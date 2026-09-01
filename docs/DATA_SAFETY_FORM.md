# Guía para completar el formulario "Data safety" de Google Play Console

Google te pedirá llenar esto directamente en Play Console (Panel → Política →
App content → Data safety). Aquí tienes las respuestas ya pensadas para Rastro,
en el mismo orden en que aparecen en el formulario. Ajusta si cambias la app.

## ¿Tu app recolecta o comparte alguno de los siguientes tipos de datos de usuario?
**Sí.**

## Ubicación
- **Ubicación aproximada**: Sí, se recolecta.
  - Finalidad: Funcionalidad de la app (mostrar y ordenar avisos por cercanía).
  - ¿Es obligatorio proporcionarla?: Opcional (el usuario puede ajustar el punto
    manualmente en el mapa sin usar el GPS del dispositivo).
  - ¿Se comparte con terceros?: No.
- **Ubicación precisa**: Sí, se recolecta.
  - Finalidad: Funcionalidad de la app (calcular coincidencias cercanas con precisión).
  - ¿Se comparte con terceros?: No.
  - Nota interna: la ubicación precisa solo se guarda para el dueño del aviso;
    a otros usuarios se les muestra una versión aproximada difuminada por el servidor.

## Información personal
- **Correo electrónico**: Sí. Finalidad: Cuenta de usuario, autenticación. No se comparte.
- **Número de teléfono**: Sí (opcional). Finalidad: Cuenta de usuario. No se comparte,
  no se muestra a otros usuarios.
- **Nombre**: No se recolecta (la app no pide nombre real, solo correo).

## Fotos y videos
- **Fotos**: Sí. Finalidad: Funcionalidad de la app (mostrar el animal en el aviso).
  Contenido generado por el usuario, visible públicamente dentro de la app porque es
  el propósito central de la funcionalidad.

## Mensajes
- **Otro contenido en la app (mensajes internos)**: Sí. Finalidad: Funcionalidad de
  la app (permitir que los usuarios coordinen la devolución de un animal). Solo
  visibles para emisor y receptor. No se comparte con terceros.

## ¿Los datos se cifran en tránsito?
**Sí** (siempre que despliegues el backend detrás de HTTPS, que es obligatorio en
producción — ver README de despliegue).

## ¿Los usuarios pueden pedir que se borren sus datos?
**Sí.** Existe una función en la app ("Eliminar mi cuenta y mis datos") que borra
la cuenta, los avisos y los mensajes de forma permanente. Debes declarar la URL de
la política de privacidad y, si quieres, un método adicional de contacto para
solicitudes de borrado fuera de la app.

## Prácticas de seguridad a declarar
- Los datos se cifran en tránsito: Sí (con HTTPS).
- Puedes solicitar que se borren los datos: Sí.
- Se envían para revisión de seguridad independiente: No (opcional, no obligatorio
  salvo para categorías específicas de apps financieras/salud).

---

**Importante**: este documento es una guía de referencia para ti, no reemplaza el
formulario oficial. Google actualiza las categorías de tanto en tanto — antes de
publicar, revisa el formulario en vivo dentro de Play Console para confirmar que
las categorías siguen llamándose igual.
