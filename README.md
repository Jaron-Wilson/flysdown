# flysdown

Live aircraft (ADS-B) and vessel (AIS) tracking on one map, with a detection
engine that dead-reckons every target forward and warns when something is
heading into restricted airspace.

- Production: https://flysdown.jaronwilson.dev (see "Custom domain" below)
- Cloudflare Pages: https://flysdown.pages.dev

## What it does

- Plots live aircraft and ships on one dark map. Aircraft are coloured by
  altitude on a single-hue ramp, vessels by whether they are under way.
- Runs a rules engine over every target on every update:
  - **Zone incursion**: already inside a restricted zone, with altitude checked
    against the zone's published floor and ceiling.
  - **Projected zone entry**: dead-reckons the current track and speed forward
    (default 10 minutes) and reports the time to the boundary. Severity rises
    as the estimate closes: under 2 minutes is critical, under 6 is serious.
  - **Emergency squawks**: 7500 unlawful interference, 7600 radio failure,
    7700 general emergency, plus the ADS-B emergency field.
  - **Rapid descent**: more than 4,000 ft/min, or 3,000 ft/min below 10,000 ft.
  - **Orbit or hold**: a target that has turned through more than 270 degrees
    while staying inside a 12 NM footprint.
- Lets you draw your own watch zones (circle or polygon) in the browser, set
  their floor, ceiling and whether they apply to aircraft, vessels or both,
  then export or import them as GeoJSON. Drawn zones persist in localStorage.
- Shows its own health: which upstream answered, how long ago, and whether what
  you are looking at is live or the last good picture.

## Architecture

```
browser (public/)                     Cloudflare edge (functions/)         upstreams
-----------------                     ----------------------------         ---------
app.js        orchestration           /api/aircraft                        adsb.lol
  js/feeds    polling + history  -->    normalise, quantise, cache   -->    adsb.fi
  js/detect   rules engine              stale-while-error                   opensky
  js/geo      geodesy                 /api/vessels                         Digitraffic
  js/zones    zone store        -->     merge positions + vessel     -->   (Fintraffic)
  js/map      MapLibre layers           metadata, cache
  js/draw     zone drawing
  js/ui       panels
```

No build step and no framework. Plain ES modules, MapLibre GL JS vendored in
`public/vendor/`, and Cloudflare Pages Functions for the two API routes.

`js/detect.js` and `js/geo.js` are pure functions with no DOM or map
dependency, so the same rules can move to a Worker on a cron trigger later and
alert with nobody watching the page.

## Data sources

| What | Source | Notes |
| --- | --- | --- |
| Aircraft positions | [adsb.lol](https://adsb.lol), [adsb.fi](https://adsb.fi), [OpenSky](https://opensky-network.org) | Community aggregators, no API key. Tried in that order. |
| Vessel positions | [Fintraffic Digitraffic](https://www.digitraffic.fi/en/marine-traffic/) | CC BY 4.0. The only genuinely keyless live AIS feed found, covering the Baltic and Gulf of Finland. |
| Prohibited airspace | [FAA Special Use Airspace](https://adds-faa.opendata.arcgis.com/) | Real published geometry, floors and ceilings. |
| DC SFRA | 14 CFR 93 subpart V | Defined in regulation as a 30 NM radius of the DCA VOR, so the circle is exact. |
| Disney TFRs | FDC 9/3799 | Standing restrictions, surface to 3,000 ft AGL. |
| Basemap | [OpenFreeMap](https://openfreemap.org) | Keyless OSM vector tiles, dark style. |

Zones are regenerated with:

```bash
node tools/fetch-zones.mjs     # rewrites public/data/zones.json
```

The FAA reissues that dataset every 56 days. The script simplifies the
geometry: the FAA ships P-56B, a one mile circle, as a 6,285 point polygon,
which becomes 17 points here with no visible difference.

## Known constraint: ADS-B from Cloudflare's IPs

The AIS feed works fine from the edge. The ADS-B aggregators are harder,
because they rate-limit by IP and a Worker egresses from addresses shared with
every other Cloudflare customer. Measured from the deployed Worker:

| Upstream | Result from the edge | Result from a normal IP |
| --- | --- | --- |
| adsb.lol | 200 in ~460 ms, but HTTP 429 on roughly 7 attempts in 8 | works |
| adsb.fi | HTTP 403, a Cloudflare bot challenge page | works |
| OpenSky | HTTP 522, connection refused after ~20 s | works, 0.5 s |

So the endpoint caches a last-known-good answer for 5 minutes and serves it,
clearly marked stale with its age, whenever every upstream refuses. In practice
the map fills within a minute and then refreshes in bursts rather than smoothly.
The UI says so rather than pretending.

Three ways to make it properly live, in order of effort:

1. **Ask for access.** airplanes.live and adsb.lol both grant higher-volume
   access to described projects. That is an email, and then one line of config.
2. **Relay from a normal IP.** Any always-on box polls the aggregators (which
   works fine from a residential address) and pushes snapshots the Worker
   reads. Needs a store the edge can read: a Durable Object works on the free
   plan, Workers KV needs the paid plan for this write rate.
3. **Leave it.** Stale-but-labelled is honest and costs nothing.

Local development has none of this problem, because requests come from your own
address: `npm run dev` shows 130 or so aircraft over Washington immediately.

## Custom domain

The Pages project is `flysdown`. Attaching `flysdown.jaronwilson.dev` needs one
step in the dashboard (Workers and Pages, flysdown, Custom domains, add
`flysdown.jaronwilson.dev`), because the wrangler OAuth token on this machine is
zone read only and cannot create the DNS record. Cloudflare creates the CNAME
and certificate automatically, the same way `spike.jaronwilson.dev` is attached
to `financeapp-spike`.

## Running it

```bash
npm install
npm run dev        # wrangler pages dev, http://127.0.0.1:8795
npm test           # detection engine unit tests, no network
npm run deploy     # wrangler pages deploy
```

Browser smoke test (loads the page in headless Chromium, fails on any console
error, exercises selection, region switching and zone drawing, writes
screenshots):

```bash
npx playwright install chromium    # once
node tools/smoke.mjs http://127.0.0.1:8795/ tmp
```

## What the projection does and does not do

It is a straight line. It takes the target's current position, track and ground
speed, extrapolates altitude from the vertical rate, and asks where that puts
it. It models no turns, no wind, no flight plan and no ATC instruction, and it
stops projecting a descending aircraft at ground level rather than below it.
That is the right question for a geofence warning ("if nothing changes, what
happens") and the wrong tool for predicting what an aircraft will actually do.

Zone checks compare barometric altitude in feet MSL against each zone's floor
and ceiling. Zones whose published limits are AGL are flagged `agl: true`, and
over terrain that comparison is approximate.

Advisory zones (the DC SFRA) are drawn and reported in a target's zone checks
but never raise alerts, because transiting the SFRA with a clearance is routine
and alerting on it buried the genuine incursions.

**Not for navigation.** Nothing here is a source of truth for flight or
maritime operations.

## Colour

Palette choices are in `public/js/palette.js` with the reasoning attached. The
altitude ramp, the aircraft/vessel identity colours and the zone kind colours
were each run through a contrast and colour-vision validator against this
page's dark surface. Zone kind is carried by outline dash pattern as well as
hue, and every alert pairs its status colour with a glyph and the severity word,
because red against green is the one pair colour vision cannot be relied on.
