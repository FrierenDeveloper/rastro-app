// Pruebas del arte de animales del frontend (frontend/razas.js).
//
// El frontend no entra en la métrica de cobertura, pero igual se prueba: cada
// raza y cada color realista tiene que producir un SVG válido, y nunca un color
// imposible para la especie (un conejo verde, un perro azul).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const frontend = path.join(raiz, 'frontend');

const html = fs.readFileSync(path.join(frontend, 'index.html'), 'utf8');
const codigo = fs.readFileSync(path.join(frontend, 'razas.js'), 'utf8');
const reports = fs.readFileSync(path.join(raiz, 'backend/routes/reports.js'), 'utf8');

// Ejecuta razas.js como script de navegador (con `window`) y devuelve su API.
const api = vm.runInContext(
  codigo +
    '\n;({ RAZAS_DEF, COLORES_ESPECIE, PALETA_ANIMAL, renderAnimalSVG, resuelveRaza, ' +
    'resuelveColor, coloresDeRaza, razasDeTipo, normalizaArt, SINONIMOS_COLOR })',
  vm.createContext({ window: {} })
);

// Especies declaradas como válidas en el backend.
const TIPOS_VALIDOS = (reports.match(/TIPOS_VALIDOS\s*=\s*\[([^\]]+)\]/)?.[1] || '')
  .match(/'([^']+)'/g)
  .map(t => t.replace(/'/g, ''));

const RAZAS_DEL_DATALIST = [...html.matchAll(/<datalist id="razas-comunes">([\s\S]*?)<\/datalist>/g)].flatMap(
  m => [...m[1].matchAll(/<option value="([^"]+)"/g)].map(o => o[1])
);

const svgValido = svg => {
  expect(svg.startsWith('<svg')).toBe(true);
  expect(svg.endsWith('</svg>')).toBe(true);
  expect(svg).not.toMatch(/NaN|undefined|null/);
  const abre = (svg.match(/<[a-z]/gi) || []).length;
  const cierra = (svg.match(/<\/[a-z]+>/gi) || []).length;
  const sueltos = (svg.match(/<[a-z][^>]*\/>/gi) || []).length;
  expect(abre).toBe(cierra + sueltos);
};

describe('arte de animales: registro de razas', () => {
  it('cubre todas las especies válidas del backend', () => {
    expect(TIPOS_VALIDOS.length).toBeGreaterThan(0);
    for (const tipo of TIPOS_VALIDOS) {
      expect(api.RAZAS_DEF[tipo]).toBeDefined();
      expect(api.COLORES_ESPECIE[tipo].length).toBeGreaterThan(0);
    }
  });

  it('cada raza tiene id único, nombre y rasgos conocidos', () => {
    const tamanos = ['mini', 'pequeno', 'mediano', 'grande', 'gigante'];
    const orejas = ['caidas', 'erguidas', 'largas', 'puntiagudas', 'redondas'];
    const hocicos = ['corto', 'medio', 'largo', 'curvo'];
    const pelos = ['corto', 'medio', 'largo', 'rizado'];
    const patrones = ['solido', 'fuego', 'moteado', 'atigrado', 'puntos', 'mascara', 'bicolor', 'calico'];
    for (const tipo of Object.keys(api.RAZAS_DEF)) {
      const ids = new Set();
      for (const raza of api.RAZAS_DEF[tipo]) {
        expect(raza.nombre).toBeTruthy();
        expect(ids.has(raza.id)).toBe(false);
        ids.add(raza.id);
        expect(tamanos).toContain(raza.rasgos.tamano);
        expect(orejas).toContain(raza.rasgos.orejas);
        expect(hocicos).toContain(raza.rasgos.hocico);
        expect(pelos).toContain(raza.rasgos.pelo);
        expect(patrones).toContain(raza.rasgos.patron);
        for (const color of raza.colores || []) {
          expect(api.PALETA_ANIMAL[color]).toBeDefined();
        }
        if (raza.rasgos.contraste) expect(api.PALETA_ANIMAL[raza.rasgos.contraste]).toBeDefined();
      }
    }
  });

  it('reconoce todas las razas que ofrece el autocompletado', () => {
    expect(RAZAS_DEL_DATALIST.length).toBeGreaterThan(20);
    const conocida = (tipo, texto) => {
      const q = api.normalizaArt(texto);
      return api.RAZAS_DEF[tipo].some(
        r => api.normalizaArt(r.nombre) === q || (r.alias || []).some(a => q.includes(api.normalizaArt(a)))
      );
    };
    for (const nombre of RAZAS_DEL_DATALIST) {
      expect(conocida('perro', nombre) || conocida('gato', nombre), `falta la raza "${nombre}"`).toBe(true);
    }
  });
});

describe('arte de animales: render por raza y color', () => {
  it('dibuja un SVG válido para cada raza con cada uno de sus colores', () => {
    let total = 0;
    for (const tipo of TIPOS_VALIDOS) {
      for (const raza of api.RAZAS_DEF[tipo]) {
        for (const color of api.coloresDeRaza(tipo, raza.nombre)) {
          expect(api.PALETA_ANIMAL[color]).toBeDefined();
          svgValido(api.renderAnimalSVG(tipo, raza.nombre, color));
          total += 1;
        }
      }
    }
    expect(total).toBeGreaterThan(150);
  });

  it('no pinta con el color de otra especie (un conejo nunca sale verde)', () => {
    const verde = api.PALETA_ANIMAL.verde.hex;
    expect(api.coloresDeRaza('conejo', 'Enano')).not.toContain('verde');
    expect(api.coloresDeRaza('perro', 'Labrador')).not.toContain('verde');
    expect(api.coloresDeRaza('gato', 'Persa')).not.toContain('verde');
    // Aunque el usuario escriba "conejo verde", el arte no usa el verde.
    expect(api.renderAnimalSVG('conejo', 'Enano', 'verde')).not.toContain(verde);
    expect(api.renderAnimalSVG('perro', 'Labrador', 'azul')).not.toContain(api.PALETA_ANIMAL.azul.hex);
  });

  it('respeta los colores realistas declarados por la raza', () => {
    expect(api.coloresDeRaza('perro', 'Dálmata')).toEqual(['blanco']);
    expect(api.coloresDeRaza('perro', 'Labrador')).toEqual(['dorado', 'chocolate', 'negro']);
    expect(api.coloresDeRaza('gato', 'Siamés')).toEqual(['crema']);
    // Un mestizo puede tener cualquier color de su especie.
    expect(api.coloresDeRaza('perro', 'Mestizo').length).toBe(api.COLORES_ESPECIE.perro.length);
  });

  it('usa el patrón de la raza y el color de contraste cuando no hay segundo color', () => {
    const dal = api.resuelveColor('perro', api.resuelveRaza('perro', 'Dálmata'), 'blanco');
    expect(dal.patron).toBe('moteado');
    expect(dal.secundario).toBe('negro');
    const siames = api.resuelveColor('gato', api.resuelveRaza('gato', 'Siamés'), '');
    expect(siames.patron).toBe('puntos');
    expect(siames.secundario).toBe('chocolate');
  });

  it('traduce el texto libre a colores reales y detecta el patrón', () => {
    const dos = api.resuelveColor('perro', api.resuelveRaza('perro', 'Mestizo'), 'café y blanco');
    expect(dos.principal).toBe('cafe');
    expect(dos.secundario).toBe('blanco');
    expect(dos.etiqueta).toBe('Café y Blanco');
    const atigrado = api.resuelveColor('gato', api.resuelveRaza('gato', 'Romadizo'), 'gato atigrado');
    expect(atigrado.principal).toBe('atigrado');
    expect(atigrado.patron).toBe('atigrado');
  });
});

describe('arte de animales: casos límite', () => {
  it('cae al animal genérico con datos vacíos, nulos o basura', () => {
    for (const [tipo, raza, color] of [
      [null, null, null],
      [undefined, undefined, undefined],
      ['', '', ''],
      ['unicornio', 'inexistente', 'colorin'],
      ['perro', 42, {}]
    ]) {
      svgValido(api.renderAnimalSVG(tipo, raza, color));
    }
    expect(api.resuelveRaza('perro', 'raza que no existe').nombre).toBe('Otra raza');
    expect(api.resuelveRaza('gato', null).nombre).toBe('Común Europeo');
    expect(api.resuelveColor('otro', api.resuelveRaza('otro', null), null).principal).toBe(
      api.COLORES_ESPECIE.otro[0]
    );
  });

  it('resuelve igual con tildes, mayúsculas y texto sobrante', () => {
    expect(api.resuelveRaza('perro', 'PASTOR ALEMÁN').id).toBe('pastor_aleman');
    expect(api.resuelveRaza('perro', 'mi labrador dorado').id).toBe('labrador');
    expect(api.resuelveRaza('gato', 'común europeo').id).toBe('comun_europeo');
    expect(api.normalizaArt('Café')).toBe('cafe');
  });

  it('es determinista y genera ids de recorte distintos por combinación', () => {
    const a = api.renderAnimalSVG('perro', 'Pug', 'arena');
    expect(api.renderAnimalSVG('perro', 'Pug', 'arena')).toBe(a);
    expect(a).not.toBe(api.renderAnimalSVG('perro', 'Husky Siberiano', 'gris'));
  });

  it('expone razas y colores para la interfaz', () => {
    const perros = api.razasDeTipo('perro');
    expect(perros.length).toBe(api.RAZAS_DEF.perro.length);
    expect(perros.every(r => r.id && r.nombre && r.colores.length > 0)).toBe(true);
    expect(api.razasDeTipo('inexistente')).toEqual(api.razasDeTipo('otro'));
  });
});
