const CACHE_NAME = "chrono-steps-ui-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./assets/css/styles.css",
  "./assets/js/storage.js",
  "./assets/js/export.js",
  "./assets/js/app.js",
  "./assets/icons/icon.svg",
  "./assets/vendor/bootstrap/bootstrap.min.css",
  "./assets/vendor/bootstrap/bootstrap.bundle.min.js",
  "./assets/vendor/bootstrap-icons/bootstrap-icons.min.css",
  "./assets/vendor/sweetalert2/sweetalert2.min.css",
  "./assets/vendor/sweetalert2/sweetalert2.all.min.js",
  "./view/index.html",
  "./view/assets/view.css",
  "./view/assets/view.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});

