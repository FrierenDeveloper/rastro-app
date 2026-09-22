const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const VARIABLES = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'];

function configuracion(env) {
  if (!VARIABLES.every(nombre => Boolean(env[nombre]))) return null;
  return {
    accountId: env.R2_ACCOUNT_ID,
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    bucket: env.R2_BUCKET,
    publicUrl: env.R2_PUBLIC_URL.replace(/\/+$/, '')
  };
}

function clientePara(config) {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey
    }
  });
}

function claveDesdeUrl(fotoUrl, publicUrl) {
  try {
    const base = new URL(`${publicUrl}/`);
    const foto = new URL(fotoUrl);
    if (foto.origin !== base.origin || !foto.pathname.startsWith(base.pathname)) return null;
    const clave = decodeURIComponent(foto.pathname.slice(base.pathname.length));
    return clave || null;
  } catch (_) {
    return null;
  }
}

function urlPublica(publicUrl, clave) {
  const ruta = clave
    .split('/')
    .map(parte => encodeURIComponent(parte))
    .join('/');
  return `${publicUrl}/${ruta}`;
}

function crearR2(env = process.env) {
  const config = configuracion(env);
  if (!config) return null;
  const client = clientePara(config);

  return {
    async guardar(filename, buffer, contentType) {
      const key = `fotos/${filename}`;
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: config.bucket,
            Key: key,
            Body: buffer,
            ContentType: contentType,
            CacheControl: 'public, max-age=31536000, immutable'
          })
        );
      } catch (error) {
        throw new Error(`No se pudo subir la foto a Cloudflare R2: ${error.message}`);
      }
      return urlPublica(config.publicUrl, key);
    },

    async borrar(fotoUrl) {
      const key = claveDesdeUrl(fotoUrl, config.publicUrl);
      if (!key) return false;
      await client.send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
      return true;
    }
  };
}

module.exports = { crearR2, claveDesdeUrl, urlPublica };
