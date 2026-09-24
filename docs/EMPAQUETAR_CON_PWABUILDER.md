# Empaquetar PetSeñal como app de Android con PWABuilder

Tiempo estimado: 20-30 minutos. Coste: **0** por el paquete; la cuenta de Google Play son 25 US$ (pago único).
No hay que instalar nada en el PC: todo ocurre en el navegador.

## Lo que ya está listo en el repo

- La PWA se sirve por HTTPS con `manifest.json`, `sw.js` e iconos **normales y maskable** (esto
  último evita que Android recorte el icono en el launcher).
- Política de privacidad pública: `https://tu-dominio.com/privacidad/`
  (archivo `frontend/privacidad/index.html`, accesible sin iniciar sesión, que es lo que exige Play).
- El backend ya implementa `/.well-known/assetlinks.json`: solo le faltan dos variables de entorno.
- Package id decidido: **`com.petsenal.app`** (no se puede cambiar después de publicar).

## Paso 1 — Generar el paquete

1. Entra en <https://www.pwabuilder.com> y pega `https://tu-dominio.com`.
2. Pulsa **Start** y revisa el informe: debe salir _installable_ y el service worker detectado.
   Si marca algo de iconos o del manifest, avísame antes de seguir.
3. **Package for stores** → pestaña **Android** → **Generate Package**.
4. Rellena el formulario:
   - **Package ID**: `com.petsenal.app`
   - **App name**: `PetSeñal`
   - **Short name**: `PetSeñal`
   - **Display mode**: `standalone`
   - **Signing key**: deja que PWABuilder cree una nueva. Te pedirá una contraseña: apúntala.
5. Descarga el ZIP. Dentro viene:
   - `*.aab` → es lo que se sube a Play.
   - `*.apk` → para probar en tu teléfono antes de publicar.
   - `signing.keystore` y `signing-key-info.txt` → **guárdalos en un lugar seguro y con copia**.
   - `assetlinks.json` de ejemplo, con el `sha256_cert_fingerprints` que necesitas.

## Paso 2 — Verificación de dominio (que no salga la barra del navegador)

Si este paso falta o el SHA no coincide, la app se instala pero se abre **con la barra de direcciones
arriba**, y deja de parecer una app.

1. Abre el `assetlinks.json` del ZIP y copia el valor de `sha256_cert_fingerprints`.
2. En Render → tu servicio → **Environment**, añade:
   - `ANDROID_PACKAGE_NAME` = `com.petsenal.app`
   - `ANDROID_SHA256_CERT_FINGERPRINTS` = el SHA-256 copiado (formato `AA:BB:CC:...`, 32 pares).
     Admite varios separados por coma, así que después puedes añadir el de Play sin borrar este.
3. Guarda y espera a que Render redespliegue.
4. Comprueba en el navegador: `https://tu-dominio.com/.well-known/assetlinks.json` debe
   devolver el JSON con tu package. Hoy responde
   `{"error":"Falta configurar ANDROID_PACKAGE_NAME y ANDROID_SHA256_CERT_FINGERPRINTS..."}`.
5. Instala el `*.apk` en el teléfono y ábrelo: si **no** aparece la barra del navegador, funcionó.
6. **Si activas Play App Signing** (lo normal): Google vuelve a firmar la app, así que el SHA que
   valida en producción es el que muestra Play Console en _Firma de apps_, no el de tu keystore local.
   Añádelo a la variable separado por coma y deja los dos.

## Paso 3 — Publicar en Play Console

1. Crear cuenta de desarrollador (25 US$) y completar la verificación de identidad.
2. **Crear app**: nombre `PetSeñal — Mascotas perdidas y encontradas`, idioma español, tipo "Aplicación",
   gratuita.
3. Subir el `.aab` en una **prueba cerrada** (te deja probar con testers antes de producción).
4. Rellenar la ficha: descripción, icono de 512×512 (sirve `frontend/icons/icon-512.png`), capturas de
   pantalla (sácalas del teléfono con la app abierta), clasificación de contenido.
5. **Data safety**: usa `docs/DATA_SAFETY_FORM.md` como base y cuádralo con lo que dice la política.
6. URL de la política de privacidad: `https://tu-dominio.com/privacidad/`
7. Si la cuenta es personal y se creó después del 13 de noviembre de 2023: hace falta una prueba
   cerrada de **14 días con al menos 12 testers** antes de poder pedir acceso a producción.
