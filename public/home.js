// Home screen: the map as a globe in space, with trip suggestions floating around it like windows. Whatever part of
// the globe faces you fills with the trips there: ready-made trips (open instantly), your own trips, and ideas
// (public/trip-ideas.json, planned with the AI when picked). Thin lines tie each window to its place on the globe.
// The globe turns slowly until you touch it. Loaded last; uses app.js (map, setView, planTrip, openTrip...).

const HOME = $("home");
const homeState = {
  ready: false, loading: false, ideas: [], presets: [], trips: [], images: {},
  cards: new Map(), // key -> { el, x, y, shown }
  detail: null, raf: 0, last: 0, lastTouch: 0, hoverPause: false,
};

// ---------- data ----------

async function loadHomeData() {
  if (homeState.loading) return;
  homeState.loading = true;
  const get = (u) => fetch(u).then((r) => r.json()).catch(() => ({}));
  const [ideas, presets, trips] = await Promise.all([get("/trip-ideas.json"), get("/api/presets"), get("/api/trips")]);
  homeState.ideas = ideas.ideas || [];
  homeState.presets = presets.presets || [];
  homeState.trips = trips.trips || [];
  homeState.ready = true;
  homeState.loading = false;
  renderHome();
  // card photos: the lead image of each idea's Wikipedia article (cached by the server)
  const titles = homeState.ideas.map((i) => i.wiki).filter((t) => t && !homeState.images[t]);
  if (titles.length) {
    api("/api/wiki-images", { titles })
      .then((d) => {
        Object.assign(homeState.images, d.images || {});
        for (const [key, c] of homeState.cards) {
          const it = homeItems().find((x) => x.key === key);
          if (it?.img && !c.el.querySelector("img")) c.el.querySelector(".hc-img").innerHTML = `<img src="${esc(it.img)}" alt="" loading="lazy">`;
        }
      })
      .catch(() => {});
  }
}
// Reload the lists next time home shows (a trip was saved, deleted, or made ready-made).
const refreshHome = () => {
  homeState.ready = false;
};

const KIND_LABEL = { ready: "Ready to go", mine: "Your trip", idea: "Trip idea" };
// Everything that can float around the globe: { key, kind, title, sub, img, at, ... }
function homeItems() {
  const items = [];
  const readyPrompts = new Set(homeState.presets.map((p) => p.prompt.trim().toLowerCase()));
  for (const p of homeState.presets) {
    if (!p.start) continue;
    items.push({
      key: `p:${p.id}`, kind: "ready", id: p.id, title: p.name, img: p.image, at: [p.start.lng, p.start.lat],
      sub: `${p.days} day${p.days === 1 ? "" : "s"}${p.duration_s ? ` · ${fmtShort(p.duration_s)} driving` : ""}`, text: p.summary, prompt: p.prompt,
    });
  }
  const seenNames = new Set();
  for (const t of homeState.trips) {
    // trips list is newest first; older trips with the same name are left out
    if (!t.start || !t.stopCount || seenNames.has(t.name)) continue;
    seenNames.add(t.name);
    items.push({
      key: `t:${t.id}`, kind: "mine", id: t.id, title: t.name, img: t.image, at: [t.start.lng, t.start.lat],
      sub: `${t.days} day${t.days === 1 ? "" : "s"} · edited ${fmtWhen(t.updatedAt)}`, text: t.summary || t.prompt, prompt: t.prompt,
    });
  }
  for (const [i, idea] of homeState.ideas.entries()) {
    if (readyPrompts.has(idea.prompt.trim().toLowerCase())) continue; // already a ready-made trip
    items.push({
      key: `i:${i}`, kind: "idea", title: idea.title, img: homeState.images[idea.wiki] || "", at: idea.at,
      sub: `${idea.days} day${idea.days === 1 ? "" : "s"}`, text: idea.blurb, prompt: idea.prompt, days: idea.days,
    });
  }
  return items;
}

// ---------- the screen ----------

