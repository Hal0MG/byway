// Checks every ready-made trip with the app's own measurements, read-only (nothing is saved, no AI, no routing):
// long and very short days, featured roads the route doesn't drive, backtracking the app could fix, overnights with no
// places to stay nearby, spots far off the route, missing heights and photos.
// Usage, with the app running: CHROME_PATH=<chrome-headless-shell> node tools/audit-trips.mjs [--json out.json]
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || "http://localhost:3000";
const jsonOut = process.argv.includes("--json") ? process.argv[process.argv.indexOf("--json") + 1] : null;
if (!process.env.CHROME_PATH) {
  console.error("Set CHROME_PATH to a chrome-headless-shell.");
  process.exit(2);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { presets } = await fetch(`${APP}/api/presets`).then((r) => r.json());
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: "shell",
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "byway-audit-")),
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
const report = [];
for (const p of presets) {
  await page.goto(`${APP}/?trip=${p.id}&view=read`, { waitUntil: "load" });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await page.evaluate((id) => trip.id === id && !!routes.scenic, p.id)) break;
  }
  const r = await page.evaluate(() => {
    const groups = dayGroups();
    const limit = longDayS();
    const days = groups.map((g) => ({ day: g.day, h: Math.round(((dayStats(g, "scenic")?.dur || 0) / 3600) * 10) / 10 }));
    const segsByDay = new Map(groups.map((g) => [g.day, daySegments(g)]));
    const roads = (plan?.roads || []).map((road) => {
      let m = 0;
      for (const segs of segsByDay.values()) for (const s of segs) if (s.road === road) m += s.distance_m;
      return { name: road.name, km: Math.round(m / 1000) };
    });
    const overnights = groups.slice(0, -1).map((g) => {
      const lodging = alongFor(g.day)?.lodging;
      const n = lodging ? (lodging.hotel || 0) + (lodging.guest || 0) + (lodging.motel || 0) + (lodging.camp || 0) : null;
      return { day: g.day, town: shortName(stops[g.items.at(-1)].name), lodging: n };
    });
    const spotsOff = [];
    for (const g of groups) {
      const line = dayLine(g.day);
      for (const s of (plan?.spots || []).filter((x) => x.day === g.day)) {
        const pos = spotAlong(line, s);
        if (pos && pos.offKm > 25) spotsOff.push({ day: g.day, name: s.name, km: Math.round(pos.offKm) });
      }
    }
    return {
      name: trip.name,
      days,
      long: days.filter((d) => d.h * 3600 > limit),
      short: days.filter((d) => d.h < 1 && groups.length > 1),
      roadsNotDriven: roads.filter((x) => x.km < 8),
      backtrackKm: Math.round((orderFixPreview() || 0) / 1000),
      noLodging: overnights.filter((o) => o.lodging === 0),
      lodgingUnknown: overnights.filter((o) => o.lodging == null).length,
      spotsOff,
      heights: hasElevation(),
      spotsNoPhoto: (plan?.spots || []).filter((s) => !s.info?.image).length,
      spots: (plan?.spots || []).length,
    };
  });
  report.push({ id: p.id, ...r });
  const issues = [
    r.long.length && `long days ${r.long.map((d) => `D${d.day} ${d.h}h`).join(", ")}`,
    r.short.length && `short days ${r.short.map((d) => `D${d.day} ${d.h}h`).join(", ")}`,
    r.roadsNotDriven.length && `featured roads not driven: ${r.roadsNotDriven.map((x) => `${x.name} (${x.km} km)`).join(", ")}`,
    r.backtrackKm >= 20 && `backtracking: ${r.backtrackKm} km shorter in another order`,
    r.noLodging.length && `no stays near: ${r.noLodging.map((o) => `D${o.day} ${o.town}`).join(", ")}`,
    r.spotsOff.length && `spots far off the route: ${r.spotsOff.map((s) => `${s.name} (${s.km} km)`).join(", ")}`,
    !r.heights && "no heights",
    r.spotsNoPhoto > r.spots / 3 && `${r.spotsNoPhoto} of ${r.spots} spots without a photo`,
  ].filter(Boolean);
  console.log(`${issues.length ? "✗" : "✓"} ${r.name}${issues.length ? `\n    ${issues.join("\n    ")}` : ""}`);
}
await browser.close();
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(report, null, 1));
const bad = report.filter((r) => r.long.length || r.roadsNotDriven.length || r.backtrackKm >= 20 || r.noLodging.length || r.spotsOff.length || r.short.length);
console.log(`\n${report.length} trips, ${bad.length} with plan problems, ${report.filter((r) => r.lodgingUnknown).length} with stays not looked up, ${report.filter((r) => !r.heights).length} without heights`);
