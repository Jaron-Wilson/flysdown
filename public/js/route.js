/**
 * Does a reported route match what the aircraft is actually doing?
 *
 * ADS-B carries no origin or destination, so routes come from adsbdb, which
 * keys them on the callsign. A callsign is a flight number, not a leg: the
 * same number flies a different pair of airports on a different day, airlines
 * reuse numbers, and volunteer data goes stale. Drawing that line and quoting
 * an arrival time as though it were filed is how a panel ends up confidently
 * wrong, so every route is measured against the aircraft's own position and
 * track before any of it is presented as where the flight is going.
 *
 * Two checks, both pure geometry:
 *
 *   1. Detour. On a real leg, the distance from the origin to the aircraft
 *      plus the distance from the aircraft to the destination stays close to
 *      the length of the leg itself. Vectoring, holding and weather
 *      deviations add tens of miles. Flying somewhere else entirely adds
 *      hundreds, and the sum stops resembling the leg at all.
 *   2. Bearing. An aircraft well away from its destination is usually pointed
 *      inside a wide cone around it. Far out and pointed away is a mismatch.
 *      Close in this says nothing, because the aircraft is turning onto an
 *      approach, so the check is skipped there.
 *
 * Neither check can prove a route right. They catch the case that matters:
 * the panel claiming a destination the aircraft is demonstrably not flying to.
 */
import { distanceNm, bearingTo, bearingDelta } from './geo.js';

/** Wandering allowed before a route is called wrong: the larger of these. */
const DETOUR_FLOOR_NM = 60;
const DETOUR_FRACTION = 0.35;

/** Under this range the heading is about the approach, not the destination. */
const BEARING_CHECK_MIN_NM = 25;
const BEARING_LIMIT_DEG = 75;

/**
 * @param {{origin: object|null, destination: object|null}|null} route
 * @param {{lat: number, lon: number, track: number|null}|null} target
 * @returns {{
 *   verdict: 'consistent'|'mismatch'|'unknown',
 *   reason: 'detour'|'bearing'|null,
 *   totalNm: number|null, flownNm: number|null, remainingNm: number|null,
 *   detourNm: number|null, bearingErrorDeg: number|null,
 * }}
 */
/**
 * The code to show for an airport.
 *
 * adsbdb carries both, and ICAO is the technical identifier, but it is not the
 * one anybody reads: a flight from Charleston to Washington National is CRW to
 * DCA on every board and ticket, not KCRW to KDCA. IATA first, then ICAO for
 * the military and general aviation fields that have no IATA code at all.
 */
export const airportCode = (airport) => airport?.iata || airport?.icao || '';

export function routeFit(route, target) {
  const origin = airportPoint(route?.origin);
  const destination = airportPoint(route?.destination);
  const result = {
    verdict: 'unknown',
    reason: null,
    totalNm: null,
    flownNm: null,
    remainingNm: null,
    detourNm: null,
    bearingErrorDeg: null,
  };

  const hasFix = target && Number.isFinite(target.lat) && Number.isFinite(target.lon);
  if (!hasFix || (!origin && !destination)) return result;

  result.flownNm = origin ? distanceNm(origin.lat, origin.lon, target.lat, target.lon) : null;
  result.remainingNm = destination ? distanceNm(target.lat, target.lon, destination.lat, destination.lon) : null;
  result.totalNm = origin && destination ? distanceNm(origin.lat, origin.lon, destination.lat, destination.lon) : null;

  if (result.totalNm !== null) {
    result.detourNm = result.flownNm + result.remainingNm - result.totalNm;
  }

  if (
    destination &&
    Number.isFinite(target.track) &&
    result.remainingNm !== null &&
    result.remainingNm > BEARING_CHECK_MIN_NM
  ) {
    const wanted = bearingTo(target.lat, target.lon, destination.lat, destination.lon);
    result.bearingErrorDeg = Math.abs(bearingDelta(target.track, wanted));
  }

  // Distance first: it is the stronger signal, and it names both airports.
  if (
    result.detourNm !== null &&
    result.detourNm > Math.max(DETOUR_FLOOR_NM, result.totalNm * DETOUR_FRACTION)
  ) {
    result.verdict = 'mismatch';
    result.reason = 'detour';
    return result;
  }

  if (result.bearingErrorDeg !== null && result.bearingErrorDeg > BEARING_LIMIT_DEG) {
    result.verdict = 'mismatch';
    result.reason = 'bearing';
    return result;
  }

  // One endpoint and a heading that is not obviously wrong is as much as can
  // be said, so do not claim more than 'nothing contradicts this'.
  result.verdict = origin && destination ? 'consistent' : 'unknown';
  return result;
}

function airportPoint(airport) {
  if (!airport || !Number.isFinite(airport.lat) || !Number.isFinite(airport.lon)) return null;
  return airport;
}
