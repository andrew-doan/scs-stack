// The home page's slideshow. Its swipe is checked here because the
// thing that could silently break it lives somewhere else: site.js
// cancels every horizontal touchmove on the page to stop iOS's history
// swipe, and it has taken a sideways control out from under another
// file once already. The countdown these checks sat beside left the
// home page with the board when the thanks page took its place.
// Run with: node tests/verify-countdown.cjs
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
  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await new Promise(res => setTimeout(res, 1200));
  }
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});

  // ---- the slideshow's swipe ----
  // One check, on a phone, because the risk is not in index.html: the
  // edge-swipe guard in site.js cancels every horizontal drag anywhere
  // on the page, the pull-to-refresh claims the first downward one, and
  // either could take this out with nothing on the page to show for it.
  {
    const SLIDES = { ok: true, step_ms: 3000, slides: [
      { key: 'a', alt: 'one', caption: 'First' },
      { key: 'b', alt: 'two', caption: 'Second' },
      { key: 'c', alt: 'three', caption: 'Third' }
    ] };
    const shot = (fill) => '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360">' +
      '<rect width="480" height="360" fill="' + fill + '"/></svg>';
    const ctx4 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const p4 = await ctx4.newPage();
    const errs = []; p4.on('pageerror', e => errs.push(e.message));
    await p4.route('**/files.scs.andyrew.space/**', r => r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    await p4.route('**/files.scs.andyrew.space/api/slides', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(SLIDES) }));
    await p4.route('**/files.scs.andyrew.space/api/slides/file**', r => r.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: shot('#2f6fb0') }));
    await p4.goto(BASE + '/');
    await p4.waitForSelector('.hs-slide', { timeout: 4000 });
    await p4.waitForTimeout(500);

    // every picture asked for and drawn: the list is fetched through
    // site.js's scs.fetch once that has run, and the deck once drew its
    // frames and dots with no picture in any of them
    const drawn = await p4.evaluate(() => [...document.querySelectorAll('.hs-slide img')]
      .map(im => im.complete && im.naturalWidth > 0 && im.parentNode.classList.contains('is-loaded')));
    check('the slideshow draws every picture in the list',
      drawn.length === 3 && drawn.every(Boolean), JSON.stringify(drawn));

    const on = () => p4.evaluate(() => [...document.querySelectorAll('.hs-slide')].findIndex(n => n.classList.contains('is-on')));
    const box = await p4.locator('#hs-stage').boundingBox();
    const cx = Math.round(box.x + box.width / 2), cy = Math.round(box.y + box.height / 2);
    const cdp = await ctx4.newCDPSession(p4);
    const drag = async (dx, dy) => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: cx, y: cy }] });
      for (let i = 1; i <= 8; i++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: cx + dx * i / 8, y: cy + dy * i / 8 }] });
        await new Promise(r => setTimeout(r, 25));
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await new Promise(r => setTimeout(r, 500));
    };

    const start = await on();
    await drag(-260, 0);
    const left = await on();
    await drag(260, 0);
    const back = await on();
    // and a drag that is mostly up is still the page scrolling
    const y0 = await p4.evaluate(() => document.body.scrollTop);
    await drag(0, -220);
    const scrolled = await p4.evaluate(() => document.body.scrollTop) > y0 + 40;
    const still = await on();
    check('a sideways drag on the slideshow moves it, and an upward one still scrolls the page',
      left === (start + 1) % 3 && back === start && scrolled && still === back,
      JSON.stringify({ start, left, back, scrolled, still }));

    // A tap opens it in the site's photo viewer, over the whole site,
    // the top bar included; a sideways swipe there moves to the next
    // photo and the slideshow under it follows; the back gesture closes
    // it. The viewer is site.js's, so the page and site.js have to
    // agree about all three.
    await p4.evaluate(() => document.body.scrollTo(0, 0));
    await p4.waitForTimeout(200);
    const stage = await p4.locator('#hs-stage').boundingBox();
    const before = await on();
    await p4.tap('#hs-well', { position: { x: stage.width / 2, y: stage.height / 2 } });
    await p4.waitForTimeout(500);
    const opened = await p4.evaluate(() => {
      const top = document.elementFromPoint(innerWidth / 2, 10);
      return { over: !!(top && top.closest('.lb-overlay')), counter: (document.querySelector('.lb-counter') || {}).textContent };
    });
    const media = await p4.locator('img.lb-media').boundingBox();
    const mx = Math.round(media.x + media.width / 2), my = Math.round(media.y + media.height / 2);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: mx, y: my }] });
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: mx - 200 * i / 8, y: my }] });
      await new Promise(r => setTimeout(r, 25));
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p4.waitForTimeout(600);
    const swiped = await p4.evaluate(() => (document.querySelector('.lb-counter') || {}).textContent);
    const follows = await on();
    await p4.goBack();
    await p4.waitForTimeout(600);
    const shut = await p4.evaluate(() => ({ gone: !document.querySelector('.lb-overlay'), path: location.pathname }));
    check('a tap opens the photo viewer over the whole page, a swipe there moves the slideshow too, and back closes it',
      opened.over && opened.counter === (before + 1) + ' / 3' && swiped === ((before + 1) % 3 + 1) + ' / 3' &&
      follows === (before + 1) % 3 && shut.gone && shut.path === '/',
      JSON.stringify({ before, opened, swiped, follows, shut }));
    check('no page errors on the home page', errs.length === 0, JSON.stringify(errs));
    await ctx4.close();
  }

  // ---- a long run of pictures ----
  // Any number may be uploaded, so the page holds only the pictures near
  // the one on screen, the dots past ten are a window that moves along,
  // and each picture is cropped round the point the dashboard set.
  {
    const MANY = { ok: true, step_ms: 60000, slides: Array.from({ length: 25 }, (_, i) =>
      ({ key: 'k' + i, alt: 'Photo ' + i, caption: '', x: i === 0 ? 20 : 50, y: i === 0 ? 80 : 50 })) };
    const ctx5 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
    const p5 = await ctx5.newPage();
    const errs = []; p5.on('pageerror', e => errs.push(e.message));
    const cors = { 'access-control-allow-origin': '*' };
    await p5.route('**/files.scs.andyrew.space/**', r => r.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{}' }));
    await p5.route('**/files.scs.andyrew.space/api/slides', r => r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(MANY) }));
    await p5.route('**/files.scs.andyrew.space/api/slides/file**', r => r.fulfill({ status: 200, contentType: 'image/svg+xml', headers: cors,
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="480" height="360" fill="#2f6fb0"/></svg>' }));
    await p5.goto(BASE + '/');
    await p5.waitForSelector('.hs-slide', { timeout: 4000 });
    await p5.waitForTimeout(600);
    const look = () => p5.evaluate(() => {
      const row = document.getElementById('hs-dots').getBoundingClientRect();
      const dots = [...document.querySelectorAll('.hs-dot')];
      const inRow = dots.map(d => { const r = d.getBoundingClientRect(); return r.left >= row.left - 1 && r.right <= row.right + 1; });
      const on = dots.findIndex(d => d.classList.contains('is-on'));
      const firstShown = inRow.indexOf(true);
      return {
        many: document.getElementById('hs-dots').classList.contains('is-many'),
        shown: inRow.filter(Boolean).length,
        onShown: inRow[on],
        edge: firstShown > 0 ? new DOMMatrix(getComputedStyle(dots[firstShown]).transform).a : 1,
        holding: [...document.querySelectorAll('.hs-slide img')].filter(im => im.getAttribute('src')).length,
        crop: document.querySelector('.hs-slide img').style.objectPosition
      };
    });
    const first = await look();
    for (let i = 0; i < 12; i++) {
      await p5.evaluate(() => document.getElementById('hs-next').click());
      await p5.waitForTimeout(60);
    }
    await p5.waitForTimeout(500);
    const later = await look();
    check('a long run holds only the pictures near the one on screen, its dots are a window of seven that moves along, and a picture is cropped round its point',
      first.many && first.shown === 7 && first.onShown && first.holding <= 7 && first.crop === '20% 80%' &&
      later.shown === 7 && later.onShown && later.edge < 1 && later.holding <= 7 && !errs.length,
      JSON.stringify({ first, later, errs }));
    await ctx5.close();
  }

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  await b.close();
  if (server) server.kill();
  process.exit(fail ? 1 : 0);
})();
