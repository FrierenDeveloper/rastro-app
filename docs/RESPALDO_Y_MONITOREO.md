# Respaldos y monitoreo de PetSeñal

Guía operativa para dos cosas que no son código pero sostienen la app cuando ya
tiene usuarios: **respaldar la base** y **enterarte si se cae**.

## 1. Respaldo diario de la base (GitHub Actions → Cloudflare R2)

El workflow `.github/workflows/backup-db.yml` corre **todos los días a las 04:17
UTC** (madrugada en Chile) y también se puede lanzar a mano desde
**GitHub → Actions → respaldo-db → Run workflow**. Hace esto:

1. Instala el cliente PostgreSQL más reciente (el del runner puede ser más viejo
   que el servidor y entonces `pg_dump` se niega a volcar).
2. Ejecuta `pg_dump --clean --if-exists | gzip -9`. Si el archivo pesa menos de
   1 KB, **aborta**: un respaldo vacío es peor que no tenerlo.
3. Lo sube a un bucket **privado** de R2 y lo deja además como artefacto de
   GitHub por 30 días.
4. Borra de R2 los respaldos de más de 30 días.

### Configurarlo (una sola vez)

En **GitHub → Settings → Secrets and variables → Actions → New repository secret**
crea estos secretos (nunca van en el archivo):

| Secreto | Valor |
| --- | --- |
| `DATABASE_URL` | Cadena de conexión a Supabase **directa** (puerto 5432) o, mejor, **Session pooler**. |
| `R2_ACCOUNT_ID` | ID de tu cuenta de Cloudflare (está en el panel de R2). |
| `R2_ACCESS_KEY_ID` | Credencial de R2 con permiso de escritura. |
| `R2_SECRET_ACCESS_KEY` | Secreto de esa credencial. |
| `R2_BACKUP_BUCKET` | Bucket **privado** solo para respaldos, por ejemplo `respaldos-petsenal`. |

> **Trampa importante (el error más común):** usa la cadena del **Session
> pooler** (`...pooler.supabase.com:5432`) o la conexión directa. **No** uses el
> *transaction pooler* (`puerto 6543`): `pg_dump` necesita una sesión estable y
> con el pooler de transacciones falla. Si tu proyecto es nuevo, además la
> conexión directa de Supabase puede ser solo IPv6, y los runners de GitHub no
> tienen IPv6: por eso el session pooler es la opción segura.

> **No uses el mismo bucket de las fotos.** El bucket de fotos es público (tiene
> URL pública). Un respaldo en un bucket público se podría descargar si alguien
> adivina el nombre del archivo. Crea un bucket aparte, privado. Si no quieres
> crear otro bucket, al menos activa el bloqueo de acceso público en un prefijo
> separado y usa nombres no adivinables.

Guarda las credenciales de R2 con permiso **solo sobre el bucket de respaldos**
(Object Read & Write de ese bucket), no de toda la cuenta.

### Probar que quedó bien

1. Actions → **respaldo-db** → **Run workflow**.
2. Al terminar, en Cloudflare → R2 → bucket de respaldos debe aparecer
   `petsenal-AAAA-MM-DD_HHMM.sql.gz` de más de 1 KB.
3. Descárgalo una vez y comprueba que abre: `gunzip -c archivo.sql.gz | head`.

### Restaurar un respaldo

`pg_dump --clean --if-exists` genera un script que **borra y recrea** las tablas,
así que restaurar encima de la base actual es destructivo. Lo recomendable es
restaurar en una base **nueva** y, si todo está bien, apuntar ahí:

```bash
# 1. Descarga el .sql.gz desde R2 (panel de Cloudflare o aws s3 cp).
# 2. Mira qué trae antes de tocar nada.
gunzip -c petsenal-2026-09-24_0417.sql.gz | less

# 3. Restaura en una base de prueba (nunca directo a producción si puedes evitarlo).
createdb petsenal_restore
gunzip -c petsenal-2026-09-24_0417.sql.gz | psql "postgresql://.../petsenal_restore"

# 4. Verifica y, si está correcto, restaura sobre la base real en una ventana de mantenimiento.
gunzip -c petsenal-2026-09-24_0417.sql.gz | psql "$DATABASE_URL"
```

### Notas de límite

- El plan free de Supabase no incluye backups automáticos; este workflow es tu
  única red de seguridad. No lo desactives sin reemplazarlo.
