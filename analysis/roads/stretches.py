"""Joins segments into stretches of up to ~30 km along one road, names each by the passes on it or the towns at its
ends, and picks a sample to look up: 100 from the pilot's top fifth of scores, 100 from the middle, 50 from the bottom
fifth, so the labels aren't only famous roads. Built-up stretches (towns) are left out. Writes cache/<region>-stretches.csv.

    python analysis/roads/stretches.py US-CO
"""
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd

HERE = Path(__file__).parent
CACHE = HERE / "cache"
STATE = {"US-CO": "Colorado", "US-CA": "California"}
# Regions that cross borders: the country decides the word for the region and the language the search is worded in
LOCAL = {"CH": ("Schweiz", "de"), "AT": ("Österreich", "de"), "IT": ("Italia", "it"), "FR": ("France", "fr")}
MAX_SEGS = 6
SAMPLE = {"top": 100, "middle": 100, "bottom": 50}


def dist_km(a, b):
    x = math.radians(b[0] - a[0]) * math.cos(math.radians((a[1] + b[1]) / 2))
    return 6371 * math.hypot(x, math.radians(b[1] - a[1]))


def main(iso, stratify="byway"):
    """stratify "byway": spread the picks over the pilot byway model's scores (US-CO). "detector": over the frozen
    detector in public/driving-score.json, for a region whose byways are too few to train a pilot (US-CA)."""
    seg = pd.read_csv(CACHE / f"{iso}-segments.csv")
    if stratify == "byway":
        scored = pd.read_csv(CACHE / f"{iso}-scored.csv")[["road", "lon", "lat", "score"]]
        seg = seg.merge(scored, on=["road", "lon", "lat"], how="left")
    else:
        seg["score"] = 0.0
    places = json.loads((CACHE / f"{iso}-places.json").read_text())["elements"]
    passes = [(p["lon"], p["lat"], p["tags"]["name"]) for p in places if p["tags"].get("mountain_pass") or p["tags"].get("natural") == "saddle"]
    towns = [(p["lon"], p["lat"], p["tags"]["name"]) for p in places if p["tags"].get("place") in ("city", "town", "village")]
    hamlets = [(p["lon"], p["lat"], p["tags"]["name"]) for p in places if p["tags"].get("place") == "hamlet"]

    def nearest(pt, pool, within):
        d, name = min((dist_km(pt, (x, y)), n) for x, y, n in pool)
        return name if d <= within else None

    # chain segments: rows come out of build_segments in order along each merged line
    stretches, cur, last = [], [], None
    for i, r in seg.iterrows():
        c = json.loads(r.coords)
        if cur and (r.road != seg.road[cur[-1]] or c[0] != last or len(cur) >= MAX_SEGS):
            stretches.append(cur)
            cur = []
        cur.append(i)
        last = c[-1]
    stretches.append(cur)

    rows, others = [], []  # the search pool, and every other named stretch (for export_detected.py)
    for idx in stretches:
        s = seg.loc[idx]
        if s.km.sum() < 10 or s.junctions_per_km.median() > 4:
            continue
        coords = [p for c in s.coords for p in json.loads(c)]
        on_pass = sorted({n for x, y, n in passes if min(dist_km((x, y), p) for p in coords[::3]) < 1.5})
        a = nearest(coords[0], towns, 25) or nearest(coords[0], hamlets, 10)
        b = nearest(coords[-1], towns, 25) or nearest(coords[-1], hamlets, 10)
        ref = s.road.iloc[0] if not s.road.iloc[0].startswith("~") else ""
        # a road's own name helps a search ("Trail Ridge Road"); street and county road names don't
        name = next((n for n in s.name if isinstance(n, str) and n and n != ref
                     and not re.search(r"county road|street|avenue|boulevard|\bblvd\b|\bdrive\b|highway \d|^(north|south|east|west) ", n, re.I)), "")
        label = " ".join(x for x in [ref, f'"{name}"' if name else ""] if x) or "road"
        where = " and ".join(on_pass[:2]) if on_pass else (f"{a} to {b}" if a and b and a != b else (f"near {a or b}" if a or b else ""))
        if not where:
            continue
        # only roads people write about go in the search pool: state and US highways, and anything over a pass or on a byway
        country = s.country.mode().iloc[0] if "country" in s else ""
        if country in LOCAL:  # no "US 40" style names: any numbered main or regional road
            pool = bool((ref and s.highway.isin(["trunk", "primary", "secondary"]).any()) or on_pass or s.byway_share.mean() > 0.5)
        else:
            pool = bool(re.match(rf"^(US|{iso[3:]}|SH) ", s.road.iloc[0]) or on_pass or s.byway_share.mean() > 0.5)
        byways = s.byway[s.byway.notna() & (s.byway != "")]
        (rows if pool else others).append({
            "stretch": len(rows) if pool else 100000 + len(others), "road": s.road.iloc[0], "name": name, "passes": "; ".join(on_pass), "from": a, "to": b,
            "query": f"{label} {where} {LOCAL[country][0]}" if country in LOCAL else f"{label} {where} {STATE.get(iso, '')} drive",
            "country": country, "lang": LOCAL[country][1] if country in LOCAL else "en",
            "km": s.km.sum(), "segments": json.dumps(idx), "score": s.score.max(),
            "byway": s.byway_share.mean() > 0.5, "byway_name": byways.mode().iloc[0] if len(byways) else "",
            "lon": float(np.mean([p[0] for p in coords])), "lat": float(np.mean([p[1] for p in coords])),
            "start": json.dumps(coords[0]), "end": json.dumps(coords[-1]),
        })
    if stratify == "detector":
        from driver_model import stretch_features
        m = json.loads((HERE.parents[1] / "public" / "driving-score.json").read_text())
        for r in rows + others:
            f = stretch_features(seg, json.loads(r["segments"]))
            z = m["intercept"] + sum(m["coef"][i] * (f[k] - m["mean"][i]) / m["scale"][i] for i, k in enumerate(["turn_per_km", "relief"]))
            r["score"] = 1 / (1 + math.exp(-z))
    pd.DataFrame(rows + others).to_csv(CACHE / f"{iso}-all-stretches.csv", index=False)
    st = pd.DataFrame(rows).dropna(subset=["score"]).drop_duplicates("query")
    lo, hi = st.score.quantile([0.2, 0.8])
    pick = pd.concat([
        st[st.score >= hi].pipe(lambda d: d.sample(min(len(d), SAMPLE["top"]), random_state=0)).assign(stratum="top"),
        st[(st.score > lo) & (st.score < hi)].pipe(lambda d: d.sample(min(len(d), SAMPLE["middle"]), random_state=0)).assign(stratum="middle"),
        st[st.score <= lo].pipe(lambda d: d.sample(min(len(d), SAMPLE["bottom"]), random_state=0)).assign(stratum="bottom"),
    ])
    pick.to_csv(CACHE / f"{iso}-stretches.csv", index=False)
    print(f"{len(st)} stretches ({(st.score >= hi).sum()} top, {((st.score > lo) & (st.score < hi)).sum()} middle, {(st.score <= lo).sum()} bottom), {len(pick)} picked ({pick.byway.sum()} on byways)")
    print(pick.groupby("stratum").query.apply(lambda q: list(q.head(4))).to_string())


if __name__ == "__main__":
    main(next((a for a in sys.argv[1:] if not a.startswith("--")), "US-CO"), "detector" if "--detector" in sys.argv else "byway")
