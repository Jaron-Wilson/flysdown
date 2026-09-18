/**
 * flysdown - application wiring.
 *
 * Pipeline, once per feed update:
 *
 *   poll -> normalize (edge) -> TargetStore (adds history)
 *        -> filters -> detection engine -> projections -> map + panels
 *
 * The detection engine and the geometry it uses are plain modules under js/,
 * deliberately free of DOM and map dependencies so the same rules can be moved
 * to a Worker cron later and alert without a browser open.
 */

import { Feed, TargetStore, areaQuery, FEED_INTERVALS, worstFeedIssue } from './js/feeds.js';

/**
 * Which deploy this file came from, rewritten in the uploaded copy by
 * tools/stamp.mjs. index.html carries the same stamp and is never cached,
 * while this file can be cached for four hours, so a disagreement means the
 * browser is running old code and the page should say so rather than quietly
 * behave like a version that has been fixed.
 */
const BUILD_STAMP = 'dev';
import { ZoneStore, prepareZone } from './js/zones.js';
import { evaluateAll, SEVERITY_RANK } from './js/detect.js';
import { projectPath, circleRing, distanceNm, greatCirclePath } from './js/geo.js';
import { routeFit } from './js/route.js';
import { MapView } from './js/map.js';
import { ZoneDrawer } from './js/draw.js';
import { UI, fmt } from './js/ui.js';

const REGIONS = {
  dc: { center: [-77.0369, 38.9072], zoom: 8.2, label: 'Washington DC' },
  gof: { center: [24.95, 59.95], zoom: 7.4, label: 'Gulf of Finland' },
  nyc: { center: [-73.94, 40.72], zoom: 8.2, label: 'New York' },
  lon: { center: [-0.12, 51.5], zoom: 8.0, label: 'London' },
  socal: { center: [-117.92, 33.81], zoom: 8.6, label: 'Southern California' },
};

/** Where the keyless AIS provider actually has coverage. */
const AIS_COVERAGE = { minLat: 55, maxLat: 67, minLon: 14, maxLon: 36 };
const inAisCoverage = (lat, lon) =>
  lat >= AIS_COVERAGE.minLat && lat <= AIS_COVERAGE.maxLat && lon >= AIS_COVERAGE.minLon && lon <= AIS_COVERAGE.maxLon;

const $ = (id) => document.getElementById(id);

const TRACKING_KEY = 'flysdown.tracking.v1';
const MAX_TRACKING_AREAS = 4;

const state = {
  filters: { aircraft: true, vessels: true, trails: true, labels: true, ground: false, military: false, alertsOnly: false, approaches: true },
  horizonSec: 600,
  cpaAlertNm: 1.0,
  selectedKey: null,
  paused: { aircraft: false, vessels: false },
  // Pinned areas keep loading regardless of where the map is scrolled. Empty
  // means follow the viewport, which is the default.
  tracking: [],
  track: { key: null, points: [] },
  coverages: [],
  viewRadiusNm: 0,
  feeds: { aircraft: { state: 'idle' }, vessels: { state: 'idle' } },
  evaluation: { alerts: [], byTarget: new Map(), zoneAlertCounts: new Map(), approaches: [] },
  pendingGeometry: null,
  // Set when this file is older than the HTML that loaded it: see BUILD_STAMP.
  staleBuild: null,
  // A callsign from the URL that has not been found in the feed yet.
  pendingHash: null,
  pendingHashSince: 0,
  missingHash: null,
};

/* ---------- tracking areas ---------- */

function loadTracking() {
  try {
    const raw = localStorage.getItem(TRACKING_KEY);
    state.tracking = raw ? JSON.parse(raw).slice(0, MAX_TRACKING_AREAS) : [];
  } catch {
    state.tracking = [];
  }
}

function saveTracking() {
  try {
    localStorage.setItem(TRACKING_KEY, JSON.stringify(state.tracking));
  } catch (err) {
    console.warn('could not persist tracking areas', err);
  }
}

/** Is this target inside any pinned area? */
function insideTracking(target) {
  return state.tracking.some((area) => {
    if (area.shape === 'box') {
      const b = area.bounds;
      return target.lat >= b.south && target.lat <= b.north && target.lon >= b.west && target.lon <= b.east;
    }
    return distanceNm(target.lat, target.lon, area.center.lat, area.center.lon) <= area.radiusNm;
  });
}

