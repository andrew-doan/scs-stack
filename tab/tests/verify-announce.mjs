// Run with: node tests/verify-announce.mjs   (needs Node 22+)
//
// Email announcements from the dashboard, against the real worker with
// the mail service played by the test, which keeps every message it is
// handed. The point of the whole feature is in the first checks: each
// person gets their own copy with nobody else's address on it, every
// address once, and only the people the announcement was for. The rest
// is the batching that makes three hundred messages possible: the page
// stepping through them, the scheduled run finishing them, the two at
// once not doubling anyone up, a failure tried again, a send stopped.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';

const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
const db = d1Shim(raw);
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };

// ---- people ----
// Three visible teams of nine and a hidden test team. Two people share
// an address (in different case), one row holds two addresses, one has
// none: none of those may turn into a second recipient of a message.
const teams = ['Night Owls', 'Platform Nine', 'Rat Race', 'Test Team'];
teams.forEach((name, i) => raw.prepare('INSERT INTO teams (name, hidden) VALUES (?, ?)').run(name, i === 3 ? 1 : 0));
raw.prepare("INSERT INTO registrations (team_name, societies, photo_permission, questions, submitted_at) VALUES ('x', '', 1, '', datetime('now'))").run();
const people = [];
let n = 0;
for (let t = 1; t <= 4; t++) {
  for (let k = 0; k < 9; k++) {
    n++;
    let email = 'person' + n + '@example.com';
    if (n === 5) email = 'Person4@Example.com';          // the same inbox as person 4
    if (n === 6) email = 'a@example.com, b@example.com'; // two addresses in one row
    if (n === 7) email = '';                              // none
    people.push({ team: t, email });
    raw.prepare('INSERT INTO participants (registration_id, team_id, position, name, zid, email) VALUES (1, ?, ?, ?, ?, ?)')
      .run(t, k + 1, 'Person ' + n, 'z5' + String(100000 + n), email);
  }
}
// Two signups with nobody in a team yet: one is somebody coming, the
// other is marked as a test and goes the way of the hidden team.
raw.prepare("INSERT INTO registrations (id, team_name, hidden) VALUES (2, '', 0), (3, '', 1)").run();
raw.prepare("INSERT INTO participants (registration_id, team_id, position, name, zid, email) VALUES (2, NULL, 1, 'Sol Oh', 'z5700001', 'sol@example.com'), (3, NULL, 1, 'Tess Test', 'z5700002', 'tess@example.com')").run();
const expectedAll = new Set(people.filter(p => p.team !== 4).map(p => p.email.trim().toLowerCase())
  .filter(e => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(e)).concat(['sol@example.com']));
const expectedTeam2 = new Set(people.filter(p => p.team === 2).map(p => p.email.toLowerCase()));

// ---- the mail service ----
const outbound = [];
let bounce = () => false;
const ENV = {
  DB: db, CONSOLE_PASSWORD: 'tab-pass',
  EMAIL_FROM: 'SCS.2 <tab@scs.andyrew.space>', EMAIL_REPLY_TO: 'westsocunsw@gmail.com',
  EMAIL: { send: async (msg) => {
    if (bounce(msg)) throw new Error('mailbox unavailable');
    outbound.push(msg);
    return { messageId: 'em_' + outbound.length };
  } }
};
const mod = await import(BOT + '/src/index.ts');
const { announceTick, ANNOUNCE_INLINE } = await import(BOT + '/src/announce.ts');
const { runSchedule } = await import(BOT + '/src/schedule.ts');
const ctx = { waitUntil() {} };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, ctx);
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
const sess = (await consoleSignIn(jpost, 'Comms', 'tab-pass')).session;

const DRAFT = {
  subject: 'Briefing moves to 10:15',
  format: 'text',
  body: '## Change of plan\n\nThe briefing starts at **10:15**, not 10:00.\n\n- Bring your phone\n- Bring water\n\nThe [quest list](https://scs.andyrew.space/questlist/) is up.'
};

// ---------------- the door ----------------
let r = await get('/api/console/announce');
check('nothing here answers without a dashboard session', r.status === 401, String(r.status));
let d = await (await get('/api/console/announce', sess)).json();
check('the tab is told how many each audience reaches: every address once, hidden teams and test signups left out',
  d.ok && d.counts.all === expectedAll.size && d.counts.teams['2'] === expectedTeam2.size,
  JSON.stringify(d.counts) + ' expected all ' + expectedAll.size);

