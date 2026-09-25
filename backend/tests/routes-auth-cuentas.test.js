// Pruebas del inicio de sesión con Google, de la sesión (GET /me) y del borrado
// de cuenta (DELETE /me) de backend/routes/auth.js.
//
// INFRAESTRUCTURA DE VALIDACIÓN: no se modifica ni una línea de producción. El
// router se importa de forma ESTÁTICA (para que Stryker lo relacione con estas
// pruebas vía `vitest related`) y sus dependencias (db, storage) se sustituyen
// con los dobles de ./helpers/aislar.js, que se importa ANTES.
//
// NOTAS DE MONTAJE:
//   * ADMIN_EMAILS se lee AL CARGAR el módulo, así que se fija en vi.hoisted
//     (corre antes que los imports). Lleva espacios, mayúsculas y comas de más a
//     propósito: ejercita el split, el trim, el toLowerCase y el filter.
//   * La verificación de Google llama a fetch contra tokeninfo: se sustituye con
//     vi.stubGlobal y se restaura con vi.unstubAllGlobals.
//   * server.js cierra los errores con su propio manejador; aquí se replica el
//     mismo cuerpo JSON para poder afirmar el 500.
vi.hoisted(() => {
  process.env.ADMIN_EMAILS = ' jefa@test.local , JEFA2@Test.Local , ,';
  process.env.TRUST_PROXY = '1';
});

import { describe, it, expect, vi, beforeEach, afterAll, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { db, storage, crearApp, pedir, tokenPara, olvidar, requerir, RUTAS } from './helpers/aislar.js';
import authRouter from '../routes/auth.js';

const app = crearApp({ '/api/auth': authRouter });
app.use((err, req, res, _next) =>
  res.status(err.status || 500).json({ error: 'Ocurrió un error en el servidor.' })
);

const LISTA_ADMIN = ' jefa@test.local , JEFA2@Test.Local , ,';
const CLIENTE = 'cliente-de-pruebas.apps.googleusercontent.com';
const SIN_AUTENTICAR = { error: 'No autenticado.' };
const SESION_INVALIDA = { error: 'Sesión inválida o expirada.' };
const SESION_CERRADA = { error: 'Tu sesión fue cerrada. Inicia sesión de nuevo.' };
const SIN_CONFIGURAR = { error: 'El inicio de sesión con Google no está configurado.' };
const CREDENCIAL_INVALIDA = { error: 'Credencial inválida.' };
const GOOGLE_NO_VERIFICADO = { error: 'No se pudo verificar la cuenta de Google.' };
const GOOGLE_AUD = { error: 'Credencial de Google inválida.' };
const GOOGLE_CORREO = { error: 'Tu correo de Google no está verificado.' };
const USUARIO_NO_ENCONTRADO = { error: 'Usuario no encontrado.' };
const MENSAJE_500 = { error: 'Ocurrió un error en el servidor.' };
const SQL_TOKEN_VERSION = 'SELECT token_version FROM users WHERE id = $1';
const SQL_USUARIO_ME = 'SELECT id, email, phone, created_at, email_verified FROM users WHERE id = $1';
const SQL_BUSCAR_GOOGLE = 'SELECT * FROM users';
const SQL_INSERT_GOOGLE = 'INSERT INTO users';
const SQL_REPORTES = 'SELECT foto_url, reunion_foto_url FROM reports WHERE user_id = $1';
const SQL_BORRAR_USUARIO = 'DELETE FROM users WHERE id = $1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Entorno que algunas pruebas tocan: se restaura en afterEach.
const ENTORNO = {
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  ADMIN_EMAILS: process.env.ADMIN_EMAILS
};

let visitas = 0;
function conIp(peticion) {
  visitas += 1;
  return peticion.set('x-forwarded-for', `10.62.${Math.floor(visitas / 250)}.${visitas % 250}`);
}

// El cupo por cuenta de estas rutas se cobra por credencial: cada prueba usa una.
let credenciales = 0;
function credencial() {
  credenciales += 1;
  return `credencial-de-prueba-${credenciales}`;
}

function consultaCon(fragmento) {
  const encontrada = db.query.mock.calls.find(([sql]) => sql.includes(fragmento));
  if (!encontrada) throw new Error(`No hubo ninguna consulta con: ${fragmento}`);
  return encontrada;
}

// Respuesta de tokeninfo con la forma que espera el router.
function googleResponde(cuerpo, opciones = {}) {
  const { ok = true } = opciones;
  const falso = vi.fn(async () => ({ ok, json: async () => cuerpo }));
  vi.stubGlobal('fetch', falso);
  return falso;
}

function tokeninfoValido(extra = {}) {
  return { aud: CLIENTE, email_verified: 'true', email: 'nueva@test.local', sub: 'google-sub-1', ...extra };
}

// requireAuth pide token_version; `propia` responde a la consulta de la ruta.
function prepararBase(propia) {
  db.query.mockImplementation(async (sql, parametros) => {
    if (sql === SQL_TOKEN_VERSION) return { rows: [{ token_version: 0 }] };
    if (propia) return propia(sql, parametros);
    return { rows: [] };
  });
}

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  storage.deletePhoto.mockReset();
  storage.deletePhoto.mockResolvedValue(undefined);
  process.env.GOOGLE_CLIENT_ID = CLIENTE;
  // Por defecto Google responde un token válido: ninguna prueba debe salir a la
  // red de verdad (el fetch real tardaría o devolvería 401).
  googleResponde(tokeninfoValido());
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [clave, valor] of Object.entries(ENTORNO)) {
    if (valor === undefined) delete process.env[clave];
    else process.env[clave] = valor;
  }
});

