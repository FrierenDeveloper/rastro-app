// Test de humo end-to-end de la API. Requiere el servidor corriendo y la base
// de datos accesible. Uso: node scripts/smoke-test.js
const BASE = process.env.SMOKE_BASE || 'http://localhost:3000';
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

(async () => {
  const stamp = Date.now();
  console.log('== config ==');
  const cfg = await req('/api/config');
  ok(cfg.status === 200 && 'pushEnabled' in cfg.data, 'GET /api/config');

  console.log('== registro / login ==');
  const owner = await req('/api/auth/register', { method: 'POST', body: { email: `owner${stamp}@x.com`, password: 'password123' } });
  ok(owner.status === 201 && owner.data.token, 'registro dueño');
  const other = await req('/api/auth/register', { method: 'POST', body: { email: `other${stamp}@x.com`, password: 'password123' } });
  ok(other.status === 201 && other.data.token, 'registro interesado');
  const third = await req('/api/auth/register', { method: 'POST', body: { email: `third${stamp}@x.com`, password: 'password123' } });
  ok(third.status === 201 && third.data.token, 'registro forastero');
  const ta = owner.data.token, tb = other.data.token;

  console.log('== crear aviso ==');
  const fd = new FormData();
  fd.append('estado', 'perdido');
  fd.append('tipo', 'perro');
  fd.append('sexo', 'macho');
  fd.append('color', 'cafe y blanco');
  fd.append('descripcion', 'se escapa de casa');
  fd.append('nombre_mascota', 'Firulais');
  fd.append('lat', '-33.4489');
  fd.append('lng', '-70.6693');
  fd.append('foto', new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])], { type: 'image/jpeg' }), 'foto.jpg');
  const created = await req('/api/reports', { method: 'POST', token: ta, form: fd });
  ok(created.status === 201 && created.data.report.id, 'POST /api/reports');
  const rid = created.data.report.id;
  ok(created.data.report.resolved === false, 'aviso nuevo no resuelto');

  console.log('== listado publico ==');
  const list = await req('/api/reports');
  ok(list.data.reports.some(r => r.id === rid), 'el aviso aparece en el listado');

  console.log('== mensajeria bidireccional ==');
  const m1 = await req(`/api/reports/${rid}/messages`, { method: 'POST', token: tb, body: { mensaje: 'creo que lo vi cerca', lat: -33.45, lng: -70.66 } });
  ok(m1.status === 201, 'interesado escribe al dueño');
  const threadsA = await req('/api/reports/threads', { token: ta });
  ok(threadsA.data.threads.length === 1 && threadsA.data.threads[0].unread === 1, 'dueño ve 1 conversacion con 1 no leido');
  const peerB = threadsA.data.threads[0].peer_id;
  const reply = await req(`/api/reports/${rid}/messages`, { method: 'POST', token: ta, body: { mensaje: 'gracias, dime donde', to_user_id: peerB } });
  ok(reply.status === 201, 'dueño responde al interesado');
  const selfMsg = await req(`/api/reports/${rid}/messages`, { method: 'POST', token: ta, body: { mensaje: 'hola', to_user_id: ta } });
  ok(selfMsg.status === 400, 'no se puede responder a un usuario que no escribio');
  const threadB = await req(`/api/reports/${rid}/threads/${owner.data.user.id}`, { token: tb });
  ok(threadB.status === 200 && threadB.data.messages.length === 2, 'interesado lee el hilo (2 mensajes)');
  const foraste = await req(`/api/reports/${rid}/threads/${peerB}`, { token: third.data.token });
  ok(foraste.status === 403, 'un tercero no puede leer una conversacion ajena');

  console.log('== editar ==');
  const edit = await req(`/api/reports/${rid}`, { method: 'PATCH', token: ta, body: { color: 'negro' } });
  ok(edit.status === 200 && edit.data.report.color === 'negro', 'PATCH edita el color');
  const editAjeno = await req(`/api/reports/${rid}`, { method: 'PATCH', token: tb, body: { color: 'rojo' } });
  ok(editAjeno.status === 404, 'no se puede editar aviso ajeno');

  console.log('== flag ==');
  const flag = await req(`/api/reports/${rid}/flag`, { method: 'POST', token: tb });
  ok(flag.status === 200, 'flag registrado');
  const flagPropio = await req(`/api/reports/${rid}/flag`, { method: 'POST', token: ta });
  ok(flagPropio.status === 400, 'no puedes flagear tu propio aviso');

  console.log('== push ==');
  const sub = await req('/api/push/subscribe', { method: 'POST', token: tb, body: { endpoint: 'https://example.com/push/' + stamp, keys: { p256dh: 'abc', auth: 'def' } } });
  ok(sub.status === 201, 'suscripcion push guardada');
  const key = await req('/api/push/public-key');
  ok(key.data.enabled === true && key.data.publicKey.length > 20, 'clave publica VAPID disponible');

  console.log('== resolver ==');
  const noResolve = await req(`/api/reports/${rid}/resolve`, { method: 'POST', token: tb, body: { resolved: true } });
  ok(noResolve.status === 404, 'solo el dueño resuelve');
  const resolve = await req(`/api/reports/${rid}/resolve`, { method: 'POST', token: ta, body: { resolved: true } });
  ok(resolve.status === 200, 'dueño marca resuelto');
  const list2 = await req('/api/reports');
  ok(!list2.data.reports.some(r => r.id === rid), 'aviso resuelto ya no sale en el listado');
  const mine = await req('/api/reports/mine/all', { token: ta });
  ok(mine.data.reports.find(r => r.id === rid).resolved === true, 'mine/all muestra resuelto');

  console.log('== recuperar contraseña ==');
  const forgot = await req('/api/auth/forgot', { method: 'POST', body: { email: other.data.user.email } });
  ok(forgot.status === 200, 'POST /auth/forgot responde genérico');
  const row = await pool.query('SELECT token FROM password_resets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [other.data.user.id]);
  ok(row.rows[0] && row.rows[0].token, 'se creó el token de reseteo');
  const reset = await req('/api/auth/reset', { method: 'POST', body: { token: row.rows[0].token, password: 'nuevaclave123' } });
  ok(reset.status === 200, 'POST /auth/reset funciona');
  const relogin = await req('/api/auth/login', { method: 'POST', body: { email: other.data.user.email, password: 'nuevaclave123' } });
  ok(relogin.status === 200, 'login con la contraseña nueva');
  const reuse = await req('/api/auth/reset', { method: 'POST', body: { token: row.rows[0].token, password: 'otraclave123' } });
  ok(reuse.status === 400, 'el token no se puede reutilizar');

  console.log('== borrar ==');
  const del = await req(`/api/reports/${rid}`, { method: 'DELETE', token: ta });
  ok(del.status === 200, 'dueño elimina su aviso');
  const delAcc = await req('/api/auth/me', { method: 'DELETE', token: ta });
  ok(delAcc.status === 200, 'eliminar cuenta');

  console.log(fallos === 0 ? '\nTODO OK' : `\n${fallos} comprobaciones fallaron`);
  await pool.end();
  process.exit(fallos === 0 ? 0 : 1);
})().catch(async e => { console.error('Error inesperado:', e); try { await pool.end(); } catch (_) {} process.exit(1); });
