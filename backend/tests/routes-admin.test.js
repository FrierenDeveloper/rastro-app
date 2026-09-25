// Pruebas de las rutas del panel de administración (backend/routes/admin.js).
//
// INFRAESTRUCTURA DE VALIDACIÓN: no se modifica ni una línea de producción. El
// router se importa de forma ESTÁTICA (para que Stryker lo relacione con estas
// pruebas vía `vitest related`) y sus dependencias (db, storage) se sustituyen
// con los dobles de ./helpers/aislar.js, que se importa ANTES.
//
// El `:id` de los tres endpoints con parámetro (`POST /reports/:id/hide`,
// `POST /reports/:id/unhide` y `DELETE /reports/:id`) se valida con
// express-validator ANTES del handler. Antes ese error de formato solo quedaba
// anotado en la request: el handler se ejecutaba igual y el id inválido llegaba
// tal cual a la consulta SQL (contra Postgres de verdad, error 22P02 → 500).
// Ahora un id que no es UUID responde 400 con JSON y no toca la base. Las
// pruebas de abajo fijan ese contrato y también el ORDEN de los middlewares:
// primero la sesión (401), después los permisos (403) y al final el formato.
//
// MUTANTES INMATABLES DE ESTE ARCHIVO (no perder tiempo con ellos): el
// condicional `(process.env.ADMIN_EMAILS || '')` de la línea 14 mutado a `true` o
// `false` deja `(true).split(',')`, que lanza TypeError AL CARGAR el módulo. Con
// el módulo roto el archivo de pruebas ni se colecta (0 pruebas ejecutadas), así
// que Stryker no puede verlo morir y lo cuenta como superviviente. Comprobado
// mutándolo a mano: la suite falla al importar. Son 2 de los 112 mutantes de
// admin.js, que por eso se queda en 98,21% y no en 100%.
vi.hoisted(() => {
  // admin.js lee ADMIN_EMAILS AL CARGARSE, y vi.hoisted corre antes que los
  // imports: así el router importado estáticamente ya ve la lista buena.
  // Lleva espacios, mayúsculas y entradas vacías a propósito: ejercita el
  // split(','), el trim, el toLowerCase y el filter(Boolean).
  process.env.ADMIN_EMAILS = ' jefa@test.local , JEFA2@Test.Local , ,';
  process.env.TRUST_PROXY = '1';
});

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { db, storage, crearApp, pedir, tokenPara, olvidar, requerir, RUTAS } from './helpers/aislar.js';
import adminRouter from '../routes/admin.js';

const app = crearApp({ '/api/admin': adminRouter });

// El valor exacto de la variable de entorno, para restaurarlo al final.
const LISTA_ADMIN = ' jefa@test.local , JEFA2@Test.Local , ,';

const SUB = 'jefa-1';
const OTRO = 'curioso-9';
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const JEFA = 'jefa@test.local';
const SQL_TOKEN = 'SELECT token_version FROM users WHERE id = $1';
const SQL_EMAIL = 'SELECT email, email_verified FROM users WHERE id = $1';
const SIN_PERMISOS = { error: 'No tienes permisos de administrador.' };
const SIN_SESION = { error: 'Sesión inválida o expirada.' };
const NO_AUTENTICADO = { error: 'No autenticado.' };

beforeEach(() => {
  db.query.mockReset();
  storage.deletePhoto.mockReset();
});

// Encoda las respuestas de la base para una petición que atraviesa requireAuth
// (token_version) y requireAdmin (email + email_verified). `resto` responde a
// las consultas propias de cada ruta; por defecto, cero filas.
function prepararBase({ version = 0, existe = true, email = JEFA, verificada = true, resto } = {}) {
  db.query.mockImplementation(async (sql, params) => {
    if (sql.includes('token_version')) return { rows: existe ? [{ token_version: version }] : [] };
    if (sql.includes('SELECT email,'))
      return { rows: email === null ? [] : [{ email, email_verified: verificada }] };
    if (resto) return resto(sql, params);
    return { rows: [] };
  });
}

// Cabecera de autenticación válida + IP distinta en cada petición (por si algún
// día estos routers montan un express-rate-limit: la clave del límite sale de
// x-forwarded-for y así ninguna prueba choca con el 429).
let visitas = 0;
function conToken(peticion, sub = SUB, ver = 0) {
  visitas += 1;
  return peticion
    .set('Authorization', `Bearer ${tokenPara(sub, ver)}`)
    .set('x-forwarded-for', `10.${Math.floor(visitas / 250)}.${visitas % 250}.9`);
}

