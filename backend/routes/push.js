const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const push = require('../push');
const { requireAuth } = require('../middleware/auth');
const { validarEndpoint } = require('../src/v2/push-endpoint');

const router = express.Router();

// El frontend consulta esto para saber si el push está activo y con qué clave.
router.get('/public-key', (req, res) => {
  res.json({ enabled: push.enabled, publicKey: push.publicKey || '' });
});

router.post(
  '/subscribe',
  requireAuth,
  body('endpoint').isString().isLength({ min: 1, max: 2000 }),
  body('keys.p256dh').isString().isLength({ min: 1, max: 500 }),
  body('keys.auth').isString().isLength({ min: 1, max: 500 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Suscripción inválida.' });

      const { endpoint, keys } = req.body;
      // El endpoint lo elige quien se suscribe y el servidor hace una petición
      // HTTPS SALIENTE contra él: sin validar sirve de proxy ciego hacia la red
      // interna (SSRF) y de amplificador. Se valida antes de guardarlo.
      const motivo = validarEndpoint(endpoint);
      if (motivo) return res.status(400).json({ error: motivo });

      await db.query(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (endpoint) DO UPDATE
           SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
        [uuidv4(), req.userId, endpoint, keys.p256dh, keys.auth, Date.now()]
      );
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/unsubscribe',
  requireAuth,
  body('endpoint').isString().isLength({ min: 1, max: 2000 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos.' });
      await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [
        req.body.endpoint,
        req.userId
      ]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------- Alertas por zona ---------- */
// El usuario guarda un punto (su barrio) y recibe avisos de mascotas perdidas
// cerca. El radio lo decide el servidor según el tiempo que lleve perdida.
//
// Hay dos formas de tener zona:
//   * 'manual': la fijó el usuario a propósito -> manda siempre y no caduca.
//   * 'auto':   la guarda la app al abrirse con la última ubicación conocida
//               (ya difuminada en el cliente) -> se refresca al abrir y caduca
//               a los 30 días sin abrir (ver ubicacion.js).
router.get('/zone', requireAuth, async (req, res, next) => {
  try {
    const r = await db.query('SELECT lat, lng, origen, updated_at FROM zone_alerts WHERE user_id = $1', [
      req.userId
    ]);
    if (!r.rows[0]) return res.json({ zone: null });
    const z = r.rows[0];
    res.json({
      zone: {
        lat: Number(z.lat),
        lng: Number(z.lng),
        // Una fila anterior a la migración no tiene origen: era una zona que el
        // usuario declaró a mano, así que se trata como tal.
        origen: z.origen || 'manual',
        updated_at: z.updated_at === null || z.updated_at === undefined ? null : Number(z.updated_at)
      }
    });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/zone',
  requireAuth,
  body('lat').isFloat({ min: -90, max: 90 }),
  body('lng').isFloat({ min: -180, max: 180 }),
  body('origen').optional().isIn(['auto', 'manual']),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Ubicación inválida.' });
      const origen = req.body.origen === 'auto' ? 'auto' : 'manual';
      const ahora = Date.now();
      // El WHERE del UPSERT es la regla de precedencia: una ubicación automática
      // no pisa la zona que el usuario fijó a mano, pero todo lo que él manda a
      // mano se guarda (aunque ya hubiera una automática).
      await db.query(
        `INSERT INTO zone_alerts (user_id, lat, lng, created_at, updated_at, origen)
         VALUES ($1,$2,$3,$4,$4,$5)
         ON CONFLICT (user_id) DO UPDATE
           SET lat = EXCLUDED.lat, lng = EXCLUDED.lng,
               updated_at = EXCLUDED.updated_at, origen = EXCLUDED.origen
           WHERE zone_alerts.origen <> 'manual' OR EXCLUDED.origen = 'manual'`,
        [req.userId, parseFloat(req.body.lat), parseFloat(req.body.lng), ahora, origen]
      );
      res.status(201).json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

router.delete('/zone', requireAuth, async (req, res, next) => {
  try {
    await db.query('DELETE FROM zone_alerts WHERE user_id = $1', [req.userId]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
