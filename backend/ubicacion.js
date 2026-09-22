// ubicacion.js
// Vigencia de la última ubicación conocida de una cuenta.
//
// Cómo se usa la ubicación (y por qué esto existe):
//   * La app guarda sola, al abrirse, un punto aproximado de donde está el
//     usuario (difuminado ~300 m en el cliente) para poder avisarle de mascotas
//     perdidas cerca. Eso es "origen auto".
//   * El usuario también puede fijar su barrio a mano ("origen manual"): esa
//     zona es una intención explícita y NO caduca, y la ubicación automática
//     nunca la pisa.
//   * Un punto automático de hace meses ya no dice nada de dónde está esa
//     persona: avisarle sería ruido. De ahí la vigencia.
'use strict';

const DIAS_VIGENTE = 30;
const MS_DIA = 24 * 60 * 60 * 1000;

// Instante (ms) a partir del cual una ubicación todavía cuenta.
function desdeCuandoVale(ahora) {
  return Number(ahora) - DIAS_VIGENTE * MS_DIA;
}

module.exports = { DIAS_VIGENTE, MS_DIA, desdeCuandoVale };
