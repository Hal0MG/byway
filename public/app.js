const STYLES = {
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
  light: "https://tiles.openfreemap.org/styles/liberty",
};
const BLUE = "#0a84ff";
const GREY = "#8e8e93";
const MODES = ["fastest", "scenic"];
const DEFAULT_NAME = "New trip";

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isMobile = () => matchMedia("(max-width: 760px)").matches;
const pad = () =>
  isMobile()
    ? { top: 90, left: 40, right: 40, bottom: Math.round(innerHeight * 0.58) }
    : { top: 110, bottom: 70, right: 70, left: 460 };

function fmtDur(s) {
  const m = Math.max(1, Math.round(s / 60));
  const h = Math.floor(m / 60);
  return h ? `${h} hr ${m % 60} min` : `${m} min`;
}
function fmtShort(s) {
  const m = Math.max(1, Math.round(s / 60));
  const h = Math.floor(m / 60);
  return h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
}
const miles = (m) => m / 1609.34;
// Distances in km everywhere except the US and the UK; temperatures in °F only in the US. Set by updateUnits().
let KM = false;
let TEMP_F = true;
const isAU = (p) => p.lng > 110 && p.lat < -9 && p.lng < 160;
// Canada: inside a covered Canadian province, or north of the 49th parallel in the west (rough, for uncovered ones).
const isCA = (p) => coverageCountry(p) === "CA" || (p.lat >= 49 && p.lng > -141 && p.lng < -95);
// The country a point is in: the covered regions first, then rough boxes for the rest.
function countryOf(p) {
  const c = coverageCountry(p);
  if (c) return c;
  if (isAU(p)) return "AU";
  if (isCA(p)) return "CA";
  if (p.lng > 165 && p.lng < 179 && p.lat < -33 && p.lat > -48) return "NZ";
  if (p.lng > -8.7 && p.lng < 1.8 && p.lat > 49.8 && p.lat < 61) return "GB";
  if (p.lng < -50 && p.lat > 15) return "US";
  return null;
}
function updateUnits() {
  const cs = stops.filter((s) => !isVia(s)).map(countryOf);
  const share = (test) => cs.filter(test).length * 2 >= cs.length;
  KM = cs.length > 0 && !share((c) => c === "US" || c === "GB");
  TEMP_F = !cs.length || share((c) => c === "US");
}
const fmtMi = (m) => (KM ? `${Math.round(m / 1000).toLocaleString()} km` : `${Math.round(miles(m)).toLocaleString()} mi`);
const fmtMiles = (mi) => fmtMi(Number(mi) * 1609.34); // a length given in miles
// Heights: feet with miles, meters with km.
const fmtElev = (m) => (KM ? `${Math.round(m).toLocaleString()} m` : `${Math.round(m * 3.2808).toLocaleString()} ft`);
const fmtTemp = (c) => (c == null ? "" : TEMP_F ? `${Math.round(c * 1.8 + 32)}°` : `${Math.round(c)}°`);
const esc = (t) =>
  String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

