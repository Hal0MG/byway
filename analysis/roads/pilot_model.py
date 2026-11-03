"""Pilot: can road measurements tell designated byway segments from other roads? Spatially blocked cross validation
(whole 0.5° cells held out), a logistic regression and gradient boosting, permutation importance, and the highest
scoring roads that are not byways (candidates, or misses in the labels).

    python analysis/roads/pilot_model.py US-CO
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.impute import SimpleImputer
from sklearn.inspection import permutation_importance
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import average_precision_score, roc_auc_score
from sklearn.model_selection import GroupKFold, cross_val_predict
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

CACHE = Path(__file__).parent / "cache"
SHAPE = ["turn_per_km", "hairpins_per_10km", "straightness"]
TERRAIN = ["elev_mean", "relief", "climb_per_km"]
ROAD = ["maxspeed", "unpaved", "lanes", "junctions_per_km", "trunk", "primary", "secondary", "tertiary"]


def main(iso):
    df = pd.read_csv(CACHE / f"{iso}-segments.csv")
    for h in ["trunk", "primary", "secondary", "tertiary"]:
        df[h] = (df.highway == h).astype(int)
    df = df[(df.byway_share == 0) | (df.byway_share > 0.5)].reset_index(drop=True)  # drop segments half on a byway
    y = (df.byway_share > 0.5).astype(int).values
    groups = (np.floor(df.lon / 0.5) * 1000 + np.floor(df.lat / 0.5)).values
    cv = GroupKFold(n_splits=5)
    print(f"{len(df)} segments, {y.sum()} byway ({y.mean():.1%} base rate), {len(set(groups))} spatial blocks\n")

    def lr():
        return make_pipeline(SimpleImputer(strategy="median"), StandardScaler(), LogisticRegression(max_iter=2000, class_weight="balanced"))

    def gb():
        return HistGradientBoostingClassifier(max_iter=300, learning_rate=0.05, max_leaf_nodes=15, class_weight="balanced", random_state=0)

    print(f"{'features':28s} {'model':8s} {'ROC AUC':>8s} {'avg prec':>9s}")
    for name, cols in [("shape only", SHAPE), ("shape + terrain", SHAPE + TERRAIN), ("all", SHAPE + TERRAIN + ROAD)]:
        for mname, m in [("logistic", lr()), ("boosting", gb())]:
            p = cross_val_predict(m, df[cols], y, groups=groups, cv=cv, method="predict_proba")[:, 1]
            print(f"{name:28s} {mname:8s} {roc_auc_score(y, p):8.3f} {average_precision_score(y, p):9.3f}")
            if name == "all" and mname == "boosting":
                df["score"] = p

    cols = SHAPE + TERRAIN + ROAD
    m = gb().fit(df[cols], y)
    imp = permutation_importance(m, df[cols], y, scoring="average_precision", n_repeats=5, random_state=0)
    print("\npermutation importance (drop in average precision):")
    for c, v in sorted(zip(cols, imp.importances_mean), key=lambda t: -t[1])[:8]:
        print(f"  {c:20s} {v:.3f}")

    print("\nbyways the model finds hardest (lowest median out-of-fold score):")
    by = df[y == 1].groupby("byway").agg(n=("score", "size"), score=("score", "median"), turn=("turn_per_km", "median"), relief=("relief", "median"))
    print(by.sort_values("score").head(6).round(2).to_string())
    print("\nbyways it finds easiest:")
    print(by.sort_values("score", ascending=False).head(6).round(2).to_string())

    print("\nhighest scoring roads that are NOT byways (out-of-fold score, grouped by road):")
    cand = df[y == 0].groupby("road").agg(n=("score", "size"), score=("score", "max"), turn=("turn_per_km", "median"),
                                          hairpins=("hairpins_per_10km", "max"), elev=("elev_mean", "max"), lat=("lat", "mean"), lon=("lon", "mean"))
    print(cand[cand.n >= 2].sort_values("score", ascending=False).head(20).round(2).to_string())
    df.drop(columns=["coords"]).to_csv(CACHE / f"{iso}-scored.csv", index=False)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "US-CO")
