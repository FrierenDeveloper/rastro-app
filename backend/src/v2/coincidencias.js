// coincidencias.js
// Puente entre el motor de emparejamiento (matching.js) y la ruta de avisos.
//
// Sigue siendo lógica PURA: no toca base de datos ni red. Recibe el aviso de
// referencia y los candidatos que la ruta ya trajo de Postgres, y devuelve a
// quién hay que avisar. Así la decisión de "esto es la misma mascota" se prueba
// sin dobles y la ruta solo se ocupa de consultar y enviar el push.
'use strict';

const { buscarCoincidencias, RADIO_TOPE_KM } = require('./matching');
const { esDuplicado } = require('./phash');
const { KM_POR_GRADO, COS_MINIMO } = require('./geo');

// Caja geográfica (bounding box) que cubre el radio máximo de emparejamiento.
// Sirve para no recorrer toda la tabla: primero se filtra por el cuadro y luego
// matching.js decide con la distancia real.
function cajaBusqueda(lat, lng, km) {
  const radio = Number.isFinite(km) && km > 0 ? km : RADIO_TOPE_KM;
  const dLat = radio / KM_POR_GRADO;
  const dLng = radio / (KM_POR_GRADO * Math.max(COS_MINIMO, Math.cos((Number(lat) * Math.PI) / 180)));
  return {
    latMin: Number(lat) - dLat,
    latMax: Number(lat) + dLat,
    lngMin: Number(lng) - dLng,
    lngMax: Number(lng) + dLng
  };
}

// Coincidencias cuyo aviso pertenece a OTRA cuenta, con el dueño adjunto.
// Si alguien publicó varios avisos parecidos, solo se le avisa una vez: se
// conserva el de mayor puntaje (la lista ya viene ordenada).
function coincidenciasDeOtros(base, candidatos, opciones) {
  const lista = Array.isArray(candidatos) ? candidatos : [];
  const porId = new Map(lista.map(c => [c.id, c]));
  const vistos = new Set();
  return buscarCoincidencias(base, lista, opciones)
    .map(m => ({ ...m, user_id: porId.get(m.id).user_id }))
    .filter(m => m.user_id && m.user_id !== base.user_id)
    .filter(m => {
      if (vistos.has(m.user_id)) return false;
      vistos.add(m.user_id);
      return true;
    });
}

// Avisos de otra cuenta cuya foto es (casi) la misma. Detecta publicaciones
// repetidas aunque la imagen se haya recortado o recomprimido.
function duplicadosDeFoto(base, candidatos, opciones) {
  const op = opciones || {};
  if (!base || !base.foto_hash) return [];
  const lista = Array.isArray(candidatos) ? candidatos : [];
  return lista
    .filter(c => c && c.id !== base.id && c.user_id !== base.user_id && c.foto_hash)
    .filter(c => esDuplicado(base.foto_hash, c.foto_hash, op.umbralDuplicado))
    .map(c => ({ id: c.id, user_id: c.user_id }));
}

module.exports = {
  cajaBusqueda,
  coincidenciasDeOtros,
  duplicadosDeFoto,
  KM_POR_GRADO,
  COS_MINIMO
};
