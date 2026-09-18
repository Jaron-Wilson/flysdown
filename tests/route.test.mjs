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

import { routeFit } from '../public/js/route.js';
import { distanceNm, bearingTo } from '../public/js/geo.js';
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
