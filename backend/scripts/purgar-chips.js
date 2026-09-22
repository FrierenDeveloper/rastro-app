// purgar-chips.js
// Purga manual de los registros de microchip dados de baja hace más de 90 días.
//
//   cd backend
//   node scripts/purgar-chips.js
//
// Es idempotente: se puede programar (cron del hosting o programador de tareas)
// tantas veces como se quiera. Si prefieres dispararlo desde fuera sin acceso a
// la consola del servidor, el panel de administración expone el mismo trabajo en
// POST /api/admin/chips/purgar.
require('dotenv').config();
const { pool } = require('../db');
const { purgarChipsBorrados } = require('../mantenimiento');

(async () => {
  try {
    const borrados = await purgarChipsBorrados(Date.now());
    console.log(`[purgar-chips] registros borrados: ${borrados}`);
  } catch (err) {
    console.error('[purgar-chips] no se pudo purgar:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
