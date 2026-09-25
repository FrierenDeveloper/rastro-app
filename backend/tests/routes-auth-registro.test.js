// Pruebas del registro, del captcha liviano y de la confirmación de correo
// (backend/routes/auth.js: GET /challenge, POST /register, GET /verify y
// POST /resend-verification).
//
// INFRAESTRUCTURA DE VALIDACIÓN: no se modifica ni una línea de producción. El
// router se importa de forma ESTÁTICA (para que Stryker lo relacione con estas
// pruebas vía `vitest related`) y sus dependencias (db, mailer) se sustituyen
// con los dobles de ./helpers/aislar.js, que se importa ANTES.
//
// NOTAS DE MONTAJE:
//   * server.js cierra los errores con su propio manejador; aquí se replica el
//     mismo cuerpo JSON para poder afirmar el 500 (Express, sin manejador,
//     devuelve HTML y el cuerpo se pierde).
//   * Los rate limits del router son reales y viven a nivel de módulo: cada
//     petición sale con una IP distinta en x-forwarded-for (TRUST_PROXY=1) y
//     cada prueba usa un buzón nuevo, para no chocar con el 429 que dejan las
//     pruebas anteriores (cupo por IP: 20; cupo por cuenta: 10).
//   * El captcha exige >= 1500 ms entre el reto y la respuesta. Los retos se
//     construyen con la misma firma HMAC que usa el router (se comprueba en la
//     primera prueba) y con el sello de tiempo ya envejecido; para los bordes
//     exactos se congela el reloj con vi.setSystemTime (sin fake timers, para
//     que el servidor HTTP de supertest siga funcionando).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { db, mailer, crearApp, pedir, tokenPara } from './helpers/aislar.js';
import authRouter from '../routes/auth.js';

const app = crearApp({ '/api/auth': authRouter });
app.use((err, req, res, _next) =>
  res.status(err.status || 500).json({ error: 'Ocurrió un error en el servidor.' })
);

const MENSAJE_CAPTCHA = { error: 'La verificación anti-spam falló. Recarga la página e inténtalo de nuevo.' };
const MENSAJE_HONEYPOT = { error: 'No se pudo validar el formulario.' };
const MENSAJE_CORREO = { error: 'Correo inválido.' };
const MENSAJE_TEMPORAL = { error: 'Usa un correo permanente; no aceptamos correos temporales.' };
const MENSAJE_PASSWORD = { error: 'La contraseña debe tener al menos 10 caracteres.' };
const MENSAJE_DUPLICADO = { error: 'Ya existe una cuenta con ese correo.' };
const MENSAJE_500 = { error: 'Ocurrió un error en el servidor.' };
const MENSAJE_401 = { error: 'No autenticado.' };
const SQL_BUSCAR = 'SELECT id FROM users WHERE email = $1 OR normalizar_correo(email) = $2';
const SQL_VERIFICACION = 'SELECT * FROM email_verifications WHERE token = $1';
const SIN_CONFIRMAR = { error: 'Sesión inválida o expirada.' };
const PASSWORD = 'contrasena-larga-de-prueba';

// Cada petición, desde una IP distinta: así el cupo del authLimiter no se llena.
let visitas = 0;
function conIp(peticion) {
  visitas += 1;
  return peticion.set('x-forwarded-for', `10.60.${Math.floor(visitas / 250)}.${visitas % 250}`);
}

// Cada prueba, con su propio buzón: el cupo por cuenta es de 10 cada 15 minutos.
let cuentas = 0;
function buzon() {
  cuentas += 1;
  return `persona-${cuentas}@test.local`;
}

// Firma idéntica a la del router: HMAC-SHA256 del payload con JWT_SECRET,
// recortada a 32 caracteres hexadecimales.
function firmaDelReto(payload) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(payload).digest('hex').slice(0, 32);
}

function retoFirmado(sello) {
  const payload = `${sello}.${crypto.randomBytes(8).toString('hex')}`;
  return `${payload}.${firmaDelReto(payload)}`;
}

