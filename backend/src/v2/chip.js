// chip.js
// Microchip de identificación (ISO 11784/11785) tratado como dato PRIVADO.
//
// Es lógica PURA salvo por el uso de crypto de Node: no toca base de datos ni
// red, y el secreto entra SIEMPRE por parámetro (nunca se lee process.env aquí),
// para poder probar todos los caminos.
//
// Regla de oro: el número del chip no se guarda ni se devuelve en claro.
//   * huella()   -> HMAC-SHA256. Es lo único que se compara y se indexa.
//   * cifrar()   -> AES-256-GCM. Permite que el DUEÑO lo vea con un botón.
//   * enmascarar -> lo que se puede mostrar sin revelar nada (•••• 1234).
//
// Formato: se aceptan de 9 a 15 dígitos. La norma ISO fija 15, pero existen
// chips anteriores a 1996 de 9 y 10 dígitos y lectores que los vuelcan así; se
// rellenan con ceros a la izquierda hasta 15 para que un chip corto y el mismo
// chip con ceros sean el MISMO. A propósito NO se valida el dígito de control
// ISO: muchos transpondedores no-ISO no lo cumplen y rechazarlos por eso
// impediría una coincidencia real (un falso negativo aquí es una mascota que no
// vuelve a casa).
'use strict';

const crypto = require('crypto');

const LARGO_MINIMO = 9;
const LARGO_ISO = 15;
// Marca de versión del formato cifrado: permite cambiar el algoritmo en el
// futuro sin romper lo ya guardado.
const MARCA = 'v1';
const SEPARADORES = /[\s\-._/]/g;
const PREFIJO_ISO = /^iso/i;
// Contexto de derivación de la clave de cifrado a partir del secreto.
const CONTEXTO = 'rastro-chip-v1';

// Deja solo lo significativo: fuera separadores y fuera el prefijo "ISO" que
// imprimen algunos lectores. No borra letras a propósito: si alguien teclea
// letras, esValido() tiene que poder rechazarlo en vez de "arreglarlo".
function normalizar(valor) {
  if (valor == null) return '';
  return String(valor).trim().replace(PREFIJO_ISO, '').replace(SEPARADORES, '');
}

// ¿Es un chip declarable? Solo dígitos y entre 9 y 15.
function esValido(valor) {
  const n = normalizar(valor);
  return /^[0-9]+$/.test(n) && n.length >= LARGO_MINIMO && n.length <= LARGO_ISO;
}

// Forma canónica: 15 dígitos con ceros a la izquierda. Cadena vacía si el valor
// no es válido, para que quien llame no guarde basura por descuido.
function canonico(valor) {
  if (!esValido(valor)) return '';
  return normalizar(valor).padStart(LARGO_ISO, '0');
}

// Lo único que se puede enseñar sin revelar el número: los últimos 4 dígitos.
function enmascarar(valor) {
  const n = normalizar(valor);
  if (!n) return '';
  if (n.length <= 4) return n;
  return '•'.repeat(n.length - 4) + ' ' + n.slice(-4);
}

// Un secreto ausente no se sustituye por uno por defecto: sin secreto no hay
// chip (fail-closed). Un HMAC con clave vacía sería reversible por diccionario.
function haySecreto(secreto) {
  return typeof secreto === 'string' && secreto.length > 0;
}

function clave(secreto) {
  const sal = Buffer.alloc(0);
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secreto, 'utf8'), sal, Buffer.from(CONTEXTO), 32));
}

// Huella con la que se compara. Nunca se devuelve al cliente.
function huella(valor, secreto) {
  const c = canonico(valor);
  if (!c || !haySecreto(secreto)) return '';
  return crypto.createHmac('sha256', secreto).update(c).digest('hex');
}

// Cifra el chip para poder mostrárselo después a su dueño.
function cifrar(valor, secreto) {
  const c = canonico(valor);
  if (!c || !haySecreto(secreto)) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', clave(secreto), iv);
  const datos = Buffer.concat([cipher.update(c, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [MARCA, iv.toString('base64'), tag.toString('base64'), datos.toString('base64')].join('.');
}

// Devuelve el chip canónico, o null si el texto no es nuestro o está manipulado
// (el tag de GCM lo detecta).
function descifrar(texto, secreto) {
  if (!haySecreto(secreto) || typeof texto !== 'string') return null;
  const partes = texto.split('.');
  if (partes.length !== 4 || partes[0] !== MARCA) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', clave(secreto), Buffer.from(partes[1], 'base64'));
    decipher.setAuthTag(Buffer.from(partes[2], 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(partes[3], 'base64')), decipher.final()]).toString(
      'utf8'
    );
  } catch {
    return null;
  }
}

module.exports = {
  normalizar,
  esValido,
  canonico,
  enmascarar,
  haySecreto,
  huella,
  cifrar,
  descifrar,
  LARGO_MINIMO,
  LARGO_ISO
};
