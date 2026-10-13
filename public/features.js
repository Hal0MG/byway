// Trip features added in 1.12: trip options, seasonal roads, daylight and weather, elevation profiles and road ratings,
// fuel/charger gaps and sights along the route, 3D terrain and road flyovers, photo galleries, export and sharing,
// plan versions, notes and checklists, ready-made trips (presets and batch building), and the installable app.
// Loaded after app.js and before itinerary.js; uses their shared state (stops, routes, plan, trip).

// ---------- small helpers ----------

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const deg = Math.PI / 180;
function bearingOf(a, b) {
  const y = Math.sin((b[0] - a[0]) * deg) * Math.cos(b[1] * deg);
  const x = Math.cos(a[1] * deg) * Math.sin(b[1] * deg) - Math.sin(a[1] * deg) * Math.cos(b[1] * deg) * Math.cos((b[0] - a[0]) * deg);
  return (Math.atan2(y, x) / deg + 360) % 360;
}
// signed difference b - a in degrees, in -180..180
const angleDiff = (b, a) => ((b - a + 540) % 360) - 180;
// A cache tied to the current scenic route: cleared whenever the route object changes.
const routeMemo = { route: null, map: new Map() };
function memo(key, fn) {
  if (routeMemo.route !== routes.scenic) {
    routeMemo.route = routes.scenic;
    routeMemo.map = new Map();
  }
  if (!routeMemo.map.has(key)) routeMemo.map.set(key, fn());
  return routeMemo.map.get(key);
}
// Called when another trip opens or a new one starts: forget per-trip state.
function tripChanged() {
  wx.key = "";
  wx.results = null;
  alongState.loading = false;
  presetState.list = null; // reloaded when the start screen shows (a trip may have just become ready-made)
  closeOverlay();
}
function openSheet(html, cls = "") {
  closeOverlay();
  const el = document.createElement("div");
  el.className = "sheet-backdrop overlay";
  el.innerHTML = `<section class="sheet ${cls}" role="dialog" aria-modal="true" aria-labelledby="sheet-title">${html}</section>`;
  el.addEventListener("click", (e) => {
    if (e.target === el || e.target.closest("[data-close]")) closeOverlay();
  });
  document.body.appendChild(el);
  el.querySelector("button, input, textarea, select, a")?.focus();
  return el;
}
function closeOverlay() {
  document.querySelectorAll(".overlay").forEach((el) => el.remove());
}
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.querySelector(".overlay") && !document.querySelector(".lightbox")) closeOverlay();
});
// (a div, not a header: inside a dialog a <header> counts as a second page banner for screen readers)
const sheetHead = (title) => `<div class="sheet-head"><h2 id="sheet-title">${esc(title)}</h2><button class="icon-btn" data-close aria-label="Close">${icon("close", 20)}</button></div>`;

// ---------- trip options ----------

const STYLES_LIST = [
  ["coast", "Coast"], ["mountains", "Mountains"], ["twisty", "Twisty roads"], ["nocities", "Avoid big cities"],
  ["photo", "Photo spots"], ["easy", "Easy driving"], ["food", "Food stops"],
];
// The options form, on the start screen and in the trip's options sheet.
function optionsForm(s, { compact = false } = {}) {
  const hours = [4, 5, 6, 7, 7.5, 8, 9, 10, 12];
  return `<div class="options ${compact ? "compact" : ""}">
    <div class="opt-styles" role="group" aria-label="Trip style">
      ${STYLES_LIST.map(([k, label]) => `<button type="button" class="chip toggle ${s.styles?.includes(k) ? "on" : ""}" data-style="${k}" aria-pressed="${s.styles?.includes(k) ? "true" : "false"}">${esc(label)}</button>`).join("")}
    </div>
    <div class="opt-row">
      <label class="field"><span>${icon("calendar", 14)} Start date</span><input type="date" name="startDate" value="${esc(s.startDate || "")}"></label>
      <label class="field"><span>${icon("clock", 14)} Leave at</span><input type="time" name="startTime" value="${esc(s.startTime || "08:00")}"></label>
      <label class="field"><span>${icon("gauge", 14)} Max driving a day</span><select name="maxHours">
        ${hours.map((h) => `<option value="${h}" ${Number(s.maxHours) === h ? "selected" : ""}>${h} hours</option>`).join("")}</select></label>
    </div>
    <div class="opt-row">
      <label class="check"><input type="checkbox" name="loop" ${s.loop ? "checked" : ""}> Loop trip (end where you start)</label>
      <label class="check"><input type="checkbox" name="noNight" ${s.noNight ? "checked" : ""}> No driving after dark</label>
      <label class="check"><input type="checkbox" name="ev" ${s.ev ? "checked" : ""}> Electric car</label>
      <label class="field inline ev-range" ${s.ev ? "" : "hidden"}><span>Range</span><input type="number" name="evRange" min="100" max="1000" step="10" value="${esc(String(s.evRange || 400))}"> km</label>
    </div>
  </div>`;
}
function readOptions(root) {
  const val = (n) => root.querySelector(`[name="${n}"]`);
  return {
    startDate: val("startDate")?.value || "",
    startTime: val("startTime")?.value || "08:00",
    maxHours: Number(val("maxHours")?.value) || 7.5,
    loop: !!val("loop")?.checked,
    noNight: !!val("noNight")?.checked,
    ev: !!val("ev")?.checked,
    evRange: Number(val("evRange")?.value) || 400,
    styles: [...root.querySelectorAll("[data-style].on")].map((b) => b.dataset.style),
  };
}
// Chips toggle and the EV range shows with "Electric car", anywhere an options form is on screen.
document.addEventListener("click", (e) => {
  const chip = e.target.closest(".options [data-style]");
  if (chip) {
    chip.classList.toggle("on");
    chip.setAttribute("aria-pressed", String(chip.classList.contains("on")));
  }
});
document.addEventListener("change", (e) => {
  if (e.target.name === "ev") {
    const r = e.target.closest(".options")?.querySelector(".ev-range");
    if (r) r.hidden = !e.target.checked;
  }
});

function settingsSummary() {
  const s = tripSettings();
  const parts = [];
  if (s.startDate) parts.push(new Date(`${s.startDate}T12:00:00Z`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }));
  parts.push(`leave ${clock(startMinutes())}`, `max ${s.maxHours} h a day`);
  if (s.noNight) parts.push("no night driving");
  if (s.loop) parts.push("loop");
  if (s.ev) parts.push(`EV, ${fmtMi(s.evRange * 1000)} range`);
  for (const k of s.styles || []) parts.push(STYLES_LIST.find(([x]) => x === k)?.[1].toLowerCase() || k);
  return parts.join(" · ");
}
// The options line under the trip's stats, with a button to change them.
function settingsStrip() {
  const s = tripSettings();
  return `<section class="settings-strip">
    <span>${icon("gauge", 16)} <b>Trip options</b> ${esc(settingsSummary())}</span>
    ${!s.startDate && !READONLY ? `<button class="link-btn" data-act="opts">${icon("calendar", 14)} Add dates for weather, daylight and road closures</button>` : ""}
    ${READONLY ? "" : `<button class="btn ghost small" data-act="opts">Edit</button>`}
  </section>`;
}
// ---------- trip cost ----------
// A rough cost from plain arithmetic, no service: fuel (or charging) from each day's distance and the car's economy,
// lodging from each night's price level ($ to $$$$ from the planner), tolls and ferries flagged but not priced.
// Prices are typical 2026 pump and charger prices; the traveler can change both numbers (saved in trip.settings.cost).
const COST_REGION = {
  US: { cur: "USD", fuel: 3.5, kwh: 0.4, stay: 1 },
  CA: { cur: "CAD", fuel: 1.6, kwh: 0.45, stay: 1.35 },
  AU: { cur: "AUD", fuel: 2.0, kwh: 0.55, stay: 1.5 },
  NZ: { cur: "NZD", fuel: 2.8, kwh: 0.65, stay: 1.65 },
  GB: { cur: "GBP", fuel: 1.45, kwh: 0.7, stay: 0.8 },
  CH: { cur: "CHF", fuel: 1.85, kwh: 0.7, stay: 0.95 },
  EU: { cur: "EUR", fuel: 1.75, kwh: 0.6, stay: 0.92 },
  // stay: the local price of a US$ room night, with the country's price level (Norway and Iceland are dear)
  NO: { cur: "NOK", fuel: 21, kwh: 5, stay: 13 },
  IS: { cur: "ISK", fuel: 320, kwh: 70, stay: 175 },
  IE: { cur: "EUR", fuel: 1.75, kwh: 0.6, stay: 1.05 },
  ES: { cur: "EUR", fuel: 1.6, kwh: 0.5, stay: 0.8 },
  PT: { cur: "EUR", fuel: 1.75, kwh: 0.55, stay: 0.72 },
  // anywhere else: a rough world average in US dollars (fuel per litre)
  WORLD: { cur: "USD", fuel: 1.3, kwh: 0.3, stay: 0.8, rough: true },
};
const EURO_CC = new Set(["AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE", "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SK", "SI"]);
// a night for two in a typical room, in US dollars, by price level (scaled by the region's `stay`)
const STAY_USD = { $: [70, 120], $$: [120, 190], $$$: [190, 320], $$$$: [320, 550] };
function costSetup() {
  const c = stops.length ? countryOf(stops[0]) || "US" : "US";
  const reg = COST_REGION[c] || (c === "LI" ? COST_REGION.CH : EURO_CC.has(c) ? COST_REGION.EU : COST_REGION.WORLD);
  const ev = !!tripSettings().ev;
  const miles = c === "US" || c === "GB";
  const econ = ev
    ? { unit: miles ? "kWh/100 mi" : "kWh/100 km", def: miles ? 30 : 18, step: 1 }
    : c === "US" ? { unit: "mpg", def: 25, step: 1 } : c === "GB" ? { unit: "mpg (UK)", def: 40, step: 1 } : { unit: "L/100 km", def: 8, step: 0.1 };
  const price = ev ? { unit: "kWh", def: reg.kwh } : { unit: c === "US" ? "gallon" : "litre", def: reg.fuel };
  const saved = tripSettings().cost || {};
  // saved numbers only count in the units they were typed in (an EV switch or another country starts fresh)
  const same = saved.econUnit === econ.unit && saved.priceUnit === price.unit && saved.cur === reg.cur;
  return { c, reg, ev, econ, price, e: same && saved.econ > 0 ? saved.econ : econ.def, p: same && saved.price > 0 ? saved.price : price.def };
}
function energyCost(distM, k) {
  const km = distM / 1000;
  const mi = distM / 1609.34;
  if (k.ev) return ((k.econ.unit.endsWith("mi") ? mi : km) / 100) * k.e * k.p;
  if (k.econ.unit === "mpg") return (mi / k.e) * k.p;
  if (k.econ.unit === "mpg (UK)") return (mi / k.e) * 4.54609 * k.p; // imperial gallons, priced by the litre
  return (km / 100) * k.e * k.p;
}
let costOpen = false;
function costCard() {
  if (!routes.scenic) return "";
  const k = costSetup();
  const money = (n) => new Intl.NumberFormat(undefined, { style: "currency", currency: k.reg.cur, maximumFractionDigits: 0 }).format(n);
  const groups = dayGroups();
  let fuel = 0, lo = 0, hi = 0, toll = 0, ferry = 0, guessed = 0;
  const rows = groups.map((g, gi) => {
    const st = dayStats(g, "scenic");
    const segs = daySegments(g);
    toll += segs.reduce((a, s) => a + (s.toll_m || 0), 0);
    ferry += segs.reduce((a, s) => a + (s.ferry_m || 0), 0);
    const f = st ? energyCost(st.dist, k) : 0;
    fuel += f;
    // every day but the last ends with a night away
    const level = gi < groups.length - 1 ? plan?.days?.find((d) => Number(d.day) === g.day)?.price || "" : null;
    if (level === "") guessed++;
    const [a, b] = level == null ? [0, 0] : (STAY_USD[level] || STAY_USD.$$).map((x) => x * k.reg.stay);
    lo += a;
    hi += b;
    return `<tr><td>Day ${g.day}</td><td>${st ? fmtMi(st.dist) : ""}</td><td>${money(f)}</td>
      <td>${level == null ? `<span class="fine">last day</span>` : `${esc(level || "$$")}${level ? "" : "?"} · ${money(a)} to ${money(b)}`}</td></tr>`;
  });
  const nights = groups.length - 1;
  const what = k.ev ? "Charging" : "Fuel";
  const dis = READONLY ? "disabled" : "";
  return `<details class="cost-card" ${costOpen ? "open" : ""}>
    <summary>${icon("wallet", 16)} <b>Trip cost</b> <span>about ${money(fuel + lo)} to ${money(fuel + hi)}</span>
      <small>${what.toLowerCase()} ${money(fuel)}${nights ? ` · ${nights} night${nights === 1 ? "" : "s"} ${money(lo)} to ${money(hi)}` : ""}</small>
      ${icon("chevron", 14, "cost-chev")}</summary>
    <div class="cost-body">
      <form class="cost-inputs" id="cost-form">
        <label class="field inline"><span>${k.ev ? "Uses" : "Economy"}</span><input type="number" name="econ" min="0.1" step="${k.econ.step}" value="${k.e}" ${dis}> ${esc(k.econ.unit)}</label>
        <label class="field inline"><span>${k.ev ? "Charging" : "Fuel"} price</span><input type="number" name="price" min="0.01" step="0.01" value="${k.p}" ${dis}> ${esc(k.reg.cur)} a ${esc(k.price.unit)}</label>
      </form>
      <table class="cost-table">
        <thead><tr><th>Day</th><th>Drive</th><th>${what}</th><th>Night</th></tr></thead>
        <tbody>${rows.join("")}</tbody>
        <tfoot><tr><td>Total</td><td>${fmtMi(groups.reduce((a, g) => a + (dayStats(g, "scenic")?.dist || 0), 0))}</td><td>${money(fuel)}</td><td>${nights ? `${money(lo)} to ${money(hi)}` : ""}</td></tr></tfoot>
      </table>
      <p class="fine">A rough guide for planning, not a quote.${k.reg.rough ? " Prices here are a world average in US dollars: change them to local ones." : ""} Lodging is a typical room for two at each night's price level ($ to $$$$, from the planner)${guessed ? ` (“?”: no level from the planner, $$ assumed)` : ""}.
        ${toll > 1000 ? `Tolls or park fees on ${fmtMi(toll)} of the route are not included.` : ""}
        ${ferry > 500 ? `Ferry fares (${fmtMi(ferry)} by ferry) are not included.` : ""} Food and park passes aren't counted.</p>
    </div>
  </details>`;
}
document.addEventListener("toggle", (e) => {
  if (e.target.classList?.contains("cost-card")) costOpen = e.target.open;
}, true);
// printed trips show the cost table (a closed <details> hides its body even with print styles)
addEventListener("beforeprint", () => document.querySelectorAll(".cost-card").forEach((d) => (d.dataset.wasOpen = d.open, (d.open = true))));
addEventListener("afterprint", () => document.querySelectorAll(".cost-card").forEach((d) => (d.open = d.dataset.wasOpen === "true")));
document.addEventListener("change", (e) => {
  const form = e.target.closest?.("#cost-form");
  if (!form || READONLY) return;
  const k = costSetup();
  const num = (n) => Number(form.querySelector(`[name="${n}"]`).value);
  trip.settings = { ...trip.settings, cost: { econ: num("econ") > 0 ? num("econ") : k.econ.def, econUnit: k.econ.unit, price: num("price") > 0 ? num("price") : k.price.def, priceUnit: k.price.unit, cur: k.reg.cur } };
  scheduleSave();
  renderItinerary();
});

function openOptions() {
  const before = tripSettings();
  const el = openSheet(`${sheetHead("Trip options")}
    <form id="opts-form">${optionsForm(before)}
      <p class="fine">Dates, the start time, the daily limit and night driving update the trip right away.
        Styles, loop and the electric car change how the planner picks roads, so they need a replan.</p>
      <div class="sheet-actions"><button type="button" class="btn ghost" data-close>Cancel</button>
        <button class="btn blue" type="submit">Save</button></div>
    </form>`, "wide");
  el.querySelector("#opts-form").onsubmit = (e) => {
    e.preventDefault();
    const next = readOptions(e.target);
    trip.settings = { ...trip.settings, ...next }; // keeps what the form doesn't hold (the cost numbers)
    rememberSettings(next);
    closeOverlay();
    scheduleSave();
    renderStops();
    updateFix();
    renderItinerary();
    const replan = ["loop", "ev", "evRange"].some((k) => String(before[k]) !== String(next[k])) ||
      [...before.styles].sort().join() !== [...next.styles].sort().join();
    if (replan && plan) {
      const el2 = openSheet(`${sheetHead("Replan with the new options?")}
        <p>The planner picks roads with the trip style, loop and car in mind. Replan now so the route follows them?</p>
        <div class="sheet-actions"><button class="btn ghost" data-close>Not now</button>
        <button class="btn blue" id="replan-go">${icon("refresh", 18)} Replan</button></div>`);
      el2.querySelector("#replan-go").onclick = () => {
        closeOverlay();
        revisePlan({ feedback: `Apply the new trip options: ${settingsSummary()}.`, title: "Replanning with your options" });
      };
    }
  };
}

// ---------- seasonal roads ----------

let SEASONAL = [];
fetch("/seasonal-roads.json")
  .then((r) => r.json())
  .then((d) => {
    SEASONAL = d.roads || [];
    renderItinerary();
  })
  .catch(() => {});

