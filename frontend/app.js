// Registrar el service worker ANTES que cualquier otro código: si algo más
// abajo en este archivo llegara a fallar, el registro no debe verse afectado.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

// ============ Configuración ============
const API_BASE = window.RASTRO_API_BASE || '';

let token = localStorage.getItem('rastro_token') || null;
let me = null;
let config = { googleClientId: '', pushEnabled: false, vapidPublicKey: '' };
let userLoc = { lat: -33.4489, lng: -70.6693 }; // Santiago, Chile (fallback)
let photoFile = { found: null, lost: null, reunion: null };
let pickedLoc = { found: null, lost: null };
let listMap, clusterGroup, mapFound, mapLost, markerFound, markerLost;
let userMarker = null,
  userAccuracy = null,
  destinoMarker = null;
let ultimaUbicacion = null,
  primeraUbicacion = true;
let pickedManual = { found: false, lost: false };
let allReports = [];
let myReports = [];
let currentConv = { reportId: null, peerId: null, esMio: false, poll: null };
let editingId = null;

const TIPO_ICON = { perro: '🐕', gato: '🐈', ave: '🐦', conejo: '🐇', otro: '🐾' };

// Misma estimación que backend/busqueda.js: cuánto se aleja una mascota según
// el tiempo. ESTA FÓRMULA ESTÁ DUPLICADA A PROPÓSITO (aquí y en el backend)
// para poder mostrar la sugerencia al instante, sin ir al servidor. Si cambias
// una, cambia la otra: hay una prueba (.audit/features.mjs) que compara ambas.
//
// El "base" de cada tipo está anclado a estudios publicados:
//   - gato: mediana de 50 m (Huang et al. 2018, Animals 8(1):5; 75% dentro de 500 m)
//   - perro: radio típico ~400 m (Ignatius 2015, citando a Lord et al. 2007)
// Lo que crece con el tiempo es una modelización nuestra (raíz del tiempo).
const RADIO_PERFIL = {
  gato: { base: 0.05, crece: 0.25, tope: 1.5 },
  perro: { base: 0.4, crece: 1.6, tope: 15.0 },
  ave: { base: 0.3, crece: 2.0, tope: 30.0 },
  conejo: { base: 0.15, crece: 0.35, tope: 2.0 },
  otro: { base: 0.3, crece: 1.0, tope: 10.0 }
};
function radioBusquedaKm(tipo, horas) {
  const p = RADIO_PERFIL[tipo] || RADIO_PERFIL.otro;
  const h = Math.max(0, Number(horas) || 0);
  const km = p.base + p.crece * Math.sqrt(h / 24);
  return Math.round(Math.min(p.tope, km) * 100) / 100;
}
// Etiqueta corta y legible: metros si es menos de 1 km.
function fmtRadio(km) {
  return km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;
}

// Texto de ayuda según el estudio y el tipo de animal.
function consejoBusqueda(tipo, horas) {
  if (tipo === 'gato') {
    return 'El 75% de los gatos perdidos aparece dentro de 500 m de donde se escapó: revisa a fondo tu casa, patios vecinos, bajo terrazas y autos antes de irte lejos.';
  }
  if (tipo === 'perro') {
    return horas <= 24
      ? 'Los perros se recuperan sobre todo porque alguien los encuentra: refugios, veterinarias y carteles en el barrio rinden más que caminar kilómetros.'
      : 'A estas alturas lo que más rinde es la difusión (refugios, veterinarias, carteles y redes del barrio): más de un tercio de los perros recuperados apareció en un refugio.';
  }
  return 'Empieza por la zona cercana y avisa a los vecinos; después amplía hacia donde haya más gente.';
}

