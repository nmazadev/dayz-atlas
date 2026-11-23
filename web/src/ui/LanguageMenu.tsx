import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LANGUAGES } from "../i18n";
import { cx, IconButton, Panel } from "./primitives";

/** Lists whatever locales exist in src/i18n/locales. */
export function LanguageMenu() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = i18n.resolvedLanguage ?? "en";

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
      <IconButton label={t("toolbar.language")} active={open} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="mono text-[11px] font-bold uppercase">{current}</span>
      </IconButton>
      {open && (
        <Panel className="absolute top-0 right-12 min-w-36 p-1">
          <ul role="menu" aria-label={t("toolbar.language")}>
            {LANGUAGES.map((l) => (
              <li key={l.code}>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={l.code === current}
                  onClick={() => {
                    i18n.changeLanguage(l.code);
                    setOpen(false);
                  }}
                  className={cx("flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] hover:bg-hover", l.code === current && "text-accent")}
                >
                  <span className="mono w-5 text-[10.5px] text-muted uppercase">{l.code}</span>
                  <span className="flex-1">{l.name}</span>
                  {l.code === current && <Check size={14} />}
                </button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}
