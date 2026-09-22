// Pruebas de backend/src/v2/geo.js.
//
// Lo que se protege aquí no es "el número", sino la RELACIÓN entre la constante
// y haversine: el cuadro que se calcula con KM_POR_GRADO tiene que CONTENER el
// círculo del radio, porque después matching.js filtra por distancia real. Si el
// cuadro vuelve a quedar más estrecho, se pierden coincidencias en silencio.
import { describe, it, expect } from 'vitest';
import { KM_POR_GRADO, COS_MINIMO } from '../src/v2/geo.js';

// Misma fórmula que matching.js, escrita aquí a propósito para que la prueba no
// se valide contra el propio código que vigila.
function distanciaKm(lat1, lng1, lat2, lng2) {
  const rad = grados => (grados * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

describe('KM_POR_GRADO', () => {
  it('vale lo que da el radio terrestre que usa haversine (no un número a mano)', () => {
    expect(KM_POR_GRADO).toBeCloseTo(111.19492664455873, 10);
  });

  it('es algo menor que 111,32: el desajuste que estrechaba el cuadro', () => {
    expect(KM_POR_GRADO).toBeLessThan(111.32);
  });
});

describe('COS_MINIMO', () => {
  it('acota el coseno para que el cuadro no se dispare en latitudes polares', () => {
    expect(COS_MINIMO).toBe(0.1);
    expect(COS_MINIMO).toBeGreaterThan(0);
    expect(COS_MINIMO).toBeLessThan(1);
  });
});

describe('el cuadro cubre el radio (la razón de ser de la constante)', () => {
  // Un candidato justo en el borde del radio tiene que caer DENTRO del cuadro;
  // si el cuadro se calcula con un KM_POR_GRADO mayor, queda fuera y se pierde.
  it.each([
    ['ecuador', 0, 0],
    ['Santiago', -33.45, -70.66],
    ['latitud alta', 60, 10]
  ])('a %s, un punto en el borde del radio cae dentro del cuadro', (_nombre, lat, lng) => {
    const radio = 5;
    const dLat = radio / KM_POR_GRADO;

    // El punto más al norte del círculo (a radio km en línea recta hacia el norte).
    const latBorde = lat + radio / 111.19492664455873;

    expect(distanciaKm(lat, lng, latBorde, lng)).toBeCloseTo(radio, 6);
    expect(latBorde).toBeLessThanOrEqual(lat + dLat);
  });

  it('un punto en el borde este del círculo también cae dentro del cuadro', () => {
    const radio = 5;
    const lat = -33.45;
    const lng = -70.66;
    const dLng = radio / (KM_POR_GRADO * Math.max(COS_MINIMO, Math.cos((lat * Math.PI) / 180)));

    // Se avanza en longitud hasta que la distancia real sea el radio.
    const cos = Math.cos((lat * Math.PI) / 180);
    const lngBorde = lng + radio / (111.19492664455873 * cos);

    expect(distanciaKm(lat, lng, lat, lngBorde)).toBeCloseTo(radio, 6);
    expect(lngBorde).toBeLessThanOrEqual(lng + dLng);
  });
});
