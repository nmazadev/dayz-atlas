import L from "leaflet";

/**
 * Thousands of map points (loot, events, spawns) drawn on one canvas.
 *
 * One Leaflet object per point made filtering slow and left tooltips stuck open; here a
 * filter change is a single redraw and hover is a grid lookup feeding one shared tooltip.
 */

export type PointShape = "dot" | "ring" | "badge";

export type Point<T = unknown> = {
  x: number; // world metres (east)
  z: number; // world metres (north)
  shape: PointShape;
  color: string;
  /** Radius in CSS px at the current zoom (badges: half the side). */
  r: number;
  glyph?: string;
  /** Emphasised points (current search) get a halo and draw on top. */
  strong?: boolean;
  data: T;
};

const PAD = 0.35; // canvas overdraw around the viewport, so panning doesn't reveal gaps
const CELL = 24; // hit-test grid cell, px

export class PointsLayer<T> extends L.Layer {
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private points: Point<T>[] = [];
  private origin = L.point(0, 0); // layer-point of the canvas' top-left corner
  private bounds: L.LatLngBounds | null = null;
  private drawnZoom = 0; // zoom the canvas was last laid out at
  private grid = new Map<number, number[]>();
  private screen: Float32Array = new Float32Array(0); // canvas-space x, y per point
  private frame = 0;

  setPoints(points: Point<T>[]) {
    this.points = points;
    this.schedule();
  }

  onAdd(map: L.Map) {
    const pane = map.getPane("points") ?? map.createPane("points");
    pane.style.zIndex = "450";
    this.canvas = L.DomUtil.create("canvas", "atlas-points leaflet-zoom-animated", pane);
    this.ctx = this.canvas.getContext("2d")!;
    this.reset();
    return this;
  }

  onRemove() {
    cancelAnimationFrame(this.frame);
    this.canvas.remove();
    return this;
  }

  getEvents() {
    return {
      moveend: this.reset,
      zoomend: this.reset,
      resize: this.reset,
      viewreset: this.reset,
      zoom: this.followZoom,
      zoomanim: this.animateZoom as L.LeafletEventHandlerFn,
    };
  }

