// Pruebas de las rutas de notificaciones push (backend/routes/push.js).
//
// INFRAESTRUCTURA DE VALIDACIÓN: no se modifica ni una línea de producción. El
// router se importa de forma ESTÁTICA (para que Stryker lo relacione con estas
// pruebas vía `vitest related`) y sus dependencias (db y push) se sustituyen con
// los dobles de ./helpers/aislar.js, que se importa ANTES.
//
// El doble de push.js empieza con enabled=true y una clave pública; varios
// tests lo cambian a propósito (push apagado, sin clave) y el beforeEach
// devuelve el doble a su estado normal.
import { describe, it, expect, beforeEach } from 'vitest';
import { db, push, crearApp, pedir, tokenPara } from './helpers/aislar.js';
import pushRouter from '../routes/push.js';

const app = crearApp({ '/api/push': pushRouter });

const SUB = 'usuario-con-push';
const OTRO = 'usuario-2';
const CLAVE_PUBLICA = 'clave-publica-de-pruebas';
const ENDPOINT = 'https://fcm.googleapis.com/fcm/send/abc-123';
const CLAVES = { p256dh: 'BAnlF3p256dh-de-prueba', auth: 'auth-de-prueba' };
const SQL_TOKEN = 'SELECT token_version FROM users WHERE id = $1';
const NO_AUTENTICADO = { error: 'No autenticado.' };
const SUSCRIPCION_INVALIDA = { error: 'Suscripción inválida.' };
const DATOS_INVALIDOS = { error: 'Datos inválidos.' };
const UBICACION_INVALIDA = { error: 'Ubicación inválida.' };
const ENDPOINT_NO_PERMITIDO = {
  error: 'El endpoint de la suscripción apunta a una dirección no permitida.'
};
const ENDPOINT_SIN_HTTPS = { error: 'El endpoint de la suscripción debe usar HTTPS.' };

const relleno = largo => 'x'.repeat(largo);

beforeEach(() => {
  db.query.mockReset();
  push.enabled = true;
  push.publicKey = CLAVE_PUBLICA;
});

// Respuestas de la base para una petición autenticada: requireAuth pide
// token_version y `propia` responde a la consulta de la ruta.
function prepararBase(propia) {
  db.query.mockImplementation(async (sql, params) => {
    if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
    if (propia) return propia(sql, params);
    return { rows: [] };
  });
}

// Cabecera válida + IP distinta en cada petición (por si algún día la ruta
// monta un express-rate-limit: la clave del límite sale de x-forwarded-for).
let visitas = 0;
function conToken(peticion, sub = SUB) {
  visitas += 1;
  return peticion
    .set('Authorization', `Bearer ${tokenPara(sub)}`)
    .set('x-forwarded-for', `10.${Math.floor(visitas / 250)}.${visitas % 250}.8`);
}

describe('GET /public-key (endpoint público)', () => {
  it('informa que el push está activo y entrega la clave pública', async () => {
    const res = await pedir(app).get('/api/push/public-key');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ enabled: true, publicKey: CLAVE_PUBLICA });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('con el push apagado lo dice sin romper la respuesta', async () => {
    push.enabled = false;
    const res = await pedir(app).get('/api/push/public-key');

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ enabled: false, publicKey: CLAVE_PUBLICA });
  });

  it('sin clave pública configurada devuelve cadena vacía, nunca null', async () => {
    for (const valor of [null, undefined, '']) {
      push.publicKey = valor;
      const res = await pedir(app).get('/api/push/public-key');

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({ enabled: true, publicKey: '' });
    }
  });
});

