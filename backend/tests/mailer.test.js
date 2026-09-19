// Pruebas de backend/mailer.js.
//
// El módulo lee RESEND_API_KEY y MAIL_FROM al cargarse. El `import` estático es
// el que hace que Stryker (vía `vitest related`) relacione este archivo con el
// módulo; para probar otras configuraciones se recarga con olvidar()/requerir()
// de tests/helpers/externos.js, que además fija el entorno de pruebas.
vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgres://pruebas:pruebas@localhost:5432/pruebas';
  process.env.NODE_ENV = 'test';
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { olvidar, requerir, RUTAS } from './helpers/externos.js';
import mailer from '../mailer.js';

const CORREO = {
  to: 'ana@ejemplo.cl',
  subject: 'Recupera tu contraseña',
  text: 'Enlace de recuperación: https://rastro.cl/reset?token=abc',
  html: '<p>Enlace de recuperación</p>'
};

let registro;
let aviso;

// Recarga el módulo con el entorno pedido (undefined = variable ausente).
function cargarMailer({ apiKey, from, nodeEnv = 'test' } = {}) {
  if (apiKey === undefined) delete process.env.RESEND_API_KEY;
  else process.env.RESEND_API_KEY = apiKey;
  if (from === undefined) delete process.env.MAIL_FROM;
  else process.env.MAIL_FROM = from;
  process.env.NODE_ENV = nodeEnv;

  olvidar(RUTAS.mailer);
  return requerir(RUTAS.mailer);
}

beforeEach(() => {
  registro = vi.spyOn(console, 'log').mockImplementation(() => {});
  aviso = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
  process.env.NODE_ENV = 'test';
});

describe('configuración leída al cargarse', () => {
  it('sin RESEND_API_KEY, usingEmail es false y mailFrom el valor por defecto', () => {
    expect(mailer.usingEmail).toBe(false);
    expect(mailer.mailFrom).toBe('Rastro <onboarding@resend.dev>');
  });

  it('con RESEND_API_KEY, usingEmail es true y MAIL_FROM manda', () => {
    const conClave = cargarMailer({ apiKey: 're_clave_secreta', from: 'Rastro <hola@rastro.cl>' });

    expect(conClave.usingEmail).toBe(true);
    expect(conClave.mailFrom).toBe('Rastro <hola@rastro.cl>');
  });

  it('una clave vacía o un MAIL_FROM vacío caen a los valores por defecto', () => {
    const vacio = cargarMailer({ apiKey: '', from: '' });

    expect(vacio.usingEmail).toBe(false);
    expect(vacio.mailFrom).toBe('Rastro <onboarding@resend.dev>');
  });
});

describe('sin clave, fuera de producción', () => {
  it('imprime el correo completo en la consola del servidor', async () => {
    const falso = vi.fn();
    vi.stubGlobal('fetch', falso);
    const mailerSinClave = cargarMailer({ nodeEnv: 'development' });

    await expect(mailerSinClave.sendMail(CORREO)).resolves.toEqual({ skipped: true });

    expect(registro).toHaveBeenCalledTimes(4);
    expect(registro.mock.calls.map(([texto]) => texto)).toEqual([
      '[mailer] RESEND_API_KEY no configurada. Correo que se habría enviado:',
      '  Para: ana@ejemplo.cl',
      '  Asunto: Recupera tu contraseña',
      '  Enlace de recuperación: https://rastro.cl/reset?token=abc'
    ]);
    expect(aviso).not.toHaveBeenCalled();
    expect(falso).not.toHaveBeenCalled();
  });

  it('en NODE_ENV=test (el caso de las pruebas) también imprime', async () => {
    await mailer.sendMail(CORREO);

    expect(registro).toHaveBeenCalledTimes(4);
  });
});

