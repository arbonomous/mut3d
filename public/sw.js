// mut3d service worker: keeps only the app itself (the page, icons and the on-device face-model files) so the app opens offline and installs.
// It never caches room links with their keys (the key lives after the #, which is not part of the request), chat, files, feedback or relay credentials.
const V = 'mut3d-shell-4';
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (r.mode === 'navigate' || u.pathname === '/') {
    // network first so updates arrive immediately; the cached copy is only for offline
    e.respondWith(fetch(r).then((res) => { if (res.ok && u.pathname === '/') { const c = res.clone(); caches.open(V).then((ca) => ca.put('/', c)); } return res; }).catch(() => caches.match(u.pathname === '/' ? '/' : r).then((m) => m || Response.error())));
  } else if (u.pathname.startsWith('/icon-') || u.pathname.startsWith('/mp/') || u.pathname.startsWith('/fonts/')) {
    // cache-first: icons, face-model files and fonts never change without a version bump
    e.respondWith(caches.match(r).then((m) => m || fetch(r).then((res) => { if (res.ok) { const c = res.clone(); caches.open(V).then((ca) => ca.put(r, c)); } return res; })));
  }
});
