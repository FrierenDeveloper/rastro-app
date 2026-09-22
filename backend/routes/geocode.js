const express = require('express');
const rateLimit = require('express-rate-limit');
const { query, validationResult } = require('express-validator');
const { requireAuth } = require('../middleware/auth');
const { keyPorIp } = require('../middleware/client-ip');

const router = express.Router();

// Límite propio: evita que alguien use la app para hacer scraping del geocodificador.
const geoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyPorIp,
  message: { error: 'Demasiadas búsquedas seguidas. Espera un momento.' }
});

// Caché en memoria (se reinicia al reiniciar el server). Guarda el resultado de
// una búsqueda por 24 h para no repetir llamadas al servicio externo.
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map();

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.results;
}
function cacheSet(key, results) {
  if (cache.size >= CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, { results, expires: Date.now() + CACHE_TTL });
}

// Arma una etiqueta legible a partir de las propiedades de Photon.
function labelDe(p) {
  const partes = [];
  const push = v => {
    if (v && !partes.includes(v)) partes.push(v);
  };
  push(p.name);
  push([p.street, p.housenumber].filter(Boolean).join(' '));
  push(p.district || p.suburb || p.locality);
  push(p.city || p.town || p.village);
  return partes.join(', ');
}

// GET /api/geocode?q=texto  (requiere sesión)
// Usa Photon (basado en OpenStreetMap, sin clave) pero SOLO devuelve resultados
// de Chile, y el navegador nunca habla con el servicio externo directamente.
router.get(
  '/',
  requireAuth,
  geoLimiter,
  query('q').isString().trim().isLength({ min: 3, max: 120 }).withMessage('Escribe al menos 3 caracteres.'),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      const key = req.query.q.toLowerCase().replace(/\s+/g, ' ').trim();
      const cached = cacheGet(key);
      if (cached) return res.json({ results: cached });

      // Sesgo hacia Santiago para que los resultados cercanos salgan primero.
      const url =
        'https://photon.komoot.io/api/?q=' +
        encodeURIComponent(req.query.q) +
        '&lat=-33.4489&lon=-70.6693&limit=8';

      let data;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const r = await fetch(url, {
          headers: { 'User-Agent': 'PetSeñal/1.0 (+https://github.com/FrierenDeveloper/rastro-app)' },
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!r.ok) throw new Error('geocoder ' + r.status);
        data = await r.json();
      } catch (e) {
        return res.status(502).json({ error: 'No se pudo buscar la dirección. Intenta de nuevo.' });
      }

      const results = (data.features || [])
        .filter(f => f.properties && f.properties.countrycode === 'CL')
        .map(f => ({
          label: labelDe(f.properties),
          lat: f.geometry.coordinates[1],
          lng: f.geometry.coordinates[0]
        }))
        .filter(r => r.label);

      cacheSet(key, results);
      res.json({ results });
    } catch (err) {
      next(err);
    }
  }
);

module.exports = router;