const doy = (mmdd) => {
  const [m, d] = String(mmdd).split("-").map(Number);
  return Math.round((Date.UTC(2001, m - 1, d) - Date.UTC(2001, 0, 1)) / 86400000);
};
// Same rules as seasonStatus in server.js: open, maybe (within two weeks of the usual opening or closing), closed,
// caution (open, winter rules in those months) or check (closures any time).
function seasonStatus(r, iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  if (isNaN(d)) return "open";
  const month = d.getUTCMonth() + 1;
  if (r.kind === "check") return "check";
  if (r.kind === "caution") return (r.months || []).includes(month) ? "caution" : "open";
  const day = doy(`${month}-${d.getUTCDate()}`);
  const o = doy(r.open);
  const c = doy(r.close);
  if (day >= o && day <= c) return day - o < 14 || c - day < 14 ? "maybe" : "open";
  const off = Math.min((o - day + 365) % 365, (day - c + 365) % 365);
  return off < 14 ? "maybe" : "closed";
}
const monthDay = (mmdd) => {
  const [m, d] = String(mmdd).split("-").map(Number);
  return new Date(Date.UTC(2001, m - 1, d)).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function seasonText(r) {
  if (r.kind === "closed") return `Usually open ${monthDay(r.open)} to ${monthDay(r.close)}`;
  if (r.kind === "caution") return `Winter rules ${MONTHS[r.months[0] - 1]} to ${MONTHS[r.months.at(-1) - 1]}`;
  return "Closures can happen any time";
}
const SEASON_LABEL = { closed: "Usually closed then", maybe: "May be closed then", caution: "Winter rules then", check: "Check before you go" };

// Seasonal roads on a day: [{ r, status }]. With a start date, only the ones that matter on that day's date
// (status closed, maybe, caution or check); without one, every seasonal road the day uses (status null).
function seasonalForDay(g, segs) {
  if (!SEASONAL.length) return [];
  return memo(`season:${g.day}:${dayDate(g.day)}:${(plan?.roads || []).length}`, () => {
    const line = routes.scenic ? dayLine(g.day) : null;
    const text = [
      ...(plan?.roads || []).filter((r) => (r.days || []).map(Number).includes(g.day)).map((r) => `${r.name} ${r.ref || ""}`),
      ...g.items.map((i) => `${stops[i].name} ${stops[i].road || ""}`),
      ...(segs || []).map((s) => s.name || ""),
    ].join(" | ").toLowerCase();
    let box = null;
    if (line) {
      box = [180, 90, -180, -90];
      for (const c of line.coords) {
        box = [Math.min(box[0], c[0]), Math.min(box[1], c[1]), Math.max(box[2], c[0]), Math.max(box[3], c[1])];
      }
    }
    const near = (p, km) => {
      if (!line || p[0] < box[0] - 0.3 || p[0] > box[2] + 0.3 || p[1] < box[1] - 0.3 || p[1] > box[3] + 0.3) return false;
      const step = Math.max(1, Math.floor(line.coords.length / 4000));
      for (let k = 0; k < line.coords.length; k += step) if (haversine(line.coords[k], p) < km * 1000) return true;
      return false;
    };
    // a name match only counts nearby: Yellowstone's own "North Rim Drive" matched the Grand Canyon's North Rim
    // ("north rim") and Crater Lake ("rim drive")
    const dayPts = g.items.map((i) => [stops[i].lng, stops[i].lat]);
    const around = (r) => !(r.at || []).length || r.at.some((p) => dayPts.some((q) => haversine(p, q) < 300000));
    const date = dayDate(g.day);
    return SEASONAL.filter((r) => (r.at || []).some((p) => near(p, r.radius_km || 3)) || (around(r) && (r.match || []).some((m) => text.includes(m))))
      .map((r) => ({ r, status: date ? seasonStatus(r, date) : null }))
      .filter((x) => !date || x.status !== "open");
  });
}
const seasonClass = (st) => (st === "closed" ? "bad" : st === "check" ? "info" : "warn");

// The trip-level note in the hero.
function seasonalHero(groups, segsByDay) {
  const all = groups.flatMap((g) => seasonalForDay(g, segsByDay.get(g.day)).map((x) => ({ ...x, day: g.day })));
  if (!all.length) return "";
  const date = tripSettings().startDate;
  const uniq = [...new Map(all.map((x) => [x.r.name, x])).values()];
  if (!date) {
    const closing = uniq.filter((x) => x.r.kind === "closed");
    if (!closing.length) return "";
    return `<p class="cov-warn info">${icon("calendar", 16)} <span>${closing.length === 1 ? "A road on this trip closes" : `${closing.length} roads on this trip close`} for part of the year:
      ${esc(closing.map((x) => x.r.name.replace(/ \(.*\)$/, "")).join(", "))}.
      ${READONLY ? "" : `<button class="link-btn" data-act="opts">Add your dates</button> to check them.`}</span></p>`;
  }
  const closed = uniq.filter((x) => x.status === "closed" || x.status === "maybe");
  if (!closed.length) return "";
  return `<p class="cov-warn bad">${icon("alert", 16)} <span>${closed.length === 1 ? "1 road is" : `${closed.length} roads are`} usually closed or may be closed on your dates:
    ${esc(closed.map((x) => `${x.r.name.replace(/ \(.*\)$/, "")} (day ${x.day})`).join(", "))}.
    ${READONLY || !plan ? "" : `<button class="link-btn" data-act="season-avoid">Ask the planner to route around ${closed.length === 1 ? "it" : "them"}</button>`}</span></p>`;
}
function avoidSeasonal() {
  const groups = dayGroups();
  const names = new Set();
  for (const g of groups) {
    for (const x of seasonalForDay(g, routes.scenic ? daySegments(g) : [])) {
      if (x.status === "closed" || x.status === "maybe") names.add(x.r.name);
    }
  }
  if (!names.size) return;
  revisePlan({
    feedback: `These roads are closed for the season on our dates, so route around them: ${[...names].join("; ")}.`,
    title: "Routing around seasonal closures",
  });
}

// ---------- sunrise, sunset and time zones ----------

// Sunrise, sunset and the evening golden hour (sun 6° up) for a place and date, as Date objects (null in polar day
// or night). The standard NOAA/suncalc formulas; accurate to about a minute.
function sunTimes(lat, lng, iso) {
  const dayMs = 86400000;
  const J1970 = 2440588;
  const J2000 = 2451545;
  const J0 = 0.0009;
  const e = deg * 23.4397;
  // local noon of that date, so the right solar day is picked on both sides of the date line
  const date = new Date(Date.parse(`${iso}T12:00:00Z`) - (lng / 15) * 3600000);
  const d = date.valueOf() / dayMs - 0.5 + J1970 - J2000;
  const lw = deg * -lng;
  const phi = deg * lat;
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = J0 + lw / (2 * Math.PI) + n;
  const M = deg * (357.5291 + 0.98560028 * ds);
  const C = deg * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + deg * 102.9372 + Math.PI;
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const Jnoon = J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  const fromJ = (j) => new Date((j + 0.5 - J1970) * dayMs);
  const setJ = (h) => {
    const w = Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
    if (isNaN(w)) return null;
    return J2000 + J0 + (w + lw) / (2 * Math.PI) + n + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
  };
  const set = setJ(-0.833 * deg);
  const golden = setJ(6 * deg);
  return {
    rise: set == null ? null : fromJ(Jnoon - (set - Jnoon)),
    set: set == null ? null : fromJ(set),
    golden: golden == null ? null : fromJ(golden),
  };
}
// Minutes east of UTC for a time zone on a date (DST included).
function tzOffsetMin(tz, iso) {
  try {
    const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
      .formatToParts(new Date(`${iso}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value || "";
    const m = s.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0)) : 0;
  } catch {
    return 0;
  }
}
const tzAbbr = (tz, iso) => {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(new Date(`${iso}T12:00:00Z`)).find((p) => p.type === "timeZoneName")?.value || "";
  } catch {
    return "";
  }
};
// Minutes after local midnight of a moment, in a time zone.
function localMinutes(date, tz) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(date);
  return Number(p.find((x) => x.type === "hour")?.value || 0) * 60 + Number(p.find((x) => x.type === "minute")?.value || 0);
}

// ---------- weather (Open-Meteo through the server) ----------

const wx = { key: "", results: null, loading: false, error: "" };
// One point for the trip's start (day 1) and one for each day's end (on that day's date).
function weatherPoints() {
  const groups = dayGroups();
  const pts = [];
  if (!stops.length) return pts;
  pts.push({ lat: stops[0].lat, lng: stops[0].lng, date: dayDate(1) });
  for (const g of groups) {
    const s = stops[g.items.at(-1)];
    pts.push({ lat: s.lat, lng: s.lng, date: dayDate(g.day) });
  }
  return pts;
}
function loadWeather() {
  if (!tripSettings().startDate || stops.length < 2) return;
  const pts = weatherPoints();
  const key = JSON.stringify(pts.map((p) => [p.lat.toFixed(2), p.lng.toFixed(2), p.date]));
  if (wx.key === key) return;
  Object.assign(wx, { key, results: null, loading: true, error: "" });
  api("/api/weather", { points: pts })
    .then((d) => {
      if (wx.key !== key) return;
      wx.results = d.results || [];
      wx.error = d.error || "";
    })
    .catch((e) => (wx.error = e.message))
    .finally(() => {
      if (wx.key !== key) return;
      wx.loading = false;
      if (!progress) renderItinerary();
    });
}
// Time zones at the start and end of the day with index gi.
const dayTz = (gi) => ({ start: wx.results?.[gi]?.tz || "", end: wx.results?.[gi + 1]?.tz || "" });
const dayWeather = (gi) => wx.results?.[gi + 1] || null;
function wxIcon(code) {
  if (code == null) return "sun";
  if (code >= 95) return "storm";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "snow";
  if (code >= 51) return "rain";
  if (code === 45 || code === 48) return "fog";
  if (code >= 2) return "cloud";
  return "sun";
}
function weatherChip(gi, endName) {
  const w = dayWeather(gi);
  if (!w || w.tmax == null) return "";
  const kind = w.kind === "forecast" ? `Forecast for ${endName}` : `Typical for ${endName} around this date (last 3 years)`;
  return `<span class="wx" title="${esc(kind)}">${icon(wxIcon(w.code), 16)} ${fmtTemp(w.tmax)} / ${fmtTemp(w.tmin)}${w.rain != null ? ` · ${Math.round(w.rain)}% ${w.kind === "forecast" ? "rain" : "wet days"}` : ""}${w.kind === "typical" ? ` <em>typical</em>` : ""}</span>`;
}

// Arrival for a day: minutes after local midnight where the day ends (time zone changes included), sunset there,
// and whether the day ends after dark. Stops planned for the day count toward the arrival time.
function dayArrival(g, gi) {
  const st = dayStats(g, "scenic");
  if (!st) return null;
  const stopMin = (plan?.spots || []).filter((s) => s.day === g.day).reduce((a, s) => a + (Number(s.minutes) || 0), 0);
  const date = dayDate(g.day);
  const tz = dayTz(gi);
  let min = startMinutes() + st.dur / 60 + stopMin;
  const shift = date && tz.start && tz.end ? tzOffsetMin(tz.end, date) - tzOffsetMin(tz.start, date) : 0;
  min += shift;
  const end = stops[g.items.at(-1)];
  const sun = date && end ? sunTimes(end.lat, end.lng, date) : null;
  const sunsetMin = sun?.set && tz.end ? localMinutes(sun.set, tz.end) : null;
  const goldenMin = sun?.golden && tz.end ? localMinutes(sun.golden, tz.end) : null;
  const riseMin = sun?.rise && tz.end ? localMinutes(sun.rise, tz.end) : null;
  return { min, shift, sunsetMin, goldenMin, riseMin, tzStart: tz.start, tzEnd: tz.end, date, dark: sunsetMin != null && min > sunsetMin + 10 };
}
function afterDarkDays() {
  const groups = dayGroups();
  return groups.filter((g, gi) => dayArrival(g, gi)?.dark).map((g) => g.day);
}

// ---------- elevation profile and road ratings ----------

const hasElevation = () => (routes.scenic?.geometry?.coordinates?.[0]?.length || 0) > 2;

// Elevation every `step` meters between two geometry indexes, smoothed over ~300 m (SRTM heights are noisy).
// Returns { d: meters along, e: meters, k: geometry index }.
function elevSamples(coords, from, to, step = 100, smooth = 150) {
  const out = { d: [], e: [], k: [] };
  let acc = 0;
  let next = 0;
  for (let k = from; k <= to; k++) {
    if (k > from) acc += haversine(coords[k - 1], coords[k]);
    if (acc >= next || k === to) {
      out.d.push(acc);
      out.e.push(coords[k][2] ?? 0);
      out.k.push(k);
      next = acc + step;
    }
  }
  const w = Math.max(1, Math.round(smooth / step));
  out.e = out.e.map((_, i) => {
    let s = 0;
    let c = 0;
    for (let j = Math.max(0, i - w); j <= Math.min(out.e.length - 1, i + w); j++) {
      s += out.e[j];
      c++;
    }
    return s / c;
  });
  return out;
}
// Climb and descent with a 3 m dead band, the highest and lowest points, and the steepest kilometre.
// SRTM cells are 30 m wide, so a road on a cliff edge picks up the slope beside it; a whole km averages that out.
function climbStats(sm) {
  let up = 0;
  let down = 0;
  let ref = sm.e[0] ?? 0;
  for (const e of sm.e) {
    if (e - ref > 3) {
      up += e - ref;
      ref = e;
    } else if (ref - e > 3) {
      down += ref - e;
      ref = e;
    }
  }
  let grade = 0;
  for (let i = 0, j = 0; i < sm.d.length; i++) {
    while (j < sm.d.length - 1 && sm.d[j] - sm.d[i] < 1000) j++;
    const run = sm.d[j] - sm.d[i];
    if (run >= 900) grade = Math.max(grade, Math.abs(sm.e[j] - sm.e[i]) / run);
  }
  return { up, down, max: Math.max(...sm.e), min: Math.min(...sm.e), grade: grade * 100 };
}
// How much a stretch of road turns: degrees of heading change per km, and hairpins (the heading swings 150° or
// more one way within 250 m).
function curveStats(coords, from, to) {
  const segs = [];
  for (let k = from; k < to; k++) {
    const d = haversine(coords[k], coords[k + 1]);
    if (d >= 4) segs.push({ h: bearingOf(coords[k], coords[k + 1]), d });
  }
  let turn = 0;
  let len = segs.reduce((a, s) => a + s.d, 0);
  for (let i = 1; i < segs.length; i++) turn += Math.abs(angleDiff(segs[i].h, segs[i - 1].h));
  let hairpins = 0;
  for (let i = 1; i < segs.length; ) {
    let acc = 0;
    let dist = 0;
    let j = i;
    let found = false;
    for (; j < segs.length && dist < 250; j++) {
      acc += angleDiff(segs[j].h, segs[j - 1].h);
      dist += segs[j].d;
      if (Math.abs(acc) >= 150) {
        found = true;
        break;
      }
    }
    if (found) {
      hairpins++;
      i = j + 1;
    } else i++;
  }
  return { len, turn, hairpins };
}
// Calibrated on ORS geometry: an interstate across Nevada ~30°/km, the Icefields Parkway ~28, the Sea-to-Sky ~98,
// Big Sur ~210, the Beartooth switchbacks ~245, the Tail of the Dragon (US 129) ~710.
const CURVE_LEVELS = [
  [40, "Mostly straight"], [100, "Gentle curves"], [200, "Curvy"], [400, "Very twisty"], [Infinity, "Relentless curves"],
];
// The whole trip's climbing, from the smoothed profile (the router's own total counts every bump in the height data).
const tripClimb = () =>
  hasElevation() ? memo("climb", () => climbStats(elevSamples(routes.scenic.geometry.coordinates, 0, routes.scenic.geometry.coordinates.length - 1, 100, 200)).up) : null;
const curveLevel = (perKm) => {
  const i = CURVE_LEVELS.findIndex(([max]) => perKm < max);
  return { level: i + 1, label: CURVE_LEVELS[i][1] };
};
// Ratings for a featured road, measured on the stretches the route drives: { km, curves, hairpins, climb, top, grade }.
function roadStats(r) {
  if (!routes.scenic) return null;
  return memo(`road:${r.name}`, () => {
    const coords = routes.scenic.geometry.coordinates;
    let len = 0;
    let turn = 0;
    let hairpins = 0;
    let up = 0;
    let top = -Infinity;
    let grade = 0;
    for (const g of dayGroups()) {
      for (const s of daySegments(g)) {
        if (s.road !== r || s.from == null || s.to == null || s.to <= s.from) continue;
        const c = curveStats(coords, s.from, s.to);
        len += c.len;
        turn += c.turn;
        hairpins += c.hairpins;
        if (hasElevation()) {
          const cs = climbStats(elevSamples(coords, s.from, s.to, 50, 250));
          up += cs.up;
          top = Math.max(top, cs.max);
          grade = Math.max(grade, cs.grade);
        }
      }
    }
    if (len < 3000) return null;
    const perKm = turn / (len / 1000);
    return { len, perKm, ...curveLevel(perKm), hairpins, climb: hasElevation() ? up : null, top: hasElevation() ? top : null, grade: hasElevation() ? grade : null };
  });
}
function ratingHtml(st) {
  if (!st) return "";
  const dots = Array.from({ length: 5 }, (_, i) => `<i class="${i < st.level ? "on" : ""}"></i>`).join("");
  return `<div class="rating">
    <span class="curves" title="${Math.round(st.perKm)}° of turning per km"><span class="dots">${dots}</span> ${esc(st.label)}</span>
    ${st.hairpins ? `<span>${icon("hairpin", 14)} ${st.hairpins} hairpin${st.hairpins === 1 ? "" : "s"}</span>` : ""}
    ${st.climb != null ? `<span>${icon("mountain", 14)} ${fmtElev(st.climb)} climb</span>` : ""}
    ${st.top != null && isFinite(st.top) ? `<span>${icon("flag", 14)} top ${fmtElev(st.top)}</span>` : ""}
    ${st.grade >= 2 ? `<span title="Average grade of the steepest kilometre">${icon("gauge", 14)} steepest km ${Math.round(st.grade)}%</span>` : ""}
  </div>`;
}

// Elevation profile of one day as an SVG, with the featured roads shaded and the spots marked. Hovering shows the
// height at that point (and moves a marker on the map in the map view).
const PROFILES = new Map();
function profileHtml(g, segs, placed, { id = `p${g.day}`, height = 150, title = "Elevation" } = {}) {
  if (!hasElevation()) return "";
  const line = dayLine(g.day);
  if (!line || line.coords.length < 2) return "";
  const legs = legsByEnd(routes.scenic);
  const base = legs.get(g.items.find((i) => legs.get(i)))?.from ?? 0;
  const coords = routes.scenic.geometry.coordinates;
  const total = line.cum.at(-1) || 1;
  // drawn from ~400 points; the climb figures come from samples every 100 m
  const step = Math.max(50, total / 400);
  const sm = elevSamples(coords, base, base + line.coords.length - 1, step, Math.max(150, step));
  if (sm.e.length < 3) return "";
  const cs = memo(`dayclimb:${g.day}`, () => climbStats(elevSamples(coords, base, base + line.coords.length - 1, 100, 200)));
  PROFILES.set(id, { sm, total, day: g.day });
  const W = 1000;
  const H = height;
  const lo = Math.min(...sm.e) - (cs.max - cs.min) * 0.15 - 20;
  const hi = Math.max(...sm.e) + (cs.max - cs.min) * 0.1 + 20;
  const X = (d) => (d / total) * W;
  const Y = (e) => H - ((e - lo) / (hi - lo)) * (H - 18) - 2;
  const pts = sm.d.map((d, i) => `${X(d).toFixed(1)},${Y(sm.e[i]).toFixed(1)}`).join(" ");
  const bands = (segs || [])
    .filter((s) => s.road && s.from != null)
    .map((s) => {
      const a = line.cum[clamp(s.from - base, 0, line.cum.length - 1)];
      const b = line.cum[clamp(s.to - base, 0, line.cum.length - 1)];
      return `<rect x="${X(a).toFixed(1)}" y="0" width="${Math.max(1, X(b) - X(a)).toFixed(1)}" height="${H}" class="pf-band"><title>${esc(s.road.name)}</title></rect>`;
    })
    .join("");
  // spots as round dots over the chart (SVG circles would stretch with the chart's width)
  const spotsHtml = (placed || [])
    .filter((p) => p.pos)
    .map((p) => {
      const k = sm.d.findIndex((d) => d >= p.pos.along * total);
      const y = Y(sm.e[k < 0 ? sm.e.length - 1 : k]);
      return `<i class="pf-spot t-${esc(p.s.type)}" style="left:${(p.pos.along * 100).toFixed(2)}%;top:${((y / H) * 100).toFixed(2)}%" title="${esc(p.s.name)}"></i>`;
    })
    .join("");
  const hiIdx = sm.e.indexOf(Math.max(...sm.e));
  return `<figure class="profile" data-profile="${id}">
    <figcaption>
      <span>${icon("mountain", 16)} ${esc(title)}</span>
      <span>${icon("trend-up", 14)} ${fmtElev(cs.up)} up</span><span>${icon("trend-down", 14)} ${fmtElev(cs.down)} down</span>
      <span>${icon("flag", 14)} high point ${fmtElev(cs.max)}</span>
    </figcaption>
    <div class="pf-box">
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Elevation profile, ${fmtElev(cs.min)} to ${fmtElev(cs.max)}">
        ${bands}
        <polygon points="0,${H} ${pts} ${W},${H}" class="pf-fill"/>
        <polyline points="${pts}" class="pf-line"/>
        <line class="pf-cursor" x1="-10" x2="-10" y1="0" y2="${H}"/>
      </svg>
      ${spotsHtml}
      <span class="pf-label hi" style="left:${((sm.d[hiIdx] / total) * 100).toFixed(1)}%">${fmtElev(cs.max)}</span>
      <span class="pf-tip" hidden></span>
    </div>
  </figure>`;
}
// The day's drive in one chart (replaces the road strip and the separate elevation chart): the climb when the route
// has heights, featured roads shaded and named, the road types along the bottom, stops marked, the clock underneath.
// Hovering says where and when and lights that row of the timeline; hovering a timeline row moves the cursor here;
// clicking opens the map there.
function driveChartHtml(g, segs, placed, st, startName, endName) {
  const line = st && routes.scenic ? dayLine(g.day) : null;
  if (!line || line.coords.length < 2) return "";
  const legs = legsByEnd(routes.scenic);
  const base = legs.get(g.items.find((i) => legs.get(i)))?.from ?? 0;
  const coords = routes.scenic.geometry.coordinates;
  const total = line.cum.at(-1) || 1;
  const step = Math.max(50, total / 400);
  const sm = elevSamples(coords, base, base + line.coords.length - 1, step, Math.max(150, step));
  if (sm.d.length < 3) return "";
  const elev = hasElevation() && Math.max(...sm.e) > Math.min(...sm.e);
  const cs = elev ? memo(`dayclimb:${g.day}`, () => climbStats(elevSamples(coords, base, base + line.coords.length - 1, 100, 200))) : null;
  // the clock: driving time spread over the distance, plus the stops' minutes once they're passed
  const start = startMinutes();
  const stopsAt = (placed || []).filter((p) => p.pos).map((p) => ({ f: p.pos.along, min: Number(p.s.minutes) || 0 }));
  const timeAt = (f) => start + (st.dur / 60) * f + stopsAt.reduce((a, x) => a + (x.f < f ? x.min : 0), 0);
  const fAt = (m) => {
    let lo = 0, hi = 1;
    for (let k = 0; k < 24; k++) {
      const mid = (lo + hi) / 2;
      if (timeAt(mid) < m) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  const endMin = timeAt(1);
  const every = endMin - start > 9 * 60 ? 120 : endMin - start > 150 ? 60 : 30;
  const ticks = [];
  for (let m = Math.floor(start / every) * every + every; m < endMin - every * 0.35; m += every) {
    const f = fAt(m);
    if (f > 0.06) ticks.push({ f, label: clock(m).replace(":00 ", " ") });
  }
  // featured roads by position on the day's line
  const bands = [];
  for (const sg of segs || []) {
    if (!sg.road || sg.from == null) continue;
    const a = line.cum[clamp(sg.from - base, 0, line.cum.length - 1)] / total;
    const b = line.cum[clamp(sg.to - base, 0, line.cum.length - 1)] / total;
    const last = bands.at(-1);
    if (last && last.road === sg.road && a - last.b < 0.02) last.b = b;
    else bands.push({ road: sg.road, a, b });
  }
  const id = `d${g.day}`;
  PROFILES.set(id, { sm, total, day: g.day, timeAt, bands });
  const W = 1000;
  const H = elev ? 110 : 34;
  const lo = elev ? Math.min(...sm.e) - (cs.max - cs.min) * 0.15 - 20 : -1;
  const hi = elev ? Math.max(...sm.e) + (cs.max - cs.min) * 0.12 + 20 : 1;
  const X = (d) => (d / total) * W;
  const Y = (e) => H - ((e - lo) / (hi - lo)) * (H - 14) - 2;
  const pts = sm.d.map((d, i) => `${X(d).toFixed(1)},${(elev ? Y(sm.e[i]) : H / 2).toFixed(1)}`).join(" ");
  const pct = (f) => `${(f * 100).toFixed(2)}%`;
  const yAt = (f) => {
    if (!elev) return 50;
    const k = sm.d.findIndex((d) => d >= f * total);
    return (Y(sm.e[k < 0 ? sm.e.length - 1 : k]) / H) * 100;
  };
  const { parts, total: partsTotal } = stripSegments(segs || []);
  let acc = 0;
  const kinds = parts
    .map((p) => {
      const html = `<i class="dc-kind ${p.kind}" style="left:${pct(acc / partsTotal)};width:${pct(p.d / partsTotal)}"></i>`;
      acc += p.d;
      return html;
    })
    .join("");
  const hiIdx = elev ? sm.e.indexOf(Math.max(...sm.e)) : -1;
  return `<figure class="profile drive" data-profile="${id}">
    <figcaption>
      <span>${icon("route", 16)} ${fmtShort(st.dur)} · ${fmtMi(st.dist)}</span>
      ${elev ? `<span>${icon("trend-up", 14)} ${fmtElev(cs.up)} up</span><span>${icon("trend-down", 14)} ${fmtElev(cs.down)} down</span>` : `<span class="fine">No heights for this route</span>`}
      <span class="dc-key"><i class="dc-kind featured"></i> featured <i class="dc-kind freeway"></i> freeway <i class="dc-kind road"></i> other roads</span>
    </figcaption>
    <div class="pf-box" style="--h:${H}px">
      ${bands.map((b) => `<span class="dc-band" style="left:${pct(b.a)};width:${pct(Math.max(0.004, b.b - b.a))}" title="${esc(b.road.name)}">${b.b - b.a > 0.09 ? `<em>${esc(refLabel(b.road.ref) || b.road.name)}</em>` : ""}</span>`).join("")}
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="The day's drive${elev ? `, ${fmtElev(cs.min)} to ${fmtElev(cs.max)}` : ""}">
        ${elev ? `<polygon points="0,${H} ${pts} ${W},${H}" class="pf-fill"/>` : ""}
        <polyline points="${pts}" class="pf-line"/>
        <line class="pf-cursor" x1="-10" x2="-10" y1="0" y2="${H}"/>
      </svg>
      ${(placed || []).filter((p) => p.pos).map((p) => `<span class="dc-spot t-${esc(p.s.type)}" style="left:${pct(p.pos.along)};top:${yAt(p.pos.along).toFixed(1)}%" title="${esc(p.s.name)}">${icon(spotType(p.s.type).icon, 11)}</span>`).join("")}
      ${elev ? `<span class="pf-label hi" style="left:${pct(sm.d[hiIdx] / total)}">${fmtElev(cs.max)}</span>` : ""}
      <span class="pf-tip" hidden></span>
    </div>
    <div class="dc-kinds">${kinds}</div>
    <div class="dc-axis">
      <span class="dc-end" style="left:0"><b>${clock(start)}</b><i> ${esc(startName)}</i></span>
      ${ticks.map((t) => `<span class="dc-tick" style="left:${pct(t.f)}">${esc(t.label)}</span>`).join("")}
      <span class="dc-end right" style="right:0"><i>${esc(endName)} </i><b>${clock(endMin)}</b></span>
    </div>
  </figure>`;
}

// Labels under the drive charts that would touch: town names go first, then the hour ticks nearest the ends.
function tidyAxes(root = document) {
  for (const ax of root.querySelectorAll(".dc-axis")) {
    if (!ax.clientWidth) continue;
    const spans = [...ax.querySelectorAll("span, i")];
    spans.forEach((x) => (x.style.visibility = ""));
    const [a, b] = ax.querySelectorAll(".dc-end");
    if (a.getBoundingClientRect().right + 10 > b.getBoundingClientRect().left) ax.querySelectorAll(".dc-end i").forEach((x) => (x.style.visibility = "hidden"));
    // the ends' times always stay; a name that's hidden doesn't take room
    const taken = [a, b].map((e) => {
      const r = e.querySelector("b").getBoundingClientRect();
      const n = e.querySelector("i");
      const nr = n.style.visibility ? r : n.getBoundingClientRect();
      return { left: Math.min(r.left, nr.left), right: Math.max(r.right, nr.right) };
    });
    for (const t of ax.querySelectorAll(".dc-tick")) {
      const r = t.getBoundingClientRect();
      if (taken.some((k) => r.left < k.right + 8 && r.right > k.left - 8)) t.style.visibility = "hidden";
      else taken.push(r);
    }
  }
}

// The cursor on a profile at fraction f of the day: a line, a tip (height, distance; time and road on a drive chart),
// a marker on the map in the map view, and on a drive chart the timeline row for that moment lit.
let profileMarker = null;
function profileAt(fig, f) {
  const p = PROFILES.get(fig.dataset.profile);
  if (!p) return;
  const target = f * p.total;
  let i = p.sm.d.findIndex((d) => d >= target);
  if (i < 0) i = p.sm.d.length - 1;
  fig.classList.add("cursoring");
  fig.querySelector(".pf-cursor").setAttribute("x1", String(f * 1000));
  fig.querySelector(".pf-cursor").setAttribute("x2", String(f * 1000));
  const tip = fig.querySelector(".pf-tip");
  tip.hidden = false;
  const elev = hasElevation() && p.sm.e[i] ? fmtElev(p.sm.e[i]) : "";
  if (p.timeAt) {
    const road = p.bands.find((b) => f >= b.a && f <= b.b)?.road;
    tip.textContent = [clock(p.timeAt(f)), road?.name, elev, `${fmtMi(p.sm.d[i])} in`].filter(Boolean).join(" · ");
    const rows = [...(fig.closest(".day")?.querySelectorAll(".tl-row[data-f]") || [])];
    const at = rows.filter((r) => Number(r.dataset.f) <= f + 0.004).at(-1);
    rows.forEach((r) => r.classList.toggle("tl-hot", r === at));
  } else tip.textContent = [elev, fmtMi(p.sm.d[i])].filter(Boolean).join(" · ");
  // centred on the cursor, but kept inside the chart (a long tip near either end was cut off on phones)
  const w = fig.querySelector(".pf-box").clientWidth;
  tip.style.left = `${clamp(f * w - tip.offsetWidth / 2, 0, Math.max(0, w - tip.offsetWidth))}px`;
  const c = routes.scenic?.geometry.coordinates[p.sm.k[i]];
  if (c && document.body.dataset.view === "map") {
    if (!profileMarker) {
      const el = document.createElement("div");
      el.className = "pf-marker";
      profileMarker = new maplibregl.Marker({ element: el });
    }
    profileMarker.setLngLat([c[0], c[1]]).addTo(map);
  }
}
function profileOff(fig) {
  fig.classList.remove("cursoring");
  fig.querySelector(".pf-tip").hidden = true;
  fig.closest(".day")?.querySelectorAll(".tl-hot").forEach((r) => r.classList.remove("tl-hot"));
  profileMarker?.remove();
}
const profileF = (fig, clientX) => {
  const box = fig.querySelector(".pf-box").getBoundingClientRect();
  return clamp((clientX - box.left) / box.width, 0, 1);
};
document.addEventListener("pointermove", (e) => {
  const fig = e.target.closest?.(".profile");
  if (fig) profileAt(fig, profileF(fig, e.clientX));
});
document.addEventListener("pointerleave", (e) => {
  const fig = e.target.closest?.(".profile");
  if (fig && e.target === fig) profileOff(fig);
}, true);
// a timeline row moves the day chart's cursor to its moment
document.addEventListener("pointerover", (e) => {
  const row = e.target.closest?.(".tl-row[data-f]");
  const fig = row?.closest(".day")?.querySelector(".profile.drive");
  if (fig) profileAt(fig, Number(row.dataset.f));
});
// the same with the keyboard: tabbing through the timeline moves the cursor
document.addEventListener("focusin", (e) => {
  const row = e.target.closest?.(".tl-row[data-f]");
  const fig = row?.closest(".day")?.querySelector(".profile.drive");
  if (fig) profileAt(fig, Number(row.dataset.f));
});
document.addEventListener("focusout", (e) => {
  const row = e.target.closest?.(".tl-row[data-f]");
  const fig = row?.closest(".day")?.querySelector(".profile.drive");
  if (fig && !e.relatedTarget?.closest?.(".tl-row[data-f]")) profileOff(fig);
});
document.addEventListener("pointerout", (e) => {
  const row = e.target.closest?.(".tl-row[data-f]");
  if (!row || row.contains(e.relatedTarget)) return;
  const fig = row.closest(".day")?.querySelector(".profile.drive");
  if (fig) profileOff(fig);
});
document.addEventListener("click", (e) => {
  const fig = e.target.closest?.(".profile");
  if (!fig || document.body.dataset.view !== "itinerary") return;
  // clicking a profile in the itinerary opens that spot on the map
  const p = PROFILES.get(fig.dataset.profile);
  if (!p) return;
  const f = profileF(fig, e.clientX);
  let i = p.sm.d.findIndex((d) => d >= f * p.total);
  if (i < 0) i = p.sm.d.length - 1;
  const c = routes.scenic?.geometry.coordinates[p.sm.k[i]];
  if (c) showPointOnMap(c[0], c[1], p.day);
});

// The profile card at the bottom of the map for the highlighted day.
function renderMapProfile() {
  const el = $("map-profile");
  if (!el) return;
  const g = highlighted != null ? dayGroups().find((x) => x.day === highlighted) : null;
  if (!g || !hasElevation()) {
    el.hidden = true;
    el.innerHTML = "";
    return;
  }
  const segs = daySegments(g);
  el.innerHTML = `<button class="icon-btn mp-close" aria-label="Close the elevation profile" data-mp-close>${icon("close", 16)}</button>
    ${profileHtml(g, segs, [], { id: `m${g.day}`, height: 110, title: `Day ${g.day} elevation` })}`;
  el.hidden = false;
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-mp-close]")) {
    highlighted = null;
    drawHighlight();
    renderMapProfile();
    profileMarker?.remove();
  }
});

// ---------- along the route: fuel and charger gaps, sights, lodging (OpenStreetMap via the server) ----------

const alongState = { loading: false, done: 0, total: 0, error: "" };
const routeSig = () => (routes.scenic ? `${Math.round(routes.scenic.distance_m)}:${routes.scenic.geometry.coordinates.length}` : "");
const SIGHT_KINDS = { view: ["Viewpoint", "viewpoint"], falls: ["Waterfall", "waterfall"], spring: ["Hot spring", "hot_spring"], diner: ["Diner", "food"] };

// Douglas-Peucker on [lng, lat] with a tolerance in degrees, raised until the line has at most maxPts points.
function simplifyLine(coords, maxPts = 200) {
  const pts = coords.map((c) => [c[0], c[1]]);
  const dp = (tol) => {
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let best = -1;
      let bestD = tol;
      const [ax, ay] = pts[a];
      const [bx, by] = pts[b];
      const dx = bx - ax;
      const dy = by - ay;
      const L = dx * dx + dy * dy || 1e-12;
      for (let i = a + 1; i < b; i++) {
        const t = clamp(((pts[i][0] - ax) * dx + (pts[i][1] - ay) * dy) / L, 0, 1);
        const d = Math.hypot(pts[i][0] - (ax + t * dx), pts[i][1] - (ay + t * dy));
        if (d > bestD) {
          bestD = d;
          best = i;
        }
      }
      if (best > 0) {
        keep[best] = 1;
        stack.push([a, best], [best, b]);
      }
    }
    return pts.filter((_, i) => keep[i]);
  };
  let tol = 0.003;
  let out = dp(tol);
  while (out.length > maxPts) out = dp((tol *= 1.6));
  return out;
}
// Position of a point along a line: { along: meters, off: meters from the line }.
function projectOnto(line, p) {
  const step = Math.max(1, Math.floor(line.coords.length / 3000));
  const kx = Math.cos(p[1] * deg);
  let best = 0;
  let bestD = Infinity;
  for (let k = 0; k < line.coords.length; k += step) {
    const c = line.coords[k];
    const d = ((c[0] - p[0]) * kx) ** 2 + (c[1] - p[1]) ** 2;
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  return { along: line.cum[best], off: haversine(line.coords[best], p) };
}
function longestGap(positions, total) {
  const xs = [0, ...positions.filter((x) => x >= 0 && x <= total).sort((a, b) => a - b), total];
  let best = { len: 0, from: 0, to: total };
  for (let i = 0; i < xs.length - 1; i++) if (xs[i + 1] - xs[i] > best.len) best = { len: xs[i + 1] - xs[i], from: xs[i], to: xs[i + 1] };
  return best;
}
// The nearest named place to a spot along a day: a stop, via point or planned spot.
function placeNear(g, line, along) {
  const cands = g.items.map((i) => ({ name: shortName(stops[i].name).replace(/ \((one end|middle|other end)\)$/, ""), p: [stops[i].lng, stops[i].lat] }));
  const gi = dayGroups().findIndex((x) => x.day === g.day);
  if (gi > 0) {
    const s = stops[dayGroups()[gi - 1].items.at(-1)];
    cands.push({ name: shortName(s.name), p: [s.lng, s.lat] });
  }
  let best = null;
  for (const c of cands) {
    const pr = projectOnto(line, c.p);
    const d = Math.abs(pr.along - along);
    if (pr.off < 20000 && (!best || d < best.d)) best = { d, name: c.name };
  }
  return best && best.d < 40000 ? best.name : `${fmtMi(along)} in`;
}

// Fetch everything along each day's route (one OpenStreetMap query per day) and store it on the plan.
async function loadAlong() {
  if (!routes.scenic || alongState.loading || READONLY) return;
  const groups = dayGroups();
  const sig = routeSig();
  plan ||= { title: trip.name, summary: "", days: [], roads: [], spots: [], sources: [] };
  if (plan.along?.sig !== sig) plan.along = { sig, days: {} };
  Object.assign(alongState, { loading: true, done: 0, total: groups.length, error: "" });
  renderItinerary();
  let failedDays = 0;
  for (const g of groups) {
    if (plan.along.days[g.day] && !plan.along.days[g.day].partial) {
      alongState.done++;
      continue;
    }
    const line = dayLine(g.day);
    if (!line) {
      alongState.done++;
      continue;
    }
    const end = stops[g.items.at(-1)];
    try {
      const d = await api("/api/along", { line: simplifyLine(line.coords), overnight: [end.lng, end.lat] });
      const total = line.cum.at(-1);
      const pos = (k, maxOff) =>
        d.pois.filter((p) => p.k === k).map((p) => ({ ...p, ...projectOnto(line, [p.lng, p.lat]) })).filter((p) => p.off <= maxOff);
      const fuel = pos("fuel", 3000);
      const fast = pos("evfast", 5000);
      const slow = pos("ev", 3000);
      const fuelGap = longestGap(fuel.map((p) => p.along), total);
      const evGap = longestGap(fast.map((p) => p.along), total);
      const sights = Object.keys(SIGHT_KINDS)
        .flatMap((k) => pos(k, k === "spring" ? 6000 : 3000).filter((p) => p.name))
        .sort((a, b) => a.along - b.along);
      // one of each name (OpenStreetMap often has a viewpoint as several points)
      const seen = new Set();
      const uniqSights = sights.filter((p) => !seen.has(`${p.k}:${p.name}`) && seen.add(`${p.k}:${p.name}`)).slice(0, 30);
      plan.along.days[g.day] = {
        total,
        fuel: fuel.length,
        fuelGap: { ...fuelGap, a: placeNear(g, line, fuelGap.from), b: placeNear(g, line, fuelGap.to) },
        evFast: fast.length,
        evSlow: slow.length,
        evGap: { ...evGap, a: placeNear(g, line, evGap.from), b: placeNear(g, line, evGap.to) },
        sights: uniqSights.map(({ k, name, lng, lat, along }) => ({ k, name, lng, lat, along: Math.round(along) })),
        pins: [...fuel.map((p) => ["fuel", p.lng, p.lat, p.name]), ...fast.map((p) => ["evfast", p.lng, p.lat, p.name]), ...slow.map((p) => ["ev", p.lng, p.lat, p.name])].slice(0, 400),
        lodging: d.lodging,
        stay: d.stay || null,
        food: d.food || null,
        partial: !!d.partial,
      };
      if (d.partial) failedDays++;
    } catch (e) {
      // keep going: the next day may work, and "Finish" retries the ones that didn't. Unless the server is down.
      failedDays++;
      alongState.error = e.message;
      if (/unreachable/.test(e.message)) break;
    } finally {
      alongState.done++;
      renderItinerary();
    }
    await sleep(1200); // be gentle with the public Overpass servers
  }
  alongState.loading = false;
  if (failedDays && !/unreachable/.test(alongState.error)) {
    alongState.error = `OpenStreetMap's free server was busy for ${failedDays} day${failedDays === 1 ? "" : "s"}. Try those again in a few minutes.`;
  }
  scheduleSave();
  drawAlongLayer();
  renderItinerary();
}
const alongFor = (day) => (plan?.along?.sig === routeSig() ? plan.along.days?.[day] : null);

function alongHtml(g) {
  const a = alongFor(g.day);
  if (!a) return "";
  const s = tripSettings();
  // a partly loaded day has holes, so its gaps mean nothing
  const longFuel = !a.partial && a.fuelGap.len > (KM ? 160000 : 160934);
  const evLimit = s.evRange * 1000 * 0.7;
  const longEv = !a.partial && s.ev && a.evGap.len > evLimit;
  const sightRows = a.sights
    .map((p) => `<li><button data-act="tl" data-lng="${p.lng}" data-lat="${p.lat}" data-day="${g.day}">
      <span class="tl-ico t-${SIGHT_KINDS[p.k][1]}">${icon(SIGHT_KINDS[p.k][1], 14)}</span>
      <span><b>${esc(p.name)}</b><small>${esc(SIGHT_KINDS[p.k][0])} · ${fmtMi(p.along)} in</small></span></button></li>`)
    .join("");
  return `<div class="along">
    ${a.partial ? `<small class="warn-text">Only part of this day loaded (OpenStreetMap's free server was busy), so there may be more fuel and sights than shown.</small>` : ""}
    <div class="along-row ${longFuel ? "warn" : ""}">${icon("fuel", 18)}<div><b>${a.fuel} fuel station${a.fuel === 1 ? "" : "s"} on the way</b>
      ${a.partial ? "" : `<small>Longest stretch without fuel: ${fmtMi(a.fuelGap.len)}${a.fuelGap.len > 15000 ? `, ${esc(a.fuelGap.a)} to ${esc(a.fuelGap.b)}` : ""}${longFuel ? ". Fill up before it." : ""}</small>`}</div></div>
    ${s.ev || a.evFast ? `<div class="along-row ${longEv ? "warn" : ""}">${icon("plug", 18)}<div><b>${a.evFast} fast charger${a.evFast === 1 ? "" : "s"}${a.evSlow ? `, ${a.evSlow} slower` : ""}</b>
      ${a.partial ? "" : `<small>Longest stretch without a fast charger: ${fmtMi(a.evGap.len)}${a.evGap.len > 15000 ? `, ${esc(a.evGap.a)} to ${esc(a.evGap.b)}` : ""}${longEv ? `. That's more than 70% of your ${fmtMi(s.evRange * 1000)} range.` : ""}</small>`}</div></div>` : ""}
    ${sightRows ? `<details class="along-sights"><summary>${icon("viewpoint", 16)} ${a.sights.length} viewpoints, waterfalls, hot springs and diners near the route</summary><ul>${sightRows}</ul></details>` : ""}
  </div>`;
}
function alongButton() {
  if (!routes.scenic || READONLY) return "";
  if (alongState.loading) return `<p class="along-status"><span class="spinner"></span> Searching OpenStreetMap along the route: day ${Math.min(alongState.done + 1, alongState.total)} of ${alongState.total}</p>`;
  const groups = dayGroups();
  const missing = groups.filter((g) => !alongFor(g.day) || alongFor(g.day).partial).length;
  if (!missing) return "";
  return `<button class="btn ghost" data-act="along">${icon("fuel", 18)} ${missing === groups.length ? "Find fuel, chargers and sights along the route" : `Finish fuel and sights for ${missing} more day${missing === 1 ? "" : "s"}`}</button>
    ${alongState.error ? `<small class="warn-text">${esc(alongState.error)}</small>` : ""}`;
}
// Fuel and chargers as small dots on the map (a layer, not markers: there can be hundreds).
function drawAlongLayer() {
  if (!styleReady) return;
  const feats = [];
  for (const [day, a] of Object.entries(plan?.along?.sig === routeSig() ? plan.along.days || {} : {})) {
    for (const [k, lng, lat, name] of a.pins || []) feats.push({ type: "Feature", properties: { k, name: name || "", day: Number(day) }, geometry: { type: "Point", coordinates: [lng, lat] } });
    for (const p of a.sights || []) feats.push({ type: "Feature", properties: { k: p.k, name: p.name, day: Number(day) }, geometry: { type: "Point", coordinates: [p.lng, p.lat] } });
  }
  const data = { type: "FeatureCollection", features: feats };
  if (map.getSource("along")) return map.getSource("along").setData(data);
  map.addSource("along", { type: "geojson", data });
  map.addLayer({
    id: "along", type: "circle", source: "along", minzoom: 6,
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 2.5, 12, 6],
      "circle-color": ["match", ["get", "k"], "fuel", "#ff9f0a", "evfast", "#30d158", "ev", "#64d2ff", "view", "#0a84ff", "falls", "#5ac8fa", "spring", "#ff375f", "diner", "#ffd60a", "#8e8e93"],
      "circle-stroke-color": "#000", "circle-stroke-width": 1, "circle-opacity": 0.9,
    },
  });
}
const ALONG_NAMES = { fuel: "Fuel", evfast: "Fast charger", ev: "Charger", view: "Viewpoint", falls: "Waterfall", spring: "Hot spring", diner: "Diner" };
map.on("click", "along", (e) => {
  const f = e.features?.[0];
  if (!f) return;
  new maplibregl.Popup({ offset: 8, className: "spot-pop" })
    .setLngLat(f.geometry.coordinates)
    .setHTML(`<div class="pop-body"><small>Day ${f.properties.day} · ${esc(ALONG_NAMES[f.properties.k] || "")}</small><b>${esc(f.properties.name || ALONG_NAMES[f.properties.k] || "")}</b></div>`)
    .addTo(map);
});
map.on("mouseenter", "along", () => (map.getCanvas().style.cursor = "pointer"));
map.on("mouseleave", "along", () => (map.getCanvas().style.cursor = ""));

// ---------- ferries, tolls and gravel ----------

// Ferry crossings on a day, with a booking link for the big operators.
function dayFerries(segs) {
  return (segs || []).filter((s) => s.ferry_m > s.distance_m / 2 && s.distance_m > 500);
}
function ferryLink(seg, g) {
  const p = stops[g.items[0]];
  const at = p ? [p.lng, p.lat] : [0, 0];
  const name = `${seg.name} ${seg.refs.join(" ")}`;
  if (at[0] < -122 && at[0] > -131 && at[1] > 48 && at[1] < 55) return ["BC Ferries", "https://www.bcferries.com"];
  if (at[0] < -121.9 && at[0] > -124 && at[1] > 46.9 && at[1] < 48.9) return ["Washington State Ferries", "https://wsdot.wa.gov/travel/washington-state-ferries"];
  if (/spirit of tasmania|devonport|geelong/i.test(name) || (at[0] > 143 && at[0] < 149 && at[1] < -38.5 && at[1] > -43.8)) return ["Spirit of Tasmania", "https://www.spiritoftasmania.com.au"];
  if (at[0] > 172 && at[0] < 175.5 && at[1] < -40.5 && at[1] > -42) return ["Interislander", "https://www.interislander.co.nz"];
  if (at[0] > -7.5 && at[0] < -4.5 && at[1] > 55.3 && at[1] < 58.8) return ["CalMac", "https://www.calmac.co.uk"];
  if (/kangaroo island|sealink/i.test(name)) return ["SeaLink", "https://www.sealink.com.au"];
  return null;
}
function routeChips(segs) {
  const sum = (k) => (segs || []).reduce((a, s) => a + (s[k] || 0), 0);
  const ferry = sum("ferry_m");
  const toll = sum("toll_m");
  const gravel = sum("unpaved_m");
  return [
    ferry > 500 ? `<span class="info">${icon("ferry", 16)} Ferry ${fmtMi(ferry)}</span>` : "",
    toll > 1000 ? `<span title="Toll roads, or roads OpenStreetMap marks as paid (like national park roads)">${icon("toll", 16)} Tolls or fees on ${fmtMi(toll)}</span>` : "",
    gravel > 1500 ? `<span class="warn">${icon("gravel", 16)} ${fmtMi(gravel)} unpaved</span>` : "",
  ].join("");
}

// ---------- 3D terrain and road flyovers ----------

let terrainOn = false;
const DEM = {
  type: "raster-dem",
  tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
  encoding: "terrarium", tileSize: 256, maxzoom: 14,
  attribution: "Terrain: Mapzen terrain tiles (AWS Open Data)",
};
function applyTerrain() {
  if (!styleReady) return;
  if (terrainOn) {
    if (!map.getSource("dem")) map.addSource("dem", DEM);
    if (!map.getSource("dem-hs")) map.addSource("dem-hs", DEM);
    if (satelliteOn && map.getLayer("hillshade")) map.removeLayer("hillshade");
    if (!satelliteOn && !map.getLayer("hillshade")) {
      map.addLayer({ id: "hillshade", type: "hillshade", source: "dem-hs",
        paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": theme === "dark" ? "#000" : "#5a5a5a" } },
        map.getStyle().layers.find((l) => l.type === "symbol")?.id);
    }
    map.setTerrain({ source: "dem", exaggeration: 1.35 });
  } else {
    map.setTerrain(null);
    if (map.getLayer("hillshade")) map.removeLayer("hillshade");
  }
  document.querySelector(".ctrl-3d")?.classList.toggle("on", terrainOn);
}
function setTerrain(on) {
  terrainOn = on;
  applyTerrain();
  map.easeTo({ pitch: on ? 60 : 0, duration: 800 });
}
// ---------- satellite imagery (no keys, no accounts) ----------
// EOX Sentinel-2 cloudless everywhere (10 m, free for non-commercial use with credit; sharp to about zoom 13) and
// USGS aerial imagery over the US (public domain, sharp to street level). Drawn under the style's labels, so road and
// place names stay on top.
let satelliteOn = store.get("satellite") === "1";
const USGS_TILES = ["https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer/tile/{z}/{y}/{x}"];
const USGS_CREDIT = "Imagery: USGS The National Map";
const SAT_SOURCES = {
  "sat-eox": {
    type: "raster", tileSize: 256, maxzoom: 14,
    tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2020_3857/default/g/{z}/{y}/{x}.jpg"],
    attribution: '<a href="https://s2maps.eu" target="_blank" rel="noopener">Sentinel-2 cloudless by EOX</a> (contains modified Copernicus Sentinel data 2020)',
  },
  // the US in three boxes (lower 48, Alaska, Hawaii), so no tiles are asked for elsewhere
  "sat-usgs": { type: "raster", tileSize: 256, minzoom: 7, maxzoom: 16, tiles: USGS_TILES, bounds: [-125, 24.3, -66.8, 49.5], attribution: USGS_CREDIT },
  "sat-usgs-ak": { type: "raster", tileSize: 256, minzoom: 7, maxzoom: 16, tiles: USGS_TILES, bounds: [-170, 51, -129.9, 71.5], attribution: USGS_CREDIT },
  "sat-usgs-hi": { type: "raster", tileSize: 256, minzoom: 7, maxzoom: 16, tiles: USGS_TILES, bounds: [-160.3, 18.8, -154.7, 22.3], attribution: USGS_CREDIT },
};
function applySatellite() {
  if (!styleReady) return;
  const ids = Object.keys(SAT_SOURCES);
  if (satelliteOn) {
    // under the first label layer of the style, so names stay readable
    const firstLabel = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    for (const id of ids) {
      if (!map.getSource(id)) map.addSource(id, SAT_SOURCES[id]);
      if (!map.getLayer(id)) {
        map.addLayer({ id, type: "raster", source: id, paint: { "raster-fade-duration": 200 } }, firstLabel);
      }
    }
  } else {
    for (const id of ids) {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    }
  }
  document.querySelector(".ctrl-sat")?.classList.toggle("on", satelliteOn);
}
function setSatellite(on) {
  satelliteOn = on;
  store.set("satellite", on ? "1" : "0");
  applySatellite();
  applyTerrain(); // the hillshade is left off over photos
}
class SatelliteControl {
  onAdd() {
    this.el = document.createElement("div");
    this.el.className = "maplibregl-ctrl maplibregl-ctrl-group";
    this.el.innerHTML = `<button class="ctrl-sat" type="button" aria-label="Satellite" title="Satellite">${icon("photo", 18)}</button>`;
    this.el.querySelector("button").onclick = () => setSatellite(!satelliteOn);
    return this.el;
  }
  onRemove() {
    this.el.remove();
  }
}
map.addControl(new SatelliteControl(), "top-right");

map.on("style.load", () => {
  applySatellite();
  applyTerrain();
  drawAlongLayer();
});
class TerrainControl {
  onAdd() {
    this.el = document.createElement("div");
    this.el.className = "maplibregl-ctrl maplibregl-ctrl-group";
    this.el.innerHTML = `<button class="ctrl-3d" type="button" aria-label="3D terrain" title="3D terrain">3D</button>`;
    this.el.querySelector("button").onclick = () => setTerrain(!terrainOn);
    return this.el;
  }
  onRemove() {
    this.el.remove();
  }
}
map.addControl(new TerrainControl(), "top-right");

// Fly along a featured road in 3D: the camera follows the road, looking ahead. Any touch, scroll or Esc stops it.
let flight = null;
function stopFlight() {
  if (!flight) return;
  cancelAnimationFrame(flight.raf);
  flight.banner?.remove();
  flight = null;
}
function flyRoad(r) {
  if (!routes.scenic) return;
  const coords = routes.scenic.geometry.coordinates;
  // the longest stretch of the route on that road
  let best = null;
  for (const g of dayGroups()) {
    for (const s of daySegments(g)) {
      if (s.road === r && s.from != null && (!best || s.distance_m > best.distance_m)) best = s;
    }
  }
  if (!best) return setStatus(`The route doesn't drive ${r.name} yet.`);
  const path = coords.slice(best.from, best.to + 1).map((c) => [c[0], c[1]]);
  const cum = [0];
  for (let k = 1; k < path.length; k++) cum.push(cum[k - 1] + haversine(path[k - 1], path[k]));
  const L = cum.at(-1);
  const at = (d) => {
    d = clamp(d, 0, L);
    let k = cum.findIndex((c) => c >= d);
    if (k <= 0) return path[Math.max(0, k)];
    const f = (d - cum[k - 1]) / (cum[k] - cum[k - 1] || 1);
    return [path[k - 1][0] + f * (path[k][0] - path[k - 1][0]), path[k - 1][1] + f * (path[k][1] - path[k - 1][1])];
  };
  stopFlight();
  setView("map");
  terrainOn = true;
  applyTerrain();
  const ms = clamp((L / 1000) * 900, 20000, 120000);
  const banner = document.createElement("div");
  banner.className = "flight-banner";
  banner.innerHTML = `${icon("mountain", 16)} <b>${esc(r.name)}</b> <span>${fmtMi(L)}</span><button class="btn ghost small">Stop</button>`;
  banner.querySelector("button").onclick = stopFlight;
  document.body.appendChild(banner);
  let bearing = bearingOf(at(0), at(1500));
  map.jumpTo({ center: at(0), zoom: 13.2, pitch: 64, bearing });
  const t0 = performance.now() + 600;
  flight = { banner, raf: 0 };
  const tick = (now) => {
    if (!flight) return;
    const t = clamp((now - t0) / ms, 0, 1);
    const d = t * L;
    const want = bearingOf(at(d), at(d + 1800));
    bearing = (bearing + angleDiff(want, bearing) * 0.04 + 360) % 360;
    map.jumpTo({ center: at(d), bearing, pitch: 64, zoom: 13.2 });
    if (t < 1) flight.raf = requestAnimationFrame(tick);
    else setTimeout(stopFlight, 1200);
  };
  flight.raf = requestAnimationFrame(tick);
}
for (const ev of ["mousedown", "wheel", "touchstart"]) map.getCanvas().addEventListener(ev, stopFlight, { passive: true });
addEventListener("keydown", (e) => e.key === "Escape" && stopFlight());

// ---------- photo galleries ----------

async function openGallery(title, query, first, where = {}) {
  const box = document.createElement("div");
  box.className = "lightbox overlay";
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-label", `Photos of ${title}`);
  box.innerHTML = `<button class="icon-btn lb-close" aria-label="Close">${icon("close", 22)}</button>
    <figure><div class="lb-img"><span class="spinner"></span></div><figcaption></figcaption></figure>
    <button class="icon-btn lb-prev" aria-label="Previous photo">${icon("chevron-left", 24)}</button>
    <button class="icon-btn lb-next" aria-label="Next photo">${icon("chevron", 24)}</button>`;
  document.body.appendChild(box);
  let photos = first ? [{ src: first, page: "", title }] : [];
  let i = 0;
  const show = () => {
    const p = photos[i];
    if (!p) {
      box.querySelector(".lb-img").innerHTML = `<p>No photos found for ${esc(title)}.</p>`;
      return;
    }
    box.querySelector(".lb-img").innerHTML = `<img src="${esc(p.src)}" alt="${esc(p.title || title)}">`;
    box.querySelector("figcaption").innerHTML = `<b>${esc(title)}</b> <span>${i + 1} of ${photos.length}</span>
      ${p.page ? `<a href="${esc(p.page)}" target="_blank" rel="noopener">Photo, author and license ${icon("external", 13)}</a>` : `<span class="subtle">From Wikipedia</span>`}`;
    box.querySelector(".lb-prev").hidden = box.querySelector(".lb-next").hidden = photos.length < 2;
  };
  const close = () => {
    box.remove();
    removeEventListener("keydown", keys);
  };
  const keys = (e) => {
    if (e.key === "Escape") close();
    if (e.key === "ArrowRight") step(1);
    if (e.key === "ArrowLeft") step(-1);
  };
  const step = (d) => {
    if (!photos.length) return;
    i = (i + d + photos.length) % photos.length;
    show();
  };
  addEventListener("keydown", keys);
  box.querySelector(".lb-close").onclick = close;
  box.querySelector(".lb-prev").onclick = () => step(-1);
  box.querySelector(".lb-next").onclick = () => step(1);
  box.addEventListener("click", (e) => e.target === box && close());
  if (photos.length) show();
  try {
    const loc = (where.at ? `&at=${encodeURIComponent(where.at)}` : "") + (where.near ? `&near=${encodeURIComponent(where.near)}` : "") +
      (where.ctx ? `&ctx=${encodeURIComponent(where.ctx)}` : "");
    const d = await (await fetch(`/api/gallery?q=${encodeURIComponent(query)}${loc}`)).json();
    const more = (d.photos || []).filter((p) => !first || !p.src.split("/").pop().includes(first.split("/").pop().replace(/^\d+px-/, "")));
    photos = [...photos, ...more];
  } catch {
    // keep what we have
  }
  if (document.body.contains(box)) show();
}

// ---------- export, print and share ----------

function openExport() {
  const el = openSheet(`${sheetHead("Export and share")}
    <div class="export-list">
      <button class="export-row" data-x="gpx">${icon("route", 22)}<span><b>GPX file</b><small>For car navigation, Garmin and other GPS apps. One track per day, with the stops and spots.</small></span></button>
      <button class="export-row" data-x="print">${icon("print", 22)}<span><b>Print or save as PDF</b><small>The itinerary laid out for paper. Choose "Save as PDF" in the print window.</small></span></button>
      <button class="export-row" data-x="page">${icon("download", 22)}<span><b>Download as a web page</b><small>One file anyone can open, with the day guides, the Google and Apple Maps links and a route sketch.</small></span></button>
      <button class="export-row" data-x="lan">${icon("share", 22)}<span><b>Share on your Wi-Fi</b><small>A read-only link for phones and computers on the same network, while this PC runs the app.</small></span></button>
    </div>
    <div id="lan-box"></div>`);
  el.addEventListener("click", async (e) => {
    const x = e.target.closest("[data-x]")?.dataset.x;
    if (!x) return;
    if (x === "gpx") exportGpx();
    if (x === "print") {
      closeOverlay();
      setView("itinerary");
      setTimeout(() => print(), 300);
    }
    if (x === "page") downloadPage();
    if (x === "lan") {
      await flushSave();
      const d = await (await fetch("/api/lan")).json().catch(() => ({ ips: [] }));
      const links = (d.ips || []).map((ip) => `http://${ip}:${d.port}/?trip=${trip.id}&view=read`);
      el.querySelector("#lan-box").innerHTML = links.length
        ? `<div class="lan-links">${links.map((l) => `<div class="lan-link"><input readonly value="${esc(l)}" aria-label="Share link"><button class="btn blue small" data-copy="${esc(l)}">Copy</button></div>`).join("")}
            <p class="fine">Opens a read-only copy of this trip. It works while this PC is on and the app is running, for devices on the same Wi-Fi.
            If it doesn't load, allow Node.js through Windows Firewall for private networks.</p></div>`
        : `<p class="fine">This PC doesn't seem to be on a network right now.</p>`;
    }
  });
  el.addEventListener("click", async (e) => {
    const b = e.target.closest("[data-copy]");
    if (!b) return;
    try {
      await navigator.clipboard.writeText(b.dataset.copy);
      b.textContent = "Copied";
    } catch {
      b.previousElementSibling?.select();
    }
  });
}

// A route sketch (no map tiles): each day's line in its own color, the overnight stops and their names.
function routeSketch() {
  const r = routes.scenic;
  if (!r) return "";
  const W = 900;
  const H = 520;
  const all = r.geometry.coordinates;
  const lat0 = all.reduce((a, c) => a + c[1], 0) / all.length;
  const kx = Math.cos(lat0 * deg);
  const xs = all.map((c) => c[0] * kx);
  const ys = all.map((c) => c[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const s = Math.min((W - 80) / (x1 - x0 || 1), (H - 80) / (y1 - y0 || 1));
  const P = (c) => [40 + (c[0] * kx - x0) * s, H - 40 - (c[1] - y0) * s];
  const colors = ["#0a84ff", "#30d1c6", "#ff9f0a", "#bf5af2", "#30d158", "#ff375f", "#ffd60a", "#64d2ff"];
  const legs = legsByEnd(r);
  const lines = dayGroups().map((g, gi) => {
    const dl = g.items.map((i) => legs.get(i)).filter(Boolean);
    if (!dl.length) return "";
    const seg = all.slice(dl[0].from, dl.at(-1).to + 1);
    const step = Math.max(1, Math.floor(seg.length / 400));
    const pts = seg.filter((_, k) => k % step === 0 || k === seg.length - 1).map((c) => P(c).map((v) => v.toFixed(1)).join(",")).join(" ");
    return `<polyline points="${pts}" fill="none" stroke="${colors[gi % colors.length]}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join("");
  const nights = dayGroups().map((g) => stops[g.items.at(-1)]);
  const dots = [stops[0], ...nights].map((p, i) => {
    const [x, y] = P([p.lng, p.lat]);
    return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6" fill="#fff" stroke="#111" stroke-width="2"/>
      <text x="${(x + 9).toFixed(1)}" y="${(y - 8).toFixed(1)}" font-size="15" font-weight="700" fill="currentColor">${i === 0 ? "Start: " : ""}${esc(shortName(p.name))}</text>`;
  }).join("");
  return `<svg class="sketch" viewBox="0 0 ${W} ${H}" role="img" aria-label="Route sketch">${lines}${dots}</svg>`;
}

async function downloadPage() {
  setView("itinerary");
  renderItinerary();
  const css = await (await fetch("/style.css")).text().catch(() => "");
  // the cost table open, and nothing that needs the app (renaming, the chart's cursor, the cost inputs)
  const body = IT.innerHTML.replace(/<details class="cost-card"(?! open)/g, '<details class="cost-card" open');
  const html = `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(trip.name)}</title><style>${css}
body{overflow:auto} #itinerary{position:static;padding-top:24px} .snapshot button,.snapshot form,.snapshot .roads-panel,.snapshot .hero-actions,.snapshot .settings-strip .btn,.snapshot .notes-add,.snapshot .rc-form,.snapshot .rc-side,.snapshot .cost-inputs,.snapshot .pf-tip,.snapshot .pf-cursor,.snapshot .tl-go{display:none!important}
.snapshot .profile{cursor:default}.snapshot .day-index:hover{width:290px}
.sketch-wrap{max-width:1240px;margin:16px auto 0;padding:0 16px}.sketch{width:100%;height:auto;background:var(--surface);border-radius:12px;color:var(--text)}
</style></head><body><main id="itinerary" class="snapshot">${body.replace(/<section class="request-card"/, `<div class="sketch-wrap">${routeSketch()}</div><section class="request-card"`)}</main></body></html>`;
  downloadFile(html, `${fileName()}.html`, "text/html");
}

// ---------- versions: compare and restore earlier plans ----------

function versionTotals() {
  const groups = dayGroups();
  const t = routes.scenic ? tripTotals(groups) : null;
  return {
    days: groups.length,
    dist: t?.dist ?? null,
    dur: t?.dur ?? null,
    featured: t?.featured ?? null,
    freeway: t?.freeway ?? null,
    hours: groups.map((g) => Math.round(((dayStats(g, "scenic")?.dur || 0) / 3600) * 10) / 10),
    roads: (plan?.roads || []).map((r) => r.name),
    spots: (plan?.spots || []).length,
  };
}
// Keep the trip as it is now, before a change replaces it (the last 6 are kept with the trip).
function snapshotVersion(label) {
  if (!plan || !stops.length || READONLY) return;
  const { sources, along, ...rest } = plan;
  trip.versions = [...(trip.versions || []), {
    id: newId(),
    at: new Date().toISOString(),
    label: String(label || "Earlier version").slice(0, 200),
    stops: stops.map(({ name, lng, lat, note, photoQuery, kind, day, road, photos }) => ({ name, lng, lat, note, photoQuery, kind, day, road, photos })),
    plan: structuredClone(rest),
    totals: versionTotals(),
  }].slice(-6);
}
function openVersions(selectedId) {
  const vs = [...(trip.versions || [])].reverse();
  if (!vs.length) return;
  const v = vs.find((x) => x.id === selectedId) || vs[0];
  const now = versionTotals();
  const was = v.totals || {};
  const row = (label, a, b, fmt = (x) => x) =>
    `<tr><th>${label}</th><td>${a == null ? "—" : fmt(a)}</td><td>${b == null ? "—" : fmt(b)}</td></tr>`;
  const pct = (a, d) => (a == null || !d ? null : `${Math.round((a / d) * 100)}%`);
  const added = now.roads.filter((r) => !(was.roads || []).includes(r));
  const removed = (was.roads || []).filter((r) => !now.roads.includes(r));
  const bars = (hours) => `<div class="v-bars">${(hours || []).map((h, i) => `<span style="height:${clamp((h / 10) * 100, 4, 100)}%" title="Day ${i + 1}: ${h} h"></span>`).join("")}</div>`;
  const when = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const el = openSheet(`${sheetHead("Versions")}
    <div class="versions">
      <ol class="v-list">${vs.map((x) => `<li><button class="${x.id === v.id ? "on" : ""}" data-v="${x.id}"><b>${esc(x.label)}</b><small>Before this change · ${esc(when(x.at))}</small></button></li>`).join("")}</ol>
      <div class="v-compare">
        <table><thead><tr><th></th><th>That version</th><th>Now</th></tr></thead><tbody>
          ${row("Days", was.days, now.days)}
          ${row("Distance", was.dist, now.dist, fmtMi)}
          ${row("Driving", was.dur, now.dur, fmtShort)}
          ${row("Featured roads", pct(was.featured, was.dist), pct(now.featured, now.dist))}
          ${row("Freeway", pct(was.freeway, was.dist), pct(now.freeway, now.dist))}
          ${row("Spots", was.spots, now.spots)}
          <tr><th>Hours a day</th><td>${bars(was.hours)}</td><td>${bars(now.hours)}</td></tr>
        </tbody></table>
        ${added.length || removed.length ? `<p class="v-roads">${removed.length ? `<span class="minus">Only then: ${esc(removed.join(", "))}</span>` : ""}${added.length ? `<span class="plus">Only now: ${esc(added.join(", "))}</span>` : ""}</p>` : `<p class="fine">Same featured roads.</p>`}
        ${READONLY ? "" : `<div class="sheet-actions"><button class="btn blue" data-restore="${v.id}">${icon("refresh", 18)} Restore that version</button></div>`}
      </div>
    </div>`, "wide");
  el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-v]");
    if (b) openVersions(b.dataset.v);
    const r = e.target.closest("[data-restore]");
    if (r) restoreVersion(r.dataset.restore);
  });
}
async function restoreVersion(id) {
  const v = (trip.versions || []).find((x) => x.id === id);
  if (!v || (progress && !progress.error)) return;
  closeOverlay();
  snapshotVersion("Restored an earlier version");
  stops.length = 0;
  stops.push(...v.stops.map((s) => ({ ...s })));
  normalizeDays();
  plan = { ...structuredClone(v.plan), sources: plan?.sources || [] };
  trip.edits = [...(trip.edits || []), { text: `Restored the version from before "${v.label}"`, at: new Date().toISOString() }];
  clearRoutes();
  renderStops();
  renderSpotMarkers();
  await findRoutes({ fit: false });
  scheduleSave();
  renderItinerary();
}

// ---------- notes and checklist ----------

const notesOf = () => (trip.notes ||= { text: "", items: [] });
function notesSection() {
  const n = notesOf();
  const done = n.items.filter((x) => x.done).length;
  return `<section class="notes" id="notes">
    <h3>${icon("list", 18)} Notes and checklist ${n.items.length ? `<small>${done} of ${n.items.length} done</small>` : ""}</h3>
    <div class="notes-grid">
      <textarea id="notes-text" rows="6" placeholder="Reservations, confirmation numbers, people to visit..." ${READONLY ? "readonly" : ""}>${esc(n.text)}</textarea>
      <div>
        <ul class="checklist">${n.items.map((x, i) => `<li class="${x.done ? "done" : ""}">
          <label><input type="checkbox" data-check="${i}" ${x.done ? "checked" : ""} ${READONLY ? "disabled" : ""}> <span>${esc(x.text)}</span></label>
          ${READONLY ? "" : `<button class="icon-btn small" data-uncheck="${i}" aria-label="Remove ${esc(x.text)}">${icon("close", 14)}</button>`}</li>`).join("")}</ul>
        ${READONLY ? "" : `<form class="notes-add" id="notes-add"><input id="notes-item" placeholder="Add an item" aria-label="Add a checklist item">
          <button class="btn ghost small" type="submit">${icon("plus", 16)} Add</button>
          <button class="btn ghost small" type="button" data-act="suggest-items">${icon("sparkle", 16)} Suggest items</button></form>`}
      </div>
    </div>
  </section>`;
}
// Checklist ideas from what's on this trip.
function suggestedItems() {
  const text = JSON.stringify([plan?.roads, plan?.spots?.map((s) => s.name), stops.map((s) => s.name)]).toLowerCase();
  const out = [];
  const groups = dayGroups();
  const countries = new Set(stops.map(countryOf));
  if (countries.has("US") && /national park/.test(text)) out.push("America the Beautiful pass (US national parks)");
  if (countries.has("CA") && /national park|banff|jasper|yoho|kootenay|pacific rim/.test(text)) out.push("Parks Canada Discovery Pass or day passes");
  if (/trail ridge|rocky mountain national/.test(text)) out.push("Rocky Mountain NP timed entry reservation (summer)");
  if (/going-to-the-sun|glacier national park/.test(text)) out.push("Glacier NP vehicle reservation for Going-to-the-Sun Road (summer)");
  if (/arches national park/.test(text)) out.push("Arches NP timed entry reservation (spring to fall)");
  if (/mount blue sky|mount evans/.test(text)) out.push("Mount Blue Sky timed entry reservation");
  if (/moraine lake/.test(text)) out.push("Parks Canada shuttle to Moraine Lake and Lake Louise");
  const seasonal = groups.flatMap((g) => seasonalForDay(g, routes.scenic ? daySegments(g) : []));
  if (seasonal.some((x) => x.status === "caution")) out.push("Winter tires or snow chains");
  if (routes.scenic?.ferry_m > 500) out.push("Ferry reservation");
  if (tripSettings().ev) out.push("Charging apps and cables (and a NACS/CCS adapter if you need one)");
  if (groups.some((g) => alongFor(g.day)?.fuelGap.len > 160000)) out.push("Fill up before the long stretches without fuel");
  if (routes.scenic?.unpaved_m > 1500) out.push("Check the car is fine on gravel (or plan around the unpaved stretch)");
  if ((wx.results || []).some((w) => w?.tmax >= 33)) out.push("Extra water for hot days");
  if ((wx.results || []).some((w) => w?.tmin != null && w.tmin <= 2)) out.push("Warm layers for cold mornings");
  if (countries.size > 1) out.push("Passport and car insurance for every country");
  out.push("Offline maps downloaded in Google or Apple Maps", "Phone mount and car charger", "Sunglasses, water and snacks", "Lodging booked for every night");
  const have = new Set(notesOf().items.map((x) => x.text.toLowerCase()));
  return out.filter((x) => !have.has(x.toLowerCase()));
}
IT.addEventListener("input", (e) => {
  if (e.target.id === "notes-text") {
    notesOf().text = e.target.value;
    scheduleSave();
  }
});
IT.addEventListener("change", (e) => {
  const i = e.target.dataset?.check;
  if (i == null) return;
  notesOf().items[Number(i)].done = e.target.checked;
  scheduleSave();
  renderItinerary();
});
IT.addEventListener("submit", (e) => {
  if (e.target.id !== "notes-add") return;
  e.preventDefault();
  const v = $("notes-item").value.trim();
  if (!v) return;
  notesOf().items.push({ text: v.slice(0, 300), done: false });
  scheduleSave();
  renderItinerary();
  $("notes-item")?.focus();
});
IT.addEventListener("click", (e) => {
  const rm = e.target.closest("[data-uncheck]");
  if (rm) {
    notesOf().items.splice(Number(rm.dataset.uncheck), 1);
    scheduleSave();
    renderItinerary();
  }
});

// ---------- ready-made trips (presets) and batch building ----------

const presetState = { list: null, loading: false, region: "all", days: "all" };
const REGION_NAMES = { US: "United States", CA: "Canada", AU: "Australia", NZ: "New Zealand", GB: "United Kingdom", ALPS: "The Alps", NO: "Norway", IS: "Iceland", IE: "Ireland", ES: "Spain", PT: "Portugal" };
function loadPresets() {
  if (presetState.list || presetState.loading) return;
  presetState.loading = true;
  fetch("/api/presets")
    .then((r) => r.json())
    .then((d) => (presetState.list = d.presets || []))
    .catch(() => (presetState.list = []))
    .finally(() => {
      presetState.loading = false;
      if (!stops.length && !plan && !progress) renderItinerary();
    });
}
const ALPS = new Set(["CH", "AT", "LI", "IT", "FR", "DE"]);
const presetRegion = (p) => {
  const c = p.start ? countryOf(p.start) : null;
  return ALPS.has(c) ? "ALPS" : c || "other";
};
function presetsHtml() {
  loadPresets();
  const list = presetState.list || [];
  if (!list.length) return "";
  const regions = [...new Set(list.map(presetRegion))];
  const daysOk = (p) => presetState.days === "all" || (presetState.days === "short" ? p.days <= 3 : presetState.days === "mid" ? p.days >= 4 && p.days <= 6 : p.days >= 7);
  const shown = list.filter((p) => (presetState.region === "all" || presetRegion(p) === presetState.region) && daysOk(p));
  const chip = (attr, val, label, on) => `<button class="chip ${on ? "on" : ""}" data-act="preset-filter" data-${attr}="${val}">${esc(label)}</button>`;
  return `<section class="presets">
    <h2>${icon("route", 22)} Ready-made trips <small>open instantly, no waiting for the AI</small></h2>
    <div class="preset-filters">
      ${chip("region", "all", "Everywhere", presetState.region === "all")}
      ${regions.map((r) => chip("region", r, REGION_NAMES[r] || "Elsewhere", presetState.region === r)).join("")}
      <span class="sep"></span>
      ${chip("days", "all", "Any length", presetState.days === "all")}${chip("days", "short", "1 to 3 days", presetState.days === "short")}
      ${chip("days", "mid", "4 to 6 days", presetState.days === "mid")}${chip("days", "long", "7+ days", presetState.days === "long")}
    </div>
    <div class="preset-grid">${shown.map((p) => {
      // each card in its own country's units (the start screen has no trip to take them from)
      const c = p.start ? countryOf(p.start) : "US";
      const dist = !p.distance_m ? "" : c === "US" || c === "GB" ? `${Math.round(p.distance_m / 1609.34).toLocaleString()} mi` : `${Math.round(p.distance_m / 1000).toLocaleString()} km`;
      return `<button class="preset" data-act="preset-open" data-id="${esc(p.id)}">
      <span class="preset-img">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy" onerror="this.remove()">` : ""}</span>
      <span class="preset-body"><b>${esc(p.name)}</b>
        <small>${p.days} day${p.days === 1 ? "" : "s"}${dist ? ` · ${dist}` : ""}${p.duration_s ? ` · ${fmtShort(p.duration_s)} driving` : ""}</small>
        <span class="preset-sum">${esc(p.summary)}</span></span></button>`;
    }).join("") || `<p class="fine">No ready-made trips match.</p>`}</div>
  </section>`;
}
async function openPreset(id) {
  try {
    const d = await api(`/api/trips/${id}/duplicate`, {});
    await openTrip(d.id);
    setStatus("Opened a copy of the ready-made trip. Change it as much as you like.");
  } catch (e) {
    setStatus(e.message);
  }
}

// Batch mode (open the app with ?batch=1): plans a list of trips one after another and saves each as a ready-made trip.
// Leave it running (overnight works); trips already built are skipped, so it can be stopped and started again.
const BATCH = new URLSearchParams(location.search).get("batch") === "1";
const batchState = { running: false, stop: false, log: [] };
const BATCH_SUGGESTIONS = [
  "San Francisco to Los Angeles on the Pacific Coast Highway in 3 days",
  "Seattle to San Diego on the Pacific Coast Highway in 8 days",
  "Denver to Moab in 3 days over the San Juan Skyway and Million Dollar Highway",
  "Salt Lake City loop through Zion, Bryce Canyon, Capitol Reef and Arches in 6 days",
  "Las Vegas loop to the Grand Canyon, Page and Zion in 4 days",
  "Jackson Hole to Yellowstone and the Beartooth Highway, ending in Billings, 3 days",
  "Glacier National Park and Going-to-the-Sun Road from Missoula, 3 day loop",
  "Asheville loop on the Blue Ridge Parkway, the Tail of the Dragon and the Cherohala Skyway in 3 days",
  "Washington DC to Asheville on Skyline Drive and the Blue Ridge Parkway in 4 days",
  "Boston loop through the White Mountains, the Kancamagus Highway and Vermont in 4 days for fall colors",
  "New York City to Acadia National Park along the coast of Maine in 4 days",
  "Austin loop through the Texas Hill Country and the Twisted Sisters in 2 days",
  "Phoenix to Sedona, Flagstaff and the Grand Canyon in 3 days",
  "Portland loop to Crater Lake, the Oregon coast and Mount Hood in 5 days",
  "Chicago to the Door Peninsula and the Lake Michigan shore in 3 days",
  "Miami to Key West on the Overseas Highway, 2 days",
  "San Francisco loop through Yosemite, Tioga Pass and Lake Tahoe in 4 days",
  "Los Angeles loop through Death Valley and the Eastern Sierra in 4 days",
  "Vancouver to Calgary through the Rockies in 4 days: Sea-to-Sky, Icefields Parkway and Highwood Pass",
  "Calgary loop through Banff, Jasper and the Icefields Parkway in 4 days",
  "Vancouver Island from Victoria to Tofino and back, 3 days",
  "Toronto to Quebec City the long way: Algonquin, the Thousand Islands and Charlevoix",
  "Montreal loop around the Gaspé Peninsula in 6 days",
  "Halifax loop around the Cabot Trail on Cape Breton Island in 4 days",
  "Sydney to Melbourne the scenic way in 5 days: Blue Mountains, Snowy Mountains and the Great Ocean Road",
  "Melbourne loop on the Great Ocean Road and the Grampians in 4 days",
  "Melbourne loop through the Victorian High Country and the Great Alpine Road in 3 days",
  "Brisbane loop through the Gold Coast hinterland and the Sunshine Coast in 3 days",
  "Hobart loop around Tasmania's east coast and Cradle Mountain in 6 days",
  "Christchurch to Queenstown via Aoraki Mount Cook and the West Coast in 5 days",
  "Queenstown to Milford Sound and back via Te Anau, 2 days",
  "Edinburgh loop through the Scottish Highlands and the North Coast 500 in 7 days",
  "Lake District and Yorkshire Dales loop from Manchester in 3 days",
  "Zurich loop over the Furka, Grimsel and Susten passes in 2 days",
  "Innsbruck to Lake Como over the Stelvio Pass and the Dolomites in 4 days",
];
function batchHtml() {
  const s = { ...DEFAULT_SETTINGS, ...rememberedSettings() };
  return `<section class="start batch">
    <div class="start-inner">
      <p class="kicker">${icon("sparkle", 16)} Batch mode</p>
      <h1>Build ready-made trips</h1>
      <p class="lede">One trip per line. Each is planned with the full planner and saved as a ready-made trip that opens instantly from the start screen.
        Trips already built are skipped. A trip takes about 3 to 6 minutes, so 30 trips is a few hours: leave it running.</p>
      <form class="prompt-box" id="batch-form">
        <textarea id="batch-list" rows="10" aria-label="Trips to build, one per line" ${batchState.running ? "disabled" : ""}>${esc(store.get("batchList") || "")}</textarea>
        ${optionsForm(s)}
        <div class="batch-actions">
          <button class="btn ghost" type="button" data-act="batch-suggest" ${batchState.running ? "disabled" : ""}>Use the suggested list</button>
          ${batchState.running ? `<button class="btn warn" type="button" data-act="batch-stop">Stop after this trip</button>` : `<button class="btn blue" type="submit">${icon("sparkle", 18)} Start building</button>`}
        </div>
      </form>
      <ol class="batch-log">${batchState.log.map((l) => `<li class="${l.state}"><b>${esc(l.prompt)}</b><small>${esc(l.note || "")}</small></li>`).join("")}</ol>
      <p class="fine"><a href="/">Back to the planner</a></p>
    </div>
  </section>`;
}
async function runBatch(prompts, settings) {
  if (batchState.running) return;
  batchState.running = true;
  batchState.stop = false;
  const have = new Set(((await (await fetch("/api/presets")).json()).presets || []).map((p) => p.prompt.trim().toLowerCase()));
  batchState.log = prompts.map((p) => ({ prompt: p, state: have.has(p.toLowerCase()) ? "skip" : "todo", note: have.has(p.toLowerCase()) ? "Already built" : "" }));
  renderItinerary();
  for (const item of batchState.log) {
    if (batchState.stop) break;
    if (item.state === "skip") continue;
    item.state = "doing";
    item.note = "Planning...";
    const t0 = Date.now();
    await newTrip();
    await planTrip(item.prompt, settings);
    if (progress?.error) {
      item.state = "error";
      item.note = progress.error;
      progress = null;
      // a half-built trip isn't worth keeping in the trips list
      await fetch(`/api/trips/${trip.id}`, { method: "DELETE" }).catch(() => {});
    } else {
      trip.preset = true;
      await saveNow();
      item.state = "done";
      item.note = `${trip.name}, ${Math.round((Date.now() - t0) / 60000)} min`;
    }
    setView("itinerary");
  }
  batchState.running = false;
  presetState.list = null;
  await newTrip();
}
IT.addEventListener("submit", (e) => {
  if (e.target.id !== "batch-form") return;
  e.preventDefault();
  const list = $("batch-list").value.split("\n").map((x) => x.trim()).filter(Boolean);
  store.set("batchList", $("batch-list").value);
  if (list.length) runBatch(list, readOptions(e.target));
});

// ---------- ask the trip: questions answered from the trip itself ----------

// A compact text summary of the trip for the AI: each day's drive, points, overnight, stops, weather, fuel and places
// to stay and eat (whatever the app has measured or looked up so far).
function tripContext() {
  const s = tripSettings();
  const lines = [`Trip: ${trip.name}. The request: "${trip.prompt || ""}".`];
  const opts = [
    s.startDate ? `starts ${s.startDate} at ${s.startTime}` : "no dates set",
    `at most ${s.maxHours} h driving a day`,
    s.noNight ? "no driving after dark" : "",
    s.ev ? `electric car, range ${s.evRange} km` : "",
    (s.styles || []).length ? `style: ${s.styles.join(", ")}` : "",
  ].filter(Boolean);
  lines.push(`Options: ${opts.join("; ")}.`);
  dayGroups().forEach((g, gi) => {
    const st = dayStats(g, "scenic");
    const meta = plan?.days?.find((d) => Number(d.day) === g.day);
    const w = dayWeather(gi);
    const al = alongFor(g.day);
    const spots = (plan?.spots || []).filter((x) => x.day === g.day).map((x) => `${x.name}${x.minutes ? ` (${x.minutes} min)` : ""}`);
    lines.push([
      `Day ${g.day}${dayDate(g.day) ? ` (${dayDate(g.day)})` : ""}: ${meta?.title || ""}.`,
      st ? `Driving ${fmtDur(st.dur)}, ${fmtMi(st.dist)}.` : "",
      `Points: ${g.items.map((i) => shortName(stops[i].name)).join(", ")}. Overnight: ${stops[g.items.at(-1)].name}.`,
      spots.length ? `Stops along the way: ${spots.join(", ")}.` : "",
      w?.tmax != null ? `Weather (${w.kind === "forecast" ? "forecast" : "typical"}): ${fmtTemp(w.tmax)} / ${fmtTemp(w.tmin)}, ${Math.round(w.rain || 0)}% rain.` : "",
      al?.fuelGap?.len ? `Longest stretch without fuel: ${fmtMi(al.fuelGap.len)} (${al.fuelGap.a} to ${al.fuelGap.b}).` : "",
      al?.stay?.length ? `Places to stay near the overnight: ${al.stay.slice(0, 5).map((x) => x.name).join(", ")}.` : "",
      al?.food?.length ? `Food in town: ${al.food.slice(0, 5).map((x) => `${x.name} (${x.cuisine})`).join(", ")}.` : "",
      meta?.summary ? `Guide: ${meta.summary}` : "",
    ].filter(Boolean).join(" "));
  });
  if (plan?.roads?.length) {
    lines.push(`Featured roads: ${plan.roads.map((r) => `${r.name}${r.ref ? ` (${r.ref})` : ""}${r.days?.length ? `, day ${r.days.join("/")}` : ""}`).join("; ")}.`);
  }
  return lines.join("\n").slice(0, 12000);
}

const askState = { mode: "change", busy: false, error: "" };
const getAskState = () => askState;
async function askTrip(question) {
  if (!plan || askState.busy) return;
  Object.assign(askState, { busy: true, error: "", pending: question });
  renderItinerary();
  try {
    const d = await api("/api/ask", { question, context: tripContext() });
    trip.qa = [...(trip.qa || []), { q: question, a: d.answer, change: d.change || "", at: new Date().toISOString() }].slice(-12);
    if (!READONLY) scheduleSave();
  } catch (e) {
    askState.error = e.message;
  }
  Object.assign(askState, { busy: false, pending: "" });
  renderItinerary();
}
// The questions so far, newest first, with "Make this change" when the answer suggests one.
function qaHtml() {
  const qa = [...(trip.qa || [])].reverse();
  if (!qa.length && !askState.busy && !askState.error) return "";
  return `<ol class="qa">
    ${askState.busy ? `<li><b>${esc(askState.pending)}</b><p class="subtle"><span class="spinner"></span> Thinking about your trip...</p></li>` : ""}
    ${askState.error ? `<li><p class="su-bad">${esc(askState.error)}</p></li>` : ""}
    ${qa.map((x, i) => `<li><b>${esc(x.q)}</b><p>${esc(x.a).replace(/\n+/g, "<br>")}</p>
      ${x.change && !READONLY ? `<button class="link-btn" data-act="qa-change" data-i="${qa.length - 1 - i}">${icon("refresh", 14)} Make this change: ${esc(x.change)}</button>` : ""}</li>`).join("")}
  </ol>`;
}

window.qaHtmlFn = qaHtml;

// ---------- live changes: "skip Winnipeg" applied in place ----------
// The trip stays on screen while the AI changes it: a bar at the bottom shows the steps, then what changed with an
// Undo (the version saved just before). The day guides and photos catch up in the background.

const liveState = { busy: false, step: "", text: "", quote: "", result: "", error: "", bg: "", undo: null, last: null, run: 0 };
function renderLiveBar() {
  const el = $("live-bar");
  if (!el) return;
  const s = liveState;
  el.hidden = !s.busy && !s.result && !s.error;
  el.innerHTML = s.error
    ? `${icon("alert", 16)}<span>${esc(s.error)}</span><button class="link-btn" data-live="retry">Try again</button><button class="lb-x" data-live="close" aria-label="Close">×</button>`
    : s.busy
      ? `<span class="spinner"></span><span><b>${esc(s.step)}</b> ${esc(s.text)}</span>`
      : `${icon("check", 16)}<span>${esc(s.result)}${s.bg ? ` <small>${esc(s.bg)}</small>` : ""}</span>
         ${s.undo ? `<button class="link-btn" data-live="undo">Undo</button>` : ""}<button class="lb-x" data-live="close" aria-label="Close">×</button>`;
}
// later steps keep the traveler's quoted request, not a note about the first step
function liveStep(step) {
  liveState.step = step;
  liveState.text = liveState.quote;
  renderLiveBar();
}
const liveChange = (text) => liveRevise({ feedback: text });
// Every AI change to an existing trip goes through here (revisePlan in app.js too): the traveler's words (feedback),
// road picks (roadEdits), measured drive times (dayHours, nightDays). `title` and `note` describe it in the bar.
async function liveRevise(opts = {}) {
  const { feedback = "", roadEdits = null, dayHours = null, nightDays = null, title = "", note = "", skel = null } = opts;
  if (READONLY || !plan || liveState.busy || (progress && !progress.error)) return;
  const run = ++liveState.run;
  const before = routes.scenic?.distance_m || 0;
  const label = feedback || roadEditText(roadEdits) || note || title || "Changed the trip";
  Object.assign(liveState, {
    busy: true, step: title || "Asking the AI", quote: feedback ? `“${feedback}”` : "",
    text: note || (feedback ? `“${feedback}”` : ""),
    result: "", error: "", bg: "", undo: null, last: opts,
  });
  renderLiveBar();
  renderItinerary();
  try {
    // a plan made already (a version picked in "Other versions") skips the AI
    const resp = skel ? { plan: skel, sources: [] } : await api("/api/plan", {
      prompt: trip.prompt || trip.name, current: skeletonOf(), feedback, roadEdits, dayHours, nightDays,
      states: tripStates(), settings: tripSettings(),
    });
    snapshotVersion(label); // the trip as it was, for Undo
    const undo = trip.versions?.at(-1)?.id || null;
    const edit = feedback || roadEditText(roadEdits);
    if (edit) trip.edits = [...(trip.edits || []), { text: edit, at: new Date().toISOString() }];
    liveStep("Placing the stops");
    await placePoints(resp.plan);
    addSources(resp.sources);
    liveStep("Measuring the drive");
    if (!(await findRoutes({ fit: false }))) throw new Error($("status").textContent || "Routing failed.");
    // the AI doesn't always route through the roads that were picked, so check and add them
    if (roadEdits?.add?.length) {
      liveStep("Making sure the route drives your roads");
      if ((await enforceRoads(roadEdits.add)).length) await findRoutes({ fit: false });
    }
    // and every featured road the new route misses
    await driveFeaturedRoads(liveStep);
    // long days that moving the overnights can fix are fixed right away, without asking the AI again
    if (longDays().length) balanceDays();
    renderSpotMarkers();
    scheduleSave();
    const km = routes.scenic?.distance_m || 0;
    const diff = km - before;
    const n = dayGroups().length;
    const long = longDays();
    Object.assign(liveState, {
      busy: false, undo,
      result: `Updated: ${n} day${n > 1 ? "s" : ""}, ${fmtMi(km)}${before && Math.abs(diff) > 1000 ? ` (${diff > 0 ? "+" : "−"}${fmtMi(Math.abs(diff))})` : ""}.` +
        (long.length ? ` Day ${long.join(", ")} ${long.length > 1 ? "are" : "is"} long.` : ""),
      bg: "Rewriting the day guides...",
    });
    renderLiveBar();
    renderItinerary();
    // the guides and photos catch up; a newer change takes over from here
    const d = await requestDetails(trip.prompt || trip.name, skeletonOf());
    if (run !== liveState.run) return;
    if (!d.error) {
      mergeDetails(d.details);
      addSources(d.sources);
    }
    liveState.bg = "Finding photos...";
    renderLiveBar();
    renderItinerary();
    await enrichPlan().catch(() => {});
    if (run !== liveState.run) return;
    liveState.bg = "";
    renderLiveBar();
    renderSpotMarkers();
    renderItinerary();
    scheduleSave();
  } catch (e) {
    if (run !== liveState.run) return;
    Object.assign(liveState, { busy: false, error: e.message });
    renderLiveBar();
    renderItinerary();
  }
}
// "Fix long days" when moving the overnights is enough: instant, no AI. Undo like any change; the day guides catch up.
function balanceLive() {
  if (READONLY || !plan || liveState.busy) return false;
  snapshotVersion("Moved the overnights to shorten long days");
  const undo = trip.versions?.at(-1)?.id || null;
  if (!balanceDays()) {
    trip.versions.pop(); // nothing changed
    return false;
  }
  const run = ++liveState.run;
  const worst = Math.max(...dayGroups().map((g) => dayStats(g, "scenic")?.dur || 0));
  Object.assign(liveState, { busy: false, error: "", undo, result: `Moved the overnights: the longest day is now ${fmtDur(worst)}.`, bg: "Rewriting the day guides..." });
  renderStops();
  renderItinerary();
  renderLiveBar();
  scheduleSave();
  requestDetails(trip.prompt || trip.name, skeletonOf()).then((d) => {
    if (run !== liveState.run) return;
    if (!d.error) mergeDetails(d.details);
    liveState.bg = "";
    renderLiveBar();
    renderItinerary();
    scheduleSave();
  });
  return true;
}

$("live-bar")?.addEventListener("click", async (e) => {
  const act = e.target.closest("[data-live]")?.dataset.live;
  if (act === "close") Object.assign(liveState, { result: "", error: "" });
  if (act === "retry") return liveRevise(liveState.last);
  if (act === "undo" && liveState.undo) {
    const id = liveState.undo;
    liveState.run++; // stop the background work of the change being undone
    Object.assign(liveState, { busy: true, step: "Undoing", text: "", undo: null, bg: "" });
    renderLiveBar();
    await restoreVersion(id);
    Object.assign(liveState, { busy: false, result: "Undone." });
  }
  renderLiveBar();
});
$("change-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("change-text").value.trim();
  if (!text) return;
  $("change-text").value = "";
  liveChange(text);
});

// ---------- other versions of the trip, side by side ----------
// Three alternatives from the AI (asked in parallel), each placed and measured without touching the trip, then compared
// with the current one. "Use this version" applies it like any live change, with Undo.

const VARIANTS = [
  { key: "easy", label: "Easier days", ask: "Make a version with less driving each day: keep the highlights the request names, drop the weaker detours, and spread the driving evenly." },
  { key: "scenic", label: "More scenic", ask: "Make a version that drives more of the region's best scenic roads and passes, even if it adds some driving, while keeping every day under the daily limit." },
  { key: "other", label: "Another way", ask: "Make a version that takes a noticeably different route between the same start and end, through other scenic roads and towns, keeping every place the request names." },
];
const altState = { items: [], el: null };

// Points placed on the map (cached place search, chosen along the route) and the scenic route, for a plan that
// isn't the trip: { points, route, days: [{ day, hours, overnight }] }.
async function measureSkeleton(skel) {
  const pts = [];
  for (const s of skel.points || []) {
    try {
      const cands = await geocodeAll(s.name);
      pts.push({ name: s.name, kind: s.kind === "via" ? "via" : "stop", day: Number(s.day) || 1, road: s.road || "", ...cands[0], cands });
    } catch {
      // a place the map doesn't know is left out, as when planning
    }
  }
  pickAlongRoute(pts);
  dropDetours(pts);
  if (pts.length < 2) throw new Error("Couldn't place this version on the map.");
  const route = await api("/api/route", { coordinates: pts.map((p) => [p.lng, p.lat]), mode: "scenic" });
  // the longest day once the app moves the overnights (it does when this version is used), if that's shorter
  const L = [0, ...route.legs.map((l) => l.duration_s)];
  const nDays = new Set(pts.map((p) => p.day)).size;
  const balanced = !askedDays(trip.prompt) || nDays === askedDays(trip.prompt) ? bestSplit(L, pts.map((p) => p.kind === "via"), nDays) : null;
  const days = new Map();
  route.legs.forEach((l, k) => {
    const p = pts[k + 1];
    const d = days.get(p.day) || { day: p.day, secs: 0, overnight: "" };
    d.secs += l.duration_s;
    d.overnight = p.name;
    days.set(p.day, d);
  });
  return { points: pts, route, days: [...days.values()], balanced };
}
// The numbers compared for one version.
function versionSummary(skel, m) {
  const secs = m.days.map((d) => d.secs);
  return {
    days: (skel.days || []).length || m.days.length,
    secs: m.route.duration_s,
    km: m.route.distance_m,
    longest: Math.min(Math.max(0, ...secs), m.balanced?.worst ?? Infinity),
    freeway: m.route.distance_m ? Math.round((100 * (m.route.highway_m || 0)) / m.route.distance_m) : 0,
    roads: (skel.roads || []).map((r) => r.name),
    overnights: m.balanced && m.balanced.worst < Math.max(0, ...secs)
      ? m.balanced.ends.slice(0, -1).map((i) => shortName(m.points[i].name))
      : m.days.slice(0, -1).map((d) => shortName(d.overnight)),
  };
}
function currentSummary() {
  const groups = dayGroups();
  const secs = groups.map((g) => dayStats(g, "scenic")?.dur || 0);
  const r = routes.scenic;
  return {
    days: groups.length, secs: r?.duration_s || 0, km: r?.distance_m || 0, longest: Math.max(0, ...secs),
    freeway: r?.distance_m ? Math.round((100 * (r.highway_m || 0)) / r.distance_m) : 0,
    roads: (plan?.roads || []).map((x) => x.name),
    overnights: groups.slice(0, -1).map((g) => shortName(stops[g.items.at(-1)].name)),
  };
}
function altHtml() {
  const cols = [{ label: "Your trip", sum: currentSummary(), current: true }, ...altState.items];
  const cell = (c, f) => (c.error ? (f === "days" ? `<span class="su-bad">${esc(c.error)}</span>` : "")
    : !c.sum ? (f === "days" ? `<span class="spinner"></span> ${esc(c.step || "")}` : "") : f);
  const limit = longDayS();
  const rows = [
    ["Days", (c) => c.sum.days],
    ["Driving", (c) => fmtDur(c.sum.secs)],
    ["Longest day", (c) => `<span class="${c.sum.longest > limit ? "warn-text" : ""}">${fmtDur(c.sum.longest)}</span>`],
    ["Distance", (c) => fmtMi(c.sum.km)],
    ["Freeway", (c) => `${c.sum.freeway}%`],
    ["Featured roads", (c) => c.sum.roads.map((x) => esc(x)).join("<br>") || "–"],
    ["Overnights", (c) => c.sum.overnights.map((x) => esc(x)).join("<br>") || "–"],
  ];
  return `${sheetHead("Other versions of this trip")}
    <p class="su-lede">Three takes on the same request, measured on the map. Pick one to switch to it; Undo brings yours back.</p>
    <div class="alt-wrap"><table class="alt-table">
      <thead><tr><th></th>${cols.map((c) => `<th>${esc(c.label)}${c.title ? `<small>${esc(c.title)}</small>` : ""}</th>`).join("")}</tr></thead>
      <tbody>${rows.map(([name, f], ri) => `<tr><th>${name}</th>${cols.map((c) => `<td>${c.sum ? f(c) : ri === 0 ? cell(c, "days") : ""}</td>`).join("")}</tr>`).join("")}
        <tr><th></th>${cols.map((c, i) => `<td>${c.current ? `<span class="subtle">Current</span>` : c.sum ? `<button class="btn blue small" data-alt="${i - 1}">Use this version</button>` : ""}</td>`).join("")}</tr>
      </tbody></table></div>`;
}
function redrawAlt() {
  const sheet = altState.el?.querySelector(".sheet");
  if (sheet && altState.el.isConnected) sheet.innerHTML = altHtml();
}
async function openAlternatives() {
  if (!plan || READONLY || !routes.scenic) return;
  altState.items = VARIANTS.map((v) => ({ ...v, step: "Asking the AI" }));
  altState.el = openSheet(altHtml(), "wide");
  altState.el.addEventListener("click", (e) => {
    const b = e.target.closest("[data-alt]");
    if (!b) return;
    const it = altState.items[Number(b.dataset.alt)];
    closeOverlay();
    liveRevise({ skel: it.skel, title: `Switching to "${it.label}"`, note: it.title || "", feedback: "" }).then(() => {
      trip.edits = [...(trip.edits || []), { text: `Switched to another version: ${it.label}`, at: new Date().toISOString() }];
      scheduleSave();
    });
  });
  const base = { prompt: trip.prompt || trip.name, current: skeletonOf(), states: tripStates(), settings: tripSettings() };
  await Promise.all(altState.items.map(async (it) => {
    try {
      const d = await api("/api/plan", { ...base, feedback: it.ask });
      it.skel = d.plan;
      it.title = d.plan.title;
      it.step = "Measuring";
      redrawAlt();
      it.sum = versionSummary(d.plan, await measureSkeleton(d.plan));
    } catch (e) {
      it.error = e.message;
    }
    redrawAlt();
  }));
}

// ---------- Today: the day you're driving, for the phone ----------
// Where you are (the phone's location, or a point you pick), what's next and how far, the next fuel or charger, roads
// and stops still ahead, arrival against sunset, and the rest of the day handed to Google or Apple Maps. Location needs
// a secure page (https or this computer); over plain http on the home Wi-Fi the phone can't share it, so you pick.

const todayState = { day: null, pos: null, posAt: 0, at: null, error: "", watch: null, el: null };
const todayIso = () => new Date().toLocaleDateString("en-CA");
function todayDefaultDay() {
  const g = dayGroups().find((x) => dayDate(x.day) === todayIso());
  return g?.day || Number(store.get("todayDay")) || dayGroups()[0]?.day || 1;
}
function openToday() {
  if (!routes.scenic) return;
  if (!dayGroups().some((g) => g.day === todayState.day)) todayState.day = todayDefaultDay();
  todayState.el = openSheet(todayHtml(), "wide today");
  todayState.el.addEventListener("click", todayClick);
  todayState.el.addEventListener("change", todayChange);
  startTodayLocation();
}
function startTodayLocation() {
  if (todayState.watch != null) return;
  if (!("geolocation" in navigator) || !isSecureContext) {
    todayState.error = "Your location isn't available on this connection (it needs https, see the README's Tailscale part).";
    return;
  }
  todayState.watch = navigator.geolocation.watchPosition(
    (p) => {
      Object.assign(todayState, { pos: [p.coords.longitude, p.coords.latitude], posAt: Date.now(), error: "" });
      redrawToday();
    },
    (err) => {
      todayState.error = err.code === 1 ? "Location is turned off for this page." : "Couldn't get your location.";
      redrawToday();
    },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }
  );
}
function redrawToday() {
  const el = todayState.el;
  if (!el?.isConnected) {
    // the sheet was closed: stop following the location
    if (todayState.watch != null) navigator.geolocation.clearWatch(todayState.watch);
    todayState.watch = null;
    return;
  }
  el.querySelector(".sheet").innerHTML = todayHtml();
}
function todayClick(e) {
  if (e.target.closest("[data-today-qr]")) {
    todayState.qr = !todayState.qr;
    loadQrLib().then(redrawToday);
  }
  if (e.target.closest("[data-today-loc]")) {
    todayState.at = null;
    startTodayLocation();
    redrawToday();
  }
}
function todayChange(e) {
  if (e.target.id === "today-day") {
    todayState.day = Number(e.target.value);
    todayState.at = null;
    store.set("todayDay", String(todayState.day));
  }
  if (e.target.id === "today-at") todayState.at = e.target.value === "" ? null : Number(e.target.value);
  redrawToday();
}
function todayHtml() {
  const groups = dayGroups();
  const gi = groups.findIndex((g) => g.day === todayState.day);
  const g = groups[gi];
  const line = g && dayLine(g.day);
  const st = g && dayStats(g, "scenic");
  if (!g || !line || !st) return `${sheetHead("Today")}<p>Measure the route first.</p>`;
  const total = line.cum.at(-1) || 1;
  const start = gi > 0 ? groups[gi - 1].items.at(-1) : g.items[0];
  const dayPoints = [...new Set([start, ...g.items])];
  const at = (p) => projectOnto(line, p);
  // where you are along today's route
  let along = 0;
  let where = "";
  if (todayState.at != null) {
    along = at([stops[todayState.at].lng, stops[todayState.at].lat]).along;
    where = `At ${shortName(stops[todayState.at].name)}`;
  } else if (todayState.pos) {
    const pr = at(todayState.pos);
    if (pr.off < 30000) {
      along = pr.along;
      where = `Your location${pr.off > 2000 ? `, ${fmtMi(pr.off)} off the route` : ""}`;
    } else where = `You're ${fmtMi(pr.off)} from today's route, so this counts from the start of the day.`;
  } else where = "From the start of the day";
  const secsFor = (m) => (st.dur * Math.max(0, m)) / total;
  const ahead = dayPoints.map((i) => ({ i, s: stops[i], a: at([stops[i].lng, stops[i].lat]).along })).filter((x) => x.a > along + 500);
  const next = ahead.find((x) => !isVia(x.s)) || ahead[0];
  const spots = (plan?.spots || []).filter((x) => x.day === g.day && x.info?.lat != null)
    .map((x) => ({ x, a: at([x.info.lng, x.info.lat]).along })).filter((y) => y.a > along + 300).sort((p, q) => p.a - q.a);
  const al = alongFor(g.day);
  const ev = tripSettings().ev;
  const pins = (al?.pins || []).filter(([k]) => (ev ? k === "evfast" || k === "ev" : k === "fuel"))
    .map(([k, lng, lat, name]) => ({ k, name, a: at([lng, lat]).along })).filter((p) => p.a > along + 300).sort((p, q) => p.a - q.a);
  const fuel = pins[0];
  // arrival: now plus the driving left and the stops still ahead
  const leftS = secsFor(total - along);
  const stopMin = spots.reduce((n, y) => n + (Number(y.x.minutes) || 0), 0);
  const end = stops[g.items.at(-1)];
  const tz = dayTz(gi).end || Intl.DateTimeFormat().resolvedOptions().timeZone;
  // the clock where you'll arrive, so arrival and sunset are in the same time zone
  const nowMin = localMinutes(new Date(), tz);
  const sun = sunTimes(end.lat, end.lng, dayDate(g.day) || todayIso());
  const sunset = sun?.set ? localMinutes(sun.set, tz) : null;
  const arrive = nowMin + leftS / 60 + stopMin;
  const roads = (plan?.roads || []).filter((r) => roadDays(r).includes(g.day)).map((r) => r.name);
  // the rest of the day for the phone's maps app: from here (or the picked point) through what's ahead
  const ll = (p) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`;
  const here = todayState.at != null ? [stops[todayState.at].lng, stops[todayState.at].lat] : todayState.pos && along > 0 ? todayState.pos : [stops[start].lng, stops[start].lat];
  // every place ahead, in parts when there are more than one link carries (each part starts where the last ended)
  const route = [{ p: here, name: "Where you are" }, ...ahead.map((x) => ({ p: [x.s.lng, x.s.lat], name: shortName(x.s.name) }))];
  const parts = linkParts(route).map((part) => ({ ...mapLinksFor(part.map((x) => ll(x.p))), from: part[0].name, to: part.at(-1).name }));
  const { google, apple } = parts[0];
  const card = (ico, label, big, small = "") => `<div class="td-card">${icon(ico, 20)}<div><small>${label}</small><b>${big}</b>${small ? `<span>${small}</span>` : ""}</div></div>`;
  return `${sheetHead("Today")}
    <div class="td-top">
      <label>Day <select id="today-day">${groups.map((x) => `<option value="${x.day}" ${x.day === g.day ? "selected" : ""}>${x.day}${dayDate(x.day) ? ` · ${dayDate(x.day)}` : ""}</option>`).join("")}</select></label>
      <label>I'm at <select id="today-at"><option value="">${todayState.pos ? "My location" : "Start of the day"}</option>
        ${dayPoints.map((i) => `<option value="${i}" ${todayState.at === i ? "selected" : ""}>${esc(shortName(stops[i].name))}</option>`).join("")}</select></label>
    </div>
    <p class="td-where">${icon("pin", 14)} ${esc(where)}${todayState.error && todayState.at == null ? ` <span class="subtle">${esc(todayState.error)}</span>` : ""}
      ${!todayState.pos && !todayState.error ? `<button class="link-btn" data-today-loc>Use my location</button>` : ""}</p>
    <div class="td-grid">
      ${next ? card("route", "Next", esc(shortName(next.s.name)), `${fmtMi(next.a - along)} · ${fmtDur(secsFor(next.a - along))}`) : card("check", "Next", "You've arrived")}
      ${card("moon", "Tonight", esc(shortName(end.name)), `${fmtMi(total - along)} to go · arrive about ${clock(arrive)}${sunset != null ? ` · sunset ${clock(sunset)}` : ""}`)}
      ${fuel ? card(ev ? "plug" : "fuel", ev ? "Next charger" : "Next fuel", esc(fuel.name || (ev ? "Charger" : "Gas station")), `in ${fmtMi(fuel.a - along)}`)
        : al ? card(ev ? "plug" : "fuel", ev ? "Next charger" : "Next fuel", ev ? "None left on today's route" : "None left on today's route", "Fill up before you go")
        : card("fuel", "Fuel", "Not looked up yet", "“Along the route” finds fuel and chargers")}
      ${sunset != null && arrive > sunset + 10 ? card("sunset", "Heads up", "You'd arrive after dark", "Skip a stop or leave earlier") : ""}
    </div>
    ${roads.length ? `<h3 class="td-h">${icon("road", 16)} Roads today</h3><p class="td-list">${roads.map(esc).join(" · ")}</p>` : ""}
    ${spots.length ? `<h3 class="td-h">${icon("viewpoint", 16)} Still ahead</h3><ol class="td-spots">${spots.slice(0, 6).map((y) => `<li><b>${esc(y.x.name)}</b><span>${fmtMi(y.a - along)}${y.x.minutes ? ` · ${y.x.minutes} min stop` : ""}</span></li>`).join("")}</ol>` : ""}
    ${parts.length > 1 ? `<p class="td-parts">${icon("route", 14)} <span>Today's route has more places than one map link carries, so it goes in
      ${parts.length} parts. Open the next part when you reach ${esc(parts[0].to)}:
      ${parts.slice(1).map((p, k) => `<span class="td-part">Part ${k + 2} from ${esc(p.from)}: <a href="${esc(p.google)}" target="_blank" rel="noopener">Google</a> · <a href="${esc(p.apple)}" target="_blank" rel="noopener">Apple</a></span>`).join("")}</span></p>` : ""}
    ${todayState.qr ? qrBlock(parts) : ""}
    <div class="sheet-actions">
      <button class="btn ghost td-qr" data-today-qr>${icon("phone", 18)} ${todayState.qr ? "Hide the QR code" : "Send to phone"}</button>
      <a class="btn ghost" href="${esc(apple)}" target="_blank" rel="noopener">${icon("pin", 18)} Apple Maps${parts.length > 1 ? ", part 1" : ""}</a>
      <a class="btn blue" href="${esc(google)}" target="_blank" rel="noopener">${icon("pin", 18)} Drive it in Google Maps${parts.length > 1 ? ", part 1" : ""}</a>
    </div>`;
}
// keep the times fresh while it's open
setInterval(() => todayState.el?.isConnected && redrawToday(), 60000);

// ---------- send to the phone ----------
// QR codes of a day's Google and Apple Maps links: the phone's camera opens the day in its maps app, nothing to type.
// qrcode-generator loads the first time (Setup uses it too).
let qrLib = null;
function loadQrLib() {
  if (typeof qrcode === "function") return Promise.resolve();
  return (qrLib ||= new Promise((ok) => {
    const sc = document.createElement("script");
    sc.src = "https://unpkg.com/qrcode-generator@1.4.4/qrcode.js";
    sc.onload = sc.onerror = () => ok();
    document.head.appendChild(sc);
  }));
}
function qrSvg(text) {
  if (typeof qrcode !== "function") return "";
  const q = qrcode(0, "L");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
// parts: [{ google, apple, from, to }], one per link (a long day has several)
function qrBlock(parts) {
  if (typeof qrcode !== "function") return `<p class="fine">The QR code maker didn't load (no internet?). The links work from the day's Google and Apple Maps buttons.</p>`;
  return `<div class="qr-wrap" data-app="google">
    <div class="rc-tabs" role="tablist">
      <button class="on" role="tab" data-qr-app="google">Google Maps</button><button role="tab" data-qr-app="apple">Apple Maps</button>
    </div>
    <div class="qr-list">
      ${parts.map((p, k) => `<figure class="qr">
        <div class="qr-code qr-g">${qrSvg(p.google)}</div><div class="qr-code qr-a">${qrSvg(p.apple)}</div>
        <figcaption>${parts.length > 1 ? `<b>Part ${k + 1}</b> ` : ""}${esc(p.from)} to ${esc(p.to)}</figcaption></figure>`).join("")}
    </div>
    <p class="fine">Point the phone's camera at the code and tap the link that appears. Google links open the Google Maps
      app when it's installed; Apple Maps links need iOS 18.4 or later.${parts.length > 1 ? " Open part 2 when you reach the end of part 1." : ""}</p>
  </div>`;
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-qr-app]");
  if (!b) return;
  const wrap = b.closest(".qr-wrap");
  wrap.dataset.app = b.dataset.qrApp;
  wrap.querySelectorAll("[data-qr-app]").forEach((x) => x.classList.toggle("on", x === b));
});
async function openPhoneSheet(day) {
  const groups = dayGroups();
  const gi = groups.findIndex((g) => g.day === day);
  const links = gi >= 0 ? dayLinks(groups, gi) : null;
  if (!links) return;
  await loadQrLib();
  const parts = links.parts.length > 1 ? links.parts : [{ google: links.google, apple: links.apple, from: links.parts[0].from, to: links.parts[0].to }];
  openSheet(`${sheetHead(groups.length > 1 ? `Send day ${day} to your phone` : "Send the trip to your phone")}${qrBlock(parts)}`, "phone-sheet");
}

// ---------- editing the route on the map ----------
// Drag a pin to move that point, drag the route line to pull it through a new via point, and right-click (long-press on
// a phone) the map to add a stop or route through a place. Each edit re-routes; nothing asks the AI.

// A name for a spot on the map: the town there, or "near" the closest one, with its state (see /api/place-name).
async function placeName(lng, lat) {
  try {
    return (await (await fetch(`/api/place-name?lat=${lat}&lng=${lng}`)).json()).name;
  } catch {
    return `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  }
}
async function rerouteAfterEdit(msg) {
  normalizeDays();
  renderStops();
  scheduleSave();
  renderItinerary();
  if (stops.length >= 2) await findRoutes({ fit: false });
  if (msg) setStatus([msg, $("status").textContent].filter(Boolean).join(" "));
}
// Where a new point adds the least distance: between two points, or (for a stop) at the end.
function cheapestSpot(p, asStop) {
  const at = (s) => [s.lng, s.lat];
  let best = { i: stops.length, cost: stops.length ? haversine(at(stops[stops.length - 1]), p) : 0 };
  if (!asStop) best.cost = Infinity;
  for (let i = 0; i < stops.length - 1; i++) {
    const cost = haversine(at(stops[i]), p) + haversine(p, at(stops[i + 1])) - haversine(at(stops[i]), at(stops[i + 1]));
    if (cost < best.cost) best = { i: i + 1, cost };
  }
  return best.i;
}
async function addOnMap(ll, kind) {
  const name = await placeName(ll.lng, ll.lat);
  const i = kind === "via" && stops.length < 2 ? stops.length : cheapestSpot([ll.lng, ll.lat], kind === "stop");
  // the leg into a point belongs to that point's day
  const day = stops[i]?.day ?? stops[stops.length - 1]?.day ?? 1;
  stops.splice(i, 0, { name, lng: ll.lng, lat: ll.lat, kind, day, road: "", note: "Added on the map" });
  await rerouteAfterEdit(kind === "via" ? `Routing through ${shortName(name)}.` : `Added ${shortName(name)}.`);
}
async function moveOnMap(i, ll) {
  const s = stops[i];
  if (!s) return;
  const old = s.name;
  s.lng = ll.lng;
  s.lat = ll.lat;
  s.name = await placeName(ll.lng, ll.lat);
  if (s.name !== old) {
    delete s.photos;
    delete s.photosP;
    s.photoQuery = "";
    // a day that ended there now ends at the new place
    for (const d of plan?.days || []) if (d.overnight === old) d.overnight = s.name;
  }
  await rerouteAfterEdit(`Moved ${shortName(old)} to ${shortName(s.name)}.`);
}

