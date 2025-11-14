import { db, getCurrentUser, auth } from './auth.js';
import { getRandomPlaces } from './samplePlaces.js';
import {
  pickDate,
  linkify
} from './travelUtils.js';

const BASE_KEY = 'travelData';
const HIDDEN_SEARCH_RESULTS_KEY = 'travelHiddenSearchResults';
const QUICK_SEARCHES_KEY = 'travelQuickSearches';
const REMOVED_QUICK_SEARCHES_KEY = 'travelRemovedQuickSearches';
const DEFAULT_QUICK_SEARCHES = ['Restaurants', 'Movie Theaters', 'Parks'];

function storageKeyForUser(uid) {
  return uid ? `${BASE_KEY}-${uid}` : BASE_KEY;
}

function storageKey() {
  const user = getCurrentUser?.();
  return storageKeyForUser(user?.uid);
}

let hiddenSearchResultKeys = new Set();
let activeContextRefresh = null;
let summaryRequestCounter = 0;
const summaryCache = new Map();
let quickSearchTerms = [];
let removedQuickSearchTerms = new Set();
function loadHiddenSearchResults() {
  if (typeof localStorage === 'undefined') {
    hiddenSearchResultKeys = new Set();
    return;
  }
  try {
    const stored = localStorage.getItem(HIDDEN_SEARCH_RESULTS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        hiddenSearchResultKeys = new Set(parsed);
        return;
      }
    }
  } catch {
    // ignore
  }
  hiddenSearchResultKeys = new Set();
}

function persistHiddenSearchResults() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      HIDDEN_SEARCH_RESULTS_KEY,
      JSON.stringify(Array.from(hiddenSearchResultKeys))
    );
  } catch {
    // ignore storage failures
  }
}

function persistedTermKey(term) {
  const normalized = normalizeQuickSearchTerm(term);
  return normalized ? normalized.toLowerCase() : '';
}

function loadRemovedQuickSearchTerms() {
  if (typeof localStorage === 'undefined') {
    removedQuickSearchTerms = new Set();
    return;
  }
  try {
    const stored = localStorage.getItem(REMOVED_QUICK_SEARCHES_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        removedQuickSearchTerms = new Set(
          parsed
            .map(value => (typeof value === 'string' ? value.toLowerCase().trim() : ''))
            .filter(Boolean)
        );
        return;
      }
    }
  } catch {
    // ignore
  }
  removedQuickSearchTerms = new Set();
}

function persistRemovedQuickSearchTerms() {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(
      REMOVED_QUICK_SEARCHES_KEY,
      JSON.stringify(Array.from(removedQuickSearchTerms))
    );
  } catch {
    // ignore storage failures
  }
}

function isQuickSearchTermRemoved(term) {
  const key = persistedTermKey(term);
  return !!key && removedQuickSearchTerms.has(key);
}

function markQuickSearchTermRemoved(term) {
  const key = persistedTermKey(term);
  if (!key) return;
  removedQuickSearchTerms.add(key);
  persistRemovedQuickSearchTerms();
}

function restoreQuickSearchTerm(term) {
  const key = persistedTermKey(term);
  if (!key || !removedQuickSearchTerms.has(key)) return false;
  removedQuickSearchTerms.delete(key);
  persistRemovedQuickSearchTerms();
  return true;
}

function isSearchResultHidden(key) {
  return key ? hiddenSearchResultKeys.has(key) : false;
}

function markSearchResultHidden(key) {
  if (!key) return;
  hiddenSearchResultKeys.add(key);
  persistHiddenSearchResults();
}

function buildHiddenResultKey({ remoteId, lat, lon, title }) {
  if (remoteId) return `id:${remoteId}`;
  const latPart = Number(lat);
  const lonPart = Number(lon);
  const safeLat = Number.isFinite(latPart) ? latPart.toFixed(5) : 'nan';
  const safeLon = Number.isFinite(lonPart) ? lonPart.toFixed(5) : 'nan';
  const safeTitle = (title || '').toLowerCase().trim();
  return `coord:${safeLat}:${safeLon}:${safeTitle}`;
}

loadHiddenSearchResults();

const normalizeQuickSearchTerm = term =>
  (term || '')
    .replace(/\s+/g, ' ')
    .trim();

function isDefaultQuickSearch(term) {
  if (!term) return false;
  const normalized = term.toLowerCase();
  return DEFAULT_QUICK_SEARCHES.some(defaultTerm => defaultTerm.toLowerCase() === normalized);
}

