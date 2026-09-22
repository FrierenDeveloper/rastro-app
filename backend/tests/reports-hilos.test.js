// Pruebas de la PARTE B de backend/routes/reports.js.
//
// Cubre, con supertest contra una app Express mínima:
//   GET  /api/reports/:id/poster          -> cartel imprimible con QR real
//   GET  /api/reports/:id                 -> detalle público del aviso
//   GET  /api/reports/:id/matches         -> coincidencias por radio y color
//   GET  /api/reports/:id/threads/:peerId -> hilo con la otra parte
//   POST /api/reports/:id/messages        -> enviar mensaje (+ push)
//
// El router se importa de forma ESTÁTICA y sus dependencias (db, push) se
// sustituyen con los dobles de ./helpers/aislar.js, importado ANTES: así
// `vitest related routes/reports.js` relaciona este archivo con el router y
// Stryker ejecuta estas pruebas para cada mutante.
//
// No se modificó ni una línea de producción. Las pruebas afirman el código de
// estado, el cuerpo JSON exacto y los argumentos de db.query, push.sendToUser y
// QRCode.toDataURL.
//
// HALLAZGO (inconsistencia real, NO se arregla desde aquí): en
// `POST /api/reports/:id/messages` la respuesta de validación usa
// `errors.array()[0].msg`, y `param('id').isUUID()` va sin mensaje propio. Por
// eso un `:id` con formato inválido responde 400 con el texto genérico
// "Invalid value" en lugar del "Identificador inválido." que devuelven el resto
// de los endpoints de este router (los GET lo llevan escrito a mano). Sigue
// siendo un 400 correcto; solo cambia el mensaje. Las pruebas afirman el
// comportamiento de hoy para que el día que se homogenicen salten.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db, push, crearApp, pedir, tokenPara } from './helpers/aislar.js';
import reportsRouter from '../routes/reports.js';
// La misma constante que usa la ruta (antes esta prueba replicaba 111.32 a mano).
import { KM_POR_GRADO, COS_MINIMO } from '../src/v2/geo.js';
import QRCode from 'qrcode';

const app = crearApp({ '/api/reports': reportsRouter });

/* ------------------------------- Datos fijos ------------------------------ */

const DUENO = 'duena-1'; // dueña del aviso
const VISITA = 'visita-2'; // interesada que escribe
const OTRO = 'ajeno-3'; // no participa en nada

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'; // aviso
const PEER = '9c858901-8a57-4791-81fe-4c455b099bc9'; // contraparte del hilo
const AJENO = '7c9e6679-7425-40de-944b-e07fc1f90ae7'; // usuario que no participa
const CAND_A = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';
const CAND_B = 'b1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

const SQL_AVISO = 'SELECT * FROM reports WHERE id = $1';
const NO_AUTENTICADO = { error: 'No autenticado.' };
const ID_INVALIDO = { error: 'Identificador inválido.' };
const SIN_AVISO = { error: 'Aviso no encontrado.' };
const RE_QR = /^data:image\/png;base64,/;

// Semilla de UUID v4 con la forma que inserta el router (uuidv4()).
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/* --------------------------------- Avisos --------------------------------- */

function aviso(cambios = {}) {
  return {
    id: UUID,
    user_id: DUENO,
    estado: 'perdido',
    tipo: 'perro',
    sexo: 'hembra',
    color: 'negro',
    raza: 'quiltro',
    collar: 'rojo',
    descripcion: 'Muy dócil',
    nombre_mascota: 'Firulais',
    foto_url: '/uploads/firulais.jpg',
    active: true,
    resolved: false,
    lat: -33.4489,
    lng: -70.6693,
    lat_public: -33.4489,
    lng_public: -70.6693,
    radio_km: '3.5',
    perdido_hace_horas: '48',
    created_at: '1700000000000',
    ...cambios
  };
}

function candidato(cambios = {}) {
  return {
    id: CAND_A,
    user_id: 'vecino-9',
    estado: 'encontrado',
    tipo: 'perro',
    sexo: 'macho',
    color: 'negro',
    raza: null,
    collar: null,
    descripcion: null,
    nombre_mascota: null,
    foto_url: null,
    active: true,
    resolved: false,
    lat: 0,
    lng: 0,
    lat_public: 0,
    lng_public: 0,
    radio_km: null,
    perdido_hace_horas: null,
    created_at: '1700000000000',
    ...cambios
  };
}

/* ---------------------- Doble de la base, por consulta --------------------- */

// Reglas en orden: la primera marca que aparezca en el SQL responde. El orden
// importa: `SELECT 1 FROM messages...` incluye "FROM messages", así que va antes
// que la regla genérica de mensajes.
function reglasDe(o) {
  return [
    ['token_version', () => ({ rows: o.sesionExiste === false ? [] : [{ token_version: o.version ?? 0 }] })],
    [
      'SELECT email_verified',
      () => ({ rows: o.usuarioExiste === false ? [] : [{ email_verified: o.verificado !== false }] })
    ],
    ['COUNT(*)::int AS n FROM messages', () => ({ rows: [{ n: o.mensajesHoy ?? 0 }] })],
    [SQL_AVISO, () => ({ rows: o.aviso ? [o.aviso] : [] })],
    ['SELECT 1 FROM messages WHERE report_id', () => ({ rows: o.conversacion ? [{ uno: 1 }] : [] })],
    ['LIMIT 100', () => ({ rows: o.candidatos ?? [] })],
    ['FROM messages', () => ({ rows: o.mensajes ?? [] })],
    ['INSERT INTO messages', () => ({ rows: [] })],
    ['UPDATE messages SET read = TRUE', () => ({ rows: [] })]
  ];
}

