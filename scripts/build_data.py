#!/usr/bin/env python3
"""Build map tiles and JSON layers from Bohemia's official DayZ Central Economy repo.

Source: https://github.com/BohemiaInteractive/DayZ-Central-Economy (ADPL-SA).
Requires `git`, `vips` and `magick` (ImageMagick) on PATH. Python stdlib only.

    python3 scripts/build_data.py                 # all maps, output to web/public/data
    python3 scripts/build_data.py --maps livonia  # one map
    python3 scripts/build_data.py --debug         # also write place-label preview PNGs
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import time
import xml.etree.ElementTree as ET
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CE_REPO = "https://github.com/BohemiaInteractive/DayZ-Central-Economy.git"


@dataclass(frozen=True)
class MapDef:
    id: str
    label: str
    mission: str
    cetool: str
    project: str


MAPS = {
    "chernarus": MapDef("chernarus", "Chernarus", "dayzOffline.chernarusplus", "ChernarusPlus", "chernarusplus.xml"),
    "livonia": MapDef("livonia", "Livonia", "dayzOffline.enoch", "Enoch", "enoch.xml"),
}

TIERS = ["Tier1", "Tier2", "Tier3", "Tier4", "Unique"]
# Bit orders shared with the web app (web/src/lib/finder.ts).
CATS = ["weapons", "clothes", "food", "tools", "containers", "explosives", "books"]
TAGS = ["floor", "ground", "shelves"]
USAGE_BITS = ["Military", "Police", "Medic", "Firefighter", "Prison", "Hunting", "Industrial", "Farm", "Office",
              "School", "Coast", "Town", "Village", "Historical", "Lunapark", "ContaminatedArea", "SeasonalEvent"]
# Usages that come from where a building stands (painted CE areas), not from the building
# itself. Stored per building after the five tier bits.
AREA_USAGES = {"ContaminatedArea": "usgFlg_Paint-Contamination", "Historical": "usgFlg_Paint-Historical",
               "Lunapark": "usgFlg_Paint-Lunapark"}
# Resolution the tier layers are sampled at (the source TGAs are 4096², ~3.75 m/px).
TIER_RES = 1024
TIER_COLORS = {  # overlay RGBA per tier, highest tier painted last
    "Tier1": (74, 222, 128, 70),
    "Tier2": (250, 204, 21, 80),
    "Tier3": (249, 115, 22, 90),
    "Tier4": (239, 68, 68, 105),
}

EVENT_KINDS = {
    "StaticHeliCrash": "heli",
    "StaticMilitaryConvoy": "convoy",
    "StaticPoliceCar": "police",
    "StaticPoliceSituation": "police",
    "StaticTrain": "train",
    "StaticContaminatedArea": "gas",
    "StaticAirplaneCrate": "crate",
    "VehicleCivilianSedan": "vehicle",
    "VehicleSedan02": "vehicle",
    "VehicleHatchback02": "vehicle",
    "VehicleOffroadHatchback": "vehicle",
    "VehicleOffroad02": "vehicle",
    "VehicleTruck01": "vehicle",
    "VehicleTransitBus": "vehicle",
    "VehicleMotorbike": "vehicle",
    "VehicleBoat": "boat",
}

VEHICLE_NAMES = {
    "VehicleCivilianSedan": "Olga 24",
    "VehicleSedan02": "Sarka 120",
    "VehicleHatchback02": "Gunter 2",
    "VehicleOffroadHatchback": "Ada 4x4",
    "VehicleOffroad02": "M1025",
    "VehicleTruck01": "M3S Truck",
    "VehicleTransitBus": "Transit Bus",
    "VehicleMotorbike": "Motorbike",
    "VehicleBoat": "Boat",
}

# --- Place names -------------------------------------------------------------
# The CE files carry town names only inside other identifiers (animal territories,
# traffic groups, spawn bubbles) with inconsistent spelling. Normalise them here.
ALIASES = {
    "chernarus": {
        "Cherno": "Chernogorsk", "Elektro": "Elektrozavodsk", "Electro": "Elektrozavodsk",
        "Novo": "Novodmitrovsk", "Kamy": "Kamyshovo", "Kamishovo": "Kamyshovo",
        "Krasno": "Krasnostav", "Zeleno": "Zelenogorsk", "Severo": "Severograd",
        "Svetlo": "Svetlojarsk", "Svetloyarsk": "Svetlojarsk", "Soln": "Solnichniy",
        "Solnechny": "Solnichniy", "StarySobor": "Stary Sobor", "Stary": "Stary Sobor",
        "NovySobor": "Novy Sobor", "Prigorodky": "Prigorodki", "Dobroye": "Dobroe",
        "Gvozdino": "Gvozdno", "CernayaPolana": "Chernaya Polana", "ChernayaPolana": "Chernaya Polana",
        "Orlovec": "Orlovets", "Myshkino": "Mishkino", "Kamarovo": "Komarovo",
        "Sinistok": "Sinystok", "Nizhnee": "Nizhnoye", "Naezhdino": "Nadezhdino",
        "Shachovka": "Shakhovka", "Ratnoe": "Ratnoye", "NovayaPetrovka": "Novaya Petrovka",
        "VyshnayaDubrovka": "Vyshnaya Dubrovka", "StaryYar": "Stary Yar",
        "Kamensk": "Kamensk", "Topolniki": "Topolniki",
    },
    "livonia": {
        "Gieraltov": "Gieraltow", "Gierlatow": "Gieraltow", "Wrezsc": "Wrzeszcz",
        "Olsanka": "Olszanka", "Stinik": "Sitnik", "karlin": "Karlin", "nadbor": "Nadbor",
        "Rodzanica2": "Rodzanica",
    },
}
# Hints that are not settlements, or are too ambiguous to place.
IGNORE = {
    "Noname", "NonameNW", "NoNameFarms", "NorthFrontier", "NorthWest", "NorthWestFrontier",
    "Test", "HenTest", "WolfTest", "Army", "City", "CityT1", "CityT2", "Firefighter", "Fox",
    "Hare", "Industrial", "IndustrialT1", "IndustrialT2", "Medic", "Police", "Prisoner",
    "Protected", "Religious", "Solitude", "Spooky", "Village", "VillageT1", "VillageT2",
    "VyborAirport", "KrasnostavAirport", "RoztokaRadunin", "Ruins", "ShkolnikCamp",
    "Altar", "VMC", "Rify", "Skalisty", "ThreeValleys", "GreenMountain", "Volchiypik",
    "Kumyrna", "Metalurg", "Pulkovo", "Frontier", "WestFrontier",
}
DIR_SUFFIX = re.compile(r"(?<=[a-z])(N|S|E|W|NE|NW|SE|SW)\d*$")
DIR_PREFIX = re.compile(r"^(North|South|East|West)(?=[A-Z])")
ANIMAL_PREFIX = re.compile(r"^(Pig|Roe|Hen|Wolf|Goat|Sheep|Cow)(?=[A-Z])")


def run(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, **kw)


def ensure_ce(path: Path, maps: list[MapDef]) -> str:
    if not (path / ".git").exists():
        # The full repo is ~750 MB; fetch only the folders these maps need.
        print(f"cloning {CE_REPO} → {path}")
        run(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", CE_REPO, str(path)])
        patterns = []
        for m in maps:
            patterns += [f"/{m.mission}/*", f"/CETool/{m.cetool}/*",
                         # Large files the pipeline never reads; with blob:none they are never fetched.
                         f"!/{m.mission}/areaflags.map", f"!/{m.mission}/mapgroupcluster*"]
        run(["git", "-C", str(path), "sparse-checkout", "set", "--no-cone", *patterns])
    return run(["git", "-C", str(path), "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()


def parse_xml(path: Path) -> ET.Element:
    # Some CE files carry stray text before the XML declaration; parse from the first tag.
    text = path.read_text(encoding="utf-8", errors="replace")
    return ET.fromstring(text[text.index("<"):].encode())


def load_json_lenient(path: Path):
    text = path.read_text(encoding="utf-8")
    text = re.sub(r"//[^\n]*", "", text)
    text = re.sub(r",(\s*[}\]])", r"\1", text)
    return json.loads(text)


def r1(v: float) -> float:
    return round(v, 1)


# --- Tiles & tier layers -----------------------------------------------------

def build_tiles(src: Path, tiles: Path, quality: int = 82) -> dict:
    """Cut `src` into a 256 px Google-layout pyramid plus a `tiles.json` the web app reads.

    vips anchors non-power-of-two images at the top-left of the pyramid, so the app derives
    its projection from `imageSize` and `maxNativeZoom` rather than assuming a full square.
    """
    if tiles.exists():
        shutil.rmtree(tiles)
    tiles.parent.mkdir(parents=True, exist_ok=True)
    width = int(run(["vipsheader", "-f", "width", str(src)], capture_output=True, text=True).stdout)
    height = int(run(["vipsheader", "-f", "height", str(src)], capture_output=True, text=True).stdout)
    if width != height:
        raise SystemExit(f"{src}: expected a square image, got {width}x{height}")
    # `rev` changes on every build; the app adds it to tile URLs so long-cached tiles refresh.
    info = {"imageSize": width, "maxNativeZoom": math.ceil(math.log2(width / 256)), "rev": format(int(time.time()), "x")}
    # Unless the image fills whole tiles at every level, edge tiles get padded; give the
    # image an alpha band so that padding is transparent instead of a white strip.
    padded = width != 256 * 2 ** info["maxNativeZoom"]
    bands = int(run(["vipsheader", "-f", "bands", str(src)], capture_output=True, text=True).stdout)
    source, extra = src, []
    if padded:
        if bands == 3:
            source = tiles.parent / f".{tiles.name}-rgba.v"
            run(["vips", "bandjoin_const", str(src), str(source), "255"], stderr=subprocess.DEVNULL)
        extra = ["--background", "0 0 0 0"]
    try:
        run(["vips", "dzsave", str(source), str(tiles), "--layout", "google", "--tile-size", "256",
             *extra, "--suffix", f".webp[Q={quality}]"], stderr=subprocess.DEVNULL)
    finally:
        if source != src:
            source.unlink(missing_ok=True)
    (tiles / "blank.png").unlink(missing_ok=True)
    (tiles.parent / "vips-properties.xml").unlink(missing_ok=True)
    (tiles / "tiles.json").write_text(json.dumps(info))
    return info


def read_tier_masks(layers: Path, tmp: Path) -> dict[str, bytes]:
    masks = {}
    names = {tier: f"valueFlg_{tier}" for tier in TIERS} | AREA_USAGES
    for tier, layer in names.items():
        tga = layers / f"{layer}.tga"
        if not tga.exists():
            continue
        raw = tmp / f"{tier}.gray"
        run(["magick", str(tga), "-colorspace", "Gray", "-filter", "Box", "-resize",
             f"{TIER_RES}x{TIER_RES}!", "-depth", "8", f"gray:{raw}"])
        masks[tier] = raw.read_bytes()
    return masks


def write_tier_overlay(masks: dict[str, bytes], tmp: Path, out: Path) -> None:
    """Paint one translucent RGBA image with the highest tier on top."""
    px = bytearray(TIER_RES * TIER_RES * 4)
    for tier, (r, g, b, a) in TIER_COLORS.items():
        mask = masks.get(tier)
        if not mask:
            continue
        for i, v in enumerate(mask):
            if v > 127:
                j = i * 4
                px[j:j + 4] = bytes((r, g, b, a))
    raw = tmp / "tiers.rgba"
    raw.write_bytes(px)
    run(["magick", "-size", f"{TIER_RES}x{TIER_RES}", "-depth", "8", f"rgba:{raw}",
         "-define", "webp:lossless=true", str(out / "tiers.webp")])


def tier_bits(masks: dict[str, bytes], world: float, x: float, z: float) -> int:
    """Bits 0–4: tier zones (TIERS); bits 5+: area usages (AREA_USAGES order)."""
    if not masks:
        return 0
    col = min(TIER_RES - 1, max(0, int(x / world * TIER_RES)))
    row = min(TIER_RES - 1, max(0, int((world - z) / world * TIER_RES)))
    i = row * TIER_RES + col
    names = TIERS + list(AREA_USAGES)
    return sum(1 << n for n, name in enumerate(names) if name in masks and masks[name][i] > 127)


# --- Loot --------------------------------------------------------------------

def build_loot(mission: Path, masks: dict[str, bytes], world: float):
    proto = parse_xml(mission / "mapgroupproto.xml")
    types: dict[str, dict] = {}
    for g in proto.iter("group"):
        usages = sorted({u.get("name") for u in g.findall("usage") if u.get("name")})
        cats, tags, points = set(), set(), 0
        containers: dict[tuple[int, int], int] = {}
        for c in g.findall("container"):
            ccats = {x.get("name") for x in c.findall("category") if x.get("name")}
            ctags = {x.get("name") for x in c.findall("tag") if x.get("name")}
            cats |= ccats
            tags |= ctags
            n = len(c.findall("point"))
            points += n
            if n:
                k = (mask(ccats, CATS), mask(ctags, TAGS))
                containers[k] = containers.get(k, 0) + n
        if not points:
            continue
        types[g.get("name")] = {
            "name": g.get("name"),
            "usages": usages,
            "cats": sorted(cats),
            "lootmax": int(g.get("lootmax", 0) or 0),
            "points": points,
            # [category mask, tag mask, loot points] per container kind; decides which items
            # can spawn here and how many spots they get.
            "containers": sorted([c, t, n] for (c, t), n in containers.items()),
        }

    pos = parse_xml(mission / "mapgrouppos.xml")
    index: dict[str, int] = {}
    type_list: list[dict] = []
    flat: list[float] = []
    buildings = []
    for g in pos.iter("group"):
        name = g.get("name")
        t = types.get(name)
        if not t:
            continue
        x, _, z = (float(v) for v in g.get("pos").split())
        if name not in index:
            index[name] = len(type_list)
            type_list.append(t)
        flat += [index[name], r1(x), r1(z), tier_bits(masks, world, x, z)]
        buildings.append((name, t["usages"], x, z))
    return {"types": type_list, "stride": 4, "points": flat}, buildings


def mask(names, order: list[str]) -> int:
    return sum(1 << order.index(n) for n in names if n in order)


def build_items(mission: Path) -> dict:
    """Spawnable items from types.xml with the fields the CE matches against loot spots."""
    items = []
    for t in parse_xml(mission / "db" / "types.xml").iter("type"):
        cat = t.find("category")
        nominal = int((t.findtext("nominal") or "0").strip() or 0)
        if cat is None or cat.get("name") not in CATS or nominal <= 0:
            continue
        flags = t.find("flags")
        deloot = flags is not None and flags.get("deloot") == "1"
        items.append([
            t.get("name"),
            CATS.index(cat.get("name")),
            mask({u.get("name") for u in t.findall("usage")}, USAGE_BITS),
            mask({v.get("name") for v in t.findall("value")}, TIERS),
            mask({g.get("name") for g in t.findall("tag")}, TAGS),
            nominal,
            1 if deloot else 0,  # only in dynamic events (heli crashes, convoys)
        ])
    items.sort(key=lambda i: i[0].lower())
    return {"cats": CATS, "tags": TAGS, "usages": USAGE_BITS, "tiers": TIERS, "areaUsages": list(AREA_USAGES),
            "fields": ["name", "cat", "usages", "tiers", "tags", "nominal", "deloot"], "items": items}


# --- Events ------------------------------------------------------------------

def build_events(mission: Path):
    root = parse_xml(mission / "cfgeventspawns.xml")
    events = []
    zone_r: dict[str, float] = {}
    for ev in root.iter("event"):
        name = ev.get("name")
        kind = EVENT_KINDS.get(name)
        if not kind:
            continue
        zone = ev.find("zone")
        if zone is not None and zone.get("r"):
            zone_r[kind] = max(zone_r.get(kind, 0), float(zone.get("r")))
        for p in ev.findall("pos"):
            events.append({
                "kind": kind,
                "name": VEHICLE_NAMES.get(name, name),
                "x": r1(float(p.get("x"))),
                "z": r1(float(p.get("z"))),
            })

    zones = []
    effect = mission / "cfgEffectArea.json"
    if effect.exists():
        for area in load_json_lenient(effect).get("Areas", []):
            d = area.get("Data", {})
            pos = d.get("Pos") or [0, 0, 0]
            zones.append({"name": area.get("AreaName", ""), "x": r1(pos[0]), "z": r1(pos[2]),
                          "r": d.get("Radius", 0)})

    spawns = []
    sp = mission / "cfgplayerspawnpoints.xml"
    if sp.exists():
        fresh = parse_xml(sp).find("fresh")
        if fresh is not None:
            for p in fresh.iter("pos"):
                spawns.append([r1(float(p.get("x"))), r1(float(p.get("z")))])
    # zoneR: how far from its point an event may actually appear, per kind.
    return {"events": events, "zones": zones, "spawns": spawns, "zoneR": zone_r}


# --- Places ------------------------------------------------------------------

def normalise_hint(raw: str, aliases: dict[str, str]) -> tuple[str, float] | None:
    """Turn e.g. 'Cattle_ChernogorskNW' into ('Chernogorsk', 0.5). Weight is lower when
    the identifier says the point lies to one side of the settlement."""
    # Identifiers look like "Cattle_BerezinoS" or "Train_Abandoned_Sitnik": the place is last.
    name = ANIMAL_PREFIX.sub("", raw.split("_")[-1].strip())
    weight = 1.0
    if DIR_PREFIX.match(name):
        name, weight = DIR_PREFIX.sub("", name), 0.7
    stripped = DIR_SUFFIX.sub("", name)
    if stripped != name:
        name, weight = stripped, 0.5
    name = re.sub(r"\d+$", "", name)
    if len(name) < 3 or name.startswith("Territory") or name in IGNORE or name.removesuffix("T") in IGNORE:
        return None
    name = aliases.get(name, name)
    if " " not in name:
        name = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name)
    return name, weight


def collect_hints(mission: Path, project: Path, aliases: dict[str, str]):
    hints: list[tuple[str, float, float, float]] = []

    def add(raw, x, z, w=1.0):
        h = normalise_hint(raw, aliases)
        if h:
            hints.append((h[0], float(x), float(z), h[1] * w))

    for terr in parse_xml(project).iter("territory"):
        for zone in terr.findall("zone"):
            # Animal territories sit on the fields around a settlement, so they only nudge.
            add(terr.get("name"), zone.get("x"), zone.get("z"), 0.25)
    for p in parse_xml(mission / "cfgeventspawns.xml").iter("pos"):
        if p.get("group"):
            add(p.get("group"), p.get("x"), p.get("z"), 1.0)
    sp = mission / "cfgplayerspawnpoints.xml"
    if sp.exists():
        for g in parse_xml(sp).iter("group"):
            for p in g.findall("pos"):
                add(g.get("name"), p.get("x"), p.get("z"), 1.0)
    return list(dict.fromkeys(hints))  # some groups list the same position twice


def cluster_buildings(points: list[tuple[float, float]], eps: float = 75.0, min_pts: int = 5):
    """Grid-accelerated single-linkage clustering of building positions."""
    grid: dict[tuple[int, int], list[int]] = defaultdict(list)
    for i, (x, z) in enumerate(points):
        grid[(int(x // eps), int(z // eps))].append(i)
    label = [-1] * len(points)
    clusters = []
    for start in range(len(points)):
        if label[start] != -1:
            continue
        label[start] = len(clusters)
        stack, members = [start], []
        while stack:
            i = stack.pop()
            members.append(i)
            x, z = points[i]
            gx, gz = int(x // eps), int(z // eps)
            for dx in (-1, 0, 1):
                for dz in (-1, 0, 1):
                    for j in grid.get((gx + dx, gz + dz), ()):
                        if label[j] == -1 and (points[j][0] - x) ** 2 + (points[j][1] - z) ** 2 <= eps * eps:
                            label[j] = label[start]
                            stack.append(j)
        clusters.append(members)
    out = []
    for members in clusters:
        if len(members) < min_pts:
            continue
        xs = [points[i][0] for i in members]
        zs = [points[i][1] for i in members]
        cx, cz = sum(xs) / len(xs), sum(zs) / len(zs)
        radius = max(math.hypot(x - cx, z - cz) for x, z in zip(xs, zs))
        out.append({"x": cx, "z": cz, "n": len(members), "r": radius})
    return out


def build_places(buildings, hints):
    homes = [(x, z) for name, usages, x, z in buildings
             if {"Town", "Village"} & set(usages) or "House" in name]
    clusters = cluster_buildings(homes)

    by_name: dict[str, list[tuple[float, float, float]]] = defaultdict(list)
    for name, x, z, w in hints:
        by_name[name].append((x, z, w))

    candidates = []
    for name, pts in by_name.items():
        wsum = sum(w for *_, w in pts)
        hx = sum(x * w for x, _, w in pts) / wsum
        hz = sum(z * w for _, z, w in pts) / wsum
        for ci, c in enumerate(clusters):
            d = math.hypot(c["x"] - hx, c["z"] - hz)
            if d > 650 + c["r"]:
                continue
            # Every hint near the cluster votes, so a town wins its own houses even when
            # hints for neighbours spill into it.
            votes = sum(w for x, z, w in pts if math.hypot(c["x"] - x, c["z"] - z) < c["r"] + 450)
            if votes <= 0:
                continue
            score = votes * c["n"] ** 0.75 / (1 + d / 250)
            candidates.append((score, name, ci, wsum))

    places, used_names, used_clusters = [], set(), set()
    for score, name, ci, wsum in sorted(candidates, reverse=True):
        if name in used_names or ci in used_clusters:
            continue
        used_names.add(name)
        used_clusters.add(ci)
        c = clusters[ci]
        kind = "city" if c["n"] >= 120 else "town" if c["n"] >= 35 else "village"
        places.append({"name": name, "x": r1(c["x"]), "z": r1(c["z"]), "kind": kind})
    places.sort(key=lambda p: p["name"])
    return places, clusters


def debug_preview(map_png: Path, world: float, places, clusters, out: Path) -> None:
    size = 2048
    draws = []
    for c in clusters:
        x, y = c["x"] / world * size, (world - c["z"]) / world * size
        draws += ["-fill", "none", "-stroke", "#22d3ee", "-draw",
                  f"circle {x:.0f},{y:.0f} {x + max(4, c['r'] / world * size):.0f},{y:.0f}"]
    for p in places:
        x, y = p["x"] / world * size, (world - p["z"]) / world * size
        draws += ["-stroke", "none", "-fill", "#facc15", "-pointsize", "18",
                  "-annotate", f"+{x + 6:.0f}+{y:.0f}", p["name"],
                  "-draw", f"circle {x:.0f},{y:.0f} {x + 4:.0f},{y:.0f}"]
    run(["magick", str(map_png), "-resize", f"{size}x{size}", *draws, str(out)])


# --- Main --------------------------------------------------------------------

def build_map(m: MapDef, ce: Path, out_root: Path, tmp: Path, debug: bool) -> dict:
    mission, tool = ce / m.mission, ce / "CETool" / m.cetool
    out = out_root / m.id
    world = float(parse_xml(tool / m.project).find("global/world").get("size"))
    print(f"[{m.id}] world {world:.0f} m")

    print(f"[{m.id}] tiles")
    build_tiles(tool / "map.png", out / "tiles")

    print(f"[{m.id}] tier layers")
    masks = read_tier_masks(tool / "layers", tmp)
    write_tier_overlay(masks, tmp, out)

    print(f"[{m.id}] loot")
    loot, buildings = build_loot(mission, masks, world)
    print(f"[{m.id}] events")
    events = build_events(mission)
    print(f"[{m.id}] places")
    hints = collect_hints(mission, tool / m.project, ALIASES.get(m.id, {}))
    places, clusters = build_places(buildings, hints)

    items = build_items(mission)
    for name, data in (("loot", loot), ("events", events), ("places", places), ("items", items)):
        (out / f"{name}.json").write_text(json.dumps(data, separators=(",", ":")))
    if debug:
        debug_preview(tool / "map.png", world, places, clusters, tmp.parent / f"debug-{m.id}.png")
        print(f"[{m.id}] debug preview → {tmp.parent / f'debug-{m.id}.png'}")

    print(f"[{m.id}] {len(loot['points']) // loot['stride']} loot buildings, "
          f"{len(events['events'])} events, {len(events['zones'])} gas zones, {len(places)} places, "
          f"{len(items['items'])} items")
    return {"id": m.id, "label": m.label, "worldSize": world}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--ce", type=Path, default=ROOT / ".cache" / "ce", help="Central Economy checkout")
    ap.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "data")
    ap.add_argument("--maps", nargs="*", default=list(MAPS), choices=list(MAPS))
    ap.add_argument("--debug", action="store_true", help="write place-label preview PNGs to .cache/")
    args = ap.parse_args()

    for tool in ("git", "vips", "magick"):
        if not shutil.which(tool):
            print(f"missing required tool: {tool}", file=sys.stderr)
            return 1

    rev = ensure_ce(args.ce, [MAPS[m] for m in MAPS])
    tmp = ROOT / ".cache" / "tmp"
    tmp.mkdir(parents=True, exist_ok=True)
    args.out.mkdir(parents=True, exist_ok=True)

    manifest_path = args.out / "maps.json"
    existing = json.loads(manifest_path.read_text())["maps"] if manifest_path.exists() else []
    built = {m["id"]: m for m in existing}
    for map_id in args.maps:
        built[map_id] = build_map(MAPS[map_id], args.ce, args.out, tmp, args.debug)

    manifest = {
        "source": {"repo": CE_REPO.removesuffix(".git"), "revision": rev, "license": "ADPL-SA"},
        "maps": [built[k] for k in MAPS if k in built],
    }
    manifest_path.write_text(json.dumps(manifest, indent=2))
    print(f"wrote {manifest_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
