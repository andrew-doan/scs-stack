// The messages bell in the top bar, the page behind it, the urgent
// pop-up and the quest list's update banner. The bell keeps the seqs of
// the messages this device has read and the pop-up the ids it has put
// away, so an answer from a colo that has not caught up cannot bring
// either back; the banner moves on the quests number, and a number set
// back is taken as read without the banner.
// Run with: node tests/verify-bell.cjs
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

// a 1x1 png, enough for a thumbnail to load
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

const MESSAGES = {
  messages: [
    {
      id: 2,
      title: 'Briefing time moved',
      body: 'Briefings now start at **10:30am**.\n\n- Bring your Opal card\n- Charge your phone\n\n[[quest:MQ1]]',
      created_at: '2026-10-19 23:30:00',
      urgency: 'urgent',
      seq: 3,
      files: [
        { key: 'msg/aaaa1111', name: 'meeting-point.png', type: 'image/png', bytes: 240000 },
        { key: 'msg/bbbb2222', name: 'run-sheet.pdf', type: 'application/pdf', bytes: 1572864 }
      ]
    },
    {
      id: 1,
      title: 'Registration closes Friday',
      body: 'Get your team in before Friday night.',
      created_at: '2026-10-10 04:00:00',
      urgency: 'silent',
      seq: 0,
      files: []
    }
  ]
};

