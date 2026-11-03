"""Cuts a region's roads into ~5 km segments and measures each one: curves, hairpins, road class, speed, surface,
junctions. Labels the share of each segment that is on a designated byway. Writes cache/<region>-segments.csv.

    python analysis/roads/build_segments.py US-CO
"""
import json
import math
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import pandas as pd
from shapely.geometry import LineString, MultiLineString
from shapely.ops import linemerge

CACHE = Path(__file__).parent / "cache"
SEG_M = 5000
MIN_M = 2000
R = 6371000.0
UNPAVED = {"unpaved", "gravel", "dirt", "compacted", "fine_gravel", "ground", "earth", "sand", "grass"}


def haversine(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(math.radians(b[0] - a[0]) / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def bearing(a, b):
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dl = math.radians(b[0] - a[0])
    y = math.sin(dl) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(dl)
    return math.degrees(math.atan2(y, x))


def angle_diff(a, b):
    return (a - b + 540) % 360 - 180


def curve_stats(coords):
    """Same method as curveStats in public/features.js: heading change per km, and hairpins (150° one way in 250 m)."""
    segs = []
    for p, q in zip(coords, coords[1:]):
        d = haversine(p, q)
        if d >= 4:
            segs.append((bearing(p, q), d))
    length = sum(d for _, d in segs)
    turn = sum(abs(angle_diff(segs[i][0], segs[i - 1][0])) for i in range(1, len(segs)))
    hairpins, i = 0, 1
    while i < len(segs):
        acc = dist = 0.0
        found = False
        j = i
        while j < len(segs) and dist < 250:
            acc += angle_diff(segs[j][0], segs[j - 1][0])
            dist += segs[j][1]
            if abs(acc) >= 150:
                found = True
                break
            j += 1
        if found:
            hairpins += 1
            i = j + 1
        else:
            i += 1
    return length, turn, hairpins


def cut(coords):
    """Splits a polyline into pieces of about SEG_M metres (the last piece absorbs a short remainder)."""
    pieces, cur, run = [], [coords[0]], 0.0
    for p, q in zip(coords, coords[1:]):
        cur.append(q)
        run += haversine(p, q)
        if run >= SEG_M:
            pieces.append(cur)
            cur, run = [q], 0.0
    if run >= MIN_M or not pieces:
        pieces.append(cur)
    elif len(cur) > 1:
        pieces[-1] = pieces[-1] + cur[1:]
    return pieces


def speed_kmh(v):
    try:
        s = str(v).split(";")[0].strip()
        n = float(s.split()[0])
        return n * 1.609 if "mph" in s else n
    except (ValueError, IndexError):
        return np.nan


def main(iso):
    ways = [e for e in json.loads((CACHE / f"{iso}-roads.json").read_text())["elements"] if e["type"] == "way"]
    rels = json.loads((CACHE / f"{iso}-byways.json").read_text())["elements"]
    byway_of = defaultdict(set)  # way id -> byway names
    for r in rels:
        for m in r.get("members", []):
            if m["type"] == "way":
                byway_of[m["ref"]].add(r["tags"].get("name", "?"))

    # vertex -> attributes, so merged lines can be traced back to the ways they came from
    use = Counter()
    vert = {}
    groups = defaultdict(list)
    for w in ways:
        t = w["tags"]
        pts = [(round(g["lon"], 7), round(g["lat"], 7)) for g in w["geometry"]]
        for p in pts:
            use[p] += 1
            vert[p] = (w["id"], t.get("highway"), speed_kmh(t.get("maxspeed")), t.get("surface", ""), t.get("lanes"))
        key = t.get("ref") or t.get("name") or f"~{t.get('highway')}"
        groups[key].append(LineString(pts))

    rows = []
    for key, lines in groups.items():
        merged = linemerge(lines)
        parts = merged.geoms if isinstance(merged, MultiLineString) else [merged]
        for line in parts:
            coords = list(line.coords)
            if len(coords) < 2:
                continue
            for k, piece in enumerate(cut(coords)):
                length, turn, hairpins = curve_stats(piece)
                if length < MIN_M:
                    continue
                attrs = [vert[p] for p in piece if p in vert]
                if not attrs:
                    continue
                on = [bool(byway_of.get(a[0])) for a in attrs]
                names = Counter(n for a in attrs for n in byway_of.get(a[0], ()))
                hw = Counter(a[1] for a in attrs).most_common(1)[0][0]
                speeds = [a[2] for a in attrs if not np.isnan(a[2])]
                mid = piece[len(piece) // 2]
                rows.append({
                    "road": key, "highway": hw, "km": length / 1000,
                    "turn_per_km": turn / (length / 1000),
                    "hairpins_per_10km": hairpins / (length / 10000),
                    "straightness": haversine(piece[0], piece[-1]) / length,
                    "maxspeed": np.median(speeds) if speeds else np.nan,
                    "unpaved": np.mean([a[3] in UNPAVED for a in attrs]),
                    "lanes": pd.to_numeric(Counter(a[4] for a in attrs).most_common(1)[0][0], errors="coerce"),
                    # junctions per km: vertices shared with other road ways, a stand-in for towns and built-up areas
                    "junctions_per_km": sum(use[p] > 1 for p in piece) / (length / 1000),
                    "byway_share": float(np.mean(on)),
                    "byway": names.most_common(1)[0][0] if names else "",
                    "lon": mid[0], "lat": mid[1],
                    "coords": json.dumps([[round(x, 5), round(y, 5)] for x, y in piece[:: max(1, len(piece) // 60)] + [piece[-1]]]),
                })
    df = pd.DataFrame(rows)
    df.to_csv(CACHE / f"{iso}-segments.csv", index=False)
    print(f"{len(df)} segments, {df.km.sum():,.0f} km, {(df.byway_share > 0.5).sum()} on byways")
    print(df.describe().T[["mean", "50%", "max"]].round(2))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "US-CO")
