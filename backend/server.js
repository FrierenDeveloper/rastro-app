require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const storage = require('./storage');
const push = require('./push');

if (!process.env.JWT_SECRET) {
  console.error('Falta JWT_SECRET en el archivo .env. Revisa .env.example.');
  process.exit(1);
}

const app = express();

// Render (y la mayoría de hostings) van detrás de un proxy que agrega la
// cabecera X-Forwarded-For. Sin esto, express-rate-limit no identifica bien a
// cada usuario y req.protocol sería "http" (rompe los enlaces de recuperar
// contraseña). Confiamos en el primer salto (el proxy de Render).
app.set('trust proxy', 1);

app.use(helmet({
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
        "https://cdnjs.cloudflare.com",  // Leaflet JS
        "https://unpkg.com",             // Leaflet.markercluster
        "https://accounts.google.com"    // Google Sign-In
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",              // Leaflet inline styles
        "https://cdnjs.cloudflare.com", // Leaflet CSS
        "https://unpkg.com",            // Leaflet.markercluster CSS
        "https://fonts.googleapis.com"  // Google Fonts CSS
      ],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com"     // Google Fonts archivos
      ],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",
        "https://*.tile.openstreetmap.org",   // Mapa OSM (subdominios)
        "https://tile.openstreetmap.org",      // Mapa OSM
        "https://cdnjs.cloudflare.com",       // iconos de Leaflet
        "https://*.supabase.co"               // Fotos en Supabase Storage
      ],
      connectSrc: [
        "'self'",
        "https://*.supabase.co",        // Supabase API
        "https://fonts.googleapis.com",
        "https://fonts.gstatic.com",
        "https://cdnjs.cloudflare.com",
        "https://unpkg.com",
        "https://accounts.google.com"
      ],
      frameSrc: [
        "'self'",
        "https://accounts.google.com"   // iframe de Google Sign-In
      ],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"]
    }
  }
}));

const allowedOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// Fotos locales (solo se usan si NO configuraste Supabase Storage; ver storage.js).
app.use('/uploads', express.static(storage.localDir, { maxAge: '7d' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/push', require('./routes/push'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// El frontend consulta esto para activar funciones opcionales (Google, push).
app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    pushEnabled: push.enabled,
    vapidPublicKey: push.publicKey || ''
  });
});

// Sirve el frontend (PWA) desde el mismo servidor. Para producción a mayor escala,
// puedes separarlos y desplegar el frontend en un CDN/hosting estático aparte.
const frontendDir = path.join(__dirname, '..', 'frontend');
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
  .catch(err => { console.error('No se pudo inicializar la base de datos:', err.message); process.exit(1); });
