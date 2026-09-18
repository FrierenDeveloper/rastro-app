const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult, param } = require('express-validator');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const storage = require('../storage');
const push = require('../push');
const { requireAuth, optionalAuth } = require('../middleware/auth');
const { keyPorIp } = require('../middleware/client-ip');
const { numEnv } = require('../middleware/limits');

const router = express.Router();

const TIPOS_VALIDOS = ['perro', 'gato', 'ave', 'conejo', 'otro'];
const SEXOS_VALIDOS = ['macho', 'hembra', 'desconocido'];
const FLAGS_PARA_OCULTAR = 5;              // antes de ocultar un aviso
const FLAGS_POR_DIA = 10;                  // por cuenta
const AVISOS_POR_DIA = 20;                 // por cuenta
const MENSAJES_POR_DIA = 100;              // por cuenta
const CUENTA_MINIMA_PARA_REPORTAR = 24 * 60 * 60 * 1000; // 24 h

// Los cupos por IP se pueden ajustar por entorno (útil para pruebas de carga
// o para subirlos si tu comunidad es muy activa detrás de una misma red).
const createLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: numEnv('LIMITE_AVISOS_HORA', 15),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyPorIp,
  message: { error: 'Publicaste demasiados avisos en poco tiempo. Intenta más tarde.' }
});

const messageLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: numEnv('LIMITE_MENSAJES_HORA', 60), keyGenerator: keyPorIp });
const flagLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: numEnv('LIMITE_REPORTES_HORA', 20), keyGenerator: keyPorIp });
const infoLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: numEnv('LIMITE_CONSULTAS_15MIN', 200), keyGenerator: keyPorIp });

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

// No confiamos en el mimetype que manda el cliente: verificamos los primeros
// bytes del archivo (magic bytes) para saber el tipo real.
function tipoImagenReal(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

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

function publicReport(r, me) {
  return {
    id: r.id, estado: r.estado, tipo: r.tipo, sexo: r.sexo, color: r.color,
    raza: r.raza, collar: r.collar, descripcion: r.descripcion,
    nombre_mascota: r.estado === 'perdido' ? r.nombre_mascota : null,
    foto_url: r.foto_url || null,
    resolved: !!r.resolved,
    es_mio: !!me && r.user_id === me,
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

async function contarUltimas24h(sql, userId) {
  const r = await db.query(sql, [userId, Date.now() - 24 * 60 * 60 * 1000]);
  return r.rows[0].n;
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

      const avisosHoy = await contarUltimas24h('SELECT COUNT(*)::int AS n FROM reports WHERE user_id = $1 AND created_at > $2', req.userId);
      if (avisosHoy >= AVISOS_POR_DIA) return res.status(429).json({ error: 'Alcanzaste el límite de avisos por hoy. Intenta mañana.' });

      const { estado, tipo, sexo, color, raza, collar, descripcion, nombre_mascota } = req.body;
      const lat = parseFloat(req.body.lat), lng = parseFloat(req.body.lng);
      const pub = jitter(lat, lng);
      const id = uuidv4();

      let fotoUrl = null;
      if (req.file) {
        const tipoReal = tipoImagenReal(req.file.buffer);
        if (!tipoReal) return res.status(400).json({ error: 'El archivo no es una imagen válida.' });
        fotoUrl = await storage.savePhoto(req.file.buffer, tipoReal);
      }

      await db.query(
        `INSERT INTO reports
          (id,user_id,estado,tipo,sexo,color,raza,collar,descripcion,nombre_mascota,foto_url,lat,lng,lat_public,lng_public,active,resolved,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE,FALSE,$16)`,
        [id, req.userId, estado, tipo, sexo, color, raza || null, collar || null,
          descripcion || null, nombre_mascota || null, fotoUrl,
          lat, lng, pub.lat, pub.lng, Date.now()]
      );

      const result = await db.query('SELECT * FROM reports WHERE id = $1', [id]);
      res.status(201).json({ report: publicReport(result.rows[0], req.userId) });
    } catch (err) { next(err); }
  }
);

/* ---------- Listado público (sin datos exactos ni de contacto) ---------- */
// optionalAuth marca es_mio para que el frontend sepa si puede gestionar el aviso.
router.get('/', optionalAuth, infoLimiter, async (req, res, next) => {
  try {
    const { tipo, estado } = req.query;
    let q = 'SELECT * FROM reports WHERE active = TRUE AND resolved = FALSE';
    const params = [];
    if (tipo && TIPOS_VALIDOS.includes(tipo)) { params.push(tipo); q += ` AND tipo = $${params.length}`; }
    if (estado && ['perdido', 'encontrado'].includes(estado)) { params.push(estado); q += ` AND estado = $${params.length}`; }
    q += ' ORDER BY created_at DESC LIMIT 200';
    const result = await db.query(q, params);
    res.json({ reports: result.rows.map(r => publicReport(r, req.userId)) });
  } catch (err) { next(err); }
});

/* ---------- Todas mis conversaciones (para dueños e interesados) ---------- */
router.get('/threads', requireAuth, async (req, res, next) => {
  try {
    const me = req.userId;
    const pairs = await db.query(
      `WITH m AS (
         SELECT report_id,
                CASE WHEN sender_user_id = $1 THEN recipient_user_id ELSE sender_user_id END AS peer,
                mensaje, created_at,
                CASE WHEN recipient_user_id = $1 AND read = FALSE THEN 1 ELSE 0 END AS unread
           FROM messages
          WHERE sender_user_id = $1 OR recipient_user_id = $1
       )
       SELECT report_id, peer,
              (array_agg(mensaje ORDER BY created_at DESC))[1] AS last_message,
              MAX(created_at) AS last_at,
              SUM(unread)::int AS unread
         FROM m
        GROUP BY report_id, peer
        ORDER BY MAX(created_at) DESC`,
      [me]
    );

    const ids = pairs.rows.map(p => p.report_id);
    let byId = {};
    if (ids.length) {
      const reps = await db.query('SELECT * FROM reports WHERE id = ANY($1)', [ids]);
      byId = Object.fromEntries(reps.rows.map(r => [r.id, r]));
    }

    const threads = pairs.rows.map(p => {
      const report = byId[p.report_id];
      if (!report) return null;
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
        last_message: p.last_message,
        last_at: Number(p.last_at),
        unread: p.unread
      };
    });

    res.json({ threads: threads.filter(Boolean) });
  } catch (err) { next(err); }
});

