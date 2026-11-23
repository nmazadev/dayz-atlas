import type { Item, ItemsData, LootType, MapData, Place } from "./data";

/**
 * "What do you need?": which buildings can spawn a set of items, following the CE's
 * rules — the spot's usage, a container of the item's category (and tag, if any), and
 * a tier zone the item allows.
 */

export type PresetId =
  | "medical" | "food" | "guns" | "ammo" | "base" | "vehicle" | "clothing" | "gas" | "explosives" | "hunting";

type Preset = { id: PresetId; test: (item: Item, cat: string, usages: string[]) => boolean };

/** The item spawns only at the given usage (e.g. medical buildings). */
const onlyAt = (item: Item, usages: string[], usage: string) => item.usages === 1 << usages.indexOf(usage);

const has = (re: RegExp) => (i: Item) => re.test(i.name);

export const PRESETS: Preset[] = [
  {
    id: "medical",
    // Medicine that only spawns at medical sites; the few that also show up in any house
    // (disinfectant, iodine, thermometer) would otherwise light up every town.
    test: (i, _cat, usages) =>
      /Bandage|Morphine|Epinephrine|Saline|BloodBag|BloodTest|Tetracycline|Painkiller|Iodine|Disinfect|Defibrillator|Syringe|StartKit|FirstAid|Antidote|Thermometer/.test(i.name) &&
      onlyAt(i, usages, "Medic"),
  },
  { id: "food", test: (i, cat) => cat === "food" || /Canteen|WaterBottle|Can_|Pot$|Cauldron/.test(i.name) },
  {
    id: "guns",
    test: (i, cat) => cat === "weapons" && !/^Mag_|^Ammo|^AmmoBox|Optic|Scope|Suppressor|Buttstock|Bttstck|Hndgrd|Handguard|Bayonet|Light$|Compensator|Rail/.test(i.name),
  },
  { id: "ammo", test: has(/^Ammo|^AmmoBox|^Mag_/) },
  {
    id: "base",
    test: has(/Nail|Hammer|Hatchet|Saw$|Hacksaw|Shovel|Pliers|WoodenPlank|BarbedWire|MetalWire|CombinationLock|CodeLock|Pickaxe|Rope$|FenceKit|WatchtowerKit|ShelterKit|TerritoryFlagKit|MetalPlate|Lockpick|Tent|CamoNet/),
  },
  {
    id: "vehicle",
    test: has(/Wheel|Tire|SparkPlug|GlowPlug|Battery$|Radiator|HeadlightH7|_Door|_Hood|_Trunk|CanisterGasoline|LugWrench|PipeWrench|Blowtorch|Screwdriver|Wrench$/),
  },
  { id: "clothing", test: (_i, cat) => cat === "clothes" },
  { id: "gas", test: has(/NBC|GasMask|AirborneMask|GP5|Filter|Antidote/) },
  { id: "explosives", test: (_i, cat) => cat === "explosives" },
  { id: "hunting", test: has(/Fishing|Hook|Bait|Worm|Bow$|Arrow|Trap|Snare|HuntingKnife|Knife$|Winchester70|Mosin|SKS|Izh18|Crossbow/) },
];

/** Usage names → bitmask in items.json order. */
export const usageMask = (items: ItemsData, names: string[]) =>
  names.reduce((m, n) => (items.usages.includes(n) ? m | (1 << items.usages.indexOf(n)) : m), 0);

export const presetItems = (items: ItemsData, id: PresetId): Item[] => {
  const preset = PRESETS.find((p) => p.id === id)!;
  return items.items.filter((i) => preset.test(i, items.cats[i.cat], items.usages));
};

// --- Matching ----------------------------------------------------------------

/** Per-building masks precomputed once per map. */
export type BuildingIndex = { usage: Uint32Array; tiers: Uint8Array };

export function indexBuildings(data: MapData): BuildingIndex {
  const { usages, areaUsages } = data.items;
  const usage = new Uint32Array(data.buildings.length);
  const tiers = new Uint8Array(data.buildings.length);
  data.buildings.forEach((b, i) => {
    let m = 0;
    for (const u of b.type.usages) {
      const bit = usages.indexOf(u);
      if (bit >= 0) m |= 1 << bit;
    }
    areaUsages.forEach((u, k) => {
      if (b.tiers & (1 << (5 + k))) m |= 1 << usages.indexOf(u);
    });
    usage[i] = m;
    tiers[i] = b.tiers & 0x1f;
  });
  return { usage, tiers };
}

/**
 * CE rule, part one: the spot's usage and tier zone must suit the item. `only` narrows the
 * usages that count (the "type of place" refinement); 0 means all of them.
 */
const placeFits = (item: Item, usage: number, tiers: number, only = 0) => {
  const u = only ? usage & only : usage;
  if (item.deloot || (only && !u)) return false;
  return (!item.usages || (item.usages & u) !== 0) && (!item.tiers || (item.tiers & tiers) !== 0);
};

/** Part two: a container that takes the item's category (and its tag, if it has one). */
const containerFits = (item: Item, [cats, tags]: LootType["containers"][number]) =>
  (cats & (1 << item.cat)) !== 0 && (!item.tags || (tags & item.tags) !== 0);