/* ---------- Gráfico: cómo crece el radio con las horas ---------- */
// Se dibuja a mano en SVG (sin librerías: la app no tiene build step).
// Los colores usan las variables CSS del tema, así funciona igual en claro y
// en oscuro sin duplicar el gráfico.
// Eje X = horas (0 a 72), eje Y = radio sugerido. Marca el punto del usuario.
function graficoRadioSVG(tipo, horasUsuario) {
  const W = 320,
    H = 150,
    ML = 46,
    MR = 10,
    MT = 16,
    MB = 24;
  const ancho = W - ML - MR,
    alto = H - MT - MB;
  const horasMax = 72;
  const puntos = [];
  for (let i = 0; i <= 36; i++) {
    const h = (horasMax * i) / 36;
    puntos.push({ h, km: radioBusquedaKm(tipo, h) });
  }
  const kmMax = Math.max(...puntos.map(p => p.km), 0.1) * 1.15;
  const x = h => ML + (h / horasMax) * ancho;
  const y = km => MT + alto - (km / kmMax) * alto;

  const linea = puntos.map((p, i) => `${i ? 'L' : 'M'}${x(p.h).toFixed(1)},${y(p.km).toFixed(1)}`).join(' ');
  const area =
    `M${x(0)},${y(0)} ` +
    puntos.map(p => `L${x(p.h).toFixed(1)},${y(p.km).toFixed(1)}`).join(' ') +
    ` L${x(horasMax)},${y(0)} Z`;

  const marcasX = [0, 24, 48, 72]
    .map(
      h =>
        `<line x1="${x(h).toFixed(1)}" y1="${MT + alto}" x2="${x(h).toFixed(1)}" y2="${MT + alto + 4}" stroke="var(--line)"/>
     <text x="${x(h).toFixed(1)}" y="${H - 6}" font-size="9" text-anchor="middle" fill="var(--ink-soft)">${h === 0 ? 'ahora' : h + ' h'}</text>`
    )
    .join('');
  const marcasY = [0, kmMax / 2, kmMax]
    .map(
      km =>
        `<line x1="${ML - 4}" y1="${y(km).toFixed(1)}" x2="${ML}" y2="${y(km).toFixed(1)}" stroke="var(--line)"/>
     <text x="${ML - 6}" y="${(y(km) + 3).toFixed(1)}" font-size="9" text-anchor="end" fill="var(--ink-soft)">${fmtRadio(km)}</text>`
    )
    .join('');

  const hUser = Math.min(horasMax, Math.max(0, Number(horasUsuario) || 0));
  const kmUser = radioBusquedaKm(tipo, hUser);
  const yEtiqueta = Math.max(MT + 8, y(kmUser) - 8);
  const punto = `<circle cx="${x(hUser).toFixed(1)}" cy="${y(kmUser).toFixed(1)}" r="4.5" fill="var(--rust)" stroke="var(--card)" stroke-width="1.5"/>
    <text x="${x(hUser).toFixed(1)}" y="${yEtiqueta.toFixed(1)}" font-size="10" font-weight="700" text-anchor="middle" fill="var(--rust)">${fmtRadio(kmUser)}</text>`;

  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Radio de búsqueda sugerido según las horas transcurridas" style="width:100%;height:auto;display:block">
    <path d="${area}" fill="var(--green)" opacity="0.14"/>
    <path d="${linea}" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linejoin="round"/>
    ${marcasY}${marcasX}
    <line x1="${ML}" y1="${MT + alto}" x2="${ML + ancho}" y2="${MT + alto}" stroke="var(--line)"/>
    ${punto}
  </svg>`;
}

// Actualiza la sugerencia Y el gráfico del formulario de "Perdí".
function actualizarRadioHint() {
  const el = document.getElementById('radio-hint-lost');
  const cont = document.getElementById('radio-chart-lost');
  const tipo = document.getElementById('tipo-lost').value;
  const horas = Number(document.getElementById('perdido-hace-lost').value);
  if (!tipo || !horas) {
    if (el) el.textContent = '';
    if (cont) cont.innerHTML = '';
    return;
  }
  const km = radioBusquedaKm(tipo, horas);
  if (el) {
    el.innerHTML =
      `🔍 Te sugerimos revisar <b>${fmtRadio(km)}</b> a la redonda y avisaremos a las personas con alertas de zona dentro de ese radio.` +
      `<br><span class="hint-suave">${consejoBusqueda(tipo, horas)}</span>`;
  }
  if (cont) {
    cont.innerHTML = `<div class="chart-card">
      <div class="chart-titulo">Cómo crece la zona de búsqueda con las horas</div>
      ${graficoRadioSVG(tipo, horas)}
      <div class="chart-pie">Basado en estudios publicados: gatos aparecen en mediana a 50 m (75% dentro de 500 m) · perros en un radio típico de ~400 m.</div>
    </div>`;
  }
}

/* ============ Capa de mapa con proveedores de respaldo ============ */
// Algunas redes, bloqueadores o países bloquean un proveedor de tiles concreto
// y el mapa queda gris. Si el proveedor principal falla varias veces seguidas,
// saltamos automáticamente al siguiente para que el mapa siempre se vea.
// Nota: CARTO y Stadia ya exigen API key (devuelven tiles con marca de agua),
// por eso no se usan aquí.
const TILE_PROVIDERS = [
  {
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri',
    maxZoom: 19
  },
  { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: '© OpenStreetMap', maxZoom: 19 },
  { url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png', attribution: '© OpenTopoMap', maxZoom: 17 }
];

function agregarCapaTiles(map) {
  let idx = 0;
  let capa = null;

  const montar = () => {
    const p = TILE_PROVIDERS[idx];
    capa = L.tileLayer(p.url, { attribution: p.attribution, maxZoom: p.maxZoom });
    let fallos = 0;
    capa.on('tileerror', () => {
      fallos++;
      // Varios fallos seguidos = ese proveedor no sirve en esta red: probamos el siguiente.
      if (fallos >= 3 && idx < TILE_PROVIDERS.length - 1) {
        console.warn('Rastro: los tiles de ' + p.url + ' fallaron; probando un proveedor de respaldo…');
        map.removeLayer(capa);
        idx++;
        montar();
      }
    });
    capa.addTo(map);
  };

  montar();
  return capa;
}

/* ============ Utilidades ============ */
// Escapa el texto que escriben los usuarios antes de mostrarlo, para que
// nadie pueda inyectar código en la página a través de un aviso o mensaje.
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}
function timeAgo(ts) {
  const diff = Date.now() - ts,
    m = Math.floor(diff / 60000),
    h = Math.floor(m / 60),
    d = Math.floor(h / 24);
  if (d > 0) return `hace ${d} día${d > 1 ? 's' : ''}`;
  if (h > 0) return `hace ${h} hora${h > 1 ? 's' : ''}`;
  if (m > 0) return `hace ${m} min`;
  return 'recién';
}
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let w = img.width,
          h = img.height;
        const max = 800;
        if (w > h && w > max) {
          h = Math.round((h * max) / w);
          w = max;
        } else if (h >= w && h > max) {
          w = Math.round((w * max) / h);
          h = max;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.75);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function api(path, { method = 'GET', body = null, isForm = false, auth = true } = {}) {
  const headers = {};
  if (auth && token) headers['Authorization'] = 'Bearer ' + token;
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: isForm ? body : body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    /* respuesta vacía */
  }
  if (!res.ok) {
    if (res.status === 401 && auth && token) logout();
    throw new Error(data.error || 'Ocurrió un error.');
  }
  return data;
}
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
// Las fotos pueden ser una ruta local (/uploads/..) o una URL absoluta de
// Supabase Storage. No hay que anteponer API_BASE a las absolutas.
function fotoSrc(u) {
  if (!u) return '';
  return /^https?:\/\//.test(u) ? u : API_BASE + u;
}

/* ============ Arranque ============ */
async function loadConfig() {
  try {
    config = await api('/api/config', { auth: false });
  } catch (e) {
    /* usa valores por defecto */
  }
  if (config.pushEnabled) document.getElementById('btn-push').classList.remove('hidden');
  if (config.googleClientId) initGoogle();
}

function showAuth() {
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('reset-screen').classList.add('hidden');
}
function showApp() {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('reset-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}
function logout() {
  token = null;
  me = null;
  localStorage.removeItem('rastro_token');
  if (currentConv.poll) {
    clearInterval(currentConv.poll);
    currentConv.poll = null;
  }
  ubicacion.detener();
  showAuth();
}

function onAuthSuccess(newToken) {
  token = newToken;
  localStorage.setItem('rastro_token', token);
  showApp();
  startApp();
}

/* ============ Auth screen ============ */
document.querySelectorAll('.auth-tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    document.getElementById('form-' + btn.dataset.auth).classList.add('active');
  });
});
document.getElementById('link-forgot').addEventListener('click', e => {
  e.preventDefault();
  document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
  document.getElementById('form-forgot').classList.add('active');
});
document.getElementById('link-back-login').addEventListener('click', e => {
  e.preventDefault();
  document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
  document.getElementById('form-login').classList.add('active');
});

document.getElementById('form-login').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('login-error');
  err.classList.remove('show');
  try {
    const data = await api('/api/auth/login', {
      method: 'POST',
      auth: false,
      body: {
        email: document.getElementById('login-email').value.trim(),
        password: document.getElementById('login-password').value
      }
    });
    onAuthSuccess(data.token);
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.add('show');
  }
});

document.getElementById('form-forgot').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('forgot-error');
  const okEl = document.getElementById('forgot-ok');
  err.classList.remove('show');
  okEl.classList.remove('show');
  try {
    const data = await api('/api/auth/forgot', {
      method: 'POST',
      auth: false,
      body: { email: document.getElementById('forgot-email').value.trim() }
    });
    okEl.textContent = data.message;
    okEl.classList.add('show');
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.add('show');
  }
});

document.getElementById('form-register').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('register-error');
  err.classList.remove('show');
  try {
    const { challenge } = await api('/api/auth/challenge', { auth: false });
    const data = await api('/api/auth/register', {
      method: 'POST',
      auth: false,
      body: {
        email: document.getElementById('register-email').value.trim(),
        password: document.getElementById('register-password').value,
        phone: document.getElementById('register-phone').value.trim(),
        website: document.getElementById('register-website').value,
        captcha: challenge
      }
    });
    onAuthSuccess(data.token);
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.add('show');
  }
});

document.getElementById('form-reset').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('reset-error');
  err.classList.remove('show');
  const tok = new URLSearchParams(location.search).get('reset');
  try {
    await api('/api/auth/reset', {
      method: 'POST',
      auth: false,
      body: { token: tok, password: document.getElementById('reset-password').value }
    });
    toast('Contraseña actualizada. Inicia sesión.');
    history.replaceState(null, '', location.pathname);
    showAuth();
  } catch (ex) {
    err.textContent = ex.message;
    err.classList.add('show');
  }
});

const NOTAS_PW = {
  1: 'Débil: agrega mayúsculas, números o símbolos.',
  2: 'Aceptable.',
  3: 'Buena.',
  4: 'Excelente.'
};
function fuerzaPassword(pw) {
  let score = 1;
  if (pw.length >= 12) score++;
  if (pw.length >= 16) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score++;
  return Math.min(score, 4);
}
function activarMedidorPassword(inputId, meterId, noteId) {
  const input = document.getElementById(inputId);
  const meter = document.getElementById(meterId);
  const note = document.getElementById(noteId);
  input.addEventListener('input', () => {
    const pw = input.value;
    if (!pw) {
      meter.dataset.score = '0';
      note.textContent = 'Mínimo 10 caracteres.';
    } else if (pw.length < 10) {
      meter.dataset.score = '1';
      note.textContent = `Faltan ${10 - pw.length} caracteres.`;
    } else {
      const score = fuerzaPassword(pw);
      meter.dataset.score = String(score);
      note.textContent = NOTAS_PW[score];
    }
  });
}
activarMedidorPassword('register-password', 'register-pw-meter', 'register-pw-note');
activarMedidorPassword('reset-password', 'reset-pw-meter', 'reset-pw-note');

function initGoogle() {
  const area = document.getElementById('google-area');
  area.classList.remove('hidden');
  const start = () => {
    if (!window.google || !google.accounts) return setTimeout(start, 300);
    google.accounts.id.initialize({
      client_id: config.googleClientId,
      callback: async resp => {
        try {
          const data = await api('/api/auth/google', {
            method: 'POST',
            auth: false,
            body: { credential: resp.credential }
          });
          onAuthSuccess(data.token);
        } catch (ex) {
          toast(ex.message);
        }
      }
    });
    google.accounts.id.renderButton(document.querySelector('.g_id_signin'), {
      theme: 'outline',
      size: 'large',
      width: 300
    });
  };
  start();
}

document.getElementById('btn-logout').addEventListener('click', logout);

document.getElementById('btn-delete-account').addEventListener('click', async () => {
  if (
    !confirm(
      'Esto eliminará tu cuenta, tus avisos, tus fotos y tus mensajes de forma permanente. ¿Continuar?'
    )
  )
    return;
  try {
    await api('/api/auth/me', { method: 'DELETE' });
    toast('Cuenta eliminada.');
    logout();
  } catch (ex) {
    toast(ex.message);
  }
});

/* ============ Tabs ============ */
document.querySelectorAll('nav.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'home') {
      setTimeout(() => listMap && listMap.invalidateSize(), 50);
      renderList()
        .then(renderListMap)
        .catch(() => {});
    }
    if (btn.dataset.tab === 'found') {
      asegurarPicker('found');
    }
    if (btn.dataset.tab === 'lost') {
      asegurarPicker('lost');
    }
    if (btn.dataset.tab === 'chats') {
      cerrarConversacion();
      renderThreads();
    }
    if (btn.dataset.tab === 'exitos') {
      renderReunions();
    }
    if (btn.dataset.tab === 'admin') {
      renderAdmin();
    }
    if (btn.dataset.tab === 'inbox') {
      renderInbox();
    }
  });
});

/* ============ Geolocalización ============ */
// Política de ubicación (a propósito, poco invasiva):
//
//   * NO hay seguimiento continuo. Antes se usaba watchPosition() con
//     enableHighAccuracy, que enciende el GPS y lo deja encendido mientras la
//     app esté abierta: eso gasta batería y obliga a Android a mostrar el
//     indicador de ubicación todo el rato. Se quitó.
//   * Se pide la ubicación UNA vez al abrir la app (con precisión de red, no de
//     GPS: para pintar un punto en un mapa de la ciudad sobra y es más rápido).
//   * Si vuelves a la app después de un rato, se refresca sola solo si el dato
//     tiene más de UBICACION_MAX_MS. Y el botón "Ir a mí" siempre refresca.
//   * La última ubicación se guarda en localStorage para no volver a pedirla al
//     recargar, y se borra al cerrar sesión.
//
// Nada de esto se manda al servidor por el simple hecho de abrir la app: la
// ubicación solo viaja si publicas un aviso, guardas tu zona de alertas o
// adjuntas "lo vi aquí" a un mensaje.
const UBICACION_CLAVE = 'rastro_ubicacion';
const UBICACION_MAX_MS = 5 * 60 * 1000; // a partir de 5 min se considera vieja
const ubicacion = {
  ultima: null, // { lat, lng, accuracy, ts }
  watchId: null, // solo si el usuario activa el seguimiento a propósito
  pidiendo: false,
  // Al cerrar sesión: se corta cualquier seguimiento y se olvida la ubicación.
  detener() {
    if (this.watchId !== null && navigator.geolocation && navigator.geolocation.clearWatch) {
      navigator.geolocation.clearWatch(this.watchId);
    }
    this.watchId = null;
    this.ultima = null;
    try {
      localStorage.removeItem(UBICACION_CLAVE);
    } catch (e) {
      /* no crítico */
    }
  }
};

function guardarUbicacion() {
  try {
    if (ubicacion.ultima) localStorage.setItem(UBICACION_CLAVE, JSON.stringify(ubicacion.ultima));
  } catch (e) {
    /* modo privado o sin espacio: no es crítico */
  }
}
function leerUbicacionGuardada() {
  try {
    const crudo = localStorage.getItem(UBICACION_CLAVE);
    if (!crudo) return null;
    const u = JSON.parse(crudo);
    if (typeof u.lat !== 'number' || typeof u.lng !== 'number') return null;
    return u;
  } catch (e) {
    return null;
  }
}
function ubicacionVieja() {
  return !ubicacion.ultima || Date.now() - ubicacion.ultima.ts > UBICACION_MAX_MS;
}

// Marcador azul "estás aquí" (con el círculo de precisión) en el mapa principal.
function pintarMarcadorUsuario() {
  if (!listMap || !ultimaUbicacion) return;
  const { lat, lng, accuracy } = ultimaUbicacion;
  if (!userMarker) {
    userAccuracy = L.circle([lat, lng], {
      radius: accuracy || 0,
      color: '#2B7DE9',
      weight: 1,
      fillColor: '#2B7DE9',
      fillOpacity: 0.12,
      interactive: false
    }).addTo(listMap);
    userMarker = L.circleMarker([lat, lng], {
      radius: 7,
      color: '#fff',
      weight: 2,
      fillColor: '#2B7DE9',
      fillOpacity: 1
    }).addTo(listMap);
    userMarker.bindPopup('Estás aquí');
  } else {
    userMarker.setLatLng([lat, lng]);
    userAccuracy.setLatLng([lat, lng]).setRadius(accuracy || 0);
  }
}

function aplicarUbicacion(lat, lng, accuracy, { deCache = false } = {}) {
  userLoc = { lat, lng };
  ultimaUbicacion = { lat, lng, accuracy: accuracy || 0 };
  ubicacion.ultima = { lat, lng, accuracy: accuracy || 0, ts: Date.now() };
  if (!deCache) guardarUbicacion();
  const chip = document.getElementById('loc-chip');
  if (chip) chip.textContent = '📍 Ubicación detectada';
  pintarMarcadorUsuario();
  // Solo movemos los mapas de "Encontré/Perdí" en la primera lectura y si el
  // usuario no eligió una ubicación a mano.
  if (primeraUbicacion) {
    primeraUbicacion = false;
    ['found', 'lost'].forEach(key => {
      const map = key === 'found' ? mapFound : mapLost;
      const marker = key === 'found' ? markerFound : markerLost;
      if (map && !pickedManual[key]) {
        map.setView([lat, lng], 15);
        if (marker) marker.setLatLng([lat, lng]);
        pickedLoc[key] = { lat, lng };
      }
    });
  }
}

// Pide UNA posición. Por defecto con precisión de red (rápida y suficiente);
// alta precisión solo si el usuario la pide a propósito.
function pedirUbicacion({ altaPrecision = false } = {}) {
  const chip = document.getElementById('loc-chip');
  if (!navigator.geolocation) {
    if (chip) chip.textContent = '📍 Santiago (ubicación manual)';
    return Promise.resolve(null);
  }
  if (ubicacion.pidiendo) return Promise.resolve(null);
  ubicacion.pidiendo = true;
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      pos => {
        ubicacion.pidiendo = false;
        aplicarUbicacion(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
        resolve(pos);
      },
      () => {
        ubicacion.pidiendo = false;
        if (chip && !ubicacion.ultima) chip.textContent = '📍 Santiago (toca el mapa para ajustar)';
        resolve(null);
      },
      altaPrecision
        ? { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
        : { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 }
    );
  });
}

// Al abrir la app: usa lo guardado y, si está viejo, refresca en segundo plano.
function locateUser() {
  const guardada = leerUbicacionGuardada();
  if (guardada) {
    aplicarUbicacion(guardada.lat, guardada.lng, guardada.accuracy, { deCache: true });
  }
  if (ubicacionVieja()) pedirUbicacion();
}

// Un solo listener de visibilidad para toda la ubicación:
//   - al volver a la app, refresca solo si el dato guardado caducó;
//   - al salir de la app, corta el seguimiento continuo (si estaba activo),
//     para no dejar el GPS encendido en segundo plano.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (estaSiguiendo()) {
      seguirUbicacion(false);
      actualizarBotonSeguir();
    }
    return;
  }
  if (token && ubicacionVieja()) pedirUbicacion();
});

/* Seguimiento continuo: SOLO mientras el usuario lo tenga activado con el botón
   "siguiendo" (por ejemplo, si va caminando buscando a su mascota). Se apaga
   solo al ocultar la pestaña y como máximo dura UBICACION_SIGUIENDO_MAX_MS. */
const UBICACION_SIGUIENDO_MAX_MS = 10 * 60 * 1000;
let siguiendoDesde = 0;
function seguirUbicacion(activar) {
  if (!navigator.geolocation) return false;
  if (activar) {
    if (ubicacion.watchId !== null) return true;
    siguiendoDesde = Date.now();
    ubicacion.watchId = navigator.geolocation.watchPosition(
      pos => {
        aplicarUbicacion(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
        // Se corta solo: no dejamos el GPS encendido indefinidamente.
        if (Date.now() - siguiendoDesde > UBICACION_SIGUIENDO_MAX_MS) seguirUbicacion(false);
      },
      () => {},
      { enableHighAccuracy: true, maximumAge: 15000, timeout: 20000 }
    );
    return true;
  }
  if (ubicacion.watchId !== null) {
    navigator.geolocation.clearWatch(ubicacion.watchId);
    ubicacion.watchId = null;
  }
  return false;
}
function estaSiguiendo() {
  return ubicacion.watchId !== null;
}

// Refleja en el botón si el seguimiento está activo.
function actualizarBotonSeguir() {
  const btn = document.getElementById('btn-seguir');
  if (!btn) return;
  const activo = estaSiguiendo();
  btn.classList.toggle('active', activo);
  btn.textContent = activo ? '📡 Siguiendo' : '📡 Seguir';
  btn.title = activo
    ? 'Dejar de seguir tu ubicación'
    : 'Mantener tu punto actualizado mientras te mueves (gasta más batería)';
}

function initPicker(elId, key) {
  const map = L.map(elId, { zoomControl: true }).setView([userLoc.lat, userLoc.lng], 14);
  agregarCapaTiles(map);
  const marker = L.marker([userLoc.lat, userLoc.lng], { draggable: true }).addTo(map);
  pickedLoc[key] = { ...userLoc };
  marker.on('dragend', () => {
    const p = marker.getLatLng();
    pickedLoc[key] = { lat: p.lat, lng: p.lng };
    pickedManual[key] = true;
  });
  map.on('click', e => {
    marker.setLatLng(e.latlng);
    pickedLoc[key] = { lat: e.latlng.lat, lng: e.latlng.lng };
    pickedManual[key] = true;
  });
  return { map, marker };
}

/* ============ Buscador de direcciones (solo Chile) ============ */
function elegirUbicacion(key, lat, lng) {
  pickedLoc[key] = { lat, lng };
  pickedManual[key] = true;
  const map = key === 'found' ? mapFound : mapLost;
  const marker = key === 'found' ? markerFound : markerLost;
  if (map) map.setView([lat, lng], 16);
  if (marker) marker.setLatLng([lat, lng]);
}

function initAddressSearch(inputId, resultsId, onPick) {
  const input = document.getElementById(inputId);
  const box = document.getElementById(resultsId);
  if (!input || !box) return;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) {
      box.classList.add('hidden');
      box.innerHTML = '';
      return;
    }
    timer = setTimeout(async () => {
      try {
        const { results } = await api('/api/geocode?q=' + encodeURIComponent(q));
        if (!results.length) {
          box.innerHTML = '<div class="addr-empty">Sin resultados en Chile.</div>';
          box.classList.remove('hidden');
          return;
        }
        box.innerHTML = results
          .map(
            r =>
              `<div class="addr-item" data-lat="${r.lat}" data-lng="${r.lng}" data-label="${esc(r.label)}">${esc(r.label)}</div>`
          )
          .join('');
        box.classList.remove('hidden');
      } catch (e) {
        box.classList.add('hidden');
        box.innerHTML = '';
      }
    }, 350);
  });
  box.addEventListener('click', e => {
    const item = e.target.closest('.addr-item');
    if (!item) return;
    input.value = item.dataset.label;
    box.classList.add('hidden');
    onPick(parseFloat(item.dataset.lat), parseFloat(item.dataset.lng));
  });
}
// Un solo listener global cierra cualquier lista de sugerencias abierta.
document.addEventListener('click', e => {
  if (!e.target.closest('.addr-search')) {
    document.querySelectorAll('.addr-results').forEach(b => b.classList.add('hidden'));
  }
});

/* ============ Zonas de foto ============ */
function initPhotoZone(zoneId, inputId, key) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    if (!input.files || !input.files[0]) return;
    try {
      const blob = await compressImage(input.files[0]);
      photoFile[key] = blob;
      mostrarPreviewFoto(zone, input, URL.createObjectURL(blob));
    } catch (e) {
      toast('No se pudo procesar la foto.');
    }
  });
}
// Cambia el contenido visible de la zona sin tocar el <input>, para no perder
// (ni duplicar) los listeners que ya están conectados.
function mostrarPreviewFoto(zone, input, url) {
  Array.from(zone.children).forEach(ch => {
    if (ch !== input) ch.remove();
  });
  const img = document.createElement('img');
  img.src = url;
  img.alt = 'Foto del animal';
  zone.appendChild(img);
}
function limpiarZonaFoto(zone, input) {
  Array.from(zone.children).forEach(ch => {
    if (ch !== input) ch.remove();
  });
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML = '<b>📷</b>Toca para tomar o subir una foto';
  zone.appendChild(hint);
}

/* ============ Publicar aviso ============ */
function resetForm(key) {
  document.getElementById('form-' + key).reset();
  photoFile[key] = null;
  const zone = document.getElementById('photo-zone-' + key);
  const input = document.getElementById('photo-input-' + key);
  input.value = '';
  limpiarZonaFoto(zone, input);
}
function renderMatchBanner(containerId, matches) {
  const el = document.getElementById(containerId);
  if (matches.length === 0) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<div class="match-banner">
    <h3>🐾 ${matches.length} posible${matches.length > 1 ? 's' : ''} coincidencia${matches.length > 1 ? 's' : ''} cerca</h3>
    <p>Mismo tipo de animal, color parecido y a menos de 5 km. Ábrelo desde "Mapa" para contactar dentro de la app.</p>
    ${matches.map(m => `<div class="match-item">${TIPO_ICON[m.tipo] || '🐾'} ${esc(m.color)} · ${esc(m.distancia_km)} km</div>`).join('')}
  </div>`;
}
async function handleSubmit(estado, key) {
  const get = id => document.getElementById(id + '-' + key).value.trim();
  const tipo = get('tipo'),
    sexo = get('sexo'),
    color = get('color'),
    raza = get('raza'),
    collar = get('collar'),
    desc = get('desc'),
    nombre = key === 'lost' ? get('nombre') : '';
  if (!tipo || !color) {
    toast('Completa los campos obligatorios (*).');
    return;
  }

  const loc = pickedLoc[key] || userLoc;
  const btn = document.querySelector(`#form-${key} .submit-btn`);
  btn.disabled = true;
  btn.textContent = 'Publicando…';

  try {
    const fd = new FormData();
    fd.append('estado', estado);
    fd.append('tipo', tipo);
    fd.append('sexo', sexo);
    fd.append('color', color);
    fd.append('raza', raza);
    fd.append('collar', collar);
    fd.append('descripcion', desc);
    fd.append('nombre_mascota', nombre);
    fd.append('lat', loc.lat);
    fd.append('lng', loc.lng);
    if (estado === 'perdido') {
      const horas = document.getElementById('perdido-hace-lost').value;
      if (horas) fd.append('perdido_hace_horas', horas);
    }
    if (photoFile[key]) fd.append('foto', photoFile[key], 'foto.jpg');

    const { report } = await api('/api/reports', { method: 'POST', isForm: true, body: fd });
    toast('¡Aviso publicado!');
    resetForm(key);
    try {
      const { matches } = await api(`/api/reports/${report.id}/matches`);
      renderMatchBanner('match-area-' + key, matches);
    } catch (e) {
      /* el aviso ya se publicó; las coincidencias son un extra */
    }
    renderList()
      .then(renderListMap)
      .catch(() => {});
  } catch (ex) {
    toast(ex.message);
  } finally {
    btn.disabled = false;
    btn.textContent =
      estado === 'encontrado' ? 'Publicar aviso de animal encontrado' : 'Publicar aviso de mascota perdida';
  }
}
document.getElementById('form-found').addEventListener('submit', e => {
  e.preventDefault();
  handleSubmit('encontrado', 'found');
});
document.getElementById('form-lost').addEventListener('submit', e => {
  e.preventDefault();
  handleSubmit('perdido', 'lost');
});
document.getElementById('tipo-lost').addEventListener('change', actualizarRadioHint);
document.getElementById('perdido-hace-lost').addEventListener('change', actualizarRadioHint);

