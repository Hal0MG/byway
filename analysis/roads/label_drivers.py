"""Labels the picked stretches from what drivers say on the web: one Tavily search per stretch, read by Gemini, which
scores driving (separately from scenery) and quotes its evidence. Uses the app's keys in .env and keeps the app's
monthly search count (data/search-usage.json) right, stopping at TAVILY_MONTHLY_LIMIT. Answers are appended to
cache/<region>-driver-labels.jsonl, so a rerun resumes and never searches a stretch twice.

    python analysis/roads/label_drivers.py US-CO [--limit 5]
"""
import json
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[2]
CACHE = Path(__file__).parent / "cache"
USAGE = ROOT / "data" / "search-usage.json"

PROMPT = """You read web search results about one stretch of road and judge what keen drivers (sports cars, motorcycles) say about driving it.

Stretch: {query}
Search results:
{results}

Judge only this stretch. Results about a different road, a town, real estate or traffic news don't count.
Keep driving and scenery apart: "beautiful views" is scenery; curves, switchbacks, "a favourite with riders",
"fun to drive", or on the other side "straight", "boring", "busy with trucks" are driving.

- relevant: do any results describe driving or riding this stretch?
- mentions: how many results do.
- driving: 5 a road keen drivers travel for (twisty, engaging, famous with riders); 4 a good drive worth choosing;
  3 pleasant but unremarkable; 2 dull or busy; 1 one to avoid. 0 when the results don't say.
- scenery: the same 1 to 5 for views, 0 when the results don't say.
- unpaved: do the results say it's gravel, dirt or 4x4 only?
- evidence: the words from the results that most support the driving score, at most 20 words, or "" when 0.
- reason: your reason in at most 20 words."""

SCHEMA = {
    "type": "object",
    "properties": {
        "relevant": {"type": "boolean"}, "mentions": {"type": "integer"},
        "driving": {"type": "integer"}, "scenery": {"type": "integer"}, "unpaved": {"type": "boolean"},
        "evidence": {"type": "string"}, "reason": {"type": "string"},
    },
    "required": ["relevant", "mentions", "driving", "scenery", "unpaved", "evidence", "reason"],
}


def env():
    out = {}
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def post(url, body, headers, timeout=60):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def search(query, key, limit):
    month = date.today().isoformat()[:7]
    usage = json.loads(USAGE.read_text()) if USAGE.exists() else {}
    if usage.get("month") != month:
        usage = {"month": month, "count": 0}
    if usage["count"] >= limit:
        raise SystemExit(f"stopped: this month's searches are at the limit ({limit})")
    d = post("https://api.tavily.com/search", {"query": query, "search_depth": "basic", "max_results": 5, "topic": "general"},
             {"Authorization": f"Bearer {key}"})
    usage["count"] += (d.get("usage") or {}).get("credits", 1)
    USAGE.write_text(json.dumps(usage))
    return [{"url": x["url"], "title": x.get("title") or x["url"], "snippet": str(x.get("content", ""))[:700]} for x in d.get("results", [])]


def judge(query, results, key, models):
    text = "\n\n".join(f"[{i + 1}] {r['title']}\n{r['snippet']}" for i, r in enumerate(results)) or "(no results)"
    body = {"contents": [{"role": "user", "parts": [{"text": PROMPT.format(query=query, results=text)}]}],
            "generationConfig": {"responseMimeType": "application/json", "responseJsonSchema": SCHEMA}}
    # Google's free tier answers "busy" (503) in bursts that can last minutes: back off and go round the models again
    for wait in (0, 20, 60, 120, 240):
        time.sleep(wait)
        for model in models:
            try:
                d = post(f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent", body, {"x-goog-api-key": key}, timeout=120)
                return json.loads(d["candidates"][0]["content"]["parts"][0]["text"]), model
            except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError) as e:
                print(f"  {model}: {getattr(e, 'code', e)}", file=sys.stderr)
    return None, None


def main(iso, limit=None):
    e = env()
    models = [m for m in [e.get("GEMINI_MODEL"), "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-flash-latest"] if m]
    models = list(dict.fromkeys(models))
    cap = int(e.get("TAVILY_MONTHLY_LIMIT", 900))
    picks = pd.read_csv(CACHE / f"{iso}-stretches.csv")
    out = CACHE / f"{iso}-driver-labels.jsonl"
    done = {json.loads(l)["stretch"] for l in out.read_text().splitlines()} if out.exists() else set()
    todo = picks[~picks.stretch.isin(done)]
    if limit:
        todo = todo.head(limit)
    print(f"{len(done)} done, {len(todo)} to go")
    # searches are saved as soon as they're paid for, so a failed verdict never costs a second search
    saved = CACHE / f"{iso}-searches.json"
    searches = json.loads(saved.read_text(encoding="utf-8")) if saved.exists() else {}
    for n, r in enumerate(todo.itertuples(), 1):
        key = str(r.stretch)
        if key not in searches:
            # worded like a review search: "... drive" alone found driver talk for fewer stretches
            searches[key] = search(r.query.removesuffix(" drive") + " driving experience motorcycle ride review", e["TAVILY_API_KEY"], cap)
            saved.write_text(json.dumps(searches), encoding="utf-8")
        results = searches[key]
        verdict, model = judge(r.query, results, e["GEMINI_API_KEY"], models)
        if verdict is None:
            print(f"{n}/{len(todo)} skipped, Gemini busy (run again later): {r.query}")
            continue
        rec = {"stretch": int(r.stretch), "query": r.query, **verdict, "model": model, "sources": [x["url"] for x in results], "results": results}
        with out.open("a", encoding="utf-8") as f:
            f.write(json.dumps(rec) + "\n")
        print(f"{n}/{len(todo)} driving={verdict['driving']} scenery={verdict['scenery']} {r.query}")
        time.sleep(4)  # under Gemini's free per-minute limit


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")  # Windows logs can't print accented place names otherwise
    args = sys.argv[1:]
    lim = int(args[args.index("--limit") + 1]) if "--limit" in args else None
    main(next((a for a in args if a.startswith(("US-", "CA-")) or "-" in a and not a.startswith("--")), "US-CO"), lim)
