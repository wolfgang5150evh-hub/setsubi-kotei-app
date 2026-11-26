// サービスワーカー：アプリ本体と PDF.js を端末に保存し、電波が弱くても開けるようにする
const CACHE_NAME = "setsubi-koutei-v4";
const APP_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./reader.js",
  "./store.js",
  "./manifest.webmanifest",
  "./icon.svg",
];
const CDN_FILES = [
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs",
  "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_FILES);
    // CDN は失敗してもインストール自体は止めない（初回表示時にまた保存される）
    await Promise.all(CDN_FILES.map((url) => cache.add(url).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)));
    self.clients.claim();
  })());
});

// アプリ本体：ネット優先（更新をすぐ反映）、だめなら保存分
// PDF.js（版数固定）：保存分優先
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const isCdn = url.hostname === "cdn.jsdelivr.net";
  const isApp = url.origin === self.location.origin;
  if (!isCdn && !isApp) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    if (isCdn) {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    }
    try {
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
