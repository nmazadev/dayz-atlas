import type { TFunction } from "i18next";
import i18n from "../i18n";
import type { Place } from "./data";

/** Text shown for a place: its name, a localised variant, or "Military base · Tisy" for bases. */
export function placeLabel(p: Place, t: TFunction): string {
  if (p.kind === "military" || p.kind === "airfield") {
    return p.near ? t(`placeLabel.${p.kind}`, { near: p.near }) : t(`placeKind.${p.kind}`);
  }
  return p.i18n?.[i18n.resolvedLanguage ?? ""] ?? p.name;
}
