// Trips: your trips and the ready-made ones in one place, to search, filter and look through before opening one.
// A card per trip (photo, route sketch, days, distance, roads); clicking one opens a preview with every day, the roads
// and what to do with it. Replaces the old "Your trips" list; the globe on Home is the scenic way in, this is the
// practical one.

const libState = { mine: null, ready: null, loading: false, q: "", show: "all", region: "", length: "", sort: "recent", open: null };
const REGIONS = [
  ["", "Anywhere"], ["US", "United States"], ["CA", "Canada"], ["AU", "Australia"], ["NZ", "New Zealand"], ["GB", "UK"], ["ALPS", "The Alps"],
];
const LENGTHS = [["", "Any length"], ["1-2", "1 to 2 days"], ["3-4", "3 to 4 days"], ["5-7", "5 to 7 days"], ["8-99", "8 days or more"]];
const SKETCH_COLORS = ["#0a84ff", "#30d1c6", "#ff9f0a", "#bf5af2", "#30d158", "#ff375f", "#ffd60a", "#64d2ff"];

const regionOf = (t) => {
  const c = t.start ? countryOf(t.start) : null;
  return ["CH", "AT", "IT", "FR", "DE", "LI"].includes(c) ? "ALPS" : c || "";
};
const regionName = (t) => (REGIONS.find(([k]) => k === regionOf(t)) || [, ""])[1];
// distances in miles for US and UK trips, km elsewhere (like the itinerary)
const libDist = (t, m) => {
  if (!m) return "";
  return ["US", "GB"].includes(regionOf(t)) || !regionOf(t) ? `${Math.round(m / 1609.34).toLocaleString()} mi` : `${Math.round(m / 1000).toLocaleString()} km`;
};
const libTown = (n) => String(n || "").split(",")[0].trim();

async function loadLibrary(force) {
  if (libState.loading || (libState.mine && !force)) return;
  libState.loading = true;
  try {
    const [m, r] = await Promise.all([fetch("/api/trips").then((x) => x.json()), fetch("/api/presets").then((x) => x.json())]);
    libState.mine = m.trips || [];
    libState.ready = r.presets || [];
  } catch {
    libState.mine ||= [];
    libState.ready ||= [];
  }
  libState.loading = false;
  renderLibrary();
}

// The route as a small SVG, one color per day, scaled to fit (no map tiles).
function sketchSvg(t, w = 120, h = 80, stroke = 3) {
  const lines = (t.dayList || []).map((d) => d.line).filter((l) => l?.length > 1);
  if (!lines.length) return "";
  const pts = lines.flat();
  const lat0 = pts.reduce((a, p) => a + p[1], 0) / pts.length;
  const kx = Math.cos((lat0 * Math.PI) / 180);
  const xs = pts.map((p) => p[0] * kx);
  const ys = pts.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const pad = stroke * 2;
  const sc = Math.min((w - pad * 2) / (x1 - x0 || 1), (h - pad * 2) / (y1 - y0 || 1));
  const ox = (w - (x1 - x0) * sc) / 2;
  const oy = (h - (y1 - y0) * sc) / 2;
  const P = (p) => `${(ox + (p[0] * kx - x0) * sc).toFixed(1)},${(oy + (y1 - p[1]) * sc).toFixed(1)}`;
  return `<svg class="lib-sketch" viewBox="0 0 ${w} ${h}" aria-hidden="true">${lines
    .map((l, i) => `<polyline points="${l.map(P).join(" ")}" fill="none" stroke="${SKETCH_COLORS[i % SKETCH_COLORS.length]}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round"/>`)
    .join("")}</svg>`;
}

