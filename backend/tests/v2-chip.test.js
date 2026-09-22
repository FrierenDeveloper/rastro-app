// Pruebas del módulo de microchip (backend/src/v2/chip.js).
// Código nuevo de src/v2: cobertura 100% obligatoria (ver AGENTS.md).
//
// Lo que se protege aquí es de privacidad: el número del chip NUNCA se guarda en
// claro. Solo se guarda su huella HMAC (para comparar) y su forma cifrada (para
// que el dueño pueda verlo con el botón "visualizar").
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Se carga con require (igual que la ruta de producción): si el módulo se
// importara por ESM y por CJS a la vez, V8 contaría dos veces el mismo archivo y
// la cobertura de src/v2 daría ramas fantasma sin cubrir.
const require = createRequire(import.meta.url);
const chip = require('../src/v2/chip.js');

const {
  normalizar,
  esValido,
  canonico,
  enmascarar,
  huella,
  cifrar,
  descifrar,
  haySecreto,
  LARGO_MINIMO,
  LARGO_ISO
} = chip;

const SECRETO = 'secreto-de-pruebas-rastro';
const CHIP_VALIDO = '981020304050607';

describe('normalizar', () => {
  it('null, undefined y vacío quedan en cadena vacía', () => {
    expect(normalizar(null)).toBe('');
    expect(normalizar(undefined)).toBe('');
    expect(normalizar('')).toBe('');
  });

  it('acepta números y los pasa a texto', () => {
    expect(normalizar(981020304050607)).toBe(CHIP_VALIDO);
  });

  it('quita separadores de un chip escrito a mano', () => {
    expect(normalizar('981 020-304.050_607')).toBe(CHIP_VALIDO);
    expect(normalizar('981/020/304/050/607')).toBe(CHIP_VALIDO);
    expect(normalizar('  981020304050607  ')).toBe(CHIP_VALIDO);
  });

  it('quita el prefijo ISO que imprimen algunos lectores', () => {
    expect(normalizar('ISO 981020304050607')).toBe(CHIP_VALIDO);
    expect(normalizar('iso981020304050607')).toBe(CHIP_VALIDO);
    expect(normalizar('isO  981020304050607')).toBe(CHIP_VALIDO);
  });

  it('no borra letras: un valor con letras debe poder rechazarse', () => {
    expect(normalizar('98102030405060A')).toBe('98102030405060A');
    expect(normalizar('ABC-981020304050607')).toBe('ABC981020304050607');
  });
});

describe('esValido', () => {
  it('acepta de 9 a 15 dígitos', () => {
    expect(esValido(CHIP_VALIDO)).toBe(true);
    expect(esValido('123456789')).toBe(true);
    expect(esValido('1'.repeat(LARGO_ISO))).toBe(true);
    expect(LARGO_MINIMO).toBe(9);
    expect(LARGO_ISO).toBe(15);
  });

  it('acepta el chip escrito con separadores', () => {
    expect(esValido('981 020 304 050 607')).toBe(true);
    expect(esValido('ISO 981020304050607')).toBe(true);
  });

  it('rechaza longitudes fuera de rango', () => {
    expect(esValido('12345678')).toBe(false);
    expect(esValido('1'.repeat(16))).toBe(false);
  });

  it('rechaza vacío, null y undefined', () => {
    expect(esValido('')).toBe(false);
    expect(esValido('   ')).toBe(false);
    expect(esValido(null)).toBe(false);
    expect(esValido(undefined)).toBe(false);
  });

  it('rechaza letras y símbolos intercalados', () => {
    expect(esValido('98102030405060A')).toBe(false);
    expect(esValido('ABC981020304050607')).toBe(false);
    expect(esValido('+981020304050607')).toBe(false);
    expect(esValido('981020304050607#')).toBe(false);
  });
});

describe('canonico', () => {
  it('rellena con ceros a la izquierda hasta 15 dígitos', () => {
    expect(canonico('123456789')).toBe('000000123456789');
    expect(canonico(CHIP_VALIDO)).toBe(CHIP_VALIDO);
  });

  it('un chip corto y el mismo con ceros dan el mismo canónico', () => {
    expect(canonico('123456789')).toBe(canonico('000000123456789'));
  });

  it('devuelve vacío si el valor no es válido', () => {
    expect(canonico('123')).toBe('');
    expect(canonico(null)).toBe('');
    expect(canonico('98102030405060A')).toBe('');
  });
});

describe('enmascarar', () => {
  it('oculta todo menos los últimos 4 dígitos', () => {
    expect(enmascarar(CHIP_VALIDO)).toBe('••••••••••• 0607');
  });

  it('enmascara también si llega con separadores', () => {
    expect(enmascarar('981 020 304 050 607')).toBe('••••••••••• 0607');
  });

  it('con 4 dígitos o menos no oculta nada', () => {
    expect(enmascarar('0607')).toBe('0607');
    expect(enmascarar('607')).toBe('607');
  });

  it('vacío, null y undefined quedan en cadena vacía', () => {
    expect(enmascarar('')).toBe('');
    expect(enmascarar(null)).toBe('');
    expect(enmascarar(undefined)).toBe('');
  });
});