function addTrackingArea(geometry) {
  if (state.tracking.length >= MAX_TRACKING_AREAS) {
    ui.setStatus(`Tracking areas are capped at ${MAX_TRACKING_AREAS}. Remove one first.`);
    return;
  }

  const id = `area-${Date.now()}`;
  if (geometry.shape === 'box') {
    const b = geometry.bounds;
    const center = { lat: (b.north + b.south) / 2, lon: (b.east + b.west) / 2 };
    // The feeds take a center and a radius, so a box is queried by its
    // bounding circle and then filtered back to the rectangle for display.
    const radiusNm = distanceNm(center.lat, center.lon, b.north, b.east);
    state.tracking.push({ id, shape: 'box', bounds: b, center, radiusNm });
  } else {
    state.tracking.push({ id, shape: 'circle', center: geometry.center, radiusNm: Math.max(1, geometry.radiusNm) });
  }

  saveTracking();
  applyQueries({ poll: true });
  tick();
}

function removeTrackingArea(id) {
  state.tracking = state.tracking.filter((area) => area.id !== id);
  saveTracking();
  applyQueries({ poll: true });
  tick();
}

function clearTrackingAreas() {
  state.tracking = [];
  saveTracking();
  applyQueries({ poll: true });
  tick();
}

function pinCurrentView() {
  const viewport = mapView.viewport();
  addTrackingArea({
    shape: 'circle',
    center: { lat: viewport.center.lat, lon: viewport.center.lng },
    radiusNm: Math.max(5, viewport.radiusNm),
  });
}

const ui = new UI();
const zones = new ZoneStore();
const store = new TargetStore();

const mapView = new MapView('map', {
  onSelect: (key) => selectTarget(key),
  onHover: (props, point) => ui.showTooltip(props, point),
  onViewChange: (viewport) => handleViewChange(viewport),
  onZoneClick: (id) => {
    const zone = zones.get(id);
    if (zone) ui.setStatus(`${zone.name}: ${zone.note || 'no note'}`);
  },
});

const drawer = new ZoneDrawer(mapView, {
  onComplete: (geometry, purpose) => {
    if (purpose === 'tracking') addTrackingArea(geometry);
    else openZoneForm(geometry);
  },
  onModeChange: (mode, purpose) => {
    $('draw-circle').classList.toggle('active', mode === 'circle' && purpose === 'zone');
    $('draw-polygon').classList.toggle('active', mode === 'polygon' && purpose === 'zone');
    $('track-circle').classList.toggle('active', mode === 'circle' && purpose === 'tracking');
    $('track-box').classList.toggle('active', mode === 'box' && purpose === 'tracking');
    $('draw-finish').hidden = !(mode === 'polygon' && purpose === 'zone');
    $('draw-cancel').hidden = !mode;
    ui.setDrawHint(
      mode === 'circle'
        ? `Click the center, then click again to set the radius${purpose === 'tracking' ? ' of the tracking area' : ''}.`
        : mode === 'box'
          ? 'Click one corner of the tracking area, then the opposite corner.'
          : mode === 'polygon'
            ? 'Click each corner, then press Finish (or double-click) to close the shape.'
            : ''
    );
  },
});

const feeds = {
  aircraft: new Feed({
    name: 'aircraft',
    endpoint: 'api/aircraft',
    itemsKey: 'aircraft',
    intervalMs: FEED_INTERVALS.aircraft,
    onData: (payload) => {
      state.coverages = payload.coverages;
      store.ingest('aircraft', payload.items, payload.fetchedAt, payload.coverages);
      tick();
    },
    onStatus: (name, status) => {
      state.feeds[name] = status;
      ui.renderFeedToggles(state.paused, state.feeds);
      updateStatusLine();
    },
  }),
  vessels: new Feed({
    name: 'vessels',
    endpoint: 'api/vessels',
    itemsKey: 'vessels',
    intervalMs: FEED_INTERVALS.vessels,
    onData: (payload) => {
      store.ingest('vessel', payload.items, payload.fetchedAt, payload.coverages);
      tick();
    },
    onStatus: (name, status) => {
      state.feeds[name] = status;
      ui.renderFeedToggles(state.paused, state.feeds);
      updateStatusLine();
    },
  }),
};

/* ---------- flight routes and the selected aircraft's track ---------- */

/**
 * Callsign -> route lookup state. ADS-B carries no origin or destination, so
 * this asks the edge (which asks adsbdb) once per callsign per session. General
 * aviation callsigns usually have no scheduled route, and that answer is
 * remembered too rather than asked again on every click.
 */
const routes = new Map();

async function ensureRoute(callsign) {
  if (!callsign || routes.has(callsign)) return;
  routes.set(callsign, { status: 'pending' });
  try {
    const res = await fetch(`api/route?${new URLSearchParams({ callsign })}`);
    const json = await res.json();
    routes.set(callsign, json.ok && json.found ? { status: 'ok', route: json } : { status: 'none' });
  } catch {
    routes.set(callsign, { status: 'none' });
  }
  // The panel and the map both want it, and it arrived after they rendered.
  const target = state.selectedKey ? store.get(state.selectedKey) : null;
  if (target && target.callsign === callsign) {
    ui.renderDetail(target, {
      evaluation: state.evaluation.byTarget.get(target.id),
      approaches: state.evaluation.approaches,
      route: routeFor(target),
      track: state.track.points,
    });
    render();
  }
}

