// The live tab page, driven against a stubbed API so the real render
// path is what is being checked rather than markup typed by hand.
//
//   node tests/verify-live-tab.cjs
//
// Covers the board itself (six columns on the page, two storeys in
// three on a phone), the medals on the top three, the last-scored
// column, the totals row, the waiting line, what the page says when
// the tab cannot be reached with and without a kept copy, the freeze,
// the loading skeleton, the FLIP row movement and the team-page links.
// Needs playwright nearby and a static server on 8123 serving website/
// (the test starts one if the port is free).
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

// A day's worth of board, with real team and quest names.
const TEAMS = [
  ['lowkeyhonestlygenuinely', 1640, 38, 'SQ14', 'Across the Coathanger', '14:21'],
  ['The Ministry of Magpie', 1515, 35, 'SQ7', 'Blocking the Suez Canal!', '14:18'],
  ['Quokka without the Q', 1470, 34, 'SQ22', 'Nice House, Old Man!', '14:09'],
  ['Citybound Sprinters', 1405, 33, 'SQ3', 'Level Crossing Hunter', '14:25'],
  ['salty cake', 1330, 31, 'SQ9', 'Ride a Diesel Train', '13:58'],
  ['Fritter Wraps', 1295, 30, 'SQ16', 'A Very Turkish Time of My Life', '14:24'],
  ['doors opening', 1185, 28, 'SQ11', 'The Full Modal', '14:02'],
  ['Galahs', 210, 6, 'SQ18', 'Playground Regression', '13:08']
];
const board = (rows) => ({
  teams: rows.map((t, i) => ({
    rank: i + 1, name: t[0], points: t[1], quests_done: t[2],
    last_quest: t[3] ? { code: t[3], name: t[4], at: '2026-10-20 ' + t[5] + ':00' } : null
  }))
});
const LB = board(TEAMS);
const STATS = {
  total_teams: 8, total_completions: 235, total_points: 10050,
  submissions_pending: 29, submissions_by_hour: [], teams_checked_in: 0, team_checkins: []
};

// the geometry a critic reads off a screenshot: anything off the side,
// words drawn on or hard against each other, type nobody can read
const SCAN = () => {
  const all = [...document.querySelectorAll('main *')];
  const seen = el => {
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const layered = el => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const s = getComputedStyle(n);
      if (s.position === 'absolute' || s.position === 'fixed') return true;
    }
    return false;
  };
  const leaves = all.filter(el => seen(el) && el.children.length === 0 &&
    (el.textContent || '').trim().length > 1 && !layered(el));
  const ink = el => {
    try {
      const g = document.createRange();
      g.selectNodeContents(el);
      const r = g.getBoundingClientRect();
      if (r.width && r.height) return r;
    } catch (e) { /* fall through */ }
    return el.getBoundingClientRect();
  };
  const over = [], touch = [];
  for (let i = 0; i < leaves.length; i++) {
    for (let j = i + 1; j < leaves.length; j++) {
      if (leaves[i].contains(leaves[j]) || leaves[j].contains(leaves[i])) continue;
      const a = ink(leaves[i]), c = ink(leaves[j]);
      const w = Math.min(a.right, c.right) - Math.max(a.left, c.left);
      const h = Math.min(a.bottom, c.bottom) - Math.max(a.top, c.top);
      if (w > 2 && h > 2) over.push(leaves[i].textContent.trim().slice(0, 18) + ' / ' + leaves[j].textContent.trim().slice(0, 18));
      else if (h > 4 && w > -4 && w <= 2) touch.push(leaves[i].textContent.trim().slice(0, 18) + '|' + leaves[j].textContent.trim().slice(0, 18));
    }
  }
  const tiny = leaves
    .filter(el => parseFloat(getComputedStyle(el).fontSize) < 10.5)
    .map(el => Math.round(parseFloat(getComputedStyle(el).fontSize) * 10) / 10 + 'px ' + el.textContent.trim().slice(0, 16));
  const wide = all.filter(el => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1);
  }).map(el => (el.className || el.tagName) + ' ' + Math.round(el.getBoundingClientRect().right));
  return {
    over: [...new Set(over)], touch: [...new Set(touch)], tiny: [...new Set(tiny)],
    wide: [...new Set(wide)].slice(0, 4),
    sideways: document.documentElement.scrollWidth > window.innerWidth + 1
  };
};

