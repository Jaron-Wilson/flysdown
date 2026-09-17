/**
 * Shape drawing. Three modes, all click-driven so they work on a touchscreen:
 *
 *   polygon - click each vertex, then Finish (or double-click) to close
 *   circle  - click the center, then click once more to set the radius
 *   box     - click one corner, then the opposite corner
 *
 * The same drawer serves two purposes, passed through to the completion
 * handler: 'zone' for a geofence and 'tracking' for a pinned area that keeps
 * loading data regardless of where the map is scrolled.
 *
 * The preview lives in its own source and is thrown away on finish or cancel.
 */

import { circleRing, distanceNm } from './geo.js';
import { INK } from './palette.js';

const EMPTY = { type: 'FeatureCollection', features: [] };

export class ZoneDrawer {
  constructor(mapView, { onComplete, onModeChange }) {
    this.mapView = mapView;
    this.map = mapView.map;
    this.onComplete = onComplete;
    this.onModeChange = onModeChange;
    this.mode = null;
    this.vertices = [];
    this.center = null;
    this.installed = false;
  }

  install() {
    if (this.installed || !this.map.getSource) return;
    this.map.addSource('draw', { type: 'geojson', data: EMPTY });
    this.map.addLayer({
      id: 'draw-fill',
      type: 'fill',
      source: 'draw',
      filter: ['==', ['geometry-type'], 'Polygon'],
      paint: { 'fill-color': '#199e70', 'fill-opacity': 0.15 },
    });
    this.map.addLayer({
      id: 'draw-line',
      type: 'line',
      source: 'draw',
      paint: { 'line-color': '#199e70', 'line-width': 2, 'line-dasharray': [2, 1] },
    });
    this.map.addLayer({
      id: 'draw-points',
      type: 'circle',
      source: 'draw',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: {
        'circle-radius': 4,
        'circle-color': '#199e70',
        'circle-stroke-color': INK.primary,
        'circle-stroke-width': 1,
      },
    });

    this.clickHandler = (event) => this.handleClick(event);
    this.moveHandler = (event) => this.handleMove(event);
    this.dblHandler = () => this.finish();
    this.installed = true;
  }

  setMode(mode, purpose = 'zone') {
    this.install();
    this.cancel({ silent: true });
    this.mode = mode;
    this.purpose = purpose;
    if (mode) {
      this.map.getCanvas().style.cursor = 'crosshair';
      this.map.on('click', this.clickHandler);
      this.map.on('mousemove', this.moveHandler);
      this.map.on('dblclick', this.dblHandler);
      this.map.doubleClickZoom.disable();
    }
    this.onModeChange?.(this.mode, this.purpose);
  }

  handleClick(event) {
    const { lng, lat } = event.lngLat;
    if (this.mode === 'polygon') {
      this.vertices.push([lng, lat]);
      this.renderPreview();
      return;
    }
    if (this.mode === 'circle') {
      if (!this.center) {
        this.center = { lat, lon: lng };
        this.renderPreview();
      } else {
        const radiusNm = distanceNm(this.center.lat, this.center.lon, lat, lng);
        this.commitCircle(Math.max(0.1, radiusNm));
      }
    }
  }

  handleMove(event) {
    if (!this.mode) return;
    this.cursor = [event.lngLat.lng, event.lngLat.lat];
    this.renderPreview();
  }

  renderPreview() {
    const features = [];
    if (this.mode === 'polygon' && this.vertices.length) {
      const ring = [...this.vertices];
      if (this.cursor) ring.push(this.cursor);
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring } });
      if (ring.length > 2) {
        features.push({
          type: 'Feature',
          properties: {},
          geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] },
        });
      }
      for (const v of this.vertices) {
        features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: v } });
      }
    }
    if (this.mode === 'box' && this.corner) {
      const to = this.cursor || [this.corner.lon, this.corner.lat];
      const north = Math.max(this.corner.lat, to[1]);
      const south = Math.min(this.corner.lat, to[1]);
      const east = Math.max(this.corner.lon, to[0]);
      const west = Math.min(this.corner.lon, to[0]);
      features.push({
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
        },
      });
      features.push({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [this.corner.lon, this.corner.lat] } });
    }

    if (this.mode === 'circle' && this.center) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [this.center.lon, this.center.lat] },
      });
      const radiusNm = this.cursor
        ? Math.max(0.05, distanceNm(this.center.lat, this.center.lon, this.cursor[1], this.cursor[0]))
        : 0.05;
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [circleRing(this.center.lat, this.center.lon, radiusNm)] },
      });
    }
    this.map.getSource('draw')?.setData({ type: 'FeatureCollection', features });
  }

  /** What the drawing looks like right now, for the hint text. */
  progress() {
    if (this.mode === 'polygon') return { mode: 'polygon', vertices: this.vertices.length };
    if (this.mode === 'circle') {
      const radiusNm = this.center && this.cursor
        ? distanceNm(this.center.lat, this.center.lon, this.cursor[1], this.cursor[0])
        : null;
      return { mode: 'circle', center: this.center, radiusNm };
    }
    if (this.mode === 'box') return { mode: 'box', corner: this.corner };
    return { mode: null };
  }

  finish() {
    if (this.mode !== 'polygon' || this.vertices.length < 3) return;
    const ring = [...this.vertices, this.vertices[0]];
    const geometry = { shape: 'polygon', ring };
    const purpose = this.purpose;
    this.cancel();
    this.onComplete?.(geometry, purpose);
  }

  commitCircle(radiusNm) {
    const geometry = { shape: 'circle', center: this.center, radiusNm };
    this.cancel();
    this.onComplete?.(geometry);
  }

  cancel({ silent = false } = {}) {
    this.vertices = [];
    this.center = null;
    this.corner = null;
    this.cursor = null;
    if (this.installed) {
      this.map.getSource('draw')?.setData(EMPTY);
      this.map.off('click', this.clickHandler);
      this.map.off('mousemove', this.moveHandler);
      this.map.off('dblclick', this.dblHandler);
      this.map.doubleClickZoom.enable();
      this.map.getCanvas().style.cursor = '';
    }
    this.mode = null;
    this.purpose = null;
    if (!silent) this.onModeChange?.(null, null);
  }
}
