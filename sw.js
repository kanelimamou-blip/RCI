/* Appli téléphone RCI (dossier hors ligne) : l'application elle-même est gardée sur le téléphone.
   Aucune donnée ici : les données du collègue sont dans le téléphone (IndexedDB), jamais sur ce site. */
var VERSION = 'rci-kit-v1';
var FICHIERS = ['./', 'index.html', 'app.html', 'rci-serveur.js', 'manifest.webmanifest', 'vendor/qrcode.js',
  'icons/rci-192.png', 'icons/rci-512.png', 'icons/rci-maskable-512.png', 'icons/apple-touch-icon.png', 'icons/favicon-32.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(VERSION).then(function (c) { return c.addAll(FICHIERS); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (k) { return Promise.all(k.filter(function (n) { return n.indexOf('rci-kit-') === 0 && n !== VERSION; }).map(function (n) { return caches.delete(n); })); })
    .then(function () { return self.clients.claim(); }));
});
// Depuis le téléphone d'abord (ouverture immédiate, même sans réseau), mise à jour en arrière-plan quand Internet est là.
self.addEventListener('fetch', function (e) {
  var r = e.request; if (r.method !== 'GET') return;
  var u = new URL(r.url); if (u.origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(function (c) {
    return c.match(r, { ignoreSearch: true }).then(function (x) {
      var reseau = fetch(r).then(function (rep) { if (rep.ok) c.put(r, rep.clone()); return rep; }).catch(function () { return x || (r.mode === 'navigate' ? c.match('index.html') : Response.error()); });
      return x || reseau;
    });
  }));
});
