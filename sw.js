// Always ask GitHub for the newest copy of the app's own files (a quick
// "not modified" check when nothing changed), so updates show up right away
// instead of after the browser's 10-minute cache. Other sites (tracking models,
// videos, which are blob: URLs) are left alone.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' }).catch(() => fetch(req)));
});
