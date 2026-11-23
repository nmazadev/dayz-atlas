import { Check, Palette as PaletteIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cx, IconButton, Panel } from "./primitives";

export const PALETTES = ["graphite", "field", "road"] as const;
export type Palette = (typeof PALETTES)[number];

/** Panel, accent and paper colour of each palette, for the swatch in the menu. */
const SWATCH: Record<Palette, [string, string, string]> = {
  graphite: ["#14161a", "#f0b429", "#e8e6e1"],
  field: ["#2b3024", "#ff7b1c", "#ebe6d3"],
  road: ["#13244a", "#d62f2f", "#ffcd2e"],
};

export function PaletteMenu({ value, onChange }: { value: Palette; onChange: (p: Palette) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <IconButton label={t("palette.title")} active={open} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <PaletteIcon size={18} />
      </IconButton>
      {open && (
        <Panel className="absolute top-0 right-12 w-60 p-1">
          <ul role="menu" aria-label={t("palette.title")}>
            {PALETTES.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={p === value}
                  onClick={() => {
                    onChange(p);
                    setOpen(false);
                  }}
                  className={cx("flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left hover:bg-hover", p === value && "bg-raised")}
                >
                  <span className="flex shrink-0 overflow-hidden rounded ring-1 ring-black/20" aria-hidden>
                    {SWATCH[p].map((c) => (
                      <span key={c} className="h-6 w-3.5" style={{ background: c }} />
                    ))}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-semibold">{t(`palette.${p}`)}</span>
                    <span className="block text-[12.5px] leading-snug text-muted">{t(`palette.${p}Hint`)}</span>
                  </span>
                  {p === value && <Check size={15} className="shrink-0 text-accent" />}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