let toastTimer = null;
function setStatus(msg) {
  $("status").textContent = msg || "";
  const t = $("toast");
  clearTimeout(toastTimer);
  t.textContent = msg || "";
  t.hidden = !msg || document.body.dataset.view === "map";
  if (msg) toastTimer = setTimeout(() => (t.hidden = true), 7000);
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

document.querySelectorAll("[data-icon]").forEach((el) => el.insertAdjacentHTML("afterbegin", icon(el.dataset.icon, 20)));
$("brand").innerHTML = LOGO;

// ---------- map and theme ----------

let theme = store.get("theme") || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
document.documentElement.dataset.theme = theme;
const themeIcon = () => ($("theme-btn").innerHTML = icon(theme === "dark" ? "sun" : "moon", 20));
themeIcon();

const map = new maplibregl.Map({
  container: "map",
  style: STYLES[theme],
  center: [-98, 39],
  zoom: 3.6,
  attributionControl: { compact: true },
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");

$("theme-btn").onclick = () => {
  theme = theme === "dark" ? "light" : "dark";
  store.set("theme", theme);
  document.documentElement.dataset.theme = theme;
  themeIcon();
  styleReady = false;
  map.setStyle(STYLES[theme], { diff: false }); // a diff skips style.load and drops the route layers
};

// ---------- views: itinerary page and map ----------

// Views: home (the globe with trip suggestions, home.js), itinerary and map.
function setView(v) {
  const prev = document.body.dataset.view;
  document.body.dataset.view = v;
  document.querySelectorAll(".seg button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
  store.set("view", v);
  $("toast").hidden = true;
  if (typeof onViewChange === "function" && (v !== prev || v === "home")) onViewChange(v, prev);
  if (v === "map") requestAnimationFrame(() => {
    map.resize();
    declutter();
  });
}
document.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => setView(b.dataset.view)));
$("brand").onclick = () => setView("home");
// "New trip": back to the globe with nothing selected.
async function goHome() {
  await newTrip();
  setView("home");
}

// ---------- state ----------

// kind "stop" is a place you visit or sleep at; kind "via" is a point on a scenic road that only steers the route.
// day groups points into driving days; the last point of a day is where you sleep.
const stops = []; // { name, lng, lat, note, photoQuery, kind, day, road, photosP }
const pins = [];
let pills = [];
let spotMarkers = [];
const routes = { scenic: null, fastest: null };
let selected = "scenic";
let trip = { id: null, name: DEFAULT_NAME, customName: false, saved: false, prompt: "", settings: {}, versions: [], notes: null };
// Read-only view (a share link: ?trip=<id>&view=read): nothing can be changed or saved.
const READONLY = new URLSearchParams(location.search).get("view") === "read";

// Trip options. styles: coast, mountains, twisty, nocities, photo, easy, food. evRange in km.
const DEFAULT_SETTINGS = { startDate: "", startTime: "08:00", maxHours: 7.5, noNight: false, loop: false, styles: [], ev: false, evRange: 400 };
const tripSettings = () => ({ ...DEFAULT_SETTINGS, ...(trip.settings || {}) });
// Options that carry over to the next new trip (not the dates or the loop).
function rememberSettings(s) {
  const { startTime, maxHours, noNight, ev, evRange, styles } = s;
  store.set("tripDefaults", JSON.stringify({ startTime, maxHours, noNight, ev, evRange, styles }));
}
function rememberedSettings() {
  try {
    return JSON.parse(store.get("tripDefaults") || "{}") || {};
  } catch {
    return {};
  }
}
// A day counts as long half an hour past the traveler's limit.
const longDayS = () => (Number(tripSettings().maxHours) + 0.5) * 3600;
// "08:30" -> 510 minutes after midnight
const startMinutes = () => {
  const [h, m] = String(tripSettings().startTime || "08:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
};
// The date of a trip day ("2026-07-04"), or "" when the trip has no start date.
function dayDate(day) {
  const s = tripSettings().startDate;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  return new Date(Date.parse(`${s}T12:00:00Z`) + (day - 1) * 86400000).toISOString().slice(0, 10);
}
// The AI plan: { title, summary, days: [{ day, title, overnight, summary }], roads: [...], spots: [...] }
let plan = null;
// While planning: { steps: [{ id, label, state, detail }], error }
let progress = null;

// ---------- geocoding (Nominatim public server allows about 1 request per second) ----------

// Up to `limit` matches, best first: [{ lng, lat, cls }] (cls: OpenStreetMap's class, "place" for towns).
// `towns`: only cities, towns and villages. Through the server (/api/geocode: cached, one polite client for all devices).
async function nominatimAll(q, limit = 1, towns = false) {
  const r = await fetch(`/api/geocode?q=${encodeURIComponent(q)}&limit=${limit}${towns ? "&towns=1" : ""}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || "Place search failed.");
  return data.hits || [];
}
const nominatim = async (q) => (await nominatimAll(q))[0] || null;
// The AI sometimes gets the region wrong ("Mount Cook Village, Otago" is in Canterbury) or names a spot the map
// doesn't know ("Arthur's Pass Summit"). Then try the place with just its country, and without words like "Summit".
async function geocode(q) {
  return (await geocodeAll(q, 1))[0];
}
// All the matches of the first query form that finds any (see geocode). Several towns share a name ("Blue River,
// British Columbia" is also a place near the Yukon), so placePoints picks among them by the route.
async function geocodeAll(q, limit = 5) {
  const parts = q.split(",").map((s) => s.trim()).filter(Boolean);
  const tries = [q];
  if (parts.length > 2) tries.push(`${parts[0]}, ${parts.at(-1)}`);
  const plain = parts[0].replace(/\b(summit|lookout|viewpoint|scenic overlook|overlook|trailhead)\b/gi, "").replace(/\s+/g, " ").trim();
  if (plain && plain !== parts[0]) tries.push([plain, ...parts.slice(1)].join(", "), parts.length > 1 ? `${plain}, ${parts.at(-1)}` : plain);
  for (const t of [...new Set(tries)]) {
    const hits = await nominatimAll(t, limit);
    if (!hits.length) continue;
    // "Green River, Utah" only finds the river; when nothing is a town, add the towns of that name
    if (limit > 1 && !hits.some((h) => /^(place|boundary)$/.test(h.cls))) hits.push(...(await nominatimAll(t, 3, true).catch(() => [])));
    return hits;
  }
  throw new Error(`No match for "${q}". Try a city or landmark name.`);
}

// ---------- photos ----------

// `s`: the stop, so the photos are from there and not from a place with the same name elsewhere
async function fetchPhotos(q, s) {
  try {
    const at = s?.lat != null ? `&at=${s.lat},${s.lng}` : "";
    const r = await fetch(`/api/photos?q=${encodeURIComponent(q)}${at}`);
    return (await r.json()).photos || [];
  } catch {
    return [];
  }
}
// Photos are saved with the trip once found, so they're only looked up once per stop.
function photosFor(s) {
  if (Array.isArray(s.photos) && s.photos.length) return Promise.resolve(s.photos);
  s.photosP ||= (async () => {
    let photos = s.photoQuery ? await fetchPhotos(s.photoQuery, s) : [];
    if (!photos.length) photos = await fetchPhotos(s.name, s);
    if (photos.length) {
      s.photos = photos;
      scheduleSave();
    }
    return photos;
  })();
  return s.photosP;
}
async function fillGallery(s, el) {
  const photos = await photosFor(s);
  photos.slice(0, 3).forEach((u) => {
    const img = new Image();
    img.src = u;
    img.alt = s.name;
    img.loading = "lazy";
    img.onerror = () => img.remove();
    el.appendChild(img);
  });
}

// ---------- days, via points and map app links ----------

const isVia = (s) => s.kind === "via";

// Indexes of the points each route goes through: scenic uses every point, fastest skips the vias.
function routeIndexes(mode) {
  const all = stops.map((_, i) => i);
  if (mode === "scenic") return all;
  const only = all.filter((i) => !isVia(stops[i]));
  return only.length >= 2 ? only : all;
}

// Map from point index to the leg of route r that ends there.
function legsByEnd(r) {
  const m = new Map();
  if (!r) return m;
  r.legs.forEach((l, k) => m.set(r.idx[k + 1], l));
  return m;
}

// Days as runs of points with the same day number. Each day starts where the previous one ended.
function dayGroups() {
  const groups = [];
  stops.forEach((s, i) => {
    let g = groups[groups.length - 1];
    if (!g || g.day !== s.day) groups.push((g = { day: s.day, items: [] }));
    g.items.push(i);
  });
  return groups;
}

// Renumber days 1, 2, 3... in list order, starting a new day wherever the number changes.
function normalizeDays() {
  let day = 1;
  stops.forEach((s, i) => {
    if (i > 0 && s.day !== stops[i - 1]._day) day++;
    s._day = s.day;
    s.day = day;
  });
  stops.forEach((s) => delete s._day);
}

function dayStats(g, mode = selected) {
  const legs = legsByEnd(routes[mode]);
  let dur = 0;
  let dist = 0;
  let any = false;
  for (const i of g.items) {
    const l = legs.get(i);
    if (l) {
      dur += l.duration_s;
      dist += l.distance_m;
      any = true;
    }
  }
  return any ? { dur, dist } : null;
}

const longDays = () => dayGroups().filter((g) => (dayStats(g, "scenic")?.dur || 0) > longDayS()).map((g) => g.day);

// The number of days the request asks for, or 0 (same rules as requestedDays on the server).
function askedDays(prompt) {
  const n = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, a: 1 };
  const t = String(prompt || "").toLowerCase();
  let m = t.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[ -]days?\b/);
  if (m) return n[m[1]] ?? Number(m[1]);
  m = t.match(/\b(a|one|two)[ -]weeks?\b/);
  return m ? (n[m[1]] ?? 1) * 7 : 0;
}

// Long days without asking the AI: the route stays as it is and only the overnights move. Split the measured legs into
// days so the longest day is as short as possible (a linear partition), sleeping at real stops where it costs under
// 15 minutes of the longest day. Keeps the number of days the request asked for; otherwise may add up to two days.
// Leaves trips with a rest or exploring day (a day under an hour) to the AI. Returns true if it fixed every long day.
// The best split of a route's legs into D days: L[i] is the drive into point i, via[i] whether point i is a via.
// Returns { ends: [last point of each day], worst: longest day in seconds } or null.
function bestSplit(L, via, D) {
  const n = L.length;
  if (D < 1 || D > n - 1) return null;
  const pre = [0];
  for (let i = 1; i < n; i++) pre[i] = pre[i - 1] + L[i];
  const span = (a, b) => pre[b] - pre[a];
  // f[d][i]: best cost with d days ending at point i; cost = longest day + 15 min per overnight at a via point
  const f = Array.from({ length: D + 1 }, () => new Array(n).fill(Infinity));
  const from = Array.from({ length: D + 1 }, () => new Array(n).fill(-1));
  f[0][0] = 0;
  for (let d = 1; d <= D; d++) {
    for (let i = d; i < n; i++) {
      if (d === D && i !== n - 1) continue;
      const pen = d < D && via[i] ? 900 : 0;
      for (let k = d - 1; k < i; k++) {
        if (f[d - 1][k] === Infinity) continue;
        const c = Math.max(f[d - 1][k], span(k, i) + pen);
        if (c < f[d][i]) [f[d][i], from[d][i]] = [c, k];
      }
    }
  }
  if (f[D][n - 1] === Infinity) return null;
  const ends = [];
  for (let d = D, i = n - 1; d > 0; i = from[d][i], d--) ends.unshift(i);
  let worst = 0;
  ends.forEach((e, d) => (worst = Math.max(worst, span(d ? ends[d - 1] : 0, e))));
  return { ends, worst };
}

function balanceDays() {
  const r = routes.scenic;
  if (!r || stops.length < 3) return false;
  const groups = dayGroups();
  if (groups.some((g) => (dayStats(g, "scenic")?.dur || 0) < 3600)) return false;
  const legs = legsByEnd(r);
  const L = stops.map((_, i) => legs.get(i)?.duration_s || 0); // L[i]: the drive into point i
  const via = stops.map((s) => isVia(s));
  const n = stops.length;
  const limit = longDayS();
  const asked = askedDays(trip.prompt);
  const counts = asked ? [groups.length] : [groups.length, groups.length + 1, groups.length + 2];
  for (const D of counts) {
    if (D > n - 1) break;
    const split = bestSplit(L, via, D);
    if (!split || split.worst > limit) continue;
    const { ends } = split;
    let day = 1;
    stops.forEach((s, i) => {
      s.day = day;
      if (i === ends[day - 1] && day < D) {
        if (isVia(s)) Object.assign(s, { kind: "stop", note: s.note || "Overnight here" });
        day++;
      }
    });
    // spots go with the day of the nearest point; roads are re-measured per day
    for (const sp of plan?.spots || []) {
      if (sp.info?.lat == null) continue;
      let best = null;
      for (const st of stops) {
        const dd = haversine([st.lng, st.lat], [sp.info.lng, sp.info.lat]);
        if (!best || dd < best.dd) best = { dd, day: st.day };
      }
      sp.day = best.day;
    }
    syncDayNames(true);
    syncRoadDays();
    return true;
  }
  return false;
}

// Keep at most n middle points: every stop first, then vias spread evenly along the day.
function thinPoints(mid, n) {
  if (mid.length <= n) return mid;
  const keepStops = mid.filter((i) => !isVia(stops[i]));
  const pick = (arr, k) => Array.from({ length: k }, (_, j) => arr[Math.floor(((j + 0.5) * arr.length) / k)]);
  if (keepStops.length >= n) return pick(keepStops, n);
  const vias = mid.filter((i) => isVia(stops[i]));
  const chosen = new Set([...keepStops, ...pick(vias, n - keepStops.length)]);
  return mid.filter((i) => chosen.has(i));
}

// One link per day for turn-by-turn in the phone's map app.
// Google: the /maps/dir/A/B/C path keeps every stop in both the website and the apps (the api=1 "waypoints"
// parameter was being dropped). Up to 10 places per link. Apple (iOS 18.4+): repeated waypoint parameters.
// No "avoid highways": the via points already put the drive on the scenic roads.
const MAX_LINK_STOPS = 8;
function dayLinks(groups, gi) {
  let pts = [...groups[gi].items];
  if (gi > 0) pts.unshift(groups[gi - 1].items.at(-1));
  if (selected === "fastest") pts = pts.filter((i, k) => k === 0 || k === pts.length - 1 || !isVia(stops[i]));
  if (pts.length < 2) return null;
  const ll = (i) => `${stops[i].lat.toFixed(5)},${stops[i].lng.toFixed(5)}`;
  const origin = pts[0];
  const dest = pts[pts.length - 1];
  const mid = thinPoints(pts.slice(1, -1), MAX_LINK_STOPS);
  const all = [origin, ...mid, dest];

  const ap = new URLSearchParams({ source: ll(origin), destination: ll(dest), mode: "driving" });
  mid.forEach((i) => ap.append("waypoint", ll(i)));

  return {
    google: `https://www.google.com/maps/dir/${all.map(ll).join("/")}/data=!4m2!4m1!3e0`,
    apple: `https://maps.apple.com/directions?${ap}`,
    count: all.length,
  };
}

function toggleOvernight(i) {
  const next = stops[i + 1];
  if (!next) return;
  const delta = next.day > stops[i].day ? -1 : 1;
  for (let j = i + 1; j < stops.length; j++) stops[j].day += delta;
  normalizeDays();
  renderStops();
  renderPills();
  updateFix();
  scheduleSave();
  renderItinerary();
}

// ---------- stops list and pins (map view panel) ----------

function renderStops() {
  updateUnits();
  $("change-form").hidden = !plan || READONLY;
  pins.forEach((p) => p.remove());
  pins.length = 0;
  const ol = $("stops");
  ol.innerHTML = "";
  $("empty").hidden = stops.length > 0;
  const legs = legsByEnd(routes[selected]);
  const groups = dayGroups();
  const multiDay = groups.length > 1;
  let num = 0;

  groups.forEach((g, gi) => {
    ol.appendChild(dayHeader(groups, gi, multiDay));
    for (const i of g.items) {
      const s = stops[i];
      const l = legs.get(i);
      if (l) {
        const leg = document.createElement("li");
        leg.className = "leg";
        leg.textContent = `${fmtDur(l.duration_s)}, ${fmtMi(l.distance_m)}`;
        ol.appendChild(leg);
      }
      if (isVia(s)) ol.appendChild(viaRow(s, i));
      else ol.appendChild(stopRow(s, i, ++num));
    }
  });
  declutter();
}

function dayHeader(groups, gi, multiDay) {
  const g = groups[gi];
  const li = document.createElement("li");
  li.className = "day-head";
  const label = document.createElement("div");
  label.className = "day-label";
  const b = document.createElement("b");
  b.textContent = multiDay ? `Day ${g.day}` : "Directions";
  const small = document.createElement("small");
  const st = dayStats(g);
  small.textContent = st ? `${fmtDur(st.dur)}, ${fmtMi(st.dist)}` : "";
  if (st && multiDay && st.dur > longDayS()) {
    small.textContent += ". Long day";
    small.classList.add("warn");
  }
  label.append(b, small);
  li.appendChild(label);

  const links = dayLinks(groups, gi);
  if (links) {
    const box = document.createElement("div");
    box.className = "day-links";
    for (const [href, app] of [[links.google, "Google Maps"], [links.apple, "Apple Maps"]]) {
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = app;
      a.setAttribute("aria-label", `Open ${multiDay ? `day ${g.day}` : "the trip"} in ${app}`);
      box.appendChild(a);
    }
    li.appendChild(box);
  }
  return li;
}

function actionButtons(i, s, extra = []) {
  const actions = document.createElement("div");
  actions.className = "actions";
  const mk = (label, aria, fn, cls) => {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.setAttribute("aria-label", aria);
    if (cls) btn.className = cls;
    btn.onclick = (e) => {
      e.stopPropagation();
      fn();
    };
    actions.appendChild(btn);
  };
  extra.forEach((x) => mk(...x));
  mk("↑", `Move ${s.name} up`, () => move(i, -1));
  mk("↓", `Move ${s.name} down`, () => move(i, 1));
  mk("×", `Remove ${s.name}`, () => {
    stops.splice(i, 1);
    changed();
  });
  return actions;
}

// A stop's or via's pin; dragging it moves the point (moveOnMap in features.js).
function pinMarker(el, s, i) {
  const m = new maplibregl.Marker({ element: el, draggable: !READONLY }).setLngLat([s.lng, s.lat]).addTo(map);
  m.on("dragend", () => moveOnMap(i, m.getLngLat()));
  return m;
}

const flyTo = (s) => map.flyTo({ center: [s.lng, s.lat], zoom: Math.max(map.getZoom(), 9), padding: pad() });

function stopRow(s, i, num) {
  const pin = document.createElement("div");
  pin.className = "pin";
  pin.textContent = num;
  pins.push(pinMarker(pin, s, i));

  const li = document.createElement("li");
  li.className = "stop";

  const gallery = document.createElement("div");
  gallery.className = "gallery";
  li.appendChild(gallery);
  fillGallery(s, gallery);

  const body = document.createElement("div");
  body.className = "stop-body";
  body.onclick = () => flyTo(s);

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = num;

  const title = document.createElement("div");
  title.className = "title";
  const b = document.createElement("b");
  b.textContent = s.name;
  title.appendChild(b);
  const sub = [s.road, s.note].filter(Boolean).join(". ");
  if (sub) {
    const small = document.createElement("small");
    small.textContent = sub;
    title.appendChild(small);
  }

  const extra = [];
  if (i < stops.length - 1) {
    const night = stops[i + 1].day > s.day;
    extra.push([
      "☾",
      night ? `Overnight at ${s.name}. Click to keep driving instead` : `Stay overnight at ${s.name}`,
      () => toggleOvernight(i),
      night ? "on" : "",
    ]);
  }
  body.append(badge, title, actionButtons(i, s, extra));
  li.appendChild(body);
  return li;
}

function viaRow(s, i) {
  const dot = document.createElement("div");
  dot.className = "via-pin";
  dot.title = `via ${s.name}`;
  pins.push(pinMarker(dot, s, i));

  const li = document.createElement("li");
  li.className = "via";
  const body = document.createElement("div");
  body.className = "stop-body";
  body.onclick = () => flyTo(s);
  const mark = document.createElement("span");
  mark.className = "via-dot";
  const title = document.createElement("div");
  title.className = "title";
  const b = document.createElement("b");
  b.textContent = `via ${shortName(s.name)}`;
  title.appendChild(b);
  const sub = [s.road, s.note].filter(Boolean).join(". ");
  if (sub) {
    const small = document.createElement("small");
    small.textContent = sub;
    title.appendChild(small);
  }
  body.append(mark, title, actionButtons(i, s));
  li.appendChild(body);
  return li;
}

function move(i, d) {
  const j = i + d;
  if (j < 0 || j >= stops.length) return;
  [stops[i], stops[j]] = [stops[j], stops[i]];
  // days stay with the positions, so moving across a day boundary moves the point into that day
  [stops[i].day, stops[j].day] = [stops[j].day, stops[i].day];
  changed();
}

function fitStops() {
  if (!stops.length) return;
  const b = new maplibregl.LngLatBounds();
  stops.forEach((s) => b.extend([s.lng, s.lat]));
  map.fitBounds(b, { padding: pad(), maxZoom: 10, duration: 0 });
}

const shortName = (n) => n.split(",")[0].trim();
function autoName() {
  if (trip.customName || stops.length < 2) return;
  trip.name = plan?.title || `${shortName(stops[0].name)} to ${shortName(stops[stops.length - 1].name)}`;
  $("trip-name").value = trip.name;
}

// Called whenever the list of stops changes by hand.
function changed() {
  normalizeDays();
  clearRoutes();
  renderStops();
  fitStops();
  autoName();
  scheduleSave();
  renderItinerary();
}

async function addStop(name, { note = "", photoQuery = "", kind = "stop", day, road = "" } = {}) {
  // of the places with that name, the one that fits after the last stop (a town over a river of the same name)
  const cands = await geocodeAll(name);
  const pts = stops.length ? [{ ...stops[stops.length - 1], cands: [stops[stops.length - 1]] }, { cands }] : [{ cands }];
  pickAlongRoute(pts);
  const g = pts[pts.length - 1];
  day ??= stops.length ? stops[stops.length - 1].day : 1;
  stops.push({ name, lng: g.lng, lat: g.lat, note, photoQuery, kind, day, road });
}

$("add-btn").onclick = async () => {
  const q = $("search").value.trim();
  if (!q) return;
  try {
    setStatus("Searching...");
    await addStop(q);
    $("search").value = "";
    changed();
    const added = stops[stops.length - 1];
    setStatus(
      coverage && !coverageCountry(added)
        ? `${shortName(added.name)} is outside the covered areas (grey on the map). Routing works, but the planner has no road list there yet.`
        : ""
    );
  } catch (e) {
    setStatus(e.message);
  }
};
$("search").addEventListener("keydown", (e) => e.key === "Enter" && $("add-btn").click());

// ---------- AI planning pipeline ----------
// 1. /api/plan: route skeleton (days, stops, via points, featured roads)
// 2. /api/details runs in the background: day write-ups, road details, spots
// 3. place the points (Nominatim), 4. measure the drive (ORS); if a day is too long, revise once with the real times
// 5. merge the details, 6. /api/enrich: Wikipedia photos, articles and coordinates

async function api(path, body, signal) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}

// An AI endpoint with { stream: true }: newline-separated JSON events while the AI works (status lines, its notes, the
// finished part of the answer), then { type: "done" } with the answer. Shown live under that step of the planning screen.
async function aiStream(path, body, step, signal) {
  const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, stream: true }), signal });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${r.status})`);
  }
  const lives = progress ? (progress.lives ||= {}) : {};
  const live = (lives[step] = {});
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        const e = JSON.parse(line);
        if (e.type === "done") return e;
        if (e.type === "error") throw new Error(e.error);
        if (e.type === "status") live.status = e.text;
        else if (e.type === "notes") live.notes = e.text;
        else if (e.type === "partial") live.plan = e.data;
        renderLive();
      }
    }
  } finally {
    if (lives[step] === live) delete lives[step];
    renderLive();
  }
  throw new Error("The AI stopped before finishing. Try again.");
}
const planStream = (body, step = "route") => aiStream("/api/plan", body, step);
// Events can come several times a second; redraw at most every 300 ms.
let liveTimer = 0;
function renderLive() {
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    liveTimer = 0;
    if (progress) renderItinerary();
  }, 300);
}

function progressStart(steps) {
  progress = { steps: steps.map(([id, label]) => ({ id, label, state: "todo", detail: "" })), error: null };
  renderItinerary();
}
function progressSet(id, state, detail) {
  const s = progress?.steps.find((x) => x.id === id);
  if (!s) return;
  s.state = state;
  if (detail != null) s.detail = detail;
  renderItinerary();
}

// The parts of the plan the AI needs to revise it.
const skeletonOf = () => ({
  title: plan?.title,
  days: (plan?.days || []).map(({ day, title, overnight }) => ({ day, title, overnight })),
  points: stops.map(({ name, kind, day, road, note }) => ({ name, kind, day, road, note })),
  roads: (plan?.roads || []).map(({ name, ref, byway, days, segment }) => ({ name, ref, byway, days, segment })),
});

// Each point has its map matches in `cands`; choose one each so the whole route is shortest (Viterbi over the
// matches), with a penalty for rivers, lakes and the like when a town shares the name ("Green River, Utah" is also the
// river by Flaming Gorge). Sets lng/lat and removes `cands`.
function pickAlongRoute(points) {
  const cost = (c) => (c.cls && !/^(place|boundary|tourism|amenity|building|historic|highway|railway|aeroway|leisure)$/.test(c.cls) ? 100000 : 0);
  let prev = null; // [{ total, path }] per candidate of the previous point
  for (const p of points) {
    const cands = p.cands?.length ? p.cands : [{ lng: p.lng, lat: p.lat }];
    prev = cands.map((c) => {
      if (!prev) return { total: cost(c), path: [c] };
      let best = null;
      for (const q of prev) {
        const t = q.total + haversine([q.path.at(-1).lng, q.path.at(-1).lat], [c.lng, c.lat]) + cost(c);
        if (!best || t < best.total) best = { total: t, path: [...q.path, c] };
      }
      return best;
    });
  }
  const best = prev?.reduce((a, b) => (b.total < a.total ? b : a));
  points.forEach((p, i) => {
    if (best) Object.assign(p, { lng: best.path[i].lng, lat: best.path[i].lat });
    delete p.cands;
    delete p.cls;
  });
}

// Replace the stops with the AI's points. Points that keep their name reuse their location and photos.
async function placePoints(skel) {
  const keepSpots = plan?.spots || [];
  plan = {
    title: skel.title, summary: skel.summary, days: skel.days || [], roads: skel.roads || [], spots: keepSpots,
    sources: plan?.sources || [],
  };
  const known = new Map(stops.map((s) => [s.name, s]));
  const next = [];
  const missed = [];
  const items = skel.points || [];
  for (const [i, s] of items.entries()) {
    progressSet("places", "doing", `${i + 1} of ${items.length}: ${shortName(s.name)}`);
    const p = {
      name: s.name,
      note: s.note || "",
      photoQuery: s.photo_query || "",
      kind: s.kind === "via" ? "via" : "stop",
      day: Number(s.day) || 1,
      road: s.road || "",
    };
    const k = known.get(s.name);
    if (k) {
      next.push({ ...p, lng: k.lng, lat: k.lat, photos: k.photos, photosP: k.photosP, cands: [k] });
      continue;
    }
    try {
      const cands = await geocodeAll(s.name);
      next.push({ ...p, ...cands[0], cands });
    } catch {
      missed.push(s.name);
    }
  }
  pickAlongRoute(next);
  const dropped = dropDetours(next);
  const saved = fixOrder(next);
  stops.length = 0;
  stops.push(...next);
  normalizeDays();
  // a day whose overnight town couldn't be found ends on a via point: sleep there instead
  for (const g of dayGroups()) {
    const last = stops[g.items.at(-1)];
    if (isVia(last)) {
      last.kind = "stop";
      last.note = last.note || "Overnight here (the planned town couldn't be found on the map)";
    }
  }
  updateUnits();
  if (saved) {
    syncDayNames(true);
    plan.syncRoads = true; // road days are redone once the new route is measured
    trip.edits = [...(trip.edits || []), { text: `Reordered the stops to avoid backtracking (${fmtMi(saved)} shorter)`, at: new Date().toISOString() }];
  }
  clearRoutes();
  renderStops();
  fitStops();
  autoName();
  const notes = [
    missed.length ? `Couldn't find ${missed.join(", ")}` : "",
    dropped.length ? `Skipped off-route ${dropped.map(shortName).join(", ")}` : "",
    saved ? `Reordered to avoid backtracking, ${fmtMi(saved)} shorter` : "",
    uncoveredStops().length ? `Outside the covered areas: ${uncoveredStops().map((s) => shortName(s.name)).join(", ")}` : "",
  ].filter(Boolean);
  progressSet("places", "done", notes.join(". ") || `${next.length} places`);
  return { reordered: saved > 0 };
}