// How far a trip starts from the home base set in "Roads near me" (meters; Infinity without one).
const fromHome = (t) => (nearState.home && t.start ? haversine(nearState.home.at, [t.start.lng, t.start.lat]) : Infinity);
function libFiltered(list) {
  const q = libState.q.trim().toLowerCase();
  const [lo, hi] = libState.length ? libState.length.split("-").map(Number) : [0, 99];
  const out = list.filter((t) => {
    if (libState.region && regionOf(t) !== libState.region) return false;
    if (t.days < lo || t.days > hi) return false;
    if (!q) return true;
    const text = [t.name, t.prompt, t.summary, ...(t.roads || []).map((r) => r.name), ...(t.dayList || []).map((d) => `${d.title} ${d.overnight}`)].join(" ").toLowerCase();
    return q.split(/\s+/).every((w) => text.includes(w));
  });
  const by = {
    recent: (a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || "") || a.name.localeCompare(b.name),
    name: (a, b) => a.name.localeCompare(b.name),
    short: (a, b) => (a.duration_s || 0) - (b.duration_s || 0),
    long: (a, b) => (b.duration_s || 0) - (a.duration_s || 0),
    days: (a, b) => a.days - b.days || a.name.localeCompare(b.name),
    near: (a, b) => fromHome(a) - fromHome(b),
  }[libState.sort === "near" && !nearState.home ? "recent" : libState.sort];
  return out.sort(by);
}

function libCard(t) {
  const roads = (t.roads || []).slice(0, 3);
  return `<button class="lib-card" data-lib="open" data-id="${esc(t.id)}" aria-label="${esc(t.name)}">
    <span class="lib-img">${t.image ? `<img src="${esc(t.image)}" alt="" loading="lazy" onerror="this.remove()">` : ""}
      <span class="lib-badge ${t.preset ? "ready" : "mine"}">${t.preset ? "Ready to go" : `Yours · ${esc(fmtWhen(t.updatedAt))}`}</span>
      ${sketchSvg(t) ? `<span class="lib-sketch-wrap">${sketchSvg(t)}</span>` : ""}</span>
    <span class="lib-body">
      <small class="lib-region">${esc(regionName(t) || "")}${t.loop ? " · Loop" : ""}</small>
      <b data-fit="14">${esc(t.name)}</b>
      <span class="lib-facts">${t.days} day${t.days === 1 ? "" : "s"}${t.distance_m ? ` · ${libDist(t, t.distance_m)}` : ""}${t.duration_s ? ` · ${fmtShort(t.duration_s)} driving` : ""}${libState.sort === "near" && isFinite(fromHome(t)) ? (fromHome(t) < 16000 ? " · starts at home" : ` · starts ${libDist(t, fromHome(t))} away`) : ""}</span>
      ${roads.length ? `<span class="lib-roads">${roads.map((r) => `<span>${esc(r.name)}</span>`).join("")}${t.roads.length > 3 ? `<span>+${t.roads.length - 3}</span>` : ""}</span>` : ""}
    </span>
  </button>`;
}

function libraryHtml() {
  if (!libState.mine) return `<div class="lib"><p class="subtle"><span class="spinner"></span> Loading your trips...</p></div>`;
  const mine = libFiltered(libState.mine);
  const ready = libFiltered(libState.ready);
  const showMine = libState.show !== "ready";
  const showReady = libState.show !== "mine";
  const chips = (name, list, value) => list.map(([k, label]) => `<button class="chip ${value === k ? "on" : ""}" data-lib="${name}" data-v="${k}">${esc(label)}</button>`).join("");
  return `<div class="lib">
    <header class="lib-head">
      <div>
        <p class="kicker">${icon("list", 16)} Trips</p>
        <h1>Your trips and ready-made ones</h1>
        <p class="lede">${libState.mine.length} of yours and ${libState.ready.length} ready to go. Open one as it is, or start from it and make it yours.</p>
      </div>
      <div class="lib-head-acts">
        <button class="btn ghost" data-lib="near">${icon("road", 18)} Roads near me</button>
        <label class="btn ghost" title="A GPX file from Byway, a GPS or another app">${icon("download", 18)} Import GPX<input type="file" id="gpx-file" accept=".gpx,application/gpx+xml" hidden></label>
        <button class="btn blue" data-lib="new">${icon("plus", 18)} New trip</button>
      </div>
    </header>
    <div class="lib-tools">
      <label class="lib-search">${icon("sparkle", 16)}<input id="lib-q" type="search" placeholder="Search trips, roads, towns" value="${esc(libState.q)}" aria-label="Search trips"></label>
      <div class="rc-tabs" role="tablist">
        ${[["all", "All"], ["mine", "Yours"], ["ready", "Ready-made"]].map(([k, l]) => `<button role="tab" class="${libState.show === k ? "on" : ""}" aria-selected="${libState.show === k}" data-lib="show" data-v="${k}">${l}</button>`).join("")}
      </div>
      <select id="lib-sort" aria-label="Sort">
        ${[["recent", "Recently edited"], ...(nearState.home ? [["near", `Nearest to ${shortName(nearState.home.name)}`]] : []), ["name", "Name"], ["days", "Fewest days"], ["short", "Least driving"], ["long", "Most driving"]].map(([k, l]) => `<option value="${k}" ${libState.sort === k ? "selected" : ""}>${esc(l)}</option>`).join("")}
      </select>
    </div>
    <div class="lib-chips">${chips("region", REGIONS, libState.region)}</div>
    <div class="lib-chips">${chips("length", LENGTHS, libState.length)}</div>
    ${showMine ? `<section class="lib-sec"><h2>Yours <small>${mine.length}</small></h2>
      ${mine.length ? `<div class="lib-grid">${mine.map(libCard).join("")}</div>`
        : `<p class="fine">${libState.mine.length ? "None of yours match." : "Nothing yet. Plan one from Home, or start from a ready-made trip below."}</p>`}</section>` : ""}
    ${showReady ? `<section class="lib-sec"><h2>Ready-made <small>${ready.length}</small></h2>
      ${ready.length ? `<div class="lib-grid">${ready.map(libCard).join("")}</div>` : `<p class="fine">No ready-made trips match.</p>`}</section>` : ""}
  </div>`;
}

