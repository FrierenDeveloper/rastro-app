# Estado del despliegue y accesos (documento de trabajo)

> **Nota para el desarrollador.** Este documento existe para dejar constancia,
> dentro del propio repositorio, de que **el asistente de IA (pi / el agente
> usado durante el desarrollo) conoce las cuentas de Supabase y Render de este
> proyecto** y del estado verificado del despliegue. Si no quieres que quede en
> el repo, bórralo o agrégalo a `.gitignore`.

Última revisión: **2026-09-18** (según fecha de la sesión de auditoría).

---

## 1. Qué conoce el asistente

El asistente de IA fue informado, durante la sesión de desarrollo, de la
existencia y el estado de las siguientes cuentas/servicios del proyecto:

| Servicio | Qué se le comunicó | Credenciales |
|----------|--------------------|--------------|
| **Supabase** | Que existe un proyecto Supabase en uso (base de datos Postgres + bucket de Storage `fotos`). | **No** se compartieron tokens, contraseñas ni la `service_role` key con el asistente. |
| **Render** | Que existe un Web Service desplegado en la URL pública de abajo. | **No** se compartió la API key de Render ni credenciales de la cuenta. |
| **GitHub** | Repositorio remoto `https://github.com/FrierenDeveloper/rastro-app`. | El asistente hizo `git commit` y `git push` desde la máquina local del desarrollador (con las credenciales ya configuradas por este). |

**Importante:** el asistente **no tiene acceso autónomo** a las cuentas de
Supabase ni de Render (no posee API tokens), y **no almacena** credenciales de
esas plataformas. Cualquier cambio sugerido en esos servicios debe ejecutarlo el
propio desarrollador. La única acción con efectos remotos que el asistente
realizó fue el `git push` al repositorio de GitHub, usando la configuración de
git local.

---

## 2. URL pública en producción

| Dato | Valor |
|------|-------|
| **URL de la app** | https://rastro-app.onrender.com/ |
| **Plataforma** | Render (plan Free) |
| **Root directory del servicio** | `backend` |
| **Build command** | `npm install` |
| **Start command** | `npm start` |
| **Health check** | `GET /api/health` |

---

## 3. Verificación del despliegue

Comprobaciones realizadas contra la URL pública:

| Comprobación | Resultado | Estado |
|--------------|-----------|--------|
| `GET /api/health` | `{"ok":true}` | ✅ |
| `GET /` (frontend PWA) | HTTP `200` | ✅ |
| `GET /manifest.json` | HTTP `200` | ✅ |
| `GET /sw.js` (service worker) | HTTP `200` | ✅ |
| Cabecera `Strict-Transport-Security` | presente (HTTPS) | ✅ |
| `Content-Security-Policy` (Helmet) | presente y ajustada a Leaflet/OSM/Google | ✅ |
| `X-Frame-Options` / `Referrer-Policy` | presentes | ✅ |
| Validación de registro (`POST /api/auth/register` con body vacío) | `{"error":"Correo inválido."}` HTTP `400` | ✅ |
| `GET /api/config` → `pushEnabled` | `false` | 🟠 pendiente |

### Pendientes detectados

- ✅ ~~Push deshabilitado~~ → RESUELTO en código salvo claves: `/api/config`
  devuelve `pushEnabled:false` porque `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`
  **no están configuradas** en Render. Hay que pegarlas en el panel.
- ✅ ~~`APP_URL`~~ → RESUELTO: el backend ahora usa `RENDER_EXTERNAL_URL`
  (que Render inyecta sola) como respaldo de `APP_URL`, así que "recuperar
  contraseña" ya funciona sin configurar nada a mano.

---

## 3.bis Prueba funcional completa (end-to-end)

Se ejecutó un flujo real contra producción (18/09/2026) con dos usuarios de
prueba, que se eliminaron al terminar (0 datos residuales):

