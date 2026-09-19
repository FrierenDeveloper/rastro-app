const express = require('express');
const multer = require('multer');
const QRCode = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult, param } = require('express-validator');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const storage = require('../storage');
const push = require('../push');
const { radioBusquedaKm, curvaRadio, sugerenciaBusqueda } = require('../busqueda');
const { requireAuth, optionalAuth, requireVerified } = require('../middleware/auth');
const { keyPorIp } = require('../middleware/client-ip');
const { numEnv } = require('../middleware/limits');

const router = express.Router();

const TIPOS_VALIDOS = ['perro', 'gato', 'ave', 'conejo', 'otro'];
const SEXOS_VALIDOS = ['macho', 'hembra', 'desconocido'];
const FLAGS_PARA_OCULTAR = 5; // antes de ocultar un aviso
const FLAGS_POR_DIA = 10; // por cuenta
const AVISOS_POR_DIA = 20; // por cuenta
const MENSAJES_POR_DIA = 100; // por cuenta
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

const messageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: numEnv('LIMITE_MENSAJES_HORA', 60),
  keyGenerator: keyPorIp
});
const flagLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: numEnv('LIMITE_REPORTES_HORA', 20),
  keyGenerator: keyPorIp
});
const infoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: numEnv('LIMITE_CONSULTAS_15MIN', 200),
  keyGenerator: keyPorIp
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
  const R = 6371,
    toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1),
    dLng = toRad(lng2 - lng1);
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
    id: r.id,
    estado: r.estado,
    tipo: r.tipo,
    sexo: r.sexo,
    color: r.color,
    raza: r.raza,
    collar: r.collar,
    descripcion: r.descripcion,
    nombre_mascota: r.estado === 'perdido' ? r.nombre_mascota : null,
    foto_url: r.foto_url || null,
    resolved: !!r.resolved,
    es_mio: !!me && r.user_id === me,
    radio_km: r.radio_km === null || r.radio_km === undefined ? null : Number(r.radio_km),
    perdido_hace_horas:
      r.perdido_hace_horas === null || r.perdido_hace_horas === undefined
        ? null
        : Number(r.perdido_hace_horas),
    lat: r.lat_public,
    lng: r.lng_public,
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

