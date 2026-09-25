// Pruebas del tope de píxeles de las fotos en backend/routes/reports.js.
//
// QUÉ SE PROTEGE AQUÍ: que una imagen cuya cabecera declara más píxeles de los
// que el servidor puede decodificar se rechace ANTES de decodificarla. Es una
// bomba de descompresión: el archivo pesa poco (pasa el filtro de 5 MB de
// multer) pero al decodificarlo pide width*height*4 bytes. Medido en la
// revisión: 60,8 KB -> 124,3 MB, y a 20000x20000 ~1,5 GB. Como el OOM del
// proceso NO es una excepción que se pueda atrapar, el servidor se caía entero
// con una sola petición autenticada.
//
// INFRAESTRUCTURA: no se toca ni una línea de producción. El router se importa
// de forma ESTÁTICA (así `vitest related` lo relaciona con estas pruebas y
// Stryker ejecuta el archivo para cada mutante) y sus dependencias (db, storage,
// push) se sustituyen con los dobles de ./helpers/aislar.js, que va PRIMERO.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import zlib from 'node:zlib';
import { db, storage, crearApp, pedir, tokenPara } from './helpers/aislar.js';
import reportsRouter from '../routes/reports.js';

const app = crearApp({ '/api/reports': reportsRouter });

// Copia literal del manejador de errores de server.js: es el que traduce los
// errores de multer a JSON. Sin él se mediría una app que no existe en
// producción.
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
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const AHORA = 1700000000000;

const SQL_TOKEN = 'SELECT token_version FROM users WHERE id = $1';
const SQL_VERIFICADO = 'SELECT email_verified FROM users WHERE id = $1';
const SQL_AVISO = 'SELECT * FROM reports WHERE id = $1';
const SQL_AVISOS_24H = 'SELECT COUNT(*)::int AS n FROM reports WHERE user_id = $1 AND created_at > $2';
const SQL_INSERT = 'INSERT INTO reports (';
const SQL_REUNION =
  'UPDATE reports SET resolved = TRUE, resolved_at = $1, reunion_foto_url = $2, reunion_nota = $3 WHERE id = $4';

const AVISO = {
  estado: 'perdido',
  tipo: 'perro',
  sexo: 'macho',
  color: 'negro',
  lat: '-33.45',
  lng: '-70.66'
};

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
    foto_url: null,
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

/* --------------------------- imágenes de prueba --------------------------- */

// PNG real y válido con las dimensiones que se le pidan. Se usa escala de grises
// (1 byte por píxel en vez de 4) solo para que el búfer de la prueba no sea
// enorme; el coste que se evita al decodificar es el mismo, porque los
// decodificadores expanden siempre a RGBA.
function pngDe(width, height) {
  const trozo = (tipo, datos) => {
    const largo = Buffer.alloc(4);
    largo.writeUInt32BE(datos.length);
    const cuerpo = Buffer.concat([Buffer.from(tipo, 'ascii'), datos]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(cuerpo) >>> 0);
    return Buffer.concat([largo, cuerpo, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bits por muestra
  ihdr[9] = 0; // escala de grises
  const crudo = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr),
    trozo('IDAT', zlib.deflateSync(crudo, { level: 9 })),
    trozo('IEND', Buffer.alloc(0))
  ]);
}

// 6000x4000 = 24 Mpx: por encima del tope de 20. Pesa muchísimo menos que 5 MB,
// así que pasa el filtro de tamaño de multer sin problemas.
const BOMBA = pngDe(6000, 4000);
// 8x8: una foto pequeña y legítima, como las que sube el cliente (reduce a 800 px).
const NORMAL = pngDe(8, 8);

const FOTO_BOMBA = { buffer: BOMBA, nombre: 'bomba.png', tipo: 'image/png' };
const FOTO_NORMAL = { buffer: NORMAL, nombre: 'normal.png', tipo: 'image/png' };

function firmaParcial(bytes, tipo = 'image/png') {
  const buffer = Buffer.alloc(12);
  Buffer.from(bytes).copy(buffer);
  return { buffer, nombre: 'firma-invalida.png', tipo };
}

const FIRMAS_INVALIDAS = [
  ['JPEG con primer byte incorrecto', firmaParcial([0x00, 0xd8, 0xff])],
  ['JPEG con segundo byte incorrecto', firmaParcial([0xff, 0x00, 0xff])],
  ['JPEG con tercer byte incorrecto', firmaParcial([0xff, 0xd8, 0x00])],
  ['PNG con primer byte incorrecto', firmaParcial([0x00, 0x50, 0x4e, 0x47])],
  ['PNG con segundo byte incorrecto', firmaParcial([0x89, 0x00, 0x4e, 0x47])],
  ['PNG con tercer byte incorrecto', firmaParcial([0x89, 0x50, 0x00, 0x47])],
  ['PNG con cuarto byte incorrecto', firmaParcial([0x89, 0x50, 0x4e, 0x00])],
  ['WebP con firma RIFF incorrecta', firmaParcial([0x52, 0x49, 0x46, 0x58], 'image/webp')],
  [
    'WebP con marca WEBP incorrecta',
    firmaParcial([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x45, 0x50], 'image/webp')
  ]
];

