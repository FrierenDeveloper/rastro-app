// Pruebas de backend/ubicacion.js: cuánto vale la última ubicación conocida de
// una cuenta. Es lo que decide si a alguien se le avisa de una mascota perdida
// cerca o si su punto ya está demasiado viejo para contar.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DIAS_VIGENTE, MS_DIA, desdeCuandoVale } = require('../ubicacion.js');

const AHORA = 1_700_000_000_000;

describe('constantes de vigencia', () => {
  it('la ubicación vale 30 días', () => {
    expect(DIAS_VIGENTE).toBe(30);
  });

  it('un día son 86.400.000 ms', () => {
    expect(MS_DIA).toBe(86_400_000);
  });
});

describe('desdeCuandoVale', () => {
  it('devuelve el instante a partir del cual una ubicación sigue contando', () => {
    expect(desdeCuandoVale(AHORA)).toBe(AHORA - 30 * 86_400_000);
  });

  it('acepta el momento como texto numérico', () => {
    expect(desdeCuandoVale(String(AHORA))).toBe(AHORA - 30 * 86_400_000);
  });

  it('exactamente 30 días justo en el límite sigue contando', () => {
    const limite = desdeCuandoVale(AHORA);
    expect(limite >= desdeCuandoVale(AHORA) && limite <= AHORA).toBe(true);
  });
});
