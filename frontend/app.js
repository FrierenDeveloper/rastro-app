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
let photoFile = { found: null, lost: null };
let pickedLoc = { found: null, lost: null };
let listMap, clusterGroup, mapFound, mapLost, markerFound, markerLost;
let allReports = [];
let myReports = [];
let currentConv = { reportId: null, peerId: null, esMio: false, poll: null };
let editingId = null;

const TIPO_ICON = { perro: '🐕', gato: '🐈', ave: '🐦', conejo: '🐇', otro: '🐾' };

/* ============ Utilidades ============ */
// Escapa el texto que escriben los usuarios antes de mostrarlo, para que
// nadie pueda inyectar código en la página a través de un aviso o mensaje.
function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2400);
}
function timeAgo(ts) {
  const diff = Date.now() - ts, m = Math.floor(diff / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
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
        let w = img.width, h = img.height; const max = 800;
        if (w > h && w > max) { h = Math.round(h * max / w); w = max; }
        else if (h >= w && h > max) { w = Math.round(w * max / h); h = max; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
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
    method, headers, body: isForm ? body : (body ? JSON.stringify(body) : undefined)
  });
  let data = {};
  try { data = await res.json(); } catch (e) { /* respuesta vacía */ }
  if (!res.ok) {
    if (res.status === 401 && auth && token) logout();
    throw new Error(data.error || 'Ocurrió un error.');
  }
  return data;
}
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
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
  } catch (e) { /* usa valores por defecto */ }
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
  token = null; me = null;
  localStorage.removeItem('rastro_token');
  if (currentConv.poll) { clearInterval(currentConv.poll); currentConv.poll = null; }
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
  const err = document.getElementById('login-error'); err.classList.remove('show');
  try {
    const data = await api('/api/auth/login', {
      method: 'POST', auth: false, body: {
        email: document.getElementById('login-email').value.trim(),
        password: document.getElementById('login-password').value
      }
    });
    onAuthSuccess(data.token);
  } catch (ex) { err.textContent = ex.message; err.classList.add('show'); }
});

document.getElementById('form-forgot').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('forgot-error'); const okEl = document.getElementById('forgot-ok');
  err.classList.remove('show'); okEl.classList.remove('show');
  try {
    const data = await api('/api/auth/forgot', {
      method: 'POST', auth: false, body: { email: document.getElementById('forgot-email').value.trim() }
    });
    okEl.textContent = data.message; okEl.classList.add('show');
  } catch (ex) { err.textContent = ex.message; err.classList.add('show'); }
});

document.getElementById('form-register').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('register-error'); err.classList.remove('show');
  try {
    const data = await api('/api/auth/register', {
      method: 'POST', auth: false, body: {
        email: document.getElementById('register-email').value.trim(),
        password: document.getElementById('register-password').value,
        phone: document.getElementById('register-phone').value.trim()
      }
    });
    onAuthSuccess(data.token);
  } catch (ex) { err.textContent = ex.message; err.classList.add('show'); }
});

document.getElementById('form-reset').addEventListener('submit', async e => {
  e.preventDefault();
  const err = document.getElementById('reset-error'); err.classList.remove('show');
  const tok = new URLSearchParams(location.search).get('reset');
  try {
    await api('/api/auth/reset', { method: 'POST', auth: false, body: { token: tok, password: document.getElementById('reset-password').value } });
    toast('Contraseña actualizada. Inicia sesión.');
    history.replaceState(null, '', location.pathname);
    showAuth();
  } catch (ex) { err.textContent = ex.message; err.classList.add('show'); }
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
          const data = await api('/api/auth/google', { method: 'POST', auth: false, body: { credential: resp.credential } });
          onAuthSuccess(data.token);
        } catch (ex) { toast(ex.message); }
      }
    });
    google.accounts.id.renderButton(document.querySelector('.g_id_signin'), { theme: 'outline', size: 'large', width: 300 });
  };
  start();
}

document.getElementById('btn-logout').addEventListener('click', logout);

document.getElementById('btn-delete-account').addEventListener('click', async () => {
  if (!confirm('Esto eliminará tu cuenta, tus avisos, tus fotos y tus mensajes de forma permanente. ¿Continuar?')) return;
  try {
    await api('/api/auth/me', { method: 'DELETE' });
    toast('Cuenta eliminada.');
    logout();
  } catch (ex) { toast(ex.message); }
});

