// Pruebas de la PARTE A de backend/routes/reports.js: creación de avisos
// (POST /), listado público (GET /), mis avisos (GET /mine/all), radio sugerido
// (GET /busqueda), muro de reencuentros (GET /reunions) y las constantes y
// limitadores de las líneas 17-60 (TIPOS_VALIDOS, SEXOS_VALIDOS, AVISOS_POR_DIA,
// createLimiter, infoLimiter, el límite de 5 MB de multer...).
//
// INFRAESTRUCTURA DE VALIDACIÓN: no se modifica ni una línea de producción. El
// router se importa de forma ESTÁTICA (para que Stryker lo relacione con estas
// pruebas vía `vitest related`) y sus dependencias (db, storage, push) se
// sustituyen con los dobles de ./helpers/aislar.js, que va PRIMERO.
//
// CÓMO SE AFIRMA: además del código de estado y del cuerpo JSON exacto, se
// comprueban los argumentos con los que la ruta llama a la base (SQL y
// parámetros) y a storage.savePhoto(). Los avisos creados se reconstruyen desde
// los propios parámetros del INSERT, que es justo lo que haría Postgres al
// devolver la fila.
//
// HALLAZGOS (comportamiento real de hoy; NO se arregla desde aquí):
//   1. Una foto con un mimetype que multer no permite (p. ej. text/plain) la
//      corta el fileFilter y el manejador central de server.js la traduce a un
//      400 con JSON ('Formato de imagen no permitido.'). Ese 400 lo pone
//      server.js, NO el router: montado sin manejador de errores la respuesta
//      era un 500 en HTML (lo que este archivo medía antes). El manejador se
//      replica abajo para no medir una app que no existe en producción.
//   2. Una imagen con el mimetype permitido pero con bytes que no son de
//      imagen responde 400 ('El archivo no es una imagen válida.') DESPUÉS de
//      haber pasado por los validadores: el mensaje no distingue entre "no
//      mandaste foto" y "la foto es falsa".
//   3. Con estado 'encontrado', `perdido_hace_horas` se acepta (y se valida)
//      pero se descarta en silencio: el aviso se guarda con NULL.
import { describe, it, expect, beforeEach } from 'vitest';
import { db, storage, push, crearApp, pedir, tokenPara } from './helpers/aislar.js';
import reportsRouter from '../routes/reports.js';
// La misma constante que usa la ruta: si aquí se volviera a escribir 111.32 a
// mano, la prueba dejaría de detectar que el cuadro es más estrecho que el radio.
import { KM_POR_GRADO, COS_MINIMO } from '../src/v2/geo.js';
import { DIAS_VIGENTE, MS_DIA } from '../ubicacion.js';
import { PNG as PNGjs } from 'pngjs';

const app = crearApp({ '/api/reports': reportsRouter });

// Copia literal del manejador de errores de server.js (líneas 184-197): es el
// que convierte el error del fileFilter de multer en un 400 con JSON.
app.use((err, req, res, _next) => {
  if (err && err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'La foto es demasiado grande (máximo 5 MB).' });
    }
    return res.status(400).json({ error: 'No se pudo procesar la imagen subida.' });
  }
  if (err && err.message === 'Formato de imagen no permitido.') {
    return res.status(400).json({ error: err.message });
  }
  res.status(err.status || 500).json({ error: 'Ocurrió un error en el servidor.' });
});

const SUB = 'duena-1';
const OTRO = 'curioso-2';
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';

const SIN_SESION = { error: 'No autenticado.' };
const SESION_INVALIDA = { error: 'Sesión inválida o expirada.' };
const SESION_CERRADA = { error: 'Tu sesión fue cerrada. Inicia sesión de nuevo.' };
const SIN_VERIFICAR = { error: 'Confirma tu correo para poder publicar. Revisa tu bandeja de entrada.' };
const CUPO_AVISOS = { error: 'Alcanzaste el límite de avisos por hoy. Intenta mañana.' };
const CUPO_HORARIO = { error: 'Publicaste demasiados avisos en poco tiempo. Intenta más tarde.' };
const IMAGEN_INVALIDA = { error: 'El archivo no es una imagen válida.' };
const VALOR_INVALIDO = { error: 'Invalid value' };

const SQL_INSERT = `INSERT INTO reports (id,user_id,estado,tipo,sexo,color,raza,collar,descripcion,nombre_mascota,foto_url,lat,lng,lat_public,lng_public,active,resolved,created_at,perdido_hace_horas,radio_km,foto_hash,chip_hash,chip_cifrado) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,TRUE,FALSE,$16,$17,$18,$19,$20,$21)`;
const SQL_AVISOS_24H = 'SELECT COUNT(*)::int AS n FROM reports WHERE user_id = $1 AND created_at > $2';

const TIPOS = ['perro', 'gato', 'ave', 'conejo', 'otro'];
const SEXOS = ['macho', 'hembra', 'desconocido'];

const AVISO = {
  estado: 'perdido',
  tipo: 'perro',
  sexo: 'macho',
  color: 'negro',
  lat: '-33.45',
  lng: '-70.66'
};

/* -------------------------- imágenes de prueba --------------------------- */
// Magic bytes reales; 12 bytes exactos para ejercitar el corte de tipoImagenReal.
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(9, 0x20)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(8, 0x20)]);
// Cabeceras completas, como las manda un navegador de verdad.
const JPEG_REAL = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG_REAL = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
const WEBP = Buffer.from('RIFF0000WEBP');
const SIN_MAGIC = Buffer.from('0123456789ab');
// Bordes del corte de 12 bytes: 0, 1, 2 y 3 bytes.
const VACIA = Buffer.alloc(0);
const UN_BYTE = Buffer.from([0xff]);
const DOS_BYTES = Buffer.from([0xff, 0xd8]);
const CORTA = Buffer.from([0xff, 0xd8, 0xff]);
const RIFF_SIN_WEBP = Buffer.from('RIFF0000XXXX');
const WEBP_SIN_RIFF = Buffer.from('XXXX0000WEBP');
// Solo cumplen UNA de las condiciones de su firma: si las comprobaciones se
// unieran con 'o' en vez de con 'y', se colarían como imagen.
const SOLO_TERCER_BYTE_JPEG = Buffer.from([0x00, 0x00, 0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const SOLO_PRIMER_BYTE_PNG = Buffer.from([0x89, 0x00, 0x00, 0x00, 0, 0, 0, 0, 0, 0, 0, 0]);
// 6 KB: cabe en los 5 MB reales, pero no en un límite mutado a 5 KB.
const GRANDE = Buffer.concat([JPEG, Buffer.alloc(6000, 0x20)]);

const FOTO = { buffer: JPEG, nombre: 'perro.jpg', tipo: 'image/jpeg' };

/* ------------------------------ utilidades ------------------------------- */
let visitas = 0;
function ipNueva() {
  visitas += 1;
  return `10.${Math.floor(visitas / 250)}.${visitas % 250}.7`;
}

function peticion(metodo, ruta, opciones = {}) {
  const { sub = SUB, ver = 0, ip = ipNueva() } = opciones;
  const p = pedir(app)[metodo](ruta).set('x-forwarded-for', ip);
  return sub === null ? p : p.set('Authorization', `Bearer ${tokenPara(sub, ver)}`);
}

function crear(cuerpo, opciones) {
  return peticion('post', '/api/reports', opciones).send(cuerpo);
}

function crearConFoto(campos, foto = FOTO, opciones) {
  let p = peticion('post', '/api/reports', opciones);
  for (const [clave, valor] of Object.entries(campos)) p = p.field(clave, valor);
  return p.attach('foto', foto.buffer, { filename: foto.nombre, contentType: foto.tipo });
}

function reposar() {
  return new Promise(resolve => setImmediate(resolve)).then(
    () => new Promise(resolve => setImmediate(resolve))
  );
}

// Espacios colapsados: afirmar el SQL completo sin depender de la indentación.
function limpiar(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function sqlDe(fragmento) {
  return db.query.mock.calls.find(call => String(call[0]).includes(fragmento));
}

function paramsDe(fragmento) {
  const llamada = sqlDe(fragmento);
  return llamada ? llamada[1] : undefined;
}

// Columnas del INSERT, en su orden, para reconstruir la fila que devolvería la
// base al hacer el SELECT posterior.
const COLUMNAS = [
  'id',
  'user_id',
  'estado',
  'tipo',
  'sexo',
  'color',
  'raza',
  'collar',
  'descripcion',
  'nombre_mascota',
  'foto_url',
  'lat',
  'lng',
  'lat_public',
  'lng_public',
  'created_at',
  'perdido_hace_horas',
  'radio_km',
  'foto_hash',
  'chip_hash',
  'chip_cifrado'
];

const creados = [];
const porId = new Map();

function filaDeParams(params) {
  const fila = { active: true, resolved: false };
  COLUMNAS.forEach((columna, i) => {
    fila[columna] = params[i];
  });
  return fila;
}

// Base de mentira para las rutas de avisos. `resto` responde a lo que no está
// contemplado aquí; por defecto, cero filas.
function base(opciones = {}) {
  const { avisos = 0, verificado = true, zonas = [], resto } = opciones;
  db.query.mockImplementation(async (sql, params) => {
    if (sql.includes('token_version FROM users')) return { rows: [{ token_version: 0 }] };
    if (sql.includes('email_verified FROM users')) return { rows: [{ email_verified: verificado }] };
    if (sql.includes('created_at > $2')) return { rows: [{ n: avisos }] };
    if (sql.startsWith('INSERT INTO reports')) {
      creados.push(params);
      porId.set(params[0], params);
      return { rows: [] };
    }
    if (sql === 'SELECT * FROM reports WHERE id = $1') {
      const params2 = porId.get(params[0]);
      return { rows: params2 ? [filaDeParams(params2)] : [] };
    }
    if (sql.includes('FROM zone_alerts')) return { rows: zonas };
    if (resto) return resto(sql, params);
    return { rows: [] };
  });
}

const AVISO_PUBLICO = {
  id: expect.any(String),
  estado: 'perdido',
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
  // El microchip solo deja ver si existe; los últimos 4 dígitos van solo en el
  // endpoint dedicado. Aquí no hay chip declarado.
  tiene_chip: false,
  chip_enmascarado: null,
  radio_km: null,
  perdido_hace_horas: null,
  lat: expect.any(Number),
  lng: expect.any(Number),
  created_at: expect.any(Number)
};

beforeEach(() => {
  db.query.mockReset();
  storage.savePhoto.mockReset();
  storage.savePhoto.mockResolvedValue('/uploads/foto-de-prueba.jpg');
  push.sendToUser.mockReset();
  push.sendToUser.mockResolvedValue(undefined);
  creados.length = 0;
  porId.clear();
});

/* ======================================================================== */
/* POST /api/reports/ · crear aviso                                         */
/* ======================================================================== */
describe('POST /api/reports/ · sesión y correo verificado', () => {
  it('sin cabecera Authorization responde 401 y no consulta la base', async () => {
    base();
    const res = await crear(AVISO, { sub: null });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SIN_SESION);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un token ilegible responde 401 sin consultar la base', async () => {
    base();
    const res = await pedir(app)
      .post('/api/reports')
      .set('x-forwarded-for', ipNueva())
      .set('Authorization', 'Bearer no-es-un-token')
      .send(AVISO);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SESION_INVALIDA);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un token de una cuenta que ya no existe responde 401', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = await crear(AVISO);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SESION_INVALIDA);
  });

  it('un token con la versión de sesión revocada responde 401 y no inserta', async () => {
    base();
    const res = await crear(AVISO, { ver: 7 });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SESION_CERRADA);
    expect(creados).toHaveLength(0);
  });

  it('una cuenta con el correo sin verificar responde 403 y no inserta', async () => {
    base({ verificado: false });
    const res = await crear(AVISO);

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(SIN_VERIFICAR);
    expect(creados).toHaveLength(0);
  });

  it('si la cuenta desaparece entre requireAuth y requireVerified responde 401', async () => {
    db.query.mockImplementation(async sql => {
      if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
      return { rows: [] };
    });
    const res = await crear(AVISO);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SESION_INVALIDA);
  });
});

