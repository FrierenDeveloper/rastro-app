// Pruebas unitarias de la lógica de búsqueda (backend/busqueda.js).
//
// Este archivo es INFRAESTRUCTURA DE VALIDACIÓN: no modifica ni depende del
// código de la aplicación. Es el punto de partida de la suite unitaria; el
// objetivo de la ley es que todo lo que exige el 100% de cobertura tenga
// pruebas como estas.
import { describe, it, expect } from 'vitest';
import busqueda from '../busqueda.js';

const { radioBusquedaKm, curvaRadio, sugerenciaBusqueda, PERFIL, FUENTES } = busqueda;

describe('radioBusquedaKm', () => {
  it('el gato arranca en la mediana publicada (50 m)', () => {
    expect(radioBusquedaKm('gato', 0)).toBeCloseTo(0.05, 5);
  });

  it('el perro arranca en el radio típico citado (400 m)', () => {
    expect(radioBusquedaKm('perro', 0)).toBeCloseTo(0.4, 5);
  });

  it('crece con el tiempo y nunca decrece', () => {
    const horas = [0, 1, 6, 24, 72, 336];
    const valores = horas.map(h => radioBusquedaKm('perro', h));
    for (let i = 1; i < valores.length; i++) expect(valores[i]).toBeGreaterThanOrEqual(valores[i - 1]);
  });

  it('el gato siempre se sugiere más cerca que el perro', () => {
    for (const h of [0, 6, 48, 336]) {
      expect(radioBusquedaKm('gato', h)).toBeLessThan(radioBusquedaKm('perro', h));
    }
  });

  it('respeta el tope de cada especie aunque pasen años', () => {
    for (const tipo of Object.keys(PERFIL)) {
      expect(radioBusquedaKm(tipo, 999999)).toBeLessThanOrEqual(PERFIL[tipo].tope);
    }
  });

  it('un tipo desconocido cae en el perfil por defecto', () => {
    expect(radioBusquedaKm('inventado', 24)).toBe(radioBusquedaKm('otro', 24));
  });

  it('horas negativas, texto o nulo no rompen: usan el mínimo', () => {
    expect(radioBusquedaKm('perro', -5)).toBe(PERFIL.perro.base);
    expect(radioBusquedaKm('perro', 'no-es-un-numero')).toBe(PERFIL.perro.base);
    expect(radioBusquedaKm('perro', null)).toBe(PERFIL.perro.base);
  });

  it('devuelve como máximo 2 decimales (50 m importan)', () => {
    const valor = radioBusquedaKm('gato', 7);
    expect(valor).toBe(Math.round(valor * 100) / 100);
  });
});

describe('curvaRadio', () => {
  it('devuelve un punto más que pasos, de 0 al máximo', () => {
    const curva = curvaRadio('perro', 72, 24);
    expect(curva).toHaveLength(25);
    expect(curva[0].horas).toBe(0);
    expect(curva[curva.length - 1].horas).toBe(72);
  });

  it('cada punto coincide con la fórmula directa', () => {
    for (const punto of curvaRadio('gato', 48, 8)) {
      expect(punto.km).toBe(radioBusquedaKm('gato', punto.horas));
    }
  });
});

describe('sugerenciaBusqueda', () => {
  it('para el gato sugiere en metros', () => {
    const s = sugerenciaBusqueda('gato', 6);
    expect(s.texto).toMatch(/unos \d+ m/);
    expect(s.metros).toBeGreaterThan(0);
  });

  it('para el perro, con tiempo, sugiere en kilómetros', () => {
    const s = sugerenciaBusqueda('perro', 72);
    expect(s.texto).toMatch(/unos [\d.]+ km/);
    expect(s.metros).toBeNull();
  });

  it('el consejo del gato cambia según si ya está dentro de los 500 m', () => {
    // A pocas horas el radio todavía está dentro de los 500 m del estudio.
    const cerca = sugerenciaBusqueda('gato', 6);
    expect(cerca.consejo).toMatch(/esconden muy cerca/i);

    // Pasados varios días el radio supera esos 500 m y el consejo lo explica.
    expect(sugerenciaBusqueda('gato', 6).km).toBeLessThanOrEqual(0.5);
    const lejos = sugerenciaBusqueda('gato', 200);
    expect(lejos.km).toBeGreaterThan(0.5);
    expect(lejos.consejo).toMatch(/75%/);
    expect(lejos.consejo).toMatch(/500 m/);
  });

  it('el consejo del perro cambia según cuánto lleva perdido', () => {
    const temprano = sugerenciaBusqueda('perro', 2).consejo;
    const tarde = sugerenciaBusqueda('perro', 200).consejo;
    expect(temprano).not.toBe(tarde);
    expect(tarde).toMatch(/refugio/i);
  });

  it('una especie rara devuelve un consejo genérico, no vacío', () => {
    expect(sugerenciaBusqueda('ave', 3).consejo.length).toBeGreaterThan(10);
  });

  it('adjunta las fuentes para que se puedan citar', () => {
    expect(sugerenciaBusqueda('gato', 1).fuentes).toHaveLength(FUENTES.length);
  });
});

