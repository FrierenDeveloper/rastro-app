// Pruebas del inicio de sesión, la recuperación de contraseña y el reseteo
// (backend/routes/auth.js: POST /login, POST /forgot, POST /reset) más los dos
// cupos de intentos que protegen esas rutas.
//
// INFRAESTRUCTURA DE VALIDACIÓN: no se modifica ni una línea de producción. El
// router se importa de forma ESTÁTICA (para que Stryker lo relacione con estas
// pruebas vía `vitest related`) y sus dependencias (db, mailer) se sustituyen
// con los dobles de ./helpers/aislar.js, que se importa ANTES.
//
// NOTAS DE MONTAJE:
//   * server.js cierra los errores con su propio manejador; aquí se replica el
//     mismo cuerpo JSON para poder afirmar el 500.
//   * bcryptjs es el de verdad: el hash de las cuentas se calcula una sola vez
//     en beforeAll (12 rondas, como en producción) y se compara con
//     bcrypt.compareSync para afirmar que lo guardado es un hash utilizable.
//   * Los rate limits viven a nivel de módulo: cada prueba usa su propia IP en
//     x-forwarded-for (TRUST_PROXY=1). Las dos pruebas que a propósito llenan un
//     cupo usan una IP y un buzón exclusivos, para no dejar 429 a las demás.
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db, mailer, crearApp, pedir } from './helpers/aislar.js';
import authRouter from '../routes/auth.js';

const app = crearApp({ '/api/auth': authRouter });
app.use((err, req, res, _next) =>
  res.status(err.status || 500).json({ error: 'Ocurrió un error en el servidor.' })
);

const PASSWORD = 'contrasena-larga-de-prueba';
const NUEVA_PASSWORD = 'contrasena-nueva-2026';
const MENSAJE_CREDENCIALES = { error: 'Correo o contraseña incorrectos.' };
const MENSAJE_INVALIDOS = { error: 'Correo o contraseña inválidos.' };
const MENSAJE_CORREO = { error: 'Correo inválido.' };
const MENSAJE_PASSWORD = { error: 'La contraseña debe tener al menos 10 caracteres.' };
const MENSAJE_ENLACE = { error: 'El enlace es inválido o ya venció. Pide uno nuevo.' };
const MENSAJE_500 = { error: 'Ocurrió un error en el servidor.' };
const MENSAJE_SIN_CONFIGURAR = {
  error: 'La recuperación por correo no está configurada en este servidor.'
};
const MENSAJE_SIN_CUENTA = 'Si el correo existe, te enviamos un enlace para restablecer la contraseña.';
const SQL_LOGIN = `SELECT * FROM users
          WHERE email = $1 OR normalizar_correo(email) = $2
          ORDER BY (email = $1) DESC
          LIMIT 1`;
const SQL_BUSCAR_CUENTA = `SELECT id, email FROM users
          WHERE email = $1 OR normalizar_correo(email) = $2
          ORDER BY (email = $1) DESC LIMIT 1`;
const SQL_RESET = 'SELECT * FROM password_resets WHERE token = $1';
const SQL_ACTUALIZAR_USUARIO =
  'UPDATE users SET password_hash = $1, token_version = token_version + 1 WHERE id = $2';
const SQL_MARCAR_RESET = 'UPDATE password_resets SET used = TRUE WHERE token = $1';

// Entorno que algunas pruebas tocan: se restaura en afterEach.
const ENTORNO = {
  NODE_ENV: process.env.NODE_ENV,
  APP_URL: process.env.APP_URL,
  RENDER_EXTERNAL_URL: process.env.RENDER_EXTERNAL_URL
};

let HASH;

beforeAll(() => {
  HASH = bcrypt.hashSync(PASSWORD, 12);
});

// Cada petición, desde una IP distinta: así el cupo del authLimiter no se llena.
let visitas = 0;
function conIp(peticion) {
  visitas += 1;
  return peticion.set('x-forwarded-for', `10.61.${Math.floor(visitas / 250)}.${visitas % 250}`);
}

let cuentas = 0;
function buzon() {
  cuentas += 1;
  return `login-${cuentas}@test.local`;
}

function hashDeReset(crudo) {
  return crypto.createHash('sha256').update(crudo).digest('hex');
}

