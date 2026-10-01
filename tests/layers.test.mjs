import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Never import tools/fetch-airspace.mjs here: it fetches and writes on import.
import { LAYER_DEFS, DEFAULT_LAYERS, loadLayerChoice, saveLayerChoice, bustTiles, describeSua, SUA_STYLE, layerDef, formatLimit } from '../public/js/layers.js';

const memory = () => {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
};

test('every layer is fully described, with an attribution', () => {
  const ids = new Set();
  for (const def of LAYER_DEFS) {
    assert.ok(!ids.has(def.id), `duplicate ${def.id}`);
    ids.add(def.id);
    assert.ok(def.label && def.group && def.attribution, def.id);
    if (def.kind === 'raster') assert.ok(def.tiles?.length && def.tiles.every((t) => /^https:\/\//.test(t)), def.id);
    else assert.ok(def.url, def.id);
  }
  for (const id of DEFAULT_LAYERS) assert.ok(layerDef(id), id);
});

test('the IFR chart is clamped to the zooms that carry imagery, in z/y/x order', () => {
  const ifr = layerDef('ifr-high');
  assert.equal(ifr.minzoom, 7);
  assert.equal(ifr.maxzoom, 9);
  assert.match(ifr.tiles[0], /\{z\}\/\{y\}\/\{x\}$/);
});

test('layer choice persists, and ids from another build are dropped', () => {
  const storage = memory();
  assert.deepEqual(loadLayerChoice(storage), DEFAULT_LAYERS);
  saveLayerChoice(['nexrad', 'gone-layer'], storage);
  assert.deepEqual(loadLayerChoice(storage), ['nexrad']);
  saveLayerChoice([], storage);
  assert.deepEqual(loadLayerChoice(storage), []);
  storage.setItem('flysdown.layers.v1', 'not json');
  assert.deepEqual(loadLayerChoice(storage), DEFAULT_LAYERS);
});

test('tile cache-busting changes once a minute and keeps existing queries', () => {
  const [a] = bustTiles(['https://x/{z}/{x}/{y}.png'], 120_000);
  const [b] = bustTiles(['https://x/wms?LAYERS=a&BBOX={bbox-epsg-3857}'], 120_000);
  assert.equal(a, 'https://x/{z}/{x}/{y}.png?_=2');
  assert.equal(b, 'https://x/wms?LAYERS=a&BBOX={bbox-epsg-3857}&_=2');
});

test('published limits read the way a chart prints them', () => {
  assert.equal(formatLimit('0', 'FT', 'SFC'), 'surface');
  assert.equal(formatLimit('180', 'FL', 'STD'), 'FL180');
  assert.equal(formatLimit('50', 'FL', 'STD'), 'FL050');
  assert.equal(formatLimit('4500', 'FT', 'MSL'), '4,500 ft MSL');
  assert.equal(formatLimit('1500', 'FT', 'HEI'), '1,500 ft AGL');
  assert.equal(formatLimit('-9998', 'FT', 'MSL'), 'unspecified');
  assert.equal(formatLimit(null, null, null), 'unspecified');
});

test('a special use area popup says what, how high, when and who', () => {
  const lines = describeSua({ name: 'R-4001A', type: 'R', typeLabel: 'Restricted', floor: 'surface', ceiling: 'FL180', hours: '0700 - 1800, MON - FRI', agency: 'FAA, POTOMAC TRACON', remarks: null });
  assert.deepEqual(lines, ['R-4001A · Restricted', 'surface to FL180', 'Hours: 0700 - 1800, MON - FRI', 'Controlled by FAA, POTOMAC TRACON']);
});

test('the generated airspace files are what the map expects', async () => {
  const sua = JSON.parse(await readFile(new URL('../public/data/sua.json', import.meta.url)));
  assert.equal(sua.type, 'FeatureCollection');
  assert.ok(sua.features.length > 1000, `${sua.features.length} areas`);
  const types = new Set(sua.features.map((f) => f.properties.type));
  // Prohibited areas alert, so they live in zones.json and never here.
  assert.ok(!types.has('P'));
  for (const type of types) assert.ok(SUA_STYLE[type], `no style for ${type}`);
  for (const f of sua.features.slice(0, 50)) {
    assert.ok(['Polygon', 'MultiPolygon'].includes(f.geometry.type));
    assert.ok(f.properties.name && f.properties.floor && f.properties.ceiling && f.properties.hours);
  }
  const artcc = JSON.parse(await readFile(new URL('../public/data/artcc.json', import.meta.url)));
  assert.ok(artcc.features.length >= 20);
  assert.ok(artcc.features.every((f) => f.properties.ident && f.geometry));
});