const REGION_VIEWS = [
  ["United States", [-98, 39], 2.4], ["Canada", [-95, 54], 2.2], ["Australia", [140, -30], 2.4],
  ["New Zealand", [172, -41.5], 3.9], ["UK", [-3.5, 54.5], 4.2], ["The Alps", [9.5, 46.5], 4.6],
];
function renderHome() {
  if (document.body.dataset.view !== "home") return;
  if (!homeState.ready) {
    loadHomeData();
    if (!HOME.firstChild) HOME.innerHTML = `<div class="home-loading"><span class="spinner"></span></div>`;
    return;
  }
  const s = homeState;
  const current = stops.length ? trip : null;
  const lastId = store.get("lastTripId");
  const last = !current && lastId ? s.trips.find((t) => t.id === lastId) : null;
  HOME.innerHTML = `
    <div class="home-glow" aria-hidden="true"></div>
    <svg class="home-lines" aria-hidden="true"></svg>
    <div class="home-cards"></div>
    <div class="home-top">
      ${current || last ? `<button class="home-continue" data-home="continue">${icon("route", 16)} <span>Continue <b>${esc((current || last).name)}</b></span>${icon("chevron", 14)}</button>` : ""}
      <p class="home-legend"><span class="k-ready"></span>Ready to go <span class="k-mine"></span>Your trips <span class="k-idea"></span>Ideas, planned when you pick one</p>
    </div>
    <div class="home-detail" hidden></div>
    <div class="home-dock">
      <h1>Where to?</h1>
      ${typeof setupState !== "undefined" && setupState.info && !setupState.info.ready
        ? `<button class="home-setup" data-home="setup">${icon("sparkle", 16)} Open a ready-made trip, or add a free AI planner (about two minutes) to plan your own ${icon("chevron", 14)}</button>` : ""}
      <form class="home-ask" id="home-ask">
        <input id="home-prompt" type="text" autocomplete="off" placeholder="Describe a trip, or spin the globe and pick one" aria-label="Describe a trip">
        <button class="btn blue" type="submit">${icon("sparkle", 18)} Plan it</button>
      </form>
      <div class="home-actions">
        <button class="chip" data-home="plan">${icon("book", 14)} Plan with options</button>
        <button class="chip" data-home="map">${icon("map", 14)} Explore the map</button>
        <button class="chip" data-home="trips">${icon("list", 14)} Your trips (${s.trips.length})</button>
        <button class="chip ${satelliteOn ? "on" : ""}" data-home="sat" aria-pressed="${satelliteOn}">${icon("photo", 14)} Satellite</button>
        <span class="sep"></span>
        ${REGION_VIEWS.map(([n], i) => `<button class="chip region" data-home="region" data-i="${i}">${esc(n)}</button>`).join("")}
      </div>
    </div>`;
  s.cards.clear();
  startHomeLoop();
}

function cardHtml(it) {
  return `<span class="hc-img">${it.img ? `<img src="${esc(it.img)}" alt="" loading="lazy" onerror="this.remove()">` : ""}</span>
    <span class="hc-body"><span class="hc-kind k-${it.kind}">${esc(KIND_LABEL[it.kind])}</span><b>${esc(it.title)}</b><small>${esc(it.sub)}</small></span>`;
}

// ---------- geometry ----------

const RAD = Math.PI / 180;
function angDist(a, b) {
  const c = Math.sin(a[1] * RAD) * Math.sin(b[1] * RAD) + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.cos((a[0] - b[0]) * RAD);
  return Math.acos(Math.max(-1, Math.min(1, c))) / RAD;
}
// The globe's center and radius on screen: the projected distance to a point 89° from the center.
function globeOnScreen() {
  const c = map.getCenter();
  const p0 = map.project(c);
  const d = 89 * RAD;
  const f1 = c.lat * RAD;
  const f2 = Math.asin(Math.sin(f1) * Math.cos(d) + Math.cos(f1) * Math.sin(d));
  const l2 = c.lng * RAD + Math.atan2(0, Math.cos(d) - Math.sin(f1) * Math.sin(f2));
  const p1 = map.project([l2 / RAD, f2 / RAD]);
  return { x: p0.x, y: p0.y, r: Math.hypot(p1.x - p0.x, p1.y - p0.y) };
}

