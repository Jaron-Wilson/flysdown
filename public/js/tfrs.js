/**
 * Live TFRs -> alerting zones.
 *
 * A TFR alerts only while it is in effect, for the aircraft it restricts, with
 * its published floor and ceiling. Everything else is drawn as advisory and
 * says why: not in effect yet, drones only, or limits not loaded. Alerting on
 * a 3,000 ft stadium TFR for every airliner at FL350 overhead, or on a drone
 * restriction for manned traffic, would bury the incursions that matter.
 *
 * Source order: /api/tfrs (FAA polygons joined with NOTAM limits at the edge),
 * then, if that is down, tar1090's public mirror of the FAA polygons, which
 * has no limits or times, so every zone from it is advisory.
 */

import { groupWfs, assembleTfr } from './tfr.js';

export const TFR_INTERVAL_MS = 5 * 60 * 1000;
export const MIRROR_URL = 'https://raw.githubusercontent.com/wiedehopf/tar1090-aux/master/tfrs.geojson';
const UNLIMITED_FT = 99999;

const when = (ms) =>
  new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });

/** Is it in effect now, and if not, why it is only advisory. */
export function tfrStatus(tfr, now = Date.now()) {
  if (tfr.dronesOnly) return { alerting: false, reason: 'drones only' };
  if (!tfr.detailLoaded) return { alerting: false, reason: 'limits not loaded' };
  if (tfr.restricts === false) return { alerting: false, reason: 'conditions, not a prohibition' };
  if (Number.isFinite(tfr.effective) && now < tfr.effective) return { alerting: false, reason: `in effect from ${when(tfr.effective)}` };
  if (Number.isFinite(tfr.expires) && now >= tfr.expires) return { alerting: false, reason: 'ended' };
  return { alerting: true, reason: '' };
}

const TYPE_WORD = {
  SECURITY: 'Security',
  VIP: 'VIP',
  'SPACE OPERATIONS': 'Space operations',
  HAZARDS: 'Hazard',
  'AIR SHOWS/SPORTS': 'Air show or sports',
  'UAS PUBLIC GATHERING': 'Drone, public gathering',
};

/** One zone feature per polygon, in the shape ZoneStore.setLive takes. */
export function tfrToFeatures(tfr, now = Date.now()) {
  const status = tfrStatus(tfr, now);
  const word = TYPE_WORD[tfr.type] || titleCase(tfr.type);
  const window = [
    Number.isFinite(tfr.effective) ? `from ${when(tfr.effective)}` : null,
    Number.isFinite(tfr.expires) ? `until ${when(tfr.expires)}` : 'no published end',
  ].filter(Boolean).join(' ');
  const note = [
    `${word} TFR, FDC ${tfr.notam}${tfr.place ? `, ${tfr.place}` : ''}.`,
    tfr.limitsText ? `${tfr.limitsText}, ${window}.` : 'Floor, ceiling and times were not available, so it is drawn without alerting.',
    tfr.areas > 1 ? `${tfr.areas} areas; each is shown with the NOTAM's overall limits.` : null,
    status.reason && status.reason !== 'limits not loaded' ? `Advisory: ${status.reason}.` : null,
  ].filter(Boolean).join(' ');

  return tfr.polygons
    .filter((ring) => ring.length >= 4)
    .map((ring, i) => ({
      type: 'Feature',
      properties: {
        id: `tfr-${tfr.notam.replace('/', '-')}-${i}`,
        name: `TFR ${tfr.notam} ${tfr.place || ''}`.trim(),
        kind: 'tfr',
        shape: 'polygon',
        floorFt: tfr.detailLoaded ? tfr.floorFt ?? 0 : 0,
        ceilingFt: tfr.detailLoaded ? Math.min(tfr.ceilingFt ?? UNLIMITED_FT, UNLIMITED_FT) : UNLIMITED_FT,
        agl: Boolean(tfr.agl),
        appliesTo: ['aircraft'],
        advisory: !status.alerting,
        advisoryReason: status.reason,
        approx: tfr.areas > 1,
        note,
        source: `FAA TFR, FDC ${tfr.notam}`,
        live: true,
      },
      geometry: { type: 'Polygon', coordinates: [ring] },
    }));
}

function titleCase(text) {
  return String(text || 'TFR').toLowerCase().replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

/**
 * Polls /api/tfrs and hands zone features to onZones. Re-derives the zones
 * every minute from the last answer, so a TFR starts alerting the minute it
 * takes effect without waiting for the next fetch.
 */
export class TfrFeed {
  constructor({ onZones, onStatus, fetchImpl, endpoint = 'api/tfrs' }) {
    this.onZones = onZones;
    this.onStatus = onStatus;
    this.fetchImpl = fetchImpl;
    this.endpoint = endpoint;
    this.tfrs = [];
    this.status = { state: 'idle', source: null, count: 0, alerting: 0, lastError: null };
  }

  report(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus?.(this.status);
  }

  publish(now = Date.now()) {
    const features = this.tfrs.flatMap((tfr) => tfrToFeatures(tfr, now));
    const alerting = this.tfrs.filter((tfr) => tfrStatus(tfr, now).alerting).length;
    this.onZones?.(features, { authoritative: this.status.source === 'FAA' });
    this.report({ count: this.tfrs.length, alerting });
  }

  async load() {
    const fetchImpl = this.fetchImpl || fetch;
    try {
      const res = await fetchImpl(this.endpoint, { headers: { accept: 'application/json' } });
      const json = await res.json();
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`);
      this.tfrs = json.tfrs;
      this.report({ state: json.stale ? 'degraded' : 'live', source: 'FAA', lastError: json.stale ? 'last good list' : json.complete ? null : 'some limits still loading', fetchedAt: json.fetchedAt });
    } catch (err) {
      // The FAA is reachable from ordinary connections even when it refuses
      // the edge, and this mirror of its polygons sends CORS headers.
      try {
        const res = await fetchImpl(MIRROR_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this.tfrs = groupWfs(await res.json()).map((group) => assembleTfr(group, null));
        this.report({ state: 'degraded', source: 'tar1090 mirror', lastError: 'limits and times unavailable, drawn only' });
      } catch {
        this.report({ state: 'down', lastError: String(err.message || err).slice(0, 72) });
        return;
      }
    }
    this.publish();
  }

  start() {
    this.load();
    clearInterval(this.fetchTimer);
    clearInterval(this.statusTimer);
    this.fetchTimer = setInterval(() => this.load(), TFR_INTERVAL_MS);
    this.statusTimer = setInterval(() => this.tfrs.length && this.publish(), 60 * 1000);
  }
}
