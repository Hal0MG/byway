// "How it works, in depth": the technical version of the How it works page, for readers who want the methods (written
// for a data science student). Each section is the problem, the method, the math where there is some, and why that
// choice. Numbers here are the ones in the code (logic.js, app.js, features.js, server.js); keep them in step.

const DEEP_FLOW = [
  ["Prompt", "text + options"],
  ["Plan", "LLM, JSON Schema"],
  ["Check", "rules, one repair"],
  ["Geocode", "5 candidates each"],
  ["Decode", "Viterbi"],
  ["Clean", "detours, 2-opt"],
  ["Route", "ORS / OSRM"],
  ["Roads", "match + insert"],
  ["Split days", "DP"],
  ["Enrich", "heights, weather, POIs"],
  ["Guide", "LLM, streamed"],
];

// [id, title, html]
const DEEP_SECTIONS = [
  ["llm", "The planner: an LLM with a schema and a checker", `
    <p class="dp-q">Problem: language models write fluent plans with structural mistakes (seven days when you asked for six, a day that ends somewhere other than its overnight, a featured road no stop is on).</p>
    <p>The model never writes free text for the plan. Its output is bound to a <b>JSON Schema</b> (Gemini's <code>responseJsonSchema</code>, or <code>response_format: json_schema</code> for a local model in LM Studio), so decoding can only produce valid JSON with the expected fields: days, points (stop or via, day number, the road it's on), featured roads. Before this, Flash-Lite sometimes broke its JSON; with the schema, 5 of 5 test plans (including the 3 that had broken) parsed on the first try.</p>
    <p>Then a deterministic validator, <code>checkPlan</code>, tests the plan against rules the model is known to break:</p>
    <ul>
      <li>the day count matches what the prompt asked for (parsed from "7 days", "seven-day", "two weeks")</li>
      <li>each day's last stop is its overnight (fuzzy place matching: "Milepost 382, Asheville, NC" equals "Asheville")</li>
      <li>a loop ends where it starts; at most 9 points a day and 50 in all</li>
      <li>every featured road has at least one point whose <code>road</code> field names it (else a router will never drive it)</li>
      <li>no place names copied from the instructions' own examples into an unrelated trip</li>
    </ul>
    <p>The problems go back to the model as sentences, once. The repaired plan is kept only if it has <b>fewer</b> problems than the first: a greedy accept step, because a repair can also make things worse.</p>
    <p><b>Grounding.</b> The prompt carries a catalog of 399 real roads: the 184 US National Scenic Byways and All-American Roads (scraped from Wikipedia's table) and 215 hand-picked famous drives in the other countries, each checked against a Wikipedia article. A local model with a 32k context gets only the roads in the states it crosses: a cheap first call names the states, which acts as a retrieval step (Denver to Moab: 20 of 184 byways).</p>
    <p><b>Streaming.</b> The answer streams token by token. <code>partialJson</code> walks the text with a bracket stack, cuts at the last closed object or array and closes the open brackets, so the screen shows whole days and stops while the rest is still being written.</p>
    <div class="dp-nums"><span>busy retry after 8 s, then 20 s</span><span>3 fallback models</span><span>local model at temperature 0.3</span><span>~3 s per plan on Flash-Lite</span></div>`],

  ["geocode", "Place names to coordinates: decoding the most likely route", `
    <p class="dp-q">Problem: names are ambiguous. "Green River, Utah" is a town on I-70 and a river by Flaming Gorge; there are dozens of Springfields. Taking each top search result independently puts some stops hundreds of km off.</p>
    <p>Each point gets up to <var>k</var> = 5 candidates from OpenStreetMap's Nominatim. Choosing one per point is a <b>shortest path through a layered graph</b>, the same structure as Viterbi decoding in a hidden Markov model: the states are candidates, the transition cost is the great-circle distance between consecutive picks, and the emission cost is a penalty of 100 km for a candidate that isn't a settlement or landmark (rivers, lakes, administrative leftovers).</p>
    <div class="dp-math">C<sub>t</sub>(j) = min<sub>i</sub> [ C<sub>t−1</sub>(i) + d(c<sub>t−1,i</sub>, c<sub>t,j</sub>) ] + π(c<sub>t,j</sub>)</div>
    <p>Backtracking from the cheapest final state gives the whole route at once, in O(<var>n</var>·<var>k</var>²). The distance is the haversine formula on a sphere of radius 6,371 km:</p>
    <div class="dp-math">d = 2R · asin √( sin²(Δφ/2) + cos φ<sub>1</sub> cos φ<sub>2</sub> sin²(Δλ/2) )</div>
    <p>When every candidate is water, a second search restricted to settlements runs first. Results: Blue River, BC went from a match near the Yukon (a 3,918 km trip) to the right town; Green River resolves to 38.995, −110.162.</p>`],

  ["clean", "Cleaning the stop sequence: outliers and backtracking", `
    <p class="dp-q">Problem: small models place a via point far off the line between its neighbours, or visit stops in a zig-zag order (Sydney, the Snowy Mountains, back to the coast, then Melbourne).</p>
    <p><b>Outliers.</b> A via whose detour is more than max(60 km, 50% of the direct distance) is dropped, as is a point under 2 km from the one before it (except a repeated overnight, which is a rest day).</p>
    <div class="dp-math">detour = d(a, v) + d(v, b) − d(a, b) &gt; max(60 km, 0.5 · d(a, b))</div>
    <p><b>Order.</b> Reordering with a fixed start and end is a path version of the travelling salesman problem. The app runs local search to a local optimum: <b>2-opt</b> (reverse a run when that shortens the path) and <b>Or-opt</b> (move a run of 1 to 3 points elsewhere, in either direction), up to 40 passes. A new order is only accepted if it saves at least 8% <i>and</i> 40 km, so deliberate detours survive. That threshold trades recall for precision: a missed fix costs a little driving, a wrong one rewrites the traveler's trip. Days keep their overnight towns.</p>
    <div class="dp-nums"><span>Vancouver to Calgary: 345 km saved</span><span>NZ test: 324 km</span></div>`],

  ["route", "Routing and the route cache", `
    <p>Each trip is routed twice: the scenic route through every point, and the fastest route through the stops only, for comparison. OpenRouteService (a router on OpenStreetMap data) answers with the geometry as [lng, lat, height] triples, per-leg distances and times, road names and refs, and per-segment flags (freeway, toll, ferry, unpaved). When it's out of quota or down, the public OSRM servers answer instead and the response is converted to the same shape, so nothing downstream knows the difference. Very long trips go in pieces of up to ~4,000 km or 45 points, joined with their indexes shifted.</p>
    <p>Routes are cached on disk under a SHA-1 of the profile and the points rounded to 5 decimals (about 1 m), for 30 days. "Can't route there" answers are cached for a day; quota and network errors never. At most 400 files; every 25 writes the expired and the oldest past the limit are removed.</p>`],

  ["roads", "Is the featured road actually driven? Matching and insertion", `
    <p class="dp-q">Problem: the planner names Skyline Drive and puts its via points in Front Royal and Luray. The router then takes the faster valley road and the trip never drives Skyline Drive. An offline audit of the 35 ready-made trips found this in 19 of them.</p>
    <p><b>Matching.</b> Route segments are matched to featured roads by normalized ref ("US 50", "AB 93", "B100", "Fv63", "E 10" all parse into a type and a number, with per-country rules) or by name. Many park roads have no name in the routing data, so a stretch also counts if it follows the road's shape from OpenStreetMap: up to 12 samples along the stretch, and at least 70% of them within 250 m of the road's polyline.</p>
    <div class="dp-math">share = (1/m) Σ<sub>k</sub> 1[ dist(p<sub>k</sub>, shape) &lt; 250 m ] ≥ 0.7</div>
    <p>Point-to-segment distance uses a local equirectangular projection (x scaled by cos φ), which is accurate to well under 1% at these distances and much cheaper than geodesics.</p>
    <p><b>Insertion.</b> A road driven for under 5 miles gets points sampled from its OSM geometry (the copy nearest the plan's own points on it: there are Skyline Drives in Virginia, near Asheville and in Tennessee). They're inserted with the <b>cheapest insertion</b> heuristic: the gap between consecutive stops, and the direction, that adds the least distance.</p>
    <div class="dp-math">Δ = d(a, r<sub>1</sub>) + L(r) + d(r<sub>m</sub>, b) − d(a, b)</div>
    <div class="dp-nums"><span>Skyline Drive: 0 → 97 km driven</span><span>Trollstigen: 0 → 69 km</span></div>`],

  ["days", "Splitting the trip into days: an exact DP", `
    <p class="dp-q">Problem: given the measured drive time of each leg, choose where to sleep so that the longest day is as short as possible.</p>
    <p>This is the <b>linear partition</b> problem. With S the prefix sums of leg times and a 15-minute penalty for sleeping at a via point rather than a real stop:</p>
    <div class="dp-math">f(d, i) = min<sub>k&lt;i</sub> max( f(d−1, k), S(i) − S(k) + p·1[i is a via] )</div>
    <p>Filled in O(<var>D</var>·<var>n</var>²) and backtracked, it's exact, so it runs before any AI is asked. If the trip has no requested day count it tries up to two extra days. Only when no split fixes the long days does the AI rebalance (moving overnights first, then trimming extras, keeping every named place), at most two rounds, kept only while each one helps.</p>`],

  ["terrain", "Elevation: signal processing on noisy heights", `
    <p class="dp-q">Problem: summing every rise in raw elevation data massively overstates climbing. ORS's own total for Vancouver to Calgary was 26,700 m, because each 30 m height cell next to a cliff road adds a bump.</p>
    <ol>
      <li><b>Resample by arc length.</b> Route vertices are irregular (dense in curves, sparse on straights), so heights are sampled every 100 m along the line.</li>
      <li><b>Smooth.</b> A centered moving average over ±200 m.</li>
      <li><b>Hysteresis.</b> Climbing counts only once the height moves 3 m past the last reference, which removes the remaining jitter.</li>
      <li><b>Steepest km.</b> Two pointers slide a 1 km window along the samples; the largest |Δh|/run is the steepest grade.</li>
    </ol>
    <div class="dp-math">ẽ<sub>i</sub> = (1 / (2w+1)) Σ<sub>j=−w…w</sub> e<sub>i+j</sub>,&nbsp;&nbsp; climb += ẽ − ref when ẽ − ref &gt; 3 m</div>
    <p>Backup routes have no heights, so they come from Open-Meteo's elevation API, which counts every point as a request. That needed a budget: at most ~300 samples a route, a cache keyed to ~100 m cells (kept a year), and 1,500 points an hour, 3,000 a day.</p>`],

  ["curves", "How twisty is a road? A curvature metric", `
    <p>Each road gets a rating from its driven geometry: total absolute heading change per km, a discrete version of integrating |curvature| along the path. Segments under 4 m are ignored (noise in the vertices). A hairpin is a cumulative signed turn of 150° or more within 250 m.</p>
    <div class="dp-math">κ̄ = Σ<sub>i</sub> |Δθ<sub>i</sub>| / L&nbsp;&nbsp;(degrees per km)</div>
    <p>It depends on how densely the router draws curves, so it was calibrated on known roads rather than in theory, and the five levels sit on a roughly log scale (40, 100, 200, 400°/km):</p>
    <table class="dp-table"><thead><tr><th>Road</th><th>°/km</th></tr></thead><tbody>
      <tr><td>Icefields Parkway</td><td>28</td></tr>
      <tr><td>An interstate across Nevada</td><td>~30</td></tr>
      <tr><td>Sea-to-Sky Highway</td><td>98</td></tr>
      <tr><td>Big Sur, Highway 1</td><td>~210</td></tr>
      <tr><td>Beartooth Highway</td><td>~245</td></tr>
      <tr><td>Tail of the Dragon, US 129</td><td>~710</td></tr>
    </tbody></table>`],

  ["spatial", "Spatial queries", `
    <ul>
      <li><b>Which country a stop is in</b> (for units, currency and the road list): ray-casting point-in-polygon, first on the finer outlines of the regions with a curated road list (merged, then simplified with Turf, in that order or seams appear), then on all 239 countries. Simplified coasts cut off harbour towns, so a miss probes rings of 8 points ~5 and ~15 km around it. Results are memoized.</li>
      <li><b>Spots along the day.</b> Each sight is projected onto the day's line: nearest vertex (the line subsampled to at most 3,000), giving distance along and distance off. That orders the timeline and flags spots over 25 km off the route.</li>
      <li><b>Fuel gaps.</b> Stations are projected the same way; the longest gap between sorted positions is the warning.</li>
      <li><b>Points of interest.</b> Fuel, chargers, viewpoints and stays come from Overpass (OSM's query engine). Big "around the line" queries ran out of memory on the public servers, so the line is covered with 0.25° tiles (about 28 by 20 km), each cached 60 days and kept a year as a stale fallback when every server fails.</li>
      <li><b>Roads near me.</b> Drive time from home is estimated without routing: straight-line distance × 1.3 (a typical road circuity factor) at 80 km/h, plus 15 minutes. Roads on another landmass (Ireland from Wales, Tasmania) are filtered out.</li>
    </ul>`],

  ["time", "Weather, sun and time zones", `
    <p>Within 16 days the weather is Open-Meteo's forecast. Further out it's <b>climatology</b>: the mean of the same calendar dates over the last three years from the historical archive, labelled "typical". Forecasts are refreshed after 6 hours; typical values are kept.</p>
    <p>Sunrise, sunset and golden hour (sun 6° up) are computed locally with the NOAA solar equations (mean anomaly, equation of center, ecliptic longitude, declination, hour angle), accurate to about a minute, and shown in each place's IANA time zone, so the timeline can say "leave 8:00 AM PDT, arrive 8:28 PM MDT" and warn when a day ends after dark.</p>`],

  ["data", "Data sources, rate limits and caches", `
    <p>Everything runs on free, keyless or free-tier services, so most of the engineering is about being a polite client: rate limits, caches and fallbacks.</p>
    <table class="dp-table"><thead><tr><th>Source</th><th>Used for</th><th>Limits and caching</th></tr></thead><tbody>
      <tr><td>Gemini, or a local model</td><td>plans, day guides, answers</td><td>model fallbacks, busy retries, usage per model per day</td></tr>
      <tr><td>OpenRouteService</td><td>routes with heights</td><td>daily quota; 30-day route cache; rests 30 min after a refusal</td></tr>
      <tr><td>OSRM</td><td>backup routes</td><td>1 request a second; cached a day</td></tr>
      <tr><td>Nominatim</td><td>place search, road shapes</td><td>1 request a second, one queue for all devices; 30-day cache</td></tr>
      <tr><td>Overpass</td><td>fuel, chargers, sights, stays</td><td>3 servers in order, resting ones that refuse; 0.25° tile cache</td></tr>
      <tr><td>Wikipedia, Commons</td><td>photos, articles</td><td>serial queue 300 ms apart, pause after 429s; disk cache</td></tr>
      <tr><td>Open-Meteo</td><td>weather, heights</td><td>point budget per hour and day; caches</td></tr>
      <tr><td>Tavily (optional)</td><td>web search for the planner</td><td>monthly count, stops at 900 of 1,000</td></tr>
    </tbody></table>
    <p><b>Photos</b> are matched by place, not just by name: a geosearch within 3 km of a known location first, else a name search that drops photos located over 150 km from the day's stops, and an article found by search must share a distinctive word with the name.</p>`],

  ["eval", "Testing and evaluation", `
    <ul>
      <li><b>Unit tests</b> (<code>npm test</code>, 15 tests): the day-split DP, map-link splitting, shape matching, road-ref matching, the plan checks, the partial JSON parser, route chunking. The pure functions live in one file that both the browser and Node load.</li>
      <li><b>Smoke test</b> (<code>npm run smoke</code>): headless Chrome opens every view and sheet at desktop and phone sizes, and fails on console errors, sideways scrolling or covered map credits. axe-core checks contrast and accessibility (0 issues at WCAG AA).</li>
      <li><b>An offline eval of plan quality</b> (<code>tools/audit-trips.mjs</code>): runs the app's own measurements over all 35 ready-made trips and reports long and short days, featured roads not driven, backtracking the reorder would fix, spots far off the route, and missing heights and photos. It's what found the 19 trips with an undriven road.</li>
    </ul>
    <p><b>Honest limits.</b> Most thresholds (8% and 40 km, 250 m and 70%, the 100 km penalty, the curvature levels) were tuned by hand on a few dozen trips, not fitted on labelled data. There's no ground truth for "a good road trip", the LLM isn't deterministic, and the audit measures structure (is the road driven, is any day too long) rather than whether a person would enjoy the trip.</p>`],
];

