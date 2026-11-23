import { Backpack, Biohazard, Bomb, Car, Crosshair, Fish, Hammer, HeartPulse, Package, Search, Utensils, X } from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";
import { useTranslation } from "react-i18next";
import type { WorldPos } from "../lib/coords";
import type { Item, MapData } from "../lib/data";
import { itemLabel, PRESETS, searchItems, type Area, type FinderResult, type PresetId } from "../lib/finder";
import { placeLabel } from "../lib/places";
import { USAGE_COLOR } from "../lib/style";
import { cx } from "./primitives";

const PRESET_ICON: Record<PresetId, ComponentType<{ size?: number; strokeWidth?: number }>> = {
  medical: HeartPulse,
  food: Utensils,
  guns: Crosshair,
  ammo: Package,
  base: Hammer,
  vehicle: Car,
  clothing: Backpack,
  gas: Biohazard,
  explosives: Bomb,
  hunting: Fish,
};

/** `places`: usages the search is narrowed to ("type of place"); empty = everywhere. */
export type FinderSelection = { preset: PresetId | null; items: string[]; places: string[] };

export function FinderPanel({
  data,
  selection,
  selected,
  result,
  placeCounts,
  areas,
  onChange,
  onFly,
}: {
  data: MapData | null;
  selection: FinderSelection;
  selected: Item[];
  result: FinderResult | null;
  /** Matching buildings per usage before narrowing, for the "type of place" chips. */
  placeCounts: number[] | null;
  areas: Area[];
  onChange: (s: FinderSelection) => void;
  onFly: (pos: WorldPos) => void;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? "en";
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const suggestions = useMemo(
    () => (data ? searchItems(data.items.items, query, lang).filter((i) => !selection.items.includes(i.name)) : []),
    [data, query, lang, selection.items],
  );

  const addItem = (item: Item) => {
    onChange({ preset: null, items: [...selection.items, item.name], places: [] });
    setQuery("");
    setActive(0);
  };
  const searching = selection.preset !== null || selection.items.length > 0;
  const single = !selection.preset && selected.length === 1 ? selected[0] : null;
  const maxSpots = areas[0]?.spots ?? 1;

  return (
    <div className="pb-4">
      <div className="relative px-2 pt-3">
        <label className="flex items-center gap-2.5 rounded-lg border border-line bg-raised px-3 focus-within:border-accent">
          <Search size={17} className="shrink-0 text-muted" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, suggestions.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter" && suggestions[active]) addItem(suggestions[active]);
              else if (e.key === "Escape") setQuery("");
            }}
            placeholder={t("finder.placeholder")}
            aria-label={t("finder.title")}
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls="finder-suggestions"
            className="h-11 w-full bg-transparent text-[15px] outline-none placeholder:text-muted"
          />
        </label>
        {suggestions.length > 0 && (
          <ul id="finder-suggestions" role="listbox" className="absolute inset-x-2 top-full z-10 mt-1 overflow-hidden rounded-lg border border-line bg-panel-solid shadow-panel">
            {suggestions.map((item, i) => (
              <li key={item.name} role="option" aria-selected={i === active}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => addItem(item)}
                  className={cx("flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left", i === active && "bg-hover")}
                >
                  <span className="text-[14px]">{itemLabel(item, lang)}</span>
                  <span className="text-[12px] text-muted">{t(`category.${data!.items.cats[item.cat] as "weapons"}`)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid grid-cols-2 gap-1.5 px-2 pt-3" role="group" aria-label={t("finder.groups")}>
        {PRESETS.map(({ id }) => {
          const Icon = PRESET_ICON[id];
          const on = selection.preset === id;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={on}
              onClick={() => onChange({ preset: on ? null : id, items: [], places: [] })}
              className={cx(
                "flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left text-[13.5px] transition-colors",
                on ? "border-accent bg-accent text-accent-fg" : "border-line hover:border-muted hover:bg-hover",
              )}
            >
              <Icon size={17} strokeWidth={2} />
              <span className="leading-tight">{t(`preset.${id}`)}</span>
            </button>
          );
        })}
      </div>

      {selection.items.length > 0 && (
        <ul className="flex flex-wrap gap-1.5 px-2 pt-3" aria-label={t("finder.selected")}>
          {selected.map((item) => (
            <li key={item.name}>
              <button
                type="button"
                onClick={() => onChange({ preset: null, items: selection.items.filter((n) => n !== item.name), places: [] })}
                className="inline-flex items-center gap-1.5 rounded-full bg-accent py-1 pr-2 pl-3 text-[13px] font-semibold text-accent-fg"
                aria-label={t("finder.remove", { name: itemLabel(item, lang) })}
              >
                {itemLabel(item, lang)}
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {!searching && <p className="px-3 pt-4 text-[13.5px] leading-relaxed text-muted">{t("finder.empty")}</p>}

      {single && data && <ItemCard item={single} data={data} />}

      {searching && result && (
        <section className="px-2 pt-4" aria-live="polite">
          <div className="flex items-baseline justify-between px-1">
            <h3 className="text-[15px] font-bold">{t("finder.whereTitle")}</h3>
            <button type="button" className="text-[12.5px] text-muted hover:text-accent" onClick={() => onChange({ preset: null, items: [], places: [] })}>
              {t("finder.clear")}
            </button>
          </div>
          <p className="px-1 pt-0.5 text-[13px] text-muted">
            {t("finder.count", { count: result.total })} {result.total > 0 && t("finder.ranking")}
          </p>

          {placeCounts && data && <PlaceFilter data={data} counts={placeCounts} selection={selection} onChange={onChange} />}

          {result.eventOnly.length > 0 && (
            <p className="mx-1 mt-2 rounded-md border border-line px-2.5 py-2 text-[12.5px] leading-snug">
              {t("finder.eventOnly", { names: result.eventOnly.slice(0, 3).map((i) => itemLabel(i, lang)).join(", "), count: result.eventOnly.length })}
            </p>
          )}
          {result.total === 0 && result.eventOnly.length === 0 && <p className="px-1 pt-2 text-[13px]">{t("finder.none")}</p>}

          <ol className="mt-2 space-y-0.5">
            {areas.map((a) => (
              <li key={`${a.place?.name ?? "field"}-${a.x}`}>
                <button type="button" onClick={() => onFly(a)} className="group grid w-full grid-cols-[1fr_auto] items-center gap-x-3 rounded-md px-1.5 py-1.5 text-left hover:bg-hover">
                  <span className="truncate text-[14px]">{a.place ? placeLabel(a.place, t) : t("finder.countryside")}</span>
                  <span className="num text-[13px] text-muted" title={t("finder.buildingsIn", { count: a.count })}>
                    {t("finder.spots", { count: a.spots })}
                  </span>
                  <span className="col-span-2 mt-1 h-1 rounded-full bg-raised">
                    <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(6, (a.spots / maxSpots) * 100)}%` }} />
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

/** What a survivor wants to know about one item: how rare, where, which tiers. */
function ItemCard({ item, data }: { item: Item; data: MapData }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.resolvedLanguage ?? "en";
  const usages = data.items.usages.filter((_, i) => item.usages & (1 << i));
  const tiers = data.items.tiers.filter((_, i) => item.tiers & (1 << i));
  const tags = data.items.tags.filter((_, i) => item.tags & (1 << i));
  const rarity = item.nominal <= 3 ? "rare" : item.nominal <= 15 ? "uncommon" : "common";
  return (
    <section className="mx-2 mt-3 rounded-lg border border-line bg-raised px-3 py-2.5">
      <h3 className="text-[16px] font-bold">{itemLabel(item, lang)}</h3>
      <dl className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[13px]">
        <dt className="text-muted">{t("item.rarity")}</dt>
        <dd>{t(`item.${rarity}`, { count: item.nominal })}</dd>
        <dt className="text-muted">{t("item.where")}</dt>
        <dd>{item.deloot ? t("item.eventsOnly") : usages.length ? usages.map((u) => t(`usage.${u as "Military"}`, { defaultValue: t(`areaUsage.${u}`, { defaultValue: u }) })).join(", ") : t("item.anywhere")}</dd>
        {tiers.length > 0 && (
          <>
            <dt className="text-muted">{t("item.tiers")}</dt>
            <dd className="num">{tiers.map((x) => x.replace("Tier", "T")).join(", ")}</dd>
          </>
        )}
        {tags.length > 0 && (
          <>
            <dt className="text-muted">{t("item.spot")}</dt>
            <dd>{tags.map((x) => t(`tag.${x as "floor"}`)).join(", ")}</dd>
          </>
        )}
      </dl>
    </section>
  );
}


/** Narrow a broad search to the kind of place you're heading for (military, police…). */
function PlaceFilter({
  data,
  counts,
  selection,
  onChange,
}: {
  data: MapData;
  counts: number[];
  selection: FinderSelection;
  onChange: (s: FinderSelection) => void;
}) {
  const { t } = useTranslation();
  const options = data.items.usages
    .map((u, i) => ({ u, n: counts[i] }))
    .filter((o) => o.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 10);
  if (options.length < 2) return null;
  const toggle = (u: string) =>
    onChange({ ...selection, places: selection.places.includes(u) ? selection.places.filter((p) => p !== u) : [...selection.places, u] });
  return (
    <div className="mt-3 px-1">
      <div className="flex items-baseline justify-between">
        <h4 className="text-[13.5px] font-semibold">{t("finder.placeType")}</h4>
        {selection.places.length > 0 && (
          <button type="button" className="text-[12.5px] text-muted hover:text-accent" onClick={() => onChange({ ...selection, places: [] })}>
            {t("finder.anyPlace")}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1.5">
        {options.map(({ u, n }) => {
          const on = selection.places.includes(u);
          const color = USAGE_COLOR[u as keyof typeof USAGE_COLOR] ?? "#a3e635";
          return (
            <button
              key={u}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(u)}
              className={cx(
                "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[13px]",
                on ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:text-fg",
              )}
            >
              <span className="size-2 rounded-full" style={{ background: color }} />
              {t(`usage.${u as "Military"}`, { defaultValue: t(`areaUsage.${u}`, { defaultValue: u }) })}
              <span className="num text-[12px] opacity-70">{n}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
