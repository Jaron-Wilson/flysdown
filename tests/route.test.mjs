/**
 * Route-plausibility tests: node --test tests/
 *
 * The case that started these: BCS30A, a 737-800 whose adsbdb route says
 * Leipzig (EDDP) to Cologne (EDDK), reported while the aircraft was near
 * Paris, 489 NM from Leipzig and 304 NM from Cologne on a leg that is barely
 * 200 NM long. The panel had quoted a distance remaining and an arrival time
 * off that, which was confidently wrong. A route the aircraft's own position
 * contradicts must be labeled as such.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { routeFit, airportCode } from '../public/js/route.js';
import { distanceNm, bearingTo } from '../public/js/geo.js';
import { detectLanding, DEFAULTS } from '../public/js/detect.js';
import { summarizeUpstreamFailure, worstFeedIssue } from '../public/js/feeds.js';

const EDDP = { icao: 'EDDP', lat: 51.4239, lon: 12.2364 };
const EDDK = { icao: 'EDDK', lat: 50.8659, lon: 7.1427 };
const ROUTE = { origin: EDDP, destination: EDDK };

test('a reported route the aircraft is nowhere near is a mismatch', () => {
  // Over France, well past Cologne and far from both airports.
  const target = { lat: 47.9, lon: 1.9, track: 163 };
  const fit = routeFit(ROUTE, target);

  assert.equal(fit.verdict, 'mismatch');
  assert.equal(fit.reason, 'detour');
  // The tell: the two legs sum to several times the length of the route.
  assert.ok(fit.flownNm + fit.remainingNm > fit.totalNm * 2, `${fit.flownNm} + ${fit.remainingNm} vs ${fit.totalNm}`);
  assert.ok(fit.detourNm > 300);
});

test('an aircraft on the leg, pointed at the destination, is consistent', () => {
  const lat = (EDDP.lat + EDDK.lat) / 2;
  const lon = (EDDP.lon + EDDK.lon) / 2;
  const fit = routeFit(ROUTE, { lat, lon, track: bearingTo(lat, lon, EDDK.lat, EDDK.lon) });

  assert.equal(fit.verdict, 'consistent');
  assert.equal(fit.reason, null);
  assert.ok(Math.abs(fit.detourNm) < 1, `detour ${fit.detourNm}`);
  assert.ok(fit.bearingErrorDeg < 1);
});

test('normal vectoring and holding do not trip the detour check', () => {
  // 25 NM off the direct line, which is an ordinary reroute on a short leg.
  const fit = routeFit(ROUTE, { lat: 51.6, lon: 9.7, track: 250 });
  assert.equal(fit.verdict, 'consistent');
});

test('on the line but flying away from the destination is a mismatch', () => {
  const lat = (EDDP.lat + EDDK.lat) / 2;
  const lon = (EDDP.lon + EDDK.lon) / 2;
  const fit = routeFit(ROUTE, { lat, lon, track: bearingTo(lat, lon, EDDP.lat, EDDP.lon) });

  assert.equal(fit.verdict, 'mismatch');
  assert.equal(fit.reason, 'bearing');
  assert.ok(fit.bearingErrorDeg > 150);
});

test('heading is not judged on final approach, where it swings by design', () => {
  // 8 NM out and pointed 90 degrees off: turning onto an approach, not lost.
  const lat = EDDK.lat + 0.13;
  const fit = routeFit(ROUTE, { lat, lon: EDDK.lon, track: 90 });

  assert.ok(distanceNm(lat, EDDK.lon, EDDK.lat, EDDK.lon) < 25);
  assert.equal(fit.bearingErrorDeg, null);
  assert.equal(fit.verdict, 'consistent');
});

test('a route with one endpoint, or no position, claims nothing', () => {
  // An origin alone says nothing about where a flight is going.
  assert.equal(routeFit({ origin: EDDP, destination: null }, { lat: 47.9, lon: 1.9, track: 163 }).verdict, 'unknown');
  assert.equal(routeFit(ROUTE, null).verdict, 'unknown');
  assert.equal(routeFit(null, { lat: 47.9, lon: 1.9, track: 163 }).verdict, 'unknown');

  // A destination with no usable coordinates for the origin cannot be checked
  // for a detour, but heading still says something, so an aircraft pointed at
  // the destination is 'unknown' rather than 'consistent'.
  const towards = { origin: { icao: 'X' }, destination: EDDK };
  const aimed = routeFit(towards, { lat: 47.9, lon: 1.9, track: bearingTo(47.9, 1.9, EDDK.lat, EDDK.lon) });
  assert.equal(aimed.verdict, 'unknown');
  assert.equal(aimed.totalNm, null);
});

test('heading alone can contradict a destination-only route', () => {
  const away = routeFit({ origin: null, destination: EDDK }, { lat: 47.9, lon: 1.9, track: 200 });
  assert.equal(away.verdict, 'mismatch');
  assert.equal(away.reason, 'bearing');
});

/*
 * The other half of the same complaint: a Cloudflare 520 page reached the
 * status line word for word, because the summarizer took everything before
 * the first colon as the name of the source and that text has no colon.
 */