const AVISO = {
  id: UUID,
  estado: 'perdido',
  tipo: 'perro',
  color: 'negro',
  raza: 'quiltro',
  descripcion: 'Collar rojo',
  nombre_mascota: 'Firulais',
  foto_url: '/uploads/foto.jpg',
  active: 1,
  resolved: 0,
  flags: 3,
  owner_email: 'duena@test.local',
  created_at: '1700000000000'
};

const AVISO_NORMALIZADO = {
  id: UUID,
  estado: 'perdido',
  tipo: 'perro',
  color: 'negro',
  raza: 'quiltro',
  descripcion: 'Collar rojo',
  nombre_mascota: 'Firulais',
  foto_url: '/uploads/foto.jpg',
  active: true,
  resolved: false,
  flags: 3,
  owner_email: 'duena@test.local',
  created_at: 1700000000000
};

describe('control de acceso al panel', () => {
  it('sin cabecera Authorization responde 401 y no toca la base', async () => {
    const res = await pedir(app).get('/api/admin/flagged');

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('una cabecera sin el prefijo Bearer también es 401', async () => {
    const res = await pedir(app).get('/api/admin/flagged').set('Authorization', `Token ${tokenPara()}`);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un token que no es un JWT válido es 401', async () => {
    const res = await pedir(app).get('/api/admin/users').set('Authorization', 'Bearer no-es-un-jwt');

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SIN_SESION);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un token de otra versión de sesión es 401', async () => {
    prepararBase({ version: 3 });
    const res = await conToken(pedir(app).get('/api/admin/users'), SUB, 1);

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'Tu sesión fue cerrada. Inicia sesión de nuevo.' });
    expect(db.query).toHaveBeenCalledWith(SQL_TOKEN, [SUB]);
  });

  it('una cuenta ya borrada es 401 aunque el token siga firmado', async () => {
    prepararBase({ existe: false });
    const res = await conToken(pedir(app).get('/api/admin/users'));

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(SIN_SESION);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('un usuario que no está en ADMIN_EMAILS recibe 403 y no ve datos', async () => {
    prepararBase({ email: 'curiosa@test.local' });
    const res = await conToken(pedir(app).get('/api/admin/flagged'), OTRO);

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(SIN_PERMISOS);
    expect(db.query).toHaveBeenCalledWith(SQL_TOKEN, [OTRO]);
    expect(db.query).toHaveBeenCalledWith(SQL_EMAIL, [OTRO]);
    expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining('FROM reports r'));
  });

  it('la lista de administradores no distingue mayúsculas del correo guardado', async () => {
    prepararBase({ email: 'JEFA@TEST.LOCAL' });
    const res = await conToken(pedir(app).get('/api/admin/flagged'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ reports: [] });
    expect(db.query).toHaveBeenCalledWith(SQL_EMAIL, [SUB]);
  });

  it('la segunda cuenta de la lista (con espacios alrededor) también entra', async () => {
    prepararBase({ email: 'jefa2@test.local' });
    const res = await conToken(pedir(app).get('/api/admin/users'), 'jefa-2');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ users: [] });
    expect(db.query).toHaveBeenCalledWith(SQL_EMAIL, ['jefa-2']);
  });

  it('una cuenta con el correo vacío no entra: las entradas vacías se filtran', async () => {
    // ADMIN_EMAILS trae comas de más. Sin el filter(Boolean) la lista incluiría
    // la cadena vacía y esta cuenta pasaría como administradora.
    prepararBase({ email: '' });
    const res = await conToken(pedir(app).get('/api/admin/users'), 'sin-correo');

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(SIN_PERMISOS);
  });

  // El agujero que cierra este par de pruebas: sin proveedor de correo el
  // registro nace con email_verified = true (routes/auth.js), así que bastaba
  // con registrar una dirección que estuviera en ADMIN_EMAILS para entrar al
  // panel sin verificar nada.
  it('una cuenta de ADMIN_EMAILS con el correo SIN verificar no entra', async () => {
    prepararBase({ verificada: false });
    const res = await conToken(pedir(app).get('/api/admin/users'));

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(SIN_PERMISOS);
    expect(db.query).not.toHaveBeenCalledWith(expect.stringContaining('FROM users u'));
  });

  it('un valor falsy que no sea el booleano false tampoco entra', async () => {
    // La comprobación es `!== true` a propósito: con `=== false` un 0 (que es
    // como Postgres puede devolver un booleano en algunas columnas) colaría.
    prepararBase({ verificada: 0 });
    const res = await conToken(pedir(app).get('/api/admin/users'));

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(SIN_PERMISOS);
  });

  it('si la base falla al comprobar el correo responde 500', async () => {
    db.query.mockImplementation(async sql => {
      if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
      throw new Error('sin conexión');
    });
    const res = await conToken(pedir(app).get('/api/admin/users'));

    expect(res.status).toBe(500);
  });
});