// Reto con la antigüedad indicada: 2000 ms ya supera el mínimo de 1500 ms.
function retoVigente(edadMs = 2000) {
  return retoFirmado(Date.now() - edadMs);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Devuelve [sql, parametros] de la primera consulta que contiene el fragmento.
function consultaCon(fragmento) {
  const encontrada = db.query.mock.calls.find(([sql]) => sql.includes(fragmento));
  if (!encontrada) throw new Error(`No hubo ninguna consulta con: ${fragmento}`);
  return encontrada;
}

// Base falsa para un registro: el SELECT de duplicados y el INSERT de la cuenta.
function prepararBase({ existe = false, inserta = true, fallaEn } = {}) {
  db.query.mockImplementation(async sql => {
    if (fallaEn === 'select' && sql.includes('SELECT id FROM users')) throw new Error('caída al buscar');
    if (sql.includes('SELECT id FROM users')) return { rows: existe ? [{ id: 'cuenta-previa' }] : [] };
    if (sql.includes('INSERT INTO users')) {
      if (fallaEn === 'insert') throw new Error('caída al insertar');
      return { rows: inserta ? [{ id: 'cuenta-nueva' }] : [] };
    }
    return { rows: [] };
  });
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
  mailer.usingEmail = true;
});

describe('GET /challenge', () => {
  it('entrega un reto con sello de tiempo, azar y firma HMAC del servidor', async () => {
    const res = await conIp(pedir(app).get('/api/auth/challenge'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ challenge: expect.any(String) });

    const [sello, azar, firma] = res.body.challenge.split('.');
    expect(Math.abs(Number(sello) - Date.now())).toBeLessThan(5000);
    expect(azar).toMatch(/^[0-9a-f]{16}$/);
    expect(firma).toBe(firmaDelReto(`${sello}.${azar}`));
    expect(db.query).not.toHaveBeenCalled();
  });

  it('cada llamada entrega un reto distinto', async () => {
    const uno = await conIp(pedir(app).get('/api/auth/challenge'));
    const dos = await conIp(pedir(app).get('/api/auth/challenge'));

    expect(uno.body.challenge).not.toBe(dos.body.challenge);
  });

  it('el reto del endpoint se acepta en /register cuando pasa el tiempo mínimo', async () => {
    const ahora = Date.now();
    vi.setSystemTime(ahora);
    const reto = (await conIp(pedir(app).get('/api/auth/challenge'))).body.challenge;
    vi.setSystemTime(ahora + 2000);
    prepararBase();

    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: reto
    });

    expect(res.status).toBe(201);
  });
});

