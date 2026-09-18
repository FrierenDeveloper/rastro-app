// Lee un cupo (máximo de peticiones) desde el entorno, con valor por defecto.
// Sirve para poder ajustar los límites sin tocar el código: pruebas de carga,
// comunidades grandes detrás de una misma red, etc.
function numEnv(nombre, porDefecto) {
  const v = Number(process.env[nombre]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : porDefecto;
}

module.exports = { numEnv };
