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
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS recipient_user_id UUID REFERENCES users(id) ON DELETE CASCADE;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION;
  `);

  // Índices (después de las migraciones, para que las columnas nuevas ya existan).
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_reports_estado_tipo ON reports(estado, tipo, active);
    CREATE INDEX IF NOT EXISTS idx_reports_user ON reports(user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_report ON messages(report_id);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient_user_id);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender_user_id);
    CREATE INDEX IF NOT EXISTS idx_push_user ON push_subscriptions(user_id);
    CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
    CREATE INDEX IF NOT EXISTS idx_emailverif_user ON email_verifications(user_id);
  `);

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
