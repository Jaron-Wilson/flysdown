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

import { chromium, devices } from 'playwright';
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
  // The card is also the Help content, and it has to carry the one caveat a
  // new reader needs: positions are measured, routes are reported.
  saysRoutesAreReported: /Routes are not/.test(document.querySelector('.welcome-caveat')?.textContent || ''),
}));
console.log(`  ${JSON.stringify({ welcomeShown, ...welcomeState })}`);
if (!welcomeState.hidden || !welcomeState.remembered) errors.push(`welcome card did not dismiss cleanly: ${JSON.stringify(welcomeState)}`);
if (!welcomeState.saysRoutesAreReported) errors.push('the welcome card no longer explains that routes are reported, not measured');

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
  const entry = window.flysdown.routes.get(airliner.callsign);
  return {
    callsign: airliner.callsign,
    status: entry?.status,
    // Whether this particular aircraft's reported route survives the
    // plausibility check is a property of today's data, not of the code, so
    // the verdict is reported and the assertion branches on it.
    verdict: entry?.status === 'ok' ? window.flysdown.routeFit(entry.route, airliner).verdict : null,
    legs: legs.map((l) => `${l.leg}:${l.airport?.icao}:${l.coords.length}pts`),
    trackPoints: window.flysdown.state.track.points.length,
    panelShowsRoute: document.getElementById('detail').textContent.includes('Reported route'),
  };
});
console.log(`  in view: ${JSON.stringify(routeOnMap)}`);
// Whether an airliner with a published route happens to be overhead is not a
// property of the code, so only a resolved route is asserted on.
if (typeof routeOnMap === 'object' && routeOnMap.status === 'ok') {
  const shouldDraw = routeOnMap.verdict !== 'mismatch';
  if ((shouldDraw && !routeOnMap.legs.length) || (!shouldDraw && routeOnMap.legs.length) || !routeOnMap.panelShowsRoute) {
    errors.push(`a resolved route was drawn wrongly for its verdict: ${JSON.stringify(routeOnMap)}`);
  }
  // The origin is a marker with no line, because the path flown to here was
  // not observed. Anything drawn forward is an interpolated great circle.
  const drawnLegs = routeOnMap.legs.filter((l) => !l.startsWith('origin:'));
  const originLegs = routeOnMap.legs.filter((l) => l.startsWith('origin:'));
  if (!originLegs.every((l) => l.endsWith(':0pts'))) {
    errors.push(`the origin should be marked, not drawn to: ${JSON.stringify(originLegs)}`);
  }
  if (!drawnLegs.every((l) => l.endsWith('65pts'))) {
    errors.push(`forward route legs should be interpolated great circles: ${JSON.stringify(drawnLegs)}`);
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
  // Through the real click path: this is the bug that started the regression
  // test, a vessel whose detail rendered below the fold.
  window.flysdown.mapView.onSelect(vessel.key);
  await new Promise((r) => setTimeout(r, 400));
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
  // app.js passes the worst feed state alongside the text; a dead feed has to
  // stay visible even when the diagnostics are folded away.
  window.flysdown.ui.setStatus(nasty, { issue: 'down' });
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

step('the feed health line folds away, and the footer stays a footer');
const feedbar = await page.evaluate(() => {
  const bar = document.getElementById('feedbar');
  const footer = document.querySelector('.statusbar');
  const clipped = document.getElementById('status-text');
  const before = {
    // The nasty status from the previous step is still in place: one line,
    // clipped, with the whole of it on the title.
    statusLines: Math.round(clipped.getBoundingClientRect().height),
    titleHoldsFullText: (clipped.title || '').length > clipped.textContent.length - 1,
    barAboveFooter: bar.getBoundingClientRect().bottom <= footer.getBoundingClientRect().top + 1,
    footerText: footer.textContent.replace(/\s+/g, ' ').trim(),
    footerLinks: [...footer.querySelectorAll('a')].map((a) => a.textContent.trim()),
  };

  // Assert the down state here rather than relying on the previous step's: a
  // healthy feed's own tick lands in between and clears it, which is correct
  // behavior and made this read a race.
  window.flysdown.ui.setStatus('ADS-B: upstream not responding', { issue: 'down' });
  before.dotShown = !document.getElementById('feedbar-dot').hidden;
  // The fold button must read as one of this app's buttons, not a control of
  // its own: same type, weight, corner and case as any other .btn.
  const themeOf = (el) => {
    const s = getComputedStyle(el);
    return [s.fontFamily, s.fontSize, s.fontWeight, s.borderRadius, s.textTransform, s.borderColor, s.color].join('|');
  };
  const themeMatchesButtons = themeOf(document.getElementById('feedbar-toggle')) === themeOf(document.getElementById('help-btn'));

  document.getElementById('feedbar-toggle').click();
  return {
    ...before,
    themeMatchesButtons,
    foldedHidesText: !document.getElementById('status-text').offsetParent,
    remembered: localStorage.getItem('flysdown.feedbar.folded.v1'),
  };
});
console.log(`  ${JSON.stringify(feedbar)}`);
if (!feedbar.barAboveFooter) errors.push('the feed health line is not above the footer');
if (feedbar.statusLines > 24) errors.push(`the feed status wrapped to ${feedbar.statusLines}px instead of staying one clipped line`);
if (!feedbar.titleHoldsFullText) errors.push('the full status text is not on the title attribute');
if (!feedbar.foldedHidesText) errors.push('folding the feed line did not hide the status text');
if (feedbar.remembered !== '1') errors.push('the folded state was not remembered');
if (!feedbar.dotShown) errors.push('a down feed did not light the dot on the fold button');
if (!feedbar.themeMatchesButtons) errors.push('the feed fold button is styled unlike the rest of the buttons');
if (/ADS-B:|AIS:|horizon/.test(feedbar.footerText)) errors.push(`feed diagnostics are still in the footer: ${feedbar.footerText}`);
if (feedbar.footerLinks.join(',') !== 'jaronwilson.dev,jaronwilson.org,LinkedIn,Paper,Slides') {
  errors.push(`unexpected footer links: ${feedbar.footerLinks.join(',')}`);
}
if (!/^jaronwilson\.dev jaronwilson\.org LinkedIn Paper Slides Built by Jaron Wilson\. Not for navigation:/.test(feedbar.footerText)) {
  errors.push(`the footer is not links then the disclaimer: ${feedbar.footerText}`);
}

// The paper and slides are served by the site itself, so the links have to
// resolve to real PDFs, not to a page that merely looks like one.
const docs = await page.evaluate(async () => {
  const out = {};
  for (const a of document.querySelectorAll('.statusbar a[href*="docs/"]')) {
    const res = await fetch(a.href, { method: 'HEAD' });
    out[a.textContent.trim()] = { status: res.status, type: res.headers.get('content-type') };
  }
  return out;
});
console.log(`  docs: ${JSON.stringify(docs)}`);
// Local dev serves public/ as it sits, and public/docs holds links to the PDFs
// that only the deploy staging resolves, so this is a check on a deployment.
const isLocal = /127\.0\.0\.1|localhost/.test(url);
for (const [label, info] of Object.entries(docs)) {
  if (isLocal) break;
  if (info.status !== 200 || !/pdf/.test(info.type || '')) errors.push(`the ${label} link does not serve a PDF: ${JSON.stringify(info)}`);
}

// Put it back, so the remaining steps and the screenshots see the normal page.
await page.evaluate(() => document.getElementById('feedbar-toggle').click());

step('every target has its own URL, and a URL selects its target');
const hashCheck = await page.evaluate(async () => {
  const { store, state, tick, hashFor, requestHash } = window.flysdown;
  const target = store.byKind('aircraft').find((t) => t.callsign) || store.all()[0];
  if (!target) return { skipped: 'nothing in the store' };

  // Selecting writes the fragment.
  state.selectedKey = null;
  requestHash(hashFor(target));
  tick();
  const afterUrl = { hash: location.hash, selected: state.selectedKey === target.key };

  // Clearing takes it away again.
  window.flysdown.ui.handlers.clearSelection?.();
  tick();

  // And a fragment nobody can resolve says so instead of going quiet.
  requestHash('ZZZZ999');
  state.pendingHashSince = Date.now() - 30000;
  tick();
  const banner = document.getElementById('map-banner');
  const missingText = banner.hidden ? null : banner.textContent.replace(/\s+/g, ' ');
  state.missingHash = null;
  tick();

  return {
    expected: `#${hashFor(target)}`,
    ...afterUrl,
    clearedHash: location.hash,
    missingText,
    historyLength: history.length,
  };
});
console.log(`  ${JSON.stringify(hashCheck)}`);
if (!hashCheck.skipped) {
  if (!hashCheck.selected) errors.push(`a URL fragment did not select its target: ${JSON.stringify(hashCheck)}`);
  if (hashCheck.hash !== hashCheck.expected) errors.push(`wrong fragment written: ${hashCheck.hash} wanted ${hashCheck.expected}`);
  if (hashCheck.clearedHash !== '') errors.push(`clearing the selection left a fragment: ${hashCheck.clearedHash}`);
  if (!/not in the area being tracked/.test(hashCheck.missingText || '')) {
    errors.push(`an unresolvable fragment said nothing: ${hashCheck.missingText}`);
  }
}

step('the papers page at /docs/');
const docsPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });
const docsResponse = await docsPage.goto(new URL('docs/', url).href, { waitUntil: 'load' });
const docsCheck = await docsPage.evaluate(async () => {
  const links = [...document.querySelectorAll('a[href$=".pdf"]')].map((a) => a.getAttribute('href'));
  const images = await Promise.all([...document.querySelectorAll('img')].map(async (img) => {
    if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
    return { src: img.getAttribute('src'), loaded: img.naturalWidth > 0 };
  }));
  return {
    title: document.title,
    // Pages answers unknown paths with the dashboard, so make sure this is
    // the papers page and not the map.
    isPapersPage: Boolean(document.querySelector('.papers')) && !document.getElementById('map'),
    paperLinked: links.includes('flysdown-paper.pdf'),
    slidesLinked: links.includes('flysdown-linkedin.pdf'),
    images,
    ogImage: document.querySelector('meta[property="og:image"]')?.content || null,
  };
});
console.log(`  ${docsResponse.status()} ${JSON.stringify(docsCheck)}`);
if (!docsCheck.isPapersPage) errors.push('/docs/ does not serve the papers page');
if (!docsCheck.paperLinked || !docsCheck.slidesLinked) errors.push(`/docs/ is missing a document link: ${JSON.stringify(docsCheck)}`);
// The images are links into docs/ that only the deploy staging resolves.
if (!/127\.0\.0\.1|localhost/.test(url) && docsCheck.images.some((i) => !i.loaded)) {
  errors.push(`/docs/ has an image that did not load: ${JSON.stringify(docsCheck.images)}`);
}
await docsPage.close();

