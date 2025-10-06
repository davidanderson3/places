// Public Firebase web config for the Places app.
// Values are loaded from environment variables when available so that
// sensitive credentials are not committed to source control.

const env =
  (typeof process !== "undefined" && process.env) ||
  (typeof import.meta !== "undefined" && import.meta.env) ||
  {};

const DEFAULT_CONFIG = {
  apiKey: env.FIREBASE_API_KEY || "AIzaSyCpcviq2fjNRJSLENqqpBrVPk0EHLU2PR8",
  authDomain: env.FIREBASE_AUTH_DOMAIN || "decision-maker-4e1d3.firebaseapp.com",
  projectId: env.FIREBASE_PROJECT_ID || "decision-maker-4e1d3",
  storageBucket:
    env.FIREBASE_STORAGE_BUCKET || "decision-maker-4e1d3.firebasestorage.app",
  messagingSenderId:
    env.FIREBASE_MESSAGING_SENDER_ID || "727689864651",
  appId:
    env.FIREBASE_APP_ID || "1:727689864651:web:0100c3894790b8c188c24e",
  measurementId: env.FIREBASE_MEASUREMENT_ID || "G-7EJVQN0WT3",
};

// Optionally allow runtime override (e.g., from a script tag before main.js):
// <script>window.firebaseConfig = { apiKey: '...', projectId: '...' };</script>
const config =
  typeof window !== "undefined" && window.firebaseConfig
    ? window.firebaseConfig
    : DEFAULT_CONFIG;

if (typeof window !== "undefined") {
  window.__placesFirebaseConfig = config;
}

export default config;
