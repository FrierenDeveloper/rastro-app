// Mutación solo sobre los archivos que han cambiado (según git diff).
//
// Uso: npm run test:mutation:changed
//
// Compara contra la rama principal (origin/main o main) y añade los cambios sin
// commitear, filtra los archivos mutables y llama a Stryker con esa lista. Si no
// hay nada que mutar, sale sin error (no tiene sentido fallar por eso).
const { execFileSync, spawnSync } = require('node:child_process');

// Archivos que Stryker puede mutar (los mismos que stryker.config.mjs).
// OJO: `git diff` devuelve rutas relativas a la RAÍZ del repo
// ("backend/routes/auth.js"), pero Stryker se ejecuta desde backend/ y espera
// rutas relativas a backend/ ("routes/auth.js"). Hay que quitar el prefijo.
const MUTABLES = /^(busqueda|db|storage|push|mailer)\.js$|^(middleware|routes)\/.*\.js$/;
const PREFIJO = /^backend\//;

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function archivosCambiados() {
  const listas = [
    git(['diff', '--name-only', 'origin/main...HEAD']),
    git(['diff', '--name-only', 'main...HEAD']),
    git(['diff', '--name-only', 'HEAD']),
    git(['diff', '--name-only', '--cached'])
  ];
  const todos = listas
    .join('\n')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
  return [...new Set(todos)].map(f => f.replace(PREFIJO, ''));
}

const mutables = archivosCambiados()
  .filter(f => MUTABLES.test(f))
  .filter(f => f.endsWith('.js'));

if (!mutables.length) {
  console.log('[mutation:changed] No hay archivos mutables modificados. Nada que hacer.');
  process.exit(0);
}

console.log('[mutation:changed] Mutando ' + mutables.length + ' archivo(s):');
for (const f of mutables) console.log('  - ' + f);

const resultado = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['stryker', 'run', '--mutate', mutables.join(',')],
  { stdio: 'inherit' }
);
process.exit(resultado.status === null ? 1 : resultado.status);