// ---------- the loop: turn the globe, choose and place the windows ----------

function startHomeLoop() {
  cancelAnimationFrame(homeState.raf);
  homeState.last = performance.now();
  const tick = (now) => {
    if (document.body.dataset.view !== "home") return;
    const dt = Math.min(100, now - homeState.last);
    homeState.last = now;
    // turn slowly while nobody is touching it
    if (!homeState.detail && !homeState.hoverPause && Date.now() - homeState.lastTouch > 6000 && map.getZoom() < 3.2 && !map.isMoving()) {
      const c = map.getCenter();
      map.setCenter([c.lng + dt * 0.003, c.lat]);
    }
    layoutHome();
    homeState.raf = requestAnimationFrame(tick);
  };
  homeState.raf = requestAnimationFrame(tick);
}
for (const ev of ["mousedown", "touchstart", "wheel"]) {
  map.getCanvas().addEventListener(ev, () => (homeState.lastTouch = Date.now()), { passive: true });
}

// The free space for the globe and the windows: under the top bar, above the dock.
function homeArea() {
  const W = innerWidth;
  const mobile = W < 760;
  return {
    W, mobile,
    top: mobile ? 72 : 84,
    bottom: innerHeight - (HOME.querySelector(".home-dock")?.offsetHeight || 150) - (mobile ? 18 : 26),
    cw: mobile ? 160 : 200,
    ch: mobile ? 138 : 164,
  };
}
// Center the globe in the free space and size it so the windows fit around it.
function frameGlobe(animate) {
  const a = homeArea();
  map.setPadding({ top: a.top, bottom: innerHeight - a.bottom, left: 0, right: 0 });
  const free = a.bottom - a.top;
  const want = a.mobile ? Math.min(a.W * 0.42, free * 0.42) : Math.min(a.W * 0.27, free * 0.36);
  const r = globeOnScreen().r;
  if (r > 1) {
    const zoom = Math.max(0, Math.min(3, map.getZoom() + Math.log2(want / r)));
    if (animate) map.easeTo({ zoom, duration: 900 });
    else map.setZoom(zoom);
  }
}
addEventListener("resize", () => document.body.dataset.view === "home" && frameGlobe(false));

