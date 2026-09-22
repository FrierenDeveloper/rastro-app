// Pruebas del MICROCHIP en backend/routes/reports.js.
//
// Lo que se protege aquí no es solo que el chip dé coincidencia inmediata, sino
// que el número NUNCA salga de donde no debe: no va en el listado, ni en el aviso
// público, ni en el push, ni a una cuenta que no sea su dueña. Solo hay una
// puerta (GET /:id/chip) y está cerrada con sesión, propiedad y cupo propio.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { db, push, crearApp, pedir, tokenPara } from './helpers/aislar.js';
import reportsRouter from '../routes/reports.js';

// Se carga con require, igual que la ruta de producción (ver v2-chip.test.js).
const require = createRequire(import.meta.url);
const chip = require('../src/v2/chip.js');

const app = crearApp({ '/api/reports': reportsRouter });

const SUB = 'duena-1';
const OTRO = 'curioso-2';
const AJENO = 'ajeno-3';
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID_MAYUS = UUID.toUpperCase();
const UUID_INVALIDO = 'no-es-un-uuid';

// El chip que se declara en casi todas las pruebas y cómo se llama en cada lado.
const CHIP = '981020304050607';
const CHIP_MASCARA = '••••••••••• 0607';
const CHIP_CORTO = '123456789';
const SECRETO_CHIP = 'chip-secreto-de-pruebas';
const SECRETO_INICIAL = process.env.CHIP_SECRET;

const MICROCHIP_INVALIDO = { error: 'El microchip debe tener entre 9 y 15 dígitos.' };
const VALOR_INVALIDO = { error: 'Invalid value' };
const NO_AUTENTICADO = { error: 'No autenticado.' };
const NO_ENCONTRADO = { error: 'Aviso no encontrado.' };
const AJENO_ERROR = { error: 'Este aviso no es tuyo.' };
const ID_INVALIDO = { error: 'Identificador inválido.' };

const AVISO = {
  estado: 'perdido',
  tipo: 'perro',
  sexo: 'macho',
  color: 'negro',
  lat: '-33.45',
  lng: '-70.66'
};

