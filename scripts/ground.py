#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["python-lzo", "pillow", "numpy"]
# ///
"""The satellite with the game's ground detail textures blended in, at 4× its resolution.

    uv run scripts/ground.py chernarus                                   # Chernogorsk → .cache/ground/poc.png
    uv run scripts/ground.py chernarus --area 6450 2450 6600 2600 --mpp 0.25 --strength 0.8
    uv run scripts/ground.py chernarus --tiles [--jobs 6] [--resume]     # whole map → tiles/<map>/ground/

--tiles writes an opaque tileset on render3d.py's grid (4× the satellite's pixels), only at the
two zooms past the satellite's: the app draws it over the satellite from there on.

The game draws the satellite from afar and, up close, each surface's detail texture (grass,
dirt, gravel, forest floor, concrete, 2048 px) blended through the terrain's surface mask. This
does the same from above: every pixel is the satellite, bilinear from its 1 m/px segments
(`s_XXX_YYY_lco.paa`), times the relative luminance of the detail textures, weighted by the
mask (`m_XXX_YYY_lca.paa`) of the segment and the slots of the 60 m cell's material
(`p_XXX-YYY_l01_l03_…_n.rvmat`), so the satellite keeps its tone and the textures add only grain.

Mask decoding (TerrainX, up to 6 slots): black is slot 0, red 1, green 2, and blue is shared by
slots 3, 4 and 5 through the alpha (255, 128, 0). On both maps this leaves under 0.01 % of the
weight on slots a cell's material marks empty (`n`); the alternatives tested leave 2.5–10 %.
The textures repeat every 6 m on Chernarus (5 m on Livonia): 24 px at 0.25 m/px.
"""

from __future__ import annotations

import argparse
import functools
import os
import re
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor" / "dayz_wrp"))
import rapify  # noqa: E402
from dayz_wrp import Wrp  # noqa: E402
from extract_game import WORLDS, decode_paa, find_game, pbo_entries, read_entry  # noqa: E402
from render3d import CHUNK, TILE, chunk_tiles, publish, read_done, run_chunks, satellite_grid  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / ".cache" / "ground"
SLOTS = 6
REPEAT = 10  # detail textures repeat this many times per material cell (TexGen1/2 uvTransform ×10)
MATERIAL = re.compile(r"p_(\d+)-(\d+)_(.*)\.rvmat$")


def _key(path: str) -> str:
    return path.replace("\\", "/").lower()


def mask_weights(rgba: np.ndarray) -> np.ndarray:
    """(…, 4) mask values 0–255 → (…, 6) slot weights that sum to 1."""
    r, g, b, a = (rgba[..., i] / 255.0 for i in range(4))
    w3, w5 = b * np.clip(2 * a - 1, 0, 1), b * np.clip(1 - 2 * a, 0, 1)
    w = np.stack([np.clip(1 - r - g - b, 0, None), r, g, w3, b - w3 - w5, w5], -1)
    return w / np.maximum(w.sum(-1, keepdims=True), 1e-6)


def _bilinear(img: np.ndarray, px: np.ndarray, py: np.ndarray) -> np.ndarray:
    """Sample an (H, W, C) image on the grid of pixel coordinates px (columns) × py (rows)."""
    h, w = img.shape[:2]
    x0 = np.clip(np.floor(px).astype(int), 0, w - 2)
    y0 = np.clip(np.floor(py).astype(int), 0, h - 2)
    fx = np.clip(px - x0, 0, 1)[None, :, None]
    fy = np.clip(py - y0, 0, 1)[:, None, None]
    r0, r1 = img[y0], img[y0 + 1]
    top = r0[:, x0] * (1 - fx) + r0[:, x0 + 1] * fx
    bottom = r1[:, x0] * (1 - fx) + r1[:, x0 + 1] * fx
    return top * (1 - fy) + bottom * fy


