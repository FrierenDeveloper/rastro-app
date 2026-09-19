// Service worker: estrategia "red primero" para el código de la app.
// Así, si publicas una corrección, el navegador la recibe de inmediato en vez
// de quedarse pegado con una versión vieja guardada en caché.
// La caché queda solo como respaldo para cuando no hay conexión.
const CACHE = 'rastro-shell-v11';
const SHELL = ['/', '/index.html', '/styles.css', '/app.js', '/manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then(c => c.addAll(SHELL))
      .catch(() => {})
  );
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

  // Deja pasar sin tocarlas las peticiones a OTROS dominios (tiles del mapa,
  // fotos de Supabase, CDNs). Que las maneje el navegador directamente: así el
  // service worker nunca puede interferir con el mapa ni servir una copia
  // vieja de un tile.
  if (url.origin !== self.location.origin) return;

  // Datos en vivo y fotos: siempre a la red, nunca desde caché.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) return;
  if (e.request.method !== 'GET') return;

  // Resto (HTML, CSS, JS): intenta la red primero y actualiza la caché.
  // Si no hay conexión, recién ahí usa la copia guardada.
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches
          .open(CACHE)
          .then(c => c.put(e.request, copy))
          .catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

/* ---------- Notificaciones push ---------- */
self.addEventListener('push', e => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch (_) {
    /* payload no JSON */
  }
  const title = data.title || 'Rastro';
  const options = {
    body: data.body || 'Tienes novedades en Rastro.',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png',
    tag: data.tag || 'rastro',
    data: { report_id: data.report_id || null, peer_id: data.peer_id || null }
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = '/?tab=chats';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if ('focus' in c) {
          c.focus();
          return;
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(url);
    })
  );
});
