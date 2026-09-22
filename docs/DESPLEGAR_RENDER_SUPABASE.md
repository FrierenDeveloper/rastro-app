# Desplegar PetSeñal gratis: Render + Supabase

Con esto, tu app queda en una URL pública con HTTPS, y los avisos, cuentas y
fotos **persisten de verdad** (no se borran cuando el servidor se reinicia).

## Parte 1 — Crear el proyecto en Supabase (base de datos + fotos)

1. Entra a [supabase.com](https://supabase.com) → crea una cuenta gratis →
   **New project**. Elige una contraseña de base de datos y guárdala.
2. Ve a **Project Settings → Database → Connection string → URI**. Copia esa
   cadena — la vas a pegar como `DATABASE_URL` en Render. Reemplaza
   `[YOUR-PASSWORD]` en la URL por la contraseña que pusiste al crear el proyecto.
3. Ve a **Storage** (menú lateral) → **New bucket** → nómbralo `fotos` → marca
   la opción **Public bucket** (para que las fotos se puedan mostrar en la app
   sin necesitar login extra) → **Create bucket**.
4. Ve a **Project Settings → API**. Copia:
   - **Project URL** → será tu `SUPABASE_URL`.
   - **service_role key** (no la `anon` key) → será tu `SUPABASE_SERVICE_ROLE_KEY`.
     ⚠️ Esta clave es sensible — solo va en el servidor (Render), nunca en el
     frontend ni en un repositorio público.

El plan gratis de Supabase incluye 500 MB de base de datos y 1 GB de
almacenamiento de archivos — de sobra para empezar.

## Parte 2 — Desplegar el backend en Render

1. Sube la carpeta `petsenal-app` a un repositorio de GitHub (puede ser privado).
2. Entra a [render.com](https://render.com) → crea una cuenta gratis (no pide
   tarjeta) → **New → Web Service** → conecta tu repositorio de GitHub.
3. Configura:
   - **Root directory**: `backend`
   - **Runtime**: Node
   - **Build command**: `npm install`
   - **Start command**: `npm start`
   - **Plan**: Free
4. En la pestaña **Environment**, agrega estas variables (los valores de la
   Parte 1):
   - `JWT_SECRET` → genera uno con `openssl rand -hex 32` en tu terminal
   - `DATABASE_URL` → la cadena de conexión de Supabase
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_BUCKET` → `fotos`
   - `APP_URL` → la URL de tu app en Render (ej. `https://petsenal-xxxx.onrender.com`)
     — se usa para el enlace de recuperar contraseña. Si la dejas vacía, el
     código usa `RENDER_EXTERNAL_URL`, que Render inyecta sola.
   - `ADMIN_EMAILS` → tu correo (el que quieras que administre la app). Sin
     esto el panel de administración queda cerrado.
   - `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` → genéralas con
     `npm run gen:vapid` en tu computador y pega los dos valores
     (necesarias para las notificaciones push)
   - `VAPID_SUBJECT` → `mailto:tucorreo@ejemplo.com`
   - `RESEND_API_KEY` → opcional, para enviar correos reales de recuperación
   - `MAIL_FROM` → remitente verificado en Resend (opcional)
   - `GOOGLE_CLIENT_ID` → opcional, para el botón de Google
   - `CORS_ORIGIN` → déjalo **vacío**. El frontend se sirve desde el mismo
     servidor, así que no hace falta CORS. El código ignora `*` a propósito:
     con `*` cualquier web podría llamar a tu API desde el navegador de tus
     usuarios. Solo rellénalo si sirves el frontend en OTRO dominio distinto
     (ej: `https://midominio.com`).
   - `TRUST_PROXY` → `1` en Render (va detrás de un proxy que reescribe
     `X-Forwarded-For`). Si dejas la variable sin definir, los límites de
     peticiones acaban contando la IP del proxy: todos tus usuarios compartirían
     el mismo cupo. Si algún día expones la app SIN proxy, ponlo en `0`.
   - `NODE_ENV` → `production`
5. **Create Web Service**. Render construye y despliega — toma unos minutos.
   Al terminar te da una URL tipo `https://petsenal-xxxx.onrender.com`.
6. Abre esa URL en tu navegador: ahí está tu app completa (backend + frontend),
   con HTTPS, y ahora sí con los datos guardados de forma persistente en
   Supabase.

## Notas importantes

- **Cold start**: en el plan gratis, si nadie usa la app por 15 minutos, Render
  la "duerme". La primera visita después de eso tarda 30-50 segundos en cargar.
  Es normal, no es que algo esté roto.
- **Actualizar la app**: cada vez que subas cambios a GitHub, Render vuelve a
  desplegar automáticamente (revisa que _Auto-Deploy_ esté activado en
  Settings → Build & Deploy; se ha visto que a veces queda apagado).
- **Revisar que Supabase esté conectado**: en los logs de Render (pestaña
  _Logs_), si ves `PetSeñal API escuchando en puerto...` sin errores antes, la
  conexión a la base de datos funcionó. Si falla, revisa que copiaste bien la
  contraseña en `DATABASE_URL`.
- **Recuperar contraseña**: el enlace se arma con `APP_URL`. Si no la defines,
  el código usa `RENDER_EXTERNAL_URL` (Render la inyecta sola), así que
  funciona igual. En producción, si no hay ninguna de las dos, el endpoint
  responde 503 a propósito: ese enlace lleva un token y no debe construirse con
  la cabecera `Host`, que la controla quien hace la petición.
- **Panel de administración**: define `ADMIN_EMAILS` con tu correo (separados
  por coma si son varios). Sin esa variable el panel queda cerrado y la pestaña
  "Admin" no aparece.
