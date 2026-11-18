// The app layout on the mobile web: on by default, a switch in the
// settings menu turns it off, and the installed app ignores the switch.
// Run with: node tests/verify-app-layout.cjs
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

const stub = async (p) => {
  await p.route('**/files.scs.andyrew.space/**', r => r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await p.route('**/unpkg.com/**', r => r.fulfill({ status: 200, body: '' }));
};

const layout = (p) => p.evaluate(() => {
  const tab = document.querySelector('.tab-bar');
  const foot = document.querySelector('body > .site-footer');
  return {
    pwa: document.documentElement.classList.contains('is-pwa'),
    installed: document.documentElement.classList.contains('is-installed'),
    tabBar: tab ? getComputedStyle(tab).display : 'none',
    navH: getComputedStyle(document.documentElement).getPropertyValue('--nav-h').trim(),
    bodyPadTop: getComputedStyle(document.body).paddingTop,
    rowShown: (() => { const r = document.querySelector('.settings-app-row'); return r ? getComputedStyle(r).display !== 'none' : null; })(),
    // html::after is the free slot and the app layout now uses it for
    // the band that covers the cutout once the bar has gone. What the
    // rule actually forbids is something painted OVER the page, so what
    // is read is the box rather than whether the slot is taken: it has
    // to be a strip pinned to the top edge, no taller than the safe
    // area it fills (nothing on this device), and untouchable.
    grain: (() => {
      const a = getComputedStyle(document.documentElement, '::after');
      if (a.content === 'none') return 'none';
      const h = parseFloat(a.height) || 0;
      return a.position === 'fixed' && a.top === '0px' && h <= 2 && a.pointerEvents === 'none'
        ? 'ok' : [a.position, a.top, a.height, a.pointerEvents].join(' ');
    })(),
    checked: (() => { const i = document.getElementById('set-app-layout'); return i ? i.checked : null; })()
  };
});

(async () => {
  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await new Promise(res => setTimeout(res, 1200));
  }
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});

  // ---- a phone browser, first visit ----
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await stub(p);
  await p.goto(BASE + '/');
  await p.waitForTimeout(700);
  const first = await layout(p);
  check('a phone browser gets the app layout with nothing stored',
    first.pwa && !first.installed && first.tabBar === 'grid', JSON.stringify(first));
  check('nothing is painted over the page',
    first.grain === 'none' || first.grain === 'ok',
    JSON.stringify(first.grain));
  check('the switch is in the settings menu, on', first.rowShown === true && first.checked === true, JSON.stringify({ shown: first.rowShown, on: first.checked }));

  // the class is set before the page paints, so there is no flash
  const early = await p.evaluate(() => window.__earlyPwa);
  await p.addInitScript(() => {
    document.addEventListener('readystatechange', () => {
      if (document.readyState === 'interactive' && window.__earlyPwa === undefined) {
        window.__earlyPwa = document.documentElement.classList.contains('is-pwa');
      }
    });
  });
  await p.reload();
  await p.waitForTimeout(600);
  check('the layout is decided before the page is parsed, so it cannot flash',
    (await p.evaluate(() => window.__earlyPwa)) === true, JSON.stringify(early));

  // ---- turning it off ----
  await p.evaluate(() => {
    document.querySelector('.settings-toggle').click();
  });
  await p.waitForTimeout(400);
  await p.evaluate(() => document.getElementById('set-app-layout').click());
  await p.waitForTimeout(500);
  const off = await layout(p);
  check('turning it off puts the ordinary site chrome back at once, no reload',
    !off.pwa && off.tabBar === 'none', JSON.stringify(off));
  check('and the ordinary chrome measures itself again',
    off.navH !== '' && parseFloat(off.navH) > 20, JSON.stringify(off.navH));
  check('the choice is written down', (await p.evaluate(() => localStorage.getItem('scs2-app-layout'))) === '0', '');

  // it sticks across a reload, and across pages
  await p.reload();
  await p.waitForTimeout(600);
  const stuck = await layout(p);
  check('it stays off on the next load', !stuck.pwa && stuck.checked === false, JSON.stringify(stuck));
  await p.goto(BASE + '/info/');
  await p.waitForTimeout(600);
  check('and on every other page', !(await layout(p)).pwa, '');

  // back on again
  await p.evaluate(() => document.querySelector('.settings-toggle').click());
  await p.waitForTimeout(400);
  await p.evaluate(() => document.getElementById('set-app-layout').click());
  await p.waitForTimeout(500);
  const backOn = await layout(p);
  check('turning it back on restores the app layout', backOn.pwa && backOn.tabBar === 'grid', JSON.stringify(backOn));

  // ---- the viewer's details sheet slides down by its pull tab ----
  // (scs.pullTab: a guard on the page's touches that swallowed this
  // drag would leave the sheet with no way shut for a finger)
  const pulled = await p.evaluate(async () => {
    const wait = (ms) => new Promise(res => setTimeout(res, ms));
    if (!document.getElementById('site-settings').classList.contains('is-hidden')) document.querySelector('.settings-toggle').click();
    await wait(300);
    const pic = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="#7a9"/></svg>');
    window.scs.lightbox([{ url: pic, type: 'image/svg+xml', name: 'made up' }], 0, null,
      { info: () => Promise.resolve([{ title: 'Made-up camera', lines: [] }]) });
    await wait(400);
    document.querySelector('.lb-info-btn').click();
    await wait(500);
    const tab = document.querySelector('.lb-info-tab');
    const r = tab.getBoundingClientRect();
    const x = r.left + r.width / 2;
    let y = r.top + r.height / 2;
    const send = (type, cy) => {
      const t = new Touch({ identifier: 3, target: tab, clientX: x, clientY: cy });
      tab.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true,
        touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t] }));
    };
    const cross = getComputedStyle(document.querySelector('.lb-info-close')).display;
    send('touchstart', y);
    let pointedDown = false;
    for (let i = 0; i < 10; i++) {
      y += 30;
      send('touchmove', y);
      await wait(30);
      pointedDown = pointedDown || tab.classList.contains('is-vee');
    }
    send('touchend', y);
    await wait(700);
    return { cross, pointedDown, open: document.querySelector('.lb-overlay').classList.contains('has-info') };
  });
  check('on a phone the viewer\'s details sheet has a pull tab rather than a cross, and slides shut by it, the tab folding the way it goes',
    pulled.cross === 'none' && pulled.pointedDown && !pulled.open, JSON.stringify(pulled));

  // ---- a zoomed photo pans on a rubber band and keeps its momentum ----
  // through real touches, since a guard on the page's touches elsewhere
  // could swallow them
  {
    await p.evaluate(() => { const o = document.querySelector('.lb-overlay'); if (o) o.remove(); });
    await p.evaluate(() => {
      const pic = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><rect width="1200" height="1600" fill="#7ab"/></svg>');
      window.scs.lightbox([{ url: pic, type: 'image/svg+xml', name: 'made up' }], 0, null, {});
    });
    await p.waitForTimeout(600);
    const cdp = await ctx.newCDPSession(p);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q, i) => ({ x: q[0], y: q[1], id: i })) });
    const at = () => p.evaluate(() => {
      const r = document.querySelector('.lb-overlay img.lb-media').getBoundingClientRect();
      return { left: Math.round(r.left), top: Math.round(r.top) };
    });
    for (let i = 0; i < 2; i++) { await touch('touchStart', [[195, 422]]); await touch('touchEnd', []); await p.waitForTimeout(120); }
    await p.waitForTimeout(400);
    await touch('touchStart', [[100, 422]]);
    for (let i = 1; i <= 14; i++) { await touch('touchMove', [[100 + 20 * i, 422]]); await p.waitForTimeout(16); }
    const banded = await at();
    await p.waitForTimeout(250);
    await touch('touchEnd', []);
    await p.waitForTimeout(900);
    const sprung = await at();
    await touch('touchStart', [[200, 600]]);
    for (let i = 1; i <= 4; i++) { await touch('touchMove', [[200, 600 - 30 * i]]); await p.waitForTimeout(10); }
    await touch('touchEnd', []);
    const let_go = await at();
    await p.waitForTimeout(150);
    const carried = await at();
    check('a zoomed photo dragged past its edge gives on a rubber band and springs back to it, and a flick carries on after the finger lifts',
      banded.left > 4 && sprung.left === 0 && carried.top < let_go.top - 10, JSON.stringify({ banded, sprung, let_go, carried }));

    // A touch iOS takes for the home bar sends no pointercancel. Counted
    // for good, it made every later tap half a pinch, and on the black
    // screen nothing could close the viewer short of a force-quit.
    await p.evaluate(() => { const o = document.querySelector('.lb-overlay'); if (o) o.remove(); });
    await p.evaluate(() => {
      const pic = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="1600"><rect width="1200" height="1600" fill="#7ab"/></svg>');
      window.scs.lightbox([{ url: pic, type: 'image/svg+xml', name: 'made up' }], 0, null, {});
    });
    await p.waitForTimeout(600);
    const shown = () => p.evaluate(() => {
      const o = document.querySelector('.lb-overlay:not(.is-leaving)');
      return { open: !!o, black: !!(o && o.classList.contains('is-immersive')) };
    });
    await touch('touchStart', [[195, 422]]); await touch('touchEnd', []);
    await p.waitForTimeout(600);
    const black = await shown();
    await p.evaluate(() => {
      document.querySelector('.lb-overlay img.lb-media').dispatchEvent(new PointerEvent('pointerdown',
        { pointerId: 991, pointerType: 'touch', isPrimary: true, clientX: 195, clientY: 800, bubbles: true }));
    });
    await touch('touchStart', [[195, 422]]); await touch('touchEnd', []);
    await p.waitForTimeout(600);
    const tapped = await shown();
    await touch('touchStart', [[195, 300]]);
    for (let i = 1; i <= 10; i++) { await touch('touchMove', [[195, 300 + 30 * i]]); await p.waitForTimeout(16); }
    await touch('touchEnd', []);
    await p.waitForTimeout(600);
    const swiped = await shown();
    check('a touch whose end never came is forgotten at the next one: a tap still leaves the black screen and a swipe still closes the photo',
      black.black && tapped.open && !tapped.black && !swiped.open, JSON.stringify({ black, tapped, swiped }));
  }
  await ctx.close();

  // ---- the installed app ignores the switch ----
  const ctx2 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p2 = await ctx2.newPage();
  await stub(p2);
  await p2.addInitScript(() => {
    Object.defineProperty(navigator, 'standalone', { get: () => true });
    try { localStorage.setItem('scs2-app-layout', '0'); } catch (e) {}
  });
  await p2.goto(BASE + '/');
  await p2.waitForTimeout(700);
  const app = await layout(p2);
  check('the installed app keeps the app layout even with the switch off',
    app.pwa && app.installed && app.tabBar === 'grid', JSON.stringify(app));
  check('and does not offer the switch at all', app.rowShown === false, JSON.stringify(app.rowShown));
  // wider than a phone (a tablet on its side) the installed app is the
  // desktop page, with the page's name clear of the bar
  await p2.setViewportSize({ width: 1180, height: 820 });
  await p2.goto(BASE + '/info/');
  await p2.waitForTimeout(700);
  const wide = await p2.evaluate(() => {
    const nav = document.querySelector('.site-nav').getBoundingClientRect();
    const h1 = document.querySelector('main h1');
    return { pwa: document.documentElement.classList.contains('is-pwa'),
      installed: document.documentElement.classList.contains('is-installed'),
      menu: getComputedStyle(document.querySelector('.site-menu')).display,
      tabBar: document.querySelector('.tab-bar') ? getComputedStyle(document.querySelector('.tab-bar')).display : null,
      navBottom: Math.round(nav.bottom), h1Top: h1 ? Math.round(h1.getBoundingClientRect().top) : null };
  });
  check('an installed app wider than 840px gets the desktop page, its name clear of the bar',
    !wide.pwa && wide.installed && wide.menu !== 'none' && wide.tabBar === 'none' && wide.h1Top >= wide.navBottom, JSON.stringify(wide));
  await ctx2.close();

  // ---- a desktop window ----
  const ctx3 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const p3 = await ctx3.newPage();
  await stub(p3);
  await p3.goto(BASE + '/');
  await p3.waitForTimeout(600);
  const desk = await layout(p3);
  check('a desktop window is untouched by any of this',
    !desk.pwa && desk.tabBar === 'none' && desk.rowShown === false && desk.grain === 'none', JSON.stringify(desk));
  // Dragging a desktop window narrow is not a phone. It used to hand
  // over to the app layout, which locked page zoom, swapped in the app
  // chrome and offered to install the app on a machine that cannot.
  await p3.setViewportSize({ width: 390, height: 844 });
  await p3.waitForTimeout(600);
  const squeezed = await layout(p3);
  check('narrowing a desktop window stays a desktop window',
    squeezed.pwa === false && squeezed.tabBar === 'none' && squeezed.rowShown === false,
    JSON.stringify(squeezed));
  const vp = await p3.evaluate(() => document.querySelector('meta[name="viewport"]').getAttribute('content'));
  check('and it keeps page zoom, rather than being locked like a phone',
    vp.indexOf('user-scalable=no') === -1, vp);
  check('and is never offered the app to install',
    (await p3.evaluate(() => !!document.querySelector('.install-nudge'))) === false, '');
  await p3.setViewportSize({ width: 1280, height: 900 });
  await p3.waitForTimeout(500);
  check('widening changes nothing either', (await layout(p3)).pwa === false, '');
  await ctx3.close();

  // ---- what tells a phone from a small window ----
  // The device is asked what it points with, not how wide it is: a
  // handheld's primary pointer is coarse and has nothing to hover with,
  // which a desktop answers honestly however narrow its window is.
  const ctx4 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } }); // no touch: a small desktop window
  const p4 = await ctx4.newPage();
  await stub(p4);
  await p4.goto(BASE + '/');
  await p4.waitForTimeout(700);
  const mouseAt390 = await p4.evaluate(() => ({
    pwa: document.documentElement.classList.contains('is-pwa'),
    coarse: matchMedia('(pointer: coarse)').matches,
    hoverless: matchMedia('(hover: none)').matches,
    narrow: matchMedia('(max-width: 840px)').matches,
    rowShown: (() => { const r = document.querySelector('.settings-app-row'); return r ? getComputedStyle(r).display !== 'none' : null; })()
  }));
  check('a phone-width window with a mouse gets the ordinary site',
    mouseAt390.narrow && !mouseAt390.coarse && !mouseAt390.hoverless &&
    !mouseAt390.pwa && mouseAt390.rowShown === false,
    JSON.stringify(mouseAt390));
  await ctx4.close();

  const ctx5 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p5 = await ctx5.newPage();
  await stub(p5);
  await p5.goto(BASE + '/');
  await p5.waitForTimeout(700);
  const fingerAt390 = await p5.evaluate(() => ({
    pwa: document.documentElement.classList.contains('is-pwa'),
    coarse: matchMedia('(pointer: coarse)').matches,
    hoverless: matchMedia('(hover: none)').matches
  }));
  check('the same width with a finger gets the app layout',
    (fingerAt390.coarse || fingerAt390.hoverless) && fingerAt390.pwa,
    JSON.stringify(fingerAt390));
  await ctx5.close();

  // ---------------- what the bar carries in each layout ----------------
  // On the web the bar is the brand and the page draws its own name; in
  // the app layout the bar IS the page's name and the page does not
  // draw it a second time. Home is the exception at both ends.
  const barProbe = () => {
    const vis = el => { if (!el) return false; const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'; };
    const q = s => document.querySelector(s);
    const burger = q('.site-nav-toggle');
    return {
      pwa: document.documentElement.classList.contains('is-pwa'),
      badge: vis(q('.site-brand-badge')),
      brandName: vis(q('.site-brand-name')),
      pageName: vis(q('.site-brand-page')),
      pageText: q('.site-brand-page') ? q('.site-brand-page').textContent.trim() : null,
      h1: vis(q('main h1')),
      burgerShown: vis(burger),
      burgerWidth: burger ? Math.round(burger.getBoundingClientRect().width) : null,
      burgerLabel: burger ? burger.getAttribute('aria-label') : null,
      burgerText: burger ? burger.textContent.trim() : null,
      burgerBorder: burger ? getComputedStyle(burger).borderTopColor : null,
      xs: ['.site-nav-toggle', '.bell-toggle', '.settings-toggle']
        .map(s => q(s) ? Math.round(q(s).getBoundingClientRect().x) : null),
      sideways: document.body.scrollWidth > window.innerWidth + 1
    };
  };

  // mobile web, app layout off: the brand stays, and the burger is the
  // first of the three icons at the right end rather than a pill with
  // the word Menu in it
  const ctx6 = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx6.addInitScript(() => { try {
    localStorage.setItem('scs2-app-layout', '0');
    sessionStorage.setItem('scs2-install-nudged', '1');
  } catch (e) {} });
  const p6 = await ctx6.newPage();
  await stub(p6);
  await p6.goto(BASE + '/info/');
  await p6.waitForTimeout(700);
  const web = await p6.evaluate(barProbe);
  const folds = await p6.evaluate(() => {
    document.querySelector('.site-nav-toggle').click();
    return new Promise(res => setTimeout(() => res({
      expanded: document.querySelector('.site-nav-toggle').getAttribute('aria-expanded'),
      open: document.querySelector('.site-menu').classList.contains('is-open'),
      turned: getComputedStyle(document.querySelector('.nav-burger span')).transform
    }), 420));
  });
  check('tapping it still opens the menu and folds the bars into a cross',
    folds.expanded === 'true' && folds.open && folds.turned !== 'none', JSON.stringify(folds));
  await ctx6.close();

  // app layout: the page's name is in the bar and nowhere else
  const ctx7 = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx7.addInitScript(() => { try {
    Object.defineProperty(navigator, 'standalone', { get: function () { return true; } });
    sessionStorage.setItem('scs2-launched', '1');
    sessionStorage.setItem('scs2-install-nudged', '1');
  } catch (e) {} });
  const p7 = await ctx7.newPage();
  await stub(p7);
  const pages = [['/info/', 'Event Info'], ['/welfare/', 'Welfare & Safety'], ['/tab/', 'Tab'],
                 ['/submit/', 'Submit a Quest'], ['/questlist/', 'Quest List'], ['/gallery/', 'Gallery'],
                 ['/rego/', 'Register'],
                 ['/recap/', 'SCS.2 in Numbers'], ['/tab/team/', 'Team'], ['/questlist/full/', 'Full Quest List']];
  const wrong = [];
  for (let i = 0; i < pages.length; i++) {
    await p7.goto(BASE + pages[i][0]);
    await p7.waitForTimeout(600);
    const d = await p7.evaluate(barProbe);
    if (!(d.pwa && d.pageName && !d.badge && !d.brandName && d.pageText === pages[i][1] && !d.h1 && !d.sideways)) {
      wrong.push(pages[i][0] + ' ' + JSON.stringify(d));
    }
  }
  check('every page puts its name in the app bar and draws it nowhere else',
    wrong.length === 0, wrong.slice(0, 2).join(' , '));
  await p7.goto(BASE + '/');
  await p7.waitForTimeout(600);
  const home = await p7.evaluate(barProbe);
  check('except home, which keeps the brand in the bar and its board under it',
    home.pwa && home.badge && !home.pageName && home.h1, JSON.stringify(home));
  await ctx7.close();

  // ---- a page that is slow to come ----
  // The loading bar: nothing inside 250ms, the bar after that, and
  // nothing at all for a tap that goes nowhere (the tab you are on
  // scrolls to the top). The old page writes down what it showed in
  // sessionStorage, which outlives it: a page whose navigation is under
  // way cannot be read from here.
  const ctx8 = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, serviceWorkers: 'block' });
  await ctx8.addInitScript(() => {
    try { sessionStorage.setItem('scs2-install-nudged', '1'); } catch (e) {}
    document.addEventListener('click', function () {
      var t0 = Date.now();
      var seen = [];
      var iv = setInterval(function () {
        var bar = document.querySelector('.ptr-bar');
        seen.push([Date.now() - t0, !!(bar && bar.classList.contains('is-going'))]);
        try { sessionStorage.setItem('lb-seen', JSON.stringify(seen)); } catch (e) {}
        if (seen.length >= 12) clearInterval(iv);
      }, 50);
    }, true);
  });
  const p8 = await ctx8.newPage();
  await stub(p8);
  await p8.route(u => u.pathname === '/info/', async r => { await new Promise(res => setTimeout(res, 1200)); await r.continue(); });
  await p8.goto(BASE + '/');
  await p8.waitForTimeout(600);
  await p8.click('.tab-bar > a.is-active');
  await p8.waitForTimeout(700);
  const stay = await p8.evaluate(() => JSON.parse(sessionStorage.getItem('lb-seen') || '[]'));
  await p8.click('.tab-bar > a.tab-info', { noWaitAfter: true });
  await p8.waitForURL('**/info/', { timeout: 8000 });
  const went = await p8.evaluate(() => JSON.parse(sessionStorage.getItem('lb-seen') || '[]'));
  const onAt = went.filter(x => x[1]).map(x => x[0]);
  check('a page slow to come shows the loading bar from 250ms and not before, and the tab you are on shows none',
    stay.length > 0 && !stay.some(x => x[1]) && onAt.length > 0 && onAt[0] >= 240 && onAt[0] <= 450,
    JSON.stringify({ stayOn: stay.filter(x => x[1]).length, firstOn: onAt[0] }));
  await ctx8.close();

  console.log('errors', errors);
  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  await b.close();
  if (server) server.kill();
  process.exit(fail ? 1 : 0);
})();
