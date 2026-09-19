// Configuración de Vitest + cobertura.
//
// ============================================================================
// COBERTURA SEGMENTADA (ley local, ver docs/ARNES_DETERMINISTA.md)
// ============================================================================
// El 100% se exige SOLO a la lógica de negocio, servicios, utilidades y
// endpoints. Los archivos de interfaz (frontend/) quedan FUERA de la métrica de
// cobertura, pero siguen sujetos al linter.
//
// Qué se mide (100% obligatorio):
//   busqueda.js            lógica de negocio (radio de búsqueda)
//   db.js                  acceso a datos
//   storage.js             servicio de fotos
//   push.js                servicio de notificaciones
//   mailer.js              servicio de correo
//   middleware/**/*.js     servicios transversales (auth, IP, límites)
//   routes/**/*.js         endpoints de la API
//
// Qué NO se mide, y por qué (exclusiones justificadas, no un agujero):
//   server.js    es el arranque/composición de la app, no lógica de negocio:
//                monta middlewares y llama a listen(). Se cubre con el smoke
//                test de integración, no con unitarios.
//   scripts/**   son herramientas de desarrollo (generar claves VAPID, smoke
//                test), no forman parte de la app que se despliega.
//   frontend/**  es interfaz: la ley pide excluirla de la métrica del 100%.
//                Sigue cubierta por ESLint.
//   tests/**     son las propias pruebas.
// ============================================================================
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    // Determinista: si no hay pruebas, el paso FALLA (no se da por bueno).
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      reportsDirectory: 'reports/coverage',
      // Todo lo que entra en la métrica. Los archivos sin pruebas también se
      // reportan (si no, un archivo sin tocar aparecería como 100%).
      include: [
        'busqueda.js',
        'db.js',
        'storage.js',
        'push.js',
        'mailer.js',
        'middleware/**/*.js',
        'routes/**/*.js'
      ],
      exclude: ['server.js', 'scripts/**', 'tests/**', '**/node_modules/**'],
      // 100% estricto: cualquier línea, rama o función sin cubrir rompe el arnés.
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100
      }
    }
  }
});