function routeFor(target) {
  if (!target || target.kind !== 'aircraft' || !target.callsign) return null;
  return routes.get(target.callsign) || null;
}

/**
 * The full observed track of the selected target, which keeps growing for as
 * long as it stays selected. Seeded from the history the store already holds,
 * so selecting an aircraft shows where it has been, not just where it goes
 * next.
 */
function updateSelectedTrack() {
  const target = state.selectedKey ? store.get(state.selectedKey) : null;
  if (!target) {
    state.track = { key: null, points: [] };
    return;
  }

  // Any path that changes the selection should get a route lookup, not just
  // a click on the map.
  if (target.callsign) ensureRoute(target.callsign);

  if (state.track.key !== target.key) {
    state.track = { key: target.key, points: target.history.map((h) => [h.lon, h.lat]) };
    return;
  }

  const last = state.track.points[state.track.points.length - 1];
  if (!last || distanceNm(last[1], last[0], target.lat, target.lon) > 0.02) {
    state.track.points.push([target.lon, target.lat]);
    if (state.track.points.length > 3000) state.track.points.shift();
  }
}

/* ---------- selection ---------- */

/* ---------- one URL per target ---------- */

/**
 * The address for a target: `#JZA786` for a flight, the ICAO hex for an
 * aircraft with no callsign, the MMSI for a ship.
 *
 * FlightAware gives every flight its own page, which is how someone checks or
 * shares one, and Jaron asked for the same here with a fragment rather than a
 * path because this is one static page. The fragment is written with
 * replaceState, so selecting six aircraft in a row does not leave six entries
 * in the back button.
 */
function hashFor(target) {
  if (!target) return null;
  if (target.kind === 'vessel') return String(target.mmsi || target.id || '').toUpperCase();
  return String(target.callsign || target.id || '').toUpperCase();
}

function syncHash(target) {
  const wanted = hashFor(target);
  const next = wanted ? `#${wanted}` : '';
  if (location.hash === next) return;
  history.replaceState(null, '', next || `${location.pathname}${location.search}`);
}

/** A target named in the URL, if it is one this page could resolve. */
function readHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, '')).trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9-]{1,11}$/.test(raw) ? raw : null;
}

function findByHash(wanted) {
  if (!wanted) return null;
  return store.all().find((target) => hashFor(target) === wanted) || null;
}

/**
 * Try to honor the URL. The feed only carries the area being watched, so a
 * flight named in the URL may simply not be here: keep looking while updates
 * arrive, then say so rather than leaving the panel silent.
 */
const PENDING_HASH_TIMEOUT_MS = 20000;

function resolvePendingHash() {
  if (!state.pendingHash) return;

  const target = findByHash(state.pendingHash);
  if (target) {
    state.missingHash = null;
    state.pendingHash = null;
    selectTarget(target.key);
    mapView.panTo(target.lon, target.lat);
    return;
  }

  if (Date.now() - state.pendingHashSince > PENDING_HASH_TIMEOUT_MS) {
    state.missingHash = state.pendingHash;
    state.pendingHash = null;
  }
}

function requestHash(wanted) {
  state.pendingHash = wanted;
  state.pendingHashSince = Date.now();
  state.missingHash = null;
  if (wanted) resolvePendingHash();
}

window.addEventListener('hashchange', () => {
  const wanted = readHash();
  if (!wanted) {
    if (state.selectedKey) selectTarget(null);
    return;
  }
  if (hashFor(state.selectedKey ? store.get(state.selectedKey) : null) === wanted) return;
  requestHash(wanted);
});

function selectTarget(key) {
  state.selectedKey = key;
  store.protect(key);
  const target = key ? store.get(key) : null;
  updateSelectedTrack();
  ui.renderDetail(target, {
    evaluation: target ? state.evaluation.byTarget.get(target.id) : null,
    approaches: state.evaluation.approaches,
    route: routeFor(target),
    track: state.track.points,
  });
  ui.focusDetail(Boolean(target));
  syncHash(target);
  if (target) state.missingHash = null;
  render();
}

ui.on('selectTarget', (key) => {
  selectTarget(key);
  const target = store.get(key);
  if (target) mapView.panTo(target.lon, target.lat);
});

ui.on('clearSelection', () => selectTarget(null));

ui.on('centerTarget', (key) => {
  const target = store.get(key);
  if (target) mapView.panTo(target.lon, target.lat);
});

ui.on('toggleZone', (id, enabled) => {
  zones.updateZone(id, { enabled });
  tick();
});

ui.on('zoomZone', (id) => {
  const zone = zones.get(id);
  if (!zone) return;
  const zoom = Math.max(6, Math.min(12, 10.5 - Math.log2(Math.max(1, zone.radiusNm))));
  mapView.flyTo([zone.center.lon, zone.center.lat], zoom);
});

