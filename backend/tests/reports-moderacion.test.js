// Pruebas de la PARTE C de backend/routes/reports.js: edición (PATCH /:id),
// reencuentro (POST /:id/reunion), resolver/reabrir (POST /:id/resolve),
// reportar (POST /:id/flag) y baja (DELETE /:id).
//
// INFRAESTRUCTURA: no se toca ni una línea de producción. El router se importa
// de forma ESTÁTICA (así `vitest related` lo relaciona con estas pruebas y
// Stryker ejecuta el archivo para cada mutante) y sus dependencias (db, storage)
// se sustituyen con los dobles de ./helpers/aislar.js, que va PRIMERO.
//
// HALLAZGOS (no se arreglan desde aquí):
//   (ninguno pendiente en esta parte)
//
// ARREGLADO (eran hallazgos de este archivo; ahora se prueba el contrato nuevo):
//   * PATCH /:id y DELETE /:id responden 403 (no 404) cuando el aviso es de otro
//     usuario: antes el mensaje no distinguía "no existe" de "no es tuyo".
//   * requireVerified exige que `email_verified` sea exactamente `true`: antes
//     comparaba `=== false`, así que un falsy que no fuera el booleano `false`
//     (por ejemplo 0) NO bloqueaba la petición.
//   * POST /:id/reunion guarda la foto NUEVA antes de borrar la anterior, y solo
//     borra la anterior cuando la base ya aceptó el cambio.
//   * DELETE /:id usa el id de la fila devuelta (report.id), no el texto de la URL.
vi.hoisted(() => {
  // flagLimiter lee su cupo al cargar el router: se fija aquí para que la prueba
  // del límite no dependa de variables del entorno.
  process.env.LIMITE_REPORTES_HORA = '20';
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { db, storage, crearApp, pedir, tokenPara } from './helpers/aislar.js';
import reportsRouter from '../routes/reports.js';

const app = crearApp({ '/api/reports': reportsRouter });

const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID_MAYUS = UUID.toUpperCase();
const SUB = 'duena-1';
const OTRO = 'curioso-9';
const AHORA = 1700000000000;
const DIA = 24 * 60 * 60 * 1000;

const SQL_TOKEN = 'SELECT token_version FROM users WHERE id = $1';
const SQL_VERIFICADO = 'SELECT email_verified FROM users WHERE id = $1';
const SQL_AVISO = 'SELECT * FROM reports WHERE id = $1';
const SQL_CREADA = 'SELECT created_at FROM users WHERE id = $1';
const SQL_FLAGS_HOY = 'SELECT COUNT(*)::int AS n FROM report_flags WHERE user_id = $1 AND created_at > $2';
const SQL_INSERT_FLAG =
  'INSERT INTO report_flags (report_id, user_id, created_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING report_id';
const SQL_SUMAR_FLAG = 'UPDATE reports SET flags = flags + 1 WHERE id = $1 RETURNING flags';
const SQL_OCULTAR = 'UPDATE reports SET active = FALSE WHERE id = $1';
const SQL_REUNION =
  'UPDATE reports SET resolved = TRUE, resolved_at = $1, reunion_foto_url = $2, reunion_nota = $3 WHERE id = $4';
const SQL_RESOLVER = 'UPDATE reports SET resolved = $1, resolved_at = $2 WHERE id = $3';
const SQL_EDITAR =
  'UPDATE reports SET tipo=$1, sexo=$2, color=$3, raza=$4, collar=$5, descripcion=$6, ' +
  'nombre_mascota=$7, lat=$8, lng=$9, lat_public=$10, lng_public=$11, ' +
  'chip_hash=$12, chip_cifrado=$13 WHERE id=$14';

const NO_AUTENTICADO = { error: 'No autenticado.' };
const SESION_INVALIDA = { error: 'Sesión inválida o expirada.' };
const NO_ENCONTRADO = { error: 'Aviso no encontrado.' };
const AJENO = { error: 'Este aviso no es tuyo.' };
const INVALIDO = { error: 'Invalid value' };
const ID_INVALIDO = { error: 'Identificador inválido.' };
const RESOLVED_INVALIDO = { error: 'El campo resolved debe ser true o false.' };
const SIN_VERIFICAR = { error: 'Confirma tu correo para poder publicar. Revisa tu bandeja de entrada.' };
const PROPIO = { error: 'No puedes reportar tu propio aviso.' };
const CUENTA_NUEVA = { error: 'Tu cuenta es demasiado nueva para reportar avisos.' };
const MUCHOS_HOY = { error: 'Reportaste demasiados avisos hoy.' };
const GRACIAS = { ok: true, message: 'Gracias, revisaremos este aviso.' };

// Un aviso propio, activo y con datos "sucios" a propósito: created_at y
// radio_km llegan como texto (Postgres los devuelve así en algunas columnas) y
// resolved como 0, para que publicReport tenga que convertir y normalizar.
function aviso(extra = {}) {
  return {
    id: UUID,
    user_id: SUB,
    estado: 'perdido',
    tipo: 'perro',
    sexo: 'macho',
    color: 'negro',
    raza: 'quiltro',
    collar: 'rojo',
    descripcion: 'Muy dócil',
    nombre_mascota: 'Firulais',
    foto_url: '/uploads/foto.jpg',
    reunion_foto_url: null,
    lat: -33.45,
    lng: -70.66,
    lat_public: -33.4527,
    lng_public: -70.6627,
    radio_km: '3',
    perdido_hace_horas: '5',
    active: true,
    resolved: 0,
    flags: 0,
    created_at: '1699990000000',
    ...extra
  };
}

// Posición de cada campo editable dentro de los parámetros del UPDATE.
const POSICION = {
  tipo: 0,
  sexo: 1,
  color: 2,
  raza: 3,
  collar: 4,
  descripcion: 5,
  nombre_mascota: 6,
  lat: 7,
  lng: 8
};

const AVISO_PUBLICO = {
  id: UUID,
  estado: 'perdido',
  tipo: 'perro',
  sexo: 'macho',
  color: 'negro',
  raza: 'quiltro',
  collar: 'rojo',
  descripcion: 'Muy dócil',
  nombre_mascota: 'Firulais',
  foto_url: '/uploads/foto.jpg',
  resolved: false,
  es_mio: true,
  tiene_chip: false,
  chip_enmascarado: null,
  radio_km: 3,
  perdido_hace_horas: 5,
  lat: -33.4527,
  lng: -70.6627,
  created_at: 1699990000000
};

// Quita la indentación de los SQL multilínea: así se afirma el contenido exacto
// de la consulta sin depender de los espacios de reports.js.
function sqlDe(consulta) {
  return String(consulta).replace(/\s+/g, ' ').trim();
}

function sqls() {
  return db.query.mock.calls.map(c => c[0]);
}

let consultasAviso = 0;
// Encadena las respuestas de la base. `fila` puede ser una fila, null (aviso
// inexistente) o una función (params, nº de consulta) para los flujos que
// consultan el aviso dos veces.
function montarBase({ fila = aviso(), verificada = true, creada = AHORA - 2 * DIA, resto } = {}) {
  consultasAviso = 0;
  db.query.mockImplementation(async (sql, params) => {
    if (sql === SQL_TOKEN) return { rows: [{ token_version: 0 }] };
    if (sql === SQL_VERIFICADO) return { rows: [{ email_verified: verificada }] };
    if (sql === SQL_AVISO) {
      consultasAviso += 1;
      const valor = typeof fila === 'function' ? fila(params, consultasAviso) : fila;
      return { rows: valor ? [valor] : [] };
    }
    if (sql === SQL_CREADA) return { rows: creada === null ? [] : [{ created_at: creada }] };
    return resto ? resto(sql, params) : { rows: [] };
  });
}

// Respuestas propias de POST /:id/flag.
function restoFlag({ hoy = 0, tras = 1, insertadas = 1 } = {}) {
  return (sql, params) => {
    if (sql === SQL_FLAGS_HOY) return { rows: [{ n: hoy }] };
    if (sql === SQL_INSERT_FLAG)
      return { rows: Array.from({ length: insertadas }, () => ({ report_id: params[0] })) };
    if (sql === SQL_SUMAR_FLAG) return { rows: [{ tras: 0, flags: tras }] };
    return { rows: [] };
  };
}

let visitas = 0;
function ipNueva() {
  visitas += 1;
  return `10.${Math.floor(visitas / 250)}.${visitas % 250}.9`;
}

// Toda petición autenticada lleva una IP distinta (TRUST_PROXY=1 hace que la
// clave del rate limit salga de x-forwarded-for): así ningún cupo se agota entre
// pruebas.
function conToken(peticion, sub = SUB, ip = ipNueva()) {
  return peticion.set('Authorization', `Bearer ${tokenPara(sub, 0)}`).set('x-forwarded-for', ip);
}

function editar(cuerpo = {}, id = UUID) {
  return conToken(pedir(app).patch(`/api/reports/${id}`)).send(cuerpo);
}

function reunion(id = UUID) {
  return conToken(pedir(app).post(`/api/reports/${id}/reunion`));
}

function resolver(cuerpo = {}, id = UUID) {
  return conToken(pedir(app).post(`/api/reports/${id}/resolve`)).send(cuerpo);
}

function flag(id = UUID, sub = SUB, ip = ipNueva()) {
  return conToken(pedir(app).post(`/api/reports/${id}/flag`), sub, ip);
}

function borrar(id = UUID) {
  return conToken(pedir(app).delete(`/api/reports/${id}`));
}

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  storage.deletePhoto.mockReset();
  storage.savePhoto.mockReset();
  storage.savePhoto.mockResolvedValue('/uploads/foto-de-prueba.jpg');
  // Reloj y azar fijos: jitter() queda determinista (300 m * 0 = 0) y las
  // ventanas de 24 h se pueden afirmar al milisegundo.
  vi.spyOn(Date, 'now').mockReturnValue(AHORA);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.restoreAllMocks();
});

