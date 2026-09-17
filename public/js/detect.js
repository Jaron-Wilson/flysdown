/**
 * Detection engine.
 *
 * Pure functions over a normalised target plus the active zone list. Nothing in
 * here touches the map or the DOM, so the same rules can later run in a Worker
 * on a cron trigger to push alerts when nobody has the page open.
 *
 * The core question is "if this target holds its current track and speed, does
 * it end up somewhere it should not be, and how long have we got". That is a
 * straight-line dead-reckoning projection, not a flight-plan prediction: it
 * models no turns, no wind and no ATC instructions, and the UI says so.
 */

import { distanceNm, destination, pointInRing, altitudeAt, secondsToGround, bearingDelta, ringBoundingCircle } from './geo.js';
import { ZONE_KINDS } from './zones.js';

export const SEVERITY_RANK = { notice: 0, warning: 1, serious: 2, critical: 3 };
export const SEVERITY_BY_RANK = ['notice', 'warning', 'serious', 'critical'];

export const DEFAULTS = {
  horizonSec: 600,          // how far ahead to project
  imminentSec: 120,         // "about to happen" band
  soonSec: 360,             // "worth watching" band
  descentFpm: -4000,        // rapid descent threshold
  lowDescentFpm: -3000,     // gentler threshold once low
  lowAltFt: 10000,
  orbitTurnDeg: 270,        // cumulative turn that counts as a hold/orbit
  orbitRadiusNm: 12,
  orbitMinSec: 150,
  staleSec: 60,
};

const clampRank = (rank) => Math.max(0, Math.min(3, rank));

/** Horizontal containment only. */
export function zoneContains(zone, lat, lon) {
  if (zone.shape === 'circle') {
    return distanceNm(lat, lon, zone.centre.lat, zone.centre.lon) <= zone.radiusNm;
  }
  return pointInRing(lon, lat, zone.ring);
}

/** Vertical containment. Surface targets (vessels) have no altitude to test. */
export function inAltitudeBand(zone, alt) {
  if (alt === null || alt === undefined) return true;
  return alt >= zone.floorFt && alt <= zone.ceilingFt;
}

function targetCourse(target) {
  const course = target.track ?? target.cog ?? target.heading;
  return course === null || course === undefined ? null : course;
}

function targetSpeed(target) {
  return target.groundSpeed ?? target.sog ?? null;
}

/**
 * First moment inside the zone within the horizon, or null.
 *
 * Step size is tied to the zone's own size so a small zone cannot be stepped
 * over, then the crossing time is refined by bisection.
 */
export function firstEntry(target, zone, opts = DEFAULTS) {
  const speed = targetSpeed(target);
  const course = targetCourse(target);
  if (!speed || speed <= 0 || course === null) return null;

  const hits = (t) => {
    const distNm = (speed * t) / 3600;
    const pos = distNm === 0 ? { lat: target.lat, lon: target.lon } : destination(target.lat, target.lon, course, distNm);
    return zoneContains(zone, pos.lat, pos.lon) && inAltitudeBand(zone, altitudeAt(target, t)) ? pos : null;
  };

  // Do not project a descending target past its own arrival on the ground.
  const horizonSec = Math.min(opts.horizonSec, secondsToGround(target));
  const maxTravelNm = (speed * horizonSec) / 3600;
  const gapNm = distanceNm(target.lat, target.lon, zone.centre.lat, zone.centre.lon) - zone.radiusNm;
  if (gapNm > maxTravelNm) return null; // cannot physically reach it in the horizon

  const stepNm = Math.max(0.05, Math.min(2, zone.radiusNm / 2, 0.5));
  const stepSec = Math.max(1, (stepNm / speed) * 3600);

  let previous = 0;
  for (let t = 0; t <= horizonSec; t += stepSec) {
    const pos = hits(t);
    if (!pos) {
      previous = t;
      continue;
    }
    // Refine: the crossing is somewhere in (previous, t].
    let lo = previous;
    let hi = t;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (hits(mid)) hi = mid;
      else lo = mid;
    }
    const at = hits(hi) || pos;
    return { etaSec: hi, lat: at.lat, lon: at.lon, alt: altitudeAt(target, hi) };
  }
  return null;
}

