#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["python-lzo", "pillow", "numpy"]
# ///
"""Extract map assets from your own DayZ install: satellite and topographic tiles, place names.

    uv run scripts/extract_game.py chernarus                  # → tiles/chernarus/ + tiles/index.json
    uv run scripts/extract_game.py livonia --game /path/to/DayZ
    uv run scripts/extract_game.py chernarus --only places    # one step: satellite | places | topo | items
    uv run scripts/extract_game.py chernarus --list           # only show the segments found

Place names come from the world's config.bin (the list the in-game map uses); see
game_places.py. The terrain's satellite layer ships as overlapping segments (`s_XXX_YYY_lco.paa`) inside
the game's .pbo archives. This script finds them, decodes them (LZO + DXT), works out the
overlap and orientation by itself, stitches them with vips, checks the result against
Bohemia's official low-res map, and cuts the tile pyramid. Needs `vips` and liblzo2.

The textures are Bohemia Interactive's: fine for your own use; they are not covered by the
ADPL-SA licence of the Central Economy data.
"""

from __future__ import annotations

import argparse
import io
import json
import math
import re
import shutil
import struct
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import lzo
from PIL import Image, ImageChops, ImageFilter, ImageStat

sys.path.insert(0, str(Path(__file__).resolve().parent))
import game_items  # noqa: E402
import game_places  # noqa: E402
import topo  # noqa: E402
from build_data import MAPS, ROOT, build_items, build_loot, build_tiles, ensure_ce  # noqa: E402

# Engine world names per map id.
WORLDS = {"chernarus": "chernarusplus", "livonia": "enoch"}
# Class names under CfgWorlds.
CONFIG_CLASS = {"chernarus": "ChernarusPlus", "livonia": "Enoch"}
SEGMENT = re.compile(r"s_(\d{3})_(\d{3})_lco\.paa$")


# --- PBO ---------------------------------------------------------------------

@dataclass
class PboEntry:
    pbo: Path
    name: str
    offset: int
    size: int
    packing: int


def _cstring(f) -> str:
    out = bytearray()
    while (c := f.read(1)) not in (b"", b"\0"):
        out += c
    return out.decode("utf-8", "replace")


def pbo_entries(pbo: Path) -> list[PboEntry]:
    """Read a PBO header. Layout: entries of (name\\0, 5×uint32), an optional "Vers"
    properties entry first, an empty entry to end; file data follows in header order."""
    entries, prefix = [], ""
    with pbo.open("rb") as f:
        while True:
            name = _cstring(f)
            packing, _orig, _res, _ts, size = struct.unpack("<5I", f.read(20))
            if not name:
                if packing == 0x56657273:  # "Vers": key/value strings until an empty key
                    while key := _cstring(f):
                        value = _cstring(f)
                        if key.lower() == "prefix":
                            prefix = value
                    continue
                break
            entries.append(PboEntry(pbo, f"{prefix}\\{name}" if prefix else name, 0, size, packing))
        offset = f.tell()
    for e in entries:
        e.offset = offset
        offset += e.size
    return entries


def read_entry(e: PboEntry) -> bytes:
    if e.packing not in (0,):
        raise ValueError(f"{e.name}: compressed PBO entries are not supported (method {e.packing:#x})")
    with e.pbo.open("rb") as f:
        f.seek(e.offset)
        return f.read(e.size)


# --- PAA ---------------------------------------------------------------------

DXT = {0xFF01: (b"DXT1", 8), 0xFF05: (b"DXT5", 16)}  # fourcc, bytes per 4×4 block


def _dds(fourcc: bytes, w: int, h: int, data: bytes) -> Image.Image:
    """Wrap raw DXT blocks in a minimal DDS header so Pillow can decode them."""
    # magic, 7×uint32, 11 reserved, pixel format (8×uint32), caps + caps2–4 + reserved2 = 128 bytes.
    header = struct.pack(
        "<4s7I44x8II16x",
        b"DDS ", 124, 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000, h, w, len(data), 0, 0,
        32, 0x4, struct.unpack("<I", fourcc)[0], 0, 0, 0, 0, 0,
        0x1000,
    )
    assert len(header) == 128
    return Image.open(io.BytesIO(header + data)).convert("RGB")