/* ------------------------------- utilidades ------------------------------- */

let visitas = 0;
function ipNueva() {
  visitas += 1;
  return `10.${Math.floor(visitas / 250)}.${visitas % 250}.9`;
}

function conToken(peticion, sub = SUB, ip = ipNueva()) {
  return peticion.set('Authorization', `Bearer ${tokenPara(sub, 0)}`).set('x-forwarded-for', ip);
}

function crearConFoto(campos = AVISO, foto = FOTO_NORMAL) {
  let p = conToken(pedir(app).post('/api/reports'));
  for (const [clave, valor] of Object.entries(campos)) p = p.field(clave, valor);
  return p.attach('foto', foto.buffer, { filename: foto.nombre, contentType: foto.tipo });
}

function reunionConFoto(foto = FOTO_NORMAL, id = UUID) {
  return conToken(pedir(app).post(`/api/reports/${id}/reunion`)).attach('foto', foto.buffer, {
    filename: foto.nombre,
    contentType: foto.tipo
  });
}

function montarBase({ verificada = true, fila = aviso() } = {}) {
  db.query.mockImplementation(async sql => {
    if (sql === SQL_TOKEN) return { rows: [{ token_version: 0 }] };
    if (sql === SQL_VERIFICADO) return { rows: [{ email_verified: verificada }] };
    if (sql === SQL_AVISOS_24H) return { rows: [{ n: 0 }] };
    if (sql === SQL_AVISO) return { rows: [fila] };
    return { rows: [] };
  });
}

function seInsertoUnAviso() {
  return db.query.mock.calls.some(call => String(call[0]).startsWith(SQL_INSERT));
}

function seActualizoElReunion() {
  return db.query.mock.calls.some(call => String(call[0]) === SQL_REUNION);
}

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  storage.savePhoto.mockReset();
  storage.savePhoto.mockResolvedValue('/uploads/foto-de-prueba.jpg');
  vi.spyOn(Date, 'now').mockReturnValue(AHORA);
});

/* -------------------------------------------------------------------------- */

describe('POST /api/reports — la bomba de descompresión no llega al decodificador', () => {
  it('la imagen de prueba es una bomba de verdad: cabe en 5 MB y declara 24 Mpx', () => {
    // Si esto dejara de cumplirse, la prueba siguiente no probaría nada.
    expect(BOMBA.length).toBeLessThan(5 * 1024 * 1024);
    expect(BOMBA.readUInt32BE(16)).toBe(6000);
    expect(BOMBA.readUInt32BE(20)).toBe(4000);
  });

  it('responde 413 y NO guarda la foto ni crea el aviso', async () => {
    montarBase();

    const res = await crearConFoto(AVISO, FOTO_BOMBA);

    expect(res.status).toBe(413);
    expect(res.body).toStrictEqual({
      error: 'La imagen tiene una resolución demasiado alta (máximo 20 megapíxeles).'
    });
    // Lo importante: se corta ANTES de tocar el almacenamiento y la base.
    expect(storage.savePhoto).not.toHaveBeenCalled();
    expect(seInsertoUnAviso()).toBe(false);
  });

  it('una foto normal sí pasa el tope y se guarda', async () => {
    montarBase();

    const res = await crearConFoto(AVISO, FOTO_NORMAL);

    expect(res.status).not.toBe(413);
    // savePhoto se llama justo después del tope: si se llamó, el tope no la frenó.
    expect(storage.savePhoto).toHaveBeenCalled();
  });

  it.each(FIRMAS_INVALIDAS)('rechaza %s aunque el mimetype esté permitido', async (_caso, foto) => {
    montarBase();

    const res = await crearConFoto(AVISO, foto);

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'El archivo no es una imagen válida.' });
    expect(storage.savePhoto).not.toHaveBeenCalled();
    expect(seInsertoUnAviso()).toBe(false);
  });
});

describe('POST /api/reports/:id/reunion — el mismo tope en la foto del reencuentro', () => {
  it('responde 413 y no guarda ni actualiza nada', async () => {
    montarBase();

    const res = await reunionConFoto(FOTO_BOMBA);

    expect(res.status).toBe(413);
    expect(res.body).toStrictEqual({
      error: 'La imagen tiene una resolución demasiado alta (máximo 20 megapíxeles).'
    });
    expect(storage.savePhoto).not.toHaveBeenCalled();
    expect(seActualizoElReunion()).toBe(false);
  });

  it('una foto normal pasa el tope', async () => {
    montarBase();

    const res = await reunionConFoto(FOTO_NORMAL);

    expect(res.status).not.toBe(413);
    expect(storage.savePhoto).toHaveBeenCalled();
  });
});

describe('límites del multipart — el cuerpo no puede crecer sin tope', () => {
  it('un multipart con demasiados campos se rechaza en vez de acumularse en memoria', async () => {
    montarBase();

    let p = conToken(pedir(app).post('/api/reports'));
    for (let i = 0; i < 40; i++) p = p.field(`relleno-${i}`, 'x'.repeat(100));
    const res = await p.attach('foto', NORMAL, { filename: 'normal.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'No se pudo procesar la imagen subida.' });
    expect(storage.savePhoto).not.toHaveBeenCalled();
  });
});
