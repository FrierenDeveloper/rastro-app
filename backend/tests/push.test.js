// Pruebas de backend/push.js.
//
// El módulo lee las claves VAPID al cargarse y habla con Postgres a través de
// db.js, que a su vez usa el Pool falso de `pg` (ver tests/helpers/externos.js).
// Así las consultas se afirman sobre poolFalso.query sin dejar la base real.
//
// El `import` estático de push.js es lo que relaciona este archivo con el módulo
// en el grafo de Vite que usa Stryker; para las distintas configuraciones de
// claves se recarga con olvidar()/requerir().
vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgres://pruebas:pruebas@localhost:5432/pruebas';
  process.env.NODE_ENV = 'test';
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { poolFalso, webpushFalso, olvidar, requerir, RUTAS } from './helpers/externos.js';
import push from '../push.js';

const CLAVE_PUBLICA = 'BPublicaDePrueba123';
const CLAVE_PRIVADA = 'PrivadaDePrueba456';
const CONSULTA = 'SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1';
const BORRADO = 'DELETE FROM push_subscriptions WHERE id = $1';

const SUSCRIPCION_1 = { id: 's-1', endpoint: 'https://push.ejemplo.cl/1', p256dh: 'p1', auth: 'a1' };
const SUSCRIPCION_2 = { id: 's-2', endpoint: 'https://push.ejemplo.cl/2', p256dh: 'p2', auth: 'a2' };

// Recarga push.js con las claves VAPID pedidas (undefined = variable ausente).
function cargarPush({ publica, privada, subject } = {}) {
  if (publica === undefined) delete process.env.VAPID_PUBLIC_KEY;
  else process.env.VAPID_PUBLIC_KEY = publica;
  if (privada === undefined) delete process.env.VAPID_PRIVATE_KEY;
  else process.env.VAPID_PRIVATE_KEY = privada;
  if (subject === undefined) delete process.env.VAPID_SUBJECT;
  else process.env.VAPID_SUBJECT = subject;

  olvidar(RUTAS.push);
  return requerir(RUTAS.push);
}

// push.js con las dos claves: el caso "activo".
function pushActivo(extra = {}) {
  return cargarPush({ publica: CLAVE_PUBLICA, privada: CLAVE_PRIVADA, ...extra });
}

beforeEach(() => {
  poolFalso.query.mockReset();
  poolFalso.query.mockResolvedValue({ rows: [] });
  webpushFalso.setVapidDetails.mockReset();
  webpushFalso.sendNotification.mockReset();
  webpushFalso.sendNotification.mockResolvedValue({});
});

afterEach(() => {
  delete process.env.VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  vi.restoreAllMocks();
});

describe('configuración VAPID al cargarse', () => {
  it('sin claves queda deshabilitado, sin clave pública y sin registrar nada', () => {
    expect(push.enabled).toBe(false);
    expect(push.publicKey).toBe('');
    expect(webpushFalso.setVapidDetails).not.toHaveBeenCalled();
  });

  it('con las dos claves registra los detalles y queda habilitado', () => {
    const pushActivoInstancia = pushActivo();

    expect(webpushFalso.setVapidDetails).toHaveBeenCalledTimes(1);
    expect(webpushFalso.setVapidDetails).toHaveBeenCalledWith(
      'mailto:contacto@example.com',
      CLAVE_PUBLICA,
      CLAVE_PRIVADA
    );
    expect(pushActivoInstancia.enabled).toBe(true);
    expect(pushActivoInstancia.publicKey).toBe(CLAVE_PUBLICA);
  });

  it('toma VAPID_SUBJECT del entorno cuando está definido', () => {
    pushActivo({ subject: 'mailto:hola@rastro.cl' });

    expect(webpushFalso.setVapidDetails).toHaveBeenCalledWith(
      'mailto:hola@rastro.cl',
      CLAVE_PUBLICA,
      CLAVE_PRIVADA
    );
  });

  it('con una sola clave también queda deshabilitado (hacen falta las dos)', () => {
    const soloPublica = cargarPush({ publica: CLAVE_PUBLICA });
    expect(webpushFalso.setVapidDetails).not.toHaveBeenCalled();
    expect(soloPublica.enabled).toBe(false);

    const soloPrivada = cargarPush({ privada: CLAVE_PRIVADA });
    expect(webpushFalso.setVapidDetails).not.toHaveBeenCalled();
    expect(soloPrivada.enabled).toBe(false);
  });

  it('una clave vacía cuenta como ausente', () => {
    const vacio = cargarPush({ publica: '', privada: '' });

    expect(vacio.enabled).toBe(false);
    expect(vacio.publicKey).toBe('');
    expect(webpushFalso.setVapidDetails).not.toHaveBeenCalled();
  });
});

