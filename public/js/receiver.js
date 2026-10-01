/**
 * A visitor's own ADS-B receiver, read directly by their browser.
 *
 * Everyone sees the shared network feed (adsb.lol / adsb.fi through the
 * relay). A visitor who runs their own receiver, such as a Pi with readsb or
 * dump1090, can add it here, and its aircraft join the same store, so every
 * detector on the page runs on them too.
 *
 * The browser fetches the receiver itself. Nothing about it passes through
 * this site's server or is stored anywhere but that browser's localStorage,
 * which is also why it works for a receiver on a private network or a tailnet:
 * the visitor's own device can reach it even though the internet cannot.
 *
 * Browsers impose two conditions, and the messages below explain both:
 *   - this page is https, so a plain http:// receiver is blocked as mixed
 *     content, except on localhost, which browsers treat as secure;
 *   - the receiver must answer with Access-Control-Allow-Origin. tar1090's
 *     aircraft.json already does.
 *
 * No DOM in this module: the wiring lives in app.js.
 */

import { normalizeReadsb } from './readsb.js';

export const RECEIVER_SOURCE = 'your receiver';
export const RECEIVER_KEY = 'flysdown.receiver.v1';
export const RECEIVER_INTERVAL_MS = 2000;
const TIMEOUT_MS = 5000;
const MAX_BACKOFF_MS = 30000;
// readsb keeps an aircraft in aircraft.json for a minute after its last
// position, which is too stale to present beside a live network feed.
const MAX_POSITION_AGE_SEC = 30;
// How far a receiver can plausibly hear, used as its coverage area so the
// store does not prune its aircraft for being outside the network's area.
const RECEIVER_RANGE_NM = 250;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * What a visitor typed -> the aircraft.json URL to poll, or null.
 *
 * Accepts a bare receiver address ("https://my-pi.tailnet.ts.net/",
 * "localhost:8080") and adds tar1090's data/aircraft.json, or a full URL to
 * any .json file, used as given (dump1090's /data.json, for instance).
 */
export function normalizeReceiverUrl(input) {
  let text = String(input || '').trim();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const host = text.split(/[/:]/)[0].toLowerCase();
    text = `${LOCAL_HOSTS.has(host) ? 'http' : 'https'}://${text}`;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!/\.json$/i.test(url.pathname)) {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/data/aircraft.json`;
  }
  url.hash = '';
  return url.toString();
}

/** receiver.json sits next to aircraft.json on tar1090 and readsb. */
export function receiverInfoUrl(aircraftUrl) {
  const url = new URL(aircraftUrl);
  if (!/\/aircraft\.json$/i.test(url.pathname)) return null;
  url.pathname = url.pathname.replace(/aircraft\.json$/i, 'receiver.json');
  url.search = '';
  return url.toString();
}

/** Would the browser refuse this as mixed content on a page with this protocol? */
export function isMixedContent(aircraftUrl, pageProtocol) {
  const url = new URL(aircraftUrl);
  return pageProtocol === 'https:' && url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname);
}

/**
 * Turn whatever the receiver answered into normalized aircraft.
 *
 * Three shapes are in the wild: readsb/tar1090 ({ now, aircraft: [...] }),
 * the aggregator API shape ({ ac: [...] }) and the original dump1090's bare
 * array with its own field names. Throws a ReceiverError('not-aircraft') when
 * it is none of them, so the visitor is told they pointed at the wrong file.
 */
export function parseReceiverJson(json, fetchedAt = Date.now()) {
  let rows;
  if (Array.isArray(json)) rows = json.map(fromDump1090);
  else if (json && Array.isArray(json.aircraft)) rows = json.aircraft;
  else if (json && Array.isArray(json.ac)) rows = json.ac;
  else throw new ReceiverError('not-aircraft');

  return rows
    .map((raw) => normalizeReadsb(raw, RECEIVER_SOURCE))
    .filter(Boolean)
    .filter((target) => (target.seenPos ?? target.seen ?? 0) <= MAX_POSITION_AGE_SEC)
    .map((target) => ({ ...target, fetchedAt, heardByReceiver: true }));
}

/** dump1090 (antirez/MalcolmRobb) /data.json -> readsb field names. */
function fromDump1090(row) {
  if (!row || row.validposition === 0) return {};
  return {
    hex: row.hex,
    flight: row.flight,
    lat: row.lat,
    lon: row.lon,
    alt_baro: row.altitude,
    track: row.validtrack === 0 ? undefined : row.track,
    gs: row.speed,
    squawk: row.squawk,
    seen: row.seen,
    messages: row.messages,
  };
}

/** The receiver's own position, from receiver.json, or null. */
export function parseReceiverInfo(json) {
  const lat = Number(json?.lat);
  const lon = Number(json?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  return { lat, lon };
}

/** The area a receiver's aircraft count as covered by. */
export function receiverCoverage(info, targets) {
  if (info) return [{ lat: info.lat, lon: info.lon, radiusNm: RECEIVER_RANGE_NM }];
  // No readable receiver.json, which is the usual case: dump1090 has none,
  // and tar1090 sends its CORS header on aircraft.json only (measured on an
  // adsb.im Pi), so the browser may not read it. Each aircraft then covers
  // itself: the store keeps what was just heard and drops it once unreported.
  return targets.map((t) => ({ lat: t.lat, lon: t.lon, radiusNm: 1 }));
}

/** When this target's position was actually measured, in ms. */
const positionTime = (target) => (target.fetchedAt ?? 0) - 1000 * (target.seenPos ?? target.seen ?? 0);

/**
 * Network aircraft plus the receiver's, one record per aircraft.
 *
 * The fresher position wins. The other record still fills in what the winner
 * lacks: a bare receiver often has no registration or type, which the
 * aggregators add from their databases.
 */
export function mergeAircraft(network, mine) {
  const byId = new Map(network.map((t) => [t.id, t]));
  for (const own of mine) {
    const other = byId.get(own.id);
    if (!other) {
      byId.set(own.id, own);
      continue;
    }
    const ownWins = positionTime(own) >= positionTime(other);
    const [winner, loser] = ownWins ? [own, other] : [other, own];
    byId.set(own.id, {
      ...loser,
      ...withoutEmpty(winner),
      heardByReceiver: true,
      source: ownWins ? RECEIVER_SOURCE : `${other.source} + ${RECEIVER_SOURCE}`,
    });
  }
  return [...byId.values()];
}

function withoutEmpty(record) {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== null && v !== undefined && v !== ''));
}

export class ReceiverError extends Error {
  constructor(kind, detail = '') {
    super(kind);
    this.kind = kind;
    this.detail = detail;
  }
}

/** A short, actionable sentence for each way a receiver can fail. */
export function describeReceiverError(err) {
  switch (err?.kind) {
    case 'mixed-content':
      return 'This site is https, so your browser blocks a plain http:// receiver. Use its https address (for example with tailscale serve), or allow insecure content for this site in your browser settings.';
    case 'unreachable':
      return 'Could not reach it. Check the address, that this device is on the same network or tailnet as the receiver, and that the receiver allows cross-origin requests (tar1090 does).';
    case 'timeout':
      return 'It did not answer within 5 seconds.';
    case 'http':
      return `It answered HTTP ${err.detail}. Check the address points at aircraft.json.`;
    case 'not-aircraft':
      return 'It answered, but not with aircraft data. Point it at aircraft.json (tar1090/readsb) or data.json (dump1090).';
    case 'invalid-url':
      return 'That is not a usable address. Try https://your-receiver/ or http://localhost:8080/.';
    default:
      return String(err?.message || err || 'Unknown error');
  }
}

/** A few words for the header and the feed line, which are one line each. */
export function shortReceiverError(err) {
  return {
    'mixed-content': 'blocked, needs https',
    unreachable: 'not reachable',
    timeout: 'timed out',
    http: `HTTP ${err?.detail || '?'}`,
    'not-aircraft': 'not aircraft data',
    'invalid-url': 'bad address',
  }[err?.kind] || 'failed';
}

/** Fetch and parse one snapshot, classifying every failure. */
export async function fetchReceiver(aircraftUrl, { fetchImpl = fetch, pageProtocol = 'https:', now = Date.now } = {}) {
  let response;
  try {
    response = await fetchImpl(aircraftUrl, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new ReceiverError('timeout');
    // fetch reports a CORS refusal, a dead host and a mixed-content block as
    // the same TypeError, so the URL is the only clue about which it was.
    throw new ReceiverError(isMixedContent(aircraftUrl, pageProtocol) ? 'mixed-content' : 'unreachable');
  }
  if (!response.ok) throw new ReceiverError('http', String(response.status));
  let json;
  try {
    json = await response.json();
  } catch {
    throw new ReceiverError('not-aircraft');
  }
  return parseReceiverJson(json, now());
}

/** Saved settings, or the defaults. */
export function loadReceiverSettings(storage = globalThis.localStorage) {
  try {
    const saved = JSON.parse(storage?.getItem(RECEIVER_KEY) || 'null');
    if (saved && typeof saved.url === 'string') return { url: saved.url, only: Boolean(saved.only) };
  } catch {
    // Corrupt settings are treated as none.
  }
  return { url: '', only: false };
}

export function saveReceiverSettings(settings, storage = globalThis.localStorage) {
  try {
    if (!settings.url) storage?.removeItem(RECEIVER_KEY);
    else storage?.setItem(RECEIVER_KEY, JSON.stringify({ url: settings.url, only: Boolean(settings.only) }));
  } catch {
    // Private browsing can refuse storage; the receiver still works this visit.
  }
}

/**
 * Polls the receiver. Reports through the same status shape as Feed, so the
 * header and the feed line treat it like the other feeds.
 */
export class ReceiverFeed {
  constructor({ onData, onStatus, fetchImpl, pageProtocol, intervalMs = RECEIVER_INTERVAL_MS }) {
    this.onData = onData;
    this.onStatus = onStatus;
    this.fetchImpl = fetchImpl;
    this.pageProtocol = pageProtocol;
    this.intervalMs = intervalMs;
    this.url = null;
    this.info = null;
    this.timer = null;
    this.failures = 0;
    this.inFlight = false;
    this.paused = false;
    this.generation = 0;
    this.status = { state: 'off', count: 0, lastSuccess: null, lastError: null, source: RECEIVER_SOURCE };
  }

  get configured() {
    return Boolean(this.url);
  }

  report(patch) {
    this.status = { ...this.status, ...patch };
    this.onStatus?.('receiver', this.status);
  }

  /** Point at a receiver (or nothing). Returns the normalized URL or null. */
  setUrl(input) {
    clearTimeout(this.timer);
    // A poll still in flight belongs to the old address: its answer is
    // discarded by generation, and it must not block the new one.
    this.generation += 1;
    this.inFlight = false;
    this.failures = 0;
    this.info = null;
    this.url = input ? normalizeReceiverUrl(input) : null;
    if (input && !this.url) {
      const err = new ReceiverError('invalid-url');
      this.report({ state: 'down', count: 0, lastError: shortReceiverError(err), help: describeReceiverError(err), errorKind: err.kind });
      return null;
    }
    if (!this.url) {
      this.report({ state: 'off', count: 0, lastError: null, help: null, errorKind: null });
      this.onData?.({ items: [], coverages: [], fetchedAt: Date.now() });
      return null;
    }
    this.report({ state: 'idle', count: 0, lastError: null, help: null, errorKind: null });
    this.loadInfo(this.generation);
    if (!this.paused) this.poll();
    return this.url;
  }

  async loadInfo(generation) {
    const infoUrl = receiverInfoUrl(this.url);
    if (!infoUrl) return;
    try {
      const res = await (this.fetchImpl || fetch)(infoUrl, { cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok && generation === this.generation) this.info = parseReceiverInfo(await res.json());
    } catch {
      // Optional: without it, coverage falls back to the aircraft themselves.
    }
  }

  async poll() {
    if (!this.url || this.inFlight || this.paused) return;
    const generation = this.generation;
    this.inFlight = true;
    const started = Date.now();
    try {
      const items = await fetchReceiver(this.url, { fetchImpl: this.fetchImpl || fetch, pageProtocol: this.pageProtocol });
      if (generation !== this.generation) return;
      this.failures = 0;
      this.report({ state: 'live', count: items.length, lastSuccess: Date.now(), lastError: null, help: null, errorKind: null, latencyMs: Date.now() - started });
      this.onData?.({ items, coverages: receiverCoverage(this.info, items), fetchedAt: Date.now() });
    } catch (err) {
      if (generation !== this.generation) return;
      this.failures += 1;
      // Short words for the one-line chrome, the full advice for the panel.
      this.report({ state: this.failures > 2 ? 'down' : 'degraded', lastError: shortReceiverError(err), help: describeReceiverError(err), errorKind: err?.kind });
    } finally {
      if (generation === this.generation) {
        this.inFlight = false;
        this.schedule();
      }
    }
  }

  schedule() {
    clearTimeout(this.timer);
    if (this.paused || !this.url) return;
    const wait = this.failures ? Math.min(MAX_BACKOFF_MS, this.intervalMs * 2 ** this.failures) : this.intervalMs;
    this.timer = setTimeout(() => this.poll(), wait);
  }

  start() {
    this.paused = false;
    this.poll();
  }

  stop() {
    this.paused = true;
    clearTimeout(this.timer);
    if (this.url) this.report({ state: 'paused' });
  }
}
