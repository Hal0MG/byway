// Setup screen: everything the app needs, filled in from the app (no editing .env by hand).
// Opens by itself the first time (no routing key yet) and from the gear button in the top bar. Each key is checked
// with its service before it's saved. The local AI part can start LM Studio, download the model and load it.

const setupState = { info: null, busy: "", msgs: {}, poll: 0, provider: null };

async function loadSetup() {
  try {
    const r = await fetch("/api/setup");
    if (!r.ok) return null; // not on this PC (a share link from another device)
    setupState.info = await r.json();
  } catch {
    setupState.info = null;
  }
  return setupState.info;
}

const tick = (ok) => `<span class="su-tick ${ok ? "ok" : ""}">${icon(ok ? "check" : "alert", 14)}</span>`;
function keyField(id, label, info, placeholder, link, linkText) {
  const msg = setupState.msgs[id];
  return `<label class="su-field"><span>${label}</span>
    <span class="su-row"><input id="su-${id}" type="password" autocomplete="off" spellcheck="false"
      placeholder="${info?.set ? `Saved (${esc(info.hint)}). Paste a new key to replace it` : esc(placeholder)}">
    <a class="btn ghost small" href="${link}" target="_blank" rel="noopener">${esc(linkText)} ${icon("external", 12)}</a></span>
    ${msg ? `<small class="${msg.ok ? "su-ok" : "su-bad"}">${esc(msg.text)}</small>` : ""}</label>`;
}

// Sound and language: per device, so they're here on every device (keys only on the computer running the app).
function prefsHtml() {
  const p = soundPrefs;
  const vol = (key, on, label) => `<input type="range" min="0" max="1" step="0.05" value="${p[key]}" data-pref="${key}" aria-label="${label}" ${on ? "" : "disabled"}>`;
  return `<section class="su-step su-prefs">
      <h3>${icon("sound", 16)} Sound and language</h3>
      <div class="su-pref">
        <label class="su-switch"><input type="checkbox" data-pref="fx" ${p.fx ? "checked" : ""}><span>Interface sounds</span></label>
        ${vol("fxVol", p.fx, "Interface sound volume")}
      </div>
      <div class="su-pref">
        <label class="su-switch"><input type="checkbox" data-pref="music" ${p.music ? "checked" : ""}><span>Music on the globe</span></label>
        ${vol("musicVol", p.music, "Music volume")}
      </div>
      <div class="su-pref su-langs" role="radiogroup" aria-label="Language">
        ${LANGS.map((l) => `<button role="radio" aria-checked="${l.code === LANG}" class="${l.code === LANG ? "on" : ""}" data-su="lang" data-v="${l.code}" data-no-i18n>
          <span class="flag">${FLAGS[l.code]}</span>${esc(l.name)}</button>`).join("")}
      </div>
      <button class="btn ghost small" data-su="welcome">${icon("sparkle", 14)} Show the welcome screen again</button>
    </section>`;
}
function prefInput(e) {
  const el = e.target.closest("[data-pref]");
  if (!el) return;
  const k = el.dataset.pref;
  setSoundPrefs({ [k]: el.type === "checkbox" ? el.checked : Number(el.value) });
  if (k === "fx" || k === "music") {
    el.closest(".su-pref").querySelector("input[type=range]").disabled = !el.checked;
    if (k === "fx" && el.checked) sfx("toggle");
  }
  // a quick sample so the new level can be heard
  if (k === "fxVol" && e.type === "change") sfx("click");
}

