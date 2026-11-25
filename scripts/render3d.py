#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["python-lzo", "pillow", "numpy"]
# ///
"""The game's objects seen from straight above, over the satellite.

    uv run scripts/render3d.py chernarus                                  # Chernogorsk port → .cache/render3d/poc.png
    uv run scripts/render3d.py chernarus --area 6650 2350 7150 2850 --mpp 0.25 --lod 0
    uv run scripts/render3d.py chernarus --tiles [--jobs 4] [--resume]    # whole map → tiles/<map>/render/

--tiles writes a transparent overlay for the app to draw over the satellite: objects and their
shadows at 4× the satellite's resolution (0.25 m/px on Chernarus), two zoom levels past it.

Every structure in the area (no trees, bushes or water) is read with odol.py, placed with
its .wrp matrix and rasterised with a numpy z-buffer, highest surface wins. Each pixel samples
its section's colour texture through the model's UVs, at the mipmap level that matches how
many texels fall on a pixel, and is lit by its face normal from the north-west like topo.py's
hillshade. Sections with an alpha texture (_ca: glass, mesh fences, road decals) are blended over
the opaque layer by the texture's alpha, the top two per pixel, so overlapping road pieces
cover each other's faded ends. Multi-materials (apartment blocks…)
blend their four colour layers through the mask, read with the second UV set. Shadows are cast along the same
light over the terrain and the opaque objects' height map. Parsed models are cached in
.cache/models/.
"""

from __future__ import annotations

import argparse
import json
import math
import multiprocessing as mp
import os
import re
import shutil
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor" / "dayz_wrp"))
from dayz_wrp import Wrp  # noqa: E402
from extract_game import WORLDS, decode_paa, find_game, pbo_entries, read_entry  # noqa: E402
from odol import read_odol  # noqa: E402
from topo import _sample  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "models"
OUT = ROOT / ".cache" / "render3d"
SKIP = ("dz\\plants", "dz\\water")  # trees, bushes, clutter, water surfaces (and their _bliss sets)
# Flat road pieces and decals, which the game drapes over the terrain: as placed, a quarter of
# their surface sits over 10 cm under it, so where they dip below the ground they are drawn on it.
DRAPE = ("dz\\structures\\roads\\parts\\", "dz\\structures\\roads\\decals\\")
MARGIN = 60  # m around the area whose objects may still reach into it
LIGHT = np.array([-0.5, 0.7071, 0.5])  # x east, y up, z north: from the north-west at 45°
GREY = (128, 128, 128)
SHADOW = 0.55  # brightness left in cast shadow
# Triangles narrower than this from above (m) cast no shadow: cables and planks only hit a
# pixel centre here and there, and each hit would cast a long streak of its own.
THIN = 0.15
SAMPLES = 1 << 21  # candidate pixels per rasterisation chunk
TILE = 256  # satellite tile size at the full-resolution zoom (1 m/px)
PROCEDURAL = re.compile(r"color\(([\d.]+),([\d.]+),([\d.]+)")


def _mesh_path(name: str, lod: int) -> Path:
    return CACHE / f"{name.replace(chr(92), '__')}.lod{lod}.npz"


def load_mesh(name: str, entry, lod: int):
    """(vertices (N, 3), UV sets (2, N, 2), triangles (T, 3), section of each triangle (T,),
    section colour textures, section recipes). A recipe is the stages a section samples as
    (texture, UV set, transform): none for a flat colour, one texture, or a multi-material's
    four layers and their mask."""
    path = _mesh_path(name, lod)
    if path.exists():
        z = np.load(path)
        if "recipe" in z:
            return z["v"], z["uvs"], z["t"], z["s"], list(z["tex"]), [json.loads(x) for x in z["recipe"]]
    m = read_odol(read_entry(entry), max_lods=lod + 1)
    lo = m.lods[min(lod, len(m.lods) - 1)] if m.lods else None
    if lo is None:
        v, uvs, t, s, tex, recipes = np.zeros((0, 3), np.float32), np.zeros((2, 0, 2), np.float32), np.zeros((0, 3), np.int32), np.zeros(0, np.int32), [], []
    else:
        tris, secs = [], []
        for si, (a, b, _) in enumerate(lo.sections):
            for f in lo.faces[a:b]:
                for k in range(1, len(f) - 1):  # fan: quads become two triangles
                    tris.append((f[0], f[k], f[k + 1]))
                    secs.append(si)
        v = lo.vertices
        uvs = np.stack([lo.uvs[0], lo.uvs[1] if len(lo.uvs) > 1 else lo.uvs[0]]).astype(np.float32)
        t = np.array(tris, np.int32).reshape(-1, 3)
        s = np.array(secs, np.int32)
        tex = [x for _, _, x in lo.sections]
        recipes = []
        for si, x in enumerate(tex):
            if si in lo.multi:
                layers, mask = lo.multi[si]
                recipes.append([[st.texture, min(st.uv_set, 1), list(st.transform)] for st in (*layers, mask)])
            else:
                recipes.append([[x, 0, [1, 0, 0, 0, 1, 0]]] if x else [])
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez(path, v=v, uvs=uvs, t=t, s=s, tex=np.array(tex, dtype=str), recipe=np.array([json.dumps(r) for r in recipes], dtype=str))
    return v, uvs, t, s, tex, recipes