// The day guides are written in the background while the route is measured. When the days change (the order fix or
// a rebalance) the request is cancelled, which also stops the local model, and sent again for the new days.
let detailsCtl = null;
function requestDetails(prompt, skel) {
  detailsCtl?.abort();
  detailsCtl = new AbortController();
  return aiStream("/api/details", { prompt, plan: skel, settings: tripSettings(), states: tripStates() }, "details", detailsCtl.signal)
    .catch((error) => ({ error }));
}

// Small models often plan stops out of order (Sydney, the Blue Mountains, the Snowy Mountains, back to the coast near
// Sydney, then Melbourne). Reorders the points to the shortest straight-line path with the same start and end (2-opt
// and moving runs of up to 3 points), and only when that's clearly shorter (8% and 40 km), so a deliberate detour
// stays. Days keep their overnight towns: a new day starts after each point that was the end of a day.
// Changes `points` in place and returns the meters saved (0 when nothing changed).
function fixOrder(points) {
  const n = points.length;
  if (n < 4) return 0;
  const P = points.map((p) => [p.lng, p.lat]);
  const D = (a, b) => haversine(P[a], P[b]);
  const total = (o) => o.slice(1).reduce((s, x, k) => s + D(o[k], x), 0);
  let ord = points.map((_, i) => i);
  const before = total(ord);
  for (let pass = 0, better = true; better && pass < 40; pass++) {
    better = false;
    for (let i = 1; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        if (D(ord[i - 1], ord[j]) + D(ord[i], ord[j + 1]) < D(ord[i - 1], ord[i]) + D(ord[j], ord[j + 1]) - 1) {
          ord = [...ord.slice(0, i), ...ord.slice(i, j + 1).reverse(), ...ord.slice(j + 1)];
          better = true;
        }
      }
    }
    for (let len = 1; len <= 3; len++) {
      for (let i = 1; i + len < n; i++) {
        const seg = ord.slice(i, i + len);
        const rest = [...ord.slice(0, i), ...ord.slice(i + len)];
        const gain = D(ord[i - 1], ord[i]) + D(ord[i + len - 1], ord[i + len]) - D(ord[i - 1], ord[i + len]);
        let moved = false;
        for (let k = 0; k < rest.length - 1 && !moved; k++) {
          if (k === i - 1) continue;
          for (const s of [seg, [...seg].reverse()]) {
            if (D(rest[k], s[0]) + D(s[s.length - 1], rest[k + 1]) - D(rest[k], rest[k + 1]) < gain - 1) {
              ord = [...rest.slice(0, k + 1), ...s, ...rest.slice(k + 1)];
              moved = better = true;
              break;
            }
          }
        }
      }
    }
  }
  const saved = before - total(ord);
  if (saved < 40000 || saved < before * 0.08) return 0;
  // day ends: the last point of each day except the final one
  const ends = new Set(points.map((p, i) => (i < n - 1 && points[i + 1].day !== p.day ? i : -1)).filter((i) => i >= 0));
  const next = ord.map((i) => points[i]);
  let day = 1;
  next.forEach((p, k) => {
    p.day = day;
    if (ends.has(ord[k]) && k < n - 1) day++;
  });
  // a via point now right next to a stop in the same place (Banff the via and Banff the overnight) goes
  for (let k = next.length - 2; k >= 0; k--) {
    const a = next[k];
    const b = next[k + 1];
    if (haversine([a.lng, a.lat], [b.lng, b.lat]) < 2000 && (isVia(a) || isVia(b))) next.splice(isVia(a) ? k : k + 1, 1);
  }
  points.splice(0, n, ...next);
  return saved;
}

