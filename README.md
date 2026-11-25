# DayZ Atlas

An ad-free interactive map for DayZ (Chernarus and Livonia), with a dark mode and no accounts.

- Satellite and topographic maps with a grid and `045 123`-style coordinates; search for places or coordinates (`Ctrl+K` or `/`).
- **What do you need?** Search any item by its in-game name (Spanish or English) or pick a group (medical, guns, ammo, base building, vehicle parts, gas protection…). The map shows only the buildings that can spawn it, sized by how many loot spots fit, and ranks the areas worth the trip. Narrow broad searches by type of place (military, police, hunting…). Each item shows its rarity, where it spawns, its tiers and whether it sits on shelves or the floor; items that only come from heli crashes and convoys light up those sites instead.
- Loot by building, filtered by location type (military, police, medical…), by category and by zone tier.
- Dynamic events: heli crashes, convoys, trains, police, vehicles and boats. Dynamic gas shows its 100 m cloud plus the ring where it may sit; static contaminated zones and player spawns too.
- Distance measuring with compass bearing (`M`).
- Your own markers (`N` or right-click), stored in the browser. Export and import them as JSON, or share a link that carries the markers inside it, so your group can import them without signing up.
- Dark and light themes. UI in Spanish and English; adding a language is one JSON file.

## Data

Everything comes from Bohemia's official [BohemiaInteractive/DayZ-Central-Economy](https://github.com/BohemiaInteractive/DayZ-Central-Economy) repository, published under the **ADPL-SA** licence (Arma and DayZ Public License Share Alike): non-commercial use, with attribution, shared under the same licence. No data or imagery from other community maps is used.

`scripts/build_data.py` fetches only the folders it needs from that repository and writes to `web/public/data/`:

| File | Contents |
| --- | --- |
| `maps.json` | Available maps and world size |
| `<map>/tiles/` | WebP tiles cut from `CETool/<map>/map.png` |
| `<map>/loot.json` | Loot buildings (`mapgrouppos.xml` + `mapgroupproto.xml`) with their tier |
| `<map>/events.json` | Events (`cfgeventspawns.xml`), contaminated zones and spawns |
| `<map>/places.json` | Settlements: the CE files have no list of names with coordinates, so houses are clustered and each cluster is named from the name hints that do appear (spawn groups, traffic groups, animal territories) |
| `<map>/tiers.webp` | Tier zone overlay |
| `<map>/items.json` | Spawnable items from `db/types.xml`: category, usages, tiers, tags, nominal count, event-only flag |

Vehicles and events are **possible** spawn points: only some are active after each server restart.

The item finder applies the Central Economy's own rules: an item can spawn in a building when the spot's usage matches (the building's own usages plus painted areas such as contaminated zones), a container takes the item's category and tag (shelves, floor), and the tier zone is one the item allows. The dynamic gas cloud radius (100 m) is the game's default for contaminated areas; the ring adds the event's spawn spread from `cfgeventspawns.xml`.

Points (loot, events, spawns) are drawn on a single canvas with grid-based hit testing and one shared tooltip, so filtering redraws in milliseconds and no tooltip can be left behind.

## Development

Requirements: Python 3, `git`, `vips`, ImageMagick 7 (`magick`), Node 24 and pnpm.

```sh
make data   # builds web/public/data (≈15 s)
make dev    # Vite dev server
make check  # types, lint and locale keys
```

### Game data: high-res satellite, topographic map and official names

The official repository only has low-resolution images (2048 px for Chernarus, about 7.5 m per pixel), and the CE place names are an estimate. If you have the game installed, extract the real data from **your own DayZ install**:

```sh
make game   # or: uv run scripts/extract_game.py chernarus
```

The script finds the game in your Steam libraries (or use `--game /path/to/DayZ`) and reads the `s_XXX_YYY_lco.paa` segments from the terrain `.pbo` files. It works out the segment overlap and order by itself, checks the result against the official map and writes `tiles/<map>/satellite/` plus `tiles/index.json`. It takes under a minute per map and produces 15 360 px for Chernarus (1 m/px) and 15 360 px for Livonia (~0.83 m/px), about 40–50 MB of tiles per map. Needs `uv`, `vips` and `liblzo2`.

It also reads the in-game map's list of names (the world's `config.bin`): cities, villages, districts, hills, lakes, camps and bases, at their exact positions. Chernarus names are in Cyrillic; they are transliterated (Черногорск → Chernogorsk) and search accepts both spellings. The game labels bases only as "military base" or "airfield", so they are shown with the nearest settlement ("Military base · Tisy"). Bases that only appear in the CE's military loot are added the same way. It also reads every item's in-game name in English and Spanish (configs + stringtable) so the finder can search "bandage" or "vendas". `--only satellite`, `--only places`, `--only topo` or `--only items` runs a single step.

The **topographic map** is rendered from the game's terrain (`worlds_<map>.pbo` → `.wrp`). It combines hillshaded relief, sea depth, contour lines every 10 m (stronger every 50 m) and every building footprint. Forest is classified from the satellite, since the terrain file has no forest polygons. Ponds, lakes and Livonia's river are objects that sit on their water surface, so the terrain below that level around each one is drawn as water; Chernarus' streams and rivers are chains of narrow pieces and are drawn as lines; roads (by class, with the gaps some road pieces leave closed), road bridges and railways (from the track pieces, joints closed) are written to `tiles/<map>/roads.json` and `rails.json`, which the app draws over the topographic map as vectors, so they stay crisp at any zoom and small tracks stay visible zoomed out. It is rendered at the satellite's pixel size, so the app switches layers (button or `T` key) without moving the map. It takes ~1 minute per map and ~25 MB. DayZ's `.wrp` format (OPRW v32) is read with [dayz-wrp-reader](https://github.com/DevilinJake/dayz-wrp-reader) (MIT), vendored unmodified in `scripts/vendor/dayz_wrp/`.

