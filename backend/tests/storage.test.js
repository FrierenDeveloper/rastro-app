// Pruebas de backend/storage.js.
//
// El módulo decide al cargarse si usa Supabase Storage o el disco local, así que
// el `import` estático se evalúa en modo local y el modo Supabase se prueba
// recargando con olvidar()/requerir() (ver tests/helpers/externos.js, que además
// inyecta el doble de @supabase/supabase-js).
//
// Los archivos que estas pruebas escriben en backend/uploads/ se borran al
// terminar cada test para no dejar basura.
vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgres://pruebas:pruebas@localhost:5432/pruebas';
  process.env.NODE_ENV = 'test';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_BUCKET;
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  subidasFalsas,
  bajasFalsas,
  urlsFalsas,
  clienteSupabaseFalso,
  supabaseFalso,
  olvidar,
  requerir,
  RUTAS
} from './helpers/externos.js';
import fs from 'node:fs';
import path from 'node:path';
import storage from '../storage.js';

const URL_SUPABASE = 'https://proyecto.supabase.co';
const CLAVE_SERVICIO = 'llave-de-servicio';

// Recarga storage.js con el modo pedido (undefined = variable ausente).
function cargarStorage({ supabase = false, bucket } = {}) {
  if (supabase) {
    process.env.SUPABASE_URL = URL_SUPABASE;
    process.env.SUPABASE_SERVICE_ROLE_KEY = CLAVE_SERVICIO;
  } else {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  }
  if (bucket === undefined) delete process.env.SUPABASE_BUCKET;
  else process.env.SUPABASE_BUCKET = bucket;

  olvidar(RUTAS.storage);
  return requerir(RUTAS.storage);
}

// Archivos creados por las pruebas, para borrarlos al final de cada una.
const creados = new Set();

function registrar(ruta) {
  creados.add(ruta);
  return ruta;
}

function escribirEnDisco(nombre, contenido = 'contenido de prueba') {
  const ruta = path.join(storage.localDir, nombre);
  fs.writeFileSync(ruta, contenido);
  return registrar(ruta);
}

function rutaDeLaFoto(url) {
  return registrar(path.join(storage.localDir, path.basename(url)));
}

// Guarda una foto en modo local y anota su ruta para borrarla al terminar.
async function guardarFoto(buffer, mimetype) {
  const url = await storage.savePhoto(buffer, mimetype);
  rutaDeLaFoto(url);
  return url;
}

const RE_UUID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';

beforeEach(() => {
  supabaseFalso.createClient.mockClear();
  clienteSupabaseFalso.storage.from.mockClear();
  subidasFalsas.upload.mockReset();
  subidasFalsas.upload.mockResolvedValue({ error: null });
  bajasFalsas.remove.mockReset();
  bajasFalsas.remove.mockResolvedValue({ error: null });
  urlsFalsas.getPublicUrl.mockReset();
  urlsFalsas.getPublicUrl.mockReturnValue({ data: { publicUrl: 'https://cdn.test/foto.jpg' } });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const ruta of creados) if (fs.existsSync(ruta)) fs.unlinkSync(ruta);
  creados.clear();
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.SUPABASE_BUCKET;
});

