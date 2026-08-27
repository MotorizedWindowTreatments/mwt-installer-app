/* ============================================================
   MWT Installer - service worker
   Caches the app shell (HTML/CSS/JS/vendor/icons) so the app opens
   and works (create/edit/save jobs - all IndexedDB, already local)
   even with no connection. It does NOT intercept the Submit & Send
   network request - that always needs a live connection and is left
   to go straight to the network so success/failure is reported
   accurately.

   Bump CACHE_NAME whenever any cached file changes so installers get
   the update instead of a stale cached copy.
   ============================================================ */

const CACHE_NAME = "mwt-installer-shell-v1";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./css/style.css",
  "./js/config.js",
  "./js/formSchemas.js",
  "./js/db.js",
  "./js/pdf.js",
  "./js/app.js",
  "./vendor/jspdf.umd.min.js",
  "./vendor/jspdf.plugin.autotable.min.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "./icons/apple-touch-icon.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Only handle same-origin GET requests for the app shell. Everything
  // else (in particular the cross-origin POST to the Apps Script email
  // endpoint) is left completely untouched, so Submit & Send always hits
  // the real network and its real success/failure is what the app sees.
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((resp) => {
          if (resp && resp.ok) {
            const copy = resp.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return resp;
        })
        .catch(() => cached); // offline - fall back to whatever is cached

      // Serve the cached shell instantly if we have it (fast + works
      // offline), while quietly refreshing the cache in the background
      // for next time.
      return cached || network;
    })
  );
});
