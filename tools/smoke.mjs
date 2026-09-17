/**
 * Browser smoke test: node tools/smoke.mjs [url]
 *
 * Loads the dashboard in headless Chromium, fails on any console or page
 * error, waits for real targets to render, exercises selection and zone
 * drawing, and writes screenshots to tmp/.
 *
 * WebGL in headless Chromium runs on SwiftShader, so the map is software
 * rendered here. That is fine for catching wiring and layout problems.
 */

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const url = process.argv[2] || 'http://127.0.0.1:8795/';
const outDir = process.argv[3] || 'tmp';
await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 950 }, deviceScaleFactor: 1 });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
});
page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
page.on('requestfailed', (req) => {
  // MapLibre cancels in-flight tile requests whenever the view moves, which
  // surfaces as ERR_ABORTED. That is normal, not a failure.
  const text = req.failure()?.errorText || '';
  if (text.includes('ERR_ABORTED')) return;
  errors.push(`requestfailed: ${req.url()} ${text}`);
});

const step = (name) => console.log(`- ${name}`);

step(`loading ${url}`);
await page.goto(url, { waitUntil: 'load', timeout: 60000 });

step('waiting for the feeds to report');
await page.waitForFunction(() => {
  const state = window.flysdown?.state;
  return state && Object.values(state.feeds).some((f) => f.state === 'live' || f.state === 'degraded');
}, { timeout: 60000 });

step('waiting for targets to land in the store');
let gotTargets = true;
try {
  await page.waitForFunction(() => (window.flysdown?.store?.all().length || 0) > 0, { timeout: 90000 });
} catch {
  // A refused upstream is a real state of the world, and the page is supposed
  // to explain it rather than sit there empty and silent. Report it and carry
  // on checking the rest of the UI.
  gotTargets = false;
  console.warn('  no targets arrived: checking that the page says why');
}
await page.waitForTimeout(4000);

const summary = await page.evaluate(() => {
  const { state, store, zones } = window.flysdown;
  return {
    aircraft: store.byKind('aircraft').length,
    vessels: store.byKind('vessel').length,
    zones: zones.all().length,
    alerts: state.evaluation.alerts.length,
    alertKinds: [...new Set(state.evaluation.alerts.map((a) => a.rule))],
    feeds: Object.fromEntries(Object.entries(state.feeds).map(([k, v]) => [k, { state: v.state, count: v.count, stale: !!v.stale }])),
    tiles: [...document.querySelectorAll('.tile-value')].map((n) => n.textContent),
    alertRows: document.querySelectorAll('.alert-list .alert').length,
    chartRows: document.querySelectorAll('.chart-row').length,
    zoneRows: document.querySelectorAll('.zone-item').length,
    legendRows: document.querySelectorAll('.legend-row').length,
    banner: document.getElementById('map-banner').hidden ? null : document.getElementById('map-banner').textContent.trim(),
    status: document.getElementById('status-text').textContent,
  };
});
console.log(JSON.stringify(summary, null, 2));
await page.screenshot({ path: `${outDir}/01-dashboard.png` });

step('checking that only the current view is tracked');
const viewCheck = await page.evaluate(() => {
  const map = window.flysdown.mapView.map;
  const bounds = map.getBounds();
  const rendered = [
    ...map.querySourceFeatures('aircraft'),
    ...map.querySourceFeatures('vessels'),
  ];
  const outside = rendered.filter((f) => {
    const [lon, lat] = f.geometry.coordinates;
    const padLat = (bounds.getNorth() - bounds.getSouth()) * 0.06;
    const padLon = (bounds.getEast() - bounds.getWest()) * 0.06;
    return (
      lat < bounds.getSouth() - padLat ||
      lat > bounds.getNorth() + padLat ||
      lon < bounds.getWest() - padLon ||
      lon > bounds.getEast() + padLon
    );
  });
  return { held: window.flysdown.store.all().length, rendered: rendered.length, outside: outside.length };
});
console.log(`  store holds ${viewCheck.held}, rendered ${viewCheck.rendered}, outside the view ${viewCheck.outside}`);
if (viewCheck.outside > 0) errors.push(`${viewCheck.outside} rendered targets are outside the current view`);

step('selecting the first target');
const selected = await page.evaluate(() => {
  const target = window.flysdown.store.byKind('aircraft')[0] || window.flysdown.store.all()[0];
  if (!target) return null;
  document.querySelector('.alert-list .alert')?.click();
  window.flysdown.state.selectedKey = target.key;
  window.flysdown.tick();
  return target.label;
});
await page.waitForTimeout(1200);
const detailText = await page.textContent('#detail');
console.log(`  selected ${selected}; detail panel has ${detailText.length} chars`);
await page.screenshot({ path: `${outDir}/02-detail.png` });