ui.on('deleteZone', (id) => {
  const zone = zones.get(id);
  if (!zone) return;
  if (!window.confirm(`Delete the drawn zone "${zone.name}"?`)) return;
  zones.removeZone(id);
  tick();
});

/* ---------- view + feeds ---------- */

/**
 * Which areas each feed should be loading.
 *
 * With pinned tracking areas the queries are those areas and nothing else, so
 * scrolling the map does not change what is being loaded. With none pinned,
 * a single query follows the viewport.
 */
function currentAreas() {
  if (state.tracking.length) {
    return state.tracking.map((area) => ({
      lat: area.center.lat,
      lon: area.center.lon,
      radiusNm: area.radiusNm,
    }));
  }
  const viewport = mapView.viewport();
  return [{ lat: viewport.center.lat, lon: viewport.center.lng, radiusNm: viewport.radiusNm }];
}

function applyQueries({ poll = false } = {}) {
  const areas = currentAreas();
  const aircraftChanged = feeds.aircraft.setQueries(areas.map((a) => areaQuery(a.lat, a.lon, a.radiusNm).aircraft));
  const vesselsChanged = feeds.vessels.setQueries(areas.map((a) => areaQuery(a.lat, a.lon, a.radiusNm).vessels));

  // Forget anything the new set of areas does not cover, straight away.
  const coverages = areas.map((a) => ({ lat: a.lat, lon: a.lon, radiusNm: a.radiusNm }));
  if (aircraftChanged) store.pruneToCoverage('aircraft', coverages);
  if (vesselsChanged) store.pruneToCoverage('vessel', coverages);

  if (aircraftChanged && (poll || !state.paused.aircraft)) feeds.aircraft.poll();
  if (vesselsChanged && (poll || !state.paused.vessels)) feeds.vessels.poll();
  return aircraftChanged || vesselsChanged;
}

function handleViewChange(viewport) {
  state.viewRadiusNm = viewport.radiusNm;
  // Pinned areas ignore the viewport entirely; that is the point of pinning.
  if (!state.tracking.length) applyQueries();
  tick();
}

/** One line describing where the data came from and how old it is. */
function describeFeed(label, status) {
  if (!status || status.state === 'idle') return `${label}: starting`;
  if (status.state === 'paused') return `${label}: paused`;
  if (status.state === 'down') return `${label}: ${status.lastError || 'unavailable'}`;

  const parts = [status.source || 'unknown'];
  if (status.ageMs > 1500) parts.push(`data ${fmt.duration(status.ageMs / 1000)} old`);
  parts.push(`polled ${fmt.ago(status.lastSuccess)}`);
  if (status.state === 'degraded' && status.lastError) parts.push(status.lastError);
  return `${label}: ${parts.join(', ')}`;
}

function updateStatusLine() {
  // Folding the health line away must not be able to hide a dead feed, so the
  // worst state travels with the text and lights a dot on the fold button.
  const issue = worstFeedIssue([state.feeds.aircraft, state.feeds.vessels]);

  ui.setStatus(
    [
      describeFeed('ADS-B', state.feeds.aircraft),
      describeFeed('AIS', state.feeds.vessels),
      `horizon ${Math.round(state.horizonSec / 60)} min`,
    ].join('  |  '),
    { issue }
  );
}

/* ---------- the tick: evaluate then render ---------- */

/**
 * A predicate for "inside the part of the world currently on screen".
 *
 * The upstreams are queried with a center and a radius, which is the smallest
 * circle covering the viewport and therefore always pulls in more than the
 * visible rectangle. Everything outside that rectangle is dropped here, so the
 * map, the counts, the alerts and the table all describe exactly what is being
 * looked at.
 */
function viewportFilter() {
  if (state.tracking.length) return () => true;
  const bounds = mapView.map.getBounds();
  const west = bounds.getWest();
  const east = bounds.getEast();
  const south = bounds.getSouth();
  const north = bounds.getNorth();

  // A view straddling the antimeridian has east < west; do not filter rather
  // than filter wrongly.
  if (east < west) return () => true;

  // A little margin so an icon straddling the edge does not flicker.
  const padLat = (north - south) * 0.03;
  const padLon = (east - west) * 0.03;
  return (target) =>
    target.lat >= south - padLat &&
    target.lat <= north + padLat &&
    target.lon >= west - padLon &&
    target.lon <= east + padLon;
}

