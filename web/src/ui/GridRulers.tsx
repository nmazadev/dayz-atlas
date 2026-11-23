import { useEffect, useState } from "react";
import type { AtlasMap } from "../map/AtlasMap";

type Tick = { pos: number; label: string; major: boolean };

/** Grid numbers pinned to the top and left edges of the viewport, like a paper map. */
export function GridRulers({ atlas }: { atlas: AtlasMap | null }) {
  const [ticks, setTicks] = useState<{ x: Tick[]; y: Tick[] }>({ x: [], y: [] });

  useEffect(() => {
    if (!atlas) return;
    // Depend on the AtlasMap instance only: a map switch must not re-subscribe to the old one.
    const { map, worldSize } = atlas;
    const update = () => {
      // Pixels per metre at this zoom decides whether 100 m labels fit.
      const pxPerM = (map.latLngToContainerPoint([0, 1000]).x - map.latLngToContainerPoint([0, 0]).x) / 1000;
      const step = pxPerM * 100 >= 34 ? 100 : pxPerM * 1000 >= 26 ? 1000 : 2000;
      const size = map.getSize();
      const nw = map.containerPointToLatLng([0, 0]);
      const se = map.containerPointToLatLng([size.x, size.y]);
      const x: Tick[] = [];
      const y: Tick[] = [];
      const label = (v: number) => (step === 100 ? String(v / 100).padStart(3, "0") : String(v / 1000).padStart(2, "0"));
      for (let v = Math.max(0, Math.ceil(nw.lng / step) * step); v <= Math.min(worldSize, se.lng); v += step) {
        x.push({ pos: map.latLngToContainerPoint([0, v]).x, label: label(v), major: v % 1000 === 0 });
      }
      for (let v = Math.max(0, Math.ceil(se.lat / step) * step); v <= Math.min(worldSize, nw.lat); v += step) {
        y.push({ pos: map.latLngToContainerPoint([v, 0]).y, label: label(v), major: v % 1000 === 0 });
      }
      setTicks({ x, y });
    };
    update();
    map.on("move zoom resize", update);
    return () => {
      map.off("move zoom resize", update);
    };
  }, [atlas]);

  const cls = (major: boolean) =>
    `absolute num text-[10px] leading-none px-1 py-0.5 rounded-sm ${major ? "text-white/90 bg-black/55" : "text-white/60 bg-black/35"}`;

  return (
    <div className="pointer-events-none absolute inset-0 z-[450] overflow-hidden" aria-hidden>
      {ticks.x.map((t) => (
        <span key={`x${t.label}`} className={cls(t.major)} style={{ left: t.pos, bottom: 52, transform: "translateX(-50%)" }}>
          {t.label}
        </span>
      ))}
      {ticks.y.map((t) => (
        <span key={`y${t.label}`} className={cls(t.major)} style={{ top: t.pos, right: 6, transform: "translateY(-50%)" }}>
          {t.label}
        </span>
      ))}
    </div>
  );
}