describe('POST /register · captcha y honeypot', () => {
  it('sin cuerpo responde 400 anti-spam y no toca la base', async () => {
    const res = await conIp(pedir(app).post('/api/auth/register')).send();

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MENSAJE_CAPTCHA);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un captcha ausente, nulo, numérico o demasiado largo se rechaza', async () => {
    for (const captcha of [undefined, null, 12345, 'x'.repeat(201)]) {
      const res = await conIp(pedir(app).post('/api/auth/register')).send({
        email: buzon(),
        password: PASSWORD,
        captcha
      });

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(MENSAJE_CAPTCHA);
    }
  });

  it('una firma manipulada se rechaza (misma longitud y longitud distinta)', async () => {
    const vigente = retoVigente();
    const partes = vigente.split('.');
    const firmaFalsa = (partes[2][0] === 'a' ? 'b' : 'a') + partes[2].slice(1);

    const igualLongitud = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: `${partes[0]}.${partes[1]}.${firmaFalsa}`
    });
    const otraLongitud = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: `${partes[0]}.${partes[1]}.corta`
    });

    expect(igualLongitud.status).toBe(400);
    expect(igualLongitud.body).toStrictEqual(MENSAJE_CAPTCHA);
    expect(otraLongitud.status).toBe(400);
    expect(otraLongitud.body).toStrictEqual(MENSAJE_CAPTCHA);
  });

  it('un reto sin punto o con sello de tiempo no numérico se rechaza aunque la firma sea válida', async () => {
    const sinPunto = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: firmaDelReto('sin-punto')
    });
    const payload = 'abc.0123456789abcdef';
    const selloMalo = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: `${payload}.${firmaDelReto(payload)}`
    });

    expect(sinPunto.status).toBe(400);
    expect(sinPunto.body).toStrictEqual(MENSAJE_CAPTCHA);
    expect(selloMalo.status).toBe(400);
    expect(selloMalo.body).toStrictEqual(MENSAJE_CAPTCHA);
  });

  it('un reto recién emitido se rechaza por ir demasiado rápido', async () => {
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: retoFirmado(Date.now())
    });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MENSAJE_CAPTCHA);
  });

  it('a los 1499 ms el reto todavía no sirve y a los 1500 ms sí', async () => {
    const ahora = Date.now();
    vi.setSystemTime(ahora);
    const temprano = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: retoFirmado(ahora - 1499)
    });
    const justo = await conIp(pedir(app).post('/api/auth/register')).send({
      email: 'no-es-un-correo',
      password: PASSWORD,
      captcha: retoFirmado(ahora - 1500)
    });

    // A los 1499 ms ni siquiera pasa del captcha; a los 1500 ms ya llega a las
    // validaciones del cuerpo, que es lo que se afirma con el mensaje.
    expect(temprano.status).toBe(400);
    expect(temprano.body).toStrictEqual(MENSAJE_CAPTCHA);
    expect(justo.status).toBe(400);
    expect(justo.body).toStrictEqual(MENSAJE_CORREO);
  });

  it('un reto caducado (más de 30 minutos) se rechaza y el del límite exacto sirve', async () => {
    const ahora = Date.now();
    vi.setSystemTime(ahora);
    const mediaHora = 30 * 60 * 1000;
    const caducado = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: retoFirmado(ahora - mediaHora - 1)
    });
    const enElLimite = await conIp(pedir(app).post('/api/auth/register')).send({
      email: 'no-es-un-correo',
      password: PASSWORD,
      captcha: retoFirmado(ahora - mediaHora)
    });

    expect(caducado.status).toBe(400);
    expect(caducado.body).toStrictEqual(MENSAJE_CAPTCHA);
    expect(enElLimite.status).toBe(400);
    expect(enElLimite.body).toStrictEqual(MENSAJE_CORREO);
  });

  it('un reto solo sirve una vez', async () => {
    // Nota sobre mutación: la limpieza de `retosUsados` cuando el Map pasa de
    // 5000 entradas NO es observable desde fuera. Solo borra retos con más de 30
    // minutos, y esos ya los rechaza la comprobación de caducidad; por eso no hay
    // prueba que la mate (harían falta más de 5000 retos válidos distintos).
    prepararBase();
    const captcha = retoVigente();
    const primera = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha
    });
    db.query.mockClear();
    const segunda = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha
    });

    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(400);
    expect(segunda.body).toStrictEqual(MENSAJE_CAPTCHA);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('el honeypot relleno bloquea el registro sin tocar la base', async () => {
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: retoVigente(),
      website: '  http://spam.example  '
    });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MENSAJE_HONEYPOT);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('el honeypot vacío, en blanco o no textual no bloquea el formulario', async () => {
    for (const website of ['', '   ', 42, null, { url: 'x' }]) {
      const res = await conIp(pedir(app).post('/api/auth/register')).send({
        email: 'no-es-un-correo',
        password: PASSWORD,
        captcha: retoVigente(),
        website
      });

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(MENSAJE_CORREO);
    }
  });
});