describe('GET /flagged (avisos reportados)', () => {
  it('devuelve los avisos normalizados junto al correo de su dueño', async () => {
    prepararBase({ resto: () => ({ rows: [AVISO] }) });
    const res = await conToken(pedir(app).get('/api/admin/flagged'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ reports: [AVISO_NORMALIZADO] });

    // calls[0] es token_version (requireAuth) y calls[1] el correo (requireAdmin).
    const consulta = db.query.mock.calls[2];
    expect(consulta).toHaveLength(1); // sin parámetros: no lleva segundo argumento
    expect(consulta[0]).toContain('FROM reports r JOIN users u ON u.id = r.user_id');
    expect(consulta[0]).toContain('WHERE r.flags > 0');
    expect(consulta[0]).toContain('ORDER BY r.flags DESC, r.created_at DESC');
    expect(consulta[0]).toContain('LIMIT 200');
  });

  it('un aviso sin foto, sin dueño y con nulos llega con null, no con undefined', async () => {
    const pelado = {
      id: UUID,
      estado: null,
      tipo: 'gato',
      color: null,
      raza: null,
      descripcion: null,
      nombre_mascota: null,
      active: null,
      resolved: null,
      flags: 1,
      created_at: null
    };
    prepararBase({ resto: () => ({ rows: [pelado] }) });
    const res = await conToken(pedir(app).get('/api/admin/flagged'));

    expect(res.body).toStrictEqual({
      reports: [
        {
          id: UUID,
          estado: null,
          tipo: 'gato',
          color: null,
          raza: null,
          descripcion: null,
          nombre_mascota: null,
          foto_url: null,
          active: false,
          resolved: false,
          flags: 1,
          owner_email: null,
          created_at: 0
        }
      ]
    });
  });

  it('un created_at ausente se serializa como null (Number(undefined) es NaN)', async () => {
    prepararBase({ resto: () => ({ rows: [{ id: UUID, tipo: 'perro', flags: 2 }] }) });
    const res = await conToken(pedir(app).get('/api/admin/flagged'));

    expect(res.body.reports[0].created_at).toBeNull();
    expect(res.body.reports[0].foto_url).toBeNull();
    expect(res.body.reports[0].owner_email).toBeNull();
  });

  it('sin avisos reportados devuelve una lista vacía', async () => {
    prepararBase();
    const res = await conToken(pedir(app).get('/api/admin/flagged'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ reports: [] });
  });

  it('un fallo de la base responde 500', async () => {
    prepararBase({
      resto: () => {
        throw new Error('caída del listado');
      }
    });
    const res = await conToken(pedir(app).get('/api/admin/flagged'));

    expect(res.status).toBe(500);
  });
});

