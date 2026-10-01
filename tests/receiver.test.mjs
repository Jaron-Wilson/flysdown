import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeReceiverUrl,
  receiverInfoUrl,
  isMixedContent,
  parseReceiverJson,
  parseReceiverInfo,
  receiverCoverage,
  mergeAircraft,
  fetchReceiver,
  describeReceiverError,
  loadReceiverSettings,
  saveReceiverSettings,
  ReceiverFeed,
  RECEIVER_SOURCE,
} from '../public/js/receiver.js';
import { normalizeReadsb as browserNormalize } from '../public/js/readsb.js';
import { normalizeReadsb as sharedNormalize } from '../shared/adsb.js';
import { TargetStore } from '../public/js/feeds.js';

// A tar1090 aircraft.json as an adsb.im Pi serves it (now in seconds).
const READSB = {
  now: 1790829630.0,
  messages: 1200,
  aircraft: [
    { hex: 'a85f3b', flight: 'N639AR  ', r: 'N639AR', t: 'C172', alt_baro: 8800, gs: 112, track: 45, lat: 37.41, lon: -79.2, seen_pos: 0.3, seen: 0.1, rssi: -27.1 },
    { hex: 'a08fc3', alt_baro: 'ground', lat: 37.33, lon: -79.2, seen_pos: 2, seen: 1 },
    { hex: 'abc123', alt_baro: 31000, seen: 0.5 }, // no position yet
    { hex: 'stale1', alt_baro: 12000, lat: 37.5, lon: -79.0, seen_pos: 55, seen: 55 }, // readsb keeps these for a minute
  ],
};

const response = (body, { status = 200, json = true } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (!json) throw new SyntaxError('Unexpected token <');
    return body;
  },
});

test('one readsb normalizer is shared by the edge, the relay and the browser', () => {
  assert.equal(sharedNormalize, browserNormalize);
});

test('receiver addresses: bare hosts, tar1090 pages and explicit json files', () => {
  assert.equal(normalizeReceiverUrl('https://adsb-feeder.tail90b62a.ts.net/'), 'https://adsb-feeder.tail90b62a.ts.net/data/aircraft.json');
  assert.equal(normalizeReceiverUrl('adsb-feeder.tail90b62a.ts.net'), 'https://adsb-feeder.tail90b62a.ts.net/data/aircraft.json');
  assert.equal(normalizeReceiverUrl('localhost:8080'), 'http://localhost:8080/data/aircraft.json');
  assert.equal(normalizeReceiverUrl('http://192.168.1.20:8080/tar1090/'), 'http://192.168.1.20:8080/tar1090/data/aircraft.json');
  assert.equal(normalizeReceiverUrl('http://localhost:8080/data.json'), 'http://localhost:8080/data.json');
  assert.equal(normalizeReceiverUrl('  https://pi.example/data/aircraft.json#x '), 'https://pi.example/data/aircraft.json');
  assert.equal(normalizeReceiverUrl(''), null);
  assert.equal(normalizeReceiverUrl('ftp://pi/data.json'), null);
  assert.equal(normalizeReceiverUrl('http://'), null);
});

test('receiver.json sits beside aircraft.json; dump1090 has none', () => {
  assert.equal(receiverInfoUrl('https://pi.example/data/aircraft.json'), 'https://pi.example/data/receiver.json');
  assert.equal(receiverInfoUrl('http://localhost:8080/data.json'), null);
});

test('mixed content: http is blocked from an https page except on localhost', () => {
  assert.equal(isMixedContent('http://192.168.1.20:8080/data/aircraft.json', 'https:'), true);
  assert.equal(isMixedContent('http://localhost:8080/data/aircraft.json', 'https:'), false);
  assert.equal(isMixedContent('http://127.0.0.1:8080/data.json', 'https:'), false);
  assert.equal(isMixedContent('https://pi.ts.net/data/aircraft.json', 'https:'), false);
  assert.equal(isMixedContent('http://192.168.1.20/data/aircraft.json', 'http:'), false);
});

test('readsb aircraft.json: positions only, stale ones dropped, labeled as the receiver', () => {
  const items = parseReceiverJson(READSB, 1000);
  assert.deepEqual(items.map((t) => t.id), ['a85f3b', 'a08fc3']);
  const [plane, ground] = items;
  assert.equal(plane.callsign, 'N639AR');
  assert.equal(plane.alt, 8800);
  assert.equal(plane.source, RECEIVER_SOURCE);
  assert.equal(plane.fetchedAt, 1000);
  assert.equal(plane.heardByReceiver, true);
  assert.equal(ground.onGround, true);
});

