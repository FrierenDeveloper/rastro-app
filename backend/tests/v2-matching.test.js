// Pruebas del motor de coincidencias (backend/src/v2/matching.js).
// Código nuevo de src/v2: cobertura 100% obligatoria (ver AGENTS.md).
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

// Se carga con require (igual que la ruta de producción): si el módulo se
// importara por ESM y por CJS a la vez, V8 contaría dos veces el mismo archivo y
// la cobertura de src/v2 daría ramas fantasma sin cubrir.
const require = createRequire(import.meta.url);
const matching = require('../src/v2/matching.js');

const {
  normalizar,
  distanciaKm,
  emparejar,
  buscarCoincidencias,
  PESO_TIPO,
  PESO_DISTANCIA_MAX,
  PESO_COLOR_EXACTO,
  PESO_COLOR_PARCIAL,
  PESO_SEXO,
  PESO_RAZA,
  PESO_COLLAR,
  PESO_TIEMPO,
  PUNTAJE_CHIP,
  RADIO_MINIMO_KM,
  RADIO_TOPE_KM
} = matching;

const T0 = 1_000_000_000_000;
const H = 60 * 60 * 1000;
// Huellas de microchip de ejemplo (en producción son HMAC-SHA256 en hex). El
// motor NUNCA ve el número del chip, solo esta huella.
const HUELLA_A = 'a'.repeat(64);
const HUELLA_B = 'b'.repeat(64);

function perdido(over = {}) {
  return {
    id: 'p1',
    estado: 'perdido',
    tipo: 'perro',
    sexo: 'macho',
    color: 'negro con blanco',
    raza: 'labrador',
    collar: 'rojo',
    lat: 40,
    lng: -3,
    created_at: T0,
    perdido_hace_horas: 2,
    ...over
  };
}

function encontrado(over = {}) {
  return { ...perdido(), id: 'e1', estado: 'encontrado', ...over };
}

describe('normalizar', () => {
  it('null y undefined quedan vacíos', () => {
    expect(normalizar(null)).toBe('');
    expect(normalizar(undefined)).toBe('');
  });

  it('quita acentos, mayúsculas y espacios de más', () => {
    expect(normalizar('  Negro   CON  Blancó ')).toBe('negro con blanco');
  });

  it('convierte números a texto', () => {
    expect(normalizar(12)).toBe('12');
  });
});

describe('distanciaKm', () => {
  it('mismo punto da 0', () => {
    expect(distanciaKm(40, -3, 40, -3)).toBe(0);
  });

  it('0.01 grados de latitud ronda 1.11 km', () => {
    const d = distanciaKm(40, -3, 40.01, -3);
    expect(d).toBeGreaterThan(1.11);
    expect(d).toBeLessThan(1.12);
  });

  it('es simétrica', () => {
    expect(distanciaKm(40, -3, 40.02, -2.98)).toBeCloseTo(distanciaKm(40.02, -2.98, 40, -3), 10);
  });
});

