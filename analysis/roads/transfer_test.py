"""The held-out test: train the detector on one region's driver labels, freeze it, and score another region's labelled
stretches. Reports ROC AUC (with 95% bootstrap intervals) for "do drivers write about it" and "do they rate it 4 or 5",
against curves alone and relief alone, and the precision at the threshold the app uses.

    python analysis/roads/transfer_test.py US-CO US-CA     # train on Colorado, test on California
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

from driver_model import stretch_features

CACHE = Path(__file__).parent / "cache"
DETECTOR = ["turn_per_km", "relief"]


def names_on(row):
    """Place names that say which stretch this is: its passes, its ends, its own road name."""
    out = [p for p in str(row.passes).split("; ")] + [row["from"], row["to"], row["name"]]
    out = [str(x).lower().strip() for x in out if isinstance(x, str) and x.strip() and x != "nan"]
    return [re.sub(r"(road|highway|pass|summit|saddle|scenic|byway|memorial|canyon)", "", x).strip() for x in out if len(x) > 3]


def load(iso, grounded=False):
    """grounded: a verdict counts only when the search results name a place on the stretch (this stops praise for the
    famous part of a long route landing on a dull part of it). Ungrounded verdicts are dropped, not counted as no talk."""
    seg = pd.read_csv(CACHE / f"{iso}-segments.csv")
    picks = pd.read_csv(CACHE / f"{iso}-stretches.csv")
    labels = pd.DataFrame([json.loads(l) for l in (CACHE / f"{iso}-driver-labels.jsonl").read_text(encoding="utf-8").splitlines()])
    text = {r.stretch: " ".join(f"{x['title']} {x['snippet']}" for x in r.results).lower() + " " + r.evidence.lower() for r in labels.itertuples()}
    df = picks.merge(labels[["stretch", "driving", "mentions"]], on="stretch")
    df["grounded"] = [any(n and n in text[r.stretch] for n in names_on(r)) for _, r in df.iterrows()]
    if grounded:
        df = df[(df.driving == 0) | df.grounded]
    feats = pd.DataFrame([stretch_features(seg, json.loads(i)) for i in df.segments])
    return pd.concat([df.reset_index(drop=True), feats], axis=1)


def auc_ci(y, p, rng, n=2000):
    y, p = np.asarray(y), np.asarray(p)
    vals = []
    for _ in range(n):
        b = rng.integers(0, len(y), len(y))
        if 0 < y[b].sum() < len(b):
            vals.append(roc_auc_score(y[b], p[b]))
    return roc_auc_score(y, p), np.percentile(vals, 2.5), np.percentile(vals, 97.5)


def main(train_iso, test_iso, grounded=False):
    rng = np.random.default_rng(0)
    tr = pd.concat([load(i, grounded) for i in train_iso.split(",")])  # "US-CO,US-CA" trains on both
    te = load(test_iso, grounded)
    tr, te = tr.reset_index(drop=True), te.reset_index(drop=True)
    print(f"[{'only verdicts that name a place on the stretch' if grounded else 'all verdicts'}]")
    det = make_pipeline(StandardScaler(), LogisticRegression())
    det.fit(tr[DETECTOR], (tr.driving > 0).astype(int))
    te["p"] = det.predict_proba(te[DETECTOR])[:, 1]
    thr = json.loads((Path(__file__).parents[2] / "public" / "driving-score.json").read_text())["high"]

    print(f"trained on {train_iso} ({len(tr)} stretches), tested on {test_iso} ({len(te)} stretches, {(te.driving > 0).sum()} with driver talk)\n")
    talked = (te.driving > 0).astype(int)
    print("A. do drivers write about the stretch at all?   ROC AUC (95% interval)")
    for name, p in [(f"detector trained on {train_iso}", te.p), ("curves per km alone", te.turn_per_km), ("relief alone", te.relief)]:
        a, lo, hi = auc_ci(talked, p, rng)
        print(f"  {name:36s} {a:.3f} ({lo:.2f} to {hi:.2f})")
    hit = te.p >= thr
    print(f"  at the app's threshold ({thr:.2f}): precision {talked[hit].mean():.0%} (Colorado held-out: 80%), recall {hit[talked == 1].mean():.0%}")

    known = te[te.driving > 0]
    loved = (known.driving >= 4).astype(int)
    print(f"\nB. among the {len(known)} with driver talk, do drivers rate it 4 or 5? ({loved.sum()} yes, {len(known) - loved.sum()} no)")
    for name, p in [(f"detector trained on {train_iso}", known.p), ("curves per km alone", known.turn_per_km), ("relief alone", known.relief)]:
        a, lo, hi = auc_ci(loved, p, rng)
        print(f"  {name:36s} {a:.3f} ({lo:.2f} to {hi:.2f})")
    print(f"  Spearman, score vs 1 to 5 rating: {spearmanr(known.p, known.driving).statistic:.2f}")

    print(f"\nC. what drivers write about, by detector score band ({test_iso})")
    te["band"] = pd.cut(te.p, [0, 0.25, 0.57, 1.0], labels=["below 0.25", "0.25 to 0.57", "above 0.57"], include_lowest=True)
    print(te.groupby("band", observed=True).agg(stretches=("p", "size"), share_with_talk=("driving", lambda d: (d > 0).mean()),
                                                mean_rating=("driving", lambda d: d[d > 0].mean())).round(2).to_string())
    print("\nhighest scoring stretches with no driver talk (candidates, or a search miss):")
    print(te[te.driving == 0].sort_values("p", ascending=False)[["query", "p", "turn_per_km", "relief"]].head(8).round(2).to_string(index=False))
    print("\ndrivers' 4 and 5 stretches the detector scores lowest (what it can't see):")
    print(known[known.driving >= 4].sort_values("p")[["query", "driving", "p", "turn_per_km", "relief"]].head(8).round(2).to_string(index=False))
    te.drop(columns=["segments"]).to_csv(CACHE / f"{test_iso}-transfer-scored.csv", index=False)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    a = [x for x in sys.argv[1:] if not x.startswith("--")]
    main(a[0] if a else "US-CO", a[1] if len(a) > 1 else "US-CA", "--grounded" in sys.argv)
