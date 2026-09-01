const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' }
});

function signToken(userId) {
  return jwt.sign({ sub: userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

router.post('/register',
  authLimiter,
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
      const hash = bcrypt.hashSync(password, 12);
      await db.query(
        'INSERT INTO users (id, email, password_hash, phone, created_at) VALUES ($1,$2,$3,$4,$5)',
        [id, email, hash, phone || null, Date.now()]
      );

      const token = signToken(id);
      res.status(201).json({ token, user: { id, email, phone: phone || null } });
    } catch (err) { next(err); }
  }
);

router.post('/login',
  authLimiter,
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Correo o contraseña inválidos.' });

      const { email, password } = req.body;
      const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);
      const user = result.rows[0];
      if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
      }
      const token = signToken(user.id);
      res.json({ token, user: { id: user.id, email: user.email, phone: user.phone } });
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
    await db.query('DELETE FROM users WHERE id = $1', [req.userId]); // ON DELETE CASCADE limpia reports y messages
    res.json({ ok: true, message: 'Cuenta y datos asociados eliminados.' });
  } catch (err) { next(err); }
});

module.exports = router;