const BYTES_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const BYTES_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const BYTES_WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP')]);

describe('PATCH /api/reports/:id — editar un aviso propio', () => {
  it('sin token responde 401 y no toca la base', async () => {
    const res = await pedir(app).patch(`/api/reports/${UUID}`).send({ color: 'blanco' });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('con un token que no es un JWT responde 401', async () => {
    const res = await pedir(app)
      .patch(`/api/reports/${UUID}`)
      .set('Authorization', 'Bearer esto-no-es-un-token');

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SESION_INVALIDA);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('si la cuenta del token ya no existe responde 401', async () => {
    db.query.mockResolvedValue({ rows: [] });

    const res = await editar({ color: 'blanco' });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SESION_INVALIDA);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(SQL_TOKEN, [SUB]);
  });

  it('un :id que no es UUID responde 400 y no consulta el aviso', async () => {
    montarBase();

    const res = await editar({ color: 'blanco' }, 'no-es-un-uuid');

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(INVALIDO);
    expect(sqls()).toStrictEqual([SQL_TOKEN]);
  });

  it('un aviso inexistente responde 404', async () => {
    montarBase({ fila: null });

    const res = await editar({ color: 'blanco' });

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(NO_ENCONTRADO);
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('un aviso de otro usuario responde 403 (no 404) y no se actualiza nada', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }) });

    const res = await editar({ color: 'blanco' });

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(AJENO);
    expect(sqls()).toStrictEqual([SQL_TOKEN, SQL_AVISO]);
  });

  it('sin campos conserva todos los valores actuales y devuelve el aviso público', async () => {
    montarBase();

    const res = await editar();

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ report: AVISO_PUBLICO });
    expect(db.query).toHaveBeenCalledTimes(4);
    expect(db.query.mock.calls[0]).toStrictEqual([SQL_TOKEN, [SUB]]);
    expect(db.query.mock.calls[1]).toStrictEqual([SQL_AVISO, [UUID]]);
    expect(sqlDe(db.query.mock.calls[2][0])).toBe(SQL_EDITAR);
    expect(db.query.mock.calls[2][1]).toStrictEqual([
      'perro',
      'macho',
      'negro',
      'quiltro',
      'rojo',
      'Muy dócil',
      'Firulais',
      -33.45,
      -70.66,
      -33.4527,
      -70.6627,
      null,
      null,
      UUID
    ]);
    expect(db.query.mock.calls[3]).toStrictEqual([SQL_AVISO, [UUID]]);
  });

  it('recorta los espacios de los campos de texto antes de guardarlos', async () => {
    montarBase();

    const res = await editar({
      tipo: 'gato',
      sexo: 'hembra',
      color: '  blanco  ',
      raza: '  siamés ',
      collar: '  azul ',
      descripcion: '  se asusta ',
      nombre_mascota: '  Michi  '
    });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2][1]).toStrictEqual([
      'gato',
      'hembra',
      'blanco',
      'siamés',
      'azul',
      'se asusta',
      'Michi',
      -33.45,
      -70.66,
      -33.4527,
      -70.6627,
      null,
      null,
      UUID
    ]);
  });

  it('los campos de texto vacíos se guardan como NULL', async () => {
    montarBase();

    const res = await editar({ raza: '', collar: '', descripcion: '', nombre_mascota: '' });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2][1].slice(3)).toStrictEqual([
      null,
      null,
      null,
      null,
      -33.45,
      -70.66,
      -33.4527,
      -70.6627,
      null,
      null,
      UUID
    ]);
  });

  it('si llegan lat y lng juntos recalcula la posición pública difuminada', async () => {
    montarBase();

    const res = await editar({ lat: '10.5', lng: '20.25' });

    expect(res.status).toBe(200);
    const params = db.query.mock.calls[2][1];
    // Math.random = 0.5 => jitter no desplaza nada: la pública coincide con la real.
    expect(params.slice(7)).toStrictEqual([10.5, 20.25, 10.5, 20.25, null, null, UUID]);
  });

  it('si solo llega lat se conservan lat, lng y la posición pública anteriores', async () => {
    montarBase();

    const res = await editar({ lat: '10.5' });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2][1].slice(7)).toStrictEqual([
      -33.45,
      -70.66,
      -33.4527,
      -70.6627,
      null,
      null,
      UUID
    ]);
  });

  it('si solo llega lng también se conserva todo', async () => {
    montarBase();

    const res = await editar({ lng: '20.25' });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2][1].slice(7)).toStrictEqual([
      -33.45,
      -70.66,
      -33.4527,
      -70.6627,
      null,
      null,
      UUID
    ]);
  });

  it('trabaja con el id de la fila devuelta, no con el texto de la URL', async () => {
    montarBase();

    // La URL va en mayúsculas y la base devuelve el id normalizado en minúsculas:
    // el UPDATE y la segunda lectura deben usar el id de la fila.
    const res = await editar({ color: 'blanco' }, UUID_MAYUS);

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[1]).toStrictEqual([SQL_AVISO, [UUID_MAYUS]]);
    expect(db.query.mock.calls[2][1][13]).toBe(UUID);
    expect(db.query.mock.calls[3]).toStrictEqual([SQL_AVISO, [UUID]]);
  });

  it('devuelve el aviso normalizado cuando la fila guardada cambia', async () => {
    montarBase({
      fila: (params, n) =>
        n === 1
          ? aviso()
          : aviso({
              estado: 'encontrado',
              nombre_mascota: 'Firulais',
              color: 'blanco',
              radio_km: null,
              perdido_hace_horas: null,
              resolved: 1,
              created_at: 1700000000123
            })
    });

    const res = await editar({ color: 'blanco' });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      report: {
        ...AVISO_PUBLICO,
        estado: 'encontrado',
        color: 'blanco',
        nombre_mascota: null,
        radio_km: null,
        perdido_hace_horas: null,
        resolved: true,
        created_at: 1700000000123
      }
    });
  });

  it('cambia varios campos a la vez y conserva los que no se envían', async () => {
    montarBase();

    const res = await editar({
      color: 'blanco',
      collar: 'verde',
      descripcion: 'nueva',
      nombre_mascota: 'Luna'
    });

    expect(res.status).toBe(200);
    const params = db.query.mock.calls[2][1];
    // Cada campo del cuerpo tiene que llegar a SU posición del UPDATE.
    expect(params[POSICION.color]).toBe('blanco');
    expect(params[POSICION.collar]).toBe('verde');
    expect(params[POSICION.descripcion]).toBe('nueva');
    expect(params[POSICION.nombre_mascota]).toBe('Luna');
    // Y los que no vienen en el cuerpo conservan lo que ya tenía el aviso.
    expect(params[POSICION.tipo]).toBe('perro');
    expect(params[POSICION.sexo]).toBe('macho');
    expect(params[POSICION.raza]).toBe('quiltro');
  });

  it.each([
    [0, 10.497305066475027, 20.247259171040753],
    [0.25, 10.498652533237513, 20.248629585520376],
    [0.5, 10.5, 20.25],
    [1, 10.502694933524973, 20.252740828959247]
  ])('difumina la ubicación pública (~300 m) con Math.random = %s', async (azar, latPub, lngPub) => {
    montarBase();
    vi.spyOn(Math, 'random').mockReturnValue(azar);

    const res = await editar({ lat: '10.5', lng: '20.25' });

    expect(res.status).toBe(200);
    const params = db.query.mock.calls[2][1];
    // La ubicación real se guarda tal cual...
    expect(params[POSICION.lat]).toBe(10.5);
    expect(params[POSICION.lng]).toBe(20.25);
    // ...y la pública lleva el desplazamiento exacto de jitter().
    // rand() = (Math.random() - 0.5) * 2; dLat = rand * 300 / 111320;
    // dLng = rand * 300 / (111320 * cos(lat * PI / 180)).
    expect(params[9]).toBeCloseTo(latPub, 10);
    expect(params[10]).toBeCloseTo(lngPub, 10);
  });

  it('si la fila no tuviera color, el UPDATE guarda NULL en vez de reventar', async () => {
    montarBase({ fila: aviso({ color: null }) });

    const res = await editar();

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2][1][2]).toBeNull();
  });

  it('un tipo fuera de la lista responde 400 y no actualiza', async () => {
    montarBase();

    const res = await editar({ tipo: 'dinosaurio' });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(INVALIDO);
    expect(sqls()).toStrictEqual([SQL_TOKEN]);
  });

  it('un sexo fuera de la lista responde 400', async () => {
    montarBase();

    const res = await editar({ sexo: 'indefinido' });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(INVALIDO);
  });

  it('un color en blanco responde 400 (el validador recorta antes de medir)', async () => {
    montarBase();

    const res = await editar({ color: '   ' });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(INVALIDO);
  });

  it.each([
    ['color', 60],
    ['raza', 80],
    ['collar', 40],
    ['descripcion', 1000],
    ['nombre_mascota', 60]
  ])('acepta %s con el largo máximo exacto (%i) y recorta los espacios de sobra', async (campo, max) => {
    montarBase();

    // El validador recorta ANTES de medir: con 5 espacios de más sigue siendo
    // válido y lo que se guarda es el texto ya recortado.
    const res = await editar({ [campo]: 'a'.repeat(max) + '     ' });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2][1][POSICION[campo]]).toBe('a'.repeat(max));
  });

  it.each([
    ['color', 60],
    ['raza', 80],
    ['collar', 40],
    ['descripcion', 1000],
    ['nombre_mascota', 60]
  ])('rechaza %s con un carácter de más (%i)', async (campo, max) => {
    montarBase();

    const res = await editar({ [campo]: 'a'.repeat(max + 1) });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(INVALIDO);
  });

  it.each([
    ['lat', '90.1'],
    ['lat', '-90.1'],
    ['lng', '180.1'],
    ['lng', '-180.1'],
    ['lat', 'no-es-un-número']
  ])('rechaza %s fuera de rango o no numérico (%s)', async (campo, valor) => {
    montarBase();

    const res = await editar({ [campo]: valor });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(INVALIDO);
  });

  it('acepta los límites exactos de lat y lng', async () => {
    montarBase();

    const res = await editar({ lat: '-90', lng: '180' });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2][1].slice(7)).toStrictEqual([-90, 180, -90, 180, null, null, UUID]);
  });

  it('si la base falla al actualizar responde 500', async () => {
    montarBase({
      resto: () => {
        throw new Error('base caída');
      }
    });

    const res = await editar({ color: 'blanco' });

    expect(res.status).toBe(500);
  });
});

