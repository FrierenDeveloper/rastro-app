// Pruebas del escaneo de microchips (POST /api/chips/scan).
//
// Lo que se protege aquí: quien escanea NUNCA recibe el contacto del dueño (solo
// el nombre de la mascota), el escaneo queda registrado siempre —con o sin
// coincidencia— para poder detectar una enumeración, la IP se guarda hasheada y
// el dueño recibe el aviso sin que la respuesta dependa de que el envío funcione.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { db, push, mailer, crearApp, pedir, tokenPara } from './helpers/aislar.js';
import chipsRouter from '../routes/chips.js';

const require = createRequire(import.meta.url);
const chip = require('../src/v2/chip.js');

const app = crearApp({ '/api/chips': chipsRouter });

const SUB = 'duena-1';
const OTRO = 'curioso-2';
const UUID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CHIP = '981020304050607';
const SECRETO_CHIP = 'chip-secreto-de-pruebas';
const SECRETO_INICIAL = process.env.CHIP_SECRET;
const IP = '190.160.1.2';

const CHIP_INVALIDO = { error: 'El microchip debe tener 15 dígitos.' };
const VALOR_INVALIDO = { error: 'Invalid value' };

const registroFila = (cambios = {}) => ({
  id: UUID,
  owner_user_id: SUB,
  pet_name: 'Firulais',
  ...cambios
});

let eventos = [];
let accesos = [];
let registro = null;
let correo = { email: 'duena@ejemplo.cl' };

function base(opciones = {}) {
  const { encontrado = registroFila(), fallaBusqueda = false } = opciones;
  registro = encontrado;
  correo = opciones.correo === undefined ? { email: 'duena@ejemplo.cl' } : opciones.correo;

  const reglas = [
    [s => s.includes('token_version FROM users'), () => ({ rows: [{ token_version: 0 }] })],
    [
      s => s.includes('WHERE chip_hash = $1'),
      () => {
        if (fallaBusqueda) throw new Error('caída al buscar el chip');
        return { rows: registro ? [registro] : [] };
      }
    ],
    [
      s => s.startsWith('INSERT INTO chip_scan_events'),
      params => {
        eventos.push(params);
        return { rows: [] };
      }
    ],
    [
      s => s.startsWith('INSERT INTO data_access_log'),
      params => {
        accesos.push(params);
        return { rows: [] };
      }
    ],
    [s => s.includes('SELECT email FROM users'), () => ({ rows: correo ? [correo] : [] })]
  ];

  db.query.mockImplementation(async (sql, params) => {
    const s = String(sql);
    for (const [aplica, responder] of reglas) {
      if (aplica(s)) return responder(params);
    }
    return { rows: [] };
  });
}

function reposar() {
  return new Promise(resolve => setImmediate(resolve)).then(
    () => new Promise(resolve => setImmediate(resolve))
  );
}

let visitas = 0;
function ipNueva() {
  visitas += 1;
  return `10.${Math.floor(visitas / 250)}.${visitas % 250}.5`;
}

// Cada escaneo usa una IP nueva (salvo cuando el test lo fija a propósito): el
// cupo por IP es real y compartido, así que con una sola IP se agotaría a mitad
// del archivo.
function escanear(cuerpo, opciones = {}) {
  const { sub = null, ip = ipNueva() } = opciones;
  const p = pedir(app).post('/api/chips/scan').set('x-forwarded-for', ip);
  return sub === null ? p.send(cuerpo) : p.set('Authorization', `Bearer ${tokenPara(sub, 0)}`).send(cuerpo);
}

beforeEach(() => {
  db.query.mockReset();
  push.sendToUser.mockReset();
  push.sendToUser.mockResolvedValue(undefined);
  mailer.sendMail.mockReset();
  mailer.sendMail.mockResolvedValue({ id: 'correo-de-prueba' });
  process.env.CHIP_SECRET = SECRETO_CHIP;
  eventos = [];
  accesos = [];
});

afterEach(() => {
  if (SECRETO_INICIAL === undefined) delete process.env.CHIP_SECRET;
  else process.env.CHIP_SECRET = SECRETO_INICIAL;
});

