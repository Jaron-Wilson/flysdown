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

step('first-visit welcome card');
// It is shown synchronously at boot, but give a slow network a moment.
const welcomeShown = await page.waitForFunction(() => !document.getElementById('welcome').hidden, null, { timeout: 15000 })
  .then(() => true)
  .catch(() => false);
if (!welcomeShown) errors.push('the welcome card did not show on a first visit');
await page.click('#welcome [data-start="explore"]');
await page.waitForTimeout(400);
const welcomeState = await page.evaluate(() => ({
  hidden: document.getElementById('welcome').hidden,
  remembered: localStorage.getItem('flysdown.welcomed.v1') === '1',
}));
console.log(`  ${JSON.stringify({ welcomeShown, ...welcomeState })}`);
if (!welcomeState.hidden || !welcomeState.remembered) errors.push(`welcome card did not dismiss cleanly: ${JSON.stringify(welcomeState)}`);

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

step('flight route lookup and the growing track');
const routeEndpoint = await page.evaluate(async () => {
  // Deterministic: a known scheduled callsign must resolve to two airports.
  const res = await fetch('api/route?callsign=AAL1314');
  const json = await res.json();
  return {
    ok: json.ok,
    found: json.found,
    from: json.origin?.icao || null,
    to: json.destination?.icao || null,
    unknownHandled: (await (await fetch('api/route?callsign=ZZZZ999')).json()).found === false,
  };
});
console.log(`  endpoint: ${JSON.stringify(routeEndpoint)}`);
if (!routeEndpoint.found || !routeEndpoint.from || !routeEndpoint.to || !routeEndpoint.unknownHandled) {
  errors.push(`route endpoint did not behave: ${JSON.stringify(routeEndpoint)}`);
}

const routeOnMap = await page.evaluate(async () => {
  const airliner = window.flysdown.store.byKind('aircraft')
    .filter((a) => a.callsign && /^[A-Z]{3}\d/.test(a.callsign) && !a.onGround)
    .sort((a, b) => (b.alt || 0) - (a.alt || 0))[0];
  if (!airliner) return 'no airline callsign airborne in view';

  window.flysdown.state.selectedKey = airliner.key;
  window.flysdown.tick();
  // Give the lookup a moment, then re-render.
  await new Promise((r) => setTimeout(r, 5000));
  window.flysdown.tick();

  const legs = window.flysdown.buildRouteLegs();
  return {
    callsign: airliner.callsign,
    status: window.flysdown.routes.get(airliner.callsign)?.status,
    legs: legs.map((l) => `${l.leg}:${l.airport?.icao}:${l.coords.length}pts`),
    trackPoints: window.flysdown.state.track.points.length,
    panelShowsRoute: document.getElementById('detail').textContent.includes('Route'),
  };
});
console.log(`  in view: ${JSON.stringify(routeOnMap)}`);
// Whether an airliner with a published route happens to be overhead is not a
// property of the code, so only a resolved route is asserted on.
if (typeof routeOnMap === 'object' && routeOnMap.status === 'ok') {
  if (!routeOnMap.legs.length || !routeOnMap.panelShowsRoute) {
    errors.push(`a resolved route was not drawn or shown: ${JSON.stringify(routeOnMap)}`);
  }
  if (!routeOnMap.legs.every((l) => l.endsWith('65pts'))) {
    errors.push(`route legs should be interpolated great circles: ${JSON.stringify(routeOnMap.legs)}`);
  }
}
await page.screenshot({ path: `${outDir}/02b-route.png` });
await page.evaluate(() => { window.flysdown.state.selectedKey = null; window.flysdown.tick(); });

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


step('vessel close-approach detection');
const approachCheck = await page.evaluate(async () => {
  const { detectCloseApproaches } = await import('./js/detect.js');
  const vessels = window.flysdown.store.byKind('vessel');
  return {
    vessels: vessels.length,
    atDefaultLimit: detectCloseApproaches(vessels).length,
    atFiveMiles: detectCloseApproaches(vessels, { cpaAlertNm: 5 }).length,
  };
});
// Whether any pair is genuinely close right now is a property of the sea, not
// of the code, so only the plumbing is asserted here; the maths has unit tests.
console.log(`  ${JSON.stringify(approachCheck)}`);
if (approachCheck.vessels > 20 && approachCheck.atFiveMiles === 0) {
  errors.push('no converging vessel pairs found at a 5 NM limit among many vessels, which suggests the detector is not running');
}


step('pausing the plane feed on its own');
const pauseCheck = await page.evaluate(async () => {
  document.querySelector('[data-feed="aircraft"]').click();
  await new Promise((r) => setTimeout(r, 400));
  const paused = {
    planes: window.flysdown.feeds.aircraft.paused,
    ships: window.flysdown.feeds.vessels.paused,
    labels: [...document.querySelectorAll('.feed-toggle')].map((b) => b.textContent.trim()),
  };
  document.querySelector('[data-feed="aircraft"]').click();
  await new Promise((r) => setTimeout(r, 200));
  return { ...paused, resumed: !window.flysdown.feeds.aircraft.paused };
});
console.log(`  ${JSON.stringify(pauseCheck)}`);
if (!pauseCheck.planes || pauseCheck.ships || !pauseCheck.resumed) {
  errors.push(`per-feed pause did not behave: ${JSON.stringify(pauseCheck)}`);
}

step('left rail tabs');
const tabCheck = {};
for (const name of ['filters', 'areas', 'overview']) {
  await page.click(`.tab[data-tab="${name}"]`);
  await page.waitForTimeout(150);
  tabCheck[name] = await page.evaluate((n) => !document.getElementById(`tab-${n}`).hidden
    && [...document.querySelectorAll('.tab-pane')].filter((p) => p.id !== `tab-${n}`).every((p) => p.hidden), name);
}
console.log(`  ${JSON.stringify(tabCheck)}`);
if (!Object.values(tabCheck).every(Boolean)) errors.push(`tab switching broke: ${JSON.stringify(tabCheck)}`);

