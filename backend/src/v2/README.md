# backend/src/v2/ — código nuevo

Todo el código nuevo del backend va aquí. Tiene **100% de cobertura obligatorio**
(líneas, ramas, funciones y sentencias), sin excepciones por archivo.

Reglas (ver `AGENTS.md`):

1. **Escribe primero las pruebas** de cada función, con su caso normal y los
   casos límite: vacío, `null`, formato inválido y usuario sin permisos.
2. `complexity` máximo **10** y **50 líneas** por función (error, no warning).
3. Nada de `eslint-disable` ni de `istanbul ignore`: no funcionan (la config
   tiene `noInlineConfig`).
4. Antes de dar algo por terminado: `npm run verify` y
   `npm run test:mutation:changed`.

Las pruebas de lo que vivas aquí van en `backend/tests/` (Vitest las descubre
con el patrón `tests/**/*.test.js`).
