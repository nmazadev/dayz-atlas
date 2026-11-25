export type MapMeta = {
  id: string;
  label: string;
  worldSize: number;
};

/** Contents of `tiles.json` next to each tile pyramid, plus where it was found. */
export type TileSource = {
  url: string;
  imageSize: number;
  maxNativeZoom: number;
  hires: boolean;
};

export type Manifest = {
  source: { repo: string; revision: string; license: string };
  maps: MapMeta[];
};

export type LootType = {
  name: string;
  usages: string[];
  cats: string[];
  lootmax: number;
  points: number;
  /** [category mask, tag mask, loot points] per container kind (bit orders in items.json). */
  containers: [number, number, number][];
};

/** Building instance after unpacking the flat `points` array. */
export type LootBuilding = {
  type: LootType;
  x: number;
  z: number;
  /** Bits 0–4: tier zones (Tier1…Unique); bits 5+: usages of the painted area it stands in. */
  tiers: number;
  usage: string;
};

/** A spawnable item from the CE's types.xml (see scripts/build_data.py build_items). */
export type Item = {
  name: string;
  cat: number;
  usages: number;
  tiers: number;
  tags: number;
  /** Target count across the whole map. */
  nominal: number;
  /** Only in dynamic events (heli crashes, convoys), never in buildings. */
  deloot: boolean;
  /** In-game names by language, when extracted from the game. */
  label?: Record<string, string>;
};

export type ItemsData = {
  cats: string[];
  tags: string[];
  usages: string[];
  tiers: string[];
  areaUsages: string[];
  items: Item[];
};

export type EventKind = "heli" | "convoy" | "police" | "train" | "gas" | "crate" | "vehicle" | "boat";
export type MapEvent = { kind: EventKind; name: string; x: number; z: number };
export type GasZone = { name: string; x: number; z: number; r: number };
export type PlaceKind =
  | "capital" | "city" | "town" | "village" | "local" | "camp" | "hill" | "ruin" | "marine" | "military" | "airfield";

/**
 * A map label. Bundled data (no game install) only has city/town/village guessed from
 * building clusters; places extracted from the game carry the in-game names.
 */
export type Place = {
  name: string;
  x: number;
  z: number;
  kind: PlaceKind;
  /** Bases: nearest settlement, shown as "Military base · Tisy". */
  near?: string;
  /** Original spelling when transliterated (Cyrillic on Chernarus). */
  native?: string;
  /** Localised names for the few entries the game translates. */
  i18n?: Record<string, string>;
};

export type MapData = {
  items: ItemsData;
  /** How far from its point each event kind may appear (m). */
  zoneR: Partial<Record<EventKind, number>>;
  buildings: LootBuilding[];
  events: MapEvent[];
  zones: GasZone[];
  spawns: [number, number][];
  places: Place[];
};

export const TIERS = ["Tier1", "Tier2", "Tier3", "Tier4"] as const;

/** Display order; the first match decides a building's colour. */
export const USAGES = [
  "Military",
  "Police",
  "Medic",
  "Firefighter",
  "Prison",
  "Hunting",
  "Industrial",
  "Farm",
  "Office",
  "School",
  "Coast",
  "Town",
  "Village",
  "Historical",
  "Other",
] as const;
export type Usage = (typeof USAGES)[number];

export const CATEGORIES = ["weapons", "clothes", "food", "tools", "containers", "explosives", "books"] as const;
export type Category = (typeof CATEGORIES)[number];

const base = import.meta.env.BASE_URL;

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}data/${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

/**
 * High-resolution tiles live in an optional volume at /tiles/<map>/ (see scripts/make_tiles.py);
 * without it, use the official low-resolution tiles bundled under /data.
 */
type TileInfo = { imageSize: number; maxNativeZoom: number; rev?: string };

/** Tiles are cached for a week under a fixed path; a new build's `rev` makes browsers fetch it. */
const withRev = (url: string, rev?: string) => (rev ? `${url}?v=${rev}` : url);

export type BaseLayer = "satellite" | "topo";
/** Satellite always exists (bundled low-res at worst); topo only with extracted game data. */
export type TileSources = { satellite: TileSource; topo?: TileSource; /** Railway vectors drawn over topo. */ rails?: string };

/** What the optional game-assets volume (/tiles) provides per map; see scripts/extract_game.py. */
type GameIndex = Record<string, Partial<Record<BaseLayer, TileInfo>> & { places?: boolean; /** rails.json revision */ rails?: string }>;
let gameIndex: Promise<GameIndex> | null = null;

const loadGameIndex = (): Promise<GameIndex> =>
  (gameIndex ??= fetch(`${base}tiles/index.json`)
    .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? (r.json() as Promise<GameIndex>) : {}))
    .catch(() => ({})));

