"""Builds analysis/trip_analysis.ipynb from the cells below and runs it.
Run from the repo root: python analysis/build_notebook.py
Needs: pandas matplotlib seaborn scikit-learn nbformat nbconvert ipykernel
"""
import nbformat as nbf
from nbconvert.preprocessors import ExecutePreprocessor

cells = []
md = lambda s: cells.append(nbf.v4.new_markdown_cell(s.strip()))
code = lambda s: cells.append(nbf.v4.new_code_cell(s.strip()))

md("""
# What 74 scenic road trips look like in data

Byway ships 74 ready-made trips on every continent. Each one was planned by an LLM, snapped to real roads, and measured
with OpenRouteService (scenic route and fastest route). This notebook treats that set as a dataset and asks:

1. How long are the trips, and how hard are the driving days?
2. How much slower is the scenic route than the fastest one, and what does that detour cost?
3. Do regions differ in road type (highway, unpaved) and climbing?
4. Can trip length be predicted from distance and terrain, and do trips fall into natural groups?

Source: `data/presets.json` (OpenRouteService routing, OpenStreetMap road data).
""")

code("""
import json, warnings
import numpy as np, pandas as pd
import matplotlib.pyplot as plt, seaborn as sns
warnings.filterwarnings("ignore")
sns.set_theme(style="whitegrid", context="notebook")
plt.rcParams["figure.dpi"] = 110

with open("../data/presets.json", encoding="utf-8") as f:
    raw = list(json.load(f).values())
len(raw)
""")

md("## 1. Build a tidy table: one row per trip")

md("""
Countries come from a point-in-polygon lookup of every stop against the app's own country outlines
(`public/countries.json`, Natural Earth, public domain), not from guessed coordinate boxes. A trip's region is the
region of its start.
""")

code("""
from shapely.geometry import shape, Point
from shapely.strtree import STRtree

with open("../public/countries.json", encoding="utf-8") as f:
    feats = json.load(f)["features"]
geoms = [shape(x["geometry"]) for x in feats]
codes = [x["properties"]["cc"] for x in feats]
tree = STRtree(geoms)

def country(lat, lng):
    p = Point(lng, lat)
    for i in tree.query(p):
        if geoms[i].contains(p): return codes[i]
    i = tree.nearest(p)                       # a coastal point just outside the simplified outline
    return codes[i] if geoms[i].distance(p) < 0.5 else None

REGION = {**dict.fromkeys(["US", "CA", "MX"], "North America"), "CR": "Central America",
          **dict.fromkeys(["AR", "BO", "BR", "CL", "PE"], "South America"),
          **dict.fromkeys(["AT", "CH", "ES", "FR", "GB", "HR", "IE", "IS", "IT", "NO", "RO"], "Europe"),
          **dict.fromkeys(["AU", "NZ"], "Oceania"), **dict.fromkeys(["BW", "MA", "NA", "ZA"], "Africa"),
          **dict.fromkeys(["OM", "TR"], "Middle East"),
          **dict.fromkeys(["BD", "GE", "IN", "JP", "KR", "MY", "SG", "TH", "TW", "VN"], "Asia")}
def region(lat, lng): return REGION[country(lat, lng)]
""")

