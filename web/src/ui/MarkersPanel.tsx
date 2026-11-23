import { Download, Link2, MapPinPlus, Trash2, Upload } from "lucide-react";
import { useRef } from "react";
import { gridRef } from "../lib/coords";
import type { Marker } from "../lib/markers";
import { useTranslation } from "react-i18next";
import { SectionTitle, TextButton } from "./primitives";

export function MarkersPanel({
  markers,
  onSelect,
  onAddMode,
  onShare,
  onExport,
  onImport,
  onClear,
}: {
  markers: Marker[];
  onSelect: (m: Marker) => void;
  onAddMode: () => void;
  onShare: () => void;
  onExport: () => void;
  onImport: (file: File) => void;
  onClear: () => void;
}) {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="pb-3">
      <div className="grid grid-cols-2 gap-2 px-2 pt-2">
        <button type="button" onClick={onAddMode} className="flex items-center justify-center gap-2 rounded-lg bg-accent px-3 py-2 text-[13px] font-semibold text-accent-fg hover:brightness-110">
          <MapPinPlus size={16} /> {t("markers.add")}
        </button>
        <button
          type="button"
          onClick={onShare}
          disabled={!markers.length}
          className="flex items-center justify-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px] font-medium hover:bg-hover disabled:opacity-40"
        >
          <Link2 size={16} /> {t("markers.share")}
        </button>
      </div>
      <p className="px-2 pt-2 text-[11.5px] leading-relaxed text-muted">
        {t("markers.help")}
      </p>

      <SectionTitle action={<span className="num text-[11px] text-muted">{markers.length}</span>}>{t("markers.yours")}</SectionTitle>
      {markers.length === 0 ? (
        <p className="px-2 py-6 text-center text-[12.5px] text-muted">{t("markers.empty")}</p>
      ) : (
        <ul className="space-y-0.5">
          {markers.map((m) => (
            <li key={m.id}>
              <button type="button" onClick={() => onSelect(m)} className="flex w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-hover">
                <span className="size-3 shrink-0 rounded-full ring-2 ring-black/30" style={{ background: m.color }} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px]">{m.label || t(`markerIcon.${m.icon}`)}</span>
                  <span className="num block text-[11px] text-muted">{gridRef(m)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-4 border-t border-line px-2 pt-3">
        <TextButton onClick={onExport} disabled={!markers.length} className="inline-flex items-center gap-1.5 disabled:opacity-40">
          <Download size={13} /> {t("markers.exportJson")}
        </TextButton>
        <TextButton onClick={() => fileRef.current?.click()} className="inline-flex items-center gap-1.5">
          <Upload size={13} /> {t("markers.import")}
        </TextButton>
        {markers.length > 0 && (
          <TextButton onClick={onClear} className="ml-auto inline-flex items-center gap-1.5 hover:!text-danger">
            <Trash2 size={13} /> {t("markers.clearAll")}
          </TextButton>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImport(f);
            e.target.value = "";
          }}
        />
      </div>
    </div>
  );
}
