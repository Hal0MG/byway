# Changelog

## 1.1.0 (2026-10-14)

Plans anywhere in the world.

- **Whole world**: trips can start and end anywhere. Place search, routing, units and currency work in every country;
  the hand-checked road lists (US, Canada, Australia, New Zealand, the UK and Ireland, the Alps, Norway, Iceland, Spain
  and Portugal) are a bonus where they exist. The grey "not covered" mask is gone.
- **66 ready-made trips**, 28 of them new and spread around the globe: Norway, Iceland, Ireland, Andalusia, Provence,
  Tuscany and Amalfi, Croatia, Romania, Turkey, Georgia, Oman, Morocco, South Africa, Namibia, Ladakh, northern
  Thailand, Taiwan, Japan, South Korea, Western Australia, Yucatán, Costa Rica, Brazil, Patagonia, Salta, Peru,
  Bangladesh, and Singapore to Malaysia. Five older ones were measured again with OpenRouteService (real heights and
  road ratings), and four with days far over the limit were rebuilt.
- **Routing**: OpenRouteService through its new address (api.heigit.org), with ten times the free daily allowance.
  Stops the router can't reach try the place search's next match or move to the nearest drivable road, and a leg with
  no direct road (a gulf, a mountain range, a closed stretch) is pointed out.
- **Better plans**: stops land in the town rather than a station or an outline (Tokyo was placed 45 km west), made-up
  road names no longer match an unrelated highway, and motorways or car-free places (Kamikochi, Zermatt) aren't
  featured anywhere in the world.
- **Home screen**: the floating windows keep their places as the globe turns, slide instead of jumping, and sit further
  out at the sides. The opening starts over the home town you set on the welcome screen.
- **Removed**: the local model in LM Studio. Gemini plans every trip (Claude still works if set up).

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
