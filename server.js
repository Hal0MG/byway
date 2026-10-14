import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

// The app's own files (the pages in public/, the road lists and ready-made trips in data/) sit next to this file. What
// the app writes (trips, caches, .env) goes in the folder it runs from: the same folder for start.sh, the user's app
// data folder for the desktop app (desktop/main.cjs).
const APP_ROOT = path.dirname(fileURLToPath(import.meta.url));
const appFile = (...parts) => path.join(APP_ROOT, ...parts);
const VERSION = JSON.parse(await fs.readFile(appFile("package.json"), "utf8")).version;

const app = express();
app.use(express.json({ limit: "15mb" }));
// An error that escapes a route is logged instead of stopping the app (one in the day guides' error handler once did).
process.on("unhandledRejection", (e) => console.log(`Unhandled error: ${e?.stack || e}`));

// Compression: JSON answers over 2 KB (a trip is ~600 KB of route, ~150 KB gzipped) and the app's text files go out
// gzipped when the browser accepts it. Streamed answers (res.write: the live planning events) are left alone, so
// they still arrive as they're written.
const acceptsGzip = (req) => /\bgzip\b/.test(req.headers["accept-encoding"] || "");
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    const text = JSON.stringify(body);
    if (!acceptsGzip(req) || text.length < 2048 || res.headersSent) return json(body);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
    return res.end(gzipSync(text));
  };
  next();
});
// Demo mode (see "demo mode" below): the visitor's id cookie is set with the page itself, before the app's first
// requests, so they all carry the same id.
app.use((req, res, next) => {
  if (process.env.DEMO === "1" && req.method === "GET" && !req.path.startsWith("/api/")) demoVisitor(req, res);
  next();
});
// The app's own files, gzipped once per version of the file and kept in memory (the biggest, coverage.json, goes from
// 480 KB to ~150 KB). Everything else (and browsers without gzip) falls through to express.static.
const GZ_TYPES = { ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".html": "text/html", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };
const gzFiles = new Map();
app.use(async (req, res, next) => {
  if ((req.method !== "GET" && req.method !== "HEAD") || !acceptsGzip(req)) return next();
  const rel = decodeURIComponent(req.path === "/" ? "/index.html" : req.path);
  const type = GZ_TYPES[path.extname(rel)];
  const root = appFile("public");
  const file = path.join(root, rel);
  if (!type || !file.startsWith(root + path.sep)) return next();
  try {
    const st = await fs.stat(file);
    const tag = `W/"gz-${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}"`;
    res.setHeader("ETag", tag);
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Vary", "Accept-Encoding");
    if (req.headers["if-none-match"] === tag) return res.status(304).end();
    let hit = gzFiles.get(file);
    if (hit?.tag !== tag) gzFiles.set(file, (hit = { tag, body: gzipSync(await fs.readFile(file)) }));
    res.setHeader("Content-Type", `${type}; charset=utf-8`);
    res.setHeader("Content-Encoding", "gzip");
    res.end(req.method === "HEAD" ? undefined : hit.body);
  } catch {
    next();
  }
});
app.use(express.static(appFile("public")));

// ---------- demo mode (DEMO=1): a public site that plans on the owner's keys ----------
// Visitors never see or set keys (the setup routes are off), each visitor sees only their own trips (a random id in a
// cookie), and the calls that spend the owner's free allowances have daily caps per visitor, per network address and
// for the whole site, so one visitor (or a bot) can't use them up. Caps reset at midnight UTC; DEMO_* env vars tune them.
const DEMO = process.env.DEMO === "1";
const cap = (name, def) => Math.max(0, Number(process.env[name] ?? def) || 0);
// kind: [per visitor, whole site]. "plan" is every /api/plan call: a new trip takes 1 to 4 (repairs, long days).
const DEMO_CAPS = {
  plan: [cap("DEMO_PLANS_PER_VISITOR", 12), cap("DEMO_PLANS_PER_DAY", 150)],
  ai: [cap("DEMO_AI_PER_VISITOR", 60), cap("DEMO_AI_PER_DAY", 900)], // day guides, Ask, road ideas and reviews
  route: [cap("DEMO_ROUTES_PER_VISITOR", 200), cap("DEMO_ROUTES_PER_DAY", 1500)], // OpenRouteService: 2,000 a day
  geo: [cap("DEMO_GEOCODES_PER_VISITOR", 400), cap("DEMO_GEOCODES_PER_DAY", 4000)], // Nominatim, one a second
  along: [cap("DEMO_ALONG_PER_VISITOR", 60), cap("DEMO_ALONG_PER_DAY", 800)], // Overpass: fuel, food, stays
};
const DEMO_KIND = {
  "POST /plan": "plan",
  "POST /details": "ai", "POST /ask": "ai", "POST /road-reviews": "ai", "POST /road-ideas": "ai", "POST /road-points": "ai",
  "POST /route": "route",
  "GET /geocode": "geo", "GET /place-name": "geo",
  "POST /along": "along",
};
const demoUse = { day: "", counts: new Map() };
const VISITOR_RE = /^[a-f0-9-]{36}$/;
function demoVisitor(req, res) {
  const m = /(?:^|;\s*)byway_v=([^;]+)/.exec(req.headers.cookie || "");
  if (m && VISITOR_RE.test(m[1])) return m[1];
  const id = crypto.randomUUID();
  res.setHeader("Set-Cookie", `byway_v=${id}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${req.secure ? "; Secure" : ""}`);
  return id;
}
// Counts one call of a kind; returns an error message when a cap is reached. A network address gets twice a visitor's
// share (clearing cookies doesn't reset it; a shared network still has room).
function demoSpend(req, kind) {
  const day = new Date().toISOString().slice(0, 10);
  if (demoUse.day !== day) Object.assign(demoUse, { day, counts: new Map() });
  const [perVisitor, perSite] = DEMO_CAPS[kind];
  const keys = [[`v:${req.visitor}:${kind}`, perVisitor], [`ip:${req.ip}:${kind}`, perVisitor * 2], [`site:${kind}`, perSite]];
  const over = keys.find(([k, limit]) => (demoUse.counts.get(k) || 0) >= limit);
  if (over) {
    return over[0].startsWith("site")
      ? "The demo has used today's free allowance for this. It resets at midnight UTC; ready-made trips still open."
      : kind === "plan"
        ? "The demo plans a few trips a day per visitor, and that's today's share. Ready-made trips still open, and Byway is free to run on your own computer."
        : "That's today's share of this for one visitor on the demo. It resets at midnight UTC.";
  }
  for (const [k] of keys) demoUse.counts.set(k, (demoUse.counts.get(k) || 0) + 1);
  return null;
}
const demoLeft = (req) => {
  const [perVisitor] = DEMO_CAPS.plan;
  return Math.max(0, perVisitor - (demoUse.day === new Date().toISOString().slice(0, 10) ? demoUse.counts.get(`v:${req.visitor}:plan`) || 0 : 0));
};
if (DEMO) {
  app.set("trust proxy", true); // the host's proxy sends the visitor's address in X-Forwarded-For
  app.use("/api", (req, res, next) => {
    req.visitor = demoVisitor(req, res);
    if (/^\/(setup|lan)\b/.test(req.path)) return res.status(404).json({ error: "Not available on the demo." });
    const kind = DEMO_KIND[`${req.method} ${req.path}`];
    const err = kind && demoSpend(req, kind);
    if (err) return res.status(429).json({ error: err });
    next();
  });
}
// On the demo, a saved trip belongs to the visitor who made it.
const ownTrip = (req, t) => !DEMO || t?.owner === req.visitor;
const DEMO_MAX_TRIPS = 30;

// Keys and choices that the in-app setup can change while the server runs (see "setup" below): reloaded from
// process.env by applyConfig().
let ORS_KEY = process.env.ORS_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
let GEMINI_KEY = process.env.GEMINI_API_KEY;
// Flash-Lite: Denver to Moab in 3 s (Flash took 191 s, mostly thinking), clean plans in tests, and the free tier allows
// far more requests a day than Flash. Flash stays as the last fallback.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
// Tried in order when the main model is busy or out of free requests. Comma separated in .env to override.
const GEMINI_FALLBACKS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-3.5-flash-lite,gemini-3.1-flash-lite,gemini-flash-latest")
  .split(",")
  .map((s) => s.trim());
// Wikimedia and Nominatim ask automated clients for a User-Agent with contact details (an email or a URL).
// Without CONTACT in .env, Wikimedia throttles photo lookups hard ("You are making too many requests").
let CONTACT = (process.env.CONTACT || "").trim();
const userAgent = () =>
  process.env.USER_AGENT || `Byway/${VERSION} (personal non-commercial road trip planner${CONTACT ? `; ${CONTACT}` : ""})`;
let UA = userAgent();
if (!CONTACT && !process.env.USER_AGENT) {
  console.log("Tip: add your email or a website in Setup (the gear button) so Wikipedia doesn't throttle photo lookups.");
}

// ---------- a small JSON cache on disk ----------

// { key: { at, value } } in data/<file>. Entries older than maxDays are ignored and dropped on the next write.
// `keepDays` (default maxDays): how long an entry stays on disk, for getStale when the source is down.
function diskCache(file, maxDays, maxEntries = 2000, keepDays = maxDays) {
  const full = path.resolve("data", file);
  let map = null;
  let timer = null;
  const fresh = (e) => e && Date.now() - e.at < maxDays * 86400000;
  const kept = (e) => e && Date.now() - e.at < keepDays * 86400000;
  const load = async () => {
    if (!map) {
      try {
        map = new Map(Object.entries(JSON.parse(await fs.readFile(full, "utf8"))));
      } catch {
        map = new Map();
      }
    }
    return map;
  };
  return {
    async get(k) {
      const e = (await load()).get(k);
      return fresh(e) ? e.value : undefined;
    },
    // an entry past maxDays but still kept: better than nothing when the source is down
    async getStale(k) {
      const e = (await load()).get(k);
      return kept(e) ? e.value : undefined;
    },
    async set(k, value) {
      (await load()).delete(k);
      map.set(k, { at: Date.now(), value });
      clearTimeout(timer);
      timer = setTimeout(() => {
        const keep = Object.fromEntries([...map].filter(([, e]) => kept(e)).slice(-maxEntries));
        fs.mkdir(path.dirname(full), { recursive: true })
          .then(() => fs.writeFile(full, JSON.stringify(keep)))
          .catch(() => {});
      }, 2000);
    },
  };
}

// ---------- geometry helpers ----------

