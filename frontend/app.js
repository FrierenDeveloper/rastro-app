// Registrar el service worker ANTES que cualquier otro código: si algo más
// abajo en este archivo llegara a fallar, el registro no debe verse afectado.
if('serviceWorker' in navigator){
  window.addEventListener('load', ()=> navigator.serviceWorker.register('sw.js').catch(()=>{}));
}

// ============ Configuración ============
// Cambia esto por la URL de tu backend cuando lo despliegues (ej: https://api.rastro.cl)
const API_BASE = window.RASTRO_API_BASE || '';

let token = localStorage.getItem('rastro_token') || null;
let userLoc = { lat: -33.4489, lng: -70.6693 }; // Santiago, Chile (fallback)
let photoFile = { found: null, lost: null };
let pickedLoc = { found: null, lost: null };
let listMap, listMarkersLayer, mapFound, mapLost, markerFound, markerLost;

const TIPO_ICON = { perro:'🐕', gato:'🐈', ave:'🐦', conejo:'🐇', otro:'🐾' };

/* ============ Utilidades ============ */
// Escapa el texto que escriben los usuarios antes de mostrarlo, para que
// nadie pueda inyectar código en la página a través de un aviso o mensaje.
function esc(v){
  if(v === null || v === undefined) return '';
  return String(v)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2400);
}
function timeAgo(ts){
  const diff = Date.now()-ts, m=Math.floor(diff/60000), h=Math.floor(m/60), d=Math.floor(h/24);
  if(d>0) return `hace ${d} día${d>1?'s':''}`;
  if(h>0) return `hace ${h} hora${h>1?'s':''}`;
  if(m>0) return `hace ${m} min`;
  return 'recién';
}
function compressImage(file){
  return new Promise((resolve, reject)=>{
    const reader = new FileReader();
    reader.onload = e=>{
      const img = new Image();
      img.onload = ()=>{
        let w=img.width, h=img.height; const max=800;
        if(w>h && w>max){ h=Math.round(h*max/w); w=max; }
        else if(h>=w && h>max){ w=Math.round(w*max/h); h=max; }
        const canvas = document.createElement('canvas');
        canvas.width=w; canvas.height=h;
        canvas.getContext('2d').drawImage(img,0,0,w,h);
        canvas.toBlob(blob=>resolve(blob), 'image/jpeg', 0.75);
      };
      img.onerror = reject;
      img.src = e.target.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
async function api(path, { method='GET', body=null, isForm=false, auth=true } = {}){
  const headers = {};
  if(auth && token) headers['Authorization'] = 'Bearer ' + token;
  if(body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(API_BASE + path, {
    method, headers, body: isForm ? body : (body ? JSON.stringify(body) : undefined)
  });
  let data = {};
  try{ data = await res.json(); }catch(e){ /* respuesta vacía */ }
  if(!res.ok) throw new Error(data.error || 'Ocurrió un error.');
  return data;
}

/* ============ Auth screen ============ */
document.querySelectorAll('.auth-tabs button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.auth-tabs button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.auth-form').forEach(f=>f.classList.remove('active'));
    document.getElementById('form-'+btn.dataset.auth).classList.add('active');
  });
});

document.getElementById('form-login').addEventListener('submit', async e=>{
  e.preventDefault();
  const err = document.getElementById('login-error'); err.classList.remove('show');
  try{
    const data = await api('/api/auth/login', { method:'POST', auth:false, body:{
      email: document.getElementById('login-email').value.trim(),
      password: document.getElementById('login-password').value
    }});
    onAuthSuccess(data.token);
  }catch(ex){ err.textContent = ex.message; err.classList.add('show'); }
});

document.getElementById('form-register').addEventListener('submit', async e=>{
  e.preventDefault();
  const err = document.getElementById('register-error'); err.classList.remove('show');
  try{
    const data = await api('/api/auth/register', { method:'POST', auth:false, body:{
      email: document.getElementById('register-email').value.trim(),
      password: document.getElementById('register-password').value,
      phone: document.getElementById('register-phone').value.trim()
    }});
    onAuthSuccess(data.token);
  }catch(ex){ err.textContent = ex.message; err.classList.add('show'); }
});

function onAuthSuccess(newToken){
  token = newToken;
  localStorage.setItem('rastro_token', token);
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  startApp();
}

document.getElementById('btn-logout').addEventListener('click', ()=>{
  token = null;
  localStorage.removeItem('rastro_token');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('auth-screen').classList.remove('hidden');
});

document.getElementById('btn-delete-account').addEventListener('click', async ()=>{
  if(!confirm('Esto eliminará tu cuenta, tus avisos y tus mensajes de forma permanente. ¿Continuar?')) return;
  try{
    await api('/api/auth/me', { method:'DELETE' });
    toast('Cuenta eliminada.');
    document.getElementById('btn-logout').click();
  }catch(ex){ toast(ex.message); }
});

/* ============ Tabs ============ */
document.querySelectorAll('nav.tabs button').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('nav.tabs button').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
    document.getElementById('view-'+btn.dataset.tab).classList.add('active');
    if(btn.dataset.tab==='home'){ setTimeout(()=> listMap && listMap.invalidateSize(),50); renderList().then(renderListMap).catch(()=>{}); }
    if(btn.dataset.tab==='found'){ setTimeout(()=> mapFound && mapFound.invalidateSize(),50); }
    if(btn.dataset.tab==='lost'){ setTimeout(()=> mapLost && mapLost.invalidateSize(),50); }
    if(btn.dataset.tab==='inbox'){ renderInbox(); }
  });
});