const COLUMNAS_INSERT = [
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

let creados = [];
let avisoGuardado = null;
let candidatos = [];
let extra = null;

function filaDeParams(params) {
  const fila = { active: true, resolved: false };
  COLUMNAS_INSERT.forEach((columna, i) => {
    fila[columna] = params[i];
  });
  return fila;
}

function avisoFila(cambios = {}) {
  return {
    id: UUID,
    user_id: SUB,
    estado: 'perdido',
    tipo: 'perro',
    sexo: 'macho',
    color: 'negro',
    raza: null,
    collar: null,
    descripcion: null,
    nombre_mascota: null,
    foto_url: null,
    foto_hash: null,
    chip_hash: null,
    chip_cifrado: null,
    lat: -33.45,
    lng: -70.66,
    lat_public: -33.45,
    lng_public: -70.66,
    active: true,
    resolved: false,
    radio_km: null,
    perdido_hace_horas: null,
    created_at: 1700000000000,
    ...cambios
  };
}

function candidato(cambios = {}) {
  return {
    id: 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f',
    user_id: OTRO,
    estado: 'encontrado',
    tipo: 'perro',
    sexo: 'macho',
    color: 'negro',
    raza: null,
    collar: null,
    chip_hash: null,
    chip_cifrado: null,
    lat: -33.45,
    lng: -70.66,
    active: true,
    resolved: false,
    created_at: 1700000000000,
    ...cambios
  };
}

function base(opciones = {}) {
  const { verificado = true, avisos = 0, fila = avisoFila(), filaDespues = null } = opciones;
  avisoGuardado = fila;
  let lecturas = 0;

  function leerAviso() {
    lecturas += 1;
    if (!avisoGuardado) return { rows: [] };
    // El PATCH lee el aviso antes de actualizarlo y otra vez después.
    if (filaDespues && lecturas > 1) return { rows: [filaDespues] };
    return { rows: [avisoGuardado] };
  }

  const reglas = [
    [sql => sql.includes('token_version FROM users'), () => ({ rows: [{ token_version: 0 }] })],
    [sql => sql.includes('email_verified FROM users'), () => ({ rows: [{ email_verified: verificado }] })],
    [sql => sql.includes('created_at > $2'), () => ({ rows: [{ n: avisos }] })],
    [
      sql => sql.startsWith('INSERT INTO reports'),
      params => {
        creados.push(params);
        avisoGuardado = filaDeParams(params);
        return { rows: [] };
      }
    ],
    [sql => sql === 'SELECT * FROM reports WHERE id = $1', () => leerAviso()],
    [sql => sql.includes('LIMIT 100'), () => ({ rows: candidatos })]
  ];

  db.query.mockImplementation(async (sql, params) => {
    for (const [aplica, responder] of reglas) {
      if (aplica(sql)) return responder(params);
    }
    return extra ? extra(sql, params) : { rows: [] };
  });
}

let visitas = 0;
function ipNueva() {
  visitas += 1;
  return `10.${Math.floor(visitas / 250)}.${visitas % 250}.9`;
}

function peticion(metodo, ruta, opciones = {}) {
  const { sub = SUB, ver = 0 } = opciones;
  const p = pedir(app)[metodo](ruta).set('x-forwarded-for', ipNueva());
  return sub === null ? p : p.set('Authorization', `Bearer ${tokenPara(sub, ver)}`);
}

function crear(cuerpo, opciones) {
  return peticion('post', '/api/reports', opciones).send(cuerpo);
}

function editar(id, cuerpo, opciones) {
  return peticion('patch', `/api/reports/${id}`, opciones).send(cuerpo);
}

function verChip(id, opciones) {
  return peticion('get', `/api/reports/${id}/chip`, opciones);
}

function buscarMatches(id, opciones) {
  return peticion('get', `/api/reports/${id}/matches`, opciones);
}

function reposar() {
  return new Promise(resolve => setImmediate(resolve)).then(
    () => new Promise(resolve => setImmediate(resolve))
  );
}

// Posiciones del UPDATE del PATCH (0-based): tipo...lng_public, chip e id.
const POS_CHIP_HASH = 11;
const POS_CHIP_CIFRADO = 12;
const POS_ID = 13;

beforeEach(() => {
  db.query.mockReset();
  push.sendToUser.mockReset();
  push.sendToUser.mockResolvedValue(undefined);
  creados = [];
  candidatos = [];
  extra = null;
  process.env.CHIP_SECRET = SECRETO_CHIP;
});

afterEach(() => {
  if (SECRETO_INICIAL === undefined) delete process.env.CHIP_SECRET;
  else process.env.CHIP_SECRET = SECRETO_INICIAL;
});

/* ======================================================================== */
/* POST /api/reports/ · declarar el microchip                               */
/* ======================================================================== */
describe('POST /api/reports/ · microchip', () => {
  it('guarda huella y cifrado, nunca el número, y devuelve la existencia con la máscara', async () => {
    base();

    const res = await crear({ ...AVISO, codigo_chip: CHIP });

    expect(res.status).toBe(201);
    const params = creados[0];
    expect(params[19]).toBe(chip.huella(CHIP, SECRETO_CHIP));
    expect(params[19]).toMatch(/^[0-9a-f]{64}$/);
    expect(params[19]).not.toContain(CHIP);
    expect(params[20]).toMatch(/^v1\./);
    // El número no aparece por ninguna parte de la respuesta.
    expect(JSON.stringify(res.body)).not.toContain(CHIP);
    expect(res.body.report.tiene_chip).toBe(true);
    expect(res.body.report.chip_enmascarado).toBe(CHIP_MASCARA);
  });

  it('acepta el chip escrito con separadores y lo normaliza antes de guardarlo', async () => {
    base();

    const res = await crear({ ...AVISO, codigo_chip: '981 020-304.050_607' });

    expect(res.status).toBe(201);
    expect(creados[0][19]).toBe(chip.huella(CHIP, SECRETO_CHIP));
  });

  it('acepta un chip corto y lo rellena con ceros', async () => {
    base();

    const res = await crear({ ...AVISO, codigo_chip: CHIP_CORTO });

    expect(res.status).toBe(201);
    expect(creados[0][19]).toBe(chip.huella('000000123456789', SECRETO_CHIP));
  });

  it('sin chip declarado guarda NULL en las dos columnas y no lo anuncia', async () => {
    base();

    const res = await crear(AVISO);

    expect(res.status).toBe(201);
    expect(creados[0][19]).toBeNull();
    expect(creados[0][20]).toBeNull();
    expect(res.body.report.tiene_chip).toBe(false);
    expect(res.body.report.chip_enmascarado).toBeNull();
  });

  it('la cadena vacía equivale a no declarar chip', async () => {
    base();

    const res = await crear({ ...AVISO, codigo_chip: '   ' });

    expect(res.status).toBe(201);
    expect(creados[0][19]).toBeNull();
    expect(creados[0][20]).toBeNull();
  });

  it.each([
    ['letras', '98102030405060A'],
    ['ocho digitos', '12345678'],
    ['dieciseis digitos', '1234567890123456'],
    ['simbolos', '+981020304050607'],
    ['solo un prefijo ISO', 'ISO']
  ])('rechaza un microchip con %s y no inserta', async (_caso, valor) => {
    base();

    const res = await crear({ ...AVISO, codigo_chip: valor });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MICROCHIP_INVALIDO);
    expect(creados).toHaveLength(0);
  });

  it('un chip que no es texto se rechaza en el validador', async () => {
    base();

    const res = await crear({ ...AVISO, codigo_chip: 981020304050607 });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(VALOR_INVALIDO);
    expect(creados).toHaveLength(0);
  });

  it('un texto imposible de chip se rechaza por longitud sin llegar a la ruta', async () => {
    base();

    const res = await crear({ ...AVISO, codigo_chip: 'x'.repeat(33) });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'El microchip no es válido.' });
    expect(creados).toHaveLength(0);
  });

  it('un cuerpo sin chip no necesita sesión verificada de más: sigue creando el aviso', async () => {
    base();

    const res = await crear({ ...AVISO, codigo_chip: CHIP }, { sub: null });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(creados).toHaveLength(0);
  });
});

