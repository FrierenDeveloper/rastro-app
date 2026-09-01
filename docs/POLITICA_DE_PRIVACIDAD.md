# Política de privacidad de Rastro

*Última actualización: [completar fecha]*

Este es un **borrador de partida**, no un documento legal terminado. Antes de publicar
en Google Play debes: (1) completarlo con los datos reales de tu organización o de la
persona responsable, (2) publicarlo en una URL pública y estable (por ejemplo, una
página en tu sitio web o un Gist/GitHub Pages), y (3) idealmente que lo revise un
abogado, especialmente si vas a operar en varios países.

## 1. Quiénes somos
[Nombre de la persona u organización responsable de la app], en adelante "Rastro",
"nosotros". Contacto: [correo de contacto].

## 2. Qué datos recolectamos

| Dato | Para qué lo usamos | ¿Se muestra a otros usuarios? |
|---|---|---|
| Correo electrónico | Crear tu cuenta e iniciar sesión | No |
| Contraseña | Se guarda **cifrada** (nunca en texto plano), solo para autenticarte | No |
| Teléfono (opcional) | Contacto de respaldo asociado a tu cuenta | No |
| Fotos que subes | Mostrar el aviso de animal perdido/encontrado | Sí, la foto que decides subir |
| Ubicación GPS | Ubicar el aviso en el mapa y calcular coincidencias cercanas | Solo una versión **aproximada** (difuminada ~300 m); la ubicación exacta nunca se muestra públicamente |
| Mensajes dentro de la app | Permitir que dos usuarios coordinen la devolución de un animal | Solo lo ve la persona destinataria del mensaje |
| Características del animal (tipo, color, raza, sexo, collar, descripción) | Mostrar el aviso y calcular coincidencias | Sí, es contenido público del aviso |

No vendemos datos personales a terceros ni los usamos con fines publicitarios.

## 3. Base legal y finalidad
Los datos se recolectan únicamente para el propósito de la app: ayudar a reunir
animales perdidos con sus familias. El tratamiento se basa en tu consentimiento al
crear una cuenta y publicar un aviso.

## 4. Ubicación (dato sensible)
Rastro solicita acceso a tu ubicación para:
- Sugerir el punto donde encontraste o perdiste un animal.
- Calcular qué avisos están cerca de un punto dado.

La ubicación exacta que guardas al publicar un aviso **solo es visible para ti**
(en "Mis avisos"). A todo el resto de usuarios se les muestra una versión aproximada,
desplazada aleatoriamente unos 300 metros, para no revelar la ubicación exacta de tu
casa o del lugar donde viste al animal.

## 5. Con quién compartimos datos
- **No compartimos** tus datos personales con terceros para fines comerciales.
- Los datos se almacenan en [nombre de tu proveedor de hosting/base de datos, ej.
  Render/Railway/Supabase], que actúa como encargado técnico del tratamiento.
- Si en el futuro integras notificaciones por correo o SMS, agrega aquí el proveedor
  (ej. SendGrid, Twilio) y qué datos les llegan.

## 6. Cuánto tiempo guardamos los datos
Mientras tu cuenta esté activa. Puedes eliminar avisos individuales o tu cuenta
completa en cualquier momento desde "Mis avisos → Eliminar mi cuenta y mis datos".
Al eliminar tu cuenta, se eliminan también tus avisos, fotos y mensajes.

## 7. Tus derechos
Puedes: acceder a tus datos, corregirlos, eliminarlos (tú mismo/a desde la app) y
retirar tu consentimiento dejando de usar la app y eliminando tu cuenta. Para
solicitudes adicionales, contáctanos a [correo de contacto].

## 8. Menores de edad
Rastro no está dirigido a menores de 13 años. Si detectamos una cuenta de un menor
de esa edad, la eliminaremos.

## 9. Seguridad
Usamos contraseñas cifradas (bcrypt), comunicación cifrada (HTTPS) en producción,
control de acceso por sesión (JWT) y límites de velocidad para prevenir abuso.
Ningún sistema es 100% infalible; si detectas una vulnerabilidad, repórtala a
[correo de contacto].

## 10. Cambios a esta política
Podemos actualizar esta política. Publicaremos la fecha de la última actualización
al inicio del documento.