// Avisa a quienes pidieron alertas de su zona cuando se pierde una mascota
// cerca. El radio sale de busqueda.js (cuánto se aleja según el tiempo).
async function notificarZona(reportId, tipo, color, lat, lng, radioKm, excluirUserId) {
  const dLat = radioKm / 111.32;
  const dLng = radioKm / (111.32 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  const rows = (
    await db.query(
      `SELECT user_id, lat, lng FROM zone_alerts
      WHERE lat BETWEEN $1 AND $2 AND lng BETWEEN $3 AND $4`,
      [lat - dLat, lat + dLat, lng - dLng, lng + dLng]
    )
  ).rows;
  const destinatarios = rows
    .filter(r => r.user_id !== excluirUserId)
    .filter(r => haversine(lat, lng, Number(r.lat), Number(r.lng)) <= radioKm);
  await Promise.all(
    destinatarios.map(r =>
      push
        .sendToUser(r.user_id, {
          title: '🐾 Se perdió una mascota cerca de ti',
          body: `Un ${tipo} ${color} se perdió en tu zona. Toca para ver el aviso.`,
          report_id: reportId,
          tag: 'zona-' + reportId
        })
        .catch(() => {})
    )
  );
}

/* ---------- Crear aviso (requiere sesión) ---------- */
router.post(
  '/',
  requireAuth,
  requireVerified,
  createLimiter,
  upload.single('foto'),
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
  body('perdido_hace_horas').optional({ values: 'falsy' }).isInt({ min: 0, max: 8760 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const avisosHoy = await contarUltimas24h(
        'SELECT COUNT(*)::int AS n FROM reports WHERE user_id = $1 AND created_at > $2',
        req.userId
      );
      if (avisosHoy >= AVISOS_POR_DIA)
        return res.status(429).json({ error: 'Alcanzaste el límite de avisos por hoy. Intenta mañana.' });

      const { estado, tipo, sexo, color, raza, collar, descripcion, nombre_mascota } = req.body;
      const lat = parseFloat(req.body.lat),
        lng = parseFloat(req.body.lng);
      const pub = jitter(lat, lng);
      const id = uuidv4();

      // Radio sugerido de búsqueda/alerta, según cuánto lleva perdida la mascota.
      const horasPerdido =
        estado === 'perdido' && req.body.perdido_hace_horas !== undefined
          ? parseInt(req.body.perdido_hace_horas, 10)
          : null;
      const radioKm = horasPerdido === null ? null : radioBusquedaKm(tipo, horasPerdido);
      let fotoUrl = null;
      if (req.file) {
        const tipoReal = tipoImagenReal(req.file.buffer);
        if (!tipoReal) return res.status(400).json({ error: 'El archivo no es una imagen válida.' });
        fotoUrl = await storage.savePhoto(req.file.buffer, tipoReal);
      }

      await db.query(
        `INSERT INTO reports
          (id,user_id,estado,tipo,sexo,color,raza,collar,descripcion,nombre_mascota,foto_url,lat,lng,lat_public,lng_public,active,resolved,created_at,perdido_hace_horas,radio_km)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE,FALSE,$16,$17,$18)`,
        [
          id,
          req.userId,
          estado,
          tipo,
          sexo,
          color,
          raza || null,
          collar || null,
          descripcion || null,
          nombre_mascota || null,
          fotoUrl,
          lat,
          lng,
          pub.lat,
          pub.lng,
          Date.now(),
          horasPerdido,
          radioKm
        ]
      );

      // Avisar a las zonas suscritas (no bloquea la respuesta si falla).
      // Para el aviso usamos un mínimo de 500 m: el radio de BÚSQUEDA de un gato
      // es de decenas de metros (mediana 50 m), pero la alerta de zona llega a
      // personas, y el estudio muestra que el 75% de los gatos aparece dentro de
      // 500 m. Avisar solo a la casa de al lado desperdiciaría la alerta.
      if (estado === 'perdido') {
        const radioAviso = Math.max(radioKm || 0, 0.5);
        notificarZona(id, tipo, color, lat, lng, radioAviso, req.userId).catch(() => {});
      }

      const result = await db.query('SELECT * FROM reports WHERE id = $1', [id]);
      res.status(201).json({ report: publicReport(result.rows[0], req.userId) });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------- Listado público (sin datos exactos ni de contacto) ---------- */
// optionalAuth marca es_mio para que el frontend sepa si puede gestionar el aviso.
router.get('/', optionalAuth, infoLimiter, async (req, res, next) => {
  try {
    const { tipo, estado } = req.query;
    const texto = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase().slice(0, 80) : '';
    let q = 'SELECT * FROM reports WHERE active = TRUE AND resolved = FALSE';
    const params = [];
    if (tipo && TIPOS_VALIDOS.includes(tipo)) {
      params.push(tipo);
      q += ` AND tipo = $${params.length}`;
    }
    if (estado && ['perdido', 'encontrado'].includes(estado)) {
      params.push(estado);
      q += ` AND estado = $${params.length}`;
    }
    if (texto) {
      // Busca en los campos que la gente usa para describir a su mascota.
      params.push('%' + texto + '%');
      const p = '$' + params.length;
      q +=
        ` AND (lower(color) LIKE ${p} OR lower(coalesce(raza,'')) LIKE ${p}` +
        ` OR lower(coalesce(descripcion,'')) LIKE ${p} OR lower(coalesce(nombre_mascota,'')) LIKE ${p}` +
        ` OR lower(coalesce(collar,'')) LIKE ${p})`;
    }
    q += ' ORDER BY created_at DESC LIMIT 200';
    const result = await db.query(q, params);
    res.json({ reports: result.rows.map(r => publicReport(r, req.userId)) });
  } catch (err) {
    next(err);
  }
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
  } catch (err) {
    next(err);
  }
});

/* ---------- Mis avisos (con ubicación exacta y conteo de no leídos) ---------- */
router.get('/mine/all', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query('SELECT * FROM reports WHERE user_id = $1 ORDER BY created_at DESC', [
      req.userId
    ]);
    const counts = await db.query(
      'SELECT report_id, COUNT(*)::int AS n FROM messages WHERE recipient_user_id = $1 AND read = FALSE GROUP BY report_id',
      [req.userId]
    );
    const unreadById = Object.fromEntries(counts.rows.map(c => [c.report_id, c.n]));
    res.json({
      reports: result.rows.map(r => ({
        ...publicReport(r, req.userId),
        lat_exacto: r.lat,
        lng_exacto: r.lng,
        unread: unreadById[r.id] || 0
      }))
    });
  } catch (err) {
    next(err);
  }
});

/* ---------- Muro de reencuentros (público) ---------- */
// Avisos resueltos con su foto/nota del reencuentro. Da prueba social y
// motivación para seguir publicando.
/* ---------- Radio de búsqueda sugerido (público) ---------- */
// Devuelve la curva de radio por horas para dibujarla en el formulario de
// "Perdí", más el texto de sugerencia. Público: es información de ayuda, no
// hay nada privado aquí y así funciona incluso antes de iniciar sesión.
router.get('/busqueda', optionalAuth, infoLimiter, (req, res) => {
  const tipo = TIPOS_VALIDOS.includes(req.query.tipo) ? req.query.tipo : 'perro';
  const horas = Math.min(24 * 365, Math.max(0, parseInt(req.query.horas, 10) || 0));
  res.json({
    tipo,
    horas,
    sugerencia: sugerenciaBusqueda(tipo, horas),
    curva: curvaRadio(tipo, 72, 24),
    curvas: TIPOS_VALIDOS.reduce((acc, t) => {
      acc[t] = curvaRadio(t, 72, 24);
      return acc;
    }, {})
  });
});

router.get('/reunions', optionalAuth, infoLimiter, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, tipo, color, raza, estado, nombre_mascota, foto_url,
              reunion_foto_url, reunion_nota, resolved_at
         FROM reports
        WHERE resolved = TRUE AND active = TRUE
        ORDER BY resolved_at DESC NULLS LAST
        LIMIT 60`
    );
    const total = await db.query(
      'SELECT COUNT(*)::int AS n FROM reports WHERE resolved = TRUE AND active = TRUE'
    );
    res.json({
      total: total.rows[0].n,
      reunions: result.rows.map(r => ({
        id: r.id,
        tipo: r.tipo,
        color: r.color,
        raza: r.raza,
        estado: r.estado,
        nombre_mascota: r.nombre_mascota,
        foto_url: r.reunion_foto_url || r.foto_url || null,
        nota: r.reunion_nota || null,
        resolved_at: r.resolved_at ? Number(r.resolved_at) : null
      }))
    });
  } catch (err) {
    next(err);
  }
});

/* ---------- Cartel imprimible con QR ---------- */
// Página lista para imprimir (o guardar como PDF) con la foto, los datos y un
// QR que lleva directo al aviso. Pensada para pegar en el barrio.
function escHtml(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

router.get('/:id/poster', optionalAuth, param('id').isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).send('Identificador inválido.');

    const report = await findReport(req.params.id);
    if (!report) return res.status(404).send('Aviso no encontrado.');
    if (!report.active && report.user_id !== req.userId) return res.status(404).send('Aviso no encontrado.');

    const appUrl =
      (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, '') ||
      `${req.protocol}://${req.get('host')}`;
    const enlace = `${appUrl}/?r=${report.id}`;
    const qr = await QRCode.toDataURL(enlace, { margin: 1, width: 360 });
    const foto = report.foto_url
      ? /^https?:\/\//.test(report.foto_url)
        ? report.foto_url
        : appUrl + report.foto_url
      : null;

    const perdido = report.estado === 'perdido';
    const titulo = perdido ? 'SE BUSCA' : 'ENCONTRADO';
    const color = perdido ? '#D98A2B' : '#3F8361';
    const nombre = report.nombre_mascota || '';

    res.type('html').send(`<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cartel · Rastro</title>
<style>
  *{box-sizing:border-box;}
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f2efe7;color:#1B2A2F;padding:18px;}
  .hoja{max-width:640px;margin:0 auto;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 16px rgba(0,0,0,.14);}
  .cab{background:${color};color:#fff;text-align:center;padding:18px 16px;}
  .cab h1{margin:0;font-size:40px;letter-spacing:2px;}
  .cab p{margin:6px 0 0;font-size:15px;opacity:.95;}
  .cuerpo{padding:20px;}
  .foto{width:100%;max-height:420px;object-fit:cover;border-radius:12px;background:#e4ded0;display:block;}
  .sinfoto{width:100%;height:220px;border-radius:12px;background:#e4ded0;display:flex;align-items:center;justify-content:center;font-size:64px;}
  .datos{margin-top:16px;}
  .dato{display:flex;justify-content:space-between;gap:12px;padding:9px 0;border-bottom:1px solid #eee;font-size:16px;}
  .dato b{color:#41565B;font-weight:600;}
  .qr{display:flex;align-items:center;gap:16px;margin-top:18px;padding-top:16px;border-top:2px dashed #ddd;}
  .qr img{width:130px;height:130px;flex-shrink:0;}
  .qr div{font-size:14px;color:#41565B;line-height:1.5;}
  /* El enlace también en texto: si el QR sale borroso al imprimir, o quien lo
     lee no tiene cámara, tiene que poder escribir la dirección a mano. */
  .qr .enlace{margin-top:8px;font-size:12.5px;color:#6b7a7d;}
  .qr .enlace span{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;color:#1B2A2F;word-break:break-all;}
  .pie{margin-top:16px;font-size:13px;color:#6b7a7d;text-align:center;}
  .nota{max-width:640px;margin:12px auto 0;font-size:12.5px;color:#6b7a7d;text-align:center;}
  @media print{ body{background:#fff;padding:0;} .hoja{box-shadow:none;border-radius:0;max-width:100%;} .nota{display:none;} }
</style></head><body>
<div class="hoja">
  <div class="cab"><h1>${titulo}</h1><p>${nombre ? escHtml(nombre) + ' · ' : ''}Ayúdame a volver a casa 🐾</p></div>
  <div class="cuerpo">
    ${foto ? `<img class="foto" src="${escHtml(foto)}" alt="Foto">` : `<div class="sinfoto">🐾</div>`}
    <div class="datos">
      ${nombre ? `<div class="dato"><b>Nombre</b><span>${escHtml(nombre)}</span></div>` : ''}
      <div class="dato"><b>Tipo</b><span>${escHtml(report.tipo)}</span></div>
      <div class="dato"><b>Color</b><span>${escHtml(report.color)}</span></div>
      ${report.raza ? `<div class="dato"><b>Raza</b><span>${escHtml(report.raza)}</span></div>` : ''}
      ${report.sexo && report.sexo !== 'desconocido' ? `<div class="dato"><b>Sexo</b><span>${escHtml(report.sexo)}</span></div>` : ''}
      ${report.collar ? `<div class="dato"><b>Collar</b><span>${escHtml(report.collar)}</span></div>` : ''}
      ${report.descripcion ? `<div class="dato"><b>Descripción</b><span>${escHtml(report.descripcion)}</span></div>` : ''}
    </div>
    <div class="qr">
      <img src="${qr}" alt="Código QR">
      <div>
        <b>Escanea el código con la cámara del celular</b><br>
        Ahí puedes ver el aviso completo y escribirme dentro de la app, sin compartir mi teléfono ni mi correo.
        <div class="enlace">O escríbelo a mano:<br><span>${escHtml(enlace)}</span></div>
      </div>
    </div>
    <div class="pie">Publicado en Rastro · el contacto se hace dentro de la app</div>
  </div>
</div>
<p class="nota">Para guardarlo: usa Imprimir → "Guardar como PDF".</p>
</body></html>`);
  } catch (err) {
    next(err);
  }
});

