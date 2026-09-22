// db.js
// Postgres (compatible con Supabase). En local puedes apuntar DATABASE_URL a
// cualquier Postgres (incluso uno instalado en tu máquina); en producción,
// apúntalo a la cadena de conexión que te da tu proyecto de Supabase.
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('Falta DATABASE_URL en el archivo .env (cadena de conexión de Postgres/Supabase).');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requiere SSL; en Postgres local normalmente no hace falta.
  ssl: process.env.DATABASE_URL.includes('supabase.co') ? { rejectUnauthorized: false } : false
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      phone TEXT,
      google_sub TEXT,
      token_version INTEGER NOT NULL DEFAULT 0,
      -- DEFAULT TRUE: las cuentas que ya existían antes de agregar la
      -- verificación quedan verificadas. El registro siempre inserta el valor
      -- explícito (FALSE), así que las cuentas nuevas parten sin verificar.
      email_verified BOOLEAN NOT NULL DEFAULT TRUE,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reports (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      estado TEXT NOT NULL CHECK (estado IN ('perdido','encontrado')),
      tipo TEXT NOT NULL,
      sexo TEXT NOT NULL,
      color TEXT NOT NULL,
      raza TEXT,
      collar TEXT,
      descripcion TEXT,
      nombre_mascota TEXT,
      foto_url TEXT,           -- URL pública (Supabase Storage) o ruta local /uploads/...
      foto_hash TEXT,          -- dHash de la foto (64 bits en hex) para detectar duplicados
      -- Microchip (dato privado, ISO 11784/11785). NUNCA se guarda el número en
      -- claro: chip_hash es el HMAC con el que se compara y chip_cifrado es el
      -- AES-GCM del que sale, solo para su dueño, el número con el botón "ver".
      chip_hash TEXT,
      chip_cifrado TEXT,
      lat DOUBLE PRECISION NOT NULL,        -- ubicación exacta, nunca se expone públicamente
      lng DOUBLE PRECISION NOT NULL,
      lat_public DOUBLE PRECISION NOT NULL, -- ubicación difuminada (~300m) para el mapa público
      lng_public DOUBLE PRECISION NOT NULL,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      resolved BOOLEAN NOT NULL DEFAULT FALSE,
      resolved_at BIGINT,
      flags INTEGER NOT NULL DEFAULT 0,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      mensaje TEXT NOT NULL,
      lat DOUBLE PRECISION,
      lng DOUBLE PRECISION,
      created_at BIGINT NOT NULL,
      read BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS password_resets (
      token TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      token TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS report_flags (
      report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (report_id, user_id)
    );

    -- Alertas por zona: el usuario guarda un punto (su barrio) y recibe avisos
    -- de mascotas perdidas cerca. Una zona por usuario.
    CREATE TABLE IF NOT EXISTS zone_alerts (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      created_at BIGINT NOT NULL
    );
  `);

  // Migraciones para bases de datos creadas con la versión anterior del esquema.
  await pool.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT TRUE;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS resolved_at BIGINT;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS flags INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS reunion_foto_url TEXT;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS reunion_nota TEXT;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS perdido_hace_horas INTEGER;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS radio_km DOUBLE PRECISION;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS foto_hash TEXT;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS chip_hash TEXT;
    ALTER TABLE reports ADD COLUMN IF NOT EXISTS chip_cifrado TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS recipient_user_id UUID REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
  `);

  // Normaliza un correo para detectar cuentas duplicadas del MISMO buzón.
  // Se hace en SQL (y no solo en JS) para poder ponerle un índice único: así la
  // regla también vale ante dos registros simultáneos.
  //
  // Por qué existe: normalizeEmail() de express-validator solo quita el "+alias"
  // en Gmail, Outlook y Yahoo. En cualquier otro dominio "a@x.com" y
  // "a+loquesea@x.com" llegan al mismo buzón, así que sin esto se podían crear
  // identidades ilimitadas (para publicar y reportar) con un solo correo real.
  //
  // Tiene que dar EXACTAMENTE el mismo resultado que normalizarCuenta() de
  // middleware/client-ip.js (hay una prueba que compara ambas).
  //
  // OJO: va en una sola línea a propósito. Postgres no admite cuerpos de función
  // en formato "SQL estándar" (BEGIN ATOMIC) antes de la versión 14; con una
  // única expresión funciona en cualquier versión.
  await pool.query(`
    CREATE OR REPLACE FUNCTION normalizar_correo(texto TEXT)
    RETURNS TEXT AS $$ SELECT CASE WHEN strpos(btrim(texto), '@') > 0 THEN split_part(split_part(lower(btrim(texto)), '+', 1), '@', 1) || '@' || split_part(lower(btrim(texto)), '@', 2) ELSE lower(btrim(texto)) END $$ LANGUAGE sql IMMUTABLE;
  `);

  // Aviso si ya hay cuentas duplicadas del mismo buzón (creadas antes de este
  // índice). No rompe el arranque: solo lo señala para que se puedan revisar.
  try {
    const dups = await pool.query(`
      SELECT normalizar_correo(email) AS cuenta, count(*)::int AS n, string_agg(email, ', ') AS correos
        FROM users GROUP BY 1 HAVING count(*) > 1 ORDER BY n DESC LIMIT 20
    `);
    if (dups.rows.length) {
      console.warn('[db] Correos duplicados del mismo buzón (revisar a mano):');
      for (const d of dups.rows) console.warn(`      ${d.cuenta} x${d.n}  ->  ${d.correos}`);
    }
  } catch (e) {
    console.warn('[db] No se pudo comprobar duplicados de correo:', e.message);
  }

  // Índices (después de las migraciones, para que las columnas nuevas ya existan).
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_reports_estado_tipo ON reports(estado, tipo, active);
    CREATE INDEX IF NOT EXISTS idx_reports_foto_hash ON reports(foto_hash);
    CREATE INDEX IF NOT EXISTS idx_reports_chip_hash ON reports(chip_hash);
    CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_report ON messages(report_id);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_user_id);
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
    CREATE INDEX IF NOT EXISTS idx_emailverif_user ON email_verifications(user_id);
    CREATE INDEX IF NOT EXISTS idx_zone_alertas ON zone_alerts(lat, lng);
  `);

  // Índice único sobre el correo normalizado. Si ya existen duplicados de antes,
  // el índice fallaría al crearse y el servidor no arrancaría; en ese caso se
  // avisa y se sigue (el registro igual comprueba duplicados antes de insertar).
  try {
    await pool.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_users_correo_normalizado ON users(normalizar_correo(email))'
    );
  } catch (e) {
    console.warn('[db] No se pudo crear el índice único de correo normalizado:', e.message);
    console.warn(
      '[db] Suele significar que hay cuentas duplicadas del mismo buzón. Revísalas y vuelve a arrancar.'
    );
  }

  // Rellena el destinatario de los mensajes antiguos (eran siempre al dueño del aviso).
  await pool.query(`
    UPDATE messages m
       SET recipient_user_id = r.user_id
      FROM reports r
     WHERE m.report_id = r.id
       AND m.recipient_user_id IS NULL
  `);
}

module.exports = { pool, init, query: (text, params) => pool.query(text, params) };