// The preview of one trip: photos, numbers, the route by day, every day and the roads, and what you can do with it.
function libPreviewHtml(t) {
  const fmtDay = (d) => `${d.secs ? fmtShort(d.secs) : ""}${d.meters ? ` · ${libDist(t, d.meters)}` : ""}`;
  const stat = (v, l) => (v ? `<div><b>${v}</b><small>${l}</small></div>` : "");
  return `<button class="icon-btn lib-close" data-lib="close" aria-label="Close">${icon("close", 20)}</button>
    <div class="lib-photos">${(t.images?.length ? t.images : [t.image]).filter(Boolean).slice(0, 3).map((src) => `<img src="${esc(src)}" alt="" loading="lazy" onerror="this.remove()">`).join("") || `<div class="lib-ph"></div>`}</div>
    <div class="lib-pv-body">
      <small class="lib-region">${t.preset ? "Ready-made trip" : `Your trip · edited ${esc(fmtWhen(t.updatedAt))}`}${regionName(t) ? ` · ${esc(regionName(t))}` : ""}</small>
      <h2>${esc(t.name)}</h2>
      ${t.prompt ? `<p class="lib-prompt">“${esc(t.prompt)}”</p>` : ""}
      ${t.summary ? `<p>${esc(t.summary)}</p>` : ""}
      <div class="lib-stats">
        ${stat(`${t.days}`, t.days === 1 ? "day" : "days")}
        ${stat(libDist(t, t.distance_m), "distance")}
        ${stat(t.duration_s ? fmtShort(t.duration_s) : "", "driving")}
        ${stat(t.longest_s ? fmtShort(t.longest_s) : "", "longest day")}
        ${stat(t.roads?.length ? `${t.roads.length}` : "", "featured roads")}
        ${stat(t.spots ? `${t.spots}` : "", "stops to see")}
      </div>
      <div class="lib-actions">
        ${t.preset
          ? `<button class="btn blue" data-lib="use" data-id="${esc(t.id)}">${icon("route", 18)} Use this trip</button>`
          : `<button class="btn blue" data-lib="go" data-id="${esc(t.id)}">${icon("route", 18)} Open</button>
             <button class="btn ghost" data-lib="copy" data-id="${esc(t.id)}">Make a copy</button>
             <button class="btn ghost danger" data-lib="delete" data-id="${esc(t.id)}">Delete</button>`}
      </div>
      ${sketchSvg(t) ? `<div class="lib-bigsketch">${sketchSvg(t, 320, 200, 4)}
        <p class="fine">${esc(libTown(t.start?.name))}${t.end && libTown(t.end.name) !== libTown(t.start?.name) ? ` to ${esc(libTown(t.end.name))}` : " loop"}</p></div>` : ""}
      ${t.dayList?.length ? `<h3>Day by day</h3><ol class="lib-days">${t.dayList.map((d, i) => `<li>
          <span class="lib-dot" style="background:${SKETCH_COLORS[i % SKETCH_COLORS.length]}">${d.day}</span>
          <div><b>${esc(d.title || `Day ${d.day}`)}</b><small>Night in ${esc(libTown(d.overnight))}${fmtDay(d) ? ` · ${fmtDay(d)}` : ""}</small></div></li>`).join("")}</ol>` : ""}
      ${t.roads?.length ? `<h3>Featured roads</h3><ul class="lib-roadlist">${t.roads.map((r) => `<li>${shield(r.ref, r.name)}<span>${esc(r.name)}${r.official ? ` <em>${esc(r.official)}</em>` : ""}</span></li>`).join("")}</ul>` : ""}
      <p class="fine lib-keys">Use ← and → to look through the trips.</p>
    </div>`;
}

