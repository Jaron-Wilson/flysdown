/**
 * FAA temporary flight restrictions: parsing, kept free of any runtime so the
 * edge function (functions/api/tfrs.js), the browser (js/tfrs.js, for the
 * fallback mirror) and the tests share one copy. It lives under public/ only
 * because that is the one directory the browser can load.
 *
 * Two FAA sources are joined, because neither is enough alone (both measured
 * 2026-10-01):
 *   - the TFR WFS (tfr.faa.gov/geoserver) has every area's polygon and the
 *     NOTAM it belongs to, but no altitudes and no machine-readable times;
 *   - each NOTAM's detail XML (tfr.faa.gov/download/detail_6_6580.xml) has
 *     the floor, ceiling, effective and expiry times, and the text.
 * Neither sends CORS headers, so the browser cannot read them directly.
 */

const tag = (xml, name) => {
  const m = xml.match(new RegExp(`<${name}>([^<]*)</${name}>`));
  return m ? m[1].trim() : null;
};
const tags = (xml, name) => [...xml.matchAll(new RegExp(`<${name}>([^<]*)</${name}>`, 'g'))].map((m) => m[1].trim());

/** "6/6580-1-FDC-F" -> "6/6580". */
export const notamIdFromKey = (key) => String(key || '').split('-')[0];

/** "6/6580" -> the detail XML URL. */
export const detailUrl = (notamId) => `https://tfr.faa.gov/download/detail_${notamId.replace('/', '_')}.xml`;

