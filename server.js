import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile, spawn } from "node:child_process";
import { Agent, fetch as undiciFetch } from "undici";

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(express.static("public"));

// Keys and choices that the in-app setup can change while the server runs (see "setup" below): reloaded from
// process.env by applyConfig().
let ORS_KEY = process.env.ORS_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
let GEMINI_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-latest";
// Tried in order when the main model is busy. Comma separated in .env to override.
const GEMINI_FALLBACKS = (process.env.GEMINI_FALLBACK_MODELS || "gemini-3.6-flash,gemini-3.7-flash,gemini-3.5-flash,gemini-3.5-flash-lite")
  .split(",")
  .map((s) => s.trim());
const GH_URL = (process.env.GRAPHHOPPER_URL || "http://localhost:8989").replace(/\/$/, "");
// GraphHopper is optional and off unless USE_GRAPHHOPPER=1 in .env. Everything works with ORS alone.
const USE_GH = /^(1|true|yes)$/i.test(process.env.USE_GRAPHHOPPER || "");
// Wikimedia and Nominatim ask automated clients for a User-Agent with contact details (an email or a URL).
// Without CONTACT in .env, Wikimedia throttles photo lookups hard ("You are making too many requests").
let CONTACT = (process.env.CONTACT || "").trim();
const userAgent = () =>
  process.env.USER_AGENT || `RoadtripPlanner/1.13 (personal non-commercial trip planner${CONTACT ? `; ${CONTACT}` : ""})`;
let UA = userAgent();
if (!CONTACT && !process.env.USER_AGENT) {
  console.log("Tip: add your email or a website in Setup (the gear button) so Wikipedia doesn't throttle photo lookups.");
}

// ---------- a small JSON cache on disk ----------