code("""

rows = []
for t in raw:
    s, f = t["routes"]["scenic"], t["routes"].get("fastest") or {}
    stops = t["stops"]
    first = stops[0]
    days = max(x.get("day", 1) for x in stops)
    # drive hours per day: a leg belongs to the day of the stop it arrives at
    per_day = {}
    for i, leg in enumerate(s["legs"]):
        d = stops[i + 1].get("day", 1)
        per_day[d] = per_day.get(d, 0) + leg["duration_s"] / 3600
    hrs = list(per_day.values())
    km = s["distance_m"] / 1000
    rows.append(dict(
        name=t["name"], topgear=t["name"].startswith("Top Gear"),
        country=country(first["lat"], first["lng"]), region=region(first["lat"], first["lng"]),
        n_countries=len({country(x["lat"], x["lng"]) for x in stops}),
        lat=first["lat"], lng=first["lng"],
        days=days, stops=len(stops), km=km, hours=s["duration_s"] / 3600,
        km_per_day=km / days, max_day_h=max(hrs) if hrs else np.nan,
        mean_day_h=np.mean(hrs) if hrs else np.nan,
        avg_kmh=km / (s["duration_s"] / 3600),
        highway_pct=100 * s.get("highway_m", 0) / s["distance_m"],
        unpaved_pct=100 * s.get("unpaved_m", 0) / s["distance_m"],
        toll_km=s.get("toll_m", 0) / 1000, ferry_km=s.get("ferry_m", 0) / 1000,
        ascent_m=s.get("ascent_m", 0), climb_m_per_km=s.get("ascent_m", 0) / km,
        fast_km=(f.get("distance_m") or np.nan) / 1000, fast_h=(f.get("duration_s") or np.nan) / 3600,
        max_h_setting=t["settings"].get("maxHours"),
    ))
df = pd.DataFrame(rows)
df["detour_km_pct"] = 100 * (df.km / df.fast_km - 1)
df["extra_min"] = 60 * (df.hours - df.fast_h)
df.round(1).head()
""")

code("""
print(df.region.value_counts().to_string())
df.describe().T[["count", "mean", "50%", "min", "max"]].round(1)
""")

md("""
## 2. Trip size

The spread of `km_per_day` shows how the planner paces drives.
""")

code("""
fig, ax = plt.subplots(1, 3, figsize=(14, 3.8))
sns.histplot(df.km, bins=20, ax=ax[0], color="#2f6f9f"); ax[0].set_xlabel("trip distance (km)")
sns.histplot(df.days, bins=range(1, int(df.days.max()) + 2), ax=ax[1], color="#2f6f9f"); ax[1].set_xlabel("days")
sns.histplot(df.km_per_day, bins=20, ax=ax[2], color="#2f6f9f"); ax[2].set_xlabel("km per day")
plt.tight_layout(); plt.show()
""")

md("## 3. How hard are the driving days?")

code("""
fig, ax = plt.subplots(1, 2, figsize=(13, 4))
order = df.groupby("region").max_day_h.median().sort_values().index
sns.boxplot(data=df, y="region", x="max_day_h", order=order, ax=ax[0], color="#9cc3de")
ax[0].axvline(8, ls="--", c="crimson"); ax[0].set_xlabel("longest driving day (hours)"); ax[0].set_ylabel("")
sns.scatterplot(data=df, x="km_per_day", y="mean_day_h", hue="region", style="topgear", ax=ax[1])
ax[1].set_xlabel("km per day"); ax[1].set_ylabel("mean driving hours per day")
plt.tight_layout(); plt.show()

hard = df[df.max_day_h > 8][["name", "region", "max_day_h", "max_h_setting"]].sort_values("max_day_h", ascending=False)
print(f"{len(hard)} of {len(df)} trips have a day longer than 8 hours of driving")
hard.round(1).head(10)
""")

md("""
Only 2 trips break 8 hours (Namibia, with 41% unpaved road, and the Seattle to San Diego trip). Where a trip carries its
own `maxHours` setting (35 of 74), the longest day sits about 2 hours under it on median, so the planner's day limit holds.
""")

code("""
df["over_setting_h"] = df.max_day_h - df.max_h_setting
df.over_setting_h.describe().round(2)
""")

md("""
## 4. The cost of going scenic

For each trip the app measured both the scenic route and the fastest route between the same stops.
""")

code("""
d = df.dropna(subset=["fast_km"])
print(f"{len(d)} trips with both routes")
print(d[["detour_km_pct", "extra_min"]].describe().round(1).T.to_string())

fig, ax = plt.subplots(1, 2, figsize=(13, 4))
sns.histplot(d.detour_km_pct, bins=20, ax=ax[0], color="#d98c2b")
ax[0].set_xlabel("scenic route longer than fastest (% distance)")
sns.scatterplot(data=d, x="fast_h", y="hours", hue="region", ax=ax[1])
lim = [0, max(d.hours.max(), d.fast_h.max()) * 1.05]
ax[1].plot(lim, lim, "k--", lw=1); ax[1].set_xlabel("fastest route (h)"); ax[1].set_ylabel("scenic route (h)")
plt.tight_layout(); plt.show()
""")

