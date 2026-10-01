/**
 * Optional map layers: airspace context, weather and charts.
 *
 * None of these alert. They are drawn under the live data for context; the
 * zones that do alert (prohibited areas, TFRs, custom watches) are the zone
 * store's business, not this module's.
 *
 * Every source here is keyless and was fetched and checked before being
 * listed (2026-10-01): status, CORS where the browser needs it, and which
 * zoom levels actually carry imagery.
 */

import { INK } from './palette.js';

export const LAYERS_KEY = 'flysdown.layers.v1';
export const DEFAULT_LAYERS = ['sua'];

// nowCOAST is a WMS; MapLibre fills {bbox-epsg-3857} per tile.
const wms = (service, layer) =>
  `https://nowcoast.noaa.gov/geoserver/${service}/wms?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=${layer}` +
  '&STYLES=&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true';

/**
 * Special use airspace types, drawn by color, dash and label together: the
 * colors alone do not separate under every color-vision deficiency, so a
 * reader can always fall back on the outline pattern and the name.
 * Red stays reserved for prohibited areas and TFRs, which alert.
 */
export const SUA_STYLE = {
  R: { color: '#fab219', dash: [6, 2], label: 'Restricted' },
  MOA: { color: '#b07ad9', dash: [2, 2], label: 'MOA' },
  W: { color: '#4fb3a9', dash: [8, 3], label: 'Warning' },
  A: { color: '#c9a56b', dash: [1, 2], label: 'Alert' },
  D: { color: '#c9a56b', dash: [4, 4], label: 'Danger' },
  NSA: { color: '#e07fb5', dash: [3, 1], label: 'National security area' },
};

export const LAYER_DEFS = [
  {
    id: 'sua',
    group: 'Airspace',
    label: 'Special use airspace',
    hint: 'Restricted, MOA, warning, alert and national security areas. Drawn, not alerted: most are active only at set hours or by NOTAM.',
    kind: 'sua',
    url: 'data/sua.json',
    attribution: 'Special use airspace FAA',
  },
  {
    id: 'artcc',
    group: 'Airspace',
    label: 'ARTCC boundaries',
    hint: 'Air route traffic control centers.',
    kind: 'lines',
    url: 'data/artcc.json',
    color: INK.muted,
    dash: [6, 3],
    labelField: 'name',
    attribution: 'ARTCC boundaries FAA',
  },
  {
    id: 'a2a',
    group: 'Airspace',
    label: 'Air-to-air refueling tracks',
    hint: 'US military refueling tracks and anchors, from tar1090.',
    kind: 'lines',
    url: 'https://cdn.jsdelivr.net/gh/wiedehopf/tar1090@master/html/geojson/US_A2A_refueling.geojson',
    color: '#7fb0d9',
    dash: [2, 2],
    labelField: 'name',
    attribution: 'A2A refueling <a href="https://github.com/wiedehopf/tar1090">tar1090</a>',
  },
  {
    id: 'nexrad',
    group: 'Weather',
    label: 'NEXRAD radar',
    hint: 'Iowa Environmental Mesonet composite, every 5 minutes.',
    kind: 'raster',
    tiles: ['1', '2', '3'].map((n) => `https://mesonet${n}.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-900913/{z}/{x}/{y}.png`),
    maxzoom: 10,
    opacity: 0.65,
    refreshMs: 2 * 60 * 1000,
    attribution: 'NEXRAD <a href="https://mesonet.agron.iastate.edu">IEM</a>',
  },
  {
    id: 'noaa-radar',
    group: 'Weather',
    label: 'NOAA radar mosaic',
    hint: 'NOAA nowCOAST base reflectivity (MRMS).',
    kind: 'raster',
    tiles: [wms('weather_radar', 'base_reflectivity_mosaic')],
    opacity: 0.65,
    refreshMs: 5 * 60 * 1000,
    attribution: 'Radar <a href="https://nowcoast.noaa.gov">NOAA nowCOAST</a>',
  },
  {
    id: 'ir-sat',
    group: 'Weather',
    label: 'Infrared satellite',
    hint: 'NOAA nowCOAST longwave infrared, global.',
    kind: 'raster',
    tiles: [wms('satellite', 'global_longwave_imagery_mosaic')],
    opacity: 0.5,
    refreshMs: 15 * 60 * 1000,
    attribution: 'Satellite <a href="https://nowcoast.noaa.gov">NOAA nowCOAST</a>',
  },
  {
    id: 'ifr-high',
    group: 'Charts',
    label: 'IFR enroute high chart',
    hint: 'FAA chart, opaque. Imagery exists only from zoom 7 to 9, so it shows when zoomed in and is enlarged beyond that.',
    kind: 'raster',
    // ArcGIS tile order is z/y/x. Zooms 5-6 are blank white and 10+ 404, so
    // the source is clamped to where there is a chart and MapLibre overzooms.
    tiles: ['https://tiles.arcgis.com/tiles/ssFJjBXIUyZDrSYZ/arcgis/rest/services/IFR_High/MapServer/tile/{z}/{y}/{x}'],
    minzoom: 7,
    maxzoom: 9,
    opacity: 0.9,
    attribution: 'IFR chart FAA',
  },
];