function setupHtml() {
  const s = setupState.info;
  if (!s) return `${sheetHead("Settings")}${prefsHtml()}<p class="fine">Keys and the AI planner are set up on the computer that runs the app.</p>`;
  return `${sheetHead("Setup")}
    <p class="su-lede">Everything here is free and optional. Keys stay on this computer, in the app's .env file.</p>
    ${prefsHtml()}

    <section class="su-step">
      <h3>${tick(s.gemini.set)} 1. The trip planner AI <em>to plan new trips</em></h3>
      <p>Ready-made trips, the map and routes work without it. To plan new trips, Gemini is the planner: a free key in about two minutes, nothing to install. It plans in seconds, with a daily limit on free requests.</p>
      ${keyField("gemini", "Gemini key", s.gemini, "Paste your key", "https://aistudio.google.com/apikey", "Get a free key") + geminiToday(s.gemini)}
    </section>

    <section class="su-step">
      <h3>${tick(s.ors.set)} 2. Routes and drive times <em>recommended</em></h3>
      <p>Without a key, routes come from OpenStreetMap's free backup router, with heights from Open-Meteo. With a free OpenRouteService key (no card) every drive also gets road surfaces and more exact times: sign up, open the dashboard, and copy your API key.</p>
      ${keyField("ors", "OpenRouteService key", s.ors, "Paste your key", "https://openrouteservice.org/dev/#/signup", "Get a free key")}
    </section>

    <section class="su-step">
      <h3>${tick(s.tavily.set)} 3. Web search while planning <em>optional</em></h3>
      <p>With Tavily the planner reads what drivers say on forums and travel sites, and road cards can sum it up (“What drivers say”). Free: 1,000 searches a month, about 100 trips. Without it, it plans from what it knows.</p>
      ${keyField("tavily", "Tavily key", s.tavily, "Paste your key (starts with tvly-)", "https://app.tavily.com/sign-in", "Get a free key")}
    </section>

    <section class="su-step">
      <h3>${tick(!!s.contact)} 4. Contact for Wikipedia <em>recommended</em></h3>
      <p>Wikipedia and OpenStreetMap ask apps to say who to contact, and slow down photo lookups for apps that don't. It's only sent to them, in each request's header.</p>
      <label class="su-field"><span>Your email or a web address</span>
        <input id="su-contact" type="text" autocomplete="email" value="${esc(s.contact)}" placeholder="you@example.com">
        ${setupState.msgs.contact ? `<small class="${setupState.msgs.contact.ok ? "su-ok" : "su-bad"}">${esc(setupState.msgs.contact.text)}</small>` : ""}</label>
    </section>

    <section class="su-step">
      <h3>${icon("pin", 16)} 5. On your phone <em>optional</em></h3>
      <p>Use the whole app on your phone while this ${s.platform === "darwin" ? "Mac" : "PC"} is on and the app is running, on the same Wi-Fi.
        Scan the code with the phone's camera. On an iPhone, Safari's Share button, then <b>Add to Home Screen</b>, makes it open like an app.
        Setup stays on this ${s.platform === "darwin" ? "Mac" : "PC"}.</p>
      <div id="su-phone">${phoneHtml()}</div>
    </section>

    <p class="fine su-legal">Byway ${esc(appVersion)} · <a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a> · <a href="terms.html" target="_blank" rel="noopener">Terms of use</a></p>

    <div class="sheet-actions su-actions">
      <span class="su-status">${s.ready ? `${icon("check", 16)} Ready to plan trips` : "Add a planner to plan new trips"}</span>
      <button class="btn ghost" data-su="check">${icon("refresh", 16)} Check again</button>
      <button class="btn blue" data-su="save" ${setupState.busy ? "disabled" : ""}>${setupState.busy ? `<span class="spinner"></span> ${esc(setupState.busy)}` : "Save"}</button>
    </div>`;
}

// The app's address on the local network, with a QR code (qrcode-generator, loaded when Setup opens).
let lanInfo = null;
function phoneHtml() {
  if (!lanInfo) return `<p class="fine">Looking up this computer's address...</p>`;
  if (!lanInfo.ips.length) return `<p class="fine">This computer isn't on a network right now.</p>`;
  const url = (ip) => `http://${ip}:${lanInfo.port}/`;
  const qr = (text) => {
    if (typeof qrcode !== "function") return "";
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  };
  return lanInfo.ips
    .map((ip) => `<div class="su-phone"><div class="su-qr">${qr(url(ip))}</div>
      <div><b>${esc(url(ip))}</b><small>${ip.startsWith("100.") ? "Tailscale: works anywhere your phone is on the same tailnet" : "Same Wi-Fi as this computer"}</small>
      <button class="btn ghost small" data-copy="${esc(url(ip))}">Copy</button></div></div>`)
    .join("");
}
async function loadPhone() {
  const lib = typeof qrcode === "function" ? null : new Promise((ok) => {
    const sc = document.createElement("script");
    sc.src = "https://unpkg.com/qrcode-generator@1.4.4/qrcode.js";
    sc.onload = sc.onerror = ok;
    document.head.appendChild(sc);
  });
  lanInfo = await fetch("/api/lan").then((r) => r.json()).catch(() => ({ ips: [], port: 3000 }));
  await lib;
  const box = setupEl?.querySelector("#su-phone");
  if (box) box.innerHTML = phoneHtml();
}

// Requests to Gemini today, per model, and any that reached their free daily limit.
function geminiToday(g) {
  const t = g?.today;
  if (!t) return "";
  const models = Object.entries(t.models || {});
  const total = models.reduce((n, [, c]) => n + c, 0);
  return `<p class="su-gpu">${icon("gauge", 14)} Today: ${total} request${total === 1 ? "" : "s"} to Gemini${models.length ? ` (${models.map(([m, c]) => `${esc(m)} ${c}`).join(", ")})` : ""}.
    The free limits reset at midnight Pacific time.</p>
    ${t.limited?.length ? `<p class="su-bad">Reached today's limit: ${esc(t.limited.join(", "))}. The app uses the next model until it resets.</p>` : ""}`;
}