// `falla` recibe el SQL y devuelve true cuando esa consulta debe reventar.
function prepararBase(o = {}) {
  db.query.mockImplementation(async sql => {
    if (o.falla && o.falla(sql)) throw new Error('caída de la base de datos');
    const regla = reglasDe(o).find(([marca]) => String(sql).includes(marca));
    return regla ? regla[1]() : { rows: [] };
  });
}

/* ------------------------------- Peticiones ------------------------------- */

// Cupos de rate limit: cada petición sale de una IP distinta (TRUST_PROXY=1 hace
// que la clave salga de x-forwarded-for) para no agotar el cupo entre pruebas.
let visitas = 0;
function ip() {
  visitas += 1;
  return `10.${Math.floor(visitas / 200)}.${visitas % 200}.7`;
}

function conToken(peticion, sub = DUENO, ver = 0) {
  return peticion.set('Authorization', `Bearer ${tokenPara(sub, ver)}`).set('x-forwarded-for', ip());
}

function anonima(peticion) {
  return peticion.set('x-forwarded-for', ip());
}

function consultaCon(fragmento) {
  return db.query.mock.calls.find(c => String(c[0]).includes(fragmento));
}

beforeEach(() => {
  db.query.mockReset();
  push.sendToUser.mockReset();
  push.sendToUser.mockImplementation(async () => {});
  delete process.env.APP_URL;
  delete process.env.RENDER_EXTERNAL_URL;
});

afterEach(() => {
  delete process.env.APP_URL;
  delete process.env.RENDER_EXTERNAL_URL;
});

/* ===================== GET /:id/poster (cartel con QR) ==================== */