function libVisible() {
  return [...(libState.show !== "ready" ? libFiltered(libState.mine || []) : []), ...(libState.show !== "mine" ? libFiltered(libState.ready || []) : [])];
}
function renderLibrary() {
  const el = $("library");
  if (!el || document.body.dataset.view !== "trips") return;
  const q = document.activeElement?.id === "lib-q";
  const pos = q ? document.activeElement.selectionStart : 0;
  el.querySelector(".lib-main").innerHTML = libraryHtml();
  if (q) {
    const i = $("lib-q");
    i.focus();
    i.setSelectionRange(pos, pos);
  }
  const t = libVisible().find((x) => x.id === libState.open) || [...(libState.mine || []), ...(libState.ready || [])].find((x) => x.id === libState.open);
  const pv = el.querySelector(".lib-preview");
  pv.hidden = !t;
  el.classList.toggle("previewing", !!t);
  if (t) pv.innerHTML = libPreviewHtml(t);
  el.querySelectorAll(".lib-card").forEach((c) => c.classList.toggle("on", c.dataset.id === libState.open));
  fitText(el);
}
function libOpen(id) {
  libState.open = id;
  renderLibrary();
  $("library").querySelector(".lib-preview").scrollTop = 0;
}

$("library").innerHTML = `<div class="lib-main"></div><aside class="lib-preview" hidden aria-label="Trip preview"></aside>`;
$("library").addEventListener("change", (e) => {
  if (e.target.id !== "gpx-file") return;
  const f = e.target.files?.[0];
  e.target.value = "";
  importGpx(f);
});
$("library").addEventListener("input", (e) => {
  if (e.target.id !== "lib-q") return;
  libState.q = e.target.value;
  renderLibrary();
});
$("library").addEventListener("change", (e) => {
  if (e.target.id !== "lib-sort") return;
  libState.sort = e.target.value;
  renderLibrary();
});
$("library").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-lib]");
  if (!b) return;
  const act = b.dataset.lib;
  const id = b.dataset.id;
  if (act === "open") libOpen(id);
  else if (act === "close") libOpen(null);
  else if (act === "show" || act === "region" || act === "length") {
    libState[act] = b.dataset.v;
    renderLibrary();
  } else if (act === "new") goHome();
  else if (act === "near") openNear();
  else if (act === "go") {
    await openTrip(id);
    setView("itinerary");
  } else if (act === "use") {
    await openPreset(id);
    setView("itinerary");
  } else if (act === "copy") {
    const d = await api(`/api/trips/${id}/duplicate`, {}).catch(() => null);
    await loadLibrary(true);
    if (d?.id) libOpen(d.id);
  } else if (act === "delete") {
    const t = libState.mine.find((x) => x.id === id);
    if (!confirm(`Delete "${t?.name || "this trip"}"? This can't be undone.`)) return;
    await fetch(`/api/trips/${id}`, { method: "DELETE" });
    if (id === trip.id) await newTrip();
    libState.open = null;
    await loadLibrary(true);
  }
});
addEventListener("keydown", (e) => {
  if (document.body.dataset.view !== "trips" || !libState.open || e.target.closest?.("input, select, textarea")) return;
  if (e.key === "Escape") return libOpen(null);
  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
  const list = libVisible();
  const i = list.findIndex((x) => x.id === libState.open);
  const next = list[(i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
  if (next) {
    e.preventDefault();
    libOpen(next.id);
    $("library").querySelector(`.lib-card[data-id="${CSS.escape(next.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }
});
// open the view: reload the lists each time (a trip may have been saved, copied or deleted since)
new MutationObserver(() => {
  if (document.body.dataset.view !== "trips") return;
  loadLibrary(true);
  renderLibrary();
}).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
