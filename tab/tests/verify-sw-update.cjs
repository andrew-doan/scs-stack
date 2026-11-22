// A new deploy has to reach a browser that already has the site, even
// when its HTTP cache holds the old files.
//
// Something in front of the site can give a script hours of life in the
// browser's HTTP cache (Cloudflare does by default, four hours, for a
// proxied domain), and the service worker used to fill its new cache
// through that HTTP cache. The new worker installed fine — the browser
// always fetches the worker's own file fresh — and then served the old
// site.js on every load, however many reloads: the quest list kept
// running the code from before the team lists, and only a private
// window, with no HTTP cache, saw the new one.
//
// No request interception anywhere here: Playwright turns the browser's
// HTTP cache off when it intercepts, which is exactly the thing under
// test. The site is served from website/ by a small server of its own
// that stamps a build name into site.js and a cache name into sw.js, so
// two builds can be deployed one after the other at the same address.
// Run with: node tests/verify-sw-update.cjs
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, '..', '..', 'website');
const PORT = 8141;
const BASE = 'http://127.0.0.1:' + PORT;
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.geojson': 'application/json' };
let build = 'one';
let failing = null; // a path answered 500, so a new worker cannot install
let fail = 0;
const check = (l, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + l + (d ? '  ' + d : '')); if (!ok) fail++; };

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  let f = path.join(SITE, p);
  if (!f.startsWith(SITE)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('not here'); return; }
  if (p === failing) { res.writeHead(500); res.end(); return; }
  let body = fs.readFileSync(f);
  if (p === '/assets/site.js') body = Buffer.concat([body, Buffer.from('\nwindow.__siteBuild = ' + JSON.stringify(build) + ';\n')]);
  if (p === '/sw.js') body = Buffer.from(body.toString().replace(/var CACHE = '[^']*';/, "var CACHE = 'scs2-cache-test-" + build + "';"));
  // the worker's own file is always fetched fresh by the browser; the
  // rest carry four hours, the way a CDN in front can set them
  res.writeHead(200, {
    'content-type': TYPES[path.extname(f)] || 'application/octet-stream',
    'cache-control': p === '/sw.js' ? 'no-cache' : 'public, max-age=14400'
  });
  res.end(body);
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const seen = () => p.evaluate(() => ({
    build: window.__siteBuild || null,
    controlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller)
  }));

  // the first build, with its worker installed and in charge
  await p.goto(BASE + '/info/');
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.waitForTimeout(800);
  const firstVisitPill = await p.evaluate(() => !!document.querySelector('.site-update'));
  await p.reload();
  await p.waitForTimeout(2000);
  const first = await seen();

  // the second build goes up at the same address
  build = 'two';
  const after = [];
  for (let i = 0; i < 3; i++) {
    await p.reload();
    await p.waitForTimeout(2500);
    after.push((await seen()).build);
  }
  check('a new deploy reaches a browser whose HTTP cache holds the old files, within two reloads',
    first.build === 'one' && first.controlled && after[1] === 'two' && after[2] === 'two',
    JSON.stringify({ first, after }));

  // A deploy whose new worker cannot install, as on a weak signal: the
  // worker in charge keeps answering with the build it installed, rather
  // than storing the new build's files one request at a time and running
  // them beside its own.
  // A reload's script tags can come from the renderer's own memory
  // without reaching the worker, so the file is asked for with fetch.
  build = 'stuck';
  failing = '/assets/site.css';
  await p.reload();
  await p.waitForTimeout(2500);
  const held = await p.evaluate(async () => {
    const ask = async () => ((await (await fetch('/assets/site.js')).text()).match(/__siteBuild = "([^"]*)"/) || [])[1];
    const first = await ask();
    await new Promise(r => setTimeout(r, 800));
    return [window.__siteBuild, first, await ask()];
  });
  failing = null;
  check('while a new worker cannot install, the worker in charge keeps answering with the build it installed',
    held.every(x => x === 'two'), JSON.stringify(held));

  // A page left open across a deploy: the new worker takes it over, the
  // page offers a reload, and the reload is the new build. The update
  // asked for here is the one the browser makes on a page load and the
  // page makes when it comes back into view.
  build = 'three';
  await p.evaluate(() => navigator.serviceWorker.getRegistration().then(r => r.update()));
  const offered = await p.waitForSelector('.site-update.is-shown', { timeout: 10000 }).then(() => true, () => false);
  const before = (await seen()).build;
  await Promise.all([p.waitForNavigation(), p.click('.site-update-go')]);
  await p.waitForTimeout(1500);
  const reloaded = await p.evaluate(() => ({
    build: window.__siteBuild || null,
    pill: !!document.querySelector('.site-update')
  }));
  check('a page open across a deploy offers a reload that brings in the new build, and a first visit offers none',
    !firstVisitPill && offered && before === 'two' && reloaded.build === 'three' && !reloaded.pill,
    JSON.stringify({ firstVisitPill, offered, before, reloaded }));

  await b.close();
  server.close();
  console.log(fail ? '\n' + fail + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); server.close(); process.exit(1); });