/* ============ Tabs ============ */
document.querySelectorAll('nav.tabs button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('nav.tabs button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    document.getElementById('view-' + btn.dataset.tab).classList.add('active');
    if (btn.dataset.tab === 'home') { setTimeout(() => listMap && listMap.invalidateSize(), 50); renderList().then(renderListMap).catch(() => {}); }
    if (btn.dataset.tab === 'found') { asegurarPicker('found'); }
    if (btn.dataset.tab === 'lost') { asegurarPicker('lost'); }
    if (btn.dataset.tab === 'chats') { cerrarConversacion(); renderThreads(); }
    if (btn.dataset.tab === 'inbox') { renderInbox(); }
  });
});

/* ============ Geolocalización ============ */
function locateUser() {
  const chip = document.getElementById('loc-chip');
  if (!navigator.geolocation) { chip.textContent = '📍 Santiago (ubicación manual)'; return; }
  navigator.geolocation.getCurrentPosition(pos => {
    userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    chip.textContent = '📍 Ubicación detectada';
    [mapFound, mapLost].forEach(m => m && m.setView([userLoc.lat, userLoc.lng], 15));
    if (markerFound) { markerFound.setLatLng([userLoc.lat, userLoc.lng]); pickedLoc.found = { ...userLoc }; }
    if (markerLost) { markerLost.setLatLng([userLoc.lat, userLoc.lng]); pickedLoc.lost = { ...userLoc }; }
    if (listMap) listMap.setView([userLoc.lat, userLoc.lng], 13);
  }, () => { chip.textContent = '📍 Santiago (toca el mapa para ajustar)'; }, { timeout: 6000 });
}

function initPicker(elId, key) {
  const map = L.map(elId, { zoomControl: true }).setView([userLoc.lat, userLoc.lng], 14);
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { attribution: '© Esri', maxZoom: 19 }).addTo(map);
  const marker = L.marker([userLoc.lat, userLoc.lng], { draggable: true }).addTo(map);
  pickedLoc[key] = { ...userLoc };
  marker.on('dragend', () => { const p = marker.getLatLng(); pickedLoc[key] = { lat: p.lat, lng: p.lng }; });
  map.on('click', e => { marker.setLatLng(e.latlng); pickedLoc[key] = { lat: e.latlng.lat, lng: e.latlng.lng }; });
  return { map, marker };
}

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
    } catch (e) { toast('No se pudo procesar la foto.'); }
  });
}
// Cambia el contenido visible de la zona sin tocar el <input>, para no perder
// (ni duplicar) los listeners que ya están conectados.
function mostrarPreviewFoto(zone, input, url) {
  Array.from(zone.children).forEach(ch => { if (ch !== input) ch.remove(); });
  const img = document.createElement('img');
  img.src = url; img.alt = 'Foto del animal';
  zone.appendChild(img);
}
function limpiarZonaFoto(zone, input) {
  Array.from(zone.children).forEach(ch => { if (ch !== input) ch.remove(); });
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
  if (matches.length === 0) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="match-banner">
    <h3>🐾 ${matches.length} posible${matches.length > 1 ? 's' : ''} coincidencia${matches.length > 1 ? 's' : ''} cerca</h3>
    <p>Mismo tipo de animal, color parecido y a menos de 5 km. Ábrelo desde "Mapa" para contactar dentro de la app.</p>
    ${matches.map(m => `<div class="match-item">${TIPO_ICON[m.tipo] || '🐾'} ${esc(m.color)} · ${esc(m.distancia_km)} km</div>`).join('')}
  </div>`;
}
async function handleSubmit(estado, key) {
  const get = id => document.getElementById(id + '-' + key).value.trim();
  const tipo = get('tipo'), sexo = get('sexo'), color = get('color'), raza = get('raza'),
        collar = get('collar'), desc = get('desc'), nombre = key === 'lost' ? get('nombre') : '';
  if (!tipo || !color) { toast('Completa los campos obligatorios (*).'); return; }

  const loc = pickedLoc[key] || userLoc;
  const btn = document.querySelector(`#form-${key} .submit-btn`);
  btn.disabled = true; btn.textContent = 'Publicando…';

  try {
    const fd = new FormData();
    fd.append('estado', estado); fd.append('tipo', tipo); fd.append('sexo', sexo);
    fd.append('color', color); fd.append('raza', raza); fd.append('collar', collar);
    fd.append('descripcion', desc); fd.append('nombre_mascota', nombre);
    fd.append('lat', loc.lat); fd.append('lng', loc.lng);
    if (photoFile[key]) fd.append('foto', photoFile[key], 'foto.jpg');

    const { report } = await api('/api/reports', { method: 'POST', isForm: true, body: fd });
    toast('¡Aviso publicado!');
    resetForm(key);
    try {
      const { matches } = await api(`/api/reports/${report.id}/matches`, { auth: false });
      renderMatchBanner('match-area-' + key, matches);
    } catch (e) { /* el aviso ya se publicó; las coincidencias son un extra */ }
    renderList().then(renderListMap).catch(() => {});
  } catch (ex) {
    toast(ex.message);
  } finally {
    btn.disabled = false;
    btn.textContent = estado === 'encontrado' ? 'Publicar aviso de animal encontrado' : 'Publicar aviso de mascota perdida';
  }
}
document.getElementById('form-found').addEventListener('submit', e => { e.preventDefault(); handleSubmit('encontrado', 'found'); });
document.getElementById('form-lost').addEventListener('submit', e => { e.preventDefault(); handleSubmit('perdido', 'lost'); });

