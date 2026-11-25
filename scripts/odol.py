#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["python-lzo", "pillow", "numpy"]
# ///
"""Reader for DayZ's binarised models (ODOL version 56): the geometry of the visual LODs.

    uv run scripts/odol.py chernarus   # parse every model in the game, check the port against the .wrp

    from odol import read_odol
    m = read_odol(data)
    lod = m.lods[0]          # most detailed visual LOD
    lod.vertices             # (N, 3) float32, model space: x east, y up, z north
    lod.faces                # list of vertex index tuples (triangles or quads)
    lod.sections             # (first face, end face, colour texture or "") per section
    lod.uvs                  # UV sets, each (N, 2) float32
    lod.multi                # section → (four colour layers, mask) for multi-materials

Worked out from hex dumps of DayZ's own models, following the public Arma ODOL layout
(community.bistudio.com, Braini01/bis-file-formats). What differs or matters here:

  * the header has no appID / prefix fields; after the resolutions comes the model info,
    of which we only take the bounding box (48 bytes in); the rest is skipped by locating the LOD offset table (n starts, then n ends, end[0] = file size);
    LODs are stored back to front
  * embedded materials are version 20: 220 bytes of colours and shader settings, the
    surface file, then the render flags before the stage counts
  * face indices are u16 behind a u8 vertex count; section face ranges are byte offsets
    that count each face as 2 + 2·k bytes
  * multi-materials blend four colour stages (0–3) through a mask (stage 4) that reads the
    second UV set; each stage's id is its texgen, which holds the UV set and a 4×3 matrix
  * arrays are LZO-compressed once they reach 1024 bytes, with no flag byte
  * only the part up to the vertex positions is read; the rest of each LOD is skipped
    through its size field
"""

from __future__ import annotations

import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent / "vendor" / "dayz_wrp"))
import lzo1x  # noqa: E402  (pure Python, and it reports how many bytes it consumed)

# Resolutions at or above this are special LODs (geometry, memory, shadow…).
SPECIAL_LOD = 1e4


@dataclass
class Lod:
    resolution: float
    vertices: np.ndarray
    faces: list[tuple[int, ...]]
    sections: list[tuple[int, int, str]]
    textures: list[str]
    bbox: tuple[np.ndarray, np.ndarray]
    uvs: list[np.ndarray]  # UV sets, (N, 2) float32 each; v grows down the texture
    multi: dict[int, tuple[list[Stage], Stage]]  # section → colour layers and their mask


@dataclass
class Stage:
    texture: str
    uv_set: int  # which of the LOD's UV sets it reads
    transform: tuple[float, ...]  # u' = a·u + b·v + c, v' = d·u + e·v + f, as (a, b, c, d, e, f)


@dataclass
class Material:
    colour: str  # first colour texture (_co / _ca), or ""
    multi: tuple[list[Stage], Stage] | None  # four colour layers and the mask that blends them


@dataclass
class Model:
    version: int
    resolutions: list[float]
    bbox: tuple[np.ndarray, np.ndarray]  # whole model, symmetric about the origin; the .wrp mapinfo rectangle is its XZ
    lods: list[Lod] = field(default_factory=list)  # visual LODs only, most detailed first


class _Reader:
    def __init__(self, data: bytes, pos: int = 0):
        self.d, self.p = data, pos

    def u8(self) -> int:
        v = self.d[self.p]
        self.p += 1
        return v

    def u16(self) -> int:
        (v,) = struct.unpack_from("<H", self.d, self.p)
        self.p += 2
        return v

    def u32(self) -> int:
        (v,) = struct.unpack_from("<I", self.d, self.p)
        self.p += 4
        return v

    def i32(self) -> int:
        (v,) = struct.unpack_from("<i", self.d, self.p)
        self.p += 4
        return v

    def floats(self, n: int) -> tuple[float, ...]:
        v = struct.unpack_from(f"<{n}f", self.d, self.p)
        self.p += 4 * n
        return v

    def asciiz(self) -> str:
        end = self.d.index(b"\0", self.p)
        v = self.d[self.p : end].decode("latin-1")
        self.p = end + 1
        return v

    def raw(self, size: int) -> bytes:
        if size >= 1024:
            out, self.p = lzo1x.decompress(self.d, self.p, size)
            return bytes(out)
        v = self.d[self.p : self.p + size]
        self.p += size
        return v

    def array(self, item: int) -> tuple[int, bytes]:
        n = self.u32()
        return n, self.raw(n * item)

    def fill_array(self, item: int) -> tuple[int, bytes]:
        n = self.u32()
        if self.u8():  # every element has the same value
            v = self.d[self.p : self.p + item]
            self.p += item
            return n, v * n
        return n, self.raw(n * item)


