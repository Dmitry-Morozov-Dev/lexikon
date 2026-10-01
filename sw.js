/* Service Worker «Лексикон» — кэширует оболочку и уже загруженные JSON. Картинки не прекэшируем. */
var CACHE_SHELL = 'lexikon-shell-v8';
var CACHE_DATA = 'lexikon-data-v19';

var SHELL_URLS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './srs.js',
  './manifest.webmanifest',
  './decks.json',
  './icons/app.svg',
  './icons/app-180.png',
  './icons/app-512.png'
];

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE_SHELL).then(function (cache) {
      return cache.addAll(SHELL_URLS.map(function (u) {
        return new Request(u, { cache: 'reload' });
      })).catch(function () {
        // частичный сбой — не валим установку
        return Promise.all(SHELL_URLS.map(function (u) {
          return cache.add(u).catch(function () { return null; });
        }));
      });
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_SHELL && k !== CACHE_DATA) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isDataJson(url) {
  return /\/data\/[^/]+\.json(\?|$)/.test(url.pathname) || url.pathname.endsWith('/decks.json');
}

function isConceptSvg(url) {
  return /\/icons\/concepts\//.test(url.pathname);
}

self.addEventListener('fetch', function (event) {
  var req = event.request;
  if (req.method !== 'GET') return;

  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Не кэшируем внешние изображения заранее; network-first без записи обязательной
  if (url.origin !== self.location.origin) {
    // внешние картинки: сеть, при ошибке — ничего (карточка сама покажет fallback)
    return;
  }

  // JSON колод: network-first (иначе Safari навсегда держит старые колоды), offline → cache
  if (isDataJson(url) || isConceptSvg(url)) {
    event.respondWith(
      caches.open(CACHE_DATA).then(function (cache) {
        return fetch(req, { cache: 'no-cache' }).then(function (res) {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        }).catch(function () {
          return cache.match(req);
        });
      })
    );
    return;
  }

  // Оболочка: network-first (чтобы iOS Safari не залипал на старом app.js)
  event.respondWith(
    caches.open(CACHE_SHELL).then(function (cache) {
      return fetch(req, { cache: 'no-cache' }).then(function (res) {
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      }).catch(function () {
        return cache.match(req).then(function (cached) {
          if (cached) return cached;
          if (req.mode === 'navigate') return cache.match('./index.html');
          return undefined;
        });
      });
    })
  );
});
