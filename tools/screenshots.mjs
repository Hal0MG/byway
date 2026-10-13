// README screenshots: drives Chrome Headless Shell (its own throwaway profile) through the running app and saves PNGs.
// Setup once: npm install (puppeteer-core is a dev dependency), then
//   npx @puppeteer/browsers install chrome-headless-shell@stable --path .browsers
// Usage, with the app running on port 3000: CHROME_PATH=<that chrome-headless-shell> node tools/screenshots.mjs <out dir> [only,names]
// Then convert to JPEG for the README (docs/screenshots). It opens a copy of a ready-made trip and plans one trip;
// delete both afterwards (their ids are printed at the end). Today gets a set location and a mid-morning clock.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const OUT = process.argv[2];
const ONLY = process.argv[3] ? new Set(process.argv[3].split(",")) : null;
const APP = "http://localhost:3000";
const PRESET = "d88f17df-6c9a-4077-9dae-22fe8e2ccb14"; // Grand Teton, Yellowstone and the Beartooth Highway
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: "shell",
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "byway-shots-")),
  args: ["--no-first-run", "--hide-scrollbars"],
});
const ctx = browser.defaultBrowserContext();
await ctx.overridePermissions("http://localhost:3000", ["geolocation"]);
const page = await browser.newPage();
await page.setGeolocation({ latitude: 44.92, longitude: -110.42 });
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("welcomed", "1"); // no welcome screen over the shots
  // screenshots only: the page's clock reads 10:40 AM in Yellowstone (16:40 UTC) today
  const RealDate = Date;
  const target = new RealDate(); target.setUTCHours(16, 40, 0, 0);
  const shift = target.getTime() - RealDate.now();
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + shift); }
    static now() { return RealDate.now() + shift; }
  };
});
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
page.on("pageerror", (e) => console.log("page error:", e.message));
const shot = async (name, fn) => {
  if (ONLY && !ONLY.has(name)) return;
  try {
    await fn();
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log("saved", name);
  } catch (e) {
    console.log("failed", name, e.message);
  }
};
const js = (f, ...a) => page.evaluate(f, ...a);
const scrollTo = (sel, offset = 90) => js((s, o) => {
  const el = document.querySelector(s);
  const box = document.querySelector("#itinerary");
  if (el && box) box.scrollTo(0, el.getBoundingClientRect().top + box.scrollTop - o);
}, sel, offset);

await page.goto(APP, { waitUntil: "load" });
await js(() => localStorage.setItem("theme", "dark"));

await shot("home", async () => {
  await page.goto(APP, { waitUntil: "load" });
  await sleep(9000); // globe, cards and photos
});

// a working copy of the ready-made trip (deleted afterwards)
let copyId = null;
let planId = null;
const openTrip = async () => {
  await page.goto(APP, { waitUntil: "load" });
  await sleep(1500);
  copyId = await js(async (id) => {
    await openPreset(id);
    setView("itinerary");
    return trip.id;
  }, PRESET);
  await sleep(4000);
};
await openTrip();

await shot("trip", async () => {
  await js(() => document.querySelector("#itinerary").scrollTo(0, 0));
  await sleep(1500);
});
await shot("day", async () => {
  await scrollTo("#day-2");
  await sleep(1500);
});
await shot("timeline", async () => {
  await scrollTo("#day-2 h3");
  await sleep(1200);
});
await shot("roads", async () => {
  await scrollTo("#day-2 .road-cards");
  await sleep(1500);
});
await shot("map", async () => {
  await js(() => setView("map"));
  await sleep(500);
  await js(() => {
    fitStops();
    map.resize();
  });
  await sleep(5000);
});
await shot("today", async () => {
  await js(() => {
    setView("itinerary");
    todayState.day = 2;
    openToday();
    // as if riding near Tower Junction on day 2
  });
  await sleep(2500);
});
await shot("ask", async () => {
  await js(async () => {
    closeOverlay();
    getAskState().mode = "ask";
    trip.qa = [];
    await askTrip("Which day is the most demanding, and where should I take a long break?");
  });
  await scrollTo(".request-card", 100);
  await sleep(1200);
});
await shot("versions", async () => {
  await js(() => document.querySelector("#itinerary").scrollTo(0, 0));
  await js(() => {
    window.__alt = openAlternatives();
  });
  for (let i = 0; i < 90; i++) {
    await sleep(2000);
    if (await js(() => altState.items.every((x) => x.sum || x.error))) break;
  }
  await sleep(800);
});
await shot("about", async () => {
  await js(() => {
    closeOverlay();
    setView("about");
  });
  await sleep(2500);
});
// the Trips tab: ready-made trips only (your own stay out of the README), one open in the preview
await shot("trips", async () => {
  await js(async (id) => {
    closeOverlay();
    setView("trips");
    await loadLibrary(true);
    Object.assign(libState, { show: "ready", region: "US", q: "" });
    libOpen(id);
  }, PRESET);
  await sleep(5000); // card and preview photos
});
// Roads near me from Denver (the home base is set directly; the list is plain arithmetic, no service)
await shot("near", async () => {
  await js(async () => {
    closeOverlay();
    setView("home");
    nearState.home = { name: "Denver, Colorado", at: [-104.985, 39.739] };
    nearState.hours = 5;
    await openNear();
  });
  await sleep(3000); // road photos
});
await shot("planning", async () => {
  await js(() => {
    setView("home");
    window.__p = planTrip("Innsbruck to Lake Como over the Stelvio Pass and the Dolomites in 4 days");
  });
  await sleep(300);
  planId = await js(() => trip.id);
  // the moment the days are coming in
  for (let i = 0; i < 200; i++) {
    await sleep(150);
    const n = await js(() => progress?.lives?.route?.plan?.points?.length || 0);
    if (n >= 8) break;
  }
});
// a phone: Today on the road
await shot("phone-today", async () => {
  await js(() => window.__p);
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.setGeolocation({ latitude: 44.92, longitude: -110.42 });
  await page.goto(APP, { waitUntil: "load" });
  await sleep(1500);
  await js(async (id) => {
    await openTrip(id);
    setView("itinerary");
    todayState.day = 2;
    openToday();
  }, copyId);
  await sleep(2000);
});

// a phone: a ready-made trip's preview in the Trips tab
await shot("phone-trips", async () => {
  await js(async () => {
    closeOverlay();
    setView("trips");
    await loadLibrary(true);
    Object.assign(libState, { show: "ready", region: "", q: "" });
    libOpen("1c2cabe3-cb21-4403-8a18-792256347da1"); // Innsbruck to Lake Como
  });
  await sleep(4000);
});

console.log(JSON.stringify({ copyId, planId }));
await browser.close();
