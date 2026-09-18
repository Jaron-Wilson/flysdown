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

import { cp, rm, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SOURCE = 'public';
const STAGED = '.deploy';

const stamp = await buildStamp();

await rm(STAGED, { recursive: true, force: true });
await cp(SOURCE, STAGED, { recursive: true });

await patch(`${STAGED}/index.html`, /<meta name="build" content="[^"]*">/, `<meta name="build" content="${stamp}">`);
await patch(`${STAGED}/app.js`, /^const BUILD_STAMP = '[^']*';$/m, `const BUILD_STAMP = '${stamp}';`);

console.log(`staged ${STAGED} with build stamp ${stamp}`);

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