describe('POST /api/reports/ · validadores del cuerpo', () => {
  it('un cuerpo vacío responde 400 y no inserta', async () => {
    base();
    const res = await crear({});

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(VALOR_INVALIDO);
    expect(creados).toHaveLength(0);
  });

  it('sin cuerpo y con content-type de texto tampoco inserta', async () => {
    base();
    const res = await peticion('post', '/api/reports').set('Content-Type', 'text/plain').send('perro');

    expect(res.status).toBe(400);
    expect(creados).toHaveLength(0);
  });

  it.each([
    ['estado fuera de la lista', { estado: 'dormido' }],
    ['estado nulo', { estado: null }],
    ['tipo fuera de la lista', { tipo: 'dinosaurio' }],
    ['tipo nulo', { tipo: null }],
    ['sexo fuera de la lista', { sexo: 'otro' }],
    ['color vacío', { color: '' }],
    ['color de solo espacios', { color: '   ' }],
    ['color de 61 caracteres', { color: 'x'.repeat(61) }],
    ['raza de 81 caracteres', { raza: 'x'.repeat(81) }],
    ['collar de 41 caracteres', { collar: 'x'.repeat(41) }],
    ['descripción de 1001 caracteres', { descripcion: 'x'.repeat(1001) }],
    ['nombre de 61 caracteres', { nombre_mascota: 'x'.repeat(61) }],
    ['lat no numérica', { lat: 'sur' }],
    ['lat vacía', { lat: '' }],
    ['lat mayor que 90', { lat: '90.5' }],
    ['lat menor que -90', { lat: '-90.5' }],
    ['lng mayor que 180', { lng: '180.5' }],
    ['lng no numérica', { lng: 'poniente' }],
    ['perdido_hace_horas no entero', { perdido_hace_horas: '2.5' }],
    ['perdido_hace_horas negativo', { perdido_hace_horas: '-1' }],
    ['perdido_hace_horas de más de un año', { perdido_hace_horas: '8761' }]
  ])('rechaza con 400 y sin insertar: %s', async (nombre, cambio) => {
    base();
    const res = await crear({ ...AVISO, ...cambio });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(VALOR_INVALIDO);
    expect(creados).toHaveLength(0);
  });

  it('un cuerpo que no es un objeto tampoco inserta', async () => {
    base();
    const res = await pedir(app)
      .post('/api/reports')
      .set('x-forwarded-for', ipNueva())
      .set('Authorization', `Bearer ${tokenPara(SUB)}`)
      .set('Content-Type', 'application/json')
      .send(JSON.stringify([]));

    expect(res.status).toBe(400);
    expect(creados).toHaveLength(0);
  });

  it.each(TIPOS)('acepta el tipo válido %s y lo guarda', async tipo => {
    base();
    const res = await crear({ ...AVISO, tipo });

    expect(res.status).toBe(201);
    expect(creados[0][3]).toBe(tipo);
  });

  it.each(SEXOS)('acepta el sexo válido %s y lo guarda', async sexo => {
    base();
    const res = await crear({ ...AVISO, sexo });

    expect(res.status).toBe(201);
    expect(creados[0][4]).toBe(sexo);
  });

  it.each([
    ['perdido', 201],
    ['encontrado', 201],
    ['PERDIDO', 400],
    ['', 400]
  ])('el estado %s responde %i', async (estado, codigo) => {
    base();
    const res = await crear({ ...AVISO, estado });

    expect(res.status).toBe(codigo);
  });

  it('acepta las coordenadas de los bordes del mapa', async () => {
    base();
    const res = await crear({ ...AVISO, lat: '90', lng: '180' });

    expect(res.status).toBe(201);
    expect(creados[0][11]).toBe(90);
    expect(creados[0][12]).toBe(180);
  });

  it('acepta los bordes negativos del mapa', async () => {
    base();
    const res = await crear({ ...AVISO, lat: '-90', lng: '-180' });

    expect(res.status).toBe(201);
    expect(creados[0][11]).toBe(-90);
    expect(creados[0][12]).toBe(-180);
  });

  it('recorta los espacios del color antes de guardarlo', async () => {
    base();
    const res = await crear({ ...AVISO, color: '  negro  ' });

    expect(res.status).toBe(201);
    expect(creados[0][5]).toBe('negro');
  });
});

describe('POST /api/reports/ · guardado del aviso', () => {
  it('crea el aviso con 201, el JSON público exacto y los parámetros del INSERT', async () => {
    base();
    const res = await crear({ ...AVISO, raza: 'quiltro', nombre_mascota: 'Firulais' });

    expect(res.status).toBe(201);
    expect(res.body.report).toStrictEqual({ ...AVISO_PUBLICO, raza: 'quiltro', nombre_mascota: 'Firulais' });
    expect(limpiar(sqlDe('INSERT INTO reports')[0])).toBe(SQL_INSERT);
    expect(creados[0].slice(1)).toStrictEqual([
      SUB,
      'perdido',
      'perro',
      'macho',
      'negro',
      'quiltro',
      null,
      null,
      'Firulais',
      null,
      -33.45,
      -70.66,
      expect.any(Number),
      expect.any(Number),
      expect.any(Number),
      null,
      null,
      null,
      // Sin microchip declarado: huella y forma cifrada van a NULL.
      null,
      null
    ]);
    expect(typeof creados[0][0]).toBe('string');
    expect(creados[0][0]).toHaveLength(36);
    expect(db.query).toHaveBeenCalledWith('SELECT * FROM reports WHERE id = $1', [creados[0][0]]);
  });

  it('los campos opcionales vacíos se guardan como NULL', async () => {
    base();
    const res = await crear({ ...AVISO, raza: '', collar: '', descripcion: '', nombre_mascota: '' });

    expect(res.status).toBe(201);
    expect(creados[0].slice(6, 10)).toStrictEqual([null, null, null, null]);
    expect(res.body.report.nombre_mascota).toBeNull();
  });

  it('el created_at del INSERT es de ahora', async () => {
    base();
    const antes = Date.now();
    await crear(AVISO);

    expect(creados[0][15]).toBeGreaterThanOrEqual(antes);
    expect(creados[0][15]).toBeLessThanOrEqual(Date.now());
  });

  it('el cupo cuenta los avisos de las últimas 24 horas', async () => {
    base();
    await crear(AVISO);

    const [sql, params] = sqlDe('created_at > $2');
    expect(limpiar(sql)).toBe(SQL_AVISOS_24H);
    expect(params[0]).toBe(SUB);
    const transcurrido = Date.now() - params[1];
    expect(transcurrido).toBeGreaterThan(24 * 3600 * 1000 - 5000);
    expect(transcurrido).toBeLessThan(24 * 3600 * 1000 + 5000);
  });

  it('con 20 avisos en 24 h responde 429 y no inserta', async () => {
    base({ avisos: 20 });
    const res = await crear(AVISO);

    expect(res.status).toBe(429);
    expect(res.body).toStrictEqual(CUPO_AVISOS);
    expect(creados).toHaveLength(0);
  });

  it('con 19 avisos en 24 h todavía deja publicar', async () => {
    base({ avisos: 19 });
    const res = await crear(AVISO);

    expect(res.status).toBe(201);
    expect(creados).toHaveLength(1);
  });

  it('si la base falla al contar los avisos responde 500', async () => {
    db.query.mockImplementation(async sql => {
      if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('email_verified')) return { rows: [{ email_verified: true }] };
      throw new Error('caída al contar');
    });
    const res = await crear(AVISO);

    expect(res.status).toBe(500);
  });

  it('si la base falla al insertar responde 500', async () => {
    db.query.mockImplementation(async sql => {
      if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('email_verified')) return { rows: [{ email_verified: true }] };
      if (sql.includes('created_at > $2')) return { rows: [{ n: 0 }] };
      throw new Error('caída al insertar');
    });
    const res = await crear(AVISO);

    expect(res.status).toBe(500);
  });
});

