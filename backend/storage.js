// storage.js
// Si SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY están configurados, las fotos se
// suben a Supabase Storage (persisten para siempre, gratis dentro de su límite).
// Si no están configurados, se guardan en el disco local del servidor —
// funciona para probar, pero en Render (plan gratis) se borran al reiniciar.
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const BUCKET = process.env.SUPABASE_BUCKET || 'fotos';
const useSupabase = !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

let supabase = null;
if (useSupabase) {
  const { createClient } = require('@supabase/supabase-js');
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

const localDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(localDir)) fs.mkdirSync(localDir, { recursive: true });

const EXT_BY_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

/**
 * Guarda una foto y devuelve la URL pública para usar en foto_url.
 * @param {Buffer} buffer contenido del archivo
 * @param {string} mimetype tipo real detectado por multer
 */
async function savePhoto(buffer, mimetype) {
  const ext = EXT_BY_MIME[mimetype] || '';
  const filename = uuidv4() + ext;

  if (useSupabase) {
    const { error } = await supabase.storage.from(BUCKET).upload(filename, buffer, {
      contentType: mimetype,
      upsert: false
    });
    if (error) throw new Error('No se pudo subir la foto a Supabase Storage: ' + error.message);
    const { data } = supabase.storage.from(BUCKET).getPublicUrl(filename);
    return data.publicUrl;
  }

  fs.writeFileSync(path.join(localDir, filename), buffer);
  return `/uploads/${filename}`;
}

// Saca bucket y ruta de una URL pública de Supabase Storage:
//
//   https://<proyecto>.supabase.co/storage/v1/object/public/<bucket>/<ruta>
//
// El bucket se lee de la PROPIA URL, no de la constante BUCKET: si el operador
// cambia SUPABASE_BUCKET, las fotos subidas con el bucket anterior se quedaban
// sin borrar nunca (huérfanas ocupando cuota para siempre).
function partesDeUrlSupabase(fotoUrl) {
  const re = /\/storage\/v1\/object\/public\/([^/]+)\/(.+)$/;
  const m = re.exec(fotoUrl);
  if (!m) return null;
  return { bucket: decodeURIComponent(m[1]), ruta: decodeURIComponent(m[2]) };
}

async function deletePhoto(fotoUrl) {
  if (!fotoUrl) return;
  try {
    const partes = partesDeUrlSupabase(fotoUrl);
    if (useSupabase && partes) {
      await supabase.storage.from(partes.bucket).remove([partes.ruta]);
    } else if (fotoUrl.startsWith('/uploads/')) {
      const p = path.join(localDir, path.basename(fotoUrl));
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  } catch (e) {
    /* no bloquear la operación principal por un error de limpieza */
  }
}

module.exports = { savePhoto, deletePhoto, usingSupabase: useSupabase, localDir };