describe('emparejar', () => {
  it('sin aviso base o sin candidato no hay coincidencia', () => {
    expect(emparejar(null, encontrado())).toBeNull();
    expect(emparejar(perdido(), null)).toBeNull();
  });

  it('dos avisos del mismo estado no se emparejan', () => {
    expect(emparejar(perdido(), perdido())).toBeNull();
  });

  it('distinta especie no se empareja', () => {
    expect(emparejar(perdido(), encontrado({ tipo: 'gato' }))).toBeNull();
  });

  it('un aviso sin tipo no se empareja', () => {
    expect(emparejar(perdido({ tipo: '' }), encontrado({ tipo: '' }))).toBeNull();
  });

  it('una coincidencia perfecta suma 100 y explica todos los motivos', () => {
    const m = emparejar(perdido(), encontrado());
    expect(m.puntaje).toBe(
      PESO_TIPO + PESO_DISTANCIA_MAX + PESO_COLOR_EXACTO + PESO_SEXO + PESO_RAZA + PESO_COLLAR + PESO_TIEMPO
    );
    expect(m.distancia_km).toBe(0);
    expect(m.motivos).toEqual([
      'Mismo tipo de mascota',
      'A menos de 500 m',
      'Mismo color',
      'Mismo sexo',
      'Misma raza',
      'Mismo collar',
      'Fechas compatibles'
    ]);
  });

  it('funciona con el aviso base en cualquiera de los dos estados', () => {
    expect(emparejar(encontrado(), perdido()).puntaje).toBe(100);
  });

  it('descarta un "encontrado" demasiado anterior a la pérdida', () => {
    expect(emparejar(perdido(), encontrado({ created_at: T0 - 9 * H }))).toBeNull();
  });

  it('descarta lo que queda fuera del radio de búsqueda de la especie', () => {
    expect(emparejar(perdido(), encontrado({ lat: 41 }))).toBeNull();
  });

  it('descarta una coincidencia por debajo del puntaje mínimo', () => {
    const flojo = encontrado({
      lat: 40.007186,
      color: 'atigrado',
      sexo: 'hembra',
      raza: 'beagle',
      collar: 'azul'
    });
    expect(emparejar(perdido(), flojo)).toBeNull();
  });

  it('el mínimo se puede bajar por opciones', () => {
    const flojo = encontrado({
      lat: 40.007186,
      color: 'atigrado',
      sexo: 'hembra',
      raza: 'beagle',
      collar: 'azul'
    });
    const m = emparejar(perdido(), flojo, { puntajeMinimo: 43 });
    expect(m.puntaje).toBe(43);
    expect(m.motivos).toEqual(['Mismo tipo de mascota', 'A 0.8 km', 'Fechas compatibles']);
  });

  it('un color parecido suma menos que uno igual y se explica', () => {
    const m = emparejar(perdido(), encontrado({ color: 'blanco' }), { puntajeMinimo: 0 });
    expect(m.puntaje).toBe(
      PESO_TIPO + PESO_DISTANCIA_MAX + PESO_COLOR_PARCIAL + PESO_SEXO + PESO_RAZA + PESO_COLLAR + PESO_TIEMPO
    );
    expect(m.motivos).toContain('Color parecido');
    expect(m.motivos).not.toContain('Mismo color');
  });

  it('si un lado no declara color, no suma ni rompe', () => {
    expect(emparejar(perdido({ color: '' }), encontrado(), { puntajeMinimo: 0 }).puntaje).toBe(80);
    expect(emparejar(perdido(), encontrado({ color: '' }), { puntajeMinimo: 0 }).puntaje).toBe(80);
  });

  it('una distancia intermedia suma 18 puntos', () => {
    const ave = perdido({ tipo: 'ave', perdido_hace_horas: 24 });
    const e = encontrado({ tipo: 'ave', lat: 40.0072 });
    const m = emparejar(ave, e, { puntajeMinimo: 0 });
    expect(m.puntaje).toBe(93);
    expect(m.motivos).toContain('A 0.8 km');
  });

  it('sexo desconocido en un lado es neutro (5 puntos)', () => {
    expect(emparejar(perdido(), encontrado({ sexo: '' }), { puntajeMinimo: 0 }).puntaje).toBe(95);
  });

  it('raza desconocida en un lado es neutra (4 puntos)', () => {
    expect(emparejar(perdido(), encontrado({ raza: '' }), { puntajeMinimo: 0 }).puntaje).toBe(96);
  });

  it('si los dos avisos no tienen collar es neutro (2 puntos)', () => {
    const m = emparejar(perdido({ collar: '' }), encontrado({ collar: '' }), { puntajeMinimo: 0 });
    expect(m.puntaje).toBe(98);
    expect(m.motivos).not.toContain('Mismo collar');
  });

  it('collar distinto no suma', () => {
    expect(emparejar(perdido(), encontrado({ collar: 'azul' }), { puntajeMinimo: 0 }).puntaje).toBe(96);
  });

  it('una fecha lejana resta 2 puntos respecto a la compatible', () => {
    const perdidoEn = T0 - 2 * H;
    const m = emparejar(perdido(), encontrado({ created_at: perdidoEn + 31 * 24 * H }), {
      puntajeMinimo: 0
    });
    expect(m.puntaje).toBe(98);
    expect(m.motivos).not.toContain('Fechas compatibles');
  });

  it('sin "perdido_hace_horas" estima las horas desde created_at y ahora', () => {
    const ahora = T0 + 24 * H;
    const p = perdido({ perdido_hace_horas: null, created_at: T0 });
    const e = encontrado({ perdido_hace_horas: null, created_at: T0, lat: 40.01779 });
    const m = emparejar(p, e, { ahora });
    expect(m.distancia_km).toBe(2);
  });

  it('con created_at inválido no explota: radio mínimo de la especie', () => {
    const p = perdido({ perdido_hace_horas: null, created_at: 'no-es-fecha' });
    const e = encontrado({ perdido_hace_horas: null, created_at: 0, lat: 40.007186 });
    const m = emparejar(p, e, { ahora: T0, puntajeMinimo: 0 });
    expect(m.puntaje).toBe(85);
  });

  it('el gato nunca baja del radio mínimo', () => {
    const g = perdido({ tipo: 'gato', perdido_hace_horas: 0, created_at: T0 });
    const e = encontrado({ tipo: 'gato', perdido_hace_horas: 0, created_at: T0, lat: 40.007186 });
    const m = emparejar(g, e, { ahora: T0, puntajeMinimo: 0 });
    expect(RADIO_MINIMO_KM).toBe(1);
    expect(m.puntaje).toBe(
      PESO_TIPO + 10 + PESO_COLOR_EXACTO + PESO_SEXO + PESO_RAZA + PESO_COLLAR + PESO_TIEMPO
    );
  });

  it('el ave tampoco supera el radio tope aunque pasen años', () => {
    const a = perdido({ tipo: 'ave', perdido_hace_horas: 10000 });
    const dentro = encontrado({ tipo: 'ave', perdido_hace_horas: 10000, lat: 40.04 });
    const fuera = encontrado({ tipo: 'ave', perdido_hace_horas: 10000, lat: 40.05 });
    expect(RADIO_TOPE_KM).toBe(5);
    expect(emparejar(a, dentro, { puntajeMinimo: 0 })).not.toBeNull();
    expect(emparejar(a, fuera, { puntajeMinimo: 0 })).toBeNull();
  });
});