def texture_colours(names: set[str], index: dict, log) -> dict[str, tuple[int, int, int]]:
    """Average RGB of each colour texture, cached in .cache/models/colours.json."""
    path = CACHE / "colours.json"
    cache = json.loads(path.read_text()) if path.exists() else {}
    missing = 0
    for name in names - cache.keys():
        key = name.lower().lstrip("\\")
        if p := PROCEDURAL.search(key):  # #(argb,8,8,3)color(r,g,b,a,co)
            cache[name] = [round(float(c) * 255) for c in p.groups()]
            continue
        try:
            img = decode_paa(read_entry(index[key]))
            cache[name] = [round(c) for c in np.asarray(img.resize((32, 32), Image.BOX), np.float32).mean((0, 1))]
        except Exception:  # noqa: BLE001 - unknown or unsupported texture: grey
            cache[name] = None
            missing += 1
    path.write_text(json.dumps(cache))
    if missing:
        log(f"  {missing} new textures could not be read (drawn grey)")
    return {k: tuple(v) if v else GREY for k, v in cache.items()}


def satellite(tiles: Path, world: float, x0: float, z0: float, x1: float, z1: float, size: tuple[int, int]) -> Image.Image:
    """The satellite crop of the area, resampled from 1 m/px; row 0 is the north edge."""
    top, bottom = world - z1, world - z0
    c0, c1, r0, r1 = int(x0 // TILE), int(x1 // TILE), int(top // TILE), int(bottom // TILE)
    z = max(int(p.name) for p in tiles.iterdir() if p.is_dir())
    canvas = Image.new("RGB", ((c1 - c0 + 1) * TILE, (r1 - r0 + 1) * TILE))
    for r in range(r0, r1 + 1):
        for c in range(c0, c1 + 1):
            f = tiles / str(z) / str(r) / f"{c}.webp"
            if f.exists():
                canvas.paste(Image.open(f).convert("RGB"), ((c - c0) * TILE, (r - r0) * TILE))
    box = (x0 - c0 * TILE, top - r0 * TILE, x1 - c0 * TILE, bottom - r0 * TILE)
    return canvas.resize(size, Image.BICUBIC, box=box)


def rasterise(xy: np.ndarray, h: np.ndarray, shape: tuple[int, int], log,
              skip: np.ndarray | None = None) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Z-buffer from above. xy: (T, 3, 2) pixel coordinates, h: (T, 3) heights.
    Returns the top height, the triangle id (-1 = none) and the barycentric weights of the
    triangle's first two vertices at every pixel. skip: a triangle id per pixel to leave out,
    to peel the next layer down from a previous pass's ids."""
    rows, cols = shape
    if not len(xy):
        return np.full(shape, -np.inf, np.float32), np.full(shape, -1, np.int32), np.zeros((*shape, 2), np.float32)
    depth = np.full(rows * cols, -np.inf, np.float32)
    ids = np.full(rows * cols, -1, np.int32)
    bary = np.zeros((rows * cols, 2), np.float32)
    a, b, c = xy[:, 0], xy[:, 1], xy[:, 2]
    area = (b[:, 0] - a[:, 0]) * (c[:, 1] - a[:, 1]) - (b[:, 1] - a[:, 1]) * (c[:, 0] - a[:, 0])
    # Pixel centres inside each triangle's box: columns lo..hi inclusive.
    lo = np.ceil(xy.min(1) - 0.5).astype(np.int64)
    hi = np.floor(xy.max(1) - 0.5).astype(np.int64)
    lo = np.maximum(lo, 0)
    hi = np.minimum(hi, [cols - 1, rows - 1])
    span = (hi - lo + 1).max(1)
    keep = (np.abs(area) > 1e-6) & (span > 0)
    k = np.zeros_like(span)
    k[keep] = 1 << np.ceil(np.log2(span[keep])).astype(np.int64)
    for size in np.unique(k[keep]):
        sel = np.flatnonzero(k == size)
        dy, dx = np.divmod(np.arange(size * size), size)
        step = max(1, SAMPLES // (size * size))
        for i in range(0, len(sel), step):
            t = sel[i : i + step]
            px = lo[t, 0, None] + dx[None]
            py = lo[t, 1, None] + dy[None]
            inbox = (px <= hi[t, 0, None]) & (py <= hi[t, 1, None])
            qx, qy = px + 0.5, py + 0.5
            ta, tb, tc = a[t], b[t], c[t]
            inv = 1 / area[t, None]
            w0 = ((tb[:, 0, None] - qx) * (tc[:, 1, None] - qy) - (tb[:, 1, None] - qy) * (tc[:, 0, None] - qx)) * inv
            w1 = ((tc[:, 0, None] - qx) * (ta[:, 1, None] - qy) - (tc[:, 1, None] - qy) * (ta[:, 0, None] - qx)) * inv
            w2 = 1 - w0 - w1
            inside = inbox & (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            z = w0 * h[t, 0, None] + w1 * h[t, 1, None] + w2 * h[t, 2, None]
            tri = np.broadcast_to(t[:, None], inside.shape)[inside]
            pix, z = (py * cols + px)[inside], z[inside].astype(np.float32)
            w = np.stack([w0[inside], w1[inside]], 1)
            up = z > depth[pix]
            if skip is not None:
                up &= tri != skip[pix]
            pix, z, tri, w = pix[up], z[up], tri[up], w[up]
            if not len(pix):
                continue
            order = np.lexsort((z, pix))  # within a pixel, the highest last
            order = order[np.r_[pix[order][1:] != pix[order][:-1], True]]
            depth[pix[order]] = z[order]
            ids[pix[order]] = tri[order]
            bary[pix[order]] = w[order]
    log(f"  {int(keep.sum())} of {len(xy)} triangles cover a pixel centre; largest box {int(span.max())} px")
    return depth.reshape(shape), ids.reshape(shape), bary.reshape(*shape, 2)


def _bilinear(img: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Sample an (H, W, C) texture at UVs, wrapping around like the game does."""
    h, w = img.shape[:2]
    x, y = u * w - 0.5, v * h - 0.5
    x0, y0 = np.floor(x), np.floor(y)
    fx, fy = (x - x0)[:, None], (y - y0)[:, None]
    x0, y0 = x0.astype(np.int64) % w, y0.astype(np.int64) % h
    x1, y1 = (x0 + 1) % w, (y0 + 1) % h
    return ((img[y0, x0] * (1 - fx) + img[y0, x1] * fx) * (1 - fy)
            + (img[y1, x0] * (1 - fx) + img[y1, x1] * fx) * fy)


class Textures:
    """Decoded textures for sampling, a few kept at a time."""

    def __init__(self, index: dict):
        self.index, self.cache = index, {}

    def image(self, name: str) -> Image.Image | None:
        if name not in self.cache:
            if len(self.cache) >= 24:
                self.cache.pop(next(iter(self.cache)))
            try:
                self.cache[name] = decode_paa(read_entry(self.index[name.lower().lstrip("\\")]), "RGBA")
            except Exception:  # noqa: BLE001 - unknown or unsupported texture
                self.cache[name] = None
        return self.cache[name]

    def sample(self, name: str, uv: np.ndarray, rho: np.ndarray) -> np.ndarray | None:
        """RGBA 0–255 at each UV; `rho` (UV units per pixel) picks the mipmap."""
        if p := PROCEDURAL.search(name):  # #(argb,8,8,3)color(r,g,b,a,…)
            return np.broadcast_to(np.array([*(float(c) * 255 for c in p.groups()), 255], np.float32), (len(uv), 4))
        img = self.image(name)
        if img is None:
            return None
        level = np.log2(np.maximum(rho * np.sqrt(img.width * img.height), 1e-9))
        level = np.clip(np.floor(level), 0, int(np.log2(min(img.size)))).astype(np.int64)
        out = np.empty((len(uv), 4), np.float32)
        for lv in np.unique(level):
            k = level == lv
            mip = img.reduce(1 << int(lv)) if lv else img
            out[k] = _bilinear(np.asarray(mip, np.float32), uv[k, 0], uv[k, 1])
        return out


def texture_pixels(tri: np.ndarray, uvs: np.ndarray, tri_recipe: np.ndarray, tri_rho: np.ndarray,
                   recipes: list, textures: Textures, flat: np.ndarray) -> np.ndarray:
    """RGBA (0–255) of each pixel from its triangle's recipe. `uvs`: (2, pixels, 2) both UV sets
    at each pixel; `tri_rho`: (T, 2) UV units per pixel for each set. Triangles without a
    readable texture keep their flat colour. Multi-material masks blend black → layer 0,
    red → 1, green → 2, blue → 3."""
    out = np.empty((len(tri), 4), np.float32)
    out[:, :3], out[:, 3] = flat[tri], 255
    if not len(tri):
        return out
    rec = tri_recipe[tri]
    order = np.argsort(rec, kind="stable")
    bounds = np.flatnonzero(np.r_[True, rec[order][1:] != rec[order][:-1], True])
    for a, b in zip(bounds[:-1], bounds[1:]):
        k = order[a:b]
        stages = recipes[rec[k[0]]]

        def at(stage, k=k):
            name, uv_set, (ta, tb, tc, td, te, tf) = stage
            u, v = uvs[uv_set, k, 0], uvs[uv_set, k, 1]
            uv = np.stack([ta * u + tb * v + tc, td * u + te * v + tf], 1)
            return textures.sample(name, uv, tri_rho[tri[k], uv_set] * np.sqrt(abs(ta * te - tb * td)))

        if len(stages) == 1:
            if (c := at(stages[0])) is not None:
                out[k] = c
        elif len(stages) == 5:
            mask = at(stages[4])
            if mask is None:
                continue
            w = np.clip(mask[:, :3] / 255, 0, 1)
            w = np.concatenate([np.clip(1 - w.sum(1, keepdims=True), 0, 1), w], 1)
            rgb = np.zeros((len(k), 3), np.float32)
            for i in range(4):
                layer = at(stages[i])
                rgb += w[:, i : i + 1] * (layer[:, :3] if layer is not None else np.float32(GREY))
            out[k, :3] = rgb / np.maximum(w.sum(1, keepdims=True), 1e-6)
    return out

def cast_shadow(caster: np.ndarray, height: np.ndarray, mpp: float) -> np.ndarray:
    """True where the caster height map blocks the north-west light at 45° over `height`. Scans
    the rows from the north: each pixel carries the highest blocking height up the diagonal."""
    drop = np.sqrt(2) * mpp * LIGHT[1] / np.hypot(LIGHT[0], LIGHT[2])
    s = caster.copy()
    for r in range(1, len(s)):
        s[r, 1:] = np.maximum(caster[r, 1:], s[r - 1, :-1] - drop)
    return s > height + 0.1


class Scene:
    """Everything a render needs, loaded once: every structure's placement and each model's
    triangles with their section colours, recipes and alpha flags."""

    def __init__(self, map_name: str, lod: int, log):
        game = find_game()
        if game is None:
            raise SystemExit("DayZ install not found")
        self.index = {}
        for pbo in sorted((game / "Addons").glob("*.pbo")):
            self.index.update((e.name.lower(), e) for e in pbo_entries(pbo) if e.name.lower().endswith((".p3d", ".paa")))
        wrp = next(e for e in pbo_entries(game / "Addons" / f"worlds_{WORLDS[map_name]}.pbo") if e.name.lower().endswith(".wrp"))
        w = Wrp(read_entry(wrp), want_objects=True, want_mapinfo=False, want_roads=False, progress=None)
        self.world, self.cell, self.elevation = float(w.world_size), w.cell_size, w.elevation.astype(np.float32)
        names = [str(x).lower() for x in w.models]
        keep = ~np.array([n.startswith(SKIP) for n in names])[w.objects["model"]]
        self.model, self.m = w.objects["model"][keep], w.objects["m"][keep]
        self.draped = {i for i, n in enumerate(names) if n.startswith(DRAPE)}
        del w
        log(f"index of {len(self.index)} files, terrain and {len(self.model)} structures read")

        meshes, failed = {}, {}
        for mi in np.unique(self.model):
            try:
                meshes[mi] = load_mesh(names[mi], self.index[names[mi]], lod)
            except Exception as e:  # noqa: BLE001 - report and carry on
                failed[names[mi]] = repr(e)
        log(f"{len(meshes)} models read; {len(failed)} not drawn")
        for n, e in list(failed.items())[:5]:
            log(f"  {n}: {e}")
        colours = texture_colours({x for v in meshes.values() for x in v[4] if x}, self.index, log)
        recipe_id = {}
        self.meshes = {}
        for mi, (v, uvs, t, s, tex, sec_recipes) in meshes.items():
            if not len(t):
                continue
            sec_rgb = np.array([colours.get(x, GREY) if x else GREY for x in tex], np.float32)
            sec_recipe = np.array([recipe_id.setdefault(json.dumps(r), len(recipe_id)) for r in sec_recipes], np.int32)
            sec_alpha = np.array([x.lower().endswith("_ca.paa") and len(r) == 1 for x, r in zip(tex, sec_recipes)], bool)
            self.meshes[mi] = (v, uvs[:, t], t, sec_rgb[s], sec_recipe[s], sec_alpha[s])
        self.recipes = [json.loads(r) for r in recipe_id]
        log(f"{len(colours)} texture colours, {len(self.recipes)} recipes")


def render(scene: Scene, x0: float, z0: float, x1: float, z1: float, mpp: float, textures: Textures,
           log=lambda _: None) -> tuple[np.ndarray, np.ndarray] | None:
    """The objects over an area, shadows included, as premultiplied colour (rows, cols, 3) and
    coverage (rows, cols): the final image is colour + (1 − coverage) × ground. None if empty."""
    m = scene.m
    near = (m[:, 9] > x0 - MARGIN) & (m[:, 9] < x1 + MARGIN) & (m[:, 11] > z0 - MARGIN) & (m[:, 11] < z1 + MARGIN)
    cols, rows = round((x1 - x0) / mpp), round((z1 - z0) / mpp)
    edge = np.array([cols - 1, rows - 1], np.float32)
    parts, placed = [], 0
    for mi, mm in zip(scene.model[near], m[near]):
        if (mesh := scene.meshes.get(mi)) is None:
            continue
        v, tuv, t, rgb, recipe, alpha = mesh
        wv = (v @ mm[:9].reshape(3, 3) + mm[9:12]).astype(np.float32)  # world = pos + R·v, R's columns are m[0:3], m[3:6], m[6:9]
        tw = wv[t]
        # Keep only triangles that cover a pixel centre in the area seen from above (most
        # walls are edge-on, and neighbouring objects only partly reach in).
        xy = np.stack([(tw[..., 0] - x0) / mpp, (z1 - tw[..., 2]) / mpp], -1)
        e1, e2 = xy[:, 1] - xy[:, 0], xy[:, 2] - xy[:, 0]
        lo = np.maximum(np.ceil(xy.min(1) - 0.5), 0)
        hi = np.minimum(np.floor(xy.max(1) - 0.5), edge)
        k = (np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0]) > 1e-6) & (lo <= hi).all(1)
        placed += len(t)
        if k.any():
            parts.append((tw[k], tuv[:, k], rgb[k], recipe[k], alpha[k], np.full(int(k.sum()), mi in scene.draped)))
    if not parts:
        return None
    tris, flat, tri_recipe, alpha, draped = (np.concatenate([p[i] for p in parts]) for i in (0, 2, 3, 4, 5))
    tri_uv = np.concatenate([p[1] for p in parts], axis=1)  # (2, T, 3, 2)
    normal = np.cross(tris[:, 1] - tris[:, 0], tris[:, 2] - tris[:, 0])
    normal *= np.where(normal[:, 1:2] < 0, -1, 1)  # face the viewer above
    normal /= np.maximum(np.linalg.norm(normal, axis=1, keepdims=True), 1e-12)
    shade = np.clip(1 - 0.55 * (1 - (normal @ LIGHT) / LIGHT[1]), 0.45, 1.15).astype(np.float32)
    log(f"{len(parts)} objects, {len(tris)} of {placed} triangles seen from above, {alpha.mean():.1%} with alpha textures")

    xy = np.stack([(tris[..., 0] - x0) / mpp, (z1 - tris[..., 2]) / mpp], -1).astype(np.float32)
    e1, e2 = xy[:, 1] - xy[:, 0], xy[:, 2] - xy[:, 0]
    plan_px = np.abs(e1[:, 0] * e2[:, 1] - e1[:, 1] * e2[:, 0])  # twice the area seen from above, px²
    f1, f2 = tri_uv[:, :, 1] - tri_uv[:, :, 0], tri_uv[:, :, 2] - tri_uv[:, :, 0]
    tri_rho = np.sqrt(np.abs(f1[..., 0] * f2[..., 1] - f1[..., 1] * f2[..., 0]) / np.maximum(plan_px, 1e-9)).T  # (T, 2)

    # Terrain under every pixel centre; object pixels below it are buried.
    gx = (x0 + (np.arange(cols) + 0.5) * mpp) / scene.cell
    gz = (z1 - (np.arange(rows) + 0.5) * mpp) / scene.cell
    height = _sample(scene.elevation, gz[:, None] + 0 * gx[None], gx[None] + 0 * gz[:, None]).astype(np.float32)
    ground = height.copy()

    colour = np.zeros((rows * cols, 3), np.float32)
    cover = np.zeros(rows * cols, np.float32)
    # Alpha surfaces are drawn two deep: road pieces fade out at their ends over the next piece,
    # and with only the top one the ground would show through every joint.
    top = None
    for name in ("opaque", "alpha under", "alpha"):
        sel = np.flatnonzero(alpha if name != "opaque" else ~alpha)
        if name == "alpha":
            depth, ids, bary = top
        else:
            if name == "alpha under":
                top = rasterise(xy[sel], tris[sel, :, 1], (rows, cols), log)
            depth, ids, bary = rasterise(xy[sel], tris[sel, :, 1], (rows, cols), log,
                                         None if top is None else top[1].ravel())
        if name != "opaque" and len(sel):
            on_ground = (ids >= 0) & draped[sel][np.maximum(ids, 0)]
            depth = np.where(on_ground, np.maximum(depth, ground + 0.01), depth)
        drawn = (ids >= 0) & (depth > height - 0.1)  # buried, or under the opaque layer
        pix = np.flatnonzero(drawn)
        tri = sel[ids.ravel()[pix]]
        w01 = bary.reshape(-1, 2)[pix]
        weights = np.concatenate([w01, 1 - w01.sum(1, keepdims=True)], 1)
        uvs = (tri_uv[:, tri] * weights[None, :, :, None]).sum(2)
        rgba = texture_pixels(tri, uvs, tri_recipe, tri_rho, scene.recipes, textures, flat)
        a = np.ones(len(pix), np.float32) if name == "opaque" else rgba[:, 3] / 255
        colour[pix] = colour[pix] * (1 - a[:, None]) + rgba[:, :3] * shade[tri, None] * a[:, None]
        cover[pix] = cover[pix] * (1 - a) + a
        if name == "opaque":
            thin = np.zeros_like(drawn)
            plan_w = plan_px / np.maximum(np.linalg.norm(xy - np.roll(xy, 1, 1), axis=2).max(1), 1e-6)
            thin.ravel()[pix] = plan_w[tri] * mpp < THIN  # narrowest height of the triangle, m
            caster = np.where(drawn & ~thin, depth, height).astype(np.float32)
            height = np.where(drawn, depth, height).astype(np.float32)
        log(f"{name} layer on {drawn.mean():.1%}")
    shadow = cast_shadow(caster, height, mpp).ravel()
    s = np.where(shadow, np.float32(SHADOW), np.float32(1))
    colour *= s[:, None]
    cover = 1 - s * (1 - cover)  # shadow darkens the ground the overlay lets through
    log(f"cast shadow on {shadow.mean():.1%}")
    return colour.reshape(rows, cols, 3), cover.reshape(rows, cols)


# --- Whole-map tiles ---------------------------------------------------------------
# The overlay pyramid has 4× the satellite's pixels, so its tiles line up with the
# satellite's two zoom levels further in. Each job renders one tile at CHUNK_ZOOM levels
# above full resolution (8×8 full-resolution tiles) plus PAD around it, so shadows and
# overhangs cross chunk edges, and writes that chunk's tiles down to CHUNK_ZOOM.
CHUNK = 3  # zoom levels between a job and full resolution
PAD = 48  # m


def _halve(x: np.ndarray) -> np.ndarray:
    h, w = x.shape[:2]
    return x.reshape(h // 2, 2, w // 2, 2, *x.shape[2:]).mean((1, 3))


def chunk_tiles(r: int, c: int, arrays: list[np.ndarray], zoom: int, levels: int):
    """The tiles of chunk (r, c) at zoom and `levels` zooms below it, each level halving the
    last: yields (z, row, col, [each array's block])."""
    for z in range(zoom, zoom - levels - 1, -1):
        n = arrays[0].shape[0] // TILE
        for i in range(n):
            for j in range(n):
                block = np.s_[i * TILE : (i + 1) * TILE, j * TILE : (j + 1) * TILE]
                yield z, r * n + i, c * n + j, [a[block] for a in arrays]
        if z > zoom - levels:
            arrays = [_halve(a) for a in arrays]


def run_chunks(worker, todo: list, done_path: Path, jobs: int, log) -> None:
    """Run worker(rc) → (rc, tiles written, seconds, error or None) over the chunks in a fork
    Pool, appending each finished one to done_path so an interrupted run can --resume."""
    errors = 0
    done_path.parent.mkdir(parents=True, exist_ok=True)
    t0 = last = time.time()
    with mp.get_context("fork").Pool(jobs) as pool, done_path.open("a") as done_file:
        for i, (rc, written, secs, err) in enumerate(pool.imap_unordered(worker, todo), 1):
            if err:
                errors += 1
                log(f"  chunk {rc}: {err}")
                continue
            done_file.write(f"{rc[0]} {rc[1]}\n")
            done_file.flush()
            if i % max(1, len(todo) // 20) == 0 or i == len(todo) or time.time() - last > 60:
                last = time.time()
                eta = (time.time() - t0) / i * (len(todo) - i)
                log(f"  {i}/{len(todo)} chunks (last {rc}: {written} tiles in {secs:.1f} s); ~{eta / 60:.0f} min left")
    if errors:
        raise SystemExit(f"{errors} chunks failed; fix and rerun with --resume")


def read_done(done_path: Path, resume: bool, root: Path) -> set[tuple[int, int]]:
    """The chunks already rendered; without resume, start over."""
    if not resume:
        shutil.rmtree(root, ignore_errors=True)
        done_path.unlink(missing_ok=True)
    return {tuple(map(int, line.split())) for line in done_path.read_text().splitlines()} if done_path.exists() else set()


def publish(root: Path, map_name: str, layer: str, info: dict, log) -> None:
    """Write the tileset's tiles.json and its entry in tiles/index.json."""
    info = {**info, "rev": format(int(time.time()), "x")}
    (root / "tiles.json").write_text(json.dumps(info))
    index_path = ROOT / "tiles" / "index.json"
    index = json.loads(index_path.read_text())
    index[map_name][layer] = info
    index_path.write_text(json.dumps(index, indent=2, sort_keys=True))
    files = list(root.glob("*/*/*.webp"))
    log(f"{len(files)} tiles, {sum(f.stat().st_size for f in files) / 1e6:.0f} MB → {root}")


def satellite_grid(map_name: str) -> dict:
    """The satellite's tiles.json entry, which overlays at higher zooms must line up with."""
    index_path = ROOT / "tiles" / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    if "satellite" not in index.get(map_name, {}):
        raise SystemExit(f"no satellite tiles for {map_name}: run extract_game.py first")
    return index[map_name]["satellite"]


def save_tile(root: Path, z: int, r: int, c: int, colour: np.ndarray, cover: np.ndarray, quality: int) -> bool:
    """Write one RGBA WebP tile from premultiplied colour; tiles with nothing on them are skipped."""
    if cover.max() < 0.5 / 255:
        return False
    rgb = colour / np.maximum(cover, 1e-6)[..., None]
    rgba = np.round(np.dstack([np.clip(rgb, 0, 255), cover[..., None] * 255])).astype(np.uint8)
    path = root / str(z) / str(r) / f"{c}.webp"
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(rgba, "RGBA").save(path, quality=quality)
    return True


_job: dict = {}  # set in the parent before forking the workers


def render_chunk(rc: tuple[int, int]) -> tuple[tuple[int, int], int, float, str | None]:
    t0 = time.time()
    scene, mpp, zoom, root, quality = (_job[k] for k in ("scene", "mpp", "zoom", "root", "quality"))
    if "textures" not in _job:
        _job["textures"] = Textures(scene.index)
    r, c = rc
    size = TILE << CHUNK
    span = size * mpp
    x0, z1 = c * span, scene.world - r * span
    pad = round(PAD / mpp)  # whole pixels, so the crop stays on the tile grid
    m = pad * mpp
    try:
        out = render(scene, x0 - m, z1 - span - m, x0 + span + m, z1 + m, mpp, _job["textures"])
        written = 0
        if out is not None:
            arrays = [a[pad : pad + size, pad : pad + size] for a in out]
            for z, tr, tc, (colour, cover) in chunk_tiles(r, c, arrays, zoom, CHUNK):
                written += save_tile(root, z, tr, tc, colour, cover, quality)
        return rc, written, time.time() - t0, None
    except Exception as e:  # noqa: BLE001 - reported by the parent, the chunk stays undone
        return rc, 0, time.time() - t0, repr(e)


def pyramid(root: Path, top: int, quality: int, log) -> None:
    """Zoom levels above the chunks, each tile averaged from its four children."""
    for z in range(top - 1, -1, -1):
        children = [(int(f.parent.name), int(f.stem)) for f in (root / str(z + 1)).glob("*/*.webp")]
        for r, c in sorted({(r // 2, c // 2) for r, c in children}):
            colour = np.zeros((2 * TILE, 2 * TILE, 3), np.float32)
            cover = np.zeros((2 * TILE, 2 * TILE), np.float32)
            for dr in (0, 1):
                for dc in (0, 1):
                    f = root / str(z + 1) / str(2 * r + dr) / f"{2 * c + dc}.webp"
                    if f.exists():
                        rgba = np.asarray(Image.open(f).convert("RGBA"), np.float32)
                        block = np.s_[dr * TILE : (dr + 1) * TILE, dc * TILE : (dc + 1) * TILE]
                        cover[block] = rgba[..., 3] / 255
                        colour[block] = rgba[..., :3] * cover[block][..., None]
            save_tile(root, z, r, c, _halve(colour), _halve(cover), quality)
        log(f"zoom {z} built")


def write_coverage(root: Path, zoom: int) -> None:
    """coverage.bin: one bit per tile slot at the top zoom (row-major, MSB first), set where a tile
    exists. Half the slots are empty (sea, fields), so the app skips them instead of asking for 404s;
    a lower zoom's tile exists when any of its children does."""
    n = 1 << zoom
    bits = np.zeros((n, n), bool)
    for f in (root / str(zoom)).glob("*/*.webp"):
        bits[int(f.parent.name), int(f.stem)] = True
    (root / "coverage.bin").write_bytes(np.packbits(bits).tobytes())


def render_tiles(scene: Scene, map_name: str, jobs: int, resume: bool, quality: int, log) -> None:
    sat = satellite_grid(map_name)
    size, zoom = sat["imageSize"] * 4, sat["maxNativeZoom"] + 2
    mpp = scene.world / size
    span = (TILE << CHUNK) * mpp
    n = math.ceil(size / (TILE << CHUNK))
    root = ROOT / "tiles" / map_name / "render"
    done_path = OUT / f"{map_name}.done"
    done = read_done(done_path, resume, root)

    # Chunks any object may reach into, the busiest first so the workers finish together.
    x, z = scene.m[:, 9], scene.world - scene.m[:, 11]
    load: dict[tuple[int, int], int] = {}
    for dx in (-MARGIN - PAD, MARGIN + PAD):
        for dz in (-MARGIN - PAD, MARGIN + PAD):
            cells = np.stack([((z + dz) // span), ((x + dx) // span)], 1).clip(0, n - 1).astype(int)
            for rc, k in zip(*np.unique(cells, axis=0, return_counts=True)):
                key = (int(rc[0]), int(rc[1]))
                load[key] = max(load.get(key, 0), int(k))
    todo = sorted((rc for rc in load if rc not in done), key=lambda rc: -load[rc])
    log(f"{size} px at {mpp:.4f} m/px, zoom {zoom}: {len(todo)} of {len(load)} chunks to render "
        f"({len(done)} already done) with {jobs} workers")

    _job.update(scene=scene, mpp=mpp, zoom=zoom, root=root, quality=quality)
    run_chunks(render_chunk, todo, done_path, jobs, log)
    pyramid(root, zoom - CHUNK, quality, log)
    write_coverage(root, zoom)
    publish(root, map_name, "render", {"imageSize": size, "maxNativeZoom": zoom}, log)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("map", choices=sorted(WORLDS))
    ap.add_argument("--area", nargs=4, type=float, metavar=("X0", "Z0", "X1", "Z1"), default=(6650, 2350, 7150, 2850))
    ap.add_argument("--mpp", type=float, default=0.25, help="metres per pixel")
    ap.add_argument("--lod", type=int, default=0, help="visual LOD, 0 = most detailed")
    ap.add_argument("--out", type=Path, default=OUT / "poc.png")
    ap.add_argument("--tiles", action="store_true", help="render the whole map into tiles/<map>/render/")
    ap.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 2) // 2), help="parallel workers for --tiles (default: one per core, ~1 GB each)")
    ap.add_argument("--resume", action="store_true", help="with --tiles: keep the chunks already rendered")
    ap.add_argument("--quality", type=int, default=80, help="WebP quality for --tiles (default: 80)")
    args = ap.parse_args()
    t0 = time.time()

    def log(msg: str) -> None:
        print(f"[{time.time() - t0:6.1f} s] {msg}", flush=True)

    scene = Scene(args.map, args.lod, log)
    if args.tiles:
        render_tiles(scene, args.map, args.jobs, args.resume, args.quality, log)
        return 0
    x0, z0, x1, z1 = args.area
    out = render(scene, x0, z0, x1, z1, args.mpp, Textures(scene.index), log)
    cols, rows = round((x1 - x0) / args.mpp), round((z1 - z0) / args.mpp)
    img = np.asarray(satellite(ROOT / "tiles" / args.map / "satellite", scene.world, x0, z0, x1, z1, (cols, rows)), np.float32)
    if out is not None:
        colour, cover = out
        img = colour + (1 - cover[..., None]) * img
    args.out.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(np.clip(img, 0, 255).astype(np.uint8)).save(args.out)
    log(f"{cols}×{rows} px → {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
