// The welcome screen: the first time the app opens (like a new phone), a "hello" in many languages and a few short
// steps: language, light or dark, sound, the AI planner (only on the computer running the app) and a home base for
// Roads near me. Every step can be skipped; nothing here is needed to use the app. Setup can show it again.

const HELLOS = ["Hello", "Bonjour", "你好", "হ্যালো", "Hola", "Ciao", "こんにちは", "Hallo", "Olá", "안녕하세요", "Merhaba", "Namaste"];
const welcomeState = { step: 0, steps: [], hello: 0, timer: 0, setup: null, msg: "", busy: false, langAtStart: LANG };

function welcomeSteps() {
  return ["hello", "lang", "look", "sound", ...(welcomeState.setup ? ["planner"] : []), "home", "done"];
}

function welcomeHtml() {
  const st = welcomeState;
  const step = st.steps[st.step];
  const dots = st.steps.slice(1, -1).map((_, i) => `<i class="${i + 1 === st.step ? "on" : i + 1 < st.step ? "past" : ""}"></i>`).join("");
  const nav = (next = t("Continue"), { skip = true } = {}) => `<div class="wl-nav">
      ${st.step > 1 ? `<button class="btn ghost" data-wl="back">${t("Back")}</button>` : "<span></span>"}
      <span class="wl-dots" aria-hidden="true">${dots}</span>
      <span class="wl-go">${skip ? `<button class="btn ghost" data-wl="pass">${t("Skip")}</button>` : ""}
        <button class="btn blue" data-wl="next" data-primary>${next}</button></span>
    </div>`;
  const body = {
    hello: () => `<div class="wl-hello">
        <h1 class="wl-word" aria-live="off">${HELLOS[st.hello % HELLOS.length]}</h1>
        <p class="wl-sub">${t("Road trips built around the drive itself.")}</p>
        <button class="btn blue wl-start" data-wl="next" data-primary>${t("Get started")} ${icon("chevron", 16)}</button>
      </div>`,
    lang: () => `<h2>${icon("language", 26)} ${t("Choose your language")}</h2>
      <p class="wl-sub">${t("Trip plans and guides are written in it too. Place and road names stay as maps know them.")}</p>
      <div class="wl-options" role="radiogroup" aria-label="Language">
        ${LANGS.map((l) => `<button role="radio" aria-checked="${l.code === LANG}" class="wl-option ${l.code === LANG ? "on" : ""}" data-wl="lang" data-v="${l.code}">
          <span class="flag big">${FLAGS[l.code]}</span><b>${esc(l.name)}</b></button>`).join("")}
      </div>
      ${nav(undefined, { skip: false })}`,
    look: () => `<h2>${icon(theme === "dark" ? "moon" : "sun", 26)} ${t("Light or dark?")}</h2>
      <p class="wl-sub">${t("You can switch any time with the button in the top bar.")}</p>
      <div class="wl-options two" role="radiogroup" aria-label="Appearance">
        ${["light", "dark"].map((m) => `<button role="radio" aria-checked="${theme === m}" class="wl-option wl-look ${theme === m ? "on" : ""}" data-wl="look" data-v="${m}">
          <span class="wl-preview ${m}"><i></i><i></i><i></i></span><b>${m === "light" ? t("Light") : t("Dark")}</b></button>`).join("")}
      </div>
      ${nav(undefined, { skip: false })}`,
    sound: () => `<h2>${icon("sound", 26)} ${t("Sound")}</h2>
      <p class="wl-sub">${t("Soft sounds when you point at and press things, and calm music on the globe. Change them later in Settings.")}</p>
      <div class="wl-options two">
        <button role="switch" aria-checked="${soundPrefs.fx}" class="wl-option ${soundPrefs.fx ? "on" : ""}" data-wl="snd" data-v="fx">
          ${icon("sound", 28)}<b>${t("Interface sounds")}</b><small>${soundPrefs.fx ? t("On") : t("Off")}</small></button>
        <button role="switch" aria-checked="${soundPrefs.music}" class="wl-option ${soundPrefs.music ? "on" : ""}" data-wl="snd" data-v="music">
          ${icon("music", 28)}<b>${t("Music on the globe")}</b><small>${soundPrefs.music ? t("On") : t("Off")}</small></button>
      </div>
      ${nav(undefined, { skip: false })}`,
    planner: () => {
      const s = st.setup;
      const ready = s.ready;
      return `<h2>${icon("sparkle", 26)} ${t("Plan your own trips")}</h2>
        <p class="wl-sub">${t("The 35 ready-made trips, the map and routes work without this. To plan new trips, the app needs an AI planner.")}</p>
        ${ready
          ? `<p class="wl-ok">${icon("check", 18)} ${t("A planner is set up. You're ready to plan trips.")}</p>`
          : `<div class="wl-card">
              <b>${t("Google Gemini, free")}</b>
              <p>${t("Get a free key in about two minutes (a Google account, no card), then paste it here.")}</p>
              <div class="wl-row">
                <input id="wl-key" type="password" autocomplete="off" spellcheck="false" placeholder="${t("Paste your Gemini key")}" aria-label="${t("Gemini key")}">
                <a class="btn ghost" href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">${t("Get a free key")} ${icon("external", 12)}</a>
              </div>
              ${st.msg ? `<p class="${st.msg.ok ? "wl-ok" : "wl-bad"}">${esc(st.msg.text)}</p>` : ""}
            </div>
            <p class="fine">${t("Prefer a model on this computer (free, private, needs a good graphics card)? Set it up later in Setup with LM Studio.")}</p>`}
        ${ready ? nav(undefined, { skip: false }) : nav(st.busy ? `<span class="spinner"></span> ${t("Checking")}` : t("Save the key"))}`;
    },
    home: () => `<h2>${icon("pin", 26)} ${t("Where do you start from?")}</h2>
      <p class="wl-sub">${t("Your home town, for Roads near me: the great drives within a few hours, and weekend loops.")}</p>
      <form class="wl-row" id="wl-home-form">
        <input id="wl-home" type="text" autocomplete="address-level2" placeholder="${t("A town or city")}" aria-label="${t("Home town")}" value="${esc(nearHomeName())}">
      </form>
      ${st.msg ? `<p class="${st.msg.ok ? "wl-ok" : "wl-bad"}">${esc(st.msg.text)}</p>` : ""}
      ${nav(st.busy ? `<span class="spinner"></span> ${t("Looking it up")}` : t("Continue"))}`,
    done: () => `<div class="wl-hello">
        <h1 class="wl-done">${icon("check", 40)}</h1>
        <h2>${t("You're all set")}</h2>
        <p class="wl-sub">${t("Spin the globe and pick a trip, or tell the planner where you want to go.")}</p>
        <button class="btn blue wl-start" data-wl="finish" data-primary>${t("Start exploring")}</button>
      </div>`,
  }[step]();
  return `<div class="wl-sky" aria-hidden="true"><i></i><i></i><i></i></div>
    ${step !== "done" ? `<button class="wl-skip link-btn" data-wl="skip">${t("Skip setup")}</button>` : ""}
    <section class="wl-step wl-${step}">${body}</section>`;
}
function nearHomeName() {
  try {
    return JSON.parse(localStorage.getItem("homeBase") || "null")?.name || "";
  } catch {
    return "";
  }
}