function aboutDeepHtml() {
  return `<div class="ab dp">
    ${aboutModeHtml()}
    <header class="dp-head">
      <p class="kicker">${icon("gauge", 16)} How it works, in depth</p>
      <h1>Under the hood</h1>
      <p class="lede">A road trip planner is a small data pipeline: a language model proposes, and deterministic code checks, measures and repairs. Here is each step, the method behind it and the numbers it runs on.</p>
    </header>

    <ol class="dp-flow" aria-label="The planning pipeline">
      ${DEEP_FLOW.map(([a, b]) => `<li><b>${esc(a)}</b><span>${esc(b)}</span></li>`).join("")}
    </ol>

    <nav class="dp-toc" aria-label="Sections">
      ${DEEP_SECTIONS.map(([id, title], i) => `<a href="#dp-${id}" data-dp="${id}"><span>${i + 1}</span>${esc(title.split(":")[0])}</a>`).join("")}
    </nav>

    ${DEEP_SECTIONS.map(([id, title, html], i) => `<section class="dp-sec ab-in" id="dp-${id}">
      <h2><span class="dp-n">${i + 1}</span>${esc(title)}</h2>
      ${html}
    </section>`).join("")}

    <div class="ab-cta">
      <button class="btn blue" data-about="plan">${icon("sparkle", 18)} Plan a trip</button>
      <button class="btn" data-about="simple">Back to the overview</button>
    </div>
  </div>`;
}

// table of contents: scroll inside #about (its own scroller) instead of jumping the page's hash
$("about")?.addEventListener("click", (e) => {
  const a = e.target.closest("[data-dp]");
  if (!a) return;
  e.preventDefault();
  const sec = $(`dp-${a.dataset.dp}`);
  sec?.classList.add("shown");
  sec?.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
});
