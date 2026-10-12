# Roadtrip Planner

Road trip planner built around scenic driving roads, for the US, Canada, Australia (NSW, Victoria, ACT, Queensland,
Tasmania), New Zealand, the UK and the Alps. Describe a trip and an AI plans it over the best driving roads (from
officially designated scenic byways and hand-picked famous drives), the app measures every day's drive, writes a
day-by-day guide with the roads and the spots worth stopping for, and opens each day in Google Maps or Apple Maps for
turn-by-turn directions.

## Getting started

1. Install [Node.js](https://nodejs.org/en/download) (free, the LTS version).
2. Windows: double-click `start.cmd`. Mac: double-click `start.command` (the first time macOS may refuse it as
   coming from an unidentified developer: right-click it, choose Open, then Open). Linux: run `sh start.sh`.
   The first time it installs what the app needs (about a minute), then opens the app in your browser.
3. The app opens its Setup screen and walks you through the rest, all free:
   - an OpenRouteService key for routes (needed, no card),
   - the trip planner AI: on your own PC with LM Studio (free and unlimited, needs a graphics card with about 8 GB;
     Setup can start LM Studio, download the model and load it), or a free Google Gemini key (no GPU, about 20 plans a day),
   - a Tavily key for web search while planning (optional),
   - your email or website, so Wikipedia doesn't slow down photo lookups (recommended).

On an Apple Silicon Mac (M1 or later, 16 GB) the local model runs on the Mac's GPU through LM Studio; planning takes a
few times longer than on a desktop graphics card. `start-ai.sh` loads it from Terminal, or use Setup.

Setup checks each key with its service before saving it to `.env` (see `.env.example`). It's the gear button in the
top bar, and it only works on the PC running the app. Keep the start window open while you use the app.

## Using it

- Start screen: describe the trip, pick a style (coast, mountains, twisty roads...), a start date, when you leave,
  the longest day you want, loop trip, no night driving, electric car. Or open a ready-made trip instantly.
- Each day shows the weather (forecast within 16 days, typical weather further out), sunset, the timeline with the
  roads and stops (time zone changes included), an elevation profile, seasonal closures and winter rules, ferries,
  tolls and gravel, featured road cards with curve, hairpin and climb ratings, spots, and where to stay.
- "Find fuel, chargers and sights along the route" checks OpenStreetMap for the longest stretch without fuel (and
  without a fast charger for electric cars), viewpoints, waterfalls, hot springs, diners and lodging.
- Fix backtracking, Fix long days, Ask for a change, Pick roads, Versions (compare and restore earlier plans), Notes
  and checklist.
- Export and share: GPX (one track per day), print or save as PDF, download as a web page, or a read-only link for
  phones on the same Wi-Fi.
- Map tab: the route, spots, 3D terrain (the 3D button), "Fly it in 3D" on road cards, the day's elevation profile.
- Trips save automatically to `data/trips.json`.
- Batch mode (`http://localhost:3000/?batch=1`) plans a list of trips one after another and saves them as
  ready-made trips. Leave it running; trips already built are skipped.
- On the PC, Chrome and Edge offer to install the app (it opens saved trips offline too).

## Data and tools

- `data/byways.json`: US National Scenic Byways and All-American Roads (`node tools/build-byways.mjs`).
- `data/*-drives.json`: hand-picked drives (US extras, Canada, Australia, New Zealand, UK, Alps).
  `node tools/check-drives.mjs` checks every Wikipedia title.
- `public/seasonal-roads.json`: roads that close for winter or need chains. `node tools/check-seasonal.mjs` checks the
  coordinates against OpenStreetMap.
- `public/coverage.json`: covered regions and the grey mask (`node tools/build-coverage.mjs`, needs `@turf/turf`).
- Caches in `data/`: Wikimedia, web searches and pages, research notes per region, weather, OpenStreetMap lookups.

## GraphHopper (optional, off by default)

A self-hosted GraphHopper can fine-tune routes inside one region. It needs Java, a lot of RAM and a long first build,
so the app doesn't need it. The California map and graph from 1.3 and 1.4 were deleted to save space (3 GB); to use it
again, download a region from Geofabrik and the GraphHopper jar, set `USE_GRAPHHOPPER=1` in `.env` and run
`graphhopper\start-graphhopper.cmd`.
