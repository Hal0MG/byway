# Handoff

Where Byway stands, for picking the work up on another computer. The long working notes (`CLAUDE.md`) are local only and
not in git; copy them over by hand if you want the full history.

## Getting going on a new computer

1. Clone `Hal0MG/byway` (or `git pull`), then `npm install` (on Windows in PowerShell: `npm.cmd install`).
2. Start it: `start.cmd` (Windows), `start.command` / `sh start.sh` (Mac), or `node server.js`.
3. Keys aren't in git. The welcome screen (or Setup, the gear button) takes a Gemini key; an OpenRouteService key and a
   Tavily key are optional. They're saved to `.env` on that computer.
4. Your own trips (`data/trips.json`) aren't in git either; copy that file over if you want them.
5. Checks: `npm test` (16 unit tests), and `npm run smoke` with `CHROME_PATH` set to a Chrome Headless Shell
   (`npx @puppeteer/browsers install chrome-headless-shell@stable --path .browsers`).

## What's in 1.1.0

- Plans anywhere in the world; hand-checked road lists for the US, Canada, Australia, New Zealand, the UK and Ireland, the
  Alps, Norway, Iceland, Spain and Portugal. 74 ready-made trips on every continent, including eight Top Gear specials.
- Gemini is the only planner (Claude works if a key is set). The local LM Studio model and GraphHopper are gone.
- OpenRouteService through `api.heigit.org` (2,000 routes a day), with OSRM as the backup router.
- Demo site mode (`DEMO=1`): see `docs/DEMO.md`. It runs on Render's free plan from `render.yaml`.
- Desktop apps for Mac (Apple Silicon) and Windows from the "Desktop apps" workflow; the current release is v1.1.0.

## Open items

1. **Make the repo public** (Settings, General, Danger zone, Change visibility) so the release downloads work for
   anyone. The license is MIT. The old working notes were already removed from the history.
2. **Smoke test** every view with `npm run smoke` (needs a headless Chrome).
3. **Watch the demo's free-service limits**: Nominatim and Overpass limit by network address, and Render's free hosts
   share addresses. If place search fails on the demo, add a fallback search (Photon, https://photon.komoot.io).
4. Long days remain in a few world trips where the router's times for gravel are slow (Namibia).
5. When OpenRouteService has quota, re-measure trips with `tools/audit-trips.mjs`, `tools/add-heights.mjs` and
   `node tools/export-presets.mjs`.
6. Later: a promo video, signed desktop apps and an Intel Mac build.