def _lod_table(d: bytes, n: int) -> tuple[tuple[int, ...], tuple[int, ...]]:
    for p in range(12 + 4 * n, len(d) - 8 * n):
        if struct.unpack_from("<I", d, p + 4 * n)[0] != len(d):
            continue
        starts = struct.unpack_from(f"<{n}I", d, p)
        ends = struct.unpack_from(f"<{n}I", d, p + 4 * n)
        if all(p < s < e <= len(d) for s, e in zip(starts, ends)):
            return starts, ends
    raise ValueError("LOD offset table not found")


UV_SOURCE = {1: 0, 5: 1}  # texgen uv source (tex, tex1) → UV set


def _material(r: _Reader) -> Material:
    """Read one embedded material: its first colour texture, and the layers of a multi-material."""
    r.asciiz()
    version = r.u32()
    if version != 20:
        raise ValueError(f"material version {version} at {r.p:#x}")
    r.p += 220  # colours, specular power, shaders, light and fog modes, DayZ extras
    r.asciiz()  # surface (.bisurf), usually empty
    r.p += 8  # render flags
    n_stages, n_texgens = r.u32(), r.u32()
    stages, texgens = [], []
    for i in range(n_stages + 1):  # the TI stage comes after the texgens
        if i == n_stages:
            for _ in range(n_texgens):
                source, m = r.u32(), r.floats(12)
                texgens.append((UV_SOURCE.get(source, 0), (m[0], m[3], m[9], m[1], m[4], m[10])))
        r.u32()  # filter
        tex = r.asciiz()
        texgen = r.u32()
        r.u8()  # world env map
        stages.append((tex, texgen))
    colour = next((t for t, _ in stages if t.lower().endswith(("_co.paa", "_ca.paa"))), "")

    def stage(i: int) -> Stage:
        tex, g = stages[i]
        return Stage(tex, *texgens[g]) if g < len(texgens) else Stage(tex, 0, (1, 0, 0, 0, 1, 0))

    multi = None
    if n_stages > 4 and stages[4][0].lower().endswith("mask.paa"):
        multi = ([stage(i) for i in range(4)], stage(4))
    return Material(colour, multi)


