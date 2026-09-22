// Pruebas del registro voluntario de microchips (backend/routes/chips.js).
//
// Lo que se protege aquí: el número del chip nunca se guarda en claro, un chip
// solo puede tener un registro activo, el consentimiento es obligatorio y
// trazable, y los derechos de acceso, rectificación y cancelación son solo del
// dueño del registro.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { db, crearApp, pedir, tokenPara } from './helpers/aislar.js';
import chipsRouter from '../routes/chips.js';

const require = createRequire(import.meta.url);
const chip = require('../src/v2/chip.js');

const app = crearApp({ '/api/chips': chipsRouter });

const SUB = 'duena-1';
const OTRO = 'curioso-2';
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const UUID_MALO = 'no-es-un-uuid';
const CHIP = '981020304050607';
const CHIP_MASCARA = '••••••••••• 0607';
const SECRETO_CHIP = 'chip-secreto-de-pruebas';
const SECRETO_INICIAL = process.env.CHIP_SECRET;

const SIN_SESION = { error: 'No autenticado.' };
const SIN_CONSENTIMIENTO = { error: 'Necesitamos tu consentimiento para registrar el microchip.' };
const CHIP_INVALIDO = { error: 'El microchip debe tener 15 dígitos.' };
const YA_REGISTRADO = { error: 'Ese microchip ya está registrado en PetSeñal.' };
const CUPO = { error: 'Alcanzaste el límite de registros por hoy. Intenta mañana.' };
const NO_ENCONTRADO = { error: 'Registro no encontrado.' };
const AJENO = { error: 'Este registro no es tuyo.' };
const ID_INVALIDO = { error: 'Identificador inválido.' };
const VALOR_INVALIDO = { error: 'Invalid value' };

const REGISTRO = { chip_id: CHIP, pet_name: 'Firulais', consent_accepted: true };

// Columnas del INSERT de registro, en orden: los parámetros que la ruta manda.
const COLUMNAS_INSERT = [
  'id',
  'chip_hash',
  'chip_cifrado',
  'owner_user_id',
  'pet_name',
  'species',
  'consent_given_at',
  'consent_text_version',
  'created_at'
];

let creados = [];
let accesos = [];
let actualizados = [];
let borrados = [];
let fila = null;

function filaDeParams(params) {
  const filaNueva = {};
  COLUMNAS_INSERT.forEach((columna, i) => {
    filaNueva[columna] = params[i];
  });
  filaNueva.verification_status = 'self_registered';
  filaNueva.verified_by_vet_id = null;
  filaNueva.updated_at = params[8];
  filaNueva.deleted_at = null;
  return filaNueva;
}

function registroFila(cambios = {}) {
  return {
    id: UUID,
    chip_hash: chip.huella(CHIP, SECRETO_CHIP),
    chip_cifrado: chip.cifrar(CHIP, SECRETO_CHIP),
    owner_user_id: SUB,
    pet_name: 'Firulais',
    species: 'perro',
    verification_status: 'self_registered',
    verified_by_vet_id: null,
    consent_given_at: 1700000000000,
    consent_text_version: 'v1',
    created_at: 1700000000000,
    updated_at: 1700000000000,
    deleted_at: null,
    ...cambios
  };
}

