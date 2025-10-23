#!/usr/bin/env node
/**
 * Lightweight static dev server for the Places app.
 * Serves out of the repo root by default and falls back to index.html for SPA routes.
 */

const http = require('http');
const fs = require('fs').promises;
const path = require('path');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.kml': 'application/vnd.google-earth.kml+xml'
};

const cwd = process.cwd();
const [maybeRoot] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const root = path.resolve(cwd, maybeRoot || '.');
const indexFile = path.join(root, 'index.html');
const port = Number(process.env.PORT) || 5173;

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

async function readFileSafe(filePath) {
  const data = await fs.readFile(filePath);
  return data;
}

async function sendFile(res, filePath) {
  const data = await readFileSafe(filePath);
  res.writeHead(200, {
    'Content-Type': getMimeType(filePath),
    'Cache-Control': 'no-cache'
  });
  res.end(data);
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let requestedPath = decodeURIComponent(url.pathname);

    if (requestedPath.endsWith('/') || requestedPath === '') {
      requestedPath = path.join(requestedPath, 'index.html');
    }

    let filePath = path.join(root, requestedPath);
    filePath = path.normalize(filePath);

    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    try {
      const stats = await fs.stat(filePath);
      if (stats.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      }
      await sendFile(res, filePath);
      return;
    } catch (err) {
      const hasExtension = path.extname(requestedPath) !== '';
      const isFirebaseInternal = requestedPath.startsWith('/__/');

      if (hasExtension || isFirebaseInternal) {
        res.writeHead(err.code === 'ENOENT' ? 404 : 500);
        res.end(err.code === 'ENOENT' ? 'Not Found' : 'Server Error');
        return;
      }

      await sendFile(res, indexFile);
    }
  } catch (err) {
    console.error('[dev-server] Unhandled error:', err);
    res.writeHead(500);
    res.end('Server Error');
  }
}

http
  .createServer(handleRequest)
  .listen(port, () => {
    console.log(`[dev-server] Serving ${root} on http://localhost:${port}`);
    console.log('[dev-server] Press Ctrl+C to stop.');
  });
