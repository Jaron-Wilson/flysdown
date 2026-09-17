/**
 * Detection-engine tests: node --test tests/
 *
 * These cover the geometry and the rules, which are the parts that are easy to
 * get quietly wrong (an ETA that is off by a factor of 60, a ceiling that is
 * ignored, a small zone that gets stepped over).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { distanceNm, destination, bearingTo, pointInRing, secondsToGround } from '../public/js/geo.js';
import { prepareZone } from '../public/js/zones.js';
import { evaluateAll, evaluateTarget, firstEntry, zoneContains, inAltitudeBand, detectOrbit, closestApproach, detectCloseApproaches } from '../public/js/detect.js';

const P56B = prepareZone({
  type: 'Feature',
  properties: { id: 'p56b', name: 'P-56B', kind: 'prohibited', shape: 'circle', radiusNm: 1, floorFt: 0, ceilingFt: 18000, appliesTo: ['aircraft'] },
  geometry: { type: 'Point', coordinates: [-77.0672, 38.9217] },
});

const MALL = prepareZone({
  type: 'Feature',
  properties: { id: 'p56a', name: 'P-56A', kind: 'prohibited', shape: 'polygon', floorFt: 0, ceilingFt: 18000, appliesTo: ['aircraft'] },
  geometry: {
    type: 'Polygon',
    coordinates: [[[-77.0570, 38.9145], [-77.0000, 38.9145], [-77.0020, 38.8790], [-77.0600, 38.8790], [-77.0570, 38.9145]]],
  },
});

const HARBOR = prepareZone({
  type: 'Feature',
  properties: { id: 'harbor', name: 'Harbor watch', kind: 'custom', shape: 'circle', radiusNm: 8, floorFt: 0, ceilingFt: 60000, appliesTo: ['vessel'] },
  geometry: { type: 'Point', coordinates: [24.96, 60.12] },
});

/**
 * Place a target `rangeNm` away from a zone center and aim it straight at that
 * center. The inbound track must come from bearingTo, not the reciprocal of
 * the outbound bearing: great circles converge, so a target 60 NM west of a
 * point and tracking 090 misses it by nearly a mile.
 */
const inboundTo = (zone, rangeNm, fromBearing = 270) => {
  const start = destination(zone.center.lat, zone.center.lon, fromBearing, rangeNm);
  return { lat: start.lat, lon: start.lon, track: bearingTo(start.lat, start.lon, zone.center.lat, zone.center.lon) };
};

const aircraft = (over) => ({
  id: 'abc123', kind: 'aircraft', label: 'TEST01', lat: 38.9217, lon: -77.0672,
  alt: 5000, groundSpeed: 300, track: 90, verticalRate: 0, onGround: false,
  squawk: '1200', emergency: null, history: [], ...over,
});

test('geodesy round-trips: destination then distance returns the same range', () => {
  const p = destination(38.9, -77.0, 90, 20);
  assert.ok(Math.abs(distanceNm(38.9, -77.0, p.lat, p.lon) - 20) < 0.01);
  assert.ok(Math.abs(bearingTo(38.9, -77.0, p.lat, p.lon) - 90) < 0.5);
});

test('ray casting puts the White House inside the Mall polygon and Dulles outside', () => {
  assert.equal(pointInRing(-77.0365, 38.8977, MALL.ring), true);
  assert.equal(pointInRing(-77.4558, 38.9531, MALL.ring), false);
});

test('a target already inside a prohibited zone raises a critical alert', () => {
  const { alerts } = evaluateTarget(aircraft({ lat: 38.9217, lon: -77.0672 }), [P56B]);
  const inside = alerts.find((a) => a.rule === 'zone-inside');
  assert.ok(inside, 'expected an inside alert');
  assert.equal(inside.severity, 'critical');
  assert.equal(inside.etaSec, 0);
});

test('projected entry ETA matches time = distance / speed', () => {
  // 20 NM west of the zone center, inbound at 300 kt => 19 NM to the edge of a
  // 1 NM zone => 228 seconds.
  const target = aircraft({ ...inboundTo(P56B, 20), groundSpeed: 300 });
  const entry = firstEntry(target, P56B);
  assert.ok(entry, 'expected a projected entry');
  const expected = (19 / 300) * 3600;
  assert.ok(Math.abs(entry.etaSec - expected) < 5, `eta ${entry.etaSec} vs expected ${expected}`);
});

