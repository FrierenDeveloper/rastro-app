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
- `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`: opcionales. Si los dejas
  vacíos, las fotos se guardan en el disco local del servidor (sirve para
  probar, pero no persiste en hosting gratuito).

```bash
npm start
```

Abre `http://localhost:3000` — el mismo servidor sirve la app completa (crea
una cuenta, publica un aviso, tómale una foto, muévete en el mapa).

## Qué seguridad ya tiene esto (vs. el prototipo anterior)
- Cuentas con contraseña **cifrada** (bcrypt), sesiones con JWT.
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
  momento (requisito de Google Play).
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
- No hay notificaciones push ni por correo todavía: cuando alguien te escribe,
  el mensaje queda esperando en "Mis avisos" dentro de la app. Para avisar de
  verdad en tiempo real necesitarías integrar algo como Firebase Cloud
  Messaging (push) o SendGrid (correo) — no lo agregué porque requiere que tú
  crees esas cuentas y me des las claves de API.
- Este backend no ha pasado una auditoría de seguridad profesional. Lo que
  incluye son buenas prácticas estándar (OWASP básico), no una certificación.