step('a cached older build announces itself');
const staleCheck = await page.evaluate(() => {
  const meta = document.querySelector('meta[name="build"]');
  const original = meta.getAttribute('content');

  // No false positive on the build actually being served.
  const atLoad = window.flysdown.checkBuildStamp();

  // Then pretend the HTML came from a later deploy than this app.js, which is
  // exactly what a four-hour asset cache produces.
  meta.setAttribute('content', 'deployed-later');
  const detected = window.flysdown.checkBuildStamp();
  window.flysdown.tick();
  const banner = document.getElementById('map-banner');
  const text = banner.hidden ? null : banner.textContent.replace(/\s+/g, ' ');

  meta.setAttribute('content', original);
  window.flysdown.checkBuildStamp();
  window.flysdown.tick();
  return { atLoad, detected, text, cleared: window.flysdown.state.staleBuild === null, stamp: window.flysdown.BUILD_STAMP };
});
console.log(`  ${JSON.stringify(staleCheck)}`);
if (staleCheck.atLoad !== null) errors.push(`the served build reported itself stale: ${JSON.stringify(staleCheck)}`);
if (staleCheck.detected !== 'deployed-later') errors.push('a stale cached build was not detected');
if (!/older build/.test(staleCheck.text || '')) errors.push(`no banner for a stale build: ${staleCheck.text}`);
if (!staleCheck.cleared) errors.push('the stale-build state did not clear');

