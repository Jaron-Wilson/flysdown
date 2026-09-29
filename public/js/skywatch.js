/**
 * SkyWatch detections: fetching, and deciding what the panel may say.
 *
 * SkyWatch is a separate detector (the LU AI Club's No-Fly-Zone Detector) run
 * server-side on this site's feed around KLYH. Its detections are not this
 * site's alerts and are never merged into them: the Alerts list is Flys
 * Down's own projected-entry warnings, this is SkyWatch's evaluation of where
 * aircraft actually were.
 *
 * Everything that decides wording lives in viewModel(), which is pure, so the
 * rules are testable: a stale or failed report never shows detections as
 * current, "evaluated and found nothing" reads differently from "could not
 * evaluate", and a detection whose zone activation is unknown is never
 * presented as a violation.
 */

export const SKYWATCH_URL = '/api/skywatch';
export const POLL_MS = 30000;
export const MAX_BACKOFF_MS = 300000;
export const STALE_AFTER_MS = 120000;

/** Detection classes, in the order the panel lists them. */
export const CLASSES = {
  confirmed_active: {
    rank: 2,
    label: 'Inside an active zone',
    short: 'In active zone',
    glyph: '■',
    blurb: 'Inside the polygon and altitude band of a zone whose published schedule says it is always active. Experimental: simplified geometry, no NOTAM or waiver check.',
  },
  activation_uncertain: {
    rank: 1,
    label: 'Inside a zone, activation unknown',
    short: 'Activation unknown',
    glyph: '?',
    blurb: 'Inside the zone volume, but nothing says whether the zone was active. Not a violation claim.',
  },
  buffered_only: {
    rank: 0,
    label: 'Near a boundary',
    short: 'Near boundary',
    glyph: '○',
    blurb: 'Outside the polygon but within position uncertainty. May be position error.',
  },
};

const plural = (n, word) => `${n} ${word}${n === 1 || word === 'aircraft' ? '' : 's'}`;

export function ageText(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}

export function clockText(iso) {
  if (!iso) return 'unknown time';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'unknown time' : `${d.toISOString().slice(11, 19)}Z`;
}

const EXIT_WORDS = {
  no_candidate: 'nowhere near a zone',
  outside_polygon: 'near but outside a zone',
  vertical_clear: 'above or below a zone',
  zone_inactive: 'in a zone that was inactive',
  on_ground: 'on the ground',
  bad_input: 'without a usable altitude for the zone',
};

/**
 * What the panel shows, from the GET envelope (or a fetch error).
 *
 * state is one of:
 *   loading      nothing fetched yet
 *   unavailable  no report, the endpoint failed, or it is unreadable
 *   stale        the report is too old to be current; detections hidden
 *   not_evaluated SkyWatch ran but its feed was stale or down, or it had no zones
 *   quiet        evaluated a fresh feed and found nothing
 *   detections   evaluated a fresh feed and found something
 */
