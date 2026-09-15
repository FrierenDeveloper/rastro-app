const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult, param } = require('express-validator');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const storage = require('../storage');
const push = require('../push');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const TIPOS_VALIDOS = ['perro', 'gato', 'ave', 'conejo', 'otro'];
const SEXOS_VALIDOS = ['macho', 'hembra', 'desconocido'];
const FLAGS_PARA_OCULTAR = 3;

const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Publicaste demasiados avisos en poco tiempo. Intenta más tarde.' }
});

const messageLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 60 });
const flagLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });
const infoLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 200 });

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
    resolved: !!r.resolved,
    lat: r.lat_public, lng: r.lng_public,
    created_at: Number(r.created_at)
  };
}

async function findReport(id) {
  const result = await db.query('SELECT * FROM reports WHERE id = $1', [id]);
  return result.rows[0];
}

// Etiqueta pública de un usuario: nunca mostramos su correo ni teléfono.
function peerLabel(id) {
  return 'Usuario ' + String(id).slice(0, 6);
}

/* ---------- Crear aviso (requiere sesión) ---------- */
router.post('/', requireAuth, createLimiter, upload.single('foto'),
  body('estado').isIn(['perdido', 'encontrado']),
  body('tipo').isIn(TIPOS_VALIDOS),
  body('sexo').isIn(SEXOS_VALIDOS),
  body('color').trim().isLength({ min: 1, max: 60 }),
  body('raza').optional().trim().isLength({ max: 80 }),
  body('collar').optional().trim().isLength({ max: 40 }),
  body('descripcion').optional().trim().isLength({ max: 1000 }),
  body('nombre_mascota').optional().trim().isLength({ max: 60 }),
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
          (id,user_id,estado,tipo,sexo,color,raza,collar,descripcion,nombre_mascota,foto_url,lat,lng,lat_public,lng_public,active,resolved,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE,FALSE,$16)`,
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
router.get('/', infoLimiter, async (req, res, next) => {
  try {
    const { tipo, estado } = req.query;
    let q = 'SELECT * FROM reports WHERE active = TRUE AND resolved = FALSE';
    const params = [];
    if (tipo && TIPOS_VALIDOS.includes(tipo)) { params.push(tipo); q += ` AND tipo = $${params.length}`; }
    if (estado && ['perdido', 'encontrado'].includes(estado)) { params.push(estado); q += ` AND estado = $${params.length}`; }
    q += ' ORDER BY created_at DESC LIMIT 200';
    const result = await db.query(q, params);
    res.json({ reports: result.rows.map(publicReport) });
  } catch (err) { next(err); }
});

/* ---------- Todas mis conversaciones (para dueños e interesados) ---------- */
router.get('/threads', requireAuth, async (req, res, next) => {
  try {
    const me = req.userId;
    const pairs = await db.query(
      `SELECT report_id,
              CASE WHEN sender_user_id = $1 THEN recipient_user_id ELSE sender_user_id END AS peer,
              MAX(created_at) AS last_at
         FROM messages
        WHERE sender_user_id = $1 OR recipient_user_id = $1
        GROUP BY report_id, peer
        ORDER BY last_at DESC`,
      [me]
    );

    const threads = await Promise.all(pairs.rows.map(async p => {
      const report = await findReport(p.report_id);
      if (!report) return null;
      const last = await db.query(
        `SELECT mensaje, created_at, sender_user_id FROM messages
          WHERE report_id = $1 AND ((sender_user_id = $2 AND recipient_user_id = $3) OR (sender_user_id = $3 AND recipient_user_id = $2))
          ORDER BY created_at DESC LIMIT 1`,
        [p.report_id, me, p.peer]
      );
      const unread = await db.query(
        'SELECT COUNT(*)::int AS n FROM messages WHERE report_id = $1 AND sender_user_id = $2 AND recipient_user_id = $3 AND read = FALSE',
        [p.report_id, p.peer, me]
      );
      return {
        report_id: report.id,
        peer_id: p.peer,
        peer_label: peerLabel(p.peer),
        es_mio: report.user_id === me,
        estado: report.estado,
        tipo: report.tipo,
        color: report.color,
        foto_url: report.foto_url || null,
        resolved: !!report.resolved,
        last_message: last.rows[0] ? last.rows[0].mensaje : null,
        last_at: last.rows[0] ? Number(last.rows[0].created_at) : Number(p.last_at),
        unread: unread.rows[0].n
      };
    }));

    res.json({ threads: threads.filter(Boolean) });
  } catch (err) { next(err); }
});

/* ---------- Mis avisos (con ubicación exacta y conteo de no leídos) ---------- */
router.get('/mine/all', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM reports WHERE user_id = $1 ORDER BY created_at DESC', [req.userId]);
    const withMeta = await Promise.all(result.rows.map(async r => {
      const unread = await db.query(
        'SELECT COUNT(*)::int AS n FROM messages WHERE report_id = $1 AND recipient_user_id = $2 AND read = FALSE',
        [r.id, req.userId]
      );
      return {
        ...publicReport(r),
        lat_exacto: r.lat, lng_exacto: r.lng,
        unread: unread.rows[0].n
      };
    }));
    res.json({ reports: withMeta });
  } catch (err) { next(err); }
});

/* ---------- Coincidencias posibles para un aviso ---------- */
router.get('/:id/matches', infoLimiter, param('id').isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

    const report = await findReport(req.params.id);
    if (!report || !report.active) return res.status(404).json({ error: 'Aviso no encontrado.' });

    const opuesto = report.estado === 'perdido' ? 'encontrado' : 'perdido';
    const candidatos = await db.query(
      'SELECT * FROM reports WHERE estado = $1 AND tipo = $2 AND active = TRUE AND resolved = FALSE',
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

/* ---------- Hilo de conversación de un aviso ---------- */
// Solo pueden leer/escribir las dos partes: el dueño del aviso y quien le escribió.
function puedoParticipar(report, me, peer) {
  return report.user_id === me || report.user_id === peer;
}

router.get('/:id/threads/:peerId', requireAuth, param('id').isUUID(), param('peerId').isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

    const report = await findReport(req.params.id);
    if (!report) return res.status(404).json({ error: 'Aviso no encontrado.' });

    const me = req.userId, peer = req.params.peerId;
    if (!puedoParticipar(report, me, peer)) return res.status(403).json({ error: 'No tienes acceso a esta conversación.' });

    const msgs = await db.query(
      `SELECT id, sender_user_id, mensaje, lat, lng, created_at, read
         FROM messages
        WHERE report_id = $1
          AND ((sender_user_id = $2 AND recipient_user_id = $3) OR (sender_user_id = $3 AND recipient_user_id = $2))
        ORDER BY created_at ASC LIMIT 500`,
      [report.id, me, peer]
    );

    await db.query(
      'UPDATE messages SET read = TRUE WHERE report_id = $1 AND sender_user_id = $2 AND recipient_user_id = $3',
      [report.id, peer, me]
    );

    res.json({
      peer_label: peerLabel(peer),
      es_mio: report.user_id === me,
      estado: report.estado, tipo: report.tipo, color: report.color,
      resolved: !!report.resolved,
      messages: msgs.rows.map(m => ({
        id: m.id,
        mio: m.sender_user_id === me,
        mensaje: m.mensaje,
        lat: m.lat === null ? null : Number(m.lat),
        lng: m.lng === null ? null : Number(m.lng),
        created_at: Number(m.created_at)
      }))
    });
  } catch (err) { next(err); }
});

/* ---------- Contactar / responder (mensajería interna bidireccional) ---------- */
router.post('/:id/messages', requireAuth, messageLimiter,
  param('id').isUUID(),
  body('mensaje').trim().isLength({ min: 1, max: 500 }),
  body('to_user_id').optional().isUUID(),
  body('lat').optional().isFloat({ min: -90, max: 90 }),
  body('lng').optional().isFloat({ min: -180, max: 180 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const report = await findReport(req.params.id);
      if (!report || !report.active) return res.status(404).json({ error: 'Aviso no encontrado.' });

      const me = req.userId, owner = report.user_id;
      let recipient;

      if (me === owner) {
        // El dueño responde: debe indicar a cuál de las conversaciones.
        recipient = req.body.to_user_id;
        if (!recipient) return res.status(400).json({ error: 'Indica a quién le respondes.' });
        const exists = await db.query(
          'SELECT 1 FROM messages WHERE report_id = $1 AND sender_user_id = $2 AND recipient_user_id = $3 LIMIT 1',
          [report.id, recipient, me]
        );
        if (!exists.rows.length) return res.status(400).json({ error: 'Ese usuario no ha iniciado una conversación sobre este aviso.' });
      } else {
        // Cualquier otro usuario escribe al dueño del aviso.
        recipient = owner;
      }

      const lat = req.body.lat !== undefined ? parseFloat(req.body.lat) : null;
      const lng = req.body.lng !== undefined ? parseFloat(req.body.lng) : null;

      await db.query(
        'INSERT INTO messages (id, report_id, sender_user_id, recipient_user_id, mensaje, lat, lng, created_at, read) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE)',
        [uuidv4(), report.id, me, recipient, req.body.mensaje, lat, lng, Date.now()]
      );

      // Notificación push al destinatario (no bloquea ni rompe si falla).
      push.sendToUser(recipient, {
        title: me === owner ? 'Respondieron tu aviso' : 'Nuevo mensaje en Rastro',
        body: req.body.mensaje.slice(0, 90),
        report_id: report.id,
        peer_id: me,
        tag: 'msg-' + report.id
      }).catch(() => {});

      res.status(201).json({ ok: true, message: 'Mensaje enviado.' });
    } catch (err) { next(err); }
  }
);

/* ---------- Editar un aviso propio ---------- */
const editValidators = [
  body('tipo').optional().isIn(TIPOS_VALIDOS),
  body('sexo').optional().isIn(SEXOS_VALIDOS),
  body('color').optional().trim().isLength({ min: 1, max: 60 }),
  body('raza').optional().trim().isLength({ max: 80 }),
  body('collar').optional().trim().isLength({ max: 40 }),
  body('descripcion').optional().trim().isLength({ max: 1000 }),
  body('nombre_mascota').optional().trim().isLength({ max: 60 }),
  body('lat').optional().isFloat({ min: -90, max: 90 }),
  body('lng').optional().isFloat({ min: -180, max: 180 })
];

router.patch('/:id', requireAuth, param('id').isUUID(), ...editValidators, async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

    const report = await findReport(req.params.id);
    if (!report || report.user_id !== req.userId) return res.status(404).json({ error: 'Aviso no encontrado.' });

    const b = req.body;
    const val = (campo, actual) => (b[campo] === undefined ? actual : (b[campo].trim() === '' ? null : b[campo].trim()));
    let lat = report.lat, lng = report.lng, latPub = report.lat_public, lngPub = report.lng_public;
    if (b.lat !== undefined && b.lng !== undefined) {
      lat = parseFloat(b.lat); lng = parseFloat(b.lng);
      const pub = jitter(lat, lng); latPub = pub.lat; lngPub = pub.lng;
    }

    await db.query(
      `UPDATE reports SET tipo=$1, sexo=$2, color=$3, raza=$4, collar=$5, descripcion=$6,
              nombre_mascota=$7, lat=$8, lng=$9, lat_public=$10, lng_public=$11
        WHERE id=$12`,
      [val('tipo', report.tipo), val('sexo', report.sexo), val('color', report.color) || report.color,
        val('raza', report.raza), val('collar', report.collar), val('descripcion', report.descripcion),
        val('nombre_mascota', report.nombre_mascota), lat, lng, latPub, lngPub, report.id]
    );

    const updated = await findReport(report.id);
    res.json({ report: publicReport(updated) });
  } catch (err) { next(err); }
});

/* ---------- Marcar como resuelto / reabrir ---------- */
router.post('/:id/resolve', requireAuth, param('id').isUUID(),
  body('resolved').isBoolean(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Dato inválido.' });

      const report = await findReport(req.params.id);
      if (!report || report.user_id !== req.userId) return res.status(404).json({ error: 'Aviso no encontrado.' });

      const resolved = req.body.resolved === true;
      await db.query('UPDATE reports SET resolved = $1, resolved_at = $2 WHERE id = $3',
        [resolved, resolved ? Date.now() : null, report.id]);

      res.json({ ok: true, resolved });
    } catch (err) { next(err); }
  }
);

/* ---------- Reportar un aviso inapropiado ---------- */
router.post('/:id/flag', requireAuth, flagLimiter, param('id').isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

    const report = await findReport(req.params.id);
    if (!report || !report.active) return res.status(404).json({ error: 'Aviso no encontrado.' });
    if (report.user_id === req.userId) return res.status(400).json({ error: 'No puedes reportar tu propio aviso.' });

    const inserted = await db.query(
      'INSERT INTO report_flags (report_id, user_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING report_id',
      [report.id, req.userId, Date.now()]
    );

    let flags = report.flags;
    if (inserted.rows.length) {
      const upd = await db.query('UPDATE reports SET flags = flags + 1 WHERE id = $1 RETURNING flags', [report.id]);
      flags = upd.rows[0].flags;
      if (flags >= FLAGS_PARA_OCULTAR) {
        await db.query('UPDATE reports SET active = FALSE WHERE id = $1', [report.id]);
      }
    }

    res.json({ ok: true, message: 'Gracias, revisaremos este aviso.' });
  } catch (err) { next(err); }
});

/* ---------- Eliminar (dar de baja) un aviso propio ---------- */
router.delete('/:id', requireAuth, param('id').isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

    const report = await findReport(req.params.id);
    if (!report || report.user_id !== req.userId) return res.status(404).json({ error: 'Aviso no encontrado.' });
    await db.query('UPDATE reports SET active = FALSE WHERE id = $1', [req.params.id]);
    await storage.deletePhoto(report.foto_url);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
