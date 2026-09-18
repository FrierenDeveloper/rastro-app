const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const storage = require('../storage');
const mailer = require('../mailer');
const { requireAuth } = require('../middleware/auth');
const { keyPorIp, keyPorIpYCuenta } = require('../middleware/client-ip');
const { numEnv } = require('../middleware/limits');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: numEnv('LIMITE_AUTH_15MIN', 20),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyPorIp,
  message: { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' }
});

// Segundo cupo, atado al correo: evita que alguien pruebe contraseñas de una
// misma cuenta repartiendo los intentos entre muchas IPs (fuerza bruta
// distribuida). Es más estricto que el anterior, así que va después.
const cuentaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: numEnv('LIMITE_CUENTA_15MIN', 10),
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: keyPorIpYCuenta,
  message: { error: 'Demasiados intentos para esta cuenta. Espera unos minutos.' }
});

function signToken(userId, version = 0) {
  return jwt.sign({ sub: userId, ver: version || 0 }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

function baseUrl(req) {
  return process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
}

function hashResetToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

router.post('/register',
  authLimiter,
  cuentaLimiter,
  body('email').isEmail().normalizeEmail().withMessage('Correo inválido.'),
  body('password').isLength({ min: 8 }).withMessage('La contraseña debe tener al menos 8 caracteres.'),
  body('phone').optional().trim().isLength({ max: 40 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const { email, password, phone } = req.body;
      const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
      if (existing.rows.length) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

      const id = uuidv4();
      const hash = await bcrypt.hash(password, 12);
      // ON CONFLICT evita un 500 si dos registros con el mismo correo entran a la vez.
      const inserted = await db.query(
        `INSERT INTO users (id, email, password_hash, phone, created_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (email) DO NOTHING
         RETURNING id`,
        [id, email, hash, phone || null, Date.now()]
      );
      if (!inserted.rows.length) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

      res.status(201).json({ token: signToken(id, 0), user: { id, email, phone: phone || null } });
    } catch (err) { next(err); }
  }
);

router.post('/login',
  authLimiter,
  cuentaLimiter,
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Correo o contraseña inválidos.' });

      const { email, password } = req.body;
      const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
      const user = result.rows[0];
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
      }
      res.json({ token: signToken(user.id, user.token_version), user: { id: user.id, email: user.email, phone: user.phone } });
    } catch (err) { next(err); }
  }
);

/* ---------- Recuperar contraseña ---------- */
// Responde siempre lo mismo exista o no la cuenta (evita revelar qué correos
// están registrados).
router.post('/forgot',
  authLimiter,
  cuentaLimiter,
  body('email').isEmail().normalizeEmail(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Correo inválido.' });

      const result = await db.query('SELECT id, email FROM users WHERE email = $1', [req.body.email]);
      const user = result.rows[0];

      if (user) {
        // En el enlace va el token en claro; en la base se guarda solo su hash.
        const rawToken = crypto.randomBytes(32).toString('hex');
        await db.query('UPDATE password_resets SET used = TRUE WHERE user_id = $1 AND used = FALSE', [user.id]);
        await db.query(
          'INSERT INTO password_resets (token, user_id, expires_at, used, created_at) VALUES ($1,$2,$3,FALSE,$4)',
          [hashResetToken(rawToken), user.id, Date.now() + 60 * 60 * 1000, Date.now()]
        );
        const link = `${baseUrl(req)}/?reset=${rawToken}`;
        try {
          await mailer.sendMail({
            to: user.email,
            subject: 'Recuperar tu contraseña de Rastro',
            text: `Para elegir una contraseña nueva entra a: ${link}\n\nEl enlace vence en 1 hora. Si no lo pediste, ignora este correo.`
          });
        } catch (e) {
          console.error('No se pudo enviar el correo de recuperación:', e.message);
        }
      }

      res.json({ ok: true, message: 'Si el correo existe, te enviamos un enlace para restablecer la contraseña.' });
    } catch (err) { next(err); }
  }
);

router.post('/reset',
  authLimiter,
  cuentaLimiter,
  body('token').isString().isLength({ min: 32, max: 128 }),
  body('password').isLength({ min: 8 }).withMessage('La contraseña debe tener al menos 8 caracteres.'),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const tokenHash = hashResetToken(req.body.token);
      const result = await db.query('SELECT * FROM password_resets WHERE token = $1', [tokenHash]);
      const reset = result.rows[0];
      if (!reset || reset.used || Number(reset.expires_at) < Date.now()) {
        return res.status(400).json({ error: 'El enlace es inválido o ya venció. Pide uno nuevo.' });
      }

      const hash = await bcrypt.hash(req.body.password, 12);
      // Subir token_version revoca todas las sesiones abiertas de esa cuenta.
      await db.query('UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2', [hash, reset.user_id]);
      await db.query('UPDATE password_resets SET used = TRUE WHERE token = $1', [tokenHash]);

      res.json({ ok: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
    } catch (err) { next(err); }
  }
);

/* ---------- Iniciar sesión con Google (opcional) ---------- */
// Solo funciona si configuras GOOGLE_CLIENT_ID en el .env. Verifica el token
// directamente contra Google (no necesita dependencias extra).
router.post('/google',
  authLimiter,
  cuentaLimiter,
  body('credential').isString().notEmpty(),
  async (req, res, next) => {
    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) return res.status(503).json({ error: 'El inicio de sesión con Google no está configurado.' });

      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Credencial inválida.' });

      const infoRes = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(req.body.credential));
      if (!infoRes.ok) return res.status(401).json({ error: 'No se pudo verificar la cuenta de Google.' });
      const info = await infoRes.json();
      if (info.aud !== clientId) return res.status(401).json({ error: 'Credencial de Google inválida.' });
      if (String(info.email_verified) !== 'true') return res.status(401).json({ error: 'Tu correo de Google no está verificado.' });

      const email = info.email.toLowerCase();
      let user = (await db.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];

      if (!user) {
        const id = uuidv4();
        // Contraseña aleatoria: esta cuenta se usa solo vía Google.
        const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
        const inserted = await db.query(
          `INSERT INTO users (id, email, password_hash, phone, google_sub, created_at)
           VALUES ($1,$2,$3,NULL,$4,$5)
           ON CONFLICT (email) DO NOTHING
           RETURNING id`,
          [id, email, hash, info.sub || null, Date.now()]
        );
        user = inserted.rows.length
          ? { id, email, phone: null, token_version: 0 }
          : (await db.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];
      } else if (!user.google_sub && info.sub) {
        await db.query('UPDATE users SET google_sub = $1 WHERE id = $2', [info.sub, user.id]);
      }

      res.json({ token: signToken(user.id, user.token_version), user: { id: user.id, email: user.email, phone: user.phone || null } });
    } catch (err) { next(err); }
  }
);

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query('SELECT id, email, phone, created_at FROM users WHERE id = $1', [req.userId]);
    if (!result.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado.' });
    res.json({ user: result.rows[0] });
  } catch (err) { next(err); }
});

// Requisito de Google Play: el usuario debe poder eliminar su cuenta y sus datos.
router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    const reports = await db.query('SELECT foto_url FROM reports WHERE user_id = $1', [req.userId]);
    await Promise.all(reports.rows.map(r => storage.deletePhoto(r.foto_url)));
    await db.query('DELETE FROM users WHERE id = $1', [req.userId]); // ON DELETE CASCADE limpia el resto
    res.json({ ok: true, message: 'Cuenta y datos asociados eliminados.' });
  } catch (err) { next(err); }
});

module.exports = router;
