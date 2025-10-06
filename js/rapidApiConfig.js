const env =
  (typeof process !== 'undefined' && process.env) ||
  (typeof import.meta !== 'undefined' && import.meta.env) ||
  {};

const readWindow = key =>
  typeof window !== 'undefined' && window ? window[key] : undefined;

const config = {
  key: (env.RAPIDAPI_KEY || readWindow('rapidApiKey') || '').trim(),
  eventsHost:
    (env.RAPIDAPI_EVENTS_HOST || readWindow('rapidApiEventsHost') || '').trim() ||
    'ticketmaster-data.p.rapidapi.com',
  eventsUrl:
    (env.RAPIDAPI_EVENTS_URL || readWindow('rapidApiEventsUrl') || '').trim() ||
    null,
  eventsCountry:
    (env.RAPIDAPI_EVENTS_COUNTRY || readWindow('rapidApiEventsCountry') || '').trim() ||
    'US'
};

if (!config.eventsUrl) {
  config.eventsUrl = `https://${config.eventsHost}/events/search`;
}

export function getRapidApiKey() {
  return config.key;
}

export function getEventsHost() {
  return config.eventsHost;
}

export function getEventsUrl() {
  return config.eventsUrl;
}

export function getDefaultEventsCountry() {
  return config.eventsCountry || 'US';
}

export function buildRapidApiHeaders() {
  const key = getRapidApiKey();
  const host = getEventsHost();
  if (!key || !host) return {};
  return {
    'X-RapidAPI-Key': key,
    'X-RapidAPI-Host': host
  };
}

export default config;