test('aggregator-shaped { ac } and dump1090 arrays are understood too', () => {
  assert.equal(parseReceiverJson({ ac: READSB.aircraft }).length, 2);
  const dump = parseReceiverJson([
    { hex: '4ca7b5', flight: 'RYR12', lat: 53.4, lon: -6.2, altitude: 34000, track: 90, speed: 450, seen: 1, validposition: 1, validtrack: 1 },
    { hex: '4ca7b6', lat: 0, lon: 0, altitude: 30000, seen: 1, validposition: 0 },
  ]);
  assert.equal(dump.length, 1);
  assert.equal(dump[0].alt, 34000);
  assert.equal(dump[0].groundSpeed, 450);
  assert.equal(dump[0].callsign, 'RYR12');
});

test('anything else is reported as the wrong file, not as zero aircraft', () => {
  assert.throws(() => parseReceiverJson({ hello: 'world' }), (err) => err.kind === 'not-aircraft');
  assert.throws(() => parseReceiverJson(null), (err) => err.kind === 'not-aircraft');
});

test('receiver.json position, ignoring the unset 0,0', () => {
  assert.deepEqual(parseReceiverInfo({ lat: 37.4, lon: -79.3, refresh: 1000 }), { lat: 37.4, lon: -79.3 });
  assert.equal(parseReceiverInfo({ lat: 0, lon: 0 }), null);
  assert.equal(parseReceiverInfo({}), null);
  assert.equal(receiverCoverage({ lat: 37.4, lon: -79.3 }, [])[0].radiusNm, 250);
  assert.equal(receiverCoverage(null, [{ lat: 1, lon: 2 }]).length, 1);
});

test('merging: the fresher position wins, the other record fills the gaps', () => {
  const network = [
    { id: 'a85f3b', lat: 37.0, lon: -79.0, seenPos: 4, fetchedAt: 10_000, registration: 'N639AR', typeDesc: 'CESSNA 172', source: 'adsb.fi' },
    { id: 'zzz111', lat: 38, lon: -77, seenPos: 1, fetchedAt: 10_000, source: 'adsb.fi' },
  ];
  const mine = [
    { id: 'a85f3b', lat: 37.1, lon: -79.1, seenPos: 0.2, fetchedAt: 11_000, registration: null, typeDesc: null, source: RECEIVER_SOURCE, heardByReceiver: true },
    { id: 'own999', lat: 37.2, lon: -79.2, seenPos: 0.5, fetchedAt: 11_000, source: RECEIVER_SOURCE, heardByReceiver: true },
  ];
  const merged = new Map(mergeAircraft(network, mine).map((t) => [t.id, t]));
  assert.equal(merged.size, 3);
  const both = merged.get('a85f3b');
  assert.equal(both.lat, 37.1);
  assert.equal(both.typeDesc, 'CESSNA 172');
  assert.equal(both.source, RECEIVER_SOURCE);
  assert.equal(both.heardByReceiver, true);
  assert.equal(merged.get('zzz111').heardByReceiver, undefined);

  // The network can be fresher, for an aircraft at the edge of the receiver's range.
  const older = [{ ...mine[0], seenPos: 20, fetchedAt: 10_500 }];
  const won = mergeAircraft(network, older).find((t) => t.id === 'a85f3b');
  assert.equal(won.lat, 37.0);
  assert.equal(won.source, `adsb.fi + ${RECEIVER_SOURCE}`);
  assert.equal(won.heardByReceiver, true);
});

test('fetch failures are classified so the visitor is told what to fix', async () => {
  const refuse = async () => {
    throw new TypeError('Failed to fetch');
  };
  await assert.rejects(fetchReceiver('http://192.168.1.20/data/aircraft.json', { fetchImpl: refuse, pageProtocol: 'https:' }), (e) => e.kind === 'mixed-content');
  await assert.rejects(fetchReceiver('https://pi.ts.net/data/aircraft.json', { fetchImpl: refuse }), (e) => e.kind === 'unreachable');
  const timeout = async () => {
    throw Object.assign(new Error('timed out'), { name: 'TimeoutError' });
  };
  await assert.rejects(fetchReceiver('https://pi.ts.net/data/aircraft.json', { fetchImpl: timeout }), (e) => e.kind === 'timeout');
  await assert.rejects(fetchReceiver('https://pi.ts.net/x.json', { fetchImpl: async () => response(null, { status: 404 }) }), (e) => e.kind === 'http' && e.detail === '404');
  await assert.rejects(fetchReceiver('https://pi.ts.net/', { fetchImpl: async () => response(null, { json: false }) }), (e) => e.kind === 'not-aircraft');

  const items = await fetchReceiver('https://pi.ts.net/data/aircraft.json', { fetchImpl: async () => response(READSB), now: () => 5 });
  assert.equal(items.length, 2);
  assert.equal(items[0].fetchedAt, 5);
});

