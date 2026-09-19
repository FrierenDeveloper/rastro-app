// Pruebas del buscador de direcciones (backend/routes/geocode.js).
//
// INFRAESTRUCTURA: no se modifica ni una línea de producción. El router se trae
// con import ESTÁTICO (para que Stryker lo relacione con estas pruebas vía
// `vitest related`) y sus dependencias (db) se sustituyen con los dobles de
// ./helpers/aislar.js, que va como PRIMER import. La API externa (Photon) se
// sustituye con vi.stubGlobal('fetch', ...) y se restaura en afterEach.
//
// El router guarda una caché en un Map a nivel de módulo (24 h, 500 entradas).
// Para los tests que necesitan caché vacía se recarga el módulo con
// olvidar(RUTAS.routesGeocode) + requerir(RUTAS.routesGeocode); el resto usa
// textos de búsqueda distintos en cada test.
//
// HALLAZGOS (no se arregla nada, solo se documenta):
//   1. El router NO recorta los resultados a 8: confía en el `limit=8` de la
//      URL. Si Photon devolviera más, se devuelven todos (test "no recorta").
//   2. La lista vacía SÍ se cachea (cacheSet va fuera del filtro), así que un
//      lugar inexistente queda cacheado 24 h (test "sin resultados").
//   3. `req.query.q.toLowerCase()...trim()` ya recibe el valor recortado por el
//      sanitizador `.trim()` de express-validator, así que ese `.trim()` final
//      es redundante (no es observable desde HTTP).
//   4. Un JSON válido con forma inesperada (null o features no-lista) NO lo
//      cubre el catch del fetch: llega a next(err) y Express responde 500
//      genérico. No se filtra el error crudo, pero tampoco es un 502.
//   5. El mensaje interno `'geocoder ' + r.status` (línea 87 del router) nunca
//      sale del catch: no llega al cliente ni a un log, así que sus mutantes no
//      son observables desde HTTP.
//   Además, el rate limit va DESPUÉS de requireAuth: sin sesión válida la
//   respuesta es 401 y la petición ni siquiera consume cupo (se comprueba).
//
// OJO con supertest: `request(app)` levanta un puerto efímero POR PETICIÓN. Esta
// suite hace cientos de peticiones (caché de 500 entradas y rate limit de 121),
// y con `request(app)` aparecía EADDRINUSE de forma intermitente. Por eso aquí
// se pasa a supertest un servidor ya escuchando (una sola vez por app) y se
// cierra todo en afterAll.
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { db, crearApp, pedir, tokenPara, olvidar, requerir, RUTAS } from './helpers/aislar.js';
import geocodeRouter from '../routes/geocode.js';

const app = crearApp({ '/api/geocode': geocodeRouter });
const servidor = app.listen(0);
const servidores = [servidor];

const RUTA = '/api/geocode';
const SUB = 'usuario-geocode';
const SQL_TOKEN = 'SELECT token_version FROM users WHERE id = $1';
const NO_AUTENTICADO = { error: 'No autenticado.' };
const SESION_INVALIDA = { error: 'Sesión inválida o expirada.' };
const SESION_CERRADA = { error: 'Tu sesión fue cerrada. Inicia sesión de nuevo.' };
const LARGO_INVALIDO = { error: 'Escribe al menos 3 caracteres.' };
const VALOR_INVALIDO = { error: 'Invalid value' };
const FALLO_BUSQUEDA = { error: 'No se pudo buscar la dirección. Intenta de nuevo.' };
const DEMASIADAS = { error: 'Demasiadas búsquedas seguidas. Espera un momento.' };
const PHOTON = 'https://photon.komoot.io/api/?q=';
const COLA = '&lat=-33.4489&lon=-70.6693&limit=8';
const AGENTE = 'Rastro/1.0 (+https://github.com/FrierenDeveloper/rastro-app)';
const TTL = 24 * 60 * 60 * 1000;

/* ------------------------------- utilidades ------------------------------- */

// Respuesta de Photon: se le pasa el objeto ya armado (features || {}).
function respuestaOk(data) {
  return { ok: true, status: 200, json: async () => data };
}