describe('regla dura del microchip', () => {
  it('el mismo chip empareja aunque el aviso esté a 500 km', () => {
    const m = emparejar(perdido({ chip_hash: HUELLA_A }), encontrado({ chip_hash: HUELLA_A, lat: 45 }));
    expect(m).not.toBeNull();
    expect(m.puntaje).toBe(PUNTAJE_CHIP);
    expect(m.distancia_km).toBeGreaterThan(500);
    expect(m.motivos[0]).toBe('Coincidencia por microchip');
  });

  it('el chip manda sobre el tipo declarado', () => {
    const m = emparejar(perdido({ chip_hash: HUELLA_A }), encontrado({ chip_hash: HUELLA_A, tipo: 'gato' }));
    expect(m).not.toBeNull();
    expect(m.motivos).not.toContain('Mismo tipo de mascota');
  });

  it('el chip manda sobre las fechas: un "encontrado" muy anterior sigue valiendo', () => {
    const m = emparejar(
      perdido({ chip_hash: HUELLA_A }),
      encontrado({ chip_hash: HUELLA_A, created_at: T0 - 900 * H })
    );
    expect(m).not.toBeNull();
    expect(m.motivos).not.toContain('Fechas compatibles');
  });

  it('el chip no se puede filtrar subiendo el puntaje mínimo', () => {
    const m = emparejar(perdido({ chip_hash: HUELLA_A }), encontrado({ chip_hash: HUELLA_A, lat: 45 }), {
      puntajeMinimo: 1000
    });
    expect(m.puntaje).toBe(PUNTAJE_CHIP);
  });

  it('explica también la distancia cuando es finita', () => {
    const m = emparejar(perdido({ chip_hash: HUELLA_A }), encontrado({ chip_hash: HUELLA_A }));
    expect(m.motivos).toEqual(['Coincidencia por microchip', 'A menos de 500 m']);
  });

  it('chips distintos no emparejan: vuelve a mandar la distancia', () => {
    expect(
      emparejar(perdido({ chip_hash: HUELLA_A }), encontrado({ chip_hash: HUELLA_B, lat: 45 }))
    ).toBeNull();
  });

  it('con un solo lado declarando chip manda la regla normal', () => {
    expect(emparejar(perdido({ chip_hash: HUELLA_A }), encontrado({ lat: 45 }))).toBeNull();
    expect(emparejar(perdido({}), encontrado({ chip_hash: HUELLA_A, lat: 45 }))).toBeNull();
  });

  it('un chip vacío o nulo no empareja con otro vacío', () => {
    expect(emparejar(perdido({ chip_hash: '' }), encontrado({ chip_hash: '' }))).not.toBeNull();
    expect(emparejar(perdido({ chip_hash: null }), encontrado({ chip_hash: null, tipo: 'ave' }))).toBeNull();
    expect(emparejar(perdido({ chip_hash: undefined }), encontrado({ chip_hash: '' }))).not.toBeNull();
  });

  it('el mismo chip no salta la regla del estado opuesto', () => {
    expect(emparejar(perdido({ chip_hash: HUELLA_A }), perdido({ chip_hash: HUELLA_A }))).toBeNull();
  });

  it('la huella se compara sin distinguir mayúsculas', () => {
    const m = emparejar(
      perdido({ chip_hash: HUELLA_A }),
      encontrado({ chip_hash: HUELLA_A.toUpperCase(), lat: 45 })
    );
    expect(m.puntaje).toBe(PUNTAJE_CHIP);
  });

  it('buscarCoincidencias pone primero la del chip aunque esté lejísimos', () => {
    const porChip = encontrado({ id: 'chip', chip_hash: HUELLA_A, lat: 45 });
    const perfecto = encontrado({ id: 'perfecto' });
    const r = buscarCoincidencias(perdido({ chip_hash: HUELLA_A }), [perfecto, porChip]);
    expect(r.map(m => m.id)).toEqual(['chip', 'perfecto']);
    expect(PUNTAJE_CHIP).toBe(100);
  });
});

