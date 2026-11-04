"""Exports the roads the curve detector finds to public/detected-roads.json, for "Roads near me" where the hand-picked
list (public/road-points.json) doesn't reach. The detector is the validated one: a logistic regression on curves per km
and relief, trained on whether drivers write about a stretch (label_drivers.py; ROC AUC about 0.84 on held-out map
areas). A stretch goes in when it scores above the threshold that keeps 75% precision on the labelled stretches, or
when drivers rated it 4 or 5; not when drivers rated it 3 or below, when it's mostly unpaved, or when the hand-picked
list already has the road. Neighbouring stretches of one road join into one entry.

    python analysis/roads/export_detected.py US-CO [US-CA ...]
"""
import json
import re
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from driver_model import stretch_features
from transfer_test import names_on

HERE = Path(__file__).parent
CACHE = HERE / "cache"
OUT = HERE.parents[1] / "public" / "detected-roads.json"
SCORE = HERE.parents[1] / "public" / "driving-score.json"
DETECTOR = ["turn_per_km", "relief"]
PRECISION = 0.75
# Countries where the detector was tested on held-out stretches (the app shows its chip only there). The Alps failed that test:
# see analysis/roads/README.md.
VALIDATED_IN = ["US"]
STATE = {"US-CO": ("Colorado", "United States"), "US-CA": ("California", "United States")}
# the app's curve levels (CURVE_LEVELS in public/features.js)
LEVELS = [(40, "mostly straight"), (100, "gentle curves"), (200, "curvy"), (400, "very twisty"), (np.inf, "relentless curves")]


def words(s):
    drop = {"scenic", "byway", "historic", "and", "national", "the", "of", "road", "highway", "colorado", "all", "american", "trail"}
    return {w for w in re.findall(r"[a-z0-9]+", str(s).lower()) if w not in drop}


def in_catalog(row, catalog):
    """The hand-picked list has it: the same byway (by name), or a road of the same name or number nearby."""
    for c in catalog:
        near = np.hypot((c["at"][0] - row.lon) * np.cos(np.radians(row.lat)), c["at"][1] - row.lat) * 111 < 60
        if row.byway_name and len(words(row.byway_name) & words(c["name"])) >= 2:
            return True
        if near and ((c.get("ref") and c["ref"].replace(" ", "") == str(row.road).replace(" ", ""))
                     or any(w and w <= words(c["name"]) for w in (words(row["name"]), words(row["road"])))):
            return True
    return False


def title(r):
    ref = "" if str(r.road).startswith("~") else str(r.road).split(";")[0]
    base = f"{r['name']} ({ref})" if r["name"] and ref else (r["name"] or ref)
    passes = [p for p in str(r.passes).split("; ") if p and p != "nan"]
    if passes:
        return f"{base} over {' and '.join(passes[:2])}"
    a, b = [x for x in (r["from"], r["to"]) if isinstance(x, str)] + [None] * 2, None
    ends = [x for x in (r["from"], r["to"]) if isinstance(x, str) and x]
    if len(ends) == 2 and ends[0] != ends[1]:
        return f"{base}, {ends[0]} to {ends[1]}"
    return f"{base} near {ends[0]}" if ends else base


def write_model(det, thr, p_cv, talked, isos):
    """The detector as numbers the app can apply (public/driving-score.json): standardise the features, then logistic."""
    sc, lr = det[0], det[-1]
    SCORE.write_text(json.dumps({
        "built": date.today().isoformat(), "trainedOn": isos, "features": ["perKm", "relief"], "validatedIn": VALIDATED_IN,
        "mean": [round(float(x), 4) for x in sc.mean_], "scale": [round(float(x), 4) for x in sc.scale_],
        "coef": [round(float(x), 4) for x in lr.coef_[0]], "intercept": round(float(lr.intercept_[0]), 4),
        "high": float(thr), "low": float(np.quantile(p_cv[talked == 0], 0.5)),
        "about": "Chance a stretch is one drivers write about, from curves per km and the biggest 5 km climb. See analysis/roads/README.md.",
    }, indent=1) + "\n", encoding="utf-8")


def prepare(iso):
    """One region's stretches with their measurements and driver verdicts. A verdict counts only when the search results
    name a place on the stretch (transfer_test.py explains why): ungrounded ones are dropped (driving becomes NaN)."""
    seg = pd.read_csv(CACHE / f"{iso}-segments.csv")
    st = pd.read_csv(CACHE / f"{iso}-all-stretches.csv", keep_default_na=False, na_values=[""])
    st["name"] = st["name"].fillna("")
    st["byway_name"] = st["byway_name"].fillna("")
    st = pd.concat([st.reset_index(drop=True), pd.DataFrame([stretch_features(seg, json.loads(i)) for i in st.segments])], axis=1)
    labels = pd.DataFrame([json.loads(l) for l in (CACHE / f"{iso}-driver-labels.jsonl").read_text(encoding="utf-8").splitlines()])
    labels["text"] = [" ".join(f"{x['title']} {x['snippet']}" for x in r.results).lower() + " " + r.evidence.lower() for r in labels.itertuples()]
    st = st.merge(labels[["stretch", "driving", "evidence", "unpaved", "text"]].rename(columns={"unpaved": "said_unpaved"}), on="stretch", how="left")
    ground = [isinstance(t, str) and any(n and n in t for n in names_on(r)) for t, (_, r) in zip(st.text, st.iterrows())]
    st.loc[(st.driving > 0) & ~pd.Series(ground, index=st.index), "driving"] = np.nan
    st["iso"] = iso
    return st.drop(columns=["text"])


