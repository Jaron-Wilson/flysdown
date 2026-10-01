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

/**
 * Anyone may call GET: it is meant to be curled. CORS is open so a page
 * elsewhere can fetch it too. POST stays token-only and gets no CORS.
 */
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'accept',
  'access-control-max-age': '86400',
};

/**
 * The stored row is cached at the edge for CACHE_SECONDS, so a crowd running
 * `watch curl` costs one D1 read per colo every ten seconds, not one each.
 * The row is cached rather than the answer, so every reply still computes
 * the report's age, and its staleness, from the current time.
 */
const ROW_CACHE_KEY = 'https://flysdown.internal/skywatch-row';

async function readRow(env, waitUntil) {
  const cache = globalThis.caches?.default;
  const key = new Request(ROW_CACHE_KEY);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return { row: await hit.json(), cache: 'hit' };
  }
  const row = await env.RELAY_DB.prepare('SELECT received_at, payload FROM skywatch_reports WHERE id = ?1')
    .bind(ROW_ID)
    .first();
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(row ?? null), {
      headers: { 'content-type': 'application/json', 'cache-control': `public, s-maxage=${CACHE_SECONDS}` },
    }));
    if (waitUntil) waitUntil(put);
    else await put;
  }
  return { row: row ?? null, cache: 'miss' };
}

const pad = (value, width) => String(value).padEnd(width);
const clock = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown' : `${d.toISOString().slice(11, 19)}Z`;
};
const age = (ms) => {
  if (!Number.isFinite(ms)) return 'unknown';
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 90 ? `${s}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${Math.round(s / 3600)} h`;
};
const num = (n, digits = 3) => (Number.isFinite(n) ? n.toFixed(digits) : '?');

const CLASS_WORDS = {
  confirmed_active: 'in active zone',
  activation_uncertain: 'activation unknown',
  buffered_only: 'near boundary',
};
const EXIT_WORDS = {
  no_candidate: 'nowhere near a zone',
  outside_polygon: 'near but outside a zone',
  vertical_clear: 'above or below a zone',
  zone_inactive: 'in an inactive zone',
  on_ground: 'on the ground',
  bad_input: 'no usable altitude',
};

/**
 * A plain-text view of the same envelope, for terminals and `watch`. It
 * applies the same rules as the page: a stale report shows no detections,
 * and "not evaluated" never reads as "nothing found".
 */