test('severity escalates as the projected entry gets closer', () => {
  const at = (rangeNm) => {
    const { alerts } = evaluateTarget(aircraft({ ...inboundTo(P56B, rangeNm), groundSpeed: 300 }), [P56B]);
    return alerts.find((a) => a.rule === 'zone-projected')?.severity;
  };
  assert.equal(at(6), 'critical');   // ~60 s out
  assert.equal(at(20), 'serious');   // ~228 s out
  assert.equal(at(40), 'warning');   // ~468 s out
});

test('a target above the zone ceiling is not an incursion', () => {
  const overhead = aircraft({ alt: 35000, groundSpeed: 0, track: null });
  assert.equal(zoneContains(P56B, overhead.lat, overhead.lon), true);
  assert.equal(inAltitudeBand(P56B, overhead.alt), false);
  const { alerts } = evaluateTarget(overhead, [P56B]);
  assert.equal(alerts.filter((a) => a.rule.startsWith('zone')).length, 0);
});

test('a descending target is caught once its projected altitude drops into the band', () => {
  // 60 NM out at 450 kt reaches the edge in ~472 s; descending 4,000 ft/min
  // from 35,000 ft it is through the 18,000 ft ceiling long before that, and
  // still above the ground when it arrives.
  const descending = aircraft({
    ...inboundTo(P56B, 60), groundSpeed: 450, alt: 35000, verticalRate: -4000,
  });
  const entry = firstEntry(descending, P56B);
  assert.ok(entry, 'expected entry after the descent crosses the ceiling');
  assert.ok(entry.alt <= 18000, `entry altitude ${entry.alt} should be inside the band`);
  const { alerts } = evaluateTarget(descending, [P56B]);
  assert.ok(alerts.some((a) => a.rule === 'descent'), 'expected a rapid-descent alert');
});

test('a small zone is not stepped over by a fast target', () => {
  const tiny = prepareZone({
    type: 'Feature',
    properties: { id: 'tiny', name: 'Tiny', kind: 'prohibited', shape: 'circle', radiusNm: 0.25, floorFt: 0, ceilingFt: 20000, appliesTo: ['aircraft'] },
    geometry: { type: 'Point', coordinates: [-77.0672, 38.9217] },
  });
  const fast = aircraft({ ...inboundTo(tiny, 60), groundSpeed: 550, alt: 5000 });
  assert.ok(firstEntry(fast, tiny), 'a 0.25 NM zone must still be detected at 550 kt');
});

test('a target tracking away from a zone raises nothing', () => {
  const inbound = inboundTo(P56B, 20);
  const outbound = aircraft({ lat: inbound.lat, lon: inbound.lon, track: (inbound.track + 180) % 360, groundSpeed: 300 });
  assert.equal(firstEntry(outbound, P56B), null);
});

test('emergency squawks are surfaced regardless of geography', () => {
  const { alerts } = evaluateTarget(aircraft({ lat: 10, lon: 10, squawk: '7700' }), [P56B]);
  const hit = alerts.find((a) => a.rule === 'squawk');
  assert.equal(hit.severity, 'critical');
});

test('orbit detection needs both a full turn and a small footprint', () => {
  const now = Date.now();
  const orbiting = aircraft({
    history: Array.from({ length: 13 }, (_, i) => {
      const bearing = (i * 30) % 360;
      const p = destination(38.9, -77.5, bearing, 2);
      return { t: now - (12 - i) * 30000, lat: p.lat, lon: p.lon, track: (bearing + 90) % 360 };
    }),
  });
  assert.ok(detectOrbit(orbiting), 'expected an orbit');

  const straight = aircraft({
    history: Array.from({ length: 13 }, (_, i) => ({
      t: now - (12 - i) * 30000, lat: 38.9 + i * 0.05, lon: -77.5, track: 0,
    })),
  });
  assert.equal(detectOrbit(straight), null);
});

