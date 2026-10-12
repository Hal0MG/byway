// Checks the hand-written road lists (data/*-drives.json): every "wiki" title must be a real English Wikipedia article
// (not missing, not a disambiguation page), and every entry needs a name, states and a description.
// Usage: node tools/check-drives.mjs
import fs from "node:fs";

const dir = new URL("../data/", import.meta.url);
const files = fs.readdirSync(dir).filter((f) => f.endsWith("-drives.json"));
const UA = "RoadtripPlanner/1.12 (personal trip planner, data check)";
let problems = 0;
for (const f of files) {
  const list = JSON.parse(fs.readFileSync(new URL(f, dir), "utf8"));
  for (const d of list) {
    if (!d.name || !Array.isArray(d.states) || !d.states.length || !d.description) {
      console.log(`!! ${f}: incomplete entry ${JSON.stringify(d).slice(0, 80)}`);
      problems++;
    }
  }
  const titles = [...new Set(list.map((d) => d.wiki).filter(Boolean))];
  for (let i = 0; i < titles.length; i += 40) {
    const u = new URL("https://en.wikipedia.org/w/api.php");
    u.search = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", redirects: "1", prop: "pageprops", ppprop: "disambiguation",
      titles: titles.slice(i, i + 40).join("|"),
    });
    const d = await (await fetch(u, { headers: { "User-Agent": UA } })).json();
    for (const p of d.query.pages) {
      if (p.missing) {
        console.log(`!! ${f}: no article "${p.title}"`);
        problems++;
      } else if (p.pageprops?.disambiguation !== undefined) {
        console.log(`!! ${f}: "${p.title}" is a disambiguation page`);
        problems++;
      }
    }
    await new Promise((ok) => setTimeout(ok, 500));
  }
  console.log(`${f}: ${list.length} drives, ${titles.length} articles checked`);
}
console.log(problems ? `${problems} problems` : "all good");
