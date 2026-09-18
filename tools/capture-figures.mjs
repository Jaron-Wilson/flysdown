#!/usr/bin/env node
/**
 * Capture the figures the paper embeds: node tools/capture-figures.mjs [url] [outdir]
 *
 * Unlike the deck's cropped shots, the paper wants the whole interface once
 * (Figure 1) and then focused crops of the detail rail for the route and the
 * close-approach figures. Dismisses the first-visit card first.
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:8795/';
const out = process.argv[3] || 'docs/figures';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'load' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'load' });
await page.waitForFunction(() => (window.flysdown?.store?.all().length || 0) > 20, { timeout: 90000 });
await page.click('#welcome [data-start="explore"]').catch(() => {});
await page.waitForTimeout(9000);

// Figure 1: the whole interface over Washington.
await page.screenshot({ path: `${out}/fig1-dashboard.jpg`, type: 'jpeg', quality: 84 });
console.log('fig1: aircraft =', await page.evaluate(() => window.flysdown.store.byKind('aircraft').length));

// Figure 2: a selected flight with its route legs and the detail rail.
const route = await page.evaluate(async () => {
  const candidates = window.flysdown.store.byKind('aircraft')
    .filter((a) => a.callsign && /^[A-Z]{3}\d/.test(a.callsign) && !a.onGround && (a.alt || 0) > 25000);
  for (const aircraft of candidates) {
    window.flysdown.mapView.onSelect(aircraft.key);
    await new Promise((r) => setTimeout(r, 2200));
    window.flysdown.tick();
    const legs = window.flysdown.buildRouteLegs();
    if (legs.length === 2) {
      const span = Math.abs(legs[0].airport.lon - legs[1].airport.lon);
      if (span > 2 && span < 22) {
        window.flysdown.mapView.fitPoints([[aircraft.lon, aircraft.lat], ...legs.map((l) => [l.airport.lon, l.airport.lat])], 190);
        return { callsign: aircraft.callsign, route: legs.map((l) => l.airport.icao) };
      }
    }
  }
  return null;
});
await page.waitForTimeout(5000);
await page.screenshot({ path: `${out}/fig2-route.jpg`, type: 'jpeg', quality: 84, clip: { x: 332, y: 76, width: 1268, height: 840 } });
console.log('fig2:', JSON.stringify(route));

// Figure 3: the Baltic, with close approaches.
await page.evaluate(() => window.flysdown.mapView.onSelect(null));
await page.selectOption('#region-select', 'gof');
await page.waitForFunction(() => (window.flysdown?.store?.byKind('vessel').length || 0) > 50, { timeout: 90000 });
await page.evaluate(() => window.flysdown.mapView.map.jumpTo({ center: [24.6, 59.75], zoom: 8.4 }));
await page.waitForTimeout(16000);
await page.screenshot({ path: `${out}/fig3-ships.jpg`, type: 'jpeg', quality: 84, clip: { x: 332, y: 76, width: 1268, height: 840 } });
console.log('fig3: approaches =', await page.evaluate(() => window.flysdown.state.evaluation.approaches.length));

await browser.close();
