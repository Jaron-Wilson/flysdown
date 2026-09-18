/**
 * Feed manager: polls the two edge endpoints, keeps a short position history
 * per target (needed for trails and for the orbit rule), and reports feed
 * health so the UI can show when data is stale rather than silently lying.
 */

import { distanceNm } from './geo.js';

const AIRCRAFT_INTERVAL_MS = 5000;
const VESSEL_INTERVAL_MS = 15000;
const MAX_HISTORY_POINTS = 400;
// How much observed track to keep per target. This is the only record of
// where an aircraft has actually been: no keyless ADS-B source serves history
// (every trace endpoint probed answers 403), so what is not kept here is gone.
const HISTORY_WINDOW_MS = 45 * 60 * 1000;
const DROP_AFTER_MS = 3 * 60 * 1000;
// How long a target inside the covered area may go unreported before it is
// dropped. Long enough to ride out one missed poll, short enough that the map
// does not accumulate ghosts.
const GRACE_MS = 45 * 1000;
const MAX_BACKOFF_MS = 60000;
// Below this, data is current enough to present as live.
const STALE_AFTER_MS = 45000;

/**
 * Upstreams answer refusals with whole HTML error pages, and the endpoint
 * passes those through for diagnostics. They must never reach the UI verbatim:
 * a nginx 429 page rendered into a status chip is unreadable. Reduce each one
 * to a few words and keep the full text on the error object for the console.
 */
export function summarizeUpstreamFailure(json, status) {
  const details = Array.isArray(json?.detail) ? json.detail : json?.detail ? [String(json.detail)] : [];

  const reasons = details.map((entry) => {
    const text = String(entry);
    const name = sourceName(text);
    if (/\b429\b|too many requests/i.test(text)) return `${name} rate limited`;
    if (/\b40[13]\b|forbidden|unauthori[sz]ed/i.test(text)) return `${name} blocked`;
    if (/timeout|timed out|\b5(?:2[0-9]|04)\b|origin web server|invalid or incomplete response|gateway/i.test(text)) {
      return `${name} not responding`;
    }
    if (/\b5\d\d\b|overloaded|misconfigured/i.test(text)) return `${name} erroring`;
    return `${name} failed`;
  });

  if (!reasons.length) return clampReason(json?.error) || `HTTP ${status}`;
  return clampReason(`no source available: ${reasons.join(', ')}`);
}

/**
 * The name of the source an upstream detail line is about.
 *
 * Details arrive as "adsb.lol: HTTP 429 - <html>...", so the part before the
 * colon is normally the source. Normally: a proxy in front of an upstream can
 * answer with a bare sentence and no colon at all, and taking the whole
 * sentence as a name is how a Cloudflare 520 page ("The origin web server
 * returned an invalid or incomplete response...") ended up printed in the
 * status line. Anything that does not look like a host or a short identifier
 * is therefore reported as 'upstream'.
 */
function sourceName(text) {
  // A source name is one short token and never contains a space, so a segment
  // with any in it is prose and gets reported as 'upstream'. Splitting on
  // whitespace instead would have promoted "The origin web server..." to a
  // source called "The".
  const head = String(text).split(':')[0].trim();
  return /^[\w.-]{2,24}$/.test(head) ? head : 'upstream';
}

