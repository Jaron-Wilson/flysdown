/**
 * SkyWatch integration tests: node --test tests/
 *
 * The fixtures in tests/fixtures/ are real output of the SkyWatch detector
 * (its live/report.py) run over its own recorded-shape Flys Down fixtures:
 * one confirmed-active detection in P-56A, one with unknown activation, one
 * near a boundary; a quiet fresh run; and a run whose feed was stale. No
 * network is touched here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { validateReport, envelope, onRequestGet, onRequestPost, STALE_AFTER_MS } from '../functions/api/skywatch.js';
import { viewModel, toFeatures, scopeFeature, SkyWatchFeed } from '../public/js/skywatch.js';

const load = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const DETECTIONS = load('skywatch-report-detections.json');
const QUIET = load('skywatch-report-quiet.json');
const STALE_FEED = load('skywatch-report-stale-feed.json');
const NOW = Date.parse('2026-09-29T22:30:10Z');

const env = (report, receivedAt = NOW - 5000) => ({ ok: true, receivedAt, ageMs: NOW - receivedAt, stale: false, report });

/* ---------- API: what may be stored ---------- */

test('real detector reports validate', () => {
  for (const report of [DETECTIONS, QUIET, STALE_FEED]) assert.equal(validateReport(report), null);
});

test('reports that overclaim are refused', () => {
  assert.match(validateReport({ ...DETECTIONS, experimental: false }), /experimental/);
  assert.match(validateReport({ ...DETECTIONS, schema: 'something/else' }), /schema/);
  assert.match(validateReport({ ...STALE_FEED, detections: DETECTIONS.detections }), /did not evaluate|fresh feed/);
  assert.match(validateReport({ ...DETECTIONS, feed: { ...DETECTIONS.feed, status: 'stale' } }), /fresh feed/);
  assert.match(validateReport([]), /object/);
});

test('the envelope carries the site clock, and marks old reports stale', () => {
  const row = { received_at: NOW - 1000, payload: JSON.stringify(QUIET) };
  assert.deepEqual(envelope(row, NOW).stale, false);
  const old = envelope({ ...row, received_at: NOW - STALE_AFTER_MS - 1 }, NOW);
  assert.equal(old.stale, true);
  assert.equal(envelope(null).ok, false);
  assert.equal(envelope({ received_at: NOW, payload: '{nope' }).ok, false);
});

/** A D1 stand-in with just enough surface for the endpoint. */
function fakeDb() {
  const rows = new Map();
  return {
    rows,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            first: async () => rows.get(args[0]) || null,
            run: async () => {
              if (/INSERT INTO skywatch_reports/.test(sql)) rows.set(args[0], { received_at: args[1], payload: args[2] });
              return { success: true };
            },
          };
        },
      };
    },
  };
}

const post = (body, token) =>
  new Request('https://flysdown.test/api/skywatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('POST needs the token, GET is public and round-trips the report', async () => {
  const RELAY_DB = fakeDb();
  const e = { RELAY_DB, SKYWATCH_TOKEN: 'sekrit-token' };

  assert.equal((await onRequestPost({ request: post(DETECTIONS), env: e })).status, 401);
  assert.equal((await onRequestPost({ request: post(DETECTIONS, 'wrong-token!'), env: e })).status, 401);
  assert.equal((await onRequestPost({ request: post('not json', 'sekrit-token'), env: e })).status, 400);
  assert.equal((await onRequestPost({ request: post({ ...DETECTIONS, experimental: false }, 'sekrit-token'), env: e })).status, 400);

  const ok = await onRequestPost({ request: post(DETECTIONS, 'sekrit-token'), env: e });
  assert.equal(ok.status, 200);
  const got = await (await onRequestGet({ env: e })).json();
  assert.equal(got.ok, true);
  assert.equal(got.stale, false);
  assert.equal(got.report.detections.length, 3);
});

test('with no token configured, nobody can publish', async () => {
  const res = await onRequestPost({ request: post(DETECTIONS, 'anything'), env: { RELAY_DB: fakeDb() } });
  assert.equal(res.status, 401);
});

test('GET with nothing stored says unavailable, not quiet', async () => {
  const got = await (await onRequestGet({ env: { RELAY_DB: fakeDb() } })).json();
  assert.equal(got.ok, false);
  assert.equal(viewModel(got, { now: NOW }).state, 'unavailable');
});

/* ---------- view model: what the panel may say ---------- */