code("""
d.sort_values("detour_km_pct", ascending=False)[["name", "region", "km", "fast_km", "detour_km_pct", "extra_min"]].round(1).head(8)
""")

md("## 5. Road type and terrain by region")

code("""
g = df.groupby("region").agg(trips=("name", "count"), km=("km", "median"),
        highway_pct=("highway_pct", "median"), unpaved_pct=("unpaved_pct", "median"),
        climb_m_per_km=("climb_m_per_km", "median"), avg_kmh=("avg_kmh", "median")).round(1)
g.sort_values("climb_m_per_km", ascending=False)
""")

code("""
fig, ax = plt.subplots(1, 3, figsize=(15, 4))
for a, col, ttl in zip(ax, ["unpaved_pct", "climb_m_per_km", "avg_kmh"],
                       ["unpaved share of route (%)", "climbing (m per km)", "average speed (km/h)"]):
    o = df.groupby("region")[col].median().sort_values().index
    sns.barplot(data=df, y="region", x=col, order=o, estimator=np.median, errorbar=None, ax=a, color="#6aa57a")
    a.set_xlabel(ttl); a.set_ylabel("")
plt.tight_layout(); plt.show()
""")

code("""
corr = df[["km", "hours", "avg_kmh", "highway_pct", "unpaved_pct", "climb_m_per_km", "ferry_km"]].corr().round(2)
plt.figure(figsize=(6.5, 5)); sns.heatmap(corr, annot=True, cmap="vlag", center=0, cbar=False); plt.show()
""")

md("""
## 6. Predicting drive time

How well do distance and terrain explain driving time? A linear model with cross validation, then a random forest to see
whether non-linear effects (gravel, mountains) matter. With only 74 trips the numbers are rough.
""")

code("""
from sklearn.linear_model import LinearRegression
from sklearn.ensemble import RandomForestRegressor
from sklearn.model_selection import cross_val_score, cross_val_predict, KFold

X = df[["km", "highway_pct", "unpaved_pct", "climb_m_per_km", "ferry_km"]].fillna(0)
y = df.hours
cv = KFold(5, shuffle=True, random_state=0)
models = {"distance only": (LinearRegression(), ["km"]),
          "linear + terrain": (LinearRegression(), list(X.columns)),
          "random forest": (RandomForestRegressor(300, random_state=0, min_samples_leaf=2), list(X.columns))}
for name, (m, cols) in models.items():
    r2 = cross_val_score(m, X[cols], y, cv=cv, scoring="r2")
    mae = -cross_val_score(m, X[cols], y, cv=cv, scoring="neg_mean_absolute_error")
    print(f"{name:18s} R2 {r2.mean():.3f}   MAE {mae.mean():.2f} h")
""")

md("""
Distance alone gives R2 of about 0.94 and adding terrain lifts it to about 0.97. The random forest does worse than the
linear model: with 74 rows and a few extreme trips (Cross-Canada at 5,800 km) a tree model cannot extrapolate, and the
linear fit is the better choice here. The largest miss is Cross-Canada, whose long straight highway is faster than its
distance suggests.
""")

code("""
rf = RandomForestRegressor(300, random_state=0, min_samples_leaf=2).fit(X, y)
imp = pd.Series(rf.feature_importances_, X.columns).sort_values()
imp.plot.barh(color="#2f6f9f", figsize=(6, 3)); plt.xlabel("random forest importance"); plt.show()

lin = LinearRegression().fit(X[["km"]], y)
print("hours per extra 100 km (distance only):", round(lin.coef_[0] * 100, 2))
""")

code("""
df["pred_h"] = cross_val_predict(RandomForestRegressor(300, random_state=0, min_samples_leaf=2), X, y, cv=cv)
df["resid_h"] = df.hours - df.pred_h
df.reindex(df.resid_h.abs().sort_values(ascending=False).index)[["name", "region", "km", "unpaved_pct", "hours", "pred_h", "resid_h"]].round(1).head(6)
""")