describe('sendToUser deshabilitado', () => {
  it('no consulta la base ni envía nada', async () => {
    await expect(push.sendToUser('u-1', { titulo: 'hola' })).resolves.toBeUndefined();

    expect(poolFalso.query).not.toHaveBeenCalled();
    expect(webpushFalso.sendNotification).not.toHaveBeenCalled();
  });
});

describe('sendToUser habilitado', () => {
  it('busca las suscripciones del usuario con su id', async () => {
    const activo = pushActivo();

    await activo.sendToUser('u-9', { titulo: 'hola' });

    expect(poolFalso.query).toHaveBeenCalledTimes(1);
    expect(poolFalso.query).toHaveBeenCalledWith(CONSULTA, ['u-9']);
    expect(webpushFalso.sendNotification).not.toHaveBeenCalled();
  });

  it('envía una notificación por suscripción con el payload serializado', async () => {
    const activo = pushActivo();
    poolFalso.query.mockResolvedValueOnce({ rows: [SUSCRIPCION_1, SUSCRIPCION_2] });
    const payload = { titulo: 'Mascota cerca', url: '/aviso/7' };

    await expect(activo.sendToUser('u-9', payload)).resolves.toBeUndefined();

    expect(webpushFalso.sendNotification).toHaveBeenCalledTimes(2);
    expect(webpushFalso.sendNotification).toHaveBeenNthCalledWith(
      1,
      { endpoint: 'https://push.ejemplo.cl/1', keys: { p256dh: 'p1', auth: 'a1' } },
      JSON.stringify(payload)
    );
    expect(webpushFalso.sendNotification).toHaveBeenNthCalledWith(
      2,
      { endpoint: 'https://push.ejemplo.cl/2', keys: { p256dh: 'p2', auth: 'a2' } },
      JSON.stringify(payload)
    );
    expect(JSON.parse(webpushFalso.sendNotification.mock.calls[0][1])).toEqual(payload);
  });

  it('serializa payloads vacíos o anidados sin recortarlos', async () => {
    const activo = pushActivo();
    poolFalso.query.mockResolvedValue({ rows: [SUSCRIPCION_1] });

    await activo.sendToUser('u-9', {});
    expect(webpushFalso.sendNotification).toHaveBeenLastCalledWith(expect.anything(), '{}');

    await activo.sendToUser('u-9', { a: { b: [1, 2] } });
    expect(webpushFalso.sendNotification).toHaveBeenLastCalledWith(expect.anything(), '{"a":{"b":[1,2]}}');
  });

  it('un 404 borra la suscripción que ya no existe', async () => {
    const activo = pushActivo();
    poolFalso.query.mockResolvedValueOnce({ rows: [SUSCRIPCION_1] }).mockResolvedValueOnce({ rows: [] });
    webpushFalso.sendNotification.mockRejectedValue(
      Object.assign(new Error('no existe'), { statusCode: 404 })
    );

    await expect(activo.sendToUser('u-9', {})).resolves.toBeUndefined();

    expect(poolFalso.query).toHaveBeenCalledTimes(2);
    expect(poolFalso.query).toHaveBeenNthCalledWith(1, CONSULTA, ['u-9']);
    expect(poolFalso.query).toHaveBeenNthCalledWith(2, BORRADO, ['s-1']);
  });

  it('un 410 también borra la suscripción', async () => {
    const activo = pushActivo();
    poolFalso.query.mockResolvedValueOnce({ rows: [SUSCRIPCION_2] }).mockResolvedValueOnce({ rows: [] });
    webpushFalso.sendNotification.mockRejectedValue(
      Object.assign(new Error('caducada'), { statusCode: 410 })
    );

    await activo.sendToUser('u-9', {});

    expect(poolFalso.query).toHaveBeenNthCalledWith(2, BORRADO, ['s-2']);
  });

  it('cualquier otro error NO borra la suscripción', async () => {
    const activo = pushActivo();
    poolFalso.query.mockResolvedValueOnce({ rows: [SUSCRIPCION_1] });
    webpushFalso.sendNotification.mockRejectedValue(
      Object.assign(new Error('servidor caído'), { statusCode: 500 })
    );

    await expect(activo.sendToUser('u-9', {})).resolves.toBeUndefined();

    expect(webpushFalso.sendNotification).toHaveBeenCalledTimes(1);
    expect(poolFalso.query).toHaveBeenCalledTimes(1);
    expect(poolFalso.query).not.toHaveBeenCalledWith(BORRADO, expect.anything());
  });

  it('un error sin statusCode tampoco borra', async () => {
    const activo = pushActivo();
    poolFalso.query.mockResolvedValueOnce({ rows: [SUSCRIPCION_1] });
    webpushFalso.sendNotification.mockRejectedValue(new Error('sin código'));

    await activo.sendToUser('u-9', {});

    expect(poolFalso.query).toHaveBeenCalledTimes(1);
  });

  // Sin este registro, un envío que falla (claves VAPID que no cuadran, 403 del
  // servicio push...) desaparece sin dejar rastro y es imposible saber por qué
  // no llegó la notificación.
  it('deja registro del fallo que no es 404/410, con el código y el detalle', async () => {
    const activo = pushActivo();
    poolFalso.query.mockResolvedValue({ rows: [SUSCRIPCION_1] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    webpushFalso.sendNotification.mockRejectedValueOnce(
      Object.assign(new Error('las claves VAPID no coinciden'), { statusCode: 403 })
    );
    await activo.sendToUser('u-9', {});
    expect(error).toHaveBeenLastCalledWith(
      '[push] no se pudo enviar a u-9 (403): las claves VAPID no coinciden'
    );

    webpushFalso.sendNotification.mockRejectedValueOnce(null);
    await activo.sendToUser('u-9', {});
    expect(error).toHaveBeenLastCalledWith('[push] no se pudo enviar a u-9 (sin código): null');

    expect(error).toHaveBeenCalledTimes(2);
    expect(poolFalso.query).not.toHaveBeenCalledWith(BORRADO, expect.anything());
  });

  it('un rechazo sin error (null) no rompe ni borra', async () => {
    const activo = pushActivo();
    poolFalso.query.mockResolvedValueOnce({ rows: [SUSCRIPCION_1] });
    webpushFalso.sendNotification.mockRejectedValue(null);

    await expect(activo.sendToUser('u-9', {})).resolves.toBeUndefined();

    expect(poolFalso.query).toHaveBeenCalledTimes(1);
  });

  it('si el borrado también falla no se propaga y el resto sigue', async () => {
    const activo = pushActivo();
    poolFalso.query
      .mockResolvedValueOnce({ rows: [SUSCRIPCION_1, SUSCRIPCION_2] })
      .mockRejectedValueOnce(new Error('sin conexión'))
      .mockResolvedValueOnce({ rows: [] });
    webpushFalso.sendNotification.mockRejectedValue(
      Object.assign(new Error('no existe'), { statusCode: 404 })
    );

    await expect(activo.sendToUser('u-9', {})).resolves.toBeUndefined();

    expect(webpushFalso.sendNotification).toHaveBeenCalledTimes(2);
    expect(poolFalso.query).toHaveBeenCalledTimes(3);
    expect(poolFalso.query).toHaveBeenNthCalledWith(2, BORRADO, ['s-1']);
    expect(poolFalso.query).toHaveBeenNthCalledWith(3, BORRADO, ['s-2']);
  });

  it('si la consulta de suscripciones falla no lanza ni envía nada', async () => {
    const activo = pushActivo();
    poolFalso.query.mockRejectedValueOnce(new Error('base caída'));

    await expect(activo.sendToUser('u-9', { titulo: 'hola' })).resolves.toBeUndefined();

    expect(poolFalso.query).toHaveBeenCalledTimes(1);
    expect(webpushFalso.sendNotification).not.toHaveBeenCalled();
  });

  it('acepta un usuario sin suscripciones (rows vacío)', async () => {
    const activo = pushActivo();
    poolFalso.query.mockResolvedValueOnce({ rows: [] });

    await activo.sendToUser('u-sin-dispositivos', {});

    expect(webpushFalso.sendNotification).not.toHaveBeenCalled();
  });
});
