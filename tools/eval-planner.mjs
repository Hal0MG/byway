// Planner eval: runs a fixed set of trip requests (eval/prompts.json) through one or more AI models and the app's own
// pipeline, and records how good each plan is at every stage, so models and prompt changes can be compared on numbers.
//
// Per request: the model's plan (/api/plan with evalModel: that model alone, no fallbacks), the plan checks before and
// after the model's one repair, geocoding (how often the route-aware pick overrode the top search result), dropped
// detours, the backtracking fix, routing, featured roads driven before and after the road pass, long days before and
// after the day-split DP, and what's left. It stops before the day guides and photos. Nothing is saved (the page's
// save is switched off), so it leaves no trips behind.
//
// Usage, with the app running and Gemini set up:
//   CHROME_PATH=<chrome-headless-shell> node tools/eval-planner.mjs --models gemini-flash-lite-latest[,other] \
//     [--only us-pch,no-fjords] [--repeat 2] [--out eval/results/<name>] [--prompts other.json]
// Then: node tools/eval-report.mjs eval/results/<name>
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || "http://localhost:3000";
const arg = (name, def) => (process.argv.includes(`--${name}`) ? process.argv[process.argv.indexOf(`--${name}`) + 1] : def);
const models = arg("models", "gemini-flash-lite-latest").split(",");
const only = arg("only", "") ? arg("only").split(",") : null;
const repeat = Number(arg("repeat", 1));
const out = arg("out", `eval/results/${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`);
if (!process.env.CHROME_PATH) {
  console.error("Set CHROME_PATH to a chrome-headless-shell.");
  process.exit(2);
}
const prompts = JSON.parse(fs.readFileSync(arg("prompts", "eval/prompts.json"), "utf8")).filter((p) => !only || only.includes(p.id));
fs.mkdirSync(out, { recursive: true });

// The road catalog the planner is given, to count featured roads that are real catalog roads (grounding).
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const catalog = [
  ...JSON.parse(fs.readFileSync("data/byways.json", "utf8")),
  ...fs.readdirSync("data").filter((f) => f.endsWith("-drives.json")).flatMap((f) => JSON.parse(fs.readFileSync(`data/${f}`, "utf8"))),
].map((b) => norm(b.name)).filter((n) => n.length > 3);
const grounded = (r) => !!r.official || catalog.some((c) => norm(r.name).includes(c) || c.includes(norm(r.name)));

// A fresh tab per request, and a new browser when the old one died (a crashed tab took the rest of a run with it).
let browser = null;
async function newPage() {
  if (!browser?.connected) {
    await browser?.close().catch(() => {});
    browser = await puppeteer.launch({
      executablePath: process.env.CHROME_PATH,
      headless: "shell",
      protocolTimeout: 900000,
      userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "byway-eval-")),
    });
  }
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.log("  page error:", e.message));
  return page;
}

