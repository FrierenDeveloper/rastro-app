const express = require('express');
const rateLimit = require('express-rate-limit');
const { query, validationResult } = require('express-validator');

const router = express.Router();

// Límite propio: evita que alguien use la app para hacer scraping del geocodificador.
const geoLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas búsquedas seguidas. Espera un momento.' }
});

// Arma una etiqueta legible a partir de las propiedades de Photon.
function labelDe(p) {
  const partes = [];
  const push = v => { if (v && !partes.includes(v)) partes.push(v); };
  push(p.name);
  push([p.street, p.housenumber].filter(Boolean).join(' '));
  push(p.district || p.suburb || p.locality);
  push(p.city || p.town || p.village);
  return partes.join(', ');
}

// GET /api/geocode?q=texto
// Usa Photon (basado en OpenStreetMap, sin clave) pero SOLO devuelve resultados
// de Chile, y el navegador nunca habla con el servicio externo directamente.
router.get('/',
  geoLimiter,
  query('q').isString().trim().isLength({ min: 3, max: 120 }).withMessage('Escribe al menos 3 caracteres.'),
  async (req, res, next) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) return res.status(400).json({ error: errors.array()[0].msg });

      // Sesgo hacia Santiago para que los resultados cercanos salgan primero.
      const url = 'https://photon.komoot.io/api/?q=' + encodeURIComponent(req.query.q) +
        '&lat=-33.4489&lon=-70.6693&limit=8';

      let data;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Rastro/1.0 (+https://github.com/FrierenDeveloper/rastro-app)' },
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

      res.json({ results });
    } catch (err) { next(err); }
  }
);

module.exports = router;
