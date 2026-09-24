import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// El respaldo automático de la base es infraestructura, no código: vive en un
// workflow de GitHub Actions. Esta prueba lo lee como texto para evitar que una
// edición futura borre el horario, el volcado o las salvaguardas sin que nadie
// se entere (y para que nunca se cuele una credencial escrita a mano).
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = path.join(raiz, '.github', 'workflows', 'backup-db.yml');
const workflow = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : '';

describe('workflow de respaldo de la base', () => {
  it('se ejecuta todos los días y también a mano', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    expect(workflow).toContain('schedule:');
    expect(workflow).toMatch(/cron: ['"]?\d+ \d+ \* \* \*/);
    expect(workflow).toContain('workflow_dispatch:');
  });

  it('vuelca la base con pg_dump y aborta si el respaldo queda vacío', () => {
    expect(workflow).toContain('pg_dump');
    expect(workflow).toContain('${{ secrets.DATABASE_URL }}');
    expect(workflow).toContain('gzip');
    expect(workflow).toContain('::error::');
  });

  it('guarda los respaldos en un bucket privado aparte de las fotos', () => {
    expect(workflow).toContain('R2_BACKUP_BUCKET');
    expect(workflow).toContain('r2.cloudflarestorage.com');
    expect(workflow).not.toContain('R2_BUCKET');
  });

  it('no incluye credenciales ni cadenas de conexión escritas a mano', () => {
    expect(workflow).not.toMatch(/postgres(ql)?:\/\//);
    expect(workflow).not.toMatch(/R2_SECRET_ACCESS_KEY:\s*[A-Za-z0-9]/);
    expect(workflow).not.toMatch(/AWS_SECRET_ACCESS_KEY:\s*[A-Za-z0-9]/);
  });
});
