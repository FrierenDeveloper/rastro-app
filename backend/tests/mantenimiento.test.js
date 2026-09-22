// Pruebas del mantenimiento de los registros de microchip
// (backend/mantenimiento.js): la purga física de los que se dieron de baja hace
// más de 90 días.
import { describe, it, expect, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import { db } from './helpers/aislar.js';

const require = createRequire(import.meta.url);
const { purgarChipsBorrados } = require('../mantenimiento.js');
const { DIAS_PURGA, fechaLimitePurga } = require('../src/v2/chip.js');

const AHORA = 1_800_000_000_000;

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('purgarChipsBorrados', () => {
  it('borra solo los registros dados de baja, y solo los antiguos', async () => {
    await purgarChipsBorrados(AHORA);

    const [sql, params] = db.query.mock.calls[0];
    expect(String(sql)).toContain('DELETE FROM chip_registrations');
    expect(String(sql)).toContain('deleted_at IS NOT NULL');
    expect(String(sql)).toContain('deleted_at < $1');
    expect(params).toStrictEqual([fechaLimitePurga(AHORA)]);
    // El corte son 90 días exactos.
    expect(params[0]).toBe(AHORA - DIAS_PURGA * 24 * 60 * 60 * 1000);
  });

  it('devuelve cuántos registros se purgaron', async () => {
    db.query.mockResolvedValue({ rows: [], rowCount: 3 });

    await expect(purgarChipsBorrados(AHORA)).resolves.toBe(3);
  });

  it('sin nada que purgar devuelve 0', async () => {
    db.query.mockResolvedValue({ rows: [] });

    await expect(purgarChipsBorrados(AHORA)).resolves.toBe(0);
  });

  it('si la base falla, el error sube (quien llama tiene que enterarse)', async () => {
    db.query.mockRejectedValue(new Error('base caída'));

    await expect(purgarChipsBorrados(AHORA)).rejects.toThrow('base caída');
  });
});
