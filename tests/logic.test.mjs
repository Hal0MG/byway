// Tests for the trip logic that runs without a page: splitting a trip into days, map-link parts, following a road's
// shape, and the server's plan checks. Run with `npm test` (no app running, no network).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

// public/logic.js is a plain browser script; load it the way a page would and take what it exports for Node
const sandbox = { module: { exports: {} }, URLSearchParams };
vm.runInNewContext(fs.readFileSync(new URL("../public/logic.js", import.meta.url), "utf8"), sandbox);
const L = sandbox.module.exports;
// arrays made inside the sandbox compare by value here
const plain = (x) => JSON.parse(JSON.stringify(x));

process.env.BYWAY_TEST = "1";
const S = await import("../server.js");

test("haversine: a degree of latitude is about 111 km", () => {
  assert.ok(Math.abs(L.haversine([0, 0], [0, 1]) - 111195) < 50);
});

test("bestSplit: the longest day is as short as it can be", () => {
  // legs into points 1..5 of 2, 2, 2, 2, 2 hours: two days of 4 and 6, or 6 and 4
  const h = (x) => x * 3600;
  const r = L.bestSplit([0, h(2), h(2), h(2), h(2), h(2)], [false, false, false, false, false, false], 2);
  assert.equal(r.worst, h(6));
  assert.equal(r.ends.at(-1), 5);
});

test("bestSplit: sleeps at a real stop when a via costs more than 15 minutes of the longest day", () => {
  const h = (x) => x * 3600;
  // the even split ends day 1 at point 2, a via; point 1 (a stop) makes the long day only 10 min longer
  const legs = [0, h(3), h(10 / 60) + h(0.1), h(3)];
  const r = L.bestSplit(legs, [false, false, true, false], 2);
  assert.equal(r.ends[0], 1);
});

test("bestSplit: impossible splits give null", () => {
  assert.equal(L.bestSplit([0, 1, 1], [false, false, false], 3), null);
  assert.equal(L.bestSplit([0, 1, 1], [false, false, false], 0), null);
});

test("linkParts: one link up to 10 places, then parts that share their ends", () => {
  const ten = [...Array(10).keys()];
  assert.deepEqual(plain(L.linkParts(ten)), [ten]);
  const thirteen = [...Array(13).keys()];
  const parts = L.linkParts(thirteen);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].at(-1), parts[1][0]); // part 2 starts where part 1 ends
  assert.ok(parts.every((p) => p.length <= L.LINK_PLACES));
  assert.deepEqual(plain([...new Set(parts.flat())]), thirteen); // nothing dropped
  for (const n of [11, 19, 20, 37]) {
    const ps = L.linkParts([...Array(n).keys()]);
    assert.ok(ps.every((p) => p.length <= 10 && p.length >= 2), `${n} places`);
    assert.equal(new Set(ps.flat()).size, n);
  }
});

