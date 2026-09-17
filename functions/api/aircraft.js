/**
 * GET /api/aircraft?lat=<deg>&lon=<deg>&dist=<nm>
 *
 * Proxies community ADS-B aggregators and returns one normalised schema, so
 * the browser never talks to an upstream directly (the upstreams send no CORS
 * headers, so it could not anyway) and so one shared edge cache entry serves
 * every viewer instead of one request per viewer.
 *
 * Sources are tried in order and the first success wins. They are deliberately
 * different projects: community aggregators rate-limit or block by IP, and a
 * Worker egresses from shared Cloudflare addresses, so any single upstream can
 * refuse us for reasons that have nothing to do with this site.
 */

const MAX_DIST_NM = 250;
const CACHE_SECONDS = 6;
// How long a last-known-good answer stays usable when every upstream refuses.
// Community feeds rate-limit by IP and a Worker shares its address with the
// world, so a transient 429 must not blank the map.
const LAST_GOOD_SECONDS = 300;
const USER_AGENT = 'flysdown.jaronwilson.dev (live traffic dashboard; contact jaron@jaronwilson.dev)';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const flag = (dbFlags, bit) => Boolean(num(dbFlags) && (dbFlags & bit));

const M_TO_FT = 3.28084;
const MS_TO_KT = 1.943844;
const MS_TO_FPM = 196.8504;

/** readsb/tar1090 JSON, shared by adsb.fi, adsb.lol and friends. */
function normaliseReadsb(raw, sourceName) {
  const lat = num(raw.lat);
  const lon = num(raw.lon);
  if (lat === null || lon === null) return null;

  const onGround = raw.alt_baro === 'ground' || raw.alt_geom === 'ground';
  const alt = onGround ? 0 : num(raw.alt_baro) ?? num(raw.alt_geom);
  const track = num(raw.track) ?? num(raw.true_heading) ?? num(raw.mag_heading);
  const callsign = (raw.flight || '').trim();

  return {
    id: raw.hex,
    kind: 'aircraft',
    callsign: callsign || null,
    label: callsign || raw.r || raw.hex,
    registration: raw.r || null,
    typeCode: raw.t || null,
    typeDesc: raw.desc || null,
    operator: raw.ownOp || null,
    year: raw.year || null,
    lat,
    lon,
    alt,
    altGeom: onGround ? 0 : num(raw.alt_geom),
    onGround,
    groundSpeed: num(raw.gs),
    track,
    verticalRate: num(raw.baro_rate) ?? num(raw.geom_rate),
    squawk: raw.squawk || null,
    emergency: raw.emergency && raw.emergency !== 'none' ? raw.emergency : null,
    category: raw.category || null,
    military: flag(raw.dbFlags, 1),
    interesting: flag(raw.dbFlags, 2),
    pia: flag(raw.dbFlags, 4),
    ladd: flag(raw.dbFlags, 8),
    seen: num(raw.seen),
    seenPos: num(raw.seen_pos),
    rssi: num(raw.rssi),
    messages: num(raw.messages),
    positionSource: raw.type || null,
    source: sourceName,
  };
}

/** OpenSky returns positional arrays in SI units. */
function normaliseOpenSky(row, sourceName, now) {
  const [icao24, callsign, , timePosition, lastContact, lon, lat, baroAltM, onGround, velocityMs, trueTrack, vsMs, , geoAltM, squawk] = row;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const alt = onGround ? 0 : num(baroAltM) !== null ? baroAltM * M_TO_FT : num(geoAltM) !== null ? geoAltM * M_TO_FT : null;
  const trimmed = (callsign || '').trim();

  return {
    id: icao24,
    kind: 'aircraft',
    callsign: trimmed || null,
    label: trimmed || icao24,
    registration: null,
    typeCode: null,
    typeDesc: null,
    operator: null,
    year: null,
    lat,
    lon,
    alt: alt === null ? null : Math.round(alt),
    altGeom: num(geoAltM) === null ? null : Math.round(geoAltM * M_TO_FT),
    onGround: Boolean(onGround),
    groundSpeed: num(velocityMs) === null ? null : Math.round(velocityMs * MS_TO_KT),
    track: num(trueTrack),
    verticalRate: num(vsMs) === null ? null : Math.round(vsMs * MS_TO_FPM),
    squawk: squawk || null,
    emergency: null,
    category: null,
    military: false,
    interesting: false,
    pia: false,
    ladd: false,
    seen: num(lastContact) === null ? null : Math.max(0, Math.round(now / 1000 - lastContact)),
    seenPos: num(timePosition) === null ? null : Math.max(0, Math.round(now / 1000 - timePosition)),
    rssi: null,
    messages: null,
    positionSource: 'opensky',
    source: sourceName,
  };
}

/** Degrees of latitude/longitude covering a radius in nautical miles. */
function boundingBox(lat, lon, distNm) {
  const dLat = distNm / 60;
  const dLon = distNm / (60 * Math.max(0.1, Math.cos((lat * Math.PI) / 180)));
  return {
    lamin: Math.max(-90, lat - dLat),
    lamax: Math.min(90, lat + dLat),
    lomin: Math.max(-180, lon - dLon),
    lomax: Math.min(180, lon + dLon),
  };
}