test('a proxy error page is summarized, not quoted', () => {
  const json = {
    ok: false,
    detail: [
      'The origin web server returned an invalid or incomplete response to Cloudflare. This typically indicates the origin is overloaded or misconfigured.',
    ],
  };
  const summary = summarizeUpstreamFailure(json, 520);

  assert.equal(summary, 'no source available: upstream not responding');
  assert.ok(summary.length < 72);
});

test('named upstream failures keep their name and reason', () => {
  const summary = summarizeUpstreamFailure(
    { ok: false, detail: ['adsb.lol: HTTP 429 - <html><head><title>429 Too Many Requests', 'opensky: timeout after 20s'] },
    503
  );
  assert.equal(summary, 'no source available: adsb.lol rate limited, opensky not responding');
});

test('any single reason is clamped to something a status line can hold', () => {
  const long = `adsb.fi: ${'x'.repeat(400)}`;
  const summary = summarizeUpstreamFailure({ ok: false, detail: [long] }, 403);
  assert.ok(summary.length <= 72, `length ${summary.length}`);
  assert.match(summary, /adsb\.fi/);
});

test('an error with no detail is clamped too, and never empty', () => {
  const summary = summarizeUpstreamFailure({ ok: false, error: 'y'.repeat(300) }, 500);
  assert.ok(summary.length <= 72);
  assert.equal(summarizeUpstreamFailure({}, 500), 'HTTP 500');
});

test('a dead feed outranks a stale one, and a paused feed is not a fault', () => {
  const down = { state: 'down' };
  const degraded = { state: 'degraded' };
  const live = { state: 'live' };
  const paused = { state: 'paused' };

  assert.equal(worstFeedIssue([live, degraded]), 'degraded');
  assert.equal(worstFeedIssue([degraded, down]), 'down');
  assert.equal(worstFeedIssue([live, live]), null);
  assert.equal(worstFeedIssue([paused, live]), null);
  // A feed paused while it was failing is still paused, not a fault to report.
  assert.equal(worstFeedIssue([{ state: 'paused', lastError: 'boom' }, live]), null);
  assert.equal(worstFeedIssue([null, undefined]), null);
  assert.equal(worstFeedIssue([]), null);
});

test('airports show the code people read, not the ICAO one', () => {
  // The complaint: KCRW and KDCA where every board says CRW and DCA.
  assert.equal(airportCode({ icao: 'KCRW', iata: 'CRW' }), 'CRW');
  assert.equal(airportCode({ icao: 'KDCA', iata: 'DCA' }), 'DCA');
  assert.equal(airportCode({ icao: 'EDDP', iata: 'LEJ' }), 'LEJ');
  // With no IATA code from the data, the US and Canadian conventions still
  // give the code people read: K or C, then the code itself.
  assert.equal(airportCode({ icao: 'KADW', iata: null }), 'ADW');
  assert.equal(airportCode({ icao: 'CYYZ' }), 'YYZ');
  assert.equal(airportCode({ icao: 'CZBB' }), 'ZBB');

  // Elsewhere the mapping is not one to one, so the ICAO code stands.
  assert.equal(airportCode({ icao: 'EDDP' }), 'EDDP');
  assert.equal(airportCode({ icao: 'PANC' }), 'PANC');
  assert.equal(airportCode({ icao: 'MYNN' }), 'MYNN');
  assert.equal(airportCode(null), '');
});

/*
 * Landing detection: "when im watcing a plane and i see its about to land and
 * it lands, let me see that its marked as landed, cause thats kinda cool to
 * watch." Both halves matter: on the ground now, and airborne a moment ago.
 */

const AT = 1789700000000;
const airborneThen = (minutesAgo, alt) => ({ t: AT - minutesAgo * 60000, lat: 38.9, lon: -77.0, alt, track: 316 });

test('an aircraft on the ground that was just flying has landed', () => {
  const landing = detectLanding({
    kind: 'aircraft',
    onGround: true,
    groundSpeed: 12,
    alt: null,
    updatedAt: AT,
    history: [airborneThen(6, 4200), airborneThen(3, 1800), { t: AT, lat: 38.85, lon: -77.04, alt: null, track: 316 }],
  });

  assert.ok(landing, 'expected a landing');
  assert.equal(landing.agoSec, 180);
  assert.equal(landing.fromAltFt, 1800);
});

test('an aircraft parked all along has not just landed', () => {
  const landing = detectLanding({
    kind: 'aircraft',
    onGround: true,
    groundSpeed: 0,
    alt: null,
    updatedAt: AT,
    history: [{ t: AT - 600000, lat: 38.85, lon: -77.04, alt: null }, { t: AT, lat: 38.85, lon: -77.04, alt: null }],
  });
  assert.equal(landing, null);
});