describe('haySecreto', () => {
  it('solo acepta cadenas con contenido', () => {
    expect(haySecreto(SECRETO)).toBe(true);
    expect(haySecreto('')).toBe(false);
    expect(haySecreto(null)).toBe(false);
    expect(haySecreto(undefined)).toBe(false);
    expect(haySecreto(12345)).toBe(false);
  });
});

describe('huella', () => {
  it('es determinista y de 64 caracteres hexadecimales', () => {
    const h = huella(CHIP_VALIDO, SECRETO);
    expect(h).toBe(huella(CHIP_VALIDO, SECRETO));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('no contiene el número del chip', () => {
    expect(huella(CHIP_VALIDO, SECRETO)).not.toContain(CHIP_VALIDO);
  });

  it('dos chips distintos dan huellas distintas', () => {
    expect(huella(CHIP_VALIDO, SECRETO)).not.toBe(huella('981020304050608', SECRETO));
  });

  it('el mismo chip con otro secreto da otra huella', () => {
    expect(huella(CHIP_VALIDO, SECRETO)).not.toBe(huella(CHIP_VALIDO, 'otro-secreto'));
  });

  it('normaliza separadores y ceros a la izquierda antes de calcular', () => {
    expect(huella('981 020 304 050 607', SECRETO)).toBe(huella(CHIP_VALIDO, SECRETO));
    expect(huella('123456789', SECRETO)).toBe(huella('000000123456789', SECRETO));
  });

  it('sin secreto devuelve vacío (no se guarda un chip sin proteger)', () => {
    expect(huella(CHIP_VALIDO, '')).toBe('');
    expect(huella(CHIP_VALIDO, null)).toBe('');
  });

  it('con un chip inválido devuelve vacío', () => {
    expect(huella('123', SECRETO)).toBe('');
    expect(huella(null, SECRETO)).toBe('');
  });
});

describe('cifrar y descifrar', () => {
  it('ida y vuelta devuelve el chip canónico', () => {
    const c = cifrar(CHIP_VALIDO, SECRETO);
    expect(descifrar(c, SECRETO)).toBe(CHIP_VALIDO);
  });

  it('el texto cifrado no contiene el número', () => {
    expect(cifrar(CHIP_VALIDO, SECRETO)).not.toContain(CHIP_VALIDO);
  });

  it('dos cifrados del mismo chip son distintos (IV aleatorio)', () => {
    expect(cifrar(CHIP_VALIDO, SECRETO)).not.toBe(cifrar(CHIP_VALIDO, SECRETO));
  });

  it('descifra un chip corto rellenado con ceros', () => {
    expect(descifrar(cifrar('123456789', SECRETO), SECRETO)).toBe('000000123456789');
  });

  it('con otro secreto no descifra', () => {
    expect(descifrar(cifrar(CHIP_VALIDO, SECRETO), 'otro-secreto')).toBe(null);
  });

  it('un texto cifrado manipulado no descifra', () => {
    const partes = cifrar(CHIP_VALIDO, SECRETO).split('.');
    const datos = Buffer.from(partes[3], 'base64');
    datos[0] = datos[0] ^ 0xff;
    expect(descifrar([partes[0], partes[1], partes[2], datos.toString('base64')].join('.'), SECRETO)).toBe(
      null
    );
  });

  it('rechaza formatos que no son nuestros', () => {
    expect(descifrar('basura', SECRETO)).toBe(null);
    expect(descifrar('v2.a.b.c', SECRETO)).toBe(null);
    expect(descifrar('v1.a.b', SECRETO)).toBe(null);
    expect(descifrar('v1.a.b.c.d', SECRETO)).toBe(null);
  });

  it('rechaza valores que no son cadena', () => {
    expect(descifrar(null, SECRETO)).toBe(null);
    expect(descifrar(undefined, SECRETO)).toBe(null);
    expect(descifrar(12345, SECRETO)).toBe(null);
  });

  it('sin secreto no cifra ni descifra', () => {
    expect(cifrar(CHIP_VALIDO, '')).toBe('');
    expect(cifrar(CHIP_VALIDO, null)).toBe('');
    expect(descifrar('v1.a.b.c', '')).toBe(null);
    expect(descifrar('v1.a.b.c', null)).toBe(null);
  });

  it('con un chip inválido no cifra', () => {
    expect(cifrar('123', SECRETO)).toBe('');
    expect(cifrar(null, SECRETO)).toBe('');
  });
});
