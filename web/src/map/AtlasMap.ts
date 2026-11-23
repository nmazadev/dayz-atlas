import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { bearing, distance, fmtMeters, gridRef, prettyBuilding, type WorldPos } from "../lib/coords";
import { tierOverlayUrl, type Category, type EventKind, type LootBuilding, type MapData, type BaseLayer, type MapMeta, type PlaceKind, type TileSources } from "../lib/data";
import type { Marker } from "../lib/markers";
import type { TFunction } from "i18next";
import { EVENT_STYLE, TIER_STYLE, USAGE_COLOR } from "../lib/style";
import { placeLabel } from "../lib/places";
import { escapeHtml, markerIconHtml } from "./glyphs";

export type LayerState = {
  loot: boolean;
  usages: ReadonlySet<string>;
  /** Empty = no category filter. */
  cats: ReadonlySet<string>;
  /** Tier indexes 0–3. Empty = no tier filter. */
  tiers: ReadonlySet<number>;
  events: ReadonlySet<EventKind>;
  grid: boolean;
  places: boolean;
  tierOverlay: boolean;
  gas: boolean;
  spawns: boolean;
};

export type Mode = "browse" | "measure" | "marker";
export type View = WorldPos & { zoom: number };

export type Callbacks = {
  onCursor: (pos: WorldPos | null) => void;
  onView: (view: View) => void;
  /** Click in "marker" mode, or right-click / long-press in any mode. */
  onPlaceMarker: (pos: WorldPos) => void;
  onMarkerClick: (id: string) => void;
  onMarkerMove: (id: string, pos: WorldPos) => void;
  onMeasure: (points: WorldPos[]) => void;
};

/** Small labels that only show up close. */
const MINOR_PLACES = new Set<PlaceKind>(["local", "camp", "hill", "ruin", "marine"]);
/** Zoom levels allowed past the native resolution (browser upscaling). */
const OVERZOOM = 2;
const toLatLng = (p: WorldPos) => L.latLng(p.z, p.x);
const toWorld = (ll: L.LatLng): WorldPos => ({ x: ll.lng, z: ll.lat });

/** Imperative Leaflet wrapper; React owns state and pushes it in through the setters. */
export class AtlasMap {
  readonly map: L.Map;
  readonly worldSize: number;
  private readonly meta: MapMeta;
  private readonly cb: Callbacks;
  private readonly canvas = L.canvas({ padding: 0.3, tolerance: 4 });
  private readonly lootGroup = L.featureGroup();
  private readonly eventGroups = new Map<EventKind, L.LayerGroup>();
  private readonly placeGroup = L.layerGroup();
  private readonly gridMajor = L.layerGroup();
  private readonly gridMinor = L.layerGroup();
  private readonly gasGroup = L.layerGroup();
  private readonly spawnGroup = L.layerGroup();
  private readonly markerGroup = L.layerGroup();
  private readonly measureGroup = L.layerGroup();
  private readonly tierOverlay: L.ImageOverlay;
  private readonly baseLayers = new Map<BaseLayer, L.TileLayer>();
  private base: BaseLayer = "satellite";
  private data: MapData | null = null;
  private layers: LayerState | null = null;
  private mode: Mode = "browse";
  private measurePts: WorldPos[] = [];
  private highlight: L.Layer | null = null;
  private markerLayers = new Map<string, L.Marker>();
  private t: TFunction;