function loadQuickSearchTerms() {
  if (typeof localStorage === 'undefined') {
    quickSearchTerms = DEFAULT_QUICK_SEARCHES.slice();
    return;
  }
  loadRemovedQuickSearchTerms();
  try {
    const stored = localStorage.getItem(QUICK_SEARCHES_KEY);
    let combined = [];
    DEFAULT_QUICK_SEARCHES.forEach(defaultTerm => {
      const normalized = normalizeQuickSearchTerm(defaultTerm);
      if (!normalized) return;
      if (isQuickSearchTermRemoved(normalized)) return;
      combined.push(normalized);
    });
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) {
        combined = combined.concat(parsed);
      }
    }
    const seen = new Set();
    quickSearchTerms = combined
      .map(normalizeQuickSearchTerm)
      .filter(Boolean)
      .filter(term => !isQuickSearchTermRemoved(term))
      .filter(term => {
        const key = term.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  } catch {
    quickSearchTerms = DEFAULT_QUICK_SEARCHES.slice();
  }
}

function persistQuickSearchTerms() {
  if (typeof localStorage === 'undefined') return;
  try {
    const customTerms = quickSearchTerms.filter(term => !isDefaultQuickSearch(term));
    localStorage.setItem(QUICK_SEARCHES_KEY, JSON.stringify(customTerms));
  } catch {
    // ignore persistence failures
  }
}

function addQuickSearchTerm(term) {
  const normalized = normalizeQuickSearchTerm(term);
  if (!normalized) return false;
  const exists = quickSearchTerms.some(t => t.toLowerCase() === normalized.toLowerCase());
  if (exists) return false;
  quickSearchTerms.push(normalized);
  restoreQuickSearchTerm(normalized);
  persistQuickSearchTerms();
  return true;
}

function removeQuickSearchTerm(term) {
  if (!term) return false;
  const normalized = term.toLowerCase();
  const nextTerms = quickSearchTerms.filter(t => t.toLowerCase() !== normalized);
  if (nextTerms.length === quickSearchTerms.length) return false;
  quickSearchTerms = nextTerms;
  persistQuickSearchTerms();
  markQuickSearchTermRemoved(term);
  return true;
}

const AI_KEY_STORAGE = 'travelOpenAiKey';
const AI_SUMMARY_STORAGE = 'travelAiSummaries';
const aiSummaries = new Map();
let openAiKey = '';

function buildAiSummaryKey(title, subtitle) {
  const keyTitle = (title || '').trim();
  const keySubtitle = (subtitle || '').trim();
  if (!keyTitle && !keySubtitle) return '';
  return `${keyTitle}||${keySubtitle}`;
}

function loadAiSummaries() {
  if (typeof localStorage === 'undefined') return;
  try {
    const stored = localStorage.getItem(AI_SUMMARY_STORAGE);
    if (!stored) return;
    const parsed = JSON.parse(stored);
    if (parsed && typeof parsed === 'object') {
      Object.entries(parsed).forEach(([key, value]) => {
        if (typeof value === 'string') {
          aiSummaries.set(key, value);
        }
      });
    }
  } catch {
    // ignore
  }
}

function persistAiSummaries() {
  if (typeof localStorage === 'undefined') return;
  try {
    const obj = Object.fromEntries(aiSummaries);
    localStorage.setItem(AI_SUMMARY_STORAGE, JSON.stringify(obj));
  } catch {
    // ignore
  }
}

function setAiSummaryForKey(key, text) {
  if (!key) return;
  if (text) {
    aiSummaries.set(key, text);
  } else {
    aiSummaries.delete(key);
  }
  persistAiSummaries();
}

function loadOpenAiKey() {
  if (typeof localStorage === 'undefined') return;
  try {
    const stored = localStorage.getItem(AI_KEY_STORAGE);
    if (stored) {
      openAiKey = stored;
    }
  } catch {
    // ignore
  }
}

function persistOpenAiKey(value) {
  if (typeof localStorage === 'undefined') return;
  try {
    if (value) {
      localStorage.setItem(AI_KEY_STORAGE, value);
    } else {
      localStorage.removeItem(AI_KEY_STORAGE);
    }
  } catch {
    // ignore
  }
}

loadAiSummaries();
loadOpenAiKey();

function extractAiResponseText(data) {
  if (!data || !Array.isArray(data.output)) return '';
  const texts = [];
  data.output.forEach(item => {
    if (item?.type === 'output_text' && typeof item.text === 'string') {
      texts.push(item.text);
    }
    if (Array.isArray(item?.content)) {
      item.content.forEach(content => {
        if (content?.type === 'output_text' && typeof content.text === 'string') {
          texts.push(content.text);
        }
      });
    }
  });
  return texts.join(' ').trim();
}