class Ground:
    """The terrain's surface data for one map: material grid, segment mapping, detail textures."""

    def __init__(self, map_name: str, log=print):
        game = find_game()
        if game is None:
            raise SystemExit("DayZ not found: install it through Steam")
        addons = game / "Addons"
        world = WORLDS[map_name]
        wrp = next(e for e in pbo_entries(addons / f"worlds_{world}.pbo") if e.name.lower().endswith(".wrp"))
        w = Wrp(read_entry(wrp), want_objects=False, want_mapinfo=False, want_roads=False, progress=None)
        self.world = w.world_size
        self.cell = w.layer_cell_size
        self.material_index = w.material_index  # row 0 is the south edge
        self.entries = {_key(e.name): e for e in pbo_entries(addons / f"worlds_{world}_data.pbo")}

        # Per material: the layer index of each slot (-1 = empty); per segment: the world → UV mapping.
        layers: dict[str, int] = {}
        textures: list[str] = []
        self.slots = np.full((len(w.materials), SLOTS), -1, np.int16)
        self.texgen: dict[tuple[int, int], tuple[float, float, float]] = {}
        for i, name in enumerate(w.materials):
            m = MATERIAL.search(_key(name))
            if not m:
                continue
            d = rapify.parse(read_entry(self.entries[_key(name)]))
            for k, layer in enumerate(m[3].split("_")):
                if layer == "n":
                    continue
                if layer not in layers:
                    layers[layer] = len(textures)
                    textures.append(_key(rapify.find_ci(d, f"Stage{4 + 2 * k}")["texture"]))
                self.slots[i, k] = layers[layer]
            seg = (int(m[1]), int(m[2]))
            if seg not in self.texgen:
                t = d["TexGen3"]["uvTransform"]
                self.texgen[seg] = (t["aside"][0], t["pos"][0], t["pos"][1])
        self.segments = 1 + max(s[0] for s in self.texgen)
        self.texture_names = textures
        self.surface_pbos = [addons / "surfaces.pbo", addons / "surfaces_bliss.pbo"]
        self._details: dict[int, np.ndarray] = {}
        self._segments: dict[tuple[str, int, int], np.ndarray | None] = {}
        log(f"{map_name}: {len(w.materials)} materials, {len(textures)} surfaces, {self.segments}² segments")

    def _segment(self, kind: str, sx: int, sy: int) -> np.ndarray | None:
        key = (kind, sx, sy)
        if key not in self._segments:
            if len(self._segments) >= 8:  # a chunk spans at most four segments of each kind
                self._segments.clear()
            e = self.entries.get(f"dz/worlds/{self._world_dir}/data/layers/{kind}_{sx:03d}_{sy:03d}_{'lco' if kind == 's' else 'lca'}.paa")
            self._segments[key] = None if e is None else np.asarray(decode_paa(read_entry(e), "RGB" if kind == "s" else "RGBA"), np.float32)
        return self._segments[key]

    @functools.cached_property
    def _world_dir(self) -> str:
        return next(k for k in self.entries if "/data/layers/m_" in k).split("/")[2]

    def details(self, n: int) -> np.ndarray:
        """(surfaces + 1, n, n) relative luminance of each detail texture shrunk to n px per repeat;
        the last entry is flat, for empty slots."""
        if n not in self._details:
            entries = {}
            for pbo in self.surface_pbos:
                entries.update({_key(e.name): e for e in pbo_entries(pbo)})
            out = np.ones((len(self.texture_names) + 1, n, n), np.float32)
            for i, name in enumerate(self.texture_names):
                img = decode_paa(read_entry(entries[name]), "RGB").resize((n, n), Image.BOX)
                lum = np.asarray(img.convert("L"), np.float32)
                out[i] = lum / max(lum.mean(), 1.0)
            self._details[n] = out
        return self._details[n]

    def render(self, x0: float, z1: float, cols: int, rows: int, mpp: float, strength: float,
               period: float | None = None) -> np.ndarray:
        """(rows, cols, 3) float colours of the area whose north-west corner is (x0, z1)."""
        xs = x0 + (np.arange(cols) + 0.5) * mpp
        zs = z1 - (np.arange(rows) + 0.5) * mpp
        period = period or self.cell / REPEAT
        n = max(1, round(period / mpp))
        details = self.details(n)
        core = self.world / self.segments
        sxs = np.clip((xs // core).astype(int), 0, self.segments - 1)
        sys_ = np.clip(self.segments - 1 - (zs // core).astype(int), 0, self.segments - 1)
        out = np.zeros((rows, cols, 3), np.float32)
        for sx in np.unique(sxs):
            ci = np.flatnonzero(sxs == sx)
            for sy in np.unique(sys_):
                ri = np.flatnonzero(sys_ == sy)
                sat, mask = self._segment("s", sx, sy), self._segment("m", sx, sy)
                if sat is None or mask is None or (sx, sy) not in self.texgen:
                    continue
                aside, pu, pv = self.texgen[(sx, sy)]
                size = sat.shape[0]
                px = (xs[ci] * aside + pu) * size - 0.5
                py = (-zs[ri] * aside + pv) * size - 0.5
                colour = _bilinear(sat, px, py)
                if strength:
                    w = mask_weights(_bilinear(mask, px, py))
                    mi = self.material_index[np.clip((zs[ri] // self.cell).astype(int), 0, self.material_index.shape[0] - 1)][
                        :, np.clip((xs[ci] // self.cell).astype(int), 0, self.material_index.shape[1] - 1)]
                    layer = self.slots[mi]  # (r, c, 6), -1 → the flat entry
                    tr = (((-zs[ri]) % period) / period * n).astype(int) % n  # texture rows run southwards
                    tc = ((xs[ci] % period) / period * n).astype(int) % n
                    grain = np.zeros(w.shape[:2], np.float32)
                    for k in range(SLOTS):
                        grain += w[..., k] * details[layer[..., k], tr[:, None], tc[None, :]]
                    colour *= (1 + strength * (grain - 1))[..., None]
                out[np.ix_(ri, ci)] = colour
        return out


# --- Whole-map tiles ---------------------------------------------------------------
# Same chunks as render3d.py (8×8 full-resolution tiles), but only the top two zooms: below
# them the satellite itself is as sharp. No padding: every pixel depends only on its own spot.
LEVELS = 1  # zooms below the full-resolution one


def save_tile(root: Path, z: int, r: int, c: int, colour: np.ndarray, quality: int) -> None:
    path = root / str(z) / str(r) / f"{c}.webp"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(np.round(colour), 0, 255).astype(np.uint8), "RGB").save(path, quality=quality)


_job: dict = {}  # set in the parent before forking the workers


def render_chunk(rc: tuple[int, int]) -> tuple[tuple[int, int], int, float, str | None]:
    t0 = time.time()
    g, mpp, zoom, root, quality, strength = (_job[k] for k in ("ground", "mpp", "zoom", "root", "quality", "strength"))
    r, c = rc
    size = TILE << CHUNK
    span = size * mpp
    try:
        img = g.render(c * span, g.world - r * span, size, size, mpp, strength)
        written = 0
        for z, tr, tc, (colour,) in chunk_tiles(r, c, [img], zoom, LEVELS):
            save_tile(root, z, tr, tc, colour, quality)
            written += 1
        return rc, written, time.time() - t0, None
    except Exception as e:  # noqa: BLE001 - reported by the parent, the chunk stays undone
        return rc, 0, time.time() - t0, repr(e)


def render_tiles(g: Ground, map_name: str, jobs: int, resume: bool, quality: int, strength: float, log) -> None:
    sat = satellite_grid(map_name)
    size, zoom = sat["imageSize"] * 4, sat["maxNativeZoom"] + 2
    mpp = g.world / size
    n = -(-size // (TILE << CHUNK))
    root = ROOT / "tiles" / map_name / "ground"
    done_path = OUT / f"{map_name}.done"
    done = read_done(done_path, resume, root)
    todo = [(r, c) for r in range(n) for c in range(n) if (r, c) not in done]
    log(f"{size} px at {mpp:.4f} m/px, zooms {zoom - LEVELS}–{zoom}: {len(todo)} of {n * n} chunks to render "
        f"({len(done)} already done) with {jobs} workers")
    g.details(max(1, round(g.cell / REPEAT / mpp)))  # once, before forking
    _job.update(ground=g, mpp=mpp, zoom=zoom, root=root, quality=quality, strength=strength)
    run_chunks(render_chunk, todo, done_path, jobs, log)
    publish(root, map_name, "ground", {"imageSize": size, "maxNativeZoom": zoom, "minNativeZoom": zoom - LEVELS}, log)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("map", choices=sorted(WORLDS))
    ap.add_argument("--area", nargs=4, type=float, metavar=("X0", "Z0", "X1", "Z1"), default=(6450, 2450, 6600, 2600))
    ap.add_argument("--mpp", type=float, default=0.25, help="metres per pixel")
    ap.add_argument("--strength", type=float, default=0.8, help="how much of the detail textures' contrast to keep")
    ap.add_argument("--period", type=float, help="metres per texture repeat (default: material cell / 10)")
    ap.add_argument("--out", type=Path, default=OUT / "poc.png")
    ap.add_argument("--tiles", action="store_true", help="render the whole map into tiles/<map>/ground/")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) // 2), help="parallel workers for --tiles")
    ap.add_argument("--resume", action="store_true", help="with --tiles: keep the chunks already rendered")
    ap.add_argument("--quality", type=int, default=80, help="WebP quality for --tiles (default: 80)")
    args = ap.parse_args()
    t0 = time.time()

    def log(msg: str) -> None:
        print(f"[{time.time() - t0:6.1f} s] {msg}", flush=True)

    g = Ground(args.map, log)
    if args.tiles:
        render_tiles(g, args.map, args.jobs, args.resume, args.quality, args.strength, log)
        return 0
    x0, z0, x1, z1 = args.area
    cols, rows = round((x1 - x0) / args.mpp), round((z1 - z0) / args.mpp)
    img = g.render(x0, z1, cols, rows, args.mpp, args.strength, args.period)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(np.round(img), 0, 255).astype(np.uint8)).save(args.out)
    log(f"{cols}×{rows} px → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
