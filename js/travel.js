import { db, getCurrentUser, auth } from './auth.js';
import { getRandomPlaces } from './samplePlaces.js';
import {
  pickDate,
  linkify
} from './travelUtils.js';

const BASE_KEY = 'travelData';

function storageKeyForUser(uid) {
  return uid ? `${BASE_KEY}-${uid}` : BASE_KEY;
}

function storageKey() {
  const user = getCurrentUser?.();
  return storageKeyForUser(user?.uid);
}

let lastUserId = null;

auth.onAuthStateChanged(user => {
  mapInitialized = false;
  travelData = [];
  if (lastUserId && lastUserId !== user?.uid) {
    localStorage.removeItem(storageKeyForUser(lastUserId));
  }
  lastUserId = user ? user.uid : null;
  if (!user) {
    localStorage.removeItem(BASE_KEY);
  }
  // Reload travel data for the newly authenticated user.
  // initTravelPanel safely exits if DOM is not ready or already initialized.
  initTravelPanel().catch(err =>
    console.error('Failed to reload travel data after auth change', err)
  );
});

let mapInitialized = false;
let map;
let markers = [];
let travelData = [];
let currentSearch = '';
let rowMarkerMap = new Map();
let markerRowMap = new Map();
let selectedRow = null;
let activeMarker = null;
let allTags = [];
let selectedTags = [];
let resultMarkers = [];
let activeSearchResultCard = null;
let showingSearchResultDetails = false;
let sortByDistance = true;
let sortKey = null; // one of: name, description, tags, Rating, Date, visited, distance
let sortDir = 'asc'; // 'asc' | 'desc'
let userCoords = null;
let showVisited = true;
const pageSize = Infinity;
let currentPage = 0;
let placemarkListEl = null;
let placemarkDetailsEl = null;
let tableBody = null;
let selectedPlaceRef = null;
let detailsEditState = { place: null, editing: false };
let savePlaceEdits = null;
let searchResultsListEl = null;

function updateMobilePlacemarkListState() {
  if (!placemarkListEl) return;
  const isMobile = window.matchMedia('(max-width: 600px)').matches;
  if (!isMobile) {
    placemarkListEl.classList.remove(
      'placemark-list--mobile-collapsed',
      'placemark-list--mobile-expanded'
    );
    return;
  }
  const hasResults = !!(searchResultsListEl && searchResultsListEl.childElementCount > 0);
  placemarkListEl.classList.toggle('placemark-list--mobile-collapsed', !hasResults);
  placemarkListEl.classList.toggle('placemark-list--mobile-expanded', hasResults);
}

function resizeTravelMap() {
  const mapEl = document.getElementById('travelMap');
  const listEl = document.getElementById('placemarkList');
  const detailsEl = document.getElementById('placemarkDetails');
  if (!mapEl) return;
  const rect = mapEl.getBoundingClientRect();
  const availableHeight = window.innerHeight - rect.top - 16;
  const height = Math.min(rect.width, availableHeight);
  mapEl.style.height = `${height}px`;
  if (listEl) {
    if (window.innerWidth <= 600) {
      listEl.style.maxHeight = '';
      listEl.style.height = '';
    } else {
      listEl.style.maxHeight = `${height}px`;
      listEl.style.height = `${height}px`;
    }
  }
  if (detailsEl) {
    if (window.innerWidth >= 1024) {
      detailsEl.style.maxHeight = `${height}px`;
    } else {
      detailsEl.style.maxHeight = '';
    }
  }
  if (map) {
    map.invalidateSize();
  }
  updateVisiblePlacemarkList();
  updateMobilePlacemarkListState();
}

window.addEventListener('resize', resizeTravelMap);

// Simple circle markers for map points. Visited places are green.
const createSvgUrl = color =>
  `data:image/svg+xml,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="white" stroke-width="2" fill="${color}"/></svg>`
  )}`;

const defaultIcon = L.icon({
  iconUrl: createSvgUrl('#DB4436'),
  iconSize: [24, 24],
  iconAnchor: [12, 12],
  popupAnchor: [0, -12],
});

const visitedIcon = L.icon({
  iconUrl: createSvgUrl('#62AF44'),
  iconSize: [24, 24],
  iconAnchor: [12, 12],
  popupAnchor: [0, -12],
});

// Search results use a distinct blue marker
const resultIcon = L.icon({
  iconUrl: createSvgUrl('#4285F4'),
  iconSize: [24, 24],
  iconAnchor: [12, 12],
  popupAnchor: [0, -12],
});

const selectedIcon = L.icon({
  iconUrl: createSvgUrl('#FFB300'),
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -14],
});

const NOMINATIM_RESULT_LIMIT = 15;

function haversine(lat1, lon1, lat2, lon2) {
  const R = 3958.8; // miles
  const toRad = deg => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function ensureDefaultTag(place) {
  if (!Array.isArray(place.tags) || place.tags.length === 0) {
    place.tags = ['no tag'];
  }
}

function applyVisitedFlag(place) {
  if (typeof place.visited === 'undefined') {
    place.visited = /icon-503-62AF44/.test(place.styleUrl || '');
  }
  if (Object.prototype.hasOwnProperty.call(place, 'styleUrl')) {
    delete place.styleUrl;
  }
}

function renderDetailsPlaceholder(message = 'Select a place to see details.') {
  showingSearchResultDetails = false;
  if (!placemarkDetailsEl) return;
  placemarkDetailsEl.innerHTML = '';
  const placeholder = document.createElement('div');
  placeholder.className = 'placemark-details-placeholder';
  placeholder.textContent = message;
  placemarkDetailsEl.appendChild(placeholder);
}

function renderPlacemarkOverview() {
  showingSearchResultDetails = false;
  if (!placemarkDetailsEl) return;
  placemarkDetailsEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'placemark-overview__header';
  header.textContent = 'Places in map view';
  placemarkDetailsEl.appendChild(header);

  const totalPlaces = travelData.length;
  const activeMarkers = markers.filter(m => m && m.place);

  if (activeMarkers.length === 0) {
    const message = document.createElement('div');
    message.className = 'placemark-overview__empty';
    message.textContent =
      totalPlaces === 0
        ? 'No saved places yet. Use the search panel to add one.'
        : 'No places match your current filters.';
    placemarkDetailsEl.appendChild(message);
    return;
  }

  let visibleMarkers = activeMarkers;
  if (map && typeof map.getBounds === 'function') {
    const bounds = map.getBounds();
    visibleMarkers = activeMarkers.filter(marker => bounds.contains(marker.getLatLng()));
  }

  if (visibleMarkers.length === 0) {
    const message = document.createElement('div');
    message.className = 'placemark-overview__empty';
    message.textContent = 'No places in the current map view. Pan or zoom to find more.';
    placemarkDetailsEl.appendChild(message);
    return;
  }

  visibleMarkers = visibleMarkers
    .slice()
    .sort((a, b) => (a.place.name || '').localeCompare(b.place.name || ''));

  const list = document.createElement('ul');
  list.className = 'placemark-overview';

  visibleMarkers.forEach(marker => {
    const place = marker.place;
    const item = document.createElement('li');
    item.className = 'placemark-overview__item';
    if (selectedPlaceRef === place) {
      item.classList.add('placemark-overview__item--active');
    }
    item.textContent = place.name || 'Untitled place';
    item.tabIndex = 0;
    const activate = () => {
      const row =
        tableBody &&
        Array.from(tableBody.children || []).find(tr => tr.placeRef === place);
      if (row) {
        bringRowToTop(row);
        return;
      }
      if (marker) {
        setActiveMarker(marker, { panToMarker: true });
        return;
      }
      selectedPlaceRef = place;
      detailsEditState = { place, editing: false };
      renderPlacemarkDetails(place);
    };
    item.addEventListener('click', activate);
    item.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
    list.appendChild(item);
  });

  placemarkDetailsEl.appendChild(list);
}

function renderSearchResultDetails(result, { onAdd } = {}) {
    showingSearchResultDetails = true;
    if (!placemarkDetailsEl) return;
    selectedPlaceRef = null;
    detailsEditState = { place: null, editing: false };
    placemarkDetailsEl.innerHTML = '';

    const titleEl = document.createElement('div');
    titleEl.className = 'placemark-details__title';
    titleEl.textContent = result.title || 'Search result';
    placemarkDetailsEl.appendChild(titleEl);

    if (result.description) {
      const desc = document.createElement('div');
      desc.className = 'placemark-details__description';
      desc.textContent = result.description;
      placemarkDetailsEl.appendChild(desc);
    }

    const actions = document.createElement('div');
    actions.className = 'placemark-details__actions placemark-details__actions--search';

    if (typeof onAdd === 'function') {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'placemark-details__edit-btn';
      addBtn.textContent = 'Add to my places';
      addBtn.addEventListener('click', () => onAdd());
      actions.append(addBtn);
    }

    if (Number.isFinite(result.lat) && Number.isFinite(result.lon)) {
      const directionsLink = document.createElement('a');
      directionsLink.className = 'placemark-details__directions';
      directionsLink.href = `https://www.google.com/maps/dir/?api=1&destination=${result.lat},${result.lon}`;
      directionsLink.target = '_blank';
      directionsLink.rel = 'noopener noreferrer';
      directionsLink.textContent = 'Get Directions';
      actions.append(directionsLink);
    }

    if (actions.childElementCount > 0) {
      placemarkDetailsEl.appendChild(actions);
    }
}

