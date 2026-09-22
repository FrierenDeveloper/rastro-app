// Base de la suite del backend: entorno de pruebas + utilidades.
//
// OJO: este archivo NO es un archivo de pruebas (no termina en ".test.js", así
// que Vitest no lo recolecta). No importa ni modifica código de producción.
//
// ---------------------------------------------------------------------------
// LO PRIMERO QUE HAY QUE ENTENDER (vale para todos los tests)
// ---------------------------------------------------------------------------
// Stryker elige los tests de cada mutante con `vitest related`, que mira el
// GRAFO DE IMPORTS de Vite. Si un test carga el módulo a probar con require()
// desde dentro de un test, el grafo no lo ve y Stryker cree que ese mutante no
// tiene tests ("No tests were executed", mutantes "no coverage"). Por eso:
//
//   * el archivo a cubrir se trae SIEMPRE con `import` (estático) en el test;
//   * sus dependencias se sustituyen ANTES, importando uno de estos helpers
//     como PRIMER import (los imports se evalúan en orden de declaración).
//
// Y para sustituir dependencias no sirve `vi.mock('../db.js')`: Vitest
// externaliza los CommonJS del proyecto (package.json dice "type": "commonjs"),
// así que el `require('../db')` interno de una ruta carga el módulo real (se ve
// como ECONNREFUSED de Postgres). Lo que sí funciona es inyectar el doble en
// require.cache, que es lo que hacen `externos.js` y `aislar.js`.
// ---------------------------------------------------------------------------
import { createRequire } from 'node:module';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

// El entorno de pruebas se fija aquí, al evaluarse este módulo: siempre antes
// que el módulo a probar (por el orden de los imports del test).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-pruebas-rastro';
// Secreto propio del microchip (en producción lo exige server.js al arrancar).
// Es distinto del de sesión a propósito: así ninguna prueba puede pasar por
// accidente si el chip volviera a depender de JWT_SECRET.
process.env.CHIP_SECRET = process.env.CHIP_SECRET || 'chip-secreto-de-pruebas';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://pruebas:pruebas@localhost:5432/pruebas';
process.env.NODE_ENV = 'test';
// Con TRUST_PROXY=1, ipReal() usa la cabecera X-Forwarded-For: así cada test de
// rutas puede usar su propio cupo de rate limit con una IP distinta y no choca
// con el límite que dejan los tests anteriores.
process.env.TRUST_PROXY = process.env.TRUST_PROXY || '1';

// El secreto de pruebas: los tokens se firman con él y los middlewares lo leen
// de process.env.JWT_SECRET, así que tienen que coincidir.
export const SECRETO = process.env.JWT_SECRET;

// require con las rutas relativas de este directorio (tests/helpers/).
export const requerir = createRequire(import.meta.url);

// Deja `dobles` como contenido del módulo indicado, de modo que cualquier
// require posterior (incluso el interno de una ruta) reciba el doble.
// La ruta se resuelve desde tests/helpers/, por eso los módulos del backend se
// nombran '../../db.js', '../../routes/...', etc.
export function inyectar(ruta, dobles) {
  const resuelta = requerir.resolve(ruta);
  requerir.cache[resuelta] = {
    id: resuelta,
    filename: resuelta,
    loaded: true,
    exports: dobles,
    children: [],
    paths: []
  };
  return dobles;
}

// Olvida un módulo ya cargado, para poder recargarlo con otro entorno:
//   olvidar(RUTAS.mailer); process.env.RESEND_API_KEY = 'x'; requerir(RUTAS.mailer);
export function olvidar(ruta) {
  delete requerir.cache[requerir.resolve(ruta)];
}

// Rutas de los módulos del backend, resueltas desde tests/helpers/.
export const RUTAS = {
  db: '../../db.js',
  storage: '../../storage.js',
  push: '../../push.js',
  mailer: '../../mailer.js',
  authMiddleware: '../../middleware/auth.js',
  clientIp: '../../middleware/client-ip.js',
  limits: '../../middleware/limits.js',
  routesAdmin: '../../routes/admin.js',
  routesAuth: '../../routes/auth.js',
  routesGeocode: '../../routes/geocode.js',
  routesPush: '../../routes/push.js',
  routesReports: '../../routes/reports.js'
};

// Monta una app Express mínima con los routers indicados. Se prefiere esto a
// require('../server'): server.js abre el puerto, inicializa la base y termina
// el proceso si falta una variable, cosas que en una prueba sobran.
//
//   const app = crearApp({ '/api/admin': adminRouter });
export function crearApp(routers = {}) {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  for (const [ruta, router] of Object.entries(routers)) app.use(ruta, router);
  return app;
}

// supertest ya envuelve la app; este alias existe para que los tests se lean
// igual sin recordar el nombre de la librería.
export function pedir(app) {
  return request(app);
}

// Token con la forma que firma routes/auth.js: { sub, ver }.
export function tokenPara(sub = 'usuario-1', ver = 0) {
  return jwt.sign({ sub, ver }, SECRETO);
}

// Respuesta falsa para probar middlewares sin levantar un servidor:
// guarda el código y el cuerpo para poder afirmarlos.
export function resFalsa() {
  const res = { codigo: null, cuerpo: null };
  res.status = codigo => {
    res.codigo = codigo;
    return res;
  };
  res.json = cuerpo => {
    res.cuerpo = cuerpo;
    return res;
  };
  res.type = () => res;
  res.send = cuerpo => {
    res.cuerpo = cuerpo;
    return res;
  };
  return res;
}

// Petición falsa: solo lo que leen los middlewares (cabeceras, socket, cuerpo).
export function reqFalsa({ headers = {}, body = {}, socket = { remoteAddress: '10.0.0.1' } } = {}) {
  return { headers, body, socket, ip: socket.remoteAddress };
}
