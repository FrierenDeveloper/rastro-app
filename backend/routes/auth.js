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
const { keyPorIp, keyPorCuenta, normalizarCuenta } = require('../middleware/client-ip');
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

// Segundo cupo, atado SOLO al correo (sin IP): 10 intentos por cuenta cada
// 15 minutos, vengan de donde vengan. Así la fuerza bruta distribuida contra
// una misma cuenta choca con el límite aunque rote IPs o X-Forwarded-For.
//
// El correo se normaliza ANTES de contar el intento, con el mismo
// normalizeEmail() del login, para que variantes como "Foo.Bar+1@Gmail.com"
// no abran un cupo nuevo.
const cuentaLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: numEnv('LIMITE_CUENTA_15MIN', 10),
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: keyPorCuenta,
  message: { error: 'Demasiados intentos para esta cuenta. Espera unos minutos.' }
});

const normalizarCorreo = body('email').normalizeEmail();

// Correos con permiso de administrador (variable ADMIN_EMAILS, separados por coma).
const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);
function esAdmin(email) {
  return ADMIN_EMAILS.includes(String(email || '').toLowerCase());
}

/* ---------- Captcha liviano (sin servicios externos) ---------- */
// Firma un reto con el JWT_SECRET y exige que pase un tiempo mínimo antes de
// enviarlo. No pretende ser un captcha fuerte: junto al honeypot y al rate
// limiting corta el spam automatizado masivo sin depender de servicios de pago.
const retosUsados = new Map();
function firmaReto(payload) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('hex').slice(0, 32);
}
function crearReto() {
  const payload = Date.now() + '.' + crypto.randomBytes(8).toString('hex');
  return payload + '.' + firmaReto(payload);
}
function validarReto(reto) {
  if (typeof reto !== 'string' || reto.length > 200) return false;
  const i = reto.lastIndexOf('.');
  if (i < 0) return false;
  const payload = reto.slice(0, i),
    sig = reto.slice(i + 1);
  const esperado = firmaReto(payload);
  if (sig.length !== esperado.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperado))) return false;
  const ts = Number(payload.split('.')[0]);
  if (!Number.isFinite(ts)) return false;
  const edad = Date.now() - ts;
  if (edad < 1500 || edad > 30 * 60 * 1000) return false; // demasiado rápido = bot / caducado
  if (retosUsados.has(reto)) return false; // un reto solo sirve una vez
  retosUsados.set(reto, Date.now() + 30 * 60 * 1000);
  if (retosUsados.size > 5000) {
    const ahora = Date.now();
    for (const [k, v] of retosUsados) if (v < ahora) retosUsados.delete(k);
  }
  return true;
}
router.get('/challenge', authLimiter, (req, res) => res.json({ challenge: crearReto() }));

// Middleware para las rutas sensibles a bots (registro).
function verificarHumano(req, res, next) {
  // Honeypot: campo oculto que solo rellenan los bots.
  if (typeof req.body.website === 'string' && req.body.website.trim()) {
    return res.status(400).json({ error: 'No se pudo validar el formulario.' });
  }
  if (!validarReto(req.body.captcha)) {
    return res
      .status(400)
      .json({ error: 'La verificación anti-spam falló. Recarga la página e inténtalo de nuevo.' });
  }
  next();
}

function signToken(userId, version = 0) {
  return jwt.sign({ sub: userId, ver: version || 0 }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// Base para los enlaces que se mandan por correo (recuperar contraseña).
// NUNCA se arma con el Host de la petición salvo en desarrollo: esa cabecera
// la controla quien llama, y si el enlace de recuperación sale apuntando a un
// dominio ajeno, el token de reseteo se filtra a un tercero.
//
// Orden de preferencia:
//   1. APP_URL (lo que configure el operador; sigue mandando).
//   2. RENDER_EXTERNAL_URL: Render la inyecta sola con la URL pública del
//      servicio y NO la controla quien hace la petición, así que es un
//      respaldo seguro que evita tener que configurar APP_URL a mano.
function baseUrl(req) {
  const configurada = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || '').trim();
  if (configurada) return configurada.replace(/\/+$/, '');
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Falta APP_URL (o RENDER_EXTERNAL_URL) en el entorno: sin ella no se puede armar un enlace de recuperación seguro.'
    );
  }
  return `${req.protocol}://${req.get('host')}`;
}

function hashResetToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Manda el correo de confirmación (solo útil si hay proveedor configurado).
async function enviarVerificacion(userId, email, req) {
  const link = `${baseUrl(req)}/?verify=`;
  const rawToken = crypto.randomBytes(32).toString('hex');
  await db.query('UPDATE email_verifications SET used = TRUE WHERE user_id = $1 AND used = FALSE', [userId]);
  await db.query(
    'INSERT INTO email_verifications (token, user_id, expires_at, used, created_at) VALUES ($1,$2,$3,FALSE,$4)',
    [hashResetToken(rawToken), userId, Date.now() + 24 * 60 * 60 * 1000, Date.now()]
  );
  try {
    await mailer.sendMail({
      to: email,
      subject: 'Confirma tu correo en Rastro',
      text: `Confirma tu correo para poder publicar avisos en Rastro:\n${link}${rawToken}\n\nEl enlace vence en 24 horas. Si no creaste esta cuenta, ignora este correo.`
    });
  } catch (e) {
    console.error('No se pudo enviar el correo de verificación:', e.message);
  }
}

router.post(
  '/register',
  authLimiter,
  normalizarCorreo,
  cuentaLimiter,
  verificarHumano,
  body('email').isEmail().normalizeEmail().withMessage('Correo inválido.'),
  body('password').isLength({ min: 10 }).withMessage('La contraseña debe tener al menos 10 caracteres.'),
  body('phone').optional().trim().isLength({ max: 40 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const { email, password, phone } = req.body;
      // normalizeEmail() solo quita el "+alias" en Gmail/Outlook/Yahoo; en el
      // resto de dominios "a@x.com" y "a+loquesea@x.com" llegan al MISMO buzón
      // pero se guardaban como cuentas distintas. Eso permitía crear identidades
      // ilimitadas (y con ellas reportes/flags) con un solo correo real.
      const cuenta = normalizarCuenta(email);
      const existing = await db.query(
        `SELECT id FROM users WHERE email = $1 OR normalizar_correo(email) = $2`,
        [email, cuenta]
      );
      if (existing.rows.length)
        return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

      const id = uuidv4();
      const hash = await bcrypt.hash(password, 12);
      // Sin proveedor de correo configurado no podemos verificar a nadie: en ese
      // caso la cuenta nace verificada para no dejar a la gente sin poder publicar.
      const verificado = !mailer.usingEmail;
      // ON CONFLICT evita un 500 si dos registros con el mismo correo entran a la
      // vez. El índice único sobre normalizar_correo() cubre además el caso del
      // "+alias": si salta, lo tratamos igual que un correo repetido.
      let inserted;
      try {
        inserted = await db.query(
          `INSERT INTO users (id, email, password_hash, phone, email_verified, created_at)
           VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (email) DO NOTHING
           RETURNING id`,
          [id, email, hash, phone || null, verificado, Date.now()]
        );
      } catch (e) {
        if (e && e.code === '23505')
          return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
        throw e;
      }
      if (!inserted.rows.length)
        return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });

      if (!verificado) await enviarVerificacion(id, email, req);

      res.status(201).json({
        token: signToken(id, 0),
        user: { id, email, phone: phone || null, email_verified: verificado }
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/login',
  authLimiter,
  normalizarCorreo,
  cuentaLimiter,
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Correo o contraseña inválidos.' });

      const { email, password } = req.body;
      // Se busca por correo exacto o comparando AMBOS lados en su forma
      // normalizada. Es importante normalizar también el texto que escribió el
      // usuario: si solo se normalizara el guardado, alguien que se registró con
      // "a+etiqueta@x.com" no podría entrar escribiendo "a@x.com".
      const result = await db.query(
        `SELECT * FROM users
          WHERE email = $1 OR normalizar_correo(email) = $2
          ORDER BY (email = $1) DESC
          LIMIT 1`,
        [email, normalizarCuenta(email)]
      );
      const user = result.rows[0];
      if (!user || !(await bcrypt.compare(password, user.password_hash))) {
        return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
      }
      res.json({
        token: signToken(user.id, user.token_version),
        user: { id: user.id, email: user.email, phone: user.phone }
      });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------- Recuperar contraseña ---------- */
// Responde siempre lo mismo exista o no la cuenta (evita revelar qué correos
// están registrados).
router.post(
  '/forgot',
  authLimiter,
  normalizarCorreo,
  cuentaLimiter,
  body('email').isEmail().normalizeEmail(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Correo inválido.' });

      const result = await db.query(
        `SELECT id, email FROM users
          WHERE email = $1 OR normalizar_correo(email) = $2
          ORDER BY (email = $1) DESC LIMIT 1`,
        [req.body.email, normalizarCuenta(req.body.email)]
      );
      const user = result.rows[0];

      if (user) {
        // El enlace se arma ANTES de guardar nada: si falta APP_URL en
        // producción, preferimos fallar entero antes que emitir un token de
        // reseteo dentro de un enlace que apunte a un dominio ajeno.
        let link;
        try {
          link = `${baseUrl(req)}/?reset=`;
        } catch (e) {
          console.error('[auth/forgot]', e.message);
          return res
            .status(503)
            .json({ error: 'La recuperación por correo no está configurada en este servidor.' });
        }

        // En el enlace va el token en claro; en la base se guarda solo su hash.
        const rawToken = crypto.randomBytes(32).toString('hex');
        await db.query('UPDATE password_resets SET used = TRUE WHERE user_id = $1 AND used = FALSE', [
          user.id
        ]);
        await db.query(
          'INSERT INTO password_resets (token, user_id, expires_at, used, created_at) VALUES ($1,$2,$3,FALSE,$4)',
          [hashResetToken(rawToken), user.id, Date.now() + 60 * 60 * 1000, Date.now()]
        );
        try {
          await mailer.sendMail({
            to: user.email,
            subject: 'Recuperar tu contraseña de Rastro',
            text: `Para elegir una contraseña nueva entra a: ${link}${rawToken}\n\nEl enlace vence en 1 hora. Si no lo pediste, ignora este correo.`
          });
        } catch (e) {
          console.error('No se pudo enviar el correo de recuperación:', e.message);
        }
      }

      res.json({
        ok: true,
        message: 'Si el correo existe, te enviamos un enlace para restablecer la contraseña.'
      });
    } catch (err) {
      next(err);
    }
  }
);

router.post(
  '/reset',
  authLimiter,
  cuentaLimiter,
  body('token').isString().isLength({ min: 32, max: 128 }),
  body('password').isLength({ min: 10 }).withMessage('La contraseña debe tener al menos 10 caracteres.'),
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
      await db.query('UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2', [
        hash,
        reset.user_id
      ]);
      await db.query('UPDATE password_resets SET used = TRUE WHERE token = $1', [tokenHash]);

      res.json({ ok: true, message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------- Iniciar sesión con Google (opcional) ---------- */
// Solo funciona si configuras GOOGLE_CLIENT_ID en el .env. Verifica el token
// directamente contra Google (no necesita dependencias extra).
router.post(
  '/google',
  authLimiter,
  cuentaLimiter,
  body('credential').isString().notEmpty(),
  async (req, res, next) => {
    try {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId)
        return res.status(503).json({ error: 'El inicio de sesión con Google no está configurado.' });

      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Credencial inválida.' });

      const infoRes = await fetch(
        'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(req.body.credential)
      );
      if (!infoRes.ok) return res.status(401).json({ error: 'No se pudo verificar la cuenta de Google.' });
      const info = await infoRes.json();
      if (info.aud !== clientId) return res.status(401).json({ error: 'Credencial de Google inválida.' });
      if (String(info.email_verified) !== 'true')
        return res.status(401).json({ error: 'Tu correo de Google no está verificado.' });

      const email = info.email.toLowerCase();
      // Igual que en el login: el correo de Google puede llegar con "+alias" y
      // debe encontrar la cuenta que ya existe para ese buzón.
      const buscarUsuario = () =>
        db.query(
          `SELECT * FROM users
          WHERE email = $1 OR normalizar_correo(email) = $2
          ORDER BY (email = $1) DESC LIMIT 1`,
          [email, normalizarCuenta(email)]
        );
      let user = (await buscarUsuario()).rows[0];

      if (!user) {
        const id = uuidv4();
        // Contraseña aleatoria: esta cuenta se usa solo vía Google.
        const hash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
        let inserted;
        try {
          inserted = await db.query(
            `INSERT INTO users (id, email, password_hash, phone, google_sub, email_verified, created_at)
             VALUES ($1,$2,$3,NULL,$4,TRUE,$5)
             ON CONFLICT (email) DO NOTHING
             RETURNING id`,
            [id, email, hash, info.sub || null, Date.now()]
          );
        } catch (e) {
          if (!e || e.code !== '23505') throw e;
          inserted = { rows: [] };
        }
        user = inserted.rows.length
          ? { id, email, phone: null, token_version: 0 }
          : (await buscarUsuario()).rows[0];
      } else if (!user.google_sub && info.sub) {
        await db.query('UPDATE users SET google_sub = $1 WHERE id = $2', [info.sub, user.id]);
      }

      res.json({
        token: signToken(user.id, user.token_version),
        user: { id: user.id, email: user.email, phone: user.phone || null }
      });
    } catch (err) {
      next(err);
    }
  }
);

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, email, phone, created_at, email_verified FROM users WHERE id = $1',
      [req.userId]
    );
    const u = result.rows[0];
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado.' });
    res.json({ user: { ...u, is_admin: esAdmin(u.email) } });
  } catch (err) {
    next(err);
  }
});