// Un resultado de Photon con la forma que consume el router.
function feature(properties = {}, coordinates = [-70.65, -33.44]) {
  return { properties: { countrycode: 'CL', ...properties }, geometry: { coordinates } };
}

let contadorTextos = 0;
function textoUnico(base = 'consulta') {
  contadorTextos += 1;
  return `${base} ${contadorTextos}`;
}

let visitas = 0;
// Cabecera válida + IP distinta en cada petición: con TRUST_PROXY=1 la clave
// del rate limit sale de x-forwarded-for, así ningún test gasta el cupo de otro.
function conToken(peticion, sub = SUB) {
  visitas += 1;
  const ip = `10.${Math.floor(visitas / 250)}.${visitas % 250}.8`;
  return peticion.set('Authorization', `Bearer ${tokenPara(sub)}`).set('x-forwarded-for', ip);
}

function buscar(q) {
  return conToken(pedir(servidor).get(RUTA).query({ q }));
}

function buscarEn(servidorPropio, q, ip) {
  const peticion = pedir(servidorPropio).get(RUTA).query({ q });
  return ip ? conToken(peticion).set('x-forwarded-for', ip) : conToken(peticion);
}

// Servidor con el router RECIÉN cargado: caché vacía y contador de rate limit
// nuevo. Se guarda para cerrarlo en afterAll.
function servidorFresco() {
  olvidar(RUTAS.routesGeocode);
  const nuevo = crearApp({ [RUTA]: requerir(RUTAS.routesGeocode) }).listen(0);
  servidores.push(nuevo);
  return nuevo;
}

// requireAuth pide token_version; la ruta de geocode no consulta nada más.
function prepararBase(tokenVersion = 0) {
  db.query.mockImplementation(async sql => {
    if (sql.includes('token_version')) return { rows: [{ token_version: tokenVersion }] };
    return { rows: [] };
  });
}

async function pedirVeces(servidorPropio, ip, texto, veces) {
  const respuestas = [];
  for (let i = 0; i < veces; i += 1) respuestas.push(await buscarEn(servidorPropio, texto, ip));
  return respuestas;
}

let dobleFetch;

beforeEach(() => {
  db.query.mockReset();
  prepararBase();
  dobleFetch = vi.fn(async () => respuestaOk({ features: [] }));
  vi.stubGlobal('fetch', dobleFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// Sin esto quedarían los servidores escuchando al terminar la suite.
afterAll(async () => {
  for (const cadaUno of servidores) {
    cadaUno.closeAllConnections();
    await new Promise(resolver => cadaUno.close(resolver));
  }
});

/* ------------------------------ autenticación ----------------------------- */

describe('autenticación de GET /api/geocode', () => {
  it('sin cabecera Authorization responde 401 y no llama al geocodificador', async () => {
    const res = await pedir(app).get(RUTA).query({ q: 'providencia' });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(dobleFetch).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un token que no es un JWT válido responde 401 sin tocar la base', async () => {
    const res = await pedir(app).get(RUTA).query({ q: 'providencia' }).set('Authorization', 'Bearer roto');

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SESION_INVALIDA);
    expect(dobleFetch).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un token válido de una cuenta que ya no existe responde 401', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await buscar('providencia');

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SESION_INVALIDA);
    expect(dobleFetch).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(SQL_TOKEN, [SUB]);
  });

  it('una sesión revocada (token_version distinta) responde 401', async () => {
    prepararBase(7);
    const res = await buscar('providencia');

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SESION_CERRADA);
    expect(dobleFetch).not.toHaveBeenCalled();
  });
});

/* --------------------------- validación de la q ---------------------------- */