test('every failure has a short sentence, and none of them is raw upstream text', () => {
  for (const kind of ['mixed-content', 'unreachable', 'timeout', 'http', 'not-aircraft', 'invalid-url']) {
    const text = describeReceiverError({ kind, detail: '500' });
    assert.ok(text.length > 10 && text.length < 260, kind);
  }
});

test('settings persist per browser, and forgetting removes them', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  assert.deepEqual(loadReceiverSettings(storage), { url: '', only: false });
  saveReceiverSettings({ url: 'https://pi.ts.net/data/aircraft.json', only: true }, storage);
  assert.deepEqual(loadReceiverSettings(storage), { url: 'https://pi.ts.net/data/aircraft.json', only: true });
  saveReceiverSettings({ url: '' }, storage);
  assert.equal(store.size, 0);
  store.set('flysdown.receiver.v1', '{not json');
  assert.deepEqual(loadReceiverSettings(storage), { url: '', only: false });
});

test('the receiver feed reports live with a count, then down with a reason', async () => {
  const statuses = [];
  const data = [];
  let fail = false;
  const feed = new ReceiverFeed({
    intervalMs: 60_000,
    pageProtocol: 'https:',
    fetchImpl: async (url) => {
      if (url.endsWith('receiver.json')) return response({ lat: 37.4, lon: -79.3 });
      if (fail) throw new TypeError('Failed to fetch');
      return response(READSB);
    },
    onStatus: (_, s) => statuses.push(s),
    onData: (payload) => data.push(payload),
  });
  assert.equal(feed.setUrl('https://pi.ts.net/'), 'https://pi.ts.net/data/aircraft.json');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(feed.status.state, 'live');
  assert.equal(feed.status.count, 2);
  assert.equal(data.at(-1).items.length, 2);

  fail = true;
  for (let i = 0; i < 3; i++) {
    feed.inFlight = false;
    await feed.poll();
  }
  assert.equal(feed.status.state, 'down');
  assert.equal(feed.status.errorKind, 'unreachable');
  // A few words for the one-line chrome, the full advice for the panel.
  assert.equal(feed.status.lastError, 'not reachable');
  assert.match(feed.status.help, /cross-origin/);

  assert.equal(feed.setUrl(null), null);
  assert.equal(feed.status.state, 'off');
  assert.equal(data.at(-1).items.length, 0);
  assert.equal(feed.setUrl('ftp://nope'), null);
  assert.equal(feed.status.state, 'down');
  feed.stop();
});

test('the store keeps each item\'s own fetch time when two feeds are merged', () => {
  const store = new TargetStore();
  const net = { id: 'n1', lat: 38, lon: -77, fetchedAt: 1_000 };
  const own = { id: 'o1', lat: 37, lon: -79, fetchedAt: 6_000 };
  store.ingest('aircraft', [net, own], 6_000);
  assert.equal(store.get('aircraft:n1').updatedAt, 1_000);
  assert.equal(store.get('aircraft:o1').updatedAt, 6_000);
  // Items without their own time still get the call's, as before.
  store.ingest('aircraft', [{ id: 'p1', lat: 1, lon: 1 }], 7_000);
  assert.equal(store.get('aircraft:p1').updatedAt, 7_000);
});

test('switching a source off removes its targets at once, but never the selected one', () => {
  const store = new TargetStore();
  store.ingest('aircraft', [
    { id: 'n1', lat: 38, lon: -77 },
    { id: 'o1', lat: 37, lon: -79, heardByReceiver: true },
    { id: 'o2', lat: 37, lon: -79.1, heardByReceiver: true },
  ], 1_000);
  store.protect('aircraft:o2');
  assert.equal(store.removeWhere((t) => t.heardByReceiver), 1);
  assert.deepEqual(store.all().map((t) => t.id).sort(), ['n1', 'o2']);
});
