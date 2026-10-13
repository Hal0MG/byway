# Changelog

## 1.0.0 (2026-10-13)

The first release, with the desktop app for Mac and Windows.

- **Welcome screen** on first launch: language, light or dark, sound, the AI planner and a home town, every step
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
- Fixed: the home panel covered the map credits on the light map.
