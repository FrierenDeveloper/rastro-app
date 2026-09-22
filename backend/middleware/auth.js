const jwt = require('jsonwebtoken');
const db = require('../db');

// Verifica el JWT y, además, que la cuenta siga existiendo y que la sesión no
// haya sido revocada (token_version). Así el token de una cuenta eliminada o
// cuya contraseña cambió deja de servir de inmediato.
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado.' });

  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Sesión inválida o expirada.' });
  }

  try {
    const result = await db.query('SELECT token_version FROM users WHERE id = $1', [payload.sub]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Sesión inválida o expirada.' });
    if ((payload.ver || 0) !== user.token_version) {
      return res.status(401).json({ error: 'Tu sesión fue cerrada. Inicia sesión de nuevo.' });
    }
    req.userId = payload.sub;
    next();
  } catch (err) {
    next(err);
  }
}

// No bloquea la request si no hay token, pero lo decodifica si existe.
// Se usa en endpoints públicos para saber si el aviso es del usuario actual.
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (token) {
    try {
      const payload = jwt.verify(token, process.env.JWT_SECRET);
      req.userId = payload.sub;
    } catch (err) {
      /* token inválido: seguimos como anónimo */
    }
  }
  next();
}

// Exige que la cuenta tenga el correo confirmado. Se usa en las acciones que
// más abusa el spam (publicar avisos, mandar mensajes, reportar).
//
// La comprobación es `!== true` a propósito: con `=== false` cualquier otro
// valor falsy (0, null, cadena vacía) colaba sin bloquear la petición. Ante la
// duda, se bloquea.
async function requireVerified(req, res, next) {
  try {
    const r = await db.query('SELECT email_verified FROM users WHERE id = $1', [req.userId]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Sesión inválida o expirada.' });
    if (r.rows[0].email_verified !== true) {
      return res
        .status(403)
        .json({ error: 'Confirma tu correo para poder publicar. Revisa tu bandeja de entrada.' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { requireAuth, optionalAuth, requireVerified };