function layoutHome() {
  const s = homeState;
  const box = HOME.querySelector(".home-cards");
  const svg = HOME.querySelector(".home-lines");
  if (!box || !svg) return;
  const { W, mobile, top, bottom, cw, ch } = homeArea();
  const g = globeOnScreen();
  const center = map.getCenter();
  // the whole globe fits with room around it: windows orbit it; otherwise they sit just above their places
  const orbit = !mobile && g.r < (bottom - top) * 0.47;
  const gap = 12;

  // what faces us: within 72° of the center and on screen
  const visible = homeItems()
    .map((it) => ({ it, d: angDist([center.lng, center.lat], it.at) }))
    .filter((x) => x.d < 72)
    .map((x) => ({ ...x, p: map.project(x.it.at) }))
    .filter((x) => x.p.x > 0 && x.p.x < W && x.p.y > top - 20 && x.p.y < bottom + 20);
  // windows already showing stay (no flicker); then ready-made trips, then the rest nearest the middle.
  // At most two of your own trips at a time, so the suggestions get room.
  const rank = { ready: 0, idea: 1, mine: 1 };
  visible.sort((a, b) => (s.cards.get(b.it.key)?.shown ? 1 : 0) - (s.cards.get(a.it.key)?.shown ? 1 : 0) || rank[a.it.kind] - rank[b.it.kind] || a.d - b.d);

  const placed = []; // { v, x, y, slot }
  const fits = (x, y) =>
    x - cw / 2 >= 10 && x + cw / 2 <= W - 10 && y - ch / 2 >= top && y + ch / 2 <= bottom &&
    placed.every((q) => Math.abs(q.x - x) >= cw + gap || Math.abs(q.y - y) >= ch + gap);
  let mine = 0;
  for (const v of visible) {
    if (placed.length >= (mobile ? 3 : 8)) break;
    if (v.it.kind === "mine" && mine >= 2) continue;
    if (placed.some((q) => Math.hypot(q.v.p.x - v.p.x, q.v.p.y - v.p.y) < 14)) continue; // same place: one window
    let spot = null;
    if (orbit) {
      // slots on a ring around the globe; take the free one nearest the place's own direction
      const own = Math.atan2(v.p.y - g.y, v.p.x - g.x);
      const prev = s.cards.get(v.it.key)?.slot;
      const tries = [];
      for (let k = 0; k < 36; k++) tries.push((k / 36) * Math.PI * 2);
      const diff = (a) => Math.abs(Math.atan2(Math.sin(a - own), Math.cos(a - own)));
      tries.sort((a, b) => diff(a) - diff(b));
      if (prev != null && diff(prev) < 0.7) tries.unshift(prev);
      for (const a of tries) {
        if (diff(a) > 1.4) break;
        const x = g.x + Math.cos(a) * (g.r + 26 + cw / 2);
        const y = g.y + Math.sin(a) * (g.r + 20 + ch / 2);
        if (fits(x, y)) {
          spot = { x, y, slot: a };
          break;
        }
      }
    } else {
      // just above the place, or below it, or to a side
      for (const [ox, oy] of [[0, -(ch / 2 + 30)], [0, ch / 2 + 30], [cw / 2 + 30, 0], [-(cw / 2 + 30), 0]]) {
        const x = Math.max(cw / 2 + 10, Math.min(W - cw / 2 - 10, v.p.x + ox));
        const y = v.p.y + oy;
        if (fits(x, y)) {
          spot = { x, y, slot: null };
          break;
        }
      }
    }
    if (!spot) continue;
    if (v.it.kind === "mine") mine++;
    placed.push({ v, ...spot });
  }
  const targets = placed;

  // move the windows (eased, so they drift rather than jump) and draw their tethers
  const keys = new Set(targets.map((t) => t.v.it.key));
  for (const [key, c] of s.cards) {
    if (!keys.has(key) && c.shown) {
      c.shown = false;
      c.el.classList.remove("on");
      setTimeout(() => !c.shown && c.el.remove(), 400);
    }
  }
  let lines = "";
  for (const t of targets) {
    const it = t.v.it;
    let c = s.cards.get(it.key);
    if (!c || !c.el.isConnected) {
      const el = document.createElement("button");
      el.className = `home-card k-${it.kind}`;
      el.dataset.key = it.key;
      el.setAttribute("aria-label", `${KIND_LABEL[it.kind]}: ${it.title}, ${it.sub}`);
      el.style.animationDelay = `${-Math.random() * 6}s`;
      el.innerHTML = cardHtml(it);
      box.appendChild(el);
      c = { el, x: t.x, y: t.y, shown: false };
      s.cards.set(it.key, c);
      requestAnimationFrame(() => el.classList.add("on"));
    }
    c.shown = true;
    c.slot = t.slot;
    c.x += (t.x - c.x) * 0.18;
    c.y += (t.y - c.y) * 0.18;
    c.el.style.transform = `translate(${(c.x - cw / 2).toFixed(1)}px, ${(c.y - ch / 2).toFixed(1)}px)`;
    // the tether: from the place to the nearest point on the window's edge
    const ex = Math.max(c.x - cw / 2, Math.min(c.x + cw / 2, t.v.p.x));
    const ey = Math.max(c.y - ch / 2, Math.min(c.y + ch / 2, t.v.p.y));
    lines += `<line x1="${t.v.p.x.toFixed(1)}" y1="${t.v.p.y.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" class="k-${it.kind}"/>
      <circle cx="${t.v.p.x.toFixed(1)}" cy="${t.v.p.y.toFixed(1)}" r="4" class="k-${it.kind}"/>`;
  }
  svg.innerHTML = lines;
  const glow = HOME.querySelector(".home-glow");
  if (glow) {
    const d = g.r * 2 + 120;
    glow.style.cssText = `width:${d}px;height:${d}px;transform:translate(${g.x - d / 2}px, ${g.y - d / 2}px);opacity:${orbit ? 1 : 0}`;
  }
}