step('pinning a tracking area and scrolling away from it');
await page.click('.tab[data-tab="areas"]');
await page.click('#track-view');
await page.waitForTimeout(2500);
const pinnedQueries = await page.evaluate(() => JSON.stringify(window.flysdown.feeds.aircraft.queries));
const drawnWhileOnScreen = await page.evaluate(() => window.flysdown.mapView.map.querySourceFeatures('tracking').length > 0);
if (!drawnWhileOnScreen) errors.push('the pinned area was not drawn on the map');
await page.evaluate(() => window.flysdown.mapView.map.jumpTo({ center: [2.35, 48.86], zoom: 8 }));
await page.waitForTimeout(6000);
const pinCheck = await page.evaluate((before) => ({
  queriesHeld: JSON.stringify(window.flysdown.feeds.aircraft.queries) === before,
  areas: window.flysdown.state.tracking.length,
  stillHoldingTargets: window.flysdown.store.all().length > 0,
  banner: document.getElementById('map-banner').hidden ? null : document.getElementById('map-banner').textContent.trim().slice(0, 60),
}), pinnedQueries);
console.log(`  ${JSON.stringify(pinCheck)}`);
if (!pinCheck.queriesHeld || pinCheck.areas !== 1) {
  errors.push(`a pinned area did not survive scrolling: ${JSON.stringify(pinCheck)}`);
}
await page.screenshot({ path: `${outDir}/03c-pinned-area.png` });
await page.click('#track-clear');
await page.waitForTimeout(1500);

step('checking a feed error cannot break the layout');
const layoutCheck = await page.evaluate(() => {
  // The exact shape that used to push the right hand panel off screen: the
  // upstream's whole nginx error page arriving as a feed status.
  const nasty = 'adsb.lol: HTTP 429 - <html> <head><title>429 Too Many Requests</title></head> <body> <center><h1>429 Too Many Requests</h1></center> <hr><center>nginx</center> </body> </html>,adsb.fi: HTTP 403 - <!DOCTYPE html> <!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]--> <!--[if IE 7]> <html class="no-js ie7 oldie" lang="en-US"> <![endif]--> <!--[if IE 8]> <html class="no-,opensky: timeout';
  window.flysdown.ui.setStatus(nasty);
  window.flysdown.ui.renderFeedToggles(
    { aircraft: false, vessels: false },
    { aircraft: { state: 'down', lastError: nasty, count: 0 }, vessels: { state: 'live', lastError: null, count: 12 } }
  );
  const panel = document.querySelector('.panel-right');
  const rect = panel.getBoundingClientRect();
  return {
    documentOverflowPx: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    panelRight: Math.round(rect.right),
    windowWidth: window.innerWidth,
    panelVisible: rect.width > 40 && rect.right <= window.innerWidth + 2,
    toggleText: document.querySelector('.feed-toggle')?.textContent.trim().slice(0, 40),
    statusText: document.getElementById('status-text').textContent.slice(0, 40),
  };
});
console.log(`  ${JSON.stringify(layoutCheck)}`);
if (!layoutCheck.panelVisible || layoutCheck.documentOverflowPx > 2) {
  errors.push(`a feed error broke the layout: ${JSON.stringify(layoutCheck)}`);
}
await page.screenshot({ path: `${outDir}/03b-feed-error.png` });

step('drawing a circular zone');
await page.click('.tab[data-tab="areas"]');
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

step('mobile layout: bottom tab bar, one view at a time');
await page.setViewportSize({ width: 430, height: 900 });
await page.waitForTimeout(1500);
const mobile = await page.evaluate(async () => {
  const shown = (sel) => getComputedStyle(document.querySelector(sel)).display !== 'none';
  const out = { headerPx: Math.round(document.querySelector('.topbar').getBoundingClientRect().height), navShown: shown('.mobile-nav') };
  document.querySelector('.mobile-nav [data-view="alerts"]').click();
  await new Promise((r) => setTimeout(r, 300));
  out.alertsView = document.body.dataset.view === 'alerts' && shown('.panel-right');
  document.querySelector('.mobile-nav [data-view="areas"]').click();
  await new Promise((r) => setTimeout(r, 300));
  out.areasView = document.body.dataset.view === 'areas' && shown('.panel-left') && !document.getElementById('tab-areas').hidden;
  document.querySelector('.mobile-nav [data-view="map"]').click();
  await new Promise((r) => setTimeout(r, 300));
  // Select through the real click path, so the sheet logic runs.
  const target = window.flysdown.store.all()[0];
  if (target) window.flysdown.mapView.onSelect(target.key);
  await new Promise((r) => setTimeout(r, 500));
  const rect = document.getElementById('detail-block').getBoundingClientRect();
  out.sheet = { height: Math.round(rect.height), bottomOnScreen: rect.bottom <= window.innerHeight + 1, aboveNav: rect.bottom <= window.innerHeight - 50 };
  return out;
});
console.log(`  ${JSON.stringify(mobile)}`);
if (!mobile.navShown || !mobile.alertsView || !mobile.areasView) errors.push(`phone view switching broke: ${JSON.stringify(mobile)}`);
if (mobile.headerPx > 190) errors.push(`phone header is ${mobile.headerPx}px tall, it should stay compact`);
if (mobile.sheet.height < 100 || !mobile.sheet.bottomOnScreen) errors.push(`detail sheet did not appear over the map on a phone: ${JSON.stringify(mobile.sheet)}`);
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
