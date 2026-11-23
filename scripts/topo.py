"""Render a topographic map from the game's terrain (.wrp) at the satellite's resolution.

Layers, bottom to top: elevation tint with hillshade, sea with depth shading, forest
(classified from the satellite tiles, since the terrain file has no forest polygons),
contour lines, roads by class, building footprints.

Uses the vendored OPRW v32 reader in vendor/dayz_wrp (MIT, see its LICENSE).
"""

from __future__ import annotations

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


def render(wrp_bytes: bytes, size: int, sat_tiles: Path | None, tmp: Path, log=print) -> Image.Image:
    w = Wrp(wrp_bytes, want_objects=False, progress=None)
    world = float(w.world_size)
    elev = w.elevation[::-1].astype(np.float32)  # row 0 = north, like the image
    shade = hillshade(elev, w.cell_size)
    forest = forest_grid(sat_tiles, tmp) if sat_tiles else None
    log(f"  terrain {w.map_x}² cells of {w.cell_size} m, forest mask {'yes' if forest is not None else 'no'}")

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

        land = h >= 0
        rgb = np.where(land[..., None], _ramp(h, LAND), _ramp(h, SEA))
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

    n_buildings = 0
    for tid, rec in w.mapinfo:
        if tid in (3, 4):  # building, house: four corners (x, z); p0 p1 p3 p2 goes around
            c = rec["corners"]
            pts = [to_px(c[0], c[1]), to_px(c[2], c[3]), to_px(c[6], c[7]), to_px(c[4], c[5])]
            draw.polygon(pts, fill=BUILDING_FILL, outline=BUILDING_LINE)
            n_buildings += 1
    log(f"  buildings: {n_buildings}")
    return out
