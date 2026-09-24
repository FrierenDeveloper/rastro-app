// Registrar el service worker ANTES que cualquier otro código: si algo más
// abajo en este archivo llegara a fallar, el registro no debe verse afectado.
if ('serviceWorker' in navigator) {
  // Ruta absoluta y scope raíz a propósito: con 'sw.js' a secas, abrir la app en
  // una ruta como /cualquier-cosa (el servidor devuelve el index por el fallback)
  // buscaba /cualquier-cosa/sw.js y el service worker no llegaba a registrarse,
  // así que se perdían el modo sin conexión y las notificaciones push.
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {})
  );
}

// ============ Configuración ============
const API_BASE = window.PETSENAL_API_BASE || window.RASTRO_API_BASE || '';
const DEMO_MODE =
  ['localhost', '127.0.0.1'].includes(location.hostname) &&
  new URLSearchParams(location.search).get('demo') === '1';

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
let zonaCalor = { id: null, capas: [] };

const TIPO_ICON = { perro: '🐕', gato: '🐈', ave: '🐦', conejo: '🐇', otro: '🐾' };
const COLLAR_COLOR = { rojo: '#e05252', azul: '#438bd1', negro: '#263238', verde: '#3da879' };
const DEMO_REPORTS = [
  {
    id: 'demo-coco',
    nombre: 'Coco',
    ubicacion: 'Palermo, CABA',
    tipo: 'perro',
    estado: 'perdido',
    color: 'Marrón',
    raza: 'Mestizo',
    collar: 'rojo',
    sexo: 'macho',
    descripcion: 'Coco es amistoso y responde cuando lo llaman.',
    lat: -34.5834,
    lng: -58.4147,
    created_at: Date.now() - 2 * 60 * 60 * 1000,
    foto_url: '',
    es_mio: false,
    radio_km: 1.2
  },
  {
    id: 'demo-luna',
    nombre: 'Luna',
    ubicacion: 'Recoleta, CABA',
    tipo: 'gato',
    estado: 'encontrado',
    color: 'Negro',
    raza: 'Doméstico',
    collar: 'azul',
    sexo: 'hembra',
    descripcion: 'Encontrada cerca de una plaza; está tranquila y cuidada.',
    lat: -34.5865,
    lng: -58.3972,
    created_at: Date.now() - 4 * 60 * 60 * 1000,
    foto_url: '',
    es_mio: false
  },
  {
    id: 'demo-nube',
    nombre: 'Nube',
    ubicacion: 'Almagro, CABA',
    tipo: 'perro',
    estado: 'encontrado',
    color: 'Blanco',
    raza: 'Poodle',
    collar: 'verde',
    sexo: 'macho',
    descripcion: 'Muy cariñoso. Tiene una mancha pequeña sobre un ojo.',
    lat: -34.6095,
    lng: -58.4274,
    created_at: Date.now() - 7 * 60 * 60 * 1000,
    foto_url: '',
    es_mio: false
  }
];

function markerIcon(report) {
  const collar = COLLAR_COLOR[report.collar] || 'transparent';
  const estado = report.estado === 'perdido' ? 'lost' : 'found';
  // El dibujo cambia con la raza y el color declarados (frontend/razas.js).
  const animal = window.RAZAS_API.renderAnimalSVG(report.tipo, report.raza, report.color);
  return L.divIcon({
    className: 'animal-marker-wrap',
    html: `<span class="animal-marker ${estado}"><span class="animal-face"><span class="animal-emoji">${animal}</span><span class="animal-collar" style="background:${collar}"></span></span></span>`,
    iconSize: [52, 60],
    iconAnchor: [26, 56],
    popupAnchor: [0, -52]
  });
}

// Iconos de línea del sprite de index.html. Solo para textos que arma el JS:
// el resto de la interfaz los lleva ya en el HTML. Son cadenas propias, sin
// datos del usuario, por eso se pueden inyectar con innerHTML.
const ico = nombre => `<svg class="ic" aria-hidden="true"><use href="#i-${nombre}" /></svg>`;

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
      ? 'Los perros se recuperan sobre todo porque alguien los encuentra: veterinarias, carteles y redes del barrio rinden más que caminar kilómetros.'
      : 'A estas alturas lo que más rinde es la difusión (veterinarias, carteles y redes del barrio): avisar a mucha gente cubre más terreno que caminar sin rumbo.';
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
// MapTiler se activa al definir window.RASTRO_MAPTILER_KEY en la configuración
// de despliegue. Sin clave, conservamos los respaldos públicos actuales.
const MAPTILER_KEY = window.RASTRO_MAPTILER_KEY || '';
const TILE_PROVIDERS = [
  ...(MAPTILER_KEY
    ? [
        {
          url: `https://api.maptiler.com/maps/streets-v4/256/{z}/{x}/{y}.png?key=${encodeURIComponent(MAPTILER_KEY)}`,
          attribution:
            '<a href="https://www.maptiler.com/copyright/" target="_blank">© MapTiler</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank">© OpenStreetMap contributors</a>',
          maxZoom: 20
        }
      ]
    : []),
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
        console.warn('PetSeñal: los tiles de ' + p.url + ' fallaron; probando un proveedor de respaldo…');
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
    // El código viaja con el error: quien llama necesita distinguir "el token no
    // vale" (401) de "la petición se cayó" (red, 500...).
    const error = new Error(data.error || 'Ocurrió un error.');
    error.status = res.status;
    throw error;
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
// Render (plan gratis) "duerme" el servicio tras 15 min sin uso: la primera
// petición tras eso puede tardar 30-50 s. La pantalla de arranque se queda
// visible hasta que el servidor responde; si tarda, avisamos y reintentamos
// hasta ~45 s en vez de dejar al usuario mirando un login que no carga.
const ESPERA_SERVIDOR_MS = 45000;

function pingSalud(msTimeout) {
  const ctrl = new window.AbortController();
  const timer = setTimeout(() => ctrl.abort(), msTimeout);
  return fetch(API_BASE + '/api/health', { signal: ctrl.signal })
    .then(res => res.ok)
    .catch(() => false)
    .finally(() => clearTimeout(timer));
}

async function despertarServidor() {
  const inicio = Date.now();
  let avisado = false;
  while (Date.now() - inicio < ESPERA_SERVIDOR_MS) {
    if (await pingSalud(6000)) return;
    if (!avisado && Date.now() - inicio > 1200) {
      avisado = true;
      const nota = document.getElementById('boot-status');
      if (nota) {
        nota.textContent = 'Estamos despertando el servidor… la primera vez puede tardar hasta 45 segundos.';
      }
    }
    await new Promise(r => setTimeout(r, 900));
  }
}

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
  ocultarArranque();
  document.getElementById('auth-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('reset-screen').classList.add('hidden');
}
function showApp() {
  ocultarArranque();
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('reset-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}
function ocultarArranque() {
  const boot = document.getElementById('boot-screen');
  if (boot) boot.classList.add('hidden');
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
let registerChallenge = null;
let registerChallengeStartedAt = 0;

function prepararRetoRegistro() {
  registerChallengeStartedAt = Date.now();
  registerChallenge = api('/api/auth/challenge', { auth: false }).then(({ challenge }) => challenge);
  return registerChallenge;
}

async function retoRegistroListo() {
  const challenge = registerChallenge || prepararRetoRegistro();
  const elapsed = Date.now() - registerChallengeStartedAt;
  if (elapsed < 1500) await new Promise(resolve => setTimeout(resolve, 1500 - elapsed));
  return challenge;
}

document.querySelectorAll('.auth-tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.auth-tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.auth-form').forEach(f => f.classList.remove('active'));
    document.getElementById('form-' + btn.dataset.auth).classList.add('active');
    if (btn.dataset.auth === 'register') prepararRetoRegistro();
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
    const challenge = await retoRegistroListo();
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

// Botón "ojo": alterna entre ocultar y mostrar lo escrito en los campos de
// contraseña (Entrar, Crear cuenta y Resetear). No toca el valor del campo.
document.querySelectorAll('.pw-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.pw);
    if (!input) return;
    const mostrar = input.type === 'password';
    input.type = mostrar ? 'text' : 'password';
    btn.classList.toggle('ver', mostrar);
    btn.setAttribute('aria-label', mostrar ? 'Ocultar contraseña' : 'Mostrar contraseña');
  });
});

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

/* ============ Menú de opciones (panel lateral) ============ */
// Los botones conservan sus id, así que sus listeners (tema, instalar, push,
// cerrar sesión) siguen funcionando aunque ahora vivan dentro del panel.
function abrirMenu() {
  const drawer = document.getElementById('options-drawer');
  drawer.classList.remove('hidden');
  const btn = document.getElementById('btn-menu');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  const cerrar = document.getElementById('btn-drawer-close');
  if (cerrar) cerrar.focus();
  // El punto verde del chat se refresca al abrir el menú para que el aviso de
  // mensajes nuevos esté al día sin esperar al ciclo de un minuto.
  actualizarBadgeChats();
}
function cerrarMenu() {
  const drawer = document.getElementById('options-drawer');
  if (drawer.classList.contains('hidden')) return;
  drawer.classList.add('hidden');
  const btn = document.getElementById('btn-menu');
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.focus();
  }
}
document.getElementById('btn-menu').addEventListener('click', abrirMenu);
document.getElementById('btn-drawer-close').addEventListener('click', cerrarMenu);
document.querySelector('.drawer-scrim').addEventListener('click', cerrarMenu);
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (document.getElementById('options-drawer').classList.contains('hidden')) return;
  cerrarMenu();
});
// Elegir una opción cierra el panel; el tema se queda abierto para poder
// alternarlo un par de veces sin volver a abrirlo.
document.querySelectorAll('.drawer-item').forEach(item => {
  if (item.id === 'btn-theme') return;
  item.addEventListener('click', cerrarMenu);
});

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

