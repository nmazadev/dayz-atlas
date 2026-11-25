import L from "leaflet";

const PAD = 0.35; // canvas overdraw around the viewport, so panning doesn't reveal gaps

/**
 * One canvas in its own pane, redrawn after each move and kept on the map during zoom
 * animations, pinch and flyTo by scaling the last drawing. Subclasses only draw.
 */
export abstract class CanvasLayer extends L.Layer {
  protected canvas!: HTMLCanvasElement;
  protected ctx!: CanvasRenderingContext2D;
  /** Layer-point of the canvas' top-left corner. */
  protected origin = L.point(0, 0);
  private bounds: L.LatLngBounds | null = null;
  private drawnZoom = 0; // zoom the canvas was last laid out at
  private frame = 0;

  constructor(
    private readonly paneName: string,
    private readonly zIndex: number,
    private readonly className: string,
  ) {
    super();
  }

  onAdd(map: L.Map) {
    const pane = map.getPane(this.paneName) ?? map.createPane(this.paneName);
    pane.style.zIndex = String(this.zIndex);
    this.canvas = L.DomUtil.create("canvas", `${this.className} leaflet-zoom-animated`, pane);
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

  /** Redraw on the next frame (data changed). */
  protected schedule() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.redraw());
  }

  /** Draw onto a cleared canvas; coordinates are layer points minus `origin`, in CSS px. */
  protected abstract draw(map: L.Map, width: number, height: number): void;

  private redraw() {
    if (!this._map) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.restore();
    const dpr = window.devicePixelRatio || 1;
    this.draw(this._map, this.canvas.width / dpr, this.canvas.height / dpr);
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
    this.redraw();
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
}
