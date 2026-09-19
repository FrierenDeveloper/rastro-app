// Pruebas unitarias de backend/middleware/client-ip.js.
//
// Este archivo es SOLO pruebas: no toca ni depende del código de producción.
// El módulo se trae con `import` ESTÁTICO (nunca con require) porque Stryker
// elige los tests de cada mutante con `vitest related`, que mira el grafo de
// imports de Vite: un require() desde dentro de un test deja al módulo fuera
// del grafo, Stryker cree que no hay pruebas y todos los mutantes sobreviven
// (ver la explicación larga en tests/helpers/base.js).
//
// `./helpers/aislar.js` va como primer import del proyecto: fija el entorno de
// pruebas y deja dobles de db/storage/push/mailer y de las dependencias
// externas antes de que se evalúe nada más. client-ip.js es puro y no usa
// ninguno, pero así el patrón queda igual que en el resto de la suite.
//
// client-ip.js lee process.env.TRUST_PROXY DENTRO de ipReal, en tiempo de
// llamada, así que no hace falta recargarlo: cada prueba ajusta la variable y
// al terminar se restaura.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reqFalsa } from './helpers/aislar.js';
import clienteIp from '../middleware/client-ip.js';

const { ipReal, keyPorIp, keyPorCuenta, normalizarCuenta } = clienteIp;

const SOCKET = '10.0.0.1';
const IP_RESPALDO = '9.9.9.9';

// TRUST_PROXY es una variable del proceso: cada prueba parte sin ella y al
// terminar se deja como estaba para no contaminar al resto de la suite.
const TRUST_INICIAL = process.env.TRUST_PROXY;

