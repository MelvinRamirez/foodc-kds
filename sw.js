// Service worker del shell de la PWA de cocina (`kds-pwa-shell`).
//
// Precachea exclusivamente el app shell versionado (HTML, CSS, JS, manifest
// e íconos). Nunca cachea ni intercepta respuestas de la API del backend
// (script.google.com / script.googleusercontent.com): esos requests van
// siempre directo a la red, sin lectura ni escritura de caché, incluso
// estando offline (`kds-pwa-shell`, "API Requests Are Always Network-Only").

const CACHE_PREFIX = 'foodc-kds-shell-';
const CACHE_VERSION = 'foodc-kds-shell-v2'; // se incrementa en el mismo commit que cualquier cambio de archivo del shell

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/config.js',
  './js/messages.js',
  './js/store.js',
  './js/api.js',
  './js/pin.js',
  './js/time.js',
  './js/queue.js',
  './js/completion.js',
  './js/actions.js',
  './js/persistence.js',
  './js/effects.js',
  './js/ticker.js',
  './js/wake-lock.js',
  './js/main.js',
  './js/views/dom.js',
  './js/views/pin-view.js',
  './js/views/queue-view.js',
  './js/views/order-card-view.js',
  './js/views/status-bar-view.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Cualquier request que no sea GET, o que sea a un origen distinto del
  // propio (la API del backend), se deja pasar sin intervención: sin
  // `respondWith` el navegador lo maneja como siempre, garantizando que la
  // API es siempre "network-only" y nunca se sirve desde la caché del shell.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cached) => cached || fetch(request)),
    );
    return;
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request)));
});
