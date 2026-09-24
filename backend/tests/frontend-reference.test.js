import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const frontendPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const html = fs.readFileSync(path.join(frontendPath, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(frontendPath, 'styles.css'), 'utf8');
const javascript = fs.readFileSync(path.join(frontendPath, 'app.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(frontendPath, 'manifest.json'), 'utf8'));

describe('pantalla principal de referencia', () => {
  it('mantiene la jerarquía visual de cabecera, mapa y navegación', () => {
    expect(html).toContain('class="header-brand"');
    expect(html).toContain('Más patas, más reencuentros');
    expect(html).toContain('class="home-map-stage"');
    expect(html).toContain('class="map-my-location"');
    expect(html).toContain('<span>Buscar</span>');
    expect(html).toContain('<span>Mi PetSeñal</span>');
    expect(html).toContain('<symbol id="i-petsenal-pin"');
    expect(html).toMatch(/class="brand-logo sm"[\s\S]*viewBox="0 0 40 48"[\s\S]*href="#i-petsenal-pin"/);
    expect(html).toMatch(/home-map-stage[\s\S]*id="list-map"/);
  });

  it('incluye los estados visuales de mapa, lista y tema oscuro', () => {
    expect(css).toContain('#view-home.home-list-mode');
    expect(css).toContain('.map-carousel-dots');
    expect(css).toContain('body.theme-dark .mode-toggle');
    expect(css).toContain('.home-map-stage > .home-map-tools');
    expect(css).toMatch(/\.home-map-stage > \.home-map-tools \{[^}]*display: grid/);
    expect(css).toContain('body.theme-dark .header-brand .gps-badge');
    expect(javascript).toContain("classList.toggle('home-list-mode', !conMapa)");
    expect(javascript).toContain("aplicarTema(guardado || 'light')");
  });

  it('mantiene el mapa nítido, controles compactos y separación sobre la navegación', () => {
    expect(css).toMatch(/\.home-actions \{[^}]*z-index: 2/);
    expect(css).toMatch(/\.home-map-stage \{[^}]*z-index: 0/);
    expect(css).toMatch(/\.home-map-stage \{[^}]*bottom: calc\(-68px/);
    expect(css).toMatch(/\.home-action \{[^}]*min-height: 84px/);
    expect(css).toMatch(/nav\.bottom-nav button \{[^}]*min-height: 48px/);
    expect(css).toMatch(/#view-home:not\(\.home-list-mode\) #reports-list \{[^}]*bottom: calc\(104px/);
    expect(css).toMatch(/#view-home:not\(\.home-list-mode\) \.home-actions \{[^}]*backdrop-filter: none/);
    expect(css).toMatch(/#view-home:not\(\.home-list-mode\) \.report-card \{[^}]*backdrop-filter: none/);
    expect(css).toMatch(/body:not\(\.theme-dark\) #list-map \.leaflet-layer \{[^}]*filter: none/);
  });

  it('convierte los puntos del mapa en navegación accesible entre avisos', () => {
    expect(html).toContain('id="map-carousel-status"');
    expect(html).toContain('aria-live="polite"');
    expect(javascript).toContain('actualizarCarruselMapa');
    expect(javascript).toContain("addEventListener('scroll'");
    expect(javascript).toContain('scrollTo({ left:');
    expect(css).not.toContain('.report-card:not(:first-child)');
  });

  it('oculta el zoom del mapa principal y funde el mapa con la barra inferior', () => {
    expect(javascript).toContain("L.map('list-map', { zoomControl: false })");
    expect(css).toMatch(
      /nav\.bottom-nav::before \{[^}]*linear-gradient\(to bottom, transparent, var\(--card\)\)/
    );
    expect(css).toMatch(/nav\.bottom-nav \{[^}]*background: var\(--card\)/);
  });

  it('muestra marcadores de mascotas visibles en el mapa', () => {
    expect(css).toMatch(/\.animal-marker \{[^}]*width: 46px[^}]*height: 46px/);
    expect(css).toMatch(/\.animal-emoji \.animal-svg \{[^}]*width: 42px[^}]*height: 42px/);
    expect(css).toMatch(/\.animal-collar \{[^}]*bottom: 2\.5px[^}]*width: 21px[^}]*height: 6px/);
    expect(javascript).toContain('iconSize: [52, 60]');
    expect(javascript).toContain('iconAnchor: [26, 56]');
  });

  it('presenta cinco tarjetas horizontales y termina con la misión', () => {
    expect(html.match(/class="onboard-step"/g)).toHaveLength(5);
    const dots = html.match(/class="onboard-dots">([\s\S]*?)<\/div>/)?.[1] || '';
    expect(dots.match(/<i/g)).toHaveLength(5);
    expect(html).toContain('Avisa a quienes están cerca');
    expect(html).toContain('onboard-map-ripple');
    expect(css).toMatch(/\.onboard-step\s*\{[^}]*grid-template-columns:/);
    expect(css).toContain('@keyframes onboard-radar-pulse');
    expect(html).toContain('<h3>Nuestra misión</h3>');
    expect(javascript).toContain('const ONBOARD_PASOS = 5');
    expect(javascript).toContain("localStorage.getItem('rastro_onboard') === '1'");
  });

  it('usa una foto real sin recortar en la tarjeta de publicar un aviso', () => {
    const paso = html.match(/<div class="onboard-step" data-step="1">[\s\S]*?data-step="2">/)?.[0] || '';
    expect(paso).toContain('class="onboard-visual onboard-photo"');
    expect(paso).toContain('src="img/onboard-aviso.jpg"');
    expect(paso).not.toContain('#i-camera');
    expect(css).toMatch(/\.onboard-photo img \{[^}]*object-fit: contain/);
    expect(fs.existsSync(path.join(frontendPath, 'img/onboard-aviso.jpg'))).toBe(true);
  });

  it('resume el consentimiento y separa la lectura de microchip', () => {
    expect(html).toContain('class="chip-consent-details"');
    expect(html).toContain('Leer consentimiento completo…');
    expect(html).toContain('id="btn-open-chip-scan"');
    expect(html).toContain('id="chip-scan-screen"');
    expect(javascript).toContain('data-action="chip-notify"');
    expect(javascript).toContain('notify_owner: true');
  });

  it('incluye un formulario de bugs dirigido al correo de soporte', () => {
    expect(html).toContain('id="btn-report-bug"');
    expect(html).toContain('id="bug-modal"');
    expect(html).toContain('id="bug-description"');
    expect(javascript).toContain('contacto@petsenal.com');
    expect(javascript).toContain('[BUG] PetSeñal');
  });

  it('incluye apoyo emocional práctico con respiración y recursos oficiales', () => {
    expect(html).toContain('id="btn-open-support"');
    expect(html).toContain('id="view-support"');
    expect(html).toContain('Calma inmediata y guía práctica');
    expect(html).toContain('Plan de búsqueda y pausas');
    expect(html).toContain('Red de apoyo y ayuda profesional');
    expect(html).toContain('id="breathing-status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('href="tel:*4141"');
    expect(html).toContain('href="tel:6003607777"');
    expect(html).toContain('href="tel:131"');
    expect(html).toContain('saludresponde.minsal.cl/gatekeepers-prevencion-del-suicidio');
    expect(javascript).toContain('detenerRespiracion');
    expect(javascript).toContain('navigator.share');
    expect(javascript).toContain('navigator.clipboard');
    expect(css).toContain(".breathing-orb[data-phase='inhale']");
    expect(css).toContain(".breathing-orb[data-phase='hold']");
    expect(css).toContain('animation: respiracion-mantener');
    expect(css).toContain(".breathing-orb[data-phase='exhale']");
    expect(css).toContain('@keyframes respiracion-exhalar');
    expect(css).toMatch(/\.breathing-orb\[data-phase='exhale'\] \{[^}]*animation: respiracion-exhalar 6s/);
  });

  it('incluye una ficha demo completa sin depender de campos opcionales', () => {
    expect(javascript).toContain("nombre: 'Coco'");
    expect(javascript).toContain("ubicacion: 'Palermo, CABA'");
    expect(javascript).toContain('r.nombre ? esc(r.nombre)');
    expect(javascript).toContain('r.ubicacion ? esc(r.ubicacion)');
    expect(javascript).toContain('<span class="animal-face"><span class="animal-emoji">');
    expect(javascript).toContain('</span><span class="animal-collar"');
    expect(javascript).toContain('<span class="pet-avatar-face">');
    expect(javascript).toContain('<span class="pet-avatar-collar"');
  });

  it('dibuja una pata vectorial con cuatro dedos y una almohadilla', () => {
    const paw = html.match(/<symbol id="i-paw"[\s\S]*?<\/symbol>/)?.[0] || '';
    const pin = html.match(/<symbol id="i-petsenal-pin"[\s\S]*?<\/symbol>/)?.[0] || '';
    expect(paw.match(/<ellipse/g)).toHaveLength(4);
    expect(paw).toContain('<path');
    expect(pin.match(/<ellipse/g)).toHaveLength(4);
    expect(pin).not.toContain('href="#i-paw"');
  });

  it('distingue las instalaciones para iPhone y Android con el mismo estilo', () => {
    expect(html).toContain('id="btn-install-ios"');
    expect(html).toContain('Instalar en iPhone');
    expect(html).toContain('id="btn-install-android"');
    expect(html).toContain('Descargar para Android');
    expect(html).toContain('href="/descargar/petsenal.apk"');
    expect(html).not.toContain('iPhone usa Safari y Android descarga el APK');
    expect(html.match(/class="auth-install-btn"/g)).toHaveLength(2);
    expect(javascript).toContain("getElementById('btn-install-ios')");
    expect(javascript).toContain('En iPhone o iPad');
    expect(javascript).toContain("'(display-mode: standalone)'");
    expect(javascript).toContain('Añadir a pantalla de inicio');
  });

  it('muestra la explicación del contacto dentro de Privacidad y no en el acceso', () => {
    const acceso = html.match(/id="auth-screen"[\s\S]*?id="app"/)?.[0] || '';
    const privacidad = html.match(/id="privacy-modal"[\s\S]*?id="zona-intro"/)?.[0] || '';
    const mensaje = 'Tu correo y teléfono nunca se muestran públicamente.';
    expect(acceso).not.toContain(mensaje);
    expect(privacidad).toContain(mensaje);
  });

  it('usa el pin de GPS con huella como logo en acceso y recuperación', () => {
    expect(html).toMatch(/id="auth-screen"[\s\S]*class="brand-logo lg"[\s\S]*href="#i-petsenal-pin"/);
    expect(html).toMatch(/id="reset-screen"[\s\S]*class="brand-logo lg"[\s\S]*href="#i-petsenal-pin"/);
    expect(html).toContain('<h1 class="serif">PetSeñal</h1>');
  });

  it('conserva un paquete web instalable e independiente', () => {
    expect(manifest.id).toBe('/');
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
    expect(manifest.display).toBe('standalone');
    expect(manifest.prefer_related_applications).toBe(false);
    expect(manifest.icons.some(icon => icon.sizes === '512x512' && icon.purpose === 'maskable')).toBe(true);
  });

  it('fija el armazón al viewport dinámico para que la vista Mapa no desplace el documento', () => {
    // body y #app deben usar la MISMA unidad de viewport. Si el armazón es 100dvh
    // pero el body queda en 100vh (viewport grande), en móvil con la barra visible
    // el documento supera al viewport y toda la interfaz se desplaza en vertical.
    expect(css).toMatch(/\bbody\s*\{[^}]*min-height:\s*100dvh/);
    expect(css).toMatch(/#app\s*\{[^}]*height:\s*100dvh/);
    expect(css).toMatch(/#app\s*\{[^}]*max-height:\s*100dvh/);
    // El scroll interno de main no debe encogerse por debajo del contenido ni
    // encadenarse al documento (rebote de toda la interfaz).
    expect(css).toMatch(/main\s*\{[^}]*min-height:\s*0/);
    expect(css).toMatch(/main\s*\{[^}]*overscroll-behavior:\s*contain/);
  });
});