- Los workflows programados de GitHub pueden retrasarse unos minutos (es normal).
- GitHub **desactiva** los `schedule` tras 60 días sin actividad en el repo; si
  pasa, vuelve a habilitarlos desde la pestaña Actions.

## 2. UptimeRobot: enterarte cuando la app se cae

**Qué es:** un servicio externo gratuito que revisa desde afuera, cada pocos
minutos, si tu web responde, y te manda un correo (o Telegram) cuando deja de
hacerlo. No va dentro de la app: es un "vigilante" que vive en otro servidor.

**Por qué sirve acá, además de avisar:**

- Render free **duerme** la app tras ~15 minutos sin visitas; el primer acceso
  después tarda 30-60 s y a veces da error. Un monitor que la toca cada 5 minutos
  la mantiene despierta y mejora la primera impresión. Un solo servicio free de
  Render son ~730 h/mes, dentro de las 750 h del plan.
- Las notificaciones por push solo avisan a usuarios; nadie te avisa a ti si el
  backend se cayó. UptimeRobot cubre eso.

**Cómo configurarlo:**

1. Crea una cuenta gratis en <https://uptimerobot.com>.
2. **Add New Monitor**:
   - **Monitor Type:** `HTTP(s)`.
   - **Friendly Name:** `PetSeñal API`.
   - **URL:** `https://petsenal.com/api/health` (responde `{"ok":true}`).
   - **Monitoring Interval:** `5 minutes`.
   - **Alert Contacts:** marca tu correo (y Telegram si quieres).
3. Guarda. Prueba con **Test Notification**.
4. Opcional: agrega un segundo monitor a `https://petsenal.com/` (la web) y, si
   quieres ser estricto, un **Keyword monitor** que busque `"ok":true` en la
   respuesta; así no lo engaña una página de error que devuelva 200.

**Qué NO es:** no reemplaza al respaldo (eso es la sección 1) ni prueba la lógica
de negocio. Solo dice "el servidor responde".

### 2b. El bot incluido (GitHub Actions y, opcional, Telegram)

El repo ya trae `.github/workflows/monitor-uptime.yml`, un vigilante que no
necesita cuentas externas. Cada **15 minutos** consulta
`https://petsenal.com/api/health` hasta 3 veces y exige `{"ok":true}`:

- Si todo va bien, no hace nada (y de paso mantiene despierta la instancia free
  de Render).
- Si no responde, **falla el workflow**, GitHub te manda un correo y abre (o
  comenta) un *issue* con la etiqueta `caida`. Cuando se recupera, lo cierra
  solo.
- También se puede lanzar a mano: **Actions → monitoreo-uptime → Run workflow**.

Para avisos en **Telegram** (opcional), crea el bot una sola vez:

1. En Telegram, habla con **@BotFather** → `/newbot` → nombre y usuario del bot.
   Copia el token que te da (formato `123456789:AA...`).
2. Escríbele algo a tu bot y abre
   `https://api.telegram.org/bot<TU_TOKEN>/getUpdates` para sacar tu
   `chat_id` (el número en `"chat":{"id":...}`).
3. En **GitHub → Settings → Secrets and variables → Actions**, crea
   `TELEGRAM_BOT_TOKEN` y `TELEGRAM_CHAT_ID`.

Límites: GitHub puede retrasar el `schedule` unos minutos y **lo pausa tras 60
días sin actividad** en el repo (se vuelve a habilitar desde Actions). Cada
corrida consume minutos de Actions; en un repo privado, cada 15 minutos cabe en
el plan gratuito. Para un aviso más rápido y sin depender de GitHub, usa
UptimeRobot (arriba).


## 3. Prueba de humo end-to-end (`backend/scripts/smoke-test.js`)

Ese script **sí** prueba la lógica: registro con captcha, crear avisos, permisos,
matches, chat, push, recuperar contraseña, borrado de cuenta, etc. Se conecta a
la base y **crea y borra sus propios datos de prueba**.

```bash
cd backend

# Contra un servidor local (levanta antes: npm run dev) y la misma base.
node scripts/smoke-test.js

# Contra producción (¡escribe en la base real! Crea usuarios y avisos y los
# borra al final; si algo falla a mitad puede dejar residuos).
SMOKE_BASE=https://petsenal.com DATABASE_URL="postgresql://..." node scripts/smoke-test.js
```

Úsalo después de cada cambio grande y antes de difundir la app. No lo pongas como
monitor periódico contra producción salvo que aceptes las escrituras de prueba;
para "¿está viva?" la sección 2 alcanza.
