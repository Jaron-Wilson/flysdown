/**
 * Panel rendering. Takes state, writes DOM. No fetching, no geometry.
 *
 * Every status color in here is accompanied by a glyph and a word, and the
 * altitude ramp is repeated in the legend, so nothing depends on hue alone.
 */

import { SEVERITY, ALTITUDE_BANDS, GROUND_COLOR, VESSEL_UNDERWAY, VESSEL_STATIC, zoneStyle, ZONE_KIND_STYLE } from './palette.js';
import { routeFit, airportCode } from './route.js';
import { targetAgeSec } from './feeds.js';
import { distanceNm } from './geo.js';
import { INK } from './palette.js';

const INK_SECONDARY = INK.secondary;

const $ = (id) => document.getElementById(id);

const int = (n) => Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });

export const fmt = {
  alt(target) {
    if (target.onGround) return 'on the ground';
    if (typeof target.alt !== 'number') return 'unknown';
    return `${int(target.alt)} ft`;
  },
  speed(kt) {
    return typeof kt === 'number' ? `${int(kt)} kt` : 'unknown';
  },
  vs(fpm) {
    if (typeof fpm !== 'number' || fpm === 0) return 'level';
    return `${fpm > 0 ? '+' : ''}${int(fpm)} ft/min`;
  },
  bearing(deg) {
    return typeof deg === 'number' ? `${Math.round(deg)}°` : 'unknown';
  },
  eta(sec) {
    if (sec === null || sec === undefined) return '';
    if (sec <= 0) return 'now';
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    return m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
  },
  ago(ts) {
    if (!ts) return 'never';
    const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return sec < 60 ? `${sec}s ago` : `${Math.floor(sec / 60)}m ago`;
  },
  nm(v) {
    return typeof v === 'number' ? `${v.toFixed(1)} NM` : 'unknown';
  },
  /** Compact duration for contact ages: 8s, 2m 05s, 1h 04m. */
  duration(sec) {
    if (!Number.isFinite(sec)) return 'unknown';
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  },
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Remembers whether the feed health line is folded away. */
const FEEDBAR_KEY = 'flysdown.feedbar.folded.v1';

export class UI {
  constructor() {
    this.refs = {
      statTiles: $('stat-tiles'),
      altChart: $('alt-chart'),
      altTotal: $('alt-total'),
      alertList: $('alert-list'),
      alertSummary: $('alert-summary'),
      detail: $('detail'),
      zoneList: $('zone-list'),
      zoneCount: $('zone-count'),
      legend: $('legend'),
      statusText: $('status-text'),
      tooltip: $('map-tooltip'),
      banner: $('map-banner'),
      tableWrap: $('table-wrap'),
      drawHint: $('draw-hint'),
      trackList: $('track-list'),
      trackNote: $('track-note'),
      feedToggles: $('feed-toggles'),
      feedbar: $('feedbar'),
      feedbarToggle: $('feedbar-toggle'),
      feedbarDot: $('feedbar-dot'),
    };
    this.handlers = {};
    this.renderLegend();
  }

  on(name, fn) {
    this.handlers[name] = fn;
  }

  /* ---------- navigation: tabs on desktop, views on phones ---------- */

  initNavigation() {
    for (const tab of document.querySelectorAll('.tabs .tab')) {
      tab.addEventListener('click', () => this.setTab(tab.dataset.tab));
    }
    for (const button of document.querySelectorAll('.mobile-nav button')) {
      button.addEventListener('click', () => this.setView(button.dataset.view));
    }
    this.initFeedbar();
  }

  /**
   * The feed health line folds away, and stays folded between visits: it is
   * diagnostics, useful when something looks wrong and noise the rest of the
   * time. Folded, the button keeps a dot when a feed is not answering, so
   * hiding the line cannot hide a dead feed.
   */
  initFeedbar() {
    const { feedbar, feedbarToggle } = this.refs;
    if (!feedbar || !feedbarToggle) return;
    this.setFeedbarFolded(localStorage.getItem(FEEDBAR_KEY) === '1');
    feedbarToggle.addEventListener('click', () => {
      const folded = !feedbar.classList.contains('is-folded');
      this.setFeedbarFolded(folded);
      try {
        localStorage.setItem(FEEDBAR_KEY, folded ? '1' : '0');
      } catch {
        // A browser with storage denied still gets the fold, just not the memory.
      }
    });
  }

  setFeedbarFolded(folded) {
    const { feedbar, feedbarToggle } = this.refs;
    if (!feedbar || !feedbarToggle) return;
    feedbar.classList.toggle('is-folded', folded);
    feedbarToggle.setAttribute('aria-expanded', String(!folded));
    feedbarToggle.title = folded ? 'Show which feed served this data' : 'Hide the feed status line';
  }

  /** Switch the left rail's tab. Also used to jump the user to a control. */
  setTab(name) {
    for (const tab of document.querySelectorAll('.tabs .tab')) {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', String(active));
    }
    for (const pane of document.querySelectorAll('.tab-pane')) {
      pane.hidden = pane.id !== `tab-${name}`;
    }
    // On a phone the rail is a view of its own; keep the two in step.
    if (window.matchMedia('(max-width: 1040px)').matches && (name === 'filters' || name === 'areas')) {
      this.setView(name, { keepTab: true });
    }
  }

  /** Phone-only: which one panel is on screen. */
  setView(name, { keepTab = false } = {}) {
    document.body.dataset.view = name;
    for (const button of document.querySelectorAll('.mobile-nav button')) {
      button.classList.toggle('is-active', button.dataset.view === name);
    }
    if (!keepTab && (name === 'filters' || name === 'areas')) this.setTab(name);
    if (name !== 'map') this.handlers.leftMap?.();
  }

  /** The alert count, shown on the Alerts heading and the phone tab. */
  renderAlertBadge(count) {
    for (const id of ['alert-badge', 'alert-badge-mobile']) {
      const node = $(id);
      if (!node) continue;
      node.textContent = String(count);
      node.hidden = count === 0;
    }
  }

  /* ---------- first visit ---------- */

  showWelcome() {
    const node = $('welcome');
    if (!node) return;
    node.hidden = false;
    node.querySelector('[data-start]')?.focus();
  }

  hideWelcome({ remember = false } = {}) {
    const node = $('welcome');
    if (!node) return;
    node.hidden = true;
    if (remember) {
      try {
        localStorage.setItem('flysdown.welcomed.v1', '1');
      } catch {
        // private mode: it will simply show again next time
      }
    }
  }

  static hasBeenWelcomed() {
    try {
      return localStorage.getItem('flysdown.welcomed.v1') === '1';
    } catch {
      return false;
    }
  }

  /** The floating map button mirrors whether the view is pinned. */
  renderMapPin(pinnedCount) {
    const button = $('map-pin');
    if (!button) return;
    const pinned = pinnedCount > 0;
    button.setAttribute('aria-pressed', String(pinned));
    button.textContent = pinned ? `Following the map again` : 'Pin this view';
    button.title = pinned
      ? `Stop tracking the ${pinnedCount} pinned area${pinnedCount === 1 ? '' : 's'} and load whatever is on screen`
      : 'Keep loading this area while you scroll elsewhere';
  }

  /* ---------- tiles ---------- */

  renderStats({ aircraftCount, vesselCount, alerts, projectedCount, groundCount }) {
    const worst = alerts.reduce((acc, a) => (SEVERITY[a.severity].rank > SEVERITY[acc].rank ? a.severity : acc), 'good');
    const status = SEVERITY[worst];

    this.refs.statTiles.innerHTML = `
      <div class="tile">
        <div class="tile-value">${int(aircraftCount)}</div>
        <div class="tile-label">Aircraft in view</div>
        <div class="tile-sub">${groundCount ? `${int(groundCount)} on the ground` : 'all airborne'}</div>
      </div>
      <div class="tile">
        <div class="tile-value">${int(vesselCount)}</div>
        <div class="tile-label">Vessels in view</div>
        <div class="tile-sub">${vesselCount ? 'AIS reporting' : 'no AIS coverage here'}</div>
      </div>
      <div class="tile">
        <div class="tile-value">${int(alerts.length)}</div>
        <div class="tile-label">Active alerts</div>
        <div class="tile-sub">
          <span class="alert-glyph" style="background:${status.color}">${status.glyph}</span>
          <span>${alerts.length ? `worst: ${status.label}` : 'nothing flagged'}</span>
        </div>
      </div>
      <div class="tile">
        <div class="tile-value">${int(projectedCount)}</div>
        <div class="tile-label">Projected zone entries</div>
        <div class="tile-sub">within the horizon</div>
      </div>`;
  }

  /* ---------- altitude distribution ---------- */

  renderAltitudeChart(aircraft) {
    const counts = ALTITUDE_BANDS.map(() => 0);
    let ground = 0;
    for (const target of aircraft) {
      if (target.onGround) {
        ground += 1;
        continue;
      }
      if (typeof target.alt !== 'number') continue;
      const index = ALTITUDE_BANDS.findIndex((b) => target.alt < b.maxFt);
      counts[index === -1 ? ALTITUDE_BANDS.length - 1 : index] += 1;
    }

    // Short labels here; the legend spells the bands out in full. The long
    // form overflowed its column and ran into the bars.
    const rows = [
      ...ALTITUDE_BANDS.map((band, i) => ({ label: band.short, title: band.label, count: counts[i], color: band.color })),
      { label: 'on ground', title: 'on the ground', count: ground, color: GROUND_COLOR },
    ].reverse();

    const max = Math.max(1, ...rows.map((r) => r.count));
    this.refs.altTotal.textContent = `${int(aircraft.length)} tracked`;
    this.refs.altChart.innerHTML = rows
      .map(
        (row) => `
        <div class="chart-row" title="${escapeHtml(row.title)}: ${int(row.count)} aircraft">
          <span class="chart-label">${escapeHtml(row.label)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${(row.count / max) * 100}%;background:${row.color}"></span></span>
          <span class="chart-value">${int(row.count)}</span>
        </div>`
      )
      .join('');
  }

  /* ---------- alerts ---------- */

  renderAlerts(alerts) {
    const counts = alerts.reduce((acc, a) => ({ ...acc, [a.severity]: (acc[a.severity] || 0) + 1 }), {});
    this.refs.alertSummary.textContent = alerts.length
      ? ['critical', 'serious', 'warning', 'notice']
          .filter((s) => counts[s])
          .map((s) => `${counts[s]} ${SEVERITY[s].label.toLowerCase()}`)
          .join(', ')
      : 'none active';

    if (!alerts.length) {
      this.refs.alertList.innerHTML = `<li class="hint">No target is inside or projected to enter an active zone, and no emergency codes are being reported.</li>`;
      return;
    }

    this.refs.alertList.innerHTML = alerts
      .slice(0, 60)
      .map((alert) => {
        const sev = SEVERITY[alert.severity];
        return `
        <li>
          <button class="alert is-${alert.severity}" type="button" data-key="${escapeHtml(alert.targetKind)}:${escapeHtml(alert.targetId)}">
            <span class="alert-glyph" style="background:${sev.color}" aria-hidden="true">${sev.glyph}</span>
            <span>
              <span class="alert-sev">${sev.label}</span>
              <div class="alert-title">${escapeHtml(alert.title)}</div>
              <div class="alert-detail">${escapeHtml(alert.detail)}</div>
              ${alert.etaSec ? `<div class="alert-eta">${alert.rule === 'close-approach' ? 'Time to closest approach' : 'Time to boundary'}: ${fmt.eta(alert.etaSec)}${alert.cpaNm !== undefined ? ` \u00b7 ${alert.cpaNm.toFixed(2)} NM` : ''}</div>` : ''}
            </span>
          </button>
        </li>`;
      })
      .join('');

    for (const button of this.refs.alertList.querySelectorAll('button[data-key]')) {
      button.addEventListener('click', () => this.handlers.selectTarget?.(button.dataset.key));
    }
  }

  /* ---------- target detail ---------- */

  renderDetail(target, options = {}) {
    const { evaluation = null, approaches = [], route = null, track = [] } = options;
    if (!target) {
      this.refs.detail.innerHTML = `<p class="hint">Select an aircraft or vessel on the map.</p>`;
      return;
    }

    const isAircraft = target.kind === 'aircraft';
    const rows = isAircraft
      ? [
          ['Altitude', fmt.alt(target)],
          ['Ground speed', fmt.speed(target.groundSpeed)],
          ['Track', fmt.bearing(target.track)],
          ['Vertical rate', fmt.vs(target.verticalRate)],
          ['Squawk', target.squawk || 'none'],
          ['Type', target.typeDesc || target.typeCode || 'unknown'],
          ['Registration', target.registration || 'unknown'],
          ['Operator', target.operator || 'unknown'],
          ['ICAO hex', target.id],
          ['Last position report', `${fmt.duration(targetAgeSec(target))} ago`],
          ['Last any message', target.seen === null || target.seen === undefined ? 'unknown' : `${fmt.duration(target.seen)} ago`],
          ['Feed', target.source || 'unknown'],
        ]
      : [
          ['Speed over ground', fmt.speed(target.sog)],
          ['Course', fmt.bearing(target.cog)],
          ['Heading', fmt.bearing(target.heading)],
          ['Status', target.navStatusDesc || 'unknown'],
          ['Type', target.typeDesc || 'unknown'],
          ['Destination', target.destination || 'not reported'],
          ['Reported ETA', target.eta || 'not reported'],
          ['Draft', target.draftM ? `${target.draftM.toFixed(1)} m` : 'not reported'],
          ['Length', target.lengthM ? `${target.lengthM} m` : 'not reported'],
          ['MMSI', target.mmsi],
          ['Call sign', target.callsign || 'not reported'],
          ['Last position report', `${fmt.duration(targetAgeSec(target))} ago`],
          ['Feed', target.source || 'unknown'],
        ];

    // Watching one land is half the fun, so say so rather than leaving it to be
    // inferred from a gray dot and a zero ground speed.
    const landed = (evaluation?.alerts || []).find((alert) => alert.rule === 'landed');
    let landedBlock = '';
    if (landed) {
      const arrival = route?.status === 'ok' ? route.route.destination : null;
      const fit = arrival ? routeFit(route.route, target) : null;
      // Only name the airport if the aircraft is actually at it.
      const where = fit && fit.remainingNm !== null && fit.remainingNm < 6 ? ` at ${escapeHtml(airportCode(arrival))}` : '';
      landedBlock = `<p class="landed-note">Landed${where} \u00b7 ${escapeHtml(fmt.duration(landed.agoSec))} ago</p>`;
    }

    const flags = [
      target.military && 'military',
      target.interesting && 'special interest',
      target.pia && 'privacy ICAO address',
      target.ladd && 'limited display',
    ].filter(Boolean);

    const zoneRows = (evaluation?.zoneResults || [])
      .slice()
      .sort((a, b) => (a.etaSec ?? 1e9) - (b.etaSec ?? 1e9))
      .map((result) => {
        const style = zoneStyle(result.zone.kind);
        const state = result.state === 'inside'
          ? 'inside now'
          : `entry in ${fmt.eta(result.etaSec)}`;
        return `<li>
            <span class="zone-swatch" style="color:${style.color};background:${style.color}33"></span>
            <span>${escapeHtml(result.zone.name)}</span>
            <span class="z-eta">${state}</span>
          </li>`;
      })
      .join('');

    const pairRisk = approaches
      .filter((a) => a.targetId === target.id || a.otherId === target.id)
      .sort((a, b) => a.cpaNm - b.cpaNm)
      .slice(0, 3)
      .map((a) => {
        const other = a.targetId === target.id ? a.otherLabel : a.targetLabel;
        return `<li>
            <span class="zone-swatch" style="color:${SEVERITY[a.severity].color};background:${SEVERITY[a.severity].color}33"></span>
            <span>${escapeHtml(other)}</span>
            <span class="z-eta">${a.cpaNm.toFixed(2)} NM in ${fmt.eta(a.etaSec)}</span>
          </li>`;
      })
      .join('');

    // Where it came from and where it is going, which ADS-B does not carry.
    let routeBlock = '';
    if (isAircraft && route?.status === 'pending') {
      routeBlock = '<h3 class="block-title">Route</h3><p class="hint">Looking up the route.</p>';
    } else if (isAircraft && route?.status === 'none') {
      routeBlock = '<h3 class="block-title">Route</h3><p class="hint">No scheduled route for this callsign, which is normal for general aviation and military flights.</p>';
    } else if (isAircraft && route?.status === 'ok') {
      const { origin, destination, airline } = route.route;
      const fit = routeFit(route.route, target);
      const wrong = fit.verdict === 'mismatch';
      const speed = target.groundSpeed;

      // An arrival time computed off a route the aircraft is not flying is the
      // most confident kind of wrong, so it is withheld rather than guessed.
      const etaSec = !wrong && fit.remainingNm !== null && speed > 40 ? (fit.remainingNm / speed) * 3600 : null;

      const leg = (airport, label) =>
        airport
          ? `<li>
              <span>${escapeHtml(label)}</span>
              <span>${escapeHtml([airportCode(airport), airport.municipality].filter(Boolean).join(' '))}</span>
              <span class="z-eta">${escapeHtml(airport.name || '')}</span>
            </li>`
          : '';

      const place = (airport) => escapeHtml(airportCode(airport) || 'the airport');
      let note = '<p class="hint">Reported for this callsign by adsbdb. ADS-B does not broadcast a destination, so this is the route the callsign usually flies, not a filed flight plan.</p>';
      if (wrong && fit.reason === 'detour') {
        note = `<p class="hint hint-warn">This does not match where the aircraft is. ${place(origin)} to ${place(destination)} is ${escapeHtml(fmt.nm(fit.totalNm))}, but the aircraft is ${escapeHtml(fmt.nm(fit.flownNm))} from ${place(origin)} and ${escapeHtml(fmt.nm(fit.remainingNm))} from ${place(destination)}. Treat the route below as the callsign's usual one, not this flight's.</p>`;
      } else if (wrong && fit.reason === 'bearing') {
        note = `<p class="hint hint-warn">This does not match where the aircraft is heading: it is ${escapeHtml(fmt.nm(fit.remainingNm))} from ${place(destination)} and tracking ${Math.round(fit.bearingErrorDeg)}\u00b0 away from it. Treat the route below as unverified.</p>`;
      }

      const rows = wrong
        ? `${fit.totalNm !== null ? `<dt>Reported leg</dt><dd>${escapeHtml(fmt.nm(fit.totalNm))}</dd>` : ''}
           ${fit.flownNm !== null ? `<dt>From ${place(origin)}</dt><dd>${escapeHtml(fmt.nm(fit.flownNm))}</dd>` : ''}
           ${fit.remainingNm !== null ? `<dt>To ${place(destination)}</dt><dd>${escapeHtml(fmt.nm(fit.remainingNm))}</dd>` : ''}`
        : `${fit.flownNm !== null ? `<dt>Flown from origin</dt><dd>${escapeHtml(fmt.nm(fit.flownNm))}</dd>` : ''}
           ${fit.remainingNm !== null ? `<dt>Remaining</dt><dd>${escapeHtml(fmt.nm(fit.remainingNm))}</dd>` : ''}
           ${etaSec !== null ? `<dt>Arrival at this speed</dt><dd>${escapeHtml(fmt.duration(etaSec))}</dd>` : ''}`;

      routeBlock = `
        <h3 class="block-title">Reported route${airline?.name ? ` \u00b7 ${escapeHtml(airline.name)}` : ''}${wrong ? ' <span class="tag tag-warn">unverified</span>' : ''}</h3>
        ${note}
        <ul class="detail-zones">
          ${leg(origin, 'From')}
          ${leg(destination, 'To')}
        </ul>
        <dl class="kv">${rows}</dl>
        ${wrong ? '' : '<button class="btn btn-sm" type="button" id="detail-route">Frame the whole route</button>'}`;
    }

    // Whatever the route lookup said, or did not say, a flight can be looked up
    // by callsign at a source that knows today's leg rather than the callsign's
    // usual one. This is the check Jaron was doing by hand.
    const checkBlock = isAircraft && target.callsign
      ? `<p class="hint detail-check"><a class="linkish" href="https://www.flightaware.com/live/flight/${encodeURIComponent(target.callsign)}" target="_blank" rel="noopener">Check ${escapeHtml(target.callsign)} on FlightAware</a></p>`
      : '';

    // How much of its path we have actually watched.
    let trackBlock = '';
    if (track.length > 1) {
      let walked = 0;
      for (let i = 1; i < track.length; i++) {
        walked += distanceNm(track[i - 1][1], track[i - 1][0], track[i][1], track[i][0]);
      }
      // What the solid line is, and what it is not. The earlier part of a
      // flight cannot be drawn: no keyless ADS-B source serves history, so the
      // record starts where this system started watching.
      trackBlock = `
        <h3 class="block-title">Observed track</h3>
        <p class="hint">${track.length} positions, ${escapeHtml(fmt.nm(walked))} of path actually watched, still extending. Anything before this system first saw the target is not drawn: no keyless source serves a flight's earlier track.</p>`;
    }

    this.refs.detail.innerHTML = `
      <div class="detail-head">
        <h3>${escapeHtml(target.label)}</h3>
        <span class="detail-kind">${isAircraft ? 'aircraft' : 'vessel'}</span>
      </div>
      <p class="detail-sub">${escapeHtml(
        isAircraft
          ? [target.callsign, target.typeCode, flags.join(', ')].filter(Boolean).join(' · ') || 'no additional identity data'
          : [target.typeDesc, target.navStatusDesc].filter(Boolean).join(' · ')
      )}</p>
      <dl class="kv">
        ${rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')}
      </dl>
      ${zoneRows ? `<h3 class="block-title">Zone checks</h3><ul class="detail-zones">${zoneRows}</ul>` : '<p class="hint">No zone interaction projected within the horizon.</p>'}
      ${pairRisk ? `<h3 class="block-title">Closest approaches</h3><ul class="detail-zones">${pairRisk}</ul>` : ''}
      ${landedBlock}
      ${routeBlock}
      ${checkBlock}
      ${trackBlock}
      <div class="form-actions">
        <button class="btn btn-sm" type="button" id="detail-center">Center map on target</button>
        ${routeBlock.includes('id="detail-route"') ? '' : ''}
        <button class="btn btn-sm" type="button" id="detail-clear">Close</button>
      </div>`;

    $('detail-center')?.addEventListener('click', () => this.handlers.centerTarget?.(target.key));
    $('detail-clear')?.addEventListener('click', () => this.handlers.clearSelection?.());
    $('detail-route')?.addEventListener('click', () => this.handlers.frameRoute?.(target.key));
  }

  /* ---------- zones ---------- */

  renderZones(zones, zoneAlertCounts) {
    const userCount = zones.filter((z) => z.userDrawn).length;
    this.refs.zoneCount.textContent = `${zones.length} loaded${userCount ? `, ${userCount} drawn` : ''}`;

    this.refs.zoneList.innerHTML = zones
      .map((zone) => {
        const style = zoneStyle(zone.kind);
        const hit = zoneAlertCounts.get(zone.id);
        const size = zone.shape === 'circle' ? `${zone.radiusNm.toFixed(1)} NM radius` : 'polygon';
        const ceiling = zone.ceilingFt >= 60000 ? 'unlimited' : `${int(zone.ceilingFt)} ft${zone.agl ? ' AGL' : ''}`;
        const tags = [style.label, size, `to ${ceiling}`];
        if (zone.advisory) tags.push('advisory only');
        if (zone.approx) tags.push('approximate');
        return `
        <li class="zone-item ${hit ? 'breached' : ''}">
          <input type="checkbox" class="zone-toggle" data-id="${escapeHtml(zone.id)}" ${zone.enabled ? 'checked' : ''} aria-label="Enable ${escapeHtml(zone.name)}">
          <span class="zone-name">
            <button type="button" data-zoom="${escapeHtml(zone.id)}">${escapeHtml(zone.name)}</button>
            <div class="zone-meta">${escapeHtml(style.label)} · ${escapeHtml(size)} · to ${escapeHtml(ceiling)}${zone.approx ? ' · approximate' : ''}</div>
          </span>
          <span class="zone-actions">
            ${hit ? `<span class="alert-glyph" style="background:${SEVERITY[hit.worst].color}" title="${hit.count} alerting">${hit.count}</span>` : ''}
            ${zone.userDrawn ? `<button class="zone-delete" type="button" data-delete="${escapeHtml(zone.id)}" aria-label="Delete ${escapeHtml(zone.name)}">&times;</button>` : ''}
          </span>
        </li>`;
      })
      .join('');

    for (const input of this.refs.zoneList.querySelectorAll('.zone-toggle')) {
      input.addEventListener('change', () => this.handlers.toggleZone?.(input.dataset.id, input.checked));
    }
    for (const button of this.refs.zoneList.querySelectorAll('[data-zoom]')) {
      button.addEventListener('click', () => this.handlers.zoomZone?.(button.dataset.zoom));
    }
    for (const button of this.refs.zoneList.querySelectorAll('[data-delete]')) {
      button.addEventListener('click', () => this.handlers.deleteZone?.(button.dataset.delete));
    }
  }

  /* ---------- legend ---------- */

  renderLegend() {
    const altRows = [...ALTITUDE_BANDS]
      .reverse()
      .map((b) => `<div class="legend-row"><span class="legend-swatch" style="background:${b.color}"></span>${b.label}</div>`)
      .join('');

    const vesselRows = `
      <div class="legend-row"><span class="legend-swatch" style="background:${VESSEL_UNDERWAY}"></span>vessel under way</div>
      <div class="legend-row"><span class="legend-swatch" style="background:${VESSEL_STATIC}"></span>vessel moored, anchored or stopped</div>`;

    const severityRows = ['critical', 'serious', 'warning', 'notice']
      .map((s) => `<div class="legend-row"><span class="alert-glyph" style="background:${SEVERITY[s].color}">${SEVERITY[s].glyph}</span>${SEVERITY[s].label}</div>`)
      .join('');

    const zoneRows = Object.entries(ZONE_KIND_STYLE)
      .map(([, style]) => `<div class="legend-row"><span class="legend-dash" style="border-top-color:${style.color};border-top-style:${style.dash.length > 1 ? 'dashed' : 'solid'}"></span>${style.label}</div>`)
      .join('');

    this.refs.legend.innerHTML = `
      <div class="legend-group"><h3>Aircraft altitude</h3>${altRows}</div>
      <div class="legend-group"><h3>Vessels</h3>${vesselRows}</div>
      <div class="legend-group"><h3>Alert severity</h3>${severityRows}</div>
      <div class="legend-group"><h3>Zone kind (outline style also differs)</h3>${zoneRows}</div>
      <div class="legend-group"><h3>Contact age</h3>
        <div class="legend-row"><span class="legend-swatch" style="background:${VESSEL_STATIC};opacity:1"></span>reported in the last 45 s</div>
        <div class="legend-row"><span class="legend-swatch" style="background:${VESSEL_STATIC};opacity:0.35"></span>faded: position is going stale</div>
      </div>`;
  }

  /* ---------- feed health ---------- */

  renderFeedChips(feeds) {
    // The header chips were removed as clutter; the toggles carry the state
    // now. Kept as a no-op so nothing that still calls it has to change.
    if (!this.refs.feedChips) return;
    this.refs.feedChips.innerHTML = Object.entries(feeds)
      .map(([name, status]) => {
        const state = status.state || 'idle';
        const color = { live: SEVERITY.good.color, degraded: SEVERITY.warning.color, down: SEVERITY.critical.color, paused: SEVERITY.notice.color }[state] || SEVERITY.notice.color;
        const glyph = { live: '●', degraded: '△', down: '!', paused: '‖' }[state] || '●';
        const detail = state === 'live'
          ? `<b>${int(status.count)}</b> targets · ${fmt.ago(status.lastSuccess)}`
          : state === 'paused'
            ? 'paused'
            : status.stale
              // Keep the count visible: the picture is real, just not current.
              ? `<b>${int(status.count)}</b> targets · stale ${Math.round(status.ageMs / 1000)}s`
              : escapeHtml(status.lastError || state);
        return `<span class="chip" title="${escapeHtml(name)}: ${escapeHtml(status.lastError || state)}">
            <span class="glyph" style="color:${color}" aria-hidden="true">${glyph}</span>
            <span>${escapeHtml(name)}</span>
            <span>${detail}</span>
          </span>`;
      })
      .join('');
  }

  /**
   * Make the detail panel visible wherever it currently sits: at the top of
   * the right rail on a wide screen, or below the map on a phone.
   */
  focusDetail(hasSelection) {
    const panel = document.querySelector('.panel-right');
    panel?.classList.toggle('has-selection', Boolean(hasSelection));
    if (!hasSelection) return;
    const block = document.getElementById('detail-block');
    if (!block) return;
    // Below this width the detail becomes a fixed sheet over the map, which
    // needs no scrolling at all.
    if (window.matchMedia('(max-width: 1040px)').matches) return;

    const rect = block.getBoundingClientRect();
    const offScreen = rect.top > window.innerHeight - 160 || rect.bottom < 80;
    if (offScreen) block.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    else panel?.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------- tracking areas ---------- */

  renderTracking(areas, max) {
    this.refs.trackNote.textContent = areas.length
      ? `${areas.length} of ${max} pinned`
      : 'following the map view';

    if (!areas.length) {
      this.refs.trackList.innerHTML =
        '<li class="hint">Loading whatever is on screen. Pin an area to keep loading it while you scroll elsewhere.</li>';
      return;
    }

    this.refs.trackList.innerHTML = areas
      .map((area) => {
        const size = area.shape === 'box'
          ? `box, ${Math.round((area.bounds.north - area.bounds.south) * 60)} x ${Math.round((area.bounds.east - area.bounds.west) * 60 * Math.cos((area.center.lat * Math.PI) / 180))} NM`
          : `circle, ${area.radiusNm < 10 ? area.radiusNm.toFixed(1) : Math.round(area.radiusNm)} NM radius`;
        return `
        <li class="zone-item">
          <span class="zone-swatch" style="color:${INK_SECONDARY};background:transparent"></span>
          <span class="zone-name">
            <button type="button" data-track-zoom="${escapeHtml(area.id)}">${escapeHtml(size)}</button>
            <div class="zone-meta">${area.center.lat.toFixed(2)}, ${area.center.lon.toFixed(2)}</div>
          </span>
          <span class="zone-actions">
            <button class="zone-delete" type="button" data-track-remove="${escapeHtml(area.id)}" aria-label="Remove tracking area">&times;</button>
          </span>
        </li>`;
      })
      .join('');

    for (const button of this.refs.trackList.querySelectorAll('[data-track-zoom]')) {
      button.addEventListener('click', () => this.handlers.zoomTrackingArea?.(button.dataset.trackZoom));
    }
    for (const button of this.refs.trackList.querySelectorAll('[data-track-remove]')) {
      button.addEventListener('click', () => this.handlers.removeTrackingArea?.(button.dataset.trackRemove));
    }
  }

  /** One pause control per feed, so planes and ships stop independently. */
  renderFeedToggles(paused, feeds) {
    this.refs.feedToggles.innerHTML = [
      ['aircraft', 'Planes'],
      ['vessels', 'Ships'],
    ]
      .map(([kind, label]) => {
        const isPaused = Boolean(paused[kind]);
        const status = feeds[kind] || {};
        const state = status.state || 'idle';
        const dot = isPaused ? SEVERITY.notice.color : state === 'live' ? SEVERITY.good.color : state === 'down' ? SEVERITY.critical.color : SEVERITY.warning.color;
        // The toggle is the one place in the header that says how each feed
        // is doing: its state, and how many targets it is carrying.
        const word = isPaused ? 'paused' : state === 'down' ? 'down' : state === 'degraded' ? 'stale' : state === 'live' ? 'live' : 'starting';
        const count = Number.isFinite(status.count) && state !== 'idle' ? `<span class="feed-count"> \u00b7 ${int(status.count)}</span>` : '';
        const detail = status.lastError ? `. ${status.lastError}` : '';
        return `<button class="btn btn-sm feed-toggle" type="button" data-feed="${kind}" aria-pressed="${isPaused}" title="${isPaused ? 'Resume' : 'Pause'} the ${label.toLowerCase()} feed${escapeHtml(detail)}">
            <span class="dot" style="background:${dot}"></span>${label}: ${word}${count}
          </button>`;
      })
      .join('');

    for (const button of this.refs.feedToggles.querySelectorAll('[data-feed]')) {
      button.addEventListener('click', () => this.handlers.toggleFeed?.(button.dataset.feed));
    }
  }

  setStatus(text, { issue = null } = {}) {
    this.refs.statusText.textContent = text;
    // Clipped to one line in CSS, so the whole of it lives on the title where
    // it can be read without being able to shove the layout sideways.
    this.refs.statusText.title = text;

    const dot = this.refs.feedbarDot;
    if (dot) {
      const severity = issue === 'down' ? SEVERITY.critical : issue === 'degraded' ? SEVERITY.warning : null;
      dot.hidden = !severity;
      if (severity) dot.style.background = severity.color;
    }
  }

  /* ---------- map overlays ---------- */

  showTooltip(props, point) {
    const node = this.refs.tooltip;
    if (!props) {
      node.hidden = true;
      return;
    }
    node.hidden = false;

    // Feature properties come back from the map as strings or nulls, so be
    // defensive about types here.
    const speed = Number(props.speed);
    const alt = Number(props.alt);
    let line;
    if (props.kind === 'vessel') {
      line = [
        props.typeDesc,
        Number.isFinite(speed) ? (speed < 0.5 ? 'stopped' : `${speed.toFixed(1)} kt`) : null,
      ].filter(Boolean).join(' \u00b7 ') || 'click for detail';
    } else {
      line = [
        props.onGround === true || props.onGround === 'true' ? 'on the ground' : Number.isFinite(alt) ? `${int(alt)} ft` : null,
        Number.isFinite(speed) ? `${int(speed)} kt` : null,
      ].filter(Boolean).join(' \u00b7 ') || 'click for detail';
    }
    const ageSec = Number(props.ageSec);
    if (Number.isFinite(ageSec) && ageSec > 20) line += ` \u00b7 ${fmt.duration(ageSec)} ago`;
    node.innerHTML = `<b>${escapeHtml(props.label)}</b><span>${escapeHtml(line)}</span>`;
    const wrap = node.parentElement.getBoundingClientRect();
    const left = Math.min(point.x + 14, wrap.width - node.offsetWidth - 10);
    const top = Math.min(point.y + 14, wrap.height - node.offsetHeight - 10);
    node.style.left = `${Math.max(8, left)}px`;
    node.style.top = `${Math.max(8, top)}px`;
  }

  showBanner(message, action) {
    const node = this.refs.banner;
    if (!message) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.innerHTML = `<span>${escapeHtml(message)}</span>`;
    if (action) {
      const button = document.createElement('button');
      button.className = 'btn btn-sm';
      button.type = 'button';
      button.textContent = action.label;
      button.addEventListener('click', action.onClick);
      node.appendChild(button);
    }
  }

  setDrawHint(text) {
    this.refs.drawHint.hidden = !text;
    this.refs.drawHint.textContent = text || '';
  }

  /* ---------- data table ---------- */

  renderTable(targets) {
    const rows = targets
      .slice()
      .sort((a, b) => (a.label || '').localeCompare(b.label || ''))
      .map((t) => `
        <tr>
          <td>${escapeHtml(t.label)}</td>
          <td>${t.kind === 'aircraft' ? 'aircraft' : 'vessel'}</td>
          <td class="num">${t.lat.toFixed(3)}</td>
          <td class="num">${t.lon.toFixed(3)}</td>
          <td class="num">${t.kind === 'aircraft' ? escapeHtml(fmt.alt(t)) : '-'}</td>
          <td class="num">${escapeHtml(fmt.speed(t.groundSpeed ?? t.sog))}</td>
          <td class="num">${escapeHtml(fmt.bearing(t.track ?? t.cog))}</td>
          <td>${escapeHtml(t.typeDesc || t.typeCode || '-')}</td>
          <td class="num">${escapeHtml(fmt.duration(targetAgeSec(t)))}</td>
          <td>${escapeHtml(t.source || '-')}</td>
        </tr>`)
      .join('');

    this.refs.tableWrap.innerHTML = `
      <table>
        <thead><tr><th>Label</th><th>Kind</th><th>Lat</th><th>Lon</th><th>Altitude</th><th>Speed</th><th>Course</th><th>Type</th><th>Last report</th><th>Feed</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="10">No contacts.</td></tr>'}</tbody>
      </table>`;
  }
}