describe('POST /api/chips/scan · coincidencia', () => {
  it('con coincidencia devuelve solo el nombre de la mascota', async () => {
    base();

    const res = await escanear({ chip_id: CHIP });

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ matched: true, pet_name: 'Firulais' });
    // Ni el contacto del dueño, ni su id, ni el id del registro.
    const texto = JSON.stringify(res.body);
    expect(texto).not.toContain(SUB);
    expect(texto).not.toContain(UUID);
    expect(texto).not.toContain('@');
    expect(texto).not.toContain('correo');
  });

  it('guarda el evento con la huella del chip, nunca el número', async () => {
    base();

    await escanear({ chip_id: CHIP });

    expect(eventos).toHaveLength(1);
    expect(eventos[0][1]).toBe(chip.huella(CHIP, SECRETO_CHIP));
    expect(JSON.stringify(eventos[0])).not.toContain(CHIP);
    expect(eventos[0][4]).toBe(true);
  });

  it('la IP se guarda hasheada, nunca en claro', async () => {
    base();

    await escanear({ chip_id: CHIP }, { ip: IP });

    const huella = eventos[0][3];
    expect(huella).toBe(chip.huellaIp(IP, SECRETO_CHIP));
    expect(huella).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(eventos[0])).not.toContain('190.160.1.2');
  });

  it('avisa al dueño por push y por correo, sin decirle quién escaneó', async () => {
    base();

    await escanear({ chip_id: CHIP });
    await reposar();

    expect(push.sendToUser).toHaveBeenCalledWith(
      SUB,
      expect.objectContaining({ title: '🐾 Alguien escaneó el microchip de tu mascota' })
    );
    const cuerpoPush = push.sendToUser.mock.calls[0][1].body;
    expect(cuerpoPush).toContain('Firulais');
    expect(cuerpoPush).not.toContain('190.160.1.2');
    expect(mailer.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'duena@ejemplo.cl', subject: expect.stringContaining('Firulais') })
    );
  });

  it('deja traza del acceso al registro (son datos personales)', async () => {
    base();

    await escanear({ chip_id: CHIP });

    expect(accesos).toHaveLength(1);
    expect(accesos[0][2]).toBe(UUID);
    expect(accesos[0][3]).toBe('read');
  });

  it('si el escaneo viene de una cuenta, el evento guarda quién lo hizo', async () => {
    base();

    await escanear({ chip_id: CHIP }, { sub: OTRO });

    expect(eventos[0][2]).toBe(OTRO);
  });

  it('un escaneo anónimo deja el evento sin usuario', async () => {
    base();

    await escanear({ chip_id: CHIP });

    expect(eventos[0][2]).toBeNull();
  });

  it('si el dueño ya no tiene correo, el aviso por correo simplemente no se manda', async () => {
    base({ correo: null });

    const res = await escanear({ chip_id: CHIP });
    await reposar();

    expect(res.status).toBe(200);
    expect(mailer.sendMail).not.toHaveBeenCalled();
    expect(push.sendToUser).toHaveBeenCalled();
  });

  it('si el push falla, quien escanea recibe su respuesta igual', async () => {
    base();
    push.sendToUser.mockRejectedValue(new Error('push caído'));
    mailer.sendMail.mockRejectedValue(new Error('correo caído'));

    const res = await escanear({ chip_id: CHIP });
    await reposar();

    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(true);
  });
});

describe('POST /api/chips/scan · sin coincidencia', () => {
  it('sin coincidencia responde matched false y no revela nada más', async () => {
    base({ encontrado: null });

    const res = await escanear({ chip_id: CHIP });
    await reposar();

    expect(res.status).toBe(200);
    expect(res.body).toStrictEqual({ matched: false });
    expect(push.sendToUser).not.toHaveBeenCalled();
    expect(mailer.sendMail).not.toHaveBeenCalled();
    expect(accesos).toHaveLength(0);
  });

  it('el intento sin coincidencia también queda registrado', async () => {
    base({ encontrado: null });

    await escanear({ chip_id: '981020304050699' });

    expect(eventos).toHaveLength(1);
    expect(eventos[0][4]).toBe(false);
  });

  it('un chip borrado no cuenta como coincidencia: la consulta lo excluye', async () => {
    base({ encontrado: null });

    await escanear({ chip_id: CHIP });

    const consulta = db.query.mock.calls.find(call => String(call[0]).includes('chip_hash = $1'));
    expect(String(consulta[0])).toContain('deleted_at IS NULL');
  });
});