/* ============ Home: lista y mapa ============ */
async function fetchReports() {
  const tipo = document.getElementById('filter-tipo').value;
  const estado = document.getElementById('filter-estado').value;
  const qs = new URLSearchParams(); if (tipo) qs.set('tipo', tipo); if (estado) qs.set('estado', estado);
  const { reports } = await api('/api/reports?' + qs.toString(), { auth: false });
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
        <div class="report-meta">${r.sexo !== 'desconocido' ? ({ macho: 'Macho', hembra: 'Hembra' })[r.sexo] + ' · ' : ''}${r.collar ? 'Collar ' + esc(r.collar) + ' · ' : ''}${timeAgo(r.created_at)}</div>
        ${r.descripcion ? `<div class="report-meta">${esc(r.descripcion)}</div>` : ''}
        <div class="report-actions">
          <button data-action="matches" data-id="${esc(r.id)}">Coincidencias</button>
          <button data-action="contact" data-id="${esc(r.id)}">Contactar</button>
          <button data-action="share" data-id="${esc(r.id)}">Compartir</button>
          <button data-action="flag" data-id="${esc(r.id)}">Reportar</button>
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
  if (box.style.display === 'block') { box.style.display = 'none'; return; }
  box.style.display = 'block';
  box.innerHTML = '<span class="none">Buscando…</span>';
  try {
    const { matches } = await api(`/api/reports/${id}/matches`, { auth: false });
    box.innerHTML = matches.length
      ? matches.map(m => `<div>${TIPO_ICON[m.tipo] || '🐾'} ${esc(m.color)} · ${esc(m.distancia_km)} km</div>`).join('')
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
      () => resolve(null), { timeout: 6000 }
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
    if (loc) { body.lat = loc.lat; body.lng = loc.lng; }
  }
  try {
    await api(`/api/reports/${id}/messages`, { method: 'POST', body });
    toast('Mensaje enviado. Lo verás en "Chats".');
    ta.value = '';
    document.getElementById('contact-' + id).classList.add('hidden');
    actualizarBadgeChats();
  } catch (ex) { toast(ex.message); }
}
async function shareReport(id) {
  const url = location.origin + '/?r=' + id;
  const shareData = { title: 'Rastro', text: 'Mira este aviso de mascota en Rastro', url };
  if (navigator.share) {
    try { await navigator.share(shareData); } catch (e) { /* cancelado */ }
  } else {
    try { await navigator.clipboard.writeText(url); toast('Enlace copiado.'); } catch (e) { toast(url); }
  }
}
async function flagReport(id) {
  if (!confirm('¿Reportar este aviso como inapropiado?')) return;
  try { const r = await api(`/api/reports/${id}/flag`, { method: 'POST' }); toast(r.message); }
  catch (ex) { toast(ex.message); }
}

document.getElementById('reports-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]'); if (!btn) return;
  const id = btn.dataset.id;
  switch (btn.dataset.action) {
    case 'matches': toggleMatches(id); break;
    case 'contact': toggleContact(id); break;
    case 'send': sendContact(id); break;
    case 'share': shareReport(id); break;
    case 'flag': flagReport(id); break;
  }
});

async function renderListMap() {
  if (!listMap) {
    listMap = L.map('list-map').setView([userLoc.lat, userLoc.lng], 12);
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', { attribution: '© Esri', maxZoom: 19 }).addTo(listMap);
    clusterGroup = L.markerClusterGroup();
    listMap.addLayer(clusterGroup);
    setTimeout(() => listMap.invalidateSize(), 200);
  }
  clusterGroup.clearLayers();
  allReports.forEach(r => {
    const color = r.estado === 'perdido' ? '#D98A2B' : '#3F8361';
    const marker = L.circleMarker([r.lat, r.lng], { radius: 9, fillColor: color, fillOpacity: 0.9, color: '#fff', weight: 2 });
    marker.bindPopup(`<b>${TIPO_ICON[r.tipo] || '🐾'} ${esc(r.color)}</b><br>${r.estado === 'perdido' ? 'Perdido' : 'Encontrado'} · ${timeAgo(r.created_at)}`);
    clusterGroup.addLayer(marker);
  });
}