describe('POST /reports/:id/hide', () => {
  it('desactiva el aviso y confirma con ok', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post(`/api/admin/reports/${UUID}/hide`));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true });
    expect(db.query).toHaveBeenCalledWith('UPDATE reports SET active = FALSE WHERE id = $1', [UUID]);
  });

  it('un id con formato inválido responde 400 y no toca la base', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post('/api/admin/reports/no-soy-un-uuid/hide'));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Identificador inválido.' });
    // Solo las consultas de los middlewares: token_version y el correo.
    expect(db.query.mock.calls.map(c => c[0])).toStrictEqual([SQL_TOKEN, SQL_EMAIL]);
  });

  it('un id literalmente "null" tampoco es un UUID', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post('/api/admin/reports/null/hide'));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Identificador inválido.' });
    expect(db.query.mock.calls.map(c => c[0])).toStrictEqual([SQL_TOKEN, SQL_EMAIL]);
  });

  it('un UUID en mayúsculas sí es válido y llega a la base', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post(`/api/admin/reports/${UUID.toUpperCase()}/hide`));

    expect(res.status).toBe(200);
    expect(db.query).toHaveBeenCalledWith('UPDATE reports SET active = FALSE WHERE id = $1', [
      UUID.toUpperCase()
    ]);
  });

  it('sin permisos de administrador el 403 manda sobre el 400 del formato', async () => {
    prepararBase({ email: 'curiosa@test.local' });
    const res = await conToken(pedir(app).post('/api/admin/reports/no-soy-un-uuid/hide'), OTRO);

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(SIN_PERMISOS);
    expect(db.query.mock.calls.map(c => c[0])).toStrictEqual([SQL_TOKEN, SQL_EMAIL]);
  });

  it('sin cabecera Authorization un id inválido responde 401 y no consulta nada', async () => {
    const res = await pedir(app).post('/api/admin/reports/no-soy-un-uuid/hide');

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un fallo de la base responde 500 y no confirma nada', async () => {
    prepararBase({
      resto: () => {
        throw new Error('caída al ocultar');
      }
    });
    const res = await conToken(pedir(app).post(`/api/admin/reports/${UUID}/hide`));

    expect(res.status).toBe(500);
  });
});

describe('POST /reports/:id/unhide', () => {
  it('reactiva el aviso, pone los flags a cero y borra los reportes', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post(`/api/admin/reports/${UUID}/unhide`));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true });
    // Las dos primeras llamadas son de los middlewares; luego van las de la ruta.
    expect(db.query.mock.calls.map(c => c[0]).slice(2)).toStrictEqual([
      'UPDATE reports SET active = TRUE, flags = 0 WHERE id = $1',
      'DELETE FROM report_flags WHERE report_id = $1'
    ]);
    expect(db.query.mock.calls[2][1]).toStrictEqual([UUID]);
    expect(db.query.mock.calls[3][1]).toStrictEqual([UUID]);
  });

  it('si falla el borrado de reportes, el aviso ya quedó reactivado', async () => {
    prepararBase({
      resto: sql => {
        if (sql.startsWith('DELETE FROM report_flags')) throw new Error('caída al limpiar');
        return { rows: [] };
      }
    });
    const res = await conToken(pedir(app).post(`/api/admin/reports/${UUID}/unhide`));

    expect(res.status).toBe(500);
    expect(db.query).toHaveBeenCalledWith('UPDATE reports SET active = TRUE, flags = 0 WHERE id = $1', [
      UUID
    ]);
    expect(db.query).toHaveBeenCalledTimes(4); // token, correo, UPDATE y DELETE fallido
  });

  it('si falla el UPDATE no intenta borrar los reportes', async () => {
    prepararBase({
      resto: sql => {
        if (sql.startsWith('UPDATE reports SET active = TRUE')) throw new Error('caída al reactivar');
        return { rows: [] };
      }
    });
    const res = await conToken(pedir(app).post(`/api/admin/reports/${UUID}/unhide`));

    expect(res.status).toBe(500);
    expect(db.query).not.toHaveBeenCalledWith('DELETE FROM report_flags WHERE report_id = $1', [UUID]);
  });

  it('un id inválido responde 400 sin reactivar nada ni limpiar reportes', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post('/api/admin/reports/1-2-3/unhide'));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Identificador inválido.' });
    expect(db.query.mock.calls.map(c => c[0])).toStrictEqual([SQL_TOKEN, SQL_EMAIL]);
  });
});

