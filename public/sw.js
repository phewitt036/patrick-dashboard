// The command centre's worker, the twin of public/patforce/sw.js. It is here
// because Android will not treat the site as an installed app without a
// manifest and a fetch handler; installed without them, it was a bare shortcut
// and Chrome drew its own title-and-address bar over the top of the page.
//
// It caches nothing and handles as little as possible: only same-origin GETs
// for the app's own icons and manifest. Navigations, the passkey POSTs and
// every API call fall through to the browser untouched, so the worker can
// never be the reason a login or a panel fails.
//
// On the Patforce-only instance server.js answers /sw.js with the Patforce
// worker instead, so this file is only ever served by the full dashboard.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const OWN = new Set([
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png'
]);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (!OWN.has(url.pathname)) return;

  event.respondWith(fetch(req));
});