// Dragging the route line: a ghost via follows the pointer; letting go adds a via there, in the leg that was grabbed.
const routeLayers = () => [`route-${selected}-line`, `route-${selected}-casing`].filter((l) => map.getLayer(l));
map.on("mousedown", (e) => {
  if (READONLY || !routes[selected] || e.originalEvent.button !== 0 || document.body.dataset.view !== "map") return;
  // a press on a pin drags the pin, even where it sits on the route line
  if (e.originalEvent.target?.closest?.(".maplibregl-marker")) return;
  if (!map.queryRenderedFeatures(e.point, { layers: routeLayers() }).length) return;
  e.preventDefault(); // this drag moves the route, not the map
  const el = document.createElement("div");
  el.className = "via-pin ghost";
  const ghost = new maplibregl.Marker({ element: el }).setLngLat(e.lngLat).addTo(map);
  const start = e.point;
  const grabbed = e.lngLat;
  const onMove = (ev) => ghost.setLngLat(ev.lngLat);
  map.on("mousemove", onMove);
  map.once("mouseup", async (ev) => {
    map.off("mousemove", onMove);
    ghost.remove();
    if (Math.hypot(ev.point.x - start.x, ev.point.y - start.y) < 8) return; // a click, not a drag
    // the leg that was grabbed: nearest point of the route line, then the leg whose geometry holds it
    const r = routes[selected];
    const coords = r.geometry.coordinates;
    let k = 0;
    let bestD = Infinity;
    coords.forEach((c, j) => {
      const d = (c[0] - grabbed.lng) ** 2 + (c[1] - grabbed.lat) ** 2;
      if (d < bestD) [bestD, k] = [d, j];
    });
    const leg = Math.max(0, r.legs.findIndex((l) => k >= l.from && k <= l.to));
    const endIdx = r.idx[leg + 1];
    const ll = ev.lngLat;
    const name = await placeName(ll.lng, ll.lat);
    stops.splice(endIdx, 0, { name, lng: ll.lng, lat: ll.lat, kind: "via", day: stops[endIdx].day, road: "", note: "Added on the map" });
    await rerouteAfterEdit(`Routing through ${shortName(name)}.`);
  });
});
map.on("mousemove", (e) => {
  if (READONLY || !routes[selected] || document.body.dataset.view !== "map" || e.originalEvent.buttons) return;
  map.getCanvas().style.cursor = map.queryRenderedFeatures(e.point, { layers: routeLayers() }).length ? "grab" : "";
});

