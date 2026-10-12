// Builds data/byways.json: every National Scenic Byway and All-American Road, from the table on
// Wikipedia's "National Scenic Byway" article (sourced from the FHWA America's Byways program).
// Usage: node tools/build-byways.mjs
import fs from "node:fs";

const UA = { "User-Agent": "roadtrip-planner/0.3 (personal project)" };
const u = "https://en.wikipedia.org/w/api.php?action=parse&page=National_Scenic_Byway&prop=wikitext&format=json&formatversion=2";
const wikitext = (await (await fetch(u, { headers: UA })).json()).parse.wikitext;

// [[Target|Label]] -> Label, [[Target]] -> Target, and drop templates, refs and markup.
const linkTarget = (s) => s.match(/\[\[([^\]|#]+)/)?.[1]?.trim() || null;
function clean(s) {
  return s
    .replace(/<ref[^>]*\/>/g, "")
    .replace(/<ref[\s\S]*?<\/ref>/g, "")
    .replace(/\{\{convert\|([\d.]+)\|mi[^}]*\}\}/g, "$1 mi")
    .replace(/\{\{dts\|([^}]*)\}\}/g, "$1")
    .replace(/\{\{[^}]*\}\}/g, "")
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replace(/<br\s*\/?>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/'''?/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const byways = [];
for (const row of wikitext.split(/\n\|-/)) {
  const type = row.match(/\|\s*(AAR|NSB)\s*\n/)?.[1];
  const nameLine = row.match(/\n!\s*scope="row"\s*\|\s*(.+)/)?.[1];
  if (!type || !nameLine) continue;
  // Cells after the name, one per line starting with "|"
  const after = row.slice(row.indexOf(nameLine) + nameLine.length);
  const cells = after.split(/\n\|/).slice(1).map((c) => c.trim());
  const [length, states, from, to, , description, qualities] = cells;
  const fhwa = row.match(/https:\/\/fhwaapps\.fhwa\.dot\.gov\/bywaysp\/StateMaps\/Show\/byway\/\d+/)?.[0] || "";
  byways.push({
    name: clean(nameLine),
    wiki: linkTarget(nameLine),
    type: type === "AAR" ? "All-American Road" : "National Scenic Byway",
    miles: parseFloat(clean(length || "")) || null,
    states: clean(states || "").split(/,\s*/).filter(Boolean),
    from: clean(from || ""),
    to: clean(to || ""),
    description: clean(description || ""),
    qualities: clean(qualities || ""),
    fhwa,
  });
}

fs.mkdirSync(new URL("../data/", import.meta.url), { recursive: true });
fs.writeFileSync(new URL("../data/byways.json", import.meta.url), JSON.stringify(byways, null, 1));
console.log(`${byways.length} byways (${byways.filter((b) => b.type === "All-American Road").length} All-American Roads)`);
for (const b of byways.filter((b) => b.states.includes("Colorado") || b.states.includes("Wyoming")).slice(0, 30)) {
  console.log(`  ${b.type === "All-American Road" ? "AAR" : "NSB"} ${b.name} (${b.miles} mi, ${b.states.join("/")}): ${b.description}`);
}