describe('POST /google · configuración y credencial', () => {
  it('sin GOOGLE_CLIENT_ID responde 503 sin llamar a Google ni a la base', async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const falso = googleResponde(tokeninfoValido());

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(503);
    expect(res.body).toStrictEqual(SIN_CONFIGURAR);
    expect(falso).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('sin credencial responde 400 sin llamar a Google', async () => {
    const falso = googleResponde(tokeninfoValido());

    const res = await conIp(pedir(app).post('/api/auth/google')).send({});

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(CREDENCIAL_INVALIDA);
    expect(falso).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('una credencial que no es texto responde 400', async () => {
    for (const credential of [42, null, '', { token: 'x' }]) {
      const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential });

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(CREDENCIAL_INVALIDA);
    }
  });

  it('consulta tokeninfo con la credencial codificada en la URL', async () => {
    const falso = googleResponde(tokeninfoValido({ aud: 'otro-cliente' }));

    await conIp(pedir(app).post('/api/auth/google')).send({ credential: 'a+b/c=d' });

    expect(falso).toHaveBeenCalledWith(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent('a+b/c=d')
    );
  });
});

describe('POST /google · verificación del token', () => {
  it('si Google responde con error, responde 401', async () => {
    googleResponde({}, { ok: false });

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(GOOGLE_NO_VERIFICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('si el aud no es el cliente configurado responde 401', async () => {
    googleResponde(tokeninfoValido({ aud: 'otro-cliente' }));

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(GOOGLE_AUD);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('si falta el aud responde 401', async () => {
    const info = tokeninfoValido();
    delete info.aud;
    googleResponde(info);

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(GOOGLE_AUD);
  });

  it('un correo de Google sin verificar responde 401', async () => {
    for (const email_verified of [false, 'false', 'TRUE', 1, undefined]) {
      googleResponde(tokeninfoValido({ email_verified }));

      const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

      expect(res.status).toBe(401);
      expect(res.body).toStrictEqual(GOOGLE_CORREO);
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it('email_verified booleano verdadero también vale (se compara como texto)', async () => {
    googleResponde(tokeninfoValido({ email_verified: true }));
    prepararBase(async sql => {
      if (sql.includes(SQL_BUSCAR_GOOGLE))
        return { rows: [{ id: 'u-1', email: 'nueva@test.local', token_version: 0 }] };
      return { rows: [] };
    });

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe('u-1');
  });

  it('un fallo de red al llamar a Google responde 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('red caída');
      })
    );

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
  });
});

describe('POST /google · cuenta nueva', () => {
  function soloInsertar() {
    prepararBase(async sql => (sql.includes(SQL_INSERT_GOOGLE) ? { rows: [{ id: 'nueva' }] } : { rows: [] }));
  }

  it('crea la cuenta verificada, sin teléfono y con el sub de Google', async () => {
    soloInsertar();
    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(200);
    expect(res.body.user).toStrictEqual({
      id: expect.stringMatching(UUID),
      email: 'nueva@test.local',
      phone: null
    });
    expect(jwt.verify(res.body.token, process.env.JWT_SECRET)).toMatchObject({ ver: 0 });

    const [sql, parametros] = consultaCon(SQL_INSERT_GOOGLE);
    expect(sql).toContain(
      'INSERT INTO users (id, email, password_hash, phone, google_sub, email_verified, created_at)'
    );
    expect(sql).toContain('VALUES ($1,$2,$3,NULL,$4,TRUE,$5)');
    expect(sql).toContain('ON CONFLICT (email) DO NOTHING');
    expect(parametros[0]).toBe(res.body.user.id);
    expect(parametros[1]).toBe('nueva@test.local');
    expect(parametros[2]).toMatch(/^\$2[ab]\$12\$/);
    expect(parametros[3]).toBe('google-sub-1');
    expect(parametros[4]).toBeLessThanOrEqual(Date.now());
  });

  it('el correo de Google se guarda y se busca en minúsculas y sin alias', async () => {
    soloInsertar();
    googleResponde(tokeninfoValido({ email: 'Nueva+Alias@Example.COM' }));

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('nueva+alias@example.com');
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining(SQL_BUSCAR_GOOGLE), [
      'nueva+alias@example.com',
      'nueva@example.com'
    ]);
  });

  it('sin sub de Google la cuenta se crea igual, con google_sub nulo', async () => {
    soloInsertar();
    const info = tokeninfoValido();
    delete info.sub;
    googleResponde(info);

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(200);
    expect(consultaCon(SQL_INSERT_GOOGLE)[1][3]).toBeNull();
  });

  it('la contraseña aleatoria guardada es un hash distinto en cada cuenta nueva', async () => {
    soloInsertar();
    await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });
    const primero = consultaCon(SQL_INSERT_GOOGLE)[1][2];
    db.query.mockClear();
    soloInsertar();
    await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });
    const segundo = consultaCon(SQL_INSERT_GOOGLE)[1][2];

    expect(primero).not.toBe(segundo);
    expect(bcrypt.compareSync('', primero)).toBe(false);
  });

  it('si el INSERT choca (23505) se busca la cuenta y se entra con ella', async () => {
    let busquedas = 0;
    prepararBase(async sql => {
      if (sql.includes(SQL_BUSCAR_GOOGLE)) {
        busquedas += 1;
        return busquedas === 1
          ? { rows: [] }
          : { rows: [{ id: 'ya-existe', email: 'nueva@test.local', phone: null, token_version: 7 }] };
      }
      const error = new Error('llave duplicada');
      error.code = '23505';
      throw error;
    });

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(200);
    expect(res.body.user).toStrictEqual({ id: 'ya-existe', email: 'nueva@test.local', phone: null });
    expect(jwt.verify(res.body.token, process.env.JWT_SECRET)).toMatchObject({ sub: 'ya-existe', ver: 7 });
    expect(busquedas).toBe(2);
  });

  // Hallazgo: aquí `user` quedaba indefinido y el `user.id` de la respuesta
  // lanzaba un TypeError (un 500 por accidente, fuera de todo control). Ahora
  // se lanza un error explícito, así que el 500 lo produce el manejador global
  // y la petición nunca queda a medias.
  it('si el INSERT choca y la cuenta tampoco aparece, responde 500 y no un TypeError', async () => {
    prepararBase(async sql => {
      if (sql === SQL_INSERT_GOOGLE) {
        const error = new Error('llave duplicada');
        error.code = '23505';
        throw error;
      }
      return { rows: [] };
    });

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
    expect(res.body.token).toBeUndefined();
  });

  // La rebúsqueda también puede correr con el `google_sub` aún sin enlazar: el
  // 23505 no puede dejar la petición a medias en ningún caso.
  it('un 23505 cuya rebúsqueda devuelve filas vacías no revienta con TypeError', async () => {
    let busquedas = 0;
    prepararBase(async sql => {
      if (sql.includes(SQL_BUSCAR_GOOGLE)) {
        busquedas += 1;
        return { rows: [] };
      }
      if (sql === SQL_INSERT_GOOGLE) {
        const error = new Error('llave duplicada');
        error.code = '23505';
        throw error;
      }
      return { rows: [] };
    });

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(busquedas).toBe(2);
    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
  });

  it('un error de la base distinto de 23505 responde 500', async () => {
    prepararBase(async sql => {
      if (sql === SQL_INSERT_GOOGLE) throw new Error('caída al insertar');
      return { rows: [] };
    });

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
  });
});