describe('POST /register · validaciones del cuerpo', () => {
  it('sin correo responde 400 con el mensaje del correo', async () => {
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      password: PASSWORD,
      captcha: retoVigente()
    });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MENSAJE_CORREO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un correo con formato inválido no llega a la base', async () => {
    for (const email of ['no-es-correo', 'a@', '@b.com', 'a b@c.com', 42]) {
      const res = await conIp(pedir(app).post('/api/auth/register')).send({
        email,
        password: PASSWORD,
        captcha: retoVigente()
      });

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(MENSAJE_CORREO);
    }
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un correo temporal conocido no crea una cuenta', async () => {
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: 'persona@mailinator.com',
      password: PASSWORD,
      captcha: retoVigente()
    });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MENSAJE_TEMPORAL);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('una contraseña de 9 caracteres se rechaza; la de 10 justos se acepta', async () => {
    prepararBase();
    const corta = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: '123456789',
      captcha: retoVigente()
    });
    const justa = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: '1234567890',
      captcha: retoVigente()
    });

    expect(corta.status).toBe(400);
    expect(corta.body).toStrictEqual(MENSAJE_PASSWORD);
    expect(justa.status).toBe(201);
  });

  it('sin contraseña responde con el mensaje de la contraseña', async () => {
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      captcha: retoVigente()
    });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(MENSAJE_PASSWORD);
  });

  it('un teléfono de 41 caracteres se rechaza y el de 40 se acepta', async () => {
    prepararBase();
    const largo = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      phone: 'x'.repeat(41),
      captcha: retoVigente()
    });
    const justo = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      phone: 'x'.repeat(40),
      captcha: retoVigente()
    });

    expect(largo.status).toBe(400);
    expect(largo.body).toStrictEqual({ error: 'Invalid value' });
    expect(justo.status).toBe(201);
  });

  it('un cuerpo JSON nulo no se puede parsear y responde 400', async () => {
    // express.json() es estricto: "null" no es objeto ni array, así que falla
    // antes de llegar al router (el 400 lo produce el parser, no la ruta).
    const res = await conIp(pedir(app).post('/api/auth/register'))
      .set('Content-Type', 'application/json')
      .send('null');

    expect(res.status).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
  });
});

describe('POST /register · cuentas duplicadas', () => {
  it('si el correo ya existe responde 409', async () => {
    prepararBase({ existe: true });
    const correo = buzon();
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: correo,
      password: PASSWORD,
      captcha: retoVigente()
    });

    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual(MENSAJE_DUPLICADO);
    expect(db.query).toHaveBeenCalledWith(SQL_BUSCAR, [correo, correo]);
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO users'),
      expect.anything()
    );
  });

  it('el mismo buzón con +alias de Gmail también cuenta como duplicado', async () => {
    prepararBase({ existe: true });
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: 'Victima+otro@gmail.com',
      password: PASSWORD,
      captcha: retoVigente()
    });

    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual(MENSAJE_DUPLICADO);
    // normalizeEmail() deja el correo sin puntos ni "+alias"; la cuenta que
    // compara la base es la misma.
    expect(db.query).toHaveBeenCalledWith(SQL_BUSCAR, ['victima@gmail.com', 'victima@gmail.com']);
  });

  it('en un dominio propio el alias se cuenta como el mismo buzón pero se guarda entero', async () => {
    prepararBase();
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: 'Ana+Perro@Example.COM',
      password: PASSWORD,
      captcha: retoVigente()
    });

    expect(res.status).toBe(201);
    expect(db.query).toHaveBeenCalledWith(SQL_BUSCAR, ['ana+perro@example.com', 'ana@example.com']);
    expect(consultaCon('INSERT INTO users')[1][1]).toBe('ana+perro@example.com');
  });

  it('si el INSERT choca con el índice único (23505) responde 409', async () => {
    db.query.mockImplementation(async sql => {
      if (sql.includes('SELECT id FROM users')) return { rows: [] };
      const error = new Error('llave duplicada');
      error.code = '23505';
      throw error;
    });
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: retoVigente()
    });

    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual(MENSAJE_DUPLICADO);
  });

  it('si el INSERT no devuelve filas (ON CONFLICT DO NOTHING) responde 409', async () => {
    prepararBase({ inserta: false });
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: retoVigente()
    });

    expect(res.status).toBe(409);
    expect(res.body).toStrictEqual(MENSAJE_DUPLICADO);
  });
});

