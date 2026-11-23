# DayZ Atlas

Mapa interactivo de DayZ (Chernarus y Livonia) sin anuncios, con modo oscuro y sin cuentas.

- Mapa satelital con grilla y coordenadas estilo `045 123`, buscador de pueblos y coordenadas (`Ctrl+K` o `/`).
- Loot por edificio: filtros por tipo de lugar (militar, policía, médico…), por lo que buscas (armas, ropa, comida…) y por tier de zona.
- Eventos dinámicos: heli crashes, convoyes, trenes, policía, vehículos y botes. También zonas contaminadas y spawns de jugador.
- Medición de distancia con rumbo de brújula (`M`).
- Marcadores propios (`N` o clic derecho), guardados en el navegador. Se pueden exportar e importar en JSON o compartir con un link que lleva los marcadores incluidos, así el grupo los importa sin registrarse.
- Tema oscuro y claro. Interfaz en español e inglés, y agregar otro idioma es crear un archivo JSON.

## Datos

Todo sale del repositorio oficial [BohemiaInteractive/DayZ-Central-Economy](https://github.com/BohemiaInteractive/DayZ-Central-Economy), publicado bajo licencia **ADPL-SA** (Arma and DayZ Public License Share Alike): uso no comercial, con atribución y compartiendo bajo la misma licencia. No se usan datos ni imágenes de otros mapas comunitarios.

`scripts/build_data.py` descarga solo las carpetas necesarias del repo y genera en `web/public/data/`:

| Archivo | Contenido |
| --- | --- |
| `maps.json` | Mapas disponibles, tamaño del mundo y zoom nativo |
| `<mapa>/tiles/` | Tiles WebP generados desde `CETool/<mapa>/map.png` |
| `<mapa>/loot.json` | Edificios con loot (`mapgrouppos.xml` + `mapgroupproto.xml`) con su tier |
| `<mapa>/events.json` | Eventos (`cfgeventspawns.xml`), zonas contaminadas y spawns |
| `<mapa>/places.json` | Pueblos: los archivos del CE no traen una lista de nombres con coordenadas, así que se agrupan las casas y se nombra cada grupo con las pistas de nombres que sí aparecen (spawns, grupos de tráfico, territorios de animales) |
| `<mapa>/tiers.webp` | Capa de zonas de tier |

Los vehículos y eventos son **posibles** puntos de aparición: en cada reinicio solo se activan algunos.

## Desarrollo

Requisitos: Python 3, `git`, `vips`, ImageMagick 7 (`magick`), Node 24 y pnpm.

```sh
make data   # genera web/public/data (≈15 s)
make dev    # servidor de desarrollo de Vite
make check  # tipos, lint y claves de idiomas
```

### Datos del juego: satélite en alta resolución, mapa topográfico y nombres oficiales

Las imágenes del repo oficial son de baja resolución (2048 px para Chernarus, unos 7.5 m por píxel), y los nombres de lugares del CE son una estimación. Si tienes el juego instalado, extrae los datos reales desde **tu propia instalación de DayZ**:

```sh
make game   # o: uv run scripts/extract_game.py chernarus
```

El script encuentra el juego en tus librerías de Steam (o usa `--game /ruta/a/DayZ`) y lee los segmentos `s_XXX_YYY_lco.paa` de los `.pbo` del terreno. Detecta solo el solape y el orden de los segmentos, verifica el resultado contra el mapa oficial y genera `tiles/<mapa>/` y `tiles/index.json`. Tarda menos de un minuto por mapa y deja Chernarus en 15 360 px (1 m/px) y Livonia en 15 360 px (~0.83 m/px), con unos 40–50 MB de tiles por mapa. Necesita `uv`, `vips` y `liblzo2`.

También lee la lista de nombres del mapa del juego (`config.bin` del mundo): ciudades, pueblos, barrios, cerros, lagos, campamentos y bases, con su posición exacta. Los nombres de Chernarus vienen en cirílico; se transliteran (Черногорск → Chernogorsk) y el buscador acepta ambas formas. El juego rotula las bases solo como "base militar" o "aeródromo", así que se muestran con el pueblo más cercano ("Base militar · Tisy"). Las bases que solo aparecen en el loot militar del CE se agregan igual. Con `--only satellite`, `--only places` o `--only topo` se ejecuta un solo paso.

El **mapa topográfico** se genera desde el terreno del juego (`worlds_<mapa>.pbo` → `.wrp`). Combina el relieve con sombreado, el mar con su profundidad, las curvas de nivel cada 10 m (más marcadas cada 50 m), los caminos por categoría y la planta de cada edificio. El bosque se detecta en el satélite, porque el terreno no lo trae como polígonos. Se renderiza al mismo tamaño que el satélite, así que en la app se cambia de capa (botón o tecla `T`) sin mover el mapa. Tarda ~1 minuto por mapa y pesa ~25 MB. El formato `.wrp` de DayZ (OPRW v32) se lee con [dayz-wrp-reader](https://github.com/DevilinJake/dayz-wrp-reader) (MIT), incluido sin cambios en `scripts/vendor/dayz_wrp/`.

La app usa estos datos cuando existen y, si no, vuelve a los oficiales. La textura del juego muestra el terreno y los caminos, pero no los edificios, que son modelos 3D aparte.

Esas texturas son de Bohemia Interactive y **no** están cubiertas por la licencia ADPL-SA de los datos del CE. Úsalas para ti y tu grupo. Antes de publicarlas en un sitio abierto, revisa los términos de Bohemia.

Para cualquier otra imagen cuadrada que cubra el mundo completo (norte arriba): `make tiles MAP=chernarus IMAGE=imagen.tif` (o `--layer topo` con `scripts/make_tiles.py`).

Estructura del volumen: `tiles/index.json` y, por mapa, `satellite/`, `topo/` y `places.json`.

### Agregar un idioma

1. Copia `web/src/i18n/locales/en.json` a `web/src/i18n/locales/<código>.json` (por ejemplo `pt.json`).
2. Traduce los valores y cambia `meta.name` (es el nombre que aparece en el selector).
3. Ejecuta `pnpm check:i18n` dentro de `web/` para confirmar que no falten claves.

No hay que tocar código: los archivos de `locales/` se registran solos. Los textos usan [i18next](https://www.i18next.com/), así que los plurales van con sufijos `_one` / `_other` (y `_few`, `_many`, etc. si el idioma los necesita). El español (`es.json`) es la referencia de tipos: una clave que no exista ahí es un error de TypeScript.

## Despliegue

```sh
docker compose up -d --build                # http://localhost:8080
BIND=0.0.0.0 PORT=8090 docker compose up -d  # abrirlo a la red en otro puerto
```

Los tiles en alta resolución no van dentro de la imagen: se montan como volumen desde `./tiles` (o `TILES_DIR=/otra/ruta`). Así la imagen sigue liviana y los tiles sobreviven a cada actualización.

La imagen (~19 MB) genera los datos durante el build y sirve todo con [static-web-server](https://static-web-server.net) sobre `scratch`: sin shell, usuario sin privilegios, sistema de archivos de solo lectura y compresión zstd/gzip. Para exponerlo a internet, ponle delante tu reverse proxy con HTTPS. Tiene un endpoint `/health`.

## Pendiente

- Grupos en tiempo real (marcadores compartidos en vivo). Los marcadores ya están detrás de `useMarkers()` (`web/src/lib/markers.ts`), así que un backend de sincronización puede reemplazar el almacenamiento local sin tocar la interfaz.
- Más mapas (Sakhal está en el repo oficial y en el juego; los mapas de mods necesitan sus propios archivos del CE).
- Vías de tren y tendido eléctrico en el topográfico (el `.wrp` los trae como objetos, no como líneas).
