import L from "leaflet";

/**
 * A tile layer whose pyramid has holes (the 3D render: nothing over the sea or open fields).
 * `coverage` has one bit per tile slot at the native zoom (row-major, MSB first, see
 * scripts/render3d.py write_coverage); slots without a tile get an empty element instead of a 404.
 */
export class SparseTileLayer extends L.TileLayer {
  /** Per zoom 0…native, one byte per slot: does a tile exist there. */
  private readonly levels: Uint8Array[] = [];

  constructor(url: string, coverage: ArrayBuffer, options: L.TileLayerOptions & { maxNativeZoom: number }) {
    super(url, options);
    const top = options.maxNativeZoom;
    const bits = new Uint8Array(coverage);
    let n = 1 << top;
    let level = new Uint8Array(n * n);
    for (let i = 0; i < level.length; i++) level[i] = (bits[i >> 3] >> (7 - (i & 7))) & 1;
    this.levels[top] = level;
    // A tile exists where any of its four children does.
    for (let z = top - 1; z >= 0; z--) {
      const child = level;
      const cn = n;
      n >>= 1;
      level = new Uint8Array(n * n);
      for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
          const i = 2 * r * cn + 2 * c;
          level[r * n + c] = child[i] | child[i + 1] | child[i + cn] | child[i + cn + 1];
        }
      }
      this.levels[z] = level;
    }
  }

  createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    // Past the native zoom Leaflet already asks for native tiles and scales them.
    const z = coords.z;
    const level = this.levels[z];
    const n = 1 << z;
    if (level && coords.x >= 0 && coords.y >= 0 && coords.x < n && coords.y < n && level[coords.y * n + coords.x]) {
      return super.createTile(coords, done);
    }
    const empty = document.createElement("div");
    queueMicrotask(() => done(undefined, empty));
    return empty;
  }
}
