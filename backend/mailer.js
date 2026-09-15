// mailer.js
// Envío de correos. Si configuras RESEND_API_KEY, usa Resend (tiene plan
// gratuito). Si no, imprime el correo en la consola del servidor: así puedes
// probar el flujo de "recuperar contraseña" sin pagar ni crear cuentas.
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const MAIL_FROM = process.env.MAIL_FROM || 'Rastro <onboarding@resend.dev>';

async function sendMail({ to, subject, text, html }) {
  if (!RESEND_API_KEY) {
    if (process.env.NODE_ENV === 'production') {
      // En producción NO imprimimos el contenido (puede incluir enlaces de reset).
      console.warn(`[mailer] RESEND_API_KEY no configurada: no se envió el correo a ${to}.`);
    } else {
      console.log('[mailer] RESEND_API_KEY no configurada. Correo que se habría enviado:');
      console.log(`  Para: ${to}`);
      console.log(`  Asunto: ${subject}`);
      console.log(`  ${text}`);
    }
    return { skipped: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: MAIL_FROM, to: [to], subject, text, html })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend respondió ${res.status}: ${body}`);
  }
  return res.json();
}

module.exports = { sendMail, usingEmail: !!RESEND_API_KEY, mailFrom: MAIL_FROM };
