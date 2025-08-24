import { initAuth } from './auth.js';
import { initTabs } from './tabs.js';
import { applySiteName } from './siteName.js';
import { initDescriptions } from './descriptions.js';

window.addEventListener('DOMContentLoaded', () => {
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker
      .register('service-worker.js')
      .catch(err => {
        console.warn('Service worker registration failed:', err);
      });
  } else {
    console.warn('Service workers are not supported; offline features will be limited.');
  }

  applySiteName();
  initDescriptions();

  const uiRefs = {
    loginBtn: document.getElementById('loginBtn'),
    logoutBtn: document.getElementById('logoutBtn')
  };

  initAuth(uiRefs, () => {
    initTabs();
  });
});