let welcomeEl = null;
function renderWelcome() {
  if (!welcomeEl) return;
  welcomeEl.innerHTML = welcomeHtml();
  (welcomeEl.querySelector("input") || welcomeEl.querySelector("[data-primary]"))?.focus({ preventScroll: true });
}
async function openWelcome() {
  if (welcomeEl) return;
  welcomeState.step = 0;
  welcomeState.msg = "";
  welcomeState.langAtStart = LANG;
  welcomeState.setup = null;
  welcomeState.steps = welcomeSteps();
  // whether this computer runs the app (the planner step) is known a moment later
  if (typeof loadSetup === "function") {
    loadSetup().then((s) => {
      welcomeState.setup = s;
      const at = welcomeState.steps[welcomeState.step];
      welcomeState.steps = welcomeSteps();
      welcomeState.step = welcomeState.steps.indexOf(at);
      if (at !== "hello") renderWelcome();
    }).catch(() => {});
  }
  welcomeEl = document.createElement("div");
  welcomeEl.id = "welcome";
  welcomeEl.className = "welcome";
  welcomeEl.setAttribute("role", "dialog");
  welcomeEl.setAttribute("aria-modal", "true");
  welcomeEl.setAttribute("aria-label", "Welcome to Byway");
  welcomeEl.setAttribute("data-no-i18n", ""); // its text comes from t() as it renders
  document.body.appendChild(welcomeEl);
  welcomeEl.addEventListener("click", welcomeClick);
  welcomeEl.addEventListener("submit", (e) => {
    e.preventDefault();
    welcomeNext();
  });
  renderWelcome();
  // "hello" in one language after another until Get started
  clearInterval(welcomeState.timer);
  welcomeState.timer = setInterval(() => {
    const w = welcomeEl?.querySelector(".wl-word");
    if (!w) return;
    w.classList.add("out");
    setTimeout(() => {
      welcomeState.hello++;
      w.textContent = HELLOS[welcomeState.hello % HELLOS.length];
      w.classList.remove("out");
    }, 450);
  }, 2200);
  musicWanted();
}
function closeWelcome() {
  clearInterval(welcomeState.timer);
  try {
    localStorage.setItem("welcomed", "1");
  } catch {}
  welcomeEl?.classList.add("leaving");
  const el = welcomeEl;
  welcomeEl = null;
  setTimeout(() => {
    el?.remove();
    musicWanted();
    // a new language: everything else is drawn again in it
    if (LANG !== welcomeState.langAtStart) setLang(LANG, true);
  }, 450);
}
function go(step) {
  welcomeState.step = Math.max(0, Math.min(welcomeState.steps.length - 1, step));
  welcomeState.msg = "";
  renderWelcome();
}
async function welcomeNext() {
  const st = welcomeState;
  const step = st.steps[st.step];
  // the steps that save something do it on Continue (Skip moves on without it)
  if (step === "planner" && !st.setup.ready) {
    const key = $("wl-key")?.value.trim();
    if (key) {
      st.busy = true;
      renderWelcome();
      try {
        const r = await api("/api/setup", { gemini: key, provider: "gemini" });
        if (r.problems?.gemini) throw new Error(r.problems.gemini);
        st.setup = (await loadSetup()) || st.setup;
        if (typeof updateSetupBadge === "function") updateSetupBadge();
        fetch("/api/status").then((x) => x.json()).then((x) => (aiInfo = x.ai)).catch(() => {});
        sfx("done");
      } catch (e) {
        st.busy = false;
        st.msg = { ok: false, text: e.message };
        sfx("error");
        return renderWelcome();
      }
      st.busy = false;
    }
  }
  if (step === "home") {
    const q = $("wl-home")?.value.trim();
    if (q && q !== nearHomeName()) {
      st.busy = true;
      renderWelcome();
      try {
        const p = await geocode(q);
        localStorage.setItem("homeBase", JSON.stringify({ name: q, at: [p.lng, p.lat] }));
        if (typeof nearState !== "undefined") nearState.home = { name: q, at: [p.lng, p.lat] };
      } catch {
        st.busy = false;
        st.msg = { ok: false, text: t("Couldn't find that place. Try a nearby city, or skip this step.") };
        sfx("error");
        return renderWelcome();
      }
      st.busy = false;
    }
  }
  go(st.step + 1);
}
function welcomeClick(e) {
  const b = e.target.closest("[data-wl]");
  if (!b) return;
  const st = welcomeState;
  const act = b.dataset.wl;
  if (act === "next") return welcomeNext();
  // Skip on a step that saves something moves on without saving
  if (act === "pass") return go(st.step + 1);
  if (act === "back") return go(st.step - 1);
  if (act === "skip" || act === "finish") return closeWelcome();
  if (act === "lang") {
    LANG = b.dataset.v;
    document.documentElement.lang = LANGS.find((l) => l.code === LANG).html;
    try {
      localStorage.setItem("lang", LANG);
    } catch {}
    return renderWelcome();
  }
  if (act === "look") {
    if (theme !== b.dataset.v) $("theme-btn").click();
    return renderWelcome();
  }
  if (act === "snd") {
    const k = b.dataset.v;
    setSoundPrefs({ [k]: !soundPrefs[k] });
    if (k === "fx" && soundPrefs.fx) sfx("toggle");
    return renderWelcome();
  }
}
addEventListener("keydown", (e) => {
  if (!welcomeEl || e.key !== "Enter" || e.target.closest("button, a")) return;
  if (e.target.matches("input")) return; // the forms handle their own Enter
  welcomeEl.querySelector("[data-primary]")?.click();
});

// First run: not for read-only share links, and not when a link opens a trip directly.
if (!READONLY && !new URLSearchParams(location.search).get("trip")) {
  let seen = null;
  try {
    seen = localStorage.getItem("welcomed");
  } catch {}
  if (!seen) addEventListener("DOMContentLoaded", openWelcome);
}