describe('POST /google · cuenta existente', () => {
  it('una cuenta con contraseña entra sin tocar la base de escritura', async () => {
    prepararBase(async sql =>
      sql.includes(SQL_BUSCAR_GOOGLE)
        ? {
            rows: [
              { id: 'u-1', email: 'ana@test.local', phone: '+56 9 1111', token_version: 4, google_sub: 'g-1' }
            ]
          }
        : { rows: [] }
    );

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(200);
    expect(res.body.user).toStrictEqual({ id: 'u-1', email: 'ana@test.local', phone: '+56 9 1111' });
    expect(jwt.verify(res.body.token, process.env.JWT_SECRET)).toMatchObject({ sub: 'u-1', ver: 4 });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('si la cuenta no tenía google_sub, se le asocia el de esta sesión', async () => {
    prepararBase(async sql =>
      sql.includes(SQL_BUSCAR_GOOGLE)
        ? { rows: [{ id: 'u-1', email: 'ana@test.local', phone: null, token_version: 0 }] }
        : { rows: [] }
    );

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledWith('UPDATE users SET google_sub = $1 WHERE id = $2', [
      'google-sub-1',
      'u-1'
    ]);
  });

  it('si Google no manda sub, no se asocia nada', async () => {
    const info = tokeninfoValido();
    delete info.sub;
    googleResponde(info);
    prepararBase(async sql =>
      sql.includes(SQL_BUSCAR_GOOGLE)
        ? { rows: [{ id: 'u-1', email: 'nueva@test.local', token_version: 0 }] }
        : { rows: [] }
    );

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(200);
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('UPDATE users SET google_sub'),
      expect.anything()
    );
  });

  it('un fallo de la base al buscar la cuenta responde 500', async () => {
    prepararBase(async () => {
      throw new Error('caída al buscar');
    });

    const res = await conIp(pedir(app).post('/api/auth/google')).send({ credential: credencial() });

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
  });
});

describe('GET /me', () => {
  it('sin cabecera Authorization responde 401 y no consulta la base', async () => {
    const res = await conIp(pedir(app).get('/api/auth/me'));

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SIN_AUTENTICAR);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('una cabecera sin el prefijo Bearer también es 401', async () => {
    const res = await conIp(pedir(app).get('/api/auth/me')).set('Authorization', `Token ${tokenPara('u-1')}`);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SIN_AUTENTICAR);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un token que no es un JWT o está firmado con otro secreto es 401', async () => {
    const ajeno = jwt.sign({ sub: 'u-1', ver: 0 }, 'otro-secreto');
    const roto = await conIp(pedir(app).get('/api/auth/me')).set('Authorization', 'Bearer no-es-un-jwt');
    const falso = await conIp(pedir(app).get('/api/auth/me')).set('Authorization', `Bearer ${ajeno}`);

    expect(roto.status).toBe(401);
    expect(roto.body).toStrictEqual(SESION_INVALIDA);
    expect(falso.status).toBe(401);
    expect(falso.body).toStrictEqual(SESION_INVALIDA);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('una sesión de otra versión (contraseña cambiada) es 401', async () => {
    db.query.mockResolvedValue({ rows: [{ token_version: 3 }] });

    const res = await conIp(pedir(app).get('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-1', 1)}`
    );

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SESION_CERRADA);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('una cuenta ya borrada es 401', async () => {
    db.query.mockResolvedValue({ rows: [] });

    const res = await conIp(pedir(app).get('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-1')}`
    );

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SESION_INVALIDA);
    expect(db.query).toHaveBeenCalledWith(SQL_TOKEN_VERSION, ['u-1']);
  });

  it('si la cuenta desaparece entre las dos consultas responde 404', async () => {
    prepararBase(async () => ({ rows: [] }));

    const res = await conIp(pedir(app).get('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-1')}`
    );

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual(USUARIO_NO_ENCONTRADO);
    expect(db.query).toHaveBeenCalledWith(SQL_USUARIO_ME, ['u-1']);
  });

  it('devuelve la cuenta con is_admin cuando el correo está en ADMIN_EMAILS', async () => {
    prepararBase(async () => ({
      rows: [
        {
          id: 'u-1',
          email: 'JEFA@TEST.LOCAL',
          phone: null,
          created_at: 1700000000000,
          email_verified: true
        }
      ]
    }));

    const res = await conIp(pedir(app).get('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-1')}`
    );

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      user: {
        id: 'u-1',
        email: 'JEFA@TEST.LOCAL',
        phone: null,
        created_at: 1700000000000,
        email_verified: true,
        is_admin: true
      }
    });
    expect(db.query).toHaveBeenCalledWith(SQL_USUARIO_ME, ['u-1']);
  });

  it('no marca como admin una cuenta de ADMIN_EMAILS cuyo correo no está verificado', async () => {
    prepararBase(async () => ({
      rows: [{ id: 'u-1', email: 'jefa@test.local', email_verified: false }]
    }));

    const res = await conIp(pedir(app).get('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-1')}`
    );

    expect(res.status).toBe(200);
    expect(res.body.user.is_admin).toBe(false);
  });

  it('la segunda cuenta de la lista (con espacios) también es administradora', async () => {
    prepararBase(async () => ({
      rows: [{ id: 'u-2', email: 'jefa2@test.local', email_verified: true }]
    }));

    const res = await conIp(pedir(app).get('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-2')}`
    );

    expect(res.status).toBe(200);
    expect(res.body.user.is_admin).toBe(true);
  });

  it('una cuenta corriente (o sin correo) no es administradora', async () => {
    prepararBase(async () => ({ rows: [{ id: 'u-3', email: 'curiosa@test.local' }] }));
    const corriente = await conIp(pedir(app).get('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-3')}`
    );

    prepararBase(async () => ({ rows: [{ id: 'u-4', email: null }] }));
    const sinCorreo = await conIp(pedir(app).get('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-4')}`
    );

    expect(corriente.status).toBe(200);
    expect(corriente.body.user.is_admin).toBe(false);
    expect(sinCorreo.status).toBe(200);
    expect(sinCorreo.body.user.is_admin).toBe(false);
  });

  it('un fallo de la base responde 500', async () => {
    prepararBase(async () => {
      throw new Error('caída al leer la cuenta');
    });

    const res = await conIp(pedir(app).get('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-1')}`
    );

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
  });
});

describe('DELETE /me', () => {
  it('sin cabecera Authorization responde 401 y no borra nada', async () => {
    const res = await conIp(pedir(app).delete('/api/auth/me'));

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SIN_AUTENTICAR);
    expect(db.query).not.toHaveBeenCalled();
    expect(storage.deletePhoto).not.toHaveBeenCalled();
  });

  it('una sesión revocada no puede borrar la cuenta', async () => {
    db.query.mockResolvedValue({ rows: [{ token_version: 5 }] });

    const res = await conIp(pedir(app).delete('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-1', 0)}`
    );

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SESION_CERRADA);
    expect(storage.deletePhoto).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalledWith(SQL_BORRAR_USUARIO, ['u-1']);
  });

  it('borra las fotos de todos los avisos (también los nulos) y después la cuenta', async () => {
    prepararBase(async sql =>
      sql === SQL_REPORTES
        ? {
            rows: [
              { foto_url: '/uploads/a.jpg', reunion_foto_url: '/uploads/b.jpg' },
              { foto_url: null, reunion_foto_url: '/uploads/c.jpg' }
            ]
          }
        : { rows: [] }
    );

    const res = await conIp(pedir(app).delete('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-1')}`
    );

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true, message: 'Cuenta y datos asociados eliminados.' });
    expect(storage.deletePhoto.mock.calls).toStrictEqual([
      ['/uploads/a.jpg'],
      ['/uploads/b.jpg'],
      [null],
      ['/uploads/c.jpg']
    ]);
    expect(db.query.mock.calls.map(([sql]) => sql)).toStrictEqual([
      SQL_TOKEN_VERSION,
      SQL_REPORTES,
      SQL_BORRAR_USUARIO
    ]);
    expect(db.query.mock.calls[1][1]).toStrictEqual(['u-1']);
    expect(db.query.mock.calls[2][1]).toStrictEqual(['u-1']);
  });

  it('sin avisos no intenta borrar fotos', async () => {
    prepararBase(async () => ({ rows: [] }));

    const res = await conIp(pedir(app).delete('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-1')}`
    );

    expect(res.status).toBe(200);
    expect(storage.deletePhoto).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(SQL_BORRAR_USUARIO, ['u-1']);
  });

  it('si falla la lectura de los avisos no borra la cuenta', async () => {
    prepararBase(async sql => {
      if (sql === SQL_REPORTES) throw new Error('caída al leer los avisos');
      return { rows: [] };
    });

    const res = await conIp(pedir(app).delete('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-1')}`
    );

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
    expect(storage.deletePhoto).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalledWith(SQL_BORRAR_USUARIO, ['u-1']);
  });

  it('si falla el borrado de la cuenta las fotos ya se borraron', async () => {
    prepararBase(async sql => {
      if (sql === SQL_REPORTES) return { rows: [{ foto_url: '/uploads/a.jpg', reunion_foto_url: null }] };
      if (sql === SQL_BORRAR_USUARIO) throw new Error('caída al borrar la cuenta');
      return { rows: [] };
    });

    const res = await conIp(pedir(app).delete('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-1')}`
    );

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
    expect(storage.deletePhoto).toHaveBeenCalledWith('/uploads/a.jpg');
  });
});