| Prueba | Resultado |
|--------|-----------|
| `GET /api/health` | ✅ `{"ok":true}` |
| Registro de usuario | ✅ devuelve JWT |
| Crear aviso con foto | ✅ |
| Foto subida a Supabase Storage | ✅ HTTP 200, `image/jpeg` |
| Listado público (sin auth) | ✅ sin email/teléfono |
| Endpoint privado sin token | ✅ 401 |
| Borrar aviso ajeno | ✅ 404 |
| Mensajería entre usuarios | ✅ 201 / hilos anonimizados (`Usuario xxxxxx`) |
| Marcar como resuelto | ✅ sale del mapa público |
| Eliminar cuenta + datos | ✅ y el token queda revocado (401) |

## 3.ter Mapa (tiles) — CAUSA REAL ENCONTRADA

**Síntoma:** el mapa se veía gris, sin tiles.

**Causa raíz:** el **service worker** interceptaba TODAS las peticiones GET,
incluidas las de otros dominios (los tiles del mapa, las fotos de Supabase).
Esa interceptación rompía la carga de los tiles. Verificado con Chrome
headless (DevTools Protocol):

| | tiles en el DOM | tiles cargados |
|---|---|---|
| Antes (SW v4) | 6 | **0** ❌ |
| Después (SW v5) | 6 | **6** ✅ |

**Arreglo aplicado:** el service worker ahora **ignora las peticiones a otros
dominios** (`url.origin !== self.location.origin`) y las deja pasar sin tocarlas.
Además se subió la versión de caché a `v5` para forzar la actualización en los
dispositivos que ya tenían la app instalada.

**Extra:** se añadió una capa de tiles con **proveedores de respaldo
automáticos** (Esri → OpenStreetMap → OpenTopoMap). Esri sirve mapas reales
correctamente; OpenStreetMap devuelve 403 "Access blocked" a apps; **CARTO se
descartó porque ahora sirve los tiles con una marca de agua "API KEY
REQUIRED"**. La cadena de respaldo solo usa proveedores sin marca de agua.

---

## 4. Variables de entorno esperadas en Render

Estas son las claves que el servicio necesita (los **valores** nunca deben
quedar escritos en el repositorio):

| Variable | Obligatoria | Notas |
|----------|-------------|-------|
| `NODE_ENV` | Sí | `production` |
| `JWT_SECRET` | Sí | Cadena aleatoria larga (`openssl rand -hex 32`). |
| `DATABASE_URL` | Sí | Cadena de conexión de Supabase (Project Settings → Database → URI). |
| `SUPABASE_URL` | Opcional* | Project URL de Supabase. |
| `SUPABASE_SERVICE_ROLE_KEY` | Opcional* | service_role key (sensible, solo en el servidor). |
| `SUPABASE_BUCKET` | Opcional | `fotos`. |
| `APP_URL` | Sí (prod) | `https://rastro-app.onrender.com`. |
| `VAPID_PUBLIC_KEY` | Opcional | Para notificaciones push. |
| `VAPID_PRIVATE_KEY` | Opcional | Para notificaciones push. |
| `VAPID_SUBJECT` | Opcional | `mailto:tucorreo@real.com`. |
| `TRUST_PROXY` | Sí | `1` en Render. |
| `RESEND_API_KEY` | Opcional | Correos de recuperación reales. |
| `GOOGLE_CLIENT_ID` | Opcional | Botón "Iniciar con Google". |

\* Si `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` faltan, las fotos caen a disco
local **y se pierden** en cada reinicio del plan Free de Render.

---

## 5. Recordatorios de seguridad

- **Nunca** subir a Git el archivo `backend/.env` (ya está en `.gitignore`),
  ni pegar `SUPABASE_SERVICE_ROLE_KEY`, `JWT_SECRET` o claves de Render en
  issues, capturas o chats.
- Si en algún momento se compartieron tokens de Render/Supabase por cualquier
  canal, **revocarlos y regenerarlos** desde cada plataforma.
- El bucket `fotos` de Supabase es **público** (por diseño, para mostrar las
  fotos en la app). No subir ahí ningún dato sensible.