async function fetchOpenAiSummary({ title, subtitle }) {
  if (!openAiKey) {
    throw new Error('OpenAI API key is required');
  }
  const safeTitle = (title || 'this place').trim();
  const safeSubtitle = (subtitle || '').trim();
  const locationHint = safeSubtitle ? ` at ${safeSubtitle}` : '';
  const prompt = `Write a concise description of ${safeTitle}${locationHint}, including its address and what makes the place notable.`;
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${openAiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-5.1',
      input: [
        {
          role: 'user',
          content: prompt
        }
      ],
      text: {
        format: { type: 'text' },
        verbosity: 'medium'
      },
      reasoning: {
        effort: 'medium'
      },
      tools: [],
      store: true,
      include: ['reasoning.encrypted_content', 'web_search_call.action.sources']
    })
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    const message = errorData?.error?.message || 'Failed to fetch AI summary.';
    throw new Error(message);
  }
  const data = await response.json();
  const outputText = extractAiResponseText(data);
  if (!outputText) {
    throw new Error('No summary returned');
  }
  return outputText;
}

function renderAiSummarySection(el, { title, subtitle }) {
  if (!el) return;
  const summaryKey = buildAiSummaryKey(title, subtitle);
  const cached = summaryKey ? aiSummaries.get(summaryKey) || '' : '';

  el.innerHTML = '';

  const actions = document.createElement('div');
  actions.className = 'ai-summary__actions';
  const generateBtn = document.createElement('button');
  generateBtn.type = 'button';
  generateBtn.textContent = 'Generate AI summary';
  actions.appendChild(generateBtn);

  const spinner = document.createElement('span');
  spinner.className = 'ai-summary__spinner';
  spinner.setAttribute('aria-hidden', 'true');
  spinner.style.display = 'none';
  actions.appendChild(spinner);

  el.appendChild(actions);

  let resultEl = null;
  const ensureResultEl = text => {
    if (!resultEl) {
      resultEl = document.createElement('div');
      resultEl.className = 'ai-summary__result';
      el.appendChild(resultEl);
    }
    if (text !== undefined) {
      resultEl.textContent = text;
    }
  };
  if (cached) {
    ensureResultEl(cached);
  }

  const showSpinner = () => {
    spinner.style.display = '';
  };
  const hideSpinner = () => {
    spinner.style.display = 'none';
  };

  generateBtn.addEventListener('click', async () => {
    if (!openAiKey) {
      alert('OpenAI API key required to generate summaries.');
      return;
    }
    generateBtn.disabled = true;
    showSpinner();
    try {
      const text = await fetchOpenAiSummary({ title: title || '', subtitle });
      ensureResultEl(text);
      if (summaryKey) {
        setAiSummaryForKey(summaryKey, text);
      }
    } catch (err) {
      const message = err?.message || 'Failed to fetch summary.';
      alert(message);
    } finally {
      generateBtn.disabled = false;
      hideSpinner();
    }
  });
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
  if (activeContextRefresh) {
    activeContextRefresh();
  } else {
    updateVisiblePlacemarkList();
  }
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
  className: 'travel-search-result-icon'
});

const selectedIcon = L.icon({
  iconUrl: createSvgUrl('#FFB300'),
  iconSize: [28, 28],
  iconAnchor: [14, 14],
  popupAnchor: [0, -14],
});

const USER_HOME_ZOOM = 12;

function setContextRefresh(fn) {
  activeContextRefresh = typeof fn === 'function' ? fn : null;
}

function handleMapMove() {
  if (activeContextRefresh) {
    activeContextRefresh();
  } else {
    updateVisiblePlacemarkList();
  }
}

function focusMapNearUser() {
  if (!map || !Array.isArray(userCoords)) return;
  const [lat, lon] = userCoords;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  map.setView([lat, lon], USER_HOME_ZOOM);
}

const NOMINATIM_RESULT_LIMIT = 15;

const OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter?data=';
const OVERPASS_TIMEOUT = 25;
const OVERPASS_CATEGORY_CONFIGS = [
  {
    filter: '["amenity"="cinema"]',
    label: 'Cinema',
    matcher: term => /\b(?:movie|cinema|theater|theatre)\b/.test(term)
  },
  {
    filter: '["amenity"="restaurant"]',
    label: 'Restaurant',
    matcher: term => /\b(?:restaurant|restaurants)\b/.test(term)
  },
  {
    filter: '["leisure"="park"]',
    label: 'Park',
    matcher: term => /\b(?:park|parks)\b/.test(term)
  }
];

function getOverpassCategoryConfig(term) {
  if (!term) return null;
  const normalized = term.toLowerCase();
  return (
    OVERPASS_CATEGORY_CONFIGS.find(config => config.matcher(normalized)) || null
  );
}

function buildOverpassBounds(bounds) {
  if (!bounds || typeof bounds.getSouth !== 'function') return null;
  const south = bounds.getSouth().toFixed(6);
  const west = bounds.getWest().toFixed(6);
  const north = bounds.getNorth().toFixed(6);
  const east = bounds.getEast().toFixed(6);
  return `${south},${west},${north},${east}`;
}