// One request through the pipeline, in a new tab. Returns the record (or { error }).
async function runOne(p, model) {
  const page = await newPage();
  try {
    return await runIn(page, p, model);
  } finally {
    await page.close().catch(() => {});
  }
}
async function runIn(page, p, model) {
  await page.goto(APP, { waitUntil: "load" });
  await page.waitForFunction(() => typeof newTrip === "function" && typeof map !== "undefined", { timeout: 30000 });
  return page.evaluate(async ({ prompt, settings, model }) => {
    // nothing is saved
    scheduleSave = () => {};
    saveNow = async () => {};
    await newTrip();
    trip.prompt = prompt;
    trip.settings = { ...(settings || {}) };
    const rec = { model };
    const t0 = performance.now();
    let res;
    try {
      res = await api("/api/plan", { prompt, settings: tripSettings(), evalModel: model });
    } catch (e) {
      return { ...rec, error: e.message, msPlan: Math.round(performance.now() - t0) };
    }
    rec.msPlan = Math.round(performance.now() - t0);
    rec.modelUsed = res.model;
    rec.checks = res.checks;
    const skel = res.plan;
    rec.daysAsked = askedDays(prompt);
    rec.daysPlanned = (skel.days || []).length;
    rec.points = (skel.points || []).length;
    rec.roadsPlanned = (skel.roads || []).map((r) => ({ name: r.name, ref: r.ref || "", official: !!r.official }));

    // instrument the cleaning steps (they're globals, so placePoints calls these wrappers)
    const orig = { geocodeAll, pickAlongRoute, dropDetours, fixOrder };
    rec.geocodeFailed = 0;
    geocodeAll = async (...a) => {
      try {
        return await orig.geocodeAll(...a);
      } catch (e) {
        rec.geocodeFailed++;
        throw e;
      }
    };
    pickAlongRoute = (pts) => {
      const top = pts.map((x) => [x.lng, x.lat]);
      const len = (ps) => ps.slice(1).reduce((s, q, i) => s + haversine(ps[i], q), 0);
      orig.pickAlongRoute(pts);
      const chosen = pts.map((x) => [x.lng, x.lat]);
      rec.viterbiChanged = chosen.filter((c, i) => haversine(c, top[i]) > 1000).length;
      rec.viterbiKmSaved = Math.round((len(top) - len(chosen)) / 1000);
    };
    dropDetours = (pts) => {
      const r = orig.dropDetours(pts);
      rec.detoursDropped = r.length;
      return r;
    };
    fixOrder = (pts) => {
      const r = orig.fixOrder(pts);
      rec.reorderKm = Math.round(r / 1000);
      return r;
    };
    await placePoints(skel);
    Object.assign(window, orig);

    const t1 = performance.now();
    if (!(await findRoutes({ fit: false }))) return { ...rec, error: `routing: ${$("status").textContent}` };
    rec.engine = routes.scenic?.engine || "ors";
    const undriven = () => (plan.roads || []).filter((r) => metersOnRoad(r) < 8047).map((r) => r.name);
    const dayHours = () => dayGroups().map((g) => Math.round(((dayStats(g, "scenic")?.dur || 0) / 360)) / 10);
    rec.roadsTotal = (plan.roads || []).length;
    rec.undrivenBefore = undriven();
    await driveFeaturedRoads();
    rec.undrivenAfter = undriven();
    rec.limitH = longDayS() / 3600;
    rec.hoursBefore = dayHours();
    rec.longBefore = longDays().length;
    // the app's first answer to long days: move the overnights along the same route (exact DP, no AI); the AI rebalance
    // that follows in the app when this can't fix them isn't part of the eval
    rec.balanced = !!balanceDays();
    rec.hoursAfter = dayHours();
    rec.longAfter = longDays().length;
    rec.daysFinal = dayGroups().length;
    rec.km = Math.round((routes.scenic?.distance_m || 0) / 1000);
    // km on any featured road (two roads on the same highway count once)
    rec.featuredKm = Math.round(dayGroups().flatMap((g) => daySegments(g)).filter((x) => x.road).reduce((a, x) => a + x.distance_m, 0) / 1000);
    rec.backtrackLeftKm = Math.round((orderFixPreview() || 0) / 1000);
    rec.uncovered = uncoveredStops().length;
    rec.msPipeline = Math.round(performance.now() - t1);
    return rec;
  }, { prompt: p.prompt, settings: p.settings, model });
}

for (const model of models) {
  const file = path.join(out, `${model}.jsonl`);
  // resume: keep the finished requests, run the rest again (failed ones too)
  const kept = fs.existsSync(file)
    ? [...new Map(fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((r) => !r.error).map((r) => [`${r.id}#${r.rep}`, r])).values()]
    : [];
  fs.writeFileSync(file, kept.map((r) => `${JSON.stringify(r)}\n`).join(""));
  const done = new Set(kept.map((r) => `${r.id}#${r.rep}`));
  let limited = 0;
  console.log(`\n${model}${kept.length ? ` (${kept.length} already done)` : ""}`);
  for (let rep = 0; rep < repeat; rep++) {
    for (const p of prompts) {
      if (limited >= 3) break;
      if (done.has(`${p.id}#${rep}`)) continue;
      const t = Date.now();
      let rec;
      let tries = 0;
      // Google's free models say "busy" in bursts; the app retries for 30 s, the eval waits longer before giving up
      for (const wait of [0, 30, 60, 120]) {
        if (wait) {
          console.log(`  … ${p.id}: busy, trying again in ${wait} s`);
          await new Promise((r) => setTimeout(r, wait * 1000));
        }
        tries++;
        try {
          rec = await runOne(p, model);
        } catch (e) {
          rec = { model, error: `harness: ${e.message}` };
        }
        // busy, or the tab crashed (it happens now and then in headless Chrome): try again in a new tab
        if (!/busy|high demand|overloaded|Target closed|Session closed/i.test(rec.error || "")) break;
      }
      rec = { id: p.id, region: p.region, rep, tries, ...rec };
      if (rec.roadsPlanned) rec.roadsGrounded = rec.roadsPlanned.filter(grounded).length;
      limited = /quota|limit|429/i.test(rec.error || "") ? limited + 1 : 0;
      fs.appendFileSync(file, `${JSON.stringify(rec)}\n`);
      const s = Math.round((Date.now() - t) / 1000);
      console.log(rec.error
        ? `  ✗ ${p.id}: ${rec.error.slice(0, 160)} (${s} s)`
        : `  ✓ ${p.id}: checks ${rec.checks.found}→${rec.checks.left}, roads undriven ${rec.undrivenBefore.length}→${rec.undrivenAfter.length}/${rec.roadsTotal}, long days ${rec.longBefore}→${rec.longAfter}, ${rec.km} km (${s} s)`);
    }
  }
  if (limited >= 3) console.log(`  stopped ${model}: it hit its limit 3 times in a row`);
}
await browser?.close();
console.log(`\nResults in ${out}. Report: node tools/eval-report.mjs ${out}`);