/* ============ Geolocalización ============ */
function locateUser(){
  const chip = document.getElementById('loc-chip');
  if(!navigator.geolocation){ chip.textContent = '📍 Santiago (ubicación manual)'; return; }
  navigator.geolocation.getCurrentPosition(pos=>{
    userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    chip.textContent = '📍 Ubicación detectada';
    [mapFound, mapLost].forEach(m=> m && m.setView([userLoc.lat,userLoc.lng], 15));
    if(markerFound){ markerFound.setLatLng([userLoc.lat,userLoc.lng]); pickedLoc.found = {...userLoc}; }
    if(markerLost){ markerLost.setLatLng([userLoc.lat,userLoc.lng]); pickedLoc.lost = {...userLoc}; }
    if(listMap) listMap.setView([userLoc.lat,userLoc.lng], 13);
  }, ()=>{ chip.textContent = '📍 Santiago (toca el mapa para ajustar)'; }, { timeout: 6000 });
}

function initPicker(elId, key){
  const map = L.map(elId, {zoomControl:true}).setView([userLoc.lat,userLoc.lng], 14);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OpenStreetMap', maxZoom:19 }).addTo(map);
  const marker = L.marker([userLoc.lat,userLoc.lng], {draggable:true}).addTo(map);
  pickedLoc[key] = {...userLoc};
  marker.on('dragend', ()=>{ const p = marker.getLatLng(); pickedLoc[key] = {lat:p.lat,lng:p.lng}; });
  map.on('click', e=>{ marker.setLatLng(e.latlng); pickedLoc[key] = {lat:e.latlng.lat,lng:e.latlng.lng}; });
  return { map, marker };
}

/* ============ Zonas de foto ============ */
function initPhotoZone(zoneId, inputId, key){
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  zone.addEventListener('click', ()=> input.click());
  input.addEventListener('change', async ()=>{
    if(!input.files || !input.files[0]) return;
    try{
      const blob = await compressImage(input.files[0]);
      photoFile[key] = blob;
      mostrarPreviewFoto(zone, input, URL.createObjectURL(blob));
    }catch(e){ toast('No se pudo procesar la foto.'); }
  });
}

// Cambia el contenido visible de la zona sin tocar el <input>, para no perder
// (ni duplicar) los listeners que ya están conectados.
function mostrarPreviewFoto(zone, input, url){
  Array.from(zone.children).forEach(ch => { if(ch !== input) ch.remove(); });
  const img = document.createElement('img');
  img.src = url; img.alt = 'Foto del animal';
  zone.appendChild(img);
}

function limpiarZonaFoto(zone, input){
  Array.from(zone.children).forEach(ch => { if(ch !== input) ch.remove(); });
  const hint = document.createElement('div');
  hint.className = 'hint';
  hint.innerHTML = '<b>📷</b>Toca para tomar o subir una foto';
  zone.appendChild(hint);
}

/* ============ Publicar aviso ============ */
function resetForm(key){
  document.getElementById('form-'+key).reset();
  photoFile[key] = null;
  const zone = document.getElementById('photo-zone-'+key);
  const input = document.getElementById('photo-input-'+key);
  input.value = '';
  limpiarZonaFoto(zone, input);
}

function renderMatchBanner(containerId, matches){
  const el = document.getElementById(containerId);
  if(matches.length===0){ el.innerHTML=''; return; }
  el.innerHTML = `<div class="match-banner">
    <h3>🐾 ${matches.length} posible${matches.length>1?'s':''} coincidencia${matches.length>1?'s':''} cerca</h3>
    <p>Mismo tipo de animal, color parecido y a menos de 5 km. Ábrelo desde "Mapa" para contactar dentro de la app.</p>
    ${matches.map(m=>`<div class="match-item">${TIPO_ICON[m.tipo]||'🐾'} ${esc(m.color)} · ${esc(m.distancia_km)} km</div>`).join('')}
  </div>`;
}

async function handleSubmit(estado, key){
  const get = id => document.getElementById(id+'-'+key).value.trim();
  const tipo = get('tipo'), sexo = get('sexo'), color = get('color'), raza = get('raza'),
        collar = get('collar'), desc = get('desc'), nombre = key==='lost' ? get('nombre') : '';
  if(!tipo || !color){ toast('Completa los campos obligatorios (*).'); return; }

  const loc =
