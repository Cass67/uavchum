const CACHE = 'uavchum-v1';
const STATIC = [
    '/static/style.css',
    '/static/app.js',
    '/static/manifest.json',
    '/static/favicon.svg',
];

self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE).then(c => c.addAll(STATIC)).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', e => {
    const url = new URL(e.request.url);

    // Network-first for API calls
    if (url.pathname.startsWith('/api/')) {
        e.respondWith(
            fetch(e.request).catch(() => new Response('{"error":"offline"}', {
                headers: { 'Content-Type': 'application/json' }
            }))
        );
        return;
    }

    if (url.pathname === '/') {
        e.respondWith(fetch(e.request));
        return;
    }

    // Cache-first for static assets
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
            if (res.ok && e.request.method === 'GET' && url.pathname.startsWith('/static/')) {
                caches.open(CACHE).then(c => c.put(e.request, res.clone()));
            }
            return res;
        }))
    );
});
