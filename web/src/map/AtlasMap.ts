import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { bearing, distance, fmtMeters, gridRef, prettyBuilding, type WorldPos } from "../lib/coords";
import { tierOverlayUrl, type BaseLayer, type Category, type EventKind, type Item, type LootBuilding, type MapData, type MapEvent, type MapMeta, type PlaceKind, type TileSources } from "../lib/data";
import { itemLabel, itemsIn, type BuildingIndex, type FinderResult } from "../lib/finder";
import type { Marker } from "../lib/markers";
import type { TFunction } from "i18next";
import { EVENT_STYLE, TIER_STYLE, USAGE_COLOR } from "../lib/style";
import { placeLabel } from "../lib/places";
import { escapeHtml, markerIconHtml } from "./glyphs";
import { PointsLayer, type Point } from "./PointsLayer";

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

/** The current search ("what do you need?"), pushed in by React. */
export type FinderState = { result: FinderResult; items: Item[]; index: BuildingIndex; only: number };

type Hit = { kind: "loot"; idx: number } | { kind: "event"; ev: MapEvent } | { kind: "spawn" };

/** Radius of a contaminated area's gas cloud: the game's default for all of them. */
const GAS_CLOUD_M = 100;

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
  private readonly points = new PointsLayer<Hit>();
  private readonly tooltip: HTMLDivElement;
  private readonly placeGroup = L.layerGroup();
  private readonly gridMajor = L.layerGroup();
  private readonly gridMinor = L.layerGroup();
  private readonly gasGroup = L.layerGroup();
  private readonly dynGasGroup = L.layerGroup();
  private readonly markerGroup = L.layerGroup();
  private readonly measureGroup = L.layerGroup();
  private readonly tierOverlay: L.ImageOverlay;
  private readonly baseLayers = new Map<BaseLayer, L.TileLayer>();
  private base: BaseLayer = "satellite";
  private data: MapData | null = null;
  private layers: LayerState | null = null;
  private finder: FinderState | null = null;
  /** The palette's --accent: search highlights and measuring lines. */
  private accent = "#f0b429";
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

    for (const g of [this.gridMajor, this.gasGroup, this.dynGasGroup, this.points, this.placeGroup, this.markerGroup, this.measureGroup]) {
      g.addTo(this.map);
    }

    // One shared hover tooltip, owned here, so nothing can be left open on the map.
    this.tooltip = L.DomUtil.create("div", "atlas-hover", this.map.getContainer());
    this.tooltip.setAttribute("role", "tooltip");

    if (view) this.map.setView(toLatLng(view), view.zoom);
    else this.fit();

    this.wire();
    this.syncZoomClass();
  }

  // --- Lifecycle -------------------------------------------------------------

  private wire() {
    const m = this.map;
    m.on("mousemove", (e) => {
      this.cb.onCursor(toWorld(e.latlng));
      this.hover(e.containerPoint, e.latlng);
    });
    m.on("mouseout", () => {
      this.cb.onCursor(null);
      this.hideTooltip();
    });
    m.on("movestart zoomstart", () => this.hideTooltip());
    m.on("zoomend", () => {
      this.syncZoomClass();
      this.syncGridDetail();
      this.buildPoints();
    });
    m.on("moveend", () => {
      const c = m.getCenter();
      this.cb.onView({ x: c.lng, z: c.lat, zoom: m.getZoom() });
    });
    m.on("click", (e) => {
      const pos = toWorld(e.latlng);
      if (this.mode === "measure") this.addMeasurePoint(pos);
      else if (this.mode === "marker") this.cb.onPlaceMarker(pos);
      else this.open(this.points.hit(e.containerPoint)?.data);
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
    this.hideTooltip();
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
    this.hideTooltip();
    if (this.data) this.buildPlaces(this.data);
  }

  setData(data: MapData) {
    this.data = data;
    this.finder = null;
    this.buildPlaces(data);
    this.buildZones(data);
    if (this.layers) this.setLayers(this.layers);
  }

  setLayers(next: LayerState) {
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
    toggle(this.dynGasGroup, next.events.has("gas"));
    this.buildPoints();
  }

  /** Palette or theme change: the map's highlights follow the UI accent. */
  setAccent(color: string) {
    if (!color || color === this.accent) return;
    this.accent = color;
    this.buildPoints();
    this.drawMeasure();
  }

  /** Show only the buildings that can hold the searched items (null clears the search). */
  setFinder(finder: FinderState | null) {
    this.finder = finder;
    this.map.closePopup();
    this.buildPoints();
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

  /** Rebuild the canvas point list from data, layer toggles, search and zoom. */
  private buildPoints() {
    const d = this.data, l = this.layers;
    if (!d || !l) return;
    const pts: Point<Hit>[] = [];
    const z = this.map.getZoom();
    const r = this.lootRadius();
    const f = this.finder;

    if (l.spawns) {
      for (const [x, sz] of d.spawns) pts.push({ x, z: sz, shape: "dot", color: "#fde68a", r: 2.6, data: { kind: "spawn" } });
    }
    if (f) {
      // The more loot spots a building has for the search, the bigger its dot.
      const ref = Math.max(1, f.result.spotsRef);
      d.buildings.forEach((b, idx) => {
        const spots = f.result.spots[idx];
        if (!spots) return;
        const size = r + 0.5 + 3.5 * Math.sqrt(Math.min(1, spots / ref));
        pts.push({ x: b.x, z: b.z, shape: "dot", color: this.accent, r: size, strong: true, data: { kind: "loot", idx } });
      });
    } else if (l.loot) {
      d.buildings.forEach((b, idx) => {
        if (AtlasMap.matches(b, l)) {
          pts.push({ x: b.x, z: b.z, shape: "dot", color: USAGE_COLOR[b.usage as keyof typeof USAGE_COLOR], r, data: { kind: "loot", idx } });
        }
      });
    }
    // Event-only search items (heli crash loot) light up the event sites instead.
    const eventSearch = f && f.result.eventOnly.length > 0;
    const badge = z < 2 ? 5 : z < 3 ? 6.5 : 8.5;
    for (const ev of d.events) {
      const searched = eventSearch && (ev.kind === "heli" || ev.kind === "convoy");
      if (!l.events.has(ev.kind) && !searched) continue;
      const style = EVENT_STYLE[ev.kind];
      pts.push(
        style.glyph
          ? { x: ev.x, z: ev.z, shape: "badge", color: searched ? this.accent : style.color, glyph: style.glyph, r: badge, strong: !!searched, data: { kind: "event", ev } }
          : { x: ev.x, z: ev.z, shape: "ring", color: style.color, r: z < 3 ? 3 : 4, data: { kind: "event", ev } },
      );
    }
    this.points.setPoints(pts);
  }

  // --- Hover & popups ----------------------------------------------------------

  private hover(cp: L.Point, ll: L.LatLng) {
    if (this.mode !== "browse") return this.hideTooltip();
    const hit = this.points.hit(cp);
    const html = hit ? this.tooltipHtml(hit.data) : this.zoneTooltip(toWorld(ll));
    this.map.getContainer().classList.toggle("atlas-hovering", !!hit);
    if (!html) return this.hideTooltip();
    this.tooltip.innerHTML = html;
    this.tooltip.style.transform = `translate(${Math.round(cp.x)}px, ${Math.round(cp.y)}px)`;
    this.tooltip.dataset.open = "true";
  }

  private hideTooltip() {
    if (this.tooltip) delete this.tooltip.dataset.open;
    this.map?.getContainer().classList.remove("atlas-hovering");
  }

  private tooltipHtml(hit: Hit): string {
    const t = this.t;
    if (hit.kind === "spawn") return `<b>${t("tooltip.spawn")}</b>`;
    if (hit.kind === "event") {
      const ev = hit.ev;
      const name = ev.kind === "vehicle" || ev.kind === "boat" ? `<span>${escapeHtml(ev.name)}</span>` : "";
      const extra = ev.kind === "gas" ? `<span>${t("tooltip.gasCloud", { cloud: GAS_CLOUD_M, spread: this.data?.zoneR.gas ?? 0 })}</span>` : "";
      return `<b>${escapeHtml(t(`event.${ev.kind}`))}</b>${name}${extra}<span class="num">${gridRef(ev)}</span>`;
    }
    const b = this.data!.buildings[hit.idx];
    const n = this.finder?.result.matches[hit.idx];
    const usage = escapeHtml(t(`usage.${b.usage as keyof typeof USAGE_COLOR}`));
    const detail = n
      ? `<span>${t("tooltip.matches", { count: n })}</span><span>${t("tooltip.spots", { count: this.finder!.result.spots[hit.idx] })}</span>`
      : `<span>${usage}</span>`;
    return `<b>${escapeHtml(prettyBuilding(b.type.name))}</b>${detail}`;
  }

  /** Inside a contaminated zone (static, or a dynamic gas cloud's reach)? */
  private zoneTooltip(p: WorldPos): string | null {
    const d = this.data, l = this.layers;
    if (!d || !l) return null;
    if (l.gas) {
      const z = d.zones.find((z) => distance(z, p) <= z.r);
      if (z) return `<b>${this.t("tooltip.staticGas")}</b><span>${this.t("tooltip.radius", { r: z.r })}</span>`;
    }
    if (l.events.has("gas")) {
      const reach = GAS_CLOUD_M + (d.zoneR.gas ?? 0);
      const ev = d.events.find((e) => e.kind === "gas" && distance(e, p) <= reach);
      if (ev) return `<b>${this.t("event.gas")}</b><span>${this.t("tooltip.gasCloud", { cloud: GAS_CLOUD_M, spread: d.zoneR.gas ?? 0 })}</span>`;
    }
    return null;
  }

  private open(hit: Hit | undefined) {
    if (!hit || hit.kind === "spawn") return;
    this.hideTooltip();
    if (hit.kind === "loot") this.showBuilding(hit.idx);
    else this.showEvent(hit.ev);
  }

  private popup(at: WorldPos, html: string) {
    L.popup({ className: "atlas-popup", maxWidth: 300, offset: [0, -4], autoPanPadding: [24, 24] })
      .setLatLng(toLatLng(at))
      .setContent(html)
      .openOn(this.map);
  }

  private showBuilding(idx: number) {
    const t = this.t;
    const d = this.data!;
    const b: LootBuilding = d.buildings[idx];
    const usages = b.type.usages.length ? b.type.usages : ["Other"];
    const chips = usages
      .map((u) => {
        const key = (u in USAGE_COLOR ? u : "Other") as keyof typeof USAGE_COLOR;
        return `<span class="atlas-chip" style="--c:${USAGE_COLOR[key]}">${t(`usage.${key}`)}</span>`;
      })
      .join("");
    const tiers = TIER_STYLE.filter((_, i) => b.tiers & (1 << i))
      .map((tier) => `<span class="atlas-chip" style="--c:${tier.color}">${tier.label}</span>`)
      .join("");
    const cats = b.type.cats.map((c) => t(`category.${c as Category}`, { defaultValue: c })).join(", ") || "—";
    let found = "";
    if (this.finder) {
      const lang = t("meta.code");
      const items = itemsIn(this.finder.items, d, this.finder.index, idx, this.finder.only);
      const shown = items.slice(0, 8).map((i) => `<li>${escapeHtml(itemLabel(i, lang))}</li>`).join("");
      const more = items.length > 8 ? `<li class="atlas-popup__more">${t("popup.more", { count: items.length - 8 })}</li>` : "";
      found = items.length ? `<p class="atlas-popup__label">${t("popup.canHold")}</p><ul class="atlas-popup__items">${shown}${more}</ul>` : "";
    }
    this.popup(
      b,
      `<div class="atlas-popup__title">${escapeHtml(prettyBuilding(b.type.name))}</div>
       <div class="atlas-popup__chips">${chips}${tiers}</div>
       ${found}
       <dl class="atlas-popup__dl">
         <dt>${t("popup.loot")}</dt><dd>${escapeHtml(cats)}</dd>
         <dt>${t("popup.spawns")}</dt><dd>${t("popup.spawnsValue", { count: b.type.points, max: b.type.lootmax })}</dd>
         <dt>${t("popup.pos")}</dt><dd class="num">${gridRef(b)}</dd>
       </dl>`,
    );
  }

  private showEvent(ev: MapEvent) {
    const t = this.t;
    const rows = [
      ev.kind === "vehicle" || ev.kind === "boat" ? `<dt>${t("popup.model")}</dt><dd>${escapeHtml(ev.name)}</dd>` : "",
      ev.kind === "gas" ? `<dt>${t("popup.cloud")}</dt><dd>${t("tooltip.gasCloud", { cloud: GAS_CLOUD_M, spread: this.data?.zoneR.gas ?? 0 })}</dd>` : "",
      `<dt>${t("popup.pos")}</dt><dd class="num">${gridRef(ev)}</dd>`,
    ].join("");
    this.popup(
      ev,
      `<div class="atlas-popup__title">${escapeHtml(t(`event.${ev.kind}`))}</div>
       <p class="atlas-popup__note">${t(`eventNote.${ev.kind}`)}</p>
       <dl class="atlas-popup__dl">${rows}</dl>`,
    );
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
        fillColor: "#a3e635",
        fillOpacity: 0.2,
        interactive: false,
      }).addTo(this.gasGroup);
    }
    // Dynamic gas: the cloud's size, plus a dashed ring for how far from the point it may sit.
    this.dynGasGroup.clearLayers();
    const spread = data.zoneR.gas ?? 0;
    for (const ev of data.events) {
      if (ev.kind !== "gas") continue;
      L.circle(toLatLng(ev), { radius: GAS_CLOUD_M, color: "#84cc16", weight: 1, fillColor: "#84cc16", fillOpacity: 0.16, interactive: false }).addTo(this.dynGasGroup);
      if (spread) {
        L.circle(toLatLng(ev), { radius: GAS_CLOUD_M + spread, color: "#84cc16", weight: 1.25, dashArray: "5 6", fill: false, interactive: false }).addTo(this.dynGasGroup);
      }
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
      L.polyline(pts.map(toLatLng), { color: this.accent, weight: 2.5, dashArray: "6 6", interactive: false }).addTo(this.measureGroup);
    }
    pts.forEach((p, i) => {
      L.circleMarker(toLatLng(p), { radius: 4, color: "#0b0c0e", weight: 1.5, fillColor: this.accent, fillOpacity: 1, interactive: false }).addTo(this.measureGroup);
      if (i === 0) return;
      const a = pts[i - 1];
      const mid = { x: (a.x + p.x) / 2, z: (a.z + p.z) / 2 };
      L.marker(toLatLng(mid), {
        interactive: false,
        icon: L.divIcon({
          className: "atlas-measure-label",
          html: `<span>${fmtMeters(distance(a, p))}<i>${Math.round(bearing(a, p))}°</i></span>`,
          iconSize: [0, 0],
        }),
      }).addTo(this.measureGroup);
    });
    this.cb.onMeasure([...pts]);
  }
}