describe('modo disco local', () => {
  it('sin credenciales de Supabase no crea ningún cliente y usa la carpeta uploads/', () => {
    expect(storage.usingSupabase).toBe(false);
    expect(path.basename(storage.localDir)).toBe('uploads');
    expect(path.isAbsolute(storage.localDir)).toBe(true);
    expect(fs.existsSync(storage.localDir)).toBe(true);
    expect(supabaseFalso.createClient).not.toHaveBeenCalled();
  });

  it('con sólo SUPABASE_URL tampoco activa Supabase', () => {
    process.env.SUPABASE_URL = URL_SUPABASE;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    olvidar(RUTAS.storage);

    const recargado = requerir(RUTAS.storage);

    expect(recargado.usingSupabase).toBe(false);
    expect(supabaseFalso.createClient).not.toHaveBeenCalled();
  });

  it('crea la carpeta uploads al cargarse cuando todavía no existe', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const crear = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => undefined);

    const recargado = cargarStorage();

    expect(crear).toHaveBeenCalledTimes(1);
    expect(crear).toHaveBeenCalledWith(recargado.localDir, { recursive: true });
  });

  it('guarda una foto jpeg en el disco y devuelve su ruta pública', async () => {
    const buffer = Buffer.from('foto-jpeg');

    const url = await guardarFoto(buffer, 'image/jpeg');

    expect(url).toMatch(new RegExp(`^/uploads/${RE_UUID}\\.jpg$`));
    expect(fs.readFileSync(rutaDeLaFoto(url), 'utf8')).toBe('foto-jpeg');
  });

  it('traduce cada mimetype soportado a su extensión exacta', async () => {
    const jpeg = await guardarFoto(Buffer.from('j'), 'image/jpeg');
    const png = await guardarFoto(Buffer.from('p'), 'image/png');
    const webp = await guardarFoto(Buffer.from('w'), 'image/webp');

    expect(jpeg).toMatch(new RegExp(`^/uploads/${RE_UUID}\\.jpg$`));
    expect(png).toMatch(new RegExp(`^/uploads/${RE_UUID}\\.png$`));
    expect(webp).toMatch(new RegExp(`^/uploads/${RE_UUID}\\.webp$`));
    expect(path.extname(jpeg)).toBe('.jpg');
    expect(path.extname(png)).toBe('.png');
    expect(path.extname(webp)).toBe('.webp');
    expect(jpeg.endsWith('.jpg')).toBe(true);
    expect(png.endsWith('.png')).toBe(true);
    expect(webp.endsWith('.webp')).toBe(true);
    expect(fs.existsSync(rutaDeLaFoto(jpeg))).toBe(true);
    expect(fs.existsSync(rutaDeLaFoto(png))).toBe(true);
    expect(fs.existsSync(rutaDeLaFoto(webp))).toBe(true);
  });

  it('un mimetype desconocido (o ausente) guarda el archivo sin extensión', async () => {
    const gif = await guardarFoto(Buffer.from('g'), 'image/gif');
    const sinTipo = await guardarFoto(Buffer.from('x'), undefined);
    const nulo = await guardarFoto(Buffer.from('y'), null);

    expect(gif).toMatch(new RegExp(`^/uploads/${RE_UUID}$`));
    expect(sinTipo).toMatch(new RegExp(`^/uploads/${RE_UUID}$`));
    expect(nulo).toMatch(new RegExp(`^/uploads/${RE_UUID}$`));
    expect(path.extname(gif)).toBe('');
    expect(path.extname(sinTipo)).toBe('');
    expect(path.extname(nulo)).toBe('');
  });

  it('cada foto recibe un nombre distinto', async () => {
    const primera = await guardarFoto(Buffer.from('1'), 'image/jpeg');
    const segunda = await guardarFoto(Buffer.from('1'), 'image/jpeg');

    expect(primera).not.toBe(segunda);
    expect(fs.readFileSync(rutaDeLaFoto(primera), 'utf8')).toBe('1');
    expect(fs.readFileSync(rutaDeLaFoto(segunda), 'utf8')).toBe('1');
  });
});

describe('deletePhoto en modo disco local', () => {
  it('con null, undefined o cadena vacía no hace nada', async () => {
    const borrar = vi.spyOn(fs, 'unlinkSync');

    await expect(storage.deletePhoto(null)).resolves.toBeUndefined();
    await expect(storage.deletePhoto(undefined)).resolves.toBeUndefined();
    await expect(storage.deletePhoto('')).resolves.toBeUndefined();

    expect(borrar).not.toHaveBeenCalled();
    expect(bajasFalsas.remove).not.toHaveBeenCalled();
  });

  it('borra del disco la foto que existe', async () => {
    const ruta = escribirEnDisco('rastro-prueba-borrar.jpg');
    const borrar = vi.spyOn(fs, 'unlinkSync');

    await storage.deletePhoto('/uploads/rastro-prueba-borrar.jpg');

    expect(borrar).toHaveBeenCalledWith(ruta);
    expect(fs.existsSync(ruta)).toBe(false);
  });

  it('si el archivo ya no existe no falla ni llama a unlinkSync', async () => {
    const borrar = vi.spyOn(fs, 'unlinkSync');

    await expect(storage.deletePhoto('/uploads/no-existe-jamas.jpg')).resolves.toBeUndefined();

    expect(borrar).not.toHaveBeenCalled();
  });

  it('ignora las URLs que no empiezan por /uploads/', async () => {
    const borrar = vi.spyOn(fs, 'unlinkSync');

    await storage.deletePhoto('https://cdn.test/foto.jpg');
    await storage.deletePhoto('fotos/foto.jpg');
    await storage.deletePhoto('/otra-carpeta/foto.jpg');

    expect(borrar).not.toHaveBeenCalled();
  });

  it('una URL externa no borra el archivo local que se llame igual', async () => {
    // El archivo existe: si el módulo no exigiera el prefijo /uploads/, una URL
    // ajena con el mismo nombre de archivo lo borraría del disco.
    const ruta = escribirEnDisco('foto-ajena.jpg');

    await storage.deletePhoto('https://cdn.test/foto-ajena.jpg');
    expect(fs.existsSync(ruta)).toBe(true);

    await storage.deletePhoto('fotos/foto-ajena.jpg');
    expect(fs.existsSync(ruta)).toBe(true);

    // El contraste: con el prefijo correcto sí se borra.
    await storage.deletePhoto('/uploads/foto-ajena.jpg');
    expect(fs.existsSync(ruta)).toBe(false);
  });

  it('usa sólo el nombre del archivo, sin aceptar rutas con ../', async () => {
    const ruta = escribirEnDisco('rastro-prueba-traversal.txt');
    const borrar = vi.spyOn(fs, 'unlinkSync');

    await storage.deletePhoto('/uploads/../rastro-prueba-traversal.txt');

    expect(borrar).toHaveBeenCalledWith(path.join(storage.localDir, 'rastro-prueba-traversal.txt'));
    expect(fs.existsSync(ruta)).toBe(false);
  });

  it('un error al borrar no se propaga', async () => {
    escribirEnDisco('rastro-prueba-error.jpg');
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw new Error('EACCES: permiso denegado');
    });

    await expect(storage.deletePhoto('/uploads/rastro-prueba-error.jpg')).resolves.toBeUndefined();
  });
});