// After the days change shape (reordering, restoring a version), keep plan.days in step: each day's overnight is
// where it now ends, and a title that no longer fits (or every title, with retitle) becomes "Start to End".
function syncDayNames(retitle = false) {
  if (!plan) return;
  const groups = dayGroups();
  plan.days = groups.map((g, gi) => {
    const old = (plan.days || []).find((d) => Number(d.day) === g.day) || {};
    const end = stops[g.items.at(-1)]?.name || "";
    const start = gi ? stops[groups[gi - 1].items.at(-1)]?.name || "" : stops[g.items[0]]?.name || "";
    const same = !retitle && old.overnight && shortName(old.overnight) === shortName(end);
    return { ...old, day: g.day, overnight: end, title: same ? old.title : `${shortName(start)} to ${shortName(end)}` };
  });
}
// After reordering, the AI's day numbers on the featured roads are out of date. Once the route is measured, each road
// belongs to the days that drive at least 5 km of it. Until then (plan.syncRoads) the old days stay.
function syncRoadDays() {
  if (!plan) return;
  if (!routes.scenic) {
    plan.syncRoads = true;
    return;
  }
  delete plan.syncRoads;
  const legs = legsByEnd(routes.scenic);
  const groups = dayGroups();
  for (const r of plan.roads || []) {
    const days = groups
      .filter((g) => g.items.flatMap((i) => legs.get(i)?.roads || []).filter((s) => matchRoad(s, [r])).reduce((a, s) => a + s.distance_m, 0) >= 5000)
      .map((g) => g.day);
    if (days.length) r.days = days;
  }
}

// How much shorter the trip would be with its stops reordered (meters, 0 if not worth it). Doesn't change anything.
function orderFixPreview() {
  if (stops.length < 4) return 0;
  return fixOrder(stops.map((s) => ({ ...s })));
}

// "Fix backtracking" on the trip page: reorder, reroute, and rewrite the day guides for the new days.
async function applyOrderFix() {
  if (progress && !progress.error) return;
  snapshotVersion("Reordered the stops");
  const copy = stops.map((s) => ({ ...s }));
  const saved = fixOrder(copy);
  if (!saved) return;
  stops.length = 0;
  stops.push(...copy);
  normalizeDays();
  syncDayNames(true);
  if (plan) plan.syncRoads = true;
  trip.edits = [...(trip.edits || []), { text: `Reordered the stops to avoid backtracking (${fmtMi(saved)} shorter)`, at: new Date().toISOString() }];
  clearRoutes();
  renderStops();
  if (!(await findRoutes({ fit: false }))) return;
  if (plan) await writeDetails();
}

// Geography check on the AI's points (small models get this wrong): drops a stop that repeats the one before it
// (like the previous night's town listed again as the next day's start), and a via point that would add a big
// detour between its neighbours. Changes `points` in place and returns the names it removed.
function dropDetours(points) {
  const removed = [];
  for (let i = 1; i < points.length; i++) {
    // the same overnight town two days running is a rest day (or a day of exploring there), not a duplicate
    const restDay = points[i].day !== points[i - 1].day && !isVia(points[i]) && !isVia(points[i - 1]);
    if (!restDay && haversine([points[i - 1].lng, points[i - 1].lat], [points[i].lng, points[i].lat]) < 2000) {
      removed.push(points[i].name);
      points.splice(i--, 1);
    }
  }
  for (let i = 1; i < points.length - 1; i++) {
    if (!isVia(points[i])) continue;
    const at = (p) => [p.lng, p.lat];
    const direct = haversine(at(points[i - 1]), at(points[i + 1]));
    const via = haversine(at(points[i - 1]), at(points[i])) + haversine(at(points[i]), at(points[i + 1]));
    if (via - direct > Math.max(60000, direct * 0.5)) {
      removed.push(points[i].name);
      points.splice(i--, 1);
    }
  }
  return removed;
}

// Which AI plans trips (from /api/status), for the progress text.
let aiInfo = null;
fetch("/api/status")
  .then((r) => r.json())
  .then((s) => (aiInfo = s.ai))
  .catch(() => {});
function aiLabel() {
  if (aiInfo?.provider === "local") {
    const name = /qwen/i.test(aiInfo.model) ? "Qwen3" : "The local model";
    return aiInfo.webSearch
      ? `${name} on your GPU is searching road trip forums and picking scenic byways`
      : `${name} on your GPU is picking scenic byways`;
  }
  if (aiInfo?.provider === "claude") {
    const name = /haiku/.test(aiInfo.model) ? "Claude Haiku" : /sonnet/.test(aiInfo.model) ? "Claude Sonnet" : "Claude";
    return aiInfo.webSearch
      ? `${name} is reading road trip forums and picking roads from 184 scenic byways`
      : `${name} is picking roads from 184 scenic byways`;
  }
  return "Choosing roads from 184 designated scenic byways";
}

// Web pages Claude read while planning, shown as sources at the end of the itinerary.
function addSources(list) {
  if (!plan || !list?.length) return;
  plan.sources ||= [];
  const have = new Set(plan.sources.map((s) => s.url));
  for (const s of list) {
    if (s?.url && !have.has(s.url) && plan.sources.length < 40) {
      plan.sources.push({ url: s.url, title: s.title || s.url });
      have.add(s.url);
    }
  }
}

