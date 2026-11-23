import { useMemo } from "react";
import { CATEGORIES, USAGES, type EventKind, type MapData } from "../lib/data";
import { useTranslation } from "react-i18next";
import { EVENT_STYLE, TIER_STYLE, USAGE_COLOR } from "../lib/style";
import type { BaseLayer } from "../lib/data";
import { AtlasMap, type LayerState } from "../map/AtlasMap";
import { Chip, SectionTitle, TextButton, Toggle } from "./primitives";

const toggled = <T,>(set: ReadonlySet<T>, v: T) => {
  const next = new Set(set);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  return next;
};

export function LayersPanel({
  data,
  layers,
  onChange,
  base,
  hasTopo,
  onBase,
  searching,
}: {
  data: MapData | null;
  layers: LayerState;
  onChange: (next: LayerState) => void;
  base: BaseLayer;
  hasTopo: boolean;
  onBase: (b: BaseLayer) => void;
  /** A "what do you need?" search is driving the loot layer. */
  searching: boolean;
}) {
  const { t } = useTranslation();
  const set = <K extends keyof LayerState>(k: K, v: LayerState[K]) => onChange({ ...layers, [k]: v });

  // Counts per usage under the *other* active filters, so chips show what you'd get.
  const usageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    if (!data) return counts;
    const all = new Set<string>(USAGES);
    for (const b of data.buildings) {
      if (AtlasMap.matches(b, { ...layers, usages: all })) counts[b.usage] = (counts[b.usage] ?? 0) + 1;
    }
    return counts;
  }, [data, layers]);

  const visible = useMemo(
    () => (data ? data.buildings.reduce((n, b) => n + (AtlasMap.matches(b, layers) ? 1 : 0), 0) : 0),
    [data, layers],
  );

  const eventCounts = useMemo(() => {
    const counts = new Map<EventKind, number>();
    for (const e of data?.events ?? []) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    return counts;
  }, [data]);

  return (
    <div className="pb-3">
      <SectionTitle>{t("layers.map")}</SectionTitle>
      {hasTopo && (
        <div className="mx-2 mb-2 grid grid-cols-2 rounded-lg bg-raised p-0.5" role="radiogroup" aria-label={t("layers.base")}>
          {(["satellite", "topo"] as const).map((b) => (
            <button
              key={b}
              type="button"
              role="radio"
              aria-checked={base === b}
              onClick={() => onBase(b)}
              className={`rounded-md py-1.5 text-[12.5px] font-medium ${base === b ? "bg-panel-solid text-fg shadow-sm" : "text-muted hover:text-fg"}`}
            >
              {t(`layers.${b}`)}
            </button>
          ))}
        </div>
      )}
      <Toggle label={t("layers.placeNames")} checked={layers.places} onChange={(v) => set("places", v)} />
      <Toggle label={t("layers.grid")} checked={layers.grid} onChange={(v) => set("grid", v)} />
      <Toggle label={t("layers.tierZones")} checked={layers.tierOverlay} onChange={(v) => set("tierOverlay", v)} />
      <Toggle label={t("layers.gasZones")} swatch="#a3e635" checked={layers.gas} onChange={(v) => set("gas", v)} hint={String(data?.zones.length ?? "")} />
      <Toggle label={t("layers.playerSpawns")} swatch="#fde68a" checked={layers.spawns} onChange={(v) => set("spawns", v)} hint={String(data?.spawns.length ?? "")} />

      <SectionTitle
        action={
          <span className="num text-[12px] text-muted" aria-live="polite">
            {layers.loot ? t("layers.buildings", { count: visible }) : t("layers.hidden")}
          </span>
        }
      >
        {t("layers.loot")}
      </SectionTitle>
      {searching && <p className="mx-2 mb-2 rounded-md border border-accent/50 px-2.5 py-2 text-[12.5px] leading-snug">{t("layers.searchActive")}</p>}
      <Toggle label={t("layers.showLoot")} checked={layers.loot} onChange={(v) => set("loot", v)} />

      <div className={layers.loot && !searching ? "" : "pointer-events-none opacity-40"}>
        <div className="mt-2 flex items-center justify-between px-2">
          <span className="text-[12px] text-muted">{t("layers.placeType")}</span>
          <span className="flex gap-3">
            <TextButton onClick={() => set("usages", new Set(USAGES))}>{t("layers.all")}</TextButton>
            <TextButton onClick={() => set("usages", new Set(["Military"]))}>{t("layers.onlyMilitary")}</TextButton>
            <TextButton onClick={() => set("usages", new Set())}>{t("layers.none")}</TextButton>
          </span>
        </div>
        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
          {USAGES.filter((u) => usageCounts[u]).map((u) => (
            <Chip key={u} on={layers.usages.has(u)} color={USAGE_COLOR[u]} count={usageCounts[u]} onClick={() => set("usages", toggled(layers.usages, u))}>
              {t(`usage.${u}`)}
            </Chip>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between px-2">
          <span className="text-[12px] text-muted">{t("layers.lookingFor")}</span>
          {layers.cats.size > 0 && <TextButton onClick={() => set("cats", new Set())}>{t("layers.clear")}</TextButton>}
        </div>
        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
          {CATEGORIES.map((c) => (
            <Chip key={c} on={layers.cats.has(c)} onClick={() => set("cats", toggled(layers.cats, c))}>
              {t(`category.${c}`)}
            </Chip>
          ))}
        </div>

        <div className="mt-3 flex items-center justify-between px-2">
          <span className="text-[12px] text-muted">{t("layers.zoneTier")}</span>
          {layers.tiers.size > 0 && <TextButton onClick={() => set("tiers", new Set())}>{t("layers.clear")}</TextButton>}
        </div>
        <div className="flex flex-wrap gap-1.5 px-2 pt-2">
          {TIER_STYLE.map((tier, i) => (
            <Chip key={tier.label} on={layers.tiers.has(i)} color={tier.color} onClick={() => set("tiers", toggled(layers.tiers, i))}>
              <span title={t(`tierHint.${i as 0 | 1 | 2 | 3}`)}>{tier.label}</span>
            </Chip>
          ))}
        </div>
      </div>

      <SectionTitle
        action={
          <TextButton onClick={() => set("events", layers.events.size ? new Set() : new Set(eventCounts.keys()))}>
            {layers.events.size ? t("layers.hideAll") : t("layers.showAll")}
          </TextButton>
        }
      >
        {t("layers.events")}
      </SectionTitle>
      {(Object.keys(EVENT_STYLE) as EventKind[])
        .filter((k) => eventCounts.get(k))
        .map((k) => (
          <Toggle
            key={k}
            label={t(`event.${k}`)}
            swatch={EVENT_STYLE[k].color}
            hint={String(eventCounts.get(k))}
            checked={layers.events.has(k)}
            onChange={() => set("events", toggled(layers.events, k))}
          />
        ))}
      <p className="px-2 pt-2 text-[11.5px] leading-relaxed text-muted">
        {t("layers.eventsNote")}
      </p>
    </div>
  );
}