function conProxies(valor) {
  if (valor === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = String(valor);
}

// Petición "pelada": sin socket y sin req.ip, para los caminos de respaldo.
function pedidoPelado(extra = {}) {
  return { headers: {}, ...extra };
}

// Petición con X-Forwarded-For y el socket habitual.
function conCabecera(valor) {
  return reqFalsa({ headers: { 'x-forwarded-for': valor } });
}

beforeEach(() => conProxies(undefined));
afterEach(() => conProxies(TRUST_INICIAL));

describe('ipReal: sin TRUST_PROXY manda la IP de la conexión TCP', () => {
  it('ignora X-Forwarded-For aunque venga informada', () => {
    expect(ipReal(conCabecera('1.1.1.1'))).toBe(SOCKET);
  });

  it('la IP del socket gana a req.ip cuando las dos existen y difieren', () => {
    const peticion = reqFalsa({ socket: { remoteAddress: '1.1.1.1' } });
    peticion.ip = '2.2.2.2';
    expect(ipReal(peticion)).toBe('1.1.1.1');
  });

  it('TRUST_PROXY=0 no habilita la cabecera', () => {
    conProxies(0);
    expect(ipReal(conCabecera('1.1.1.1'))).toBe(SOCKET);
    expect(ipReal(conCabecera(IP_RESPALDO))).toBe(SOCKET);
  });

  it('TRUST_PROXY=0.5 no habilita la cabecera: es finito, pero no llega a 1', () => {
    conProxies(0.5);
    expect(ipReal(conCabecera(IP_RESPALDO))).toBe(SOCKET);
  });

  it('TRUST_PROXY vacío equivale a 0', () => {
    conProxies('');
    expect(ipReal(conCabecera('1.1.1.1'))).toBe(SOCKET);
  });

  it('TRUST_PROXY con texto no numérico no habilita la cabecera', () => {
    conProxies('abc');
    expect(ipReal(conCabecera('1.1.1.1'))).toBe(SOCKET);
  });

  it('TRUST_PROXY="null" (texto) no habilita la cabecera', () => {
    conProxies('null');
    expect(ipReal(conCabecera('1.1.1.1'))).toBe(SOCKET);
  });

  it('TRUST_PROXY=Infinity no habilita la cabecera: no es un número finito', () => {
    conProxies('Infinity');
    expect(ipReal(conCabecera('1.1.1.1'))).toBe(SOCKET);
  });

  it('TRUST_PROXY=0.9 no llega al mínimo de un proxy de confianza', () => {
    conProxies(0.9);
    expect(ipReal(conCabecera('1.1.1.1'))).toBe(SOCKET);
  });

  it('TRUST_PROXY negativo no habilita la cabecera', () => {
    conProxies(-1);
    expect(ipReal(conCabecera('1.1.1.1'))).toBe(SOCKET);
  });
});

describe('ipReal: con TRUST_PROXY = 1 se usa la última entrada de la cabecera', () => {
  beforeEach(() => conProxies(1));

  it('con un proxy de confianza toma la última entrada', () => {
    expect(ipReal(conCabecera('1.1.1.1, 2.2.2.2'))).toBe('2.2.2.2');
  });

  it('con una sola entrada la devuelve tal cual', () => {
    expect(ipReal(conCabecera('3.3.3.3'))).toBe('3.3.3.3');
  });

  it('recorta los espacios de la entrada elegida', () => {
    expect(ipReal(conCabecera(' 1.1.1.1 ,   2.2.2.2  '))).toBe('2.2.2.2');
  });

  it('ignora las entradas vacías que deja un proxy descuidado', () => {
    expect(ipReal(conCabecera('1.1.1.1, , '))).toBe('1.1.1.1');
  });

  it('TRUST_PROXY con espacios alrededor se interpreta igual', () => {
    conProxies(' 1 ');
    expect(ipReal(conCabecera('1.1.1.1, 2.2.2.2'))).toBe('2.2.2.2');
  });

  it('trunca los saltos hacia abajo: 1.9 equivale a un proxy', () => {
    conProxies(1.9);
    expect(ipReal(conCabecera('1.1.1.1, 2.2.2.2'))).toBe('2.2.2.2');
  });
});

describe('ipReal: con TRUST_PROXY = 2 se usa la penúltima entrada', () => {
  beforeEach(() => conProxies(2));

  it('toma la penúltima de tres entradas', () => {
    expect(ipReal(conCabecera('1.1.1.1, 2.2.2.2, 3.3.3.3'))).toBe('2.2.2.2');
  });

  it('trunca los saltos hacia abajo: 2.7 equivale a dos proxies', () => {
    conProxies(2.7);
    expect(ipReal(conCabecera('1.1.1.1, 2.2.2.2, 3.3.3.3'))).toBe('2.2.2.2');
  });

  it('con huecos en medio, las posiciones se cuentan sobre las entradas útiles', () => {
    expect(ipReal(conCabecera('1.1.1.1, ,2.2.2.2, '))).toBe('1.1.1.1');
  });
});

describe('ipReal: cabecera inservible, se cae a la IP del socket', () => {
  beforeEach(() => conProxies(1));

  it('índice fuera de rango', () => {
    conProxies(3);
    expect(ipReal(conCabecera('1.1.1.1, 2.2.2.2'))).toBe(SOCKET);
  });

  it('cabecera vacía', () => {
    expect(ipReal(conCabecera(''))).toBe(SOCKET);
  });

  it('cabecera con solo comas y espacios', () => {
    expect(ipReal(conCabecera(' , , '))).toBe(SOCKET);
  });

  it('cabecera que no es texto (array)', () => {
    expect(ipReal(conCabecera(['1.1.1.1']))).toBe(SOCKET);
  });

  it('cabecera que no es texto (número)', () => {
    expect(ipReal(conCabecera(12345))).toBe(SOCKET);
  });

  it('cabecera undefined', () => {
    expect(ipReal(reqFalsa({ headers: { 'x-forwarded-for': undefined } }))).toBe(SOCKET);
  });

  it('sin la cabecera', () => {
    expect(ipReal(reqFalsa())).toBe(SOCKET);
  });
});

describe('ipReal: escalera de respaldo cuando no hay IP de socket', () => {
  it('sin socket usa req.ip', () => {
    expect(ipReal({ headers: {}, ip: IP_RESPALDO })).toBe(IP_RESPALDO);
  });

  it('socket sin remoteAddress usa req.ip', () => {
    expect(ipReal({ headers: {}, socket: {}, ip: IP_RESPALDO })).toBe(IP_RESPALDO);
  });

  it('remoteAddress vacío usa req.ip', () => {
    expect(ipReal({ headers: {}, socket: { remoteAddress: '' }, ip: IP_RESPALDO })).toBe(IP_RESPALDO);
  });

  it('socket null usa req.ip', () => {
    expect(ipReal({ headers: {}, socket: null, ip: IP_RESPALDO })).toBe(IP_RESPALDO);
  });

  it('sin socket ni req.ip devuelve "desconocido"', () => {
    expect(ipReal({ headers: {} })).toBe('desconocido');
  });

  it('una petición sin nada devuelve "desconocido"', () => {
    expect(ipReal({})).toBe('desconocido');
  });

  it('detrás de un proxy, sin cabecera útil, también cae a req.ip', () => {
    conProxies(2);
    expect(ipReal({ headers: {}, ip: IP_RESPALDO })).toBe(IP_RESPALDO);
  });

  it('devuelve la IPv6 del socket tal cual', () => {
    expect(ipReal(reqFalsa({ socket: { remoteAddress: '::1' } }))).toBe('::1');
  });
});

describe('keyPorIp: la clave anónima es exactamente la IP real', () => {
  it('sin proxy devuelve la IP del socket', () => {
    expect(keyPorIp(conCabecera('1.1.1.1'))).toBe(SOCKET);
  });

  it('con proxy devuelve la entrada de confianza', () => {
    conProxies(1);
    expect(keyPorIp(conCabecera('1.1.1.1, 2.2.2.2'))).toBe('2.2.2.2');
  });

  it('coincide con ipReal también en peticiones incompletas', () => {
    expect(keyPorIp({ headers: {} })).toBe(ipReal({ headers: {} }));
    expect(keyPorIp({ headers: {}, ip: IP_RESPALDO })).toBe(ipReal({ headers: {}, ip: IP_RESPALDO }));
    expect(keyPorIp(reqFalsa())).toBe(ipReal(reqFalsa()));
  });
});

describe('normalizarCuenta: agrupa variantes del mismo buzón', () => {
  it('quita el +alias', () => {
    expect(normalizarCuenta('victima+1@gmail.com')).toBe('victima@gmail.com');
  });

  it('quita todo lo que sigue al primer + (alias con varios +)', () => {
    expect(normalizarCuenta('victima+a+b@gmail.com')).toBe('victima@gmail.com');
  });

  it('pasa a minúsculas y recorta los espacios', () => {
    expect(normalizarCuenta('  VICTIMA+1@GMAIL.COM  ')).toBe('victima@gmail.com');
  });

  it('no toca los dominios sin +', () => {
    expect(normalizarCuenta('victima@x.com')).toBe('victima@x.com');
    expect(normalizarCuenta('VICTIMA@X.COM')).toBe('victima@x.com');
  });

  it('también agrupa el +alias en dominios que normalizeEmail no tocaría', () => {
    expect(normalizarCuenta('victima+1@x.com')).toBe('victima@x.com');
  });

  it('sin @ devuelve el texto normalizado tal cual', () => {
    expect(normalizarCuenta('sin-arroba')).toBe('sin-arroba');
    expect(normalizarCuenta('  SIN-ARROBA  ')).toBe('sin-arroba');
  });

  it('con el @ al principio devuelve el texto tal cual', () => {
    expect(normalizarCuenta('@x.com')).toBe('@x.com');
  });

  it('con el @ al final conserva la parte local', () => {
    expect(normalizarCuenta('a@')).toBe('a@');
  });

  it('con varios @ usa el último para partir', () => {
    expect(normalizarCuenta('a@b@c')).toBe('a@b@c');
    expect(normalizarCuenta('a+b@c@d')).toBe('a@d');
  });

  it('la cadena vacía y los espacios quedan vacíos', () => {
    expect(normalizarCuenta('')).toBe('');
    expect(normalizarCuenta('   ')).toBe('');
  });

  it('null y undefined dan cadena vacía', () => {
    expect(normalizarCuenta(null)).toBe('');
    expect(normalizarCuenta(undefined)).toBe('');
  });

  it('el 0, false y NaN dan cadena vacía', () => {
    expect(normalizarCuenta(0)).toBe('');
    expect(normalizarCuenta(false)).toBe('');
    expect(normalizarCuenta(NaN)).toBe('');
  });

  it('un número distinto de 0 se vuelve texto, no vacío', () => {
    // OJO: no devuelve '' como podría suponerse al leer el requisito:
    // String(123 || '') es '123', así que sale '123'.
    expect(normalizarCuenta(123)).toBe('123');
  });
});

describe('keyPorCuenta: prioridad correo > token/credential > IP', () => {
  it('con correo devuelve la cuenta normalizada', () => {
    expect(keyPorCuenta(reqFalsa({ body: { email: 'victima+1@gmail.com' } }))).toBe(
      'cuenta:victima@gmail.com'
    );
  });

  it('recorta los espacios del correo', () => {
    expect(keyPorCuenta(reqFalsa({ body: { email: '  VICTIMA@GMAIL.COM  ' } }))).toBe(
      'cuenta:victima@gmail.com'
    );
  });

  it('recorta la cuenta a 120 caracteres', () => {
    const correo = 'a'.repeat(200) + '@x.com';
    const clave = keyPorCuenta(reqFalsa({ body: { email: correo } }));
    expect(clave).toBe('cuenta:' + 'a'.repeat(120));
    expect(clave).toHaveLength('cuenta:'.length + 120);
  });

  it('un correo de solo espacios no cuenta: se usa el respaldo', () => {
    expect(keyPorCuenta(reqFalsa({ body: { email: '   ' } }))).toBe('ip:' + SOCKET);
    expect(keyPorCuenta(reqFalsa({ body: { email: '   ', token: 'tok-1' } }))).toBe('valor:tok-1');
  });

  it('un correo vacío cede el paso al token', () => {
    expect(keyPorCuenta(reqFalsa({ body: { email: '', token: 'tok-1' } }))).toBe('valor:tok-1');
  });

  it('un correo que no es texto cede el paso al token', () => {
    expect(keyPorCuenta(reqFalsa({ body: { email: 123, token: 'tok-1' } }))).toBe('valor:tok-1');
  });

  it('un correo null cede el paso al token', () => {
    expect(keyPorCuenta(reqFalsa({ body: { email: null, token: 'tok-1' } }))).toBe('valor:tok-1');
  });

  it('sin correo usa el token', () => {
    expect(keyPorCuenta(reqFalsa({ body: { token: 'tok-1' } }))).toBe('valor:tok-1');
  });

  it('recorta los espacios del token', () => {
    expect(keyPorCuenta(reqFalsa({ body: { token: '  tok-1  ' } }))).toBe('valor:tok-1');
  });

  it('recorta el token a 120 caracteres', () => {
    const token = 't'.repeat(200);
    const clave = keyPorCuenta(reqFalsa({ body: { token } }));
    expect(clave).toBe('valor:' + 't'.repeat(120));
    expect(clave).toHaveLength('valor:'.length + 120);
  });

  it('un token de solo espacios no cuenta: se usa el respaldo', () => {
    expect(keyPorCuenta(reqFalsa({ body: { token: '   ' } }))).toBe('ip:' + SOCKET);
  });

  it('un token que no es texto cede el paso al credential', () => {
    expect(keyPorCuenta(reqFalsa({ body: { token: 7, credential: 'cred-1' } }))).toBe('valor:cred-1');
  });

  it('sin token usa el credential de Google', () => {
    expect(keyPorCuenta(reqFalsa({ body: { credential: 'cred-1' } }))).toBe('valor:cred-1');
    expect(keyPorCuenta(reqFalsa({ body: { credential: '  cred-1  ' } }))).toBe('valor:cred-1');
  });

  it('el correo tiene prioridad sobre token y credential', () => {
    expect(keyPorCuenta(reqFalsa({ body: { email: 'a@b.com', token: 'tok', credential: 'cred' } }))).toBe(
      'cuenta:a@b.com'
    );
  });

  it('el token tiene prioridad sobre el credential', () => {
    expect(keyPorCuenta(reqFalsa({ body: { token: 'tok', credential: 'cred' } }))).toBe('valor:tok');
  });

  it('sin correo, sin token y sin credential cae a la IP', () => {
    expect(keyPorCuenta(reqFalsa())).toBe('ip:' + SOCKET);
    expect(keyPorCuenta(reqFalsa({ body: {} }))).toBe('ip:' + SOCKET);
  });

  it('token y credential que no son texto: cae a la IP', () => {
    expect(keyPorCuenta(reqFalsa({ body: { token: 7, credential: 8 } }))).toBe('ip:' + SOCKET);
    expect(keyPorCuenta(reqFalsa({ body: { credential: null } }))).toBe('ip:' + SOCKET);
  });

  it('sin body cae a la IP', () => {
    const peticion = reqFalsa();
    delete peticion.body;
    expect(keyPorCuenta(peticion)).toBe('ip:' + SOCKET);
  });

  it('con body null cae a la IP', () => {
    expect(keyPorCuenta(reqFalsa({ body: null }))).toBe('ip:' + SOCKET);
  });

  it('cae a la IP real, contando los proxies de confianza', () => {
    conProxies(1);
    expect(keyPorCuenta(reqFalsa({ headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' } }))).toBe('ip:2.2.2.2');
  });

  it('sin datos de red devuelve "ip:desconocido"', () => {
    expect(keyPorCuenta(pedidoPelado())).toBe('ip:desconocido');
  });
});
