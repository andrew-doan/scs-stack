// Offline map tiles: the service worker keeps the tiles it has drawn
// in a cache of its own, kept across version bumps, and the settings
// rocker turns the whole thing on or off. A real service worker only
// intercepts over https, so what is proved here is the flag the page
// writes, the switch that writes it, the first-boot decision from the
// room the browser reports, and the worker's own arithmetic read
// straight out of sw.js.
// Run with: node tests/verify-offline.cjs
// Needs playwright nearby and a static server on 8123 serving
// website/ (the test starts one if the port is free).
const { chromium } = require('playwright');
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'website');   // the site is served from here
const BASE = 'http://127.0.0.1:8123';
let fail = 0;
const check = (l, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + l + (d ? '  ' + d : '')); if (!ok) fail++; };

const TILE_CACHE = 'scs2-tiles-v1';
const TILE_CFG = 'scs2-tiles-cfg';
const KEY = 'scs2-tile-cache';
const MB = 1024 * 1024;

// pull one `var NAME = ...;` value out of a source file
function decl(src, name) {
  const at = src.indexOf('var ' + name + ' = ');
  if (at === -1) return '';
  return src.slice(at + ('var ' + name + ' = ').length, src.indexOf(';', at));
}

(async () => {
  // ---------------- sw.js, read as text ----------------
  const swText = fs.readFileSync(path.join(SITE, 'sw.js'), 'utf8');
  const qlText = fs.readFileSync(path.join(SITE, 'questlist', 'scs-2-questlist-map.js'), 'utf8');

  let parses = true;
  try { execFileSync(process.execPath, ['--check', path.join(SITE, 'sw.js')]); }
  catch (err) { parses = false; }
  check('sw.js parses', parses, '');

  check('the tile cache and its flag have their own names',
    decl(swText, 'TILE_CACHE') === "'" + TILE_CACHE + "'" &&
    decl(swText, 'TILE_CFG') === "'" + TILE_CFG + "'",
    JSON.stringify({ cache: decl(swText, 'TILE_CACHE'), cfg: decl(swText, 'TILE_CFG') }));

  // the version-bump cleanup must leave both alone
  const activate = swText.slice(swText.indexOf("addEventListener('activate'"), swText.indexOf("addEventListener('push'"));
  check('a version bump does not delete the tiles or the flag',
    activate.indexOf('TILE_CACHE') !== -1 && activate.indexOf('TILE_CFG') !== -1 &&
    activate.indexOf('caches.delete') !== -1,
    activate.split('\n').filter(l => l.indexOf('TILE_') !== -1).join(' / ').trim());

  // the tile hosts and the shape of a tile path, against the URLs the
  // quest list actually builds
  const hosts = decl(swText, 'TILE_HOSTS').split("'").filter(s => s.indexOf('.') !== -1 && s.indexOf(',') === -1);
  const endpoints = [(/var TILE_URL = '([^']+)'/.exec(qlText) || [])[1]].filter(Boolean);
  // A host the page probes but the worker does not know serves tiles
  // that are never kept; a host the worker knows but the page never
  // probes is a name left behind. Either way the two lists have drifted,
  // which is the thing worth catching — how many there are is not.
  const endpointHosts = endpoints.map(t => new URL(t).hostname);
  check('the worker keeps tiles from exactly the hosts the quest list probes',
    endpoints.length === 1 &&
    endpointHosts.every(h => hosts.indexOf(h) !== -1) &&
    hosts.every(h => endpointHosts.indexOf(h) !== -1),
    JSON.stringify({ endpoints: endpointHosts, hosts }));

  const tilePath = new Function('return ' + decl(swText, 'TILE_PATH'))();
  const realTiles = endpoints.map(t => new URL(t.replace('{z}/{x}/{y}', '13/7534/4915')).pathname);
  check('a real tile path is recognised, other paths are not',
    realTiles.every(p2 => tilePath.test(p2)) &&
    !tilePath.test('/my_area/metadata.json') && !tilePath.test('/questlist/') && !tilePath.test('/api/pulse'),
    JSON.stringify(realTiles));

  // The quest map skips its idle wait when the switch is not off. It
  // reads the page's stored choice, so it has to compare against a value
  // site-app.js actually writes, not the worker's 'on'/'off' flag.
  {
    const appText = fs.readFileSync(path.join(SITE, 'assets', 'site-app.js'), 'utf8');
    const store = appText.slice(appText.indexOf('function storeTilePref'), appText.indexOf('\n  }', appText.indexOf('function storeTilePref')));
    const written = (store.match(/on \? '([^']*)' : '([^']*)'/) || []).slice(1);
    const drawn = qlText.slice(qlText.indexOf('function mapDrawnBefore'), qlText.indexOf('\n  }', qlText.indexOf('function mapDrawnBefore')));
    const compared = (drawn.match(/tiles !== '([^']*)'/) || [])[1];
    check('the quest map reads the Offline Map choice as site-app.js stores it',
      written.length === 2 && compared === written[1],
      JSON.stringify({ written, compared }));
  }

  // the cap: nothing dropped under it, the oldest 80 over it
  const trimSrc = swText.slice(swText.indexOf('function tileTrimCount'), swText.indexOf('\n}', swText.indexOf('function tileTrimCount')) + 2);
  const trim = new Function('TILE_MAX', 'TILE_TRIM', trimSrc + ' return tileTrimCount;')(800, 80);
  check('the cache is capped at 800 tiles and sheds 80 at a time',
    Number(decl(swText, 'TILE_MAX')) === 800 && Number(decl(swText, 'TILE_TRIM')) === 80 &&
    trim(0) === 0 && trim(800) === 0 && trim(801) === 80 && trim(880) === 80 && trim(1000) === 200,
    JSON.stringify([trim(800), trim(801), trim(1000)]));

  // The worker reads the flag at most once a minute, so the page tells it
  // when the switch goes off: run in a stubbed worker global, a tile
  // fetched after that message is not stored and the cache is gone.
  {
    const vm = require('vm');
    const stores = new Map();
    const store = name => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name);
      return {
        match: k => Promise.resolve(m.get(String(k.url || k))),
        put: (k, v) => { m.set(String(k.url || k), v); return Promise.resolve(); },
        keys: () => Promise.resolve([...m.keys()]),
        delete: k => Promise.resolve(m.delete(String(k.url || k)))
      };
    };
    const handlers = {};
    class Resp {
      constructor(body, init) { this.status = (init && init.status) || 200; this.body = body; this.headers = new Map(Object.entries((init && init.headers) || {})); }
      clone() { return this; }
      text() { return Promise.resolve(this.body); }
      arrayBuffer() { return Promise.resolve(this.body); }
    }
    let fetches = 0;
    const ctx = {
      self: { addEventListener: (n, fn) => { handlers[n] = fn; }, location: { origin: 'https://scs.andyrew.space' } },
      caches: { open: name => Promise.resolve(store(name)), delete: name => Promise.resolve(stores.delete(name)), has: name => Promise.resolve(stores.has(name)) },
      fetch: () => { fetches++; return Promise.resolve(new Resp('tile')); }, URL, Response: Resp, console
    };
    vm.createContext(ctx);
    vm.runInContext(swText, ctx);
    const tile = 'https://tiles.scs.andyrew.space/my_area/13/7534/4915.mvt';
    const behind = [];
    const fetchTile = (url) => new Promise(res => handlers.fetch({
      request: { method: 'GET', url: url || tile, mode: 'cors' }, respondWith: p => p.then(res), waitUntil: p => behind.push(p)
    }));
    await fetchTile();
    await new Promise(res => setTimeout(res, 20));
    const keptWhileOn = stores.has(TILE_CACHE) && stores.get(TILE_CACHE).size === 1;
    // A kept tile is answered with no request; one kept over a week ago is
    // answered from the cache and fetched again behind it.
    const before = fetches;
    await fetchTile();
    const askedForKept = fetches - before;
    stores.get(TILE_CACHE).get(tile).headers.set('x-scs-kept', String(Date.now() - 8 * 86400000));
    const old = await fetchTile();
    await Promise.all(behind);
    const refreshed = fetches - before - askedForKept;
    let probeTaken = false;
    handlers.fetch({ request: { method: 'GET', url: tile + '?probe=1', mode: 'cors' }, respondWith: () => { probeTaken = true; } });
    check('a kept tile is answered with no request, an old one is fetched again behind it, and a probe goes to the network',
      askedForKept === 0 && old && old.body === 'tile' && refreshed === 1 && !probeTaken,
      JSON.stringify({ askedForKept, refreshed, probeTaken }));
    const waits = [];
    handlers.message({ data: { type: 'scs-tiles', on: false }, waitUntil: p => waits.push(p) });
    await Promise.all(waits);
    await fetchTile();
    await new Promise(res => setTimeout(res, 20));
    const kept = stores.has(TILE_CACHE) ? stores.get(TILE_CACHE).size : 0;
    check('told the switch is off, the worker drops the tiles and stores none, without waiting to read the flag',
      keptWhileOn && kept === 0, JSON.stringify({ keptWhileOn, kept }));
  }

  // ---------------- the proof-image cache ----------------
  // The name is asserted by its shape, not its number: it is renamed
  // whenever what the worker serves under an unchanged URL changes,
  // and a test that pins the number has to be edited every time.
  const fileCache = decl(swText, 'FILE_CACHE');
  check('the image cache has its own name and survives a version bump',
    /^'scs2-files-v\d+'$/.test(fileCache) && activate.indexOf('FILE_CACHE') !== -1,
    fileCache);
  check('and every cache not kept goes at a version bump, a renamed one\'s predecessor with it',
    /return caches\.delete\(key\)/.test(activate), '');

  const isFileSrc = swText.slice(swText.indexOf('function isFileRequest'), swText.indexOf('\n}', swText.indexOf('function isFileRequest')) + 2);
  const isFile = new Function('FILE_HOST', 'FILE_PATHS', isFileSrc + ' return isFileRequest;')(
    'files.scs.andyrew.space', new Function('return ' + decl(swText, 'FILE_PATHS'))());
  check('the four file endpoints are caught, the slideshow\'s among them, and nothing else',
    isFile(new URL('https://files.scs.andyrew.space/api/submit/file?key=sub%2F1%2Fx&thumb=1')) &&
    isFile(new URL('https://files.scs.andyrew.space/api/quests/file?key=qst%2Fy')) &&
    isFile(new URL('https://files.scs.andyrew.space/api/messages/file?key=msg%2Fz')) &&
    isFile(new URL('https://files.scs.andyrew.space/api/slides/file?key=slide%2Fw')) &&
    !isFile(new URL('https://files.scs.andyrew.space/api/pulse')) &&
    !isFile(new URL('https://files.scs.andyrew.space/api/questlist')) &&
    !isFile(new URL('https://scs.andyrew.space/api/submit/file?key=k')), '');

  const keepSrc = swText.slice(swText.indexOf('function keepableImage'), swText.indexOf('\n}', swText.indexOf('function keepableImage')) + 2);
  const keep = new Function('FILE_BYTES_MAX', keepSrc + ' return keepableImage;')(Number(decl(swText, 'FILE_BYTES_MAX')));
  const req = (range) => ({ headers: { get: (h) => (h === 'range' ? range || null : null) } });
  const res = (status, type, ct, len) => ({
    status, type,
    headers: { get: (h) => (h === 'content-type' ? ct : h === 'content-length' ? len : null) }
  });
  check('only whole readable images under the cap are kept',
    keep(req(), res(200, 'cors', 'image/jpeg', '250000')) === true &&
    keep(req(), res(200, 'cors', 'video/mp4', '250000')) === false &&
    keep(req(), res(200, 'cors', 'application/pdf', '250000')) === false &&
    keep(req(), res(206, 'cors', 'image/jpeg', '250000')) === false &&
    keep(req(), res(200, 'opaque', 'image/jpeg', '250000')) === false &&
    keep(req(), res(200, 'cors', 'image/jpeg', '9999999')) === false &&
    keep(req(), res(200, 'cors', 'image/jpeg', null)) === false &&
    keep(req('bytes=0-100'), res(200, 'cors', 'image/jpeg', '250000')) === false &&
    // a slide is the picture as uploaded, so it is kept at its own cap
    keep(req(), res(200, 'cors', 'image/jpeg', '6000000'), Number(decl(swText, 'SLIDE_BYTES_MAX'))) === true &&
    keep(req(), res(200, 'cors', 'image/jpeg', '6000000')) === false, '');

  check('the image cache is capped and sheds in batches',
    Number(decl(swText, 'FILE_MAX')) === 400 && Number(decl(swText, 'FILE_TRIM')) === 40 &&
    Number(decl(swText, 'FILE_BYTES_MAX')) === 2500000, '');

  // ---------------- the page: the switch and the flag ----------------
  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await new Promise(res => setTimeout(res, 1200));
  }
  const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const errors = [];

  // a context whose browser reports the room we want it to
  const roomy = async (quota, usage) => {
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript(({ q, u }) => {
      window.__estimates = 0;
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        get: () => ({
          estimate: () => { window.__estimates++; return Promise.resolve({ quota: q, usage: u }); },
          persist: () => Promise.resolve(true),
          persisted: () => Promise.resolve(false)
        })
      });
    }, { q: quota, u: usage });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: r.request().url().endsWith('.css') ? 'text/css' : 'application/javascript', body: '' }));
    await page.route('**/tiles.scs.andyrew.space/**', r => r.fulfill({ status: 404, body: '' }));
    await page.route('**/files.scs.andyrew.space/**', r => r.fulfill({
      status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}'
    }));
    return { ctx, page };
  };

  const flag = (page) => page.evaluate(async (name) => {
    const cache = await caches.open(name);
    const res = await cache.match('/__tiles');
    return res ? (await res.text()) : null;
  }, TILE_CFG);
  const stored = (page) => page.evaluate((k) => localStorage.getItem(k), KEY);
  const rocker = (page) => page.evaluate(() => {
    const box = document.getElementById('set-tile-cache');
    if (!box) return null;
    const row = box.closest('.settings-row');
    return {
      text: row.querySelector('span').textContent,
      checked: box.checked,
      faces: [...row.querySelectorAll('.settings-switch span')].map(s => s.textContent).join(''),
      rows: document.querySelectorAll('#site-settings .settings-check').length
    };
  });

  // ---- the row is on the pages, alongside the other rockers ----
  const big = await roomy(8 * 1024 * MB, 200 * MB);
  await big.page.goto(BASE + '/questlist/');
  await big.page.waitForTimeout(900);
  const onQuests = await rocker(big.page);
  check('the quest list carries an Offline map rocker in the settings menu',
    !!onQuests && onQuests.text === 'Offline Map' && onQuests.faces === 'OI' && onQuests.rows >= 5,
    JSON.stringify(onQuests));

  await big.page.goto(BASE + '/');
  await big.page.waitForTimeout(900);
  const onHome = await rocker(big.page);
  check('so does the home page', !!onHome && onHome.text === 'Offline Map' && onHome.faces === 'OI', JSON.stringify(onHome));

  // ---- first boot with room to spare: on ----
  check('a browser with room to spare starts the offline map on',
    onHome.checked === true && (await stored(big.page)) === '1' && (await flag(big.page)) === 'on',
    JSON.stringify({ checked: onHome.checked, stored: await stored(big.page), flag: await flag(big.page) }));

  // ---- turning it off writes the flag and throws the tiles away ----
  await big.page.evaluate(async () => {
    const cache = await caches.open('scs2-tiles-v1');
    await cache.put('https://tiles.scs.andyrew.space/my_area/13/7534/4915.mvt', new Response('tile'));
  });
  check('the seeded tile is there to begin with',
    await big.page.evaluate(() => caches.has('scs2-tiles-v1')), '');

  await big.page.evaluate(() => document.getElementById('set-tile-cache').click());
  await big.page.waitForTimeout(500);
  check('turning it off stores the choice and tells the worker',
    (await stored(big.page)) === '0' && (await flag(big.page)) === 'off', '');
  check('and the tiles already downloaded go with it',
    (await big.page.evaluate(() => caches.has('scs2-tiles-v1'))) === false, '');

  await big.page.evaluate(() => document.getElementById('set-tile-cache').click());
  await big.page.waitForTimeout(500);
  check('turning it back on writes the flag again',
    (await stored(big.page)) === '1' && (await flag(big.page)) === 'on', '');

  // ---- the stored choice survives, and is not second-guessed ----
  await big.page.evaluate((k) => localStorage.setItem(k, '0'), KEY);
  await big.page.reload();
  await big.page.waitForTimeout(900);
  const kept = await rocker(big.page);
  check('a stored choice wins on the next visit, without asking about storage again',
    kept.checked === false && (await flag(big.page)) === 'off' &&
    (await big.page.evaluate(() => window.__estimates)) === 0,
    JSON.stringify({ checked: kept.checked, estimates: await big.page.evaluate(() => window.__estimates) }));
  await big.ctx.close();

  // ---- first boot on a full device: off ----
  const tight = await roomy(300 * MB, 200 * MB); // 100MB free, under the 250MB mark
  await tight.page.goto(BASE + '/questlist/');
  await tight.page.waitForTimeout(900);
  const onFull = await rocker(tight.page);
  check('a browser with little room left starts the offline map off',
    onFull.checked === false && (await stored(tight.page)) === '0' && (await flag(tight.page)) === 'off',
    JSON.stringify({ checked: onFull.checked, stored: await stored(tight.page), flag: await flag(tight.page) }));
  check('and it only asked about storage once',
    (await tight.page.evaluate(() => window.__estimates)) === 1,
    String(await tight.page.evaluate(() => window.__estimates)));
  await tight.ctx.close();

  // ---- a browser that cannot say how much room there is ----
  const blind = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  await blind.addInitScript(() => {
    Object.defineProperty(navigator, 'storage', { configurable: true, get: () => undefined });
  });
  const blindPage = await blind.newPage();
  blindPage.on('pageerror', e => errors.push(e.message));
  await blindPage.route('**/files.scs.andyrew.space/**', r => r.fulfill({
    status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}'
  }));
  await blindPage.goto(BASE + '/');
  await blindPage.waitForTimeout(900);
  check('a browser that cannot say how much room it has starts it on',
    (await blindPage.$eval('#set-tile-cache', el => el.checked)) === true &&
    (await stored(blindPage)) === '1' && (await flag(blindPage)) === 'on', '');
  await blind.close();

  console.log('errors', errors);
  check('no page errors', errors.length === 0, errors.join(' | '));

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  await b.close();
  if (server) server.kill();
  process.exit(fail ? 1 : 0);
})();
