// Public Firebase web config for the Places app.
// Values are loaded from environment variables when available so that
// sensitive credentials are not committed to source control.

const env =
  (typeof process !== "undefined" && process.env) ||
  (typeof import.meta !== "undefined" && import.meta.env) ||
  {};

const DEFAULT_CONFIG = {
  apiKey: env.FIREBASE_API_KEY || "secrets.APIKEY",
  authDomain: env.FIREBASE_AUTH_DOMAIN || "secrets.AUTHDOMAIN",
  projectId: env.FIREBASE_PROJECT_ID || "secrets.PROJECTID",
  storageBucket: env.FIREBASE_STORAGE_BUCKET || "secrets.STORAGEBUCKET",
  messagingSenderId:
    env.FIREBASE_MESSAGING_SENDER_ID || "secrets.MESSAGINGSENDERID",
  appId: env.FIREBASE_APP_ID || "secrets.APPID",
  measurementId: env.FIREBASE_MEASUREMENT_ID || "secrets.MEASUREMENTID",
};

// Optionally allow runtime override (e.g., from a script tag before main.js):
// <script>window.firebaseConfig = { apiKey: '...', projectId: '...' };</script>
const config =
  typeof window !== "undefined" && window.firebaseConfig
    ? window.firebaseConfig
    : DEFAULT_CONFIG;

export default config;

