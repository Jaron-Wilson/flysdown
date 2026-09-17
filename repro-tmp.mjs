import { chromium } from 'playwright';
const browser = await chromium.launch({ channel: 'chromium' });
// 7.5in of text at 96dpi is the paper's new measure; match it so the wrapping
// on screen is the wrapping in the PDF.
const page = await browser.newPage({ viewport: { width: 720, height: 1200 }, deviceScaleFactor: 2 });
await page.goto('file:///home/jaron/.claude/jobs/027c943c/tmp/paper.html', { waitUntil: 'load' });
await page.emulateMedia({ media: 'print' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(1500);
const refs = await page.$('h2:last-of-type');
await refs.scrollIntoViewIfNeeded();
await page.waitForTimeout(600);
await page.screenshot({ path: '/home/jaron/.claude/jobs/027c943c/tmp/refs-check.png' });
await browser.close();
