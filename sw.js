// Service worker: gør A104 Navigator offline. Appens filer og Python-runtime (Pyodide) gemmes ved installation.
const BUILD = '2.18.0-bc430c89ae';
const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.2/full/';
const APP_CACHE = `a104-app-${BUILD}`;
const PY_CACHE = `a104-pyodide-${PYODIDE_URL}`;
const PRECACHE = ["./", "index.html", "app.css", "app.js", "worker.js", "manifest.webmanifest", "core.zip?v=2.18.0-bc430c89ae", "data.zip?v=2.18.0-bc430c89ae", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png", "data/love/AB18.pdf", "data/love/ABR18.pdf", "data/love/ABT18.pdf"];
const PYODIDE_CORE = ['pyodide.js', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
const PYODIDE_PACKAGES = ['sqlite3'];

async function cachePyodide() {
  const cache = await caches.open(PY_CACHE);
  const lock = await fetch(PYODIDE_URL + 'pyodide-lock.json').then((r) => r.json());
  const files = new Set(PYODIDE_CORE);
  const add = (name) => {
    const pkg = lock.packages[name];
    if (!pkg || files.has(pkg.file_name)) return;
    files.add(pkg.file_name);
    (pkg.depends || []).forEach(add);
  };
  PYODIDE_PACKAGES.forEach(add);
  await Promise.all([...files].map(async (f) => {
    const url = PYODIDE_URL + f;
    if (!(await cache.match(url))) await cache.add(url);
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([
    caches.open(APP_CACHE).then((c) => c.addAll(PRECACHE)),
    cachePyodide(),
  ]));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== APP_CACHE && key !== PY_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.href.startsWith(PYODIDE_URL)) {
    event.respondWith((async () => {
      const cache = await caches.open(PY_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }
  if (url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    if (req.mode === 'navigate') {
      return (await cache.match('./')) || fetch(req);
    }
    const hit = await cache.match(req);
    if (hit) return hit;
    const res = await fetch(req);
    if (res.ok && url.pathname.includes('/data/')) cache.put(req, res.clone());
    return res;
  })());
});