// ---------------------------------------------------------------------------
// Bordes EXACTOS de los umbrales de sugerenciaBusqueda (líneas 110-135).
//
// Estos casos existen para matar los mutantes de comparación: un mutante
// `<=` -> `<` (o `>`), o un `km < 1` -> `km <= 1`, solo se nota cuando el valor
// cae JUSTO en el umbral (km = 1, km = 0.5, h = 12). A propósito se afirma el
// texto COMPLETO del consejo y de la sugerencia: así también caen los mutantes
// que vacían una plantilla de texto (que un `length > 10` no distingue).
//
// AQUÍ VIVÍAN LOS "MUTANTES EQUIVALENTES": el ternario `nombre` se calculaba y
// no se leía en ninguna parte ni se devolvía. Se comprobó comparando el objeto
// devuelto completo entre el original y 12 versiones mutadas de esa línea sobre
// 11 tipos x 21 valores de horas (231 casos): las 12 daban 0 diferencias, así
// que ningún test podía matarlas. En vez de forzar una prueba se eliminó el
// código muerto, y con él sus 11 mutantes (que ya no se generan).
// ---------------------------------------------------------------------------
describe('sugerenciaBusqueda: bordes exactos de los umbrales', () => {
  it('con km exactamente 1 la sugerencia ya va en km, no en metros', () => {
    const s = sugerenciaBusqueda('gato', 347);
    expect(s.km).toBe(1);
    expect(s.metros).toBeNull();
    expect(s.texto).toBe('Busca en un radio de unos 1 km a la redonda.');
  });

  it('el umbral de 1 km se cruza exactamente entre 342 y 351 horas', () => {
    const abajo = sugerenciaBusqueda('gato', 342);
    expect(abajo.km).toBe(0.99);
    expect(abajo.metros).toBe(990);
    expect(abajo.texto).toBe('Busca en un radio de unos 990 m a la redonda.');

    const arriba = sugerenciaBusqueda('gato', 351);
    expect(arriba.km).toBe(1.01);
    expect(arriba.metros).toBeNull();
    expect(arriba.texto).toBe('Busca en un radio de unos 1.01 km a la redonda.');
  });

  it('con km exactamente 0.5 el gato sigue con el consejo de "muy cerca"', () => {
    const s = sugerenciaBusqueda('gato', 78);
    expect(s.km).toBe(0.5);
    expect(s.metros).toBe(500);
    expect(s.texto).toBe('Busca en un radio de unos 500 m a la redonda.');
    expect(s.consejo).toBe(
      'Los gatos casi siempre se esconden muy cerca: revisa a fondo tu casa, patios vecinos, debajo de terrazas y autos. No hace falta irte lejos.'
    );
  });

  it('pasados los 0.5 km el gato pasa al consejo de ampliar la búsqueda', () => {
    const s = sugerenciaBusqueda('gato', 80);
    expect(s.km).toBe(0.51);
    expect(s.consejo).toBe(
      'Aunque el 75% de los gatos aparece dentro de 500 m, a estas alturas conviene ampliar un poco: pide a los vecinos que miren sus patios y bodegas.'
    );
  });

  it('a las 12 horas exactas el perro sigue con el consejo de las primeras horas', () => {
    const s = sugerenciaBusqueda('perro', 12);
    expect(s.consejo).toBe(
      'Un perro suele alejarse poco al principio. Pregunta en la calle, revisa refugios y veterinarias cercanas, y reparte carteles: es lo que más rinde.'
    );
  });

  it('a las 13 horas el perro ya pasa al consejo de difusión', () => {
    const s = sugerenciaBusqueda('perro', 13);
    expect(s.consejo).toBe(
      'A estas alturas lo más efectivo es la difusión: refugios, veterinarias, redes del barrio y carteles. Los perros se recuperan sobre todo porque alguien los encuentra y los reporta.'
    );
  });

  it('solo el gato y el perro tienen consejo propio: el resto recibe el genérico', () => {
    const generico =
      'Revisa primero la zona cercana y avisa a los vecinos; después amplía hacia donde haya más gente.';
    for (const tipo of ['ave', 'conejo', 'otro', 'inventado', '', null, undefined]) {
      expect(sugerenciaBusqueda(tipo, 3).consejo).toBe(generico);
    }
  });

  it('el texto en metros lleva la cifra exacta del radio', () => {
    const s = sugerenciaBusqueda('gato', 6);
    expect(s.km).toBe(0.18);
    expect(s.texto).toBe('Busca en un radio de unos 180 m a la redonda.');
  });

  it('el texto en km lleva la cifra exacta del radio', () => {
    const s = sugerenciaBusqueda('perro', 72);
    expect(s.km).toBe(3.17);
    expect(s.texto).toBe('Busca en un radio de unos 3.17 km a la redonda.');
  });
});