  /** Nearest point under a container pixel, within its radius plus a few px of slack. */
  hit(containerPoint: L.Point): Point<T> | null {
    if (!this._map) return null;
    const lp = this._map.containerPointToLayerPoint(containerPoint).subtract(this.origin);
    const cx = Math.floor(lp.x / CELL), cy = Math.floor(lp.y / CELL);
    let best: Point<T> | null = null;
    let bestD = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const i of this.grid.get(key(cx + dx, cy + dy)) ?? []) {
          const p = this.points[i];
          const d = Math.hypot(this.screen[i * 2] - lp.x, this.screen[i * 2 + 1] - lp.y);
          const reach = p.r + 4;
          if (d <= reach && (d < bestD || (p.strong && !best?.strong))) {
            best = p;
            bestD = d;
          }
        }
      }
    }
    return best;
  }

  private schedule() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.draw());
  }

  private reset = () => {
    if (!this._map) return;
    const map = this._map;
    const size = map.getSize();
    const pad = size.multiplyBy(PAD).round();
    this.origin = map.containerPointToLayerPoint(pad.multiplyBy(-1)).round();
    const full = size.add(pad.multiplyBy(2));
    const dpr = window.devicePixelRatio || 1;
    L.DomUtil.setPosition(this.canvas, this.origin);
    this.canvas.style.width = `${full.x}px`;
    this.canvas.style.height = `${full.y}px`;
    this.canvas.width = Math.round(full.x * dpr);
    this.canvas.height = Math.round(full.y * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const nw = map.layerPointToLatLng(this.origin);
    const se = map.layerPointToLatLng(this.origin.add(full));
    this.bounds = L.latLngBounds(nw, se);
    this.drawnZoom = map.getZoom();
    this.draw();
  };

  private animateZoom = (e: L.ZoomAnimEvent) => this.transformTo(e.center, e.zoom);

  /** Pinch and flyTo fire `zoom` every frame without `zoomanim`: keep the drawn canvas on the map. */
  private followZoom = () => {
    if (this._map) this.transformTo(this._map.getCenter(), this._map.getZoom());
  };

  /** Same approach as L.ImageOverlay: scale the drawn canvas into the view at `zoom` around `center`. */
  private transformTo(center: L.LatLng, zoom: number) {
    if (!this.bounds || !this._map) return;
    const map = this._map as L.Map & {
      _latLngBoundsToNewLayerBounds(b: L.LatLngBounds, zoom: number, center: L.LatLng): L.Bounds;
    };
    // Relative to the drawn zoom: mid-pinch the map's own zoom has already moved on.
    const scale = map.getZoomScale(zoom, this.drawnZoom);
    const offset = map._latLngBoundsToNewLayerBounds(this.bounds, zoom, center).min!;
    L.DomUtil.setTransform(this.canvas, offset, scale);
  }

  private draw() {
    if (!this._map) return;
    const map = this._map;
    const ctx = this.ctx;
    const w = this.canvas.width, h = this.canvas.height;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.restore();

    const pts = this.points;
    this.screen = new Float32Array(pts.length * 2);
    this.grid.clear();
    const zoom = map.getZoom();
    const pixelOrigin = map.getPixelOrigin();
    const crs = map.options.crs!;
    const maxX = w / (window.devicePixelRatio || 1), maxY = h / (window.devicePixelRatio || 1);

    // Project all points, keep the visible ones; strong points are drawn last (on top).
    const order: number[] = [];
    const strong: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const lp = crs.latLngToPoint(L.latLng(p.z, p.x), zoom).subtract(pixelOrigin).subtract(this.origin);
      this.screen[i * 2] = lp.x;
      this.screen[i * 2 + 1] = lp.y;
      if (lp.x < -20 || lp.y < -20 || lp.x > maxX + 20 || lp.y > maxY + 20) continue;
      (p.strong ? strong : order).push(i);
      const k = key(Math.floor(lp.x / CELL), Math.floor(lp.y / CELL));
      let cell = this.grid.get(k);
      if (!cell) this.grid.set(k, (cell = []));
      cell.push(i);
    }

    for (const i of order) this.drawPoint(pts[i], this.screen[i * 2], this.screen[i * 2 + 1]);
    for (const i of strong) this.drawPoint(pts[i], this.screen[i * 2], this.screen[i * 2 + 1]);
  }

  private drawPoint(p: Point<T>, x: number, y: number) {
    const ctx = this.ctx;
    if (p.shape === "badge") {
      const s = p.r;
      ctx.beginPath();
      ctx.roundRect(x - s, y - s, s * 2, s * 2, Math.max(2, s * 0.35));
      ctx.fillStyle = "#151a10";
      ctx.fill();
      ctx.lineWidth = Math.max(1.5, s * 0.2);
      ctx.strokeStyle = p.color;
      ctx.stroke();
      if (p.glyph && s >= 6) {
        ctx.fillStyle = p.color;
        ctx.font = `700 ${Math.round(s * 1.15)}px "Sofia Sans Semi Condensed Variable", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(p.glyph, x, y + s * 0.06);
      }
      return;
    }
    if (p.strong) {
      ctx.beginPath();
      ctx.arc(x, y, p.r + 4, 0, Math.PI * 2);
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath();
    ctx.arc(x, y, p.r, 0, Math.PI * 2);
    if (p.shape === "ring") {
      ctx.fillStyle = "#151a10";
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = p.color;
      ctx.stroke();
    } else {
      ctx.fillStyle = p.color;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgb(10 12 8 / 0.85)";
      ctx.stroke();
    }
  }
}

const key = (x: number, y: number) => (x + 4096) * 8192 + (y + 4096);
