import { Layers, Locate, MapPin, Mountain, Satellite, Maximize2, Minus, Moon, PanelLeftClose, Plus, Ruler, Search, Sun, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bearing, distance, fmtMeters, gridRef, type WorldPos } from "./lib/coords";
import { hideBoot } from "./lib/boot";
import { loadManifest, loadMapData, resolveTiles, USAGES, type BaseLayer, type EventKind, type Manifest, type MapData } from "./lib/data";
import { decodeMarkers, encodeMarkers, newId, sameMarker, useMarkers, type Marker } from "./lib/markers";
import { useTranslation } from "react-i18next";
import { readJson, writeJson } from "./lib/storage";
import { MARKER_COLORS } from "./lib/style";
import { AtlasMap, type Callbacks, type LayerState, type Mode, type View } from "./map/AtlasMap";
import { GridRulers } from "./ui/GridRulers";
import { LanguageMenu } from "./ui/LanguageMenu";
import { PALETTES, PaletteMenu, type Palette } from "./ui/PaletteMenu";
import { FinderPanel, type FinderSelection } from "./ui/FinderPanel";
import { LayersPanel } from "./ui/LayersPanel";
import { indexBuildings, presetItems, rankAreas, runFinder, usageMask } from "./lib/finder";
import { MarkerEditor } from "./ui/MarkerEditor";
import { MarkersPanel } from "./ui/MarkersPanel";
import { cx, IconButton, Panel } from "./ui/primitives";
import { SearchDialog } from "./ui/SearchDialog";

// --- Persisted layer state ---------------------------------------------------

type StoredLayers = Omit<LayerState, "usages" | "cats" | "tiers" | "events"> & {
  usages: string[];
  cats: string[];
  tiers: number[];
  events: EventKind[];
};

const DEFAULT_LAYERS: StoredLayers = {
  loot: true,
  usages: ["Military", "Police", "Medic", "Firefighter", "Prison", "Hunting"],
  cats: [],
  tiers: [],
  events: ["heli", "convoy", "train"],
  grid: true,
  places: true,
  tierOverlay: false,
  gas: true,
  spawns: false,
};

const hydrate = (s: StoredLayers): LayerState => ({
  ...s,
  usages: new Set(s.usages.filter((u) => (USAGES as readonly string[]).includes(u))),
  cats: new Set(s.cats),
  tiers: new Set(s.tiers),
  events: new Set(s.events),
});
const dehydrate = (l: LayerState): StoredLayers => ({
  ...l,
  usages: [...l.usages],
  cats: [...l.cats],
  tiers: [...l.tiers],
  events: [...l.events],
});

// --- URL hash: #map=chernarus&x=4465&z=2461&zoom=4&m=<shared markers> --------

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const num = (k: string) => (p.has(k) && Number.isFinite(Number(p.get(k))) ? Number(p.get(k)) : undefined);
  const x = num("x"), z = num("z"), zoom = num("zoom");
  return {
    map: p.get("map") ?? undefined,
    view: x !== undefined && z !== undefined && zoom !== undefined ? { x, z, zoom } : undefined,
    shared: p.get("m") ?? undefined,
  };
}

const viewHash = (mapId: string, v: View) => `map=${mapId}&x=${Math.round(v.x)}&z=${Math.round(v.z)}&zoom=${+v.zoom.toFixed(2)}`;

type Theme = "dark" | "light";
type Tab = "finder" | "layers" | "markers";
type Editing = { marker: Marker; isNew: boolean } | null;