/* ============ Home: lista y mapa ============ */
async function fetchReports() {
  const tipo = document.getElementById('filter-tipo').value;
  const estado = document.getElementById('filter-estado').value;
  const q = (document.getElementById('search-text').value || '').trim();
  const qs = new URLSearchParams();
  if (tipo) qs.set('tipo', tipo);
  if (estado) qs.set('estado', estado);
  if (q) qs.set('q', q);
  const { reports } = await api('/api/reports?' + qs.toString());
  allReports = reports.sort((a, b) => b.created_at - a.created_at);
}
function reportCard(r) {
  return `
    <div class="report-card ${r.estado === 'perdido' ? 'lost' : ''}" data-id="${esc(r.id)}">
      ${r.foto_url ? `<img src="${esc(fotoSrc(r.foto_url))}" alt="" loading="lazy">` : `<div class="ph-placeholder">${TIPO_ICON[r.tipo] || '🐾'}</div>`}
      <div class="report-body">
        <div class="report-top">
          <h4>${TIPO_ICON[r.tipo] || '🐾'} ${esc(r.color)}${r.raza ? ' · ' + esc(r.raza) : ''}</h4>
          <span class="tag ${r.estado === 'perdido' ? 'lost' : 'found'}">${r.estado === 'perdido' ? 'Perdido' : 'Encontrado'}</span>
        </div>
        <div class="report-meta">${r.sexo !== 'desconocido' ? { macho: 'Macho', hembra: 'Hembra' }[r.sexo] + ' · ' : ''}${r.collar ? 'Collar ' + esc(r.collar) + ' · ' : ''}${timeAgo(r.created_at)}${r.radio_km ? ' · 🔍 ~' + esc(r.radio_km) + ' km' : ''}</div>
        ${r.descripcion ? `<div class="report-meta">${esc(r.descripcion)}</div>` : ''}
        <div class="report-actions">
          ${
            r.es_mio
              ? `<button data-action="matches" data-id="${esc(r.id)}">Coincidencias</button>`
              : `<button data-action="contact" data-id="${esc(r.id)}">Contactar</button><button data-action="flag" data-id="${esc(r.id)}">Reportar</button>`
          }
          <button data-action="share" data-id="${esc(r.id)}">Compartir</button>
        </div>
        <div class="matches-box" id="matches-${esc(r.id)}" style="display:none;"></div>
        <div class="contact-box hidden" id="contact-${esc(r.id)}">
          <textarea class="contact-text" placeholder="Escribe un mensaje para quien publicó este aviso…"></textarea>
          <label class="check"><input type="checkbox" class="contact-loc"> Adjuntar mi ubicación actual</label>
          <button data-action="send" data-id="${esc(r.id)}">Enviar mensaje</button>
        </div>
      </div>
    </div>`;
}
async function renderList() {
  await fetchReports();
  const el = document.getElementById('reports-list');
  if (allReports.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="big">🐾</div>Todavía no hay avisos.<br>Publica el primero desde las pestañas de arriba.</div>`;
    return;
  }
  el.innerHTML = allReports.map(reportCard).join('');
}

async function toggleMatches(id) {
  const box = document.getElementById('matches-' + id);
  if (box.style.display === 'block') {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'block';
  box.innerHTML = '<span class="none">Buscando…</span>';
  try {
    const { matches } = await api(`/api/reports/${id}/matches`);
    box.innerHTML = matches.length
      ? matches
          .map(m => `<div>${TIPO_ICON[m.tipo] || '🐾'} ${esc(m.color)} · ${esc(m.distancia_km)} km</div>`)
          .join('')
      : `<span class="none">Sin coincidencias por ahora.</span>`;
  } catch (ex) {
    box.innerHTML = `<span class="none">${esc(ex.message)}</span>`;
  }
}
function toggleContact(id) {
  document.getElementById('contact-' + id).classList.toggle('hidden');
}
async function getCurrentLocOrNull() {
  if (!navigator.geolocation) return null;
  return new Promise(resolve => {
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(null),
      { timeout: 6000 }
    );
  });
}
async function sendContact(id) {
  const card = document.querySelector(`.report-card[data-id="${id}"]`);
  const ta = card.querySelector('.contact-text');
  if (!ta.value.trim()) return;
  const body = { mensaje: ta.value.trim() };
  if (card.querySelector('.contact-loc').checked) {
    const loc = await getCurrentLocOrNull();
    if (loc) {
      body.lat = loc.lat;
      body.lng = loc.lng;
    }
  }
  try {
    await api(`/api/reports/${id}/messages`, { method: 'POST', body });
    toast('Mensaje enviado. Lo verás en "Chats".');
    ta.value = '';
    document.getElementById('contact-' + id).classList.add('hidden');
    actualizarBadgeChats();
  } catch (ex) {
    toast(ex.message);
  }
}
async function shareReport(id) {
  const url = location.origin + '/?r=' + id;
  const shareData = { title: 'Rastro', text: 'Mira este aviso de mascota en Rastro', url };
  if (navigator.share) {
    try {
      await navigator.share(shareData);
    } catch (e) {
      /* cancelado */
    }
  } else {
    try {
      await navigator.clipboard.writeText(url);
      toast('Enlace copiado.');
    } catch (e) {
      toast(url);
    }
  }
}
async function flagReport(id) {
  if (!confirm('¿Reportar este aviso como inapropiado?')) return;
  try {
    const r = await api(`/api/reports/${id}/flag`, { method: 'POST' });
    toast(r.message);
  } catch (ex) {
    toast(ex.message);
  }
}

document.getElementById('reports-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  switch (btn.dataset.action) {
    case 'matches':
      toggleMatches(id);
      break;
    case 'contact':
      toggleContact(id);
      break;
    case 'send':
      sendContact(id);
      break;
    case 'share':
      shareReport(id);
      break;
    case 'flag':
      flagReport(id);
      break;
  }
});

async function renderListMap() {
  if (!listMap) {
    listMap = L.map('list-map').setView([userLoc.lat, userLoc.lng], 12);
    agregarCapaTiles(listMap);
    clusterGroup = L.markerClusterGroup();
    listMap.addLayer(clusterGroup);
    setTimeout(() => listMap.invalidateSize(), 200);
    pintarMarcadorUsuario();
  }
  clusterGroup.clearLayers();
  allReports.forEach(r => {
    const color = r.estado === 'perdido' ? '#D98A2B' : '#3F8361';
    const marker = L.circleMarker([r.lat, r.lng], {
      radius: 9,
      fillColor: color,
      fillOpacity: 0.9,
      color: '#fff',
      weight: 2
    });
    marker.bindPopup(
      `<b>${TIPO_ICON[r.tipo] || '🐾'} ${esc(r.color)}</b><br>${r.estado === 'perdido' ? 'Perdido' : 'Encontrado'} · ${timeAgo(r.created_at)}`
    );
    clusterGroup.addLayer(marker);
  });
}

document.getElementById('filter-tipo').addEventListener('change', () => {
  renderList().then(renderListMap);
});
document.getElementById('filter-estado').addEventListener('change', () => {
  renderList().then(renderListMap);
});
let searchTimer = null;
document.getElementById('search-text').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    renderList()
      .then(renderListMap)
      .catch(() => {});
  }, 350);
});
document.getElementById('btn-refresh').addEventListener('click', async () => {
  await renderList();
  await renderListMap();
  toast('Lista actualizada.');
});
// "Mapa" y "Lista" cambian lo que se ve en la pantalla principal: el mapa
// arriba (con el listado debajo) o solo el listado de avisos.
function mostrarVistaHome(conMapa) {
  document.getElementById('btn-view-map').classList.toggle('active', conMapa);
  document.getElementById('btn-view-list').classList.toggle('active', !conMapa);
  document.getElementById('list-map').style.display = conMapa ? 'block' : 'none';
  if (conMapa) setTimeout(() => listMap && listMap.invalidateSize(), 50);
}
document.getElementById('btn-view-map').addEventListener('click', () => mostrarVistaHome(true));
document.getElementById('btn-view-list').addEventListener('click', () => mostrarVistaHome(false));

/* ============ Chats ============ */
function actualizarBadgeChats() {
  api('/api/reports/threads')
    .then(({ threads }) => {
      const total = threads.reduce((s, t) => s + t.unread, 0);
      const b = document.getElementById('badge-chats');
      if (total > 0) {
        b.textContent = total;
        b.classList.remove('hidden');
      } else b.classList.add('hidden');
    })
    .catch(() => {});
}
async function renderThreads() {
  const el = document.getElementById('threads-list');
  el.innerHTML = '<div class="empty-state">Cargando…</div>';
  try {
    const { threads } = await api('/api/reports/threads');
    const total = threads.reduce((s, t) => s + t.unread, 0);
    const b = document.getElementById('badge-chats');
    if (total > 0) {
      b.textContent = total;
      b.classList.remove('hidden');
    } else b.classList.add('hidden');
    if (threads.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="big">💬</div>No tienes conversaciones todavía.<br>Escribe desde el mapa para contactar a alguien.</div>`;
      return;
    }
    el.innerHTML = threads
      .map(
        t => `
      <div class="thread" data-action="open" data-report="${esc(t.report_id)}" data-peer="${esc(t.peer_id)}" data-mio="${t.es_mio}">
        <div class="thread-ic">${TIPO_ICON[t.tipo] || '🐾'}</div>
        <div class="thread-body">
          <div class="thread-top">
            <h4>${esc(t.peer_label)} · ${esc(t.color)}</h4>
            ${t.unread ? `<span class="unread-dot">${t.unread}</span>` : ''}
          </div>
          <div class="report-meta">${t.es_mio ? 'Tu aviso (' + (t.estado === 'perdido' ? 'perdido' : 'encontrado') + ')' : 'Escribiste sobre su aviso'} · ${timeAgo(t.last_at)}</div>
          <div class="thread-last">${esc(t.last_message || '')}</div>
        </div>
      </div>`
      )
      .join('');
  } catch (ex) {
    el.innerHTML = `<p class="loc-note">${esc(ex.message)}</p>`;
  }
}
document.getElementById('threads-list').addEventListener('click', e => {
  const t = e.target.closest('[data-action="open"]');
  if (!t) return;
  openConversation(t.dataset.report, t.dataset.peer, t.dataset.mio === 'true');
});