/* ======================================================================== */
/* POST /api/reports/ · el chip da coincidencia inmediata                   */
/* ======================================================================== */
describe('POST /api/reports/ · coincidencia por microchip', () => {
  it('avisa a las dos partes cuando el chip coincide, aunque el aviso esté a 500 km y sea de otra especie', async () => {
    base();
    // Mismo chip declarado en un aviso de OTRA cuenta, a ~500 km y como "gato".
    candidatos = [
      candidato({
        chip_hash: chip.huella(CHIP, SECRETO_CHIP),
        tipo: 'gato',
        color: 'atigrado',
        sexo: 'hembra',
        lat: -28.0
      })
    ];

    const res = await crear({ ...AVISO, codigo_chip: CHIP });
    await reposar();

    expect(res.status).toBe(201);
    const id = creados[0][0];
    const payload = {
      title: '✅ El microchip coincide',
      body: 'Publicaron un aviso de perro que declara el mismo microchip que el tuyo. Toca para verlo.',
      report_id: id,
      tag: 'chip-' + id
    };
    expect(push.sendToUser.mock.calls.map(call => call[0])).toStrictEqual([OTRO, SUB]);
    expect(push.sendToUser).toHaveBeenCalledWith(OTRO, payload);
    expect(push.sendToUser).toHaveBeenCalledWith(SUB, payload);
    // El número del chip no viaja en el push.
    expect(JSON.stringify(push.sendToUser.mock.calls)).not.toContain(CHIP);
  });

  it('un chip de Otra cuenta distinto no avisa a nadie', async () => {
    base();
    candidatos = [candidato({ chip_hash: chip.huella('981020304050699', SECRETO_CHIP), lat: -28.0 })];

    const res = await crear({ ...AVISO, codigo_chip: CHIP });
    await reposar();

    expect(res.status).toBe(201);
    // Lejos y sin nada en común: ni por chip ni por la regla normal.
    expect(push.sendToUser).not.toHaveBeenCalled();
  });

  it('un aviso sin chip no coincide con un candidato que sí lo declara', async () => {
    base();
    candidatos = [candidato({ chip_hash: chip.huella(CHIP, SECRETO_CHIP) })];

    const res = await crear(AVISO);
    await reposar();

    expect(res.status).toBe(201);
    // Sin chip declarado no hay regla dura: manda la comparación normal, y el
    // candidato tiene que ser compatible en color/sexo/raza/collar y distancia.
    expect(push.sendToUser).not.toHaveBeenCalled();
  });

  it('el aviso se crea igual si el push por chip falla', async () => {
    base();
    candidatos = [candidato({ chip_hash: chip.huella(CHIP, SECRETO_CHIP), lat: -28.0 })];
    push.sendToUser.mockRejectedValue(new Error('push caído'));

    const res = await crear({ ...AVISO, codigo_chip: CHIP });
    await reposar();

    expect(res.status).toBe(201);
  });
});

