/**
 * GBmul Service Worker
 *
 * Strategy:
 *  - Navigations / index.html: network-only (never cache HTML — avoids sticky UI stamps)
 *  - Other GET assets: network-first, cache fallback for offline
 *  - sw.js itself: network-only, no-store
 *
 * Bump CACHE_VERSION + sw.js?v= in index.html on every deploy that must reach clients.
 */

const CACHE_VERSION = "gbmul-v280";

// Versioned assets for offline. Keep in sync with index.html / index.js imports.
// Do NOT list "./" or "./index.html" — HTML must always come from the network.
const PRECACHE_URLS = [
  "./index.js?v=378",
  "./bot.js?v=366",
  "./style.css?v=99",
  "./shader.js?v=28",
  "./fonts/cuterminus.ttf",
  "./webgblink.js?v=6",
  "./qrcode-lib.js",
  "./img/caseClosed-Small.png",
  "./img/caseOpened-Small.png",
  "./stats.html",
  "./manifest.json",
  "./pkg/gbmul_wasm.js?v=173",
  "./pkg/gbmul_wasm_bg.wasm?v=173",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      // addAll aborts the whole install if one URL 404s; add one-by-one instead.
      await Promise.all(
        PRECACHE_URLS.map((u) =>
          cache.add(u).catch((err) => {
            console.warn("[sw] precache skip", u, err);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("message", (event) => {
  const type = event.data && event.data.type;
  if (type === "SKIP_WAITING") {
    self.skipWaiting();
  }
  if (type === "CLEAR_CACHES") {
    event.waitUntil(
      caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
    );
  }
});

function isNavigationRequest(request) {
  if (request.mode === "navigate") return true;
  const accept = request.headers.get("accept") || "";
  return accept.includes("text/html");
}

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);

  // Never intercept cross-origin (PeerJS, CDNs, …).
  if (url.origin !== self.location.origin) return;

  // Always bypass cache for the worker script itself.
  if (url.pathname.endsWith("/sw.js")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  // HTML / navigations: network-only. Do not put into Cache Storage.
  // This is what kept serving "ui 335/338" after hard reloads.
  if (isNavigationRequest(event.request) || url.pathname.endsWith("/index.html") || url.pathname.endsWith("/")) {
    event.respondWith(
      fetch(event.request, { cache: "no-cache" }).catch(() =>
        caches.match("./index.html").then((r) => r || caches.match("./"))
      )
    );
    return;
  }

  // Assets: network-first, update cache, offline fallback.
  event.respondWith(
    fetch(event.request, { cache: "no-cache" })
      .then((response) => {
        if (response && response.status === 200 && response.type !== "error") {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