// ---------- picking a trip ----------

function showDetail(key) {
  const it = homeItems().find((x) => x.key === key);
  const box = HOME.querySelector(".home-detail");
  if (!it || !box) return;
  homeState.detail = key;
  const actions = {
    ready: `<button class="btn blue" data-home="open-ready" data-id="${esc(it.id)}">${icon("route", 18)} Open this trip</button>`,
    mine: `<button class="btn blue" data-home="open-mine" data-id="${esc(it.id)}">${icon("route", 18)} Open</button>`,
    idea: `<button class="btn blue" data-home="plan-idea" data-key="${esc(key)}">${icon("sparkle", 18)} Plan this trip</button>
      <button class="btn ghost" data-home="idea-options" data-key="${esc(key)}">Set dates and options first</button>`,
  }[it.kind];
  box.innerHTML = `<button class="icon-btn hd-close" data-home="close" aria-label="Close">${icon("close", 18)}</button>
    <div class="hd-img">${it.img ? `<img src="${esc(it.img)}" alt="" onerror="this.remove()">` : ""}</div>
    <div class="hd-body">
      <span class="hc-kind k-${it.kind}">${esc(KIND_LABEL[it.kind])}</span>
      <h2>${esc(it.title)}</h2>
      <p class="hd-sub">${esc(it.sub)}</p>
      <div class="hd-actions">${actions}</div>
      ${it.text ? `<p class="hd-text">${esc(it.text)}</p>` : ""}
      ${it.kind === "idea" ? `<p class="fine">“${esc(it.prompt)}”. Planning takes a few minutes on your GPU.</p>` : ""}
      ${it.kind === "ready" ? `<p class="fine">Opens as your own copy, so you can change it.</p>` : ""}
    </div>`;
  box.hidden = false;
  // bring its place to the middle of the globe
  homeState.lastTouch = Date.now();
  map.easeTo({ center: it.at, duration: 1200, zoom: Math.max(map.getZoom(), 2.2) });
}
function closeDetail() {
  homeState.detail = null;
  const box = HOME.querySelector(".home-detail");
  if (box) box.hidden = true;
}

