/* ============================================================================
 * razas.js — arte de animales de PetSeñal
 *
 * Genera una ilustración SVG para cada combinación de especie + raza + color.
 * No hay fotos ni archivos por raza: todo se dibuja con formas, así el repo no
 * carga cientos de imágenes y el color siempre es plausible para la especie
 * (un conejo nunca sale verde). Las razas solo cambian de forma (orejas, hocico,
 * pelo, tamaño y patrón) y de paleta realista.
 *
 * Se carga ANTES de app.js (ver index.html) y deja globales sus funciones.
 * El frontend queda fuera de la métrica de cobertura, pero igual tiene pruebas
 * en backend/tests/animal-art.test.js.
 * ========================================================================== */

// Colores realistas. `hex` es el tono base que se pinta.
var PALETA_ANIMAL = {
  negro: { hex: '#332f31', nombre: 'Negro' },
  blanco: { hex: '#f5f2ea', nombre: 'Blanco' },
  crema: { hex: '#eadcc0', nombre: 'Crema' },
  arena: { hex: '#d8c49b', nombre: 'Arena' },
  gris: { hex: '#a2a7ac', nombre: 'Gris' },
  gris_raton: { hex: '#8b8d92', nombre: 'Gris ratón' },
  humo: { hex: '#7d8087', nombre: 'Humo' },
  azul_gris: { hex: '#81909c', nombre: 'Azul grisáceo' },
  cafe: { hex: '#6f4a31', nombre: 'Café' },
  chocolate: { hex: '#5b3a24', nombre: 'Chocolate' },
  marron: { hex: '#8b5a33', nombre: 'Marrón' },
  canela: { hex: '#bc7c42', nombre: 'Canela' },
  dorado: { hex: '#d9a94d', nombre: 'Dorado' },
  ambar: { hex: '#c98a3a', nombre: 'Ámbar' },
  naranja: { hex: '#d97f2c', nombre: 'Naranja' },
  rojizo: { hex: '#a5582c', nombre: 'Rojizo' },
  rojo: { hex: '#b8452f', nombre: 'Rojo' },
  atigrado: { hex: '#c08a4e', nombre: 'Atigrado' },
  moteado: { hex: '#bda98d', nombre: 'Moteado' },
  calico: { hex: '#efe3cf', nombre: 'Calicó' },
  fuego: { hex: '#c9772f', nombre: 'Fuego' },
  amarillo: { hex: '#e7c94a', nombre: 'Amarillo' },
  limon: { hex: '#c7d34e', nombre: 'Lima' },
  verde: { hex: '#3f8f5c', nombre: 'Verde' },
  turquesa: { hex: '#3f9fa6', nombre: 'Turquesa' },
  celeste: { hex: '#6aa8c9', nombre: 'Celeste' },
  azul: { hex: '#3f6fb0', nombre: 'Azul' },
  purpura: { hex: '#7b5aa6', nombre: 'Púrpura' },
  rosado: { hex: '#d98a97', nombre: 'Rosado' }
};

// Sinónimos en texto libre (sin tildes) -> clave de la paleta.
var SINONIMOS_COLOR = {
  negro: 'negro',
  negra: 'negro',
  azabache: 'negro',
  carbon: 'negro',
  blanco: 'blanco',
  blanca: 'blanco',
  marfil: 'blanco',
  albino: 'blanco',
  crema: 'crema',
  beige: 'crema',
  beis: 'crema',
  vainilla: 'crema',
  arena: 'arena',
  ante: 'arena',
  gris: 'gris',
  plateado: 'gris',
  plata: 'gris',
  grisaceo: 'gris',
  ceniza: 'gris',
  raton: 'gris_raton',
  ahumado: 'humo',
  humo: 'humo',
  azul: 'azul_gris',
  azulgrisaceo: 'azul_gris',
  cafe: 'cafe',
  marron: 'marron',
  chocolate: 'chocolate',
  canela: 'canela',
  canelo: 'canela',
  dorado: 'dorado',
  dorada: 'dorado',
  oro: 'dorado',
  rubio: 'dorado',
  ambar: 'ambar',
  miel: 'ambar',
  naranja: 'naranja',
  anaranjado: 'naranja',
  rojizo: 'rojizo',
  bermejo: 'rojizo',
  rojo: 'rojo',
  roja: 'rojo',
  atigrado: 'atigrado',
  atigrada: 'atigrado',
  tabby: 'atigrado',
  rayado: 'atigrado',
  rayada: 'atigrado',
  moteado: 'moteado',
  moteada: 'moteado',
  manchado: 'moteado',
  manchada: 'moteado',
  pinto: 'moteado',
  pinta: 'moteado',
  manchas: 'moteado',
  calico: 'calico',
  fuego: 'fuego',
  amarillo: 'amarillo',
  amarilla: 'amarillo',
  limon: 'limon',
  verde: 'verde',
  esmeralda: 'verde',
  oliva: 'verde',
  turquesa: 'turquesa',
  celeste: 'celeste',
  purpura: 'purpura',
  violeta: 'purpura',
  lila: 'purpura',
  rosado: 'rosado',
  rosa: 'rosado',
  rosada: 'rosado',
  salmon: 'rosado'
};

// Palabras que, además de color, sugieren un patrón.
var PATRONES_TEXTO = [
  ['manchad', 'moteado'],
  ['mancha', 'moteado'],
  ['motead', 'moteado'],
  ['pinto', 'moteado'],
  ['atigrad', 'atigrado'],
  ['rayad', 'atigrado'],
  ['tabby', 'atigrado'],
  ['calico', 'calico'],
  ['carey', 'calico'],
  ['tricolor', 'bicolor'],
  ['bicolor', 'bicolor'],
  ['fuego', 'fuego'],
  ['punto', 'puntos'],
  ['mascara', 'mascara']
];

