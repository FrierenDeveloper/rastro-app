// Aislamiento de los MÓDULOS DEL BACKEND para probar rutas y middlewares.
//
// Se importa como PRIMER import del test, antes del router o middleware:
//
//   import { db, storage, push, mailer } from './helpers/aislar.js';
//   import adminRouter from '../routes/admin.js';     // ya ve los dobles
//
// Deja dobles de db, storage, push y mailer en require.cache, y además los
// dobles de las dependencias externas (pg, web-push, supabase). Los dobles son
// vi.fn(): se reconfiguran por test (mockResolvedValue, mockImplementation...) y
// se comprueban con toHaveBeenCalledWith.
//
// OJO: un test que quiera cubrir db.js, storage.js, push.js o mailer.js NO debe
// usar este helper (sustituiría el módulo que quiere probar). Para esos casos:
// `import ... from './helpers/externos.js'` y luego el módulo real.
import { vi } from 'vitest';
export * from './externos.js';
import { inyectar, RUTAS } from './base.js';

export const db = inyectar(RUTAS.db, {
  query: vi.fn(async () => ({ rows: [] })),
  pool: {},
  init: vi.fn(async () => {})
});

export const storage = inyectar(RUTAS.storage, {
  savePhoto: vi.fn(async () => '/uploads/foto-de-prueba.jpg'),
  deletePhoto: vi.fn(async () => {}),
  usingSupabase: false,
  localDir: ''
});

export const push = inyectar(RUTAS.push, {
  sendToUser: vi.fn(async () => {}),
  enabled: true,
  publicKey: 'clave-publica-de-pruebas'
});

export const mailer = inyectar(RUTAS.mailer, {
  sendMail: vi.fn(async () => ({ id: 'correo-de-prueba' })),
  usingEmail: true,
  mailFrom: 'PetSeñal <pruebas@test.local>'
});
