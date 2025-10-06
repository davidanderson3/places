import {
  buildRapidApiHeaders,
  getDefaultEventsCountry,
  getEventsUrl,
  getRapidApiKey
} from './rapidApiConfig.js';

const STORAGE_KEYS = {
  city: 'eventsPanel:lastCity',
  keyword: 'eventsPanel:lastKeyword',
  country: 'eventsPanel:lastCountry'
};

let panelInitialized = false;
let hasRunInitialSearch = false;
let activeController = null;

function readStorage(key, fallback = '') {
  try {
    const value = localStorage.getItem(key);
    return value == null ? fallback : value;
  } catch (err) {
    console.warn('Failed to read localStorage for key', key, err);
    return fallback;
  }
}

function writeStorage(key, value) {
  try {
    if (value) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch (err) {
    console.warn('Failed to persist localStorage value for key', key, err);
  }
}

function updateStatus(el, message, variant = 'info') {
  if (!el) return;
  const classes = [
    'events-status--info',
    'events-status--success',
    'events-status--error',
    'events-status--warning'
  ];
  el.classList.remove(...classes);
  if (!message) {
    el.textContent = '';
    el.removeAttribute('data-active');
    return;
  }
  const normalizedVariant = classes.some(cls => cls.endsWith(variant))
    ? variant
    : 'info';
  el.textContent = message;
  el.setAttribute('data-active', 'true');
  el.classList.add(`events-status--${normalizedVariant}`);
}

function truncate(text, maxLength = 220) {
  if (!text) return '';
  const trimmed = text.trim();
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength - 1).trim()}…`;
}

function buildEventsUrl({ city, keyword, country }) {
  const base = getEventsUrl();
  const url = new URL(base);
  const params = url.searchParams;

  if (!params.has('size')) params.set('size', '20');
  if (!params.has('sort')) params.set('sort', 'date,asc');

  if (city) {
    params.set('city', city);
  } else {
    params.delete('city');
  }

  if (keyword) {
    params.set('keyword', keyword);
  } else {
    params.delete('keyword');
  }

  if (country) {
    params.set('countryCode', country);
  } else {
    params.delete('countryCode');
  }

  url.search = params.toString();
  return url.toString();
}

function normalizeEvents(data) {
  if (!data) return [];
  const candidates = [];
  if (Array.isArray(data)) candidates.push(data);
  if (Array.isArray(data.events)) candidates.push(data.events);
  if (Array.isArray(data.data)) candidates.push(data.data);
  if (Array.isArray(data.results)) candidates.push(data.results);
  if (data._embedded && Array.isArray(data._embedded.events)) {
    candidates.push(data._embedded.events);
  }
  const list = candidates.find(Array.isArray) || [];
  return list
    .map(coerceEvent)
    .filter(Boolean);
}

function coerceEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const start = raw.dates?.start || raw.start || {};
  let dateTime = start.dateTime || raw.startDateTime || raw.datetime || raw.start_date;
  let dateOnly = start.localDate || raw.localDate || raw.date || raw.event_date;
  if (!dateTime && dateOnly && start.localTime) {
    dateTime = `${dateOnly}T${start.localTime}`;
  } else if (!dateOnly && dateTime && typeof dateTime === 'string') {
    dateOnly = dateTime.split('T')[0];
  }

  const venueCandidate =
    raw._embedded?.venues?.[0] ||
    (Array.isArray(raw.venues) ? raw.venues[0] : null) ||
    raw.venue ||
    raw.location ||
    {};

  const classification =
    raw.classifications?.[0] ||
    raw.category ||
    raw.segment ||
    raw.type ||
    {};

  let image = null;
  if (Array.isArray(raw.images) && raw.images.length) {
    image = raw.images
      .slice()
      .sort((a, b) => (b.width || 0) - (a.width || 0))[0]?.url;
  }
  if (!image) {
    image = raw.image || raw.thumbnail || raw.poster || null;
  }

  const description =
    raw.info ||
    raw.description ||
    raw.summary ||
    raw.long_description ||
    raw.short_description ||
    '';

  return {
    id: raw.id || raw._id || raw.uuid || `${raw.name || raw.title || 'event'}-${dateTime || Date.now()}`,
    name: raw.name || raw.title || raw.event_name || 'Untitled event',
    description,
    url: raw.url || raw.event_url || raw.link || '',
    image,
    dateTime,
    dateOnly,
    venueName:
      venueCandidate.name ||
      venueCandidate.venue ||
      venueCandidate.title ||
      venueCandidate.place ||
      venueCandidate.address?.name ||
      '',
    address:
      venueCandidate.address?.line1 ||
      venueCandidate.address?.line ||
      venueCandidate.address ||
      venueCandidate.street ||
      '',
    city: venueCandidate.city?.name || venueCandidate.city || venueCandidate.town || venueCandidate.location || '',
    state:
      venueCandidate.state?.stateCode ||
      venueCandidate.state?.name ||
      venueCandidate.state ||
      venueCandidate.region ||
      '',
    country:
      venueCandidate.country?.countryCode ||
      venueCandidate.country?.code ||
      venueCandidate.country ||
      '',
    timezone: start.timezone || raw.timezone || venueCandidate.timezone || '',
    classification:
      classification.genre?.name ||
      classification.segment?.name ||
      classification.name ||
      classification.type ||
      (typeof classification === 'string' ? classification : ''),
    priceRanges: raw.priceRanges || raw.prices || raw.price_range || null
  };
}

function formatEventDate(event) {
  const input = event.dateTime || (event.dateOnly ? `${event.dateOnly}T00:00:00` : null);
  if (!input) return '';
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) {
    return event.dateOnly || event.dateTime || '';
  }
  const options = { dateStyle: 'medium' };
  if (event.dateTime && /T/.test(event.dateTime)) {
    options.timeStyle = 'short';
  }
  return new Intl.DateTimeFormat(undefined, options).format(date);
}

function formatLocation(event) {
  const parts = [];
  if (event.venueName) parts.push(event.venueName);
  const cityState = [event.city, event.state].filter(Boolean).join(', ');
  if (cityState) parts.push(cityState);
  if (event.country && !cityState.includes(event.country)) parts.push(event.country);
  return parts.join(' • ');
}

function describePrice(priceRanges) {
  if (!priceRanges) return '';
  if (Array.isArray(priceRanges)) {
    const [range] = priceRanges;
    if (!range) return '';
    const min = typeof range.min === 'number' ? range.min : null;
    const max = typeof range.max === 'number' ? range.max : null;
    const currency = range.currency || '';
    if (min != null && max != null) {
      return `From ${currency}${min.toFixed(2)} to ${currency}${max.toFixed(2)}`;
    }
    if (min != null) return `From ${currency}${min.toFixed(2)}`;
    if (max != null) return `Up to ${currency}${max.toFixed(2)}`;
    return '';
  }
  if (typeof priceRanges === 'string') return priceRanges;
  return '';
}

function renderEvents(events, container) {
  container.innerHTML = '';
  const limited = events.slice(0, 20);
  limited.forEach(event => {
    const li = document.createElement('li');
    li.className = 'events-result';

    const card = document.createElement('article');
    card.className = 'events-card';

    if (event.image) {
      const figure = document.createElement('div');
      figure.className = 'events-card-media';
      const img = document.createElement('img');
      img.src = event.image;
      img.alt = `${event.name} poster`;
      figure.appendChild(img);
      card.appendChild(figure);
    }

    const body = document.createElement('div');
    body.className = 'events-card-body';

    const title = document.createElement('h4');
    title.className = 'events-card-title';
    title.textContent = event.name;
    body.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'events-card-meta';

    const date = formatEventDate(event);
    if (date) {
      const dateEl = document.createElement('span');
      dateEl.className = 'events-card-date';
      dateEl.textContent = date;
      meta.appendChild(dateEl);
    }

    const location = formatLocation(event);
    if (location) {
      const locationEl = document.createElement('span');
      locationEl.className = 'events-card-location';
      locationEl.textContent = location;
      meta.appendChild(locationEl);
    }

    if (event.classification) {
      const typeEl = document.createElement('span');
      typeEl.className = 'events-card-type';
      typeEl.textContent = event.classification;
      meta.appendChild(typeEl);
    }

    if (meta.childNodes.length) {
      body.appendChild(meta);
    }

    const price = describePrice(event.priceRanges);
    if (price) {
      const priceEl = document.createElement('div');
      priceEl.className = 'events-card-price';
      priceEl.textContent = price;
      body.appendChild(priceEl);
    }

    const description = truncate(event.description);
    if (description) {
      const descEl = document.createElement('p');
      descEl.className = 'events-card-description';
      descEl.textContent = description;
      body.appendChild(descEl);
    }

    if (event.url) {
      const link = document.createElement('a');
      link.href = event.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.className = 'events-card-link';
      link.textContent = 'View details';
      body.appendChild(link);
    }

    card.appendChild(body);
    li.appendChild(card);
    container.appendChild(li);
  });
  return limited.length;
}

async function fetchEvents(params, signal) {
  const headers = buildRapidApiHeaders();
  if (!headers['X-RapidAPI-Key']) {
    throw new Error('Missing RapidAPI credentials. Set RAPIDAPI_KEY or window.rapidApiKey.');
  }

  const url = buildEventsUrl(params);
  const response = await fetch(url, {
    headers,
    signal
  });

  if (!response.ok) {
    let errorDetail = '';
    try {
      errorDetail = await response.text();
    } catch (_) {
      errorDetail = '';
    }
    const message = errorDetail
      ? `RapidAPI request failed (${response.status}): ${errorDetail.slice(0, 140)}`
      : `RapidAPI request failed with status ${response.status}.`;
    throw new Error(message);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    console.error('Failed to parse RapidAPI response as JSON', err);
    throw new Error('Received an unexpected response from RapidAPI.');
  }

  return normalizeEvents(data);
}

async function performSearch({
  city,
  keyword,
  country,
  statusEl,
  resultsEl
}) {
  const trimmedCity = city.trim();
  const trimmedKeyword = keyword.trim();
  const trimmedCountry = country.trim();

  if (!trimmedCity) {
    updateStatus(statusEl, 'Enter a city to search for events.', 'warning');
    return;
  }

  if (activeController) {
    activeController.abort();
  }
  const controller = new AbortController();
  activeController = controller;

  const descriptor = [trimmedCity, trimmedCountry].filter(Boolean).join(', ');
  updateStatus(statusEl, `Searching events for ${descriptor}…`, 'info');
  resultsEl.innerHTML = '';

  writeStorage(STORAGE_KEYS.city, trimmedCity);
  writeStorage(STORAGE_KEYS.keyword, trimmedKeyword);
  writeStorage(STORAGE_KEYS.country, trimmedCountry);

  try {
    const events = await fetchEvents(
      {
        city: trimmedCity,
        keyword: trimmedKeyword,
        country: trimmedCountry
      },
      controller.signal
    );

    if (controller.signal.aborted) {
      return;
    }

    if (!events.length) {
      updateStatus(statusEl, `No upcoming events found for ${descriptor}.`, 'warning');
      resultsEl.innerHTML = '';
      return;
    }

    const displayedCount = renderEvents(events, resultsEl);
    const countLabel = displayedCount === 1 ? 'event' : 'events';
    updateStatus(
      statusEl,
      `Found ${displayedCount} ${countLabel} for ${descriptor}.`,
      'success'
    );
  } catch (err) {
    if (controller.signal.aborted) {
      return;
    }
    console.error('RapidAPI events search failed', err);
    updateStatus(statusEl, err?.message || 'Unable to load events. Try again later.', 'error');
  } finally {
    if (activeController === controller) {
      activeController = null;
    }
  }
}

export async function initEventsPanel() {
  const panel = document.getElementById('eventsPanel');
  if (!panel) return;

  const form = panel.querySelector('#eventsSearchForm');
  const cityInput = panel.querySelector('#eventsCityInput');
  const keywordInput = panel.querySelector('#eventsKeywordInput');
  const countrySelect = panel.querySelector('#eventsCountrySelect');
  const statusEl = panel.querySelector('#eventsStatus');
  const resultsEl = panel.querySelector('#eventsResults');
  const clearBtn = panel.querySelector('#eventsClearBtn');

  if (!panelInitialized) {
    cityInput.value = readStorage(STORAGE_KEYS.city, '');
    keywordInput.value = readStorage(STORAGE_KEYS.keyword, '');
    const storedCountry = readStorage(
      STORAGE_KEYS.country,
      getDefaultEventsCountry()
    );
    if (storedCountry) {
      countrySelect.value = storedCountry;
    }

    form.addEventListener('submit', event => {
      event.preventDefault();
      performSearch({
        city: cityInput.value,
        keyword: keywordInput.value,
        country: countrySelect.value,
        statusEl,
        resultsEl
      });
    });

    clearBtn.addEventListener('click', () => {
      cityInput.value = '';
      keywordInput.value = '';
      countrySelect.value = getDefaultEventsCountry();
      resultsEl.innerHTML = '';
      if (activeController) {
        activeController.abort();
        activeController = null;
      }
      updateStatus(statusEl, 'Cleared the previous search. Enter a city to find events.', 'info');
      writeStorage(STORAGE_KEYS.city, '');
      writeStorage(STORAGE_KEYS.keyword, '');
      writeStorage(STORAGE_KEYS.country, '');
      hasRunInitialSearch = false;
      cityInput.focus();
    });

    panelInitialized = true;
  }

  const hasKey = Boolean(getRapidApiKey());
  if (!hasKey) {
    updateStatus(
      statusEl,
      'Add your RapidAPI key (set RAPIDAPI_KEY or window.rapidApiKey) to search for events.',
      'warning'
    );
    resultsEl.innerHTML = '';
    return;
  }

  if (!cityInput.value) {
    updateStatus(statusEl, 'Search for concerts, festivals, and more by city.', 'info');
    return;
  }

  if (!hasRunInitialSearch) {
    hasRunInitialSearch = true;
    performSearch({
      city: cityInput.value,
      keyword: keywordInput.value,
      country: countrySelect.value,
      statusEl,
      resultsEl
    });
  }
}

window.initEventsPanel = initEventsPanel;
