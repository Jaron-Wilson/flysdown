/**
 * ADS-B fetching and normalising, shared by two callers that must agree
 * exactly on the output shape:
 *
 *   functions/api/aircraft.js  runs at the Cloudflare edge
 *   tools/relay.mjs            runs on a machine with an ordinary IP address
 *
 * The community aggregators rate-limit by IP, and a Worker egresses from
 * addresses shared with every other Cloudflare customer, so the edge is
 * refused most of the time while the same request from a normal connection
 * always succeeds. The relay exists to close that gap; keeping the
 * normalisation here means a relayed snapshot is byte-for-byte the same shape
 * as a live one.
 */

export const MAX_DIST_NM = 250;
export const USER_AGENT = 'flysdown.jaronwilson.dev (live traffic dashboard; contact jaron@jaronwilson.dev)';

const M_TO_FT = 3.28084;
const MS_TO_KT = 1.943844;
const MS_TO_FPM = 196.8504;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** ADS-B "dbFlags" is a bitmask: 1 military, 2 interesting, 4 PIA, 8 LADD. */
const flag = (dbFlags, bit) => Boolean(num(dbFlags) && (dbFlags & bit));

/** readsb/tar1090 JSON, shared by adsb.fi, adsb.lol and friends. */
export function normaliseReadsb(raw, sourceName) {
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
export function normaliseOpenSky(row, sourceName, now = Date.now()) {
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
export function boundingBox(lat, lon, distNm) {
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
 * Order was measured from a deployed Worker, not guessed. From the edge:
 * adsb.lol answers in ~460 ms but 429s most attempts, adsb.fi serves a
 * Cloudflare bot challenge, and OpenSky does not respond at all. From a
 * normal IP all three behave, and adsb.fi carries the richest fields
 * (aircraft description, operator, year), which is why the relay prefers it.
 */
export const SOURCES = [
  {
    name: 'adsb.lol',
    url: (lat, lon, dist) => `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
    parse: (json, name) => (json.ac || []).map((raw) => normaliseReadsb(raw, name)),
    timeoutMs: 9000,
    retries: 4,
  },
  {
    name: 'adsb.fi',
    url: (lat, lon, dist) => `https://opendata.adsb.fi/api/v2/lat/${lat}/lon/${lon}/dist/${dist}`,
    parse: (json, name) => (json.aircraft || []).map((raw) => normaliseReadsb(raw, name)),
    timeoutMs: 9000,
  },
  {
    name: 'opensky',
    url: (lat, lon, dist) => {
      const box = boundingBox(Number(lat), Number(lon), dist);
      return `https://opensky-network.org/api/states/all?lamin=${box.lamin.toFixed(4)}&lomin=${box.lomin.toFixed(4)}&lamax=${box.lamax.toFixed(4)}&lomax=${box.lomax.toFixed(4)}`;
    },
    parse: (json, name) => (json.states || []).map((row) => normaliseOpenSky(row, name)),
    timeoutMs: 6000,
  },
];

/** Relay-side ordering: richest data first, since nothing is blocking us. */
export const RELAY_SOURCE_ORDER = ['adsb.fi', 'adsb.lol', 'opensky'];

export const quantise = (value, step) => Math.round(value / step) * step;

export function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Canonical request area. Quantising means nearby viewers share one cache
 * entry and one relay region instead of each pulling their own.
 */
export function canonicalRegion(params) {
  const lat = quantise(clampNumber(params.get('lat'), -90, 90, 38.9), 0.1).toFixed(1);
  const lon = quantise(clampNumber(params.get('lon'), -180, 180, -77.0), 0.1).toFixed(1);
  const dist = Math.max(25, quantise(clampNumber(params.get('dist'), 1, MAX_DIST_NM, 150), 25));
  return { lat, lon, dist, key: `aircraft:${lat}:${lon}:${dist}` };
}

/** Fetch one source with a jittered retry on 429. Returns normalised aircraft. */
export async function fetchSource(source, lat, lon, dist, { fetchImpl = fetch } = {}) {
  let response = null;
  const attempts = source.retries ?? 1;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    response = await fetchImpl(source.url(lat, lon, dist), {
      headers: { accept: 'application/json', 'accept-encoding': 'gzip', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(source.timeoutMs ?? 9000),
    });
    if (response.status !== 429 || attempt === attempts) break;
    await new Promise((resolve) => setTimeout(resolve, 200 * attempt + Math.random() * 300));
  }

  if (!response.ok) {
    const snippet = (await response.text().catch(() => '')).slice(0, 160).replace(/\s+/g, ' ');
    const error = new Error(`HTTP ${response.status}${snippet ? ` - ${snippet}` : ''}`);
    error.status = response.status;
    throw error;
  }

  return source.parse(await response.json(), source.name).filter(Boolean);
}
