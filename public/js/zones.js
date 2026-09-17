/**
 * Zone store: seeded restricted airspace from data/zones.json plus any zones
 * the operator draws in the browser (kept in localStorage and exportable as
 * GeoJSON, so a drawn watch area survives a reload and can be shared).
 */

import { circleRing, ringBoundingCircle, distanceNm } from './geo.js';

const STORAGE_KEY = 'flysdown.zones.v1';

/**
 * insideRank is the severity of being inside the zone, before the ETA
 * adjustment. advisory means the zone is drawn and reported in a target's zone
 * checks but never raises an alert: an airliner transiting the DC SFRA with a
 * clearance is routine, and alerting on it would bury the real incursions.
 */
export const ZONE_KINDS = {
  prohibited: { label: 'Prohibited', insideRank: 3, advisory: false },
  tfr: { label: 'TFR', insideRank: 3, advisory: false },
  restricted: { label: 'Restricted', insideRank: 2, advisory: false },
  custom: { label: 'Custom watch', insideRank: 2, advisory: false },
  sfra: { label: 'Special flight rules', insideRank: 0, advisory: true },
};

/**
 * Turn a GeoJSON feature into the shape the detector wants: an explicit ring
 * for rendering and polygon tests, plus a bounding circle for the prefilter.
 */
export function prepareZone(feature) {
  const p = feature.properties || {};
  const isCircle = p.shape === 'circle' || feature.geometry?.type === 'Point';

  let ring;
  let center;
  let radiusNm;

  if (isCircle) {
    const [lon, lat] = feature.geometry.coordinates;
    radiusNm = Number(p.radiusNm) || 1;
    center = { lat, lon };
    ring = circleRing(lat, lon, radiusNm);
  } else {
    ring = feature.geometry.coordinates[0].slice();
    const bounds = ringBoundingCircle(ring);
    center = { lat: bounds.lat, lon: bounds.lon };
    radiusNm = bounds.radiusNm;
  }

  return {
    id: p.id || `zone-${Math.random().toString(36).slice(2, 9)}`,
    name: p.name || 'Unnamed zone',
    kind: ZONE_KINDS[p.kind] ? p.kind : 'custom',
    shape: isCircle ? 'circle' : 'polygon',
    floorFt: Number.isFinite(p.floorFt) ? p.floorFt : 0,
    ceilingFt: Number.isFinite(p.ceilingFt) ? p.ceilingFt : 60000,
    agl: Boolean(p.agl),
    appliesTo: Array.isArray(p.appliesTo) && p.appliesTo.length ? p.appliesTo : ['aircraft'],
    advisory: p.advisory ?? ZONE_KINDS[ZONE_KINDS[p.kind] ? p.kind : 'custom'].advisory,
    approx: Boolean(p.approx),
    note: p.note || '',
    source: p.source || '',
    userDrawn: Boolean(p.userDrawn),
    enabled: p.enabled !== false,
    ring,
    center,
    radiusNm,
  };
}

/** Back to GeoJSON, so a drawn zone round-trips through export/import. */
export function zoneToFeature(zone) {
  const properties = {
    id: zone.id,
    name: zone.name,
    kind: zone.kind,
    shape: zone.shape,
    floorFt: zone.floorFt,
    ceilingFt: zone.ceilingFt,
    agl: zone.agl,
    appliesTo: zone.appliesTo,
    advisory: zone.advisory,
    approx: zone.approx,
    note: zone.note,
    source: zone.source,
    userDrawn: zone.userDrawn,
    enabled: zone.enabled,
  };
  if (zone.shape === 'circle') {
    properties.radiusNm = zone.radiusNm;
    return {
      type: 'Feature',
      properties,
      geometry: { type: 'Point', coordinates: [zone.center.lon, zone.center.lat] },
    };
  }
  const ring = zone.ring.slice();
  const [firstLon, firstLat] = ring[0];
  const [lastLon, lastLat] = ring[ring.length - 1];
  if (firstLon !== lastLon || firstLat !== lastLat) ring.push([firstLon, firstLat]);
  return { type: 'Feature', properties, geometry: { type: 'Polygon', coordinates: [ring] } };
}

export class ZoneStore {
  constructor() {
    this.seeded = [];
    this.user = [];
    this.meta = {};
    this.listeners = new Set();
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) fn(this.all());
  }

  all() {
    return [...this.seeded, ...this.user];
  }

  active(kindFilter) {
    return this.all().filter((z) => z.enabled && (!kindFilter || kindFilter.has(z.kind)));
  }

  get(id) {
    return this.all().find((z) => z.id === id) || null;
  }

  async loadSeeded(url = 'data/zones.json') {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`zones.json HTTP ${res.status}`);
    const json = await res.json();
    this.meta = json.meta || {};
    this.seeded = (json.features || []).map(prepareZone);
    this.loadUser();
    this.emit();
    return this.seeded;
  }

  loadUser() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      this.user = (parsed.features || []).map((f) => {
        const zone = prepareZone(f);
        zone.userDrawn = true;
        return zone;
      });
    } catch (err) {
      console.warn('could not restore drawn zones', err);
      this.user = [];
    }
  }

  saveUser() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.exportUser()));
    } catch (err) {
      console.warn('could not persist drawn zones', err);
    }
  }

  addUserZone(zone) {
    const prepared = { ...zone, userDrawn: true };
    this.user.push(prepared);
    this.saveUser();
    this.emit();
    return prepared;
  }

  updateZone(id, patch) {
    const list = this.user.some((z) => z.id === id) ? this.user : this.seeded;
    const index = list.findIndex((z) => z.id === id);
    if (index === -1) return null;
    list[index] = { ...list[index], ...patch };
    if (list === this.user) this.saveUser();
    this.emit();
    return list[index];
  }

  removeZone(id) {
    const before = this.user.length;
    this.user = this.user.filter((z) => z.id !== id);
    if (this.user.length !== before) {
      this.saveUser();
      this.emit();
      return true;
    }
    return false;
  }

  clearUserZones() {
    this.user = [];
    this.saveUser();
    this.emit();
  }

  exportUser() {
    return { type: 'FeatureCollection', features: this.user.map(zoneToFeature) };
  }

  exportAll() {
    return { type: 'FeatureCollection', features: this.all().map(zoneToFeature) };
  }

  /** Accepts any GeoJSON FeatureCollection; circles need properties.radiusNm. */
  importFeatures(json) {
    const features = json?.type === 'FeatureCollection' ? json.features : [json];
    let added = 0;
    for (const feature of features || []) {
      if (!feature?.geometry) continue;
      const type = feature.geometry.type;
      if (type !== 'Point' && type !== 'Polygon') continue;
      const zone = prepareZone({
        ...feature,
        properties: {
          ...feature.properties,
          id: `user-${Date.now()}-${added}`,
          kind: feature.properties?.kind || 'custom',
          userDrawn: true,
        },
      });
      this.user.push(zone);
      added += 1;
    }
    if (added) {
      this.saveUser();
      this.emit();
    }
    return added;
  }
}

/** Convenience used by the detail panel: distance from a point to a zone edge. */
export function distanceToZoneNm(zone, lat, lon) {
  const toCenter = distanceNm(lat, lon, zone.center.lat, zone.center.lon);
  return zone.shape === 'circle' ? toCenter - zone.radiusNm : toCenter - zone.radiusNm;
}
