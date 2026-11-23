// Every locale must have exactly the keys of es.json (plural suffixes may vary by language).
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../src/i18n/locales/", import.meta.url);
const flat = (obj, prefix = "") =>
  Object.entries(obj).flatMap(([k, v]) => (v && typeof v === "object" ? flat(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
const keys = (file) => new Set(flat(JSON.parse(readFileSync(new URL(file, dir), "utf8"))).map((k) => k.replace(/_(zero|one|two|few|many|other)$/, "")));

const base = keys("es.json");
let failed = false;
for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "es.json")) {
  const k = keys(file);
  const missing = [...base].filter((x) => !k.has(x));
  const extra = [...k].filter((x) => !base.has(x));
  if (missing.length || extra.length) {
    failed = true;
    console.error(`${file}:`, missing.length ? `\n  missing: ${missing.join(", ")}` : "", extra.length ? `\n  extra: ${extra.join(", ")}` : "");
  }
}
if (failed) process.exit(1);
console.log("locales ok");
