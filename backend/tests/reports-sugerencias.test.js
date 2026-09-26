// Pruebas de las SUGERENCIAS AMPLIAS en GET /api/reports/:id/matches?amplio=1.
//
// Para qué existe: cuando el aviso normal no encuentra nada porque el animal se
// alejó más allá del radio de la especie, o porque quien publicó describió poco.
// Estas sugerencias no exigen distancia ni puntaje: solo que compartan alguna
// cualidad declarada (color, raza, collar, sexo o microchip), y dicen en cuál
// coinciden para que nadie las confunda con una coincidencia fuerte.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { db, crearApp, pedir, tokenPara } from './helpers/aislar.js';
import reportsRouter from '../routes/reports.js';

const require = createRequire(import.meta.url);
const chip = require('../src/v2/chip.js');

const app = crearApp({ '/api/reports': reportsRouter });

const SUB = 'duena-1';
const OTRO = 'curioso-2';
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const SECRETO_CHIP = 'chip-secreto-de-pruebas';
const SECRETO_INICIAL = process.env.CHIP_SECRET;

let candidatosCaja = [];
let candidatosAmplios = [];
let aviso = null;

function avisoBase(cambios = {}) {
  return {
    id: UUID,
    user_id: SUB,
    estado: 'perdido',
    tipo: 'perro',
    sexo: 'macho',
    color: 'negro con blanco',
    raza: 'labrador',
    collar: 'rojo',
    descripcion: null,
    nombre_mascota: null,
    foto_url: null,
    foto_hash: null,
    chip_hash: null,
    chip_cifrado: null,
    lat: 40,
    lng: -3,
    lat_public: 40,
    lng_public: -3,
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
    color: 'negro con blanco',
    raza: 'labrador',
    collar: 'rojo',
    foto_url: null,
    foto_hash: null,
    chip_hash: null,
    chip_cifrado: null,
    lat: 40.01,
    lng: -3,
    active: true,
    resolved: false,
    created_at: 1700000000000,
    ...cambios
  };
}

function base(opciones = {}) {
  aviso = opciones.fila === undefined ? avisoBase() : opciones.fila;
  const fallaAmplio = opciones.fallaAmplio || false;
  db.query.mockImplementation(async sql => {
    if (String(sql).includes('token_version')) return { rows: [{ token_version: 0 }] };
    if (sql === 'SELECT * FROM reports WHERE id = $1') return aviso ? { rows: [aviso] } : { rows: [] };
    if (String(sql).includes('LIMIT 200')) {
      if (fallaAmplio) throw new Error('caída en las sugerencias');
      return { rows: candidatosAmplios };
    }
    if (String(sql).includes('LIMIT 100')) return { rows: candidatosCaja };
    return { rows: [] };
  });
}

function buscar(id, consulta = '', opciones = {}) {
  const { sub = SUB } = opciones;
  const p = pedir(app)
    .get(`/api/reports/${id}/matches${consulta}`)
    .set('x-forwarded-for', `10.0.0.${(id.length + consulta.length) % 250}`);
  return sub === null ? p : p.set('Authorization', `Bearer ${tokenPara(sub, 0)}`);
}

beforeEach(() => {
  db.query.mockReset();
  process.env.CHIP_SECRET = SECRETO_CHIP;
  candidatosCaja = [];
  candidatosAmplios = [];
});

afterEach(() => {
  if (SECRETO_INICIAL === undefined) delete process.env.CHIP_SECRET;
  else process.env.CHIP_SECRET = SECRETO_INICIAL;
});

describe('GET /:id/matches sin amplio', () => {
  it('ordena por puntaje del motor y desempata por distancia desde la pérdida', async () => {
    base();
    const lejosConDatos = candidato({
      id: 'a1111111-a111-4111-8111-111111111111',
      lat: 40.025,
      raza: 'labrador',
      sexo: 'macho',
      collar: 'rojo'
    });
    const cercaMenosSimilar = candidato({
      id: 'b1111111-b111-4111-8111-111111111111',
      lat: 40.005,
      raza: 'beagle',
      sexo: 'hembra',
      collar: 'azul'
    });
    const igualPuntajeMasCerca = candidato({
      id: 'c1111111-c111-4111-8111-111111111111',
      lat: 40.01,
      raza: 'labrador',
      sexo: 'macho',
      collar: 'rojo'
    });
    candidatosCaja = [cercaMenosSimilar, lejosConDatos, igualPuntajeMasCerca];

    const res = await buscar(UUID);

    expect(res.status).toBe(200);
    expect(res.body.matches.map(match => match.id)).toEqual([
      igualPuntajeMasCerca.id,
      lejosConDatos.id,
      cercaMenosSimilar.id
    ]);
    expect(res.body.matches[0].puntaje).toBeGreaterThan(res.body.matches[2].puntaje);
  });

  it('responde exactamente como antes: solo coincidencias fuertes', async () => {
    base();

    const res = await buscar(UUID);

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ matches: [] });
    expect(res.body.sugerencias).toBeUndefined();
  });
});

