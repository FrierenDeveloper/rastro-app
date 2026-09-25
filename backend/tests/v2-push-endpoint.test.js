// Pruebas de backend/src/v2/push-endpoint.js.
//
// Por qué existe: el `endpoint` de una suscripción Web Push lo elige el cliente
// y el servidor hace con él una petición HTTPS SALIENTE (web-push llama a
// https.request contra el host que venga, sin lista blanca ni bloqueo de rangos
// privados). Sin validar, un usuario autenticado puede apuntarlo a 127.0.0.1 o a
// cualquier host interno y usar el servidor como proxy ciego (SSRF), además de
// como amplificador registrando muchas suscripciones al mismo destino.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Se carga con require (igual que routes/push.js en producción): si el módulo
// se importara por ESM y por CJS a la vez, V8 contaría dos veces el mismo
// archivo y la cobertura de src/v2 daría ramas fantasma sin cubrir.
const require = createRequire(import.meta.url);
const { validarEndpoint, MAX_LARGO } = require('../src/v2/push-endpoint.js');

const NO_VALIDO = 'El endpoint de la suscripción no es válido.';
const NO_URL = 'El endpoint de la suscripción no es una URL válida.';
const NO_HTTPS = 'El endpoint de la suscripción debe usar HTTPS.';
const NO_PERMITIDA = 'El endpoint de la suscripción apunta a una dirección no permitida.';

describe('validarEndpoint — acepta endpoints legítimos', () => {
  it.each([
    ['Chrome/FCM', 'https://fcm.googleapis.com/fcm/send/abc123'],
    ['Firefox', 'https://updates.push.services.mozilla.com/wpush/v2/abc'],
    ['Safari', 'https://web.push.apple.com/QABC'],
    ['Edge/WNS', 'https://wns2-bn1305.notify.windows.com/w/?token=abc'],
    ['un host propio', 'https://push.ejemplo.cl/1'],
    ['con puerto', 'https://fcm.googleapis.com:443/fcm/send/abc'],
    ['IP pública IPv4', 'https://8.8.8.8/x'],
    ['IP pública IPv6', 'https://[2606:4700:4700::1111]/x']
  ])('%s', (_caso, endpoint) => {
    expect(validarEndpoint(endpoint)).toBeNull();
  });
});

describe('validarEndpoint — rechaza lo que no es una URL utilizable', () => {
  it('una cadena que no es URL', () => {
    expect(validarEndpoint('no-es-una-url')).toBe(NO_URL);
  });

  it('vacía o solo espacios', () => {
    expect(validarEndpoint('')).toBe(NO_VALIDO);
    expect(validarEndpoint('    ')).toBe(NO_VALIDO);
  });

  it('valores que no son texto', () => {
    expect(validarEndpoint(null)).toBe(NO_VALIDO);
    expect(validarEndpoint(undefined)).toBe(NO_VALIDO);
    expect(validarEndpoint(123)).toBe(NO_VALIDO);
    expect(validarEndpoint({})).toBe(NO_VALIDO);
  });

  it('más larga que el tope (2000)', () => {
    expect(validarEndpoint('https://fcm.googleapis.com/' + 'a'.repeat(MAX_LARGO))).toBe(NO_VALIDO);
  });

  it('justo en el tope sí se evalúa (y pasa si es legítima)', () => {
    const relleno = 'a'.repeat(MAX_LARGO - 'https://fcm.googleapis.com/'.length);
    const endpoint = 'https://fcm.googleapis.com/' + relleno;
    expect(endpoint.length).toBe(MAX_LARGO);
    expect(validarEndpoint(endpoint)).toBeNull();
  });

  it('esquemas que no son HTTPS', () => {
    expect(validarEndpoint('http://fcm.googleapis.com/x')).toBe(NO_HTTPS);
    expect(validarEndpoint('ftp://fcm.googleapis.com/x')).toBe(NO_HTTPS);
    expect(validarEndpoint('file:///etc/passwd')).toBe(NO_HTTPS);
  });
});

describe('validarEndpoint — rechaza direcciones internas (el SSRF)', () => {
  it.each([
    ['loopback', '127.0.0.1'],
    ['loopback en forma corta', '127.1'],
    ['loopback en hexadecimal', '0x7f.0.0.1'],
    ['loopback en octal', '0177.0.0.1'],
    ['loopback como entero decimal', '2130706433'],
    ['"este host"', '0.0.0.0'],
    ['red privada 10/8', '10.1.2.3'],
    ['red privada 172.16/12', '172.16.0.1'],
    ['borde alto de 172.16/12', '172.31.255.255'],
    ['red privada 192.168/16', '192.168.1.1'],
    ['link-local', '169.254.1.1'],
    ['metadata de nube', '169.254.169.254'],
    ['CGNAT', '100.64.0.1'],
    ['borde alto de CGNAT', '100.127.255.255']
  ])('IPv4 %s', (_caso, ip) => {
    expect(validarEndpoint(`https://${ip}/x`)).toBe(NO_PERMITIDA);
  });

  it.each([
    ['loopback', '[::1]'],
    ['sin especificar', '[::]'],
    ['unique-local fc00::/7', '[fc00::1]'],
    ['unique-local fd00::/8', '[fd12:3456::1]'],
    ['link-local fe80::/10', '[fe80::1]'],
    ['IPv4 mapeada en IPv6', '[::ffff:127.0.0.1]']
  ])('IPv6 %s', (_caso, ip) => {
    expect(validarEndpoint(`https://${ip}/x`)).toBe(NO_PERMITIDA);
  });

  it.each([
    ['localhost', 'localhost'],
    ['subdominio de localhost', 'foo.localhost'],
    ['sufijo .local', 'impresora.local'],
    ['sufijo .internal', 'api.internal'],
    ['sufijo .home.arpa', 'router.home.arpa']
  ])('nombre %s', (_caso, host) => {
    expect(validarEndpoint(`https://${host}/x`)).toBe(NO_PERMITIDA);
  });

  it('una IP privada justo por encima de un rango prohibido sí se acepta', () => {
    // 100.128.0.0 queda fuera de CGNAT (100.64.0.0-100.127.255.255): sirve para
    // comprobar que la comparación tiene dos extremos y no sólo el de abajo.
    expect(validarEndpoint('https://100.128.0.1/x')).toBeNull();
    expect(validarEndpoint('https://172.32.0.1/x')).toBeNull();
    expect(validarEndpoint('https://192.169.0.1/x')).toBeNull();
  });
});