/* ---------- Un aviso puntual (para los enlaces compartidos) ---------- */
// El listado público solo trae los 200 más recientes; sin esto, un enlace
// compartido a un aviso más antiguo no abría nada en el frontend.
router.get('/:id', optionalAuth, param('id').isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

    const report = await findReport(req.params.id);
    if (!report || !report.active || report.resolved)
      return res.status(404).json({ error: 'Aviso no encontrado.' });

    res.json({ report: publicReport(report, req.userId) });
  } catch (err) {
    next(err);
  }
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
    if (report.user_id !== req.userId)
      return res.status(403).json({ error: 'Solo puedes ver coincidencias de tus propios avisos.' });

    const opuesto = report.estado === 'perdido' ? 'encontrado' : 'perdido';
    const dLat = 5 / 111.32; // ~5 km
    const dLng = 5 / (111.32 * Math.max(0.1, Math.cos((report.lat * Math.PI) / 180)));
    const candidatos = await db.query(
      `SELECT * FROM reports
        WHERE estado = $1 AND tipo = $2 AND active = TRUE AND resolved = FALSE
          AND lat BETWEEN $3 AND $4 AND lng BETWEEN $5 AND $6
        LIMIT 100`,
      [opuesto, report.tipo, report.lat - dLat, report.lat + dLat, report.lng - dLng, report.lng + dLng]
    );

    const matches = candidatos.rows
      .map(c => ({ ...c, dist: haversine(report.lat, report.lng, c.lat, c.lng) }))
      .filter(
        c =>
          c.dist <= 5 &&
          (c.color.toLowerCase().includes(report.color.toLowerCase().split(' ')[0]) ||
            report.color.toLowerCase().includes(c.color.toLowerCase().split(' ')[0]))
      )
      .sort((a, b) => a.dist - b.dist)
      .map(c => ({ ...publicReport(c, req.userId), distancia_km: Math.round(c.dist * 10) / 10 }));

    res.json({ matches });
  } catch (err) {
    next(err);
  }
});

