/**
 * Regenerate public/data/zones.json: node tools/fetch-zones.mjs
 *
 * Prohibited-area geometry comes from the FAA's own Special Use Airspace
 * feature service, so the boundaries, floors and ceilings are the published
 * ones rather than something drawn by hand. The FAA reissues this data every
 * 56 days, so re-run this when the cycle changes.
 *
 * Two zones are added from regulation rather than from that dataset:
 * the DC Special Flight Rules Area (defined in 14 CFR 93 as a 30 NM radius of
 * the DCA VOR, so a circle is the exact shape, not an approximation) and the
 * two standing Disney TFRs.
 */

import { writeFile } from 'node:fs/promises';

const SUA = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/ArcGIS/rest/services/Special_Use_Airspace/FeatureServer/0/query';

const query = new URLSearchParams({
  where: "TYPE_CODE='P'",
  outFields: 'NAME,TYPE_CODE,LOWER_VAL,LOWER_UOM,LOWER_CODE,UPPER_VAL,UPPER_UOM,UPPER_CODE,CITY,STATE,COUNTRY,TIMESOFUSE,REMARKS',
  f: 'geojson',
  outSR: '4326',
});

/** Perpendicular distance from p to the segment a-b, in degrees. */
function perpendicular(p, a, b) {
  const [px, py] = p;
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * Douglas-Peucker. The FAA ships circular areas as 6,285-point polygons,
 * which is a quarter of a megabyte of JSON for a one-mile circle.
 */
function simplify(points, tolerance) {
  if (points.length < 3) return points;
  let maxDist = 0;
  let index = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicular(points[i], points[0], points[points.length - 1]);
    if (dist > maxDist) {
      maxDist = dist;
      index = i;
    }
  }
  if (maxDist <= tolerance) return [points[0], points[points.length - 1]];
  return [
    ...simplify(points.slice(0, index + 1), tolerance).slice(0, -1),
    ...simplify(points.slice(index), tolerance),
  ];
}

const round = (ring) => ring.map(([lon, lat]) => [Number(lon.toFixed(5)), Number(lat.toFixed(5))]);

const centroid = (ring) => ({
  lat: ring.reduce((a, p) => a + p[1], 0) / ring.length,
  lon: ring.reduce((a, p) => a + p[0], 0) / ring.length,
});

const near = (c, lat, lon, tol = 0.01) => Math.abs(c.lat - lat) < tol && Math.abs(c.lon - lon) < tol;

/** "0FT/SFC" and "18000FT/MSL" style pairs into plain feet. */
function altitude(value, code, fallback) {
  if (code === 'SFC' || code === 'GND') return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function titleCase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim();
}

/** ArcGIS answers 200 with an error body when it is unhappy, so check both. */
async function fetchSua(attempt = 1) {
  const res = await fetch(`${SUA}?${query}`, { headers: { accept: 'application/json' } });
  const json = res.ok ? await res.json() : null;
  if (json && Array.isArray(json.features)) return json;

  const reason = !res.ok ? `HTTP ${res.status}` : JSON.stringify(json?.error || json).slice(0, 200);
  if (attempt >= 3) throw new Error(`FAA SUA query failed after ${attempt} attempts: ${reason}`);
  console.warn(`  attempt ${attempt} failed (${reason}), retrying`);
  await new Promise((r) => setTimeout(r, 2000 * attempt));
  return fetchSua(attempt + 1);
}

const raw = await fetchSua();

const features = [];
let dropped = 0;

for (const feature of raw.features) {
  const p = feature.properties;
  // The dataset carries a few non-US entries with no state; skip them.
  // COUNTRY is spelled out as "UNITED STATES" here, not "USA".
  const usCountry = !p.COUNTRY || /UNITED STATES|USA/i.test(p.COUNTRY);
  if (!p.STATE || !usCountry) {
    dropped += 1;
    continue;
  }
  if (feature.geometry?.type !== 'Polygon') {
    dropped += 1;
    continue;
  }

  const original = feature.geometry.coordinates[0];
  const ring = round(simplify(original, 0.0004));
  const c = centroid(ring);

  // The FAA publishes both sections of P-56 under the same name. The small
  // circle over the Naval Observatory is P-56B; the Mall polygon is P-56A.
  let name = p.NAME;
  if (p.NAME === 'P-56') {
    name = near(c, 38.9214, -77.0669) ? 'P-56B Naval Observatory' : 'P-56A National Mall';
  } else if (p.CITY) {
    name = `${p.NAME} ${titleCase(p.CITY).split(',')[0]}`;
  }

  features.push({
    type: 'Feature',
    properties: {
      id: `faa-${p.NAME.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${features.length}`,
      name,
      kind: 'prohibited',
      shape: 'polygon',
      floorFt: altitude(p.LOWER_VAL, p.LOWER_CODE, 0),
      ceilingFt: altitude(p.UPPER_VAL, p.UPPER_CODE, 18000),
      appliesTo: ['aircraft'],
      approx: false,
      simplifiedFrom: original.length > ring.length ? original.length : undefined,
      note: [p.TIMESOFUSE, p.REMARKS].filter(Boolean).join(' ').slice(0, 300) || 'Prohibited area.',
      source: 'FAA Special Use Airspace (ArcGIS feature service)',
      state: p.STATE,
    },
    geometry: { type: 'Polygon', coordinates: [ring] },
  });
}

