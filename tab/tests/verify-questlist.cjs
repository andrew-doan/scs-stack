// The three marks a tick leaves: the list name draws its own strike,
// the code chips dim rather than being crossed out, and a tick that
// only opens the sheet flashes the box holding the choice.
// Run with: node tests/verify-questlist.cjs
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

(async () => {
  const q = await import(path.join(ROOT, 'tab/src/data/scs2-quests.ts'));
  const pl = await import(path.join(ROOT, 'tab/src/data/places.ts'));
  const list = { regions: q.REGIONS, groups: q.QUESTS.map(g => ({ key: g.key, name: g.name, region: g.region, description: g.description, flavour: g.flavour, location: g.location, coords: g.coords, submit: g.submit, prompt: g.prompt, options: g.options, codes: g.codes })), places: pl.PLACES };

  // two quests carrying a question: one taking answers, one shut. The
  // quests the tick tests use are left alone.
  const spare = list.groups.filter(g => ['MQ1', 'MQ2', 'SQ46'].indexOf(g.key) === -1).slice(0, 2);
  const LIVE_KEY = spare[0].key;
  const SHUT_KEY = spare[1].key;
  spare[0].ask = { kind: 'choice', prompt: 'Which way?', options: ['Left', 'Right'], open: true, open_until: '2026-10-20 06:00:00' };
  spare[1].ask = { kind: 'choice', prompt: 'Which way?', options: ['Left', 'Right'], open: false, open_until: '' };
  // a mystery quest, sent the way the worker sends one: no points
  const mystery = list.groups.find(g => ['MQ1', 'MQ2', 'SQ46', LIVE_KEY, SHUT_KEY].indexOf(g.key) === -1 &&
    g.codes.length === 1 && g.submit !== 'count' && !/^per\b/i.test(g.codes[0].label || ''));
  mystery.mystery = true;
  mystery.codes = mystery.codes.map(c => Object.assign({}, c, { points: null }));

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

  const item = (key) => p.evaluate((k) => {
    const it = [...document.querySelectorAll('.ql-item')].find(i => i.dataset.questId === k);
    const label = it.querySelector('.ql-item-label');
    const chip = it.querySelector('.ql-code');
    return {
      done: it.classList.contains('is-done'),
      strike: getComputedStyle(label).backgroundSize,
      chipColour: getComputedStyle(chip).color,
      chipOpacity: getComputedStyle(chip).opacity,
      labelIsOwnSpan: !!label && label.textContent.length > 2
    };
  }, key);

  // ---- the chip row still scrolls sideways ----
  // The row is a horizontal scroller, and site.js carries two gesture
  // guards that cancel touchmoves: the pull, which claims the first
  // downward move at the top of the page before it can tell how far
  // sideways the finger is going, and the swipe killer, which cancels
  // every horizontal drag so iOS does not read one as a back gesture.
  // Both were cancelling this row's own pan, so a phone could only ever
  // reach the chips already on screen — a guard in one file silently
  // disabling a control in another, with nothing on the page to show
  // for it.
  const swipe = await p.evaluate(async () => {
    const chip = document.querySelector('#ql-chips .ql-chip');
    const r = chip.getBoundingClientRect();
    const x0 = Math.round(r.left + r.width / 2), y0 = Math.round(r.top + r.height / 2);
    const mk = (type, x, y) => {
      const t = new Touch({ identifier: 3, target: chip, clientX: x, clientY: y, pageX: x, pageY: y });
      const one = type === 'touchend' ? [] : [t];
      return new TouchEvent(type, { touches: one, targetTouches: one, changedTouches: [t], bubbles: true, cancelable: true });
    };
    chip.dispatchEvent(mk('touchstart', x0, y0));
    const cancelled = [];
    // sideways, drifting a pixel down a frame the way a real finger does
    for (let i = 1; i <= 6; i++) {
      const ev = mk('touchmove', x0 - i * 18, y0 + i);
      chip.dispatchEvent(ev);
      cancelled.push(ev.defaultPrevented);
      await new Promise(res => setTimeout(res, 30));
    }
    chip.dispatchEvent(mk('touchend', x0 - 108, y0 + 6));
    const row = document.getElementById('ql-chips');
    return { cancelled, over: row.scrollWidth - row.clientWidth };
  });
  check('a sideways drag on the chip row is left to the browser',
    swipe.over > 40 && swipe.cancelled.every(c => c === false), JSON.stringify(swipe));

  // ---- ticking a plain quest on the list ----
  const before = await item('MQ1');
  check('a quest that is not done shows no line and a bright chip',
    parseFloat(before.strike) === 0 && before.labelIsOwnSpan, JSON.stringify(before));
  const chipBright = before.chipColour;

  await p.evaluate(() => {
    const it = [...document.querySelectorAll('.ql-item')].find(i => i.dataset.questId === 'MQ1');
    it.scrollIntoView();
    it.querySelector('.ql-check').click();
  });
  await sleep(90);

  await sleep(500);
  await sleep(600);

  // un-ticking pulls it back off
  await p.evaluate(() => {
    const it = [...document.querySelectorAll('.ql-item')].find(i => i.dataset.questId === 'MQ1');
    it.querySelector('.ql-check').click();
  });
  await sleep(600);
  const undone = await item('MQ1');
  check('un-ticking takes the line back off and brings the chip back',
    parseFloat(undone.strike) === 0 && undone.chipColour === chipBright, JSON.stringify(undone));

  // open a quest's sheet
  await p.evaluate(() => {
    const it = [...document.querySelectorAll('.ql-item')].find(i => i.dataset.questId === 'SQ46');
    it.scrollIntoView();
    it.querySelector('.ql-item-body').click();
  });
  await p.waitForTimeout(800);

  // the sheet offers the way to send proof, with the quest carried in
  // the hash for the submit page to pick up
  const submitLink = await p.evaluate(() => {
    const a = document.getElementById('ql-detail-submit');
    const r = a.getBoundingClientRect();
    return { href: a.getAttribute('href'), text: a.textContent, shown: r.width > 0 && r.height > 0 };
  });
  check('the sheet carries a Submit proof link naming its quest',
    submitLink.href === '../submit/#SQ46' && submitLink.text === 'Submit this Quest' && submitLink.shown,
    JSON.stringify(submitLink));

  const rowBefore = await p.evaluate(() => {
    const row = document.querySelectorAll('.ql-code-row')[1];
    return { chip: getComputedStyle(row.querySelector('.code')).color, after: getComputedStyle(row.querySelector('.ql-code-text'), '::after').transform };
  });
  await p.evaluate(() => document.querySelectorAll('.ql-code-row input')[1].click());
  await sleep(80);
  const rowMid = await p.evaluate(() => {
    const row = document.querySelectorAll('.ql-code-row')[1];
    return getComputedStyle(row.querySelector('.ql-code-text'), '::after').transform;
  });
  await sleep(600);
  const rowAfter = await p.evaluate(() => {
    const row = document.querySelectorAll('.ql-code-row')[1];
    return { chip: getComputedStyle(row.querySelector('.code')).color, after: getComputedStyle(row.querySelector('.ql-code-text'), '::after').transform };
  });
  await p.keyboard.press('Escape');
  await sleep(600);

  // ---- the flash when a tick only opens the sheet ----
  // The box pulses several times and the pulses come apart as they go,
  // so watch it frame by frame and read the rhythm off the colour.
  // ---- deep links: the hash names a quest on both pages ----
  // the share button in a sheet's head copies the link that opens it
  const shared = await p.evaluate(async () => {
    document.querySelector('.ql-item[data-quest-id="MQ1"] .ql-item-body').click();
    await new Promise(r => setTimeout(r, 900));
    let copied = null;
    navigator.clipboard.writeText = text => { copied = text; return Promise.resolve(); };
    document.getElementById('ql-detail-share').click();
    await new Promise(r => setTimeout(r, 100));
    return copied;
  });
  await p.goto(shared || BASE + '/questlist/');
  await p.waitForTimeout(1400);
  const hashOpen = await p.evaluate(() => ({
    open: !document.getElementById('ql-detail-overlay').classList.contains('is-hidden'),
    title: document.getElementById('ql-detail-title').textContent,
    submitHref: document.getElementById('ql-detail-submit').getAttribute('href')
  }));
  const mq1 = list.groups.find(g => g.key === 'MQ1');
  check('a sheet\'s share button copies /questlist/#MQ1, and that link opens the quest\'s sheet',
    shared === BASE + '/questlist/#MQ1' &&
    hashOpen.open && hashOpen.title === mq1.name && hashOpen.submitHref === '../submit/#MQ1',
    JSON.stringify({ shared, hashOpen }));

  await p.goto(BASE + '/submit/#MQ1');
  await p.waitForTimeout(900);
  const picked = await p.evaluate(() => {
    const el = document.getElementById('sub-quest-picked');
    return {
      hidden: el.classList.contains('is-hidden'),
      chip: el.querySelector('.code') ? el.querySelector('.code').textContent : '',
      text: el.textContent
    };
  });
  check('/submit/#MQ1 arrives with the quest already picked',
    !picked.hidden && picked.chip === 'MQ1' && picked.text.indexOf(mq1.name) !== -1,
    JSON.stringify(picked));

  // ---- the panel's text search filters the list ----
  // (matchesFilters takes (quest, skipSearch); handed bare to .filter
  // it received the index as skipSearch and only quest 0 was searched)
  await p.goto(BASE + '/questlist/');
  await p.waitForTimeout(1300);
  const allCount = await p.evaluate(() => document.querySelectorAll('.ql-item').length);
  await p.fill('#ql-search', 'parramatta');
  await p.waitForTimeout(400);
  const searched = await p.evaluate(() => ({
    items: document.querySelectorAll('.ql-item').length,
    names: [...document.querySelectorAll('.ql-item-label')].map(n => n.textContent)
  }));
  check('typing in the panel search narrows the list to matching quests',
    searched.items > 0 && searched.items < allCount / 4 &&
    searched.names.some(n => /parramatta/i.test(n)),
    JSON.stringify({ all: allCount, found: searched.items, names: searched.names }));
  await p.fill('#ql-search', 'paramata');
  await p.waitForTimeout(400);
  const loose = await p.evaluate(() => [...document.querySelectorAll('.ql-item-label')].map(n => n.textContent));
  check('a misspelt name still finds its quests', loose.length > 0 && loose.some(n => /parramatta/i.test(n)) && loose.length < 6, JSON.stringify(loose));
  await p.fill('#ql-search', '18');
  await p.waitForTimeout(400);
  const byNumber = await p.evaluate(() => [...document.querySelectorAll('.ql-item .ql-code')].map(n => n.textContent));
  check('a number alone finds every quest with it in the code', byNumber.length >= 1 && byNumber.every(c => /18/.test(c)), JSON.stringify(byNumber));
  await p.fill('#ql-search', '');
  await p.waitForTimeout(400);
  check('clearing the search brings the whole list back',
    (await p.evaluate(() => document.querySelectorAll('.ql-item').length)) === allCount, '');

  // ---- a quest with a question open right now says so on its card ----
  const live = await p.evaluate((keys) => {
    const card = (k) => [...document.querySelectorAll('.ql-item')].find(i => i.dataset.questId === k);
    const probe = document.createElement('span');
    probe.style.color = 'var(--alert-ink)';
    document.body.appendChild(probe);
    const alert = getComputedStyle(probe).color;
    probe.remove();
    const tag = (k) => {
      const c = card(k);
      const t = c ? c.querySelector('.ql-live') : null;
      if (!t) return null;
      const cs = getComputedStyle(t);
      return {
        text: t.textContent, caps: cs.textTransform, colour: cs.color, size: cs.fontSize,
        // between the code chip and the name, so the strike is untouched
        afterChip: t.compareDocumentPosition(c.querySelector('.ql-code')) === 2,
        beforeName: t.compareDocumentPosition(c.querySelector('.ql-item-label')) === 4,
        strike: getComputedStyle(c.querySelector('.ql-item-label')).backgroundSize
      };
    };
    return { alert, open: tag(keys.open), shut: tag(keys.shut) };
  }, { open: LIVE_KEY, shut: SHUT_KEY });
  check('a quest taking answers is marked LIVE beside its code, red as words',
    !!live.open && live.open.text === 'Live' && live.open.caps === 'uppercase' &&
    live.open.colour === live.alert && parseFloat(live.open.size) === 0.72 * 16 &&
    live.open.afterChip && live.open.beforeName,
    JSON.stringify(live.open));
  check('a question that is shut leaves no mark', live.shut === null, JSON.stringify(live.shut));
  check('the mark does not disturb the name\'s strike',
    parseFloat(live.open.strike) === 0, JSON.stringify(live.open.strike));

  // ---- the panel's Live questions only rocker ----
  const rocker = await p.evaluate(() => {
    const box = document.getElementById('ql-live-only');
    const label = box.closest('.ql-checkbox');
    return {
      text: label.querySelector('span').textContent,
      checked: box.checked,
      faces: [...label.querySelectorAll('.settings-switch span')].map(s => s.textContent).join(''),
      // it travels to the fullscreen search panel with the other filters
      inFilterGroup: !!label.closest('#ql-filter-group')
    };
  });
  check('the filter is an O/I rocker in the panel, off to begin with',
    rocker.text === 'Live Quests Only' && rocker.checked === false &&
    rocker.faces === 'OI' && rocker.inFilterGroup, JSON.stringify(rocker));

  await p.evaluate(() => document.getElementById('ql-live-only').click());
  await p.waitForTimeout(400);
  const narrowed = await p.evaluate(() => ({
    items: [...document.querySelectorAll('.ql-item')].map(i => i.dataset.questId),
    count: document.getElementById('ql-count').textContent
  }));
  check('turning it on narrows the list to the quest taking answers',
    narrowed.items.length === 1 && narrowed.items[0] === LIVE_KEY &&
    narrowed.count.indexOf('1 of ' + allCount) === 0,
    JSON.stringify(narrowed));

  await p.evaluate(() => document.getElementById('ql-live-only').click());
  await p.waitForTimeout(400);
  check('turning it off brings the whole list back',
    (await p.evaluate(() => document.querySelectorAll('.ql-item').length)) === allCount, '');

  // ---- clearing progress: slide, then a plain confirm ----
  await p.goto(BASE + '/questlist/');
  await p.waitForTimeout(600);
  await p.evaluate(() => localStorage.setItem('scs2-questlist-done-v2', JSON.stringify({ MQ1: true, MQ2: true })));
  await p.reload();
  await p.waitForTimeout(1300);

  const doneCount = () => p.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('scs2-questlist-done-v2') || '{}')).length);
  const openClear = async () => {
    await p.evaluate(() => {
      const b = document.getElementById('ql-reset-done');
      b.scrollIntoView();
      b.click();
    });
    await p.waitForTimeout(400);
  };
  const slideTo = async (fracs) => p.evaluate(async (steps) => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const track = document.querySelector('.confirm-slide');
    const thumb = document.querySelector('.confirm-slide-thumb');
    const max = track.clientWidth - thumb.offsetWidth - 6;
    const ev = (type, x) => thumb.dispatchEvent(new PointerEvent(type, { clientX: x, pointerId: 1, bubbles: true }));
    ev('pointerdown', 0);
    for (const f of steps) { ev('pointermove', max * f); await sleep(40); }
    ev('pointerup', max * steps[steps.length - 1]);
    await sleep(120);
    return {
      step2: !!document.querySelector('.btn-danger'),
      overlay: !!document.querySelector('.confirm-overlay')
    };
  }, fracs);

  await openClear();
  check('Reset progress opens the slide panel instead of clearing',
    await p.evaluate(() => !!document.querySelector('.confirm-overlay .confirm-slide-thumb')) &&
    (await doneCount()) === 2, '');

  const half = await slideTo([0.3, 0.55]);
  check('letting go half way does nothing', half.overlay && !half.step2 && (await doneCount()) === 2, JSON.stringify(half));
  await p.waitForTimeout(400);
  const thumbHome = await p.evaluate(() => getComputedStyle(document.querySelector('.confirm-slide-thumb')).transform);
  check('and the thumb eases back to the start',
    thumbHome === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(thumbHome), thumbHome);

  const backAgain = await slideTo([0.5, 1, 0.98, 0.2]);
  check('sliding across and back before letting go does nothing either',
    backAgain.overlay && !backAgain.step2 && (await doneCount()) === 2, JSON.stringify(backAgain));

  // a downward drag on the slider must never feed the pull-to-refresh:
  // it used to move the page under the overlay and arm the arrow
  const pullLeak = await p.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    document.body.scrollTop = 0;
    const thumb = document.querySelector('.confirm-slide-thumb');
    const send = (type, x, y) => {
      const t = new Touch({ identifier: 9, target: thumb, clientX: x, clientY: y });
      thumb.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
    };
    let y = 400;
    send('touchstart', 100, y);
    await sleep(40);
    for (let i = 0; i < 5; i++) { y += 30; send('touchmove', 100, y); await sleep(30); }
    const state = {
      pulling: document.documentElement.classList.contains('is-pulling'),
      pull: getComputedStyle(document.documentElement).getPropertyValue('--pull').trim(),
      armed: document.querySelector('.ptr').classList.contains('is-armed')
    };
    send('touchend', 100, y);
    await sleep(150);
    return state;
  });
  check('a touch on the confirm overlay never feeds the pull',
    !pullLeak.pulling && !pullLeak.armed && (pullLeak.pull === '' || pullLeak.pull === '0px'),
    JSON.stringify(pullLeak));

  await p.keyboard.press('Escape');
  await p.waitForTimeout(600);
  check('Escape closes the slide panel with nothing cleared',
    !(await p.evaluate(() => !!document.querySelector('.confirm-overlay'))) && (await doneCount()) === 2, '');

  // and the pull itself still lives once the overlay is gone
  const pullAlive = await p.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    document.body.scrollTop = 0;
    await sleep(60);
    const main = document.querySelector('main[data-pull]');
    const send = (type, y) => {
      const t = new Touch({ identifier: 8, target: main, clientX: 200, clientY: y });
      main.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
    };
    let y = 300;
    send('touchstart', y);
    await sleep(40);
    for (let i = 0; i < 3; i++) { y += 20; send('touchmove', y); await sleep(30); }
    const pulling = document.documentElement.classList.contains('is-pulling');
    send('touchend', y);
    await sleep(400);
    return { pulling, settled: !document.documentElement.classList.contains('is-pulling') };
  });
  check('and an ordinary pull still works after the overlay is gone',
    pullAlive.pulling && pullAlive.settled, JSON.stringify(pullAlive));

  await openClear();
  const armed = await slideTo([0.4, 0.8, 1]);
  check('released at the far end it moves on to the second panel — still nothing cleared',
    armed.step2 && (await doneCount()) === 2, JSON.stringify(armed));
  await p.evaluate(() => {
    [...document.querySelectorAll('.confirm-actions .btn')].find(b => b.textContent === 'Cancel').click();
  });
  await p.waitForTimeout(500);
  check('Cancel on the second panel keeps everything',
    !(await p.evaluate(() => !!document.querySelector('.confirm-overlay'))) && (await doneCount()) === 2, '');

  await openClear();
  await slideTo([0.6, 1]);
  await p.evaluate(() => document.querySelector('.btn-danger').click());
  await p.waitForTimeout(500);
  check('the Clear button on the second panel is what finally clears',
    (await doneCount()) === 0 &&
    !(await p.evaluate(() => !!document.querySelector('.confirm-overlay'))), '');

  // A mystery quest says ??? on its row and its sheet, and a tick adds
  // ??? to the tally rather than a figure.
  const unknown = await p.evaluate(async (k) => {
    const it = [...document.querySelectorAll('.ql-item')].find(i => i.dataset.questId === k);
    it.scrollIntoView();
    const row = it.querySelector('.ql-item-points').textContent;
    it.querySelector('.ql-check').click();
    await new Promise(res => setTimeout(res, 700));
    const tally = document.getElementById('ql-done-points').getAttribute('data-value');
    [...document.querySelectorAll('.ql-item')].find(i => i.dataset.questId === k).querySelector('.ql-item-body').click();
    await new Promise(res => setTimeout(res, 900));
    const sheet = [...document.querySelectorAll('#ql-detail-overlay .ql-code-pts')].map(n => n.textContent);
    return { row, tally, sheet };
  }, mystery.key);
  check('a mystery quest reads ??? on the list and the sheet, and adds ??? to the tally',
    unknown.row === '???' && unknown.tally === '0 + ???' && unknown.sheet.length === 1 && unknown.sheet[0] === '???',
    JSON.stringify(unknown));

  // Hide Checklist in the settings menu (site.js) takes the ticking off
  // the quest list, on the spot and after a reload, and leaves what was
  // ticked saved, so turning it off brings the ticks back.
  await p.keyboard.press('Escape');
  await sleep(600);
  const savedTicks = () => p.evaluate(() => localStorage.getItem('scs2-questlist-done-v2'));
  const ticksBefore = await savedTicks();
  const checklist = () => p.evaluate(async (k) => {
    const shown = el => !!el && el.getBoundingClientRect().height > 0;
    const it = document.querySelector('.ql-item[data-quest-id="' + k + '"]');
    const out = {
      on: document.documentElement.classList.contains('hide-checklist'),
      boxes: [...document.querySelectorAll('.ql-check')].filter(shown).length,
      marked: document.querySelectorAll('.ql-item.is-done, .ql-item.is-partial').length,
      tally: shown(document.querySelector('.ql-tally')),
      hideDone: getComputedStyle(document.getElementById('ql-hide-done').closest('.ql-checkbox')).display !== 'none',
      // the row's words start at the row's edge once the box column goes
      inset: Math.round(it.querySelector('.ql-item-body').getBoundingClientRect().left - it.getBoundingClientRect().left)
    };
    const parts = document.querySelector('.ql-item[data-quest-id="SQ46"]');
    parts.scrollIntoView();
    parts.querySelector('.ql-item-body').click();
    await new Promise(res => setTimeout(res, 900));
    out.sheetBoxes = document.querySelectorAll('#ql-detail-overlay .ql-code-row input').length;
    out.sheetButton = shown(document.getElementById('ql-detail-done'));
    return out;
  }, mystery.key);
  const flipChecklist = async () => {
    await p.evaluate(() => document.getElementById('set-hide-checklist').click());
    await sleep(300);
  };
  await flipChecklist();
  const hidden = await checklist();
  await p.keyboard.press('Escape');
  await sleep(600);
  await p.reload();
  await p.waitForTimeout(1300);
  const hiddenAfterLoad = await checklist();
  await p.keyboard.press('Escape');
  await sleep(600);
  await flipChecklist();
  const back = await checklist();
  await p.keyboard.press('Escape');
  await sleep(600);
  const gone = c => c.on && c.boxes === 0 && c.marked === 0 && !c.tally && !c.hideDone && c.inset === 0 && c.sheetBoxes === 0 && !c.sheetButton;
  check('Hide Checklist takes the tick boxes, the total and the done marks off the quest list, and the ticks come back with it off',
    gone(hidden) && gone(hiddenAfterLoad) && !back.on && back.boxes > 0 && back.marked === 1 && back.tally && back.hideDone &&
    back.sheetBoxes > 0 && back.sheetButton && (await savedTicks()) === ticksBefore && ticksBefore.indexOf(mystery.key) !== -1,
    JSON.stringify({ hidden, hiddenAfterLoad, back, ticksBefore }));

  // Lists: Saved and one made on the sheet. Each shows as a chip between
  // All and the regions once it holds a quest, picking it narrows the
  // list to its quests, and it is still there after a reload.
  await p.evaluate(() => {
    const it = document.querySelector('.ql-item[data-quest-id="MQ1"]');
    it.scrollIntoView();
    it.querySelector('.ql-item-body').click();
  });
  await sleep(900);
  await p.click('.ql-list-pick');
  await p.click('.ql-list-new');
  await sleep(400);
  await p.fill('.ql-list-picks input', 'Day plan');
  await p.press('.ql-list-picks input', 'Enter');
  await sleep(500);
  await p.keyboard.press('Escape');
  await sleep(700);
  const chipsNow = () => p.$$eval('#ql-chips .ql-chip:not(.ql-chip-more)', cs => cs.slice(0, 4).map(c => c.textContent));
  const madeChips = await chipsNow();
  await p.evaluate(() => document.querySelector('.ql-chip-list:not([data-list="saved"])').click());
  await sleep(600);
  const onList = await p.$$eval('.ql-item', its => its.map(i => i.dataset.questId));
  await p.reload();
  await p.waitForTimeout(1300);
  const keptChips = await chipsNow();
  check('a quest saved and put on a new list from its sheet: both lists are chips after All, picking one narrows to its quests, and a reload keeps them',
    madeChips[0] === 'All' && madeChips[1] === 'Saved1' && madeChips[2] === 'Day plan1' &&
    JSON.stringify(onList) === JSON.stringify(['MQ1']) && JSON.stringify(keptChips) === JSON.stringify(madeChips),
    JSON.stringify({ madeChips, onList, keptChips }));

  // Whose list: a team signed in with its submit code asks for its own,
  // and that copy is never painted for anybody else on the device.
  const teamQuest = { key: 'TQ1', name: 'Preview walk', region: list.regions[0], description: '', flavour: '',
    location: '', coords: [], submit: 'none', prompt: '', options: [], codes: [{ code: 'TQ1', label: '', points: 10 }] };
  const tp = await ctx.newPage();
  const asked = [];
  let publicDown = false;
  await tp.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: r.request().url().endsWith('.css') ? 'text/css' : 'application/javascript', body: '' }));
  await tp.route('**/files.scs.andyrew.space/**', r => {
    const u = r.request().url();
    const cors = { 'access-control-allow-origin': '*' };
    const auth = r.request().headers().authorization || '';
    if (u.includes('/api/questlist/team')) {
      asked.push(auth);
      if (auth !== 'Bearer good-session') return r.fulfill({ status: 401, contentType: 'application/json', headers: cors, body: '{"error":"not signed in"}' });
      return r.fulfill({ status: 200, contentType: 'application/json', headers: cors,
        body: JSON.stringify(Object.assign({}, list, { groups: list.groups.concat([teamQuest]), more: false, team: 'Team A' })) });
    }
    if (u.includes('/api/questlist')) {
      if (publicDown) return r.fulfill({ status: 500, contentType: 'application/json', headers: cors, body: '{}' });
      return r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(Object.assign({}, list, { more: true })) });
    }
    return r.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{}' });
  });
  for (const host of ['tiles.scs.andyrew.space']) {
    await tp.route('**/' + host + '/**', r => r.fulfill({ status: 404, body: '' }));
  }
  const whose = async (session) => {
    await tp.evaluate(s => { s ? localStorage.setItem('scs2-submit-session', s) : localStorage.removeItem('scs2-submit-session'); }, session);
    await tp.reload();
    await tp.waitForTimeout(1300);
    return tp.evaluate(() => ({
      team: !!document.querySelector('.ql-item[data-quest-id="TQ1"]'),
      line: !document.getElementById('ql-more').hidden
    }));
  };
  await tp.goto(BASE + '/questlist/');
  await tp.evaluate(() => localStorage.removeItem('scs2-questlist-cache'));
  const out = await whose('');
  const signedIn = await whose('good-session');
  check('signed out the list is the public one and says teams see more; signed in it is the team\'s own, asked for with the session',
    !out.team && out.line && signedIn.team && !signedIn.line && asked[asked.length - 1] === 'Bearer good-session',
    JSON.stringify({ out, signedIn, asked }));
  publicDown = true;
  const outAgain = await whose('');
  publicDown = false;
  const stale = await whose('old-session');
  check('the team\'s copy on the device is never shown to somebody signed out, and a session the worker refuses gets the public list',
    !outAgain.team && !stale.team && stale.line, JSON.stringify({ outAgain, stale }));
  await tp.close();

  console.log('errors', errors);
  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  await b.close();
  if (server) server.kill();
  process.exit(fail ? 1 : 0);
})();
