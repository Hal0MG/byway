// Builds public/road-points.json: a point and a photo for every road the app knows (the National Scenic Byways and the
// hand-picked drives), so "Roads near me" can work out what's within reach with plain arithmetic, no service at runtime.
// The point is the road's Wikipedia article location, else OpenStreetMap's match for "road name, state". Uses the running
// app (its Wikipedia and place caches and polite rate limits): start the app, then `node tools/build-road-points.mjs`.
import fs from "node:fs";

const APP = process.env.APP || "http://localhost:3000";
const read = (f) => JSON.parse(fs.readFileSync(new URL(`../data/${f}`, import.meta.url), "utf8"));
const list = (d) => (Array.isArray(d) ? d : d.byways || d.drives || Object.values(d));

const roads = [];
for (const b of list(read("byways.json"))) {
  // a byway's ends as plain places when they read like one ("Gouldsboro"), else what's in them ("SR 39 in Loudonville")
  const plain = [b.from, b.to].filter((t) => t && t.length < 40 && !/\d|;|\bof\b|\bline\b/i.test(t));
  roads.push({ name: b.name, wiki: b.wiki, type: b.type, states: b.states, country: "United States", km: b.miles ? Math.round(b.miles * 1.609) : null, about: b.description || "", ends: `${b.from || ""}; ${b.to || ""}`, plain });
}
const COUNTRY = { us: "United States", ca: "Canada", au: "Australia", nz: "New Zealand", uk: "United Kingdom", alps: "" };
for (const f of ["us", "ca", "au", "nz", "uk", "alps"]) {
  for (const d of list(read(`${f}-drives.json`))) {
    // the Alps files name the country last ("Lombardy", "Trentino-Alto Adige", "Italy")
    const country = COUNTRY[f] || d.states.at(-1);
    const states = d.states.filter((x) => x !== country);
    roads.push({ name: d.name, wiki: d.wiki, type: "Famous drive", ref: d.ref || "", states: states.length ? states : [country], country, km: d.km || null, about: d.description || "" });
  }
}
// The first place a description names: "Te Anau to Milford Sound...", "...road from Torquay to Allansford..."
// Places named after "in", "near" or "at": "SR 39 in Loudonville; US 62 near Brinkhaven"
const placesIn = (t) => [...String(t || "").matchAll(/\b(?:in|near|at|of) ((?:the )?[A-Z][A-Za-z'’.-]+(?: [A-Z][A-Za-z'’.-]+){0,3})/g)].map((m) => m[1]);
const firstPlace = (t) => (String(t).match(/(?:^|\bfrom |\bbetween )([A-Z][A-Za-z'’.-]+(?: [A-Z][A-Za-z'’.-]+){0,3})(?= to\b| and\b| up\b| around\b| through\b| over\b|,)/) || [])[1] || "";

// Roads no lookup places: set by hand (a town or park on the road)
const BY_HAND = {
  "International Selkirk Loop": [-116.553, 48.276], // Sandpoint, Idaho
  "Peter Norbeck Scenic Byway": [-103.45, 43.77], // Custer State Park, South Dakota
  "Highway 60 through Algonquin": [-78.4, 45.55], // Algonquin Park, Ontario
  "Fundy Coastal Drive (Route 114)": [-64.95, 45.6], // Fundy National Park, New Brunswick
  "Central Coastal Drive (Green Gables Shore)": [-63.38, 46.49], // Cavendish, Prince Edward Island
  "Grand Pacific Drive": [150.97, -34.25], // the Sea Cliff Bridge, New South Wales
};
const post = (path, body) => fetch(`${APP}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const out = [];
let fromWiki = 0;
let fromPlace = 0;
for (let i = 0; i < roads.length; i += 40) {
  const batch = roads.slice(i, i + 40);
  const r = await post("/api/enrich", { roads: batch.map((x, k) => ({ key: String(k), wiki: x.wiki, name: x.name })) });
  for (const [k, x] of batch.entries()) {
    const w = r.roads?.[String(k)] || {};
    let p = w.lat != null ? [w.lng, w.lat] : BY_HAND[x.name] || null;
    if (w.lat != null) fromWiki++;
    else if (p) fromPlace++;
    else {
      // the road by name, then where a byway starts, then the first place its description names; with the first
      // state and the country (several states in one query find nothing), then the country alone
      const name = x.name.replace(/\s*\(.*?\)/g, "").replace(/ - .*$/, "");
      const where = [...new Set([`${x.states[0]}, ${x.country}`, x.country])];
      const places = [...new Set([name, ...(x.plain || []), ...placesIn(x.ends), firstPlace(x.about), ...placesIn(x.about)].filter(Boolean))].slice(0, 5);
      const tries = places.flatMap((pl) => where.map((w) => `${pl}, ${w}`));
      for (const q of tries) {
        const g = await fetch(`${APP}/api/geocode?q=${encodeURIComponent(q)}`).then((res) => res.json()).catch(() => ({}));
        const h = g.hits?.[0];
        if (h) {
          p = [h.lng, h.lat];
          fromPlace++;
          break;
        }
      }
    }
    if (!p) {
      console.log("no point:", x.name);
      continue;
    }
    out.push({
      name: x.name, type: x.type, ...(x.ref ? { ref: x.ref } : {}), state: x.states[0],
      km: x.km, about: x.about, at: p.map((v) => Math.round(v * 1e4) / 1e4), image: w.image || "", url: w.url || "",
    });
  }
  console.log(`${Math.min(i + 40, roads.length)} of ${roads.length}`);
}
fs.writeFileSync(new URL("../public/road-points.json", import.meta.url), JSON.stringify({ built: new Date().toISOString().slice(0, 10), roads: out }) + "\n");
console.log(`${out.length} roads: ${fromWiki} from Wikipedia, ${fromPlace} from OpenStreetMap, ${roads.length - out.length} without a point`);
