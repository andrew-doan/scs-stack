// Hand-built touch sequences: the sheet's hand-scroll (handover from the
// first move — content scrolling inside the sheet is never left to the
// browser's own pan, so a gesture that reverses direction cannot have
// the browser and the script moving things at once), the grab bar
// pinned at the sheet's top, and the pull arrow still arming after a
// gesture that went up before it came down.
// Run with: node tests/verify-sheet-gestures.cjs
// Needs playwright nearby and a static server on 8123 serving
// website/ (the test starts one if the port is free).
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'website');   // the site is served from here
const BASE = 'http://127.0.0.1:8123';
let fail = 0;
const check = (l, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + l + (d ? '  ' + d : '')); if (!ok) fail++; };

(async () => {
  const q = await import(path.join(ROOT, 'tab/src/data/scs2-quests.ts'));
  const pl = await import(path.join(ROOT, 'tab/src/data/places.ts'));
  const list = { regions: q.REGIONS, groups: q.QUESTS.map(g => ({ key: g.key, name: g.name, region: g.region, description: g.description, flavour: g.flavour, location: g.location, coords: g.coords, submit: g.submit, prompt: g.prompt, options: g.options, codes: g.codes })), places: pl.PLACES };

  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await new Promise(res => setTimeout(res, 1200));
  }
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  p.on('pageerror', e => console.log('pageerror', e.message));
  await p.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: r.request().url().endsWith('.css') ? 'text/css' : 'application/javascript', body: '' }));
  await p.route('**/files.scs.andyrew.space/**', r => {
    const u = r.request().url();
    if (u.includes('/api/questlist')) return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(list) });
    return r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
  await p.route('**/tiles.scs.andyrew.space/**', r => r.fulfill({ status: 404, body: '' }));
  await p.goto(BASE + '/questlist/');
  await p.waitForTimeout(1300);

  // ---- open a sheet and make its content long ----
  await p.evaluate(() => {
    const it = [...document.querySelectorAll('.ql-item')].find(i => i.dataset.questId === 'Arc');
    it.scrollIntoView();
    it.querySelector('.ql-item-body').click();
  });
  await p.waitForTimeout(900);
  await p.evaluate(() => {
    const body = document.getElementById('ql-detail-description');
    for (let i = 0; i < 40; i++) {
      const el = document.createElement('p');
      el.textContent = 'Filler line ' + i + ' to make the sheet content much taller than the screen.';
      body.appendChild(el);
    }
  });

  // ---- one continuous gesture: up into handover, then reverse ----
  const drag = await p.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const sheet = document.querySelector('#ql-detail-overlay .ql-detail');
    const body = document.getElementById('ql-detail-description');
    const send = (type, x, y) => {
      const t = new Touch({ identifier: 1, target: body, clientX: x, clientY: y });
      body.dispatchEvent(new TouchEvent(type, {
        touches: type === 'touchend' ? [] : [t],
        changedTouches: [t],
        bubbles: true, cancelable: true
      }));
    };
    const out = {};
    let y = 700;
    send('touchstart', 200, y);
    await sleep(40);
    // up far enough to reach full and keep going: content should scroll
    for (let i = 0; i < 16; i++) { y -= 40; send('touchmove', 200, y); await sleep(20); }
    out.scrolledTo = sheet.scrollTop;
    out.isFull = sheet.classList.contains('is-full');
    const sheetRect = sheet.getBoundingClientRect();
    const barRect = document.querySelector('.ql-sheet-handle').getBoundingClientRect();
    out.barAtTop = Math.abs(barRect.top - sheetRect.top) < 4;
    out.barStyle = getComputedStyle(document.querySelector('.ql-sheet-handle')).position;
    // reverse: content should come back roughly with the finger, the
    // sheet itself not moving until the content is back at its top
    const before = sheet.scrollTop;
    const topBefore = sheetRect.top;
    for (let i = 0; i < 4; i++) { y += 40; send('touchmove', 200, y); await sleep(20); }
    out.reversedBy = before - sheet.scrollTop;
    out.sheetHeld = Math.abs(sheet.getBoundingClientRect().top - topBefore) < 2;
    // all the way down: content reaches its top, then the sheet moves
    for (let i = 0; i < 16; i++) { y += 44; send('touchmove', 200, y); await sleep(20); }
    out.backAtTop = sheet.scrollTop <= 0;
    out.sheetMoved = sheet.getBoundingClientRect().top - topBefore;
    send('touchend', 200, y);
    await sleep(120);
    return out;
  });
  check('an upward gesture grows the sheet to full and scrolls the content by hand',
    drag.isFull && drag.scrolledTo > 100, JSON.stringify(drag));
  check('the grab bar stays pinned at the sheet top while the content scrolls',
    drag.barAtTop && drag.barStyle === 'sticky', JSON.stringify({ atTop: drag.barAtTop, position: drag.barStyle }));
  check('reversing inside the gesture scrolls the content back with the finger, sheet held still',
    drag.reversedBy > 100 && drag.reversedBy < 200 && drag.sheetHeld, JSON.stringify({ reversedBy: drag.reversedBy, held: drag.sheetHeld }));
  check('and once the content is back at its top the sheet itself follows the finger down',
    drag.backAtTop && drag.sheetMoved > 60, JSON.stringify({ atTop: drag.backAtTop, moved: drag.sheetMoved }));
  await p.keyboard.press('Escape');
  await p.waitForTimeout(700);

  // ---- pull to refresh: up first, then a long pull down ----
  await p.evaluate(() => { document.body.scrollTop = 0; });
  await p.waitForTimeout(200);
  const ptr = await p.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    window.__stayed = true;
    const main = document.querySelector('main[data-pull]');
    const send = (type, y) => {
      const t = new Touch({ identifier: 2, target: main, clientX: 200, clientY: y });
      main.dispatchEvent(new TouchEvent(type, {
        touches: type === 'touchend' ? [] : [t],
        changedTouches: [t],
        bubbles: true, cancelable: true
      }));
    };
    let y = 400;
    send('touchstart', y);
    await sleep(40);
    y -= 30; send('touchmove', y); await sleep(30); // first move up: the browser's
    y -= 10; send('touchmove', y); await sleep(30);
    for (let i = 0; i < 8; i++) { y += 30; send('touchmove', y); await sleep(30); } // then a long pull down
    const armed = document.querySelector('.ptr').classList.contains('is-armed');
    send('touchend', y);
    await sleep(120);
    return { armed, barRuns: document.querySelector('.ptr-bar').classList.contains('is-loading') };
  });
  check('after an up-then-down gesture the arrow still arms and the release reloads',
    ptr.armed && ptr.barRuns, JSON.stringify(ptr));
  await p.waitForTimeout(1100);
  check('the reload actually happened', await p.evaluate(() => window.__stayed !== true), '');

  // ---- the ordinary first-move-down pull still works ----
  await p.waitForTimeout(1200);
  const plain = await p.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    window.__stayed = true;
    const main = document.querySelector('main[data-pull]');
    const send = (type, y) => {
      const t = new Touch({ identifier: 3, target: main, clientX: 200, clientY: y });
      main.dispatchEvent(new TouchEvent(type, {
        touches: type === 'touchend' ? [] : [t],
        changedTouches: [t],
        bubbles: true, cancelable: true
      }));
    };
    let y = 300;
    send('touchstart', y);
    await sleep(40);
    for (let i = 0; i < 6; i++) { y += 25; send('touchmove', y); await sleep(30); }
    const state = {
      pulling: document.documentElement.classList.contains('is-pulling'),
      pull: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--pull')),
      armed: document.querySelector('.ptr').classList.contains('is-armed')
    };
    send('touchend', y);
    await sleep(120);
    state.barRuns = document.querySelector('.ptr-bar').classList.contains('is-loading');
    return state;
  });
  check('a plain pull still follows the finger, arms and reloads',
    plain.pulling && plain.pull > 40 && plain.armed && plain.barRuns, JSON.stringify(plain));
  await p.waitForTimeout(1100);
  check('and that reload happened too', await p.evaluate(() => window.__stayed !== true), '');

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  await b.close();
  if (server) server.kill();
  process.exit(fail ? 1 : 0);
})();