describe('validación del parámetro q', () => {
  it('sin parámetro q responde 400 con "Invalid value"', async () => {
    const res = await conToken(pedir(app).get(RUTA));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(VALOR_INVALIDO);
    expect(dobleFetch).not.toHaveBeenCalled();
  });

  it('una q vacía o de solo espacios responde 400 con el mensaje de largo', async () => {
    for (const q of ['', '   ', '\t']) {
      const res = await buscar(q);

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(LARGO_INVALIDO);
    }
    expect(dobleFetch).not.toHaveBeenCalled();
  });

  it('una q de 1 o 2 caracteres (aun con espacios alrededor) responde 400', async () => {
    for (const q of ['a', 'ab', '  ab  ']) {
      const res = await buscar(q);

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(LARGO_INVALIDO);
    }
    expect(dobleFetch).not.toHaveBeenCalled();
  });

  it('una q de 121 caracteres responde 400 y una de 120 sí se busca', async () => {
    const larga = await buscar('x'.repeat(121));
    const borde = await buscar('x'.repeat(120));

    expect(larga.status).toBe(400);
    expect(larga.body).toStrictEqual(LARGO_INVALIDO);
    expect(borde.status).toBe(200);
    expect(dobleFetch).toHaveBeenCalledTimes(1);
  });

  it('una q repetida (array) responde 400 con "Invalid value"', async () => {
    const res = await conToken(pedir(app).get(RUTA).query('q=a&q=bb'));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(VALOR_INVALIDO);
    expect(dobleFetch).not.toHaveBeenCalled();
  });

  it('un array explícito q[] tampoco pasa la validación', async () => {
    const res = await conToken(pedir(app).get(RUTA).query('q[]=providencia'));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(VALOR_INVALIDO);
    expect(dobleFetch).not.toHaveBeenCalled();
  });

  // En un query string no existen los números: `?q=123` llega como el texto
  // "123" (3 caracteres), así que la validación lo acepta y se busca tal cual.
  it('una q numérica viaja como texto y se acepta', async () => {
    const res = await buscar(123);

    expect(res.status).toBe(200);
    expect(dobleFetch).toHaveBeenCalledTimes(1);
    expect(dobleFetch.mock.calls[0][0]).toBe(`${PHOTON}123${COLA}`);
  });

  it('la búsqueda llama a Photon con la URL, el agente y la señal exactos', async () => {
    const texto = textoUnico('Avenida Providencia');
    const res = await buscar(texto);

    expect(res.status).toBe(200);
    expect(dobleFetch).toHaveBeenCalledTimes(1);
    const [url, opciones] = dobleFetch.mock.calls[0];
    expect(url).toBe(`${PHOTON}${encodeURIComponent(texto)}${COLA}`);
    expect(url).toContain('q=Avenida%20Providencia');
    expect(Object.keys(opciones).sort()).toStrictEqual(['headers', 'signal']);
    expect(opciones.headers).toStrictEqual({ 'User-Agent': AGENTE });
    expect(opciones.method).toBeUndefined();
    expect(typeof opciones.signal.addEventListener).toBe('function');
    expect(opciones.signal.aborted).toBe(false);
  });
});

/* --------------------- transformación de la respuesta ---------------------- */