describe('GET /api/reports/:id/poster', () => {
  it('un id que no es UUID responde 400 en texto y no toca la base', async () => {
    const res = await anonima(pedir(app).get('/api/reports/no-soy-uuid/poster'));

    expect(res.status).toBe(400);
    expect(res.text).toBe('Identificador inválido.');
    expect(res.headers['content-type']).toContain('text/html');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('arma el cartel de un aviso perdido con QR, foto y todos los datos', async () => {
    process.env.APP_URL = 'https://rastro.test/';
    prepararBase({ aviso: aviso() });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}/poster`));

    const enlace = `https://rastro.test/?r=${UUID}`;
    // El QR es real y determinista: se compara con el mismo enlace y las mismas
    // opciones (margin 1, width 360). Si cambian las opciones, el data URL cambia.
    const qrEsperado = await QRCode.toDataURL(enlace, { margin: 1, width: 360 });
    expect(qrEsperado).toMatch(RE_QR);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('<title>Cartel · PetSeñal</title>');
    expect(res.text).toContain('<h1>SE BUSCA</h1>');
    expect(res.text).toContain('background:#D98A2B');
    expect(res.text).toContain(
      `<img class="foto" src="https://rastro.test/uploads/firulais.jpg" alt="Foto">`
    );
    expect(res.text).toContain('<b>Nombre</b><span>Firulais</span>');
    // La cabecera exacta: el nombre, el separador ' · ' y el lema. Si el
    // separador se muta a cadena vacía, esta comparación falla.
    expect(res.text).toContain('<p>Firulais · Ayúdame a volver a casa 🐾</p>');
    expect(res.text).toContain('<b>Tipo</b><span>perro</span>');
    expect(res.text).toContain('<b>Color</b><span>negro</span>');
    expect(res.text).toContain('<b>Raza</b><span>quiltro</span>');
    expect(res.text).toContain('<b>Sexo</b><span>hembra</span>');
    expect(res.text).toContain('<b>Collar</b><span>rojo</span>');
    expect(res.text).toContain('<b>Descripción</b><span>Muy dócil</span>');
    expect(res.text).toContain('<img src="' + qrEsperado + '" alt="Código QR">');
    expect(res.text).toContain(`<span>${enlace}</span>`);
    expect(res.text).toContain('Para guardarlo: usa Imprimir → "Guardar como PDF".');
    // La barra final de APP_URL se recorta: sin el replace el enlace sería
    // "https://rastro.test//?r=..." y el QR no coincidiría.
    expect(res.text).not.toContain('https://rastro.test//?r=');
    expect(db.query).toHaveBeenCalledWith(SQL_AVISO, [UUID]);
  });

  it('escapa el HTML de los campos que vienen de la base', async () => {
    process.env.APP_URL = 'https://rastro.test';
    prepararBase({
      aviso: aviso({
        nombre_mascota: `<b>"Firulais" & 'Rocky'</b>`,
        color: '<negro>',
        tipo: 'perro',
        raza: null,
        collar: null,
        descripcion: null,
        sexo: 'desconocido'
      })
    });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}/poster`));
    const escapado = '&lt;b&gt;&quot;Firulais&quot; &amp; &#39;Rocky&#39;&lt;/b&gt;';

    expect(res.status).toBe(200);
    expect(res.text).toContain(`<span>${escapado}</span>`);
    expect(res.text).toContain('<b>Color</b><span>&lt;negro&gt;</span>');
    expect(res.text).not.toContain('<b>"Firulais"');
    expect(res.text).not.toContain('<negro>');
    // Sin raza, sin collar y sin descripción no se pintan esas filas.
    expect(res.text).not.toContain('<b>Raza</b>');
    expect(res.text).not.toContain('<b>Collar</b>');
    expect(res.text).not.toContain('<b>Descripción</b>');
  });

  it('un aviso encontrado cambia título, color y omite los datos vacíos', async () => {
    process.env.APP_URL = 'https://rastro.test';
    prepararBase({
      aviso: aviso({
        estado: 'encontrado',
        nombre_mascota: null,
        raza: null,
        collar: null,
        descripcion: null,
        sexo: 'desconocido',
        foto_url: null
      })
    });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}/poster`));

    expect(res.status).toBe(200);
    expect(res.text).toContain('<h1>ENCONTRADO</h1>');
    expect(res.text).toContain('background:#3F8361');
    expect(res.text).not.toContain('background:#D98A2B');
    expect(res.text).toContain('<div class="sinfoto">🐾</div>');
    expect(res.text).not.toContain('<img class="foto"');
    // Sin nombre no se antepone nada al lema del cartel.
    expect(res.text).toContain('<p>Ayúdame a volver a casa 🐾</p>');
    expect(res.text).not.toContain('Firulais');
    expect(res.text).not.toContain('<b>Nombre</b>');
    expect(res.text).not.toContain('<b>Raza</b>');
    expect(res.text).not.toContain('<b>Collar</b>');
    expect(res.text).not.toContain('<b>Descripción</b>');
    expect(res.text).not.toContain('<b>Sexo</b>');
    expect(res.text).not.toContain('null');
    // Cada fila opcional ausente aporta la cadena vacía al HTML; si esa cadena
    // vacía se muta por un texto cualquiera, el cartel lo mostraría.
    expect(res.text).not.toContain('Stryker was here!');
  });

  it('una foto con URL absoluta no se prefija con la URL de la app', async () => {
    process.env.APP_URL = 'https://rastro.test';
    prepararBase({ aviso: aviso({ foto_url: 'https://cdn.test/foto.jpg' }) });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}/poster`));

    expect(res.status).toBe(200);
    expect(res.text).toContain('<img class="foto" src="https://cdn.test/foto.jpg" alt="Foto">');
    expect(res.text).not.toContain('https://rastro.test/https://cdn.test/foto.jpg');
  });

  it('detecta la URL absoluta de la foto con http:// (sin s) y con mayúsculas sólo prefija', async () => {
    process.env.APP_URL = 'https://rastro.test';

    // 'http://' es absoluta igual que 'https://': la regex acepta las dos y la
    // URL se deja intacta (sin el prefijo de la app). Una cadena vacía, en
    // cambio, no es foto.
    prepararBase({ aviso: aviso({ foto_url: 'http://cdn.test/f.jpg' }) });
    const sinS = await anonima(pedir(app).get(`/api/reports/${UUID}/poster`));

    prepararBase({ aviso: aviso({ foto_url: 'HTTPS://CDN.TEST/f.jpg' }) });
    const mayusculas = await anonima(pedir(app).get(`/api/reports/${UUID}/poster`));

    prepararBase({ aviso: aviso({ foto_url: '' }) });
    const vacia = await anonima(pedir(app).get(`/api/reports/${UUID}/poster`));

    expect(sinS.status).toBe(200);
    expect(sinS.text).toContain('<img class="foto" src="http://cdn.test/f.jpg" alt="Foto">');
    expect(sinS.text).not.toContain('https://rastro.testhttp://cdn.test/f.jpg');

    // La regex es sensible a mayúsculas: 'HTTPS://...' se toma por ruta relativa
    // y se le pega el prefijo de la app (comportamiento real de hoy).
    expect(mayusculas.status).toBe(200);
    expect(mayusculas.text).toContain('src="https://rastro.testHTTPS://CDN.TEST/f.jpg"');

    expect(vacia.status).toBe(200);
    expect(vacia.text).toContain('<div class="sinfoto">🐾</div>');
    expect(vacia.text).not.toContain('<img class="foto"');
  });

  it('usa RENDER_EXTERNAL_URL si no hay APP_URL, recortando las barras finales', async () => {
    process.env.RENDER_EXTERNAL_URL = 'https://render.test///';
    prepararBase({ aviso: aviso() });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}/poster`));

    expect(res.status).toBe(200);
    expect(res.text).toContain(`<span>https://render.test/?r=${UUID}</span>`);
    expect(res.text).toContain('src="https://render.test/uploads/firulais.jpg"');
  });

  it('sin variables de entorno usa el protocolo y el host de la petición', async () => {
    prepararBase({ aviso: aviso() });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}/poster`));

    expect(res.status).toBe(200);
    expect(res.text).toMatch(new RegExp(`http://127\\.0\\.0\\.1:\\d+/\\?r=${UUID}`));
    expect(res.text).toMatch(/src="http:\/\/127\.0\.0\.1:\d+\/uploads\/firulais\.jpg"/);
  });

  it('un aviso inexistente responde 404 en texto', async () => {
    prepararBase();

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}/poster`));

    expect(res.status).toBe(404);
    expect(res.text).toBe('Aviso no encontrado.');
  });

  it('un aviso inactivo y ajeno responde 404 aunque exista', async () => {
    prepararBase({ aviso: aviso({ active: false }) });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}/poster`));

    expect(res.status).toBe(404);
    expect(res.text).toBe('Aviso no encontrado.');
  });

  it('el dueño sí puede sacar el cartel de su aviso inactivo', async () => {
    process.env.APP_URL = 'https://rastro.test';
    prepararBase({ aviso: aviso({ active: false, estado: 'encontrado' }) });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/poster`), DUENO);

    expect(res.status).toBe(200);
    expect(res.text).toContain('<h1>ENCONTRADO</h1>');
  });

  it('un fallo de la base responde 500', async () => {
    prepararBase({ falla: sql => String(sql).includes('FROM reports') });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}/poster`));

    expect(res.status).toBe(500);
  });
});

/* ========================== GET /api/reports/:id ========================= */

