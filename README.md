# flysdown

Live aircraft (ADS-B) and vessel (AIS) tracking on one map, with a detection
engine that dead-reckons every target forward and warns when something is
heading into restricted airspace.

- Production: https://flysdown.jaronwilson.dev
- Pages deployment URL behind it: https://flysdown.pages.dev

## Documentation

`docs/flysdown-paper.md` is a full write-up of how the system works: the data
sources and their quirks, the architecture, the detection mathematics, the
airspace pipeline, the visual encoding, the verification, and a provenance
table separating what was measured from what is documented or standardized.
It is authored by Jaron M. Wilson and Claude (Anthropic), with an author
contributions section stating who did what, three figures captured from the
live system by `npm run figures`, and a contents list.
`docs/flysdown-paper.pdf` is the same thing paginated (11 pages with figures),
typeset in the same palette and type as jaronwilson.dev and jaronwilson.org.
`docs/flysdown-linkedin.pdf` is a 10 slide square carousel of the same story,
sized for LinkedIn's document posts, which render a PDF one page per card.

```bash
npm run figures -- <url> docs/figures  # the paper's three figures
npm run paper                          # docs/flysdown-paper.pdf
npm run shots -- <url> tmp/deck        # screenshots the deck embeds
npm run linkedin -- tmp/deck         # docs/flysdown-linkedin.pdf
npm run linkedin -- tmp/deck docs/flysdown-linkedin.pdf --png tmp/slides
```

The last form also writes each slide as a PNG, for anywhere that wants images
rather than a document.

The dashboard itself uses those sites' own dark tokens (paper `#17150f`,
surface `#201d16`, accent `#d97a4a`) with Fraunces and Inter, so the three
read as one person. The brand accent stays in the chrome and never touches the
map: it is too close to the vessel orange to be told apart.

## What it does

- Plots live aircraft and ships on one dark map. Aircraft are colored by
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
- Is laid out to be found your way around: a tabbed left rail (Overview,
  Filters, Areas) instead of one long scroll, a first-visit welcome card with
  three quick starts, a floating "Pin this view" on the map, and on phones a
  bottom tab bar that shows one view at a time with an alert count.
- Tracks only the area on screen by default. The upstreams are queried with a
  center and a radius, which always covers more than the visible rectangle, so
  everything outside the viewport is filtered out of the map, the counts, the
  alerts and the table.
- Or pins the tracking area. Draw up to four circles or boxes and those areas
  keep loading while you scroll the map anywhere else, with their contacts
  staying in the counts and the alerts even when off screen.
- Pauses each feed on its own, so the aircraft picture can be frozen for
  inspection while the ships keep moving.
- Warns when two vessels are converging: the projected Closest Point of
  Approach and the time to it, with a settable CPA limit, the same alarm model
  ARPA radar uses. Moored and anchored ships are excluded, so a harbor does not
  drown the feed.
- Shows a selected flight's history and its route: the track this system has
  actually observed, drawn and extended for as long as the target stays
  selected, plus the published origin and destination airports as great circles
  with distance flown, distance remaining and an arrival estimate. ADS-B does
  not carry a schedule, so routes come from adsbdb, cached hard at the edge.
- Timestamps every contact. Each target's age combines how long ago the
  receiver network last heard from it with how long ago we fetched that answer,
  so nothing claims to be fresher than it is. Contacts fade as their position
  goes stale, and the detail panel, tooltip and data table all show the age.
- Shows its own health: which path served the data (relay or direct), how old
  that data is, when it was last polled, and whether what you are looking at is
  live or the last good picture.

## Architecture