export function viewModel(envelope, { now = Date.now(), error = null, staleAfterMs = STALE_AFTER_MS } = {}) {
  const empty = { detections: [], counts: { confirmed_active: 0, activation_uncertain: 0, buffered_only: 0 } };
  if (error) {
    return { ...empty, state: 'unavailable', headline: 'SkyWatch is unreachable', detail: `Could not load ${SKYWATCH_URL}: ${error}` };
  }
  if (!envelope) return { ...empty, state: 'loading', headline: 'Loading SkyWatch', detail: '' };
  if (!envelope.ok || !envelope.report) {
    return { ...empty, state: 'unavailable', headline: 'No SkyWatch report', detail: envelope.reason || 'SkyWatch has not published a report.' };
  }

  const { report } = envelope;
  const ageMs = Number.isFinite(envelope.receivedAt) ? Math.max(0, now - envelope.receivedAt) : envelope.ageMs;
  const scope = report.scope || {};
  const where = `${scope.name || 'its area'}, ${scope.radiusNm ?? '?'} NM`;
  const base = { ...empty, ageMs, scope, generatedAt: report.generatedAt, feed: report.feed || {}, evaluation: report.evaluation || {} };

  if (envelope.stale || !(ageMs <= staleAfterMs)) {
    return {
      ...base,
      state: 'stale',
      headline: `Last SkyWatch report is ${ageText(ageMs)} old`,
      detail: 'Its results are not current, so none are shown. The SkyWatch runner may have stopped.',
    };
  }

  const feed = report.feed || {};
  const evaluation = report.evaluation || {};
  if (!evaluation.ran) {
    return {
      ...base,
      state: 'not_evaluated',
      headline: feed.status && feed.status !== 'fresh' ? `SkyWatch could not evaluate: feed ${feed.status}` : 'SkyWatch could not evaluate',
      detail: `${(evaluation.reason || feed.reason || 'No reason given').replace(/\.?$/, '.')} This is not the same as finding nothing.`,
    };
  }

  const detections = [...(report.detections || [])]
    .filter((d) => CLASSES[d.classification])
    .sort((a, b) => CLASSES[b.classification].rank - CLASSES[a.classification].rank || (b.score ?? 0) - (a.score ?? 0));
  const counts = { confirmed_active: 0, activation_uncertain: 0, buffered_only: 0 };
  for (const d of detections) counts[d.classification] += 1;

  const checked = `Checked ${plural(evaluation.statesEvaluated ?? 0, 'aircraft')} around ${where} at ${clockText(report.generatedAt)}, feed ${ageText((feed.snapshotAgeS ?? NaN) * 1000)} old via ${feed.source || 'unknown source'}.`;

  if (!detections.length) {
    const exits = Object.entries(evaluation.exits || {})
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${n} ${EXIT_WORDS[reason] || reason}`)
      .join(', ');
    return {
      ...base,
      state: 'quiet',
      headline: 'No aircraft inside a zone volume',
      detail: `${checked}${exits ? ` ${exits}.` : ''}`,
    };
  }

  const parts = Object.entries(counts).filter(([, n]) => n).map(([k, n]) => `${n} ${CLASSES[k].short.toLowerCase()}`);
  return {
    ...base,
    state: 'detections',
    detections,
    counts,
    headline: parts.join(', '),
    detail: checked + (evaluation.truncated ? ` ${evaluation.truncated} more not shown.` : ''),
  };
}

/** Map features for the detection rings; empty unless the view is current. */
export function toFeatures(view) {
  if (view.state !== 'detections') return [];
  return view.detections.map((d) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [d.lon, d.lat] },
    properties: {
      key: `aircraft:${d.aircraftId}`,
      classification: d.classification,
      label: `SkyWatch: ${CLASSES[d.classification].short}`,
    },
  }));
}

/** The SkyWatch area as a ring, so its scope is visible on the map. */
export function scopeFeature(view, segments = 96) {
  const { lat, lon, radiusNm } = view.scope || {};
  if (![lat, lon, radiusNm].every(Number.isFinite) || view.state === 'loading' || view.state === 'unavailable') return [];
  const R = 3440.065;
  const d = radiusNm / R;
  const toRad = (x) => (x * Math.PI) / 180;
  const toDeg = (x) => (x * 180) / Math.PI;
  const lat1 = toRad(lat);
  const lon1 = toRad(lon);
  const ring = [];
  for (let i = 0; i <= segments; i++) {
    const brng = (2 * Math.PI * i) / segments;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
    ring.push([toDeg(lon2), toDeg(lat2)]);
  }
  return [{ type: 'Feature', geometry: { type: 'LineString', coordinates: ring }, properties: { label: `SkyWatch area: ${view.scope.name || ''} ${radiusNm} NM` } }];
}

/**
 * Polls /api/skywatch. One request per POLL_MS while the page is visible,
 * doubling up to MAX_BACKOFF_MS while it fails. The endpoint is edge-cached
 * for 10 s, so many viewers cost one storage read, not one each.
 */
export class SkyWatchFeed {
  constructor({ onUpdate, fetchImpl = (...args) => fetch(...args), doc = globalThis.document } = {}) {
    this.onUpdate = onUpdate;
    this.fetchImpl = fetchImpl;
    this.doc = doc;
    this.envelope = null;
    this.error = null;
    this.failures = 0;
    this.timer = null;
    this.stopped = false;
  }

  start() {
    this.stopped = false;
    this.doc?.addEventListener?.('visibilitychange', () => {
      if (this.doc.visibilityState === 'visible') this.poll();
    });
    this.poll();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  view(now = Date.now()) {
    return viewModel(this.envelope, { now, error: this.error });
  }

  async poll() {
    clearTimeout(this.timer);
    if (this.stopped) return;
    if (this.doc?.visibilityState === 'hidden') return; // resumes on visibilitychange
    try {
      const response = await this.fetchImpl(SKYWATCH_URL, { headers: { accept: 'application/json' } });
      const type = response.headers?.get?.('content-type') || '';
      // Pages answers unknown paths with the dashboard's HTML and a 200, so
      // check what came back, not only the status.
      if (!response.ok || !type.includes('application/json')) throw new Error(`HTTP ${response.status}${type.includes('json') ? '' : ', not JSON'}`);
      this.envelope = await response.json();
      this.error = null;
      this.failures = 0;
    } catch (err) {
      this.error = String(err.message || err);
      this.failures += 1;
    }
    this.onUpdate?.(this.view());
    const wait = Math.min(MAX_BACKOFF_MS, POLL_MS * 2 ** Math.min(this.failures, 4));
    this.timer = setTimeout(() => this.poll(), wait);
  }
}
