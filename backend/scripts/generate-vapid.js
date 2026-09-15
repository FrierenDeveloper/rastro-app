// Genera un par de claves VAPID para las notificaciones push.
// Uso: npm run gen:vapid
// Copia los dos valores en tu .env (VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY).
const webpush = require('web-push');

const keys = webpush.generateVAPIDKeys();
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