/* ======================================================================== */
/* GET /api/reports/:id/chip · la única puerta al número                    */
/* ======================================================================== */
describe('GET /api/reports/:id/chip', () => {
  it('devuelve el número canónico y la máscara a su dueño', async () => {
    base({
      fila: avisoFila({
        chip_hash: chip.huella(CHIP, SECRETO_CHIP),
        chip_cifrado: chip.cifrar(CHIP, SECRETO_CHIP)
      })
    });

    const res = await verChip(UUID);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ chip: CHIP, enmascarado: CHIP_MASCARA, tiene_chip: true });
  });

  it('devuelve el chip corto ya normalizado con ceros', async () => {
    base({
      fila: avisoFila({
        chip_hash: chip.huella(CHIP_CORTO, SECRETO_CHIP),
        chip_cifrado: chip.cifrar(CHIP_CORTO, SECRETO_CHIP)
      })
    });

    const res = await verChip(UUID);

    expect(res.body.chip).toBe('000000123456789');
    expect(res.body.enmascarado).toBe('••••••••••• 6789');
  });

  it('sin chip declarado responde vacío pero con 200', async () => {
    base();

    const res = await verChip(UUID);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ chip: null, enmascarado: null, tiene_chip: false });
  });

  it('si el secreto cambió no puede descifrar y responde vacío en vez de romper', async () => {
    base({
      fila: avisoFila({
        chip_hash: chip.huella(CHIP, SECRETO_CHIP),
        chip_cifrado: chip.cifrar(CHIP, SECRETO_CHIP)
      })
    });
    process.env.CHIP_SECRET = 'secreto-rotado';

    const res = await verChip(UUID);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ chip: null, enmascarado: null, tiene_chip: false });
  });

  it('sin sesión responde 401 y no toca la base', async () => {
    base();

    const res = await verChip(UUID, { sub: null });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un id que no es UUID responde 400', async () => {
    base();

    const res = await verChip(UUID_INVALIDO);

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(ID_INVALIDO);
  });

  it('un aviso inexistente responde 404', async () => {
    base();
    avisoGuardado = null;

    const res = await verChip(UUID);

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(NO_ENCONTRADO);
  });

  it('el aviso de otra cuenta responde 403 (no 404) y no revela nada', async () => {
    base({
      fila: avisoFila({
        user_id: AJENO,
        chip_hash: chip.huella(CHIP, SECRETO_CHIP),
        chip_cifrado: chip.cifrar(CHIP, SECRETO_CHIP)
      })
    });

    const res = await verChip(UUID);

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(AJENO_ERROR);
    expect(JSON.stringify(res.body)).not.toContain(CHIP);
  });
});

