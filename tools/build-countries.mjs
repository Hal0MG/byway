// Builds public/countries.json: every country's outline (Natural Earth 1:50m, public domain, simplified) with its ISO
// code, so the app knows which country a place is in anywhere in the world (units, currency, the Trips tab's regions)
// without asking a server. The covered regions with road lists still come from coverage.json.
// Usage: node tools/build-countries.mjs   (needs the @turf/turf dev dependency)
import fs from "node:fs";
import * as turf from "@turf/turf";

const base = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/";
const world = await (await fetch(base + "ne_50m_admin_0_countries.geojson")).json();
const r3 = (v) => Math.round(v * 1e3) / 1e3;
const round = (c) => (typeof c[0] === "number" ? [r3(c[0]), r3(c[1])] : c.map(round));
const features = [];
for (const f of world.features) {
  const p = f.properties;
  // a few countries have iso_a2 "-99" in Natural Earth (France, Norway, Kosovo); their other codes are right
  const cc = [p.ISO_A2, p.ISO_A2_EH, p.WB_A2].find((x) => /^[A-Z]{2}$/.test(x || ""));
  if (!cc) continue;
  const simple = turf.simplify(f, { tolerance: 0.06, highQuality: false });
  features.push({ type: "Feature", properties: { cc, name: p.NAME }, geometry: { type: simple.geometry.type, coordinates: round(simple.geometry.coordinates) } });
}
const out = JSON.stringify({ type: "FeatureCollection", features });
fs.writeFileSync("public/countries.json", out);
console.log(`wrote public/countries.json (${Math.round(out.length / 1024)} KB, ${features.length} countries)`);
