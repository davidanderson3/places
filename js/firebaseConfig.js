// Public Firebase web config for the Places app.
// Values are loaded from environment variables when available so that
// sensitive credentials are not committed to source control.

const env =
  (typeof process !== "undefined" && process.env) ||
  (typeof import.meta !== "undefined" && import.meta.env) ||
  {};

const DEFAULT_CONFIG = {
  apiKey: env.FIREBASE_API_KEY || "AIzaSyBbet_bmwm8h8G5CqvmzrdAnc3AO-0IKa8",
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

// Optionally allow runtime override (e.g., from firebase-config.js generated at build time).
const runtimeConfig =
  (typeof window !== "undefined" &&
    (window.__FIREBASE_CONFIG__ || window.firebaseConfig)) ||
  {};

const config = Object.fromEntries(
  Object.entries({
    ...DEFAULT_CONFIG,
    ...runtimeConfig
  }).filter(([, value]) => Boolean(value))
);

export default config;