describe('GET /api/reports/:id', () => {
  it('un id que no es UUID responde 400 con JSON y sin consultar la base', async () => {
    const res = await anonima(pedir(app).get('/api/reports/12345'));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(ID_INVALIDO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('devuelve el aviso público normalizado sin sesión', async () => {
    prepararBase({ aviso: aviso() });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}`));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      report: {
        id: UUID,
        estado: 'perdido',
        tipo: 'perro',
        sexo: 'hembra',
        color: 'negro',
        raza: 'quiltro',
        collar: 'rojo',
        descripcion: 'Muy dócil',
        nombre_mascota: 'Firulais',
        foto_url: '/uploads/firulais.jpg',
        resolved: false,
        es_mio: false,
        tiene_chip: false,
        chip_enmascarado: null,
        radio_km: 3.5,
        perdido_hace_horas: 48,
        lat: -33.4489,
        lng: -70.6693,
        created_at: 1700000000000
      }
    });
    // optionalAuth no consulta la base: la única consulta es la del aviso.
    expect(db.query.mock.calls).toHaveLength(1);
    expect(db.query).toHaveBeenCalledWith(SQL_AVISO, [UUID]);
  });

  it('con el token del dueño marca es_mio y sigue haciendo una sola consulta', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}`), DUENO);

    expect(res.status).toBe(200);
    expect(res.body.report.es_mio).toBe(true);
    expect(db.query.mock.calls).toHaveLength(1);
  });

  it('con el token de otra persona es_mio queda en false', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}`), VISITA);

    expect(res.status).toBe(200);
    expect(res.body.report.es_mio).toBe(false);
  });

  it('un token ilegible no rompe: el aviso se ve como anónimo', async () => {
    prepararBase({ aviso: aviso() });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}`).set('Authorization', 'Bearer basura'));

    expect(res.status).toBe(200);
    expect(res.body.report.es_mio).toBe(false);
  });

  it('solo muestra el nombre de la mascota si el aviso es de un perdido', async () => {
    prepararBase({ aviso: aviso({ estado: 'encontrado', nombre_mascota: 'Firulais' }) });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}`));

    expect(res.status).toBe(200);
    expect(res.body.report.nombre_mascota).toBeNull();
  });

  it('convierte nulos y ausentes a null/false, nunca a undefined', async () => {
    prepararBase({
      aviso: aviso({
        foto_url: null,
        resolved: undefined,
        radio_km: null,
        perdido_hace_horas: undefined,
        lat_public: null,
        lng_public: null,
        created_at: '1700000000000'
      })
    });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}`));

    expect(res.status).toBe(200);
    expect(res.body.report.foto_url).toBeNull();
    expect(res.body.report.resolved).toBe(false);
    expect(res.body.report.radio_km).toBeNull();
    expect(res.body.report.perdido_hace_horas).toBeNull();
    expect(res.body.report.lat).toBeNull();
    expect(res.body.report.lng).toBeNull();
    expect(res.body.report.created_at).toBe(1700000000000);
  });

  it('un aviso inexistente responde 404', async () => {
    prepararBase();

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}`));

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(SIN_AVISO);
  });

  it('un aviso inactivo responde 404', async () => {
    prepararBase({ aviso: aviso({ active: false }) });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}`));

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(SIN_AVISO);
  });

  it('un aviso ya resuelto responde 404 aunque siga activo', async () => {
    prepararBase({ aviso: aviso({ resolved: true, active: true }) });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}`));

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(SIN_AVISO);
  });

  it('un fallo de la base responde 500', async () => {
    prepararBase({ falla: sql => String(sql).includes('FROM reports') });

    const res = await anonima(pedir(app).get(`/api/reports/${UUID}`));

    expect(res.status).toBe(500);
  });
});

/* ====================== GET /api/reports/:id/matches ===================== */

describe('GET /api/reports/:id/matches', () => {
  it('sin token responde 401 y no toca la base', async () => {
    const res = await anonima(pedir(app).get(`/api/reports/${UUID}/matches`));

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un id que no es UUID responde 400 antes de buscar el aviso', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(pedir(app).get('/api/reports/no-uuid/matches'));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(ID_INVALIDO);
    expect(consultaCon(SQL_AVISO)).toBeUndefined();
  });

  it('un aviso inexistente responde 404', async () => {
    prepararBase();

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`));

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(SIN_AVISO);
  });

  it('un aviso inactivo responde 404', async () => {
    prepararBase({ aviso: aviso({ active: false }) });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`));

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(SIN_AVISO);
  });

  it('un aviso ajeno responde 403 y no busca candidatos', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`), VISITA);

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({ error: 'Solo puedes ver coincidencias de tus propios avisos.' });
    expect(consultaCon('LIMIT 100')).toBeUndefined();
  });

  it('busca el estado opuesto dentro de la caja de ~5 km con los parámetros exactos', async () => {
    prepararBase({ aviso: aviso({ lat: -33.4489, lng: -70.6693 }), candidatos: [] });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`), DUENO);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ matches: [] });

    const dLat = 5 / KM_POR_GRADO;
    const dLng = 5 / (KM_POR_GRADO * Math.max(COS_MINIMO, Math.cos((-33.4489 * Math.PI) / 180)));
    const consulta = consultaCon('LIMIT 100');
    expect(consulta[0]).toContain('WHERE estado = $1 AND active = TRUE AND resolved = FALSE');
    expect(consulta[0]).toContain('tipo = $2 AND lat BETWEEN $3 AND $4 AND lng BETWEEN $5 AND $6');
    expect(consulta[0]).toContain('OR chip_hash = $7');
    expect(consulta[0]).toContain('LIMIT 100');
    expect(consulta[1][0]).toBe('encontrado');
    expect(consulta[1][1]).toBe('perro');
    expect(consulta[1][2]).toBeCloseTo(-33.4489 - dLat, 10);
    expect(consulta[1][3]).toBeCloseTo(-33.4489 + dLat, 10);
    expect(consulta[1][4]).toBeCloseTo(-70.6693 - dLng, 10);
    expect(consulta[1][5]).toBeCloseTo(-70.6693 + dLng, 10);
    // Sin microchip declarado el parámetro va NULL y la condición no aporta nada.
    expect(consulta[1][6]).toBeNull();
  });

  it('si el aviso es un encontrado busca perdidos', async () => {
    prepararBase({ aviso: aviso({ estado: 'encontrado' }) });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`), DUENO);

    expect(res.status).toBe(200);
    expect(consultaCon('LIMIT 100')[1][0]).toBe('perdido');
  });

  it('en latitudes polares el coseno se topa con 0.1 para no disparar la caja', async () => {
    prepararBase({ aviso: aviso({ lat: 89.9, lng: 0 }) });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`), DUENO);

    const dLng = 5 / (KM_POR_GRADO * COS_MINIMO);
    expect(res.status).toBe(200);
    expect(consultaCon('LIMIT 100')[1][4]).toBeCloseTo(-dLng, 10);
    expect(consultaCon('LIMIT 100')[1][5]).toBeCloseTo(dLng, 10);
  });

  it('compara colores sin distinguir mayúsculas y por coincidencia parcial', async () => {
    prepararBase({
      aviso: aviso({ lat: 0, lng: 0, color: 'negro' }),
      candidatos: [
        candidato({ id: CAND_A, color: 'NEGRO' }),
        candidato({ id: CAND_B, color: 'xnegro' }),
        candidato({ id: AJENO, color: 'blanco' })
      ]
    });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`), DUENO);

    expect(res.status).toBe(200);
    expect(res.body.matches.map(m => m.id)).toStrictEqual([CAND_A, CAND_B]);
  });

  it('compara solo con la primera palabra del color del aviso', async () => {
    prepararBase({
      aviso: aviso({ lat: 0, lng: 0, color: 'negro rayas' }),
      candidatos: [candidato({ id: CAND_A, color: 'rayasXYZ' }), candidato({ id: CAND_B, color: 'NEGRO' })]
    });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`), DUENO);

    // "rayasXYZ" contiene la SEGUNDA palabra ("rayas"), no la primera: queda fuera.
    expect(res.status).toBe(200);
    expect(res.body.matches.map(m => m.id)).toStrictEqual([CAND_B]);
  });

  it('descarta los candidatos a más de 5 km', async () => {
    prepararBase({
      aviso: aviso({ lat: 0, lng: 0, color: 'negro' }),
      // ~11,1 km al norte: dentro de la tabla pero fuera del radio de coincidencia.
      candidatos: [candidato({ id: CAND_A, lat: 0.1, lng: 0 }), candidato({ id: CAND_B, lat: 0.01, lng: 0 })]
    });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`), DUENO);

    expect(res.status).toBe(200);
    expect(res.body.matches.map(m => m.id)).toStrictEqual([CAND_B]);
  });

  it('incluye al candidato que está EXACTAMENTE a 5 km (borde del radio)', async () => {
    // 0.04496608029593653 es la latitud, en grados, para la que
    // haversine(0, 0, lat, 0) da exactamente 5 en punto flotante (el siguiente
    // double ya da 5.000000000000002). Es el único caso que separa `dist <= 5`
    // del mutante `dist < 5`: con el estricto, este candidato desaparece.
    const LAT_EXACTA_5KM = 0.04496608029593653;
    prepararBase({
      aviso: aviso({ lat: 0, lng: 0, color: 'negro' }),
      candidatos: [
        candidato({ id: CAND_A, lat: LAT_EXACTA_5KM, lng: 0 }),
        candidato({ id: CAND_B, lat: 0.01, lng: 0 }),
        // ~5,03 km: este sí queda fuera.
        candidato({ id: AJENO, lat: 0.0453, lng: 0 })
      ]
    });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`), DUENO);

    expect(res.status).toBe(200);
    expect(res.body.matches.map(m => m.id)).toStrictEqual([CAND_B, CAND_A]);
    expect(res.body.matches[1].distancia_km).toBe(5);
  });

  it('acepta que la contraparte repita la segunda palabra del color', async () => {
    // El aviso es "negro rayas": la primera parte del filtro busca "negro" (no
    // está en "RAYAS") y la segunda busca "RAYAS" dentro de "negro rayas", que
    // sí está. Si la segunda comparación no normaliza a minúsculas, el
    // candidato se cae y la lista queda vacía.
    prepararBase({
      aviso: aviso({ lat: 0, lng: 0, color: 'negro rayas' }),
      candidatos: [candidato({ id: CAND_A, color: 'RAYAS' }), candidato({ id: CAND_B, color: 'BLANCO' })]
    });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`), DUENO);

    expect(res.status).toBe(200);
    expect(res.body.matches.map(m => m.id)).toStrictEqual([CAND_A]);
  });

  it('normaliza mayúsculas y espacios de los colores en los dos sentidos', async () => {
    prepararBase({
      aviso: aviso({ lat: 0, lng: 0, color: 'Negro Con Manchas' }),
      candidatos: [
        candidato({ id: CAND_A, color: 'NEGRO' }),
        candidato({ id: CAND_B, color: 'negro con manchas' }),
        candidato({ id: AJENO, color: 'BLANCO' })
      ]
    });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`), DUENO);

    expect(res.status).toBe(200);
    expect(res.body.matches.map(m => m.id)).toStrictEqual([CAND_A, CAND_B]);
  });

  it('ordena por distancia y redondea la distancia a un decimal', async () => {
    prepararBase({
      aviso: aviso({ lat: 0, lng: 0, color: 'negro' }),
      // Se entregan al revés a propósito: el más lejano primero.
      candidatos: [
        candidato({ id: CAND_A, lat: 0.03, lng: 0 }),
        // lat/lng reales para la distancia; lat_public/lng_public son los que se
        // publican (distintos a propósito: la respuesta no debe filtrar el exacto).
        candidato({ id: CAND_B, lat: 0.01, lng: 0, lat_public: 0.02, lng_public: 0.03, user_id: DUENO })
      ]
    });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`), DUENO);

    expect(res.status).toBe(200);
    expect(res.body.matches.map(m => m.id)).toStrictEqual([CAND_B, CAND_A]);
    expect(res.body.matches[0]).toStrictEqual({
      id: CAND_B,
      estado: 'encontrado',
      tipo: 'perro',
      sexo: 'macho',
      color: 'negro',
      raza: null,
      collar: null,
      descripcion: null,
      nombre_mascota: null,
      foto_url: null,
      resolved: false,
      es_mio: true,
      tiene_chip: false,
      chip_enmascarado: null,
      radio_km: null,
      perdido_hace_horas: null,
      lat: 0.02,
      lng: 0.03,
      created_at: 1700000000000,
      distancia_km: 1.1,
      por_chip: false
    });
    expect(res.body.matches[1].distancia_km).toBe(3.3);
    expect(res.body.matches[1].es_mio).toBe(false);
  });

  it('sin candidatos devuelve una lista vacía', async () => {
    prepararBase({ aviso: aviso({ lat: 0, lng: 0 }), candidatos: [] });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`), DUENO);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ matches: [] });
  });

  it('un fallo de la base al buscar candidatos responde 500', async () => {
    prepararBase({ aviso: aviso(), falla: sql => String(sql).includes('LIMIT 100') });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/matches`), DUENO);

    expect(res.status).toBe(500);
  });
});

