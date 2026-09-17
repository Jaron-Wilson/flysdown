/**
 * flysdown - application wiring.
 *
 * Pipeline, once per feed update:
 *
 *   poll -> normalise (edge) -> TargetStore (adds history)
 *        -> filters -> detection engine -> projections -> map + panels
 *
 * The detection engine and the geometry it uses are plain modules under js/,
 * deliberately free of DOM and map dependencies so the same rules can be moved
 * to a Worker cron later and alert without a browser open.
 */

import { Feed, TargetStore, viewportQuery, FEED_INTERVALS } from './js/feeds.js';
import { ZoneStore, prepareZone } from './js/zones.js';
import { evaluateAll, SEVERITY_RANK } from './js/detect.js';
import { projectPath, circleRing, distanceNm } from './js/geo.js';
import { MapView } from './js/map.js';
import { ZoneDrawer } from './js/draw.js';
import { UI, fmt } from './js/ui.js';

const REGIONS = {
  dc: { centre: [-77.0369, 38.9072], zoom: 8.2, label: 'Washington DC' },
  gof: { centre: [24.95, 59.95], zoom: 7.4, label: 'Gulf of Finland' },
  nyc: { centre: [-73.94, 40.72], zoom: 8.2, label: 'New York' },
  lon: { centre: [-0.12, 51.5], zoom: 8.0, label: 'London' },
  socal: { centre: [-117.92, 33.81], zoom: 8.6, label: 'Southern California' },
};

/** Where the keyless AIS provider actually has coverage. */
const AIS_COVERAGE = { minLat: 55, maxLat: 67, minLon: 14, maxLon: 36 };
const inAisCoverage = (lat, lon) =>
  lat >= AIS_COVERAGE.minLat && lat <= AIS_COVERAGE.maxLat && lon >= AIS_COVERAGE.minLon && lon <= AIS_COVERAGE.maxLon;

const $ = (id) => document.getElementById(id);

const state = {
  filters: { aircraft: true, vessels: true, trails: true, labels: true, ground: false, military: false, alertsOnly: false },
  horizonSec: 600,
  selectedKey: null,
  paused: false,
  coverage: null,
  feeds: { aircraft: { state: 'idle' }, vessels: { state: 'idle' } },
  evaluation: { alerts: [], byTarget: new Map(), zoneAlertCounts: new Map() },
  pendingGeometry: null,
};

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
  onComplete: (geometry) => openZoneForm(geometry),
  onModeChange: (mode) => {
    $('draw-circle').classList.toggle('active', mode === 'circle');
    $('draw-polygon').classList.toggle('active', mode === 'polygon');
    $('draw-finish').hidden = mode !== 'polygon';
    $('draw-cancel').hidden = !mode;
    ui.setDrawHint(
      mode === 'circle'
        ? 'Click the centre, then click again to set the radius.'
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
    intervalMs: FEED_INTERVALS.aircraft,
    onData: (json) => {
      state.coverage = json.coverage ? { lat: json.coverage.lat, lon: json.coverage.lon, radiusNm: json.coverage.distNm } : null;
      store.ingest('aircraft', json.aircraft, json.fetchedAt, state.coverage);
      tick();
    },
    onStatus: (name, status) => {
      state.feeds[name] = status;
      ui.renderFeedChips(state.feeds);
      updateStatusLine();
    },
  }),
  vessels: new Feed({
    name: 'vessels',
    endpoint: 'api/vessels',
    intervalMs: FEED_INTERVALS.vessels,
    onData: (json) => {
      const area = json.coverage && json.coverage.radiusKm
        ? { lat: json.coverage.lat, lon: json.coverage.lon, radiusNm: json.coverage.radiusKm / 1.852 }
        : null;
      store.ingest('vessel', json.vessels, json.fetchedAt, area);
      tick();
    },
    onStatus: (name, status) => {
      state.feeds[name] = status;
      ui.renderFeedChips(state.feeds);
      updateStatusLine();
    },
  }),
};

/* ---------- selection ---------- */

function selectTarget(key) {
  state.selectedKey = key;
  const target = key ? store.get(key) : null;
  ui.renderDetail(target, target ? state.evaluation.byTarget.get(target.id) : null);
  render();
}

ui.on('selectTarget', (key) => {
  selectTarget(key);
  const target = store.get(key);
  if (target) mapView.panTo(target.lon, target.lat);
});

ui.on('centreTarget', (key) => {
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
  mapView.flyTo([zone.centre.lon, zone.centre.lat], zoom);
});

ui.on('deleteZone', (id) => {
  const zone = zones.get(id);
  if (!zone) return;
  if (!window.confirm(`Delete the drawn zone "${zone.name}"?`)) return;
  zones.removeZone(id);
  tick();
});

/* ---------- view + feeds ---------- */

function handleViewChange(viewport) {
  const query = viewportQuery(viewport.centre, viewport.radiusNm);
  const aircraftChanged = feeds.aircraft.setQuery(query.aircraft);
  const vesselsChanged = feeds.vessels.setQuery(query.vessels);
  if (state.paused) return;
  if (aircraftChanged) feeds.aircraft.poll();
  if (vesselsChanged) feeds.vessels.poll();
}

function updateStatusLine() {
  const air = state.feeds.aircraft || {};
  const sea = state.feeds.vessels || {};
  const parts = [
    `ADS-B: ${air.state === 'live' ? `${air.source}, ${fmt.ago(air.lastSuccess)}` : air.state}`,
    `AIS: ${sea.state === 'live' ? `${sea.source}, ${fmt.ago(sea.lastSuccess)}` : sea.state}`,
    `horizon ${Math.round(state.horizonSec / 60)} min`,
  ];
  ui.setStatus(parts.join('  |  '));
}

