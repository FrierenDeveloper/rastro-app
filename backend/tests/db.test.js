// Pruebas de backend/db.js.
//
// Cubren las tres cosas que hace el módulo: construir el Pool al cargarse (con
// SSL sólo cuando la URL es de Supabase), ejecutar init() (esquema, migraciones,
// índices y relleno del destinatario) y delegar query() en el pool.
//
// El `import` de db.js es estático para que el grafo de Vite (y por lo tanto
// Stryker con `vitest related`) relacione este archivo con el módulo. El driver
// `pg` ya viene sustituido por el doble de tests/helpers/externos.js, que se
// importa ANTES.
vi.hoisted(() => {
  process.env.DATABASE_URL = 'postgres://pruebas:pruebas@localhost:5432/pruebas';
  process.env.NODE_ENV = 'test';
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PoolFalso, poolFalso, olvidar, requerir, RUTAS } from './helpers/externos.js';
import db from '../db.js';

const URL_LOCAL = 'postgres://pruebas:pruebas@localhost:5432/pruebas';
const URL_SUPABASE = 'postgres://usuario:clave@aws-0-sa-east-1.pooler.supabase.co:6543/postgres';

// db.js lee el entorno al cargarse, así que cada configuración exige recargarlo.
// El Pool falso es siempre el mismo objeto (PoolFalso lo devuelve), sólo cambian
// las opciones con que se lo construyó.
function cargarDb() {
  olvidar(RUTAS.db);
  PoolFalso.mockClear();
  return requerir(RUTAS.db);
}

function opcionesDelPool() {
  return PoolFalso.mock.calls.at(-1)[0];
}

// Deja el query del pool respondiendo: `duplicados` para la consulta de correos
// repetidos y un error para cualquier consulta cuyo texto contenga una marca.
function configurarConsultas({ duplicados = { rows: [] }, fallas = {} } = {}) {
  poolFalso.query.mockImplementation(async texto => {
    for (const [marca, mensaje] of Object.entries(fallas)) {
      if (String(texto).includes(marca)) throw new Error(mensaje);
    }
    if (String(texto).includes('HAVING count(*) > 1')) return duplicados;
    return { rows: [] };
  });
}

// Texto de todas las consultas que init() envió al pool, en orden.
function sqlEnviado() {
  return poolFalso.query.mock.calls.map(([texto]) => String(texto)).join('\n');
}

let avisos;
let errores;

beforeEach(() => {
  avisos = vi.spyOn(console, 'warn').mockImplementation(() => {});
  errores = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.env.DATABASE_URL = URL_LOCAL;
  poolFalso.query.mockReset();
  poolFalso.query.mockResolvedValue({ rows: [] });
  PoolFalso.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env.DATABASE_URL = URL_LOCAL;
});

describe('construcción del Pool', () => {
  it('usa la cadena de DATABASE_URL y desactiva SSL fuera de Supabase', () => {
    cargarDb();

    expect(PoolFalso).toHaveBeenCalledTimes(1);
    expect(opcionesDelPool().connectionString).toBe(URL_LOCAL);
    expect(opcionesDelPool().ssl).toBe(false);
    expect(opcionesDelPool()).toEqual({
      connectionString: URL_LOCAL,
      ssl: false,
      max: 10,
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000
    });
    expect(db.pool).toBe(poolFalso);
  });

  it('activa SSL sin verificar el certificado cuando la URL es de supabase.co', () => {
    process.env.DATABASE_URL = URL_SUPABASE;
    cargarDb();

    expect(PoolFalso).toHaveBeenCalledTimes(1);
    expect(opcionesDelPool().connectionString).toBe(URL_SUPABASE);
    expect(opcionesDelPool().ssl).toEqual({ rejectUnauthorized: false });
  });

  it('detecta supabase.co en cualquier parte de la cadena, no sólo al final', () => {
    process.env.DATABASE_URL = 'postgres://usuario:clave@db.supabase.co:5432/postgres';
    cargarDb();

    expect(opcionesDelPool().connectionString).toBe('postgres://usuario:clave@db.supabase.co:5432/postgres');
    expect(opcionesDelPool().ssl).toEqual({ rejectUnauthorized: false });
  });

  it('un anfitrión parecido (supabase.io) NO activa SSL', () => {
    process.env.DATABASE_URL = 'postgres://usuario:clave@db.supabase.io:5432/postgres';
    cargarDb();

    expect(opcionesDelPool().ssl).toBe(false);
  });

  // Sin listener de 'error', el pool relanza el error de una conexión ociosa
  // como excepción NO capturada y el proceso Node muere entero. Lo dispara la
  // infraestructura (el pooler cierra conexiones ociosas, un failover, un corte
  // de NAT), así que no es hipotético: es una caída esperando a ocurrir.
  function manejadorDeError() {
    cargarDb();
    const registro = poolFalso.on.mock.calls.find(([evento]) => evento === 'error');
    expect(registro).toBeDefined();
    return registro[1];
  }

  it('registra un listener que deja constancia del error en vez de morir', () => {
    const manejador = manejadorDeError();

    expect(() => manejador(new Error('conexión cerrada por el servidor'))).not.toThrow();
    // Se afirma el CONTENIDO, no sólo que no reviente: si el console.error
    // desapareciera o dejara de incluir el mensaje, la caída de conexiones
    // pasaría inadvertida en los registros y nadie se enteraría.
    expect(errores).toHaveBeenCalledWith(
      '[db] error en una conexión ociosa del pool:',
      'conexión cerrada por el servidor'
    );
  });

  it('el listener no depende de que el error traiga mensaje', () => {
    const manejador = manejadorDeError();

    expect(() => manejador(undefined)).not.toThrow();
    expect(errores).toHaveBeenCalledWith('[db] error en una conexión ociosa del pool:', undefined);
  });

  it('faltando DATABASE_URL avisa por consola y termina con código 1', () => {
    delete process.env.DATABASE_URL;
    // El espía imita la salida real: process.exit() no vuelve, así que el módulo
    // no llega a la línea que leería DATABASE_URL.
    const salir = vi.spyOn(process, 'exit').mockImplementation(codigo => {
      throw new Error(`process.exit(${codigo})`);
    });

    expect(() => cargarDb()).toThrow('process.exit(1)');
    expect(errores).toHaveBeenCalledWith(
      'Falta DATABASE_URL en el archivo .env (cadena de conexión de Postgres/Supabase).'
    );
    expect(salir).toHaveBeenCalledWith(1);
  });

  it('una DATABASE_URL vacía también cuenta como ausente', () => {
    process.env.DATABASE_URL = '';
    const salir = vi.spyOn(process, 'exit').mockImplementation(codigo => {
      throw new Error(`process.exit(${codigo})`);
    });

    expect(() => cargarDb()).toThrow('process.exit(1)');
    expect(errores).toHaveBeenCalledTimes(1);
    expect(salir).toHaveBeenCalledWith(1);
  });

  it('exporta pool, init y query', () => {
    const recargado = cargarDb();

    expect(Object.keys(recargado).sort()).toEqual(['init', 'pool', 'query']);
    expect(typeof recargado.init).toBe('function');
    expect(typeof recargado.query).toBe('function');
  });
});

describe('query', () => {
  it('delega en pool.query con los mismos argumentos y devuelve su resultado', async () => {
    const esperado = { rows: [{ id: 7 }] };
    poolFalso.query.mockResolvedValue(esperado);

    await expect(db.query('SELECT id FROM users WHERE id = $1', ['7'])).resolves.toBe(esperado);
    expect(poolFalso.query).toHaveBeenCalledTimes(1);
    expect(poolFalso.query).toHaveBeenCalledWith('SELECT id FROM users WHERE id = $1', ['7']);
  });

  it('devuelve tal cual el valor resuelto por el pool', async () => {
    const respuesta = { rows: [{ total: 3 }] };
    poolFalso.query.mockResolvedValue(respuesta);

    const devuelto = await db.query('SELECT 1', [7]);

    expect(devuelto).toBe(respuesta);
    expect(poolFalso.query).toHaveBeenCalledTimes(1);
    expect(poolFalso.query).toHaveBeenCalledWith('SELECT 1', [7]);
  });

  it('sin parámetros pasa undefined como segundo argumento y devuelve el resultado', async () => {
    const respuesta = { rows: [] };
    poolFalso.query.mockResolvedValue(respuesta);

    const devuelto = await db.query('SELECT 1');

    expect(devuelto).toBe(respuesta);
    expect(poolFalso.query).toHaveBeenCalledWith('SELECT 1', undefined);
  });

  it('propaga el rechazo del pool', async () => {
    poolFalso.query.mockRejectedValue(new Error('sin conexión'));

    await expect(db.query('SELECT 1')).rejects.toThrow('sin conexión');
  });
});

describe('init', () => {
  it('envía esquema, migraciones, índices y relleno en siete consultas', async () => {
    configurarConsultas();

    await expect(db.init()).resolves.toBeUndefined();
    expect(poolFalso.query).toHaveBeenCalledTimes(7);
  });

  it('el esquema crea todas las tablas con sus columnas clave', async () => {
    configurarConsultas();
    await db.init();

    const sql = sqlEnviado();
    const fragmentos = [
      'CREATE TABLE IF NOT EXISTS users',
      'CREATE TABLE IF NOT EXISTS reports',
      'CREATE TABLE IF NOT EXISTS messages',
      'CREATE TABLE IF NOT EXISTS password_resets',
      'CREATE TABLE IF NOT EXISTS email_verifications',
      'CREATE TABLE IF NOT EXISTS push_subscriptions',
      'CREATE TABLE IF NOT EXISTS report_flags',
      'CREATE TABLE IF NOT EXISTS zone_alerts',
      'CREATE TABLE IF NOT EXISTS chip_registrations',
      'CREATE TABLE IF NOT EXISTS chip_scan_events',
      'CREATE TABLE IF NOT EXISTS data_access_log',
      'email TEXT UNIQUE NOT NULL',
      'password_hash TEXT NOT NULL',
      'google_sub TEXT',
      'token_version INTEGER NOT NULL DEFAULT 0',
      'email_verified BOOLEAN NOT NULL DEFAULT TRUE',
      "estado TEXT NOT NULL CHECK (estado IN ('perdido','encontrado'))",
      'foto_url TEXT',
      'foto_hash TEXT',
      'lat_public DOUBLE PRECISION NOT NULL',
      'recipient_user_id UUID REFERENCES users(id) ON DELETE CASCADE',
      'read BOOLEAN NOT NULL DEFAULT FALSE'
    ];
    for (const fragmento of fragmentos) expect(sql).toContain(fragmento);
  });

  it('las migraciones agregan cada columna nueva con IF NOT EXISTS', async () => {
    configurarConsultas();
    await db.init();

    const sql = sqlEnviado();
    const fragmentos = [
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE',
      'ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved BOOLEAN NOT NULL DEFAULT FALSE',
      'ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at BIGINT',
      'ALTER TABLE reports ADD COLUMN IF NOT EXISTS flags INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE reports ADD COLUMN IF NOT EXISTS reunion_foto_url TEXT',
      'ALTER TABLE reports ADD COLUMN IF NOT EXISTS reunion_nota TEXT',
      'ALTER TABLE reports ADD COLUMN IF NOT EXISTS perdido_hace_horas INTEGER',
      'ALTER TABLE reports ADD COLUMN IF NOT EXISTS radio_km DOUBLE PRECISION',
      'ALTER TABLE reports ADD COLUMN IF NOT EXISTS foto_hash TEXT',
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS recipient_user_id UUID REFERENCES users(id) ON DELETE CASCADE',
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION',
      'ALTER TABLE messages ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION',
      'ALTER TABLE zone_alerts ADD COLUMN IF NOT EXISTS updated_at BIGINT',
      "ALTER TABLE zone_alerts ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'manual'"
    ];
    for (const fragmento of fragmentos) expect(sql).toContain(fragmento);
  });

  it('define la función SQL que normaliza el correo tal como la usa el índice', async () => {
    configurarConsultas();
    await db.init();

    const sql = sqlEnviado();
    expect(sql).toContain('CREATE OR REPLACE FUNCTION normalizar_correo(texto TEXT)');
    expect(sql).toContain("RETURNS TEXT AS $$ SELECT CASE WHEN strpos(btrim(texto), '@') > 0");
    expect(sql).toContain("split_part(split_part(lower(btrim(texto)), '+', 1), '@', 1)");
    expect(sql).toContain("split_part(lower(btrim(texto)), '@', 2)");
    expect(sql).toContain('LANGUAGE sql IMMUTABLE');
  });

  it('crea los índices y el índice único del correo normalizado', async () => {
    configurarConsultas();
    await db.init();

    const sql = sqlEnviado();
    const fragmentos = [
      'CREATE INDEX IF NOT EXISTS idx_reports_estado_tipo ON reports(estado, tipo, active)',
      'CREATE INDEX IF NOT EXISTS idx_reports_foto_hash ON reports(foto_hash)',
      'CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_messages_report ON messages(report_id)',
      'CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_user_id)',
      'CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_user_id)',
      'CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_emailverif_user ON email_verifications(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_zone_alertas ON zone_alerts(lat, lng)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_chip_registros_activo',
      'CREATE INDEX IF NOT EXISTS idx_chip_registros_dueno ON chip_registrations(owner_user_id)',
      'CREATE INDEX IF NOT EXISTS idx_chip_escaneos_hash ON chip_scan_events(chip_hash)',
      'CREATE INDEX IF NOT EXISTS idx_chip_escaneos_fecha ON chip_scan_events(scanned_at)',
      'CREATE INDEX IF NOT EXISTS idx_accesos_registro ON data_access_log(record_id)',
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_correo_normalizado ON users(normalizar_correo(email))'
    ];
    for (const fragmento of fragmentos) expect(sql).toContain(fragmento);
  });

  it('el índice único del correo se crea con una sola consulta sin parámetros', async () => {
    configurarConsultas();
    await db.init();

    const llamada = poolFalso.query.mock.calls.find(([texto]) =>
      String(texto).includes('idx_users_correo_normalizado')
    );
    expect(llamada).toHaveLength(1);
    expect(String(llamada[0])).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_correo_normalizado');
    // Va sola en su consulta (con try/catch): si hubiera duplicados, este índice
    // es el único que puede fallar sin impedir el arranque.
    expect(String(llamada[0]).match(/CREATE UNIQUE INDEX/g)).toHaveLength(1);
  });

  it('rellena el destinatario de los mensajes antiguos desde el aviso', async () => {
    configurarConsultas();
    await db.init();

    const llamada = poolFalso.query.mock.calls.find(([texto]) => String(texto).includes('UPDATE messages m'));
    expect(String(llamada[0])).toContain('SET recipient_user_id = r.user_id');
    expect(String(llamada[0])).toContain('FROM reports r');
    expect(String(llamada[0])).toContain('m.report_id = r.id');
    expect(String(llamada[0])).toContain('m.recipient_user_id IS NULL');
  });

  it('respeta el orden: migraciones, luego índices, luego el relleno', async () => {
    configurarConsultas();
    await db.init();

    const consultas = poolFalso.query.mock.calls.map(([texto]) => String(texto));
    const posMigraciones = consultas.findIndex(t => t.includes('ADD COLUMN IF NOT EXISTS radio_km'));
    const posIndices = consultas.findIndex(t => t.includes('idx_zone_alertas'));
    const posUnico = consultas.findIndex(t => t.includes('idx_users_correo_normalizado'));
    const posRelleno = consultas.findIndex(t => t.includes('UPDATE messages m'));

    expect(posMigraciones).toBeGreaterThan(-1);
    expect(posIndices).toBeGreaterThan(posMigraciones);
    expect(posUnico).toBeGreaterThan(posIndices);
    expect(posRelleno).toBeGreaterThan(posUnico);
  });

  it('pregunta por los correos duplicados del mismo buzón', async () => {
    configurarConsultas();
    await db.init();

    const sql = sqlEnviado();
    expect(sql).toContain('SELECT normalizar_correo(email) AS cuenta, count(*)::int AS n');
    expect(sql).toContain("string_agg(email, ', ') AS correos");
    expect(sql).toContain('FROM users GROUP BY 1 HAVING count(*) > 1');
    expect(sql).toContain('ORDER BY n DESC LIMIT 20');
  });

  it('sin duplicados no avisa nada', async () => {
    configurarConsultas({ duplicados: { rows: [] } });
    await db.init();

    expect(avisos).not.toHaveBeenCalled();
  });

  it('avisa por cada cuenta duplicada encontrada', async () => {
    configurarConsultas({
      duplicados: {
        rows: [
          { cuenta: 'ana@ejemplo.cl', n: 2, correos: 'ana@ejemplo.cl, ana+perro@ejemplo.cl' },
          {
            cuenta: 'bea@ejemplo.cl',
            n: 3,
            correos: 'bea@ejemplo.cl, bea+gato@ejemplo.cl, bea+ave@ejemplo.cl'
          }
        ]
      }
    });

    await db.init();

    expect(avisos.mock.calls.map(([texto]) => texto)).toEqual([
      '[db] Correos duplicados del mismo buzón (revisar a mano):',
      '      ana@ejemplo.cl x2  ->  ana@ejemplo.cl, ana+perro@ejemplo.cl',
      '      bea@ejemplo.cl x3  ->  bea@ejemplo.cl, bea+gato@ejemplo.cl, bea+ave@ejemplo.cl'
    ]);
  });

  it('si falla la consulta de duplicados avisa con el motivo y sigue con los índices', async () => {
    configurarConsultas({ fallas: { 'HAVING count(*) > 1': 'la función normalizar_correo no existe' } });

    await expect(db.init()).resolves.toBeUndefined();

    expect(avisos).toHaveBeenCalledWith(
      '[db] No se pudo comprobar duplicados de correo:',
      'la función normalizar_correo no existe'
    );
    expect(sqlEnviado()).toContain('CREATE INDEX IF NOT EXISTS idx_zone_alertas');
    expect(sqlEnviado()).toContain('UPDATE messages m');
  });

  it('si falla el índice único avisa dos veces y sigue con el relleno', async () => {
    configurarConsultas({ fallas: { idx_users_correo_normalizado: 'hay cuentas duplicadas' } });

    await expect(db.init()).resolves.toBeUndefined();

    expect(avisos).toHaveBeenCalledTimes(2);
    expect(avisos).toHaveBeenNthCalledWith(
      1,
      '[db] No se pudo crear el índice único de correo normalizado:',
      'hay cuentas duplicadas'
    );
    expect(avisos).toHaveBeenNthCalledWith(
      2,
      '[db] Suele significar que hay cuentas duplicadas del mismo buzón. Revísalas y vuelve a arrancar.'
    );
    expect(sqlEnviado()).toContain('UPDATE messages m');
  });
});