function visibleTargets() {
  const inView = viewportFilter();
  const pinned = state.tracking.length > 0;
  return store.all().filter((target) => {
    // The selected target stays visible wherever the map has been moved to,
    // so its track and route do not vanish when framing a long flight.
    if (target.key === state.selectedKey) return true;
    // Pinned areas define the working set, so their contacts stay in the
    // counts and the alerts even when scrolled off screen.
    if (pinned ? !insideTracking(target) : !inView(target)) return false;
    if (target.kind === 'aircraft' && !state.filters.aircraft) return false;
    if (target.kind === 'vessel' && !state.filters.vessels) return false;
    if (!state.filters.ground && target.kind === 'aircraft' && target.onGround) return false;
    if (state.filters.military && target.kind === 'aircraft' && !(target.military || target.interesting)) return false;
    return true;
  });
}

function tick() {
  const activeZones = zones.all().filter((z) => z.enabled);
  const candidates = visibleTargets();
  state.evaluation = evaluateAll(candidates, activeZones, {
    horizonSec: state.horizonSec,
    cpaAlertNm: state.cpaAlertNm,
    closeApproaches: state.filters.approaches && state.filters.vessels,
  });

  resolvePendingHash();
  updateSelectedTrack();
  if (!state.selectedKey) {
    // Clearing the selection has to clear the panel too: without this it kept
    // showing the last target's detail forever.
    ui.renderDetail(null);
  } else {
    const target = store.get(state.selectedKey);
    ui.renderDetail(target, {
      evaluation: target ? state.evaluation.byTarget.get(target.id) : null,
      approaches: state.evaluation.approaches,
      route: routeFor(target),
      track: state.track.points,
    });
  }
  render(candidates);
  updateStatusLine();
}

/** Projection lines: everything alerting on a zone, plus the selection. */
function buildProjections(targets) {
  const projections = [];
  const alertsByTarget = new Map();
  for (const alert of state.evaluation.alerts) {
    if (!alert.zoneId) continue;
    const current = alertsByTarget.get(alert.targetId);
    if (!current || SEVERITY_RANK[alert.severity] > SEVERITY_RANK[current.severity]) alertsByTarget.set(alert.targetId, alert);
  }

  for (const target of targets) {
    const alert = alertsByTarget.get(target.id);
    const isSelected = target.key === state.selectedKey;
    if (!alert && !isSelected) continue;

    const horizon = alert?.etaSec ? Math.min(state.horizonSec, Math.max(30, alert.etaSec)) : state.horizonSec;
    const samples = projectPath(target, { horizonSec: horizon, stepSec: Math.max(5, horizon / 40) });
    if (samples.length < 2) continue;

    projections.push({
      key: target.key,
      severity: alert?.severity || 'notice',
      coords: samples.map((s) => [s.lon, s.lat]),
      entry: alert?.etaSec ? [samples[samples.length - 1].lon, samples[samples.length - 1].lat] : null,
    });
  }
  return projections;
}

function render(candidates = visibleTargets()) {
  const alertedIds = new Set(state.evaluation.alerts.map((a) => a.targetId));
  const shown = state.filters.alertsOnly ? candidates.filter((t) => alertedIds.has(t.id)) : candidates;

  const aircraft = shown.filter((t) => t.kind === 'aircraft');
  const vessels = shown.filter((t) => t.kind === 'vessel');
  const groundCount = candidates.filter((t) => t.kind === 'aircraft' && t.onGround).length;

  const singleCoverage = state.tracking.length === 0 && state.coverages.length === 1 ? state.coverages[0] : null;

  mapView.render({
    aircraft,
    vessels,
    zones: zones.all().filter((z) => z.enabled),
    zoneAlertCounts: state.evaluation.zoneAlertCounts,
    projections: buildProjections(shown),
    alerts: state.evaluation.alerts,
    approaches: state.filters.vessels ? state.evaluation.approaches : [],
    trackingAreas: state.tracking,
    selectedTrack: state.track.points,
    routeLegs: buildRouteLegs(),
    selectedKey: state.selectedKey,
    // Only worth drawing when the upstream radius cap actually cuts into the
    // view; otherwise it is an off-screen circle explaining nothing.
    coverage: state.filters.aircraft && singleCoverage && state.viewRadiusNm > singleCoverage.radiusNm * 1.02
      ? singleCoverage
      : null,
    showLabels: state.filters.labels,
  });

  const shownKeys = new Set(shown.map((t) => t.key));
  mapView.setData('trails', state.filters.trails
    ? [
        ...(state.filters.aircraft ? store.trailFeatures('aircraft') : []),
        ...(state.filters.vessels ? store.trailFeatures('vessel') : []),
      ].filter((feature) => shownKeys.has(feature.properties.key))
    : []);

  ui.renderStats({
    aircraftCount: aircraft.length,
    vesselCount: vessels.length,
    alerts: state.evaluation.alerts,
    projectedCount: state.evaluation.alerts.filter((a) => a.rule === 'zone-projected').length,
    groundCount,
  });
  ui.renderAltitudeChart(aircraft);
  ui.renderAlerts(state.evaluation.alerts);
  ui.renderZones(sortedZones(), state.evaluation.zoneAlertCounts);
  ui.renderTracking(state.tracking, MAX_TRACKING_AREAS);
  ui.renderFeedToggles(state.paused, state.feeds);
  // 'good' covers events like a landing, which belong in the rail but should
  // not inflate a count that reads as "things wrong right now".
  ui.renderAlertBadge(state.evaluation.alerts.filter((alert) => alert.severity !== 'good').length);
  ui.renderMapPin(state.tracking.length);

  updateBanner(vessels.length);
}

