const CACHE_NAME = "cube-scanner-video-v3";
const APP_SHELL = ["/scanner", "/scanner/manifest.json", "/favicon.svg"];
const MEDIAPIPE_ORIGINS = new Set(["https://cdn.jsdelivr.net", "https://storage.googleapis.com"]);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("cube-scanner-video-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);

  if (event.request.mode === "navigate" && url.pathname.startsWith("/scanner")) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put("/scanner", copy));
          return response;
        })
        .catch(() => caches.match("/scanner")),
    );
    return;
  }

  const cacheable = url.origin === self.location.origin || MEDIAPIPE_ORIGINS.has(url.origin);
  if (!cacheable) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const refresh = fetch(event.request).then((response) => {
        if (response.ok || response.type === "opaque") {
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
        }
        return response;
      });
      if (cached) {
        event.waitUntil(refresh.catch(() => undefined));
        return cached;
      }
      return refresh;
    }),
  );
});
