require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');
const rateLimit = require('express-rate-limit');
const db = require('./db');
const storage = require('./storage');

if (!process.env.JWT_SECRET) {
  console.error('Falta JWT_SECRET en el archivo .env. Revisa .env.example.');
  process.exit(1);
}

const app = express();

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

const allowedOrigin = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: allowedOrigin }));

app.use(express.json({ limit: '1mb' }));
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false }));

// Fotos locales (solo se usan si NO configuraste Supabase Storage; ver storage.js).
app.use('/uploads', express.static(storage.localDir, { maxAge: '7d' }));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/reports', require('./routes/reports'));

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Sirve el frontend (PWA) desde el mismo servidor. Para producción a mayor escala,
// puedes separarlos y desplegar el frontend en un CDN/hosting estático aparte.
const frontendDir = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendDir));
app.get(/^(?!\/api\/).*/, (req, res) => res.sendFile(path.join(frontendDir, 'index.html')));

// Manejador de errores centralizado: nunca exponer detalles internos al cliente.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: 'Ocurrió un error en el servidor.' });
});

const PORT = process.env.PORT || 3000;
db.init()
  .then(() => app.listen(PORT, () => console.log(`Rastro API escuchando en puerto ${PORT}`)))
  .catch(err => { console.error('No se pudo inicializar la base de datos:', err.message); process.exit(1); });