step('a route that disagrees with the aircraft is labeled, not asserted');
const routeCheck = await page.evaluate(async () => {
  const { ui, routeFit, buildRouteLegs, store, state, routes } = window.flysdown;

  // Synthetic on purpose: SWA1246 as it actually appeared, over Washington and
  // descending, against the route adsbdb reports for that callsign. Live
  // traffic is not required, so this asserts the same thing on every run.
  const target = {
    id: 'aa9b42',
    key: 'aircraft:aa9b42',
    kind: 'aircraft',
    label: 'SWA1246',
    callsign: 'SWA1246',
    registration: 'N7827A',
    typeCode: 'B737',
    lat: 38.85,
    lon: -77.04,
    alt: 5375,
    groundSpeed: 250,
    track: 316,
    verticalRate: -1152,
    squawk: '2174',
    history: [],
    seenPosSec: 38,
    seenSec: 0,
    source: 'adsb.fi',
  };
  const route = {
    status: 'ok',
    route: {
      origin: { icao: 'KIAH', iata: 'IAH', municipality: 'Houston', name: 'George Bush Intercontinental Houston Airport', lat: 29.9844, lon: -95.3414 },
      destination: { icao: 'KMSY', iata: 'MSY', municipality: 'New Orleans', name: 'Louis Armstrong New Orleans International Airport', lat: 29.9934, lon: -90.258 },
      airline: { name: 'Southwest Airlines' },
    },
  };

  const fit = routeFit(route.route, target);
  ui.renderDetail(target, { evaluation: null, approaches: [], route, track: [] });
  const panel = document.getElementById('detail').textContent.replace(/\s+/g, ' ');

  // And the same route on a real aircraft, to prove nothing is drawn for it.
  let drawn = null;
  const real = store.byKind('aircraft').find((t) => t.callsign);
  if (real) {
    routes.set(real.callsign, route);
    state.selectedKey = real.key;
    drawn = buildRouteLegs().length;
  }

  return {
    verdict: fit.verdict,
    reason: fit.reason,
    detourNm: Math.round(fit.detourNm),
    flagged: panel.includes('unverified'),
    explains: /does not match where the aircraft is/.test(panel),
    withholdsArrival: !panel.includes('Arrival at this speed'),
    notFramable: !document.getElementById('detail-route'),
    legsDrawnForRealAircraft: drawn,
    // The codes people read: IAH and MSY, not KIAH and KMSY.
    showsIataCodes: panel.includes('IAH Houston') && panel.includes('MSY New Orleans'),
    showsIcaoCodes: /\bKIAH\b|\bKMSY\b/.test(panel),
  };
});
console.log(`  ${JSON.stringify(routeCheck)}`);
if (routeCheck.verdict !== 'mismatch' || routeCheck.reason !== 'detour') {
  errors.push(`the SWA1246 case was not caught: ${JSON.stringify(routeCheck)}`);
}
if (!routeCheck.flagged) errors.push('a contradicted route was not marked unverified');
if (!routeCheck.explains) errors.push('a contradicted route did not say why it looks wrong');
if (!routeCheck.withholdsArrival) errors.push('an arrival time was quoted off a route the aircraft is not flying');
if (!routeCheck.notFramable) errors.push('a contradicted route still offered to frame itself');
if (routeCheck.legsDrawnForRealAircraft) errors.push('a contradicted route was still drawn on the map');
if (!routeCheck.showsIataCodes || routeCheck.showsIcaoCodes) {
  errors.push(`airport codes are not the ones people read: ${JSON.stringify(routeCheck)}`);
}
await page.evaluate(() => window.flysdown.ui.renderDetail(null, {}));

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

