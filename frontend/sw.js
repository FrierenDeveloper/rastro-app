// Service worker: estrategia "red primero" para el código de la app.
// Así, si publicas una corrección, el navegador la recibe de inmediato en vez
// de quedarse pegado con una versión vieja guardada en caché.
// La caché queda solo como respaldo para cuando no hay conexión.
const CACHE = 'rastro-shell-v3';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Datos en vivo y fotos: siempre a la red, nunca desde caché.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;
  if (e.request.method !== 'GET') return;

  // Resto (HTML, CSS, JS): intenta la red primero y actualiza la caché.
  // Si no hay conexión, recién ahí usa la copia guardada.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
