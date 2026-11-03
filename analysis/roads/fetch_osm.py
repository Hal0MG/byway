"""Downloads one region's road network and its scenic byway relations from OpenStreetMap (Overpass), into cache/.

    python analysis/roads/fetch_osm.py US-CO

Roads are trunk to tertiary (no motorways, no residential streets): the roads a scenic drive is made of.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS = "https://overpass-api.de/api/interpreter"
UA = "byway-research (https://github.com/Hal0MG/byway)"
CACHE = Path(__file__).parent / "cache"


def overpass(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    for attempt in range(4):
        try:
            req = urllib.request.Request(OVERPASS, body, {"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=600) as r:
                return json.load(r)
        except Exception as e:  # busy server: wait and retry
            print(f"  overpass failed ({e}), retrying", file=sys.stderr)
            time.sleep(30 * (attempt + 1))
    raise RuntimeError("Overpass kept failing")


def main(iso):
    CACHE.mkdir(exist_ok=True)
    area = f'area["ISO3166-2"="{iso}"]->.a;'
    roads = CACHE / f"{iso}-roads.json"
    if not roads.exists():
        print("roads...")
        q = f'[out:json][timeout:500];{area}way(area.a)[highway~"^(trunk|primary|secondary|tertiary)$"];out tags geom;'
        roads.write_text(json.dumps(overpass(q)))
    byways = CACHE / f"{iso}-byways.json"
    if not byways.exists():
        print("byways...")
        # designated byways: national and state networks ("US:CO:Scenic", "byway:historic", ...)
        q = f'[out:json][timeout:300];{area}rel(area.a)[route=road][network~"Scenic|byway|Byway",i];out body;'
        byways.write_text(json.dumps(overpass(q)))
    places = CACHE / f"{iso}-places.json"
    if not places.exists():
        print("passes and towns...")
        # names for searches: mountain passes, and towns to say where a stretch runs ("Telluride to Rico")
        q = (f'[out:json][timeout:300];{area}(node(area.a)[mountain_pass=yes][name];node(area.a)[natural=saddle][name];'
             f'node(area.a)[place~"^(city|town|village|hamlet)$"][name];);out;')
        places.write_text(json.dumps(overpass(q)))
    for f in (roads, byways, places):
        print(f.name, len(json.loads(f.read_text())["elements"]), "elements")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "US-CO")
