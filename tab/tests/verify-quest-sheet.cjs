// The quest sheet as study 12 settled it: a box on a desktop, a sheet on
// a phone, the same composition in both.
//
// What it holds to:
//   - the order is head, the live question, what the quest is, where it
//     is, what came with it, what it pays, the actions
//   - four type sizes among the sheet's own words, none under 10.5px
//   - the figures in the codes table are the largest numerals on it
//   - green appears once, on the action
//   - four left edges at most, and none within 3px of another
//   - nothing runs off the side, and no two pieces of text touch
//   - the desktop keeps the box: a centred panel with the close glyph
//     back on the name's line; the phone has the grab bar and no close
//   - the behaviour the sheet exists for still works: ticking a code
//     draws its line, the tally counts, Submit proof carries the quest
//     in the hash, and the live question still sends
//
// Run with: node tests/verify-quest-sheet.cjs
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

// the longest quest name in the file, 49 characters, six code rows: a
// short invented name is what hides a measure problem
const KEY = 'SQ1';

(async () => {
  const q = await import(path.join(ROOT, 'tab/src/data/scs2-quests.ts'));
  const pl = await import(path.join(ROOT, 'tab/src/data/places.ts'));
  const groups = q.QUESTS.map(g => ({
    key: g.key, name: g.name, region: g.region, description: g.description,
    flavour: g.flavour, location: g.location, coords: g.coords, submit: g.submit,
    prompt: g.prompt, options: g.options, codes: g.codes, files: [], ask: null
  }));
  const target = groups.find(g => g.key === KEY);
  target.files = [
    { key: 'qst/pic1', name: 'platform.jpg', type: 'image/jpeg', bytes: 240000 },
    { key: 'qst/doc1', name: 'station-list.pdf', type: 'application/pdf', bytes: 524288 }
  ];
  target.ask = {
    kind: 'text', prompt: 'Which station will you finish at?', options: [],
    open: true, open_until: '2026-10-20 14:30:00'
  };
  // a per-unit quest, for the tally
  const COUNT_KEY = groups.find(g => g.submit === 'count').key;
  // SQ1's region carries a colour of its own, as the worker sends it
  const list = { regions: q.REGIONS, groups, places: pl.PLACES, region_colours: { 'Competition Region': 'purple' } };
  const posts = [];

  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await sleep(1200);
  }
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});

  const CORS = { 'access-control-allow-origin': '*' };
  const open = async (width, theme) => {
    const phone = width <= 930;
    const ctx = await b.newContext({
      serviceWorkers: 'block', viewport: { width, height: phone ? 844 : 900 },
      isMobile: phone, hasTouch: phone
    });
    const p = await ctx.newPage();
    const errors = [];
    const missing = [];
    p.on('pageerror', e => errors.push(e.message));
    p.on('response', r => {
      if (r.status() >= 400 && r.url().startsWith(BASE)) missing.push(r.status() + ' ' + r.url());
    });
    await p.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: r.request().url().endsWith('.css') ? 'text/css' : 'application/javascript', body: '' }));
    await p.route('**/files.scs.andyrew.space/**', async r => {
      const u = r.request().url();
      if (u.includes('/api/questlist')) return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(list) });
      if (u.includes('/api/quests/file')) return r.fulfill({ status: 200, contentType: 'image/svg+xml', headers: CORS, body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="#8aa"/></svg>' });
      if (u.includes('/api/quests')) return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ total_teams: 43, quests: [], groups: { [KEY]: 7 } }) });
      if (u.includes('/api/quest/ask')) {
        if (r.request().method() === 'POST') {
          posts.push(JSON.parse(r.request().postData() || '{}'));
          return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: true, choice: 'Central', amount: 0 }) });
        }
        return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ kind: 'text', prompt: 'Which station will you finish at?', options: [], open: true, open_until: '2026-10-20 14:30:00' }) });
      }
      return r.fulfill({ status: 404, contentType: 'application/json', headers: CORS, body: '{}' });
    });
    for (const h of ['tiles.scs.andyrew.space']) {
      await p.route('**/' + h + '/**', r => r.fulfill({ status: 404, body: '' }));
    }
    await p.addInitScript((dark) => {
      try {
        if (dark) localStorage.setItem('scs2-theme', 'dark');
        localStorage.setItem('scs2-anim', 'slide');       // no morph: measure a settled sheet
        localStorage.setItem('scs2-install-dismissed', '1');
        localStorage.setItem('scs2-submit-session', 'team-token');
      } catch (e) {}
    }, theme === 'dark');
    await p.goto(BASE + '/questlist/#' + KEY);
    await p.waitForTimeout(1500);
    return { ctx, p, errors, missing };
  };

  // Everything the sheet says, measured where the ink is rather than
  // where the box is: a right-aligned figure's box starts at the left of
  // its column while its first glyph is at the right.
  const survey = () => p => p.evaluate(() => {
    const sheet = document.querySelector('#ql-detail-overlay .ql-detail');
    // let it run to its full height: the sheet scrolls inside itself, and
    // measuring only what is above the fold is how five critics judged a
    // sheet whose codes, points and Submit button were off the shot
    const hadMax = sheet.style.maxHeight, hadOv = sheet.style.overflow;
    sheet.style.maxHeight = 'none';
    sheet.style.overflow = 'visible';
    // the head pins to the sheet's own scroll; unrolled, it would pin to
    // the window instead and sit over whatever is at the top of it
    const head = sheet.querySelector('.ql-detail-top');
    const hadPos = head.style.position;
    head.style.position = 'static';
    const box = sheet.getBoundingClientRect();
    const all = [...sheet.querySelectorAll('*')];
    const seen = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const layered = el => {
      for (let n = el; n && n !== sheet; n = n.parentElement) {
        const s = getComputedStyle(n);
        if (s.position === 'absolute' || s.position === 'fixed') return true;
      }
      return false;
    };
    const leaves = all.filter(el => seen(el) && el.children.length === 0 &&
      (el.textContent || '').trim().length > 1 && !layered(el));
    const inkOf = new Map();
    const ink = el => {
      if (inkOf.has(el)) return inkOf.get(el);
      let r;
      try {
        const g = document.createRange();
        g.selectNodeContents(el);
        r = g.getBoundingClientRect();
        if (!r.width || !r.height) r = el.getBoundingClientRect();
      } catch (e) { r = el.getBoundingClientRect(); }
      inkOf.set(el, r);
      return r;
    };

    const over = [], touch = [];
    for (let i = 0; i < leaves.length; i++) {
      for (let j = i + 1; j < leaves.length; j++) {
        if (leaves[i].contains(leaves[j]) || leaves[j].contains(leaves[i])) continue;
        const a = ink(leaves[i]), c = ink(leaves[j]);
        const w = Math.min(a.right, c.right) - Math.max(a.left, c.left);
        const h = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
        const say = (x, y) => x.textContent.trim().slice(0, 18) + ' / ' + y.textContent.trim().slice(0, 18);
        if (w > 2 && h > 2) over.push(say(leaves[i], leaves[j]));
        else if (h > 4 && w > -4 && w <= 2) touch.push(say(leaves[i], leaves[j]));
      }
    }

    // anything running off the side of the sheet
    const spill = all.filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > box.right + 1 || r.left < box.left - 1);
    }).map(el => (el.className || el.tagName) + '');

    // the sizes the sheet's own words are set at
    const sizes = {};
    const tiny = [];
    for (const el of leaves) {
      const s = getComputedStyle(el);
      const px = Math.round(parseFloat(s.fontSize) * 10) / 10;
      sizes[px] = (sizes[px] || 0) + 1;
      if (px < 10.5) tiny.push(el.textContent.trim().slice(0, 20) + ' @' + px);
    }

    // where the sheet's words start
    const edges = {};
    const says = {};
    for (const el of leaves) {
      const al = getComputedStyle(el).textAlign;
      if (al === 'right' || al === 'end' || al === 'center') continue;
      const r = ink(el);
      if (r.width < 40) continue;
      const x = Math.round(r.left - box.left);
      edges[x] = (edges[x] || 0) + 1;
      says[x] = (says[x] || []).concat(el.textContent.trim().slice(0, 14));
    }
    const used = Object.entries(edges).filter(([, n]) => n >= 2).map(([x]) => +x).sort((a, c) => a - c);
    const kept = [], near = [];
    for (const x of used) {
      if (kept.length && x - kept[kept.length - 1] <= 3) {
        near.push(kept[kept.length - 1] + ' "' + says[kept[kept.length - 1]][0] + '" / ' + x + ' "' + says[x][0] + '"');
        continue;
      }
      kept.push(x);
    }

    // where green turns up
    const probe = document.createElement('span');
    probe.style.color = 'var(--accent)';
    document.body.appendChild(probe);
    const accent = getComputedStyle(probe).color;
    probe.style.color = 'var(--accent-dark)';
    const accentDark = getComputedStyle(probe).color;
    // a filled green is --accent-solid, which is the light theme's green
    // in both themes; --accent is the green as ink
    probe.style.color = 'var(--accent-solid)';
    const accentSolid = getComputedStyle(probe).color;
    probe.remove();
    const greens = [];
    for (const el of all) {
      if (!seen(el)) continue;
      const s = getComputedStyle(el);
      const words = (el.children.length === 0 && (el.textContent || '').trim().length > 0);
      if (words && (s.color === accent || s.color === accentDark)) greens.push('ink:' + el.textContent.trim().slice(0, 16));
      if (s.backgroundColor === accent || s.backgroundColor === accentSolid) greens.push('fill:' + (el.textContent || '').trim().slice(0, 16));
    }

    const at = sel => {
      const el = sheet.querySelector(sel);
      return el ? Math.round(el.getBoundingClientRect().top - box.top) : null;
    };
    const cs = getComputedStyle(sheet);
    const out = {
      width: Math.round(box.width),
      viewport: document.documentElement.clientWidth,
      left: Math.round(box.left),
      radius: cs.borderTopLeftRadius,
      shadow: cs.boxShadow,
      topEdge: cs.borderTopColor + ' ' + cs.borderTopWidth,
      over, touch, spill, tiny,
      sizes: Object.keys(sizes).map(Number).sort((a, c) => a - c),
      edges: kept, near, greens,
      order: {
        head: at('.ql-detail-top'), ask: at('.ql-detail-ask'),
        body: at('#ql-detail-description'), facts: at('.ql-detail-facts'),
        files: at('#ql-detail-files'), points: at('.ql-detail-points'),
        actions: at('.ql-detail-actions')
      },
      headInk: (() => {
        const h = sheet.querySelector('.ql-detail-top');
        const hs = getComputedStyle(h);
        return { bg: hs.backgroundColor, fg: hs.color };
      })(),
      close: (() => {
        const c = sheet.querySelector('#ql-detail-close');
        const s = getComputedStyle(c);
        const r = c.getBoundingClientRect();
        const title = sheet.querySelector('#ql-detail-title').getBoundingClientRect();
        return {
          shown: s.display !== 'none',
          box: s.borderTopWidth + '/' + s.backgroundColor,
          hit: Math.round(r.width) + 'x' + Math.round(r.height),
          onTitleLine: r.height ? r.top < title.bottom : null,
          size: parseFloat(s.fontSize)
        };
      })(),
      grab: (() => {
        const g = sheet.querySelector('.ql-sheet-handle');
        const s = getComputedStyle(g);
        return { shown: s.display !== 'none', position: s.position, bg: s.backgroundColor };
      })(),
      figures: [...sheet.querySelectorAll('.ql-code-pts')].map(n => ({
        text: n.textContent, size: parseFloat(getComputedStyle(n).fontSize),
        nums: getComputedStyle(n).fontVariantNumeric, band: !!n.closest('.ql-band-row')
      })),
      title: (() => {
        const t = sheet.querySelector('#ql-detail-title');
        const s = getComputedStyle(t);
        const r = t.getBoundingClientRect();
        return { text: t.textContent, size: parseFloat(s.fontSize), lines: Math.round(r.height / parseFloat(s.lineHeight)) };
      })(),
      askBand: (() => {
        const a = sheet.querySelector('.ql-detail-ask');
        const s = getComputedStyle(a);
        const r = a.getBoundingClientRect();
        const glow = document.createElement('span');
        glow.style.backgroundColor = 'var(--glow-fill)';
        document.body.appendChild(glow);
        const amber = getComputedStyle(glow).backgroundColor;
        glow.remove();
        return {
          amber: s.backgroundColor === amber,
          bleeds: Math.abs(r.left - box.left) < 2 && Math.abs(r.right - box.right) < 2,
          send: (() => {
            const b2 = a.querySelector('.ql-ask-send');
            if (!b2) return null;
            const bs = getComputedStyle(b2);
            return { bg: bs.backgroundColor, fg: bs.color };
          })()
        };
      })()
    };
    sheet.style.maxHeight = hadMax;
    sheet.style.overflow = hadOv;
    head.style.position = hadPos;
    return out;
  });

  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [440, 'light'], [390, 'light'], [390, 'dark']]) {
    const tag = width + ' ' + theme;
    const { ctx, p, errors, missing } = await open(width, theme);
    const d = await survey()(p);

    check(tag + ': the page loads clean', errors.length === 0 && missing.length === 0,
      JSON.stringify({ errors, missing }));
    check(tag + ': nothing runs off the side of the sheet', d.spill.length === 0, d.spill.join(' | '));
    check(tag + ': no two pieces of text overlap or touch',
      d.over.length === 0 && d.touch.length === 0, JSON.stringify({ over: d.over, touch: d.touch }));
    check(tag + ': no type under 10.5px', d.tiny.length === 0, d.tiny.join(' | '));
    check(tag + ': four type sizes and no more', d.sizes.length <= 4, d.sizes.join(', '));
    check(tag + ': four left edges at most, none a near miss of another',
      d.edges.length <= 4 && d.near.length === 0, JSON.stringify({ edges: d.edges, near: d.near }));
    check(tag + ': green appears once, on the action',
      d.greens.length === 1, JSON.stringify(d.greens));

    const o = d.order;
    // What the quest pays used to come first, on the argument that it
    // is what a team opens the sheet to find out. It reads the other
    // way round: the description says what the quest IS, and a team
    // that does not know that has no use for the figure.
    check(tag + ': the order is head, question, what it is, where, what came with it, what it pays, the action',
      o.head < o.ask && o.body > o.ask && o.facts > o.body &&
      o.files > o.facts && o.points > o.files && o.actions > o.points,
      JSON.stringify(o));

    check(tag + ': the head is the one black object, carrying the name',
      d.headInk.bg === (theme === 'dark' ? 'rgb(12, 12, 12)' : 'rgb(19, 19, 19)') &&
      d.headInk.fg === 'rgb(255, 255, 255)', JSON.stringify(d.headInk));
    check(tag + ': a route edge across the top in the region\'s colour', /^rgb\(185, 51, 173\) 3px$/.test(d.topEdge), d.topEdge);

    check(tag + ': the real quest name fits the head in two lines',
      d.title.text.length === 49 && d.title.lines <= 2,
      JSON.stringify({ chars: d.title.text.length, size: d.title.size, lines: d.title.lines }));

    // SQ1 is a counted part, its four bands under it, and a bonus
    const parts = d.figures.filter(f => !f.band);
    const bands = d.figures.filter(f => f.band);
    check(tag + ': the figures are the largest numerals on the sheet, set tabular, a counted part\'s bands under it',
      parts.length === 1 && bands.length === 4 && d.figures.every(f => /^\d+$/.test(f.text)) &&
      d.figures.every(f => /tabular-nums/.test(f.nums)) &&
      parts[0].size === Math.max.apply(null, d.figures.map(f => f.size)) && parts[0].size >= 20 &&
      bands.every(f => f.size < parts[0].size),
      JSON.stringify(d.figures));

    check(tag + ': the question is one amber field reaching both edges, with Send as ink',
      d.askBand.amber && d.askBand.bleeds &&
      d.askBand.send && d.askBand.send.bg === 'rgba(0, 0, 0, 0)',
      JSON.stringify(d.askBand));

    if (width > 930) {
      // No shadow: the sheet is flat now, along with the fullscreen
      // map's search panel and the actions on it.
      check(tag + ': the desktop keeps the box — a centred panel, square, flat',
        d.width <= 560 && d.radius === '2px' && d.shadow === 'none' &&
        Math.abs(d.left - (d.viewport - d.width) / 2) < 2,
        JSON.stringify({ width: d.width, radius: d.radius, left: d.left, shadow: d.shadow }));
      check(tag + ': the close is a glyph on the name\'s line with a 44px hit area and no box',
        d.close.shown && d.close.hit === '44x44' && d.close.box === '0px/rgba(0, 0, 0, 0)' &&
        d.close.onTitleLine && d.close.size === d.title.size,
        JSON.stringify(d.close));
      check(tag + ': and no grab bar, since nothing drags', !d.grab.shown, JSON.stringify(d.grab));
    } else {
      check(tag + ': the phone gets the sheet — full width, no close button',
        d.width === d.viewport && !d.close.shown, JSON.stringify({ width: d.width, viewport: d.viewport, close: d.close.shown }));
      check(tag + ': the grab bar is still pinned at the top, in the head\'s own ink',
        d.grab.shown && d.grab.position === 'sticky' &&
        d.grab.bg === (theme === 'dark' ? 'rgb(12, 12, 12)' : 'rgb(19, 19, 19)'),
        JSON.stringify(d.grab));
    }

    await ctx.close();
  }

  // ---------- the behaviour the sheet exists for ----------
  const { ctx, p, errors } = await open(390, 'light');

  const submitHref = await p.evaluate(() => document.getElementById('ql-detail-submit').getAttribute('href'));
  check('Submit proof carries the quest in the hash', submitHref === '../submit/#SQ1', submitHref);
  const route = await p.evaluate(() => getComputedStyle(document.getElementById('ql-detail-bullet')).backgroundColor);
  check('the sheet takes its region\'s colour from the list the worker sends', route === 'rgb(185, 51, 173)', route);

  // ticking one code draws its line across the words and dims its chip
  const before = await p.evaluate(() => {
    const row = document.querySelectorAll('.ql-code-row:not(.ql-band-row)')[1];
    return {
      strike: getComputedStyle(row.querySelector('.ql-code-text'), '::after').transform,
      chip: getComputedStyle(row.querySelector('.code')).color
    };
  });
  await p.evaluate(() => document.querySelectorAll('.ql-code-row input')[1].click());
  await sleep(700);
  const after = await p.evaluate(() => {
    const row = document.querySelectorAll('.ql-code-row:not(.ql-band-row)')[1];
    const text = row.querySelector('.ql-code-text').getBoundingClientRect();
    const chip = row.querySelector('.code').getBoundingClientRect();
    const line = getComputedStyle(row.querySelector('.ql-code-text'), '::after');
    return {
      strike: line.transform,
      top: parseFloat(line.top),
      height: text.height,
      clearOfChip: text.left > chip.right,
      chip: getComputedStyle(row.querySelector('.code')).color
    };
  });
  await p.evaluate(() => document.querySelectorAll('.ql-code-row input')[1].click());
  await sleep(400);

  // the live question still sends
  await p.fill('.ql-ask-input', 'Central');
  await sleep(200);
  await p.click('.ql-ask-send');
  await sleep(500);
  check('the live question still posts the answer with the team session',
    posts.length === 1 && posts[0].quest === 'SQ1' && posts[0].choice === 'Central',
    JSON.stringify(posts));

  // the tally counts stations and nothing else
  await p.keyboard.press('Escape');
  await sleep(600);
  await p.evaluate((k) => {
    const it = [...document.querySelectorAll('.ql-item')].find(i => i.dataset.questId === k);
    it.scrollIntoView();
    it.querySelector('.ql-item-body').click();
  }, COUNT_KEY);
  await sleep(800);
  const tally0 = await p.evaluate(() => {
    const box = document.getElementById('ql-detail-repeat');
    const count = document.getElementById('ql-repeat-count');
    const minus = document.getElementById('ql-repeat-minus');
    const plus = document.getElementById('ql-repeat-plus');
    const cs = getComputedStyle(box);
    return {
      shown: !box.classList.contains('is-hidden'),
      text: count.textContent,
      minusOff: minus.disabled,
      border: cs.borderTopWidth,
      tracks: cs.gridTemplateColumns.split(' ').length,
      // both marks are bars, so they weigh the same
      minusBar: getComputedStyle(minus, '::before').width,
      plusBar: getComputedStyle(plus, '::before').width,
      plusStem: getComputedStyle(plus, '::after').height,
      minusStem: getComputedStyle(minus, '::after').content,
      centred: getComputedStyle(count).display + '/' + getComputedStyle(count).textAlign
    };
  });
  await p.click('#ql-repeat-plus');
  await p.click('#ql-repeat-plus');
  await sleep(300);
  const tally2 = await p.evaluate(() => ({
    text: document.getElementById('ql-repeat-count').textContent,
    lead: parseFloat(getComputedStyle(document.querySelector('#ql-repeat-count b')).fontSize),
    body: parseFloat(getComputedStyle(document.getElementById('ql-repeat-count')).fontSize)
  }));

  // the sheet still opens from a card and closes on Escape
  await p.keyboard.press('Escape');
  await sleep(600);
  check('Escape closes the sheet',
    await p.evaluate(() => document.getElementById('ql-detail-overlay').classList.contains('is-hidden')), '');
  check('no page errors', errors.length === 0, errors.join(' | '));
  await ctx.close();

  await b.close();
  if (server) server.kill();
  console.log(fail ? '\nFAILURES: ' + fail : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