function mergeDetails(d) {
  for (const x of d.days || []) {
    const day = plan.days.find((y) => Number(y.day) === Number(x.day));
    if (day) Object.assign(day, { summary: x.summary, stay: x.stay || day.stay || "", price: x.price || day.price || "" });
  }
  const norm = (s) => String(s || "").toLowerCase().trim();
  for (const x of d.roads || []) {
    const road = plan.roads.find((r) => norm(r.name) === norm(x.name)) || plan.roads.find((r) => r.ref && norm(r.ref) === norm(x.ref));
    if (road) Object.assign(road, { why: x.why, drive: x.drive, tips: x.tips, wiki: x.wiki || road.wiki });
  }
  plan.spots = (d.spots || []).map((s) => ({ ...s, day: Number(s.day) || 1, info: null }));
}

// The stops on a road's days, as [[lng, lat], ...] (photos of the road must be from around there), and their names
// as context for photos without a location.
const roadStops = (r) => {
  const days = new Set((r.days || []).map(Number));
  return stops.filter((s) => !days.size || days.has(s.day)).slice(0, 40);
};
const roadNear = (r) => roadStops(r).map((s) => [s.lng, s.lat]);
const placesText = (list) => [...new Set(list.map((s) => s.name))].join("; ").slice(0, 500);

// Wikipedia articles and photos for roads and spots, and coordinates for the spots.
async function enrichPlan() {
  if (!plan) return;
  const around = (day) => stops.filter((s) => s.day === day || s.day === day - 1 || s.day === day + 1);
  const near = (day) => around(day).map((s) => [s.lng, s.lat]);
  const roads = plan.roads.map((r, i) => ({
    key: `r${i}`,
    name: r.ref ? `${r.name} ${r.ref}` : r.name,
    photo: r.name, // Commons photo search works better with the plain name
    wiki: r.wiki || r.official?.wiki || "",
    near: roadNear(r),
    ctx: placesText(roadStops(r)),
  }));
  const spots = plan.spots.map((s, i) => ({ key: `s${i}`, name: s.name, wiki: s.wiki || "", near: near(s.day), ctx: placesText(around(s.day)) }));
  const out = await api("/api/enrich", { roads, spots });
  // Keep what an earlier lookup found when this one came back empty (Wikimedia may be rate limiting).
  const merge = (old, next) => {
    if (!next) return old || null;
    const m = { ...(old || {}) };
    for (const [k, v] of Object.entries(next)) if (v != null && v !== "") m[k] = v;
    return m;
  };
  plan.roads.forEach((r, i) => (r.info = merge(r.info, out.roads[`r${i}`])));
  plan.spots.forEach((s, i) => (s.info = merge(s.info, out.spots[`s${i}`])));
}

const missingPhotos = () =>
  plan ? [...(plan.spots || []), ...(plan.roads || [])].filter((x) => !x.info?.image).length : 0;

async function refreshPhotos() {
  setStatus("Looking for the missing photos...");
  try {
    await enrichPlan();
    const left = missingPhotos();
    setStatus(left ? `${left} still without a photo. Wikipedia may be busy, try again in a minute.` : "Photos updated.");
  } catch (e) {
    setStatus(e.message);
  }
  scheduleSave();
  renderSpotMarkers();
  renderItinerary();
}

async function planTrip(prompt, settings) {
  if (READONLY || (progress && !progress.error)) return;
  await flushSave();
  if (stops.length || plan) {
    resetTrip();
    trip = { id: newId(), name: DEFAULT_NAME, customName: false, saved: false, prompt, edits: [], settings: {}, versions: [], notes: null };
    $("trip-name").value = trip.name;
  }
  trip.prompt = prompt;
  if (settings) {
    trip.settings = { ...settings };
    rememberSettings(tripSettings());
  }
  setView("itinerary");
  progressStart([
    ["route", "Planning the route"],
    ["places", "Placing stops on the map"],
    ["drive", "Measuring every day's drive"],
    ["details", "Writing the day guides"],
    ["photos", "Finding photos and articles"],
  ]);
  progress.retry = () => planTrip(prompt, settings);
  try {
    progressSet("route", "doing", aiLabel());
    const first = await planStream({ prompt, settings: tripSettings() });
    let skel = first.plan;
    progressSet("route", "done", `${skel.days.length} days, ${skel.roads.length} featured roads`);
    let detailsP = requestDetails(prompt, skel);
    progressSet("details", "doing", "Runs alongside the next steps");

    const placed = await placePoints(skel);
    addSources(first.sources);
    // the order fix moved days around, so the day guides being written no longer fit
    if (placed.reordered) detailsP = requestDetails(prompt, skeletonOf());
    progressSet("drive", "doing", "Routing with OpenRouteService");
    if (!(await findRoutes({ fit: false }))) throw new Error($("status").textContent || "Routing failed.");

    // Up to two rounds of "these days are too long", while each round helps (fewer long days, or the longest shorter).
    const worst = () => Math.max(0, ...dayGroups().map((g) => dayStats(g, "scenic")?.dur || 0));
    // moving the overnights along the same route often fixes it with no AI request at all
    if (longDays().length && balanceDays()) {
      progressSet("drive", "doing", "Moved the overnights so no day runs long");
      detailsP = requestDetails(prompt, skeletonOf());
    }
    for (let round = 0, long = longDays(); long.length && round < 2; round++) {
      const before = { n: long.length, worst: worst() };
      progressSet("drive", "doing", `Day ${long.join(", ")} ran over ${tripSettings().maxHours} hours, asking the AI to rebalance`);
      // The guides being written are for the old days and get redone after this, and two answers at once
      // halve the local model's speed, so stop them.
      detailsCtl?.abort();
      progressSet("details", "todo", "Waits for the rebalanced days");
      const dayHours = dayGroups().map((g) => (dayStats(g, "scenic")?.dur || 0) / 3600);
      skel = (await planStream({ prompt, current: skeletonOf(), dayHours, settings: tripSettings(), states: tripStates() }, "drive")).plan;
      detailsP = requestDetails(prompt, skel);
      progressSet("details", "doing", "Rewriting for the rebalanced days");
      if ((await placePoints(skel)).reordered) detailsP = requestDetails(prompt, skeletonOf());
      await findRoutes({ fit: false });
      long = longDays();
      if (long.length >= before.n && worst() >= before.worst - 600) break; // no better: stop asking
    }
    const total = routes.scenic;
    progressSet("drive", "done", total ? `${fmtMi(total.distance_m)}, ${fmtDur(total.duration_s)} of driving` : "");

    const d = await detailsP;
    if (d.error) progressSet("details", "error", d.error.message);
    else {
      mergeDetails(d.details);
      addSources(d.sources);
      progressSet("details", "done", `${plan.spots.length} spots along the way`);
    }

    progressSet("photos", "doing", "Wikipedia and Wikimedia Commons");
    try {
      await enrichPlan();
      progressSet("photos", "done");
    } catch (e) {
      progressSet("photos", "error", e.message);
    }
    progress = null;
    scheduleSave();
    renderSpotMarkers();
    renderItinerary();
  } catch (e) {
    progress.error = e.message;
    renderItinerary();
  }
}

// Change an existing plan with the AI, in place (liveRevise in features.js shows it in the bar at the bottom). Used for:
//   fixing long days     { dayHours, nightDays }
//   the traveler's notes { feedback: "swap day 2 for the Adirondacks" }
//   the road picker      { roadEdits: { add: [{ name, ref, states, why }], remove: [names] } }
//   new trip options and seasonal closures (feedback written by the app)
// Each change is recorded in trip.edits, shown under the original request.
const revisePlan = (opts) => liveRevise(opts);
// ---------- making the route drive a road (doesn't rely on the AI following instructions) ----------

// Meters of the scenic route that run on road r ({ name, ref }).
function metersOnRoad(r) {
  if (!routes.scenic) return 0;
  let m = 0;
  for (const g of dayGroups()) for (const s of daySegments(g)) if (matchRoad(s, [r])) m += s.distance_m;
  return m;
}

// Insert points along a road (in road order) into the trip where they add the least straight-line detour,
// trying both directions. Returns the day they landed in.
function insertRoadPoints(pts, r) {
  const at = (p) => [p.lng, p.lat];
  let best = null;
  for (const order of [pts, [...pts].reverse()]) {
    for (let i = 0; i < stops.length - 1; i++) {
      const a = at(stops[i]);
      const b = at(stops[i + 1]);
      let cost = haversine(a, at(order[0])) + haversine(at(order[order.length - 1]), b) - haversine(a, b);
      for (let k = 0; k + 1 < order.length; k++) cost += haversine(at(order[k]), at(order[k + 1]));
      if (!best || cost < best.cost) best = { cost, i, order };
    }
  }
  if (!best) return null;
  const day = stops[best.i + 1].day; // the leg into the next point belongs to that point's day
  const vias = best.order.map((p) => ({ name: p.name, lng: p.lng, lat: p.lat, kind: "via", day, road: r.name, note: `On ${r.name}` }));
  stops.splice(best.i + 1, 0, ...vias);
  return day;
}

// For each road the route doesn't drive yet: find points on it and add them as via points.
// Returns the names of the roads it added. Call findRoutes() afterwards.
async function enforceRoads(roads) {
  const added = [];
  for (const r of roads) {
    if (metersOnRoad(r) >= 8047) continue; // already drives 5+ miles of it
    let pts = [];
    try {
      pts = (await api("/api/road-points", {
        name: r.name, ref: r.ref, states: [].concat(r.states || r.official?.states || tripStates()), near: stops.map((s) => [s.lng, s.lat]),
        osm: r.osm || r.official?.osm || "",
      })).points || [];
    } catch {
      pts = [];
    }
    if (!pts.length) continue;
    const day = insertRoadPoints(pts, r);
    if (!plan.roads.some((x) => sameRoad(x.name, r.name))) {
      plan.roads.push({
        name: r.name, ref: r.ref || "", byway: "", days: [day], why: r.why || "",
        segment: `${shortName(pts[0].name)} to ${shortName(pts[pts.length - 1].name)}`,
      });
    }
    added.push(r.name);
  }
  return added;
}

// "Route through it" on a road card: add the road's points and reroute, without replanning the whole trip.
async function routeThroughRoad(r) {
  if (progress && !progress.error) return;
  setStatus(`Finding points on ${r.name}...`);
  const added = await enforceRoads([r]);
  if (!added.length) return setStatus(`Couldn't place ${r.name} on the map. Try asking for it in "Ask for a change".`);
  setStatus("Rerouting...");
  if (!(await findRoutes({ fit: false }))) return; // findRoutes already shows why
  trip.edits = [...(trip.edits || []), { text: `Routed through ${r.name}`, at: new Date().toISOString() }];
  scheduleSave();
  renderItinerary();
  const mi = Math.round(metersOnRoad(r) / 1609);
  setStatus(
    mi
      ? `The route now drives ${mi} mi of ${r.name}.`
      : `The router can't drive ${r.name} (it may be private or a toll road), so the route goes as close as it can.`
  );
}

