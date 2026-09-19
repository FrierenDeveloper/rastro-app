// Configuración de ESLint (formato plano, ESLint 10). Vive en la RAÍZ porque
// ESLint 10 ignora todo archivo que esté fuera del directorio de su config.
//
// REGLAS (ver AGENTS.md):
//   * complexity                 máximo 10   -> error
//   * max-lines-per-function      máximo 50   -> error
//   * prohibido eslint-disable    -> error (noInlineConfig)
//
// Los archivos que ya existían y no cumplen se listan abajo en "DEUDA ACEPTADA":
// para ellos la regla baja a WARNING (no rompen el pipeline) hasta que se
// arreglen. Cualquier archivo NUEVO debe cumplir como error.

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

const REGLAS = {
  complexity: ['error', { max: 10 }],
  'max-lines-per-function': ['error', { max: 50, skipBlankLines: true, skipComments: true }],
  'no-undef': 'error',
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
  'no-redeclare': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-unreachable': 'error',
  'no-cond-assign': 'error',
  'no-empty': ['error', { allowEmptyCatch: true }],
  'no-fallthrough': 'error',
  'valid-typeof': 'error',
  'use-isnan': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'no-unsafe-negation': 'error',
  'require-atomic-updates': 'off'
};

// DEUDA ACEPTADA: archivos que YA existían y superan complexity 10, 50 líneas o
// tienen código sin usar. Para ellos la regla baja a WARNING (visible, no
// bloquea) hasta que se arreglen al tocarlos. Medido el 2026-09-18:
//   12 avisos de complexity  -> auth.js(3), reports.js(4), app.js(4), smoke-test.js(1)
//    2 avisos de tamaño      -> db.js(1), reports.js(1)
//    2 avisos de código muerto -> busqueda.js(1), server.js(1)
// No se pueden añadir archivos nuevos a esta lista sin aprobación explícita
// (el pre-commit bloquea cambios a este archivo de configuración).
const DEUDA_ACEPTADA = [
  'backend/routes/auth.js',
  'backend/routes/reports.js',
  'backend/scripts/smoke-test.js',
  'backend/db.js',
  'backend/busqueda.js',
  'backend/server.js',
  'frontend/app.js'
];
const REGLAS_DEUDA = {
  ...REGLAS,
  complexity: ['warn', { max: 10 }],
  'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true }],
  'no-unused-vars': ['warn', { argsIgnorePattern: '^_', caughtErrors: 'none' }]
};

export default [
  {
    // Nada de esto se lint-ea: dependencias, artefactos del arnés y las propias
    // configuraciones de las herramientas.
    ignores: [
      '**/node_modules/**',
      'backend/coverage/**',
      'backend/reports/**',
      'backend/.stryker-tmp/**',
      'backend/uploads/**',
      '.audit/**',
      '*.config.mjs',
      'eslint.config.mjs'
    ]
  },
  {
    files: ['backend/**/*.js'],
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: GLOBALS_NODE },
    rules: REGLAS
  },
  {
    files: ['frontend/**/*.js'],
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
    languageOptions: { ecmaVersion: 2023, sourceType: 'script', globals: GLOBALS_BROWSER },
    rules: { ...REGLAS, 'no-implicit-globals': 'off' }
  },
  {
    files: ['backend/tests/**/*.js'],
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'error' },
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
    rules: { ...REGLAS, 'max-lines-per-function': 'off' }
  },
  {
    files: DEUDA_ACEPTADA,
    rules: REGLAS_DEUDA
  }
];
