// A request the network drops is asked again before the page is told it
// failed. A phone that has just woken or changed networks often loses its
// first request and gets the second, which read as "the site failed to
// load, and a reload fixed it".
//
// A read that gets no answer at all in time is given up and asked again
// too, since a phone can hold a request on a connection that is gone.
//
// Two places do the asking again, and they cover different requests:
// sw.js for the site's own pages and files, and scs.fetch (site.js) for
// reads from the tab worker, which the service worker never sees. Both
// are driven here against servers that drop the first tries on purpose,
// with a real service worker in charge and no request interception, so
// what is tested is what the browser does.
// Run with: node tests/verify-retry.cjs
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const SITE = path.join(__dirname, '..', '..', 'website');
const PORT = 8142;      // the site
const API_PORT = 8143;  // a stand-in for the tab worker, on another origin
const BASE = 'http://127.0.0.1:' + PORT;
const API = 'http://127.0.0.1:' + API_PORT;
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
  '.geojson': 'application/json', '.pbf': 'application/x-protobuf' };
let fail = 0;
const check = (l, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + l + (d ? '  ' + d : '')); if (!ok) fail++; };

// path -> how many times it has been asked for. A path in `flaky` has
// its first try dropped with no answer at all and its second answered
// 503, and the third goes through.
const asked = {};
const flaky = new Set();
function flake(req, res) {
  const p = req.url.split('?')[0];
  asked[p] = (asked[p] || 0) + 1;
  if (!flaky.has(p)) return false;
  if (asked[p] === 1) { req.socket.destroy(); return true; }
  if (asked[p] === 2) { res.writeHead(503, { 'access-control-allow-origin': '*', connection: 'close' }); res.end(); return true; }
  return false;
}

const site = http.createServer((req, res) => {
  if (flake(req, res)) return;
  const p = decodeURIComponent(req.url.split('?')[0]);
  let f = path.join(SITE, p);
  if (!f.startsWith(SITE)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, 'index.html');
  if (!fs.existsSync(f)) { res.writeHead(404); res.end('not here'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', connection: 'close' });
  res.end(fs.readFileSync(f));
});

// answers held open and never sent: a request on a connection that is no
// longer there, which the page would otherwise wait on for good
const held = [];
const api = http.createServer((req, res) => {
  if (flake(req, res)) return;
  const p = req.url.split('?')[0];
  if (p === '/api/hang' && asked[p] === 1) { held.push(res); return; }
  const head = { 'content-type': 'application/json', 'access-control-allow-origin': '*', connection: 'close' };
  // a write that failed may still have arrived, so it is never sent again
  if (p === '/api/write') { res.writeHead(503, head); res.end('{}'); return; }
  res.writeHead(200, head);
  res.end(JSON.stringify({ ok: true }));
});

(async () => {
  await new Promise(r => site.listen(PORT, r));
  await new Promise(r => api.listen(API_PORT, r));
  const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();

  // the worker installed and in charge of the page
  await p.goto(BASE + '/info/');
  await p.evaluate(() => navigator.serviceWorker.ready);
  await p.reload();
  await p.waitForFunction(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller) && !!window.scs);

  // ---- scs.fetch: a read is asked again, a write is not ----
  flaky.add('/api/read');
  const reads = await p.evaluate((API) => Promise.all([
    window.scs.fetch(API + '/api/read', { cache: 'no-store' }).then(r => r.json()).then(d => d.ok, () => 'failed'),
    window.scs.fetch(API + '/api/write', { method: 'POST' }).then(r => r.status, () => 'failed'),
    window.scs.fetch(API + '/api/hang', { cache: 'no-store', timeout: 600 }).then(r => r.json()).then(d => d.ok, () => 'failed')
  ]), API);
  check('a read from the tab worker that the network drops, or that gets no answer in time, is asked again until it lands, and a POST is sent once',
    reads[0] === true && asked['/api/read'] >= 3 && reads[1] === 503 && asked['/api/write'] === 1 &&
    reads[2] === true && asked['/api/hang'] === 2,
    JSON.stringify({ reads, asked: { read: asked['/api/read'], write: asked['/api/write'], hang: asked['/api/hang'] } }));
  held.forEach(r => r.socket && r.socket.destroy());

  // ---- sw.js: a file it has no copy of is asked for again ----
  // the email header is on the site but not in PRECACHE, so the worker
  // has nothing stored for it and has to go to the network
  const file = '/assets/email/header-banner.png';
  flaky.add(file);
  asked[file] = 0;
  const got = await p.evaluate((file) => fetch(file).then(r => r.status, () => 'failed'), file);
  check('a page or file the service worker has no copy of is asked for again when the first tries are dropped',
    got === 200 && asked[file] >= 3, JSON.stringify({ got, asked: asked[file] }));

  // ---- a ticket link with no signal ----
  // the ticket is the page somebody opens at check-in, and its link
  // carries the ticket in the query
  const TICKET = '/ticket/?AgNhYmNBbGljZQpMb2NvIE1vdGl2ZQ';
  const ticketShown = (page) => page.evaluate(() => ({ path: location.pathname, note: !!document.querySelector('.tk-note') }))
    .catch(() => ({ path: 'error', note: false }));
  await ctx.setOffline(true);
  await p.goto(BASE + TICKET).catch(() => {});
  const ticket = await ticketShown(p);
  // a page never opened here is sent to the stored home page, at the
  // home page's own address, so its styles and scripts load
  await p.goto(BASE + '/scs1-tab/').catch(() => {});
  const unstored = await p.evaluate(() => ({
    path: location.pathname,
    styled: [...document.styleSheets].some(s => /\/assets\/site\.css$/.test(s.href || '') && s.cssRules.length > 0),
    scripts: !!window.scs
  })).catch(() => ({ path: 'error' }));
  await ctx.setOffline(false);
  check('a ticket link opens from the stored ticket page with no signal, not the home page',
    ticket.path === '/ticket/' && ticket.note, JSON.stringify(ticket));
  check('with no signal, a page never stored goes to the stored home page at its own address, styled and running',
    unstored.path === '/' && unstored.styled && unstored.scripts, JSON.stringify(unstored));

  // ---- the ticket link alone ----
  // a phone that only ever opens the link in its email still gets the
  // worker, and with it the ticket at the door with no signal
  const fresh = await b.newContext({ viewport: { width: 390, height: 844 } });
  const q = await fresh.newPage();
  await q.goto(BASE + TICKET);
  const registered = await q.evaluate(() => Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise(res => setTimeout(() => res(false), 15000))
  ]));
  await fresh.setOffline(true);
  await q.reload().catch(() => {});
  const alone = await ticketShown(q);
  await fresh.setOffline(false);
  check('the ticket link alone installs the worker, and the ticket opens again with no signal',
    registered && alone.path === '/ticket/' && alone.note, JSON.stringify({ registered, alone }));
  await fresh.close();

  await b.close();
  site.close();
  api.close();
  console.log(fail ? '\n' + fail + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); site.close(); api.close(); process.exit(1); });