function highlightSearchResultCard(card) {
  if (activeSearchResultCard && activeSearchResultCard !== card) {
    activeSearchResultCard.classList.remove('search-result-card--active');
  }
  activeSearchResultCard = card || null;
  if (activeSearchResultCard) {
    activeSearchResultCard.classList.add('search-result-card--active');
    try {
      activeSearchResultCard.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch {
      // scrollIntoView may fail in older browsers; ignore
    }
  }
}

function createSearchResultListItem(
  result,
  {
    onAdd,
    onFocus,
    variant = 'remote',
  } = {}
) {
  const li = document.createElement('li');
  li.className = 'search-result-card';
  if (variant && variant !== 'remote') {
    li.classList.add(`search-result-card--${variant}`);
  }

  const title = document.createElement('div');
  title.className = 'search-result-card__title';
  title.textContent = result.title || 'Search result';
  li.append(title);

  const subtitleText = result.subtitle || result.description;
  if (subtitleText) {
    const subtitle = document.createElement('div');
    subtitle.className = 'search-result-card__subtitle';
    subtitle.textContent = subtitleText;
    li.append(subtitle);
  }

  if (variant === 'existing') {
    const badge = document.createElement('span');
    badge.className = 'search-result-card__badge';
    badge.textContent = 'Already saved';
    li.append(badge);
  }

  if (typeof onAdd === 'function' || (Number.isFinite(result.lat) && Number.isFinite(result.lon))) {
    const actions = document.createElement('div');
    actions.className = 'placemark-details__actions placemark-details__actions--search search-result-card__actions';

    if (typeof onAdd === 'function') {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'placemark-details__edit-btn';
      addBtn.textContent = 'Add to my places';
      addBtn.addEventListener('click', e => {
        e.stopPropagation();
        onAdd();
      });
      actions.append(addBtn);
    }

    if (Number.isFinite(result.lat) && Number.isFinite(result.lon)) {
      const directionsLink = document.createElement('a');
      directionsLink.className = 'placemark-details__directions';
      directionsLink.href = `https://www.google.com/maps/dir/?api=1&destination=${result.lat},${result.lon}`;
      directionsLink.target = '_blank';
      directionsLink.rel = 'noopener noreferrer';
      directionsLink.textContent = 'Get Directions';
      directionsLink.addEventListener('click', e => {
        e.stopPropagation();
      });
      actions.append(directionsLink);
    }

    if (actions.childElementCount > 0) {
      li.append(actions);
    }
  }

  li.addEventListener('click', e => {
    if (e.target.closest('.placemark-details__edit-btn')) return;
    if (e.target.closest('.placemark-details__directions')) return;
    if (typeof onFocus === 'function') {
      onFocus();
    }
  });

  return li;
}

function highlightRow(row) {
  if (selectedRow) selectedRow.classList.remove('selected-row');
  selectedRow = row;
  row?.classList.add('selected-row');
}

function setActiveMarker(marker, { panToMarker = false } = {}) {
  if (!marker || !map) return;
  if (activeMarker && activeMarker !== marker && typeof activeMarker.setIcon === 'function') {
    activeMarker.setIcon(activeMarker.defaultIcon || defaultIcon);
  }
  activeMarker = marker;
  if (typeof marker.setIcon === 'function') {
    marker.setIcon(selectedIcon);
  }
  selectedPlaceRef = marker.place || null;
  detailsEditState = { place: selectedPlaceRef, editing: false };
  renderPlacemarkDetails(selectedPlaceRef);
  if (panToMarker && typeof map.setView === 'function') {
    const latLng =
      typeof marker.getLatLng === 'function'
        ? marker.getLatLng()
        : marker.place
        ? [marker.place.lat, marker.place.lon]
        : null;
    if (latLng) {
      const currentZoom = typeof map.getZoom === 'function' ? map.getZoom() : 0;
      const targetZoom = Math.max(currentZoom || 0, 14);
      map.setView(latLng, targetZoom);
    }
  }
}

function bringRowToTop(row) {
  if (!row || !tableBody) return;
  tableBody.insertBefore(row, tableBody.firstChild);
  highlightRow(row);
  const marker = rowMarkerMap.get(row);
  if (marker) {
    setActiveMarker(marker, { panToMarker: true });
  }
}

function renderPlacemarkDetails(place) {
  showingSearchResultDetails = false;
  if (!placemarkDetailsEl) return;
  if (!place) {
    renderPlacemarkOverview();
    return;
  }

  const editing = detailsEditState.editing && detailsEditState.place === place;
  placemarkDetailsEl.innerHTML = '';

  if (!editing) {
    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'placemark-details__back';
    backBtn.textContent = '← Back to map places';
    backBtn.addEventListener('click', () => {
      selectedPlaceRef = null;
      detailsEditState = { place: null, editing: false };
      renderPlacemarkOverview();
    });
    placemarkDetailsEl.appendChild(backBtn);
  }

  const title = document.createElement('div');
  title.className = 'placemark-details__title';
  title.textContent = place.name || 'Untitled place';
  placemarkDetailsEl.appendChild(title);

  if (place.description) {
    const desc = document.createElement('div');
    desc.className = 'placemark-details__description';
    desc.innerHTML = linkify(place.description);
    placemarkDetailsEl.appendChild(desc);
  }

  const hasTags = Array.isArray(place.tags) && place.tags.length;
  let tagsSection = null;
  if (hasTags) {
    tagsSection = document.createElement('div');
    tagsSection.className = 'placemark-details__tags';
    place.tags.forEach(tag => {
      const chip = document.createElement('span');
      chip.className = 'placemark-details__tag';
      chip.textContent = tag;
      tagsSection.appendChild(chip);
    });
  }

  const infoList = document.createElement('dl');
  infoList.className = 'placemark-details__list';

  const addInfoRow = (label, value) => {
    if (value === undefined || value === null || value === '') return;
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    infoList.append(dt, dd);
  };

  addInfoRow('Rating', place.Rating);
  addInfoRow('Date', place.Date);
  addInfoRow('Visited', place.visited ? 'Yes' : 'No');

  const lat = Number(place.lat);
  const lon = Number(place.lon);
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
  if (hasCoords && userCoords) {
    const dist = haversine(userCoords[0], userCoords[1], lat, lon);
    addInfoRow('Distance from you', `${dist.toFixed(1)} mi`);
  }

  if (infoList.childElementCount) {
    placemarkDetailsEl.appendChild(infoList);
  }

  if (!editing && tagsSection) {
    placemarkDetailsEl.appendChild(tagsSection);
  }

  let tagListId = null;
  const actions = document.createElement('div');
  actions.className = 'placemark-details__actions';

  if (editing) {
    const form = document.createElement('form');
    form.className = 'placemark-details__form';

    const makeField = (labelText, inputEl) => {
      const wrapper = document.createElement('label');
      wrapper.className = 'placemark-details__form-field';
      const label = document.createElement('span');
      label.textContent = labelText;
      wrapper.append(label, inputEl);
      return wrapper;
    };

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = place.name || '';
    nameInput.required = true;
    form.append(makeField('Name', nameInput));

    const descInput = document.createElement('textarea');
    descInput.value = place.description || '';
    descInput.rows = 3;
    form.append(makeField('Description', descInput));

    const tagsInput = document.createElement('input');
    tagsInput.type = 'text';
    tagsInput.value = Array.isArray(place.tags) ? place.tags.join(', ') : '';
    const tagList = document.createElement('datalist');
    tagListId = `tag-list-${Date.now()}-${Math.random()}`;
    tagList.id = tagListId;
    tagsInput.setAttribute('list', tagListId);
    const updateTagSuggestions = () => {
      const val = tagsInput.value;
      const parts = val.split(',');
      const partial = parts.pop().trim().toLowerCase();
      const prefix = parts.map(t => t.trim()).filter(Boolean).join(', ');
      const used = parts.map(t => t.trim()).filter(Boolean);
      tagList.innerHTML = '';
      allTags
        .filter(t => t.toLowerCase().startsWith(partial) && !used.includes(t))
        .forEach(t => {
          const option = document.createElement('option');
          option.value = prefix ? `${prefix}, ${t}` : t;
          tagList.appendChild(option);
        });
    };
    tagsInput.addEventListener('input', updateTagSuggestions);
    updateTagSuggestions();
    form.append(makeField('Tags', tagsInput));
    form.append(tagList);

    const ratingInput = document.createElement('input');
    ratingInput.type = 'text';
    ratingInput.value = place.Rating || '';
    form.append(makeField('Rating', ratingInput));

    const dateInput = document.createElement('input');
    dateInput.type = 'date';
    dateInput.value = place.Date || '';
    form.append(makeField('Date', dateInput));

    const visitedWrapper = document.createElement('label');
    visitedWrapper.className = 'placemark-details__form-field placemark-details__form-field--inline';
    const visitedCheckbox = document.createElement('input');
    visitedCheckbox.type = 'checkbox';
    visitedCheckbox.checked = !!place.visited;
    const visitedText = document.createElement('span');
    visitedText.textContent = 'Visited';
    visitedWrapper.append(visitedCheckbox, visitedText);
    form.append(visitedWrapper);

    const buttonRow = document.createElement('div');
    buttonRow.className = 'placemark-details__form-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'submit';
    saveBtn.textContent = 'Save';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'Cancel';
    buttonRow.append(saveBtn, cancelBtn);
    form.append(buttonRow);

    form.addEventListener('submit', async e => {
      e.preventDefault();
      const name = nameInput.value.trim();
      if (!name) {
        nameInput.focus();
        return;
      }
      const tags = tagsInput.value
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
      const updates = {
        name,
        description: descInput.value.trim(),
        tags,
        Rating: ratingInput.value.trim(),
        Date: dateInput.value.trim(),
        visited: visitedCheckbox.checked,
      };
      try {
        detailsEditState = { place, editing: false };
        if (typeof savePlaceEdits === 'function') {
          await savePlaceEdits(place, updates);
        } else {
          Object.assign(place, updates);
          ensureDefaultTag(place);
          renderPlacemarkDetails(place);
        }
      } catch (err) {
        console.error('Failed to save place', err);
        detailsEditState = { place, editing: true };
        renderPlacemarkDetails(place);
      }
    });

    cancelBtn.addEventListener('click', e => {
      e.preventDefault();
      detailsEditState = { place, editing: false };
      renderPlacemarkDetails(place);
    });

    placemarkDetailsEl.appendChild(form);
  } else {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'placemark-details__edit-btn';
    editBtn.textContent = 'Edit place';
    editBtn.addEventListener('click', e => {
      e.preventDefault();
      e.stopPropagation();
      detailsEditState = { place, editing: true };
      renderPlacemarkDetails(place);
    });
    actions.append(editBtn);
  }

  if (hasCoords) {
    const directionsLink = document.createElement('a');
    directionsLink.className = 'placemark-details__directions';
    directionsLink.href = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
    directionsLink.target = '_blank';
    directionsLink.rel = 'noopener noreferrer';
    directionsLink.textContent = 'Get Directions';
    actions.append(directionsLink);
  }

  if (actions.childElementCount > 0) {
    placemarkDetailsEl.appendChild(actions);
  }
}

function updateVisiblePlacemarkList() {
  if (
    !placemarkDetailsEl ||
    showingSearchResultDetails ||
    detailsEditState.editing ||
    selectedPlaceRef
  ) {
    return;
  }
  renderPlacemarkOverview();
}

export async function initTravelPanel() {
  const panel = document.getElementById('travelPanel');
  if (!panel) return;
  if (mapInitialized) {
    // panel is being re-shown; resize the map to fill its container
    resizeTravelMap();
    return;
  }
  mapInitialized = true;

  const mapEl = document.getElementById('travelMap');
  tableBody = document.querySelector('#travelTable tbody');
  const tableHeaders = Array.from(document.querySelectorAll('#travelTable thead th'));
  const headerKeys = ['name','description','tags','Rating','Date','visited','distance'];
  const headerBaseText = tableHeaders.map(th => th.textContent.trim());
  const searchInput = document.getElementById('travelSearch');
  const placeInput = document.getElementById('placeSearch');
  const resultsList = document.getElementById('placeResults');
  const searchPlaceBtn = document.getElementById('placeSearchBtn');
  const tagFiltersDiv = document.getElementById('travelTagFilters');
  searchResultsListEl = resultsList;
  placemarkListEl = document.getElementById('placemarkList');
  placemarkDetailsEl = document.getElementById('placemarkDetails');
  updateMobilePlacemarkListState();
  const placeCountEl = document.getElementById('placeCount');
  const paginationDiv = document.getElementById('paginationControls');
  const prevPageBtn = document.getElementById('prevPageBtn');
  const nextPageBtn = document.getElementById('nextPageBtn');
  const pageInfoSpan = document.getElementById('pageInfo');
  const showVisitedToggle = document.getElementById('showVisitedToggle');
  const addPlaceModal = document.getElementById('addPlaceModal');
  const addPlaceForm = document.getElementById('addPlaceForm');
  const placeTagsDiv = document.getElementById('placeTags');
  const extraTagsInput = document.getElementById('extraTags');
  const placeCancelBtn = document.getElementById('placeCancel');
  map = L.map(mapEl, {
    maxBounds: [
      [-90, -180],
      [90, 180]
    ],
    maxBoundsViscosity: 1.0,
    worldCopyJump: false,
    doubleClickZoom: false
  }).setView([20, 0], 2);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap contributors',
    noWrap: false,
    bounds: [
      [-85.05112878, -180],
      [85.05112878, 180]
    ]
  }).addTo(map);
  map.on('moveend', updateVisiblePlacemarkList);
  resizeTravelMap();
  renderPlacemarkDetails(null);

  async function openAddPlaceForm(lat, lon) {
    if (!addPlaceModal || !addPlaceForm || !placeTagsDiv) {
      const name = prompt('Place name:');
      if (!name) return;
      const description = prompt('Description:');
      const tagsStr = prompt('Tags (comma separated):');
      const rating = prompt('Rating:');
      const date = await pickDate('');
      const visited = confirm('Visited?');
      await storePlace({
        name,
        description: description || '',
        lat,
        lon,
        tags: tagsStr ? tagsStr.split(',').map(t => t.trim()).filter(Boolean) : [],
        Rating: rating || '',
        Date: date || '',
        visited
      });
      return;
    }

    addPlaceForm.reset();
    if (extraTagsInput) extraTagsInput.value = '';
    placeTagsDiv.innerHTML = '';
    allTags.forEach(tag => {
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = tag;
      label.append(cb, document.createTextNode(tag));
      placeTagsDiv.append(label);
    });
    addPlaceModal.style.display = 'flex';

    const submitHandler = async e => {
      e.preventDefault();
      const name = addPlaceForm.querySelector('#placeName').value.trim();
      if (!name) return;
      const description = addPlaceForm
        .querySelector('#placeDescription')
        .value.trim();
      const rating = addPlaceForm.querySelector('#placeRating').value.trim();
      const date = addPlaceForm.querySelector('#placeDate').value.trim();
      const visited = addPlaceForm.querySelector('#placeVisited').checked;
      const tags = Array.from(
        placeTagsDiv.querySelectorAll('input[type="checkbox"]:checked')
      ).map(cb => cb.value);
      if (extraTagsInput && extraTagsInput.value.trim()) {
        tags.push(
          ...extraTagsInput.value
            .split(',')
            .map(t => t.trim())
            .filter(Boolean)
        );
      }
      addPlaceModal.style.display = 'none';
      addPlaceForm.removeEventListener('submit', submitHandler);
      await storePlace({
        name,
        description,
        lat,
        lon,
        tags,
        Rating: rating,
        Date: date,
        visited
      });
    };

    addPlaceForm.addEventListener('submit', submitHandler);
    const cancelHandler = () => {
      addPlaceModal.style.display = 'none';
      addPlaceForm.removeEventListener('submit', submitHandler);
    };
    placeCancelBtn?.addEventListener('click', cancelHandler, { once: true });
  }

  map.on('dblclick', e => openAddPlaceForm(e.latlng.lat, e.latlng.lng));

  let initialRemoteLoadComplete = false;
  let pendingAdds = [];
  let pendingUpdates = [];
  let pendingDeletes = [];
  const persistPlaceUpdates = async (place, updates) => {
    place.name = updates.name;
    place.description = updates.description;
    place.tags = updates.tags;
    ensureDefaultTag(place);
    place.Rating = updates.Rating;
    place.Date = updates.Date;
    place.visited = updates.visited;
    const user = getCurrentUser?.();
    if (user) {
      localStorage.setItem(storageKey(), JSON.stringify(travelData));
      if (place.id) {
        if (initialRemoteLoadComplete) {
          try {
            await db
              .collection('users')
              .doc(user.uid)
              .collection('travel')
              .doc(place.id)
              .set(place, { merge: true });
          } catch (err) {
            console.error('Failed to update place', err);
          }
        } else {
          pendingUpdates.push({ id: place.id, data: JSON.parse(JSON.stringify(place)) });
        }
      }
    } else {
      localStorage.setItem(storageKey(), JSON.stringify(travelData));
    }
    allTags = Array.from(new Set(travelData.flatMap(pl => pl.tags || []))).sort();
    renderTagFilters();
    renderList(currentSearch);
  };
  savePlaceEdits = persistPlaceUpdates;

  const user = getCurrentUser?.();
  const cached = user ? localStorage.getItem(storageKey()) : null;
  travelData = cached ? JSON.parse(cached) : user ? [] : getRandomPlaces();
  travelData.forEach(p => {
    ensureDefaultTag(p);
    applyVisitedFlag(p);
  });

  allTags = Array.from(new Set(travelData.flatMap(p => p.tags || []))).sort();

  const renderTagFilters = () => {
    if (!tagFiltersDiv) return;
    tagFiltersDiv.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'tags-header';
    header.textContent = 'Tags';
    tagFiltersDiv.append(header);
    allTags.forEach(tag => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = tag;
      btn.className = 'tag-filter-button';
      if (selectedTags.includes(tag)) btn.classList.add('active');
      btn.addEventListener('click', () => {
        if (selectedTags.includes(tag)) {
          selectedTags = selectedTags.filter(t => t !== tag);
        } else {
          selectedTags.push(tag);
        }
        currentPage = 0;
        renderTagFilters();
        renderList(currentSearch);
      });
      tagFiltersDiv.append(btn);
    });
  };

  renderTagFilters();

  // Show scroll arrows on the tags panel when content overflows
  const updateTagScrollIndicators = () => {
    if (!tagFiltersDiv) return;
    const el = tagFiltersDiv;
    const scrollable = el.scrollHeight > el.clientHeight + 1;
    el.classList.toggle('scrollable', scrollable);
    if (!scrollable) {
      el.classList.remove('at-top', 'at-bottom');
      return;
    }
    const atTop = el.scrollTop <= 1;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    el.classList.toggle('at-top', atTop);
    el.classList.toggle('at-bottom', atBottom);
  };
  tagFiltersDiv?.addEventListener('scroll', updateTagScrollIndicators);
  // Recompute after initial render and on window resize
  setTimeout(updateTagScrollIndicators, 0);
  window.addEventListener('resize', () => setTimeout(updateTagScrollIndicators, 0));

  function updatePagination(total) {
    if (!paginationDiv) return;
    const totalPages = Math.ceil(total / pageSize) || 1;
    pageInfoSpan.textContent = `${currentPage + 1} / ${totalPages}`;
    prevPageBtn.disabled = currentPage === 0;
    nextPageBtn.disabled = currentPage >= totalPages - 1;
  }

  prevPageBtn?.addEventListener('click', () => {
    if (currentPage > 0) {
      currentPage -= 1;
      renderList(currentSearch);
    }
  });

  nextPageBtn?.addEventListener('click', () => {
    currentPage += 1;
    renderList(currentSearch);
  });

  if (showVisitedToggle) {
    showVisitedToggle.checked = showVisited;
    showVisitedToggle.addEventListener('change', () => {
      showVisited = showVisitedToggle.checked;
      currentPage = 0;
      renderList(currentSearch);
    });
  }

  const renderList = (term = '', customItems = null) => {
    tableBody.innerHTML = '';
    if (customItems) currentPage = 0;
    const previousSelection = selectedPlaceRef;
    markers.forEach(m => m.remove());
    markers = [];
    activeMarker = null;
    rowMarkerMap.clear();
    markerRowMap.clear();
    let items;
    if (Array.isArray(customItems)) {
      items = customItems;
    } else {
      items = travelData.filter(
        p =>
          p.name.toLowerCase().includes(term.toLowerCase()) &&
          (selectedTags.length === 0 ||
            (Array.isArray(p.tags) && selectedTags.some(t => p.tags.includes(t)))) &&
          (showVisited || !p.visited)
      );
    }
    const selectionStillVisible =
      previousSelection && items.includes(previousSelection);
    if (!selectionStillVisible) {
      selectedPlaceRef = null;
      detailsEditState = { place: null, editing: false };
    }
    if (!detailsEditState.editing) {
      renderPlacemarkDetails(selectionStillVisible ? previousSelection : null);
    }

    // Sorting
    const compare = (a, b, key) => {
      const dir = sortDir === 'desc' ? -1 : 1;
      const val = v => {
        switch (key) {
          case 'name': return (v.name || '').toLowerCase();
          case 'description': return (v.description || '').toLowerCase();
          case 'tags': return Array.isArray(v.tags) ? v.tags.join(', ').toLowerCase() : '';
          case 'Rating': {
            const n = parseFloat(v.Rating);
            return Number.isFinite(n) ? n : -Infinity;
          }
          case 'Date': {
            const d = Date.parse(v.Date || '');
            return Number.isFinite(d) ? d : -Infinity;
          }
          case 'visited': return v.visited ? 1 : 0;
          case 'distance': {
            if (!userCoords) return Infinity;
            return haversine(userCoords[0], userCoords[1], v.lat, v.lon);
          }
          default: return 0;
        }
      };
      const av = val(a), bv = val(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    };
    if (sortKey) {
      items.sort((a, b) => compare(a, b, sortKey));
    } else if (sortByDistance && userCoords) {
      items.sort((a, b) => compare(a, b, 'distance'));
    }
    const total = items.length;
    let start;
    let pageItems;
    if (pageSize === Infinity) {
      start = 0;
      pageItems = items;
      if (paginationDiv) paginationDiv.style.display = 'none';
    } else {
      start = currentPage * pageSize;
      pageItems = items.slice(start, start + pageSize);
      if (paginationDiv) paginationDiv.style.display = '';
      updatePagination(total);
    }
    if (placeCountEl) {
      const end =
        pageSize === Infinity ? total : Math.min(start + pageItems.length, total);
      placeCountEl.textContent =
        total === 0 ? 'Showing 0 of 0' : `Showing ${start + 1}-${end} of ${total}`;
    }

    pageItems.forEach(p => {
      const icon = p.visited ? visitedIcon : defaultIcon;
      const m = L.marker([p.lat, p.lon], { icon }).addTo(map);
      markers.push(m);
      m.place = p;
      m.defaultIcon = icon;
      Object.defineProperty(p, 'marker', {
        value: m,
        enumerable: false,
        configurable: true,
        writable: true,
      });
      m.on('click', () => {
        const row = markerRowMap.get(m);
        if (row) {
          bringRowToTop(row);
        } else {
          setActiveMarker(m);
        }
      });
      const tr = document.createElement('tr');
      tr.placeRef = p;
      const nameTd = document.createElement('td');
      const nameLink = document.createElement('a');
      nameLink.href = `https://www.google.com/search?q=${encodeURIComponent(p.name)}`;
      nameLink.textContent = p.name;
      nameLink.target = '_blank';
      nameTd.appendChild(nameLink);
      nameTd.dataset.label = 'Name';
      const descTd = document.createElement('td');
      descTd.innerHTML = linkify(p.description || '');
      descTd.dataset.label = 'Description';
      const tagsTd = document.createElement('td');
      tagsTd.textContent = Array.isArray(p.tags) ? p.tags.join(', ') : '';
      tagsTd.dataset.label = 'Tags';
      const ratingTd = document.createElement('td');
      ratingTd.textContent = p.Rating || '';
      ratingTd.dataset.label = 'Rating';
      const dateTd = document.createElement('td');
      dateTd.textContent = p.Date || '';
      dateTd.dataset.label = 'Date';
      const visitedTd = document.createElement('td');
      visitedTd.textContent = p.visited ? '✅' : '';
      visitedTd.dataset.label = 'Visited';
      if (p.visited) visitedTd.classList.add('visited-icon');
      const distTd = document.createElement('td');
      distTd.dataset.label = 'Distance (mi)';
      if (userCoords) {
        const dist = haversine(userCoords[0], userCoords[1], p.lat, p.lon);
        distTd.textContent = dist.toFixed(1);
      } else {
        distTd.textContent = '';
      }
      const actionsTd = document.createElement('td');
      actionsTd.dataset.label = 'Actions';
      actionsTd.style.whiteSpace = 'nowrap';

      const editBtn = document.createElement('button');
      editBtn.textContent = '✏️';
      editBtn.title = 'Edit';
      editBtn.className = 'row-edit-btn';
      Object.assign(editBtn.style, { background: 'none', border: 'none', cursor: 'pointer' });
      editBtn.addEventListener('click', e => {
        e.stopPropagation();
        tr.innerHTML = '';
        const form = document.createElement('form');
        form.style.display = 'flex';
        form.style.flexWrap = 'wrap';
        form.style.gap = '4px';
        const td = document.createElement('td');
        td.colSpan = 8;
        td.className = 'edit-cell';

        const nameInput = document.createElement('input');
        nameInput.value = p.name || '';
        nameInput.placeholder = 'name';
        const descInput = document.createElement('input');
        descInput.value = p.description || '';
        descInput.placeholder = 'description';
        const tagsInput = document.createElement('input');
        tagsInput.value = Array.isArray(p.tags) ? p.tags.join(', ') : '';
        tagsInput.placeholder = 'tags';
        const tagList = document.createElement('datalist');
        const listId = `tag-list-${Date.now()}-${Math.random()}`;
        tagList.id = listId;
        tagsInput.setAttribute('list', listId);
        const updateTagSuggestions = () => {
          const val = tagsInput.value;
          const parts = val.split(',');
          const partial = parts.pop().trim().toLowerCase();
          const prefix = parts.map(t => t.trim()).filter(Boolean).join(', ');
          const used = parts.map(t => t.trim()).filter(Boolean);
          tagList.innerHTML = '';
          allTags
            .filter(t =>
              t.toLowerCase().startsWith(partial) && !used.includes(t)
            )
            .forEach(t => {
              const option = document.createElement('option');
              option.value = prefix ? `${prefix}, ${t}` : t;
              tagList.appendChild(option);
            });
        };
        tagsInput.addEventListener('input', updateTagSuggestions);
        updateTagSuggestions();
        const ratingInput = document.createElement('input');
        ratingInput.value = p.Rating || '';
        ratingInput.placeholder = 'rating';
        const dateInput = document.createElement('input');
        dateInput.type = 'date';
        dateInput.value = p.Date || '';
        const visitedInput = document.createElement('input');
        visitedInput.type = 'checkbox';
        visitedInput.checked = !!p.visited;
        visitedInput.title = 'Visited';
        const visitedLabel = document.createElement('label');
        visitedLabel.style.whiteSpace = 'nowrap';
        visitedLabel.append(visitedInput, ' Visited');

        const saveBtn = document.createElement('button');
        saveBtn.textContent = 'Save';
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        [saveBtn, cancelBtn].forEach(b =>
          Object.assign(b.style, {
            background: 'none',
            border: '1px solid #999',
            padding: '2px 6px',
            marginTop: '0'
          })
        );

        visitedLabel.style.display = 'flex';
        visitedLabel.style.alignItems = 'center';

        const btnRow = document.createElement('div');
        btnRow.style.display = 'flex';
        btnRow.style.gap = '4px';
        btnRow.append(saveBtn, cancelBtn);

        form.append(
          nameInput,
          descInput,
          tagsInput,
          tagList,
          ratingInput,
          dateInput,
          visitedLabel,
          btnRow
        );
        td.append(form);
        tr.append(td);

        form.addEventListener('submit', async ev => {
          ev.preventDefault();
          const updates = {
            name: nameInput.value.trim(),
            description: descInput.value.trim(),
            tags: tagsInput.value
              .split(',')
              .map(t => t.trim())
              .filter(Boolean),
            Rating: ratingInput.value.trim(),
            Date: dateInput.value.trim(),
            visited: visitedInput.checked,
          };
          try {
            await persistPlaceUpdates(p, updates);
          } catch (err) {
            console.error('Failed to update place', err);
          }
        });
        cancelBtn.addEventListener('click', e2 => {
          e2.preventDefault();
          renderList(currentSearch);
        });
      });
      actionsTd.append(editBtn);

      const delBtn = document.createElement('button');
      delBtn.textContent = '❌';
      delBtn.title = 'Delete';
      Object.assign(delBtn.style, { background: 'none', border: 'none', cursor: 'pointer' });
      delBtn.addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm('Delete this place?')) return;
        await deletePlace(p);
      });
      const dirLink = document.createElement('a');
      dirLink.href = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}`;
      dirLink.target = '_blank';
      dirLink.rel = 'noopener noreferrer';
      dirLink.textContent = 'Directions';
      Object.assign(dirLink.style, { marginLeft: '6px' });
      actionsTd.append(delBtn, dirLink);

      tr.append(
        nameTd,
        descTd,
        tagsTd,
        ratingTd,
        dateTd,
        visitedTd,
        distTd,
        actionsTd
      );
      tableBody.append(tr);
      rowMarkerMap.set(tr, m);
      markerRowMap.set(m, tr);
      if (selectedPlaceRef === p) {
        highlightRow(tr);
        setActiveMarker(m);
      }

      tr.addEventListener('click', e => {
        // If the user clicked a link inside the row, allow the link to
        // navigate without selecting the row or moving the map.
        if (e.target.closest('a')) return;

        highlightRow(tr);
        setActiveMarker(m, { panToMarker: true });
        // mapEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Don't auto-scroll to the map when selecting a place
      });
    });
    updateVisiblePlacemarkList();
  };

  function updateSortIndicators() {
    tableHeaders.forEach((th, i) => {
      const base = headerBaseText[i];
      const key = headerKeys[i];
      if (sortKey === key) {
        th.textContent = `${base} ${sortDir === 'asc' ? '▲' : '▼'}`;
      } else {
        th.textContent = base;
      }
    });
  }

  // Enable sorting by clicking headers
  tableHeaders.forEach((th, i) => {
    th.style.cursor = 'pointer';
    th.title = 'Click to sort';
    th.addEventListener('click', () => {
      const key = headerKeys[i];
      if (sortKey === key) {
        sortDir = sortDir === 'asc' ? 'desc' : 'asc';
      } else {
        sortKey = key;
        sortDir = 'asc';
      }
      // Disable default distance sort when custom sort is chosen
      sortByDistance = false;
      updateSortIndicators();
      currentPage = 0;
      renderList(currentSearch);
    });
  });
  updateSortIndicators();

  const renderDefaultList = () => {
    currentPage = 0;
    renderList('');
  };
    
    // Removed: Popular Nearby Places section and TripAdvisor fetch

    const clearSearchResults = () => {
      if (resultsList) resultsList.innerHTML = '';
      resultMarkers.forEach(m => m.remove());
      resultMarkers = [];
      highlightSearchResultCard(null);
      showingSearchResultDetails = false;
      if (!selectedPlaceRef && !detailsEditState.editing) {
        renderPlacemarkOverview();
      }
      updateMobilePlacemarkListState();
    };
    placeInput?.setAttribute('autocomplete', 'off');
    placeInput?.addEventListener('input', e => {
      if (!e.target.value.trim()) {
        clearSearchResults();
      }
    });
    // Clear button removed from UI; keep internal helper for programmatic clears only

    async function flushPendingOperations() {
    const user = getCurrentUser?.();
    if (!initialRemoteLoadComplete || !user) return;
    for (const place of pendingAdds) {
      try {
        const docRef = await db
          .collection('users')
          .doc(user.uid)
          .collection('travel')
          .add(place);
        place.id = docRef.id;
      } catch (err) {
        console.error('Failed to save place to Firestore', err);
      }
    }
    pendingAdds = [];
    for (const { id, data } of pendingUpdates) {
      try {
        await db
          .collection('users')
          .doc(user.uid)
          .collection('travel')
          .doc(id)
          .set(data, { merge: true });
      } catch (err) {
        console.error('Failed to update place', err);
      }
    }
    pendingUpdates = [];
    for (const id of pendingDeletes) {
      try {
        await db
          .collection('users')
          .doc(user.uid)
          .collection('travel')
          .doc(id)
          .delete();
      } catch (err) {
        console.error('Failed to delete place', err);
      }
    }
    pendingDeletes = [];
  }

  async function storePlace(place) {
    ensureDefaultTag(place);
    applyVisitedFlag(place);
    const user = getCurrentUser?.();
    travelData.push(place);
    if (user) {
      localStorage.setItem(storageKey(), JSON.stringify(travelData));
      if (initialRemoteLoadComplete) {
        try {
          const docRef = await db
            .collection('users')
            .doc(user.uid)
            .collection('travel')
            .add(place);
          place.id = docRef.id;
        } catch (err) {
          console.error('Failed to save place to Firestore', err);
        }
      } else {
        pendingAdds.push(place);
      }
    }
    allTags = Array.from(new Set(travelData.flatMap(p => p.tags || []))).sort();
    renderTagFilters();
    renderList(currentSearch);
  }

  async function deletePlace(p) {
    const user = getCurrentUser?.();
    if (user && p.id) {
      if (initialRemoteLoadComplete) {
        try {
          await db
            .collection('users')
            .doc(user.uid)
            .collection('travel')
            .doc(p.id)
            .delete();
        } catch (err) {
          console.error('Failed to delete place', err);
        }
      } else {
        pendingDeletes.push(p.id);
      }
    }
    travelData.splice(travelData.indexOf(p), 1);
    if (user) {
      localStorage.setItem(storageKey(), JSON.stringify(travelData));
    }
    allTags = Array.from(new Set(travelData.flatMap(pl => pl.tags || []))).sort();
    renderTagFilters();
    renderList(currentSearch);
  }

  if (searchInput) {
    searchInput.addEventListener('input', e => {
      currentSearch = e.target.value;
      currentPage = 0;
      renderList(currentSearch);
    });
  }

  if (user) {
    db
      .collection('users')
      .doc(user.uid)
      .collection('travel')
      .onSnapshot(
        { includeMetadataChanges: true },
        snap => {
          const fromServer = !snap.metadata.fromCache;
          const data = snap.docs.map(doc => {
            const d = { id: doc.id, ...doc.data() };
            ensureDefaultTag(d);
            applyVisitedFlag(d);
            return d;
          });
          if (fromServer || travelData.length === 0) {
            travelData = data;
            localStorage.setItem(storageKey(), JSON.stringify(travelData));
            allTags = Array.from(
              new Set(travelData.flatMap(p => p.tags || []))
            ).sort();
            renderTagFilters();
            renderList(currentSearch);
          }
          if (fromServer && !initialRemoteLoadComplete) {
            initialRemoteLoadComplete = true;
            flushPendingOperations();
          }
        },
        err => {
          console.error('Failed to sync travel data', err);
        }
      );
  } else {
    initialRemoteLoadComplete = true;
  }


  const renderInitial = () => {
    renderDefaultList();
  };

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        userCoords = [pos.coords.latitude, pos.coords.longitude];
        renderInitial();
      },
      () => {
        // location retrieval failed; still render list without userCoords
        renderInitial();
      }
    );
  } else {
    renderInitial();
  }

  const dmsToDecimal = (deg, min, sec, dir) => {
    const dec = Number(deg) + Number(min) / 60 + Number(sec) / 3600;
    return /[SW]/i.test(dir) ? -dec : dec;
  };
  const ddmToDecimal = (deg, min, dir) => {
    const dec = Number(deg) + Number(min) / 60;
    return /[SW]/i.test(dir) ? -dec : dec;
  };
  const parseCoordinates = input => {
    const ddMatch = input.match(/^\s*(-?\d{1,3}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    if (ddMatch) {
      return { lat: parseFloat(ddMatch[1]), lon: parseFloat(ddMatch[2]) };
    }
    const dmsMatch = input.match(/^[\s]*?(\d{1,3})[°\s]\s*(\d{1,2})['\s]\s*(\d{1,2}(?:\.\d+)?)["\s]?\s*([NS])[,\s]+(\d{1,3})[°\s]\s*(\d{1,2})['\s]\s*(\d{1,2}(?:\.\d+)?)["\s]?\s*([EW])\s*$/i);
    if (dmsMatch) {
      const lat = dmsToDecimal(dmsMatch[1], dmsMatch[2], dmsMatch[3], dmsMatch[4]);
      const lon = dmsToDecimal(dmsMatch[5], dmsMatch[6], dmsMatch[7], dmsMatch[8]);
      return { lat, lon };
    }
    const ddmMatch = input.match(/^\s*(\d{1,3})[°\s]\s*(\d{1,2}(?:\.\d+)?)[']?\s*([NS])[,\s]+(\d{1,3})[°\s]\s*(\d{1,2}(?:\.\d+)?)[']?\s*([EW])\s*$/i);
    if (ddmMatch) {
      const lat = ddmToDecimal(ddmMatch[1], ddmMatch[2], ddmMatch[3]);
      const lon = ddmToDecimal(ddmMatch[4], ddmMatch[5], ddmMatch[6]);
      return { lat, lon };
    }
    return null;
  };

  const searchForPlace = async () => {
    if (!placeInput) return;
    const term = placeInput.value.trim();
    if (!term) return;
    clearSearchResults();

    const appendSectionHeader = text => {
      if (!resultsList) return;
      const header = document.createElement('li');
      header.className = 'search-results__header';
      header.textContent = text;
      resultsList.append(header);
    };

    const normalizedTerm = term.toLowerCase();
    const existingMatches = travelData.filter(p =>
      p.name.toLowerCase().includes(normalizedTerm)
    );

    if (existingMatches.length) {
      appendSectionHeader('Saved places');
    }

    existingMatches.forEach(p => {
      let card;
      const config = {
        variant: 'existing',
        onFocus: () => {
          const marker = p.marker;
          if (marker) {
            const row = markerRowMap.get(marker);
            if (row) {
              bringRowToTop(row);
            } else {
              setActiveMarker(marker, { panToMarker: true });
            }
          } else {
            map.setView([p.lat, p.lon], 14);
            renderPlacemarkDetails(p);
          }
          highlightSearchResultCard(card);
        },
      };
      card = createSearchResultListItem(
        {
          title: p.name || 'Untitled place',
          subtitle: p.description || '',
          lat: p.lat,
          lon: p.lon,
        },
        config
      );
      resultsList?.append(card);
    });

    updateMobilePlacemarkListState();

    const coords = parseCoordinates(term);
    if (coords) {
      const { lat, lon } = coords;
      let card;
      let marker;
      const handleAdd = async () => {
        const name = prompt('Place name:', '') || '';
        if (!name.trim()) return;
        await storePlace({
          name: name.trim(),
          description: '',
          lat,
          lon,
          tags: [],
          Rating: '',
          Date: '',
          visited: false
        });
        clearSearchResults();
        placeInput.value = '';
      };
      const config = {
        onAdd: handleAdd,
        onFocus: () => {
          map.setView([lat, lon], 14);
          showDetails();
        },
      };
      card = createSearchResultListItem(
        {
          title: 'Searched location',
          subtitle: `Results for "${term}"`,
          lat,
          lon,
        },
        config
      );
      resultsList?.append(card);
      updateMobilePlacemarkListState();
      const showDetails = () => {
        renderSearchResultDetails(
          {
            title: 'Searched location',
            description: `Results for "${term}"`,
            lat,
            lon,
          },
          { onAdd: handleAdd }
        );
        highlightSearchResultCard(card);
      };
      marker = L.marker([lat, lon], { icon: resultIcon }).addTo(map);
      resultMarkers.push(marker);
      marker.on('click', () => {
        map.setView([lat, lon], 14);
        showDetails();
      });
      map.setView([lat, lon], 14);
      showDetails();
      return;
    }

    try {
      const resp = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=${NOMINATIM_RESULT_LIMIT}&q=${encodeURIComponent(term)}`);
      if (!resp.ok) throw new Error('Search request failed');
      const data = await resp.json();
      if (Array.isArray(data) && data.length) {
        appendSectionHeader(existingMatches.length ? 'Other results' : 'Search results');
        const latLngs = [];
        data.forEach(res => {
          const { lat, lon, display_name } = res;
          const latitude = parseFloat(lat);
          const longitude = parseFloat(lon);
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
          latLngs.push([latitude, longitude]);
          let card;
          const placeSummary = {
            title: display_name.split(',')[0] || display_name,
            subtitle: display_name,
            lat: latitude,
            lon: longitude,
          };
          const handleAdd = async () => {
            const name =
              prompt('Place name:', placeSummary.title) || '';
            if (!name.trim()) return;
            await storePlace({
              name: name.trim(),
              description: '',
              lat: latitude,
              lon: longitude,
              tags: [],
              Rating: '',
              Date: '',
              visited: false
            });
            clearSearchResults();
            placeInput.value = '';
          };
          const config = {
            onAdd: handleAdd,
            onFocus: () => {
              map.setView([latitude, longitude], 14);
              showDetails();
            },
          };
          card = createSearchResultListItem(placeSummary, config);
          resultsList?.append(card);
          const showDetails = () => {
            renderSearchResultDetails(
              {
                title: placeSummary.title,
                description: placeSummary.subtitle,
                lat: latitude,
                lon: longitude,
              },
              { onAdd: handleAdd }
            );
            highlightSearchResultCard(card);
          };
          const marker = L.marker([latitude, longitude], { icon: resultIcon }).addTo(map);
          resultMarkers.push(marker);
          marker.on('click', () => {
            map.setView([latitude, longitude], 14);
            showDetails();
          });
        });
        if (latLngs.length === 1) {
          map.setView(latLngs[0], 14);
        } else if (latLngs.length > 1) {
          map.fitBounds(latLngs);
        }
      } else if (!existingMatches.length) {
        const li = document.createElement('li');
        li.className = 'search-results__empty';
        li.textContent = `No results for "${term}".`;
        resultsList?.append(li);
      }
    } catch (err) {
      console.error('Error searching place', err);
      const li = document.createElement('li');
      li.className = 'search-results__empty';
      li.textContent = 'Search failed. Please try again.';
      resultsList?.append(li);
    }

    updateMobilePlacemarkListState();
  };

  placeInput?.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    searchForPlace();
  });

  searchPlaceBtn?.addEventListener('click', e => {
    e.preventDefault();
    searchForPlace();
  });

  const addBtn = document.getElementById('addPlaceBtn');
  addBtn?.addEventListener('click', async () => {
    const name = prompt('Place name:');
    const description = prompt('Description:');
    const tags = prompt('Tags (comma separated):');
    const rating = prompt('Rating:');
    const date = await pickDate('');
    const visited = confirm('Visited?');
    const lat = parseFloat(prompt('Latitude:'));
    const lon = parseFloat(prompt('Longitude:'));
    if (!name || Number.isNaN(lat) || Number.isNaN(lon)) return;
    const place = {
      name,
      description: description || '',
      lat,
      lon,
      tags: tags ? tags.split(',').map(t => t.trim()).filter(Boolean) : [],
      Rating: rating || '',
      Date: date || '',
      visited
    };
    await storePlace(place);
  });

}

window.initTravelPanel = initTravelPanel;