// Colores plausibles por especie: el filtro que impide un conejo verde.
var COLORES_ESPECIE = {
  perro: [
    'negro',
    'blanco',
    'crema',
    'gris',
    'cafe',
    'chocolate',
    'marron',
    'canela',
    'dorado',
    'rojizo',
    'atigrado',
    'moteado',
    'arena',
    'fuego'
  ],
  gato: [
    'negro',
    'blanco',
    'crema',
    'gris',
    'gris_raton',
    'azul_gris',
    'humo',
    'cafe',
    'marron',
    'canela',
    'naranja',
    'atigrado',
    'moteado'
  ],
  ave: [
    'amarillo',
    'limon',
    'verde',
    'turquesa',
    'celeste',
    'azul',
    'blanco',
    'gris',
    'negro',
    'naranja',
    'rojo',
    'cafe',
    'rosado',
    'purpura'
  ],
  conejo: [
    'blanco',
    'crema',
    'arena',
    'gris',
    'gris_raton',
    'humo',
    'negro',
    'cafe',
    'chocolate',
    'marron',
    'canela',
    'moteado'
  ],
  otro: ['cafe', 'marron', 'negro', 'blanco', 'gris', 'crema', 'moteado', 'canela', 'arena']
};

// ---------------------------------------------------------------------------
// Razas. Cada una define de dónde saca sus colores y sus rasgos de dibujo:
//   tamano: mini | pequeno | mediano | grande | gigante
//   orejas: caidas | erguidas | largas | puntiagudas | redondas
//   hocico: corto | medio | largo
//   pelo:   corto | medio | largo | rizado
//   patron: solido | fuego | moteado | atigrado | puntos | mascara | bicolor | calico
// `contraste` es el color con el que se dibuja el patrón cuando el usuario
// declara un solo color (p. ej. un dálmata blanco necesita manchas negras).
// La ÚLTIMA raza de cada lista es la que se usa cuando no se reconoce la raza.
// ---------------------------------------------------------------------------
var RAZAS_DEF = {
  perro: [
    {
      id: 'mestizo',
      nombre: 'Mestizo',
      alias: ['mestiza', 'comun', 'criollo'],
      rasgos: { tamano: 'mediano', orejas: 'caidas', hocico: 'medio', pelo: 'corto', patron: 'solido' }
    },
    {
      id: 'quiltro',
      nombre: 'Quiltro',
      alias: ['quiltra', 'mestizo chico', 'callejero'],
      rasgos: { tamano: 'pequeno', orejas: 'caidas', hocico: 'medio', pelo: 'corto', patron: 'solido' }
    },
    {
      id: 'labrador',
      nombre: 'Labrador',
      alias: ['labrador retriever'],
      colores: ['dorado', 'chocolate', 'negro'],
      rasgos: { tamano: 'grande', orejas: 'caidas', hocico: 'medio', pelo: 'corto', patron: 'solido' }
    },
    {
      id: 'golden',
      nombre: 'Golden Retriever',
      alias: ['golden'],
      colores: ['dorado', 'crema'],
      rasgos: { tamano: 'grande', orejas: 'caidas', hocico: 'medio', pelo: 'largo', patron: 'solido' }
    },
    {
      id: 'pastor_aleman',
      nombre: 'Pastor Alemán',
      alias: ['pastor aleman', 'alsaciano', 'ovejero'],
      colores: ['negro', 'marron', 'fuego'],
      rasgos: {
        tamano: 'grande',
        orejas: 'erguidas',
        hocico: 'largo',
        pelo: 'medio',
        patron: 'fuego',
        contraste: 'fuego'
      }
    },
    {
      id: 'pastor_belga',
      nombre: 'Pastor Belga',
      alias: ['malinois', 'pastor belga malinois'],
      colores: ['cafe', 'negro', 'gris'],
      rasgos: {
        tamano: 'grande',
        orejas: 'erguidas',
        hocico: 'largo',
        pelo: 'medio',
        patron: 'mascara',
        contraste: 'negro'
      }
    },
    {
      id: 'beagle',
      nombre: 'Beagle',
      alias: ['beagle ingles'],
      colores: ['blanco', 'cafe', 'moteado'],
      rasgos: {
        tamano: 'pequeno',
        orejas: 'caidas',
        hocico: 'medio',
        pelo: 'corto',
        patron: 'moteado',
        contraste: 'cafe'
      }
    },
    {
      id: 'poodle',
      nombre: 'Poodle',
      alias: ['caniche', 'poodle enano', 'poodle toy'],
      colores: ['blanco', 'crema', 'marron', 'negro', 'gris'],
      rasgos: { tamano: 'pequeno', orejas: 'caidas', hocico: 'medio', pelo: 'rizado', patron: 'solido' }
    },
    {
      id: 'pug',
      nombre: 'Pug',
      alias: ['carlino', 'pug chino'],
      colores: ['arena', 'negro', 'crema'],
      rasgos: {
        tamano: 'mini',
        orejas: 'caidas',
        hocico: 'corto',
        pelo: 'corto',
        patron: 'mascara',
        contraste: 'negro'
      }
    },
    {
      id: 'bulldog',
      nombre: 'Bulldog',
      alias: ['bulldog ingles', 'buldog'],
      colores: ['blanco', 'canela', 'moteado', 'negro'],
      rasgos: {
        tamano: 'mediano',
        orejas: 'caidas',
        hocico: 'corto',
        pelo: 'corto',
        patron: 'moteado',
        contraste: 'canela'
      }
    },
    {
      id: 'boxer',
      nombre: 'Boxer',
      alias: ['boxer aleman'],
      colores: ['canela', 'atigrado', 'blanco'],
      rasgos: { tamano: 'mediano', orejas: 'caidas', hocico: 'corto', pelo: 'corto', patron: 'solido' }
    },
    {
      id: 'chihuahua',
      nombre: 'Chihuahua',
      alias: ['chihuahueno'],
      colores: ['crema', 'negro', 'blanco', 'cafe'],
      rasgos: { tamano: 'mini', orejas: 'erguidas', hocico: 'corto', pelo: 'corto', patron: 'solido' }
    },
    {
      id: 'yorkshire',
      nombre: 'Yorkshire',
      alias: ['yorkie', 'yorkshire terrier'],
      colores: ['negro', 'fuego', 'gris', 'crema'],
      rasgos: {
        tamano: 'mini',
        orejas: 'erguidas',
        hocico: 'medio',
        pelo: 'largo',
        patron: 'fuego',
        contraste: 'fuego'
      }
    },
    {
      id: 'schnauzer',
      nombre: 'Schnauzer',
      alias: ['schnauzer mini', 'schnauzer miniatura'],
      colores: ['gris', 'negro', 'blanco'],
      rasgos: { tamano: 'mediano', orejas: 'caidas', hocico: 'medio', pelo: 'largo', patron: 'solido' }
    },
    {
      id: 'cocker',
      nombre: 'Cocker Spaniel',
      alias: ['cocker', 'cocker english'],
      colores: ['dorado', 'negro', 'moteado', 'cafe'],
      rasgos: {
        tamano: 'mediano',
        orejas: 'largas',
        hocico: 'medio',
        pelo: 'largo',
        patron: 'moteado',
        contraste: 'negro'
      }
    },
    {
      id: 'husky',
      nombre: 'Husky Siberiano',
      alias: ['husky', 'siberiano'],
      colores: ['gris', 'negro', 'blanco', 'moteado'],
      rasgos: {
        tamano: 'mediano',
        orejas: 'erguidas',
        hocico: 'medio',
        pelo: 'medio',
        patron: 'mascara',
        contraste: 'negro'
      }
    },
    {
      id: 'rottweiler',
      nombre: 'Rottweiler',
      alias: ['rott', 'rotweiler'],
      colores: ['negro', 'fuego'],
      rasgos: {
        tamano: 'grande',
        orejas: 'caidas',
        hocico: 'corto',
        pelo: 'corto',
        patron: 'fuego',
        contraste: 'fuego'
      }
    },
    {
      id: 'doberman',
      nombre: 'Doberman',
      alias: ['doberman pinscher'],
      colores: ['negro', 'chocolate', 'fuego'],
      rasgos: {
        tamano: 'grande',
        orejas: 'erguidas',
        hocico: 'largo',
        pelo: 'corto',
        patron: 'fuego',
        contraste: 'fuego'
      }
    },
    {
      id: 'dalmata',
      nombre: 'Dálmata',
      alias: ['dalmata', 'dalmatian'],
      colores: ['blanco'],
      rasgos: {
        tamano: 'mediano',
        orejas: 'caidas',
        hocico: 'medio',
        pelo: 'corto',
        patron: 'moteado',
        contraste: 'negro'
      }
    },
    {
      id: 'san_bernardo',
      nombre: 'San Bernardo',
      alias: ['san bernardo', 'saint bernard'],
      colores: ['blanco', 'rojizo', 'canela'],
      rasgos: {
        tamano: 'gigante',
        orejas: 'caidas',
        hocico: 'medio',
        pelo: 'largo',
        patron: 'bicolor',
        contraste: 'rojizo'
      }
    },
    {
      id: 'gran_danes',
      nombre: 'Gran Danés',
      alias: ['gran danes', 'dogo aleman', 'alano'],
      colores: ['atigrado', 'negro', 'arena', 'gris'],
      rasgos: { tamano: 'gigante', orejas: 'caidas', hocico: 'largo', pelo: 'corto', patron: 'solido' }
    },
    {
      id: 'salchicha',
      nombre: 'Salchicha (Dachshund)',
      alias: ['salchicha', 'dachshund', 'teckel', 'perro salchicha'],
      colores: ['cafe', 'chocolate', 'negro', 'fuego'],
      rasgos: {
        tamano: 'mini',
        orejas: 'largas',
        hocico: 'largo',
        pelo: 'corto',
        patron: 'fuego',
        contraste: 'fuego'
      }
    },
    {
      id: 'shih_tzu',
      nombre: 'Shih Tzu',
      alias: ['shihtzu', 'shih-tzu', 'shitzu'],
      colores: ['dorado', 'blanco', 'moteado', 'negro'],
      rasgos: {
        tamano: 'mini',
        orejas: 'caidas',
        hocico: 'corto',
        pelo: 'largo',
        patron: 'moteado',
        contraste: 'negro'
      }
    },
    {
      id: 'maltes',
      nombre: 'Maltés',
      alias: ['maltes', 'maltese'],
      colores: ['blanco'],
      rasgos: { tamano: 'mini', orejas: 'caidas', hocico: 'medio', pelo: 'largo', patron: 'solido' }
    },
    {
      id: 'akita',
      nombre: 'Akita',
      alias: ['akita inu', 'akita japones'],
      colores: ['blanco', 'marron', 'moteado', 'fuego'],
      rasgos: { tamano: 'grande', orejas: 'erguidas', hocico: 'medio', pelo: 'medio', patron: 'solido' }
    },
    {
      id: 'perro_otro',
      nombre: 'Otra raza',
      alias: ['perro', 'otro'],
      rasgos: { tamano: 'mediano', orejas: 'caidas', hocico: 'medio', pelo: 'corto', patron: 'solido' }
    }
  ],
  gato: [
    {
      id: 'siames',
      nombre: 'Siamés',
      alias: ['siames', 'siam'],
      colores: ['crema'],
      rasgos: {
        tamano: 'mediano',
        orejas: 'puntiagudas',
        hocico: 'medio',
        pelo: 'corto',
        patron: 'puntos',
        contraste: 'chocolate'
      }
    },
    {
      id: 'persa',
      nombre: 'Persa',
      alias: ['persa', 'persian'],
      colores: ['blanco', 'gris', 'naranja', 'negro', 'crema', 'humo'],
      rasgos: { tamano: 'mediano', orejas: 'redondas', hocico: 'corto', pelo: 'largo', patron: 'solido' }
    },
    {
      id: 'angora',
      nombre: 'Angora',
      alias: ['angora', 'angora turco'],
      colores: ['blanco', 'negro', 'gris', 'naranja', 'moteado'],
      rasgos: {
        tamano: 'mediano',
        orejas: 'puntiagudas',
        hocico: 'medio',
        pelo: 'largo',
        patron: 'moteado',
        contraste: 'negro'
      }
    },
    {
      id: 'bengali',
      nombre: 'Bengalí',
      alias: ['bengali', 'bengala', 'bengal'],
      colores: ['atigrado', 'moteado', 'canela', 'dorado'],
      rasgos: {
        tamano: 'mediano',
        orejas: 'puntiagudas',
        hocico: 'medio',
        pelo: 'corto',
        patron: 'moteado',
        contraste: 'negro'
      }
    },
    {
      id: 'romadizo',
      nombre: 'Romadizo',
      alias: ['romadizo', 'quirquincho', 'gato comun'],
      colores: ['negro', 'blanco', 'gris', 'atigrado', 'naranja', 'humo', 'moteado'],
      rasgos: {
        tamano: 'mediano',
        orejas: 'puntiagudas',
        hocico: 'medio',
        pelo: 'corto',
        patron: 'atigrado',
        contraste: 'negro'
      }
    },
    {
      id: 'comun_europeo',
      nombre: 'Común Europeo',
      alias: ['comun europeo', 'europeo', 'domestico', 'criollo', 'gato'],
      colores: ['negro', 'blanco', 'gris', 'atigrado', 'naranja', 'humo', 'moteado', 'calico'],
      rasgos: {
        tamano: 'mediano',
        orejas: 'puntiagudas',
        hocico: 'medio',
        pelo: 'corto',
        patron: 'atigrado',
        contraste: 'negro'
      }
    }
  ],
  ave: [
    {
      id: 'periquito',
      nombre: 'Periquito',
      alias: ['periquito', 'periquito australiano', 'budgie', 'cotorrita'],
      colores: ['verde', 'limon', 'celeste', 'amarillo', 'azul', 'blanco'],
      rasgos: { tamano: 'mini', orejas: 'redondas', hocico: 'corto', pelo: 'corto', patron: 'solido' }
    },
    {
      id: 'canario',
      nombre: 'Canario',
      alias: ['canario', 'canary'],
      colores: ['amarillo', 'naranja', 'blanco', 'rojizo'],
      rasgos: { tamano: 'mini', orejas: 'redondas', hocico: 'corto', pelo: 'corto', patron: 'solido' }
    },
    {
      id: 'cotorra',
      nombre: 'Cotorra',
      alias: ['cotorra', 'loro', 'papagayo', 'periquito grande'],
      colores: ['verde', 'turquesa', 'amarillo'],
      rasgos: { tamano: 'mediano', orejas: 'redondas', hocico: 'curvo', pelo: 'corto', patron: 'solido' }
    },
    {
      id: 'agapornis',
      nombre: 'Agapornis',
      alias: ['agapornis', 'inseparable', 'lovebird'],
      colores: ['verde', 'naranja', 'rosado', 'celeste'],
      rasgos: { tamano: 'mini', orejas: 'redondas', hocico: 'corto', pelo: 'corto', patron: 'solido' }
    },
    {
      id: 'cacatua',
      nombre: 'Cacatúa',
      alias: ['cacatua', 'cockatoo'],
      colores: ['blanco', 'rosado'],
      rasgos: { tamano: 'mediano', orejas: 'redondas', hocico: 'curvo', pelo: 'corto', patron: 'solido' }
    },
    {
      id: 'ninfa',
      nombre: 'Ninfa',
      alias: ['ninfa', 'carolina', 'calopsita'],
      colores: ['gris', 'amarillo', 'crema', 'blanco'],
      rasgos: { tamano: 'mediano', orejas: 'redondas', hocico: 'curvo', pelo: 'corto', patron: 'solido' }
    },
    {
      id: 'ave_otra',
      nombre: 'Otra ave',
      alias: ['ave', 'pajaro', 'otro'],
      rasgos: { tamano: 'mini', orejas: 'redondas', hocico: 'corto', pelo: 'corto', patron: 'solido' }
    }
  ],
  conejo: [
    {
      id: 'conejo_comun',
      nombre: 'Conejo común',
      alias: ['comun', 'mestizo', 'criollo'],
      colores: ['blanco', 'gris', 'negro', 'cafe', 'marron', 'canela', 'moteado'],
      rasgos: { tamano: 'mediano', orejas: 'erguidas', hocico: 'corto', pelo: 'corto', patron: 'solido' }
    },
    {
      id: 'enano',
      nombre: 'Enano',
      alias: ['enano', 'mini lop', 'minilop', 'enano holandes'],
      colores: ['blanco', 'gris', 'negro', 'cafe', 'moteado', 'canela'],
      rasgos: {
        tamano: 'mini',
        orejas: 'erguidas',
        hocico: 'corto',
        pelo: 'corto',
        patron: 'moteado',
        contraste: 'negro'
      }
    },
    {
      id: 'belier',
      nombre: 'Belier',
      alias: ['belier', 'lop', 'orejas caidas', 'cabezal'],
      colores: ['blanco', 'gris', 'negro', 'cafe', 'moteado'],
      rasgos: {
        tamano: 'pequeno',
        orejas: 'caidas',
        hocico: 'corto',
        pelo: 'corto',
        patron: 'moteado',
        contraste: 'negro'
      }
    },
    {
      id: 'angora',
      nombre: 'Angora',
      alias: ['angora'],
      colores: ['blanco', 'gris', 'cafe', 'negro', 'moteado'],
      rasgos: {
        tamano: 'mediano',
        orejas: 'erguidas',
        hocico: 'corto',
        pelo: 'largo',
        patron: 'moteado',
        contraste: 'gris'
      }
    },
    {
      id: 'californiano',
      nombre: 'Californiano',
      alias: ['californiano'],
      colores: ['blanco'],
      rasgos: {
        tamano: 'mediano',
        orejas: 'erguidas',
        hocico: 'corto',
        pelo: 'corto',
        patron: 'puntos',
        contraste: 'negro'
      }
    },
    {
      id: 'himalaya',
      nombre: 'Himalaya',
      alias: ['himalaya'],
      colores: ['blanco'],
      rasgos: {
        tamano: 'pequeno',
        orejas: 'erguidas',
        hocico: 'corto',
        pelo: 'corto',
        patron: 'puntos',
        contraste: 'chocolate'
      }
    },
    {
      id: 'cabeza_leon',
      nombre: 'Cabeza de León',
      alias: ['cabeza de leon', 'lion head', 'lionhead'],
      colores: ['dorado', 'canela', 'blanco', 'moteado'],
      rasgos: {
        tamano: 'pequeno',
        orejas: 'erguidas',
        hocico: 'corto',
        pelo: 'largo',
        patron: 'moteado',
        contraste: 'canela'
      }
    },
    {
      id: 'conejo_otro',
      nombre: 'Otro conejo',
      alias: ['otro'],
      rasgos: { tamano: 'mediano', orejas: 'erguidas', hocico: 'corto', pelo: 'corto', patron: 'solido' }
    }
  ],
  otro: [
    {
      id: 'hamster',
      nombre: 'Hámster',
      alias: ['hamster'],
      colores: ['dorado', 'blanco', 'gris', 'canela', 'moteado'],
      rasgos: {
        tamano: 'mini',
        orejas: 'redondas',
        hocico: 'corto',
        pelo: 'corto',
        patron: 'moteado',
        contraste: 'blanco'
      }
    },
    {
      id: 'huron',
      nombre: 'Hurón',
      alias: ['huron', 'ferret'],
      colores: ['marron', 'blanco', 'negro', 'crema'],
      rasgos: {
        tamano: 'pequeno',
        orejas: 'redondas',
        hocico: 'medio',
        pelo: 'medio',
        patron: 'mascara',
        contraste: 'negro'
      }
    },
    {
      id: 'tortuga',
      nombre: 'Tortuga',
      alias: ['tortuga'],
      colores: ['verde', 'marron', 'negro', 'moteado'],
      rasgos: {
        tamano: 'pequeno',
        orejas: 'redondas',
        hocico: 'corto',
        pelo: 'corto',
        patron: 'moteado',
        contraste: 'marron'
      }
    },
    {
      id: 'cuyo',
      nombre: 'Cuyo (conejillo de Indias)',
      alias: ['cuyo', 'conejillo', 'conejillo de indias', 'guinea pig'],
      colores: ['marron', 'blanco', 'negro', 'canela', 'moteado'],
      rasgos: {
        tamano: 'mini',
        orejas: 'redondas',
        hocico: 'corto',
        pelo: 'corto',
        patron: 'moteado',
        contraste: 'negro'
      }
    },
    {
      id: 'otro_animal',
      nombre: 'Otro animal',
      alias: ['otro', ' desconocido'],
      rasgos: { tamano: 'mediano', orejas: 'redondas', hocico: 'medio', pelo: 'corto', patron: 'solido' }
    }
  ]
};

