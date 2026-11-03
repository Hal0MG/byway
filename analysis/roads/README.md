# What makes a great driving road?

A model that scores every road segment in a region for how much it looks like the roads people drive for the drive
itself. Labels come from designated scenic byways (OpenStreetMap route relations) and Byway's own hand-picked road
catalog (`public/road-points.json`, 399 roads). Features come from the road's geometry, terrain and OpenStreetMap tags,
measured the same way the app rates featured roads (`curveStats` in `public/features.js`).

The aim is to find great roads the catalog doesn't list, for "Roads near me" and the planner in regions with no
hand-checked list, and to say what makes a road a driving road, in numbers.

## Pilot: Colorado (2026-11-03)

```bash
python analysis/roads/fetch_osm.py US-CO       # roads (trunk to tertiary) and byway relations from Overpass, ~2 min
python analysis/roads/build_segments.py US-CO  # ~5 km segments, curves, hairpins, road tags, byway label
python analysis/roads/add_elevation.py US-CO   # terrain from the public AWS terrain tiles, seconds
python analysis/roads/pilot_model.py US-CO     # blocked cross validation, importance, candidates
```

**Data.** 8,609 segments, 39,860 km of road. 783 segments lie on one of 26 designated byways (9.4%). The curve measure
matches the app's calibration: the Million Dollar Highway scores about 205°/km with 5 hairpins per 10 km, and I‑70
about 28°/km (the app's reference interstate is about 30).

**Can measurements pick out byways?** Spatially blocked 5-fold cross validation, holding out whole 0.5° map cells, so a
segment is never scored by a model that trained on its neighbours:

| Features | Logistic ROC AUC | Boosting ROC AUC | Best average precision (base rate 0.094) |
|---|---|---|---|
| Shape only (curves, hairpins, straightness) | 0.65 | 0.67 | 0.16 |
| + terrain (height, relief, climbing) | 0.70 | 0.72 | 0.24 |
| + road tags (class, speed, surface, junctions) | 0.84 | 0.83 | 0.41 |

There is real signal: about 4× the base rate in precision on held-out ground. The top non-byway roads it found are the
right kind of road: Pikes Peak Highway (in Byway's catalog, and never shown to the model as a positive), Loveland Pass
(US 6), Berthoud Pass (US 40), Hoosier Pass (CO 9), Coal Creek and Boulder Canyons (CO 72, CO 119 outside Peak to Peak).

**What the pilot also shows (the problems to solve):**

1. **The label is "designated", not "great to drive".** Byways are chosen for scenery and history. Pawnee Pioneer
   Trails (4°/km) and the Santa Fe Trail (6°/km) are flat plains roads, while Alpine Loop (300°/km, 4×4 passes) scores
   low because it's unpaved. That's why shape alone is weak. The target needs defining before the model can be good.
2. **Absolute height is a Colorado shortcut.** The top feature is mean elevation, so flat roads on high plains
   (Elbert Road, CR 17-21, the North Park end of CO 14) score high. That won't transfer to a coast road at sea level.
   Terrain has to be relative: relief, grade, height above the valley floor.
3. **Positive-unlabeled.** "Not a byway" doesn't mean "not great", so a high score on a non-byway is sometimes a
   discovery and sometimes an error. Precision against byway labels understates the model, and only a hand-checked test
   set can say by how much.

## Plan

1. **A gold test set.** Hand-label about 300 segments across regions ("would you drive this for fun", 1 to 3),
   stratified by model score. This is the only honest measure of the real target, and the step that most needs a
   driver's judgement. Use it for evaluation only; train on the weak labels.
2. **Three label tiers.** Catalog famous drives (driving quality, hand-picked), designated byways (scenery), and
   unlabeled roads. Then compare a positive-unlabeled learner against plain weighted classification.
3. **Features that transfer.** Relative terrain (relief, max grade, height above the lowest point within 10 km),
   scenery from OpenStreetMap (coast or lake within 500 m, forest, protected areas), distance to towns, and switchback
   sequences, not just hairpin counts.
4. **More regions, and the headline test.** Add California, the Alps, Scotland and Norway (the catalog has roads in
   all of them). Train on three, test on the fourth. If the scores hold across regions, the model is useful worldwide.
   If they don't, that's the finding.
5. **Back into the app.** Export the top-scoring segments per region as a `road-points.json`-style list, so "Roads near
   me" works where there's no catalog.

Everything uses free, keyless data (Overpass, AWS terrain tiles). The limit is Overpass on large areas, so fetch big
regions as several boxes.