// Devuelve [sql, parametros] de la primera consulta que contiene el fragmento.
function consultaCon(fragmento) {
  const encontrada = db.query.mock.calls.find(([sql]) => sql.includes(fragmento));
  if (!encontrada) throw new Error(`No hubo ninguna consulta con: ${fragmento}`);
  return encontrada;
}

function usuarioDeLogin(extra = {}) {
  return {
    id: 'u-1',
    email: 'ana@test.local',
    phone: '+56 9 1111 2222',
    password_hash: HASH,
    token_version: 0,
    ...extra
  };
}

beforeEach(() => {
  db.query.mockReset();
  db.query.mockResolvedValue({ rows: [] });
  mailer.sendMail.mockReset();
  mailer.sendMail.mockResolvedValue({ id: 'correo-de-prueba' });
  mailer.usingEmail = true;
});

afterEach(() => {
  vi.useRealTimers();
  for (const [clave, valor] of Object.entries(ENTORNO)) {
    if (valor === undefined) delete process.env[clave];
    else process.env[clave] = valor;
  }
});

describe('POST /login · validaciones', () => {
  it('sin cuerpo responde 400 y no toca la base', async () => {
    const res = await conIp(pedir(app).post('/api/auth/login')).send();

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MENSAJE_INVALIDOS);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un correo con formato inválido responde 400', async () => {
    for (const email of ['no-es-correo', 'a@', '@b.com', 42, '']) {
      const res = await conIp(pedir(app).post('/api/auth/login')).send({ email, password: PASSWORD });

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(MENSAJE_INVALIDOS);
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it('una contraseña vacía responde 400', async () => {
    for (const password of ['', null, undefined]) {
      const res = await conIp(pedir(app).post('/api/auth/login')).send({
        email: buzon(),
        password
      });

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(MENSAJE_INVALIDOS);
    }
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('POST /login · credenciales', () => {
  it('un usuario que no existe responde 401 con el mensaje genérico', async () => {
    const correo = buzon();
    const res = await conIp(pedir(app).post('/api/auth/login')).send({
      email: correo,
      password: PASSWORD
    });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(MENSAJE_CREDENCIALES);
    // Se busca por el correo tal cual y por su versión sin "+alias".
    expect(db.query).toHaveBeenCalledWith(SQL_LOGIN, [correo, correo]);
  });

  it('una contraseña incorrecta responde 401', async () => {
    db.query.mockResolvedValue({ rows: [usuarioDeLogin()] });
    const res = await conIp(pedir(app).post('/api/auth/login')).send({
      email: 'ana@test.local',
      password: 'otra-contraseña-larga'
    });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(MENSAJE_CREDENCIALES);
  });

  it('un hash guardado que no es bcrypt tampoco deja entrar', async () => {
    db.query.mockResolvedValue({ rows: [usuarioDeLogin({ password_hash: 'no-es-un-hash' })] });
    const res = await conIp(pedir(app).post('/api/auth/login')).send({
      email: 'ana@test.local',
      password: PASSWORD
    });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(MENSAJE_CREDENCIALES);
  });

  it('con las credenciales correctas responde el token y el usuario', async () => {
    db.query.mockResolvedValue({ rows: [usuarioDeLogin()] });
    const res = await conIp(pedir(app).post('/api/auth/login')).send({
      email: 'ana@test.local',
      password: PASSWORD
    });

    expect(res.status).toBe(200);
    expect(res.body.user).toStrictEqual({ id: 'u-1', email: 'ana@test.local', phone: '+56 9 1111 2222' });

    const payload = jwt.verify(res.body.token, process.env.JWT_SECRET);
    expect(payload.sub).toBe('u-1');
    expect(payload.ver).toBe(0);
    expect(payload.exp - payload.iat).toBe(7 * 24 * 60 * 60);
  });

  it('el token lleva la versión de sesión guardada en la cuenta', async () => {
    db.query.mockResolvedValue({ rows: [usuarioDeLogin({ token_version: 7 })] });
    const res = await conIp(pedir(app).post('/api/auth/login')).send({
      email: 'ana@test.local',
      password: PASSWORD
    });

    expect(jwt.verify(res.body.token, process.env.JWT_SECRET).ver).toBe(7);
  });

  it('sin token_version guardado el token sale con versión 0', async () => {
    db.query.mockResolvedValue({ rows: [usuarioDeLogin({ token_version: null })] });
    const res = await conIp(pedir(app).post('/api/auth/login')).send({
      email: 'ana@test.local',
      password: PASSWORD
    });

    expect(res.status).toBe(200);
    expect(jwt.verify(res.body.token, process.env.JWT_SECRET).ver).toBe(0);
  });

  it('el correo normalizado encuentra la cuenta aunque se escriba con alias y mayúsculas', async () => {
    db.query.mockResolvedValue({ rows: [usuarioDeLogin({ email: 'victima@gmail.com', phone: null })] });
    const res = await conIp(pedir(app).post('/api/auth/login')).send({
      email: 'Victima+Otro@Gmail.com',
      password: PASSWORD
    });

    expect(res.status).toBe(200);
    expect(res.body.user.phone).toBeNull();
    expect(db.query).toHaveBeenCalledWith(SQL_LOGIN, ['victima@gmail.com', 'victima@gmail.com']);
  });

  it('en un dominio propio el alias se busca por la cuenta sin alias', async () => {
    db.query.mockResolvedValue({ rows: [usuarioDeLogin({ email: 'ana+perro@example.com' })] });
    const res = await conIp(pedir(app).post('/api/auth/login')).send({
      email: 'Ana+Perro@Example.COM',
      password: PASSWORD
    });

    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledWith(SQL_LOGIN, ['ana+perro@example.com', 'ana@example.com']);
  });

  it('una cuenta sin el correo confirmado también puede iniciar sesión', async () => {
    // Comportamiento actual: /login NO exige email_verified. El bloqueo vive en
    // requireVerified (publicar, reportar...). Se documenta aquí para que, si
    // algún día el login lo exige, esta prueba salte y haya que actualizarla.
    db.query.mockResolvedValue({ rows: [usuarioDeLogin({ email_verified: false })] });
    const res = await conIp(pedir(app).post('/api/auth/login')).send({
      email: 'ana@test.local',
      password: PASSWORD
    });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      token: expect.any(String),
      user: { id: 'u-1', email: 'ana@test.local', phone: '+56 9 1111 2222' }
    });
  });

  it('un fallo de la base responde 500', async () => {
    db.query.mockImplementation(async () => {
      throw new Error('caída al buscar la cuenta');
    });
    const res = await conIp(pedir(app).post('/api/auth/login')).send({
      email: buzon(),
      password: PASSWORD
    });

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
  });
});

describe('POST /login · cupos de intentos', () => {
  it('el cupo por IP corta en el intento 21 con su mensaje exacto', async () => {
    const respuestas = [];
    for (let i = 0; i < 21; i += 1) {
      respuestas.push(
        await pedir(app)
          .post('/api/auth/login')
          .set('x-forwarded-for', '10.61.250.250')
          .send({ email: `cupo-ip-${i}@test.local`, password: PASSWORD })
      );
    }

    expect(respuestas[19].status).toBe(401);
    expect(respuestas[20].status).toBe(429);
    expect(respuestas[20].body).toStrictEqual({
      error: 'Demasiados intentos. Intenta de nuevo en unos minutos.'
    });
    // standardHeaders: true deja las cabeceras del borrador y ninguna legacy.
    expect(respuestas[20].headers['ratelimit-limit']).toBe('20');
    expect(respuestas[20].headers['ratelimit-remaining']).toBe('0');
    // La ventana es de 15 minutos (900 segundos).
    expect(respuestas[20].headers['ratelimit-policy']).toBe('20;w=900');
    expect(respuestas[20].headers['x-ratelimit-limit']).toBeUndefined();
  });

  it('el cupo por cuenta corta en el intento 11 aunque cambie la IP', async () => {
    const respuestas = [];
    for (let i = 0; i < 10; i += 1) {
      respuestas.push(
        await conIp(pedir(app).post('/api/auth/login')).send({
          email: `cupo-cuenta+${i}@test.local`,
          password: PASSWORD
        })
      );
    }
    respuestas.push(
      await conIp(pedir(app).post('/api/auth/login')).send({
        email: 'cupo-cuenta@test.local',
        password: PASSWORD
      })
    );

    expect(respuestas[9].status).toBe(401);
    expect(respuestas[10].status).toBe(429);
    expect(respuestas[10].body).toStrictEqual({
      error: 'Demasiados intentos para esta cuenta. Espera unos minutos.'
    });
  });
});

describe('POST /forgot · validaciones', () => {
  it('sin cuerpo responde 400 con el mensaje del correo', async () => {
    const res = await conIp(pedir(app).post('/api/auth/forgot')).send();

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MENSAJE_CORREO);
    expect(db.query).not.toHaveBeenCalled();
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('un correo inválido responde 400', async () => {
    for (const email of ['no-es-correo', 'a@', 42]) {
      const res = await conIp(pedir(app).post('/api/auth/forgot')).send({ email });

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(MENSAJE_CORREO);
    }
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('POST /forgot · respuesta y envío', () => {
  it('sin cuenta registrada responde lo mismo y no manda ningún correo', async () => {
    const correo = buzon();
    const res = await conIp(pedir(app).post('/api/auth/forgot')).send({ email: correo });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true, message: MENSAJE_SIN_CUENTA });
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(SQL_BUSCAR_CUENTA, [correo, correo]);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('con cuenta registrada invalida los tokens viejos, guarda el hash y manda el enlace', async () => {
    db.query.mockImplementation(async sql =>
      sql.startsWith('SELECT id, email FROM users')
        ? { rows: [{ id: 'u-9', email: 'ana@test.local' }] }
        : { rows: [] }
    );
    const res = await conIp(pedir(app).post('/api/auth/forgot')).send({ email: buzon() });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true, message: MENSAJE_SIN_CUENTA });
    expect(db.query.mock.calls.map(([sql]) => sql)).toStrictEqual([
      SQL_BUSCAR_CUENTA,
      'UPDATE password_resets SET used = TRUE WHERE user_id = $1 AND used = FALSE',
      'INSERT INTO password_resets (token, user_id, expires_at, used, created_at) VALUES ($1,$2,$3,FALSE,$4)'
    ]);
    expect(db.query.mock.calls[1][1]).toStrictEqual(['u-9']);

    // En la base solo va el SHA-256 del token que viaja en el enlace.
    const [, parametros] = consultaCon('INSERT INTO password_resets');
    expect(parametros[1]).toBe('u-9');
    expect(parametros[3]).toBeLessThanOrEqual(Date.now());

    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    const aviso = mailer.sendMail.mock.calls[0][0];
    expect(aviso.to).toBe('ana@test.local');
    expect(aviso.subject).toBe('Recuperar tu contraseña de Rastro');
    expect(aviso.text).toContain('El enlace vence en 1 hora. Si no lo pediste, ignora este correo.');
    const enlace = aviso.text.match(/\/\?reset=([0-9a-f]{64})/);
    expect(enlace).not.toBeNull();
    expect(parametros[0]).toBe(hashDeReset(enlace[1]));
    expect(parametros[2] - parametros[3]).toBeLessThanOrEqual(60 * 60 * 1000);
    expect(parametros[2] - parametros[3]).toBeGreaterThan(60 * 60 * 1000 - 1000);
  });

  it('APP_URL manda en el enlace y se le quitan las barras finales', async () => {
    process.env.APP_URL = 'https://rastro.test///';
    db.query.mockImplementation(async sql =>
      sql.startsWith('SELECT id, email FROM users')
        ? { rows: [{ id: 'u-9', email: 'ana@test.local' }] }
        : { rows: [] }
    );
    await conIp(pedir(app).post('/api/auth/forgot')).send({ email: buzon() });

    expect(mailer.sendMail.mock.calls[0][0].text).toContain('https://rastro.test/?reset=');
    expect(mailer.sendMail.mock.calls[0][0].text).not.toContain('rastro.test//');
  });

  it('sin APP_URL se usa RENDER_EXTERNAL_URL', async () => {
    delete process.env.APP_URL;
    process.env.RENDER_EXTERNAL_URL = 'https://rastro.onrender.com/';
    db.query.mockImplementation(async sql =>
      sql.startsWith('SELECT id, email FROM users')
        ? { rows: [{ id: 'u-9', email: 'ana@test.local' }] }
        : { rows: [] }
    );
    await conIp(pedir(app).post('/api/auth/forgot')).send({ email: buzon() });

    expect(mailer.sendMail.mock.calls[0][0].text).toContain('https://rastro.onrender.com/?reset=');
  });

  it('un APP_URL en blanco no cuenta como configurado', async () => {
    process.env.APP_URL = '   ';
    delete process.env.RENDER_EXTERNAL_URL;
    db.query.mockImplementation(async sql =>
      sql.startsWith('SELECT id, email FROM users')
        ? { rows: [{ id: 'u-9', email: 'ana@test.local' }] }
        : { rows: [] }
    );
    await conIp(pedir(app).post('/api/auth/forgot')).send({ email: buzon() });

    expect(mailer.sendMail.mock.calls[0][0].text).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\?reset=/);
  });

  it('en desarrollo, sin URL configurada, el enlace usa el host de la petición', async () => {
    delete process.env.APP_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    db.query.mockImplementation(async sql =>
      sql.startsWith('SELECT id, email FROM users')
        ? { rows: [{ id: 'u-9', email: 'ana@test.local' }] }
        : { rows: [] }
    );
    await conIp(pedir(app).post('/api/auth/forgot')).send({ email: buzon() });

    expect(mailer.sendMail.mock.calls[0][0].text).toMatch(/http:\/\/127\.0\.0\.1:\d+\/\?reset=[0-9a-f]{64}/);
  });

  it('en producción sin APP_URL ni RENDER_EXTERNAL_URL responde 503 y no guarda nada', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.APP_URL;
    delete process.env.RENDER_EXTERNAL_URL;
    db.query.mockImplementation(async sql =>
      sql.startsWith('SELECT id, email FROM users')
        ? { rows: [{ id: 'u-9', email: 'ana@test.local' }] }
        : { rows: [] }
    );
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await conIp(pedir(app).post('/api/auth/forgot')).send({ email: buzon() });

    expect(res.status).toBe(503);
    expect(res.body).toStrictEqual(MENSAJE_SIN_CONFIGURAR);
    expect(error.mock.calls[0][0]).toBe('[auth/forgot]');
    expect(db.query).toHaveBeenCalledTimes(1); // solo el SELECT de la cuenta
    expect(mailer.sendMail).not.toHaveBeenCalled();
    error.mockRestore();
  });

  it('si el correo no sale, la respuesta sigue siendo la misma', async () => {
    db.query.mockImplementation(async sql =>
      sql.startsWith('SELECT id, email FROM users')
        ? { rows: [{ id: 'u-9', email: 'ana@test.local' }] }
        : { rows: [] }
    );
    mailer.sendMail.mockRejectedValue(new Error('sin servidor de correo'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await conIp(pedir(app).post('/api/auth/forgot')).send({ email: buzon() });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true, message: MENSAJE_SIN_CUENTA });
    expect(error.mock.calls[0]).toStrictEqual([
      'No se pudo enviar el correo de recuperación:',
      'sin servidor de correo'
    ]);
    error.mockRestore();
  });

  it('un fallo de la base responde 500', async () => {
    db.query.mockImplementation(async () => {
      throw new Error('caída al buscar la cuenta');
    });
    const res = await conIp(pedir(app).post('/api/auth/forgot')).send({ email: buzon() });

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
  });
});

describe('POST /reset · validaciones', () => {
  it('sin cuerpo responde 400 con el error de validación del token', async () => {
    const res = await conIp(pedir(app).post('/api/auth/reset')).send();

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Invalid value' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un token demasiado corto, demasiado largo o no textual se rechaza', async () => {
    for (const token of ['x'.repeat(31), 'x'.repeat(129), 42, null, { a: 1 }]) {
      const res = await conIp(pedir(app).post('/api/auth/reset')).send({
        token,
        password: NUEVA_PASSWORD
      });

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual({ error: 'Invalid value' });
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it('los largos del límite (32 y 128) sí llegan a la base', async () => {
    for (const largo of [32, 128]) {
      const token = 'x'.repeat(largo);
      const res = await conIp(pedir(app).post('/api/auth/reset')).send({
        token,
        password: NUEVA_PASSWORD
      });

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(MENSAJE_ENLACE);
      expect(db.query).toHaveBeenCalledWith(SQL_RESET, [hashDeReset(token)]);
    }
  });

  it('una contraseña corta se rechaza aunque el token sea válido', async () => {
    db.query.mockImplementation(async sql =>
      sql.includes('SELECT * FROM password_resets')
        ? { rows: [{ user_id: 'u-9', used: false, expires_at: Date.now() + 60000 }] }
        : { rows: [] }
    );
    const res = await conIp(pedir(app).post('/api/auth/reset')).send({
      token: 'a'.repeat(64),
      password: 'corta'
    });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MENSAJE_PASSWORD);
    // La validación del cuerpo corta antes de consultar el token.
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('POST /reset · tokens inválidos', () => {
  function conTokenGuardado(registro) {
    db.query.mockImplementation(async sql =>
      sql.includes('SELECT * FROM password_resets') ? { rows: registro ? [registro] : [] } : { rows: [] }
    );
  }

  it('un token que no está en la base se rechaza sin cambiar nada', async () => {
    conTokenGuardado(null);
    const res = await conIp(pedir(app).post('/api/auth/reset')).send({
      token: 'b'.repeat(64),
      password: NUEVA_PASSWORD
    });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MENSAJE_ENLACE);
    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query).toHaveBeenCalledWith(SQL_RESET, [hashDeReset('b'.repeat(64))]);
  });

  it('un token ya usado se rechaza (aunque no haya caducado)', async () => {
    conTokenGuardado({ user_id: 'u-9', used: true, expires_at: Date.now() + 600000 });
    const res = await conIp(pedir(app).post('/api/auth/reset')).send({
      token: 'c'.repeat(64),
      password: NUEVA_PASSWORD
    });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MENSAJE_ENLACE);
    expect(db.query).not.toHaveBeenCalledWith(SQL_ACTUALIZAR_USUARIO, expect.anything());
  });

  it('un token caducado se rechaza', async () => {
    conTokenGuardado({ user_id: 'u-9', used: false, expires_at: Date.now() - 1 });
    const res = await conIp(pedir(app).post('/api/auth/reset')).send({
      token: 'd'.repeat(64),
      password: NUEVA_PASSWORD
    });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MENSAJE_ENLACE);
    expect(db.query.mock.calls).toHaveLength(1);
  });
});

describe('POST /reset · cambio de contraseña', () => {
  const CRUDO = 'e'.repeat(64);

  function prepararReset(expiraEn = 60000) {
    db.query.mockImplementation(async sql =>
      sql.includes('SELECT * FROM password_resets')
        ? {
            rows: [
              { token: hashDeReset(CRUDO), user_id: 'u-9', used: false, expires_at: Date.now() + expiraEn }
            ]
          }
        : { rows: [] }
    );
  }

  it('actualiza el hash, marca el token y sube token_version para cerrar sesiones', async () => {
    prepararReset();
    const res = await conIp(pedir(app).post('/api/auth/reset')).send({
      token: CRUDO,
      password: NUEVA_PASSWORD
    });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      ok: true,
      message: 'Contraseña actualizada. Ya puedes iniciar sesión.'
    });
    expect(db.query.mock.calls.map(([sql]) => sql)).toStrictEqual([
      SQL_RESET,
      SQL_ACTUALIZAR_USUARIO,
      SQL_MARCAR_RESET
    ]);
    expect(db.query.mock.calls[0][1]).toStrictEqual([hashDeReset(CRUDO)]);
    expect(db.query.mock.calls[2][1]).toStrictEqual([hashDeReset(CRUDO)]);

    const [hash, id] = db.query.mock.calls[1][1];
    expect(id).toBe('u-9');
    expect(hash).toMatch(/^\$2[ab]\$12\$/);
    expect(bcrypt.compareSync(NUEVA_PASSWORD, hash)).toBe(true);
    expect(bcrypt.compareSync(PASSWORD, hash)).toBe(false);
    // El token en claro nunca se guarda ni se compara contra la base.
    expect(db.query).not.toHaveBeenCalledWith(SQL_RESET, [CRUDO]);
  });

  it('un token que caduca justo después de usarse ya no sirve dos veces', async () => {
    prepararReset(-1);
    const res = await conIp(pedir(app).post('/api/auth/reset')).send({
      token: CRUDO,
      password: NUEVA_PASSWORD
    });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MENSAJE_ENLACE);
    expect(db.query).not.toHaveBeenCalledWith(SQL_ACTUALIZAR_USUARIO, expect.anything());
  });

  it('un fallo de la base al guardar responde 500', async () => {
    db.query.mockImplementation(async sql => {
      if (sql.includes('SELECT * FROM password_resets')) {
        return { rows: [{ user_id: 'u-9', used: false, expires_at: Date.now() + 60000 }] };
      }
      throw new Error('caída al actualizar');
    });
    const res = await conIp(pedir(app).post('/api/auth/reset')).send({
      token: CRUDO,
      password: NUEVA_PASSWORD
    });

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
  });
});