describe('transformación de la respuesta de Photon', () => {
  it('convierte una dirección de Photon al formato del router', async () => {
    dobleFetch.mockResolvedValue(
      respuestaOk({
        features: [
          feature(
            { name: 'Cerro San Cristóbal', street: 'Pío Nono', housenumber: '123', city: 'Recoleta' },
            [-70.6381, -33.4247]
          )
        ]
      })
    );
    const res = await buscar(textoUnico('cerro'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      results: [{ label: 'Cerro San Cristóbal, Pío Nono 123, Recoleta', lat: -33.4247, lng: -70.6381 }]
    });
  });

  it('descarta los resultados que no son de Chile', async () => {
    dobleFetch.mockResolvedValue(
      respuestaOk({
        features: [
          feature({ name: 'Obelisco', countrycode: 'AR' }, [-58.38, -34.6]),
          feature({ name: 'Plaza de Armas' }, [-70.65, -33.43]),
          feature({ name: 'Mendoza', countrycode: 'AR' }, [-68.84, -32.89])
        ]
      })
    );
    const res = await buscar(textoUnico('chile'));

    expect(res.status).toBe(200);
    expect(res.body.results).toStrictEqual([{ label: 'Plaza de Armas', lat: -33.43, lng: -70.65 }]);
  });

  it('un countrycode en minúsculas no cuenta como Chile', async () => {
    dobleFetch.mockResolvedValue(
      respuestaOk({ features: [feature({ name: 'Santiago', countrycode: 'cl' })] })
    );
    const res = await buscar(textoUnico('minusculas'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ results: [] });
  });

  it('ignora los resultados sin properties o sin geometry utilizable', async () => {
    dobleFetch.mockResolvedValue(
      respuestaOk({
        features: [
          { geometry: { coordinates: [-70.65, -33.43] } },
          feature({ name: 'Válido' }, [-70.6, -33.4])
        ]
      })
    );
    const res = await buscar(textoUnico('sin-properties'));

    expect(res.status).toBe(200);
    expect(res.body.results).toStrictEqual([{ label: 'Válido', lat: -33.4, lng: -70.6 }]);
  });

  it('un resultado sin etiqueta posible se descarta', async () => {
    dobleFetch.mockResolvedValue(respuestaOk({ features: [feature({}, [-70.65, -33.43])] }));
    const res = await buscar(textoUnico('sin-etiqueta'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ results: [] });
  });

  it('sin features en la respuesta devuelve 200 con lista vacía', async () => {
    dobleFetch.mockResolvedValue(respuestaOk({}));
    const res = await buscar(textoUnico('sin-features'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ results: [] });
  });

  it('arma la etiqueta con nombre, calle, número y comuna sin repetir valores', async () => {
    dobleFetch.mockResolvedValue(
      respuestaOk({
        features: [
          feature({
            name: 'Cerro San Cristóbal',
            street: 'Pío Nono',
            housenumber: '123',
            district: 'Recoleta'
          }),
          feature({ name: 'Santiago', district: 'Santiago', city: 'Santiago' })
        ]
      })
    );
    const res = await buscar(textoUnico('etiqueta'));

    expect(res.body.results.map(r => r.label)).toStrictEqual([
      'Cerro San Cristóbal, Pío Nono 123, Recoleta',
      'Santiago'
    ]);
  });

  it('usa district/suburb/locality y city/town/village como respaldo, en ese orden', async () => {
    dobleFetch.mockResolvedValue(
      respuestaOk({
        features: [
          feature({ district: 'Recoleta', suburb: 'Otro barrio' }),
          feature({ suburb: 'Ñuñoa' }),
          feature({ locality: 'Lo Barnechea' }),
          feature({ city: 'Santiago', town: 'Otra ciudad' }),
          feature({ town: 'San Bernardo' }),
          feature({ village: 'El Monte' })
        ]
      })
    );
    const res = await buscar(textoUnico('respaldos'));

    expect(res.body.results.map(r => r.label)).toStrictEqual([
      'Recoleta',
      'Ñuñoa',
      'Lo Barnechea',
      'Santiago',
      'San Bernardo',
      'El Monte'
    ]);
  });

  it('con solo la calle, solo el número o ambos no deja espacios de más', async () => {
    dobleFetch.mockResolvedValue(
      respuestaOk({
        features: [
          feature({ street: 'Avenida Matta' }),
          feature({ housenumber: '742' }),
          feature({ street: 'Matta', housenumber: '742' })
        ]
      })
    );
    const res = await buscar(textoUnico('calle-numero'));

    expect(res.body.results.map(r => r.label)).toStrictEqual(['Avenida Matta', '742', 'Matta 742']);
  });

  // HALLAZGO 1: el router no recorta a 8; confía en el limite pedido a Photon.
  it('no recorta los resultados: devuelve todos los de Chile que lleguen', async () => {
    const features = [];
    for (let i = 0; i < 9; i += 1) features.push(feature({ name: `Calle ${i}` }, [-70.6 - i / 100, -33.4]));
    dobleFetch.mockResolvedValue(respuestaOk({ features }));
    const res = await buscar(textoUnico('muchos'));

    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(9);
    expect(res.body.results.map(r => r.label)).toStrictEqual(features.map((_, i) => `Calle ${i}`));
  });
});