// A phone-sized viewport is a much smaller query area, and earlier steps have
// moved the map, so the store is pruned and refilled on the next poll. Wait for
// something to be there rather than racing the feed.
const haveTargets = await page
  .waitForFunction(() => (window.flysdown?.store?.all().length || 0) > 0, null, { timeout: 30000 })
  .then(() => true)
  .catch(() => false);
if (!haveTargets) console.warn('  no targets in the phone viewport: the sheet check will be skipped');
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
  // Select through the real click path, so the sheet logic runs. Earlier steps
  // move the map, and a target from the previous view can be pruned between
  // being chosen here and being clicked, so take one whose key still resolves
  // and try again if it went anyway.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const target = window.flysdown.store.all().find((t) => window.flysdown.store.get(t.key));
    if (!target) break;
    window.flysdown.mapView.onSelect(target.key);
    await new Promise((r) => setTimeout(r, 500));
    out.selected = window.flysdown.state.selectedKey;
    if (document.querySelector('.panel-right').classList.contains('has-selection')) break;
  }
  const rect = document.getElementById('detail-block').getBoundingClientRect();
  out.sheet = { height: Math.round(rect.height), bottomOnScreen: rect.bottom <= window.innerHeight + 1, aboveNav: rect.bottom <= window.innerHeight - 50 };
  return out;
});
console.log(`  ${JSON.stringify(mobile)}`);
if (!mobile.navShown || !mobile.alertsView || !mobile.areasView) errors.push(`phone view switching broke: ${JSON.stringify(mobile)}`);
if (mobile.headerPx > 190) errors.push(`phone header is ${mobile.headerPx}px tall, it should stay compact`);
if (haveTargets && (mobile.sheet.height < 100 || !mobile.sheet.bottomOnScreen)) {
  errors.push(`detail sheet did not appear over the map on a phone: ${JSON.stringify(mobile)}`);
}
await page.screenshot({ path: `${outDir}/05-mobile.png`, fullPage: false });

