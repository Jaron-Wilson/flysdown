/**
 * /api/tfrs - current FAA temporary flight restrictions, with real limits.
 *
 * The browser cannot read the FAA's TFR services itself (no CORS), so this
 * joins them at the edge: polygons from the TFR WFS, and each NOTAM's floor,
 * ceiling and active window from its detail XML (see shared/tfr.js).
 *
 * Budget: a Pages Function may make 50 subrequests per invocation and there
 * are around 85 NOTAMs, so details are filled in over a few refreshes and
 * remembered: the working state (assembled TFRs plus every parsed detail)
 * lives in one edge-cache entry. A refresh costs the WFS plus at most
 * MAX_DETAILS_PER_RUN details. A TFR whose detail is not in yet is served
 * with detailLoaded:false, and the page draws it without alerting on it.
 */

import { groupWfs, parseTfrDetail, assembleTfr, detailUrl } from '../../public/js/tfr.js';
import { USER_AGENT } from '../../shared/adsb.js';

export const WFS_URL =
  'https://tfr.faa.gov/geoserver/TFR/ows?service=WFS&version=1.1.0&request=GetFeature&typeName=TFR:V_TFR_LOC&outputFormat=application/json';
const CACHE_KEY = 'https://flysdown.jaronwilson.dev/__cache/tfrs-v2';
export const FRESH_MS = 5 * 60 * 1000;
// While details are still missing, come back sooner to fill them in.
const INCOMPLETE_RETRY_MS = 30 * 1000;
const DETAIL_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_DETAILS_PER_RUN = 35;

const HEADERS = { 'user-agent': USER_AGENT, accept: 'application/json, text/xml' };

/**
 * One refresh: pure apart from fetchImpl, so it is tested with fixtures.
 * Returns the new working state. Throws only if the WFS itself fails.
 */
export async function buildTfrs({ fetchImpl = fetch, previous = null, now = Date.now() } = {}) {
  const res = await fetchImpl(WFS_URL, { headers: HEADERS, signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`FAA TFR WFS HTTP ${res.status}`);
  const groups = groupWfs(await res.json());

  // Keep details for NOTAMs still published, until they are old enough to recheck.
  const details = {};
  for (const group of groups) {
    const known = previous?.details?.[group.notam];
    if (known && now - known.at < DETAIL_TTL_MS) details[group.notam] = known;
  }

  const missing = groups.filter((g) => !details[g.notam]).slice(0, MAX_DETAILS_PER_RUN);
  const fetched = await Promise.allSettled(
    missing.map(async (group) => {
      const r = await fetchImpl(detailUrl(group.notam), { headers: HEADERS, signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return [group.notam, parseTfrDetail(await r.text())];
    })
  );
  let detailFailures = 0;
  for (const result of fetched) {
    if (result.status === 'fulfilled') details[result.value[0]] = { at: now, parsed: result.value[1] };
    else detailFailures += 1;
  }

  const tfrs = groups
    .map((group) => assembleTfr(group, details[group.notam]?.parsed))
    // Over is over; anything without a known end stays.
    .filter((tfr) => !(Number.isFinite(tfr.expires) && tfr.expires < now));
  const complete = tfrs.every((t) => t.detailLoaded);

  return {
    builtAt: now,
    refreshAfter: now + (complete ? FRESH_MS : INCOMPLETE_RETRY_MS),
    complete,
    detailFailures,
    details,
    tfrs,
  };
}

/** What the browser gets: the TFRs, never the working state's detail store. */
export function publicBody(state, { stale = false } = {}) {
  return {
    ok: true,
    source: 'FAA tfr.faa.gov (WFS polygons, NOTAM detail limits)',
    fetchedAt: state.builtAt,
    complete: state.complete,
    stale,
    count: state.tfrs.length,
    tfrs: state.tfrs,
  };
}

const json = (body, status = 200, maxAge = 120) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${maxAge}` },
  });

export const onRequestGet = async ({ waitUntil }) => {
  const cache = globalThis.caches?.default;
  let previous = null;
  try {
    const hit = await cache?.match(CACHE_KEY);
    if (hit) previous = await hit.json();
  } catch {
    previous = null;
  }

  const now = Date.now();
  if (previous && now < previous.refreshAfter) return json(publicBody(previous));

  let state;
  try {
    state = await buildTfrs({ previous, now });
  } catch (err) {
    // The last good picture beats nothing, and says it is stale.
    if (previous) return json(publicBody(previous, { stale: true }), 200, 60);
    return json({ ok: false, error: `FAA TFR service unavailable: ${String(err.message || err).slice(0, 80)}` }, 502, 30);
  }

  const put = cache?.put(CACHE_KEY, new Response(JSON.stringify(state), { headers: { 'cache-control': 'public, max-age=21600' } }));
  if (put) waitUntil ? waitUntil(put.catch(() => {})) : await put.catch(() => {});
  return json(publicBody(state), 200, state.complete ? 120 : 20);
};
