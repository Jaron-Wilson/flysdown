/**
 * Zone drawing. Two modes, both click-driven so they work on a touchscreen:
 *
 *   polygon - click each vertex, then Finish (or double-click) to close
 *   circle  - click the centre, then click once more to set the radius
 *
 * The drawing preview lives in its own source and is thrown away on finish or
 * cancel; the committed zone goes to the ZoneStore.
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
    this.centre = null;
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

  setMode(mode) {
    this.install();
    this.cancel({ silent: true });
    this.mode = mode;
    if (mode) {
      this.map.getCanvas().style.cursor = 'crosshair';
      this.map.on('click', this.clickHandler);
      this.map.on('mousemove', this.moveHandler);
      this.map.on('dblclick', this.dblHandler);
      this.map.doubleClickZoom.disable();
    }
    this.onModeChange?.(this.mode);
  }

  handleClick(event) {
    const { lng, lat } = event.lngLat;
    if (this.mode === 'polygon') {
      this.vertices.push([lng, lat]);
      this.renderPreview();
      return;
    }
    if (this.mode === 'circle') {
      if (!this.centre) {
        this.centre = { lat, lon: lng };
        this.renderPreview();
      } else {
        const radiusNm = distanceNm(this.centre.lat, this.centre.lon, lat, lng);
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
    if (this.mode === 'circle' && this.centre) {
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Point', coordinates: [this.centre.lon, this.centre.lat] },
      });
      const radiusNm = this.cursor
        ? Math.max(0.05, distanceNm(this.centre.lat, this.centre.lon, this.cursor[1], this.cursor[0]))
        : 0.05;
      features.push({
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [circleRing(this.centre.lat, this.centre.lon, radiusNm)] },
      });
    }
    this.map.getSource('draw')?.setData({ type: 'FeatureCollection', features });
  }

  /** Vertex count and, for a circle in progress, the live radius. */
  progress() {
    if (this.mode === 'polygon') return { mode: 'polygon', vertices: this.vertices.length };
    if (this.mode === 'circle') {
      const radiusNm = this.centre && this.cursor
        ? distanceNm(this.centre.lat, this.centre.lon, this.cursor[1], this.cursor[0])
        : null;
      return { mode: 'circle', centre: this.centre, radiusNm };
    }
    return { mode: null };
  }

  finish() {
    if (this.mode !== 'polygon' || this.vertices.length < 3) return;
    const ring = [...this.vertices, this.vertices[0]];
    const geometry = { shape: 'polygon', ring };
    this.cancel();
    this.onComplete?.(geometry);
  }

  commitCircle(radiusNm) {
    const geometry = { shape: 'circle', centre: this.centre, radiusNm };
    this.cancel();
    this.onComplete?.(geometry);
  }

  cancel({ silent = false } = {}) {
    this.vertices = [];
    this.centre = null;
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
    if (!silent) this.onModeChange?.(null);
  }
}