document.getElementById('filter-tipo').addEventListener('change', () => { renderList().then(renderListMap); });
document.getElementById('filter-estado').addEventListener('change', () => { renderList().then(renderListMap); });
document.getElementById('btn-refresh').addEventListener('click', async () => { await renderList(); await renderListMap(); toast('Lista actualizada.'); });
document.getElementById('btn-view-map').addEventListener('click', () => {
  document.getElementById('btn-view-map').classList.add('active');
  document.getElementById('btn-view-list').classList.remove('active');
  document.getElementById('list-map').style.display = 'block';
  document.getElementById('reports-list').style.display = 'block';
  setTimeout(() => listMap && listMap.invalidateSize(), 50);
});
document.getElementById('btn-view-list').addEventListener('click', () => {
  document.getElementById('btn-view-list').classList.add('active');
  document.getElementById('btn-view-map').classList.remove('active');
  document.getElementById('list-map').style.display = 'none';
});

/* ============ Chats ============ */
function actualizarBadgeChats() {
  api('/api/reports/threads').then(({ threads }) => {
    const total = threads.reduce((s, t) => s + t.unread, 0);
    const b = document.getElementById('badge-chats');
    if (total > 0) { b.textContent = total; b.classList.remove('hidden'); }
    else b.classList.add('hidden');
  }).catch(() => {});
}
async function renderThreads() {
  const el = document.getElementById('threads-list');
  el.innerHTML = '<div class="empty-state">Cargando…</div>';
  try {
    const { threads } = await api('/api/reports/threads');
    const total = threads.reduce((s, t) => s + t.unread, 0);
    const b = document.getElementById('badge-chats');
    if (total > 0) { b.textContent = total; b.classList.remove('hidden'); } else b.classList.add('hidden');
    if (threads.length === 0) {
      el.innerHTML = `<div class="empty-state"><div class="big">💬</div>No tienes conversaciones todavía.<br>Escribe desde el mapa para contactar a alguien.</div>`;
      return;
    }
    el.innerHTML = threads.map(t => `
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
      </div>`).join('');
  } catch (ex) {
    el.innerHTML = `<p class="loc-note">${esc(ex.message)}</p>`;
  }
}
document.getElementById('threads-list').addEventListener('click', e => {
  const t = e.target.closest('[data-action="open"]'); if (!t) return;
  openConversation(t.dataset.report, t.dataset.peer, t.dataset.mio === 'true');
});

async function openConversation(reportId, peerId, esMio) {
  currentConv.reportId = reportId; currentConv.peerId = peerId; currentConv.esMio = esMio;
  document.getElementById('threads-list').classList.add('hidden');
  document.getElementById('conversation').classList.remove('hidden');
  await loadConversation();
  if (currentConv.poll) clearInterval(currentConv.poll);
  currentConv.poll = setInterval(loadConversation, 15000);
}
function cerrarConversacion() {
  if (currentConv.poll) { clearInterval(currentConv.poll); currentConv.poll = null; }
  currentConv.reportId = null; currentConv.peerId = null;
  document.getElementById('conversation').classList.add('hidden');
  document.getElementById('threads-list').classList.remove('hidden');
}
document.getElementById('btn-conv-back').addEventListener('click', () => { cerrarConversacion(); renderThreads(); });