/* ---------- Hilo de conversación de un aviso ---------- */
// Solo pueden leer/escribir las dos partes: el dueño del aviso y quien le escribió.
function puedoParticipar(report, me, peer) {
  return report.user_id === me || report.user_id === peer;
}

router.get(
  '/:id/threads/:peerId',
  requireAuth,
  param('id').isUUID(),
  param('peerId').isUUID(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

      const report = await findReport(req.params.id);
      if (!report) return res.status(404).json({ error: 'Aviso no encontrado.' });

      const me = req.userId,
        peer = req.params.peerId;
      if (!puedoParticipar(report, me, peer))
        return res.status(403).json({ error: 'No tienes acceso a esta conversación.' });

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
        estado: report.estado,
        tipo: report.tipo,
        color: report.color,
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
    } catch (err) {
      next(err);
    }
  }
);

/* ---------- Contactar / responder (mensajería interna bidireccional) ---------- */
router.post(
  '/:id/messages',
  requireAuth,
  requireVerified,
  messageLimiter,
  param('id').isUUID(),
  body('mensaje').trim().isLength({ min: 1, max: 500 }),
  body('to_user_id').optional().isUUID(),
  body('lat').optional().isFloat({ min: -90, max: 90 }),
  body('lng').optional().isFloat({ min: -180, max: 180 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const mensajesHoy = await contarUltimas24h(
        'SELECT COUNT(*)::int AS n FROM messages WHERE sender_user_id = $1 AND created_at > $2',
        req.userId
      );
      if (mensajesHoy >= MENSAJES_POR_DIA)
        return res.status(429).json({ error: 'Enviaste demasiados mensajes hoy. Intenta mañana.' });

      const report = await findReport(req.params.id);
      if (!report || !report.active) return res.status(404).json({ error: 'Aviso no encontrado.' });

      const me = req.userId,
        owner = report.user_id;
      let recipient;

      if (me === owner) {
        // El dueño responde: debe indicar a cuál de las conversaciones.
        recipient = req.body.to_user_id;
        if (!recipient) return res.status(400).json({ error: 'Indica a quién le respondes.' });
        const exists = await db.query(
          'SELECT 1 FROM messages WHERE report_id = $1 AND sender_user_id = $2 AND recipient_user_id = $3 LIMIT 1',
          [report.id, recipient, me]
        );
        if (!exists.rows.length)
          return res
            .status(400)
            .json({ error: 'Ese usuario no ha iniciado una conversación sobre este aviso.' });
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
      push
        .sendToUser(recipient, {
          title: me === owner ? 'Respondieron tu aviso' : 'Nuevo mensaje en Rastro',
          body: req.body.mensaje.slice(0, 90),
          report_id: report.id,
          peer_id: me,
          tag: 'msg-' + report.id
        })
        .catch(() => {});

      res.status(201).json({ ok: true, message: 'Mensaje enviado.' });
    } catch (err) {
      next(err);
    }
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
    if (!report || report.user_id !== req.userId)
      return res.status(404).json({ error: 'Aviso no encontrado.' });

    const b = req.body;
    const val = (campo, actual) =>
      b[campo] === undefined ? actual : b[campo].trim() === '' ? null : b[campo].trim();
    let lat = report.lat,
      lng = report.lng,
      latPub = report.lat_public,
      lngPub = report.lng_public;
    if (b.lat !== undefined && b.lng !== undefined) {
      lat = parseFloat(b.lat);
      lng = parseFloat(b.lng);
      const pub = jitter(lat, lng);
      latPub = pub.lat;
      lngPub = pub.lng;
    }

    await db.query(
      `UPDATE reports SET tipo=$1, sexo=$2, color=$3, raza=$4, collar=$5, descripcion=$6,
              nombre_mascota=$7, lat=$8, lng=$9, lat_public=$10, lng_public=$11
        WHERE id=$12`,
      [
        val('tipo', report.tipo),
        val('sexo', report.sexo),
        val('color', report.color) || report.color,
        val('raza', report.raza),
        val('collar', report.collar),
        val('descripcion', report.descripcion),
        val('nombre_mascota', report.nombre_mascota),
        lat,
        lng,
        latPub,
        lngPub,
        report.id
      ]
    );

    const updated = await findReport(report.id);
    res.json({ report: publicReport(updated, req.userId) });
  } catch (err) {
    next(err);
  }
});

