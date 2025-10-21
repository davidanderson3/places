#!/usr/bin/env node

/**
 * Generates firebase-config.js in the project root so the client
 * can read Firebase settings without hard-coding them in source.
 * Values are pulled from process.env, falling back to a local .env file.
 */

const fs = require('fs');
const path = require('path');

const projectRoot = process.cwd();
const envFilePath = path.join(projectRoot, '.env');

const envFromFile = {};

if (fs.existsSync(envFilePath)) {
  const fileContents = fs.readFileSync(envFilePath, 'utf8');
  fileContents.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) return;
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (!key) return;
    // Only set if not already set via process.env
    if (!(key in envFromFile)) {
      envFromFile[key] = value.replace(/^['"]|['"]$/g, '');
    }
  });
}

const env = new Proxy({}, {
  get(_, prop) {
    const key = String(prop);
    if (process.env[key] !== undefined) return process.env[key];
    if (envFromFile[key] !== undefined) return envFromFile[key];
    return undefined;
  }
});

const configKeys = {
  apiKey: 'FIREBASE_API_KEY',
  authDomain: 'FIREBASE_AUTH_DOMAIN',
  projectId: 'FIREBASE_PROJECT_ID',
  storageBucket: 'FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'FIREBASE_MESSAGING_SENDER_ID',
  appId: 'FIREBASE_APP_ID',
  measurementId: 'FIREBASE_MEASUREMENT_ID'
};

const config = {};
const missingKeys = [];

Object.entries(configKeys).forEach(([field, envKey]) => {
  const value = env[envKey];
  if (value) {
    config[field] = value;
  } else {
    missingKeys.push(envKey);
  }
});

if (missingKeys.length) {
  console.warn(
    '[generateFirebaseConfig] Missing values for:',
    missingKeys.join(', ')
  );
}

const outputPath = path.join(projectRoot, 'firebase-config.js');
const output = `window.__FIREBASE_CONFIG__ = ${JSON.stringify(config, null, 2)};\n`;

fs.writeFileSync(outputPath, output);
console.log(`[generateFirebaseConfig] Wrote ${outputPath}`);
