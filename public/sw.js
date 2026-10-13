// Service worker: makes the app installable and lets saved trips open without a connection.
// App files and opened trips: from the network (so updates show at once), falling back to the last copy when offline.
// Everything else (planning, routing, map tiles) always goes to the network.
const CACHE = "byway-1.37";
const SHELL = [
  "/", "/index.html", "/style.css", "/icons.js", "/app.js", "/itinerary.js", "/features.js", "/home.js", "/setup.js", "/about.js", "/library.js",
  "/privacy.html", "/terms.html", "/legal.css",
  "/coverage.json", "/seasonal-roads.json", "/trip-ideas.json", "/manifest.webmanifest", "/icons/icon.svg",
  "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js", "https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.css",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const shell = SHELL.includes(url.origin === location.origin ? url.pathname : url.href);
  const tripRead = url.origin === location.origin && /^\/api\/(trips|presets)/.test(url.pathname);
  if (shell || tripRead) {
    e.respondWith(
      fetch(req)
        .then((r) => {
          if (r.ok) {
            const copy = r.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return r;
        })
        .catch(() => caches.match(req, { ignoreSearch: shell }))
    );
  }
});
