/**
 * /api/skywatch tests: node --test tests/
 *
 * SkyWatch now runs on the caller's own computer, so this endpoint carries
 * no detections. It must say so plainly, in both formats, to anyone.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { onRequestGet, onRequestPost, onRequestOptions, selfRunInfo, renderText, STEPS } from '../functions/api/skywatch.js';

const get = (query = '') => onRequestGet({ request: new Request(`https://flysdown.test/api/skywatch${query}`) });

test('JSON answer says it is self-run and gives the steps, with CORS open', async () => {
  const res = await get();
  assert.match(res.headers.get('content-type'), /application\/json/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.status, 'self_run');
  assert.equal(body.experimental, true);
  assert.deepEqual(body.steps, STEPS);
  assert.equal(body.detections, undefined);
});

test('text answer prints numbered steps for a terminal', async () => {
  const res = await get('?format=text');
  assert.match(res.headers.get('content-type'), /text\/plain/);
  const text = await res.text();
  assert.match(text, /EXPERIMENTAL - not for navigation/);
  assert.match(text, /1\. git clone -b jaron-wilson\/flysdown-live /);
  assert.match(text, /python -m air\.detectors\.no_fly_zone\.live --once/);
  assert.equal(text, renderText(selfRunInfo()));
});

test('nothing can publish reports any more', async () => {
  assert.equal((await onRequestPost()).status, 410);
  assert.equal((await onRequestOptions()).status, 204);
});
