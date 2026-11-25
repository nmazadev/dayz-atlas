"""Render a topographic map from the game's terrain (.wrp) at the satellite's resolution.

Layers, bottom to top: elevation tint with hillshade, sea with depth shading, forest
(classified from the satellite tiles, since the terrain file has no forest polygons),
inland water (rivers, ponds, lakes), contour lines, roads by class, building footprints.
Railways come back as vector segments instead, for the app to draw at any zoom.

Uses the vendored OPRW v32 reader in vendor/dayz_wrp (MIT, see its LICENSE).
"""

from __future__ import annotations

import math
import re
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor" / "dayz_wrp"))
from dayz_wrp import Wrp  # noqa: E402

Image.MAX_IMAGE_PIXELS = None

STRIP = 512  # output rows processed at a time

# Elevation tint stops (metres → RGB); subtle so contours and roads stay readable.
LAND = [(0, (238, 234, 216)), (150, (233, 227, 203)), (300, (226, 217, 186)), (450, (216, 203, 168)), (650, (205, 190, 153))]
SEA = [(0, (171, 211, 232)), (-40, (138, 190, 222)), (-250, (104, 163, 204))]
FOREST = np.array([181, 210, 155], dtype=np.float32)
CONTOUR_MINOR = np.array([176, 146, 112], dtype=np.float32)
CONTOUR_MAJOR = np.array([150, 117, 80], dtype=np.float32)
COAST = np.array([74, 134, 168], dtype=np.float32)

# Road model class → (fill, casing or None, width in metres). Drawn in this order.
ROADS = [
    ("path", ((150, 120, 85), None, 1.6)),
    ("mud", ((156, 124, 86), None, 3.0)),
    ("grav", ((168, 146, 112), None, 4.0)),
    ("taxiway", ((190, 190, 186), None, 14.0)),
    ("concrete", ((190, 190, 186), None, 8.0)),
    ("city", ((255, 255, 255), (120, 120, 120), 6.5)),
    ("asf3", ((255, 255, 255), (120, 120, 120), 6.5)),
    ("asf2", ((250, 215, 122), (140, 108, 52), 7.5)),
    ("asf1", ((246, 172, 70), (138, 88, 30), 9.0)),
]
BUILDING_FILL, BUILDING_LINE = (152, 146, 138), (104, 99, 92)
RAIL_LINK = 15.0  # longest gap (m) closed between the ends of two track pieces
FRESHWATER = np.array([160, 203, 228], dtype=np.float32)
# Rail models outside rail/tracks/ that still carry the line.
RAIL_CARRIERS = ("rail_bridge_", "rail_crossing_block_", "rail_tracksmall_switch")

# Inland water objects → how far (m) their surface may spread from the object's origin.
# Rivers and Livonia's named lakes (enoch_jantar…) are tiled from many pieces, so each reaches
# only around itself; checked in this order, so the 50 × 50 ponds win over the enoch_ prefix.
WATER_REACH = [
    ("stream", 25), ("pond", 45), ("enoch_50x50", 45), ("river", 70), ("enoch_river", 70), ("enoch_", 90), ("lake", 150),
]
WATER_SKIP = ("water_station", "underground", "streambed", "stones")


def water_reach(p3d: str) -> int | None:
    path = p3d.replace("\\", "/").lower()
    if "/water" not in path:
        return None
    name = path.rsplit("/", 1)[-1]
    if name.startswith(WATER_SKIP):
        return None
    return next((r for prefix, r in WATER_REACH if name.startswith(prefix)), None)


def rail_length(p3d: str) -> float | None:
    """Length (m) of a piece that carries track (plain track, bridge, road crossing, switch), else None."""
    path = p3d.replace("\\", "/").lower()
    name = path.rsplit("/", 1)[-1].removesuffix(".p3d").removesuffix("_lc")
    if "/rail/tracks/" not in path and not name.startswith(RAIL_CARRIERS):
        return None
    m = re.search(r"(?:track(?:e|small)?|bridge|block)_(?:[lr]|up_|down_|passing_)?(\d+)", name)
    if m:
        return float(m[1])
    return 10.0 if "crossing" in name else 25.0


def road_class(p3d: str) -> str | None:
    name = p3d.replace("\\", "/").lower().rsplit("/", 1)[-1]
    if "path" in name:
        return "path"
    if "taxiway" in name:
        return "taxiway"
    if "concrete" in name:
        return "concrete"
    if "quarry" in name:
        return "grav"
    for cls in ("asf1", "asf2", "asf3", "city", "grav", "mud"):
        if cls in name:
            return cls
    if name.startswith("kr_"):  # crossroads pieces
        return "asf3"
    return None


