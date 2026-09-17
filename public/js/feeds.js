/**
 * Feed manager: polls the two edge endpoints, keeps a short position history
 * per target (needed for trails and for the orbit rule), and reports feed
 * health so the UI can show when data is stale rather than silently lying.
 */

import { distanceNm } from './geo.js';

const AIRCRAFT_INTERVAL_MS = 5000;
const VESSEL_INTERVAL_MS = 15000;
const MAX_HISTORY_POINTS = 150;
const HISTORY_WINDOW_MS = 10 * 60 * 1000;
const DROP_AFTER_MS = 3 * 60 * 1000;
// How long a target inside the covered area may go unreported before it is
// dropped. Long enough to ride out one missed poll, short enough that the map
// does not accumulate ghosts.
const GRACE_MS = 45 * 1000;
const MAX_BACKOFF_MS = 60000;

/**
 * Upstreams answer refusals with whole HTML error pages, and the endpoint
 * passes those through for diagnostics. They must never reach the UI verbatim:
 * a nginx 429 page rendered into a status chip is unreadable. Reduce each one
 * to a few words and keep the full text on the error object for the console.
 */
export function summariseUpstreamFailure(json, status) {
  const details = Array.isArray(json?.detail) ? json.detail : json?.detail ? [String(json.detail)] : [];

  const reasons = details.map((entry) => {
    const text = String(entry);
    const name = text.split(':')[0].trim() || 'source';
    if (/\b429\b|too many requests/i.test(text)) return `${name} rate limited`;
    if (/\b40[13]\b|forbidden|unauthori[sz]ed/i.test(text)) return `${name} blocked`;
    if (/timeout|\b52[0-9]\b|timed out/i.test(text)) return `${name} not responding`;
    if (/\b5\d\d\b/.test(text)) return `${name} erroring`;
    return name;
  });

  if (!reasons.length) return json?.error || `HTTP ${status}`;
  return `no source available: ${reasons.join(', ')}`;
}

export class Feed {
  constructor({ name, endpoint, intervalMs, onData, onStatus }) {
    this.name = name;
    this.endpoint = endpoint;
    this.intervalMs = intervalMs;
    this.onData = onData;
    this.onStatus = onStatus;
    this.timer = null;
    this.failures = 0;
    this.inFlight = false;
    this.status = { state: 'idle', lastSuccess: null, lastError: null, latencyMs: null, count: 0, source: null };
    this.query = null;
    this.paused = false;
  }

  setQuery(query) {
    const changed = JSON.stringify(query) !== JSON.stringify(this.query);
    this.query = query;
    return changed;
  }

  report(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.name, this.status);
  }

  async poll({ force = false } = {}) {
    if (this.inFlight || (this.paused && !force)) return;
    if (!this.query) {
      // The map has not reported a viewport yet. Try again rather than
      // dropping the poll loop on the floor.
      this.schedule();
      return;
    }
    this.inFlight = true;
    const started = performance.now();
    try {
      const url = `${this.endpoint}?${new URLSearchParams(this.query)}`;
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      const json = await res.json();
      if (!res.ok || json.ok === false) {
        const error = new Error(summariseUpstreamFailure(json, res.status));
        error.detail = json.detail;
        throw error;
      }

      this.failures = 0;
      this.report({
        state: json.stale ? 'degraded' : 'live',
        lastSuccess: Date.now(),
        lastError: json.stale ? `serving the last good picture, ${Math.round((json.ageMs || 0) / 1000)}s old` : null,
        latencyMs: Math.round(performance.now() - started),
        count: json.count ?? 0,
        source: json.source || null,
        stale: Boolean(json.stale),
        ageMs: json.ageMs || 0,
        cache: res.headers.get('x-flysdown-cache'),
      });
      this.onData?.(json);
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

/**
 * Holds the current world: the latest state of every target plus its recent
 * track. Targets are keyed by ICAO hex (aircraft) or MMSI (vessel), which are
 * both stable identifiers, so history survives across polls.
 */
export class TargetStore {
  constructor() {
    this.targets = new Map();
  }

  /**
   * Replace the current set for one kind, merging history forward.
   *
   * `coverage` is the area the feed just answered for. Anything outside it is
   * dropped rather than left on the map: when the view jumps from Washington
   * to the Baltic, the old aircraft are not "still there", we simply have no
   * information about them.
   */
  ingest(kind, incoming, fetchedAt = Date.now(), coverage = null) {
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

      const outsideCoverage = coverage
        ? distanceNm(target.lat, target.lon, coverage.lat, coverage.lon) > coverage.radiusNm
        : false;
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
  pruneToCoverage(kind, coverage) {
    if (!coverage) return 0;
    let removed = 0;
    for (const [key, target] of this.targets) {
      if (target.kind !== kind) continue;
      if (distanceNm(target.lat, target.lon, coverage.lat, coverage.lon) > coverage.radiusNm) {
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

/** Viewport -> feed query. Aircraft upstreams cap the radius at 250 NM. */
export function viewportQuery(centre, radiusNm) {
  return {
    aircraft: {
      lat: centre.lat.toFixed(3),
      lon: centre.lng.toFixed(3),
      dist: String(Math.max(25, Math.min(250, Math.round(radiusNm)))),
    },
    vessels: {
      lat: centre.lat.toFixed(3),
      lon: centre.lng.toFixed(3),
      radius: String(Math.max(10, Math.min(800, Math.round(radiusNm * 1.852)))),
    },
  };
}

export const FEED_INTERVALS = { aircraft: AIRCRAFT_INTERVAL_MS, vessels: VESSEL_INTERVAL_MS };
