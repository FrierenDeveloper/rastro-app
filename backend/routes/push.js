const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const db = require('../db');
const push = require('../push');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// El frontend consulta esto para saber si el push está activo y con qué clave.
router.get('/public-key', (req, res) => {
  res.json({ enabled: push.enabled, publicKey: push.publicKey || '' });
});

router.post('/subscribe', requireAuth,
  body('endpoint').isString().isLength({ min: 1, max: 2000 }),
  body('keys.p256dh').isString().isLength({ min: 1, max: 500 }),
  body('keys.auth').isString().isLength({ min: 1, max: 500 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Suscripción inválida.' });

      const { endpoint, keys } = req.body;
      await db.query(
        `INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (endpoint) DO UPDATE
           SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
        [uuidv4(), req.userId, endpoint, keys.p256dh, keys.auth, Date.now()]
      );
      res.status(201).json({ ok: true });
    } catch (err) { next(err); }
  }
);

router.post('/unsubscribe', requireAuth,
  body('endpoint').isString().isLength({ min: 1, max: 2000 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Datos inválidos.' });
      await db.query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [req.body.endpoint, req.userId]);
      res.json({ ok: true });
    } catch (err) { next(err); }
  }
);

module.exports = router;
