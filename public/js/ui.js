/**
 * Panel rendering. Takes state, writes DOM. No fetching, no geometry.
 *
 * Every status colour in here is accompanied by a glyph and a word, and the
 * altitude ramp is repeated in the legend, so nothing depends on hue alone.
 */

import { SEVERITY, ALTITUDE_BANDS, GROUND_COLOR, VESSEL_UNDERWAY, VESSEL_STATIC, zoneStyle, ZONE_KIND_STYLE } from './palette.js';

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
};

const escapeHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
      feedChips: $('feed-chips'),
      statusText: $('status-text'),
      tooltip: $('map-tooltip'),
      banner: $('map-banner'),
      tableWrap: $('table-wrap'),
      drawHint: $('draw-hint'),
    };
    this.handlers = {};
    this.renderLegend();
  }

  on(name, fn) {
    this.handlers[name] = fn;
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

    const rows = [
      ...ALTITUDE_BANDS.map((band, i) => ({ label: band.label, count: counts[i], color: band.color })),
      { label: 'on the ground', count: ground, color: GROUND_COLOR },
    ].reverse();

    const max = Math.max(1, ...rows.map((r) => r.count));
    this.refs.altTotal.textContent = `${int(aircraft.length)} tracked`;
    this.refs.altChart.innerHTML = rows
      .map(
        (row) => `
        <div class="chart-row" title="${escapeHtml(row.label)}: ${int(row.count)} aircraft">
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
              ${alert.etaSec ? `<div class="alert-eta">Time to boundary: ${fmt.eta(alert.etaSec)}</div>` : ''}
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

  renderDetail(target, evaluation) {
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
          ['Last message', `${target.seen ?? '?'} s ago`],
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
          ['Draught', target.draughtM ? `${target.draughtM.toFixed(1)} m` : 'not reported'],
          ['Length', target.lengthM ? `${target.lengthM} m` : 'not reported'],
          ['MMSI', target.mmsi],
          ['Call sign', target.callsign || 'not reported'],
          ['Feed', target.source || 'unknown'],
        ];

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
      <button class="btn btn-sm" type="button" id="detail-centre">Centre map on target</button>`;

    $('detail-centre')?.addEventListener('click', () => this.handlers.centreTarget?.(target.key));
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
      <div class="legend-group"><h3>Zone kind (outline style also differs)</h3>${zoneRows}</div>`;
  }

  /* ---------- feed health ---------- */

  renderFeedChips(feeds) {
    this.refs.feedChips.innerHTML = Object.entries(feeds)
      .map(([name, status]) => {
        const state = status.state || 'idle';
        const colour = { live: SEVERITY.good.color, degraded: SEVERITY.warning.color, down: SEVERITY.critical.color, paused: SEVERITY.notice.color }[state] || SEVERITY.notice.color;
        const glyph = { live: '●', degraded: '△', down: '!', paused: '‖' }[state] || '●';
        const detail = state === 'live'
          ? `<b>${int(status.count)}</b> targets · ${status.latencyMs} ms`
          : state === 'paused'
            ? 'paused'
            : escapeHtml(status.lastError || state);
        return `<span class="chip" title="${escapeHtml(name)}: ${escapeHtml(status.lastError || state)}">
            <span class="glyph" style="color:${colour}" aria-hidden="true">${glyph}</span>
            <span>${escapeHtml(name)}</span>
            <span>${detail}</span>
          </span>`;
      })
      .join('');
  }

  setStatus(text) {
    this.refs.statusText.textContent = text;
  }

  /* ---------- map overlays ---------- */

  showTooltip(props, point) {
    const node = this.refs.tooltip;
    if (!props) {
      node.hidden = true;
      return;
    }
    node.hidden = false;
    node.innerHTML = `<b>${escapeHtml(props.label)}</b><span>${
      props.alt === null || props.alt === undefined || props.alt === 'null'
        ? 'click for detail'
        : `${int(props.alt)} ft`
    }</span>`;
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
          <td>${escapeHtml(t.source || '-')}</td>
        </tr>`)
      .join('');

    this.refs.tableWrap.innerHTML = `
      <table>
        <thead><tr><th>Label</th><th>Kind</th><th>Lat</th><th>Lon</th><th>Altitude</th><th>Speed</th><th>Course</th><th>Type</th><th>Feed</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="9">No contacts.</td></tr>'}</tbody>
      </table>`;
  }
}