describe('POST /api/reports/ · radio sugerido y aviso a la zona', () => {
  it('sin perdido_hace_horas el radio queda en NULL', async () => {
    base();
    await crear(AVISO);

    expect(creados[0][16]).toBeNull();
    expect(creados[0][17]).toBeNull();
  });

  it('encontrado descarta el perdido_hace_horas que sí se envía', async () => {
    base();
    const res = await crear({ ...AVISO, estado: 'encontrado', perdido_hace_horas: '5' });

    expect(res.status).toBe(201);
    expect(creados[0][16]).toBeNull();
    expect(creados[0][17]).toBeNull();
    expect(res.body.report.nombre_mascota).toBeNull();
  });

  it('perdido con 0 horas guarda el radio base del gato', async () => {
    base();
    await crear({ ...AVISO, tipo: 'gato', perdido_hace_horas: '0' });

    expect(creados[0][16]).toBe(0);
    expect(creados[0][17]).toBe(0.05);
  });

  it('perdido con 24 horas amplía el radio según busqueda.js', async () => {
    base();
    await crear({ ...AVISO, tipo: 'gato', perdido_hace_horas: '24' });

    expect(creados[0][16]).toBe(24);
    expect(creados[0][17]).toBe(0.3);
  });

  it.each(TIPOS)('el radio de un %s nunca es nulo cuando hay horas', async tipo => {
    base();
    await crear({ ...AVISO, tipo, perdido_hace_horas: '1' });

    expect(creados[0][17]).toBeGreaterThan(0);
  });

  it('un aviso perdido avisa por push solo a las zonas dentro del radio y sin el dueño', async () => {
    // Distancias al punto exacto (-33.45, -70.66): OTRO ~72 m (dentro),
    // cerca-4 ~445 m (dentro), lejos-5 ~630 m (fuera del radio de 500 m),
    // y el propio dueño, que nunca recibe su aviso.
    base({
      zonas: [
        { user_id: OTRO, lat: -33.4505, lng: -70.6605 },
        { user_id: SUB, lat: -33.4505, lng: -70.6605 },
        { user_id: 'cerca-4', lat: -33.446, lng: -70.66 },
        { user_id: 'lejos-5', lat: -33.446, lng: -70.6552 }
      ]
    });
    const res = await crear({ ...AVISO, perdido_hace_horas: '0' });
    await reposar();

    expect(res.status).toBe(201);
    expect(paramsDe('FROM zone_alerts')).toStrictEqual([
      -33.45 - 0.5 / KM_POR_GRADO,
      -33.45 + 0.5 / KM_POR_GRADO,
      -70.66 - 0.5 / (KM_POR_GRADO * Math.cos((-33.45 * Math.PI) / 180)),
      -70.66 + 0.5 / (KM_POR_GRADO * Math.cos((-33.45 * Math.PI) / 180)),
      // Quinto parámetro: el corte de vigencia de la última ubicación.
      expect.any(Number)
    ]);
    expect(push.sendToUser.mock.calls.map(call => call[0])).toStrictEqual([OTRO, 'cerca-4']);
    expect(push.sendToUser).toHaveBeenCalledWith(OTRO, {
      title: '🐾 Se perdió una mascota cerca de ti',
      body: 'Un perro negro se perdió en tu zona. Toca para ver el aviso.',
      report_id: res.body.report.id,
      tag: 'zona-' + res.body.report.id
    });
  });

  it('el aviso de zona usa el tipo y el color del aviso que se creó', async () => {
    base({ zonas: [{ user_id: OTRO, lat: -33.4505, lng: -70.6605 }] });
    await crear({ ...AVISO, tipo: 'gato', color: 'blanco', perdido_hace_horas: '3' });
    await reposar();

    expect(push.sendToUser.mock.calls[0][1].body).toBe(
      'Un gato blanco se perdió en tu zona. Toca para ver el aviso.'
    );
  });

  it('un aviso encontrado no consulta las zonas suscritas', async () => {
    base({ zonas: [{ user_id: OTRO, lat: -33.4505, lng: -70.6605 }] });
    await crear({ ...AVISO, estado: 'encontrado' });
    await reposar();

    expect(sqlDe('FROM zone_alerts')).toBeUndefined();
    expect(push.sendToUser).not.toHaveBeenCalled();
  });

  it('cerca del polo el cuadro de búsqueda no se dispara (coseno acotado a 0.1)', async () => {
    base({ zonas: [] });
    await crear({ ...AVISO, lat: '89.9', lng: '0', perdido_hace_horas: '0' });
    await reposar();

    const [latMin, latMax, lngMin, lngMax] = paramsDe('FROM zone_alerts');
    expect(latMin).toBeCloseTo(89.9 - 0.5 / KM_POR_GRADO, 10);
    expect(latMax).toBeCloseTo(89.9 + 0.5 / KM_POR_GRADO, 10);
    expect(lngMin).toBeCloseTo(-0.5 / (KM_POR_GRADO * COS_MINIMO), 10);
    expect(lngMax).toBeCloseTo(0.5 / (KM_POR_GRADO * COS_MINIMO), 10);
  });

  it('con un radio de aviso grande el cuadro usa ese radio, no el mínimo de 500 m', async () => {
    base({ zonas: [] });
    await crear({ ...AVISO, tipo: 'perro', perdido_hace_horas: '8760' });
    await reposar();

    expect(creados[0][17]).toBe(15);
    const [latMin, latMax, lngMin, lngMax] = paramsDe('FROM zone_alerts');
    const dLng = 15 / (KM_POR_GRADO * Math.cos((-33.45 * Math.PI) / 180));
    expect(latMin).toBeCloseTo(-33.45 - 15 / KM_POR_GRADO, 10);
    expect(latMax).toBeCloseTo(-33.45 + 15 / KM_POR_GRADO, 10);
    expect(lngMin).toBeCloseTo(-70.66 - dLng, 10);
    expect(lngMax).toBeCloseTo(-70.66 + dLng, 10);
  });

  it('solo avisa a zonas vigentes: la zona a mano o la ubicación reciente', async () => {
    base({ zonas: [] });
    await crear({ ...AVISO, perdido_hace_horas: '0' });
    await reposar();

    const sql = sqlDe('FROM zone_alerts')[0];
    expect(sql).toContain("origen = 'manual' OR COALESCE(updated_at, created_at) >= $5");
    const corte = paramsDe('FROM zone_alerts')[4];
    const esperado = Date.now() - DIAS_VIGENTE * MS_DIA;
    expect(Math.abs(corte - esperado)).toBeLessThan(5000);
  });

  it('si el push falla, la respuesta del aviso sigue siendo 201', async () => {
    base({ zonas: [{ user_id: OTRO, lat: -33.4505, lng: -70.6605 }] });
    push.sendToUser.mockRejectedValue(new Error('sin servicio de push'));
    const res = await crear({ ...AVISO, perdido_hace_horas: '0' });
    await reposar();

    expect(res.status).toBe(201);
    expect(push.sendToUser).toHaveBeenCalledTimes(1);
  });
});

/* ======================================================================== */
/* POST /api/reports/ · coincidencias y fotos repetidas                     */
/* ======================================================================== */
function candidatoZona(cambios = {}) {
  return {
    id: 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d',
    user_id: OTRO,
    estado: 'encontrado',
    tipo: 'perro',
    sexo: 'macho',
    color: 'negro',
    raza: null,
    collar: null,
    lat: -33.45,
    lng: -70.66,
    created_at: Date.now(),
    perdido_hace_horas: null,
    foto_hash: null,
    active: true,
    resolved: false,
    ...cambios
  };
}