/** Combined "already in it" / "heading into it" result for one target+zone. */
export function zoneStatus(target, zone, opts = DEFAULTS) {
  const alt = typeof target.alt === 'number' ? target.alt : null;
  const insideNow = zoneContains(zone, target.lat, target.lon) && inAltitudeBand(zone, alt);
  const edgeDistanceNm = distanceNm(target.lat, target.lon, zone.centre.lat, zone.centre.lon) - zone.radiusNm;

  if (insideNow) {
    return { state: 'inside', etaSec: 0, edgeDistanceNm, lat: target.lat, lon: target.lon, alt };
  }
  const entry = firstEntry(target, zone, opts);
  if (entry) return { state: 'projected', ...entry, edgeDistanceNm };
  return null;
}

function severityFor(zone, status, opts) {
  const base = ZONE_KINDS[zone.kind]?.insideRank ?? 2;
  if (status.state === 'inside') return SEVERITY_BY_RANK[clampRank(base)];
  const penalty = status.etaSec <= opts.imminentSec ? 0 : status.etaSec <= opts.soonSec ? 1 : 2;
  return SEVERITY_BY_RANK[clampRank(base - penalty)];
}

const mins = (sec) => {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
};

const ft = (v) => (typeof v === 'number' ? `${Math.round(v / 100) * 100} ft` : 'unknown alt');

/**
 * How to describe where a target is when it enters a zone. Aircraft get an
 * altitude, vessels get a speed: telling someone a ship is "at unknown alt"
 * is noise.
 */
function positionPhrase(target, alt) {
  if (target.kind === 'vessel') {
    const speed = target.sog;
    if (typeof speed !== 'number') return 'speed not reported';
    return speed < 0.5 ? 'stopped or moored' : `making ${speed.toFixed(1)} kt`;
  }
  return ft(alt);
}

/**
 * Cumulative turn over the recent track history. A target that has turned
 * through most of a circle while staying in a small area is holding, orbiting
 * or surveying rather than going somewhere.
 */
export function detectOrbit(target, opts = DEFAULTS) {
  const history = target.history || [];
  if (history.length < 5) return null;
  const spanSec = (history[history.length - 1].t - history[0].t) / 1000;
  if (spanSec < opts.orbitMinSec) return null;

  let turn = 0;
  for (let i = 1; i < history.length; i++) {
    const a = history[i - 1].track;
    const b = history[i].track;
    if (a === null || b === null || a === undefined || b === undefined) continue;
    turn += Math.abs(bearingDelta(a, b));
  }
  if (turn < opts.orbitTurnDeg) return null;

  const bounds = ringBoundingCircle(history.map((h) => [h.lon, h.lat]));
  if (bounds.radiusNm > opts.orbitRadiusNm) return null;
  return { turnDeg: Math.round(turn), radiusNm: bounds.radiusNm, spanSec };
}