function base(opciones = {}) {
  const {
    hoy = 0,
    duplicado = false,
    filas = null,
    fallaLog = false,
    filaInicial = registroFila()
  } = opciones;
  fila = filaInicial;

  function insertarAcceso(params) {
    if (fallaLog) throw new Error('log caído');
    accesos.push(params);
    return { rows: [] };
  }

  function actualizarRegistro(params) {
    actualizados.push(params);
    fila = { ...fila, pet_name: params[0], species: params[1], updated_at: params[2] };
    return { rows: [] };
  }

  function leerMios() {
    if (filas !== null) return { rows: filas };
    return { rows: fila ? [fila] : [] };
  }

  const reglas = [
    [s => s.includes('token_version FROM users'), () => ({ rows: [{ token_version: 0 }] })],
    [s => s.includes('COUNT(*)::int AS n FROM chip_registrations'), () => ({ rows: [{ n: hoy }] })],
    [
      s => s.includes('SELECT id FROM chip_registrations WHERE chip_hash'),
      () => ({ rows: duplicado ? [{ id: 'ya-existe' }] : [] })
    ],
    [
      s => s.startsWith('INSERT INTO chip_registrations'),
      params => {
        creados.push(params);
        fila = filaDeParams(params);
        return { rows: [] };
      }
    ],
    [s => s.startsWith('INSERT INTO data_access_log'), insertarAcceso],
    [s => s.includes('WHERE owner_user_id'), leerMios],
    [
      s => s.includes('SELECT * FROM chip_registrations WHERE id = $1 AND deleted_at IS NULL'),
      () => ({ rows: fila ? [fila] : [] })
    ],
    [s => s.includes('UPDATE chip_registrations SET pet_name'), actualizarRegistro],
    [
      s => s.includes('UPDATE chip_registrations SET deleted_at'),
      params => {
        borrados.push(params);
        return { rows: [] };
      }
    ],
    [
      s => s.startsWith('SELECT * FROM chip_registrations WHERE id = $1'),
      () => ({ rows: fila ? [fila] : [] })
    ]
  ];

  db.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    for (const [aplica, responder] of reglas) {
      if (aplica(s)) return responder(params);
    }
    return { rows: [] };
  });
}

let visitas = 0;
function ipNueva() {
  visitas += 1;
  return `10.${Math.floor(visitas / 250)}.${visitas % 250}.4`;
}

function peticion(metodo, ruta, opciones = {}) {
  const { sub = SUB } = opciones;
  const p = pedir(app)[metodo](ruta).set('x-forwarded-for', ipNueva());
  return sub === null ? p : p.set('Authorization', `Bearer ${tokenPara(sub, 0)}`);
}

function registrar(cuerpo, opciones) {
  return peticion('post', '/api/chips/register', opciones).send(cuerpo);
}

function misChips(opciones) {
  return peticion('get', '/api/chips/mine', opciones);
}

function editar(id, cuerpo, opciones) {
  return peticion('patch', `/api/chips/${id}`, opciones).send(cuerpo);
}

function borrar(id, opciones) {
  return peticion('delete', `/api/chips/${id}`, opciones);
}

beforeEach(() => {
  db.query.mockReset();
  process.env.CHIP_SECRET = SECRETO_CHIP;
  creados = [];
  accesos = [];
  actualizados = [];
  borrados = [];
});

afterEach(() => {
  if (SECRETO_INICIAL === undefined) delete process.env.CHIP_SECRET;
  else process.env.CHIP_SECRET = SECRETO_INICIAL;
});