export async function resolveTiles(mapId: string): Promise<TileSources> {
  const entry = (await loadGameIndex())[mapId] ?? {};
  const fromVolume = (layer: BaseLayer, { imageSize, maxNativeZoom, rev }: TileInfo): TileSource => ({
    url: withRev(`${base}tiles/${mapId}/${layer}/{z}/{y}/{x}.webp`, rev),
    hires: true,
    imageSize,
    maxNativeZoom,
  });
  const bundled = async (): Promise<TileSource> => {
    const { imageSize, maxNativeZoom, rev } = await getJson<TileInfo>(`${mapId}/tiles/tiles.json`);
    return { url: withRev(`${base}data/${mapId}/tiles/{z}/{y}/{x}.webp`, rev), hires: false, imageSize, maxNativeZoom };
  };
  const satellite = entry.satellite ? fromVolume("satellite", entry.satellite) : await bundled();
  // Layers swap under one projection, so topo must match the satellite's pixel size.
  const topo =
    entry.topo && entry.topo.imageSize === satellite.imageSize && entry.topo.maxNativeZoom === satellite.maxNativeZoom
      ? fromVolume("topo", entry.topo)
      : undefined;
  const rails = topo && entry.rails ? withRev(`${base}tiles/${mapId}/rails.json`, entry.rails) : undefined;
  return { satellite, topo, rails };
}
export const tierOverlayUrl = (mapId: string) => `${base}data/${mapId}/tiers.webp`;

let manifest: Promise<Manifest> | null = null;
export const loadManifest = () => (manifest ??= getJson<Manifest>("maps.json"));

// Start the requests every page needs right away, before React mounts.
loadManifest().catch(() => {});
void loadGameIndex();

/** In-game names from the volume when extracted, otherwise the bundled estimate. */
async function loadPlaces(mapId: string): Promise<Place[]> {
  if ((await loadGameIndex())[mapId]?.places) {
    const res = await fetch(`${base}tiles/${mapId}/places.json`);
    if (res.ok) return res.json() as Promise<Place[]>;
  }
  return getJson<Place[]>(`${mapId}/places.json`);
}

/** In-game item names (scripts/extract_game.py --only items); the bundled file is empty. */
let itemNames: Promise<Record<string, Record<string, string>>> | null = null;
const loadItemNames = (): Promise<Record<string, Record<string, string>>> =>
  (itemNames ??= fetch(`${base}tiles/item-names.json`)
    .then((r) => (r.ok && r.headers.get("content-type")?.includes("json") ? (r.json() as Promise<Record<string, Record<string, string>>>) : {}))
    .catch(() => ({})));

const cache = new Map<string, Promise<MapData>>();

export function loadMapData(mapId: string): Promise<MapData> {
  let p = cache.get(mapId);
  if (!p) {
    p = (async () => {
      const [loot, ev, places, items, names] = await Promise.all([
        getJson<{ types: LootType[]; stride: number; points: number[] }>(`${mapId}/loot.json`),
        getJson<{ events: MapEvent[]; zones: GasZone[]; spawns: [number, number][]; zoneR?: MapData["zoneR"] }>(`${mapId}/events.json`),
        loadPlaces(mapId),
        getJson<Omit<ItemsData, "items"> & { items: [string, number, number, number, number, number, number][] }>(`${mapId}/items.json`),
        loadItemNames(),
      ]);
      const buildings: LootBuilding[] = [];
      for (let i = 0; i < loot.points.length; i += loot.stride) {
        const type = loot.types[loot.points[i]];
        buildings.push({
          type,
          x: loot.points[i + 1],
          z: loot.points[i + 2],
          tiers: loot.points[i + 3],
          usage: USAGES.find((u) => type.usages.includes(u)) ?? "Other",
        });
      }
      const itemsData: ItemsData = {
        ...items,
        items: items.items.map(([name, cat, usages, tiers, tags, nominal, deloot]) => ({
          name, cat, usages, tiers, tags, nominal, deloot: deloot === 1, label: names[name],
        })),
      };
      return { buildings, events: ev.events, zones: ev.zones, spawns: ev.spawns, places, items: itemsData, zoneR: ev.zoneR ?? {} };
    })();
    p.catch(() => cache.delete(mapId));
    cache.set(mapId, p);
  }
  return p;
}
