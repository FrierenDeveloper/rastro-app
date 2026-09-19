// Vitest + cobertura v8.
//
// REGLAS DEL PROYECTO (ver AGENTS.md):
//   * La cobertura actual es el UMBRAL MÍNIMO: solo puede subir, nunca bajar.
//   * El frontend queda EXCLUIDO de la métrica (es interfaz).
//   * El código nuevo de backend/src/v2/ exige 100%.
//
// Como el umbral es un "trinquete" (ratchet), si añades código nuevo sin pruebas
// el porcentaje baja y el pipeline falla. Para subirlo: cambia estos números a la
// baja NUNCA; solo al alza, y solo después de que la cobertura real suba.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      reportsDirectory: 'reports/coverage',
      // Lo que entra en la métrica (el frontend NO está aquí a propósito).
      include: [
        'busqueda.js',
        'db.js',
        'storage.js',
        'push.js',
        'mailer.js',
        'middleware/**/*.js',
        'routes/**/*.js',
        'src/v2/**/*.js'
      ],
      exclude: ['server.js', 'scripts/**', 'tests/**', '**/node_modules/**'],
      thresholds: {
        // Medido el 2026-09-18 tras estabilizar el formato:
        //   lines/statements 6.29% (134/2130), functions 26.66%, branches 65.71%
        // Se fija con un margen mínimo a la baja para tolerar redondeos.
        // Trinquete: estos números NUNCA bajan, solo suben.
        lines: 6.2,
        statements: 6.2,
        functions: 26.6,
        branches: 65.7,
        // Código nuevo: 100% obligatorio.
        'src/v2/**/*.js': {
          lines: 100,
          statements: 100,
          functions: 100,
          branches: 100
        }
      }
    }
  }
});