step('switching to the AIS region');
await page.selectOption('#region-select', 'gof');
await page.waitForTimeout(9000);
const gof = await page.evaluate(() => ({
  vessels: window.flysdown.store.byKind('vessel').length,
  aircraft: window.flysdown.store.byKind('aircraft').length,
}));
console.log(`  gulf of finland: ${gof.vessels} vessels, ${gof.aircraft} aircraft`);
await page.screenshot({ path: `${outDir}/03-vessels.png` });

step('selecting a vessel and checking the detail becomes visible');
const vesselCheck = await page.evaluate(async () => {
  const store = window.flysdown.store;
  if (!store.byKind('vessel').length) return 'no vessels in this view';
  const vessel = store.byKind('vessel')[0];
  window.flysdown.state.selectedKey = vessel.key;
  window.flysdown.tick();
  const block = document.getElementById('detail-block');
  const rect = block.getBoundingClientRect();
  return {
    label: vessel.label,
    hasSpeedRow: document.getElementById('detail').textContent.includes('Speed over ground'),
    onScreen: rect.top < window.innerHeight && rect.bottom > 0,
  };
});
console.log(`  vessel detail: ${JSON.stringify(vesselCheck)}`);
if (typeof vesselCheck === 'object' && (!vesselCheck.hasSpeedRow || !vesselCheck.onScreen)) {
  errors.push(`vessel detail did not render visibly: ${JSON.stringify(vesselCheck)}`);
}


step('checking a feed error cannot break the layout');
const layoutCheck = await page.evaluate(() => {
  // The exact shape that used to push the right hand panel off screen: the
  // upstream's whole nginx error page arriving as a feed status.
  const nasty = 'adsb.lol: HTTP 429 - <html> <head><title>429 Too Many Requests</title></head> <body> <center><h1>429 Too Many Requests</h1></center> <hr><center>nginx</center> </body> </html>,adsb.fi: HTTP 403 - <!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> <!--[if IE 7]> <html class="no-js ie7 oldie" lang="en-US"> <![endif]--> <!--[if IE 8]> <html class="no-,opensky: timeout';
  window.flysdown.ui.renderFeedChips({
    aircraft: { state: 'down', lastError: nasty, count: 0 },
    vessels: { state: 'live', lastError: null, count: 12, latencyMs: 200 },
  });
  const panel = document.querySelector('.panel-right');
  const rect = panel.getBoundingClientRect();
  return {
    documentOverflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    panelRight: Math.round(rect.right),
    windowWidth: window.innerWidth,
    panelVisible: rect.width > 40 && rect.right <= window.innerWidth + 2,
    chipText: document.querySelector('.feed-chips .chip')?.textContent.trim().slice(0, 70),
  };
});
console.log(`  ${JSON.stringify(layoutCheck)}`);
if (!layoutCheck.panelVisible || layoutCheck.documentOverflowPx > 2) {
  errors.push(`a feed error broke the layout: ${JSON.stringify(layoutCheck)}`);
}
await page.screenshot({ path: `${outDir}/03b-feed-error.png` });

step('drawing a circular zone');
await page.click('#draw-circle');
const box = await page.locator('#map').boundingBox();
await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2);
await page.mouse.click(box.x + box.width / 2 + 120, box.y + box.height / 2);
await page.waitForTimeout(600);
await page.fill('#zf-name', 'Smoke test zone');
await page.check('#zf-vessels');
await page.click('#zone-form button[type="submit"]');
await page.waitForTimeout(3000);
const drawn = await page.evaluate(() => {
  const zone = window.flysdown.zones.all().find((z) => z.name === 'Smoke test zone');
  return zone ? { radiusNm: Number(zone.radiusNm.toFixed(2)), appliesTo: zone.appliesTo, alerts: window.flysdown.state.evaluation.alerts.filter((a) => a.zoneId === zone.id).length } : null;
});
console.log(`  drawn zone: ${JSON.stringify(drawn)}`);
await page.screenshot({ path: `${outDir}/04-drawn-zone.png` });

step('mobile layout');
await page.setViewportSize({ width: 430, height: 900 });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${outDir}/05-mobile.png`, fullPage: false });

await browser.close();

// A 502 from our own /api/aircraft is the documented upstream refusal, which
// the page handles and explains; the browser logs it either way.
const fatal = errors.filter((e) => !/favicon|ResizeObserver/i.test(e) && !/status of 502/.test(e));
if (fatal.length) {
  console.error(`\nFAILED with ${fatal.length} error(s):`);
  for (const e of fatal.slice(0, 20)) console.error(`  ${e}`);
  process.exit(1);
}
if (!gotTargets && !summary.banner) {
  console.error('\nFAILED: no targets rendered and no explanation shown to the user');
  process.exit(1);
}
if (!gotTargets) {
  console.log(`\nno targets, but the page explained itself: "${summary.banner}"`);
}
console.log('\nsmoke test passed');
