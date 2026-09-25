// Pruebas de la política CSP: en particular, que las fotos servidas desde R2
// estén permitidas sin abrir img-src a dominios arbitrarios.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { directivasCsp } = require('../src/v2/politica-csp.js');

describe('directivasCsp', () => {
  it('permite el origen público de R2 en imgSrc, sin conservar la ruta', () => {
    const directivas = directivasCsp('https://fotos.example.test/bucket/mascotas');

    expect(directivas.imgSrc).toContain('https://fotos.example.test');
    expect(directivas.imgSrc).not.toContain('https://fotos.example.test/bucket/mascotas');
  });

  it.each(['', null, undefined])('no añade origen R2 si falta (%s)', valor => {
    const directivas = directivasCsp(valor);

    expect(directivas.imgSrc).not.toContain('');
    expect(directivas.imgSrc).not.toContain('null');
    expect(directivas.imgSrc).not.toContain('undefined');
    expect(directivas.imgSrc).toContain("'self'");
  });

  it('ignora una URL inválida sin abrir imgSrc', () => {
    const directivas = directivasCsp('no-es-una-url');

    expect(directivas.imgSrc).not.toContain('no-es-una-url');
    expect(directivas.imgSrc).toContain('https://*.supabase.co');
  });

  it('conserva las directivas base requeridas por la aplicación', () => {
    const directivas = directivasCsp('');

    expect(directivas).toMatchObject({
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        'https://cdnjs.cloudflare.com',
        'https://unpkg.com',
        'https://accounts.google.com'
      ],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"]
    });
  });
});
