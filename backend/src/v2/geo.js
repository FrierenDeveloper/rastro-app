// geo.js
// Constantes y utilidades geográficas COMPARTIDAS.
//
// Por qué existe este archivo: el cuadro de búsqueda (bounding box) se calculaba
// con 111,32 km por grado, mientras que la distancia real se decide con
// haversine sobre un radio de 6371 km, que da 111,19493 km por grado. El cuadro
// salía ~0,11 % más pequeño que el radio, así que un aviso que estaba justo en
// el borde del radio quedaba fuera del cuadro y nunca llegaba a compararse:
// la coincidencia se perdía en silencio.
//
// Con una sola constante, el cuadro siempre CONTIENE el círculo del radio, que
// es lo que el filtro necesita para no descartar candidatos válidos.
'use strict';

// Kilómetros que abarca un grado de latitud: 2*PI*6371/360.
//
// Se deriva del mismo radio (6371) que usa haversine en vez de escribirlo a
// mano: así no pueden volver a separarse. Ojo, es a propósito el valor del
// ecuador; para la longitud se corrige con el coseno de la latitud.
const KM_POR_GRADO = (2 * Math.PI * 6371) / 360;

// En latitudes polares el coseno tiende a 0 y el cuadro se dispararía sin
// limite; se acota para que la consulta siga siendo razonable.
const COS_MINIMO = 0.1;

module.exports = { KM_POR_GRADO, COS_MINIMO };