HOME.addEventListener("click", async (e) => {
  const card = e.target.closest(".home-card");
  if (card) return showDetail(card.dataset.key);
  const b = e.target.closest("[data-home]");
  if (!b) return;
  const act = b.dataset.home;
  const settings = () => ({ ...DEFAULT_SETTINGS, ...rememberedSettings() });
  if (act === "close") closeDetail();
  else if (act === "setup") openSetup();
  else if (act === "continue") {
    if (!stops.length && store.get("lastTripId")) await openTrip(store.get("lastTripId")).catch(() => {});
    setView("itinerary");
  } else if (act === "plan") setView("itinerary");
  else if (act === "map") setView("map");
  else if (act === "trips") $("trips-btn").click();
  else if (act === "sat") {
    setSatellite(!satelliteOn);
    b.classList.toggle("on", satelliteOn);
    b.setAttribute("aria-pressed", String(satelliteOn));
  }
  else if (act === "region") {
    const [, center, zoom] = REGION_VIEWS[Number(b.dataset.i)];
    homeState.lastTouch = Date.now();
    closeDetail();
    map.flyTo({ center, zoom, duration: 1800 });
  } else if (act === "open-ready") {
    closeDetail();
    await openPreset(b.dataset.id);
    refreshHome();
    setView("itinerary");
  } else if (act === "open-mine") {
    closeDetail();
    await openTrip(b.dataset.id).catch((err) => setStatus(err.message));
    setView("itinerary");
  } else if (act === "plan-idea" || act === "idea-options") {
    const it = homeItems().find((x) => x.key === b.dataset.key);
    if (!it) return;
    closeDetail();
    refreshHome();
    if (act === "plan-idea") planTrip(it.prompt, settings());
    else {
      // the planning page with this trip's description filled in, to add dates and options before planning
      await newTrip();
      trip.prompt = it.prompt;
      setView("itinerary");
      renderItinerary();
    }
  }
});
HOME.addEventListener("submit", (e) => {
  if (e.target.id !== "home-ask") return;
  e.preventDefault();
  const p = $("home-prompt").value.trim();
  if (!p) return $("home-prompt").focus();
  refreshHome();
  planTrip(p, { ...DEFAULT_SETTINGS, ...rememberedSettings() });
});
// hovering a window pauses the turning, so it doesn't drift away from the pointer
HOME.addEventListener("pointerover", (e) => (homeState.hoverPause = !!e.target.closest(".home-card, .home-detail, .home-dock")));
HOME.addEventListener("pointerleave", () => (homeState.hoverPause = false));
addEventListener("keydown", (e) => e.key === "Escape" && homeState.detail && closeDetail());

// ---------- entering and leaving home ----------

// Called by setView (app.js). Home shows the globe; the other views use the flat map.
let homeCamera = { center: [-98, 30], zoom: 1.5 };
function onViewChange(v, prev) {
  if (!styleReady) return;
  if (v === "home") {
    homeState.ready = false; // reload the lists: trips may have been saved, deleted or made ready-made since
    map.setProjection({ type: "globe" });
    setHomeLayers(false);
    const fit = Math.min(innerWidth, innerHeight);
    map.jumpTo({ center: homeCamera.center, zoom: fit < 700 ? 0.9 : homeCamera.zoom, pitch: 0, bearing: 0 });
    // once the dock is on screen, center the globe in the space above it
    requestAnimationFrame(() => requestAnimationFrame(() => frameGlobe(false)));
    if (typeof setTerrain === "function" && terrainOn) {
      terrainOn = false;
      applyTerrain();
    }
    renderHome();
  } else {
    if (prev === "home") {
      const c = map.getCenter();
      homeCamera = { center: [c.lng, c.lat], zoom: Math.min(map.getZoom(), 2.2) };
    }
    cancelAnimationFrame(homeState.raf);
    closeDetail();
    map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    map.setProjection({ type: "mercator" });
    setHomeLayers(true);
    if (prev === "home" && stops.length) fitStops();
  }
}
// The trip's own layers (route, coverage mask, fuel dots) are hidden on the globe.
function setHomeLayers(show) {
  const vis = show ? "visible" : "none";
  for (const id of ["coverage-mask", "route-scenic-casing", "route-scenic-line", "route-fastest-casing", "route-fastest-line", "day-hl", "along"]) {
    if (map.getLayer(id)) map.setLayoutProperty(id, "visibility", vis);
  }
}
map.on("style.load", () => onViewChange(document.body.dataset.view, null));

// A starfield behind the globe, drawn once.
(function stars() {
  const c = document.createElement("canvas");
  c.width = c.height = 900;
  const g = c.getContext("2d");
  for (let i = 0; i < 520; i++) {
    const r = Math.random() < 0.94 ? Math.random() * 0.9 + 0.2 : Math.random() * 1.5 + 0.8;
    g.globalAlpha = Math.random() * 0.7 + 0.15;
    g.fillStyle = Math.random() < 0.15 ? "#bfe6ff" : "#ffffff";
    g.beginPath();
    g.arc(Math.random() * 900, Math.random() * 900, r, 0, Math.PI * 2);
    g.fill();
  }
  document.documentElement.style.setProperty("--stars", `url(${c.toDataURL()})`);
})();