async function openConversation(reportId, peerId, esMio) {
  currentConv.reportId = reportId;
  currentConv.peerId = peerId;
  currentConv.esMio = esMio;
  document.getElementById('threads-list').classList.add('hidden');
  document.getElementById('conversation').classList.remove('hidden');
  await loadConversation();
  if (currentConv.poll) clearInterval(currentConv.poll);
  currentConv.poll = setInterval(loadConversation, 15000);
}
function cerrarConversacion() {
  if (currentConv.poll) {
    clearInterval(currentConv.poll);
    currentConv.poll = null;
  }
  currentConv.reportId = null;
  currentConv.peerId = null;
  document.getElementById('conversation').classList.add('hidden');
  document.getElementById('threads-list').classList.remove('hidden');
}
document.getElementById('btn-conv-back').addEventListener('click', () => {
  cerrarConversacion();
  renderThreads();
});

async function loadConversation() {
  if (!currentConv.reportId || !currentConv.peerId) return;
  const box = document.getElementById('conv-msgs');
  try {
    const data = await api(`/api/reports/${currentConv.reportId}/threads/${currentConv.peerId}`);
    document.getElementById('conv-title').textContent =
      `${data.peer_label} · ${TIPO_ICON[data.tipo] || '🐾'} ${data.color}`;
    box.innerHTML = data.messages.length
      ? data.messages
          .map(
            m => `
        <div class="msg ${m.mio ? 'mine' : 'theirs'}">
          <div class="msg-text">${esc(m.mensaje)}</div>
          ${m.lat !== null ? `<a class="msg-loc" href="https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lng}#map=16/${m.lat}/${m.lng}" target="_blank" rel="noopener">📍 ubicación compartida</a>` : ''}
          <div class="when">${timeAgo(m.created_at)}</div>
        </div>`
          )
          .join('')
      : '<p class="loc-note">Aún no hay mensajes.</p>';
    box.scrollTop = box.scrollHeight;
  } catch (ex) {
    box.innerHTML = `<p class="loc-note">${esc(ex.message)}</p>`;
  }
}
document.getElementById('btn-conv-send').addEventListener('click', async () => {
  const ta = document.getElementById('conv-text');
  if (!ta.value.trim()) return;
  const body = { mensaje: ta.value.trim(), to_user_id: currentConv.peerId };
  if (document.getElementById('conv-attach-loc').checked) {
    const loc = await getCurrentLocOrNull();
    if (loc) {
      body.lat = loc.lat;
      body.lng = loc.lng;
    }
  }
  try {
    await api(`/api/reports/${currentConv.reportId}/messages`, { method: 'POST', body });
    ta.value = '';
    document.getElementById('conv-attach-loc').checked = false;
    await loadConversation();
  } catch (ex) {
    toast(ex.message);
  }
});

