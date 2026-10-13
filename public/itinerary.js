// The itinerary page: a magazine-style planning view with photos, day guides, the roads and the spots.
// Reads the shared state from app.js (stops, routes, plan, progress) and re-renders on change.

const IT = $("itinerary");

const EXAMPLES = [
  "San Francisco to Dallas through Teton County and Colorado, national parks on the way",
  "Seattle to San Diego on the Pacific Coast Highway in 8 days",
  "Vancouver to Calgary through the Rockies in 4 days: Sea-to-Sky, Icefields Parkway and Highwood Pass",
  "Sydney to Melbourne the scenic way in 5 days: Blue Mountains, Snowy Mountains and the Great Ocean Road",
  "Christchurch to Queenstown via Aoraki Mount Cook and the West Coast in 5 days",
  "Edinburgh loop through the Scottish Highlands and the North Coast 500 in 7 days",
  "Zurich loop over the Furka, Grimsel and Susten passes, then the Stelvio, in 4 days",
];

// Where the planner has a road list. Keep in step with tools/build-coverage.mjs and data/*-drives.json.
const COVERAGE_TEXT = "Covered: the US · Canada from BC to Newfoundland · Australia: NSW, Victoria, ACT, Queensland, Tasmania · New Zealand · the UK · the Alps (Switzerland, Austria, Bavaria, the Italian and French Alps)";

// Layered mountains and a road, used on the start, progress and How it works screens. Each copy gets its own gradient
// ids: with shared ones, a copy in a hidden view (the start screen) took the ids and the visible one lost its sky.
let artCount = 0;
function artSvg() {
  const n = ++artCount;
  return `<svg class="art" viewBox="0 0 600 220" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
  <defs>
    <linearGradient id="sky${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a84ff" stop-opacity=".35"/><stop offset="1" stop-color="#30d1c6" stop-opacity="0"/></linearGradient>
    <linearGradient id="road${n}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".1"/><stop offset="1" stop-color="#fff" stop-opacity=".35"/></linearGradient>
  </defs>
  <rect width="600" height="220" fill="url(#sky${n})"/>
  <circle cx="455" cy="62" r="20" fill="#ffd60a" opacity=".55"/>
  <path d="M0 150 L90 80 L150 128 L230 52 L310 120 L370 88 L450 140 L520 96 L600 132 V220 H0z" fill="#30d1c6" opacity=".18"/>
  <path d="M0 176 L70 132 L140 168 L210 116 L290 172 L360 130 L430 170 L520 128 L600 162 V220 H0z" fill="#0a84ff" opacity=".22"/>
  <path d="M286 220 C 292 196, 300 186, 304 176 L 310 176 C 312 188, 326 200, 350 220 z" fill="url(#road${n})"/>
  <path d="M305 220 L306 210 M306 202 L306.6 195 M307 189 L307.3 184" stroke="#ffd60a" stroke-width="1.6" opacity=".7"/>
</svg>`;
}

function renderItinerary() {
  // Re-rendering replaces the page, so keep whatever the traveler is typing (and where) across it.
  const a = document.activeElement;
  const keep = a && a.id && IT.contains(a) && /^(TEXTAREA|INPUT)$/.test(a.tagName)
    ? { id: a.id, value: a.value, start: a.selectionStart, end: a.selectionEnd } : null;
  if (progress) renderProgress();
  else if (BATCH && !stops.length && !plan) IT.innerHTML = batchHtml();
  else if (!stops.length && !plan) renderStart();
  else renderTrip();
  if ($("rename-input")) growRename($("rename-input"));
  fitText(IT.querySelector(".day-index") || IT);
  tidyAxes(IT);
  spyDays();
  if (keep) {
    const el = $(keep.id);
    if (el) {
      el.value = keep.value;
      el.focus();
      try {
        el.setSelectionRange(keep.start, keep.end);
      } catch {
        // not a text field
      }
    }
  }
}

// ---------- start screen ----------

function renderStart() {
  const s = { ...DEFAULT_SETTINGS, ...rememberedSettings(), ...(trip.settings || {}) };
  IT.innerHTML = `
    <section class="start">
      ${artSvg()}
      <div class="start-inner">
        <p class="kicker">${icon("sparkle", 16)} Scenic road trip planner</p>
        <h1>Where to?</h1>
        <p class="lede">Describe the trip. The planner picks the best driving roads from 184 designated scenic byways and the
          routes drivers love, plans each day, and finds the spots worth stopping for.</p>
        <form class="prompt-box" id="plan-form">
          <textarea id="plan-prompt" rows="3" placeholder="${esc(EXAMPLES[0])}" aria-label="Describe your trip">${esc(trip.prompt || "")}</textarea>
          ${optionsForm(s)}
          <button class="btn blue" type="submit">${icon("sparkle", 18)} Plan my trip</button>
        </form>
        <div class="examples">${EXAMPLES.map((x) => `<button class="chip" data-act="example">${esc(x)}</button>`).join("")}</div>
        <p class="fine">${esc(planTime())} You can also add stops by hand on the Map tab.</p>
        <p class="fine coverage-note">${icon("map", 14)} ${esc(COVERAGE_TEXT)}. Other places are grey on the map.</p>
      </div>
      ${presetsHtml()}
    </section>`;
  $("plan-form").onsubmit = (e) => {
    e.preventDefault();
    const p = $("plan-prompt").value.trim();
    if (p) planTrip(p, readOptions(e.target));
  };
}

// ---------- planning progress ----------