const roadEditText = (e) =>
  e
    ? [
        e.add?.length ? `Added ${e.add.map((r) => r.name).join(", ")}` : "",
        e.remove?.length ? `Removed ${e.remove.join(", ")}` : "",
      ].filter(Boolean).join(". ")
    : "";

function fixLongDays() {
  if (balanceLive()) return;
  const dayHours = dayGroups().map((g) => (dayStats(g, "scenic")?.dur || 0) / 3600);
  // with "no night driving", days that arrive after dark count as too long too
  const nightDays = tripSettings().noNight ? afterDarkDays() : [];
  return revisePlan({ dayHours, nightDays, title: "Rebalancing the days", note: "Sending the measured drive times to the AI" });
}
$("fix-btn").onclick = fixLongDays;

function updateFix() {
  const groups = dayGroups();
  $("fix-btn").hidden = READONLY || !(
    routes[selected] && groups.length > 1 && groups.some((g) => (dayStats(g)?.dur || 0) > longDayS())
  );
}

// ---------- routes ----------

// isStyleLoaded() also waits for tiles, so it can still be false inside style.load. Track the style alone.
let styleReady = false;
let highlighted = null; // day number drawn with a glow on the map

function addRouteLayers() {
  if (!styleReady) return; // the style.load handler will call this again
  for (const mode of MODES) {
    const r = routes[mode];
    if (!r) continue;
    const id = `route-${mode}`;
    if (!map.getSource(id)) {
      map.addSource(id, { type: "geojson", data: { type: "Feature", geometry: r.geometry } });
    }
    const layout = { "line-cap": "round", "line-join": "round" };
    if (!map.getLayer(`${id}-casing`)) {
      map.addLayer({ id: `${id}-casing`, type: "line", source: id, layout, paint: { "line-color": "#ffffff", "line-width": 10 } });
    }
    if (!map.getLayer(`${id}-line`)) {
      map.addLayer({ id: `${id}-line`, type: "line", source: id, layout, paint: { "line-color": BLUE, "line-width": 6 } });
    }
  }
  styleRoutes();
  drawHighlight();
}

function styleRoutes() {
  const order = [...MODES].sort((a) => (a === selected ? 1 : -1));
  for (const mode of order) {
    if (!map.getLayer(`route-${mode}-line`)) continue;
    const sel = mode === selected;
    map.setPaintProperty(`route-${mode}-casing`, "line-color", sel ? "#ffffff" : "#3a3a3c");
    map.setPaintProperty(`route-${mode}-casing`, "line-width", sel ? 11 : 8);
    map.setPaintProperty(`route-${mode}-casing`, "line-opacity", sel ? 0.95 : 0.8);
    map.setPaintProperty(`route-${mode}-line`, "line-color", sel ? BLUE : GREY);
    map.setPaintProperty(`route-${mode}-line`, "line-width", sel ? 7 : 5);
    map.moveLayer(`route-${mode}-casing`);
    map.moveLayer(`route-${mode}-line`);
  }
}

map.on("style.load", () => {
  styleReady = true;
  drawCoverage();
  addRouteLayers();
});

// ---------- coverage: the regions with a road catalog; everywhere else is greyed out on the map ----------
// public/coverage.json is built by tools/build-coverage.mjs: { covered: FeatureCollection (one shape per country,
// properties.country), mask: the world minus those shapes }.
let coverage = null;
fetch("/coverage.json")
  .then((r) => r.json())
  .then((c) => {
    coverage = c;
    drawCoverage();
    renderItinerary();
  })
  .catch(() => {});

function drawCoverage() {
  if (!styleReady || !coverage) return;
  const dark = theme === "dark";
  if (!map.getSource("coverage-mask")) map.addSource("coverage-mask", { type: "geojson", data: coverage.mask });
  if (!map.getLayer("coverage-mask")) {
    // under the route lines, which are added after this
    map.addLayer({ id: "coverage-mask", type: "fill", source: "coverage-mask",
      // hidden on the home globe (home.js shows it again for the map view)
      layout: { visibility: document.body.dataset.view === "home" ? "none" : "visible" },
      // a lighter grey on the dark map, so it reads as "greyed out" rather than just darker
      paint: { "fill-color": dark ? "#48484a" : "#8e8e93", "fill-opacity": dark ? 0.6 : 0.4 } });
  }
  if (!map.getSource("coverage-edge")) map.addSource("coverage-edge", { type: "geojson", data: coverage.covered });
  if (!map.getLayer("coverage-edge")) {
    map.addLayer({ id: "coverage-edge", type: "line", source: "coverage-edge",
      paint: { "line-color": "#30d1c6", "line-opacity": 0.35, "line-width": 1 } });
  }
}

// Ray casting over a polygon's rings: inside the outer ring and not inside a hole.
function inRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function inGeometry(pt, g) {
  const polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
  return polys.some((rings) => inRing(pt, rings[0]) && !rings.slice(1).some((h) => inRing(pt, h)));
}
// The covered country a point is in ("US", "CA", "AU", "NZ"...), or null when it's outside the covered areas.
// The outlines are simplified, so a town right on the coast (Greymouth) can fall just outside: points within ~5 km of
// a covered area count as inside.
const coverMemo = new Map();
function coverageCountry(p) {
  if (!coverage) return null;
  const key = `${p.lng.toFixed(3)},${p.lat.toFixed(3)}`;
  if (coverMemo.has(key)) return coverMemo.get(key);
  const at = (pt) => coverage.covered.features.find((x) => inGeometry(pt, x.geometry))?.properties.country || null;
  let c = at([p.lng, p.lat]);
  if (!c) {
    const dy = 0.045;
    const dx = 0.045 / Math.cos((p.lat * Math.PI) / 180);
    for (const [ox, oy] of [[dx, 0], [-dx, 0], [0, dy], [0, -dy], [dx, dy], [-dx, dy], [dx, -dy], [-dx, -dy]]) {
      if ((c = at([p.lng + ox, p.lat + oy]))) break;
    }
  }
  coverMemo.set(key, c);
  return c;
}
// Stops outside the covered areas (null while coverage.json is still loading).
const uncoveredStops = () => (coverage ? stops.filter((s) => !isVia(s) && !coverageCountry(s)) : []);

// Geometry of one day on the scenic route: { coords, cum } with cumulative meters along it.
function dayLine(day) {
  const r = routes.scenic;
  const g = dayGroups().find((x) => x.day === day);
  if (!r || !g) return null;
  const legs = legsByEnd(r);
  const dl = g.items.map((i) => legs.get(i)).filter(Boolean);
  if (!dl.length || dl[0].from == null) return null;
  const coords = r.geometry.coordinates.slice(dl[0].from, dl[dl.length - 1].to + 1);
  const cum = [0];
  for (let k = 1; k < coords.length; k++) cum.push(cum[k - 1] + haversine(coords[k - 1], coords[k]));
  return { coords, cum };
}

