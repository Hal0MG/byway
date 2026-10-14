# Changelog

## 1.1.0 (2026-10-14)

Plans anywhere in the world, with 74 ready-made trips and a public demo mode. Changes since 1.0.0:

**Anywhere in the world**
- Trips can start and end in any country. Place search, routing, units, currency and the Trips tab work everywhere; the
  hand-checked road lists (US, Canada, Australia, New Zealand, the UK and Ireland, the Alps, Norway, Iceland, Spain and
  Portugal) are a bonus where they exist. The grey "not covered" mask and warning are gone.
- **36 new ready-made trips (74 in all)**: 28 around the world (Norway, Iceland, Ireland, Andalusia, Provence, Tuscany and
  Amalfi, Croatia, Romania, Turkey, Georgia, Oman, Morocco, South Africa, Namibia, Ladakh, northern Thailand, Taiwan,
  Japan, South Korea, Western Australia, Yucatán, Costa Rica, Brazil, Patagonia, Salta, Peru, Bangladesh, and Singapore
  to Malaysia) and eight Top Gear specials (Botswana, the US, Vietnam over the Hai Van Pass, Bolivia and the Yungas
  road, India, Patagonia, the Stelvio, and the Transfăgărășan).
- Five older trips measured again with OpenRouteService (real heights, climbs and road ratings), and Toronto to Vancouver,
  Dallas to Teton County and Gaspé rebuilt with days within the daily limit.
- **Trips tab and home screen**: trips outside the hand-checked countries are grouped as More of Europe, Asia, Africa
  and the Middle East, and Latin America, and labelled by country; the globe's region buttons gained Europe, Asia,
  Africa, the Middle East and the Americas.
- **Trip cost** in the local currency (yen, taka, rand, and 17 more), priced by the country where most nights are.

**Better plans**
- Stops land in the town, not a station or an area outline (Tokyo had been placed 45 km west of the city).
- A stop the router can't reach tries the place search's other matches, then the nearest drivable road; two stops it
  can't connect do the same (Nha Trang, Angra dos Reis).
- A leg with no direct road (a gulf, mountains, a closed stretch) is pointed out after routing.
- Made-up road names no longer match an unrelated highway; motorways and expressways aren't featured anywhere; car-free
  places (Kamikochi, Zermatt, Ilha Grande) aren't used as stops.
- The start screen, planning status line, README and How it works (in all four languages) describe planning anywhere.

**Routing**
- OpenRouteService through its new address (api.heigit.org): 2,000 free routes a day instead of 200. Snapping a point to
  a road falls back to OSRM when Overpass is busy.

**Home screen**
- The floating trip windows keep their places as the globe turns, slide instead of jumping, fade instead of sweeping
  across the globe, and sit further out at the sides.
- The opening starts over the home town set on the welcome screen, not San Francisco.

**Demo site mode** (`DEMO=1`, `render.yaml`, `docs/DEMO.md`)
- A public site on the owner's keys: no key screens, each visitor's trips kept to themselves, daily caps per visitor,
  network and site so the free allowances can't be used up, and trips that survive the free host's sleep. The privacy
  page has a section for it.

**Removed**
- The local model in LM Studio: Gemini plans every trip (Claude still works if a key is set). The `start-ai` scripts and
  the `undici` package went with it.
- GraphHopper (the optional self-hosted router) and its folder.

## 1.0.0 (2026-10-13)

The first release, with the desktop app for Mac and Windows.

- **Opening**: the globe pulls back from a satellite view of your town, then the trips, search and top bar fade in.
  Dark and satellite by default.
- **Welcome screen** on first launch: language, sound, the AI planner and a home town, every step
  skippable.
- **Languages**: English, French, Chinese (simplified) and Bangla, from the flag menu in the top bar. The AI writes trip
  plans, guides and answers in the chosen language.
- **Sound**: interface sounds and ambient music on the globe, with switches and volume in Settings (now on every
  device, not only the computer running the app).
- **How it works, in depth**: the methods behind each step (the planner's checks, route-aware place matching, the
  day-split, elevation smoothing, the curve ratings), for readers who want the details.
- **Planner eval** (`npm run eval`): 30 trip requests through each AI model and the pipeline, with a report of what
  each step fixes.
- **Smaller files**: route lines stored as encoded polylines (ready-made trips 24 MB to 5.4 MB, saved trips about a
  quarter of their old size), gzip for everything the app sends, and a slimmer photo lookup cache. Saved trips are
  converted once at start; the old file is kept as `data/trips.pre-1.0.json`.
- Featured roads the planner names are now really driven (points added on the road itself), Gemini retries when
  Google's free models are busy, and five more countries: Norway, Iceland, Ireland, Spain and Portugal.
- **38 ready-made trips**, three new ones: Toronto to Vancouver, Dallas to Teton County, and Los Angeles to Death
  Valley.
- **Home screen**: shooting stars, a shorter search panel, trip cards further out at the sides, and a sound for each
  kind of control.
- Removed: switching LM Studio between computers (LM Link). A local model on the computer running Byway still works.
- Fixed: the home panel covered the map credits on the light map; the phone top bar didn't fit the language flag.
