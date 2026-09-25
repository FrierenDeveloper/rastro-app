// Pruebas de backend/src/v2/limites-imagen.js.
//
// Lo que se protege aquí es que el servidor NUNCA decodifique una imagen cuyo
// tamaño declarado no quepa en memoria. El tamaño del archivo no dice nada: un
// PNG de 60 KB puede declarar 20000x20000 y hacer que el decodificador reserve
// ~1,5 GB (bomba de descompresión). Estas pruebas fijan ese contrato.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Se carga con require (igual que phash.js en producción): si el módulo se
// importara por ESM y por CJS a la vez, V8 contaría dos veces el mismo archivo y
// la cobertura de src/v2 daría ramas fantasma sin cubrir.
const require = createRequire(import.meta.url);
const { MAX_PIXELES, dimensionesImagen, excedePresupuesto } = require('../src/v2/limites-imagen.js');

// ---------- Constructores de cabeceras (bytes reales, no simulaciones) ----------

// PNG: firma de 8 bytes + [longitud 4][tipo 4] + datos del IHDR.
// El ancho vive en los bytes 16..20 y el alto en 20..24 (big-endian).
function pngConDimensiones(width, height, { tipo = 'IHDR', bytes = 24 } = {}) {
  const buf = Buffer.alloc(bytes);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);
  buf.write(tipo, 12, 'ascii');
  // Solo se escriben las dimensiones si el buffer llega a tenerlas: así se
  // puede construir a propósito una cabecera truncada.
  if (bytes >= 24) {
    buf.writeUInt32BE(width, 16);
    buf.writeUInt32BE(height, 20);
  }
  return buf;
}

const SOI = Buffer.from([0xff, 0xd8]);

// Segmento JPEG completo: marcador + longitud + datos.
function segmento(marcador, longitud) {
  const buf = Buffer.alloc(2 + longitud);
  buf.writeUInt8(0xff, 0);
  buf.writeUInt8(marcador, 1);
  buf.writeUInt16BE(longitud, 2);
  return buf;
}

// SOF: desde el marcador, alto en +5 y ancho en +7.
function sof(marcador, width, height) {
  const buf = Buffer.alloc(2 + 17);
  buf.writeUInt8(0xff, 0);
  buf.writeUInt8(marcador, 1);
  buf.writeUInt16BE(17, 2);
  buf.writeUInt8(8, 4); // precisión
  buf.writeUInt16BE(height, 5);
  buf.writeUInt16BE(width, 7);
  return buf;
}

function jpegConDimensiones(width, height, marcadorSof = 0xc0) {
  return Buffer.concat([SOI, segmento(0xe0, 16), sof(marcadorSof, width, height)]);
}

// ---------- dimensionesImagen ----------

describe('dimensionesImagen', () => {
  it('devuelve null con null, undefined o un buffer demasiado corto', () => {
    expect(dimensionesImagen(null)).toBeNull();
    expect(dimensionesImagen(undefined)).toBeNull();
    expect(dimensionesImagen(Buffer.alloc(0))).toBeNull();
    expect(dimensionesImagen(Buffer.alloc(11))).toBeNull();
  });

  it('lee las dimensiones de un PNG real', () => {
    expect(dimensionesImagen(pngConDimensiones(4000, 3000))).toEqual({ width: 4000, height: 3000 });
  });

  it('lee las dimensiones de un JPEG real (SOF0)', () => {
    expect(dimensionesImagen(jpegConDimensiones(640, 480))).toEqual({ width: 640, height: 480 });
  });

  it('lee las dimensiones de un JPEG progresivo (SOF2)', () => {
    expect(dimensionesImagen(jpegConDimensiones(1024, 768, 0xc2))).toEqual({ width: 1024, height: 768 });
  });

  it('devuelve null con un formato que no reconoce (WebP, GIF, basura)', () => {
    const webp = Buffer.alloc(24);
    webp.write('RIFF', 0, 'ascii');
    webp.write('WEBP', 8, 'ascii');
    expect(dimensionesImagen(webp)).toBeNull();
    expect(dimensionesImagen(Buffer.alloc(24))).toBeNull();
  });
});

// ---------- camino PNG ----------

describe('dimensionesImagen en el camino PNG', () => {
  it('devuelve null si la cabecera no llega a los 24 bytes', () => {
    expect(dimensionesImagen(pngConDimensiones(10, 10, { bytes: 20 }))).toBeNull();
  });

  it('devuelve null si el primer bloque no es IHDR', () => {
    expect(dimensionesImagen(pngConDimensiones(10, 10, { tipo: 'IDAT' }))).toBeNull();
  });
});

// ---------- camino JPEG ----------

