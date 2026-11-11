/* =========================================================================
   NEONBOOM · service worker
   Cache-first for the app shell so the workstation opens and plays with no
   network at all. Bump CACHE when you ship a new build.
   ========================================================================= */
const CACHE = 'neonboom-v1.4.0';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './assets/css/tokens.css',
  './assets/css/app.css',
  './assets/img/icon.svg',
  './assets/img/icon-192.png',
  './assets/img/icon-512.png',
  './src/core/util.js',
  './src/core/project.js',
  './src/core/looppack.js',
  './src/core/transport.js',
  './src/audio/synth.js',
  './src/audio/engine.js',
  './src/audio/schedule.js',
  './src/audio/wav.js',
  './src/ui/timeline.js',
  './src/ui/pads.js',
  './src/ui/mixer.js',
  './src/ui/fx.js',
  './src/ui/inspector.js',
  './src/ui/shell.js',
  './src/app.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  event.respondWith(
    caches.match(req).then((hit) => {
      if (hit) {
        /* refresh in the background, serve instantly */
        fetch(req).then((res) => {
          if (res && res.ok) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match('./index.html'));
    })
  );
});