/**
 * The two legs of a selected flight: where it came from, and where it is
 * going. Drawn as great circles from the origin airport to the aircraft's
 * current position and on to the destination, so both are shown as flown
 * rather than as straight lines on a Mercator projection.
 */
function buildRouteLegs() {
  const target = state.selectedKey ? store.get(state.selectedKey) : null;
  const entry = routeFor(target);
  if (!target || entry?.status !== 'ok') return [];

  const { origin, destination } = entry.route;

  // A route the aircraft's own position contradicts is not drawn at all. Drawn
  // faintly it was still a line from Houston through an aircraft over
  // Washington and on to New Orleans, which reads as a path whatever its
  // opacity, and it sent the framing button to a view of half a continent.
  // The panel keeps the claim, with the distances that disprove it.
  if (routeFit(entry.route, target).verdict === 'mismatch') return [];

  const legs = [];

  // The origin is marked, not drawn to. A great circle from the departure
  // airport to the aircraft's current position claims a path it did not fly:
  // airways, vectors and holds are not straight, and Jaron noticed. What this
  // system can honestly draw of the past is the track it has actually watched,
  // which is the solid line, so the origin gets its marker and nothing more.
  if (origin) {
    legs.push({ leg: 'origin', airport: origin, coords: [] });
  }

  // Ahead of the aircraft is a projection rather than a record, and it is
  // dashed for that reason.
  if (destination) {
    legs.push({
      leg: 'remaining',
      airport: destination,
      coords: greatCirclePath(target.lat, target.lon, destination.lat, destination.lon, 64),
    });
  }
  return legs;
}

/** Breached zones first, then whatever is nearest the current view. */
function sortedZones() {
  const center = mapView.map.getCenter();
  const counts = state.evaluation.zoneAlertCounts;
  return zones.all()
    .map((zone) => ({
      zone,
      breached: counts.has(zone.id) ? 1 : 0,
      distanceNm: distanceNm(center.lat, center.lng, zone.center.lat, zone.center.lon),
    }))
    .sort((a, b) => b.breached - a.breached || a.distanceNm - b.distanceNm)
    .map((entry) => entry.zone);
}

/**
 * One banner slot, so the map always explains its own state. Priority order:
 * a dead feed first, then a stale one, then missing AIS coverage.
 */
function updateBanner(vesselCount) {
  const air = state.feeds.aircraft || {};
  const center = mapView.map.getCenter();

  // A URL naming a target that is not here is a direct answer to something the
  // reader did, so it outranks the feed's own state, but not stale code.
  if (state.missingHash) {
    ui.showBanner(
      `${state.missingHash} is not in the area being tracked right now. Move the map to where it is flying, or pin that area, and it will be selected.`,
      { label: 'Dismiss', onClick: () => { state.missingHash = null; updateBanner(vesselCount); } }
    );
    return;
  }

  // Outranks every other banner: if this is old code, nothing else it says
  // about itself can be trusted.
  if (state.staleBuild) {
    ui.showBanner(
      `This page is running an older build (${BUILD_STAMP}) than the one deployed (${state.staleBuild}), because the browser cached it. Reload with Ctrl+Shift+R, or Cmd+Shift+R on a Mac.`,
      null
    );
    return;
  }

  if (state.filters.aircraft && air.state === 'down') {
    ui.showBanner(
      'ADS-B feed unavailable right now. The community aggregators rate-limit shared cloud addresses, so the edge proxy is being refused. Vessel data is unaffected.',
      null
    );
    return;
  }

  if (state.filters.aircraft && air.stale) {
    const seconds = Math.round(air.ageMs / 1000);
    ui.showBanner(
      air.via === 'relay'
        ? `Aircraft positions are ${seconds} s old: the relay has not pushed a fresh snapshot. Check that it is still running.`
        : `Aircraft positions are ${seconds} s old: the aggregators are rate-limiting the edge, so this is the last good picture.`,
      null
    );
    return;
  }

  if (state.tracking.length && !state.tracking.some((area) => mapView.map.getBounds().contains([area.center.lon, area.center.lat]))) {
    ui.showBanner(
      `Tracking ${state.tracking.length} pinned area${state.tracking.length === 1 ? '' : 's'}, none of which is on screen. Data keeps loading for them.`,
      { label: 'Go to area', onClick: () => mapView.flyTo([state.tracking[0].center.lon, state.tracking[0].center.lat], 8) }
    );
    return;
  }

  if (state.filters.vessels && vesselCount === 0 && !inAisCoverage(center.lat, center.lng)) {
    ui.showBanner('No AIS coverage in this view. The keyless AIS feed covers the Baltic and Gulf of Finland.', {
      label: 'Jump to coverage',
      onClick: () => {
        $('region-select').value = 'gof';
        mapView.flyTo(REGIONS.gof.center, REGIONS.gof.zoom);
      },
    });
    return;
  }

  ui.showBanner(null);
}

