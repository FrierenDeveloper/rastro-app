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
  concurrency: 2,
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  ignoreStatic: true
};
