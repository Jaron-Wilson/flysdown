/**
 * GET /api/vessels?lat=<deg>&lon=<deg>&radius=<km>
 *
 * AIS proxy + normalizer. The only genuinely keyless live AIS feed is
 * Fintraffic's Digitraffic service (CC BY 4.0), which covers the Baltic /
 * Gulf of Finland. Everything below is written against a provider interface so
 * a global feed (e.g. aisstream.io, which needs a free key and a websocket)
 * can be added as a second provider without touching the client.
 */

const BASE = 'https://meri.digitraffic.fi/api/ais/v1';
const LOCATION_CACHE_SECONDS = 12;
const METADATA_CACHE_SECONDS = 1800;
const MAX_RADIUS_KM = 800;
// Same reasoning as the aircraft endpoint: a refused upstream should show the
// last known picture, marked stale, rather than an empty sea.
const LAST_GOOD_SECONDS = 300;

// Digitraffic answers 406 unless the request advertises gzip support, and it
// asks callers to identify themselves with Digitraffic-User.
const HEADERS = {
  accept: 'application/json',
  'accept-encoding': 'gzip',
  'digitraffic-user': 'flysdown.jaronwilson.dev',
};

/** AIS ship-type code -> human label (ITU-R M.1371 table 53). */
function shipTypeLabel(code) {
  if (typeof code !== 'number' || code <= 0) return 'Unknown';
  if (code >= 20 && code <= 29) return 'Wing in ground';
  if (code === 30) return 'Fishing';
  if (code === 31 || code === 32) return 'Towing';
  if (code === 33) return 'Dredging';
  if (code === 34) return 'Diving ops';
  if (code === 35) return 'Military ops';
  if (code === 36) return 'Sailing';
  if (code === 37) return 'Pleasure craft';
  if (code >= 40 && code <= 49) return 'High-speed craft';
  if (code === 50) return 'Pilot vessel';
  if (code === 51) return 'Search and rescue';
  if (code === 52) return 'Tug';
  if (code === 53) return 'Port tender';
  if (code === 54) return 'Anti-pollution';
  if (code === 55) return 'Law enforcement';
  if (code === 58) return 'Medical transport';
  if (code >= 60 && code <= 69) return 'Passenger';
  if (code >= 70 && code <= 79) return 'Cargo';
  if (code >= 80 && code <= 89) return 'Tanker';
  if (code >= 90 && code <= 99) return 'Other';
  return 'Unknown';
}

/** Coarse class used for icon + color choices on the client. */
function shipClass(code) {
  if (typeof code !== 'number') return 'other';
  if (code >= 80 && code <= 89) return 'tanker';
  if (code >= 70 && code <= 79) return 'cargo';
  if (code >= 60 && code <= 69) return 'passenger';
  if (code === 30) return 'fishing';
  if (code === 35 || code === 55 || code === 51) return 'gov';
  if (code === 36 || code === 37) return 'pleasure';
  if (code === 52 || code === 50 || code === 53) return 'service';
  return 'other';
}

const NAV_STATUS = {
  0: 'Under way using engine',
  1: 'At anchor',
  2: 'Not under command',
  3: 'Restricted maneuverability',
  4: 'Constrained by draft',
  5: 'Moored',
  6: 'Aground',
  7: 'Engaged in fishing',
  8: 'Under way sailing',
  14: 'AIS-SART / emergency',
  15: 'Undefined',
};

