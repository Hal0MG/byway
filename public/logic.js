// Pure helpers (no page, no map): distances, splitting a trip into days, map-link parts, following a road's shape.
// Loaded before app.js in the page, and by the tests in Node (tests/logic.test.mjs).

const MAX_LINK_STOPS = 8;

// Meters between two [lng, lat] points (great circle).
function haversine(a, b) {
  const R = 6371000;
  const r = Math.PI / 180;
  const x =
    Math.sin(((b[1] - a[1]) * r) / 2) ** 2 +
    Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(((b[0] - a[0]) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

// The best split of a route's legs into D days: L[i] is the drive into point i, via[i] whether point i is a via.
// Returns { ends: [last point of each day], worst: longest day in seconds } or null.
function bestSplit(L, via, D) {
  const n = L.length;
  if (D < 1 || D > n - 1) return null;
  const pre = [0];
  for (let i = 1; i < n; i++) pre[i] = pre[i - 1] + L[i];
  const span = (a, b) => pre[b] - pre[a];
  // f[d][i]: best cost with d days ending at point i; cost = longest day + 15 min per overnight at a via point
  const f = Array.from({ length: D + 1 }, () => new Array(n).fill(Infinity));
  const from = Array.from({ length: D + 1 }, () => new Array(n).fill(-1));
  f[0][0] = 0;
  for (let d = 1; d <= D; d++) {
    for (let i = d; i < n; i++) {
      if (d === D && i !== n - 1) continue;
      const pen = d < D && via[i] ? 900 : 0;
      for (let k = d - 1; k < i; k++) {
        if (f[d - 1][k] === Infinity) continue;
        const c = Math.max(f[d - 1][k], span(k, i) + pen);
        if (c < f[d][i]) [f[d][i], from[d][i]] = [c, k];
      }
    }
  }
  if (f[D][n - 1] === Infinity) return null;
  const ends = [];
  for (let d = D, i = n - 1; d > 0; i = from[d][i], d--) ends.unshift(i);
  let worst = 0;
  ends.forEach((e, d) => (worst = Math.max(worst, span(d ? ends[d - 1] : 0, e))));
  return { ends, worst };
}

const LINK_PLACES = MAX_LINK_STOPS + 2;
// Google and Apple links for places given as "lat,lng" strings, in order.
function mapLinksFor(lls) {
  const ap = new URLSearchParams({ source: lls[0], destination: lls.at(-1), mode: "driving" });
  lls.slice(1, -1).forEach((x) => ap.append("waypoint", x));
  return { google: `https://www.google.com/maps/dir/${lls.join("/")}/data=!4m2!4m1!3e0`, apple: `https://maps.apple.com/directions?${ap}` };
}
// More places than one link carries: parts of about equal size that meet at a shared place (the end of one is the
// start of the next), so every scenic via point reaches the phone instead of being thinned out.
function linkParts(items) {
  if (items.length <= LINK_PLACES) return [items];
  const n = Math.ceil((items.length - 1) / (LINK_PLACES - 1));
  const per = (items.length - 1) / n;
  return Array.from({ length: n }, (_, k) => items.slice(Math.round(k * per), Math.round((k + 1) * per) + 1));
}

// Whether a stretch of the route runs along a road's mapped shape (r.shape from /api/road-points): most of its points
// within 250 m. For roads the router has no name for (Skyline Drive, many park and pass roads).
function alongShape(coords, shape) {
  if (!shape?.length || coords.length < 2) return false;
  const near = (p) => {
    for (let k = 0; k < shape.length; k++) {
      if (haversine(p, shape[k]) < 250) return true;
      // between two shape points that belong to the same stretch (under 3 km apart)
      const q = shape[k + 1];
      if (q && haversine(shape[k], q) < 3000 && distToSegment(p, shape[k], q) < 250) return true;
    }
    return false;
  };
  const step = Math.max(1, Math.floor(coords.length / 12));
  let hit = 0;
  let n = 0;
  for (let k = 0; k < coords.length; k += step, n++) if (near(coords[k])) hit++;
  return hit / n >= 0.7;
}
// Meters from p to the segment a-b, on a local flat projection (fine at these distances).
function distToSegment(p, a, b) {
  const kx = 111320 * Math.cos((p[1] * Math.PI) / 180);
  const ky = 110540;
  const [px, py, ax, ay, bx, by] = [p[0] * kx, p[1] * ky, a[0] * kx, a[1] * ky, b[0] * kx, b[1] * ky];
  const dx = bx - ax;
  const dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

// In Node (the tests) the helpers are exported; in the page they're globals like the rest of the app.
if (typeof module !== "undefined") module.exports = { MAX_LINK_STOPS, LINK_PLACES, haversine, bestSplit, mapLinksFor, linkParts, alongShape, distToSegment };