  constructor(el: HTMLElement, meta: MapMeta, tiles: TileSources, base: BaseLayer, cb: Callbacks, t: TFunction, view?: View) {
    this.t = t;
    this.meta = meta;
    this.worldSize = meta.worldSize;
    this.cb = cb;
    const w = meta.worldSize;
    // One CRS unit = one in-game metre. At the native zoom one screen pixel is one image
    // pixel; the image sits at the top-left of the tile pyramid (vips google layout).
    const native = tiles.satellite;
    const f = native.imageSize / (w * 2 ** native.maxNativeZoom);
    const crs = L.extend({}, L.CRS.Simple, { transformation: new L.Transformation(f, 0, -f, f * w) });
    const maxZoom = native.maxNativeZoom + OVERZOOM;
    const bounds = L.latLngBounds([0, 0], [w, w]);

    this.map = L.map(el, {
      crs,
      minZoom: 0,
      maxZoom,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 90,
      zoomControl: false,
      attributionControl: false,
      maxBounds: bounds.pad(0.3),
      maxBoundsViscosity: 0.7,
      renderer: this.canvas,
      preferCanvas: true,
    });

    // Place names sit above event icons and pins so they stay readable.
    this.map.createPane("labels").style.zIndex = "640";
    this.map.getPane("labels")!.style.pointerEvents = "none";

    for (const [layer, src] of Object.entries(tiles) as [BaseLayer, TileSources["satellite"] | undefined][]) {
      if (!src) continue;
      this.baseLayers.set(
        layer,
        L.tileLayer(src.url, {
          bounds,
          noWrap: true,
          tileSize: 256,
          minZoom: 0,
          maxZoom,
          maxNativeZoom: src.maxNativeZoom,
          keepBuffer: 4,
          className: "atlas-tiles",
        }),
      );
    }

    this.tierOverlay = L.imageOverlay(tierOverlayUrl(meta.id), bounds, { className: "atlas-tier-overlay" });
    this.setBaseLayer(base);

    for (const g of [this.gridMajor, this.gasGroup, this.lootGroup, this.spawnGroup, this.placeGroup, this.markerGroup, this.measureGroup]) {
      g.addTo(this.map);
    }

    if (view) this.map.setView(toLatLng(view), view.zoom);
    else this.fit();

    this.lootGroup.on("click", (e: L.LeafletEvent) => {
      const b = (e as L.LeafletMouseEvent & { layer: { building?: LootBuilding } }).layer.building;
      if (b && this.mode === "browse") this.showBuilding(b);
    });
    this.wire();
    this.syncZoomClass();
  }

  // --- Lifecycle -------------------------------------------------------------

  private wire() {
    const m = this.map;
    m.on("mousemove", (e) => this.cb.onCursor(toWorld(e.latlng)));
    m.on("mouseout", () => this.cb.onCursor(null));
    m.on("zoomend", () => {
      this.syncZoomClass();
      this.syncGridDetail();
      this.syncLootRadius();
    });
    m.on("moveend", () => {
      const c = m.getCenter();
      this.cb.onView({ x: c.lng, z: c.lat, zoom: m.getZoom() });
    });
    m.on("click", (e) => {
      const pos = toWorld(e.latlng);
      if (this.mode === "measure") this.addMeasurePoint(pos);
      else if (this.mode === "marker") this.cb.onPlaceMarker(pos);
    });
    m.on("contextmenu", (e) => this.cb.onPlaceMarker(toWorld(e.latlng)));
  }

  destroy() {
    this.map.remove();
  }

  fit() {
    const w = this.meta.worldSize;
    this.map.fitBounds([[0, 0], [w, w]], { padding: [16, 16] });
  }

  zoomIn = () => this.map.zoomIn();
  zoomOut = () => this.map.zoomOut();
  invalidate = () => this.map.invalidateSize();

  flyTo(pos: WorldPos, zoom?: number) {
    const z = zoom ?? Math.max(this.map.getZoom(), 4.5);
    this.map.flyTo(toLatLng(pos), z, { duration: 0.6 });
    this.highlight?.remove();
    this.highlight = L.marker(toLatLng(pos), {
      interactive: false,
      icon: L.divIcon({ className: "", html: '<div class="atlas-ping"></div>', iconSize: [0, 0] }),
    }).addTo(this.map);
    const h = this.highlight;
    setTimeout(() => {
      if (this.highlight === h) {
        h.remove();
        this.highlight = null;
      }
    }, 2400);
  }

  setMode(mode: Mode) {
    this.mode = mode;
    this.map.getContainer().dataset.mode = mode;
    if (mode !== "measure") this.clearMeasure();
  }

  get hasTopo() {
    return this.baseLayers.has("topo");
  }