test('zone appliesTo keeps maritime zones off aircraft and vice versa', () => {
  const vessel = { id: '123', kind: 'vessel', label: 'MV TEST', lat: 60.12, lon: 24.96, sog: 10, cog: 90, alt: null };
  const { alerts } = evaluateTarget(vessel, [HARBOR, P56B]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].zoneId, 'harbor');

  const plane = aircraft({ lat: 60.12, lon: 24.96 });
  const planeAlerts = evaluateTarget(plane, [HARBOR]).alerts;
  assert.equal(planeAlerts.length, 0, 'aircraft must not match a vessel-only zone');
});

test('evaluateAll sorts worst-first and counts alerts per zone', () => {
  const inside = aircraft({ id: 'inside1', label: 'INSIDE', lat: 38.9217, lon: -77.0672, groundSpeed: 0, track: null });
  const approaching = aircraft({ id: 'appr1', label: 'APPROACH', ...inboundTo(P56B, 45), groundSpeed: 300 });
  const { alerts, zoneAlertCounts } = evaluateAll([approaching, inside], [P56B]);
  assert.equal(alerts[0].severity, 'critical');
  assert.equal(zoneAlertCounts.get('p56b').count, 2);
  assert.equal(zoneAlertCounts.get('p56b').worst, 'critical');
});

test('a target that will hit the ground first is not projected past it', () => {
  // Descending 6,000 ft/min from 9,000 ft reaches the ground in 90 s, well
  // before it could cover the 60 NM to the zone.
  const doomed = aircraft({ ...inboundTo(P56B, 60), groundSpeed: 450, alt: 9000, verticalRate: -6000 });
  assert.ok(Math.abs(secondsToGround(doomed) - 90) < 0.5);
  assert.equal(firstEntry(doomed, P56B), null);
});

test('advisory zones report in zone checks but never raise alerts', () => {
  const advisory = prepareZone({
    type: 'Feature',
    properties: { id: 'sfra', name: 'SFRA', kind: 'sfra', shape: 'circle', radiusNm: 30, floorFt: 0, ceilingFt: 18000, appliesTo: ['aircraft'] },
    geometry: { type: 'Point', coordinates: [-77.035, 38.8594] },
  });
  assert.equal(advisory.advisory, true, 'sfra should default to advisory');

  const inside = aircraft({ lat: 38.8594, lon: -77.035, alt: 9000, groundSpeed: 250 });
  const { alerts, zoneResults } = evaluateTarget(inside, [advisory]);
  assert.equal(alerts.length, 0, 'advisory zones must not alert');
  assert.equal(zoneResults.length, 1, 'but must still be reported');
  assert.equal(zoneResults[0].state, 'inside');
});

test('real FAA zone data loads and keeps its published limits', async () => {
  const { readFile } = await import('node:fs/promises');
  const json = JSON.parse(await readFile(new URL('../public/data/zones.json', import.meta.url), 'utf8'));
  const zones = json.features.map(prepareZone);
  assert.ok(zones.length >= 10, 'expected the FAA prohibited areas plus the hand-added zones');

  const p56b = zones.find((z) => z.name.startsWith('P-56B'));
  assert.ok(p56b, 'P-56B should be present');
  assert.equal(p56b.ceilingFt, 18000);
  assert.equal(p56b.floorFt, 0);
  // The Naval Observatory sits inside P-56B; Dulles does not.
  assert.equal(zoneContains(p56b, 38.9214, -77.0669), true);
  assert.equal(zoneContains(p56b, 38.9531, -77.4558), false);

  const mall = zones.find((z) => z.name.startsWith('P-56A'));
  assert.equal(zoneContains(mall, 38.8977, -77.0365), true, 'the White House is inside P-56A');
});

/* ---------- vessel close approach (CPA / TCPA) ---------- */

const ship = (over) => ({
  id: 'm1', kind: 'vessel', label: 'SHIP ONE', lat: 60, lon: 24,
  sog: 10, cog: 90, heading: 90, navStatus: 0, alt: null, ...over,
});

/** n NM east of longitude 24 at the given latitude. */
const eastOf = (lat, nm) => 24 + nm / (60 * Math.cos((lat * Math.PI) / 180));

test('head-on pair: CPA is zero and TCPA is range over closing speed', () => {
  const a = ship({ id: 'a', cog: 90 });
  const b = ship({ id: 'b', label: 'SHIP TWO', lon: eastOf(60, 10), cog: 270 });
  const { cpaNm, tcpaSec, rangeNm, closing } = closestApproach(a, b);
  assert.ok(Math.abs(rangeNm - 10) < 0.01, `range ${rangeNm}`);
  assert.equal(closing, true);
  // 10 NM closing at 20 kt is half an hour.
  assert.ok(Math.abs(tcpaSec - 1800) < 5, `tcpa ${tcpaSec}`);
  assert.ok(cpaNm < 0.01, `cpa ${cpaNm}`);
});