// ---------------- what it looks like ----------------
// the line at the bottom: the default when none is given, the
// organiser's own when typed (an address in it made a link), and
// nothing at all when emptied
{
  const plain = await (await jpost('/api/console/announce/preview', DRAFT, sess)).json();
  const own = await (await jpost('/api/console/announce/preview', Object.assign({}, DRAFT, { footer: 'Sent by OrgCom. Write to org@example.com.' }), sess)).json();
  const none = await (await jpost('/api/console/announce/preview', Object.assign({}, DRAFT, { footer: '' }), sess)).json();
  check('the line at the bottom is the default, the organiser\'s own, or nothing',
    plain.html.includes('You are getting this because') && plain.text.includes('You are getting this because') &&
    own.html.includes('Sent by OrgCom.') && own.html.includes('href="mailto:org@example.com"') &&
    !own.html.includes('You are getting this because') && own.text.includes('Write to org@example.com.') &&
    !none.html.includes('You are getting this because') && !none.text.includes('You are getting this because'), '');
}
d = await (await jpost('/api/console/announce/preview', DRAFT, sess)).json();
check('the text is drawn in the confirmation email\'s frame, the markdown turned into mail-safe HTML',
  d.ok && d.html.includes('assets/email/header-banner.png') && d.html.includes('<strong>10:15</strong>') &&
  /<h2 style="[^"]+">Change of plan<\/h2>/.test(d.html) && d.html.includes('<li style="margin:0 0 4px;">Bring water</li>') &&
  d.html.includes('href="https://scs.andyrew.space/questlist/"'),
  d.html.length + ' chars');
