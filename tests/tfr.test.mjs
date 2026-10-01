import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseTfrDetail, appliesToDronesOnly, limitFeet, groupWfs, assembleTfr, placeFromTitle, notamIdFromKey, detailUrl } from '../public/js/tfr.js';
import { buildTfrs, publicBody, MAX_DETAILS_PER_RUN, WFS_URL } from '../functions/api/tfrs.js';

const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('NOTAM keys and detail URLs', () => {
  assert.equal(notamIdFromKey('6/6580-1-FDC-F'), '6/6580');
  assert.equal(detailUrl('6/6580'), 'https://tfr.faa.gov/download/detail_6_6580.xml');
  assert.equal(placeFromTitle('MAYPORT, FL, Sunday, September 27, 2026 through Friday, October 2, 2026 Local'), 'Mayport, FL');
  assert.equal(placeFromTitle('8NM SE BIG SUR, CA, Monday, ...'), '8nm Se Big Sur, CA');
});

test('vertical limits: AGL, MSL, flight levels, and an unreadable ceiling is never low', () => {
  assert.deepEqual(limitFeet('4999', 'FT', 'HEI'), { ft: 4999, agl: true, unlimited: false });
  assert.deepEqual(limitFeet('8000', 'FT', 'ALT'), { ft: 8000, agl: false, unlimited: false });
  assert.deepEqual(limitFeet('180', 'FL', 'ALT'), { ft: 18000, agl: false, unlimited: false });
  assert.deepEqual(limitFeet('UNL', 'FT', 'ALT', { ceiling: true }), { ft: 99999, agl: false, unlimited: true });
});

test('a VIP TFR: limits and the UTC window from the detail XML', async () => {
  const d = parseTfrDetail(await fixture('tfr-detail-6_6580.xml'));
  assert.equal(d.floorFt, 0);
  assert.equal(d.ceilingFt, 4999);
  assert.equal(d.agl, true);
  assert.equal(d.limitsText, 'surface to 4,999 ft AGL');
  // "EFFECTIVE 2610021645 UTC ... UNTIL 2610031430 UTC" in the NOTAM text.
  assert.equal(new Date(d.effective).toISOString(), '2026-10-02T16:45:00.000Z');
  assert.equal(new Date(d.expires).toISOString(), '2026-10-03T14:30:00.000Z');
  assert.equal(d.dronesOnly, false);
  assert.match(d.name, /Thurmont/);
});

test('a space operations TFR up to FL180 restricts every aircraft', async () => {
  const d = parseTfrDetail(await fixture('tfr-detail-6_6208.xml'));
  assert.equal(d.ceilingFt, 18000);
  assert.equal(d.agl, false);
  assert.equal(d.dronesOnly, false);
});

test('a public gathering TFR is for drones only', async () => {
  const d = parseTfrDetail(await fixture('tfr-detail-6_6074.xml'));
  assert.equal(d.dronesOnly, true);
  assert.equal(d.ceilingFt, 400);
});

test('a hazard TFR never says prohibited, and still applies to everyone', async () => {
  const d = parseTfrDetail(await fixture('tfr-detail-6_6039.xml'));
  assert.equal(d.dronesOnly, false);
  assert.equal(d.ceilingFt, 8500);
});

test('only NOTAMs that close airspace restrict flight: DC speed rules do not', async () => {
  const dc = parseTfrDetail(await fixture('tfr-detail-4_9383.xml'));
  assert.equal(dc.restricts, false, 'FDC 4/9383 is SFRA speed limits and training, not a prohibition');
  assert.equal(dc.ceilingFt, 17999);
  // Space operations close airspace by citing 91.143 without the word "prohibited".
  assert.equal(parseTfrDetail(await fixture('tfr-detail-6_6134.xml')).restricts, true);
  const blackRock = parseTfrDetail(await fixture('tfr-detail-6_6134.xml'));
  assert.equal(blackRock.ceilingFt, 91000, 'the FAA encodes SFC-UNL as FL910');
  assert.equal(blackRock.limitsText, 'surface to unlimited');
  assert.equal(parseTfrDetail(await fixture('tfr-detail-6_6039.xml')).restricts, true, '91.137 hazard area');
  assert.equal(parseTfrDetail(await fixture('tfr-detail-6_6580.xml')).restricts, true);
  assert.equal(assembleTfr({ notam: '1/1', type: 'SECURITY', polygons: [] }, null).restricts, null);
});