/* ============ Mis avisos / inbox ============ */
async function renderInbox() {
  const el = document.getElementById('inbox-list');
  try {
    const { reports } = await api('/api/reports/mine/all');
    myReports = reports;
    if (reports.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="big">📭</div>Todavía no has publicado avisos.</div>`;
      return;
    }
    el.innerHTML = reports
      .map(
        r => `
      <div class="inbox-item" data-id="${esc(r.id)}">
        <h4>${TIPO_ICON[r.tipo] || '🐾'} ${esc(r.color)} · ${r.estado === 'perdido' ? 'Perdido' : 'Encontrado'}
          ${r.resolved ? '<span class="tag resolved">Resuelto</span>' : ''}
          ${r.unread ? `<span class="unread-dot">${r.unread}</span>` : ''}
        </h4>
        <div class="report-meta">Publicado ${timeAgo(r.created_at)}${r.descripcion ? ' · ' + esc(r.descripcion) : ''}</div>
        <div class="report-actions">
          <button data-action="open-chat" data-id="${esc(r.id)}">Conversaciones</button>
          <button data-action="resolve" data-id="${esc(r.id)}" data-resolved="${r.resolved ? 'false' : 'true'}">${r.resolved ? 'Reabrir' : 'Marcar resuelto'}</button>
          <button data-action="edit" data-id="${esc(r.id)}">Editar</button>
          <button data-action="poster" data-id="${esc(r.id)}">Cartel</button>
          <button data-action="share" data-id="${esc(r.id)}">Compartir</button>
          <button data-action="delete" data-id="${esc(r.id)}">Eliminar</button>
        </div>
      </div>`
      )
      .join('');
  } catch (ex) {
    el.innerHTML = `<p class="loc-note">${esc(ex.message)}</p>`;
  }
}
document.getElementById('inbox-list').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  if (action === 'share') return shareReport(id);
  if (action === 'poster') return window.open((API_BASE || '') + `/api/reports/${id}/poster`, '_blank');
  if (action === 'resolve') {
    if (btn.dataset.resolved === 'true') return abrirModalReunion(id);
    try {
      await api(`/api/reports/${id}/resolve`, { method: 'POST', body: { resolved: false } });
      toast('Aviso reabierto.');
      renderInbox();
    } catch (ex) {
      toast(ex.message);
    }
  }
  if (action === 'delete') {
    if (!confirm('¿Eliminar este aviso? Se borrará su foto de forma permanente.')) return;
    try {
      await api(`/api/reports/${id}`, { method: 'DELETE' });
      toast('Aviso eliminado.');
      renderInbox();
      renderList()
        .then(renderListMap)
        .catch(() => {});
    } catch (ex) {
      toast(ex.message);
    }
  }
  if (action === 'edit') {
    const r = myReports.find(x => x.id === id);
    if (!r) return;
    editingId = id;
    document.getElementById('edit-tipo').value = r.tipo;
    document.getElementById('edit-sexo').value = r.sexo;
    document.getElementById('edit-color').value = r.color || '';
    document.getElementById('edit-raza').value = r.raza || '';
    document.getElementById('edit-collar').value = r.collar || '';
    document.getElementById('edit-nombre').value = r.nombre_mascota || '';
    document.getElementById('edit-desc').value = r.descripcion || '';
    document.getElementById('edit-modal').classList.remove('hidden');
  }
  if (action === 'open-chat') {
    document.querySelector('nav.tabs button[data-tab="chats"]').click();
  }
});
document
  .getElementById('btn-edit-cancel')
  .addEventListener('click', () => document.getElementById('edit-modal').classList.add('hidden'));
document.getElementById('form-edit').addEventListener('submit', async e => {
  e.preventDefault();
  if (!editingId) return;
  const body = {
    tipo: document.getElementById('edit-tipo').value,
    sexo: document.getElementById('edit-sexo').value,
    color: document.getElementById('edit-color').value.trim(),
    raza: document.getElementById('edit-raza').value.trim(),
    collar: document.getElementById('edit-collar').value.trim(),
    nombre_mascota: document.getElementById('edit-nombre').value.trim(),
    descripcion: document.getElementById('edit-desc').value.trim()
  };
  try {
    await api(`/api/reports/${editingId}`, { method: 'PATCH', body });
    document.getElementById('edit-modal').classList.add('hidden');
    toast('Aviso actualizado.');
    renderInbox();
    renderList()
      .then(renderListMap)
      .catch(() => {});
  } catch (ex) {
    toast(ex.message);
  }
});

/* ============ Notificaciones push ============ */
async function actualizarBotonPush() {
  const btn = document.getElementById('btn-push');
  if (!config.pushEnabled || !('serviceWorker' in navigator) || !('PushManager' in window)) {
    btn.classList.add('hidden');
    return;
  }
  btn.classList.remove('hidden');
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    btn.classList.toggle('active', !!sub);
    btn.title = sub ? 'Notificaciones activadas (toca para desactivar)' : 'Activar notificaciones';
  } catch (e) {
    /* ignore */
  }
}
document.getElementById('btn-push').addEventListener('click', async () => {
  if (!config.pushEnabled) return toast('Notificaciones no configuradas en el servidor.');
  if (!('serviceWorker' in navigator) || !('PushManager' in window))
    return toast('Este dispositivo no soporta notificaciones.');
  try {
    const reg = await navigator.serviceWorker.ready;
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: existing.endpoint } });
      await existing.unsubscribe();
      toast('Notificaciones desactivadas.');
    } else {
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') return toast('No diste permiso para las notificaciones.');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey)
      });
      await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
      toast('Notificaciones activadas.');
    }
    actualizarBotonPush();
  } catch (ex) {
    toast(ex.message || 'No se pudieron cambiar las notificaciones.');
  }
});

/* ============ Tema claro / oscuro ============ */
function aplicarTema(tema) {
  document.body.classList.toggle('theme-dark', tema === 'dark');
  const btn = document.getElementById('btn-theme');
  if (btn) btn.textContent = tema === 'dark' ? '☀️' : '🌙';
}
function initTema() {
  const guardado = localStorage.getItem('rastro_tema');
  const prefiereOscuro = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  aplicarTema(guardado || (prefiereOscuro ? 'dark' : 'light'));
}
document.getElementById('btn-theme').addEventListener('click', () => {
  const nuevo = document.body.classList.contains('theme-dark') ? 'light' : 'dark';
  localStorage.setItem('rastro_tema', nuevo);
  aplicarTema(nuevo);
});

/* ============ Instalar como app (PWA) ============ */
let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  document.getElementById('btn-install').classList.remove('hidden');
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  document.getElementById('btn-install').classList.add('hidden');
});
document.getElementById('btn-install').addEventListener('click', async () => {
  const btn = document.getElementById('btn-install');
  if (!deferredInstall) {
    btn.classList.add('hidden');
    return;
  }
  deferredInstall.prompt();
  try {
    await deferredInstall.userChoice;
  } catch (e) {
    /* ignore */
  }
  deferredInstall = null;
  btn.classList.add('hidden');
});

/* ============ Consejos ============ */
document
  .getElementById('btn-tips')
  .addEventListener('click', () => document.getElementById('tips-modal').classList.remove('hidden'));
document
  .getElementById('btn-tips-close')
  .addEventListener('click', () => document.getElementById('tips-modal').classList.add('hidden'));

/* ============ Onboarding (solo la primera vez) ============ */
function initOnboarding() {
  if (localStorage.getItem('rastro_onboard') === '1') return;
  const modal = document.getElementById('onboarding');
  modal.classList.remove('hidden');
  const total = 3;
  let step = 0;
  const mostrar = () => {
    modal
      .querySelectorAll('.onboard-step')
      .forEach(s => s.classList.toggle('hidden', Number(s.dataset.step) !== step));
    modal.querySelectorAll('.onboard-dots i').forEach((d, i) => d.classList.toggle('active', i === step));
    document.getElementById('btn-onboard-next').textContent = step === total - 1 ? 'Empezar' : 'Siguiente';
  };
  const cerrar = () => {
    localStorage.setItem('rastro_onboard', '1');
    modal.classList.add('hidden');
  };
  document.getElementById('btn-onboard-next').onclick = () => {
    if (step === total - 1) return cerrar();
    step++;
    mostrar();
  };
  document.getElementById('btn-onboard-skip').onclick = cerrar;
  mostrar();
}

/* ============ Muro de reencuentros ============ */
async function renderReunions() {
  const grid = document.getElementById('reunions-grid');
  const totalEl = document.getElementById('reunion-total');
  grid.innerHTML = '<div class="empty-state">Cargando…</div>';
  try {
    const { reunions, total } = await api('/api/reports/reunions');
    totalEl.innerHTML =
      total > 0
        ? `💚 <b>${total}</b> mascota${total > 1 ? 's' : ''} reunida${total > 1 ? 's' : ''} con su familia`
        : '';
    if (!reunions.length) {
      grid.innerHTML = `<div class="empty-state"><div class="big">🐾</div>Todavía no hay reencuentros.<br>Cuando una mascota vuelva a casa, aparecerá aquí.</div>`;
      return;
    }
    grid.innerHTML = reunions
      .map(
        r => `
      <div class="reunion-card">
        ${r.foto_url ? `<img src="${esc(fotoSrc(r.foto_url))}" alt="" loading="lazy">` : `<div class="reunion-ph">${TIPO_ICON[r.tipo] || '🐾'}</div>`}
        <div class="reunion-body">
          <h4>${TIPO_ICON[r.tipo] || '🐾'} ${esc(r.nombre_mascota || r.color)} <span class="tag found">Reunido</span></h4>
          ${r.resolved_at ? `<div class="report-meta">${timeAgo(r.resolved_at)}</div>` : ''}
          ${r.nota ? `<p class="reunion-nota">“${esc(r.nota)}”</p>` : ''}
        </div>
      </div>`
      )
      .join('');
  } catch (ex) {
    grid.innerHTML = `<p class="loc-note">${esc(ex.message)}</p>`;
  }
}

let reunionReportId = null;
function abrirModalReunion(id) {
  reunionReportId = id;
  document.getElementById('reunion-nota').value = '';
  photoFile.reunion = null;
  const zone = document.getElementById('photo-zone-reunion');
  const input = document.getElementById('photo-input-reunion');
  input.value = '';
  limpiarZonaFoto(zone, input);
  document.getElementById('reunion-modal').classList.remove('hidden');
}
document.getElementById('btn-reunion-cancel').addEventListener('click', async () => {
  if (!reunionReportId) return;
  try {
    await api(`/api/reports/${reunionReportId}/resolve`, { method: 'POST', body: { resolved: true } });
    toast('Aviso marcado como resuelto.');
    document.getElementById('reunion-modal').classList.add('hidden');
    renderInbox();
    renderList()
      .then(renderListMap)
      .catch(() => {});
  } catch (ex) {
    toast(ex.message);
  }
});
document.getElementById('btn-reunion-save').addEventListener('click', async () => {
  if (!reunionReportId) return;
  const btn = document.getElementById('btn-reunion-save');
  btn.disabled = true;
  try {
    const fd = new FormData();
    const nota = document.getElementById('reunion-nota').value.trim();
    if (nota) fd.append('nota', nota);
    if (photoFile.reunion) fd.append('foto', photoFile.reunion, 'reunion.jpg');
    await api(`/api/reports/${reunionReportId}/reunion`, { method: 'POST', isForm: true, body: fd });
    toast('¡Gracias por compartirlo! 🎉');
    document.getElementById('reunion-modal').classList.add('hidden');
    renderInbox();
    renderList()
      .then(renderListMap)
      .catch(() => {});
  } catch (ex) {
    toast(ex.message);
  } finally {
    btn.disabled = false;
  }
});

/* ============ Alertas por zona ============ */
async function actualizarBotonZona() {
  try {
    const { zone } = await api('/api/push/zone');
    const b = document.getElementById('btn-zone');
    b.textContent = zone
      ? '🔔 Alertas de zona activadas (toca para desactivar)'
      : '🔔 Activar alertas de mi zona';
  } catch (e) {
    /* ignore */
  }
}
document.getElementById('btn-zone').addEventListener('click', async () => {
  try {
    const { zone } = await api('/api/push/zone');
    if (zone) {
      if (!confirm('¿Desactivar las alertas de mascotas perdidas cerca de tu zona?')) return;
      await api('/api/push/zone', { method: 'DELETE' });
      toast('Alertas de zona desactivadas.');
      actualizarBotonZona();
      return;
    }
    const loc = (await getCurrentLocOrNull()) || userLoc;
    await api('/api/push/zone', { method: 'POST', body: { lat: loc.lat, lng: loc.lng } });
    toast('Listo: avisaremos aquí cuando se pierda una mascota cerca.');
    // Las alertas llegan por notificación push: recordar activarlas si faltan.
    if (config.pushEnabled && 'serviceWorker' in navigator && 'PushManager' in window) {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) toast('Tip: activa también las notificaciones (🔔 arriba).');
    }
    actualizarBotonZona();
  } catch (ex) {
    toast(ex.message);
  }
});

/* ============ Verificación de correo ============ */
function actualizarBannerVerificacion() {
  const b = document.getElementById('verify-banner');
  if (me && me.email_verified === false) b.classList.remove('hidden');
  else b.classList.add('hidden');
}
document.getElementById('btn-resend-verify').addEventListener('click', async () => {
  try {
    const r = await api('/api/auth/resend-verification', { method: 'POST' });
    toast(r.message);
    if (me) me.email_verified = true;
    actualizarBannerVerificacion();
  } catch (ex) {
    toast(ex.message);
  }
});

/* ============ Panel de administración ============ */
function mostrarTabAdmin() {
  if (me && me.is_admin) document.getElementById('tab-admin').classList.remove('hidden');
}
async function renderAdmin() {
  const flagged = document.getElementById('admin-flagged');
  const users = document.getElementById('admin-users');
  flagged.innerHTML = '<div class="empty-state">Cargando…</div>';
  users.innerHTML = '';
  try {
    const { reports } = await api('/api/admin/flagged');
    flagged.innerHTML = reports.length
      ? reports
          .map(
            r => `
      <div class="inbox-item">
        <h4>${TIPO_ICON[r.tipo] || '🐾'} ${esc(r.color)} ${r.active ? '' : '<span class="tag resolved">Oculto</span>'} <span class="unread-dot">${r.flags}</span></h4>
        <div class="report-meta">${esc(r.owner_email || '')} · ${timeAgo(r.created_at)}</div>
        ${r.descripcion ? `<div class="report-meta">${esc(r.descripcion)}</div>` : ''}
        <div class="report-actions">
          ${
            r.active
              ? `<button data-admin="hide" data-id="${esc(r.id)}">Ocultar</button>`
              : `<button data-admin="unhide" data-id="${esc(r.id)}">Restaurar</button>`
          }
          <button data-admin="ver" data-id="${esc(r.id)}">Compartir</button>
          <button data-admin="delete" data-id="${esc(r.id)}">Eliminar</button>
        </div>
      </div>`
          )
          .join('')
      : '<div class="empty-state">No hay avisos reportados. 🎉</div>';
  } catch (ex) {
    flagged.innerHTML = `<p class="loc-note">${esc(ex.message)}</p>`;
  }

  try {
    const { users: us } = await api('/api/admin/users');
    users.innerHTML = us
      .map(
        u => `
      <div class="inbox-item">
        <h4>${esc(u.email)}</h4>
        <div class="report-meta">${timeAgo(u.created_at)} · ${u.reports} aviso(s) · ${u.email_verified ? 'verificado' : 'sin verificar'}</div>
      </div>`
      )
      .join('');
  } catch (ex) {
    users.innerHTML = `<p class="loc-note">${esc(ex.message)}</p>`;
  }
}
document.getElementById('admin-flagged').addEventListener('click', async e => {
  const btn = e.target.closest('[data-admin]');
  if (!btn) return;
  const id = btn.dataset.id,
    acc = btn.dataset.admin;
  try {
    if (acc === 'ver') return shareReport(id);
    if (acc === 'hide') await api(`/api/admin/reports/${id}/hide`, { method: 'POST' });
    if (acc === 'unhide') await api(`/api/admin/reports/${id}/unhide`, { method: 'POST' });
    if (acc === 'delete') {
      if (!confirm('¿Eliminar este aviso definitivamente?')) return;
      await api(`/api/admin/reports/${id}`, { method: 'DELETE' });
    }
    toast('Hecho.');
    renderAdmin();
  } catch (ex) {
    toast(ex.message);
  }
});

/* ============ Arranque ============ */
let appIniciada = false;
let pickersIniciados = { found: false, lost: false };
// Los mapas de "Encontré/Perdí" se crean recién al abrir su pestaña: si se
// crean con la vista oculta (display:none), Leaflet les asigna tamaño 0 y el
// mapa queda gris sin cargar tiles.
function asegurarPicker(key) {
  if (!pickersIniciados[key]) {
    const p = initPicker('map-' + key, key);
    if (key === 'found') {
      mapFound = p.map;
      markerFound = p.marker;
    } else {
      mapLost = p.map;
      markerLost = p.marker;
    }
    pickersIniciados[key] = true;
  }
  const m = key === 'found' ? mapFound : mapLost;
  setTimeout(() => m && m.invalidateSize(), 80);
}
function startApp() {
  if (!appIniciada) {
    initOnboarding();
    initPhotoZone('photo-zone-found', 'photo-input-found', 'found');
    initPhotoZone('photo-zone-lost', 'photo-input-lost', 'lost');
    initPhotoZone('photo-zone-reunion', 'photo-input-reunion', 'reunion');
    initAddressSearch('addr-found', 'addr-results-found', (lat, lng) => elegirUbicacion('found', lat, lng));
    initAddressSearch('addr-lost', 'addr-results-lost', (lat, lng) => elegirUbicacion('lost', lat, lng));
    initAddressSearch('addr-home', 'addr-results-home', (lat, lng) => {
      if (!listMap) return;
      listMap.setView([lat, lng], 16);
      if (destinoMarker) listMap.removeLayer(destinoMarker);
      destinoMarker = L.marker([lat, lng]).addTo(listMap).bindPopup('Dirección').openPopup();
    });
    document.getElementById('btn-my-loc').addEventListener('click', async () => {
      // Este botón SÍ pide ubicación fresca (el usuario la está pidiendo a
      // propósito): con GPS para que el punto quede fino.
      const pos = await pedirUbicacion({ altaPrecision: true });
      if (!navigator.geolocation) {
        if (listMap) listMap.setView([userLoc.lat, userLoc.lng], 15);
        return;
      }
      const centro = pos ? { lat: pos.coords.latitude, lng: pos.coords.longitude } : userLoc;
      if (listMap) listMap.setView([centro.lat, centro.lng], 15);
    });

    // Seguimiento continuo: es OPCIONAL y el usuario lo enciende a propósito
    // (por ejemplo, si va caminando buscando a su mascota). Se apaga solo al
    // ocultar la pestaña y a los 10 minutos, para no dejar el GPS encendido.
    const btnSeguir = document.getElementById('btn-seguir');
    if (btnSeguir && navigator.geolocation) {
      btnSeguir.classList.remove('hidden');
      btnSeguir.addEventListener('click', () => {
        const activo = seguirUbicacion(!estaSiguiendo());
        actualizarBotonSeguir();
        toast(
          activo
            ? 'Siguiendo tu ubicación. Se apagará solo en 10 minutos.'
            : 'Dejamos de seguir tu ubicación.'
        );
      });
      actualizarBotonSeguir();
    }
    appIniciada = true;
  }
  locateUser();
  actualizarBannerVerificacion();
  mostrarTabAdmin();
  actualizarBotonZona();
  renderList()
    .then(renderListMap)
    .then(() => abrirDeepLink())
    .catch(() => {});
  actualizarBadgeChats();
  actualizarBotonPush();
}

// Enlaces compartidos (/?r=<id>): el listado público solo trae los 200 avisos
// más recientes, así que si el aviso no está en la lista lo pedimos aparte.
async function abrirDeepLink() {
  const rid = new URLSearchParams(location.search).get('r');
  if (!rid) return;
  const enLista = allReports.some(r => r.id === rid);
  if (!enLista) {
    try {
      const { report } = await api(`/api/reports/${encodeURIComponent(rid)}`);
      allReports.unshift(report);
      const el = document.getElementById('reports-list');
      const vacio = el.querySelector('.empty-state');
      if (vacio) el.innerHTML = reportCard(report);
      else el.insertAdjacentHTML('afterbegin', reportCard(report));
    } catch (e) {
      toast('Ese aviso ya no está disponible.');
      return;
    }
  }
  const card = document.querySelector(`.report-card[data-id="${CSS.escape(rid)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.style.outline = '3px solid var(--rust)';
  setTimeout(() => {
    card.style.outline = '';
  }, 3000);
}

/* ============ Bootstrap ============ */
(async function bootstrap() {
  initTema();
  await loadConfig();

  const params = new URLSearchParams(location.search);
  if (params.get('verified') === '1') toast('¡Correo confirmado! Ya puedes publicar.');
  if (params.get('verified') === '0') toast('El enlace de confirmación venció o ya se usó.');
  if (params.get('reset')) {
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.add('hidden');
    document.getElementById('reset-screen').classList.remove('hidden');
    return;
  }

  if (token) {
    try {
      const data = await api('/api/auth/me');
      me = data.user;
      showApp();
      startApp();
      if (params.get('tab') === 'chats') document.querySelector('nav.tabs button[data-tab="chats"]').click();
      return;
    } catch (e) {
      /* token inválido: volvemos al login */ token = null;
      localStorage.removeItem('rastro_token');
    }
  }
  showAuth();
})();

window.toggleMatches = toggleMatches;
window.toggleContact = toggleContact;
window.sendContact = sendContact;
