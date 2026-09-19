# Arnés determinístico (LEY DEL PROYECTO)

> Esta es una **ley local del proyecto**, no una sugerencia. El comando
> `npm run verify:harness` es la única puerta de entrada para dar algo por bueno,
> y el hook de git impide commitear si falla.
> Creada el 18 de septiembre de 2026.

---

## 1. Comando único

```bash
cd backend
npm run verify:harness
```

Corre **en orden** y **para en el primer fallo** (determinista: siempre lo mismo,
en el mismo orden):

| # | Paso | Comando | Qué exige |
|---|------|---------|-----------|
| 1 | Formateo | `npm run format:check` | Todo el código pasa Prettier |
| 2 | Linter | `npm run lint` | Cero errores de ESLint |
| 3 | Pruebas + cobertura | `npm run test:coverage` | **100%** en lógica/servicios/endpoints |
| 4 | Mutación | `npm run test:mutation` | Score de mutación ≥ 80% |

Pasos individuales, para trabajar:

```bash
npm run format:write   # arregla el formato automáticamente
npm run lint:fix       # arregla lo que ESLint pueda arreglar solo
npm run test:unit      # pruebas sin cobertura (rápido)
npm run test:coverage  # pruebas con cobertura
npm run test:mutation  # mutación
```

---

## 2. Reglas innegociables

### 2.1 Lógica estricta (ESLint, en `eslint.config.mjs` de la raíz)

| Regla | Valor | Nivel |
|---|---|---|
| `complexity` (complejidad ciclomática) | **máx. 5** | **error** |
| `max-lines-per-function` | **máx. 20 líneas** | **error** |

Son **error, no warning**: el pipeline falla. Los comentarios y las líneas en
blanco **no cuentan** para el límite de 20 líneas (el código está muy comentado
a propósito y contar comentarios castigaría la documentación).

Se aplican a **backend y frontend**. La config vive en la **raíz** porque ESLint
10 ignora todo archivo que esté fuera del directorio de su configuración, y hay
que lint-ear `backend/` y `frontend/` con las mismas reglas.

### 2.2 Cobertura segmentada (Vitest, en `backend/vitest.config.mjs`)

**100% obligatorio** (statements, branches, functions, lines) en:

```
backend/busqueda.js          lógica de negocio
backend/db.js                acceso a datos
backend/storage.js           servicio de fotos
backend/push.js              servicio de notificaciones
backend/mailer.js            servicio de correo
backend/middleware/**/*.js   servicios transversales (auth, IP, límites)
backend/routes/**/*.js       endpoints de la API
```

**Excluido de la métrica del 100%, con motivo** (no es un agujero: es la parte
de interfaz y de arranque):

| Excluido | Por qué |
|---|---|
| `frontend/**` | Es interfaz. La ley pide excluir la UI de la métrica del 100%… pero **sigue sujeta al linter** (paso 2). |
| `backend/server.js` | Es el arranque/composición (monta middlewares y hace `listen`), no lógica de negocio. Lo cubre el smoke test de integración. |
| `backend/scripts/**` | Herramientas de desarrollo (generar VAPID, smoke test), no parte de la app desplegada. |
| `tests/**` | Son las propias pruebas. |

### 2.3 Mutación (Stryker, en `backend/stryker.config.mjs`)

Umbral actual: `break: 80`, `high: 90`, `low: 80`.

**⚠️ NO SUBIR VITEST A LA V5.** El runner `@stryker-mutator/vitest-runner@10.0.0`
declara soportar `vitest >=2.0.0`, pero con Vitest 5 revienta con
`Converting circular structure to JSON` en `VitestTestRunner.init` (Vitest 5 añade
`resolvedProjects` y el runner intenta serializarlo). Resultado: **no ejecuta ni
una prueba y da un 0% falso**. Por eso `package.json` fija `"vitest": "^3"`.
Si se sube Vitest, comprobar que el score sigue siendo un número real (que no
aparezca `0.00 tests per mutant`).

---

## 3. Hook de git

`.husky/pre-commit` corre `npm run verify:harness` y **bloquea el commit** si
falla. No se salta con `--no-verify`.

Si falta `backend/node_modules` (clon nuevo sin instalar), el hook **avisa y deja
pasar** el commit: no queremos romper el flujo a quien todavía no preparó el
entorno. Con el entorno instalado, sí bloquea.

---

## 4. Estado actual (línea base medida el 2026-09-18)

El arnés está **operativo**: corre los 4 pasos y para en el primero que falla.
Pero **el código todavía NO cumple la ley** en ninguno de los cuatro:

| Paso | Resultado real | Qué falta |
|---|---|---|
| 1. Formato | **FALLA** — 17 archivos sin formatear | `npm run format:write` (mecánico) |
| 2. Lint | **FALLA** — 93 errores, 2 warnings | Partir funciones y bajar complejidad (**toca código**) |
| 3. Cobertura | **FALLA** — 2,53% (se exige 100%) | Escribir pruebas para ~1000 líneas de backend |
| 4. Mutación | **FALLA** — 76,39% (se exige 80%) | Más pruebas; 17 mutantes sobrevivientes en `busqueda.js` |

Consecuencia: **con el hook activo no se puede commitear** hasta pagar esta
deuda. Es el efecto que pidió la ley. El plan para pagarla está en el punto
siguiente.

---

## 5. Plan para cumplir la ley (en este orden)

1. **Formato** (minutos, no cambia lógica): `npm run format:write`.
2. **Refactor de lint** (toca código funcional): partir las funciones largas y
   bajar la complejidad. Los peores son `routes/reports.js`, `routes/auth.js` y
   `db.js::init` (141 líneas).
3. **Pruebas de cobertura**: unitarias para `busqueda.js`, `middleware/*`,
   `storage.js`, `mailer.js`, `push.js`, `db.js`, y de endpoints con
   `supertest` para `routes/*`.
4. **Mutación**: subir de 76% a 80%+ cerrando los 17 mutantes sobrevivientes.

Los pasos 2, 3 y 4 **modifican o añaden código**, por eso no se hicieron al
instalar el arnés.
