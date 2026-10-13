// Report for a planner eval run (tools/eval-planner.mjs): per model, the share of plans that pass at each stage of the
// pipeline, the metrics behind them with 95% bootstrap intervals (resampling requests), and the problems found.
// Usage: node tools/eval-report.mjs eval/results/<name>   (writes report.md there and prints it)
import fs from "node:fs";
import path from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("Usage: node tools/eval-report.mjs eval/results/<name>");
  process.exit(2);
}
const runs = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => ({
  model: f.replace(/\.jsonl$/, ""),
  recs: fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)),
}));

// seeded random numbers, so the same results give the same intervals
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
// statistic over records -> [value, lo, hi], percentile bootstrap with 2,000 resamples of the records
function boot(recs, stat, B = 2000) {
  const v = stat(recs);
  if (!recs.length || !Number.isFinite(v)) return [v, NaN, NaN];
  const vals = [];
  for (let b = 0; b < B; b++) {
    const s = Array.from({ length: recs.length }, () => recs[Math.floor(rand() * recs.length)]);
    const x = stat(s);
    if (Number.isFinite(x)) vals.push(x);
  }
  vals.sort((a, c) => a - c);
  return [v, vals[Math.floor(vals.length * 0.025)], vals[Math.floor(vals.length * 0.975)]];
}
const share = (pred) => (rs) => mean(rs.map((r) => (pred(r) ? 1 : 0)));
// pooled ratio (sum of a / sum of b): roads driven out of roads planned, and so on
const ratio = (a, b) => (rs) => rs.reduce((s, r) => s + a(r), 0) / rs.reduce((s, r) => s + b(r), 0);
const pct = ([v, lo, hi]) => (Number.isFinite(v) ? `${Math.round(v * 100)}% (${Math.round(lo * 100)} to ${Math.round(hi * 100)})` : "n/a");
const num = (d = 1) => ([v, lo, hi]) => (Number.isFinite(v) ? `${v.toFixed(d)} (${lo.toFixed(d)} to ${hi.toFixed(d)})` : "n/a");