features.push(
  {
    type: 'Feature',
    properties: {
      id: 'dc-sfra',
      name: 'DC Special Flight Rules Area',
      kind: 'sfra',
      shape: 'circle',
      radiusNm: 30,
      floorFt: 0,
      ceilingFt: 18000,
      appliesTo: ['aircraft'],
      approx: false,
      advisory: true,
      note: 'A 30 NM radius on the DCA VOR/DME. Entry needs a flight plan, a discrete transponder code and two-way radio, so transiting traffic here is routine. Shown for context and listed under zone checks, but it does not raise alerts.',
      source: '14 CFR 93 subpart V',
    },
    geometry: { type: 'Point', coordinates: [-77.035, 38.8594] },
  },
  {
    type: 'Feature',
    properties: {
      id: 'tfr-wdw',
      name: 'Walt Disney World TFR',
      kind: 'tfr',
      shape: 'circle',
      radiusNm: 3,
      floorFt: 0,
      ceilingFt: 3000,
      agl: true,
      appliesTo: ['aircraft'],
      approx: false,
      note: 'Standing temporary flight restriction, surface to 3,000 ft AGL.',
      source: 'FDC 9/3799',
    },
    geometry: { type: 'Point', coordinates: [-81.5811, 28.4147] },
  },
  {
    type: 'Feature',
    properties: {
      id: 'tfr-dlr',
      name: 'Disneyland TFR',
      kind: 'tfr',
      shape: 'circle',
      radiusNm: 3,
      floorFt: 0,
      ceilingFt: 3000,
      agl: true,
      appliesTo: ['aircraft'],
      approx: false,
      note: 'Standing temporary flight restriction, surface to 3,000 ft AGL.',
      source: 'FDC 9/3799',
    },
    geometry: { type: 'Point', coordinates: [-117.9197, 33.8117] },
  },
  {
    type: 'Feature',
    properties: {
      id: 'demo-gulf-lane',
      name: 'Gulf of Finland lane watch',
      kind: 'custom',
      shape: 'circle',
      radiusNm: 3,
      floorFt: 0,
      ceilingFt: 60000,
      appliesTo: ['vessel', 'aircraft'],
      approx: true,
      note: 'Demonstration watch area on the Helsinki to Tallinn shipping lane, not an official restriction. Sited on open water rather than over a harbour so it shows vessels transiting rather than a list of moored ships.',
      source: 'flysdown demo',
    },
    geometry: { type: 'Point', coordinates: [24.78, 59.9] },
  }
);

const out = {
  type: 'FeatureCollection',
  meta: {
    updated: new Date().toISOString().slice(0, 10),
    sources: [
      'FAA Special Use Airspace feature service (prohibited areas, real published geometry)',
      '14 CFR 93 subpart V (DC SFRA)',
      'FDC 9/3799 (standing Disney TFRs)',
    ],
    disclaimer: 'NOT FOR NAVIGATION. Prohibited-area geometry is the FAA published boundary, simplified for the browser, but activation times, NOTAMs and temporary restrictions are not modelled. Always use current charts and NOTAMs.',
    altitudeNote: 'floorFt/ceilingFt are compared against barometric altitude in feet MSL. Zones whose published limits are AGL are marked agl:true; over terrain that comparison is approximate.',
  },
  features,
};

await writeFile('public/data/zones.json', `${JSON.stringify(out, null, 1)}\n`);
console.log(`wrote ${features.length} zones (${dropped} dropped), ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
for (const f of features) {
  const pts = f.geometry.type === 'Polygon' ? f.geometry.coordinates[0].length : 1;
  console.log(`  ${f.properties.name.padEnd(34)} ${String(f.properties.floorFt).padStart(5)} - ${String(f.properties.ceilingFt).padEnd(6)} ft  ${pts} pts${f.properties.simplifiedFrom ? ` (from ${f.properties.simplifiedFrom})` : ''}`);
}
