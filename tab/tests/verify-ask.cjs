// Live quests on the quest sheet: the files an organiser hangs on a
// quest, and the question it asks while the day runs — buttons, a
// typed answer, a sealed number, and points staked on an option.
// Run with: node tests/verify-ask.cjs
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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS'
};

// one quest per kind of question, plus a closed one
const quest = (key, name, ask, files) => ({
  key, name, region: 'Live quests', description: 'What to do.', flavour: '',
  location: 'Town Hall', coords: [{ label: name, lat: -33.8832, lng: 151.207 }],
  submit: 'none', prompt: '', options: [],
  codes: [{ code: key, label: 'Answered', points: 100 }],
  files: files || [], ask
});

const list = {
  regions: ['Live quests'],
  groups: [
    quest('LQ1', 'Red or blue', { kind: 'choice', prompt: 'Which button do you press?', options: ['Red button', 'Blue button'], open: true }, [
      { key: 'qst/pic1', name: 'the-clue.png', type: 'image/png', bytes: 20480 },
      { key: 'qst/doc1', name: 'the-rules.pdf', type: 'application/pdf', bytes: 524288 }
    ]),
    quest('LQ2', 'The casino', { kind: 'wager', prompt: 'Stake points on a colour.', options: ['Black', 'Red'], open: true }),
    quest('LQ3', 'Sealed bid', { kind: 'number', prompt: 'What do you bid?', options: [], open: true }),
    quest('LQ4', 'Name the place', { kind: 'text', prompt: 'Where was this taken?', options: [], open: true }),
    quest('LQ5', 'Too late', { kind: 'choice', prompt: 'Which way?', options: ['Left', 'Right'], open: false }),
    quest('LQ6', 'An ordinary quest', null),
    // the worker keeps a question out of the list until it opens, so
    // this one is only ever seen through /api/quest/ask
    quest('LQ7', 'Kept under wraps', null),
    // closed questions that show teams the other answers
    quest('LQ8', 'North or south', null),
    quest('LQ9', 'Name the statue', null)
  ],
  places: {}
};