/* ================= GET /api/reports/:id/threads/:peerId ================== */

describe('GET /api/reports/:id/threads/:peerId', () => {
  it('sin token responde 401 y no toca la base', async () => {
    const res = await anonima(pedir(app).get(`/api/reports/${UUID}/threads/${PEER}`));

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un id de aviso inválido responde 400', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(pedir(app).get(`/api/reports/nada/threads/${PEER}`));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(ID_INVALIDO);
    expect(consultaCon(SQL_AVISO)).toBeUndefined();
  });

  it('un id de contraparte inválido responde 400', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/threads/nada`));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(ID_INVALIDO);
    expect(consultaCon(SQL_AVISO)).toBeUndefined();
  });

  it('un aviso inexistente responde 404', async () => {
    prepararBase();

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/threads/${PEER}`));

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(SIN_AVISO);
  });

  it('quien no es parte del hilo recibe 403 y no se leen mensajes', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/threads/${AJENO}`), OTRO);

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({ error: 'No tienes acceso a esta conversación.' });
    expect(consultaCon('LIMIT 500')).toBeUndefined();
    expect(consultaCon('UPDATE messages SET read = TRUE')).toBeUndefined();
  });

  it('la dueña lee el hilo completo, lo marca leído y normaliza los mensajes', async () => {
    prepararBase({
      aviso: aviso(),
      mensajes: [
        {
          id: 'm1',
          sender_user_id: VISITA,
          mensaje: '¿Sigue perdido?',
          lat: null,
          lng: null,
          created_at: '1700000000000',
          read: false
        },
        {
          id: 'm2',
          sender_user_id: DUENO,
          mensaje: 'Sí, lo busco',
          lat: '3.5',
          lng: '-70.5',
          created_at: '1700000001000',
          read: true
        }
      ]
    });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/threads/${PEER}`), DUENO);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      peer_label: 'Usuario ' + PEER.slice(0, 6),
      es_mio: true,
      estado: 'perdido',
      tipo: 'perro',
      color: 'negro',
      resolved: false,
      messages: [
        { id: 'm1', mio: false, mensaje: '¿Sigue perdido?', lat: null, lng: null, created_at: 1700000000000 },
        { id: 'm2', mio: true, mensaje: 'Sí, lo busco', lat: 3.5, lng: -70.5, created_at: 1700000001000 }
      ]
    });

    const msgs = consultaCon('LIMIT 500');
    expect(msgs[0]).toContain('SELECT id, sender_user_id, mensaje, lat, lng, created_at, read');
    expect(msgs[0]).toContain('sender_user_id = $2 AND recipient_user_id = $3');
    expect(msgs[0]).toContain('sender_user_id = $3 AND recipient_user_id = $2');
    expect(msgs[0]).toContain('ORDER BY created_at ASC LIMIT 500');
    expect(msgs[1]).toStrictEqual([UUID, DUENO, PEER]);

    const marca = consultaCon('UPDATE messages SET read = TRUE');
    expect(marca[0]).toBe(
      'UPDATE messages SET read = TRUE WHERE report_id = $1 AND sender_user_id = $2 AND recipient_user_id = $3'
    );
    // Se marcan como leídos los mensajes DEL PEER hacia mí, en ese orden.
    expect(marca[1]).toStrictEqual([UUID, PEER, DUENO]);
  });

  it('la interesada (contraparte del aviso) también puede leer el hilo', async () => {
    prepararBase({ aviso: aviso({ user_id: PEER }), mensajes: [] });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/threads/${PEER}`), VISITA);

    expect(res.status).toBe(200);
    expect(res.body.es_mio).toBe(false);
    expect(res.body.messages).toStrictEqual([]);
    expect(res.body.peer_label).toBe('Usuario ' + PEER.slice(0, 6));
    expect(consultaCon('LIMIT 500')[1]).toStrictEqual([UUID, VISITA, PEER]);
    expect(consultaCon('UPDATE messages SET read = TRUE')[1]).toStrictEqual([UUID, PEER, VISITA]);
  });

  it('un aviso resuelto llega como resolved true', async () => {
    prepararBase({ aviso: aviso({ resolved: true }), mensajes: [] });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/threads/${PEER}`), DUENO);

    expect(res.status).toBe(200);
    expect(res.body.resolved).toBe(true);
  });

  it('un fallo de la base al leer los mensajes responde 500', async () => {
    prepararBase({ aviso: aviso(), falla: sql => String(sql).includes('ORDER BY created_at ASC') });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/threads/${PEER}`), DUENO);

    expect(res.status).toBe(500);
  });

  it('un fallo al marcar como leído responde 500', async () => {
    prepararBase({ aviso: aviso(), falla: sql => String(sql).includes('UPDATE messages SET read = TRUE') });

    const res = await conToken(pedir(app).get(`/api/reports/${UUID}/threads/${PEER}`), DUENO);

    expect(res.status).toBe(500);
  });
});

/* ==================== POST /api/reports/:id/messages ===================== */

describe('POST /api/reports/:id/messages', () => {
  it('sin token responde 401 y no toca la base', async () => {
    const res = await anonima(pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola' }));

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un id que no es UUID responde 400', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(
      pedir(app).post('/api/reports/nada/messages').send({ mensaje: 'hola' }),
      VISITA
    );

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Invalid value' });
    expect(db.query.mock.calls.some(c => String(c[0]).includes('INSERT INTO messages'))).toBe(false);
  });

  it('un mensaje vacío o solo con espacios responde 400', async () => {
    prepararBase({ aviso: aviso() });

    const vacio = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: '' }),
      VISITA
    );
    const espacios = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: '    ' }),
      VISITA
    );

    expect(vacio.status).toBe(400);
    expect(vacio.body).toStrictEqual({ error: 'Invalid value' });
    expect(espacios.status).toBe(400);
    expect(espacios.body).toStrictEqual({ error: 'Invalid value' });
  });

  it('sin el campo mensaje responde 400', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(pedir(app).post(`/api/reports/${UUID}/messages`).send({}), VISITA);

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Invalid value' });
  });

  it('un mensaje de 501 caracteres responde 400', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(
      pedir(app)
        .post(`/api/reports/${UUID}/messages`)
        .send({ mensaje: 'a'.repeat(501) }),
      VISITA
    );

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Invalid value' });
  });

  it('un mensaje de 500 caracteres (el borde) se acepta', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(
      pedir(app)
        .post(`/api/reports/${UUID}/messages`)
        .send({ mensaje: 'a'.repeat(500) }),
      VISITA
    );

    expect(res.status).toBe(201);
    expect(res.body).toStrictEqual({ ok: true, message: 'Mensaje enviado.' });
  });

  it('un lat que no es número responde 400', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola', lat: 'sur' }),
      VISITA
    );

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Invalid value' });
  });

  it('con el correo sin confirmar responde 403 sin escribir nada', async () => {
    prepararBase({ aviso: aviso(), verificado: false });

    const res = await conToken(pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola' }));

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual({
      error: 'Confirma tu correo para poder publicar. Revisa tu bandeja de entrada.'
    });
    expect(db.query.mock.calls.some(c => String(c[0]).includes('INSERT INTO messages'))).toBe(false);
  });

  it('si la cuenta del token ya no existe responde 401', async () => {
    prepararBase({ aviso: aviso(), usuarioExiste: false });

    const res = await conToken(pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola' }));

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'Sesión inválida o expirada.' });
  });

  it('al llegar a 100 mensajes en 24 h responde 429 y ni busca el aviso', async () => {
    prepararBase({ aviso: aviso(), mensajesHoy: 100 });

    const res = await conToken(pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola' }));

    expect(res.status).toBe(429);
    expect(res.body).toStrictEqual({ error: 'Enviaste demasiados mensajes hoy. Intenta mañana.' });
    expect(consultaCon(SQL_AVISO)).toBeUndefined();

    const conteo = consultaCon('COUNT(*)::int AS n FROM messages');
    expect(conteo[0]).toBe(
      'SELECT COUNT(*)::int AS n FROM messages WHERE sender_user_id = $1 AND created_at > $2'
    );
    expect(conteo[1][0]).toBe(DUENO);
    expect(Math.abs(conteo[1][1] - (Date.now() - 24 * 60 * 60 * 1000))).toBeLessThan(5000);
  });

  it('con 99 mensajes en 24 h todavía se puede escribir', async () => {
    prepararBase({ aviso: aviso(), mensajesHoy: 99 });

    const res = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola' }),
      VISITA
    );

    expect(res.status).toBe(201);
  });

  it('un aviso inexistente responde 404', async () => {
    prepararBase();

    const res = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola' }),
      VISITA
    );

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(SIN_AVISO);
  });

  it('un aviso inactivo responde 404', async () => {
    prepararBase({ aviso: aviso({ active: false }) });

    const res = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola' }),
      VISITA
    );

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(SIN_AVISO);
  });

  it('la dueña que responde sin indicar destinatario recibe 400', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola' }));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Indica a quién le respondes.' });
  });

  it('la dueña que responde a un id que no es UUID recibe 400', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola', to_user_id: 'pepe' })
    );

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Invalid value' });
  });

  it('la dueña no puede responder a quien nunca le escribió', async () => {
    prepararBase({ aviso: aviso(), conversacion: false });

    const res = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola', to_user_id: PEER })
    );

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({
      error: 'Ese usuario no ha iniciado una conversación sobre este aviso.'
    });

    const previa = consultaCon('SELECT 1 FROM messages WHERE report_id');
    expect(previa[0]).toBe(
      'SELECT 1 FROM messages WHERE report_id = $1 AND sender_user_id = $2 AND recipient_user_id = $3 LIMIT 1'
    );
    expect(previa[1]).toStrictEqual([UUID, PEER, DUENO]);
  });

  it('la dueña responde a quien sí le escribió: inserta y avisa por push', async () => {
    prepararBase({ aviso: aviso(), conversacion: true });

    const res = await conToken(
      pedir(app)
        .post(`/api/reports/${UUID}/messages`)
        .send({ mensaje: '  ¿Sigue perdido?  ', to_user_id: PEER })
    );

    expect(res.status).toBe(201);
    expect(res.body).toStrictEqual({ ok: true, message: 'Mensaje enviado.' });

    const insert = consultaCon('INSERT INTO messages');
    expect(insert[0]).toBe(
      'INSERT INTO messages (id, report_id, sender_user_id, recipient_user_id, mensaje, lat, lng, created_at, read) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE)'
    );
    // El validador hace trim(): el mensaje guardado va sin espacios de sobra.
    expect(insert[1][0]).toMatch(UUID_V4);
    expect(insert[1].slice(1, 5)).toStrictEqual([UUID, DUENO, PEER, '¿Sigue perdido?']);
    expect(insert[1][5]).toBeNull();
    expect(insert[1][6]).toBeNull();
    expect(Math.abs(insert[1][7] - Date.now())).toBeLessThan(5000);

    expect(push.sendToUser).toHaveBeenCalledTimes(1);
    expect(push.sendToUser).toHaveBeenCalledWith(PEER, {
      title: 'Respondieron tu aviso',
      body: '¿Sigue perdido?',
      report_id: UUID,
      peer_id: DUENO,
      tag: 'msg-' + UUID
    });
  });

  it('otra persona escribe a la dueña y el aviso push es distinto', async () => {
    prepararBase({ aviso: aviso({ user_id: DUENO }) });

    const res = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'Lo vi en el parque' }),
      VISITA
    );

    expect(res.status).toBe(201);

    const insert = consultaCon('INSERT INTO messages');
    expect(insert[1].slice(1, 5)).toStrictEqual([UUID, VISITA, DUENO, 'Lo vi en el parque']);
    // Quien no es la dueña no necesita comprobar la conversación previa.
    expect(consultaCon('SELECT 1 FROM messages WHERE report_id')).toBeUndefined();
    expect(push.sendToUser).toHaveBeenCalledWith(DUENO, {
      title: 'Nuevo mensaje en PetSeñal',
      body: 'Lo vi en el parque',
      report_id: UUID,
      peer_id: VISITA,
      tag: 'msg-' + UUID
    });
  });

  it('la notificación push recorta el cuerpo a 90 caracteres', async () => {
    const largo = 'x'.repeat(120);
    prepararBase({ aviso: aviso() });

    const res = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: largo }),
      VISITA
    );

    expect(res.status).toBe(201);
    expect(consultaCon('INSERT INTO messages')[1][4]).toBe(largo);
    expect(push.sendToUser).toHaveBeenCalledWith(DUENO, {
      title: 'Nuevo mensaje en PetSeñal',
      body: 'x'.repeat(90),
      report_id: UUID,
      peer_id: VISITA,
      tag: 'msg-' + UUID
    });
  });

  it('convierte lat y lng a número cuando vienen como texto', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(
      pedir(app)
        .post(`/api/reports/${UUID}/messages`)
        .send({ mensaje: 'Está aquí', lat: '12.5', lng: '-70.5' }),
      VISITA
    );

    expect(res.status).toBe(201);
    const insert = consultaCon('INSERT INTO messages');
    expect(insert[1][5]).toBe(12.5);
    expect(insert[1][6]).toBe(-70.5);
  });

  it('un 0 en lat/lng se guarda como 0, no como null', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'Está aquí', lat: 0, lng: 0 }),
      VISITA
    );

    expect(res.status).toBe(201);
    const insert = consultaCon('INSERT INTO messages');
    expect(insert[1][5]).toBe(0);
    expect(insert[1][6]).toBe(0);
  });

  it('sin lat ni lng guarda null', async () => {
    prepararBase({ aviso: aviso() });

    const res = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'Está aquí' }),
      VISITA
    );

    expect(res.status).toBe(201);
    const insert = consultaCon('INSERT INTO messages');
    expect(insert[1][5]).toBeNull();
    expect(insert[1][6]).toBeNull();
  });

  it('si el push falla el mensaje igual queda enviado', async () => {
    prepararBase({ aviso: aviso() });
    push.sendToUser.mockRejectedValueOnce(new Error('sin suscripción'));

    const res = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola' }),
      VISITA
    );

    expect(res.status).toBe(201);
    expect(res.body).toStrictEqual({ ok: true, message: 'Mensaje enviado.' });
  });

  it('un fallo de la base al insertar responde 500', async () => {
    prepararBase({ aviso: aviso(), falla: sql => String(sql).includes('INSERT INTO messages') });

    const res = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola' }),
      VISITA
    );

    expect(res.status).toBe(500);
  });

  it('un fallo de la base al contar los mensajes del día responde 500', async () => {
    prepararBase({ falla: sql => String(sql).includes('COUNT(*)::int AS n FROM messages') });

    const res = await conToken(
      pedir(app).post(`/api/reports/${UUID}/messages`).send({ mensaje: 'hola' }),
      VISITA
    );

    expect(res.status).toBe(500);
  });

  it('el cupo por IP (messageLimiter) corta a los 60 mensajes de la hora', async () => {
    prepararBase({ aviso: aviso() });
    // IP propia y fija: las 61 peticiones comparten cupo y ninguna otra prueba
    // de este archivo usa esta dirección.
    const mismaIP = '10.99.99.99';
    const enviar = () =>
      pedir(app)
        .post(`/api/reports/${UUID}/messages`)
        .set('Authorization', `Bearer ${tokenPara(VISITA)}`)
        .set('x-forwarded-for', mismaIP)
        .send({ mensaje: 'hola' });

    let primera = null;
    for (let i = 0; i < 60; i += 1) {
      const res = await enviar();
      if (i === 0) primera = res;
    }

    expect(primera.status).toBe(201);
    const bloqueada = await enviar();
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.text).toContain('Too many requests');
  });
});