export type FinderResult = {
  /** Number of selected items each building can spawn (0 = no match). */
  matches: Uint16Array;
  /** Loot spots per building that can hold at least one selected item. */
  spots: Uint16Array;
  /** A high spot count (90th percentile), to scale highlights against. */
  spotsRef: number;
  /** Matching buildings per usage bit (items.json `usages` order). */
  byUsage: number[];
  total: number;
  /** Selected items that only come from dynamic events. */
  eventOnly: Item[];
  /** Selected items no building can spawn here. */
  nowhere: Item[];
};

export function runFinder(data: MapData, index: BuildingIndex, items: Item[], only = 0): FinderResult {
  const matches = new Uint16Array(data.buildings.length);
  const spots = new Uint16Array(data.buildings.length);
  const found = new Set<Item>();
  // Items with identical spawn rules behave the same everywhere: test each rule once.
  const rules = new Map<string, Item[]>();
  for (const item of items) {
    if (item.deloot) continue;
    const k = `${item.cat}/${item.usages}/${item.tiers}/${item.tags}`;
    rules.set(k, [...(rules.get(k) ?? []), item]);
  }
  const groups = [...rules.values()];
  let total = 0;
  const byUsage = Array.from({ length: data.items.usages.length }, () => 0);
  const used = new Uint8Array(32);
  data.buildings.forEach((b, i) => {
    const containers = b.type.containers;
    used.fill(0, 0, containers.length);
    let n = 0;
    for (const group of groups) {
      const item = group[0];
      if (!placeFits(item, index.usage[i], index.tiers[i], only)) continue;
      let fits = false;
      containers.forEach((c, j) => {
        if (containerFits(item, c)) {
          fits = true;
          used[j] = 1;
        }
      });
      if (fits) {
        n += group.length;
        for (const it of group) found.add(it);
      }
    }
    if (!n) return;
    let s = 0;
    containers.forEach((c, j) => {
      if (used[j]) s += c[2];
    });
    matches[i] = Math.min(n, 65535);
    spots[i] = Math.min(s, 65535);
    total++;
    for (let u = 0; u < byUsage.length; u++) if (index.usage[i] & (1 << u)) byUsage[u]++;
  });
  const sorted = [...spots].filter((v) => v > 0).sort((a, b) => a - b);
  return {
    matches,
    spots,
    spotsRef: sorted[Math.floor(sorted.length * 0.9)] ?? 1,
    byUsage,
    total,
    eventOnly: items.filter((i) => i.deloot),
    nowhere: items.filter((i) => !i.deloot && !found.has(i)),
  };
}

/** Items from the selection that a given building can spawn (for its popup). */
export function itemsIn(items: Item[], data: MapData, index: BuildingIndex, buildingIdx: number, only = 0): Item[] {
  const containers = data.buildings[buildingIdx].type.containers;
  return items.filter(
    (it) => placeFits(it, index.usage[buildingIdx], index.tiers[buildingIdx], only) && containers.some((c) => containerFits(it, c)),
  );
}

// --- Where to look -------------------------------------------------------------

export type Area = { place: Place | null; count: number; spots: number; x: number; z: number };

const AREA_KINDS = new Set(["capital", "city", "town", "village", "military", "airfield"]);

/** Group matching buildings by the nearest named place (within 1.2 km), most loot spots first. */
export function rankAreas(data: MapData, result: FinderResult, limit = 8): Area[] {
  const anchors = data.places.filter((p) => AREA_KINDS.has(p.kind));
  const groups = new Map<Place | null, { count: number; spots: number; sx: number; sz: number }>();
  data.buildings.forEach((b, i) => {
    if (!result.matches[i]) return;
    let best: Place | null = null;
    let bestD = 1200;
    for (const p of anchors) {
      const d = Math.hypot(p.x - b.x, p.z - b.z);
      if (d < bestD) {
        best = p;
        bestD = d;
      }
    }
    const g = groups.get(best) ?? { count: 0, spots: 0, sx: 0, sz: 0 };
    g.count++;
    g.spots += result.spots[i];
    g.sx += b.x;
    g.sz += b.z;
    groups.set(best, g);
  });
  return [...groups.entries()]
    .map(([place, g]) => ({ place, count: g.count, spots: g.spots, x: g.sx / g.count, z: g.sz / g.count }))
    .sort((a, b) => b.spots - a.spots)
    .slice(0, limit);
}

// --- Search ------------------------------------------------------------------

export const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** Classname → readable fallback: "TireRepairKit" → "Tire Repair Kit". */
export const prettyItem = (name: string) =>
  name.replace(/_/g, " ").replace(/(?<=[a-z])(?=[A-Z0-9])/g, " ").replace(/\s+/g, " ").trim();

export const itemLabel = (item: Item, lang: string) => item.label?.[lang] ?? item.label?.en ?? prettyItem(item.name);

export function searchItems(items: Item[], query: string, lang: string, limit = 8): Item[] {
  const q = fold(query.trim());
  if (q.length < 2) return [];
  const scored: [number, Item][] = [];
  for (const item of items) {
    const names = [itemLabel(item, lang), ...Object.values(item.label ?? {}), item.name, prettyItem(item.name)].map(fold);
    let score = -1;
    for (const n of names) {
      if (n === q) score = Math.max(score, 3);
      else if (n.startsWith(q)) score = Math.max(score, 2);
      else if (n.split(/[\s\-_,.()]+/).some((w) => w.startsWith(q))) score = Math.max(score, 1.5);
      else if (n.includes(q)) score = Math.max(score, 1);
    }
    if (score >= 0) scored.push([score + Math.min(item.nominal, 50) / 500, item]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, i]) => i);
}
