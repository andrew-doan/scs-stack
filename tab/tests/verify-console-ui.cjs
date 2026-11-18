// The console page in a real browser against stubbed API routes:
// login gate, score entry posting the right payload, the import
// preview pills with commit arming, staleness on edit, the day board,
// review claims and the times that go out as UTC.
// Run with: node tests/verify-console-ui.cjs
// Needs playwright installed nearby (npm i playwright) and a Chromium
// (CHROMIUM_PATH env, or playwright's own download).
const { chromium } = require('playwright');
let HTML;
const htmlReady = import('../src/console-page.js').then(m => { HTML = m.consolePage(); });
let fail = 0;
const check = (l, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + l + (d ? '  ' + d : '')); if (!ok) fail++; };

(async () => {
  await htmlReady;
  const b = await chromium.launch(
    process.env.CHROMIUM_PATH || require('fs').existsSync('/opt/pw-browsers/chromium')
      ? { executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' }
      : {});
  // the dashboard is read in Sydney; every stamp it sends must still be UTC
  const p = await b.newPage({ serviceWorkers: 'block', viewport: { width: 1100, height: 900 }, timezoneId: 'Australia/Sydney' });
  // A read this suite does not stub answers "not ok", which the page
  // takes as nothing to show. Left to the network it fails at a moment
  // of its own, and its "Could not reach the worker." toast lands on
  // whichever check is reading the toast then. Registered first, so
  // every stub below takes precedence.
  await p.route(u => u.pathname.indexOf('/api/console/') === 0, r => {
    if (r.request().method() !== 'GET') return r.fallback();
    return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":false}' });
  });
  const calls = { adjust: [], voids: [], reopen: [], commit: 0, freeze: [], close: [], claim: [], exports: 0, msgSave: [] };
  let frozenState = { ok: true, frozen: false, frozen_at: null };
  let closedState = false;
  // three saved copies of the standings, newest first, and the board in each
  const copyList = [
    { id: 3, taken_at: '2026-10-20 04:00:00', kind: 'hour', taken_by: 'schedule', teams: 2, top: [{ name: 'Galahs', points: 4467 }] },
    { id: 2, taken_at: '2026-10-20 03:30:00', kind: 'freeze', taken_by: 'Alex', teams: 2, top: [{ name: 'Galahs', points: 4200 }] },
    { id: 1, taken_at: '2026-10-20 03:00:00', kind: 'hour', taken_by: 'schedule', teams: 2, top: [{ name: 'Trubbish', points: 4000 }] }
  ];
  const boards = {
    1: [{ rank: 1, name: 'Trubbish', points: 4000 }, { rank: 2, name: 'Galahs', points: 3900 }],
    2: [{ rank: 1, name: 'Galahs', points: 4200 }, { rank: 2, name: 'Trubbish', points: 4050 }],
    3: [{ rank: 1, name: 'Galahs', points: 4467 }, { rank: 2, name: 'Trubbish', points: 4100 }]
  };
  const tabNow = () => Object.assign({}, frozenState, {
    closed: closedState, closed_at: closedState ? '2026-10-20 05:00:00' : null, copies: copyList
  });

  await p.route('**/api/console/log*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, entries: [{ id: 9, at: '2026-08-30 06:00:00', action: 'score-set', team_name: 'Galahs', quest_code: 'S200', points_delta: 300, old_total: 4167, new_total: 4467, actor: 'console:Alex' }]
  }) }));

  await p.route('**/api/console/freeze', async r => {
    if (r.request().method() === 'POST') {
      const body = r.request().postDataJSON();
      calls.freeze.push(body);
      frozenState = body.frozen
        ? { ok: true, frozen: true, frozen_at: '2026-10-20 14:30:00' }
        : { ok: true, frozen: false, frozen_at: null };
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tabNow()) });
  });
  await p.route('**/api/console/freeze/close', async r => {
    const body = r.request().postDataJSON();
    calls.close.push(body);
    closedState = !!body.closed;
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, closed: closedState }) });
  });
  await p.route(url => url.pathname === '/api/console/freeze/copy', async r => {
    const id = Number(new URL(r.request().url()).searchParams.get('id'));
    const at = copyList.findIndex(c => c.id === id);
    const before = copyList[at + 1];
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, copy: Object.assign({}, copyList[at], { teams: boards[id] }),
      before: before ? Object.assign({}, before, { teams: boards[before.id] }) : null
    }) });
  });
  await p.route('**/fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  // the pictures to paste into a chat are drawn by the site's own script
  await p.route('https://scs.andyrew.space/assets/share-image.js', r => r.fulfill({ status: 200, contentType: 'application/javascript',
    body: require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'website', 'assets', 'share-image.js'), 'utf8') }));
  await p.route(url => url.pathname === '/api/console/standings', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, teams: [{ rank: 1, dnf: false, name: 'Galahs', points: 4467, quests_done: 12 }, { rank: null, dnf: true, name: 'Trubbish', points: 4100, quests_done: 11 }]
  }) }));
  await p.route('https://tab.example/console', r => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
  // Signing in takes a code as well as the password, and a name that
  // has never signed in is answered with a secret to enrol rather than
  // a session. This stub is the worker's side of that agreement, and
  // logins[] is what the page actually sent.
  const logins = [];
  await p.route('**/api/console/login', async r => {
    const body = r.request().postDataJSON();
    logins.push(body);
    if (body.password !== 'tab-pass') {
      await r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'wrong password' }) });
      return;
    }
    if (body.name === 'Newbie' && !body.code) {
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, enrol: true, name: body.name, secret: 'ABCD EFGH IJKL MNOP QRST UVWX',
        otpauth: 'otpauth://totp/SCS.2:Newbie?secret=ABCDEFGH',
        qr: 'data:image/svg+xml;base64,PHN2Zy8+'
      }) });
      return;
    }
    if (body.name === 'Newbie') {
      await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, session: 'sess-1', name: body.name,
        backup_codes: ['AAAA-1111', 'BBBB-2222', 'CCCC-3333']
      }) });
      return;
    }
    if (!body.code) {
      await r.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'wrong code', needs_code: true }) });
      return;
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, session: 'sess-1', name: body.name || 'console' }) });
  });
  const authResets = [];
  await p.route('**/api/console/auth/reset', async r => {
    authResets.push({ method: r.request().method(), body: r.request().postDataJSON() });
    await r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
  });
  // What the signed-in account may use. The checks near the end swap it
  // for an account that only reviews.
  const ALL_TABS = ['scores', 'review', 'quests', 'teams', 'messages', 'push', 'email', 'rego', 'files', 'discord', 'settings', 'log'];
  let meState = { ok: true, name: 'Alex', admin: true, perms: ALL_TABS, code: true };
  await p.route('**/api/console/me', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(meState) }));
  const accountsState = {
    ok: true, failed_last_hour: 2, human_check: false, second_password: true, perms: ALL_TABS,
    users: [{ name: 'Alex', admin: true, perms: ALL_TABS, require_2fa: true, own_password: true, confirmed_at: '2026-10-19 08:00:00',
              created_at: '2026-10-19 07:59:00', created_by: '', last_seen: '2026-10-20 07:10:00', codes_left: 9 },
            { name: 'Sam', admin: false, perms: ['review', 'messages'], require_2fa: true, own_password: true, confirmed_at: '2026-10-19 08:05:00',
              created_at: '2026-10-19 08:04:00', created_by: 'Alex', last_seen: '2026-10-20 06:50:00', codes_left: 10 }],
    guards: [{ key: 'push', label: 'Sending a push notification', on: true },
             { key: 'freeze', label: 'Freezing or unfreezing the tab', on: false }],
    attempts: [{ at: '2026-10-20 07:10:00', name: 'Alex', ip: 'ip:0a1b2c3d', outcome: 'ok', detail: 'code' },
               { at: '2026-10-20 07:09:00', name: 'Mallory', ip: 'ip:99887766', outcome: 'bad-code', detail: '' }]
  };
  await p.route('**/api/console/accounts', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(accountsState) }));
  const accountSaves = [];
  await p.route('**/api/console/accounts/save', async r => {
    accountSaves.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(accountsState) });
  });
  const secondSets = [];
  await p.route('**/api/console/guards/set', async r => {
    const second = r.request().headers()['x-second-password'] || '';
    if (!second) {
      await r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({
        error: 'This needs the second password.', second_password: true, wrong: false, what: 'Changing this' }) });
      return;
    }
    secondSets.push({ body: r.request().postDataJSON(), second: second });
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(accountsState) });
  });
  await p.route('**/api/console/overview', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true,
    teams: [{ id: 7, name: 'Galahs', pts: 4167, quests_done: 12 }, { id: 8, name: 'S.S. Crab', pts: 3100, quests_done: 9 }, { id: 9, name: 'Test Run', pts: 0, quests_done: 0, hidden: 1 }],
    quests: [{ code: 'MQ1', norm: 'MQ1', points: 800, teams_done: 5 }, { code: 'S200', norm: 'S200', points: 150, teams_done: 1 }]
  }) }));
  const questsPayload = {
    ok: true,
    groups: [{ id: 1, key: 'SQ40', name: 'Wondabyne', region: 'Exploration Region', description: 'Whole team on the platform.\n\n**Note:** request stop.',
      flavour: 'No roads lead here.', location: 'Wondabyne Station', coords: [{ label: 'Wondabyne', lat: -33.49, lng: 151.25 }],
      submit: 'none', prompt: '', options: [], sort: 1, hidden: 0, visibility: 'everyone', opens_at: '', tags: [], audiences: [],
      codes: [{ code: 'SQ40', label: '', points: 950, sort: 0, hidden: 0 }] },
    { id: 2, key: 'SQ41', name: 'Early look', region: 'Exploration Region', description: '', flavour: '', location: '', coords: [],
      submit: 'none', prompt: '', options: [], sort: 2, hidden: 0, visibility: 'groups', opens_at: '', tags: [2], audiences: [3],
      codes: [{ code: 'SQ41', label: '', points: 100, sort: 0, hidden: 0 }] },
    { id: 3, key: 'SQ1-o', name: 'Last year', region: 'Exploration Region', description: '', flavour: '', location: '', coords: [],
      submit: 'none', prompt: '', options: [], sort: 3, hidden: 1, visibility: 'everyone', opens_at: '', tags: [1], audiences: [],
      codes: [{ code: 'SQ1-o', label: '', points: 50, sort: 0, hidden: 1 }] }],
    loose: [{ code: 'S200', label: '', points: 150, sort: 0, hidden: 0 }],
    regions: [{ id: 1, name: 'Exploration Region', sort: 1, quests: 1 }, { id: 2, name: 'Clubs Region', sort: 2, quests: 0 }],
    tags: [{ id: 1, name: 'Old', dash_hidden: 1, sort: 0, quests: 1 }, { id: 2, name: 'Wave 1', dash_hidden: 0, sort: 0, quests: 1 }],
    // Test Run (9) is hidden from the dashboard's lists but in the group
    audiences: [{ id: 3, name: 'Preview', team_ids: [7, 9] }]
  };
  await p.route('**/api/console/quests', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(questsPayload) }));
  // a region's quests put in order: answered with the list, as the worker does
  const questOrders = [];
  await p.route('**/api/console/quests/order', async r => {
    const body = r.request().postDataJSON();
    questOrders.push(body);
    const groups = body.ids.map(id => questsPayload.groups.find(g => g.id === id));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Object.assign({}, questsPayload, { groups })) });
  });
  // who can see a quest: what the page sends the worker
  const access = { set: [], save: [], openAll: [], teamGroup: [] };
  const recordJson = (list, answer) => async r => {
    const body = r.request().postDataJSON();
    list.push(body);
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(answer(body)) });
  };
  await p.route('**/api/console/quests/group/access', recordJson(access.set, b => ({ ok: true,
    group: { id: b.id, key: b.id === 1 ? 'SQ40' : 'SQ77', hidden: b.visibility === 'organisers' ? 1 : 0, visibility: b.visibility, opens_at: b.opens_at || '', tags: [], audiences: b.audiences || [] } })));
  await p.route('**/api/console/quests/group/save', recordJson(access.save, b => ({ ok: true, group: { id: b.id || 5, key: b.key } })));
  await p.route('**/api/console/quests/open-all', recordJson(access.openAll, () => ({ ok: true, opened: 1 })));
  await p.route('**/api/console/quests/team-groups/save', recordJson(access.teamGroup, () => ({ ok: true, id: 3 })));
  await p.route('**/api/console/quests/visible*', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, keys: r.request().url().includes('team_id=0') ? ['SQ40'] : ['SQ40', 'SQ41'] }) }));
  let regoGuard = { ok: true, closed: false, cap: 0, people: 2, turnstile: false };
  const guardSets = [];
  await p.route('**/api/console/rego/settings/set', async r => {
    const body = r.request().postDataJSON();
    guardSets.push(body);
    regoGuard = { ok: true, closed: !!body.closed, cap: body.cap, people: 2, turnstile: false };
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(regoGuard) });
  });
  await p.route('**/api/console/rego/settings', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(regoGuard) }));
  // what a photo says about itself, read from the block the worker
  // took off it at upload
  const metaCalls = [];
  // rebuilding the clean copies: the page keeps asking until the
  // worker says it is done
  const recleanCalls = [];
  await p.route('**/api/console/files/reclean', r => {
    const body = r.request().postDataJSON();
    recleanCalls.push(body.after);
    const done = recleanCalls.length >= 3;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, done: done, checked: done ? 4 : 12, removed: done ? 1 : 5, after: recleanCalls.length * 12
    }) });
  });
  // the Storage card's count: two answers, the second picked up by the
  // cursor the first handed back
  const storageCalls = [];
  await p.route(u => u.pathname === '/api/console/storage', r => {
    const cursor = new URL(r.request().url()).searchParams.get('cursor') || '';
    storageCalls.push(cursor);
    const body = cursor
      ? { ok: true, done: true, cursor: '', listed: 2,
          places: { 'proof|photo': { n: 1, bytes: 1048576 }, 'proof|copy720': { n: 1, bytes: 2097152 } },
          types: { 'image/jpeg': { n: 1, bytes: 1048576 } },
          largest: [{ key: 'rnd/b', name: 'IMG_2.mov', area: 'proof', kind: 'copy720', bytes: 2097152 }] }
      : { ok: true, done: false, cursor: 'page-2', listed: 3,
          places: { 'proof|photo': { n: 2, bytes: 3145728 }, 'proof|unlinked': { n: 1, bytes: 1024 } },
          types: { 'image/jpeg': { n: 2, bytes: 3145728 } },
          largest: [{ key: 'sub/a', name: 'IMG_1.jpg', area: 'proof', kind: 'photo', bytes: 2097152 }],
          database: { bytes: 5242880, tables: [{ name: 'submissions', rows: 40 }, { name: 'teams', rows: 3 }] },
          teams: [{ name: 'Galahs', hidden: false, n: 3, bytes: 4194304 }], albums: [] };
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  // personal data and the original videos (privacy.ts, originals.ts):
  // what the page sends each one
  const privacyCalls = { remove: [], restore: [], deletes: [], asked: 0 };
  const personalCopy = { kind: 'scs2-personal-data', version: 1, exported_at: '2026-11-04 01:00:00', exported_by: 'Alex',
    people: [{ id: 1, name: 'Alice', team: 'Galahs', zid: 'z1234567', email: 'a@example.com', dietary: '' },
      { id: 2, name: 'Ben', team: 'Galahs', zid: 'z7654321', email: 'b@example.com', dietary: 'Vegan' }],
    eoi: [], email_queue: [], checkin: { people: [] } };
  await p.route(u => u.pathname === '/api/console/privacy', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, stored: { people: 2, emails: 2, zids: 2, dietary: 1, eoi: 0, queue: 0 }, removed: null,
    checkin: { connected: true, reached: true, people: 2, emails: 2, zids: 2 }
  }) }));
  await p.route('**/api/console/privacy/export', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, copy: personalCopy, file: 'scs2-personal-data-2026-11-04.json' }) }));
  await p.route('**/api/console/privacy/remove', r => {
    privacyCalls.remove.push(r.request().postDataJSON());
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, people: 2, eoi: 0, queue: 0, checkin: 2, note: '' }) });
  });
  await p.route(u => u.pathname === '/api/console/originals', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, ready: true, kept: 5, kept_bytes: 5368709120, saved: 5, deletable: 4, deletable_bytes: 4294967296, unencoded: 1, gone: 0
  }) }));
  // guarded: refused until the second password comes in the header
  await p.route('**/api/console/originals/delete', r => {
    const body = r.request().postDataJSON();
    const second = r.request().headers()['x-second-password'] || '';
    if (second !== 'push-pass') {
      privacyCalls.asked++;
      return r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({
        error: 'This needs the second password.', second_password: true, wrong: !!second, what: 'Deleting original videos' }) });
    }
    privacyCalls.deletes.push(body.after);
    const last = privacyCalls.deletes.length >= 2;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, deleted: 2, freed: 2147483648, kept: 0, after: privacyCalls.deletes.length * 40, done: last
    }) });
  });
  await p.route('**/api/console/file/meta*', r => {
    metaCalls.push(r.request().url());
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, name: 'proof.jpg', type: 'image/jpeg', has_exif: true,
      taken_at: '2026-10-20 09:14:02', modified_at: '2026-10-20 11:03:11',
      gps: { lat: -33.883, lng: 151.2063 }, make: 'Apple', model: 'iPhone 15 Pro',
      software: '18.2', lens: 'iPhone 15 Pro back camera', maker_note: true,
      signals: ['camera: Apple iPhone 15 Pro', 'last written 2026-10-20 11:03:11, taken 2026-10-20 09:14:02'],
      verdict: 'edited or re-saved'
    }) });
  });
  await p.route('**/api/console/codes', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, codes: [{ name: 'Galahs', code: 'GARB-1' }, { name: 'S.S. Crab', code: '' }, { name: 'Test Run', code: 'TEST-9' }]
  }) }));
  // the numbers the Scores tab can change, and what the worker still has
  const limitDefaults = { submit_max_pending: 12, album_anyone_per_hour: 40 };
  let limits = Object.assign({}, limitDefaults);
  const limitSaves = [];
  await p.route('**/api/console/limits', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, limits, defaults: limitDefaults }) }));
  await p.route('**/api/console/limits/set', async r => {
    const body = r.request().postDataJSON();
    limitSaves.push(body.limits);
    limits = Object.assign({}, limits, body.limits);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, limits, defaults: limitDefaults }) });
  });
  await p.route('**/api/console/schedule', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, push_waiting: 1, tickets_waiting: 2, emails_waiting: 30 }) }));
  // the home page's countdown, as a run of stops
  // a day from now, so the stop is always still ahead
  let cdStops = [{ label: 'SCS.2 starts', at: new Date(Date.now() + 864e5).toISOString().slice(0, 19).replace('T', ' ') }];
  const cdSaves = [];
  await p.route('**/api/console/flags', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, flags: { team_pages: false, recap: false } }) }));
  await p.route('**/api/console/countdown', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, stops: cdStops }) }));
  await p.route('**/api/console/countdown/set', async r => {
    const body = r.request().postDataJSON();
    cdSaves.push(body.stops);
    cdStops = body.stops;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, stops: cdStops }) });
  });
  // the files OrgComm drops in and the short links that point at them
  const dropFile = {
    key: 'drop/abc123def456', name: 'Day Two Poster.png', type: 'image/png', bytes: 240000,
    note: 'Goes up in the Roundhouse', created_at: '2026-10-01 04:00:00', created_by: 'Alex',
    url: '/api/drop/drop/abc123def456/Day%20Two%20Poster.png', suggest: 'day-two-poster.png'
  };
  let dropState = {
    ok: true, host: 'go.example', api: 'https://files.example',
    files: [dropFile],
    links: [{
      slug: 'info', kind: 'url', target: 'https://scs.andyrew.space/info/', file_key: '', hits: 12,
      created_at: '2026-10-01 04:00:00', created_by: 'Alex', url: 'https://go.example/info'
    }, {
      slug: 'poster.png', kind: 'file', target: '', file_key: 'drop/abc123def456', hits: 3,
      created_at: '2026-10-01 05:00:00', created_by: 'Alex', url: 'https://go.example/poster.png'
    }]
  };
  const dropUploads = [];
  const linkSaves = [];
  const linkDeletes = [];
  const dropDeletes = [];
  await p.route('**/api/console/drop', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dropState) }));
  await p.route('**/api/console/drop/upload', async r => {
    dropUploads.push(r.request().postData() || '');
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
      Object.assign({ ok: true }, dropFile, { name: 'map.png' })) });
  });
  const dropEdits = [];
  await p.route('**/api/console/drop/edit', async r => {
    dropEdits.push(r.request().postData() || '');
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dropState) });
  });
  await p.route('**/api/console/drop/delete', async r => {
    dropDeletes.push(r.request().postDataJSON());
    dropState = Object.assign({}, dropState, { files: [], links: [] });
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dropState) });
  });
  await p.route('**/api/console/links/save', async r => {
    const body = r.request().postDataJSON();
    linkSaves.push(body);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dropState) });
  });
  await p.route('**/api/console/links/delete', async r => {
    linkDeletes.push(r.request().postDataJSON());
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(dropState) });
  });
  // the albums, and the teams the album form picks gallery photos from
  const albumState = {
    ok: true, albums: [], turnstile: true, site: 'https://scs.example',
    teams: [{ id: 7, name: 'Galahs', hidden: false, gallery: 3 }, { id: 9, name: 'Trubbish', hidden: false, gallery: 0 }]
  };
  const albumSaves = [];
  await p.route('**/api/console/albums', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(albumState) }));
  await p.route('**/api/console/albums/save', async r => {
    albumSaves.push(r.request().postDataJSON());
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(albumState) });
  });

  // the pictures the home page runs as a slideshow
  let slideRows = [
    { key: 'slide/aaa111bbb222', name: 'Quad.png', type: 'image/png', bytes: 180000,
      alt: 'Teams waiting in the quad', caption: 'Before the start', sort: 1,
      created_at: '2026-10-20 22:15:00', created_by: 'Alex' },
    { key: 'slide/ccc333ddd444', name: 'Finish.png', type: 'image/png', bytes: 210000,
      alt: 'The last team over the line', caption: '', sort: 2,
      created_at: '2026-10-20 23:40:00', created_by: 'Alex' }
  ];
  const slideSaves = [];
  const slideEdits = [];
  const slideOrders = [];
  const slideDeletes = [];
  const slideThumbs = [];
  // a 1x1 PNG, so the rows draw a real picture rather than a broken box
  const onePixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64');
  await p.route('**/api/slides/file*', r => {
    slideThumbs.push(r.request().url());
    return r.fulfill({ status: 200, contentType: 'image/png', body: onePixel });
  });
  await p.route('**/api/console/slides', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, slides: slideRows }) }));
  await p.route('**/api/console/slides/save', async r => {
    slideSaves.push(r.request().postData() || '');
    slideRows = slideRows.concat([{
      key: 'slide/eee555fff666', name: 'Ceremony.png', type: 'image/png', bytes: 90000,
      alt: 'The prizes being handed out', caption: '', sort: 3,
      created_at: '2026-10-21 08:00:00', created_by: 'Alex'
    }]);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, key: 'slide/eee555fff666', name: 'Ceremony.png', slides: slideRows }) });
  });
  const slideHides = [];
  await p.route('**/api/console/slides/hide', async r => {
    const body = JSON.parse(r.request().postData() || '{}');
    slideHides.push(body);
    slideRows = slideRows.map(s => body.keys.includes(s.key) ? Object.assign({}, s, { hidden: body.hidden ? 1 : 0 }) : s);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, slides: slideRows }) });
  });
  const slideFocuses = [];
  await p.route('**/api/console/slides/focus', async r => {
    const body = JSON.parse(r.request().postData() || '{}');
    slideFocuses.push(body);
    slideRows = slideRows.map(s => s.key === body.key ? Object.assign({}, s, { focus_x: body.x, focus_y: body.y }) : s);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, slides: slideRows }) });
  });
  await p.route('**/api/console/slides/edit', async r => {
    const body = r.request().postDataJSON();
    slideEdits.push(body);
    slideRows = slideRows.map(s => s.key === body.key
      ? Object.assign({}, s, { alt: body.alt, caption: body.caption }) : s);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, slides: slideRows }) });
  });
  await p.route('**/api/console/slides/order', async r => {
    const body = r.request().postDataJSON();
    slideOrders.push(body.keys);
    slideRows = body.keys.map((k, i) =>
      Object.assign({}, slideRows.filter(s => s.key === k)[0], { sort: i + 1 }));
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, slides: slideRows }) });
  });
  await p.route('**/api/console/slides/delete', async r => {
    const body = r.request().postDataJSON();
    slideDeletes.push(body);
    slideRows = slideRows.filter(s => s.key !== body.key);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, slides: slideRows }) });
  });

  // the confirmation email's three sender shapes: only the first two
  // carry the name, so the test send has to say which one went out
  const emailTests = [];
  let emailShape = 0;
  await p.route('**/api/console/rego/email/test', async r => {
    emailTests.push(r.request().postDataJSON());
    if (emailShape === 0) {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, status: 'sent', via: 'the Email Service binding', shape: 'name and address, with a reply-to',
        name_kept: true, from: 'SCS.2 Tab Team <tab@scs.andyrew.space>', refused: [] }) });
    }
    if (emailShape === 1) {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, status: 'sent', via: 'the Email Service binding', shape: 'the whole sender as one string',
        name_kept: false, from: 'SCS.2 Tab Team <tab@scs.andyrew.space>',
        refused: [{ shape: 'name and address, with a reply-to', error: 'reply_to is not supported' },
          { shape: 'name and address', error: 'from must be a string' }] }) });
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: false, status: 'skipped', via: 'nothing configured', shape: '', name_kept: false,
      from: 'SCS.2 Tab Team <tab@scs.andyrew.space>', refused: [],
      error: 'Nothing is configured to send email.' }) });
  });
  await p.route('**/api/console/rego', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, teams: 1, people: 2, dietary: { Vegetarian: 1 }, checkin_live: true,
    registrations: [{ id: 3, team_id: 7, team_name: 'Galahs', societies: 'WestSoc; RailSoc', photo_permission: 1, questions: '', submitted_at: '2026-08-30 06:00:00',
      members: [{ id: 11, registration_id: 3, position: 1, name: 'Alice Park', zid: 'z5111111', email: 'alice@example.com', arc: 1, dietary: 'Vegetarian', discord: 'alicep', qr_url: 'https://checkin.example/qr/a.png', email_status: 'sent', checked_in_at: '2026-10-20 00:05:00', ticket_url: 'https://scs.andyrew.space/ticket/?AAAA', photo_ok: 1 },
        { id: 12, registration_id: 3, position: 2, name: 'Ben Ho', zid: 'z5222222', email: 'ben@example.com', arc: 0, dietary: '', discord: '', qr_url: null, email_status: 'failed', checked_in_at: null, ticket_url: '', photo_ok: 0 }] }]
  }) }));
  const regoCalls = [];
  let regoFail = false; // flip to make the next save answer an error
  let regoHeld = false; // flip to answer the way a save with no QR does
  await p.route('**/api/console/rego/person/save', async r => {
    regoCalls.push(r.request().postDataJSON());
    await new Promise(res => setTimeout(res, 120)); // long enough to see the busy state
    if (regoFail) {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ error: 'That zID is taken.' }) });
    }
    if (regoHeld) {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, person: { id: 12, name: 'Ben Ho', qr_url: null }, qr: 'missing',
        qr_note: 'could not reach the check-in worker at https://checkin.example', ticket_url: '', email_held: true }) });
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, person: { id: 11, name: 'Alice Park-Lee', qr_url: 'x' }, qr: 'attached' }) });
  });
  // the check-in worker is down until qrWorks is flipped, the way it
  // is for a person whose code cannot be made
  const qrCalls = [];
  const emailCalls = [];
  let qrWorks = false;
  const noQr = 'could not reach the check-in worker at https://checkin.example';
  await p.route('**/api/console/rego/person/qr', async r => {
    qrCalls.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(qrWorks
      ? { ok: true, name: 'Ben Ho', qr: 'attached', qr_note: null, ticket_url: 'https://scs.andyrew.space/ticket/?BBBB' }
      : { ok: false, name: 'Ben Ho', qr: 'missing', qr_note: noQr, error: 'No QR code for Ben Ho: ' + noQr }) });
  });
  await p.route('**/api/console/rego/email', async r => {
    const body = r.request().postDataJSON();
    emailCalls.push(body);
    if (!qrWorks && !body.force) {
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: false, needs_qr: true, name: 'Ben Ho', qr: 'missing', qr_note: noQr, error: 'No QR code for Ben Ho: ' + noQr }) });
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, status: 'sent', name: 'Ben Ho', qr: qrWorks ? 'attached' : 'missing', sent_without_qr: !qrWorks }) });
  });
  await p.route('**/api/console/discord/status', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, configured: true, bot: { id: '9', username: 'scs-tab' }, servers: [{ id: '222', name: 'Test Server' }],
    guilds: [{ guild_id: '111', name: 'SCS Sydney', organiser_role_id: '55', category_name: 'Private Channels', category_id: null, enabled: 1, in_server: true, teams_setup: 1, verified: 2 }],
    teams: [{ id: 7, name: 'Galahs', hidden: 0, registrations: 1, verified: 2, guilds: { '111': { role_id: '77', channel_id: '88', role_name: 'Galahs', channel_name: 'galahs' } } },
      { id: 8, name: 'S.S. Crab', hidden: 0, registrations: 1, verified: 0, guilds: {} }],
    members: [{ guild_id: '111', user_id: '5', username: 'alicep', verified_at: '2026-08-30 07:00:00', team_name: 'Galahs', person: 'Alice Park' }]
  }) }));
  await p.route('**/api/console/discord/guild?*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, roles: [{ id: '55', name: 'OrgCom' }, { id: '56', name: 'Galahs' }, { id: '57', name: 'No Team Assigned' }],
    channels: [{ id: '1', name: 'general', type: 0, parent_id: null }, { id: '2', name: 'Private Channels', type: 4, parent_id: null }, { id: '88', name: 'galahs', type: 0, parent_id: '2' }]
  }) }));
  const guildSaves = [];
  await p.route('**/api/console/discord/guild/save', async r => {
    guildSaves.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, guild_id: '111', note: '' }) });
  });
  // one request per team, each answering with who got the role
  const discordSetups = [];
  await p.route('**/api/console/discord/setup', async r => {
    const b = r.request().postDataJSON();
    discordSetups.push(b);
    const name = b.team_id === 7 ? 'Galahs' : 'S.S. Crab';
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, failed: [],
      done: [{ team: name, role: name, channel: name, made: { role: b.team_id === 8, category: false, channel: b.team_id === 8 },
        given: b.team_id === 7 ? 2 : 1, missing: b.team_id === 8 ? ['sscrab3'] : [], skipped: [] }] }) });
  });
  const holds = [];
  await p.route('**/api/console/discord/hold', async r => {
    holds.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, held: holds[holds.length - 1].held }) });
  });
  const discordPosts = [];
  await p.route('**/api/console/discord/post', async r => {
    discordPosts.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: '1' }) });
  });
  const dot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64');
  await p.route('**/api/console/file*', r => r.fulfill({ status: 200, contentType: 'image/png', body: dot }));
  const reviewAsks = [];
  await p.route('**/api/console/submissions*', r => { reviewAsks.push(r.request().url()); return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, counts: [{ key: 'SQ41', name: 'Ferry', n: 3, hidden: 1 }, { key: 'SQ40', name: 'Wondabyne', n: 1, hidden: 0 }],
    team_counts: [{ id: 9, name: 'Test Run', n: 1, hidden: 1 }, { id: 8, name: 'S.S. Crab', n: 2, hidden: 0 }, { id: 7, name: 'Galahs', n: 1, hidden: 0 }], submissions: [{ id: 9, team_name: 'Galahs', quest_code: 'SQ40', quest_name: 'Wondabyne', group_key: 'SQ40', points: 950,
      note: 'Platform crew', status: 'pending', submitted_at: '2026-10-20 01:00:00', gallery: 0, answer: null, codes: [],
      claimed_by: 'Sam', claimed_at: '2026-10-20 01:02:00', credited: { SQ40: 1 },
      media: [{ key: 'sub/9/imgkey', type: 'image/jpeg', bytes: 2048000, name: 'platform.jpg' },
        { key: 'sub/9/vidkey', type: 'video/quicktime', bytes: 40960000, name: 'platform.mov' }] },
    { id: 8, team_name: 'S.S. Crab', quest_code: 'SQ41', quest_name: 'Ferry', group_key: 'SQ41', points: 100,
      note: '', status: 'rejected', submitted_at: '2026-10-20 00:40:00', reviewed_by: 'Alex',
      reason: 'The second casino is out of frame.', gallery: 0, answer: null, codes: [],
      claimed_by: '', claimed_at: '', credited: {}, media: [] }]
  }) }); });
  await p.route('**/api/console/review/claim', async r => {
    calls.claim.push(r.request().postDataJSON());
    await r.fulfill({ status: 409, contentType: 'application/json',
      body: JSON.stringify({ error: 'Sam is reviewing this one.', claimed_by: 'Sam' }) });
  });
  await p.route('**/api/console/board', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, pending: 3, oldest_pending_at: '2026-10-20 01:00:00',
    per_hour: [{ hour: '2026-10-20 00:00', submissions: 4 }, { hour: '2026-10-20 01:00', submissions: 7 }],
    teams: { total: 43, hidden: 1 }, checkin: { registered: 120, checked_in: 88, live: true },
    push_subs: 57, encoder: { waiting: 2, encoding: 1, done: 9, online: 1 }, frozen: false
  }) }));
  await p.route('**/api/console/export/all', r => {
    calls.exports++;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, exported_at: '2026-10-20 06:00:00', push_subs_count: 57,
      tables: { teams: [{ id: 7, name: 'Galahs' }], completions: [] }
    }) });
  });
  await p.route('**/api/console/messages/list', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, messages: [{ id: 4, title: 'Halfway briefing', body: 'Read this at noon.', created_at: '2026-10-20 01:00:00',
      updated_at: null, hidden: 1, archived: 0, urgency: 'normal', sort: 0, publish_at: '2026-10-20 03:30:00', files: [],
      visibility: 'everyone', audiences: [] }],
    team_groups: [{ id: 3, name: 'Night crew', teams: 2 }]
  }) }));
  await p.route('**/api/console/counters', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, counters: { quests: 3, messages: 5 } }) }));
  await p.route('**/api/console/messages/save', async r => {
    calls.msgSave.push(r.request().postData() || '');
    await r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ok: true, id: 5, title: 'Halfway briefing', hidden: 1, urgency: 'normal', publish_at: '2026-10-20 03:30:00', added: 0 }) });
  });
  await p.route('**/api/console/ledger/adjust', async r => {
    calls.adjust.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: 40, team: 'S.S. Crab', code: 'S200', points: -25, total: 575 }) });
  });
  await p.route('**/api/console/ledger/void', async r => {
    calls.voids.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: 61, team: 'S.S. Crab', total: 500 }) });
  });

  await p.goto('https://tab.example/console');
  await p.waitForTimeout(300);
  check('the login card gates the console', await p.isVisible('#login') && !(await p.isVisible('#main')), '');

  await p.fill('#login-pass', 'wrong');
  await p.click('#login-btn');
  await p.waitForTimeout(250);
  check('a wrong password stays put with the server message',
    (await p.textContent('#login-error')).includes('wrong password'), '');

  // A name nobody has used is answered with a secret rather than a
  // session. The page has to put the picture up and keep the card open.
  await p.fill('#login-name', 'Newbie');
  await p.fill('#login-pass', 'tab-pass');
  await p.click('#login-btn');
  await p.waitForTimeout(350);
  check('a name with no code set up gets the QR and stays on the card',
    await p.isVisible('#enrol') && !(await p.isVisible('#main')) &&
    (await p.getAttribute('#enrol-qr', 'src')).startsWith('data:image/svg+xml') &&
    (await p.textContent('#enrol-secret')).includes('ABCD'), '');

  await p.fill('#login-code', '123456');
  await p.click('#login-btn');
  await p.waitForTimeout(400);
  check('the code goes with the password, under the name the worker reads',
    logins[logins.length - 1].code === '123456' && logins[logins.length - 1].password === 'tab-pass', '');
  // The human check rides on the same request. The widget is
  // Cloudflare's and there is no network here, so the field is empty —
  // what matters is that it is sent under the name the worker reads,
  // and that the worker only insists on it after a refusal.
  check('and the human check rides with it', 'turnstile' in logins[logins.length - 1],
    JSON.stringify(Object.keys(logins[logins.length - 1])));
  check('the backup codes are printed once, and the console waits behind them',
    await p.isVisible('#backup') && !(await p.isVisible('#main')) &&
    (await p.textContent('#backup-list')).includes('AAAA-1111'), '');
  await p.click('#backup-done');
  await p.waitForTimeout(400);
  check('and go when they have been kept',
    !(await p.isVisible('#backup')) && await p.isVisible('#main'), '');

  await p.evaluate(() => { localStorage.clear(); });
  await p.goto('https://tab.example/console');
  await p.waitForTimeout(300);
  await p.fill('#login-name', 'Alex');
  await p.fill('#login-pass', 'tab-pass');
  await p.click('#login-btn');
  await p.waitForTimeout(300);
  check('an enrolled name without a code is refused, with the reason on the card',
    !(await p.isVisible('#main')) && (await p.textContent('#login-error')).includes('wrong code'), '');
  await p.fill('#login-code', '654321');
  await p.click('#login-btn');
  await p.waitForTimeout(400);
  check('the right password and code open the console as the named tabber',
    await p.isVisible('#main') && (await p.textContent('#who')) === 'Alex', '');
  const fileCookie = (await p.context().cookies()).find(c => c.name === 'scs_console');
  check('login arms the preview cookie, scoped to the file endpoint',
    !!fileCookie && fileCookie.path === '/api/console/file' && fileCookie.value === 'sess-1',
    JSON.stringify(fileCookie || null));

  // hidden teams: the switch keeps them out of every tab
  await p.click('.tabs button[data-tab="teams"]');
  await p.waitForTimeout(300);
  const teamsShown = await p.$$eval('#team-rows tr', trs => trs.map(t => t.querySelector('td:nth-child(2)').textContent));
  const scoreOptions = await p.$$eval('#ledger-team option', os => os.map(o => o.textContent));
  check('hidden teams are out of the Teams table and the ledger\u2019s picker by default',
    teamsShown.length === 2 && !teamsShown.some(n => n.includes('Test Run')) && !scoreOptions.some(n => n.includes('Test Run')), JSON.stringify(teamsShown));
  await p.click('#teams-hide-hidden');
  await p.waitForTimeout(200);
  const teamsAll = await p.$$eval('#team-rows tr', trs => trs.map(t => t.querySelector('td:nth-child(2)').textContent));
  check('switching it off shows them again, marked', teamsAll.length === 3 && teamsAll.some(n => n.includes('Test Run') && n.includes('hidden')), JSON.stringify(teamsAll));
  await p.click('#teams-hide-hidden');
  // the submit codes are on the same switch: a hidden team's code is
  // not handed out from here either
  await p.click('#codes-show');
  await p.waitForTimeout(300);
  const codesHidden = await p.$$eval('#codes-rows tr', trs => trs.map(t => t.querySelector('td').textContent));
  check('the submit codes leave hidden teams out too',
    codesHidden.length === 2 && !codesHidden.includes('Test Run'), JSON.stringify(codesHidden));
  await p.click('#teams-hide-hidden');
  await p.waitForTimeout(200);
  const codesAll = await p.$$eval('#codes-rows tr', trs => trs.map(t => t.querySelector('td').textContent));
  check('switching the hide off redraws the open codes table with them back',
    codesAll.length === 3 && codesAll.includes('Test Run'), JSON.stringify(codesAll));
  await p.click('#teams-hide-hidden');
  // a team group lists the teams the switch shows; saving it must not
  // drop the member the switch is hiding
  await p.evaluate(() => {
    const label = [...document.querySelectorAll('#team-groups .qg-picks label')].find(l => l.textContent === 'S.S. Crab');
    label.querySelector('input').click();
    [...document.querySelectorAll('#team-groups button')].find(b => b.textContent === 'Save').click();
  });
  await p.waitForTimeout(300);
  check('saving a team group keeps the members the hidden-teams switch is hiding',
    access.teamGroup.length === 1 && access.teamGroup[0].id === 3 &&
    access.teamGroup[0].team_ids.slice().sort().join() === '7,8,9', JSON.stringify(access.teamGroup));
  check('there is no Import tab, the Points tab is a quest\'s Desk, and Review is the Queue with no status to pick',
    (await p.$$eval('.tabs button[data-tab]', bs => bs.map(b => b.dataset.tab))).indexOf('import') === -1 &&
    (await p.textContent('.tabs button[data-tab="desk"]')) === 'Desk' && !(await p.$('.tabs button[data-tab="points"]')) &&
    (await p.textContent('.tabs button[data-tab="review"]')).startsWith('Queue') && !(await p.$('#review-status')), '');

  // review proof: small copies in the grid, full preview in place
  await p.click('.tabs button[data-tab="review"]');
  await p.waitForTimeout(400);
  // a video is its still too: a video element per card had Firefox on
  // a Mac flickering with HDR video on screen
  const reviewImgs = await p.$$eval('#review-list .review-media img', els => els.map(e => e.src));
  const inlineVideos = await p.$$eval('#review-list video', els => els.length);
  check('review thumbnails ask for the small copy, a video\'s included, and no video loads in the list',
    reviewImgs.length === 2 && reviewImgs.every(u => u.includes('thumb=1')) && inlineVideos === 0,
    JSON.stringify({ reviewImgs, inlineVideos }));
  await p.click('#review-list .review-media img');
  await p.waitForTimeout(300);
  const pv = await p.evaluate(() => {
    const o = document.querySelector('.preview-overlay');
    return o ? { full: o.querySelector('img').src.includes('key=') && !o.querySelector('img').src.includes('thumb=1') } : null;
  });
  check('clicking proof previews the full photo over the dashboard', !!pv && pv.full, JSON.stringify(pv));
  // The site serves the copy with the metadata taken off, so this
  // panel is the only place where the photo is asked where it was
  // taken and whether it has been written to since.
  await p.waitForTimeout(400);
  const meta = await p.evaluate(() => {
    const box = document.querySelector('.preview-meta');
    if (!box) return null;
    return {
      verdict: box.querySelector('.preview-verdict').textContent,
      off: box.querySelector('.preview-verdict').classList.contains('is-off'),
      text: box.textContent.replace(/\s+/g, ' '),
      map: (box.querySelector('a') || {}).href || ''
    };
  });
  check('the preview says where the photo was taken, on what, and that it has been re-saved',
    !!meta && meta.verdict === 'edited or re-saved' && meta.off &&
    /Apple iPhone 15 Pro/.test(meta.text) && /-33\.883000, 151\.206300/.test(meta.text) &&
    meta.map.includes('mlat=-33.883'), JSON.stringify(meta));
  check('and asked for the block, not the picture',
    metaCalls.length === 1 && metaCalls[0].includes('key='), JSON.stringify(metaCalls));
  await p.keyboard.press('Escape');
  await p.waitForTimeout(200);
  check('Escape closes the dashboard preview', await p.evaluate(() => !document.querySelector('.preview-overlay')), '');
  await p.click('#review-list .review-video');
  await p.waitForTimeout(200);
  const played = await p.evaluate(() => {
    const v = document.querySelector('.preview-overlay video');
    return v ? v.getAttribute('src') : null;
  });
  await p.keyboard.press('Escape');
  check('a video plays in the preview, its largest copy', !!played && played.includes('vidkey') && played.includes('res=1080'), String(played));

  // claims, the already-credited warning and a stored rejection reason
  await p.click('#review-list .review-card .review-head strong');
  await p.waitForTimeout(250);
  check('opening a submission claims it, once, without a button to press',
    calls.claim.length === 1 && calls.claim[0].id === 9, JSON.stringify(calls.claim));
  check('a submission someone else has says who has it, and leaves the verdict alone',
    (await p.textContent('#review-list .review-claim')).includes('Being reviewed by Sam') &&
    (await p.textContent('#toast')).includes('Sam is reviewing this one') &&
    await p.$$eval('#review-list .review-actions button', bs => bs.every(x => !x.disabled)),
    await p.textContent('#review-list .review-claim'));
  check('a team that already holds points on the quest is said so before it is credited again',
    (await p.textContent('#review-list .review-warn')).includes('already has points on SQ40'),
    await p.textContent('#review-list .review-warn'));
  check('a rejected submission shows the words the team was given',
    (await p.textContent('#review-list .review-reason')).includes('The second casino is out of frame.'),
    await p.textContent('#review-list .review-reason'));

  // one quest's submissions: the picker counts them, hidden teams left out
  const questPicks = await p.$$eval('#review-quest option', os => os.map(o => o.textContent));
  await p.selectOption('#review-quest', 'SQ41');
  await p.waitForTimeout(300);
  check('review can be narrowed to one quest, the picker counting each quest\'s submissions',
    JSON.stringify(questPicks) === JSON.stringify(['Every quest (3)', 'SQ40 · Wondabyne (1)', 'SQ41 · Ferry (2)']) &&
    /[?&]quest=SQ41(&|$)/.test(reviewAsks[reviewAsks.length - 1]),
    JSON.stringify({ questPicks, asked: reviewAsks[reviewAsks.length - 1] }));

  // the filters picked come back after a reload, and the queue asks
  // for what is waiting
  await p.reload();
  await p.waitForTimeout(800);
  const keptAsk = reviewAsks[reviewAsks.length - 1];
  check('the queue\'s filters picked are kept over a reload, and it asks for what is waiting',
    (await p.inputValue('#review-quest')) === 'SQ41' &&
    /[?&]quest=SQ41(&|$)/.test(keptAsk) && /[?&]status=pending(&|$)/.test(keptAsk),
    JSON.stringify({ keptAsk }));

  // one team's submissions in every status, from its row on the Teams tab,
  // with a line over them pointing at the team's ledger
  const receiptAsks = [];
  const line = (o) => Object.assign({ units: 1, points: 300, note: '', organiser: false, label: '', voided: null, made_at: o.at }, o);
  const ledgerAnswer = { ok: true, team: { id: 8, name: 'S.S. Crab', hidden: false, dnf: false }, total: 600, place: 2, of: 3,
    waiting: [{ id: 21, quest_code: 'SQ42', status: 'pending', submitted_at: '2026-10-20 04:00:00', name: 'Harbour' }],
    closed: [{ id: 22, quest_code: 'SQ43', status: 'rejected', reason: 'Blurry', submitted_at: '2026-10-20 04:10:00', name: 'Bridge' }],
    quests: [
      { key: 'SQ41', name: 'Ferry', times: 2, worth: 600, held: [{ code: 'SQ41', label: '', points: 300, amount: 2, worth: 600 }],
        entries: [], other: [],
        lines: [
          line({ id: 50, code: 'SQ41', kind: 'submission', source_id: 3, at: '2026-10-20 01:00:00', by: 'Alex',
            sub: { status: 'accepted', quest_code: 'SQ41', sent: '2026-10-20 00:50:00', decided: '2026-10-20 01:00:00', by: 'Alex', adjust: false, reason: '' } }),
          line({ id: 51, code: 'SQ41', kind: 'submission', source_id: 4, at: '2026-10-20 02:00:00', by: 'Sam',
            sub: { status: 'accepted', quest_code: 'SQ41', sent: '2026-10-20 01:55:00', decided: '2026-10-20 02:00:00', by: 'Sam', adjust: false, reason: '' } }),
          line({ id: 52, code: 'SQ41', kind: 'submission', source_id: 5, at: '2026-10-20 02:30:00', by: 'Sam',
            voided: { at: '2026-10-20 02:40:00', by: 'Sam', reason: 'Sent back to the queue: wrong team' },
            sub: { status: 'pending', quest_code: 'SQ41', sent: '2026-10-20 02:20:00', decided: '', by: '', adjust: false, reason: '' } })
        ] },
      { key: 'C2', name: 'Stations', times: 0, worth: 0, held: [], entries: [], other: [],
        lines: [line({ id: 61, code: 'C2', kind: 'award', source_id: 9, points: 100, units: 0.5, at: '2026-10-20 05:00:00', by: 'Alex', label: 'Points by place' }),
          line({ id: 62, code: 'C2', kind: 'balance', source_id: null, points: -100, units: -0.5, at: '2026-10-20 05:00:00', by: 'migration', label: 'From before the ledger' })] }
    ] };
  await p.route('**/api/console/team/receipt*', r => {
    receiptAsks.push(new URL(r.request().url()).search);
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ledgerAnswer) });
  });
  await p.route('**/api/console/submissions/reopen', async r => {
    calls.reopen.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: 3, team: 'S.S. Crab', was: 'accepted', total: 300 }) });
  });
  await p.click('.tabs button[data-tab="teams"]');
  await p.waitForTimeout(300);
  const teamButtons = await p.$$eval('#team-rows tr', trs => [...trs.find(t => t.textContent.includes('S.S. Crab')).querySelectorAll('button')].map(b => b.textContent));
  await p.click('.tabs button[data-tab="review"]');
  await p.waitForTimeout(200);
  await p.selectOption('#review-quest', '');
  await p.selectOption('#review-team', '8');
  await p.waitForTimeout(300);
  const teamPicks = await p.$$eval('#review-team option', os => os.map(o => o.textContent));
  const teamAsk = reviewAsks[reviewAsks.length - 1];
  const ledgerLine = await p.textContent('#review-ledger');
  check('the queue narrowed to one team counts each team\'s waiting submissions and has a line to its ledger, which a team\'s row opens too',
    ledgerLine.includes('S.S. Crab') && ledgerLine.includes('3100 points') && ledgerLine.includes('Open the ledger') &&
    teamButtons.includes('Ledger') && !teamButtons.includes('Submissions') &&
    JSON.stringify(teamPicks) === JSON.stringify(['Every team (3)', 'Galahs (1)', 'S.S. Crab (2)']) &&
    /[?&]status=pending(&|$)/.test(teamAsk) && /[?&]team_id=8(&|$)/.test(teamAsk) && !/[?&]quest=/.test(teamAsk),
    JSON.stringify({ teamPicks, asked: teamAsk, ledgerLine, teamButtons }));
  await p.click('#review-ledger button');
  await p.waitForTimeout(400);
  const ledgerHead = await p.textContent('#ledger-view .lg-head');
  const ledgerRows = await p.$$eval('#ledger-view .lg-lines li', lis => lis.map(li => li.querySelector('.lg-what').textContent + ' | ' + li.querySelector('.lg-pts').textContent));
  check('Open the ledger shows the team\'s place, what is waiting and every live line by what made it, a quest given twice marked, undone lines kept back',
    /[?&]team_id=8(&|$)/.test(receiptAsks[receiptAsks.length - 1] || '') && await p.isVisible('#view-ledger') &&
    ledgerHead.includes('600 points · 2nd of 3') && ledgerHead.includes('Waiting on review') && ledgerHead.includes('SQ42 Harbour') &&
    ledgerHead.includes('Rejected or deleted') && ledgerHead.includes('SQ43 Bridge, rejected (Blurry)') &&
    (await p.textContent('#ledger-view .lg-list')).includes('Given by 2 submissions') &&
    ledgerRows.length === 4 && ledgerRows[0].startsWith('Sent ') && ledgerRows[0].includes('accepted by Alex') && ledgerRows[0].endsWith('+300') &&
    ledgerRows[2].startsWith('Points by place, awarded by Alex') && ledgerRows[3].startsWith('From before the ledger') && ledgerRows[3].endsWith('-100'),
    JSON.stringify({ ledgerHead, ledgerRows }));
  await p.check('#ledger-voided');
  await p.waitForTimeout(150);
  const voidedRow = await p.$$eval('#ledger-view .lg-lines li.is-voided', lis => lis.map(li => li.textContent));
  check('Show undone lines brings back the undone one, struck through, saying who undid it and why',
    voidedRow.length === 1 && voidedRow[0].includes('(300)') && voidedRow[0].includes('by Sam: Sent back to the queue: wrong team'),
    JSON.stringify(voidedRow));
  await p.uncheck('#ledger-voided');
  // the ledger goes onto the clipboard as a picture
  await p.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.write = items => Promise.all(items.map(item => item.getType('image/png'))).then(blobs => {
      blobs.forEach(b => window.__copied.push({ type: b.type, size: b.size }));
    });
  });
  await p.click('#ledger-view .lg-head button:has-text("Copy as image")');
  await p.waitForFunction(() => window.__copied.length > 0, null, { timeout: 5000 }).catch(() => {});
  const copied = await p.evaluate(() => window.__copied);
  check('Copy as image puts the team\'s points on the clipboard as a PNG',
    copied.length === 1 && copied[0].type === 'image/png' && copied[0].size > 1000 && /copied as an image/.test(await p.textContent('#toast')),
    JSON.stringify(copied));
  // Undo on an award's line asks why before it sends; on a team's
  // submission it sends it back to the queue, the reason optional
  await p.$$eval('#ledger-view .lg-lines li', lis => lis[2].querySelector('.lg-acts button').click());
  await p.$$eval('#ledger-view .lg-lines li', lis => lis[2].querySelector('.lg-confirm button.danger').click());
  await p.waitForTimeout(150);
  const unsentVoid = calls.voids.length;
  await p.fill('#ledger-view .lg-lines .lg-confirm .lg-why', 'Counted the wrong stations');
  await p.$$eval('#ledger-view .lg-lines li', lis => lis[2].querySelector('.lg-confirm button.danger').click());
  await p.waitForTimeout(300);
  await p.$$eval('#ledger-view .lg-lines li', lis => [...lis[0].querySelectorAll('.lg-acts button')].find(b => b.textContent === 'Undo').click());
  const undoLabelSaid = await p.$$eval('#ledger-view .lg-lines li', lis => lis[0].querySelector('.lg-confirm button.danger').textContent);
  await p.$$eval('#ledger-view .lg-lines li', lis => lis[0].querySelector('.lg-confirm button.danger').click());
  await p.waitForTimeout(300);
  check('Undo on an award line needs a reason and sends that line; on a team\'s submission it names the points and sends it back to the queue',
    unsentVoid === 0 && calls.voids.length === 1 && calls.voids[0].id === 61 && calls.voids[0].reason === 'Counted the wrong stations' &&
    undoLabelSaid === 'Take 300 points off' && calls.reopen.length === 1 && calls.reopen[0].id === 3 && calls.reopen[0].reason === '',
    JSON.stringify({ voids: calls.voids, reopen: calls.reopen, undoLabelSaid }));
  // Adjust: the quest, the points and why, the button naming the points
  await p.click('#ledger-view .lg-head button:has-text("Adjust")');
  await p.selectOption('#ledger-view .lg-adjust select', 'S200');
  await p.fill('#ledger-view .lg-adjust input[type=number]', '-25');
  const adjustSays = await p.textContent('#ledger-view .lg-adjust button');
  await p.click('#ledger-view .lg-adjust button');
  await p.waitForTimeout(150);
  const unsentAdjust = calls.adjust.length;
  await p.fill('#ledger-view .lg-adjust .lg-why', 'Late to the finish');
  await p.click('#ledger-view .lg-adjust button');
  await p.waitForTimeout(300);
  check('Adjust names the points it moves, needs a reason, and sends the team, the quest, the points and why',
    adjustSays === 'Take 25 points off' && unsentAdjust === 0 && calls.adjust.length === 1 &&
    JSON.stringify(calls.adjust[0]) === JSON.stringify({ team_id: 8, code: 'S200', points: -25, reason: 'Late to the finish' }) &&
    /Took 25 off S\.S\. Crab/.test(await p.textContent('#toast')),
    JSON.stringify({ adjustSays, adjust: calls.adjust }));
  // Open on a line shows that one submission on the Queue, whatever its
  // state, with the way back to the queue in place of the filters
  await p.$$eval('#ledger-view .lg-lines li', lis => [...lis[0].querySelectorAll('.lg-acts button')].find(b => b.textContent === 'Open').click());
  await p.waitForTimeout(300);
  const oneAsk = reviewAsks[reviewAsks.length - 1];
  const oneLine = await p.isVisible('#review-one') ? await p.textContent('#review-one') : '';
  const filtersHidden = !(await p.isVisible('#review-quest')) && !(await p.isVisible('#review-team'));
  await p.click('#review-one button');
  await p.waitForTimeout(300);
  const backAsk = reviewAsks[reviewAsks.length - 1];
  check('Open on a ledger line shows its submission on the Queue, whatever its state, and Back to the queue goes back to what waits',
    await p.isVisible('#view-review') && /[?&]id=3(&|$)/.test(oneAsk) && !/status=/.test(oneAsk) && oneLine.includes('Back to the queue') && filtersHidden &&
    /[?&]status=pending(&|$)/.test(backAsk) && !(await p.isVisible('#review-one')) && await p.isVisible('#review-team'),
    JSON.stringify({ oneAsk, oneLine, filtersHidden, backAsk }));
  await p.selectOption('#review-team', '');
  await p.waitForTimeout(200);

  // Change on an accepted card starts from what it credited, part marks
  // included, and Save sends what the boxes then say
  const acceptedCard = { id: 12, team_name: 'Galahs', quest_code: 'SQ42', quest_name: 'Harbour', group_key: 'SQ42', points: 300,
    note: '', status: 'accepted', submitted_at: '2026-10-20 02:00:00', reviewed_by: 'Alex', reason: null, gallery: 0, answer: null,
    codes: [{ code: 'SQ42', label: 'Climbed', points: 300, scoring: 'judged' }, { code: 'SQ42-2', label: 'Whole team', points: 150, scoring: 'judged' }],
    credit: { codes: ['SQ42', 'SQ42-2'], amount: 1, amounts: { SQ42: 0.5 } }, part: { given: 300, of: 450 }, added_by: '',
    claimed_by: '', claimed_at: '', credited: { SQ42: 0.5, 'SQ42-2': 1 }, media: [], files: { kinds: ['photo'], max: 4 } };
  const acceptedList = r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, counts: [{ key: 'SQ42', name: 'Harbour', n: 1, hidden: 0 }], team_counts: [{ id: 7, name: 'Galahs', n: 1, hidden: 0 }],
    submissions: [acceptedCard] }) });
  await p.route('**/api/console/submissions*', acceptedList);
  const revisions = [];
  await p.route('**/api/console/submissions/revise', async r => {
    revisions.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, id: 12, team: 'Galahs', quest: 'SQ42', codes: ['SQ42'], amount: 1, gained: 200, full: 300, was: 300, total: 4367 }) });
  });
  await p.click('#review-refresh');
  await p.waitForTimeout(300);
  await p.$$eval('#review-list .review-actions button', bs => bs.find(b => b.textContent === 'Change').click());
  await p.waitForTimeout(150);
  const codeRows = await p.$$('#review-list .review-code');
  const filled = await p.$$eval('#review-list .review-code', rows => rows.map(r => [r.querySelector('input[type=checkbox]').checked, r.querySelector('.part-mark input').value]));
  await (await codeRows[1].$('input[type=checkbox]')).uncheck();
  await (await codeRows[0].$('.part-mark input')).fill('200');
  const worthSaid = await p.$$eval('#review-list .review-actions span.muted', ss => ss.map(s => s.textContent).join('|'));
  await p.$$eval('#review-list .review-actions button', bs => bs.find(b => b.textContent === 'Save').click());
  await p.waitForTimeout(300);
  check('Change on an accepted card starts from what it credited and sends what the boxes say',
    JSON.stringify(filled) === '[[true,"150"],[true,"150"]]' && worthSaid.includes('Worth 200 of 300 points · was 300') &&
    revisions.length === 1 && JSON.stringify(revisions[0]) === JSON.stringify({ id: 12, amount: '1', codes: ['SQ42'], awarded: { SQ42: '200' } }),
    JSON.stringify({ filled, worthSaid, revisions }));

  // Add photos on the same card sends the submission, the file under the
  // name typed for it, and the small copy made here
  const filesAdded = [];
  await p.route('**/api/console/submissions/files', async r => {
    filesAdded.push(r.request().postDataBuffer().toString('latin1'));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, id: 12, team: 'Galahs', quest: 'SQ42', added: 1, files: 1 }) });
  });
  await p.click('#review-list .review-more summary');
  const [chooser] = await Promise.all([
    p.waitForEvent('filechooser'),
    p.click('#review-list .review-more button:text-is("Add photos")')
  ]);
  await chooser.setFiles({ name: 'IMG_7.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64') });
  await p.waitForSelector('#review-list .file-row .file-rename');
  await p.fill('#review-list .file-row .file-rename', 'summit');
  await p.click('#review-list .review-actions button:text-is("Add to submission")');
  await p.waitForTimeout(400);
  const addSent = filesAdded[0] || '';
  check('Add photos on a card sends the submission, the file under the name typed for it and its small copy, and says what it added',
    filesAdded.length === 1 && /name="id"\r\n\r\n12\r\n/.test(addSent) && /name="files"; filename="summit\.png"/.test(addSent) &&
    /name="thumb0"; filename="thumb\.jpg"/.test(addSent) && /Added a photo to SQ42 for Galahs/.test(await p.textContent('#toast')),
    JSON.stringify({ sent: filesAdded.length, fields: [...addSent.matchAll(/name="([^"]+)"/g)].map(m => m[1]), toast: await p.textContent('#toast') }));
  await p.unroute('**/api/console/submissions*', acceptedList);

  // Edit answers starts from what the team said and sends the answer in
  // the shape the worker keeps
  const answeredCard = Object.assign({}, acceptedCard, { id: 13, group_id: 42,
    answer: { kind: 'choice', value: 'Manly', prompt: 'Which ferry?', more: [{ kind: 'count', value: 3, prompt: 'How many on board?' }] } });
  const answeredList = r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, counts: [], team_counts: [], submissions: [answeredCard],
    questions: { 42: [{ kind: 'choice', prompt: 'Which ferry?', options: ['Manly', 'Parramatta'] }, { kind: 'count', prompt: 'How many on board?', options: [] }] } }) });
  await p.route('**/api/console/submissions*', answeredList);
  const answerEdits = [];
  await p.route('**/api/console/submissions/answer', async r => {
    answerEdits.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await p.click('#review-refresh');
  await p.waitForTimeout(300);
  await p.$$eval('#review-list .review-actions button', bs => bs.find(b => b.textContent === 'Edit answers').click());
  await p.waitForTimeout(150);
  const startedAt = await p.evaluate(() => {
    const box = document.querySelector('#review-list .review-answer-edit');
    return box ? [box.querySelector('select').value, box.querySelector('input').value] : null;
  });
  await p.selectOption('#review-list .review-answer-edit select', 'Parramatta');
  await p.fill('#review-list .review-answer-edit input', '');
  await p.$$eval('#review-list .review-actions button', bs => bs.find(b => b.textContent === 'Save answers').click());
  await p.waitForTimeout(300);
  check('Edit answers starts from what the team said and sends what the boxes say',
    JSON.stringify(startedAt) === '["Manly","3"]' && answerEdits.length === 1 &&
    JSON.stringify(answerEdits[0]) === JSON.stringify({ id: 13, answer: { kind: 'choice', value: 'Parramatta', prompt: 'Which ferry?', more: [null] } }),
    JSON.stringify({ startedAt, answerEdits }));
  await p.unroute('**/api/console/submissions*', answeredList);

  // a pending submission for a running total shows the team's number
  // beside Accept; one put right goes in once the accept has gone through
  const countedCard = Object.assign({}, acceptedCard, { id: 15, group_id: 43, status: 'pending', partial: false, codes: [], credit: null, part: null,
    added_by: '', reviewed_by: null, tally: 'sum', answer: { kind: 'count', value: 4 } });
  const countedList = r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, counts: [], team_counts: [], submissions: [countedCard], questions: { 43: [{ kind: 'count', prompt: 'How many bridges?', options: [] }] } }) });
  await p.route('**/api/console/submissions*', countedList);
  const countCalls = [];
  await p.route('**/api/console/submissions/answer', async r => {
    countCalls.push(['answer', r.request().postDataJSON()]);
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await p.route('**/api/console/submissions/accept', async r => {
    countCalls.push(['accept', r.request().postDataJSON()]);
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, team: 'Galahs', quest: 'SQ42', amount: 1, total: 4400 }) });
  });
  await p.click('#review-refresh');
  await p.waitForTimeout(300);
  const countStart = await p.inputValue('#review-list .review-count input');
  await p.fill('#review-list .review-count input', '5');
  await p.$$eval('#review-list .review-actions button', bs => bs.find(b => b.textContent === 'Accept').click());
  await p.waitForTimeout(300);
  check('a running total\'s number shows beside Accept, and one put right goes in once the accept has gone through',
    countStart === '4' && countCalls.length === 2 && countCalls[0][0] === 'accept' && countCalls[0][1].id === 15 &&
    countCalls[1][0] === 'answer' &&
    JSON.stringify(countCalls[1][1]) === JSON.stringify({ id: 15, answer: { kind: 'count', value: 5 } }),
    JSON.stringify({ countStart, countCalls }));
  await p.unroute('**/api/console/submissions*', countedList);
  // with no number question the box starts empty, says Counted, and the
  // number goes into the answer on its own
  const bareCard = Object.assign({}, countedCard, { id: 16, group_id: 44, answer: null });
  const bareList = r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, counts: [], team_counts: [], submissions: [bareCard], questions: { 44: [] } }) });
  await p.route('**/api/console/submissions*', bareList);
  countCalls.length = 0;
  await p.click('#review-refresh');
  await p.waitForTimeout(300);
  const bareStart = await p.evaluate(() => {
    const box = document.querySelector('#review-list .review-count');
    return box ? [box.querySelector('span').textContent, box.querySelector('input').value] : null;
  });
  await p.fill('#review-list .review-count input', '5');
  await p.$$eval('#review-list .review-actions button', bs => bs.find(b => b.textContent === 'Accept').click());
  await p.waitForTimeout(300);
  check('with no number question the box beside Accept starts empty and the count typed goes in on its own',
    JSON.stringify(bareStart) === '["Counted",""]' && countCalls.length === 2 &&
    countCalls[0][0] === 'accept' &&
    JSON.stringify(countCalls[1][1]) === JSON.stringify({ id: 16, answer: { kind: 'count', value: 5, prompt: 'Counted' } }),
    JSON.stringify({ bareStart, countCalls }));
  await p.unroute('**/api/console/submissions*', bareList);
  // an answer sent before the questions changed holds its number in another
  // slot: the box starts from it, as the worker counts it (answerTo)
  const movedCard = Object.assign({}, countedCard, { id: 17, answer: { kind: 'text', value: 'Old question', more: [{ kind: 'count', value: 7 }] } });
  const movedList = r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, counts: [], team_counts: [], submissions: [movedCard], questions: { 43: [{ kind: 'count', prompt: 'How many bridges?', options: [] }] } }) });
  await p.route('**/api/console/submissions*', movedList);
  await p.click('#review-refresh');
  await p.waitForTimeout(300);
  const movedStart = await p.inputValue('#review-list .review-count input');
  check('a number held in another slot of an older answer starts the box beside Accept, as the worker counts it', movedStart === '7', movedStart);
  await p.unroute('**/api/console/submissions*', movedList);

  // a tiered part takes the number reached, started from the team's
  // answer, and Accept sends it where the worker reads it
  const tierCard = Object.assign({}, countedCard, { id: 17, group_id: 45, tally: '', quest_code: 'SQ39', points: 175, scoring: 'tiered',
    bands: [{ from: 1, points: 50 }, { from: 2, points: 100 }, { from: 3, points: 175 }], answer: { kind: 'count', value: 2 } });
  const tierList = r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, counts: [], team_counts: [], submissions: [tierCard], questions: { 45: [{ kind: 'count', prompt: 'How many Mount suburbs?', options: [] }] } }) });
  await p.route('**/api/console/submissions*', tierList);
  countCalls.length = 0;
  await p.click('#review-refresh');
  await p.waitForTimeout(300);
  const tierShown = await p.evaluate(() => {
    const box = document.querySelector('#review-list .part-band');
    return box ? [box.querySelector('input').value, box.querySelector('span').textContent] : null;
  });
  await p.fill('#review-list .part-band input', '3');
  await p.$$eval('#review-list .review-actions button', bs => bs.find(b => b.textContent === 'Accept').click());
  await p.waitForTimeout(300);
  const tierSent = (countCalls.find(c => c[0] === 'accept') || [])[1];
  check('a tiered part starts from the team\'s number, shows its band, and Accept sends the number reached',
    JSON.stringify(tierShown) === '["2","= 100 points"]' && JSON.stringify(tierSent) === JSON.stringify({ id: 17, amount: '1', numbers: { SQ39: '3' } }),
    JSON.stringify({ tierShown, tierSent }));
  await p.unroute('**/api/console/submissions*', tierList);

  // an entry a Discord command recorded says so plainly, and Undo on its
  // card, asked twice, sends points/undo; the card shows Change and Undo
  // and keeps the rest behind More
  const discordCard = Object.assign({}, acceptedCard, { id: 14, added_by: 'discord:sam', reviewed_by: 'discord:sam', partial: false,
    credit: { codes: ['SQ42'], amount: 1 }, part: null });
  const discordList = r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, counts: [], team_counts: [], submissions: [discordCard], questions: {} }) });
  await p.route('**/api/console/submissions*', discordList);
  const undos = [];
  await p.route('**/api/console/points/undo', async r => {
    undos.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: 14, team: 'Galahs', total: 4067 }) });
  });
  await p.click('#review-refresh');
  await p.waitForTimeout(300);
  const discordHead = await p.textContent('#review-list .review-card .review-head');
  const discordButtons = await p.$$eval('#review-list .review-actions > button', bs => bs.map(b => b.textContent));
  const discordMore = await p.$$eval('#review-list .review-actions .review-more .menu-pop button', bs => bs.map(b => b.textContent));
  await p.$$eval('#review-list .review-actions button', bs => bs.find(b => b.textContent === 'Undo').click());
  await p.waitForTimeout(100);
  await p.$$eval('#review-list .review-actions button', bs => bs.find(b => /^Take \d+ points? off$/.test(b.textContent)).click());
  await p.waitForTimeout(300);
  check('an entry a Discord command recorded reads as that person in Discord, its card has Change and Undo with the rest under More, and Undo takes it back',
    discordHead.includes('Recorded by sam (Discord)') && !discordHead.includes('discord:') &&
    discordButtons.join() === 'Change,Undo' && discordMore.indexOf('Delete') !== -1 &&
    undos.length === 1 && undos[0].id === 14,
    JSON.stringify({ discordHead, discordButtons, discordMore, undos }));
  await p.unroute('**/api/console/submissions*', discordList);
  // one that took points off gives them back, and one taken back can be
  // put back
  const offCard = Object.assign({}, discordCard, { id: 15, credit: { codes: ['SQ42'], amount: -1 } });
  const goneCard = Object.assign({}, discordCard, { id: 17, status: 'deleted', reason: 'Taken back' });
  const offList = r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, counts: [], team_counts: [], submissions: [offCard, goneCard], questions: {} }) });
  await p.route('**/api/console/submissions*', offList);
  const redos = [];
  await p.route('**/api/console/points/redo', async r => {
    redos.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: 17, team: 'Galahs', total: 4167 }) });
  });
  await p.click('#review-refresh');
  await p.waitForTimeout(300);
  const cardButtons = await p.$$eval('#review-list .review-card', cs => cs.map(c => [...c.querySelectorAll('.review-actions button')].map(b => b.textContent)));
  await p.$$eval('#review-list .review-card', cs => [...cs[0].querySelectorAll('.review-actions button')].find(b => b.textContent === 'Undo').click());
  await p.waitForTimeout(100);
  const giveLabel = await p.$$eval('#review-list .review-card', cs => [...cs[0].querySelectorAll('.review-actions button')].map(b => b.textContent).join('|'));
  await p.$$eval('#review-list .review-card', cs => [...cs[0].querySelectorAll('.review-actions button')].find(b => /^Give \d/.test(b.textContent)).click());
  await p.waitForTimeout(300);
  await p.$$eval('#review-list .review-card', cs => [...cs[1].querySelectorAll('.review-actions button')].find(b => b.textContent === 'Put back').click());
  await p.waitForTimeout(100);
  await p.$$eval('#review-list .review-card', cs => [...cs[1].querySelectorAll('.review-actions button')].find(b => /^Put back \d/.test(b.textContent)).click());
  await p.waitForTimeout(300);
  check('an entry that took points off is undone by giving them back, and one undone has Put back',
    cardButtons[0].indexOf('Undo') !== -1 && cardButtons[1].join() === 'Put back' && /Give \d+ points? back/.test(giveLabel) &&
    undos.length === 2 && undos[1].id === 15 && redos.length === 1 && redos[0].id === 17,
    JSON.stringify({ cardButtons, giveLabel, undos, redos }));
  await p.unroute('**/api/console/submissions*', offList);
  await p.click('#review-refresh');
  await p.waitForTimeout(200);

  // messages written ahead of time: shown in this device's zone, sent as UTC
  await p.click('.tabs button[data-tab="messages"]');
  await p.waitForTimeout(400);
  check('a scheduled message is marked as one, with when it goes up',
    (await p.textContent('#msg-list')).includes('scheduled') &&
    (await p.textContent('#msg-list')).includes('goes up'), await p.textContent('#msg-count'));
  await p.fill('#msg-title', 'Halfway briefing');
  // an attached file sits in a row with its name open to change
  await p.setInputFiles('#msg-files', { name: 'IMG_4021.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64') });
  await p.waitForTimeout(200);
  const msgRow = await p.evaluate(() => {
    const box = document.querySelector('#msg-files-list .file-rename');
    return { name: box && box.value, ext: box && box.nextSibling.textContent };
  });
  check('a message attachment lists with its name in a box, the extension fixed', msgRow.name === 'IMG_4021' && msgRow.ext === '.png', JSON.stringify(msgRow));
  await p.fill('#msg-files-list .file-rename', 'gazebo');
  await p.selectOption('#msg-who', 'groups');
  await p.check('#msg-groups input[value="3"]');
  await p.fill('#msg-publish-at', '2026-10-20T14:30');
  await p.waitForTimeout(150);
  check('a time on the message hides both announcements and renames the button',
    (await p.textContent('#msg-post')) === 'Schedule message' &&
    await p.$eval('#msg-push-row', el => el.classList.contains('hidden')) &&
    await p.$eval('#msg-discord-row', el => el.classList.contains('hidden')), await p.textContent('#msg-post'));
  await p.click('#msg-post');
  await p.waitForTimeout(400);
  check('the attachment goes up under the typed name',
    calls.msgSave.length === 1 && calls.msgSave[0].includes('filename="gazebo.png"') && !calls.msgSave[0].includes('IMG_4021'), '');
  check('a message for a team group is sent with the group the worker reads',
    calls.msgSave.length === 1 && /name="visibility"\r\n\r\ngroups\r\n/.test(calls.msgSave[0]) &&
    /name="audiences"\r\n\r\n3\r\n/.test(calls.msgSave[0]), '');
  check('and it is sent as UTC, whatever the dashboard is showing',
    calls.msgSave.length === 1 && calls.msgSave[0].includes('2026-10-20 03:30:00'),
    JSON.stringify((calls.msgSave[0] || '').slice(0, 0) + (calls.msgSave.length ? 'sent' : 'nothing sent')));
  check('the form comes back empty afterwards', (await p.inputValue('#msg-publish-at')) === '', '');

  // the quests tab: groups as cards with mono code chips and rendered markdown
  await p.click('.tabs button[data-tab="quests"]');
  await p.waitForTimeout(400);
  await p.click('#quest-list .qg .qg-row');
  await p.waitForTimeout(300);
  await p.$$eval('#quest-list .qg button', bs => { const b = bs.find(x => x.textContent === 'Preview'); if (b) b.click(); });
  const questCard = await p.evaluate(() => {
    const card = document.querySelector('#quest-list .qg');
    if (!card) return null;
    const chip = card.querySelector('.code-chip');
    const desc = card.querySelector('textarea.tall');
    const preview = card.querySelector('.qg-preview');
    return { chip: chip && chip.textContent, font: getComputedStyle(chip).fontFamily,
      editing: !!desc && desc.value.includes('**Note:**'),
      bold: !!(preview && preview.querySelector('strong')), flavour: !!preview && preview.textContent.includes('No roads lead here'),
      codeRows: card.querySelectorAll('.qg-codes tbody tr').length };
  });
  check('a quest card opens into an editor with its markdown previewed and its codes listed',
    !!questCard && questCard.chip === 'SQ40' && questCard.font.includes('Roboto Mono') && questCard.editing && questCard.bold && questCard.flavour && questCard.codeRows === 1,
    JSON.stringify(questCard));
  await p.click('#quest-regions-toggle');
  const regionRows = await p.$$eval('#quest-regions .qr-row', rows => rows.map(r => r.querySelector('input').value + ':' + r.querySelector('.count').textContent));
  check('the regions panel lists every region with its quest count and order controls',
    regionRows.length === 2 && regionRows[0] === 'Exploration Region:1 quest' && regionRows[1] === 'Clubs Region:0 quests', JSON.stringify(regionRows));
  const regionSelect = await p.$$eval('#quest-list .qg select', sels => { const s = sels.find(x => [...x.options].some(o => o.value === 'Clubs Region')); return s ? [s.value, s.options.length] : null; });
  check('the editor picks a region from the list, no region allowed', !!regionSelect && regionSelect[0] === 'Exploration Region' && regionSelect[1] === 3, JSON.stringify(regionSelect));

  // who can see a quest, with the editor opened above closed again
  await p.click('#quest-list .qg .qg-row');
  await p.waitForTimeout(200);
  const cardsNow = () => p.$$eval('#quest-list .qg .qg-row', rows => rows.map(r =>
    r.querySelector('.code-chip').textContent + ':' + r.querySelector('.qg-who').value +
    (r.querySelector('.qg-access') ? ':' + r.querySelector('.qg-access').textContent : '')));
  const listed = await cardsNow();
  await p.check('#quest-show-dash-hidden');
  await p.waitForTimeout(150);
  const withOld = await cardsNow();
  await p.uncheck('#quest-show-dash-hidden');
  await p.selectOption('#quest-view-as', 'public');
  await p.waitForTimeout(300);
  const asPublic = await cardsNow();
  await p.selectOption('#quest-view-as', '');
  await p.waitForTimeout(200);
  check('a quest under a hidden tag stays out until the switch is on, and the list can be seen as someone signed out',
    listed.join(' | ') === 'SQ40:everyone | SQ41:groups:PreviewWave 1' &&
    withOld.length === 3 && withOld[2] === 'SQ1-o:organisers:Old' && asPublic.join() === 'SQ40:everyone',
    JSON.stringify({ listed, withOld, asPublic }));

  await p.selectOption('#quest-list .qg .qg-who >> nth=0', 'teams');
  await p.waitForTimeout(300);
  check('the switch on a card sends who can see the quest, keeping its team groups and time',
    access.set.length === 1 && access.set[0].id === 1 && access.set[0].visibility === 'teams' &&
    Array.isArray(access.set[0].audiences) && access.set[0].opens_at === '', JSON.stringify(access.set));

  // a quest is added under its region: the code typed once, how it
  // scores under its name
  await p.evaluate(() => [...document.querySelectorAll('#quest-list .qg-add')].find(b => b.textContent === 'Add a quest to Clubs Region').click());
  await p.waitForTimeout(200);
  await p.evaluate(() => {
    const card = document.querySelector('#quest-list .qg-edit').parentNode;
    const inputs = card.querySelectorAll('.qg-grid input');
    inputs[0].value = 'Night walk';
    inputs[1].value = 'SQ77';
    inputs[1].dispatchEvent(new Event('input'));
    const type = card.querySelector('.qg-part-one select');
    type.value = 'unit';
    type.dispatchEvent(new Event('change'));
    card.querySelector('.qg-part-one input.pts').value = '40';
    card.querySelector('.qg-part-one input[aria-label="Counts up to"]').value = '6';
    [...card.querySelectorAll('.qg-actions button')].find(b => b.textContent === 'Add quest').click();
  });
  await p.waitForTimeout(400);
  check('a quest added under a region goes there with one part, how it scores and its points, written hidden, then given who can see it',
    access.save.length === 1 && access.save[0].hidden === true && access.save[0].region === 'Clubs Region' &&
    JSON.stringify(access.save[0].codes.map(c => [c.code, c.scoring, c.points, c.most])) === '[["SQ77","unit","40","6"]]' &&
    access.set.length === 2 && access.set[1].id === 5 && access.set[1].visibility === 'organisers',
    JSON.stringify({ save: access.save.map(s => [s.hidden, s.region, s.codes]), set: access.set[1] }));

  await p.click('#quest-open-all');
  await p.fill('#quest-status input', 'OPEN');
  await p.$$eval('#quest-status button', bs => bs.find(b => /^Open \d/.test(b.textContent)).click());
  await p.waitForTimeout(300);
  check('opening everything counts what it will open and sends the word typed',
    access.openAll.length === 1 && access.openAll[0].confirm === 'OPEN', JSON.stringify(access.openAll));

  // The quest's one Save carries who can see it and the tags, but only
  // when they were touched. It used to drop them: a tag ticked in the
  // editor was thrown away by the Save at the bottom.
  const editorSave = () => p.evaluate(() =>
    [...document.querySelectorAll('#quest-list .qg-edit > .qg-actions button')].find(b => b.textContent === 'Save').click());
  const openCard = (k) => p.evaluate(key =>
    [...document.querySelectorAll('#quest-list .qg .qg-row')].find(r => r.querySelector('.code-chip').textContent === key).click(), k);
  const setsBefore = access.set.length;
  await openCard('SQ40');
  await p.waitForTimeout(300);
  await editorSave();
  await p.waitForTimeout(400);
  const untouched = access.set.length - setsBefore;
  await openCard('SQ40');
  await p.waitForTimeout(300);
  // the open quest's row gives up its own Who: changing it there saved at
  // once and redrew the editor, losing the tag ticked in it
  const rowWho = await p.evaluate(() => !!document.querySelector('#quest-list .qg-edit').parentNode.querySelector('.qg-row .qg-who'));
  await p.evaluate(() => [...document.querySelectorAll('#quest-list .qg-edit .qg-picks label')]
    .find(l => l.textContent === 'Wave 1').querySelector('input').click());
  await editorSave();
  await p.waitForTimeout(400);
  const tagged = access.set.slice(setsBefore);
  check('the quest\'s Save sends a tag ticked in its editor, and sends nothing about who can see it when that was left alone',
    untouched === 0 && tagged.length === 1 && tagged[0].id === 1 && tagged[0].tags.join() === 'Wave 1' && !rowWho,
    JSON.stringify({ untouched, tagged, rowWho }));
  // the questions the submit form asks go to the worker as one list
  await openCard('SQ40');
  await p.waitForTimeout(300);
  const addQuestion = () => p.evaluate(() =>
    [...document.querySelectorAll('#quest-list .qg-edit .qg-questions > button')].find(b => b.textContent === 'Add a question').click());
  await addQuestion();
  await addQuestion();
  await p.evaluate(() => {
    const rows = document.querySelectorAll('#quest-list .qg-edit .qg-q');
    const sel = rows[0].querySelector('select');
    sel.value = 'choice';
    sel.dispatchEvent(new Event('change'));
    rows[0].querySelector('input[type=text]').value = 'Which ferry?';
    rows[0].querySelector('textarea').value = 'Manly\nTaronga';
    rows[1].querySelector('input[type=text]').value = 'Who steered?';
  });
  const savesBefore = access.save.length;
  await editorSave();
  await p.waitForTimeout(400);
  const asked = access.save.length > savesBefore ? access.save[access.save.length - 1].questions : null;
  check('the editor sends the quest\'s questions as one list, in order',
    JSON.stringify(asked) === JSON.stringify([{ kind: 'choice', prompt: 'Which ferry?', options: 'Manly\nTaronga' }, { kind: 'text', prompt: 'Who steered?', options: '' }]),
    JSON.stringify(asked));

  // a region's quests put in order: SQ1-o dragged by its handle to the
  // top, then SQ40 moved down a place from the keyboard
  await p.check('#quest-show-dash-hidden');
  await p.waitForTimeout(150);
  await p.evaluate(() => [...document.querySelectorAll('#quest-list .qg-region-head')]
    .find(head => head.firstChild.textContent === 'Exploration Region').querySelector('button').click());
  await p.waitForTimeout(200);
  const orderShown = () => p.$$eval('#quest-list .qo-row .code-chip', chips => chips.map(c => c.textContent).join());
  const shownAtFirst = await orderShown();
  const grip = p.locator('#quest-list .qo-row[data-id="3"] .qo-grip');
  await grip.scrollIntoViewIfNeeded();
  const from = await grip.boundingBox();
  const rowHeight = (await p.locator('#quest-list .qo-row').first().boundingBox()).height;
  const x = from.x + from.width / 2;
  let y = from.y + from.height / 2;
  await p.mouse.move(x, y);
  await p.mouse.down();
  for (let i = 0; i < 12; i++) {
    y -= rowHeight * 2.2 / 12;
    await p.mouse.move(x, y);
    await p.waitForTimeout(40);
  }
  await p.mouse.up();
  await p.waitForTimeout(500);
  const afterDrag = await orderShown();
  await p.locator('#quest-list .qo-row[data-id="1"] .qo-down').focus();
  await p.keyboard.press('Enter');
  await p.waitForTimeout(100);
  const afterKey = await orderShown();
  await p.evaluate(() => [...document.querySelectorAll('#quest-list .qo button')].find(b => b.textContent === 'Save order').click());
  await p.waitForTimeout(400);
  const panelGone = await p.$$eval('#quest-list .qo', els => els.length === 0);
  check('a region\'s quests are put in order by a drag and by a key, and Save sends the region and the new order',
    shownAtFirst === 'SQ40,SQ41,SQ1-o' && afterDrag === 'SQ1-o,SQ40,SQ41' && afterKey === 'SQ1-o,SQ41,SQ40' &&
    questOrders.length === 1 && questOrders[0].region === 'Exploration Region' && questOrders[0].ids.join() === '3,2,1' && panelGone,
    JSON.stringify({ shownAtFirst, afterDrag, afterKey, questOrders, panelGone }));
  await p.uncheck('#quest-show-dash-hidden');
  // the rego tab: a card per team that opens into an editor
  await p.click('.tabs button[data-tab="rego"]');
  await p.waitForTimeout(400);

  // the sign-up summary reads like a form's response page: stat
  // cards, then bars per question, counted from the same rows
  const sum = await p.evaluate(() => {
    const box = document.getElementById('rego-summary');
    const stats = [...box.querySelectorAll('.stat')].map(st => ({
      label: st.querySelector('.stat-label').textContent,
      n: st.querySelector('.stat-num').textContent.replace(/\s/g, ''),
      note: st.querySelector('.stat-note').textContent
    }));
    const chart = (title) => {
      const card = [...box.querySelectorAll('.rg-chart')].find(c => c.querySelector('.rg-chart-title').textContent === title);
      if (!card) return null;
      return [...card.querySelectorAll('.rg-bar-row')].map(r => ({
        label: r.querySelector('.rg-bar-label').textContent,
        w: r.querySelector('.rg-bar-fill').style.width,
        n: r.querySelector('.rg-bar-n').textContent
      }));
    };
    return { stats, soc: chart('Societies'), size: chart('Team size'), arc: chart('Arc members'), diet: chart('Dietary requirements'), photo: chart('Photo permission'), checkin: chart('Checked in') };
  });
  check('the summary leads with the totals: teams, people, accepted the terms, checked in, photo permission',
    sum.stats.length === 5 && sum.stats[0].label === 'Teams' && sum.stats[0].n === '1' &&
    sum.stats[1].n === '2' && sum.stats[2].label === 'Accepted the terms' && sum.stats[2].note === 'of 2' &&
    sum.stats[3].label === 'Checked in' && sum.stats[3].n === '1' && sum.stats[3].note === 'of 2' &&
    sum.stats[4].label === 'Photo permission' && sum.stats[4].n === '1' && sum.stats[4].note === 'of 2', JSON.stringify(sum.stats));
  check('the societies chart lists every society as a bar, picked ones full and unpicked at zero',
    !!sum.soc && sum.soc.length === 11 && sum.soc[0].label === 'RailSoc' && sum.soc[0].w === '100%' && /1 team \(100%\)/.test(sum.soc[0].n) &&
    sum.soc[1].label === 'WestSoc' && sum.soc.filter(r => r.w === '0%').length === 9, JSON.stringify((sum.soc || []).slice(0, 3)));
  // ---- the Sign-ups card: the switch, the cap, and where it stands ----
  // the Rego tab says where sign-ups stand, and its button goes to the
  // card that changes it on the Settings tab
  const standing = await p.textContent('#rego-standing');
  await p.click('#view-rego [data-goto="settings"]');
  await p.waitForTimeout(400);
  const guard = await p.evaluate(() => ({
    open: document.getElementById('rego-open').checked,
    cap: document.getElementById('rego-cap').value,
    line: document.getElementById('rego-open-state').textContent,
    note: document.getElementById('rego-guard-note').textContent,
    onSettings: !document.getElementById('view-settings').classList.contains('hidden')
  }));
  check('the Rego tab says sign-ups are open and its button opens the Sign-ups settings, painted open with no cap',
    /Sign-ups open\. 2 people signed up, no cap/.test(standing) && guard.onSettings &&
    guard.open && guard.cap === '' && /2 people signed up, no cap/.test(guard.line) && /human check is off/.test(guard.note),
    JSON.stringify({ standing, guard }));
  await p.fill('#rego-cap', '40');
  await p.click('#rego-settings-save');
  await p.waitForTimeout(300);
  check('saving posts the switch and the cap and repaints the standing',
    guardSets.length === 1 && guardSets[0].closed === false && guardSets[0].cap === 40 &&
    /2 of 40 spots taken/.test(await p.textContent('#rego-open-state')), JSON.stringify(guardSets));
  await p.evaluate(() => { document.getElementById('rego-open').checked = false; });
  await p.click('#rego-settings-save');
  await p.waitForTimeout(300);
  check('unticking open closes the form',
    guardSets.length === 2 && guardSets[1].closed === true &&
    /Closed by hand/.test(await p.textContent('#rego-open-state')), JSON.stringify(guardSets[1]));

  // ---- the test send: which shape went out, and whether the name survived ----
  await p.click('#email-test-send');
  await p.waitForTimeout(200);
  check('a test with no address asks for one and sends nothing',
    emailTests.length === 0 && /address/i.test(await p.textContent('#toast')), '');
  await p.fill('#email-test-to', 'alex@example.com');
  await p.click('#email-test-send');
  await p.waitForTimeout(300);
  const goodSend = await p.textContent('#email-test-out');
  check('a send that keeps the name says so, with the address inboxes will show',
    emailTests.length === 1 && emailTests[0].to === 'alex@example.com' &&
    /the Email Service binding, name and address, with a reply-to/.test(goodSend) &&
    /name survived/.test(goodSend) && goodSend.includes('SCS.2 Tab Team <tab@scs.andyrew.space>'),
    JSON.stringify(goodSend));
  emailShape = 1;
  await p.click('#email-test-send');
  await p.waitForTimeout(300);
  const bareSend = await p.textContent('#email-test-out');
  check('falling through to the string shape says the name was dropped and lists what refused',
    /the whole sender as one string/.test(bareSend) && /name was dropped/.test(bareSend) &&
    /Refused \(name and address, with a reply-to\): reply_to is not supported/.test(bareSend) &&
    /Refused \(name and address\): from must be a string/.test(bareSend), JSON.stringify(bareSend));
  emailShape = 2;
  await p.click('#email-test-send');
  await p.waitForTimeout(300);
  const badSend = await p.textContent('#email-test-out');
  check('nothing configured reports the reason and marks the line',
    /Nothing is configured to send email/.test(badSend) &&
    await p.evaluate(() => document.getElementById('email-test-out').classList.contains('bad')), JSON.stringify(badSend));
  emailShape = 0;

  // ---- the other two sends: the ticket email, and it with a header ----
  // All three go through one action, so what is checked is that each
  // button asks for the right kind and carries the right fields.
  const before = emailTests.length;
  await p.fill('#email-test-name', 'Jo Tran');
  await p.fill('#email-test-team', 'Dry Run');
  await p.click('#email-test-ticket');
  await p.waitForTimeout(300);
  const ticketSend = emailTests[emailTests.length - 1];
  check('the ticket button sends the confirmation with the typed name and team',
    emailTests.length === before + 1 && ticketSend.kind === 'ticket' &&
    ticketSend.name === 'Jo Tran' && ticketSend.team === 'Dry Run' &&
    ticketSend.to === 'alex@example.com', JSON.stringify(ticketSend));

  await p.click('#email-test-banner-send');
  await p.waitForTimeout(300);
  check('the header button with no link asks for one rather than sending a message with a gap in it',
    emailTests.length === before + 1 && /link to the picture/i.test(await p.textContent('#toast')), '');

  await p.fill('#email-test-banner', 'https://files.example/api/drop/k/title.gif');
  await p.click('#email-test-banner-send');
  await p.waitForTimeout(300);
  const bannerSend = emailTests[emailTests.length - 1];
  check('and with one it sends the same email plus the picture',
    emailTests.length === before + 2 && bannerSend.kind === 'banner' &&
    bannerSend.banner === 'https://files.example/api/drop/k/title.gif' &&
    bannerSend.name === 'Jo Tran', JSON.stringify(bannerSend));

  check('team size, Arc and dietary read as bars with counts and shares',
    !!sum.size && sum.size[0].label === '2 people' && /1 team \(100%\)/.test(sum.size[0].n) &&
    !!sum.arc && sum.arc[0].label === 'Yes' && /1 person \(50%\)/.test(sum.arc[0].n) &&
    !!sum.diet && sum.diet[0].label === 'Vegetarian' && sum.diet[1].label === 'None given' &&
    !!sum.photo && !!sum.checkin, JSON.stringify({ size: sum.size, arc: sum.arc, diet: sum.diet }));
  await p.click('.tabs button[data-tab="rego"]');
  await p.waitForTimeout(300);
  const regoHead = await p.textContent('#rego-list .rg-head');
  const tree = await p.$$eval('#rego-list .rg-tree li', lis => lis.map(li => li.textContent));
  check('registrations show as a team with its people as branches and their check-in state',
    regoHead.includes('Galahs') && regoHead.includes('2 people') && regoHead.includes('1 checked in') &&
    tree.length === 2 && tree[0].includes('Alice Park') && tree[0].includes('checked in') && tree[1].includes('not checked in') && tree[1].includes('no QR'),
    JSON.stringify(tree));
  await p.$$eval('#rego-list .rg-head button', bs => bs.find(b => b.textContent === 'Edit').click());
  await p.waitForTimeout(300);
  const people = await p.$$eval('#rego-list .rg-person', ps => ps.map(x => x.querySelector('strong').textContent));
  check('the editor lists every person with an add button', people.length === 2 && people[0] === '#1 Alice Park' && (await p.textContent('#rego-list')).includes('Add a person'), JSON.stringify(people));
  await p.$eval('#rego-list .rg-person input', el => { el.value = 'Alice Park-Lee'; });
  await p.$$eval('#rego-list .rg-person button', bs => bs.find(b => b.textContent === 'Save').click());
  await p.waitForTimeout(60);
  check('the save button ticks while the worker is asked',
    await p.$$eval('#rego-list .rg-person button', bs => bs.find(b => b.textContent === 'Save').classList.contains('is-busy')), '');
  await p.waitForTimeout(400);
  check('saving a person posts the edited fields', regoCalls.length === 1 && regoCalls[0].id === 11 && regoCalls[0].name === 'Alice Park-Lee' && regoCalls[0].registration_id === 3 && regoCalls[0].arc === true, JSON.stringify(regoCalls[0]));

  // a failed save must say so: the success text used to be built
  // before the ok check, and its crash swallowed the error toast
  regoFail = true;
  await p.$$eval('#rego-list .rg-person button', bs => bs.find(b => b.textContent === 'Save').click());
  await p.waitForTimeout(400);
  check('a failed save shows the worker\'s reason in the toast',
    (await p.textContent('#toast')).includes('That zID is taken.') &&
    !(await p.$$eval('#rego-list .rg-person button', bs => bs.find(b => b.textContent === 'Save').classList.contains('is-busy'))),
    await p.textContent('#toast'));
  regoFail = false;

  // adding someone whose code cannot be made: nothing is emailed and
  // the dashboard asks on their row
  regoHeld = true;
  await p.$$eval('#rego-list .rg-person button', bs => bs.find(b => b.textContent === 'Save').click());
  await p.waitForTimeout(500);
  check('a save that could not make a QR raises the question instead of emailing',
    !!(await p.$('#rego-list .rg-ask')) &&
    (await p.textContent('#rego-list .rg-ask .rg-ask-head')).includes('no email was sent'), '');
  await p.$$eval('#rego-list .rg-ask button', bs => bs.find(b => b.textContent === 'Leave it unsent').click());
  await p.waitForTimeout(200);
  regoHeld = false;

  // a person with no QR: two actions instead of one, and a ticket link
  // only for the person who has a code
  const personRows = await p.$$eval('#rego-list .rg-person', ps => ps.map(box => ({
    who: box.querySelector('strong').textContent,
    buttons: [...box.querySelectorAll('button')].map(b => b.textContent),
    ticket: (box.querySelector('a.rg-ticket') || {}).href || ''
  })));
  check('a person with a code gets an Open ticket link and one send action',
    personRows[0].ticket === 'https://scs.andyrew.space/ticket/?AAAA' &&
    personRows[0].buttons.indexOf('Send email') !== -1 && personRows[0].buttons.indexOf('Create QR code') === -1,
    JSON.stringify(personRows[0]));
  check('a person with none gets no ticket link and both Create QR code and Send email',
    personRows[1].ticket === '' && personRows[1].buttons.indexOf('Create QR code') !== -1 && personRows[1].buttons.indexOf('Send email') !== -1,
    JSON.stringify(personRows[1]));

  const benBtn = (label) => p.$$eval('#rego-list .rg-person', (ps, l) => {
    const box = ps.find(x => x.querySelector('strong').textContent.includes('Ben Ho'));
    [...box.querySelectorAll('button')].find(b => b.textContent === l).click();
  }, label);

  // Send email mints first; with no code it asks instead of sending
  await benBtn('Send email');
  await p.waitForTimeout(400);
  const ask = await p.evaluate(() => {
    const panel = document.querySelector('#rego-list .rg-ask');
    return panel ? { head: panel.querySelector('.rg-ask-head').textContent, note: panel.querySelector('.rg-ask-note').textContent,
      buttons: [...panel.querySelectorAll('button')].map(b => b.textContent) } : null;
  });
  check('Send email with no code asks before anything goes out, and says why',
    !!ask && /could not be made/.test(ask.head) && /no email was sent/.test(ask.head) && ask.note === noQr &&
    ask.buttons.join('|') === 'Send the email anyway|Leave it unsent' &&
    emailCalls.length === 1 && !emailCalls[0].force, JSON.stringify({ ask, calls: emailCalls }));

  await p.$$eval('#rego-list .rg-ask button', bs => bs.find(b => b.textContent === 'Leave it unsent').click());
  await p.waitForTimeout(200);
  check('leaving it unsent closes the question and sends nothing',
    !(await p.$('#rego-list .rg-ask')) && emailCalls.length === 1, 'calls=' + emailCalls.length);

  await benBtn('Send email');
  await p.waitForTimeout(400);
  await p.$$eval('#rego-list .rg-ask button', bs => bs.find(b => b.textContent === 'Send the email anyway').click());
  await p.waitForTimeout(500);
  check('saying send it anyway sends it, once, and says the email went out',
    emailCalls.length === 3 && emailCalls[2].id === 12 && emailCalls[2].force === true &&
    (await p.textContent('#toast')).includes('no ticket link') && !(await p.$('#rego-list .rg-ask')),
    JSON.stringify(emailCalls));

  // Create QR code retries the code on its own
  await benBtn('Create QR code');
  await p.waitForTimeout(400);
  check('Create QR code asks for the code alone and reports a failure in the toast',
    qrCalls.length === 1 && qrCalls[0].id === 12 && emailCalls.length === 3 &&
    (await p.textContent('#toast')).includes(noQr), JSON.stringify({ qrCalls, toast: await p.textContent('#toast') }));
  qrWorks = true;
  await benBtn('Create QR code');
  await p.waitForTimeout(500);
  check('and says so when it works, without sending anything',
    qrCalls.length === 2 && emailCalls.length === 3 && (await p.textContent('#toast')).includes('QR code made for Ben Ho'),
    await p.textContent('#toast'));
  qrWorks = false;

  // the discord tab: status, the server card, a message box, the teams table
  await p.click('.tabs button[data-tab="discord"]');
  await p.waitForTimeout(500);
  await p.click('#discord-hold input');
  await p.waitForTimeout(200);
  check('Hold posts sends the server ticked and the box as it now stands',
    holds.length === 1 && holds[0].held === true && holds[0].guild_id === '111' &&
    (await p.textContent('#discord-hold')).includes('SCS Sydney') && await p.$eval('#discord-hold input', i => i.checked), JSON.stringify(holds));
  await p.click('#discord-hold input');
  await p.waitForTimeout(200);
  const dc = await p.evaluate(() => ({
    status: document.getElementById('discord-status').textContent,
    server: document.querySelector('#discord-servers .dc-server strong').textContent,
    role: document.querySelector('#discord-servers .dc-server select').value,
    roleOptions: [...document.querySelector('#discord-servers .dc-server select').options].map(o => o.textContent),
    enabledOptions: [...document.querySelectorAll('#discord-servers .dc-server select')][1].options.length,
    announceOptions: [...[...document.querySelectorAll('#discord-servers .dc-server select')][2].options].map(o => o.textContent),
    channels: [...document.getElementById('discord-post-channel').options].map(o => o.textContent),
    teamRows: document.querySelectorAll('#discord-teams tbody tr').length,
    setupButtons: [...document.querySelectorAll('#discord-teams tbody button')].filter(b => b.textContent === 'Set up').length,
    members: document.querySelectorAll('#discord-members tbody tr').length
  }));
  check('the discord tab shows the bot, the server with its organiser role picked, channels, teams and members',
    dc.status.includes('Signed in as scs-tab') && dc.server === 'SCS Sydney' && dc.role === '55' && dc.roleOptions.includes('OrgCom') && dc.enabledOptions === 2 &&
    dc.channels.length === 2 && dc.channels[1] === '#galahs (Private Channels)' && dc.teamRows === 2 && dc.setupButtons === 1 && dc.members === 1, JSON.stringify(dc));
  check('the server card offers the cross-post channel picker, off by default',
    dc.announceOptions[0] === 'No cross-posting' && dc.announceOptions.some(o => o.includes('#general')), JSON.stringify(dc.announceOptions));
  // the role for a signup not in a team yet is picked from the server's own roles
  await p.evaluate(() => {
    const label = [...document.querySelectorAll('#discord-servers .dc-server label')].find(l => l.textContent.startsWith('Signed up without a team'));
    const sel = label.querySelector('select');
    sel.value = '57';
    sel.dispatchEvent(new Event('change'));
  });
  await p.click('#discord-servers .dc-server button:text-is("Save")');
  await p.waitForTimeout(300);
  check('the server card sends the roles picked for people without a team and for members no signup lists',
    guildSaves.length === 1 && guildSaves[0].no_team_role_id === '57' && guildSaves[0].unknown_role_id === '', JSON.stringify(guildSaves));
  await p.fill('#discord-post-text', 'Briefing 3 is live.');
  await p.click('#discord-post-send');
  await p.waitForTimeout(300);
  check('sending a message posts the channel and text', discordPosts.length === 1 && discordPosts[0].channel_id === '1' && discordPosts[0].content === 'Briefing 3 is live.' && discordPosts[0].preset === '', JSON.stringify(discordPosts[0]));
  await p.click('#discord-post-leaderboard');
  await p.waitForTimeout(300);
  check('the top 10 button posts the preset', discordPosts.length === 2 && discordPosts[1].preset === 'leaderboard', '');
  await p.click('#discord-servers .dc-server button:has-text("Set up teams and give out roles")');
  await p.waitForFunction(() => /teams set up/.test(document.querySelector('.dc-report').textContent), null, { timeout: 4000 }).catch(() => {});
  const report = await p.$eval('.dc-report', n => n.textContent);
  check('Set up teams and give out roles asks for each team in turn and says who got the role and who is not in the server',
    discordSetups.length === 2 && discordSetups.every(b => b.guild_id === '111' && b.members === true) &&
    discordSetups.map(b => b.team_id).join() === '7,8' && /2 of 2 teams set up \(1 new\)\. 3 people given their team role\./.test(report) &&
    /Not in the server yet \(1\): sscrab3/.test(report), JSON.stringify({ discordSetups, report }));
  // the previews: one team channel at a time, a page of its messages a
  // request, carrying on from where the worker says until it says done
  const refreshes = [];
  await p.route('**/api/console/discord/refresh', async r => {
    const b = r.request().postDataJSON();
    refreshes.push(b);
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b.before
      ? { ok: true, team: 'Galahs', edited: 3, checked: 3, before: null, failed: [] }
      : { ok: true, team: 'Galahs', edited: 20, checked: 20, before: '123', failed: [] }) });
  });
  await p.click('#discord-servers .dc-server button:has-text("Refresh photo and video previews")');
  await p.waitForFunction(() => /posts refreshed in/.test(document.querySelector('.dc-report').textContent), null, { timeout: 4000 }).catch(() => {});
  const refreshReport = await p.$eval('.dc-report', n => n.textContent);
  check('Refresh photo and video previews goes through each team channel a page at a time until the worker says it is done',
    refreshes.length === 2 && refreshes.every(b => b.guild_id === '111' && b.team_id === 7) &&
    refreshes[0].before === '' && refreshes[1].before === '123' && /23 posts refreshed in 1 of 1 team channels\./.test(refreshReport),
    JSON.stringify({ refreshes, refreshReport }));
  // recording points: the form sends what the worker reads
  const pointsSent = [];
  await p.route('**/api/console/points/form', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    ok: true, ready: true, limited: false, places: {}, teams: [{ id: 7, name: 'Galahs', hidden: 0 }],
    quests: [{ key: 'SQ5', name: 'Wondabyne', submit: 'count', prompt: 'How many?', options: [],
      codes: [{ code: 'SQ5', label: '', points: 50, scoring: 'unit' }, { code: 'SQ5-2', label: 'Bonus', points: 25, scoring: 'unit' }] }]
  }) }));
  const deskAsks = [];
  await p.route('**/api/console/desk*', r => {
    deskAsks.push(new URL(r.request().url()).search);
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      ok: true, quest: { key: 'SQ5', name: 'Wondabyne', tally: '', ask: '', codes: [] },
      teams: [{ id: 7, name: 'Galahs', hidden: false, worth: 50, lines: [{ id: 70, code: 'SQ5', units: 1, points: 50, kind: 'submission', source_id: 31,
        at: '2026-10-20 03:00:00', made_at: '2026-10-20 03:05:00', by: 'Alex', note: '', organiser: true, label: '', voided: null,
        sub: { status: 'accepted', quest_code: 'SQ5', sent: '2026-10-20 03:00:00', decided: '2026-10-20 03:05:00', by: 'Alex', adjust: false, reason: '' } }] }],
      waiting: [{ id: 32, team_id: 8, team_name: 'S.S. Crab', team_hidden: false, quest_code: 'SQ5', name: 'Wondabyne', status: 'pending', reason: '', submitted_at: '2026-10-20 03:30:00' }],
      closed: [], media: { 31: [{ key: 'sub/Desk00Photo0031', type: 'image/jpeg', bytes: 2048, name: 'proof.jpg' }] } }) });
  });
  const timeMoves = [];
  await p.route('**/api/console/points/time', async r => {
    timeMoves.push(r.request().postDataJSON());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, at: '2026-10-20 02:30:00' }) });
  });
  await p.route('**/api/console/points/add', async r => {
    pointsSent.push(r.request().postData() || '');
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: 1, team: 'Galahs', gained: 75, total: 4242 }) });
  });
  await p.click('.tabs button[data-tab="desk"]');
  await p.waitForTimeout(300);
  // the account's one quest is picked, with what each team holds on it
  // and what waits on review for it
  const deskPicks = await p.$$eval('#desk-quest option', os => os.map(o => o.value));
  const deskTeams = await p.textContent('#desk-teams');
  const deskThumbs = await p.$$eval('#desk-teams .lg-lines li .lg-media img', ims => ims.map(i => i.getAttribute('src')));
  check('a submission\'s line on the desk shows its photos',
    deskThumbs.length === 1 && deskThumbs[0] === '/api/console/file?key=sub%2FDesk00Photo0031&thumb=1', JSON.stringify(deskThumbs));
  check('the desk opens on the one quest there is, listing each team\'s lines on it and what waits on review',
    JSON.stringify(deskPicks) === '["SQ5"]' && /[?&]quest=SQ5(&|$)/.test(deskAsks[deskAsks.length - 1] || '') &&
    deskTeams.includes('Galahs') && deskTeams.includes('Recorded by Alex') && deskTeams.includes('+50') &&
    deskTeams.includes('Waiting on review') && deskTeams.includes('S.S. Crab'),
    JSON.stringify({ deskPicks, deskAsks, deskTeams }));
  // an organiser's entry's time moves from its line
  await p.$$eval('#desk-teams .lg-lines li', lis => [...lis[0].querySelectorAll('.lg-acts button')].find(b => b.textContent === 'Time').click());
  await p.fill('#desk-teams .lg-confirm input[type=datetime-local]', '2026-10-20T13:30');
  await p.click('#desk-teams .lg-confirm button:has-text("Save time")');
  await p.waitForTimeout(300);
  check('Time on an organiser\'s entry sends the submission and the time typed, in UTC',
    timeMoves.length === 1 && timeMoves[0].id === 31 && /^2026-10-20 \d\d:30:00$/.test(timeMoves[0].at),
    JSON.stringify(timeMoves));
  await p.selectOption('#pt-team', '7');
  await p.selectOption('#desk-quest', 'SQ5');
  await p.check('#pt-codes input[type=checkbox] >> nth=1');
  // each per-unit part has its own count
  await p.fill('#pt-codes .code-count >> nth=1', '2');
  await p.fill('#pt-answer input', '3');
  await p.click('#pt-add');
  await p.waitForTimeout(300);
  const sentPoints = pointsSent[0] || '';
  const field = name => (sentPoints.match(new RegExp('name="' + name + '"\\r\\n\\r\\n([^\\r]*)')) || [])[1];
  check('Add points sends the team, the quest, the ticked codes, each code\u2019s count and the answer, and says what it was worth',
    pointsSent.length === 1 && field('team_id') === '7' && field('quest') === 'SQ5' && field('codes') === '["SQ5","SQ5-2"]' &&
    field('amount') === '1' && field('counts') === '{"SQ5":"1","SQ5-2":"2"}' && field('answer') === '{"kind":"count","value":3}' &&
    /Added 75 points to Galahs/.test(await p.textContent('#toast')) && (await p.inputValue('#pt-team')) === '',
    JSON.stringify({ team: field('team_id'), quest: field('quest'), codes: field('codes'), counts: field('counts'), answer: field('answer') }));


  // push
  const pushCalls = [];
  const pushNames = [];
  let pushState = {
    ok: true, subscribers: 57,
    devices: [
      { id: 3, label: 'Alex iPhone', service: 'Apple', team_id: 7, team_name: 'Galahs', created_at: '2026-10-19 22:10:00' },
      { id: 2, label: '', service: 'Google', team_id: null, team_name: '', created_at: '2026-10-19 21:00:00' }
    ]
  };
  await p.route('**/api/console/push/stats', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify(pushState) }));
  await p.route('**/api/console/push/name', async r => {
    const body = r.request().postDataJSON();
    pushNames.push(body);
    pushState.devices = pushState.devices.map(v => v.id === body.id ? Object.assign({}, v, { label: body.label }) : v);
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(pushState) });
  });
  // the worker's side: refused until the second password comes in the header
  await p.route('**/api/console/push/send', async r => {
    const body = r.request().postDataJSON();
    const second = r.request().headers()['x-second-password'] || '';
    if (second !== 'push-pass') {
      await r.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({
        error: second ? 'Wrong second password.' : 'This needs the second password.',
        second_password: true, wrong: !!second, what: 'Sending a push notification' }) });
      return;
    }
    pushCalls.push(Object.assign({ second: second }, body));
    const aim = (body.target && body.target.kind) || 'all';
    await r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify(aim === 'all'
        ? { ok: true, target: 'all', who: 'everyone', sent: 57, failed: 0, dead: 2, remaining: 40, queued: true }
        : { ok: true, target: aim, who: aim === 'team' ? 'Galahs' : 'one device', sent: 1, failed: 0, dead: 0, remaining: 0, queued: false }) });
  });
  p.on('dialog', d => d.accept());
  async function typeSecond(pass) {
    await p.waitForSelector('#second:not(.hidden)');
    await p.fill('#second-pass', pass);
    await p.click('#second-go');
    await p.waitForTimeout(300);
  }
  await p.click('.tabs button[data-tab="push"]');
  await p.waitForTimeout(250);
  check('the push tab reports the subscriber count',
    (await p.textContent('#push-count')).includes('57 devices'), '');
  await p.fill('#push-title', 'Briefing 3 is live');
  await p.fill('#push-body', 'Check the quest list.');
  await p.click('#push-send');
  await p.waitForTimeout(100);
  check('the first click arms the send instead of a dialog',
    pushCalls.length === 0 && (await p.textContent('#push-send')).includes('Confirm'), '');
  await p.click('#push-send');
  await p.waitForTimeout(300);
  check('a send that needs the second password asks for it over the page, naming what asked',
    await p.isVisible('#second') && (await p.textContent('#second-what')).includes('Sending a push notification') &&
    pushCalls.length === 0, '');
  await p.fill('#second-pass', 'wrong');
  await p.click('#second-go');
  await p.waitForTimeout(300);
  check('a wrong one asks again and says so',
    await p.isVisible('#second') && (await p.textContent('#second-error')).includes('Wrong'), '');
  await p.fill('#second-pass', 'push-pass');
  await p.press('#second-pass', 'Enter');
  await p.waitForTimeout(300);
  check('the right one sends the same request again with it, and the send reports back',
    !(await p.isVisible('#second')) &&
    pushCalls.length === 1 && pushCalls[0].second === 'push-pass' &&
    pushCalls[0].title === 'Briefing 3 is live' &&
    pushCalls[0].target.kind === 'all' &&
    (await p.textContent('#push-status')).includes('Sent to 57 devices') &&
    (await p.textContent('#push-status')).includes('The other 40 go out') &&
    (await p.textContent('#push-status')).includes('2 dead'), JSON.stringify(pushCalls));

  // ---- who it goes to ----
  check('the devices are listed with what can safely be said about them',
    (await p.$$eval('#push-devices tr', els => els.length)) === 2 &&
    (await p.textContent('#push-devices')).includes('Apple') &&
    (await p.textContent('#push-devices')).includes('Galahs') &&
    (await p.textContent('#push-devices')).includes('not linked to a team') &&
    (await p.$eval('#push-devices input', el => el.value)) === 'Alex iPhone',
    await p.$eval('#push-devices input', el => el.value));

  // a send to one device is how you see an announcement before everyone does
  await p.click('#push-devices button:has-text("Send here")');
  check('Send here aims at that device and the button says so',
    (await p.$eval('#push-target', el => el.value)) === 'device' &&
    (await p.$eval('#push-device', el => el.value)) === '3' &&
    (await p.$eval('#push-device', el => el.classList.contains('hidden'))) === false &&
    (await p.textContent('#push-send')).includes('Alex iPhone'),
    await p.textContent('#push-send'));
  await p.fill('#push-title', 'Test one');
  await p.fill('#push-body', 'Checking how this looks.');
  await p.click('#push-send');
  await p.click('#push-send');
  await typeSecond('push-pass');
  check('it sends to that device alone, and leaves the message in the boxes to send for real',
    pushCalls.length === 2 && pushCalls[1].target.kind === 'device' && pushCalls[1].target.sub_id === 3 &&
    (await p.$eval('#push-title', el => el.value)) === 'Test one' &&
    (await p.textContent('#push-status')).includes('Alex iPhone'),
    JSON.stringify(pushCalls[1].target));

  await p.selectOption('#push-target', 'team');
  check('picking a team shows the team list and hides the device one',
    (await p.$eval('#push-team', el => el.classList.contains('hidden'))) === false &&
    (await p.$eval('#push-device', el => el.classList.contains('hidden'))) === true &&
    (await p.$$eval('#push-team option', els => els.map(e => e.textContent))).indexOf('Test Run') === -1,
    await p.textContent('#push-send'));
  await p.click('#push-send');
  await p.click('#push-send');
  await typeSecond('push-pass');
  check('and sends to that team only',
    pushCalls.length === 3 && pushCalls[2].target.kind === 'team' && pushCalls[2].target.team_id === 7,
    JSON.stringify(pushCalls[2].target));

  await p.fill('#push-devices input', 'Welfare tent');
  await p.click('#push-devices button:has-text("Save")');
  await p.waitForTimeout(300);
  check('a device can be given a name you will recognise',
    pushNames.length === 1 && pushNames[0].id === 3 && pushNames[0].label === 'Welfare tent' &&
    (await p.$eval('#push-devices input', el => el.value)) === 'Welfare tent',
    JSON.stringify(pushNames));

  await p.selectOption('#push-target', 'all');
  await p.fill('#push-title', ''); await p.fill('#push-body', '');

  // email announcements
  // The preview is the worker's HTML, which in HTML mode is whatever an
  // organiser typed. It is drawn in a frame that runs nothing, or a
  // script in a draft would run in the dashboard with the session in
  // reach.
  const annCalls = [];
  // email sending switched off on the Settings tab, as the Email tab's
  // read reports it, and whether the worker refuses a send for it
  let annEmailOff = false;
  let annRefuse = false;
  await p.route('**/api/console/announce', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, configured: true, email_off: annEmailOff, counts: { all: 120, teams: { 7: 4 } }, sends: [] }) }));
  const emailHolds = [];
  await p.route('**/api/console/email/hold', async r => {
    if (r.request().method() === 'POST') emailHolds.push(r.request().postDataJSON());
    const held = emailHolds.length ? emailHolds[emailHolds.length - 1].held : annEmailOff;
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, held: held }) });
  });
  await p.route('**/api/console/announce/preview', r => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ ok: true, html: '<html><body><p id="said">The briefing moves</p><script>parent.__annRan = 1;</script></body></html>', text: '' }) }));
  await p.route('**/api/console/announce/send', async r => {
    annCalls.push(r.request().postDataJSON());
    if (annRefuse) {
      await r.fulfill({ status: 409, contentType: 'application/json',
        body: JSON.stringify({ error: 'Email sending is off. Turn it on in Settings.', email_off: true }) });
      return;
    }
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true,
      send: { id: 1, subject: 'Briefing', audience: 'all', total: 120, sent: 120, failed: 0, status: 'done', created_at: '2026-10-19 22:10:00' } }) });
  });
  await p.click('.tabs button[data-tab="email"]');
  await p.waitForTimeout(250);
  await p.fill('#ann-subject', 'Briefing');
  await p.fill('#ann-body', '<p>The briefing moves</p>');
  await p.waitForTimeout(700);
  const frame = await p.$eval('#ann-preview', f => ({ sandbox: f.getAttribute('sandbox'), shown: !f.classList.contains('hidden'), doc: f.srcdoc }));
  check('the email preview is the worker\'s message, in a frame where nothing in it runs',
    frame.sandbox === '' && frame.shown && frame.doc.includes('The briefing moves') &&
    (await p.evaluate(() => window.__annRan)) === undefined, JSON.stringify({ sandbox: frame.sandbox, shown: frame.shown }));
  await p.click('#ann-send');
  const armed = (await p.textContent('#ann-send')).includes('Confirm: email 120 people') && annCalls.length === 0;
  await p.click('#ann-send');
  await p.waitForTimeout(300);
  check('two taps send it, the first saying how many people it reaches',
    armed && annCalls.length === 1 && annCalls[0].audience === 'all' && annCalls[0].subject === 'Briefing' &&
    (await p.textContent('#ann-status')).includes('120 of 120'), JSON.stringify(annCalls));

  // Email sending off: a pop-up each time the tab is opened, a line at
  // the top that stays once it is closed, and a way to the switch.
  const annOffView = () => p.evaluate(() => ({
    popup: !document.getElementById('email-off').classList.contains('hidden'),
    line: !document.getElementById('ann-mail-off').classList.contains('hidden'),
    send: document.getElementById('ann-send').disabled,
    test: document.getElementById('ann-test').disabled
  }));
  annEmailOff = true;
  await p.click('.tabs button[data-tab="push"]');
  await p.waitForTimeout(200);
  await p.click('.tabs button[data-tab="email"]');
  await p.waitForTimeout(300);
  const offOpened = await annOffView();
  const offSays = await p.textContent('#email-off');
  await p.click('#email-off-close');
  await p.waitForTimeout(100);
  const offClosed = await annOffView();
  check('with email off, opening the Email tab puts up a pop-up saying so, and the line at the top stays once it is closed',
    offOpened.popup && offOpened.line && offOpened.send && offOpened.test && /Email sending is off/.test(offSays) &&
    !offClosed.popup && offClosed.line && offClosed.send, JSON.stringify({ offOpened, offClosed }));
  await p.click('.tabs button[data-tab="push"]');
  await p.waitForTimeout(200);
  await p.click('.tabs button[data-tab="email"]');
  await p.waitForTimeout(300);
  await p.click('#email-off-go');
  await p.waitForTimeout(400);
  const toSettings = await p.evaluate(() => ({
    popup: !document.getElementById('email-off').classList.contains('hidden'),
    settings: !document.getElementById('view-settings').classList.contains('hidden'),
    ticked: document.getElementById('email-hold').checked
  }));
  check('Go to Settings opens the Settings tab with the switch ticked', !toSettings.popup && toSettings.settings && toSettings.ticked,
    JSON.stringify(toSettings));
  await p.click('#email-hold');
  await p.waitForTimeout(200);
  check('unticking it sends the switch as it now stands',
    emailHolds.length === 1 && emailHolds[0].held === false && !(await p.$eval('#email-hold', i => i.checked)), JSON.stringify(emailHolds));
  // a page that had not heard: the worker's refusal is said and the tab
  // turns to the off state
  annEmailOff = false;
  annRefuse = true;
  await p.click('.tabs button[data-tab="email"]');
  await p.waitForTimeout(300);
  await p.fill('#ann-subject', 'Briefing');
  await p.fill('#ann-body', '<p>The briefing moves</p>');
  await p.click('#ann-send');
  await p.click('#ann-send');
  await p.waitForTimeout(300);
  const refusedView = await annOffView();
  check('a send the worker refuses because email is off says the worker\'s reason, and the tab shows the line',
    annCalls.length === 2 && (await p.textContent('#toast')) === 'Email sending is off. Turn it on in Settings.' &&
    refusedView.line && refusedView.send && !refusedView.popup, JSON.stringify(refusedView));
  annRefuse = false;
  await p.fill('#ann-subject', '');
  await p.fill('#ann-body', '');

  // log
  await p.click('.tabs button[data-tab="log"]');
  await p.waitForTimeout(250);
  check('the log tab lists entries with the actor',
    (await p.textContent('#log-rows')).includes('console:Alex') && (await p.textContent('#log-rows')).includes('score-set'), '');
  // ---- accounts ----
  // The names the Accounts tab reads out of /api/console/accounts are an
  // agreement between this page and console.js, and nothing else would
  // notice one of them being renamed.
  await p.click('.tabs button[data-tab="accounts"]');
  await p.waitForTimeout(300);
  check('the Accounts tab reads who can sign in, what each may use, and who has been trying',
    (await p.textContent('#acc-rows')).includes('Alex (you)') &&
    (await p.textContent('#acc-rows')).includes('Queue, Messages') &&
    (await p.textContent('#acc-rows')).includes('9 backup left') &&
    (await p.textContent('#auth-attempts')).includes('Wrong code') &&
    (await p.textContent('#auth-attempts')).includes('ip:99887766') &&
    (await p.textContent('#auth-standing')).includes('2 refused in the last hour'), '');

  // a new account: ticking Admin ticks every tab and holds them there
  await p.click('#acc-new');
  await p.fill('#acc-name', 'Jo');
  await p.fill('#acc-pass', 'jo-password-1');
  await p.check('#acc-perms input[value="review"]');
  await p.check('#acc-admin');
  const underAdmin = await p.$$eval('#acc-perms input', is => is.every(i => i.checked && i.disabled));
  await p.uncheck('#acc-admin');
  const afterAdmin = await p.$$eval('#acc-perms input:checked', is => is.map(i => i.value));
  await p.check('#acc-perms input[value="messages"]');
  await p.uncheck('#acc-2fa');
  await p.click('#acc-save');
  await p.waitForTimeout(300);
  check('Admin ticks every tab while it is on, and gives back the ones picked before',
    underAdmin && afterAdmin.join() === 'review', JSON.stringify(afterAdmin));
  check('a new account goes to the worker with its password, its tabs and whether it needs a code',
    accountSaves.length === 1 && accountSaves[0].create === true && accountSaves[0].name === 'Jo' &&
    accountSaves[0].password === 'jo-password-1' && accountSaves[0].admin === false &&
    accountSaves[0].perms.join() === 'review,messages' && accountSaves[0].require_2fa === false &&
    !(await p.isVisible('#acc-edit')), JSON.stringify(accountSaves));

  // somebody else's phone is gone: their account resets once the name
  // is typed back; your own has nothing to press
  await p.click('#acc-rows tr:nth-child(1) button:has-text("Edit")');
  const ownDanger = await p.$$eval('#acc-danger button', bs => bs.length);
  await p.click('#acc-rows tr:nth-child(2) button:has-text("Edit")');
  await p.click('#acc-danger button:has-text("Reset code")');
  await p.fill('#acc-danger input', 'Sam');
  await p.click('#acc-danger button:has-text("Reset Sam")');
  await p.waitForTimeout(300);
  check('resetting another account posts its name once it is typed back, and your own cannot be',
    ownDanger === 0 && authResets.length === 1 &&
    authResets[0].method === 'POST' && authResets[0].body.name === 'Sam', JSON.stringify({ ownDanger, authResets }));

  await p.check('#guard-rows label:has-text("Freezing") input');
  await typeSecond('push-pass');
  check('ticking an action to ask for the second password asks for it first',
    secondSets.length === 1 && secondSets[0].body.key === 'freeze' && secondSets[0].body.on === true &&
    secondSets[0].second === 'push-pass', JSON.stringify(secondSets));

  // ---- the tab survives a reload ----
  // The dashboard gets reloaded all day — a flaky venue connection, a
  // phone waking up — and landing on Scores every time means finding
  // your place again on every one of them.
  const histBefore = await p.evaluate(() => history.length);
  await p.click('.tabs button[data-tab="rego"]');
  await p.waitForTimeout(200);
  await p.click('.tabs button[data-tab="log"]');
  await p.waitForTimeout(200);
  check('switching tabs writes the address but adds nothing to the back button',
    (await p.evaluate(() => location.hash)) === '#log' &&
    (await p.evaluate(() => history.length)) === histBefore,
    (await p.evaluate(() => location.hash + ' / ' + history.length)));

  // session survives reload
  await p.goto('https://tab.example/console');
  await p.waitForTimeout(400);
  check('the session survives a reload', await p.isVisible('#main'), '');
  check('and it comes back on the tab that was open, with the pill on it',
    await p.isVisible('#view-log') && !(await p.isVisible('#view-tab')) &&
    await p.evaluate(() => document.querySelector('[data-tab="log"]').classList.contains('is-active')) &&
    await p.evaluate(() => {
      const pill = document.querySelector('.tabs-pill').getBoundingClientRect();
      const b = document.querySelector('[data-tab="log"]').getBoundingClientRect();
      return Math.abs(pill.left - b.left) < 2 && Math.abs(pill.top - b.top) < 2;
    }),
    await p.evaluate(() => document.querySelector('.tabs button.is-active').dataset.tab));

  // A link to one tab, which is the other half of putting it in the
  // address: an organiser can send "look at Rego" rather than describe
  // where to click.
  await p.goto('https://tab.example/console#rego');
  await p.waitForTimeout(400);
  check('a link straight to a tab opens it, beating what was last open',
    await p.isVisible('#view-rego') && !(await p.isVisible('#view-log')),
    await p.evaluate(() => document.querySelector('.tabs button.is-active').dataset.tab));

  // The line above is a fragment change, which a browser answers
  // without reloading anything. A bookmark is the other case: the page
  // loads from nothing with the tab already in the address.
  await p.reload();
  await p.waitForTimeout(400);
  check('and a bookmark to one opens it from a cold start',
    await p.isVisible('#view-rego') && !(await p.isVisible('#view-log')) &&
    await p.evaluate(() => document.querySelector('[data-tab="rego"]').classList.contains('is-active')),
    await p.evaluate(() => document.querySelector('.tabs button.is-active').dataset.tab));

  // A tab that no longer exists must not leave the page showing
  // nothing at all.
  await p.goto('https://tab.example/console#nosuchtab');
  await p.waitForTimeout(400);
  check('an address naming a tab that is not there falls back rather than blanking',
    await p.isVisible('#view-rego') &&
    (await p.evaluate(() => location.hash)) === '#rego',
    await p.evaluate(() => location.hash + ' ' +
      document.querySelector('.tabs button.is-active').dataset.tab));

  // An account that only reviews: the tabs it cannot use are not drawn
  // at all, and an address or a stored tab naming one lands on its own.
  meState = { ok: true, name: 'Sam', admin: false, perms: ['review'], code: true };
  await p.goto('https://tab.example/console#log');
  await p.reload();
  await p.waitForTimeout(500);
  const samTabs = await p.$$eval('.tabs button[data-tab]', bs => bs.filter(b => b.offsetParent !== null).map(b => b.dataset.tab));
  check('an account that only reviews sees the Queue, the quests\u2019 desks and the teams\u2019 ledgers and no other tab, and lands on the Queue wherever the address pointed',
    samTabs.join() === 'review,desk,ledger' && await p.isVisible('#view-review') && !(await p.isVisible('#view-log')) &&
    (await p.evaluate(() => location.hash)) === '#review', JSON.stringify(samTabs));
  // a marshal: Points on one quest lands on that quest's desk
  meState = { ok: true, name: 'Kim', admin: false, perms: ['points'], quests: ['SQ5'], code: true };
  await p.evaluate(() => { try { localStorage.removeItem('scs2-dashboard-tab'); } catch (e) {} });
  await p.goto('https://tab.example/console#log');
  await p.reload();
  await p.waitForTimeout(600);
  const kimTabs = await p.$$eval('.tabs button[data-tab]', bs => bs.filter(b => b.offsetParent !== null).map(b => b.dataset.tab));
  check('an account with Points on one quest lands on that quest\u2019s desk with the form to record a result',
    kimTabs.join() === 'desk,ledger' && (await p.evaluate(() => location.hash)) === '#desk' &&
    (await p.inputValue('#desk-quest')) === 'SQ5' && await p.isVisible('#desk-record'), JSON.stringify(kimTabs));
  meState = { ok: true, name: 'Alex', admin: true, perms: ALL_TABS, code: true };

  // back to the log tab, which is where the checks below carry on from
  await p.goto('https://tab.example/console#log');
  await p.reload();
  await p.waitForTimeout(400);

  // ---- the day board ----
  await p.click('[data-tab="tab"]');
  await p.waitForTimeout(300);
  const board = await p.$$eval('#board .stat', cards => cards.map(c => c.textContent));
  check('the Scores tab opens on the day: review, the last two hours, the room, the machines',
    board.length === 6 &&
    board[0].includes('Waiting on review') && board[0].includes('3') && board[0].includes('oldest') &&
    board[1].includes('7') && board[1].includes('4 in the hour before') &&
    board[2].includes('88') && board[2].includes('of 120 registered') &&
    board[3].includes('43') && board[3].includes('1 hidden') &&
    board[4].includes('57') && board[5].includes('2 videos waiting'), JSON.stringify(board));
  check('and says under the numbers what the worker still has in hand',
    /1 push announcement still going out/.test(await p.textContent('#sched-state')) &&
    /30 emails of an announcement still to send/.test(await p.textContent('#sched-state')) &&
    /2 ticket emails still being retried/.test(await p.textContent('#sched-state')) &&
    await p.isVisible('#sched-state'),
    await p.textContent('#sched-state'));

  // ---- the Settings tab's tools ----
  await p.click('.tabs button[data-tab="settings"]');
  await p.waitForTimeout(300);

  // ---- one file with everything in it ----
  await p.click('#export-all');
  await p.waitForTimeout(400);
  check('Export everything asks the worker for the lot and says what came back',
    calls.exports === 1 && (await p.textContent('#toast')).includes('tables'), await p.textContent('#toast'));

  // ---- freezing the tab ----
  // tidying the photo storage walks every file in batches
  await p.click('#reclean');
  await p.waitForTimeout(600);
  check('Tidy photo storage keeps asking until the worker says it is done, then reports the total',
    recleanCalls.length === 3 && JSON.stringify(recleanCalls) === '[0,12,24]' &&
    /Deleted 11 old copies from 28 files/.test(await p.textContent('#reclean-out')),
    JSON.stringify({ recleanCalls, out: await p.textContent('#reclean-out') }));

  await p.click('#storage-count');
  await p.waitForTimeout(600);
  const storage = await p.evaluate(() => ({
    stats: [...document.querySelectorAll('#storage-view .stat')].map(s => s.querySelector('.stat-label').textContent + ': ' + s.querySelector('.stat-num').textContent.replace(/\u00a0/g, ' ')),
    state: document.getElementById('storage-state').textContent
  }));
  check('Storage follows the cursor to the end and adds the answers up',
    JSON.stringify(storageCalls) === '["","page-2"]' &&
    storage.stats.indexOf('Stored in all: 11 MB') !== -1 && storage.stats.indexOf('Files as sent: 4 MB') !== -1 &&
    storage.stats.indexOf('Not linked to anything: 1 KB') !== -1 && /Counted 5 files/.test(storage.state),
    JSON.stringify({ storageCalls, storage }));

  // ---- personal data: a copy, then removing with that copy ----
  check('an admin sees the Personal data and Original videos cards, filled in from the worker',
    await p.isVisible('#set-privacy') && await p.isVisible('#set-originals') &&
    /2 email addresses/.test(await p.textContent('#privacy-state')) && /5 originals kept/.test(await p.textContent('#originals-state')),
    await p.textContent('#privacy-state'));
  const [saveCopy] = await Promise.all([p.waitForEvent('download'), p.click('#privacy-export')]);
  const savedCopy = JSON.parse(require('fs').readFileSync(await saveCopy.path(), 'utf8'));
  check('Download saves the copy the worker made, under its name',
    saveCopy.suggestedFilename() === 'scs2-personal-data-2026-11-04.json' && savedCopy.kind === 'scs2-personal-data' && savedCopy.people.length === 2);
  const [copyChooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('#privacy-remove')]);
  await copyChooser.setFiles({ name: 'copy.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(personalCopy)) });
  await p.waitForSelector('#privacy-remove-host .danger');
  const armedRemove = await p.textContent('#privacy-remove-host .danger');
  await p.click('#privacy-remove-host .danger');
  await p.waitForTimeout(300);
  check('removing asks for the copy, names how many people, and sends the copy itself',
    /Remove 2 people/.test(armedRemove) && privacyCalls.remove.length === 1 && privacyCalls.remove[0].copy.people.length === 2 &&
    /Removed 2 people/.test(await p.textContent('#privacy-remove-out')), armedRemove);

  // ---- original videos: deleting runs batch after batch ----
  await p.click('#originals-delete-host button');
  await p.click('#originals-delete-host .danger');
  await typeSecond('push-pass');
  await p.waitForTimeout(500);
  check('deleting the saved originals keeps asking until the worker says it is done, with the second password typed once, then says how much went',
    JSON.stringify(privacyCalls.deletes) === '[0,40]' && privacyCalls.asked === 1 &&
    /Deleted 4 originals, 4\sGB/.test(await p.textContent('#originals-delete-out')),
    JSON.stringify({ calls: privacyCalls.deletes, asked: privacyCalls.asked, out: await p.textContent('#originals-delete-out') }));

  // ---- the numbers Settings can change ----
  check('Settings carries the pending cap, filled in from the worker',
    (await p.$eval('#lim-submit-max-pending', el => el.value)) === '12', '');
  await p.fill('#lim-submit-max-pending', '30');
  await p.click('#lim-save');
  await p.waitForTimeout(400);
  check('raising it sends the number and says it has moved off the default',
    limitSaves.length === 1 && limitSaves[0].submit_max_pending === 30 &&
    (await p.textContent('#lim-state')).includes('Changed from 12'),
    JSON.stringify({ saves: limitSaves, state: await p.textContent('#lim-state') }));
  await p.fill('#lim-album-per-hour', '120');
  await p.click('#lim-album-save');
  await p.waitForTimeout(400);
  check('the albums\' hourly number is saved under the name the upload reads, alone',
    limitSaves.length === 2 && JSON.stringify(limitSaves[1]) === '{"album_anyone_per_hour":120}' &&
    (await p.textContent('#lim-album-state')).includes('Changed from 40'),
    JSON.stringify({ saves: limitSaves, state: await p.textContent('#lim-album-state') }));

  // ---- the countdown on the home page ----
  check('Settings carries the countdown, one row per stop, saying which one is live',
    (await p.$$eval('#cd-rows .cd-row', els => els.length)) === 1 &&
    (await p.$eval('#cd-rows .cd-label', el => el.value)) === 'SCS.2 starts' &&
    (await p.textContent('#cd-state')).includes('Counting to SCS.2 starts'),
    await p.textContent('#cd-state'));
  await p.click('#cd-add');
  await p.fill('#cd-rows .cd-row:last-child .cd-label', 'Submissions close');
  await p.fill('#cd-rows .cd-row:last-child .cd-at', '2026-10-20T17:00');
  await p.click('#cd-save');
  await p.waitForTimeout(400);
  check('adding a stop and saving sends the whole list, times converted out of this computer\'s clock',
    cdSaves.length === 1 && cdSaves[0].length === 2 &&
    cdSaves[0][1].label === 'Submissions close' && /^2026-10-\d\d \d\d:\d\d:00$/.test(cdSaves[0][1].at),
    JSON.stringify(cdSaves[0]));
  await p.click('#cd-rows .cd-row:last-child button');
  await p.click('#cd-save');
  await p.waitForTimeout(400);
  check('removing one and saving takes it away rather than leaving it behind',
    cdSaves.length === 2 && cdSaves[1].length === 1 &&
    (await p.$$eval('#cd-rows .cd-row', els => els.length)) === 1, JSON.stringify(cdSaves[1]));

  await p.click('[data-tab="tab"]');
  await p.waitForTimeout(300);
  check('the Scores tab carries the freeze, saying which way round it is',
    /live/i.test(await p.textContent('#freeze-state')) &&
    (await p.textContent('#freeze-btn')) === 'Freeze the tab', '');
  await p.click('#freeze-btn');
  await p.waitForTimeout(200);
  check('one tap only arms it — nothing is sent',
    calls.freeze.length === 0 && (await p.textContent('#freeze-btn')).includes('Tap again'), JSON.stringify(calls.freeze));
  await p.click('#freeze-btn');
  await p.waitForTimeout(500);
  check('the second tap freezes it and the card says when it stopped',
    calls.freeze.length === 1 && calls.freeze[0].frozen === true &&
    (await p.textContent('#freeze-state')).includes('Frozen since') &&
    (await p.textContent('#freeze-btn')) === 'Unfreeze the tab', JSON.stringify(calls.freeze));
  check('and the card marks itself while the tab is stopped',
    await p.$eval('.freeze-card', el => el.classList.contains('is-frozen')), '');
  await p.click('#freeze-btn');
  await p.click('#freeze-btn');
  await p.waitForTimeout(500);
  check('the same two taps put it back live',
    calls.freeze.length === 2 && calls.freeze[1].frozen === false &&
    /live/i.test(await p.textContent('#freeze-state')), JSON.stringify(calls.freeze));

  // closing is two taps as well
  await p.click('#close-btn');
  await p.waitForTimeout(150);
  const closeArmed = calls.close.length === 0 && (await p.textContent('#close-btn')).includes('Tap again');
  await p.click('#close-btn');
  await p.waitForTimeout(500);
  check('closing takes two taps too, and then the card says teams see no standings',
    closeArmed && calls.close.length === 1 && calls.close[0].closed === true &&
    /Closed since/.test(await p.textContent('#freeze-state')) && (await p.textContent('#close-btn')) === 'Open the tab',
    JSON.stringify(calls.close));
  await p.click('#close-btn');
  await p.click('#close-btn');
  await p.waitForTimeout(400);

  // the saved copies, newest first, each board with what moved since the one before
  const copyRows = () => p.$$eval('#copy-view tbody tr', rows => rows.map(r => [...r.cells].map(c => c.textContent)));
  const firstShown = await copyRows();
  const options = await p.$$eval('#copy-pick option', os => os.map(o => o.textContent));
  await p.click('#copy-prev');
  await p.waitForTimeout(400);
  const earlier = await copyRows();
  check('the saved standings list newest first, and each board says what moved since the copy before it',
    options.length === 3 && /On the hour/.test(options[0]) && /Galahs leads on 4,467/.test(options[0]) &&
    /At the freeze/.test(options[1]) &&
    firstShown.length === 2 && firstShown[0][1] === 'Galahs' && firstShown[0][3] === '+267' &&
    earlier[0][3] === '+300, up 1' && earlier[1][3] === '+50, down 1',
    JSON.stringify({ options, firstShown, earlier }));
  await p.click('#copy-freeze');
  await p.click('#copy-freeze');
  await p.waitForTimeout(400);
  check('Freeze the tab with this sends the copy that is showing',
    calls.freeze.length === 3 && calls.freeze[2].frozen === true && calls.freeze[2].copy_id === 2,
    JSON.stringify(calls.freeze[2]));
  // the standings as they are, and a saved copy, each as a picture
  await p.evaluate(() => {
    window.__copied = [];
    navigator.clipboard.write = items => Promise.all(items.map(item => item.getType('image/png'))).then(blobs => {
      blobs.forEach(b => window.__copied.push({ type: b.type, size: b.size }));
    });
  });
  await p.click('#standings-image');
  await p.waitForTimeout(500);
  await p.click('#copy-image');
  await p.waitForTimeout(500);
  const standingsCopied = await p.evaluate(() => window.__copied);
  check('the live standings and a saved copy both go onto the clipboard as PNGs',
    standingsCopied.length === 2 && standingsCopied.every(c => c.type === 'image/png' && c.size > 1000),
    JSON.stringify(standingsCopied));

  // ---- files to share, and the short links that point at them ----
  await p.click('.tabs button[data-tab="files"]');
  await p.waitForTimeout(400);
  check('the Files tab lists the drop, and the address it hands out is on the public hostname',
    (await p.$$eval('#drop-rows tr', els => els.length)) === 1 &&
    (await p.textContent('#drop-rows')).includes('Day Two Poster.png') &&
    (await p.textContent('#drop-rows')).includes('234 KB') &&
    (await p.$eval('#drop-rows a', el => el.href)) ===
      'https://files.example/api/drop/drop/abc123def456/Day%20Two%20Poster.png',
    await p.$eval('#drop-rows a', el => el.href));
  check('the short links are listed with where they point and how often they have been opened',
    (await p.$eval('#link-rows a', el => el.textContent)) === '/info' &&
    (await p.textContent('#link-rows')).includes('12') &&
    (await p.textContent('#link-rows')).includes('Day Two Poster.png') &&
    (await p.textContent('#link-host')) === 'go.example/',
    await p.textContent('#link-host'));

  await p.setInputFiles('#drop-file', { name: 'map.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
  await p.fill('#drop-note', 'The walking route');
  await p.click('#drop-send');
  await p.waitForTimeout(400);
  check('uploading sends the file and what it is as one multipart form',
    dropUploads.length === 1 && dropUploads[0].includes('map.png') &&
    dropUploads[0].includes('The walking route') &&
    (await p.$eval('#drop-note', el => el.value)) === '',
    JSON.stringify({ sent: dropUploads.length, cleared: await p.$eval('#drop-note', el => el.value) }));

  // a file is replaced where it is, under its own key, so its links stay
  await p.click('#drop-rows button:has-text("Edit")');
  await p.setInputFiles('#drop-rows input[type=file]', { name: 'poster-v2.png', mimeType: 'image/png', buffer: Buffer.from([137, 80, 78, 71]) });
  await p.click('#drop-rows button:has-text("Save")');
  await p.waitForTimeout(400);
  check('Edit sends the replacement with the file\'s key and its name kept, and the row comes back',
    dropEdits.length === 1 && /name="key"\r\n\r\ndrop\/abc123def456\r\n/.test(dropEdits[0]) &&
    /name="name"\r\n\r\nDay Two Poster\.png\r\n/.test(dropEdits[0]) && dropEdits[0].includes('poster-v2.png') &&
    (await p.$$eval('#drop-rows input[type=file]', els => els.length)) === 0,
    JSON.stringify({ sent: dropEdits.length }));

  // a link to a file is offered the file's own name, extension and all
  await p.click('#drop-rows button:has-text("Short link")');
  check('Short link fills the form from the file, keeping the extension that makes it embed',
    (await p.$eval('#link-slug', el => el.value)) === 'day-two-poster.png' &&
    (await p.$eval('#link-kind', el => el.value)) === 'file' &&
    (await p.$eval('#link-file', el => el.value)) === 'drop/abc123def456' &&
    (await p.$eval('#link-target', el => el.classList.contains('hidden'))) === true,
    await p.$eval('#link-slug', el => el.value));
  await p.click('#link-save');
  await p.waitForTimeout(400);
  check('and saving it sends the file, not an address',
    linkSaves.length === 1 && linkSaves[0].kind === 'file' &&
    linkSaves[0].slug === 'day-two-poster.png' && linkSaves[0].file_key === 'drop/abc123def456' &&
    linkSaves[0].was === '', JSON.stringify(linkSaves[0]));

  // renaming one has to carry the name it started as, or the old name
  // is left answering
  await p.click('#link-rows button:has-text("Edit")');
  check('editing a link loads it, and offers a way out',
    (await p.$eval('#link-slug', el => el.value)) === 'info' &&
    (await p.$eval('#link-target', el => el.value)) === 'https://scs.andyrew.space/info/' &&
    (await p.textContent('#link-save')) === 'Save changes' &&
    (await p.$$eval('#link-save + button:has-text("Cancel")', els => els.length)) === 1, '');
  await p.fill('#link-slug', 'about');
  await p.click('#link-save');
  await p.waitForTimeout(400);
  check('saving a rename says which name it started as',
    linkSaves.length === 2 && linkSaves[1].slug === 'about' && linkSaves[1].was === 'info' &&
    (await p.textContent('#link-save')) === 'Save link', JSON.stringify(linkSaves[1]));

  await p.click('#link-rows button:has-text("Delete")');
  check('deleting a link asks first', linkDeletes.length === 0 &&
    (await p.textContent('#link-rows')).includes('Delete /info?'), await p.textContent('#link-rows'));
  await p.click('#link-rows button:has-text("Cancel")');
  check('and the question can be answered no', linkDeletes.length === 0 &&
    !(await p.textContent('#link-rows')).includes('Delete /info?'), '');

  // a file goes with every link pointing at it, so the question says so
  await p.click('#drop-rows button:has-text("Delete")');
  check('deleting a file says what else goes with it', dropDeletes.length === 0 &&
    (await p.textContent('#drop-rows')).includes('Delete, and drop 1 short link?'),
    await p.textContent('#drop-rows'));
  await p.click('#drop-rows button:has-text("Delete")');
  await p.waitForTimeout(400);
  check('answering yes sends the key and the table empties',
    dropDeletes.length === 1 && dropDeletes[0].key === 'drop/abc123def456' &&
    (await p.textContent('#drop-rows')).includes('Nothing uploaded yet'),
    JSON.stringify(dropDeletes));

  // an album can show some teams' gallery photos without the whole gallery
  await p.fill('#alb-name', 'Galahs on the day');
  await p.check('#alb-teams input[value="7"]');
  await p.click('#alb-save');
  await p.waitForTimeout(400);
  check('the album form sends the teams ticked for their gallery photos',
    albumSaves.length === 1 && JSON.stringify(albumSaves[0].teams) === '[7]' && albumSaves[0].gallery === false,
    JSON.stringify(albumSaves));

  // a merged album: only albums that merge nothing can be ticked, and an
  // organisers-only album's Open asks for a pass and goes there
  const albumRow = (id, name, visibility, merges) => ({ id, slug: name.toLowerCase(), name, about: '', adding: 'closed', gallery: false,
    hidden: visibility === 'hidden', show_hidden: false, details: true, sort: id, default_order: 'added', visibility, link_key: 'k' + id,
    merges, count: 2, uploads: 2, teams: [] });
  albumState.albums = [albumRow(3, 'Day One', 'listed', []), albumRow(4, 'Everything', 'hidden', [3])];
  const passAsks = [];
  await p.route('**/api/console/album/pass**', r => {
    passAsks.push(new URL(r.request().url()).searchParams.get('id'));
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, url: 'https://scs.example/albums/?pass=4.1.sig', hours: 24 }) });
  });
  await p.context().route('https://scs.example/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: '<p>album</p>' }));
  await p.fill('#alb-name', 'All of it');
  await p.click('#alb-save');
  await p.waitForTimeout(400);
  const offered = await p.$$eval('#alb-merges input', els => els.map(i => i.value));
  await p.fill('#alb-name', 'All of it');
  await p.check('#alb-merges input[value="3"]');
  await p.click('#alb-save');
  await p.waitForTimeout(400);
  const popup = p.context().waitForEvent('page', { timeout: 4000 }).catch(() => null);
  await p.click('#alb-rows tr:nth-child(2) button:has-text("Open")');
  const passTab = await popup;
  if (passTab) await passTab.waitForURL('https://scs.example/**', { timeout: 4000 }).catch(() => {});
  check('the album form offers only albums that merge nothing, sends the ones ticked as merges, and Open goes to the pass the worker made',
    JSON.stringify(offered) === '["3"]' && JSON.stringify(albumSaves[2].merges) === '[3]' &&
    JSON.stringify(passAsks) === '["4"]' && !!passTab && passTab.url() === 'https://scs.example/albums/?pass=4.1.sig',
    JSON.stringify({ offered, saved: albumSaves[2], passAsks, passTab: passTab && passTab.url() }));
  if (passTab) await passTab.close();

  // ---- the pictures on the home page ----
  await p.click('.tabs button[data-tab="settings"]');
  await p.waitForTimeout(400);
  check('the Settings tab lists the home page pictures in the order they play',
    (await p.$$eval('#slide-rows tr', els => els.length)) === 2 &&
    (await p.textContent('#slide-rows')).includes('Quad.png') &&
    (await p.$$eval('#slide-rows input', els => els.map(i => i.value)))
      .join(' | ') === 'Teams waiting in the quad | Before the start | The last team over the line | ',
    JSON.stringify(await p.$$eval('#slide-rows input', els => els.map(i => i.value))));
  check('each row shows the picture, asking the file endpoint for the small copy',
    (await p.$$eval('#slide-rows img.slide-whole', els => els.length)) === 2 &&
    slideThumbs.some(u => u.includes('key=slide%2Faaa111bbb222') && u.includes('thumb=1')),
    JSON.stringify(slideThumbs));
  check('and the alt text is on the thumbnail too, so the dashboard reads the way the home page will',
    (await p.$eval('#slide-rows img', el => el.alt)) === 'Teams waiting in the quad',
    await p.$eval('#slide-rows img', el => el.alt));

  // where the home page crops it: a click on the picture sets the point
  // and saves it, and the two previews beside it crop round it
  const picture = p.locator('#slide-rows tr:nth-child(1) img.slide-whole');
  await picture.scrollIntoViewIfNeeded();
  const whole = await picture.boundingBox();
  await picture.click({ position: { x: whole.width * 0.25, y: whole.height * 0.75 } });
  await p.waitForTimeout(700);
  const crops = await p.$$eval('#slide-rows tr:nth-child(1) .slide-crop img', els => els.map(e => e.style.objectPosition));
  check('a click on a picture sets the point the home page crops it round, and the computer and phone previews follow',
    slideFocuses.length === 1 && slideFocuses[0].key === 'slide/aaa111bbb222' &&
    Math.abs(slideFocuses[0].x - 25) <= 1 && Math.abs(slideFocuses[0].y - 75) <= 1 &&
    crops.length === 2 && crops.every(c => c === slideFocuses[0].x + '% ' + slideFocuses[0].y + '%'),
    JSON.stringify({ slideFocuses, crops }));

  // alt text is not optional: the send is stopped before anything goes out
  await p.setInputFiles('#slide-file', { name: 'ceremony.png', mimeType: 'image/png', buffer: onePixel });
  await p.click('#slide-send');
  await p.waitForTimeout(300);
  check('a picture with nothing said about it is not sent',
    slideSaves.length === 0 && (await p.textContent('#toast')).includes('what the picture shows'),
    await p.textContent('#toast'));

  await p.fill('#slide-alt', 'The prizes being handed out');
  await p.fill('#slide-caption', 'The ceremony');
  await p.click('#slide-send');
  // the PNG and its preview are made first, which takes most of a second
  for (let i = 0; i < 50 && !slideSaves.length; i++) await p.waitForTimeout(100);
  await p.waitForTimeout(300);
  check('with the alt text filled in it goes as one multipart form, picture, words and preview',
    slideSaves.length === 1 && slideSaves[0].includes('ceremony.png') &&
    slideSaves[0].includes('The prizes being handed out') &&
    slideSaves[0].includes('The ceremony') && slideSaves[0].includes('name="thumb"'),
    JSON.stringify({ sent: slideSaves.length, thumb: !!slideSaves[0] && slideSaves[0].includes('name="thumb"') }));
  check('and the boxes clear, with the new picture on the end of the list',
    (await p.$eval('#slide-alt', el => el.value)) === '' &&
    (await p.$eval('#slide-caption', el => el.value)) === '' &&
    (await p.$$eval('#slide-rows tr', els => els.length)) === 3 &&
    (await p.textContent('#slide-rows')).includes('Ceremony.png'), '');

  // editing the words on a picture already up
  await p.fill('#slide-rows tr:nth-child(2) input:nth-of-type(1)', 'The last team crossing the line');
  await p.click('#slide-rows tr:nth-child(2) button:has-text("Save")');
  await p.waitForTimeout(400);
  check('editing a picture sends its key, alt and caption',
    slideEdits.length === 1 && slideEdits[0].key === 'slide/ccc333ddd444' &&
    slideEdits[0].alt === 'The last team crossing the line' && slideEdits[0].caption === '',
    JSON.stringify(slideEdits[0]));

  await p.fill('#slide-rows tr:nth-child(1) input:nth-of-type(1)', '   ');
  await p.click('#slide-rows tr:nth-child(1) button:has-text("Save")');
  await p.waitForTimeout(300);
  check('and an edit that empties the alt text is stopped here too',
    slideEdits.length === 1 && (await p.textContent('#toast')).includes('what the picture shows'),
    await p.textContent('#toast'));

  // reordering: the whole list goes up in its new order
  check('the first row cannot move up and the last cannot move down',
    (await p.$eval('#slide-rows tr:nth-child(1) button:has-text("Up")', el => el.disabled)) === true &&
    (await p.$eval('#slide-rows tr:nth-child(3) button:has-text("Down")', el => el.disabled)) === true, '');
  await p.click('#slide-rows tr:nth-child(2) button:has-text("Up")');
  await p.waitForTimeout(400);
  check('moving one up sends every key in the new order',
    slideOrders.length === 1 &&
    slideOrders[0].join() === 'slide/ccc333ddd444,slide/aaa111bbb222,slide/eee555fff666',
    JSON.stringify(slideOrders[0]));

  // deleting asks for the file name back before it goes
  await p.click('#slide-rows tr:nth-child(1) button:has-text("Delete")');
  check('deleting a picture asks for its file name first',
    slideDeletes.length === 0 &&
    (await p.$eval('#slide-rows input[placeholder="Type the file name to confirm"]', el => !!el)),
    '');
  await p.fill('#slide-rows input[placeholder="Type the file name to confirm"]', 'Quad.png');
  await p.click('#slide-rows tr:nth-child(1) button:has-text("Delete")');
  await p.waitForTimeout(300);
  check('the wrong name does not delete anything', slideDeletes.length === 0, '');
  await p.fill('#slide-rows input[placeholder="Type the file name to confirm"]', 'Finish.png');
  await p.click('#slide-rows tr:nth-child(1) button:has-text("Delete")');
  await p.waitForTimeout(500);
  check('the right one sends the key and the row goes',
    slideDeletes.length === 1 && slideDeletes[0].key === 'slide/ccc333ddd444' &&
    (await p.$$eval('#slide-rows tr', els => els.length)) === 2 &&
    !(await p.textContent('#slide-rows')).includes('Finish.png'),
    JSON.stringify(slideDeletes));

  {
  // edit mode: the pictures as tiles, dragged to a new place (saved when
  // a tile lands), picked with a click and hidden from the slideshow
  await p.click('#slide-edit');
  await p.waitForTimeout(200);
  const tileKeys = () => p.$$eval('#slide-board .slide-tile', els => els.map(e => e.getAttribute('data-key')));
  const before = await tileKeys();
  const ordersBefore = slideOrders.length;
  const tiles = p.locator('#slide-board .slide-tile');
  const a = await tiles.nth(0).boundingBox();
  const bBox = await tiles.nth(1).boundingBox();
  await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await p.mouse.down();
  for (let i = 1; i <= 10; i++) {
    await p.mouse.move(a.x + a.width / 2 + (bBox.x + bBox.width * 0.8 - a.x - a.width / 2) * i / 10, bBox.y + bBox.height / 2);
    await p.waitForTimeout(20);
  }
  await p.mouse.up();
  await p.waitForTimeout(400);
  const moved = slideOrders.slice(ordersBefore);
  const after = await tileKeys();
  await tiles.nth(0).click();
  await p.waitForTimeout(100);
  const picked = await p.textContent('#slide-picked');
  await p.click('#slide-hide');
  await p.waitForTimeout(400);
  const hiddenTile = await p.$eval('#slide-board .slide-tile:first-child', el => el.classList.contains('is-hidden'));
  await p.click('#slide-done');
  await p.waitForTimeout(200);
  const backToRows = await p.evaluate(() => ({ table: !document.getElementById('slide-table').hidden, board: document.getElementById('slide-board').hidden, count: document.getElementById('slide-count').textContent }));
  check('edit mode: a tile dragged past the next one moves and saves, a click picks one and Hide takes it out of the slideshow, still on the card',
    before.length === 2 && moved.length === 1 && moved[0].join() === [before[1], before[0]].join() && after.join() === moved[0].join() &&
    picked === '1 picked' && slideHides.length === 1 && slideHides[0].hidden === true && slideHides[0].keys.join() === after[0] &&
    hiddenTile && backToRows.table && backToRows.board && /1 hidden/.test(backToRows.count),
    JSON.stringify({ before, moved, after, picked, slideHides, hiddenTile, backToRows }));
  }

  {
  // A finger on an iPad: a swipe over the board scrolls the page and
  // moves nothing, and a tile held still for a moment first is dragged
  // as the mouse drags it. Real touches, through the browser's own input.
  await p.click('#slide-edit');
  await p.waitForTimeout(200);
  const cdp = await p.context().newCDPSession(p);
  const finger = async (from, to, hold) => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from[0], y: from[1] }] });
    if (hold) await p.waitForTimeout(hold);
    for (let i = 1; i <= 8; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from[0] + (to[0] - from[0]) * i / 8, y: from[1] + (to[1] - from[1]) * i / 8 }] });
      await p.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await p.waitForTimeout(400);
  };
  const tileKeys = () => p.$$eval('#slide-board .slide-tile', els => els.map(e => e.getAttribute('data-key')));
  const middle = async (n) => {
    const b = await p.locator('#slide-board .slide-tile').nth(n).boundingBox();
    return [b.x + b.width / 2, b.y + b.height / 2, b];
  };
  await p.evaluate(() => document.getElementById('slide-board').scrollIntoView({ block: 'center' }));
  const before = await tileKeys();
  const ordersBefore = slideOrders.length;
  const y0 = await p.evaluate(() => window.scrollY);
  const a = await middle(0);
  await finger(a, [a[0], a[1] - 150]);
  const swipe = { scrolled: (await p.evaluate(() => window.scrollY)) - y0, kept: (await tileKeys()).join() === before.join(), sent: slideOrders.length - ordersBefore };
  await p.evaluate(() => document.getElementById('slide-board').scrollIntoView({ block: 'center' }));
  const from = await middle(0);
  const to = (await middle(1))[2];
  const y1 = await p.evaluate(() => window.scrollY);
  await finger(from, [to.x + to.width * 0.8, to.y + to.height / 2], 450);
  const held = { scrolled: (await p.evaluate(() => window.scrollY)) - y1, sent: slideOrders.slice(ordersBefore) };
  await p.click('#slide-done');
  await p.waitForTimeout(200);
  check('a finger on the slide board: a swipe scrolls the page and moves nothing, a hold then a drag moves the tile and saves',
    swipe.scrolled > 50 && swipe.kept && swipe.sent === 0 &&
    held.scrolled === 0 && held.sent.length === 1 && held.sent[0].join() === [before[1], before[0]].join(),
    JSON.stringify({ before, swipe, held }));
  }

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  // a phone: the tabs fold into a menu with the name and sign-out inside
  await p.setViewportSize({ width: 390, height: 800 });
  await p.waitForTimeout(200);
  const phone = await p.evaluate(() => ({
    menuVisible: getComputedStyle(document.getElementById('menu-btn')).display !== 'none',
    tabsHidden: getComputedStyle(document.getElementById('tabs')).display === 'none',
    whoHidden: getComputedStyle(document.getElementById('who-line')).display === 'none',
    overflow: document.documentElement.scrollWidth <= window.innerWidth
  }));
  await p.click('#menu-btn');
  const opened = await p.evaluate(() => ({
    open: getComputedStyle(document.getElementById('tabs')).display !== 'none',
    who: document.getElementById('who-menu').textContent,
    signOut: !!document.querySelector('#tabs .menu-who a')
  }));
  await p.click('.tabs button[data-tab="log"]');
  await p.waitForTimeout(200);
  const closed = await p.evaluate(() => getComputedStyle(document.getElementById('tabs')).display === 'none' && !document.getElementById('view-log').classList.contains('hidden'));
  check('on a phone the tabs sit behind a Menu button with the name and sign-out inside, nothing overflows',
    phone.menuVisible && phone.tabsHidden && phone.whoHidden && phone.overflow && opened.open && opened.who === 'Alex' && opened.signOut && closed,
    JSON.stringify({ phone, opened, closed }));

  // ---------------- people without a team ----------------
  // Their signups sit in a box of their own above the teams, a tick
  // each, and the ticked ones go into a new team or one with room. What
  // the page sends is what rego/place reads.
  {
    const q = await b.newPage({ serviceWorkers: 'block', viewport: { width: 1100, height: 900 } });
    await q.addInitScript(() => { localStorage.setItem('scs-console-session', 'sess'); localStorage.setItem('scs2-dashboard-tab', 'rego'); });
    const placed = [];
    const hid = [];
    const member = (id, reg, pos, name) => ({ id, registration_id: reg, position: pos, name, zid: 'z57000' + id, email: id + '@example.com', arc: 1, dietary: '', discord: '', qr_url: 'q', email_status: 'sent', terms_at: null });
    await q.route('**/*', async r => {
      const u = r.request().url();
      if (u === 'https://tab.example/console') return r.fulfill({ status: 200, contentType: 'text/html', body: HTML });
      if (u.includes('/api/console/rego/hide')) {
        hid.push(r.request().postDataJSON());
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, count: 1 }) });
      }
      if (u.includes('/api/console/rego/place')) {
        placed.push(r.request().postDataJSON());
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, team: 'Galahs', team_id: 7, created: false, moved: 1, emails: 0 }) });
      }
      if (u.endsWith('/api/console/rego')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, teams: 1, people: 6, dietary: {}, checkin_live: false, registrations: [
          { id: 3, team_id: 7, team_name: 'Galahs', societies: '', photo_permission: 1, questions: '', submitted_at: '2026-10-08 06:00:00', solo: 0,
            members: [member(11, 3, 1, 'Ann'), member(12, 3, 2, 'Bo'), member(13, 3, 3, 'Cy')] },
          { id: 5, team_id: null, team_name: '', societies: '', photo_permission: 1, questions: '', submitted_at: '2026-10-09 06:00:00', solo: 1,
            members: [member(21, 5, 1, 'Sol Oh')] },
          { id: 6, team_id: null, team_name: '', societies: '', photo_permission: 1, questions: '', submitted_at: '2026-10-09 08:00:00', solo: 1,
            members: [member(22, 6, 1, 'Pia Ir'), member(23, 6, 2, 'Rey Ir')] }
        ] }) });
      if (u.includes('/api/console/')) return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return r.fulfill({ status: 404, body: '' });
    });
    await q.goto('https://tab.example/console');
    await q.waitForSelector('.rg-solo .rg-head input[type=checkbox]');
    const rows = await q.$$eval('.rg-solo .rg-name', ns => ns.map(n => n.textContent));
    const teamCards = await q.$$eval('#rego-list > .rg .rg-name', ns => ns.map(n => n.textContent));
    await q.check('.rg-solo .rg-head input[aria-label="Pick Sol Oh"]');
    const room = await q.$$eval('.rg-place select option', os => os.map(o => o.value));
    await q.selectOption('.rg-place select', '7');
    await q.click('.rg-place button:has-text("Add to team")');
    await q.waitForTimeout(300);
    check('people without a team are listed by name in a box of their own, and the ticked ones are sent to be placed',
      rows.join('|') === 'Sol Oh|Pia Ir and Rey Ir' && teamCards.join() === 'Galahs' && room.includes('7') &&
      placed.length === 1 && JSON.stringify(placed[0].registration_ids) === '[5]' && placed[0].team_id === 7 && placed[0].email === true,
      JSON.stringify({ rows, teamCards, room, placed }));
    await q.click('.rg-solo .rg:has(.rg-name:text-is("Pia Ir and Rey Ir")) .rg-head button:has-text("Hide")');
    await q.waitForTimeout(300);
    check('each of them can be hidden from its own row, and only that signup is sent',
      hid.length === 1 && JSON.stringify(hid[0].ids) === '[6]' && hid[0].hidden === true, JSON.stringify(hid));
    await q.close();
  }

  // ---------------- moving someone to another team ----------------
  // The person's own Move offers the teams with room and No team, never
  // their own team or a full one, and sends what rego/person/move reads.
  {
    const q = await b.newPage({ serviceWorkers: 'block', viewport: { width: 1100, height: 900 } });
    await q.addInitScript(() => { localStorage.setItem('scs-console-session', 'sess'); localStorage.setItem('scs2-dashboard-tab', 'rego'); });
    const moved = [];
    const member = (id, reg, pos, name) => ({ id, registration_id: reg, position: pos, name, zid: 'z58000' + id, email: id + '@example.com', arc: 1, dietary: '', discord: '', qr_url: 'q', email_status: 'sent', terms_at: null });
    const team = (id, teamId, name, names) => ({ id, team_id: teamId, team_name: name, societies: '', photo_permission: 1, questions: '',
      submitted_at: '2026-10-08 06:00:00', solo: 0, members: names.map((n, i) => member(id * 100 + i, id, i + 1, n)) });
    await q.route('**/*', async r => {
      const u = r.request().url();
      if (u === 'https://tab.example/console') return r.fulfill({ status: 200, contentType: 'text/html', body: HTML });
      if (u.includes('/api/console/rego/person/move')) {
        moved.push(r.request().postDataJSON());
        return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, name: 'Bo', from: 'Galahs', team: 'Hoothoot', team_id: 8, emailed: true, discord: 0, left: 2 }) });
      }
      if (u.endsWith('/api/console/overview')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, quests: [], teams: [7, 8, 9].map(id => ({ id, name: 'Team ' + id, hidden: 0, total: 0 })) }) });
      if (u.endsWith('/api/console/rego')) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        ok: true, teams: 3, people: 14, dietary: {}, checkin_live: false, max_team: 10, registrations: [
          team(3, 7, 'Galahs', ['Ann', 'Bo', 'Cy']),
          team(4, 8, 'Hoothoot', ['Di']),
          team(5, 9, 'Full House', ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'])
        ] }) });
      if (u.includes('/api/console/')) return r.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
      return r.fulfill({ status: 404, body: '' });
    });
    await q.goto('https://tab.example/console');
    await q.click('#rego-list > .rg:has(.rg-name:text-is("Galahs")) .rg-head button:has-text("Edit")');
    const bo = '.rg-person:has(strong:text-is("#2 Bo"))';
    await q.click(bo + ' button:has-text("Move")');
    const offered = await q.$$eval(bo + ' select[aria-label="Move Bo to"] option', os => os.map(o => o.value));
    await q.selectOption(bo + ' select[aria-label="Move Bo to"]', '8');
    await q.click(bo + ' button:has-text("Move Bo")');
    await q.waitForTimeout(300);
    const said = await q.textContent('#toast');
    check('a person in a team can be moved to another team with room, or out of any, and the page sends what the worker reads',
      offered.join() === ',8,0' && moved.length === 1 && moved[0].id === 301 && moved[0].team_id === 8 && moved[0].email === true &&
      /Moved Bo from Galahs to Hoothoot/.test(said || ''),
      JSON.stringify({ offered, moved, said }));
    await q.close();
  }

  // Ranks reads its boards in the shape the worker writes them, leaves a
  // hidden team out, and a board made there asks for its quest and measure
  // and is saved to the worker with its title and its place on the recap;
  // Quests done and Photo to submission tick on and off the recap too
  {
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 900 } });
    const q = await ctx.newPage();
    const ok = (r, body) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Object.assign({ ok: true }, body)) });
    const asked = [];
    await q.route(u => u.pathname.indexOf('/api/console/') === 0, r => ok(r, {}));
    await q.route('https://tab.example/console', r => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
    await q.route('**/api/console/overview', r => ok(r, { teams: [], quests: [] }));
    await q.route('**/api/console/quests', r => ok(r, { groups: [{ key: 'S24', name: 'Ferry hop', codes: [] }], loose: [], regions: [], tags: [], audiences: [] }));
    await q.route('**/api/console/standings', r => ok(r, { teams: [{ rank: 1, dnf: false, name: 'Galahs', points: 4467 }] }));
    await q.route('**/api/console/quests-done', r => ok(r, { teams: [
      { id: 1, name: 'Galahs', hidden: false, quests: 3, keys: ['S1', 'S2', 'S24'] }, { id: 9, name: 'Test run', hidden: true, quests: 2, keys: ['S1', 'S2'] }] }));
    await q.route('**/api/console/ranks/times', r => ok(r, { teams: [{ id: 1, name: 'Galahs', hidden: false, submissions: 4, average: 252, quickest: 40 }] }));
    await q.route(u => u.pathname === '/api/console/ranks/custom', r => {
      const sp = new URL(r.request().url()).searchParams;
      asked.push(sp.get('quest') + '/' + sp.get('measure'));
      ok(r, { teams: [{ id: 1, name: 'Galahs', hidden: false, value: 2 }] });
    });
    let savedBoards = null;
    await q.route(u => u.pathname === '/api/console/ranks/boards', r => {
      if (r.request().method() === 'POST') savedBoards = JSON.parse(r.request().postData()).boards;
      ok(r, { boards: savedBoards || [], builtin: { quests_done: true, submit_times: false } });
    });
    // the Recap card's settings, and a quest set to show photo by photo
    const after = (views) => ({ hours: { from: '', to: '', mode: 'merge' }, review: { from: '', to: '' }, times: { from: '', to: '' },
      arrivals: { from: '', to: '' }, most_skip: [], date_rules: [], seen: { first: '', last: '' }, last_until: '', quest_views: views });
    let viewsNow = { SQ1: 'stations' };
    const viewSent = [];
    await q.route(u => u.pathname === '/api/console/recap/hours', r => ok(r, after(viewsNow)));
    await q.route(u => u.pathname === '/api/console/recap/views', r => {
      const body = JSON.parse(r.request().postData());
      viewSent.push(body);
      viewsNow = Object.assign({}, viewsNow);
      if (body.view === 'sent') delete viewsNow[body.key]; else viewsNow[body.key] = body.view;
      ok(r, after(viewsNow));
    });
    let builtinSent = null;
    await q.route(u => u.pathname === '/api/console/ranks/recap', r => {
      builtinSent = JSON.parse(r.request().postData());
      ok(r, { builtin: builtinSent });
    });
    await q.goto('https://tab.example/console');
    await q.evaluate(() => { localStorage.setItem('scs-console-session', 'sess-1'); localStorage.removeItem('scs2-dashboard-boards'); });
    await q.reload();
    await q.click('.tabs button[data-tab="ranks"]');
    await q.waitForSelector('#times-view table');
    await q.click('#custom-add');
    await q.selectOption('.custom-card .custom-quest', 'S24');
    await q.selectOption('.custom-card .custom-measure', 'points');
    await q.fill('.custom-card .custom-title', 'Most ferry hops');
    await q.press('.custom-card .custom-title', 'Enter');
    await q.check('.custom-card .custom-on-recap');
    const doneTicked = await q.isChecked('#done-on-recap');
    await q.check('#times-on-recap');
    await q.waitForTimeout(300);
    const seen = await q.evaluate(() => ['rank-points', 'done-view', 'times-view'].map(id =>
      [...document.querySelectorAll('#' + id + ' tbody tr')].map(tr => [...tr.children].map(td => td.textContent.trim()).join('|'))));
    check('Ranks draws the worker\'s boards, leaves a hidden team out, and a board made there asks for its quest and measure',
      seen[0][0] === '1|Galahs|4,467' && seen[1].length === 1 && /^1\|Galahs/.test(seen[1][0]) &&
      seen[2][0] === '1|Galahs|4 min 12 s|4' && asked.join() === '/accepted,S24/accepted,S24/points' &&
      JSON.stringify(savedBoards) === JSON.stringify([{ title: 'Most ferry hops', quest: 'S24', measure: 'points', recap: true }]) &&
      doneTicked && JSON.stringify(builtinSent) === JSON.stringify({ quests_done: true, submit_times: true }),
      JSON.stringify({ seen, asked, savedBoards, doneTicked, builtinSent }));
    const chips = () => q.$$eval('#quest-view-list .most-skip-chip', bs => bs.map(b => b.textContent.trim()));
    const before = await chips();
    await q.selectOption('#quest-view-pick', 'S24');
    await q.selectOption('#quest-view-kind', 'places');
    await q.click('#quest-view-set');
    await q.waitForTimeout(300);
    const setChips = await chips();
    await q.click('#quest-view-list .most-skip-chip >> nth=0');
    await q.waitForTimeout(300);
    check('the Recap card shows which quests show photo by photo, sets one with the way picked, and a chip sets it back',
      before.join() === 'SQ1 at the stations \u00d7' && setChips.length === 2 && /S24 at its places/.test(setChips.join()) &&
      JSON.stringify(viewSent) === JSON.stringify([{ key: 'S24', view: 'places' }, { key: 'S24', view: 'sent' }]),
      JSON.stringify({ before, setChips, viewSent }));
    await ctx.close();
  }

  // The Routes tab cleans a GPX file with the site's cleaner, guesses the
  // team from the file's name, cuts what is asked before cleaning, and
  // sends a route the worker's own check takes.
  {
    const fs = require('fs'), path = require('path');
    const SITE_DIR = path.join(__dirname, '..', '..', 'website');
    const { checkRoute } = await import('../src/tracks.ts');
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 900 }, timezoneId: 'Australia/Sydney' });
    const q = await ctx.newPage();
    const errs = [];
    q.on('pageerror', e => errs.push(e.message));
    const ok = (r, body) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Object.assign({ ok: true }, body)) });
    await q.route(u => u.pathname.indexOf('/api/console/') === 0, r => ok(r, {}));
    await q.route('https://tab.example/console', r => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
    await q.route('**/api/console/overview', r => ok(r, { teams: [{ id: 1, name: 'Foursome', hidden: false }, { id: 2, name: 'Five Guys', hidden: false }], quests: [] }));
    // the site's cleaner and rail lines; no map library, which the tab
    // has to clean without
    await q.route('https://scs.andyrew.space/tab/replay/track-clean.js', r => r.fulfill({ status: 200, contentType: 'application/javascript',
      body: fs.readFileSync(path.join(SITE_DIR, 'tab', 'replay', 'track-clean.js'), 'utf8') }));
    await q.route('https://scs.andyrew.space/assets/transit.geojson', r => r.fulfill({ status: 200, contentType: 'application/json',
      body: fs.readFileSync(path.join(SITE_DIR, 'assets', 'transit.geojson'), 'utf8') }));
    await q.route('https://scs.andyrew.space/assets/maplibre/**', r => r.fulfill({ status: 404, body: '' }));
    await q.route(u => /tiles|openstreetmap/.test(u.hostname), r => r.fulfill({ status: 404, body: '' }));
    let saved = null;
    const listed = () => ({ ready: true, sent: [], tracks: saved ? [{ team_id: 1, points: 12, started_at: '2026-10-19 23:05:00',
      ended_at: '2026-10-19 23:19:50', source: 'Foursome walk.gpx', has_gpx: true, sent_key: '', edits: null, notes: '', saved_at: '2026-11-04 01:00:00', saved_by: 'Alex' }] : [] });
    await q.route(u => u.pathname === '/api/console/tracks', r => ok(r, listed()));
    await q.route(u => u.pathname === '/api/console/tracks/save', async r => {
      const req = r.request();
      const form = await new Response(req.postDataBuffer(), { headers: { 'content-type': req.headers()['content-type'] } }).formData();
      const gpx = form.get('gpx');
      saved = { team: form.get('team_id'), route: JSON.parse(form.get('route')), edits: JSON.parse(form.get('edits')),
        source: form.get('source'), gpx: gpx && gpx.name, gpxText: gpx && await gpx.text() };
      ok(r, { points: saved.route.t.length });
    });
    const start = Date.parse('2026-10-19T23:00:00Z') / 1000;
    const fixes = [];
    for (let i = 0; i < 120; i++) {
      fixes.push('<trkpt lat="' + (-33.883 + i * 0.00012).toFixed(6) + '" lon="' + (151.2065 + Math.sin(i / 6) * 0.0002).toFixed(6) + '"><time>' +
        new Date((start + i * 10) * 1000).toISOString() + '</time></trkpt>');
    }
    const text = '<?xml version="1.0"?><gpx version="1.1"><trk><name>Morning Walk</name><trkseg>' + fixes.join('') + '</trkseg></trk></gpx>';
    await q.goto('https://tab.example/console');
    await q.evaluate(() => localStorage.setItem('scs-console-session', 'sess-1'));
    await q.reload();
    await q.click('.tabs button[data-tab="routes"]');
    await q.waitForSelector('#routes-rows tr');
    await q.setInputFiles('#routes-files', { name: 'Foursome walk.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(text) });
    await q.waitForFunction(() => /points recorded/.test(document.getElementById('routes-summary').textContent), null, { timeout: 20000 });
    const guessed = await q.$eval('#routes-team', s => s.value);
    const before = await q.textContent('#routes-summary');
    await q.fill('#routes-from', '10:05');
    await q.dispatchEvent('#routes-from', 'change');
    await q.waitForFunction(t => document.getElementById('routes-summary').textContent !== t, before, { timeout: 10000 });
    await q.click('#routes-save');
    await q.waitForFunction(() => document.getElementById('routes-editor').classList.contains('hidden'), null, { timeout: 10000 });
    await q.waitForTimeout(200);
    const rows = await q.$$eval('#routes-rows tr', trs => trs.map(tr => tr.children[0].textContent));
    const verdict = saved ? checkRoute(saved.route) : { error: 'nothing sent' };
    check('the Routes tab cleans a file, guesses its team from the name, cuts before cleaning and sends a route the worker takes',
      guessed === '1' && saved && saved.team === '1' && !('error' in verdict) && saved.route.t0 >= start + 300 &&
      saved.edits.from === '10:05' && saved.source === 'Foursome walk.gpx' && saved.gpx === 'Foursome walk.gpx' && saved.gpxText === text &&
      rows.join() === 'Foursome' && errs.length === 0,
      JSON.stringify({ guessed, verdict: verdict.error || 'ok', t0: saved && saved.route.t0 - start, edits: saved && saved.edits, rows, errs }));
    await ctx.close();
  }

  // The spinner page opens with the dashboard's sign-in, read from where
  // the dashboard keeps it, and asks the worker for the board's teams;
  // without a sign-in it sends the visitor to the dashboard and back.
  {
    const { spinnerPage } = await import('../src/console-page.js');
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 900 }, reducedMotion: 'reduce' });
    const q = await ctx.newPage();
    const asked = [];
    await q.route('https://tab.example/dash/spinner', r => r.fulfill({ status: 200, contentType: 'text/html', body: spinnerPage() }));
    await q.route('https://tab.example/api/console/spinner', r => {
      asked.push(r.request().headers().authorization || '');
      r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, teams: [
        { id: 1, name: 'Galahs', points: 4467 }, { id: 2, name: 'Trubbish', points: 4100 }, { id: 3, name: 'Hoothoot', points: 0 }] }) });
    });
    await q.goto('https://tab.example/dash/spinner');
    const gate = await q.evaluate(() => !document.getElementById('sp-signin').classList.contains('hidden') &&
      document.querySelector('.sp-go').getAttribute('href') === '/dash?then=spinner');
    await q.evaluate(() => localStorage.setItem('scs-console-session', 'sess-9'));
    await q.reload();
    await q.waitForSelector('#sp-app:not(.hidden)');
    await q.uncheck('#sp-list li:nth-child(2) input');
    await q.click('#sp-spin');
    await q.waitForFunction(() => document.getElementById('sp-winner').textContent !== '');
    const won = await q.textContent('#sp-winner');
    check('the spinner opens with the dashboard\'s sign-in, reads the teams and draws only a ticked team with points',
      gate && asked.length === 1 && asked[0] === 'Bearer sess-9' && won === 'Galahs',
      JSON.stringify({ gate, asked, won }));
    await ctx.close();
  }

  await b.close();
  process.exit(fail === 0 ? 0 : 1);
})();
