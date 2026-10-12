// Checks public/seasonal-roads.json: geocodes each road's "where" with Nominatim and reports points that are far
// from where OpenStreetMap puts that place. Usage: node tools/check-seasonal.mjs
import fs from "node:fs";

const file = new URL("../public/seasonal-roads.json", import.meta.url);
const { roads } = JSON.parse(fs.readFileSync(file, "utf8"));
const UA = "RoadtripPlanner/1.12 (personal trip planner, data check)";
const toRad = (d) => (d * Math.PI) / 180;
const km = (a, b) => {
  const x = Math.sin(toRad(b[1] - a[1]) / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(toRad(b[0] - a[0]) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
};

for (const r of roads) {
  if (!r.where || !r.at?.length) continue;
  await new Promise((ok) => setTimeout(ok, 1100));
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(r.where)}`;
  const d = await (await fetch(u, { headers: { "User-Agent": UA } })).json().catch(() => []);
  if (!d[0]) {
    console.log(`?? ${r.name}: "${r.where}" not found`);
    continue;
  }
  const p = [Number(d[0].lon), Number(d[0].lat)];
  const off = km(p, r.at[0]);
  console.log(`${off > 3 ? "!!" : "ok"} ${off.toFixed(1).padStart(6)} km  ${r.name}  osm=[${p[0].toFixed(4)}, ${p[1].toFixed(4)}]  (${d[0].display_name.slice(0, 70)})`);
}
