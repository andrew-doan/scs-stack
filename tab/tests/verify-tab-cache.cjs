// The copies pages keep between visits: the live tab paints its last
// good table before the network answers, and the quest sheet's
// "N of M teams" line renders from the stored stats when the API is
// slow or away.
// Run with: node tests/verify-tab-cache.cjs
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
const json = (r, o) => r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(o) });

(async () => {
  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await sleep(1200);
  }
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});

  // ---- the live tab: cached table first, fresh rows behind ----
  {
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 800 } });
    await ctx.addInitScript(() => {
      try {
        localStorage.setItem('scs2-tab-cache', JSON.stringify({
          lb: { teams: [
            { rank: 1, name: 'Team Ferrous', quests_done: 12, points: 5820 },
            { rank: 2, name: 'Galahs', quests_done: 10, points: 5100 }
          ] },
          stats: { total_completions: 240, total_points: 61000, total_teams: 41 },
          at: Date.now() - 10 * 60000
        }));
      } catch (e) {}
    });
    const p = await ctx.newPage();
    const errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await p.route('**/files.scs.andyrew.space/**', async r => {
      const u = new URL(r.request().url());
      if (u.pathname === '/api/pulse') return json(r, { quests: 1, messages: 0, urgent: 0 });
      // the network is slow: the fresh table lands well after the paint
      await sleep(1800);
      if (u.pathname === '/api/tab') {
        return json(r, { leaderboard: { teams: [
          { rank: 1, name: 'Galahs', quests_done: 13, points: 6400 },
          { rank: 2, name: 'Team Ferrous', quests_done: 12, points: 5820 }
        ] }, stats: { total_completions: 260, total_points: 66000, total_teams: 41 } });
      }
      return json(r, {});
    });
    await p.goto(BASE + '/tab/');
    await sleep(700);
    const early = await p.evaluate(() => ({
      rows: [...document.querySelectorAll('#tab-body tr')].map(tr => tr.getAttribute('data-team')),
      updated: (document.getElementById('tab-updated') || {}).textContent || ''
    }));
    check('the kept table paints before the network answers',
      early.rows.join('|') === 'Team Ferrous|Galahs', JSON.stringify(early.rows));
    check('and the updated line says how old the copy is',
      /min ago/.test(early.updated), early.updated);
    await sleep(2200);
    const late = await p.evaluate(() => ({
      rows: [...document.querySelectorAll('#tab-body tr')].map(tr => tr.getAttribute('data-team')),
      stored: JSON.parse(localStorage.getItem('scs2-tab-cache')).lb.teams[0].name
    }));
    check('the fresh table replaces it when it lands',
      late.rows.join('|') === 'Galahs|Team Ferrous', JSON.stringify(late.rows));
    check('and becomes the copy the next visit opens on', late.stored === 'Galahs', late.stored);
    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  // ---- the quest sheet: the teams line from the kept stats ----
  {
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await ctx.addInitScript(() => {
      try {
        sessionStorage.setItem('scs2-install-nudged', '1');
        localStorage.setItem('scs2-tab-stats-cache', JSON.stringify({
          total: 41, byCode: { SQ12: 3 }, byGroup: { SQ12: 3 }
        }));
      } catch (e) {}
    });
    const p = await ctx.newPage();
    const errors = []; p.on('pageerror', e => errors.push(e.message));
    await p.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await p.route('**/tiles.scs.andyrew.space/**', r => r.fulfill({ status: 404, body: '' }));
    await p.route('**/files.scs.andyrew.space/**', r => {
      const u = new URL(r.request().url());
      if (u.pathname === '/api/pulse') return json(r, { quests: 1, messages: 0, urgent: 0 });
      if (u.pathname === '/api/questlist') {
        return json(r, { regions: ['Inner West'], places: {}, groups: [{
          key: 'SQ12', name: 'Tile spotting', region: 'Inner West', description: '', flavour: '',
          location: 'Newtown', coords: [], submit: 'none', prompt: '', options: [],
          codes: [{ code: 'SQ12', label: '', points: 40 }], files: [], ask: null
        }] });
      }
      // the stats API is down: the kept copy is all there is
      return r.fulfill({ status: 500, contentType: 'application/json', headers: CORS, body: '{}' });
    });
    await p.goto(BASE + '/questlist/');
    await sleep(1400);
    await p.evaluate(() => {
      document.querySelector('.ql-item .ql-item-body').click();
    });
    await sleep(900);
    const line = await p.evaluate(() => (document.getElementById('ql-detail-teams') || {}).textContent || '');
    check('the teams line renders from the kept stats while the API is away',
      line.includes('3 of 41 teams'), line);
    check('no page errors', errors.length === 0, errors.join(' | '));
    await ctx.close();
  }

  await b.close();
  if (server) server.kill();
  console.log(fail ? 'FAILURES: ' + fail : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