// Right-click (or long-press) the map: add a stop or route through there.
let editPopup = null;
function editMenu(ll) {
  if (READONLY || document.body.dataset.view !== "map") return;
  editPopup?.remove();
  const box = document.createElement("div");
  box.className = "edit-menu";
  const btn = (label, kind) => {
    const b = document.createElement("button");
    b.className = "btn ghost small";
    b.textContent = label;
    b.onclick = () => {
      editPopup?.remove();
      addOnMap(ll, kind);
    };
    box.appendChild(b);
  };
  btn(stops.length ? "Add a stop here" : "Start here", "stop");
  if (stops.length >= 2) btn("Route through here", "via");
  editPopup = new maplibregl.Popup({ closeButton: false, offset: 8 }).setLngLat(ll).setDOMContent(box).addTo(map);
}
map.on("contextmenu", (e) => editMenu(e.lngLat));
let pressTimer = 0;
map.on("touchstart", (e) => {
  clearTimeout(pressTimer);
  if (e.originalEvent.touches.length !== 1) return;
  pressTimer = setTimeout(() => editMenu(e.lngLat), 600);
});
for (const ev of ["touchend", "touchmove", "touchcancel", "movestart"]) map.on(ev, () => clearTimeout(pressTimer));

// ---------- installable app (PWA) ----------

