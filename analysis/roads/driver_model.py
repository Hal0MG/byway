"""Trains on what drivers say (label_drivers.py) instead of byway designation, and compares, on held-out map areas:
the pilot's byway model, curves alone, and models trained on driver scores. Then scores every highway stretch and
lists the best ones nobody's written about.

    python analysis/roads/driver_model.py US-CO
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import roc_auc_score
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

CACHE = Path(__file__).parent / "cache"
FEATURES = ["turn_per_km", "hairpins_per_10km", "straightness", "relief", "climb_per_km", "elev_mean",
            "maxspeed", "unpaved", "junctions_per_km"]


def stretch_features(seg, idx):
    s = seg.loc[idx]
    w = s.km / s.km.sum()
    out = {c: float(np.nansum(s[c] * w)) if s[c].notna().any() else np.nan for c in FEATURES}
    out["hairpins_per_10km"] = float(s.hairpins_per_10km.max())  # the best part of the stretch, not its average
    out["relief"] = float(s.relief.max())
    out["turn_max"] = float(s.turn_per_km.max())
    return out


def main(iso):
    seg = pd.read_csv(CACHE / f"{iso}-segments.csv")
    picks = pd.read_csv(CACHE / f"{iso}-stretches.csv")
    labels = pd.DataFrame([json.loads(l) for l in (CACHE / f"{iso}-driver-labels.jsonl").read_text(encoding="utf-8").splitlines()])
    df = picks.merge(labels[["stretch", "relevant", "mentions", "driving", "scenery", "unpaved", "evidence"]].rename(columns={"unpaved": "said_unpaved"}), on="stretch")
    feats = pd.DataFrame([stretch_features(seg, json.loads(i)) for i in df.segments])
    df = pd.concat([df.reset_index(drop=True), feats], axis=1)
    cols = FEATURES + ["turn_max"]

    known = df[df.driving > 0].reset_index(drop=True)
    print(f"{len(df)} stretches searched, {len(known)} with a driving verdict ({len(df) - len(known)} nobody writes about)")
    print("driving scores:", known.driving.value_counts().sort_index().to_dict())
    print("share with a verdict by pilot stratum:", df.assign(k=df.driving > 0).groupby("stratum").k.mean().round(2).to_dict())

    y = (known.driving >= 4).astype(int).values
    groups = (np.floor(known.lon / 0.5) * 1000 + np.floor(known.lat / 0.5)).values
    cv = GroupKFold(n_splits=5)
    print(f"\ntarget: drivers rate it 4 or 5 ({y.mean():.0%} of the stretches with a verdict). Held-out map areas.\n")
    print(f"{'predictor':42s} {'ROC AUC':>8s} {'95% interval':>14s} {'Spearman vs 1-5':>16s}")
    rng = np.random.default_rng(0)
    boots = [rng.integers(0, len(y), len(y)) for _ in range(2000)]

    def report(name, p):
        p = np.asarray(p)
        aucs = [roc_auc_score(y[b], p[b]) for b in boots if 0 < y[b].sum() < len(b)]
        lo, hi = np.percentile(aucs, [2.5, 97.5])
        print(f"{name:42s} {roc_auc_score(y, p):8.3f} {f'{lo:.2f} to {hi:.2f}':>14s} {spearmanr(p, known.driving).statistic:16.3f}")

    report("pilot byway model (no driver labels)", known.score)
    report("curves per km alone", known.turn_per_km)
    report("relief alone", known.relief)
    lr = make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=0.5, max_iter=2000, class_weight="balanced"))
    p_lr = cross_val_predict(lr, known[cols], y, groups=groups, cv=cv, method="predict_proba")[:, 1]
    report("logistic on driver labels", p_lr)
    gb = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=7, min_samples_leaf=8, class_weight="balanced", random_state=0)
    p_gb = cross_val_predict(gb, known[cols], y, groups=groups, cv=cv, method="predict_proba")[:, 1]
    report("boosting on driver labels", p_gb)

    # the other signal: whether drivers write about a stretch at all
    talked = (df.driving > 0).astype(int)
    print(f"\ndo drivers write about it at all? pilot byway model ROC AUC {roc_auc_score(talked, df.score):.3f}, "
          f"curves alone {roc_auc_score(talked, df.turn_per_km):.3f}, relief alone {roc_auc_score(talked, df.relief):.3f}")
    g_all = (np.floor(df.lon / 0.5) * 1000 + np.floor(df.lat / 0.5)).values
    p_t = cross_val_predict(lr, df[cols], talked, groups=g_all, cv=cv, method="predict_proba")[:, 1]
    aucs = [roc_auc_score(talked.values[b], p_t[b]) for b in (rng.integers(0, len(df), len(df)) for _ in range(2000))]
    print(f"logistic trained on it, held-out map areas: ROC AUC {roc_auc_score(talked, p_t):.3f} "
          f"({np.percentile(aucs, 2.5):.2f} to {np.percentile(aucs, 97.5):.2f})")
    coef_t = pd.Series(make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(C=0.5, max_iter=2000))
                       .fit(df[cols], talked)[-1].coef_[0], index=cols).sort_values()
    print("its weights:", coef_t.round(2).to_dict())

    lr.fit(known[cols], y)
    coef = pd.Series(lr[-1].coef_[0], index=cols).sort_values()
    print("\nwhat drivers' favourites have (standardised logistic weights, + means more of it, more likely great):")
    print(coef.round(2).to_string())

    # score every highway stretch, including those nobody wrote about
    allst = df.copy()
    allst["p"] = lr.predict_proba(allst[cols])[:, 1]
    quiet = allst[allst.driving == 0].sort_values("p", ascending=False)
    print("\nhighest scoring stretches with no driver talk found (unsung, or a search miss):")
    print(quiet[["query", "p", "turn_per_km", "hairpins_per_10km", "relief"]].head(12).round(2).to_string(index=False))
    print("\ndrivers' favourites the model rates lowest (what it can't see):")
    miss = known.assign(p=p_lr)[known.driving >= 4].sort_values("p")
    print(miss[["query", "driving", "p", "turn_per_km", "relief", "evidence"]].head(8).round(2).to_string(index=False))
    allst.drop(columns=["segments"]).to_csv(CACHE / f"{iso}-driver-scored.csv", index=False)
    # the labels cost searches to make, so a slim copy (no search text) is kept in git
    slim = df[["stretch", "query", "road", "km", "lon", "lat", "byway", "driving", "scenery", "mentions", "said_unpaved", "evidence"]]
    slim.merge(labels[["stretch", "sources"]].assign(sources=labels.sources.str.join(" ")), on="stretch") \
        .round({"km": 1, "lon": 4, "lat": 4}).to_csv(Path(__file__).parent / f"{iso}-driver-labels.csv", index=False)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "US-CO")