/** No amount of upstream prose may reach the interface. */
function clampReason(text, limit = 72) {
  if (!text) return '';
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}\u2026`;
}

/**
 * The worst thing wrong with any feed, or null when nothing is.
 *
 * Drives the dot on the feed line's fold button: folding the diagnostics away
 * is allowed to hide the detail, not the fact that a feed is dead. A paused
 * feed is not a fault, it is an instruction, so it is ignored here.
 */
export function worstFeedIssue(statuses) {
  const states = (statuses || []).filter((s) => s && s.state !== 'paused').map((s) => s.state);
  if (states.includes('down')) return 'down';
  if (states.includes('degraded')) return 'degraded';
  return null;
}

export class Feed {
  constructor({ name, endpoint, itemsKey, intervalMs, onData, onStatus }) {
    this.name = name;
    this.endpoint = endpoint;
    this.itemsKey = itemsKey;
    this.intervalMs = intervalMs;
    this.onData = onData;
    this.onStatus = onStatus;
    this.timer = null;
    this.failures = 0;
    this.inFlight = false;
    this.status = { state: 'idle', lastSuccess: null, lastError: null, latencyMs: null, count: 0, source: null };
    this.queries = [];
    this.paused = false;
  }

  /**
   * A feed can cover several areas at once: one per pinned tracking area, or
   * a single one derived from the viewport. Returns whether the set changed.
   */
  setQueries(queries) {
    const next = queries || [];
    const changed = JSON.stringify(next) !== JSON.stringify(this.queries);
    this.queries = next;
    return changed;
  }

  report(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.name, this.status);
  }

  async fetchOne(query) {
    const url = `${this.endpoint}?${new URLSearchParams(query)}`;
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    const json = await res.json();
    if (!res.ok || json.ok === false) {
      const error = new Error(summarizeUpstreamFailure(json, res.status));
      error.detail = json.detail;
      throw error;
    }
    return json;
  }

  async poll({ force = false } = {}) {
    if (this.inFlight || (this.paused && !force)) return;
    if (!this.queries.length) {
      // The map has not reported an area yet. Try again rather than dropping
      // the poll loop on the floor.
      this.schedule();
      return;
    }

    this.inFlight = true;
    const started = performance.now();
    try {
      const settled = await Promise.allSettled(this.queries.map((query) => this.fetchOne(query)));
      const ok = settled.filter((r) => r.status === 'fulfilled').map((r) => r.value);
      const failures = settled.filter((r) => r.status === 'rejected').map((r) => r.reason);
      if (!ok.length) throw failures[0] || new Error('no areas answered');

      // Merge the areas: dedupe by id, union the covered areas, and report the
      // oldest data in the set rather than the newest, so age is never
      // flattering.
      const byId = new Map();
      const coverages = [];
      const sources = new Set();
      let ageMs = 0;
      let stale = false;

      for (const json of ok) {
        for (const item of json[this.itemsKey] || []) byId.set(item.id, item);
        if (json.coverage) coverages.push(normalizeCoverage(json.coverage));
        if (json.source) sources.add(json.source);
        ageMs = Math.max(ageMs, json.ageMs || 0);
        stale = stale || Boolean(json.stale);
      }

      const partial = failures.length
        ? `${failures.length} of ${this.queries.length} areas failed: ${failures[0].message}`
        : null;
      const reallyStale = stale && ageMs > STALE_AFTER_MS;

      this.failures = 0;
      this.report({
        state: reallyStale || partial ? 'degraded' : 'live',
        lastSuccess: Date.now(),
        lastError: reallyStale ? `last good picture, ${Math.round(ageMs / 1000)}s old` : partial,
        latencyMs: Math.round(performance.now() - started),
        count: byId.size,
        source: [...sources].join(' + ') || null,
        via: ok[0]?.via || 'edge',
        areas: ok.length,
        stale: reallyStale,
        ageMs,
      });

      this.onData?.({
        items: [...byId.values()],
        coverages: coverages.filter(Boolean),
        fetchedAt: Date.now(),
      });
    } catch (err) {
      this.failures += 1;
      this.report({ state: this.failures > 2 ? 'down' : 'degraded', lastError: String(err.message || err) });
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }

  schedule() {
    clearTimeout(this.timer);
    if (this.paused) return;
    const backoff = this.failures ? Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** this.failures) : this.intervalMs;
    this.timer = setTimeout(() => this.poll(), backoff);
  }

  start() {
    this.paused = false;
    this.poll();
  }

  stop() {
    this.paused = true;
    clearTimeout(this.timer);
    this.report({ state: 'paused' });
  }
}

/** Is this target inside any of the covered areas? */
function insideAny(target, coverages) {
  return coverages.some((area) => distanceNm(target.lat, target.lon, area.lat, area.lon) <= area.radiusNm);
}

/** Coverage comes back as nautical miles for aircraft and kilometers for AIS. */
function normalizeCoverage(coverage) {
  if (!Number.isFinite(coverage.lat) || !Number.isFinite(coverage.lon)) return null;
  const radiusNm = Number.isFinite(coverage.distNm)
    ? coverage.distNm
    : Number.isFinite(coverage.radiusKm)
      ? coverage.radiusKm / 1.852
      : null;
  return radiusNm ? { lat: coverage.lat, lon: coverage.lon, radiusNm } : null;
}

/**
 * Holds the current world: the latest state of every target plus its recent
 * track. Targets are keyed by ICAO hex (aircraft) or MMSI (vessel), which are
 * both stable identifiers, so history survives across polls.
 */
export class TargetStore {
  constructor() {
    this.targets = new Map();
    // A target the operator is looking at is never pruned. Framing a
    // transatlantic route zooms far outside the feed's coverage radius, and
    // dropping the very aircraft whose route is on screen would be absurd.
    this.protectedKey = null;
  }

  protect(key) {
    this.protectedKey = key;
  }

  /**
   * Replace the current set for one kind, merging history forward.
   *
   * `coverage` is the area the feed just answered for. Anything outside it is
   * dropped rather than left on the map: when the view jumps from Washington
   * to the Baltic, the old aircraft are not "still there", we simply have no
   * information about them.
   */
  ingest(kind, incoming, fetchedAt = Date.now(), coverages = []) {
    const seen = new Set();

    for (const raw of incoming) {
      const key = `${kind}:${raw.id}`;
      seen.add(key);
      const previous = this.targets.get(key);
      const history = previous ? previous.history : [];
      const last = history[history.length - 1];

      const movedNm = last ? distanceNm(last.lat, last.lon, raw.lat, raw.lon) : Infinity;
      if (!last || movedNm > 0.02) {
        history.push({
          t: fetchedAt,
          lat: raw.lat,
          lon: raw.lon,
          alt: raw.alt ?? null,
          track: raw.track ?? raw.cog ?? raw.heading ?? null,
        });
        while (history.length > MAX_HISTORY_POINTS) history.shift();
        while (history.length > 2 && fetchedAt - history[0].t > HISTORY_WINDOW_MS) history.shift();
      }

      this.targets.set(key, { ...raw, kind, key, history, updatedAt: fetchedAt });
    }

    // Prune, but only within the kind we just refreshed: an aircraft poll says
    // nothing about vessels.
    for (const [key, target] of this.targets) {
      if (target.kind !== kind) continue;
      if (seen.has(key)) continue;
      if (key === this.protectedKey) continue;

      const outsideCoverage = coverages.length ? !insideAny(target, coverages) : false;
      const unreportedFor = fetchedAt - target.updatedAt;

      // Outside the answered area: no information, so do not draw it.
      // Inside it and unreported: it has genuinely dropped off the feed, with a
      // short grace period to ride out a single missed update.
      if (outsideCoverage || unreportedFor > GRACE_MS) this.targets.delete(key);
      else if (unreportedFor > DROP_AFTER_MS) this.targets.delete(key);
    }
  }

  /**
   * Drop targets of one kind that fall outside an area. Called when the view
   * moves, so a refused poll for the new area cannot leave the previous
   * region's targets on the map pretending to be current.
   */
  pruneToCoverage(kind, coverages) {
    if (!coverages?.length) return 0;
    let removed = 0;
    for (const [key, target] of this.targets) {
      if (target.kind !== kind) continue;
      if (key === this.protectedKey) continue;
      if (!insideAny(target, coverages)) {
        this.targets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  all() {
    return [...this.targets.values()];
  }

  byKind(kind) {
    return this.all().filter((t) => t.kind === kind);
  }

  get(key) {
    return this.targets.get(key) || null;
  }

  trailFeatures(kind, { minPoints = 2 } = {}) {
    const features = [];
    for (const target of this.targets.values()) {
      if (kind && target.kind !== kind) continue;
      if (target.history.length < minPoints) continue;
      features.push({
        type: 'Feature',
        properties: { key: target.key, kind: target.kind },
        geometry: { type: 'LineString', coordinates: target.history.map((h) => [h.lon, h.lat]) },
      });
    }
    return features;
  }
}

/**
 * Seconds since this target last reported a position.
 *
 * Two things add up: how long ago the receiver network last heard from it
 * (the feed's own seen_pos, or the AIS report timestamp), plus how long ago we
 * fetched that answer. Serving a five minute old relay snapshot and then
 * claiming every contact in it is two seconds old would be a lie.
 */
export function targetAgeSec(target, now = Date.now()) {
  const sinceFetch = Math.max(0, (now - (target.updatedAt || now)) / 1000);

  if (target.kind === 'vessel') {
    return Number.isFinite(target.reportedAt)
      ? Math.max(0, (now - target.reportedAt) / 1000)
      : sinceFetch;
  }

  const sinceHeard = target.seenPos ?? target.seen;
  return sinceFetch + (Number.isFinite(sinceHeard) ? sinceHeard : 0);
}

/**
 * One area becomes one query per feed. Aircraft upstreams cap the radius at
 * 250 NM; the AIS service takes kilometers.
 */
export function areaQuery(lat, lon, radiusNm) {
  return {
    aircraft: {
      lat: lat.toFixed(3),
      lon: lon.toFixed(3),
      dist: String(Math.max(25, Math.min(250, Math.round(radiusNm)))),
    },
    vessels: {
      lat: lat.toFixed(3),
      lon: lon.toFixed(3),
      radius: String(Math.max(10, Math.min(800, Math.round(radiusNm * 1.852)))),
    },
  };
}

export const FEED_INTERVALS = { aircraft: AIRCRAFT_INTERVAL_MS, vessels: VESSEL_INTERVAL_MS };
