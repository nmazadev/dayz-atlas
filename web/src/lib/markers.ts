import { useCallback, useEffect, useState } from "react";
import type { MarkerIcon } from "./style";
import { readJson, writeJson } from "./storage";

export type Marker = {
  id: string;
  x: number;
  z: number;
  label: string;
  color: string;
  icon: MarkerIcon;
};

const key = (mapId: string) => `atlas:markers:${mapId}`;
export const newId = () => crypto.randomUUID().slice(0, 8);

/**
 * Markers for one map, persisted in this browser. Kept behind this hook so a
 * shared group store (backend sync) can replace it without touching the UI.
 */
export function useMarkers(mapId: string) {
  const [markers, setMarkers] = useState<Marker[]>(() => readJson(key(mapId), []));

  useEffect(() => setMarkers(readJson(key(mapId), [])), [mapId]);

  const commit = useCallback(
    (update: (prev: Marker[]) => Marker[]) =>
      setMarkers((prev) => {
        const next = update(prev);
        writeJson(key(mapId), next);
        return next;
      }),
    [mapId],
  );

  return {
    markers,
    add: useCallback((m: Marker) => commit((p) => [...p, m]), [commit]),
    update: useCallback((id: string, patch: Partial<Marker>) => commit((p) => p.map((m) => (m.id === id ? { ...m, ...patch } : m))), [commit]),
    remove: useCallback((id: string) => commit((p) => p.filter((m) => m.id !== id)), [commit]),
    replaceAll: useCallback((next: Marker[]) => commit(() => next), [commit]),
  };
}

// --- Sharing -----------------------------------------------------------------
// Markers travel inside the link itself (deflated + base64url), so sharing a
// set with your group needs no account and no server.

type Packed = [number, number, string, string, string];

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Blob([bytes as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

const toB64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64Url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

export async function encodeMarkers(markers: Marker[]): Promise<string> {
  const packed: Packed[] = markers.map((m) => [Math.round(m.x), Math.round(m.z), m.label, m.color, m.icon]);
  const json = new TextEncoder().encode(JSON.stringify(packed));
  return toB64Url(await pipe(json, new CompressionStream("deflate-raw")));
}

export async function decodeMarkers(payload: string): Promise<Marker[]> {
  const json = await pipe(fromB64Url(payload), new DecompressionStream("deflate-raw"));
  const packed = JSON.parse(new TextDecoder().decode(json)) as Packed[];
  return packed.map(([x, z, label, color, icon]) => ({ id: newId(), x, z, label, color, icon: icon as MarkerIcon }));
}

/** Two markers at the same spot with the same label are the same marker. */
export const sameMarker = (a: Marker, b: Marker) =>
  Math.round(a.x) === Math.round(b.x) && Math.round(a.z) === Math.round(b.z) && a.label === b.label;
