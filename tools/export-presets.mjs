// Copies the ready-made trips built on this PC (preset: true in data/trips.json) into data/presets.json, which ships
// with the app, so a fresh install has trips that open instantly. Personal parts (notes, versions) are left out.
// Usage: node tools/export-presets.mjs
import fs from "node:fs";

const dir = new URL("../data/", import.meta.url);
const trips = JSON.parse(fs.readFileSync(new URL("trips.json", dir), "utf8"));
let out = {};
try {
  out = JSON.parse(fs.readFileSync(new URL("presets.json", dir), "utf8"));
} catch {
  // first export
}
let n = 0;
for (const t of Object.values(trips)) {
  if (!t.preset) continue;
  out[t.id] = { ...t, versions: [], notes: { text: "", items: [] }, edits: [] };
  n++;
}
fs.writeFileSync(new URL("presets.json", dir), JSON.stringify(out));
console.log(`${n} ready-made trips exported, ${Object.keys(out).length} in data/presets.json`);
