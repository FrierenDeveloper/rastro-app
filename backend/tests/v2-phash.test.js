// Pruebas del hash perceptual (backend/src/v2/phash.js).
// Código nuevo de src/v2: cobertura 100% obligatoria (ver AGENTS.md).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';

// Se carga con require (igual que la ruta de producción): si el módulo se
// importara por ESM y por CJS a la vez, V8 contaría dos veces el mismo archivo y
// la cobertura de src/v2 daría ramas fantasma sin cubrir.
const require = createRequire(import.meta.url);
const phash = require('../src/v2/phash.js');

const { hashPerceptual, distanciaHamming, esDuplicado, tipoImagen, ANCHO_HASH, ALTO_HASH, UMBRAL_DUPLICADO } =
  phash;

const BLANCO = 'ffffffffffffffff';
const NEGRO = '0000000000000000';

// PNG RGBA a partir de una función de píxel.
function pngDe(width, height, pixel) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = pixel(x, y);
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function jpegDe(width, height, pixel) {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = pixel(x, y);
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return jpeg.encode({ data, width, height }, 90).data;
}

const solido = (r, g, b) => () => [r, g, b];
const gradiente = x => [x * 20, x * 20, x * 20];

function pngSolido(r, g, b) {
  return pngDe(ANCHO_HASH, ALTO_HASH, solido(r, g, b));
}

function pngGradiente() {
  return pngDe(ANCHO_HASH, ALTO_HASH, gradiente);
}

describe('tipoImagen', () => {
  it('null, indefinido y buffers cortos no son imagen', () => {
    expect(tipoImagen(null)).toBeNull();
    expect(tipoImagen(undefined)).toBeNull();
    expect(tipoImagen(Buffer.alloc(0))).toBeNull();
    expect(tipoImagen(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
  });

  it('reconoce JPEG y PNG por sus primeros bytes', () => {
    expect(tipoImagen(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9)]))).toBe('image/jpeg');
    expect(tipoImagen(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8)]))).toBe(
      'image/png'
    );
  });

  it('cualquier otra firma es desconocida', () => {
    expect(tipoImagen(Buffer.from('RIFF0000WEBP'))).toBeNull();
  });
});

describe('hashPerceptual', () => {
  it('una imagen de un solo color da todos los bits a 0', () => {
    expect(hashPerceptual(pngSolido(10, 10, 10))).toBe(NEGRO);
    expect(hashPerceptual(pngSolido(255, 255, 255))).toBe(NEGRO);
  });

  it('un gradiente creciente da todos los bits a 1', () => {
    expect(hashPerceptual(pngGradiente())).toBe(BLANCO);
  });

  it('pondera los canales al pasar a escala de grises', () => {
    // Rojo -> verde -> azul: el verde es el más claro (0.587) y el azul el más
    // oscuro (0.114), así que el primer bit sube y el segundo baja.
    const color = x => (x === 0 ? [255, 0, 0] : x === 1 ? [0, 255, 0] : [0, 0, 255]);
    expect(hashPerceptual(pngDe(ANCHO_HASH, ALTO_HASH, color))).toBe('8080808080808080');
  });

  it('es estable: la misma foto da el mismo hash', () => {
    const a = pngGradiente();
    expect(hashPerceptual(a)).toBe(hashPerceptual(a));
  });

  it('una imagen de 1x1 también se puede procesar', () => {
    expect(hashPerceptual(pngDe(1, 1, solido(128, 128, 128)))).toBe(NEGRO);
  });

  it('un JPEG válido devuelve un hash de 16 caracteres', () => {
    const hash = hashPerceptual(jpegDe(ANCHO_HASH, ALTO_HASH, gradiente));
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('WEBP no se puede decodificar: no hay hash', () => {
    expect(hashPerceptual(Buffer.concat([Buffer.from('RIFF0000WEBP'), Buffer.alloc(4)]))).toBeNull();
  });

  it('una cabecera PNG con bytes basura no rompe: null', () => {
    const falso = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(8, 0xff)
    ]);
    expect(hashPerceptual(falso)).toBeNull();
  });

  it('una cabecera JPEG con bytes basura no rompe: null', () => {
    const falso = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(12, 0x00)]);
    expect(hashPerceptual(falso)).toBeNull();
  });
});

describe('distanciaHamming', () => {
  it('el mismo hash tiene distancia 0', () => {
    expect(distanciaHamming(NEGRO, NEGRO)).toBe(0);
  });

  it('cuenta los bits distintos de cada nibble', () => {
    expect(distanciaHamming('0000000000000000', '000000000000000f')).toBe(4);
    expect(distanciaHamming('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });

  it('bits que se solapan en el mismo nibble no se cuentan dos veces', () => {
    expect(distanciaHamming('3', '3')).toBe(0);
    expect(distanciaHamming('f', '3')).toBe(2);
  });

  it('hashes de distinta longitud o vacíos no son comparables', () => {
    expect(distanciaHamming('00', '0000')).toBeNull();
    expect(distanciaHamming('', '')).toBeNull();
  });

  it('valores que no son texto no son comparables', () => {
    expect(distanciaHamming(null, NEGRO)).toBeNull();
    expect(distanciaHamming(NEGRO, undefined)).toBeNull();
  });

  it('texto que no es hexadecimal no es comparable', () => {
    expect(distanciaHamming('zz', '00')).toBeNull();
    expect(distanciaHamming('00', 'zz')).toBeNull();
  });
});

describe('esDuplicado', () => {
  it('hashes iguales son duplicado', () => {
    expect(esDuplicado(NEGRO, NEGRO)).toBe(true);
  });

  it('usa el umbral por defecto de 6 bits', () => {
    expect(UMBRAL_DUPLICADO).toBe(6);
    expect(esDuplicado('0000000000000000', '000000000000003f')).toBe(true); // 6 bits
    expect(esDuplicado('0000000000000000', '000000000000007f')).toBe(false); // 7 bits
  });

  it('acepta un umbral propio', () => {
    expect(esDuplicado('0000000000000000', '000000000000000f', 2)).toBe(false);
    expect(esDuplicado('0000000000000000', '000000000000000f', 4)).toBe(true);
  });

  it('un umbral inválido cae al valor por defecto', () => {
    expect(esDuplicado('0000000000000000', '000000000000003f', -1)).toBe(true);
    expect(esDuplicado('0000000000000000', '000000000000003f', 1.5)).toBe(true);
  });

  it('con hashes incomparables no hay duplicado', () => {
    expect(esDuplicado(null, NEGRO)).toBe(false);
    expect(esDuplicado('zz', '00')).toBe(false);
  });
});
