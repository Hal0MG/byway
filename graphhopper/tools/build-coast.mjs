// Regenerates custom_models/coast.json: a corridor around Highway 1 / PCH, the coastal
// US 101 stretches, the San Diego coast (Old 101) and the north coast (US 101 Eureka-Oregon).
// Traces the roads with the running GraphHopper (car profile), so start it first.
// Usage, from the graphhopper folder:
//   npm.cmd install --no-save @turf/turf@7.1.0
//   node tools/build-coast.mjs [buffer_km=1.5] [boost=2]
// Then delete graph-<region> and restart GraphHopper.
import * as turf from "@turf/turf";
import fs from "node:fs";

const km = parseFloat(process.argv[2] || "1.5");
const boost = process.argv[3] || "2";
const out = new URL("../custom_models/coast.json", import.meta.url);

// [lat, lon] along Highway 1, north to south
const wp = [
  [39.8740, -123.7200], // Leggett (north end)
  [39.7385, -123.8170], [39.6363, -123.7822], [39.4457, -123.8053], [39.3077, -123.7995],
  [39.1316, -123.7164], [38.9088, -123.6928], [38.7660, -123.5281], [38.7150, -123.4530],
  [38.4499, -123.1158], [38.3333, -123.0481], [38.2466, -122.9050], [38.0691, -122.8069],
  [38.0410, -122.7889], [37.9005, -122.6444], [37.8625, -122.5800], [37.8730, -122.5150],
  [37.7470, -122.4757], [37.6138, -122.4869], [37.4636, -122.4286], [37.2617, -122.4122],
  [37.0116, -122.1963], [36.9620, -122.0400], [36.9772, -121.8994], [36.8044, -121.7869],
  [36.6844, -121.8022], [36.5960, -121.8790], [36.5450, -121.9070], [36.3715, -121.9017],
  [36.2704, -121.8081], [36.0222, -121.5497], [35.7786, -121.3289], [35.6438, -121.1897],
  [35.5641, -121.0807], [35.4428, -120.8920], [35.3658, -120.8499], [35.2828, -120.6596],
  [35.1428, -120.6413], [35.0989, -120.6127], [34.9716, -120.5718], [34.6391, -120.4579],
  [34.5100, -120.2270], [34.4717, -120.2195], [34.4140, -119.6900], [34.3989, -119.5185],
  [34.2746, -119.2290], [34.1975, -119.1771], [34.0866, -119.0610], [34.0216, -118.8318],
  [34.0359, -118.6772], [34.0177, -118.5010], [33.9880, -118.4460], [33.9300, -118.3960],
  [33.8550, -118.3800], [33.7950, -118.3300], [33.7900, -118.1900], [33.7414, -118.1048],
  [33.6550, -118.0020], [33.6170, -117.9290], [33.5990, -117.8690], [33.5427, -117.7854],
  [33.4669, -117.6981], [33.4620, -117.6720], // Dana Point / I-5 (south end)
];

// Extra coastal chains where every road between the waypoints counts
const sandiego = [
  [33.4620, -117.6720], [33.4270, -117.6120], [33.1959, -117.3795], [33.1581, -117.3506],
  [33.0369, -117.2920], [32.9595, -117.2653], [32.9200, -117.2530], [32.8328, -117.2713],
];
const northcoast = [
  [40.8021, -124.1637], [40.8665, -124.0828], [41.0593, -124.1431], [41.2876, -124.0592],
  [41.5265, -124.0384], [41.7558, -124.2026], [41.9980, -124.2050],
];
const chains = [[wp, /\bCA 1\b|\bUS 101\b/], [sandiego, null], [northcoast, null]];

const lines = [];
const gaps = [];
for (const [pts0, keep] of chains) for (let i = 0; i < pts0.length - 1; i++) {
  const [a, b] = [pts0[i], pts0[i + 1]];
  const u = `http://localhost:8989/route?point=${a}&point=${b}&profile=car&instructions=false&points_encoded=false&details=street_ref`;
  const r = await fetch(u.replaceAll(",", "%2C").replace(/point=([^&]+)/g, (m, p) => `point=${p}`));
  const d = await r.json();
  if (!r.ok) { gaps.push(`leg ${i}: ${d.message}`); continue; }
  const path = d.paths[0];
  const pts = path.points.coordinates;
  let kept = 0;
  const refs = new Set();
  for (const [from, to, ref] of path.details.street_ref) {
    if (ref) refs.add(ref);
    if ((!keep || (ref && keep.test(ref))) && to > from) {
      lines.push(pts.slice(from, to + 1));
      kept += turf.length(turf.lineString(pts.slice(from, to + 1)));
    }
  }
  const total = path.distance / 1000;
  if (kept / total < 0.8) gaps.push(`leg ${i} ${a} -> ${b}: kept ${kept.toFixed(1)} of ${total.toFixed(1)} km, refs: ${[...refs].join(" | ")}`);
}
console.log(gaps.length ? "legs with little CA 1:\n  " + gaps.join("\n  ") : "all legs on CA 1 / US 101");

const ml = turf.simplify(turf.multiLineString(lines), { tolerance: 0.0005 });
let poly = turf.buffer(ml, km, { units: "kilometers", steps: 4 });
poly = turf.simplify(poly, { tolerance: 0.002, highQuality: true });
const g = poly.geometry;
const count = (g.type === "Polygon" ? [g.coordinates] : g.coordinates).flat(2).length;
console.log(`segments: ${lines.length}, type: ${g.type}, vertices: ${count}`);
const feature = { type: "Feature", id: "coast", properties: {}, geometry: g };
fs.writeFileSync(out, JSON.stringify({
  priority: [{ if: "in_coast", multiply_by: boost }],
  areas: { type: "FeatureCollection", features: [feature] },
}));
console.log(`wrote ${out.pathname}`);
