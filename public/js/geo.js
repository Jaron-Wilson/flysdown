/**
 * Geodesy + geometry helpers.
 *
 * Pure functions, no DOM and no map dependency, so the same module can run in
 * a Worker or a scheduled job later for server-side alerting.
 *
 * Units used throughout: distance in nautical miles, speed in knots,
 * altitude in feet, vertical rate in feet per minute, bearings in degrees true.
 */

export const EARTH_RADIUS_NM = 3440.065;

const toRad = (deg) => (deg * Math.PI) / 180;
const toDeg = (rad) => (rad * 180) / Math.PI;

export const normalizeBearing = (deg) => ((deg % 360) + 360) % 360;

/** Smallest signed difference between two bearings, in (-180, 180]. */
export function bearingDelta(from, to) {
  let d = normalizeBearing(to) - normalizeBearing(from);
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

/** Great-circle distance in nautical miles. */
export function distanceNm(lat1, lon1, lat2, lon2) {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Initial great-circle bearing from point 1 to point 2, in degrees true. */
export function bearingTo(lat1, lon1, lat2, lon2) {
  const p1 = toRad(lat1);
  const p2 = toRad(lat2);
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dLon);
  return normalizeBearing(toDeg(Math.atan2(y, x)));
}

/** Point reached by traveling distNm along a great circle on the given bearing. */
export function destination(lat, lon, bearing, distNm) {
  const d = distNm / EARTH_RADIUS_NM;
  const b = toRad(bearing);
  const p1 = toRad(lat);
  const l1 = toRad(lon);
  const sinP2 = Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b);
  const p2 = Math.asin(Math.min(1, Math.max(-1, sinP2)));
  const l2 =
    l1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(p1),
      Math.cos(d) - Math.sin(p1) * sinP2
    );
  let lonOut = toDeg(l2);
  if (lonOut > 180) lonOut -= 360;
  if (lonOut < -180) lonOut += 360;
  return { lat: toDeg(p2), lon: lonOut };
}

/**
 * Points along the great circle between two positions.
 *
 * A straight line between two distant airports is wrong on a Mercator map:
 * the shortest path curves. This interpolates the real path so a route from
 * Philadelphia to Austin, or anything transoceanic, is drawn as flown.
 * Longitudes are kept continuous so a path crossing the antimeridian does not
 * draw itself the long way round the world.
 */
export function greatCirclePath(lat1, lon1, lat2, lon2, steps = 64) {
  const p1 = toRad(lat1);
  const l1 = toRad(lon1);
  const p2 = toRad(lat2);
  const l2 = toRad(lon2);

  const d =
    2 *
    Math.asin(
      Math.min(1, Math.sqrt(Math.sin((p2 - p1) / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin((l2 - l1) / 2) ** 2))
    );
  if (!Number.isFinite(d) || d < 1e-9) return [[lon1, lat1], [lon2, lat2]];

  const points = [];
  let previousLon = null;
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x = a * Math.cos(p1) * Math.cos(l1) + b * Math.cos(p2) * Math.cos(l2);
    const y = a * Math.cos(p1) * Math.sin(l1) + b * Math.cos(p2) * Math.sin(l2);
    const z = a * Math.sin(p1) + b * Math.sin(p2);

    const lat = toDeg(Math.atan2(z, Math.hypot(x, y)));
    let lon = toDeg(Math.atan2(y, x));
    if (previousLon !== null) {
      while (lon - previousLon > 180) lon -= 360;
      while (previousLon - lon > 180) lon += 360;
    }
    previousLon = lon;
    points.push([lon, lat]);
  }
  return points;
}

/** Ray-casting containment test. Ring is [[lon, lat], ...], closed or not. */
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const straddles = yi > lat !== yj > lat;
    if (straddles && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Approximate a circle as a polygon ring for rendering. */
export function circleRing(lat, lon, radiusNm, steps = 72) {
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const p = destination(lat, lon, (360 * i) / steps, radiusNm);
    ring.push([p.lon, p.lat]);
  }
  return ring;
}

/**
 * Bounding circle of a ring: used only as a cheap prefilter, so an
 * over-estimate is safe and an under-estimate is not.
 */
export function ringBoundingCircle(ring) {
  let minLat = 90;
  let maxLat = -90;
  let minLon = 180;
  let maxLon = -180;
  for (const [lon, lat] of ring) {
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
    minLon = Math.min(minLon, lon);
    maxLon = Math.max(maxLon, lon);
  }
  const lat = (minLat + maxLat) / 2;
  const lon = (minLon + maxLon) / 2;
  let radiusNm = 0;
  for (const [plon, plat] of ring) {
    radiusNm = Math.max(radiusNm, distanceNm(lat, lon, plat, plon));
  }
  return { lat, lon, radiusNm };
}

/**
 * Dead-reckon a target forward along its current track at its current speed,
 * with altitude extrapolated from vertical rate.
 *
 * This is deliberately a straight-line projection: it answers "if nothing
 * changes, where does this end up", which is the question a geofence warning
 * needs. It does not model turns, wind or flight plans.
 */
export function projectPath(target, { horizonSec = 600, stepSec = 30 } = {}) {
  const speed = target.groundSpeed ?? target.sog ?? 0;
  const course = target.track ?? target.cog ?? target.heading;
  if (!speed || course === null || course === undefined) return [];

  const samples = [];
  for (let t = 0; t <= horizonSec; t += stepSec) {
    const distNm = (speed * t) / 3600;
    const { lat, lon } = distNm === 0
      ? { lat: target.lat, lon: target.lon }
      : destination(target.lat, target.lon, course, distNm);
    samples.push({ t, lat, lon, alt: altitudeAt(target, t) });
  }
  return samples;
}

/**
 * Extrapolated altitude in feet at t seconds from now, or null for surface
 * targets. Clamped at ground level: a constant-rate descent extrapolated far
 * enough goes below sea level, which is not a place an aircraft can be.
 */
export function altitudeAt(target, t) {
  if (typeof target.alt !== 'number') return null;
  const rate = target.verticalRate || 0;
  return Math.max(0, target.alt + (rate * t) / 60);
}

/**
 * Seconds until a descending target reaches the ground at its current rate.
 * Infinity for level or climbing targets. Used to stop projecting a target
 * past the point where it has landed.
 */
export function secondsToGround(target) {
  const rate = target.verticalRate;
  if (typeof target.alt !== 'number' || typeof rate !== 'number' || rate >= 0) return Infinity;
  return (target.alt / -rate) * 60;
}
