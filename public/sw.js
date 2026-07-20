// IDEALSCAN service worker — exists to make the app installable.
// It deliberately does NOT cache anything: scanning is a live-data app and
// every deploy must reach devices immediately. All requests pass straight
// through to the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network as usual */ });
