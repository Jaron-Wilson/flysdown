/**
 * Map layer: owns the MapLibre instance, the generated icons and every
 * GeoJSON source. It takes already-filtered, already-evaluated state and
 * renders it; it holds no application state of its own beyond the selection
 * highlight, so the render path stays a pure function of what it is handed.
 */

import { INK, altitudeBand, ALTITUDE_BANDS, GROUND_COLOR, VESSEL_UNDERWAY, VESSEL_STATIC, SEVERITY, zoneStyle } from './palette.js';
import { circleRing } from './geo.js';
import { targetAgeSec } from './feeds.js';

const ICON_SIZE = 44;
const PLANE = [[22, 3], [25, 16], [40, 26], [40, 30], [25, 24], [24, 35], [30, 39], [30, 41], [22, 38], [14, 41], [14, 39], [20, 35], [19, 24], [4, 30], [4, 26], [19, 16]];
const SHIP = [[22, 4], [30, 16], [30, 35], [26, 40], [18, 40], [14, 35], [14, 16]];

const EMPTY = { type: 'FeatureCollection', features: [] };

function iconFromPath(points, color, { round = false } = {}) {
  const canvas = document.createElement('canvas');
  canvas.width = ICON_SIZE;
  canvas.height = ICON_SIZE;
  const ctx = canvas.getContext('2d');

  ctx.beginPath();
  if (round) {
    ctx.arc(ICON_SIZE / 2, ICON_SIZE / 2, 9, 0, Math.PI * 2);
  } else {
    points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }
  // Dark casing first so a light icon still reads over a light coastline.
  ctx.lineJoin = 'round';
  ctx.strokeStyle = 'rgba(6,6,8,0.92)';
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fill();

  return { width: ICON_SIZE, height: ICON_SIZE, data: ctx.getImageData(0, 0, ICON_SIZE, ICON_SIZE).data };
}

export const iconForAircraft = (target) => {
  if (target.track === null || target.track === undefined) return 'plane-nohdg';
  if (target.onGround) return 'plane-ground';
  return `plane-${Math.max(0, altitudeBand(target.alt, false).index)}`;
};

export const iconForVessel = (target) => {
  const course = target.cog ?? target.heading;
  if (course === null || course === undefined) return 'ship-nohdg';
  return target.sog && target.sog > 0.5 ? 'ship-underway' : 'ship-static';
};

