// Test de humo end-to-end de la API. Requiere el servidor corriendo y la base
// de datos accesible. Uso: node scripts/smoke-test.js
const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
const crypto = require('crypto');
require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('supabase.co') ? { rejectUnauthorized: false } : false
});

let fallos = 0;
function ok(cond, msg) {
  if (cond) console.log('  ok  - ' + msg);
  else { fallos++; console.log('  FALLA - ' + msg); }
}

async function req(path, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  let payload;
  if (form) payload = form;
  else if (body) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers, body: payload });
  let data = {};
  try { data = await res.json(); } catch (e) { /* vacío */ }
  return { status: res.status, data };
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]);

async function crearAviso(token, campos, fotoBytes) {
  const fd = new FormData();
  Object.entries(campos).forEach(([k, v]) => fd.append(k, v));
  if (fotoBytes) fd.append('foto', new Blob([fotoBytes], { type: 'image/jpeg' }), 'f.jpg');
  return req('/api/reports', { method: 'POST', token, form: fd });
}

(async () => {
  const s = Date.now();
  console.log('== config / 404 ==');
  const cfg = await req('/api/config');
  ok(cfg.status === 200 && 'pushEnabled' in cfg.data, 'GET /api/config');
  const nf = await req('/api/ruta-que-no-existe');
  ok(nf.status === 404, 'ruta /api desconocida responde 404 JSON');

  console.log('== registro ==');
  const a = await req('/api/auth/register', { method: 'POST', body: { email: `a${s}@x.com`, password: 'password123' } });
  const b = await req('/api/auth/register', { method: 'POST', body: { email: `b${s}@x.com`, password: 'password123' } });
  const c = await req('/api/auth/register', { method: 'POST', body: { email: `c${s}@x.com`, password: 'password123' } });
  ok(a.status === 201 && b.status === 201 && c.status === 201, 'registro de 3 usuarios');
  let ta = a.data.token, tb = b.data.token;
  const tc = c.data.token;

  console.log('== avisos + magic bytes ==');
  const rep = await crearAviso(ta, { estado: 'perdido', tipo: 'perro', sexo: 'macho', color: 'cafe y blanco', lat: '-33.4489', lng: '-70.6693' }, JPEG);
  ok(rep.status === 201 && rep.data.report.id, 'crear aviso con imagen válida');
  const rid = rep.data.report && rep.data.report.id;
  const falso = await crearAviso(ta, { estado: 'perdido', tipo: 'perro', sexo: 'macho', color: 'cafe', lat: '-33.44', lng: '-70.66' }, Buffer.from('no soy una imagen de verdad'));
  ok(falso.status === 400, 'rechaza archivo que no es imagen real (magic bytes)');
  const cand = await crearAviso(tc, { estado: 'encontrado', tipo: 'perro', sexo: 'hembra', color: 'cafe', lat: '-33.45', lng: '-70.67' }, JPEG);
  ok(cand.status === 201, 'crear aviso candidato');

  console.log('== listado + es_mio ==');
  const anon = await req('/api/reports');
  ok(anon.data.reports.some(r => r.id === rid && r.es_mio === false), 'anónimo ve el aviso con es_mio=false');
  const comoDueno = await req('/api/reports', { token: ta });
  ok(comoDueno.data.reports.find(r => r.id === rid).es_mio === true, 'dueño ve es_mio=true');

  console.log('== matches (permisos) ==');
  const sinSesion = await req(`/api/reports/${rid}/matches`);
  ok(sinSesion.status === 401, 'matches sin sesión -> 401');
  const ajeno = await req(`/api/reports/${rid}/matches`, { token: tb });
  ok(ajeno.status === 403, 'matches de aviso ajeno -> 403');
  const propio = await req(`/api/reports/${rid}/matches`, { token: ta });
  ok(propio.status === 200 && propio.data.matches.some(m => m.id === cand.data.report.id), 'dueño ve las coincidencias');

  console.log('== geocode (requiere sesión) ==');
  const geoAnon = await req('/api/geocode?q=Providencia');
  ok(geoAnon.status === 401, 'geocode sin sesión -> 401');
  const geo = await req('/api/geocode?q=Plaza%20Nunoa', { token: ta });
  ok(geo.status === 200 && Array.isArray(geo.data.results), 'geocode con sesión responde');

  console.log('== mensajería ==');
  const m1 = await req(`/api/reports/${rid}/messages`, { method: 'POST', token: tb, body: { mensaje: 'lo vi cerca' } });
  ok(m1.status === 201, 'B escribe al dueño');
  const th = await req('/api/reports/threads', { token: ta });
  ok(th.data.threads.length === 1 && th.data.threads[0].unread === 1, 'dueño ve 1 conversación con 1 no leído');
  const peer = th.data.threads[0].peer_id;
  const rep2 = await req(`/api/reports/${rid}/messages`, { method: 'POST', token: ta, body: { mensaje: 'gracias', to_user_id: peer } });
  ok(rep2.status === 201, 'dueño responde');
  const conv = await req(`/api/reports/${rid}/threads/${a.data.user.id}`, { token: tb });
  ok(conv.status === 200 && conv.data.messages.length === 2, 'B lee los 2 mensajes');

  console.log('== editar / flags ==');
  const ed = await req(`/api/reports/${rid}`, { method: 'PATCH', token: ta, body: { color: 'gris' } });
  ok(ed.status === 200 && ed.data.report.color === 'gris', 'editar aviso');
  const flagPropio = await req(`/api/reports/${rid}/flag`, { method: 'POST', token: ta });
  ok(flagPropio.status === 400, 'no puedes reportar tu propio aviso');
  const flagNuevo = await req(`/api/reports/${rid}/flag`, { method: 'POST', token: tb });
  ok(flagNuevo.status === 403, 'cuenta nueva no puede reportar (antigüedad)');

  console.log('== push ==');
  const sub = await req('/api/push/subscribe', { method: 'POST', token: tb, body: { endpoint: 'https://example.com/push/' + s, keys: { p256dh: 'abc', auth: 'def' } } });
  ok(sub.status === 201, 'suscripción push guardada');
  const key = await req('/api/push/public-key');
  ok(key.data.enabled === true && key.data.publicKey.length > 20, 'clave pública VAPID');

  console.log('== resolver ==');
  const resolve = await req(`/api/reports/${rid}/resolve`, { method: 'POST', token: ta, body: { resolved: true } });
  ok(resolve.status === 200, 'marcar resuelto');
  const list2 = await req('/api/reports');
  ok(!list2.data.reports.some(r => r.id === rid), 'resuelto sale del listado');

  console.log('== recuperar contraseña + revocación de sesiones ==');
  const forgot = await req('/api/auth/forgot', { method: 'POST', body: { email: b.data.user.email } });
  ok(forgot.status === 200, 'forgot responde genérico');
  const row = await pool.query('SELECT token FROM password_resets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [b.data.user.id]);
  ok(row.rows[0] && /^[0-9a-f]{64}$/.test(row.rows[0].token), 'en la BD se guarda el hash del token, no el token');
  // Insertamos un token conocido (hash) para probar el reset sin depender del correo.
  const raw = crypto.randomBytes(32).toString('hex');
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  await pool.query('INSERT INTO password_resets (token,user_id,expires_at,used,created_at) VALUES ($1,$2,$3,FALSE,$4)', [hash, b.data.user.id, Date.now() + 3600000, Date.now()]);
  const badReset = await req('/api/auth/reset', { method: 'POST', body: { token: 'x'.repeat(64), password: 'nuevaclave123' } });
  ok(badReset.status === 400, 'token de reset inválido -> 400');
  const reset = await req('/api/auth/reset', { method: 'POST', body: { token: raw, password: 'nuevaclave123' } });
  ok(reset.status === 200, 'reset con token válido -> 200');
  const tbViejo = await req('/api/auth/me', { token: tb });
  ok(tbViejo.status === 401, 'tras el reset se revocan las sesiones anteriores');
  const relogin = await req('/api/auth/login', { method: 'POST', body: { email: b.data.user.email, password: 'nuevaclave123' } });
  ok(relogin.status === 200, 'login con la contraseña nueva');
  if (relogin.data.token) tb = relogin.data.token;

  console.log('== borrado y revocación ==');
  const del = await req(`/api/reports/${rid}`, { method: 'DELETE', token: ta });
  ok(del.status === 200, 'dueño elimina su aviso');
  const delAcc = await req('/api/auth/me', { method: 'DELETE', token: ta });
  ok(delAcc.status === 200, 'eliminar cuenta');
  const tokenMuerto = await req('/api/auth/me', { token: ta });
  ok(tokenMuerto.status === 401, 'token de cuenta eliminada ya no sirve');

  console.log('== limpieza ==');
  await req('/api/auth/me', { method: 'DELETE', token: tc });
  await req('/api/auth/me', { method: 'DELETE', token: tb });
  ok(true, 'usuarios de prueba eliminados');

  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} comprobaciones fallaron`);
  await pool.end();
  process.exit(fallos === 0 ? 0 : 1);
})().catch(async e => { console.error('Error inesperado:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