/* --------------------------- caché en memoria ------------------------------ */

describe('caché en memoria', () => {
  it('la segunda búsqueda idéntica no vuelve a llamar a Photon', async () => {
    const texto = textoUnico('cache-hit');
    dobleFetch.mockResolvedValue(respuestaOk({ features: [feature({ name: 'Providencia' })] }));

    const primera = await buscar(texto);
    const segunda = await buscar(texto);

    expect(primera.status).toBe(200);
    expect(segunda.status).toBe(200);
    expect(segunda.body).toStrictEqual(primera.body);
    expect(dobleFetch).toHaveBeenCalledTimes(1);
  });

  // HALLAZGO 2: la lista vacía también se cachea.
  it('sin resultados también cachea: la segunda consulta no llama a Photon', async () => {
    const texto = textoUnico('cache-vacia');
    dobleFetch.mockResolvedValue(respuestaOk({ features: [] }));

    const primera = await buscar(texto);
    const segunda = await buscar(texto);

    expect(primera.body).toStrictEqual({ results: [] });
    expect(segunda.body).toStrictEqual({ results: [] });
    expect(dobleFetch).toHaveBeenCalledTimes(1);
  });

  it('la clave de la caché ignora mayúsculas y espacios de más', async () => {
    dobleFetch.mockResolvedValue(respuestaOk({ features: [feature({ name: 'Ñuñoa' })] }));

    const conMayusculas = await buscar('Av  Providencia');
    const enMinusculas = await buscar('av providencia');

    expect(enMinusculas.body).toStrictEqual(conMayusculas.body);
    expect(dobleFetch).toHaveBeenCalledTimes(1);
  });

  it('mantiene el resultado justo en el TTL exacto y lo descarta un milisegundo después', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const inicio = Date.parse('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(inicio);
    const texto = textoUnico('ttl');
    dobleFetch.mockResolvedValueOnce(respuestaOk({ features: [feature({ name: 'Primera' })] }));

    const primera = await buscar(texto);
    expect(primera.body.results[0].label).toBe('Primera');

    vi.setSystemTime(inicio + TTL - 1000);
    const casi = await buscar(texto);
    expect(casi.body).toStrictEqual(primera.body);

    // Borde exacto (expires === ahora): todavía es un acierto.
    vi.setSystemTime(inicio + TTL);
    const borde = await buscar(texto);
    expect(borde.body).toStrictEqual(primera.body);
    expect(dobleFetch).toHaveBeenCalledTimes(1);

    // Un milisegundo más: caduca, se borra y se vuelve a pedir a Photon.
    vi.setSystemTime(inicio + TTL + 1);
    dobleFetch.mockResolvedValueOnce(respuestaOk({ features: [feature({ name: 'Segunda' })] }));
    const nueva = await buscar(texto);

    expect(nueva.body.results[0].label).toBe('Segunda');
    expect(dobleFetch).toHaveBeenCalledTimes(2);
    expect(dobleFetch.mock.calls[1][0]).toBe(dobleFetch.mock.calls[0][0]);
  });

  it('con más de 500 búsquedas distintas descarta la entrada más antigua', async () => {
    const servidorPropio = servidorFresco();
    const prefijo = textoUnico('relleno-cache');
    dobleFetch.mockResolvedValue(respuestaOk({ features: [feature({ name: 'Relleno' })] }));

    const claves = [];
    for (let i = 0; i < 501; i += 1) claves.push(`${prefijo} ${i}`);
    for (let i = 0; i < 500; i += 1) await buscarEn(servidorPropio, claves[i]);
    expect(dobleFetch).toHaveBeenCalledTimes(500);

    // La 501ª entrada llena la caché (500) y desaloja la más antigua.
    await buscarEn(servidorPropio, claves[500]);
    expect(dobleFetch).toHaveBeenCalledTimes(501);

    await buscarEn(servidorPropio, claves[0]);
    expect(dobleFetch).toHaveBeenCalledTimes(502);
    await buscarEn(servidorPropio, claves[500]);
    expect(dobleFetch).toHaveBeenCalledTimes(502);
    await buscarEn(servidorPropio, claves[499]);
    expect(dobleFetch).toHaveBeenCalledTimes(502);
  }, 120000);
});

