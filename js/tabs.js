export const PANELS = ['travelPanel', 'eventsPanel'];

export const PANEL_NAMES = {
  travelPanel: 'Places',
  eventsPanel: 'Events'
};

let tabsInitialized = false;

export function initTabs() {
  if (tabsInitialized) return;
  tabsInitialized = true;

  const LAST_PANEL_KEY = 'lastPanel';

  const tabButtons = Array.from(document.querySelectorAll('.tab-button'));
  const panels = PANELS;
  const tabsContainer = document.getElementById('tabsContainer');
  if (tabsContainer) {
    tabsContainer.style.visibility = 'visible';
  }

  tabButtons.forEach(btn => {
    btn.addEventListener('click', async () => {
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const target = btn.dataset.target;
      panels.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = id === target ? 'flex' : 'none';
      });

      try { localStorage.setItem(LAST_PANEL_KEY, target); } catch {}
      history.pushState(null, '', `#${target}`);

      if (target === 'travelPanel') {
        await window.initTravelPanel?.();
      } else if (target === 'eventsPanel') {
        await window.initEventsPanel?.();
      }
    });
  });

  const hash = window.location.hash.substring(1);
  let saved = null;
  try { saved = localStorage.getItem(LAST_PANEL_KEY); } catch {}
  const initial = panels.includes(hash)
    ? hash
    : (saved && panels.includes(saved)) ? saved
    : tabButtons[0]?.dataset.target || panels[0];

  tabButtons.forEach(b => b.classList.remove('active'));
  document.querySelector(`.tab-button[data-target="${initial}"]`)?.classList.add('active');
  panels.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === initial ? 'flex' : 'none';
  });

  try { localStorage.setItem(LAST_PANEL_KEY, initial); } catch {}

  const runInitial = () => {
    if (initial === 'travelPanel') {
      window.initTravelPanel?.();
    } else if (initial === 'eventsPanel') {
      window.initEventsPanel?.();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', runInitial);
  } else {
    runInitial();
  }
}

