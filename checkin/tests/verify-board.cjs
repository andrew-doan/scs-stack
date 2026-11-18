// Run with: node tests/verify-board.cjs
// The status board in a real browser: login gate, the Tabbycat-style
// wall of person chips grouped by team, the filter, the hide rockers
// and the sort modes. The page HTML comes from the real pages.js; the
// API is a tiny in-test server with a fixed roster.
const http = require('http');
const path = require('path');
let fail = 0;
const check = (l, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + l + (d ? '  ' + d : '')); if (!ok) fail++; };

const ROSTER = [
  { name: 'Alice Park', team_name: 'Galahs', checked_in_at: '2026-10-20 07:55:00' },
  { name: 'Ben Ho', team_name: 'Galahs', checked_in_at: '2026-10-20 08:02:00' },
  { name: 'Cass Nguyen', team_name: 'Galahs', checked_in_at: '2026-10-20 08:10:00' },
  { name: 'Dana Wu', team_name: 'Team Ferrous', checked_in_at: '2026-10-20 08:20:00' },
  { name: 'Eli Stone', team_name: 'Team Ferrous', checked_in_at: null },
  { name: 'Finn Gray', team_name: 'Loco Motive', checked_in_at: null },
  { name: 'Gus Webb', team_name: 'Loco Motive', checked_in_at: null },
  { name: 'Hana Cole', team_name: 'Loco Motive', checked_in_at: null }
];
const STATUS = {
  ok: true, people: 8, people_checked_in: 4, teams: 3, teams_complete: 1,
  team_list: [
    { team_name: 'Galahs', size: 3, checked_in: 3, complete: true, completed_at: '2026-10-20 08:10:00' },
    { team_name: 'Loco Motive', size: 3, checked_in: 0, complete: false, completed_at: null },
    { team_name: 'Team Ferrous', size: 2, checked_in: 1, complete: false, completed_at: null }
  ],
  people_list: ROSTER
};

(async () => {
  const { boardPage } = await import(path.join('file://', __dirname, '..', 'src', 'pages.js'));
  const html = boardPage();

  const server = http.createServer((req, res) => {
    if (req.url === '/board') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(html);
    }
    if (req.url === '/api/login' && req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        const data = JSON.parse(body || '{}');
        if (data.role === 'board' && data.password === 'wall-pass') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, session: 'brd-1' }));
        } else {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'wrong password' }));
        }
      });
      return;
    }
    if (req.url === '/api/status') {
      const authed = req.headers.authorization === 'Bearer brd-1';
      res.writeHead(authed ? 200 : 401, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(authed ? STATUS : { error: 'not signed in' }));
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise(res => server.listen(8126, res));

  const { chromium } = require('playwright');
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const p = await b.newPage({ viewport: { width: 1280, height: 900 } });

  await p.goto('http://127.0.0.1:8126/board');
  await p.waitForTimeout(300);
  check('the board gates on its password', await p.isVisible('#login'), '');
  await p.fill('#password', 'nope');
  await p.click('#login-btn');
  await p.waitForTimeout(300);
  check('a wrong password shows the server message',
    (await p.textContent('#login-error')).includes('wrong password'), '');
  await p.fill('#password', 'wall-pass');
  await p.click('#login-btn');
  await p.waitForTimeout(500);

  const stats = await p.evaluate(() => ({
    pin: document.getElementById('people-in').textContent,
    ptot: document.getElementById('people-total').textContent,
    tin: document.getElementById('teams-in').textContent,
    ttot: document.getElementById('teams-total').textContent
  }));
  check('the counters read people 4/8, teams 1/3',
    stats.pin === '4' && stats.ptot === '8' && stats.tin === '1' && stats.ttot === '3', JSON.stringify(stats));

  const wall = await p.evaluate(() => ({
    groups: document.querySelectorAll('.group').length,
    heads: [...document.querySelectorAll('.group-head')].map(h => h.textContent.replace(/\s+/g, ' ').trim()),
    doneHeads: [...document.querySelectorAll('.group-head.done')].map(h => h.textContent),
    chips: document.querySelectorAll('.chip').length,
    inChips: document.querySelectorAll('.chip.in').length,
    times: [...document.querySelectorAll('.chip.in .t')].map(t => t.textContent)
  }));
  check('the wall groups every team under a sign bar with its count',
    wall.groups === 3 && wall.heads.some(h => h.includes('Galahs') && h.includes('3/3')), JSON.stringify(wall.heads));
  check('a complete team\'s bar goes green',
    wall.doneHeads.length === 1 && wall.doneHeads[0].includes('Galahs'), '');
  check('one chip per person, checked-in solid with a time',
    wall.chips === 8 && wall.inChips === 4 && wall.times.length === 4 && wall.times.every(t => /\d/.test(t)),
    JSON.stringify({ chips: wall.chips, in: wall.inChips }));

  await p.fill('#filter', 'ferrous');
  await p.waitForTimeout(200);
  check('the filter narrows the wall by team or name',
    (await p.$$eval('.chip', c => c.length)) === 2 && (await p.$$eval('.group', g => g.length)) === 1, '');
  await p.fill('#filter', '');
  await p.waitForTimeout(200);

  await p.evaluate(() => document.getElementById('hide-in').click());
  await p.waitForTimeout(200);
  check('Hide checked in leaves only the absentees',
    (await p.$$eval('.chip', c => c.length)) === 4 && (await p.$$eval('.chip.in', c => c.length)) === 0, '');
  await p.evaluate(() => document.getElementById('hide-in').click());

  await p.selectOption('#sort', 'time');
  await p.waitForTimeout(200);
  const timeView = await p.evaluate(() => ({
    groups: document.querySelectorAll('.group').length,
    first: document.querySelector('.chip') ? document.querySelector('.chip').textContent : ''
  }));
  check('sorting by time flattens the wall, latest arrival first',
    timeView.groups === 0 && timeView.first.includes('Dana Wu'), JSON.stringify(timeView));

  // on a wall: a screen too short for the wall scrolls itself down after
  // a rest at the top, and stays switched on across a reload
  await p.selectOption('#sort', 'team');
  await p.setViewportSize({ width: 1280, height: 320 });
  await p.evaluate(() => document.getElementById('auto-scroll').click());
  await p.waitForTimeout(5500);
  const moved = await p.evaluate(() => document.scrollingElement.scrollTop);
  await p.reload();
  await p.waitForTimeout(600);
  const kept = await p.evaluate(() => document.getElementById('auto-scroll').checked);
  check('Auto scroll moves down the wall after a rest at the top, and is still on after a reload',
    moved > 20 && kept, JSON.stringify({ moved, kept }));

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  await b.close();
  server.close();
  process.exit(fail === 0 ? 0 : 1);
})();
