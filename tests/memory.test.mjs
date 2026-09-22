/**
 * Retention tests: node --test tests/
 *
 * The page ran a large desktop out of memory. Measured: with ~790 targets on
 * screen the whole browser grew from 763 MB to 981 MB in eight minutes, in a
 * straight line, because every target kept 45 minutes and 400 positions and
 * all of it was re-sent to the map as trail geometry every tick. These pin
 * down the bounded behavior that replaced it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TargetStore, worthKeeping, TRAIL_POINTS } from '../public/js/feeds.js';
import { detectOrbit } from '../public/js/detect.js';

const T0 = 1789700000000;

// A straight, level flight reported every 5 s, the aircraft poll interval.
function straightFlight(store, id, polls, { start = T0, protect = false } = {}) {
  if (protect) store.protect(`aircraft:${id}`);
  for (let i = 0; i < polls; i += 1) {
    store.ingest('aircraft', [{ id, lat: 38 + i * 0.004, lon: -77, alt: 30000, track: 0 }], start + i * 5000, []);
  }
  return store.get(`aircraft:${id}`);
}

test('a straight flight keeps a point every 15 s, not every poll', () => {
  const store = new TargetStore();
  const target = straightFlight(store, 'a1', 120); // ten minutes of polls
  // 600 s at one kept point per 15 s is about 40, plus the provisional head.
  assert.ok(target.history.length <= 45, `kept ${target.history.length}`);
  assert.ok(target.history.length >= 35, `kept ${target.history.length}`);
});

test('the trail always reaches the aircraft: the newest position is the head', () => {
  const store = new TargetStore();
  const target = straightFlight(store, 'a2', 7);
  const last = target.history[target.history.length - 1];
  assert.equal(last.lat, 38 + 6 * 0.004);
  assert.ok(target.history.filter((h) => h.head).length <= 1);
});

test('ambient history is bounded however long the page stays open', () => {
  const store = new TargetStore();
  const target = straightFlight(store, 'a3', 720); // an hour of polls
  const spanMin = (target.history.at(-1).t - target.history[0].t) / 60000;
  assert.ok(target.history.length <= 120, `kept ${target.history.length}`);
  assert.ok(spanMin <= 15.5, `spans ${spanMin.toFixed(1)} min`);
});

test('the selected target keeps its long, full-resolution history', () => {
  const store = new TargetStore();
  const target = straightFlight(store, 'a4', 400, { protect: true }); // 33 minutes
  assert.ok(target.history.length > 300, `kept ${target.history.length}`);
  const spanMin = (target.history.at(-1).t - target.history[0].t) / 60000;
  assert.ok(spanMin > 30, `spans ${spanMin.toFixed(1)} min`);
});

test('turns, climbs and touchdowns are kept at full detail', () => {
  const base = { t: T0, lat: 38, lon: -77, alt: 30000, track: 0 };
  assert.equal(worthKeeping(base, { ...base, t: T0 + 5000, track: 12 }), true, 'a 12 degree turn');
  assert.equal(worthKeeping(base, { ...base, t: T0 + 5000, alt: 29000 }), true, 'a 1,000 ft change');
  assert.equal(worthKeeping(base, { ...base, t: T0 + 5000, alt: null }), true, 'airborne to ground');
  assert.equal(worthKeeping(base, { ...base, t: T0 + 5000, lat: 38.001 }), false, 'nothing much changed');
  assert.equal(worthKeeping(base, { ...base, t: T0 + 16000, lat: 38.001 }), true, 'fifteen seconds passed');
});

test('trails send a short tail, not the history', () => {
  const store = new TargetStore();
  const target = straightFlight(store, 'a5', 400, { protect: true });
  const [feature] = store.trailFeatures([target]);
  assert.equal(feature.geometry.coordinates.length, TRAIL_POINTS);
  assert.ok(target.history.length > TRAIL_POINTS * 10);
});

test('the orbit rule judges its own ten minutes, not the whole retained history', () => {
  // Forty minutes of history: a long straight transit, then an orbit in the
  // last ten. The transit must not dilute the orbit out of existence.
  const history = [];
  for (let i = 0; i < 60; i += 1) history.push({ t: T0 + i * 30000, lat: 36 + i * 0.05, lon: -77, alt: 8000, track: 0 });
  const orbitStart = T0 + 60 * 30000;
  for (let i = 0; i < 40; i += 1) {
    const angle = (i / 40) * 2 * Math.PI;
    history.push({ t: orbitStart + i * 15000, lat: 39 + 0.05 * Math.cos(angle), lon: -77 + 0.05 * Math.sin(angle), alt: 8000, track: (i * 9) % 360 });
  }
  const orbit = detectOrbit({ history });
  assert.ok(orbit, 'the orbit in the last ten minutes should be found');
  assert.ok(orbit.radiusNm < 12);
});