// Last, because it feeds the store a target of its own and a poll for one kind
// prunes what it did not mention.
step('watching one land');
await page.setViewportSize({ width: 1600, height: 950 });
await page.waitForTimeout(800);
const landedCheck = await page.evaluate(() => {
  const { store, state, tick, mapView } = window.flysdown;
  const center = mapView.map.getCenter();
  const now = Date.now();
  const base = {
    id: 'ffee01',
    label: 'SMOKE1',
    callsign: 'SMOKE1',
    typeCode: 'B738',
    typeDesc: 'BOEING 737-800',
    lat: center.lat,
    lon: center.lng,
    track: 90,
    source: 'smoke test',
    seenPos: 0,
    seen: 0,
  };

  // Airborne three minutes ago, on the ground now: the transition is the whole
  // point, so it takes two updates.
  store.ingest('aircraft', [{ ...base, alt: 3000, groundSpeed: 180, onGround: false }], now - 180000, state.coverages);
  store.ingest('aircraft', [{ ...base, alt: null, groundSpeed: 8, onGround: true }], now, state.coverages);

  state.selectedKey = 'aircraft:ffee01';
  tick();

  const panel = document.getElementById('detail').textContent.replace(/\s+/g, ' ');
  const landedAlerts = state.evaluation.alerts.filter((alert) => alert.rule === 'landed');
  const badge = document.getElementById('alert-badge');
  return {
    detected: landedAlerts.length,
    severity: landedAlerts[0]?.severity || null,
    detail: landedAlerts[0]?.detail || null,
    panelSaysLanded: /Landed \u00b7 \d/.test(panel),
    inRail: [...document.querySelectorAll('.alert-list .alert')].some((row) => /Landed/.test(row.textContent)),
    badgeCountsIt: (badge.textContent || '').trim() !== '' && !badge.hidden
      ? state.evaluation.alerts.filter((a) => a.severity !== 'good').length !== Number(badge.textContent)
      : false,
  };
});
console.log(`  ${JSON.stringify(landedCheck)}`);
if (landedCheck.detected !== 1) errors.push(`a landing was not detected: ${JSON.stringify(landedCheck)}`);
if (landedCheck.severity !== 'good') errors.push(`a landing was reported as a fault: ${landedCheck.severity}`);
if (!landedCheck.panelSaysLanded) errors.push('the panel did not say the target had landed');
if (!landedCheck.inRail) errors.push('the landing did not appear in the alerts rail');
if (landedCheck.badgeCountsIt) errors.push('the alert badge counted a landing as something wrong');
await page.screenshot({ path: `${outDir}/06-landed.png` });