/* ======================================================================== */
/* El chip no se filtra en los listados                                     */
/* ======================================================================== */
describe('el microchip no sale en el aviso público', () => {
  it('un aviso de otra cuenta solo dice que hay chip, sin máscara ni número', async () => {
    base({
      fila: avisoFila({
        user_id: AJENO,
        chip_hash: chip.huella(CHIP, SECRETO_CHIP),
        chip_cifrado: chip.cifrar(CHIP, SECRETO_CHIP)
      })
    });

    const res = await peticion('get', `/api/reports/${UUID}`, { sub: OTRO });

    expect(res.status).toBe(200);
    expect(res.body.report.tiene_chip).toBe(true);
    expect(res.body.report.chip_enmascarado).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain(CHIP);
    expect(JSON.stringify(res.body)).not.toContain(chip.huella(CHIP, SECRETO_CHIP));
  });

  it('el dueño ve la máscara en el propio aviso', async () => {
    base({
      fila: avisoFila({
        chip_hash: chip.huella(CHIP, SECRETO_CHIP),
        chip_cifrado: chip.cifrar(CHIP, SECRETO_CHIP)
      })
    });

    const res = await peticion('get', `/api/reports/${UUID}`);

    expect(res.body.report.chip_enmascarado).toBe(CHIP_MASCARA);
    expect(JSON.stringify(res.body)).not.toContain(CHIP);
  });

  it('si el secreto cambió, el dueño ve el aviso igual pero sin máscara', async () => {
    base({
      fila: avisoFila({
        chip_hash: chip.huella(CHIP, SECRETO_CHIP),
        chip_cifrado: chip.cifrar(CHIP, SECRETO_CHIP)
      })
    });
    process.env.CHIP_SECRET = 'secreto-rotado';

    const res = await peticion('get', `/api/reports/${UUID}`);

    expect(res.status).toBe(200);
    expect(res.body.report.tiene_chip).toBe(true);
    expect(res.body.report.chip_enmascarado).toBeNull();
  });
});

/* ======================================================================== */
/* PATCH /api/reports/:id · declarar, cambiar o borrar el chip             */
/* ======================================================================== */
describe('PATCH /api/reports/:id · microchip', () => {
  it('añade el chip a un aviso que no lo tenía', async () => {
    base({
      filaDespues: avisoFila({
        chip_hash: chip.huella(CHIP, SECRETO_CHIP),
        chip_cifrado: chip.cifrar(CHIP, SECRETO_CHIP)
      })
    });

    const res = await editar(UUID, { codigo_chip: CHIP });

    expect(res.status).toBe(200);
    const params = db.query.mock.calls[2][1];
    expect(params[POS_CHIP_HASH]).toBe(chip.huella(CHIP, SECRETO_CHIP));
    expect(params[POS_CHIP_CIFRADO]).toMatch(/^v1\./);
    expect(params[POS_ID]).toBe(UUID);
    expect(res.body.report.tiene_chip).toBe(true);
    expect(res.body.report.chip_enmascarado).toBe(CHIP_MASCARA);
  });

  it('sin el campo conserva el chip que ya tenía el aviso', async () => {
    const cifradoPrevio = chip.cifrar(CHIP, SECRETO_CHIP);
    base({
      fila: avisoFila({ chip_hash: chip.huella(CHIP, SECRETO_CHIP), chip_cifrado: cifradoPrevio })
    });

    const res = await editar(UUID, { color: 'blanco' });

    expect(res.status).toBe(200);
    const params = db.query.mock.calls[2][1];
    // Se conserva el texto cifrado TAL CUAL: no se vuelve a cifrar (cada cifrado
    // lleva un IV distinto, así que recifrar cambiaría el valor sin necesidad).
    expect(params[POS_CHIP_HASH]).toBe(chip.huella(CHIP, SECRETO_CHIP));
    expect(params[POS_CHIP_CIFRADO]).toBe(cifradoPrevio);
  });

  it('sin el campo y sin chip previo deja NULL (no revienta al leer la fila)', async () => {
    base();

    const res = await editar(UUID, { color: 'blanco' });

    expect(res.status).toBe(200);
    const params = db.query.mock.calls[2][1];
    expect(params[POS_CHIP_HASH]).toBeNull();
    expect(params[POS_CHIP_CIFRADO]).toBeNull();
  });

  it('con la cadena vacía borra el chip declarado', async () => {
    base({
      fila: avisoFila({
        chip_hash: chip.huella(CHIP, SECRETO_CHIP),
        chip_cifrado: chip.cifrar(CHIP, SECRETO_CHIP)
      })
    });

    const res = await editar(UUID, { codigo_chip: '' });

    expect(res.status).toBe(200);
    const params = db.query.mock.calls[2][1];
    expect(params[POS_CHIP_HASH]).toBeNull();
    expect(params[POS_CHIP_CIFRADO]).toBeNull();
  });

  it('un chip con formato inválido responde 400 y no toca la base', async () => {
    base();

    const res = await editar(UUID, { codigo_chip: '12345' });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MICROCHIP_INVALIDO);
    expect(db.query).toHaveBeenCalledTimes(2); // token + aviso
  });

  it('un chip que no es texto lo corta el validador', async () => {
    base();

    const res = await editar(UUID, { codigo_chip: 981020304050607 });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(VALOR_INVALIDO);
  });

  it('funciona con el id en mayúsculas de la URL', async () => {
    base();

    const res = await editar(UUID_MAYUS, { codigo_chip: CHIP });

    expect(res.status).toBe(200);
    expect(db.query.mock.calls[2][1][POS_ID]).toBe(UUID);
  });
});

