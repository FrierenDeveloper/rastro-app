// limites-imagen.js
// Tope de píxeles por imagen, medido en la CABECERA antes de decodificar.
//
// Por qué existe: el tamaño del archivo no dice nada del coste de decodificarlo.
// Un PNG de 60 KB puede declarar 20000x20000 y obligar a pngjs a reservar
// width*height*4 bytes (~1,5 GB), más el búfer de inflado: es una bomba de
// descompresión, y el OOM que provoca NO es una excepción que se pueda atrapar
// (el proceso muere). Medido en este proyecto: 60,8 KB -> 124,3 MB de RSS, en
// 141 ms y de forma síncrona (bloquea el event loop).
//
// jpeg-js trae sus propios topes (100 Mpx / 512 MB) pero son demasiado holgados
// para un contenedor de 512 MB, y pngjs no trae ninguno. Por eso el límite se
// aplica aquí, antes de tocar cualquier decodificador.
//
// Es lógica PURA: recibe un Buffer y no toca disco, base de datos ni red.
'use strict';

// 20 Mpx: deja pasar una foto de móvil a resolución completa (4032x3024 = 12,2
// Mpx) y una de 5000x4000 enviada directo a la API, y corta las bombas.
// Presupuesto de memoria: decodificar cuesta unas 2-3 veces width*height*4
// bytes, o sea ~160-240 MB en el tope, que cabe en el plan de 512 MB de Render.
// El cliente web reduce a 800 px antes de subir (frontend/app.js), así que en
// uso normal esto no se roza. Si se sube el plan se puede subir esta constante;
// si se baja, hay que comprobar que 4032x3024 siga entrando.
const MAX_PIXELES = 20 * 1000 * 1000;

const FIRMA_PNG = [0x89, 0x50, 0x4e, 0x47];
const FIRMA_JPEG = [0xff, 0xd8, 0xff];

// Marcadores SOF (inicio de cuadro): los únicos que declaran las dimensiones.
// Se excluyen DHT (0xc4), JPG (0xc8) y DAC (0xcc), que comparten el rango c0-cf.
const MARCADORES_SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf
]);

// Marcadores que no llevan campo de longitud: TEM (0x01) y los RST (0xd0-0xd7).
const SIN_LONGITUD = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);

function coincide(buffer, firma) {
  return firma.every((valor, i) => buffer[i] === valor);
}

// PNG: la firma ocupa 8 bytes y el IHDR es SIEMPRE el primer bloque, así que el
// ancho está en los bytes 16..20 y el alto en 20..24 (big-endian). El IHDR no
// puede mentir a la baja: pngjs reserva según lo que declare aquí, y si el IDAT
// trae más de lo que cabe, falla en vez de crecer.
function dimensionesPng(buffer) {
  if (buffer.length < 24) return null;
  if (buffer.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// JPEG: hay que recorrer los segmentos hasta el primer SOF. Contando desde el
// marcador: tipo en +1, longitud en +2, precisión en +4, alto en +5, ancho en +7.
function dimensionesJpeg(buffer) {
  let i = 2; // se salta el SOI
  while (i + 9 <= buffer.length) {
    if (buffer[i] !== 0xff) return null;
    const marcador = buffer[i + 1];
    if (MARCADORES_SOF.has(marcador)) {
      return { width: buffer.readUInt16BE(i + 7), height: buffer.readUInt16BE(i + 5) };
    }
    if (marcador === 0xda) return null; // empiezan los datos: ya no habrá SOF
    if (SIN_LONGITUD.has(marcador)) {
      i += 2;
      continue;
    }
    const largo = buffer.readUInt16BE(i + 2);
    if (largo < 2) return null; // un segmento no puede medir menos que su longitud
    i += largo + 2;
  }
  return null;
}

// Dimensiones declaradas en la cabecera, o null si no se reconocen.
function dimensionesImagen(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (coincide(buffer, FIRMA_PNG)) return dimensionesPng(buffer);
  if (coincide(buffer, FIRMA_JPEG)) return dimensionesJpeg(buffer);
  return null;
}

// ¿Decodificar esta imagen no cabe en el presupuesto? Sin dimensiones no se
// pronuncia: adivinar el formato no es su trabajo.
function excedePresupuesto(dims) {
  if (!dims) return false;
  if (!Number.isInteger(dims.width) || !Number.isInteger(dims.height)) return true;
  if (dims.width <= 0 || dims.height <= 0) return true;
  // Se divide en vez de multiplicar: width*height puede pasar de 2^53.
  return dims.width > MAX_PIXELES / dims.height;
}

module.exports = { MAX_PIXELES, dimensionesImagen, excedePresupuesto };