/** The detail file's times are UTC without a zone suffix (they match the "UTC" in the NOTAM text). */
const utc = (text) => {
  if (!text) return null;
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * One vertical limit in feet, and whether it is above ground level.
 * HEI is height above ground, ALT is MSL, STD with FL is a flight level.
 * Anything unreadable on a ceiling is treated as unlimited, never as low.
 */
export function limitFeet(value, uom, code, { ceiling = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return { ft: ceiling ? 99999 : 0, agl: false, unlimited: ceiling };
  const ft = uom === 'FL' ? n * 100 : n;
  return { ft, agl: code === 'HEI', unlimited: false };
}

const fmt = (limit) => {
  // The FAA encodes "SFC-UNL" as FL910, so anything that high reads unlimited.
  if (limit.unlimited || limit.ft >= 60000) return 'unlimited';
  if (limit.ft === 0) return 'surface';
  return `${limit.ft.toLocaleString('en-US')} ft ${limit.agl ? 'AGL' : 'MSL'}`;
};

/**
 * Who a TFR restricts. The words before the first "ARE PROHIBITED" name it:
 * "ALL ACFT FLT OPS", "ACFT OPS" (everyone) or "UAS FLT OPS" (drones only).
 * Hazard TFRs (91.137) never say "prohibited" and restrict everyone but
 * relief aircraft, so the default is everyone.
 */
/**
 * Does this NOTAM actually close airspace, or only set conditions for it?
 *
 * Most TFRs say "... ARE PROHIBITED". Some close airspace by citing the rule
 * instead: 91.137/91.138 (hazard areas, open only to relief aircraft), 91.143
 * (space operations) and 91.145 (air shows and sporting events). Measured on
 * the live list (2026-10-01), 83 of 84 do one or the other. The one that did
 * neither was FDC 4/9383, the DC security instructions: speed limits and
 * training inside the SFRA, not a prohibition. Treating it as one put 17
 * critical alerts on routine DC traffic, the same failure the SFRA itself
 * once caused.
 */
export function restrictsFlight(text) {
  const flat = String(text || '').replace(/\s+/g, ' ');
  return /\bARE PROHIBITED\b/i.test(flat) || /\b91\.(137|138|143|145)\b/.test(flat);
}

export function appliesToDronesOnly(text, legalType) {
  if (/UAS PUBLIC GATHERING/i.test(legalType || '')) return true;
  const m = String(text || '').match(/([^.:]{0,120})\bARE PROHIBITED/i);
  if (!m) return false;
  const subject = m[1].toUpperCase();
  // "ALL ACFT FLT OPS INCLUDING REMOTE CONTROLLED ACFT OPS" is everyone.
  if (/\bALL (ACFT|AIRCRAFT)\b/.test(subject)) return false;
  return /\b(UAS|UNMANNED)\b/.test(subject);
}

/**
 * Parse one detail XML into the limits and window that matter for alerting.
 *
 * A NOTAM can have several areas with different limits. The polygons in the
 * WFS cannot be matched to those areas reliably, so every area of a NOTAM
 * gets the NOTAM's envelope: the lowest floor, the highest ceiling and the
 * widest window. That can only over-report, never miss, and it is labeled.
 */
export function parseTfrDetail(xml) {
  const text = tag(xml, 'txtDescrUSNS') || tag(xml, 'txtDescrTraditional') || '';
  const uppers = tags(xml, 'valDistVerUpper');
  const upperUoms = tags(xml, 'uomDistVerUpper');
  const upperCodes = tags(xml, 'codeDistVerUpper');
  const lowers = tags(xml, 'valDistVerLower');
  const lowerUoms = tags(xml, 'uomDistVerLower');
  const lowerCodes = tags(xml, 'codeDistVerLower');

  const ceilings = uppers.map((v, i) => limitFeet(v, upperUoms[i], upperCodes[i], { ceiling: true }));
  const floors = lowers.map((v, i) => limitFeet(v, lowerUoms[i], lowerCodes[i]));
  const ceiling = ceilings.length ? ceilings.reduce((a, b) => (b.ft > a.ft ? b : a)) : null;
  const floor = floors.length ? floors.reduce((a, b) => (b.ft < a.ft ? b : a)) : null;

  const effective = tags(xml, 'dateEffective').map(utc).filter(Number.isFinite);
  const expires = tags(xml, 'dateExpire').map(utc).filter(Number.isFinite);

  return {
    name: (tag(xml, 'txtLocalName') || '').replace(/\s+/g, ' ').trim() || null,
    floorFt: floor ? floor.ft : null,
    ceilingFt: ceiling ? ceiling.ft : null,
    // Only the ceiling's datum matters for the comparison: a floor of 0 AGL
    // is the surface either way.
    agl: Boolean(ceiling?.agl),
    limitsText: floor && ceiling ? `${fmt(floor)} to ${fmt(ceiling)}` : null,
    areas: Math.max(ceilings.length, floors.length),
    effective: effective.length ? Math.min(...effective) : null,
    expires: expires.length ? Math.max(...expires) : null,
    scheduled: /<isScheduledTfrArea>TRUE</i.test(xml),
    dronesOnly: appliesToDronesOnly(text),
    restricts: restrictsFlight(text),
    text: text.replace(/\s+/g, ' ').slice(0, 600),
  };
}

const round = (ring) => ring.map(([lon, lat]) => [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);

/** "MAYPORT, FL, Sunday, September 27, 2026 through ..." -> "Mayport, FL". */
export function placeFromTitle(title) {
  const head = String(title || '').split(/,\s*(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/)[0];
  return head
    .replace(/,(\s*,)+/g, ',')
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b([A-Z][a-z])$/, (s) => s.toUpperCase())
    .trim();
}

/** WFS features grouped by NOTAM, with each polygon's outer ring. */
export function groupWfs(geojson) {
  const byNotam = new Map();
  for (const f of geojson?.features || []) {
    const p = f.properties || {};
    const id = notamIdFromKey(p.NOTAM_KEY);
    if (!id || f.geometry?.type !== 'Polygon') continue;
    if (!byNotam.has(id)) {
      byNotam.set(id, { notam: id, type: p.LEGAL || 'TFR', place: placeFromTitle(p.TITLE), title: p.TITLE || '', facility: p.CNS_LOCATION_ID || null, polygons: [] });
    }
    byNotam.get(id).polygons.push(round(f.geometry.coordinates[0]));
  }
  return [...byNotam.values()];
}

/** One TFR as the API serves it: WFS geometry plus detail limits, if known. */
export function assembleTfr(group, detail) {
  return {
    ...group,
    name: detail?.name || null,
    floorFt: detail?.floorFt ?? null,
    ceilingFt: detail?.ceilingFt ?? null,
    agl: detail?.agl ?? false,
    limitsText: detail?.limitsText ?? null,
    areas: detail?.areas ?? null,
    effective: detail?.effective ?? null,
    expires: detail?.expires ?? null,
    scheduled: detail?.scheduled ?? false,
    dronesOnly: Boolean(detail?.dronesOnly) || /UAS PUBLIC GATHERING/i.test(group.type),
    // Unknown until the detail is in; tfrStatus treats that as not alerting.
    restricts: detail ? detail.restricts !== false : null,
    detailLoaded: Boolean(detail),
    text: detail?.text || null,
  };
}