test('detections are grouped by class, confirmed first', () => {
  const view = viewModel(env(DETECTIONS), { now: NOW });
  assert.equal(view.state, 'detections');
  assert.deepEqual(view.detections.map((d) => d.classification), ['confirmed_active', 'activation_uncertain', 'buffered_only']);
  assert.deepEqual(view.counts, { confirmed_active: 1, activation_uncertain: 1, buffered_only: 1 });
  assert.match(view.headline, /1 in active zone, 1 activation unknown, 1 near boundary/);
  const uncertain = view.detections.find((d) => d.classification === 'activation_uncertain');
  assert.equal(uncertain.activation, 'UNKNOWN');
  assert.equal(uncertain.severity, 'LOW');
});

test('a quiet evaluated run reads differently from a stale feed and from no report', () => {
  const quiet = viewModel(env(QUIET), { now: NOW });
  const staleFeed = viewModel(env(STALE_FEED), { now: NOW });
  const missing = viewModel({ ok: false, reason: 'No SkyWatch report has been published yet.' }, { now: NOW });

  assert.equal(quiet.state, 'quiet');
  assert.match(quiet.headline, /No aircraft inside a zone volume/);
  assert.match(quiet.detail, /Checked 2 aircraft/);
  assert.equal(staleFeed.state, 'not_evaluated');
  assert.match(staleFeed.headline, /feed stale/);
  assert.match(staleFeed.detail, /not the same as finding nothing/);
  assert.equal(missing.state, 'unavailable');
  for (const view of [quiet, staleFeed, missing]) assert.deepEqual(toFeatures(view), []);
});

test('an old report hides its detections instead of presenting them as current', () => {
  const old = viewModel(env(DETECTIONS, NOW - STALE_AFTER_MS - 60000), { now: NOW });
  assert.equal(old.state, 'stale');
  assert.deepEqual(old.detections, []);
  assert.deepEqual(toFeatures(old), []);
  assert.match(old.headline, /old/);
  const flagged = viewModel({ ...env(DETECTIONS), stale: true }, { now: NOW });
  assert.equal(flagged.state, 'stale');
});

test('a fetch error is unavailable, even if an earlier report was fine', () => {
  const view = viewModel(env(DETECTIONS), { now: NOW, error: 'HTTP 502' });
  assert.equal(view.state, 'unavailable');
  assert.deepEqual(toFeatures(view), []);
});

test('map features carry the class and a label, and the scope is a closed ring', () => {
  const view = viewModel(env(DETECTIONS), { now: NOW });
  const features = toFeatures(view);
  assert.equal(features.length, 3);
  assert.deepEqual(features[0].geometry.coordinates, [-77.02641, 38.89098]);
  assert.equal(features[0].properties.key, 'aircraft:a11111');
  assert.match(features[0].properties.label, /^SkyWatch: /);
  const [ring] = scopeFeature(view);
  const coords = ring.geometry.coordinates;
  assert.deepEqual(coords[0].map((v) => v.toFixed(6)), coords.at(-1).map((v) => v.toFixed(6)));
});

test('the poller treats an HTML fallback as unavailable and backs off', async () => {
  const views = [];
  const html = { ok: true, status: 200, headers: new Headers({ 'content-type': 'text/html' }), json: async () => ({}) };
  const feed = new SkyWatchFeed({ onUpdate: (v) => views.push(v), fetchImpl: async () => html, doc: null });
  await feed.poll();
  feed.stop();
  assert.equal(views[0].state, 'unavailable');
  assert.match(views[0].detail, /not JSON/);
  assert.equal(feed.failures, 1);
});

test('switching SkyWatch off mid-request draws nothing', async () => {
  const views = [];
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const res = { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => ({ ok: true, receivedAt: Date.now(), report: DETECTIONS }) };
  const feed = new SkyWatchFeed({ onUpdate: (v) => views.push(v), fetchImpl: () => pending.then(() => res), doc: null });
  const inflight = feed.poll();
  feed.stop();
  release();
  await inflight;
  assert.deepEqual(views, []);
});

test('the poller renders a good report', async () => {
  const views = [];
  const body = { ok: true, receivedAt: Date.now(), ageMs: 0, stale: false, report: QUIET };
  const res = { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => body };
  const feed = new SkyWatchFeed({ onUpdate: (v) => views.push(v), fetchImpl: async () => res, doc: null });
  await feed.poll();
  feed.stop();
  assert.equal(views[0].state, 'quiet');
  assert.equal(feed.failures, 0);
});
