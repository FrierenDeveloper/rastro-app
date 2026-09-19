// busqueda.js
// Radio de búsqueda sugerido según el tiempo que lleva perdida la mascota.
//
// ---------------------------------------------------------------------------
// EN QUÉ SE BASA (datos publicados, no inventados)
// ---------------------------------------------------------------------------
// 1) Gatos — Huang, Coradini, Rand, Morton, Albrecht, Wasson y Robertson (2018),
//    "Search Methods Used to Locate Missing Cats and Locations Where Missing
//    Cats Are Found", Animals 8(1):5. Estudio con 1.210 gatos perdidos:
//      - mediana de distancia al punto de escape: 50 m
//      - 50% encontrados dentro de 50 m; 75% dentro de 500 m
//      - distancia máxima registrada: 1,5 km
//    Es decir: un gato casi nunca se va lejos; se esconde cerca. El error típico
//    es buscar demasiado lejos en vez de mirar a fondo la propia manzana.
//
// 2) Perros — Lord, Wittum, Ferketich, Rajala-Schultz y Funk (2007),
//    JAVMA 230(2):211-216 y 230(12):1835-1841. El 71% de los perros perdidos se
//    recuperó (frente al 53% de los gatos) y, a diferencia de los gatos, solo el
//    8% volvió solo: la mayoría apareció porque alguien lo llevó a un refugio
//    (más de un tercio), porque llevaba chapa (más de un cuarto) o por un cartel
//    en el barrio (15%). Eso significa que para un perro lo que más rinde es la
//    difusión en la zona, no caminar kilómetros.
//
// 3) Perros, distancia concreta — Ignatius (2015), "Distance Traveled by Lost
//    Dogs from Lost Location to Found Location" (tesis de Máster, Saint Mary's
//    University of Minnesota) trabajó con ~400 m (0,25 millas) como radio de
//    búsqueda típico del perro, citando a Lord et al.
//
// ---------------------------------------------------------------------------
// CÓMO SE CONVIERTE ESO EN UN NÚMERO
// ---------------------------------------------------------------------------
// Los estudios dan DISTANCIAS (sobre todo para el momento en que se encontró la
// mascota), no una curva distancia-tiempo: no existe un dato publicado que diga
// "a las 6 horas el perro medio está a X km". Así que la forma de la curva es
// una MODELIZACIÓN nuestra, transparente y conservadora:
//
//   radio(horas) = base + crece * sqrt(horas / 24)      (con un tope por tipo)
//
// La raíz del tiempo es como se dispersa un desplazamiento aleatorio (caminata
// aleatoria): al principio crece rápido y después se estanca. Es a propósito
// conservador: preferimos que alguien revise bien la zona cercana a que se vaya
// a recorrer 20 km.
//
// El valor "base" de cada tipo está anclado a los datos de arriba (gato: 50 m
// de mediana; perro: ~400 m de radio típico). Lo que NO está anclado a un
// estudio es cuánto crece con el tiempo: eso es nuestra estimación.
// ---------------------------------------------------------------------------

const PERFIL = {
  // base: km que se sugieren de entrada (0 h). anclado a la mediana publicada.
  // crece: cuánto se amplía con el tiempo (modelización propia).
  // tope: máximo razonable; más allá no tiene sentido para esa especie.
  gato:   { base: 0.05, crece: 0.25, tope: 1.5 },   // mediana publicada: 50 m
  perro:  { base: 0.40, crece: 1.60, tope: 15.0 },  // radio típico: ~400 m
  ave:    { base: 0.30, crece: 2.00, tope: 30.0 },  // puede volar lejos
  conejo: { base: 0.15, crece: 0.35, tope: 2.0 },
  otro:   { base: 0.30, crece: 1.00, tope: 10.0 }
};

const FUENTES = [
  { cita: 'Huang et al. 2018, Animals 8(1):5', url: 'https://www.mdpi.com/2076-2615/8/1/5', dato: 'gatos: 50% dentro de 50 m, 75% dentro de 500 m' },
  { cita: 'Lord et al. 2007, JAVMA 230(2):211', url: 'https://pubmed.ncbi.nlm.nih.gov/17223753/', dato: 'perros: 71% recuperados; 15% por carteles en el barrio' },
  { cita: 'Ignatius 2015 (tesis, SMUMN)', url: 'http://gis.smumn.edu/GradProjects/IgnatiusA.pdf', dato: 'perros: radio de búsqueda típico ~400 m' }
];

/**
 * Radio sugerido en km.
 * @param {string} tipo  perro | gato | ave | conejo | otro
 * @param {number} horas horas transcurridas desde que se perdió
 */
function radioBusquedaKm(tipo, horas) {
  const p = PERFIL[tipo] || PERFIL.otro;
  const h = Math.max(0, Number(horas) || 0);
  const km = p.base + p.crece * Math.sqrt(h / 24);
  return Math.round(Math.min(p.tope, km) * 100) / 100; // 2 decimales: 50 m importa
}

/**
 * Curva completa para dibujar el gráfico: un punto por tramo de horas.
 * @param {string} tipo
 * @param {number} horasMax hasta cuántas horas dibujar
 * @param {number} pasos cuántos puntos
 * @returns {{horas:number, km:number}[]}
 */
function curvaRadio(tipo, horasMax = 72, pasos = 24) {
  const puntos = [];
  for (let i = 0; i <= pasos; i++) {
    const h = Math.round((horasMax * i) / pasos);
    puntos.push({ horas: h, km: radioBusquedaKm(tipo, h) });
  }
  return puntos;
}

/**
 * Sugerencia en texto para mostrar al usuario.
 */
function sugerenciaBusqueda(tipo, horas) {
  const km = radioBusquedaKm(tipo, horas);
  const metros = km < 1 ? Math.round(km * 1000) : null;
  const h = Math.max(0, Number(horas) || 0);
  const nombre = tipo === 'gato' ? 'tu gato' : tipo === 'perro' ? 'tu perro' : 'tu mascota';

  let consejo;
  if (tipo === 'gato') {
    // Los datos son tajantes: el 75% aparece dentro de 500 m.
    consejo = km <= 0.5
      ? `Los gatos casi siempre se esconden muy cerca: revisa a fondo tu casa, patios vecinos, debajo de terrazas y autos. No hace falta irte lejos.`
      : `Aunque el 75% de los gatos aparece dentro de 500 m, a estas alturas conviene ampliar un poco: pide a los vecinos que miren sus patios y bodegas.`;
  } else if (tipo === 'perro') {
    consejo = h <= 12
      ? `Un perro suele alejarse poco al principio. Pregunta en la calle, revisa refugios y veterinarias cercanas, y reparte carteles: es lo que más rinde.`
      : `A estas alturas lo más efectivo es la difusión: refugios, veterinarias, redes del barrio y carteles. Los perros se recuperan sobre todo porque alguien los encuentra y los reporta.`;
  } else {
    consejo = `Revisa primero la zona cercana y avisa a los vecinos; después amplía hacia donde haya más gente.`;
  }

  return {
    km,
    metros,
    texto: metros
      ? `Busca en un radio de unos ${metros} m a la redonda.`
      : `Busca en un radio de unos ${km} km a la redonda.`,
    consejo,
    fuentes: FUENTES
  };
}

module.exports = { radioBusquedaKm, curvaRadio, sugerenciaBusqueda, PERFIL, FUENTES };
