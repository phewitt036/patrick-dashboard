// Exists mainly because Android will not offer to install a site without a
// fetch handler. It deliberately caches nothing: these are income records
// behind a session, and a stale page or a response left on disk after logout
// would be worse than needing a connection.
//
// It also handles as little as possible. Only same-origin GETs for the app's
// own icons and manifest are intercepted; navigations, the passkey POSTs and
// every API call fall through to the browser untouched, so the worker can
// never be the reason a login or a record write fails.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/patforce/')) return;

  event.respondWith(fetch(req));
});