def decode_paa(raw: bytes) -> Image.Image:
    """Decode the largest mipmap. PAA: uint16 type, GGAT tags, palette, then mipmaps of
    (uint16 w, uint16 h, uint24 size, data); bit 15 of w marks LZO-compressed DXT data."""
    kind = struct.unpack_from("<H", raw)[0]
    if kind not in DXT:
        raise ValueError(f"unsupported PAA type {kind:#06x}")
    pos = 2
    while raw[pos:pos + 4] == b"GGAT":
        (length,) = struct.unpack_from("<I", raw, pos + 8)
        pos += 12 + length
    (palette,) = struct.unpack_from("<H", raw, pos)
    pos += 2 + palette * 3
    w, h = struct.unpack_from("<HH", raw, pos)
    size = int.from_bytes(raw[pos + 4:pos + 7], "little")
    data = raw[pos + 7:pos + 7 + size]
    fourcc, block = DXT[kind]
    if w & 0x8000:
        w &= 0x7FFF
        data = lzo.decompress(data, False, (w // 4) * (h // 4) * block)
    return _dds(fourcc, w, h, data)


# --- Discovery -----------------------------------------------------------------

def find_game() -> Path | None:
    roots = [Path.home() / p for p in (".local/share/Steam", ".steam/steam",
                                       ".var/app/com.valvesoftware.Steam/.local/share/Steam")]
    libraries = []
    for root in roots:
        vdf = root / "steamapps" / "libraryfolders.vdf"
        if vdf.exists():
            libraries += [Path(p) for p in re.findall(r'"path"\s+"([^"]+)"', vdf.read_text(errors="replace"))]
        libraries.append(root)
    for lib in libraries:
        game = lib / "steamapps" / "common" / "DayZ"
        if (game / "Addons").is_dir():
            return game
    return None


def find_segments(game: Path, world: str) -> dict[tuple[int, int], PboEntry]:
    segments = {}
    for pbo in sorted(game.rglob("*.pbo")):
        if world not in pbo.name.lower() and "world" not in pbo.name.lower():
            continue
        try:
            entries = pbo_entries(pbo)
        except (struct.error, OSError) as err:
            print(f"  skip {pbo.name}: {err}")
            continue
        for e in entries:
            path = e.name.replace("\\", "/").lower()
            # Only the satellite layer: some worlds also ship same-named `usermap/` segments.
            if f"/{world}/" in f"/{path}" and "/layers/" in path and (m := SEGMENT.search(path)):
                segments[(int(m[1]), int(m[2]))] = e
    return segments


# --- Stitching -------------------------------------------------------------------

def _decode_to(args: tuple[PboEntry, Path]) -> tuple[int, int]:
    entry, dest = args
    img = decode_paa(read_entry(entry))
    img.save(dest, compress_level=1)
    return img.size


def _edge_diff(a: Image.Image, b: Image.Image, k: int, horizontal: bool) -> float:
    w, h = a.size
    if horizontal:
        ea, eb = a.crop((w - k, 0, w, h)), b.crop((0, 0, k, h))
    else:
        ea, eb = a.crop((0, h - k, w, h)), b.crop((0, 0, w, k))
    return ImageStat.Stat(ImageChops.difference(ea.convert("L"), eb.convert("L"))).mean[0]


def detect_layout(files: dict[tuple[int, int], Path], size: int) -> tuple[int, bool]:
    """Return (overlap px, first index is the column). Neighbouring segments repeat a
    strip of pixels; find the strip width and the axis where edges actually match."""
    a = Image.open(files[(0, 0)])
    best = (math.inf, 0, True)
    for first_is_x in (True, False):
        b = Image.open(files[(1, 0)])  # neighbour along the first index
        horizontal = first_is_x
        for k in [2**i for i in range(1, int(math.log2(size // 2)) + 1)]:
            d = _edge_diff(a, b, k, horizontal)
            if d < best[0]:
                best = (d, k, first_is_x)
    diff, overlap, first_is_x = best
    print(f"  overlap {overlap} px, first index = {'column' if first_is_x else 'row'} (edge diff {diff:.2f})")
    if diff > 6:
        print("  warning: segment edges do not match cleanly; check the result")
    return overlap, first_is_x


def compare_to_reference(candidate: Path, reference: Path, tmp: Path) -> float:
    """Mean abs difference (0–255) between a stitched image and the official map, both 512 px."""
    small = tmp / "cmp.png"
    subprocess.run(["vips", "thumbnail", str(candidate), str(small), "512", "--size", "force"],
                   check=True, stderr=subprocess.DEVNULL)
    ref = Image.open(reference).convert("L").resize((512, 512), Image.LANCZOS).filter(ImageFilter.GaussianBlur(1.5))
    cand = Image.open(small).convert("L").filter(ImageFilter.GaussianBlur(1.5))
    # Normalise brightness: the satellite and the CE map are graded differently.
    def norm(im):
        s = ImageStat.Stat(im)
        return im.point(lambda v, m=s.mean[0], d=max(s.stddev[0], 1): max(0, min(255, int((v - m) / d * 40 + 128))))
    return ImageStat.Stat(ImageChops.difference(norm(ref), norm(cand))).mean[0]


def stitch(map_id: str, game: Path, workdir: Path) -> Path:
    world = WORLDS[map_id]
    print(f"[{map_id}] scanning {game} for '{world}' satellite segments…")
    segments = find_segments(game, world)
    if not segments:
        raise SystemExit(f"no s_XXX_YYY_lco.paa segments for {world} found under {game}")
    cols = 1 + max(i for i, _ in segments)
    rows = 1 + max(j for _, j in segments)
    print(f"  {len(segments)} segments ({cols}×{rows}) in {len({e.pbo for e in segments.values()})} PBO(s)")
    missing = [(i, j) for i in range(cols) for j in range(rows) if (i, j) not in segments]
    if missing:
        raise SystemExit(f"  missing segments: {missing[:8]}…")

    seg_dir = workdir / "segments"
    seg_dir.mkdir(parents=True, exist_ok=True)
    files = {key: seg_dir / f"{key[0]:03d}_{key[1]:03d}.png" for key in segments}
    todo = [(segments[k], files[k]) for k in segments if not files[k].exists()]
    print(f"  decoding {len(todo)} segments…")
    with ProcessPoolExecutor() as pool:
        sizes = set(pool.map(_decode_to, todo)) | {Image.open(f).size for f in list(files.values())[:1]}
    if len(sizes) != 1:
        raise SystemExit(f"  segments have different sizes: {sizes}")
    size = sizes.pop()[0]
    print(f"  segment size {size} px")

    overlap, first_is_x = detect_layout(files, size)
    stride = size - overlap
    n_across = cols if first_is_x else rows
    n_down = rows if first_is_x else cols
    reference = ROOT / ".cache" / "ce" / "CETool" / MAPS[map_id].cetool / "map.png"

    # Row order (top-down vs bottom-up) is checked against the official map below.
    candidates = []
    for flip in (False, True):
        order = []
        for r in range(n_down):
            rr = n_down - 1 - r if flip else r
            for c in range(n_across):
                order.append(files[(c, rr) if first_is_x else (rr, c)])
        # arrayjoin lays tile k in a stride-wide cell and clips the canvas to n × stride, which is
        # the world. "low" puts each segment at the cell origin; "centre" shifts it back by half
        # the overlap, for segments that start outside the world border.
        side = n_across * stride
        for align in ("low", "centre"):
            out = workdir / f"world{'_flip' if flip else ''}_{align}.v"
            subprocess.run(["vips", "arrayjoin", " ".join(map(str, order)), str(out), "--across", str(n_across),
                            "--hspacing", str(stride), "--vspacing", str(stride),
                            "--halign", align, "--valign", align], check=True, stderr=subprocess.DEVNULL)
            score = compare_to_reference(out, reference, workdir) if reference.exists() else 0.0
            candidates.append((score, out, flip, align, side))
            print(f"  candidate flip={flip} align={align}: {side} px, difference vs official map {score:.1f}")
    score, best, flip, align, side = min(candidates)
    print(f"  using flip={flip} align={align} → {side}×{side} px")
    if reference.exists() and score > 30:
        print("  warning: the result does not resemble the official map; inspect before publishing")
    return best


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("map", choices=list(WORLDS))
    ap.add_argument("--game", type=Path, help="DayZ install folder (auto-detected from Steam)")
    ap.add_argument("--out", type=Path, default=ROOT / "tiles", help="tiles volume root (default: ./tiles)")
    ap.add_argument("--quality", type=int, default=80)
    ap.add_argument("--only", choices=["satellite", "places", "topo", "items"], help="run a single step")
    ap.add_argument("--list", action="store_true", help="only list the segments found")
    args = ap.parse_args()

    game = args.game or find_game()
    if not game:
        print("DayZ install not found; pass --game /path/to/DayZ", file=sys.stderr)
        return 1
    if args.list:
        segs = find_segments(game, WORLDS[args.map])
        for (i, j), e in sorted(segs.items())[:10]:
            print(f"{i:03d} {j:03d}  {e.pbo.name}  {e.name}")
        print(f"{len(segs)} segments")
        return 0

    index_path = args.out / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    entry = index.setdefault(args.map, {})

    if args.only in (None, "satellite"):
        workdir = ROOT / ".cache" / "satellite" / args.map
        workdir.mkdir(parents=True, exist_ok=True)
        image = stitch(args.map, game, workdir)
        entry["satellite"] = build_tiles(image, args.out / args.map / "satellite", args.quality)
        # Intermediates are ~3 GB per map; decoding again takes under a minute.
        shutil.rmtree(workdir)
        print(f"[{args.map}] satellite {entry['satellite']['imageSize']} px, native zoom {entry['satellite']['maxNativeZoom']}")

    if args.only in (None, "places"):
        places = extract_places(args.map, game)
        (args.out / args.map).mkdir(parents=True, exist_ok=True)
        (args.out / args.map / "places.json").write_text(json.dumps(places, ensure_ascii=False, separators=(",", ":")))
        entry["places"] = True

    if args.only in (None, "topo"):
        # Same pixel size as the satellite so both layers share one projection.
        size = entry.get("satellite", {}).get("imageSize", 15360)
        print(f"[{args.map}] rendering topographic map ({size} px)…")
        wrp = next(e for e in pbo_entries(game / "Addons" / f"worlds_{WORLDS[args.map]}.pbo") if e.name.lower().endswith(".wrp"))
        workdir = ROOT / ".cache" / "topo"
        workdir.mkdir(parents=True, exist_ok=True)
        image, rails = topo.render(read_entry(wrp), size, args.out / args.map / "satellite", workdir, log=print)
        (args.out / args.map / "rails.json").write_text(json.dumps(rails, separators=(",", ":")))
        entry["rails"] = format(int(time.time()), "x")  # revision, so the app refetches after a rebuild
        tif = workdir / f"{args.map}.tif"
        image.save(tif)
        del image
        entry["topo"] = build_tiles(tif, args.out / args.map / "topo", args.quality)
        tif.unlink()

    if args.only in (None, "items"):
        extract_item_names(args.map, game, args.out / "item-names.json")

    entry.pop("tiles", None)  # pre-layers index format
    index_path.write_text(json.dumps(index, indent=2, sort_keys=True))
    print(f"[{args.map}] → {args.out / args.map}")
    return 0


def extract_item_names(map_id: str, game: Path, out: Path) -> None:
    """In-game names (en/es) for this map's spawnable items, merged into one shared file."""
    ensure_ce(ROOT / ".cache" / "ce", list(MAPS.values()))
    wanted = [i[0] for i in build_items(ROOT / ".cache" / "ce" / MAPS[map_id].mission)["items"]]
    configs = []
    for pbo in sorted([*game.glob("Addons/*.pbo"), *game.glob("dta/*.pbo")]):
        try:
            configs += [read_entry(e) for e in pbo_entries(pbo) if e.name.lower().endswith("config.bin")]
        except (struct.error, OSError, ValueError):
            continue
    lang = next((e for e in pbo_entries(game / "dta" / "languagecore.pbo") if e.name.lower().endswith("stringtable.csv")), None)
    strings = game_places.load_stringtable(read_entry(lang)) if lang else {}
    names = game_items.display_names(game_items.collect_classes(configs), wanted, strings)
    merged = json.loads(out.read_text()) if out.exists() else {}
    merged.update(names)
    out.write_text(json.dumps(merged, ensure_ascii=False, separators=(",", ":"), sort_keys=True))
    print(f"[{map_id}] item names: {len(names)} of {len(wanted)} items ({len(configs)} configs)")


def extract_places(map_id: str, game: Path) -> list[dict]:
    world = WORLDS[map_id]
    config = next(e for e in pbo_entries(game / "Addons" / f"worlds_{world}.pbo") if e.name.lower().endswith("config.bin"))
    lang = next((e for e in pbo_entries(game / "dta" / "languagecore.pbo") if e.name.lower().endswith("stringtable.csv")), None)
    strings = game_places.load_stringtable(read_entry(lang)) if lang else {}
    places = game_places.from_config(read_entry(config), CONFIG_CLASS[map_id], strings)
    # Bases the config leaves unnamed still show up in the CE's military loot.
    m = MAPS[map_id]
    ensure_ce(ROOT / ".cache" / "ce", list(MAPS.values()))
    _, buildings = build_loot(ROOT / ".cache" / "ce" / m.mission, {}, 1.0)  # no tier masks needed here
    added = game_places.add_military_clusters(places, buildings)
    kinds = {k: sum(p["kind"] == k for p in places) for k in sorted({p["kind"] for p in places})}
    print(f"[{map_id}] {len(places)} places ({added} bases from CE loot): {kinds}")
    return places


if __name__ == "__main__":
    sys.exit(main())