function haversine(a, b) {
  const R = 6371000;
  const r = Math.PI / 180;
  const x =
    Math.sin(((b[1] - a[1]) * r) / 2) ** 2 +
    Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// A soft glow under one day of the route, shown when you open a day on the map.
function drawHighlight() {
  if (!styleReady) return;
  const line = highlighted != null ? dayLine(highlighted) : null;
  const data = line ? { type: "Feature", geometry: { type: "LineString", coordinates: line.coords } } : { type: "FeatureCollection", features: [] };
  if (map.getSource("day-hl")) map.getSource("day-hl").setData(data);
  else {
    map.addSource("day-hl", { type: "geojson", data });
    map.addLayer(
      { id: "day-hl", type: "line", source: "day-hl", layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#30d1c6", "line-width": 18, "line-opacity": 0.35, "line-blur": 3 } },
      map.getLayer("route-scenic-casing") ? "route-scenic-casing" : undefined
    );
  }
}

function showDayOnMap(day) {
  highlighted = day;
  setView("map");
  drawHighlight();
  renderMapProfile();
  const line = dayLine(day);
  const b = new maplibregl.LngLatBounds();
  if (line) line.coords.forEach((c) => b.extend(c));
  else stops.filter((s) => s.day === day).forEach((s) => b.extend([s.lng, s.lat]));
  if (!b.isEmpty()) map.fitBounds(b, { padding: pad(), maxZoom: 11 });
}

// Open the map at a point (from the day timeline).
function showPointOnMap(lng, lat, day) {
  if (day != null) highlighted = day;
  setView("map");
  drawHighlight();
  renderMapProfile();
  map.flyTo({ center: [lng, lat], zoom: 11, padding: pad() });
}

// The states a trip passes through, from its point names ("Ouray, Colorado" or "Ouray, CO").
const STATE_NAMES = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee",
  TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
const AU_STATES = {
  NSW: "New South Wales", VIC: "Victoria", ACT: "Australian Capital Territory", QLD: "Queensland",
  SA: "South Australia", WA: "Western Australia", TAS: "Tasmania", NT: "Northern Territory",
};
const CA_PROVINCES = {
  BC: "British Columbia", AB: "Alberta", SK: "Saskatchewan", MB: "Manitoba", ON: "Ontario", QC: "Quebec",
  NB: "New Brunswick", NS: "Nova Scotia", PE: "Prince Edward Island", NL: "Newfoundland and Labrador",
  YT: "Yukon", NT: "Northwest Territories", NU: "Nunavut",
};
// Outside the US, Canada and Australia the road lists go by country ("New Zealand", "Switzerland").
const COUNTRY_NAME = {
  NZ: "New Zealand", GB: "United Kingdom", CH: "Switzerland", AT: "Austria", LI: "Liechtenstein", IT: "Italy",
  FR: "France", DE: "Germany",
};
function tripStates() {
  const out = new Set();
  for (const s of stops) {
    const cc = countryOf(s);
    if (COUNTRY_NAME[cc]) {
      out.add(COUNTRY_NAME[cc]);
      continue;
    }
    // Australian points use Australian states ("WA" is Western Australia there, Washington in the US)
    // (and Canadian points Canadian provinces)
    const table = isAU(s) ? AU_STATES : isCA(s) ? CA_PROVINCES : STATE_NAMES;
    // "Québec" and "Quebec" are the same
    const key = (x) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    // "Lorne, Victoria, Australia" or "Ouray, CO": the state is the last part that names one
    for (const part of s.name.split(",").map((x) => x.trim()).reverse()) {
      const hit = table[part.toUpperCase()] || Object.values(table).find((x) => key(x) === key(part));
      if (hit) {
        out.add(hit);
        break;
      }
    }
  }
  return [...out];
}

function showSpotOnMap(i) {
  const s = plan?.spots?.[i];
  if (!s?.info?.lat) return;
  setView("map");
  map.flyTo({ center: [s.info.lng, s.info.lat], zoom: 11, padding: pad() });
  spotMarkers[i]?.togglePopup();
}

// Time pills: one per day on the selected route, plus one on the other route.
function addPill(lngLat, html, mode, active, label) {
  const el = document.createElement("button");
  el.className = "pill" + (active ? " active" : " alt");
  el.innerHTML = html;
  el.setAttribute("aria-label", label);
  el.onclick = () => select(mode);
  pills.push(new maplibregl.Marker({ element: el }).setLngLat(lngLat).addTo(map));
}

function renderPills() {
  pills.forEach((p) => p.remove());
  pills = [];
  for (const mode of MODES) {
    const r = routes[mode];
    if (!r) continue;
    if (mode === selected) {
      const groups = dayGroups();
      const legs = legsByEnd(r);
      for (const g of groups) {
        const dayLegs = g.items.map((i) => legs.get(i)).filter(Boolean);
        if (!dayLegs.length) continue;
        const dur = dayLegs.reduce((s, l) => s + l.duration_s, 0);
        const multi = groups.length > 1;
        addPill(
          dayLegs[Math.floor(dayLegs.length / 2)].mid,
          multi ? `<b>D${g.day}</b> ${fmtShort(dur)}` : fmtShort(dur),
          mode,
          true,
          multi ? `Day ${g.day}, ${fmtDur(dur)}` : fmtDur(dur)
        );
      }
    } else {
      const l = r.legs[Math.floor(r.legs.length / 2)];
      const at = l ? l.mid : r.geometry.coordinates[Math.floor(r.geometry.coordinates.length / 2)];
      const name = mode === "scenic" ? "Scenic" : "Fastest";
      addPill(at, `${name} ${fmtShort(r.duration_s)}`, mode, false, `Switch to ${name.toLowerCase()} route, ${fmtDur(r.duration_s)}`);
    }
  }
  declutter();
}

// Hide pills that would overlap a stop pin or another pill, so a zoomed-out map stays readable.
// Earlier pills win, and everything is re-checked as the map moves.
let declutterQueued = false;
function declutter() {
  if (declutterQueued) return;
  declutterQueued = true;
  requestAnimationFrame(() => {
    declutterQueued = false;
    const placed = [];
    const overlaps = (r) => placed.some((p) => !(r.right + 6 < p.left || r.left - 6 > p.right || r.bottom + 4 < p.top || r.top - 4 > p.bottom));
    for (const m of pins) {
      const el = m.getElement();
      if (el.classList.contains("pin")) placed.push(el.getBoundingClientRect());
    }
    for (const m of pills) {
      const el = m.getElement();
      const r = el.getBoundingClientRect();
      const hide = overlaps(r);
      el.classList.toggle("hidden-pill", hide);
      if (!hide) placed.push(r);
    }
  });
}
map.on("move", declutter);

// Spot markers with a small icon for each type; click for a popup.
function renderSpotMarkers() {
  spotMarkers.forEach((m) => m?.remove()); // null where a spot has no coordinates
  spotMarkers = [];
  (plan?.spots || []).forEach((s, i) => {
    if (s.info?.lat == null) return spotMarkers.push(null);
    const el = document.createElement("button");
    el.className = `spot-pin t-${s.type}`;
    el.innerHTML = icon(spotType(s.type).icon, 14);
    el.setAttribute("aria-label", s.name);
    const html = `${s.info.image ? `<img src="${esc(s.info.image)}" alt="">` : ""}
      <div class="pop-body"><small>Day ${s.day} · ${esc(spotType(s.type).label)}</small><b>${esc(s.name)}</b><p>${esc(s.why || "")}</p></div>`;
    const popup = new maplibregl.Popup({ offset: 14, maxWidth: "280px", className: "spot-pop" }).setHTML(html);
    spotMarkers.push(new maplibregl.Marker({ element: el }).setLngLat([s.info.lng, s.info.lat]).setPopup(popup).addTo(map));
  });
}

function updateOptions() {
  const fast = routes.fastest;
  for (const mode of MODES) {
    const r = routes[mode];
    const el = $(`opt-${mode}`);
    el.classList.toggle("selected", mode === selected);
    if (!r) continue;
    el.querySelector(".time").textContent = fmtDur(r.duration_s);
    let meta = fmtMi(r.distance_m);
    if (mode === "scenic" && fast) {
      const extra = r.duration_s - fast.duration_s;
      if (extra >= 60) meta += `, ${fmtDur(extra)} longer`;
      else meta += ", same time as fastest";
    }
    el.querySelector(".meta").textContent = meta;
  }
}

function showRoutes() {
  addRouteLayers();
  renderPills();
  renderStops();
  updateOptions();
  updateFix();
  drawAlongLayer();
  $("options").hidden = false;
  $("gpx-btn").hidden = false;
}

function select(mode) {
  selected = mode;
  styleRoutes();
  renderPills();
  renderStops();
  updateOptions();
  updateFix();
  scheduleSave();
  renderItinerary();
}
document.querySelectorAll(".option").forEach((el) => (el.onclick = () => select(el.dataset.mode)));

function clearRoutes() {
  for (const mode of MODES) {
    for (const suffix of ["casing", "line"]) {
      const id = `route-${mode}-${suffix}`;
      if (map.getLayer(id)) map.removeLayer(id);
    }
    if (map.getSource(`route-${mode}`)) map.removeSource(`route-${mode}`);
    routes[mode] = null;
  }
  highlighted = null;
  drawHighlight();
  if (typeof renderMapProfile === "function") renderMapProfile();
  pills.forEach((p) => p.remove());
  pills = [];
  $("options").hidden = true;
  $("gpx-btn").hidden = true;
  $("fix-btn").hidden = true;
}

async function findRoutes({ fit = true } = {}) {
  if (stops.length < 2) {
    setStatus("Add at least two stops to find routes.");
    return false;
  }
  try {
    setStatus("Finding routes...");
    const notes = new Set();
    // A via point the router can't reach (a private toll road's summit, a spot in the woods) would sink the whole
    // route. Drop that via point and try again; a real stop that can't be reached is still an error.
    const dropped = [];
    for (let attempt = 0; ; attempt++) {
      clearRoutes();
      let failed = null;
      for (const mode of MODES) {
        const idx = routeIndexes(mode);
        const coordinates = idx.map((i) => [stops[i].lng, stops[i].lat]);
        const r = await fetch("/api/route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ coordinates, mode }),
        });
        const data = await r.json();
        if (!r.ok) {
          failed = { message: data.error || "Routing failed.", idx };
          break;
        }
        routes[mode] = { ...data, idx };
        if (data.note) notes.add(data.note);
      }
      if (!failed) break;
      // "coordinate 5" names the point; "between points 4 (...) and 5 (...)" (one of them on a road cut off from the
      // rest of the map, seen near Bryce Canyon) names two: drop whichever is a via, the later one first.
      const pair = failed.message.match(/between points (\d+) .*? and (\d+)/);
      const n = failed.message.match(/coordinate (\d+)/)?.[1];
      const cands = (pair ? [pair[2], pair[1]] : n != null ? [n] : []).map((k) => failed.idx[Number(k)]);
      const i = cands.find((k) => k != null && isVia(stops[k]));
      if (attempt >= 6) throw new Error(failed.message);
      if (i == null) {
        // Two stops the router can't connect (Bryce Canyon Lodge sits on roads the map has cut off): move one of them
        // a little toward the other, onto a road it can reach, once.
        if (!pair || cands.some((k) => k == null)) throw new Error(failed.message);
        const [a, b] = cands;
        let moved = false;
        for (const [k, other] of [[a, b], [b, a]]) {
          if (stops[k].moved) continue;
          const to = await reachableNear(stops[k], stops[other]);
          if (!to) continue;
          stops[k].lng = to.lng;
          stops[k].lat = to.lat;
          stops[k].moved = true;
          notes.add(`Moved ${stops[k].name.split(",")[0]} ${to.km} km to the nearest road the router can reach.`);
          moved = true;
          break;
        }
        if (!moved) throw new Error(failed.message);
        continue;
      }
      dropped.push(stops[i].name);
      stops.splice(i, 1);
    }
    if (dropped.length) notes.add(`Skipped ${dropped.join(", ")}: no drivable road there.`);
    selected = "scenic";
    if (plan?.syncRoads) syncRoadDays();
    showRoutes();
    if (fit) {
      const b = new maplibregl.LngLatBounds();
      for (const mode of MODES) routes[mode].geometry.coordinates.forEach((c) => b.extend(c));
      map.fitBounds(b, { padding: pad() });
    }
    setStatus([...notes].join(" "));
    scheduleSave();
    renderItinerary();
    return true;
  } catch (e) {
    setStatus(e.message);
    return false;
  }
}
$("route-btn").onclick = () => findRoutes();

// A point 1, 2, 4 or 8 km from `p` toward `from` that the router can reach from `from`, or null.
async function reachableNear(p, from) {
  const d = haversine([p.lng, p.lat], [from.lng, from.lat]);
  for (const km of [1, 2, 4, 8]) {
    if (km * 1000 >= d) break;
    const f = (km * 1000) / d;
    const c = { lng: p.lng + (from.lng - p.lng) * f, lat: p.lat + (from.lat - p.lat) * f, km };
    const r = await fetch("/api/route", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ coordinates: [[from.lng, from.lat], [c.lng, c.lat]], mode: "fastest" }),
    }).catch(() => null);
    if (r?.ok) return c;
  }
  return null;
}

// ---------- saving trips ----------

let saveTimer = null;
let saving = Promise.resolve();

