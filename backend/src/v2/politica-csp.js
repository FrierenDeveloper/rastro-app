// Política de seguridad de contenido del frontend.
'use strict';

function origenFotosR2(urlPublica) {
  try {
    return urlPublica ? new URL(urlPublica).origin : '';
  } catch {
    return '';
  }
}

function directivasCsp(urlPublicaR2) {
  const origenFotos = origenFotosR2(urlPublicaR2);
  return {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com', 'https://unpkg.com', 'https://accounts.google.com'],
    styleSrc: [
      "'self'",
      "'unsafe-inline'",
      'https://cdnjs.cloudflare.com',
      'https://unpkg.com',
      'https://fonts.googleapis.com'
    ],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    imgSrc: [
      "'self'",
      'data:',
      'blob:',
      'https://*.tile.openstreetmap.org',
      'https://tile.openstreetmap.org',
      'https://server.arcgisonline.com',
      'https://*.tile.opentopomap.org',
      'https://cdnjs.cloudflare.com',
      'https://*.supabase.co',
      ...(origenFotos ? [origenFotos] : [])
    ],
    connectSrc: [
      "'self'",
      'https://*.supabase.co',
      'https://fonts.googleapis.com',
      'https://fonts.gstatic.com',
      'https://cdnjs.cloudflare.com',
      'https://unpkg.com',
      'https://accounts.google.com'
    ],
    frameSrc: ["'self'", 'https://accounts.google.com'],
    workerSrc: ["'self'"],
    manifestSrc: ["'self'"]
  };
}

module.exports = { directivasCsp };
