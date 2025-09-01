const KEY = 'siteName';
const DEFAULT_NAME = 'Places';

export function getSiteName() {
  // Hard-code the site name regardless of stored settings
  return DEFAULT_NAME;
}

export function setSiteName(name) {
  // Ignore attempts to customize; always use DEFAULT_NAME
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem(KEY);
    }
  } catch {}
}

export function applySiteName() {
  document.querySelectorAll('.site-name').forEach(el => {
    el.textContent = DEFAULT_NAME;
  });
}
