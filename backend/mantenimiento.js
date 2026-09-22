// mantenimiento.js
// Tareas de limpieza que no son de ninguna ruta en concreto.
//
// La primera: purgar los registros de microchip que su dueño dio de baja hace más
// de 90 días. La baja (deleted_at) ya los saca de las búsquedas del escaneo al
// instante; este borrado definitivo solo espera el plazo para poder auditar una
// baja reciente. Se puede lanzar a mano con `node scripts/purgar-chips.js` o desde
// el panel de administración.
'use strict';

const db = require('./db');
const { fechaLimitePurga } = require('./src/v2/chip');

// Borra los registros con baja anterior al plazo y devuelve cuántos borró.
async function purgarChipsBorrados(ahora) {
  const resultado = await db.query(
    'DELETE FROM chip_registrations WHERE deleted_at IS NOT NULL AND deleted_at < $1',
    [fechaLimitePurga(ahora)]
  );
  return resultado.rowCount || 0;
}

module.exports = { purgarChipsBorrados };
