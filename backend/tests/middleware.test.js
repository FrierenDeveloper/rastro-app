// Pruebas de los middlewares compartidos: cupos configurables (limits.js) y
// autenticación (auth.js).
//
// El orden de los imports importa: `./helpers/aislar.js` va PRIMERO porque deja
// el pool de Postgres sustituido por un doble antes de que se evalúe auth.js.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { db, resFalsa, reqFalsa, SECRETO } from './helpers/aislar.js';
import { numEnv } from '../middleware/limits.js';
import { requireAuth, optionalAuth, requireVerified } from '../middleware/auth.js';

describe('numEnv (cupos configurables por entorno)', () => {
  beforeEach(() => {
    delete process.env.CUPO_DE_PRUEBA;
  });

  it('sin variable definida devuelve el valor por defecto', () => {
    expect(numEnv('CUPO_DE_PRUEBA', 42)).toBe(42);
  });

  it('lee el número del entorno y lo trunca a entero', () => {
    process.env.CUPO_DE_PRUEBA = '25';
    expect(numEnv('CUPO_DE_PRUEBA', 42)).toBe(25);

    process.env.CUPO_DE_PRUEBA = '12.9';
    expect(numEnv('CUPO_DE_PRUEBA', 42)).toBe(12);
  });

  it('cero, negativos, texto y vacío caen al valor por defecto', () => {
    for (const valor of ['0', '-3', 'abc', '', '  ']) {
      process.env.CUPO_DE_PRUEBA = valor;
      expect(numEnv('CUPO_DE_PRUEBA', 42)).toBe(42);
    }
  });

  it('un infinito no se usa como cupo', () => {
    process.env.CUPO_DE_PRUEBA = 'Infinity';
    expect(numEnv('CUPO_DE_PRUEBA', 42)).toBe(42);
  });

  it('acepta notación científica y números con espacios', () => {
    process.env.CUPO_DE_PRUEBA = ' 1e3 ';
    expect(numEnv('CUPO_DE_PRUEBA', 42)).toBe(1000);
  });
});

