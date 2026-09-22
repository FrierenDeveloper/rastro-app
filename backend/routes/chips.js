// routes/chips.js
// Registro voluntario de microchips.
//
// Un dueño registra el chip de su mascota y, cuando alguien lo escanea (Módulo de
// escaneo aparte), se le avisa SOLO a él: quien escanea nunca recibe su contacto.
//
// Dos decisiones que vienen de antes y se mantienen aquí:
//   * El número del chip NO se guarda en claro: chip_hash (HMAC con CHIP_SECRET)
//     para buscar y chip_cifrado (AES-GCM) para que su dueño pueda verlo. El
//     registro voluntario y el chip declarado en un aviso usan el mismo formato,
//     así que la huella de un mismo chip coincide en los dos sitios.
//   * Nada de columnas que no se usen: sin dirección, sin RUT, sin teléfono (el
//     contacto sale de la cuenta). La tabla queda preparada para veterinarias,
//     pero el flujo no las necesita.
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { body, param, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const db = require('../db');
const chip = require('../src/v2/chip');
const { requireAuth } = require('../middleware/auth');
const { keyPorIp } = require('../middleware/client-ip');
const { numEnv } = require('../middleware/limits');

const router = express.Router();

// Versión del texto de consentimiento que el usuario acepta. Se guarda con cada
// registro: si el texto cambia, se sabrá cuál aceptó cada uno.
const VERSION_CONSENTIMIENTO = 'v1';
const REGISTROS_POR_DIA = 10;
const MS_DIA = 24 * 60 * 60 * 1000;
const TABLA = 'chip_registrations';

const registroLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: numEnv('LIMITE_CHIPS_HORA', 15),
  keyGenerator: keyPorIp
});

function secreto() {
  return process.env.CHIP_SECRET;
}