/**
 * Order matters, and it was measured from a deployed Worker rather than
 * guessed:
 *   adsb.lol  answers in ~460 ms from the edge, and 429s occasionally when the
 *             shared Cloudflare egress address is busy. Primary.
 *   adsb.fi   serves a Cloudflare bot challenge (403) to Worker subrequests,
 *             so it only ever works from local dev or a normal IP. Kept as a
 *             fallback because it costs 4 ms to find out.
 *   opensky   refuses the connection from the edge (522 after ~20 s), so it is
 *             last and on a short timeout to keep the failure chain quick.
 */
const SOURCES = [
  {
    name: 'adsb.lol',
    url: (lat, lon, dist) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
    parse: (json, name) => (json.ac || []).map((raw) => normaliseReadsb(raw, name)),
    timeoutMs: 9000,
  },
  {
    name: 'adsb.fi',
    url: (lat, lon, dist) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
    parse: (json, name) => (json.aircraft || []).map((raw) => normaliseReadsb(raw, name)),
    timeoutMs: 9000,
  },
  {
    name: 'opensky',
    timeoutMs: 6000,
    url: (lat, lon, dist) => {
      const box = boundingBox(Number(lat), Number(lon), dist);
      return `https://opensky-network.org/api/states/all?lamin=${box.lamin.toFixed(4)}&lomin=${box.lomin.toFixed(4)}&lamax=${box.lamax.toFixed(4)}&lomax=${box.lomax.toFixed(4)}`;
    },
    parse: (json, name) => (json.states || []).map((row) => normaliseOpenSky(row, name, Date.now())),
  },
];

function quantise(value, step) {
  return Math.round(value / step) * step;
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export const onRequestGet = async (context) => {
  const { request, waitUntil } = context;
  const params = new URL(request.url).searchParams;

  const lat = quantise(clampNumber(params.get('lat'), -90, 90, 38.9), 0.1).toFixed(1);
  const lon = quantise(clampNumber(params.get('lon'), -180, 180, -77.0), 0.1).toFixed(1);
  const dist = Math.max(25, quantise(clampNumber(params.get('dist'), 1, MAX_DIST_NM, 150), 25));
  const only = params.get('src');

  const cache = caches.default;
  const base = `lat=${lat}&lon=${lon}&dist=${dist}&src=${only || 'auto'}`;
  const freshKey = new Request(`https://flysdown.internal/aircraft?${base}`, { method: 'GET' });
  const lastGoodKey = new Request(`https://flysdown.internal/aircraft-last?${base}`, { method: 'GET' });

  const cached = await cache.match(freshKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set('x-flysdown-cache', 'hit');
    return hit;
  }

  const errors = [];
  for (const source of SOURCES) {
    if (only && source.name !== only) continue;
    try {
      const upstream = await fetch(source.url(lat, lon, dist), {
        headers: { accept: 'application/json', 'accept-encoding': 'gzip', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(source.timeoutMs ?? 9000),
      });
      if (!upstream.ok) {
        // Keep a snippet: these upstreams explain refusals in the body, and
        // without it a 403 is indistinguishable from a 403.
        const snippet = (await upstream.text().catch(() => '')).slice(0, 160).replace(/\s+/g, ' ');
        errors.push(`${source.name}: HTTP ${upstream.status}${snippet ? ` - ${snippet}` : ''}`);
        continue;
      }
      const aircraft = source.parse(await upstream.json(), source.name).filter(Boolean);

      const body = JSON.stringify({
        ok: true,
        source: source.name,
        fetchedAt: Date.now(),
        coverage: { lat: Number(lat), lon: Number(lon), distNm: dist },
        count: aircraft.length,
        aircraft,
        degraded: errors.length ? errors : undefined,
      });

      const headers = {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=0, s-maxage=${CACHE_SECONDS}`,
        'x-flysdown-cache': 'miss',
        'x-flysdown-source': source.name,
      };
      waitUntil(cache.put(freshKey, new Response(body, { headers })));
      waitUntil(cache.put(lastGoodKey, new Response(body, {
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, s-maxage=${LAST_GOOD_SECONDS}` },
      })));
      return new Response(body, { headers });
    } catch (err) {
      errors.push(`${source.name}: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
    }
  }

  // Every upstream refused. Serve the last good answer, clearly marked, rather
  // than an empty map.
  const lastGood = await cache.match(lastGoodKey);
  if (lastGood) {
    try {
      const json = await lastGood.json();
      return new Response(
        JSON.stringify({ ...json, stale: true, ageMs: Date.now() - json.fetchedAt, degraded: errors }),
        {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'public, max-age=0, s-maxage=8',
            'x-flysdown-cache': 'stale',
          },
        }
      );
    } catch {
      // fall through to the error below
    }
  }

  return new Response(JSON.stringify({ ok: false, error: 'all ADS-B upstreams refused the request', detail: errors }), {
    status: 502,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=0, s-maxage=8' },
  });
};
