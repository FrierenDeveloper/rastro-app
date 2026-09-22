require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const storage = require('./storage');
const push = require('./push');
const { keyPorIp } = require('./middleware/client-ip');

if (!process.env.JWT_SECRET) {
  console.error('Falta JWT_SECRET en el archivo .env. Revisa .env.example.');
  process.exit(1);
}

// El microchip se compara por huella (HMAC) y se enseña descifrado (AES), así que
// necesita su PROPIO secreto. A propósito NO se cae a JWT_SECRET: si el chip
// dependiera del secreto de sesión, rotarlo dejaría sin coincidencia —y sin poder
// verse— todos los chips ya declarados, en silencio y sin arreglo posible. Se
// aborta el arranque para que ese despliegue no llegue a producirse.
if (!process.env.CHIP_SECRET) {
  console.error(
    'Falta CHIP_SECRET en el archivo .env. Revisa .env.example (es obligatorio y distinto de JWT_SECRET).'
  );
  process.exit(1);
}

const app = express();

// Render (y la mayoría de hostings) van detrás de un proxy que agrega la
// cabecera X-Forwarded-For. Confiamos en el primer salto.
// IMPORTANTE: si algún día expones la app SIN proxy por delante, pon TRUST_PROXY=0
// en el .env; de lo contrario se podría falsear la IP con X-Forwarded-For y
// evadir los límites de peticiones.
const trustProxy = process.env.TRUST_PROXY !== undefined ? Number(process.env.TRUST_PROXY) : 1;
app.set('trust proxy', trustProxy);

app.use(
  helmet({
    // OpenStreetMap exige que el navegador envíe un Referer válido; con el
    // "no-referrer" por defecto de Helmet, OSM bloquea los tiles (403) y el mapa
    // queda gris. Este valor manda solo el origen en peticiones cross-origin.
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          'https://cdnjs.cloudflare.com', // Leaflet JS
          'https://unpkg.com', // Leaflet.markercluster
          'https://accounts.google.com' // Google Sign-In
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'", // Leaflet inline styles
          'https://cdnjs.cloudflare.com', // Leaflet CSS
          'https://unpkg.com', // Leaflet.markercluster CSS
          'https://fonts.googleapis.com' // Google Fonts CSS
        ],
        fontSrc: [
          "'self'",
          'https://fonts.gstatic.com' // Google Fonts archivos
        ],
        imgSrc: [
          "'self'",
          'data:',
          'blob:',
          'https://*.tile.openstreetmap.org', // Mapa OSM (subdominios)
          'https://tile.openstreetmap.org', // Mapa OSM
          'https://server.arcgisonline.com', // Tiles Esri
          'https://*.tile.opentopomap.org', // Tiles OpenTopoMap (respaldo)
          'https://cdnjs.cloudflare.com', // iconos de Leaflet
          'https://*.supabase.co' // Fotos en Supabase Storage
        ],
        connectSrc: [
          "'self'",
          'https://*.supabase.co', // Supabase API
          'https://fonts.googleapis.com',
          'https://fonts.gstatic.com',
          'https://cdnjs.cloudflare.com',
          'https://unpkg.com',
          'https://accounts.google.com'
        ],
        frameSrc: [
          "'self'",
          'https://accounts.google.com' // iframe de Google Sign-In
        ],
        workerSrc: ["'self'"],
        manifestSrc: ["'self'"]
      }
    }
  })
);

// El frontend se sirve desde el mismo origen, así que CORS no hace falta.
// Solo montamos el middleware si defines un dominio explícito: así no se
// devuelve la cabecera Access-Control-Allow-Origin a terceros.
let allowedOrigin = process.env.CORS_ORIGIN || '';
if (allowedOrigin === '*') allowedOrigin = '';
if (allowedOrigin) app.use(cors({ origin: allowedOrigin }));

app.use(express.json({ limit: '1mb' }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyPorIp
  })
);