8. **Nivel de API**: Play exige apuntar a Android 16 (API 36) para apps nuevas desde el 31 de agosto de 2026. Comprueba lo que dice Play Console al subir el `.aab`; si se queda corto, en el ZIP viene el
   proyecto Android y se corrige el `targetSdkVersion` y se vuelve a compilar (eso ya sería con
   Bubblewrap o Android Studio, y te lo puedo montar).

## Comprobaciones antes de dar por buena la app

- [ ] El APK instalado abre **sin** barra de direcciones.
- [ ] El icono del launcher se ve completo (sin recortes raros).
- [ ] `/privacidad/` abre desde el menú de la app y sin iniciar sesión.
- [ ] `/.well-known/assetlinks.json` devuelve el JSON en producción.
- [ ] Las notificaciones push funcionan en la app instalada.
- [ ] El `.keystore` y su contraseña están guardados en dos sitios distintos.

## Actualizar el APK cuando la app cambia

La app Android es una **TWA**: un contenedor que abre la web en vivo. **No empaqueta** el
HTML/CSS/JS, así que los cambios de contenido (onboarding, login, respiración, etc.) **ya se
ven en la app instalada sin recompilar**. Solo hay que recompilar si quieres cambiar:

- la URL que abre la app: el APK viejo estaba fijado a `https://rastro-app.onrender.com`; el
  nuevo ya apunta a `https://petsenal.com`;
- iconos, nombre o `targetSdkVersion`;
- el `versionCode` (Android/Play lo exigen para aceptar una actualización).

La descarga del login apunta siempre a `frontend/descargar/petsenal.apk`, así que basta
reemplazar ese archivo; no hay que tocar el código.

### Recompilar (PWABuilder, sin instalar nada)

1. <https://www.pwabuilder.com> → pega `https://petsenal.com` → **Start**.
2. **Package for stores** → **Android** → **Generate Package**.
3. Package ID `com.petsenal.app`, nombre `PetSeñal`, display `standalone`.
4. **Firma**: en las opciones de Android, elige **"Use my own"** y sube el `signing.keystore`
   original con su contraseña. Es clave: si dejas que PWABuilder cree otra clave, cambia el SHA y
   entonces (a) hay que actualizar `ANDROID_SHA256_CERT_FINGERPRINTS` en Render y (b) las
   instalaciones existentes **no** se pueden actualizar: hay que desinstalar y reinstalar.
5. Sube el `versionCode` (1 → 2, …) en cada build.
6. Descarga el ZIP y copia el `.apk` sobre `frontend/descargar/petsenal.apk`.
7. `npm run verify` y commit/push; Render lo despliega.

Si el `.keystore` original se perdió no hay forma de conservar el SHA actual: toca clave nueva,
actualizar la variable en Render y reinstalar en los teléfonos.

### Recompilar en el proyecto (Android SDK local, sin PWABuilder)

El proyecto Android ya vive en `android/` (template de Bubblewrap adaptado). Compila y
firma con el SDK que trae PocketDev:

```bash
cd android
bash build.sh
```

`build.sh` corre `gradle assembleRelease`, alinea con `zipalign`, firma con
`petsenal-release.keystore` (configurado en `keystore.properties`) y copia el
resultado sobre `frontend/descargar/petsenal.apk`. Requisitos: JDK 17, Gradle
8.14.3 y Android SDK 36 con build-tools 35.0.0 (ya instalados aquí).

- `android/signing-key-info.txt` guarda el alias, las contraseñas y la huella
  SHA-256. **No se commitea**: cópialo junto con `android/petsenal-release.keystore`
  a dos lugares seguros.
- Para subir la versión antes de un release, cambia `versionCode` y `versionName`
  en `android/app/build.gradle`.
- La huella SHA-256 del APK firmado va en Render, en
  `ANDROID_SHA256_CERT_FINGERPRINTS` (separada por coma si hay varias).

> **Ojo — firma nueva.** El keystore original del primer APK (`SHA-256 3A:91:…`) no está
> en el repositorio, así que este build usa una clave nueva (`SHA-256 8D:A4:16:85:…`).
> Hay que **agregar la huella nueva** a `ANDROID_SHA256_CERT_FINGERPRINTS` en Render
> (pueden quedar las dos separadas por coma) o la app abrirá con la barra del navegador.
> Si un teléfono ya tenía instalada la app vieja, hay que desinstalarla antes de instalar
> esta: Android no acepta actualizaciones firmadas con otra clave.

Para compilar con Bubblewrap/Android Studio no hace falta instalar nada más.
