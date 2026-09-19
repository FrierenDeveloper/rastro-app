// Configuración de ESLint (formato plano, ESLint 10).
// Vive en la RAÍZ del proyecto a propósito: ESLint ignora todo archivo que esté
// fuera del directorio donde está su configuración, y necesitamos lint-ear
// backend/ y frontend/ con las mismas reglas.
//
// ============================================================================
// REGLAS INNEGOCIABLES DEL PROYECTO (ley local, ver docs/ARNES_DETERMINISTA.md)
// ============================================================================
//   * Complejidad ciclomática de una función > 5  -> ERROR (no warning)
//   * Función de más de 20 líneas                  -> ERROR (no warning)
//
// Se aplican a TODO el código JavaScript: backend y frontend. El frontend no se
// queda fuera del linter aunque esté excluido de la métrica de cobertura (la ley
// lo pide así: la interfaz se lint-ea, pero no se le exige 100% de cobertura).
//
// Los comentarios y las líneas en blanco NO cuentan para el límite de 20 líneas:
// el código está muy comentado a propósito y contar comentarios castigaría la
// documentación.
// ============================================================================

// Variables globales del entorno Node (backend).
const GLOBALS_NODE = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
  process: 'readonly',
  console: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
  Buffer: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  setImmediate: 'readonly',
  fetch: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  AbortController: 'readonly',
  FormData: 'readonly',
  Blob: 'readonly',
  TextEncoder: 'readonly',
  global: 'readonly'
};

// Variables globales del navegador (frontend: app.js, sw.js).
const GLOBALS_BROWSER = {
  window: 'readonly',
  document: 'readonly',
  navigator: 'readonly',
  localStorage: 'readonly',
  sessionStorage: 'readonly',
  location: 'readonly',
  history: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setInterval: 'readonly',
  clearInterval: 'readonly',
  requestAnimationFrame: 'readonly',
  Notification: 'readonly',
  Image: 'readonly',
  FileReader: 'readonly',
  Blob: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  FormData: 'readonly',
  CustomEvent: 'readonly',
  Event: 'readonly',
  confirm: 'readonly',
  alert: 'readonly',
  CSS: 'readonly',
  atob: 'readonly',
  self: 'readonly',
  caches: 'readonly',
  clients: 'readonly',
  L: 'readonly',
  google: 'readonly'
};

const REGLAS_INNEGOCIABLES = {
  // --- Las dos reglas de la ley ---
  complexity: ['error', { max: 5 }],
  'max-lines-per-function': ['error', { max: 20, skipBlankLines: true, skipComments: true }],

  // --- Corrección (errores reales, no estilo: el estilo lo hace Prettier) ---
  'no-undef': 'error',
  'no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    // Un `catch (err)` que no usa el error es normal (solo se ignora la falla).
    // Exigir renombrarlo a `_err` obligaría a tocar código sin motivo real.
    caughtErrors: 'none'
  }],
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unreachable': 'error',
  'no-cond-assign': 'error',
  'no-constant-condition': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-fallthrough': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  // Detecta condiciones de carrera reales, pero en Express marca como sospechoso
  // el patrón `req.algo = x` después de un await (req es por petición, no hay
  // carrera). Se deja como aviso para no obligar a reescribir código correcto.
  'require-atomic-updates': 'warn',
  'no-await-in-loop': 'warn'
};

export default [
  {
    // node_modules y los artefactos de las pruebas no se lint-ean.
    ignores: ['**/node_modules/**', 'backend/coverage/**', 'backend/reports/**', 'backend/.stryker-tmp/**', 'backend/uploads/**']
  },
  {
    // Backend: CommonJS sobre Node.
    files: ['backend/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: GLOBALS_NODE },
    rules: REGLAS_INNEGOCIABLES
  },
  {
    // Frontend: navegador, cargado como <script> clásico (no módulos).
    files: ['frontend/**/*.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: GLOBALS_BROWSER },
    rules: {
      ...REGLAS_INNEGOCIABLES,
      // app.js y sw.js se cargan como scripts clásicos: sus funciones de nivel
      // superior son globales a propósito.
      'no-implicit-globals': 'off'
    }
  },
  {
    // Las pruebas pueden tener funciones más largas (organizar casos), pero
    // mantienen la complejidad baja.
    files: ['backend/tests/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        ...GLOBALS_NODE,
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        vi: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly'
      }
    },
    rules: { ...REGLAS_INNEGOCIABLES, 'max-lines-per-function': 'off' }
  }
];
