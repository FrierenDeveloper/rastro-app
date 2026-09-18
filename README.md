# Rastro — mascotas perdidas y encontradas

Proyecto completo: backend (API + base de datos + autenticación) y frontend (PWA)
listos para desplegar como una app real, más los documentos que Google Play pide
antes de publicar.

```
rastro-app/
├── backend/     API en Node.js/Express + Postgres (auth, avisos, mensajería, fotos)
├── frontend/    PWA (HTML/CSS/JS) instalable, habla con la API
└── docs/        Política de privacidad, Data Safety form, checklist de Play Store,
                 guía de despliegue gratuito en Render + Supabase
```

## Probarla en tu computador (10 minutos)

Necesitas [Node.js](https://nodejs.org) 18+ y una base de datos Postgres.
La forma más simple para probar es crear un proyecto gratis en
[Supabase](https://supabase.com) y usar su cadena de conexión incluso para
desarrollo local (ver `docs/DESPLEGAR_RENDER_SUPABASE.md`, Parte 1) — así
pruebas exactamente lo mismo que vas a desplegar.

```bash
cd backend
npm install
cp .env.example .env
```

Abre `.env` y completa:
- `JWT_SECRET`: cualquier texto largo y aleatorio (`openssl rand -hex 32`).
- `DATABASE_URL`: la cadena de conexión de tu proyecto de Supabase (o de
  cualquier Postgres al que tengas acceso).
- `APP_URL`: la URL pública de tu app (`https://tu-app.onrender.com`). Es
  **obligatoria en producción**: con ella se arma el enlace de "recuperar
  contraseña". Si falta, el servidor responde 503 en vez de generar un enlace
  inseguro (ese enlace lleva un token y no debe construirse con la cabecera
  `Host`, que la controla quien hace la petición).
- `TRUST_PROXY`: déjalo en `1` si tu app va detrás de un proxy que reescribe
  `X-Forwarded-For` (Render). Si la expones directo a internet, ponlo en `0`.
- `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`: opcionales. Si los dejas
  vacíos, las fotos se guardan en el disco local del servidor (sirve para
  probar, pero no persiste en hosting gratuito).
- `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`: para las notificaciones push.
  Genera las tuyas con `npm run gen:vapid` (el `.env` de ejemplo ya trae unas
  de prueba).
- `RESEND_API_KEY` (opcional): para enviar correos reales de recuperación de
  contraseña. Sin ella, el enlace se imprime en la consola.
- `GOOGLE_CLIENT_ID` (opcional): para mostrar el botón "Iniciar con Google".

```bash
npm start
```

Abre `http://localhost:3000` — el mismo servidor sirve la app completa (crea
una cuenta, publica un aviso, tómale una foto, muévete en el mapa).

## Qué incluye
- Cuentas con contraseña **cifrada** (bcrypt), sesiones con JWT, y **recuperar
  contraseña** por correo (funciona con Resend; sin configurar, el enlace se
  imprime en la consola del servidor).
- **Inicio de sesión con Google** (opcional: solo aparece si configuras
  `GOOGLE_CLIENT_ID`).
- **Chat bidireccional** entre quien publica un aviso y quien lo ve: el dueño
  puede responder, con hilos de conversación y contador de no leídos. Puedes
  adjuntar tu ubicación actual a un mensaje ("lo vi aquí").
- **Notificaciones push** reales cuando te escriben (Web Push / VAPID, sin
  cuentas externas: `npm run gen:vapid`).
- **Editar** tus avisos, **marcar como resuelto** (deja de aparecer en el mapa),
  **compartir** por WhatsApp/redes y **reportar** avisos inapropiados (se ocultan
  automáticamente tras 5 reportes de 5 cuentas distintas con más de 24 h de
  antigüedad).
- **Clustering de marcadores** en el mapa cuando hay muchos avisos.
- La ubicación exacta de cada aviso solo la ve su dueño; a todos los demás se
  les muestra un punto difuminado (~300 m) — nunca se expone dónde vive alguien.
- El contacto (teléfono/correo) **nunca se muestra públicamente**: la
  comunicación pasa por mensajería interna dentro de la app.
- Límites de velocidad (rate limiting) contra fuerza bruta en login y contra
  spam de avisos falsos.
- Fotos validadas por tipo real de archivo, guardadas con nombre aleatorio
  (evita ataques de path traversal), máximo 5 MB.
- Cabeceras de seguridad HTTP (Helmet), CORS restringible a tu dominio.
- El usuario puede **eliminar su cuenta y todos sus datos** en cualquier
  momento (requisito de Google Play): se borran avisos, fotos y mensajes.
- Fotos guardadas en **Supabase Storage** cuando está configurado (persisten de
  verdad); si no lo configuras, caen a disco local como respaldo para pruebas.
- `npm audit`: 0 vulnerabilidades en las dependencias al momento de construir esto.

## Desplegarlo gratis en producción (Render + Supabase)

Sigue `docs/DESPLEGAR_RENDER_SUPABASE.md` paso a paso — deja tu app en una URL
pública con HTTPS y los datos (cuentas, avisos, fotos) guardados de forma
persistente, todo en capas gratuitas. Después:

1. Publica `docs/POLITICA_DE_PRIVACIDAD.md` (completa los datos reales primero)
   en una URL pública — la necesitarás para Google Play.
2. Sigue `docs/CHECKLIST_GOOGLE_PLAY.md` paso a paso para llegar a Play Store.

## Limitaciones que debes saber
- El plan gratis de Render "duerme" el servidor tras 15 min sin uso; la
  primera visita después de eso tarda 30-50 segundos en responder.
- Los planes gratis de Supabase (500 MB de base de datos, 1 GB de
  almacenamiento) alcanzan de sobra para partir, pero tienen techo — si el
  proyecto crece mucho, tocará pasar a un plan pago.
- Las **notificaciones push** funcionan en Android/Chrome (PWA y app
  empaquetada). En iPhone requieren que la PWA esté instalada en la pantalla de
  inicio (limitación de iOS, no del código). Para notificaciones nativas
  garantizadas en iOS necesitarías Firebase Cloud Messaging con una app nativa.
- **Recuperar contraseña** usa Resend (plan gratis) si configuras
  `RESEND_API_KEY`. Sin esa clave el enlace se imprime en la consola del
  servidor: sirve para probar, pero no envía correos reales.
- Este backend no ha pasado una auditoría de seguridad profesional. Lo que
  incluye son buenas prácticas estándar (OWASP básico), no una certificación.
