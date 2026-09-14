// Offline, and the reason this is installable at all.
//
// The game has no server side and never had: every track, record and ghost
// lives in the browser. Once the files are here it runs on a train.

const CACHE = 'dare-stunts-pc-v1';

// What to fetch up front, so the very first visit is enough to make the game
// work offline afterwards -- without it, anything not touched on that visit
// would be missing later.
//
// It is a written list, and a written list goes stale. So nothing depends on
// it being complete: a file missing from here is still cached the first time
// the game asks for it (see the fetch handler), and a file listed here that no
// longer exists is skipped instead of failing the whole install -- which is
// what cache.addAll would do, taking offline support down with it.
const ASSETS = [
  './',
  './css/tv.css',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable.png',
  './img/capa.svg',
  './img/corsario.png',
  './img/lebre.png',
  './img/tenaz.png',
  './index.html',
  './js/core/gl.js',
  './js/core/materials.js',
  './js/core/math.js',
  './js/core/mesh.js',
  './js/core/renderer.js',
  './js/core/shaders/common.js',
  './js/core/shaders/post.js',
  './js/core/shaders/present.js',
  './js/core/shaders/scene.js',
  './js/core/shaders/shadow.js',
  './js/editor/close.js',
  './js/game/audio.js',
  './js/game/car.js',
  './js/game/cars.js',
  './js/game/driver.js',
  './js/game/game.js',
  './js/game/ghost.js',
  './js/game/hud.js',
  './js/game/input.js',
  './js/game/rival.js',
  './js/tv/editor.js',
  './js/tv/input.js',
  './js/tv/keyboard.js',
  './js/tv/main.js',
  './js/tv/map.js',
  './js/tv/screens.js',
  './js/ui/install.js',
  './js/ui/keys.js',
  './js/ui/pads.js',
  './js/ui/profiles.js',
  './js/world/customtracks.js',
  './js/world/pieces.js',
  './js/world/scenery.js',
  './js/world/track.js',
  './js/world/tracks.js',
  './manifest.webmanifest',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.allSettled(ASSETS.map(u => cache.add(u)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

// Network first, cache as fallback.
//
// Cache-first would start marginally faster off a local server and would keep
// serving yesterday's modules after every edit -- which, in a repository whose
// whole subject is changing how the thing looks, is a guaranteed afternoon
// spent debugging something already fixed. This way online is always current
// and offline still works from the last visit.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      // A deep link with nothing cached for it still has to land somewhere.
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('Offline e sem cópia em cache.', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});