// What the AI is doing right now: its current step, its notes as they're written, then the days as the plan comes in.
let liveShown = 0; // days already on screen, so only new ones slide in
// The end of the AI's notes, from a line start, without markdown marks.
function notesTail(notes) {
  let text = String(notes || "").replace(/[*#]+/g, "").trim();
  if (text.length > 700) text = text.slice(text.indexOf("\n", text.length - 700) + 1 || text.length - 700);
  return `<div class="live-notes">${esc(text)}</div>`;
}
// The day guides as they're written: each day's spots, and how many roads are written up.
function liveDetails(live) {
  const d = live.plan || {};
  const days = Array.isArray(d.days) ? d.days : [];
  const spots = Array.isArray(d.spots) ? d.spots : [];
  const roads = Array.isArray(d.roads) ? d.roads : [];
  const nums = [...new Set([...days.map((x) => Number(x.day)), ...spots.map((x) => Number(x.day))])].filter(Boolean).sort((a, b) => a - b);
  let body = "";
  if (nums.length || roads.length) {
    body = `<ol class="live-days">
        ${nums
          .map((n) => {
            const names = spots.filter((x) => Number(x.day) === n).map((x) => x.name);
            const sum = days.find((x) => Number(x.day) === n)?.summary || "";
            return `<li><span class="live-num">${n}</span><div><b>${names.length ? esc(names.join(" · ")) : "Day " + n}</b>
              ${sum ? `<small>${esc(sum)}</small>` : ""}</div></li>`;
          })
          .join("")}
      </ol>
      ${roads.length ? `<div class="live-roads">${roads.map((r) => `<span class="chip">${esc(r.name)}</span>`).join("")}</div>` : ""}`;
  } else if (live.notes) body = notesTail(live.notes);
  return `<div class="live">
      ${live.status ? `<p class="live-status">${esc(live.status)}</p>` : ""}
      ${body}
    </div>`;
}
function liveBlock(live) {
  const lp = live.plan || {};
  const days = Array.isArray(lp.days) ? lp.days : [];
  const points = Array.isArray(lp.points) ? lp.points : [];
  const roads = Array.isArray(lp.roads) ? lp.roads : [];
  const town = (n) => String(n || "").split(",")[0];
  let body = "";
  if (days.length) {
    body = `
      ${lp.title ? `<h3>${esc(lp.title)}</h3>` : ""}
      ${lp.summary ? `<p class="live-summary">${esc(lp.summary)}</p>` : ""}
      <ol class="live-days">
        ${days
          .map((d, i) => {
            // the day's stops as a path ending at the overnight town
            const night = town(d.overnight);
            const pts = points.filter((x) => Number(x.day) === Number(d.day)).map((x) => town(x.name)).filter((n) => n !== night);
            return `<li${i >= liveShown ? ' class="new"' : ""}><span class="live-num">${esc(d.day)}</span><div><b>${esc(d.title || "")}</b>
              <small>${pts.length ? esc([...pts, night].join(" → ")) : `Night in ${esc(night)}`}</small></div></li>`;
          })
          .join("")}
      </ol>
      ${roads.length ? `<div class="live-roads">${roads.map((r) => `<span class="chip">${esc(r.name)}</span>`).join("")}</div>` : ""}`;
  } else if (live.notes) body = notesTail(live.notes);
  liveShown = days.length;
  return `<div class="live">
      ${live.status ? `<p class="live-status">${esc(live.status)}</p>` : ""}
      ${body}
    </div>`;
}

function renderProgress() {
  const p = progress;
  // when planning stopped, the step that was running shows the stop, and what to do comes first, under the title
  const state = (s) => (p.error && s.state === "doing" ? "error" : s.state);
  const errorBox = p.error
    ? `<div class="error-box">${icon("alert", 18)}<p>${esc(p.error)}</p>
         ${/LM Studio|local model|API key|\.env|routing engine|ORS|Gemini|planner/i.test(p.error)
           ? `<button class="btn ghost" data-act="setup">${icon("gear", 18)} Open setup</button>` : ""}
         <button class="btn blue" data-act="retry">${icon("refresh", 18)} Try again</button>
         <button class="btn ghost" data-act="cancel">Back</button></div>`
    : "";
  IT.innerHTML = `
    <section class="start progress">
      ${artSvg()}
      <div class="start-inner">
        <p class="kicker">${icon("sparkle", 16)} ${p.error ? "Planning stopped" : "Planning your trip"}</p>
        <h1>${esc(trip.prompt || trip.name)}</h1>
        ${errorBox}
        <ol class="steps">
          ${p.steps
            .map(
              (s) => `<li class="step ${state(s)}">
                <span class="step-ico">${s.state === "done" ? icon("check", 16) : state(s) === "error" ? icon("alert", 16) : ""}</span>
                <div><b>${esc(s.label)}</b><small>${esc(s.detail || "")}</small></div>
              </li>${p.lives?.[s.id] && !p.error ? `<li class="live-li">${s.id === "details" ? liveDetails(p.lives[s.id]) : liveBlock(p.lives[s.id])}</li>` : ""}`
            )
            .join("")}
        </ol>
        ${p.error ? "" : `<p class="fine">The AI and the map services are free tiers, so this can take a couple of minutes.</p>`}
        ${batchState.running
          ? `<p class="fine">${icon("list", 14)} Batch: trip ${batchState.log.filter((l) => l.state !== "todo").length} of ${batchState.log.length}.
              <button class="link-btn" data-act="batch-stop">${batchState.stop ? "Stopping after this trip" : "Stop after this trip"}</button></p>`
          : ""}
      </div>
    </section>`;
}

// ---------- roads: merging route segments and matching them to the plan's featured roads ----------

// "US 550" -> { t: "US", n: "550" }; state routes (CO 82, SH 82, SR 12...) all count as type "ST".
// Australian alphanumeric routes ("B100", "M1") are type "AU" with the letter kept: { t: "AU", l: "B", n: "100" }.
function refParts(str) {
  const out = [];
  // Canadian maps name highways in words ("Highway 99", "Hwy 3", "Route 132"); those count as state routes.
  for (const m of String(str || "").matchAll(/\b(?:Highway|Hwy|Route)\s+(\d+)\b/gi)) out.push({ t: "ST", n: m[1] });
  // letter-number routes: Australia and the UK (B100, A82, M6), Austria and Germany (B107, L188), France (D902, N85)
  for (const m of String(str || "").matchAll(/\b([MABCDLN])(\d{1,4})\b|\b(I|US|[A-Z]{2,3})[ -]?(\d+)\b/gi)) {
    if (m[1]) {
      out.push({ t: "AU", l: m[1].toUpperCase(), n: m[2] });
      continue;
    }
    const t = m[3].toUpperCase();
    out.push({ t: t === "I" ? "I" : t === "US" ? "US" : "ST", n: m[4] });
  }
  return out;
}
const coreName = (s) => String(s || "").replace(/\(.*?\)/g, "").toLowerCase().trim();

function matchRoad(seg, roads) {
  const segRefs = seg.refs.flatMap(refParts);
  const segName = coreName(seg.name);
  for (const r of roads) {
    const rr = refParts(r.ref).concat(refParts(r.name));
    if (rr.some((a) => segRefs.some((b) => a.t === b.t && a.n === b.n && (a.l || "") === (b.l || "")))) return r;
    const rn = coreName(r.name);
    if (segName.length >= 6 && rn.length >= 6 && (segName.includes(rn) || rn.includes(segName))) return r;
  }
  return null;
}

// The days a featured road is on: the days the measured route drives 5+ km of it, else the planner's days (then the
// card says the route doesn't use it yet). The planner's list can be off by a day (Beartooth on day 2 and 3 when only
// day 3 drives it).
function roadDays(r) {
  const planned = (r.days || []).map(Number);
  if (!routes.scenic) return planned;
  const driven = dayGroups().filter((g) => daySegments(g).filter((s) => matchRoad(s, [r])).reduce((a, s) => a + s.distance_m, 0) >= 5000).map((g) => g.day);
  return driven.length ? driven : planned;
}

// Road segments driven on a day, merged across legs: [{ ref, refs, name, distance_m, duration_s, highway_m, road }]
// Pieces that share a route number are one road (US 26 is "North Cache Street" through Jackson).
// Featured roads are matched against the roads planned for that day.
function daySegments(g) {
  const legs = legsByEnd(routes.scenic);
  const out = [];
  const same = (a, b) => (a.ref || a.name) === (b.ref || b.name) || a.refs.some((r) => b.refs.includes(r));
  for (const i of g.items) {
    for (const s of legs.get(i)?.roads || []) {
      const last = out[out.length - 1];
      if (last && (last.ref || last.name) && same(last, s)) {
        if (s.distance_m > last.distance_m) last.name = s.name || last.name;
        last.distance_m += s.distance_m;
        last.duration_s += s.duration_s;
        last.highway_m += s.highway_m;
        for (const k of ["ferry_m", "toll_m", "unpaved_m"]) last[k] = (last[k] || 0) + (s[k] || 0);
        if (s.to != null) last.to = s.to;
        for (const r of s.refs) if (!last.refs.includes(r)) last.refs.push(r);
      } else out.push({ ...s, refs: [...s.refs] });
    }
  }
  const all = plan?.roads || [];
  const today = all.filter((r) => (r.days || []).map(Number).includes(g.day));
  for (const s of out) s.road = matchRoad(s, today.length ? today : all);
  return out;
}

// The strip graphic: neighbouring pieces of the same kind joined, slivers folded into a neighbour.
function stripSegments(segs) {
  const kind = (s) =>
    s.ferry_m > s.distance_m / 2 ? "ferry" : s.road ? "featured" : s.highway_m > s.distance_m / 2 ? "freeway" : "road";
  const out = [];
  for (const s of segs) {
    const k = kind(s);
    const last = out[out.length - 1];
    if (last && last.kind === k && (k !== "featured" || last.road === s.road)) {
      last.d += s.distance_m;
      if (s.distance_m > last.longest) Object.assign(last, { longest: s.distance_m, ref: s.ref, name: s.name });
    } else out.push({ kind: k, d: s.distance_m, longest: s.distance_m, road: s.road, ref: s.ref, name: s.name });
  }
  const total = out.reduce((a, s) => a + s.d, 0) || 1;
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && s.d / total < 0.015 && s.kind !== "featured" && s.kind !== "ferry") last.d += s.d;
    else merged.push(s);
  }
  return { parts: merged, total };
}
const refLabel = (ref) => String(ref || "").replace(/^I (\d)/, "I-$1");

function shield(ref, name) {
  const p = refParts(ref)[0];
  if (!p) return `<span class="shield plain">${icon("road", 14)}</span>`;
  // Letter-number route plates ("B100", "A82", "D902"): green in Australia and on UK primary routes, yellow for French
  // D roads, red for N roads, white for Austrian L roads
  if (p.t === "AU") return `<span class="shield au l-${esc(p.l)}" title="${esc(ref)}${name ? ` · ${esc(name)}` : ""}"><b>${esc(p.l + p.n)}</b></span>`;
  const label = p.t === "I" ? "I" : p.t === "US" ? "US" : String(ref).split(/[ -]/)[0].toUpperCase();
  return `<span class="shield ${p.t.toLowerCase()}" title="${esc(ref)}${name ? ` · ${esc(name)}` : ""}"><i>${esc(label)}</i><b>${esc(p.n)}</b></span>`;
}

// Where a spot sits along a day's route: { along: 0..1, offKm }
function spotAlong(line, s) {
  if (!line || s.info?.lat == null) return null;
  const pt = [s.info.lng, s.info.lat];
  let best = 0;
  let bestD = Infinity;
  const step = Math.max(1, Math.floor(line.coords.length / 1500));
  for (let k = 0; k < line.coords.length; k += step) {
    const d = haversine(line.coords[k], pt);
    if (d < bestD) {
      bestD = d;
      best = k;
    }
  }
  const total = line.cum[line.cum.length - 1] || 1;
  return { along: line.cum[best] / total, offKm: bestD / 1000 };
}

// ---------- trip page ----------