describe('POST /register · cuenta creada', () => {
  it('responde 201 con el usuario, el correo en minúsculas y un token de 7 días', async () => {
    prepararBase();
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: 'Ana.B@Example.COM',
      password: PASSWORD,
      phone: '  +56 9 1234 5678  ',
      captcha: retoVigente()
    });

    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toStrictEqual(['token', 'user']);
    expect(res.body.user).toStrictEqual({
      id: expect.stringMatching(UUID),
      email: 'ana.b@example.com',
      phone: '+56 9 1234 5678',
      email_verified: false
    });

    const payload = jwt.verify(res.body.token, process.env.JWT_SECRET);
    expect(payload.sub).toBe(res.body.user.id);
    expect(payload.ver).toBe(0);
    expect(payload.exp - payload.iat).toBe(7 * 24 * 60 * 60);
  });

  it('guarda el hash bcrypt de 12 rondas y todos los campos del INSERT', async () => {
    prepararBase();
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: retoVigente()
    });
    const [sql, parametros] = consultaCon('INSERT INTO users');

    expect(sql).toContain('INSERT INTO users (id, email, password_hash, phone, email_verified, created_at)');
    expect(sql).toContain('VALUES ($1,$2,$3,$4,$5,$6)');
    expect(sql).toContain('ON CONFLICT (email) DO NOTHING');
    expect(sql).toContain('RETURNING id');
    expect(parametros).toHaveLength(6);
    expect(parametros[0]).toMatch(UUID);
    expect(parametros[2]).toMatch(/^\$2[ab]\$12\$/);
    expect(bcrypt.compareSync(PASSWORD, parametros[2])).toBe(true);
    expect(bcrypt.compareSync('otra-contraseña-larga', parametros[2])).toBe(false);
    expect(parametros[3]).toBeNull();
    expect(parametros[5]).toBeLessThanOrEqual(Date.now());
    expect(res.status).toBe(201);
  });

  it('el token de sesión se firma para el id insertado', async () => {
    prepararBase();
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: retoVigente()
    });

    expect(jwt.verify(res.body.token, process.env.JWT_SECRET).sub).toBe(
      consultaCon('INSERT INTO users')[1][0]
    );
  });

  it('un teléfono en blanco se guarda como null, no como cadena vacía', async () => {
    prepararBase();
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      phone: '   ',
      captcha: retoVigente()
    });

    expect(res.status).toBe(201);
    expect(res.body.user.phone).toBeNull();
    expect(consultaCon('INSERT INTO users')[1][3]).toBeNull();
  });
});

describe('POST /register · correo de confirmación', () => {
  it('con proveedor de correo la cuenta nace sin verificar y se manda el enlace', async () => {
    prepararBase();
    const correo = buzon();
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: correo,
      password: PASSWORD,
      captcha: retoVigente()
    });
    const id = consultaCon('INSERT INTO users')[1][0];

    expect(res.status).toBe(201);
    expect(res.body.user.email_verified).toBe(false);
    expect(consultaCon('INSERT INTO users')[1][4]).toBe(false);
    expect(consultaCon('UPDATE email_verifications')).toStrictEqual([
      'UPDATE email_verifications SET used = TRUE WHERE user_id = $1 AND used = FALSE',
      [id]
    ]);

    // El enlace lleva el token en claro; en la base solo va su SHA-256.
    const [sqlInsercion, parametros] = consultaCon('INSERT INTO email_verifications');
    expect(sqlInsercion).toContain(
      'INSERT INTO email_verifications (token, user_id, expires_at, used, created_at)'
    );
    expect(sqlInsercion).toContain('VALUES ($1,$2,$3,FALSE,$4)');
    expect(parametros[1]).toBe(id);
    expect(parametros[3]).toBeLessThanOrEqual(Date.now());

    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    const aviso = mailer.sendMail.mock.calls[0][0];
    expect(aviso.to).toBe(correo);
    expect(aviso.subject).toBe('Confirma tu correo en PetSeñal');
    // El enlace debe apuntar al endpoint que verifica en el servidor. Antes
    // apuntaba a `/?verify=<token>`, un parámetro que la app nunca leía: se
    // abría la portada y la cuenta quedaba sin verificar.
    const enlace = aviso.text.match(/\/api\/auth\/verify\?token=([0-9a-f]{64})/);
    expect(enlace).not.toBeNull();
    expect(aviso.text).not.toContain('/?verify=');
    expect(parametros[0]).toBe(crypto.createHash('sha256').update(enlace[1]).digest('hex'));
    // expires_at y created_at son dos Date.now() distintos: la diferencia es de
    // 24 horas salvo el milisegundo que pueda pasar entre las dos llamadas.
    expect(parametros[2] - parametros[3]).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
    expect(parametros[2] - parametros[3]).toBeGreaterThan(24 * 60 * 60 * 1000 - 1000);
    expect(aviso.text).toContain('El enlace vence en 24 horas.');
  });

  it('sin proveedor de correo la cuenta nace verificada y no se manda nada', async () => {
    mailer.usingEmail = false;
    prepararBase();
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: retoVigente()
    });

    expect(res.status).toBe(201);
    expect(res.body.user.email_verified).toBe(true);
    expect(consultaCon('INSERT INTO users')[1][4]).toBe(true);
    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('email_verifications'),
      expect.anything()
    );
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('si el envío del correo falla el registro sigue respondiendo 201', async () => {
    prepararBase();
    mailer.sendMail.mockRejectedValue(new Error('sin servidor de correo'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: retoVigente()
    });

    expect(res.status).toBe(201);
    expect(error.mock.calls[0]).toStrictEqual([
      'No se pudo enviar el correo de verificación:',
      'sin servidor de correo'
    ]);
    error.mockRestore();
  });
});