export class MapView {
  constructor(container, { onSelect, onHover, onViewChange, onZoneClick }) {
    this.onSelect = onSelect;
    this.onHover = onHover;
    this.onViewChange = onViewChange;
    this.onZoneClick = onZoneClick;
    this.ready = false;

    this.map = new maplibregl.Map({
      container,
      // OpenFreeMap serves OpenStreetMap-derived vector tiles with no API key
      // and no rate limit, and ships a dark style. CARTO's anonymous raster
      // tiles now carry an "API KEY REQUIRED" watermark, so they are out.
      style: 'https://tiles.openfreemap.org/styles/dark',
      center: [-77.0369, 38.9072],
      zoom: 8.2,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
    });

    this.map.addControl(
      new maplibregl.AttributionControl({
        compact: true,
        // The style already credits OpenFreeMap, OpenMapTiles and OSM.
        // adsb.fi's usage policy requires a citation with a link to its home
        // page; adsb.lol publishes its data under ODbL 1.0; Digitraffic is
        // CC BY 4.0. All three are credited here.
        customAttribution:
          'ADS-B <a href="https://adsb.fi">adsb.fi</a> and <a href="https://adsb.lol">adsb.lol</a>, ' +
          'AIS <a href="https://www.digitraffic.fi">Fintraffic Digitraffic</a> CC BY 4.0, airspace FAA',
      }),
      'bottom-right'
    );
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-left');

    this.map.on('load', () => {
      this.installIcons();
      this.installLayers();
      this.ready = true;
      this.onViewChange?.(this.viewport());
    });

    let moveTimer = null;
    this.map.on('moveend', () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => this.onViewChange?.(this.viewport()), 250);
    });
  }

  installIcons() {
    ALTITUDE_BANDS.forEach((band, i) => this.map.addImage(`plane-${i}`, iconFromPath(PLANE, band.color), { pixelRatio: 2 }));
    this.map.addImage('plane-ground', iconFromPath(PLANE, GROUND_COLOR), { pixelRatio: 2 });
    this.map.addImage('plane-nohdg', iconFromPath(PLANE, GROUND_COLOR, { round: true }), { pixelRatio: 2 });
    this.map.addImage('ship-underway', iconFromPath(SHIP, VESSEL_UNDERWAY), { pixelRatio: 2 });
    this.map.addImage('ship-static', iconFromPath(SHIP, VESSEL_STATIC), { pixelRatio: 2 });
    this.map.addImage('ship-nohdg', iconFromPath(SHIP, VESSEL_STATIC, { round: true }), { pixelRatio: 2 });
  }

  addSource(id, data = EMPTY) {
    this.map.addSource(id, { type: 'geojson', data });
  }

  installLayers() {
    for (const id of ['zones', 'zone-labels', 'coverage', 'tracking', 'tracking-labels', 'approaches', 'route-legs', 'route-airports', 'selected-track', 'trails', 'projections', 'entry-points', 'alert-rings', 'vessels', 'aircraft', 'selection']) {
      this.addSource(id);
    }

    this.map.addLayer({
      id: 'zone-fill',
      type: 'fill',
      source: 'zones',
      paint: { 'fill-color': ['get', 'color'], 'fill-opacity': ['get', 'fillOpacity'] },
    });

    // One outline layer per kind: line-dasharray cannot be data-driven, and the
    // dash pattern is load-bearing here (it carries zone kind for CVD readers).
    for (const [kind, style] of Object.entries({
      prohibited: zoneStyle('prohibited'),
      tfr: zoneStyle('tfr'),
      restricted: zoneStyle('restricted'),
      sfra: zoneStyle('sfra'),
      custom: zoneStyle('custom'),
    })) {
      this.map.addLayer({
        id: `zone-outline-${kind}`,
        type: 'line',
        source: 'zones',
        filter: ['==', ['get', 'kind'], kind],
        paint: {
          'line-color': style.color,
          'line-width': ['case', ['get', 'breached'], style.width + 1.5, style.width],
          'line-dasharray': style.dash,
        },
      });
    }

    this.map.addLayer({
      id: 'coverage-ring',
      type: 'line',
      source: 'coverage',
      paint: { 'line-color': INK.muted, 'line-width': 1, 'line-dasharray': [4, 4], 'line-opacity': 0.7 },
    });

    // Pinned tracking areas: deliberately neutral, so they never read as a
    // restriction. They are an instruction to the loader, not a hazard.
    this.map.addLayer({
      id: 'tracking-fill',
      type: 'fill',
      source: 'tracking',
      paint: { 'fill-color': INK.secondary, 'fill-opacity': 0.05 },
    });

    this.map.addLayer({
      id: 'tracking-outline',
      type: 'line',
      source: 'tracking',
      paint: { 'line-color': INK.secondary, 'line-width': 1.6, 'line-dasharray': [5, 3], 'line-opacity': 0.85 },
    });

    this.map.addLayer({
      id: 'tracking-label-text',
      type: 'symbol',
      source: 'tracking-labels',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'text-anchor': 'top',
        'text-offset': [0, 0.4],
        'text-allow-overlap': false,
      },
      paint: { 'text-color': INK.secondary, 'text-halo-color': INK.page, 'text-halo-width': 1.4 },
    });

    // Vessel close approaches: a line between the pair at risk.
    this.map.addLayer({
      id: 'approach-lines',
      type: 'line',
      source: 'approaches',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 2,
        'line-dasharray': [1, 1.5],
        'line-opacity': 0.95,
      },
    });

    // The selected flight's route: where it came from, where it is going.
    this.map.addLayer({
      id: 'route-leg-lines',
      type: 'line',
      source: 'route-legs',
      paint: {
        'line-color': ['case', ['==', ['get', 'leg'], 'flown'], '#6da7ec', '#9ec5f4'],
        'line-width': 1.6,
        'line-dasharray': ['case', ['==', ['get', 'leg'], 'flown'], ['literal', [1, 0]], ['literal', [4, 3]]],
        'line-opacity': 0.75,
      },
    });

    this.map.addLayer({
      id: 'route-airport-dots',
      type: 'circle',
      source: 'route-airports',
      paint: {
        'circle-radius': 4.5,
        'circle-color': INK.page,
        'circle-stroke-color': '#9ec5f4',
        'circle-stroke-width': 2,
      },
    });

    this.map.addLayer({
      id: 'route-airport-labels',
      type: 'symbol',
      source: 'route-airports',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-anchor': 'top',
        'text-offset': [0, 0.7],
        'text-allow-overlap': true,
      },
      paint: { 'text-color': '#cde2fb', 'text-halo-color': INK.page, 'text-halo-width': 1.5 },
    });

    // The observed track of the selected target, which keeps growing.
    this.map.addLayer({
      id: 'selected-track-line',
      type: 'line',
      source: 'selected-track',
      paint: { 'line-color': INK.primary, 'line-width': 2, 'line-opacity': 0.85 },
    });

    this.map.addLayer({
      id: 'trail-lines',
      type: 'line',
      source: 'trails',
      paint: {
        'line-color': ['case', ['==', ['get', 'kind'], 'vessel'], VESSEL_UNDERWAY, '#3987e5'],
        'line-width': 1.5,
        'line-opacity': 0.45,
      },
    });

    this.map.addLayer({
      id: 'projection-lines',
      type: 'line',
      source: 'projections',
      paint: {
        'line-color': ['get', 'color'],
        'line-width': 2,
        'line-dasharray': [2, 2],
        'line-opacity': 0.9,
      },
    });

    this.map.addLayer({
      id: 'entry-markers',
      type: 'circle',
      source: 'entry-points',
      paint: {
        'circle-radius': 4,
        'circle-color': ['get', 'color'],
        'circle-stroke-color': INK.page,
        'circle-stroke-width': 1.5,
      },
    });

    this.map.addLayer({
      id: 'alert-rings',
      type: 'circle',
      source: 'alert-rings',
      paint: {
        'circle-radius': 13,
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': ['get', 'color'],
        'circle-stroke-width': 2,
      },
    });

    this.map.addLayer({
      id: 'selection-ring',
      type: 'circle',
      source: 'selection',
      paint: {
        'circle-radius': 18,
        'circle-color': 'rgba(255,255,255,0.06)',
        'circle-stroke-color': INK.primary,
        'circle-stroke-width': 1.5,
      },
    });

    this.map.addLayer({
      id: 'vessel-icons',
      type: 'symbol',
      source: 'vessels',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-rotate': ['get', 'rotation'],
        'icon-rotation-alignment': 'map',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.5, 10, 0.75, 14, 0.95],
        'icon-allow-overlap': true,
      },
      paint: {
        // A contact that has not reported for a while fades, so a stale
        // picture is visible as a stale picture.
        'icon-opacity': ['interpolate', ['linear'], ['get', 'ageSec'], 45, 1, 240, 0.3],
      },
    });

    this.map.addLayer({
      id: 'aircraft-icons',
      type: 'symbol',
      source: 'aircraft',
      layout: {
        'icon-image': ['get', 'icon'],
        'icon-rotate': ['get', 'rotation'],
        'icon-rotation-alignment': 'map',
        'icon-size': ['interpolate', ['linear'], ['zoom'], 5, 0.55, 10, 0.8, 14, 1],
        'icon-allow-overlap': true,
      },
      paint: {
        // A contact that has not reported for a while fades, so a stale
        // picture is visible as a stale picture.
        'icon-opacity': ['interpolate', ['linear'], ['get', 'ageSec'], 45, 1, 240, 0.3],
      },
    });

    this.map.addLayer({
      id: 'zone-label-text',
      type: 'symbol',
      source: 'zone-labels',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 11,
        'text-anchor': 'center',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': ['get', 'color'],
        'text-halo-color': INK.page,
        'text-halo-width': 1.4,
      },
    });

    this.map.addLayer({
      id: 'target-labels',
      type: 'symbol',
      source: 'aircraft',
      minzoom: 8.5,
      layout: {
        'text-field': ['get', 'label'],
        'text-font': ['Noto Sans Regular'],
        'text-size': 10,
        'text-offset': [0, 1.3],
        'text-anchor': 'top',
        'text-allow-overlap': false,
        'text-optional': true,
      },
      paint: {
        'text-color': INK.secondary,
        'text-halo-color': INK.page,
        'text-halo-width': 1.4,
      },
    });

    const pickable = ['aircraft-icons', 'vessel-icons'];

    /**
     * In a busy harbor or a stack of arrivals several icons overlap the same
     * pixel. queryRenderedFeatures returns them in draw order, which means the
     * topmost wins and that is not necessarily the one under the cursor. Pick
     * the closest one instead, so clicking does what it looks like it will do.
     */
    const nearestHit = (point) => {
      const hits = this.map.queryRenderedFeatures(point, { layers: pickable });
      if (hits.length < 2) return hits[0];
      let best = hits[0];
      let bestDistance = Infinity;
      for (const hit of hits) {
        const [lon, lat] = hit.geometry.coordinates;
        const projected = this.map.project([lon, lat]);
        const distance = (projected.x - point.x) ** 2 + (projected.y - point.y) ** 2;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = hit;
        }
      }
      return best;
    };

    this.map.on('click', (event) => {
      const hit = nearestHit(event.point);
      if (hit) {
        this.onSelect?.(hit.properties.key);
        return;
      }
      const zoneHits = this.map.queryRenderedFeatures(event.point, { layers: ['zone-fill'] });
      if (zoneHits.length) {
        this.onZoneClick?.(zoneHits[0].properties.id);
        return;
      }
      this.onSelect?.(null);
    });

    this.map.on('mousemove', (event) => {
      const hit = nearestHit(event.point);
      this.map.getCanvas().style.cursor = hit ? 'pointer' : '';
      this.onHover?.(hit ? hit.properties : null, event.point);
    });
  }

  viewport() {
    const center = this.map.getCenter();
    const bounds = this.map.getBounds();
    const corner = bounds.getNorthEast();
    const R = 3440.065;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(corner.lat - center.lat);
    const dLon = toRad(corner.lng - center.lng);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(center.lat)) * Math.cos(toRad(corner.lat)) * Math.sin(dLon / 2) ** 2;
    const radiusNm = 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
    return { center, radiusNm, zoom: this.map.getZoom() };
  }

  setData(id, features) {
    const source = this.map.getSource(id);
    if (source) source.setData({ type: 'FeatureCollection', features });
  }

  /** One render pass. Everything here is derived state handed in by app.js. */
  render(state) {
    if (!this.ready) return;
    const { aircraft, vessels, zones, zoneAlertCounts, projections, alerts, approaches, trackingAreas, selectedTrack, routeLegs, selectedKey, coverage, showLabels } = state;

    this.setData('aircraft', aircraft.map((t) => ({
      type: 'Feature',
      properties: {
        key: t.key,
        kind: 'aircraft',
        label: t.label,
        icon: iconForAircraft(t),
        rotation: t.track ?? 0,
        alt: t.alt ?? null,
        onGround: t.onGround,
        speed: t.groundSpeed ?? null,
        ageSec: Math.round(targetAgeSec(t)),
      },
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
    })));

    this.setData('vessels', vessels.map((t) => ({
      type: 'Feature',
      properties: {
        key: t.key,
        kind: 'vessel',
        label: t.label,
        icon: iconForVessel(t),
        rotation: t.heading ?? t.cog ?? 0,
        speed: t.sog ?? null,
        typeDesc: t.typeDesc || null,
        navStatus: t.navStatusDesc || null,
        ageSec: Math.round(targetAgeSec(t)),
      },
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
    })));

    this.map.setLayoutProperty('target-labels', 'visibility', showLabels ? 'visible' : 'none');

    const zoneFeatures = [];
    const zoneLabels = [];
    for (const zone of zones) {
      const style = zoneStyle(zone.kind);
      const hit = zoneAlertCounts.get(zone.id);
      const breached = Boolean(hit);
      zoneFeatures.push({
        type: 'Feature',
        properties: {
          id: zone.id,
          kind: zone.kind,
          color: style.color,
          fillOpacity: breached ? 0.22 : 0.08,
          breached,
        },
        geometry: { type: 'Polygon', coordinates: [zone.ring] },
      });
      zoneLabels.push({
        type: 'Feature',
        properties: {
          id: zone.id,
          color: style.color,
          label: hit ? `${zone.name}  (${hit.count})` : zone.name,
        },
        geometry: { type: 'Point', coordinates: [zone.center.lon, zone.center.lat] },
      });
    }
    this.setData('zones', zoneFeatures);
    this.setData('zone-labels', zoneLabels);

    this.setData('projections', projections.map((p) => ({
      type: 'Feature',
      properties: { key: p.key, color: SEVERITY[p.severity]?.color || INK.muted },
      geometry: { type: 'LineString', coordinates: p.coords },
    })));

    this.setData('entry-points', projections.filter((p) => p.entry).map((p) => ({
      type: 'Feature',
      properties: { key: p.key, color: SEVERITY[p.severity]?.color || INK.muted },
      geometry: { type: 'Point', coordinates: p.entry },
    })));

    const worstByTarget = new Map();
    for (const alert of alerts) {
      const current = worstByTarget.get(alert.targetId);
      if (!current || SEVERITY[alert.severity].rank > SEVERITY[current].rank) {
        worstByTarget.set(alert.targetId, alert.severity);
      }
    }
    const ringFeatures = [];
    for (const target of [...aircraft, ...vessels]) {
      const severity = worstByTarget.get(target.id);
      if (!severity) continue;
      ringFeatures.push({
        type: 'Feature',
        properties: { key: target.key, color: SEVERITY[severity].color },
        geometry: { type: 'Point', coordinates: [target.lon, target.lat] },
      });
    }
    this.setData('alert-rings', ringFeatures);

    const selected = [...aircraft, ...vessels].find((t) => t.key === selectedKey);
    this.setData('selection', selected
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [selected.lon, selected.lat] } }]
      : []);

    const trackingFeatures = [];
    const trackingLabels = [];
    for (const area of trackingAreas || []) {
      const ring = area.shape === 'box'
        ? [
            [area.bounds.west, area.bounds.south],
            [area.bounds.east, area.bounds.south],
            [area.bounds.east, area.bounds.north],
            [area.bounds.west, area.bounds.north],
            [area.bounds.west, area.bounds.south],
          ]
        : circleRing(area.center.lat, area.center.lon, area.radiusNm, 96);

      trackingFeatures.push({
        type: 'Feature',
        properties: { id: area.id },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
      trackingLabels.push({
        type: 'Feature',
        properties: {
          id: area.id,
          label: area.shape === 'box'
            ? 'tracking area'
            : `tracking area, ${area.radiusNm < 10 ? area.radiusNm.toFixed(1) : Math.round(area.radiusNm)} NM`,
        },
        geometry: { type: 'Point', coordinates: [area.center.lon, area.center.lat] },
      });
    }
    this.setData('tracking', trackingFeatures);
    this.setData('tracking-labels', trackingLabels);

    this.setData('approaches', (approaches || []).map((approach) => ({
      type: 'Feature',
      properties: { id: approach.id, color: SEVERITY[approach.severity]?.color || INK.muted },
      geometry: {
        type: 'LineString',
        coordinates: approach.pair.map((p) => [p.lon, p.lat]),
      },
    })));

    this.setData('route-legs', (routeLegs || []).map((leg) => ({
      type: 'Feature',
      properties: { leg: leg.leg },
      geometry: { type: 'LineString', coordinates: leg.coords },
    })));

    this.setData('route-airports', (routeLegs || []).filter((leg) => leg.airport).map((leg) => ({
      type: 'Feature',
      properties: {
        label: `${leg.airport.icao || leg.airport.iata || ''}${leg.airport.municipality ? ` ${leg.airport.municipality}` : ''}`.trim(),
      },
      geometry: { type: 'Point', coordinates: [leg.airport.lon, leg.airport.lat] },
    })));

    this.setData('selected-track', selectedTrack && selectedTrack.length > 1
      ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: selectedTrack } }]
      : []);

    this.setData('coverage', coverage
      ? [{
          type: 'Feature',
          properties: {},
          geometry: { type: 'LineString', coordinates: circleRing(coverage.lat, coverage.lon, coverage.radiusNm, 96) },
        }]
      : []);
  }

  flyTo(center, zoom) {
    this.map.flyTo({ center: center, zoom, speed: 1.4 });
  }

  panTo(lon, lat) {
    this.map.easeTo({ center: [lon, lat], duration: 600 });
  }

  /** Fit a set of [lon, lat] points, used to frame a whole flight route. */
  fitPoints(points, padding = 80) {
    if (!points?.length) return;
    const bounds = points.reduce(
      (acc, [lon, lat]) => acc.extend([lon, lat]),
      new maplibregl.LngLatBounds(points[0], points[0])
    );
    this.map.fitBounds(bounds, { padding, duration: 900, maxZoom: 9 });
  }
}