// { key: { at, value } } in data/<file>. Entries older than maxDays are ignored and dropped on the next write.
function diskCache(file, maxDays, maxEntries = 2000) {
  const full = path.resolve("data", file);
  let map = null;
  let timer = null;
  const fresh = (e) => e && Date.now() - e.at < maxDays * 86400000;
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
    async set(k, value) {
      (await load()).delete(k);
      map.set(k, { at: Date.now(), value });
      clearTimeout(timer);
      timer = setTimeout(() => {
        const keep = Object.fromEntries([...map].filter(([, e]) => fresh(e)).slice(-maxEntries));
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

// ---------- GraphHopper (self-hosted, real scenic rules) ----------

async function routeGraphHopper(coords, mode) {
  let r;
  try {
    r = await fetch(`${GH_URL}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: coords,
        profile: mode === "scenic" ? "scenic" : "car",
        // scenic only has an LM preparation, so CH must be turned off for it
        ...(mode === "scenic" && { "ch.disable": true }),
        points_encoded: false,
        instructions: false,
        calc_points: true,
        details: ["time"],
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch {
    throw new RouteError("GraphHopper is not running", { fallback: true });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data.message || "GraphHopper routing failed";
    const m = msg.match(/Cannot find point (\d+)/i);
    if (m) {
      // Outside the downloaded map region, or far from a road
      throw new RouteError(msg, { pointIndex: parseInt(m[1], 10), fallback: true });
    }
    throw new RouteError(msg, { fallback: true });
  }

  const p = data.paths[0];
  const coordsOut = p.points.coordinates.map((c) => [c[0], c[1]]);
  const snappedWps = p.snapped_waypoints?.coordinates || coords;
  const wp = waypointIndexes(coordsOut, snappedWps);
  const timeDetails = p.details?.time || [];
  const timeAt = timeDetails.length
    ? (a, b) => {
        let ms = 0;
        for (const [from, to, v] of timeDetails) {
          const lo = Math.max(from, a);
          const hi = Math.min(to, b);
          if (hi > lo) ms += v * ((hi - lo) / (to - from));
        }
        return ms / 1000;
      }
    : null;

  // Leg distances are measured along the line; scale them so they add up to GraphHopper's total.
  const legs = legsFromIndexes(coordsOut, wp, p.distance, p.time / 1000, timeAt);
  const sum = legs.reduce((s, l) => s + l.distance_m, 0);
  if (sum > 0) legs.forEach((l) => (l.distance_m *= p.distance / sum));

  return {
    engine: "graphhopper",
    geometry: { type: "LineString", coordinates: coordsOut },
    distance_m: p.distance,
    duration_s: p.time / 1000,
    legs,
  };
}

// ---------- road breakdown from ORS turn-by-turn steps ----------

// ORS step names look like "Lincoln Highway, US 50" or "Carson City Freeway, I 580, US 50".
// US refs ("US 50", "CO 82"), and letter-number routes: Australia and the UK ("B100", "M1", "A82"), Austria and
// Germany ("B107", "L188"), France ("D902", "N85"). Italy's "SS38" fits the two-letter form.
const REF_RE = /^(I|US|SR|SH|CR|FR|NFR|FM|RM|BIA|[A-Z]{2}|[MABCDLN](?=\d))[ -]?\d+[A-Z]?( (Business|Bus|Alt|Spur|Truck|Bypass|Loop|Scenic))?$/i;
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
async function routeOrs(coords, mode) {
  if (!ORS_KEY) throw new RouteError("No routing engine available. Add ORS_API_KEY to .env.");
  const body = {
    coordinates: coords,
    instructions: true,
    // elevation: coordinates come back as [lng, lat, meters] (SRTM), for the elevation profile and road ratings
    elevation: true,
    extra_info: ["waycategory", "surface"],
    radiuses: coords.map(() => -1),
    preference: mode === "scenic" ? "recommended" : "fastest",
  };
  const r = await fetch("https://api.openrouteservice.org/v2/directions/driving-car/geojson", {
    method: "POST",
    headers: { Authorization: ORS_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90000),
  });
  const data = await r.json();
  if (!r.ok) {
    const msg = typeof data?.error === "string" ? data.error : data?.error?.message || "Routing failed";
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

// Route between stops. coordinates: [[lng, lat], ...], mode: "scenic" | "fastest".
// Uses GraphHopper when it is running, otherwise OpenRouteService.
// GraphHopper's /info tells us whether it is running and which area its map covers.
let ghInfo = { at: 0, value: null };
async function getGhInfo() {
  if (!USE_GH) return null;
  if (Date.now() - ghInfo.at < 30000) return ghInfo.value;
  let value = null;
  try {
    const r = await fetch(`${GH_URL}/info`, { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const info = await r.json();
      const profiles = (info.profiles || []).map((p) => p.name);
      value = { bbox: info.bbox || null, scenic: profiles.includes("scenic") };
    }
  } catch {
    // not running
  }
  ghInfo = { at: Date.now(), value };
  return value;
}
const inBbox = (bbox, [lng, lat]) =>
  !bbox || (lng >= bbox[0] && lat >= bbox[1] && lng <= bbox[2] && lat <= bbox[3]);

// Route between stops. coordinates: [[lng, lat], ...], mode: "scenic" | "fastest".
// Uses GraphHopper when it is running and its map covers every stop,
// otherwise OpenRouteService.
app.post("/api/route", async (req, res) => {
  const { coordinates, mode } = req.body;
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    return res.status(400).json({ error: "Add at least two stops to find routes." });
  }

  const gh = await getGhInfo();
  let note = null;
  if (gh?.scenic && coordinates.every((c) => inBbox(gh.bbox, c))) {
    try {
      return res.json(await withSnapping(coordinates, (c) => routeGraphHopper(c, mode)));
    } catch (e) {
      if (!ORS_KEY) return res.status(422).json({ error: e.message });
      note = `GraphHopper could not route this trip (${e.message}), so basic routing was used.`;
    }
  } else if (gh?.scenic) {
    note = "Some stops are outside your GraphHopper map, so basic routing was used.";
  }

  if (!ORS_KEY) {
    return res.status(422).json({
      error: "No routing engine available. Start GraphHopper or add ORS_API_KEY to .env.",
    });
  }
  try {
    const result = await withSnapping(coordinates, (c) => routeOrs(c, mode));
    if (note) result.note = note;
    res.json(result);
  } catch (e) {
    res.status(422).json({ error: e.message });
  }
});

// Which routing engine is available, for the status line in the app.
app.get("/api/status", async (req, res) => {
  const gh = await getGhInfo();
  res.json({
    graphhopper: !!gh?.scenic, bbox: gh?.bbox || null, ors: !!ORS_KEY, useGraphhopper: USE_GH,
    ai: AI_PROVIDER === "local"
      ? { provider: "local", model: LOCAL_MODEL, webSearch: LOCAL_SEARCHES_PLAN + LOCAL_SEARCHES_DETAILS > 0, ...(await localStatus()) }
      : AI_PROVIDER === "claude" && anthropic
        ? { provider: "claude", model: CLAUDE_MODEL, webSearch: SEARCHES_PLAN + SEARCHES_DETAILS > 0 }
        : { provider: "gemini", model: GEMINI_MODEL, webSearch: false },
  });
});

// ---------- saved trips (stored in data/trips.json) ----------

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

// A short summary of a trip for lists (the trips sheet and the ready-made trips gallery).
function tripSummary(t) {
  const sc = t.routes?.scenic;
  const days = new Set((t.stops || []).map((s) => s.day)).size;
  return {
    id: t.id, name: t.name, stopCount: t.stops?.length || 0, updatedAt: t.updatedAt, preset: !!t.preset,
    prompt: t.prompt || "", days, distance_m: sc?.distance_m || null, duration_s: sc?.duration_s || null,
    summary: t.plan?.summary || "", styles: t.settings?.styles || [], loop: !!t.settings?.loop,
    image: (t.plan?.roads || []).find((r) => r.info?.image)?.info.image || (t.plan?.spots || []).find((s) => s.info?.image)?.info.image || "",
    start: t.stops?.[0] ? { lng: t.stops[0].lng, lat: t.stops[0].lat, name: t.stops[0].name } : null,
  };
}

app.get("/api/trips", async (req, res) => {
  try {
    const trips = await readTrips();
    // ready-made trips (built in batch, see "presets") are listed separately
    const list = Object.values(trips)
      .filter((t) => !t.preset)
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
      shippedPresets = JSON.parse(await fs.readFile(path.join(DATA_DIR, "presets.json"), "utf8"));
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
      if (!t) return null;
      const now = new Date().toISOString();
      const name = String(req.body?.name || (t.preset ? t.name : `${t.name} (copy)`)).slice(0, 120);
      trips[id] = { ...structuredClone(t), id, name, preset: false, createdAt: now, updatedAt: now, versions: [] };
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
  const trip = trips[req.params.id] || (await shipped())[req.params.id];
  if (!trip) return res.status(404).json({ error: "That trip no longer exists." });
  res.json(trip);
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
        preset: !!preset,
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
        routes: routes && typeof routes === "object" ? routes : null,
        // AI plan with its days, featured roads and spots (plus their Wikipedia details)
        plan: plan && typeof plan === "object" && !Array.isArray(plan) ? plan : null,
        createdAt: trips[id]?.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      return trips[id];
    });
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
      delete trips[req.params.id];
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ---------- photos (Wikimedia Commons, free, no key) ----------

const photoCache = new Map();
const NOT_A_PHOTO = /\b(map|logo|flag|seal|diagram|locator|coat of arms|icon|sign|plaque)\b/i;
async function commonsPhotos(q, width = 640) {
  const key = `${width}:${q}`;
  if (photoCache.has(key)) return photoCache.get(key);
  try {
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    url.search = new URLSearchParams({
      action: "query",
      format: "json",
      generator: "search",
      gsrsearch: `${q.replace(/,/g, " ")} filetype:bitmap`,
      gsrnamespace: "6",
      gsrlimit: "20",
      prop: "imageinfo",
      iiprop: "url|mime|size",
      iiurlwidth: String(width),
    });
    const data = await wmFetch(url);
    const pages = Object.values(data?.query?.pages || {}).sort((a, b) => a.index - b.index);
    const photos = pages
      // the file name must mention the place, so a loose search match doesn't bring in an unrelated photo
      .filter((p) => !NOT_A_PHOTO.test(p.title || "") && (!words(q).length || sharesWord(q, p.title)))
      .map((p) => p.imageinfo?.[0])
      .filter((i) => i && i.mime === "image/jpeg" && i.width >= 800 && i.width >= i.height && i.thumburl)
      .slice(0, 4)
      .map((i) => i.thumburl);
    if (data) photoCache.set(key, photos); // nothing cached while Wikimedia is throttling
    return photos;
  } catch {
    return [];
  }
}
app.get("/api/photos", async (req, res) => {
  const q = String(req.query.q || "").trim();
  res.json({ photos: q ? await commonsPhotos(q) : [] });
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
  try {
    const url = new URL("https://commons.wikimedia.org/w/api.php");
    url.search = new URLSearchParams({
      action: "query", format: "json", generator: "search", gsrsearch: `${q.replace(/,/g, " ")} filetype:bitmap`,
      gsrnamespace: "6", gsrlimit: "30", prop: "imageinfo", iiprop: "url|mime|size", iiurlwidth: "1280",
    });
    const data = await wmFetch(url);
    const pages = Object.values(data?.query?.pages || {}).sort((a, b) => a.index - b.index);
    const photos = pages
      .filter((p) => !NOT_A_PHOTO.test(p.title || "") && (!words(q).length || sharesWord(q, p.title)))
      .map((p) => ({ i: p.imageinfo?.[0], title: String(p.title || "").replace(/^File:/, "").replace(/\.[a-z]+$/i, "") }))
      .filter(({ i }) => i && i.mime === "image/jpeg" && i.width >= 800 && i.thumburl)
      .slice(0, 8)
      .map(({ i, title }) => ({ src: i.thumburl, page: i.descriptionurl, title }));
    res.json({ photos });
  } catch {
    res.json({ photos: [] });
  }
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
//   -> { pois: [{ k, lng, lat, name }], lodging: { hotel, motel, guest, camp } }
// k: fuel | ev | evfast | view | falls | spring | diner. Overpass is free and public, so one query per day, cached 14 days.
const alongCache = diskCache("along-cache.json", 14, 500);
// (other public instances, like overpass.kumi.systems, timed out on every test in October 2026)
const OVERPASS = ["https://overpass-api.de/api/interpreter"];
// Busy public servers turn away big queries ("Dispatcher_Client::request_read_and_idx::timeout"), so every query
// declares a short timeout and a small memory budget, covers only a few boxes, and is retried after a pause.
async function overpass(body) {
  const query = `[out:json][timeout:25][maxsize:67108864];${body}`;
  let last = null;
  for (const [i, url] of [OVERPASS[0], OVERPASS[0], OVERPASS[0]].entries()) {
    // the public server allows a few queries at a time per address and refuses the rest, so wait it out
    if (i) await new Promise((ok) => setTimeout(ok, 8000 * i));
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) {
        const d = await r.json();
        // a query that ran out of time or memory still answers 200, with the error in "remark"
        if (/error/i.test(d.remark || "")) throw new Error(d.remark);
        return d;
      }
      last = new Error(`Overpass ${r.status}`);
    } catch (e) {
      last = e;
      console.log(`Overpass: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`);
      // can't even connect: the server is down, so don't wait through the retries
      if (/CONNECT_TIMEOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(e.cause?.code || "")) {
        const down = new Error("OpenStreetMap's search server is unreachable right now");
        down.down = true;
        throw down;
      }
    }
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

  // Small boxes along the line (a few per query), then keep what's within reach of the route.
  const boxes = lineBoxes(line);
  const parts = (b) => {
    const bb = b.join(",");
    // (searching restaurant names for "diner" ran the public server out of memory, so only places tagged as diners)
    return `nwr["amenity"~"^(fuel|charging_station)$"](${bb});node["tourism"="viewpoint"]["name"](${bb});` +
      `nwr["waterway"="waterfall"]["name"](${bb});nwr["natural"="hot_spring"](${bb});nwr["cuisine"~"diner"](${bb});`;
  };
  try {
    const elements = [];
    // a piece that still fails after the retries is skipped, and the answer says it's partial
    let failed = 0;
    let tried = 0;
    let lastError = null;
    for (let i = 0; i < boxes.length; i += 3) {
      tried++;
      if (i) await new Promise((ok) => setTimeout(ok, 1500));
      try {
        const d = await overpass(`(${boxes.slice(i, i + 3).map(parts).join("")});out center tags;`);
        elements.push(...(d.elements || []));
      } catch (e) {
        failed++;
        lastError = e;
        if (e.down) {
          failed = tried;
          break;
        }
      }
    }
    if (night) {
      const dy = 8 / 110.5;
      const dx = 8 / (111.3 * Math.cos((night[1] * Math.PI) / 180));
      const bb = [night[1] - dy, night[0] - dx, night[1] + dy, night[0] + dx].map((v) => v.toFixed(4)).join(",");
      try {
        const d = await overpass(`(nwr["tourism"~"^(hotel|motel|guest_house|hostel|camp_site|caravan_site|chalet)$"](${bb}););out center tags;`);
        for (const el of d.elements || []) elements.push({ ...el, lodging: true });
      } catch {
        // lodging counts are a nice extra
      }
    }
    if (failed === tried) throw lastError || new Error("no answer");
    const pois = [];
    const lodging = { hotel: 0, motel: 0, guest: 0, camp: 0 };
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
        const k = t.tourism === "motel" ? "motel" : /camp|caravan/.test(t.tourism) ? "camp" : /hotel/.test(t.tourism) ? "hotel" : "guest";
        lodging[k]++;
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
    const out = { pois, lodging: night ? lodging : null, partial: failed > 0 };
    console.log(`Along: ${boxes.length} boxes, ${elements.length} found, ${pois.length} near the route${failed ? `, ${failed} of ${tried} pieces failed` : ""}`);
    if (!failed) alongCache.set(key, out);
    res.json(out);
  } catch (e) {
    res.status(502).json({
      error: e.down ? `${e.message}. Try again later.` : `OpenStreetMap search is busy (${e.message}). Try again in a minute.`,
    });
  }
});

// The PC's addresses on the local network, for share links a phone on the same Wi-Fi can open.
app.get("/api/lan", async (req, res) => {
  const { networkInterfaces } = await import("node:os");
  const ips = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && n.family === "IPv4" && !n.internal && !/^169\.254\./.test(n.address))
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
try {
  for (const [k, v] of Object.entries(JSON.parse(await fs.readFile(WM_CACHE_FILE, "utf8")))) wmCache.set(k, v);
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
        const d = await r.json();
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
const COUNTRY_CODES = "us,ca,au,nz,gb,ch,at,li,it,fr,de";
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
async function geocodeServer(q) {
  if (geoCache.has(q)) return geoCache.get(q);
  const d = await nominatimJson(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=${COUNTRY_CODES}&q=${encodeURIComponent(q)}`);
  if (!d) return null;
  const hit = d[0] ? { lat: parseFloat(d[0].lat), lng: parseFloat(d[0].lon) } : null;
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
      const p = await wikiSearch(s.name, fitsNear(s.near));
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
      if (!w.image) w.image = (await commonsPhotos(s.name, 1280))[0] || "";
    }
    for (const r of roads) {
      const w = (out.roads[r.key] ||= {});
      if (!w.image) w.image = (await commonsPhotos(r.photo || r.name, 1280))[0] || "";
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
// Default since 1.8: a local model in LM Studio (free, runs on the PC's GPU) with Tavily web search.
let AI_PROVIDER = (process.env.AI_PROVIDER || "local").toLowerCase();
const LOCAL_URL = (process.env.LOCAL_AI_URL || "http://localhost:1234/v1").replace(/\/$/, "");
const LOCAL_MODEL = process.env.LOCAL_MODEL || "qwen/qwen3.5-9b";
// How long one answer from the local model may take. A laptop GPU (an M3 MacBook) writes several times slower than a
// desktop card, and the longest answer (the day guides) can take many minutes there.
const LOCAL_TIMEOUT = Number(process.env.LOCAL_TIMEOUT_S || (process.platform === "darwin" ? 900 : 290)) * 1000;
const LOCAL_SEARCHES_PLAN = Number(process.env.LOCAL_SEARCHES_PLAN ?? 4);
const LOCAL_SEARCHES_DETAILS = Number(process.env.LOCAL_SEARCHES_DETAILS ?? 6);
// Qwen3.5 thinks for thousands of tokens per research turn. Fine on a desktop GPU, but an M3 writes ~17 tokens/s,
// so one turn could think for 6 minutes. On a Mac it thinks only when LM Studio runs the model on another computer
// over LM Link (his PC: Denver to Moab in 30 s with thinking). LOCAL_THINK=1 or 0 forces it.
let thinkCache = { at: 0, value: true };
async function localThink() {
  if (process.env.LOCAL_THINK != null) return process.env.LOCAL_THINK !== "0";
  if (process.platform !== "darwin") return true;
  if (Date.now() - thinkCache.at < 60000) return thinkCache.value;
  const remote = await new Promise((resolve) =>
    execFile(LMS, ["ps", "--json"], { timeout: 10000 }, (err, out) => {
      try {
        const m = JSON.parse(out).find((x) => x.identifier === LOCAL_MODEL || x.modelKey === LOCAL_MODEL);
        resolve(!!m?.deviceIdentifier);
      } catch {
        resolve(false);
      }
    })
  );
  thinkCache = { at: Date.now(), value: remote };
  return remote;
}
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-haiku-5-5";
const CLAUDE_EFFORT = process.env.CLAUDE_EFFORT || "medium"; // low | medium | high
// Web searches allowed per call ($10 per 1,000 searches). 0 turns search off.
const SEARCHES_PLAN = Number(process.env.CLAUDE_SEARCHES_PLAN ?? 4);
const SEARCHES_DETAILS = Number(process.env.CLAUDE_SEARCHES_DETAILS ?? 5);

// Free-tier Gemini models are often overloaded (503), rate limited (429) or drop long answers part way,
// and non-streamed requests get cut off around 60 s. So: stream the answer, and move to the next model on any failure.
const GEMINI_MODELS = [GEMINI_MODEL, ...GEMINI_FALLBACKS].filter((m, i, a) => m && a.indexOf(m) === i);
async function callGemini(prompt) {
  const errors = [];
  for (const model of GEMINI_MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_KEY },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
        signal: AbortSignal.timeout(240000), // a stalled stream moves on to the next model
      });
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
        }
      }
      JSON.parse(text); // a cut-off answer fails here and moves on to the next model
      return { text, model: version };
    } catch (e) {
      errors.push(`${model}: ${e.message}`);
      console.log(`Gemini ${model} failed: ${e.message}`);
    }
  }
  throw new Error(`The AI is busy right now, please try again in a minute. (${errors.join("; ")})`);
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
// signal: stop when the app stops waiting (local model only). region: a key for reusing research notes.
async function callAI({ system, user, searches = 0, schema, signal, region, onEvent }) {
  // Local model: no fallback, so a stopped LM Studio shows its own clear error instead of a Gemini quota message.
  if (AI_PROVIDER === "local") return callLocal({ system, user, searches, schema, signal, region, onEvent });
  if (AI_PROVIDER === "claude" && anthropic) {
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
  const { text, model } = await callGemini(`${system}\n\n${user}\n\nReturn JSON only.`);
  return { data: JSON.parse(text), model, sources: [] };
}

// ---------- local model (LM Studio) with web search ----------

const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const htmlText = (s) =>
  String(s)
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&[a-z]+;/gi, " ") // any other named entity (&nbsp;, &middot;...)
    .replace(/\s+/g, " ").trim();

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
const pageCache = diskCache("page-cache.json", 30, 400);
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

// The readable text of a web page, trimmed so it fits in a small model's context.
async function readPage(url) {
  const hit = await pageCache.get(url);
  if (hit) return hit;
  const r = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: AbortSignal.timeout(12000), redirect: "follow" });
  if (!r.ok) throw new Error(`the page returned ${r.status}`);
  const html = await r.text();
  const body = html
    .replace(/<(script|style|noscript|svg|nav|footer|header|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const text = htmlText(body).slice(0, 4000);
  pageCache.set(url, text);
  return text;
}

const LOCAL_TOOLS = [
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the web. Returns titles, links and short snippets. Add 'reddit' or 'forum' to a query to find " +
        "what drivers and road trippers say.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "What to search for" } },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_page",
      description: "Read the main text of a web page from a search result (first ~4000 characters). Reddit pages can't be opened.",
      parameters: {
        type: "object",
        properties: { url: { type: "string", description: "The page's full URL" } },
        required: ["url"],
      },
    },
  },
];