md("""
## 7. Do trips fall into natural groups?

K-means on standardised pacing and road features. The silhouette scores are low and flat (0.23 to 0.26), so there is no
sharp cluster structure. The split into two groups is a gradient: faster highway-heavy trips against slower, steeper,
winding ones.
""")

code("""
from sklearn.preprocessing import StandardScaler
from sklearn.cluster import KMeans
from sklearn.decomposition import PCA
from sklearn.metrics import silhouette_score

feat = ["km_per_day", "avg_kmh", "highway_pct", "unpaved_pct", "climb_m_per_km", "days"]
Z = StandardScaler().fit_transform(df[feat].fillna(0))
scores = {k: silhouette_score(Z, KMeans(k, n_init=10, random_state=0).fit_predict(Z)) for k in range(2, 8)}
print({k: round(v, 3) for k, v in scores.items()})
k = max(scores, key=scores.get)
df["cluster"] = KMeans(k, n_init=10, random_state=0).fit_predict(Z)
print("chosen k =", k)
df.groupby("cluster")[feat].median().round(1).assign(trips=df.cluster.value_counts().sort_index())
""")

code("""
P = PCA(2).fit_transform(Z)
plt.figure(figsize=(7, 5))
sns.scatterplot(x=P[:, 0], y=P[:, 1], hue=df.cluster, palette="Set2", style=df.topgear, s=70)
plt.xlabel("PC1"); plt.ylabel("PC2"); plt.title("Trips by driving character"); plt.show()
for c, g in df.groupby("cluster"):
    print(c, "|", ", ".join(g.sample(min(4, len(g)), random_state=1).name.str.slice(0, 38)))
""")

md("## 8. Where the trips are")

code("""
plt.figure(figsize=(11, 5))
sns.scatterplot(data=df, x="lng", y="lat", hue="region", size="km", sizes=(30, 250), alpha=.75)
plt.legend(bbox_to_anchor=(1.01, 1), loc="upper left"); plt.xlabel("longitude"); plt.ylabel("latitude"); plt.show()
""")

md("""
## 9. How good is the planner, and what does the pipeline fix?

The trips above are the finished product. The app's planner works in stages: the model drafts a plan, a checker finds
problems and asks for one repair, stops are geocoded, routed, extra points are added on featured roads the route misses
("road pass"), and a dynamic program moves overnights so no day runs long. `tools/eval-planner.mjs` ran 30 fixed trip
requests through that pipeline and logged every stage (results in `eval/results/`). Here the logs are analysed with
bootstrap intervals (resampling requests).

Two of the three models are compared. The third (`gemini-flash-latest`) failed 62% of requests on busy-server errors, so
its numbers rest on too few trips to compare.
""")

code("""
import glob, os
run = sorted(glob.glob("../eval/results/*/"))[-1]
logs = {os.path.basename(p)[:-6]: pd.read_json(p, lines=True) for p in glob.glob(run + "*.jsonl")}
logs = {k: v for k, v in logs.items() if k != "gemini-flash-latest"}
rng = np.random.default_rng(0)

def boot(frame, stat, n=2000):
    vals = [stat(frame.iloc[rng.integers(0, len(frame), len(frame))]) for _ in range(n)]
    return stat(frame), np.nanpercentile(vals, 2.5), np.nanpercentile(vals, 97.5)

rows = []
for model, L in logs.items():
    ok = L[L.get("error").isna()] if "error" in L else L
    ok = ok.dropna(subset=["roadsTotal"]).copy()
    ok["driven_before"] = ok.roadsTotal - ok.undrivenBefore.apply(len)
    ok["driven_after"] = ok.roadsTotal - ok.undrivenAfter.apply(len)
    ok["maxh_before"] = ok.hoursBefore.apply(max); ok["maxh_after"] = ok.hoursAfter.apply(max)
    for label, stat in [
        ("featured roads driven, before road pass (%)", lambda f: 100 * f.driven_before.sum() / f.roadsTotal.sum()),
        ("featured roads driven, after road pass (%)", lambda f: 100 * f.driven_after.sum() / f.roadsTotal.sum()),
        ("trips with a day over the limit, before (%)", lambda f: 100 * (f.longBefore > 0).mean()),
        ("trips with a day over the limit, after (%)", lambda f: 100 * (f.longAfter > 0).mean()),
        ("longest day before day-split (h)", lambda f: f.maxh_before.mean()),
        ("longest day after day-split (h)", lambda f: f.maxh_after.mean()),
        ("distance saved by reordering stops (km, mean)", lambda f: f.viterbiKmSaved.mean()),
    ]:
        v, lo, hi = boot(ok, stat)
        rows.append(dict(model=model, n=len(ok), metric=label, value=v, lo=lo, hi=hi))
res = pd.DataFrame(rows)
print({m: f"{len(L)} requests, {len(L) - len(L[L.get('error').isna()]) if 'error' in L else 0} failed" for m, L in logs.items()})
res.pivot(index="metric", columns="model", values="value").round(1)
""")

