"""Why did the detector not transfer to the Alps? Three checks on the labels already collected (no new searches):
1. is there signal inside the Alps at all (a model trained and tested there, blocked by map area)?
2. does it help to know more than curves and relief (road class, speed, junctions, straightness, surface)?
3. is it tunnels and expressways, which climb a lot and curve little, scoring as "great"?
Each is also run leaving out one region at a time, trained on the other two.

    python analysis/roads/diagnostics.py
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from driver_model import stretch_features
from transfer_test import load

CACHE = Path(__file__).parent / "cache"
REGIONS = ["US-CO", "US-CA", "EU-AL"]
BASIC = ["turn_per_km", "relief"]
MORE = BASIC + ["straightness", "maxspeed", "junctions_per_km", "unpaved", "trunk", "primary", "secondary", "hairpins_per_10km"]
FAST = re.compile(r"tunnel|galleria|schnellstra|autoroute|autostrada|expressway|umfahrung|bypass|ringstra", re.I)


def prepare(iso):
    d = load(iso, grounded=True).reset_index(drop=True)
    seg = pd.read_csv(CACHE / f"{iso}-segments.csv")
    classes = [seg.loc[json.loads(i)].highway.mode().iloc[0] for i in d.segments]
    for c in ("trunk", "primary", "secondary"):
        d[c] = [int(x == c) for x in classes]
    d["fast"] = d["query"].str.contains(FAST) | d["road"].astype(str).str.contains(FAST)
    d["region"] = iso
    return d


def model():
    return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=0.5, max_iter=2000))


def auc(y, p):
    return roc_auc_score(y, p)


def main():
    data = {i: prepare(i) for i in REGIONS}
    for d in data.values():
        d["talk"] = (d.driving > 0).astype(int)
    print("share of searched stretches with grounded driver talk, and mean stats:")
    for i, d in data.items():
        print(f"  {i}: {len(d)} stretches, talk {d.talk.mean():.0%}, curves {d.turn_per_km.median():.0f}°/km median, relief {d.relief.median():.0f} m median, "
              f"{d.fast.sum()} tunnels or expressways")
    alps = data["EU-AL"]
    print("\nAlps by country (share with talk):", alps.groupby("country").talk.agg(["mean", "size"]).round(2).to_dict("index"))

    print("\n1-2. Alps only, trained and tested there (5-fold, whole map cells held out): ROC AUC for 'drivers write about it'")
    g = (np.floor(alps.lon / 0.4) * 1000 + np.floor(alps.lat / 0.4)).values
    for name, cols in [("curves + relief", BASIC), ("+ road class, speed, junctions, surface, straightness", MORE)]:
        p = cross_val_predict(model(), alps[cols], alps.talk, groups=g, cv=GroupKFold(5), method="predict_proba")[:, 1]
        print(f"  {name:58s} {auc(alps.talk, p):.3f}")

    print("\nLeave one region out (train on the other two): ROC AUC for 'drivers write about it', by feature set")
    print(f"  {'held out':8s} {'curves+relief':>14s} {'more features':>14s} {'without tunnels/expressways':>28s}")
    for held in REGIONS:
        tr = pd.concat(d for i, d in data.items() if i != held)
        te = data[held]
        out = []
        for cols in (BASIC, MORE):
            m = model().fit(tr[cols], tr.talk)
            out.append(auc(te.talk, m.predict_proba(te[cols])[:, 1]))
        m = model().fit(tr[BASIC], tr.talk)
        ok = ~te.fast
        out.append(auc(te.talk[ok], m.predict_proba(te.loc[ok, BASIC])[:, 1]))
        print(f"  {held:8s} {out[0]:14.3f} {out[1]:14.3f} {out[2]:28.3f}")

    tr = pd.concat(d for i, d in data.items() if i != "EU-AL")
    m = model().fit(tr[MORE], tr.talk)
    print("\nwhat the three-region-minus-Alps model weighs (standardised):", dict(zip(MORE, m[-1].coef_[0].round(2))))
    f = alps.fast
    print(f"\nin the Alps, the {f.sum()} tunnel/expressway stretches have driver talk {alps.talk[f].mean():.0%} of the time; the other {(~f).sum()}: {alps.talk[~f].mean():.0%}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
