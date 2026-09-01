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
    const data = await api('/api/auth/login', { auth:false, body:{
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
    const data = await api('/api/auth/register', { auth:false, body:{
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
    if(btn.dataset.tab==='home'){ setTimeout(()=> listMap && listMap.invalidateSize(),50); renderList(); }
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
      const url = URL.createObjectURL(blob);
      zone.innerHTML = `<img src="${url}" alt="Foto del animal">`;
      zone.appendChild(input);
    }catch(e){ toast('No se pudo procesar la foto.'); }
  });
}

/* ============ Publicar aviso ============ */
function resetForm(key){
  document.getElementById('form-'+key).reset();
  photoFile[key] = null;
  const zone = document.getElementById('photo-zone-'+key);
  zone.innerHTML = `<div class="hint"><b>📷</b>Toca para tomar o subir una foto</div><input type="file" accept="image/*" capture="environment" id="photo-input-${key}">`;
  initPhotoZone('photo-zone-'+key, 'photo-input-'+key, key);
}

function renderMatchBanner(containerId, matches){
  const el = document.getElementById(containerId);
  if(matches.length===0){ el.innerHTML=''; return; }
  el.innerHTML = `<div class="match-banner">
    <h3>🐾 ${matches.length} posible${matches.length>1?'s':''} coincidencia${matches.length>1?'s':''} cerca</h3>
    <p>Mismo tipo de animal, color parecido y a menos de 5 km. Ábrelo desde "Mapa" para contactar dentro de la app.</p>
    ${matches.map(m=>`<div class="match-item">${TIPO_ICON[m.tipo]} ${m.color} · ${m.distancia_km} km</div>`).join('')}
  </div>`;
}

async function handleSubmit(estado, key){
  const get = id => document.getElementById(id+'-'+key).value.trim();
  const tipo = get('tipo'), sexo = get('sexo'), color = get('color'), raza = get('raza'),
        collar = get('collar'), desc = get('desc'), nombre = key==='lost' ? get('nombre') : '';
  if(!tipo || !color){ toast('Completa los campos obligatorios (*).'); return; }

  const loc = pickedLoc[key] || userLoc;
  const btn = document.querySelector(`#form-${key} .submit-btn`);
  btn.disabled = true; btn.textContent = 'Publicando…';

  try{
    const fd = new FormData();
    fd.append('estado', estado); fd.append('tipo', tipo); fd.append('sexo', sexo);
    fd.append('color', color); fd.append('raza', raza); fd.append('collar', collar);
    fd.append('descripcion', desc); fd.append('nombre_mascota', nombre);
    fd.append('lat', loc.lat); fd.append('lng', loc.lng);
    if(photoFile[key]) fd.append('foto', photoFile[key], 'foto.jpg');

    const { report } = await api('/api/reports', { method:'POST', isForm:true, body: fd });
    toast('¡Aviso publicado!');
    const { matches } = await api(`/api/reports/${report.id}/matches`, { auth:false });
    renderMatchBanner('match-area-'+key, matches);
    resetForm(key);
    renderList(); renderListMap();
  }catch(ex){
    toast(ex.message);
  }finally{
    btn.disabled = false;
    btn.textContent = estado==='encontrado' ? 'Publicar aviso de animal encontrado' : 'Publicar aviso de mascota perdida';
  }
}
document.getElementById('form-found').addEventListener('submit', e=>{ e.preventDefault(); handleSubmit('encontrado','found'); });
document.getElementById('form-lost').addEventListener('submit', e=>{ e.preventDefault(); handleSubmit('perdido','lost'); });

/* ============ Home: lista y mapa ============ */
let allReports = [];
async function fetchReports(){
  const tipo = document.getElementById('filter-tipo').value;
  const estado = document.getElementById('filter-estado').value;
  const qs = new URLSearchParams(); if(tipo) qs.set('tipo',tipo); if(estado) qs.set('estado',estado);
  const { reports } = await api('/api/reports?'+qs.toString(), { auth:false });
  allReports = reports.sort((a,b)=>b.created_at-a.created_at);
}

async function renderList(){
  await fetchReports();
  const el = document.getElementById('reports-list');
  if(allReports.length===0){
    el.innerHTML = `<div class="empty-state"><div class="big">🐾</div>Todavía no hay avisos.<br>Publica el primero desde las pestañas de arriba.</div>`;
    return;
  }
  el.innerHTML = allReports.map(r=>`
    <div class="report-card ${r.estado==='perdido'?'lost':''}" data-id="${r.id}">
      ${r.foto_url ? `<img src="${API_BASE}${r.foto_url}" alt="">` : `<div class="ph-placeholder">${TIPO_ICON[r.tipo]}</div>`}
      <div class="report-body">
        <div class="report-top">
          <h4>${TIPO_ICON[r.tipo]} ${r.color}${r.raza ? ' · '+r.raza : ''}</h4>
          <span class="tag ${r.estado==='perdido'?'lost':'found'}">${r.estado==='perdido'?'Perdido':'Encontrado'}</span>
        </div>
        <div class="report-meta">${r.sexo!=='desconocido'?({macho:'Macho',hembra:'Hembra'})[r.sexo]+' · ':''}${r.collar?'Collar '+r.collar+' · ':''}${timeAgo(r.created_at)}</div>
        <div class="report-actions">
          <button onclick="toggleMatches('${r.id}')">Ver coincidencias</button>
          <button onclick="toggleContact('${r.id}')">Contactar</button>
        </div>
        <div class="matches-box" id="matches-${r.id}" style="display:none;"></div>
        <div class="contact-box hidden" id="contact-${r.id}">
          <textarea id="contact-text-${r.id}" placeholder="Escribe un mensaje para quien publicó este aviso…"></textarea>
          <button onclick="sendContact('${r.id}')">Enviar mensaje</button>
        </div>
      </div>
    </div>
  `).join('');
}

window.toggleMatches = async function(id){
  const box = document.getElementById('matches-'+id);
  if(box.style.display==='block'){ box.style.display='none'; return; }
  const { matches } = await api(`/api/reports/${id}/matches`, { auth:false });
  box.innerHTML = matches.length
    ? matches.map(m=>`<div>${TIPO_ICON[m.tipo]} ${m.color} · ${m.distancia_km} km</div>`).join('')
    : `<span class="none">Sin coincidencias por ahora.</span>`;
  box.style.display='block';
};
window.toggleContact = function(id){
  document.getElementById('contact-'+id).classList.toggle('hidden');
};
window.sendContact = async function(id){
  const ta = document.getElementById('contact-text-'+id);
  if(!ta.value.trim()) return;
  try{
    await api(`/api/reports/${id}/messages`, { method:'POST', body:{ mensaje: ta.value.trim() } });
    toast('Mensaje enviado. Solo lo verá la persona que publicó el aviso.');
    ta.value=''; document.getElementById('contact-'+id).classList.add('hidden');
  }catch(ex){ toast(ex.message); }
};

async function renderListMap(){
  if(!listMap){
    listMap = L.map('list-map').setView([userLoc.lat,userLoc.lng], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OpenStreetMap', maxZoom:19 }).addTo(listMap);
    listMarkersLayer = L.layerGroup().addTo(listMap);
  }
  listMarkersLayer.clearLayers();
  allReports.forEach(r=>{
    const color = r.estado==='perdido' ? '#D98A2B' : '#3F8361';
    const marker = L.circleMarker([r.lat, r.lng], { radius:9, fillColor:color, fillOpacity:0.9, color:'#fff', weight:2 }).addTo(listMarkersLayer);
    marker.bindPopup(`<b>${TIPO_ICON[r.tipo]} ${r.color}</b><br>${r.estado==='perdido'?'Perdido':'Encontrado'} · ${timeAgo(r.created_at)}`);
  });
}

document.getElementById('filter-tipo').addEventListener('change', ()=>{ renderList().then(renderListMap); });
document.getElementById('filter-estado').addEventListener('change', ()=>{ renderList().then(renderListMap); });
document.getElementById('btn-refresh').addEventListener('click', async ()=>{ await renderList(); await renderListMap(); toast('Lista actualizada.'); });
document.getElementById('btn-view-map').addEventListener('click', ()=>{
  document.getElementById('btn-view-map').classList.add('active');
  document.getElementById('btn-view-list').classList.remove('active');
  document.getElementById('list-map').style.display='block';
  document.getElementById('reports-list').style.display='block';
  setTimeout(()=>listMap && listMap.invalidateSize(),50);
});
document.getElementById('btn-view-list').addEventListener('click', ()=>{
  document.getElementById('btn-view-list').classList.add('active');
  document.getElementById('btn-view-map').classList.remove('active');
  document.getElementById('list-map').style.display='none';
});

/* ============ Mis avisos / inbox ============ */
async function renderInbox(){
  const el = document.getElementById('inbox-list');
  try{
    const { reports } = await api('/api/reports/mine/all');
    if(reports.length===0){ el.innerHTML = `<div class="empty-state"><div class="big">📭</div>Todavía no has publicado avisos.</div>`; return; }
    el.innerHTML = reports.map(r=>`
      <div class="inbox-item">
        <h4>${TIPO_ICON[r.tipo]} ${r.color} · ${r.estado==='perdido'?'Perdido':'Encontrado'}</h4>
        <div class="report-meta">Publicado ${timeAgo(r.created_at)}</div>
        ${r.mensajes.length===0
          ? `<p class="loc-note">Sin mensajes todavía.</p>`
          : r.mensajes.map(m=>`<div class="msg">${m.mensaje}<div class="when">${timeAgo(m.created_at)}</div></div>`).join('')}
      </div>
    `).join('');
  }catch(ex){ el.innerHTML = `<p class="loc-note">${ex.message}</p>`; }
}

/* ============ Arranque ============ */
function startApp(){
  initPhotoZone('photo-zone-found','photo-input-found','found');
  initPhotoZone('photo-zone-lost','photo-input-lost','lost');
  const pf = initPicker('map-found','found'); mapFound = pf.map; markerFound = pf.marker;
  const pl = initPicker('map-lost','lost'); mapLost = pl.map; markerLost = pl.marker;
  locateUser();
  renderList().then(renderListMap);
}

if(token){
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  startApp();
}
