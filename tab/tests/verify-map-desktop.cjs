// Desktop map: the wheel and a trackpad pinch zoom it in the page and
// full screen alike, the full-screen quest list is a column beside the
// map that can be put away, and in a
// narrower window the search panel's grab bar drags with a mouse as
// well as stepping on a click.
//
// MapLibre needs WebGL and the tiles need the network, so a small
// stand-in takes its place — enough of the surface the page actually
// touches, recording what the page asks the map to do.
// Run with: node tests/verify-map-desktop.cjs
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

const FAKE_MAPLIBRE = () => {
  window.__wheelSeen = [];
  let map = null;
  function Map(opts) {
    map = this;
    window.__map = this;
    this._zoom = 12;
    this._el = document.getElementById(opts.container);
    this._canvas = document.createElement('canvas');
    this._el.appendChild(this._canvas);
    // where MapLibre's own wheel zoom listens
    this._canvas.addEventListener('wheel', e => window.__wheelSeen.push(e.ctrlKey ? 'pinch' : 'wheel'));
  }
  const self = function () { return this; };
  Object.assign(Map.prototype, {
    doubleClickZoom: { enable() {}, disable() {} },
    touchZoomRotate: { disableRotation() {} },
    keyboard: { disableRotation() {} },
    on: self, once: self, off: self, addControl: self, fitBounds: self, resize: self,
    easeTo(o) { if (o && typeof o.zoom === 'number') this._zoom = o.zoom; return this; },
    setPaintProperty: self, setLayoutProperty: self,
    getSource() { return undefined; },
    getLayer() { return undefined; },
    queryRenderedFeatures() { return []; },
    getCanvas() { return this._canvas; },
    getCanvasContainer() { return this._el; },
    getZoom() { return this._zoom; },
    getMaxZoom() { return 18; },
    zoomIn() { this._zoom += 1; return this; },
    zoomOut() { this._zoom -= 1; return this; },
    project() { return { x: 0, y: 0 }; },
    unproject() { return { lng: 151.2, lat: -33.87 }; }
  });
  function Popup() {}
  Object.assign(Popup.prototype, { setLngLat: self, setText: self, setOffset: self, addTo: self, remove: self });
  window.maplibregl = { Map, Popup, NavigationControl: function () {}, AttributionControl: function () {} };
};

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
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.addInitScript(FAKE_MAPLIBRE);
  await p.route('**/files.scs.andyrew.space/**', r => {
    const u = r.request().url();
    if (u.includes('/api/questlist')) return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(list) });
    return r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
  await p.route('**/tiles.scs.andyrew.space/**', r => r.fulfill({ status: 404, body: '' }));

  await p.goto(BASE + '/questlist/');
  await p.waitForTimeout(1400);

  // ---- the wheel ----
  // Every wheel over the map is the page's own: it zooms around the
  // pointer, keeps going a little once the input stops, and MapLibre's
  // own wheel zoom (a listener on its canvas in the stand-in) never sees
  // it, so nothing zooms twice. A scroll of the page that runs on over
  // the map stays the page's.
  const wheelOn = (events, settle) => p.evaluate(([evs, wait]) => new Promise(res => {
    const canvas = document.querySelector('#ql-map canvas');
    const before = window.__map.getZoom();
    window.__wheelSeen.length = 0;
    let prevented = false;
    let i = 0;
    let atLast = null;
    (function next() {
      if (i < evs.length) {
        const e = evs[i++];
        const ev = new WheelEvent('wheel', { deltaY: e.dy, ctrlKey: !!e.ctrl, cancelable: true, bubbles: true, clientX: 400, clientY: 300 });
        (e.page ? document.querySelector('.ql-list-card') || document.body : canvas).dispatchEvent(ev);
        if (!e.page) prevented = prevented || ev.defaultPrevented;
        requestAnimationFrame(next);
        return;
      }
      requestAnimationFrame(() => {
        atLast = window.__map.getZoom();
        setTimeout(() => res({ prevented, before, atLast, after: window.__map.getZoom(), seen: window.__wheelSeen.slice() }), wait);
      });
    })();
  }), [events, settle]);

  const passing = await wheelOn([{ dy: 40, page: true }, { dy: 40 }], 300);
  check('a scroll of the page that runs on over the in-page map is left to the page',
    !passing.prevented && passing.after === passing.before, JSON.stringify(passing));
  await p.waitForTimeout(400);

  const notch = await wheelOn([{ dy: -120 }], 600);
  check('a wheel resting on the in-page map zooms it, gliding rather than jumping, and never scrolls the page',
    notch.prevented && notch.atLast > notch.before && notch.after > notch.atLast && notch.seen.length === 0, JSON.stringify(notch));

  const pinch = await wheelOn([1, 2, 3, 4, 5, 6].map(() => ({ dy: -4, ctrl: true })), 600);
  check('a pinch zooms by its size and carries on a little after the fingers stop',
    pinch.prevented && pinch.atLast > pinch.before && pinch.after > pinch.atLast && pinch.after - pinch.before < 1 &&
    pinch.seen.length === 0, JSON.stringify(pinch));

  await p.click('#ql-map-full');
  await p.waitForTimeout(600);
  const fullWheel = await wheelOn([{ dy: -120 }, { dy: -4, ctrl: true }], 600);
  check('full screen the wheel and the pinch are still the page\'s, and MapLibre\'s own wheel zoom never sees them',
    fullWheel.prevented && fullWheel.after > fullWheel.before && fullWheel.seen.length === 0, JSON.stringify(fullWheel));

  // ---- the sidebar ----
  // Full screen on a desktop keeps the quest list in a column down the
  // left with the map beside it. It can be put away and brought back,
  // and the device keeps which: what the page and the stored key have
  // to agree about is checked here, not how the column looks.
  const sideNow = () => p.evaluate(() => {
    const panel = document.getElementById('ql-map-search').getBoundingClientRect();
    const card = document.querySelector('.ql-map-card').getBoundingClientRect();
    return {
      away: document.documentElement.classList.contains('ql-side-away'),
      inert: document.getElementById('ql-map-search').inert,
      panelLeft: Math.round(panel.left), panelRight: Math.round(panel.right), panelH: Math.round(panel.height),
      cardLeft: Math.round(card.left),
      rows: document.querySelectorAll('#ql-search-results .ql-sr-item').length,
      kept: localStorage.getItem('scs2-questlist-side')
    };
  });
  let side0 = await sideNow();
  check('full screen on a desktop puts the quest list in a column down the left, with the map beside it',
    !side0.away && side0.panelLeft === 0 && side0.panelH > 700 && side0.cardLeft === side0.panelRight &&
    side0.rows > 50, JSON.stringify(side0));
  await p.click('#ql-side-edge');
  await p.waitForTimeout(450);
  const side1 = await sideNow();
  check('the strip along its edge puts it away: the map takes the width and the column is inert',
    side1.away && side1.inert === true && side1.cardLeft === 0 && side1.kept === '0', JSON.stringify(side1));
  await p.keyboard.press('[');
  await p.waitForTimeout(450);
  const side2 = await sideNow();
  check('and [ brings it back',
    !side2.away && side2.inert === false && side2.cardLeft > 300 && side2.kept === '1', JSON.stringify(side2));
  await p.focus('#ql-search-input');
  await p.keyboard.press('[');
  await p.waitForTimeout(300);
  const typed = await p.evaluate(() => ({ away: document.documentElement.classList.contains('ql-side-away'), value: document.getElementById('ql-search-input').value }));
  check('a [ typed into the search box is a character, not the shortcut',
    !typed.away && typed.value === '[', JSON.stringify(typed));
  await p.evaluate(() => { const i = document.getElementById('ql-search-input'); i.value = ''; i.dispatchEvent(new Event('input')); i.blur(); });

  // ---- the grab bar drags with a mouse ----
  // a desktop window narrower than the sidebar's breakpoint gets the
  // phone's panel, and a mouse drags it the way a finger does
  await p.setViewportSize({ width: 900, height: 900 });
  await p.waitForTimeout(500);
  const panelH = () => p.$eval('#ql-map-search', el => Math.round(el.getBoundingClientRect().height));
  const grab = () => p.$eval('#ql-map-search .ql-search-grab', el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });

  const barH = await panelH();
  check('the panel starts as a bar', barH > 40 && barH < 160, 'h=' + barH);

  let g = await grab();
  await p.mouse.move(g.x, g.y);
  await p.mouse.down();
  await p.mouse.move(g.x, g.y - 60, { steps: 6 });
  await p.mouse.move(g.x, g.y - 160, { steps: 8 });
  const dragging = await p.evaluate(() => {
    const el = document.getElementById('ql-map-search');
    return { h: Math.round(el.getBoundingClientRect().height), cls: el.classList.contains('is-dragging'), inline: el.style.height };
  });
  check('holding the bar and pulling up grows the panel under the pointer',
    dragging.h > barH + 120 && dragging.cls && dragging.inline !== '', JSON.stringify({ barH, ...dragging }));

  await p.mouse.move(g.x, g.y - 430, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(500);
  const afterDrag = await p.evaluate(() => {
    const el = document.getElementById('ql-map-search');
    return {
      h: Math.round(el.getBoundingClientRect().height),
      half: el.classList.contains('is-half'), full: el.classList.contains('is-full'),
      dragging: el.classList.contains('is-dragging'), inline: el.style.height
    };
  });
  check('letting go snaps it to a resting size and hands the height back to the stylesheet',
    (afterDrag.half || afterDrag.full) && !afterDrag.dragging && afterDrag.inline === '', JSON.stringify(afterDrag));
  check('the drag does not also fire the click that would step it on again',
    afterDrag.h > barH + 150, JSON.stringify(afterDrag));

  g = await grab();
  await p.mouse.move(g.x, g.y);
  await p.mouse.down();
  await p.mouse.move(g.x, g.y + 520, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(500);
  const backDown = await panelH();
  check('dragging it down puts it away again', Math.abs(backDown - barH) < 10, JSON.stringify({ barH, backDown }));

  g = await grab();
  await p.mouse.click(g.x, g.y);
  await p.waitForTimeout(450);
  const clicked = await p.evaluate(() => document.getElementById('ql-map-search').classList.contains('is-half'));
  check('a click with no movement still opens it to half', clicked, '');

  // leaving full screen
  await p.keyboard.press('Escape');
  await p.waitForTimeout(300);
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);
  await p.setViewportSize({ width: 1280, height: 900 });
  await p.waitForTimeout(500);

  // The search, the chips and the switches are one set of controls with
  // one home in the DOM, and on a wide screen that home is the side
  // panel. Full screen borrows all three; what has to survive giving
  // them back is the order and the fact that nothing closed the
  // switches on the way out — neither of which any layout check can
  // see, and both of which a change to travel() or placeSide() breaks
  // without a symptom until somebody looks at the page.
  const side = await p.evaluate(() => {
    const el = document.getElementById('ql-side');
    const f = document.getElementById('ql-filters');
    return {
      kids: [].map.call(el.children, (c) => c.id),
      switches: !!f && !f.hidden && f.getBoundingClientRect().height > 0,
      search: (document.getElementById('ql-search') || {}).isConnected === true
    };
  });
  check('and hands the search, the chips and the switches back to the side panel, in order and still showing',
    side.kids.join(',') === 'ql-pill,ql-chips,ql-filters' && side.switches && side.search,
    JSON.stringify(side));

  // The fold is the one thing about the chips a reader can break by
  // editing something else: hidden chips have to come back the moment
  // the row is not a wrapped column any more, and the category that is
  // on can never be one of the hidden ones — a row that folds away the
  // answer reads as nothing being picked.
  const folded = await p.evaluate(() => {
    const row = document.getElementById('ql-chips');
    const kids = [].slice.call(row.children);
    const more = row.querySelector('.ql-chip-more');
    const hidden = kids.filter((c) => c !== more && c.hidden);
    return {
      total: kids.length - (more ? 1 : 0),
      hidden: hidden.length,
      onHidden: hidden.some((c) => c.classList.contains('is-on')),
      label: more && !more.hidden ? more.textContent : ''
    };
  });
  check('the chip row folds to two rows with the rest behind a button',
    folded.total > folded.hidden && folded.hidden > 0 &&
    !folded.onHidden && folded.label === folded.hidden + ' more',
    JSON.stringify(folded));

  await p.setViewportSize({ width: 700, height: 900 });
  await p.waitForTimeout(300);
  const narrow = await p.evaluate(() => {
    const row = document.getElementById('ql-chips');
    const more = row.querySelector('.ql-chip-more');
    return {
      hidden: [].filter.call(row.children, (c) => c !== more && c.hidden).length,
      more: !!more && !more.hidden
    };
  });
  check('a row that scrolls sideways has nothing folded and no button',
    narrow.hidden === 0 && narrow.more === false, JSON.stringify(narrow));

  console.log('errors', errors);
  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  await b.close();
  if (server) server.kill();
  process.exit(fail ? 1 : 0);
})();