/* ---------- Confirmar correo ---------- */
// El enlace del correo apunta aquí; al terminar devuelve a la app.
router.get('/verify', async (req, res, next) => {
  try {
    const raw = typeof req.query.token === 'string' ? req.query.token : '';
    if (!raw) return res.redirect('/?verified=0');
    const tokenHash = hashResetToken(raw);
    const result = await db.query('SELECT * FROM email_verifications WHERE token = $1', [tokenHash]);
    const v = result.rows[0];
    if (!v || v.used || Number(v.expires_at) < Date.now()) return res.redirect('/?verified=0');
    await db.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [v.user_id]);
    await db.query('UPDATE email_verifications SET used = TRUE WHERE token = $1', [tokenHash]);
    res.redirect('/?verified=1');
  } catch (err) {
    next(err);
  }
});

// Reenviar el correo de confirmación (desde la app).
router.post('/resend-verification', requireAuth, authLimiter, async (req, res, next) => {
  try {
    const u = (await db.query('SELECT id, email, email_verified FROM users WHERE id = $1', [req.userId]))
      .rows[0];
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado.' });
    if (u.email_verified) return res.json({ ok: true, message: 'Tu correo ya está confirmado.' });
    if (!mailer.usingEmail) {
      await db.query('UPDATE users SET email_verified = TRUE WHERE id = $1', [u.id]);
      return res.json({ ok: true, message: 'Correo confirmado.' });
    }
    await enviarVerificacion(u.id, u.email, req);
    res.json({ ok: true, message: 'Te enviamos un correo de confirmación.' });
  } catch (err) {
    next(err);
  }
});

// Requisito de Google Play: el usuario debe poder eliminar su cuenta y sus datos.
router.delete('/me', requireAuth, async (req, res, next) => {
  try {
    const reports = await db.query('SELECT foto_url, reunion_foto_url FROM reports WHERE user_id = $1', [
      req.userId
    ]);
    await Promise.all(
      reports.rows.flatMap(r => [storage.deletePhoto(r.foto_url), storage.deletePhoto(r.reunion_foto_url)])
    );
    await db.query('DELETE FROM users WHERE id = $1', [req.userId]); // ON DELETE CASCADE limpia el resto
    res.json({ ok: true, message: 'Cuenta y datos asociados eliminados.' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