  /** Swap the background imagery; the grid switches to dark lines on the light topo map. */
  setBaseLayer(base: BaseLayer) {
    const next = this.baseLayers.has(base) ? base : "satellite";
    for (const [layer, tiles] of this.baseLayers) {
      if (layer === next) tiles.addTo(this.map).bringToBack();
      else tiles.remove();
    }
    const changed = next !== this.base || !this.gridMajor.getLayers().length;
    this.base = next;
    this.map.getContainer().dataset.base = next;
    if (changed) {
      this.gridMajor.clearLayers();
      this.gridMinor.clearLayers();
      this.buildGrid();
    }
  }

  private syncZoomClass() {
    const el = this.map.getContainer();
    el.dataset.zoom = String(Math.floor(this.map.getZoom()));
  }

  // --- Data layers -----------------------------------------------------------

  /** Language change: rebuild the layers whose tooltips carry text. */
  setStrings(t: TFunction) {
    if (t === this.t) return;
    this.t = t;
    this.map.closePopup();
    if (this.data) {
      this.buildEvents(this.data);
      this.buildZones(this.data);
      this.buildPlaces(this.data);
      if (this.layers) this.setLayers(this.layers);
    }
  }

  setData(data: MapData) {
    this.data = data;
    this.buildEvents(data);
    this.buildPlaces(data);
    this.buildZones(data);
    if (this.layers) this.setLayers(this.layers, true);
  }

  setLayers(next: LayerState, force = false) {
    const prev = this.layers;
    this.layers = next;
    const toggle = (layer: L.Layer, on: boolean) => {
      if (on && !this.map.hasLayer(layer)) layer.addTo(this.map);
      else if (!on && this.map.hasLayer(layer)) layer.remove();
    };
    toggle(this.gridMajor, next.grid);
    this.syncGridDetail();
    toggle(this.placeGroup, next.places);
    toggle(this.tierOverlay, next.tierOverlay);
    toggle(this.gasGroup, next.gas);
    toggle(this.spawnGroup, next.spawns);
    for (const [kind, group] of this.eventGroups) toggle(group, next.events.has(kind));

    const lootChanged =
      force || !prev || prev.loot !== next.loot || prev.usages !== next.usages || prev.cats !== next.cats || prev.tiers !== next.tiers;
    if (lootChanged) this.buildLoot();
  }

  /** Buildings passing the current filters (shared with the sidebar counters). */
  static matches(b: LootBuilding, l: LayerState) {
    if (!l.usages.has(b.usage)) return false;
    if (l.cats.size && !b.type.cats.some((c) => l.cats.has(c))) return false;
    if (l.tiers.size && ![...l.tiers].some((t) => b.tiers & (1 << t))) return false;
    return true;
  }

  private lootRadius() {
    const z = this.map.getZoom();
    return z < 2 ? 1.6 : z < 3 ? 2.4 : z < 4 ? 3.4 : z < 5 ? 4.6 : 6;
  }

  private buildLoot() {
    this.lootGroup.clearLayers();
    const l = this.layers;
    if (!this.data || !l?.loot) return;
    const radius = this.lootRadius();
    for (const b of this.data.buildings) {
      if (!AtlasMap.matches(b, l)) continue;
      const color = USAGE_COLOR[b.usage as keyof typeof USAGE_COLOR];
      const cm = L.circleMarker(toLatLng(b), {
        renderer: this.canvas,
        radius,
        stroke: true,
        weight: 1,
        color: "#0b0c0e",
        opacity: 0.85,
        fillColor: color,
        fillOpacity: 0.95,
      }) as L.CircleMarker & { building?: LootBuilding };
      cm.building = b;
      this.lootGroup.addLayer(cm);
    }
  }

  private syncLootRadius() {
    const r = this.lootRadius();
    this.lootGroup.eachLayer((layer) => (layer as L.CircleMarker).setRadius(r));
  }

