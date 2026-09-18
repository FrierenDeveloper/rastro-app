// busqueda.js
// Estima en cuánto se aleja una mascota perdida según el tiempo transcurrido,
// para sugerir un radio de búsqueda y de alertas razonable.
//
// Base (rangos publicados en la literatura de mascotas perdidas; NO es una
// búsqueda en vivo, son las cifras que suelen citarse):
//   - Perros: la mayoría aparece relativamente cerca, con una mediana en torno
//     a 1 km del lugar donde se perdió; unos pocos recorren varios km.
//   - Gatos: tienden a esconderse muy cerca (cientos de metros, a veces la
//     misma manzana), aunque pueden alejarse algo con los días.
//
// El radio crece con la RAÍZ del tiempo, que es como se dispersa un
// desplazamiento aleatorio (caminata aleatoria): al principio crece rápido y
// después se estanca. Eso evita prometer radios enormes a los pocos días.
//
// Los valores son deliberadamente conservadores y fáciles de ajustar.
const PERFIL = {
  perro:  { base: 0.5, crece: 1.20, tope: 10.0 },
  gato:   { base: 0.2, crece: 0.15, tope: 1.5 },
  ave:    { base: 0.3, crece: 0.20, tope: 2.0 },
  conejo: { base: 0.3, crece: 0.20, tope: 1.5 },
  otro:   { base: 0.5, crece: 0.80, tope: 8.0 }
};

/**
 * @param {string} tipo  perro | gato | ave | conejo | otro
 * @param {number} horas horas transcurridas desde que se perdió
 * @returns {number} radio sugerido en km (1 decimal)
 */
function radioBusquedaKm(tipo, horas) {
  const p = PERFIL[tipo] || PERFIL.otro;
  const dias = Math.max(0, Number(horas) || 0) / 24;
  const km = p.base + p.crece * Math.sqrt(dias);
  return Math.round(Math.min(p.tope, km) * 10) / 10;
}

module.exports = { radioBusquedaKm };
