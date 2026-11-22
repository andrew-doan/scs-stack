#!/usr/bin/env node
// Which suites does this change actually need?
//
//   node scripts/affected.mjs            what changed against HEAD, and what to run
//   node scripts/affected.mjs --run      run them
//   node scripts/affected.mjs --all      every suite, for a release
//   node scripts/affected.mjs --since=<ref>   changed against a ref instead of HEAD
//   --workers / --browsers                    only the worker suites, or only the browser ones
//
// The browser suites take about seven and a half minutes end to end and
// the worker suites about fifteen seconds. Running everything after
// every edit spends most of that on files the edit could not reach —
// the worker suites never touch website/, and a change to one page
// cannot break another page's own suite. So the rule is: run what the
// change can reach, and run it once, after the last edit.
//
// The map below is deliberately coarse where the code is interlinked.
// src/index.ts and src/shared.ts route and serve everything, and the
// whole worker set is fifteen seconds, so any worker change runs all of
// it rather than pretending to know which module a route touches.
import { execSync, spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TAB = path.join(HERE, '..');
const ROOT = path.join(TAB, '..');
const TESTS = path.join(TAB, 'tests');

// Roughly how long each suite takes, measured on this container. Only
// used to print what a run will cost, so nobody has to guess whether it
// is worth narrowing further.
const SECONDS = {
  'verify-anywhere.cjs': 10, 'verify-app-layout.cjs': 18, 'verify-ask.cjs': 33,
  'verify-bell.cjs': 42, 'verify-compress.cjs': 32, 'verify-console-ui.cjs': 32,
  'verify-console-direct.cjs': 6, 'verify-countdown.cjs': 11, 'verify-email.cjs': 2, 'verify-full-list.cjs': 18,
  'verify-gallery.cjs': 6, 'verify-live-tab.cjs': 17, 'verify-map-desktop.cjs': 5,
  'verify-offline.cjs': 6, 'verify-one-site.cjs': 4, 'verify-quest-sheet.cjs': 15,
  'verify-questlist.cjs': 19, 'verify-recap.cjs': 7, 'verify-redesign.cjs': 27,
  'verify-rego-guard.cjs': 5, 'verify-rego-page.cjs': 2, 'verify-retry.cjs': 9, 'verify-sheet-gestures.cjs': 9,
  'verify-submit-page.cjs': 77, 'verify-sw-push.cjs': 1, 'verify-sw-update.cjs': 12, 'verify-switch.cjs': 22,
  'verify-tab-cache.cjs': 6, 'verify-dash-bundle.mjs': 3
};

const all = () => readdirSync(TESTS).filter(f => /^verify-.*\.(cjs|mjs)$/.test(f)).sort();
const workerSuites = () => all().filter(f => f.endsWith('.mjs'));
const browserSuites = () => all().filter(f => f.endsWith('.cjs'));

// Every page walked by the two generic checkers, which is every page —
// so any change under website/ runs them. They are what catches text
// off the page, text on text, type under 10.5px and a page that has
// left the type ladder, and they are 31 seconds for the pair.
const GENERIC = ['verify-redesign.cjs', 'verify-one-site.cjs'];

// A page's own suites. Anything under the key runs the values, plus the
// two generic checkers.
const PAGES = [
  ['website/questlist/', ['verify-questlist.cjs', 'verify-anywhere.cjs', 'verify-quest-sheet.cjs',
    'verify-full-list.cjs', 'verify-map-desktop.cjs', 'verify-ask.cjs', 'verify-sheet-gestures.cjs',
    'verify-offline.cjs']],
  ['website/submit/', ['verify-submit-page.cjs', 'verify-compress.cjs']],
  ['website/compress/', ['verify-compress.cjs', 'verify-submit-page.cjs']],
  ['website/assets/ffmpeg-mt/', ['verify-compress.cjs']],
  ['website/gallery/', ['verify-gallery.cjs', 'verify-submit-page.cjs']],
  ['website/albums/', ['verify-gallery.cjs']],
  // the album viewer's details and a shared photo's page, which the
  // worker's share pages load from the site
  ['website/assets/photo-details.js', ['verify-gallery.cjs']],
  ['website/assets/photo-view.js', ['verify-gallery.cjs']],
  // the compressor's demuxer and muxer
  ['website/assets/mp4box/', ['verify-compress.cjs']],
  ['website/assets/mp4-muxer/', ['verify-compress.cjs']],
  ['website/tab/', ['verify-live-tab.cjs', 'verify-tab-cache.cjs', 'verify-recap.cjs']],
  ['website/recap/', ['verify-recap.cjs']],
  ['website/plan/', ['verify-plan.cjs']],
  ['website/messages/', ['verify-bell.cjs']],
  ['website/rego/', ['verify-rego-page.cjs', 'verify-rego-guard.cjs']],
  ['website/terms/', ['verify-rego-page.cjs']],
  ['website/ticket/', ['verify-email.cjs']],
  ['website/welfare/', []],
  ['website/info/', []],
  ['website/404.html', []],
  ['website/index.html', ['verify-countdown.cjs', 'verify-bell.cjs']],
  ['website/manifest.webmanifest', ['verify-app-layout.cjs']]
];

// The shared chrome is on every page, so a change to it can reach every
// browser suite. sw.js is the same: it serves them all.
const SHARED = [
  'website/assets/site.css', 'website/assets/site.js', 'website/assets/site-viewer.js',
  'website/assets/site-chrome.js', 'website/assets/site-input.js', 'website/assets/site-app.js',
  'website/sw.js'
];

function changed(since) {
  const out = [];
  const run = (cmd) => {
    try { return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean); }
    catch { return []; }
  };
  out.push(...run(`git diff --name-only ${since}`));
  // Uncommitted work is what HEAD is being compared against. Against
  // any other ref the question is what a commit range touched, and the
  // working tree is not part of it.
  if (since === 'HEAD') {
    out.push(...run('git diff --name-only --cached'));
    out.push(...run('git ls-files --others --exclude-standard'));
  }
  return [...new Set(out)];
}

