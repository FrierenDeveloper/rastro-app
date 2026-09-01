const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult, param, query: queryValidator } = require('express-validator');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const storage = require('../storage');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const TIPOS_VALIDOS = ['perro', 'gato', 'ave', 'conejo', 'otro'];
const SEXOS_VALIDOS = ['macho', 'hembra', 'desconocido'];

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Publicaste demasiados avisos en poco tiempo. Intenta más tarde.' }
});

// multer en memoria: el buffer se pasa directo a storage.savePhoto()
// (Supabase Storage o disco local, según esté configurado).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    const ok = ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype);
    cb(ok ? null : new Error('Formato de imagen no permitido.'), ok);
  }
});

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
// Difumina la ubicación real ~300m: el mapa público nunca muestra la posición exacta.
function jitter(lat, lng, meters = 300) {
  const rand = () => (Math.random() - 0.5) * 2;
  const dLat = (rand() * meters) / 111320;
  const dLng = (rand() * meters) / (111320 * Math.cos((lat * Math.PI) / 180));
  return { lat: lat + dLat, lng: lng + dLng };
}

function publicReport(r) {
  return {
    id: r.id, estado: r.estado, tipo: r.tipo, sexo: r.sexo, color: r.color,
    raza: r.raza, collar: r.collar, descripcion: r.descripcion,
    nombre_mascota: r.estado === 'perdido' ? r.nombre_mascota : null,
    foto_url: r.foto_url || null,
    lat: r.lat_public, lng: r.lng_public,
    created_at: Number(r.created_at)
  };
}

/* ---------- Crear aviso (requiere sesión) ---------- */
router.post('/', requireAuth, createLimiter, upload.single('foto'),
  body('estado').isIn(['perdido', 'encontrado']),
  body('tipo').isIn(TIPOS_VALIDOS),
  body('sexo').isIn(SEXOS_VALIDOS),
  body('color').trim().isLength({ min: 1, max: 60 }),
  body('lat').isFloat({ min: -90, max: 90 }),
  body('lng').isFloat({ min: -180, max: 180 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const { estado, tipo, sexo, color, raza, collar, descripcion, nombre_mascota } = req.body;
      const lat = parseFloat(req.body.lat), lng = parseFloat(req.body.lng);
      const pub = jitter(lat, lng);
      const id = uuidv4();

      let fotoUrl = null;
      if (req.file) fotoUrl = await storage.savePhoto(req.file.buffer, req.file.mimetype);

      await db.query(
        `INSERT INTO reports
          (id,user_id,estado,tipo,sexo,color,raza,collar,descripcion,nombre_mascota,foto_url,lat,lng,lat_public,lng_public,active,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE,$16)`,
        [id, req.userId, estado, tipo, sexo, color, raza || null, collar || null,
          descripcion || null, nombre_mascota || null, fotoUrl,
          lat, lng, pub.lat, pub.lng, Date.now()]
      );

      const result = await db.query('SELECT * FROM reports WHERE id = $1', [id]);
      res.status(201).json({ report: publicReport(result.rows[0]) });
    } catch (err) { next(err); }
  }
);

/* ---------- Listado público (sin datos exactos ni de contacto) ---------- */
router.get('/', async (req, res, next) => {
  try {
    const { tipo, estado } = req.query;
    let q = 'SELECT * FROM reports WHERE active = TRUE';
    const params = [];
    if (tipo && TIPOS_VALIDOS.includes(tipo)) { params.push(tipo); q += ` AND tipo = $${params.length}`; }
    if (estado && ['perdido', 'encontrado'].includes(estado)) { params.push(estado); q += ` AND estado = $${params.length}`; }
    q += ' ORDER BY created_at DESC LIMIT 200';
    const result = await db.query(q, params);
    res.json({ reports: result.rows.map(publicReport) });
  } catch (err) { next(err); }
});

/* ---------- Coincidencias posibles para un aviso ---------- */
router.get('/:id/matches', param('id').isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

    const result = await db.query('SELECT * FROM reports WHERE id = $1 AND active = TRUE', [req.params.id]);
    const report = result.rows[0];
    if (!report) return res.status(404).json({ error: 'Aviso no encontrado.' });

    const opuesto = report.estado === 'perdido' ? 'encontrado' : 'perdido';
    const candidatos = await db.query(
      'SELECT * FROM reports WHERE estado = $1 AND tipo = $2 AND active = TRUE',
      [opuesto, report.tipo]
    );

    const matches = candidatos.rows
      .map(c => ({ ...c, dist: haversine(report.lat, report.lng, c.lat, c.lng) })) // distancia real, en el servidor
      .filter(c => c.dist <= 5 &&
        (c.color.toLowerCase().includes(report.color.toLowerCase().split(' ')[0]) ||
         report.color.toLowerCase().includes(c.color.toLowerCase().split(' ')[0])))
      .sort((a, b) => a.dist - b.dist)
      .map(c => ({ ...publicReport(c), distancia_km: Math.round(c.dist * 10) / 10 }));

    res.json({ matches });
  } catch (err) { next(err); }
});

/* ---------- Mis avisos (con ubicación exacta y mensajes recibidos) ---------- */
router.get('/mine/all', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM reports WHERE user_id = $1 ORDER BY created_at DESC', [req.userId]);
    const withMessages = await Promise.all(result.rows.map(async r => {
      const msgs = await db.query(
        'SELECT id, mensaje, created_at, read FROM messages WHERE report_id = $1 ORDER BY created_at DESC',
        [r.id]
      );
      return {
        ...publicReport(r),
        lat_exacto: r.lat, lng_exacto: r.lng,
        mensajes: msgs.rows.map(m => ({ ...m, created_at: Number(m.created_at) }))
      };
    }));
    res.json({ reports: withMessages });
  } catch (err) { next(err); }
});

/* ---------- Contactar al autor de un aviso (mensajería interna) ---------- */
const messageLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30 });
router.post('/:id/messages', requireAuth, messageLimiter,
  param('id').isUUID(),
  body('mensaje').trim().isLength({ min: 1, max: 500 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const result = await db.query('SELECT * FROM reports WHERE id = $1 AND active = TRUE', [req.params.id]);
      const report = result.rows[0];
      if (!report) return res.status(404).json({ error: 'Aviso no encontrado.' });

      const id = uuidv4();
      await db.query(
        'INSERT INTO messages (id, report_id, sender_user_id, mensaje, created_at) VALUES ($1,$2,$3,$4,$5)',
        [id, report.id, req.userId, req.body.mensaje, Date.now()]
      );

      // Producción: aquí se dispararía un correo/push al dueño del aviso (SendGrid, FCM, etc.)
      res.status(201).json({ ok: true, message: 'Mensaje enviado a la persona que publicó el aviso.' });
    } catch (err) { next(err); }
  }
);

/* ---------- Eliminar (dar de baja) un aviso propio ---------- */
router.delete('/:id', requireAuth, param('id').isUUID(), async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM reports WHERE id = $1', [req.params.id]);
    const report = result.rows[0];
    if (!report || report.user_id !== req.userId) return res.status(404).json({ error: 'Aviso no encontrado.' });
    await db.query('UPDATE reports SET active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