describe('modo Supabase Storage', () => {
  it('con las dos credenciales crea el cliente con la URL y la llave de servicio', () => {
    const recargado = cargarStorage({ supabase: true });

    expect(recargado.usingSupabase).toBe(true);
    expect(supabaseFalso.createClient).toHaveBeenCalledTimes(1);
    expect(supabaseFalso.createClient).toHaveBeenCalledWith(URL_SUPABASE, CLAVE_SERVICIO);
  });

  it('sube la foto al bucket con su contentType, sin sobrescribir, y devuelve la URL pública', async () => {
    const recargado = cargarStorage({ supabase: true });
    const buffer = Buffer.from('foto-png');
    urlsFalsas.getPublicUrl.mockReturnValue({
      data: { publicUrl: 'https://proyecto.supabase.co/storage/v1/object/public/fotos/abc.png' }
    });

    const url = await recargado.savePhoto(buffer, 'image/png');

    expect(url).toBe('https://proyecto.supabase.co/storage/v1/object/public/fotos/abc.png');
    expect(clienteSupabaseFalso.storage.from).toHaveBeenCalledWith('fotos');
    expect(subidasFalsas.upload).toHaveBeenCalledTimes(1);
    const [nombre, contenido, opciones] = subidasFalsas.upload.mock.calls[0];
    expect(nombre).toMatch(new RegExp(`^${RE_UUID}\\.png$`));
    expect(contenido).toBe(buffer);
    expect(opciones).toEqual({ contentType: 'image/png', upsert: false });
    expect(urlsFalsas.getPublicUrl).toHaveBeenCalledWith(nombre);
  });

  it('respeta SUPABASE_BUCKET cuando está configurado', async () => {
    const recargado = cargarStorage({ supabase: true, bucket: 'mascotas' });

    await recargado.savePhoto(Buffer.from('x'), 'image/jpeg');

    expect(clienteSupabaseFalso.storage.from).toHaveBeenCalledWith('mascotas');
  });

  it('si Supabase responde con error lanza un Error con el motivo', async () => {
    const recargado = cargarStorage({ supabase: true });
    subidasFalsas.upload.mockResolvedValue({ error: { message: 'bucket no encontrado' } });

    const error = await recargado.savePhoto(Buffer.from('x'), 'image/jpeg').catch(e => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('No se pudo subir la foto a Supabase Storage: bucket no encontrado');
    expect(urlsFalsas.getPublicUrl).not.toHaveBeenCalled();
  });

  it('borra del bucket sólo las URLs que apuntan a su carpeta pública', async () => {
    const recargado = cargarStorage({ supabase: true });

    await recargado.deletePhoto(
      'https://proyecto.supabase.co/storage/v1/object/public/fotos/carpeta/foto.jpg'
    );

    expect(clienteSupabaseFalso.storage.from).toHaveBeenCalledWith('fotos');
    expect(bajasFalsas.remove).toHaveBeenCalledTimes(1);
    expect(bajasFalsas.remove).toHaveBeenCalledWith(['carpeta/foto.jpg']);
  });

  it('no toca el bucket si la URL es de otro bucket o de otro sitio', async () => {
    const recargado = cargarStorage({ supabase: true });
    const borrarDisco = vi.spyOn(fs, 'unlinkSync');

    await recargado.deletePhoto('https://proyecto.supabase.co/storage/v1/object/public/otros/foto.jpg');
    await recargado.deletePhoto('https://cdn.test/foto.jpg');

    expect(bajasFalsas.remove).not.toHaveBeenCalled();
    expect(borrarDisco).not.toHaveBeenCalled();
  });

  it('no borra cuando la URL termina justo en la carpeta (sin nombre de archivo)', async () => {
    const recargado = cargarStorage({ supabase: true });

    await recargado.deletePhoto('https://proyecto.supabase.co/storage/v1/object/public/fotos/');

    expect(bajasFalsas.remove).not.toHaveBeenCalled();
  });

  it('un error de Supabase al borrar no se propaga', async () => {
    const recargado = cargarStorage({ supabase: true });
    bajasFalsas.remove.mockRejectedValue(new Error('sin conexión'));

    await expect(
      recargado.deletePhoto('https://proyecto.supabase.co/storage/v1/object/public/fotos/foto.jpg')
    ).resolves.toBeUndefined();
  });

  it('en modo Supabase una URL local igual se borra del disco', async () => {
    const recargado = cargarStorage({ supabase: true });
    const ruta = escribirEnDisco('rastro-prueba-mixta.jpg');

    await recargado.deletePhoto('/uploads/rastro-prueba-mixta.jpg');

    expect(bajasFalsas.remove).not.toHaveBeenCalled();
    expect(fs.existsSync(ruta)).toBe(false);
  });
});