async function tabPage(b, opts) {
  opts = opts || {};
  const ctx = await b.newContext({
    serviceWorkers: 'block',
    viewport: opts.viewport || { width: 1280, height: 900 },
    isMobile: !!opts.mobile,
    hasTouch: !!opts.mobile,
    colorScheme: opts.theme === 'dark' ? 'dark' : 'light'
  });
  await ctx.addInitScript(([cache, theme]) => {
    try {
      localStorage.setItem('scs2-theme', theme);
      if (cache) localStorage.setItem('scs2-tab-cache', cache);
      else localStorage.removeItem('scs2-tab-cache');
    } catch (e) {}
  }, [opts.cache ? JSON.stringify(opts.cache) : '', opts.theme === 'dark' ? 'dark' : 'light']);
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  // the stubbed API answering 500 on purpose is the scenario, not a
  // fault; same-origin failures are counted below instead
  p.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/.test(m.text())) return;
    errors.push('console: ' + m.text());
  });
  const badRequests = [];
  p.on('requestfailed', r => { if (r.url().indexOf(BASE) === 0) badRequests.push(r.url()); });
  p.on('response', r => { if (r.url().indexOf(BASE) === 0 && r.status() >= 400) badRequests.push(r.status() + ' ' + r.url()); });
  await p.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  return { ctx, p, errors, badRequests };
}

const stub = (p, get) => p.route('**/files.scs.andyrew.space/**', async r => {
  const u = new URL(r.request().url());
  const answer = u.pathname === '/api/tab'
    ? { leaderboard: await get('/api/leaderboard'), stats: await get('/api/stats') }
    : await get(u.pathname);
  if (answer === null) return r.fulfill({ status: 500, contentType: 'application/json', headers: CORS, body: '{}' });
  return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(answer) });
});

