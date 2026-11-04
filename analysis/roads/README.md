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

## California: the held-out test (2026-11-03)

Colorado can't say whether the detector works anywhere else, so California was labelled the same way: 250 stretches
searched (100 from the top of the Colorado detector's scores, 100 from the middle, 50 from the bottom, because the
byway model has too few California byways to spread the sample), 142 with driver talk. That's another 250 of the
month's 1,000 free searches.

```bash
python analysis/roads/fetch_osm.py US-CA                  # 426,000 road ways, ~5 min
python analysis/roads/build_segments.py US-CA && python analysis/roads/add_elevation.py US-CA
python analysis/roads/stretches.py US-CA --detector       # 250 picks, spread over the Colorado detector's scores
python analysis/roads/label_drivers.py US-CA              # 1 search + 1 Gemini answer each
python analysis/roads/transfer_test.py US-CO US-CA --grounded   # train on one region, test on the other
```

**The labels needed a fix first.** The first run scored flat Central Valley roads 5 out of 5 ("CA 33 Ahern Road,
Tracy to Patterson", "Lost Hills Road"). Gemini had read praise for the famous mountain part of CA 33 and CA 36 and
credited it to flat stretches that share the route number ("CA 36 is 150 miles of twists" landed on "Road 36" near
Tulare). Colorado had the same problem on a smaller scale (CO 82). So a verdict now counts only when the search results
name a place on the stretch (its pass, an end town, its own name): 85% of California's verdicts pass, 93% of
Colorado's. Verdicts that fail are dropped, not counted as "no talk".

**Results**, with 95% bootstrap intervals, on verdicts that pass that check:

| | Train on Colorado, test on California | Train on California, test on Colorado |
|---|---|---|
| Do drivers write about the stretch? Detector | **0.77** (0.71 to 0.83) | **0.85** (0.80 to 0.89) |
| ... curves per km alone | 0.76 (0.69 to 0.82) | 0.85 (0.79 to 0.89) |
| ... relief alone | 0.75 (0.68 to 0.81) | 0.84 (0.78 to 0.88) |
| ... precision at the 0.57 threshold, recall | 75%, 78% | 79%, 49% |
| Among those, do drivers rate it 4 or 5? Detector | 0.68 (0.53 to 0.81) | 0.66 (0.53 to 0.78) |

1. **The detector transfers, both ways.** Against Colorado's own held-out 0.83, training on Colorado and testing on California loses about 0.06
   and the other direction matches it, and in California the share of stretches drivers write about climbs
   with the score: 19% below 0.25, 34% from 0.25 to 0.57, 75% above 0.57.
2. **Telling great from good still doesn't work.** For "rated 4 or 5" the intervals run from about 0.53 to 0.8, so
   they can't be told apart from a weak signal. There are only 23 to 27 low-rated stretches in each region, and people
   mostly write about roads they like.
3. **Relief matters most, in both regions.** Its weight is 0.93 in Colorado and 0.79 in California. Curves per km weigh
   0.74 in Colorado and 0.25 in California, where nearly every road in the sample curves, so curves separate less. A
   detector trained on one region leans on the one that separates there, which is the argument for pooling.
4. **Both regions are US, English and mostly motorcycle-forum talk.** This isn't yet a test of a different road
   culture; the Alps (Italy, France, Switzerland) would be.

**Pooled.** The app's weights come from both regions together: 462 labelled stretches, ROC AUC 0.79 on held-out map
areas. Precision plateaus at 76 to 78% and never reaches the 80% Colorado showed alone, so the app's "Drivers' road"
threshold is the lowest score that keeps 75% (0.56; it finds 61% of the stretches drivers write about). With one fit
for both regions there's no held-out number left for it, so the two directions above are the evidence.

## In the app: "Roads near me" (2026-11-03)

```bash
python analysis/roads/export_detected.py US-CO US-CA   # fits the detector, writes public/detected-roads.json and public/driving-score.json
```

The detector is a logistic regression on curves per km and relief only (the two features that carried it), trained on
whether drivers write about a stretch, in both regions together. A stretch is exported when its score clears the
threshold that keeps 75% precision on held-out labelled stretches, or when drivers rated it 4 or 5. Left out: stretches
drivers rated 3 or below, mostly unpaved ones, forest and county roads unless drivers rated them 4 or 5 and didn't call
them unpaved (gravel often has no surface tag), roads the hand-picked list already has, and every kind of road that
wasn't searched. Only state and US highways, pass roads and byways are exported, because the precision figure says
nothing about local roads (an early export that included them listed 496 roads, most of them back roads nobody had
checked). Neighbouring stretches of a road join into one entry. That's 221 roads: 51 in Colorado and 170 in
California, 113 of them with driver ratings of 4 or 5, and the rest found from the map data alone.

"Roads near me" lists them in their own section, "more found from map data", below the hand-picked roads, with what the
measurements say and, where there is one, a driver quote. Weekend loops use hand-picked roads only. Measured from San
Francisco: 6 hand-picked roads and 72 found ones within 5 hours (Highway 35 over Saratoga Gap, Woodside Road, Old Santa
Cruz Highway over Patchen Pass and Silverado Trail, among others).

**Caveat.** About a quarter of the roads found from map data alone will be wrong, and gravel can slip through when
OpenStreetMap has no surface tag. The section tells the traveler to check before committing.

## In the app: road cards and a plan check (2026-11-03)

The detector's weights go to `public/driving-score.json` (written by `export_detected.py`), and the app applies them to
every featured road as the route drives it: curves per km (the number the road card already shows) and the biggest
climb inside any 5 km (`windowRelief` and `drivingScore` in `public/logic.js`, with tests).

- **Road cards** show a gold "Drivers' road" chip when the score clears the 75%-precision threshold.
- **A plan check.** A road that isn't an official byway, that the route drives for 8 km or more, and that scores below
  the median of the stretches nobody writes about, gets a note on its card: "Measured on this route it's mostly
  straight and flat, so it may be a road for the views more than the drive", with the existing "Swap for another
  road" button. Official byways are left alone, since they're chosen for scenery and history.

**A check on the world.** The 74 ready-made trips have 180 featured roads on every continent, and none of them was in
the training data. Scored as the app measures them (in the page, trip by trip) with the pooled weights:

| | Roads | Examples |
|---|---|---|
| Score above the threshold (0.56) | 110 | Manali to Leh, Geiranger and the Eagle Road, Susten, Sea-to-Sky, Stelvio, Bernina, North Yungas Road, Bealach na Bà (0.94 to 0.99) |
| In between | 48 | |
| Below the weak line (0.28) | 22, of which 12 flagged (the rest are official byways, or under 8 km of the route) | Tamiami Trail, Florida Gulf Coast and Keys highways, Trans-Kalahari and Boteti Road in Botswana, Malaysia's North-South Expressway, NH 62 (under 100°/km, 4 to 30 m of climb in 5 km) |

The ranking matches what a driver would say: the famous mountain roads at the top, long flat plains and coastal
highways at the bottom, and for the Botswana road the AI's own write-up says "Straight, flat, and lightly
trafficked". That's a check by reading the list, not a measured accuracy: those roads have no driver ratings. The
measured evidence is the California test above, which is two US regions.

**Limits.** Scores say how much a road curves and climbs, nothing about scenery, so a flat coastal road gets flagged
(Shark Bay Road is one) when it may be exactly what the traveler wants, which is why the note is worded as a maybe and
official byways are exempt. The Botswana roads are on the list because it's a Top Gear route, not because anyone
chose them for the driving. A road can appear on the card several times (one note per day). Surface isn't in the
score, so a gravel road can score as a good drive.

## The Alps: the held-out test that failed (2026-11-04)

Region: Switzerland, Tyrol and Vorarlberg, Lombardy and South Tyrol, Savoie, Haute-Savoie and Hautes-Alpes. 209
labelled stretches, searched in German, Italian and French. The detector was trained on Colorado and California and
frozen, then scored the Alpine stretches (`python analysis/roads/transfer_test.py US-CO,US-CA EU-AL --grounded`).

| Question | Colorado to California | US to Alps |
| --- | --- | --- |
| Do drivers write about it? ROC AUC | 0.77 to 0.85 | **0.63** (0.55 to 0.71) |
| Precision at the app's threshold | about 75% | **43%** (recall 91%) |
| Rated 4 or 5 among those discussed, AUC | 0.66 to 0.68 | 0.46 (no signal) |

So the detector does not transfer. `diagnostics.py` checks why, using the labels already collected:

- **Little signal inside the Alps either.** Trained and tested within the Alps (blocked by map area), AUC is 0.64 to 0.66,
  and leaving one region out gives similar numbers. Curves and relief barely separate Alpine roads because nearly all
  of them curve and climb (range restriction).
- **Label coverage differs by country.** Share of stretches with driver talk: France 46%, Austria 41%, Switzerland 36%,
  Italy 26% (against 47% Colorado, 53% California). Part of "no talk" in Italy is a search miss, not a dull road.
- **Tunnels and expressways** (6 of 209) climb and curve little but are not the cause: 17% talk against 37%.
- More features (road class, speed, junctions, surface, straightness) do not rescue it.

**Decision.** The Alps are not added to the weights and no Alpine roads are exported to `detected-roads.json`. The app
shows the "Drivers' road" chip only in countries listed in `validatedIn` in `public/driving-score.json` (US). The weak-road
note stays global because it states a plain fact (mostly straight and flat), not a prediction of what drivers love.

A negative result is still a result: it says the score measures "twisty and steep compared with a typical US road",
which is what drivers write about in the US, and says nothing about regions where every road is twisty. Fixing that
would need relative features (how much a road beats its neighbours) and a label that isn't search-hit rate.

## Plan

1. **A region with a different road culture.** Done for the Alps (above): it failed, so the chip stays US-only. Next try
   relative features (a road against its neighbours) before spending more searches; add a country to `validatedIn` only
   after a held-out test passes.
2. **Sharper labels.** Search more low-scoring stretches to get more negatives (fine grading needs about 100 stretches
   drivers rate 3 or below, against 50 across both regions now), and check the place-name test by hand on a sample.
3. **Features that transfer.** Surface (so gravel stops scoring as a good drive) and scenery from OpenStreetMap (coast,
   lakes, forest, protected areas) for a scenery score, and relative terrain (height above the valley floor).
4. **Let the planner use it.** Hand the AI a shortlist of detected roads for the region while it plans, so its featured
   roads come from roads drivers write about instead of from the model's memory.

Everything uses free, keyless data (Overpass, AWS terrain tiles). The limits are Overpass on large areas (California
took about 5 minutes in one request) and 1,000 free Tavily searches a month: Colorado and California used 498.
