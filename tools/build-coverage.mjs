// Builds public/coverage.json: the regions the planner covers (it has a road catalog for them) and a grey mask
// for everywhere else. Boundaries: Natural Earth states and provinces (public domain), simplified.
// Usage: node tools/build-coverage.mjs   (needs the dev dependency @turf/turf; downloads about 45 MB)
// When a region gets a road catalog (data/*-drives.json), add it to COVERED and run this again.
import * as turf from "@turf/turf";
import fs from "node:fs";

// Per country: "all" (every state or province), a list of state/province names, or { region: [...] } to pick by the
// "region" field (Italy and France list provinces and departments, grouped into regions).
// US, Canada and Australia come from the 1:50m file, the rest from the more detailed 1:10m file.
const COVERED = {
  US: "all",
  CA: ["British Columbia", "Alberta", "Saskatchewan", "Manitoba", "Ontario", "Québec", "New Brunswick", "Nova Scotia",
    "Prince Edward Island", "Newfoundland and Labrador"],
  AU: ["New South Wales", "Victoria", "Australian Capital Territory", "Queensland", "Tasmania"],
  NZ: { region: ["North Island", "South Island"] },
  GB: "all",
  // the Alps
  CH: "all",
  AT: "all",
  LI: "all",
  DE: ["Bayern"],
  IT: { region: ["Valle d'Aosta", "Piemonte", "Lombardia", "Trentino-Alto Adige", "Veneto", "Friuli-Venezia Giulia"] },
  FR: { region: ["Auvergne-Rhône-Alpes", "Provence-Alpes-Côte-d'Azur"] },
};
const FROM_50M = new Set(["US", "CA", "AU"]);

const base = "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/";
const get = async (f) => (await fetch(base + f)).json();
const [m50, m10] = await Promise.all([get("ne_50m_admin_1_states_provinces.geojson"), get("ne_10m_admin_1_states_provinces.geojson")]);

const wanted = (f) => {
  const cc = f.properties.iso_a2;
  const want = COVERED[cc];
  if (!want) return false;
  if (want === "all") return true;
  if (Array.isArray(want)) return want.includes(f.properties.name);
  return want.region.includes(f.properties.region);
};
const picked = [
  ...m50.features.filter((f) => FROM_50M.has(f.properties.iso_a2) && wanted(f)),
  ...m10.features.filter((f) => !FROM_50M.has(f.properties.iso_a2) && wanted(f)),
];
for (const [cc, want] of Object.entries(COVERED)) {
  const got = picked.filter((f) => f.properties.iso_a2 === cc);
  if (Array.isArray(want)) {
    for (const n of want) if (!got.some((f) => f.properties.name === n)) console.log(`MISSING ${cc}: ${n}`);
  }
  console.log(`${cc}: ${got.length} areas`);
}

// One shape per country: merged first, then simplified (simplifying each state first leaves thin seams between them).
const regions = [];
for (const cc of Object.keys(COVERED)) {
  const parts = picked.filter((f) => f.properties.iso_a2 === cc);
  if (!parts.length) continue;
  let u = parts.length > 1 ? turf.union(turf.featureCollection(parts)) : parts[0];
  u = turf.simplify(u, { tolerance: 0.03, highQuality: true });
  u.properties = { country: cc };
  regions.push(u);
}
const covered = turf.featureCollection(regions);

// The mask: the world with the covered regions cut out.
const world = turf.bboxPolygon([-180, -85, 180, 85]);
const mask = turf.difference(turf.featureCollection([world, ...regions.map((r) => ({ ...r, properties: {} }))]));
mask.properties = {};

const out = { covered, mask, regions: COVERED };
fs.writeFileSync(new URL("../public/coverage.json", import.meta.url), JSON.stringify(out));
const kb = Math.round(JSON.stringify(out).length / 1024);
console.log(`wrote public/coverage.json (${kb} KB, ${regions.length} countries)`);