describe('POST /register · errores de la base', () => {
  it('un fallo al buscar el correo responde 500', async () => {
    prepararBase({ fallaEn: 'select' });
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: retoVigente()
    });

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
  });

  it('un fallo al insertar la cuenta responde 500', async () => {
    prepararBase({ fallaEn: 'insert' });
    const res = await conIp(pedir(app).post('/api/auth/register')).send({
      email: buzon(),
      password: PASSWORD,
      captcha: retoVigente()
    });

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
  });
});

describe('GET /verify', () => {
  it('sin token vuelve a la app con verified=0 y no consulta la base', async () => {
    const res = await conIp(pedir(app).get('/api/auth/verify'));

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?verified=0');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un token repetido en la query (array) no se acepta como texto', async () => {
    const res = await conIp(pedir(app).get('/api/auth/verify?token=a&token=b'));

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?verified=0');
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un token inexistente vuelve con verified=0 y se busca por su hash', async () => {
    const crudo = 'a'.repeat(64);
    const res = await conIp(pedir(app).get(`/api/auth/verify?token=${crudo}`));

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?verified=0');
    expect(db.query).toHaveBeenCalledWith(SQL_VERIFICACION, [
      crypto.createHash('sha256').update(crudo).digest('hex')
    ]);
  });

  it('un token ya usado vuelve con verified=0 y no marca nada', async () => {
    db.query.mockImplementation(async sql =>
      sql.includes('SELECT * FROM email_verifications')
        ? { rows: [{ user_id: 'u1', used: true, expires_at: Date.now() + 60000 }] }
        : { rows: [] }
    );
    const res = await conIp(pedir(app).get(`/api/auth/verify?token=${'b'.repeat(64)}`));

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?verified=0');
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('un token caducado vuelve con verified=0', async () => {
    db.query.mockImplementation(async sql =>
      sql.includes('SELECT * FROM email_verifications')
        ? { rows: [{ user_id: 'u1', used: false, expires_at: Date.now() - 1 }] }
        : { rows: [] }
    );
    const res = await conIp(pedir(app).get(`/api/auth/verify?token=${'c'.repeat(64)}`));

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?verified=0');
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('un token válido marca el correo y el token, y vuelve con verified=1', async () => {
    db.query.mockImplementation(async sql =>
      sql.includes('SELECT * FROM email_verifications')
        ? { rows: [{ user_id: 'u-verificado', used: false, expires_at: Date.now() + 60000 }] }
        : { rows: [] }
    );
    const crudo = 'd'.repeat(64);
    const res = await conIp(pedir(app).get(`/api/auth/verify?token=${crudo}`));

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?verified=1');
    expect(db.query.mock.calls.map(([sql]) => sql)).toStrictEqual([
      SQL_VERIFICACION,
      'UPDATE users SET email_verified = TRUE WHERE id = $1',
      'UPDATE email_verifications SET used = TRUE WHERE token = $1'
    ]);
    expect(db.query.mock.calls[1][1]).toStrictEqual(['u-verificado']);
    expect(db.query.mock.calls[2][1]).toStrictEqual([
      crypto.createHash('sha256').update(crudo).digest('hex')
    ]);
  });

  it('un fallo de la base responde 500', async () => {
    db.query.mockImplementation(async () => {
      throw new Error('caída al verificar');
    });
    const res = await conIp(pedir(app).get(`/api/auth/verify?token=${'e'.repeat(64)}`));

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
  });
});

describe('POST /resend-verification', () => {
  // requireAuth pide token_version; `usuario` responde a la consulta de la ruta.
  function prepararSesion(usuario) {
    db.query.mockImplementation(async sql => {
      if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
      if (sql.includes('SELECT id, email, email_verified FROM users')) {
        return { rows: usuario ? [usuario] : [] };
      }
      return { rows: [] };
    });
  }

  it('sin token responde 401 y no toca la base', async () => {
    const res = await conIp(pedir(app).post('/api/auth/resend-verification'));

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(MENSAJE_401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un token que no es un JWT responde 401', async () => {
    const res = await conIp(pedir(app).post('/api/auth/resend-verification')).set(
      'Authorization',
      'Bearer no-es-un-jwt'
    );

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SIN_CONFIRMAR);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un usuario que ya no existe responde 404', async () => {
    prepararSesion(null);
    const res = await conIp(pedir(app).post('/api/auth/resend-verification')).set(
      'Authorization',
      `Bearer ${tokenPara('fantasma')}`
    );

    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({ error: 'Usuario no encontrado.' });
    expect(db.query).toHaveBeenLastCalledWith('SELECT id, email, email_verified FROM users WHERE id = $1', [
      'fantasma'
    ]);
  });

  it('si el correo ya está confirmado no manda nada', async () => {
    prepararSesion({ id: 'u1', email: 'a@test.local', email_verified: true });
    const res = await conIp(pedir(app).post('/api/auth/resend-verification')).set(
      'Authorization',
      `Bearer ${tokenPara('u1')}`
    );

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true, message: 'Tu correo ya está confirmado.' });
    expect(mailer.sendMail).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('si falta confirmar reenvía el correo y crea un token nuevo', async () => {
    prepararSesion({ id: 'u1', email: 'a@test.local', email_verified: false });
    const res = await conIp(pedir(app).post('/api/auth/resend-verification')).set(
      'Authorization',
      `Bearer ${tokenPara('u1')}`
    );

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true, message: 'Te enviamos un correo de confirmación.' });
    expect(consultaCon('UPDATE email_verifications')).toStrictEqual([
      'UPDATE email_verifications SET used = TRUE WHERE user_id = $1 AND used = FALSE',
      ['u1']
    ]);
    expect(consultaCon('INSERT INTO email_verifications')[1][1]).toBe('u1');
    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    expect(mailer.sendMail.mock.calls[0][0].to).toBe('a@test.local');
  });

  it('sin proveedor de correo confirma la cuenta directamente', async () => {
    mailer.usingEmail = false;
    prepararSesion({ id: 'u1', email: 'a@test.local', email_verified: false });
    const res = await conIp(pedir(app).post('/api/auth/resend-verification')).set(
      'Authorization',
      `Bearer ${tokenPara('u1')}`
    );

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true, message: 'Correo confirmado.' });
    expect(db.query).toHaveBeenCalledWith('UPDATE users SET email_verified = TRUE WHERE id = $1', ['u1']);
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it('estando ya confirmado, un fallo de la base responde 500', async () => {
    prepararSesion({ id: 'u1', email: 'a@test.local', email_verified: true });
    db.query.mockImplementation(async sql => {
      if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
      throw new Error('caída al leer el usuario');
    });
    const res = await conIp(pedir(app).post('/api/auth/resend-verification')).set(
      'Authorization',
      `Bearer ${tokenPara('u1')}`
    );

    expect(res.status).toBe(500);
    expect(res.body).toStrictEqual(MENSAJE_500);
  });
});