/* ======================================================================== */
/* POST /api/chips/register                                                 */
/* ======================================================================== */
describe('POST /api/chips/register', () => {
  it('sin sesión responde 401 y no toca la base', async () => {
    base();

    const res = await registrar(REGISTRO, { sub: null });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SIN_SESION);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('registra el chip sin guardar el número: huella y cifrado, nada más', async () => {
    base();

    const res = await registrar({ ...REGISTRO, species: 'perro' });

    expect(res.status).toBe(201);
    const params = creados[0];
    expect(params[1]).toBe(chip.huella(CHIP, SECRETO_CHIP));
    expect(params[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(params[2]).toMatch(/^v1\./);
    expect(JSON.stringify(params)).not.toContain(CHIP);
    expect(params[3]).toBe(SUB);
    expect(params[4]).toBe('Firulais');
    expect(params[5]).toBe('perro');
    // El consentimiento queda fechado y con la versión del texto aceptado.
    expect(params[6]).toBe(params[8]);
    expect(params[7]).toBe('v1');
    expect(accesos).toHaveLength(1);
    expect(accesos[0][3]).toBe('create');
  });

  it('devuelve el número a su dueño y la máscara, pero nunca el cifrado ni la huella', async () => {
    base();

    const res = await registrar(REGISTRO);

    expect(res.status).toBe(201);
    expect(res.body.registro.chip).toBe(CHIP);
    expect(res.body.registro.chip_enmascarado).toBe(CHIP_MASCARA);
    expect(res.body.registro.verification_status).toBe('self_registered');
    expect(res.body.registro.species).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('v1.');
    expect(JSON.stringify(res.body)).not.toContain(chip.huella(CHIP, SECRETO_CHIP));
  });

  it('sin consentimiento no registra nada', async () => {
    base();

    const sinCampo = await registrar({ chip_id: CHIP, pet_name: 'Firulais' });
    const enFalso = await registrar({ ...REGISTRO, consent_accepted: false });
    const comoTexto = await registrar({ ...REGISTRO, consent_accepted: 'true' });

    expect(sinCampo.status).toBe(400);
    expect(enFalso.status).toBe(400);
    expect(enFalso.body).toStrictEqual(SIN_CONSENTIMIENTO);
    expect(comoTexto.status).toBe(400);
    expect(creados).toHaveLength(0);
  });

  it.each([
    ['catorce dígitos', '98102030405060', CHIP_INVALIDO],
    ['dieciséis dígitos', '9810203040506078', CHIP_INVALIDO],
    ['letras', '98102030405060A', CHIP_INVALIDO],
    ['demasiado largo', '1'.repeat(33), CHIP_INVALIDO],
    ['un número, no texto', 981020304050607, VALOR_INVALIDO]
  ])('rechaza un chip con %s y no registra', async (_caso, valor, esperado) => {
    base();

    const res = await registrar({ ...REGISTRO, chip_id: valor });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(esperado);
    expect(creados).toHaveLength(0);
  });

  it('acepta el chip escrito con espacios y guarda la huella canónica', async () => {
    base();

    const res = await registrar({ ...REGISTRO, chip_id: '981 020 304 050 607' });

    expect(res.status).toBe(201);
    expect(creados[0][1]).toBe(chip.huella(CHIP, SECRETO_CHIP));
  });

  it('exige el nombre de la mascota y no acepta uno vacío', async () => {
    base();

    const sinNombre = await registrar({ chip_id: CHIP, consent_accepted: true });
    const vacio = await registrar({ ...REGISTRO, pet_name: '   ' });

    expect(sinNombre.status).toBe(400);
    expect(vacio.status).toBe(400);
    expect(creados).toHaveLength(0);
  });

  it('un nombre de más de 100 caracteres se rechaza', async () => {
    base();

    const res = await registrar({ ...REGISTRO, pet_name: 'a'.repeat(101) });

    expect(res.status).toBe(400);
    expect(creados).toHaveLength(0);
  });

  it('un chip ya registrado responde 409 y no sobrescribe nada', async () => {
    base({ duplicado: true });

    const res = await registrar(REGISTRO);

    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual(YA_REGISTRADO);
    expect(creados).toHaveLength(0);
  });

  it('al llegar a 10 registros en 24 h responde 429 y no inserta', async () => {
    base({ hoy: 10 });

    const res = await registrar(REGISTRO);

    expect(res.status).toBe(429);
    expect(res.body).toStrictEqual(CUPO);
    expect(creados).toHaveLength(0);
  });

  it('con 9 registros todavía deja registrar', async () => {
    base({ hoy: 9 });

    const res = await registrar(REGISTRO);

    expect(res.status).toBe(201);
  });

  it('si falla el registro de accesos, el alta sigue funcionando', async () => {
    base({ fallaLog: true });

    const res = await registrar(REGISTRO);

    expect(res.status).toBe(201);
    expect(creados).toHaveLength(1);
  });

  it('si la base falla responde 500', async () => {
    base();
    db.query.mockImplementation(async sql => {
      if (String(sql).includes('token_version')) return { rows: [{ token_version: 0 }] };
      throw new Error('base caída');
    });

    const res = await registrar(REGISTRO);

    expect(res.status).toBe(500);
  });
});

/* ======================================================================== */
/* GET /api/chips/mine (derecho de acceso)                                  */
/* ======================================================================== */
describe('GET /api/chips/mine', () => {
  it('sin sesión responde 401', async () => {
    base();

    const res = await misChips({ sub: null });

    expect(res.status).toBe(401);
  });

  it('devuelve los registros activos del usuario con el número descifrado', async () => {
    base({ filas: [registroFila(), registroFila({ id: 'otro-id', pet_name: 'Luna', species: null })] });

    const res = await misChips();

    expect(res.status).toBe(200);
    expect(res.body.registros).toHaveLength(2);
    expect(res.body.registros[0].chip).toBe(CHIP);
    expect(res.body.registros[1].pet_name).toBe('Luna');
    expect(res.body.registros[1].species).toBeNull();
    // La consulta filtra por el dueño del token y excluye los borrados.
    const consulta = db.query.mock.calls.find(call => String(call[0]).includes('WHERE owner_user_id'));
    expect(String(consulta[0])).toContain('deleted_at IS NULL');
    expect(consulta[1]).toStrictEqual([SUB]);
    // Cada lectura queda trazada (son datos personales).
    expect(accesos.map(a => a[3])).toStrictEqual(['read', 'read']);
  });

  it('sin registros devuelve una lista vacía y no registra accesos', async () => {
    base({ filas: [] });

    const res = await misChips();

    expect(res.body.registros).toStrictEqual([]);
    expect(accesos).toHaveLength(0);
  });
});

/* ======================================================================== */
/* PATCH /api/chips/:id (derecho de rectificación)                          */
/* ======================================================================== */
describe('PATCH /api/chips/:id', () => {
  it('cambia el nombre y la especie del propio registro', async () => {
    base();

    const res = await editar(UUID, { pet_name: 'Firulais II', species: 'quiltro' });

    expect(res.status).toBe(200);
    expect(res.body.registro.pet_name).toBe('Firulais II');
    expect(actualizados[0][0]).toBe('Firulais II');
    expect(actualizados[0][1]).toBe('quiltro');
    expect(accesos[0][3]).toBe('update');
  });

  it('sin campos conserva lo que ya había', async () => {
    base();

    const res = await editar(UUID, {});

    expect(res.status).toBe(200);
    expect(actualizados[0][0]).toBe('Firulais');
    expect(actualizados[0][1]).toBe('perro');
  });

  it('una especie vacía se guarda como NULL', async () => {
    base();

    await editar(UUID, { species: '   ' });

    expect(actualizados[0][1]).toBeNull();
  });

  it('el registro de otra cuenta responde 403', async () => {
    base({ filaInicial: registroFila({ owner_user_id: OTRO }) });

    const res = await editar(UUID, { pet_name: 'Mío' });

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(AJENO);
    expect(actualizados).toHaveLength(0);
  });

  it('un registro inexistente responde 404', async () => {
    base({ filaInicial: null });

    const res = await editar(UUID, { pet_name: 'Mío' });

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(NO_ENCONTRADO);
  });

  it('un id que no es UUID responde 400', async () => {
    base();

    const res = await editar(UUID_MALO, { pet_name: 'Mío' });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(ID_INVALIDO);
  });

  it('sin sesión responde 401', async () => {
    base();

    const res = await editar(UUID, { pet_name: 'Mío' }, { sub: null });

    expect(res.status).toBe(401);
  });
});

/* ======================================================================== */
/* DELETE /api/chips/:id (derecho de cancelación)                           */
/* ======================================================================== */
describe('DELETE /api/chips/:id', () => {
  it('hace borrado lógico: marca la fecha, nunca borra la fila', async () => {
    base();

    const res = await borrar(UUID);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true });
    expect(borrados).toHaveLength(1);
    expect(borrados[0][0]).toEqual(expect.any(Number));
    expect(borrados[0][1]).toBe(UUID);
    const sql = String(db.query.mock.calls.find(call => String(call[0]).includes('SET deleted_at'))[0]);
    expect(sql).toContain('UPDATE chip_registrations SET deleted_at');
    expect(sql).not.toContain('DELETE FROM');
    expect(accesos[0][3]).toBe('delete');
  });

  it('el registro de otra cuenta responde 403 y no se borra', async () => {
    base({ filaInicial: registroFila({ owner_user_id: OTRO }) });

    const res = await borrar(UUID);

    expect(res.status).toBe(403);
    expect(borrados).toHaveLength(0);
  });

  it('un registro inexistente responde 404', async () => {
    base({ filaInicial: null });

    const res = await borrar(UUID);

    expect(res.status).toBe(404);
  });

  it('un id que no es UUID responde 400 y no consulta', async () => {
    base();

    const res = await borrar(UUID_MALO);

    expect(res.status).toBe(400);
    expect(borrados).toHaveLength(0);
  });

  it('sin sesión responde 401', async () => {
    base();

    const res = await borrar(UUID, { sub: null });

    expect(res.status).toBe(401);
  });
});

/* ======================================================================== */
/* Contrato fino: lo que fijan los mutantes que sobrevivían                 */
/* ======================================================================== */
describe('POST /api/chips/register · parámetros y traza exactos', () => {
  it('el cupo diario se cuenta con la cuenta del token y una ventana de 24 h', async () => {
    const antes = Date.now();
    base();

    await registrar(REGISTRO);

    const consulta = db.query.mock.calls.find(call => String(call[0]).includes('COUNT(*)::int AS n'));
    expect(consulta[1][0]).toBe(SUB);
    // Hacia atrás 24 h, no hacia delante.
    expect(consulta[1][1]).toBeLessThanOrEqual(antes);
    expect(consulta[1][1]).toBeGreaterThanOrEqual(antes - 24 * 60 * 60 * 1000 - 5000);
    expect(consulta[1][1]).toBeLessThan(antes - 24 * 60 * 60 * 1000 + 5000);
  });

  it('busca el duplicado por la huella y relee la fila por su id', async () => {
    base();

    await registrar(REGISTRO);

    const duplicado = db.query.mock.calls.find(call =>
      String(call[0]).includes('SELECT id FROM chip_registrations')
    );
    expect(duplicado[1]).toStrictEqual([chip.huella(CHIP, SECRETO_CHIP)]);
    const relectura = db.query.mock.calls.find(call =>
      String(call[0]).startsWith('SELECT * FROM chip_registrations')
    );
    expect(relectura[1]).toStrictEqual([creados[0][0]]);
  });

  it('la traza de acceso guarda la tabla, la acción y quién la hizo', async () => {
    base();

    await registrar(REGISTRO);

    expect(accesos[0][1]).toBe('chip_registrations');
    expect(accesos[0][3]).toBe('create');
    expect(accesos[0][4]).toBe(SUB);
    expect(accesos[0][5]).toEqual(expect.any(Number));
  });

  it('devuelve la especie declarada tal cual', async () => {
    base();

    const res = await registrar({ ...REGISTRO, species: 'perro' });

    expect(res.body.registro.species).toBe('perro');
  });

  it('sin CHIP_SECRET el alta falla con 500 en vez de guardar algo sin proteger', async () => {
    base();
    delete process.env.CHIP_SECRET;

    const res = await registrar(REGISTRO);

    expect(res.status).toBe(500);
    expect(creados).toHaveLength(0);
  });
});

describe('PATCH y DELETE · detalles del contrato', () => {
  it('un nombre vacío en la edición responde 400', async () => {
    base();

    const res = await editar(UUID, { pet_name: '   ' });

    expect(res.status).toBe(400);
    expect(actualizados).toHaveLength(0);
  });

  it('recorta los espacios del nombre antes de guardarlo', async () => {
    base();

    await editar(UUID, { pet_name: '  Luna  ' });

    expect(actualizados[0][0]).toBe('Luna');
  });

  it('una especie con espacios se recorta', async () => {
    base();

    await editar(UUID, { species: '  quiltro  ' });

    expect(actualizados[0][1]).toBe('quiltro');
  });

  it('la traza de la edición guarda quién y qué acción', async () => {
    base();

    await editar(UUID, { pet_name: 'Luna' });

    expect(accesos[0][1]).toBe('chip_registrations');
    expect(accesos[0][3]).toBe('update');
    expect(accesos[0][4]).toBe(SUB);
  });

  it('si la base falla al editar responde 500', async () => {
    base();
    db.query.mockImplementation(async sql => {
      if (String(sql).includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (String(sql).includes('SELECT * FROM chip_registrations WHERE id = $1 AND deleted_at IS NULL')) {
        return { rows: [registroFila()] };
      }
      throw new Error('base caída');
    });

    const res = await editar(UUID, { pet_name: 'Luna' });

    expect(res.status).toBe(500);
  });

  it('si la base falla al dar de baja responde 500', async () => {
    base();
    db.query.mockImplementation(async sql => {
      if (String(sql).includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (String(sql).includes('SELECT * FROM chip_registrations WHERE id = $1 AND deleted_at IS NULL')) {
        return { rows: [registroFila()] };
      }
      throw new Error('base caída');
    });

    const res = await borrar(UUID);

    expect(res.status).toBe(500);
  });

  it('la traza de la baja guarda quién y qué acción', async () => {
    base();

    await borrar(UUID);

    expect(accesos[0][1]).toBe('chip_registrations');
    expect(accesos[0][3]).toBe('delete');
    expect(accesos[0][4]).toBe(SUB);
  });
});
