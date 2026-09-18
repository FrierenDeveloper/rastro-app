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
      const partes = cadena.split(',').map(p => p.trim()).filter(Boolean);
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

// Clave para endpoints anónimos que además identifican una cuenta o un intento
// concreto (login / registro / recuperar contraseña / reset / Google). Sumar el
// identificador al cupo por IP evita que alguien pruebe contraseñas o tokens de
// una misma cuenta rotando la IP o la cabecera X-Forwarded-For: al agotar el
// cupo de ese identificador, se bloquea.
function keyPorIpYCuenta(req) {
  const cuerpo = req.body || {};
  const campos = [cuerpo.email, cuerpo.token, cuerpo.credential];
  for (const valor of campos) {
    if (typeof valor === 'string' && valor.trim()) {
      return `${ipReal(req)}|${valor.trim().toLowerCase().slice(0, 120)}`;
    }
  }
  return ipReal(req);
}

module.exports = { ipReal, keyPorIp, keyPorIpYCuenta };