test("mapLinksFor: Google path and Apple waypoints in order", () => {
  const l = L.mapLinksFor(["1,2", "3,4", "5,6"]);
  assert.match(l.google, /\/maps\/dir\/1,2\/3,4\/5,6\//);
  assert.match(l.apple, /source=1%2C2&destination=5%2C6&mode=driving&waypoint=3%2C4/);
});

test("alongShape: a stretch on the road's shape counts, a parallel road 2 km away doesn't", () => {
  const shape = Array.from({ length: 20 }, (_, i) => [-78.3 + i * 0.01, 38.7]);
  const on = Array.from({ length: 30 }, (_, i) => [-78.3 + i * 0.006, 38.7005]);
  const off = on.map(([x, y]) => [x, y + 0.02]);
  assert.equal(L.alongShape(on, shape), true);
  assert.equal(L.alongShape(off, shape), false);
  assert.ok(L.distToSegment([0, 0.001], [-0.01, 0], [0.01, 0]) < 120);
});

test("requestedDays reads numbers and words", () => {
  assert.equal(S.requestedDays("Denver to Moab in 3 days"), 3);
  assert.equal(S.requestedDays("a five-day loop"), 5);
  assert.equal(S.requestedDays("two weeks in the Rockies"), 14);
  assert.equal(S.requestedDays("Seattle to San Diego"), 0);
});

test("samePlace: a part of one name is the other's town", () => {
  assert.ok(S.samePlace("Milepost 382, Asheville, NC", "Asheville, North Carolina"));
  assert.ok(!S.samePlace("Moab, Utah", "Green River, Utah"));
});

const plan = (over = {}) => ({
  title: "Denver to Moab",
  days: [{ day: 1, overnight: "Ouray, Colorado" }, { day: 2, overnight: "Moab, Utah" }],
  points: [
    { name: "Denver, Colorado", kind: "stop", day: 1, road: "" },
    { name: "Red Mountain Pass, Colorado", kind: "via", day: 1, road: "US 550" },
    { name: "Ouray, Colorado", kind: "stop", day: 1, road: "" },
    { name: "Moab, Utah", kind: "stop", day: 2, road: "" },
  ],
  roads: [{ name: "Million Dollar Highway", ref: "US 550", days: [1] }],
  ...over,
});

test("checkPlan: a good plan passes", () => {
  assert.deepEqual(S.checkPlan(plan(), { prompt: "Denver to Moab in 2 days via Ouray" }), []);
});

test("checkPlan: wrong day count, a day not ending at its overnight, a road with no point on it", () => {
  const p = plan({ roads: [{ name: "Million Dollar Highway", ref: "US 550", days: [1] }, { name: "Colorado National Monument", ref: "", days: [2] }] });
  p.points[2].name = "Silverton, Colorado";
  const issues = S.checkPlan(p, { prompt: "Denver to Moab in 3 days" });
  assert.ok(issues.some((x) => /asked for 3 days/.test(x)));
  assert.ok(issues.some((x) => /Day 1's last stop is "Silverton/.test(x)));
  assert.ok(issues.some((x) => /Colorado National Monument" has no point/.test(x)));
});

test("checkPlan: a loop must end where it starts; copied instruction examples are caught", () => {
  const p = plan({ title: "Moab loop over Tioga Pass" });
  const issues = S.checkPlan(p, { prompt: "a loop from Denver in 2 days", loop: true });
  assert.ok(issues.some((x) => /loop, so it must end where it starts/.test(x)));
  assert.ok(issues.some((x) => /"Tioga Pass" \(in California\)/.test(x)));
});

test("partialJson: the answer so far, up to the last closed object", () => {
  const out = S.partialJson('{"title":"Trip","days":[{"day":1,"overnight":"A"},{"day":2,"over');
  assert.equal(out.title, "Trip");
  assert.equal(out.days.length, 1);
});

test("routePieces: long routes in pieces that share their ends", () => {
  const coords = Array.from({ length: 100 }, (_, i) => [i * 0.01, 0]);
  const pieces = S.routePieces(coords);
  assert.ok(pieces.length >= 3);
  pieces.slice(1).forEach((p, k) => assert.equal(p[0], pieces[k][1]));
  assert.equal(pieces.at(-1)[1], 99);
});

// matchRoad and refParts live in itinerary.js with the page code; the two functions are taken out and run alone
const itin = fs.readFileSync(new URL("../public/itinerary.js", import.meta.url), "utf8");
const roadCtx = {};
vm.runInNewContext(itin.slice(itin.indexOf("function refParts"), itin.indexOf("// The days a featured road is on")) + "\nthis.matchRoad = matchRoad;", roadCtx);
test("matchRoad: road numbers as each country's map writes them", () => {
  const seg = (ref, name = "") => ({ refs: ref ? [ref] : [], name });
  const hit = (s, ref, name = "x") => !!roadCtx.matchRoad(s, [{ name, ref }]);
  assert.ok(hit(seg("Hwy 63"), "Fv63")); // Norway: OpenStreetMap's bare "63"
  assert.ok(hit(seg("Hwy 1"), "1")); // Iceland's Ring Road
  assert.ok(hit(seg("Hwy 35"), "F35"));
  assert.ok(hit(seg("E 10"), "E10"));
  assert.ok(hit(seg("Hwy 99"), "BC 99")); // Canada
  assert.ok(hit(seg("US 89"), "US 89"));
  assert.ok(hit(seg("", "Going-to-the-Sun Road"), "", "Going-to-the-Sun Road"));
  assert.ok(!hit(seg("Hwy 63"), "N63")); // an Irish N road isn't a bare number
  assert.ok(!hit(seg("US 89"), "US 191"));
});

test("route lines packed for storage come back the same, to about a metre", () => {
  const coords = [[-122.408337, 37.787825, 49], [-122.40812, 37.78801, 49.4], [-122.40812, 37.78801, 49.4], [7.6862, 62.5677, -3.2], [-179.99, -45.1, 1203]];
  const back = S.decodeLine(S.encodeLine(coords));
  assert.equal(back.length, coords.length); // every point kept, so leg indexes still hold
  back.forEach((p, i) => {
    assert.ok(Math.abs(p[0] - coords[i][0]) < 1e-5 && Math.abs(p[1] - coords[i][1]) < 1e-5);
    assert.ok(Math.abs(p[2] - coords[i][2]) < 0.06);
  });
  const flat = [[1.5, 2.5], [1.6, 2.4]];
  assert.equal(JSON.stringify(S.decodeLine(S.encodeLine(flat))), JSON.stringify(flat));
  const routes = { scenic: { distance_m: 5, geometry: { type: "LineString", coordinates: coords } }, fastest: null };
  const packed = S.packRoutes(routes);
  assert.ok(packed.scenic.geometry.packed && !packed.scenic.geometry.coordinates);
  assert.equal(packed.scenic.distance_m, 5);
  assert.equal(S.unpackRoutes(packed).scenic.geometry.coordinates.length, coords.length);
  assert.equal(S.unpackRoutes(routes).scenic.geometry.coordinates, coords); // old trips pass through
});

test("osrmResult builds each leg's roads (the backup router needs roadsFromSteps and parseRoadName)", () => {
  const step = (name, ref, coords, d) => ({ name, ref, distance: d, duration: d / 20, geometry: { coordinates: coords }, intersections: [] });
  const route = {
    distance: 3000, duration: 150,
    legs: [{ distance: 3000, duration: 150, steps: [
      step("Main Street", "", [[-105, 39.7], [-105, 39.71]], 1000),
      step("", "CO 88", [[-105, 39.71], [-105.01, 39.72]], 2000),
    ] }],
  };
  const r = S.osrmResult(route);
  assert.equal(r.engine, "osrm");
  assert.equal(r.legs.length, 1);
  assert.ok(r.legs[0].roads.length >= 2);
  assert.equal(r.legs[0].roads[1].ref, "CO 88");
});