describe('requireAuth', () => {
  beforeEach(() => {
    db.query.mockReset();
  });

  it('sin cabecera Authorization responde 401 y no llama a next', async () => {
    const res = resFalsa();
    const next = vi.fn();
    await requireAuth(reqFalsa(), res, next);

    expect(res.codigo).toBe(401);
    expect(res.cuerpo).toEqual({ error: 'No autenticado.' });
    expect(next).not.toHaveBeenCalled();
    expect(db.query).not.toHaveBeenCalled();
  });

  it('una cabecera sin el prefijo Bearer también es 401', async () => {
    const res = resFalsa();
    await requireAuth(reqFalsa({ headers: { authorization: 'Token abc' } }), res, vi.fn());
    expect(res.codigo).toBe(401);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('un token inválido o vencido es 401 de sesión inválida', async () => {
    const res = resFalsa();
    await requireAuth(reqFalsa({ headers: { authorization: 'Bearer no-es-un-jwt' } }), res, vi.fn());
    expect(res.codigo).toBe(401);
    expect(res.cuerpo).toEqual({ error: 'Sesión inválida o expirada.' });
  });

  it('un token firmado con otro secreto no sirve', async () => {
    const ajeno = jwt.sign({ sub: 'usuario-1', ver: 0 }, 'otro-secreto');
    const res = resFalsa();
    await requireAuth(reqFalsa({ headers: { authorization: `Bearer ${ajeno}` } }), res, vi.fn());
    expect(res.codigo).toBe(401);
  });

  it('si la cuenta ya no existe responde 401', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = resFalsa();
    await requireAuth(
      reqFalsa({ headers: { authorization: `Bearer ${jwt.sign({ sub: 'u', ver: 0 }, SECRETO)}` } }),
      res,
      vi.fn()
    );

    expect(res.codigo).toBe(401);
    expect(res.cuerpo).toEqual({ error: 'Sesión inválida o expirada.' });
  });

  it('si token_version no coincide avisa de que la sesión fue cerrada', async () => {
    db.query.mockResolvedValue({ rows: [{ token_version: 3 }] });
    const res = resFalsa();
    await requireAuth(
      reqFalsa({ headers: { authorization: `Bearer ${jwt.sign({ sub: 'u', ver: 2 }, SECRETO)}` } }),
      res,
      vi.fn()
    );

    expect(res.codigo).toBe(401);
    expect(res.cuerpo).toEqual({ error: 'Tu sesión fue cerrada. Inicia sesión de nuevo.' });
  });

  it('un token sin campo ver se compara como cero', async () => {
    db.query.mockResolvedValue({ rows: [{ token_version: 0 }] });
    const req = reqFalsa({ headers: { authorization: `Bearer ${jwt.sign({ sub: 'u' }, SECRETO)}` } });
    const next = vi.fn();
    await requireAuth(req, resFalsa(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBe('u');
  });

  it('con token válido y sesión viva deja pasar y anota el usuario', async () => {
    db.query.mockResolvedValue({ rows: [{ token_version: 1 }] });
    const req = reqFalsa({
      headers: { authorization: `Bearer ${jwt.sign({ sub: 'usuario-9', ver: 1 }, SECRETO)}` }
    });
    const next = vi.fn();
    await requireAuth(req, resFalsa(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBe('usuario-9');
    expect(db.query).toHaveBeenCalledWith('SELECT token_version FROM users WHERE id = $1', ['usuario-9']);
  });

  it('un fallo de la base se propaga a next en vez de tumbar la petición', async () => {
    const fallo = new Error('sin conexión');
    db.query.mockRejectedValue(fallo);
    const next = vi.fn();
    await requireAuth(
      reqFalsa({ headers: { authorization: `Bearer ${jwt.sign({ sub: 'u', ver: 0 }, SECRETO)}` } }),
      resFalsa(),
      next
    );

    expect(next).toHaveBeenCalledWith(fallo);
  });
});

describe('optionalAuth', () => {
  it('sin token sigue como anónimo', () => {
    const req = reqFalsa();
    const next = vi.fn();
    optionalAuth(req, resFalsa(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBeUndefined();
  });

  it('con token válido anota el usuario', () => {
    const req = reqFalsa({ headers: { authorization: `Bearer ${jwt.sign({ sub: 'u-7' }, SECRETO)}` } });
    optionalAuth(req, resFalsa(), vi.fn());
    expect(req.userId).toBe('u-7');
  });

  it('con token inválido no falla: sigue como anónimo', () => {
    const req = reqFalsa({ headers: { authorization: 'Bearer roto' } });
    const next = vi.fn();
    optionalAuth(req, resFalsa(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.userId).toBeUndefined();
  });

  it('ignora una cabecera que no empieza por Bearer', () => {
    const req = reqFalsa({ headers: { authorization: `Basic ${jwt.sign({ sub: 'u' }, SECRETO)}` } });
    optionalAuth(req, resFalsa(), vi.fn());
    expect(req.userId).toBeUndefined();
  });
});

describe('requireVerified', () => {
  beforeEach(() => {
    db.query.mockReset();
  });

  it('si la cuenta no existe responde 401', async () => {
    db.query.mockResolvedValue({ rows: [] });
    const res = resFalsa();
    await requireVerified({ userId: 'u' }, res, vi.fn());

    expect(res.codigo).toBe(401);
    expect(res.cuerpo).toEqual({ error: 'Sesión inválida o expirada.' });
  });

  it('con el correo sin confirmar responde 403 y explica qué hacer', async () => {
    db.query.mockResolvedValue({ rows: [{ email_verified: false }] });
    const res = resFalsa();
    await requireVerified({ userId: 'u' }, res, vi.fn());

    expect(res.codigo).toBe(403);
    expect(res.cuerpo.error).toContain('Confirma tu correo');
  });

  it('con el correo confirmado deja pasar', async () => {
    db.query.mockResolvedValue({ rows: [{ email_verified: true }] });
    const next = vi.fn();
    await requireVerified({ userId: 'u' }, resFalsa(), next);

    expect(next).toHaveBeenCalledWith();
    expect(db.query).toHaveBeenCalledWith('SELECT email_verified FROM users WHERE id = $1', ['u']);
  });

  // La comprobación exige exactamente `true`. Antes se comparaba contra `false`,
  // así que cualquier otro falsy (0, null, cadena vacía) colaba sin bloquear, y
  // un `1` tampoco debe valer: la columna es `boolean` en Postgres.
  it.each([0, 1, null, undefined, '', 'false'])('un %s no confirma la cuenta: 403', async valor => {
    db.query.mockResolvedValue({ rows: [{ email_verified: valor }] });
    const res = resFalsa();
    const next = vi.fn();
    await requireVerified({ userId: 'u' }, res, next);

    expect(res.codigo).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('un fallo de la base se propaga a next', async () => {
    const fallo = new Error('caída');
    db.query.mockRejectedValue(fallo);
    const next = vi.fn();
    await requireVerified({ userId: 'u' }, resFalsa(), next);

    expect(next).toHaveBeenCalledWith(fallo);
  });
});