/** Run every rule against one target. Returns alerts plus per-zone detail. */
export function evaluateTarget(target, zones, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const alerts = [];
  const zoneResults = [];

  for (const zone of zones) {
    if (!zone.enabled) continue;
    if (!zone.appliesTo.includes(target.kind)) continue;
    const status = zoneStatus(target, zone, opts);
    if (!status) continue;

    zoneResults.push({ zone, ...status });
    // Advisory zones still appear in the target's zone checks, they just do
    // not generate alerts.
    if (zone.advisory) continue;
    const severity = severityFor(zone, status, opts);
    const kindLabel = ZONE_KINDS[zone.kind]?.label || 'Zone';

    alerts.push(
      status.state === 'inside'
        ? {
            id: `${target.id}:inside:${zone.id}`,
            rule: 'zone-inside',
            severity,
            targetId: target.id,
            targetKind: target.kind,
            targetLabel: target.label,
            zoneId: zone.id,
            zoneName: zone.name,
            etaSec: 0,
            title: `Inside ${zone.name}`,
            detail: `${target.label} is within the ${kindLabel.toLowerCase()} boundary, ${positionPhrase(target, status.alt)}.`,
          }
        : {
            id: `${target.id}:projected:${zone.id}`,
            rule: 'zone-projected',
            severity,
            targetId: target.id,
            targetKind: target.kind,
            targetLabel: target.label,
            zoneId: zone.id,
            zoneName: zone.name,
            etaSec: status.etaSec,
            title: `Projected entry: ${zone.name}`,
            detail: `On current track, ${target.label} reaches ${zone.name} in ${mins(status.etaSec)}, ${positionPhrase(target, status.alt)}.`,
          }
    );
  }

  if (target.kind === 'aircraft') {
    const squawkRules = {
      7500: { severity: 'critical', text: 'Squawk 7500: unlawful interference' },
      7600: { severity: 'serious', text: 'Squawk 7600: radio failure' },
      7700: { severity: 'critical', text: 'Squawk 7700: general emergency' },
    };
    const squawk = squawkRules[Number(target.squawk)];
    if (squawk) {
      alerts.push({
        id: `${target.id}:squawk:${target.squawk}`,
        rule: 'squawk',
        severity: squawk.severity,
        targetId: target.id,
        targetKind: target.kind,
        targetLabel: target.label,
        title: squawk.text,
        detail: `${target.label} is transmitting ${target.squawk} at ${ft(target.alt)}.`,
      });
    }

    if (target.emergency) {
      alerts.push({
        id: `${target.id}:emergency`,
        rule: 'emergency',
        severity: 'critical',
        targetId: target.id,
        targetKind: target.kind,
        targetLabel: target.label,
        title: `Emergency declared: ${target.emergency}`,
        detail: `${target.label} is reporting emergency status "${target.emergency}".`,
      });
    }

    const vs = target.verticalRate;
    if (typeof vs === 'number' && !target.onGround) {
      const low = typeof target.alt === 'number' && target.alt < opts.lowAltFt;
      if (vs <= opts.descentFpm || (low && vs <= opts.lowDescentFpm)) {
        alerts.push({
          id: `${target.id}:descent`,
          rule: 'descent',
          severity: low ? 'serious' : 'warning',
          targetId: target.id,
          targetKind: target.kind,
          targetLabel: target.label,
          title: 'Rapid descent',
          detail: `${target.label} descending ${Math.abs(Math.round(vs))} ft/min through ${ft(target.alt)}.`,
        });
      }
    }

    const orbit = detectOrbit(target, opts);
    if (orbit) {
      alerts.push({
        id: `${target.id}:orbit`,
        rule: 'orbit',
        severity: 'notice',
        targetId: target.id,
        targetKind: target.kind,
        targetLabel: target.label,
        title: 'Orbiting / holding',
        detail: `${target.label} has turned ${orbit.turnDeg}° inside a ${orbit.radiusNm.toFixed(1)} NM area over the last ${mins(orbit.spanSec)}.`,
      });
    }
  }

  return { alerts, zoneResults };
}

/** Run the engine across every target. */
export function evaluateAll(targets, zones, options = {}) {
  const alerts = [];
  const byTarget = new Map();
  const zoneAlertCounts = new Map();

  for (const target of targets) {
    const result = evaluateTarget(target, zones, options);
    if (result.alerts.length) {
      byTarget.set(target.id, result);
      alerts.push(...result.alerts);
      for (const alert of result.alerts) {
        if (!alert.zoneId) continue;
        const current = zoneAlertCounts.get(alert.zoneId) || { count: 0, worst: 'notice' };
        current.count += 1;
        if (SEVERITY_RANK[alert.severity] > SEVERITY_RANK[current.worst]) current.worst = alert.severity;
        zoneAlertCounts.set(alert.zoneId, current);
      }
    } else {
      byTarget.set(target.id, result);
    }
  }

  alerts.sort((a, b) => {
    const bySeverity = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
    if (bySeverity !== 0) return bySeverity;
    return (a.etaSec ?? 1e9) - (b.etaSec ?? 1e9);
  });

  return { alerts, byTarget, zoneAlertCounts };
}