/* ---------- Marcar el reencuentro (con foto y nota opcionales) ---------- */
// Es la forma "buena" de resolver: además de sacar el aviso del mapa, permite
// subir una foto del reencuentro y una nota corta para el muro público.
router.post(
  '/:id/reunion',
  requireAuth,
  param('id').isUUID(),
  upload.single('foto'),
  body('nota').optional().trim().isLength({ max: 500 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const report = await findReport(req.params.id);
      if (!report || report.user_id !== req.userId)
        return res.status(404).json({ error: 'Aviso no encontrado.' });

      let reunionFoto = report.reunion_foto_url;
      let fotoNueva = null;
      if (req.file) {
        const tipoReal = tipoImagenReal(req.file.buffer);
        if (!tipoReal) return res.status(400).json({ error: 'El archivo no es una imagen válida.' });
        // Guardar SIEMPRE antes de borrar: si esto falla, la foto anterior (la
        // que la base sigue referenciando) tiene que seguir viva. Antes se
        // borraba primero, así que un fallo del almacenamiento dejaba el
        // reencuentro anterior perdido y sin foto nueva.
        fotoNueva = await storage.savePhoto(req.file.buffer, tipoReal);
        reunionFoto = fotoNueva;
      }

      await db.query(
        'UPDATE reports SET resolved = TRUE, resolved_at = $1, reunion_foto_url = $2, reunion_nota = $3 WHERE id = $4',
        [Date.now(), reunionFoto || null, req.body.nota || null, report.id]
      );
      // La anterior solo se borra cuando la base ya aceptó el cambio: si el
      // UPDATE falla, la fila sigue apuntando a la foto vieja y hay que
      // conservarla (la nueva quedaría huérfana, que es menos grave).
      if (fotoNueva && report.reunion_foto_url) await storage.deletePhoto(report.reunion_foto_url);
      const updated = await findReport(report.id);
      res.json({ report: publicReport(updated, req.userId) });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------- Marcar como resuelto / reabrir ---------- */
router.post(
  '/:id/resolve',
  requireAuth,
  param('id').isUUID(),
  body('resolved').isBoolean(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Dato inválido.' });

      const report = await findReport(req.params.id);
      if (!report || report.user_id !== req.userId)
        return res.status(404).json({ error: 'Aviso no encontrado.' });

      const resolved = req.body.resolved === true;
      await db.query('UPDATE reports SET resolved = $1, resolved_at = $2 WHERE id = $3', [
        resolved,
        resolved ? Date.now() : null,
        report.id
      ]);

      res.json({ ok: true, resolved });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------- Reportar un aviso inapropiado ---------- */
// Para evitar que cuentas nuevas oculten avisos ajenos: se exige una cuenta con
// al menos 24 h, un límite diario, y hacen falta 5 reportes de 5 cuentas distintas.
router.post(
  '/:id/flag',
  requireAuth,
  requireVerified,
  flagLimiter,
  param('id').isUUID(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

      const report = await findReport(req.params.id);
      if (!report || !report.active) return res.status(404).json({ error: 'Aviso no encontrado.' });
      if (report.user_id === req.userId)
        return res.status(400).json({ error: 'No puedes reportar tu propio aviso.' });

      const user = (await db.query('SELECT created_at FROM users WHERE id = $1', [req.userId])).rows[0];
      if (!user || Number(user.created_at) > Date.now() - CUENTA_MINIMA_PARA_REPORTAR) {
        return res.status(403).json({ error: 'Tu cuenta es demasiado nueva para reportar avisos.' });
      }
      const flagsHoy = await contarUltimas24h(
        'SELECT COUNT(*)::int AS n FROM report_flags WHERE user_id = $1 AND created_at > $2',
        req.userId
      );
      if (flagsHoy >= FLAGS_POR_DIA)
        return res.status(429).json({ error: 'Reportaste demasiados avisos hoy.' });

      const inserted = await db.query(
        'INSERT INTO report_flags (report_id, user_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING report_id',
        [report.id, req.userId, Date.now()]
      );

      if (inserted.rows.length) {
        const upd = await db.query('UPDATE reports SET flags = flags + 1 WHERE id = $1 RETURNING flags', [
          report.id
        ]);
        if (upd.rows[0].flags >= FLAGS_PARA_OCULTAR) {
          await db.query('UPDATE reports SET active = FALSE WHERE id = $1', [report.id]);
        }
      }

      res.json({ ok: true, message: 'Gracias, revisaremos este aviso.' });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------- Eliminar (dar de baja) un aviso propio ---------- */
router.delete('/:id', requireAuth, param('id').isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

    const report = await findReport(req.params.id);
    if (!report || report.user_id !== req.userId)
      return res.status(404).json({ error: 'Aviso no encontrado.' });
    // Con el id de la fila, igual que PATCH /:id: el texto de la URL puede venir
    // con otro formato (mayúsculas) y findReport ya devolvió el id real.
    await db.query('UPDATE reports SET active = FALSE WHERE id = $1', [report.id]);
    await storage.deletePhoto(report.foto_url);
    if (report.reunion_foto_url) await storage.deletePhoto(report.reunion_foto_url);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
