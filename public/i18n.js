// Languages: English (the app's own text), French, Chinese (simplified) and Bangla.
// The app is written in English. In another language, a translator watches the page and swaps every piece of text
// (and placeholder, label and tooltip) found in the dictionary (i18n-strings.js) for its translation as screens
// render, so the screens' code doesn't change and text without a translation yet simply stays in English. What the AI
// writes (plans, day guides, answers) comes back in the chosen language. Place and road names never change: maps look
// them up by name.

const FLAGS = {
  // the United Kingdom
  en: `<svg viewBox="0 0 60 30" aria-hidden="true"><clipPath id="fl-uk"><path d="M0 0v30h60V0z"/></clipPath><clipPath id="fl-uk2"><path d="M30 15h30v15zv15H0zH0V0zV0h30z"/></clipPath><g clip-path="url(#fl-uk)"><path d="M0 0v30h60V0z" fill="#012169"/><path d="M0 0l60 30m0-30L0 30" stroke="#fff" stroke-width="6"/><path d="M0 0l60 30m0-30L0 30" clip-path="url(#fl-uk2)" stroke="#C8102E" stroke-width="4"/><path d="M30 0v30M0 15h60" stroke="#fff" stroke-width="10"/><path d="M30 0v30M0 15h60" stroke="#C8102E" stroke-width="6"/></g></svg>`,
  fr: `<svg viewBox="0 0 3 2" aria-hidden="true"><path fill="#002654" d="M0 0h1v2H0z"/><path fill="#fff" d="M1 0h1v2H1z"/><path fill="#CE1126" d="M2 0h1v2H2z"/></svg>`,
  zh: `<svg viewBox="0 0 30 20" aria-hidden="true"><path fill="#EE1C25" d="M0 0h30v20H0z"/><g fill="#FFFF00"><path d="M5 2l1.18 3.62H10L6.91 7.86 8.09 11.5 5 9.26 1.91 11.5 3.09 7.86 0 5.62h3.82z"/><circle cx="10" cy="2" r=".9"/><circle cx="12" cy="4" r=".9"/><circle cx="12" cy="7" r=".9"/><circle cx="10" cy="9" r=".9"/></g></svg>`,
  bn: `<svg viewBox="0 0 10 6" aria-hidden="true"><path fill="#006A4E" d="M0 0h10v6H0z"/><circle cx="4.5" cy="3" r="2" fill="#F42A41"/></svg>`,
};
const LANGS = [
  { code: "en", name: "English", html: "en" },
  { code: "fr", name: "Français", html: "fr" },
  { code: "zh", name: "简体中文", html: "zh-Hans" },
  { code: "bn", name: "বাংলা", html: "bn" },
];
// the language the AI is asked to write in
const AI_LANG = { fr: "French (français)", zh: "Simplified Chinese (简体中文)", bn: "Bangla (বাংলা)" };

let LANG = (() => {
  let saved = null;
  try {
    saved = localStorage.getItem("lang");
  } catch {}
  if (LANGS.some((l) => l.code === saved)) return saved;
  // first visit: the browser's language when we have it
  const nav = (navigator.languages || [navigator.language || "en"]).map((x) => String(x).slice(0, 2).toLowerCase());
  return nav.map((x) => LANGS.find((l) => l.code === x)?.code).find(Boolean) || "en";
})();
document.documentElement.lang = LANGS.find((l) => l.code === LANG).html;

const I18N = {}; // { fr: { "English text": "texte" }, ... } from i18n-strings.js
const I18N_PATTERNS = {}; // { fr: [[/^Day (\d+)$/, "Jour $1"], ...] } for text with numbers or names in it

// One string: its translation, or the English. {name} placeholders are filled from vars.
function t(s, vars) {
  let out = (LANG !== "en" && I18N[LANG]?.[s]) || s;
  if (vars) out = out.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
  return out;
}
function i18nLookup(s) {
  const dict = I18N[LANG];
  if (dict && Object.hasOwn(dict, s)) return dict[s];
  for (const [re, rep] of I18N_PATTERNS[LANG] || []) {
    if (re.test(s)) return s.replace(re, rep);
  }
  return null;
}