/* --------------------- fallos del servicio externo ------------------------- */

describe('fallos del geocodificador externo', () => {
  it('si fetch rechaza responde 502 con un mensaje controlado y sin el error crudo', async () => {
    dobleFetch.mockRejectedValue(new Error('ECONNREFUSED 51.15.1.1:443'));
    const res = await buscar(textoUnico('caida'));

    expect(res.status).toBe(502);
    expect(res.body).toStrictEqual(FALLO_BUSQUEDA);
    expect(JSON.stringify(res.body)).not.toContain('ECONNREFUSED');
    expect(JSON.stringify(res.body)).not.toContain('geocoder');
  });

  it('una respuesta HTTP que no es ok responde 502 y no intenta leer el JSON', async () => {
    const json = vi.fn(async () => ({ features: [] }));
    dobleFetch.mockResolvedValue({ ok: false, status: 500, json });
    const res = await buscar(textoUnico('error-500'));

    expect(res.status).toBe(502);
    expect(res.body).toStrictEqual(FALLO_BUSQUEDA);
    expect(json).not.toHaveBeenCalled();
  });

  it('un JSON inválido responde 502 con el mensaje controlado', async () => {
    dobleFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('Unexpected token < in JSON at position 0');
      }
    });
    const res = await buscar(textoUnico('json-roto'));

    expect(res.status).toBe(502);
    expect(res.body).toStrictEqual(FALLO_BUSQUEDA);
    expect(JSON.stringify(res.body)).not.toContain('Unexpected token');
  });

  // HALLAZGO 4: el catch solo cubre fetch/json; una forma inesperada va a
  // next(err) y Express responde 500 genérico (sin filtrar el error al cliente).
  it('un JSON válido con forma inesperada termina en un 500 genérico', async () => {
    dobleFetch.mockResolvedValueOnce(respuestaOk(null));
    const nulo = await buscar(textoUnico('json-nulo'));

    dobleFetch.mockResolvedValueOnce(respuestaOk({ features: 'no-es-una-lista' }));
    const raro = await buscar(textoUnico('json-raro'));

    expect(nulo.status).toBe(500);
    expect(raro.status).toBe(500);
    expect(JSON.stringify(nulo.body)).not.toContain('TypeError');
  });

  // En vez de falsificar TODOS los temporizadores (rompe la petición HTTP de
  // supertest), se intercepta solo el de 8 s del router: así el plazo se cumple
  // a voluntad y el test no espera 8 segundos reales.
  it('si Photon no contesta en 8 segundos aborta la petición y responde 502', async () => {
    const setTimeoutReal = globalThis.setTimeout;
    const clearTimeoutReal = globalThis.clearTimeout;
    const plazos = new Map();
    vi.stubGlobal('setTimeout', (fn, ms, ...resto) => {
      if (ms === 8000) {
        const id = { fn };
        plazos.set(id, fn);
        return id;
      }
      return setTimeoutReal(fn, ms, ...resto);
    });
    vi.stubGlobal('clearTimeout', id => {
      if (id && plazos.has(id)) {
        plazos.delete(id);
        return undefined;
      }
      return clearTimeoutReal(id);
    });

    let senal = null;
    let desbloquear = null;
    let avisarLlegada = null;
    const llegoAFetch = new Promise(resolver => {
      avisarLlegada = resolver;
    });
    dobleFetch.mockImplementation((url, opciones) => {
      senal = opciones.signal;
      avisarLlegada();
      return new Promise((_resolver, rechazar) => {
        desbloquear = rechazar;
        opciones.signal.addEventListener('abort', () => rechazar(new Error('abortado')));
      });
    });

    const pendiente = buscar(textoUnico('lento'));
    let respuesta = null;
    // Si la petición se resolviera sin llegar a Photon (401, 429, caché...), el
    // test falla al instante en vez de quedarse esperando para siempre.
    const quienGana = Promise.race([
      llegoAFetch.then(() => 'fetch'),
      pendiente.then(res => {
        respuesta = res;
        return 'respuesta';
      })
    ]);
    try {
      expect(await quienGana).toBe('fetch');
      expect(respuesta).toBe(null);
      expect(senal.aborted).toBe(false);
      expect(plazos.size).toBe(1); // el router programó el plazo de 8 s
      for (const [id, fn] of plazos) {
        plazos.delete(id);
        fn();
      }
      expect(senal.aborted).toBe(true);

      const res = await pendiente;
      expect(res.status).toBe(502);
      expect(res.body).toStrictEqual(FALLO_BUSQUEDA);
    } finally {
      if (desbloquear) desbloquear(new Error('fin de la prueba'));
    }
  }, 30000);

  it('limpia el plazo de 8 s cuando Photon responde a tiempo', async () => {
    const setTimeoutReal = globalThis.setTimeout;
    const clearTimeoutReal = globalThis.clearTimeout;
    const plazos = new Map();
    vi.stubGlobal('setTimeout', (fn, ms, ...resto) => {
      if (ms === 8000) {
        const id = { fn };
        plazos.set(id, fn);
        return id;
      }
      return setTimeoutReal(fn, ms, ...resto);
    });
    vi.stubGlobal('clearTimeout', id => {
      if (id && plazos.has(id)) {
        plazos.delete(id);
        return undefined;
      }
      return clearTimeoutReal(id);
    });
    dobleFetch.mockResolvedValue(respuestaOk({ features: [] }));

    const res = await buscar(textoUnico('timer'));

    expect(res.status).toBe(200);
    expect(plazos.size).toBe(0); // el router canceló el plazo al recibir la respuesta
  });
});