  private showBuilding(b: LootBuilding) {
    const usages = b.type.usages.length ? b.type.usages : ["Other"];
    const chips = usages
      .map((u) => {
        const key = (u in USAGE_COLOR ? u : "Other") as keyof typeof USAGE_COLOR;
        return `<span class="atlas-chip" style="--c:${USAGE_COLOR[key]}">${this.t(`usage.${key}`)}</span>`;
      })
      .join("");
    const cats = b.type.cats.map((c) => this.t(`category.${c as Category}`, { defaultValue: c })).join(" · ") || "—";
    const tiers = TIER_STYLE.filter((_, i) => b.tiers & (1 << i))
      .map((t) => `<span class="atlas-chip" style="--c:${t.color}">${t.label}</span>`)
      .join("");
    L.popup({ className: "atlas-popup", maxWidth: 280, offset: [0, -2] })
      .setLatLng(toLatLng(b))
      .setContent(
        `<div class="atlas-popup__title">${escapeHtml(prettyBuilding(b.type.name))}</div>
         <div class="atlas-popup__chips">${chips}${tiers}</div>
         <dl class="atlas-popup__dl">
           <dt>${this.t("popup.loot")}</dt><dd>${escapeHtml(cats)}</dd>
           <dt>${this.t("popup.spawns")}</dt><dd>${this.t("popup.spawnsValue", { count: b.type.points, max: b.type.lootmax })}</dd>
           <dt>${this.t("popup.pos")}</dt><dd class="mono">${Math.round(b.x)} / ${Math.round(b.z)} · ${gridRef(b)}</dd>
         </dl>`,
      )
      .openOn(this.map);
  }

  private buildEvents(data: MapData) {
    for (const g of this.eventGroups.values()) g.remove();
    this.eventGroups.clear();
    for (const ev of data.events) {
      let g = this.eventGroups.get(ev.kind);
      if (!g) this.eventGroups.set(ev.kind, (g = L.layerGroup()));
      const style = EVENT_STYLE[ev.kind];
      const tip = `<b>${escapeHtml(this.t(`event.${ev.kind}`))}</b>${ev.kind === "vehicle" || ev.kind === "boat" ? ` · ${escapeHtml(ev.name)}` : ""}<br><span class="mono">${gridRef(ev)}</span>`;
      if (style.glyph) {
        L.marker(toLatLng(ev), {
          icon: L.divIcon({
            className: "",
            html: `<div class="atlas-event" style="--c:${style.color}">${style.glyph}</div>`,
            iconSize: [20, 20],
            iconAnchor: [10, 10],
          }),
        })
          .bindTooltip(tip, { className: "atlas-tooltip", direction: "top", offset: [0, -10] })
          .addTo(g);
      } else {
        L.circleMarker(toLatLng(ev), {
          renderer: this.canvas,
          radius: 4,
          weight: 2,
          color: style.color,
          fillColor: "#0b0c0e",
          fillOpacity: 0.9,
        })
          .bindTooltip(tip, { className: "atlas-tooltip", direction: "top" })
          .addTo(g);
      }
    }
  }

  private buildPlaces(data: MapData) {
    this.placeGroup.clearLayers();
    for (const p of data.places) {
      const minor = MINOR_PLACES.has(p.kind) ? " atlas-place--minor" : "";
      L.marker(toLatLng(p), {
        pane: "labels",
        interactive: false,
        keyboard: false,
        icon: L.divIcon({
          className: `atlas-place atlas-place--${p.kind}${minor}`,
          html: `<span>${escapeHtml(placeLabel(p, this.t))}</span>`,
          iconSize: [0, 0],
        }),
      }).addTo(this.placeGroup);
    }
  }

  private buildZones(data: MapData) {
    this.gasGroup.clearLayers();
    for (const z of data.zones) {
      L.circle(toLatLng(z), {
        radius: z.r,
        color: "#a3e635",
        weight: 1.5,
        dashArray: "4 4",
        fillColor: "#a3e635",
        fillOpacity: 0.18,
        interactive: true,
      })
        .bindTooltip(`<b>${this.t("popup.gasZone")}</b><br>${escapeHtml(z.name)} · r ${z.r} m`, { className: "atlas-tooltip", sticky: true })
        .addTo(this.gasGroup);
    }
    this.spawnGroup.clearLayers();
    for (const [x, z] of data.spawns) {
      L.circleMarker(toLatLng({ x, z }), {
        renderer: this.canvas,
        radius: 3,
        weight: 1,
        color: "#0b0c0e",
        fillColor: "#fde68a",
        fillOpacity: 0.9,
        interactive: false,
      }).addTo(this.spawnGroup);
    }
  }

