#!/usr/bin/env node
// The repo's mechanical rules, checked rather than remembered.
//
//   node scripts/check-rules.mjs                    the working tree, and the commits not yet on origin
//   node scripts/check-rules.mjs --range=A..B       each commit in a range (CI, on a push)
//   node scripts/check-rules.mjs --range=A..B --net the range as one change (CI, on a pull request,
//                                                   whose branch holds commits from before this check)
//
// 1. Every commit that changes a file the site serves bumps CACHE in
//    website/sw.js. The installed app only refreshes on a bump, and the
//    bump is what shows "SCS.2 updated" on a page left open.
// 2. Every PRECACHE entry is a file that exists.
// 3. Every file the site serves is in PRECACHE, or is in NOT_PRECACHED
//    below with the reason it is fetched only when needed.
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SITE = path.join(ROOT, 'website');
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });

// The deploy deletes these before publishing (netlify.toml), so they are
// not site files.
const notServed = (f) => /(^|\/)CLAUDE\.md$/.test(f) || /(^|\/)tests\//.test(f);

// Served but left out of PRECACHE on purpose: each is big, or needed by
// only some devices or some pages, so it is fetched when first wanted
// and the service worker keeps it then.
const NOT_PRECACHED = [
  [/^sw\.js$/, 'the service worker itself'],
  [/^favicon\.ico$/, 'asked for by the browser, not by a page'],
  [/(^|\/)(LICENSE[^/]*|[^/]+\.(txt|md))$/, 'licences and notes beside vendored files'],
  [/^assets\/email\//, 'pictures the confirmation email loads'],
  [/^assets\/ffmpeg\/ffmpeg-core\./, 'the 31MB video engine, loaded by a compress run that needs it'],
  [/^assets\/ffmpeg-mt\//, 'the multi-threaded video engine, loaded by a compress run on the isolated compress page'],
  [/^assets\/fonts\//, 'the Helvetica stand-in, fetched only by a device without Helvetica Neue'],
  [/^assets\/heic\//, 'the 3MB HEIC decoder, needed only by a phone that is not Safari'],
  [/^assets\/maplibre\/fonts\//, 'map label glyphs outside the ranges precached, fetched as a map shows them'],
  [/^assets\/(mp4box|mp4-muxer)\//, 'the compressor\'s demuxer and muxer, loaded when a run starts'],
  [/^assets\/pdfjs\//, 'PDF.js, loaded by the worker\'s file pages and not by the site'],
  [/^assets\/photo-view\.js$/, 'loaded by the worker\'s file pages and not by the site'],
  [/^tab\/replay\/track-clean\.js$/, 'the GPX cleaner, run by tracks/clean.mjs and the dashboard and not by a page'],
  [/^scs1-tab\//, 'pages no menu links to; kept once opened'],
  [/^(rego|terms|gallery|albums|compress|recap)\//, 'pages not needed offline on the day; kept once opened'],
  [/^tab\/(team|replay)\//, 'pages that open after the event; kept once opened'],
  [/^questlist\/full\/index\.html$/, 'a page nothing links to; its script and styles are the quest list\'s'],
  [/^assets\/ffmpeg\/[^/]+\.js$/, 'the compressor\'s engine wrappers, of no use without the 31MB core'],
  [/^assets\/(push|slideshow|photo-strip|photo-details)\.(js|css)$/, 'loaded only by pages that are not precached']
];

const args = process.argv.slice(2);
const rangeArg = (args.find(a => a.startsWith('--range=')) || '').slice('--range='.length);
const problems = [];

// ---- 1. the cache bump, commit by commit ----
function commitsToCheck() {
  if (rangeArg) {
    const [from, to] = rangeArg.split('..');
    // a branch pushed for the first time has no "before": check its tip
    if (!from || /^0+$/.test(from)) return [to || 'HEAD'];
    try {
      return git('rev-list', '--no-merges', rangeArg).split('\n').filter(Boolean);
    } catch {
      // a force push: "before" is no longer in the history
      return [to || 'HEAD'];
    }
  }
  try {
    return git('rev-list', '--no-merges', '@{upstream}..HEAD').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
const bumps = (diff) => /^\+var CACHE = '/m.test(diff);
const siteFiles = (names) => names.split('\n').filter(f => f.startsWith('website/') && !notServed(f.slice('website/'.length)));
const net = args.includes('--net') && rangeArg && !/^0*\.\./.test(rangeArg);
if (net) {
  const [from, to] = rangeArg.split('..');
  const files = siteFiles(git('diff', '--name-only', from + '...' + (to || 'HEAD')));
  if (files.length && !bumps(git('diff', from + '...' + (to || 'HEAD'), '--', 'website/sw.js'))) {
    problems.push(`this change touches site files (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}) without bumping CACHE in website/sw.js`);
  }
}
for (const c of net ? [] : commitsToCheck()) {
  const files = siteFiles(git('diff-tree', '--no-commit-id', '--name-only', '-r', '--root', c));
  if (!files.length) continue;
  if (!bumps(git('show', '--format=', c, '--', 'website/sw.js'))) {
    problems.push(`commit ${c.slice(0, 8)} changes site files (${files.slice(0, 3).join(', ')}${files.length > 3 ? ', …' : ''}) without bumping CACHE in website/sw.js`);
  }
}
// work not committed yet, when no range was asked for
if (!rangeArg) {
  const dirty = git('status', '--porcelain', '--', 'website').split('\n').filter(Boolean)
    .map(l => l.slice(3)).filter(f => !notServed(f.slice('website/'.length)));
  if (dirty.length && !bumps(git('diff', 'HEAD', '--', 'website/sw.js'))) {
    problems.push(`uncommitted changes to site files (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}) and CACHE in website/sw.js not bumped`);
  }
}

// ---- 2 and 3. PRECACHE against the files ----
const sw = readFileSync(path.join(SITE, 'sw.js'), 'utf8');
const list = sw.match(/var PRECACHE = \[([\s\S]*?)\n\];/);
if (!list) {
  problems.push('could not find the PRECACHE list in website/sw.js');
} else {
  const entries = [...list[1].replace(/\/\/[^\n]*/g, '').matchAll(/'([^'\n]*)'/g)].map(m => m[1]);
  const fileOf = (e) => (e === '' || e === './') ? 'index.html' : e.endsWith('/') ? e + 'index.html' : e;
  for (const e of entries) {
    if (!existsSync(path.join(SITE, fileOf(e)))) problems.push(`PRECACHE lists '${e}', which is not a file in website/`);
  }
  const precached = new Set(entries.map(fileOf));
  const served = git('ls-files', '--cached', '--others', '--exclude-standard', 'website').split('\n').filter(Boolean)
    .map(f => f.slice('website/'.length)).filter(f => !notServed(f));
  for (const f of served) {
    if (precached.has(f) || NOT_PRECACHED.some(([re]) => re.test(f))) continue;
    problems.push(`website/${f} is not in PRECACHE in website/sw.js (add it, or add it to NOT_PRECACHED in this script with the reason)`);
  }
}

if (problems.length) {
  for (const p of problems) console.log('FAIL  ' + p);
  console.log(`\n${problems.length} problem(s)`);
  process.exit(1);
}
console.log('PASS  the cache bump and PRECACHE rules hold');