test('parallel pair at the same speed never closes', () => {
  const a = ship({ id: 'a', cog: 90 });
  const b = ship({ id: 'b', lon: eastOf(60, 3), cog: 90 });
  const { closing, cpaNm, tcpaSec } = closestApproach(a, b);
  assert.equal(closing, false);
  assert.equal(tcpaSec, 0);
  assert.ok(Math.abs(cpaNm - 3) < 0.01, 'CPA is simply the current range');
});

test('crossing pair keeps its offset as the closest approach', () => {
  const a = ship({ id: 'a', cog: 90 });
  const b = ship({ id: 'b', lat: 60 + 5 / 60, lon: eastOf(60, 10), cog: 270 });
  const { cpaNm, tcpaSec } = closestApproach(a, b);
  assert.ok(Math.abs(tcpaSec - 1800) < 30, `tcpa ${tcpaSec}`);
  assert.ok(Math.abs(cpaNm - 5) < 0.1, `cpa ${cpaNm} should be the 5 NM offset`);
});

test('a pair that has already passed is not closing', () => {
  const a = ship({ id: 'a', cog: 270 });
  const b = ship({ id: 'b', lon: eastOf(60, 5), cog: 90 });
  assert.equal(closestApproach(a, b).closing, false);
});

test('close approach raises one alert per pair, not two', () => {
  const a = ship({ id: 'a', cog: 90 });
  const b = ship({ id: 'b', label: 'SHIP TWO', lon: eastOf(60, 4), cog: 270 });
  const alerts = detectCloseApproaches([a, b]);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].rule, 'close-approach');
  assert.ok(alerts[0].detail.includes('NM apart'));
  assert.deepEqual([alerts[0].targetId, alerts[0].otherId], ['a', 'b']);
  // Order of the input must not change the alert identity.
  assert.equal(detectCloseApproaches([b, a])[0].id, alerts[0].id);
});

test('a harbor full of moored ships raises nothing', () => {
  const moored = Array.from({ length: 30 }, (_, i) => ship({
    id: `moored${i}`,
    lat: 60 + i * 0.0004,
    lon: 24 + i * 0.0004,
    sog: 0,
    navStatus: 5,
  }));
  assert.equal(detectCloseApproaches(moored).length, 0);

  // Anchored and drifting-slow vessels are excluded the same way.
  assert.equal(detectCloseApproaches([ship({ id: 'x', sog: 0.2 }), ship({ id: 'y', sog: 0.1, lon: eastOf(60, 0.05) })]).length, 0);
});

test('close approach severity follows how close and how soon', () => {
  const severityFor = (missNm, closingKt) => {
    const a = ship({ id: 'a', cog: 90, sog: closingKt / 2 });
    const b = ship({
      id: 'b',
      lat: 60 + missNm / 60,
      lon: eastOf(60, 6),
      cog: 270,
      sog: closingKt / 2,
    });
    return detectCloseApproaches([a, b])[0]?.severity;
  };
  // 6 NM apart closing at 40 kt is 9 minutes: urgent.
  assert.equal(severityFor(0.05, 40), 'critical');
  assert.equal(severityFor(0.2, 40), 'serious');
  // Same geometry closing at 10 kt is 36 minutes out, beyond the horizon.
  assert.equal(severityFor(0.05, 10), undefined);
  // A comfortable pass raises nothing at all.
  assert.equal(severityFor(3, 40), undefined);
});

test('evaluateAll includes pairwise vessel risk alongside per-target rules', () => {
  const a = ship({ id: 'a', cog: 90 });
  const b = ship({ id: 'b', label: 'SHIP TWO', lon: eastOf(60, 4), cog: 270 });
  const { alerts, approaches } = evaluateAll([a, b], []);
  assert.equal(approaches.length, 1);
  assert.ok(alerts.some((x) => x.rule === 'close-approach'));
  assert.equal(evaluateAll([a, b], [], { closeApproaches: false }).approaches.length, 0);
});
