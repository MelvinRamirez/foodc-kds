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

TBD — filled in during Phase 16 (GitHub Pages deploy)
