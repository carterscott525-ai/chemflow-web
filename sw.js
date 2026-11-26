// ChemFlow service worker — caches the app shell so it opens with no signal.
// Data is handled by the app (route cache + offline visit queue in IndexedDB).
var CACHE = 'chemflow-v1';
var SHELL = ['.', 'index.html', 'app.js', 'config.js', 'manifest.json'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e){
  var url = new URL(e.request.url);
  if(e.request.method !== 'GET') return;
  if(url.origin === location.origin){
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then(function(hit){
        return hit || fetch(e.request).then(function(resp){
          var copy = resp.clone();
          caches.open(CACHE).then(function(c){ c.put(e.request, copy); });
          return resp;
        });
      })
    );
  }
  // Cross-origin (Supabase API, CDN): network only; the app queues offline work itself.
});