  private buildGrid() {
    const w = this.meta.worldSize;
    const line = (a: [number, number], b: [number, number], major: boolean) =>
      L.polyline([a, b], {
        interactive: false,
        renderer: this.canvas,
        color: this.base === "topo" ? "#3b3326" : "#ffffff",
        opacity: (major ? 0.22 : 0.08) * (this.base === "topo" ? 1.4 : 1),
        weight: major ? 1 : 0.6,
      });
    for (let v = 0; v <= w; v += 100) {
      const major = v % 1000 === 0;
      const g = major ? this.gridMajor : this.gridMinor;
      line([0, v], [w, v], major).addTo(g);
      line([v, 0], [v, w], major).addTo(g);
    }
  }

  private syncGridDetail() {
    const on = !!this.layers?.grid && this.map.getZoom() >= 4;
    if (on && !this.map.hasLayer(this.gridMinor)) this.gridMinor.addTo(this.map);
    else if (!on && this.map.hasLayer(this.gridMinor)) this.gridMinor.remove();
  }

  // --- User markers ----------------------------------------------------------

  setMarkers(markers: Marker[]) {
    const seen = new Set<string>();
    for (const m of markers) {
      seen.add(m.id);
      const icon = L.divIcon({
        className: "",
        html: markerIconHtml(m.icon, m.color, m.label),
        iconSize: [28, 36],
        iconAnchor: [14, 35],
      });
      const existing = this.markerLayers.get(m.id);
      if (existing) {
        existing.setLatLng(toLatLng(m));
        existing.setIcon(icon);
        continue;
      }
      const layer = L.marker(toLatLng(m), { icon, draggable: true, riseOnHover: true, autoPan: true });
      layer.on("click", () => this.cb.onMarkerClick(m.id));
      layer.on("dragend", () => this.cb.onMarkerMove(m.id, toWorld(layer.getLatLng())));
      layer.addTo(this.markerGroup);
      this.markerLayers.set(m.id, layer);
    }
    for (const [id, layer] of this.markerLayers) {
      if (!seen.has(id)) {
        layer.remove();
        this.markerLayers.delete(id);
      }
    }
  }

  // --- Measuring -------------------------------------------------------------

  private addMeasurePoint(p: WorldPos) {
    this.measurePts.push(p);
    this.drawMeasure();
  }

  undoMeasure() {
    this.measurePts.pop();
    this.drawMeasure();
  }

  clearMeasure() {
    this.measurePts = [];
    this.drawMeasure();
  }

  private drawMeasure() {
    this.measureGroup.clearLayers();
    const pts = this.measurePts;
    if (pts.length > 1) {
      L.polyline(pts.map(toLatLng), { color: "#f0b429", weight: 2.5, dashArray: "6 6", interactive: false }).addTo(this.measureGroup);
    }
    pts.forEach((p, i) => {
      L.circleMarker(toLatLng(p), { radius: 4, color: "#0b0c0e", weight: 1.5, fillColor: "#f0b429", fillOpacity: 1, interactive: false }).addTo(this.measureGroup);
      if (i === 0) return;
      const a = pts[i - 1];
      const mid = { x: (a.x + p.x) / 2, z: (a.z + p.z) / 2 };
      L.marker(toLatLng(mid), {
        interactive: false,
        icon: L.divIcon({
          className: "atlas-measure-label",
          html: `<span>${fmtMeters(distance(a, p))} · ${Math.round(bearing(a, p))}°</span>`,
          iconSize: [0, 0],
        }),
      }).addTo(this.measureGroup);
    });
    this.cb.onMeasure([...pts]);
  }
}