describe('POST /api/chips/scan · validación y cupo', () => {
  it.each([
    ['catorce dígitos', '98102030405060', CHIP_INVALIDO],
    ['letras', '98102030405060A', CHIP_INVALIDO],
    ['demasiado largo', '1'.repeat(33), CHIP_INVALIDO],
    ['vacío', '', CHIP_INVALIDO],
    ['un número, no texto', 981020304050607, VALOR_INVALIDO]
  ])('rechaza %s y no registra el intento', async (_caso, valor, esperado) => {
    base();

    const res = await escanear({ chip_id: valor });

    expect(res.status).toBe(400);
    expect(res.body).toStrictEqual(esperado);
    expect(eventos).toHaveLength(0);
  });

  it('acepta el chip escrito con espacios', async () => {
    base();

    const res = await escanear({ chip_id: '981 020 304 050 607' });

    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(true);
  });

  it('corta con 429 el escaneo 21 de la misma IP', async () => {
    base({ encontrado: null });
    const ip = '200.1.1.1';

    for (let i = 0; i < 20; i++) {
      const ok = await escanear({ chip_id: CHIP }, { ip });
      expect(ok.status).toBe(200);
    }
    const res = await escanear({ chip_id: CHIP }, { ip });

    expect(res.status).toBe(429);
    // El intento cortado no llega a la base.
    expect(eventos).toHaveLength(20);
  });

  it('si la búsqueda falla responde 500', async () => {
    base({ fallaBusqueda: true });

    const res = await escanear({ chip_id: CHIP });

    expect(res.status).toBe(500);
  });
});

/* ======================================================================== */
/* Contrato fino: lo que fijan los mutantes que sobrevivían                 */
/* ======================================================================== */
describe('POST /api/chips/scan · parámetros y avisos exactos', () => {
  it('el evento guarda todos sus campos: huella, quién, huella de IP, coincidencia y fecha', async () => {
    base();
    const antes = Date.now();

    await escanear({ chip_id: CHIP }, { sub: OTRO, ip: IP });

    expect(eventos[0][0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(eventos[0][1]).toBe(chip.huella(CHIP, SECRETO_CHIP));
    expect(eventos[0][2]).toBe(OTRO);
    expect(eventos[0][3]).toBe(chip.huellaIp(IP, SECRETO_CHIP));
    expect(eventos[0][4]).toBe(true);
    expect(eventos[0][5]).toBeGreaterThanOrEqual(antes);
    expect(eventos[0][5]).toBeLessThanOrEqual(Date.now());
  });

  it('la traza de la lectura guarda la tabla, la acción y quién escaneó', async () => {
    base();

    await escanear({ chip_id: CHIP }, { sub: OTRO });

    expect(accesos[0][1]).toBe('chip_registrations');
    expect(accesos[0][2]).toBe(UUID);
    expect(accesos[0][3]).toBe('read');
    expect(accesos[0][4]).toBe(OTRO);
  });

  it('en un escaneo anónimo la traza queda sin actor', async () => {
    base();

    await escanear({ chip_id: CHIP });

    expect(accesos[0][4]).toBeNull();
  });

  it('el correo al dueño lleva el nombre, el aviso y la firma', async () => {
    base();

    await escanear({ chip_id: CHIP });
    await reposar();

    const correo = mailer.sendMail.mock.calls[0][0];
    expect(correo.subject).toContain('Firulais');
    expect(correo.text).toContain('Alguien acaba de escanear el microchip');
    expect(correo.text).toContain('Firulais');
    expect(correo.text).toContain('no compartimos tus datos de contacto');
    expect(correo.text).toContain('PetSeñal');
  });

  it('el push lleva una etiqueta propia del registro, para no repetir avisos', async () => {
    base();

    await escanear({ chip_id: CHIP });
    await reposar();

    expect(push.sendToUser).toHaveBeenCalledWith(SUB, expect.objectContaining({ tag: 'chip-scan-' + UUID }));
  });

  it('sin CHIP_SECRET el escaneo falla con 500 en vez de comparar con la huella vacía', async () => {
    base();
    delete process.env.CHIP_SECRET;

    const res = await escanear({ chip_id: CHIP });

    expect(res.status).toBe(500);
    expect(eventos).toHaveLength(0);
  });
});
