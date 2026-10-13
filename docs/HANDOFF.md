# Handoff: where Byway stands (2026-10-13, after the 1.0 release)

For picking the work up on another computer. `CLAUDE.md` (the long working notes) is local only and not in git; copy
it over by hand if you want the full history. This file has what's needed to continue.

## Getting going on a new computer

1. `git pull` (or clone `Hal0MG/byway`), then `npm install` (on Windows in PowerShell: `npm.cmd install`).
2. Start it: `start.cmd` (Windows), `start.command` / `sh start.sh` (Mac), or `node server.js`.
3. Keys aren't in git. Open the app, the welcome screen (or Setup, the gear button) takes a Gemini key; an
   OpenRouteService key and a Tavily key are optional. They're saved to `.env` on that computer.
4. Your own trips (`data/trips.json`) aren't in git either. Copy that file over if you want them; the three you made
   are also in the ready-made trips now.
5. Checks: `npm test` (16 unit tests), `npm run smoke` with `CHROME_PATH` set to a Chrome Headless Shell
   (`npx @puppeteer/browsers install chrome-headless-shell@stable --path .browsers`).

## Done in 1.0

- Released: https://github.com/Hal0MG/byway/releases/tag/v1.0.0 (Mac Apple Silicon .dmg/.zip, Windows installer/.zip).
  The repo is still **private**, so only collaborators can download.
- Welcome screen on first launch (language, sound, Gemini key, home town; all skippable).
- Opening: satellite view of the home town (else San Francisco) pulling back to the globe; trips, search panel and top
  bar fade in. Dark mode and satellite are the defaults.
- Home: no legend, a shorter search panel (actions in one sliding row), cards further out at the sides, shooting stars.
- Sounds made with Web Audio (`public/sound.js`): a different sound per kind of control, ambient music on the globe;
  on/off and volume in Settings.
- Languages: English, French, Chinese, Bangla (`public/i18n.js`, `public/i18n-strings.js`, the in-depth How it works in
  `public/about-deep-i18n.js`). The AI writes in the chosen language. Arabic was skipped (right to left).
- How it works has an "In depth" version on the methods behind each step.
- Planner eval (`npm run eval`, results in `eval/results/2026-10-13`).
- Smaller files: route lines stored as encoded polylines, gzip responses, a trimmed photo cache.
- 38 ready-made trips. LM Link (running the model on another computer) removed.

## Open items, in order

1. **Before making the repo public**: erase old `CLAUDE.md` and `docs/BACKLOG.md` copies from the git history. A
   backup mirror was made on the Mac at `~/code/byway-history-backup.git`. Commands:
   `FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --index-filter 'git rm -q --cached --ignore-unmatch CLAUDE.md docs/BACKLOG.md' --prune-empty -- main world-coverage`
   then `git push --force origin main world-coverage`. After that, every other clone (this PC included) must reset to
   the new history (`git fetch && git reset --hard origin/main`) or re-clone, or the old commits come back.
2. Then make the repo public (Settings > General > Danger zone > Change visibility) so the release downloads work for
   anyone. License is MIT (`LICENSE`), already in the README.
3. **Private website for a few testers** (later). Current plan: a read-only demo (globe, ready-made trips, trip pages,
   map, How it works; no AI planning) hosted for free, with the desktop app for planning. A full multi-user site would
   need per-visitor keys and storage and its own place search (the free Nominatim server allows 1 request a second).
4. **Promo video** (offered, not started): script the app in headless Chrome, captions, optional macOS `say`
   voiceover; joining clips needs ffmpeg (`brew install ffmpeg`).
5. Whole world coverage is parked on the `world-coverage` branch. Missing: a fallback place search when Nominatim
   rate-limits (Photon, https://photon.komoot.io, was next), and checking world plans end to end.
6. Translations are machine quality; a native speaker should review `public/i18n-strings.js`. Example prompts and the
   ready-made trips' own text stay in English.
7. Desktop builds: GitHub Actions "Desktop apps" workflow (run it by hand, or it runs on a `v*` tag). Apps are unsigned
   and Mac is Apple Silicon only; Intel/universal Mac builds would be bigger.
8. When OpenRouteService has quota: re-measure the ready-made trips with the road pass and add heights
   (`tools/audit-trips.mjs`, `tools/add-heights.mjs`, then `node tools/export-presets.mjs`).