export default function App() {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const initialHash = useRef(readHash());
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mapId, setMapId] = useState<string>(() => initialHash.current.map ?? readJson("atlas:map", "chernarus"));
  const [data, setData] = useState<MapData | null>(null);
  const [atlas, setAtlas] = useState<AtlasMap | null>(null);
  const [layers, setLayers] = useState<LayerState>(() => hydrate({ ...DEFAULT_LAYERS, ...readJson<Partial<StoredLayers>>("atlas:layers", {}) }));
  const [mode, setMode] = useState<Mode>("browse");
  const [base, setBase] = useState<BaseLayer>(() => readJson<BaseLayer>("atlas:base", "satellite"));
  const baseRef = useRef(base);
  baseRef.current = base;
  const [cursor, setCursor] = useState<WorldPos | null>(null);
  const [measure, setMeasure] = useState<WorldPos[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 768);
  const [tab, setTab] = useState<Tab>("finder");
  const [finderSel, setFinderSel] = useState<FinderSelection>({ preset: null, items: [], places: [] });
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme as Theme) ?? "dark");
  const [palette, setPalette] = useState<Palette>(() => {
    const p = document.documentElement.dataset.palette as Palette | undefined;
    return p && PALETTES.includes(p) ? p : "graphite";
  });
  const [toast, setToast] = useState<string | null>(null);
  const [pendingShare, setPendingShare] = useState<{ mapId: string; markers: Marker[] } | null>(null);
  const mapEl = useRef<HTMLDivElement>(null);

  const meta = manifest?.maps.find((m) => m.id === mapId) ?? manifest?.maps[0];
  const { markers, add, update, remove, replaceAll } = useMarkers(meta?.id ?? mapId);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast((t) => (t === msg ? null : t)), 2600);
  }, []);

  // Manifest + shared-link payload.
  useEffect(() => {
    loadManifest().then(setManifest, (e: Error) => setError(e.message));
    const { shared, map } = initialHash.current;
    if (shared) {
      decodeMarkers(shared).then(
        (ms) => setPendingShare({ mapId: map ?? "chernarus", markers: ms }),
        () => flash(tRef.current("share.broken")),
      );
    }
  }, [flash]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    // Stored raw (not JSON) so the inline script in index.html can apply it before first paint.
    try {
      localStorage.setItem("atlas:theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => writeJson("atlas:layers", dehydrate(layers)), [layers]);
  useEffect(() => writeJson("atlas:map", mapId), [mapId]);

  // Latest handlers for the map without recreating it.
  const handlers = useRef<Pick<Callbacks, "onPlaceMarker" | "onMarkerClick" | "onMarkerMove">>(null!);
  handlers.current = {
    onPlaceMarker: (pos) => {
      setEditing({ marker: { id: newId(), ...pos, label: "", color: MARKER_COLORS[0], icon: "pin" }, isNew: true });
      setMode("browse");
    },
    onMarkerClick: (id) => {
      const m = markers.find((x) => x.id === id);
      if (m) setEditing({ marker: m, isNew: false });
    },
    onMarkerMove: (id, pos) => update(id, pos),
  };

  // (Re)create the Leaflet map when the selected map changes.
  useEffect(() => {
    if (!meta || !mapEl.current) return;
    const el = mapEl.current;
    const first = initialHash.current.view && initialHash.current.map === meta.id ? initialHash.current.view : undefined;
    let live = true;
    let a: AtlasMap | null = null;
    setData(null);
    // The projection depends on which tile pyramid is available (hi-res volume or bundled).
    resolveTiles(meta.id).then(
      (tiles) => {
        if (!live) return;
        initialHash.current.view = undefined;
        a = new AtlasMap(
          el,
          meta,
          tiles,
          baseRef.current,
          {
            onCursor: setCursor,
            onView: (v) => history.replaceState(null, "", `#${viewHash(meta.id, v)}`),
            onMeasure: setMeasure,
            onPlaceMarker: (p) => handlers.current.onPlaceMarker(p),
            onMarkerClick: (id) => handlers.current.onMarkerClick(id),
            onMarkerMove: (id, p) => handlers.current.onMarkerMove(id, p),
          },
          tRef.current,
          first,
        );
        setAtlas(a);
      },
      (e: Error) => live && setError(e.message),
    );
    loadMapData(meta.id).then(
      (d) => live && setData(d),
      (e: Error) => live && setError(e.message),
    );
    return () => {
      live = false;
      a?.destroy();
      setAtlas(null);
    };
  }, [meta]);

  useEffect(() => {
    if (!atlas || !data) return;
    atlas.setData(data);
    // First map on screen: let the boot screen hand over once the imagery is in.
    void atlas.tilesReady().then(hideBoot);
  }, [atlas, data]);
  useEffect(() => atlas?.setLayers(layers), [atlas, layers]);

  // "What do you need?": selected items → buildings that can hold them.
  const buildingIndex = useMemo(() => (data ? indexBuildings(data) : null), [data]);
  const selectedItems = useMemo(() => {
    if (!data) return [];
    if (finderSel.preset) return presetItems(data.items, finderSel.preset);
    const byName = new Map(data.items.items.map((i) => [i.name, i]));
    return finderSel.items.map((n) => byName.get(n)).filter((i) => i !== undefined);
  }, [data, finderSel]);
  // The unrestricted run feeds the "type of place" chips; the restricted one drives the map.
  const finderAll = useMemo(
    () => (data && buildingIndex && selectedItems.length ? runFinder(data, buildingIndex, selectedItems) : null),
    [data, buildingIndex, selectedItems],
  );
  const onlyMask = useMemo(() => (data ? usageMask(data.items, finderSel.places) : 0), [data, finderSel.places]);
  const finderResult = useMemo(
    () => (onlyMask && data && buildingIndex && finderAll ? runFinder(data, buildingIndex, selectedItems, onlyMask) : finderAll),
    [onlyMask, data, buildingIndex, finderAll, selectedItems],
  );
  const areas = useMemo(() => (data && finderResult ? rankAreas(data, finderResult) : []), [data, finderResult]);
  useEffect(() => {
    if (!atlas || !data) return;
    atlas.setFinder(finderResult && buildingIndex ? { result: finderResult, items: selectedItems, index: buildingIndex, only: onlyMask } : null);
  }, [atlas, data, finderResult, buildingIndex, selectedItems, onlyMask]);
  useEffect(() => atlas?.setMarkers(markers), [atlas, markers]);
  useEffect(() => atlas?.setMode(mode), [atlas, mode]);
  useEffect(() => atlas?.setBaseLayer(base), [atlas, base]);

  // Palette: stored raw like the theme so index.html can apply it before first paint.
  useEffect(() => {
    document.documentElement.dataset.palette = palette;
    try {
      localStorage.setItem("atlas:palette", palette);
    } catch {
      /* ignore */
    }
  }, [palette]);
  // The map's highlights follow whichever accent the palette and theme resolve to.
  useEffect(() => {
    atlas?.setAccent(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
  }, [atlas, palette, theme]);
  useEffect(() => writeJson("atlas:base", base), [base]);
  useEffect(() => atlas?.setStrings(t), [atlas, t]);
  useEffect(() => {
    // Sidebar width changes the map's visible area on desktop.
    const t = window.setTimeout(() => atlas?.invalidate(), 220);
    return () => window.clearTimeout(t);
  }, [atlas, sidebarOpen]);

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing)) {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (typing || searchOpen) return;
      if (e.key === "Escape") {
        setMode("browse");
        setEditing(null);
      } else if (e.key === "m") setMode((m) => (m === "measure" ? "browse" : "measure"));
      else if (e.key === "n") setMode((m) => (m === "marker" ? "browse" : "marker"));
      else if (e.key === "t" && atlas?.hasTopo) setBase((b) => (b === "topo" ? "satellite" : "topo"));
      else if (e.key === "Backspace" && mode === "measure") atlas?.undoMeasure();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [atlas, mode, searchOpen]);

  // --- Marker actions --------------------------------------------------------

  const share = async () => {
    if (!meta || !atlas) return;
    const c = atlas.map.getCenter();
    const url = `${location.origin}${location.pathname}#${viewHash(meta.id, { x: c.lng, z: c.lat, zoom: atlas.map.getZoom() })}&m=${await encodeMarkers(markers)}`;
    try {
      if (navigator.share && matchMedia("(pointer: coarse)").matches) await navigator.share({ title: "DayZ Atlas", url });
      else {
        await navigator.clipboard.writeText(url);
        flash(t("share.copied", { count: markers.length }));
      }
    } catch {
      window.prompt(t("share.copyThisLink"), url);
    }
  };

  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ map: meta?.id, markers }, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `dayz-atlas-${meta?.id}-markers.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const merge = (incoming: Marker[]) => {
    const fresh = incoming.filter((m) => !markers.some((x) => sameMarker(x, m)));
    replaceAll([...markers, ...fresh.map((m) => ({ ...m, id: newId() }))]);
    return fresh.length;
  };

  const importJson = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { markers?: Marker[] } | Marker[];
      const list = (Array.isArray(parsed) ? parsed : (parsed.markers ?? [])).filter(
        (m) => typeof m?.x === "number" && typeof m?.z === "number",
      );
      const count = merge(list.map((m) => ({ ...m, label: String(m.label ?? ""), color: m.color ?? MARKER_COLORS[0], icon: m.icon ?? "pin" })));
      flash(t("share.imported", { count }));
    } catch {
      flash(t("share.importFailed"));
    }
  };

  // Shared markers wait until we're on their map.
  const acceptShare = () => {
    if (!pendingShare) return;
    if (pendingShare.mapId !== meta?.id) {
      setMapId(pendingShare.mapId);
      return;
    }
    flash(t("share.imported", { count: merge(pendingShare.markers) }));
    setPendingShare(null);
    setTab("markers");
    setSidebarOpen(true);
  };
  const measureTotal = useMemo(() => measure.slice(1).reduce((d, p, i) => d + distance(measure[i], p), 0), [measure]);

  if (error) {
    hideBoot();
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="text-lg font-semibold">{t("status.loadError")}</p>
          <p className="num mt-2 text-sm text-muted">{error}</p>
          <p className="mt-4 text-sm text-muted">{t("status.loadErrorHint")}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <div ref={mapEl} className="absolute inset-0" />
      {layers.grid && <GridRulers atlas={atlas} />}

      {/* Top-left: brand, map switcher, search + sidebar */}
      <div className="pointer-events-none absolute top-3 left-3 z-[1000] max-md:z-[1200] flex max-h-[calc(100%-24px)] w-[min(340px,calc(100vw-24px))] flex-col gap-2 max-md:w-[calc(100vw-80px)]">
        <Panel className="pointer-events-auto flex items-center gap-1 p-1.5">
          <IconButton label={sidebarOpen ? t("toolbar.hidePanel") : t("toolbar.showPanel")} active={false} onClick={() => setSidebarOpen((o) => !o)}>
            {sidebarOpen ? <PanelLeftClose size={18} /> : <Layers size={18} />}
          </IconButton>
          <div className="mr-1 hidden pl-1 leading-tight sm:block">
            <div className="text-[13px] font-bold tracking-wide whitespace-nowrap">
              DAYZ <span className="text-accent">ATLAS</span>
            </div>
          </div>
          <div className="ml-auto flex rounded-lg bg-raised p-0.5" role="tablist" aria-label={t("toolbar.mapTabs")}>
            {manifest?.maps.map((m) => (
              <button
                key={m.id}
                role="tab"
                aria-selected={m.id === meta?.id}
                onClick={() => {
                  setMapId(m.id);
                  setEditing(null);
                  setMode("browse");
                }}
                className={cx(
                  "rounded-md px-2.5 py-1.5 text-[12.5px] font-medium transition-colors",
                  m.id === meta?.id ? "bg-panel-solid text-fg shadow-sm" : "text-muted hover:text-fg",
                )}
              >
                {m.label}
              </button>
            ))}
          </div>
          <IconButton label={t("toolbar.search")} onClick={() => setSearchOpen(true)}>
            <Search size={18} />
          </IconButton>
        </Panel>

        {sidebarOpen && (
          <Panel className="pointer-events-auto flex min-h-0 flex-col overflow-clip max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:max-h-[62vh] max-md:rounded-b-none">
            <div className="flex gap-1 border-b border-line p-1.5" role="tablist">
              {(
                [
                  ["finder", t("tabs.finder"), 0],
                  ["layers", t("tabs.layers"), 0],
                  ["markers", t("tabs.markers"), markers.length],
                ] as const
              ).map(([id, label, count]) => (
                <button
                  key={id}
                  role="tab"
                  aria-selected={tab === id}
                  onClick={() => setTab(id)}
                  className={cx("flex-1 rounded-md py-1.5 text-[14px] font-semibold", tab === id ? "bg-raised text-fg" : "text-muted hover:text-fg")}
                >
                  {label}
                  {count > 0 && <span className="num ml-1.5 text-[12px] font-medium text-muted">{count}</span>}
                </button>
              ))}
              <button type="button" className="rounded-md px-2 text-muted hover:text-fg md:hidden" aria-label={t("toolbar.closePanel")} onClick={() => setSidebarOpen(false)}>
                <X size={16} />
              </button>
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5">
              {tab === "finder" ? (
                <FinderPanel
                  data={data}
                  selection={finderSel}
                  selected={selectedItems}
                  result={finderResult}
                  placeCounts={finderAll?.byUsage ?? null}
                  areas={areas}
                  onChange={setFinderSel}
                  onFly={(p) => atlas?.flyTo(p, Math.max(atlas.map.getZoom(), 4))}
                />
              ) : tab === "layers" ? (
                <LayersPanel
                  data={data}
                  layers={layers}
                  onChange={setLayers}
                  base={base}
                  hasTopo={!!atlas?.hasTopo}
                  onBase={setBase}
                  searching={!!finderResult}
                />
              ) : (
                <MarkersPanel
                  markers={markers}
                  onSelect={(m) => {
                    atlas?.flyTo(m);
                    setEditing({ marker: m, isNew: false });
                  }}
                  onAddMode={() => {
                    setMode("marker");
                    if (window.innerWidth < 768) setSidebarOpen(false);
                  }}
                  onShare={share}
                  onExport={exportJson}
                  onImport={importJson}
                  onClear={() => window.confirm(t("share.confirmClear", { count: markers.length })) && replaceAll([])}
                />
              )}
            </div>
          </Panel>
        )}
      </div>

      {/* Right: tools */}
      <Panel className="absolute top-3 right-3 z-[1000] flex flex-col gap-0.5 p-1">
        <IconButton label={t("toolbar.zoomIn")} onClick={() => atlas?.zoomIn()}>
          <Plus size={18} />
        </IconButton>
        <IconButton label={t("toolbar.zoomOut")} onClick={() => atlas?.zoomOut()}>
          <Minus size={18} />
        </IconButton>
        <IconButton label={t("toolbar.fitWorld")} onClick={() => atlas?.fit()}>
          <Maximize2 size={16} />
        </IconButton>
        {atlas?.hasTopo && (
          <IconButton label={t("toolbar.baseLayer")} onClick={() => setBase((b) => (b === "topo" ? "satellite" : "topo"))}>
            {base === "topo" ? <Satellite size={18} /> : <Mountain size={18} />}
          </IconButton>
        )}
        <div className="mx-2 my-1 h-px bg-line" />
        <IconButton label={t("toolbar.measure")} active={mode === "measure"} onClick={() => setMode((m) => (m === "measure" ? "browse" : "measure"))}>
          <Ruler size={18} />
        </IconButton>
        <IconButton label={t("toolbar.newMarker")} active={mode === "marker"} onClick={() => setMode((m) => (m === "marker" ? "browse" : "marker"))}>
          <MapPin size={18} />
        </IconButton>
        <div className="mx-2 my-1 h-px bg-line" />
        <IconButton label={theme === "dark" ? t("toolbar.themeLight") : t("toolbar.themeDark")} onClick={() => setTheme((v) => (v === "dark" ? "light" : "dark"))}>
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </IconButton>
        <PaletteMenu value={palette} onChange={setPalette} />
        <LanguageMenu />
      </Panel>

      {/* Marker editor */}
      {editing && (
        <div className="absolute top-3 right-[68px] z-[1100] max-md:top-auto max-md:right-3 max-md:bottom-14">
          <MarkerEditor
            marker={editing.marker}
            isNew={editing.isNew}
            onCancel={() => setEditing(null)}
            onLocate={() => atlas?.flyTo(editing.marker)}
            onDelete={() => {
              remove(editing.marker.id);
              setEditing(null);
            }}
            onSave={(m) => {
              if (editing.isNew) add(m);
              else update(m.id, m);
              setEditing(null);
            }}
          />
        </div>
      )}

      {/* Mode hints */}
      {mode === "marker" && (
        <Hint label={t("hint.exit")} onClose={() => setMode("browse")}>{t("hint.marker")}</Hint>
      )}
      {mode === "measure" && (
        <Hint label={t("hint.exit")} onClose={() => setMode("browse")}>
          {measure.length < 2 ? (
            t("hint.measure")
          ) : (
            <span className="num">
              {fmtMeters(measureTotal)}
              {measure.length === 2 && <span className="text-muted"> · {t("hint.bearing")} {Math.round(bearing(measure[0], measure[1]))}°</span>}
            </span>
          )}
          {measure.length > 0 && (
            <button type="button" className="ml-1 rounded p-1 text-muted hover:bg-hover hover:text-fg" aria-label={t("hint.undoPoint")} onClick={() => atlas?.undoMeasure()}>
              <Undo2 size={14} />
            </button>
          )}
        </Hint>
      )}

      {/* Shared-link import prompt */}
      {pendingShare && (
        <Panel className="absolute bottom-14 left-1/2 z-[1200] flex w-[min(420px,calc(100vw-24px))] -translate-x-1/2 items-center gap-3 p-3">
          <MapPin size={18} className="shrink-0 text-accent" />
          <p className="flex-1 text-[13px]">
            {pendingShare.mapId === meta?.id
              ? t("share.incoming", { count: pendingShare.markers.length })
              : t("share.incomingOtherMap", {
                  count: pendingShare.markers.length,
                  map: manifest?.maps.find((m) => m.id === pendingShare.mapId)?.label ?? pendingShare.mapId,
                })}
          </p>
          <button type="button" className="text-[12.5px] text-muted hover:text-fg" onClick={() => setPendingShare(null)}>
            {t("share.ignore")}
          </button>
          <button type="button" className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-fg" onClick={acceptShare}>
            {pendingShare.mapId !== meta?.id ? t("share.openMap") : t("share.import")}
          </button>
        </Panel>
      )}

      {/* Bottom status bar */}
      <div className="pointer-events-none absolute bottom-3 left-1/2 z-[1000] -translate-x-1/2 max-md:hidden">
        <Panel className="pointer-events-auto flex items-center gap-3 px-3 py-1.5">
          <Locate size={14} className="text-muted" />
          <span className="num text-[12px]">
            {cursor ? (
              // One element, not loose text nodes, and never translated: page translation would
              // wrap the numbers and break React's updates.
              <span translate="no">
                <span className="text-muted">X</span> {Math.round(cursor.x).toString().padStart(5)} <span className="text-muted">Z</span>{" "}
                {Math.round(cursor.z).toString().padStart(5)} <span className="mx-1 text-line">│</span> <span className="text-accent">{gridRef(cursor)}</span>
              </span>
            ) : (
              <span className="text-muted">{t("status.cursorIdle")}</span>
            )}
          </span>
        </Panel>
      </div>
      <div className="pointer-events-none absolute right-3 bottom-3 z-[1000]">
        <p className="pointer-events-auto rounded bg-black/45 px-2 py-0.5 text-[10.5px] text-white/70">
          {t("status.attribution")}{" "}
          <a className="underline-offset-2 hover:underline" href={manifest?.source.repo} target="_blank" rel="noreferrer">
            Bohemia Interactive
          </a>{" "}
          · ADPL-SA · {t("status.unofficial")}
        </p>
      </div>

      {toast && (
        <div role="status" className="absolute top-20 left-1/2 z-[1500] -translate-x-1/2 rounded-lg bg-accent px-4 py-2 text-[13px] font-semibold text-accent-fg shadow-panel">
          {toast}
        </div>
      )}

      {searchOpen && meta && (
        <SearchDialog
          places={data?.places ?? []}
          markers={markers}
          worldSize={meta.worldSize}
          onPick={(p) => atlas?.flyTo(p, Math.max(atlas.map.getZoom(), 4.5))}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
}

function Hint({ children, label, onClose }: { children: React.ReactNode; label: string; onClose: () => void }) {
  return (
    <Panel className="absolute top-3 left-1/2 z-[1050] flex -translate-x-1/2 items-center gap-2 py-1.5 pr-1.5 pl-3.5 text-[13px] max-md:top-auto max-md:bottom-14">
      {children}
      <button type="button" onClick={onClose} aria-label={label} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
        <X size={14} />
      </button>
    </Panel>
  );
}