let setupEl = null;
async function openSetup() {
  await loadSetup();
  setupState.msgs = {};
  setupState.provider = null;
  setupEl = openSheet(setupHtml(), "wide setup");
  setupEl.addEventListener("click", setupClick);
  setupEl.addEventListener("input", prefInput);
  setupEl.addEventListener("change", prefInput);
  pollSetup();
  loadPhone();
}
function redrawSetup() {
  if (!setupEl?.isConnected) return;
  // keep what's typed in the key boxes
  const typed = {};
  setupEl.querySelectorAll("input").forEach((i) => (typed[i.id] = i.value));
  setupEl.querySelector(".sheet").innerHTML = setupHtml();
  for (const [id, v] of Object.entries(typed)) if ($(id)) $(id).value = v;
}
// While a download or load runs, check every few seconds.
function pollSetup() {
  clearTimeout(setupState.poll);
  if (!setupEl?.isConnected) return;
  const job = setupState.info?.local?.job;
  if (job && !job.done) {
    setupState.poll = setTimeout(async () => {
      await loadSetup();
      redrawSetup();
      updateSetupBadge();
      pollSetup();
    }, 3000);
  }
}
async function setupClick(e) {
  const c = e.target.closest("[data-copy]");
  if (c) {
    navigator.clipboard?.writeText(c.dataset.copy).then(() => (c.textContent = "Copied"), () => {});
    return;
  }
  const b = e.target.closest("[data-su]");
  if (!b) return;
  const act = b.dataset.su;
  if (act === "lang") return setLang(b.dataset.v);
  if (act === "welcome") {
    closeOverlay(true);
    return openWelcome();
  }
  if (act === "provider") {
    setupState.provider = b.dataset.v;
    redrawSetup();
  } else if (act === "check") {
    await loadSetup();
    redrawSetup();
    updateSetupBadge();
  } else if (act.startsWith("lms-")) {
    b.disabled = true;
    delete setupState.msgs.lms;
    const r = await api("/api/setup/lms", { action: act.slice(4), device: b.dataset.v }).catch((err) => ({ error: err.message }));
    if (r.error) setupState.msgs.lms = { ok: false, text: r.error };
    // LM Studio's server takes a few seconds to answer after starting
    for (let i = 0; i < (act === "lms-start" ? 10 : 1); i++) {
      await loadSetup();
      if (act !== "lms-start" || setupState.info?.local.running) break;
      await sleep(1500);
    }
    redrawSetup();
    pollSetup();
  } else if (act === "save") {
    const val = (id) => $(`su-${id}`)?.value ?? null;
    const body = { ors: val("ors"), tavily: val("tavily"), gemini: val("gemini"), contact: val("contact") };
    if (setupState.provider) body.provider = setupState.provider;
    setupState.busy = "Checking the keys";
    redrawSetup();
    try {
      const r = await api("/api/setup", body);
      setupState.msgs = {};
      for (const k of ["ors", "tavily", "gemini", "contact"]) {
        if (r.problems?.[k]) setupState.msgs[k] = { ok: false, text: r.problems[k] };
      }
      const names = { ORS_API_KEY: "ors", TAVILY_API_KEY: "tavily", GEMINI_API_KEY: "gemini", CONTACT: "contact" };
      for (const k of r.saved || []) if (names[k]) setupState.msgs[names[k]] = { ok: true, text: "Saved." };
    } catch (err) {
      setupState.msgs.ors = { ok: false, text: err.message };
    }
    setupState.busy = "";
    setupState.provider = null;
    await loadSetup();
    redrawSetup();
    updateSetupBadge();
    // the planner's label ("Qwen3 on your GPU...") follows the chosen AI
    fetch("/api/status").then((r) => r.json()).then((s) => (aiInfo = s.ai)).catch(() => {});
  }
}

// The gear button gets a dot while something needed is missing.
function updateSetupBadge() {
  const b = $("setup-btn");
  if (b) b.classList.toggle("needs", !!setupState.info && !setupState.info.ready);
  // the home dock shows a "finish setting up" button while something's missing
  if (document.body.dataset.view === "home" && homeState.ready) renderHome();
}
$("setup-btn")?.addEventListener("click", openSetup);
// Setup no longer opens by itself: the app works without keys, and the home screen offers to add a planner.
addEventListener("DOMContentLoaded", async () => {
  if (READONLY) return;
  const s = await loadSetup();
  if (!s) {
    // another device: no keys to set here, only sound and language
    $("setup-btn")?.setAttribute("aria-label", "Settings");
    $("setup-btn")?.setAttribute("title", "Settings");
    return;
  }
  updateSetupBadge();
});
