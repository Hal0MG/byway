// A quick check of the whole app in a headless browser: every view and the main sheets, at desktop and phone width, in
// dark and light, failing on any page error or console error. For unattended sessions and before a commit:
//   CHROME_PATH=<chrome-headless-shell> npm run smoke        (the app must be running on port 3000, or set APP)
// It opens a copy of a ready-made trip (deleted at the end) and makes no AI calls. Screenshots go to SMOKE_OUT if set.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const APP = process.env.APP || "http://localhost:3000";
const OUT = process.env.SMOKE_OUT || "";
const PRESET = "d88f17df-6c9a-4077-9dae-22fe8e2ccb14"; // Grand Teton, Yellowstone and the Beartooth Highway
if (!process.env.CHROME_PATH) {
  console.error("Set CHROME_PATH to a chrome-headless-shell (npx @puppeteer/browsers install chrome-headless-shell@stable).");
  process.exit(2);
}
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const problems = [];

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: "shell",
  userDataDir: fs.mkdtempSync(path.join(os.tmpdir(), "byway-smoke-")),
  args: ["--hide-scrollbars"],
});
const copies = [];
try {
  // the third pass is in Bangla: the translator runs on every screen (a looping translation once froze the trip page)
  for (const [size, theme, lang] of [["desktop", "dark", "en"], ["phone", "light", "en"], ["desktop", "light", "bn"]]) {
    const page = await browser.newPage();
    const where = { step: "load" };
    page.on("pageerror", (e) => problems.push(`${size}/${theme}/${lang} ${where.step}: page error: ${e.message}`));
    page.on("console", (m) => {
      // map tiles and photos can fail on a flaky network; those aren't the app's errors
      if (m.type() === "error" && !/Failed to load resource|tile|ERR_|net::/i.test(m.text())) problems.push(`${size}/${theme}/${lang} ${where.step}: ${m.text()}`);
    });
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: theme }]);
    await page.setViewport(size === "phone" ? { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { width: 1440, height: 900 });
    await page.goto(APP, { waitUntil: "load" });
    await page.evaluate((t, l) => {
      localStorage.setItem("theme", t);
      localStorage.setItem("lang", l);
    }, theme, lang);
    await page.goto(APP, { waitUntil: "load" });
    await sleep(4000);
    const js = (f, ...a) => page.evaluate(f, ...a);
    // the welcome screen shows on a first visit: go through every step with the main button, then it must be gone
    if (size === "desktop" && lang === "en") {
      where.step = "welcome";
      if (!(await js(() => !!document.getElementById("welcome")))) problems.push(`${size}/${theme}/${lang} welcome: didn't open on the first visit`);
      for (let i = 0; i < 12 && (await js(() => !!document.getElementById("welcome"))); i++) {
        await js(() => document.querySelector("#welcome [data-primary]")?.click());
        await sleep(700);
      }
      if (await js(() => !!document.getElementById("welcome"))) problems.push(`${size}/${theme}/${lang} welcome: still open after every step`);
    }
    await js(() => localStorage.setItem("welcomed", "1"));
    if (await js(() => !!document.getElementById("welcome"))) {
      await page.goto(APP, { waitUntil: "load" });
      await sleep(4000);
    }
    const step = async (name, fn, wait = 1500) => {
      where.step = name;
      try {
        await fn();
        await sleep(wait);
        if (OUT) await page.screenshot({ path: path.join(OUT, `${size}-${theme}-${name}.png`) });
        // nothing wider than the screen: the page, the view or an open sheet scrolling sideways on a phone
        const wide = await js(() => {
          const view = { trips: "#library .lib-main", about: "#about", home: "#home", map: "#panel" }[document.body.dataset.view] || "#itinerary";
          return [document.scrollingElement, document.querySelector(view), document.querySelector(".overlay .sheet")]
            .filter(Boolean)
            .filter((el) => el.scrollWidth > el.clientWidth + 2 && !/hidden|clip/.test(getComputedStyle(el).overflowX))
            .map((el) => `${el.id || el.className || el.tagName} is ${el.scrollWidth} px wide in ${el.clientWidth}`)
            .join("; ");
        });
        if (wide && size === "phone") problems.push(`${size}/${theme}/${lang} ${name}: wider than the screen: ${wide}`);
        // the map credits (OpenStreetMap and the tile providers) must stay visible wherever the map shows
        const hidden = await js(() => {
          if (!["home", "map"].includes(document.body.dataset.view) || document.querySelector(".overlay")) return "";
          const a = document.querySelector(".maplibregl-ctrl-attrib")?.getBoundingClientRect();
          if (!a) return "no credits";
          const top = document.elementFromPoint(a.left + 8, a.top + a.height / 2);
          return top?.closest(".maplibregl-ctrl-attrib") ? "" : `covered by ${top?.id || top?.className || top?.tagName}`;
        });
        if (hidden) problems.push(`${size}/${theme}/${lang} ${name}: map credits ${hidden}`);
      } catch (e) {
        problems.push(`${size}/${theme}/${lang} ${name}: ${e.message}`);
      }
    };
    await step("home", async () => js(() => setView("home")), 3000);
    await step("trips", async () => js(() => setView("trips")), 2500);
    await step("trip-preview", async () => js((id) => libOpen(id), PRESET));
    await step("open-copy", async () => {
      copies.push(await js(async (id) => {
        await openPreset(id);
        setView("itinerary");
        return trip.id;
      }, PRESET));
    }, 3000);
    await step("itinerary-day", async () => js(() => {
      const b = document.querySelector("#itinerary");
      const el = document.querySelector("#day-2 h3");
      b.scrollTo(0, el.getBoundingClientRect().top + b.scrollTop - 90);
    }));
    await step("chart-hover", async () => js(() => {
      const row = document.querySelector("#day-2 .tl-row[data-f] button");
      row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
      if (document.querySelector("#day-2 .pf-tip")?.hidden) throw new Error("the day chart didn't follow a timeline row");
    }));
    await step("cost", async () => js(() => document.querySelector(".cost-card summary").click()));
    await step("map", async () => js(() => setView("map")), 3000);
    await step("today", async () => js(() => { setView("itinerary"); openToday(); }));
    await step("export", async () => js(() => { closeOverlay(); document.querySelector('[data-act="export"]').click(); }));
    await step("phone-sheet", async () => js(() => { closeOverlay(); openPhoneSheet(1); }), 2500);
    await step("near", async () => js(async () => {
      closeOverlay();
      nearState.home = { name: "Denver, Colorado", at: [-104.985, 39.739] };
      await openNear();
      if (!document.querySelectorAll(".near-list li").length) throw new Error("no roads near Denver");
    }));
    await step("setup", async () => js(() => { closeOverlay(); setView("home"); openSetup(); }), 2500);
    await step("about", async () => js(() => { closeOverlay(); setView("about"); }));
    await page.close();
  }
} finally {
  for (const id of copies.filter(Boolean)) await fetch(`${APP}/api/trips/${id}`, { method: "DELETE" }).catch(() => {});
  await browser.close();
}
if (problems.length) {
  console.log(`${problems.length} problem(s):\n${problems.join("\n")}`);
  process.exit(1);
}
console.log("All views opened without errors (desktop dark, phone light, desktop light in Bangla), and the welcome screen went through.");
