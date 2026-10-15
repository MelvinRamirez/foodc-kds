# foodc-kds

Kitchen Display System (KDS) de FoodC: pantalla de cocina para ver y completar pedidos pendientes desde una tablet, mediante sondeo (polling) al mismo backend que usa el comensal. Sitio estático puro (sin framework, sin bundler), publicado por GitHub Pages.

El backend (Google Apps Script) vive en el repositorio privado de FoodC (la FoodC backend repository). Este repositorio no duplica ningún archivo de ese backend; solo consume sus endpoints HTTP documentados en sus specs (`order-api`, `api-transport`, `kitchen-pin-api`).

## Desarrollo local

Requiere Node.js >= 22.

```bash
npm test
```

Para emular el sub-path de GitHub Pages en desarrollo local:

```bash
# desde el directorio padre de foodc-kds
python3 -m http.server 8000
# abrir http://localhost:8000/foodc-kds/
```

## Tailwind CSS

El CSS se genera una vez con el CLI standalone de Tailwind v4 y se commitea (no hay build en el deploy). Binario fijado para este proyecto:

- Versión: **v4.3.3**
- Binario: `tailwindcss-macos-x64` (ajustar a la arquitectura de quien regenere el CSS)
- Descarga:

```bash
mkdir -p bin
curl -sSLo bin/tailwindcss https://github.com/tailwindlabs/tailwindcss/releases/download/v4.3.3/tailwindcss-macos-x64
chmod +x bin/tailwindcss
```

Regenerar el CSS tras cambiar clases en `index.html` o `js/`:

```bash
npm run build:css
```

## Deploy

URL publicada: `https://melvinramirez.github.io/foodc-kds/` (queda en línea recién después de que Phase 16 habilite GitHub Pages para este repositorio — al momento de escribir esto, esa fase todavía no se ejecutó).

### Fallback de pantalla siempre encendida (Wake Lock)

La app pide `navigator.wakeLock.request('screen')` al desbloquear y de nuevo al volver a estar visible. Si el navegador no soporta la API o la rechaza (por ejemplo, ahorro de batería), la barra de estado muestra un aviso visible y hay que usar el ajuste del dispositivo:

- **Android**: Ajustes → Pantalla → tiempo de espera de pantalla al máximo, o Opciones de desarrollador → "Permanecer activo" mientras se carga.
- **iPadOS**: Ajustes → Pantalla y brillo → Bloqueo automático → Nunca.

### Procedimiento de bump de `CACHE_VERSION`

`sw.js` precachea el app shell completo (HTML, CSS, JS, manifest, íconos) bajo `CACHE_VERSION`. Cada vez que cambie cualquier archivo del shell, `CACHE_VERSION` debe incrementarse **en el mismo commit** (p. ej. `foodc-kds-shell-v1` → `foodc-kds-shell-v2`). El flujo, idéntico a `foodc-cliente`:

1. `install` precachea la lista con `{cache: 'reload'}` (bypassea la caché HTTP) y llama `self.skipWaiting()`.
2. `activate` borra toda caché cuyo nombre empiece con `CACHE_PREFIX` (`foodc-kds-shell-`) y no sea la versión actual, luego llama `self.clients.claim()`.
3. Como la KDS corre horas en una sola pestaña de la tablet, el shell nuevo recién se aplica en la próxima navegación — no hay recarga automática. El checklist de deploy incluye recargar manualmente la tablet una vez después de cada deploy que toque archivos del shell.