/* ---------- the tick: evaluate then render ---------- */

function visibleTargets() {
  const targets = store.all().filter((target) => {
    if (target.kind === 'aircraft' && !state.filters.aircraft) return false;
    if (target.kind === 'vessel' && !state.filters.vessels) return false;
    if (!state.filters.ground && target.kind === 'aircraft' && target.onGround) return false;
    if (state.filters.military && target.kind === 'aircraft' && !(target.military || target.interesting)) return false;
    return true;
  });
  return targets;
}

function tick() {
  const activeZones = zones.all().filter((z) => z.enabled);
  const candidates = visibleTargets();
  state.evaluation = evaluateAll(candidates, activeZones, { horizonSec: state.horizonSec });

  if (state.selectedKey) {
    const target = store.get(state.selectedKey);
    ui.renderDetail(target, target ? state.evaluation.byTarget.get(target.id) : null);
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

  mapView.render({
    aircraft,
    vessels,
    zones: zones.all().filter((z) => z.enabled),
    zoneAlertCounts: state.evaluation.zoneAlertCounts,
    projections: buildProjections(shown),
    alerts: state.evaluation.alerts,
    selectedKey: state.selectedKey,
    coverage: state.filters.aircraft ? state.coverage : null,
    showLabels: state.filters.labels,
  });

  mapView.setData('trails', state.filters.trails
    ? [...(state.filters.aircraft ? store.trailFeatures('aircraft') : []), ...(state.filters.vessels ? store.trailFeatures('vessel') : [])]
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

  updateBanner(vessels.length);
}

/** Breached zones first, then whatever is nearest the current view. */
function sortedZones() {
  const centre = mapView.map.getCenter();
  const counts = state.evaluation.zoneAlertCounts;
  return zones.all()
    .map((zone) => ({
      zone,
      breached: counts.has(zone.id) ? 1 : 0,
      distanceNm: distanceNm(centre.lat, centre.lng, zone.centre.lat, zone.centre.lon),
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
  const centre = mapView.map.getCenter();

  if (state.filters.aircraft && air.state === 'down') {
    ui.showBanner(
      'ADS-B feed unavailable right now. The community aggregators rate-limit shared cloud addresses, so the edge proxy is being refused. Vessel data is unaffected.',
      null
    );
    return;
  }

  if (state.filters.aircraft && air.stale) {
    ui.showBanner(`Aircraft positions are ${Math.round(air.ageMs / 1000)} s old: the upstream is rate-limiting the edge, so this is the last good picture.`, null);
    return;
  }

  if (state.filters.vessels && vesselCount === 0 && !inAisCoverage(centre.lat, centre.lng)) {
    ui.showBanner('No AIS coverage in this view. The keyless AIS feed covers the Baltic and Gulf of Finland.', {
      label: 'Jump to coverage',
      onClick: () => {
        $('region-select').value = 'gof';
        mapView.flyTo(REGIONS.gof.centre, REGIONS.gof.zoom);
      },
    });
    return;
  }

  ui.showBanner(null);
}

/* ---------- zone drawing ---------- */

function openZoneForm(geometry) {
  state.pendingGeometry = geometry;
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
        centre: geometry.centre,
        ring: circleRing(geometry.centre.lat, geometry.centre.lon, geometry.radiusNm),
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

$('draw-circle').addEventListener('click', () => drawer.setMode(drawer.mode === 'circle' ? null : 'circle'));
$('draw-polygon').addEventListener('click', () => drawer.setMode(drawer.mode === 'polygon' ? null : 'polygon'));
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
};

for (const [key, id] of Object.entries(filterInputs)) {
  $(id).addEventListener('change', (event) => {
    state.filters[key] = event.target.checked;
    tick();
  });
}

$('horizon').addEventListener('input', (event) => {
  state.horizonSec = Number(event.target.value) * 60;
  $('horizon-out').textContent = `${event.target.value} min`;
  tick();
});

$('region-select').addEventListener('change', (event) => {
  const region = REGIONS[event.target.value];
  if (region) mapView.flyTo(region.centre, region.zoom);
});

$('pause-btn').addEventListener('click', () => {
  state.paused = !state.paused;
  const button = $('pause-btn');
  button.textContent = state.paused ? 'Resume' : 'Pause';
  button.setAttribute('aria-pressed', String(state.paused));
  if (state.paused) {
    feeds.aircraft.stop();
    feeds.vessels.stop();
  } else {
    feeds.aircraft.start();
    feeds.vessels.start();
  }
});

$('toggle-table').addEventListener('click', () => {
  ui.renderTable(visibleTargets());
  $('table-dialog').showModal();
});
$('table-close').addEventListener('click', () => $('table-dialog').close());

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (drawer.mode) {
    drawer.cancel();
    return;
  }
  if (state.selectedKey) selectTarget(null);
});

/* ---------- boot ---------- */

zones.onChange(() => {
  if (mapView.ready) render();
});

(async function boot() {
  ui.renderFeedChips(state.feeds);
  try {
    await zones.loadSeeded();
  } catch (err) {
    ui.setStatus(`Could not load zone data: ${err.message}`);
  }
  feeds.aircraft.start();
  feeds.vessels.start();
  ui.setStatus('Waiting for the first feed update');
})();

// Handy for poking at live state from the console.
window.flysdown = { state, store, zones, feeds, mapView, tick };
