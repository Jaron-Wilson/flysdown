/**
 * /api/skywatch - the latest report from the SkyWatch No-Fly-Zone Detector.
 *
 * SkyWatch (LU AI Club) is a separate detector. It runs as its own process
 * next to the relay, reads this site's public /api/aircraft feed for its own
 * area (KLYH, 150 NM), and POSTs a report here. Browsers only ever GET it.
 * Nothing about it touches this site's own alerts: those are projected-entry
 * warnings computed in the browser, and these are SkyWatch's detections.
 *
 *   POST /api/skywatch   Authorization: Bearer $SKYWATCH_TOKEN, body = report
 *   GET  /api/skywatch   public, { ok, receivedAt, ageMs, stale, report }
 *
 * The site never upgrades what a report says. It adds one thing, its own
 * clock: a report older than STALE_AFTER_MS is served with stale: true so the
 * page can say so instead of showing it as current.
 */

export const REPORT_SCHEMA = 'skywatch.flysdown.report/1';
export const STALE_AFTER_MS = 120000;
const MAX_REPORT_BYTES = 512 * 1024;
const MAX_DETECTIONS = 200;
const CACHE_SECONDS = 10;
const ROW_ID = 'latest';

const json = (body, status = 200, cacheSeconds = CACHE_SECONDS) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cacheSeconds ? `public, max-age=0, s-maxage=${cacheSeconds}` : 'no-store',
    },
  });

function authorized(request, env) {
  if (!env.SKYWATCH_TOKEN) return false;
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token.length !== env.SKYWATCH_TOKEN.length) return false;
  let same = 0;
  for (let i = 0; i < token.length; i++) same |= token.charCodeAt(i) ^ env.SKYWATCH_TOKEN.charCodeAt(i);
  return same === 0;
}

/** Why a posted report cannot be stored, or null when it can. */
export function validateReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return 'report must be a JSON object';
  if (report.schema !== REPORT_SCHEMA) return `schema must be ${REPORT_SCHEMA}`;
  if (report.experimental !== true) return 'report must be marked experimental';
  if (!report.feed || typeof report.feed.status !== 'string') return 'report.feed.status is required';
  if (!report.evaluation || typeof report.evaluation.ran !== 'boolean') return 'report.evaluation.ran is required';
  if (!Array.isArray(report.detections)) return 'report.detections must be an array';
  if (report.detections.length > MAX_DETECTIONS) return `at most ${MAX_DETECTIONS} detections`;
  if (!report.evaluation.ran && report.detections.length) return 'a report that did not evaluate cannot carry detections';
  if (report.feed.status !== 'fresh' && report.detections.length) return 'detections need a fresh feed';
  return null;
}

/** What GET returns, from a stored row (or none). Pure, so it is testable. */
export function envelope(row, now = Date.now()) {
  if (!row) {
    return { ok: false, status: 'unavailable', reason: 'No SkyWatch report has been published yet.' };
  }
  let report;
  try {
    report = JSON.parse(row.payload);
  } catch {
    return { ok: false, status: 'unavailable', reason: 'The stored SkyWatch report could not be read.' };
  }
  const ageMs = Math.max(0, now - row.received_at);
  return { ok: true, receivedAt: row.received_at, ageMs, stale: ageMs > STALE_AFTER_MS, report };
}

export const onRequestGet = async ({ env }) => {
  if (!env.RELAY_DB) return json({ ok: false, status: 'unavailable', reason: 'SkyWatch storage is not configured.' }, 200, 0);
  try {
    const row = await env.RELAY_DB.prepare('SELECT received_at, payload FROM skywatch_reports WHERE id = ?1')
      .bind(ROW_ID)
      .first();
    return json(envelope(row));
  } catch (err) {
    return json({ ok: false, status: 'unavailable', reason: `SkyWatch storage error: ${String(err.message || err).slice(0, 120)}` }, 200, 0);
  }
};

export const onRequestPost = async ({ request, env }) => {
  if (!authorized(request, env)) return json({ ok: false, error: 'unauthorized' }, 401, 0);
  if (!env.RELAY_DB) return json({ ok: false, error: 'no database binding' }, 500, 0);

  const text = await request.text();
  if (text.length > MAX_REPORT_BYTES) return json({ ok: false, error: 'report too large' }, 413, 0);
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return json({ ok: false, error: 'body is not JSON' }, 400, 0);
  }
  const problem = validateReport(report);
  if (problem) return json({ ok: false, error: problem }, 400, 0);

  const now = Date.now();
  await env.RELAY_DB.prepare(
    `INSERT INTO skywatch_reports (id, received_at, payload) VALUES (?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET received_at = ?2, payload = ?3`
  )
    .bind(ROW_ID, now, text)
    .run();
  return json({ ok: true, storedAt: now, detections: report.detections.length }, 200, 0);
};