// Traza de acceso a datos personales (Ley 21.719). A propósito NUNCA puede tumbar
// la acción que la origina: si falla el log, el usuario igual ejerce su derecho.
async function registrarAcceso(recordId, action, actorUserId) {
  try {
    await db.query(
      `INSERT INTO data_access_log (id, table_name, record_id, action, actor_user_id, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [uuidv4(), TABLA, recordId, action, actorUserId || null, Date.now()]
    );
  } catch (e) {
    /* sin traza, pero sin bloquear al usuario */
  }
}

// Lo que ve su dueño: el número descifrado (es su propio dato) y la máscara. La
// huella y el texto cifrado no salen nunca de aquí.
function registroPublico(fila) {
  const claro = fila.chip_cifrado ? chip.descifrar(fila.chip_cifrado, secreto()) : null;
  return {
    id: fila.id,
    pet_name: fila.pet_name,
    species: fila.species || null,
    verification_status: fila.verification_status,
    created_at: Number(fila.created_at),
    updated_at: Number(fila.updated_at),
    chip: claro,
    chip_enmascarado: claro ? chip.enmascarar(claro) : null
  };
}

async function buscarPropio(id, userId) {
  const fila = (await db.query('SELECT * FROM chip_registrations WHERE id = $1 AND deleted_at IS NULL', [id]))
    .rows[0];
  if (!fila) return { error: 404 };
  if (fila.owner_user_id !== userId) return { error: 403 };
  return { fila };
}

/* ---------- Alta del registro ---------- */
router.post(
  '/register',
  requireAuth,
  registroLimiter,
  body('chip_id').isString().trim().isLength({ max: 32 }).withMessage('El microchip debe tener 15 dígitos.'),
  body('pet_name').trim().isLength({ min: 1, max: 100 }),
  body('species').optional({ values: 'falsy' }).trim().isLength({ max: 50 }),
  body('consent_accepted').isBoolean({ strict: true }).withMessage('Necesitamos tu consentimiento.'),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });
      if (!chip.esIso(req.body.chip_id))
        return res.status(400).json({ error: 'El microchip debe tener 15 dígitos.' });
      // Sin consentimiento explícito no hay registro: nunca implícito ni preseleccionado.
      if (req.body.consent_accepted !== true)
        return res.status(400).json({ error: 'Necesitamos tu consentimiento para registrar el microchip.' });

      const hoy = await db.query(
        'SELECT COUNT(*)::int AS n FROM chip_registrations WHERE owner_user_id = $1 AND created_at > $2',
        [req.userId, Date.now() - MS_DIA]
      );
      if (hoy.rows[0].n >= REGISTROS_POR_DIA)
        return res.status(429).json({ error: 'Alcanzaste el límite de registros por hoy. Intenta mañana.' });

      const hash = chip.huella(req.body.chip_id, secreto());
      const cifrado = chip.cifrar(req.body.chip_id, secreto());
      if (!hash || !cifrado) throw new Error('[chips] no se pudo proteger el microchip (revisa CHIP_SECRET)');

      const yaEsta = await db.query(
        'SELECT id FROM chip_registrations WHERE chip_hash = $1 AND deleted_at IS NULL',
        [hash]
      );
      // No se sobrescribe en silencio: el flujo de "reclamar" queda para después.
      if (yaEsta.rows.length)
        return res.status(409).json({ error: 'Ese microchip ya está registrado en Rastro.' });

      const id = uuidv4();
      const ahora = Date.now();
      await db.query(
        `INSERT INTO chip_registrations
          (id, chip_hash, chip_cifrado, owner_user_id, pet_name, species, verification_status,
           verified_by_vet_id, consent_given_at, consent_text_version, created_at, updated_at, deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,'self_registered',NULL,$7,$8,$9,$9,NULL)`,
        [
          id,
          hash,
          cifrado,
          req.userId,
          req.body.pet_name,
          req.body.species || null,
          ahora,
          VERSION_CONSENTIMIENTO,
          ahora
        ]
      );
      await registrarAcceso(id, 'create', req.userId);
      const fila = (await db.query('SELECT * FROM chip_registrations WHERE id = $1', [id])).rows[0];
      res.status(201).json({ registro: registroPublico(fila) });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------- Mis registros (derecho de acceso) ---------- */
router.get('/mine', requireAuth, async (req, res, next) => {
  try {
    const filas = (
      await db.query(
        `SELECT * FROM chip_registrations
          WHERE owner_user_id = $1 AND deleted_at IS NULL
          ORDER BY created_at DESC`,
        [req.userId]
      )
    ).rows;
    for (const fila of filas) await registrarAcceso(fila.id, 'read', req.userId);
    res.json({ registros: filas.map(registroPublico) });
  } catch (err) {
    next(err);
  }
});

/* ---------- Editar (derecho de rectificación) ---------- */
router.patch(
  '/:id',
  requireAuth,
  param('id').isUUID().withMessage('Identificador inválido.'),
  body('pet_name').optional().trim().isLength({ min: 1, max: 100 }),
  body('species').optional().trim().isLength({ max: 50 }),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const { fila, error } = await buscarPropio(req.params.id, req.userId);
      if (error === 404) return res.status(404).json({ error: 'Registro no encontrado.' });
      if (error === 403) return res.status(403).json({ error: 'Este registro no es tuyo.' });

      const nombre =
        req.body.pet_name === undefined ? fila.pet_name : req.body.pet_name.trim() || fila.pet_name;
      const especie = req.body.species === undefined ? fila.species : req.body.species.trim() || null;
      await db.query(
        'UPDATE chip_registrations SET pet_name = $1, species = $2, updated_at = $3 WHERE id = $4',
        [nombre, especie, Date.now(), fila.id]
      );
      await registrarAcceso(fila.id, 'update', req.userId);
      const actualizada = (await db.query('SELECT * FROM chip_registrations WHERE id = $1', [fila.id]))
        .rows[0];
      res.json({ registro: registroPublico(actualizada) });
    } catch (err) {
      next(err);
    }
  }
);

/* ---------- Cancelar (derecho de cancelación / oposición) ---------- */
// Borrado lógico: la fila se conserva para poder auditar, pero deja de aparecer
// en las búsquedas del escaneo al instante. La purga física va aparte.
router.delete(
  '/:id',
  requireAuth,
  param('id').isUUID().withMessage('Identificador inválido.'),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const { fila, error } = await buscarPropio(req.params.id, req.userId);
      if (error === 404) return res.status(404).json({ error: 'Registro no encontrado.' });
      if (error === 403) return res.status(403).json({ error: 'Este registro no es tuyo.' });

      await db.query('UPDATE chip_registrations SET deleted_at = $1, updated_at = $1 WHERE id = $2', [
        Date.now(),
        fila.id
      ]);
      await registrarAcceso(fila.id, 'delete', req.userId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
