// Lumen service worker: offline caching + cross-origin isolation headers
// (needed for the multi-threaded RAW decoder on hosts that can't set headers).
//
// Three kinds of cache:
//  * the app shell (page, scripts, styles, fonts, icons): fetched on install, so the app starts
//    offline straight after an update; one per build, older ones are dropped
//  * the big runtimes (RAW decoder, ONNX Runtime, MediaPipe, the built-in AI model): kept on
//    first use and across app updates, until those files themselves change
//  * AI models the app downloaded itself ('lumen-models-…', see src/ai/segment.ts): never touched here
//
// scripts/stamp-sw.mjs fills in the three values below after a build (without it the worker
// still works: nothing is fetched ahead, and files are kept as they're used).
const BUILD = '__BUILD__';
const RUNTIMES = '__RUNTIMES__';
const PRECACHE = [/*__PRECACHE__*/];

const SHELL = 'lumen-v16-' + BUILD;
const RUNTIME = 'lumen-rt-' + RUNTIMES;
const RUNTIME_DIRS = ['/libraw/', '/models/', '/ort/', '/mediapipe/'];
/** How long a page load waits for the network before starting from the saved shell. */
const NAV_TIMEOUT = 3000;

/** Save whatever part of the app shell isn't saved yet (once per start of the worker; best effort). */
let shell = null;
function ensureShell() {
  return (shell ??= (async () => {
    try {
      const cache = await caches.open(SHELL);
      const have = new Set((await cache.keys()).map((r) => r.url));
      await Promise.all(PRECACHE.map(async (path) => {
        const url = new URL(path, self.registration.scope).href;
        if (have.has(url)) return;
        try {
          // files with a hash in their name never change: take them from an earlier shell if it
          // has them; the page itself is asked for afresh
          const hashed = path.startsWith('assets/');
          const resp = (hashed && (await caches.match(url))) || (await fetch(url, { cache: hashed ? 'default' : 'no-cache' }));
          if (resp.status === 200) await cache.put(url, resp);
        } catch (err) {
          /* offline or storage full: that file is kept when it's next used */
        }
      }));
    } catch (err) {
      /* no cache storage: the worker still adds the isolation headers */
    }
  })());
}

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    // an update has its shell saved before it takes over (so the app still starts offline right
    // after); a first install doesn't wait for that: the page reloads once as soon as the worker
    // is in control, and the shell is saved while it loads
    if (self.registration.active) await ensureShell();
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

/**
 * Drop this worker's own older caches (never the models the app downloaded). Done when the app
 * is next started, not when the update arrives: a page still open from before the update keeps
 * finding its own files (the video editor, the workers) until then.
 */
async function dropOld() {
  try {
    const keys = await caches.keys();
    const old = (k) => (k.startsWith('lumen-v') && k !== SHELL) || (k.startsWith('lumen-rt-') && k !== RUNTIME);
    await Promise.all(keys.filter(old).map((k) => caches.delete(k)));
  } catch (err) {
    /* no cache storage */
  }
}
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

/** Keep a copy of a complete, same-origin response (best effort: storage may be full). */
function keep(cache, req, resp) {
  if (resp.status === 200 && resp.type === 'basic') cache.put(req, resp.clone()).catch(() => {});
}

/** The saved page for a navigation: this URL's copy, or the app's start page. */
async function savedPage(cache, req) {
  return (await cache.match(req, { ignoreSearch: true })) || (await cache.match(new URL('./', self.registration.scope).href));
}

/**
 * A page load: the network first (so an update shows up at once), but only for a few seconds;
 * on a connection that's there but not answering, the app starts from the saved shell instead.
 */
async function navigate(e, cache, req) {
  const net = fetch(req).then((resp) => {
    keep(cache, req, resp);
    return resp;
  });
  // (if the saved shell is used, the answer still gets stored when it comes)
  e.waitUntil(net.catch(() => {}).then(dropOld));
  let timer;
  const slow = new Promise((res) => (timer = setTimeout(res, NAV_TIMEOUT, null)));
  try {
    const resp = await Promise.race([net, slow]);
    if (resp) return resp;
    return (await savedPage(cache, req)) || (await net);
  } catch (err) {
    const hit = await savedPage(cache, req);
    if (hit) return hit;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Shared to the installed app (Android's share sheet): the files are kept for the page, which
 * is then opened to pick them up (see bindShared in src/ui/app.ts).
 */
async function takeShare(req) {
  try {
    const form = await req.formData();
    await caches.delete('lumen-share');
    const cache = await caches.open('lumen-share');
    let n = 0;
    for (const f of form.getAll('media')) {
      if (!(f instanceof File)) continue;
      await cache.put(new URL(`./shared/${n++}`, self.registration.scope).href, new Response(f, { headers: { 'content-type': f.type || '', 'x-name': encodeURIComponent(f.name) } }));
    }
  } catch (err) {
    /* nothing kept: the app just opens */
  }
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method === 'POST' && new URL(req.url).pathname.endsWith('/share-target')) return e.respondWith(takeShare(req));
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('.apk')) return; // let Chrome download the app directly
  // the captions model: fetched once by the app, which keeps it with its other models
  if (url.pathname.includes('/asr/')) return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  e.waitUntil(ensureShell());
  e.respondWith((async () => {
    const runtime = RUNTIME_DIRS.some((d) => url.pathname.includes(d));
    const cache = await caches.open(runtime ? RUNTIME : SHELL);
    if (req.mode === 'navigate') return isolate(await navigate(e, cache, req));
    // these never change under the same name (and cache name): no need to ask the network
    if (runtime || url.pathname.includes('/assets/')) {
      // (hashed files: an older build's copy will do too, a page from before an update asks
      // for its own; the runtimes only ever come from this build's set)
      const hit = (await cache.match(req)) || (runtime ? undefined : await caches.match(req));
      if (hit) return isolate(hit);
    }
    try {
      const resp = await fetch(req);
      keep(cache, req, resp);
      return isolate(resp);
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return isolate(hit);
      throw err;
    }
  })());
});