function pick(files) {
  const want = new Set();
  const why = new Map();
  const add = (suite, reason) => {
    want.add(suite);
    if (!why.has(suite)) why.set(suite, reason);
  };

  for (const f of files) {
    // a suite edited is a suite to run
    if (f.startsWith('tab/tests/verify-')) {
      const name = path.basename(f);
      if (existsSync(path.join(TESTS, name))) add(name, 'the suite itself changed');
      continue;
    }
    // the shared test scaffolding — the D1 shim, the sign-in helper —
    // is under every worker suite, so an edit there runs the lot
    if (f.startsWith('tab/tests/')) {
      for (const s of workerSuites()) add(s, 'shared test scaffolding changed');
      continue;
    }
    // the deploy and migrate scripts have two suites of their own and
    // reach nothing else; affected.mjs itself reaches nothing at all
    if (/^tab\/scripts\//.test(f)) {
      // the backup command has a suite of its own, and is one of the
      // scripts kept identical in both workers
      if (/backup\.mjs$/.test(f)) {
        add('verify-backup.mjs', 'the backup command changed');
        add('verify-migrations.mjs', 'the backup command changed');
        continue;
      }
      // the email's icons are drawn by a script of their own
      if (/email-icons\.cjs$/.test(f)) {
        add('verify-email.mjs', 'the email icons changed');
        add('verify-email.cjs', 'the email icons changed');
        continue;
      }
      if (!/affected\.mjs$/.test(f)) {
        add('verify-migrate.mjs', 'a deploy or migrate script changed');
        add('verify-migrations.mjs', 'a deploy or migrate script changed');
      }
      continue;
    }
    // what the deploy bundles: wrangler.toml's [[rules]] make the
    // dashboard's files Text modules, and package.json's "imports" is
    // how every suite's copy of the worker finds them
    if (f === 'tab/wrangler.toml') {
      add('verify-dash-bundle.mjs', 'the worker\'s config changed');
      continue;
    }
    if (f === 'tab/package.json') {
      for (const s of workerSuites()) add(s, 'the worker\'s package.json changed');
      continue;
    }
    // the worker: routing and the shared helpers reach everything, and
    // the whole set is fifteen seconds
    if (/^tab\/(src|migrations)\//.test(f) || /^tab\/(schema|seed)\.sql$/.test(f)) {
      for (const s of workerSuites()) add(s, 'the worker changed');
      // the dashboard page: src/dash/ and the file that puts it together
      if (f.includes('console-page') || f.startsWith('tab/src/dash/')) add('verify-console-ui.cjs', 'the dashboard page changed');
      // the dashboard's saves sending files straight to R2, page and
      // worker together, so any of the routes they reach
      if (/^tab\/src\//.test(f)) add('verify-console-direct.cjs', 'the worker changed');
      if (f.includes('email')) add('verify-email.cjs', 'the confirmation email changed');
      // a file's page, which loads the site's viewer
      if (f === 'tab/src/sharepage.ts') add('verify-gallery.cjs', 'a file\'s page changed');
      // the compressor's results are read back with the worker's video reader
      if (f === 'tab/src/videostrip.ts' || f === 'tab/src/strip.ts') add('verify-compress.cjs', 'the video reader changed');
      continue;
    }
    if (SHARED.includes(f)) {
      for (const s of browserSuites()) add(s, 'the shared chrome changed');
      continue;
    }
    if (f.startsWith('website/')) {
      for (const g of GENERIC) add(g, 'a page changed');
      // a page's head says what the worker's Discord card for it says
      if (/(^website\/|\/)index\.html$/.test(f)) add('verify-embed.mjs', 'a page\'s link preview tags');
      for (const [prefix, suites] of PAGES) {
        if (!f.startsWith(prefix)) continue;
        for (const s of suites) add(s, prefix.replace('website/', '') + ' changed');
      }
    }
  }
  return { want: [...want].sort(), why };
}

const args = process.argv.slice(2);
const doRun = args.includes('--run');
const sinceArg = args.find(a => a.startsWith('--since='));
const since = sinceArg ? sinceArg.slice('--since='.length) : 'HEAD';

let suites, why = new Map(), files = [];
if (args.includes('--all')) {
  suites = all();
  for (const s of suites) why.set(s, 'asked for every suite');
} else {
  files = changed(since);
  ({ want: suites, why } = pick(files));
  console.log(files.length ? `changed against ${since}:` : `nothing changed against ${since}`);
  for (const f of files.slice(0, 40)) console.log('  ' + f);
  if (files.length > 40) console.log(`  … and ${files.length - 40} more`);
  console.log('');
}

if (args.includes('--workers')) suites = suites.filter(s => s.endsWith('.mjs'));
if (args.includes('--browsers')) suites = suites.filter(s => s.endsWith('.cjs'));

if (!suites.length) {
  console.log('no suite covers this change');
  process.exit(0);
}

const cost = suites.reduce((n, s) => n + (SECONDS[s] ?? 1), 0);
const total = all().reduce((n, s) => n + (SECONDS[s] ?? 1), 0);
console.log(`${suites.length} of ${all().length} suites, about ${cost}s (all of them is about ${total}s)`);
for (const s of suites) console.log(`  ${s.padEnd(32)} ${why.get(s) || ''}`);

if (!doRun) {
  console.log('\n--run to run them');
  process.exit(0);
}

console.log('');
let failed = [];
for (const s of suites) {
  const r = spawnSync('node', [path.join('tests', s)], { cwd: TAB, encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed.push(s);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${s}`);
  if (!ok) {
    const lines = ((r.stdout || '') + (r.stderr || '')).split('\n')
      .filter(l => /^\s*FAIL|Error|Timeout/i.test(l)).slice(0, 6);
    for (const l of lines) console.log('      ' + l.trim());
  }
}
console.log(failed.length ? `\n${failed.length} suite(s) failed` : '\nall clear');
process.exit(failed.length ? 1 : 0);