test('an aircraft on approach has not landed yet', () => {
  const landing = detectLanding({
    kind: 'aircraft',
    onGround: false,
    groundSpeed: 140,
    alt: 400,
    updatedAt: AT,
    history: [airborneThen(2, 2500), { t: AT, lat: 38.85, lon: -77.04, alt: 400 }],
  });
  assert.equal(landing, null, 'still flying at 400 ft and 140 kt');
});

test('a taxiing aircraft with a barometric offset still counts as down', () => {
  const landing = detectLanding({
    kind: 'aircraft',
    onGround: false,
    groundSpeed: 18,
    alt: 200,
    updatedAt: AT,
    history: [airborneThen(4, 3000), { t: AT, lat: 38.85, lon: -77.04, alt: 200 }],
  });
  assert.ok(landing);
  assert.equal(landing.agoSec, 240);
});

test('a landing stops being news after the window', () => {
  const stale = detectLanding({
    kind: 'aircraft',
    onGround: true,
    groundSpeed: 0,
    alt: null,
    updatedAt: AT,
    history: [airborneThen(30, 5000), { t: AT, lat: 38.85, lon: -77.04, alt: null }],
  });
  assert.equal(stale, null, `outside the ${DEFAULTS.landedWindowSec}s window`);
});

test('ships do not land', () => {
  assert.equal(detectLanding({ kind: 'vessel', onGround: false, groundSpeed: 0, history: [] }), null);
});

/*
 * The case Jaron reported: about twenty aircraft landing at Washington
 * National, all showing destinations elsewhere. Measured on 18 September 2026:
 * of eight aircraft on the ground at DCA, seven carried a route between two
 * airports that were neither DCA nor where they had come from. Six of those
 * seven were already caught by the detour test; BOS-DFW was not, because DCA
 * lies close to the great circle between them, which is what these two checks
 * are for.
 */

const DCA = { icao: 'KDCA', iata: 'DCA', lat: 38.8512, lon: -77.0402 };
const BOS = { icao: 'KBOS', iata: 'BOS', lat: 42.3656, lon: -71.0096 };
const DFW = { icao: 'KDFW', iata: 'DFW', lat: 32.8998, lon: -97.0403 };
const EWR = { icao: 'KEWR', iata: 'EWR', lat: 40.6925, lon: -74.1687 };
const PWM = { icao: 'KPWM', iata: 'PWM', lat: 43.6462, lon: -70.3087 };

test('parked at an airport on neither end of the route is a mismatch', () => {
  // AAL2077 sat at DCA reporting BOS to DFW. DCA is nearly on that line, so
  // the detour test alone cannot see it.
  const onLine = routeFit({ origin: BOS, destination: DFW }, { ...DCA, onGround: true, alt: null, groundSpeed: 0, track: 0, verticalRate: 0 });
  assert.ok(Math.abs(onLine.detourNm) < Math.max(60, onLine.totalNm * 0.35), 'the detour test should not fire here');
  assert.equal(onLine.verdict, 'mismatch');
  assert.equal(onLine.reason, 'on-ground-elsewhere');
  assert.ok(onLine.nearestEndpointNm > 300);
});

test('parked at one end of the route is consistent', () => {
  const atOrigin = routeFit({ origin: EWR, destination: PWM }, { lat: EWR.lat, lon: EWR.lon, onGround: true, alt: null, track: 0, verticalRate: 0 });
  assert.equal(atOrigin.verdict, 'consistent');
  const atDestination = routeFit({ origin: EWR, destination: PWM }, { lat: PWM.lat, lon: PWM.lon, onGround: true, alt: null, track: 0, verticalRate: 0 });
  assert.equal(atDestination.verdict, 'consistent');
});

test('descending to land far from the reported destination is a mismatch', () => {
  // On approach into DCA while the route claims Dallas: what he was watching.
  const arriving = routeFit(
    { origin: BOS, destination: DFW },
    { lat: 38.95, lon: -77.15, alt: 3200, verticalRate: -900, track: 170, onGround: false }
  );
  assert.equal(arriving.verdict, 'mismatch');
  assert.equal(arriving.reason, 'landing-elsewhere');
});

test('descending into the reported destination is not flagged', () => {
  const arriving = routeFit(
    { origin: BOS, destination: DCA },
    { lat: 38.95, lon: -77.15, alt: 3200, verticalRate: -900, track: 170, onGround: false }
  );
  assert.equal(arriving.verdict, 'consistent');
});

test('a normal cruise descent is not a landing somewhere else', () => {
  // Stepping down at altitude, 200 NM out: not low, so not landing.
  const cruise = routeFit(
    { origin: BOS, destination: DFW },
    { lat: 39.5, lon: -80.0, alt: 24000, verticalRate: -1200, track: 250, onGround: false }
  );
  assert.equal(cruise.verdict, 'consistent');
});
