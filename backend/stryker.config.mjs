// Configuración de Stryker Mutator (pruebas de mutación).
//
// Qué hace: modifica a propósito el código (cambia un `<=` por `<`, un `+` por
// `-`, borra una condición...) y comprueba si las pruebas detectan el cambio.
// Si un mutante "sobrevive", significa que hay código que ninguna prueba cubre
// de verdad: cobertura alta con mutación baja = pruebas que ejecutan líneas sin
// comprobar su comportamiento.
//
// Umbrales: la ley exige 100% en COBERTURA; para mutación se parte de un umbral
// exigente pero alcanzable (el 100% de mutación no es realista en código con
// ramas defensivas). Se puede subir cuando la suite madure.
//
// ============================================================================
// ¡NO SUBIR VITEST A LA V5! (averiguado a la mala)
// ============================================================================
// @stryker-mutator/vitest-runner@10.0.0 dice en su peerDependencies que soporta
// "vitest >=2.0.0", pero con Vitest 5 el runner EXPLOTA al inicializar:
//
//   TypeError: Converting circular structure to JSON
//     at VitestTestRunner.init
//     resolvedProjects -> viteConfig -> test (referencia circular)
//
// Vitest 5 añade "resolvedProjects" a su configuración y el runner intenta
// serializarla con JSON.stringify. El error hace que NO se ejecute ni una prueba
// y que TODOS los mutantes sobrevivan, dando un 0% falso (y bloqueando commits
// por un dato que no es real). Con Vitest 3.2.7 funciona: ~2 pruebas por mutante
// y el score real. Por eso package.json fija "vitest": "^3".
//
// Si algún día hay que subir Vitest: comprobar PRIMERO que el score de mutación
// sigue siendo un número real (si vuelve a 0.00% con "0.00 tests per mutant", es
// este mismo bug).
// ============================================================================
//
// Stryker 10 no exporta un helper defineConfig: se exporta el objeto directo.
import os from 'node:os';
import path from 'node:path';

export default {
  testRunner: 'vitest',
  // Solo se mutan los archivos que la ley considera lógica/servicios/endpoints.
  mutate: [
    'busqueda.js',
    'db.js',
    'storage.js',
    'push.js',
    'mailer.js',
    'middleware/**/*.js',
    'routes/**/*.js'
  ],
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/mutation.json' },
  thresholds: {
    high: 90,
    low: 80,
    break: 80
  },
  timeoutMS: 20000,
  // Hilos en paralelo. La máquina de desarrollo (Ryzen 5 5600X) tiene 6 núcleos
  // y 12 hilos, así que en local se usan 12; el runner de GitHub Actions solo
  // tiene 2-4 vCPU, y allí 12 procesos no aceleran nada: agotan la memoria y
  // provocan timeouts (mutantes que "sobreviven" por lentitud, no por falta de
  // pruebas). Se puede forzar sin tocar este archivo:
  //   STRIKER_CONCURRENCY=4 npm run test:mutation
  concurrency: Number(process.env.STRIKER_CONCURRENCY) || (process.env.CI ? 2 : 12),
  // Caché incremental (reports/stryker-incremental.json, dentro de
  // backend/reports/, que git ignora): reutiliza el resultado de los mutantes
  // cuyo código y pruebas no cambiaron. La primera pasada cuesta lo mismo y las
  // siguientes tardan segundos. En CI no aporta (no hay caché entre jobs).
  // En la corrida estricta se desactiva a propósito: guarda un resultado por
  // mutante y los de perTest y 'all' no son comparables (un mutante "muerto" con
  // perTest puede ser un falso superviviente), así que mezclarlos daría un
  // informe incoherente.
  incremental: process.env.STRYKER_ESTRICTO !== '1',
  // Cómo elige Stryker las pruebas que ejecuta con cada mutante:
  //   'perTest' (por defecto): solo las que cubren esa línea. Es lo que hace
  //     viable esta suite (con 'all' cada mutante correría las 775 pruebas).
  //     PERO atribuye mal la cobertura del código que se ejecuta al CARGAR el
  //     módulo (declaraciones de rutas, constantes leídas del entorno): esos
  //     mutantes salen como supervivientes aunque las pruebas sí los maten.
  //     Medido en routes/admin.js: con perTest 89,29% y 12 vivos; con 'all'
  //     97,32% y 3 vivos. Los otros 9 eran FALSOS supervivientes.
  //   'all': cada mutante corre toda la suite. Da el número honesto a costa de
  //     ~6x más tiempo (inviable en CI, que tiene 2 vCPU), así que se pide a
  //     mano cuando se quiere la foto real:
  //       STRYKER_ESTRICTO=1 npm run test:mutation
  coverageAnalysis: process.env.STRYKER_ESTRICTO === '1' ? 'all' : 'perTest',
  // El sandbox (la copia de trabajo que Stryker crea en cada corrida) se deja
  // FUERA del repo a propósito: el proyecto vive dentro de OneDrive y, dentro de
  // una carpeta sincronizada, OneDrive intentaría subir los archivos temporales
  // mientras se ejecutan las pruebas. En %TEMP% no molesta a nadie. Se sigue
  // borrando al terminar (cleanTempDir).
  tempDirName: path.join(os.tmpdir(), 'stryker-rastro'),
  cleanTempDir: true,
  // Mutantes "estáticos": código que se ejecuta UNA sola vez al cargar el módulo
  // (tablas y constantes, configuración leída del entorno, funciones de
  // normalización de nivel de módulo...). Se miden POR DEFECTO: estuvieron
  // ignorados un tiempo y, al medirlos, resultó que 165 de los 178 los matan las
  // pruebas que ya existían; solo sobreviven 13. El score oficial pasa de 92,82%
  // a 92,78% (muy por encima del break 80) y a cambio el denominador deja de
  // estar maquillado. Para volver al comportamiento antiguo:
  //   STRYKER_IGNORAR_ESTATICOS=1 npm run test:mutation
  ignoreStatic: process.env.STRYKER_IGNORAR_ESTATICOS === '1'
};