describe('POST /api/reports/:id/reunion — marcar el reencuentro', () => {
  it('sin token responde 401', async () => {
    const res = await pedir(app).post(`/api/reports/${UUID}/reunion`).send({});

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un :id que no es UUID responde 400', async () => {
    montarBase();

    const res = await reunion('abc');

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(INVALIDO);
    expect(sqls()).toStrictEqual([SQL_TOKEN]);
  });

  it('un aviso inexistente responde 404', async () => {
    montarBase({ fila: null });

    const res = await reunion();

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(NO_ENCONTRADO);
  });

  it('un aviso de otro usuario responde 404 y no se marca nada', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }) });

    const res = await reunion();

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(NO_ENCONTRADO);
    expect(sqls()).toStrictEqual([SQL_TOKEN, SQL_AVISO]);
  });

  it('sin foto ni nota resuelve el aviso con valores nulos', async () => {
    montarBase();

    const res = await reunion();

    expect(res.status).toBe(200);
    expect(sqlDe(db.query.mock.calls[2][0])).toBe(SQL_REUNION);
    expect(db.query.mock.calls[2][1]).toStrictEqual([AHORA, null, null, UUID]);
    expect(storage.savePhoto).not.toHaveBeenCalled();
    expect(storage.deletePhoto).not.toHaveBeenCalled();
    expect(res.body).toStrictEqual({ report: AVISO_PUBLICO });
  });

  it('sin foto nueva conserva la foto de reencuentro anterior', async () => {
    montarBase({ fila: aviso({ reunion_foto_url: '/uploads/vieja.jpg' }) });

    const res = await reunion();

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2][1]).toStrictEqual([AHORA, '/uploads/vieja.jpg', null, UUID]);
    expect(storage.deletePhoto).not.toHaveBeenCalled();
  });

  it('guarda la nota recortada y devuelve el aviso ya resuelto', async () => {
    montarBase({
      fila: (params, n) =>
        n === 1
          ? aviso()
          : aviso({ resolved: 1, reunion_foto_url: '/uploads/nueva.jpg', reunion_nota: 'Volvió a casa' })
    });

    const res = await reunion().send({ nota: '  Volvió a casa  ' });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2][1]).toStrictEqual([AHORA, null, 'Volvió a casa', UUID]);
    expect(res.body).toStrictEqual({ report: { ...AVISO_PUBLICO, resolved: true } });
  });

  it('una nota vacía se guarda como NULL', async () => {
    montarBase();

    const res = await reunion().send({ nota: '' });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2][1][2]).toBeNull();
  });

  it('una nota de más de 500 caracteres responde 400 y no resuelve el aviso', async () => {
    montarBase();

    const res = await reunion().send({ nota: 'a'.repeat(501) });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(INVALIDO);
    expect(sqls()).toStrictEqual([SQL_TOKEN]);
  });

  it('acepta una nota de 500 caracteres exactos', async () => {
    montarBase();

    const res = await reunion().send({ nota: 'a'.repeat(500) });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2][1][2]).toBe('a'.repeat(500));
  });

  it('con una foto JPEG válida la guarda y la deja como foto del reencuentro', async () => {
    montarBase();

    const res = await reunion().attach('foto', BYTES_JPEG, {
      filename: 'reunion.jpg',
      contentType: 'image/jpeg'
    });

    expect(res.status).toBe(200);
    expect(storage.savePhoto).toHaveBeenCalledTimes(1);
    expect(storage.savePhoto).toHaveBeenCalledWith(BYTES_JPEG, 'image/jpeg');
    // Rama falsa de `if (reunionFoto)`: no había nada que borrar.
    expect(storage.deletePhoto).not.toHaveBeenCalled();
    expect(db.query.mock.calls[2][1]).toStrictEqual([AHORA, '/uploads/foto-de-prueba.jpg', null, UUID]);
    expect(res.body).toStrictEqual({ report: AVISO_PUBLICO });
  });

  it('detecta el tipo real por los bytes, no por el mimetype: un PNG se guarda como image/png', async () => {
    montarBase();

    const res = await reunion().attach('foto', BYTES_PNG, {
      filename: 'foto.png',
      contentType: 'image/jpeg'
    });

    expect(res.status).toBe(200);
    expect(storage.savePhoto).toHaveBeenCalledWith(BYTES_PNG, 'image/png');
  });

  it('detecta también un WEBP', async () => {
    montarBase();

    const res = await reunion().attach('foto', BYTES_WEBP, {
      filename: 'foto.webp',
      contentType: 'image/webp'
    });

    expect(res.status).toBe(200);
    expect(storage.savePhoto).toHaveBeenCalledWith(BYTES_WEBP, 'image/webp');
  });

  it('guarda la nueva foto, actualiza la base y solo entonces borra la anterior', async () => {
    const eventos = [];
    montarBase({
      fila: aviso({ reunion_foto_url: '/uploads/vieja.jpg' }),
      resto: sql => {
        if (sql === SQL_REUNION) eventos.push('actualizar');
        return { rows: [] };
      }
    });
    storage.deletePhoto.mockImplementation(async url => eventos.push('borrar:' + url));
    storage.savePhoto.mockImplementation(async (_buf, tipo) => {
      eventos.push('guardar:' + tipo);
      return '/uploads/nueva.jpg';
    });

    const res = await reunion().attach('foto', BYTES_JPEG, {
      filename: 'reunion.jpg',
      contentType: 'image/jpeg'
    });

    expect(res.status).toBe(200);
    // El orden importa: guardar -> actualizar -> borrar. Si el guardado falla, la
    // foto anterior (la que la base sigue referenciando) no se toca; si falla el
    // UPDATE, tampoco.
    expect(eventos).toStrictEqual(['guardar:image/jpeg', 'actualizar', 'borrar:/uploads/vieja.jpg']);
    expect(storage.deletePhoto).toHaveBeenCalledTimes(1);
    expect(storage.savePhoto).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[2][1]).toStrictEqual([AHORA, '/uploads/nueva.jpg', null, UUID]);
    expect(res.body).toStrictEqual({ report: AVISO_PUBLICO });
  });

  it('un archivo que no es una imagen responde 400 y no guarda nada', async () => {
    montarBase();

    const res = await reunion().attach('foto', Buffer.from('esto no es una imagen'), {
      filename: 'trampa.jpg',
      contentType: 'image/jpeg'
    });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'El archivo no es una imagen válida.' });
    expect(storage.savePhoto).not.toHaveBeenCalled();
    expect(sqls()).toStrictEqual([SQL_TOKEN, SQL_AVISO]);
  });

  it('si guardar la foto falla responde 500 y la foto anterior no se toca', async () => {
    montarBase({ fila: aviso({ reunion_foto_url: '/uploads/vieja.jpg' }) });
    storage.savePhoto.mockRejectedValue(new Error('almacenamiento caído'));

    const res = await reunion().attach('foto', BYTES_JPEG, {
      filename: 'reunion.jpg',
      contentType: 'image/jpeg'
    });

    expect(res.status).toBe(500);
    expect(storage.deletePhoto).not.toHaveBeenCalled();
    expect(sqls()).not.toContain(SQL_REUNION);
  });

  it('si la base falla al actualizar, la foto anterior tampoco se borra', async () => {
    montarBase({
      fila: aviso({ reunion_foto_url: '/uploads/vieja.jpg' }),
      resto: () => {
        throw new Error('base caída');
      }
    });

    const res = await reunion().attach('foto', BYTES_JPEG, {
      filename: 'reunion.jpg',
      contentType: 'image/jpeg'
    });

    expect(res.status).toBe(500);
    expect(storage.savePhoto).toHaveBeenCalledTimes(1);
    expect(storage.deletePhoto).not.toHaveBeenCalled();
  });
});

