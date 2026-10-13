# Planner eval

How good are the AI's trip plans, and how much does each part of the app's pipeline fix? This folder holds a fixed set
of trip requests and the results of running them.

- `prompts.json`: 30 requests across every covered region (US, Canada, Australia, New Zealand, UK, the Alps, Norway,
  Iceland, Ireland, Spain, Portugal), 2 to 8 days, one-way and loops.
- `results/<run>/<model>.jsonl`: one record per request: the plan checks before and after the model's repair, geocoding,
  dropped detours, the backtracking fix, featured roads driven before and after the road pass, long days before and
  after the day split, distance, timing.
- `results/<run>/report.md`: the summary.

Run it with the app running and Gemini set up (each request takes about a minute; nothing is saved):

```bash
CHROME_PATH=<chrome-headless-shell> npm run eval -- --models gemini-flash-lite-latest,gemini-flash-latest
```

```bash
npm run eval:report -- eval/results/<run>
```

`--only id1,id2` runs some requests, `--repeat n` runs each n times (the model isn't deterministic). Running again into the same folder resumes: finished requests are kept, failed ones run again.

**The stages.** A trip passes a stage when everything up to it holds: the model's first answer passes the plan checks;
after its one repair; once routed, every featured road is driven and no day is over the daily limit; after the road
pass; after the day split; and finally no backtracking of 20 km or more and no stop outside the covered areas. Each
step up the table is what that part of the pipeline adds.

**Caveats.** About 30 requests, so the 95% intervals (bootstrap over requests) are wide. Routes come from whichever
router answers (OpenRouteService, or OSRM when it's out of quota), which changes drive times a little. The eval stops
before the AI's own rebalance of long days, the day guides and the photos. Busy answers from Google are retried for
up to 3.5 minutes per request and then recorded as errors.
