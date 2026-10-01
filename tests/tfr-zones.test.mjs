import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { tfrStatus, tfrToFeatures, TfrFeed, MIRROR_URL } from '../public/js/tfrs.js';
import { prepareZone, ZoneStore } from '../public/js/zones.js';

const T0 = Date.parse('2026-10-02T18:00:00Z');
const ring = [[-77.5, 39.6], [-77.4, 39.6], [-77.4, 39.7], [-77.5, 39.6]];
const vip = {
  notam: '6/6580',
  type: 'VIP',
  place: 'Thurmont, MD',
  polygons: [ring],
  detailLoaded: true,
  floorFt: 0,
  ceilingFt: 4999,
  agl: true,
  limitsText: 'surface to 4,999 ft AGL',
  areas: 1,
  effective: Date.parse('2026-10-02T16:45:00Z'),
  expires: Date.parse('2026-10-03T14:30:00Z'),
  dronesOnly: false,
};

test('a TFR alerts only while in effect, for manned aircraft, with known limits', () => {
  assert.deepEqual(tfrStatus(vip, T0), { alerting: true, reason: '' });
  assert.match(tfrStatus(vip, Date.parse('2026-10-01T00:00:00Z')).reason, /^in effect from /);
  assert.equal(tfrStatus(vip, Date.parse('2026-10-04T00:00:00Z')).reason, 'ended');
  assert.equal(tfrStatus({ ...vip, dronesOnly: true }, T0).reason, 'drones only');
  assert.equal(tfrStatus({ ...vip, detailLoaded: false }, T0).reason, 'limits not loaded');
  assert.equal(tfrStatus({ ...vip, expires: null }, T0).alerting, true, 'no published end means still in effect');
  assert.equal(tfrStatus({ ...vip, restricts: false }, T0).reason, 'conditions, not a prohibition');
  assert.equal(tfrStatus({ ...vip, restricts: true }, T0).alerting, true);
});

test('an active TFR becomes an alerting zone with its real limits', () => {
  const [feature] = tfrToFeatures(vip, T0);
  const zone = prepareZone(feature);
  assert.equal(zone.kind, 'tfr');
  assert.equal(zone.advisory, false);
  assert.equal(zone.floorFt, 0);
  assert.equal(zone.ceilingFt, 4999);
  assert.equal(zone.agl, true);
  assert.equal(zone.live, true);
  assert.match(zone.name, /TFR 6\/6580 Thurmont, MD/);
  assert.match(zone.note, /VIP TFR, FDC 6\/6580/);
  assert.equal(zone.id, 'tfr-6-6580-0');
});

test('an upcoming or limitless TFR is drawn as advisory, and says why', () => {
  const early = prepareZone(tfrToFeatures(vip, Date.parse('2026-10-01T00:00:00Z'))[0]);
  assert.equal(early.advisory, true);
  assert.match(early.advisoryReason, /in effect from/);
  const bare = prepareZone(tfrToFeatures({ ...vip, detailLoaded: false, floorFt: null, ceilingFt: null, limitsText: null }, T0)[0]);
  assert.equal(bare.advisory, true);
  assert.equal(bare.ceilingFt, 99999);
  assert.match(bare.note, /were not available/);
});

test('a multi-area NOTAM is labeled approximate, one zone per polygon', () => {
  const features = tfrToFeatures({ ...vip, polygons: [ring, ring, [[0, 0], [1, 1]]], areas: 3 }, T0);
  assert.equal(features.length, 2, 'a degenerate ring is skipped');
  assert.ok(features.every((f) => f.properties.approx));
});

test('live zones replace each other, and a zone switched off stays off', () => {
  const store = new ZoneStore();
  store.setLive(tfrToFeatures(vip, T0));
  assert.equal(store.all().length, 1);
  store.updateZone('tfr-6-6580-0', { enabled: false });
  store.setLive(tfrToFeatures(vip, T0 + 60_000));
  assert.equal(store.get('tfr-6-6580-0').enabled, false);
  store.setLive([]);
  assert.equal(store.all().length, 0);
});

test('the FAA list supersedes the seeded TFRs, a limitless mirror does not', () => {
  const store = new ZoneStore();
  store.seeded = [prepareZone({ type: 'Feature', properties: { id: 'tfr-dlr', kind: 'tfr', shape: 'circle', radiusNm: 3 }, geometry: { type: 'Point', coordinates: [-117.92, 33.81] } })];
  store.setLive(tfrToFeatures(vip, T0), { authoritative: true });
  assert.deepEqual(store.all().map((z) => z.id), ['tfr-6-6580-0']);
  store.setLive(tfrToFeatures({ ...vip, detailLoaded: false }, T0), { authoritative: false });
  assert.deepEqual(store.all().map((z) => z.id), ['tfr-dlr', 'tfr-6-6580-0']);
});

test('when /api/tfrs is down, the mirror is drawn without alerting', async () => {
  const wfs = await readFile(new URL('./fixtures/tfr-wfs.json', import.meta.url), 'utf8');
  let zones = [];
  const feed = new TfrFeed({
    onZones: (features) => (zones = features),
    fetchImpl: async (url) => (url === MIRROR_URL ? new Response(wfs) : new Response('{"ok":false,"error":"FAA TFR service unavailable"}', { status: 502 })),
  });
  await feed.load();
  assert.equal(feed.status.source, 'tar1090 mirror');
  assert.equal(feed.status.state, 'degraded');
  assert.equal(zones.length, 6);
  assert.ok(zones.every((f) => f.properties.advisory));
  assert.equal(feed.status.alerting, 0);
});

test('from the API, active TFRs count as in effect', async () => {
  let zones = [];
  const feed = new TfrFeed({
    onZones: (features) => (zones = features),
    fetchImpl: async () => new Response(JSON.stringify({ ok: true, complete: true, fetchedAt: T0, tfrs: [{ ...vip, effective: Date.now() - 1000, expires: Date.now() + 3_600_000 }] })),
  });
  await feed.load();
  assert.equal(feed.status.source, 'FAA');
  assert.equal(feed.status.state, 'live');
  assert.equal(feed.status.alerting, 1);
  assert.equal(zones[0].properties.advisory, false);
});