describe('POST /api/reports/:id/resolve — resolver o reabrir', () => {
  it('sin token responde 401', async () => {
    const res = await pedir(app).post(`/api/reports/${UUID}/resolve`).send({ resolved: true });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un :id que no es UUID responde 400', async () => {
    montarBase();

    const res = await resolver({ resolved: true }, 'xyz');

    expect(res.status).toBe(400);
    // El id mal formado y el `resolved` inválido ya se distinguen: cada validador
    // lleva su propio mensaje en vez de compartir un "Dato inválido." genérico.
    expect(res.body).toStrictEqual(ID_INVALIDO);
    expect(sqls()).toStrictEqual([SQL_TOKEN]);
  });

  it.each([{}, { resolved: 'quizás' }, { resolved: null }])(
    'sin un booleano válido responde 400 (%o)',
    async cuerpo => {
      montarBase();

      const res = await resolver(cuerpo);

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(RESOLVED_INVALIDO);
      expect(sqls()).toStrictEqual([SQL_TOKEN]);
    }
  );

  it('un aviso inexistente responde 404', async () => {
    montarBase({ fila: null });

    const res = await resolver({ resolved: true });

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(NO_ENCONTRADO);
  });

  it('un aviso de otro usuario responde 403 (no 404)', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }) });

    const res = await resolver({ resolved: true });

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(AJENO);
    expect(sqls()).toStrictEqual([SQL_TOKEN, SQL_AVISO]);
  });

  it('con resolved=true marca el aviso como resuelto con la marca de tiempo', async () => {
    montarBase();

    const res = await resolver({ resolved: true });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true, resolved: true });
    expect(sqlDe(db.query.mock.calls[2][0])).toBe(SQL_RESOLVER);
    expect(db.query.mock.calls[2][1]).toStrictEqual([true, AHORA, UUID]);
  });

  it('con resolved=false lo reabre y borra la marca de tiempo', async () => {
    montarBase();

    const res = await resolver({ resolved: false });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true, resolved: false });
    expect(db.query.mock.calls[2][1]).toStrictEqual([false, null, UUID]);
  });

  it('el texto "true" se rechaza con 400: exige el booleano de verdad', async () => {
    montarBase();

    const res = await resolver({ resolved: 'true' });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(RESOLVED_INVALIDO);
    expect(sqls()).toStrictEqual([SQL_TOKEN]);
  });

  // Hallazgo: `isBoolean()` de express-validator acepta 1, y después
  // `req.body.resolved === true` lo guardaba como `false`. La API decía 200 y
  // "resolved: false" ante un 1 que el cliente mandó como "sí".
  it('un 1 ahora se rechaza con 400 en vez de guardarse como false', async () => {
    montarBase();

    const res = await resolver({ resolved: 1 });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(RESOLVED_INVALIDO);
    expect(sqls()).toStrictEqual([SQL_TOKEN]);
  });

  it('un 0 también se rechaza con 400', async () => {
    montarBase();

    const res = await resolver({ resolved: 0 });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(RESOLVED_INVALIDO);
  });

  it('si la base falla responde 500', async () => {
    montarBase({
      resto: () => {
        throw new Error('base caída');
      }
    });

    const res = await resolver({ resolved: true });

    expect(res.status).toBe(500);
  });
});

