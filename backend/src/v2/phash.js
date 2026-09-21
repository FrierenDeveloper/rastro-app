// phash.js
// Hash perceptual de fotos (dHash) para detectar imágenes repetidas.
//
// No hace machine learning ni llama a ningún servicio: decodifica la imagen con
// librerías puras de JavaScript (jpeg-js/pngjs), la reduce a una rejilla de 9x8
// en escala de grises y guarda 64 bits que representan los cambios de brillo
// entre píxeles vecinos. Dos fotos de la misma mascota se parecen aunque se
// recorten o se recompriman; compararlas es contar bits distintos (Hamming).
//
// Es lógica PURA: recibe un Buffer y devuelve un string hexadecimal, o null si
// el formato no se puede leer. No toca disco, base de datos ni red.
'use strict';

const jpeg = require('jpeg-js');
const { PNG } = require('pngjs');

const ANCHO_HASH = 9; // 9 columnas -> 8 comparaciones por fila
const ALTO_HASH = 8; // 8 filas
const BITS_POR_NIBBLE = 4;
const HEX = /^[0-9a-f]+$/;
const UMBRAL_DUPLICADO = 6; // de 64 bits: iguales o casi iguales
const POPCOUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];

// Mismo criterio de magic bytes que la ruta de avisos: no confiamos en el
// mimetype del cliente. WebP no tiene decodificador puro aquí, así que lo
// dejamos fuera (devuelve null y el aviso se guarda sin hash).
function tipoImagen(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47)
    return 'image/png';
  return null;
}

function decodificar(buffer) {
  const tipo = tipoImagen(buffer);
  if (tipo === 'image/jpeg') {
    const img = jpeg.decode(buffer, { useTArray: true });
    return { width: img.width, height: img.height, data: img.data };
  }
  if (tipo === 'image/png') {
    const png = PNG.sync.read(buffer);
    return { width: png.width, height: png.height, data: png.data };
  }
  return null;
}

function luminancia(datos, i) {
  return 0.299 * datos[i] + 0.587 * datos[i + 1] + 0.114 * datos[i + 2];
}

// Reduce la imagen a la rejilla del hash promediando bloques (escala de grises).
function reescalarGris(imagen) {
  const { width, height, data } = imagen;
  const salida = new Array(ANCHO_HASH * ALTO_HASH);
  for (let oy = 0; oy < ALTO_HASH; oy++) {
    const y0 = Math.floor((oy * height) / ALTO_HASH);
    const y1 = Math.min(height, Math.max(y0 + 1, Math.floor(((oy + 1) * height) / ALTO_HASH)));
    for (let ox = 0; ox < ANCHO_HASH; ox++) {
      const x0 = Math.floor((ox * width) / ANCHO_HASH);
      const x1 = Math.min(width, Math.max(x0 + 1, Math.floor(((ox + 1) * width) / ANCHO_HASH)));
      let suma = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          suma += luminancia(data, (y * width + x) * 4);
          n += 1;
        }
      }
      salida[oy * ANCHO_HASH + ox] = suma / n;
    }
  }
  return salida;
}

// dHash: un bit por cada par de celdas contiguas (1 si la izquierda es más
// oscura que la derecha). 64 bits -> 16 caracteres hexadecimales.
function dhashDesdeGris(gris) {
  let hex = '';
  let nibble = 0;
  let bits = 0;
  for (let y = 0; y < ALTO_HASH; y++) {
    for (let x = 0; x < ANCHO_HASH - 1; x++) {
      const bit = gris[y * ANCHO_HASH + x] < gris[y * ANCHO_HASH + x + 1] ? 1 : 0;
      nibble = (nibble << 1) | bit;
      bits += 1;
      if (bits === BITS_POR_NIBBLE) {
        hex += nibble.toString(16);
        nibble = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

// Devuelve el hash de la imagen, o null si no se puede decodificar.
function hashPerceptual(buffer) {
  try {
    const imagen = decodificar(buffer);
    if (!imagen) return null;
    return dhashDesdeGris(reescalarGris(imagen));
  } catch {
    return null;
  }
}

// Cuenta los bits distintos entre dos hashes; null si no son comparables.
function distanciaHamming(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || a.length !== b.length) return null;
  if (!HEX.test(a) || !HEX.test(b)) return null;
  let distancia = 0;
  for (let i = 0; i < a.length; i++) {
    distancia += POPCOUNT[parseInt(a[i], 16) ^ parseInt(b[i], 16)];
  }
  return distancia;
}

// ¿Son la misma foto (o lo bastante parecidas)? Umbral configurable.
function esDuplicado(a, b, umbral) {
  const distancia = distanciaHamming(a, b);
  if (distancia === null) return false;
  const tope = Number.isInteger(umbral) && umbral >= 0 ? umbral : UMBRAL_DUPLICADO;
  return distancia <= tope;
}

module.exports = {
  hashPerceptual,
  distanciaHamming,
  esDuplicado,
  tipoImagen,
  ANCHO_HASH,
  ALTO_HASH,
  UMBRAL_DUPLICADO
};