test('who a TFR restricts, from the words before "ARE PROHIBITED"', () => {
  assert.equal(appliesToDronesOnly('ALL ACFT FLT OPS INCLUDING REMOTE CONTROLLED ACFT OPS ARE PROHIBITED: WI'), false);
  assert.equal(appliesToDronesOnly('PURSUANT TO 14 CFR 91.145, ACFT OPS ARE PROHIBITED WI AN AREA'), false);
  assert.equal(appliesToDronesOnly('PUBLIC GATHERINGS. UAS FLT OPS ARE PROHIBITED WI AN AREA'), true);
  assert.equal(appliesToDronesOnly('ONLY RELIEF ACFT OPS UNDER THE DIRECTION OF'), false);
  assert.equal(appliesToDronesOnly('', 'UAS PUBLIC GATHERING'), true);
});

test('WFS polygons are grouped by NOTAM', async () => {
  const groups = groupWfs(JSON.parse(await fixture('tfr-wfs.json')));
  assert.deepEqual(groups.map((g) => [g.notam, g.polygons.length]), [['6/5553', 4], ['6/6208', 1], ['6/6074', 1]]);
  assert.equal(groups[0].place, 'Mayport, FL');
  assert.equal(groups[0].type, 'SECURITY');
  const tfr = assembleTfr(groups[2], null);
  assert.equal(tfr.detailLoaded, false);
  assert.equal(tfr.dronesOnly, true, 'the WFS type alone already says drones only');
});

/** A fake FAA: the WFS fixture, two detail fixtures, and a 404 for the rest. */
async function fakeFaa(log = []) {
  const wfs = await fixture('tfr-wfs.json');
  const details = { '6_6208': await fixture('tfr-detail-6_6208.xml'), '6_6074': await fixture('tfr-detail-6_6074.xml') };
  return async (url) => {
    log.push(url);
    if (url === WFS_URL) return new Response(wfs, { status: 200 });
    const id = url.match(/detail_(\d+_\d+)\.xml$/)?.[1];
    if (details[id]) return new Response(details[id], { status: 200 });
    return new Response('nope', { status: 404 });
  };
}

test('a refresh joins polygons with limits, drops expired TFRs, and remembers details', async () => {
  const log = [];
  const fetchImpl = await fakeFaa(log);
  const now = Date.parse('2026-10-01T12:00:00Z');
  const first = await buildTfrs({ fetchImpl, now });
  const byId = Object.fromEntries(first.tfrs.map((t) => [t.notam, t]));
  assert.equal(byId['6/6208'].ceilingFt, 18000);
  assert.equal(byId['6/6208'].detailLoaded, true);
  assert.equal(byId['6/5553'].detailLoaded, false);
  assert.equal(first.complete, false);
  assert.equal(first.detailFailures, 1);
  assert.ok(first.refreshAfter - now <= 30_000, 'incomplete comes back sooner');

  // The next refresh reuses what it knows and only asks for what is missing.
  log.length = 0;
  const second = await buildTfrs({ fetchImpl, previous: first, now: now + 60_000 });
  assert.deepEqual(log.filter((u) => u !== WFS_URL), ['https://tfr.faa.gov/download/detail_6_5553.xml']);
  assert.equal(second.details['6/6208'].at, now);

  // After its end time, a TFR is gone.
  const later = await buildTfrs({ fetchImpl, previous: second, now: Date.parse('2026-10-05T00:00:00Z') });
  assert.ok(!later.tfrs.some((t) => t.notam === '6/6208'));
});

test('a refresh never spends more than its share of subrequests', async () => {
  const features = Array.from({ length: 90 }, (_, i) => ({
    type: 'Feature',
    properties: { NOTAM_KEY: `6/${1000 + i}-1-FDC-F`, LEGAL: 'SECURITY', TITLE: 'X, VA, Monday' },
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  }));
  let calls = 0;
  const fetchImpl = async (url) => {
    calls += 1;
    if (url === WFS_URL) return new Response(JSON.stringify({ features }), { status: 200 });
    return new Response('<x/>', { status: 200 });
  };
  await buildTfrs({ fetchImpl, now: 0 });
  assert.equal(calls, 1 + MAX_DETAILS_PER_RUN);
  assert.ok(1 + MAX_DETAILS_PER_RUN + 2 < 50, 'WFS + details + cache read and write stay under 50');
});

test('the public body carries the TFRs but not the working state', async () => {
  const state = await buildTfrs({ fetchImpl: await fakeFaa(), now: Date.parse('2026-10-01T12:00:00Z') });
  const body = publicBody(state);
  assert.equal(body.ok, true);
  assert.equal(body.count, state.tfrs.length);
  assert.equal(body.details, undefined);
});
