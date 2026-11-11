/* Ten Seconds service worker: offline app shell + background result sync. */
'use strict';

importScripts('/js/queue.js');

// Replaced by the server with a hash of the app files, so every deploy installs a fresh cache.
const VERSION = '__BUILD_HASH__';
const SHELL_CACHE = `ten-shell-${VERSION}`;
const RESULTS_ENDPOINT = '/api/results';

// Everything the game needs to boot and play with no network at all.
const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/manifest.webmanifest',
  '/js/app.js',
  '/js/timing.js',
  '/js/queue.js',
  '/js/api.js',
  '/js/sound.js',
  '/fonts/orbitron-latin-700-normal.woff2',
  '/fonts/orbitron-latin-900-normal.woff2',
  '/fonts/rajdhani-latin-500-normal.woff2',
  '/fonts/rajdhani-latin-700-normal.woff2',
  '/icons/favicon.svg',
  '/icons/favicon-32.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-192.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/logo.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      // cache: 'reload' bypasses the HTTP cache so a new version never precaches stale files.
      .then((cache) => cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
  );
  // Do not skipWaiting automatically: the page offers an "Update" button so a game
  // in progress is never swapped out from under the player.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('ten-') && k !== SHELL_CACHE).map((k) => caches.delete(k)));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (_) { /* ignore */ }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
  if (event.data === 'FLUSH') event.waitUntil(flushAndNotify());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;               // POST /api/results goes straight to the network.
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;   // Live data is never served from cache.

  // App navigations: always answer with the cached shell (instant + works offline).
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('/index.html', { cacheName: SHELL_CACHE });
      if (cached) return cached;
      try { return await fetch(req); } catch (_) { return offlineFallback(); }
    })());
    return;
  }

  // Static assets: cache first, then network (and cache same-origin successes).
  event.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
      }
      return res;
    } catch (err) {
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});

function offlineFallback() {
  return new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Ten Seconds</title><body style="margin:0;display:grid;place-items:center;height:100vh;background:#07070d;color:#e8f6ff;font:600 18px system-ui">' +
    'You are offline. Open Ten Seconds once while online to install it for offline play.</body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  );
}

// Background Sync (Chromium): retry pending results even if the app was closed.
self.addEventListener('sync', (event) => {
  if (event.tag === 'submit-results') event.waitUntil(flushAndNotify(true));
});

async function flushAndNotify(throwOnRemaining) {
  const report = await self.TenQueue.flush(RESULTS_ENDPOINT);
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (report.sent.length || report.rejected.length) {
    clients.forEach((c) => c.postMessage({ type: 'SYNC_REPORT', report: serialisable(report) }));
  }
  // Throwing makes the browser schedule another sync attempt later.
  if (throwOnRemaining && report.networkError && report.remaining > 0) throw new Error('results still pending');
  return report;
}

function serialisable(report) {
  return JSON.parse(JSON.stringify(report));
}
