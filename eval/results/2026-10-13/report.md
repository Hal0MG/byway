# Planner eval: 2026-10-13

30 trip requests (eval/prompts.json), 3 models. Intervals are 95% bootstrap intervals over the requests; with ~30 requests they're wide, so read differences under ~15 points as noise.

## Trips that pass, stage by stage

| Stage | gemini-3.1-flash-lite | gemini-flash-latest | gemini-flash-lite-latest |
|---|---|---|---|
| Model's first answer passes the plan checks | 96% (89 to 100) | 100% (100 to 100) | 96% (88 to 100) |
| After the model's one repair | 100% (100 to 100) | 100% (100 to 100) | 100% (100 to 100) |
| ... and once routed, every featured road is driven and no day runs long | 37% (19 to 56) | 60% (20 to 100) | 42% (23 to 62) |
| After the road pass (points added on undriven roads) | 41% (22 to 59) | 60% (20 to 100) | 62% (42 to 81) |
| After the day-split DP (overnights moved) | 52% (33 to 70) | 100% (100 to 100) | 69% (50 to 85) |
| ... and no backtracking left (20+ km) and no stops outside coverage | 48% (30 to 67) | 100% (100 to 100) | 65% (46 to 85) |

## Metrics

| Metric | gemini-3.1-flash-lite | gemini-flash-latest | gemini-flash-lite-latest |
|---|---|---|---|
| Requests that failed (error, quota, routing) | 10% (0 to 20) | 62% (31 to 85) | 13% (3 to 27) |
| Plan problems in the first answer (mean) | 0.04 (0.00 to 0.11) | 0.00 (0.00 to 0.00) | 0.04 (0.00 to 0.12) |
| Plan problems left after the repair (mean) | 0.00 (0.00 to 0.00) | 0.00 (0.00 to 0.00) | 0.00 (0.00 to 0.00) |
| Asked day count kept | 100% (100 to 100) | 100% (100 to 100) | 100% (100 to 100) |
| Featured roads that are real catalog roads | 94% (87 to 99) | 73% (53 to 93) | 97% (92 to 100) |
| Featured roads driven, as planned | 66% (51 to 81) | 100% (100 to 100) | 79% (70 to 89) |
| Featured roads driven, after the road pass | 69% (53 to 83) | 100% (100 to 100) | 90% (83 to 97) |
| Trips with a long day, as planned | 19% (4 to 33) | 40% (0 to 80) | 19% (4 to 35) |
| Trips with a long day, after the day split | 4% (0 to 11) | 0% (0 to 0) | 12% (0 to 27) |
| Longest day, hours (mean over trips, final) | 4.8 (4.1 to 5.6) | 5.4 (4.3 to 6.4) | 5.3 (4.5 to 6.4) |
| Share of the distance on featured roads | 26% (17 to 36) | 27% (19 to 38) | 37% (29 to 46) |
| Points where the route-aware geocode beat the top result | 13% (8 to 18) | 7% (1 to 13) | 13% (9 to 18) |
| Trips the backtracking fix reordered | 15% (4 to 30) | 20% (0 to 60) | 27% (12 to 46) |
| Trips with detour points dropped | 19% (4 to 33) | 20% (0 to 60) | 19% (4 to 35) |
| Plan time, median seconds (includes busy retries) | 7 | 142 | 4 |

## What the plan checks found in first answers

| Problem | gemini-3.1-flash-lite | gemini-flash-latest | gemini-flash-lite-latest |
|---|---|---|---|
| day count | 0 | 0 | 0 |
| day ends away from its overnight | 1 | 0 | 1 |
| loop doesn't end at the start | 0 | 0 | 0 |
| featured road with no point on it | 0 | 0 | 0 |
| copied example place | 0 | 0 | 0 |
| day numbering or missing day | 0 | 0 | 0 |
| too many points | 0 | 0 | 0 |

## Per request

| Request | gemini-3.1-flash-lite | gemini-flash-latest | gemini-flash-lite-latest |
|---|---|---|---|
| us-pch | ok | ok | ok |
| us-utah | ok | ok | ok |
| us-blueridge | undriven: Skyline Drive, Blue Ridge Parkway | ok | ok |
| us-colorado | ok | error: The AI couldn't answer, please try again | ok |
| us-newengland | undriven: Connecticut River Byway | error: routing: Could not find routable point w | ok |
| us-yellowstone | ok | ok | ok |
| us-texas | undriven: Twisted Sisters, Ross Maxwell Scenic Drive | ok | ok |
| us-route66 | ok | error: The AI couldn't answer, please try again | ok |
| us-pnw | ok | error: The AI couldn't answer, please try again | ok |
| ca-rockies | undriven: Bow Valley Parkway | error: The AI couldn't answer, please try again | ok |
| ca-cabot | error: routing: Add at least two stops to find  | error: The AI couldn't answer, please try again | undriven: Cabot Trail; backtrack 82 km |
| ca-bc | ok | error: The AI couldn't answer, please try again | ok |
| au-gor | 2 outside coverage | error: The AI couldn't answer, please try again | 1 outside coverage |
| au-tas | error: routing: Add at least two stops to find  |  | ok |
| au-qld | undriven: Mount Glorious Road, Blackall Range Tourist Drive |  | undriven: Blackall Range Tourist Drive |
| nz-south | ok |  | 2 long days (max 10.6 h) |
| nz-north | undriven: Thermal Explorer (Rotorua to Taupō) |  | ok |
| uk-nc500 | ok |  | ok |
| uk-wales | undriven: Llanberis Pass, Black Mountain Pass |  | ok |
| alps-swiss | ok |  | ok |
| alps-dolomites | ok |  | ok |
| alps-france | undriven: Col de la Bonette |  | undriven: Col de la Bonette |
| no-fjords | undriven: Aurlandsvegen |  | undriven: Aurlandsvegen |
| no-lofoten | 1 long day (max 10.5 h) |  | 2 long days (max 12.9 h) |
| is-ring | error: routing: fetch failed |  | undriven: East Fjords Road; 2 outside coverage |
| ie-wild | undriven: The Burren |  | undriven: Gap of Dunloe, Healy Pass, Ring of Beara; 1 long day (max 9.5 h) |
| ie-north | undriven: Inishowen 100; backtrack 111 km |  | error: routing: Add at least two stops to find  |
| es-picos | ok |  | error: routing: Add at least two stops to find  |
| es-andalusia | ok |  | error: routing: Add at least two stops to find  |
| pt-douro | undriven: Douro Valley, Alto Douro wine region, Monsanto and the historic villages, Costa Vicentina, Arrábida; backtrack 132 km |  | error: routing: Add at least two stops to find  |
