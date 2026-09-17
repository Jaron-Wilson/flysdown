#!/usr/bin/env node
/**
 * ADS-B relay for flysdown.
 *
 * Why this exists: the community ADS-B aggregators rate-limit by IP, and a
 * Cloudflare Worker egresses from addresses shared with every other Cloudflare
 * customer. Measured from production, adsb.lol answers about one attempt in
 * six from the edge and adsb.fi serves a bot challenge every time. The same
 * requests from an ordinary connection succeed every time and return richer
 * data, so this process runs wherever you have a normal IP address, asks the
 * site which areas people are actually looking at, fetches those, and pushes
 * the snapshots back.
 *
 *   RELAY_TOKEN=... node tools/relay.mjs
 *   RELAY_TOKEN=... node tools/relay.mjs --url https://flysdown.pages.dev --interval 8
 *   RELAY_TOKEN=... node tools/relay.mjs --once        # one cycle, for testing
 *
 * Keep it running with forever, pm2 or a systemd unit (see the README).
 */

import { readFileSync } from 'node:fs';
import { SOURCES, RELAY_SOURCE_ORDER, fetchSource } from '../shared/adsb.js';

/**
 * The token lives in .env.relay (gitignored) so a restart under forever,
 * systemd or pm2 needs no environment plumbing.
 */
function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    // no file: rely on the real environment
  }
}
loadEnvFile(new URL('../.env.relay', import.meta.url).pathname);

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};

const SITE = (flag('url', process.env.FLYSDOWN_URL || 'https://flysdown.pages.dev')).replace(/\/$/, '');
const INTERVAL_MS = Math.max(4000, Number(flag('interval', process.env.RELAY_INTERVAL || 8)) * 1000);
const ONCE = args.includes('--once');
const TOKEN = process.env.RELAY_TOKEN;

if (!TOKEN) {
  console.error('RELAY_TOKEN is not set. It must match the RELAY_TOKEN secret on the Pages project.');
  process.exit(1);
}

const ordered = RELAY_SOURCE_ORDER.map((name) => SOURCES.find((s) => s.name === name)).filter(Boolean);
const stamp = () => new Date().toISOString().slice(11, 19);
const log = (...parts) => console.log(stamp(), ...parts);

let cycles = 0;
let pushed = 0;
let failures = 0;

async function relayOnce() {
  const listed = await fetch(`${SITE}/api/relay`, {
    headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });

  if (!listed.ok) {
    throw new Error(`GET /api/relay returned ${listed.status} ${(await listed.text()).slice(0, 120)}`);
  }

  const { regions } = await listed.json();
  if (!regions?.length) {
    log('no regions requested (nobody is viewing the map)');
    return;
  }

  for (const region of regions) {
    const started = Date.now();
    let aircraft = null;
    let usedSource = null;
    const problems = [];

    for (const source of ordered) {
      try {
        aircraft = await fetchSource(source, region.lat.toFixed(1), region.lon.toFixed(1), region.distNm);
        usedSource = source.name;
        break;
      } catch (err) {
        problems.push(`${source.name}: ${err.message.slice(0, 60)}`);
      }
    }

    if (!aircraft) {
      failures += 1;
      log(`could not fetch ${region.region}: ${problems.join(' | ')}`);
      continue;
    }

    const posted = await fetch(`${SITE}/api/relay`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        region: region.region,
        lat: region.lat,
        lon: region.lon,
        distNm: region.distNm,
        source: usedSource,
        aircraft,
      }),
      signal: AbortSignal.timeout(20000),
    });

    if (!posted.ok) {
      failures += 1;
      log(`push failed for ${region.region}: ${posted.status} ${(await posted.text()).slice(0, 120)}`);
      continue;
    }

    pushed += 1;
    const age = region.snapshotAgeMs === null ? 'first' : `${Math.round(region.snapshotAgeMs / 1000)}s old`;
    log(`${region.region}: ${aircraft.length} aircraft via ${usedSource} in ${Date.now() - started}ms (previous ${age})`);
  }
}

log(`relaying to ${SITE} every ${INTERVAL_MS / 1000}s`);

async function loop() {
  for (;;) {
    cycles += 1;
    try {
      await relayOnce();
    } catch (err) {
      failures += 1;
      log(`cycle failed: ${err.message}`);
    }
    if (ONCE) break;
    if (cycles % 50 === 0) log(`(${cycles} cycles, ${pushed} snapshots pushed, ${failures} failures)`);
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`stopping after ${cycles} cycles, ${pushed} snapshots pushed, ${failures} failures`);
    process.exit(0);
  });
}

await loop();