function tripTotals(groups) {
  const r = routes.scenic;
  if (!r) return null;
  let featured = 0;
  for (const g of groups) for (const s of daySegments(g)) if (s.road) featured += s.distance_m;
  return {
    dist: r.distance_m,
    dur: r.duration_s,
    featured,
    freeway: r.highway_m || 0,
    extra: routes.fastest ? r.duration_s - routes.fastest.duration_s : null,
  };
}

function dayImage(day, segs) {
  const sp = (plan?.spots || []).find((s) => s.day === day && s.info?.image);
  if (sp) return sp.info.image;
  const rd = segs.find((s) => s.road?.info?.image)?.road;
  if (rd) return rd.info.image;
  return (plan?.roads || []).find((r) => (r.days || []).map(Number).includes(day) && r.info?.image)?.info.image || "";
}

function renderTrip() {
  updateUnits();
  loadWeather();
  const groups = dayGroups();
  const totals = tripTotals(groups);
  const segsByDay = new Map(groups.map((g) => [g.day, routes.scenic ? daySegments(g) : []]));
  const reorderSaves = !READONLY && plan && routes.scenic ? orderFixPreview() : 0;
  // The trip's cover: an All-American Road photo if there is one, else a photo from the middle of the trip.
  const dayImgs = groups.map((g) => dayImage(g.day, segsByDay.get(g.day)));
  const heroImg =
    (plan?.roads || []).find((r) => r.official?.type?.startsWith("All") && r.info?.image)?.info.image ||
    dayImgs[Math.floor(dayImgs.length / 2)] ||
    dayImgs.find(Boolean) ||
    "";
  const long = routes.scenic ? longDays() : [];
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

  const stat = (value, label, sub = "") =>
    `<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span>${sub ? `<small>${sub}</small>` : ""}</div>`;

  const hero = `
    <header class="trip-hero">
      ${heroImg ? `<img class="hero-img" src="${esc(heroImg)}" alt="" onerror="this.remove()">` : artSvg()}
      <div class="hero-shade"></div>
      <div class="hero-inner">
        <p class="kicker">${icon("route", 16)} ${groups.length} ${groups.length === 1 ? "day" : "days"} · ${esc(shortName(stops[0]?.name || ""))} to ${esc(shortName(stops.at(-1)?.name || ""))}</p>
        ${renameDraft != null
          ? `<textarea id="rename-input" class="rename-input" rows="1" maxlength="120" aria-label="Trip name">${esc(renameDraft)}</textarea>`
          : `<h1>${esc(tripTitle())}${READONLY ? "" : ` <button class="rename-btn" data-act="rename" title="Rename the trip" aria-label="Rename the trip">${icon("pencil", 20)}</button>`}</h1>`}
        ${plan?.summary ? `<p class="lede">${esc(plan.summary)}</p>` : ""}
        ${(() => {
          const out = uncoveredStops();
          return out.length
            ? `<p class="cov-warn">${icon("alert", 16)} ${out.length === 1 ? "1 stop is" : `${out.length} stops are`} outside the areas we cover
                (grey on the map): ${esc(out.map((s) => shortName(s.name)).join(", "))}. Routes and photos work there, but there's no road list to pick from yet.</p>`
            : "";
        })()}
        ${seasonalHero(groups, segsByDay)}
        ${(() => {
          const dark = tripSettings().noNight && routes.scenic ? afterDarkDays() : [];
          return dark.length
            ? `<p class="cov-warn">${icon("moon", 16)} <span>Day ${dark.join(", ")} ${dark.length === 1 ? "ends" : "end"} after sunset, and you'd rather not drive in the dark.
                ${READONLY ? "" : `<button class="link-btn" data-act="fix">Shorten ${dark.length === 1 ? "it" : "them"}</button>`}</span></p>`
            : "";
        })()}
        <div class="hero-actions">
          <button class="btn blue" data-act="map">${icon("map", 18)} Open the map</button>
          ${routes.scenic ? `<button class="btn ghost" data-act="today">${icon("clock", 18)} Today</button>` : ""}
          ${plan && !READONLY ? `<button class="btn ghost" data-act="goto-roads">${icon("road", 18)} Pick roads</button>` : ""}
          ${!routes.scenic && stops.length > 1 && !READONLY ? `<button class="btn ghost" data-act="route">${icon("route", 18)} Find routes</button>` : ""}
          ${routes.scenic && !hasElevation() && !READONLY ? `<button class="btn ghost" data-act="route">${icon("mountain", 18)} Measure elevation</button>` : ""}
          ${long.length && plan && !READONLY ? `<button class="btn warn" data-act="fix">${icon("alert", 18)} Fix long days (${long.map((d) => `D${d}`).join(", ")})</button>` : ""}
          ${reorderSaves ? `<button class="btn warn" data-act="order-fix">${icon("route", 18)} Fix backtracking (${fmtMi(reorderSaves)} shorter)</button>` : ""}
          ${plan && !(plan.spots || []).length && !READONLY ? `<button class="btn ghost" data-act="details">${icon("sparkle", 18)} Write the day guides</button>` : ""}
          ${moreMenu()}
        </div>
      </div>
    </header>
    ${
      totals
        ? `<div class="stats">
            ${stat(fmtMi(totals.dist).replace(/ (mi|km)$/, ""), KM ? "km" : "miles")}
            ${stat(fmtShort(totals.dur), "driving", totals.extra != null ? `${totals.extra > 60 ? "+" + fmtShort(totals.extra) : "same"} vs fastest` : "")}
            ${stat(`${pct(totals.featured, totals.dist)}%`, "on featured roads", `${fmtMi(totals.featured)}`)}
            ${stat(`${pct(totals.freeway, totals.dist)}%`, "freeway", "for the long transit stretches")}
            ${tripClimb() != null ? stat(fmtElev(tripClimb()).replace(/ (ft|m)$/, ""), KM ? "m of climbing" : "ft of climbing",
              routes.scenic.unpaved_m > 1500 ? `${fmtMi(routes.scenic.unpaved_m)} unpaved` : routes.scenic.ferry_m > 500 ? `${fmtMi(routes.scenic.ferry_m)} by ferry` : "") : ""}
            ${stat(String((plan?.spots || []).length), "spots", `${(plan?.roads || []).length} featured roads`)}
          </div>`
        : ""
    }
    ${stops.length ? settingsStrip() : ""}
    ${costCard()}`;

  const index = `
    <nav class="day-index" aria-label="Days">
      ${groups
        .map((g) => {
          const meta = plan?.days?.find((d) => Number(d.day) === g.day);
          const st = dayStats(g, "scenic");
          return `<a href="#day-${g.day}" data-act="jump" data-day="${g.day}">
            <span class="di-num">${g.day}</span>
            <span class="di-text"><b data-fit="12">${esc(meta?.title || `Day ${g.day}`)}</b><small>${st ? fmtShort(st.dur) + " · " + fmtMi(st.dist) : ""}</small></span>
          </a>`;
        })
        .join("")}
    </nav>`;

  const days = groups.map((g, gi) => renderDay(g, gi, groups, segsByDay.get(g.day))).join("");

  // Pages the planner read on the web (Claude with web search)
  const host = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return u;
    }
  };
  const sources = (plan?.sources || []).filter((s) => /^https?:/.test(s.url));
  const sourceList = sources.length
    ? `<section class="sources"><h3>${icon("book", 18)} What the planner read</h3><ul>
        ${sources
          .map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener"><b>${esc(s.title)}</b><small>${esc(host(s.url))}</small></a></li>`)
          .join("")}
      </ul></section>`
    : "";

  const alongBtn = alongButton();
  IT.innerHTML = `${hero}${requestCard()}${plan && !READONLY ? roadsPanel() : ""}<div class="it-layout">${index}<div class="days">
    ${alongBtn ? `<div class="along-bar">${alongBtn}</div>` : ""}${days}${notesShown() ? notesSection() : ""}${sourceList}
    <p class="credit">Routes and elevation by OpenRouteService. Road details from the AI planner, the FHWA America's Byways program and Wikipedia.
    Photos from Wikipedia and Wikimedia Commons; tap a photo for its author and license. Fuel, chargers, sights and lodging counts
    from OpenStreetMap contributors. Weather by Open-Meteo. Terrain from Mapzen terrain tiles.</p></div></div>`;

  // Overnight photos come from Commons and load after the page is drawn.
  IT.querySelectorAll("[data-overnight]").forEach(async (el) => {
    const s = stops[Number(el.dataset.overnight)];
    const photos = s ? await photosFor(s) : [];
    if (photos[0]) el.insertAdjacentHTML("afterbegin", `<img src="${esc(photos[0])}" alt="" loading="lazy" onerror="this.remove()">`);
  });
}

// ---------- the original request, past changes, and a box to ask for more ----------

function requestCard() {
  const edits = trip.edits || [];
  // (features.js, loaded after this file, defines the ask state)
  const askState = typeof window.askState === "object" ? window.askState : typeof getAskState === "function" ? getAskState() : { mode: "change", busy: false };
  const qaHtml = typeof window.qaHtmlFn === "function" ? window.qaHtmlFn : () => "";
  const when = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? "" : d.toLocaleDateString([], { month: "short", day: "numeric" });
  };
  return `<section class="request-card">
    <div class="rc-main">
      <p class="rc-label">${icon("sparkle", 14)} Your request</p>
      <p class="rc-prompt">${trip.prompt ? `“${esc(trip.prompt)}”` : `<span class="subtle">Planned by hand</span>`}</p>
      ${edits.length
        ? `<ol class="rc-edits">${edits.map((e) => `<li><span>${esc(when(e.at))}</span>${esc(e.text)}</li>`).join("")}</ol>`
        : ""}
      ${(trip.versions || []).length
        ? `<button class="link-btn rc-versions" data-act="versions">${icon("refresh", 14)} Compare or restore earlier versions (${trip.versions.length})</button>`
        : ""}
    </div>
    ${plan
      ? `<div class="rc-side">
        <div class="rc-tabs" role="tablist">
          ${READONLY ? "" : `<button role="tab" data-act="rc-mode" data-v="change" aria-selected="${askState.mode === "change"}" class="${askState.mode === "change" ? "on" : ""}">${icon("refresh", 14)} Change the trip</button>`}
          ${askState.mode === "ask" || READONLY || trip.qa?.length ? `<button role="tab" data-act="rc-mode" data-v="ask" aria-selected="${askState.mode === "ask" || READONLY}" class="${askState.mode === "ask" || READONLY ? "on" : ""}">${icon("sparkle", 14)} Ask about it</button>` : ""}
        </div>
        ${askState.mode === "ask" || READONLY
          ? `<form class="rc-form" id="ask-form">
              <textarea id="ask-text" rows="2" aria-label="Ask about this trip"
                placeholder="${esc(tripExamples().ask)}"></textarea>
              <button class="btn blue" type="submit" ${askState.busy ? "disabled" : ""}>${icon("sparkle", 18)} Ask</button>
            </form>${qaHtml()}`
          : `<form class="rc-form" id="edit-form">
              <textarea id="edit-text" rows="2" aria-label="Ask for a change"
                placeholder="${esc(tripExamples().change)}"></textarea>
              <button class="btn blue" type="submit" ${typeof liveState !== "undefined" && liveState.busy ? "disabled" : ""}>${icon("refresh", 18)} Update trip</button>
            </form>`}
      </div>`
      : ""}
  </section>`;
}

// ---------- road picker: keep, remove or add the trip's featured roads ----------

// Pending choices, applied together with "Update trip".
const roadDraft = { add: new Map(), remove: new Set() };
// Official byways in the trip's states (loaded once per set of states) and AI road ideas (saved on the plan).
const bywayList = { key: "", items: null, loading: false, showAll: false };
let ideasLoading = false;

const sameRoad = (a, b) => coreName(a) === coreName(b);
const onTrip = (name) => (plan?.roads || []).some((r) => sameRoad(r.name, name) || sameRoad(r.official?.name, name));

function loadByways() {
  const states = tripStates();
  const key = states.join(",");
  if (!key || bywayList.key === key || bywayList.loading) return;
  bywayList.loading = true;
  fetch(`/api/byways?states=${encodeURIComponent(key)}`)
    .then((r) => r.json())
    .then((d) => Object.assign(bywayList, { key, items: d.byways || [] }))
    .catch(() => Object.assign(bywayList, { key, items: [] }))
    .finally(() => {
      bywayList.loading = false;
      refreshRoads();
    });
}

function roadRow({ name, ref, meta, why, badge, action, actionLabel, state }) {
  return `<li class="rp-row ${state || ""}">
    ${shield(ref, name)}
    <div class="rp-text">
      <b>${esc(name)}${badge || ""}</b>
      ${meta ? `<small>${esc(meta)}</small>` : ""}
      ${why ? `<p>${esc(why)}</p>` : ""}
    </div>
    ${action}
  </li>`;
}
const addBtn = (key, picked) =>
  `<button class="rp-btn ${picked ? "on" : ""}" data-act="road-add" data-key="${esc(key)}">${icon(picked ? "check" : "plus", 16)} ${picked ? "Added" : "Add"}</button>`;

function roadsPanel() {
  loadByways();
  const states = tripStates();
  const current = (plan.roads || []).map((r) => {
    const removing = roadDraft.remove.has(r.name);
    return roadRow({
      name: r.name,
      ref: r.ref,
      meta: [r.segment, r.days?.length ? `Day ${r.days.join(", ")}` : ""].filter(Boolean).join(" · "),
      badge: r.official ? `<span class="badge-official ${r.official.type.startsWith("All") ? "aar" : ""}">${esc(r.official.type)}</span>` : "",
      state: removing ? "removing" : "",
      action: `<button class="rp-btn ${removing ? "" : "danger"}" data-act="road-remove" data-name="${esc(r.name)}">${
        removing ? `${icon("refresh", 16)} Keep` : `${icon("close", 16)} Remove`}</button>`,
    });
  });

  const byways = (bywayList.items || []).filter((b) => !onTrip(b.name));
  const sorted = [...byways].sort((a, b) => (b.type.startsWith("All") - a.type.startsWith("All")) || (b.miles || 0) - (a.miles || 0));
  const shown = bywayList.showAll ? sorted : sorted.slice(0, 6);
  const bywayRows = shown.map((b) =>
    roadRow({
      name: b.name,
      ref: "",
      meta: [b.states.join(", "), b.miles ? fmtMiles(b.miles) : ""].filter(Boolean).join(" · "),
      why: b.description,
      badge: `<span class="badge-official ${b.type.startsWith("All") ? "aar" : ""}">${esc(b.type)}</span>`,
      state: roadDraft.add.has(`b:${b.name}`) ? "adding" : "",
      action: addBtn(`b:${b.name}`, roadDraft.add.has(`b:${b.name}`)),
    })
  );

  const ideas = (plan.roadIdeas || []).filter((r) => !onTrip(r.name));
  const ideaRows = ideas.map((r) =>
    roadRow({
      name: r.name,
      ref: r.ref,
      meta: [r.state, r.miles ? `about ${fmtMiles(r.miles)}` : ""].filter(Boolean).join(" · "),
      why: r.why,
      state: roadDraft.add.has(`i:${r.name}`) ? "adding" : "",
      action: addBtn(`i:${r.name}`, roadDraft.add.has(`i:${r.name}`)),
    })
  );

  const pending = roadDraft.add.size + roadDraft.remove.size;
  return `<section class="roads-panel" id="roads">
    <header class="rp-head">
      <div>
        <h2>${icon("road", 22)} Scenic roads</h2>
        <p>Pick the roads you want to drive. The planner reroutes the trip through every road you add.</p>
      </div>
    </header>

    <h3>On this trip</h3>
    <ul class="rp-list">${current.join("") || `<li class="rp-empty">No featured roads yet. Add some below.</li>`}</ul>

    <h3>Scenic byways along the way${states.length ? ` <small>${esc(states.join(", "))}</small>` : ""}</h3>
    ${bywayList.loading && !bywayList.items
      ? `<p class="rp-empty">Loading...</p>`
      : `<ul class="rp-list">${bywayRows.join("") || `<li class="rp-empty">No other designated byways in these states.</li>`}</ul>
         ${sorted.length > 6 ? `<button class="rp-more" data-act="byways-all">${bywayList.showAll ? "Show fewer" : `Show all ${sorted.length}`}</button>` : ""}`}

    <h3>More roads drivers love</h3>
    ${ideaRows.length ? `<ul class="rp-list">${ideaRows.join("")}</ul>` : ""}
    <button class="btn ghost rp-find" data-act="road-ideas" ${ideasLoading ? "disabled" : ""}>
      ${ideasLoading ? `<span class="spinner"></span> Searching for roads...` : `${icon("sparkle", 18)} ${ideaRows.length ? "Find more" : "Find roads with AI"}`}
    </button>

    ${pending
      ? `<div class="rp-bar">
          <span>${[
            roadDraft.add.size ? `${roadDraft.add.size} to add` : "",
            roadDraft.remove.size ? `${roadDraft.remove.size} to remove` : "",
          ].filter(Boolean).join(", ")}</span>
          <button class="btn ghost" data-act="road-clear">Clear</button>
          <button class="btn blue" data-act="road-apply">${icon("refresh", 18)} Update trip</button>
        </div>`
      : ""}
  </section>`;
}

function refreshRoads() {
  const el = $("roads");
  if (el && plan) el.outerHTML = roadsPanel();
}

async function findRoadIdeas() {
  if (ideasLoading) return;
  ideasLoading = true;
  refreshRoads();
  try {
    const d = await api("/api/road-ideas", {
      prompt: trip.prompt || trip.name,
      states: tripStates(),
      have: [...(plan.roads || []).map((r) => r.name), ...(plan.roadIdeas || []).map((r) => r.name)],
    });
    const have = new Set((plan.roadIdeas || []).map((r) => coreName(r.name)));
    plan.roadIdeas = [...(plan.roadIdeas || []), ...d.roads.filter((r) => !have.has(coreName(r.name)))];
    addSources(d.sources);
    scheduleSave();
  } catch (e) {
    setStatus(e.message);
  }
  ideasLoading = false;
  refreshRoads();
}

function toggleRoadAdd(key) {
  if (roadDraft.add.has(key)) roadDraft.add.delete(key);
  else {
    const [kind, ...rest] = key.split(":");
    const name = rest.join(":");
    if (kind === "b") {
      const b = (bywayList.items || []).find((x) => x.name === name);
      if (b) roadDraft.add.set(key, { name: b.name, ref: b.ref || "", states: b.states, why: b.description, osm: b.osm || "" });
    } else {
      const r = (plan.roadIdeas || []).find((x) => x.name === name);
      if (r) roadDraft.add.set(key, { name: r.name, ref: r.ref, states: r.state, why: r.why });
    }
  }
  refreshRoads();
}

function applyRoads() {
  const roadEdits = { add: [...roadDraft.add.values()], remove: [...roadDraft.remove] };
  roadDraft.add.clear();
  roadDraft.remove.clear();
  revisePlan({ roadEdits, title: "Rerouting through your roads", note: roadEditText(roadEdits) });
}

// ---------- day timeline: when you reach each featured road and spot ----------

const clock = (min) => {
  const m = Math.round(min) % (24 * 60);
  const h = Math.floor(m / 60);
  return `${((h + 11) % 12) + 1}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
};
function coordAt(line, f) {
  if (!line) return null;
  const target = f * (line.cum[line.cum.length - 1] || 0);
  const k = line.cum.findIndex((c) => c >= target);
  return line.coords[k < 0 ? line.coords.length - 1 : k];
}