describe('carga del módulo sin ADMIN_EMAILS', () => {
  // Se recarga una instancia aparte del router (el import estático ya garantiza
  // la relación con Stryker); al terminar se deja la lista buena otra vez.
  afterAll(() => {
    process.env.ADMIN_EMAILS = LISTA_ADMIN;
    olvidar(RUTAS.routesAuth);
    requerir(RUTAS.routesAuth);
  });

  it('sin lista de administradores nadie es administrador', async () => {
    delete process.env.ADMIN_EMAILS;
    olvidar(RUTAS.routesAuth);
    const sinLista = requerir(RUTAS.routesAuth);
    const appSinLista = crearApp({ '/api/auth': sinLista });
    appSinLista.use((err, req, res, _next) =>
      res.status(err.status || 500).json({ error: 'Ocurrió un error en el servidor.' })
    );
    db.query.mockImplementation(async sql =>
      sql === SQL_TOKEN_VERSION ? { rows: [{ token_version: 0 }] } : { rows: [{ email: 'jefa@test.local' }] }
    );

    const res = await conIp(pedir(appSinLista).get('/api/auth/me')).set(
      'Authorization',
      `Bearer ${tokenPara('u-1')}`
    );

    expect(res.status).toBe(200);
    expect(res.body.user.is_admin).toBe(false);
    expect(db.query).toHaveBeenCalledWith(SQL_USUARIO_ME, ['u-1']);
  });
});