code("""
pairs = [("featured roads driven, before road pass (%)", "featured roads driven, after road pass (%)", "Featured roads driven (%)"),
         ("trips with a day over the limit, before (%)", "trips with a day over the limit, after (%)", "Trips with an over-limit day (%)"),
         ("longest day before day-split (h)", "longest day after day-split (h)", "Mean longest day (h)")]
fig, axs = plt.subplots(1, 3, figsize=(15, 4))
for ax, (b, a, ttl) in zip(axs, pairs):
    for j, (model, g) in enumerate(res.groupby("model")):
        for k, (lab, m) in enumerate([("before", b), ("after", a)]):
            r = g[g.metric == m].iloc[0]
            x = j + (k - .5) * .35
            ax.bar(x, r.value, .33, color=["#b8c4cf", "#2f6f9f"][k], label=lab if j == 0 else None)
            ax.errorbar(x, r.value, yerr=[[r.value - r.lo], [r.hi - r.value]], c="k", lw=1, capsize=3)
    ax.set_xticks(range(len(logs))); ax.set_xticklabels(list(logs), fontsize=8); ax.set_title(ttl)
axs[0].legend(); plt.tight_layout(); plt.show()
""")

md("""
Read it as an ablation: each bar pair is the same requests before and after one pipeline stage. Both stages move the
numbers in the intended direction: more featured roads driven after the road pass (about +3 and +10 points), and fewer
trips with an over-limit day after the day split (about 19% down to 4% and 12%). But the intervals overlap, so with 30
requests this is evidence of direction, not proof of size. Running each request several times (`--repeat`) would narrow
them. Differences under about 15 points between models are noise.
""")

md("## Summary numbers")

code("""
d = df.dropna(subset=["fast_km"])
print(f"- {len(df)} trips in {df.region.nunique()} regions, median {df.km.median():.0f} km over {df.days.median():.0f} days.")
print(f"- Median scenic detour: {d.detour_km_pct.median():.1f}% more distance, {d.extra_min.median():.0f} extra minutes over the fastest route.")
print(f"- {(df.max_day_h > 8).sum()} trips have a driving day above 8 hours; highest median longest day: {df.groupby('region').max_day_h.median().idxmax()}.")
print(f"- Distance alone explains drive time with cross-validated R2 about {cross_val_score(LinearRegression(), df[['km']], df.hours, cv=cv, scoring='r2').mean():.2f}.")
df.drop(columns=["pred_h", "resid_h"]).to_csv("trip_features.csv", index=False)
print("- Saved the table as trip_features.csv.")
""")

nb = nbf.v4.new_notebook(cells=cells)
nb.metadata["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
ExecutePreprocessor(timeout=600, kernel_name="python3").preprocess(nb, {"metadata": {"path": "analysis"}})
nbf.write(nb, "analysis/trip_analysis.ipynb")
print("wrote analysis/trip_analysis.ipynb")
