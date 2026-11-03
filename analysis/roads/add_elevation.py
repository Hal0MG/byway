"""Adds terrain to each segment from the public AWS terrain tiles (Terrarium PNGs, zoom 10, about 150 m a pixel, no
key or quota): mean height, relief (top minus bottom) and climbing per km over 8 points along the segment. Tiles are
cached in cache/tiles/.

    python analysis/roads/add_elevation.py US-CO
"""
import io
import json
import math
import sys
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image

CACHE = Path(__file__).parent / "cache"
TILES = CACHE / "tiles"
Z = 10
N = 8


def tile_xy(lon, lat):
    n = 2 ** Z
    x = (lon + 180) / 360 * n
    y = (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n
    return x, y


def load_tile(xy):
    x, y = xy
    f = TILES / f"{Z}-{x}-{y}.png"
    if not f.exists():
        url = f"https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{Z}/{x}/{y}.png"
        with urllib.request.urlopen(url, timeout=60) as r:
            f.write_bytes(r.read())
    a = np.asarray(Image.open(io.BytesIO(f.read_bytes())).convert("RGB"), dtype=float)
    return xy, a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768


def main(iso):
    TILES.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"{iso}-segments.csv"
    df = pd.read_csv(path)
    samples = []
    for c in df.coords:
        pts = json.loads(c)
        idx = np.linspace(0, len(pts) - 1, N).round().astype(int)
        samples.append([tile_xy(*pts[i]) for i in idx])
    need = {(int(x), int(y)) for s in samples for x, y in s}
    print(f"{len(need)} tiles")
    with ThreadPoolExecutor(8) as pool:
        tiles = dict(pool.map(load_tile, need))

    def height(x, y):
        t = tiles[(int(x), int(y))]
        return t[min(255, int((y % 1) * 256)), min(255, int((x % 1) * 256))]

    el = np.array([[height(x, y) for x, y in s] for s in samples])
    df["elev_mean"] = el.mean(1)
    df["relief"] = el.max(1) - el.min(1)
    df["climb_per_km"] = np.clip(np.diff(el, axis=1), 0, None).sum(1) / df.km
    df.to_csv(path, index=False)
    print(df[["elev_mean", "relief", "climb_per_km"]].describe().round(1))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "US-CO")
