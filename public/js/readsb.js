/**
 * readsb/tar1090 aircraft records -> the shape every part of flysdown uses.
 *
 * Three callers must agree on that shape exactly: the edge function and the
 * relay (both through shared/adsb.js, which re-exports this) and the browser,
 * which reads a visitor's own receiver directly. It lives under public/ only
 * because that is the one directory the browser can load; there is still just
 * one copy, so a relayed snapshot, a live edge answer and a visitor's own
 * receiver cannot drift apart.
 */

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** ADS-B "dbFlags" is a bitmask: 1 military, 2 interesting, 4 PIA, 8 LADD. */
const flag = (dbFlags, bit) => Boolean(num(dbFlags) && (dbFlags & bit));

/** readsb/tar1090 JSON, shared by adsb.fi, adsb.lol and friends. */
export function normalizeReadsb(raw, sourceName) {
  const lat = num(raw.lat);
  const lon = num(raw.lon);
  if (lat === null || lon === null) return null;

  const onGround = raw.alt_baro === 'ground' || raw.alt_geom === 'ground';
  const alt = onGround ? 0 : num(raw.alt_baro) ?? num(raw.alt_geom);
  const track = num(raw.track) ?? num(raw.true_heading) ?? num(raw.mag_heading);
  const callsign = (raw.flight || '').trim();

  return {
    id: raw.hex,
    kind: 'aircraft',
    callsign: callsign || null,
    label: callsign || raw.r || raw.hex,
    registration: raw.r || null,
    typeCode: raw.t || null,
    typeDesc: raw.desc || null,
    operator: raw.ownOp || null,
    year: raw.year || null,
    lat,
    lon,
    alt,
    altGeom: onGround ? 0 : num(raw.alt_geom),
    onGround,
    groundSpeed: num(raw.gs),
    track,
    verticalRate: num(raw.baro_rate) ?? num(raw.geom_rate),
    squawk: raw.squawk || null,
    emergency: raw.emergency && raw.emergency !== 'none' ? raw.emergency : null,
    category: raw.category || null,
    military: flag(raw.dbFlags, 1),
    interesting: flag(raw.dbFlags, 2),
    pia: flag(raw.dbFlags, 4),
    ladd: flag(raw.dbFlags, 8),
    seen: num(raw.seen),
    seenPos: num(raw.seen_pos),
    rssi: num(raw.rssi),
    messages: num(raw.messages),
    positionSource: raw.type || null,
    source: sourceName,
  };
}