describe('DELETE /reports/:id', () => {
  const SQL_FOTOS = 'SELECT foto_url, reunion_foto_url FROM reports WHERE id = $1';
  const SQL_BORRAR = 'DELETE FROM reports WHERE id = $1';

  it('borra las dos fotos de disco y luego la fila', async () => {
    prepararBase({
      resto: sql =>
        sql.includes('SELECT foto_url')
          ? { rows: [{ foto_url: '/uploads/a.jpg', reunion_foto_url: '/uploads/b.jpg' }] }
          : { rows: [] }
    });
    const res = await conToken(pedir(app).delete(`/api/admin/reports/${UUID}`));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true });
    expect(storage.deletePhoto.mock.calls).toStrictEqual([['/uploads/a.jpg'], ['/uploads/b.jpg']]);
    expect(db.query.mock.calls.map(c => c[0]).slice(2)).toStrictEqual([SQL_FOTOS, SQL_BORRAR]);
    expect(db.query.mock.calls[2][1]).toStrictEqual([UUID]);
    expect(db.query.mock.calls[3][1]).toStrictEqual([UUID]);
  });

  it('si el aviso ya no existe no intenta borrar fotos', async () => {
    prepararBase();
    const res = await conToken(pedir(app).delete(`/api/admin/reports/${UUID}`));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true });
    expect(storage.deletePhoto).not.toHaveBeenCalled();
    expect(db.query).toHaveBeenCalledWith(SQL_BORRAR, [UUID]);
  });

  it('si las dos columnas de foto son null se pide borrar null dos veces', async () => {
    // Comportamiento actual del router: solo comprueba que la fila exista, no
    // cada URL. El storage real ignora el null, pero la llamada se hace.
    prepararBase({
      resto: sql =>
        sql.includes('SELECT foto_url')
          ? { rows: [{ foto_url: null, reunion_foto_url: null }] }
          : { rows: [] }
    });
    const res = await conToken(pedir(app).delete(`/api/admin/reports/${UUID}`));

    expect(res.status).toBe(200);
    expect(storage.deletePhoto.mock.calls).toStrictEqual([[null], [null]]);
  });

  it('si falla la lectura de las fotos no borra nada ni la fila', async () => {
    prepararBase({
      resto: sql => {
        if (sql.includes('SELECT foto_url')) throw new Error('caída al leer');
        return { rows: [] };
      }
    });
    const res = await conToken(pedir(app).delete(`/api/admin/reports/${UUID}`));

    expect(res.status).toBe(500);
    expect(storage.deletePhoto).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalledWith(SQL_BORRAR, [UUID]);
  });

  it('si falla el borrado de la fila las fotos ya se borraron y responde 500', async () => {
    prepararBase({
      resto: sql => {
        if (sql.includes('SELECT foto_url')) {
          return { rows: [{ foto_url: '/uploads/a.jpg', reunion_foto_url: null }] };
        }
        throw new Error('caída al borrar');
      }
    });
    const res = await conToken(pedir(app).delete(`/api/admin/reports/${UUID}`));

    expect(res.status).toBe(500);
    expect(storage.deletePhoto).toHaveBeenCalledWith('/uploads/a.jpg');
  });

  it('un id inválido responde 400 sin leer ni borrar nada', async () => {
    prepararBase();
    const res = await conToken(pedir(app).delete('/api/admin/reports/xxx'));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual({ error: 'Identificador inválido.' });
    expect(storage.deletePhoto).not.toHaveBeenCalled();
    expect(db.query.mock.calls.map(c => c[0])).toStrictEqual([SQL_TOKEN, SQL_EMAIL]);
  });
});

describe('GET /users', () => {
  const SQL_USUARIOS = 'SELECT u.id, u.email, u.created_at, u.email_verified';

  it('lista las cuentas con su número de avisos ya normalizado', async () => {
    prepararBase({
      resto: () => ({
        rows: [
          {
            id: 'u-1',
            email: 'ana@test.local',
            created_at: '1700000000000',
            email_verified: 1,
            reports: 4
          }
        ]
      })
    });
    const res = await conToken(pedir(app).get('/api/admin/users'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      users: [
        {
          id: 'u-1',
          email: 'ana@test.local',
          created_at: 1700000000000,
          email_verified: true,
          reports: 4
        }
      ]
    });

    const [sql] = db.query.mock.calls[2];
    expect(sql).toContain(SQL_USUARIOS);
    expect(sql).toContain('COUNT(*)::int FROM reports r WHERE r.user_id = u.id');
    expect(sql).toContain('ORDER BY u.created_at DESC');
    expect(sql).toContain('LIMIT 200');
  });

  it('marca como no verificado lo que no sea true y convierte la fecha', async () => {
    prepararBase({
      resto: () => ({
        rows: [{ id: 'u-2', email: 'bea@test.local', created_at: null, email_verified: 0, reports: 0 }]
      })
    });
    const res = await conToken(pedir(app).get('/api/admin/users'));

    expect(res.body).toStrictEqual({
      users: [{ id: 'u-2', email: 'bea@test.local', created_at: 0, email_verified: false, reports: 0 }]
    });
  });

  it('sin cuentas devuelve una lista vacía', async () => {
    prepararBase();
    const res = await conToken(pedir(app).get('/api/admin/users'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ users: [] });
  });

  it('un fallo de la base responde 500', async () => {
    prepararBase({
      resto: () => {
        throw new Error('caída del listado de usuarios');
      }
    });
    const res = await conToken(pedir(app).get('/api/admin/users'));

    expect(res.status).toBe(500);
  });
});

