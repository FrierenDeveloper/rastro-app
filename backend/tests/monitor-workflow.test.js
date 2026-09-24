import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// El "vigilante" de disponibilidad es infraestructura, no código: vive en un
// workflow de GitHub Actions. Esta prueba lo lee como texto para que una edición
// futura no borre el chequeo de salud, el aviso ni la limpieza de la credencial
// escrita a mano.
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workflowPath = path.join(raiz, '.github', 'workflows', 'monitor-uptime.yml');
const workflow = fs.existsSync(workflowPath) ? fs.readFileSync(workflowPath, 'utf8') : '';

describe('workflow de vigilancia (uptime)', () => {
  it('revisa la salud de la app de forma periódica y también a mano', () => {
    expect(fs.existsSync(workflowPath)).toBe(true);
    expect(workflow).toContain('schedule:');
    expect(workflow).toMatch(/cron: ['"]?\*\/\d+ \* \* \* \*/);
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('/api/health');
    expect(workflow).toContain('"ok":true');
  });

  it('avisa cuando la app no responde y deja constancia reabrible', () => {
    expect(workflow).toContain('::error::');
    expect(workflow).toContain('if: failure()');
    expect(workflow).toContain('api.telegram.org');
    expect(workflow).toContain('gh issue create');
    expect(workflow).toContain('gh issue comment');
  });

  it('cierra el aviso cuando la app se recupera', () => {
    expect(workflow).toContain('if: success()');
    expect(workflow).toContain('gh issue close');
  });

  it('no incluye credenciales ni tokens escritos a mano', () => {
    expect(workflow).toMatch(/secrets\.TELEGRAM_BOT_TOKEN/);
    expect(workflow).toMatch(/secrets\.TELEGRAM_CHAT_ID/);
    expect(workflow).not.toMatch(/bot\d{6,}:[A-Za-z0-9_-]{10,}/);
    expect(workflow).not.toMatch(/TELEGRAM_BOT_TOKEN:\s*[A-Za-z0-9]/);
    expect(workflow).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
  });
});