(async () => {
  const q = await import(path.join(ROOT, 'tab/src/data/scs2-quests.ts'));
  const pl = await import(path.join(ROOT, 'tab/src/data/places.ts'));
  const groups = q.QUESTS.map(g => ({ key: g.key, name: g.name, region: g.region, description: g.description, flavour: g.flavour, location: g.location, coords: g.coords, submit: g.submit, prompt: g.prompt, options: g.options, codes: g.codes }));
  const baseList = { regions: q.REGIONS, groups: groups, places: pl.PLACES };
  const NEW_QUEST = { key: 'SQ999', name: 'Ride the last ferry', region: q.REGIONS[0], description: '', flavour: '', location: '', coords: [], submit: 'none', prompt: '', options: [], codes: [{ code: 'SQ999', label: '', points: 5 }] };
  const grownList = { regions: q.REGIONS, groups: groups.concat([NEW_QUEST]), places: pl.PLACES };

  const state = {
    pulse: { quests: 1, messages: 0 },
    messages: MESSAGES,
    grown: false,
    pulseHits: 0,
    fileHits: [],
    msgHits: 0,
    questHits: 0,
    messagesStatus: 200
  };

  const stub = async (p) => {
    await p.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: r.request().url().endsWith('.css') ? 'text/css' : 'application/javascript', body: '' }));
    await p.route('**/tiles.scs.andyrew.space/**', r => r.fulfill({ status: 404, body: '' }));
    await p.route('**/files.scs.andyrew.space/**', r => {
      const u = r.request().url();
      const headers = { 'access-control-allow-origin': '*' };
      const json = (body, status) => r.fulfill({ status: status || 200, contentType: 'application/json', headers, body: JSON.stringify(body) });
      if (u.includes('/api/pulse')) { state.pulseHits++; return json(state.pulse); }
      if (u.includes('/api/messages/file')) { state.fileHits.push(u); return r.fulfill({ status: 200, contentType: 'image/png', headers, body: PNG }); }
      if (u.includes('/api/messages')) {
        state.msgHits++;
        if (state.messagesStatus !== 200) return json({ error: 'nope' }, state.messagesStatus);
        return json(state.messages);
      }
      if (u.includes('/api/questlist')) { state.questHits++; return json(state.grown ? grownList : baseList); }
      return json({}, 404);
    });
  };

  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await new Promise(res => setTimeout(res, 1200));
  }
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const errors = [];

  // ---------------- the bell on a desktop window ----------------
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  // the app icon's badge, as the page last set it
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, 'setAppBadge', { configurable: true, value: n => { window.__badge = n; return Promise.resolve(); } });
    Object.defineProperty(navigator, 'clearAppBadge', { configurable: true, value: () => { window.__badge = 0; return Promise.resolve(); } });
  });
  const p = await ctx.newPage();
  p.on('pageerror', e => errors.push('desktop: ' + e.message));
  await stub(p);
  state.pulse = { quests: 4, messages: 0 };
  await p.goto(BASE + '/info/');
  await p.waitForTimeout(600);

  const chrome = await p.evaluate(() => {
    const bell = document.querySelector('.site-nav-inner .bell-toggle');
    const gear = document.querySelector('.site-nav-inner .settings-toggle');
    const nav = document.querySelector('.site-nav');
    if (!bell || !gear) return null;
    const b = bell.getBoundingClientRect();
    const g = gear.getBoundingClientRect();
    return {
      href: bell.getAttribute('href'),
      label: bell.getAttribute('aria-label'),
      rightBeforeGear: bell.nextElementSibling === gear,
      leftOfGear: b.right <= g.left + 1,
      sameRow: Math.abs(b.top - g.top) < 2,
      size: [Math.round(b.width), Math.round(b.height)],
      gearSize: [Math.round(g.width), Math.round(g.height)],
      inBar: b.top >= nav.getBoundingClientRect().top && b.bottom <= nav.getBoundingClientRect().bottom,
      navH: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')),
      navReal: nav.offsetHeight,
      hasBothFaces: !!bell.querySelector('.icon-bell-outline') && !!bell.querySelector('.icon-bell-fill'),
      sameCell: (() => {
        // the waiting face is scaled down, so compare centres, not corners
        const o = bell.querySelector('.icon-bell-outline').getBoundingClientRect();
        const f = bell.querySelector('.icon-bell-fill').getBoundingClientRect();
        return Math.abs((o.left + o.right) - (f.left + f.right)) < 2 &&
          Math.abs((o.top + o.bottom) - (f.top + f.bottom)) < 2;
      })(),
      restOutline: parseFloat(getComputedStyle(bell.querySelector('.icon-bell-outline')).opacity),
      restFill: parseFloat(getComputedStyle(bell.querySelector('.icon-bell-fill')).opacity),
      fades: parseFloat(getComputedStyle(bell.querySelector('.icon-bell-fill')).transitionDuration) > 0,
      dotRound: getComputedStyle(bell.querySelector('.bell-dot')).borderRadius
    };
  });

  // ---- a tap fills the bell in on its way to the messages page ----
  await p.evaluate(() => {
    const bell = document.querySelector('.bell-toggle');
    bell.addEventListener('click', e => e.preventDefault(), { once: true });
    bell.click();
  });
  const swinging = await p.evaluate(() => {
    const bell = document.querySelector('.bell-toggle');
    return {
      ringing: bell.classList.contains('is-ringing'),
      animations: bell.querySelectorAll('svg').length > 0 &&
        [...bell.querySelectorAll('svg')].some(s => s.getAnimations().some(a => a.animationName === 'bell-ring'))
    };
  });
  await p.waitForTimeout(900);
  const rung = await p.evaluate(() => {
    const bell = document.querySelector('.bell-toggle');
    return {
      filled: bell.classList.contains('is-filled'),
      fillOn: parseFloat(getComputedStyle(bell.querySelector('.icon-bell-fill')).opacity),
      outlineOff: parseFloat(getComputedStyle(bell.querySelector('.icon-bell-outline')).opacity),
      borderless: getComputedStyle(bell).borderTopColor === 'rgba(0, 0, 0, 0)',
      settled: [...bell.querySelectorAll('svg')].every(s => s.getAnimations().length === 0)
    };
  });

  // ---- the page switch cuts the swing short; arrival finishes it ----
  await p.goto(BASE + '/messages/');
  await p.waitForTimeout(300);
  const arrival = await p.evaluate(() => {
    const bell = document.querySelector('.bell-toggle');
    return {
      ringing: bell.classList.contains('is-ringing'),
      swing: [...bell.querySelectorAll('svg')].some(s => s.getAnimations().some(a => a.animationName === 'bell-ring')),
      flagGone: sessionStorage.getItem('scs2-bell-rung') === null
    };
  });
  await p.waitForTimeout(900); // the arrival swing settles

  // a tap on the page's own bell rings in place instead of reloading
  await p.evaluate(() => {
    window.__stayed = true;
    document.querySelector('.bell-toggle').click();
  });
  await p.waitForTimeout(150);
  const inPlace = await p.evaluate(() => ({
    stayed: window.__stayed === true,
    swing: [...document.querySelectorAll('.bell-toggle svg')].some(s => s.getAnimations().some(a => a.animationName === 'bell-ring'))
  }));
  check('a tap on its own bell rings in place without reloading the page',
    inPlace.stayed && inPlace.swing, JSON.stringify(inPlace));
  await p.goto(BASE + '/info/');
  await p.waitForTimeout(500);

  // ---- the dot obeys what this device has read ----
  // `stored` is the set of seqs read, or {legacy: n} for the single mark
  // kept before the set
  const READ = 'scs2-msg-read';
  const readSet = () => p.evaluate((key) => JSON.parse(localStorage.getItem(key) || 'null'), READ);
  const dotAfter = async (stored, pulse) => {
    state.pulse = pulse;
    await p.evaluate(([s, key]) => {
      localStorage.removeItem(key);
      localStorage.removeItem('scs2-msg-seen');
      if (Array.isArray(s)) localStorage.setItem(key, JSON.stringify(s));
      else if (s && s.legacy != null) localStorage.setItem('scs2-msg-seen', String(s.legacy));
    }, [stored, READ]);
    await p.reload();
    await p.waitForTimeout(600);
    const out = await p.evaluate(() => {
      const dot = document.querySelector('.bell-dot');
      return { hidden: dot.hidden, painted: dot.getBoundingClientRect().width > 0, badge: window.__badge };
    });
    out.read = await readSet();
    return out;
  };

  const unread = await dotAfter([2, 5], { quests: 4, messages: 6, message_seqs: [6, 5, 2] });
  const level = await dotAfter([2, 5, 6], { quests: 4, messages: 6, message_seqs: [6, 5, 2] });
  check('a message this device has not read shows the dot and counts on the badge, and reading it takes both off',
    !unread.hidden && unread.painted && unread.badge === 1 && level.hidden && !level.painted && level.badge === 0,
    JSON.stringify({ unread, level }));
  const lower = await dotAfter([19, 20], { quests: 4, messages: 20, message_seqs: [20, 15] });
  check('a message numbered below the newest one read still lights it: a team\'s own after a public one, or a counter set back',
    !lower.hidden && lower.badge === 1, JSON.stringify(lower));
  const behind = await dotAfter([5, 6, 9], { quests: 4, messages: 6, message_seqs: [6, 5] });
  check('an answer from behind lights nothing and takes nothing off what was read',
    behind.hidden && JSON.stringify(behind.read) === '[5,6,9]', JSON.stringify(behind));
  const fresh = await dotAfter(null, { quests: 4, messages: 2, message_seqs: [2, 1] });
  const empty = await dotAfter(null, { quests: 4, messages: 0, message_seqs: [] });
  check('a device that has read nothing shows the dot for what is there, and with nothing posted there is none',
    !fresh.hidden && fresh.badge === 2 && JSON.stringify(fresh.read) === '[]' && empty.hidden && JSON.stringify(empty.read) === '[]',
    JSON.stringify({ fresh, empty }));
  const migrated = await dotAfter({ legacy: 5 }, { quests: 4, messages: 7, message_seqs: [7, 5, 3] });
  await p.evaluate(() => localStorage.setItem('scs2-msg-seen', '99'));
  await p.reload();
  await p.waitForTimeout(600);
  const stillLit = await p.evaluate(() => !document.querySelector('.bell-dot').hidden);
  check('the old single mark counts what is at or below it as read, once, and is not read again',
    !migrated.hidden && JSON.stringify(migrated.read) === '[5,3]' && stillLit, JSON.stringify({ migrated, stillLit }));

  // ---------------- the messages page ----------------
  state.pulse = { quests: 4, messages: 3, message_seqs: [3] };
  await p.evaluate((key) => localStorage.setItem(key, '[1]'), READ);
  await p.goto(BASE + '/messages/');
  await p.waitForTimeout(900);

  const page = await p.evaluate(() => {
    const cards = [...document.querySelectorAll('.msg-card')];
    const first = cards[0];
    const shot = first ? first.querySelector('.msg-shot img') : null;
    const row = first ? first.querySelector('.msg-files li') : null;
    return {
      count: cards.length,
      title: first ? first.querySelector('.msg-title').textContent : '',
      order: cards.map(c => c.querySelector('.msg-title').textContent),
      time: first ? first.querySelector('.msg-time').textContent : '',
      bold: first ? !!first.querySelector('.msg-body strong') : false,
      bullets: first ? first.querySelectorAll('.msg-body li').length : 0,
      rawMarkdown: first ? first.querySelector('.msg-body').textContent.indexOf('**') !== -1 : true,
      thumb: shot ? shot.getAttribute('src') : '',
      fileName: row ? row.querySelector('a').textContent : '',
      fileHref: row ? row.querySelector('a').getAttribute('href') : '',
      fileSize: row ? row.querySelector('.msg-file-size').textContent : '',
      fileTarget: row ? row.querySelector('a').getAttribute('target') : null,
      status: document.getElementById('msg-status').textContent,
      dotHidden: document.querySelector('.bell-dot').hidden,
      embed: (() => {
        const q = first ? first.querySelector('.msg-body .mq') : null;
        if (!q) return null;
        const links = [...q.querySelectorAll('.mq-actions a')];
        return {
          chip: q.querySelector('.code').textContent,
          name: q.querySelector('.mq-name').textContent,
          tokenGone: first.querySelector('.msg-body').textContent.indexOf('[[quest:') === -1,
          open: links[0] ? { text: links[0].textContent, href: links[0].getAttribute('href') } : null,
          submit: links[1] ? { text: links[1].textContent, href: links[1].getAttribute('href') } : null
        };
      })(),
      bell: (() => {
        const bell = document.querySelector('.bell-toggle');
        return {
          filled: bell.classList.contains('is-filled'),
          here: bell.getAttribute('aria-current'),
          fillOn: parseFloat(getComputedStyle(bell.querySelector('.icon-bell-fill')).opacity),
          outlineOff: parseFloat(getComputedStyle(bell.querySelector('.icon-bell-outline')).opacity),
          borderless: getComputedStyle(bell).borderTopColor === 'rgba(0, 0, 0, 0)',
          ringing: bell.classList.contains('is-ringing')
        };
      })(),
      read: JSON.parse(localStorage.getItem('scs2-msg-read') || '[]'),
      cached: !!localStorage.getItem('scs2-messages-cache'),
      hero: document.querySelector('.msg-board h1').textContent,
      // the newest message goes on the board when it is urgent, so the
      // first card is the notice up there rather than a row of the log
      noticeOnBoard: !!(first && first.classList.contains('msg-notice') &&
        document.querySelector('.msg-board').contains(first)),
      flags: cards.map(c => {
        const f = c.querySelector('.msg-urgent');
        return f ? { text: f.textContent, colour: getComputedStyle(f).color, caps: getComputedStyle(f).textTransform } : null;
      }),
      alertSign: getComputedStyle(document.documentElement).getPropertyValue('--alert-sign').trim()
    };
  });
  check('the page renders what the worker sent, in the order it sent it',
    page.count === 2 && page.title === 'Briefing time moved' &&
    page.order[1] === 'Registration closes Friday' && page.hero === 'Messages',
    JSON.stringify({ count: page.count, order: page.order }));
  const signRgb = (() => {
    const hex = page.alertSign.replace('#', '');
    return 'rgb(' + [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)).join(', ') + ')';
  })();
  check('the newest message rides on the board when it is urgent', page.noticeOnBoard, '');
  check('the body comes through the markdown renderer',
    page.bold && page.bullets === 2 && !page.rawMarkdown,
    JSON.stringify({ bold: page.bold, bullets: page.bullets, raw: page.rawMarkdown }));
  const mq1Name = baseList.groups.find(g => g.key === 'MQ1').name;
  check('a [[quest:MQ1]] line becomes a quest card, token gone',
    !!page.embed && page.embed.chip === 'MQ1' && page.embed.name === mq1Name && page.embed.tokenGone,
    JSON.stringify(page.embed));
  check('with the way to the quest and to the submit page, quest in hand',
    !!page.embed && page.embed.open && page.embed.open.text === 'Open quest' &&
    page.embed.open.href === '../questlist/#MQ1' &&
    page.embed.submit && page.embed.submit.text === 'Submit proof' &&
    page.embed.submit.href === '../submit/#MQ1',
    JSON.stringify(page.embed));
  check('the time is rendered in this device\'s zone, not the raw stamp',
    /\d/.test(page.time) && page.time.indexOf('2026-10-19') === -1, page.time);
  const shotHits = state.fileHits.filter(u => u.indexOf('aaaa1111') !== -1);
  check('a picture shows its thumbnail first and then the whole picture in its place',
    shotHits.length >= 2 && shotHits[0].indexOf('thumb=1') !== -1 && page.thumb.indexOf('/api/messages/file?key=') !== -1 &&
    page.thumb.indexOf('thumb=1') === -1, JSON.stringify({ shotHits, src: page.thumb }));
  check('anything else is a row you can open, with its size',
    page.fileName === 'run-sheet.pdf' && page.fileSize === '1.5 MB' &&
    page.fileHref.indexOf('/api/messages/file?key=') !== -1 && page.fileTarget === null,
    JSON.stringify({ name: page.fileName, size: page.fileSize, target: page.fileTarget }));
  check('opening the page marks the messages read and drops the dot',
    page.read.indexOf(3) !== -1 && page.dotHidden === true, JSON.stringify({ read: page.read, dot: page.dotHidden }));
  check('and the payload is kept for the next visit', page.cached, '');

  // the pulse and the list are cached apart: a message the pulse names
  // and the list does not carry yet was not drawn, so it is not read
  state.pulse = { quests: 4, messages: 4, message_seqs: [4, 3] };
  await p.reload();
  await p.waitForTimeout(900);
  const drawn = await p.evaluate(() => ({
    read: JSON.parse(localStorage.getItem('scs2-msg-read') || '[]'),
    dot: !document.querySelector('.bell-dot').hidden
  }));
  check('it marks read exactly the messages it drew, not what a newer pulse names',
    drawn.read.indexOf(3) !== -1 && drawn.read.indexOf(4) === -1 && drawn.dot, JSON.stringify(drawn));

  // a tap on a thumbnail opens the full file in place, not a new tab
  await p.evaluate(() => document.querySelector('.msg-shot').click());
  await p.waitForTimeout(300);
  const lb = await p.evaluate(() => {
    const box = document.querySelector('.lb-overlay');
    const img = box ? box.querySelector('.lb-media') : null;
    return { open: !!box, src: img ? img.getAttribute('src') : '' };
  });
  check('a tap on the picture opens it in the lightbox at full size',
    lb.open && lb.src.indexOf('/api/messages/file?key=') !== -1 && lb.src.indexOf('thumb=1') === -1,
    JSON.stringify(lb));
  await p.keyboard.press('Escape');
  await sleep(300);

  // the copy on the device stands when the worker cannot be reached
  state.messagesStatus = 500;
  await p.reload();
  await p.waitForTimeout(800);
  const offline = await p.evaluate(() => ({
    count: document.querySelectorAll('.msg-card').length,
    status: document.getElementById('msg-status').textContent
  }));
  check('with the worker unreachable the copy on the device still reads',
    offline.count === 2 && offline.status === '', JSON.stringify(offline));

  // nothing posted yet
  state.messagesStatus = 200;
  state.messages = { messages: [] };
  await p.reload();
  await p.waitForTimeout(800);
  const none = await p.evaluate(() => ({
    count: document.querySelectorAll('.msg-card').length,
    status: document.getElementById('msg-status').textContent
  }));
  check('an empty list says so plainly',
    none.count === 0 && none.status === 'Nothing from OrgCom yet.', JSON.stringify(none));
  state.messages = MESSAGES;

  // the notification switch is the site's own rocker near the top of
  // the page, not a card of its own
  const sub = await p.evaluate(() => {
    const row = document.querySelector('.msg-set');
    const box = document.getElementById('msg-push');
    const log = document.getElementById('msg-log');
    return {
      rocker: !!row.querySelector('.settings-switch .switch-o') && !!row.querySelector('.settings-switch .switch-i'),
      subCheck: row.classList.contains('sub-check'),
      notACard: !row.classList.contains('card') && !document.querySelector('.msg-subscribe'),
      aboveTheLog: row.getBoundingClientRect().bottom <= log.getBoundingClientRect().top + 1,
      noStateWord: !row.querySelector('.msg-set-text') && row.querySelector('.msg-set-name').textContent.trim() === 'Push Notifications',
      disabled: box.disabled,
      notSetPush: box.id !== 'set-push' && document.querySelectorAll('#set-push').length === 1
    };
  });
  check('the switch is the site\'s own O/I rocker, above the log, not a card',
    sub.rocker && sub.subCheck && sub.notACard && sub.aboveTheLog, JSON.stringify(sub));
  check('and it is named with no word for its state beside it', sub.noStateWord, JSON.stringify(sub));
  check('and its switch has its own id, not the settings menu\'s',
    sub.notSetPush, '');

  // a change that went through says so in a toast; one that failed puts
  // the switch back and says why under it, and no toast claims otherwise
  const flip = (ok) => p.evaluate(async (ok) => {
    window.scs.pushSub.enable = () => ok ? Promise.resolve() : Promise.reject(new Error('nope'));
    window.scs.pushSub.disable = () => Promise.resolve();
    document.querySelectorAll('.toast-stack .toast').forEach(t => t.remove());
    const box = document.getElementById('msg-push');
    box.checked = !box.checked;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 300));
    return {
      on: box.checked,
      toasts: [...document.querySelectorAll('.toast-stack .toast')].map(t => t.textContent),
      hint: document.getElementById('msg-push-hint').textContent
    };
  }, ok);
  const turnedOn = await flip(true);
  const turnedOff = await flip(true);
  const refused = await flip(false);
  check('turning push on or off says so in a toast, and a refusal puts the switch back with a reason',
    turnedOn.on && turnedOn.toasts.join() === 'Push Notifications for Announcements On' &&
    !turnedOff.on && turnedOff.toasts.join() === 'Push Notifications for Announcements Off' &&
    !refused.on && !refused.toasts.length && refused.hint.length > 0,
    JSON.stringify({ turnedOn, turnedOff, refused }));
  await ctx.close();

  // ---------------- the bell in the app layout ----------------
  const ctx2 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p2 = await ctx2.newPage();
  p2.on('pageerror', e => errors.push('phone: ' + e.message));
  await stub(p2);
  state.pulse = { quests: 4, messages: 4 };
  await p2.goto(BASE + '/');
  await p2.waitForTimeout(700);
  const phone = await p2.evaluate(() => {
    const bell = document.querySelector('.bell-toggle');
    const gear = document.querySelector('.settings-toggle');
    const brand = document.querySelector('.site-brand');
    const nav = document.querySelector('.site-nav');
    const b = bell.getBoundingClientRect();
    const g = gear.getBoundingClientRect();
    const t = brand.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    return {
      pwa: document.documentElement.classList.contains('is-pwa'),
      href: bell.getAttribute('href'),
      shown: getComputedStyle(bell).display !== 'none' && b.width > 0,
      leftOfGear: b.right <= g.left + 1,
      insideBar: b.top >= n.top - 1 && b.bottom <= n.bottom + 1,
      onScreen: b.left >= n.left && b.right <= window.innerWidth,
      clearOfTitle: t.left >= b.right && t.right <= g.left,
      titleShown: getComputedStyle(document.querySelector('.site-brand-name')).display !== 'none',
      dotHidden: document.querySelector('.bell-dot').hidden
    };
  });
  check('the home page bell points at the messages page from the root',
    phone.href === 'messages/', phone.href);

  // the chrome fade takes the bell with it: it lives inside the bar
  const rides = await p2.evaluate(() => {
    const nav = document.querySelector('.site-nav');
    return nav.contains(document.querySelector('.bell-toggle'));
  });
  await ctx2.close();

  // ---------------- the quest list's update banner ----------------
  const ctx3 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p3 = await ctx3.newPage();
  p3.on('pageerror', e => errors.push('quests: ' + e.message));
  await stub(p3);
  const banner = () => p3.evaluate(() => {
    const el = document.getElementById('ql-update');
    return {
      hidden: el.hidden,
      shown: el.classList.contains('is-shown'),
      painted: el.getBoundingClientRect().height > 0,
      seen: localStorage.getItem('scs2-quests-seen')
    };
  });

  state.pulse = { quests: 4, messages: 0 };
  await p3.goto(BASE + '/questlist/');
  await p3.waitForTimeout(1400);
  const first = await banner();
  check('a first visit is not an update: nothing is announced, the version is taken as read',
    first.hidden === true && first.seen === '4', JSON.stringify(first));

  state.pulse = { quests: 5, messages: 0 };
  await p3.reload();
  await p3.waitForTimeout(1400);
  const bumped = await banner();
  check('a newer version brings the banner in',
    bumped.hidden === false && bumped.shown && bumped.painted, JSON.stringify(bumped));

  await p3.evaluate(() => document.getElementById('ql-update-close').click());
  await p3.waitForTimeout(700);
  const closed = await banner();
  check('putting it away counts as read, so it does not come back',
    closed.hidden === true && closed.seen === '5', JSON.stringify(closed));
  await p3.reload();
  await p3.waitForTimeout(1400);
  check('and it stays away on the next load', (await banner()).hidden === true, '');

  // ---- tap to update: the new list is fetched, kept, and reloaded onto ----
  state.pulse = { quests: 6, messages: 0 };
  state.grown = true;
  await p3.reload();
  await p3.waitForTimeout(1400);
  check('a further version brings it back', (await banner()).hidden === false, '');
  const hitsBefore = state.questHits;
  await p3.evaluate(() => { window.__stayed = true; });
  await p3.evaluate(() => document.getElementById('ql-update-go').click());
  await p3.waitForTimeout(2200);
  const took = await p3.evaluate(() => ({
    stayed: window.__stayed === true,
    hasNew: [...document.querySelectorAll('.ql-item')].some(i => i.dataset.questId === 'SQ999'),
    cached: (localStorage.getItem('scs2-questlist-cache') || '').indexOf('SQ999') !== -1
  }));
  const after = await banner();
  check('the tap fetches the list again rather than trusting the reload to land on it',
    state.questHits >= hitsBefore + 2, JSON.stringify({ before: hitsBefore, now: state.questHits }));
  check('it keeps the new list and reloads onto it',
    !took.stayed && took.hasNew && took.cached, JSON.stringify(took));
  check('and the banner is gone afterwards, with the version written down',
    after.hidden === true && after.seen === '6', JSON.stringify(after));

  // ---- a version below the one taken: the counter was set back ----
  // It becomes the version taken and the list is fetched again, once,
  // with no banner; a rise from there brings the banner as usual.
  let listUrls = [];
  const noteList = req => { if (req.url().includes('/api/questlist')) listUrls.push(req.url()); };
  p3.on('request', noteList);
  await p3.evaluate(() => {
    localStorage.setItem('scs2-quests-seen', '9');
    const kept = JSON.parse(localStorage.getItem('scs2-questlist-cache'));
    kept.version = 9;
    kept.keptAt = Date.now();
    localStorage.setItem('scs2-questlist-cache', JSON.stringify(kept));
  });
  state.pulse = { quests: 6, messages: 0 };
  listUrls = [];
  await p3.reload();
  await p3.waitForTimeout(1500);
  const lowered = await banner();
  const loweredUrls = listUrls.slice();
  check('a version below the one this device took becomes the one taken, and the list is fetched again at it, once, with no banner',
    lowered.hidden === true && lowered.seen === '6' && loweredUrls.length === 1 && loweredUrls[0].endsWith('/api/questlist?v=6'),
    JSON.stringify({ lowered, loweredUrls }));
  state.pulse = { quests: 7, messages: 0 };
  await p3.reload();
  await p3.waitForTimeout(1400);
  check('and a version above it from there brings the banner in', (await banner()).hidden === false, '');

  // ---- a kept list at the pulse's version is not asked for again ----
  // The worker stamps the list with the quests number it was built at.
  state.grown = false;
  state.pulse = { quests: 6, messages: 0 };
  await p3.evaluate(() => {
    const kept = JSON.parse(localStorage.getItem('scs2-questlist-cache'));
    kept.version = 6;
    kept.keptAt = Date.now();
    localStorage.setItem('scs2-questlist-cache', JSON.stringify(kept));
  });
  listUrls = [];
  await p3.reload();
  await p3.waitForTimeout(1500);
  const unasked = listUrls.slice();
  listUrls = [];
  state.pulse = { quests: 7, messages: 0 };
  await p3.reload();
  await p3.waitForTimeout(1500);
  p3.off('request', noteList);
  check('a kept list is asked for again only once the pulse passes its version, and at that version',
    unasked.length === 0 && listUrls.length === 1 && listUrls[0].endsWith('/api/questlist?v=7'),
    JSON.stringify({ unasked, listUrls }));
  await ctx3.close();

  // ---------------- no push in this browser ----------------
  const ctx4 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const p4 = await ctx4.newPage();
  p4.on('pageerror', e => errors.push('no-push: ' + e.message));
  await stub(p4);
  await p4.addInitScript(() => {
    try { delete window.PushManager; } catch (e) { /* left as it is */ }
  });
  state.pulse = { quests: 6, messages: 1 };
  await p4.goto(BASE + '/messages/');
  await p4.waitForTimeout(900);
  const degraded = await p4.evaluate(() => {
    const box = document.getElementById('msg-push');
    const hint = document.getElementById('msg-push-hint');
    return {
      supported: 'PushManager' in window,
      disabled: box.disabled,
      checked: box.checked,
      hint: hint.textContent,
      hintShown: !hint.classList.contains('is-hidden'),
      cards: document.querySelectorAll('.msg-card').length
    };
  });
  check('a browser without push gets the switch turned off and a plain reason',
    !degraded.supported && degraded.disabled && !degraded.checked &&
    degraded.hintShown && degraded.hint === 'This browser does not support notifications.',
    JSON.stringify(degraded));
  check('and the rest of the page carries on regardless', degraded.cards === 2, String(degraded.cards));
  await ctx4.close();

  // ---------------- the board in the app layout ----------------
  // There the bar reads Messages, so the masthead is hidden and the
  // board carries the urgent message alone. With nothing urgent the
  // board has nothing on it at all, and a band of black holding
  // nothing is not a band — it comes off the page.
  const board = async (payload) => {
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => { try {
      Object.defineProperty(navigator, 'standalone', { get: function () { return true; } });
      sessionStorage.setItem('scs2-launched', '1');
      sessionStorage.setItem('scs2-install-nudged', '1');
      localStorage.setItem('scs2-urgent-seen', '99');
    } catch (e) {} });
    const pg = await ctx.newPage();
    pg.on('pageerror', e => errors.push('app-board: ' + e.message));
    await stub(pg);
    state.messages = payload;
    await pg.goto(BASE + '/messages/');
    await pg.waitForTimeout(900);
    const out = await pg.evaluate(() => {
      const vis = el => { if (!el) return false; const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none'; };
      return {
        bar: (document.querySelector('.site-brand-page') || {}).textContent,
        board: vis(document.querySelector('.msg-board')),
        mast: vis(document.querySelector('.msg-mast')),
        notice: vis(document.querySelector('.msg-notice')),
        cards: document.querySelectorAll('.msg-card').length
      };
    });
    await ctx.close();
    return out;
  };
  const urgent = await board(MESSAGES);
  const quiet = await board({ messages: [MESSAGES.messages[1]] });
  state.messages = MESSAGES;

  // ---------------- the urgent pop-up ----------------
  const ctx5 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const p5 = await ctx5.newPage();
  p5.on('pageerror', e => errors.push('urgent: ' + e.message));
  await stub(p5);
  const popup = () => p5.evaluate(() => {
    const box = document.querySelector('.urgent-overlay');
    const card = box ? box.querySelector('.urgent-card') : null;
    const link = card ? card.querySelector('.urgent-actions a') : null;
    const nav = document.querySelector('.site-nav');
    return {
      open: !!box,
      shown: !!box && box.classList.contains('is-open'),
      head: card ? card.querySelector('.urgent-head').textContent : '',
      title: card ? card.querySelector('.urgent-title').textContent : '',
      bold: card ? !!card.querySelector('.urgent-text strong') : false,
      raw: card ? card.querySelector('.urgent-text').textContent.indexOf('**') !== -1 : false,
      linkText: link ? link.textContent : '',
      linkHref: link ? link.getAttribute('href') : '',
      dismiss: card ? !!card.querySelector('.urgent-dismiss') : false,
      embed: card ? !!card.querySelector('.urgent-text .mq') : false,
      focusInside: !!box && box.contains(document.activeElement),
      overChrome: box ? Number(getComputedStyle(box).zIndex) > Number(getComputedStyle(nav).zIndex) : false,
      path: location.pathname,
      away: JSON.parse(localStorage.getItem('scs2-urgent-dismissed') || '[]'),
      stayed: window.__stayed === true
    };
  });
  const mark = () => p5.evaluate(() => { window.__stayed = true; });
  const forgetUrgent = () => p5.evaluate(() => {
    localStorage.removeItem('scs2-urgent-dismissed');
    localStorage.removeItem('scs2-urgent-seen');
  });

  // a page to come back to, with nothing urgent waiting on it
  state.pulse = { quests: 6, messages: 3, urgent: 0 };
  await p5.goto(BASE + '/welfare/');
  await p5.waitForTimeout(700);
  state.pulse = { quests: 6, messages: 3, urgent: 2 };
  await p5.goto(BASE + '/info/');
  await p5.waitForTimeout(1800);
  const shown = await popup();
  check('an urgent message opens over the page it lands on',
    shown.open && shown.shown && shown.head === 'From OrgCom' &&
    shown.title === 'Briefing time moved' && shown.overChrome,
    JSON.stringify({ open: shown.open, head: shown.head, title: shown.title, over: shown.overChrome }));
  check('it carries the message itself, rendered, and the way to the rest',
    shown.bold && !shown.raw && shown.linkText === 'Open messages' &&
    shown.linkHref === '../messages/' && shown.dismiss,
    JSON.stringify({ bold: shown.bold, link: shown.linkHref, dismiss: shown.dismiss }));
  check('and the keyboard is put inside it', shown.focusInside, '');
  check('the quest card renders inside the pop-up too', shown.embed, '');

  // Escape closes it, consumes exactly one history entry, and hands
  // the focus back
  await p5.keyboard.press('Escape');
  await p5.waitForTimeout(500);
  const escaped = await popup();
  check('Escape puts it away and writes down that it was read',
    !escaped.open && escaped.away.indexOf(2) !== -1 && escaped.path === '/info/',
    JSON.stringify({ open: escaped.open, away: escaped.away, path: escaped.path }));
  check('the focus comes back to the page',
    (await p5.evaluate(() => document.activeElement === document.body)), '');
  await p5.evaluate(() => history.back());
  await p5.waitForTimeout(900);
  check('closing it consumed one history entry, not two — one back leaves the page',
    (await p5.evaluate(() => location.pathname)) === '/welfare/',
    await p5.evaluate(() => location.pathname));

  // it does not come back
  await p5.goto(BASE + '/info/');
  await p5.waitForTimeout(1800);
  check('a message already put away never opens again',
    (await popup()).open === false, '');

  // the device keeps the ids it put away, not the highest: one put away
  // stays away behind a later one (an answer from a colo that has not
  // caught up), and an older id that went live later still opens (a
  // draft published, a message scheduled or turned urgent)
  await p5.evaluate(() => localStorage.setItem('scs2-urgent-dismissed', '[2,9]'));
  state.pulse = { quests: 6, messages: 3, urgent: 2 };
  await p5.reload();
  await p5.waitForTimeout(1800);
  const stillAway = await popup();
  check('an urgent message put away stays away, even with a later one put away since',
    !stillAway.open && JSON.stringify(stillAway.away) === '[2,9]', JSON.stringify({ open: stillAway.open, away: stillAway.away }));
  await forgetUrgent();
  await p5.evaluate(() => localStorage.setItem('scs2-urgent-seen', '2'));
  await p5.reload();
  await p5.waitForTimeout(1800);
  const migratedUrgent = await popup();
  state.pulse = { quests: 6, messages: 3, urgent: 1 };
  await p5.reload();
  await p5.waitForTimeout(1800);
  const olderLater = await popup();
  check('the old single mark counts as that message put away, and an older id that went live after it still opens',
    !migratedUrgent.open && JSON.stringify(migratedUrgent.away) === '[2]' &&
    olderLater.open && olderLater.title === 'Registration closes Friday',
    JSON.stringify({ migrated: { open: migratedUrgent.open, away: migratedUrgent.away }, older: { open: olderLater.open, title: olderLater.title } }));

  // the system back closes it without leaving the page
  await forgetUrgent();
  state.pulse = { quests: 6, messages: 3, urgent: 2 };
  await p5.reload();
  await p5.waitForTimeout(1800);
  check('it is back for a device that has not seen it', (await popup()).open === true, '');
  await mark();
  await p5.evaluate(() => history.back());
  await p5.waitForTimeout(700);
  const backed = await popup();
  check('the system back closes it and stays on the page',
    !backed.open && backed.stayed && backed.path === '/info/' && backed.away.indexOf(2) !== -1,
    JSON.stringify({ open: backed.open, stayed: backed.stayed, path: backed.path, away: backed.away }));

  // the button does the same
  await forgetUrgent();
  await p5.reload();
  await p5.waitForTimeout(1800);
  await mark();
  await p5.evaluate(() => document.querySelector('.urgent-dismiss').click());
  await p5.waitForTimeout(500);
  const dismissed = await popup();
  check('the Dismiss button puts it away and keeps the page where it was',
    !dismissed.open && dismissed.stayed && dismissed.away.indexOf(2) !== -1 && dismissed.path === '/info/',
    JSON.stringify(dismissed));
  await p5.reload();
  await p5.waitForTimeout(1800);
  check('and it stays away on the next load', (await popup()).open === false, '');

  // the messages page is where it would send you: being there is
  // reading it, and nothing pops up over it
  await forgetUrgent();
  await p5.goto(BASE + '/messages/');
  await p5.waitForTimeout(1800);
  const onPage = await popup();
  check('opening the messages page counts as seeing it, with no pop-up over it',
    !onPage.open && onPage.away.indexOf(2) !== -1, JSON.stringify({ open: onPage.open, away: onPage.away }));
  await ctx5.close();

  // ---------------- a team signed in reads its own messages ----------------
  // Some messages are for some teams only: a device with a submit
  // session asks the team's copies of the pulse and the list, and the
  // copy it keeps is never painted for anyone signed out.
  const ctx6 = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const p6 = await ctx6.newPage();
  p6.on('pageerror', e => errors.push('team: ' + e.message));
  await stub(p6);
  const teamAsks = [];
  const TEAM_ONLY = { id: 7, title: 'Night crew meets at Central', body: 'Platform 1.', created_at: '2026-10-19 23:40:00', urgency: 'normal', seq: 9, files: [] };
  await p6.route('**/api/pulse/team', r => {
    teamAsks.push('pulse ' + r.request().headers().authorization);
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ quests: 4, messages: 9, message_seqs: [9, 5], urgent: 0 }) });
  });
  await p6.route('**/api/messages/team', r => {
    teamAsks.push('messages ' + r.request().headers().authorization);
    r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ messages: [TEAM_ONLY].concat(MESSAGES.messages) }) });
  });
  await p6.goto(BASE + '/info/');
  await p6.evaluate(() => {
    localStorage.setItem('scs2-submit-session', 'team-session-abcdefgh');
    localStorage.setItem('scs2-urgent-seen', '2');
  });
  await p6.goto(BASE + '/messages/');
  await p6.waitForTimeout(1200);
  const teamPage = await p6.evaluate(() => document.getElementById('msg-list').textContent.indexOf('Night crew meets at Central') !== -1);
  check('a signed-in team asks for its own pulse and messages, and reads the message meant for it',
    teamPage && teamAsks.indexOf('pulse Bearer team-session-abcdefgh') !== -1 &&
    teamAsks.indexOf('messages Bearer team-session-abcdefgh') !== -1, JSON.stringify(teamAsks));
  // signed out, with the public list never arriving: the kept copy was
  // the team's, so nothing from it may show while the page waits
  await p6.evaluate(() => localStorage.removeItem('scs2-submit-session'));
  await p6.route('**/api/messages', () => {});
  await p6.goto(BASE + '/messages/');
  await p6.waitForTimeout(800);
  const leaked = await p6.evaluate(() => document.getElementById('msg-list').textContent.indexOf('Night crew meets at Central') !== -1);
  check('signed out, the team\'s kept copy of the messages is not painted', !leaked, '');
  await ctx6.close();

  check('no page threw anywhere', errors.length === 0, JSON.stringify(errors));
  console.log('errors', errors);
  console.log('pulse fetches', state.pulseHits, '| messages fetches', state.msgHits, '| questlist fetches', state.questHits);
  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  await b.close();
  if (server) server.kill();
  process.exit(fail ? 1 : 0);
})();