describe('carga del módulo sin ADMIN_EMAILS', () => {
  // El router importado arriba ya tiene la lista buena; aquí se recarga una
  // instancia aparte (permitido por el patrón) solo para este caso.
  afterAll(() => {
    process.env.ADMIN_EMAILS = LISTA_ADMIN;
    olvidar(RUTAS.routesAdmin);
    requerir(RUTAS.routesAdmin);
  });

  it('avisa por consola y deja el panel cerrado a todo el mundo', async () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.ADMIN_EMAILS;
    olvidar(RUTAS.routesAdmin);
    const cerrado = requerir(RUTAS.routesAdmin);
    const appCerrada = crearApp({ '/api/admin': cerrado });

    expect(aviso).toHaveBeenCalledTimes(1);
    expect(aviso.mock.calls[0][0]).toBe(
      '[admin] ADMIN_EMAILS no configurado: el panel de administración queda deshabilitado.'
    );

    prepararBase({ email: JEFA });
    const res = await conToken(pedir(appCerrada).get('/api/admin/flagged'));

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(SIN_PERMISOS);

    aviso.mockRestore();
  });

  // La otra cara del aviso: con la lista configurada NO debe avisar. Sin esta
  // comprobación sobrevive el mutante que convierte `if (!ADMIN_EMAILS.length)`
  // en `if (true)`: avisaría siempre y ninguna prueba lo notaba.
  it('con la lista configurada no avisa por consola', () => {
    const aviso = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.ADMIN_EMAILS = LISTA_ADMIN;
    olvidar(RUTAS.routesAdmin);
    requerir(RUTAS.routesAdmin);

    expect(aviso).not.toHaveBeenCalled();

    aviso.mockRestore();
  });
});

describe('POST /api/admin/chips/purgar', () => {
  it('sin token responde 401 y no purga nada', async () => {
    prepararBase();

    const res = await pedir(app).post('/api/admin/chips/purgar');

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('una cuenta que no es administradora responde 403 y no purga', async () => {
    prepararBase({ email: 'curiosa@test.local' });

    const res = await conToken(pedir(app).post('/api/admin/chips/purgar'), OTRO);

    expect(res.status).toBe(403);
    expect(res.body).toStrictEqual(SIN_PERMISOS);
    expect(db.query.mock.calls.some(([sql]) => String(sql).includes('DELETE FROM chip_registrations'))).toBe(
      false
    );
  });

  it('una administradora purga los registros con baja anterior al plazo', async () => {
    const purgas = [];
    prepararBase({
      resto: (sql, params) => {
        if (String(sql).startsWith('DELETE FROM chip_registrations')) {
          purgas.push(params);
          return { rows: [], rowCount: 4 };
        }
        return { rows: [] };
      }
    });

    const res = await conToken(pedir(app).post('/api/admin/chips/purgar'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ borrados: 4 });
    expect(purgas).toHaveLength(1);
    expect(purgas[0][0]).toBeLessThanOrEqual(Date.now());
  });

  it('sin nada que purgar responde 0', async () => {
    prepararBase({
      resto: sql =>
        String(sql).startsWith('DELETE FROM chip_registrations') ? { rows: [], rowCount: 0 } : { rows: [] }
    });

    const res = await conToken(pedir(app).post('/api/admin/chips/purgar'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ borrados: 0 });
  });

  it('si la base falla responde 500', async () => {
    prepararBase({
      resto: sql => {
        if (String(sql).startsWith('DELETE FROM chip_registrations')) throw new Error('base caída');
        return { rows: [] };
      }
    });

    const res = await conToken(pedir(app).post('/api/admin/chips/purgar'));

    expect(res.status).toBe(500);
  });
});