async function loadConversation() {
  if (!currentConv.reportId || !currentConv.peerId) return;
  const box = document.getElementById('conv-msgs');
  try {
    const data = await api(`/api/reports/${currentConv.reportId}/threads/${currentConv.peerId}`);
    document.getElementById('conv-title').textContent = `${data.peer_label} · ${TIPO_ICON[data.tipo] || '🐾'} ${data.color}`;
    box.innerHTML = data.messages.length
      ? data.messages.map(m => `
        <div class="msg ${m.mio ? 'mine' : 'theirs'}">
          <div class="msg-text">${esc(m.mensaje)}</div>
          ${m.lat !== null ? `<a class="msg-loc" href="https://www.openstreetmap.org/?mlat=${m.lat}&mlon=${m.lng}#map=16/${m.lat}/${m.lng}" target="_blank" rel="noopener">📍 ubicación compartida</a>` : ''}
          <div class="when">${timeAgo(m.created_at)}</div>
        </div>`).join('')
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
    if (loc) { body.lat = loc.lat; body.lng = loc.lng; }
  }
  try {
    await api(`/api/reports/${currentConv.reportId}/messages`, { method: 'POST', body });
    ta.value = '';
    document.getElementById('conv-attach-loc').checked = false;
    await loadConversation();
  } catch (ex) { toast(ex.message); }
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
    el.innerHTML = reports.map(r => `
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
          <button data-action="share" data-id="${esc(r.id)}">Compartir</button>
          <button data-action="delete" data-id="${esc(r.id)}">Eliminar</button>
        </div>
      </div>`).join('');
  } catch (ex) { el.innerHTML = `<p class="loc-note">${esc(ex.message)}</p>`; }
}
document.getElementById('inbox-list').addEventListener('click', async e => {
  const btn = e.target.closest('[data-action]'); if (!btn) return;
  const id = btn.dataset.id;
  const action = btn.dataset.action;
  if (action === 'share') return shareReport(id);
  if (action === 'resolve') {
    try {
      const r = await api(`/api/reports/${id}/resolve`, { method: 'POST', body: { resolved: btn.dataset.resolved === 'true' } });
      toast(r.resolved ? 'Aviso marcado como resuelto.' : 'Aviso reabierto.');
      renderInbox();
    } catch (ex) { toast(ex.message); }
  }
  if (action === 'delete') {
    if (!confirm('¿Eliminar este aviso? Se borrará su foto de forma permanente.')) return;
    try { await api(`/api/reports/${id}`, { method: 'DELETE' }); toast('Aviso eliminado.'); renderInbox(); renderList().then(renderListMap).catch(() => {}); }
    catch (ex) { toast(ex.message); }
  }
  if (action === 'edit') {
    const r = myReports.find(x => x.id === id); if (!r) return;
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
document.getElementById('btn-edit-cancel').addEventListener('click', () => document.getElementById('edit-modal').classList.add('hidden'));
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
    renderInbox(); renderList().then(renderListMap).catch(() => {});
  } catch (ex) { toast(ex.message); }
});

/* ============ Notificaciones push ============ */
async function actualizarBotonPush() {
  const btn = document.getElementById('btn-push');
  if (!config.pushEnabled || !('serviceWorker' in navigator) || !('PushManager' in window)) { btn.classList.add('hidden'); return; }
  btn.classList.remove('hidden');
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    btn.classList.toggle('active', !!sub);
    btn.title = sub ? 'Notificaciones activadas (toca para desactivar)' : 'Activar notificaciones';
  } catch (e) { /* ignore */ }
}
document.getElementById('btn-push').addEventListener('click', async () => {
  if (!config.pushEnabled) return toast('Notificaciones no configuradas en el servidor.');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return toast('Este dispositivo no soporta notificaciones.');
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
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(config.vapidPublicKey) });
      await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
      toast('Notificaciones activadas.');
    }
    actualizarBotonPush();
  } catch (ex) { toast(ex.message || 'No se pudieron cambiar las notificaciones.'); }
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
    if (key === 'found') { mapFound = p.map; markerFound = p.marker; }
    else { mapLost = p.map; markerLost = p.marker; }
    pickersIniciados[key] = true;
  }
  const m = key === 'found' ? mapFound : mapLost;
  setTimeout(() => m && m.invalidateSize(), 80);
}
function startApp() {
  if (!appIniciada) {
    initPhotoZone('photo-zone-found', 'photo-input-found', 'found');
    initPhotoZone('photo-zone-lost', 'photo-input-lost', 'lost');
    appIniciada = true;
  }
  locateUser();
  renderList().then(renderListMap).then(() => abrirDeepLink()).catch(() => {});
  actualizarBadgeChats();
  actualizarBotonPush();
}

function abrirDeepLink() {
  const rid = new URLSearchParams(location.search).get('r');
  if (!rid) return;
  const card = document.querySelector(`.report-card[data-id="${rid}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.style.outline = '3px solid var(--rust)';
    setTimeout(() => { card.style.outline = ''; }, 3000);
  }
}

/* ============ Bootstrap ============ */
(async function bootstrap() {
  await loadConfig();

  const params = new URLSearchParams(location.search);
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
    } catch (e) { /* token inválido: volvemos al login */ token = null; localStorage.removeItem('rastro_token'); }
  }
  showAuth();
})();

window.toggleMatches = toggleMatches;
window.toggleContact = toggleContact;
window.sendContact = sendContact;
