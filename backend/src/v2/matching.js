// matching.js
// Motor de coincidencias perdido <-> encontrado.
//
// Es lógica PURA: no toca base de datos ni red. Recibe el aviso de referencia y
// una lista de candidatos y devuelve los que probablemente sean la misma
// mascota, ordenados por puntaje. La integración (leer de Postgres y avisar por
// push) se hace fuera, en la ruta; aquí solo se decide y se explica el porqué.
//
// Reglas duras (si no se cumplen, no hay coincidencia):
//   * estado opuesto (un "perdido" contra un "encontrado"),
//   * mismo tipo de mascota,
//   * el aviso de "encontrado" no puede ser anterior al momento de la pérdida,
//   * la distancia no puede superar el radio de búsqueda de la especie.
// Lo demás (color, sexo, raza, collar, tiempo) suma puntos y se explica en
// `motivos`, para que el usuario entienda por qué se le sugiere esa coincidencia.
'use strict';

const { radioBusquedaKm } = require('../../busqueda');

const PESO_TIPO = 30;
const PESO_DISTANCIA_MAX = 25;
const PESO_COLOR_EXACTO = 20;
const PESO_COLOR_PARCIAL = 12;
const PESO_SEXO = 10;
const PESO_RAZA = 8;
const PESO_COLLAR = 4;
const PESO_TIEMPO = 3;
// El mismo microchip es la prueba más fuerte que existe: dos avisos que lo
// declaran son el mismo animal. Puntúa como una coincidencia perfecta, pero
// además lleva `por_chip` para ordenarse siempre por delante.
const PUNTAJE_CHIP = 100;
const PUNTAJE_MINIMO = 50;
const RADIO_MINIMO_KM = 1;
const RADIO_TOPE_KM = 5;
const TOLERANCIA_HORAS = 6;
const MS_HORA = 60 * 60 * 1000;
const DIAS_30 = 30 * 24 * MS_HORA;

