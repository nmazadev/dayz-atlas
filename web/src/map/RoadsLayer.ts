import L from "leaflet";
import { CanvasLayer } from "./CanvasLayer";

/** Roads by class in world metres (scripts/topo.py → roads.json). */
export type Roads = {
  /** Class → [fill, casing or null, width in metres], in drawing order (minor first). */
  styles: Record<string, [string, string | null, number]>;
  /** Class → polylines, each flat [x1, z1, x2, z2, …]. */
  lines: Record<string, number[][]>;
  /** Road bridge pieces: [ax, az, bx, bz, class, a is an outer end, b is an outer end]. */
  bridges: [number, number, number, number, string, number, number][];
};

/** Narrowest a class gets on screen (px), so tracks and paths stay visible zoomed out. */
const MIN_PX: Record<string, number> = { path: 1, mud: 1.3, grav: 1.6, taxiway: 2, concrete: 1.6, city: 1.8, asf3: 1.8, asf2: 2.4, asf1: 3 };
const MAX_PX = 40;
// Bridge symbol (m): a dark line along each side, a little off the deck, flared at the outer ends.
const BRIDGE_EDGE = "#282624", BRIDGE_GAP = 1.5, BRIDGE_LINE = 1.6, BRIDGE_WING = 6, BRIDGE_JOIN = 2;

type Line = { pts: number[]; minX: number; minZ: number; maxX: number; maxZ: number };

/**
 * The topographic map's road network, drawn as vectors so it stays crisp at any zoom.
 * `part` "bridges" is a second instance above the railways, so road bridges cross over them.
 */
export class RoadsLayer extends CanvasLayer {
  private readonly classes: { name: string; fill: string; casing: string | null; widthM: number; lines: Line[] }[];

  constructor(
    private readonly roads: Roads,
    private readonly part: "roads" | "bridges",
  ) {
    super(part === "roads" ? "roads" : "road-bridges", part === "roads" ? 370 : 390, `atlas-${part === "roads" ? "roads" : "road-bridges"}`);
    this.classes = Object.entries(roads.styles).map(([name, [fill, casing, widthM]]) => ({
      name,
      fill,
      casing,
      widthM,
      lines: (roads.lines[name] ?? []).map(withBounds),
    }));
  }

  protected draw(map: L.Map, maxX: number, maxY: number) {
    const ctx = this.ctx;
    const zoom = map.getZoom();
    const crs = map.options.crs!;
    const shift = map.getPixelOrigin().add(this.origin);
    const toPx = (x: number, z: number) => crs.latLngToPoint(L.latLng(z, x), zoom).subtract(shift);
    const o = toPx(0, 0);
    const pxPerM = toPx(1, 0).x - o.x;
    // CRS.Simple here is a linear map, so world → canvas is a scale and an offset.
    const sx = pxPerM, sy = toPx(0, 1).y - o.y;
    const px = (x: number) => o.x + x * sx;
    const py = (z: number) => o.y + z * sy;
    // Visible world box, with a margin for line widths.
    const m = 50;
    const x0 = (0 - o.x) / sx - m, x1 = (maxX - o.x) / sx + m;
    const z0 = Math.min((0 - o.y) / sy, (maxY - o.y) / sy) - m, z1 = Math.max((0 - o.y) / sy, (maxY - o.y) / sy) + m;
    const widthOf = (name: string, widthM: number) => Math.min(MAX_PX, Math.max(MIN_PX[name] ?? 1.5, widthM * pxPerM));
    if (this.part === "bridges") return this.drawBridges(px, py, pxPerM, widthOf, [x0, x1, z0, z1]);

    const trace = (lines: Line[]) => {
      ctx.beginPath();
      for (const l of lines) {
        if (l.maxX < x0 || l.minX > x1 || l.maxZ < z0 || l.minZ > z1) continue;
        const p = l.pts;
        ctx.moveTo(px(p[0]), py(p[1]));
        for (let i = 2; i < p.length; i += 2) ctx.lineTo(px(p[i]), py(p[i + 1]));
      }
    };
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    // Casing for all classes first, then fills: crossings merge instead of cutting each other.
    for (const c of this.classes) {
      if (!c.casing) continue;
      trace(c.lines);
      ctx.strokeStyle = c.casing;
      ctx.lineWidth = widthOf(c.name, c.widthM) + 2;
      ctx.stroke();
    }
    for (const c of this.classes) {
      trace(c.lines);
      ctx.strokeStyle = c.fill;
      ctx.lineWidth = widthOf(c.name, c.widthM);
      ctx.stroke();
    }
  }

  private drawBridges(
    px: (x: number) => number,
    py: (z: number) => number,
    pxPerM: number,
    widthOf: (name: string, widthM: number) => number,
    [x0, x1, z0, z1]: number[],
  ) {
    const ctx = this.ctx;
    const edge = Math.max(1, BRIDGE_LINE * pxPerM);
    for (const [ax, az, bx, bz, cls, freeA, freeB] of this.roads.bridges) {
      if (Math.max(ax, bx) < x0 || Math.min(ax, bx) > x1 || Math.max(az, bz) < z0 || Math.min(az, bz) > z1) continue;
      const style = this.roads.styles[cls];
      if (!style) continue;
      const width = widthOf(cls, style[2]);
      const A = [px(ax), py(az)], B = [px(bx), py(bz)];
      const len = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1;
      const d = [(B[0] - A[0]) / len, (B[1] - A[1]) / len];
      // Pieces of one bridge don't quite meet: stretch inner ends so the sides run on unbroken.
      const join = BRIDGE_JOIN * pxPerM;
      if (!freeA) {
        A[0] -= d[0] * join;
        A[1] -= d[1] * join;
      }
      if (!freeB) {
        B[0] += d[0] * join;
        B[1] += d[1] * join;
      }
      const n = [-d[1], d[0]];
      ctx.lineCap = "round"; // pieces of one bridge overlap instead of leaving a seam
      ctx.strokeStyle = style[0];
      ctx.lineWidth = width;
      ctx.beginPath();
      ctx.moveTo(A[0], A[1]);
      ctx.lineTo(B[0], B[1]);
      ctx.stroke();
      // Side lines, flared outwards at the bridge's outer ends.
      const off = width / 2 + Math.max(1.5, BRIDGE_GAP * pxPerM);
      const wing = Math.max(4, BRIDGE_WING * pxPerM) / Math.SQRT2;
      ctx.strokeStyle = BRIDGE_EDGE;
      ctx.lineWidth = edge;
      ctx.lineCap = "round";
      ctx.beginPath();
      for (const side of [1, -1]) {
        const p = [A[0] + n[0] * off * side, A[1] + n[1] * off * side];
        const q = [B[0] + n[0] * off * side, B[1] + n[1] * off * side];
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
        if (freeA) {
          ctx.moveTo(p[0], p[1]);
          ctx.lineTo(p[0] + (-d[0] + n[0] * side) * wing, p[1] + (-d[1] + n[1] * side) * wing);
        }
        if (freeB) {
          ctx.moveTo(q[0], q[1]);
          ctx.lineTo(q[0] + (d[0] + n[0] * side) * wing, q[1] + (d[1] + n[1] * side) * wing);
        }
      }
      ctx.stroke();
    }
  }
}

function withBounds(pts: number[]): Line {
  let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    minX = Math.min(minX, pts[i]);
    maxX = Math.max(maxX, pts[i]);
    minZ = Math.min(minZ, pts[i + 1]);
    maxZ = Math.max(maxZ, pts[i + 1]);
  }
  return { pts, minX, minZ, maxX, maxZ };
}