// Cuadrado de un color único: su dHash son 64 bits a 0.
function pngCuadrado() {
  const png = new PNGjs({ width: 9, height: 8 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 15;
    png.data[i + 1] = 15;
    png.data[i + 2] = 15;
    png.data[i + 3] = 255;
  }
  return PNGjs.sync.write(png);
}

const HASH_CUADRADO = '0000000000000000';

function baseConCandidatos(candidatos, extra = {}) {
  return base({
    ...extra,
    resto: (sql, params) => {
      void params;
      return sql.includes('id <> $2') ? { rows: candidatos } : { rows: [] };
    }
  });
}

describe('POST /api/reports/ · coincidencias entre avisos', () => {
  it('avisa al dueño del aviso candidato y al autor cuando hay coincidencia', async () => {
    baseConCandidatos([candidatoZona()]);
    const res = await crear(AVISO);
    await reposar();

    expect(res.status).toBe(201);
    const params = paramsDe('id <> $2');
    expect(params[0]).toBe('perro');
    expect(params[1]).toBe(creados[0][0]);
    const dLat = 5 / KM_POR_GRADO;
    const dLng = 5 / (KM_POR_GRADO * Math.cos((-33.45 * Math.PI) / 180));
    expect(params[2]).toBeCloseTo(-33.45 - dLat, 10);
    expect(params[3]).toBeCloseTo(-33.45 + dLat, 10);
    expect(params[4]).toBeCloseTo(-70.66 - dLng, 10);
    expect(params[5]).toBeCloseTo(-70.66 + dLng, 10);
    expect(push.sendToUser.mock.calls.map(call => call[0])).toStrictEqual([OTRO, SUB]);
    expect(push.sendToUser).toHaveBeenCalledWith(OTRO, {
      title: '🔎 Un aviso puede coincidir con el tuyo',
      body: 'Publicaron un perdido de perro a menos de 500 m de tu aviso. Toca para verlo.',
      report_id: creados[0][0],
      tag: 'coincidencia-' + creados[0][0]
    });
    expect(push.sendToUser).toHaveBeenCalledWith(SUB, {
      title: '🔎 Encontramos posibles coincidencias',
      body: 'Hay 1 aviso(s) que podrían ser tu mascota. Toca para verlos.',
      report_id: creados[0][0],
      tag: 'coincidencia-' + creados[0][0]
    });
  });

  it('no avisa de una coincidencia con un aviso del propio usuario', async () => {
    baseConCandidatos([candidatoZona({ user_id: SUB })]);
    const res = await crear(AVISO);
    await reposar();

    expect(res.status).toBe(201);
    expect(push.sendToUser).not.toHaveBeenCalled();
  });

  it('describe la distancia cuando la coincidencia no está pegada al aviso', async () => {
    baseConCandidatos([candidatoZona({ lat: -33.4428 })]);
    const res = await crear(AVISO);
    await reposar();

    expect(res.status).toBe(201);
    expect(push.sendToUser).toHaveBeenCalledWith(
      OTRO,
      expect.objectContaining({ body: expect.stringContaining('a 0.8 km') })
    );
  });

  it('una coincidencia por debajo del puntaje mínimo no avisa a nadie', async () => {
    // Mismo tipo y fechas, pero lejos del centro del radio y sin nada más en
    // común: matching.js lo descarta y la ruta no debe mandar push.
    baseConCandidatos([
      candidatoZona({ lat: -33.442, color: 'atigrado', sexo: 'hembra', raza: 'beagle', collar: 'azul' })
    ]);
    const res = await crear(AVISO);
    await reposar();

    expect(res.status).toBe(201);
    expect(push.sendToUser).not.toHaveBeenCalled();
  });

  it('si falla la consulta de candidatos, el aviso igual se crea (201)', async () => {
    base({
      resto: sql => {
        if (sql.includes('id <> $2')) throw new Error('caída al buscar');
        return { rows: [] };
      }
    });
    const res = await crear(AVISO);
    await reposar();

    expect(res.status).toBe(201);
    expect(push.sendToUser).not.toHaveBeenCalled();
  });

  it('guarda el hash de la foto y avisa si ya estaba publicada', async () => {
    baseConCandidatos([candidatoZona({ foto_hash: HASH_CUADRADO })]);
    const res = await crearConFoto(AVISO, { buffer: pngCuadrado(), nombre: 'perro.png', tipo: 'image/png' });
    await reposar();

    expect(res.status).toBe(201);
    expect(creados[0][18]).toBe(HASH_CUADRADO);
    expect(push.sendToUser).toHaveBeenCalledWith(SUB, {
      title: '⚠️ Esa foto ya está en otro aviso',
      body: 'Ya existe un aviso con la misma foto. Revisa que no sea una publicación repetida.',
      report_id: creados[0][0],
      tag: 'duplicado-' + creados[0][0]
    });
  });
});

describe('POST /api/reports/ · la ubicación pública se difumina', () => {
  it('nunca es la exacta y siempre cae dentro de los 300 m', async () => {
    base();
    const latDeltas = [];
    const lngDeltas = [];
    for (let i = 0; i < 30; i++) {
      const res = await crear({ ...AVISO, estado: 'encontrado' });
      expect(res.status).toBe(201);
      const params = creados[creados.length - 1];
      expect(params[11]).toBe(-33.45);
      expect(params[12]).toBe(-70.66);
      expect(params[13]).not.toBe(params[11]);
      expect(params[14]).not.toBe(params[12]);
      latDeltas.push(params[13] - params[11]);
      lngDeltas.push(params[14] - params[12]);
    }

    const MAX_LAT = 300 / 111320;
    const MAX_LNG = 300 / (111320 * Math.cos((-33.45 * Math.PI) / 180));
    // El desplazamiento va en los dos sentidos y llega a la mitad del radio
    // (con 30 muestras, quedarse corto es prácticamente imposible).
    expect(latDeltas.some(delta => delta < 0)).toBe(true);
    expect(latDeltas.some(delta => delta > 0)).toBe(true);
    expect(lngDeltas.some(delta => delta < 0)).toBe(true);
    expect(lngDeltas.some(delta => delta > 0)).toBe(true);
    expect(Math.max(...latDeltas.map(Math.abs))).toBeGreaterThan(0.5 * MAX_LAT);
    expect(Math.max(...lngDeltas.map(Math.abs))).toBeGreaterThan(0.5 * MAX_LNG);
    expect(latDeltas.every(delta => Math.abs(delta) <= MAX_LAT)).toBe(true);
    expect(lngDeltas.every(delta => Math.abs(delta) <= MAX_LNG)).toBe(true);
  });

  it('en latitudes polares la difusión de longitud crece como 1/cos(lat)', async () => {
    base();
    const deltasLng = [];
    for (let i = 0; i < 6; i++) {
      await crear({ ...AVISO, estado: 'encontrado', lat: '89.9', lng: '0' });
      const params = creados[creados.length - 1];
      expect(params[11]).toBe(89.9);
      deltasLng.push(Math.abs(params[14] - params[12]));
    }

    const MAX_LNG = 300 / (111320 * Math.cos((89.9 * Math.PI) / 180));
    expect(Math.max(...deltasLng)).toBeGreaterThan(0.01);
    expect(Math.max(...deltasLng)).toBeLessThanOrEqual(MAX_LNG);
  });

  it('la frontera del radio cae donde manda haversine (100 m a 1 km)', async () => {
    // Copia exacta de la fórmula de la ruta: sirve de regla de medición.
    const haversine = (lat1, lng1, lat2, lng2) => {
      const toRad = d => (d * Math.PI) / 180;
      const dLat = toRad(lat2 - lat1);
      const dLng = toRad(lng2 - lng1);
      const a =
        Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
      return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    };
    // 1 grado de latitud con R=6371: 111,19492664455873 km.
    const GRADO_KM = (6371 * Math.PI) / 180;
    const RADIO = 0.5; // perro sin horas -> max(0.4, 0.5)
    const cosLat = Math.cos((-33.45 * Math.PI) / 180);
    // Las dos últimas de la recta están a 2 cm y a 10 cm de más: cualquier
    // fórmula que mueva la distancia más de un 0,004 % cambia quién recibe el
    // aviso. Las diagonales (3-4-5) llevan desplazamiento también en longitud,
    // que es donde pesa el producto de cosenos de haversine.
    const kilometros = [0.1, 0.25, 0.4, 0.45, 0.48, 0.495, 0.499, 0.50002, 0.5001, 0.51, 0.55, 0.7, 1];
    const zonas = [
      ...kilometros.map((km, i) => ({ user_id: 'zona-' + i, lat: -33.45 + km / GRADO_KM, lng: -70.66 })),
      ...[0.4999, 0.50002, 0.5001, 0.51].map((km, i) => ({
        user_id: 'diagonal-' + i,
        lat: -33.45 + (0.6 * km) / GRADO_KM,
        lng: -70.66 + (0.8 * km) / (GRADO_KM * cosLat)
      }))
    ];
    base({ zonas });
    await crear({ ...AVISO, perdido_hace_horas: '0' });
    await reposar();

    // La medición del test coincide con la que hace la ruta (tolerancia estrecha).
    expect(haversine(-33.45, -70.66, zonas[0].lat, zonas[0].lng)).toBeCloseTo(0.1, 6);
    expect(haversine(-33.45, -70.66, zonas[6].lat, zonas[6].lng)).toBeCloseTo(0.499, 4);
    expect(haversine(-33.45, -70.66, zonas[12].lat, zonas[12].lng)).toBeCloseTo(1, 6);
    expect(haversine(-33.45, -70.66, zonas[14].lat, zonas[14].lng)).toBeCloseTo(0.50002, 4);

    const ESPERADOS = ['zona-0', 'zona-1', 'zona-2', 'zona-3', 'zona-4', 'zona-5', 'zona-6', 'diagonal-0'];
    const dentro = zonas.filter(z => haversine(-33.45, -70.66, z.lat, z.lng) <= RADIO);
    expect(dentro.map(z => z.user_id)).toStrictEqual(ESPERADOS);
    expect(push.sendToUser.mock.calls.map(call => call[0])).toStrictEqual(ESPERADOS);
  });
});

describe('POST /api/reports/ · foto (multer + magic bytes)', () => {
  it.each([
    ['JPEG mínimo de 12 bytes', 'image/jpeg', JPEG, 'image/jpeg'],
    ['JPEG con cabecera JFIF completa', 'image/jpeg', JPEG_REAL, 'image/jpeg'],
    ['PNG mínimo de 12 bytes', 'image/png', PNG, 'image/png'],
    ['PNG con cabecera IHDR completa', 'image/png', PNG_REAL, 'image/png'],
    ['WEBP de 12 bytes', 'image/webp', WEBP, 'image/webp']
  ])('guarda un %s con su tipo real y su URL en el aviso', async (nombre, mimetype, buffer, tipoReal) => {
    base();
    // El nombre del archivo no importa: manda el mimetype que declara el cliente.
    const res = await crearConFoto(AVISO, { buffer, nombre: 'mascota.otra', tipo: mimetype });

    expect(res.status).toBe(201);
    expect(storage.savePhoto).toHaveBeenCalledTimes(1);
    expect(storage.savePhoto).toHaveBeenCalledWith(buffer, tipoReal);
    expect(creados[0][10]).toBe('/uploads/foto-de-prueba.jpg');
    expect(res.body.report.foto_url).toBe('/uploads/foto-de-prueba.jpg');
  });

  it.each([
    ['bytes sin firma de imagen', SIN_MAGIC, 'image/webp'],
    ['archivo de 0 bytes', VACIA, 'image/jpeg'],
    ['archivo de 1 byte', UN_BYTE, 'image/jpeg'],
    ['archivo de 2 bytes', DOS_BYTES, 'image/jpeg'],
    ['archivo de 3 bytes', CORTA, 'image/webp'],
    ['RIFF que no es WEBP', RIFF_SIN_WEBP, 'image/webp'],
    ['WEBP sin cabecera RIFF', WEBP_SIN_RIFF, 'image/webp'],
    ['JPEG al que solo le cuadra el tercer byte', SOLO_TERCER_BYTE_JPEG, 'image/jpeg'],
    ['PNG al que solo le cuadra el primer byte', SOLO_PRIMER_BYTE_PNG, 'image/png']
  ])('rechaza con 400 sin guardar: %s', async (nombre, buffer, mimetype) => {
    base();
    const res = await crearConFoto(AVISO, { buffer, nombre: 'falsa.bin', tipo: mimetype });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(IMAGEN_INVALIDA);
    expect(storage.savePhoto).not.toHaveBeenCalled();
    expect(creados).toHaveLength(0);
  });

  it('una foto de 6 KB con mimetype permitido se acepta (el tope es 5 MB)', async () => {
    base();
    const res = await crearConFoto(AVISO, { buffer: GRANDE, nombre: 'grande.jpg', tipo: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(storage.savePhoto).toHaveBeenCalledWith(GRANDE, 'image/jpeg');
  });

  it('un mimetype no permitido lo corta el filtro de multer con un 400 en JSON', async () => {
    base();
    const res = await crearConFoto(AVISO, {
      buffer: Buffer.from('hola'),
      nombre: 'notas.txt',
      tipo: 'text/plain'
    });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Formato de imagen no permitido.' });
    expect(storage.savePhoto).not.toHaveBeenCalled();
    expect(creados).toHaveLength(0);
  });

  it.each([
    ['text/plain', 'notas.txt'],
    ['application/pdf', 'contrato.pdf'],
    ['image/gif', 'animado.gif'],
    ['image/svg+xml', 'logo.svg'],
    ['', 'sin-tipo']
  ])('el mimetype %s tampoco pasa el filtro', async (tipo, nombre) => {
    base();
    const res = await crearConFoto(AVISO, { buffer: JPEG, nombre, tipo });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Formato de imagen no permitido.' });
    expect(storage.savePhoto).not.toHaveBeenCalled();
    expect(creados).toHaveLength(0);
  });

  it('sin foto el aviso se guarda igual, con foto_url NULL', async () => {
    base();
    const res = await crear(AVISO);

    expect(res.status).toBe(201);
    expect(storage.savePhoto).not.toHaveBeenCalled();
    expect(creados[0][10]).toBeNull();
  });
});

/* ======================================================================== */
/* GET /api/reports/ · listado público                                      */
/* ======================================================================== */
function baseListado(filas) {
  db.query.mockImplementation(async (sql, params) => {
    if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
    if (sql.includes('WHERE active = TRUE')) return { rows: filas };
    void params;
    return { rows: [] };
  });
}

describe('GET /api/reports/ · listado público', () => {
  it('sin filtros pide los avisos activos y sin resolver con LIMIT 200', async () => {
    baseListado([]);
    const res = await peticion('get', '/api/reports', { sub: null });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ reports: [] });
    expect(limpiar(sqlDe('WHERE active = TRUE')[0])).toBe(
      'SELECT * FROM reports WHERE active = TRUE AND resolved = FALSE ORDER BY created_at DESC LIMIT 200'
    );
    expect(paramsDe('WHERE active = TRUE')).toStrictEqual([]);
  });

  it.each(TIPOS)('filtra por el tipo válido %s', async tipo => {
    baseListado([]);
    await peticion('get', `/api/reports?tipo=${tipo}`, { sub: null });

    expect(limpiar(sqlDe('WHERE active = TRUE')[0])).toContain('AND tipo = $1');
    expect(paramsDe('WHERE active = TRUE')).toStrictEqual([tipo]);
  });

  it.each(['dinosaurio', 'PERRO', 'perro,gato', ''])('ignora el tipo no válido "%s"', async tipo => {
    baseListado([]);
    await peticion('get', `/api/reports?tipo=${encodeURIComponent(tipo)}`, { sub: null });

    expect(limpiar(sqlDe('WHERE active = TRUE')[0])).not.toContain('AND tipo');
    expect(paramsDe('WHERE active = TRUE')).toStrictEqual([]);
  });

  it.each(['perdido', 'encontrado'])('filtra por el estado válido %s', async estado => {
    baseListado([]);
    await peticion('get', `/api/reports?estado=${estado}`, { sub: null });

    expect(limpiar(sqlDe('WHERE active = TRUE')[0])).toContain('AND estado = $1');
    expect(paramsDe('WHERE active = TRUE')).toStrictEqual([estado]);
  });

  it.each(['dormido', 'PERDIDO'])('ignora el estado no válido "%s"', async estado => {
    baseListado([]);
    await peticion('get', `/api/reports?estado=${estado}`, { sub: null });

    expect(limpiar(sqlDe('WHERE active = TRUE')[0])).not.toContain('AND estado');
    expect(paramsDe('WHERE active = TRUE')).toStrictEqual([]);
  });

  it('numera los parámetros cuando hay tipo y estado a la vez', async () => {
    baseListado([]);
    await peticion('get', '/api/reports?tipo=gato&estado=encontrado', { sub: null });

    const sql = limpiar(sqlDe('WHERE active = TRUE')[0]);
    expect(sql).toContain('AND tipo = $1');
    expect(sql).toContain('AND estado = $2');
    expect(paramsDe('WHERE active = TRUE')).toStrictEqual(['gato', 'encontrado']);
  });

  it('recorta, pasa a minúsculas y limita a 80 el texto de búsqueda', async () => {
    baseListado([]);
    await peticion('get', `/api/reports?q=${encodeURIComponent('  ' + 'A'.repeat(100) + '  ')}`, {
      sub: null
    });

    const sql = limpiar(sqlDe('LIKE')[0]);
    expect(paramsDe('LIKE')).toStrictEqual(['%' + 'a'.repeat(80) + '%']);
    expect(sql).toContain('lower(color) LIKE $1');
    expect(sql).toContain("lower(coalesce(raza,'')) LIKE $1");
    expect(sql).toContain("lower(coalesce(descripcion,'')) LIKE $1");
    expect(sql).toContain("lower(coalesce(nombre_mascota,'')) LIKE $1");
    expect(sql).toContain("lower(coalesce(collar,'')) LIKE $1");
  });

  it('busca con el texto en minúsculas junto a los filtros', async () => {
    baseListado([]);
    await peticion('get', '/api/reports?tipo=perro&q=Collar+Rojo', { sub: null });

    expect(paramsDe('LIKE')).toStrictEqual(['perro', '%collar rojo%']);
    expect(limpiar(sqlDe('LIKE')[0])).toContain('AND (lower(color) LIKE $2');
  });

  it.each([
    ['texto vacío', 'q='],
    ['texto de solo espacios', 'q=%20%20'],
    ['texto repetido como arreglo', 'q[]=x&q[]=y']
  ])('ignora el texto si es %s', async (nombre, consulta) => {
    baseListado([]);
    await peticion('get', `/api/reports?${consulta}`, { sub: null });

    expect(sqlDe('LIKE')).toBeUndefined();
    expect(paramsDe('WHERE active = TRUE')).toStrictEqual([]);
  });

  const FILA = {
    id: UUID,
    user_id: SUB,
    estado: 'perdido',
    tipo: 'gato',
    sexo: 'hembra',
    color: 'blanco',
    raza: 'siames',
    collar: 'rojo',
    descripcion: 'muy tímida',
    nombre_mascota: 'Luna',
    foto_url: '/uploads/luna.jpg',
    resolved: 0,
    radio_km: '0.30',
    perdido_hace_horas: '4',
    lat: -33.4,
    lng: -70.6,
    lat_public: -33.401,
    lng_public: -70.601,
    created_at: '1700000000000'
  };

  it('serializa el aviso con la ubicación pública y marca es_mio si hay sesión', async () => {
    baseListado([FILA]);
    const res = await peticion('get', '/api/reports');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      reports: [
        {
          id: UUID,
          estado: 'perdido',
          tipo: 'gato',
          sexo: 'hembra',
          color: 'blanco',
          raza: 'siames',
          collar: 'rojo',
          descripcion: 'muy tímida',
          nombre_mascota: 'Luna',
          foto_url: '/uploads/luna.jpg',
          resolved: false,
          es_mio: true,
          tiene_chip: false,
          chip_enmascarado: null,
          radio_km: 0.3,
          perdido_hace_horas: 4,
          lat: -33.401,
          lng: -70.601,
          created_at: 1700000000000
        }
      ]
    });
  });

  it('sin sesión es_mio es falso y un aviso de otro no se marca', async () => {
    baseListado([{ ...FILA, user_id: OTRO }]);
    const res = await peticion('get', '/api/reports', { sub: null });

    expect(res.body.reports[0].es_mio).toBe(false);
  });

  it('con sesión, el aviso de otra persona no se marca como mío', async () => {
    baseListado([{ ...FILA, user_id: OTRO }]);
    const res = await peticion('get', '/api/reports');

    expect(res.status).toBe(200);
    expect(res.body.reports[0].es_mio).toBe(false);
  });

  it('oculta el nombre de una mascota encontrada y pone a null lo que falta', async () => {
    baseListado([
      {
        id: UUID,
        user_id: OTRO,
        estado: 'encontrado',
        tipo: 'perro',
        color: 'negro',
        nombre_mascota: 'Rex',
        resolved: 1
      }
    ]);
    const res = await peticion('get', '/api/reports', { sub: null });

    expect(res.body.reports[0]).toStrictEqual({
      id: UUID,
      estado: 'encontrado',
      tipo: 'perro',
      color: 'negro',
      nombre_mascota: null,
      foto_url: null,
      resolved: true,
      es_mio: false,
      tiene_chip: false,
      chip_enmascarado: null,
      radio_km: null,
      perdido_hace_horas: null,
      created_at: null
    });
  });

  it('un radio_km o un perdido_hace_horas en NULL explícito no se convierten en 0', async () => {
    baseListado([{ ...FILA, radio_km: null, perdido_hace_horas: null }]);
    const res = await peticion('get', '/api/reports');

    expect(res.status).toBe(200);
    expect(res.body.reports[0].radio_km).toBeNull();
    expect(res.body.reports[0].perdido_hace_horas).toBeNull();
  });

  it('un radio_km o un perdido_hace_horas en 0 se publican como el número 0', async () => {
    baseListado([{ ...FILA, radio_km: 0, perdido_hace_horas: 0 }]);
    const res = await peticion('get', '/api/reports');

    expect(res.body.reports[0].radio_km).toBe(0);
    expect(res.body.reports[0].perdido_hace_horas).toBe(0);
  });

  it('sin foto y sin resolución publica null y false', async () => {
    baseListado([{ ...FILA, estado: 'encontrado', foto_url: '', resolved: undefined }]);
    const res = await peticion('get', '/api/reports', { sub: null });

    expect(res.body.reports[0].foto_url).toBeNull();
    expect(res.body.reports[0].resolved).toBe(false);
  });

  it('un fallo de la base responde 500', async () => {
    db.query.mockImplementation(async () => {
      throw new Error('caída del listado');
    });
    const res = await peticion('get', '/api/reports', { sub: null });

    expect(res.status).toBe(500);
  });
});