def _ramp(h: np.ndarray, stops) -> np.ndarray:
    xs = [s[0] for s in stops]
    order = np.argsort(xs)
    xs = np.array(xs, dtype=np.float32)[order]
    cols = np.array([s[1] for s in stops], dtype=np.float32)[order]
    return np.stack([np.interp(h, xs, cols[:, c]) for c in range(3)], axis=-1)


def _sample(grid: np.ndarray, gy: np.ndarray, gx: np.ndarray) -> np.ndarray:
    """Bilinear sample of a 2-D grid at fractional (row, col) coordinates."""
    h, w = grid.shape
    gy = np.clip(gy, 0, h - 1.001)
    gx = np.clip(gx, 0, w - 1.001)
    y0, x0 = gy.astype(np.int32), gx.astype(np.int32)
    ty, tx = gy - y0, gx - x0
    a, b = grid[y0, x0], grid[y0, x0 + 1]
    c, d = grid[y0 + 1, x0], grid[y0 + 1, x0 + 1]
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty


def hillshade(elev_north_up: np.ndarray, cell: float) -> np.ndarray:
    """Light from the north-west at 45°, relative to flat ground (1.0 = flat)."""
    gy, gx = np.gradient(elev_north_up, cell)
    dz_east, dz_north = gx, -gy  # rows grow southwards
    nx, ny, nz = -dz_east, -dz_north, np.ones_like(gx)
    norm = np.sqrt(nx * nx + ny * ny + nz * nz)
    light = np.array([-0.5, 0.5, 0.7071])
    shade = (nx * light[0] + ny * light[1] + nz * light[2]) / norm
    return (shade / 0.7071).astype(np.float32)


def forest_grid(sat_tiles: Path, tmp: Path) -> np.ndarray | None:
    """Forest density 0–1 from the satellite pyramid at 4 m/px: dark, green, smooth areas."""
    info_z = 4
    z_dir = sat_tiles / str(info_z)
    if not z_dir.is_dir():
        return None
    rows = sorted(int(p.name) for p in z_dir.iterdir() if p.is_dir())
    cols = sorted(int(p.stem) for p in (z_dir / str(rows[0])).glob("*.webp"))
    files = [str(z_dir / str(r) / f"{c}.webp") for r in rows for c in cols]
    joined = tmp / "sat_z4.png"
    subprocess.run(["vips", "arrayjoin", " ".join(files), str(joined), "--across", str(len(cols))],
                   check=True, stderr=subprocess.DEVNULL)
    img = np.asarray(Image.open(joined).convert("RGB"), dtype=np.float32)
    joined.unlink()
    r, g, b = img[..., 0], img[..., 1], img[..., 2]
    lum = (r + g + b) / 3
    # Forest canopy is the darkest vegetation on these textures; fields and towns are lighter.
    dense = np.clip((52 - lum) / 14, 0, 1) * (g >= b)
    # Box-blur a few metres so single dark pixels don't become forest.
    k = 3
    pad = np.pad(dense, k, mode="edge")
    cs = pad.cumsum(0).cumsum(1)
    cs = np.pad(cs, ((1, 0), (1, 0)))
    n = 2 * k + 1
    smooth = (cs[n:, n:] - cs[:-n, n:] - cs[n:, :-n] + cs[:-n, :-n]) / (n * n)
    return smooth.astype(np.float32)


