// Firebase configuration is expected to be provided externally.
// Supply values via environment variables at build/deploy time or
// by including a `firebase-config.js` file that assigns them to
// `window.firebaseConfig` before this module is loaded.

// Attempt to read config from Node-style environment variables.
const envConfig = (typeof process !== 'undefined' && process.env && process.env.FIREBASE_API_KEY)
  ? {
      apiKey: process.env.FIREBASE_API_KEY,
      authDomain: process.env.FIREBASE_AUTH_DOMAIN,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
      messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
      appId: process.env.FIREBASE_APP_ID,
      measurementId: process.env.FIREBASE_MEASUREMENT_ID,
    }
  : null;

// Fallback to config injected on the window object.
const config = envConfig || (typeof window !== 'undefined' && window.firebaseConfig) || {};

if (!Object.keys(config).length) {
  console.warn('Firebase configuration is missing.');
}

export default config;