/* ======================================================================== */
/* GET /api/reports/mine/all                                                */
/* ======================================================================== */
describe('GET /api/reports/mine/all · mis avisos', () => {
  const FILA_MIA = {
    id: UUID,
    user_id: SUB,
    estado: 'perdido',
    tipo: 'perro',
    sexo: 'macho',
    color: 'negro',
    raza: 'quiltro',
    collar: null,
    descripcion: null,
    nombre_mascota: 'Firulais',
    foto_url: null,
    resolved: 0,
    radio_km: null,
    perdido_hace_horas: null,
    lat: -33.4,
    lng: -70.6,
    lat_public: -33.401,
    lng_public: -70.601,
    created_at: 1700000000000
  };

  it('sin sesión responde 401 y no consulta la base', async () => {
    base();
    const res = await peticion('get', '/api/reports/mine/all', { sub: null });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SIN_SESION);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('devuelve mis avisos con la ubicación exacta y los mensajes sin leer', async () => {
    db.query.mockImplementation(async (sql, params) => {
      if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('WHERE user_id = $1 ORDER BY created_at DESC')) return { rows: [FILA_MIA] };
      if (sql.includes('FROM messages WHERE recipient_user_id')) {
        return {
          rows: [
            { report_id: UUID, n: 3 },
            { report_id: 'ajeno', n: 9 }
          ]
        };
      }
      void params;
      return { rows: [] };
    });
    const res = await peticion('get', '/api/reports/mine/all');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      reports: [
        {
          id: UUID,
          estado: 'perdido',
          tipo: 'perro',
          sexo: 'macho',
          color: 'negro',
          raza: 'quiltro',
          collar: null,
          descripcion: null,
          nombre_mascota: 'Firulais',
          foto_url: null,
          resolved: false,
          es_mio: true,
          tiene_chip: false,
          chip_enmascarado: null,
          radio_km: null,
          perdido_hace_horas: null,
          lat: -33.401,
          lng: -70.601,
          created_at: 1700000000000,
          lat_exacto: -33.4,
          lng_exacto: -70.6,
          unread: 3
        }
      ]
    });

    const [sql, params] = sqlDe('WHERE user_id = $1 ORDER BY created_at DESC');
    expect(limpiar(sql)).toBe('SELECT * FROM reports WHERE user_id = $1 ORDER BY created_at DESC');
    expect(params).toStrictEqual([SUB]);
    const [sqlLeidos, paramsLeidos] = sqlDe('FROM messages WHERE recipient_user_id');
    expect(limpiar(sqlLeidos)).toBe(
      'SELECT report_id, COUNT(*)::int AS n FROM messages WHERE recipient_user_id = $1 AND read = FALSE GROUP BY report_id'
    );
    expect(paramsLeidos).toStrictEqual([SUB]);
  });

  it('un aviso sin mensajes sin leer queda con unread 0', async () => {
    db.query.mockImplementation(async sql => {
      if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('ORDER BY created_at DESC')) {
        return { rows: [FILA_MIA, { ...FILA_MIA, id: 'aviso-sin-mensajes' }] };
      }
      if (sql.includes('FROM messages')) return { rows: [{ report_id: UUID, n: 0 }] };
      return { rows: [] };
    });
    const res = await peticion('get', '/api/reports/mine/all');

    expect(res.body.reports.map(aviso => aviso.unread)).toStrictEqual([0, 0]);
    expect(res.body.reports[0].lat_exacto).toBe(-33.4);
  });

  it('con la lista vacía devuelve un arreglo vacío', async () => {
    base();
    const res = await peticion('get', '/api/reports/mine/all');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ reports: [] });
  });

  it('un fallo de la base responde 500', async () => {
    db.query.mockImplementation(async sql => {
      if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
      throw new Error('caída de mis avisos');
    });
    const res = await peticion('get', '/api/reports/mine/all');

    expect(res.status).toBe(500);
  });
});

