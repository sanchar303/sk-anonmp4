/* SK AnonMp4 service worker
   - Caches only the app shell (same-origin files).
   - Network-first, so a new deploy shows up on the next load; the cache is the offline fallback.
   - Never intercepts Firebase, the upload API, the proxy, video embeds or any other origin. */
const CACHE = 'sk-anonmp4-v1';
const SHELL = ['./', './index.html', './style.css', './app.js', './manifest.json', './favicon.png'];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => null))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin) return; // leave every other origin to the browser

    event.respondWith(
        fetch(req)
            .then((res) => {
                if (res && res.ok && res.type === 'basic') {
                    const copy = res.clone();
                    caches.open(CACHE).then((cache) => cache.put(req, copy)).catch(() => {});
                }
                return res;
            })
            .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : undefined)))
    );
});