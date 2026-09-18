#!/usr/bin/env node
/**
 * Capture the screenshots the LinkedIn deck embeds:
 *
 *   node tools/capture-shots.mjs [url] [outdir]
 *
 * Writes 01-dc.png, 02-route.png and 03-ships.png, each cropped to the map
 * and the alerts rail. The full interface shrunk into a square card is
 * illegible on a phone, so the crop is the point: everything in these images
 * should be readable at thumb size.
 *
 * Needs a running instance (npm run dev) because it drives the real app.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8795/';
const out = process.argv[3] || 'tmp/deck';
mkdirSync(out, { recursive: true });

// The map plus the alerts rail, dropping the controls that mean nothing in a
// still image.
const clip = { x: 412, y: 88, width: 1188, height: 760 };

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

await page.goto(url, { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => (window.flysdown?.store?.all().length || 0) > 20, { timeout: 90000 });
await page.click('#welcome [data-start="explore"]').catch(() => {});
await page.waitForTimeout(9000);

// 1. Washington, as it arrives.
await page.screenshot({ path: `${out}/01-dc.png`, clip });
console.log('01-dc: aircraft =', await page.evaluate(() => window.flysdown.store.byKind('aircraft').length));

// 2. A selected airliner with its route drawn. A transatlantic frame is mostly
// empty ocean, so prefer a flight whose airports are 2 to 22 degrees apart.
const route = await page.evaluate(async () => {
  const candidates = window.flysdown.store.byKind('aircraft')
    .filter((a) => a.callsign && /^[A-Z]{3}\d/.test(a.callsign) && !a.onGround && (a.alt || 0) > 15000);
  for (const aircraft of candidates) {
    window.flysdown.mapView.onSelect(aircraft.key);
    await new Promise((r) => setTimeout(r, 2200));
    window.flysdown.tick();

    // A route that fails the plausibility check draws nothing, by design, so
    // it is no use for a screenshot of a route.
    const entry = window.flysdown.routes.get(aircraft.callsign);
    if (entry?.status !== 'ok' || window.flysdown.routeFit(entry.route, aircraft).verdict === 'mismatch') continue;

    const legs = window.flysdown.buildRouteLegs();
    if (legs.length === 2) {
      const span = Math.abs(legs[0].airport.lon - legs[1].airport.lon);
      if (span > 2 && span < 22) {
        window.flysdown.mapView.fitPoints(
          [[aircraft.lon, aircraft.lat], ...legs.map((l) => [l.airport.lon, l.airport.lat])],
          190
        );
        return { callsign: aircraft.callsign, route: legs.map((l) => l.airport.icao) };
      }
    }
  }
  return null;
});
await page.waitForTimeout(5000);
await page.screenshot({ path: `${out}/02-route.png`, clip });
console.log('02-route:', JSON.stringify(route));

// 3. The Baltic, where the close-approach detector has something to say.
await page.evaluate(() => window.flysdown.mapView.onSelect(null));
await page.selectOption('#region-select', 'gof');
await page.waitForFunction(() => (window.flysdown?.store?.byKind('vessel').length || 0) > 50, { timeout: 90000 });
await page.evaluate(() => window.flysdown.mapView.map.jumpTo({ center: [24.6, 59.75], zoom: 8.4 }));
await page.waitForTimeout(16000);
await page.screenshot({ path: `${out}/03-ships.png`, clip });
console.log('03-ships: approaches =', await page.evaluate(() => window.flysdown.state.evaluation.approaches.length));

await browser.close();