export const layerDef = (id) => LAYER_DEFS.find((d) => d.id === id) || null;

/** Saved choice, or the default. Unknown ids from an older build are dropped. */
export function loadLayerChoice(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(LAYERS_KEY) || 'null');
    if (Array.isArray(saved)) return saved.filter((id) => layerDef(id));
  } catch {
    // Treated as no choice.
  }
  return [...DEFAULT_LAYERS];
}

export function saveLayerChoice(ids, storage = globalThis.localStorage) {
  try {
    storage?.setItem(LAYERS_KEY, JSON.stringify(ids));
  } catch {
    // Private browsing: the choice lasts this visit.
  }
}

/** Cache-busted tile URLs, so a refresh actually fetches new imagery. */
export function bustTiles(tiles, now = Date.now()) {
  return tiles.map((url) => `${url}${url.includes('?') ? '&' : '?'}_=${Math.floor(now / 60000)}`);
}

/** "18000" FT MSL, "180" FL, "0" SFC -> a short readable limit. */
export function formatLimit(value, uom, code) {
  if (code === 'SFC' || code === 'GND') return 'surface';
  if (value === null || value === undefined || value === '' || Number(value) < 0) return 'unspecified';
  if (uom === 'FL') return `FL${String(value).padStart(3, '0')}`;
  const n = Number(value);
  const ft = Number.isFinite(n) ? n.toLocaleString('en-US') : value;
  return `${ft} ft${code === 'HEI' || code === 'AGL' ? ' AGL' : ' MSL'}`;
}

/** The popup text for one special use area. */
export function describeSua(p) {
  const lines = [
    `${p.name} · ${p.typeLabel || p.type}`,
    `${p.floor} to ${p.ceiling}`,
    `Hours: ${p.hours}`,
  ];
  if (p.agency) lines.push(`Controlled by ${p.agency}`);
  if (p.remarks) lines.push(p.remarks);
  return lines;
}

/**
 * Adds and removes the layers on a MapLibre map. Everything is inserted
 * beneath `beforeId`, the first of the app's own layers, so live targets,
 * alerting zones and projections always draw on top.
 */
export class Overlays {
  constructor(map, { beforeId, onError } = {}) {
    this.map = map;
    this.beforeId = beforeId;
    this.onError = onError;
    this.on = new Set();
    this.timers = new Map();
  }

  isOn(id) {
    return this.on.has(id);
  }

  set(id, visible) {
    const def = layerDef(id);
    if (!def || !this.map.getStyle()) return;
    if (visible) this.show(def);
    else this.hide(def);
  }

  layerIds(def) {
    if (def.kind === 'raster') return [`ov-${def.id}`];
    if (def.kind === 'sua') return ['ov-sua-fill', ...Object.keys(SUA_STYLE).map((t) => `ov-sua-line-${t}`), 'ov-sua-label'];
    return [`ov-${def.id}-line`, `ov-${def.id}-label`];
  }

