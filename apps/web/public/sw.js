/**
 * Minimal service worker — caches the app shell so the UI loads offline.
 * Live chat / API requests bypass the cache and go straight to the network.
 *
 * Cache name bumps on every build (Vite injects a hash in the JS file name
 * already; we cache by URL so old shells get evicted naturally on next visit).
 */
const CACHE_VERSION = "v0.2.0";
const SHELL_CACHE = `claw-hq-shell-${CACHE_VERSION}`;
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/icon.svg",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k.startsWith("claw-hq-shell-") && k !== SHELL_CACHE).map((k) => caches.delete(k)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache API / WS — they're live.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;
  // Same-origin GETs: network-first with cache fallback.
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match("/index.html"))),
  );
});
