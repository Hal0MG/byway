# Whole-world coverage: prep notes (2026-10-13)

Where it stands. Nothing here changes the app yet; it is the checklist for the session that does the work.

## What exists

Branch `world-coverage` is one commit (`51b86f6`) on top of `4d60f28`; `main` is 14+ commits ahead. It:
- drops the `countrycodes=` filter from Nominatim searches (`geocodeServer`, `roadShape` in `server.js`);
- rewrites the planner prompt to "anywhere in the world", with the hand-checked road lists as a bonus, and tells the
  model not to invent roads outside them;
- removes the grey "outside the covered areas" mask and warning (`itinerary.js`, `app.js`, `home.js`);
- adds `public/countries.json` (493 KB, Natural Earth 1:50m outlines with ISO codes, built by
  `tools/build-countries.mjs`, needs `@turf/turf` as a dev dependency) so units, currency and the Trips tab regions
  work anywhere without a server call.

## Merging it

`git merge-tree` against current `main`: one conflict, `public/sw.js` (the cache name and shell file list: keep main's
version and add `/countries.json` to the shell list). Everything else merges cleanly. Merge the branch into `main`
(or cherry-pick), do not rebase the 14 main commits onto it.

## Decided

- No Photon fallback. The earlier Nominatim trouble was an error on our side (the ORS routing limit and old address,
  fixed in `a424fcf`), not the search being rate limited. The queue (one request, 1.1 s gap) and the disk cache stay.
  Add a fallback only if real 429/403 answers from Nominatim show up.

## To do, in order

1. Merge `world-coverage`, fix `sw.js`, `npm test`, `npm run smoke`.
2. Plan 5 trips outside the covered lists (for example Japan, South Africa Garden Route, Chile/Argentina Andes, a
   Balkans loop, Thailand north) and check each end to end: place names found, routes measured by ORS, units and
   currency right, no grey mask, no invented roads, seasonal rules not wrongly applied.
3. Check what is still region-specific: `seasonal-roads.json` (US/Canada/Alps closures only), Overpass fuel and
   diners queries (box queries; slow in remote areas), the driving side and speed units per country, the
   per-country fuel price defaults, the Wikipedia language for photos.
4. ORS limits: the free key allows 2,000 routes/day on `api.heigit.org` (200 on the old address), and a route can't be
   longer than the API's distance cap; long trips are already cut into pieces, check a very long overseas one.
5. Update the README, How it works (all four languages in `public/i18n-strings.js`, `about-deep-i18n.js`) and the
   changelog from "covered regions" wording to "anywhere, with hand-picked roads in these places".
