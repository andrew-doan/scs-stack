// The home page's clock: the row on the station board that says how
// long is left. Three figures — days, hours, minutes — set plainly,
// counting to the first stop still ahead and moving to the next as each
// passes. Seconds are deliberately not shown: at thirty days out they
// were false precision, and a digit that never moves reads as broken.
// The slideshow's swipe is here too, because the thing that could
// silently break it lives somewhere else — site.js cancels every
// horizontal touchmove on the page to stop iOS's history swipe, and it
// has taken a sideways control out from under another file once
// already.
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

  // what is on screen, as the reader sees it
  const READ = () => ['days', 'hours', 'mins']
    .map(k => document.querySelector('[data-cd-' + k + ']').textContent).join(':');

  for (const mode of ['normal', 'reduced']) {
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 }, reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
    const p = await ctx.newPage();
    const errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.route('**/files.scs.andyrew.space/**', r => r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    // freeze the clock so the countdown is deterministic: 2 days, 3 hours,
    // 4 minutes, 9 seconds before the start
    await p.addInitScript(() => {
      const target = new Date('2026-10-20T09:15:00+11:00').getTime();
      let fake = target - ((2 * 86400 + 3 * 3600 + 4 * 60 + 9) * 1000);
      const RealDate = Date;
      window.__advance = (ms) => { fake += ms; };
      class FakeDate extends RealDate {
        constructor(...args) { if (args.length === 0) super(fake); else super(...args); }
        static now() { return fake; }
      }
      window.Date = FakeDate;
    });
    await p.goto(BASE + '/');
    await p.waitForTimeout(600);

    check(mode + ': the clock reads the time left in days, hours and minutes',
      (await p.evaluate(READ)) === '2:3:4', await p.evaluate(READ));

    // the whole point of dropping the flap modules: these are ordinary
    // numerals on the board, not a widget made of moving parts
    const built = await p.evaluate(() => {
      const fig = document.querySelector('[data-cd-days]');
      const cs = getComputedStyle(fig);
      return {
        flaps: document.querySelectorAll('.flap').length,
        secs: document.querySelectorAll('[data-cd-secs]').length,
        tag: fig.tagName,
        nums: cs.fontVariantNumeric,
        family: cs.fontFamily.slice(0, 20)
      };
    });
    // The flap modules went because the board is ordinary numerals, not
    // a widget made of moving parts, and that still holds. The seconds
    // came back: at a month out they are noise, but on the morning
    // itself a clock without them looks stopped.
    check(mode + ': no flap modules, and the seconds are on the board',
      built.flaps === 0 && built.secs === 1, JSON.stringify(built));
    check(mode + ': the figures are lining tabular numerals, so a change never shifts the row',
      /tabular-nums/.test(built.nums) && /lining-nums/.test(built.nums), built.nums);

    if (mode === 'normal') {
      // the seconds are the only figure that moves on its own
      const secBefore = await p.evaluate(() => document.querySelector('[data-cd-secs]').textContent);
      await p.evaluate(() => window.__advance(2000));
      await p.waitForFunction((was) => document.querySelector('[data-cd-secs]').textContent !== was,
        secBefore, { timeout: 3000 });
      check('the seconds count down on their own',
        (await p.evaluate(() => document.querySelector('[data-cd-secs]').textContent)) !== secBefore,
        secBefore + ' -> ' + (await p.evaluate(() => document.querySelector('[data-cd-secs]').textContent)));
      await p.evaluate(() => window.__advance(-2000)); // put the clock back

      // a minute on: the minutes step and nothing else moves
      await p.evaluate(() => window.__advance(60000));
      await p.waitForFunction(() => document.querySelector('[data-cd-mins]').textContent === '3', null, { timeout: 3000 });
      check('a minute on, the minutes step and the rest hold',
        (await p.evaluate(READ)) === '2:3:3', await p.evaluate(READ));

      // crossing the hour takes the hours down with it
      await p.evaluate(() => window.__advance(3 * 60 * 1000 + 10000));
      await p.waitForFunction(() => document.querySelector('[data-cd-hours]').textContent === '2', null, { timeout: 3000 });

      // a value under ten is set as one digit: a leading zero is a flap
      // convention, and "00 hours" in plain type reads as broken
      await p.evaluate(() => window.__advance(2 * 86400 * 1000 + 2 * 3600 * 1000));
      await p.waitForFunction(() => document.querySelector('[data-cd-days]').textContent === '0', null, { timeout: 3000 });

      // and the run to the start still ends with the message in place of
      // the figures
      await p.evaluate(() => window.__advance(3 * 86400 * 1000));
      await p.waitForFunction(() => document.querySelector('.countdown-grid').classList.contains('is-hidden'), null, { timeout: 4000 });
      const over = await p.evaluate(() => ({
        figs: document.querySelector('.countdown-grid').classList.contains('is-hidden'),
        msgHidden: document.querySelector('[data-cd-message]').classList.contains('is-hidden'),
        msg: document.querySelector('[data-cd-message]').textContent
      }));
      check('past the start the figures give way to the message',
        over.figs && !over.msgHidden && /SCS\.2 is/.test(over.msg), JSON.stringify(over));
    } else {
      // reduced motion changes nothing here — there is nothing to animate
      await p.evaluate(() => window.__advance(60000));
      await p.waitForFunction(() => document.querySelector('[data-cd-mins]').textContent === '3', null, { timeout: 3000 });
      check('reduced motion: the figures still count, with nothing animating',
        (await p.evaluate(READ)) === '2:3:3' && (await p.evaluate(() => document.getAnimations().length)) === 0,
        await p.evaluate(READ));
    }

    check(mode + ': no page errors', errors.length === 0, JSON.stringify(errors));
    await ctx.close();
  }

  // dark theme, and a phone width: the clock is a row inside the board,
  // so what matters is that it stays on the board and inside the screen
  const ctx2 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' });
  const p2 = await ctx2.newPage();
  await p2.route('**/files.scs.andyrew.space/**', r => r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await p2.goto(BASE + '/');
  await p2.waitForTimeout(700);
  const fits = await p2.evaluate(() => {
    const clock = document.querySelector('.board-clock');
    const board = document.querySelector('.board');
    const r = clock.getBoundingClientRect();
    const br = board.getBoundingClientRect();
    const label = document.querySelector('[data-cd-label]').getBoundingClientRect();
    const facts = document.querySelector('.board-facts > div').getBoundingClientRect();
    return {
      overflow: r.right > window.innerWidth + 0.5 || r.left < -0.5,
      onBoard: r.left >= br.left - 0.5 && r.right <= br.right + 0.5,
      // the label sits on the same reading edge as the facts above it
      edge: Math.abs(label.left - facts.left) < 1.5,
      inset: Math.round(label.left - br.left)
    };
  });
  await ctx2.close();

  // ---- the run of stops the dashboard holds ----
  // The page counts to the first stop still ahead and moves to the next
  // as each passes. The date in the markup is what it shows until the
  // worker answers — and instead of it, if the worker never does.
  {
    const STOPS = { stops: [
      { label: 'SCS.2 starts', at: '2026-10-19 22:00:00' },      // 09:00 +11
      { label: 'Submissions close', at: '2026-10-20 06:00:00' }, // 17:00 +11
      { label: 'Closing ceremony', at: '2026-10-20 07:00:00' }   // 18:00 +11
    ], over: 'That was SCS.2. See you at the ceremony.' };
    let serveStops = true;
    const ctx3 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
    const p3 = await ctx3.newPage();
    const errs = []; p3.on('pageerror', e => errs.push(e.message));
    // the catch-all goes on first: a later route wins over an earlier one
    await p3.route('**/files.scs.andyrew.space/**', r => r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    await p3.route('**/files.scs.andyrew.space/api/countdown', r => r.fulfill(serveStops
      ? { status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(STOPS) }
      : { status: 500, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    await p3.addInitScript(() => {
      let fake = new Date('2026-10-19T22:00:00Z').getTime() - 90000; // ninety seconds out
      const RealDate = Date;
      window.__advance = (ms) => { fake += ms; };
      class FakeDate extends RealDate {
        constructor(...args) { if (args.length === 0) super(fake); else super(...args); }
        static now() { return fake; }
      }
      window.Date = FakeDate;
    });
    const label = () => p3.evaluate(() => document.querySelector('[data-cd-label]').textContent);
    const board = () => p3.evaluate(READ);

    await p3.goto(BASE + '/');
    await p3.waitForFunction(() => document.querySelector('[data-cd-label]').textContent === 'SCS.2 starts', null, { timeout: 4000 });
    check('the saved stops take over from the date in the markup',
      (await board()) === '0:0:1', await board());

    // the first stop passing moves the board to the next one
    await p3.evaluate(() => window.__advance(91000));
    await p3.waitForFunction(() => document.querySelector('[data-cd-label]').textContent === 'Submissions close', null, { timeout: 4000 });
    check('a stop passing moves the clock to the next one rather than ending it',
      (await board()) === '0:7:59' &&
      !(await p3.evaluate(() => document.querySelector('.countdown-grid').classList.contains('is-hidden'))),
      await board());

    await p3.evaluate(() => window.__advance(8 * 3600 * 1000));
    await p3.waitForFunction(() => document.querySelector('[data-cd-label]').textContent === 'Closing ceremony', null, { timeout: 4000 });
    check('and on to the last one', (await label()) === 'Closing ceremony', await board());

    await p3.evaluate(() => window.__advance(3600 * 1000 + 2000));
    await p3.waitForFunction(() => document.querySelector('.countdown-grid').classList.contains('is-hidden'), null, { timeout: 4000 });
    const endLine = await p3.evaluate(() => document.querySelector('[data-cd-message]').textContent);
    check('past the last stop the figures give way to the line the dashboard set',
      endLine === 'That was SCS.2. See you at the ceremony.', endLine);

    const kept = await p3.evaluate(() => localStorage.getItem('scs2-countdown'));
    check('the stops are kept for the next visit', /Submissions close/.test(kept || ''), String(kept).slice(0, 60));

    // the point of keeping them: a worker that cannot be reached changes
    // nothing on screen, and there is no loading state to sit through
    serveStops = false;
    await p3.reload();
    await p3.waitForTimeout(700);
    check('with the worker refusing, the kept copy still drives the clock',
      (await label()) === 'SCS.2 starts' && (await board()) === '0:0:1',
      JSON.stringify({ label: await label(), board: await board() }));
    check('no page errors', errs.length === 0, JSON.stringify(errs));
    await ctx3.close();
  }

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
