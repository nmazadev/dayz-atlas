import type { EventKind, Usage } from "./data";

// Colours only; user-facing names live in i18n.tsx.

/** Building colours. Picked to stay distinguishable on the dark satellite imagery. */
export const USAGE_COLOR: Record<Usage, string> = {
  Military: "#ef4444",
  Police: "#3b82f6",
  Medic: "#f472b6",
  Firefighter: "#f97316",
  Prison: "#a8a29e",
  Hunting: "#22c55e",
  Industrial: "#eab308",
  Farm: "#a3e635",
  Office: "#a78bfa",
  School: "#2dd4bf",
  Coast: "#22d3ee",
  Town: "#e2e8f0",
  Village: "#94a3b8",
  Historical: "#d6b48a",
  Other: "#78716c",
};

export const TIER_STYLE = [
  { label: "T1", color: "#4ade80" },
  { label: "T2", color: "#facc15" },
  { label: "T3", color: "#f97316" },
  { label: "T4", color: "#ef4444" },
];

export const EVENT_STYLE: Record<EventKind, { color: string; glyph: string }> = {
  heli: { color: "#f43f5e", glyph: "H" },
  convoy: { color: "#f59e0b", glyph: "C" },
  police: { color: "#60a5fa", glyph: "P" },
  train: { color: "#c084fc", glyph: "T" },
  gas: { color: "#84cc16", glyph: "☣" },
  crate: { color: "#fb923c", glyph: "▣" },
  vehicle: { color: "#38bdf8", glyph: "" },
  boat: { color: "#06b6d4", glyph: "" },
};

export const MARKER_COLORS = ["#ff7b1c", "#ef4444", "#22c55e", "#3b82f6", "#a78bfa", "#f472b6", "#e2e8f0", "#14b8a6"];

export const MARKER_ICONS = ["pin", "base", "stash", "vehicle", "danger", "loot", "meet"] as const;
export type MarkerIcon = (typeof MARKER_ICONS)[number];