/* ======================================================================== */
/* GET /api/reports/threads · todas mis conversaciones                      */
/* ======================================================================== */
const SQL_THREADS = `WITH m AS (
         SELECT report_id,
                CASE WHEN sender_user_id = $1 THEN recipient_user_id ELSE sender_user_id END AS peer,
                mensaje, created_at,
                CASE WHEN recipient_user_id = $1 AND read = FALSE THEN 1 ELSE 0 END AS unread
           FROM messages
          WHERE sender_user_id = $1 OR recipient_user_id = $1
       )
       SELECT report_id, peer,
              (array_agg(mensaje ORDER BY created_at DESC))[1] AS last_message,
              MAX(created_at) AS last_at,
              SUM(unread)::int AS unread
         FROM m
        GROUP BY report_id, peer
        ORDER BY MAX(created_at) DESC`;

const SQL_REPORTES_ANY = 'SELECT * FROM reports WHERE id = ANY($1)';

describe('GET /api/reports/threads · todas mis conversaciones', () => {
  function baseHilos(pares, reportes) {
    db.query.mockImplementation(async sql => {
      if (sql.includes('token_version FROM users')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('FROM messages')) return { rows: pares };
      if (sql.includes('ANY($1)')) return { rows: reportes };
      return { rows: [] };
    });
  }

  it('sin sesión responde 401 y no consulta la base', async () => {
    base();
    const res = await peticion('get', '/api/reports/threads', { sub: null });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SIN_SESION);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('sin conversaciones devuelve una lista vacía y no busca los avisos', async () => {
    baseHilos([], []);
    const res = await peticion('get', '/api/reports/threads');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ threads: [] });
    const [sql, params] = sqlDe('FROM messages');
    expect(limpiar(sql)).toBe(limpiar(SQL_THREADS));
    expect(params).toStrictEqual([SUB]);
    expect(db.query).not.toHaveBeenCalledWith(SQL_REPORTES_ANY, expect.anything());
  });

  it('mapea cada conversación con el aviso, la etiqueta del otro y lo no leído', async () => {
    baseHilos(
      [
        {
          report_id: UUID,
          peer: 'curioso-2',
          last_message: '¿Sigue perdido?',
          last_at: '1700000009000',
          unread: 2
        },
        {
          report_id: 'aviso-ajeno',
          peer: 987654321,
          last_message: 'Lo vi en la plaza',
          last_at: 1700000008000,
          unread: 0
        }
      ],
      [
        {
          id: UUID,
          user_id: SUB,
          estado: 'perdido',
          tipo: 'perro',
          color: 'negro',
          foto_url: '/uploads/x.jpg',
          resolved: 0
        },
        { id: 'aviso-ajeno', user_id: OTRO, estado: 'encontrado', tipo: 'gato', color: 'blanco', resolved: 1 }
      ]
    );
    const res = await peticion('get', '/api/reports/threads');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      threads: [
        {
          report_id: UUID,
          peer_id: 'curioso-2',
          peer_label: 'Usuario curios',
          es_mio: true,
          estado: 'perdido',
          tipo: 'perro',
          color: 'negro',
          foto_url: '/uploads/x.jpg',
          resolved: false,
          last_message: '¿Sigue perdido?',
          last_at: 1700000009000,
          unread: 2
        },
        {
          report_id: 'aviso-ajeno',
          peer_id: 987654321,
          peer_label: 'Usuario 987654',
          es_mio: false,
          estado: 'encontrado',
          tipo: 'gato',
          color: 'blanco',
          foto_url: null,
          resolved: true,
          last_message: 'Lo vi en la plaza',
          last_at: 1700000008000,
          unread: 0
        }
      ]
    });
    expect(db.query).toHaveBeenCalledWith(SQL_REPORTES_ANY, [[UUID, 'aviso-ajeno']]);
  });

  it('una foto ausente o vacía se publica como null', async () => {
    baseHilos(
      [
        { report_id: 'sin-foto', peer: 'p-1', last_message: 'hola', last_at: 1, unread: 0 },
        { report_id: 'foto-vacia', peer: 'p-2', last_message: 'hola', last_at: 2, unread: 0 }
      ],
      [
        { id: 'sin-foto', user_id: SUB, tipo: 'perro', color: 'negro', resolved: 0 },
        { id: 'foto-vacia', user_id: SUB, tipo: 'perro', color: 'negro', foto_url: '', resolved: 0 }
      ]
    );
    const res = await peticion('get', '/api/reports/threads');

    expect(res.body.threads.map(hilo => hilo.foto_url)).toStrictEqual([null, null]);
  });

  it('una conversación cuyo aviso ya no existe se descarta', async () => {
    baseHilos(
      [
        { report_id: UUID, peer: 'p-1', last_message: 'sigue ahí', last_at: 5, unread: 1 },
        { report_id: 'aviso-borrado', peer: 'p-2', last_message: 'hola', last_at: 4, unread: 0 }
      ],
      [{ id: UUID, user_id: SUB, estado: 'perdido', tipo: 'perro', color: 'negro', resolved: 0 }]
    );
    const res = await peticion('get', '/api/reports/threads');

    expect(res.status).toBe(200);
    expect(res.body.threads).toHaveLength(1);
    expect(res.body.threads[0].report_id).toBe(UUID);
  });

  it('respeta el orden que devuelve la base', async () => {
    baseHilos(
      [
        { report_id: 'nuevo', peer: 'p-1', last_message: 'último', last_at: 20, unread: 0 },
        { report_id: 'viejo', peer: 'p-2', last_message: 'primero', last_at: 10, unread: 0 }
      ],
      [
        { id: 'nuevo', user_id: SUB, tipo: 'ave', color: 'verde', resolved: 0 },
        { id: 'viejo', user_id: SUB, tipo: 'ave', color: 'verde', resolved: 0 }
      ]
    );
    const res = await peticion('get', '/api/reports/threads');

    expect(res.body.threads.map(hilo => hilo.report_id)).toStrictEqual(['nuevo', 'viejo']);
    expect(res.body.threads.map(hilo => hilo.last_at)).toStrictEqual([20, 10]);
  });

  it('si falla la consulta de mensajes responde 500', async () => {
    db.query.mockImplementation(async sql => {
      if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
      throw new Error('caída de las conversaciones');
    });
    const res = await peticion('get', '/api/reports/threads');

    expect(res.status).toBe(500);
  });

  it('si falla la consulta de los avisos responde 500', async () => {
    db.query.mockImplementation(async sql => {
      if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('FROM messages')) {
        return { rows: [{ report_id: UUID, peer: 'p-1', last_message: 'hola', last_at: 1, unread: 0 }] };
      }
      throw new Error('caída de los avisos');
    });
    const res = await peticion('get', '/api/reports/threads');

    expect(res.status).toBe(500);
  });
});