describe('GET /:id/matches?amplio=1', () => {
  it('sugiere un aviso lejano que solo comparte el color', async () => {
    base();
    candidatosCaja = [];
    candidatosAmplios = [
      candidato({ id: 'lejano', lat: 42.7, sexo: 'hembra', raza: 'beagle', collar: 'azul' })
    ];

    const res = await buscar(UUID, '?amplio=1');

    expect(res.status).toBe(200);
    expect(res.body.matches).toStrictEqual([]);
    expect(res.body.sugerencias).toHaveLength(1);
    expect(res.body.sugerencias[0]).toMatchObject({
      id: 'lejano',
      cualidades: ['color'],
      por_chip: false,
      es_mio: false,
      distancia_km: expect.any(Number)
    });
    expect(res.body.sugerencias[0].distancia_km).toBeGreaterThan(290);
  });

  it('la consulta amplia no lleva caja geográfica y busca por tipo o chip', async () => {
    base();
    candidatosAmplios = [candidato({ id: 'lejano', lat: 42.7 })];

    await buscar(UUID, '?amplio=1');

    const consulta = db.query.mock.calls.find(call => String(call[0]).includes('LIMIT 200'));
    expect(String(consulta[0])).toContain('(tipo = $2 OR chip_hash = $3)');
    expect(String(consulta[0])).not.toContain('BETWEEN');
    expect(String(consulta[0])).toContain('ORDER BY created_at DESC');
    expect(consulta[1]).toStrictEqual(['encontrado', 'perro', null]);
  });

  it('con chip declarado pasa la huella para encontrar al animal aunque sea de otra especie', async () => {
    base({ fila: avisoBase({ chip_hash: chip.huella('981020304050607', SECRETO_CHIP) }) });
    candidatosAmplios = [];

    await buscar(UUID, '?amplio=1');

    const consulta = db.query.mock.calls.find(call => String(call[0]).includes('LIMIT 200'));
    expect(consulta[1][2]).toBe(chip.huella('981020304050607', SECRETO_CHIP));
  });

  it('no repite como sugerencia lo que ya salió como coincidencia fuerte', async () => {
    base();
    // El mismo aviso entra por la caja (coincidencia fuerte) y también estaría en
    // la lista amplia: no puede aparecer dos veces.
    candidatosCaja = [candidato({ id: 'cerca' })];
    candidatosAmplios = [candidato({ id: 'cerca' }), candidato({ id: 'lejano', lat: 42.7 })];

    const res = await buscar(UUID, '?amplio=1');

    expect(res.body.matches.map(m => m.id)).toStrictEqual(['cerca']);
    expect(res.body.sugerencias.map(s => s.id)).toStrictEqual(['lejano']);
  });

  it('sin candidatos amplios devuelve una lista vacía', async () => {
    base();
    candidatosAmplios = [];

    const res = await buscar(UUID, '?amplio=1');

    expect(res.body.sugerencias).toStrictEqual([]);
  });

  it('un candidato sin nada en común no se sugiere', async () => {
    base();
    candidatosAmplios = [
      candidato({ id: 'nada', lat: 42.7, color: 'atigrado', sexo: 'hembra', raza: 'beagle', collar: 'azul' })
    ];

    const res = await buscar(UUID, '?amplio=1');

    expect(res.body.sugerencias).toStrictEqual([]);
  });

  it('una sugerencia no filtra el microchip del otro aviso', async () => {
    base();
    const huellaAjena = chip.huella('981020304050607', SECRETO_CHIP);
    candidatosAmplios = [
      candidato({
        id: 'con-chip',
        lat: 42.7,
        chip_hash: huellaAjena,
        chip_cifrado: chip.cifrar('981020304050607', SECRETO_CHIP)
      })
    ];

    const res = await buscar(UUID, '?amplio=1');

    // Coincide el color, así que hay sugerencia; pero del microchip ajeno solo se
    // puede saber que existe, nunca el número ni la huella.
    expect(res.body.sugerencias).toHaveLength(1);
    expect(res.body.sugerencias[0].tiene_chip).toBe(true);
    expect(res.body.sugerencias[0].chip_enmascarado).toBeNull();
    expect(JSON.stringify(res.body)).not.toContain('981020304050607');
    expect(JSON.stringify(res.body)).not.toContain(huellaAjena);
  });

  it('si la consulta amplia falla responde 500', async () => {
    base({ fallaAmplio: true });

    const res = await buscar(UUID, '?amplio=1');

    expect(res.status).toBe(500);
  });

  it('sin sesión responde 401 y con otra cuenta responde 403', async () => {
    base();

    const sinSesion = await buscar(UUID, '?amplio=1', { sub: null });
    const ajena = await buscar(UUID, '?amplio=1', { sub: OTRO });

    expect(sinSesion.status).toBe(401);
    expect(ajena.status).toBe(403);
  });
});
