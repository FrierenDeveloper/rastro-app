# Empaquetar Rastro como app de Android con PWABuilder

Tiempo estimado: 20-30 minutos. Coste: **0** por el paquete; la cuenta de Google Play son 25 US$ (pago único).
No hay que instalar nada en el PC: todo ocurre en el navegador.

## Lo que ya está listo en el repo

- La PWA se sirve por HTTPS con `manifest.json`, `sw.js` e iconos **normales y maskable** (esto
  último evita que Android recorte el icono en el launcher).
- Política de privacidad pública: `https://rastro-app.onrender.com/privacidad/`
  (archivo `frontend/privacidad/index.html`, accesible sin iniciar sesión, que es lo que exige Play).
- El backend ya implementa `/.well-known/assetlinks.json`: solo le faltan dos variables de entorno.
- Package id decidido: **`com.rastro.app`** (no se puede cambiar después de publicar).

## Paso 1 — Generar el paquete

1. Entra en <https://www.pwabuilder.com> y pega `https://rastro-app.onrender.com`.
2. Pulsa **Start** y revisa el informe: debe salir _installable_ y el service worker detectado.
   Si marca algo de iconos o del manifest, avísame antes de seguir.
3. **Package for stores** → pestaña **Android** → **Generate Package**.
4. Rellena el formulario:
   - **Package ID**: `com.rastro.app`
   - **App name**: `Rastro`
   - **Short name**: `Rastro`
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
   - `ANDROID_PACKAGE_NAME` = `com.rastro.app`
   - `ANDROID_SHA256_CERT_FINGERPRINTS` = el SHA-256 copiado (formato `AA:BB:CC:...`, 32 pares).
     Admite varios separados por coma, así que después puedes añadir el de Play sin borrar este.
3. Guarda y espera a que Render redespliegue.
4. Comprueba en el navegador: `https://rastro-app.onrender.com/.well-known/assetlinks.json` debe
   devolver el JSON con tu package. Hoy responde
   `{"error":"Falta configurar ANDROID_PACKAGE_NAME y ANDROID_SHA256_CERT_FINGERPRINTS..."}`.
5. Instala el `*.apk` en el teléfono y ábrelo: si **no** aparece la barra del navegador, funcionó.
6. **Si activas Play App Signing** (lo normal): Google vuelve a firmar la app, así que el SHA que
   valida en producción es el que muestra Play Console en _Firma de apps_, no el de tu keystore local.
   Añádelo a la variable separado por coma y deja los dos.

## Paso 3 — Publicar en Play Console

1. Crear cuenta de desarrollador (25 US$) y completar la verificación de identidad.
2. **Crear app**: nombre `Rastro — Mascotas perdidas y encontradas`, idioma español, tipo "Aplicación",
   gratuita.
3. Subir el `.aab` en una **prueba cerrada** (te deja probar con testers antes de producción).
4. Rellenar la ficha: descripción, icono de 512×512 (sirve `frontend/icons/icon-512.png`), capturas de
   pantalla (sácalas del teléfono con la app abierta), clasificación de contenido.
5. **Data safety**: usa `docs/DATA_SAFETY_FORM.md` como base y cuádralo con lo que dice la política.
6. URL de la política de privacidad: `https://rastro-app.onrender.com/privacidad/`
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
