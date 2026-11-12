/* Service worker: keeps the cards app available offline.
   The build ID changes whenever the cards file or the app changes, which makes the
   browser install the new version and drop the old cache. */
var CACHE = 'bls-cards-__BUILD_ID__';
// Note: no './index.html' — some hosts (Cloudflare Pages) redirect it to './', and a redirected
// response served for a navigation is refused by Safari ("the service worker has redirections").
var ASSETS = [
  './',
  './manifest.webmanifest',
  './cards.he-IL.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', function (e) {
  self.skipWaiting(); // take over right away (also replaces a broken earlier version)
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return Promise.all(ASSETS.map(function (u) {
      var req = new Request(u, { cache: 'reload' });
      return fetch(req).then(function (res) {
        if (!res.ok) throw new Error('precache failed: ' + u);
        if (!res.redirected) return c.put(req, res);
        // store a clean copy so it is never served as a redirect
        return res.blob().then(function (body) { return c.put(req, new Response(body, { status: 200, headers: res.headers })); });
      });
    }));
  }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k.indexOf('bls-cards-') === 0 && k !== CACHE; })
      .map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('message', function (e) {
  if (e.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') !== -1) return; // server functions always go to the network
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./', { cacheName: CACHE }).then(function (r) {
      return r || fetch(req);
    }).catch(function () { return fetch(req); }));
    return;
  }
  e.respondWith(caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then(function (r) {
    return r || fetch(req);
  }));
});