The app uses this data when present and falls back to the official data otherwise. The game's satellite texture shows terrain and roads but not buildings, which are separate 3D models.

The **3D objects** layer draws those models over the satellite, seen from straight above: `uv run scripts/render3d.py chernarus --tiles [--jobs N] [--resume]`. It reads every structure's binarised model (ODOL v56, with `scripts/odol.py`), places it with its `.wrp` matrix and rasterises it with textures, north-west lighting and cast shadows, at 4× the satellite's resolution (0.25 m/px on Chernarus). It writes a transparent overlay to `tiles/<map>/render/` with a `coverage.bin` bitmap, so the app never asks for the empty tiles over the sea and fields. It takes ~18 min per map with 6 workers (~1 GB of RAM each) and ~120 MB. The app shows it over the satellite (toggle under Layers) and allows one more zoom level when it exists.

The **ground detail** layer sharpens the satellite under it: `uv run scripts/ground.py chernarus --tiles [--jobs N] [--resume]`. The satellite stops at 1 m/px; up close, the game blends each surface's detail texture (grass, dirt, gravel, forest floor, concrete) through the terrain's surface mask (`m_XXX_YYY_lca.paa`) and the slots of each 60 m cell's material. `ground.py` does the same from above at 0.25 m/px, keeping the satellite's colour and adding only the textures' grain. It writes an opaque tileset to `tiles/<map>/ground/`, on the 3D render's grid but only for its two zoom levels past the satellite's, which the app draws over the satellite from there on. It takes ~6 min per map with 6 workers and ~0.4–0.47 GB.

These textures belong to Bohemia Interactive and are **not** covered by the ADPL-SA licence of the CE data. Use them for yourself and your group; check Bohemia's terms before publishing them on an open site.

For any other square image covering the whole world (north up): `make tiles MAP=chernarus IMAGE=image.tif` (or `--layer topo` with `scripts/make_tiles.py`).

Volume layout: `tiles/index.json`, `tiles/item-names.json` and, per map, `satellite/`, `topo/`, `ground/`, `render/` and `places.json`.

### Adding a language

1. Copy `web/src/i18n/locales/en.json` to `web/src/i18n/locales/<code>.json` (for example `pt.json`).
2. Translate the values and change `meta.name` (the name shown in the language picker).
3. Run `pnpm check:i18n` inside `web/` to make sure no keys are missing.

No code changes are needed: files in `locales/` are registered automatically. Strings use [i18next](https://www.i18next.com/), so plurals take `_one` / `_other` suffixes (plus `_few`, `_many`, etc. where the language needs them). Spanish (`es.json`) is the type reference: a key that does not exist there is a TypeScript error.

## Deployment

```sh
docker compose up -d --build                # http://localhost:8080
BIND=0.0.0.0 PORT=8090 docker compose up -d  # expose it on the network, on another port
```

High-resolution tiles are not baked into the image: they are mounted as a volume from `./tiles` (or `TILES_DIR=/other/path`). The image stays small and the tiles survive every update.

### Test server

The public test instance runs on a small VPS behind a shared Caddy proxy that owns 80/443 and the certificates (kept in a separate `config` repo; the app joins its `edge` network with the alias `dayz-atlas`).

```sh
make deploy        # build here, ship the image over SSH, sync tiles/, restart, check /health
make deploy-logs   # recent logs on the server
```

`HOST` and `DEPLOY_DIR` default to `nmaza-vultr` and `/srv/dayz-atlas`. The image is built locally (the server has 1 vCPU / 1 GB) and tagged with the git commit; the last few tags stay on the server for rollback: `ssh nmaza-vultr 'cd /srv/dayz-atlas && echo TAG=<tag> > .env && docker compose up -d'`.

The image (~19 MB) builds the data during `docker build` and serves everything with [static-web-server](https://static-web-server.net) on `scratch`: no shell, non-root user, read-only filesystem, zstd/gzip compression. To expose it to the internet, put your HTTPS reverse proxy in front. There is a `/health` endpoint.

## Roadmap

- Real-time groups (live shared markers). Markers already sit behind `useMarkers()` (`web/src/lib/markers.ts`), so a sync backend can replace local storage without touching the UI.
- More maps (Sakhal is in the official repository and in the game; modded maps need their own CE files).
- Power lines on the topographic map (the `.wrp` stores them as objects, not lines).
- Close the remaining gaps in topographic roads and tracks. Some road pieces carry a shape that covers only part of the piece, and `road_links()` in `scripts/topo.py` joins most of the gaps (by connected runs, within 40 m and in line), but some dirt tracks and paths still break up, e.g. east of Pik Kozlova in Chernarus. Using the road objects' own positions, not just their shapes, would likely close the rest.
- Overhead 3D render of the game's objects (roofs, containers, track) as a third base layer, like the satellite view on some community maps: needs a reader for the binarised ODOL v56 models.