// force: reload even though LANG already is the code (the welcome screen switches its own text first)
function setLang(code, force = false) {
  if ((code === LANG && !force) || !LANGS.some((l) => l.code === code)) return;
  try {
    localStorage.setItem("lang", code);
  } catch {}
  // every screen is rendered again in the new language: simplest and sure is to reload (the trip is saved)
  if (typeof flushSave === "function") flushSave().finally(() => location.reload());
  else location.reload();
}

// ---------- the translator ----------
const I18N_ATTRS = ["placeholder", "aria-label", "title", "alt"];
const I18N_SKIP = "script, style, svg, textarea, input, .maplibregl-ctrl-attrib, [data-no-i18n], [contenteditable]";
function translateNode(root) {
  if (root.nodeType === Node.TEXT_NODE) return translateText(root);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  let fit = false;
  if (!root.closest(I18N_SKIP)) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest(I18N_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) fit = translateText(n) || fit;
  }
  // placeholders, labels and tooltips (inputs included)
  for (const el of [root, ...root.querySelectorAll(I18N_ATTRS.map((a) => `[${a}]`).join(","))]) {
    if (el.closest("svg, .maplibregl-ctrl-attrib, [data-no-i18n]")) continue;
    for (const a of I18N_ATTRS) {
      const v = el.getAttribute(a);
      const key = v && v.trim().replace(/\s+/g, " ");
      const tr = key && i18nLookup(key);
      // only a real change: setting the same value would be a new mutation, and so on forever
      if (tr && tr !== key && tr !== v && i18nOnce(el)) el.setAttribute(a, tr);
    }
  }
  // titles sized to fit were measured in English
  if (fit && typeof fitText === "function") fitText();
}
// how many times each text node and element was rewritten: a safety stop if two translations ever undo each other
const i18nTouched = new WeakMap();
const i18nOnce = (x) => {
  const k = (i18nTouched.get(x) || 0) + 1;
  i18nTouched.set(x, k);
  return k <= 20;
};
function translateText(n) {
  const raw = n.nodeValue;
  // the page's source wraps long sentences over lines: compare with single spaces
  const s = raw.trim().replace(/\s+/g, " ");
  if (!s || s.length > 600 || !/[A-Za-z]/.test(s)) return false;
  const tr = i18nLookup(s);
  if (tr == null || tr === s || !i18nOnce(n)) return false;
  n.nodeValue = raw.match(/^\s*/)[0] + tr + raw.match(/\s*$/)[0];
  return !!n.parentElement?.closest("[data-fit]");
}
if (LANG !== "en") {
  const start = () => {
    translateNode(document.body);
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === "characterData") translateText(m.target);
        else if (m.type === "attributes") translateNode(m.target);
        else for (const n of m.addedNodes) if (!(n instanceof SVGElement)) translateNode(n);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: I18N_ATTRS });
  };
  // after the page's scripts have built the first screens
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else setTimeout(start);
}

// ---------- the language menu (the flag next to the light/dark switch) ----------
function langMenuHtml() {
  return `<div class="lang-menu" role="menu" aria-label="Language">
    ${LANGS.map((l) => `<button role="menuitemradio" aria-checked="${l.code === LANG}" data-lang="${l.code}" data-no-i18n>
      <span class="flag">${FLAGS[l.code]}</span><span>${l.name}</span>${l.code === LANG ? icon("check", 14) : ""}</button>`).join("")}
  </div>`;
}
function setupLangButton() {
  const btn = document.getElementById("lang-btn");
  if (!btn) return;
  btn.innerHTML = `<span class="flag">${FLAGS[LANG]}</span>${icon("chevron", 12)}`;
  btn.onclick = (e) => {
    e.stopPropagation();
    const open = document.querySelector(".lang-menu");
    if (open) return closeLangMenu();
    btn.insertAdjacentHTML("afterend", langMenuHtml());
    btn.setAttribute("aria-expanded", "true");
    const menu = document.querySelector(".lang-menu");
    menu.querySelector('[aria-checked="true"]')?.focus();
    menu.onclick = (ev) => {
      const b = ev.target.closest("[data-lang]");
      if (b) setLang(b.dataset.lang);
    };
  };
  addEventListener("click", (e) => !e.target.closest(".lang-menu") && closeLangMenu());
  addEventListener("keydown", (e) => e.key === "Escape" && closeLangMenu());
}
function closeLangMenu() {
  document.querySelector(".lang-menu")?.remove();
  document.getElementById("lang-btn")?.setAttribute("aria-expanded", "false");
}
setupLangButton();