check('and the plain-text copy is plain',
  !/[*#<]/.test(d.text) && d.text.includes('quest list (https://scs.andyrew.space/questlist/)'), d.text.slice(0, 120));
const htmlDraft = {
  subject: 'Map', format: 'html',
  body: '<p onclick="steal()">Here is <b>the map</b>.</p><script>alert(1)</script>' +
    '<a href="javascript:alert(2)">bad</a><table><tr><td>kept</td></tr></table><iframe src="https://x.example"></iframe>'
};
d = await (await jpost('/api/console/announce/preview', htmlDraft, sess)).json();
check('HTML is the organisers\' own, less anything that could run',
  d.html.includes('<b>the map</b>') && d.html.includes('<td>kept</td>') &&
  !d.html.includes('<script') && !d.html.includes('onclick') && !d.html.includes('javascript:') && !d.html.includes('<iframe'),
  '');

// ---------------- a test send ----------------
r = await jpost('/api/console/announce/test', Object.assign({ to: 'not an address' }, DRAFT), sess);
check('a test address that is not one is refused', r.status === 400, String(r.status));
outbound.length = 0;
d = await (await jpost('/api/console/announce/test', Object.assign({ to: 'Org@Example.com' }, DRAFT), sess)).json();
check('a test is one message to the one address typed, marked as a test',
  d.ok && outbound.length === 1 && outbound[0].to === 'org@example.com' && /^\[Test\] /.test(outbound[0].subject), '');

// ---------------- everyone ----------------
function leaks(list) {
  const out = [];
  list.forEach(m => {
    if (typeof m.to !== 'string' || (m.to.match(/@/g) || []).length !== 1 || /[,;]/.test(m.to)) out.push('to: ' + JSON.stringify(m.to));
    if ('cc' in m || 'bcc' in m) out.push('cc or bcc on ' + m.to);
    // nobody's address is in the message itself
    people.forEach(p => {
      const e = p.email.toLowerCase();
      if (e && (String(m.html).toLowerCase().includes(e) || String(m.text).toLowerCase().includes(e))) out.push(e + ' in the body');
    });
  });
  return out;
}
outbound.length = 0;
d = await (await jpost('/api/console/announce/send', Object.assign({ audience: 'all' }, DRAFT), sess)).json();
const first = d.send;
check('a send to everyone writes down every address once and sends the first batch at once',
  d.ok && first.total === expectedAll.size && first.status === 'sending' &&
  outbound.length === ANNOUNCE_INLINE && first.sent === ANNOUNCE_INLINE,
  JSON.stringify({ total: first.total, sent: first.sent, went: outbound.length }));
let steps = 0;
let state = first;
while (state.status === 'sending' && steps < 10) {
  state = (await (await jpost('/api/console/announce/step', { id: first.id }, sess)).json()).send;
  steps++;
}
const to = outbound.map(m => m.to);
check('the tab steps through the rest until it is done',
  state.status === 'done' && state.sent === expectedAll.size && state.failed === 0, JSON.stringify(state));
check('each person gets their own copy, with only their own address on it and nobody else\'s anywhere in it',
  leaks(outbound).length === 0, leaks(outbound).slice(0, 3).join('; '));
check('everyone it was for, each once, and nobody else — not the hidden team or a test signup, not a row holding two addresses',
  to.length === expectedAll.size && new Set(to).size === to.length && to.every(e => expectedAll.has(e)) &&
  !to.includes('a@example.com') && !to.includes('tess@example.com') && to.includes('sol@example.com') && !to.some(e => e.includes(',')),
  to.length + ' sent, ' + new Set(to).size + ' different');
check('it is in the log', raw.prepare("SELECT COUNT(*) AS n FROM submission_log WHERE action = 'announce-send'").get().n === 1, '');

// ---------------- one team ----------------
outbound.length = 0;
d = await (await jpost('/api/console/announce/send', Object.assign({ audience: 'team', team_id: 2 }, DRAFT), sess)).json();
check('a send to one team reaches that team and nobody else',
  d.ok && d.send.status === 'done' && outbound.length === expectedTeam2.size &&
  outbound.every(m => expectedTeam2.has(m.to)), outbound.map(m => m.to).join(','));
r = await jpost('/api/console/announce/send', Object.assign({ audience: 'team', team_id: 999 }, DRAFT), sess);
check('a team that is not there is refused', r.status === 400, String(r.status));

// addresses typed or pasted: spreadsheet rows with names beside the
// address, a repeat in another case, a mailto, and a piece that is not
// an address — every address once, one message each, nothing else
outbound.length = 0;
const PASTED = 'Ana Lee\tana@example.com\tWestSoc\nBo Chan\tBO@Example.com\n' +
  'ana@example.com, mailto:cy@example.org; not-an-address@\n<dee@example.net>';
d = await (await jpost('/api/console/announce/send', Object.assign({ audience: 'list', emails: PASTED }, DRAFT), sess)).json();
const listed = ['ana@example.com', 'bo@example.com', 'cy@example.org', 'dee@example.net'];
check('a send to pasted addresses takes every address in the paste once and nobody else',
  d.ok && d.send.audience === 'list' && d.send.total === 4 && d.send.status === 'done' &&
  outbound.length === 4 && listed.every(e => outbound.some(m => m.to === e)) && leaks(outbound).length === 0,
  JSON.stringify({ total: d.send && d.send.total, to: outbound.map(m => m.to) }));
r = await jpost('/api/console/announce/send', Object.assign({ audience: 'list', emails: 'no addresses here' }, DRAFT), sess);
check('a paste with no address in it is refused', r.status === 400, String(r.status));
outbound.length = 0;
d = await (await jpost('/api/console/announce/send', Object.assign({ audience: 'list', emails: 'a1@example.com a2@example.com', footer: 'Kept with the send.', reply_to: 'Helpdesk@Example.com' }, DRAFT), sess)).json();
check('a send keeps the line at the bottom and the reply address it was sent with, for every message in it',
  d.ok && outbound.length === 2 && outbound.every(m => m.html.includes('Kept with the send.') && !m.html.includes('You are getting this because') &&
    m.replyTo === 'helpdesk@example.com'),
  JSON.stringify(outbound.map(m => m.replyTo)));
r = await jpost('/api/console/announce/send', Object.assign({ audience: 'list', emails: 'a1@example.com', reply_to: 'not an address' }, DRAFT), sess);
check('a reply address that is not one is refused before anything goes out', r.status === 400, String(r.status));

// ---------------- the page and the schedule at once ----------------
outbound.length = 0;
d = await (await jpost('/api/console/announce/send', Object.assign({ audience: 'all' }, DRAFT), sess)).json();
const both = d.send.id;
await Promise.all([
  jpost('/api/console/announce/step', { id: both }, sess),
  announceTick(ENV),
  jpost('/api/console/announce/step', { id: both }, sess)
]);
for (let i = 0; i < 5; i++) await announceTick(ENV);
const twice = outbound.map(m => m.to);
check('the page and the scheduled run working on one announcement send nobody the same message twice',
  twice.length === expectedAll.size && new Set(twice).size === twice.length,
  twice.length + ' sent, ' + new Set(twice).size + ' different');

// ---------------- left to the schedule ----------------
outbound.length = 0;
d = await (await jpost('/api/console/announce/send', Object.assign({ audience: 'all' }, DRAFT), sess)).json();
const left = d.send.id;
const tick = await runSchedule(ENV);
const after = raw.prepare('SELECT status, sent FROM email_sends WHERE id = ?').get(left);
check('with the tab closed, the scheduled run finishes it',
  tick.announce && tick.announce.ran && after.status === 'done' && after.sent === expectedAll.size,
  JSON.stringify({ tick: tick.announce, after }));

// ---------------- failures, tried again ----------------
outbound.length = 0;
bounce = (m) => m.to === 'person3@example.com' || m.to === 'person12@example.com';
d = await (await jpost('/api/console/announce/send', Object.assign({ audience: 'all' }, DRAFT), sess)).json();
let f = d.send;
while (f.status === 'sending') f = (await (await jpost('/api/console/announce/step', { id: f.id }, sess)).json()).send;
check('an address that fails is counted, and the rest still go',
  f.status === 'done' && f.failed === 2 && f.sent === expectedAll.size - 2, JSON.stringify(f));
bounce = () => false;
const before = outbound.length;
d = await (await jpost('/api/console/announce/retry', { id: f.id }, sess)).json();
check('trying the failures again sends to those two and nobody else',
  d.ok && d.send.status === 'done' && d.send.failed === 0 && d.send.sent === expectedAll.size &&
  outbound.slice(before).map(m => m.to).sort().join() === 'person12@example.com,person3@example.com',
  outbound.slice(before).map(m => m.to).join());

// ---------------- stopped ----------------
outbound.length = 0;
let bounced = '';
bounce = (m) => { if (!bounced) bounced = m.to; return m.to === bounced; };
d = await (await jpost('/api/console/announce/send', Object.assign({ audience: 'all' }, DRAFT), sess)).json();
bounce = () => false;
await jpost('/api/console/announce/stop', { id: d.send.id }, sess);
await jpost('/api/console/announce/step', { id: d.send.id }, sess);
await announceTick(ENV);
const stopped = raw.prepare('SELECT status, sent, failed FROM email_sends WHERE id = ?').get(d.send.id);
check('a stopped announcement sends nothing more, from the page or the schedule',
  stopped.status === 'stopped' && outbound.length === ANNOUNCE_INLINE - 1 && stopped.sent === ANNOUNCE_INLINE - 1 && stopped.failed === 1,
  JSON.stringify(stopped) + ' ' + outbound.length);
const sentBefore = outbound.length;
d = await (await jpost('/api/console/announce/retry', { id: d.send.id }, sess)).json();
for (let i = 0; i < 3; i++) await announceTick(ENV);
check('trying its failure again sends that one address, and the stopped ones stay unsent',
  outbound.slice(sentBefore).map(m => m.to).join() === bounced && d.send.status === 'stopped' &&
  raw.prepare("SELECT COUNT(*) AS n FROM email_queue WHERE send_id = ? AND status = 'stopped'").get(d.send.id).n === expectedAll.size - ANNOUNCE_INLINE,
  outbound.slice(sentBefore).map(m => m.to).join() + ' ' + JSON.stringify(d.send));

// ---------------- the list ----------------
d = await (await get('/api/console/announce', sess)).json();
check('the tab lists what was sent, newest first, with how far each got',
  d.sends.length === 8 && d.sends[0].status === 'stopped' && d.sends[1].sent === expectedAll.size &&
  d.sends.some(s => s.team_name === 'Platform Nine'), JSON.stringify(d.sends.map(s => s.status)));

// ---------------- email off on the Settings tab ----------------
// While the switch is on nothing reaches the mail service. A send, a
// step, a retry and both kinds of test are refused before anything is
// written; the scheduled run leaves an announcement part way out where
// it is, neither sent nor stopped; and once the switch is off the run
// carries on from where it stopped, with nobody sent anything twice.
{
  const setHold = async (held) => (await jpost('/api/console/email/hold', { held }, sess)).json();
  const count = (sql, ...args) => raw.prepare(sql).get(...args).n;
  outbound.length = 0;
  d = await (await jpost('/api/console/announce/send', Object.assign({ audience: 'all' }, DRAFT), sess)).json();
  const paused = d.send.id;
  const held = await setHold(true);
  const went = outbound.length;
  const sends = count('SELECT COUNT(*) AS n FROM email_sends');
  const queued = count('SELECT COUNT(*) AS n FROM email_queue');
  const refusals = [];
  for (const [path, body] of [
    ['/api/console/announce/send', Object.assign({ audience: 'all' }, DRAFT)],
    ['/api/console/announce/send', Object.assign({ audience: 'list', emails: 'x1@example.com' }, DRAFT)],
    ['/api/console/announce/step', { id: paused }],
    ['/api/console/announce/retry', { id: paused }],
    ['/api/console/announce/test', Object.assign({ to: 'org@example.com' }, DRAFT)],
    ['/api/console/rego/email/test', { to: 'org@example.com', kind: 'plain' }]
  ]) {
    const x = await jpost(path, body, sess);
    const b = await x.json();
    refusals.push(x.status + (b.email_off ? ' off ' : ' ') + b.error);
  }
  check('with email off, a send, a step, a retry and both tests are refused with the reason, and nothing new is written down',
    held.ok && held.held === true && went === ANNOUNCE_INLINE &&
    refusals.every(t => t === '409 off Email sending is off. Turn it on in Settings.') &&
    count('SELECT COUNT(*) AS n FROM email_sends') === sends && count('SELECT COUNT(*) AS n FROM email_queue') === queued,
    JSON.stringify(refusals));
  const tick = await runSchedule(ENV);
  await announceTick(ENV);
  const row = raw.prepare('SELECT status, sent FROM email_sends WHERE id = ?').get(paused);
  check('and the scheduled run sends nothing: the announcement part way out waits, its queue neither sent nor stopped',
    outbound.length === went && tick.announce && tick.announce.ran === false && tick.announce.held === true &&
    row.status === 'sending' && row.sent === ANNOUNCE_INLINE &&
    count("SELECT COUNT(*) AS n FROM email_queue WHERE send_id = ? AND status = ''", paused) === expectedAll.size - ANNOUNCE_INLINE,
    JSON.stringify({ tick: tick.announce, row, went: outbound.length }));
  d = await (await get('/api/console/announce', sess)).json();
  check('the Email tab is told email is off', d.ok && d.email_off === true, String(d.email_off));

  const released = await setHold(false);
  await runSchedule(ENV);
  const finished = raw.prepare('SELECT status, sent FROM email_sends WHERE id = ?').get(paused);
  const reached = outbound.map(m => m.to);
  check('once it is back on, the scheduled run finishes the announcement and nobody gets it twice',
    released.ok && released.held === false && finished.status === 'done' && finished.sent === expectedAll.size &&
    reached.length === expectedAll.size && new Set(reached).size === reached.length,
    JSON.stringify({ finished, reached: reached.length }));
  check('turning it off and on is in the log',
    count("SELECT COUNT(*) AS n FROM submission_log WHERE action = 'email-hold'") === 1 &&
    count("SELECT COUNT(*) AS n FROM submission_log WHERE action = 'email-release'") === 1, '');

  // switched on in the middle of a batch: what has not gone goes back in
  // the queue, and nothing is counted as failed
  outbound.length = 0;
  bounce = () => {
    raw.prepare("INSERT INTO site_flags (name, value) VALUES ('email_held', 1) ON CONFLICT(name) DO UPDATE SET value = 1").run();
    return false;
  };
  d = await (await jpost('/api/console/announce/send', Object.assign({ audience: 'all' }, DRAFT), sess)).json();
  bounce = () => false;
  const mid = d.send;
  check('switched on part way through a batch, the rest wait in the queue and none is counted as failed',
    d.ok && mid.status === 'sending' && mid.failed === 0 && mid.sent === outbound.length && outbound.length < ANNOUNCE_INLINE &&
    count("SELECT COUNT(*) AS n FROM email_queue WHERE send_id = ? AND status = ''", mid.id) === expectedAll.size - outbound.length,
    JSON.stringify({ mid, went: outbound.length }));
  await setHold(false);
  await runSchedule(ENV);
  const rest = outbound.map(m => m.to);
  check('and they go once it is off again',
    raw.prepare('SELECT status FROM email_sends WHERE id = ?').get(mid.id).status === 'done' &&
    rest.length === expectedAll.size && new Set(rest).size === rest.length, rest.length + ' sent');
}

const nobody = Object.assign({}, ENV);
delete nobody.EMAIL;
r = await mod.default.fetch(new Request('https://bot.example/api/console/announce/send', {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sess },
  body: JSON.stringify(Object.assign({ audience: 'all' }, DRAFT))
}), nobody, ctx);
check('with no mail service set up, nothing is written down and the tab is told why',
  r.status === 503 && /not set up/.test((await r.json()).error), String(r.status));

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