(async () => {
  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await new Promise(res => setTimeout(res, 1200));
  }
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // the install panel would sit over the sheet on a phone-sized page
  await ctx.addInitScript(() => {
    try { localStorage.setItem('scs2-install-dismissed', '1'); } catch (e) {}
  });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));

  // ---- the worker, as far as this page is concerned ----
  const asks = {};
  list.groups.forEach(g => { if (g.ask) asks[g.key] = JSON.parse(JSON.stringify(g.ask)); });
  const answers = {};   // quest key -> {choice, amount} the worker holds
  const posts = [];     // every answer the page sent, with its bearer
  const askGets = [];   // every question the page asked the worker for
  const fileHits = [];  // every quest file the page asked for
  const dot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64');

  await p.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: r.request().url().endsWith('.css') ? 'text/css' : 'application/javascript', body: '' }));
  await p.route('**/tiles.scs.andyrew.space/**', r => r.fulfill({ status: 404, body: '' }));
  await p.route('**/files.scs.andyrew.space/**', async r => {
    const req = r.request();
    const u = req.url();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS, body: '' });
    if (u.includes('/api/questlist')) {
      return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(list) });
    }
    if (u.includes('/api/quests/file')) {
      fileHits.push(u);
      return r.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: dot });
    }
    if (u.includes('/api/quest/ask')) {
      const bearer = (req.headers()['authorization'] || '').replace('Bearer ', '');
      if (req.method() === 'POST') {
        const body = req.postDataJSON();
        posts.push({ body, bearer });
        const ask = asks[body.quest];
        if (!ask) return r.fulfill({ status: 404, contentType: 'application/json', headers: CORS, body: JSON.stringify({ error: 'No quest by that code.' }) });
        if (!bearer) return r.fulfill({ status: 401, contentType: 'application/json', headers: CORS, body: JSON.stringify({ error: 'not signed in' }) });
        if (!ask.open) return r.fulfill({ status: 409, contentType: 'application/json', headers: CORS, body: JSON.stringify({ error: 'Responses are closed.' }) });
        const kept = { choice: body.choice || '', amount: Number(body.amount) || 0 };
        answers[body.quest] = kept;
        return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ ok: true, choice: kept.choice, amount: kept.amount }) });
      }
      const key = new URL(u).searchParams.get('quest');
      askGets.push(key);
      const ask = asks[key];
      if (!ask) return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ kind: '' }) });
      return r.fulfill({
        status: 200, contentType: 'application/json', headers: CORS,
        body: JSON.stringify(Object.assign({
          kind: ask.kind, prompt: ask.prompt, options: ask.options, open: ask.open,
          response: bearer ? (answers[key] || null) : null
        }, ask.results ? { results: ask.results } : {}))
      });
    }
    if (u.includes('/api/pulse')) {
      return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify({ quests: 1, messages: 0, urgent: 0 }) });
    }
    return r.fulfill({ status: 404, contentType: 'application/json', headers: CORS, body: '{}' });
  });

  await p.goto(BASE + '/questlist/');
  await p.waitForTimeout(1300);

  const openQuest = async (key) => {
    await p.evaluate((k) => {
      const it = [...document.querySelectorAll('.ql-item')].find(i => i.dataset.questId === k);
      it.scrollIntoView();
      it.querySelector('.ql-item-body').click();
    }, key);
    await p.waitForTimeout(800);
  };
  const closeSheet = async () => { await p.keyboard.press('Escape'); await sleep(700); };
  const askState = () => p.evaluate(() => {
    const box = document.getElementById('ql-detail-ask');
    const status = box.querySelector('.ql-ask-status');
    const input = box.querySelector('.ql-ask-input');
    const send = box.querySelector('.ql-ask-send');
    return {
      shown: !box.classList.contains('is-hidden'),
      label: (box.querySelector('.ql-points-label') || {}).textContent || '',
      prompt: (box.querySelector('.ql-ask-prompt') || {}).textContent || '',
      options: [...box.querySelectorAll('.ql-ask-option')].map(o => ({
        text: o.textContent, pressed: o.getAttribute('aria-pressed'), off: o.disabled
      })),
      status: status ? status.textContent : '',
      statusLink: status && status.querySelector('a') ? status.querySelector('a').getAttribute('href') : '',
      input: input ? { value: input.value, off: input.disabled, kind: input.type, max: input.getAttribute('maxlength') } : null,
      sendOff: send ? send.disabled : null
    };
  });
  const tapOption = (text) => p.evaluate((t) => {
    const b = [...document.querySelectorAll('.ql-ask-option')].find(o => o.textContent === t);
    b.click();
  }, text);

  // ---------- the files hung on a quest ----------
  await openQuest('LQ1');
  const files = await p.evaluate(() => {
    const box = document.getElementById('ql-detail-files');
    const img = box.querySelector('.ql-file-shot img');
    const row = box.querySelector('.ql-file-list li');
    const link = row ? row.querySelector('a') : null;
    return {
      shown: !box.classList.contains('is-hidden'),
      shots: box.querySelectorAll('.ql-file-shot').length,
      src: img ? img.getAttribute('src') : '',
      lazy: img ? img.getAttribute('loading') : '',
      cell: img ? Math.round(img.getBoundingClientRect().height) : 0,
      rows: box.querySelectorAll('.ql-file-list li').length,
      name: link ? link.textContent : '',
      href: link ? link.getAttribute('href') : '',
      target: link ? link.getAttribute('target') : null,
      size: row ? (row.querySelector('.ql-file-size') || {}).textContent : '',
      // What came with the quest reads with the quest: after the
      // description and where it is, before what it pays.
      beforeCodes: box.compareDocumentPosition(document.querySelector('.ql-detail-points')) === 4,
      inQuestBlock: box.compareDocumentPosition(document.getElementById('ql-detail-description')) === 2
    };
  });
  check('a quest with files shows its picture as a thumbnail, asked for as a thumbnail',
    files.shown && files.shots === 1 && /\/api\/quests\/file\?key=qst%2Fpic1&thumb=1$/.test(files.src) && files.lazy === 'lazy',
    JSON.stringify({ src: files.src, shots: files.shots }));
  check('the picture cell has a size of its own, so a slow load cannot resize the sheet',
    files.cell > 40, files.cell + 'px tall before the picture arrives');
  check('the PDF is a plain row with its name and size, opening in place',
    files.rows === 1 && files.name === 'the-rules.pdf' && files.target === null &&
    /\/api\/quests\/file\?key=qst%2Fdoc1$/.test(files.href) && files.size === '512 KB',
    JSON.stringify({ name: files.name, href: files.href, size: files.size }));
  check('the files sit in the quest block, above what the quest pays',
    files.beforeCodes && files.inQuestBlock, JSON.stringify({ beforeCodes: files.beforeCodes, inQuestBlock: files.inQuestBlock }));

  await p.evaluate(() => document.querySelector('.ql-file-shot').click());
  await sleep(300);
  const lightbox = await p.evaluate(() => {
    const media = document.querySelector('.lb-overlay .lb-media');
    return { open: !!document.querySelector('.lb-overlay'), src: media ? media.getAttribute('src') : '' };
  });
  check('a tap opens the full picture in place, not the small copy',
    lightbox.open && /key=qst%2Fpic1$/.test(lightbox.src), JSON.stringify(lightbox));
  await p.keyboard.press('Escape');
  await sleep(300);

  // ---------- signed out ----------
  const out = await askState();
  check('the question shows with its prompt and one button per option',
    out.shown && out.label === 'Live Question' && out.prompt === 'Which button do you press?' &&
    out.options.length === 2 && out.options[0].text === 'Red button',
    JSON.stringify({ label: out.label, prompt: out.prompt, options: out.options.map(o => o.text) }));
  check('with no team session it points at the submit page and the buttons are dead',
    out.status === 'Sign in on the submit page to answer.' && out.statusLink === '../submit/' &&
    out.options.every(o => o.off), JSON.stringify({ status: out.status, link: out.statusLink }));
  await tapOption('Red button');
  await sleep(300);
  check('and tapping one sends nothing', posts.length === 0, posts.length + ' posts');

  // ---------- signed in: a choice goes the moment it is tapped ----------
  await closeSheet();
  await p.evaluate(() => localStorage.setItem('scs2-submit-session', 'team-token'));
  await openQuest('LQ1');
  await sleep(300);
  await tapOption('Red button');
  await sleep(400);
  const picked = await askState();
  check('a tapped option posts the quest and the choice with the team\'s session',
    posts.length === 1 && posts[0].bearer === 'team-token' &&
    JSON.stringify(posts[0].body) === JSON.stringify({ quest: 'LQ1', choice: 'Red button' }),
    JSON.stringify(posts[0] || null));
  check('the button it recorded reads as pressed, and the line names it',
    picked.options[0].pressed === 'true' && picked.options[1].pressed === 'false' &&
    picked.status === 'Recorded: Red button.', JSON.stringify({ status: picked.status, options: picked.options }));

  await tapOption('Blue button');
  await sleep(400);
  const changed = await askState();
  check('changing the answer posts again and moves the pressed button',
    posts.length === 2 && posts[1].body.choice === 'Blue button' &&
    changed.options[0].pressed === 'false' && changed.options[1].pressed === 'true' &&
    changed.status === 'Recorded: Blue button.', JSON.stringify({ status: changed.status, posts: posts.length }));

  // reopening reads the answer back off the worker
  await closeSheet();
  await openQuest('LQ1');
  await sleep(400);
  const again = await askState();
  check('the answer is still there on the next open, from the worker',
    again.options[1].pressed === 'true' && again.status === 'Recorded: Blue button.',
    JSON.stringify({ status: again.status }));

  // ---------- the wager: an option and a stake, then Send ----------
  await closeSheet();
  await openQuest('LQ2');
  await sleep(400);
  const wager0 = await askState();
  check('a wager shows its options, a points box and a Send that is not ready yet',
    wager0.label === 'Points Wager' && wager0.options.length === 2 &&
    wager0.input && wager0.input.kind === 'number' && wager0.sendOff === true,
    JSON.stringify({ label: wager0.label, sendOff: wager0.sendOff }));

  await p.fill('.ql-ask-input', '200');
  await sleep(150);
  const wagerPoints = await askState();
  check('points alone do not arm Send', wagerPoints.sendOff === true, '');
  await tapOption('Black');
  await sleep(200);
  const wagerBoth = await askState();
  check('with a colour picked as well it is ready',
    wagerBoth.sendOff === false && wagerBoth.options[0].pressed === 'true',
    JSON.stringify({ sendOff: wagerBoth.sendOff }));
  await p.click('.ql-ask-send');
  await sleep(400);
  const wagerSent = await askState();
  check('Send posts the colour and the stake together',
    posts.length === 3 && JSON.stringify(posts[2].body) === JSON.stringify({ quest: 'LQ2', choice: 'Black', amount: 200 }),
    JSON.stringify(posts[2] ? posts[2].body : null));
  check('and the line says what was staked on what',
    wagerSent.status === 'Recorded: 200 points on Black.', wagerSent.status);

  // ---------- the sealed number ----------
  await closeSheet();
  await openQuest('LQ3');
  await sleep(400);
  const num0 = await askState();
  check('a number question has no buttons, and Send waits for a number',
    num0.options.length === 0 && num0.input.kind === 'number' && num0.sendOff === true,
    JSON.stringify({ options: num0.options.length, sendOff: num0.sendOff }));
  await p.fill('.ql-ask-input', '42');
  await sleep(150);
  await p.click('.ql-ask-send');
  await sleep(400);
  const numSent = await askState();
  check('it posts the number with an empty choice',
    posts.length === 4 && JSON.stringify(posts[3].body) === JSON.stringify({ quest: 'LQ3', choice: '', amount: 42 }),
    JSON.stringify(posts[3] ? posts[3].body : null));
  check('and reads the answer back plainly', numSent.status === 'Recorded: 42.', numSent.status);

  // ---------- the typed answer ----------
  await closeSheet();
  await openQuest('LQ4');
  await sleep(400);
  const text0 = await askState();
  check('a text question is a line to type in, capped, with Send off while it is empty',
    text0.options.length === 0 && text0.input.kind === 'text' && text0.input.max === '200' &&
    text0.sendOff === true, JSON.stringify({ kind: text0.input.kind, max: text0.input.max }));
  await p.fill('.ql-ask-input', 'Central station');
  await sleep(150);
  const textTyped = await askState();
  check('typing arms Send', textTyped.sendOff === false, '');
  await p.click('.ql-ask-send');
  await sleep(400);
  const textSent = await askState();
  check('it posts the words as the choice',
    posts.length === 5 && JSON.stringify(posts[4].body) === JSON.stringify({ quest: 'LQ4', choice: 'Central station' }),
    JSON.stringify(posts[4] ? posts[4].body : null));
  check('and the line quotes back what was recorded',
    textSent.status === 'Recorded: "Central station".', textSent.status);

  await closeSheet();
  await openQuest('LQ4');
  await sleep(400);
  const textBack = await askState();
  check('the recorded words come back in the box on the next open',
    textBack.input.value === 'Central station' && textBack.status === 'Recorded: "Central station".',
    JSON.stringify({ value: textBack.input.value, status: textBack.status }));

  // ---------- closed ----------
  await closeSheet();
  await openQuest('LQ5');
  await sleep(400);
  const closed = await askState();
  check('a closed question says so and takes no answer',
    closed.status === 'Responses are closed.' && closed.options.every(o => o.off),
    JSON.stringify({ status: closed.status, off: closed.options.map(o => o.off) }));

  // ---------- closed between the read and the answer ----------
  await closeSheet();
  await openQuest('LQ1');
  await sleep(400);
  asks.LQ1.open = false; // organisers shut it while the sheet was open
  await tapOption('Red button');
  await sleep(400);
  const refused = await askState();
  check('an answer refused as closed says so and the buttons stop',
    refused.status === 'Responses are closed.' && refused.options.every(o => o.off),
    JSON.stringify({ status: refused.status }));

  // ---------- a quest that asks nothing ----------
  await closeSheet();
  await openQuest('LQ6');
  await sleep(400);
  const quiet = await p.evaluate(() => ({
    ask: document.getElementById('ql-detail-ask').classList.contains('is-hidden'),
    files: document.getElementById('ql-detail-files').classList.contains('is-hidden')
  }));
  check('an ordinary quest carries neither box', quiet.ask && quiet.files, JSON.stringify(quiet));

  // ---------- a question the list held back ----------
  // The worker keeps closed questions out of the public list, so one
  // that opens after the list was cached — or one this team answered
  // before it closed — arrives through the ask endpoint alone. The
  // sheet has to build the box from that answer by itself.
  asks.LQ7 = { kind: 'choice', prompt: 'Now it can be told.', options: ['Yes', 'No'], open: true };
  await closeSheet();
  await openQuest('LQ7');
  await sleep(500);
  const late = await askState();
  check('a question missing from the list still appears, from the worker alone',
    late.shown && late.prompt === 'Now it can be told.' && late.options.length === 2,
    JSON.stringify({ shown: late.shown, prompt: late.prompt }));

  // ---------- what the other teams answered ----------
  // A closed question that shows the tally, or every answer: the worker
  // marks this team's own, and the sheet draws what it is given.
  const results = () => p.evaluate(() => {
    const box = document.querySelector('#ql-detail-ask .ql-ask-results');
    return {
      shown: !!box && !box.classList.contains('is-hidden'),
      total: box ? (box.querySelector('.ql-ask-total') || {}).textContent : '',
      bars: box ? [...box.querySelectorAll('.ql-ask-bar')].map(b => ({
        name: b.querySelector('.ql-ask-bar-name').textContent,
        figure: b.querySelector('.ql-ask-bar-figure').textContent,
        width: Math.round(b.querySelector('.ql-ask-bar-fill').getBoundingClientRect().width /
          b.querySelector('.ql-ask-bar-track').getBoundingClientRect().width * 100),
        mine: b.classList.contains('is-mine')
      })) : [],
      answers: box ? [...box.querySelectorAll('.ql-ask-answers li')].map(li => ({
        team: li.querySelector('.ql-ask-team').textContent,
        answer: li.querySelector('.ql-ask-answer').textContent,
        mine: li.classList.contains('is-mine')
      })) : []
    };
  });
  asks.LQ8 = {
    kind: 'choice', prompt: 'North or south?', options: ['North', 'South'], open: false,
    results: { total: 3, counts: [{ choice: 'North', teams: 2, points: 0, mine: true }, { choice: 'South', teams: 1, points: 0 }] }
  };
  answers.LQ8 = { choice: 'North', amount: 0 };
  await closeSheet();
  await openQuest('LQ8');
  await sleep(500);
  const tally = await results();
  check('a closed question that shows the tally draws a bar per option, the team\'s own pick marked',
    tally.shown && tally.total === '3 teams answered' && tally.bars.length === 2 &&
    tally.bars[0].name === 'NorthYour answer' && tally.bars[0].figure === '2 teams' && tally.bars[0].mine &&
    tally.bars[0].width >= 64 && tally.bars[0].width <= 68 && tally.bars[1].name === 'South' && !tally.bars[1].mine &&
    tally.answers.length === 0, JSON.stringify(tally));

  asks.LQ9 = {
    kind: 'text', prompt: 'Who is the statue?', options: [], open: false,
    results: { total: 2, answers: [{ team: 'Galahs', choice: 'Queen Victoria', amount: 0, mine: true }, { team: 'S.S. Crab', choice: 'Captain Cook', amount: 0 }] }
  };
  await closeSheet();
  await openQuest('LQ9');
  await sleep(500);
  const every = await results();
  check('one that shows every answer lists each team and what it said, the team\'s own marked',
    every.shown && every.total === '2 teams answered' && every.bars.length === 0 &&
    JSON.stringify(every.answers) === JSON.stringify([
      { team: 'GalahsYour team', answer: 'Queen Victoria', mine: true },
      { team: 'S.S. Crab', answer: 'Captain Cook', mine: false }
    ]), JSON.stringify(every));

  // signed out there is no session and no recorded answer to fetch
  await closeSheet();
  await p.evaluate(() => localStorage.removeItem('scs2-submit-session'));
  askGets.length = 0;
  await openQuest('LQ6');
  await sleep(400);
  check('signed out, a quest the list gave no question is not even asked about',
    askGets.length === 0, JSON.stringify(askGets));

  console.log('errors', errors);
  check('no page errors', errors.length === 0, errors.join(' | '));

  // ---------- the dashboard end: hanging files, the polls and wagers, the desk ----------
  const HTML = (await import(path.join(ROOT, 'tab/src/console-page.js'))).consolePage();
  const dash = await b.newPage({ serviceWorkers: 'block', viewport: { width: 1100, height: 950 } });
  const dashErrors = []; dash.on('pageerror', e => dashErrors.push(e.message));
  const sent = { files: [], deleted: [], saved: [], opened: [], responses: 0, settled: [] };
  let group = {
    id: 1, key: 'LQ2', name: 'The casino', region: 'Live quests', description: '', flavour: '',
    location: '', coords: [], submit: 'none', prompt: '', options: [], sort: 1, hidden: 0,
    codes: [{ code: 'LQ2', label: '', points: 100, sort: 0, hidden: 0 }],
    files: [{ key: 'qst/pic1', name: 'the-clue.png', type: 'image/png', bytes: 20480 }],
    ask: { kind: 'wager', prompt: 'Stake points on a colour.', options: ['Black', 'Red'], open: true }
  };
  const other = Object.assign({}, group, { id: 2, key: 'LQ3', name: 'Name the place', sort: 2, files: [], ask: null,
    codes: [{ code: 'LQ3', label: '', points: 40, sort: 0, hidden: 0 }] });
  const askList = [{ key: 'LQ2', name: 'The casino', hidden: false, kind: 'wager', prompt: 'Stake points on a colour.',
    options: ['Black', 'Red'], open: true, open_until: '', reveal: '', reveal_live: false, answers: 2, settled: null }];

  await dash.route('**/api/console/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, teams: [], quests: [], entries: [], submissions: [], groups: [], loose: [], regions: [], subscribers: 0, waiting: [], closed: [] }) }));
  await dash.route('**/fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await dash.route('**/api/quests/file**', r => r.fulfill({ status: 200, contentType: 'image/png', body: dot }));
  await dash.route('**/api/console/login', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, session: 'sess-1', name: 'Alex' }) }));
  await dash.route('**/api/console/quests', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, groups: [group, other], loose: [], regions: [{ id: 1, name: 'Live quests', sort: 1, quests: 2 }]
  }) }));
  await dash.route('**/api/console/quests/asks', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, asks: askList }) }));
  await dash.route('**/api/console/quests/group/files', async r => {
    sent.files.push(r.request().postData() || '');
    group.files = group.files.concat([{ key: 'qst/pic2', name: 'added.png', type: 'image/png', bytes: 4096 }]);
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, files: group.files }) });
  });
  await dash.route('**/api/console/quests/group/file/delete', async r => {
    sent.deleted.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await dash.route('**/api/console/quests/group/ask/save', async r => {
    const body = r.request().postDataJSON();
    sent.saved.push(body);
    const ask = { kind: body.kind, prompt: body.prompt, options: String(body.options || '').split('\n').filter(Boolean), open: false, open_until: '' };
    const had = askList.find(a => a.key === body.key);
    if (had) Object.assign(had, ask);
    else askList.push(Object.assign({ key: body.key, name: 'Name the place', hidden: false, reveal: '', reveal_live: false, answers: 0, settled: null }, ask));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, ask }) });
  });
  await dash.route('**/api/console/quests/group/ask/open', async r => {
    const body = r.request().postDataJSON();
    sent.opened.push(body);
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true,
      ask: { kind: 'wager', prompt: 'Stake points on a colour.', options: ['Black', 'Red'], open: !!body.open, open_until: body.open_until || '' } }) });
  });
  await dash.route('**/api/console/quests/group/ask/responses', async r => {
    sent.responses++;
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, kind: 'wager', prompt: 'Stake points on a colour.', options: ['Black', 'Red'], open: true, open_until: '',
      responses: [
        { team: 'Galahs', hidden: 0, choice: 'Black', amount: 200, updated_at: '2026-10-20 03:15:00' },
        { team: 'S.S. Crab', hidden: 0, choice: 'Red', amount: 50, updated_at: '2026-10-20 03:20:00' },
        { team: 'Test Run', hidden: 1, choice: 'Black', amount: 900, updated_at: '2026-10-20 03:22:00' }
      ],
      counts: [{ choice: 'Black', teams: 2, points: 1100 }, { choice: 'Red', teams: 1, points: 50 }],
      total: 3, settled: null
    }) });
  });
  await dash.route('**/api/console/quests/group/ask/settle', async r => {
    sent.settled.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, settled: 2, winner: 'Black' }) });
  });
  await dash.route('**/api/console/points/form', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, ready: true, limited: false, places: {}, teams: [],
    quests: [{ key: 'LQ2', name: 'The casino', submit: 'none', prompt: '', options: [], tally: '', ask: 'wager',
      codes: [{ code: 'LQ2', label: '', points: 100, scoring: '' }] }]
  }) }));
  await dash.route('https://tab.example/console', r => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));

  await dash.goto('https://tab.example/console');
  await dash.waitForTimeout(300);
  await dash.fill('#login-pass', 'tab-pass');
  await dash.click('#login-btn');
  await dash.waitForTimeout(400);
  await dash.click('.tabs button[data-tab="quests"]');
  await dash.waitForTimeout(400);
  await dash.click('#quest-list .qg .qg-row');
  await dash.waitForTimeout(300);

  const editor = await dash.evaluate(() => {
    const card = document.querySelector('#quest-list .qg');
    const file = card.querySelector('.qg-file');
    return {
      fileRows: card.querySelectorAll('.qg-file').length,
      thumb: file.querySelector('img') ? file.querySelector('img').getAttribute('src') : '',
      fileName: file.querySelector('a').textContent,
      fileSize: file.querySelector('.muted').textContent,
      question: !!card.querySelector('.qg-ask') || [...card.querySelectorAll('select')].some(s => [...s.options].some(o => o.value === 'wager'))
    };
  });
  check('the quest editor lists the files hung on it, thumbnail and size, and holds no question',
    editor.fileRows === 1 && /key=qst%2Fpic1&thumb=1$/.test(editor.thumb) &&
    editor.fileName === 'the-clue.png' && editor.fileSize === '20 KB' && !editor.question,
    JSON.stringify(editor));

  // adding a file goes up as multipart, and the reply redraws the rows
  // a picked file waits in a row with its name open to change, and
  // goes up under the typed name once Upload is pressed
  await dash.setInputFiles('#quest-list .qg input[type=file]', { name: 'added.png', mimeType: 'image/png', buffer: dot });
  await dash.waitForTimeout(300);
  const waiting = await dash.evaluate(() => {
    const box = document.querySelector('#quest-list .qg .qg-waiting .file-rename');
    const up = [...document.querySelectorAll('#quest-list .qg .qg-waiting button')].find(b => /^Upload/.test(b.textContent));
    return { box: box && box.value, ext: box && box.nextSibling.textContent, upload: up && up.textContent, sentYet: false };
  });
  check('a picked file waits in a row with its name open to change',
    waiting.box === 'added' && waiting.ext === '.png' && waiting.upload === 'Upload 1 file' && sent.files.length === 0, JSON.stringify(waiting));
  await dash.fill('#quest-list .qg .qg-waiting .file-rename', 'clue for teams');
  await dash.$$eval('#quest-list .qg .qg-waiting button', bs => { const b = bs.find(x => /^Upload/.test(x.textContent)); if (b) b.click(); });
  await dash.waitForTimeout(900);
  check('Upload sends the quest key and the file as multipart under the typed name',
    sent.files.length === 1 && sent.files[0].indexOf('name="key"') !== -1 &&
    sent.files[0].indexOf('name="file0"') !== -1 && sent.files[0].indexOf('LQ2') !== -1 &&
    sent.files[0].indexOf('filename="clue for teams.png"') !== -1,
    'multipart parts: ' + (sent.files[0] || '').split('name="').length);
  check('and the rows redraw from what the worker gives back',
    (await dash.$$eval('#quest-list .qg .qg-file', rows => rows.length)) === 2, '');

  await dash.$$eval('#quest-list .qg .qg-file button', bs => bs[0].click());
  await dash.waitForTimeout(300);
  check('Remove takes one file off by its own key',
    sent.deleted.length === 1 && sent.deleted[0].key === 'qst/pic1', JSON.stringify(sent.deleted[0] || null));

  // ---- the list of polls and wagers holds the words ----
  await dash.click('#quest-asks-toggle');
  await dash.waitForTimeout(400);
  const listed = await dash.$$eval('#quest-asks .ask-row', rows => rows.map(r => r.textContent));
  check('Polls and wagers lists each quest that asks something: its code and name, the kind, the question, whether it takes answers and how many teams answered',
    listed.length === 1 && listed[0].includes('LQ2') && listed[0].includes('The casino') && listed[0].includes('Points wager') &&
    listed[0].includes('Stake points on a colour.') && listed[0].includes('Taking answers · 2 teams have answered'),
    JSON.stringify(listed));

  await dash.$$eval('#quest-asks .ask-row button', bs => bs.find(b => b.textContent === 'Edit').click());
  await dash.waitForTimeout(200);
  const askForm = await dash.evaluate(() => {
    const box = document.querySelector('#quest-asks .qg-ask');
    const kind = [...box.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'wager'));
    const options = box.querySelector('textarea');
    return {
      kinds: [...kind.options].map(o => o.value + ':' + o.textContent),
      kindValue: kind.value,
      options: options.value,
      optionsShown: !options.parentNode.classList.contains('hidden'),
      switches: box.querySelectorAll('.rocker, input[type=datetime-local]').length
    };
  });
  check('its editor offers the four kinds, shows the saved one with its options one per line, and has no switch or closing time',
    askForm.kinds.join(' | ') === 'choice:Buttons | text:Text answer | number:Number entry | wager:Points wager' &&
    askForm.kindValue === 'wager' && askForm.options === 'Black\nRed' && askForm.optionsShown && askForm.switches === 0,
    JSON.stringify(askForm));

  // a number question has no options to give
  const pickKind = value => dash.$$eval('#quest-asks .qg-ask select', (sels, v) => {
    const s = sels.find(x => [...x.options].some(o => o.value === 'wager'));
    s.value = v;
    s.dispatchEvent(new Event('change'));
  }, value);
  await pickKind('number');
  check('a number question hides the options box',
    await dash.$eval('#quest-asks .qg-ask textarea', t => t.parentNode.classList.contains('hidden')), '');
  await pickKind('wager');

  // what teams see of the other answers, and the tick box that only
  // means something once they see any
  await dash.$$eval('#quest-asks .qg-ask select', sels => {
    const s = sels.find(x => [...x.options].some(o => o.value === 'tally'));
    s.value = 'tally';
    s.dispatchEvent(new Event('change'));
  });
  await dash.$$eval('#quest-asks .qg-ask .qg-picks input', boxes => boxes[0].click());
  await dash.$$eval('#quest-asks .qg-ask button', bs => bs.find(b => b.textContent === 'Save').click());
  await dash.waitForTimeout(400);
  check('Save sends the quest, the kind, the prompt, the options and what teams see, and leaves taking answers to the desk',
    sent.saved.length === 1 && sent.saved[0].key === 'LQ2' && sent.saved[0].kind === 'wager' &&
    sent.saved[0].options === 'Black\nRed' && sent.saved[0].prompt === 'Stake points on a colour.' &&
    sent.saved[0].reveal === 'tally' && sent.saved[0].reveal_live === true &&
    !('open' in sent.saved[0]) && !('open_until' in sent.saved[0]),
    JSON.stringify(sent.saved[0] || null));

  // adding one: a quest that asks nothing yet, picked first
  await dash.$$eval('#quest-asks button', bs => bs.find(b => b.textContent === 'Add a poll or wager').click());
  await dash.waitForTimeout(200);
  const questPicks = await dash.$$eval('#quest-asks .qg-ask select', sels => [...sels[0].options].map(o => o.value));
  await dash.$$eval('#quest-asks .qg-ask button', bs => bs.find(b => b.textContent === 'Add').click());
  await dash.waitForTimeout(200);
  const unpicked = sent.saved.length;
  await dash.selectOption('#quest-asks .qg-ask select', 'LQ3');
  await pickKind('text');
  await dash.fill('#quest-asks .qg-ask input[type=text]', 'Where was this taken?');
  await dash.$$eval('#quest-asks .qg-ask button', bs => bs.find(b => b.textContent === 'Add').click());
  await dash.waitForTimeout(400);
  check('Add a poll or wager offers only the quests that ask nothing, sends nothing until one is picked, then adds the question to it',
    JSON.stringify(questPicks) === '["","LQ3"]' && unpicked === 1 && sent.saved.length === 2 &&
    sent.saved[1].key === 'LQ3' && sent.saved[1].kind === 'text' && sent.saved[1].prompt === 'Where was this taken?' &&
    (await dash.$$eval('#quest-asks .ask-row', rows => rows.length)) === 2,
    JSON.stringify({ questPicks, saved: sent.saved[1] || null }));

  // ---- the desk runs it ----
  await dash.$$eval('#quest-asks .ask-row', rows => [...rows[0].querySelectorAll('button')].find(b => b.textContent === 'Its desk').click());
  await dash.waitForTimeout(600);
  const run = await dash.evaluate(() => {
    const bar = document.querySelector('#desk-question .ask-run');
    return bar ? { on: bar.querySelector('.rocker input').checked, state: bar.querySelector('.ask-state').textContent, until: bar.querySelector('input[type=datetime-local]').value } : null;
  });
  check('the quest\'s desk shows its question with Taking answers switched on and no closing time',
    !!run && run.on && run.state === '' && run.until === '' &&
    (await dash.$eval('#desk-question', n => n.textContent)).includes('Stake points on a colour.'), JSON.stringify(run));
  await dash.click('#desk-question .ask-run .rocker');
  await dash.waitForTimeout(300);
  await dash.fill('#desk-question .ask-run input[type=datetime-local]', '2026-10-20T13:30');
  await dash.$$eval('#desk-question .ask-run button', bs => bs.find(b => b.textContent === 'Set').click());
  await dash.waitForTimeout(300);
  check('the switch stops the answers at once, and Set sends the time it closes at with it',
    sent.opened.length === 2 && sent.opened[0].key === 'LQ2' && sent.opened[0].open === false && sent.opened[0].open_until === '' &&
    sent.opened[1].open === false && /^2026-10-20 \d\d:30:00$/.test(sent.opened[1].open_until) &&
    /^Closed at /.test(await dash.$eval('#desk-question .ask-state', n => n.textContent)),
    JSON.stringify(sent.opened));

  const answersView = await dash.evaluate(() => {
    const box = document.querySelector('#desk-question .qg-ask-responses');
    return {
      note: box.querySelector('.note').textContent,
      counts: [...box.querySelectorAll('.qg-ask-count')].map(c => c.textContent),
      head: [...box.querySelectorAll('thead th')].map(t => t.textContent),
      rows: [...box.querySelectorAll('tbody tr')].map(tr => [...tr.children].map(td => td.textContent))
    };
  });
  check('the desk tallies each option and lists every team with its answer, stake and time',
    answersView.head.join('/') === 'Team/Answer/Points/When' && answersView.rows.length === 2 &&
    answersView.rows[0][0] === 'Galahs' && answersView.rows[0][1] === 'Black' &&
    answersView.rows[0][2] === '200' && answersView.rows[0][3].indexOf('Oct') !== -1,
    JSON.stringify(answersView.rows));
  check('the hidden team is kept out of the table and the tally alike',
    answersView.note.indexOf('2 teams') === 0 &&
    answersView.counts[0] === 'Black — 1 team · 200 points' && answersView.counts[1] === 'Red — 1 team · 50 points',
    JSON.stringify({ note: answersView.note, counts: answersView.counts }));

  // settling moves points, so the winning option is typed back first
  await dash.$$eval('#desk-question .qg-ask-responses button', bs => bs.find(b => b.textContent === 'Settle').click());
  await dash.waitForTimeout(200);
  await dash.fill('#desk-question .qg-ask-responses .inline input', 'Blue');
  await dash.$$eval('#desk-question .qg-ask-responses .inline button', bs => bs.find(b => b.textContent === 'Settle').click());
  await dash.waitForTimeout(200);
  check('a mistyped winner settles nothing', sent.settled.length === 0, JSON.stringify(sent.settled));
  await dash.fill('#desk-question .qg-ask-responses .inline input', 'Black');
  await dash.$$eval('#desk-question .qg-ask-responses .inline button', bs => bs.find(b => b.textContent === 'Settle').click());
  await dash.waitForTimeout(400);
  check('the winner typed back settles the wager',
    sent.settled.length === 1 && sent.settled[0].key === 'LQ2' && sent.settled[0].winner === 'Black',
    JSON.stringify(sent.settled[0] || null));

  console.log('dashboard errors', dashErrors);
  check('no dashboard page errors', dashErrors.length === 0, dashErrors.join(' | '));

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  await b.close();
  if (server) server.kill();
  process.exit(fail ? 1 : 0);
})();
