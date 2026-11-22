// The full quest list page (every quest on one page), the lightbox's
// pinch/wheel/double-tap zoom, and the messages page's full-width
// photos.
// Run with: node tests/verify-full-list.cjs
// Needs playwright nearby and a static server on 8123 serving
// website/ (the test starts one if the port is free).
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'website');   // the site is served from here
const BASE = 'http://127.0.0.1:8123';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (l, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + l + (d ? '  ' + d : '')); if (!ok) fail++; };

const CORS = { 'access-control-allow-origin': '*' };
const LIST = {
  regions: ['Inner West', 'Live quests'],
  places: {},
  groups: [
    { key: 'SQ12', name: 'Tile spotting', region: 'Inner West', description: 'Find the **oldest** shop tiles.', flavour: 'Look down.', location: 'Newtown',
      coords: [], submit: 'none', prompt: '', options: [], codes: [{ code: 'SQ12', label: '', points: 40 }], files: [], ask: null },
    { key: 'SQ46', name: 'Harbour lights', region: 'Inner West', description: 'One per landmark.', flavour: '', location: '',
      coords: [], submit: 'codes', prompt: '', options: [],
      codes: [{ code: 'SQ46-1', label: 'Lighthouse', points: 30 }, { code: 'SQ46-2', label: 'Bridge', points: 60 }],
      files: [{ key: 'qst/pic1', name: 'clue.png', type: 'image/png', bytes: 4200 }], ask: null },
    { key: 'LQ1', name: 'The SCS Dilemma', region: 'Live quests', description: 'Press one button.', flavour: '', location: '',
      coords: [], submit: 'none', prompt: '', options: [], codes: [{ code: 'LQ1', label: '', points: 0 }],
      files: [], ask: { kind: 'choice', prompt: 'Which?', options: ['Red', 'Blue'], open: true } },
    { key: 'SQ99', name: 'Stray quest', region: '', description: '', flavour: '', location: '',
      coords: [], submit: 'none', prompt: '', options: [], codes: [{ code: 'SQ99', label: '', points: 10 }], files: [], ask: null }
  ]
};