if ("serviceWorker" in navigator && isSecureContext) {
  addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

// ---------- roads near me ----------
// A home base and the great roads within a few hours of it, from public/road-points.json (a point per byway and
// hand-picked drive, built once by tools/build-road-points.mjs): plain distance arithmetic, nothing asked of a service
// until a weekend loop is planned. Drive time is a straight-line estimate (x1.3 for the roads, 80 km/h).
const nearState = { roads: null, home: null, hours: 5, busy: "", error: "" };
try {
  nearState.home = JSON.parse(store.get("homeBase") || "null");
} catch {}
const nearHours = (km) => (km * 1.3) / 80 + 0.25;
async function loadNearRoads() {
  nearState.roads ||= await fetch("road-points.json").then((r) => r.json()).then((d) => d.roads || []).catch(() => []);
  return nearState.roads;
}
// Which landmass a point is on, so a road across the sea (Wales from Dublin, Norway from Scotland) isn't "an hour
// away" in a straight line. Northern Ireland goes with Ireland; Tasmania, the Balearics and the Canaries are their own.
function landOf([lng, lat]) {
  if (lng > 143 && lng < 149 && lat < -39.5) return "TAS";
  const c = countryOf({ lng, lat });
  if (c === "GB" && lng < -5.4 && lat > 54 && lat < 55.4) return "IE";
  if (c === "ES" && lng > 1 && lat < 40.2) return "BAL";
  if (c === "ES" && lat < 30) return "CAN";
  if (["US", "CA"].includes(c)) return "NA";
  if (["CH", "AT", "LI", "IT", "FR", "DE", "ES", "PT", "NO"].includes(c)) return "EU";
  return c || "?";
}
function nearList() {
  const home = nearState.home;
  if (!home || !nearState.roads) return [];
  const land = landOf(home.at);
  return nearState.roads
    .filter((r) => (r.land ||= landOf(r.at)) === land || land === "?")
    .map((r) => ({ r, km: haversine(home.at, r.at) / 1000 }))
    .map((x) => ({ ...x, h: nearHours(x.km) }))
    .filter((x) => x.h <= nearState.hours)
    .sort((a, b) => a.h - b.h);
}
// Weekend loops: the nearest roads alone (one night), and pairs of roads close to each other (two nights).
function nearLoops(list) {
  const out = [];
  const town = shortName(nearState.home.name);
  for (const a of list.slice(0, 6)) {
    const b = list.find((x) => x !== a && haversine(a.r.at, x.r.at) < 160000 && !out.some((o) => o.roads.includes(x.r.name) && o.roads.includes(a.r.name)));
    // two roads close to home fit one night; farther out, two
    const nights = Math.max(a.h, b?.h || 0) > 3 ? 2 : 1;
    if (b && out.length < 2) out.push({ roads: [a.r.name, b.r.name], nights, prompt: `A weekend loop from ${town}: drive ${a.r.name} and ${b.r.name}, ${nights + 1} days, back to ${town}` });
  }
  for (const a of list.slice(0, 3)) {
    if (out.length >= 4) break;
    if (!out.some((o) => o.roads.length === 1 && o.roads[0] === a.r.name)) out.push({ roads: [a.r.name], nights: 1, prompt: `A one-night loop from ${town} to drive ${a.r.name}, 2 days, back to ${town}` });
  }
  return out;
}
function nearHtml() {
  const s = nearState;
  const home = s.home;
  const list = nearList();
  const loops = home && list.length ? nearLoops(list) : [];
  const fmtH = (h) => (h < 1 ? "under an hour" : `about ${h < 2 ? Math.round(h * 2) / 2 : Math.round(h)} h`);
  // lengths in the home base's units (miles in the US and UK)
  const miles = home && ["US", "GB"].includes(countryOf({ lng: home.at[0], lat: home.at[1] }) || "US");
  const len = (km) => (miles ? `${Math.round(km / 1.609)} mi` : `${Math.round(km)} km`);
  return `${sheetHead("Great roads near you")}
    <form class="near-home" id="near-form">
      <label class="field grow"><span>${icon("pin", 14)} Home base</span><input name="home" type="text" autocomplete="off" placeholder="Your town or city" value="${esc(home?.name || "")}"></label>
      <button class="btn blue" type="submit">${s.busy === "find" ? `<span class="spinner"></span>` : ""} Find roads</button>
      ${navigator.geolocation && isSecureContext ? `<button class="btn ghost" type="button" data-near-loc>${s.busy === "loc" ? `<span class="spinner"></span>` : icon("pin", 16)} Use my location</button>` : ""}
    </form>
    ${s.error ? `<p class="near-error">${esc(s.error)}</p>` : ""}
    ${home ? `<div class="near-reach" role="group" aria-label="How far">
      <span>Within</span>${[2, 3, 5, 8].map((h) => `<button class="chip ${s.hours === h ? "on" : ""}" data-near-h="${h}">${h} hours</button>`).join("")}
    </div>` : `<p class="fine">Type a town (or use your location) to see the scenic byways and famous drives within a few hours, and weekend loops to plan in one tap.</p>`}
    ${home && !list.length ? `<p class="fine">No roads from the app's list within ${s.hours} hours of ${esc(shortName(home.name))}. Try a longer reach; the list covers the US, Canada, Australia, New Zealand, the UK, Ireland, Norway, Iceland, Spain, Portugal and the Alps.</p>` : ""}
    ${loops.length ? `<h3 class="near-h">${icon("route", 16)} Weekend loops</h3><div class="near-loops">
      ${loops.map((l) => `<div class="near-loop"><span><b>${esc(l.roads.join(" + "))}</b><small>${l.nights === 1 ? "1 night" : "2 nights"} from ${esc(shortName(home.name))}</small></span>
        <button class="btn blue small" data-near-plan="${esc(l.prompt)}">${icon("sparkle", 14)} Plan it</button></div>`).join("")}
    </div>` : ""}
    ${list.length ? `<h3 class="near-h">${icon("road", 16)} ${list.length} road${list.length === 1 ? "" : "s"} within ${s.hours} hours</h3>
    <ul class="near-list">
      ${list.slice(0, 40).map((x) => `<li>
        <span class="near-img">${x.r.image ? `<img src="${esc(x.r.image)}" alt="" loading="lazy" onerror="this.remove()">` : icon("road", 18)}</span>
        <span class="near-text"><b>${esc(x.r.name)}</b><small>${esc(x.r.type)} · ${esc(x.r.state || "")}${x.r.km ? ` · ${len(x.r.km)} long` : ""} · ${fmtH(x.h)} away</small>
          ${x.r.about ? `<span class="near-about">${esc(x.r.about)}</span>` : ""}</span>
        <span class="near-acts">
          <button class="link-btn" data-near-map="${esc(x.r.name)}">${icon("map", 13)} Map</button>
          <button class="link-btn" data-near-plan="${esc(`A one-night loop from ${shortName(home.name)} to drive ${x.r.name}, 2 days, back to ${shortName(home.name)}`)}">${icon("sparkle", 13)} Plan a loop</button>
        </span>
      </li>`).join("")}
    </ul>
    <p class="fine">Times are straight-line estimates; the plan measures the real drive.</p>` : ""}`;
}
let nearEl = null;
async function openNear() {
  await loadNearRoads();
  nearEl = openSheet(nearHtml(), "wide near-sheet");
  nearEl.addEventListener("submit", nearSubmit);
  nearEl.addEventListener("click", nearClick);
}
const redrawNear = () => nearEl?.isConnected && (nearEl.querySelector(".sheet").innerHTML = nearHtml());
async function setNearHome(name, at) {
  nearState.home = { name, at };
  store.set("homeBase", JSON.stringify(nearState.home));
}
async function nearSubmit(e) {
  if (e.target.id !== "near-form") return;
  e.preventDefault();
  const q = e.target.querySelector("[name=home]").value.trim();
  if (!q) return;
  Object.assign(nearState, { busy: "find", error: "" });
  redrawNear();
  const g = await fetch(`/api/geocode?towns=1&q=${encodeURIComponent(q)}`).then((r) => r.json()).catch(() => ({}));
  const h = g.hits?.[0] || (await fetch(`/api/geocode?q=${encodeURIComponent(q)}`).then((r) => r.json()).catch(() => ({}))).hits?.[0];
  nearState.busy = "";
  if (h) await setNearHome(q, [h.lng, h.lat]);
  else nearState.error = `Couldn't find “${q}”. Try the town with its state or country.`;
  redrawNear();
}
function nearClick(e) {
  const h = e.target.closest("[data-near-h]");
  if (h) {
    nearState.hours = Number(h.dataset.nearH);
    redrawNear();
  }
  if (e.target.closest("[data-near-loc]")) {
    Object.assign(nearState, { busy: "loc", error: "" });
    redrawNear();
    navigator.geolocation.getCurrentPosition(
      async (p) => {
        const at = [p.coords.longitude, p.coords.latitude];
        const d = await fetch(`/api/place-name?lat=${at[1]}&lng=${at[0]}`).then((r) => r.json()).catch(() => ({}));
        nearState.busy = "";
        await setNearHome(d.name || "My location", at);
        redrawNear();
      },
      () => {
        Object.assign(nearState, { busy: "", error: "Location isn't available. Type your town instead." });
        redrawNear();
      },
      { timeout: 15000, maximumAge: 600000 }
    );
  }
  const m = e.target.closest("[data-near-map]");
  if (m) showNearOnMap(m.dataset.nearMap);
  const p = e.target.closest("[data-near-plan]");
  if (p) {
    closeOverlay();
    planTrip(p.dataset.nearPlan, { ...DEFAULT_SETTINGS, ...rememberedSettings(), loop: true });
  }
}
// The road and the home base as pins on the map; they go when the map is left.
const nearPins = [];
function showNearOnMap(name) {
  const r = nearState.roads?.find((x) => x.name === name);
  if (!r) return;
  closeOverlay();
  nearPins.forEach((m) => m.remove());
  nearPins.length = 0;
  const pin = (cls, at, title) => {
    const el = document.createElement("div");
    el.className = "near-mark";
    el.innerHTML = `<i class="${cls}"></i><span>${esc(title)}</span>`;
    nearPins.push(new maplibregl.Marker({ element: el, anchor: "left", offset: [-8, 0] }).setLngLat(at).addTo(map));
  };
  if (nearState.home) pin("near-pin home", nearState.home.at, shortName(nearState.home.name));
  pin("near-pin", r.at, r.name);
  setView("map");
  const b = new maplibregl.LngLatBounds();
  b.extend(r.at);
  if (nearState.home) b.extend(nearState.home.at);
  try {
    map.fitBounds(b, { padding: pad(), maxZoom: 9, duration: 800 });
  } catch {
    map.flyTo({ center: r.at, zoom: 8 });
  }
}
new MutationObserver(() => {
  if (document.body.dataset.view !== "map" && nearPins.length) {
    nearPins.forEach((m) => m.remove());
    nearPins.length = 0;
  }
}).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });

// ---------- import a GPX file as a trip ----------
// A GPX exported from Byway comes back as it was (stops, via points and days, from its waypoints). Other files: a route's
// points, else the waypoints, else a recorded track sampled every ~60 km (start and end as stops, the rest as via points,
// named by OpenStreetMap). The trip is then measured and split into days by the daily limit. No AI involved.
function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("That file isn't a GPX file the app can read.");
  const all = (el, tag) => [...el.getElementsByTagNameNS("*", tag)];
  const kid = (el, tag) => all(el, tag)[0]?.textContent.trim() || "";
  const pt = (el) => ({ lng: Number(el.getAttribute("lon")), lat: Number(el.getAttribute("lat")), name: kid(el, "name"), desc: kid(el, "desc"), type: kid(el, "type") });
  const ok = (p) => isFinite(p.lng) && isFinite(p.lat) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  const name = kid(all(doc, "metadata")[0] || doc.createElement("x"), "name") || kid(all(doc, "trk")[0] || doc.createElement("x"), "name");
  const wpts = all(doc, "wpt").map(pt).filter(ok);
  // our own export: waypoints typed "stop" or "via" with "Day N" in the description (the plan's spots are typed otherwise)
  const ours = wpts.filter((p) => (p.type === "stop" || p.type === "via") && /^Day \d+/.test(p.desc));
  if (ours.length >= 2) {
    return { name, byway: true, points: ours.map((p) => ({ ...p, via: p.type === "via", day: Number(p.desc.match(/^Day (\d+)/)[1]), note: p.desc.replace(/^Day \d+\.?\s*/, "") })) };
  }
  const rte = all(doc, "rtept").map(pt).filter(ok);
  if (rte.length >= 2) return { name, points: rte };
  if (wpts.length >= 2) return { name, points: wpts };
  const track = all(doc, "trkpt").map(pt).filter(ok);
  if (track.length < 2) throw new Error("The file has no route, waypoints or track to make a trip from.");
  // sample the track by distance: ends kept, a point every ~60 km between (at most 14 in all)
  const cum = [0];
  for (let i = 1; i < track.length; i++) cum.push(cum[i - 1] + haversine([track[i - 1].lng, track[i - 1].lat], [track[i].lng, track[i].lat]));
  const total = cum.at(-1);
  const n = Math.max(2, Math.min(14, Math.round(total / 60000) + 1));
  const pts = Array.from({ length: n }, (_, k) => {
    const target = (k / (n - 1)) * total;
    const i = Math.max(0, cum.findIndex((c) => c >= target));
    return { ...track[i], name: "", via: k > 0 && k < n - 1 };
  });
  return { name, points: pts, track: true };
}
async function importGpx(file) {
  if (READONLY || !file) return;
  try {
    if (file.size > 30e6) throw new Error("That file is too big (over 30 MB).");
    const g = parseGpx(await file.text());
    await newTrip();
    setView("itinerary");
    // places without names get one from OpenStreetMap (one at a time; the server caches them)
    for (const [k, p] of g.points.entries()) {
      if (p.name) continue;
      setStatus(`Naming the places on the route (${k + 1} of ${g.points.length})...`);
      const d = await fetch(`/api/place-name?lat=${p.lat}&lng=${p.lng}`).then((r) => r.json()).catch(() => ({}));
      p.name = d.name || `${p.lat.toFixed(3)}, ${p.lng.toFixed(3)}`;
    }
    for (const p of g.points) {
      stops.push({ name: p.name, lng: p.lng, lat: p.lat, note: p.note || "", kind: p.via ? "via" : "stop", day: p.day || 1, road: "" });
    }
    normalizeDays();
    trip.name = g.name || `${shortName(stops[0].name)} to ${shortName(stops.at(-1).name)}`;
    trip.customName = !!g.name;
    trip.edits = [{ at: new Date().toISOString(), text: `Imported from ${file.name}` }];
    renderStops();
    fitStops();
    scheduleSave();
    renderItinerary();
    if (await findRoutes()) {
      // one long day: split it by the daily limit (a Byway file keeps its own days)
      if (!g.byway && dayGroups().length === 1) {
        const total = stops.reduce((a, _, i) => a + (legsByEnd(routes.scenic).get(i)?.duration_s || 0), 0);
        if (balanceDays(Math.max(1, Math.ceil(total / longDayS())))) {
          renderStops();
          renderPills();
        }
      }
      scheduleSave();
      renderItinerary();
      setStatus(`Imported ${stops.length} places from ${file.name}.`);
    }
  } catch (e) {
    setStatus(e.message || String(e));
  }
}

