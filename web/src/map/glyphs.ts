import type { MarkerIcon } from "../lib/style";

// 24×24 stroke glyphs drawn inside user marker pins.
const GLYPHS: Record<MarkerIcon, string> = {
  pin: '<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>',
  base: '<path d="M4 11 12 4l8 7"/><path d="M6 10v9h12v-9"/><path d="M10 19v-5h4v5"/>',
  stash: '<path d="M4 8h16v11H4z"/><path d="M3 5h18v3H3z"/><path d="M10 12h4"/>',
  vehicle: '<path d="M5 16V11l2-5h10l2 5v5"/><path d="M4 16h16"/><circle cx="8" cy="17" r="1.6"/><circle cx="16" cy="17" r="1.6"/>',
  danger: '<path d="M12 4 21 20H3z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
  loot: '<path d="m12 4 2.4 5 5.6.8-4 3.9 1 5.5L12 16.6 7 19.2l1-5.5-4-3.9L9.6 9z"/>',
  meet: '<path d="M6 21V4"/><path d="M6 4h11l-2 4 2 4H6"/>',
};

export function markerIconHtml(icon: MarkerIcon, color: string, label: string) {
  const text = label ? `<span class="atlas-pin__label">${escapeHtml(label)}</span>` : "";
  return `<div class="atlas-pin" style="--pin:${color}">
    <svg class="atlas-pin__body" viewBox="0 0 32 40"><path d="M16 39s13-12.6 13-23A13 13 0 0 0 3 16c0 10.4 13 23 13 23z"/></svg>
    <svg class="atlas-pin__glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[icon]}</svg>
    ${text}
  </div>`;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
