// After the event, on the site: the leaderboard's names become links
// once the pulse says team pages are open, the team page draws a
// team's day, the recap page draws the event's, the replay draws the
// routes teams recorded, and each says so plainly while it is closed.
// Run with: node tests/verify-recap.cjs
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

const LB = { teams: [
  { rank: 1, name: 'Galahs', points: 4167, quests_done: 22 },
  // the one row carrying its id: a copy frozen before ids links by name
  { id: 3, rank: 2, name: 'S.S. Crab', points: 3900.5, quests_done: 19 },
  { rank: 3, name: 'Team & Co', points: 3100, quests_done: 15 }
] };
const STATS = { total_teams: 3, total_completions: 56, total_points: 11167.5, submissions_by_hour: [], teams_checked_in: 0, team_checkins: [] };
const TEAM = {
  ok: true, team: 'S.S. Crab', rank: 2, teams: 3, total: 3900.5, quests_done: 2,
  lines: [
    { code: 'SQ18', group_key: 'SQ18', name: 'The Snout', label: '', region: 'Exploration Region', amount: 1, points: 25, worth: 25, at: '2026-10-20 01:26:00' },
    { code: 'SQ70', group_key: 'SQ70', name: 'School run', label: 'Per school', region: 'Physical Region', amount: 3, points: 10, worth: 30, at: '2026-10-20 02:40:00' }
  ],
  submissions: { sent: 4, accepted: 2, rejected: 1, pending: 1 },
  first_at: '2026-10-20 00:30:00', last_at: '2026-10-20 03:20:00',
  by_hour: [
    { hour: '2026-10-20 00:00', sent: 1, accepted: 0 },
    { hour: '2026-10-20 01:00', sent: 2, accepted: 2 },
    { hour: '2026-10-20 02:00', sent: 0, accepted: 0 },
    { hour: '2026-10-20 03:00', sent: 1, accepted: 0 }
  ],
  by_half: [],
  by_quarter: ['2026-10-20 00:30', '2026-10-20 00:45', '2026-10-20 01:00', '2026-10-20 01:15', '2026-10-20 01:30', '2026-10-20 01:45']
    .map((hour, i) => ({ hour, sent: [1, 0, 1, 1, 0, 1][i], accepted: [0, 0, 1, 1, 0, 0][i] })),
  by_minute: ['2026-10-20 00:30', '2026-10-20 00:31', '2026-10-20 00:32'].map((hour, i) => ({ hour, sent: [1, 0, 1][i], accepted: [0, 0, 1][i] })),
  files: { photos: 3, videos: 1, bytes: 9120000 },
  checked_in_at: '2026-10-19 23:05:00'
};
const RECAP = {
  ok: true, teams: 3, quests: 89, completions: 56, points: 11167.5,
  submissions: {
    sent: 40, accepted: 30, rejected: 6, pending: 4, first_at: '2026-10-19 22:30:00', last_at: '2026-10-20 04:10:00',
    busiest_hour: { hour: '2026-10-19 23:00', sent: 12, accepted: 9 },
    by_hour: ['2026-10-19 22:00', '2026-10-19 23:00', '2026-10-20 00:00', '2026-10-20 01:00', '2026-10-20 02:00', '2026-10-20 03:00', '2026-10-20 04:00']
      .map((hour, i) => ({ hour, sent: [5, 12, 8, 7, 4, 2, 2][i], accepted: [4, 9, 6, 5, 3, 2, 1][i] })),
    by_quarter: ['2026-10-19 22:00', '2026-10-19 22:15', '2026-10-19 22:30', '2026-10-19 22:45', '2026-10-19 23:00']
      .map((hour, i) => ({ hour, sent: [1, 2, 1, 1, 6][i], accepted: [1, 1, 1, 1, 4][i] })),
    busiest_quarter: { hour: '2026-10-19 23:00', sent: 6, accepted: 4 },
    by_half: [], busiest_half: null,
    by_minute: ['2026-10-19 22:00', '2026-10-19 22:01', '2026-10-19 22:02'].map((hour, i) => ({ hour, sent: [1, 0, 2][i], accepted: [1, 0, 1][i] })),
    busiest_minute: { hour: '2026-10-19 22:02', sent: 2, accepted: 1 }
  },
  review: { reviewed: 36, median_minutes: 14.5, mean_minutes: 22.1, fastest_minutes: 0.5, slowest_minutes: 130 },
  quests_by_time: [
    { key: 'SQ18', name: 'The Snout', region: 'Exploration Region', done_by: 3, points: 75, peak_hour: '2026-10-20 01:00', peak_count: 2, source: 'submissions' },
    { key: 'MQ1', name: 'Parramatta', region: 'The Mainland', done_by: 2, points: 800, peak_hour: '2026-10-20 04:00', peak_count: 2, source: 'completions' }
  ],
  most_done: [{ key: 'SQ18', name: 'The Snout', region: 'Exploration Region', done_by: 3 }, { key: 'MQ1', name: 'Parramatta', region: 'The Mainland', done_by: 2 }],
  least_done: [{ key: 'MQ1', name: 'Parramatta', region: 'The Mainland', done_by: 2 }],
  never_done: [{ key: 'SQ40', name: 'Wondabyne', region: 'Exploration Region' }, { key: 'SQ99', name: 'Stray', region: '' }],
  regions: [{ region: 'The Mainland', completions: 20, points: 8000, teams: 3, quests: [{ key: 'MQ1', name: 'Parramatta', completions: 2, teams: 2, points: 800 }] },
    { region: 'Exploration Region', completions: 36, points: 3167.5, teams: 3, quests: [] }],
  top_teams: LB.teams.map(t => ({ rank: t.rank, name: t.name, points: t.points, quests_done: t.quests_done })),
  most_active: [{ name: 'Galahs', sent: 20, accepted: 16, rejected: 3 }, { name: 'S.S. Crab', sent: 12, accepted: 9, rejected: 2 }],
  biggest_score: { team: 'Galahs', code: 'MQ1', quest: 'Parramatta', amount: 1, points: 400, worth: 400 },
  points_spread: { min: 3100, max: 4167, median: 3900.5, mean: 3722.5 },
  files: { photos: 60, videos: 12, bytes: 900000000, biggest_bytes: 120000000, gallery: 25 },
  checkins: { n: 3, first_at: '2026-10-19 23:05:00', last_at: '2026-10-19 23:40:00' },
  asks: { questions: 2, answers: 5 },
  boards: [{ title: 'Most stations', measure: 'count', teams: [{ place: 1, name: 'Galahs', value: 12 }, { place: 1, name: 'S.S. Crab', value: 12 }] }]
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
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript(() => { try { sessionStorage.setItem('scs2-install-nudged', '1'); localStorage.removeItem('scs2-tab-cache'); } catch (e) {} });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));

  let flags = { team_pages: false, recap: false, replay: false };
  let teamBody = TEAM;
  // A route in the replay's shape, a point every two minutes between
  // [time, lat, lon] waypoints: times in seconds from t0, positions in
  // 1e-5 degrees, each the difference from the one before.
  const T = s => Date.parse(s) / 1000;
  const routeOf = (team, way, legs) => {
    const pts = [];
    for (let k = 1; k < way.length; k++) {
      const [ta, ya, xa] = way[k - 1], [tb, yb, xb] = way[k];
      for (let t = ta; t < tb; t += 120) { const u = (t - ta) / (tb - ta); pts.push([t, ya + (yb - ya) * u, xa + (xb - xa) * u]); }
    }
    pts.push(way[way.length - 1]);
    const out = { v: 1, team, t0: pts[0][0], t: [], y: [], x: [], legs: legs || [], stays: [] };
    let pt = out.t0, py = 0, px = 0;
    pts.forEach(([t, lat, lon]) => {
      const yi = Math.round(lat * 1e5), xi = Math.round(lon * 1e5);
      out.t.push(t - pt); out.y.push(yi - py); out.x.push(xi - px);
      pt = t; py = yi; px = xi;
    });
    return out;
  };
  // Foursome rides to UNSW underground, stays, and walks back towards
  // the city; Five Guys walks north
  const ROUTES = {
    Foursome: routeOf('Foursome', [[T('2026-10-19T23:00:00Z'), -33.8830, 151.2066], [T('2026-10-19T23:50:00Z'), -33.9170, 151.2310],
      [T('2026-10-20T01:00:00Z'), -33.9172, 151.2312], [T('2026-10-20T04:30:00Z'), -33.8700, 151.2070]],
      [{ mode: 'metro', from: 'Central', to: 'Kingsford', t0: T('2026-10-19T23:00:00Z'), t1: T('2026-10-19T23:50:00Z'), filled: 1 }]),
    'Five Guys': routeOf('Five Guys', [[T('2026-10-19T23:10:00Z'), -33.8688, 151.2093], [T('2026-10-20T03:00:00Z'), -33.8000, 151.1800]])
  };
  // the replay's read: two teams with a route and one without, one quest
  // on a pin the first passes and one sent with the date taken off
  const REPLAY = { ok: true, teams: [
    { name: 'Foursome', rank: 1, dnf: false, total: 2000, route: '2026-11-01 10:00:00',
      log: [{ at: '2026-10-19 23:58:00', points: 500, sent: 1, accepted: 1 }, { at: '2026-10-20 03:40:00', points: 1500, sent: 1, accepted: 1 }],
      quests: [
      { key: 'MQ4', code: 'MQ4', name: 'UNSW', region: 'The Mainland', at: '2026-10-19 23:58:00' },
      { key: 'SQ1', code: 'SQ1', name: 'Stations Visited', region: 'Competition Region', at: '2026-10-20 00:20:00',
        spot: { lat: -33.88402, lng: 151.2062, place: 'Central' }, stop: 'Central', taken: true },
      { key: 'SQ18', code: 'SQ18', name: 'The Snout', region: 'Exploration Region', at: '14:40' }
    ] },
    { name: 'Five Guys', rank: 2, dnf: false, total: 1500, route: '2026-11-01 10:05:00', quests: [],
      log: [{ at: '2026-10-20 00:30:00', points: 1500, sent: 1, accepted: 1 }, { at: '2026-10-20 01:00:00', points: 0, sent: 1, accepted: 0 }] },
    { name: 'S.S. Crab', rank: 3, dnf: false, total: 900, route: '', log: [{ edge: 'end', points: 900, sent: 0, accepted: 0 }], quests: [
      { key: 'SQ7', code: 'SQ7', name: 'The Rocks', region: 'Exploration Region', at: '2026-10-20 02:00:00',
        spot: { lat: -33.8599, lng: 151.2090, place: 'The Rocks' } }
    ] }
  ], pins: { MQ4: [{ label: 'UNSW Kensington', lat: -33.9173, lng: 151.2313 }], SQ18: [] } };
  // a quest shown photo by photo, at the stations: each team's in the order visited
  const QUEST_PAGE = { ok: true, quest: { key: 'SQ1', name: 'Stations Visited', region: 'Competition Region' }, teams: 3, done_by: 2,
    submissions: { sent: 9, accepted: 8, rejected: 1, waiting: 0, teams: 2 },
    accepted: [{ team: 'Foursome', at: '2026-10-20 00:00:00' }, { team: 'Five Guys', at: '2026-10-20 00:30:00' }],
    visits: { kind: 'stations', teams: [
      { team: 'Foursome', visits: [{ place: 'Redfern', at: '2026-10-19 23:40:00' }, { place: 'Town Hall', at: '2026-10-19 23:50:00' },
        { place: 'Central', at: '2026-10-19 23:55:00' }] },
      { team: 'Five Guys', visits: [{ place: 'Museum', at: '2026-10-20 00:30:00' }] }
    ] } };
  const stubApi = async page => {
    await page.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    await page.route('**/files.scs.andyrew.space/**', r => {
      const u = new URL(r.request().url());
      const json = (body, status) => r.fulfill({ status: status || 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
      if (u.pathname === '/api/pulse') return json({ quests: 1, messages: 0, urgent: 0, team_pages: flags.team_pages, recap: flags.recap, replay: flags.replay });
      if (u.pathname === '/api/replay') return flags.replay ? json(REPLAY) : json({ error: 'not found' }, 404);
      if (u.pathname === '/api/replay/route') {
        const route = ROUTES[u.searchParams.get('name')];
        return flags.replay && route ? json({ ok: true, route }) : json({ error: 'not found' }, 404);
      }
      if (u.pathname === '/api/tab') return json({ leaderboard: LB, stats: STATS });
      if (u.pathname === '/api/leaderboard') return json(LB);
      if (u.pathname === '/api/stats') return json(STATS);
      if (u.pathname === '/api/team') {
        // by id first, as the worker does, which a renamed team still answers to
        const asked = (u.searchParams.get('id') === '3' && teamBody.team === 'S.S. Crab') || u.searchParams.get('name') === teamBody.team;
        return flags.team_pages && asked ? json(teamBody) : json({ error: 'not found' }, 404);
      }
      if (u.pathname === '/api/recap') return flags.recap ? json(RECAP) : json({ error: 'not found' }, 404);
      if (u.pathname === '/api/recap/quest') return flags.recap ? json(QUEST_PAGE) : json({ error: 'not found' }, 404);
      return json({}, 404);
    });
  };
  await stubApi(p);

  // ---------------- closed: the tab is as it was ----------------
  await p.goto(BASE + '/tab/');
  await sleep(1200);
  const closed = await p.evaluate(() => ({
    links: document.querySelectorAll('#tab-body a').length,
    names: [...document.querySelectorAll('#tab-body .tab-team')].map(td => td.textContent),
    recap: document.getElementById('tab-recap').hidden,
    share: document.getElementById('tab-share').hidden
  }));
  check('with both switches off the leaderboard names are plain text and there is no recap link or standings picture',
    closed.links === 0 && closed.names.length === 3 && closed.recap === true && closed.share === true, JSON.stringify(closed));

  await p.goto(BASE + '/tab/team/?name=S.S.%20Crab');
  await sleep(800);
  check('the team page says team pages are not open',
    (await p.isVisible('#tm-closed')) && !(await p.isVisible('#tm-body')) && (await p.textContent('#tm-name')) === 'S.S. Crab', '');
  await p.goto(BASE + '/recap/');
  await sleep(800);
  check('the recap page says it is not open', (await p.isVisible('#rc-closed')) && !(await p.isVisible('#rc-body')), '');

  // ---------------- open ----------------
  flags = { team_pages: true, recap: true };
  await p.goto(BASE + '/tab/');
  await sleep(1200);
  const open = await p.evaluate(() => ({
    links: [...document.querySelectorAll('#tab-body a.tab-team-link')].map(a => a.getAttribute('href')),
    recap: document.getElementById('tab-recap').hidden,
    recapHref: document.querySelector('#tab-recap a').getAttribute('href')
  }));
  check('with the switches on every name links to its team page and the recap link shows',
    open.links.length === 3 && open.links[1] === 'team/?id=3&name=S.S.%20Crab' && open.links[0] === 'team/?name=Galahs' &&
    open.recap === false && open.recapHref === '../recap/', JSON.stringify(open));

  // the results are out: the standings, and a team's receipt, go onto
  // the clipboard as pictures
  const stubClipboard = () => p.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.write = items => Promise.all(items.map(item => item.getType('image/png'))).then(blobs => {
      blobs.forEach(b => window.__copied.push({ type: b.type, size: b.size }));
    });
  });
  await stubClipboard();
  await p.click('#tab-copy');
  await sleep(700);
  const tabPicture = await p.evaluate(() => window.__copied);
  await p.goto(BASE + '/tab/team/?name=S.S.%20Crab');
  await sleep(1000);
  await stubClipboard();
  await p.click('#tm-copy');
  await sleep(900);
  const shown = () => p.evaluate(() => {
    const img = document.getElementById('tm-preview-img');
    return { open: !document.getElementById('tm-preview').hidden, src: img.hidden ? '' : img.src, h: img.naturalHeight };
  });
  const full = await shown();
  await p.click('#tm-detail [data-detail="compact"]');
  await sleep(900);
  const compact = await shown();
  await p.click('#tm-preview-copy');
  await sleep(700);
  const teamPicture = await p.evaluate(() => window.__copied);
  const after = await shown();
  check('with the results out the standings copy as a PNG, and a team\'s receipt opens in a window that shows it, redraws it for the option and copies it as a PNG',
    tabPicture.length === 1 && teamPicture.length === 1 &&
    tabPicture.concat(teamPicture).every(c => c.type === 'image/png' && c.size > 1000) &&
    full.open && !!full.src && compact.src !== full.src && compact.h > 0 && !after.open,
    JSON.stringify({ tabPicture, teamPicture, full, compact, after }));
  await p.goto(BASE + '/tab/');
  await sleep(1200);


  await p.click('#tab-body a.tab-team-link >> nth=1');
  await sleep(1000);
  const team = await p.evaluate(() => ({
    url: location.pathname + location.search,
    name: document.getElementById('tm-name').textContent,
    place: document.getElementById('tm-place').textContent,
    points: (document.querySelector('#tm-figures .figure-n') || {}).textContent,
    quests: (document.querySelectorAll('#tm-figures .figure-n')[1] || {}).textContent,
    regions: [...document.querySelectorAll('.tm-region')].map(n => n.textContent),
    rows: document.querySelectorAll('#tm-lines tbody tr').length,
    codes: [...document.querySelectorAll('#tm-lines .code')].map(n => n.textContent),
    amount: [...document.querySelectorAll('#tm-lines td')].some(td => /× 3/.test(td.textContent)),
    bars: document.querySelectorAll('#tm-hours .hour-col').length,
    tallest: (function () {
      const bars = [...document.querySelectorAll('#tm-hours .hour-bar')];
      return bars.map(b => Math.round(b.getBoundingClientRect().height));
    })(),
    inner: document.querySelectorAll('#tm-hours .hour-bar-inner').length,
    facts: document.getElementById('tm-facts').textContent,
    title: document.title
  }));
  check('tapping a name opens that team\'s page with its place, points and quests',
    /team\/\?id=3&name=S\.S\.%20Crab$/.test(team.url) && team.name === 'S.S. Crab' && /2nd of 3 teams/.test(team.place) &&
    team.points === '3,900.5' && team.quests === '2' && /S\.S\. Crab/.test(team.title), JSON.stringify(team));
  check('its quests are grouped by region, with the code, the name, the amount and when it was recorded',
    team.regions.join('|') === 'Exploration Region|Physical Region' && team.rows === 2 && team.codes.join('|') === 'SQ18|SQ70' && team.amount, JSON.stringify(team));
  check('its submissions by hour are bars, the tallest full height, with the accepted part inside',
    team.bars === 4 && team.tallest[1] > team.tallest[0] && team.tallest[2] === 0 && team.inner === 4 && Math.max.apply(null, team.tallest) >= 150, JSON.stringify(team.tallest));
  check('and the plain facts of its day: check-in in the line under the name, first and last submission, the files',
    /Checked in at/.test(team.place) && /First Submission/.test(team.facts) && /3 photos, 1 video/.test(team.facts), team.place + ' / ' + team.facts);

  // the team's chart has the recap's step picker, drawing the worker's
  // rows for the step and the minute as lines
  await p.click('#tm-step');
  await p.click('#tm-step-menu [data-step="15"]');
  await sleep(200);
  const teamQuarter = await p.evaluate(() => ({
    bars: document.querySelectorAll('#tm-hours .hour-col').length,
    word: document.querySelector('#tm-step .chart-step-text').textContent
  }));
  await p.click('#tm-step');
  await p.click('#tm-step-menu [data-step="1"]');
  await sleep(200);
  const teamMinute = await p.evaluate(() => ({
    line: document.querySelectorAll('#tm-hours svg.hour-line path').length,
    note: document.getElementById('tm-subs-note').textContent
  }));
  await p.click('#tm-step');
  await p.click('#tm-step-menu [data-step="60"]');
  check('the team\'s chart steps by the quarter and the minute from the worker\'s rows',
    teamQuarter.bars === 6 && teamQuarter.word === 'Quarter' && teamMinute.line > 0 && /dark green line/.test(teamMinute.note),
    JSON.stringify({ teamQuarter, teamMinute }));

  // a time the worker sent without its date (the organisers' date rules)
  // is printed as that time, with no date and no move to another zone
  teamBody = Object.assign({}, TEAM, {
    first_at: '12:10', last_at: '14:20', checked_in_at: '10:05',
    lines: TEAM.lines.map(l => Object.assign({}, l, { at: '12:26' })),
    by_hour: TEAM.by_hour.map((h, i) => Object.assign({}, h, { hour: (11 + i) + ':00' }))
  });
  await p.goto(BASE + '/tab/team/?name=S.S.%20Crab');
  await sleep(1000);
  const bareTimes = await p.evaluate(() => ({
    place: document.getElementById('tm-place').textContent,
    facts: document.getElementById('tm-facts').textContent,
    at: (document.querySelector('#tm-lines .tm-col-at') && [...document.querySelectorAll('#tm-lines td.tm-col-at')].map(td => td.textContent)) || [],
    tick: (document.querySelector('#tm-hours .hour-tick') || {}).textContent
  }));
  check('times sent without their date read as those times, on any page that prints them',
    /10:05\s?am/i.test(bareTimes.place) && /12:10\s?pm/i.test(bareTimes.facts) && /2:20\s?pm/i.test(bareTimes.facts) &&
    bareTimes.at.every(t => /^12:26\s?pm$/i.test(t)) && /^11\s?am$/i.test(bareTimes.tick) && !/Oct/.test(bareTimes.facts + bareTimes.place),
    JSON.stringify(bareTimes));
  teamBody = TEAM;

  // The team page with no ?name= is a different miss from a page that
  // is not open yet, and it used to say the pages were shut while they
  // were open. The section stays, for its link back; the sentence goes.
  await p.goto(BASE + '/tab/team/');
  await sleep(800);
  const noName = await p.evaluate(() => {
    const vis = el => !!el && !el.hidden && getComputedStyle(el).display !== 'none';
    return {
      place: document.getElementById('tm-place').textContent,
      section: vis(document.getElementById('tm-closed')),
      why: vis(document.getElementById('tm-closed-why')),
      shown: [...document.querySelectorAll('#tm-closed p')].filter(vis).map(n => n.textContent.trim())
    };
  });
  check('with no team named the page says so and does not claim team pages are shut',
    noName.place === 'No team named. Pick one from the tab.' && noName.section === true &&
    noName.why === false && noName.shown.length === 1 && /Back to the Tab/.test(noName.shown[0]),
    JSON.stringify(noName));

  await p.goto(BASE + '/recap/');
  await sleep(1000);
  const recap = await p.evaluate(() => ({
    big: [...document.querySelectorAll('#rc-big li')].map(li => [...li.children].map(c => c.textContent).join(' ').replace(/\u00a0/g, ' ')),
    bars: document.querySelectorAll('#rc-hours .hour-col').length,
    ticks: [...document.querySelectorAll('#rc-hours .hour-tick')].filter(t => t.textContent).length,
    busiest: document.getElementById('rc-subs-facts').textContent,
    questRows: [...document.querySelectorAll('#rc-quest-rows tr')].map(tr => [...tr.children].map(td => td.textContent.replace(/\s+/g, ' ').trim()).join(' | ')),
    questLink: (document.querySelector('#rc-quest-rows a') || {}).getAttribute('href'),
    most: document.querySelectorAll('#rc-most li').length,
    never: [...document.querySelectorAll('#rc-never .code')].map(n => n.textContent),
    neverNote: document.getElementById('rc-never-note').textContent,
    top: [...document.querySelectorAll('#rc-top li')].map(li => li.textContent),
    regions: document.querySelectorAll('#rc-regions tr').length,
    facts: document.getElementById('rc-facts').textContent,
    boards: [...document.querySelectorAll('#rc-boards > div')].map(b => b.querySelector('h2').textContent + ': ' +
      [...b.querySelectorAll('li')].map(li => li.style.counterSet + ' ' + li.textContent).join(', '))
  }));
  check('the recap leads with the headline numbers',
    recap.big[0] === '3 Teams' && recap.big[1] === '56 Quest Completions across 89 Quests' &&
    recap.big[2] === '11,167.5 Total Points, 3,900.5 for the Median Team' &&
    recap.big[3] === '40 Submissions, 30 Accepted, 6 Rejected and 4 Waiting', JSON.stringify(recap.big));
  check('submissions by hour are seven bars with hour ticks, and the busiest hour and verdict times are named',
    recap.bars === 7 && recap.ticks >= 4 && /Busiest Hour/.test(recap.busiest) && /12 submissions/.test(recap.busiest) && /Median 15 min/.test(recap.busiest), JSON.stringify({ bars: recap.bars, ticks: recap.ticks, facts: recap.busiest }));
  check('each quest lists the teams that did it and the hour it was most often done, opening the quest\'s own page',
    recap.questRows.length === 2 && /^SQ18 The Snout \| Exploration Region \| 3 \| .+ \(2\)$/.test(recap.questRows[0]) &&
    recap.questLink === 'quest/?key=SQ18', JSON.stringify(recap.questRows));
  check('most done, never done, the top teams and the regions are listed',
    recap.most === 2 && recap.never.join('|') === 'SQ40|SQ99' && /2 quests were never done/.test(recap.neverNote) &&
    recap.top.length === 3 && /Galahs/.test(recap.top[0]) && /4,167 pts/.test(recap.top[0]) && recap.regions === 3, JSON.stringify({ never: recap.never, top: recap.top[0], regions: recap.regions }));
  check('and the fun stats: the spread, the proof and the arrivals',
    /3,100 to 4,167/.test(recap.facts) && /60 photos and 12 videos/.test(recap.facts) && /3 teams checked in/.test(recap.facts) &&
    !/Biggest/.test(recap.facts) && !/questions asked/.test(recap.facts), recap.facts);
  check('a board picked on the dashboard is listed with its title, level teams sharing a place',
    recap.boards.length === 1 && /^Most stations: rc 1 Galahs12, rc 1 S\.S\. Crab12$/.test(recap.boards[0]), JSON.stringify(recap.boards));

  // the chart's step picks which of the worker's rows it draws and which
  // busiest it names; a region opens to the quests the worker lists in it
  await p.click('#rc-step');
  await p.click('#rc-step-menu [data-step="15"]');
  await sleep(200);
  const quarter = await p.evaluate(() => ({
    bars: document.querySelectorAll('#rc-hours .hour-col').length,
    facts: document.getElementById('rc-subs-facts').textContent
  }));
  await p.click('#rc-step');
  await p.click('#rc-step-menu [data-step="1"]');
  await sleep(200);
  const minute = await p.evaluate(() => ({
    bars: document.querySelectorAll('#rc-hours .hour-col').length,
    line: document.querySelectorAll('#rc-hours svg.hour-line path').length,
    facts: document.getElementById('rc-subs-facts').textContent
  }));
  await p.click('#rc-step');
  await p.click('#rc-step-menu [data-step="60"]');
  const closedRows = await p.$$eval('#rc-regions tr', rows => rows.filter(r => !r.hidden).length);
  await p.click('.rc-region-toggle');
  const opened = await p.evaluate(() => ({
    shown: [...document.querySelectorAll('#rc-regions tr')].filter(r => !r.hidden).map(r => [...r.children].map(td => td.textContent.replace(/\s+/g, ' ').trim()).join(' | ')),
    link: (document.querySelector('#rc-regions .rc-region-quest a') || {}).getAttribute('href')
  }));
  check('the chart steps by the quarter and the minute from the worker\'s rows, naming the busiest of each, and a region opens to its quests',
    quarter.bars === 5 && /Busiest Quarter/.test(quarter.facts) && /6 submissions/.test(quarter.facts) &&
    minute.bars === 0 && minute.line === 4 && /Busiest Minute/.test(minute.facts) && /2 submissions/.test(minute.facts) &&
    closedRows === 2 && opened.shown.length === 3 && /^MQ1 Parramatta \| 2 \| 2 \| 800$/.test(opened.shown[1]) && opened.link === 'quest/?key=MQ1',
    JSON.stringify({ quarter, minute, closedRows, opened }));

  // A team's page, the recap and a quest's page slide in from the page
  // they were opened from and a swipe in from the left edge takes them
  // back: the link's data-push, site.js's copy of that page and push.js
  // have to agree for either to happen
  await p.addInitScript(() => {
    window.__xs = [];
    (function look() {
      const m = document.querySelector('body > main');
      if (m) window.__xs.push(Math.round(m.getBoundingClientRect().left));
      if (window.__xs.length < 90) requestAnimationFrame(look);
    })();
  });
  const touch = (type, x, y) => p.evaluate(([type, x, y]) => {
    const tgt = document.elementFromPoint(Math.max(1, x), y) || document.body;
    const t = new Touch({ identifier: 1, target: tgt, clientX: x, clientY: y, pageX: x, pageY: y });
    tgt.dispatchEvent(new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }));
  }, [type, x, y]);
  const swipeBack = async () => {
    await touch('touchstart', 6, 500);
    for (let x = 20; x <= 260; x += 30) { await touch('touchmove', x, 502); await sleep(30); }
    await touch('touchend', 260, 502);
    await sleep(1200);
    return p.evaluate(() => location.pathname);
  };
  // in from the right, through the frames between, to its place
  const slid = xs => Math.max.apply(null, xs) > 200 && xs.some(x => x > 60 && x < 200) && xs[xs.length - 1] < 40;
  const arrive = async () => { await sleep(900); return p.evaluate(() => window.__xs.slice()); };
  await p.goto(BASE + '/tab/');
  await sleep(1000);
  await p.tap('#tab-body tr.has-team-link >> nth=1');
  await p.waitForURL(/team/);
  const teamXs = await arrive();
  const teamBack = await swipeBack();
  await p.tap('#tab-recap a');
  await p.waitForURL(/recap\/$/);
  const recapXs = await arrive();
  await p.tap('#rc-quest-rows tr.has-quest-link >> nth=0');
  await p.waitForURL(/quest/);
  const questXs = await arrive();
  const questBack = await swipeBack();
  const recapBack = await swipeBack();
  check('a team\'s page and the recap slide in over the tab and a quest\'s page over the recap, and a swipe from the left edge goes back to each',
    slid(teamXs) && teamBack === '/tab/' && slid(recapXs) && slid(questXs) && questBack === '/recap/' && recapBack === '/tab/',
    JSON.stringify({ teamXs, teamBack, recapXs, questXs, questBack, recapBack }));

  // ---------------- a quest shown photo by photo ----------------
  {
    const sctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const sp = await sctx.newPage();
    sp.on('pageerror', e => errors.push(e.message));
    await stubApi(sp);
    flags = { team_pages: true, recap: true, replay: false };
    await sp.goto(BASE + '/recap/quest/?key=SQ1');
    await sp.waitForSelector('#qs-visits .qs-vt', { timeout: 10000 }).catch(() => {});
    const shut = await sp.evaluate(() => ({
      rows: [...document.querySelectorAll('#qs-visits .qs-vt-toggle')].map(b => b.textContent.replace(/\s+/g, ' ').trim()),
      open: !document.querySelector('#qs-visits .qs-vt-list').hidden,
      title: document.getElementById('qs-visits-title').textContent
    }));
    await sp.tap('#qs-visits .qs-vt-toggle >> nth=0');
    const opened = await sp.evaluate(() => [...document.querySelectorAll('#qs-visits .qs-vt-list')[0].querySelectorAll('.qs-vt-row')]
      .map(v => v.textContent.replace(/\s+/g, ' ').trim()));
    check('a quest shown photo by photo lists each team with how many stations, and a tap opens them in the order visited',
      shut.title === 'Stations Visited' && shut.rows.length === 2 && /Foursome.*3 Stations/.test(shut.rows[0]) && /Five Guys.*1 Station$/.test(shut.rows[1]) && !shut.open &&
      opened.length === 3 && /Redfern$/.test(opened[0]) && /Central$/.test(opened[2]) && /\d/.test(opened[0]),
      JSON.stringify({ shut, opened }));
    await sctx.close();
  }

  // ---------------- the replay ----------------
  // Off, the page says so and the tab has no way to it. On, the routes
  // the tab has are drawn with their quests, and a team with a route
  // shows it on its own page.
  const rctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 900 } });
  const rp = await rctx.newPage();
  rp.on('pageerror', e => errors.push(e.message));
  await stubApi(rp);
  flags = { team_pages: true, recap: true, replay: false };
  await rp.goto(BASE + '/tab/replay/');
  await sleep(800);
  const replayOff = { closed: await rp.isVisible('#rp-closed'), body: await rp.isVisible('#rp-body') };
  await rp.goto(BASE + '/tab/');
  await sleep(900);
  replayOff.link = await rp.isVisible('#tab-replay');
  flags.replay = true;
  await rp.goto(BASE + '/tab/');
  await sleep(900);
  const replayLink = await rp.isVisible('#tab-replay a[href="replay/"]');
  check('the replay says it is not open until its switch, and the tab links to it once it is',
    replayOff.closed && !replayOff.body && !replayOff.link && replayLink, JSON.stringify(Object.assign({ replayLink }, replayOff)));
  const inked = () => rp.evaluate(() => {
    const c = document.querySelector('.rp-canvas');
    if (!c || !c.width) return 0;
    const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < px.length; i += 4) if (px[i]) n++;
    return n;
  });
  await rp.goto(BASE + '/tab/replay/');
  await rp.waitForSelector('.rp-team', { timeout: 20000 }).catch(() => {});
  await sleep(600);
  const drawn = await rp.evaluate(() => ({
    teams: document.querySelectorAll('.rp-team:not(.rp-team-all):not(.rp-team-others)').length,
    first: (document.querySelector('.rp-team:not(.rp-team-all) .rp-team-name') || {}).textContent,
    feed: [...document.querySelectorAll('.rp-feed-row')].map(r => r.textContent),
    lead: document.getElementById('rp-lead').textContent
  }));
  drawn.ink = await inked();
  check('every route is drawn, best placed first, with its quests from the tab, a date-less time put on the route\'s day',
    drawn.teams === 2 && drawn.first === 'Foursome' && drawn.ink > 2000 &&
    drawn.feed.length === 3 && /The Snout/.test(drawn.feed[0]) && /SQ1\s*Central/.test(drawn.feed[1]) && /UNSW/.test(drawn.feed[2]) && /\d/.test(drawn.lead),
    JSON.stringify(drawn));
  // the leaderboard at the replay's time: the tab's totals at the end, and
  // earlier only what had been sent by then
  const boardAt = async (stamp) => {
    if (stamp) {
      await rp.evaluate(t => { const sl = document.querySelector('.rp-scrub'); sl.value = String(Date.parse(t) / 1000); sl.dispatchEvent(new Event('input')); }, stamp);
      await sleep(200);
    }
    return rp.evaluate(() => ({
      rows: [...document.querySelectorAll('.rp-board-row')].map(r => r.innerText.replace(/\s+/g, ' ').trim()),
      figures: [...document.querySelectorAll('.rp-figures .figure-n')].map(n => n.textContent),
      ahead: document.querySelectorAll('.rp-chart .hour-col.is-ahead').length,
      bars: document.querySelectorAll('.rp-chart .hour-col').length
    }));
  };
  const atEnd = await boardAt(null);
  const atNoon = await boardAt('2026-10-20T01:05:00Z');
  await rp.evaluate(() => { const sl = document.querySelector('.rp-scrub'); sl.value = sl.max; sl.dispatchEvent(new Event('input')); });
  check('the leaderboard follows the replay\'s time: the tab\'s totals at the end, earlier only what had been sent, with the counters and the bars after it faded',
    atEnd.rows.join('|') === '1 Foursome 2,000|2 Five Guys 1,500|3 S.S. Crab 900' && atEnd.figures.join() === '4,3' && atEnd.ahead === 0 &&
    atNoon.rows.join('|') === '1 Five Guys 1,500|2 Foursome 500|\u2013 S.S. Crab 0' && atNoon.figures.join() === '3,2' &&
    atNoon.ahead > 0 && atNoon.ahead < atNoon.bars, JSON.stringify({ atEnd, atNoon }));
  // a team with no route: off until its toggle, then its quest at the spot
  const offInk = await inked();
  const offFeed = await rp.$$eval('.rp-feed-row', rows => rows.map(r => r.textContent).join('|'));
  await rp.click('.rp-team-others');
  await sleep(400);
  const others = {
    label: await rp.textContent('.rp-team-others'),
    off: { ink: offInk, crab: /S\.S\. Crab/.test(offFeed) },
    on: { ink: await inked(), crab: /S\.S\. Crab/.test(await rp.$$eval('.rp-feed-row', rows => rows.map(r => r.textContent).join('|'))),
      key: await rp.isVisible('.rp-key-other'), pressed: await rp.getAttribute('.rp-team-others', 'aria-pressed') }
  };
  await rp.click('.rp-team-others');
  await sleep(200);
  check('a team with no route has a toggle, and on, its quests are drawn at their places, in the feed and in the key',
    /1 team with no route/.test(others.label) && !others.off.crab && others.on.crab && others.on.ink > others.off.ink &&
    others.on.key && others.on.pressed === 'true', JSON.stringify(others));
  teamBody = Object.assign({}, TEAM, { team: 'Foursome' });
  await rp.goto(BASE + '/tab/team/?name=Foursome');
  await rp.waitForSelector('#tm-route:not([hidden]) .rp-canvas', { timeout: 20000 }).catch(() => {});
  await sleep(600);
  const route = { shown: await rp.isVisible('#tm-route'), ink: await inked(), chips: await rp.$$eval('.rp-team', n => n.length) };
  teamBody = TEAM;
  await rp.goto(BASE + '/tab/team/?name=S.S.%20Crab');
  await sleep(1200);
  route.none = !(await rp.isVisible('#tm-route'));
  check('a team with a route shows it alone on its page, and a team without one shows no Route section',
    route.shown && route.ink > 1000 && route.chips === 0 && route.none, JSON.stringify(route));
  await rctx.close();
  flags = { team_pages: true, recap: true, replay: false };

  // The hours arrive as UTC stamps and are read in the device's zone,
  // the day as well as the hour: asked in Sydney, 23:00 UTC on the 19th
  // is 10 am on the 20th.
  const zctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, timezoneId: 'Australia/Sydney', locale: 'en-AU' });
  await zctx.addInitScript(() => { try { sessionStorage.setItem('scs2-install-nudged', '1'); } catch (e) {} });
  const zoned = await zctx.newPage();
  zoned.on('pageerror', e => errors.push(e.message));
  await stubApi(zoned);
  await zoned.goto(BASE + '/recap/');
  await sleep(1000);
  const local = await zoned.evaluate(() => ({
    tick: document.querySelector('#rc-hours .hour-tick').textContent,
    wantTick: new Date('2026-10-19T22:00:00Z').toLocaleTimeString(undefined, { hour: 'numeric' }),
    busiest: document.getElementById('rc-subs-facts').textContent
  }));
  check('hour labels and the busiest hour\'s day are local time',
    local.tick === local.wantTick && / on 20 Oct, 12 submissions/.test(local.busiest), JSON.stringify(local));
  await zctx.close();

  console.log('errors', errors);
  check('no page errors', errors.length === 0, errors.join(' | '));

  await b.close();
  if (server) server.kill();
  console.log(fail ? 'FAILURES: ' + fail : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
