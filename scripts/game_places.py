"""Place names from the game's own world config (CfgWorlds >> <world> >> Names).

The in-game map labels come from this list: exact positions, the official names
(Cyrillic for Chernarus, transliterated here), and a type per entry. Military bases
appear only as generic "military base" / "airfield" entries, so those get the nearest
settlement as context; bases that only show up in the Central Economy's military loot
are added the same way.
"""

from __future__ import annotations

import csv
import io
import math
import re

import rapify

# Config type → kind used by the web app (decides style and the zoom it appears at).
KINDS = {
    "Capital": "capital",
    "City": "city",
    "Village": "village",
    "Local": "local",
    "LocalOffice": "local",
    "Camp": "camp",
    "Hill": "hill",
    "Ruin": "ruin",
    "Marine": "marine",
    "RailroadStation": "local",
}
SETTLEMENTS = {"capital", "city", "village"}

# Generic labels the engine uses for bases (lower-case, after transliteration).
GENERIC = {"voennaya baza": "military", "aerodrom": "airfield"}
AIRBASE = re.compile(r"^aviatsionnaya baza (.+)$", re.I)

_CYR = dict(zip("абвгдезийклмнопрстуфыэ", "abvgdeziyklmnoprstufye")) | {
    "ё": "yo", "ж": "zh", "х": "kh", "ц": "ts", "ч": "ch", "ш": "sh", "щ": "shch",
    "ъ": "", "ь": "", "ю": "yu", "я": "ya",
}


def transliterate(s: str) -> str:
    """Russian → Latin, matching the spellings players use (Черногорск → Chernogorsk)."""
    s = re.sub(r"ый\b", "y", s)
    s = re.sub(r"ЫЙ\b", "Y", s)
    out = []
    for c in s:
        t = _CYR.get(c.lower())
        out.append(c if t is None else t.capitalize() if c.isupper() else t)
    return "".join(out)


def load_stringtable(csv_bytes: bytes) -> dict[str, dict[str, str]]:
    """STR_key → {"en": …, "es": …} from DayZ's languagecore stringtable.csv."""
    rows = csv.reader(io.StringIO(csv_bytes.decode("utf-8", "replace")))
    header = [h.lower() for h in next(rows)]
    col = {lang: header.index(name) for lang, name in (("en", "english"), ("es", "spanish")) if name in header}
    table = {}
    for row in rows:
        if row and len(row) > max(col.values()):
            table[row[0].lower()] = {lang: row[i] for lang, i in col.items() if row[i]}
    return table


def _nearest(places: list[dict], x: float, z: float) -> dict | None:
    settlements = [p for p in places if p["kind"] in SETTLEMENTS]
    return min(settlements, key=lambda p: math.hypot(p["x"] - x, p["z"] - z), default=None)


def from_config(config_bin: bytes, world: str, strings: dict[str, dict[str, str]]) -> list[dict]:
    worlds = rapify.find_ci(rapify.parse(config_bin), "CfgWorlds")
    names = rapify.find_ci(rapify.find_ci(worlds, world), "Names")
    places, generic = [], []
    for entry in names.values():
        if not isinstance(entry, dict) or not entry.get("name") or entry.get("type") not in KINDS:
            continue
        raw = entry["name"]
        x, z = entry["position"][:2]
        place = {"name": raw, "x": round(x, 1), "z": round(z, 1), "kind": KINDS[entry["type"]]}
        if raw.startswith("$STR_"):
            loc = strings.get(raw[1:].lower(), {})
            place["name"] = loc.get("en") or re.sub(r"(?<=[a-z])(?=[A-Z])", " ", raw.rsplit("_", 1)[-1])
            if loc.get("es") and loc["es"] != place["name"]:
                place["i18n"] = {"es": loc["es"]}
        elif re.search("[а-яА-ЯёЁ]", raw):
            place["name"] = transliterate(raw)
            place["native"] = raw
        latin = place["name"].lower()
        if latin in GENERIC:
            place["kind"] = GENERIC[latin]
            generic.append(place)
        elif m := AIRBASE.match(latin):  # "Aviatsionnaya baza Vybor" = Vybor air base (NWAF)
            place.update(kind="airfield", name="", near=m[1].title())
        places.append(place)
    # Generic base labels carry the nearest settlement instead of a name.
    for p in generic:
        near = _nearest(places, p["x"], p["z"])
        p["name"] = ""
        p["near"] = near["name"] if near else ""
    return places


def add_military_clusters(places: list[dict], buildings, min_buildings: int = 8) -> int:
    """Label military loot clusters that the config leaves unnamed."""
    from build_data import cluster_buildings  # local import: build_data pulls in the CE pipeline

    mil = [(x, z) for _name, usages, x, z in buildings if "Military" in usages]
    bases = [p for p in places if p["kind"] in ("military", "airfield")]
    added = 0
    for c in cluster_buildings(mil, eps=120, min_pts=min_buildings):
        if any(math.hypot(b["x"] - c["x"], b["z"] - c["z"]) < 700 + c["r"] for b in bases):
            continue
        near = _nearest(places, c["x"], c["z"])
        place = {"name": "", "near": near["name"] if near else "", "x": round(c["x"], 1), "z": round(c["z"], 1), "kind": "military"}
        places.append(place)
        bases.append(place)
        added += 1
    return added