// Tamaño relativo de cada raza (escala el dibujo completo).
var ESCALA_ART = { mini: 0.74, pequeno: 0.85, mediano: 0.95, grande: 1.0, gigante: 1.08 };

// Aves que llevan penacho en la cabeza (el resto va liso).
var AVES_CON_CRESTA = { cotorra: true, cacatua: true, ninfa: true };

/* ---------------------------------------------------------------------------
 * Utilidades
 * ------------------------------------------------------------------------- */

// Minúsculas, sin tildes y sin espacios sobrantes. Así "Café" = "cafe".
function normalizaArt(valor) {
  return String(valor == null ? '' : valor)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim();
}

// Hash estable: da un id corto a cada combinación para los clipPath del SVG.
function hashArt(texto) {
  let h = 2166136261;
  for (let i = 0; i < texto.length; i += 1) {
    h ^= texto.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function parseHex(hex) {
  const s = String(hex).replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

// Mezcla dos colores: t=0 deja "a", t=1 deja "b".
function mezclaHex(a, b, t) {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const canal = i => Math.round(pa[i] + (pb[i] - pa[i]) * t);
  const hex = n => n.toString(16).padStart(2, '0');
  return '#' + hex(canal(0)) + hex(canal(1)) + hex(canal(2));
}
function oscurece(hex, t) {
  return mezclaHex(hex, '#000000', t);
}
function aclara(hex, t) {
  return mezclaHex(hex, '#ffffff', t);
}

function elip(cx, cy, rx, ry, fill, extra) {
  return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="${fill}"${extra || ''}/>`;
}
function ojosAnimal(cx, cy, sep, r, fill) {
  return (
    elip(cx - sep, cy, r, r, fill) +
    elip(cx + sep, cy, r, r, fill) +
    elip(cx - sep, cy - r * 0.3, r * 0.32, r * 0.32, 'rgba(255,255,255,0.85)') +
    elip(cx + sep, cy - r * 0.3, r * 0.32, r * 0.32, 'rgba(255,255,255,0.85)')
  );
}
function narizAnimal(cx, cy, w, fill) {
  const h = w * 0.8;
  return `<path d="M${cx - w} ${cy} Q${cx} ${cy - h} ${cx + w} ${cy} Q${cx} ${cy + h} ${cx - w} ${cy}Z" fill="${fill}"/>`;
}

/* ---------------------------------------------------------------------------
 * Capas de patrón (se recortan contra la cabeza)
 * ------------------------------------------------------------------------- */
var CAPAS_PATRON = {
  fuego: c2 => elip(48, 58, 11, 9, c2) + elip(72, 58, 11, 9, c2) + elip(60, 86, 13, 11, c2),
  mascara: c2 => `<rect x="22" y="44" width="76" height="20" rx="10" fill="${c2}"/>`,
  moteado: c2 =>
    elip(40, 44, 7, 6, c2) +
    elip(80, 50, 6, 5.5, c2) +
    elip(58, 34, 5, 4.5, c2) +
    elip(46, 74, 6, 5, c2) +
    elip(76, 76, 5, 4.5, c2) +
    elip(86, 40, 4.5, 4, c2),
  atigrado: (_c2, s) =>
    `<rect x="50" y="28" width="4" height="16" rx="2" fill="${s}"/>` +
    `<rect x="62" y="28" width="4" height="16" rx="2" fill="${s}"/>` +
    `<rect x="38" y="40" width="5" height="13" rx="2.5" fill="${s}"/>` +
    `<rect x="74" y="40" width="5" height="13" rx="2.5" fill="${s}"/>` +
    `<rect x="26" y="52" width="6" height="11" rx="3" fill="${s}"/>` +
    `<rect x="84" y="52" width="6" height="11" rx="3" fill="${s}"/>`,
  puntos: c2 => elip(38, 42, 10, 9, c2) + elip(82, 42, 10, 9, c2) + elip(60, 90, 13, 10, c2),
  bicolor: c2 => `<path d="M22 72 Q60 98 98 72 L98 120 L22 120Z" fill="${c2}"/>`,
  calico: () =>
    elip(42, 46, 12, 11, '#d97f2c') + elip(78, 48, 11, 10, '#332f31') + elip(60, 92, 12, 9, '#332f31')
};

// Dibuja la cabeza con su patrón recortado dentro del óvalo de la cara.
function cabezaConPatron(cx, cy, rx, ry, c1, c2, pat, uid) {
  const clipId = 'c' + uid;
  const capa = CAPAS_PATRON[pat] ? CAPAS_PATRON[pat](c2, oscurece(c1, 0.24)) : '';
  const recorte = capa
    ? `<defs><clipPath id="${clipId}"><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}"/></clipPath></defs>` +
      `<g clip-path="url(#${clipId})">${capa}</g>`
    : '';
  const contorno = elip(cx, cy, rx, ry, 'none', ` stroke="${oscurece(c1, 0.2)}" stroke-width="1.25"`);
  return elip(cx, cy, rx, ry, c1) + recorte + contorno;
}

/* ---------------------------------------------------------------------------
 * Perro: orejas, hocico, pelo
 * ------------------------------------------------------------------------- */
var OREJAS_PERRO = {
  caidas: (c1, c2) =>
    elip(30, 60, 11, 22, c1) +
    elip(90, 60, 11, 22, c1) +
    elip(30, 62, 5.5, 13, aclara(c2, 0.12)) +
    elip(90, 62, 5.5, 13, aclara(c2, 0.12)),
  erguidas: (c1, c2) =>
    `<path d="M42 32 L20 4 L56 26 Z" fill="${c1}"/>` +
    `<path d="M78 32 L100 4 L64 26 Z" fill="${c1}"/>` +
    `<path d="M44 30 L30 12 L52 26 Z" fill="${aclara(c2, 0.1)}"/>` +
    `<path d="M76 30 L90 12 L68 26 Z" fill="${aclara(c2, 0.1)}"/>`,
  largas: (c1, c2) =>
    elip(26, 68, 10, 30, c1) +
    elip(94, 68, 10, 30, c1) +
    elip(26, 70, 5, 18, aclara(c2, 0.12)) +
    elip(94, 70, 5, 18, aclara(c2, 0.12))
};
var HOCICOS_PERRO = {
  corto: m => elip(60, 74, 17, 11, m),
  medio: m => elip(60, 79, 15, 13, m),
  largo: m => elip(60, 86, 13, 18, m)
};
var MELENAS_PERRO = {
  largo: c1 =>
    `<path d="M60 16c-25 0-44 17-44 41 0 8 2 14 6 20l6-6 5 8 6-7 5 8 6-7 5 8 6-7 5 8 6-7 5 8 6-6c4-6 6-12 6-20 0-24-19-41-44-41Z" fill="${aclara(c1, 0.08)}"/>`,
  rizado: c1 =>
    [
      [28, 40],
      [38, 26],
      [52, 18],
      [68, 18],
      [82, 26],
      [92, 40]
    ]
      .map(p => elip(p[0], p[1], 10, 9, c1))
      .join('')
};
function caraPerro(def, c, uid) {
  const c1 = c.principal;
  const c2 = c.secundario;
  const orejas = (OREJAS_PERRO[def.rasgos.orejas] || OREJAS_PERRO.caidas)(c1, c2);
  const melena = MELENAS_PERRO[def.rasgos.pelo] ? MELENAS_PERRO[def.rasgos.pelo](c1) : '';
  const hocico = (HOCICOS_PERRO[def.rasgos.hocico] || HOCICOS_PERRO.medio)(aclara(c1, 0.16));
  const cabeza = cabezaConPatron(60, 60, 35, 33, c1, c2, c.patron, uid);
  const ojos = ojosAnimal(60, 55, 13, 4.6, '#2b2a2c');
  const nariz = narizAnimal(60, 78, 6, '#2b2a2c');
  const mejillas = elip(52, 79, 8, 6.5, aclara(c1, 0.24)) + elip(68, 79, 8, 6.5, aclara(c1, 0.24));
  const cejas = `<path d="M40 47 q7 -4 13 0 M67 47 q6 -4 13 0" stroke="${oscurece(c1, 0.3)}" stroke-width="1.25" fill="none" stroke-linecap="round"/>`;
  const boca = `<path d="M60 82 v5 q-7 6 -13 1 M60 87 q7 6 13 1" stroke="${oscurece(c1, 0.34)}" stroke-width="2" fill="none" stroke-linecap="round"/>`;
  const pecas = `<circle cx="45" cy="84" r="1" fill="${oscurece(c1, 0.25)}"/><circle cx="48" cy="87" r="1" fill="${oscurece(c1, 0.25)}"/><circle cx="75" cy="84" r="1" fill="${oscurece(c1, 0.25)}"/><circle cx="72" cy="87" r="1" fill="${oscurece(c1, 0.25)}"/>`;
  return melena + orejas + cabeza + hocico + mejillas + cejas + ojos + nariz + boca + pecas;
}

/* ---------------------------------------------------------------------------
 * Gato
 * ------------------------------------------------------------------------- */
var OREJAS_GATO = {
  puntiagudas: (c1, c2) =>
    `<path d="M38 38 L26 6 L58 30 Z" fill="${c1}"/>` +
    `<path d="M82 38 L94 6 L62 30 Z" fill="${c1}"/>` +
    `<path d="M40 36 L33 15 L52 30 Z" fill="${aclara(c2, 0.05)}"/>` +
    `<path d="M80 36 L87 15 L68 30 Z" fill="${aclara(c2, 0.05)}"/>`,
  redondas: (c1, c2) =>
    elip(36, 38, 12, 11, c1) +
    elip(84, 38, 12, 11, c1) +
    elip(36, 39, 6, 5.5, aclara(c2, 0.08)) +
    elip(84, 39, 6, 5.5, aclara(c2, 0.08))
};
function caraGato(def, c, uid) {
  const c1 = c.principal;
  const c2 = c.secundario;
  const pelaje = def.rasgos.pelo === 'largo' ? elip(60, 62, 38, 35, aclara(c1, 0.05)) : '';
  const orejas = (OREJAS_GATO[def.rasgos.orejas] || OREJAS_GATO.puntiagudas)(c1, c2);
  const cabeza = cabezaConPatron(60, 62, 34, 31, c1, c2, c.patron, uid);
  const ojos =
    `<ellipse cx="47" cy="58" rx="8" ry="6" fill="#c9d66b"/><ellipse cx="73" cy="58" rx="8" ry="6" fill="#c9d66b"/>` +
    `<ellipse cx="47" cy="58" rx="2.2" ry="5.5" fill="#22302e"/><ellipse cx="73" cy="58" rx="2.2" ry="5.5" fill="#22302e"/>`;
  const hocico = elip(60, 80, 15, 10, aclara(c1, 0.18));
  const nariz = `<path d="M56 75 Q60 72 64 75 Q60 80 56 75Z" fill="#d98a97"/>`;
  const bigotes = `<path d="M34 79 h-14 M35 84 h-14 M86 79 h14 M85 84 h14" stroke="${oscurece(c1, 0.4)}" stroke-width="1.4" stroke-linecap="round"/>`;
  return pelaje + orejas + cabeza + ojos + hocico + nariz + bigotes;
}

/* ---------------------------------------------------------------------------
 * Ave
 * ------------------------------------------------------------------------- */
var CRESTAS_AVE = {
  penacho: c1 => `<path d="M52 24 q4 -18 12 -16 q-2 10 4 16 q6 -8 12 -2 q-8 6 -10 16 Z" fill="${c1}"/>`
};
var PICOS_AVE = {
  corto: () => `<path d="M84 54 L100 60 L84 66 Z" fill="#e7a13a"/>`,
  curvo: () => `<path d="M84 52 q16 0 16 10 q-4 -5 -8 -3 q2 6 -4 9 q-6 -6 -4 -16 Z" fill="#e7a13a"/>`
};
function caraAve(def, c) {
  const c1 = c.principal;
  const patas = `<path d="M52 110 v6 M68 110 v6" stroke="#e7a13a" stroke-width="3" stroke-linecap="round"/>`;
  const cuerpo = elip(60, 82, 30, 32, c1);
  const panza = elip(60, 88, 20, 22, aclara(c1, 0.16));
  const ala = `<path d="M40 74 q16 4 22 22 q-18 4 -30 -8 q-6 -8 8 -14 Z" fill="${oscurece(c1, 0.14)}"/>`;
  const cabeza = elip(56, 50, 27, 26, c1);
  const cresta = AVES_CON_CRESTA[def.id] ? CRESTAS_AVE.penacho(c1) : '';
  const pico = (PICOS_AVE[def.rasgos.hocico] || PICOS_AVE.corto)();
  const ojo = `<circle cx="66" cy="46" r="5" fill="#ffffff"/><circle cx="67" cy="46" r="2.6" fill="#22302e"/>`;
  return patas + cuerpo + panza + ala + cabeza + cresta + pico + ojo;
}

/* ---------------------------------------------------------------------------
 * Conejo
 * ------------------------------------------------------------------------- */
var OREJAS_CONEJO = {
  erguidas: (c1, c2) =>
    elip(44, 30, 9, 28, c1) +
    elip(76, 30, 9, 28, c1) +
    elip(44, 30, 4.5, 20, aclara(c2, 0.08)) +
    elip(76, 30, 4.5, 20, aclara(c2, 0.08)),
  caidas: (c1, c2) =>
    elip(30, 62, 9, 26, c1, ' transform="rotate(24 30 62)"') +
    elip(90, 62, 9, 26, c1, ' transform="rotate(-24 90 62)"') +
    elip(30, 64, 4.5, 18, aclara(c2, 0.08), ' transform="rotate(24 30 62)"') +
    elip(90, 64, 4.5, 18, aclara(c2, 0.08), ' transform="rotate(-24 90 62)"')
};
function caraConejo(def, c, uid) {
  const c1 = c.principal;
  const c2 = c.secundario;
  const orejas = (OREJAS_CONEJO[def.rasgos.orejas] || OREJAS_CONEJO.erguidas)(c1, c2);
  const cabeza = cabezaConPatron(60, 74, 30, 28, c1, c2, c.patron, uid);
  const hocico = elip(60, 88, 14, 10, aclara(c1, 0.2));
  const ojos = ojosAnimal(60, 70, 12, 4.4, '#2b2a2c');
  const nariz = narizAnimal(60, 84, 5, '#d98a97');
  const bigotes = `<path d="M40 86 h-12 M41 90 h-12 M80 86 h12 M79 90 h12" stroke="${oscurece(c1, 0.3)}" stroke-width="1.3" stroke-linecap="round"/>`;
  return orejas + cabeza + hocico + ojos + nariz + bigotes;
}

/* ---------------------------------------------------------------------------
 * Otro animal (genérico)
 * ------------------------------------------------------------------------- */
function caraOtro(def, c, uid) {
  const c1 = c.principal;
  const c2 = c.secundario;
  const orejas =
    elip(30, 40, 13, 13, c1) +
    elip(90, 40, 13, 13, c1) +
    elip(30, 41, 6.5, 6.5, aclara(c2, 0.1)) +
    elip(90, 41, 6.5, 6.5, aclara(c2, 0.1));
  const cabeza = cabezaConPatron(60, 62, 34, 32, c1, c2, c.patron, uid);
  const hocico = elip(60, 82, 15, 12, aclara(c1, 0.16));
  const ojos = ojosAnimal(60, 56, 13, 5, '#2b2a2c');
  const nariz = narizAnimal(60, 80, 6, '#2b2a2c');
  return orejas + cabeza + hocico + ojos + nariz;
}

var CARAS = { perro: caraPerro, gato: caraGato, ave: caraAve, conejo: caraConejo, otro: caraOtro };

/* ---------------------------------------------------------------------------
 * Resolución de raza, colores y patrón
 * ------------------------------------------------------------------------- */
function resuelveRaza(tipo, raza) {
  const lista = RAZAS_DEF[tipo] || RAZAS_DEF.otro;
  const q = normalizaArt(raza);
  if (q) {
    const exacta = lista.find(r => normalizaArt(r.nombre) === q);
    if (exacta) return exacta;
    // "mi labrador dorado" o "golden" deben encontrar su raza.
    const mencionada = lista.find(
      r => q.includes(normalizaArt(r.nombre)) || (r.alias || []).some(a => q.includes(normalizaArt(a)))
    );
    if (mencionada) return mencionada;
  }
  return lista[lista.length - 1];
}

function coloresDeRaza(tipo, raza) {
  const def = resuelveRaza(tipo, raza);
  if (def.colores && def.colores.length) return def.colores.slice();
  return (COLORES_ESPECIE[tipo] || COLORES_ESPECIE.otro).slice();
}

// Lista de razas de una especie, con sus colores realistas (para la interfaz).
function razasDeTipo(tipo) {
  return (RAZAS_DEF[tipo] || RAZAS_DEF.otro).map(r => ({
    id: r.id,
    nombre: r.nombre,
    colores: (r.colores && r.colores.length
      ? r.colores
      : COLORES_ESPECIE[tipo] || COLORES_ESPECIE.otro
    ).slice()
  }));
}

// Colores válidos que aparecen en un texto libre, en orden y sin repetir.
function coloresEnTexto(texto, permitidos) {
  const tokens = normalizaArt(texto)
    .split(/[^a-z]+/)
    .filter(Boolean);
  const salida = [];
  for (const token of tokens) {
    const clave = SINONIMOS_COLOR[token];
    if (clave && permitidos.includes(clave) && !salida.includes(clave)) salida.push(clave);
  }
  return salida;
}

// Patrón sugerido por el texto; si no dice nada, el de la raza.
function detectaPatron(texto, def) {
  const t = normalizaArt(texto);
  for (const par of PATRONES_TEXTO) {
    if (t.includes(par[0])) return par[1];
  }
  return def.rasgos.patron || 'solido';
}

// Traduce el color declarado a colores de la paleta que tengan sentido para la
// raza. Nunca inventa un color imposible: si no reconoce ninguno, usa el primero
// realista de la raza.
function resuelveColor(tipo, def, texto) {
  const permitidos =
    def.colores && def.colores.length ? def.colores : COLORES_ESPECIE[tipo] || COLORES_ESPECIE.otro;
  const claves = coloresEnTexto(texto, permitidos);
  const principal = claves[0] || permitidos[0];
  const secundario = claves[1] || def.rasgos.contraste || principal;
  const patron = detectaPatron(texto, def);
  const etiqueta =
    PALETA_ANIMAL[principal].nombre + (claves[1] ? ' y ' + PALETA_ANIMAL[claves[1]].nombre : '');
  return { principal, secundario, patron, etiqueta };
}

/* ---------------------------------------------------------------------------
 * API pública
 * ------------------------------------------------------------------------- */

// Devuelve el SVG (como cadena) del animal descrito. Siempre responde algo:
// con datos inválidos cae al animal genérico de la especie.
function renderAnimalSVG(tipo, raza, color, opts) {
  const t = RAZAS_DEF[tipo] ? tipo : 'otro';
  const def = resuelveRaza(t, raza);
  const c = resuelveColor(t, def, color);
  const uid = hashArt(t + '|' + def.id + '|' + c.principal + '|' + c.secundario + '|' + c.patron);
  // El dibujo trabaja con hex: las claves de la paleta no son colores CSS.
  const colores = {
    principal: PALETA_ANIMAL[c.principal].hex,
    secundario: PALETA_ANIMAL[c.secundario].hex,
    patron: c.patron
  };
  const cara = (CARAS[t] || CARAS.otro)(def, colores, uid);
  const escala = ESCALA_ART[def.rasgos.tamano] || 1;
  const fondo = opts && opts.fondo ? elip(60, 60, 58, 58, opts.fondo) : '';
  return (
    `<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg" class="animal-svg" ` +
    `aria-hidden="true" focusable="false"><g class="animal-sprite" transform="translate(60 60) scale(${escala}) translate(-60 -60)">` +
    `${fondo}${cara}</g></svg>`
  );
}

// Lo que consume la app (y lo que hace referencia a las funciones, para que el
// linter no las tome por código muerto).
window.RAZAS_API = {
  renderAnimalSVG: renderAnimalSVG,
  coloresDeRaza: coloresDeRaza,
  razasDeTipo: razasDeTipo
};
