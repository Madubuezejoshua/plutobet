const CACHE_NAME = "plutobet-shell-v2";
const PRECACHE_URLS = [
  "/offline",
  "/icon.svg",
  "/pwa-192x192.png",
  "/pwa-512x512.png",
  "/pwa-maskable-512x512.png",
  "/apple-touch-icon.png",
];

// Strictly never intercept Next.js chunks, API endpoints, admin routes, or
// account/money pages. Caching `/_next/static/` breaks Turbopack dev chunks
// across rebuilds and caching money/odds routes risks stale balances.
const BYPASS_PREFIXES = [
  "/_next/",
  "/api/",
  "/admin",
  "/wallet",
  "/deposit",
  "/withdraw",
  "/bets",
  "/account",
  "/kyc",
  "/signin",
  "/register",
];

const CACHEABLE_EXACT_PATHS = new Set(PRECACHE_URLS);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (BYPASS_PREFIXES.some((prefix) => url.pathname.startsWith(prefix))) return;

  // Navigation requests: always network-first, falling back to /offline only on network failure.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cached = await caches.match("/offline");
        return cached || new Response("You are offline.", { status: 503 });
      }),
    );
    return;
  }

  // Only serve our precached static PWA shell assets from cache.
  if (CACHEABLE_EXACT_PATHS.has(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request)),
    );
  }
});
