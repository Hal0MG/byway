// "How it works": a short, friendly tour of what the app does, for the view of the same name. It covers the idea and
// the main features, not every detail (Setup and the README have those). "In depth" swaps it for the technical version
// (about-deep.js): the pipeline, the algorithms and their numbers, the caches and how it's tested.

const ABOUT_STEPS = [
  ["sparkle", "Say where you want to go", "“Toronto to Vancouver in 7 days”, a loop through the parks, or one of the ready-made trips. Set your dates, how long you like to drive each day and the kind of roads you're after."],
  ["road", "The planner picks the roads", "An AI planner builds the route around roads worth driving: designated scenic byways and famous drives, chosen for this trip. The app then checks its work, so every day ends where it says and every featured road is really on the route."],
  ["gauge", "Every day is measured", "Real road routing measures each day's drive: hours, distance, climbs and curves, ferries and tolls. Long days are evened out by moving the overnights before anything else changes."],
  ["photo", "The guide fills in", "Each day gets a write-up, the stops worth pulling over for with photos, the weather, sunset, fuel and charger gaps, and places to stay and eat at the end of the day."],
  ["pin", "Take it on the road", "Send any day to Google Maps or Apple Maps for turn-by-turn, or open Today on your phone for what's next, the next fuel and when you'll arrive."],
];
const ABOUT_TILES = [
  ["mountain", "Scenic, not slow", "Beautiful roads where they're worth it, sensible highways in between. No back roads just to avoid a freeway."],
  ["refresh", "Change it in plain words", "“Skip Winnipeg”, “add a night in Banff”. The trip updates in seconds, and Undo is one tap away."],
  ["sparkle", "Ask your trip", "“Where should we eat in Moab?” Answers come from your own days, stops and places."],
  ["route", "Other versions", "See easier, more scenic or different takes side by side before you commit."],
  ["map", "Edit on the map", "Drag a stop, pull the route through a town, or long-press to add a place."],
  ["road", "Roads near home", "The great drives within a few hours of you, and weekend loops to plan in one tap."],
  ["phone", "Hand it to your phone", "Scan a day's code and it opens in Google Maps or Apple Maps, every scenic stretch included."],
  ["wallet", "What it costs", "Fuel or charging for each day and a range for each night, in your own units and currency."],
  ["globe", "Free to run", "Free data and free tiers, or an AI model on your own computer. No accounts, no ads."],
];

// Overview or in depth, remembered per browser
let aboutDepth = (() => {
  try {
    return localStorage.getItem("aboutDepth") === "deep";
  } catch {
    return false;
  }
})();
const aboutModeHtml = () => `<div class="ab-mode" role="group" aria-label="How much detail">
    <button data-about="simple" aria-pressed="${!aboutDepth}">Overview</button>
    <button data-about="deep" aria-pressed="${aboutDepth}">${icon("gauge", 15)} In depth</button>
  </div>`;

function aboutHtml() {
  return `<div class="ab">
    ${aboutModeHtml()}
    <section class="ab-hero">
      ${artSvg()}
      <div class="ab-hero-text">
        <p class="kicker">${icon("sparkle", 16)} How it works</p>
        <h1>Road trips built around <span class="ab-grad">the drive itself</span></h1>
        <p class="lede">Tell it where you're going. It finds the roads worth driving, measures every day, and hands each one to your phone.</p>
      </div>
    </section>

    <ol class="ab-steps">
      ${ABOUT_STEPS.map(([ico, title, text], i) => `<li class="ab-step ab-in">
        <span class="ab-num">${i + 1}</span>
        <div class="ab-step-body">${icon(ico, 22)}<h2>${esc(title)}</h2><p>${esc(text)}</p></div>
      </li>`).join("")}
    </ol>

    <h2 class="ab-h">What makes it different</h2>
    <div class="ab-tiles">
      ${ABOUT_TILES.map(([ico, title, text]) => `<div class="ab-tile ab-in">${icon(ico, 22)}<h3>${esc(title)}</h3><p>${esc(text)}</p></div>`).join("")}
    </div>

    <section class="ab-where ab-in">
      <h2 class="ab-h">Where it plans</h2>
      <p>The United States, Canada, Australia, New Zealand, the United Kingdom and Ireland, the Alps, Norway, Iceland, Spain and Portugal. Anywhere else, routing still works, but the planner has no list of scenic roads there yet.</p>
    </section>

    <section class="ab-credits ab-in">
      <p>Built on open data and free services: maps and places from OpenStreetMap, routes from OpenRouteService and OSRM, photos and articles from Wikipedia and Wikimedia Commons, weather and heights from Open-Meteo. Your trips and keys stay on your own computer.</p>
      <p class="ab-links"><a href="privacy.html" target="_blank" rel="noopener">Privacy policy</a> · <a href="terms.html" target="_blank" rel="noopener">Terms of use</a></p>
    </section>

    <div class="ab-cta">
      <button class="btn blue" data-about="plan">${icon("sparkle", 18)} Plan a trip</button>
      <button class="btn" data-about="deep">${icon("gauge", 18)} How it works, in depth</button>
    </div>
  </div>`;
}

let aboutObserver = null;
function renderAbout() {
  const el = $("about");
  if (!el) return;
  const mode = aboutDepth ? "deep" : "simple";
  if (el.dataset.mode !== mode) {
    el.innerHTML = aboutDepth ? aboutDeepHtml() : aboutHtml();
    el.dataset.mode = mode;
  }
  // sections fade up as they scroll into view (not with reduced motion: they're just there)
  if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) {
    el.querySelectorAll(".ab-in").forEach((x) => x.classList.add("shown"));
    return;
  }
  aboutObserver ||= new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) {
      e.target.classList.add("shown");
      aboutObserver.unobserve(e.target);
    }
  }, { root: el, threshold: 0.15 });
  el.querySelectorAll(".ab-in:not(.shown)").forEach((x) => aboutObserver.observe(x));
}
$("about")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-about]");
  if (!b) return;
  if (b.dataset.about === "plan") return setView("home");
  if (b.dataset.about === "simple" || b.dataset.about === "deep") {
    aboutDepth = b.dataset.about === "deep";
    try {
      localStorage.setItem("aboutDepth", aboutDepth ? "deep" : "simple");
    } catch {}
    renderAbout();
    $("about").scrollTop = 0;
    $("about").querySelector(`.ab-mode [data-about="${b.dataset.about}"]`)?.focus();
  }
});
// render when the view opens (app.js's setView calls onViewChange, which home.js owns, so watch the attribute)
new MutationObserver(() => document.body.dataset.view === "about" && renderAbout()).observe(document.body, { attributes: true, attributeFilter: ["data-view"] });
if (document.body.dataset.view === "about") renderAbout();
