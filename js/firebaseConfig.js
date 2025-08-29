// Public Firebase web config for the Places app.
// Replace these values when moving to a new Firebase project.

const DEFAULT_CONFIG = {
  apiKey: "AIzaSyBbet_bmwm8h8G5CqvmzrdAnc3AO-0IKa8",
  authDomain: "decision-maker-4e1d3.firebaseapp.com",
  projectId: "decision-maker-4e1d3",
  storageBucket: "decision-maker-4e1d3.firebasestorage.app",
  messagingSenderId: "727689864651",
  appId: "1:727689864651:web:0100c3894790b8c188c24e",
  measurementId: "G-7EJVQN0WT3"
};

// Optionally allow runtime override (e.g., from a script tag before main.js):
// <script>window.firebaseConfig = { apiKey: '...', projectId: '...' };</script>
const config = (typeof window !== 'undefined' && window.firebaseConfig)
  ? window.firebaseConfig
  : DEFAULT_CONFIG;

export default config;