export function renderText(body, now = Date.now()) {
  const lines = [
    'SkyWatch No-Fly-Zone Detector  (EXPERIMENTAL - not for navigation)',
    'LU AI Club SkyWatch, run on Project Flys Down: https://flysdown.jaronwilson.dev',
    '',
  ];
  if (!body.ok || !body.report) {
    lines.push(`Status    UNAVAILABLE  ${body.reason || 'no report'}`);
    return `${lines.join('\n')}\n`;
  }
  const { report } = body;
  const scope = report.scope || {};
  const feed = report.feed || {};
  const ev = report.evaluation || {};
  const ageMs = Number.isFinite(body.receivedAt) ? now - body.receivedAt : body.ageMs;
  const stale = body.stale || !(ageMs <= STALE_AFTER_MS);

  lines.push(`Area      ${scope.name} ${scope.radiusNm} NM around ${scope.lat}, ${scope.lon}`);
  lines.push(`Report    ${clock(report.generatedAt)} (${age(ageMs)} ago)  ${stale ? 'STALE' : 'CURRENT'}`);
  lines.push(`Feed      ${feed.status} via ${feed.source || 'unknown'}, snapshot ${num(feed.snapshotAgeS, 1)}s old, ${feed.count ?? '?'} aircraft in the feed`);
  if (report.detector) lines.push(`Detector  ${report.detector.id} ${report.detector.version}, ${report.detector.baseline || report.detector.rulesVersion}`);

  if (stale) {
    lines.push('', `Result    STALE: the last report is ${age(ageMs)} old, so its results are not shown.`);
    return `${lines.join('\n')}\n`;
  }
  if (!ev.ran) {
    lines.push('', `Result    NOT EVALUATED: ${ev.reason || feed.reason || 'no reason given'}.`, '          This is not the same as finding nothing.');
    return `${lines.join('\n')}\n`;
  }

  const exits = Object.entries(ev.exits || {}).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${EXIT_WORDS[k] || k}`).join(', ');
  const skipped = Object.entries(ev.skipped || {}).map(([k, n]) => `${n} ${k.replace(/_/g, ' ')}`).join(', ');
  lines.push(`Checked   ${ev.statesEvaluated} aircraft${exits ? `: ${exits}` : ''}`);
  if (skipped) lines.push(`Skipped   ${skipped}`);

  const detections = report.detections || [];
  if (!detections.length) {
    lines.push('', 'Result    No aircraft inside a zone volume.');
    return `${lines.join('\n')}\n`;
  }

  lines.push('', `Detections (${detections.length}${ev.truncated ? `, ${ev.truncated} more not shown` : ''})`);
  lines.push(`  ${pad('CLASS', 19)}${pad('SEV', 7)}${pad('SCORE', 7)}${pad('AIRCRAFT', 18)}${pad('ZONE', 26)}${pad('ALT FT', 9)}OBSERVED (est.)`);
  for (const d of detections) {
    const who = `${d.aircraftId}${d.callsign ? ` ${d.callsign}` : ''}`;
    const alt = Number.isFinite(d.altitudeFt) ? `${Math.round(d.altitudeFt)}${d.altitudeSource === 'BAROMETRIC' ? 'b' : ''}` : '?';
    lines.push(`  ${pad(CLASS_WORDS[d.classification] || d.classification, 19)}${pad(d.severity, 7)}${pad(num(d.score), 7)}${pad(who, 18)}${pad(String(d.zoneName).slice(0, 25), 26)}${pad(alt, 9)}${clock(d.observedAt)}`);
    const s = d.scoring;
    if (s) {
      const signals = (s.contextSignals || []).map((c) => `${c.name} ${num(c.weight, 2)}`).join(', ');
      lines.push(`      score = base ${num(s.base)} (${s.baseReason}) + depth ${num(s.depthBump)} (${num(s.depthNm, 2)} NM x ${s.depthBumpPerNm}, cap ${s.depthBumpCap}) - context ${num(s.contextPenalty)}${signals ? ` [${signals}]` : ''} = ${num(s.score)}`);
      for (const cap of s.severityCaps || []) lines.push(`      severity ${cap}`);
    }
    lines.push(`      activation: ${d.activationBasis}`);
  }
  lines.push('', 'Raw JSON: curl https://flysdown.jaronwilson.dev/api/skywatch');
  return `${lines.join('\n')}\n`;
}

export const onRequestOptions = async () => new Response(null, { status: 204, headers: CORS });

export const onRequestGet = async ({ request, env, waitUntil }) => {
  const asText = new URL(request.url).searchParams.get('format') === 'text';
  const reply = (body, cache) => {
    if (asText) {
      return new Response(renderText(body), {
        headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-skywatch-cache': cache, ...CORS },
      });
    }
    return new Response(JSON.stringify(body), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-skywatch-cache': cache, ...CORS },
    });
  };

  if (!env.RELAY_DB) return reply({ ok: false, status: 'unavailable', reason: 'SkyWatch storage is not configured.' }, 'none');
  try {
    const { row, cache } = await readRow(env, waitUntil);
    return reply(envelope(row), cache);
  } catch (err) {
    return reply({ ok: false, status: 'unavailable', reason: `SkyWatch storage error: ${String(err.message || err).slice(0, 120)}` }, 'error');
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
  // Drop this colo's cached row so the new report shows at once here; other
  // colos catch up within CACHE_SECONDS.
  await globalThis.caches?.default?.delete(new Request(ROW_CACHE_KEY)).catch(() => {});
  return json({ ok: true, storedAt: now, detections: report.detections.length }, 200, 0);
};
