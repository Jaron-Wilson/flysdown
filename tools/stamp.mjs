/**
 * Stage a stamped copy of the site for deployment: node tools/stamp.mjs
 *
 * Cloudflare Pages will not serve this project's modules with a cache shorter
 * than four hours (measured; see public/_headers), so a returning browser can
 * run JavaScript from the previous deploy while showing the current HTML. The
 * HTML is the one thing always fresh, so it carries the truth: the copy that
 * gets uploaded has the same stamp written into index.html and app.js, and a
 * page whose app.js disagrees with its own HTML knows it is out of date and
 * says so.
 *
 * The stamp is written into a staged copy in `.deploy/` rather than into
 * `public/`, so the repository stays clean and every deploy still gets a
 * distinct stamp. `npm run dev` serves `public/` untouched, where both stamps
 * read 'dev' and nothing is reported.
 */

import { cp, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SOURCE = 'public';
const STAGED = '.deploy';

const stamp = await buildStamp();

await rm(STAGED, { recursive: true, force: true });
// Dereference: public/docs holds one link per published document, pointing at
// the copy the build scripts write in docs/, so no PDF is committed twice.
// It is one link per file rather than one link to the whole folder on
// purpose: anything dropped into docs/ would otherwise be published the next
// time somebody deployed from that checkout.
await cp(SOURCE, STAGED, { recursive: true, dereference: true });
await checkPublishedDocs();

await patch(`${STAGED}/index.html`, /<meta name="build" content="[^"]*">/, `<meta name="build" content="${stamp}">`);
await patch(`${STAGED}/app.js`, /^const BUILD_STAMP = '[^']*';$/m, `const BUILD_STAMP = '${stamp}';`);

console.log(`staged ${STAGED} with build stamp ${stamp}`);

/**
 * The published documents must be exactly the ones tracked under public/docs,
 * each a real, non-empty file once staged. A dangling link, an empty PDF, or a
 * stray file would otherwise go out silently.
 */
async function checkPublishedDocs() {
  const { stdout } = await run('git', ['ls-files', `${SOURCE}/docs`]);
  const tracked = stdout.trim().split('\n').filter(Boolean).map((path) => path.split('/').pop()).sort();
  const staged = (await readdir(`${STAGED}/docs`)).sort();
  if (staged.join('|') !== tracked.join('|')) {
    throw new Error(`published docs ${staged.join(', ')} do not match tracked ${tracked.join(', ')}`);
  }
  for (const name of staged) {
    const info = await stat(`${STAGED}/docs/${name}`);
    if (!info.isFile() || info.size === 0) throw new Error(`published doc ${name} is missing or empty`);
  }
}

async function buildStamp() {
  // The commit is the most useful thing to find in the page source. A dirty
  // tree, or no git at all, still needs a stamp that changes per deploy.
  try {
    const { stdout: head } = await run('git', ['rev-parse', '--short', 'HEAD']);
    const { stdout: dirty } = await run('git', ['status', '--porcelain']);
    const suffix = dirty.trim() ? `-${Date.now().toString(36)}` : '';
    return `${head.trim()}${suffix}`;
  } catch {
    return Date.now().toString(36);
  }
}

async function patch(path, pattern, replacement) {
  const text = await readFile(path, 'utf8');
  if (!pattern.test(text)) throw new Error(`${path} has nothing matching ${pattern} to stamp`);
  await writeFile(path, text.replace(pattern, replacement));
}