def main(isos):
    catalog = json.loads((HERE.parents[1] / "public" / "road-points.json").read_text(encoding="utf-8"))["roads"]
    regions = {iso: prepare(iso) for iso in isos}
    # one detector for all regions: trained on every region's labelled stretches together
    lab = pd.concat(r[r.driving.notna()] for r in regions.values()).reset_index(drop=True)
    talked = (lab.driving > 0).astype(int)
    det = make_pipeline(StandardScaler(), LogisticRegression())
    groups = (np.floor(lab.lon / 0.5) * 1000 + np.floor(lab.lat / 0.5)).values
    p_cv = cross_val_predict(det, lab[DETECTOR], talked, groups=groups, cv=GroupKFold(5), method="predict_proba")[:, 1]
    # lowest threshold whose held-out precision on the labelled stretches is at least PRECISION
    thr = next(t for t in sorted(set(np.round(p_cv, 3))) if talked[p_cv >= t].mean() >= PRECISION)
    det.fit(lab[DETECTOR], talked)
    write_model(det, thr, p_cv, talked, isos)
    print(f"pooled over {isos}: {len(lab)} labelled stretches, ROC AUC {roc_auc_score(talked, p_cv):.3f} on held-out map areas; "
          f"threshold {thr:.2f} (precision {talked[p_cv >= thr].mean():.0%}, recall {(p_cv >= thr)[talked == 1].mean():.0%})")
    out = []
    for iso, st in regions.items():
        state, country = STATE[iso]
        st["p"] = det.predict_proba(st[DETECTOR])[:, 1]
        loved = st.driving >= 4
        keep = ((st.p >= thr) | loved) & ~(st.driving.between(1, 3)) & (st.unpaved < 0.3) & ~(st.said_unpaved == True)
        # forest and county roads are often gravel with no surface tag: only keep those drivers rate 4 or 5 and don't call unpaved
        backroad = st.road.astype(str).str.match(r"^(FR|NF|CR|CH|CS|RD|M\d|~)")
        keep &= ~backroad | (loved & ~(st.said_unpaved == True))
        # only the kind of road that was searched and labelled (state and US highways, passes, byways): the precision
        # figure says nothing about the county and local roads stretches.py leaves out of the pool (ids from 100000)
        keep &= st.stretch < 100000
        keep &= ~st.apply(lambda r: in_catalog(r, catalog), axis=1)
        st["keep"] = keep
        print(f"{iso}: {keep.sum()} of {len(st)} stretches kept ({(keep & loved).sum()} that drivers rate 4 or 5)")

        # join neighbouring kept stretches of one road (each one's end is the next one's start)
        runs, cur = [], []
        for r in st.itertuples():
            if r.keep and cur and r.road == cur[-1].road and r.start == cur[-1].end:
                cur.append(r)
                continue
            if cur:
                runs.append(cur)
            cur = [r] if r.keep else []
        if cur:
            runs.append(cur)

        for run in runs:
            rows = st.loc[[r.Index for r in run]]
            km = rows.km.sum()
            turn = float((rows.turn_per_km * rows.km).sum() / km)
            first, last = rows.iloc[0], rows.iloc[-1]
            name_row = first.copy()
            name_row["to"] = last["to"]
            name_row["passes"] = "; ".join(dict.fromkeys(p for x in rows.passes for p in str(x).split("; ") if p and p != "nan"))
            level = next(lbl for lim, lbl in LEVELS if turn < lim)
            quote = next((e for e, d in zip(rows.evidence, rows.driving) if isinstance(e, str) and e and d >= 4), "")
            measured = f"{level.capitalize()} ({turn:.0f}°/km), {rows.relief.max():.0f} m of climb from bottom to top"
            out.append({
                "name": title(name_row), "type": "Found from map data", "state": state, "country": country,
                "km": round(km), "at": [round(float(rows.lon.mean()), 4), round(float(rows.lat.mean()), 4)],
                "about": f'Drivers say: "{quote}". {measured}.' if quote else f"{measured}. No driver reviews found yet.",
                "detected": True, "score": round(float(rows.p.max()), 2),
                "drivers": int(rows.driving.max()) if rows.driving.max() >= 4 else None,
            })
    out.sort(key=lambda r: -r["score"])
    OUT.write_text(json.dumps({"built": date.today().isoformat(), "regions": isos,
                               "method": "analysis/roads: curves and relief, trained on what drivers write about", "roads": out}) + "\n", encoding="utf-8")
    print(f"{len(out)} roads -> {OUT.relative_to(HERE.parents[1])}")
    for r in out[:15]:
        print(f"  {r['score']:.2f} {r['drivers'] or '-'} {r['km']:4d} km  {r['name']}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main(sys.argv[1:] or ["US-CO"])