describe('POST /api/reports/:id/flag — reportar un aviso', () => {
  it('sin token responde 401 y no consulta ni el aviso', async () => {
    const res = await pedir(app).post(`/api/reports/${UUID}/flag`);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('con la cuenta sin correo verificado responde 403', async () => {
    montarBase({ verificada: false });

    const res = await flag();

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(SIN_VERIFICAR);
    expect(sqls()).toStrictEqual([SQL_TOKEN, SQL_VERIFICADO]);
  });

  it('si la cuenta del token desapareció entre medio responde 401', async () => {
    db.query.mockImplementation(async sql => {
      if (sql === SQL_TOKEN) return { rows: [{ token_version: 0 }] };
      return { rows: [] };
    });

    const res = await flag();

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SESION_INVALIDA);
  });

  it('un :id que no es UUID responde 400', async () => {
    montarBase();

    const res = await flag('no-es-uuid');

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(ID_INVALIDO);
    expect(sqls()).toStrictEqual([SQL_TOKEN, SQL_VERIFICADO]);
  });

  it('un aviso inexistente responde 404', async () => {
    montarBase({ fila: null });

    const res = await flag();

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(NO_ENCONTRADO);
  });

  it('un aviso ya oculto (active = false) responde 404', async () => {
    montarBase({ fila: aviso({ active: false }) });

    const res = await flag();

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(NO_ENCONTRADO);
    expect(sqls()).toStrictEqual([SQL_TOKEN, SQL_VERIFICADO, SQL_AVISO]);
  });

  it('reportar el aviso propio responde 400 y no cuenta el reporte', async () => {
    montarBase();

    const res = await flag();

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(PROPIO);
    expect(sqls()).toStrictEqual([SQL_TOKEN, SQL_VERIFICADO, SQL_AVISO]);
  });

  it('una cuenta con menos de 24 h responde 403 y no gasta cupo diario', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }), creada: AHORA - DIA + 1 });

    const res = await flag();

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(CUENTA_NUEVA);
    expect(sqls()).toContain(SQL_CREADA);
    expect(sqls()).not.toContain(SQL_FLAGS_HOY);
    expect(db.query).toHaveBeenCalledWith(SQL_CREADA, [SUB]);
  });

  it('una cuenta que no existe responde 403', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }), creada: null });

    const res = await flag();

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(CUENTA_NUEVA);
  });

  it('una cuenta con exactamente 24 h ya puede reportar', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }), creada: AHORA - DIA, resto: restoFlag() });

    const res = await flag();

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual(GRACIAS);
  });

  it('un valor falsy que no sea `false` (0) tampoco deja reportar: responde 403', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }), verificada: 0, resto: restoFlag() });

    const res = await flag();

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(SIN_VERIFICAR);
  });

  it('con 10 reportes en 24 h responde 429 y no inserta nada', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }), resto: restoFlag({ hoy: 10 }) });

    const res = await flag();

    expect(res.status).toBe(429);
    expect(res.body).toStrictEqual(MUCHOS_HOY);
    expect(sqls()).not.toContain(SQL_INSERT_FLAG);
    expect(db.query.mock.calls[4]).toStrictEqual([SQL_FLAGS_HOY, [SUB, AHORA - DIA]]);
  });

  it('con 9 reportes en 24 h todavía puede reportar', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }), resto: restoFlag({ hoy: 9 }) });

    const res = await flag();

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual(GRACIAS);
  });

  it('registra el reporte y suma el contador del aviso', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }), resto: restoFlag({ tras: 3 }) });

    const res = await flag();

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual(GRACIAS);
    expect(db.query).toHaveBeenCalledTimes(7);
    expect(db.query.mock.calls[0]).toStrictEqual([SQL_TOKEN, [SUB]]);
    expect(db.query.mock.calls[1]).toStrictEqual([SQL_VERIFICADO, [SUB]]);
    expect(db.query.mock.calls[2]).toStrictEqual([SQL_AVISO, [UUID]]);
    expect(db.query.mock.calls[3]).toStrictEqual([SQL_CREADA, [SUB]]);
    expect(db.query.mock.calls[4]).toStrictEqual([SQL_FLAGS_HOY, [SUB, AHORA - DIA]]);
    expect(db.query.mock.calls[5]).toStrictEqual([SQL_INSERT_FLAG, [UUID, SUB, AHORA]]);
    expect(db.query.mock.calls[6]).toStrictEqual([SQL_SUMAR_FLAG, [UUID]]);
    expect(sqls()).not.toContain(SQL_OCULTAR);
  });

  it('con 4 reportes el aviso sigue visible (el umbral son 5)', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }), resto: restoFlag({ tras: 4 }) });

    const res = await flag();

    expect(res.status).toBe(200);
    expect(sqls()).not.toContain(SQL_OCULTAR);
  });

  it('al llegar a 5 reportes el aviso se auto-oculta', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }), resto: restoFlag({ tras: 5 }) });

    const res = await flag();

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual(GRACIAS);
    expect(db.query).toHaveBeenCalledTimes(8);
    expect(db.query.mock.calls[7]).toStrictEqual([SQL_OCULTAR, [UUID]]);
  });

  it('si el INSERT no devuelve fila (ya lo había reportado) no suma ni oculta', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }), resto: restoFlag({ insertadas: 0 }) });

    const res = await flag();

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual(GRACIAS);
    expect(sqls()).not.toContain(SQL_SUMAR_FLAG);
    expect(sqls()).not.toContain(SQL_OCULTAR);
  });

  it('si la base falla responde 500', async () => {
    montarBase({
      fila: aviso({ user_id: OTRO }),
      resto: () => {
        throw new Error('base caída');
      }
    });

    const res = await flag();

    expect(res.status).toBe(500);
  });

  it('flagLimiter corta con 429 la petición 21 de la misma IP', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }), resto: restoFlag() });
    const ip = '192.0.2.77';

    for (let i = 0; i < 20; i += 1) {
      const res = await flag(UUID, SUB, ip);
      expect(res.status).toBe(200);
    }

    const res = await flag(UUID, SUB, ip);

    expect(res.status).toBe(429);
    expect(res.text).toContain('Too many');
  });
});

