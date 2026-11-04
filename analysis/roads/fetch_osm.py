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


# Regions that aren't one ISO area: several areas, each tagged with its country (for the search language)
REGIONS = {
    "EU-AL": [  # the Alps: Switzerland, western Austria, northern Italy, the French Alps
        ("CH", '["ISO3166-1"="CH"]'), ("AT", '["ISO3166-2"="AT-7"]'), ("AT", '["ISO3166-2"="AT-8"]'),
        ("IT", '["ISO3166-2"="IT-32"]'), ("IT", '["ISO3166-2"="IT-23"]'),
        ("FR", '["ISO3166-2"="FR-73"]'), ("FR", '["ISO3166-2"="FR-74"]'), ("FR", '["ISO3166-2"="FR-05"]'),
    ],
}


def fetch(out_file, body, areas):
    """Runs `body` (with {a} for the area set) over each area, merges the elements, tags each with its country."""
    if out_file.exists():
        return
    elements, seen = [], set()
    for n, (country, sel) in enumerate(areas):
        part = CACHE / f"{out_file.stem}-part{n}.json"
        if not part.exists():
            print(f"  {out_file.stem} {country}{sel} ...")
            part.write_text(json.dumps(overpass(body.format(a=f"area{sel}->.a;"))))
        for e in json.loads(part.read_text())["elements"]:
            if (e["type"], e["id"]) not in seen:
                seen.add((e["type"], e["id"]))
                e["area"] = country
                elements.append(e)
    out_file.write_text(json.dumps({"elements": elements}))
    for n in range(len(areas)):
        (CACHE / f"{out_file.stem}-part{n}.json").unlink(missing_ok=True)


def main(iso):
    CACHE.mkdir(exist_ok=True)
    areas = REGIONS.get(iso) or [("", f'["ISO3166-2"="{iso}"]')]
    fetch(CACHE / f"{iso}-roads.json",
          '[out:json][timeout:500];{a}way(area.a)[highway~"^(trunk|primary|secondary|tertiary)$"];out tags geom;', areas)
    # designated byways: national and state networks ("US:CO:Scenic", "byway:historic", ...)
    fetch(CACHE / f"{iso}-byways.json", '[out:json][timeout:300];{a}rel(area.a)[route=road][network~"Scenic|byway|Byway",i];out body;', areas)
    # names for searches: mountain passes, and towns to say where a stretch runs ("Telluride to Rico")
    fetch(CACHE / f"{iso}-places.json", '[out:json][timeout:300];{a}(node(area.a)[mountain_pass=yes][name];node(area.a)[natural=saddle][name];'
          'node(area.a)[place~"^(city|town|village|hamlet)$"][name];);out;', areas)
    for f in (f"{iso}-roads.json", f"{iso}-byways.json", f"{iso}-places.json"):
        print(f, len(json.loads((CACHE / f).read_text())["elements"]), "elements")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "US-CO")
