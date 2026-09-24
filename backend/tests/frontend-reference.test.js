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

  it('mantiene las acciones sobre el mapa y extiende el mapa tras la navegación', () => {
    expect(css).toMatch(/\.home-actions \{[^}]*z-index: 2/);
    expect(css).toMatch(/\.home-map-stage \{[^}]*z-index: 0/);
    expect(css).toMatch(/\.home-map-stage \{[^}]*bottom: calc\(-85px/);
  });

  it('muestra marcadores de mascotas visibles en el mapa', () => {
    expect(css).toMatch(/\.animal-marker \{[^}]*width: 46px[^}]*height: 46px/);
    expect(css).toMatch(/\.animal-emoji \.animal-svg \{[^}]*width: 36px[^}]*height: 36px/);
    expect(javascript).toContain('iconSize: [52, 60]');
    expect(javascript).toContain('iconAnchor: [26, 56]');
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

  it('ofrece instalar PetSeñal directamente desde la pantalla de acceso', () => {
    expect(html).toContain('id="btn-install-auth"');
    expect(html).toContain('Instalar PetSeñal');
    expect(html).toContain('/descargar/petsenal.apk');
    expect(javascript).toContain("['btn-install', 'btn-install-auth']");
    expect(javascript).toContain("'(display-mode: standalone)'");
    expect(javascript).toContain('Añadir a pantalla de inicio');
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