async function fetchOverpassPlaces(config, bounds) {
  const bbox = buildOverpassBounds(bounds);
  if (!bbox) return [];
  const query =
    `[out:json][timeout:${OVERPASS_TIMEOUT}];` +
    `(node${config.filter}(${bbox});` +
    `way${config.filter}(${bbox});` +
    `relation${config.filter}(${bbox}););` +
    'out center;';
  const resp = await fetch(`${OVERPASS_ENDPOINT}${encodeURIComponent(query)}`);
  if (!resp.ok) {
    throw new Error('Overpass request failed');
  }
  const data = await resp.json();
  if (!Array.isArray(data?.elements)) return [];
  const toNumber = value => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  return data.elements
    .map(element => {
      const latitude =
        toNumber(element.lat) ?? toNumber(element.center?.lat);
      const longitude =
        toNumber(element.lon) ?? toNumber(element.center?.lon);
      if (latitude === null || longitude === null) return null;
      const name = (element.tags?.name || '').trim();
      const subtitleParts = [];
      const subtitleKeys = [
        'brand',
        'operator',
        'addr:street',
        'addr:city',
        'addr:state',
        'addr:postcode',
        'addr:country'
      ];
      subtitleKeys.forEach(key => {
        const value = element.tags?.[key];
        if (value) subtitleParts.push(value);
      });
      const title = name || config.label || 'Search result';
      const remoteId = `overpass:${element.type}:${element.id}`;
      return {
        title,
        subtitle: subtitleParts.join(', ') || config.label || '',
        lat: latitude,
        lon: longitude,
        remoteId,
        hiddenKey: buildHiddenResultKey({
          remoteId,
          lat: latitude,
          lon: longitude,
          title
        })
      };
    })
    .filter(Boolean)
    .slice(0, 25);
}

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