// Real phone emulation: touch, a device pixel ratio and a phone user agent,
// in a fresh visit so the welcome card shows. The desktop page resized to a
// phone width, above, cannot catch what only a touch screen does.
step('real phones: welcome, header, map overlays, the target sheet');
for (const name of ['iPhone 13', 'Pixel 7']) {
  const context = await browser.newContext({ ...devices[name] });
  const phone = await context.newPage();
  phone.on('pageerror', (err) => errors.push(`${name} pageerror: ${err.message}`));
  await phone.goto(url, { waitUntil: 'load', timeout: 60000 });
  await phone.waitForFunction(() => !document.getElementById('welcome').hidden, null, { timeout: 15000 }).catch(() => {});

  const welcome = await phone.evaluate(() => {
    const card = document.querySelector('.welcome-card').getBoundingClientRect();
    const actions = document.querySelector('.welcome-actions').getBoundingClientRect();
    return { cardTop: Math.round(card.top), actionsOnScreen: actions.top >= 0 && actions.bottom <= innerHeight + 1 };
  });

  await phone.locator('#welcome [data-start="dc"]').tap();
  await phone.waitForFunction(() => (window.flysdown?.store?.all().length || 0) > 3, null, { timeout: 60000 }).catch(() => {});
  await phone.waitForTimeout(2500);

  const layout = await phone.evaluate(() => {
    const box = (sel) => document.querySelector(sel)?.getBoundingClientRect() || null;
    const shown = (el) => Boolean(el) && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
    const overlap = (a, b) => Boolean(a && b) && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    const header = box('.topbar');
    const map = box('#map');
    const nav = box('.mobile-nav');
    const attrib = document.querySelector('.maplibregl-ctrl-attrib');
    const zoom = document.querySelector('.maplibregl-ctrl-zoom-in')?.closest('.maplibregl-ctrl-group');
    return {
      headerPx: Math.round(header.height),
      mapEndsAboveNav: map.bottom <= nav.top + 1,
      feedbarHidden: !shown(document.getElementById('feedbar')),
      zoomHidden: !shown(zoom),
      creditsCollapsed: Boolean(attrib) && !attrib.classList.contains('maplibregl-compact-show'),
      pinClearOfCredits: !overlap(box('.map-actions'), attrib?.getBoundingClientRect()),
      overflowX: document.documentElement.scrollWidth - innerWidth,
      bannerClosable: document.getElementById('map-banner').hidden || Boolean(document.querySelector('#map-banner .banner-close')),
    };
  });

  // Close whatever banner is up and make sure that one stays closed. Which
  // banner it is depends on the feed's state at the time: a lower-priority
  // one appearing in its place is correct, the same one returning is not.
  const closer = phone.locator('#map-banner .banner-close');
  if (await closer.isVisible().catch(() => false)) {
    const closed = await phone.evaluate(() => document.querySelector('#map-banner .banner-text')?.textContent || '');
    await closer.tap();
    await phone.waitForTimeout(6000);
    layout.bannerStaysDismissed = await phone.evaluate((text) => {
      const banner = document.getElementById('map-banner');
      return banner.hidden || (banner.querySelector('.banner-text')?.textContent || '') !== text;
    }, closed);
  }

  const sheet = await phone.evaluate(async () => {
    const target = window.flysdown.store.all().find((t) => window.flysdown.store.get(t.key));
    if (!target) return { skipped: true };
    window.flysdown.mapView.onSelect(target.key);
    await new Promise((r) => setTimeout(r, 1100));
    const block = document.getElementById('detail-block').getBoundingClientRect();
    const nav = document.querySelector('.mobile-nav').getBoundingClientRect();
    const header = document.querySelector('.topbar').getBoundingClientRect();
    const mapBox = document.getElementById('map').getBoundingClientRect();
    const closeButton = document.getElementById('detail-close-x');
    // Where the tapped target is on screen now: it must not be under the card.
    const live = window.flysdown.store.get(target.key) || target;
    const point = window.flysdown.mapView.map.project([live.lon, live.lat]);
    const peekPx = Math.round(block.height);
    document.getElementById('sheet-toggle').click();
    await new Promise((r) => setTimeout(r, 300));
    const expandedPx = Math.round(document.getElementById('detail-block').getBoundingClientRect().height);
    return {
      aboveNav: block.bottom <= nav.top + 1,
      mapShare: Math.round(((block.top - header.bottom) / innerHeight) * 100),
      hasClose: Boolean(closeButton),
      peekPx,
      expandedPx,
      targetVisible: mapBox.top + point.y < block.top && mapBox.top + point.y > mapBox.top,
      tooltipHidden: getComputedStyle(document.getElementById('map-tooltip')).display === 'none',
    };
  });
  if (!sheet.skipped) {
    await phone.locator('#detail-close-x').tap();
    await phone.waitForTimeout(400);
    sheet.closes = await phone.evaluate(() => !document.querySelector('.panel-right').classList.contains('has-selection'));
  }

  const result = { welcome, layout, sheet };
  console.log(`  ${name}: ${JSON.stringify(result)}`);
  const tag = name.replace(/\s+/g, '-').toLowerCase();
  await phone.screenshot({ path: `${outDir}/07-${tag}.png` });

  if (welcome.cardTop < 0) errors.push(`${name}: the welcome card starts above the screen`);
  if (!welcome.actionsOnScreen) errors.push(`${name}: the welcome buttons are off screen`);
  if (layout.headerPx > 100) errors.push(`${name}: the header is ${layout.headerPx}px tall`);
  if (!layout.mapEndsAboveNav) errors.push(`${name}: the map runs under the tab bar`);
  if (!layout.feedbarHidden) errors.push(`${name}: the feed line is showing on a phone`);
  if (!layout.zoomHidden) errors.push(`${name}: zoom buttons shown on a touch screen`);
  if (!layout.creditsCollapsed) errors.push(`${name}: the map credits are expanded over the map`);
  if (!layout.pinClearOfCredits) errors.push(`${name}: Pin this view overlaps the map credits`);
  if (layout.overflowX > 1) errors.push(`${name}: the page scrolls sideways by ${layout.overflowX}px`);
  if (!layout.bannerClosable) errors.push(`${name}: a map banner has no way to close it`);
  if (layout.bannerStaysDismissed === false) errors.push(`${name}: the dismissed AIS note came back`);
  if (!sheet.skipped) {
    if (!sheet.aboveNav) errors.push(`${name}: the target sheet runs under the tab bar`);
    if (sheet.mapShare < 25) errors.push(`${name}: only ${sheet.mapShare}% of the screen is map with a target selected`);
    if (!sheet.hasClose || !sheet.closes) errors.push(`${name}: the target sheet cannot be closed from its top`);
    if (sheet.peekPx > 240) errors.push(`${name}: a tap opens a ${sheet.peekPx}px sheet instead of a short card`);
    if (sheet.expandedPx <= sheet.peekPx) errors.push(`${name}: More details did not open the full detail`);
    if (!sheet.targetVisible) errors.push(`${name}: the tapped target is hidden under its own card`);
    if (!sheet.tooltipHidden) errors.push(`${name}: the hover tooltip shows on a touch screen`);
  }
  await context.close();
}

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