// Fotos locales (solo se usan si NO configuraste Supabase Storage; ver storage.js).
app.use('/uploads', express.static(storage.localDir, { maxAge: '7d' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/push', require('./routes/push'));
app.use('/api/geocode', require('./routes/geocode'));
app.use('/api/admin', require('./routes/admin'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// El frontend consulta esto para activar funciones opcionales (Google, push).
app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    pushEnabled: push.enabled,
    vapidPublicKey: push.publicKey || ''
  });
});

/* ---------- Verificación de dominio para el APK de Android (TWA) ---------- */
// Un APK tipo TWA (Bubblewrap / PWABuilder) comprueba que la app y esta web son
// del mismo dueño leyendo /.well-known/assetlinks.json. Si el archivo falta, o
// si la firma no coincide, Android abre la app CON la barra del navegador a la
// vista (deja de parecer una app).
//
// Se configura por variables de entorno, así no hay que tocar código:
//   ANDROID_PACKAGE_NAME              ej: com.rastro.app
//   ANDROID_SHA256_CERT_FINGERPRINTS  uno o varios SHA-256 separados por coma
// Los dos datos los entrega PWABuilder, o se sacan con:
//   keytool -list -v -keystore mi.keystore
const ANDROID_PACKAGE_NAME = (process.env.ANDROID_PACKAGE_NAME || '').trim();
const FORMATO_SHA256 = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
const FINGERPRINTS_CRUDOS = (process.env.ANDROID_SHA256_CERT_FINGERPRINTS || '')
  .split(',')
  .map(s => s.trim().toUpperCase())
  .filter(Boolean);
const ANDROID_FINGERPRINTS = FINGERPRINTS_CRUDOS.filter(f => FORMATO_SHA256.test(f));

if (FINGERPRINTS_CRUDOS.length && ANDROID_FINGERPRINTS.length !== FINGERPRINTS_CRUDOS.length) {
  // Un SHA mal copiado no da error en Android: simplemente la verificación
  // falla y la app se abre con barra de navegador. Mejor avisar fuerte aquí.
  console.warn('[android] Hay huellas SHA-256 con formato inválido y se van a ignorar:');
  for (const f of FINGERPRINTS_CRUDOS) {
    if (!FORMATO_SHA256.test(f))
      console.warn(`      "${f}" (se esperan 32 pares AA:BB:... separados por dos puntos)`);
  }
}

app.get('/.well-known/assetlinks.json', (req, res) => {
  if (!ANDROID_PACKAGE_NAME || !ANDROID_FINGERPRINTS.length) {
    // Sin configurar responde 404 JSON. NO devolvemos la app: un verificador que
    // recibe HTML en vez de JSON falla de una forma muy difícil de diagnosticar.
    return res.status(404).json({
      error: 'Falta configurar ANDROID_PACKAGE_NAME y ANDROID_SHA256_CERT_FINGERPRINTS en el entorno.'
    });
  }
  res.type('application/json').json([
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: ANDROID_PACKAGE_NAME,
        sha256_cert_fingerprints: ANDROID_FINGERPRINTS
      }
    }
  ]);
});

// Cualquier otro /.well-known/* (por ejemplo apple-app-site-association para
// iOS) responde 404 JSON y nunca el index.html de la app.
app.use('/.well-known', (req, res) => res.status(404).json({ error: 'No encontrado.' }));

// Sirve el frontend (PWA) desde el mismo servidor. Para producción a mayor escala,
// puedes separarlos y desplegar el frontend en un CDN/hosting estático aparte.
const frontendDir = path.join(__dirname, '..', 'frontend');
// Cualquier ruta /api desconocida responde JSON (no el index.html de la app).
app.use('/api', (req, res) => res.status(404).json({ error: 'No encontrado.' }));
app.use(express.static(frontendDir));
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(frontendDir, 'index.html')));

// Manejador de errores centralizado: nunca exponer detalles internos al cliente.
app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'La foto es demasiado grande (máximo 5 MB).' });
    }
    return res.status(400).json({ error: 'No se pudo procesar la imagen subida.' });
  }
  if (err && err.message === 'Formato de imagen no permitido.') {
    return res.status(400).json({ error: err.message });
  }
  res.status(err.status || 500).json({ error: 'Ocurrió un error en el servidor.' });
});

const PORT = process.env.PORT || 3000;
db.init()
  .then(() => app.listen(PORT, () => console.log(`Rastro API escuchando en puerto ${PORT}`)))
  .catch(err => {
    console.error('No se pudo inicializar la base de datos:', err.message);
    process.exit(1);
  });
