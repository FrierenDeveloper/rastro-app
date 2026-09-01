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
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY,
      report_id UUID NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
      sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      mensaje TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      read BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE INDEX IF NOT EXISTS idx_reports_estado_tipo ON reports(estado, tipo, active);
    CREATE INDEX IF NOT EXISTS idx_messages_report ON messages(report_id);
  `);
}

module.exports = { pool, init, query: (text, params) => pool.query(text, params) };