const toRad = (d) => (d * Math.PI) / 180;
function haversine(a, b) {
  const R = 6371000;
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// Build per-leg stats from a line and the point index where each stop sits.
// timeAt(a, b) returns the seconds spent between indexes a and b, if known.
function legsFromIndexes(coords, wp, totalDist, totalTime, timeAt) {
  const legs = [];
  for (let i = 0; i < wp.length - 1; i++) {
    const a = wp[i];
    const b = wp[i + 1];
    let dist = 0;
    const cum = [0];
    for (let k = a; k < b; k++) {
      dist += haversine(coords[k], coords[k + 1]);
      cum.push(dist);
    }
    let mid = coords[Math.floor((a + b) / 2)];
    for (let k = 0; k < cum.length; k++) {
      if (cum[k] >= dist / 2) {
        mid = coords[a + k];
        break;
      }
    }
    const t = timeAt?.(a, b);
    legs.push({
      distance_m: dist,
      duration_s: t ?? (totalDist ? totalTime * (dist / totalDist) : 0),
      mid,
      from: a, // geometry index where the leg starts
      to: b,
    });
  }
  return legs;
}

// Index of each stop along the line, searching forward so loops still work.
function waypointIndexes(coords, waypoints) {
  const out = [];
  let from = 0;
  waypoints.forEach((w, i) => {
    if (i === 0) return out.push(0);
    if (i === waypoints.length - 1) return out.push(coords.length - 1);
    let best = from;
    let bestD = Infinity;
    for (let k = from; k < coords.length; k++) {
      const d = haversine(coords[k], w);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
      if (d < 1) break;
    }
    out.push(best);
    from = best;
  });
  return out;
}

// ---------- snapping stops that are far from any road ----------

// Park and lake center points are often far from any road. When a router
// cannot place a stop, we move it to the nearest road found through Overpass.
const snapCache = new Map();
async function snapToRoad(lng, lat) {
  const key = `${lng.toFixed(4)},${lat.toFixed(4)}`;
  if (snapCache.has(key)) return snapCache.get(key);

  const tiers = [
    { radius: 2000, classes: "motorway|trunk|primary|secondary|tertiary|unclassified|residential" },
    { radius: 10000, classes: "motorway|trunk|primary|secondary|tertiary|unclassified" },
    { radius: 40000, classes: "motorway|trunk|primary|secondary" },
  ];
  let best = null;
  for (const { radius, classes } of tiers) {
    const query = `[out:json][timeout:25][maxsize:67108864];way(around:${radius},${lat},${lng})[highway~"^(${classes})$"];out geom;`;
    try {
      const r = await fetch("https://overpass-api.de/api/interpreter", {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      let bestD = Infinity;
      for (const el of data.elements || []) {
        for (const g of el.geometry || []) {
          const d = haversine([lng, lat], [g.lon, g.lat]);
          if (d < bestD) {
            bestD = d;
            best = [g.lon, g.lat];
          }
        }
      }
      if (best) break;
    } catch {
      // try the next tier
    }
  }
  // Overpass busy or rate limiting after a run of lookups (an Iceland trip has a dozen waterfalls and lagoons off the
  // road; ORS only looks 350 m around each point): the backup router's nearest drivable road.
  for (const base of best ? [] : OSRM) {
    try {
      const r = await fetch(`${base}/nearest/v1/driving/${lng},${lat}?number=1`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      const loc = r.ok ? (await r.json())?.waypoints?.[0]?.location : null;
      if (loc) {
        best = loc;
        break;
      }
    } catch {
      // the next server
    }
  }
  if (best) snapCache.set(key, best);
  return best;
}

class RouteError extends Error {
  constructor(message, { pointIndex = null, fallback = false } = {}) {
    super(message);
    this.pointIndex = pointIndex;
    this.fallback = fallback; // true means "try the other routing engine"
  }
}

// Calls router(coords) and, when a stop cannot be placed on a road,
// snaps that stop and tries again (at most once per stop).
async function withSnapping(coordinates, router) {
  const coords = coordinates.map((c) => [...c]);
  const snapped = new Set();
  for (let attempt = 0; attempt <= coords.length; attempt++) {
    try {
      return await router(coords);
    } catch (e) {
      const idx = e instanceof RouteError ? e.pointIndex : null;
      if (idx == null || idx < 0 || idx >= coords.length || snapped.has(idx)) throw e;
      const near = await snapToRoad(coords[idx][0], coords[idx][1]);
      if (!near) throw new RouteError(`No road found near stop ${idx + 1}. Try a town or landmark on a road instead.`);
      coords[idx] = near;
      snapped.add(idx);
    }
  }
  throw new RouteError("Could not place the stops on roads.");
}

// ---------- road breakdown from ORS turn-by-turn steps ----------

// ORS step names look like "Lincoln Highway, US 50" or "Carson City Freeway, I 580, US 50".
// US refs ("US 50", "CO 82"), and letter-number routes: Australia and the UK ("B100", "M1", "A82"), Austria and
// Germany ("B107", "L188"), France ("D902", "N85"). Italy's "SS38" fits the two-letter form.
// letter-number routes too: E10 (European), Fv63 / Rv7 (Norway), R559 (Ireland), A-372 (Spain), F35 (Iceland)
const REF_RE = /^(I|US|SR|SH|CR|FR|NFR|FM|RM|BIA|[A-Z]{2}|[MABCDLNERF](?=[ -]?\d))[ -]?\d+[A-Z]?( (Business|Bus|Alt|Spur|Truck|Bypass|Loop|Scenic))?$/i;
function parseRoadName(raw) {
  // Canadian roads come with a bare number ("Icefields Parkway, 93", or just "93"): call it "Hwy 93".
  const parts = String(raw || "")
    .split(/,\s*/)
    .map((p) => p.trim())
    .filter((p) => p && p !== "-")
    .map((p) => (/^\d{1,3}[A-Z]?$/.test(p) ? `Hwy ${p}` : p));
  const isRef = (p) => REF_RE.test(p) || /^Hwy \d/.test(p);
  return { refs: parts.filter(isRef), names: parts.filter((p) => !isRef(p)) };
}

// Merge consecutive steps on the same road into segments:
// { ref, refs, name, distance_m, duration_s, highway_m, ferry_m, toll_m, unpaved_m, from, to }.
// catBetween(a, b, bit) gives the meters between two geometry indexes in an ORS waycategory (1 freeway, 2 toll,
// 8 ferry, 16 unpaved). from/to are geometry indexes, so the app can measure curves and climbs on each road.
function roadsFromSteps(steps, catBetween) {
  const out = [];
  for (const s of steps) {
    if (!s.distance) continue;
    const [a, b] = s.way_points || [0, 0];
    const ferry = catBetween(a, b, 8);
    // Some steps have no name ("-"); the instruction usually still says it, like "Keep left toward I 25 South".
    const named = s.name && s.name !== "-" ? s.name : "";
    const fromText = named ? "" : s.instruction?.match(/\b(?:onto|on|toward|towards)\s+(.+?)\s*$/i)?.[1] || "";
    // A ferry is named after its terminals ("Swartz Bay ↔ Tsawwassen, 1"); its number isn't a highway
    const { refs, names } = ferry > s.distance / 2
      ? { refs: [], names: [named.split(",")[0].trim() || "Ferry"] }
      : parseRoadName(named || fromText.replace(/\s+(North|South|East|West)$/i, ""));
    const key = refs[0] || names[0] || "";
    let seg = out[out.length - 1];
    if (!seg || seg.key !== key) {
      seg = { key, ref: refs[0] || "", refs: [], names: {}, distance_m: 0, duration_s: 0, highway_m: 0, ferry_m: 0, toll_m: 0, unpaved_m: 0, from: a, to: b };
      out.push(seg);
    }
    for (const r of refs) if (!seg.refs.includes(r)) seg.refs.push(r);
    for (const n of names) seg.names[n] = (seg.names[n] || 0) + s.distance;
    seg.distance_m += s.distance;
    seg.duration_s += s.duration;
    seg.highway_m += catBetween(a, b, 1);
    seg.ferry_m += ferry;
    seg.toll_m += catBetween(a, b, 2);
    seg.unpaved_m += catBetween(a, b, 16);
    seg.to = b;
  }
  return out.map(({ key, names, ...seg }) => ({
    ...seg,
    // the name used for the longest stretch, like "Lincoln Highway"
    name: Object.entries(names).sort((x, y) => y[1] - x[1])[0]?.[0] || "",
  }));
}

// ---------- OpenRouteService (whole US) ----------

// Scenic: through every point including the scenic "via" points, with normal road preferences.
// Freeways are fine for getting between scenic roads; the via points keep the route on the good roads.
// After ORS says its daily allowance is used up, don't ask again for half an hour (a minute after "too many requests"):
// every route goes straight to the backup router meanwhile.
let orsRestUntil = 0;
async function routeOrs(coords, mode) {
  if (!ORS_KEY) throw new RouteError("No routing engine available. Add ORS_API_KEY to .env.");
  if (Date.now() < orsRestUntil) throw new RouteError("OpenRouteService is resting after its limit");
  const body = {
    coordinates: coords,
    instructions: true,
    // elevation: coordinates come back as [lng, lat, meters] (SRTM), for the elevation profile and road ratings
    elevation: true,
    extra_info: ["waycategory", "surface"],
    radiuses: coords.map(() => -1),
    preference: mode === "scenic" ? "recommended" : "fastest",
  };
  const r = await fetch("https://api.heigit.org/openrouteservice/v2/directions/driving-car/geojson", {
    method: "POST",
    headers: { Authorization: ORS_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const data = await r.json();
  if (!r.ok) {
    let msg = typeof data?.error === "string" ? data.error : data?.error?.message || "Routing failed";
    // the free plan's daily allowance; it ran out on 2026-10-12 after a day of testing and a 35-trip batch
    if (r.status === 429) orsRestUntil = Date.now() + 60000;
    if (r.status === 403 && /quota/i.test(msg)) {
      orsRestUntil = Date.now() + 30 * 60000;
      msg = "Today's free routing from OpenRouteService is used up, so routes can't be measured until it resets " +
        "(within 24 hours). Planned trips still open.";
    }
    const m = msg.match(/coordinate (\d+)/);
    throw new RouteError(msg, { pointIndex: m ? parseInt(m[1], 10) : null });
  }

  const f = data.features[0];
  const coordsOut = f.geometry.coordinates;
  const { way_points: wp = [], segments = [], summary, extras } = f.properties;

  // Meters between two geometry indexes in an ORS waycategory bit: 1 highway, 2 toll (a ferry's fare isn't counted
  // as a toll road; OpenStreetMap also marks some national park roads as paid), 8 ferry. Bit 16 here means unpaved,
  // taken from the surface extra (2 unpaved, 8 to 13 gravel, dirt, ground, ice, 15 to 17 sand, woodchips, grass).
  const cum = [0];
  for (let k = 1; k < coordsOut.length; k++) cum.push(cum[k - 1] + haversine(coordsOut[k - 1], coordsOut[k]));
  const UNPAVED = new Set([2, 8, 9, 10, 11, 12, 13, 15, 16, 17]);
  const cats = [
    ...(extras?.waycategory?.values || []).map(([f, t, v]) => [f, t, v & 15]),
    ...(extras?.surface?.values || []).filter(([, , v]) => UNPAVED.has(v)).map(([f, t]) => [f, t, 16]),
  ];
  const catBetween = (a, b, bit) => {
    let m = 0;
    for (const [from, to, v] of cats) {
      if (!(v & bit) || (bit === 2 && v & 8)) continue;
      const lo = Math.max(a, from);
      const hi = Math.min(b, to);
      if (hi > lo) m += cum[hi] - cum[lo];
    }
    return m;
  };
  const end = coordsOut.length - 1;

  const legs = legsFromIndexes(coordsOut, wp, summary.distance, summary.duration, null).map((l, i) => ({
    ...l,
    distance_m: segments[i]?.distance ?? l.distance_m,
    duration_s: segments[i]?.duration ?? l.duration_s,
    ascent_m: segments[i]?.ascent ?? null,
    descent_m: segments[i]?.descent ?? null,
    roads: roadsFromSteps(segments[i]?.steps || [], catBetween),
  }));
  return {
    engine: "openrouteservice",
    geometry: f.geometry,
    distance_m: summary.distance,
    duration_s: summary.duration,
    ascent_m: f.properties.ascent ?? summary.ascent ?? null,
    descent_m: f.properties.descent ?? summary.descent ?? null,
    highway_m: catBetween(0, end, 1),
    toll_m: catBetween(0, end, 2),
    ferry_m: catBetween(0, end, 8),
    unpaved_m: catBetween(0, end, 16),
    legs,
  };
}

// ---------- backup router: OSRM (OpenStreetMap's public routing servers, no key) ----------
// Used when OpenRouteService can't answer (the free daily allowance ran out on 2026-10-12, or it's down). The public
// servers are meant for light use (about one request a second, a real User-Agent), so requests wait their turn. OSRM has
// one car profile (scenic and fastest differ only by the via points), no elevation and no road surface; freeways,
// tolls and ferries come from each step's road classes. OSRM_URLS overrides the list.
const OSRM = process.env.OSRM_URLS?.split(",").map((x) => x.trim()).filter(Boolean) || [
  "https://routing.openstreetmap.de/routed-car",
  "https://router.project-osrm.org",
];
let osrmChain = Promise.resolve();
let osrmLast = 0;
function routeOsrm(coords) {
  const job = osrmChain.then(async () => {
    const wait = 1100 - (Date.now() - osrmLast);
    if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
    osrmLast = Date.now();
    let last = null;
    for (const base of OSRM) {
      try {
        const url = `${base}/route/v1/driving/${coords.map((c) => `${(+c[0]).toFixed(6)},${(+c[1]).toFixed(6)}`).join(";")}` +
          "?overview=false&steps=true&geometries=geojson";
        const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(30000) });
        const d = await r.json().catch(() => ({}));
        if (d.code === "Ok" && d.routes?.length) return await addElevation(osrmResult(d.routes[0]));
        last = new RouteError(d.message || `Backup routing failed (${r.status})`);
        if (d.code === "NoRoute" || d.code === "NoSegment") break; // the other server has the same map
      } catch (e) {
        last = e;
      }
    }
    throw last || new RouteError("Backup routing failed");
  });
  osrmChain = job.catch(() => {});
  return job;
}
// OSRM's answer in the shape routeOrs returns. The line is built from the steps, so step and leg boundaries are
// indexes into it, like ORS's way_points.
function osrmResult(route) {
  const coords = [];
  const wp = [0];
  const steps = [];
  const cats = [];
  for (const [li, leg] of route.legs.entries()) {
    for (const st of leg.steps) {
      const pts = st.geometry?.coordinates || [];
      const a = Math.max(0, coords.length - 1);
      for (const [k, c] of pts.entries()) {
        const prev = coords[coords.length - 1];
        if (k === 0 && prev && prev[0] === c[0] && prev[1] === c[1]) continue;
        coords.push(c);
      }
      const b = coords.length - 1;
      const classes = new Set((st.intersections || []).flatMap((i) => i.classes || []));
      // the public servers often leave out the motorway class, so interstates and named freeways count too
      const freeway = classes.has("motorway") || /^(I|M)[ -]?\d/.test(st.ref || "") || /\b(Freeway|Motorway|Autobahn|Autoroute|Autostrada)\b/i.test(st.name || "");
      const bits = (freeway ? 1 : 0) | (classes.has("toll") ? 2 : 0) | (st.mode === "ferry" || classes.has("ferry") ? 8 : 0);
      if (bits) cats.push([a, b, bits]);
      const name = [...String(st.ref || "").split(";"), st.name].map((x) => String(x || "").trim()).filter(Boolean).join(", ");
      steps.push({ distance: st.distance, duration: st.duration, name: name || "-", way_points: [a, b], leg: li });
    }
    wp.push(coords.length - 1);
  }
  const cum = [0];
  for (let k = 1; k < coords.length; k++) cum.push(cum[k - 1] + haversine(coords[k - 1], coords[k]));
  const catBetween = (a, b, bit) => {
    let m = 0;
    for (const [from, to, v] of cats) {
      if (!(v & bit) || (bit === 2 && v & 8)) continue;
      const lo = Math.max(a, from);
      const hi = Math.min(b, to);
      if (hi > lo) m += cum[hi] - cum[lo];
    }
    return m;
  };
  const end = coords.length - 1;
  const legs = legsFromIndexes(coords, wp, route.distance, route.duration, null).map((l, i) => ({
    ...l,
    distance_m: route.legs[i]?.distance ?? l.distance_m,
    duration_s: route.legs[i]?.duration ?? l.duration_s,
    ascent_m: null,
    descent_m: null,
    roads: roadsFromSteps(steps.filter((x) => x.leg === i), catBetween),
  }));
  return {
    engine: "osrm",
    geometry: { type: "LineString", coordinates: coords },
    distance_m: route.distance,
    duration_s: route.duration,
    ascent_m: null,
    descent_m: null,
    highway_m: catBetween(0, end, 1),
    toll_m: catBetween(0, end, 2),
    ferry_m: catBetween(0, end, 8),
    unpaved_m: 0,
    legs,
    note: "Measured with the backup router (OpenStreetMap's OSRM) because OpenRouteService couldn't answer: no elevation or road surface this time.",
  };
}
// Heights for a backup route from Open-Meteo's free elevation API (Copernicus 90 m terrain, no key). Open-Meteo counts
// every point as a call (free: 600 a minute, 5,000 an hour, 10,000 a day, shared with the weather), so a route gets at
// most ~300 samples (every 0.5 to several km) filled in between by distance, heights already looked up are kept a year
// (data/elevation-cache.json, per ~100 m), and lookups stop at 1,500 points an hour and 3,000 a day
// (data/elevation-usage.json) to leave the rest for the weather. Best effort: a route without heights is still a route.
const elevCache = diskCache("elevation-cache.json", 365, 60000);
const ELEV_USAGE_FILE = path.resolve("data", "elevation-usage.json");
const ELEV_HOUR = 1500;
const ELEV_DAY = 3000;
let elevUsage = null;
async function elevAllowance(n) {
  if (!elevUsage) elevUsage = JSON.parse(await fs.readFile(ELEV_USAGE_FILE, "utf8").catch(() => "{}"));
  const hour = new Date().toISOString().slice(0, 13);
  if (elevUsage.hour !== hour) Object.assign(elevUsage, { hour, h: 0 });
  if (elevUsage.day !== hour.slice(0, 10)) Object.assign(elevUsage, { day: hour.slice(0, 10), d: 0 });
  if (elevUsage.h + n > ELEV_HOUR || elevUsage.d + n > ELEV_DAY) return false;
  elevUsage.h += n;
  elevUsage.d += n;
  fs.writeFile(ELEV_USAGE_FILE, JSON.stringify(elevUsage)).catch(() => {});
  return true;
}
let elevChain = Promise.resolve();
function elevFetch(points) {
  const job = elevChain.then(async () => {
    if (!(await elevAllowance(points.length))) throw new Error("this hour's or today's share of free height lookups is used");
    const url = `https://api.open-meteo.com/v1/elevation?latitude=${points.map((p) => p[1]).join(",")}&longitude=${points.map((p) => p[0]).join(",")}`;
    const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !Array.isArray(d.elevation) || d.elevation.length !== points.length) throw new Error(d.reason || `elevation ${r.status}`);
    // a short pause between requests keeps well under the minute limit
    await new Promise((ok) => setTimeout(ok, 1500));
    return d.elevation;
  });
  elevChain = job.catch(() => {});
  return job;
}
async function addElevation(result) {
  const coords = result.geometry.coordinates;
  if (coords.length < 2 || coords[0].length > 2) return result;
  try {
    const cum = [0];
    for (let k = 1; k < coords.length; k++) cum.push(cum[k - 1] + haversine(coords[k - 1], coords[k]));
    const step = Math.max(500, cum.at(-1) / 300);
    const idx = [];
    for (let k = 0, next = 0; k < coords.length; k++) {
      if (cum[k] >= next || k === coords.length - 1) {
        idx.push(k);
        next = cum[k] + step;
      }
    }
    // heights already known (the same roads again: undo, reopening, a rebuilt trip) come from the cache
    const key = (k) => `${coords[k][1].toFixed(3)},${coords[k][0].toFixed(3)}`;
    const ele = await Promise.all(idx.map((k) => elevCache.get(key(k))));
    const missing = idx.map((k, i) => (ele[i] == null ? i : -1)).filter((i) => i >= 0);
    for (let i = 0; i < missing.length; i += 100) {
      const part = missing.slice(i, i + 100);
      const got = await elevFetch(part.map((j) => [coords[idx[j]][0].toFixed(3), coords[idx[j]][1].toFixed(3)]));
      part.forEach((j, n) => {
        ele[j] = got[n];
        elevCache.set(key(idx[j]), got[n]);
      });
    }
    for (let k = 0, j = 0; k < coords.length; k++) {
      while (j < idx.length - 2 && cum[idx[j + 1]] < cum[k]) j++;
      const a = idx[j];
      const b = idx[j + 1] ?? a;
      const t = b === a ? 0 : Math.min(1, Math.max(0, (cum[k] - cum[a]) / (cum[b] - cum[a])));
      const e = ele[j] + ((ele[j + 1] ?? ele[j]) - ele[j]) * t;
      coords[k] = [coords[k][0], coords[k][1], Math.round(e * 10) / 10];
    }
    result.note = "Measured with the backup router (OpenStreetMap's OSRM) because OpenRouteService couldn't answer: heights from Open-Meteo, no road surface this time.";
  } catch (e) {
    console.log(`Heights for the backup route failed (${e.message})`);
  }
  return result;
}

// ---------- long routes in pieces ----------
// ORS takes at most 50 points and about 6,000 km per request (a two-week cross-country trip is more). Longer routes are
// measured in pieces that share their end points and joined; point numbers in errors ("coordinate 5", "between points
// 4 and 5") are moved back to the whole route's numbering, so the app's fixes still find the right point.
const PIECE_POINTS = 45;
const PIECE_KM = 4000;
function routePieces(coords) {
  const pieces = [];
  let start = 0;
  let km = 0;
  for (let i = 1; i < coords.length; i++) {
    km += haversine(coords[i - 1], coords[i]) / 1000;
    // the road distance can be well over the straight line, hence the margin under 6,000 km
    if (i - start + 1 >= PIECE_POINTS || (km > PIECE_KM && i - start >= 2)) {
      pieces.push([start, i]);
      start = i;
      km = 0;
    }
  }
  if (start < coords.length - 1 || !pieces.length) pieces.push([start, coords.length - 1]);
  return pieces;
}
async function routeInPieces(coords, router) {
  const pieces = routePieces(coords);
  if (pieces.length === 1) return router(coords);
  const parts = [];
  for (const [a, b] of pieces) {
    try {
      parts.push(await router(coords.slice(a, b + 1)));
    } catch (e) {
      const shift = (n) => String(Number(n) + a);
      e.message = e.message
        .replace(/coordinate (\d+)/g, (_, n) => `coordinate ${shift(n)}`)
        .replace(/between points (\d+)(.*?) and (\d+)/, (_, x, mid, y) => `between points ${shift(x)}${mid} and ${shift(y)}`);
      throw e;
    }
  }
  // join: the line without each piece's repeated first point, leg and road indexes moved along it, totals added up
  const out = { ...parts[0], geometry: { type: "LineString", coordinates: [...parts[0].geometry.coordinates] }, legs: [...parts[0].legs] };
  const add = (k, v) => (out[k] = out[k] == null || v == null ? null : out[k] + v);
  for (const p of parts.slice(1)) {
    const off = out.geometry.coordinates.length - 1;
    out.geometry.coordinates.push(...p.geometry.coordinates.slice(1));
    out.legs.push(...p.legs.map((l) => ({
      ...l, from: l.from + off, to: l.to + off,
      roads: (l.roads || []).map((r) => ({ ...r, from: r.from + off, to: r.to + off })),
    })));
    for (const k of ["distance_m", "duration_s", "ascent_m", "descent_m", "highway_m", "toll_m", "ferry_m", "unpaved_m"]) add(k, p[k]);
    if (p.engine !== out.engine) out.engine = "mixed";
    if (p.note && !out.note) out.note = p.note;
  }
  return out;
}

// ---------- route cache ----------
// OpenRouteService's free plan has a daily allowance, and it ran out on 2026-10-12. The same request (same points, same
// route type) comes back often: Undo, reopening and re-measuring a trip, retries, rebuilding ready-made trips, the
// probes that move unreachable stops. So answers are kept on disk, one file per route (a route with its elevation is a
// few hundred KB): routes for 30 days, "can't route there" for a day. Running out of quota and network errors are
// never kept.
const ROUTE_DIR = path.resolve("data", "route-cache");
const ROUTE_KEEP_MS = 30 * 86400000;
const ROUTE_FAIL_MS = 86400000;
const ROUTE_MAX_FILES = 400;
// ORS's answers that mean "no road route between these points", not "can't answer right now"
const ROUTE_IMPOSSIBLE = /could not be found|unable to find a route|could not find routable point|coordinate \d+/i;
const routeKey = (coords, mode) =>
  createHash("sha1").update(JSON.stringify([mode, coords.map((c) => c.map((v) => +Number(v).toFixed(5)))])).digest("hex");
async function routeCacheGet(key) {
  try {
    const e = JSON.parse(await fs.readFile(path.join(ROUTE_DIR, `${key}.json`), "utf8"));
    // failures and backup-router routes only a day: ORS's own route (with elevation) is better once it answers again
    // backup routes from before they had heights are measured again
    if (e.result?.engine === "osrm" && (e.result.geometry?.coordinates?.[0]?.length || 0) < 3) return null;
    return Date.now() - e.at < (e.error || e.result?.engine !== "openrouteservice" ? ROUTE_FAIL_MS : ROUTE_KEEP_MS) ? e : null;
  } catch {
    return null;
  }
}
let routeWrites = 0;
async function routeCacheSet(key, entry) {
  try {
    await fs.mkdir(ROUTE_DIR, { recursive: true });
    await fs.writeFile(path.join(ROUTE_DIR, `${key}.json`), JSON.stringify({ at: Date.now(), ...entry }));
    if (++routeWrites % 25) return;
    // now and then: drop old routes, and the oldest ones past the file limit
    const files = await Promise.all((await fs.readdir(ROUTE_DIR)).map(async (f) => {
      const full = path.join(ROUTE_DIR, f);
      return { full, t: (await fs.stat(full)).mtimeMs };
    }));
    files.sort((a, b) => b.t - a.t);
    for (const [i, f] of files.entries()) {
      if (i >= ROUTE_MAX_FILES || Date.now() - f.t > ROUTE_KEEP_MS) await fs.unlink(f.full).catch(() => {});
    }
  } catch {
    // a cache that can't be written just means asking again
  }
}

// Route between stops. coordinates: [[lng, lat], ...], mode: "scenic" | "fastest". OpenRouteService, and the backup router
// (OSRM) when it can't answer.
app.post("/api/route", async (req, res) => {
  const { mode } = req.body;
  const coordinates = asArray(req.body.coordinates);
  if (coordinates.length < 2) return res.status(400).json({ error: "Add at least two stops to find routes." });
  // longitude and latitude in range; anything else is a bad point, not a routing problem
  const bad = coordinates.findIndex((c) => !Array.isArray(c) || !(Math.abs(c[0]) <= 180) || !(Math.abs(c[1]) <= 90));
  if (bad >= 0) return res.status(400).json({ error: `Stop ${bad + 1} has no valid location.` });
  if (coordinates.length > 400) return res.status(400).json({ error: "That's more than 400 points; split the trip." });

  // (without an ORS key every route comes from the backup router: it works, without elevation)
  const key = routeKey(coordinates, mode);
  const hit = await routeCacheGet(key);
  if (hit) return hit.error ? res.status(422).json({ error: hit.error }) : res.json(hit.result);
  try {
    const result = await routeInPieces(coordinates, async (c) => {
      try {
        return await withSnapping(c, (cc) => routeOrs(cc, mode));
      } catch (e) {
        // ORS out of allowance, rate limited, down or unreachable: the backup router. A real "can't route there"
        // stays an error, so the app can drop or move that point.
        if (e instanceof RouteError && ROUTE_IMPOSSIBLE.test(e.message)) throw e;
        if (!/resting/.test(e.message)) console.log(`ORS failed (${e.message}), using the backup router`);
        return routeOsrm(c);
      }
    });
    routeCacheSet(key, { result });
    res.json(result);
  } catch (e) {
    // only ORS's own "can't route that" answers are kept; not quota, timeouts or network failures
    if (e instanceof RouteError && ROUTE_IMPOSSIBLE.test(e.message)) {
      routeCacheSet(key, { error: e.message });
    }
    res.status(422).json({ error: e.message });
  }
});

// POST /api/heights { coordinates: [[lng, lat], ...] } -> { coordinates: [[lng, lat, m], ...] }: heights for a route
// measured without them (older backup routes), from Open-Meteo like addElevation, within its budget. Used by
// tools/add-heights.mjs (which does what the budget allows and can be run again later for the rest).
app.post("/api/heights", async (req, res) => {
  const coords = asArray(req.body?.coordinates).filter((c) => Array.isArray(c) && Math.abs(c[0]) <= 180 && Math.abs(c[1]) <= 90).map((c) => [+c[0], +c[1]]);
  if (coords.length < 2 || coords.length > 200000) return res.status(400).json({ error: "Send 2 to 200,000 points." });
  const out = await addElevation({ geometry: { coordinates: coords } });
  if (out.geometry.coordinates[0].length < 3) return res.status(502).json({ error: "Heights aren't available right now." });
  res.json({ coordinates: out.geometry.coordinates });
});

// Which routing engine is available, for the status line in the app.
app.get("/api/status", async (req, res) => {
  res.json({
    version: VERSION,
    ors: !!ORS_KEY,
    ai: AI_PROVIDER === "claude" && anthropic
        ? { provider: "claude", model: CLAUDE_MODEL, webSearch: SEARCHES_PLAN + SEARCHES_DETAILS > 0 }
        : { provider: "gemini", model: GEMINI_MODEL, webSearch: false },
    demo: DEMO ? { plansLeft: demoLeft(req), plansPerDay: DEMO_CAPS.plan[0] } : null,
  });
});

// ---------- saved trips (stored in data/trips.json) ----------

// Route lines are stored as encoded polylines (Google's format, 5 decimals: about 1 m) with the height as a third value
// (tenths of a metre), instead of [lng, lat, height] arrays: 24 MB of ready-made trips become ~5.5 MB. Every point
// is kept, so the leg and road indexes into the line still hold. The app sends and receives plain arrays as before;
// packing happens only on disk.
function encodeLine(coords) {
  const dims = coords[0]?.length >= 3 ? 3 : 2;
  const f = [1e5, 1e5, 10];
  const prev = [0, 0, 0];
  let out = "";
  for (const c of coords) {
    for (let d = 0; d < dims; d++) {
      const q = Math.round((d === 0 ? c[1] : d === 1 ? c[0] : c[2] ?? 0) * f[d]);
      let v = q - prev[d];
      prev[d] = q;
      v = v < 0 ? ~(v << 1) : v << 1;
      while (v >= 0x20) {
        out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
        v >>= 5;
      }
      out += String.fromCharCode(v + 63);
    }
  }
  return { dims, line: out };
}
function decodeLine({ dims, line }) {
  const coords = [];
  const f = [1e5, 1e5, 10];
  const prev = [0, 0, 0];
  let i = 0;
  while (i < line.length) {
    const p = [];
    for (let d = 0; d < dims; d++) {
      let shift = 0;
      let v = 0;
      let b;
      do {
        b = line.charCodeAt(i++) - 63;
        v |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      prev[d] += v & 1 ? ~(v >> 1) : v >> 1;
      p.push(prev[d] / f[d]);
    }
    coords.push(dims === 3 ? [p[1], p[0], p[2]] : [p[1], p[0]]);
  }
  return coords;
}
// { scenic, fastest } with geometry.coordinates <-> geometry.packed; anything else passes through unchanged
const mapRoutes = (routes, fn) =>
  routes && typeof routes === "object" ? Object.fromEntries(Object.entries(routes).map(([k, r]) => [k, r?.geometry ? { ...r, geometry: fn(r.geometry) } : r])) : routes;
const packRoutes = (routes) =>
  mapRoutes(routes, (g) => (Array.isArray(g.coordinates) && g.coordinates.length ? { type: g.type || "LineString", packed: encodeLine(g.coordinates) } : g));
const unpackRoutes = (routes) =>
  mapRoutes(routes, (g) => (g.packed ? { type: g.type || "LineString", coordinates: decodeLine(g.packed) } : g));
const unpackTrip = (t) => (t?.routes ? { ...t, routes: unpackRoutes(t.routes) } : t);

const DATA_DIR = path.resolve("data");
const TRIPS_FILE = path.join(DATA_DIR, "trips.json");
const ID_RE = /^[a-z0-9-]{6,40}$/;

async function readTrips() {
  try {
    return JSON.parse(await fs.readFile(TRIPS_FILE, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw e;
  }
}

// Writes go one at a time, and through a temp file so a crash can't corrupt the file.
let writeChain = Promise.resolve();
function updateTrips(fn) {
  const job = writeChain.then(async () => {
    const trips = await readTrips();
    const result = fn(trips);
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = `${TRIPS_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(trips));
    await fs.rename(tmp, TRIPS_FILE);
    return result;
  });
  writeChain = job.catch(() => {});
  return job;
}
// Trips saved before 1.0 have plain route arrays: packed once at start, after keeping a copy of the old file.
async function packOldTrips() {
  const trips = await readTrips().catch(() => ({}));
  if (!Object.values(trips).some((t) => Object.values(t.routes || {}).some((r) => Array.isArray(r?.geometry?.coordinates)))) return;
  await fs.copyFile(TRIPS_FILE, path.join(DATA_DIR, "trips.pre-1.0.json")).catch(() => {});
  await updateTrips((all) => {
    for (const t of Object.values(all)) if (t.routes) t.routes = packRoutes(t.routes);
  });
  console.log("Saved trips: route lines packed (the old file is kept as data/trips.pre-1.0.json)");
}
if (!process.env.BYWAY_TEST) packOldTrips().catch((e) => console.log(`Packing saved trips failed: ${e.message}`));

// A short summary of a trip for lists (the trips sheet and the ready-made trips gallery).
// What the Trips tab shows for a trip without opening it: the numbers, each day (title, overnight, driving), the
// featured roads, a few photos and a light sketch of the route per day (about 120 points in all, for an SVG).
const summaries = new Map(); // id -> { at, summary }: decoding every route for each list request adds up
function tripSummary(t) {
  const hit = summaries.get(t.id);
  if (hit && hit.at === t.updatedAt) return hit.summary;
  const summary = makeSummary(unpackTrip(t));
  summaries.set(t.id, { at: t.updatedAt, summary });
  return summary;
}
function makeSummary(t) {
  const sc = t.routes?.scenic;
  const stops = t.stops || [];
  const days = new Set(stops.map((s) => s.day)).size;
  const byDay = new Map();
  const coords = sc?.geometry?.coordinates || [];
  (sc?.legs || []).forEach((l, k) => {
    const end = stops[sc.idx?.[k + 1]];
    if (!end) return;
    const d = byDay.get(end.day) || { secs: 0, meters: 0, from: l.from, to: l.to };
    d.secs += l.duration_s || 0;
    d.meters += l.distance_m || 0;
    d.to = l.to;
    byDay.set(end.day, d);
  });
  const step = Math.max(1, Math.ceil(coords.length / 120));
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const dayList = (t.plan?.days || []).map((d) => {
    const m = byDay.get(Number(d.day)) || {};
    const line = m.from != null ? coords.slice(m.from, m.to + 1).filter((_, i, a) => i % step === 0 || i === a.length - 1).map((c) => [r3(c[0]), r3(c[1])]) : [];
    return { day: Number(d.day), title: d.title || "", overnight: d.overnight || "", secs: Math.round(m.secs || 0), meters: Math.round(m.meters || 0), line };
  });
  const images = [...(t.plan?.roads || []), ...(t.plan?.spots || [])].map((x) => x.info?.image).filter(Boolean);
  const end = stops.filter((s) => s.kind !== "via").at(-1);
  return {
    id: t.id, name: t.name, stopCount: stops.length, updatedAt: t.updatedAt, preset: !!t.preset,
    prompt: t.prompt || "", days, distance_m: sc?.distance_m || null, duration_s: sc?.duration_s || null,
    summary: t.plan?.summary || "", styles: t.settings?.styles || [], loop: !!t.settings?.loop,
    image: images[0] || "",
    images: [...new Set(images)].slice(0, 5),
    start: stops[0] ? { lng: stops[0].lng, lat: stops[0].lat, name: stops[0].name } : null,
    end: end ? { lng: end.lng, lat: end.lat, name: end.name } : null,
    longest_s: Math.max(0, ...dayList.map((d) => d.secs)),
    ascent_m: sc?.ascent_m ?? null,
    highway_m: sc?.highway_m ?? null,
    spots: (t.plan?.spots || []).length,
    roads: (t.plan?.roads || []).map((r) => ({ name: r.name, ref: r.ref || "", official: r.official?.type || "" })),
    dayList,
  };
}

app.get("/api/trips", async (req, res) => {
  try {
    const trips = await readTrips();
    // ready-made trips (built in batch, see "presets") are listed separately
    const list = Object.values(trips)
      .filter((t) => !t.preset && ownTrip(req, t))
      .map(tripSummary)
      .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    res.json({ trips: list });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Ready-made trips that ship with the app (data/presets.json, made by tools/export-presets.mjs), next to the ones built
// on this PC (preset: true in trips.json). Shipped ones are read-only: opening one makes a copy in trips.json.
let shippedPresets = null;
async function shipped() {
  if (!shippedPresets) {
    try {
      shippedPresets = JSON.parse(await fs.readFile(appFile("data", "presets.json"), "utf8"));
    } catch {
      shippedPresets = {};
    }
  }
  return shippedPresets;
}

// Ready-made trips: planned ahead of time (batch mode, ?batch=1) and opened as a copy, with no AI needed.
app.get("/api/presets", async (req, res) => {
  try {
    const list = Object.values({ ...(await shipped()), ...(await readTrips()) })
      .filter((t) => t.preset)
      .map(tripSummary)
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ presets: list });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Copy a trip (also how a ready-made trip is opened). POST { name } -> the new trip's id
app.post("/api/trips/:id/duplicate", async (req, res) => {
  try {
    const id = crypto.randomUUID();
    const ship = await shipped();
    const copy = await updateTrips((trips) => {
      const t = trips[req.params.id] || ship[req.params.id];
      if (!t || (!t.preset && !ownTrip(req, t))) return null;
      const now = new Date().toISOString();
      const name = String(req.body?.name || (t.preset ? t.name : `${t.name} (copy)`)).slice(0, 120);
      trips[id] = { ...structuredClone(t), id, name, preset: false, createdAt: now, updatedAt: now, versions: [], ...(DEMO && { owner: req.visitor }) };
      return trips[id];
    });
    if (!copy) return res.status(404).json({ error: "That trip no longer exists." });
    res.json({ id: copy.id });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

app.get("/api/trips/:id", async (req, res) => {
  const trips = await readTrips().catch(() => ({}));
  let trip = trips[req.params.id];
  if (trip && !trip.preset && !ownTrip(req, trip)) trip = null;
  trip ||= (await shipped())[req.params.id];
  if (!trip) return res.status(404).json({ error: "That trip no longer exists." });
  res.json(unpackTrip(trip));
});

// PUT from the app, POST .../beacon when the tab is closing.
async function saveTrip(req, res) {
  const { id } = req.params;
  if (!ID_RE.test(id)) return res.status(400).json({ error: "Bad trip id" });
  const { name, stops, mode, routes, prompt, plan, edits, settings, versions, notes, preset } = req.body || {};
  if (!Array.isArray(stops)) return res.status(400).json({ error: "Missing stops" });
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  try {
    const trip = await updateTrips((trips) => {
      if (DEMO) {
        // someone else's trip, or a ready-made one, can't be written; and a visitor keeps at most DEMO_MAX_TRIPS
        if (trips[id] && trips[id].owner !== req.visitor) return { denied: "That trip isn't yours to change." };
        const mine = Object.values(trips).filter((t) => t.owner === req.visitor);
        if (!trips[id] && mine.length >= DEMO_MAX_TRIPS)
          return { denied: `The demo keeps up to ${DEMO_MAX_TRIPS} trips per visitor. Delete one to save another.` };
      }
      trips[id] = {
        id,
        name: String(name || "Untitled trip").slice(0, 120),
        prompt: String(prompt || "").slice(0, 2000),
        // the changes asked for after the first plan, oldest first: [{ text, at }]
        edits: asArray(edits).slice(-50).map((e) => ({ text: String(e?.text || "").slice(0, 1000), at: String(e?.at || "") })),
        // trip options: { startDate, startTime, maxHours, noNight, loop, styles, ev, evRange }
        settings: isObj(settings) ? settings : {},
        // earlier versions of the plan, to compare and restore (the app keeps the last few)
        versions: asArray(versions).slice(-6),
        // free-text notes and a checklist: { text, items: [{ text, done }] }
        notes: isObj(notes) ? { text: String(notes.text || "").slice(0, 20000), items: asArray(notes.items).slice(0, 200) } : { text: "", items: [] },
        preset: DEMO ? false : !!preset,
        ...(DEMO && { owner: req.visitor }),
        stops: stops.map((s) => ({
          name: String(s.name || ""),
          lng: Number(s.lng),
          lat: Number(s.lat),
          note: s.note ? String(s.note) : "",
          photoQuery: s.photoQuery ? String(s.photoQuery) : "",
          kind: s.kind === "via" ? "via" : "stop",
          day: Math.max(1, Math.round(Number(s.day)) || 1),
          road: s.road ? String(s.road).slice(0, 120) : "",
          // photos found for the stop, kept so they aren't looked up again
          ...(Array.isArray(s.photos) && { photos: s.photos.slice(0, 4).map(String) }),
        })),
        mode: mode === "fastest" ? "fastest" : "scenic",
        routes: routes && typeof routes === "object" ? packRoutes(routes) : null,
        // AI plan with its days, featured roads and spots (plus their Wikipedia details)
        plan: plan && typeof plan === "object" && !Array.isArray(plan) ? plan : null,
        createdAt: trips[id]?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return trips[id];
    });
    if (trip.denied) return res.status(403).json({ error: trip.denied });
    res.json({ id: trip.id, updatedAt: trip.updatedAt });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
app.put("/api/trips/:id", saveTrip);
app.post("/api/trips/:id/beacon", saveTrip);

app.delete("/api/trips/:id", async (req, res) => {
  try {
    await updateTrips((trips) => {
      if (trips[req.params.id] && (trips[req.params.id].preset ? !DEMO : ownTrip(req, trips[req.params.id]))) delete trips[req.params.id];
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- photos (Wikimedia Commons, free, no key) ----------

const photoCache = new Map();
const NOT_A_PHOTO = /\b(map|logo|flag|seal|diagram|locator|coat of arms|icon|sign|plaque)\b/i;
// Commons photos of a place: [{ src, page, title }]. Names repeat across the world ("Tunnel View" is in Yosemite and
// in Grand Teton), so where the place is known the photos must be from there:
//   at:   { lat, lng } of the place: photos taken within 3 km, ones naming the place first, then the nearest.
//   near: [[lng, lat], ...] (the day's stops, or a road's): a name search, dropping photos located over 150 km away.
//   ctx:  names around it ("Jackson, Wyoming; West Yellowstone, Montana"): a photo with no location must also name
//         one of them, or "Tunnel view at Yosemite" passes for Grand Teton's Tunnel View.
async function commonsSearch(q, { width = 640, limit = 4, at = null, near = null, ctx = "" } = {}) {
  const key = JSON.stringify([width, limit, q, at && [at.lat.toFixed(3), at.lng.toFixed(3)], near?.length ? near[0] : null, ctx]);
  if (photoCache.has(key)) return photoCache.get(key);
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  const common = { action: "query", format: "json", prop: "imageinfo|coordinates", iiprop: "url|mime|size", iiurlwidth: String(width) };
  url.search = new URLSearchParams(at
    ? { ...common, generator: "geosearch", ggscoord: `${at.lat}|${at.lng}`, ggsradius: "3000", ggsnamespace: "6", ggslimit: "50" }
    : { ...common, generator: "search", gsrsearch: `${q.replace(/,/g, " ")} filetype:bitmap`, gsrnamespace: "6", gsrlimit: "30" });
  try {
    const data = await wmFetch(url);
    let pages = Object.values(data?.query?.pages || {}).filter((p) => !NOT_A_PHOTO.test(p.title || ""));
    if (at) {
      const dist = (p) => (p.coordinates?.[0] ? haversine([at.lng, at.lat], [p.coordinates[0].lon, p.coordinates[0].lat]) : 1e9);
      pages.sort((a, b) => (sharesWord(q, b.title) - sharesWord(q, a.title)) || dist(a) - dist(b));
    } else {
      pages.sort((a, b) => a.index - b.index);
      // the file name must mention the place, so a loose search match doesn't bring in an unrelated photo
      pages = pages.filter((p) => !words(q).length || sharesWord(q, p.title));
      // and a photo with a location must be near the trip
      if (near?.length) pages = pages.filter((p) => !p.coordinates?.[0] || nearEnough(near, p.coordinates[0].lat, p.coordinates[0].lon, 150));
      if (ctx) pages = pages.filter((p) => p.coordinates?.[0] || sharesWord(ctx, p.title));
    }
    const photos = pages
      .map((p) => ({ i: p.imageinfo?.[0], title: String(p.title || "").replace(/^File:/, "").replace(/\.[a-z]+$/i, "") }))
      .filter(({ i }) => i && i.mime === "image/jpeg" && i.width >= 800 && i.width >= i.height && i.thumburl)
      .slice(0, limit)
      .map(({ i, title }) => ({ src: i.thumburl, page: i.descriptionurl, title }));
    // nothing taken right there: photos named after the place, from around it
    if (at && !photos.length && data) return commonsSearch(q, { width, limit, near: [[at.lng, at.lat]], ctx });
    if (data) photoCache.set(key, photos); // nothing cached while Wikimedia is throttling
    return photos;
  } catch {
    return [];
  }
}
const commonsPhotos = async (q, width = 640, where = {}) => (await commonsSearch(q, { width, ...where })).map((p) => p.src);
// "lat,lng" and "lng,lat;lng,lat" from query strings
const parseAt = (v) => {
  const [lat, lng] = String(v || "").split(",").map(Number);
  return isFinite(lat) && isFinite(lng) && v ? { lat, lng } : null;
};
const parseNear = (v) => String(v || "").split(";").map((x) => x.split(",").map(Number)).filter((p) => p.length === 2 && p.every(isFinite)).slice(0, 40);

app.get("/api/photos", async (req, res) => {
  const q = String(req.query.q || "").trim();
  res.json({ photos: q ? await commonsPhotos(q, 640, { at: parseAt(req.query.at), near: parseNear(req.query.near) }) : [] });
});

// Lead photos of Wikipedia articles, for the home screen's trip cards. POST { titles: [...] } -> { images: { title: url } }
app.post("/api/wiki-images", async (req, res) => {
  const titles = asArray(req.body?.titles).map(String).filter(Boolean).slice(0, 80);
  const images = {};
  try {
    for (let i = 0; i < titles.length; i += 20) {
      const chunk = titles.slice(i, i + 20);
      const d = await wmFetch(wikiUrl({ titles: chunk.join("|"), pithumbsize: "640" }));
      if (!d?.query) continue;
      const pages = new Map((d.query.pages || []).filter((p) => !p.missing).map((p) => [p.title, p]));
      const follow = (t) => {
        for (const n of d.query.normalized || []) if (n.from === t) t = n.to;
        for (const r of d.query.redirects || []) if (r.from === t) t = r.to;
        return t;
      };
      for (const t of chunk) {
        const src = pages.get(follow(t))?.thumbnail?.source;
        if (isPhoto(src)) images[t] = src;
      }
    }
    // articles that lead with a map or a drawing: a Commons photo of the place instead
    for (const t of titles) if (!images[t]) images[t] = (await commonsPhotos(t.replace(/ \(.*\)$/, ""), 640))[0] || "";
  } catch {
    // cards fall back to a gradient
  }
  res.json({ images });
});

// A photo gallery for a place: up to 8 Commons photos with their file pages (author and license are on the page).
app.get("/api/gallery", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (!q) return res.json({ photos: [] });
  res.json({ photos: await commonsSearch(q, { width: 1280, limit: 8, at: parseAt(req.query.at), near: parseNear(req.query.near), ctx: String(req.query.ctx || "").slice(0, 500) }) });
});


// ---------- weather and daylight (Open-Meteo: free, no key, non-commercial) ----------

// POST { points: [{ lat, lng, date: "2026-07-04" }] } -> { results: [{ tz, kind: "forecast"|"typical", tmax, tmin, rain, code, wind }] }
// Within the 16-day forecast: the forecast. Further out: what the last three years were like around that date.
// Every result has the place's time zone (IANA name), used for sunrise and sunset and for arrival times.
const weatherCache = diskCache("weather-cache.json", 30, 3000);
async function openMeteo(base, pts, params) {
  const u = new URL(base);
  u.search = new URLSearchParams({
    latitude: pts.map((p) => p.lat.toFixed(3)).join(","),
    longitude: pts.map((p) => p.lng.toFixed(3)).join(","),
    timezone: "auto",
    ...params,
  });
  const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20000) });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d) throw new Error(d?.reason || `Open-Meteo ${r.status}`);
  return Array.isArray(d) ? d : [d];
}
const isoDay = (d) => d.toISOString().slice(0, 10);
const addDays = (iso, n) => isoDay(new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000));

app.post("/api/weather", async (req, res) => {
  const pts = asArray(req.body?.points)
    .slice(0, 40)
    .map((p) => ({ lat: Number(p.lat), lng: Number(p.lng), date: String(p.date || "") }))
    .filter((p) => isFinite(p.lat) && isFinite(p.lng) && /^\d{4}-\d{2}-\d{2}$/.test(p.date));
  if (!pts.length) return res.json({ results: [] });
  const today = isoDay(new Date());
  const lastForecast = addDays(today, 15);
  const results = new Array(pts.length).fill(null);
  const key = (p) => `${p.lat.toFixed(2)},${p.lng.toFixed(2)},${p.date}`;
  for (const [i, p] of pts.entries()) {
    const hit = await weatherCache.get(key(p));
    // forecasts are refreshed after 6 hours, typical weather is kept
    if (hit && (hit.kind === "typical" || Date.now() - hit.at < 6 * 3600000)) results[i] = hit;
  }
  try {
    // 1. Forecast for dates in the next 16 days
    const soon = pts.map((p, i) => ({ ...p, i })).filter((p) => !results[p.i] && p.date >= today && p.date <= lastForecast);
    if (soon.length) {
      const dates = soon.map((p) => p.date).sort();
      const out = await openMeteo("https://api.open-meteo.com/v1/forecast", soon, {
        daily: "temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,wind_speed_10m_max",
        start_date: dates[0], end_date: dates.at(-1),
      });
      soon.forEach((p, k) => {
        const d = out[k];
        const j = d?.daily?.time?.indexOf(p.date) ?? -1;
        if (j < 0) return;
        results[p.i] = {
          tz: d.timezone, kind: "forecast", at: Date.now(),
          tmax: d.daily.temperature_2m_max[j], tmin: d.daily.temperature_2m_min[j],
          rain: d.daily.precipitation_probability_max[j], code: d.daily.weather_code[j], wind: d.daily.wind_speed_10m_max[j],
        };
        weatherCache.set(key(p), results[p.i]);
      });
    }
    // 2. Typical weather: the same dates (plus or minus 3 days) in each of the last three years
    const later = pts.map((p, i) => ({ ...p, i })).filter((p) => !results[p.i]);
    if (later.length) {
      const dates = later.map((p) => p.date).sort();
      const thisYear = new Date().getUTCFullYear();
      const acc = later.map(() => ({ tmax: [], tmin: [], wet: 0, n: 0, wind: [], tz: "" }));
      for (const back of [1, 2, 3]) {
        // shift the window back whole years, keeping it in the past
        const shift = (iso) => `${Number(iso.slice(0, 4)) - (Number(dates.at(-1).slice(0, 4)) - thisYear) - back}${iso.slice(4)}`;
        const from = shift(addDays(dates[0], -3));
        const to = shift(addDays(dates.at(-1), 3));
        const out = await openMeteo("https://archive-api.open-meteo.com/v1/archive", later, {
          daily: "temperature_2m_max,temperature_2m_min,precipitation_sum,wind_speed_10m_max", start_date: from, end_date: to,
        });
        later.forEach((p, k) => {
          const d = out[k];
          if (!d?.daily) return;
          acc[k].tz = d.timezone;
          const center = shift(p.date);
          d.daily.time.forEach((t, j) => {
            if (Math.abs(Date.parse(t) - Date.parse(center)) > 3 * 86400000) return;
            if (d.daily.temperature_2m_max[j] == null) return;
            acc[k].tmax.push(d.daily.temperature_2m_max[j]);
            acc[k].tmin.push(d.daily.temperature_2m_min[j]);
            acc[k].wind.push(d.daily.wind_speed_10m_max[j]);
            acc[k].n++;
            if (d.daily.precipitation_sum[j] >= 1) acc[k].wet++;
          });
        });
      }
      const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
      later.forEach((p, k) => {
        const a = acc[k];
        if (!a.n) return;
        const rain = Math.round((a.wet / a.n) * 100);
        results[p.i] = {
          tz: a.tz, kind: "typical", at: Date.now(), tmax: avg(a.tmax), tmin: avg(a.tmin), rain, wind: avg(a.wind),
          // a rough sky for the icon: often wet, sometimes wet, mostly dry
          code: rain >= 50 ? 61 : rain >= 25 ? 3 : 1,
        };
        weatherCache.set(key(p), results[p.i]);
      });
    }
    res.json({ results });
  } catch (e) {
    res.json({ results, error: e.message });
  }
});

// ---------- along the route: fuel, chargers, viewpoints, waterfalls, hot springs, diners, lodging (OpenStreetMap) ----------

// POST { line: [[lng, lat], ...] (one day, simplified), overnight: [lng, lat] }
//   -> { pois: [{ k, lng, lat, name }], lodging: { hotel, motel, guest, camp },
//        stay: [{ name, k, lng, lat, web }] (nearest named places to stay), food: [{ name, cuisine, lng, lat, web }] }
// k: fuel | ev | evfast | view | falls | spring | diner. Overpass is free and public, so one query per day, cached 14 days.
const alongCache = diskCache("along-cache.json", 14, 500);
// The main public server first, then other public instances. In October 2026 overpass-api.de was the only one that
// answered from here (overpass.private.coffee, maps.mail.ru and overpass.kumi.systems timed out), and it was itself
// unreachable for a while one day, so a server that fails is skipped for a few minutes and the next one tried.
// OVERPASS_URLS (comma-separated) replaces the list, for example with your own Overpass server.
const OVERPASS = process.env.OVERPASS_URLS?.split(",").map((x) => x.trim()).filter(Boolean) || [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const overpassRest = new Map(); // url -> skip until (ms)
// Busy public servers turn away big queries ("Dispatcher_Client::request_read_and_idx::timeout"), so every query
// declares a short timeout and a small memory budget, covers only a few boxes, and is retried after a pause.
async function overpass(body) {
  const query = `[out:json][timeout:25][maxsize:67108864];${body}`;
  let last = null;
  let reached = false;
  for (let round = 0; round < 2; round++) {
    // the servers allow a few queries at a time per address and refuse the rest, so wait it out once
    if (round) await new Promise((ok) => setTimeout(ok, 10000));
    for (const [i, url] of OVERPASS.entries()) {
      if ((overpassRest.get(url) || 0) > Date.now()) continue;
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query),
          // the backups often hang without answering
          signal: AbortSignal.timeout(i ? 20000 : 30000),
        });
        reached = true;
        if (r.ok) {
          const d = await r.json();
          // a query that ran out of time or memory still answers 200, with the error in "remark"
          if (/error/i.test(d.remark || "")) throw new Error(d.remark);
          return d;
        }
        last = new Error(`Overpass ${r.status}`);
        if (r.status === 429 || r.status >= 500) overpassRest.set(url, Date.now() + 60000);
      } catch (e) {
        last = e;
        console.log(`Overpass ${new URL(url).host}: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`);
        // can't connect or no answer at all: rest that server for a while
        if (e.name === "TimeoutError" || /CONNECT_TIMEOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(e.cause?.code || "")) {
          overpassRest.set(url, Date.now() + 10 * 60000);
        }
      }
    }
  }
  if (!reached) {
    const down = new Error("OpenStreetMap's search servers are unreachable right now");
    down.down = true;
    throw down;
  }
  throw last || new Error("Overpass failed");
}
// Meters from a point to a polyline (flat-earth math, fine at these distances).
function distToLine(p, line) {
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 110540;
  let best = Infinity;
  for (let i = 0; i < line.length - 1; i++) {
    const ax = (line[i][0] - p[0]) * kx;
    const ay = (line[i][1] - p[1]) * ky;
    const bx = (line[i + 1][0] - p[0]) * kx;
    const by = (line[i + 1][1] - p[1]) * ky;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
// Boxes covering a line: one per ~30 km of it, padded by `padKm`. Returns [[south, west, north, east], ...].
function lineBoxes(line, padKm = 6) {
  const boxes = [];
  let cur = null;
  let run = 0;
  for (let i = 0; i < line.length; i++) {
    const [lng, lat] = line[i];
    if (i) run += haversine(line[i - 1], line[i]);
    if (!cur || run > 30000) {
      if (cur) boxes.push(cur);
      cur = [lat, lng, lat, lng];
      if (i) cur = [Math.min(lat, line[i - 1][1]), Math.min(lng, line[i - 1][0]), Math.max(lat, line[i - 1][1]), Math.max(lng, line[i - 1][0])];
      run = 0;
    }
    cur = [Math.min(cur[0], lat), Math.min(cur[1], lng), Math.max(cur[2], lat), Math.max(cur[3], lng)];
  }
  if (cur) boxes.push(cur);
  return boxes.map(([s, w, n, e]) => {
    const dy = padKm / 110.5;
    const dx = padKm / (111.3 * Math.cos((((s + n) / 2) * Math.PI) / 180));
    return [s - dy, w - dx, n + dy, e + dx].map((v) => +v.toFixed(4));
  });
}
// How far from the route each kind still counts (meters).
const ALONG_RADIUS = { fuel: 2500, ev: 3000, evfast: 5000, view: 1500, falls: 3000, spring: 6000, diner: 1500 };
const FAST_SOCKETS = /^socket:(type1_combo|type2_combo|chademo|tesla_supercharger|nacs|tesla_supercharger_ccs)$/;
const FAST_NAMES = /supercharger|electrify|evgo|ionna|flo\b|petro-canada|chargefox|evie|ampol|tesla|ionity|fastned|gridserve|instavolt|chargepoint express|circle k/i;
function evFast(t) {
  if (Object.keys(t).some((k) => FAST_SOCKETS.test(k) && t[k] !== "no" && t[k] !== "0")) return true;
  if (Object.entries(t).some(([k, v]) => /^socket:.*:output$/.test(k) && parseFloat(v) >= 50)) return true;
  return FAST_NAMES.test(`${t.name || ""} ${t.brand || ""} ${t.operator || ""} ${t.network || ""}`);
}

// Fuel, chargers and sights are fetched and kept per tile (0.25°, about 28 by 20 km), so trips through the same area
// share them, and when every Overpass server is down, tiles fetched before (kept a year) still answer.
const TILE = 0.25;
const alongTiles = diskCache("along-tiles.json", 60, 5000, 365);
function tilesFor(line) {
  const keys = new Set();
  for (const [s, w, n, e] of lineBoxes(line)) {
    for (let a = Math.floor(s / TILE); a <= Math.floor(n / TILE); a++) {
      for (let b = Math.floor(w / TILE); b <= Math.floor(e / TILE); b++) keys.add(`${a},${b}`);
    }
  }
  return [...keys];
}
const tileBox = (k) => {
  const [a, b] = k.split(",").map(Number);
  return [a * TILE, b * TILE, (a + 1) * TILE, (b + 1) * TILE].map((v) => +v.toFixed(4));
};
const KEEP_TAG = /^(name|brand|operator|network|amenity|tourism|waterway|natural|cuisine|access)$|^socket:/;
// What's kept of an element: where it is and the tags the app reads.
function slimElement(el) {
  const tags = Object.fromEntries(Object.entries(el.tags || {}).filter(([k]) => KEEP_TAG.test(k)));
  return { type: el.type, id: el.id, lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon, tags };
}

app.post("/api/along", async (req, res) => {
  const line = asArray(req.body?.line)
    .filter((p) => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]))
    .slice(0, 250)
    .map((p) => [Number(p[0]), Number(p[1])]);
  const night = Array.isArray(req.body?.overnight) ? req.body.overnight.map(Number) : null;
  if (line.length < 2) return res.json({ pois: [], lodging: null });
  const key = line.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(";") + (night ? `|${night.join(",")}` : "");
  const hit = await alongCache.get(key);
  if (hit) return res.json(hit);

  // The tiles along the line (cached ones first, the rest a few per query), then keep what's within reach of the route.
  const tiles = tilesFor(line);
  const parts = (b) => {
    const bb = b.join(",");
    // (searching restaurant names for "diner" ran the public server out of memory, so only places tagged as diners)
    return `nwr["amenity"~"^(fuel|charging_station)$"](${bb});node["tourism"="viewpoint"]["name"](${bb});` +
      `nwr["waterway"="waterfall"]["name"](${bb});nwr["natural"="hot_spring"](${bb});nwr["cuisine"~"diner"](${bb});`;
  };
  try {
    const elements = [];
    const have = new Map();
    const missing = [];
    for (const k of tiles) {
      const v = await alongTiles.get(k);
      if (v) have.set(k, v);
      else missing.push(k);
    }
    // a tile that still fails after the retries uses its old copy if there is one; otherwise the answer is partial
    let failed = 0;
    let stale = 0;
    let lastError = null;
    let down = false;
    for (let i = 0; i < missing.length; i += 4) {
      const group = missing.slice(i, i + 4);
      if (!down) {
        if (i) await new Promise((ok) => setTimeout(ok, 1500));
        try {
          const d = await overpass(`(${group.map((k) => parts(tileBox(k))).join("")});out center tags;`);
          const byTile = new Map(group.map((k) => [k, []]));
          for (const el of d.elements || []) {
            const e = slimElement(el);
            if (e.lat == null) continue;
            byTile.get(`${Math.floor(e.lat / TILE)},${Math.floor(e.lon / TILE)}`)?.push(e);
          }
          for (const [k, list] of byTile) {
            have.set(k, list);
            alongTiles.set(k, list);
          }
          continue;
        } catch (e) {
          lastError = e;
          down = !!e.down;
        }
      }
      for (const k of group) {
        const v = await alongTiles.getStale(k);
        if (v) {
          have.set(k, v);
          stale++;
        } else failed++;
      }
    }
    for (const list of have.values()) elements.push(...list);
    if (night) {
      const dy = 8 / 110.5;
      const dx = 8 / (111.3 * Math.cos((night[1] * Math.PI) / 180));
      const bb = [night[1] - dy, night[0] - dx, night[1] + dy, night[0] + dx].map((v) => v.toFixed(4)).join(",");
      // restaurants only close to town (3 km), or a city returns hundreds
      const fy = 3 / 110.5;
      const fx = 3 / (111.3 * Math.cos((night[1] * Math.PI) / 180));
      const fb = [night[1] - fy, night[0] - fx, night[1] + fy, night[0] + fx].map((v) => v.toFixed(4)).join(",");
      try {
        const d = await overpass(`(nwr["tourism"~"^(hotel|motel|guest_house|hostel|camp_site|caravan_site|chalet)$"](${bb});` +
          `nwr["amenity"~"^(restaurant|cafe|pub)$"]["name"](${fb}););out center tags;`);
        for (const el of d.elements || []) elements.push({ ...el, lodging: true });
      } catch {
        // lodging and food near the overnight are a nice extra
      }
    }
    if (failed && !have.size) throw lastError || new Error("no answer");
    const pois = [];
    const lodging = { hotel: 0, motel: 0, guest: 0, camp: 0 };
    const stay = [];
    const food = [];
    const web = (t) => String(t.website || t["contact:website"] || "").slice(0, 200);
    const seen = new Set();
    for (const el of elements) {
      if (seen.has(`${el.type}${el.id}${el.lodging ? "l" : ""}`)) continue;
      seen.add(`${el.type}${el.id}${el.lodging ? "l" : ""}`);
      const t = el.tags || {};
      const lng = el.lon ?? el.center?.lon;
      const lat = el.lat ?? el.center?.lat;
      if (lng == null) continue;
      const name = t.name || t.brand || "";
      if (el.lodging) {
        const at = { lng: +lng.toFixed(5), lat: +lat.toFixed(5), d: haversine(night, [lng, lat]) };
        if (t.amenity) {
          food.push({ name: String(t.name).slice(0, 80), cuisine: String(t.cuisine || t.amenity).replace(/_/g, " ").split(";")[0], web: web(t), ...at });
          continue;
        }
        const k = t.tourism === "motel" ? "motel" : /camp|caravan/.test(t.tourism) ? "camp" : /hotel/.test(t.tourism) ? "hotel" : "guest";
        lodging[k]++;
        if (t.name) stay.push({ name: String(t.name).slice(0, 80), k, web: web(t), ...at });
        continue;
      }
      const k = t.amenity === "fuel" ? "fuel"
        : t.amenity === "charging_station" ? (evFast(t) ? "evfast" : "ev")
        : t.tourism === "viewpoint" ? "view"
        : t.waterway === "waterfall" ? "falls"
        : t.natural === "hot_spring" ? "spring"
        : "diner";
      // private chargers and fuel (fleet yards, farms) are no use to a traveler
      if ((k === "fuel" || k.startsWith("ev")) && /^(private|no|customers)$/.test(t.access || "")) continue;
      if (distToLine([lng, lat], line) > ALONG_RADIUS[k]) continue;
      pois.push({ k, lng: +lng.toFixed(5), lat: +lat.toFixed(5), name: String(name).slice(0, 80) });
    }
    // the nearest ones, with a website first when it's a close call
    const nearest = (list, n) => list.sort((a, b) => a.d - (a.web ? 500 : 0) - (b.d - (b.web ? 500 : 0))).slice(0, n).map(({ d, ...x }) => x);
    const out = { pois, lodging: night ? lodging : null, stay: night ? nearest(stay, 8) : null, food: night ? nearest(food, 8) : null, partial: failed > 0 };
    console.log(`Along: ${tiles.length} tiles (${tiles.length - missing.length} cached${stale ? `, ${stale} old copies` : ""}), ` +
      `${elements.length} found, ${pois.length} near the route${failed ? `, ${failed} tiles failed` : ""}`);
    if (!failed && !stale) alongCache.set(key, out);
    res.json(out);
  } catch (e) {
    res.status(502).json({
      error: e.down ? `${e.message}. Try again later.` : `OpenStreetMap search is busy (${e.message}). Try again in a minute.`,
    });
  }
});

// GET /api/geocode?q=&limit=&towns=1 -> { hits: [{ lng, lat, cls }] }: place search for the app. Going through the server
// means one polite Nominatim client (one request a second, a User-Agent with the contact) for every device using the
// app, and a disk cache: trips through the same towns don't look them up again.
const geocodeCache = diskCache("geocode-cache.json", 30, 5000);
app.get("/api/geocode", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 200);
  const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 1));
  const towns = req.query.towns === "1";
  if (!q) return res.status(400).json({ error: "q" });
  const key = `${limit}|${towns ? "t" : ""}|${q.toLowerCase()}`;
  const hit = await geocodeCache.get(key);
  if (hit) return res.json({ hits: hit });
  const hits = await geoSearch(q, limit, towns);
  if (!Array.isArray(hits)) return res.status(502).json({ error: "Place search is busy, try again in a moment." });
  geocodeCache.set(key, hits);
  res.json({ hits });
});

// GET /api/place-name?lat=&lng= -> { name }: a name for a spot picked on the map. The town or village there, else
// "near" the nearest one within 25 km (OpenStreetMap), else the road and county.
app.get("/api/place-name", async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!isFinite(lat) || !isFinite(lng)) return res.status(400).json({ error: "lat and lng" });
  const d = await nominatimJson(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=16&lat=${lat}&lon=${lng}`);
  const a = d?.address || {};
  const region = a.state || a.region || a.province || "";
  const country = a.country_code && a.country_code !== "us" ? a.country : "";
  const tail = [region, country].filter(Boolean);
  const town = a.village || a.town || a.city || a.hamlet || a.suburb || a.municipality;
  if (town) return res.json({ name: [town, ...tail].join(", ") });
  try {
    const o = await overpass(`node["place"~"^(city|town|village|hamlet)$"]["name"](around:25000,${lat},${lng});out 40;`);
    const near = asArray(o.elements).map((e) => ({ name: e.tags.name, d: haversine([lng, lat], [e.lon, e.lat]) })).sort((x, y) => x.d - y.d)[0];
    if (near) return res.json({ name: [`near ${near.name}`, ...tail].join(", ") });
  } catch {
    // fall through to the road
  }
  const road = a.road || d?.name || "";
  res.json({ name: [road, a.county, ...tail].filter(Boolean).join(", ") || `${lat.toFixed(4)}, ${lng.toFixed(4)}` });
});

// ---------- ask the trip ----------
// POST { question, context } -> { answer, change, model }. The app sends a compact summary of the trip (days, hours,
// stops, roads, weather, fuel, places to stay); the AI answers from it like a local guide. A question that really asks
// for a change ("can we skip Winnipeg?") also returns the change as an instruction the app can apply live.
app.post("/api/ask", async (req, res) => {
  try {
    if (noAI()) return res.status(500).json({ error: NO_AI });
    const question = String(req.body?.question || "").trim().slice(0, 600);
    const context = String(req.body?.context || "").slice(0, 12000);
    if (!question) return res.status(400).json({ error: "Ask a question first." });
    const signal = clientGone(res);
    const { data, model } = await callAI({
      system: "You are a friendly road trip guide who knows the roads, towns and parks well.",
      user:
        `The traveler planned this road trip:\n${context}\n\nThe traveler asks: "${question}"\n\n` +
        "Answer from the trip above and what you know. Be short (at most about 120 words), concrete and practical, " +
        "like a local driver. Use the trip's own days, times and places. When something can change (opening hours, " +
        "prices, closures, permits), say to check it. If the question asks to change the trip (add, skip, swap, move, " +
        'shorten), also write the change as one short instruction in "change", like "Skip Winnipeg and stay in Kenora ' +
        'instead"; otherwise "change" is "". Return JSON with "answer" and "change".' + langText(req.body?.lang),
      searches: 0,
      schema: obj({ answer: str, change: str }),
      signal,
      writing: "Answering",
    });
    res.json({ answer: String(data.answer || "").trim(), change: String(data.change || "").trim(), model });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// POST /api/road-reviews { name, region } -> { points, sources, at }: what drivers say about a road, from one web
// search (Tavily) summed up by the planner AI. Only when the traveler asks (a button on the road card), and cached 30
// days per road, so it costs one search and one short AI answer per road a month at most. Without a search key it
// answers { error: "no-search" } and the card offers links to search instead.
const reviewCache = diskCache("road-reviews-cache.json", 30, 500);
app.post("/api/road-reviews", async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 120);
  const region = String(req.body?.region || "").trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: "Which road?" });
  const lang = LANG_NAMES[req.body?.lang] ? req.body.lang : "en";
  const key = `${name}|${region}${lang === "en" ? "" : `|${lang}`}`.toLowerCase();
  const hit = await reviewCache.get(key);
  if (hit) return res.json(hit);
  if (!TAVILY_KEY) return res.json({ error: "no-search" });
  if (noAI()) return res.status(500).json({ error: NO_AI });
  try {
    const results = await webSearch(`${name} ${region} driving experience tips reviews`);
    if (!results.length) return res.json({ points: [], sources: [], at: new Date().toISOString().slice(0, 10) });
    const { data } = await callAI({
      system: "You sum up what drivers say about a road, from web search results, plainly and briefly.",
      user:
        `Road: ${name}${region ? ` (${region})` : ""}.\n\nSearch results:\n` +
        results.map((r, i) => `[${i + 1}] ${r.title}\n${r.snippet}`).join("\n\n") +
        "\n\nIn 3 to 5 short points, say what drivers say about driving this road: what it's like, the best time to go, " +
        "traffic, hazards and tips. Use only what the results say, and skip what they don't cover. Each point at most " +
        '25 words, no lead-in like "Drivers say". Return JSON with "points" (a list of strings).' + langText(req.body?.lang),
      searches: 0,
      schema: obj({ points: { type: "array", items: str } }),
      signal: clientGone(res),
      writing: "Summing up",
    });
    const out = {
      points: (data.points || []).map((x) => String(x).trim()).filter(Boolean).slice(0, 5),
      sources: results.slice(0, 5).map(({ url, title }) => ({ url, title })),
      at: new Date().toISOString().slice(0, 10),
    };
    reviewCache.set(key, out);
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// The PC's addresses on the local network, for share links a phone on the same Wi-Fi can open.
app.get("/api/lan", async (req, res) => {
  const { networkInterfaces } = await import("node:os");
  // Wi-Fi and Ethernet addresses, without VPN tunnels and virtual adapters a phone can't reach (a Mac VPN showed up as
  // utun6). Tailscale's 100.64.0.0/10 addresses stay: phones on the same tailnet reach those.
  const tunnel = /^(utun|ipsec|ppp|tun|tap|docker|vboxnet|vmnet|bridge|awdl|llw|veth|br-)/i;
  const tailscale = (ip) => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip);
  const ips = Object.entries(networkInterfaces())
    .flatMap(([name, list]) => (list || []).map((n) => ({ ...n, name })))
    .filter((n) => n.family === "IPv4" && !n.internal && !/^169\.254\./.test(n.address))
    .filter((n) => !tunnel.test(n.name) || tailscale(n.address))
    .map((n) => n.address);
  res.json({ ips, port: Number(process.env.PORT || 3000) });
});

// ---------- Wikipedia details for roads and spots ----------

// Wikimedia rejects bursts of API calls ("You are making too many requests"). Every Wikipedia and Commons
// call goes through this queue: one at a time with a short gap, and cached. When Wikimedia says to slow
// down twice in a row, lookups pause for a minute and return nothing, so a plan finishes without the
// missing photos instead of waiting minutes (the app offers to fetch them again later).
// The cache is kept on disk (data/wikimedia-cache.json) so restarting the server doesn't repeat lookups.
const WM_CACHE_FILE = path.resolve("data", "wikimedia-cache.json");
const wmCache = new Map();
// Wikimedia answers carry a lot the app never reads (srcset variants, paging, tracking parameters on every image URL):
// about 30 KB per Commons search, most of the 40 MB the cache had grown to. Kept answers are trimmed to what's used.
const WM_UNUSED = new Set(["responsiveUrls", "thumbattribs", "continue", "batchcomplete", "imagerepository", "descriptionshorturl", "warnings"]);
function wmTrim(v) {
  if (typeof v === "string") return v.replace(/\?utm_source=[^"\s]*$/, "");
  if (Array.isArray(v)) return v.map(wmTrim);
  if (!v || typeof v !== "object") return v;
  // an image's full-size url and edit link aren't used once it has a thumbnail
  const skip = (k) => WM_UNUSED.has(k) || ("thumburl" in v && (k === "url" || k === "editurl"));
  return Object.fromEntries(Object.entries(v).filter(([k]) => !skip(k)).map(([k, x]) => [k, wmTrim(x)]));
}
try {
  for (const [k, v] of Object.entries(JSON.parse(await fs.readFile(WM_CACHE_FILE, "utf8")))) wmCache.set(k, wmTrim(v));
} catch {
  // no cache yet
}
let wmSaveTimer = null;
function saveWmCache() {
  clearTimeout(wmSaveTimer);
  wmSaveTimer = setTimeout(() => {
    const recent = Object.fromEntries([...wmCache].slice(-3000));
    fs.mkdir(path.dirname(WM_CACHE_FILE), { recursive: true })
      .then(() => fs.writeFile(WM_CACHE_FILE, JSON.stringify(recent)))
      .catch(() => {});
  }, 3000);
}
let wmChain = Promise.resolve();
let wmPausedUntil = 0;
function wmFetch(url) {
  const key = String(url);
  if (wmCache.has(key)) return Promise.resolve(wmCache.get(key));
  const job = wmChain.then(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (Date.now() < wmPausedUntil) return null;
      try {
        // a stuck request would block the whole queue, so give up after 15 s
        const r = await fetch(key, { headers: { "User-Agent": UA, "Api-User-Agent": UA }, signal: AbortSignal.timeout(15000) });
        if (r.status === 429 || r.status >= 500) {
          if (attempt === 1) {
            wmPausedUntil = Date.now() + 60000;
            console.log(`Wikimedia ${r.status} twice, pausing photo lookups for a minute`);
            return null;
          }
          await new Promise((ok) => setTimeout(ok, Math.min((Number(r.headers.get("retry-after")) || 2) * 1000, 5000)));
          continue;
        }
        const d = wmTrim(await r.json());
        await new Promise((ok) => setTimeout(ok, 300));
        wmCache.set(key, d);
        saveWmCache();
        return d;
      } catch (e) {
        console.log(`Wikimedia request failed (${e.name})`);
        await new Promise((ok) => setTimeout(ok, 1000));
      }
    }
    return null;
  });
  wmChain = job.catch(() => {});
  return job;
}

const WIKI_API = "https://en.wikipedia.org/w/api.php";
// No article text (extracts are the expensive, most rate-limited part, and the AI writes the descriptions).
const WIKI_PROPS = {
  action: "query", format: "json", formatversion: "2", redirects: "1",
  prop: "coordinates|pageimages|pageprops|info", inprop: "url", colimit: "max", pilimit: "max",
  ppprop: "disambiguation", piprop: "thumbnail", pithumbsize: "1280",
};
const wikiUrl = (params) => {
  const u = new URL(WIKI_API);
  u.search = new URLSearchParams({ ...WIKI_PROPS, ...params });
  return u;
};
const isDisambig = (p) => /\(disambiguation\)/.test(p.title) || p.pageprops?.disambiguation !== undefined;
// Road articles often lead with a route map or a shield. Only keep real photos (JPEGs that aren't maps or signs).
const isPhoto = (src) => {
  const file = decodeURIComponent(String(src || "").split("?")[0].split("/").pop() || "");
  return /\.jpe?g$/i.test(file) && !/map|locator|route|shield|sign|diagram|logo|seal|flag|plaque|svg/i.test(file);
};
const pageInfo = (p) => ({
  title: p.title,
  image: isPhoto(p.thumbnail?.source) ? p.thumbnail.source : "",
  url: p.fullurl || `https://en.wikipedia.org/wiki/${encodeURIComponent(p.title)}`,
  lat: p.coordinates?.[0]?.lat ?? null,
  lng: p.coordinates?.[0]?.lon ?? null,
});
const nearEnough = (near, lat, lng, km) =>
  !near?.length || near.some(([nLng, nLat]) => haversine([nLng, nLat], [lng, lat]) < km * 1000);
// With near ([[lng, lat], ...]) an article must have coordinates within km of one of those points.
const fitsNear = (near, km = 150) => (p) => {
  if (isDisambig(p)) return false;
  if (!near?.length) return true;
  const c = p.coordinates?.[0];
  return c ? nearEnough(near, c.lat, c.lon, km) : false;
};

// A search hit for a road must share a distinctive word with its name ("Teton" for Teton Park Road),
// so a generic road article from elsewhere isn't used.
const GENERIC = new Set(["road", "highway", "scenic", "byway", "route", "state", "national", "park", "drive", "trail",
  "pass", "the", "and", "loop", "parkway", "historic", "interstate", "across", "north", "south", "east", "west"]);
const words = (s) => String(s || "").toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !GENERIC.has(w)) || [];
const sharesWord = (name, title) => {
  const t = new Set(words(title));
  return words(name).some((w) => t.has(w));
};

// Exact titles, up to 20 per request. Returns Map(requested title -> page), following redirects.
async function wikiByTitles(titles) {
  const out = new Map();
  const uniq = [...new Set(titles.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 20) {
    const chunk = uniq.slice(i, i + 20);
    const d = await wmFetch(wikiUrl({ titles: chunk.join("|") }));
    if (!d?.query) continue;
    const pages = new Map((d.query.pages || []).filter((p) => !p.missing).map((p) => [p.title, p]));
    const follow = (t) => {
      for (const n of d.query.normalized || []) if (n.from === t) t = n.to;
      for (const r of d.query.redirects || []) if (r.from === t) t = r.to;
      return t;
    };
    for (const t of chunk) {
      const p = pages.get(follow(t));
      if (p) out.set(t, p);
    }
  }
  return out;
}

async function wikiSearch(q, fits) {
  const d = await wmFetch(wikiUrl({ generator: "search", gsrsearch: q, gsrlimit: "5" }));
  const pages = (d?.query?.pages || []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  return pages.find(fits) || null;
}

// The countries the planner covers, so a name like "Victoria" or "Banff" isn't found somewhere else.
// (until 1.0 searches were limited to the covered countries; they now run worldwide)
// Nominatim allows about 1 request per second, so server lookups go through a queue.
const geoCache = new Map();
let geoChain = Promise.resolve();
// Any Nominatim request, one at a time with a 1.1 s gap. Returns the JSON, or null on failure.
function nominatimJson(url) {
  const job = geoChain.then(async () => {
    await new Promise((ok) => setTimeout(ok, 1100));
    try {
      return await (await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) })).json();
    } catch {
      return null;
    }
  });
  geoChain = job.catch(() => {});
  return job;
}

// Photon (photon.komoot.io, OpenStreetMap data, no key): the fallback when Nominatim won't answer. Nominatim limits by
// network address, and a shared host (the demo site on Render's free plan) often gets refused outright.
let photonChain = Promise.resolve();
function photonSearch(q, limit, towns) {
  const job = photonChain.then(async () => {
    await new Promise((ok) => setTimeout(ok, 250));
    try {
      const url = `https://photon.komoot.io/api/?lang=en&limit=${limit}${towns ? "&osm_tag=place" : ""}&q=${encodeURIComponent(q)}`;
      const d = await (await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) })).json();
      if (!Array.isArray(d?.features)) return null;
      // osm_key is the same "class" Nominatim reports (place, boundary, tourism, natural, waterway...)
      return d.features.map((f) => ({ lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], cls: f.properties?.osm_key || "" }));
    } catch {
      return null;
    }
  });
  photonChain = job.catch(() => {});
  return job;
}
// Search for a place: [{ lng, lat, cls }], [] when nothing matches, or null when no service answered. A Nominatim
// that fails rests for a minute, so the next lookups go straight to Photon instead of each waiting out a timeout.
let nominatimRestUntil = 0;
async function geoSearch(q, limit = 1, towns = false) {
  if (Date.now() >= nominatimRestUntil) {
    const d = await nominatimJson(`https://nominatim.openstreetmap.org/search?format=json&limit=${limit}${towns ? "&featureType=settlement" : ""}&q=${encodeURIComponent(q)}`);
    if (Array.isArray(d)) return d.map((x) => ({ lng: +x.lon, lat: +x.lat, cls: x.class }));
    nominatimRestUntil = Date.now() + 60000;
    console.log("Nominatim didn't answer, using Photon for a minute");
  }
  return photonSearch(q, limit, towns);
}
async function geocodeServer(q) {
  if (geoCache.has(q)) return geoCache.get(q);
  const d = await geoSearch(q, 1);
  if (!d) return null;
  const hit = d[0] ? { lat: d[0].lat, lng: d[0].lng } : null;
  geoCache.set(q, hit);
  return hit;
}

// Details for the plan's featured roads and spots: article, photo and (for spots) coordinates.
// roads: [{ key, name, wiki }], spots: [{ key, name, wiki, near: [[lng, lat], ...] }]
app.post("/api/enrich", async (req, res) => {
  const roads = Array.isArray(req.body?.roads) ? req.body.roads.slice(0, 60) : [];
  const spots = Array.isArray(req.body?.spots) ? req.body.spots.slice(0, 80) : [];
  const out = { roads: {}, spots: {} };
  try {
    // 1. Titles the AI was confident about, in batches.
    const byTitle = await wikiByTitles([...roads.map((r) => r.wiki), ...spots.map((s) => s.wiki)]);
    for (const r of roads) {
      const p = byTitle.get(r.wiki);
      if (p && !isDisambig(p)) out.roads[r.key] = pageInfo(p);
    }
    for (const s of spots) {
      const p = byTitle.get(s.wiki);
      // an article without coordinates is still trusted when the AI named it exactly
      if (p && !isDisambig(p) && (!p.coordinates || fitsNear(s.near)(p))) out.spots[s.key] = pageInfo(p);
    }
    // 2. Search for the rest; spots must be near the day's route.
    for (const r of roads) {
      if (out.roads[r.key]) continue;
      const p = await wikiSearch(r.name, (pg) => fitsNear(null)(pg) && sharesWord(r.name, pg.title));
      if (p) out.roads[r.key] = pageInfo(p);
    }
    for (const s of spots) {
      if (out.spots[s.key]) continue;
      // a different place nearby isn't it ("Bernie's Diner" found the Northern Hotel's article)
      const p = await wikiSearch(s.name, (pg) => fitsNear(s.near)(pg) && sharesWord(s.name, pg.title));
      if (p) out.spots[s.key] = pageInfo(p);
    }
    // 3. Coordinates from Nominatim for spots without an article location.
    for (const s of spots) {
      const w = (out.spots[s.key] ||= {});
      if (w.lat != null) continue;
      const g = await geocodeServer(s.name);
      if (g && nearEnough(s.near, g.lat, g.lng, 150)) Object.assign(w, g);
    }
    // 4. A Commons photo where Wikipedia had none.
    for (const s of spots) {
      const w = out.spots[s.key];
      if (!w.image) {
        const where = w.lat != null ? { at: { lat: w.lat, lng: w.lng }, ctx: s.ctx } : { near: s.near, ctx: s.ctx };
        w.image = (await commonsPhotos(s.name, 1280, where))[0] || "";
      }
    }
    for (const r of roads) {
      const w = (out.roads[r.key] ||= {});
      if (!w.image) w.image = (await commonsPhotos(r.photo || r.name, 1280, { near: r.near, ctx: r.ctx }))[0] || "";
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---------- AI trip planning ----------

// Claude (Haiku 5.5 by default) when ANTHROPIC_API_KEY is set: fast, and it can search the web, so it reads what road
// trip forums and driving sites say about the route. Without a key it uses Gemini's free tier (no web search).
// AI_PROVIDER=claude or gemini in .env picks one explicitly. If Claude fails and a Gemini key exists, Gemini takes over.
const anthropic = ANTHROPIC_KEY ? new Anthropic() : null; // reads ANTHROPIC_API_KEY from the environment
// The planner is Gemini unless AI_PROVIDER=claude. (Until 1.1 it could also be a local model in LM Studio; an old
// AI_PROVIDER=local in .env counts as Gemini.)
const pickProvider = (v) => ((v || "").toLowerCase() === "claude" ? "claude" : "gemini");
let AI_PROVIDER = pickProvider(process.env.AI_PROVIDER);
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || "medium"; // low | medium | high
// Web searches allowed per call ($10 per 1,000 searches). 0 turns search off.
const SEARCHES_PLAN = Number(process.env.CLAUDE_SEARCHES_PLAN ?? 4);
const SEARCHES_DETAILS = Number(process.env.CLAUDE_SEARCHES_DETAILS ?? 5);

// Free-tier Gemini models are often overloaded (503), rate limited (429) or drop long answers part way,
// and non-streamed requests get cut off around 60 s. So: stream the answer, and move to the next model on any failure.
const GEMINI_MODELS = [GEMINI_MODEL, ...GEMINI_FALLBACKS].filter((m, i, a) => m && a.indexOf(m) === i);
// Gemini's free limits are per model per day and reset at midnight Pacific time, so requests are counted that way
// (data/gemini-usage.json) and shown in Setup, with the models that answered "limit reached" (429) today.
const GEMINI_USAGE_FILE = path.resolve("data", "gemini-usage.json");
const pacificDay = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
let geminiUsage = null;
async function geminiUsageToday() {
  if (!geminiUsage) {
    try {
      geminiUsage = JSON.parse(await fs.readFile(GEMINI_USAGE_FILE, "utf8"));
    } catch {
      geminiUsage = null;
    }
  }
  if (geminiUsage?.day !== pacificDay()) geminiUsage = { day: pacificDay(), models: {}, limited: [] };
  return geminiUsage;
}
async function countGemini(model, limited) {
  const u = await geminiUsageToday();
  u.models[model] = (u.models[model] || 0) + 1;
  if (limited && !u.limited.includes(model)) u.limited.push(model);
  fs.mkdir(path.dirname(GEMINI_USAGE_FILE), { recursive: true })
    .then(() => fs.writeFile(GEMINI_USAGE_FILE, JSON.stringify(u)))
    .catch(() => {});
}

// GEMINI_BASE_URL: another endpoint with the same API (a proxy, or a stand-in for tests).
const GEMINI_BASE = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com").replace(/\/$/, "");
// `onText` (optional) gets the answer so far as it streams; `signal` cancels; `schema` (JSON Schema) makes Gemini answer
// in exactly that shape (Flash-Lite without it sometimes wrote broken JSON, which cost a fallback to the next model).
// When every model says it's busy ("high demand", which Google's free tier says in bursts), it waits and goes round
// once or twice more (8 s, then 20 s) before giving up; a busy answer doesn't count against the free limit.
// `models` (optional) replaces the model list: the planner eval (tools/eval-planner.mjs) measures one model at a time.
async function callGemini(prompt, { signal, onText, schema, models = GEMINI_MODELS } = {}) {
  const errors = [];
  // busy or a passing server error on Google's side (500 "Internal error encountered" comes in the same bursts)
  const busy = (m) => /high demand|overloaded|unavailable|try again later|internal error|50[0-4]/i.test(m);
  for (const [round, wait] of [[0, 0], [1, 8000], [2, 20000]]) {
    if (round && !errors.slice(-models.length).every((e) => busy(e))) break;
    if (wait) {
      console.log(`Gemini: every model busy, trying again in ${wait / 1000} s`);
      await new Promise((ok, no) => {
        const t = setTimeout(ok, wait);
        signal?.addEventListener("abort", () => (clearTimeout(t), no(new Error("Cancelled."))), { once: true });
      });
    }
  for (const model of models) {
    if (signal?.aborted) throw new Error("Cancelled.");
    try {
      const r = await fetch(`${GEMINI_BASE}/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json", ...(schema && { responseJsonSchema: schema }) },
        }),
        // a stalled stream moves on to the next model
        signal: signal ? AbortSignal.any([AbortSignal.timeout(240000), signal]) : AbortSignal.timeout(240000),
      });
      // busy answers (503) don't use the quota; answers and "limit reached" (429) do
      if (r.ok || r.status === 429) countGemini(model, r.status === 429);
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d?.error?.message || `HTTP ${r.status}`);
      }
      let text = "";
      let buf = "";
      let version = model;
      const dec = new TextDecoder();
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line.startsWith("data:")) continue;
          const d = JSON.parse(line.slice(5));
          if (d.error) throw new Error(d.error.message || "stream error");
          version = d.modelVersion || version;
          text += (d.candidates?.[0]?.content?.parts || []).map((p) => (p.thought ? "" : p.text || "")).join("");
          onText?.(text);
        }
      }
      JSON.parse(text); // a cut-off answer fails here and moves on to the next model
      return { text, model: version };
    } catch (e) {
      if (signal?.aborted) throw new Error("Cancelled.");
      errors.push(`${model}: ${e.message}`);
      console.log(`Gemini ${model} failed: ${e.message}`);
    }
  }
  }
  const last = errors.slice(-models.length);
  if (last.every((e) => busy(e))) throw new Error("Google's free Gemini models are all busy right now (that comes and goes). Try again in a few minutes.");
  throw new Error(`The AI couldn't answer, please try again in a minute. (${last.join("; ")})`);
}

// One Claude answer, streamed (long outputs), with the web search tool when searches > 0.
// A long search turn can stop with "pause_turn"; sending the turn back lets Claude carry on.
// The system prompt is cached, so the byway catalog isn't re-billed in full on the revision call.
async function callClaude({ system, user, searches = 0 }) {
  const tools = searches > 0 ? [{ type: "web_search_20250305", name: "web_search", max_uses: searches }] : undefined;
  const messages = [{ role: "user", content: user }];
  const sources = new Map();
  let text = "";
  let msg;
  let searched = 0;
  for (let turn = 0; turn < 5; turn++) {
    const stream = anthropic.messages.stream({
      model: CLAUDE_MODEL,
      max_tokens: 32000,
      output_config: { effort: CLAUDE_EFFORT },
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages,
      ...(tools && { tools }),
    });
    msg = await stream.finalMessage();
    for (const b of msg.content) {
      if (b.type === "text") text += b.text;
      // a failed search returns an error object here instead of a list of results
      if (b.type === "web_search_tool_result" && Array.isArray(b.content)) {
        for (const r of b.content) if (r.url) sources.set(r.url, r.title || r.url);
      }
    }
    searched += msg.usage?.server_tool_use?.web_search_requests || 0;
    if (msg.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: msg.content });
  }
  const u = msg.usage || {};
  console.log(
    `Claude ${msg.model}: ${u.input_tokens} in (+${u.cache_read_input_tokens || 0} cached), ${u.output_tokens} out, ${searched} searches`
  );
  if (msg.stop_reason === "refusal") throw new Error("Claude declined to plan this trip. Try describing it differently.");
  if (msg.stop_reason === "max_tokens") throw new Error("The plan was too long and got cut off. Try fewer days or stops.");
  return { text, model: msg.model, sources: [...sources].map(([url, title]) => ({ url, title })) };
}

// The JSON object in an answer: the last ```json block, otherwise everything from the first { to the last }.
function extractJson(text) {
  const blocks = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidate = blocks.length ? blocks[blocks.length - 1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(candidate);
}

// Ask the configured AI for a JSON answer. Returns { data, model, sources }.
// signal: stop when the app stops waiting. region: a key for reusing research notes.
// `model`: a Gemini model to use alone, no fallbacks (the planner eval).
async function callAI({ system, user, searches = 0, schema, signal, region, onEvent, writing, model: only }) {
  if (AI_PROVIDER === "claude" && anthropic && !only) {
    try {
      const ending = searches > 0
        ? `Before answering, use web search (at most ${searches} searches) to check what road trip and driving communities ` +
          "(Reddit, motorcycle and driving-road forums, travel writers) recommend for this route and region, and any current " +
          "road closures. Then reply with only the JSON object, in a ```json code block."
        : "Reply with only the JSON object, in a ```json code block.";
      const r = await callClaude({ system, user: `${user}\n\n${ending}`, searches });
      let data;
      try {
        data = extractJson(r.text);
      } catch {
        // rare: broken JSON. One quick pass to repair it, without search.
        const fix = await callClaude({
          system: "You repair JSON.",
          user: `Return the JSON object from this answer as valid JSON, in a \`\`\`json code block, changing nothing else:\n\n${r.text}`,
        });
        data = extractJson(fix.text);
      }
      return { data, model: r.model, sources: r.sources };
    } catch (e) {
      const why =
        e instanceof Anthropic.AuthenticationError ? "the ANTHROPIC_API_KEY in .env was rejected"
        : e instanceof Anthropic.PermissionDeniedError ? "the API key isn't allowed to use this model"
        : e instanceof Anthropic.RateLimitError ? "Claude is rate limiting this key, try again in a minute"
        : e instanceof Anthropic.APIError ? `Claude API error ${e.status}: ${e.message}`
        : e.message;
      console.log(`Claude failed: ${why}`);
      if (!GEMINI_KEY) throw new Error(`Claude failed: ${why}`);
      console.log("Falling back to Gemini");
    }
  }
  // Gemini streams too, so the app shows the plan as it's written (partial events with the finished part of the plan)
  onEvent?.({ type: "status", text: writing || "Writing the plan" });
  let lastPartial = "";
  let lastLen = 0;
  const partialOut = every(400, (text) => {
    if (text.length < lastLen) lastPartial = ""; // the next model started over
    lastLen = text.length;
    const data = partialJson(text);
    const key = data ? JSON.stringify(data) : "";
    if (key.length > lastPartial.length) {
      lastPartial = key;
      onEvent?.({ type: "partial", data });
    }
  });
  const { text, model } = await callGemini(`${system}\n\n${user}\n\nReturn JSON only.`, { signal, onText: partialOut, schema, ...(only && { models: [only] }) });
  return { data: JSON.parse(text), model, sources: [] };
}

// ---------- web search (Tavily) ----------

// Web search through Tavily's API (free plan: 1,000 searches a month, no card). Each search costs 1 credit
// (search_depth "basic"). A monthly count is kept in data/search-usage.json and searching stops at
// TAVILY_MONTHLY_LIMIT, under the free allowance. Without TAVILY_API_KEY the model plans without searching.
let TAVILY_KEY = (process.env.TAVILY_API_KEY || "").trim();
const TAVILY_LIMIT = Number(process.env.TAVILY_MONTHLY_LIMIT ?? 900);
const USAGE_FILE = path.resolve("data", "search-usage.json");
const thisMonth = () => new Date().toISOString().slice(0, 7);
async function searchUsage() {
  try {
    const u = JSON.parse(await fs.readFile(USAGE_FILE, "utf8"));
    return u.month === thisMonth() ? u : { month: thisMonth(), count: 0 };
  } catch {
    return { month: thisMonth(), count: 0 };
  }
}
const searchAvailable = () => !!TAVILY_KEY;

// Searches, pages and research notes are kept on disk for 30 days, so planning the same region again is quicker
// and doesn't spend the monthly searches twice.
const searchCache = diskCache("search-cache.json", 30, 1500);
const notesCache = diskCache("region-notes.json", 30, 200);
// Key for a region: its states, sorted ("colorado|utah").
const regionKey = (states) => [...new Set(asArray(states).map(placeKey).filter(Boolean))].sort().join("|");
async function regionNotes(key) {
  return key ? (await notesCache.get(key)) || null : null;
}
function saveRegionNotes(key, notes) {
  if (key) notesCache.set(key, String(notes).slice(0, 3000));
}

let searchChain = Promise.resolve();
async function webSearch(query) {
  const key = query.toLowerCase().trim();
  const hit = await searchCache.get(key);
  if (hit) return hit;
  // one search at a time, so the monthly count stays exact
  const job = searchChain.then(async () => {
    if (!TAVILY_KEY) throw new Error("web search isn't set up");
    const usage = await searchUsage();
    if (usage.count >= TAVILY_LIMIT) throw new Error("this month's free searches are used up, so plan from what you know");
    const r = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { Authorization: `Bearer ${TAVILY_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, search_depth: "basic", max_results: 5, topic: "general" }),
      signal: AbortSignal.timeout(20000),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`search failed (${r.status}${d?.detail?.error ? `: ${d.detail.error}` : ""})`);
    usage.count += d?.usage?.credits || 1;
    await fs.mkdir(path.dirname(USAGE_FILE), { recursive: true });
    await fs.writeFile(USAGE_FILE, JSON.stringify(usage));
    const results = (d.results || []).map((x) => ({ url: x.url, title: x.title || x.url, snippet: String(x.content || "").slice(0, 700) }));
    searchCache.set(key, results);
    return results;
  });
  searchChain = job.catch(() => {});
  return job;
}

// An AbortSignal that fires when the app stops waiting for this request (it replaced the request with a newer one,
// or the tab closed), so the AI doesn't keep writing an answer nobody will read.
function clientGone(res) {
  const c = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) c.abort();
  });
  return c.signal;
}

// Calls fn(x) at most every `ms` milliseconds; the calls in between are dropped (the next one carries the newer state).
function every(ms, fn) {
  let last = 0;
  return (x) => {
    const now = Date.now();
    if (now - last < ms) return;
    last = now;
    fn(x);
  };
}

// The finished part of a JSON answer that's still being written: everything up to the last closed object or array,
// with the open brackets closed. Half-written strings are left out, so the app only shows whole days and stops.
function partialJson(text) {
  const stack = [];
  let inStr = false;
  let esc = false;
  let cut = 0;
  let open = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") {
      stack.pop();
      cut = i + 1;
      open = [...stack];
    }
  }
  if (!cut) return null;
  try {
    return JSON.parse(text.slice(text.indexOf("{"), cut) + open.reverse().map((b) => (b === "{" ? "}" : "]")).join(""));
  } catch {
    return null;
  }
}

// JSON shapes for the planner's answers (Gemini is held to these).
const str = { type: "string" };
const int = { type: "integer" };
const obj = (properties) => ({ type: "object", properties, required: Object.keys(properties) });
const PLAN_SCHEMA = obj({
  title: str,
  summary: str,
  days: { type: "array", items: obj({ day: int, title: str, overnight: str }) },
  points: { type: "array", items: obj({ name: str, kind: { type: "string", enum: ["stop", "via"] }, day: int, road: str, note: str }) },
  roads: { type: "array", items: obj({ name: str, ref: str, byway: str, days: { type: "array", items: int }, segment: str }) },
});
const SPOT_TYPES = ["viewpoint", "hike", "food", "landmark", "park", "town", "photo", "waterfall", "hot_spring"];
const DETAILS_SCHEMA = obj({
  days: {
    type: "array",
    items: obj({ day: int, summary: str, stay: str, price: { type: "string", enum: ["$", "$$", "$$$", "$$$$"] } }),
  },
  roads: { type: "array", items: obj({ name: str, why: str, drive: str, tips: str, wiki: str }) },
  spots: {
    type: "array",
    items: obj({
      name: str,
      type: { type: "string", enum: SPOT_TYPES },
      day: int, road: str, why: str, minutes: int, wiki: str,
    }),
  },
});

// The road catalog: US National Scenic Byways (data/byways.json, from tools/build-byways.mjs) plus famous
// Australian drives (data/au-drives.json, hand-picked around Sydney, Melbourne and Canberra; each has a Wikipedia
// article and its route number was checked against OpenStreetMap). Australia has no national byway program.
let byways = null;
async function loadByways() {
  if (!byways) {
    const read = async (file) => {
      try {
        return JSON.parse(await fs.readFile(appFile("data", file), "utf8"));
      } catch {
        return [];
      }
    };
    const drives = async (file, country) =>
      (await read(file)).map((d) => ({
        ...d,
        type: "Famous drive",
        country,
        miles: d.km ? Math.round(d.km / 1.609) : null,
        qualities: "",
        fhwa: "",
      }));
    byways = [
      ...(await read("byways.json")).map((b) => ({ ...b, country: "US" })),
      ...(await drives("us-drives.json", "US")), // famous US roads that aren't official byways (Tail of the Dragon...)
      ...(await drives("ca-drives.json", "CA")), // all provinces with a lot of driving, from BC to Newfoundland
      ...(await drives("au-drives.json", "AU")), // NSW, Victoria, ACT, Queensland, Tasmania
      ...(await drives("nz-drives.json", "NZ")),
      ...(await drives("uk-drives.json", "GB")),
      ...(await drives("alps-drives.json", "ALPS")), // Switzerland, Austria and the Alpine parts of Italy, France, Germany
      ...(await drives("no-drives.json", "NO")),
      ...(await drives("is-drives.json", "IS")),
      ...(await drives("ie-drives.json", "IE")),
      ...(await drives("es-drives.json", "ES")),
      ...(await drives("pt-drives.json", "PT")),
    ];
  }
  return byways;
}

const MOTORWAY_NAME = /\b(expressway|motorway|autobahn|autoroute|autostrada|autopista|autov[ií]a|auto-?estrada|tollway|turnpike|freeway)\b/i;
const PLANNER_INTRO = `You are an expert road trip planner for anywhere in the world, with a hand-checked list of celebrated roads
for the United States, Canada, Australia, New Zealand, the United Kingdom, the Alps, Norway, Iceland, Ireland, Spain and
Portugal. You know which roads driving enthusiasts, motorcyclists and
road trip communities rave about on forums, and you balance great roads with sensible travel: use interstates and fast highways
for long stretches with nothing special, and spend the driving time on roads that are worth it. Never route onto slow back roads
just to avoid a freeway.`;

const asArray = (v) => (Array.isArray(v) ? v : []);

// The traveler's language (the app's language menu) for what the AI writes. Names stay as maps know them: the app looks
// every point, road and spot up by name.
const LANG_NAMES = { fr: "French (français)", zh: "Simplified Chinese (简体中文)", bn: "Bangla (বাংলা)" };
function langText(lang) {
  const name = LANG_NAMES[lang];
  return name
    ? `\n\nLanguage: write every title, summary, note, description, tip and answer in ${name}. Keep the names of places, ` +
      "points, roads and spots exactly as a map or Wikipedia knows them (usually English or the local name), because the " +
      "app looks them up by name, and keep route numbers, JSON keys and the type values as they are."
    : "";
}

// ---------- seasonal roads (public/seasonal-roads.json, shared with the app) ----------

let seasonal = null;
async function seasonalRoads() {
  if (!seasonal) {
    try {
      seasonal = JSON.parse(await fs.readFile(appFile("public", "seasonal-roads.json"), "utf8")).roads || [];
    } catch {
      seasonal = [];
    }
  }
  return seasonal;
}
const dayOfYear = (mmdd) => {
  const [m, d] = String(mmdd).split("-").map(Number);
  return Math.round((Date.UTC(2001, m - 1, d) - Date.UTC(2001, 0, 1)) / 86400000);
};
// A seasonal road's state on a date ("2026-07-04"): open, maybe (near the usual opening or closing date), closed,
// caution (open, winter rules apply) or check (closures can happen any time). Same rules as seasonStatus in app.js.
function seasonStatus(r, iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (isNaN(d)) return "open";
  const month = d.getUTCMonth() + 1;
  if (r.kind === "check") return "check";
  if (r.kind === "caution") return (r.months || []).includes(month) ? "caution" : "open";
  const day = dayOfYear(`${month}-${d.getUTCDate()}`);
  const o = dayOfYear(r.open);
  const c = dayOfYear(r.close);
  const MARGIN = 14; // opening and closing dates move with the snow
  if (day >= o && day <= c) return day - o < MARGIN || c - day < MARGIN ? "maybe" : "open";
  const off = Math.min((o - day + 365) % 365, (day - c + 365) % 365);
  return off < MARGIN ? "maybe" : "closed";
}
const fmtMonthDay = (mmdd) => {
  const [m, d] = String(mmdd).split("-").map(Number);
  return new Date(Date.UTC(2001, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
};

// The traveler's trip options as instructions for the planner.
// settings: { startDate, startTime, maxHours, noNight, loop, styles: [...], ev, evRange (km) }
const STYLE_TEXT = {
  coast: "Favour coastal roads and ocean or lake views wherever the route allows.",
  mountains: "Favour mountain roads, passes and alpine scenery.",
  twisty: "Favour twisty roads that driving enthusiasts and motorcyclists love.",
  nocities: "Avoid big cities: route around them and pick small towns for overnights.",
  photo: "Favour famous viewpoints and photo spots, and plan the days so the best scenery comes in good light.",
  easy: "Keep the driving easy: avoid steep, narrow, unpaved or very twisty roads, and keep the days short.",
  food: "Favour classic diners, bakeries and local food stops along the way.",
};
async function settingsText(settings, states) {
  const s = settings && typeof settings === "object" ? settings : {};
  const lines = [];
  if (s.loop) lines.push("This is a loop trip: it starts and ends at the same place. Don't drive the same roads twice where you can avoid it.");
  for (const k of asArray(s.styles)) if (STYLE_TEXT[k]) lines.push(STYLE_TEXT[k]);
  if (s.startTime) lines.push(`Each day starts at ${s.startTime}.`);
  if (s.noNight) lines.push("No driving after dark: every day must arrive before sunset, so keep the days short enough for the season.");
  if (Number(s.evRange) > 0 && s.ev) {
    const km = Math.round(Number(s.evRange));
    lines.push(`The traveler drives an electric car with about ${km} km (${Math.round(km / 1.609)} mi) of range. Pick overnight towns with ` +
      `fast chargers and avoid long stretches without chargers (more than about ${Math.round(km * 0.7)} km).`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.startDate || "")) {
    const when = new Date(`${s.startDate}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
    lines.push(`The trip starts on ${when}. Plan for the season: weather, daylight and which roads are open.`);
    const want = new Set(asArray(states).map(placeKey));
    const closed = (await seasonalRoads()).filter((r) => {
      const st = placeKey(String(r.where || "").split(",").pop());
      return r.kind === "closed" && (!want.size || !st || want.has(st)) && ["closed", "maybe"].includes(seasonStatus(r, s.startDate));
    });
    if (closed.length) {
      lines.push("These roads are usually closed for the season around then. Don't use them: " +
        closed.map((r) => `${r.name} (usually open ${fmtMonthDay(r.open)} to ${fmtMonthDay(r.close)})`).join("; ") + ".");
    }
  }
  return lines.length ? `\nThe traveler's options:\n${lines.map((l) => `- ${l}`).join("\n")}` : "";
}
// The longest day the traveler wants, in hours (default 7.5).
const maxHoursOf = (settings) => {
  const h = Number(settings?.maxHours);
  return h >= 2 && h <= 14 ? h : 7.5;
};
// "Québec" and "quebec " are the same state for matching.
const placeKey = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
const bywayRecord = (b) => ({
  name: b.name, type: b.type, miles: b.miles, km: b.km || (b.miles ? Math.round(b.miles * 1.609) : null),
  description: b.description, qualities: b.qualities, fhwa: b.fhwa, wiki: b.wiki, ref: b.ref || "", country: b.country,
  // the road's name in OpenStreetMap when it differs ("Furkastrasse" for the Furka Pass)
  ...(b.osm && { osm: b.osm }),
});
const noAI = () => !anthropic && !GEMINI_KEY;
// What the app says when an AI feature is used before a planner is set up. Everything else works without keys.
const NO_AI = "Planning with AI needs a planner. Add a free Google Gemini key in Setup (the gear button, about two minutes), " +
  "Ready-made trips, the map and routes work without it.";

// Step 1: the route. Days, stops, via points and featured roads, with the byway catalog as reference.
// With current + dayHours it revises an existing plan using drive times the app measured.
// With `stream: true` in the body, an AI endpoint answers newline-separated JSON events (status, notes, partial; see
// callAI) and ends with { type: "done", ... } or { type: "error", error }. Returns emit(event) (a no-op otherwise).
function eventStream(req, res) {
  if (!req.body?.stream) return () => {};
  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.flushHeaders();
  return (e) => !res.writableEnded && res.write(`${JSON.stringify(e)}\n`);
}
// The final answer: the "done" event when streaming, plain JSON otherwise.
function finish(req, res, emit, body) {
  if (!req.body?.stream) return res.json(body);
  emit({ type: "done", ...body });
  res.end();
}
function fail(res, emit, e) {
  const error = e.message || String(e);
  if (!res.headersSent) return res.status(500).json({ error });
  emit({ type: "error", error });
  res.end();
}

// ---------- checking a plan before it's used ----------
// Any model (small local ones most) can break the plan's own rules. These checks are plain code, so they hold whichever
// model plans; the problems found go back to the model once, worded so it can fix them.

const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, a: 1 };
// The number of days the traveler asked for, or 0: "in 5 days", "a 3-day loop", "two days", "a week", "two weeks".
function requestedDays(prompt) {
  const t = String(prompt || "").toLowerCase();
  const num = (w) => NUM_WORDS[w] ?? Number(w);
  let m = t.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)[ -]days?\b/);
  if (m) return num(m[1]);
  m = t.match(/\b(a|one|two|three)[ -]weeks?\b/);
  if (m) return num(m[1]) * 7;
  return 0;
}

// Examples in the planning instructions that a model may copy into an unrelated trip, with where they really are.
const PROMPT_EXAMPLES = [
  { text: "Tioga Pass", where: "California" },
  { text: "Signal Mountain Lodge", where: "Wyoming" },
  { text: "Ouray", where: "Colorado" },
  { text: "US 550", where: "Colorado" },
];

const townOf = (name) => placeKey(String(name || "").split(",")[0]);
// "Milepost 382, Asheville, NC" and "Asheville, North Carolina" are the same place: one's town is a part of the other.
function samePlace(a, b) {
  const parts = (x) => String(x || "").split(",").map(placeKey);
  return parts(a).includes(townOf(b)) || parts(b).includes(townOf(a));
}
// Whether a point's road field names this road: models write the name ("Icefields Parkway") or the number ("AB 93").
function onRoad(point, road) {
  const pr = placeKey(point.road).replace(/[^a-z0-9]+/g, " ").trim();
  if (!pr) return false;
  return [road.name, road.ref].map((x) => placeKey(x).replace(/[^a-z0-9]+/g, " ").trim()).some((x) => x && (pr.includes(x) || x.includes(pr)));
}

// Problems in a plan, as sentences for the model. `opts`: prompt, loop, revising, feedback.
function checkPlan(plan, { prompt, loop, feedback }) {
  const issues = [];
  const days = plan.days;
  const points = plan.points;
  const n = days.length;
  if (!n) return ["The plan has no days."];
  if (!points.length) return ["The plan has no points."];

  const want = feedback ? 0 : requestedDays(prompt);
  if (want && n !== want) issues.push(`The traveler asked for ${want} days but the plan has ${n}. Plan exactly ${want} days.`);
  days.forEach((d, i) => {
    if (Number(d.day) !== i + 1) issues.push(`Days must be numbered 1 to ${n} in order; day ${i + 1} is numbered ${d.day}.`);
  });
  for (const p of points) {
    if (!(Number(p.day) >= 1 && Number(p.day) <= n)) issues.push(`Point "${p.name}" is on day ${p.day}, which doesn't exist.`);
  }
  for (const d of days) {
    const mine = points.filter((p) => Number(p.day) === Number(d.day));
    const stopsToday = mine.filter((p) => p.kind === "stop");
    if (!stopsToday.length) {
      issues.push(`Day ${d.day} has no stop. Its last stop must be the overnight, "${d.overnight}".`);
      continue;
    }
    const last = stopsToday[stopsToday.length - 1];
    if (!samePlace(last.name, d.overnight)) {
      issues.push(`Day ${d.day}'s last stop is "${last.name}" but its overnight is "${d.overnight}". They must be the same place.`);
    }
    if (mine.length > 9) issues.push(`Day ${d.day} has ${mine.length} points; at most 9 per day.`);
  }
  if (points.length > 50) issues.push(`The plan has ${points.length} points; at most 50 in total.`);
  if (loop || /\bloop\b/i.test(prompt || "")) {
    const first = points[0], end = points[points.length - 1];
    if (!samePlace(first.name, end.name)) {
      issues.push(`This is a loop, so it must end where it starts ("${first.name}"), not at "${end.name}".`);
    }
  }
  for (const r of plan.roads) {
    const rdays = asArray(r.days).map(Number);
    if (rdays.some((d) => !(d >= 1 && d <= n))) issues.push(`Road "${r.name}" lists day(s) ${rdays.join(", ")}, but the plan has ${n} days.`);
    if (!points.some((p) => onRoad(p, r))) {
      issues.push(`Featured road "${r.name}" has no point on it (no point has road "${r.name}"), so a router won't drive it. ` +
        "Add a via on it, or drop the road.");
    }
  }
  // copied examples: the example text appears, but nothing in the plan or request is in the place it belongs to
  const everything = [plan.title, ...days.map((d) => d.title), ...points.map((p) => p.name), ...plan.roads.map((r) => `${r.name} ${r.ref || ""}`)]
    .join(" | ");
  const placesText = placeKey(`${prompt || ""} | ${points.map((p) => p.name).join(" | ")}`);
  for (const ex of PROMPT_EXAMPLES) {
    if (everything.includes(ex.text) && !placesText.includes(placeKey(ex.where)) && !placeKey(prompt).includes(placeKey(ex.text))) {
      issues.push(`"${ex.text}" (in ${ex.where}) isn't on this trip; it was only an example in the instructions. Use real names from this trip.`);
    }
  }
  return [...new Set(issues)];
}

// The model's answer as a plan with the expected arrays.
function asPlan(data) {
  const plan = Array.isArray(data) ? { points: data } : { ...data };
  plan.points = asArray(plan.points || plan.stops);
  plan.days = asArray(plan.days);
  plan.roads = asArray(plan.roads);
  return plan;
}

app.post("/api/plan", async (req, res) => {
  let emit = () => {}; // set once the answer starts streaming; the catch needs it too
  try {
    if (noAI()) return res.status(500).json({ error: NO_AI });
    // Revisions send `current` (the plan so far) with any of: dayHours (measured drive times), feedback (the traveler's
    // comment, like "swap day 2 for the Adirondacks") and roadEdits ({ add: [{ name, ref, states, why }], remove: [names] }).
    const { current, dayHours, feedback, roadEdits, settings, nightDays } = req.body;
    // a pasted essay or a runaway client shouldn't fill the model's context
    const prompt = String(req.body.prompt || "").slice(0, 2000);
    if (!prompt) return res.status(400).json({ error: "Describe the trip first." });
    const signal = clientGone(res);
    const maxH = maxHoursOf(settings);
    // the planner eval picks one Gemini model (only from this computer: it bypasses the fallbacks)
    const evalModel = isLocalRequest(req) && /^gemini-[\w.-]+$/.test(req.body.evalModel || "") ? req.body.evalModel : undefined;
    emit = eventStream(req, res);

    // The states the trip crosses (a revision's, sent by the app) pick the research notes to reuse and the options text.
    const list = await loadByways();
    const stateList = asArray(req.body.states).map(String).filter(Boolean);
    const catalog = list
      .map((b) => {
        const len = b.country === "US" ? `${b.miles ?? "?"} mi` : `${b.km ?? "?"} km`;
        return `${b.name}${b.ref ? ` (${b.ref})` : ""} | ${b.type} | ${b.states.join("/")} | ${len} | ${b.description}`;
      })
      .join("\n");

    // Stable part first (cached by Claude): who the planner is and the byway catalog.
    const system = `${PLANNER_INTRO}

Celebrated scenic roads (US National Scenic Byways and All-American Roads, and famous drives elsewhere),
one per line as name | designation | states | length | description:
${catalog}

Prefer these where they fit the trip, and also use famous roads that aren't in the list. Outside the countries the list
covers, pick roads you know drivers there rate highly, with their real names and route numbers; never invent a road, and
if a country has no well-known scenic road on the way, plan a sensible route with good stops instead.
Name places so a map search finds them, with their state or region and country outside the US (in English or the
local name a map knows), like these: "Banff, Alberta, Canada",
"Lorne, Victoria, Australia", "Wānaka, Otago, New Zealand", "Fort William, Scotland, United Kingdom",
"Bormio, Lombardy, Italy", "Andermatt, Switzerland", "Geiranger, Møre og Romsdal, Norway", "Vík, Iceland", "Dingle, County Kerry,
Ireland", "Ronda, Andalusia, Spain", "Pinhão, Vila Real, Portugal". Write refs the way the country numbers its roads: "BC 99",
"QC 132", "B100" (Australia), "SH 6" (New Zealand), "A82" (UK), "SS38" (Italy), "B107" (Austria), "D902" (France), "CH 19"
(Switzerland), "E6", "Fv63", "Rv7" (Norway), "1", "F35" (Iceland), "N70", "R559" (Ireland), "A-7", "N-340", "Ma-10" (Spain),
"N222" (Portugal). High Alpine passes are only open from about June to October, and so are Norway's high mountain roads
(Trollstigen, Sognefjellet, the Snow Road) and Iceland's highland F-roads, which also need a 4x4 rental.`;

    // "via" points steer the route onto the featured roads. Any router (ours, Google Maps, Apple Maps)
    // connecting the points in order then follows those roads, so no special scenic engine is needed.
    let user = `Plan the route. Return one JSON object:
{
  "title": short trip title,
  "summary": 2 to 3 sentences on the trip's character and best roads,
  "days": [{"day": 1, "title": short day title like "Over Tioga Pass", "overnight": "Town, State"}],
  "points": [{"name": "Town, State", "kind": "stop" or "via", "day": 1, "road": road name or "", "note": one short line}],
  "roads": [{"name": common name, "ref": route number like "US 550", "byway": exact name from the list above or "",
             "days": [day numbers], "segment": "from X to Y"}]
}

Rules:
- Number of days: if the request gives one, use it. Otherwise pick enough days that most days have ${Math.max(2, Math.min(4, maxH - 3))} to ${Math.max(3, Math.min(6, maxH - 1.5))} hours of driving
  (about 200 to 330 miles, 320 to 530 km at most), with shorter days where there's a lot to see. Never more than ${maxH} hours in a day.
- Places the request names (parks, regions, towns) are must-sees. Route through each national park on or near the way and give
  it real time: a stop inside the park and a lighter driving day.
- points are in driving order. kind "stop": a place the traveler visits or sleeps at; the last stop of each day is where they
  sleep and must match that day's "overnight". Include the start and the end as stops. kind "via": a town or landmark directly
  ON a featured road, only there to make a router follow that road. Put a via near each end of every featured road and about
  every 40 to 100 miles along it wherever a faster road runs nearby, so a router can't shortcut. No vias on plain transit stretches.
- Each day has at most 9 points (Google Maps limit). At most 50 points in total.
- point names: real towns, cities or landmarks with their state, on a drivable road, that geocode well ("Ouray, Colorado").
  Never a lake, forest or park center, and never a place private cars can't reach (car-free valleys, towns and islands
  like Kamikochi, Zermatt or Ilha Grande: use the nearest place you can drive to).
- roads: every featured road once, 1 to 3 per day where the route offers them. Only roads worth driving for their own
  sake: never an ordinary interstate, motorway, expressway, autobahn, autoroute or toll highway in any country (a famous
  scenic stretch like I-70 through Glenwood Canyon is fine).
- For a featured road with a faster road nearby or inside a national park, put at least one via ON that road (a lodge,
  pullout, junction or village on it, like "Signal Mountain Lodge, Wyoming" for Teton Park Road) so a router drives it.
- No backtracking. Before answering, check the order and estimate each day's driving time.
${await settingsText(settings, stateList)}

Request: ${prompt}${langText(req.body.lang)}`;

    const revising = !!current;
    const adds = asArray(roadEdits?.add).filter((r) => r?.name);
    const removes = asArray(roadEdits?.remove).map(String).filter(Boolean);
    if (revising) {
      user += `\n\nCurrent plan: ${JSON.stringify(current)}`;
      if (Array.isArray(dayHours)) {
        const hours = dayHours.map((h, i) => `Day ${i + 1}: ${Number(h).toFixed(1)} hours`).join(", ");
        user +=
          `\nA router measured the actual driving time per day: ${hours}.` +
          `\nRevise the plan so no day is over ${maxH} hours and the driving is spread evenly. ` +
          // A fixed day count used to mean "accept long days", and Flash-Lite packed in roads until days ran 9+ hours.
          // Scenic but sensible: trim the extras before stretching a day.
          (requestedDays(prompt)
            ? `The traveler asked for exactly ${requestedDays(prompt)} days, so keep that many days. To shorten the long days, ` +
              "first move day boundaries and overnight towns, then drop or trim the extras on those days: a featured road " +
              "that's a detour, a side trip, a stop the request didn't name. Keep every place the request names. A day may " +
              "only stay long if the named places can't fit otherwise."
            : "Add days where needed. Add overnight towns along the way or move day boundaries.");
      }
      if (asArray(nightDays).length) {
        user += `\nThese days arrive after sunset and the traveler doesn't drive in the dark: day ${asArray(nightDays).join(", ")}. ` +
          "Shorten them (add an overnight or move the day boundary) so they finish in daylight.";
      }
      if (adds.length) {
        user +=
          "\nThe traveler picked these roads. Every one MUST be a featured road in the plan, and the route must drive it: " +
          "put vias ON the road near both ends and every 40 to 100 miles along it, and reorder or add days as needed:\n" +
          adds.map((r) => `- ${r.name}${r.ref ? ` (${r.ref})` : ""}${r.states ? `, ${[].concat(r.states).join("/")}` : ""}${r.why ? `: ${r.why}` : ""}`).join("\n");
      }
      if (removes.length) {
        user += `\nThe traveler doesn't want these roads. Remove them and their vias, and route another way: ${removes.join("; ")}.`;
      }
      if (feedback) user += `\nThe traveler asked for these changes: "${String(feedback).slice(0, 1000)}"`;
      user +=
        "\nKeep the parts that already work, using the exact same names for points and roads you keep. " +
        "Return the full revised plan in the same format.";
    }

    // A rebalance only moves day boundaries, so it skips the web search; a comment or road change gets a little.
    const planSearches = SEARCHES_PLAN;
    const searches = !revising ? planSearches : feedback || adds.length ? Math.min(2, planSearches) : 0;
    const region = !revising ? regionKey(stateList) : "";
    const { data, model, sources } = await callAI({ system, user, searches, schema: PLAN_SCHEMA, signal, region, onEvent: emit, model: evalModel });
    let plan = asPlan(data);

    // Check the plan against its own rules; send the problems back once, without searching again.
    const checkOpts = { prompt, loop: !!settings?.loop, feedback };
    let issues = checkPlan(plan, checkOpts);
    const found = issues.length;
    const firstIssues = issues;
    if (found) {
      console.log(`Plan check: ${found} problem(s): ${issues.join(" / ")}`);
      emit({ type: "status", text: `Fixing ${found} problem${found > 1 ? "s" : ""} in the plan` });
      emit({ type: "partial", data: null });
      try {
        const fixed = await callAI({
          system,
          user: `${user}\n\nYour plan was:\n${JSON.stringify(plan)}\n\nIt has these problems:\n` +
            issues.map((x) => `- ${x}`).join("\n") +
            "\nReturn the full corrected plan in the same format. Keep everything that was fine, with the same names.",
          searches: 0, schema: PLAN_SCHEMA, signal, onEvent: emit, model: evalModel,
        });
        const next = asPlan(fixed.data);
        const left = checkPlan(next, checkOpts);
        console.log(`Plan check after fixing: ${left.length} problem(s)${left.length ? `: ${left.join(" / ")}` : ""}`);
        if (left.length < issues.length) [plan, issues] = [next, left];
      } catch (e) {
        if (signal.aborted) throw e;
        console.log(`Plan fix failed, keeping the first plan: ${e.message}`);
      }
    }
    const checks = { found, left: issues.length, issues: firstIssues, leftIssues: found ? issues : [] };

    // Attach the official byway record to roads the AI picked from the catalog.
    const byName = new Map((await loadByways()).map((b) => [b.name.toLowerCase(), b]));
    for (const r of plan.roads) {
      const b = byName.get(String(r.byway || "").toLowerCase()) || byName.get(String(r.name || "").toLowerCase());
      if (b) r.official = bywayRecord(b);
    }
    // Models (especially small ones) still list plain interstates as "featured" despite the rules. Drop them,
    // unless it's an official byway or the traveler picked it.
    const picked = new Set(adds.map((r) => r.name.toLowerCase()));
    plan.roads = plan.roads.filter(
      // US interstates, Australian motorways ("M1", the Hume's "M31"), Ontario's 400-series freeways and Quebec autoroutes
      (r) =>
        r.official ||
        picked.has(String(r.name).toLowerCase()) ||
        !/^(I|Interstate)[ -]?\d|^M\d|^(ON )?4\d\d\b|^Highway 4\d\d\b|^(A-|Autoroute )\d/i.test(`${r.ref || ""}`.trim() || `${r.name || ""}`.trim())
    );
    // and anywhere in the world, roads named as motorways ("Tokai-Hokuriku Expressway", "Autostrada del Sole")
    plan.roads = plan.roads.filter((r) => r.official || picked.has(String(r.name).toLowerCase()) || !MOTORWAY_NAME.test(String(r.name || "")));
    finish(req, res, emit, { plan, model, sources, checks });
  } catch (e) {
    fail(res, emit, e);
  }
});

// Designated byways in the given states, for the road picker. GET /api/byways?states=New York,Vermont
app.get("/api/byways", async (req, res) => {
  const states = new Set(String(req.query.states || "").split(",").map(placeKey).filter(Boolean));
  const list = (await loadByways()).filter((b) => b.states.some((s) => states.has(placeKey(s))));
  res.json({ byways: list.map(bywayRecord).map((b, i) => ({ ...b, states: list[i].states })) });
});

// Driving roads the AI recommends for this trip's region that aren't designated byways (enthusiast roads like
// Hawk's Nest or Smugglers' Notch), found with web search where available.
app.post("/api/road-ideas", async (req, res) => {
  try {
    if (noAI()) return res.status(500).json({ error: NO_AI });
    const { prompt, states, have } = req.body || {};
    const user = `A traveler is planning this road trip: "${String(prompt || "").slice(0, 500)}"
States it passes through: ${asArray(states).join(", ")}.
Roads already in the plan: ${asArray(have).join("; ") || "none"}.

Suggest up to 8 more roads in or near those states that driving enthusiasts, motorcyclists and road trippers love and that
fit this trip: twisty mountain roads, passes, switchbacks, scenic parkways, famous drives. Not interstates, not roads already
in the plan. For each: the common name, route number, state, one line on why drivers love it, and about how long it is.${langText(req.body?.lang)}`;
    const { data, sources } = await callAI({
      system: PLANNER_INTRO,
      user,
      searches: Math.min(2, SEARCHES_PLAN),
      schema: obj({ roads: { type: "array", items: obj({ name: str, ref: str, state: str, why: str, miles: int }) } }),
    });
    res.json({ roads: asArray(data.roads).slice(0, 8), sources });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Points along a road, in order, so the app itself can make the route drive it (small models ignore "must use").
// POST { name, ref, states, near: [[lng, lat], ...] } -> { points: [{ name, lat, lng }], source }
// 1. OpenStreetMap via Nominatim: the road's pieces, searched by route number ("VT 108, Vermont", the most reliable)
//    and then by name. A long road is cut to the 120 km stretch nearest the trip (`near` = the trip's points).
// 2. Fallback: the AI names a start, middle and end place on the road, kept only near where the road is.
const STATE_ABBR = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA",
  kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI",
  minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH",
  "new jersey": "NJ", "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", ohio: "OH",
  oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI", "south carolina": "SC", "south dakota": "SD",
  tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV",
  wisconsin: "WI", wyoming: "WY",
  // Canadian provinces
  "british columbia": "BC", alberta: "AB", saskatchewan: "SK", manitoba: "MB", ontario: "ON", quebec: "QC",
  "new brunswick": "NB", "nova scotia": "NS", "prince edward island": "PE", "newfoundland and labrador": "NL",
};

// Words that don't tell one road from another: a road the AI made up ("Sahara Approach Highway") otherwise matches some
// unrelated highway nearby on these alone.
const ROAD_WORDS = new Set(["road", "highway", "route", "drive", "way", "street", "the", "and", "pass", "scenic", "coast",
  "coastal", "loop", "link", "trail", "byway", "parkway", "national", "state", "approach", "mountain", "valley", "old", "new"]);
const plainText = (t) => String(t).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
async function roadShape(q) {
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=40&polygon_geojson=1&polygon_threshold=0.001&q=${encodeURIComponent(q)}`;
  // the result must carry a distinctive word of the name, or the road number
  const head = plainText(q.split(",")[0]);
  const words = head.split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !ROAD_WORDS.has(w));
  const nums = head.match(/d+/g) || [];
  const pts = [];
  for (const x of asArray(await nominatimJson(u))) {
    if (x.class !== "highway") continue;
    const label = plainText(`${x.name || ""} ${x.display_name || ""}`);
    const labelWords = new Set(label.split(/[^a-z0-9]+/));
    if (words.length ? !words.some((w) => label.includes(w)) : nums.length && !nums.some((n) => labelWords.has(n))) continue;
    const g = x.geojson;
    if (g?.type === "LineString") pts.push(...g.coordinates);
    else if (g?.type === "MultiLineString") g.coordinates.forEach((l) => pts.push(...l));
  }
  return pts;
}
function farthestPair(pts) {
  let best = [0, -1, -1];
  for (let i = 0; i < pts.length; i++)
    for (let j = i + 1; j < pts.length; j++) {
      const d = haversine(pts[i], pts[j]);
      if (d > best[0]) best = [d, i, j];
    }
  return best;
}
// Start, middle and end of a set of road points, limited to the stretch nearest the trip for long roads.
function roadEnds(pts, near, name) {
  let use = pts;
  if (farthestPair(pts)[0] > 120000 && near?.length) {
    const dist = (p) => Math.min(...near.map((n) => haversine(p, n)));
    const center = pts.reduce((a, p) => (dist(p) < dist(a) ? p : a), pts[0]);
    use = pts.filter((p) => haversine(p, center) < 60000);
  }
  const [span, i, j] = farthestPair(use);
  if (span < 3000) return null;
  const a = use[i];
  const b = use[j];
  const midTarget = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const mid = use.reduce((m, p) => (haversine(p, midTarget) < haversine(m, midTarget) ? p : m), use[0]);
  const pt = (p, label) => ({ name: `${name} (${label})`, lng: p[0], lat: p[1] });
  const ends = [pt(a, "one end"), pt(mid, "middle"), pt(b, "other end")];
  // the road's shape near the trip, so the app can tell whether the route really drives it (routers often have no name
  // for park roads like Skyline Drive): at most ~400 points, rounded to ~10 m
  const keep = Math.max(1, Math.ceil(use.length / 400));
  ends.shape = use.filter((_, k) => k % keep === 0).map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
  return ends;
}

app.post("/api/road-points", async (req, res) => {
  try {
    const { name, ref, near, osm } = req.body || {};
    if (!name) return res.status(400).json({ error: "Which road?" });
    const states = [].concat(req.body.states || []).flatMap((s) => String(s).split(/[\/,]/)).map((s) => s.trim()).filter(Boolean);
    const nearPts = asArray(near).filter((p) => Array.isArray(p) && p.length === 2);

    // 1. Map data, by route number and by name; keep whichever covers more of the road
    //    (OpenStreetMap has B100 in a few pieces but "Great Ocean Road" in many).
    const queries = [];
    // the road's own OpenStreetMap name, when the catalog knows it ("Furkastrasse")
    if (osm) queries.push(`${osm}${states.at(-1) ? `, ${states.at(-1)}` : ""}`);
    const nz = states.some((s) => /new zealand/i.test(s));
    for (const m of String(ref || "").matchAll(/\b([MABCDLN])(\d{1,4})\b|\b(I|US|[A-Z]{2})[ -]?(\d+)\b/gi)) {
      if (m[1]) {
        queries.push(`${m[1].toUpperCase()}${m[2]}${states[0] ? `, ${states[0]}` : ""}`); // "B100, Victoria", "A82, Scotland"
        break;
      }
      const kind = m[3].toUpperCase();
      if (kind === "I") continue; // interstates are never the scenic road we're after
      if (kind === "SH" && nz) {
        queries.push(`State Highway ${m[4]}, New Zealand`);
        break;
      }
      if (kind === "CH") break; // Swiss main roads are found by name
      const st = kind === "US" ? states[0] : states.find((s) => STATE_ABBR[s.toLowerCase()] === kind) || states[0];
      // OpenStreetMap knows Canadian highways as "Highway 99, British Columbia" and "Route 132, Quebec", not "BC 99"
      const CA = ["BC", "AB", "SK", "MB", "ON", "QC", "NB", "NS", "PE", "NL"];
      if (CA.includes(kind)) queries.push(`${kind === "QC" ? "Route" : "Highway"} ${m[4]}${st ? `, ${st}` : ""}`);
      else queries.push(`${kind} ${m[4]}${st ? `, ${st}` : ""}`);
      break;
    }
    // by name in each of the trip's states (up to 4): "Skyline Drive" exists in a dozen states
    for (const st of states.length ? states.slice(0, 4) : [""]) queries.push(`${name}${st ? `, ${st}` : ""}`);
    // the match nearest where the trip expects the road (there's a Skyline Drive in Virginia and another near
    // Asheville); between matches about as near, the longer one. Over 60 km away isn't it.
    const offTrip = (ends) => (nearPts.length ? Math.min(...ends.map((p) => Math.min(...nearPts.map((n) => haversine(n, [p.lng, p.lat]))))) : 0);
    let best = null;
    for (const q of [...new Set(queries)]) {
      const ends = roadEnds(await roadShape(q), nearPts, name);
      if (!ends) continue;
      const off = offTrip(ends);
      if (off > 60000) continue;
      const span = haversine([ends[0].lng, ends[0].lat], [ends[2].lng, ends[2].lat]);
      if (!best || off < best.off - 5000 || (off < best.off + 5000 && span > best.span)) best = { ends, span, off, q };
    }
    if (best) return res.json({ points: best.ends, shape: best.ends.shape, source: `map: ${best.q}` });

    // 2. The AI's places, kept only within 80 km of where the map puts the road (or of each other)
    if (noAI()) return res.json({ points: [] });
    const anchor = await geocodeServer(`${name}${states[0] ? `, ${states[0]}` : ""}`);
    const { data } = await callAI({
      system: "You know US, Canadian and Australian roads and geography precisely.",
      user:
        `List 3 places that sit directly ON ${name}${ref ? ` (${ref})` : ""}${states.length ? ` in ${states.join(", ")}` : ""}, ` +
        "in driving order: near its start, near its middle, near its end. Use towns, villages, passes, summits or landmarks " +
        'with their state, named so a map search finds them, like "Kancamagus Pass, New Hampshire".',
      schema: obj({ points: { type: "array", items: obj({ name: str }) } }),
    });
    let points = [];
    for (const p of asArray(data.points).slice(0, 4)) {
      const g = await geocodeServer(String(p.name));
      if (g) points.push({ name: String(p.name), ...g });
    }
    points = anchor
      ? points.filter((p) => haversine([p.lng, p.lat], [anchor.lng, anchor.lat]) < 80000)
      : points.filter((p) => points.some((q) => q !== p && haversine([p.lng, p.lat], [q.lng, q.lat]) < 150000));
    if (anchor && points.length < 2) points = [{ name, ...anchor }];
    res.json({ points, source: "ai" });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// Step 2: the details for a planned route. Day write-ups, what each featured road is like, and spots to stop at.
app.post("/api/details", async (req, res) => {
  let emit = () => {}; // set once the answer starts streaming; the catch needs it too
  try {
    if (noAI()) return res.status(500).json({ error: NO_AI });
    const { plan, settings, states } = req.body;
    const prompt = String(req.body.prompt || "").slice(0, 2000);
    if (!plan?.points?.length) return res.status(400).json({ error: "Plan the route first." });
    const signal = clientGone(res);
    emit = eventStream(req, res);

    const route = {
      days: asArray(plan.days).map((d) => ({ day: d.day, title: d.title, overnight: d.overnight })),
      points: asArray(plan.points).map((p) => ({ name: p.name, kind: p.kind, day: p.day, road: p.road })),
      roads: asArray(plan.roads).map((r) => ({
        name: r.name, ref: r.ref, days: r.days, segment: r.segment,
        official: r.official ? `${r.official.type}: ${r.official.description}` : "",
      })),
    };
    const user = `This road trip route is already planned:
${JSON.stringify(route)}

Write the details. Return one JSON object:
{
  "days": [{"day": 1, "summary": 2 to 3 sentences on that day's drive: the landscape, the best stretch, and the feel of the day,
            "stay": one sentence on where to stay that night: the best part of town or a nearby alternative, and what kind
            of places (motels, lodges, B&Bs, campgrounds), without naming specific hotels (they change and are easy to get
            wrong), "price": typical lodging price there, "$" (cheap) to "$$$$" (expensive)}],
  "roads": [{"name": exactly as in the route, "why": what makes it special as drivers describe it (views, curves, elevation,
             history), "drive": what driving it is like (grades, switchbacks, exposure, traffic, best direction),
             "tips": timing, season, closures, fuel, "wiki": exact English Wikipedia article title or ""}],
  "spots": [{"name": specific place, "type": "viewpoint" | "hike" | "food" | "landmark" | "park" | "town" | "photo" |
             "waterfall" | "hot_spring", "day": day number, "road": road it's on or "", "why": 1 to 2 sentences,
             "minutes": suggested stop length, "wiki": exact English Wikipedia article title or ""}]
}

Rules:
- A summary and a stay for every day, and details for every road in the route. Be concrete and specific, like an
  experienced local driver giving advice, not a brochure. The last day's stay is about the destination.
- spots: 3 to 5 for every day, in driving order within the day, along that day's route or at its stops: viewpoints and
  pullouts, short hikes, waterfalls, hot springs, roadside attractions, classic diners or local food, photo spots. Mix the
  types. Real places only, named so they can be found on a map ("Tunnel View, Yosemite", "Oxbow Bend, Grand Teton").
- Only give a wiki title when you are confident the English Wikipedia article exists.
${await settingsText(settings, states)}

The traveler's request: ${prompt || ""}${langText(req.body.lang)}`;

    const { data: d, model, sources } = await callAI({
      system: PLANNER_INTRO,
      user,
      searches: SEARCHES_DETAILS,
      schema: DETAILS_SCHEMA,
      signal,
      region: asArray(states).length ? `details:${regionKey(states)}` : "",
      onEvent: emit,
      writing: "Writing the day guides",
    });
    finish(req, res, emit, { details: { days: asArray(d.days), roads: asArray(d.roads), spots: asArray(d.spots) }, model, sources });
  } catch (e) {
    fail(res, emit, e);
  }
});

// ---------- setup: keys and the local AI, from the app instead of editing files ----------
//
// GET /api/setup shows what's set up (keys masked, never sent back), POST /api/setup checks each new key with its
// service and writes it to .env.
// Only from this PC: a phone opening a share link on the same Wi-Fi can't see or change any of it.

const isLocalRequest = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
const localOnly = (req, res, next) => (isLocalRequest(req) ? next() : res.status(403).json({ error: "Setup only works on the PC running the app." }));
const ENV_FILE = path.resolve(".env");

// Pick up changed keys without a restart.
function applyConfig() {
  ORS_KEY = (process.env.ORS_API_KEY || "").trim();
  GEMINI_KEY = (process.env.GEMINI_API_KEY || "").trim();
  TAVILY_KEY = (process.env.TAVILY_API_KEY || "").trim();
  CONTACT = (process.env.CONTACT || "").trim();
  UA = userAgent();
  AI_PROVIDER = pickProvider(process.env.AI_PROVIDER);
}
// Set lines in .env (creating it if needed), keeping every other line and comment as it is.
async function writeEnv(values) {
  let text = "";
  try {
    text = await fs.readFile(ENV_FILE, "utf8");
  } catch {
    text = "# Settings for Byway. The Setup screen in the app (the gear button) writes these.\n";
  }
  for (const [k, v] of Object.entries(values)) {
    const clean = String(v ?? "").replace(/[\r\n]/g, "").trim();
    const line = `${k}=${clean}`;
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\n?$/, "\n")}${line}\n`;
    process.env[k] = clean;
  }
  await fs.writeFile(ENV_FILE, text);
  applyConfig();
}
const mask = (k) => (k ? `${k.slice(0, 4)}…${k.slice(-4)}` : "");

app.get("/api/setup", localOnly, async (req, res) => {
  res.json({
    ors: { set: !!ORS_KEY, hint: mask(ORS_KEY) },
    tavily: { set: !!TAVILY_KEY, hint: mask(TAVILY_KEY) },
    gemini: { set: !!GEMINI_KEY, hint: mask(GEMINI_KEY), model: GEMINI_MODEL, today: GEMINI_KEY ? await geminiUsageToday() : null },
    contact: CONTACT,
    provider: AI_PROVIDER,
    node: process.version,
    platform: process.platform,
    // ready to plan with AI; routes work without an ORS key (the backup router), so it isn't required
    ready: AI_PROVIDER === "gemini" ? !!GEMINI_KEY : !!anthropic || !!GEMINI_KEY,
  });
});

// POST { ors?, tavily?, gemini?, contact?, provider? }: each key is tried with its service before it's saved.
app.post("/api/setup", localOnly, async (req, res) => {
  const b = req.body || {};
  const save = {};
  const problems = {};
  try {
    if (b.ors != null && b.ors.trim()) {
      const k = b.ors.trim();
      const r = await fetch(`https://api.heigit.org/openrouteservice/v2/directions/driving-car?api_key=${encodeURIComponent(k)}&start=-122.42,37.77&end=-122.41,37.78`,
        { signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (r?.ok) save.ORS_API_KEY = k;
      else problems.ors = r ? `OpenRouteService didn't accept that key (${r.status}).` : "Couldn't reach OpenRouteService.";
    }
    if (b.tavily != null && b.tavily.trim()) {
      const k = b.tavily.trim();
      // a one-result search (uses 1 of the month's free searches)
      const r = await fetch("https://api.tavily.com/search", {
        method: "POST", headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "scenic drives", max_results: 1 }), signal: AbortSignal.timeout(20000),
      }).catch(() => null);
      if (r?.ok) save.TAVILY_API_KEY = k;
      else problems.tavily = r ? `Tavily didn't accept that key (${r.status}).` : "Couldn't reach Tavily.";
    }
    if (b.gemini != null && b.gemini.trim()) {
      const k = b.gemini.trim();
      const r = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", { headers: { "x-goog-api-key": k }, signal: AbortSignal.timeout(15000) }).catch(() => null);
      if (r?.ok) save.GEMINI_API_KEY = k;
      else problems.gemini = r ? `Google didn't accept that key (${r.status}).` : "Couldn't reach Google.";
    }
    if (b.contact != null) {
      const c = b.contact.trim();
      if (!c || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c) || /^https?:\/\/\S+$/.test(c)) save.CONTACT = c;
      else problems.contact = "Use an email address or a web address starting with http.";
    }
    if (b.provider === "gemini") save.AI_PROVIDER = b.provider;
    if (Object.keys(save).length) await writeEnv(save);
    res.json({ saved: Object.keys(save), problems });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

const port = process.env.PORT || 3000;
const url = `http://localhost:${port}`;
// start.cmd / start.sh pass --open to open the app in the browser
function openBrowser() {
  if (!process.argv.includes("--open")) return;
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
// The tests import this file for its plan checks without starting the app (BYWAY_TEST=1).
export { checkPlan, requestedDays, partialJson, samePlace, osrmResult, routePieces, encodeLine, decodeLine, packRoutes, unpackRoutes };
if (!process.env.BYWAY_TEST) app.listen(port, () => {
  console.log(`Running on ${url}`);
  openBrowser();
}).on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  // already running (started twice): just show it
  console.log(`Byway is already running on ${url}`);
  openBrowser();
  setTimeout(() => process.exit(0), 500);
});
