// Adds heights to the ready-made trips whose routes were measured by the backup router before it had them (their day
// charts were flat). The routes themselves don't change: only the third number of every point. Through the running app
// (/api/heights, Open-Meteo), which stops at its hourly and daily share of free lookups: run it again later for the rest
// (about two trips an hour). Then `node tools/export-presets.mjs`. Usage: node tools/add-heights.mjs [--dry]
const APP = process.env.APP || "http://localhost:3000";
const dry = process.argv.includes("--dry");
const json = (r) => r.json();
const { presets } = await fetch(`${APP}/api/presets`).then(json);
let done = 0;
for (const p of presets) {
  const t = await fetch(`${APP}/api/trips/${p.id}`).then(json);
  const modes = Object.entries(t.routes || {}).filter(([, r]) => r?.geometry?.coordinates?.length > 1 && r.geometry.coordinates[0].length < 3);
  if (!modes.length) continue;
  if (!t.preset) {
    console.log(`skipped ${t.name}: not a ready-made trip on this computer`);
    continue;
  }
  console.log(`${t.name}: ${modes.map(([m, r]) => `${m} ${r.geometry.coordinates.length} points`).join(", ")}`);
  if (dry) continue;
  for (const [, r] of modes) {
    const h = await fetch(`${APP}/api/heights`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ coordinates: r.geometry.coordinates }) }).then(json);
    if (!h.coordinates) {
      console.log(`Stopped at ${t.name}: ${h.error} Run it again later.`);
      process.exit(done ? 0 : 1);
    }
    r.geometry.coordinates = h.coordinates;
    r.note = String(r.note || "").replace("no elevation or road surface this time", "heights from Open-Meteo, no road surface this time");
  }
  const s = await fetch(`${APP}/api/trips/${t.id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(t) }).then(json);
  if (!s.id) throw new Error(`${t.name}: not saved`);
  done++;
}
console.log(dry ? "Dry run: nothing changed." : `${done} trip(s) got heights. Now run: node tools/export-presets.mjs`);
