'use strict';

const DOMINIOS_TEMPORALES = new Set([
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
]);

function normalizarTexto(valor) {
  return typeof valor === 'string' ? valor.trim().toLowerCase() : '';
}

function dominioDeCorreo(correo) {
  const texto = normalizarTexto(correo);
  const separador = texto.lastIndexOf('@');
  if (separador <= 0 || separador === texto.length - 1) return '';
  return texto.slice(separador + 1);
}

function listaAdicional(valor) {
  return normalizarTexto(valor)
    .split(',')
    .map(dominio => dominio.trim())
    .filter(Boolean);
}

function coincideDominio(dominio, bloqueado) {
  return dominio === bloqueado || dominio.endsWith(`.${bloqueado}`);
}

function esDominioTemporal(valor, adicionales = process.env.DISPOSABLE_EMAIL_DOMAINS) {
  const dominio = normalizarTexto(valor);
  if (!dominio) return false;
  return [...DOMINIOS_TEMPORALES, ...listaAdicional(adicionales)].some(bloqueado =>
    coincideDominio(dominio, bloqueado)
  );
}

function esCorreoTemporal(correo, adicionales) {
  const dominio = dominioDeCorreo(correo);
  return dominio ? esDominioTemporal(dominio, adicionales) : false;
}

module.exports = { dominioDeCorreo, esDominioTemporal, esCorreoTemporal };
