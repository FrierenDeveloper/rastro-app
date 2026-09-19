# AGENTS.md — reglas permanentes del proyecto

Estas reglas son **obligatorias** para cualquier persona o agente que toque este
repositorio. No se cambian sin aprobación explícita (el pre-commit bloquea las
modificaciones a este archivo y a toda la configuración del arnés).

## Cómo trabajar

1. **Tests primero.** Escribe primero las pruebas y luego el código. Cada
   funcionalidad necesita su caso normal **y** los casos límite: vacío, `null`,
   formato inválido y usuario sin permisos.
2. **Toca solo los archivos necesarios.** No leas el resto del proyecto para
   "entender el contexto": abre solo lo que vas a modificar.
3. **Ejecuta `npm run verify` y corrige hasta que pase.** Formato, lint y tests
   con cobertura. Si falla, se arregla; no se ignora.
4. **Nunca cambies la configuración, los umbrales ni las reglas de lint.**
   Prohibido `eslint-disable` y `istanbul/c8 ignore`: si una regla molesta, se
   arregla el código, no la regla. (Los `eslint-disable` no funcionan: la
   configuración tiene `noInlineConfig`.)
5. **Al terminar, ejecuta `npm run test:mutation:changed`** y corrige los
   mutantes que sobrevivan.
6. **El código nuevo va en `backend/src/v2/`** y exige **100% de cobertura**
   (líneas, ramas, funciones y sentencias). No se negocia por archivo.
7. **Respuesta final: máximo 3 líneas + la lista de archivos modificados.**

## Comandos

```bash
cd backend
npm run verify                  # formato -> lint -> tests con cobertura
npm run test:unit               # tests sin cobertura (rápido)
npm run test:mutation           # mutación de todo (lento)
npm run test:mutation:changed   # mutación solo de lo que cambió (git diff)
npm run format:write            # arregla el formato
npm run lint                    # lint completo (incluye avisos de deuda)
```

## Reglas del arnés

| Regla                         | Valor                                                             | Nivel |
| ----------------------------- | ----------------------------------------------------------------- | ----- |
| `complexity`                  | máximo **10**                                                     | error |
| `max-lines-per-function`      | máximo **50** líneas (sin contar comentarios ni líneas en blanco) | error |
| `eslint-disable`              | prohibido                                                         | error |
| Cobertura (backend)           | **trinquete**: el valor actual es el mínimo; solo sube            | error |
| Cobertura (`backend/src/v2/`) | **100%**                                                          | error |
| Mutación                      | umbral `break: 80`                                                | error |

**Deuda aceptada**: algunos archivos que ya existían superan los máximos o tienen
código sin usar. Para ellos la regla baja a _warning_ (no bloquea) y están
listados en `eslint.config.mjs`. Ese archivo no se toca sin aprobación.

El frontend (`frontend/`) queda **fuera de la métrica de cobertura** (es
interfaz) pero **sí pasa por el linter**.

## Dos trampas conocidas (no repetir)

- **No subas Vitest a la v5.** `@stryker-mutator/vitest-runner@10` revienta con
  `Converting circular structure to JSON` y entonces **no ejecuta ni una prueba**:
  todos los mutantes sobreviven y el score sale `0.00%` (falso). Por eso
  `package.json` fija `vitest@^3`. Si subes Vitest, comprueba que la mutación
  siga dando un número real (que no diga `0.00 tests per mutant`).
- **La config de ESLint vive en la raíz**, no en `backend/`: ESLint 10 ignora los
  archivos que están fuera del directorio de su configuración, así que desde
  `backend/` no se puede lint-ear `frontend/`.

## Antes de commitear

El hook de pre-commit hace: bloqueo de cambios de configuración → formato y lint
de los archivos modificados (lint-staged) → tests rápidos. Los tests de mutación
**no** se corren ahí (tardan); van en GitHub Actions y a mano con
`test:mutation:changed`.