/* ============ Navegación ============ */
// La barra inferior tiene solo tres vistas (Perdí, Mapa, Encontré); el chat y
// el panel de administración se abren desde el menú de opciones. Esta función
// es el único punto que cambia de vista: los atajos del icono, las
// notificaciones y los botones internos llaman aquí y no duplican lógica.
function mostrarVista(tab) {
  const vista = document.getElementById('view-' + tab);
  if (!vista) return;
  if (tab === 'admin' && !(me && me.is_admin)) return;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  vista.classList.add('active');
  document.querySelectorAll('.bottom-nav button').forEach(b => {
    const esMapaPrincipal = tab === 'home' && b.dataset.homeMode === 'map';
    b.classList.toggle('active', esMapaPrincipal || (!b.dataset.homeMode && b.dataset.tab === tab));
  });
  document.querySelectorAll('.drawer-item[data-vista]').forEach(b => {
    b.classList.toggle('active', b.dataset.vista === tab);
  });
  if (tab === 'home') {
    setTimeout(() => listMap && listMap.invalidateSize(), 50);
    renderList()
      .then(renderListMap)
      .catch(() => {});
    renderReunions();
  }
  if (tab === 'found') {
    asegurarPicker('found');
    renderInbox();
    ajustarAlto('found');
  }
  if (tab === 'lost') {
    asegurarPicker('lost');
    renderInbox();
    ajustarAlto('lost');
  }
  if (tab === 'chats') {
    cerrarConversacion();
    renderThreads();
  }
  if (tab === 'admin') {
    renderAdmin();
  }
  if (tab === 'chips') {
    renderMisChips();
  }
  // Al salir de la vista, cualquier número revelado vuelve a enmascararse.
  if (tab !== 'chips') ocultarChipVisible();
}
document
  .querySelectorAll('.bottom-nav button, .drawer-item[data-vista], .home-action[data-tab]')
  .forEach(btn => {
    btn.addEventListener('click', () => {
      mostrarVista(btn.dataset.tab || btn.dataset.vista);
      if (btn.dataset.homeMode) mostrarVistaHome(btn.dataset.homeMode === 'map');
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
// Lo único que sale del dispositivo sin que el usuario haga nada es la ubicación
// DIFUMINADA (~300 m) para las alertas de zona, y solo con la app abierta, con
// umbral de 6 h o 500 m de movimiento y respetando si desactivó esas alertas
// (ver guardarUbicacionDeZona). Todo lo demás viaja solo si él lo pide: publicar
// un aviso, guardar su barrio o adjuntar "lo vi aquí" a un mensaje.
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

// Estado de la ubicación en la cabecera. La patita GPS brilla cuando hay punto
// (data-estado="ok"), queda tenue mientras busca y se apaga si el navegador no
// geolocaliza o el usuario niega el permiso. El detalle se lee en Opciones.
function marcarUbicacion(estado, texto) {
  const badge = document.getElementById('gps-badge');
  const fila = document.getElementById('opt-ubicacion');
  const label = document.getElementById('opt-ubicacion-texto');
  if (badge) badge.dataset.estado = estado;
  if (fila) fila.dataset.estado = estado;
  if (label) label.textContent = texto;
}

function aplicarUbicacion(lat, lng, accuracy, { deCache = false } = {}) {
  userLoc = { lat, lng };
  ultimaUbicacion = { lat, lng, accuracy: accuracy || 0 };
  ubicacion.ultima = { lat, lng, accuracy: accuracy || 0, ts: Date.now() };
  if (!deCache) guardarUbicacion();
  marcarUbicacion('ok', 'Ubicación activa');
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
  if (!navigator.geolocation) {
    marcarUbicacion('manual', 'Santiago (ubicación manual)');
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
        if (!ubicacion.ultima) {
          marcarUbicacion('sin', 'Sin ubicación: toca el mapa para ajustar el punto');
          toast('No pudimos leer tu ubicación. Toca el mapa para ajustarla.');
        }
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
  btn.innerHTML = ico('radar') + (activo ? 'Siguiendo' : 'Seguir');
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
  hint.innerHTML = ico('camera') + 'Toca para tomar o subir una foto';
  zone.appendChild(hint);
}

/* ============ Publicar por pasos ============ */
// El formulario de publicar va en cuatro pasos dentro de un carril (el mismo
// gesto que el onboarding). Cada paso valida lo suyo antes de dejar avanzar y, si
// falta algo, señala EL CAMPO: un aviso suelto obliga a adivinar qué falta.
const PASOS_PUBLICAR = 4;
const NOMBRES_PASOS = ['Tipo y sexo', 'Cómo es', 'Foto y descripción', 'Ubicación'];
const BOTONES_PASO = ['Siguiente: ¿cómo es?', 'Siguiente: foto y descripción', 'Siguiente: ubicación', ''];
const wizardPaso = { found: 0, lost: 0 };

function ultimoPaso(key) {
  return wizardPaso[key] === PASOS_PUBLICAR - 1;
}

// Mismo criterio que el backend: fuera separadores y el prefijo ISO, y de 9 a 15
// dígitos. Se avisa aquí para no hacer esperar una ida al servidor.
function chipMalEscrito(valor) {
  if (!valor) return false;
  const digitos = valor.replace(/^iso/i, '').replace(/[\s\-._/]/g, '');
  return !/^[0-9]{9,15}$/.test(digitos);
}

// Qué le falta al paso para poder avanzar: null o el campo concreto que falla.
function problemaDelPaso(key, paso) {
  const valor = id => (document.getElementById(id + '-' + key).value || '').trim();
  if (paso === 0 && !valor('tipo')) return { id: 'tipo-' + key, mensaje: 'Elige el tipo de animal.' };
  if (paso === 1 && !valor('color')) return { id: 'color-' + key, mensaje: 'Escribe el color del animal.' };
  if (paso === 1 && chipMalEscrito(valor('chip')))
    return { id: 'chip-' + key, mensaje: 'El microchip debe tener entre 9 y 15 dígitos.' };
  // En "Perdí" la antigüedad de la pérdida es obligatoria: sin ella no hay radio
  // de búsqueda. Antes lo cortaba el navegador con su mensaje genérico.
  if (paso === 3 && key === 'lost' && !document.getElementById('perdido-hace-lost').value)
    return { id: 'perdido-hace-lost', mensaje: 'Dinos cuándo se perdió.' };
  return null;
}

// Señala el campo que falta: borde, mensaje debajo y foco. Se limpia solo en
// cuanto el usuario corrige el valor.
function marcarError(id, mensaje) {
  const campo = document.getElementById(id);
  if (!campo) return;
  campo.classList.add('campo-error');
  campo.setAttribute('aria-invalid', 'true');
  let aviso = campo.nextElementSibling;
  if (!aviso || !aviso.classList.contains('error-campo')) {
    aviso = document.createElement('p');
    aviso.className = 'error-campo';
    campo.insertAdjacentElement('afterend', aviso);
  }
  aviso.textContent = mensaje;
  campo.focus();
}

function limpiarErrorDe(campo) {
  campo.classList.remove('campo-error');
  campo.removeAttribute('aria-invalid');
  const aviso = campo.nextElementSibling;
  if (aviso && aviso.classList.contains('error-campo')) aviso.remove();
}

function limpiarErrores(form) {
  form.querySelectorAll('.campo-error').forEach(limpiarErrorDe);
}

// Alto del carril = alto del paso que se está viendo. Sin esto el carril mide lo
// que el paso más alto (el del mapa) y los pasos cortos dejan un hueco enorme.
function ajustarAlto(key) {
  const viewport = document.getElementById('wizard-viewport-' + key);
  const paso = document.querySelector(`#wizard-track-${key} .wizard-step[data-step="${wizardPaso[key]}"]`);
  if (!viewport || !paso) return;
  const alto = paso.offsetHeight;
  // Con la vista oculta la medida es 0: ahí se deja el alto automático.
  viewport.style.height = alto > 0 ? alto + 'px' : '';
}

// Dentro de un paso el contenido cambia solo: el gráfico del radio aparece al
// elegir la antigüedad, la foto sustituye al aviso de "toca para subir", un texto
// pasa a dos líneas. Si no se vuelve a medir, el carril lo recortaría.
if (typeof window.ResizeObserver !== 'undefined') {
  const medirPasos = new window.ResizeObserver(() => {
    ajustarAlto('found');
    ajustarAlto('lost');
  });
  document.querySelectorAll('.wizard-step').forEach(paso => medirPasos.observe(paso));
}

function pintarPaso(key) {
  const paso = wizardPaso[key];
  document.getElementById('wizard-track-' + key).style.transform = `translateX(${-100 * paso}%)`;
  document
    .querySelectorAll('#wizard-dots-' + key + ' i')
    .forEach((d, i) => d.classList.toggle('active', i === paso));

  const progreso = document.getElementById('wizard-dots-' + key);
  progreso.setAttribute('aria-valuenow', String(paso + 1));
  progreso.setAttribute('aria-label', `Paso ${paso + 1} de ${PASOS_PUBLICAR}`);
  document.getElementById('wizard-paso-' + key).textContent =
    `Paso ${paso + 1} de ${PASOS_PUBLICAR} · ${NOMBRES_PASOS[paso]}`;

  document.getElementById('wizard-prev-' + key).classList.toggle('hidden', paso === 0);
  const siguiente = document.getElementById('wizard-next-' + key);
  siguiente.classList.toggle('hidden', ultimoPaso(key));
  siguiente.textContent = BOTONES_PASO[paso];
  document.getElementById('wizard-submit-' + key).classList.toggle('hidden', !ultimoPaso(key));
  ajustarAlto(key);
}

function irAlPaso(key, paso) {
  wizardPaso[key] = Math.min(Math.max(paso, 0), PASOS_PUBLICAR - 1);
  pintarPaso(key);
}

// Avanzar solo si el paso está completo; retroceder nunca bloquea (lo escrito se
// queda donde estaba: los campos no se vacían al moverse por el carril).
function avanzarPaso(key) {
  const form = document.getElementById('form-' + key);
  limpiarErrores(form);
  const problema = problemaDelPaso(key, wizardPaso[key]);
  if (problema) {
    marcarError(problema.id, problema.mensaje);
    return;
  }
  irAlPaso(key, wizardPaso[key] + 1);
}

function initWizard(key) {
  const form = document.getElementById('form-' + key);
  document
    .getElementById('wizard-prev-' + key)
    .addEventListener('click', () => irAlPaso(key, wizardPaso[key] - 1));
  document.getElementById('wizard-next-' + key).addEventListener('click', () => avanzarPaso(key));
  // El aviso de error desaparece en cuanto se corrige el campo.
  form.querySelectorAll('input, select, textarea').forEach(campo => {
    campo.addEventListener('input', () => limpiarErrorDe(campo));
    campo.addEventListener('change', () => limpiarErrorDe(campo));
  });
  activarSwipeOnboarding(
    document.getElementById('wizard-track-' + key),
    paso => irAlPaso(key, paso),
    () => wizardPaso[key]
  );
  pintarPaso(key);
}

// Al girar el móvil el alto del paso cambia: hay que volver a medirlo.
window.addEventListener('resize', () => {
  ajustarAlto('found');
  ajustarAlto('lost');
});

/* ============ Publicar aviso ============ */
function resetForm(key) {
  document.getElementById('form-' + key).reset();
  photoFile[key] = null;
  const zone = document.getElementById('photo-zone-' + key);
  const input = document.getElementById('photo-input-' + key);
  input.value = '';
  limpiarZonaFoto(zone, input);
  // Tras publicar se vuelve al primer paso, no se queda en el último.
  irAlPaso(key, 0);
}
// Sugerencias amplias: avisos que coinciden en algo aunque estén a cientos de
// kilómetros o la descripción fuera corta. Van con menos peso visual y dicen en
// qué coinciden, para que nadie las tome por una coincidencia confirmada.
function htmlSugerencias(sugerencias) {
  if (!sugerencias || !sugerencias.length) return '';
  const filas = sugerencias
    .map(
      s =>
        `<div class="match-item">${TIPO_ICON[s.tipo] || '🐾'} ${esc(s.color)} · ${esc(s.distancia_km)} km · ${esc((s.cualidades || []).join(', '))}</div>`
    )
    .join('');
  return `<div class="sugerencias">
    <p class="loc-note">Nada cerca por ahora. Mira estos avisos: coinciden en algo, aunque estén lejos o la descripción fuera corta.</p>
    ${filas}
  </div>`;
}
function renderMatchBanner(containerId, matches, sugerencias) {
  const el = document.getElementById(containerId);
  const extra = htmlSugerencias(sugerencias);
  if (matches.length === 0 && !extra) {
    el.innerHTML = '';
    return;
  }
  const fuertes = matches.length
    ? `<div class="match-banner">
    <h3>${ico('paw')} ${matches.length} posible${matches.length > 1 ? 's' : ''} coincidencia${matches.length > 1 ? 's' : ''} cerca</h3>
    <p>Mismo tipo de animal, color parecido y a menos de 5 km; o el mismo microchip, aunque esté lejos. Ábrelo desde "Mapa" para contactar dentro de la app.</p>
    ${matches.map(m => `<div class="match-item">${TIPO_ICON[m.tipo] || '🐾'} ${esc(m.color)} · ${m.por_chip ? 'mismo microchip' : esc(m.distancia_km) + ' km'}</div>`).join('')}
  </div>`
    : '';
  el.innerHTML = fuertes + extra;
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
  // Por id, no por clase: dentro del formulario hay otro botón con la clase
  // .submit-btn (el "Siguiente" del wizard) y querySelector devolvería ese.
  const btn = document.getElementById('wizard-submit-' + key);
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
    // El microchip es opcional y privado: solo viaja si su dueño lo declara.
    const chipValor = get('chip');
    if (chipValor) fd.append('codigo_chip', chipValor);
    if (photoFile[key]) fd.append('foto', photoFile[key], 'foto.jpg');

    const { report } = await api('/api/reports', { method: 'POST', isForm: true, body: fd });
    toast('¡Aviso publicado!');
    resetForm(key);
    try {
      const { matches, sugerencias } = await api(`/api/reports/${report.id}/matches?amplio=1`);
      renderMatchBanner('match-area-' + key, matches, sugerencias);
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
// Publicar solo desde el último paso: con Enter en los pasos intermedios no se
// envía nada (el botón de publicar está oculto hasta el final).
document.getElementById('form-found').addEventListener('submit', e => {
  e.preventDefault();
  if (!ultimoPaso('found')) return;
  handleSubmit('encontrado', 'found');
});
document.getElementById('form-lost').addEventListener('submit', e => {
  e.preventDefault();
  if (!ultimoPaso('lost')) return;
  handleSubmit('perdido', 'lost');
});
document.getElementById('tipo-lost').addEventListener('change', actualizarRadioHint);
document.getElementById('perdido-hace-lost').addEventListener('change', actualizarRadioHint);

// Vista previa del animal en el formulario: se redibuja al cambiar tipo, raza o
// color, para que el usuario vea cómo quedará su aviso antes de publicarlo.
function actualizarPreviewAnimal(key) {
  const cont = document.getElementById('preview-' + key);
  if (!cont) return;
  const valor = campo => (document.getElementById(campo + '-' + key) || {}).value || '';
  cont.innerHTML = window.RAZAS_API.renderAnimalSVG(valor('tipo') || 'otro', valor('raza'), valor('color'));
}
['found', 'lost'].forEach(key => {
  ['tipo', 'raza', 'color'].forEach(campo => {
    const input = document.getElementById(campo + '-' + key);
    if (input) input.addEventListener('input', () => actualizarPreviewAnimal(key));
  });
});

/* ============ Home: lista y mapa ============ */
async function fetchReports() {
  const tipo = document.getElementById('filter-tipo').value;
  const estado = document.getElementById('filter-estado').value;
  const q = (document.getElementById('search-text').value || '').trim();
  if (DEMO_MODE) {
    allReports = DEMO_REPORTS.filter(
      report =>
        (!tipo || report.tipo === tipo) &&
        (!estado || report.estado === estado) &&
        (!q || `${report.color} ${report.raza} ${report.descripcion}`.toLowerCase().includes(q.toLowerCase()))
    );
    return;
  }
  const qs = new URLSearchParams();
  if (tipo) qs.set('tipo', tipo);
  if (estado) qs.set('estado', estado);
  if (q) qs.set('q', q);
  const { reports } = await api('/api/reports?' + qs.toString());
  allReports = reports.sort((a, b) => b.created_at - a.created_at).map(conNombre);
}

// La API expone el nombre de la mascota como `nombre_mascota`; las tarjetas y
// los datos de demostración leen `r.nombre`. Se unifica en un solo punto para
// que el nombre se vea siempre, sin tocar cada lugar que lo usa.
function conNombre(r) {
  return { ...r, nombre: r.nombre_mascota || r.nombre || null };
}
function reportCard(r) {
  const nombre = r.nombre ? esc(r.nombre) : `${TIPO_ICON[r.tipo] || '🐾'} ${esc(r.color)}`;
  const ubicacion = r.ubicacion ? esc(r.ubicacion) : '';
  const avatar = window.RAZAS_API.renderAnimalSVG(r.tipo, r.raza, r.color);
  const colorCollar = COLLAR_COLOR[String(r.collar || '').toLowerCase()] || '';
  const collarAvatar = colorCollar
    ? `<span class="pet-avatar-collar" style="background:${colorCollar}"></span>`
    : '';
  return `
    <div class="report-card ${r.estado === 'perdido' ? 'lost' : ''}" data-id="${esc(r.id)}">
      ${r.foto_url ? `<img src="${esc(fotoSrc(r.foto_url))}" alt="" loading="lazy">` : `<div class="ph-placeholder pet-avatar"><span class="pet-avatar-face"><span class="pet-avatar-emoji">${avatar}</span>${collarAvatar}</span></div>`}
      <div class="report-body">
        <div class="report-top">
          <h4>${nombre}</h4>
          <span class="report-time">${timeAgo(r.created_at)}</span>
        </div>
        <div class="report-meta report-summary">${TIPO_ICON[r.tipo] || '🐾'} ${r.raza ? esc(r.raza) : esc(r.tipo)} · ${esc(r.color)}${r.collar ? ' · Collar ' + esc(r.collar) : ''}</div>
        ${ubicacion ? `<div class="report-location">${ico('pin')} ${ubicacion}</div>` : ''}
        ${r.descripcion ? `<div class="report-meta">${esc(r.descripcion)}</div>` : ''}
        <div class="report-actions">
          ${
            r.es_mio
              ? `<button data-action="matches" data-id="${esc(r.id)}" data-estado="${esc(r.estado)}">Coincidencias</button>`
              : `<button data-action="contact" data-id="${esc(r.id)}">Contactar</button><button data-action="flag" data-id="${esc(r.id)}">Reportar</button>`
          }
          ${r.estado === 'perdido' ? `<button data-action="heat" data-id="${esc(r.id)}">Zona de búsqueda</button>` : ''}
          <button data-action="share" data-id="${esc(r.id)}">Compartir</button>
        </div>
        <div class="matches-box" id="matches-${esc(r.id)}" style="display:none;"></div>
        <div class="contact-box hidden" id="contact-${esc(r.id)}">
          <textarea class="contact-text" placeholder="Escribe un mensaje para quien publicó este aviso…"></textarea>
          <label class="check"><input type="checkbox" class="contact-loc"> Adjuntar mi ubicación actual</label>
          <button data-action="send" data-id="${esc(r.id)}">Enviar mensaje</button>
        </div>
      </div>
      ${
        r.estado === 'perdido'
          ? `<span class="report-heat" title="Zona de búsqueda sugerida">${ico('thermometer')}<small>Zona posible</small></span>`
          : '<span class="report-chevron" aria-hidden="true">›</span>'
      }
    </div>`;
}
async function renderList() {
  limpiarZonaCalor();
  await fetchReports();
  const el = document.getElementById('reports-list');
  if (allReports.length === 0) {
    el.innerHTML = `<div class="empty-state"><div class="big">🐾</div>Todavía no hay avisos.<br>Publica el primero desde Perdí o Encontré.</div>`;
    return;
  }
  el.innerHTML = allReports.map(reportCard).join('');
}

async function toggleMatches(id, estado) {
  const box = document.getElementById('matches-' + id);
  if (box.style.display === 'block') {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'block';
  box.innerHTML = '<span class="none">Buscando…</span>';
  try {
    const { matches, sugerencias } = await api(`/api/reports/${id}/matches?amplio=1`);
    // Solo el dueño de un aviso PERDIDO puede confirmar un avistamiento (la
    // coincidencia es un aviso "encontrado" que él reconoce como su mascota).
    const puedeConfirmar = estado === 'perdido';
    const fuertes = matches
      .map(
        m => `
        <div class="match-row">
          ${
            m.foto_url
              ? `<img class="match-thumb" src="${esc(fotoSrc(m.foto_url))}" alt="" loading="lazy">`
              : `<span class="match-thumb">${TIPO_ICON[m.tipo] || '🐾'}</span>`
          }
          <div class="match-info">
            <div>${TIPO_ICON[m.tipo] || '🐾'} ${esc(m.color)} · ${m.por_chip ? 'mismo microchip' : esc(m.distancia_km) + ' km'}</div>
            ${
              puedeConfirmar
                ? `<button data-action="sighting" data-id="${esc(id)}" data-found="${esc(m.id)}">Es mi mascota: confirmar avistamiento</button>`
                : ''
            }
          </div>
        </div>`
      )
      .join('');
    box.innerHTML =
      (fuertes || `<span class="none">Sin coincidencias cercanas.</span>`) + htmlSugerencias(sugerencias);
  } catch (ex) {
    box.innerHTML = `<span class="none">${esc(ex.message)}</span>`;
  }
}
// El dueño autoriza que un aviso "encontrado" es su mascota vista: se guarda el
// punto del avistamiento y la zona de búsqueda se re-centra ahí (más acotada).
async function confirmarAvistamiento(lostId, foundId) {
  if (
    !confirm(
      '¿Confirmas que este aviso es tu mascota? Se marcará el punto donde la vieron y la zona de búsqueda se ajustará a ese lugar.'
    )
  )
    return;
  try {
    await api(`/api/reports/${lostId}/sighting`, { method: 'POST', body: { found_report_id: foundId } });
    toast('Avistamiento confirmado. Ajustamos la zona de búsqueda.');
    await renderList();
    renderListMap();
    if (zonaCalor.id !== lostId) toggleHeat(lostId);
  } catch (ex) {
    toast(ex.message);
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
    card.querySelector('.contact-loc').checked = false;
    document.getElementById('contact-' + id).classList.add('hidden');
    actualizarBadgeChats();
  } catch (ex) {
    toast(ex.message);
  }
}
async function shareReport(id) {
  const url = location.origin + '/?r=' + id;
  const shareData = { title: 'PetSeñal', text: 'Mira este aviso de mascota en PetSeñal', url };
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
  if (btn) {
    const id = btn.dataset.id;
    switch (btn.dataset.action) {
      case 'matches':
        toggleMatches(id, btn.dataset.estado);
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
      case 'sighting':
        confirmarAvistamiento(id, btn.dataset.found);
        break;
      case 'heat':
        toggleHeat(id);
        break;
    }
    return;
  }
  // En el mapa las tarjetas no muestran botones: tocar una de una mascota
  // perdida enciende (o apaga) su zona de búsqueda sugerida.
  if (e.target.closest('button, input, textarea, select, a, .contact-box, .matches-box')) return;
  const card = e.target.closest('.report-card');
  const enMapa = !document.getElementById('view-home').classList.contains('home-list-mode');
  if (card && enMapa) toggleHeat(card.dataset.id);
});

async function renderListMap() {
  if (!listMap) {
    listMap = L.map('list-map').setView([userLoc.lat, userLoc.lng], DEMO_MODE ? 13 : 12);
    agregarCapaTiles(listMap);
    clusterGroup = DEMO_MODE ? L.layerGroup() : L.markerClusterGroup();
    listMap.addLayer(clusterGroup);
    setTimeout(() => listMap.invalidateSize(), 200);
    pintarMarcadorUsuario();
  }
  clusterGroup.clearLayers();
  allReports.forEach(r => {
    const marker = L.marker([r.lat, r.lng], { icon: markerIcon(r) });
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
// La pantalla principal tiene dos modos (mapa o lista) y se eligen desde la
// barra inferior: "Mapa" y "Buscar". Antes había además un botón Mapa/Lista
// flotante sobre el mapa, que duplicaba esa elección; se quitó.
function mostrarVistaHome(conMapa) {
  document.getElementById('view-home').classList.toggle('home-list-mode', !conMapa);
  document.querySelectorAll('.bottom-nav button[data-home-mode]').forEach(button => {
    button.classList.toggle('active', button.dataset.homeMode === (conMapa ? 'map' : 'list'));
  });
  document.getElementById('list-map').style.display = conMapa ? 'block' : 'none';
  if (conMapa) setTimeout(() => listMap && listMap.invalidateSize(), 50);
}

/* ============ Zona de búsqueda sugerida (mapa) ============ */
// Al tocar un aviso de mascota perdida se dibuja en el mapa la zona donde los
// estudios sugieren buscarla (ver docs/RADIO_DE_BUSQUEDA.md y backend/busqueda.js).
// Es opcional: el mismo toque la muestra y la esconde. La primera vez de cada
// sesión (token de ingreso) se avisa de que es una referencia, no una regla.
const ZONA_INTRO_KEY = 'rastro_zona_intro';

function limpiarZonaCalor() {
  if (listMap) zonaCalor.capas.forEach(capa => listMap.removeLayer(capa));
  zonaCalor = { id: null, capas: [] };
}

// Tres anillos concéntricos: el degradado hace de "mapa de calor" sin librerías.
// Si el dueño confirmó un avistamiento, la zona se centra ahí y el radio sale de
// la MISMA fórmula pero contando desde el avistamiento (por eso es más acotada);
// la zona original queda de referencia, punteada y tenue.
function dibujarZonaCalor(r) {
  const originalKm = r.radio_km || radioBusquedaKm(r.tipo, r.perdido_hace_horas || 0);
  const capas = [];
  let centro = [r.lat, r.lng];
  let km = originalKm;
  if (r.sighting) {
    centro = [r.sighting.lat, r.sighting.lng];
    const horas = Math.max(0, (Date.now() - r.sighting.at) / 3600000);
    km = radioBusquedaKm(r.tipo, horas);
    capas.push(
      L.circle([r.lat, r.lng], {
        radius: originalKm * 1000,
        color: '#9bb6b8',
        weight: 1,
        opacity: 0.55,
        dashArray: '5 7',
        fill: false,
        interactive: false
      }).addTo(listMap)
    );
  }
  const anillos = [
    { f: 1, color: '#f2a03d', op: 0.1 },
    { f: 0.66, color: '#e8763a', op: 0.13 },
    { f: 0.33, color: '#d84a2f', op: 0.16 }
  ];
  const anillosCapas = anillos.map(a =>
    L.circle(centro, {
      radius: km * 1000 * a.f,
      color: '#c8452c',
      weight: 1,
      opacity: 0.5,
      fillColor: a.color,
      fillOpacity: a.op,
      interactive: false
    }).addTo(listMap)
  );
  return { capas: [...capas, ...anillosCapas], borde: anillosCapas[0] };
}

function toggleHeat(id) {
  const r = allReports.find(x => x.id === id);
  if (!r || r.estado !== 'perdido' || !listMap) return;
  if (zonaCalor.id === id) {
    limpiarZonaCalor();
    return;
  }
  limpiarZonaCalor();
  mostrarVistaHome(true);
  zonaCalor.id = id;
  const { capas, borde } = dibujarZonaCalor(r);
  zonaCalor.capas = capas;
  setTimeout(() => {
    if (listMap && borde) listMap.fitBounds(borde.getBounds(), { padding: [40, 40], maxZoom: 15 });
  }, 120);
  if (zonaIntroPendiente()) {
    abrirZonaIntro();
    marcarZonaIntro();
  }
}

// El aviso informativo se muestra una sola vez por token de ingreso: se guarda
// el token actual y no vuelve a salir hasta que se inicie sesión de nuevo.
function zonaIntroPendiente() {
  try {
    return Boolean(token) && localStorage.getItem(ZONA_INTRO_KEY) !== token;
  } catch (e) {
    return false;
  }
}
function marcarZonaIntro() {
  try {
    localStorage.setItem(ZONA_INTRO_KEY, token || '');
  } catch (e) {
    /* modo privado: se volverá a mostrar, no es crítico */
  }
}
function abrirZonaIntro() {
  document.getElementById('zona-intro').classList.remove('hidden');
}
document.getElementById('btn-zona-intro-close').addEventListener('click', () => {
  document.getElementById('zona-intro').classList.add('hidden');
});

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
          ${m.lat !== null ? `<a class="msg-loc" href="https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lng}#map=16/${m.lat}/${m.lng}" target="_blank" rel="noopener">${ico('pin')} ubicación compartida</a>` : ''}
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

/* ============ Mis avisos (repartidos por estado) ============ */
// Antes había una pestaña "Avisos" con todo mezclado. Ahora cada sección
// (Perdí, Encontré) muestra los suyos, así que la lista se filtra por estado.
function avisosHTML(reports, vacio, previos = false) {
  if (!reports.length) {
    return `<div class="empty-state"><div class="big">${vacio}</div>Todavía no has publicado avisos aquí.</div>`;
  }
  return reports
    .map(
      r => `
      <div class="inbox-item${previos ? ' previous-item' : ''}" data-id="${esc(r.id)}">
        <h4>${TIPO_ICON[r.tipo] || '🐾'} ${r.nombre_mascota ? esc(r.nombre_mascota) + ' · ' : ''}${esc(r.color)}
          ${r.resolved ? '<span class="tag resolved">Resuelto</span>' : ''}
          ${previos ? '<span class="tag previous">Previo</span>' : ''}
          ${r.unread ? `<span class="unread-dot">${r.unread}</span>` : ''}
        </h4>
        <div class="report-meta">Publicado ${timeAgo(r.created_at)}${r.descripcion ? ' · ' + esc(r.descripcion) : ''}</div>
        ${
          previos
            ? ''
            : `<div class="report-actions">
          <button data-action="open-chat" data-id="${esc(r.id)}">Conversaciones</button>
          <button data-action="resolve" data-id="${esc(r.id)}" data-resolved="${r.resolved ? 'false' : 'true'}">${r.resolved ? 'Reabrir' : 'Marcar resuelto'}</button>
          <button data-action="edit" data-id="${esc(r.id)}">Editar</button>
          <button data-action="poster" data-id="${esc(r.id)}">Cartel</button>
          ${r.tiene_chip ? `<button data-action="chip" data-id="${esc(r.id)}">Ver microchip</button>` : ''}
          <button data-action="share" data-id="${esc(r.id)}">Compartir</button>
          <button data-action="delete" data-id="${esc(r.id)}">Eliminar</button>
        </div>`
        }
      </div>`
    )
    .join('');
}
async function renderInbox() {
  try {
    const [{ reports }, { reports: previous }] = await Promise.all([
      api('/api/reports/mine/all'),
      api('/api/reports/mine/previous')
    ]);
    myReports = reports;
    document.getElementById('inbox-lost').innerHTML = avisosHTML(
      reports.filter(r => r.estado === 'perdido'),
      '🔎'
    );
    document.getElementById('inbox-found').innerHTML = avisosHTML(
      reports.filter(r => r.estado !== 'perdido'),
      '🐾'
    );
    document.getElementById('inbox-previous-lost').innerHTML = avisosHTML(
      previous.filter(r => r.estado === 'perdido'),
      '🔎',
      true
    );
    document.getElementById('inbox-previous-found').innerHTML = avisosHTML(
      previous.filter(r => r.estado !== 'perdido'),
      '🐾',
      true
    );
  } catch (ex) {
    const error = `<p class="loc-note">${esc(ex.message)}</p>`;
    document.getElementById('inbox-lost').innerHTML = error;
    document.getElementById('inbox-found').innerHTML = error;
  }
}
// El número del microchip solo se pide cuando su dueño lo pide a propósito: en el
// listado solo viaja la máscara. El botón alterna ver y volver a ocultar.
async function mostrarChip(id, btn) {
  const caja = btn.parentElement.querySelector('.chip-valor');
  if (caja && caja.dataset.visible === '1') {
    caja.dataset.visible = '0';
    caja.textContent = caja.dataset.mascara || '';
    btn.textContent = 'Ver microchip';
    return;
  }
  try {
    const datos = await api(`/api/reports/${id}/chip`);
    if (!datos.chip) return toast('Este aviso no tiene microchip declarado.');
    let destino = caja;
    if (!destino) {
      destino = document.createElement('span');
      destino.className = 'chip-valor';
      btn.parentElement.appendChild(destino);
    }
    destino.dataset.visible = '1';
    destino.dataset.mascara = datos.enmascarado || '';
    destino.textContent = datos.chip;
    btn.textContent = 'Ocultar microchip';
  } catch (ex) {
    toast(ex.message);
  }
}
async function manejarAccionAviso(e) {
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
    // El microchip no se rellena (el número no viaja en los listados): se dice si
    // existe y se deja el campo solo para cambiarlo.
    document.getElementById('edit-chip').value = '';
    document.getElementById('edit-chip-borrar').checked = false;
    document.getElementById('edit-chip-estado').textContent = r.tiene_chip
      ? `Tiene microchip declarado${r.chip_enmascarado ? ' (' + r.chip_enmascarado + ')' : ''}. Solo lo ves tú.`
      : 'Este aviso no tiene microchip declarado.';
    document.getElementById('edit-modal').classList.remove('hidden');
  }
  if (action === 'chip') return mostrarChip(id, btn);
  if (action === 'open-chat') {
    mostrarVista('chats');
  }
}
document.getElementById('inbox-lost').addEventListener('click', manejarAccionAviso);
document.getElementById('inbox-found').addEventListener('click', manejarAccionAviso);
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
  // El chip solo se manda si el usuario lo cambia o pide borrarlo: si no, se
  // conserva el que ya tenía (mandar la cadena vacía lo borraría).
  const chipNuevo = document.getElementById('edit-chip').value.trim();
  if (document.getElementById('edit-chip-borrar').checked) body.codigo_chip = '';
  else if (chipNuevo) body.codigo_chip = chipNuevo;
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
    const label = document.getElementById('push-label');
    if (label) label.textContent = sub ? 'Notificaciones activadas' : 'Activar notificaciones';
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
  const oscuro = tema === 'dark';
  document.body.classList.toggle('theme-dark', oscuro);
  // El icono vive en su propio hueco dentro del botón del menú: reemplazar el
  // innerHTML del botón borraría su etiqueta "Modo claro / oscuro".
  const icono = document.getElementById('theme-ico');
  if (icono) icono.innerHTML = ico(oscuro ? 'sun' : 'moon');
  const btn = document.getElementById('btn-theme');
  if (btn) btn.title = oscuro ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro';
  const etiqueta = document.getElementById('theme-label');
  if (etiqueta) etiqueta.innerHTML = oscuro ? 'Modo<br>claro' : 'Modo<br>nocturno';
  // La barra del sistema (Android) sigue al tema elegido.
  const meta = document.getElementById('meta-theme');
  if (meta) meta.content = oscuro ? '#14181a' : '#f5f2eb';
}
function initTema() {
  const guardado = localStorage.getItem('rastro_tema');
  aplicarTema(guardado || 'light');
}
document.getElementById('btn-theme').addEventListener('click', () => {
  const nuevo = document.body.classList.contains('theme-dark') ? 'light' : 'dark';
  localStorage.setItem('rastro_tema', nuevo);
  aplicarTema(nuevo);
});

/* ============ Instalar como app (PWA) ============ */
let deferredInstall = null;

function appEstaInstalada() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

function actualizarControlesInstalacion() {
  const instalada = appEstaInstalada();
  document.getElementById('auth-install').classList.toggle('hidden', instalada);
  document.getElementById('btn-install').classList.toggle('hidden', instalada || !deferredInstall);
}

function ayudaInstalacionManual() {
  const apple = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  return apple
    ? 'En Safari, toca Compartir y luego “Añadir a pantalla de inicio”.'
    : 'Abre el menú del navegador y elige “Instalar aplicación” o “Añadir a pantalla de inicio”.';
}

async function instalarApp() {
  if (appEstaInstalada()) {
    toast('PetSeñal ya está instalada en este dispositivo.');
    actualizarControlesInstalacion();
    return;
  }
  if (!deferredInstall) {
    toast(ayudaInstalacionManual());
    return;
  }
  deferredInstall.prompt();
  try {
    await deferredInstall.userChoice;
  } catch (_) {
    /* El navegador cerró el diálogo de instalación. */
  }
  deferredInstall = null;
  actualizarControlesInstalacion();
}

window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  actualizarControlesInstalacion();
});
window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  actualizarControlesInstalacion();
});
['btn-install', 'btn-install-auth'].forEach(id =>
  document.getElementById(id).addEventListener('click', instalarApp)
);
actualizarControlesInstalacion();

/* ============ Privacidad ============ */
// El modal está fuera de #app: se abre tanto desde el menú de Opciones como
// desde el enlace de la pantalla de acceso, así que sirve con y sin sesión.
function abrirPrivacidad() {
  document.getElementById('privacy-modal').classList.remove('hidden');
}
function cerrarPrivacidad() {
  document.getElementById('privacy-modal').classList.add('hidden');
}
document.getElementById('btn-privacy').addEventListener('click', abrirPrivacidad);
document.getElementById('btn-privacy-close').addEventListener('click', cerrarPrivacidad);
document.getElementById('link-privacy').addEventListener('click', e => {
  e.preventDefault();
  abrirPrivacidad();
});

/* ============ Consejos ============ */
document
  .getElementById('btn-tips')
  .addEventListener('click', () => document.getElementById('tips-modal').classList.remove('hidden'));
document
  .getElementById('btn-tips-close')
  .addEventListener('click', () => document.getElementById('tips-modal').classList.add('hidden'));

/* ============ Onboarding (solo la primera vez) ============ */
const ONBOARD_PASOS = 3;

function initOnboarding() {
  if (localStorage.getItem('rastro_onboard') === '1') return;
  const modal = document.getElementById('onboarding');
  const track = document.getElementById('onboard-track');
  modal.classList.remove('hidden');
  let step = 0;
  const pintar = () => {
    track.style.transform = `translateX(${-100 * step}%)`;
    modal.querySelectorAll('.onboard-dots i').forEach((d, i) => d.classList.toggle('active', i === step));
    document.getElementById('btn-onboard-next').textContent =
      step === ONBOARD_PASOS - 1 ? 'Empezar' : 'Siguiente';
  };
  const ir = nuevo => {
    step = Math.min(Math.max(nuevo, 0), ONBOARD_PASOS - 1);
    pintar();
  };
  const cerrar = () => {
    localStorage.setItem('rastro_onboard', '1');
    modal.classList.add('hidden');
  };
  document.getElementById('btn-onboard-next').onclick = () => {
    if (step === ONBOARD_PASOS - 1) return cerrar();
    ir(step + 1);
  };
  document.getElementById('btn-onboard-skip').onclick = cerrar;
  activarSwipeOnboarding(track, ir, () => step);
  pintar();
}

// Arrastre del carril (dedo o ratón) y flechas del teclado. El umbral es
// relativo al ancho: en pantallas chicas no hace falta arrastrar tanto.
function activarSwipeOnboarding(track, ir, pasoActual) {
  let x0 = null;
  let dx = 0;
  // Desde dentro de un control (el mapa, un campo, la zona de la foto) el gesto
  // es del control, no del carril: si no, arrastrar el mapa movería los pasos.
  const desdeControl = objetivo =>
    Boolean(objetivo.closest) &&
    Boolean(objetivo.closest('.mini-map, input, textarea, select, button, .photo-zone, .addr-results'));
  const pintarArrastre = () => {
    track.style.transform = `translateX(calc(${-100 * pasoActual()}% + ${dx}px))`;
  };
  const soltar = () => {
    if (x0 === null) return;
    track.style.transition = '';
    const umbral = Math.max(36, track.clientWidth * 0.18);
    if (dx <= -umbral) ir(pasoActual() + 1);
    else if (dx >= umbral) ir(pasoActual() - 1);
    else pintarArrastre();
    x0 = null;
    dx = 0;
  };
  track.addEventListener('pointerdown', e => {
    if (desdeControl(e.target)) return;
    x0 = e.clientX;
    dx = 0;
    track.style.transition = 'none';
    track.setPointerCapture(e.pointerId);
  });
  track.addEventListener('pointermove', e => {
    if (x0 === null) return;
    dx = e.clientX - x0;
    pintarArrastre();
  });
  track.addEventListener('pointerup', soltar);
  track.addEventListener('pointercancel', soltar);
  document.addEventListener('keydown', e => {
    if (document.getElementById('onboarding').classList.contains('hidden')) return;
    if (e.key === 'ArrowRight') ir(pasoActual() + 1);
    if (e.key === 'ArrowLeft') ir(pasoActual() - 1);
  });
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

/* ============ Ubicación para las alertas de zona ============ */
// Al abrir la app se guarda la última ubicación conocida para poder avisar de
// mascotas perdidas cerca. Tres reglas:
//   1. Sale DIFUMINADA (~300 m): para avisar "cerca de tu zona" sobra, y así el
//      servidor no guarda dónde vives exactamente.
//   2. Solo se reenvía si pasaron 6 h o si te moviste más de 500 m: no hay una
//      escritura en la base por cada vez que se abre la app.
//   3. Si el usuario desactivó las alertas, no se vuelve a guardar sola.
const ZONA_AUTO_KEY = 'rastro_zona_auto';
const ZONA_OFF_KEY = 'rastro_zona_off';
const ZONA_MIN_MS = 6 * 60 * 60 * 1000;
const ZONA_MIN_M = 500;
const DIFUMINADO_M = 300;

function distanciaAproxM(a, b) {
  const dLat = (b.lat - a.lat) * 111320;
  const dLng = (b.lng - a.lng) * 111320 * Math.max(0.1, Math.cos((a.lat * Math.PI) / 180));
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

// Corre el punto un poco (mismo criterio que la ubicación pública de los avisos).
function difuminarPunto(loc, metros = DIFUMINADO_M) {
  const angulo = Math.random() * 2 * Math.PI;
  const radio = Math.random() * metros;
  return {
    lat: loc.lat + (radio * Math.cos(angulo)) / 111320,
    lng: loc.lng + (radio * Math.sin(angulo)) / (111320 * Math.max(0.1, Math.cos((loc.lat * Math.PI) / 180)))
  };
}

function leerZonaAuto() {
  try {
    return JSON.parse(localStorage.getItem(ZONA_AUTO_KEY) || 'null');
  } catch (e) {
    return null;
  }
}

async function guardarUbicacionDeZona() {
  if (!token || localStorage.getItem(ZONA_OFF_KEY) === '1') return;
  const previa = leerZonaAuto();
  if (previa && Date.now() - previa.fecha < ZONA_MIN_MS) return;
  const loc = await getCurrentLocOrNull();
  if (!loc) return;
  if (previa && distanciaAproxM(previa, loc) < ZONA_MIN_M) {
    // Sigue siendo el mismo sitio: basta con anotar que se comprobó hoy.
    localStorage.setItem(ZONA_AUTO_KEY, JSON.stringify({ ...previa, fecha: Date.now() }));
    return;
  }
  // El servidor decide: si el usuario fijó su barrio a mano, esto no lo pisa.
  const difuminado = difuminarPunto(loc);
  try {
    await api('/api/push/zone', { method: 'POST', body: { ...difuminado, origen: 'auto' } });
    localStorage.setItem(ZONA_AUTO_KEY, JSON.stringify({ lat: loc.lat, lng: loc.lng, fecha: Date.now() }));
  } catch (e) {
    /* es un extra silencioso: la app funciona igual sin esto */
  }
}

/* ============ Microchips ============ */
// Registro voluntario. El número completo solo se pide al servidor cuando su
// dueño lo pide a propósito, y la lista ya trae la máscara para mostrarla por
// defecto. Nada de esto se muestra a otras cuentas en ninguna parte de la app.
let misChips = [];
let editandoChipId = null;
let chipVisibleTimer = null;
// El número revelado se vuelve a ocultar solo: no conviene que quede a la vista
// en el móvil si alguien mira por encima del hombro.
const CHIP_VISIBLE_MS = 30000;

function chipsHTML(registros) {
  if (!registros.length) {
    return `<div class="empty-state"><div class="big">🔒</div>Todavía no registraste ningún microchip.</div>`;
  }
  return registros
    .map(
      r => `
      <div class="inbox-item" data-id="${esc(r.id)}">
        <h4>🐾 ${esc(r.pet_name)}${r.species ? ' · ' + esc(r.species) : ''}</h4>
        <div class="report-meta">
          Registrado ${timeAgo(r.created_at)} ·
          <span
            class="chip-mascara"
            role="status"
            aria-live="polite"
            data-visible="0"
            data-mascara="${esc(r.chip_enmascarado || '')}"
            >${esc(r.chip_enmascarado || 'sin datos')}</span
          >
        </div>
        <div class="report-actions">
          <button data-action="chip-ver" data-id="${esc(r.id)}">Ver número</button>
          <button data-action="chip-editar" data-id="${esc(r.id)}">Editar</button>
          <button data-action="chip-borrar" data-id="${esc(r.id)}">Dar de baja</button>
        </div>
      </div>`
    )
    .join('');
}

async function renderMisChips() {
  const caja = document.getElementById('chips-lista');
  try {
    const { registros } = await api('/api/chips/mine');
    misChips = registros;
    caja.innerHTML = chipsHTML(registros);
  } catch (ex) {
    caja.innerHTML = `<p class="loc-note">${esc(ex.message)}</p>`;
  }
}

// Alterna entre la máscara y el número completo. El número ya vino en la lista
// (es el dato de su dueño), así que no hace falta otra llamada.
function alternarChipVisible(btn, registro) {
  const caja = btn.closest('.inbox-item').querySelector('.chip-mascara');
  if (caja.dataset.visible === '1') return ocultarChipVisible();
  caja.dataset.visible = '1';
  caja.textContent = registro.chip || caja.dataset.mascara || '';
  btn.textContent = 'Ocultar número';
  if (chipVisibleTimer) clearTimeout(chipVisibleTimer);
  chipVisibleTimer = setTimeout(ocultarChipVisible, CHIP_VISIBLE_MS);
}

// Vuelve a enmascarar todos los números (y cancela el temporizador). Se llama al
// ocultar a mano y al salir de la vista.
function ocultarChipVisible() {
  if (chipVisibleTimer) {
    clearTimeout(chipVisibleTimer);
    chipVisibleTimer = null;
  }
  document.querySelectorAll('.chip-mascara[data-visible="1"]').forEach(caja => {
    caja.dataset.visible = '0';
    caja.textContent = caja.dataset.mascara || '';
    const item = caja.closest('.inbox-item');
    const btn = item ? item.querySelector('[data-action="chip-ver"]') : null;
    if (btn) btn.textContent = 'Ver número';
  });
}

function editarChip(registro) {
  editandoChipId = registro.id;
  document.getElementById('chip-edit-nombre').value = registro.pet_name;
  document.getElementById('chip-edit-especie').value = registro.species || '';
  document.getElementById('chip-modal').classList.remove('hidden');
  document.getElementById('chip-edit-nombre').focus();
}

document.getElementById('btn-chip-edit-cancel').addEventListener('click', () => {
  document.getElementById('chip-modal').classList.add('hidden');
  editandoChipId = null;
});

document.getElementById('form-chip-edit').addEventListener('submit', async e => {
  e.preventDefault();
  if (!editandoChipId) return;
  const nombre = document.getElementById('chip-edit-nombre').value.trim();
  if (!nombre) return toast('Escribe el nombre de tu mascota.');
  try {
    await api(`/api/chips/${editandoChipId}`, {
      method: 'PATCH',
      body: { pet_name: nombre, species: document.getElementById('chip-edit-especie').value }
    });
    document.getElementById('chip-modal').classList.add('hidden');
    editandoChipId = null;
    toast('Registro actualizado.');
    renderMisChips();
  } catch (ex) {
    toast(ex.message);
  }
});

async function borrarChip(registro) {
  if (
    !confirm(`¿Dar de baja el microchip de ${registro.pet_name}? Dejará de aparecer si alguien lo escanea.`)
  )
    return;
  try {
    await api(`/api/chips/${registro.id}`, { method: 'DELETE' });
    toast('Microchip dado de baja.');
    renderMisChips();
  } catch (ex) {
    toast(ex.message);
  }
}

async function manejarAccionChip(e) {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const registro = misChips.find(r => r.id === btn.dataset.id);
  if (!registro) return;
  if (btn.dataset.action === 'chip-ver') return alternarChipVisible(btn, registro);
  if (btn.dataset.action === 'chip-editar') return editarChip(registro);
  if (btn.dataset.action === 'chip-borrar') return borrarChip(registro);
}
document.getElementById('chips-lista').addEventListener('click', manejarAccionChip);

// Mismo criterio que el servidor: fuera separadores y el prefijo ISO. El registro
// pide los 15 dígitos de la cartilla (el aviso admite menos porque se dicta).
function digitosDelChip(valor) {
  return valor.replace(/^iso/i, '').replace(/[\s\-._/]/g, '');
}

document.getElementById('form-chip').addEventListener('submit', async e => {
  e.preventDefault();
  const codigo = document.getElementById('chip-reg-codigo').value.trim();
  const nombre = document.getElementById('chip-reg-nombre').value.trim();
  if (!/^[0-9]{15}$/.test(digitosDelChip(codigo))) return toast('El microchip debe tener 15 dígitos.');
  if (!nombre) return toast('Escribe el nombre de tu mascota.');
  // Sin consentimiento no se registra: la casilla nunca viene marcada sola.
  if (!document.getElementById('chip-reg-consent').checked)
    return toast('Necesitamos tu consentimiento para registrar el microchip.');
  try {
    await api('/api/chips/register', {
      method: 'POST',
      body: {
        chip_id: codigo,
        pet_name: nombre,
        species: document.getElementById('chip-reg-especie').value,
        consent_accepted: true
      }
    });
    toast('Microchip registrado. Si alguien lo escanea, te avisamos.');
    document.getElementById('form-chip').reset();
    renderMisChips();
  } catch (ex) {
    toast(ex.message);
  }
});

document.getElementById('btn-chip-scan').addEventListener('click', async () => {
  const caja = document.getElementById('chip-scan-resultado');
  const codigo = document.getElementById('chip-scan-codigo').value.trim();
  if (!/^[0-9]{15}$/.test(digitosDelChip(codigo))) {
    caja.innerHTML = `<p class="loc-note">Escribe los 15 dígitos del microchip.</p>`;
    return;
  }
  caja.innerHTML = `<p class="loc-note">Buscando…</p>`;
  try {
    const r = await api('/api/chips/scan', { method: 'POST', body: { chip_id: codigo } });
    caja.innerHTML = r.matched
      ? `<div class="match-banner">
          <h3>✅ Microchip registrado</h3>
          <p>Está a nombre de <b>${esc(r.pet_name)}</b>. Ya avisamos a su familia. Por su privacidad, no te damos sus datos: si lo encontraste, publica un aviso en «Encontré» para que puedan contactarte.</p>
        </div>`
      : `<p class="loc-note">Ese microchip no está registrado en PetSeñal. Publica un aviso en «Encontré»: es la vía para que su familia lo vea.</p>`;
  } catch (ex) {
    caja.innerHTML = `<p class="loc-note">${esc(ex.message)}</p>`;
  }
});

/* ============ Alertas por zona ============ */
async function actualizarBotonZona() {
  try {
    const { zone } = await api('/api/push/zone');
    const label = document.getElementById('zone-label');
    if (label) {
      if (!zone) label.textContent = 'Activar alertas de mi zona';
      else if (zone.origen === 'auto') {
        label.textContent =
          'Alertas de tu zona activadas con tu última ubicación (toca para fijar tu barrio)';
      } else label.textContent = 'Alertas de tu zona activadas con tu barrio (toca para desactivar)';
    }
    const b = document.getElementById('btn-zone');
    if (b) b.classList.toggle('active', !!zone);
  } catch (e) {
    /* ignore */
  }
}
document.getElementById('btn-zone').addEventListener('click', async () => {
  try {
    const { zone } = await api('/api/push/zone');
    if (zone) {
      // Con la ubicación automática, el primer toque fija el barrio a mano (es lo
      // que el usuario está pidiendo); ya con su barrio fijado, desactiva.
      if (zone.origen === 'auto') {
        await api('/api/push/zone', {
          method: 'POST',
          body: { lat: userLoc.lat, lng: userLoc.lng, origen: 'manual' }
        });
        localStorage.removeItem(ZONA_OFF_KEY);
        toast('Listo: tu barrio queda fijado para las alertas. Toca de nuevo para desactivarlas.');
        actualizarBotonZona();
        return;
      }
      if (!confirm('¿Desactivar las alertas de mascotas perdidas cerca de tu zona?')) return;
      await api('/api/push/zone', { method: 'DELETE' });
      // Sin esto, la próxima vez que abras la app se volvería a guardar sola.
      localStorage.setItem(ZONA_OFF_KEY, '1');
      localStorage.removeItem(ZONA_AUTO_KEY);
      toast('Alertas de zona desactivadas.');
      actualizarBotonZona();
      return;
    }
    const loc = (await getCurrentLocOrNull()) || userLoc;
    await api('/api/push/zone', { method: 'POST', body: { lat: loc.lat, lng: loc.lng, origen: 'manual' } });
    localStorage.removeItem(ZONA_OFF_KEY);
    toast('Listo: avisaremos aquí cuando se pierda una mascota cerca.');
    // Las alertas llegan por notificación push: recordar activarlas si faltan.
    if (config.pushEnabled && 'serviceWorker' in navigator && 'PushManager' in window) {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (!sub) toast('Tip: activa también las notificaciones con la campana de arriba.');
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
    // No damos por confirmado el correo solo porque se reenvió el enlace: con un
    // proveedor de correo real el servidor solo lo manda, no lo verifica. Se
    // consulta el estado real y así el aviso no desaparece antes de tiempo.
    try {
      const { user } = await api('/api/auth/me');
      if (user) me = user;
    } catch (e) {
      /* si no se puede comprobar, dejamos el aviso como estaba */
    }
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
document.getElementById('btn-admin-purge-reports').addEventListener('click', async () => {
  if (!confirm('¿Borrar TODOS los avisos? Se eliminan también sus fotos.')) return;
  if (!confirm('Última confirmación: esto deja la app en cero y no se puede deshacer.')) return;
  try {
    const r = await api('/api/admin/reports', { method: 'DELETE' });
    toast(`Se borraron ${r.borrados} aviso(s).`);
    renderAdmin();
    renderList()
      .then(renderListMap)
      .catch(() => {});
  } catch (ex) {
    toast(ex.message);
  }
});

/* ============ Arranque ============ */
let appIniciada = false;
let pickersIniciados = { found: false, lost: false };
let badgeTimer = null;
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
    // Publicar va por pasos: el carril se prepara al arrancar, con los mapas ya
    // dentro del DOM (si no, Leaflet mediría un contenedor oculto).
    initWizard('found');
    initWizard('lost');
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
  if (!DEMO_MODE) locateUser();
  // Guarda la última ubicación (difuminada) para las alertas de zona. Es
  // silencioso y con umbral: no bloquea ni escribe en cada apertura.
  guardarUbicacionDeZona();
  actualizarBannerVerificacion();
  mostrarTabAdmin();
  actualizarBotonZona();
  renderList()
    .then(renderListMap)
    .then(() => abrirDeepLink())
    .catch(() => {});
  renderReunions();
  actualizarBadgeChats();
  // El punto verde del chat se revisa cada minuto mientras la app esté abierta.
  if (!badgeTimer) badgeTimer = setInterval(actualizarBadgeChats, 60000);
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
      const normalizado = conNombre(report);
      allReports.unshift(normalizado);
      const el = document.getElementById('reports-list');
      const vacio = el.querySelector('.empty-state');
      if (vacio) el.innerHTML = reportCard(normalizado);
      else el.insertAdjacentHTML('afterbegin', reportCard(normalizado));
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
// Abre la vista que pida la URL (?tab=home, ?tab=found, ?tab=lost, ?tab=chats).
// La usan los atajos del icono de la app (manifest.json → shortcuts) y las
// notificaciones push. mostrarVista se encarga de ignorar ?tab=admin a quien no
// es administrador.
function abrirTabDeLaUrl(params) {
  const tab = params.get('tab');
  if (!tab) return;
  if (['home', 'found', 'lost', 'chats', 'admin'].includes(tab)) mostrarVista(tab);
}

// Comprueba el token guardado antes de entrar. Solo se cierra sesión si el
// servidor responde 401, que es lo único que significa "este token no vale": un
// fallo de red o el arranque en frío de Render (el servicio se duerme y la
// primera petición puede tardar o caerse) NO debe borrar la sesión. Antes
// cualquier fallo mandaba al login y borraba el token, así que bastaba abrir la
// app con mala conexión para tener que escribir la contraseña otra vez.
async function validarSesion(intentos = 2) {
  for (let i = 0; i < intentos; i++) {
    try {
      const data = await api('/api/auth/me');
      return { user: data.user };
    } catch (e) {
      if (e && e.status === 401) return { caducada: true };
      if (i < intentos - 1) await new Promise(r => setTimeout(r, 1200));
    }
  }
  return { transitorio: true };
}

(async function bootstrap() {
  initTema();
  await despertarServidor();
  await loadConfig();

  const params = new URLSearchParams(location.search);
  if (DEMO_MODE) {
    userLoc = { lat: -34.6037, lng: -58.4218 };
    document.body.classList.add('demo-mode');
    showApp();
    startApp();
    return;
  }
  if (params.get('verified') === '1') toast('¡Correo confirmado! Ya puedes publicar.');
  if (params.get('verified') === '0') toast('El enlace de confirmación venció o ya se usó.');
  if (params.get('reset')) {
    ocultarArranque();
    document.getElementById('auth-screen').classList.add('hidden');
    document.getElementById('app').classList.add('hidden');
    document.getElementById('reset-screen').classList.remove('hidden');
    return;
  }

  if (token) {
    const sesion = await validarSesion();
    if (!sesion.caducada) {
      me = sesion.user || null;
      showApp();
      startApp();
      abrirTabDeLaUrl(params);
      if (sesion.transitorio) toast('No pudimos confirmar tu sesión. Revisa tu conexión.');
      return;
    }
    /* token inválido: volvemos al login */ token = null;
    localStorage.removeItem('rastro_token');
  }
  showAuth();
})();

window.toggleMatches = toggleMatches;
window.toggleContact = toggleContact;
window.sendContact = sendContact;
