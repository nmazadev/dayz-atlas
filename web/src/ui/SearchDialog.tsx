import { Crosshair, MapPin, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { gridRef, parsePosition, type WorldPos } from "../lib/coords";
import type { Place } from "../lib/data";
import { useTranslation } from "react-i18next";
import type { Marker } from "../lib/markers";
import { placeLabel } from "../lib/places";
import { cx } from "./primitives";

type Result = { key: string; title: string; sub: string; grid: string; pos: WorldPos; kind: "coord" | "place" | "marker" };

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

export function SearchDialog({
  places,
  markers,
  worldSize,
  onPick,
  onClose,
}: {
  places: Place[];
  markers: Marker[];
  worldSize: number;
  onPick: (pos: WorldPos) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo<Result[]>(() => {
    const out: Result[] = [];
    const pos = parsePosition(q, worldSize);
    if (pos) out.push({ key: "coord", title: t("search.goTo", { x: Math.round(pos.x), z: Math.round(pos.z) }), sub: t("search.gridSquare"), grid: gridRef(pos), pos, kind: "coord" });
    const needle = fold(q.trim());
    const score = (name: string) => {
      const f = fold(name);
      return f.startsWith(needle) ? 0 : f.includes(needle) ? 1 : -1;
    };
    const ranked = [
      ...places.map((p, i) => {
        const label = placeLabel(p, t);
        // Also match the original spelling (Cyrillic on Chernarus).
        const s = Math.max(score(label), p.native ? score(p.native) : -1);
        return { s, r: { key: `p${i}`, title: label, sub: t(`placeKind.${p.kind}`), grid: gridRef(p), pos: p, kind: "place" as const } };
      }),
      ...markers
        .filter((m) => m.label)
        .map((m) => ({ s: score(m.label), r: { key: `m${m.id}`, title: m.label, sub: t("search.marker"), grid: gridRef(m), pos: m, kind: "marker" as const } })),
    ]
      .filter((x) => !needle || x.s >= 0)
      .sort((a, b) => a.s - b.s || a.r.title.localeCompare(b.r.title));
    for (const x of ranked.slice(0, 40)) out.push(x.r);
    return out;
  }, [q, places, markers, worldSize, t]);

  useEffect(() => setActive(0), [q]);

  const pick = (r: Result | undefined) => {
    if (!r) return;
    onPick(r.pos);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[2000] flex items-start justify-center bg-black/50 px-3 pt-[12vh]" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label={t("search.label")}
        className="w-full max-w-lg overflow-hidden rounded-xl border border-line bg-panel-solid shadow-panel"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={18} className="text-muted" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") pick(results[active]);
            }}
            placeholder={t("search.placeholder")}
            className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted"
          />
          <kbd className="num rounded border border-line px-1.5 text-[10px] text-muted">Esc</kbd>
        </div>
        <ul className="scroll-thin max-h-[50vh] overflow-y-auto p-1.5" role="listbox">
          {results.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted">{t("search.noResults")}</li>}
          {results.map((r, i) => (
            <li key={r.key} role="option" aria-selected={i === active}>
              <button
                type="button"
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(r)}
                className={cx("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left", i === active && "bg-hover")}
              >
                {r.kind === "coord" ? <Crosshair size={16} className="text-accent" /> : <MapPin size={16} className={r.kind === "marker" ? "text-accent" : "text-muted"} />}
                <span className="flex-1 text-[13.5px]">{r.title}</span>
                <span className="text-[12.5px] text-muted">{r.sub}</span>
                <span className="num w-14 text-right text-[12.5px] text-muted">{r.grid}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
