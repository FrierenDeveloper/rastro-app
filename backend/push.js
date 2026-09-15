// push.js
// Notificaciones push web (Web Push / VAPID). No requiere ninguna cuenta
// externa: las claves VAPID las generas tú mismo con `npm run gen:vapid` y las
// pones en el .env. Chrome en Android las entrega a través de su propio
// servicio de push, así que funciona tanto en la PWA como en la app empaquetada.
const webpush = require('web-push');
const db = require('./db');

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:contacto@example.com';

const enabled = !!(PUBLIC_KEY && PRIVATE_KEY);
if (enabled) webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);

/**
 * Envía una notificación push a todos los dispositivos suscritos de un usuario.
 * Nunca lanza error hacia afuera: un fallo de push no debe romper la petición.
 */
async function sendToUser(userId, payload) {
  if (!enabled) return;
  let subs;
  try {
    subs = await db.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1', [userId]);
  } catch (e) { return; }

  await Promise.all(subs.rows.map(async s => {
    const subscription = { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } };
    try {
      await webpush.sendNotification(subscription, JSON.stringify(payload));
    } catch (err) {
      // 404/410 = la suscripción ya no existe (app desinstalada, etc.).
      if (err && (err.statusCode === 404 || err.statusCode === 410)) {
        try { await db.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]); } catch (e) { /* ignore */ }
      }
    }
  }));
}

module.exports = { sendToUser, enabled, publicKey: PUBLIC_KEY };
