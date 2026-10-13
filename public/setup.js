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

function setupHtml() {
  const s = setupState.info;
  if (!s) return `${sheetHead("Setup")}<p>Setup only works on the PC that runs the app.</p>`;
  const provider = setupState.provider || s.provider;
  const L = s.local;
  const job = L.job && !L.job.done ? L.job : null;
  const gpuText = s.gpu?.apple
    ? `${s.gpu.name}, ${s.gpu.gb} GB shared memory. ${s.gpu.gb >= 16 ? "Enough for the local model; planning takes a few times longer than on a desktop graphics card." : "That's tight for the local model (it uses about 7 GB); Gemini may suit this Mac better."}`
    : s.gpu?.name
      ? `${s.gpu.name}, ${s.gpu.gb} GB. ${s.gpu.gb >= 8 ? "Plenty for the local model." : "That's tight for the local model (it wants about 6 GB free); Gemini may suit this PC better."}`
      : "No NVIDIA graphics card found. The local model needs a good GPU (about 8 GB) or an Apple Silicon Mac; without one, use Gemini.";
  // LM Link: other computers on the same LM Studio account that can run the model instead
  const link = L.link;
  const here = s.platform === "darwin" ? "This Mac" : "This PC";
  const devName = (d) => (d.id === "local" ? here : d.name);
  const onName = link?.on ? devName(link.devices.find((d) => d.id === link.on) || { id: link.on, name: "another computer" }) : "";
  const localSteps = [
    [L.lms, "LM Studio installed", L.lms ? "" : `<a class="btn ghost small" href="https://lmstudio.ai/download" target="_blank" rel="noopener">Get LM Studio (free) ${icon("external", 12)}</a> <small>Install it and open it once, then press Check again.</small>`],
    [L.running, "LM Studio's server running", !L.lms || L.running ? "" : `<button class="btn ghost small" data-su="lms-start">Start it</button>`],
    [L.downloaded, `The planning model (${esc(L.model)}, about 6 GB)`, !L.running || L.downloaded ? "" : `<button class="btn ghost small" data-su="lms-download" ${job ? "disabled" : ""}>Download it</button>`],
    [L.loaded, link?.on && link.on !== "local" ? `Model loaded on ${esc(onName)}` : "Model loaded on the graphics card",
      !L.downloaded || L.loaded ? "" : `<button class="btn ghost small" data-su="lms-load" ${job ? "disabled" : ""}>Load it</button>`],
  ];
  return `${sheetHead("Setup")}
    <p class="su-lede">Everything here is free. Keys stay on this PC, in the app's .env file.</p>

    <section class="su-step">
      <h3>${tick(s.ors.set)} 1. Routes and drive times <em>needed</em></h3>
      <p>OpenRouteService measures every drive. Sign up for free (no card), open the dashboard, and copy your API key.</p>
      ${keyField("ors", "OpenRouteService key", s.ors, "Paste your key", "https://openrouteservice.org/dev/#/signup", "Get a free key")}
    </section>

    <section class="su-step">
      <h3>${tick(s.ready && s.ors.set ? true : provider === "gemini" ? s.gemini.set : L.loaded)} 2. The trip planner AI <em>needed</em></h3>
      <div class="su-choice" role="radiogroup">
        <button class="${provider === "local" ? "on" : ""}" data-su="provider" data-v="local" role="radio" aria-checked="${provider === "local"}">
          <b>On this ${s.platform === "darwin" ? "Mac" : "PC"}</b><small>Free and unlimited, private. Needs a good graphics card or an Apple Silicon Mac. Uses LM Studio.</small></button>
        <button class="${provider === "gemini" ? "on" : ""}" data-su="provider" data-v="gemini" role="radio" aria-checked="${provider === "gemini"}">
          <b>Google Gemini</b><small>Free key, no graphics card needed. Plans in seconds (Flash-Lite), with a daily limit on free requests.</small></button>
      </div>
      ${provider === "local"
        ? `<p class="su-gpu">${icon("gauge", 14)} ${esc(gpuText)}</p>
           <ul class="su-list">${localSteps.map(([ok, label, action]) => `<li>${tick(ok)}<span>${label}</span>${action}</li>`).join("")}</ul>
           ${link ? `<p class="su-sub">Run the model on</p>
             <div class="su-choice" role="radiogroup" aria-label="Where the model runs">
               ${link.devices.map((d) => {
                 const why = !d.connected ? "Not connected" : !d.has ? "Model not downloaded there" : link.on === d.id ? "Running the model now" : d.id === "local" ? "Uses this computer's chip" : "Over LM Link, uses that computer's GPU";
                 return `<button class="${link.on === d.id ? "on" : ""}" data-su="lms-use" data-v="${esc(d.id)}" role="radio" aria-checked="${link.on === d.id}"
                   ${!d.connected || !d.has || job || link.on === d.id ? "disabled" : ""}><b>${esc(devName(d))}</b><small>${why}</small></button>`;
               }).join("")}
             </div>` : ""}
           ${setupState.msgs.lms ? `<p class="su-bad">${esc(setupState.msgs.lms.text)}</p>` : ""}
           ${job ? `<p class="su-job"><span class="spinner"></span> ${job.action === "download" ? "Downloading the model. This can take a while; you can keep using the app." : "Loading the model..."}
             <small>${esc(job.out.split(/\r|\n/).filter(Boolean).pop() || "")}</small></p>` : ""}
           ${L.job?.done && !L.job.ok ? `<p class="su-bad">That didn't work: ${esc(L.job.out.split(/\r|\n/).filter(Boolean).slice(-2).join(" "))}</p>` : ""}
           ${L.loaded ? "" : `<p class="fine">After a restart of the PC, the model needs loading again: press "Load it" here, or run start-ai.cmd.</p>`}`
        : keyField("gemini", "Gemini key", s.gemini, "Paste your key", "https://aistudio.google.com/apikey", "Get a free key") + geminiToday(s.gemini)}
    </section>

    <section class="su-step">
      <h3>${tick(s.tavily.set)} 3. Web search while planning <em>optional</em></h3>
      <p>With Tavily the planner reads what drivers say on forums and travel sites. Free: 1,000 searches a month, about 100 trips. Without it, it plans from what it knows.</p>
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

    <p class="fine su-legal"><a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a> · <a href="terms.html" target="_blank" rel="noopener">Terms of use</a></p>

    <div class="sheet-actions su-actions">
      <span class="su-status">${s.ready ? `${icon("check", 16)} Ready to plan trips` : "Not ready yet"}</span>
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
// First run: no routing key yet, so open setup straight away.
addEventListener("DOMContentLoaded", async () => {
  if (READONLY) return;
  const s = await loadSetup();
  if (!s) {
    $("setup-btn")?.remove(); // another device: nothing to set up from here
    return;
  }
  updateSetupBadge();
  if (!s.ors.set || (s.provider === "gemini" && !s.gemini.set)) openSetup();
});
