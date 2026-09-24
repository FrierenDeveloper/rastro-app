import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dominioDeCorreo, esDominioTemporal, esCorreoTemporal } = require('../src/v2/disposable-email.js');

const DOMINIOS_TEMPORALES = [
  '10minutemail.com',
  'disposablemail.com',
  'emailondeck.com',
  'fakemail.net',
  'getnada.com',
  'grr.la',
  'guerrillamail.com',
  'guerrillamailblock.com',
  'maildrop.cc',
  'mailinator.com',
  'moakt.com',
  'mytemp.email',
  'sharklasers.com',
  'temp-mail.org',
  'tempail.com',
  'tempmail.com',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com'
];

describe('dominioDeCorreo', () => {
  it('normaliza el dominio y conserva la última arroba como separador', () => {
    expect(dominioDeCorreo(' Persona@Sub.Mailinator.COM ')).toBe('sub.mailinator.com');
    expect(dominioDeCorreo('nombre@equipo@dominio.cl')).toBe('dominio.cl');
  });

  it('rechaza valores vacíos, no textuales o sin ambas partes', () => {
    for (const correo of [null, undefined, 42, '', '@dominio.cl', 'persona@', 'sin-arroba']) {
      expect(dominioDeCorreo(correo)).toBe('');
    }
  });
});

describe('esDominioTemporal', () => {
  it('bloquea dominios conocidos y cualquiera de sus subdominios', () => {
    for (const dominio of DOMINIOS_TEMPORALES) expect(esDominioTemporal(dominio)).toBe(true);
    expect(esDominioTemporal('entrada.guerrillamail.com')).toBe(true);
    expect(esDominioTemporal('YOPMAIL.COM')).toBe(true);
  });

  it('no confunde un dominio legítimo parecido ni acepta un dominio vacío', () => {
    expect(esDominioTemporal('notmailinator.com')).toBe(false);
    expect(esDominioTemporal('gmail.com')).toBe(false);
    expect(esDominioTemporal('')).toBe(false);
  });

  it('admite una lista adicional configurable, limpia espacios y descarta vacíos', () => {
    const adicionales = ' temporal.cl, , OTRO.test ';
    expect(esDominioTemporal('temporal.cl', adicionales)).toBe(true);
    expect(esDominioTemporal('sub.otro.test', adicionales)).toBe(true);
    expect(esDominioTemporal('estable.cl', adicionales)).toBe(false);
    expect(esDominioTemporal('estable.cl', null)).toBe(false);
  });
});

describe('esCorreoTemporal', () => {
  it('evalúa el dominio de un correo completo', () => {
    expect(esCorreoTemporal('persona@10minutemail.com')).toBe(true);
    expect(esCorreoTemporal('persona@correo.cl')).toBe(false);
  });

  it('un correo inválido o nulo no se clasifica aquí como temporal', () => {
    expect(esCorreoTemporal(null)).toBe(false);
    expect(esCorreoTemporal('sin-arroba')).toBe(false);
  });
});