def _lod(d: bytes, start: int, end: int, resolution: float) -> Lod:
    r = _Reader(d, start)
    for _ in range(r.u32()):  # proxies
        r.asciiz()
        r.floats(12)
        r.p += 16  # sequence id, selection, bone, section
    n = r.u32()  # sub-skeleton → skeleton
    r.p += 4 * n
    for _ in range(r.u32()):  # skeleton → sub-skeleton
        n = r.u32()
        r.p += 4 * n
    n_vertices = r.u32()
    r.floats(1)  # face area
    r.u32(), r.u32()  # or / and hints
    b = r.floats(10)
    bbox = (np.array(b[0:3], np.float32), np.array(b[3:6], np.float32))
    textures = [r.asciiz() for _ in range(r.u32())]
    materials = [_material(r) for _ in range(r.u32())]
    r.array(2)  # point → vertex
    r.array(2)  # vertex → point

    n_faces = r.u32()
    r.u32()  # faces' size in section-offset units
    r.u16()
    faces, offsets, off = [], [], 0
    for _ in range(n_faces):
        k = r.u8()
        faces.append(struct.unpack_from(f"<{k}H", d, r.p))
        r.p += 2 * k
        offsets.append(off)
        off += 2 + 2 * k
    offsets.append(off)
    face_at = {o: i for i, o in enumerate(offsets)}

    sections, multi = [], {}
    for si in range(r.u32()):
        lo, hi = r.u32(), r.u32()
        r.p += 12  # min bone, bone count, unknown
        tex = r.u16()
        r.u32()  # special flags
        mat = r.i32()
        if mat == -1:
            r.asciiz()
        r.floats(r.u32())  # area over texture
        if lo not in face_at or hi not in face_at:
            raise ValueError(f"section range {lo}–{hi} not on a face boundary")
        material = materials[mat] if 0 <= mat < len(materials) else None
        if tex < len(textures):
            texture = textures[tex]
        else:  # no texture of its own: the material's colour stage
            texture = material.colour if material else ""
        if material and material.multi:
            multi[si] = material.multi
        sections.append((face_at[lo], face_at[hi], texture))

    for _ in range(r.u32()):  # named selections
        r.asciiz()
        r.array(2)  # faces
        r.u32()
        r.u8()  # sectional
        r.array(4)  # sections
        r.array(2)  # vertices
        r.array(1)  # weights
    for _ in range(r.u32()):  # named properties
        r.asciiz(), r.asciiz()
    if r.u32():
        raise ValueError("keyframe animations are not supported")
    r.p += 12  # top colour, colour, special
    r.u8()  # vertex bone refs are simple
    size_at = r.p
    if size_at + r.u32() != end:
        raise ValueError(f"LOD at {start:#x}: rest size does not reach the LOD end")

    r.fill_array(4)  # clip flags
    uvs = [_uv_set(r)]
    for _ in range(r.u32() - 1):
        uvs.append(_uv_set(r))
    n, raw = r.array(12)
    if n != n_vertices:
        raise ValueError(f"{n} positions for {n_vertices} vertices")
    vertices = np.frombuffer(raw, "<f4").reshape(-1, 3).copy()
    if any(len(uv) != n_vertices for uv in uvs):
        raise ValueError(f"{[len(uv) for uv in uvs]} UVs for {n_vertices} vertices")
    return Lod(resolution, vertices, faces, sections, textures, bbox, uvs, multi)


def _uv_set(r: _Reader) -> np.ndarray:
    """A UV set: its range, then each vertex as two s16 within it."""
    u0, v0, u1, v1 = r.floats(4)
    _, raw = r.fill_array(4)
    packed = (np.frombuffer(raw, "<i2").reshape(-1, 2).astype(np.float32) + 32767) / 65534
    return packed * [u1 - u0, v1 - v0] + [u0, v0]


def read_odol(data: bytes, max_lods: int | None = None) -> Model:
    """Parse the visual LODs (most detailed first); `max_lods` stops after that many."""
    if data[:4] != b"ODOL":
        raise ValueError("not an ODOL model")
    version, n = struct.unpack_from("<II", data, 4)
    if version != 56:
        raise ValueError(f"ODOL version {version}, expected 56")
    resolutions = list(struct.unpack_from(f"<{n}f", data, 12))
    starts, ends = _lod_table(data, n)
    b = np.frombuffer(data, "<f4", 6, 12 + 4 * n + 48)
    model = Model(version, resolutions, (b[:3].copy(), b[3:].copy()))
    for i, res in enumerate(resolutions):
        if res >= SPECIAL_LOD or (max_lods is not None and len(model.lods) >= max_lods):
            continue
        model.lods.append(_lod(data, starts[i], ends[i], res))
    return model