function buildPlaceLocationHint(place) {
  if (!place) return '';
  const parts = [];
  if (place.description) parts.push(place.description);
  if (Array.isArray(place.tags) && place.tags.length) {
    parts.push(place.tags.join(', '));
  }
  if (Number.isFinite(place.lat) && Number.isFinite(place.lon)) {
    parts.push(`${place.lat}, ${place.lon}`);
  }
  return parts.join(' • ');
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

function getVisibleMarkersSnapshot() {
  const totalPlaces = travelData.length;
  const activeMarkers = markers.filter(m => m && m.place);
  let visibleMarkers = activeMarkers;
  if (map && typeof map.getBounds === 'function') {
    const bounds = map.getBounds();
    visibleMarkers = activeMarkers.filter(marker => bounds.contains(marker.getLatLng()));
  }
  const canUseProximitySort =
    Array.isArray(userCoords) &&
    Number.isFinite(userCoords[0]) &&
    Number.isFinite(userCoords[1]);
  visibleMarkers = visibleMarkers.slice().sort((a, b) => {
    const hasCoords = marker =>
      marker?.place &&
      Number.isFinite(marker.place.lat) &&
      Number.isFinite(marker.place.lon);
    if (canUseProximitySort && hasCoords(a) && hasCoords(b)) {
      const distA = haversine(userCoords[0], userCoords[1], a.place.lat, a.place.lon);
      const distB = haversine(userCoords[0], userCoords[1], b.place.lat, b.place.lon);
      if (Number.isFinite(distA) && Number.isFinite(distB)) {
        if (Math.abs(distA - distB) < 1e-6) {
          return (a.place.name || '').localeCompare(b.place.name || '');
        }
        return distA - distB;
      }
    }
    return (a.place.name || '').localeCompare(b.place.name || '');
  });
  return { totalPlaces, activeMarkers, visibleMarkers };
}

function createVisibleMarkersList(visibleMarkers) {
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
  return list;
}

function renderContextSection(parent, { emptyMessage } = {}) {
  const section = document.createElement('div');
  section.className = 'placemark-search-context';
  parent.appendChild(section);
  const updateSection = () => {
    section.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'placemark-overview__header';
    header.textContent = 'Other places in this map view';
    section.appendChild(header);
    const { visibleMarkers } = getVisibleMarkersSnapshot();
    if (visibleMarkers.length) {
      section.appendChild(createVisibleMarkersList(visibleMarkers));
    } else {
      const empty = document.createElement('div');
      empty.className = 'placemark-overview__empty';
      empty.textContent = emptyMessage || 'No places in the current map view.';
      section.appendChild(empty);
    }
  };
  updateSection();
  setContextRefresh(updateSection);
  return section;
}

function renderPlacemarkOverview() {
  showingSearchResultDetails = false;
  if (!placemarkDetailsEl) return;
  placemarkDetailsEl.innerHTML = '';
  setContextRefresh(null);

  const header = document.createElement('div');
  header.className = 'placemark-overview__header';
  header.textContent = 'Places in map view';
  placemarkDetailsEl.appendChild(header);

  const { totalPlaces, activeMarkers, visibleMarkers } = getVisibleMarkersSnapshot();

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

  if (visibleMarkers.length === 0) {
    const message = document.createElement('div');
    message.className = 'placemark-overview__empty';
    message.textContent = 'No places in the current map view. Pan or zoom to find more.';
    placemarkDetailsEl.appendChild(message);
    return;
  }

  placemarkDetailsEl.appendChild(createVisibleMarkersList(visibleMarkers));
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

    const summarySection = document.createElement('div');
    summarySection.className = 'placemark-summary';
    placemarkDetailsEl.appendChild(summarySection);
    renderAiSummarySection(summarySection, {
      title: result.title || '',
      subtitle: result.description || result.subtitle || ''
    });

    if (actions.childElementCount > 0) {
      placemarkDetailsEl.appendChild(actions);
    }

    renderContextSection(placemarkDetailsEl, {
      emptyMessage: 'No saved places are currently visible.'
    });
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
    onDismiss,
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

  if (typeof onDismiss === 'function') {
    li.classList.add('search-result-card--dismissable');
    const dismissBtn = document.createElement('button');
    dismissBtn.type = 'button';
    dismissBtn.className = 'search-result-card__dismiss';
    dismissBtn.setAttribute('aria-label', 'Hide this result');
    dismissBtn.textContent = '×';
    dismissBtn.addEventListener('click', e => {
      e.stopPropagation();
      onDismiss();
    });
    li.append(dismissBtn);
  }

  if (variant === 'existing') {
    const badge = document.createElement('span');
    badge.className = 'search-result-card__badge';
    badge.textContent = 'Already saved';
    li.append(badge);
  }

  if (typeof onAdd === 'function') {
    const actions = document.createElement('div');
    actions.className = 'placemark-details__actions placemark-details__actions--search search-result-card__actions';
    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'placemark-details__edit-btn';
    addBtn.textContent = 'Add to my places';
    addBtn.addEventListener('click', e => {
      e.stopPropagation();
      onAdd();
    });
    actions.append(addBtn);
    li.append(actions);
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

  let visitedToggleEl = null;
  if (!editing) {
    visitedToggleEl = document.createElement('label');
    visitedToggleEl.className = 'placemark-details__visited-toggle';
    const visitedCheckbox = document.createElement('input');
    visitedCheckbox.type = 'checkbox';
    visitedCheckbox.checked = !!place.visited;
    visitedCheckbox.title = 'Visited';
    visitedCheckbox.setAttribute('aria-label', 'Visited');
    const visitedText = document.createElement('span');
    visitedText.textContent = 'Visited';
    visitedToggleEl.append(visitedCheckbox, visitedText);
    let updatingVisited = false;
    visitedCheckbox.addEventListener('change', async () => {
      if (updatingVisited) return;
      if (typeof savePlaceEdits !== 'function') {
        console.warn('Visited toggle unavailable until data sync is ready.');
        visitedCheckbox.checked = !visitedCheckbox.checked;
        return;
      }
      updatingVisited = true;
      visitedCheckbox.disabled = true;
      const nextVisited = visitedCheckbox.checked;
      try {
        await savePlaceEdits(place, { visited: nextVisited });
      } catch (err) {
        console.error('Failed to update visited state', err);
        visitedCheckbox.checked = !nextVisited;
      } finally {
        visitedCheckbox.disabled = false;
        updatingVisited = false;
      }
    });
  }

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

  if (visitedToggleEl) {
    placemarkDetailsEl.appendChild(visitedToggleEl);
  }

  if (!editing && tagsSection) {
    placemarkDetailsEl.appendChild(tagsSection);
  }

  let summarySection = null;
  if (!editing) {
    summarySection = document.createElement('div');
    summarySection.className = 'placemark-summary';
    placemarkDetailsEl.appendChild(summarySection);
    renderAiSummarySection(summarySection, {
      title: place.name || '',
      subtitle: buildPlaceLocationHint(place)
    });
  } else {
    setContextRefresh(null);
  }

  let tagListId = null;
  const actions = document.createElement('div');
  actions.className = 'placemark-details__actions';

  if (editing) {
    setContextRefresh(null);
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
    const linkGroup = document.createElement('div');
    linkGroup.className = 'placemark-details__direction-links';

    const directionsLink = document.createElement('a');
    directionsLink.className = 'placemark-details__directions';
    directionsLink.href = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
    directionsLink.target = '_blank';
    directionsLink.rel = 'noopener noreferrer';
    directionsLink.textContent = 'Get Directions';

    const separator = document.createElement('span');
    separator.className = 'placemark-details__direction-separator';
    separator.textContent = ' | ';

    const webSearchLink = document.createElement('a');
    webSearchLink.className = 'placemark-details__web-search';
    const searchName = encodeURIComponent(place.name || 'place');
    webSearchLink.href = `https://www.google.com/search?q=${searchName}`;
    webSearchLink.target = '_blank';
    webSearchLink.rel = 'noopener noreferrer';
    webSearchLink.textContent = 'Search the Web';

    linkGroup.append(directionsLink, separator, webSearchLink);
    actions.append(linkGroup);
  }

  if (actions.childElementCount > 0) {
    placemarkDetailsEl.appendChild(actions);
  }

  if (!editing) {
    renderContextSection(placemarkDetailsEl, {
      emptyMessage: 'No other saved places are currently visible.'
    });
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
  const quickSearchContainer = document.getElementById('quickSearches');
  const quickSearchForm = document.getElementById('quickSearchForm');
  const quickSearchInput = document.getElementById('quickSearchInput');
  const placeSearchStatusEl = document.getElementById('placeSearchStatus');
  const sortByProximityBtn = document.getElementById('sortByProximityBtn');
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
  map.on('moveend', handleMapMove);
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
  const persistPlaceUpdates = async (place, updates = {}) => {
    if (!place) return;
    const hasProp = key => Object.prototype.hasOwnProperty.call(updates, key);
    if (hasProp('name')) {
      place.name = updates.name;
    } else if (typeof place.name === 'undefined') {
      place.name = '';
    }
    if (hasProp('description')) {
      place.description = updates.description;
    } else if (typeof place.description === 'undefined') {
      place.description = '';
    }
    if (hasProp('tags')) {
      place.tags = Array.isArray(updates.tags) ? updates.tags : [];
    } else if (!Array.isArray(place.tags)) {
      place.tags = [];
    }
    ensureDefaultTag(place);
    if (hasProp('Rating')) {
      place.Rating = updates.Rating;
    } else if (typeof place.Rating === 'undefined') {
      place.Rating = '';
    }
    if (hasProp('Date')) {
      place.Date = updates.Date;
    } else if (typeof place.Date === 'undefined') {
      place.Date = '';
    }
    if (hasProp('visited')) {
      place.visited = !!updates.visited;
    } else {
      place.visited = !!place.visited;
    }
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
    if (activeContextRefresh) {
      activeContextRefresh();
    } else {
      updateVisiblePlacemarkList();
    }
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
        focusMapNearUser();
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

  const ZIP_CODE_REGEX = /^\d{5}(?:-\d{4})?$/;
  const isUnitedStates = value => {
    if (!value) return false;
    return /united states/i.test(value) || value.toLowerCase() === 'us';
  };
  const formatSearchResultSubtitle = (displayName, title, address = {}) => {
    if (!displayName) return '';
    const rawParts = displayName
      .split(',')
      .map(p => p.trim())
      .filter(Boolean);
    if (!rawParts.length) return '';
    const parts = [];
    for (let i = 0; i < rawParts.length; i += 1) {
      const current = rawParts[i];
      const next = rawParts[i + 1];
      if (/^\d+$/.test(current) && next && /^[A-Za-z]/.test(next)) {
        parts.push(`${current} ${next}`);
        i += 1;
      } else {
        parts.push(current);
      }
    }
    const normalizedTitle = (title || '').trim().toLowerCase();
    const countryCode = address?.country_code?.toLowerCase();
    const displayIndicatesUS = parts.some(part => /united states/i.test(part));
    const removeCountry = countryCode === 'us' || (!countryCode && displayIndicatesUS);
    const cleaned = [];
    parts.forEach((part, idx) => {
      const normalizedPart = part.toLowerCase();
      if (idx === 0 && normalizedTitle && normalizedPart === normalizedTitle) {
        return;
      }
      if (/county/i.test(part)) return;
      if (ZIP_CODE_REGEX.test(part.replace(/\s+/g, ''))) return;
      if (removeCountry && isUnitedStates(part)) return;
      cleaned.push(part);
    });
    if (!cleaned.length) {
      const fallback = parts.filter(
        (part, idx) => !(idx === 0 && normalizedTitle && part.toLowerCase() === normalizedTitle)
      );
      return fallback.join(', ');
    }
    return cleaned.join(', ');
  };

  const setSearchStatus = (message = '', showSpinner = false) => {
    if (!placeSearchStatusEl) return;
    placeSearchStatusEl.innerHTML = '';
    if (!message) return;
    if (showSpinner) {
      const spinner = document.createElement('span');
      spinner.className = 'place-search-status__spinner';
      placeSearchStatusEl.appendChild(spinner);
    }
    placeSearchStatusEl.appendChild(document.createTextNode(message));
  };

  const NOMINATIM_BASE_URL = `https://nominatim.openstreetmap.org/search?format=json&limit=${NOMINATIM_RESULT_LIMIT}`;
  const buildViewboxParams = bounds =>
    bounds && typeof bounds.getWest === 'function'
      ? `&viewbox=${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()},${bounds.getSouth()}&bounded=1`
      : '';
  const extractNominatimSummaries = data => {
    if (!Array.isArray(data)) return [];
    return data
      .map(res => {
        const { lat, lon, display_name, address, place_id } = res;
        const latitude = parseFloat(lat);
        const longitude = parseFloat(lon);
        if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
        const placeTitle = (display_name?.split(',')[0] || display_name || '').trim();
        const subtitle = formatSearchResultSubtitle(display_name, placeTitle, address);
        const hiddenKey = buildHiddenResultKey({
          remoteId: place_id,
          lat: latitude,
          lon: longitude,
          title: placeTitle
        });
        if (isSearchResultHidden(hiddenKey)) return null;
        return {
          title: placeTitle || 'Search result',
          subtitle,
          lat: latitude,
          lon: longitude,
          hiddenKey
        };
      })
      .filter(Boolean);
  };
  const queryNominatimForTerm = async (term, viewboxParams) => {
    const resp = await fetch(`${NOMINATIM_BASE_URL}&q=${encodeURIComponent(term)}${viewboxParams || ''}`);
    if (!resp.ok) throw new Error('Search request failed');
    const data = await resp.json();
    return extractNominatimSummaries(data);
  };

  const RESULT_CLUSTER_TARGET_FRACTION = 0.75;
  const RESULT_CLUSTER_MAX_ZOOM = 13;
  const selectDenseCluster = points => {
    if (!Array.isArray(points) || points.length <= 2) return points || [];
    const targetCount = Math.max(2, Math.ceil(points.length * RESULT_CLUSTER_TARGET_FRACTION));
    let bestCluster = points;
    let tightestRadius = Infinity;
    points.forEach(([anchorLat, anchorLon]) => {
      const distances = points
        .map(point => ({
          point,
          distance: haversine(anchorLat, anchorLon, point[0], point[1])
        }))
        .sort((a, b) => a.distance - b.distance);
      const subset = distances.slice(0, targetCount);
      const radius = subset[subset.length - 1]?.distance ?? Infinity;
      if (radius < tightestRadius) {
        tightestRadius = radius;
        bestCluster = subset.map(entry => entry.point);
      }
    });
    return bestCluster;
  };

  const focusMapOnResultCluster = points => {
    if (!map || !Array.isArray(points) || !points.length) return;
    if (points.length === 1) {
      map.setView(points[0], 14);
      return;
    }
    const clusterPoints = selectDenseCluster(points);
    if (!clusterPoints.length) return;
    if (clusterPoints.length === 1) {
      map.setView(clusterPoints[0], 14);
      return;
    }
    const bounds = L.latLngBounds(clusterPoints.map(([lat, lon]) => [lat, lon]));
    map.fitBounds(bounds, {
      padding: [48, 48],
      maxZoom: RESULT_CLUSTER_MAX_ZOOM
    });
  };

  const searchForPlace = async (termOverride = null, options = {}) => {
    const providedTerm = termOverride ?? placeInput?.value ?? '';
    const term = providedTerm.trim();
    if (!term) return;
    if (placeInput && termOverride !== null) {
      placeInput.value = term;
    }
    clearSearchResults();

    const bounds = options?.bounds ?? map?.getBounds?.();
    const viewboxParams = buildViewboxParams(bounds);

    setSearchStatus(`Searching for "${term}"…`, true);

    const searchResultLatLngs = [];
    const savedMatchLatLngs = [];
    const registerResultLatLng = (lat, lon, source = 'search') => {
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
      if (source === 'saved') {
        savedMatchLatLngs.push([lat, lon]);
      } else {
        searchResultLatLngs.push([lat, lon]);
      }
    };
    let focusApplied = false;
    const applyResultFocus = () => {
      if (focusApplied) return;
      const focusPoints = searchResultLatLngs.length
        ? searchResultLatLngs
        : savedMatchLatLngs;
      if (focusPoints.length) {
        focusMapOnResultCluster(focusPoints);
        focusApplied = true;
      }
    };

    const appendSectionHeader = text => {
      if (!resultsList) return;
      const header = document.createElement('li');
      header.className = 'search-results__header';
      header.textContent = text;
      resultsList.append(header);
    };

    const normalizedTerm = term.toLowerCase();
    const searchWords = normalizedTerm.split(/\s+/).filter(Boolean);
    const matchesSearchWords = text =>
      searchWords.length > 0 &&
      searchWords.every(word => text.includes(word));

    const existingMatches = travelData.filter(place => {
      const haystack = `${place.name || ''} ${place.description || ''}`.toLowerCase();
      return matchesSearchWords(haystack);
    });

    if (existingMatches.length) {
      appendSectionHeader('Saved places');
    }

      existingMatches.forEach(p => {
        registerResultLatLng(p.lat, p.lon, 'saved');
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
      registerResultLatLng(lat, lon);
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
      setSearchStatus('', false);
      applyResultFocus();
      return;
    }

    try {
      let placeSummaries = await queryNominatimForTerm(term, viewboxParams);
      let boundsForCategorySearch = bounds;
      if (!placeSummaries.length && viewboxParams && bounds?.pad) {
        setSearchStatus('No results within the current view; expanding area…', true);
        const expandedBounds = bounds.pad(2);
        const expandedViewbox = buildViewboxParams(expandedBounds);
        if (expandedViewbox) {
          placeSummaries = await queryNominatimForTerm(term, expandedViewbox);
          boundsForCategorySearch = expandedBounds;
        }
      }

      const overpassConfig = getOverpassCategoryConfig(normalizedTerm);
      if (overpassConfig && boundsForCategorySearch) {
        try {
          const overpassResults = await fetchOverpassPlaces(overpassConfig, boundsForCategorySearch);
          overpassResults.forEach(extra => {
            if (!extra || isSearchResultHidden(extra.hiddenKey)) return;
            placeSummaries.push(extra);
          });
        } catch (overpassErr) {
          console.warn('Overpass search failed', overpassErr);
        }
      }

      const matchesSummary = summary => {
        const titleText = `${summary.title || ''} ${summary.subtitle || ''}`.toLowerCase();
        return matchesSearchWords(titleText);
      };
      let filteredSummaries = placeSummaries.filter(matchesSummary);
      if (!filteredSummaries.length && !existingMatches.length) {
        setSearchStatus(`No nearby results for "${term}"; searching worldwide…`, true);
        const globalResults = await queryNominatimForTerm(term);
        filteredSummaries = globalResults.filter(matchesSummary);
        if (filteredSummaries.length) {
          setSearchStatus(`Showing best worldwide match for "${term}".`, true);
        }
      }

      if (filteredSummaries.length) {
        appendSectionHeader(existingMatches.length ? 'Other results' : 'Search results');
        filteredSummaries.forEach(placeSummary => {
          const latitude = placeSummary.lat;
          const longitude = placeSummary.lon;
          if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
          registerResultLatLng(latitude, longitude);
          let card;
          let marker;
          const hiddenKey = placeSummary.hiddenKey;
          const handleDismiss = () => {
            if (hiddenKey) {
              markSearchResultHidden(hiddenKey);
            }
            if (card?.isConnected) {
              card.remove();
            }
            if (marker) {
              marker.remove();
              resultMarkers = resultMarkers.filter(m => m !== marker);
            }
            if (activeSearchResultCard === card) {
              activeSearchResultCard = null;
              renderPlacemarkOverview();
            }
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
            placeInput.value = '';
          };
          const config = {
            onAdd: handleAdd,
            onFocus: () => {
              map.setView([latitude, longitude], 14);
              showDetails();
            },
            onDismiss: handleDismiss
          };
          card = createSearchResultListItem(
            {
              title: placeSummary.title,
              subtitle: placeSummary.subtitle || '',
              lat: latitude,
              lon: longitude,
            },
            config
          );
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
          marker = L.marker([latitude, longitude], { icon: resultIcon }).addTo(map);
          resultMarkers.push(marker);
          marker.on('click', () => {
            map.setView([latitude, longitude], 14);
            showDetails();
          });
        });
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
    } finally {
      setSearchStatus('', false);
    }
    applyResultFocus();

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

  const handleQuickSearch = term => {
    const normalized = normalizeQuickSearchTerm(term);
    if (!normalized) return;
    if (placeInput) {
      placeInput.value = normalized;
    }
    const bounds = map?.getBounds?.();
    searchForPlace(normalized, { bounds });
  };

  const renderQuickSearches = () => {
    if (!quickSearchContainer) return;
    quickSearchContainer.innerHTML = '';
    if (!quickSearchTerms.length) {
      const empty = document.createElement('div');
      empty.className = 'placemark-overview__empty';
      empty.textContent = 'No saved categories yet.';
      quickSearchContainer.appendChild(empty);
      return;
    }
    quickSearchTerms.forEach(term => {
      const pill = document.createElement('span');
      pill.className = 'quick-search-pill';
      const searchBtn = document.createElement('button');
      searchBtn.type = 'button';
      searchBtn.className = 'quick-search-link';
      searchBtn.textContent = term;
      searchBtn.addEventListener('click', () => handleQuickSearch(term));
      pill.appendChild(searchBtn);
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'quick-search-link__remove';
      removeBtn.setAttribute('aria-label', `Remove ${term}`);
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', () => {
        removeQuickSearchTerm(term);
        renderQuickSearches();
      });
      pill.appendChild(removeBtn);
      quickSearchContainer.appendChild(pill);
    });
  };

  renderQuickSearches();

  quickSearchForm?.addEventListener('submit', e => {
    e.preventDefault();
    const value = quickSearchInput?.value || '';
    const added = addQuickSearchTerm(value);
    if (added) {
      renderQuickSearches();
    }
    if (quickSearchInput) {
      quickSearchInput.value = '';
    }
  });

  sortByProximityBtn?.addEventListener('click', () => {
    sortByDistance = true;
    sortKey = null;
    renderList(currentSearch);
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
