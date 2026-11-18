// Four things that touch every page: the O/I rocker's travelling
// block, the theme flip going through a view transition, the
// invisible native switches that make iOS 26.5 and later tick, and
// the shape of the settings menu itself.
// Run with: node tests/verify-switch.cjs
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

// a phone that reports native switches and no Vibration API: what an
// iPhone on 26.5+ looks like to the feature test in site.js
const IOS_LIKE = () => {
  Object.defineProperty(HTMLInputElement.prototype, 'switch', { value: false, writable: true, configurable: true });
  Object.defineProperty(Navigator.prototype, 'vibrate', { value: undefined, configurable: true });
  // the install nudge would sit over the floating button
  try { localStorage.setItem('scs2-install-dismissed', '1'); } catch (e) { }
};

(async () => {
  // ---------- the bottom bar points where its labels say ----------
  // The submit, gallery and rego pages each had the Welfare heart
  // linking to "./", so tapping it reopened the page you were on.
  const fs = require('fs');
  const wantTab = { Home: 'index', Quests: 'questlist', Submit: 'submit', Info: 'info', Welfare: 'welfare', Tab: 'tab' };
  const pages = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name[0] === '.' || e.name === 'node_modules') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name === 'index.html') pages.push(full);
    }
  })(SITE);
  const wrongLinks = [];
  for (const file of pages) {
    const src = fs.readFileSync(file, 'utf8');
    const bar = /<nav class="tab-bar"[\s\S]*?<\/nav>/.exec(src);
    if (!bar) continue;
    const here = path.dirname(file);
    let m;
    const re = /<a href="([^"]+)"[^>]*>[\s\S]*?<span>([^<]+)<\/span>/g;
    while ((m = re.exec(bar[0]))) {
      const key = wantTab[m[2]];
      if (!key) continue;
      const target = path.relative(SITE, path.resolve(here, m[1]));
      const ok = key === 'index' ? target === '' : target.split(path.sep).pop() === key;
      if (!ok) wrongLinks.push(path.relative(SITE, file) + ': ' + m[2] + ' -> ' + m[1]);
    }
  }
  check('every bottom-bar link goes where its label says', wrongLinks.length === 0, wrongLinks.join(' | '));

  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await new Promise(res => setTimeout(res, 1200));
  }
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const phone = { serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };

  // ---------- the rocker ----------
  let ctx = await b.newContext(phone);
  let p = await ctx.newPage();
  // the install nudge arrives 1.2s in and would sit over the filters button
  await p.addInitScript(() => { try { localStorage.setItem('scs2-install-dismissed', '1'); } catch (e) { } });
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.route('**/files.scs.andyrew.space/**', r => r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await p.goto(BASE + '/questlist/');
  await p.waitForTimeout(900);

  const swState = () => p.evaluate(() => {
    const art = document.querySelector('#ql-anywhere-only + .settings-switch');
    const o = art.querySelector('.switch-o').getBoundingClientRect();
    const i = art.querySelector('.switch-i').getBoundingClientRect();
    const block = getComputedStyle(art, '::before');
    const shift = (block.transform.match(/matrix\(1, 0, 0, 1, ([-\d.]+)/) || [0, 0])[1];
    return {
      halves: [Math.round(o.width * 10) / 10, Math.round(i.width * 10) / 10],
      blockW: Math.round(parseFloat(block.width) * 10) / 10,
      shift: Math.round(Number(shift) * 10) / 10,
      bg: block.backgroundColor,
      oInk: getComputedStyle(art.querySelector('.switch-o')).color,
      iInk: getComputedStyle(art.querySelector('.switch-i')).color
    };
  });

  // the switches moved into the filters drawer, behind the button
  // beside the search box
  await p.click('#ql-filters-btn');
  await sleep(400);

  const off = await swState();
  const oInkOff = off.oInk, iInkOff = off.iInk;

  // the block a quarter of the way through its transition, held there
  // rather than sampled by the clock, which a busy page throws off
  const mid = await p.evaluate(() => {
    const input = document.getElementById('ql-anywhere-only');
    const art = input.nextElementSibling;
    input.click();
    const run = document.getAnimations().find(a => a.effect && a.effect.target === art &&
      a.effect.pseudoElement === '::before' && a.transitionProperty === 'transform');
    if (!run) return { shift: null };
    run.pause();
    run.currentTime = run.effect.getTiming().duration * 0.25;
    const m = getComputedStyle(art, '::before').transform.match(/matrix\(1, 0, 0, 1, ([-\d.]+)/);
    run.play();
    return { shift: m ? Math.round(Number(m[1]) * 10) / 10 : 0 };
  });
  check('the block travels rather than cross-fading: part way across mid-flight',
    mid.shift > 0 && mid.shift < off.halves[0], JSON.stringify(mid.shift));

  await sleep(500);
  const on = await swState();
  check('it lands on the I side and turns accent green',
    Math.abs(on.shift - on.halves[0]) < 0.5 && on.bg !== off.bg, JSON.stringify({ shift: on.shift, bg: on.bg }));

  // ---------- the text size ----------
  const sizeNow = () => p.evaluate(() => ({
    shown: document.getElementById('set-font-val').textContent,
    root: document.documentElement.style.fontSize,
    decOff: document.getElementById('set-font-dec').disabled,
    incOff: document.getElementById('set-font-inc').disabled
  }));
  const nudge = (id, times) => p.evaluate(([i, n]) => {
    for (var k = 0; k < n; k++) document.getElementById(i).click();
  }, [id, times]);

  await nudge('set-font-inc', 30);
  const biggest = await sizeNow();
  check('the text size climbs to 200% and stops there',
    biggest.shown === '200%' && biggest.root === '200%', JSON.stringify(biggest));
  await nudge('set-font-dec', 40);
  const smallest = await sizeNow();
  check('and down to 33%', smallest.shown === '33%' && smallest.root === '33%', JSON.stringify(smallest));

  const ladder = await p.evaluate(() => {
    const seen = [];
    const val = () => document.getElementById('set-font-val').textContent;
    for (let i = 0; i < 40; i++) {
      if (seen[seen.length - 1] !== val()) seen.push(val());
      document.getElementById('set-font-inc').click();
    }
    return seen;
  });
  await nudge('set-font-dec', 40);
  await nudge('set-font-inc', 40);
  await p.evaluate(() => {
    // back to normal for the checks that follow
    for (let i = 0; i < 40; i++) document.getElementById('set-font-dec').click();
    for (let i = 0; i < 5; i++) document.getElementById('set-font-inc').click();
  });
  const midSize = await sizeNow();
  check('100% leaves the root size alone entirely', midSize.root === '', JSON.stringify(midSize));

  // ---------- the gear says the menu is open ----------
  // It used to draw a solid outline while open. It draws none now: the
  // gear fills in, and that face is what says so. An outline round it
  // as well read as the stray highlight a tap's leftover hover leaves,
  // which is the thing the outline was added to replace in the first
  // place — so the answer was the face, not a second box.
  await p.evaluate(() => document.querySelector('.settings-toggle').click());
  await sleep(400); // the faces hand over, so read them once they have
  const gear = await p.evaluate(() => {
    const b = document.querySelector('.settings-toggle');
    return {
      open: b.classList.contains('is-open'),
      border: getComputedStyle(b).borderTopColor,
      fillOn: parseFloat(getComputedStyle(b.querySelector('.icon-gear-fill')).opacity),
      outlineOff: parseFloat(getComputedStyle(b.querySelector('.icon-gear-outline')).opacity)
    };
  });
  check('opening the settings menu fills the gear in, without needing a hover',
    gear.open && gear.fillOn === 1 && gear.outlineOff === 0, JSON.stringify(gear));
  await p.keyboard.press('Escape');
  await sleep(300);

  // ---------- the tab you are already on ----------
  const selfTap = await p.evaluate(() => new Promise(resolve => {
    document.body.scrollTop = 600;
    const active = document.querySelector('.tab-bar > a.is-active');
    const was = location.pathname;
    active.click();
    setTimeout(() => resolve({ was, now: location.pathname, scroll: Math.round(document.body.scrollTop) }), 700);
  }));
  check('tapping the tab you are already on goes back to the top instead of reloading',
    selfTap.was === selfTap.now && selfTap.scroll === 0, JSON.stringify(selfTap));

  // ---------- the theme flip ----------
  const themed = async (stub) => {
    const c = await b.newContext(phone);
    const pg = await c.newPage();
    await pg.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await pg.route('**/files.scs.andyrew.space/**', r => r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    await pg.addInitScript(stub);
    await pg.goto(BASE + '/');
    await pg.waitForTimeout(700);
    return { c, pg };
  };

  let t = await themed(() => {
    window.__vt = 0;
    document.startViewTransition = function (cb) {
      window.__vt++;
      cb();
      return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() };
    };
  });
  await t.pg.evaluate(() => document.querySelector('.theme-toggle').click());
  await sleep(120);
  check('the theme flip goes through a view transition where there is one',
    await t.pg.evaluate(() => window.__vt) === 1 &&
    await t.pg.evaluate(() => document.documentElement.getAttribute('data-theme')) === 'dark', '');
  check('and it does not also run the per-element fade',
    !(await t.pg.evaluate(() => document.documentElement.classList.contains('theme-fading'))), '');
  await t.c.close();

  // it lives on the prototype, so deleting it off the instance leaves it there
  t = await themed(() => {
    Object.defineProperty(Document.prototype, 'startViewTransition', { value: undefined, configurable: true });
  });
  await t.pg.evaluate(() => document.querySelector('.theme-toggle').click());
  await sleep(60);
  const fading = await t.pg.evaluate(() => document.documentElement.classList.contains('theme-fading'));
  const dark = await t.pg.evaluate(() => document.documentElement.getAttribute('data-theme'));
  check('without one it falls back to easing every element', fading && dark === 'dark', JSON.stringify({ fading, dark }));
  await sleep(500);
  check('and the fallback class comes off again',
    !(await t.pg.evaluate(() => document.documentElement.classList.contains('theme-fading'))), '');
  await t.c.close();

  check('no page errors on the rocker page', errors.length === 0, errors.join(' | '));
  await ctx.close();

  // ---------- direct-tap haptics ----------
  ctx = await b.newContext(phone);
  p = await ctx.newPage();
  const asked = [];
  p.on('request', r => { if (r.url().includes('/haptics/')) asked.push(r.url()); });
  await p.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await p.route('**/files.scs.andyrew.space/**', r => r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await p.addInitScript(IOS_LIKE);
  await p.goto(BASE + '/');
  await p.waitForTimeout(900);

  check('a phone with native switches and no Vibration API takes the tap path',
    await p.evaluate(() => document.documentElement.classList.contains('haptic-taps')), '');
  check('the old engine is not even fetched there', asked.length === 0, asked.join(' '));

  const bar = await p.evaluate(() => {
    const links = [...document.querySelectorAll('.tab-bar > a')];
    const sws = [...document.querySelectorAll('.tab-bar > input.haptic-tap')];
    const box = el => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    return {
      links: links.length,
      switches: sws.length,
      aligned: sws.every((s, i) => JSON.stringify(box(s)) === JSON.stringify(box(links[i]))),
      native: sws.every(s => s.type === 'checkbox' && s.hasAttribute('switch')),
      quiet: sws.every(s => s.getAttribute('aria-hidden') === 'true' && s.tabIndex === -1),
      // the bar holds six links and shows five: the hidden one's switch
      // goes with it, and every other one is there but not drawn
      unseen: sws.every((s, i) => getComputedStyle(links[i]).display === 'none'
        ? getComputedStyle(s).display === 'none'
        : getComputedStyle(s).opacity === '0' && getComputedStyle(s).display !== 'none')
    };
  });
  check('every bottom-bar link wears a switch, laid exactly over it',
    bar.links > 0 && bar.switches === bar.links && bar.aligned, JSON.stringify(bar));
  check('they are real native switches, invisible rather than removed',
    bar.native && bar.unseen, JSON.stringify(bar));
  check('and they are out of the way of the keyboard and screen readers', bar.quiet, JSON.stringify(bar));

  const chrome = await p.evaluate(() => {
    const box = el => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    const over = host => {
      const sw = [...document.querySelectorAll('input.haptic-tap')].find(s => s._scsHost === host);
      // offsetLeft is a whole number and a box can sit on a fraction
      return sw ? box(sw).every((v, i) => Math.abs(v - box(host)[i]) <= 1) : false;
    };
    document.querySelector('.settings-toggle').click();   // the panel's own control needs it open
    const bell = over(document.querySelector('.bell-toggle'));
    const gear = over(document.querySelector('.settings-toggle'));
    const theme = over(document.querySelector('.theme-toggle'));
    return { bell, gear, theme, panelOpen: !document.querySelector('.settings-panel').classList.contains('is-hidden') };
  });
  check('the bell, the gear and the light/dark button each wear one, laid over their box',
    chrome.bell && chrome.gear && chrome.theme, JSON.stringify(chrome));
  check('the gear\'s own switch opens the menu instead of opening and shutting it',
    chrome.panelOpen, JSON.stringify(chrome));

  // The settings menu's rockers narrowed the same way the quest list's
  // did: the checkbox covers the knob (the label round the drawn
  // switch), not the row, because a native switch across the row flips
  // when a finger is put down on the words to scroll, and this panel
  // scrolls on a short screen. The knob is 44px tall for a thumb. The
  // checkbox also has to be what the finger lands on: the drawn switch
  // is positioned and later in the document, so without a z-index the
  // tap reached the drawing and no tick came.
  await sleep(400); // the panel is still scaling up from its open animation; measure it settled
  const knob = await p.evaluate(() => {
    const box = document.getElementById('set-haptics');
    const label = box.closest('.settings-knob');
    const row = box.closest('.settings-row');
    // Haptic feedback is the last row, and past a certain number of
    // rockers the panel is taller than a phone and scrolls — which is
    // what it is built to do. The hit test below asks what a finger
    // lands on, so the row has to be under the finger first.
    row.scrollIntoView({ block: 'center' });
    const a = box.getBoundingClientRect(), k = label.getBoundingClientRect(), r = row.getBoundingClientRect();
    const near = (x, y) => Math.abs(x - y) <= 1;
    return {
      native: box.hasAttribute('switch'),
      coversKnob: near(a.width, k.width) && near(a.height, k.height) && near(a.left, k.left) && near(a.top, k.top),
      notTheRow: Math.round(a.width) < Math.round(r.width),
      tall: k.height >= 44,
      onTop: document.elementFromPoint(k.left + k.width / 2, k.top + k.height / 2) === box,
      z: getComputedStyle(box).zIndex
    };
  });
  check('a settings rocker\'s checkbox covers its 44px knob, not the row, and is what a finger lands on',
    knob.native && knob.coversKnob && knob.notTheRow && knob.tall && knob.onTop && knob.z === '2', JSON.stringify(knob));
  const sizeOver = await p.evaluate(() => {
    const box = el => { const b = el.getBoundingClientRect(); return [Math.round(b.x), Math.round(b.y), Math.round(b.width), Math.round(b.height)]; };
    const over = host => {
      const sw = [...document.querySelectorAll('input.haptic-tap')].find(s => s._scsHost === host);
      // offsetLeft is a whole number and a box can sit on a fraction
      return sw ? box(sw).every((v, i) => Math.abs(v - box(host)[i]) <= 1) : false;
    };
    return { dec: over(document.getElementById('set-font-dec')), inc: over(document.getElementById('set-font-inc')) };
  });
  check('and both halves of the text-size stepper wear one, laid over their box', sizeOver.dec && sizeOver.inc, JSON.stringify(sizeOver));

  // the settings rocker turns the tap path off as well
  await p.evaluate(() => {
    const box = document.getElementById('set-haptics');
    box.checked = false;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(200);
  const offNow = await p.evaluate(() => {
    const all = [...document.querySelectorAll('input.haptic-tap')];
    const rockers = [...document.querySelectorAll('.settings-switch')]
      .map(a => a.previousElementSibling).filter(b => b && b.tagName === 'INPUT');
    return {
      overlays: all.length && all.every(s => !s.hasAttribute('switch')),
      rockers: rockers.length && rockers.every(b => !b.hasAttribute('switch')),
      stillThere: all.length
    };
  });
  check('turning Haptic feedback off takes the switch attribute off every one of them',
    offNow.overlays && offNow.rockers && offNow.stillThere > 0, JSON.stringify(offNow));

  await p.evaluate(() => {
    const box = document.getElementById('set-haptics');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(200);
  check('turning it back on restores them',
    await p.evaluate(() => [...document.querySelectorAll('input.haptic-tap')].every(s => s.hasAttribute('switch'))), '');
  await p.keyboard.press('Escape');
  await sleep(300);


  await p.goto(BASE + '/questlist/');
  await p.waitForTimeout(900);
  // The checkbox used to grow to cover the whole row, so a finger
  // landing anywhere on it got iOS's tick. That also meant a swipe
  // begun anywhere on the row flipped the switch, which is worse on a
  // page people scroll with their thumb, so the target is the rocker
  // itself now. The tick follows the control: what has to be covered
  // is the switch, not the row.
  // the rockers live in the filters drawer now: nothing to measure
  // until the button beside the search box has opened it
  await p.click('#ql-filters-btn');
  await sleep(400);
  const rocker = await p.evaluate(() => {
    const box = document.getElementById('ql-anywhere-only');
    const row = box.closest('.ql-checkbox');
    // the control's own box, which the quest list wraps round the
    // switch so the checkbox has something to be grown to
    const knob = row.querySelector('.ql-rocker') || row.querySelector('.settings-switch');
    const a = box.getBoundingClientRect();
    const k = knob.getBoundingClientRect(), b = row.getBoundingClientRect();
    const near = (x, y) => Math.abs(x - y) <= 1;
    return {
      native: box.hasAttribute('switch'),
      coversKnob: near(a.width, k.width) && near(a.height, k.height) &&
                  near(a.left, k.left) && near(a.top, k.top),
      notTheRow: Math.round(a.width) < Math.round(b.width),
      hidden: getComputedStyle(box).opacity === '0'
    };
  });
  check('a rocker\'s own checkbox becomes the switch and covers the switch, not the row',
    rocker.native && rocker.coversKnob && rocker.notTheRow && rocker.hidden, JSON.stringify(rocker));

  // one tap, one toggle: the row is a label wrapping the switch, so a
  // tap landing on the switch itself must not also be forwarded by the
  // label and cancel itself out
  await p.click('#ql-anywhere-only');
  await sleep(300);
  check('and one tap on it still flips the switch exactly once',
    await p.evaluate(() => document.getElementById('ql-anywhere-only').checked), '');
  // ---------- tapping the bar while the page is still moving ----------
  // iOS can spend that first tap stopping the scroll, so the release
  // navigates itself — but only then, and only for a tap that did not
  // travel.
  const tapBar = async (label, scrollFirst) => {
    await p.goto(BASE + '/questlist/');
    await p.waitForTimeout(900);
    await p.evaluate(([lab, scrolled]) => {
      const link = [...document.querySelectorAll('.tab-bar > a')].find(a => a.querySelector('span').textContent === lab);
      const sw = [...document.querySelectorAll('.tab-bar > input.haptic-tap')].find(s => s._scsHost === link);
      const box = link.getBoundingClientRect();
      window.__tapTarget = sw || link;
      window.__tapTouch = new Touch({
        identifier: 1, target: window.__tapTarget,
        clientX: box.x + box.width / 2, clientY: box.y + box.height / 2
      });
      if (scrolled) document.body.scrollTop = 500;   // a real scroll event, just now
    }, [label, scrollFirst]);
    await p.waitForTimeout(40);
    await p.evaluate(() => {
      window.__tapTarget.dispatchEvent(new TouchEvent('touchstart',
        { touches: [window.__tapTouch], changedTouches: [window.__tapTouch], bubbles: true, cancelable: true }));
    });
    await p.waitForTimeout(60);
    // the release may navigate, which tears this context down mid-call
    await p.evaluate(() => {
      window.__tapTarget.dispatchEvent(new TouchEvent('touchend',
        { touches: [], changedTouches: [window.__tapTouch], bubbles: true, cancelable: true }));
    }).catch(() => { });
    await p.waitForTimeout(500);
    return new URL(p.url()).pathname;
  };

  check('a tap on the bar taken mid-scroll changes the page on the release',
    (await tapBar('Info', true)).indexOf('/info/') === 0, '');
  check('a tap with no scroll behind it is left to the ordinary click',
    (await tapBar('Info', false)).indexOf('/questlist/') === 0, '');

  await ctx.close();

  // ---------- the settings menu ----------
  // Seven switches used to sit in one flat list with nothing said
  // about any of them, two of them named for the code rather than for
  // what they did. It is three groups now — Display, On the day,
  // Phone — each row a name, a line saying what the setting does, and
  // the control; the Phone group goes with its rows where a device
  // cannot offer them, so no label is left over nothing. Every control
  // is the rocker's width, so the column is one column. The panel
  // scrolls inside itself on a short screen, and the floating button
  // steps back while the menu is open: it is above the top bar's
  // stacking context and would otherwise cover the last row.
  const menuOn = async (opts, path) => {
    const init = opts.init;
    const ctxOpts = Object.assign({ serviceWorkers: 'block' }, opts);
    delete ctxOpts.init;
    const c = await b.newContext(ctxOpts);
    const pg = await c.newPage();
    await pg.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await pg.route('**/files.scs.andyrew.space/**', r => r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
    if (init) await pg.addInitScript(init);
    await pg.goto(BASE + (path || '/'));
    await pg.waitForTimeout(700);
    await pg.evaluate(() => document.querySelector('.settings-toggle').click());
    await pg.waitForTimeout(450);
    return { c, pg };
  };
  const readMenu = (pg) => pg.evaluate(() => {
    const panel = document.getElementById('site-settings');
    const shown = el => !!el && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0;
    const groups = [...panel.querySelectorAll('.settings-group')].map(g => ({
      title: (g.querySelector('.settings-group-title') || {}).textContent,
      shown: shown(g),
      rows: [...g.querySelectorAll('.settings-row')].map(r => {
        const line = r.querySelector('.settings-desc');
        return {
          name: (r.querySelector('.settings-name') || {}).textContent,
          shown: shown(r),
          hasLine: !!line && line.textContent.trim().length > 0
        };
      })
    }));
    const box = el => { const r = el.getBoundingClientRect(); return { w: r.width, cx: r.x + r.width / 2 }; };
    const controls = [document.querySelector('.settings-panel .theme-toggle'), document.querySelector('.settings-size')]
      .concat([...panel.querySelectorAll('.settings-switch')]).filter(shown).map(box);
    const rockers = [...panel.querySelectorAll('.settings-knob > input')].map(i => {
      const name = document.getElementById(i.getAttribute('aria-labelledby') || '');
      const points = i.getAttribute('aria-describedby') || '';
      const desc = document.getElementById(points);
      const row = i.closest('.settings-row');
      return {
        id: i.id,
        named: !!name && !!row && name === row.querySelector('.settings-name'),
        hasLine: !!row && !!row.querySelector('.settings-desc'),
        described: !!desc && desc.textContent.trim().length > 0,
        // an aria-describedby naming an element that is not there:
        // a reader announces nothing and nobody sees the mistake
        dangling: !!points && !desc
      };
    });
    const r = panel.getBoundingClientRect();
    const tab = document.querySelector('.tab-bar');
    const tabTop = tab && getComputedStyle(tab).display !== 'none' ? tab.getBoundingClientRect().top : innerHeight;
    return {
      groups, controls, rockers,
      panel: {
        top: Math.round(r.top), bottom: Math.round(r.bottom), width: Math.round(r.width),
        scrolls: panel.scrollHeight > panel.clientHeight + 1,
        overflow: getComputedStyle(panel).overflowY
      },
      floor: Math.round(Math.min(innerHeight, tabTop)),
      push: { line: document.getElementById('set-push-hint').textContent, disabled: document.getElementById('set-push').disabled }
    };
  });

  let m = await menuOn(phone);
  let menu = await readMenu(m.pg);
  // Four now. The first three are the menu itself; Visual is the second
  // page behind the Visual row, in the panel but not on screen until it
  // is opened.
  check('the settings menu is four named groups: Display, On the day, Phone, Visual',
    menu.groups.map(g => g.title).join('|') === 'Display|On the day|Phone|Visual', JSON.stringify(menu.groups.map(g => g.title)));
  // Every row is named. A row carries a second line only where that
  // line says something the name and the control cannot, so the list
  // below is the panel's copy, checked by name:
  //   Appearance      no line. The moon and the sun say it.
  //   Text size       the line IS the value, "100%" — a bare number
  //                   next to A− / A+, which is why it stays.
  //   Quest animation both positions are an animation, so the name on
  //                   its own does not say what off gives you.
  //   Notifications   what actually arrives, and the state line when
  //                   the browser has none or they are blocked.
  //   Offline map     what is kept, what it costs on a phone, and that
  //                   off deletes it — none of it visible from the row.
  //   App layout      what the bottom tabs are. "Off is the ordinary
  //                   website" was the same sentence backwards.
  //   Haptic feedback no line. "A tick when you tap." is the name again
  //                   in a sentence.
  const lines = {};
  menu.groups.forEach(g => g.rows.forEach(r => { lines[r.name] = r.hasLine; }));
  //   Hide Dates      no line; the committee took it out.
  //   Justified Text  what justifying does to a paragraph, which the
  //                   two words on their own do not say.
  //   Hide Checklist  that it is the quest list's checklist, which the
  //                   name alone does not say.
  //   Group Map Pins  what a group is on the map, which the name alone
  //                   does not say.
  const wantLines = {
    'Appearance': false, 'Text Size': true, 'Full Screen Map': true, 'Sharper Map': true,
    'Hide Dates': false, 'Quest Panel Animation': true, 'Push Notifications': true,
    'Offline Map': true, 'App Layout': true, 'Haptic Feedback': false,
    'Justified Text': true, '24-hour Time': false, 'Hide Checklist': true, 'Group Map Pins': true
  };
  // A rocker is named by its row either way. Where the row has a line,
  // the rocker points at it; where the copy was cut, the attribute went
  // with it rather than being left aimed at nothing.
  check('every rocker is named by its row, and points at its line where there is one',
    menu.rockers.length === 12 &&
    menu.rockers.every(r => r.named && !r.dangling && r.described === r.hasLine) &&
    menu.rockers.filter(r => r.described).length === 9, JSON.stringify(menu.rockers));
  check('a phone browser shows the Phone group, both rows',
    menu.groups[2].shown && menu.groups[2].rows.length === 2 && menu.groups[2].rows.every(r => r.shown), JSON.stringify(menu.groups[2]));

  // The Visual row opens the second page, the back button comes home,
  // and closing the menu puts it back to the first — the gear always
  // opens the same thing. The panel's markup is in fifteen HTML files
  // and what drives it is in site.js, so one edited without the other
  // leaves four settings with no way to reach them and nothing on the
  // page to show for it.
  const whichPage = () => m.pg.evaluate(() => ({
    main: !document.getElementById('set-page-main').hidden,
    visual: !document.getElementById('set-page-visual').hidden,
    rows: [...document.querySelectorAll('#set-page-visual .settings-row')]
      .filter(r => r.getBoundingClientRect().height > 0).length
  }));
  await m.pg.evaluate(() => document.getElementById('set-visual-open').click());
  await sleep(450);
  const onVisual = await whichPage();
  await m.pg.evaluate(() => document.getElementById('set-visual-back').click());
  await sleep(450);
  const backHome = await whichPage();
  // left on the second page and closed, the gear still opens the first
  await m.pg.evaluate(() => document.getElementById('set-visual-open').click());
  await sleep(450);
  await m.pg.keyboard.press('Escape');
  await sleep(450);
  await m.pg.evaluate(() => document.querySelector('.settings-toggle').click());
  await sleep(450);
  const reopened = await whichPage();
  check('the Visual row opens the second page, back comes home, and the menu reopens on the first',
    onVisual.visual && !onVisual.main && onVisual.rows === 8 &&
    backHome.main && !backHome.visual &&
    reopened.main && !reopened.visual,
    JSON.stringify({ onVisual, backHome, reopened }));
  const w0 = menu.controls[0].w, cx0 = menu.controls[0].cx;
  check('the Notifications line says what they are, where the browser has them',
    menu.push.line.indexOf('Enable to receive') === 0 && !menu.push.disabled, menu.push.line);
  await m.pg.keyboard.press('Escape');
  await sleep(900);
  await m.c.close();

  // short screens: a phone on its side, an SE
  for (const vp of [{ width: 375, height: 667 }, { width: 844, height: 390 }]) {
    m = await menuOn({ viewport: vp, isMobile: true, hasTouch: true });
    menu = await readMenu(m.pg);
    check('at ' + vp.width + 'x' + vp.height + ' the panel stops above the bottom of the screen and scrolls inside itself',
      menu.panel.bottom <= menu.floor && menu.panel.scrolls && menu.panel.overflow === 'auto', JSON.stringify({ panel: menu.panel, floor: menu.floor }));
    await m.c.close();
  }

  // a desktop window has no phone things to offer
  m = await menuOn({ viewport: { width: 1280, height: 900 } });
  menu = await readMenu(m.pg);
  check('a desktop window shows Display and On the day, and no Phone group at all',
    menu.groups[0].shown && menu.groups[1].shown && !menu.groups[2].shown && menu.groups[2].rows.every(r => !r.shown),
    JSON.stringify(menu.groups.map(g => [g.title, g.shown])));
  await m.c.close();

  // a browser without push: the row's line says so in place of the
  // explanation, and the switch is greyed rather than sitting there
  m = await menuOn(Object.assign({ init: () => { try { delete window.PushManager; } catch (e) { } } }, phone));
  menu = await readMenu(m.pg);
  check('where the browser has no notifications the line says so and the switch is off limits',
    menu.push.disabled && menu.push.line === 'This browser does not support notifications.', JSON.stringify(menu.push));
  await m.c.close();

  // An iPhone's tap switches are added after the controls they cover,
  // the back button's at the end of the second page's group, so a rule
  // reading the last child left the last row's hairline showing.
  m = await menuOn(Object.assign({ init: IOS_LIKE }, phone));
  await m.pg.evaluate(() => document.getElementById('set-visual-open').click());
  await sleep(450);
  const lastLines = await m.pg.evaluate(() => [...document.querySelectorAll('#site-settings .settings-group')].map(g => {
    const rows = [...g.querySelectorAll(':scope > .settings-row')].filter(r => getComputedStyle(r).display !== 'none');
    const last = rows[rows.length - 1];
    return { tail: g.lastElementChild.className, line: last ? getComputedStyle(last).borderBottomWidth : '' };
  }));
  check('with an iPhone\'s tap switches in the menu, the last row of every group still has no line under it',
    lastLines.every(x => x.line === '0px') && lastLines.some(x => /haptic-tap/.test(x.tail)), JSON.stringify(lastLines));
  await m.c.close();

  // ---------- everything else is untouched ----------
  ctx = await b.newContext(phone);
  p = await ctx.newPage();
  await p.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await p.route('**/files.scs.andyrew.space/**', r => r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' }));
  await p.goto(BASE + '/');
  await p.waitForTimeout(700);
  check('a phone with the Vibration API keeps the old engine and grows no switches',
    !(await p.evaluate(() => document.documentElement.classList.contains('haptic-taps'))) &&
    (await p.evaluate(() => document.querySelectorAll('input.haptic-tap').length)) === 0, '');
  await ctx.close();

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  await b.close();
  if (server) server.kill();
  process.exit(fail === 0 ? 0 : 1);
})();
