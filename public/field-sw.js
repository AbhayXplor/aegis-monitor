const CACHE = 'aegis-field-v1';
const PRECACHE = ['/field.html', '/lib/rag-core.mjs'];
const KB_PATH = '/api/v1/kb';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  // Only same-origin GETs are ever touched; POSTs and other requests pass through untouched.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  if (url.pathname === KB_PATH) {
    // Network-first, falling back to the last cached copy.
    e.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) caches.open(CACHE).then(c => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req))
    );
  } else if (PRECACHE.includes(url.pathname)) {
    // Cache-first for the static files.
    e.respondWith(caches.match(req).then(hit => hit || fetch(req)));
  }
});