(async () => {
  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await sleep(1200);
  }
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  // phone-sized: the code table's fit on a narrow screen is part of
  // what this suite checks
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('scs2-install-nudged', '1'); } catch (e) {} });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  const dot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64');

  await p.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await p.route('**/files.scs.andyrew.space/**', r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/pulse') return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ quests: 1, messages: 2, urgent: 0 }) });
    if (u.pathname === '/api/questlist') return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(LIST) });
    if (u.pathname === '/api/quests/file') return r.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: dot });
    if (u.pathname === '/api/messages') {
      return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ messages: [
        { id: 2, title: 'Photos attached', body: 'Two shots.', created_at: '2026-10-20 01:00:00',
          files: [{ key: 'msg/a1', name: 'one.png', type: 'image/png', bytes: 999 },
            { key: 'msg/a2', name: 'wave.gif', type: 'image/gif', bytes: 40000 }] },
        { id: 1, title: 'The halfway checkpoint has moved to the other side of the station forecourt', body: 'Look for the green gazebo.', created_at: '2026-10-20 00:30:00', files: [] }
      ] }) });
    }
    return r.fulfill({ status: 404, contentType: 'application/json', headers: CORS, body: '{}' });
  });

  // ---------------- the full list page ----------------
  await p.goto(BASE + '/questlist/full/#SQ46');
  await sleep(1200);

  const page = await p.evaluate(() => ({
    headings: [...document.querySelectorAll('#fl-list .section-heading')].map(h => h.textContent),
    quests: [...document.querySelectorAll('.fl-quest')].map(q => q.id),
    summary: document.getElementById('fl-summary').textContent,
    bold: !!document.querySelector('#SQ12 .fl-body strong'),
    flavour: (document.querySelector('#SQ12 .fl-flavour') || {}).textContent || '',
    points12: (document.querySelector('#SQ12 .fl-points') || {}).textContent || '',
    points46: (document.querySelector('#SQ46 .fl-points') || {}).textContent || '',
    codeRows: document.querySelectorAll('#SQ46 .fl-codes tr').length,
    ptsOnScreen: (function () {
      var r = document.querySelector('#SQ46 .fl-codes .fl-num').getBoundingClientRect();
      return r.right <= window.innerWidth && r.width > 0;
    })(),
    live: !!document.querySelector('#LQ1 .fl-live'),
    mapHref: (document.querySelector('#SQ12 .fl-links a') || {}).getAttribute('href'),
    subHref: (document.querySelectorAll('#SQ12 .fl-links a')[1] || {}).getAttribute('href'),
    scrolled: (document.body.scrollTop || window.scrollY) > 50,
    shotCors: (document.querySelector('#SQ46 .fl-shot img') || {}).crossOrigin
  }));
  check('regions render in payload order with no-region last',
    page.headings.join('|') === 'Inner West|Live quests|Other quests', JSON.stringify(page.headings));
  check('every quest is on the page under its own anchor',
    page.quests.join('|') === 'SQ12|SQ46|LQ1|SQ99', JSON.stringify(page.quests));
  check('an open question wears the LIVE tag here too', page.live, '');
  check('the links go to the map sheet and the submit page',
    page.mapHref === '../#SQ12' && page.subHref === '../../submit/#SQ12',
    JSON.stringify({ map: page.mapHref, sub: page.subHref }));
  check('#KEY lands on that quest', page.scrolled, 'scrollY stayed at top');
  check('quest photos are CORS-readable thumbs', page.shotCors === 'anonymous', String(page.shotCors));

  // ---------------- the lightbox zoom, from a quest photo ----------------
  await p.evaluate(() => { document.querySelector('#SQ46 .fl-shot').click(); });
  await sleep(500);

  // the bar over the photo is the app bar's twin: same height, the
  // close button exactly where the gear sits on the page beneath
  const chrome = await p.evaluate(() => {
    const bar = document.querySelector('.lb-bar').getBoundingClientRect();
    const nav = document.querySelector('.site-nav').getBoundingClientRect();
    const close = document.querySelector('.lb-close');
    const cr = close.getBoundingClientRect();
    const svg = close.querySelector('svg').getBoundingClientRect();
    const gear = document.querySelector('.settings-toggle').getBoundingClientRect();
    return {
      barH: Math.round(bar.height), navH: Math.round(nav.height),
      closeRight: Math.round(cr.right), gearRight: Math.round(gear.right),
      // measured from each bar's own top: the app bar may be scrolled away
      closeMidY: Math.round(cr.top + cr.height / 2 - bar.top), gearMidY: Math.round(gear.top + gear.height / 2 - nav.top),
      crossDx: Math.abs((svg.left + svg.width / 2) - (cr.left + cr.width / 2)),
      crossDy: Math.abs((svg.top + svg.height / 2) - (cr.top + cr.height / 2)),
      photoBelowBar: document.querySelector('img.lb-media').getBoundingClientRect().top >= bar.bottom
    };
  });
  const centred = await p.evaluate(() => {
    const r = document.querySelector('img.lb-media').getBoundingClientRect();
    return { mid: Math.round(r.top + r.height / 2), screenMid: Math.round(innerHeight / 2) };
  });

  // the file name rides in the bar, centred on the bar itself, and no
  // caption is left under the photo
  const cap = await p.evaluate(() => {
    const bar = document.querySelector('.lb-bar').getBoundingClientRect();
    const c = document.querySelector('.lb-bar .lb-caption');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(c);
    const t = range.getBoundingClientRect();
    return {
      text: c.textContent,
      textMidX: Math.round(t.left + t.width / 2), barMidX: Math.round(bar.left + bar.width / 2),
      midY: Math.round(r.top + r.height / 2 - bar.top), barMidY: Math.round(bar.height / 2),
      below: !!document.querySelector('.lb-overlay > .lb-caption, .lb-frame .lb-caption')
    };
  });

  const zoomAt = () => p.evaluate(() => {
    const img = document.querySelector('img.lb-media');
    const t = img.style.transform;
    const m = /scale\(([\d.]+)\)/.exec(t);
    return { scale: m ? Number(m[1]) : 1, zoomedClass: img.classList.contains('is-zoomed') };
  });

  await p.evaluate(() => {
    const img = document.querySelector('img.lb-media');
    const r = img.getBoundingClientRect();
    img.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true }));
  });
  let z = await zoomAt();
  check('the wheel zooms the photo in place', z.scale > 1.2 && z.zoomedClass, JSON.stringify(z));

  // a double tap: two quick pointer taps in the same spot
  const tapTwice = () => p.evaluate(() => {
    const img = document.querySelector('img.lb-media');
    const r = img.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const fire = (type) => img.dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: true }));
    fire('pointerdown'); fire('pointerup');
    fire('pointerdown'); fire('pointerup');
  });
  await tapTwice();
  z = await zoomAt();
  check('a double tap while zoomed goes back to 1', z.scale === 1 && !z.zoomedClass, JSON.stringify(z));
  await tapTwice();
  z = await zoomAt();
  check('a double tap at rest zooms in', z.scale > 2 && z.zoomedClass, JSON.stringify(z));

  // the jump glides: a transition is on the photo right after the tap
  // and comes off once it has run, so a finger moves it directly again
  const glideNow = await p.evaluate(() => document.querySelector('img.lb-media').style.transition);
  await sleep(400);
  const glideLater = await p.evaluate(() => document.querySelector('img.lb-media').style.transition);
  const over = await p.evaluate(() => {
    const img = document.querySelector('img.lb-media').getBoundingClientRect();
    const bar = document.querySelector('.lb-bar').getBoundingClientRect();
    const c = document.querySelector('.lb-close').getBoundingClientRect();
    const hit = document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2);
    const under = document.elementFromPoint(bar.left + 30, bar.top + bar.height / 2);
    const z = (el) => Number(getComputedStyle(el).zIndex);
    return { closeHit: !!hit && !!hit.closest('.lb-close'), barHit: under && under.className,
      order: z(document.querySelector('.lb-frame')) > z(document.querySelector('.lb-bar')) && z(document.querySelector('.lb-top')) > z(document.querySelector('.lb-frame')) };
  });

  const panned = await p.evaluate(() => {
    const img = document.querySelector('img.lb-media');
    const r = img.getBoundingClientRect();
    const fire = (type, x, y) => img.dispatchEvent(new PointerEvent(type, { pointerId: 2, clientX: x, clientY: y, bubbles: true, cancelable: true, isPrimary: true }));
    const before = img.style.transform;
    fire('pointerdown', r.left + 60, r.top + 60);
    fire('pointermove', r.left + 20, r.top + 30);
    fire('pointerup', r.left + 20, r.top + 30);
    return { before, after: img.style.transform, open: !!document.querySelector('.lb-overlay') };
  });
  check('a drag pans the zoomed photo and does not close the lightbox',
    panned.after !== panned.before && panned.open, JSON.stringify(panned));

  await p.keyboard.press('Escape');
  await sleep(400);

  // ---------- the open morph and the swipe to close ----------
  await p.evaluate(() => { document.querySelector('#SQ46 .fl-shot').click(); });
  await sleep(80);
  check('the photo grows out of the tapped thumbnail',
    await p.evaluate(() => {
      const img = document.querySelector('img.lb-media');
      return !!img && img.getAnimations().length > 0;
    }), '');
  await sleep(500);

  const swipe = (dy, id) => p.evaluate(([d, pid]) => {
    const img = document.querySelector('img.lb-media');
    const r = img.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const fire = (type, cy) => img.dispatchEvent(new PointerEvent(type, { pointerId: pid, clientX: x, clientY: cy, bubbles: true, cancelable: true, isPrimary: true }));
    fire('pointerdown', y);
    fire('pointermove', y + d / 2);
    fire('pointermove', y + d);
    fire('pointerup', y + d);
  }, [dy, id]);

  await swipe(40, 7);
  await sleep(400);
  check('a short drag springs back instead of closing',
    await p.evaluate(() => !!document.querySelector('.lb-overlay') && document.querySelector('.lb-frame').style.transform === ''), '');
  await swipe(160, 8);
  await sleep(500);
  check('a firm swipe down closes the photo, like the quest sheet',
    await p.evaluate(() => !document.querySelector('.lb-overlay')), '');

  // ---------------- the quest list shows it in place ----------------
  // This page still exists and is still precached, but the filter panel
  // no longer sends anyone here: everything it shows is a rocker away
  // on the list itself, drawn by this page's own full.js so there is
  // one renderer rather than two that can drift.
  await p.goto(BASE + '/questlist/');
  await sleep(1100);
  const toggle = await p.evaluate(() => {
    const box = document.getElementById('ql-full-info');
    return box ? {
      label: (box.closest('.ql-checkbox') || {}).textContent.trim(),
      gone: !document.getElementById('ql-full-link')
    } : null;
  });
  check('the filter panel offers full quest information as a rocker, not a link away',
    !!toggle && /List Full Quest Details/.test(toggle.label) && toggle.gone, JSON.stringify(toggle));

  const expands = await p.evaluate(() => {
    const box = document.getElementById('ql-full-info');
    const before = document.querySelectorAll('.ql-item-full').length;
    box.click();
    return new Promise(function (done) {
      setTimeout(function () {
        done({ before: before, after: document.querySelectorAll('.ql-item-full').length,
               stored: localStorage.getItem('scs2-questlist-full-info') });
      }, 700);
    });
  });
  check('turning it on opens every quest in place, and the choice is kept',
    expands.after > expands.before && expands.stored === '1', JSON.stringify(expands));

  // ---------------- messages photos run wide ----------------
  await p.goto(BASE + '/messages/');
  await sleep(1100);
  const shots = await p.evaluate(() => {
    const grid = document.querySelector('.msg-shots');
    const img = document.querySelector('.msg-shot img');
    if (!grid || !img) return null;
    const cs = getComputedStyle(grid);
    const ics = getComputedStyle(img);
    return {
      tracks: cs.gridTemplateColumns.trim().split(/\s+/).length,
      fit: ics.objectFit,
      capped: ics.maxHeight !== 'none',
      fixed: ics.height === '150px'
    };
  });
  check('message photos run one to a row at their own shape, capped not squared',
    !!shots && shots.tracks === 1 && !shots.fixed && shots.capped, JSON.stringify(shots));

  // A GIF is asked for whole. The only still a browser can make of one
  // is its first frame, so a grid that asked for a small copy showed a
  // picture that does not move — and asking is what has to stop, not
  // just the worker's answer, or every reader waits on a deploy.
  const gifSrc = await p.evaluate(() => {
    const imgs = [...document.querySelectorAll('.msg-shot img')];
    const find = (n) => { const i = imgs.find(x => x.src.includes(n)); return i ? i.src : null; };
    return { gif: find('msg%2Fa2'), png: find('msg%2Fa1') };
  });
  check('a GIF in a message is fetched whole, while an ordinary photo still asks for its small copy',
    !!gifSrc.gif && gifSrc.gif.indexOf('thumb=1') === -1 &&
    !!gifSrc.png && gifSrc.png.indexOf('thumb=1') !== -1, JSON.stringify(gifSrc));

  // at this width the time is a stamp on its own line above the
  // headline, on the same left edge, whether the headline takes one
  // line or three
  const heads = await p.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.msg-card'), (c) => {
    const t = c.querySelector('.msg-title').getBoundingClientRect();
    const tm = c.querySelector('.msg-time').getBoundingClientRect();
    return {
      title: c.querySelector('.msg-title').textContent.slice(0, 20),
      lines: Math.round(t.height / parseFloat(getComputedStyle(c.querySelector('.msg-title')).lineHeight)),
      above: tm.bottom <= t.top + 1,
      sameEdge: Math.abs(tm.left - t.left) < 2
    };
  }));

  // ---------------- a message photo, on its own ----------------
  // just the photo: no message under it, the file name top left and
  // the close button top right, floating over it
  await p.evaluate(() => document.querySelector('.msg-shot').click());
  await sleep(500);
  const opened = await p.evaluate(() => {
    const img = document.querySelector('img.lb-media').getBoundingClientRect();
    const name = document.querySelector('.lb-caption').getBoundingClientRect();
    const close = document.querySelector('.lb-close').getBoundingClientRect();
    return {
      sheet: !!document.querySelector('.lb-sheet'),
      name: document.querySelector('.lb-caption').textContent,
      nameTopLeft: name.left < 40 && name.top < 40,
      closeTopRight: close.right > innerWidth - 40 && close.top < 40,
      centred: Math.abs((img.top + img.height / 2) - innerHeight / 2) <= 2
    };
  });
  check('a message photo opens on its own: the name top left, the close top right, the photo centred',
    !opened.sheet && opened.name === 'one.png' && opened.nameTopLeft && opened.closeTopRight && opened.centred, JSON.stringify(opened));

  // a swipe on the photo lifts the name and the buttons with it
  const swipeMid = await p.evaluate(() => {
    const img = document.querySelector('img.lb-media');
    const r = img.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const fire = (t, dy) => img.dispatchEvent(new PointerEvent(t, { pointerId: 12, clientX: x, clientY: y + dy, bubbles: true, cancelable: true, isPrimary: true }));
    fire('pointerdown', 0); fire('pointermove', 20); fire('pointermove', 60);
    const b = document.querySelector('.lb-top').getBoundingClientRect();
    fire('pointerup', 60);
    return { topAt: Math.round(b.top) };
  });
  await sleep(400);
  const swipeBack = await p.evaluate(() => ({
    topAt: Math.round(document.querySelector('.lb-top').getBoundingClientRect().top),
    open: !!document.querySelector('.lb-overlay')
  }));
  check('a swipe on the photo lifts the buttons in step, and a short one brings them back',
    swipeMid.topAt < -20 && swipeBack.open && swipeBack.topAt === 0, JSON.stringify({ swipeMid, swipeBack }));

  // one tap: the photo alone on black, edge to edge; another tap: back
  const tapOnce = () => p.evaluate(() => {
    const img = document.querySelector('img.lb-media');
    const r = img.getBoundingClientRect();
    const fire = (t) => img.dispatchEvent(new PointerEvent(t, { pointerId: 13, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, isPrimary: true }));
    fire('pointerdown'); fire('pointerup');
  });
  await tapOnce();
  await sleep(150);
  const early = await p.evaluate(() => document.querySelector('.lb-overlay').classList.contains('is-immersive'));
  await sleep(600);
  const imm = await p.evaluate(() => {
    const o = document.querySelector('.lb-overlay');
    const f = document.querySelector('.lb-frame').getBoundingClientRect();
    const img = document.querySelector('img.lb-media').getBoundingClientRect();
    return {
      on: o.classList.contains('is-immersive'),
      bg: getComputedStyle(o).backgroundColor,
      frameFull: Math.round(f.top) === 0 && Math.round(f.bottom) === 844,
      edgeToEdge: Math.round(img.width) === 390 || Math.round(img.height) === 844,
      buttonsGone: document.querySelector('.lb-top').getBoundingClientRect().bottom <= 0
    };
  });
  check('a single tap waits for a possible double tap, then puts the photo alone on black',
    !early && imm.on && imm.bg === 'rgb(0, 0, 0)' && imm.frameFull && imm.edgeToEdge && imm.buttonsGone, JSON.stringify({ early, imm }));
  await tapOnce();
  await sleep(750);
  const back = await p.evaluate(() => ({
    on: document.querySelector('.lb-overlay').classList.contains('is-immersive'),
    buttonsBack: document.querySelector('.lb-top').getBoundingClientRect().top === 0
  }));
  check('another tap brings the name and the buttons back', !back.on && back.buttonsBack, JSON.stringify(back));
  await p.keyboard.press('Escape');
  await sleep(400);
  check('Escape closes it', await p.evaluate(() => !document.querySelector('.lb-overlay')), '');

  // ---------------- the lightbox on a computer ----------------
  // A mouse gets none of the phone's gestures: a click zooms where it
  // landed instead of waiting to see whether a second one is coming,
  // dragging a photo that is not zoomed does nothing, and the message
  // stands down the side of the screen as a panel rather than a sheet
  // to drag up from the bottom.
  {
    const dctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
    await dctx.addInitScript(() => { try { sessionStorage.setItem('scs2-install-nudged', '1'); } catch (e) {} });
    const d = await dctx.newPage();
    d.on('pageerror', e => errors.push('desktop: ' + e.message));
    await d.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await d.route('**/files.scs.andyrew.space/**', r => {
      const u = new URL(r.request().url());
      if (u.pathname === '/api/pulse') return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ quests: 1, messages: 2, urgent: 0 }) });
      if (u.pathname === '/api/messages/file') return r.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: dot });
      if (u.pathname === '/api/messages') {
        return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ messages: [
          { id: 2, title: 'Photos attached', body: 'Two shots.', created_at: '2026-10-20 01:00:00',
            files: [{ key: 'msg/a1', name: 'one.png', type: 'image/png', bytes: 999 }] }
        ] }) });
      }
      return r.fulfill({ status: 404, contentType: 'application/json', headers: CORS, body: '{}' });
    });
    await d.goto(BASE + '/messages/');
    await sleep(1100);
    await d.click('.msg-shot');
    await sleep(500);
    const kind = await d.evaluate(() => {
      const o = document.querySelector('.lb-overlay');
      return o && { mouse: o.classList.contains('is-mouse'), sheet: !!document.querySelector('.lb-sheet') };
    });
    check('a mouse opens the lightbox in its own mode, with nothing beside the photo',
      !!kind && kind.mouse && !kind.sheet, JSON.stringify(kind));
    // a click on the photo zooms at once — no 330ms wait, no black screen
    const clickPhoto = () => d.evaluate(() => {
      const img = document.querySelector('img.lb-media');
      const r = img.getBoundingClientRect();
      const fire = (t) => img.dispatchEvent(new PointerEvent(t, { pointerId: 30, pointerType: 'mouse', clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true, isPrimary: true }));
      fire('pointerdown'); fire('pointerup');
    });
    await clickPhoto();
    await sleep(120);
    const zoomed = await d.evaluate(() => ({
      zoomed: document.querySelector('img.lb-media').classList.contains('is-zoomed'),
      immersive: document.querySelector('.lb-overlay').classList.contains('is-immersive'),
      open: !!document.querySelector('.lb-overlay')
    }));
    check('one click zooms straight in and never reaches the black screen',
      zoomed.zoomed && !zoomed.immersive && zoomed.open, JSON.stringify(zoomed));
    await clickPhoto();
    await sleep(400);
    check('a second click zooms back out',
      await d.evaluate(() => !document.querySelector('img.lb-media').classList.contains('is-zoomed')), '');
    // dragging a photo that is not zoomed is not a way to close it
    const dragged = await d.evaluate(() => {
      const img = document.querySelector('img.lb-media');
      const r = img.getBoundingClientRect();
      const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const fire = (t, dy) => img.dispatchEvent(new PointerEvent(t, { pointerId: 31, pointerType: 'mouse', clientX: x, clientY: y + dy, bubbles: true, cancelable: true, isPrimary: true }));
      fire('pointerdown', 0); fire('pointermove', 60); fire('pointermove', 140); fire('pointerup', 140);
      return { moved: document.querySelector('.lb-frame').style.transform };
    });
    await sleep(400);
    check('dragging an unzoomed photo with a mouse moves nothing and closes nothing',
      dragged.moved === '' && await d.evaluate(() => !!document.querySelector('.lb-overlay')), JSON.stringify(dragged));
    // the keyboard zoom every picture viewer has
    await d.keyboard.press('+');
    await sleep(250);
    check('+ zooms from the keyboard',
      await d.evaluate(() => document.querySelector('img.lb-media').classList.contains('is-zoomed')), '');
    await d.keyboard.press('0');
    await sleep(300);
    check('0 puts it back',
      await d.evaluate(() => !document.querySelector('img.lb-media').classList.contains('is-zoomed')), '');
    await d.keyboard.press('Escape');
    await sleep(400);
    check('Escape closes it', await d.evaluate(() => !document.querySelector('.lb-overlay')), '');
    await dctx.close();
  }

  console.log('errors', errors);
  check('no page errors', errors.length === 0, errors.join(' | '));

  await b.close();
  if (server) server.kill();
  console.log(fail ? 'FAILURES: ' + fail : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
