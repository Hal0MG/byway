# The public demo

Byway can run as a public website on your own keys. Visitors never see a key or the Setup screen; they get the globe,
the ready-made trips, the map, and a few new trips a day each.

## What demo mode does (`DEMO=1`)

- **No keys for visitors.** The setup routes are switched off, and the keys come from the host's environment, never
  from a file in the repo.
- **Everyone's trips are their own.** A random id in a cookie marks each visitor; they only see, change and delete their
  own trips, and can't make a trip "ready-made". Up to 30 trips each.
- **Daily caps** (reset at midnight UTC), per visitor, per network address (twice a visitor's share) and for the whole
  site, so nobody can use up your free allowances:

  | What | Per visitor | Whole site | Env vars |
  |---|---|---|---|
  | Planning calls (a new trip takes 1 to 4) | 12 | 150 | `DEMO_PLANS_PER_VISITOR`, `DEMO_PLANS_PER_DAY` |
  | Other AI calls (day guides, Ask, road ideas) | 60 | 900 | `DEMO_AI_PER_VISITOR`, `DEMO_AI_PER_DAY` |
  | Routes (OpenRouteService, 2,000 a day) | 200 | 1,500 | `DEMO_ROUTES_PER_VISITOR`, `DEMO_ROUTES_PER_DAY` |
  | Place searches (Nominatim) | 400 | 4,000 | `DEMO_GEOCODES_PER_VISITOR`, `DEMO_GEOCODES_PER_DAY` |
  | Fuel, food and stays (Overpass) | 60 | 800 | `DEMO_ALONG_PER_VISITOR`, `DEMO_ALONG_PER_DAY` |

- **Trips survive the host's sleep.** Render's free plan wipes the disk when the site sleeps (after 15 idle minutes) or
  redeploys. The browser keeps a copy of each trip the visitor saves (`public/demo.js`) and puts it back when the
  server has lost it, so a visitor's trips stay as long as their browser keeps its site data.
- The start screen says it's a demo with a few trips a day.

## Putting it on Render (free)

1. Sign up at https://render.com (free; "Sign in with GitHub" is easiest) and let it see the `Hal0MG/byway` repo.
2. **New > Blueprint**, pick the repo. Render reads `render.yaml` and asks for the four secret values:
   - `GEMINI_API_KEY`, `ORS_API_KEY`, `TAVILY_API_KEY`: your keys (the same as in your `.env`).
   - `CONTACT`: what Wikipedia and OpenStreetMap see as the contact for the site's requests. The demo's web address
     (for example `https://byway.onrender.com`) works and keeps your email out of it.
3. **Apply.** The first build takes a few minutes; the site is at `https://byway.onrender.com` (or the address Render
   shows). Every push to `main` redeploys it.

Don't rename the service in Render's dashboard: the Blueprint finds it by the name in `render.yaml` (`byway`), and if
the names differ it creates a second site. To rename it, change `name:` in `render.yaml` too.

Free plan notes: the site sleeps after 15 minutes without visitors and takes about 30 seconds to wake; 750 free hours a
month is enough for one site running all month.

## Trying demo mode on your computer

Run it from an empty folder so it doesn't touch your own trips (the app writes trips and caches in the folder it runs
from):

```
mkdir demo-test && cd demo-test
DEMO=1 PORT=3002 GEMINI_API_KEY=... ORS_API_KEY=... node ../server.js
```

On Windows PowerShell: `$env:DEMO="1"; $env:PORT="3002"; node ..\server.js` (with the keys set the same way).
