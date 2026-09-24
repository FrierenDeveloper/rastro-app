# Estado actual de PetSeñal

Actualizado: septiembre de 2026. Este documento permite que otra persona tome
el proyecto sin depender del historial del equipo.

## Qué es y qué ya funciona

PetSeñal es una PWA para publicar, ubicar y reencontrar mascotas perdidas o
encontradas. La interfaz es web móvil primero e incluye mapa interactivo,
avisos, búsqueda, chat entre usuarios, notificaciones, registro de microchips,
privacidad, panel de administración y generación de carteles con QR.

La marca visible ya es **PetSeñal**. Su emblema único es una huella de cuatro
dedos y almohadilla dentro de un pin GPS vectorial; se usa en acceso,
recuperación de contraseña, cabecera, onboarding, manifest y notificaciones.

## Arquitectura

| Parte       | Tecnología y responsabilidad                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------- |
| `frontend/` | PWA estática: HTML, CSS y JavaScript; Leaflet para el mapa; manifest y service worker para instalación y modo sin conexión. |
| `backend/`  | Node.js + Express: autenticación, avisos, chat, microchips, geocodificación, notificaciones y moderación.                   |
| Datos       | PostgreSQL; Supabase funciona como proveedor administrado compatible.                                                       |
| Fotos       | Cloudflare R2 es la prioridad; Supabase Storage y disco local son respaldos compatibles.                                    |
| Pruebas     | Vitest, cobertura, ESLint, Prettier y Stryker. El código nuevo de `backend/src/v2/` exige 100 % de cobertura.               |
| `android/`  | TWA (Trusted Web Activity) con Bubblewrap: envuelve la PWA para Android y se firma con `android/build.sh`.                  |
| Despliegue  | `render.yaml` define el servicio web de Render; GitHub Actions ejecuta verificación.                                        |

## Imágenes en Cloudflare R2

El backend valida JPEG, PNG y WebP antes de guardarlos. Las credenciales de R2
quedan exclusivamente en el servidor; nunca se envían al navegador. Cada objeto
recibe un UUID, conserva su tipo real, se publica por `R2_PUBLIC_URL` y se
elimina cuando se elimina el aviso o la cuenta.

Para activarlo, crea un bucket R2 y un token S3 con permiso **Object Read &
Write** limitado a ese bucket. Configura en Render o en el `.env` del servidor:

```text
R2_ACCOUNT_ID=
R2_ACCESS_KEY_ID=
R2_SECRET_ACCESS_KEY=
R2_BUCKET=fotos-petsenal
R2_PUBLIC_URL=https://fotos.tu-dominio.com
```

Conecta un dominio propio al bucket para producción. No usar la URL `r2.dev`
en producción: Cloudflare la reserva para desarrollo y aplica límites variables.

## Configuración necesaria para producción

Además de R2, faltan secretos y cuentas externas reales: `DATABASE_URL`,
`JWT_SECRET`, `CHIP_SECRET`, `APP_URL`, las claves VAPID, `VAPID_SUBJECT`,
`ADMIN_EMAILS` y, si se enviarán correos, `RESEND_API_KEY` y `MAIL_FROM`.
Consulta `backend/.env.example` y `render.yaml` para el listado completo.

`CHIP_SECRET` es especialmente crítico: no se debe reemplazar una vez que haya
microchips registrados, porque se usa para proteger y comparar esos datos.

## Pendientes para quien herede el proyecto

1. Crear y configurar las cuentas reales de PostgreSQL, Cloudflare R2, Resend y
   Web Push; añadir las variables al entorno de Render sin subir secretos a Git.
2. Definir el dominio público final, actualizar `APP_URL`, la política de
   privacidad y los enlaces de despliegue todavía usados como ejemplos.
3. Publicar la PWA en HTTPS y probar instalación en Android, iOS y escritorio.
4. Android: la app es una TWA en `android/` (package `com.petsenal.app`, apunta a
   `https://petsenal.com`). Se recompila y firma con `bash android/build.sh`, que
   copia el APK a `frontend/descargar/petsenal.apk`. La clave de firma
   (`android/petsenal-release.keystore`) y sus contraseñas (`android/signing-key-info.txt`)
   no se versionan: hay que custodiarlas. Para publicar en Google Play falta subir el `.aab`
   y completar la ficha (ver `docs/CHECKLIST_GOOGLE_PLAY.md`).
5. Mantener los identificadores técnicos heredados que aún contienen el nombre
   anterior (por ejemplo, claves de `localStorage`, caché y contexto
   criptográfico) hasta hacer una migración versionada: cambiarlos sin migrar
   puede cerrar sesiones, dejar caché antigua o impedir leer microchips ya
   registrados.

## Rutina de desarrollo

Desde `backend/`, antes de entregar cambios ejecuta:

```bash
npm run verify
npm run test:mutation:changed
```

No se cambian los umbrales de cobertura ni la configuración de lint. Los
artefactos generados, secretos, bases locales y paquetes Android deben quedar
fuera de los commits salvo que se prepare expresamente una entrega de release.
