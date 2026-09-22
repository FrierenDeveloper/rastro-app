const crypto = require('crypto');

// Clave de rate limiting.
//
// Hallazgo de auditoría: con la configuración anterior, todos los límites se
// podían evadir mandando una cabecera `X-Forwarded-For` distinta en cada
// petición, porque express-rate-limit la usaba (a través de `req.ip`) como si
// fuera la IP del cliente. Un atacante podía así probar contraseñas sin límite.
//
// Regla que aplicamos ahora:
//   * Por defecto se usa la IP real de la conexión TCP (req.socket.remoteAddress).
//     Esa no la puede escribir el cliente, así que no se puede falsear.
//   * Solo si el operador define TRUST_PROXY >= 1 (es decir: "estoy detrás de
//     N proxies de confianza que reescriben X-Forwarded-For") se usa la
//     cabecera, tomando la entrada N contada desde la derecha: la que añadió
//     el proxy de confianza.
//
// Ojo: si dejas TRUST_PROXY sin definir, detrás de un proxy todos los usuarios
// comparten la IP del proxy y los límites por IP pasan a ser un cupo común.
// Es el precio de que no se puedan falsear; los cupos por cuenta (avisos,
// mensajes, reportes) siguen funcionando igual en cualquier caso.
function ipReal(req) {
  const hops = Number(process.env.TRUST_PROXY);
  // Solo se confía en X-Forwarded-For cuando el operador declara explícitamente
  // cuántos proxies de confianza tiene delante (TRUST_PROXY >= 1).
  const usarCabecera = Number.isFinite(hops) && hops >= 1;

  if (usarCabecera) {
    const saltos = Math.floor(hops);
    const cadena = req.headers['x-forwarded-for'];
    if (typeof cadena === 'string' && cadena.length) {
      const partes = cadena
        .split(',')
        .map(p => p.trim())
        .filter(Boolean);
      const ip = partes[partes.length - saltos];
      if (ip) return ip;
    }
  }
  return (req.socket && req.socket.remoteAddress) || req.ip || 'desconocido';
}

// Clave para express-rate-limit en endpoints anónimos (login, registro, etc.).
function keyPorIp(req) {
  return ipReal(req);
}

// Normaliza un correo para AGRUPAR intentos de la misma cuenta.
//
// No basta con normalizeEmail() de express-validator: ese sanitizador solo
// quita el "+alias" en Gmail, Outlook y Yahoo (los demás proveedores los
// conservan porque son direcciones legítimamente distintas). Comprobado:
//
//   victima+1@gmail.com -> victima@gmail.com      (lo agrupa)
//   victima+1@x.com     -> victima+1@x.com        (NO lo agrupa)
//
// Sin esto, un atacante que rote IPs Y añada un "+algo" distinto en cada
// intento abre un cupo nuevo cada vez y el límite por cuenta nunca se llena.
//
// Ojo con el alcance: si dos personas comparten un dominio propio y usan
// "+etiqueta" para distinguir buzones (común en empresas), cuentan como la
// misma cuenta a efectos del límite. El peor caso es que compartan el cupo de
// intentos de login; no se mezclan datos ni contraseñas.
function normalizarCuenta(email) {
  const texto = String(email || '')
    .trim()
    .toLowerCase();
  const corte = texto.lastIndexOf('@');
  if (corte <= 0) return texto;
  const local = texto.slice(0, corte);
  const dominio = texto.slice(corte + 1);
  // Quita todo lo que va después del primer "+" en la parte local.
  const sinAlias = local.split('+')[0];
  return `${sinAlias}@${dominio}`;
}

// Longitud a partir de la cual una credencial se resume con un hash en vez de
// usarse tal cual. Se eligió corta a propósito: las claves de express-rate-limit
// acaban en memoria y no aporta nada guardar un JWT entero.
const LARGO_MAXIMO = 64;

// Resume una credencial larga en un hash estable.
//
// Hallazgo de auditoría: antes se hacía `valor.slice(0, 120)`, y eso hacía que
// dos credenciales distintas con los mismos 120 primeros caracteres cayeran en
// el MISMO cupo. Con los JWT de Google pasa siempre: todos comparten cabecera
// (`eyJhbGciOiJSUzI1NiIs...`), así que varias cuentas quedaban mezcladas en un
// cupo común y se agotaban entre ellas. Un hash evita la colisión sin alargar
// la clave.
function resumir(valor) {
  if (valor.length <= LARGO_MAXIMO) return valor;
  return crypto.createHash('sha256').update(valor).digest('hex');
}

// Clave del cupo por cuenta (login / registro / recuperar contraseña / reset /
// Google). A propósito NO lleva la IP: el cupo es el mismo venga de donde venga
// la petición, para que la fuerza bruta distribuida contra una cuenta choque
// con el límite y no con una IP suelta.
//
// Contrapartida asumida: alguien puede dejar una cuenta 15 minutos en espera a
// propósito; solo molesta, no compromete nada.
function keyPorCuenta(req) {
  const cuerpo = req.body || {};
  if (typeof cuerpo.email === 'string' && cuerpo.email.trim()) {
    return 'cuenta:' + resumir(normalizarCuenta(cuerpo.email));
  }
  const valor =
    typeof cuerpo.token === 'string'
      ? cuerpo.token
      : typeof cuerpo.credential === 'string'
        ? cuerpo.credential
        : '';
  if (valor.trim()) return 'valor:' + resumir(valor.trim());
  return 'ip:' + ipReal(req);
}

module.exports = { ipReal, keyPorIp, keyPorCuenta, normalizarCuenta };
