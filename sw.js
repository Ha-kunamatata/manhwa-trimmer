/* Offline shell for the installed app. Bump CACHE when assets change. */
const CACHE = "manhwa-trimmer-v2";
const ASSETS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./src/styles.css",
  "./src/main.js",
  "./src/ui/app.js",
  "./src/ui/editor.js",
  "./src/ui/reader.js",
  "./src/ui/library.js",
  "./src/ui/sources.js",
  "./src/ui/github.js",
  "./src/core/analysis.js",
  "./src/core/geometry.js",
  "./src/core/naming.js",
  "./src/core/pdf.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png"
];

/* Pages downloaded from a repository live in their own cache and are keyed by
   content hash, so they outlive any number of app updates. Sweeping every other
   cache on activate would throw away a library the user waited to download. */
const KEEP = ["manhwa-github-blobs"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE && KEEP.indexOf(k) < 0).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Cache-first for our own files; anything else goes straight to the network.
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        if (res.ok && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => caches.match("./index.html"))
    )
  );
});
