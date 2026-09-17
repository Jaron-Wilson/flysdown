#!/usr/bin/env node
/**
 * Render docs/flysdown-paper.md to a paginated PDF.
 *
 *   node tools/build-paper.mjs [input.md] [output.pdf]
 *
 * Chromium does the typesetting, which gives real pagination, page numbers
 * and control over widows and orphans that a markdown viewer cannot.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { marked } from 'marked';
import { chromium } from 'playwright';

const input = process.argv[2] || 'docs/flysdown-paper.md';
const output = process.argv[3] || 'docs/flysdown-paper.pdf';

const source = await readFile(input, 'utf8');
const body = marked.parse(source, { gfm: true, mangle: false, headerIds: true });

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>flysdown</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  /* Typeset in jaronwilson.dev and jaronwilson.org's own palette and type, so
     the paper reads as part of the same body of work. */
  :root {
    --paper: #faf8f4;
    --surface: #ffffff;
    --ink: #1a1a17;
    --muted: #6b6862;
    --border: #e8e4dc;
    --accent: #b3542b;
  }

  @page { size: letter; margin: 0.52in 0.7in 0.5in; }

  html { font-size: 8pt; }
  body {
    font-family: "Inter", -apple-system, BlinkMacSystemFont, sans-serif;
    line-height: 1.35;
    color: var(--ink);
    background: var(--paper);
    margin: 0;
    hyphens: auto;
  }

  h1, h2, h3, h4 {
    font-family: "Fraunces", Georgia, serif;
    font-weight: 600;
    letter-spacing: -0.01em;
    font-optical-sizing: none;
    font-variation-settings: "opsz" 72;
    line-height: 1.35;
    color: var(--ink);
    break-after: avoid;
    page-break-after: avoid;
    hyphens: none;
  }
  h1 { font-size: 21pt; margin: 0 0 4pt; }
  h2 {
    font-size: 12pt;
    margin: 13pt 0 4pt;
    padding-bottom: 3pt;
    border-bottom: 1pt solid var(--accent);
  }
  h3 { font-size: 10pt; margin: 9pt 0 2pt; color: var(--accent); }

  /* The subtitle under the title, and the version line. */
  h1 + p strong { font-family: "Fraunces", Georgia, serif; font-weight: 400; font-size: 11.5pt; }

  p, li { orphans: 3; widows: 3; }
  p { margin: 0 0 4.5pt; }
  ul, ol { margin: 0 0 5pt; padding-left: 14pt; }
  li { margin-bottom: 1.5pt; }
  strong { font-weight: 600; }

  hr { border: 0; border-top: 1px solid var(--border); margin: 8pt 0; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 7.6pt;
    margin: 3pt 0 7pt;
    background: var(--surface);
  }
  th, td { border: 0.5pt solid var(--border); padding: 2.5pt 4pt; text-align: left; vertical-align: top; }
  th {
    background: #f1ece3;
    font-weight: 600;
    font-size: 7pt;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
  }
  tr { break-inside: avoid; page-break-inside: avoid; }

  pre {
    background: var(--surface);
    border: 0.5pt solid var(--border);
    border-left: 2pt solid var(--accent);
    border-radius: 3pt;
    padding: 5pt 7pt;
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 6.9pt;
    line-height: 1.3;
    overflow: hidden;
    white-space: pre;
    break-inside: avoid;
    page-break-inside: avoid;
    margin: 3pt 0 7pt;
  }
  code {
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 8.3pt;
    background: #f1ece3;
    padding: 0 2pt;
    border-radius: 2pt;
  }
  pre code { background: none; padding: 0; font-size: inherit; }

  a { color: var(--accent); text-decoration: none; word-break: break-all; }

  blockquote { margin: 0 0 6pt; padding-left: 8pt; border-left: 2pt solid var(--border); color: var(--muted); }
</style></head><body>${body}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });
// Google Fonts are remote; without this the PDF renders in the fallback face.
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1200);

await page.pdf({
  path: output,
  format: 'Letter',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font:7.5pt Inter,system-ui,sans-serif;color:#6b6862;padding:0 0.72in;display:flex;justify-content:space-between;">' +
    '<span>flysdown &middot; jaronwilson.dev</span>' +
    '<span class="pageNumber"></span></div>',
  margin: { top: '0.52in', bottom: '0.5in', left: '0.7in', right: '0.7in' },
});

await browser.close();

// Page count straight out of the PDF, so the target is measured not guessed.
const pdf = await readFile(output);
const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
console.log(`${output}: ${pages} pages, ${(pdf.length / 1024).toFixed(0)} KB, from ${source.split(/\s+/).length} words`);
