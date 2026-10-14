// Lumen service worker: offline caching + cross-origin isolation headers
// (needed for the multi-threaded RAW decoder on hosts that can't set headers).
const CACHE = 'lumen-v10';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('message', (e) => {
  if (e.data === 'claim') self.clients.claim();
});

function isolate(resp) {
  if (!resp || resp.status === 0 || resp.type === 'opaque') return resp;
  const h = new Headers(resp.headers);
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('.apk')) return; // let Chrome download the app directly
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const immutable = ['/assets/', '/libraw/', '/models/', '/ort/', '/mediapipe/'].some((d) => url.pathname.includes(d));
    if (immutable) {
      const hit = await cache.match(req);
      if (hit) return isolate(hit);
    }
    try {
      const resp = await fetch(req);
      if (resp.ok && resp.type === 'basic') cache.put(req, resp.clone());
      return isolate(resp);
    } catch (err) {
      const hit = (await cache.match(req, { ignoreSearch: true })) ||
        (req.mode === 'navigate' ? await cache.match(new URL('./', self.registration.scope).href) : undefined);
      if (hit) return isolate(hit);
      throw err;
    }
  })());
});