/* ---------- zone drawing ---------- */

function openZoneForm(geometry) {
  state.pendingGeometry = geometry;
  ui.setTab('areas');
  if (window.matchMedia('(max-width: 1040px)').matches) ui.setView('areas');
  const form = $('zone-form');
  form.hidden = false;
  const count = zones.all().filter((z) => z.userDrawn).length + 1;
  $('zf-name').value = `Watch area ${count}`;
  $('zf-name').focus();
  ui.setDrawHint('');
}

$('zone-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const geometry = state.pendingGeometry;
  if (!geometry) return;

  const appliesTo = [];
  if ($('zf-aircraft').checked) appliesTo.push('aircraft');
  if ($('zf-vessels').checked) appliesTo.push('vessel');

  const base = {
    id: `user-${Date.now()}`,
    name: $('zf-name').value.trim() || 'Watch area',
    kind: $('zf-kind').value,
    floorFt: Number($('zf-floor').value) || 0,
    ceilingFt: Number($('zf-ceiling').value) || 60000,
    appliesTo: appliesTo.length ? appliesTo : ['aircraft'],
    approx: true,
    note: 'Drawn in the browser.',
    source: 'operator',
    userDrawn: true,
    enabled: true,
  };

  const zone = geometry.shape === 'circle'
    ? {
        ...base,
        shape: 'circle',
        radiusNm: geometry.radiusNm,
        center: geometry.center,
        ring: circleRing(geometry.center.lat, geometry.center.lon, geometry.radiusNm),
      }
    : prepareZone({
        type: 'Feature',
        properties: { ...base, shape: 'polygon' },
        geometry: { type: 'Polygon', coordinates: [geometry.ring] },
      });

  zones.addUserZone(zone);
  state.pendingGeometry = null;
  $('zone-form').hidden = true;
  $('zone-form').reset();
  $('zf-aircraft').checked = true;
  tick();
});

$('zf-cancel').addEventListener('click', () => {
  state.pendingGeometry = null;
  $('zone-form').hidden = true;
});

$('track-circle').addEventListener('click', () => drawer.setMode(drawer.mode === 'circle' && drawer.purpose === 'tracking' ? null : 'circle', 'tracking'));
$('track-box').addEventListener('click', () => drawer.setMode(drawer.mode === 'box' ? null : 'box', 'tracking'));
$('track-view').addEventListener('click', () => pinCurrentView());
$('map-pin').addEventListener('click', () => {
  if (state.tracking.length) clearTrackingAreas();
  else pinCurrentView();
});
$('track-clear').addEventListener('click', () => clearTrackingAreas());

$('draw-circle').addEventListener('click', () => drawer.setMode(drawer.mode === 'circle' && drawer.purpose === 'zone' ? null : 'circle', 'zone'));
$('draw-polygon').addEventListener('click', () => drawer.setMode(drawer.mode === 'polygon' ? null : 'polygon', 'zone'));
$('draw-finish').addEventListener('click', () => drawer.finish());
$('draw-cancel').addEventListener('click', () => drawer.cancel());

$('zone-export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(zones.exportAll(), null, 2)], { type: 'application/geo+json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'flysdown-zones.geojson';
  link.click();
  URL.revokeObjectURL(url);
});

$('zone-import').addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const added = zones.importFeatures(JSON.parse(await file.text()));
    ui.setStatus(added ? `Imported ${added} zone${added === 1 ? '' : 's'}.` : 'No usable Point or Polygon features in that file.');
    tick();
  } catch (err) {
    ui.setStatus(`Could not read that file: ${err.message}`);
  }
  event.target.value = '';
});

/* ---------- controls ---------- */

const filterInputs = {
  aircraft: 'f-aircraft',
  vessels: 'f-vessels',
  trails: 'f-trails',
  labels: 'f-labels',
  ground: 'f-ground',
  military: 'f-military',
  alertsOnly: 'f-alerts',
  approaches: 'f-approach',
};

for (const [key, id] of Object.entries(filterInputs)) {
  $(id).addEventListener('change', (event) => {
    state.filters[key] = event.target.checked;
    tick();
  });
}

