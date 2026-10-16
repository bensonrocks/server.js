// IDEALONE PWA service worker (served at /sw.js only when PWA_ENABLED=1;
// otherwise /sw.js is the original pass-through worker in public/sw.js).
//
// RULES — read before editing:
//  * NEVER touches /api/*, non-GET requests, cross-origin requests, or anything
//    with a query string: those go to the network untouched (no respondWith),
//    so scanning, packing, labels, orders and stock behave exactly as without
//    a service worker. The offline scan queue (#50) lives in localStorage in
//    app.js and is not involved here.
//  * HTML, JS, CSS and manifests: NETWORK-FIRST. The cache is only a fallback
//    when the device is offline, so every deploy shows up on the next load.
//  * Icons / vendor libs / brand images: cache-first (they are versioned by
//    the deploy-stamped cache name below, so a deploy refreshes them too).
const BUILD = '__BUILD__';
const CACHE = 'idealone-shell-' + BUILD;
const SHELL = ['/', '/portal', '/driver', '/styles.css', '/manifest.json', '/portal-manifest.json', '/driver-manifest.json',
  '/icons/icon-192.png', '/icons/icon-512.png', '/icons/portal-icon-192.png', '/icons/portal-icon-512.png',
  '/icons/driver-icon-192.png', '/icons/driver-icon-512.png'];
const NAV_PATHS = new Set(['/', '/index.html', '/portal', '/portal.html', '/driver', '/driver.html']);
const STATIC_FIRST = /^\/(icons|vendor|brand)\//;
const STATIC_NET = /\.(?:js|css|json)$/;

self.addEventListener('install', e => {
  self.skipWaiting();
  // Best-effort precache; a failure must never block install.
  e.waitUntil(caches.open(CACHE).then(c => Promise.all(SHELL.map(u => c.add(new Request(u, { cache: 'reload' })).catch(() => {})))));
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('idealone-shell-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

function cacheable(res) {
  return res && res.ok && res.status === 200 && res.type === 'basic';
}
async function networkFirst(req, key) {
  try {
    const res = await fetch(req);
    if (cacheable(res)) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(key || req, copy)).catch(() => {}); }
    return res;
  } catch (err) {
    const hit = await caches.match(key || req);
    if (hit) return hit;
    throw err;
  }
}
async function cacheFirst(req) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cacheable(res)) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {}); }
  return res;
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.search) return;                                   // tokens / data queries: never cached
  const p = url.pathname;
  if (p.startsWith('/api/') || p === '/sw.js' || p === '/pwa-config.json') return;
  if (req.mode === 'navigate') {
    if (!NAV_PATHS.has(p)) return;
    e.respondWith(networkFirst(req, p === '/index.html' ? '/' : p.replace(/\.html$/, '')));
    return;
  }
  if (STATIC_FIRST.test(p)) { e.respondWith(cacheFirst(req)); return; }
  if ((STATIC_NET.test(p) && p.lastIndexOf('/') === 0) || p.startsWith('/pwa/')) { e.respondWith(networkFirst(req)); return; }
  // anything else: network as usual
});

// ── Web Push ────────────────────────────────────────────────────────────────
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'IDEALONE', body: e.data ? e.data.text() : '' }; }
  const title = d.title || 'IDEALONE';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '', tag: d.tag || d.type || 'idealone', renotify: false,
    icon: d.icon || '/icons/portal-icon-192.png', badge: '/icons/icon-192.png',
    data: { url: d.url || '/' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const raw = (e.notification.data && e.notification.data.url) || '/';
  const target = new URL(raw, self.location.origin);
  if (target.origin !== self.location.origin) return;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) { if (new URL(w.url).pathname.startsWith(target.pathname)) { await w.focus(); return; } }
    await self.clients.openWindow(target.href);
  })());
});
