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
// opciones se construyó y qué consultas recibe. `on` está porque db.js registra
// un listener de 'error' sobre el pool: sin esta función, cargar db.js en
// cualquier prueba reventaría con "pool.on is not a function".
export const poolFalso = { query: vi.fn(async () => ({ rows: [] })), on: vi.fn() };

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

/* ----------------------------- Cloudflare R2 ---------------------------- */
export const enviarR2Falso = vi.fn(async () => ({}));
export const clienteR2Falso = { send: enviarR2Falso };
export const S3ClientFalso = vi.fn(function (opciones) {
  this.opciones = opciones;
  return clienteR2Falso;
});
export class PutObjectCommandFalso {
  constructor(input) {
    this.input = input;
  }
}
export class DeleteObjectCommandFalso {
  constructor(input) {
    this.input = input;
  }
}
export const r2Falso = inyectar('@aws-sdk/client-s3', {
  S3Client: S3ClientFalso,
  PutObjectCommand: PutObjectCommandFalso,
  DeleteObjectCommand: DeleteObjectCommandFalso
});