/* ---------- Mis avisos (con ubicación exacta y conteo de no leídos) ---------- */
router.get('/mine/all', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM reports WHERE user_id = $1 ORDER BY created_at DESC', [req.userId]);
    const counts = await db.query(
      'SELECT report_id, COUNT(*)::int AS n FROM messages WHERE recipient_user_id = $1 AND read = FALSE GROUP BY report_id',
      [req.userId]
    );
    const unreadById = Object.fromEntries(counts.rows.map(c => [c.report_id, c.n]));
    res.json({
      reports: result.rows.map(r => ({
        ...publicReport(r, req.userId),
        lat_exacto: r.lat, lng_exacto: r.lng,
        unread: unreadById[r.id] || 0
      }))
    });
  } catch (err) { next(err); }
});

/* ---------- Un aviso puntual (para los enlaces compartidos) ---------- */
// El listado público solo trae los 200 más recientes; sin esto, un enlace
// compartido a un aviso más antiguo no abría nada en el frontend.
router.get('/:id', optionalAuth, param('id').isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

    const report = await findReport(req.params.id);
    if (!report || !report.active || report.resolved) return res.status(404).json({ error: 'Aviso no encontrado.' });

    res.json({ report: publicReport(report, req.userId) });
  } catch (err) { next(err); }
});

/* ---------- Coincidencias posibles para un aviso ---------- */
// Solo el dueño del aviso puede ver las coincidencias (evita que cualquiera use
// las distancias para triangular ubicaciones). Se acota con un bounding box y
// un LIMIT para no recorrer toda la tabla.
router.get('/:id/matches', requireAuth, infoLimiter, param('id').isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

    const report = await findReport(req.params.id);
    if (!report || !report.active) return res.status(404).json({ error: 'Aviso no encontrado.' });
    if (report.user_id !== req.userId) return res.status(403).json({ error: 'Solo puedes ver coincidencias de tus propios avisos.' });

    const opuesto = report.estado === 'perdido' ? 'encontrado' : 'perdido';
    const dLat = 5 / 111.32;                                             // ~5 km
    const dLng = 5 / (111.32 * Math.max(0.1, Math.cos(report.lat * Math.PI / 180)));
    const candidatos = await db.query(
      `SELECT * FROM reports
        WHERE estado = $1 AND tipo = $2 AND active = TRUE AND resolved = FALSE
          AND lat BETWEEN $3 AND $4 AND lng BETWEEN $5 AND $6
        LIMIT 100`,
      [opuesto, report.tipo, report.lat - dLat, report.lat + dLat, report.lng - dLng, report.lng + dLng]
    );

    const matches = candidatos.rows
      .map(c => ({ ...c, dist: haversine(report.lat, report.lng, c.lat, c.lng) }))
      .filter(c => c.dist <= 5 &&
        (c.color.toLowerCase().includes(report.color.toLowerCase().split(' ')[0]) ||
         report.color.toLowerCase().includes(c.color.toLowerCase().split(' ')[0])))
      .sort((a, b) => a.dist - b.dist)
      .map(c => ({ ...publicReport(c, req.userId), distancia_km: Math.round(c.dist * 10) / 10 }));

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

      const mensajesHoy = await contarUltimas24h('SELECT COUNT(*)::int AS n FROM messages WHERE sender_user_id = $1 AND created_at > $2', req.userId);
      if (mensajesHoy >= MENSAJES_POR_DIA) return res.status(429).json({ error: 'Enviaste demasiados mensajes hoy. Intenta mañana.' });

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
    res.json({ report: publicReport(updated, req.userId) });
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
// Para evitar que cuentas nuevas oculten avisos ajenos: se exige una cuenta con
// al menos 24 h, un límite diario, y hacen falta 5 reportes de 5 cuentas distintas.
router.post('/:id/flag', requireAuth, flagLimiter, param('id').isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

    const report = await findReport(req.params.id);
    if (!report || !report.active) return res.status(404).json({ error: 'Aviso no encontrado.' });
    if (report.user_id === req.userId) return res.status(400).json({ error: 'No puedes reportar tu propio aviso.' });

    const user = (await db.query('SELECT created_at FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!user || Number(user.created_at) > Date.now() - CUENTA_MINIMA_PARA_REPORTAR) {
      return res.status(403).json({ error: 'Tu cuenta es demasiado nueva para reportar avisos.' });
    }
    const flagsHoy = await contarUltimas24h('SELECT COUNT(*)::int AS n FROM report_flags WHERE user_id = $1 AND created_at > $2', req.userId);
    if (flagsHoy >= FLAGS_POR_DIA) return res.status(429).json({ error: 'Reportaste demasiados avisos hoy.' });

    const inserted = await db.query(
      'INSERT INTO report_flags (report_id, user_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING report_id',
      [report.id, req.userId, Date.now()]
    );

    if (inserted.rows.length) {
      const upd = await db.query('UPDATE reports SET flags = flags + 1 WHERE id = $1 RETURNING flags', [report.id]);
      if (upd.rows[0].flags >= FLAGS_PARA_OCULTAR) {
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
