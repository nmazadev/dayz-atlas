import L from "leaflet";
import { CanvasLayer } from "./CanvasLayer";

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

const CELL = 24; // hit-test grid cell, px

export class PointsLayer<T> extends CanvasLayer {
  private points: Point<T>[] = [];
  private grid = new Map<number, number[]>();
  private screen: Float32Array = new Float32Array(0); // canvas-space x, y per point

  constructor() {
    super("points", 450, "atlas-points");
  }

  setPoints(points: Point<T>[]) {
    this.points = points;
    this.schedule();
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

  protected draw(map: L.Map, maxX: number, maxY: number) {
    const pts = this.points;
    this.screen = new Float32Array(pts.length * 2);
    this.grid.clear();
    const zoom = map.getZoom();
    const pixelOrigin = map.getPixelOrigin();
    const crs = map.options.crs!;

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