describe('dimensionesImagen en el camino JPEG', () => {
  it('devuelve null si aparece el inicio de los datos (SOS) antes que el SOF', () => {
    expect(dimensionesImagen(Buffer.concat([SOI, segmento(0xda, 8)]))).toBeNull();
  });

  it('salta los marcadores que no llevan longitud (RST) y sigue buscando', () => {
    const buf = Buffer.concat([
      SOI,
      Buffer.from([0xff, 0xd0]), // RST0: sin longitud, se salta 2 bytes
      jpegConDimensiones(320, 240).subarray(2) // sin repetir el SOI
    ]);
    expect(dimensionesImagen(buf)).toEqual({ width: 320, height: 240 });
  });

  it('devuelve null si un segmento declara una longitud imposible', () => {
    // Marcador con longitud declarada 0 (< 2): no puede ser un segmento real.
    const buf = Buffer.concat([SOI, Buffer.from([0xff, 0xe0, 0x00, 0x00]), Buffer.alloc(7)]);
    expect(dimensionesImagen(buf)).toBeNull();
  });

  it('devuelve null si encuentra un byte que no inicia marcador', () => {
    // El buffer tiene que entrar de verdad al parser: firma JPEG correcta
    // (ff d8 ff), un APP0 que declara 16 bytes de longitud, y después relleno
    // donde debería empezar el siguiente marcador. Ese relleno es el que hace
    // que el recorrido se encuentre un byte que no es 0xff.
    const buf = Buffer.concat([SOI, Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(40)]);
    expect(dimensionesImagen(buf)).toBeNull();
  });

  it('devuelve null si el buffer se acaba sin encontrar el SOF', () => {
    expect(dimensionesImagen(Buffer.concat([SOI, segmento(0xe0, 400)]))).toBeNull();
  });
});

// ---------- excedePresupuesto ----------

describe('excedePresupuesto', () => {
  it('no se pronuncia si no hay dimensiones (no es su trabajo inventarlas)', () => {
    expect(excedePresupuesto(null)).toBe(false);
  });

  it('rechaza dimensiones que no son enteros', () => {
    expect(excedePresupuesto({ width: 10.5, height: 10 })).toBe(true);
    expect(excedePresupuesto({ width: 10, height: '20' })).toBe(true);
  });

  it('rechaza dimensiones no positivas', () => {
    expect(excedePresupuesto({ width: 0, height: 10 })).toBe(true);
    expect(excedePresupuesto({ width: 10, height: 0 })).toBe(true);
    expect(excedePresupuesto({ width: -1, height: 10 })).toBe(true);
  });

  it('acepta una imagen justo en el tope', () => {
    expect(excedePresupuesto({ width: MAX_PIXELES, height: 1 })).toBe(false);
  });

  it('rechaza una imagen un píxel por encima del tope', () => {
    expect(excedePresupuesto({ width: MAX_PIXELES + 1, height: 1 })).toBe(true);
  });

  it('no desborda con dimensiones enormes (compara dividiendo, no multiplicando)', () => {
    expect(excedePresupuesto({ width: 4294967295, height: 4294967295 })).toBe(true);
  });
});

// ---------- MAX_PIXELES ----------

describe('MAX_PIXELES', () => {
  it('es un entero positivo', () => {
    expect(Number.isInteger(MAX_PIXELES)).toBe(true);
    expect(MAX_PIXELES).toBeGreaterThan(0);
  });

  it('deja pasar la foto más grande que sube el cliente (reduce a 800 px)', () => {
    expect(excedePresupuesto({ width: 800, height: 800 })).toBe(false);
  });

  it('deja pasar una foto de móvil a resolución completa (4032x3024, 12,2 Mpx)', () => {
    expect(excedePresupuesto({ width: 4032, height: 3024 })).toBe(false);
  });

  it('deja pasar una foto de 5000x4000 enviada directo a la API', () => {
    expect(excedePresupuesto({ width: 5000, height: 4000 })).toBe(false);
  });

  // La prueba que importa: el caso medido en la revisión. Ese PNG pesaba 60 KB
  // y pedía 124 MB al decodificarse; a 20000x20000, ~1,5 GB.
  it('rechaza la bomba de descompresión medida (20000x20000 en 60 KB)', () => {
    const bomba = pngConDimensiones(20000, 20000);
    expect(bomba.length).toBeLessThan(5 * 1024 * 1024);
    expect(excedePresupuesto(dimensionesImagen(bomba))).toBe(true);
  });

  it('rechaza también la bomba moderada de 6000x6000, que sí cabía en 5 MB', () => {
    expect(excedePresupuesto(dimensionesImagen(pngConDimensiones(6000, 6000)))).toBe(true);
  });
});

// ---------- coherencia entre las dos piezas ----------

describe('el camino real: cabecera -> decisión', () => {
  it.each([
    ['PNG legítimo', pngConDimensiones(4000, 3000), false],
    ['PNG bomba', pngConDimensiones(20000, 20000), true],
    ['JPEG legítimo', jpegConDimensiones(4032, 3024), false],
    ['JPEG bomba', jpegConDimensiones(20000, 20000), true],
    ['cabecera PNG truncada', pngConDimensiones(10, 10, { bytes: 20 }), false]
  ])('con %s, la decisión final es la esperada', (_caso, buffer, esperado) => {
    const dims = dimensionesImagen(buffer);
    // Sin dimensiones no hay nada que rechazar aquí: el decodificador de phash
    // tampoco intenta decodificar lo que no reconoce.
    expect(dims === null ? false : excedePresupuesto(dims)).toBe(esperado);
  });
});