// Quita acentos, mayúsculas y espacios de más para comparar texto de usuario.
function normalizar(valor) {
  return String(valor == null ? '' : valor)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

// Fórmula de Haversine: distancia en km entre dos coordenadas.
function distanciaKm(lat1, lng1, lat2, lng2) {
  const rad = grados => (grados * Math.PI) / 180;
  const dLat = rad(Number(lat2) - Number(lat1));
  const dLng = rad(Number(lng2) - Number(lng1));
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(Number(lat1))) * Math.cos(rad(Number(lat2))) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

function tokens(valor) {
  return normalizar(valor)
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function puntosColor(a, b) {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (!na || !nb) return 0;
  if (na === nb) return PESO_COLOR_EXACTO;
  const tb = tokens(nb);
  let coincide = false;
  for (const t of tokens(na)) {
    if (tb.includes(t)) coincide = true;
  }
  return coincide ? PESO_COLOR_PARCIAL : 0;
}

function puntosSexo(a, b) {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (na && nb && na === nb) return PESO_SEXO;
  if (!na || !nb) return 5;
  return 0;
}

function puntosRaza(a, b) {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (na && nb && na === nb) return PESO_RAZA;
  if (!na || !nb) return 4;
  return 0;
}

function puntosCollar(a, b) {
  const na = normalizar(a);
  const nb = normalizar(b);
  if (!na && !nb) return 2;
  if (na && nb && na === nb) return PESO_COLLAR;
  return 0;
}

// Horas que lleva perdida la mascota. Si no se declararon, se estiman desde la
// fecha de creación del aviso (un aviso "perdido" se crea al perderla).
function horasPerdido(perdido, ahora) {
  const horas = Number(perdido.perdido_hace_horas);
  if (Number.isFinite(horas) && horas > 0) return horas;
  const creado = Number(perdido.created_at);
  if (!Number.isFinite(creado)) return 0;
  return Math.max(0, (ahora - creado) / MS_HORA);
}

function inicioPerdida(perdido, ahora) {
  const creado = Number(perdido.created_at) || 0;
  return creado - horasPerdido(perdido, ahora) * MS_HORA;
}

// Devuelve los puntos por fecha, o null si el "encontrado" es tan anterior a la
// pérdida que no puede ser esa mascota (con 6 h de tolerancia por relojes).
function puntosTiempo(perdido, encontrado, ahora) {
  const perdidoEn = inicioPerdida(perdido, ahora);
  const encontradoEn = Number(encontrado.created_at) || 0;
  if (encontradoEn < perdidoEn - TOLERANCIA_HORAS * MS_HORA) return null;
  return encontradoEn - perdidoEn <= DIAS_30 ? PESO_TIEMPO : 1;
}

function radioKm(perdido, ahora) {
  const base = radioBusquedaKm(perdido.tipo, horasPerdido(perdido, ahora));
  return Math.min(RADIO_TOPE_KM, Math.max(RADIO_MINIMO_KM, base));
}

function puntosDistancia(dist, radio) {
  if (dist <= 0.5) return PESO_DISTANCIA_MAX;
  if (dist <= radio / 2) return 18;
  return 10;
}

function esPar(base, candidato) {
  if (!base || !candidato) return false;
  if (normalizar(base.estado) === normalizar(candidato.estado)) return false;
  // El chip manda sobre el tipo declarado: si es el mismo animal, da igual que
  // alguien haya puesto "gato" donde iba "perro".
  if (mismoChip(base, candidato)) return true;
  const tipo = normalizar(base.tipo);
  return Boolean(tipo) && tipo === normalizar(candidato.tipo);
}

// ¿Los dos avisos declaran el MISMO microchip? Solo se compara la huella: el
// número del chip no llega nunca a este módulo ni sale de la base de datos.
// Un lado sin chip no puede coincidir "por vacío".
function mismoChip(a, b) {
  const ha = normalizar(a.chip_hash);
  const hb = normalizar(b.chip_hash);
  return Boolean(ha) && ha === hb;
}

// El aviso de referencia puede ser el "perdido" o el "encontrado"; aquí se
// orienta la pareja para razonar siempre igual.
function orientar(a, b) {
  return normalizar(a.estado) === 'perdido' ? { perdido: a, encontrado: b } : { perdido: b, encontrado: a };
}

function textoDistancia(dist) {
  if (dist <= 0.5) return 'A menos de 500 m';
  return `A ${Math.round(dist * 10) / 10} km`;
}

function motivos(d) {
  const lista = ['Mismo tipo de mascota', textoDistancia(d.dist)];
  if (d.pColor === PESO_COLOR_EXACTO) lista.push('Mismo color');
  else if (d.pColor === PESO_COLOR_PARCIAL) lista.push('Color parecido');
  if (d.pSexo === PESO_SEXO) lista.push('Mismo sexo');
  if (d.pRaza === PESO_RAZA) lista.push('Misma raza');
  if (d.pCollar === PESO_COLLAR) lista.push('Mismo collar');
  if (d.pTiempo === PESO_TIEMPO) lista.push('Fechas compatibles');
  return lista;
}

// Coincidencia por microchip: inmediata. No se mira radio, ni fecha, ni puntaje
// mínimo; solo se calcula la distancia para poder mostrarla. Nunca incluye el
// número del chip, solo el motivo.
function coincidenciaPorChip(candidato, dist) {
  return {
    id: candidato.id,
    puntaje: PUNTAJE_CHIP,
    distancia_km: Math.round(dist * 10) / 10,
    por_chip: true,
    motivos: ['Coincidencia por microchip', textoDistancia(dist)]
  };
}

/**
 * Compara dos avisos y devuelve la coincidencia puntuada, o null si no aplica.
 * @param {object} base aviso de referencia
 * @param {object} candidato posible pareja
 * @param {{ahora?:number, puntajeMinimo?:number}} [opciones]
 */
function emparejar(base, candidato, opciones) {
  const op = opciones || {};
  if (!esPar(base, candidato)) return null;

  const { perdido, encontrado } = orientar(base, candidato);
  const ahora = Number.isFinite(op.ahora) ? op.ahora : Date.now();
  const dist = distanciaKm(perdido.lat, perdido.lng, encontrado.lat, encontrado.lng);

  // Va antes que todo lo demás a propósito: el chip no se filtra ni por fecha ni
  // por distancia ni por puntaje mínimo.
  if (mismoChip(base, candidato)) return coincidenciaPorChip(candidato, dist);

  const pTiempo = puntosTiempo(perdido, encontrado, ahora);
  if (pTiempo === null) return null;

  const radio = radioKm(perdido, ahora);
  if (dist > radio) return null;

  const pDist = puntosDistancia(dist, radio);
  const pColor = puntosColor(perdido.color, encontrado.color);
  const pSexo = puntosSexo(perdido.sexo, encontrado.sexo);
  const pRaza = puntosRaza(perdido.raza, encontrado.raza);
  const pCollar = puntosCollar(perdido.collar, encontrado.collar);
  const puntaje = PESO_TIPO + pDist + pColor + pSexo + pRaza + pCollar + pTiempo;

  const minimo = Number.isFinite(op.puntajeMinimo) ? op.puntajeMinimo : PUNTAJE_MINIMO;
  if (puntaje < minimo) return null;

  return {
    id: candidato.id,
    puntaje,
    distancia_km: Math.round(dist * 10) / 10,
    motivos: motivos({ pDist, pColor, pSexo, pRaza, pCollar, pTiempo, dist })
  };
}

// 1 si la coincidencia es por microchip. Sirve para que el chip gane el
// desempate contra una coincidencia perfecta (las dos puntúan 100).
function prioridad(m) {
  return m.por_chip ? 1 : 0;
}

/**
 * Ordena por puntaje (mayor primero) y, a igualdad, por cercanía.
 * @param {object} base aviso de referencia
 * @param {object[]} candidatos
 * @param {{ahora?:number, puntajeMinimo?:number, limite?:number}} [opciones]
 */
function buscarCoincidencias(base, candidatos, opciones) {
  const op = opciones || {};
  const lista = Array.isArray(candidatos) ? candidatos : [];
  const limite = Number.isInteger(op.limite) && op.limite > 0 ? op.limite : 20;
  return lista
    .map(c => emparejar(base, c, op))
    .filter(Boolean)
    .sort((a, b) => prioridad(b) - prioridad(a) || b.puntaje - a.puntaje || a.distancia_km - b.distancia_km)
    .slice(0, limite);
}

module.exports = {
  normalizar,
  distanciaKm,
  emparejar,
  buscarCoincidencias,
  PUNTAJE_MINIMO,
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
};
