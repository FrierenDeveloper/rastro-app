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
  incremental: true,
  // Explícito aunque sea el valor por defecto del runner de Vitest: cada mutante
  // ejecuta únicamente las pruebas que lo cubren, que es lo que hace viable esta
  // suite (con "all" cada mutante correría las 763 pruebas).
  coverageAnalysis: 'perTest',
  // El sandbox (la copia de trabajo que Stryker crea en cada corrida) se deja
  // FUERA del repo a propósito: el proyecto vive dentro de OneDrive y, dentro de
  // una carpeta sincronizada, OneDrive intentaría subir los archivos temporales
  // mientras se ejecutan las pruebas. En %TEMP% no molesta a nadie. Se sigue
  // borrando al terminar (cleanTempDir).
  tempDirName: path.join(os.tmpdir(), 'stryker-rastro'),
  cleanTempDir: true,
  // Mutantes "estáticos": código que se ejecuta UNA sola vez al cargar el módulo
  // (tablas y constantes, configuración leída del entorno, funciones de
  // normalización de nivel de módulo...). Se ignoran por defecto porque un test
  // que importa el módulo una vez no puede observarlos: solo engordarían el
  // denominador sin que nadie los mire. Están fichados: 178 entre busqueda.js
  // (20), routes/push.js (20), routes/reports.js (135) y 3 sueltos.
  //
  // Para ver la foto REAL (y poder trabajarlos recargando el módulo dentro del
  // test con el patrón cargar(): new Module + _compile):
  //   STRYKER_ESTATICOS=1 npm run test:mutation
  // OJO: al incluirlos el score oficial BAJA, porque los que sobreviven entran
  // en el denominador. La métrica honesta mientras tanto es muertos/generados.
  ignoreStatic: process.env.STRYKER_ESTATICOS !== '1'
};
