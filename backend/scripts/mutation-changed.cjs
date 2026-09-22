// Mutación solo sobre los archivos que han cambiado (según git diff).
//
// Uso: npm run test:mutation:changed
//
// Compara contra la rama principal (origin/main o main) y añade los cambios sin
// commitear, filtra los archivos mutables y llama a Stryker con esa lista. Si no
// hay nada que mutar, sale sin error (no tiene sentido fallar por eso).
//
// DOS TRAMPAS QUE ESTE SCRIPT YA RESUELVE (y que costaron una tarde):
//
//   1. El CLI de Stryker IGNORA --mutate: la configuración del proyecto lee
//      STRYKER_MUTAR. Y por esa vía solo funciona UN archivo: con una lista
//      separada por comas Stryker vuelve a mutarlo todo, en silencio. Por eso la
//      lista viaja en una configuración temporal que extiende la del proyecto
//      (el formato nativo de `mutate` es una lista) y se borra al terminar.
//   2. En Windows, spawnSync('npx.cmd') devuelve EINVAL en Node 24 (endureció el
//      lanzamiento de .cmd/.bat). Se lanza a través del shell.
//
// OJO con la caché: Stryker reutiliza reports/stryker-incremental.json, así que
// además de poder reportar un número viejo, el informe puede arrastrar archivos
// de corridas anteriores. Para una medición limpia, borra ese archivo antes (o
// lanza `npx stryker run --force`).
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Archivos que Stryker puede mutar (los mismos que stryker.config.mjs).
// OJO: `git diff` devuelve rutas relativas a la RAÍZ del repo
// ("backend/routes/auth.js"), pero Stryker se ejecuta desde backend/ y espera
// rutas relativas a backend/ ("routes/auth.js"). Hay que quitar el prefijo.
const MUTABLES = /^(busqueda|db|storage|push|mailer)\.js$|^(middleware|routes)\/.*\.js$/;
const PREFIJO = /^backend\//;
// Dentro de backend/ (que es el directorio desde el que corre Stryker).
const CONFIG_TEMPORAL = path.join('reports', 'stryker-changed.config.mjs');

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

// Escribe la configuración temporal: la del proyecto con `mutate` cambiado.
// Se importa la original para no duplicar umbrales, reporteros ni exclusiones.
function escribirConfigTemporal(mutables) {
  fs.mkdirSync(path.dirname(CONFIG_TEMPORAL), { recursive: true });
  fs.writeFileSync(
    CONFIG_TEMPORAL,
    [
      "import base from '../stryker.config.mjs';",
      '',
      '// Generado por scripts/mutation-changed.cjs: no editar a mano.',
      `export default { ...base, mutate: ${JSON.stringify(mutables)} };`,
      ''
    ].join('\n')
  );
}

function borrarConfigTemporal() {
  try {
    fs.unlinkSync(CONFIG_TEMPORAL);
  } catch {
    /* ya no está: nada que limpiar */
  }
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

escribirConfigTemporal(mutables);

// shell: por el EINVAL de Node 24 al lanzar npx en Windows. La configuración va
// como argumento posicional: `stryker run [configFile]`.
const resultado = spawnSync('npx', ['stryker', 'run', CONFIG_TEMPORAL.replace(/\\/g, '/')], {
  stdio: 'inherit',
  shell: true
});

borrarConfigTemporal();
process.exit(resultado.status === null ? 1 : resultado.status);