/* ---------------------------- rate limit propio ---------------------------- */

describe('límite de búsquedas por IP', () => {
  it('la petición 121 de la misma IP responde 429 y la ventana se reinicia a los 15 minutos', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const servidorPropio = servidorFresco();
    const ip = '203.0.113.7';
    const texto = textoUnico('limite');
    dobleFetch.mockResolvedValue(respuestaOk({ features: [feature({ name: 'Centro' })] }));

    const respuestas = await pedirVeces(servidorPropio, ip, texto, 121);

    expect(respuestas[0].status).toBe(200);
    expect(respuestas[119].status).toBe(200);
    expect(respuestas[120].status).toBe(429);
    expect(respuestas[120].body).toStrictEqual(DEMASIADAS);
    expect(dobleFetch).toHaveBeenCalledTimes(1); // las demás salen de la caché

    expect(respuestas[0].headers['ratelimit-limit']).toBe('120');
    expect(respuestas[0].headers['ratelimit-policy']).toBe('120;w=900');
    expect(respuestas[0].headers['ratelimit-remaining']).toBe('119');
    expect(respuestas[0].headers['x-ratelimit-limit']).toBeUndefined();

    vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1);
    const despues = await buscarEn(servidorPropio, texto, ip);
    expect(despues.status).toBe(200);
    expect(despues.headers['ratelimit-remaining']).toBe('119');
  }, 120000);

  it('cada IP tiene su propio cupo', async () => {
    const servidorPropio = servidorFresco();
    const texto = textoUnico('por-ip');
    dobleFetch.mockResolvedValue(respuestaOk({ features: [] }));

    const primera = await buscarEn(servidorPropio, texto, '198.51.100.10');
    const segunda = await buscarEn(servidorPropio, texto, '198.51.100.11');
    const tercera = await buscarEn(servidorPropio, texto, '2001:db8::1');

    expect([primera.status, segunda.status, tercera.status]).toStrictEqual([200, 200, 200]);
    expect([
      primera.headers['ratelimit-remaining'],
      segunda.headers['ratelimit-remaining'],
      tercera.headers['ratelimit-remaining']
    ]).toStrictEqual(['119', '119', '119']);
    expect(dobleFetch).toHaveBeenCalledTimes(1);
  });
});
