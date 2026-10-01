/**
 * /api/skywatch - where SkyWatch results used to be served, kept so that
 * anyone who curls it learns how to run the detector themselves.
 *
 * SkyWatch (the LU AI Club's No-Fly-Zone Detector) is no longer hosted for
 * this site: nothing runs it on a server any more. It runs on the caller's
 * own computer, fetching aircraft straight from adsb.lol and the zones from
 * this site's static /data/zones.json, and prints its scored report there.
 * This endpoint therefore carries no detections and stores nothing; it only
 * answers with that explanation, as JSON or (?format=text) for a terminal.
 */

export const REPO = 'https://github.com/Jaron-Wilson/ai-club-skywatch.git';
export const BRANCH = 'jaron-wilson/flysdown-live';

export const STEPS = [
  `git clone -b ${BRANCH} ${REPO}`,
  'cd ai-club-skywatch && python3 -m venv .venv && . .venv/bin/activate',
  'pip install -e ".[nfz]"',
  'python -m air.detectors.no_fly_zone.live --once',
];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, OPTIONS',
  'access-control-allow-headers': 'accept',
  'access-control-max-age': '86400',
};

export function selfRunInfo() {
  return {
    ok: false,
    status: 'self_run',
    reason: 'SkyWatch is not hosted here. Run it on your own computer; it fetches live aircraft from adsb.lol itself.',
    experimental: true,
    steps: STEPS,
    watch: 'python -m air.detectors.no_fly_zone.live',
    json: 'python -m air.detectors.no_fly_zone.live --once --print json',
    zones: 'https://flysdown.jaronwilson.dev/data/zones.json',
    requires: 'Python 3.11+ and git',
  };
}

export function renderText(info = selfRunInfo()) {
  return [
    'SkyWatch No-Fly-Zone Detector  (EXPERIMENTAL - not for navigation)',
    'LU AI Club SkyWatch, with zones from Project Flys Down: https://flysdown.jaronwilson.dev',
    '',
    info.reason,
    `You need ${info.requires}.`,
    '',
    ...info.steps.map((step, i) => `  ${i + 1}. ${step}`),
    '',
    `Keep watching:  ${info.watch}`,
    `Full JSON:      ${info.json}`,
    '',
    'Each detection prints its score as base + depth - context penalty, with any',
    'severity cap. "No aircraft inside a zone volume" is a real result; NOT EVALUATED',
    'means the aircraft data was too old or unavailable.',
    '',
  ].join('\n');
}

export const onRequestOptions = async () => new Response(null, { status: 204, headers: CORS });

export const onRequestGet = async ({ request }) => {
  const asText = new URL(request.url).searchParams.get('format') === 'text';
  const headers = { 'cache-control': 'public, max-age=300', ...CORS };
  if (asText) {
    return new Response(renderText(), { headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
  }
  return new Response(JSON.stringify(selfRunInfo()), { headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });
};

/** Nothing accepts reports any more. */
export const onRequestPost = async () =>
  new Response(JSON.stringify({ ok: false, error: 'SkyWatch reports are no longer accepted here; it runs on your own computer.' }), {
    status: 410,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