  show(def) {
    if (this.on.has(def.id)) return;
    this.on.add(def.id);
    const sourceId = `ov-${def.id}`;
    const before = this.map.getLayer(this.beforeId) ? this.beforeId : undefined;

    if (!this.map.getSource(sourceId)) {
      if (def.kind === 'raster') {
        this.map.addSource(sourceId, {
          type: 'raster',
          tiles: def.refreshMs ? bustTiles(def.tiles) : def.tiles,
          tileSize: 256,
          ...(def.minzoom !== undefined ? { minzoom: def.minzoom } : {}),
          ...(def.maxzoom !== undefined ? { maxzoom: def.maxzoom } : {}),
          attribution: def.attribution,
        });
      } else {
        this.map.addSource(sourceId, { type: 'geojson', data: def.url, attribution: def.attribution });
      }
    }

    if (def.kind === 'raster') {
      this.map.addLayer({ id: `ov-${def.id}`, type: 'raster', source: sourceId, paint: { 'raster-opacity': def.opacity ?? 0.7 } }, before);
      if (def.refreshMs) {
        this.timers.set(def.id, setInterval(() => this.map.getSource(sourceId)?.setTiles?.(bustTiles(def.tiles)), def.refreshMs));
      }
    } else if (def.kind === 'sua') {
      const colorByType = ['match', ['get', 'type'], ...Object.entries(SUA_STYLE).flatMap(([t, s]) => [t, s.color]), INK.muted];
      this.map.addLayer({ id: 'ov-sua-fill', type: 'fill', source: sourceId, paint: { 'fill-color': colorByType, 'fill-opacity': 0.05 } }, before);
      // line-dasharray cannot be data-driven, so one line layer per type.
      for (const [type, style] of Object.entries(SUA_STYLE)) {
        this.map.addLayer({
          id: `ov-sua-line-${type}`,
          type: 'line',
          source: sourceId,
          filter: ['==', ['get', 'type'], type],
          paint: { 'line-color': style.color, 'line-width': 1.1, 'line-opacity': 0.75, 'line-dasharray': style.dash },
        }, before);
      }
      this.map.addLayer({
        id: 'ov-sua-label',
        type: 'symbol',
        source: sourceId,
        minzoom: 7.5,
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'symbol-placement': 'point', 'text-allow-overlap': false },
        paint: { 'text-color': colorByType, 'text-halo-color': INK.page, 'text-halo-width': 1.3, 'text-opacity': 0.85 },
      }, before);
    } else {
      this.map.addLayer({
        id: `ov-${def.id}-line`,
        type: 'line',
        source: sourceId,
        paint: { 'line-color': def.color, 'line-width': 1.2, 'line-opacity': 0.8, 'line-dasharray': def.dash || [1] },
      }, before);
      this.map.addLayer({
        id: `ov-${def.id}-label`,
        type: 'symbol',
        source: sourceId,
        minzoom: 6,
        layout: { 'text-field': ['coalesce', ['get', def.labelField], ['get', `${def.labelField} `], ''], 'text-font': ['Noto Sans Regular'], 'text-size': 10, 'symbol-placement': 'line', 'text-allow-overlap': false },
        paint: { 'text-color': def.color, 'text-halo-color': INK.page, 'text-halo-width': 1.3 },
      }, before);
    }
  }

  hide(def) {
    if (!this.on.has(def.id)) return;
    this.on.delete(def.id);
    clearInterval(this.timers.get(def.id));
    this.timers.delete(def.id);
    for (const id of this.layerIds(def)) if (this.map.getLayer(id)) this.map.removeLayer(id);
    // The source stays, so turning a layer back on does not download it again.
  }

  /** The special use area under a click, if that layer is on. */
  suaAt(point) {
    if (!this.on.has('sua') || !this.map.getLayer('ov-sua-fill')) return null;
    const hits = this.map.queryRenderedFeatures(point, { layers: ['ov-sua-fill'] });
    return hits.length ? hits.map((h) => h.properties) : null;
  }
}
