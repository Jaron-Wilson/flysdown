/**
 * Regenerate the drawn airspace layers: node tools/fetch-airspace.mjs
 *
 *   public/data/sua.json    every Special Use Airspace type except prohibited
 *                           (those are alerting zones in zones.json):
 *                           restricted, MOA, warning, alert, NSA, danger
 *   public/data/artcc.json  ARTCC (air route traffic control center) boundaries
 *
 * Both come from the FAA's own ArcGIS feature services, the same publisher as
 * the prohibited areas, and like them are reissued on the 56-day cycle, so
 * re-run this with fetch-zones.mjs.
 *
 * These are drawn, not alerted on. Most restricted areas and MOAs are active
 * only at published hours or "by NOTAM", which no keyless source states in a
 * machine-readable way, and alerting on every airliner crossing a MOA would
 * bury the incursions that matter (the DC SFRA taught that: 55 alerts down to
 * 3 once it went advisory). A click shows the published limits and hours.
 *
 * The geometry is simplified by the FAA's server (maxAllowableOffset): the
 * full set is 22 MB, this is under 1 MB and about 100 KB on the wire.
 */

import { writeFile } from 'node:fs/promises';
import { formatLimit } from '../public/js/layers.js';

const BASE = 'https://services6.arcgis.com/ssFJjBXIUyZDrSYZ/arcgis/rest/services';

const TYPE_LABEL = {
  R: 'Restricted',
  MOA: 'Military operations area',
  W: 'Warning area',
  A: 'Alert area',
  D: 'Danger area',
  NSA: 'National security area',
};

async function query(service, params, attempt = 1) {
  const url = `${BASE}/${service}/FeatureServer/0/query?${new URLSearchParams({ outSR: '4326', f: 'geojson', ...params })}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  // ArcGIS answers 200 with an error body when it is unhappy, so check both.
  const json = res.ok ? await res.json() : null;
  if (json && Array.isArray(json.features)) return json.features;
  const reason = !res.ok ? `HTTP ${res.status}` : JSON.stringify(json?.error || json).slice(0, 200);
  if (attempt >= 3) throw new Error(`${service} query failed after ${attempt} attempts: ${reason}`);
  console.warn(`  ${service}: attempt ${attempt} failed (${reason}), retrying`);
  await new Promise((r) => setTimeout(r, 3000 * attempt));
  return query(service, params, attempt + 1);
}

const clean = (text, limit = 240) => {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1).trimEnd()}…`;
};

const SIMPLIFY = { maxAllowableOffset: '0.005', geometryPrecision: '4' };

const sua = await query('Special_Use_Airspace', {
  where: "TYPE_CODE<>'P'",
  outFields: 'NAME,TYPE_CODE,LOWER_VAL,LOWER_UOM,LOWER_CODE,UPPER_VAL,UPPER_UOM,UPPER_CODE,TIMESOFUSE,CONT_AGENT,CITY,STATE,REMARKS',
  ...SIMPLIFY,
});
// National security areas live in a different service with different names.
const nsa = await query('Airspace', {
  where: "TYPE_CODE='NSA'",
  outFields: 'NAME_TXT,TYPE_CODE,DISTVERTUPPER_VAL,DISTVERTUPPER_UOM,DISTVERTUPPER_CODE,DISTVERTLOWER_VAL,DISTVERTLOWER_UOM,DISTVERTLOWER_CODE,WORKHR_CODE,WORKHRRMK_TXT,REMARKS_TXT',
  ...SIMPLIFY,
});

const features = [];
const counts = {};
for (const f of sua) {
  const p = f.properties;
  if (!f.geometry || !TYPE_LABEL[p.TYPE_CODE]) continue;
  counts[p.TYPE_CODE] = (counts[p.TYPE_CODE] || 0) + 1;
  features.push({
    type: 'Feature',
    properties: {
      name: clean(p.NAME, 80),
      type: p.TYPE_CODE,
      typeLabel: TYPE_LABEL[p.TYPE_CODE],
      floor: formatLimit(p.LOWER_VAL, p.LOWER_UOM, p.LOWER_CODE),
      ceiling: formatLimit(p.UPPER_VAL, p.UPPER_UOM, p.UPPER_CODE),
      hours: clean(p.TIMESOFUSE, 160) || 'not published',
      agency: clean(p.CONT_AGENT, 80) || null,
      remarks: clean(p.REMARKS, 200) || null,
    },
    geometry: f.geometry,
  });
}
for (const f of nsa) {
  const p = f.properties;
  if (!f.geometry) continue;
  counts.NSA = (counts.NSA || 0) + 1;
  features.push({
    type: 'Feature',
    properties: {
      name: clean(p.NAME_TXT, 80),
      type: 'NSA',
      typeLabel: TYPE_LABEL.NSA,
      floor: formatLimit(p.DISTVERTLOWER_VAL, p.DISTVERTLOWER_UOM, p.DISTVERTLOWER_CODE),
      ceiling: formatLimit(p.DISTVERTUPPER_VAL, p.DISTVERTUPPER_UOM, p.DISTVERTUPPER_CODE),
      hours: clean(p.WORKHRRMK_TXT || p.WORKHR_CODE, 160) || 'not published',
      agency: null,
      remarks: clean(p.REMARKS_TXT, 200) || 'Pilots are requested to voluntarily avoid flying through it.',
    },
    geometry: f.geometry,
  });
}

const artccRaw = await query('Boundary_Airspace', {
  where: "TYPE_CODE='ARTCC' AND LOCAL_TYPE='ARTCC_L'",
  outFields: 'IDENT,NAME',
  maxAllowableOffset: '0.01',
  geometryPrecision: '3',
});
const artcc = artccRaw
  .filter((f) => f.geometry)
  .map((f) => ({ type: 'Feature', properties: { ident: f.properties.IDENT, name: clean(f.properties.NAME, 60) }, geometry: f.geometry }));

const meta = (what) => ({
  updated: new Date().toISOString().slice(0, 10),
  source: `FAA ArcGIS feature services (${what}), geometry simplified by the server`,
  disclaimer: 'NOT FOR NAVIGATION. Drawn for context; activation and NOTAMs are not modeled.',
});

await writeFile('public/data/sua.json', `${JSON.stringify({ type: 'FeatureCollection', meta: { ...meta('Special_Use_Airspace, Airspace'), counts }, features })}\n`);
await writeFile('public/data/artcc.json', `${JSON.stringify({ type: 'FeatureCollection', meta: meta('Boundary_Airspace'), features: artcc })}\n`);
console.log(`sua.json: ${features.length} areas ${JSON.stringify(counts)}; artcc.json: ${artcc.length} centers`);
