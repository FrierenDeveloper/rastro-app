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