def rail_segments(pieces: list[tuple[np.ndarray, np.ndarray, float]]) -> tuple[list, int]:
    """Straight segments for the track pieces, plus links that close the joints between them.

    Lengths come from model names and curved or special pieces don't match theirs exactly,
    so a loose end is joined to the nearest end ahead of it (within RAIL_LINK m and roughly in
    line). Requiring the link to point along the track keeps parallel tracks in a yard apart.
    """
    ends = []  # (point, outward direction, piece index)
    segments = []
    for i, (c, d, length) in enumerate(pieces):
        a, b = c - d * length / 2, c + d * length / 2
        segments.append((a, b))
        ends += [(a, -d, i), (b, d, i)]
    grid: dict[tuple[int, int], list[int]] = {}
    for k, (p, _u, _i) in enumerate(ends):
        grid.setdefault((int(p[0] // RAIL_LINK), int(p[1] // RAIL_LINK)), []).append(k)
    cos_max = math.cos(math.radians(35))
    links = 0
    for k, (p, u, i) in enumerate(ends):
        gx, gz = int(p[0] // RAIL_LINK), int(p[1] // RAIL_LINK)
        near = [j for dx in (-1, 0, 1) for dz in (-1, 0, 1) for j in grid.get((gx + dx, gz + dz), ()) if ends[j][2] != i]
        dists = [(float(np.hypot(*(ends[j][0] - p))), j) for j in near]
        if any(dist < 0.6 for dist, _ in dists):
            continue  # already meets another piece
        best = None
        for dist, j in sorted(dists):
            if dist > RAIL_LINK:
                break
            v = (ends[j][0] - p) / dist
            if float(v @ u) >= cos_max:
                best = j
                break
        if best is not None:
            segments.append((p, ends[best][0]))
            links += 1
    return segments, links


def water_levels(w: Wrp, elev: np.ndarray, world: float) -> tuple[np.ndarray, int]:
    """Inland water surface height per terrain cell (row 0 = north), NaN where dry.

    Rivers, ponds and lakes are objects whose origin sits on the water surface; the terrain
    below that level, connected to the object and within its reach, is under water. Cells
    next to the water keep the level too, so the shoreline can follow the terrain itself.
    """
    cell = w.cell_size
    rows, cols = elev.shape
    levels = np.full(elev.shape, np.nan, dtype=np.float32)
    reach_by_model = [water_reach(p) for p in w.models]
    is_water = np.array([r is not None for r in reach_by_model])[w.objects["model"]]
    n = 0
    for mi, m in zip(w.objects["model"][is_water], w.objects["m"][is_water]):
        reach = reach_by_model[mi]
        x, level, z = float(m[9]), float(m[10]), float(m[11])
        r0, c0 = int((world - z) / cell), int(x / cell)
        k = int(reach / cell) + 1
        ra, rb, ca, cb = max(0, r0 - k), min(rows, r0 + k + 1), max(0, c0 - k), min(cols, c0 + k + 1)
        if ra >= rb or ca >= cb:
            continue
        below = elev[ra:rb, ca:cb] < level - 0.05
        # Seed on the object's cell, or any submerged cell right next to it (origins can sit on a bank).
        seed = np.zeros_like(below)
        sr, sc = r0 - ra, c0 - ca
        seed[max(0, sr - 1) : sr + 2, max(0, sc - 1) : sc + 2] = True
        seed &= below
        if not seed.any():
            continue
        # Flood fill by repeated dilation inside the window.
        while True:
            grown = seed.copy()
            grown[1:] |= seed[:-1]
            grown[:-1] |= seed[1:]
            grown[:, 1:] |= seed[:, :-1]
            grown[:, :-1] |= seed[:, 1:]
            grown &= below
            if (grown == seed).all():
                break
            seed = grown
        win = levels[ra:rb, ca:cb]
        win[seed] = np.fmax(win[seed], level)
        n += 1
    # Spread each level one cell outwards so pixels on the bank can compare against it.
    edge = levels.copy()
    for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)):
        shifted = np.full_like(levels, np.nan)
        shifted[max(0, dr) : rows + min(0, dr), max(0, dc) : cols + min(0, dc)] = levels[
            max(0, -dr) : rows + min(0, -dr), max(0, -dc) : cols + min(0, -dc)
        ]
        edge = np.fmax(edge, shifted)
    return edge, n


def render(wrp_bytes: bytes, size: int, sat_tiles: Path | None, tmp: Path, log=print) -> tuple[Image.Image, dict]:
    """The topographic raster, plus the railway as segments in world metres for the app to draw."""
    w = Wrp(wrp_bytes, want_objects=True, progress=None)
    world = float(w.world_size)
    elev = w.elevation[::-1].astype(np.float32)  # row 0 = north, like the image
    shade = hillshade(elev, w.cell_size)
    forest = forest_grid(sat_tiles, tmp) if sat_tiles else None
    levels, n_water = water_levels(w, elev, world)
    log(f"  terrain {w.map_x}² cells of {w.cell_size} m, forest mask {'yes' if forest is not None else 'no'}")
    log(f"  inland water: {n_water} objects, {int((elev < levels).sum() * w.cell_size**2 / 1e4)} ha")

    px_per_m = size / world
    out = Image.new("RGB", (size, size))
    xs = (np.arange(size, dtype=np.float32) + 0.5) / px_per_m  # world x of each column
    for y0 in range(0, size, STRIP):
        y1 = min(size, y0 + STRIP)
        # One extra row so contours can compare with the row below.
        rows = np.arange(y0, min(size, y1 + 1), dtype=np.float32)
        north = world - (rows + 0.5) / px_per_m  # world z of each row
        gy = ((world - north) / w.cell_size)[:, None] * np.ones_like(xs)[None, :]
        gx = (xs / w.cell_size)[None, :] * np.ones_like(rows)[:, None]
        h = _sample(elev, gy, gx)
        s = _sample(shade, gy, gx)

        # Nearest cell's water level against the smooth terrain: the shore follows the ground.
        ly = np.clip(np.rint(gy).astype(np.int32), 0, levels.shape[0] - 1)
        lx = np.clip(np.rint(gx).astype(np.int32), 0, levels.shape[1] - 1)
        with np.errstate(invalid="ignore"):
            lake = h < levels[ly, lx] - 0.05
        land = (h >= 0) & ~lake
        rgb = np.where(land[..., None], _ramp(h, LAND), _ramp(h, SEA))
        rgb = np.where((lake & (h >= 0))[..., None], FRESHWATER, rgb)
        if forest is not None:
            fy = gy * w.cell_size / world * forest.shape[0]
            fx = gx * w.cell_size / world * forest.shape[1]
            f = np.clip(_sample(forest, fy, fx) * 1.6 - 0.25, 0, 1) * land
            rgb = rgb * (1 - f[..., None] * 0.8) + FOREST * (f[..., None] * 0.8)
        rgb *= np.clip(1 - 0.55 * (1 - s), 0.45, 1.15)[..., None]

        # Contours: a pixel is on a line where the 10 m band changes to its right or below.
        band10, band50 = np.floor(h / 10), np.floor(h / 50)
        edge10 = np.zeros_like(land)
        edge50 = np.zeros_like(land)
        edge10[:, :-1] |= band10[:, :-1] != band10[:, 1:]
        edge10[:-1] |= band10[:-1] != band10[1:]
        edge50[:, :-1] |= band50[:, :-1] != band50[:, 1:]
        edge50[:-1] |= band50[:-1] != band50[1:]
        coast = np.zeros_like(land)
        coast[:, :-1] |= land[:, :-1] != land[:, 1:]
        coast[:-1] |= land[:-1] != land[1:]
        minor = edge10 & ~edge50 & land
        major = edge50 & land & ~coast
        rgb = np.where(minor[..., None], rgb * 0.55 + CONTOUR_MINOR * 0.45, rgb)
        rgb = np.where(major[..., None], rgb * 0.2 + CONTOUR_MAJOR * 0.8, rgb)
        rgb = np.where(coast[..., None], COAST, rgb)

        strip = np.clip(rgb[: y1 - y0], 0, 255).astype(np.uint8)
        out.paste(Image.fromarray(strip, "RGB"), (0, y0))
    log("  base raster done")

    draw = ImageDraw.Draw(out)
    to_px = lambda x, z: (x * px_per_m, (world - z) * px_per_m)  # noqa: E731

    by_class: dict[str, list] = {}
    for _cell, pts, _types, _oid, _flags, p3d, _m in w.roads:
        cls = road_class(p3d)
        if cls and len(pts) > 1:
            by_class.setdefault(cls, []).append([to_px(p[0], p[2]) for p in pts])
    for cls, (fill, casing, width_m) in ROADS:
        lines = by_class.get(cls, [])
        width = max(1, round(width_m * px_per_m))
        if casing:
            for line in lines:
                draw.line(line, fill=casing, width=width + 2, joint="curve")
        for line in lines:
            draw.line(line, fill=fill, width=width, joint="curve")
    log(f"  roads: {sum(len(v) for v in by_class.values())} segments")

    # Track pieces: origin at the piece's centre, running along its local z axis.
    length_by_model = [rail_length(p) for p in w.models]
    is_rail = np.array([n is not None for n in length_by_model])[w.objects["model"]]
    pieces = []
    for mi, m in zip(w.objects["model"][is_rail], w.objects["m"][is_rail]):
        d = np.array([m[6], m[8]], dtype=np.float64)
        d /= np.linalg.norm(d) or 1.0
        pieces.append((np.array([m[9], m[11]], dtype=np.float64), d, length_by_model[mi]))
    segments, joints = rail_segments(pieces)
    # Railways are drawn by the app as vectors (crisp at any zoom, yards stay apart up close).
    flat = lambda segs: [round(float(v), 1) for a, b in segs for v in (*a, *b)]  # noqa: E731
    rails = {"track": flat(segments[: len(pieces)]), "joints": flat(segments[len(pieces) :])}
    log(f"  railway: {len(pieces)} track pieces, {joints} joints closed")

    n_buildings = 0
    for tid, rec in w.mapinfo:
        if tid in (3, 4):  # building, house: four corners (x, z); p0 p1 p3 p2 goes around
            c = rec["corners"]
            pts = [to_px(c[0], c[1]), to_px(c[2], c[3]), to_px(c[6], c[7]), to_px(c[4], c[5])]
            draw.polygon(pts, fill=BUILDING_FILL, outline=BUILDING_LINE)
            n_buildings += 1
    log(f"  buildings: {n_buildings}")
    return out, rails
