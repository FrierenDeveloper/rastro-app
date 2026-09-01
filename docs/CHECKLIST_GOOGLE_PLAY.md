# Checklist para publicar Rastro en Google Play (2026)

Basado en los requisitos vigentes de Google Play al 31 de agosto de 2026. Google
actualiza estas reglas con frecuencia — antes de enviar tu app a revisión, confirma
en [Play Console Help](https://support.google.com/googleplay/android-developer)
que nada cambió.

## Fase 0 — Antes de tocar Play Console
- [ ] Desplegar el backend (`/backend`) en un hosting con **HTTPS obligatorio**
      (Render, Railway, Fly.io, o tu propio servidor con un certificado TLS).
- [ ] Configurar `CORS_ORIGIN` en el `.env` de producción con el dominio real de tu app.
- [ ] Publicar `docs/POLITICA_DE_PRIVACIDAD.md` en una URL pública y accesible sin login.
- [ ] Decidir el nombre final, ícono y capturas de pantalla de la app.

## Fase 1 — Convertir el frontend en una app instalable en Android
Tienes dos caminos razonables:
- [ ] **Opción A — PWA empaquetada (más rápido)**: usa
      [PWABuilder](https://www.pwabuilder.com) o `bubblewrap` para envolver el
      `frontend/` (ya es un PWA válido: tiene `manifest.json` y `sw.js`) en un
      Android App Bundle (`.aab`) mediante Trusted Web Activity.
- [ ] **Opción B — App nativa/híbrida**: reconstruir la UI en Flutter o React
      Native, reutilizando la misma API del backend. Más trabajo, mejor
      integración con funciones nativas (notificaciones push, cámara nativa).

## Fase 2 — Requisitos técnicos de Google Play
- [ ] El Android App Bundle debe apuntar (target API level) a **Android 16
      (API 36)** o superior — obligatorio para apps nuevas desde el 31 de agosto
      de 2026.
- [ ] Firmar el `.aab` (Play App Signing, gestionado por Google).
- [ ] Verificar que los permisos declarados (ubicación, cámara) tengan una
      justificación clara y coincidan con el formulario de Data Safety.

## Fase 3 — Cuenta de desarrollador
- [ ] Crear cuenta en Play Console: pago único de **US$25**.
- [ ] Completar la **verificación de identidad de desarrollador**.
- [ ] Desde el 30 de septiembre de 2026, además aplica el nuevo programa de
      **Android Developer Verification** — revisa si te corresponde según tu tipo
      de cuenta.

## Fase 4 — Ficha de la tienda y declaraciones
- [ ] Ficha de la tienda: descripción, categoría, ícono, capturas de pantalla.
- [ ] Clasificación de contenido (content rating) — obligatoria, Google no permite
      apps sin clasificar.
- [ ] Completar el formulario **Data Safety** (usa `docs/DATA_SAFETY_FORM.md` como
      base) y que coincida exactamente con tu política de privacidad.
- [ ] Declarar la URL de la política de privacidad.

## Fase 5 — Prueba cerrada (obligatoria en cuentas personales nuevas)
- [ ] Si tu cuenta de desarrollador es personal y se creó después del 13 de
      noviembre de 2023: debes correr una **prueba cerrada de 14 días con al
      menos 12 testers** que hayan aceptado participar, antes de poder solicitar
      acceso a producción.
- [ ] Recluta a los 12 testers (amigos, familia, comunidad) con anticipación —
      este es el paso donde más se atascan los desarrolladores primerizos.

## Fase 6 — Revisión y publicación
- [ ] Solicitar acceso a producción (la revisión de Google toma aprox. 7 días).
- [ ] Revisión final de la app antes de que quede pública.

## Después de publicar
- [ ] Mantener el Data Safety form actualizado si agregas nuevas funciones que
      recolecten datos (por ejemplo, notificaciones push).
- [ ] Monitorear reportes de errores y reseñas desde Play Console.
- [ ] Revisar cada año el nuevo piso de target API level (Google lo sube
      anualmente).