/* ======================================================================== */
/* GET /api/reports/busqueda                                                */
/* ======================================================================== */
describe('GET /api/reports/busqueda · radio sugerido', () => {
  it('sin parámetros sugiere un perro con 0 horas y la curva completa', async () => {
    const res = await peticion('get', '/api/reports/busqueda', { sub: null });

    expect(res.status).toBe(200);
    expect(res.body.tipo).toBe('perro');
    expect(res.body.horas).toBe(0);
    expect(res.body.sugerencia.km).toBe(0.4);
    expect(res.body.sugerencia.metros).toBe(400);
    expect(res.body.sugerencia.texto).toBe('Busca en un radio de unos 400 m a la redonda.');
    expect(res.body.curva).toHaveLength(25);
    expect(res.body.curva[0]).toStrictEqual({ horas: 0, km: 0.4 });
    expect(res.body.curva[24]).toStrictEqual({ horas: 72, km: 3.17 });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('devuelve una curva por cada tipo válido, en orden', async () => {
    const res = await peticion('get', '/api/reports/busqueda', { sub: null });

    expect(Object.keys(res.body.curvas)).toStrictEqual(TIPOS);
    expect(res.body.curvas.gato).toHaveLength(25);
    expect(res.body.curvas.gato[0]).toStrictEqual({ horas: 0, km: 0.05 });
  });

  it.each(TIPOS)('respeta el tipo %s pedido', async tipo => {
    const res = await peticion('get', `/api/reports/busqueda?tipo=${tipo}`, { sub: null });

    expect(res.body.tipo).toBe(tipo);
    expect(res.body.sugerencia.km).toBeGreaterThan(0);
  });

  it.each(['dinosaurio', 'PERRO', 'perro,gato'])('un tipo desconocido ("%s") cae en perro', async tipo => {
    const res = await peticion('get', `/api/reports/busqueda?tipo=${encodeURIComponent(tipo)}`, {
      sub: null
    });

    expect(res.body.tipo).toBe('perro');
  });

  it('un tipo repetido como arreglo también cae en perro', async () => {
    const res = await peticion('get', '/api/reports/busqueda?tipo[]=gato&tipo[]=ave', { sub: null });

    expect(res.body.tipo).toBe('perro');
  });

  it.each([
    ['-5', 0],
    ['0', 0],
    ['1', 1],
    ['7.9', 7],
    ['8760', 8760],
    ['999999', 8760]
  ])('normaliza las horas "%s" a %i', async (horas, esperado) => {
    const res = await peticion('get', `/api/reports/busqueda?horas=${horas}`, { sub: null });

    expect(res.body.horas).toBe(esperado);
  });

  it.each(['abc', '', 'muchas'])('unas horas no numéricas ("%s") quedan en 0', async horas => {
    const res = await peticion('get', `/api/reports/busqueda?horas=${horas}`, { sub: null });

    expect(res.body.horas).toBe(0);
  });
});

/* ======================================================================== */
/* GET /api/reports/reunions                                                */
/* ======================================================================== */
const SQL_REUNIONS =
  'SELECT id, tipo, color, raza, estado, nombre_mascota, foto_url, reunion_foto_url, reunion_nota, resolved_at FROM reports WHERE resolved = TRUE AND active = TRUE ORDER BY resolved_at DESC NULLS LAST LIMIT 60';
const SQL_TOTAL_REUNIONS = 'SELECT COUNT(*)::int AS n FROM reports WHERE resolved = TRUE AND active = TRUE';

describe('GET /api/reports/reunions · muro de reencuentros', () => {
  function baseReunions(filas, total = 0) {
    db.query.mockImplementation(async sql => {
      if (sql.includes('reunion_foto_url')) return { rows: filas };
      if (sql.includes('COUNT(*)')) return { rows: [{ n: total }] };
      return { rows: [] };
    });
  }

  it('devuelve el total y cada reencuentro con su foto y su nota', async () => {
    baseReunions(
      [
        {
          id: UUID,
          tipo: 'perro',
          color: 'negro',
          raza: 'quiltro',
          estado: 'perdido',
          nombre_mascota: 'Rex',
          foto_url: '/uploads/rex.jpg',
          reunion_foto_url: '/uploads/reunion.jpg',
          reunion_nota: 'Volvió solo a la casa',
          resolved_at: '1700000000000'
        }
      ],
      7
    );
    const res = await peticion('get', '/api/reports/reunions', { sub: null });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      total: 7,
      reunions: [
        {
          id: UUID,
          tipo: 'perro',
          color: 'negro',
          raza: 'quiltro',
          estado: 'perdido',
          nombre_mascota: 'Rex',
          foto_url: '/uploads/reunion.jpg',
          nota: 'Volvió solo a la casa',
          resolved_at: 1700000000000
        }
      ]
    });
    expect(limpiar(sqlDe('reunion_foto_url')[0])).toBe(SQL_REUNIONS);
    expect(paramsDe('reunion_foto_url')).toBeUndefined();
    expect(limpiar(sqlDe('COUNT(*)')[0])).toBe(SQL_TOTAL_REUNIONS);
  });

  it('sin foto de reencuentro usa la del aviso y deja la nota y la fecha en null', async () => {
    baseReunions(
      [
        { id: UUID, tipo: 'gato', color: 'blanco', foto_url: '/uploads/gato.jpg' },
        { id: 'sin-fotos', tipo: 'ave', color: 'verde', reunion_foto_url: null }
      ],
      2
    );
    const res = await peticion('get', '/api/reports/reunions', { sub: null });

    expect(res.body.reunions[0]).toStrictEqual({
      id: UUID,
      tipo: 'gato',
      color: 'blanco',
      foto_url: '/uploads/gato.jpg',
      nota: null,
      resolved_at: null
    });
    expect(res.body.reunions[1]).toStrictEqual({
      id: 'sin-fotos',
      tipo: 'ave',
      color: 'verde',
      foto_url: null,
      nota: null,
      resolved_at: null
    });
  });

  it('con el muro vacío devuelve total 0 y una lista vacía', async () => {
    baseReunions([], 0);
    const res = await peticion('get', '/api/reports/reunions', { sub: null });

    expect(res.body).toStrictEqual({ total: 0, reunions: [] });
  });

  it('si falla la cuenta responde 500', async () => {
    db.query.mockImplementation(async sql => {
      if (sql.includes('COUNT(*)')) throw new Error('caída al contar reencuentros');
      return { rows: [] };
    });
    const res = await peticion('get', '/api/reports/reunions', { sub: null });

    expect(res.status).toBe(500);
  });

  it('si falla el listado responde 500', async () => {
    db.query.mockImplementation(async () => {
      throw new Error('caída del muro');
    });
    const res = await peticion('get', '/api/reports/reunions', { sub: null });

    expect(res.status).toBe(500);
  });
});