/* ======================================================================== */
/* GET /api/reports/:id/matches · el chip entra aunque esté lejos           */
/* ======================================================================== */
describe('GET /api/reports/:id/matches · microchip', () => {
  it('la consulta busca por tipo y caja, o por el mismo chip', async () => {
    base({ fila: avisoFila({ chip_hash: chip.huella(CHIP, SECRETO_CHIP) }) });
    candidatos = [];

    const res = await buscarMatches(UUID);

    expect(res.status).toBe(200);
    const consulta = db.query.mock.calls.find(call => String(call[0]).includes('LIMIT 100'));
    expect(String(consulta[0])).toContain('OR chip_hash = $7');
    expect(consulta[1][6]).toBe(chip.huella(CHIP, SECRETO_CHIP));
  });

  it('un aviso sin chip manda NULL como parámetro del chip', async () => {
    base();
    candidatos = [];

    await buscarMatches(UUID);

    const consulta = db.query.mock.calls.find(call => String(call[0]).includes('LIMIT 100'));
    expect(consulta[1][6]).toBeNull();
  });

  it('muestra una coincidencia por chip lejana y con otro color, marcada y la primera', async () => {
    base({
      fila: avisoFila({ chip_hash: chip.huella(CHIP, SECRETO_CHIP), color: 'negro con blanco' })
    });
    candidatos = [
      // Cerca y con color compartido, pero sin chip: entra por la regla normal.
      candidato({ id: 'cerca', color: 'blanco' }),
      // A 500 km, otro tipo y otro color: solo puede entrar por el chip.
      candidato({
        id: 'chip-lejano',
        chip_hash: chip.huella(CHIP, SECRETO_CHIP),
        tipo: 'gato',
        color: 'atigrado',
        lat: -28.0
      })
    ];

    const res = await buscarMatches(UUID);

    expect(res.status).toBe(200);
    expect(res.body.matches.map(m => m.id)).toStrictEqual(['chip-lejano', 'cerca']);
    expect(res.body.matches[0].por_chip).toBe(true);
    expect(res.body.matches[1].por_chip).toBe(false);
    // El chip no viaja: ni el número ni la huella.
    expect(JSON.stringify(res.body)).not.toContain(CHIP);
    expect(JSON.stringify(res.body)).not.toContain(chip.huella(CHIP, SECRETO_CHIP));
  });

  it('un aviso sin chip no arrastra candidatos lejanos', async () => {
    base();
    candidatos = [candidato({ id: 'chip-lejano', chip_hash: chip.huella(CHIP, SECRETO_CHIP), lat: -28.0 })];

    const res = await buscarMatches(UUID);

    expect(res.body.matches).toStrictEqual([]);
  });

  it('descarta un candidato cerca pero con un color que no se parece en nada', async () => {
    base({ fila: avisoFila({ color: 'negro' }) });
    candidatos = [candidato({ id: 'otro-color', color: 'dorado' })];

    const res = await buscarMatches(UUID);

    expect(res.body.matches).toStrictEqual([]);
  });

  it('compara el color por la primera palabra en los dos sentidos', async () => {
    base({ fila: avisoFila({ color: 'negro con blanco' }) });
    candidatos = [candidato({ id: 'blanco', color: 'blanco' })];

    const res = await buscarMatches(UUID);

    expect(res.body.matches.map(m => m.id)).toStrictEqual(['blanco']);
  });

  it('sigue respondiendo 403 al que no es dueño del aviso', async () => {
    base();

    const res = await buscarMatches(UUID, { sub: OTRO });

    expect(res.status).toBe(403);
  });
});