// The stages: each adds one part of the pipeline and one more condition for "this trip is fine".
const asked = (r) => !r.daysAsked || r.daysPlanned === r.daysAsked;
const STAGES = [
  ["Model's first answer passes the plan checks", (r) => r.checks.found === 0],
  ["After the model's one repair", (r) => r.checks.left === 0],
  ["... and once routed, every featured road is driven and no day runs long", (r) => r.checks.left === 0 && !r.undrivenBefore.length && !r.longBefore],
  ["After the road pass (points added on undriven roads)", (r) => r.checks.left === 0 && !r.undrivenAfter.length && !r.longBefore],
  ["After the day-split DP (overnights moved)", (r) => r.checks.left === 0 && !r.undrivenAfter.length && !r.longAfter],
  ["... and no backtracking left (20+ km) and no stops outside coverage", (r) => r.checks.left === 0 && !r.undrivenAfter.length && !r.longAfter && r.backtrackLeftKm < 20 && !r.uncovered],
];
// what the plan checks complained about, by kind
const KINDS = [
  ["day count", /asked for \d+ days/],
  ["day ends away from its overnight", /overnight is/],
  ["loop doesn't end at the start", /This is a loop/],
  ["featured road with no point on it", /has no point on it/],
  ["copied example place", /only an example/],
  ["day numbering or missing day", /numbered|doesn't exist|has no stop/],
  ["too many points", /at most/],
];

const lines = [`# Planner eval: ${path.basename(dir)}`, ""];
const prompts = new Set(runs.flatMap((r) => r.recs.map((x) => x.id)));
lines.push(`${prompts.size} trip requests (eval/prompts.json), ${runs.length} model${runs.length > 1 ? "s" : ""}. Intervals are 95% bootstrap intervals over the requests; with ~30 requests they're wide, so read differences under ~15 points as noise.`, "");

lines.push("## Trips that pass, stage by stage", "");
lines.push(`| Stage | ${runs.map((r) => r.model).join(" | ")} |`, `|---|${runs.map(() => "---").join("|")}|`);
const okRecs = (r) => r.recs.filter((x) => !x.error);
for (const [label, pred] of STAGES) lines.push(`| ${label} | ${runs.map((r) => pct(boot(okRecs(r), share(pred)))).join(" | ")} |`);
lines.push("");

lines.push("## Metrics", "");
const METRICS = [
  ["Requests that failed (error, quota, routing)", (r) => pct(boot(r.recs, share((x) => !!x.error)))],
  ["Plan problems in the first answer (mean)", (r) => num(2)(boot(okRecs(r), (rs) => mean(rs.map((x) => x.checks.found))))],
  ["Plan problems left after the repair (mean)", (r) => num(2)(boot(okRecs(r), (rs) => mean(rs.map((x) => x.checks.left))))],
  ["Asked day count kept", (r) => pct(boot(okRecs(r).filter((x) => x.daysAsked), share(asked)))],
  ["Featured roads that are real catalog roads", (r) => pct(boot(okRecs(r), ratio((x) => x.roadsGrounded || 0, (x) => x.roadsPlanned.length)))],
  ["Featured roads driven, as planned", (r) => pct(boot(okRecs(r), ratio((x) => x.roadsTotal - x.undrivenBefore.length, (x) => x.roadsTotal)))],
  ["Featured roads driven, after the road pass", (r) => pct(boot(okRecs(r), ratio((x) => x.roadsTotal - x.undrivenAfter.length, (x) => x.roadsTotal)))],
  ["Trips with a long day, as planned", (r) => pct(boot(okRecs(r), share((x) => x.longBefore > 0)))],
  ["Trips with a long day, after the day split", (r) => pct(boot(okRecs(r), share((x) => x.longAfter > 0)))],
  ["Longest day, hours (mean over trips, final)", (r) => num(1)(boot(okRecs(r), (rs) => mean(rs.map((x) => Math.max(...x.hoursAfter))))) ],
  ["Share of the distance on featured roads", (r) => pct(boot(okRecs(r), ratio((x) => x.featuredKm, (x) => x.km)))],
  ["Points where the route-aware geocode beat the top result", (r) => pct(boot(okRecs(r), ratio((x) => x.viterbiChanged || 0, (x) => x.points)))],
  ["Trips the backtracking fix reordered", (r) => pct(boot(okRecs(r), share((x) => x.reorderKm > 0)))],
  ["Trips with detour points dropped", (r) => pct(boot(okRecs(r), share((x) => x.detoursDropped > 0)))],
  ["Plan time, median seconds (includes busy retries)", (r) => { const v = median(okRecs(r).map((x) => x.msPlan / 1000)); return Number.isFinite(v) ? v.toFixed(0) : "n/a"; }],
];
lines.push(`| Metric | ${runs.map((r) => r.model).join(" | ")} |`, `|---|${runs.map(() => "---").join("|")}|`);
for (const [label, f] of METRICS) lines.push(`| ${label} | ${runs.map(f).join(" | ")} |`);
lines.push("");

lines.push("## What the plan checks found in first answers", "");
lines.push(`| Problem | ${runs.map((r) => r.model).join(" | ")} |`, `|---|${runs.map(() => "---").join("|")}|`);
for (const [label, re] of KINDS) {
  lines.push(`| ${label} | ${runs.map((r) => okRecs(r).flatMap((x) => x.checks.issues || []).filter((s) => re.test(s)).length).join(" | ")} |`);
}
lines.push("");

lines.push("## Per request", "");
lines.push(`| Request | ${runs.map((r) => r.model).join(" | ")} |`, `|---|${runs.map(() => "---").join("|")}|`);
const cell = (x) => {
  if (!x) return "";
  if (x.error) return `error: ${x.error.slice(0, 40)}`;
  const bad = [
    x.checks.left && `${x.checks.left} check`,
    x.undrivenAfter.length && `undriven: ${x.undrivenAfter.join(", ")}`,
    x.longAfter && `${x.longAfter} long day${x.longAfter > 1 ? "s" : ""} (max ${Math.max(...x.hoursAfter)} h)`,
    x.backtrackLeftKm >= 20 && `backtrack ${x.backtrackLeftKm} km`,
    x.uncovered && `${x.uncovered} outside coverage`,
  ].filter(Boolean);
  return bad.length ? bad.join("; ") : "ok";
};
for (const id of prompts) lines.push(`| ${id} | ${runs.map((r) => cell(r.recs.find((x) => x.id === id))).join(" | ")} |`);
lines.push("");

const md = lines.join("\n");
fs.writeFileSync(path.join(dir, "report.md"), md);
console.log(md);
