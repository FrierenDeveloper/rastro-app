import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const frontendPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../frontend');
const html = fs.readFileSync(path.join(frontendPath, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(frontendPath, 'styles.css'), 'utf8');
const javascript = fs.readFileSync(path.join(frontendPath, 'app.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(frontendPath, 'manifest.json'), 'utf8'));

function extraerFuncion(nombre) {
  return (
    javascript.match(new RegExp(`(?:async )?function ${nombre}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0] || ''
  );
}

function tabAdminFalso() {
  const clases = new Set(['hidden']);
  return {
    clases,
    elemento: {
      classList: {
        add: nombre => clases.add(nombre),
        remove: nombre => clases.delete(nombre)
      }
    }
  };
}

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

  it('mantiene el control de ubicación compacto, accesible y dentro del mapa', () => {
    const boton = html.match(/<button[^>]*id="btn-my-loc"[\s\S]*?<\/button>/)?.[0] || '';
    expect(boton).toContain('aria-label="Ubicarme en mi ubicación actual"');
    expect(boton).toContain('title="Ubicarme"');
    expect(boton).not.toContain('<span>Ir a mí</span>');
    expect(css).toMatch(
      /@media \(max-width: 899px\) \{[^}]*\.map-my-location \{[^}]*width:\s*42px[^}]*height:\s*42px/s
    );
    expect(css).toMatch(
      /\.map-my-location \{[^}]*right:\s*16px[^}]*bottom:\s*calc\(206px \+ env\(safe-area-inset-bottom\)\)/
    );
    expect(css).toMatch(/#view-home:not\(\.home-list-mode\) \.map-my-location \{[^}]*bottom:\s*22px/);
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

  it('mide modales, chat y pantallas de acceso con el viewport dinámico', () => {
    // Con la barra del navegador visible, 100vh (viewport grande) supera el área
    // real. En un modal eso es peor que un simple desplazamiento: su contenido
    // entra en 90vh, no se genera scroll interno y el final queda inalcanzable.
    // Por eso los contenedores con alto acotado usan dvh, con vh como respaldo.
    expect(css).toMatch(/\.modal-box\s*\{[^}]*max-height:\s*90vh[^}]*max-height:\s*90dvh/);
    expect(css).toMatch(/\.conv-msgs\s*\{[^}]*max-height:\s*52vh[^}]*max-height:\s*52dvh/);
    expect(css).toMatch(/\.drawer\s*\{[^}]*height:\s*100vh[^}]*height:\s*100dvh/);
    expect(css).toMatch(/#boot-screen\s*\{[^}]*min-height:\s*100dvh/);
    expect(css).toMatch(/#auth-screen,\s*#reset-screen\s*\{[^}]*min-height:\s*100dvh/);
  });

  it('aprovecha las pantallas de escritorio con un diseño de dos columnas', () => {
    // La app es móvil primero. En escritorio, el armazón usa todo el viewport y
    // reserva una columna lateral para la navegación.
    expect(css).toContain('@media (min-width: 900px)');
    expect(css).toMatch(/@media \(min-width: 900px\) \{[\s\S]*#app \{[^}]*width: 100%[^}]*max-width: none/);
    // La vista Mapa pone los avisos en un panel lateral en vez del carrusel de abajo.
    expect(css).toMatch(/#view-home:not\(\.home-list-mode\) #reports-list \{[^}]*flex-direction: column/);
    expect(css).toMatch(/#view-home:not\(\.home-list-mode\) #reports-list \{[^}]*overflow-y: auto/);
    // "Buscar" reparte las tarjetas en una cuadrícula.
    expect(css).toMatch(
      /#view-home\.home-list-mode #reports-list \{[^}]*display: grid[^}]*grid-template-columns/
    );
    // Los formularios se centran en una columna legible.
    expect(css).toMatch(/\.view > \.card[^{]*\{[^}]*max-width: 860px/);
  });
});

describe('visibilidad del panel de administración', () => {
  it.each([true, false])(
    'al iniciar sesión carga del servidor is_admin=%s antes de arrancar',
    async esAdmin => {
      const onAuthSuccess = extraerFuncion('onAuthSuccess');
      const llamadas = [];
      const guardado = [];
      const contexto = {
        token: null,
        me: null,
        localStorage: { setItem: (clave, valor) => guardado.push([clave, valor]) },
        api: async ruta => {
          llamadas.push(ruta);
          return { user: { id: 'u-1', is_admin: esAdmin } };
        },
        showApp: () => llamadas.push('showApp'),
        startApp: () => llamadas.push(`startApp:${contexto.me && contexto.me.is_admin}`)
      };

      await vm.runInNewContext(
        `(async () => { ${onAuthSuccess}; await onAuthSuccess('jwt-test'); })()`,
        contexto
      );

      expect(contexto.me.is_admin).toBe(esAdmin);
      expect(guardado).toStrictEqual([['rastro_token', 'jwt-test']]);
      expect(llamadas).toStrictEqual(['/api/auth/me', 'showApp', `startApp:${esAdmin}`]);
    }
  );

  it('ignora una respuesta tardía de /me si ya se cerró esa sesión', async () => {
    let completarMe;
    const respuestaPendiente = new Promise(resolve => {
      completarMe = resolve;
    });
    const llamadas = [];
    const contexto = {
      token: null,
      me: null,
      localStorage: { setItem: () => {} },
      api: () => respuestaPendiente,
      showApp: () => llamadas.push('showApp'),
      startApp: () => llamadas.push('startApp')
    };
    const tarea = vm.runInNewContext(
      `(async () => { ${extraerFuncion('onAuthSuccess')}; await onAuthSuccess('jwt-cerrado'); })()`,
      contexto
    );
    contexto.token = null;
    contexto.me = null;
    completarMe({ user: { id: 'u-admin', is_admin: true } });
    await tarea;

    expect(contexto.me).toBeNull();
    expect(llamadas).toStrictEqual([]);
  });

  it('logout vuelve a ocultar el botón después de una sesión administradora', () => {
    const tab = tabAdminFalso();
    const borrados = [];
    const paneles = {
      'admin-flagged': { replaceChildren: () => borrados.push('admin-flagged') },
      'admin-users': { replaceChildren: () => borrados.push('admin-users') }
    };
    const contexto = {
      token: 'jwt-admin',
      me: { is_admin: true },
      currentConv: { poll: null },
      localStorage: { removeItem: () => {} },
      ubicacion: { detener: () => {} },
      showAuth: () => {},
      document: {
        getElementById: id => (id === 'tab-admin' ? tab.elemento : paneles[id] || null)
      }
    };

    vm.runInNewContext(
      `${extraerFuncion('mostrarTabAdmin')}; ${extraerFuncion('limpiarDatosAdmin')}; ${extraerFuncion(
        'logout'
      )}; mostrarTabAdmin(); logout();`,
      contexto
    );

    expect(contexto.me).toBeNull();
    expect(tab.clases.has('hidden')).toBe(true);
    expect(borrados).toStrictEqual(['admin-flagged', 'admin-users']);
  });

  it('oculta de nuevo el botón al pasar de admin a cuenta normal', () => {
    const tab = tabAdminFalso();
    const contexto = {
      me: null,
      document: { getElementById: id => (id === 'tab-admin' ? tab.elemento : null) }
    };
    const mostrar = extraerFuncion('mostrarTabAdmin');
    vm.runInNewContext(`${mostrar}; mostrarTabAdmin()`, contexto);
    contexto.me = { is_admin: true };
    vm.runInNewContext('mostrarTabAdmin()', contexto);
    contexto.me = { is_admin: false };
    vm.runInNewContext('mostrarTabAdmin()', contexto);

    expect(tab.clases.has('hidden')).toBe(true);
  });
});

describe('términos y condiciones públicos', () => {
  const terminosPath = path.join(frontendPath, 'terminos', 'index.html');
  const terminos = fs.existsSync(terminosPath) ? fs.readFileSync(terminosPath, 'utf8') : '';

  it('publica una página de términos y condiciones estable y accesible', () => {
    expect(fs.existsSync(terminosPath)).toBe(true);
    expect(terminos).toContain('<title>Términos y condiciones');
    expect(terminos).toContain('class="legal-doc"');
    expect(terminos).toContain('Última actualización:');
    expect(terminos).toContain('mailto:contacto@petsenal.com');
    expect(terminos).toContain('<a class="legal-volver" href="/">');
  });

  it('cubre aceptación, uso indebido, responsabilidad y datos personales', () => {
    expect(terminos).toContain('Aceptación');
    expect(terminos).toContain('Conducta prohibida');
    expect(terminos).toContain('Límite de responsabilidad');
    expect(terminos).toContain('Tus datos');
    expect(terminos).toContain('/privacidad/');
  });

  it('enlaza los términos desde el acceso y desde el modal de privacidad', () => {
    const acceso = html.match(/id="auth-screen"[\s\S]*?id="app"/)?.[0] || '';
    const privacidad = html.match(/id="privacy-modal"[\s\S]*?id="zona-intro"/)?.[0] || '';
    expect(acceso).toContain('href="/terminos/"');
    expect(privacidad).toContain('href="/terminos/"');
  });

  it('deja el scroll legal en la página, no confinado al main de la app', () => {
    const reglaLegal = css.match(/\.legal-doc\s*\{[^}]*\}/)?.[0] || '';
    expect(reglaLegal).toMatch(/overflow:\s*visible/);
    expect(reglaLegal).toMatch(/overscroll-behavior:\s*auto/);
    expect(reglaLegal).toMatch(/flex:\s*none/);
  });
});
