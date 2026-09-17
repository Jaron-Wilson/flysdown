/**
 * GET /api/aircraft?lat=<deg>&lon=<deg>&dist=<nm>
 *
 * One normalised aircraft feed, assembled from whichever path can actually
 * deliver it. In order of preference:
 *
 *   1. the edge cache, if a recent answer is already there
 *   2. a relay snapshot from D1, written by a poller on an ordinary IP
 *   3. the community aggregators directly, which usually refuse a Worker
 *   4. the last known good answer, clearly marked stale with its age
 *
 * Step 2 exists because these aggregators rate-limit by IP and a Worker
 * shares its egress address with every other Cloudflare customer: measured
 * from production, adsb.lol answers about one attempt in six and adsb.fi
 * serves a bot challenge every time. When the relay is running, step 2 hits
 * and we never touch an upstream at all, which is both reliable and a good
 * deal politer.
 */

import { SOURCES, canonicalRegion, fetchSource } from '../../shared/adsb.js';

const CACHE_SECONDS = 6;
const LAST_GOOD_SECONDS = 300;
const RELAY_FRESH_MS = 30000;   // prefer a relay snapshot this fresh over any upstream
const RELAY_USABLE_MS = 300000; // and still serve one this old rather than nothing
const FAILURE_CACHE_SECONDS = 8;

const json = (body, extraHeaders = {}, status = 200) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=0, s-maxage=${CACHE_SECONDS}`,
      ...extraHeaders,
    },
  });

// A region stays on the relay's list for ten minutes, so refreshing its
// timestamp more often than every couple of minutes is pure write volume. D1's
// free allowance is 100k row writes a day and the snapshots themselves need
// most of it.
const DEMAND_REFRESH_MS = 120000;

/** Record that somebody is looking here, so the relay knows what to poll. */
async function recordDemand(env, region) {
  if (!env.RELAY_DB) return;

  const existing = await env.RELAY_DB.prepare('SELECT requested_at FROM wanted WHERE region = ?1')
    .bind(region.key)
    .first();
  if (existing && Date.now() - existing.requested_at < DEMAND_REFRESH_MS) return;

  await env.RELAY_DB.prepare(
    `INSERT INTO wanted (region, kind, lat, lon, radius_nm, requested_at)
     VALUES (?1, 'aircraft', ?2, ?3, ?4, ?5)
     ON CONFLICT(region) DO UPDATE SET requested_at = ?5`
  )
    .bind(region.key, Number(region.lat), Number(region.lon), region.dist, Date.now())
    .run();
}

async function readSnapshot(env, region, maxAgeMs) {
  if (!env.RELAY_DB) return null;
  const row = await env.RELAY_DB.prepare(
    `SELECT payload, updated_at, source, count FROM snapshots
     WHERE region = ?1 AND updated_at > ?2`
  )
    .bind(region.key, Date.now() - maxAgeMs)
    .first();
  if (!row) return null;

  try {
    return { aircraft: JSON.parse(row.payload), updatedAt: row.updated_at, source: row.source, count: row.count };
  } catch {
    return null;
  }
}

export const onRequestGet = async (context) => {
  const { request, waitUntil, env } = context;
  const params = new URL(request.url).searchParams;
  const region = canonicalRegion(params);
  const only = params.get('src');

  const cache = caches.default;
  const base = `lat=${region.lat}&lon=${region.lon}&dist=${region.dist}&src=${only || 'auto'}`;
  const freshKey = new Request(`https://flysdown.internal/aircraft?${base}`, { method: 'GET' });
  const lastGoodKey = new Request(`https://flysdown.internal/aircraft-last?${base}`, { method: 'GET' });

  const cached = await cache.match(freshKey);
  if (cached) {
    const hit = new Response(cached.body, cached);
    hit.headers.set('x-flysdown-cache', 'hit');
    return hit;
  }

  // Always tell the relay where people are looking, even on a cache hit path
  // miss, so a newly viewed area starts being covered within one relay cycle.
  waitUntil(recordDemand(env, region).catch(() => {}));

  const store = (body) => {
    waitUntil(cache.put(freshKey, new Response(body, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, s-maxage=${CACHE_SECONDS}` },
    })));
    waitUntil(cache.put(lastGoodKey, new Response(body, {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, s-maxage=${LAST_GOOD_SECONDS}` },
    })));
  };

  const coverage = { lat: Number(region.lat), lon: Number(region.lon), distNm: region.dist };

  if (!only) {
    const snapshot = await readSnapshot(env, region, RELAY_FRESH_MS).catch(() => null);
    if (snapshot) {
      const body = JSON.stringify({
        ok: true,
        source: `relay/${snapshot.source || 'unknown'}`,
        via: 'relay',
        fetchedAt: snapshot.updatedAt,
        ageMs: Date.now() - snapshot.updatedAt,
        coverage,
        count: snapshot.aircraft.length,
        aircraft: snapshot.aircraft,
      });
      store(body);
      return json(body, { 'x-flysdown-cache': 'relay', 'x-flysdown-source': `relay/${snapshot.source}` });
    }
  }

  const errors = [];
  for (const source of SOURCES) {
    if (only && source.name !== only) continue;
    try {
      const aircraft = await fetchSource(source, region.lat, region.lon, region.dist);
      const body = JSON.stringify({
        ok: true,
        source: source.name,
        via: 'edge',
        fetchedAt: Date.now(),
        coverage,
        count: aircraft.length,
        aircraft,
        degraded: errors.length ? errors : undefined,
      });
      store(body);
      return json(body, { 'x-flysdown-cache': 'miss', 'x-flysdown-source': source.name });
    } catch (err) {
      errors.push(`${source.name}: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`);
    }
  }

  // Nothing fresh. An older relay snapshot beats a five minute old cache entry,
  // so try it first, then the cache, and only then admit defeat.
  const olderSnapshot = only ? null : await readSnapshot(env, region, RELAY_USABLE_MS).catch(() => null);
  if (olderSnapshot) {
    const ageMs = Date.now() - olderSnapshot.updatedAt;
    return json(
      JSON.stringify({
        ok: true,
        source: `relay/${olderSnapshot.source || 'unknown'}`,
        via: 'relay',
        fetchedAt: olderSnapshot.updatedAt,
        // Only actually stale if it is actually old. Reaching this branch
        // means the upstreams refused, which does not make a snapshot from
        // three seconds ago out of date.
        stale: ageMs > RELAY_FRESH_MS,
        ageMs,
        coverage,
        count: olderSnapshot.aircraft.length,
        aircraft: olderSnapshot.aircraft,
        degraded: errors,
      }),
      { 'cache-control': `public, max-age=0, s-maxage=${FAILURE_CACHE_SECONDS}`, 'x-flysdown-cache': 'relay-stale' }
    );
  }

  const lastGood = await cache.match(lastGoodKey);
  if (lastGood) {
    try {
      const previous = await lastGood.json();
      return json(
        JSON.stringify({ ...previous, stale: true, ageMs: Date.now() - previous.fetchedAt, degraded: errors }),
        { 'cache-control': `public, max-age=0, s-maxage=${FAILURE_CACHE_SECONDS}`, 'x-flysdown-cache': 'stale' }
      );
    } catch {
      // fall through
    }
  }

  return json(
    JSON.stringify({ ok: false, error: 'all ADS-B upstreams refused the request', detail: errors }),
    { 'cache-control': `public, max-age=0, s-maxage=${FAILURE_CACHE_SECONDS}` },
    502
  );
};