/* ======================================================================== */
/* GET /api/reports/:id/poster · escapado de HTML (escHtml)                  */
/* ======================================================================== */
// escHtml (líneas 420-428) no se exporta: la única forma de ejercitarlo es el
// cartel imprimible, que lo usa con todos los campos del aviso.
describe('GET /api/reports/:id/poster · escapado de HTML', () => {
  function basePoster(fila) {
    db.query.mockImplementation(async sql => {
      if (sql.includes('SELECT * FROM reports WHERE id = $1')) return { rows: fila ? [fila] : [] };
      return { rows: [] };
    });
  }

  // El QR es una imagen base64 enorme: fuera del HTML antes de comparar.
  function sinQr(texto) {
    return String(texto).replace(/data:image\/png;base64,[^"]+/, '');
  }

  it('un campo nulo o ausente no se imprime como "null" ni "undefined"', async () => {
    basePoster({ id: UUID, user_id: SUB, estado: 'perdido', tipo: null, color: undefined, active: true });
    const res = await peticion('get', `/api/reports/${UUID}/poster`, { sub: null });

    expect(res.status).toBe(200);
    expect(res.type).toBe('text/html');
    const html = sinQr(res.text);
    expect(html).toContain('<b>Tipo</b><span></span>');
    expect(html).toContain('<b>Color</b><span></span>');
    expect(html).not.toContain('null');
    expect(html).not.toContain('undefined');
  });

  it('un 0 o un false sí se imprimen: no son null', async () => {
    basePoster({ id: UUID, user_id: SUB, estado: 'perdido', tipo: 0, color: false, active: true });
    const res = await peticion('get', `/api/reports/${UUID}/poster`, { sub: null });

    const html = sinQr(res.text);
    expect(html).toContain('<b>Tipo</b><span>0</span>');
    expect(html).toContain('<b>Color</b><span>false</span>');
  });

  it('una cadena vacía no deja rastro en el cartel', async () => {
    basePoster({
      id: UUID,
      user_id: SUB,
      estado: 'encontrado',
      tipo: 'gato',
      color: 'blanco',
      raza: '',
      collar: '',
      descripcion: '',
      nombre_mascota: '',
      foto_url: null,
      active: true
    });
    const res = await peticion('get', `/api/reports/${UUID}/poster`, { sub: null });

    const html = sinQr(res.text);
    expect(html).toContain('<b>Color</b><span>blanco</span>');
    expect(html).not.toContain('<b>Raza</b>');
    expect(html).not.toContain('<b>Collar</b>');
    expect(html).not.toContain('<b>Descripción</b>');
    expect(html).not.toContain('<b>Nombre</b>');
  });

  it('una foto con URL absoluta se usa tal cual y el sexo desconocido no se imprime', async () => {
    basePoster({
      id: UUID,
      user_id: SUB,
      estado: 'perdido',
      tipo: 'perro',
      color: 'negro',
      sexo: 'desconocido',
      foto_url: 'https://cdn.test/perro.jpg',
      active: true
    });
    const res = await peticion('get', `/api/reports/${UUID}/poster`, { sub: null });

    const html = sinQr(res.text);
    expect(html).toContain('src="https://cdn.test/perro.jpg"');
    expect(html).not.toContain('<b>Sexo</b>');
  });

  it('una foto relativa se pega a la URL de la app', async () => {
    basePoster({
      id: UUID,
      user_id: SUB,
      estado: 'perdido',
      tipo: 'perro',
      color: 'negro',
      sexo: 'hembra',
      foto_url: '/uploads/perro.jpg',
      active: true
    });
    const res = await peticion('get', `/api/reports/${UUID}/poster`, { sub: null });

    const html = sinQr(res.text);
    expect(html).toContain('src="http://127.0.0.1');
    expect(html).toContain('/uploads/perro.jpg"');
    expect(html).toContain('<b>Sexo</b><span>hembra</span>');
  });

  it('un fallo de la base responde 500', async () => {
    db.query.mockImplementation(async () => {
      throw new Error('caída del cartel');
    });
    const res = await peticion('get', `/api/reports/${UUID}/poster`, { sub: null });

    expect(res.status).toBe(500);
  });

  it('escapa los caracteres peligrosos de todos los campos', async () => {
    basePoster({
      id: UUID,
      user_id: SUB,
      estado: 'perdido',
      tipo: 'perro',
      color: 'negro',
      raza: '<script>alert(1)</script>',
      collar: '"comillas"',
      descripcion: "& o '",
      nombre_mascota: '<b>Luna</b> & "Firulais"',
      foto_url: '/uploads/foto.jpg',
      active: true
    });
    const res = await peticion('get', `/api/reports/${UUID}/poster`, { sub: null });

    const html = sinQr(res.text);
    expect(html).toContain('&lt;b&gt;Luna&lt;/b&gt; &amp; &quot;Firulais&quot;');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&quot;comillas&quot;');
    expect(html).toContain('&amp; o &#39;');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('<b>Luna</b>');
  });

  it('un identificador que no es UUID responde 400 sin consultar la base', async () => {
    basePoster(null);
    const res = await peticion('get', '/api/reports/no-soy-un-uuid/poster', { sub: null });

    expect(res.status).toBe(400);
    expect(res.text).toBe('Identificador inválido.');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un aviso que no existe responde 404', async () => {
    basePoster(null);
    const res = await peticion('get', `/api/reports/${UUID}/poster`, { sub: null });

    expect(res.status).toBe(404);
    expect(res.text).toBe('Aviso no encontrado.');
  });

  it('un aviso desactivado de otra persona responde 404', async () => {
    basePoster({ id: UUID, user_id: OTRO, estado: 'perdido', tipo: 'perro', color: 'negro', active: false });
    const res = await peticion('get', `/api/reports/${UUID}/poster`, { sub: null });

    expect(res.status).toBe(404);
    expect(res.text).toBe('Aviso no encontrado.');
  });
});

/* ======================================================================== */
/* Limitadores (líneas 17-60)                                               */
/* ======================================================================== */
describe('limitadores de avisos', () => {
  it('la petición 16 desde la misma IP recibe 429 con el mensaje del cupo horario', async () => {
    base();
    const fija = '203.0.113.7';
    const codigos = [];
    for (let i = 0; i < 16; i++) {
      const res = await peticion('post', '/api/reports', { ip: fija }).send({});
      codigos.push(res.status);
      if (i === 15) expect(res.body).toStrictEqual(CUPO_HORARIO);
    }

    expect(codigos.slice(0, 15)).toStrictEqual(new Array(15).fill(400));
    expect(codigos[15]).toBe(429);
  });

  it('manda las cabeceras estándar del límite y ninguna de las antiguas', async () => {
    base();
    const res = await peticion('post', '/api/reports', { ip: '203.0.113.8' }).send({});

    expect(res.headers['ratelimit-limit']).toBe('15');
    expect(res.headers['ratelimit-remaining']).toBe('14');
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
  });

  it('el cupo horario por IP es independiente de la cuenta', async () => {
    base();
    const res = await crear(AVISO, { sub: OTRO, ip: '203.0.113.9' });

    expect(res.status).toBe(201);
  });
});