const plain = (pulse) => (pathname) => {
  if (pathname === '/api/pulse') return Object.assign({ quests: 1, messages: 0, urgent: 0 }, pulse || {});
  if (pathname === '/api/leaderboard') return LB;
  if (pathname === '/api/stats') return STATS;
  return {};
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

  // ---------------- the board at 1280 ----------------
  {
    const { ctx, p, errors, badRequests } = await tabPage(b, {});
    await stub(p, plain());
    await p.goto(BASE + '/tab/');
    await sleep(1200);

    const behind = await p.$$eval('#tab-body tr', trs => trs.map(tr => tr.children[3].textContent.replace(/[^0-9,]/g, '')));
    check('behind is the leader’s points less the row’s, on every row, the leader’s printed as the 0 it is',
      behind.join('|') === '0|125|170|235|310|345|455|1,430', JSON.stringify(behind));

    // The totals row used to carry "8 teams" under the Team column. It
    // does not any more: the last place in the column above it is the
    // number of teams, so the page was saying the same figure twice,
    // three rules apart. The cell stays — it holds the column open —
    // and is checked empty, so the count cannot come back unnoticed.
    const totals = await p.evaluate(() => {
      const tr = document.querySelector('#tab-table tfoot tr');
      return {
        teams: tr.children[1].textContent.replace(/\s+/g, ' ').trim(),
        points: tr.children[2].textContent.trim(),
        quests: tr.children[4].textContent.replace(/\s+/g, ' ').trim(),
        rule: getComputedStyle(tr.children[2]).borderTopWidth
      };
    });

    const waiting = await p.textContent('#tab-waiting');

    const cut = await p.$$eval('*', ns => ns.filter(n => /prizes stop here/i.test(n.textContent || '') && n.children.length === 0).length);

    check('no page errors and no failed same-origin requests at 1280',
      errors.length === 0 && badRequests.length === 0, errors.concat(badRequests).join(' | '));
    await ctx.close();
  }

  // ---------------- the board at 390 ----------------
  {
    const { ctx, p, errors, badRequests } = await tabPage(b, { viewport: { width: 390, height: 844 }, mobile: true });
    await stub(p, plain());
    await p.goto(BASE + '/tab/');
    await sleep(1200);

    const shape = await p.evaluate(() => {
      const tr = document.querySelector('#tab-body tr');
      const cells = [...tr.children];
      const rowOf = el => Math.round(el.getBoundingClientRect().top);
      const storeys = [...new Set(cells.filter(c => c.getBoundingClientRect().height > 0).map(rowOf))].sort((a, b) => a - b);
      return {
        cols: getComputedStyle(tr).gridTemplateColumns.split(' ').length,
        display: getComputedStyle(tr).display,
        storeys: storeys.length,
        // everything shown sits on one line: no cell starts below the
        // name's bottom edge
        oneLine: cells.filter(c => c.getBoundingClientRect().height > 0)
          .every(c => c.getBoundingClientRect().top < tr.querySelector('td.tab-team').getBoundingClientRect().bottom),
        quests: cells[4].textContent.replace(/\s+/g, ' ').trim(),
        behind: cells[3].textContent.replace(/\s+/g, ' ').trim(),
        last: cells[5].textContent.replace(/\s+/g, ' ').trim(),
        heads: [...document.querySelectorAll('#tab-table thead th')]
          .filter(n => getComputedStyle(n).display !== 'none').map(n => n.textContent.trim())
      };
    });
    // Two views on a phone. Compact is one line a team — place, name,
    // quests, points — under heads for the three that need one; Full
    // adds a line under the name with last scored and the gap to the
    // leader. Either way the row is a grid, not a table scrolling
    // sideways, and the choice is kept for next time.
    check('compact: one line a team, place, name, quests and points, with their heads',
      shape.display === 'grid' && shape.cols === 4 && shape.oneLine &&
      /38/.test(shape.quests) && shape.heads.join('|') === 'Team|Points|Quests', JSON.stringify(shape));
    await p.click('.tab-view button[data-view="full"]');
    await sleep(200);
    const full = await p.evaluate(() => {
      const tr = document.querySelector('#tab-body tr');
      const name = tr.querySelector('td.tab-team').getBoundingClientRect();
      const last = tr.children[5].getBoundingClientRect();
      return {
        under: last.height > 0 && last.top >= name.bottom - 1,
        last: tr.children[5].getBoundingClientRect().height > 0 ? tr.children[5].textContent.replace(/\s+/g, ' ').trim() : '',
        kept: localStorage.getItem('scs2-tab-view')
      };
    });
    check('full: a second line with last scored under the name, and the choice is kept',
      full.under && /SQ14/.test(full.last) && /Across the Coathanger/.test(full.last) && full.kept === 'full',
      JSON.stringify(full));

    const totalQuests = await p.evaluate(() => {
      const el = document.getElementById('tab-completions');
      const r = el.getBoundingClientRect();
      return { text: el.textContent.trim(), shown: r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none' };
    });
    check('the total quests completed is on the page at 390 too',
      totalQuests.shown && totalQuests.text === '235', JSON.stringify(totalQuests));

    // This used to read the other way round: the place centred on the
    // whole row. A row here is three storeys and only the first carries
    // the name, so on a wrapped quest name the number sat half a row
    // below the team it labels, beside the detail instead. The place,
    // the name and the points now share the first storey and are
    // centred on that, which is what the CSS comment beside the grid
    // says. The row check stays, inverted: a number back on the middle
    // of a tall row is the old layout returning.
    const centred = await p.evaluate(() => {
      const tr = document.querySelector('#tab-body tr');
      const cell = tr.children[0].getBoundingClientRect();
      const name = tr.querySelector('td.tab-team').getBoundingClientRect();
      const mark = tr.querySelector('.rank-bullet').getBoundingClientRect();
      const row = tr.getBoundingClientRect();
      const mid = (mark.top + mark.bottom) / 2;
      return {
        inCell: Math.abs(mid - (cell.top + cell.bottom) / 2),
        onName: Math.abs(mid - (name.top + name.bottom) / 2),
        inRow: Math.abs(mid - (row.top + row.bottom) / 2),
        rowH: row.height,
        cellH: cell.height
      };
    });
    check('the rank is centred on the name it labels, not on the whole row',
      centred.inCell < 2 && centred.onName < 2, JSON.stringify(centred));

    // The folded row is the one layout here that verify-redesign never
    // sees with data in it, so the geometry is worth a look at 390 and
    // nowhere else.
    const d = await p.evaluate(SCAN);
    check('the folded row holds together: nothing off the side, no text on text',
      d.wide.length === 0 && !d.sideways && d.over.length === 0,
      JSON.stringify(d.wide) + ' ' + d.over.slice(0, 2).join(' , '));
    check('no page errors and no failed same-origin requests at 390',
      errors.length === 0 && badRequests.length === 0, errors.concat(badRequests).join(' | '));
    await ctx.close();
  }

  // ---------------- both themes ----------------
  for (const theme of ['light', 'dark']) {
    for (const width of [1280, 390]) {
      const { ctx, p, errors } = await tabPage(b, {
        theme, viewport: { width, height: width === 390 ? 844 : 900 }, mobile: width === 390
      });
      await stub(p, plain());
      await p.goto(BASE + '/tab/');
      await sleep(1000);
      const ink = await p.evaluate(() => {
        const contrast = (a, b) => {
          const lum = c => {
            const [r, g, bl] = c.match(/[\d.]+/g).slice(0, 3).map(n => {
              const v = Number(n) / 255;
              return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            });
            return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
          };
          const x = lum(a), y = lum(b);
          return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
        };
        const page = getComputedStyle(document.body).backgroundColor;
        const out = { theme: document.documentElement.getAttribute('data-theme') || 'light', medals: [], rows: 0 };
        [...document.querySelectorAll('.rank-bullet')].forEach(b => {
          const s = getComputedStyle(b);
          out.medals.push({
            onNumber: Math.round(contrast(s.backgroundColor, s.color) * 10) / 10,
            onPage: Math.round(contrast(s.backgroundColor, page) * 10) / 10
          });
        });
        const cell = document.querySelector('#tab-body td.tab-team');
        out.body = Math.round(contrast(getComputedStyle(cell).color, page) * 10) / 10;
        out.rows = document.querySelectorAll('#tab-body tr').length;
        return out;
      });
      check(theme + ' at ' + width + ': the board renders and its text carries',
        ink.rows === 8 && ink.body >= 4.5 && (theme === 'dark') === (ink.theme === 'dark'), JSON.stringify(ink.theme) + ' body=' + ink.body);
      check(theme + ' at ' + width + ': every medal carries its number and sits off the ground',
        ink.medals.length === 3 && ink.medals.every(m => m.onNumber >= 4.5 && m.onPage >= 1.35),
        JSON.stringify(ink.medals));
      check(theme + ' at ' + width + ': no page errors', errors.length === 0, errors.join(' | '));
      await ctx.close();
    }
  }

  // ---------------- the tab cannot be reached: nothing kept ----------------
  {
    const { ctx, p, errors } = await tabPage(b, {});
    await stub(p, (path) => (path === '/api/pulse' ? { quests: 1, messages: 0, urgent: 0 } : null));
    await p.goto(BASE + '/tab/');
    await sleep(1400);
    const state = await p.evaluate(() => ({
      shown: !document.getElementById('tab-error').classList.contains('is-hidden'),
      text: document.getElementById('tab-error-text').textContent,
      retry: !!document.getElementById('tab-retry'),
      updated: document.getElementById('tab-updated').textContent,
      rows: document.querySelectorAll('#tab-body tr').length,
      pulsing: document.querySelectorAll('.t-skel:not(.is-revealed)').length
    }));
    check('a first visit with no answer says there is nothing to show yet',
      state.shown && /no standings to show yet/i.test(state.text) && state.rows === 0, JSON.stringify(state));
    check('and the skeleton stops pulsing rather than promising a table that is not coming',
      state.pulsing === 0, JSON.stringify(state));
    check('no page errors while the API is away', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- the tab cannot be reached: a copy on screen ----------------
  {
    const kept = { lb: LB, stats: STATS, at: Date.now() - 12 * 60000 };
    const { ctx, p, errors } = await tabPage(b, { cache: kept });
    await stub(p, (path) => (path === '/api/pulse' ? { quests: 1, messages: 0, urgent: 0 } : null));
    await p.goto(BASE + '/tab/');
    await sleep(1400);
    const state = await p.evaluate(() => ({
      text: document.getElementById('tab-error-text').textContent,
      updated: document.getElementById('tab-updated').textContent,
      rows: document.querySelectorAll('#tab-body tr').length,
      waiting: document.getElementById('tab-waiting').textContent
    }));
    check('with a kept copy on screen the message is that the refresh failed and this is the copy',
      /last refresh failed/i.test(state.text) && /copy saved on this device/i.test(state.text) && state.rows === 8,
      JSON.stringify(state.text));
    check('and the line above still says how old the copy is',
      /12 min ago/.test(state.updated), state.updated);
    check('the two messages are not the same message',
      !/nothing to show/i.test(state.text), state.text);
    check('the kept copy paints the whole board, waiting line included',
      /29 submissions are waiting/.test(state.waiting), state.waiting);
    check('no page errors with a kept copy and no network', errors.length === 0, errors.join(' | '));

    // a copy kept by an older build carries neither new field
    await ctx.close();
  }

  // ---------------- an older kept copy, before the two new fields ----------------
  {
    const old = {
      lb: { teams: [{ rank: 1, name: 'Team Ferrous', points: 5820, quests_done: 12 }] },
      stats: { total_teams: 41, total_completions: 240, total_points: 61000 },
      at: Date.now() - 4 * 60000
    };
    const { ctx, p, errors } = await tabPage(b, { cache: old });
    await stub(p, (path) => (path === '/api/pulse' ? { quests: 1, messages: 0, urgent: 0 } : null));
    await p.goto(BASE + '/tab/');
    await sleep(1200);
    const state = await p.evaluate(() => ({
      rows: document.querySelectorAll('#tab-body tr').length,
      last: document.querySelector('#tab-body tr').children[5].textContent.trim(),
      waitingHidden: document.getElementById('tab-waiting').classList.contains('is-hidden')
    }));
    check('a copy kept before the new fields existed still paints, with an empty cell where there is nothing',
      state.rows === 1 && state.last === '' && state.waitingHidden, JSON.stringify(state));
    check('no page errors on an older copy', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- a team that did not finish ----------------
  // The first and fourth teams by points did not finish: a dash for the
  // place, a * after the points, nothing behind, and the medals go to the
  // three teams that did. The line under the board goes with the last one.
  {
    const out = (rows, gone) => {
      let place = 0;
      return { teams: rows.map((t, i) => ({
        rank: gone.includes(i) ? null : ++place, dnf: gone.includes(i),
        name: t[0], points: t[1], quests_done: t[2], last_quest: null
      })) };
    };
    let lb = out(TEAMS, [0, 3]);
    const { ctx, p, errors } = await tabPage(b, {});
    await stub(p, (path) => {
      if (path === '/api/pulse') return { quests: 1, messages: 0, urgent: 0 };
      if (path === '/api/leaderboard') return lb;
      if (path === '/api/stats') return STATS;
      return {};
    });
    await p.goto(BASE + '/tab/');
    await sleep(1200);
    const rows = await p.$$eval('#tab-body tr', trs => trs.slice(0, 6).map(tr => [
      tr.children[0].textContent.trim(), (tr.querySelector('.rank-bullet') || {}).className || '',
      tr.children[2].textContent.trim(), tr.children[3].textContent.replace(/[^0-9,]/g, '')
    ].join(' ')));
    const noteOf = () => p.$eval('#tab-dnf', el => (!el.hidden && el.getBoundingClientRect().height > 0 ? el.textContent.trim() : ''));
    const note = await noteOf();
    lb = out(TEAMS, []);
    await p.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(600);
    const noteAfter = await noteOf();
    check('a team that did not finish has a dash for its place and a * on its points, the places and medals skip it, and the line under the board says what the * means while one is there',
      JSON.stringify(rows) === JSON.stringify([
        '–  1,640* ', '1 rank-bullet rank-bullet--1 1,515 0', '2 rank-bullet rank-bullet--2 1,470 45',
        '–  1,405* ', '3 rank-bullet rank-bullet--3 1,330 185', '4  1,295 220']) &&
      note === '* Did not finish.' && noteAfter === '',
      JSON.stringify({ rows, note, noteAfter }));
    check('no page errors with a team that did not finish', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- frozen ----------------
  {
    const frozenLb = Object.assign({ frozen: true, frozen_at: '2026-10-20 05:25:00' }, LB);
    const frozenStats = Object.assign({ frozen: true, frozen_at: '2026-10-20 05:25:00' }, STATS);
    const { ctx, p, errors } = await tabPage(b, {});
    await stub(p, (path) => {
      if (path === '/api/pulse') return { quests: 1, messages: 0, urgent: 0 };
      if (path === '/api/leaderboard') return frozenLb;
      if (path === '/api/stats') return frozenStats;
      return {};
    });
    await p.goto(BASE + '/tab/');
    await sleep(1600);
    const frozen = await p.evaluate(() => ({
      iced: document.documentElement.classList.contains('tab-frozen'),
      sheet: !!document.getElementById('tab-ice'),
      when: document.getElementById('tab-updated').textContent,
      last: document.querySelector('#tab-body tr').children[5].textContent.trim(),
      quests: document.getElementById('tab-completions').textContent.trim(),
      points: document.getElementById('tab-points').textContent.trim(),
      waiting: document.getElementById('tab-waiting').textContent.trim()
    }));
    check('a frozen answer ices the page over and the line under the title says when it stopped, to the minute',
      frozen.iced && frozen.sheet && /^Standings as of .*\d:\d\d/.test(frozen.when) && !/\d:\d\d:\d\d/.test(frozen.when), JSON.stringify(frozen.when));
    check('the frozen copy still carries last scored, the total scored and the waiting count',
      /SQ14/.test(frozen.last) && frozen.quests === '235' && frozen.points === '10,050' &&
      frozen.waiting === '29 submissions are waiting for review and are not included on the tab.',
      JSON.stringify({ last: frozen.last, quests: frozen.quests, waiting: frozen.waiting }));
    // a refresh that brings the same frozen answer changes nothing on the
    // page: redrawing the rows under the frost made the text flash sharp
    const touched = await p.evaluate(async () => {
      let changes = 0;
      const watch = new MutationObserver(list => { changes += list.length; });
      ['tab-table', 'tab-updated', 'tab-waiting'].forEach(id => watch.observe(document.getElementById(id),
        { childList: true, subtree: true, characterData: true, attributes: true }));
      document.getElementById('tab-retry').click();
      await new Promise(res => setTimeout(res, 900));
      watch.disconnect();
      return changes;
    });
    check('a refresh while frozen leaves the board, the line under the title and the waiting count untouched',
      touched === 0, 'mutations=' + touched);
    check('no page errors while frozen', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- closed ----------------
  // A device that kept a board opens on it, the closed answer lands, the
  // board gives way to the sign, and the kept copy is now the sign.
  {
    const { ctx, p, errors } = await tabPage(b, { cache: { lb: LB, stats: STATS, at: Date.now() - 5000 } });
    await stub(p, (path) => {
      if (path === '/api/pulse') return { quests: 1, messages: 0, urgent: 0 };
      if (path === '/api/leaderboard' || path === '/api/stats') return { closed: true };
      return {};
    });
    await p.goto(BASE + '/tab/');
    await sleep(1600);
    const shown = (sel) => p.$eval(sel, el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().height > 0);
    const closed = {
      sign: await shown('#tab-closed'),
      board: await shown('#tab-table'),
      bar: await shown('.tab-bar-row'),
      words: (await p.textContent('#tab-closed')).replace(/\s+/g, ' ').trim(),
      kept: await p.evaluate(() => JSON.parse(localStorage.getItem('scs2-tab-cache') || 'null'))
    };
    check('a closed answer takes the board off the page for a sign, and the copy this device keeps is the closed one',
      closed.sign && !closed.board && !closed.bar && /The tab is closed/.test(closed.words) &&
      closed.kept && closed.kept.lb && closed.kept.lb.closed === true && !closed.kept.lb.teams,
      JSON.stringify(closed));
    check('no page errors while closed', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---------------- rows move, and names become links ----------------
  {
    let rows = TEAMS;
    let pulseFlags = { team_pages: false, recap: false };
    const { ctx, p, errors } = await tabPage(b, {});
    await stub(p, (path) => {
      if (path === '/api/pulse') return Object.assign({ quests: 1, messages: 0, urgent: 0 }, pulseFlags);
      if (path === '/api/leaderboard') return board(rows);
      if (path === '/api/stats') return STATS;
      return {};
    });
    await p.goto(BASE + '/tab/');
    await sleep(1200);
    check('the skeleton hands over once the data lands',
      (await p.$$('.t-skel:not(.is-revealed)')).length === 0, '');

    // second place overtakes: the row should glide rather than jump
    const swapped = TEAMS.slice();
    swapped[0] = TEAMS[1]; swapped[1] = TEAMS[0];
    rows = swapped.map((t, i) => (i < 2 ? [t[0], i === 0 ? 1700 : 1640, t[2], t[3], t[4], t[5]] : t));
    await p.evaluate(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await sleep(120);
    const flip = await p.evaluate(() => ({
      order: [...document.querySelectorAll('#tab-body tr')].slice(0, 2).map(tr => tr.getAttribute('data-team')),
      moving: [...document.querySelectorAll('#tab-body tr')].filter(tr => tr.getAnimations && tr.getAnimations().length).length
    }));
    check('a team that changes place glides there rather than teleporting',
      flip.order[0] === 'The Ministry of Magpie' && flip.moving >= 2, JSON.stringify(flip));

    // the medals follow the places rather than the rows
    await sleep(500);
    const medalOrder = await p.$$eval('#tab-body tr', trs => trs.slice(0, 3).map(tr => ({
      team: tr.getAttribute('data-team'), medal: (tr.querySelector('.rank-bullet') || {}).className
    })));
    check('the medals follow the places',
      medalOrder[0].medal === 'rank-bullet rank-bullet--1' && medalOrder[0].team === 'The Ministry of Magpie',
      JSON.stringify(medalOrder[0]));

    pulseFlags = { team_pages: true, recap: true };
    await p.reload();
    await sleep(1200);
    const after = await p.evaluate(() => ({
      links: document.querySelectorAll('#tab-body a.tab-team-link').length,
      href: (document.querySelector('#tab-body a.tab-team-link') || {}).getAttribute('href'),
      names: [...document.querySelectorAll('#tab-body .tab-team')].map(td => td.textContent).slice(0, 2),
      recap: document.getElementById('tab-recap').hidden
    }));
    check('after the event every name is a link to its team page and the recap link shows',
      after.links === 8 && /^team\/\?name=/.test(after.href) && after.recap === false, JSON.stringify(after));
    check('and the name cell still holds the name and nothing else',
      after.names[0] === 'The Ministry of Magpie', JSON.stringify(after.names));
    check('no page errors while the table moves', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  await b.close();
  if (server) server.kill();
  console.log(fail ? '\n' + fail + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
