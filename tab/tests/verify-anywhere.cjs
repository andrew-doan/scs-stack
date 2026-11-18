// Quests with no coordinates get no pin, and on this list that is more
// than half of them. This covers the four things that keep them from
// disappearing behind the map: the Anywhere mark on every row, the
// chip on the map that counts them and narrows the list, the panel
// rocker that does the same, and the sort that puts them at the top of
// their region instead of below every pin once location is on.
// Run with: node tests/verify-anywhere.cjs
// Needs playwright nearby and a static server on 8123 serving
// website/ (the test starts one if the port is free).
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'website');   // the site is served from here
const BASE = 'http://127.0.0.1:8123';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (l, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + l + (d ? '  ' + d : '')); if (!ok) fail++; };

(async () => {
  const q = await import(path.join(ROOT, 'tab/src/data/scs2-quests.ts'));
  const pl = await import(path.join(ROOT, 'tab/src/data/places.ts'));
  const list = {
    regions: q.REGIONS,
    groups: q.QUESTS.map(g => ({
      key: g.key, name: g.name, region: g.region, description: g.description, flavour: g.flavour,
      location: g.location, coords: g.coords, submit: g.submit, prompt: g.prompt, options: g.options, codes: g.codes
    })),
    places: pl.PLACES
  };
  const anywhere = list.groups.filter(g => !(g.coords || []).length);
  const pinned = list.groups.filter(g => (g.coords || []).length);
  const bare = anywhere.find(g => !g.location);          // no pin and no place named
  const named = anywhere.find(g => g.location);          // no pin but names a sort of place
  const onMap = pinned[0];

  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await new Promise(res => setTimeout(res, 1200));
  }
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await b.newContext({
    serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    permissions: ['geolocation'], geolocation: { latitude: -33.8830, longitude: 151.2063 } // Central
  });
  // the install nudge covers the corner the filters button and the map
  // buttons are in, and this suite drives both with real clicks
  await ctx.addInitScript(() => {
    try { sessionStorage.setItem('scs2-install-nudged', '1'); } catch (e) { /* private mode */ }
  });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: r.request().url().endsWith('.css') ? 'text/css' : 'application/javascript', body: '' }));
  await p.route('**/files.scs.andyrew.space/**', r => {
    const u = r.request().url();
    if (u.includes('/api/questlist')) return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(list) });
    return r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
  await p.route('**/tiles.scs.andyrew.space/**', r => r.fulfill({ status: 404, body: '' }));
  await p.goto(BASE + '/questlist/');
  await p.waitForTimeout(1300);

  const row = (key) => p.evaluate((k) => {
    const it = [...document.querySelectorAll('.ql-item')].find(i => i.dataset.questId === k);
    if (!it) return null;
    const meta = it.querySelector('.ql-item-meta');
    return { meta: meta ? meta.textContent : null };
  }, key);

  // ---- what the row says about a quest with no pin ----
  const bareRow = await row(bare.key);
  const namedRow = await row(named.key);
  const pinRow = await row(onMap.key);
  check('a quest with no pin and no place named says so under its name',
    bareRow && bareRow.meta === 'No Fixed Location', JSON.stringify(bareRow));
  check('one that names a sort of place shows the place instead',
    namedRow && namedRow.meta === named.location,
    JSON.stringify({ got: namedRow, want: named.location }));
  check('a quest with a pin shows where it is', pinRow && !!pinRow.meta, JSON.stringify(pinRow));

  // ---- the chip on the map ----
  const chip = () => p.evaluate(() => {
    const c = document.getElementById('ql-map-anywhere');
    return {
      shown: !c.classList.contains('is-hidden'),
      num: Number(document.getElementById('ql-map-anywhere-num').textContent),
      on: c.classList.contains('is-on'),
      pressed: c.getAttribute('aria-pressed'),
      label: c.textContent.replace(/\s+/g, ' ').trim(),
      overMap: (() => {
        const box = c.getBoundingClientRect();
        const card = document.querySelector('.ql-map-card').getBoundingClientRect();
        return box.left >= card.left && box.right <= card.right && box.bottom <= card.bottom + 1;
      })()
    };
  });
  const first = await chip();
  check('the chip counts every quest the map cannot show',
    first.shown && first.num === anywhere.length && first.overMap,
    JSON.stringify({ chip: first, expected: anywhere.length }));

  const listed = () => p.evaluate(() => [...document.querySelectorAll('.ql-item')].map(i => i.dataset.questId));
  const before = await listed();

  await p.click('#ql-map-anywhere');
  await sleep(500);
  const onChip = await chip();
  const onList = await listed();
  const keys = anywhere.map(g => g.key);
  check('tapping the chip narrows the list to just those quests',
    onList.length === anywhere.length && onList.every(k => keys.indexOf(k) !== -1),
    JSON.stringify({ shown: onList.length, expected: anywhere.length }));
  check('the panel rocker follows the chip',
    await p.$eval('#ql-anywhere-only', el => el.checked), '');

  await p.click('#ql-map-anywhere');
  await sleep(500);
  const offChip = await chip();
  check('tapping it again brings every quest back',
    (await listed()).length === before.length && !offChip.on && offChip.pressed === 'false',
    JSON.stringify({ now: (await listed()).length, was: before.length }));

  // ---- the rocker drives the same filter ----
  await p.evaluate(() => {
    const box = document.getElementById('ql-anywhere-only');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(400);
  check('the rocker narrows the list and lights the chip',
    (await listed()).length === anywhere.length && (await chip()).on, '');
  await p.evaluate(() => {
    const box = document.getElementById('ql-anywhere-only');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(400);

  // ---- the count follows the other filters ----
  const region = q.REGIONS.find(r => list.groups.some(g => g.region === r && !(g.coords || []).length) &&
    list.groups.some(g => g.region === r && (g.coords || []).length));
  const inRegion = list.groups.filter(g => g.region === region && !(g.coords || []).length).length;
  await p.evaluate((r) => {
    [...document.querySelectorAll('.ql-chip')].find(c => c.dataset.cat === r).click();
  }, region);
  await sleep(400);
  check('picking a region counts only that region\'s anywhere quests',
    (await chip()).num === inRegion, JSON.stringify({ region, got: (await chip()).num, want: inRegion }));
  await p.evaluate(() => document.querySelector('.ql-chip[data-cat="all"]').click());
  await sleep(400);

  // ---- sorting once location is on ----
  // the location button is in the filters drawer now
  await p.click('#ql-filters-btn');
  await sleep(350);
  await p.click('#ql-locate');
  await sleep(900);
  await p.evaluate(() => {
    const r = document.getElementById('ql-radius');
    r.value = '50';
    r.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await sleep(500);
  const groups = await p.evaluate((keys) => {
    const out = [];
    let cur = null;
    [...document.getElementById('ql-list').children].forEach(node => {
      if (node.classList.contains('ql-group-title')) { cur = { region: node.textContent, rows: [] }; out.push(cur); }
      else if (node.classList.contains('ql-item') && cur) {
        cur.rows.push({ key: node.dataset.questId, anywhere: keys.indexOf(node.dataset.questId) !== -1 });
      }
    });
    return out;
  }, anywhere.map(g => g.key));
  const mixed = groups.filter(g => g.rows.some(r => r.anywhere) && g.rows.some(r => !r.anywhere));
  const outOfOrder = mixed.filter(g => {
    const lastAnywhere = g.rows.map(r => r.anywhere).lastIndexOf(true);
    const firstPinned = g.rows.map(r => r.anywhere).indexOf(false);
    return lastAnywhere > firstPinned;
  });
  check('with location on, anywhere quests sort to the top of their region, not the bottom',
    mixed.length > 0 && outOfOrder.length === 0,
    JSON.stringify({ mixedRegions: mixed.length, wrong: outOfOrder.map(g => g.region) }));

  // ---- the chip on the fullscreen map ----
  await p.click('#ql-map-full');
  await sleep(700);
  check('the chip stays on the fullscreen map, clear of the panel',
    await p.evaluate(() => {
      const c = document.getElementById('ql-map-anywhere').getBoundingClientRect();
      const panel = document.getElementById('ql-map-search').getBoundingClientRect();
      return c.width > 0 && c.bottom < panel.top;
    }), '');
  await p.click('#ql-map-anywhere');
  await sleep(700);
  check('tapping it there opens the search panel rather than leaving an empty map',
    await p.$eval('#ql-map-search', el => el.classList.contains('is-half') || el.classList.contains('is-full')), '');
  check('the map\'s own list narrows with it',
    await p.evaluate(() => document.querySelectorAll('.ql-sr-item').length) === anywhere.length, '');

  // ---- the fullscreen map keeps its chrome inside the safe area ----
  // A phone turned sideways loses a strip to the notch and a curve at
  // every corner. There is no way to make a browser here report real
  // insets, but the map reads them through named properties, so the
  // test sets those and checks that everything pinned to an edge
  // moves in by them. The map canvas itself still fills the screen.
  const safe = await p.evaluate(() => {
    const r = document.documentElement;
    r.style.setProperty('--map-safe-l', '44px');
    r.style.setProperty('--map-safe-r', '44px');
    r.style.setProperty('--map-safe-t', '20px');
    r.style.setProperty('--map-safe-b', '21px');
    const read = (sel, prop) => getComputedStyle(document.querySelector(sel))[prop];
    const out = {
      chipLeft: read('#ql-map-anywhere', 'left'),
      btnRight: read('#ql-map-full', 'right'),
      panelPadL: read('#ql-map-search', 'paddingLeft'),
      panelPadR: read('#ql-map-search', 'paddingRight'),
      card: document.querySelector('.ql-map-card').getBoundingClientRect()
    };
    r.style.removeProperty('--map-safe-l');
    r.style.removeProperty('--map-safe-r');
    r.style.removeProperty('--map-safe-t');
    r.style.removeProperty('--map-safe-b');
    return out;
  });
  check('every pinned control comes in by the safe area, and the map still fills the screen',
    safe.chipLeft === '56px' && safe.btnRight === '56px' &&
    safe.panelPadL === '44px' && safe.panelPadR === '44px' &&
    safe.card.left === 0 && safe.card.width === 390,
    JSON.stringify(safe));

  // ---- the two rockers are one three-way choice ----
  await p.click('#ql-map-full');
  await sleep(600);
  const flip = (id, on) => p.evaluate(([i, v]) => {
    const box = document.getElementById(i);
    box.checked = v;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, on]);

  await flip('ql-anywhere-only', false);
  await flip('ql-show-unlocated', true);
  await sleep(400);
  const allShown = await p.evaluate(() => document.querySelectorAll('.ql-item').length);

  await flip('ql-show-unlocated', false);
  await sleep(400);
  const hidden = await p.evaluate(() => ({
    shown: document.querySelectorAll('.ql-item').length,
    chip: document.getElementById('ql-map-anywhere').textContent.replace(/\s+/g, ' ').trim(),
    off: document.getElementById('ql-map-anywhere').classList.contains('is-off'),
    visible: !document.getElementById('ql-map-anywhere').classList.contains('is-hidden')
  }));
  check('turning the quests without a pin off hides exactly those',
    hidden.shown === allShown - anywhere.length,
    JSON.stringify({ shown: hidden.shown, want: allShown - anywhere.length }));
  check('the chip stays and says how many are hidden',
    hidden.visible && hidden.off && /hidden/.test(hidden.chip), JSON.stringify(hidden));

  await flip('ql-anywhere-only', true);
  await sleep(400);
  check('asking for only those quests stands the other rocker back up',
    await p.evaluate(() => document.getElementById('ql-show-unlocated').checked) &&
    (await p.evaluate(() => document.querySelectorAll('.ql-item').length)) === anywhere.length, '');

  await flip('ql-show-unlocated', false);
  await sleep(400);
  check('and hiding them again turns the other one off, never both at once',
    !(await p.evaluate(() => document.getElementById('ql-anywhere-only').checked)) &&
    (await p.evaluate(() => document.querySelectorAll('.ql-item').length)) === allShown - anywhere.length, '');

  await p.click('#ql-map-anywhere');
  await sleep(400);
  check('tapping the chip brings the hidden quests back',
    await p.evaluate(() => document.getElementById('ql-show-unlocated').checked) &&
    (await p.evaluate(() => document.querySelectorAll('.ql-item').length)) === allShown, '');

  // ---- a quest picked from the full-screen map's list opens its sheet ----
  await p.click('#ql-map-full');
  await sleep(700);
  await p.click('#ql-search-input');
  await p.fill('#ql-search-input', onMap.key);
  await sleep(400);
  await p.click('.ql-sr-item');
  await sleep(700);
  const shown = (pg) => pg.evaluate(() => {
    const sh = document.querySelector('#ql-detail-overlay .ql-detail');
    return {
      sheet: !document.getElementById('ql-detail-overlay').classList.contains('is-hidden'),
      card: sh.classList.contains('is-card'),
      title: document.getElementById('ql-detail-title').textContent,
      top: Math.round(sh.getBoundingClientRect().top),
      full: document.documentElement.classList.contains('ql-map-full')
    };
  });
  const fromList = await shown(p);
  await p.goBack();
  await sleep(700);
  const listBack = await shown(p);
  check('a quest picked from the full-screen map\'s list opens its sheet, and back closes it and leaves the map up',
    fromList.sheet && !fromList.card && fromList.title === onMap.name && !listBack.sheet && listBack.full,
    JSON.stringify({ fromList, listBack }));

  // ---- a pin on the full-screen map: the sheet's card, pulled up ----
  // A fresh page, so the map is where it starts: the pin furthest from
  // any other is worked out from the map's own projection (512px tiles,
  // zoom 9 on the page's centre) and tapped. It opens the sheet at its
  // card; a pull up on the card brings the rest of it up; back closes
  // the sheet and leaves the map.
  // The page runs as Safari before 15.4 would, without Object.hasOwn and
  // .at(), in its workers too: MapLibre calls both, and the vendored
  // bundle carries the stand-ins (an upgrade has to keep them).
  {
    const OLD_SAFARI = () => {
      const kinds = ['Array', 'String', 'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array',
        'Uint16Array', 'Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array'];
      const strip = 'delete Object.hasOwn;' + kinds.map(c => 'delete ' + c + '.prototype.at;').join('');
      delete Object.hasOwn;
      kinds.forEach(c => { delete window[c].prototype.at; });
      const Real = window.Worker;
      window.Worker = function (url, opts) {
        const pre = strip + 'importScripts(' + JSON.stringify(String(url)) + ');';
        return new Real(URL.createObjectURL(new Blob([pre], { type: 'text/javascript' })), opts);
      };
      window.Worker.prototype = Real.prototype;
    };
    const src = fs.readFileSync(path.join(SITE, 'questlist/scs-2-questlist-map.js'), 'utf8');
    const centre = JSON.parse(/var MAP_CENTER = (\[[^\]]+\])/.exec(src)[1]);
    const world = 512 * Math.pow(2, 9);
    const proj = (lng, lat) => ({ x: (lng + 180) / 360 * world, y: (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2 * world });
    const mid = proj(centre[0], centre[1]);
    const pins = [];
    list.groups.forEach(g => (g.coords || []).forEach(c => {
      const q = proj(Number(c.lng), Number(c.lat));
      pins.push({ key: g.key, name: g.name, x: 195 + q.x - mid.x, y: 422 + q.y - mid.y });
    }));
    pins.forEach(a => { a.gap = Math.min(...pins.filter(o => o !== a).map(o => Math.hypot(a.x - o.x, a.y - o.y))); });
    const lone = pins.filter(a => a.x > 40 && a.x < 330 && a.y > 90 && a.y < 680).sort((a, c) => c.gap - a.gap)[0];
    const ctx2 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx2.addInitScript(() => { try { sessionStorage.setItem('scs2-install-nudged', '1'); } catch (e) { /* private mode */ } });
    await ctx2.addInitScript(OLD_SAFARI);
    const p2 = await ctx2.newPage();
    const errors2 = []; p2.on('pageerror', e => errors2.push(e.message));
    p2.on('console', m => { if (m.type() === 'error' && /hasOwn|\.at is not|not a function/.test(m.text())) errors2.push(m.text()); });
    await p2.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await p2.route('**/files.scs.andyrew.space/**', r => {
      const u = r.request().url();
      if (u.includes('/api/questlist')) return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(list) });
      return r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
    });
    for (const host of ['tiles.scs.andyrew.space', 'tile.openstreetmap.org'])
      await p2.route('**/' + host + '/**', r => r.fulfill({ status: 404, body: '' }));
    await p2.goto(BASE + '/questlist/');
    await p2.waitForTimeout(2500);
    await p2.tap('#ql-map-full');
    await p2.waitForTimeout(1200);
    await p2.touchscreen.tap(lone.x, lone.y);
    await p2.waitForTimeout(800);
    const asCard = await shown(p2);
    const cdp = await ctx2.newCDPSession(p2);
    const y0 = asCard.top + 40;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 195, y: y0 }] });
    for (let i = 1; i <= 10; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 195, y: y0 - i * 20 }] });
      await p2.waitForTimeout(16);
    }
    await p2.waitForTimeout(200);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p2.waitForTimeout(800);
    const pulled = await shown(p2);
    await p2.goBack();
    await p2.waitForTimeout(800);
    const afterBack = await shown(p2);
    check('on Safari before 15.4, a pin on the full-screen map opens the sheet at its card, a pull up brings the rest of it up, and back closes it and leaves the map up',
      asCard.sheet && asCard.card && asCard.title === lone.name &&
      pulled.sheet && !pulled.card && pulled.top < asCard.top - 100 &&
      !afterBack.sheet && afterBack.full && errors2.length === 0,
      JSON.stringify({ pin: lone.key, asCard, pulled, afterBack, errors: errors2.slice(0, 3) }));
    await ctx2.close();
  }

  check('no page errors', errors.length === 0, errors.join(' | '));

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  await b.close();
  if (server) server.kill();
  process.exit(fail === 0 ? 0 : 1);
})();