describe('DELETE /api/reports/:id — dar de baja un aviso propio', () => {
  it('sin token responde 401 y no borra fotos', async () => {
    const res = await pedir(app).delete(`/api/reports/${UUID}`);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(storage.deletePhoto).not.toHaveBeenCalled();
  });

  it('un :id que no es UUID responde 400', async () => {
    montarBase();

    const res = await borrar('no-es-uuid');

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(ID_INVALIDO);
    expect(sqls()).toStrictEqual([SQL_TOKEN]);
  });

  it('un aviso inexistente responde 404', async () => {
    montarBase({ fila: null });

    const res = await borrar();

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(NO_ENCONTRADO);
    expect(storage.deletePhoto).not.toHaveBeenCalled();
  });

  it('un aviso de otro usuario responde 403 (no 404) y no se da de baja', async () => {
    montarBase({ fila: aviso({ user_id: OTRO }) });

    const res = await borrar();

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(AJENO);
    expect(sqls()).toStrictEqual([SQL_TOKEN, SQL_AVISO]);
    expect(storage.deletePhoto).not.toHaveBeenCalled();
  });

  it('da de baja el aviso usando el id de la fila, no el texto de la URL', async () => {
    montarBase();

    // La URL va en mayúsculas y la base devuelve el id normalizado: el UPDATE
    // debe usar el id de la fila (igual que hace PATCH /:id).
    const res = await borrar(UUID_MAYUS);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true });
    expect(db.query.mock.calls[1]).toStrictEqual([SQL_AVISO, [UUID_MAYUS]]);
    expect(db.query.mock.calls[2]).toStrictEqual([SQL_OCULTAR, [UUID]]);
    expect(storage.deletePhoto).toHaveBeenCalledTimes(1);
    expect(storage.deletePhoto).toHaveBeenCalledWith('/uploads/foto.jpg');
  });

  it('borra también la foto del reencuentro si existe', async () => {
    montarBase({ fila: aviso({ reunion_foto_url: '/uploads/reunion.jpg' }) });

    const res = await borrar();

    expect(res.status).toBe(200);
    expect(storage.deletePhoto).toHaveBeenCalledTimes(2);
    expect(storage.deletePhoto.mock.calls).toStrictEqual([['/uploads/foto.jpg'], ['/uploads/reunion.jpg']]);
  });

  it('sin foto sigue llamando al borrado una sola vez (con null)', async () => {
    montarBase({ fila: aviso({ foto_url: null }) });

    const res = await borrar();

    expect(res.status).toBe(200);
    expect(storage.deletePhoto).toHaveBeenCalledTimes(1);
    expect(storage.deletePhoto).toHaveBeenCalledWith(null);
  });

  it('si la base falla responde 500 y no borra la foto', async () => {
    montarBase({
      resto: () => {
        throw new Error('base caída');
      }
    });

    const res = await borrar();

    expect(res.status).toBe(500);
    expect(storage.deletePhoto).not.toHaveBeenCalled();
  });
});