describe('buscarCoincidencias', () => {
  it('sin lista de candidatos devuelve vacío', () => {
    expect(buscarCoincidencias(perdido(), null)).toEqual([]);
    expect(buscarCoincidencias(perdido(), 'nope')).toEqual([]);
  });

  it('ordena por puntaje de mayor a menor', () => {
    const c1 = encontrado({ id: 'perfecto' });
    const c2 = encontrado({ id: 'sexo-desconocido', sexo: '' });
    const c3 = encontrado({ id: 'color-parecido', color: 'blanco' });
    const r = buscarCoincidencias(perdido(), [c3, c1, c2]);
    expect(r.map(m => m.id)).toEqual(['perfecto', 'sexo-desconocido', 'color-parecido']);
  });

  it('separa los candidatos que emparejan de los que no', () => {
    const bueno = encontrado({ id: 'bueno' });
    const otroTipo = encontrado({ id: 'otro-tipo', tipo: 'gato' });
    const mismoEstado = perdido({ id: 'mismo-estado' });
    const r = buscarCoincidencias(perdido(), [otroTipo, bueno, mismoEstado]);
    expect(r.map(m => m.id)).toEqual(['bueno']);
  });

  it('a igual puntaje gana el más cercano', () => {
    const cerca = encontrado({ id: 'cerca', color: 'blanco' });
    const lejos = encontrado({ id: 'lejos', color: 'blanco', lat: 40.003 });
    const r = buscarCoincidencias(perdido(), [lejos, cerca]);
    expect(r.map(m => m.id)).toEqual(['cerca', 'lejos']);
  });

  it('respeta el límite indicado', () => {
    const lista = [encontrado({ id: 'a' }), encontrado({ id: 'b' }), encontrado({ id: 'c' })];
    expect(buscarCoincidencias(perdido(), lista, { limite: 2 })).toHaveLength(2);
  });

  it('un límite inválido cae al valor por defecto (20)', () => {
    const lista = Array.from({ length: 25 }, (_, i) => encontrado({ id: 'e' + i }));
    expect(buscarCoincidencias(perdido(), lista, { limite: 0 })).toHaveLength(20);
    expect(buscarCoincidencias(perdido(), lista, { limite: null })).toHaveLength(20);
  });
});
