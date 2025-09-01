// Public Firebase web config for the Places app.
// Replace these values when moving to a new Firebase project.

const DEFAULT_CONFIG = {
  apiKey: "secrets.APIKEY",
  authDomain: "secrets.AUTHDOMAIN",
  projectId: "secrets.PROJECTID",
  storageBucket: "secrets.STORAGEBUCKET",
  messagingSenderId: "secrets.MESSAGINGSENDERID",
  appId: "secrets.APPID",
  measurementId: "secrets.MEASUREMENTID"
};

// Optionally allow runtime override (e.g., from a script tag before main.js):
// <script>window.firebaseConfig = { apiKey: '...', projectId: '...' };</script>
const config = (typeof window !== 'undefined' && window.firebaseConfig)
  ? window.firebaseConfig
  : DEFAULT_CONFIG;

export default config;

