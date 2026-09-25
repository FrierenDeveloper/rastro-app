// push-endpoint.js
// Valida el `endpoint` de una suscripción Web Push ANTES de guardarlo.
//
// Por qué existe: ese endpoint lo elige quien se suscribe, y el servidor hace
// con él una petición HTTPS saliente (web-push llama a https.request contra el
// host que venga, sin lista blanca y sin bloquear rangos privados). Sin validar,
// un usuario autenticado puede apuntarlo a 127.0.0.1 o a cualquier host interno
// y usar el servidor como proxy ciego (SSRF), además de como amplificador si
// registra muchas suscripciones al mismo destino.
//
// Se bloquea la CLASE de destino peligroso (esquema, loopback, rangos privados,
// link-local, CGNAT, metadata de nube) en vez de permitir sólo una lista de
// servicios push conocidos: una lista blanca se queda corta cada vez que un
// navegador cambia de proveedor y dejaría sin notificaciones a usuarios reales.
//
// LÍMITE CONOCIDO: un nombre de dominio que RESUELVA a una IP privada (DNS
// rebinding) pasa esta validación, porque comprobarlo exigiría resolver el DNS
// aquí. Cubre el caso directo, que es el que está al alcance de cualquiera.
//
// Es lógica PURA: no toca disco, base de datos ni red.
'use strict';

const MAX_LARGO = 2000;

// Nombres que nunca deben alcanzarse desde el servidor aunque no sean una IP.
const NOMBRES_PROHIBIDOS = new Set(['localhost']);
const SUFIJOS_PROHIBIDOS = ['.localhost', '.local', '.internal', '.home.arpa'];

// Rangos IPv4 que no deben alcanzarse, como pares [desde, hasta] inclusivos.
// Se comparan como enteros de 32 bits para no repetir comparaciones por octeto.
const RANGOS_IPV4_PROHIBIDOS = [
  ['0.0.0.0', '0.255.255.255'], // "este host"
  ['10.0.0.0', '10.255.255.255'], // red privada
  ['100.64.0.0', '100.127.255.255'], // CGNAT
  ['127.0.0.0', '127.255.255.255'], // loopback
  ['169.254.0.0', '169.254.255.255'], // link-local y metadata de nube
  ['172.16.0.0', '172.31.255.255'], // red privada
  ['192.168.0.0', '192.168.255.255'] // red privada
];

// Prefijos IPv6 prohibidos: loopback, sin especificar, unique-local (fc00::/7)
// y link-local (fe80::/10). El prefijo '::' cubre además las IPv4 mapeadas
// (::ffff:127.0.0.1), que son otra forma de llegar a loopback.
const PREFIJOS_IPV6_PROHIBIDOS = ['::', 'fc', 'fd', 'fe8', 'fe9', 'fea', 'feb'];

const RE_IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

// Los hostnames IPv6 llegan entre corchetes ("[::1]").
function sinCorchetes(host) {
  return host.replace(/^\[|\]$/g, '');
}

function aEntero(ip) {
  const [a, b, c, d] = ip.split('.').map(Number);
  return a * 16777216 + b * 65536 + c * 256 + d;
}

function ipv4Prohibida(host) {
  if (!RE_IPV4.test(host)) return false;
  const valor = aEntero(host);
  return RANGOS_IPV4_PROHIBIDOS.some(([desde, hasta]) => valor >= aEntero(desde) && valor <= aEntero(hasta));
}

function ipv6Prohibida(host) {
  const h = host.toLowerCase();
  return PREFIJOS_IPV6_PROHIBIDOS.some(prefijo => h === prefijo || h.startsWith(prefijo));
}

function esIpProhibida(host) {
  return host.includes(':') ? ipv6Prohibida(host) : ipv4Prohibida(host);
}

function nombreProhibido(host) {
  const h = host.toLowerCase();
  return NOMBRES_PROHIBIDOS.has(h) || SUFIJOS_PROHIBIDOS.some(sufijo => h.endsWith(sufijo));
}

/**
 * Devuelve null si el endpoint se puede usar, o el motivo del rechazo.
 * @param {unknown} valor endpoint tal como llegó del cliente
 */
function validarEndpoint(valor) {
  if (typeof valor !== 'string' || !valor.trim() || valor.length > MAX_LARGO)
    return 'El endpoint de la suscripción no es válido.';
  let url;
  try {
    url = new URL(valor);
  } catch {
    return 'El endpoint de la suscripción no es una URL válida.';
  }
  // Web Push siempre es HTTPS; exigirlo corta de paso file:, gopher: y demás.
  if (url.protocol !== 'https:') return 'El endpoint de la suscripción debe usar HTTPS.';
  // El WHATWG URL normaliza las formas ofuscadas de IPv4 (0x7f.0.0.1, 0177.0.0.1,
  // 2130706433, 127.1) a decimal punteado, así que mirar el hostname ya
  // normalizado basta para no dejarse ninguna puerta abierta.
  const host = sinCorchetes(url.hostname);
  if (nombreProhibido(host) || esIpProhibida(host)) {
    return 'El endpoint de la suscripción apunta a una dirección no permitida.';
  }
  return null;
}

module.exports = { validarEndpoint, MAX_LARGO };
