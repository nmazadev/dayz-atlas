import { Crosshair, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { gridRef } from "../lib/coords";
import type { Marker } from "../lib/markers";
import { useTranslation } from "react-i18next";
import { MARKER_COLORS, MARKER_ICONS } from "../lib/style";
import { cx, Panel } from "./primitives";

export function MarkerEditor({
  marker,
  isNew,
  onSave,
  onDelete,
  onCancel,
  onLocate,
}: {
  marker: Marker;
  isNew: boolean;
  onSave: (m: Marker) => void;
  onDelete: () => void;
  onCancel: () => void;
  onLocate: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(marker);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setDraft(marker);
    inputRef.current?.focus();
  }, [marker]);

  return (
    <Panel className="w-[min(340px,calc(100vw-24px))] p-3">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ ...draft, label: draft.label.trim() });
        }}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
      >
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold">{isNew ? t("editor.new") : t("editor.edit")}</h2>
          <div className="flex items-center gap-1">
            <button type="button" onClick={onLocate} className="num flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-hover hover:text-fg" title={t("editor.centerOnMap")}>
              <Crosshair size={12} /> {gridRef(draft)}
            </button>
            <button type="button" onClick={onCancel} aria-label={t("editor.close")} className="rounded p-1 text-muted hover:bg-hover hover:text-fg">
              <X size={16} />
            </button>
          </div>
        </div>

        <input
          ref={inputRef}
          value={draft.label}
          maxLength={40}
          placeholder={t("editor.namePlaceholder")}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
          className="w-full rounded-md border border-line bg-raised px-2.5 py-1.5 text-[13px] outline-none placeholder:text-muted focus:border-accent"
        />

        <div className="mt-3 flex flex-wrap gap-1.5" role="radiogroup" aria-label={t("editor.color")}>
          {MARKER_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={draft.color === c}
              aria-label={c}
              onClick={() => setDraft({ ...draft, color: c })}
              className={cx("size-6 rounded-full ring-offset-2 ring-offset-[var(--panel-solid)]", draft.color === c && "ring-2 ring-fg")}
              style={{ background: c }}
            />
          ))}
        </div>

        <div className="mt-3 grid grid-cols-4 gap-1.5" role="radiogroup" aria-label={t("editor.type")}>
          {MARKER_ICONS.map((icon) => (
            <button
              key={icon}
              type="button"
              role="radio"
              aria-checked={draft.icon === icon}
              onClick={() => setDraft({ ...draft, icon })}
              className={cx(
                "rounded-md border px-1 py-1.5 text-[11.5px]",
                draft.icon === icon ? "border-accent bg-accent/15 text-fg" : "border-line text-muted hover:text-fg",
              )}
            >
              {t(`markerIcon.${icon}`)}
            </button>
          ))}
        </div>

        <div className="mt-3 flex items-center gap-2">
          {!isNew && (
            <button type="button" onClick={onDelete} className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[12.5px] text-muted hover:bg-hover hover:text-danger">
              <Trash2 size={14} /> {t("editor.delete")}
            </button>
          )}
          <button type="submit" className="ml-auto rounded-md bg-accent px-4 py-1.5 text-[13px] font-semibold text-accent-fg hover:brightness-110">
            {t("editor.save")}
          </button>
        </div>
      </form>
    </Panel>
  );
}
