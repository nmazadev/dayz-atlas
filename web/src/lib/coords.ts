/** In-game positions are metres on the X (east) and Z (north) axes. */
export type WorldPos = { x: number; z: number };

const pad3 = (n: number) => String(Math.max(0, Math.floor(n))).padStart(3, "0");

/** The classic "045 123" notation: 100 m squares, as read off the in-game map. */
export const gridRef = ({ x, z }: WorldPos) => `${pad3(x / 100)} ${pad3(z / 100)}`;

export const fmtMeters = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);

export const distance = (a: WorldPos, b: WorldPos) => Math.hypot(b.x - a.x, b.z - a.z);

/** Compass bearing from a to b, degrees clockwise from north — what the in-game compass shows. */
export const bearing = (a: WorldPos, b: WorldPos) =>
  (Math.atan2(b.x - a.x, b.z - a.z) * (180 / Math.PI) + 360) % 360;

/**
 * Parse a typed position. Accepts metres ("4465 2461", "4465.3, 2461"),
 * a 3+3 grid reference ("044 024", "044024") → centre of that 100 m square.
 */
export function parsePosition(input: string, worldSize: number): WorldPos | null {
  const s = input.trim();
  const grid = s.match(/^(\d{3})\s*[,;/ ]?\s*(\d{3})$/);
  if (grid) {
    const pos = { x: Number(grid[1]) * 100 + 50, z: Number(grid[2]) * 100 + 50 };
    return inside(pos, worldSize) ? pos : null;
  }
  const m = s.match(/^(-?\d+(?:\.\d+)?)\s*[,;/ ]\s*(-?\d+(?:\.\d+)?)$/);
  if (m) {
    const pos = { x: Number(m[1]), z: Number(m[2]) };
    return inside(pos, worldSize) ? pos : null;
  }
  return null;
}

const inside = (p: WorldPos, size: number) => p.x >= 0 && p.z >= 0 && p.x <= size && p.z <= size;

/** Strip engine prefixes: "Land_Mil_Barracks1" → "Mil Barracks 1". */
export function prettyBuilding(name: string) {
  return name
    .replace(/^(Land|StaticObj|Wreck)_/, "")
    .replace(/_/g, " ")
    .replace(/(?<=[a-z])(?=[A-Z0-9])/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