// arr: dayArrival() for the day (time zones and sunset, when the trip has dates).
function dayTimeline(g, segs, placed, line, st, startName, endName, arr) {
  if (!st) return "";
  const total = segs.reduce((a, s) => a + s.distance_m, 0) || 1;
  const events = [{ kind: "start", f: 0 }];
  let acc = 0;
  for (const s of segs) {
    const last = events[events.length - 1];
    if (s.ferry_m > s.distance_m / 2) {
      events.push({ kind: "ferry", f: acc / total, seg: s, dist: s.distance_m, dur: s.duration_s });
    } else if (s.road) {
      if (last.kind === "road" && last.road === s.road) {
        last.dist += s.distance_m;
        last.dur += s.duration_s;
      } else events.push({ kind: "road", f: acc / total, road: s.road, ref: s.ref, dist: s.distance_m, dur: s.duration_s });
    }
    acc += s.distance_m;
  }
  placed.forEach((p, n) => events.push({ kind: "spot", f: p.pos ? p.pos.along : 0.98 + n * 0.001, ...p }));
  events.push({ kind: "end", f: 1 });
  events.sort((a, b) => a.f - b.f || (a.kind === "end") - (b.kind === "end"));

  const start = startMinutes();
  const shift = arr?.shift || 0;
  const zone = (tz) => (shift && tz && arr?.date ? ` <i>${esc(tzAbbr(tz, arr.date))}</i>` : "");
  let stopped = 0;
  const rows = events.map((e) => {
    const r = rowFor(e);
    // where the row is in the day (0 to 1), so the day chart and the row can point at each other
    if (r.html) r.html = r.html.replace(/^<li class="/, `<li data-f="${Math.min(1, Math.max(0, e.f)).toFixed(4)}" class="`);
    return r;
  });
  function rowFor(e) {
    const min = start + (st.dur / 60) * e.f + stopped;
    const t = clock(min);
    const at = coordAt(line, e.f);
    const go = at ? `data-act="tl" data-lng="${at[0]}" data-lat="${at[1]}" data-day="${g.day}"` : "";
    if (e.kind === "start") {
      return { min, html: `<li class="tl-row"><button ${go}><time>${t}${zone(arr?.tzStart)}</time><span class="tl-ico">${icon("pin", 16)}</span>
        <span class="tl-text"><b>Leave ${esc(startName)}</b></span></button></li>` };
    }
    if (e.kind === "end") {
      const dark = arr?.dark;
      return { min, html: `<li class="tl-row end ${dark ? "dark" : ""}"><button ${go}><time>${clock(min + shift)}${zone(arr?.tzEnd)}</time><span class="tl-ico">${icon(g.day ? "moon" : "pin", 16)}</span>
        <span class="tl-text"><b>Arrive ${esc(endName)}</b><small>${fmtShort(st.dur)} driving${stopped ? ` + ${fmtShort(stopped * 60)} of stops` : ""}${dark ? " · after dark" : ""}</small></span></button></li>` };
    }
    if (e.kind === "road") {
      return { min, html: `<li class="tl-row road"><button ${go}><time>${t}</time>${shield(e.road.ref || e.ref, e.road.name)}
        <span class="tl-text"><b>${esc(e.road.name)}</b><small>Featured road · ${fmtMi(e.dist)} · ${fmtShort(e.dur)}</small></span></button></li>` };
    }
    if (e.kind === "ferry") {
      const link = ferryLink(e.seg, g);
      return { min, html: `<li class="tl-row ferry"><button ${go}><time>${t}</time><span class="tl-ico">${icon("ferry", 16)}</span>
        <span class="tl-text"><b>Ferry: ${esc(e.seg.name || "crossing")}</b><small>${fmtMi(e.dist)} · about ${fmtShort(e.dur)} plus boarding</small></span></button>
        ${link ? `<a class="tl-link" href="${esc(link[1])}" target="_blank" rel="noopener">Book with ${esc(link[0])} ${icon("external", 12)}</a>` : ""}</li>` };
    }
    const s = e.s;
    const mins = Number(s.minutes) || 0;
    stopped += mins;
    const where = !e.pos ? "" : e.pos.offKm > 5 ? ` · ${fmtMi(e.pos.offKm * 1000)} off route` : "";
    const btn = s.info?.lat != null ? `data-act="spot" data-i="${e.i}"` : go;
    return { min, html: `<li class="tl-row spot"><button ${btn}><time>${t}</time><span class="tl-ico t-${esc(s.type)}">${icon(spotType(s.type).icon, 16)}</span>
      <span class="tl-text"><b>${esc(s.name)}</b><small>${esc(spotType(s.type).label)}${mins ? ` · stop ${fmtShort(mins * 60)}` : ""}${esc(where)}</small></span></button></li>` };
  }
  // Golden hour and sunset, when they come before the day ends (times at the destination, shown in the start's zone)
  const endMin = rows.at(-1).min;
  const sunRow = (m, label, ico) =>
    m != null && m - shift > start && m - shift < endMin
      ? { min: m - shift, html: `<li class="tl-row sun"><div class="tl-static"><time>${clock(m - shift)}</time><span class="tl-ico">${icon(ico, 16)}</span>
          <span class="tl-text"><b>${label}${shift && arr?.tzEnd ? ` in ${esc(endName)}, ${clock(m)} ${esc(tzAbbr(arr.tzEnd, arr.date))}` : ""}</b></span></div></li>` }
      : null;
  const sun = [sunRow(arr?.goldenMin, "Golden hour", "sun"), sunRow(arr?.sunsetMin, "Sunset", "sunset")].filter(Boolean);
  const all = [...rows.slice(0, -1), ...sun].sort((a, b) => a.min - b.min).concat(rows.at(-1));
  const go = `<span class="tl-go">${icon("map", 14)} Map</span>`;
  return `<ol class="timeline">${all.map((r) => r.html.replace("</button></li>", `${go}</button></li>`)).join("")}</ol>`;
}

function renderDay(g, gi, groups, segs) {
  const day = g.day;
  const meta = plan?.days?.find((d) => Number(d.day) === day);
  const st = dayStats(g, "scenic");
  const startIdx = gi > 0 ? groups[gi - 1].items.at(-1) : g.items[0];
  const endIdx = g.items.at(-1);
  const startName = shortName(stops[startIdx]?.name || "");
  const endName = shortName(stops[endIdx]?.name || "");
  const featuredM = segs.filter((s) => s.road).reduce((a, s) => a + s.distance_m, 0);
  const links = dayLinks(groups, gi);
  const img = dayImage(day, segs);
  const line = routes.scenic ? dayLine(day) : null;
  const spots = (plan?.spots || []).map((s, i) => ({ s, i })).filter(({ s }) => s.day === day);
  const placed = spots.map(({ s, i }) => ({ s, i, pos: spotAlong(line, s) }));
  const roadsToday = (plan?.roads || []).filter((r) => roadDays(r).includes(day));
  const long = st && st.dur > longDayS();
  const arr = routes.scenic ? dayArrival(g, gi) : null;
  const seasonal = seasonalForDay(g, segs);

  const timeline = routes.scenic
    ? dayTimeline(g, segs, placed, line, st, startName, endName, arr)
    : `<p class="subtle">Find routes to see the timeline for this day.</p>`;

  const roadCards = roadsToday
    .map((r) => {
      const onRoute = segs.filter((s) => s.road === r).reduce((a, s) => a + s.distance_m, 0);
      const o = r.official;
      const season = seasonal.find((x) => (x.r.match || []).some((m) => `${r.name} ${r.ref || ""}`.toLowerCase().includes(m)));
      return `<article class="road-card">
        ${r.info?.image ? `<button class="road-img-btn" data-act="gallery" data-q="${esc(r.name)}" data-near="${esc(roadNear(r).map((p) => p.map((x) => x.toFixed(3)).join(",")).join(";"))}" data-ctx="${esc(placesText(roadStops(r)))}" data-first="${esc(r.info.image)}" aria-label="Photos of ${esc(r.name)}">
          <img class="road-img" src="${esc(r.info.image)}" alt="" loading="lazy" onerror="this.remove()"><span class="gal-hint">${icon("photo", 14)} Photos</span></button>` : ""}
        <div class="road-body">
          <div class="road-head">${shield(r.ref, r.name)}<h4>${esc(r.name)}</h4>
            ${o ? `<span class="badge-official ${o.type.startsWith("All") ? "aar" : ""}">${esc(o.type)}</span>` : ""}</div>
          <small class="road-seg">${esc(r.segment || "")}${onRoute >= 8047 ? ` · ${fmtMi(onRoute)} on this route` : ""}</small>
          ${onRoute >= 8047 ? ratingHtml(roadStats(r)) : ""}
          ${season ? `<p class="road-warn ${seasonClass(season.status)}">${icon("calendar", 14)} <span><b>${esc(season.status ? SEASON_LABEL[season.status] : seasonText(season.r))}.</b>
            ${esc(season.r.note)} ${season.r.url ? `<a href="${esc(season.r.url)}" target="_blank" rel="noopener">Road status ${icon("external", 12)}</a>` : ""}</span></p>` : ""}
          ${routes.scenic && onRoute < 8047 && !READONLY
            ? `<p class="road-warn">${icon("alert", 14)} <span>Today's route ${onRoute ? `only touches this road (${fmtMi(onRoute)})` : "doesn't use this road yet"}.
                <button class="link-btn" data-act="road-force" data-name="${esc(r.name)}">Route through it</button></span></p>`
            : ""}
          ${r.why ? `<p>${esc(r.why)}</p>` : ""}
          ${r.drive || r.tips ? `<dl>${r.drive ? `<dt>Driving it</dt><dd>${esc(r.drive)}</dd>` : ""}${r.tips ? `<dt>Tips</dt><dd>${esc(r.tips)}</dd>` : ""}</dl>` : ""}
          ${o ? `<p class="official">${icon("book", 14)} <span><b>Official:</b> ${esc(o.description)}${o.miles ? ` (${fmtMiles(o.miles)})` : ""}</span></p>` : ""}
          ${reviewsHtml(r)}
          <div class="links">
            ${READONLY || reviewState.has(r.name) ? "" : `<button class="link-btn" data-act="road-reviews" data-name="${esc(r.name)}">${icon("sparkle", 13)} What drivers say</button>`}
            ${onRoute >= 8047 ? `<button class="link-btn" data-act="fly" data-name="${esc(r.name)}">${icon("mountain", 13)} Fly it in 3D</button>` : ""}
            ${READONLY ? "" : `<button class="link-btn" data-act="road-swap" data-name="${esc(r.name)}">${icon("refresh", 13)} Swap for another road</button>`}
            ${r.info?.url ? `<a href="${esc(r.info.url)}" target="_blank" rel="noopener">Wikipedia ${icon("external", 13)}</a>` : ""}
            ${o?.fhwa ? `<a href="${esc(o.fhwa)}" target="_blank" rel="noopener">America's Byways ${icon("external", 13)}</a>` : ""}
          </div>
        </div>
      </article>`;
    })
    .join("");

  const spotCards = placed
    .map(({ s, i, pos }) => {
      const t = spotType(s.type);
      const where = !pos ? "" : pos.offKm > 5 ? `${fmtMi(pos.offKm * 1000)} off route` : "On the route";
      return `<article class="spot-card">
        <button class="spot-img" data-act="gallery" data-q="${esc(s.name)}" data-at="${s.info?.lat != null ? `${s.info.lat},${s.info.lng}` : ""}" data-ctx="${esc(placesText(stops.filter((x) => Math.abs(x.day - s.day) <= 1)))}" data-first="${esc(s.info?.image || "")}" aria-label="Photos of ${esc(s.name)}">${s.info?.image ? `<img src="${esc(s.info.image)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
          <span class="spot-type t-${esc(s.type)}">${icon(t.icon, 14)} ${esc(t.label)}</span></button>
        <div class="spot-body">
          <h4>${esc(s.name)}</h4>
          <p>${esc(s.why || "")}</p>
          <div class="spot-meta">
            ${s.minutes ? `<span>${icon("clock", 14)} ${esc(fmtShort(Number(s.minutes) * 60))}</span>` : ""}
            ${where ? `<span>${icon("pin", 14)} ${esc(where)}</span>` : ""}
          </div>
          <div class="spot-actions">
            ${s.info?.lat != null ? `<button data-act="spot" data-i="${i}">${icon("map", 14)} Map</button>` : ""}
            ${s.info?.url ? `<a href="${esc(s.info.url)}" target="_blank" rel="noopener">Wikipedia ${icon("external", 13)}</a>` : ""}
          </div>
        </div>
      </article>`;
    })
    .join("");

  const isLast = gi === groups.length - 1;
  const date = dayDate(day);
  const when = date ? new Date(`${date}T12:00:00Z`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }) : "";
  const sunChip = arr?.sunsetMin != null
    ? `<span class="${arr.dark ? "warn" : ""}" title="Sunrise ${clock(arr.riseMin)}, golden hour from ${clock(arr.goldenMin)} at ${esc(endName)}">${icon("sunset", 16)} Sunset ${clock(arr.sunsetMin)}${arr.dark ? " · arrive after dark" : ""}</span>`
    : "";
  const seasonBox = seasonal.length
    ? `<div class="season-box">${seasonal.map((x) => `<p class="road-warn ${seasonClass(x.status)}">${icon("calendar", 14)} <span><b>${esc(x.r.name)}:</b>
        ${esc(x.status ? `${SEASON_LABEL[x.status]}. ` : `${seasonText(x.r)}. `)}${esc(x.r.note)}
        ${x.r.url ? `<a href="${esc(x.r.url)}" target="_blank" rel="noopener">Road status ${icon("external", 12)}</a>` : ""}</span></p>`).join("")}</div>`
    : "";
  const stay = meta?.stay || "";
  const lodging = alongFor(day)?.lodging;
  const lodgingText = lodging
    ? [lodging.hotel + lodging.guest ? `${lodging.hotel + lodging.guest} hotels and inns` : "", lodging.motel ? `${lodging.motel} motels` : "",
       lodging.camp ? `${lodging.camp} campgrounds` : ""].filter(Boolean).join(", ")
    : "";
  const endStop = stops[endIdx];
  const stayHtml = isLast ? "" : stayLinks(endStop, date, alongFor(day));
  return `<section class="day" id="day-${day}">
    <div class="day-hero">
      ${img ? `<img src="${esc(img)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
      <div class="hero-shade"></div>
      <div class="day-hero-text">
        <span class="day-kicker">Day ${day}${when ? ` · ${esc(when)}` : ""}</span>
        <h2>${esc(meta?.title || `${startName} to ${endName}`)}</h2>
        <p>${esc(startName)} ${icon("chevron", 14)} ${esc(endName)}</p>
      </div>
    </div>
    <div class="day-stats">
      ${st ? `<span class="${long ? "warn" : ""}">${icon("clock", 16)} ${fmtShort(st.dur)}${long ? " · long day" : ""}</span><span>${icon("gauge", 16)} ${fmtMi(st.dist)}</span>` : ""}
      ${st && featuredM ? `<span class="accent">${icon("sparkle", 16)} ${Math.round((featuredM / st.dist) * 100)}% featured roads</span>` : ""}
      ${weatherChip(gi, endName)}
      ${sunChip}
      ${routeChips(segs)}
      <span class="grow"></span>
      ${!links ? "" : links.parts.length > 1
        // more places than one link carries: the day in parts that meet at a shared place
        ? ["Google Maps", "Apple Maps"].map((app) => `<span class="app-link app-parts">${icon("pin", 16)} ${app}
            ${links.parts.map((p, k) => `<a href="${esc(p[app.startsWith("G") ? "google" : "apple"])}" target="_blank" rel="noopener" title="${esc(`${p.from} to ${p.to}`)}">Part ${k + 1}</a>`).join("")}</span>`).join("")
        : `<a class="app-link" href="${esc(links.google)}" target="_blank" rel="noopener">${icon("pin", 16)} Google<span class="long"> Maps</span></a>
           <a class="app-link" href="${esc(links.apple)}" target="_blank" rel="noopener">${icon("pin", 16)} Apple<span class="long"> Maps</span></a>`}
      <button class="app-link" data-act="day-map" data-day="${day}">${icon("map", 16)} <span class="long">Show on map</span><span class="short">Map</span></button>
      ${links ? `<button class="app-link send-phone" data-act="day-phone" data-day="${day}" title="QR codes of this day's map links">${icon("phone", 16)} Send to phone</button>` : ""}
    </div>
    ${meta?.summary ? `<p class="day-summary">${esc(meta.summary)}</p>` : ""}
    ${seasonBox}
    <h3>${icon("clock", 18)} The day</h3>
    ${routes.scenic ? driveChartHtml(g, segs, placed, st, startName, endName) : ""}
    ${timeline}
    ${alongHtml(g)}
    ${roadCards ? `<h3>${icon("route", 18)} Featured roads</h3><div class="road-cards">${roadCards}</div>` : ""}
    ${spotCards ? `<h3>${icon("viewpoint", 18)} Stops along the way</h3><div class="spot-grid">${spotCards}</div>` : ""}
    <div class="overnight ${stay || lodgingText ? "has-stay" : ""}" data-overnight="${endIdx}">
      <div class="on-text">${icon(isLast ? "pin" : "moon", 20)}<div><small>${isLast ? "Destination" : "Overnight"}</small><b>${esc(endStop?.name || "")}</b>
        ${stay ? `<p class="stay">${esc(stay)}${meta?.price ? ` <span class="price" title="Typical lodging price">${esc(meta.price)}</span>` : ""}</p>` : ""}
        ${lodgingText || endStop ? `<p class="stay-meta">${lodgingText ? `${esc(lodgingText)} within 8 km · ` : ""}<a href="https://www.google.com/maps/search/${encodeURIComponent(`lodging near ${endStop?.name || ""}`)}/@${endStop?.lat},${endStop?.lng},12z" target="_blank" rel="noopener">See places to stay ${icon("external", 12)}</a></p>` : ""}
      </div></div>
    </div>
    ${stayHtml}
  </section>`;
}

// Places to stay and eat near an overnight (from "Along the route"), and booking searches for that night's dates.
const STAY_KIND = { hotel: "Hotel", motel: "Motel", guest: "Inn / B&B", camp: "Campground" };
function stayLinks(stop, date, along) {
  if (!stop) return "";
  const town = shortName(stop.name);
  const where = stop.name.split(",").slice(0, 2).join(",").trim();
  const next = date ? new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10) : "";
  const dates = (inName, outName) => (date ? `&${inName}=${date}&${outName}=${next}` : "");
  const book = [
    ["Booking.com", `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(where)}${dates("checkin", "checkout")}&group_adults=2`],
    ["Airbnb", `https://www.airbnb.com/s/${encodeURIComponent(where)}/homes?${dates("checkin", "checkout").slice(1)}`],
    ["Restaurants on Google Maps", `https://www.google.com/maps/search/${encodeURIComponent(`restaurants near ${where}`)}/@${stop.lat},${stop.lng},14z`],
  ];
  const place = (x, label) => {
    const href = x.web || `https://www.google.com/maps/search/${encodeURIComponent(`${x.name}, ${town}`)}/@${x.lat},${x.lng},16z`;
    return `<a class="stay-place" href="${esc(href)}" target="_blank" rel="noopener"><b>${esc(x.name)}</b><small>${esc(label)}</small></a>`;
  };
  const stays = along?.stay || [];
  const food = along?.food || [];
  return `<div class="stay-more">
      ${stays.length ? `<p class="stay-h">${icon("moon", 14)} Places to stay nearby</p><div class="stay-list">${stays.map((x) => place(x, STAY_KIND[x.k] || "")).join("")}</div>` : ""}
      ${food.length ? `<p class="stay-h">${icon("food", 14)} Food in town</p><div class="stay-list">${food.map((x) => place(x, x.cuisine)).join("")}</div>` : ""}
      <p class="stay-book">${date ? `Night of ${esc(new Date(`${date}T12:00:00Z`).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" }))}:` : "Search:"}
        ${book.map(([t, u]) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(t)} ${icon("external", 12)}</a>`).join(" · ")}</p>
      ${!along?.stay && !READONLY ? `<p class="fine">Names of hotels and restaurants here come with "Along the route" (fuel, chargers and sights).</p>` : ""}
    </div>`;
}

// Write the day guides for a trip whose details are missing (for example after an AI error).
async function writeDetails() {
  if (!plan) return;
  progressStart([
    ["details", "Writing the day guides"],
    ["photos", "Finding photos and articles"],
  ]);
  try {
    progressSet("details", "doing");
    const d = await requestDetails(trip.prompt || trip.name, skeletonOf());
    if (d.error) throw d.error;
    mergeDetails(d.details);
    addSources(d.sources);
    progressSet("details", "done");
    progressSet("photos", "doing");
    await enrichPlan().catch(() => {});
    progress = null;
    scheduleSave();
    renderSpotMarkers();
    renderItinerary();
  } catch (e) {
    progress.error = e.message;
    renderItinerary();
  }
}

// "Ask for a change" under the request
IT.addEventListener("submit", (e) => {
  if (e.target.id !== "edit-form") return;
  e.preventDefault();
  const text = $("edit-text").value.trim();
  if (!text) return;
  $("edit-text").value = "";
  liveChange(text);
});
IT.addEventListener("submit", (e) => {
  if (e.target.id !== "ask-form") return;
  e.preventDefault();
  const text = $("ask-text").value.trim();
  if (!text) return;
  $("ask-text").value = "";
  askTrip(text);
});
// Enter sends the change or question (Shift+Enter for a new line)
IT.addEventListener("keydown", (e) => {
  if ((e.target.id === "edit-text" || e.target.id === "ask-text") && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    e.target.form.requestSubmit();
  }
});

// What drivers say about a road: one web search summed up by the AI (/api/road-reviews, cached there 30 days), asked
// for from the road card; kept here for the session. Without a search key, links to search instead.
const reviewState = new Map();
const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return u;
  }
};
function roadRegion(r) {
  const s = roadStops(r)[0];
  return s ? s.name.split(",").slice(1).join(",").trim() : "";
}
function reviewsHtml(r) {
  const st = reviewState.get(r.name);
  if (!st) return "";
  const q = encodeURIComponent(`${r.name} ${roadRegion(r)} driving`);
  const links = `<a href="https://www.google.com/search?q=${q}" target="_blank" rel="noopener">Google</a> · <a href="https://www.reddit.com/search/?q=${q}" target="_blank" rel="noopener">Reddit</a>`;
  if (st.loading) return `<div class="road-reviews"><p><span class="spinner"></span> Reading what drivers say...</p></div>`;
  if (st.error === "no-search") return `<div class="road-reviews"><p>Web search isn't set up (a free Tavily key in Setup), so look it up: ${links}</p></div>`;
  if (st.error) return `<div class="road-reviews"><p class="warn">${esc(st.error)}</p><p>Look it up: ${links}</p></div>`;
  if (!st.points?.length) return `<div class="road-reviews"><p>The search found nothing useful about this road. Look it up: ${links}</p></div>`;
  return `<div class="road-reviews"><h5>${icon("sparkle", 14)} What drivers say</h5>
    <ul>${st.points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>
    <p class="fine">Summed up by AI from ${st.sources.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(hostOf(x.url))}</a>`).join(", ")}${st.at ? ` (${esc(st.at)})` : ""}. More: ${links}</p></div>`;
}
async function loadRoadReviews(name) {
  const r = (plan?.roads || []).find((x) => x.name === name);
  if (!r) return;
  reviewState.set(name, { loading: true });
  renderItinerary();
  try {
    const d = await fetch("/api/road-reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, region: roadRegion(r) }) }).then((x) => x.json());
    reviewState.set(name, d.error ? { error: d.error } : d);
  } catch {
    reviewState.set(name, { error: "Couldn't reach the app." });
  }
  renderItinerary();
}

// The trip's less-used tools in one menu, so the page leads with the days, roads and maps.
let notesOpen = false;
const notesShown = () => notesOpen || !!(notesOf().text || notesOf().items.length);
function moreMenu() {
  const items = [
    routes.scenic && plan && !READONLY && ["alternatives", "route", "Other versions", "Easier, more scenic or another way, side by side"],
    plan && ["ask", "sparkle", "Ask about the trip", "Questions answered from its own days and places"],
    routes.scenic && ["export", "share", "Export and share", "GPX, print or PDF, a web page, a Wi-Fi link"],
    !notesShown() && ["notes", "list", "Notes and checklist", "Reservations, numbers, things to pack"],
    plan && (plan.spots || []).length && missingPhotos() > 2 && !READONLY && ["photos", "photo", `Find missing photos (${missingPhotos()})`, ""],
    !READONLY && ["new", "plus", "New trip", ""],
  ].filter(Boolean);
  if (!items.length) return "";
  return `<details class="more-menu"><summary class="btn ghost">${icon("chevron", 16, "more-chev")} More</summary>
    <div class="more-list" role="menu">${items.map(([act, ico, label, sub]) => `<button role="menuitem" data-act="${act === "ask" ? "more-ask" : act === "notes" ? "more-notes" : act}">${icon(ico, 16)}<span><b>${esc(label)}</b>${sub ? `<small>${esc(sub)}</small>` : ""}</span></button>`).join("")}</div></details>`;
}
// a click anywhere else, or Esc, closes it; choosing an item does too
document.addEventListener("click", (e) => {
  document.querySelectorAll(".more-menu[open]").forEach((d) => {
    if (!d.contains(e.target) || e.target.closest(".more-list button")) d.open = false;
  });
});
addEventListener("keydown", (e) => e.key === "Escape" && document.querySelectorAll(".more-menu[open]").forEach((d) => (d.open = false)));
// the hero clips what overflows it, so the list is placed on the screen under the button (above it near the bottom)
document.addEventListener("toggle", (e) => {
  const d = e.target;
  if (!d.classList?.contains("more-menu") || !d.open) return;
  const b = d.querySelector("summary").getBoundingClientRect();
  const list = d.querySelector(".more-list");
  const w = Math.min(290, innerWidth - 16);
  list.style.width = `${w}px`;
  list.style.left = `${Math.max(8, Math.min(b.left, innerWidth - w - 8))}px`;
  const below = innerHeight - b.bottom > list.offsetHeight + 16;
  list.style.top = below ? `${b.bottom + 6}px` : `${Math.max(8, b.top - list.offsetHeight - 6)}px`;
}, true);
// scrolling the page moves the button away from its list
IT.addEventListener("scroll", () => document.querySelectorAll(".more-menu[open]").forEach((d) => (d.open = false)), { passive: true });

// Light the rail's number for the day being read.
function spyDays() {
  let cur = null;
  for (const d of IT.querySelectorAll(".day")) {
    if (d.getBoundingClientRect().top < 200) cur = d.id.slice(4);
    else break;
  }
  IT.querySelectorAll(".day-index a").forEach((a) => a.classList.toggle("on", a.dataset.day === (cur ?? "1")));
}
let spyRaf = 0;
IT.addEventListener("scroll", () => {
  if (!spyRaf) spyRaf = requestAnimationFrame(() => {
    spyRaf = 0;
    spyDays();
  });
}, { passive: true });

// The trip's own name when it was renamed, else the planner's title.
const tripTitle = () => (trip.customName ? trip.name : plan?.title || trip.name);
// Rename in place: the title becomes a box of the same size (kept across re-renders while typing); Enter or leaving
// it saves, Esc cancels.
let renameDraft = null;
function startRename() {
  if (READONLY) return;
  renameDraft = tripTitle();
  renderItinerary();
  $("rename-input")?.focus();
  $("rename-input")?.select();
}
function finishRename(save) {
  if (renameDraft == null) return;
  const name = renameDraft.replace(/\s+/g, " ");
  renameDraft = null;
  if (save) renameTrip(name);
  renderItinerary();
}
function growRename(el) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
IT.addEventListener("input", (e) => {
  if (e.target.id !== "rename-input") return;
  renameDraft = e.target.value;
  growRename(e.target);
});
IT.addEventListener("keydown", (e) => {
  if (e.target.id !== "rename-input") return;
  if (e.key === "Enter") {
    e.preventDefault();
    finishRename(true);
  } else if (e.key === "Escape") finishRename(false);
});
// leaving the box saves; a re-render also blurs it but puts focus straight back in the new box
IT.addEventListener("focusout", (e) => {
  if (e.target.id === "rename-input") setTimeout(() => document.activeElement?.id !== "rename-input" && finishRename(true));
});

IT.addEventListener("click", (e) => {
  const t = e.target.closest("[data-act]");
  if (!t) return;
  const act = t.dataset.act;
  if (act === "example") {
    $("plan-prompt").value = t.textContent;
    $("plan-prompt").focus();
  } else if (act === "map") setView("map");
  else if (act === "rename") startRename();
  else if (act === "route") findRoutes();
  else if (act === "fix") fixLongDays();
  else if (act === "details") writeDetails();
  else if (act === "photos") refreshPhotos();
  else if (act === "new") goHome();
  else if (act === "day-map") showDayOnMap(Number(t.dataset.day));
  else if (act === "day-phone") openPhoneSheet(Number(t.dataset.day));
  else if (act === "road-reviews") loadRoadReviews(t.dataset.name);
  else if (act === "spot") showSpotOnMap(Number(t.dataset.i));
  else if (act === "jump") {
    e.preventDefault();
    $(`day-${t.dataset.day}`)?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  } else if (act === "retry") {
    const again = progress?.retry;
    progress = null;
    if (again) again();
    else if (trip.prompt) planTrip(trip.prompt);
    else renderItinerary();
  } else if (act === "goto-roads") {
    $("roads")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (act === "road-add") toggleRoadAdd(t.dataset.key);
  else if (act === "road-remove") {
    const n = t.dataset.name;
    if (roadDraft.remove.has(n)) roadDraft.remove.delete(n);
    else roadDraft.remove.add(n);
    refreshRoads();
  } else if (act === "road-swap") {
    // mark the road for removal and go pick its replacement
    roadDraft.remove.add(t.dataset.name);
    refreshRoads();
    $("roads")?.scrollIntoView({ behavior: "smooth", block: "start" });
  } else if (act === "road-force") {
    const r = (plan?.roads || []).find((x) => x.name === t.dataset.name);
    if (r) routeThroughRoad(r);
  } else if (act === "road-clear") {
    roadDraft.add.clear();
    roadDraft.remove.clear();
    refreshRoads();
  } else if (act === "road-apply") applyRoads();
  else if (act === "road-ideas") findRoadIdeas();
  else if (act === "byways-all") {
    bywayList.showAll = !bywayList.showAll;
    refreshRoads();
  } else if (act === "tl") showPointOnMap(Number(t.dataset.lng), Number(t.dataset.lat), Number(t.dataset.day));
  else if (act === "cancel") {
    progress = null;
    detailsCtl?.abort();
    renderItinerary();
  } else if (act === "opts") openOptions();
  else if (act === "setup") openSetup();
  else if (act === "season-avoid") avoidSeasonal();
  else if (act === "along") loadAlong();
  else if (act === "export") openExport();
  else if (act === "alternatives") openAlternatives();
  else if (act === "today") openToday();
  else if (act === "versions") openVersions();
  else if (act === "more-ask") {
    getAskState().mode = "ask";
    renderItinerary();
    $("ask-text")?.scrollIntoView({ block: "center", behavior: "smooth" });
    $("ask-text")?.focus({ preventScroll: true });
  } else if (act === "more-notes") {
    notesOpen = true;
    renderItinerary();
    $("notes")?.scrollIntoView({ block: "start", behavior: "smooth" });
    $("notes-text")?.focus({ preventScroll: true });
  } else if (act === "rc-mode") {
    getAskState().mode = t.dataset.v;
    renderItinerary();
    $(t.dataset.v === "ask" ? "ask-text" : "edit-text")?.focus();
  } else if (act === "qa-change") {
    const x = trip.qa?.[Number(t.dataset.i)];
    if (x?.change) liveChange(x.change);
  }
  else if (act === "order-fix") applyOrderFix();
  else if (act === "fly") {
    const r = (plan?.roads || []).find((x) => x.name === t.dataset.name);
    if (r) flyRoad(r);
  } else if (act === "gallery") openGallery(t.dataset.q, t.dataset.q, t.dataset.first || "", { at: t.dataset.at, near: t.dataset.near, ctx: t.dataset.ctx });
  else if (act === "suggest-items") {
    const items = suggestedItems();
    notesOf().items.push(...items.map((text) => ({ text, done: false })));
    scheduleSave();
    renderItinerary();
    $("notes")?.scrollIntoView({ block: "nearest" });
  } else if (act === "preset-filter") {
    if (t.dataset.region) presetState.region = t.dataset.region;
    if (t.dataset.days) presetState.days = t.dataset.days;
    renderItinerary();
  } else if (act === "preset-open") openPreset(t.dataset.id);
  else if (act === "batch-suggest") {
    $("batch-list").value = BATCH_SUGGESTIONS.join("\n");
    store.set("batchList", $("batch-list").value);
  } else if (act === "batch-stop") {
    batchState.stop = true;
    renderItinerary();
  }
});