```
browser (public/)                     Cloudflare edge (functions/)         upstreams
-----------------                     ----------------------------         ---------
app.js        orchestration           /api/aircraft                        adsb.lol
  js/feeds    polling + history  -->    normalize, quantize, cache   -->    adsb.fi
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
| Flight routes | [adsbdb](https://github.com/mrjackwills/adsbdb) | Origin and destination airports for airline callsigns. ADS-B carries no schedule. |
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

## The relay, and why ADS-B needs one

The AIS feed works fine from the edge. The ADS-B aggregators do not, because
they rate-limit by IP and a Worker egresses from addresses shared with every
other Cloudflare customer. Measured from the deployed Worker:

| Upstream | From the edge | From an ordinary IP |
| --- | --- | --- |
| adsb.lol | 200 in ~460 ms, but 429 on five to seven attempts in eight | works every time |
| adsb.fi | 403, a Cloudflare bot challenge page | works every time, richest fields |
| OpenSky | 522, no response after ~20 s (4 attempts in 4) | works, 0.5 s |

None of them send CORS headers, so the browser cannot fetch them directly
either. The constraint is the shared egress address, not the choice of source,
so switching sources does not fix it. What fixes it is moving the fetch.

**`tools/relay.mjs`** runs wherever you have a normal connection. It asks the
site which areas people are currently looking at, fetches those from the
aggregators, and pushes the snapshots back into Cloudflare D1, which
`/api/aircraft` reads first. It is demand driven, so it follows the map rather
than polling a fixed list, and when it is running the edge never touches an
upstream at all, which is both reliable and considerably politer.

```
browser ---> /api/aircraft ---> D1 snapshot (fresh)         <--- relay pushes
                 |                                               every 8 s
                 +--> aggregators directly (usually refused)
                 +--> last known good, labeled stale with its age
```

### Running it

```bash
npm run relay:once          # one cycle, prints what it found
npm run relay               # loop in the foreground

# kept alive across crashes:
forever start --uid flysdown-relay -a -l relay.log tools/relay.mjs
forever list
forever stop flysdown-relay
tail -f relay.log
```

The token lives in `.env.relay` (gitignored) and must match the `RELAY_TOKEN`
secret on the Pages project. To rotate it:

```bash
printf '%s' "<new token>" | npx wrangler pages secret put RELAY_TOKEN --project-name flysdown
printf 'RELAY_TOKEN=%s\n' "<new token>" > .env.relay
```

To survive a reboot, a systemd user unit is the tidier option:

```ini
# ~/.config/systemd/user/flysdown-relay.service
[Unit]
Description=flysdown ADS-B relay
After=network-online.target

[Service]
WorkingDirectory=%h/flysdown
ExecStart=/usr/bin/env node tools/relay.mjs
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now flysdown-relay
loginctl enable-linger "$USER"     # so it runs without an active login
```

### If the relay stops

Nothing breaks. `/api/aircraft` falls back to the aggregators, then to the last
known good picture held for five minutes, and the map says how old what it is
showing is. The site degrades to intermittent rather than to empty.

### Write budget

D1's free allowance is 100,000 row writes a day. The relay writes one row per
region per cycle: four regions at eight seconds is about 43,000 a day. The
endpoint also records which regions are being viewed, throttled to one write
per region every two minutes, and housekeeping sweeps run on about one relay
poll in twenty. Raise `--interval` if that ever gets close.

### Relay endpoints

`GET /api/relay` lists the regions being viewed, with the age of each stored
snapshot. `POST /api/relay` stores a snapshot. Both require
`Authorization: Bearer $RELAY_TOKEN` and are for the poller only.

## Custom domain

The Pages project is `flysdown`, and `flysdown.jaronwilson.dev` is attached to
it as a custom domain, with the CNAME and certificate managed by Cloudflare.
Both hostnames serve the same deployment, so the `pages.dev` URL stays useful
for checking a build before the domain picks it up.

The wrangler OAuth token on this machine is zone read only, so it cannot add or
change that DNS record: a future domain change is a dashboard step (Workers and
Pages, flysdown, Custom domains).

## Running it

```bash
npm install
npm run dev        # wrangler pages dev, http://127.0.0.1:8795
npm test           # detection engine unit tests, no network
npm run deploy     # wrangler pages deploy
npm run relay      # ADS-B relay, see above
```

Local development needs no relay: requests come from your own address, so the
aggregators answer directly.

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

## Color

Palette choices are in `public/js/palette.js` with the reasoning attached. The
altitude ramp, the aircraft/vessel identity colors and the zone kind colors
were each run through a contrast and color-vision validator against this
page's dark surface. Zone kind is carried by outline dash pattern as well as
hue, and every alert pairs its status color with a glyph and the severity word,
because red against green is the one pair color vision cannot be relied on.
