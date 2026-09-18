// admin.js
// Panel de administración mínimo para moderar avisos reportados.
//
// Solo las cuentas cuyo correo figure en la variable ADMIN_EMAILS (separados
// por coma) pueden entrar. Si la variable está vacía, el panel queda cerrado.
const express = require('express');
const { param } = require('express-validator');
const db = require('../db');
const storage = require('../storage');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const ADMIN_EMAILS = (process.env.ADMIN_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

if (!ADMIN_EMAILS.length) {
  console.warn('[admin] ADMIN_EMAILS no configurado: el panel de administración queda deshabilitado.');
}

async function requireAdmin(req, res, next) {
  try {
    const u = (await db.query('SELECT email FROM users WHERE id = $1', [req.userId])).rows[0];
    if (!u || !ADMIN_EMAILS.includes(String(u.email).toLowerCase())) {
      return res.status(403).json({ error: 'No tienes permisos de administrador.' });
    }
    next();
  } catch (err) { next(err); }
}

function adminReport(r) {
  return {
    id: r.id, estado: r.estado, tipo: r.tipo, color: r.color, raza: r.raza,
    descripcion: r.descripcion, nombre_mascota: r.nombre_mascota,
    foto_url: r.foto_url || null,
    active: !!r.active, resolved: !!r.resolved, flags: r.flags,
    owner_email: r.owner_email || null,
    created_at: Number(r.created_at)
  };
}

/* ---------- Avisos reportados ---------- */
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
  } catch (err) { next(err); }
});

/* ---------- Ocultar / restaurar un aviso ---------- */
router.post('/reports/:id/hide', requireAuth, requireAdmin, param('id').isUUID(), async (req, res, next) => {
  try {
    await db.query('UPDATE reports SET active = FALSE WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/reports/:id/unhide', requireAuth, requireAdmin, param('id').isUUID(), async (req, res, next) => {
  try {
    await db.query('UPDATE reports SET active = TRUE, flags = 0 WHERE id = $1', [req.params.id]);
    await db.query('DELETE FROM report_flags WHERE report_id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ---------- Eliminar un aviso (y su foto) ---------- */
router.delete('/reports/:id', requireAuth, requireAdmin, param('id').isUUID(), async (req, res, next) => {
  try {
    const r = (await db.query('SELECT foto_url, reunion_foto_url FROM reports WHERE id = $1', [req.params.id])).rows[0];
    if (r) {
      await storage.deletePhoto(r.foto_url);
      await storage.deletePhoto(r.reunion_foto_url);
    }
    await db.query('DELETE FROM reports WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { next(err); }
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
        id: u.id, email: u.email, created_at: Number(u.created_at),
        email_verified: !!u.email_verified, reports: u.reports
      }))
    });
  } catch (err) { next(err); }
});

module.exports = router;