$('cpa-limit').addEventListener('input', (event) => {
  state.cpaAlertNm = Number(event.target.value);
  $('cpa-out').textContent = `${state.cpaAlertNm.toFixed(2).replace(/0$/, '')} NM`;
  tick();
});

$('horizon').addEventListener('input', (event) => {
  state.horizonSec = Number(event.target.value) * 60;
  $('horizon-out').textContent = `${event.target.value} min`;
  tick();
});

$('region-select').addEventListener('change', (event) => {
  const region = REGIONS[event.target.value];
  if (region) mapView.flyTo(region.center, region.zoom);
});

/** Each feed pauses on its own: freeze the planes, keep the ships running. */
function setFeedPaused(kind, paused) {
  state.paused[kind] = paused;
  if (paused) feeds[kind].stop();
  else feeds[kind].start();
  ui.renderFeedToggles(state.paused, state.feeds);
  updateStatusLine();
}

ui.on('toggleFeed', (kind) => setFeedPaused(kind, !state.paused[kind]));

ui.on('frameRoute', (key) => {
  const target = store.get(key);
  const entry = routeFor(target);
  if (!target) return;
  const points = [[target.lon, target.lat], ...state.track.points];
  if (entry?.status === 'ok') {
    const { origin, destination } = entry.route;
    if (origin) points.push([origin.lon, origin.lat]);
    if (destination) points.push([destination.lon, destination.lat]);
  }
  mapView.fitPoints(points);
});

ui.on('removeTrackingArea', (id) => removeTrackingArea(id));
ui.on('zoomTrackingArea', (id) => {
  const area = state.tracking.find((a) => a.id === id);
  if (!area) return;
  mapView.flyTo([area.center.lon, area.center.lat], Math.max(5, Math.min(11, 10.5 - Math.log2(Math.max(1, area.radiusNm)))));
});

$('toggle-table').addEventListener('click', () => {
  ui.renderTable(visibleTargets());
  $('table-dialog').showModal();
});
$('table-close').addEventListener('click', () => $('table-dialog').close());

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!$('welcome').hidden) {
    ui.hideWelcome();
    return;
  }
  if (drawer.mode) {
    drawer.cancel();
    return;
  }
  if (state.selectedKey) selectTarget(null);
});

/* ---------- welcome, help and navigation ---------- */

ui.initNavigation();

// Drawing needs the map visible; on a phone the Areas view covers it.
for (const id of ['track-circle', 'track-box', 'draw-circle', 'draw-polygon']) {
  $(id).addEventListener('click', () => {
    if (window.matchMedia('(max-width: 1040px)').matches && drawer.mode) ui.setView('map');
  });
}

// A selection made on a phone should be seen: it arrives as a sheet over the
// map, so make sure the map view is the one showing.
ui.on('leftMap', () => drawer.cancel());

$('help-btn').addEventListener('click', () => ui.showWelcome());

for (const button of document.querySelectorAll('#welcome [data-start]')) {
  button.addEventListener('click', () => {
    const remember = $('welcome-remember').checked;
    ui.hideWelcome({ remember });
    const start = button.dataset.start;
    if (start === 'dc' || start === 'gof') {
      $('region-select').value = start;
      mapView.flyTo(REGIONS[start].center, REGIONS[start].zoom);
    }
  });
}

$('welcome').addEventListener('click', (event) => {
  // Clicking the dim backdrop, not the card, closes it without remembering.
  if (event.target === $('welcome')) ui.hideWelcome();
});

/* ---------- boot ---------- */

zones.onChange(() => {
  if (mapView.ready) render();
});

/** Is this file older than the HTML that loaded it? See BUILD_STAMP. */
function checkBuildStamp() {
  const deployed = document.querySelector('meta[name="build"]')?.getAttribute('content') || '';
  state.staleBuild = deployed && deployed !== BUILD_STAMP ? deployed : null;
  return state.staleBuild;
}

(async function boot() {
  // First thing, before any network round trip: a first-time visitor should
  // not stare at an unexplained map while the zone file downloads.
  if (!UI.hasBeenWelcomed()) ui.showWelcome();
  checkBuildStamp();
  requestHash(readHash());
  loadTracking();
  ui.renderFeedToggles(state.paused, state.feeds);
  ui.renderTracking(state.tracking, MAX_TRACKING_AREAS);
  try {
    await zones.loadSeeded();
  } catch (err) {
    ui.setStatus(`Could not load zone data: ${err.message}`);
  }
  applyQueries();
  feeds.aircraft.start();
  feeds.vessels.start();
  ui.setStatus('Waiting for the first feed update');
})();

// Handy for poking at live state from the console.
window.flysdown = { state, store, zones, feeds, mapView, ui, tick, applyQueries, routes, buildRouteLegs, routeFit, checkBuildStamp, BUILD_STAMP, hashFor, readHash, requestHash };