function tripPayload() {
  const keep = (r) =>
    r && {
      engine: r.engine, geometry: r.geometry, distance_m: r.distance_m, duration_s: r.duration_s, highway_m: r.highway_m,
      ascent_m: r.ascent_m, descent_m: r.descent_m, toll_m: r.toll_m, ferry_m: r.ferry_m, unpaved_m: r.unpaved_m,
      legs: r.legs, idx: r.idx,
    };
  return {
    name: trip.name,
    prompt: trip.prompt || "",
    edits: trip.edits || [],
    settings: trip.settings || {},
    versions: trip.versions || [],
    notes: trip.notes || { text: "", items: [] },
    preset: !!trip.preset,
    mode: selected,
    stops: stops.map(({ name, lng, lat, note, photoQuery, kind, day, road, photos }) => ({ name, lng, lat, note, photoQuery, kind, day, road, photos })),
    routes: routes.scenic || routes.fastest ? { scenic: keep(routes.scenic), fastest: keep(routes.fastest) } : null,
    plan,
  };
}

function scheduleSave() {
  if (READONLY) return;
  // Don't save a blank trip nobody has touched yet.
  if (!trip.saved && !stops.length) return;
  clearTimeout(saveTimer);
  $("save-state").textContent = "Saving...";
  saveTimer = setTimeout(saveNow, 700);
}

async function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (READONLY || (!trip.saved && !stops.length)) return;
  const id = trip.id;
  const body = JSON.stringify(tripPayload());
  saving = saving.then(async () => {
    try {
      const r = await fetch(`/api/trips/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (!r.ok) throw new Error((await r.json()).error || "Save failed");
      if (trip.id === id) {
        trip.saved = true;
        $("save-state").textContent = "Saved";
      }
      store.set("lastTripId", id);
    } catch (e) {
      if (trip.id === id) $("save-state").textContent = `Not saved: ${e.message}. Is the server running?`;
    }
  });
  return saving;
}

async function flushSave() {
  if (saveTimer) await saveNow();
  await saving;
}

const newId = () =>
  (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

function resetTrip() {
  detailsCtl?.abort();
  clearRoutes();
  stops.length = 0;
  plan = null;
  renderSpotMarkers();
  selected = "scenic";
  setStatus("");
  $("save-state").textContent = "";
  tripChanged();
}

async function newTrip() {
  await flushSave();
  resetTrip();
  progress = null;
  trip = { id: newId(), name: DEFAULT_NAME, customName: false, saved: false, prompt: "", edits: [], settings: {}, versions: [], notes: null };
  $("trip-name").value = trip.name;
  renderStops();
  renderItinerary();
}

async function openTrip(id) {
  await flushSave();
  const r = await fetch(`/api/trips/${id}`);
  if (!r.ok) throw new Error((await r.json()).error || "Could not open that trip.");
  const t = await r.json();
  resetTrip();
  progress = null;
  trip = {
    id: t.id, name: t.name, customName: t.name !== DEFAULT_NAME && t.name !== t.plan?.title, saved: true,
    prompt: t.prompt || "", edits: t.edits || [], settings: t.settings || {}, versions: t.versions || [],
    notes: t.notes || null, preset: !!t.preset,
  };
  $("trip-name").value = t.name;
  t.stops.forEach((s) => {
    const p = { kind: "stop", road: "", ...s };
    // Trips from before 1.5 kept the day inside the note, like "Day 2: ..."
    if (!s.day) {
      const m = (p.note || "").match(/^Day (\d+):?\s*/);
      p.day = m ? Number(m[1]) : 1;
      if (m) p.note = p.note.slice(m[0].length);
    }
    stops.push(p);
  });
  normalizeDays();
  plan = t.plan || null;
  selected = t.mode || "scenic";
  if (!READONLY) store.set("lastTripId", t.id);
  const all = stops.map((_, i) => i);
  for (const mode of MODES) {
    const rt = t.routes?.[mode];
    if (rt && !rt.idx) rt.idx = all; // older saves routed through every point
  }
  const valid = (rt) =>
    rt && rt.geometry?.coordinates?.length > 1 && Array.isArray(rt.legs) && rt.legs.length === rt.idx.length - 1 &&
    rt.idx.every((i) => i < stops.length);
  if (valid(t.routes?.scenic) && valid(t.routes?.fastest)) {
    routes.scenic = t.routes.scenic;
    routes.fastest = t.routes.fastest;
    showRoutes();
  } else {
    renderStops();
  }
  renderSpotMarkers();
  fitStops();
  renderItinerary();
  $("save-state").textContent = "Saved";
}

$("trip-name").addEventListener("input", () => {
  trip.name = $("trip-name").value.trim() || DEFAULT_NAME;
  trip.customName = true;
  scheduleSave();
});
$("trip-name").addEventListener("keydown", (e) => e.key === "Enter" && e.target.blur());

// ---------- trips sheet ----------

function fmtWhen(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const days = Math.floor((Date.now() - d) / 86400000);
  if (days < 1) return `today at ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  if (days < 2) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return d.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}

async function renderTrips() {
  const ul = $("trips");
  ul.innerHTML = "";
  let list = [];
  try {
    const r = await fetch("/api/trips");
    list = (await r.json()).trips || [];
  } catch {
    $("trips-empty").textContent = "Could not load trips. Is the server running?";
    $("trips-empty").hidden = false;
    return;
  }
  $("trips-empty").hidden = list.length > 0;
  for (const t of list) {
    const li = document.createElement("li");
    li.className = "trip" + (t.id === trip.id ? " current" : "");

    const open = document.createElement("button");
    open.className = "trip-open";
    const b = document.createElement("b");
    b.textContent = t.name;
    const small = document.createElement("small");
    small.textContent = `${t.stopCount} ${t.stopCount === 1 ? "point" : "points"}, edited ${fmtWhen(t.updatedAt)}`;
    open.append(b, small);
    open.onclick = async () => {
      try {
        await openTrip(t.id);
        closeTrips();
      } catch (e) {
        $("trips-empty").textContent = e.message;
        $("trips-empty").hidden = false;
      }
    };

    const del = document.createElement("button");
    del.className = "trip-delete";
    del.innerHTML = icon("close", 16);
    del.setAttribute("aria-label", `Delete ${t.name}`);
    del.onclick = async () => {
      if (!confirm(`Delete "${t.name}"? This can't be undone.`)) return;
      await fetch(`/api/trips/${t.id}`, { method: "DELETE" });
      if (t.id === trip.id) {
        clearTimeout(saveTimer);
        saveTimer = null;
        await goHome();
      }
      renderTrips();
    };

    li.append(open, del);
    ul.appendChild(li);
  }
}

function closeTrips() {
  $("trips-sheet").hidden = true;
  $("trips-btn").focus();
}
$("trips-btn").onclick = async () => {
  await flushSave();
  $("trips-sheet").hidden = false;
  renderTrips();
  $("trips-done").focus();
};
$("trips-done").onclick = closeTrips;
$("trips-sheet").addEventListener("click", (e) => e.target === $("trips-sheet") && closeTrips());
addEventListener("keydown", (e) => e.key === "Escape" && !$("trips-sheet").hidden && closeTrips());
$("new-trip").onclick = async () => {
  await goHome();
  closeTrips();
};

// ---------- GPX export ----------

// One track per day (with elevation when the route has it), the stops and via points, and the plan's spots.
// Car navigation units and Garmin import this; most show each day as its own track.
function gpx(route, name) {
  const x = (t) => String(t ?? "").replace(/[<>&"]/g, "");
  const pt = (tag, [lng, lat, ele], inner = "") =>
    `<${tag} lat="${lat.toFixed(6)}" lon="${lng.toFixed(6)}">${ele != null ? `<ele>${Math.round(ele)}</ele>` : ""}${inner}</${tag}>`;
  const wpts = stops
    .map((s) => pt("wpt", [s.lng, s.lat], `<name>${x(s.name)}</name><desc>${x(`Day ${s.day}${s.note ? `. ${s.note}` : ""}`)}</desc><type>${isVia(s) ? "via" : "stop"}</type>`))
    .concat((plan?.spots || []).filter((s) => s.info?.lat != null)
      .map((s) => pt("wpt", [s.info.lng, s.info.lat], `<name>${x(s.name)}</name><desc>${x(s.why || "")}</desc><type>${x(s.type)}</type>`)))
    .join("");
  const coords = route.geometry.coordinates;
  const legs = legsByEnd(route);
  const tracks = dayGroups()
    .map((g) => {
      const dl = g.items.map((i) => legs.get(i)).filter(Boolean);
      if (!dl.length || dl[0].from == null) return "";
      const seg = coords.slice(dl[0].from, dl.at(-1).to + 1).map((c) => pt("trkpt", c)).join("");
      return `<trk><name>${x(`${name}, day ${g.day}`)}</name><trkseg>${seg}</trkseg></trk>`;
    })
    .join("");
  const all = `<trk><name>${x(name)}</name><trkseg>${coords.map((c) => pt("trkpt", c)).join("")}</trkseg></trk>`;
  return `<?xml version="1.0" encoding="UTF-8"?><gpx version="1.1" creator="Byway" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>${x(name)}</name></metadata>${wpts}${tracks || all}</gpx>`;
}

function downloadFile(text, filename, type) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const fileName = () => trip.name.replace(/[^\w -]+/g, "").trim() || "byway";

function exportGpx() {
  const route = routes[selected];
  if (!route) return setStatus("Find routes first.");
  downloadFile(gpx(route, `${trip.name} (${selected})`), `${fileName()}-${selected}.gpx`, "application/gpx+xml");
}
$("gpx-btn").onclick = exportGpx;

// Save before the tab closes, and reopen the last trip on load.
addEventListener("pagehide", () => {
  if (saveTimer && (trip.saved || stops.length)) {
    navigator.sendBeacon?.(
      `/api/trips/${trip.id}/beacon`,
      new Blob([JSON.stringify(tripPayload())], { type: "application/json" })
    );
  }
});

// itinerary.js loads after this file, so start once everything is in place.
// ?trip=<id> opens that trip (a share link adds &view=read for a read-only copy).
// Without a link the app opens on the home globe with no trip selected (the last trip is one click away there).
addEventListener("DOMContentLoaded", async () => {
  if (READONLY) document.body.classList.add("readonly");
  const linked = new URLSearchParams(location.search).get("trip");
  if (linked) {
    setView("itinerary");
    try {
      await openTrip(linked);
      return;
    } catch {
      // fall through
    }
  }
  await newTrip();
  // batch mode (features.js) starts on its own screen
  setView(BATCH || READONLY ? "itinerary" : "home");
});