describe('sin clave, en producción', () => {
  it('sólo avisa por consola y nunca imprime el contenido del correo', async () => {
    const falso = vi.fn();
    vi.stubGlobal('fetch', falso);
    const mailerProduccion = cargarMailer({ nodeEnv: 'production' });

    await expect(mailerProduccion.sendMail(CORREO)).resolves.toEqual({ skipped: true });

    expect(aviso).toHaveBeenCalledTimes(1);
    expect(aviso).toHaveBeenCalledWith(
      '[mailer] RESEND_API_KEY no configurada: no se envió el correo a ana@ejemplo.cl.'
    );
    expect(registro).not.toHaveBeenCalled();
    const salida = [...registro.mock.calls, ...aviso.mock.calls].flat().join(' ');
    expect(salida).not.toContain('token=abc');
    expect(falso).not.toHaveBeenCalled();
  });

  it('en cualquier otro entorno que no sea producción sí imprime', async () => {
    const mailerStaging = cargarMailer({ nodeEnv: 'staging' });

    await mailerStaging.sendMail(CORREO);

    expect(aviso).not.toHaveBeenCalled();
    expect(registro).toHaveBeenCalledTimes(4);
  });
});

describe('con clave (Resend)', () => {
  it('hace POST a la API de Resend con la clave, el JSON y el correo completo', async () => {
    const respuesta = { ok: true, status: 200, json: vi.fn().mockResolvedValue({ id: 'correo-1' }) };
    const falso = vi.fn().mockResolvedValue(respuesta);
    vi.stubGlobal('fetch', falso);
    const mailerConClave = cargarMailer({ apiKey: 're_abc123', from: 'Rastro <hola@rastro.cl>' });

    await expect(mailerConClave.sendMail(CORREO)).resolves.toEqual({ id: 'correo-1' });

    expect(falso).toHaveBeenCalledTimes(1);
    const [url, opciones] = falso.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(opciones.method).toBe('POST');
    expect(opciones.headers).toEqual({
      Authorization: 'Bearer re_abc123',
      'Content-Type': 'application/json'
    });
    expect(opciones.body).toBe(
      JSON.stringify({
        from: 'Rastro <hola@rastro.cl>',
        to: ['ana@ejemplo.cl'],
        subject: 'Recupera tu contraseña',
        text: 'Enlace de recuperación: https://rastro.cl/reset?token=abc',
        html: '<p>Enlace de recuperación</p>'
      })
    );
    expect(JSON.parse(opciones.body).to).toEqual(['ana@ejemplo.cl']);
    expect(respuesta.json).toHaveBeenCalledTimes(1);
    expect(registro).not.toHaveBeenCalled();
    expect(aviso).not.toHaveBeenCalled();
  });

  it('usa el remitente por defecto cuando MAIL_FROM no está configurado', async () => {
    const respuesta = { ok: true, status: 200, json: vi.fn().mockResolvedValue({ id: 'correo-2' }) };
    const falso = vi.fn().mockResolvedValue(respuesta);
    vi.stubGlobal('fetch', falso);
    const mailerConClave = cargarMailer({ apiKey: 're_abc123' });

    await mailerConClave.sendMail(CORREO);

    expect(JSON.parse(falso.mock.calls[0][1].body).from).toBe('Rastro <onboarding@resend.dev>');
  });

  it('si la respuesta no es ok lanza un Error con el estado y el cuerpo', async () => {
    const respuesta = { ok: false, status: 422, text: vi.fn().mockResolvedValue('dominio no verificado') };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta));
    const mailerConClave = cargarMailer({ apiKey: 're_abc123' });

    const error = await mailerConClave.sendMail(CORREO).catch(e => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Resend respondió 422: dominio no verificado');
    expect(respuesta.text).toHaveBeenCalledTimes(1);
  });

  it('si el cuerpo del error no se puede leer, el mensaje queda sin detalle', async () => {
    const respuesta = {
      ok: false,
      status: 500,
      text: vi.fn().mockRejectedValue(new Error('cuerpo ilegible'))
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respuesta));
    const mailerConClave = cargarMailer({ apiKey: 're_abc123' });

    const error = await mailerConClave.sendMail(CORREO).catch(e => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('Resend respondió 500: ');
  });

  it('propaga el fallo de red del fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ENOTFOUND api.resend.com')));
    const mailerConClave = cargarMailer({ apiKey: 're_abc123' });

    await expect(mailerConClave.sendMail(CORREO)).rejects.toThrow('ENOTFOUND api.resend.com');
  });
});
