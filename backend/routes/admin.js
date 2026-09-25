// admin.js
// Panel de administración mínimo para moderar avisos reportados.
//
// Solo las cuentas cuyo correo figure en la variable ADMIN_EMAILS (separados
// por coma) pueden entrar. Si la variable está vacía, el panel queda cerrado.
const express = require('express');
const { param, validationResult } = require('express-validator');
const db = require('../db');
const storage = require('../storage');
const { purgarChipsBorrados } = require('../mantenimiento');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',')
  .map(s => s.trim().toLowerCase())
  .filter(Boolean);

if (!ADMIN_EMAILS.length) {
  console.warn('[admin] ADMIN_EMAILS no configurado: el panel de administración queda deshabilitado.');
}

async function requireAdmin(req, res, next) {
  try {
    // Además de estar en la lista, el correo tiene que estar VERIFICADO. Sin
    // esta comprobación bastaba con registrar una dirección de ADMIN_EMAILS
    // para entrar al panel: sin proveedor de correo el registro nace con
    // email_verified = true (ver routes/auth.js), así que no había ninguna
    // barrera. Se exige en este único sitio, y no ruta por ruta, para que una
    // ruta nueva no pueda olvidarse de pedirlo.
    const u = (await db.query('SELECT email, email_verified FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!u || !ADMIN_EMAILS.includes(String(u.email).toLowerCase()) || u.email_verified !== true) {
      return res.status(403).json({ error: 'No tienes permisos de administrador.' });
    }
    next();
  } catch (err) {
    next(err);
  }
}

function adminReport(r) {
  return {
    id: r.id,
    estado: r.estado,
    tipo: r.tipo,
    color: r.color,
    raza: r.raza,
    descripcion: r.descripcion,
    nombre_mascota: r.nombre_mascota,
    foto_url: r.foto_url || null,
    active: !!r.active,
    resolved: !!r.resolved,
    flags: r.flags,
    owner_email: r.owner_email || null,
    created_at: Number(r.created_at)
  };
}

/* ---------- Avisos reportados ---------- */
// `param('id').isUUID()` solo deja el error anotado en la request: hay que
// leerlo con validationResult y cortar antes de tocar la base. Sin esto, un id
// que no es UUID llegaba tal cual al SQL (en Postgres, error 22P02 -> 500 en vez
// del 400 que anuncia la validación).
router.get('/flagged', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT r.*, u.email AS owner_email
         FROM reports r JOIN users u ON u.id = r.user_id
        WHERE r.flags > 0
        ORDER BY r.flags DESC, r.created_at DESC
        LIMIT 200`
    );
    res.json({ reports: result.rows.map(adminReport) });
  } catch (err) {
    next(err);
  }
});

/* ---------- Ocultar / restaurar un aviso ---------- */
router.post('/reports/:id/hide', requireAuth, requireAdmin, param('id').isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

    await db.query('UPDATE reports SET active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/reports/:id/unhide',
  requireAuth,
  requireAdmin,
  param('id').isUUID(),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

      await db.query('UPDATE reports SET active = TRUE, flags = 0 WHERE id = $1', [req.params.id]);
      await db.query('DELETE FROM report_flags WHERE report_id = $1', [req.params.id]);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------- Eliminar un aviso (y su foto) ---------- */
router.delete('/reports/:id', requireAuth, requireAdmin, param('id').isUUID(), async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ error: 'Identificador inválido.' });

    const r = (
      await db.query('SELECT foto_url, reunion_foto_url FROM reports WHERE id = $1', [req.params.id])
    ).rows[0];
    if (r) {
      await storage.deletePhoto(r.foto_url);
      await storage.deletePhoto(r.reunion_foto_url);
    }
    await db.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---------- Eliminar TODOS los avisos (limpieza) ---------- */
// Borra todos los avisos y sus fotos de una vez, para dejar la app en cero tras
// pruebas. Los mensajes y reportes asociados se van por ON DELETE CASCADE.
router.delete('/reports', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const fotos = await db.query('SELECT foto_url, reunion_foto_url FROM reports');
    await Promise.all(
      fotos.rows.flatMap(r => [storage.deletePhoto(r.foto_url), storage.deletePhoto(r.reunion_foto_url)])
    );
    const borrados = await db.query('DELETE FROM reports');
    res.json({ borrados: borrados.rowCount });
  } catch (err) {
    next(err);
  }
});

/* ---------- Usuarios (para revisar cuentas sospechosas) ---------- */
router.get('/users', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT u.id, u.email, u.created_at, u.email_verified,
              (SELECT COUNT(*)::int FROM reports r WHERE r.user_id = u.id) AS reports
         FROM users u
        ORDER BY u.created_at DESC
        LIMIT 200`
    );
    res.json({
      users: result.rows.map(u => ({
        id: u.id,
        email: u.email,
        created_at: Number(u.created_at),
        email_verified: !!u.email_verified,
        reports: u.reports
      }))
    });
  } catch (err) {
    next(err);
  }
});

/* ---------- Mantenimiento: purga de microchips dados de baja ---------- */
// El borrado lógico saca el registro de las búsquedas al instante, pero la fila
// se conserva 90 días para poder auditar una baja reciente. Esto la borra del
// todo. Va como endpoint para poder programarlo desde fuera (el hosting no
// siempre deja ejecutar un script): es idempotente y no toca nada más.
router.post('/chips/purgar', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const borrados = await purgarChipsBorrados(Date.now());
    res.json({ borrados });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
