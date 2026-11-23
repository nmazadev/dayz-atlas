"""In-game item names (English and Spanish) from the game's configs.

Items are config classes under CfgVehicles / CfgWeapons / CfgMagazines, spread over
many PBOs and inheriting from each other; `displayName` is usually a $STR_ key that
the stringtable translates.
"""

from __future__ import annotations

import rapify

ROOTS = ("CfgVehicles", "CfgWeapons", "CfgMagazines")


def collect_classes(config_bins) -> dict[str, dict]:
    """Merge class bodies from every config.bin: name (lower) → {"parent", "displayName"}."""
    classes: dict[str, dict] = {}
    for data in config_bins:
        try:
            root = rapify.parse(data)
        except (ValueError, IndexError):
            continue
        for root_name in ROOTS:
            section = rapify.find_ci(root, root_name)
            if not isinstance(section, dict):
                continue
            for name, body in section.items():
                if not isinstance(body, dict):
                    continue  # extern / delete declarations
                entry = classes.setdefault(name.lower(), {"name": name, "parent": None, "displayName": None})
                if body.get("__parent__"):
                    entry["parent"] = body["__parent__"].lower()
                if isinstance(body.get("displayName"), str) and body["displayName"]:
                    entry["displayName"] = body["displayName"]
    return classes


def display_names(classes: dict[str, dict], wanted: list[str], strings: dict[str, dict[str, str]]) -> dict[str, dict]:
    """class name → {"en": …, "es": …} for the wanted items, following inheritance."""
    out = {}
    for item in wanted:
        cls, seen = classes.get(item.lower()), set()
        while cls and not cls["displayName"] and cls["parent"] and cls["parent"] not in seen:
            seen.add(cls["parent"])
            cls = classes.get(cls["parent"])
        raw = cls["displayName"] if cls else None
        if not raw:
            continue
        if raw.startswith("$STR_"):
            names = strings.get(raw[1:].lower(), {})
        else:
            names = {"en": raw}
        names = {lang: n.strip() for lang, n in names.items() if n and n.strip()}
        if names:
            out[item] = names
    return out
