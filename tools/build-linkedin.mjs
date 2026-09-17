#!/usr/bin/env node
/**
 * Build the LinkedIn carousel: node tools/build-linkedin.mjs [outdir-of-shots]
 *
 * LinkedIn renders an uploaded PDF as a swipeable carousel, one page per card,
 * so this is square (1080 by 1080) with type big enough to read on a phone.
 * It is deliberately a different artifact from docs/flysdown-paper.pdf: the
 * paper is for reading, this is for scrolling past.
 *
 * Styled in jaronwilson.dev and jaronwilson.org's own palette and type.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const shots = process.argv[2] || '/home/jaron/.claude/jobs/027c943c/tmp/deck';
const output = process.argv[3] || 'docs/flysdown-linkedin.pdf';

/** Inline as data URIs: setContent has no base URL for file paths to resolve against. */
async function image(name) {
  const buffer = await readFile(`${shots}/${name}`);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

const [dcShot, routeShot, shipShot] = await Promise.all([
  image('01-dc.png'),
  image('02-route.png'),
  image('03-ships.png'),
]);

const slides = [
  {
    kind: 'cover',
    eyebrow: 'Side project &middot; September 2026',
    title: 'flysdown',
    lede: 'Live aircraft and ships on one map, with a detection engine that warns before something enters restricted airspace.',
    meta: 'flysdown.jaronwilson.dev',
  },
  {
    eyebrow: 'What you are looking at',
    title: '39 seconds from prohibited airspace',
    image: routeShot,
    caption:
      'A live warning over the National Mall, and the selected regional jet drawn back to Newark where it took off, with the distance flown, the distance remaining and an arrival time at its current speed.',
  },
  {
    eyebrow: 'What it does',
    title: 'Four questions, answered live',
    bullets: [
      'Is anything inside restricted airspace right now, and at what altitude?',
      'If nothing changes, what enters a zone next, and how long have we got?',
      'Are two ships converging on each other, and how close will they pass?',
      'Where did this flight come from, and where is it going?',
    ],
  },
  {
    eyebrow: 'The problem nobody warns you about',
    title: 'Serverless has no IP address of its own',
    stat: '1 in 8',
    statNote: 'polls succeeded from the edge before the fix',
    body:
      'Community ADS-B feeds rate-limit by IP, and a Cloudflare Worker egresses from addresses shared with every other customer on the platform. Measured from production: adsb.lol returned 429 on most attempts, adsb.fi served a bot challenge every time, and OpenSky did not answer at all. None of them send CORS headers, so the browser cannot call them either. Changing source does not fix it. The address is the problem.',
  },
  {
    eyebrow: 'The fix',
    title: 'Move the fetch, not the source',
    body:
      'A small poller runs where the IP is ordinary. It asks the site which map areas people are actually looking at, fetches those, and pushes snapshots into Cloudflare D1, which the edge reads first. Demand driven, so it follows the map instead of polling a fixed list of cities.',
    diagram: `browser  ->  /api/aircraft  ->  D1 snapshot (fresh)   <-  relay, every 8 s
                          |
                          +->  aggregators directly (usually refused)
                          +->  last known good, labeled stale with its age`,
    stat: '2 to 9 s',
    statNote: 'age of live aircraft data in production, about 490 targets',
  },
  {
    eyebrow: 'Detection, part one',
    title: 'Projected airspace entry',
    body:
      'Every target is dead-reckoned forward and checked against each zone in three dimensions, so a jet at 35,000 ft over a surface-to-18,000 ft prohibited area is correctly not an incursion, while one descending into the band is caught. The step size is tied to each zone\\u2019s own radius, because a fixed 15 second step at 500 knots walks straight over a one mile circle, and the crossing time is then refined by bisection.',
    quote: 'N9287Y reaches P-40 Thurmont in 56s, 5000 ft',
    quoteNote: 'a real alert, over Camp David',
  },
  {
    eyebrow: 'Detection, part two',
    title: 'Two ships, one relative track',
    image: shipShot,
    caption:
      'Closest Point of Approach by relative motion, the same alarm model an ARPA radar uses: a preset CPA limit and a warning time. The tightest pair measured so far was projected to pass 0.32 NM apart, 2 minutes 14 seconds out.',
  },
  {
    eyebrow: 'Getting the boring parts right',
    title: 'Real airspace, and honest staleness',
    bullets: [
      'Zone geometry is the FAA\\u2019s own published Special Use Airspace, not hand-drawn. Their one-mile circles ship as 6,285-point polygons; simplification takes that to 17 with no visible difference.',
      'Transiting the DC Special Flight Rules Area with a clearance is routine, so it is advisory: drawn and reported, never alerted. That change took one view from 55 alerts to 3 real ones.',
      'When every upstream refuses, the map shows the last good picture labeled with its age. A dashboard that quietly shows five minute old positions as current is worse than one showing nothing.',
    ],
  },
  {
    eyebrow: 'By the numbers',
    title: 'What it took',
    stats: [
      ['5,780', 'lines, no framework, no build step'],
      ['26', 'unit tests, plus a real-browser smoke test'],
      ['16', 'restricted zones from FAA data'],
      ['4', 'live data sources, none needing a key'],
      ['$0', 'hosting: Cloudflare free tier'],
      ['9', 'page write-up of how it all works'],
    ],
  },
  {
    kind: 'cover',
    eyebrow: 'Have a look',
    title: 'flysdown.jaronwilson.dev',
    lede:
      'ADS-B from adsb.fi and adsb.lol, AIS from Fintraffic Digitraffic, airspace from the FAA, routes from adsbdb, basemap from OpenFreeMap. Built on Cloudflare Pages with MapLibre GL JS.',
    meta: 'Jaron Wilson &middot; jaronwilson.dev &middot; jaronwilson.org',
  },
];

const escape = (v) => String(v ?? '');

function renderSlide(slide, index, total) {
  const number = `${index + 1} / ${total}`;
  const body = [];

  if (slide.lede) body.push(`<p class="lede">${escape(slide.lede)}</p>`);
  if (slide.stat) {
    body.push(`<div class="stat"><span class="stat-value">${escape(slide.stat)}</span><span class="stat-note">${escape(slide.statNote)}</span></div>`);
  }
  if (slide.body) body.push(`<p class="body">${escape(slide.body)}</p>`);
  if (slide.diagram) body.push(`<pre class="diagram">${escape(slide.diagram)}</pre>`);
  if (slide.quote) {
    body.push(`<blockquote>${escape(slide.quote)}<span>${escape(slide.quoteNote)}</span></blockquote>`);
  }
  if (slide.bullets) {
    body.push(`<ul>${slide.bullets.map((b) => `<li>${escape(b)}</li>`).join('')}</ul>`);
  }
  if (slide.stats) {
    body.push(
      `<div class="grid">${slide.stats
        .map(([value, label]) => `<div class="cell"><span class="cell-value">${escape(value)}</span><span class="cell-label">${escape(label)}</span></div>`)
        .join('')}</div>`
    );
  }
  if (slide.image) {
    body.push(`<figure><img src="${slide.image}" alt=""></figure>`);
    if (slide.caption) body.push(`<p class="caption">${escape(slide.caption)}</p>`);
  }

  return `
  <section class="slide ${slide.kind === 'cover' ? 'cover' : ''}">
    <div class="top">
      <div class="eyebrow">${escape(slide.eyebrow)}</div>
      <h2>${escape(slide.title)}</h2>
      ${body.join('\n      ')}
    </div>
    <div class="foot">
      <span>${slide.kind === 'cover' ? escape(slide.meta) : 'flysdown.jaronwilson.dev'}</span>
      <span>${slide.kind === 'cover' ? '' : number}</span>
    </div>
  </section>`;
}

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>flysdown</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --paper: #faf8f4;
    --surface: #ffffff;
    --ink: #1a1a17;
    --muted: #6b6862;
    --border: #e8e4dc;
    --accent: #b3542b;
  }
  @page { size: 1080px 1080px; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--paper); font-family: "Inter", sans-serif; color: var(--ink); }

  .slide {
    width: 1080px;
    height: 1080px;
    padding: 76px 80px 60px;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    background: var(--paper);
    break-after: page;
    page-break-after: always;
    overflow: hidden;
  }
  .slide:last-child { break-after: auto; page-break-after: auto; }
  .slide.cover { justify-content: center; text-align: left; }
  .slide.cover .top { display: flex; flex-direction: column; gap: 6px; }

  .eyebrow {
    font-size: 21px;
    font-weight: 600;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--accent);
    margin-bottom: 18px;
  }

  h2 {
    font-family: "Fraunces", Georgia, serif;
    font-weight: 600;
    font-optical-sizing: none;
    font-variation-settings: "opsz" 72;
    letter-spacing: -0.015em;
    line-height: 1.04;
    font-size: 66px;
    margin: 0 0 26px;
  }
  .cover h2 { font-size: 104px; margin-bottom: 20px; }

  .lede { font-size: 33px; line-height: 1.45; color: var(--muted); margin: 0; max-width: 21ch; }
  .cover .lede { max-width: 26ch; }
  .body { font-size: 27px; line-height: 1.5; color: var(--muted); margin: 0 0 22px; }

  ul { margin: 0; padding-left: 30px; }
  li { font-size: 27px; line-height: 1.42; color: var(--muted); margin-bottom: 20px; }
  li::marker { color: var(--accent); }

  .stat { display: flex; flex-direction: column; margin: 0 0 26px; }
  .stat-value {
    font-family: "Fraunces", Georgia, serif;
    font-weight: 600;
    font-variation-settings: "opsz" 144;
    font-size: 132px;
    line-height: 1;
    color: var(--accent);
  }
  .stat-note { font-size: 25px; color: var(--muted); margin-top: 10px; }

  .diagram {
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 19px;
    line-height: 1.55;
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: 10px;
    padding: 22px 24px;
    margin: 0 0 24px;
    white-space: pre;
    color: var(--ink);
  }

  blockquote {
    margin: 0;
    padding: 24px 28px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: 10px;
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 26px;
    color: var(--ink);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  blockquote span { font-family: "Inter", sans-serif; font-size: 22px; color: var(--muted); }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 26px 40px; }
  .cell { display: flex; flex-direction: column; gap: 4px; }
  .cell-value {
    font-family: "Fraunces", Georgia, serif;
    font-weight: 600;
    font-variation-settings: "opsz" 144;
    font-size: 62px;
    line-height: 1;
    color: var(--ink);
  }
  .cell-label { font-size: 22px; color: var(--muted); line-height: 1.3; }

  figure { margin: 0; }
  figure img {
    width: 100%;
    border-radius: 12px;
    border: 1px solid var(--border);
    display: block;
  }
  .caption { font-size: 23px; line-height: 1.42; color: var(--muted); margin: 20px 0 0; }

  .foot {
    display: flex;
    justify-content: space-between;
    font-size: 20px;
    color: var(--muted);
    border-top: 1px solid var(--border);
    padding-top: 18px;
  }
  .cover .foot { border-top: 0; }
</style></head><body>
${slides.map((slide, i) => renderSlide(slide, i, slides.length)).join('\n')}
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 } });
await page.setContent(html, { waitUntil: 'load' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1500);
await page.pdf({ path: output, width: '1080px', height: '1080px', printBackground: true, pageRanges: `1-${slides.length}` });
await browser.close();

const size = (await readFile(output)).length;
console.log(`${output}: ${slides.length} slides, ${(size / 1024).toFixed(0)} KB, 1080x1080`);