describe('POST /subscribe', () => {
  it('sin cabecera Authorization responde 401 y no toca la base', async () => {
    const res = await pedir(app).post('/api/push/subscribe').send({ endpoint: ENDPOINT, keys: CLAVES });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un token que no es un JWT válido es 401', async () => {
    const res = await pedir(app)
      .post('/api/push/subscribe')
      .set('Authorization', 'Bearer roto')
      .send({ endpoint: ENDPOINT, keys: CLAVES });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual({ error: 'Sesión inválida o expirada.' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('con token pero cuerpo vacío la suscripción es inválida', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post('/api/push/subscribe'));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(SUSCRIPCION_INVALIDA);
    expect(db.query).toHaveBeenCalledTimes(1); // solo el SELECT de token_version
    expect(db.query).toHaveBeenCalledWith(SQL_TOKEN, [SUB]);
  });

  it('un cuerpo null tampoco pasa la validación', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post('/api/push/subscribe').send(null));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(SUSCRIPCION_INVALIDA);
  });

  it('sin las claves de cifrado no se suscribe', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post('/api/push/subscribe').send({ endpoint: ENDPOINT }));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(SUSCRIPCION_INVALIDA);
  });

  it('si keys no es un objeto tampoco se suscribe', async () => {
    prepararBase();
    const res = await conToken(
      pedir(app).post('/api/push/subscribe').send({ endpoint: ENDPOINT, keys: 'no-soy-un-objeto' })
    );

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(SUSCRIPCION_INVALIDA);
  });

  // El endpoint lo elige quien se suscribe y el servidor hace una petición HTTPS
  // SALIENTE contra él (web-push llama a https.request contra el host que
  // venga): sin validar sirve de proxy ciego hacia la red interna (SSRF).
  it.each([
    ['loopback', 'https://127.0.0.1/x', ENDPOINT_NO_PERMITIDO],
    ['loopback ofuscado en hexadecimal', 'https://0x7f.0.0.1/x', ENDPOINT_NO_PERMITIDO],
    ['loopback como entero decimal', 'https://2130706433/x', ENDPOINT_NO_PERMITIDO],
    ['red privada', 'https://192.168.1.1/x', ENDPOINT_NO_PERMITIDO],
    ['metadata de nube', 'https://169.254.169.254/latest/meta-data', ENDPOINT_NO_PERMITIDO],
    ['localhost', 'https://localhost/x', ENDPOINT_NO_PERMITIDO],
    ['sin HTTPS', 'http://127.0.0.1/x', ENDPOINT_SIN_HTTPS]
  ])('rechaza un endpoint de %s sin guardar la suscripción', async (_caso, endpoint, esperado) => {
    prepararBase();

    const res = await conToken(pedir(app).post('/api/push/subscribe').send({ endpoint, keys: CLAVES }));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(esperado);
    // Solo el SELECT de token_version: no se llegó a tocar push_subscriptions.
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('un endpoint legítimo de un servicio push se sigue guardando', async () => {
    prepararBase();

    const res = await conToken(
      pedir(app).post('/api/push/subscribe').send({ endpoint: ENDPOINT, keys: CLAVES })
    );

    expect(res.status).toBe(201);
    expect(res.body).toStrictEqual({ ok: true });
  });

  it('un endpoint vacío, nulo, numérico o de 2001 caracteres es inválido', async () => {
    prepararBase();
    for (const endpoint of ['', null, 42, relleno(2001)]) {
      const res = await conToken(pedir(app).post('/api/push/subscribe').send({ endpoint, keys: CLAVES }));

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(SUSCRIPCION_INVALIDA);
    }
    expect(db.query).toHaveBeenCalledTimes(4); // ninguna llegó al INSERT
  });

  it('una clave p256dh vacía, numérica o de 501 caracteres es inválida', async () => {
    prepararBase();
    for (const p256dh of ['', 7, relleno(501)]) {
      const res = await conToken(
        pedir(app)
          .post('/api/push/subscribe')
          .send({ endpoint: ENDPOINT, keys: { p256dh, auth: CLAVES.auth } })
      );

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(SUSCRIPCION_INVALIDA);
    }
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it('una clave auth vacía o de 501 caracteres es inválida', async () => {
    prepararBase();
    for (const auth of ['', relleno(501)]) {
      const res = await conToken(
        pedir(app)
          .post('/api/push/subscribe')
          .send({ endpoint: ENDPOINT, keys: { p256dh: CLAVES.p256dh, auth } })
      );

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(SUSCRIPCION_INVALIDA);
    }
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('los largos justo en el límite (2000 y 500) sí se aceptan', async () => {
    prepararBase();
    const endpoint = `https://push.test/${relleno(2000 - 'https://push.test/'.length)}`;
    const res = await conToken(
      pedir(app)
        .post('/api/push/subscribe')
        .send({ endpoint, keys: { p256dh: relleno(500), auth: relleno(500) } })
    );

    expect(endpoint).toHaveLength(2000);
    expect(res.status).toBe(201);
    expect(res.body).toStrictEqual({ ok: true });
  });

  it('guarda la suscripción con el usuario del token y las claves exactas', async () => {
    prepararBase();
    const res = await conToken(
      pedir(app).post('/api/push/subscribe').send({ endpoint: ENDPOINT, keys: CLAVES })
    );

    expect(res.status).toBe(201);
    expect(res.body).toStrictEqual({ ok: true });
    expect(db.query.mock.calls[1][0]).toContain(
      'INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at)'
    );
    expect(db.query.mock.calls[1][0]).toContain('VALUES ($1,$2,$3,$4,$5,$6)');
    expect(db.query.mock.calls[1][1]).toStrictEqual([
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
      SUB,
      ENDPOINT,
      CLAVES.p256dh,
      CLAVES.auth,
      expect.any(Number)
    ]);
  });

  it('el mismo endpoint se actualiza (ON CONFLICT) y cambia de dueño', async () => {
    prepararBase();
    const primera = await conToken(
      pedir(app).post('/api/push/subscribe').send({ endpoint: ENDPOINT, keys: CLAVES })
    );
    const segunda = await conToken(
      pedir(app)
        .post('/api/push/subscribe')
        .send({ endpoint: ENDPOINT, keys: { p256dh: 'otra-clave', auth: 'otro-auth' } }),
      OTRO
    );

    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(201);
    expect(db.query.mock.calls[1][0]).toContain('ON CONFLICT (endpoint) DO UPDATE');
    expect(db.query.mock.calls[1][0]).toContain(
      'SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth'
    );
    expect(db.query.mock.calls[1][1][1]).toBe(SUB);
    expect(db.query.mock.calls[3][1][1]).toBe(OTRO);
    expect(db.query.mock.calls[3][1][3]).toBe('otra-clave');
  });

  it('un fallo de la base al guardar responde 500 y no confirma', async () => {
    prepararBase(sql => {
      if (sql.includes('INSERT INTO push_subscriptions')) throw new Error('caída al guardar');
      return { rows: [] };
    });
    const res = await conToken(
      pedir(app).post('/api/push/subscribe').send({ endpoint: ENDPOINT, keys: CLAVES })
    );

    expect(res.status).toBe(500);
  });
});

describe('POST /unsubscribe', () => {
  it('sin cabecera Authorization responde 401 y no toca la base', async () => {
    const res = await pedir(app).post('/api/push/unsubscribe').send({ endpoint: ENDPOINT });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('sin endpoint responde 400 con "Datos inválidos."', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post('/api/push/unsubscribe'));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(DATOS_INVALIDOS);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('un endpoint vacío, numérico o de 2001 caracteres es inválido', async () => {
    prepararBase();
    for (const endpoint of ['', null, 42, relleno(2001)]) {
      const res = await conToken(pedir(app).post('/api/push/unsubscribe').send({ endpoint }));

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(DATOS_INVALIDOS);
    }
    expect(db.query).toHaveBeenCalledTimes(4);
  });

  it('borra solo la suscripción de ese endpoint y de ese usuario', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post('/api/push/unsubscribe').send({ endpoint: ENDPOINT }));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true });
    expect(db.query).toHaveBeenCalledWith(
      'DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2',
      [ENDPOINT, SUB]
    );
  });

  it('un fallo de la base responde 500', async () => {
    prepararBase(sql => {
      if (sql.includes('DELETE FROM push_subscriptions')) throw new Error('caída al borrar');
      return { rows: [] };
    });
    const res = await conToken(pedir(app).post('/api/push/unsubscribe').send({ endpoint: ENDPOINT }));

    expect(res.status).toBe(500);
  });
});

describe('GET /zone', () => {
  it('sin cabecera Authorization responde 401 y no toca la base', async () => {
    const res = await pedir(app).get('/api/push/zone');

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('devuelve las coordenadas guardadas como números', async () => {
    prepararBase(() => ({
      rows: [{ lat: '12.5', lng: '-70.6', origen: 'manual', updated_at: '1700000000000' }]
    }));
    const res = await conToken(pedir(app).get('/api/push/zone'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({
      zone: { lat: 12.5, lng: -70.6, origen: 'manual', updated_at: 1700000000000 }
    });
    expect(db.query).toHaveBeenCalledWith(
      'SELECT lat, lng, origen, updated_at FROM zone_alerts WHERE user_id = $1',
      [SUB]
    );
  });

  it('una zona automática se anuncia como tal', async () => {
    prepararBase(() => ({ rows: [{ lat: 1, lng: 2, origen: 'auto', updated_at: '1700000000000' }] }));
    const res = await conToken(pedir(app).get('/api/push/zone'));

    expect(res.body.zone.origen).toBe('auto');
  });

  it('sin fecha de actualización devuelve null, no 0', async () => {
    prepararBase(() => ({ rows: [{ lat: 1, lng: 2, origen: null, updated_at: null }] }));
    const res = await conToken(pedir(app).get('/api/push/zone'));

    expect(res.body.zone.updated_at).toBeNull();
    // Una fila anterior a la migración cuenta como zona fijada a mano.
    expect(res.body.zone.origen).toBe('manual');
  });

  it('sin zona guardada devuelve zone null', async () => {
    prepararBase();
    const res = await conToken(pedir(app).get('/api/push/zone'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ zone: null });
  });

  it('un fallo de la base responde 500', async () => {
    prepararBase(() => {
      throw new Error('caída al leer la zona');
    });
    const res = await conToken(pedir(app).get('/api/push/zone'));

    expect(res.status).toBe(500);
  });
});

describe('POST /zone', () => {
  it('sin cabecera Authorization responde 401 y no toca la base', async () => {
    const res = await pedir(app).post('/api/push/zone').send({ lat: 1, lng: 2 });

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('sin coordenadas responde 400 con "Ubicación inválida."', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post('/api/push/zone'));

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(UBICACION_INVALIDA);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('si falta una de las dos coordenadas es 400', async () => {
    prepararBase();
    const soloLat = await conToken(pedir(app).post('/api/push/zone').send({ lat: -33.4 }));
    const soloLng = await conToken(pedir(app).post('/api/push/zone').send({ lng: -70.6 }));

    expect(soloLat.status).toBe(400);
    expect(soloLat.body).toStrictEqual(UBICACION_INVALIDA);
    expect(soloLng.status).toBe(400);
    expect(soloLng.body).toStrictEqual(UBICACION_INVALIDA);
  });

  it('lat/lng fuera de rango o no numéricas son 400', async () => {
    prepararBase();
    const malas = [
      { lat: 90.5, lng: 0 },
      { lat: -90.5, lng: 0 },
      { lat: 0, lng: 180.5 },
      { lat: 0, lng: -180.5 },
      { lat: 'abc', lng: 0 },
      { lat: null, lng: 0 },
      { lat: true, lng: 0 },
      { lat: 0, lng: 'no-es-un-numero' }
    ];
    for (const cuerpo of malas) {
      const res = await conToken(pedir(app).post('/api/push/zone').send(cuerpo));

      expect(res.status).toBe(400);
      expect(res.body).toStrictEqual(UBICACION_INVALIDA);
    }
    expect(db.query).toHaveBeenCalledTimes(malas.length); // ninguna llegó al INSERT
  });

  it('justo en los bordes (±90 y ±180) sí se acepta', async () => {
    prepararBase();
    const norte = await conToken(pedir(app).post('/api/push/zone').send({ lat: 90, lng: 180 }));
    const sur = await conToken(pedir(app).post('/api/push/zone').send({ lat: -90, lng: -180 }));

    expect(norte.status).toBe(201);
    expect(norte.body).toStrictEqual({ ok: true });
    expect(sur.status).toBe(201);
    expect(sur.body).toStrictEqual({ ok: true });
  });

  it('guarda la zona del usuario del token con las coordenadas convertidas', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post('/api/push/zone').send({ lat: '12.5', lng: '-70.5' }));

    expect(res.status).toBe(201);
    expect(res.body).toStrictEqual({ ok: true });
    const [sql, params] = db.query.mock.calls[1];
    expect(sql).toContain('INSERT INTO zone_alerts (user_id, lat, lng, created_at, updated_at, origen)');
    expect(sql).toContain('VALUES ($1,$2,$3,$4,$4,$5)');
    expect(sql).toContain('ON CONFLICT (user_id) DO UPDATE');
    expect(sql).toContain('SET lat = EXCLUDED.lat, lng = EXCLUDED.lng');
    expect(sql).toContain('updated_at = EXCLUDED.updated_at, origen = EXCLUDED.origen');
    // Sin decir nada, la zona es del usuario: una ubicación automática nunca la
    // pisa (WHERE), pero lo que él manda a mano siempre se guarda.
    expect(sql).toContain("WHERE zone_alerts.origen <> 'manual' OR EXCLUDED.origen = 'manual'");
    expect(params).toStrictEqual([SUB, 12.5, -70.5, expect.any(Number), 'manual']);
  });

  it('una ubicación automática se marca como auto y no pisa una zona manual', async () => {
    prepararBase();
    const res = await conToken(pedir(app).post('/api/push/zone').send({ lat: 1, lng: 2, origen: 'auto' }));

    expect(res.status).toBe(201);
    const [sql, params] = db.query.mock.calls[1];
    expect(params[4]).toBe('auto');
    expect(sql).toContain("zone_alerts.origen <> 'manual'");
  });

  it('un origen que no existe responde 400 y no guarda', async () => {
    prepararBase();
    const res = await conToken(
      pedir(app).post('/api/push/zone').send({ lat: 1, lng: 2, origen: 'inventado' })
    );

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(UBICACION_INVALIDA);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('la zona se guarda a nombre del dueño del token, no de otro', async () => {
    prepararBase();
    await conToken(pedir(app).post('/api/push/zone').send({ lat: 1, lng: 2 }), OTRO);

    expect(db.query.mock.calls[1][1][0]).toBe(OTRO);
  });

  it('un fallo de la base al guardar responde 500', async () => {
    prepararBase(sql => {
      if (sql.includes('INSERT INTO zone_alerts')) throw new Error('caída al guardar la zona');
      return { rows: [] };
    });
    const res = await conToken(pedir(app).post('/api/push/zone').send({ lat: 1, lng: 2 }));

    expect(res.status).toBe(500);
  });
});

describe('DELETE /zone', () => {
  it('sin cabecera Authorization responde 401 y no toca la base', async () => {
    const res = await pedir(app).delete('/api/push/zone');

    expect(res.status).toBe(401);
    expect(res.body).toStrictEqual(NO_AUTENTICADO);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('borra la zona del usuario del token', async () => {
    prepararBase();
    const res = await conToken(pedir(app).delete('/api/push/zone'));

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ ok: true });
    expect(db.query).toHaveBeenCalledWith('DELETE FROM zone_alerts WHERE user_id = $1', [SUB]);
  });

  it('un fallo de la base responde 500', async () => {
    prepararBase(sql => {
      if (sql.includes('DELETE FROM zone_alerts')) throw new Error('caída al borrar la zona');
      return { rows: [] };
    });
    const res = await conToken(pedir(app).delete('/api/push/zone'));

    expect(res.status).toBe(500);
  });
});