def _check(map_id: str) -> int:
    """Parse every model in the install, then place the Chernogorsk port's buildings with
    their .wrp matrices and compare against the map's footprint rectangles (mapinfo)."""
    import itertools
    import time

    from dayz_wrp import Wrp
    from extract_game import WORLDS, find_game, pbo_entries, read_entry

    game = find_game()
    if game is None:
        print("DayZ install not found", file=sys.stderr)
        return 1
    index = {}
    for pbo in sorted((game / "Addons").glob("*.pbo")):
        index.update((e.name.lower(), e) for e in pbo_entries(pbo) if e.name.lower().endswith(".p3d"))
    t, bad, models = time.time(), {}, {}
    for name, entry in index.items():
        try:
            m = read_odol(read_entry(entry))
            for lod in m.lods:
                n = len(lod.vertices)
                if lod.faces and max(max(f) for f in lod.faces) >= n:
                    raise ValueError("face index out of range")
                covered = sorted((a, b) for a, b, _ in lod.sections)
                if covered and (covered[0][0] != 0 or covered[-1][1] != len(lod.faces)
                                or any(a[1] != b[0] for a, b in itertools.pairwise(covered))):
                    raise ValueError("sections do not cover the faces")
            models[name] = m
        except Exception as e:  # noqa: BLE001 - report and carry on
            bad[name] = repr(e)
    print(f"{len(models)}/{len(index)} models parsed in {time.time() - t:.0f} s")
    for name, err in list(bad.items())[:10]:
        print(f"  {name}: {err}")

    wrp = next(e for e in pbo_entries(game / "Addons" / f"worlds_{WORLDS[map_id]}.pbo") if e.name.lower().endswith(".wrp"))
    w = Wrp(read_entry(wrp), want_objects=True, want_roads=False, progress=None)
    footprint = {rec["id"]: rec["corners"] for kind, rec in w.mapinfo if kind in (3, 4)}  # building, house
    x0, z0, x1, z1 = 6300, 2100, 7300, 2900  # Chernogorsk port and around
    rows: dict[str, list] = {}
    for oid, mi, m in zip(w.objects["id"], w.objects["model"], w.objects["m"]):
        name = str(w.models[mi]).lower()
        if not (x0 < m[9] < x1 and z0 < m[11] < z1) or int(oid) not in footprint or name not in models:
            continue
        model = models[name]
        rot = np.array([[m[0], m[6]], [m[2], m[8]]])  # world (x, z) from model (x, z)
        corners = np.array(footprint[int(oid)]).reshape(4, 2)
        lo, hi = model.bbox
        box = np.array([[lo[0], lo[2]], [hi[0], lo[2]], [hi[0], hi[2]], [lo[0], hi[2]]]) @ rot.T + [m[9], m[11]]
        place = np.linalg.norm(corners[:, None] - box[None], axis=2).min(1).max()
        half = np.abs((corners - [m[9], m[11]]) @ np.linalg.inv(rot).T).max(0)
        reach = np.abs(model.lods[0].vertices[:, [0, 2]]).max(0)
        rows.setdefault(name, []).append((place, (reach - half).max(), (half - reach).min()))
    # place: header box placed by the matrix vs the rectangle. out: how far the most detailed
    # LOD pokes out of the rectangle. gap: how far it stays inside on its tighter axis.
    print(f"\n{'model':32} {'n':>4} {'place':>6} {'out':>6} {'gap':>6}")
    for name, r in sorted(rows.items(), key=lambda kv: -len(kv[1]))[:20]:
        a = np.array(r)
        print(f"{name.split(chr(92))[-1][:-4]:32} {len(a):4} {a[:, 0].max():6.2f} {a[:, 1].max():6.2f} {np.median(a[:, 2]):6.2f}")
    a = np.concatenate([np.array(r) for r in rows.values()])
    print(f"\n{len(a)} footprints: placement error ≤ {a[:, 0].max():.3f} m, mesh outside ≤ {a[:, 1].max():.3f} m, "
          f"mesh within 1 m of the rectangle in {np.mean(a[:, 2] < 1):.1%}")
    return 0 if not bad and a[:, 0].max() < 1 and a[:, 1].max() < 1 else 1


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    sys.exit(_check(sys.argv[1] if len(sys.argv) > 1 else "chernarus"))