// Qwen3 and similar models write their reasoning in <think> tags. Keep it out of the conversation history.
const stripThink = (s) => String(s || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

// An AbortSignal that fires when the app stops waiting for this request (it replaced the request with a newer one,
// or the tab closed), so the GPU doesn't keep writing an answer nobody will read.
function clientGone(res) {
  const c = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) c.abort();
  });
  return c.signal;
}

// Answers are streamed, so the app can show the plan while it's written (`onText` gets the answer so far). A plain
// request also failed on the Mac: LM Studio sends nothing until the answer is done, and Node's fetch gives up after
// 300 s without response headers. The agent keeps undici's own timeouts out of it; LOCAL_TIMEOUT is the only limit.
const LM_AGENT = new Agent({ headersTimeout: 0, bodyTimeout: 0 });

async function lmChat(body, signal, onText) {
  const failed = (e) => {
    if (signal?.aborted) return new Error("Cancelled.");
    if (e.name === "TimeoutError") return new Error("The local model took too long to answer.");
    console.log(`LM Studio request failed: ${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`);
    return new Error("LM Studio isn't running. Open Setup (the gear button) to start it.");
  };
  let r;
  try {
    r = await undiciFetch(`${LOCAL_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // low temperature: steadier routes from a small model
      body: JSON.stringify({ model: LOCAL_MODEL, temperature: 0.3, ...body, stream: true }),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(LOCAL_TIMEOUT), signal]) : AbortSignal.timeout(LOCAL_TIMEOUT),
      dispatcher: LM_AGENT,
    });
  } catch (e) {
    throw failed(e);
  }
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    throw new Error(`LM Studio: ${d?.error?.message || d?.error || `HTTP ${r.status}`}`);
  }
  // Server-sent events: content and reasoning arrive in pieces, tool calls as pieces keyed by index.
  let content = "";
  let reasoning = "";
  let finish = null;
  const calls = [];
  let buf = "";
  const dec = new TextDecoder();
  try {
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith("data:") || line === "data: [DONE]") continue;
        const d = JSON.parse(line.slice(5));
        if (d.error) throw new Error(`LM Studio: ${d.error.message || d.error}`);
        const c = d.choices?.[0];
        if (!c) continue;
        const delta = c.delta || {};
        if (delta.reasoning_content || delta.reasoning) reasoning += delta.reasoning_content || delta.reasoning;
        if (delta.content) {
          content += delta.content;
          onText?.(content);
        }
        for (const t of delta.tool_calls || []) {
          const call = (calls[t.index ?? calls.length] ||= { id: "", type: "function", function: { name: "", arguments: "" } });
          if (t.id) call.id = t.id;
          if (t.function?.name) call.function.name += t.function.name;
          if (t.function?.arguments) call.function.arguments += t.function.arguments;
        }
        if (c.finish_reason) finish = c.finish_reason;
      }
    }
  } catch (e) {
    if (e.message.startsWith("LM Studio:")) throw e;
    throw failed(e);
  }
  const tool_calls = calls.filter(Boolean);
  return { role: "assistant", content, reasoning_content: reasoning, ...(tool_calls.length && { tool_calls }), finish };
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

// Turns off Qwen3.5's thinking on LM Studio's OpenAI-compatible endpoint. Only this works there: "reasoning": "off",
// "reasoning_effort": "low", /no_think and enable_thinking:false were all ignored (tested 2026-10-12).
const NO_THINK = { reasoning_effort: "none" };

// One planning answer from the local model.
// 1. Research: the model may call web_search / read_page (up to `searches` calls), then writes its plan as notes.
// 2. Answer: a second request turns the notes into JSON, with LM Studio constraining the output to the schema,
//    so a small model can't produce broken JSON.
// `onEvent` (optional) hears the progress: { type: "status", text }, { type: "notes", text } with the notes so far,
// and { type: "partial", data } with the finished part of the JSON answer.
async function callLocal({ system, user, searches = 0, schema, signal, region, onEvent }) {
  const notesOut = every(500, (text) => onEvent?.({ type: "notes", text: stripThink(text) }));
  let lastPartial = "";
  const partialOut = every(400, (text) => {
    const data = partialJson(stripThink(text));
    const key = data ? JSON.stringify(data) : "";
    if (key.length > lastPartial.length) {
      lastPartial = key;
      onEvent?.({ type: "partial", data });
    }
  });
  if (!searchAvailable()) searches = 0; // no TAVILY_API_KEY: plan from the model's own knowledge
  const sources = new Map();
  const messages = [{ role: "system", content: system }];
  let used = 0;
  const think = searches > 0 && (await localThink());

  // Research notes from an earlier trip in the same region (kept 30 days) go in as background, with fewer searches.
  const earlier = region ? await regionNotes(region) : null;
  if (earlier && searches > 0) searches = Math.max(1, Math.floor(searches / 2));

  if (searches > 0) {
    messages.push({
      role: "user",
      content:
        `${user}\n\n${earlier ? `Notes from earlier research on this region (still useful background):\n${earlier}\n\n` : ""}` +
        `First research with the tools (at most ${searches} tool calls): check what road trip and driving ` +
        "communities (Reddit, forums, travel writers) recommend for this route and region, and any current road closures. " +
        "Then write your answer as concise notes (at most about 500 words: the days, overnight towns, roads and spots) " +
        "covering everything the JSON needs. Don't write the JSON yet.",
    });
    for (let turn = 0; turn < searches + 3; turn++) {
      if (signal?.aborted) throw new Error("Cancelled.");
      const allowTools = used < searches;
      const turnBody = {
        messages,
        // Without thinking the model reasons in its notes instead, and once filled all 6,000 tokens (8 minutes on an M3).
        max_tokens: think ? 6000 : 2000,
        ...(!think && NO_THINK),
        ...(allowTools && { tools: LOCAL_TOOLS, tool_choice: "auto" }),
      };
      let m = await lmChat(turnBody, signal, notesOut);
      // Qwen3.5 sometimes thinks until it runs out of tokens and says nothing. Redo that turn without thinking.
      if (m.finish === "length" && !stripThink(m.content) && !m.tool_calls?.length) {
        console.log("  thinking ran away, redoing the turn without it");
        m = await lmChat({ ...turnBody, ...NO_THINK }, signal);
      }
      // a turn can ask for several searches at once; keep only what's left of the budget
      const calls = allowTools ? (m.tool_calls || []).slice(0, searches - used) : [];
      messages.push({ role: "assistant", content: stripThink(m.content), ...(calls.length && { tool_calls: calls }) });
      if (!calls.length) break;
      for (const c of calls) {
        let result;
        try {
          const args = JSON.parse(c.function?.arguments || "{}");
          if (c.function?.name === "web_search") {
            onEvent?.({ type: "status", text: `Searching: ${args.query}` });
            const found = await webSearch(String(args.query || ""));
            found.forEach((x) => sources.set(x.url, x.title));
            result = found.length
              ? found.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n")
              : "No results.";
            console.log(`  search: ${args.query} (${found.length} results)`);
          } else if (c.function?.name === "read_page") {
            onEvent?.({ type: "status", text: `Reading ${String(args.url || "").replace(/^https?:\/\/(www\.)?/, "").split("/")[0]}` });
            result = await readPage(String(args.url || ""));
            console.log(`  read: ${args.url}`);
          } else result = "Unknown tool.";
        } catch (e) {
          result = `Tool failed: ${e.message}. Continue without it.`;
        }
        used++;
        messages.push({ role: "tool", tool_call_id: c.id, content: result });
      }
      if (used >= searches) {
        messages.push({ role: "user", content: "That's all the research. Write your notes now, at most about 500 words." });
        onEvent?.({ type: "status", text: "Writing notes on the route" });
      }
    }
  }

  // The JSON step gets only the request and the model's notes, not every search result, so a long trip
  // (SF to Dallas: 8 days, 30 spots) has room in the 32k context for a long answer.
  const notes = [...messages].reverse().find((x) => x.role === "assistant" && x.content)?.content || "";
  if (region && notes && used > 0) saveRegionNotes(region, notes);
  const ask = (extra) => [
    messages[0],
    {
      role: "user",
      content: notes
        ? `${user}\n\nYour research notes:\n${notes}\n\nGive the final answer as the JSON object described above.${extra}`
        : `${user}${extra}`,
    },
  ];
  let data = null;
  onEvent?.({ type: "status", text: "Writing the plan" });
  for (let attempt = 0; attempt < 2 && !data; attempt++) {
    lastPartial = "";
    const m = await lmChat({
      messages: ask(attempt ? "\nKeep every text field short (one sentence) so the whole answer fits." : ""),
      max_tokens: 16000,
      // The reasoning happened in the research notes; thinking here only burns the token budget
      // (it once used 60,000 characters and left no answer).
      ...NO_THINK,
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: true, schema } },
    }, signal, partialOut);
    try {
      data = extractJson(stripThink(m.content));
    } catch {
      console.log(
        `Local JSON attempt ${attempt + 1} failed: finish=${m.finish}, ${String(m.content || "").length} chars of answer, ` +
          `${String(m.reasoning_content || m.reasoning || "").length} chars of reasoning`
      );
    }
  }
  if (!data) throw new Error("The local model's answer was cut off. Try again, or plan a shorter trip.");
  console.log(`Local ${LOCAL_MODEL}: ${used} tool calls`);
  return { data, model: LOCAL_MODEL, sources: [...sources].map(([url, title]) => ({ url, title })) };
}

// A small model plans better with a short catalog, so first ask which states the trip crosses.
async function localStates(prompt, signal) {
  const { data } = await callLocal({
    system: "You know world geography and road trips.",
    // generous on purpose: it only decides which byways the planner may consider
    user:
      "Which states, provinces or territories could this road trip pass through (US states, Canadian provinces like " +
      "British Columbia and Ontario, or Australian states like New South Wales and Victoria)? For New Zealand, the " +
      "United Kingdom and the Alps, list the country names (New Zealand, United Kingdom, Switzerland, Austria, Italy, " +
      "France, Germany) and the regions. Include every one on the likely route plus neighbouring " +
      `states it might reasonably detour into. Use full names.\n\nTrip: ${prompt}`,
    schema: { type: "object", properties: { states: { type: "array", items: { type: "string" } } }, required: ["states"] },
    signal,
  });
  return asArray(data.states).map(String);
}

// JSON shapes for the local model's answers (LM Studio constrains output to these).
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

// Whether LM Studio is up and the model is loaded (for the status line and clear errors).
async function localStatus() {
  try {
    const r = await fetch(`${LOCAL_URL.replace(/\/v1$/, "")}/api/v0/models`, { signal: AbortSignal.timeout(2000) });
    const d = await r.json();
    const m = (d.data || []).find((x) => x.id === LOCAL_MODEL);
    return { running: true, downloaded: !!m, loaded: m?.state === "loaded", context: m?.loaded_context_length || null };
  } catch {
    return { running: false, downloaded: false, loaded: false, context: null };
  }
}

// The road catalog: US National Scenic Byways (data/byways.json, from tools/build-byways.mjs) plus famous
// Australian drives (data/au-drives.json, hand-picked around Sydney, Melbourne and Canberra; each has a Wikipedia
// article and its route number was checked against OpenStreetMap). Australia has no national byway program.
let byways = null;
async function loadByways() {
  if (!byways) {
    const read = async (file) => {
      try {
        return JSON.parse(await fs.readFile(path.resolve("data", file), "utf8"));
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
    ];
  }
  return byways;
}

const PLANNER_INTRO = `You are an expert road trip planner for the United States, Canada, Australia, New Zealand, the United Kingdom and the Alps.
You know which roads driving enthusiasts, motorcyclists and
road trip communities rave about on forums, and you balance great roads with sensible travel: use interstates and fast highways
for long stretches with nothing special, and spend the driving time on roads that are worth it. Never route onto slow back roads
just to avoid a freeway.`;

const asArray = (v) => (Array.isArray(v) ? v : []);

// ---------- seasonal roads (public/seasonal-roads.json, shared with the app) ----------

let seasonal = null;
async function seasonalRoads() {
  if (!seasonal) {
    try {
      seasonal = JSON.parse(await fs.readFile(path.resolve("public", "seasonal-roads.json"), "utf8")).roads || [];
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
const placeKey = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();
const bywayRecord = (b) => ({
  name: b.name, type: b.type, miles: b.miles, km: b.km || (b.miles ? Math.round(b.miles * 1.609) : null),
  description: b.description, qualities: b.qualities, fhwa: b.fhwa, wiki: b.wiki, ref: b.ref || "", country: b.country,
  // the road's name in OpenStreetMap when it differs ("Furkastrasse" for the Furka Pass)
  ...(b.osm && { osm: b.osm }),
});
const noAI = () => AI_PROVIDER !== "local" && !anthropic && !GEMINI_KEY;

// Step 1: the route. Days, stops, via points and featured roads, with the byway catalog as reference.
// With current + dayHours it revises an existing plan using drive times the app measured.
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
  try {
    if (noAI()) return res.status(500).json({ error: "Add ANTHROPIC_API_KEY (or GEMINI_API_KEY) to .env" });
    // Revisions send `current` (the plan so far) with any of: dayHours (measured drive times), feedback (the traveler's
    // comment, like "swap day 2 for the Adirondacks") and roadEdits ({ add: [{ name, ref, states, why }], remove: [names] }).
    const { prompt, current, dayHours, feedback, roadEdits, settings, nightDays } = req.body;
    if (!prompt) return res.status(400).json({ error: "Describe the trip first." });
    const signal = clientGone(res);
    const maxH = maxHoursOf(settings);
    // With `stream`, the answer is newline-separated JSON events (see callLocal), ending in { type: "done", ... }.
    if (req.body.stream) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.flushHeaders();
    }
    const emit = (e) => req.body.stream && !res.writableEnded && res.write(`${JSON.stringify(e)}\n`);

    // The local model gets only the byways in the states the trip crosses (shorter prompt, better focus).
    // A revision already knows its states (the client sends them); a new trip asks the model first.
    // Never send the whole catalog to the local model: with a plan attached it overflows the 32k context, LM Studio
    // cuts off the start, and the model loses the request (it once started planning Sydney to Melbourne).
    let list = await loadByways();
    let stateList = asArray(req.body.states).map(String).filter(Boolean);
    if (AI_PROVIDER === "local") {
      if (!stateList.length) {
        emit({ type: "status", text: "Working out which states and provinces the trip crosses" });
        stateList = await localStates(prompt, signal);
      }
      const states = new Set(stateList.map(placeKey));
      list = list.filter((b) => b.states.some((s) => states.has(placeKey(s))));
      console.log(`Catalog for ${[...states].join(", ") || "no states"}: ${list.length} byways`);
    }
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

Prefer these where they fit the trip, and also use famous roads that aren't in the list.
Name places so a map search finds them, with their state or region and country outside the US: "Banff, Alberta, Canada",
"Lorne, Victoria, Australia", "Wānaka, Otago, New Zealand", "Fort William, Scotland, United Kingdom",
"Bormio, Lombardy, Italy", "Andermatt, Switzerland". Write refs the way the country numbers its roads: "BC 99", "QC 132",
"B100" (Australia), "SH 6" (New Zealand), "A82" (UK), "SS38" (Italy), "B107" (Austria), "D902" (France), "CH 19" (Switzerland).
High Alpine passes are only open from about June to October.`;

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
  Never a lake, forest or park center.
- roads: every featured road once, 1 to 3 per day where the route offers them. Only roads worth driving for their own
  sake: never an ordinary interstate or highway (a famous scenic stretch like I-70 through Glenwood Canyon is fine).
- For a featured road with a faster road nearby or inside a national park, put at least one via ON that road (a lodge,
  pullout, junction or village on it, like "Signal Mountain Lodge, Wyoming" for Teton Park Road) so a router drives it.
- No backtracking. Before answering, check the order and estimate each day's driving time.
${await settingsText(settings, stateList)}

Request: ${prompt}`;

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
          "If the request gives a number of days, keep exactly that many days, even if that means longer days. " +
          "Otherwise add days where needed. Add overnight towns along the way or move day boundaries.";
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
    const planSearches = AI_PROVIDER === "local" ? LOCAL_SEARCHES_PLAN : SEARCHES_PLAN;
    const searches = !revising ? planSearches : feedback || adds.length ? Math.min(2, planSearches) : 0;
    const region = !revising ? regionKey(stateList) : "";
    const { data, model, sources } = await callAI({ system, user, searches, schema: PLAN_SCHEMA, signal, region, onEvent: emit });
    let plan = asPlan(data);

    // Check the plan against its own rules; send the problems back once, without searching again.
    const checkOpts = { prompt, loop: !!settings?.loop, feedback };
    let issues = checkPlan(plan, checkOpts);
    const found = issues.length;
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
          searches: 0, schema: PLAN_SCHEMA, signal, onEvent: emit,
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
    const checks = { found, left: issues.length };

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
    if (req.body.stream) {
      emit({ type: "done", plan, model, sources, checks });
      res.end();
    } else res.json({ plan, model, sources, checks });
  } catch (e) {
    const error = e.message || String(e);
    if (!res.headersSent) res.status(500).json({ error });
    else {
      emit({ type: "error", error });
      res.end();
    }
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
    if (noAI()) return res.status(500).json({ error: "No AI is set up." });
    const { prompt, states, have } = req.body || {};
    const user = `A traveler is planning this road trip: "${String(prompt || "").slice(0, 500)}"
States it passes through: ${asArray(states).join(", ")}.
Roads already in the plan: ${asArray(have).join("; ") || "none"}.

Suggest up to 8 more roads in or near those states that driving enthusiasts, motorcyclists and road trippers love and that
fit this trip: twisty mountain roads, passes, switchbacks, scenic parkways, famous drives. Not interstates, not roads already
in the plan. For each: the common name, route number, state, one line on why drivers love it, and about how long it is.`;
    const { data, sources } = await callAI({
      system: PLANNER_INTRO,
      user,
      searches: Math.min(2, AI_PROVIDER === "local" ? LOCAL_SEARCHES_PLAN : SEARCHES_PLAN),
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

async function roadShape(q) {
  const u = `https://nominatim.openstreetmap.org/search?format=json&limit=40&countrycodes=${COUNTRY_CODES}&polygon_geojson=1&polygon_threshold=0.001&q=${encodeURIComponent(q)}`;
  const pts = [];
  for (const x of asArray(await nominatimJson(u))) {
    if (x.class !== "highway") continue;
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
  return [pt(a, "one end"), pt(mid, "middle"), pt(b, "other end")];
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
    queries.push(`${name}${states[0] ? `, ${states[0]}` : ""}`);
    let best = null;
    for (const q of queries) {
      const ends = roadEnds(await roadShape(q), nearPts, name);
      const span = ends ? haversine([ends[0].lng, ends[0].lat], [ends[2].lng, ends[2].lat]) : 0;
      if (ends && (!best || span > best.span)) best = { ends, span, q };
    }
    if (best) return res.json({ points: best.ends, source: `map: ${best.q}` });

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
  try {
    if (noAI()) return res.status(500).json({ error: "Add ANTHROPIC_API_KEY (or GEMINI_API_KEY) to .env" });
    const { prompt, plan, settings, states } = req.body;
    if (!plan?.points?.length) return res.status(400).json({ error: "Plan the route first." });
    const signal = clientGone(res);

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

The traveler's request: ${prompt || ""}`;

    const { data: d, model, sources } = await callAI({
      system: PLANNER_INTRO,
      user,
      searches: AI_PROVIDER === "local" ? LOCAL_SEARCHES_DETAILS : SEARCHES_DETAILS,
      schema: DETAILS_SCHEMA,
      signal,
      region: asArray(states).length ? `details:${regionKey(states)}` : "",
    });
    res.json({ details: { days: asArray(d.days), roads: asArray(d.roads), spots: asArray(d.spots) }, model, sources });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ---------- setup: keys and the local AI, from the app instead of editing files ----------
//
// GET /api/setup shows what's set up (keys masked, never sent back), POST /api/setup checks each new key with its
// service and writes it to .env, and POST /api/setup/lms starts LM Studio's server, downloads or loads the model.
// Only from this PC: a phone opening a share link on the same Wi-Fi can't see or change any of it.

const isLocalRequest = (req) => ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
const localOnly = (req, res, next) => (isLocalRequest(req) ? next() : res.status(403).json({ error: "Setup only works on the PC running the app." }));
const ENV_FILE = path.resolve(".env");
const LMS = process.env.LMS_PATH || path.join(os.homedir(), ".lmstudio", "bin", process.platform === "win32" ? "lms.exe" : "lms");

// Pick up changed keys without a restart.
function applyConfig() {
  ORS_KEY = (process.env.ORS_API_KEY || "").trim();
  GEMINI_KEY = (process.env.GEMINI_API_KEY || "").trim();
  TAVILY_KEY = (process.env.TAVILY_API_KEY || "").trim();
  CONTACT = (process.env.CONTACT || "").trim();
  UA = userAgent();
  AI_PROVIDER = (process.env.AI_PROVIDER || "local").toLowerCase();
}
// Set lines in .env (creating it if needed), keeping every other line and comment as it is.
async function writeEnv(values) {
  let text = "";
  try {
    text = await fs.readFile(ENV_FILE, "utf8");
  } catch {
    text = "# Settings for Roadtrip Planner. The Setup screen in the app (the gear button) writes these.\n";
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
function run(cmd, args, ms = 120000) {
  return new Promise((ok) => {
    execFile(cmd, args, { timeout: ms, windowsHide: true }, (err, stdout, stderr) =>
      ok({ ok: !err, out: `${stdout || ""}${stderr || ""}`.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim() }));
  });
}
// The graphics hardware, to say whether the local model will run well: an NVIDIA card's own memory, or on an Apple
// Silicon Mac the chip and its shared memory (the model runs on the Mac's GPU from that memory).
let gpuInfo = null;
async function gpu() {
  if (gpuInfo) return gpuInfo;
  if (process.platform === "darwin" && process.arch === "arm64") {
    const r = await run("sysctl", ["-n", "machdep.cpu.brand_string"], 5000);
    gpuInfo = { name: r.ok ? r.out.trim() : "Apple Silicon", gb: Math.round(os.totalmem() / 2 ** 30), apple: true };
    return gpuInfo;
  }
  const r = await run("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"], 5000);
  const [name, mb] = r.ok ? r.out.split("\n")[0].split(",").map((s) => s.trim()) : [];
  gpuInfo = name ? { name, gb: Math.round(Number(mb) / 1024) } : { name: "", gb: null };
  return gpuInfo;
}
let lmsJob = null; // { action, started, done, ok, out } for the running download or load
async function lmsInstalled() {
  try {
    await fs.access(LMS);
    return true;
  } catch {
    return false;
  }
}

app.get("/api/setup", localOnly, async (req, res) => {
  const local = await localStatus();
  res.json({
    ors: { set: !!ORS_KEY, hint: mask(ORS_KEY) },
    tavily: { set: !!TAVILY_KEY, hint: mask(TAVILY_KEY) },
    gemini: { set: !!GEMINI_KEY, hint: mask(GEMINI_KEY) },
    contact: CONTACT,
    provider: AI_PROVIDER,
    local: { ...local, model: LOCAL_MODEL, lms: await lmsInstalled(), job: lmsJob && { ...lmsJob, out: lmsJob.out.slice(-400) } },
    gpu: await gpu(),
    node: process.version,
    platform: process.platform,
    // ready to plan: routing, and an AI that will answer
    ready: !!ORS_KEY && (AI_PROVIDER === "gemini" ? !!GEMINI_KEY : local.loaded),
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
      const r = await fetch(`https://api.openrouteservice.org/v2/directions/driving-car?api_key=${encodeURIComponent(k)}&start=-122.42,37.77&end=-122.41,37.78`,
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
    if (["local", "gemini"].includes(b.provider)) save.AI_PROVIDER = b.provider;
    if (Object.keys(save).length) await writeEnv(save);
    res.json({ saved: Object.keys(save), problems });
  } catch (e) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// POST { action: "start" | "download" | "load" }: LM Studio's command line tool, for people who'd rather not use it.
app.post("/api/setup/lms", localOnly, async (req, res) => {
  const action = req.body?.action;
  if (!(await lmsInstalled())) return res.status(400).json({ error: "LM Studio isn't installed (or hasn't been opened once yet)." });
  if (lmsJob && !lmsJob.done) return res.json({ job: lmsJob });
  if (action === "start") {
    const r = await run(LMS, ["server", "start"], 30000);
    return res.json({ ok: r.ok, out: r.out.slice(-400) });
  }
  // downloading (about 6 GB) and loading take a while: run in the background, the app polls GET /api/setup
  const args = action === "download" ? ["get", LOCAL_MODEL, "-y"]
    : action === "load" ? ["load", LOCAL_MODEL, "--context-length", "32768", "--gpu", "max", "-y"]
    : null;
  if (!args) return res.status(400).json({ error: "Unknown action" });
  if (action === "load") await run(LMS, ["server", "start"], 30000);
  lmsJob = { action, started: Date.now(), done: false, ok: false, out: "" };
  const job = lmsJob;
  const p = spawn(LMS, args, { windowsHide: true });
  const keep = (d) => (job.out = (job.out + d.toString()).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").slice(-4000));
  p.stdout.on("data", keep);
  p.stderr.on("data", keep);
  p.on("close", (code) => Object.assign(job, { done: true, ok: code === 0 }));
  p.on("error", (e) => Object.assign(job, { done: true, ok: false, out: e.message }));
  res.json({ job });
});

const port = process.env.PORT || 3000;
const url = `http://localhost:${port}`;
// start.cmd / start.sh pass --open to open the app in the browser
function openBrowser() {
  if (!process.argv.includes("--open")) return;
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
app.listen(port, () => {
  console.log(`Running on ${url}`);
  openBrowser();
}).on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  // already running (started twice): just show it
  console.log(`Roadtrip Planner is already running on ${url}`);
  openBrowser();
  setTimeout(() => process.exit(0), 500);
});
