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
<style>
  @page { size: letter; margin: 0.65in 0.75in 0.6in; }

  html { font-size: 9.2pt; }
  body {
    font-family: Georgia, "Times New Roman", serif;
    line-height: 1.28;
    color: #15171a;
    margin: 0;
    hyphens: auto;
  }

  h1, h2, h3, h4 {
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    /* Never hyphenate a heading: it rendered the title as "ge-ofence". */
    hyphens: none;
    line-height: 1.2;
    color: #0b0b0b;
    break-after: avoid;
    page-break-after: avoid;
  }
  h1 { font-size: 17pt; margin: 0 0 3pt; letter-spacing: -0.01em; }
  h1 + p strong { font-size: 11pt; }
  h2 {
    font-size: 11pt;
    margin: 10pt 0 3pt;
    padding-bottom: 2pt;
    border-bottom: 0.6pt solid #c8ccd2;
  }
  h3 { font-size: 9.6pt; margin: 7.5pt 0 2pt; }

  p, li { orphans: 3; widows: 3; }
  p { margin: 0 0 4pt; }
  ul, ol { margin: 0 0 5pt; padding-left: 14pt; }
  li { margin-bottom: 1.5pt; }
  strong { color: #000; }

  /* Provenance tags read as small caps labels rather than shouting. */
  p strong:only-child { display: inline; }

  hr { border: 0; border-top: 0.6pt solid #dcdfe4; margin: 7pt 0; }

  table {
    width: 100%;
    border-collapse: collapse;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 7.4pt;
    margin: 2pt 0 6pt;
    break-inside: auto;
  }
  th, td { border: 0.5pt solid #ccd1d7; padding: 2pt 3.5pt; text-align: left; vertical-align: top; }
  th { background: #eef1f4; font-weight: 600; }
  tr { break-inside: avoid; page-break-inside: avoid; }

  pre {
    background: #f5f6f8;
    border: 0.5pt solid #d8dce1;
    border-radius: 3pt;
    padding: 5pt 6pt;
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 7pt;
    line-height: 1.26;
    overflow: hidden;
    white-space: pre;
    break-inside: avoid;
    page-break-inside: avoid;
    margin: 3pt 0 7pt;
  }
  code {
    font-family: ui-monospace, "SFMono-Regular", Consolas, monospace;
    font-size: 8.8pt;
    background: #f1f3f5;
    padding: 0 1.5pt;
    border-radius: 2pt;
  }
  pre code { background: none; padding: 0; font-size: inherit; }

  a { color: #123f78; text-decoration: none; word-break: break-all; }

  /* The reference list is dense by nature; let it breathe less. */
  h2#references ~ ol li, h2[id^="12"] ~ ol li { margin-bottom: 3.5pt; }
</style></head><body>${body}</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'load' });

await page.pdf({
  path: output,
  format: 'Letter',
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="width:100%;font:8pt system-ui,sans-serif;color:#7b8189;padding:0 0.75in;display:flex;justify-content:space-between;">' +
    '<span>flysdown: live ADS-B and AIS dashboard with geofence projection</span>' +
    '<span class="pageNumber"></span></div>',
  margin: { top: '0.65in', bottom: '0.6in', left: '0.75in', right: '0.75in' },
});

await browser.close();

// Page count straight out of the PDF, so the target is measured not guessed.
const pdf = await readFile(output);
const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
console.log(`${output}: ${pages} pages, ${(pdf.length / 1024).toFixed(0)} KB, from ${source.split(/\s+/).length} words`);
