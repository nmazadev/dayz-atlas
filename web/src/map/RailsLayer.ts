import L from "leaflet";
import { CanvasLayer } from "./CanvasLayer";

/** Railway segments in world metres, flat [x1, z1, x2, z2, …] (scripts/topo.py → rails.json). */
export type Rails = { track: number[]; joints: number[] };

const WIDTH_M = 3.2; // a track with its sleepers; parallel tracks run ~4.5 m apart
const BLOCK_M = 6; // white block and gap length
const MIN_WIDTH = 3.6, MAX_WIDTH = 14; // px: zoomed out it must still read as a railway
const MIN_BLOCK = 6; // px, so the white blocks stay visible when zoomed out

/**
 * The classic railway symbol, a black line with white blocks along its middle, drawn as
 * vectors so it stays crisp at any zoom and parallel tracks in a yard part as you zoom in.
 */
export class RailsLayer extends CanvasLayer {
  constructor(private readonly rails: Rails) {
    super("rails", 380, "atlas-rails");
  }

  protected draw(map: L.Map, maxX: number, maxY: number) {
    const ctx = this.ctx;
    const zoom = map.getZoom();
    const crs = map.options.crs!;
    const shift = map.getPixelOrigin().add(this.origin);
    const toPx = (x: number, z: number) => crs.latLngToPoint(L.latLng(z, x), zoom).subtract(shift);
    const pxPerM = toPx(1, 0).x - toPx(0, 0).x;
    // True to scale up close; zoomed out the symbol keeps a minimum size (yards merge, as on paper maps).
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, WIDTH_M * pxPerM));

    // Visible segments in canvas px.
    const visible = (flat: number[]) => {
      const out: number[] = [];
      for (let i = 0; i < flat.length; i += 4) {
        const a = toPx(flat[i], flat[i + 1]), b = toPx(flat[i + 2], flat[i + 3]);
        if (Math.max(a.x, b.x) < -width || Math.min(a.x, b.x) > maxX + width) continue;
        if (Math.max(a.y, b.y) < -width || Math.min(a.y, b.y) > maxY + width) continue;
        out.push(a.x, a.y, b.x, b.y);
      }
      return out;
    };
    const track = visible(this.rails.track);
    const joints = visible(this.rails.joints);

    ctx.lineCap = "round";
    ctx.strokeStyle = "#181818";
    ctx.lineWidth = width;
    ctx.beginPath();
    for (const segs of [track, joints]) {
      for (let i = 0; i < segs.length; i += 4) {
        ctx.moveTo(segs[i], segs[i + 1]);
        ctx.lineTo(segs[i + 2], segs[i + 3]);
      }
    }
    ctx.stroke();

    // White blocks, phased by position along the line (not per piece), so the pattern runs on
    // across joints and the blocks of parallel tracks line up.
    const block = Math.max(BLOCK_M * pxPerM, MIN_BLOCK);
    ctx.lineCap = "butt";
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = width * 0.45;
    ctx.setLineDash([block, block]);
    for (let i = 0; i < track.length; i += 4) {
      const ax = track[i], ay = track[i + 1], bx = track[i + 2], by = track[i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1) continue;
      // Distance of the start along this direction, measured from the layer's fixed pixel origin.
      const along = ((ax + shift.x) * (bx - ax) + (ay + shift.y) * (by - ay)) / len;
      ctx.lineDashOffset = along % (2 * block);
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}
