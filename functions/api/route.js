/**
 * GET /api/route?callsign=<callsign>
 *
 * Where a flight came from and where it is going. ADS-B itself broadcasts no
 * such thing: an aircraft transmits identity, position and velocity, not its
 * schedule. Routes come from adsbdb, which resolves an airline callsign to
 * origin and destination airports with coordinates, built on volunteer route
 * data (credited in the paper's references).
 *
 * Lookups are cached hard because a callsign's route does not change during a
 * day, and misses are cached too: most general aviation callsigns have no
 * scheduled route at all and would otherwise be asked for on every click.
 */

const UPSTREAM = 'https://api.adsbdb.com/v0/callsign';
const FOUND_TTL = 21600;     // 6 hours
const MISSING_TTL = 3600;    // 1 hour
const USER_AGENT = 'flysdown.jaronwilson.dev (live traffic dashboard; contact jaron@jaronwilson.dev)';

const json = (body, ttl, extra = {}) =>
  new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=60, s-maxage=${ttl}`,
      ...extra,
    },
  });

/** adsbdb gives country, elevation and municipality too; keep what we draw. */
function airport(raw) {
  if (!raw || !Number.isFinite(raw.latitude) || !Number.isFinite(raw.longitude)) return null;
  return {
    icao: raw.icao_code || null,
    iata: raw.iata_code || null,
    name: raw.name || null,
    municipality: raw.municipality || null,
    country: raw.country_iso_name || null,
    lat: raw.latitude,
    lon: raw.longitude,
    elevationFt: Number.isFinite(raw.elevation) ? raw.elevation : null,
  };
}

export const onRequestGet = async (context) => {
  const { request, waitUntil } = context;
  const params = new URL(request.url).searchParams;

  // Callsigns are alphanumeric; anything else is not worth forwarding.
  const callsign = (params.get('callsign') || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
  if (!callsign) {
    return json(JSON.stringify({ ok: false, error: 'callsign required' }), 60);
  }

  const cache = caches.default;
  const cacheKey = new Request(`https://flysdown.internal/route?callsign=${callsign}`, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set('x-flysdown-cache', 'hit');
    return hit;
  }

  try {
    const upstream = await fetch(`${UPSTREAM}/${callsign}`, {
      headers: { accept: 'application/json', 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(8000),
    });

    // 404 is the normal answer for a callsign with no scheduled route.
    if (upstream.status === 404) {
      const body = JSON.stringify({ ok: true, found: false, callsign, reason: 'no scheduled route for this callsign' });
      const response = json(body, MISSING_TTL, { 'x-flysdown-cache': 'miss' });
      waitUntil(cache.put(cacheKey, new Response(body, {
        headers: { 'content-type': 'application/json', 'cache-control': `public, s-maxage=${MISSING_TTL}` },
      })));
      return response;
    }

    if (!upstream.ok) throw new Error(`adsbdb HTTP ${upstream.status}`);

    const payload = await upstream.json();
    const route = payload?.response?.flightroute;
    const origin = airport(route?.origin);
    const destination = airport(route?.destination);

    if (!origin && !destination) {
      const body = JSON.stringify({ ok: true, found: false, callsign, reason: 'route had no usable airports' });
      waitUntil(cache.put(cacheKey, new Response(body, {
        headers: { 'content-type': 'application/json', 'cache-control': `public, s-maxage=${MISSING_TTL}` },
      })));
      return json(body, MISSING_TTL, { 'x-flysdown-cache': 'miss' });
    }

    const body = JSON.stringify({
      ok: true,
      found: true,
      callsign,
      callsignIata: route.callsign_iata || null,
      airline: route.airline ? { name: route.airline.name || null, icao: route.airline.icao || null, iata: route.airline.iata || null } : null,
      origin,
      destination,
      source: 'adsbdb',
      fetchedAt: Date.now(),
    });
    waitUntil(cache.put(cacheKey, new Response(body, {
      headers: { 'content-type': 'application/json', 'cache-control': `public, s-maxage=${FOUND_TTL}` },
    })));
    return json(body, FOUND_TTL, { 'x-flysdown-cache': 'miss' });
  } catch (err) {
    return json(
      JSON.stringify({ ok: false, error: 'route lookup failed', detail: String(err.message || err) }),
      60,
      { 'x-flysdown-cache': 'error' }
    );
  }
};
