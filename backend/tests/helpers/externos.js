// Dobles de las dependencias EXTERNAS (paquetes de node_modules), inyectados
// antes de que se evalúe el módulo a probar.
//
// Se importa como PRIMER import del test:
//
//   import { poolFalso, PoolFalso } from './helpers/externos.js';
//   import db from '../db.js';            // ya ve el Pool falso
//
// Inyectar los tres es inofensivo: el módulo que no los use ni se entera.
import { vi } from 'vitest';
export * from './base.js';
import { inyectar } from './base.js';

/* ------------------------------- Postgres -------------------------------- */
// `new Pool(...)` debe devolver este objeto para poder inspeccionar con qué
// opciones se construyó y qué consultas recibe.
export const poolFalso = { query: vi.fn(async () => ({ rows: [] })) };

export const PoolFalso = vi.fn(function () {
  return poolFalso;
});

// El driver entero, como lo ve db.js.
export const pgFalso = inyectar('pg', { Pool: PoolFalso });

/* ------------------------------- Web Push -------------------------------- */
export const webpushFalso = inyectar('web-push', {
  setVapidDetails: vi.fn(),
  sendNotification: vi.fn(async () => ({}))
});

/* ---------------------------- Supabase Storage --------------------------- */
// Cliente con la forma que usa storage.js: storage.from(bucket).upload/remove/
// getPublicUrl. Cada método es un vi.fn() que devuelve lo que se le configure.
export const subidasFalsas = { upload: vi.fn(async () => ({ error: null })) };
export const bajasFalsas = { remove: vi.fn(async () => ({ error: null })) };
export const urlsFalsas = {
  getPublicUrl: vi.fn(() => ({ data: { publicUrl: 'https://cdn.test/foto.jpg' } }))
};

export const clienteSupabaseFalso = {
  storage: {
    from: vi.fn(() => ({ ...subidasFalsas, ...bajasFalsas, ...urlsFalsas }))
  }
};

export const supabaseFalso = inyectar('@supabase/supabase-js', {
  createClient: vi.fn(() => clienteSupabaseFalso)
});
