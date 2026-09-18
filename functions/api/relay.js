/**
 * The relay endpoint. Talks only to the poller, never to the browser.
 *
 *   GET  /api/relay   -> the regions people are currently looking at
 *   POST /api/relay   -> a snapshot of aircraft for one of those regions
 *
 * Both require the shared secret in RELAY_TOKEN. The point of the whole
 * arrangement is that the poller runs somewhere with an ordinary IP address,
 * where the ADS-B aggregators answer every time, instead of at the edge where
 * they mostly refuse.
 */

const WANTED_TTL_MS = 10 * 60 * 1000; // stop polling an area nobody has looked at for ten minutes
const MAX_REGIONS = 5;                // bounds both upstream load and D1 writes
const MAX_SNAPSHOT_BYTES = 2_000_000;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function authorized(request, env) {
  if (!env.RELAY_TOKEN) return false;
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Constant-time-ish: compare lengths first, then every byte.
  if (token.length !== env.RELAY_TOKEN.length) return false;
  let same = 0;
  for (let i = 0; i < token.length; i++) same |= token.charCodeAt(i) ^ env.RELAY_TOKEN.charCodeAt(i);
  return same === 0;
}

export const onRequestGet = async ({ request, env }) => {
  if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.RELAY_DB) return json({ ok: false, error: 'no RELAY_DB binding' }, 503);

  const since = Date.now() - WANTED_TTL_MS;
  const { results } = await env.RELAY_DB.prepare(
    `SELECT w.region, w.lat, w.lon, w.radius_nm, w.requested_at, s.updated_at
     FROM wanted w
     LEFT JOIN snapshots s ON s.region = w.region
     WHERE w.requested_at > ?1
     ORDER BY w.requested_at DESC
     LIMIT ?2`
  )
    .bind(since, MAX_REGIONS)
    .all();

  // Housekeeping: forget abandoned regions so the poller's list stays short.
  // The poller calls this every few seconds and there is rarely anything to
  // delete, so only sweep occasionally.
  if (Math.random() < 0.05) {
    await env.RELAY_DB.prepare('DELETE FROM wanted WHERE requested_at < ?1').bind(since).run();
    await env.RELAY_DB.prepare('DELETE FROM snapshots WHERE updated_at < ?1').bind(since).run();
  }

  return json({
    ok: true,
    now: Date.now(),
    regions: (results || []).map((row) => ({
      region: row.region,
      lat: row.lat,
      lon: row.lon,
      distNm: row.radius_nm,
      requestedAt: row.requested_at,
      snapshotAgeMs: row.updated_at ? Date.now() - row.updated_at : null,
    })),
  });
};

export const onRequestPost = async ({ request, env }) => {
  if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401);
  if (!env.RELAY_DB) return json({ ok: false, error: 'no RELAY_DB binding' }, 503);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: 'body must be JSON' }, 400);
  }

  const { region, lat, lon, distNm, source, aircraft } = body || {};
  if (!region || !Array.isArray(aircraft) || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(distNm)) {
    return json({ ok: false, error: 'need region, lat, lon, distNm and an aircraft array' }, 400);
  }

  const payload = JSON.stringify(aircraft);
  if (payload.length > MAX_SNAPSHOT_BYTES) return json({ ok: false, error: 'snapshot too large' }, 413);

  const now = Date.now();
  await env.RELAY_DB.prepare(
    `INSERT INTO snapshots (region, kind, lat, lon, radius_nm, updated_at, source, count, payload)
     VALUES (?1, 'aircraft', ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(region) DO UPDATE SET
       updated_at = ?5, source = ?6, count = ?7, payload = ?8, lat = ?2, lon = ?3, radius_nm = ?4`
  )
    .bind(region, lat, lon, distNm, now, String(source || 'unknown').slice(0, 40), aircraft.length, payload)
    .run();

  return json({ ok: true, region, count: aircraft.length, storedAt: now });
};
