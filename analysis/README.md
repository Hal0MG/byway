# Trip data analysis

A Python notebook that treats the 74 ready-made trips in `data/presets.json` as a dataset: trip size, driving-day load,
the cost of the scenic route against the fastest one, road type and climbing by region (countries from a point-in-polygon
lookup), what the planner's pipeline fixes (from the saved eval runs in `eval/results`), a drive-time model (linear
regression and random forest, cross validated) and k-means clustering.

- `trip_analysis.ipynb`: the notebook, with outputs saved, so GitHub shows it as is.
- `trip_features.csv`: the table it builds, one row per trip.
- `build_notebook.py`: rebuilds and runs the notebook. From the repo root: `pip install -r analysis/requirements.txt`, then `python analysis/build_notebook.py`.
