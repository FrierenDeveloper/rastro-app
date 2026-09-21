// Pruebas del puente de coincidencias (backend/src/v2/coincidencias.js).
// Código nuevo de src/v2: cobertura 100% obligatoria (ver AGENTS.md).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const coincidencias = require('../src/v2/coincidencias.js');

const { cajaBusqueda, coincidenciasDeOtros, duplicadosDeFoto, KM_POR_GRADO, COS_MINIMO } = coincidencias;

const T0 = 1_000_000_000_000;

function perdido(over = {}) {
  return {
    id: 'p1',
    user_id: 'u-base',
    estado: 'perdido',
    tipo: 'perro',
    sexo: 'macho',
    color: 'negro',
    raza: 'labrador',
    collar: 'rojo',
    lat: 40,
    lng: -3,
    created_at: T0,
    perdido_hace_horas: 2,
    foto_hash: null,
    ...over
  };
}

function encontrado(over = {}) {
  return { ...perdido(), id: 'e1', user_id: 'u-otro', estado: 'encontrado', ...over };
}

describe('cajaBusqueda', () => {
  it('por defecto cubre el radio tope de 5 km', () => {
    const caja = cajaBusqueda(0, 0);
    const d = 5 / KM_POR_GRADO;
    expect(caja).toStrictEqual({ latMin: -d, latMax: d, lngMin: -d, lngMax: d });
  });

  it('acepta un radio propio', () => {
    const caja = cajaBusqueda(0, 0, 1);
    const d = 1 / KM_POR_GRADO;
    expect(caja.latMin).toBe(-d);
    expect(caja.latMax).toBe(d);
    expect(cajaBusqueda(0, 0, 0.5).latMax).toBe(0.5 / KM_POR_GRADO);
  });

  it('en latitudes polares acota el coseno para no disparar la caja', () => {
    const caja = cajaBusqueda(89.9, 0);
    const dLng = 5 / (KM_POR_GRADO * COS_MINIMO);
    expect(caja.lngMin).toBeCloseTo(-dLng, 10);
    expect(caja.lngMax).toBeCloseTo(dLng, 10);
  });

  it('un radio inválido cae al valor por defecto', () => {
    const d = 5 / KM_POR_GRADO;
    for (const km of [0, -3, NaN, undefined]) {
      expect(cajaBusqueda(0, 0, km).latMax).toBe(d);
    }
  });
});

describe('coincidenciasDeOtros', () => {
  it('sin lista de candidatos no hay coincidencias', () => {
    expect(coincidenciasDeOtros(perdido(), null)).toEqual([]);
    expect(coincidenciasDeOtros(perdido(), 'nope')).toEqual([]);
  });

  it('adjunta el dueño de cada aviso emparejado', () => {
    const r = coincidenciasDeOtros(perdido(), [encontrado({ id: 'e9' })]);

    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 'e9', user_id: 'u-otro' });
    expect(r[0].puntaje).toBeGreaterThan(0);
  });

  it('descarta los avisos del propio usuario', () => {
    expect(coincidenciasDeOtros(perdido(), [encontrado({ user_id: 'u-base' })])).toEqual([]);
  });

  it('descarta candidatos sin dueño', () => {
    expect(coincidenciasDeOtros(perdido(), [encontrado({ user_id: null })])).toEqual([]);
    expect(coincidenciasDeOtros(perdido(), [encontrado({ user_id: undefined })])).toEqual([]);
  });

  it('avisa una sola vez por usuario, con su mejor coincidencia', () => {
    const mejor = encontrado({ id: 'mejor' });
    const peor = encontrado({ id: 'peor', color: 'blanco' });

    const r = coincidenciasDeOtros(perdido(), [peor, mejor], { puntajeMinimo: 0 });

    expect(r.map(m => m.id)).toStrictEqual(['mejor']);
  });

  it('respeta el límite y el resto de opciones del motor', () => {
    const lista = [
      encontrado({ id: 'a', user_id: 'u1' }),
      encontrado({ id: 'b', user_id: 'u2' }),
      encontrado({ id: 'c', user_id: 'u3' })
    ];

    expect(coincidenciasDeOtros(perdido(), lista, { limite: 2 })).toHaveLength(2);
  });
});

describe('duplicadosDeFoto', () => {
  it('sin foto en el aviso de referencia no hay duplicados', () => {
    expect(duplicadosDeFoto(perdido(), [encontrado({ foto_hash: '0000000000000000' })])).toEqual([]);
  });

  it('sin lista de candidatos no hay duplicados', () => {
    expect(duplicadosDeFoto(perdido({ foto_hash: '0000000000000000' }), null)).toEqual([]);
  });

  it('encuentra al aviso con la misma foto', () => {
    const base = perdido({ foto_hash: '0000000000000000' });
    const r = duplicadosDeFoto(base, [encontrado({ foto_hash: '0000000000000000' })]);

    expect(r).toStrictEqual([{ id: 'e1', user_id: 'u-otro' }]);
  });

  it('ignora al mismo aviso, al propio usuario, sin hash y con otra foto', () => {
    const base = perdido({ id: 'p1', foto_hash: '0000000000000000' });
    const candidatos = [
      encontrado({ id: 'p1', foto_hash: '0000000000000000' }),
      encontrado({ id: 'propio', user_id: 'u-base', foto_hash: '0000000000000000' }),
      encontrado({ id: 'sin-hash', foto_hash: null }),
      encontrado({ id: 'otra', foto_hash: 'ffffffffffffffff' })
    ];

    expect(duplicadosDeFoto(base, candidatos)).toEqual([]);
  });

  it('admite una foto parecida dentro del umbral', () => {
    const base = perdido({ foto_hash: '0000000000000000' });
    expect(duplicadosDeFoto(base, [encontrado({ foto_hash: '0000000000000003' })])).toHaveLength(1);
  });

  it('acepta un umbral propio', () => {
    const base = perdido({ foto_hash: '0000000000000000' });
    const candidatos = [encontrado({ foto_hash: '000000000000000f' })];

    expect(duplicadosDeFoto(base, candidatos, { umbralDuplicado: 1 })).toEqual([]);
    expect(duplicadosDeFoto(base, candidatos, { umbralDuplicado: 4 })).toHaveLength(1);
  });

  it('un candidato nulo no rompe', () => {
    const base = perdido({ foto_hash: '0000000000000000' });
    expect(duplicadosDeFoto(base, [null, undefined])).toEqual([]);
  });
});