/** AIS packs ETA into 20 bits: month(4) day(5) hour(5) minute(6). */
function decodeEta(eta) {
  if (typeof eta !== 'number' || eta <= 0) return null;
  const minute = eta & 0x3f;
  const hour = (eta >> 6) & 0x1f;
  const day = (eta >> 11) & 0x1f;
  const month = (eta >> 16) & 0x0f;
  if (!month || !day || month > 12 || day > 31 || hour > 23 || minute > 59) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(month)}-${pad(day)} ${pad(hour)}:${pad(minute)}Z`;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** AIS sentinel values: cog 360, heading 511, sog 102.3 all mean "not available". */
const sentinel = (v, bad) => (v === null || v === bad ? null : v);

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

async function cachedJson(url, cache, cacheKeyUrl, ttl, waitUntil) {
  const cacheKey = new Request(cacheKeyUrl, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return { json: await cached.json(), cache: 'hit' };

  const upstream = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
  if (!upstream.ok) throw new Error(`digitraffic HTTP ${upstream.status} for ${new URL(url).pathname}`);
  const json = await upstream.json();

  const store = new Response(JSON.stringify(json), {
    headers: { 'content-type': 'application/json', 'cache-control': `public, s-maxage=${ttl}` },
  });
  waitUntil(cache.put(cacheKey, store));
  return { json, cache: 'miss' };
}

export const onRequestGet = async (context) => {
  const { request, waitUntil } = context;
  const params = new URL(request.url).searchParams;
  const cache = caches.default;

  const hasArea = params.has('lat') && params.has('lon');
  const lat = Math.round(clampNumber(params.get('lat'), -90, 90, 60.15) * 2) / 2;
  const lon = Math.round(clampNumber(params.get('lon'), -180, 180, 24.95) * 2) / 2;
  const radiusKm = Math.round(clampNumber(params.get('radius'), 5, MAX_RADIUS_KM, 300) / 25) * 25;

  const locationsUrl = hasArea
    ? `${BASE}/locations?latitude=${lat}&longitude=${lon}&radius=${radiusKm}`
    : `${BASE}/locations`;
  const locationsKey = hasArea
    ? `https://flysdown.internal/ais/locations?lat=${lat}&lon=${lon}&r=${radiusKm}`
    : 'https://flysdown.internal/ais/locations?all=1';

  const lastGoodKey = new Request(`https://flysdown.internal/vessels-last?${locationsKey.split('?')[1]}`, { method: 'GET' });

  try {
    const [locations, metadata] = await Promise.all([
      cachedJson(locationsUrl, cache, locationsKey, LOCATION_CACHE_SECONDS, waitUntil),
      cachedJson(`${BASE}/vessels`, cache, 'https://flysdown.internal/ais/vessels', METADATA_CACHE_SECONDS, waitUntil),
    ]);

    const byMmsi = new Map();
    for (const vessel of metadata.json || []) byMmsi.set(vessel.mmsi, vessel);

    const vessels = (locations.json.features || [])
      .map((feature) => {
        const [vlon, vlat] = feature.geometry?.coordinates || [];
        if (!Number.isFinite(vlat) || !Number.isFinite(vlon)) return null;
        const p = feature.properties || {};
        const meta = byMmsi.get(p.mmsi) || {};
        const name = (meta.name || '').trim();

        return {
          id: String(p.mmsi),
          kind: 'vessel',
          mmsi: p.mmsi,
          label: name || `MMSI ${p.mmsi}`,
          name: name || null,
          callsign: (meta.callSign || '').trim() || null,
          imo: meta.imo || null,
          shipType: num(meta.shipType),
          typeDesc: shipTypeLabel(num(meta.shipType)),
          shipClass: shipClass(num(meta.shipType)),
          destination: (meta.destination || '').trim() || null,
          eta: decodeEta(meta.eta),
          draftM: num(meta.draught) ? meta.draught / 10 : null,
          lengthM: num(meta.referencePointA) && num(meta.referencePointB)
            ? meta.referencePointA + meta.referencePointB
            : null,
          lat: vlat,
          lon: vlon,
          sog: sentinel(num(p.sog), 102.3),
          cog: sentinel(num(p.cog), 360),
          heading: sentinel(num(p.heading), 511),
          rot: num(p.rot),
          navStatus: num(p.navStat),
          navStatusDesc: NAV_STATUS[p.navStat] || 'Unknown',
          positionAccurate: Boolean(p.posAcc),
          reportedAt: num(p.timestampExternal),
          source: 'digitraffic',
        };
      })
      .filter(Boolean);

    const body = JSON.stringify({
        ok: true,
        source: 'digitraffic',
        attribution: 'Fintraffic / Digitraffic, CC BY 4.0',
        fetchedAt: Date.now(),
        dataUpdatedAt: locations.json.dataUpdatedTime || null,
        coverage: hasArea ? { lat, lon, radiusKm } : { note: 'full Digitraffic feed (Baltic / Gulf of Finland)' },
        count: vessels.length,
        vessels,
    });

    const headers = {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=0, s-maxage=${LOCATION_CACHE_SECONDS}`,
      'x-flysdown-cache': locations.cache,
    };
    waitUntil(cache.put(lastGoodKey, new Response(body, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, s-maxage=${LAST_GOOD_SECONDS}` },
    })));
    return new Response(body, { headers });
  } catch (err) {
    const lastGood = await cache.match(lastGoodKey);
    if (lastGood) {
      try {
        const json = await lastGood.json();
        return new Response(
          JSON.stringify({ ...json, stale: true, ageMs: Date.now() - json.fetchedAt, degraded: [String(err.message || err)] }),
          {
            headers: {
              'content-type': 'application/json; charset=utf-8',
              'cache-control': 'public, max-age=0, s-maxage=15',
              'x-flysdown-cache': 'stale',
            },
          }
        );
      } catch {
        // fall through
      }
    }
    return new Response(
      JSON.stringify({ ok: false, error: 'AIS upstream failed', detail: String(err.message || err) }),
      { status: 502, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=0, s-maxage=15' } }
    );
  }
};
