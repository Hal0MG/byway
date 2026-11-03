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

## Labels from what drivers say (2026-11-03)

Byway designation is the wrong label, so the next step labelled roads by driver opinion instead: one web search per
stretch (Tavily, worded like a review search: "... driving experience motorcycle ride review"), read by Gemini, which
scores driving 1 to 5 apart from scenery and quotes its evidence. It's the app's "What drivers say" feature, made to
give a score.

```bash
python analysis/roads/fetch_osm.py US-CO       # now also passes and towns, to name stretches
python analysis/roads/stretches.py US-CO       # ~30 km stretches of state and US highways, named, 242 picked
python analysis/roads/label_drivers.py US-CO   # 1 search + 1 Gemini answer each, resumable, keeps the app's search count
python analysis/roads/driver_model.py US-CO    # compares predictors, writes US-CO-driver-labels.csv
```

The 242 stretches were picked across the pilot model's scores (92 top fifth, 100 middle, 50 bottom fifth), from state
and US highways and anything over a pass or on a byway. County roads were left out because nobody writes about them.
They cost 248 of the month's 1,000 free searches. The labels are in `US-CO-driver-labels.csv`, with each verdict's
evidence and sources.

**What the labels look like.** 119 of 242 stretches had drivers talking about them. Scores bunch up: 92 of the 119 are
4 or 5, because people mostly write about roads they like. A read of about 40 verdicts against their sources found
them well grounded ("Best switchback mountain pass in Colorado" for Berthoud Pass, "17 miles of consistent curves" for
Grand Mesa), with about 1 in 20 clearly wrong. One came from a troll comment (Poudre Canyon got 1/5). Another came from
spillover, where a road's reputation lands on a dull part of it (CO 82's approach to Independence Pass got 5/5, US 160
on the Kansas plains got 4/5). Some famous stretches come back with nothing usable (Trail Ridge Road's results were
about closures).

**Results**, on held-out map areas, with 95% bootstrap intervals:

| Question | Predictor | ROC AUC |
|---|---|---|
| Do drivers write about this stretch at all? (119 yes, 123 no) | Curves per km alone | **0.84** |
| | Relief alone | 0.83 |
| | Logistic on all features | 0.83 (0.78 to 0.88) |
| | Pilot byway model | 0.73 |
| Among those, do drivers rate it 4 or 5? (92 yes, 27 no) | Curves per km alone | 0.56 (0.42 to 0.69) |
| | Pilot byway model | 0.70 (0.58 to 0.81) |
| | Logistic on driver scores | 0.76 (0.65 to 0.87) |

1. **The app's curve measure is a good driving-road detector.** On its own it says which roads drivers talk about
   (0.84) better than official byway status does (0.73), and a full model adds nothing over it. This is the validated
   result: curves and relief, measured from map data, find the roads drivers care about.
2. **What separates great from fine isn't captured yet.** Among roads drivers discuss, curves don't separate 4s and 5s
   from 3s, and the driver-trained model's lead over the byway model is inside the noise (27 negatives). The weights
   hint that drivers favour high relief, the twistiest part of a stretch and paved roads, but that's a hint, not a
   finding.
3. **Candidates.** The highest scoring stretches with no driver talk found include Cucharas Pass on the Highway of
   Legends, Dallas Divide, CO 90 to Paradox, and Turkey Creek Canyon on US 285. Trail Ridge Road also appears there,
   which shows that some "silent" stretches are search misses, not unknown roads.

## Plan

1. **Use the detector now.** Curves plus relief is simple and validated: score every highway stretch in a region and
   export the top ones as a `road-points.json`-style list, so "Roads near me" works where there's no catalog.
2. **Sharper labels.** Count a verdict only when its evidence names a place on the stretch (cuts spillover), and
   search more low-scoring stretches to get more negatives. Fine grading needs about 100 stretches drivers rate 3 or
   below, against 27 now.
3. **More regions, and the headline test.** California, the Alps, Scotland and Norway, about 250 searches each (a
   month's free searches covers three to four regions). Train on three, test on the fourth. If the detector holds
   across regions, it's useful worldwide.
4. **Features that transfer.** Relative terrain (relief, height above the valley floor) over absolute height, plus
   scenery from OpenStreetMap (coast, lakes, forest, protected areas) for the scenery score.

Everything uses free, keyless data (Overpass, AWS terrain tiles). The limit is Overpass on large areas, so fetch big
regions as several boxes.
