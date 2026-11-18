// Run with: node tests/verify-rego.mjs   (needs Node 22+)
// Team registration end to end against the real worker: a signup
// creates the team and its people, mints check-in QRs through the
// check-in worker's API, emails every member (From the unmonitored
// address, Reply-To the org inbox, QR embedded), mirrors rows to the
// Google Sheet webhook — and holds the door against junk: honeypot,
// rate limits, duplicate zIDs and taken team names. Console side:
// the Rego overview, the CSV export, sheet resync and email resend.
// The terms: nobody accepts them on the form; each person accepts from
// the link in their own email, and the worker records it against them.
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

// ---- D1 shim ----
const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };

// ---- capture everything the worker sends out ----
const outbound = { checkin: [], emails: [], sheet: [] };
let qrCounter = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://checkin.example/qr/')) {
    // the QR images themselves, for the ticket proxy
    if (url.endsWith('/qr/code-2.png')) return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } });
    return new Response('nope', { status: 404 });
  }
  if (url.startsWith('https://checkin.example/')) {
    const body = JSON.parse(init.body);
    outbound.checkin.push({ auth: init.headers.authorization, body });
    qrCounter++;
    return Response.json({ ok: true, id: qrCounter, qr_url: 'https://checkin.example/qr/code-' + qrCounter + '.png',
      token: Buffer.from('ticket-token-code-' + qrCounter).toString('base64url') });
  }
  if (url.startsWith('https://api.resend.com/')) {
    outbound.emails.push({ auth: init.headers.authorization, body: JSON.parse(init.body) });
    return Response.json({ id: 'em_' + outbound.emails.length });
  }
  if (url.startsWith('https://script.google.com/')) {
    outbound.sheet.push({ url, body: JSON.parse(init.body) });
    // the real web app runs the script on the POST and puts its answer
    // behind a redirect, to be fetched with a GET
    if (url.includes('token=moved')) {
      return new Response(null, { status: 302, headers: { location: 'https://script.googleusercontent.com/macros/echo?user_content_key=k' } });
    }
    // a script that crashed: Google's error page, still HTTP 200
    if (url.includes('token=broken')) {
      return new Response('<html><body><div style="margin:auto">TypeError: Cannot read properties of null (reading &#39;clearContents&#39;) (line 9, file &quot;Code&quot;)</div></body></html>');
    }
    // like the real Apps Script: HTTP 200 either way, the body is the verdict
    return new Response(url.includes('token=shh') ? 'ok' : 'no');
  }
  if (url.startsWith('https://script.googleusercontent.com/')) {
    return new Response(init && init.method && init.method !== 'GET' ? 'Sorry, unable to open the file at this time.' : 'ok');
  }
  return realFetch(input, init);
};

const mod = await import(BOT + '/src/index.ts');
const ENV = {
  DB: db, CONSOLE_PASSWORD: 'tab-pass',
  // trailing slash on purpose: the worker must normalise it away
  CHECKIN_API: 'https://checkin.example/', CHECKIN_KEY: 'rego-key',
  // the Cloudflare Email Service binding, played by the test
  EMAIL: { send: async (msg) => { outbound.emails.push({ body: msg }); return { messageId: 'em_' + (outbound.emails.length + 1) }; } },
  EMAIL_FROM: 'SCS.2 <tab@scs.andyrew.space>', EMAIL_REPLY_TO: 'westsocunsw@gmail.com',
  SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/hook?token=shh'
};
const waits = [];
const ctx = { waitUntil(p) { waits.push(p); } };
const settle = () => Promise.all(waits.splice(0));
const front = (path, opts, ip) => {
  opts = opts || {};
  opts.headers = Object.assign({ 'cf-connecting-ip': ip || '203.0.113.7' }, opts.headers || {});
  return mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, ctx);
};
const jpost = (path, body, token, ip) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
}, ip);

const member = (over) => Object.assign({
  name: 'Alice Park', zid: 'z5111111', email: 'Alice@Example.com',
  discord: 'alicep', arc: true, dietary: 'Vegetarian'
}, over);
// a team is three to five people on the public form, so a signup
// naming fewer is filled out to three with visitors of its own
let padn = 0;
const signup = (over) => {
  const body = Object.assign({
    team_name: 'Loco Motive',
    societies: ['WestSoc', 'RailSoc'],
    photo_permission: true,
    questions: 'Is there a wet weather plan?',
    website: '',
    members: [
      member(),
      member({ name: 'Ben Ho', zid: 'z5222222', email: 'ben@example.com', discord: '', dietary: 'Halal; peanuts — carries epipen' }),
      member({ name: 'Cass Visitor', zid: 'z0000000', email: 'cass@example.com', dietary: '' })
    ]
  }, over);
  while (body.members.length < 3) {
    padn += 1;
    body.members.push(member({ name: 'Pad ' + padn, zid: 'z0000000', email: 'pad' + padn + '@example.com', discord: '' }));
  }
  return body;
};

// ---------------- the happy path ----------------
let r = await jpost('/api/rego/create', signup());
let data = await r.json();
await settle();
check('a team of three registers cleanly, QRs counted (trailing-slash URL tolerated)',
  r.status === 200 && data.ok &&
  data.team === 'Loco Motive' && data.members === 3 && data.emails === 3 && data.qrs === 3, JSON.stringify(data));
check('the team lands on the tab',
  !!raw.prepare("SELECT id FROM teams WHERE name = 'Loco Motive'").get(), '');
check('every person is on file with their details',
  raw.prepare('SELECT COUNT(*) AS n FROM participants').get().n === 3 &&
  raw.prepare("SELECT dietary FROM participants WHERE zid = 'z5222222'").get().dietary === 'Halal; peanuts — carries epipen', '');
check('emails are stored lowercased',
  raw.prepare("SELECT email FROM participants WHERE zid = 'z5111111'").get().email === 'alice@example.com', '');
check('each member got a check-in QR through the check-in worker',
  outbound.checkin.length === 3 && outbound.checkin.every(c => c.auth === 'Bearer rego-key') &&
  outbound.checkin[0].body.team_name === 'Loco Motive' &&
  raw.prepare("SELECT qr_url FROM participants WHERE zid = 'z5111111'").get().qr_url === 'https://checkin.example/qr/code-1.png', '');

const mail = outbound.emails[1];
// the ticket link: a version byte, the check-in token's raw bytes,
// then name and team — the page redraws the QR from the token itself
const tokenRaw = Buffer.from('ticket-token-code-2');
const ticketToken = Buffer.concat([
  Buffer.from([2, tokenRaw.length]), tokenRaw, Buffer.from('Ben Ho\nLoco Motive', 'utf8')
]).toString('base64url');
check('every member gets the confirmation email', outbound.emails.length === 3, '');
check('the email presents as the unmonitored address, named so inboxes show it, with replies to the org inbox',
  mail.body.from && mail.body.from.name === 'SCS.2' && mail.body.from.email === 'tab@scs.andyrew.space' &&
  mail.body.replyTo === 'westsocunsw@gmail.com' && !('reply_to' in mail.body), JSON.stringify({ from: mail.body.from, replyTo: mail.body.replyTo }));
check('the email names who signed them up, the date, and embeds their own QR',
  mail.body.html.includes('Alice Park signed your team up') &&
  mail.body.html.includes('Tuesday 20 October') &&
  mail.body.html.includes('qr/code-2.png') && mail.body.html.includes('/ticket/?' + ticketToken) && mail.body.text.includes('/ticket/?' + ticketToken) &&
  mail.body.html.includes('westsocunsw@gmail.com'), '');
r = await front('/api/ticket/qr?k=code-2');
check('the ticket page fetches the QR through the tab worker by its key',
  r.status === 200 && r.headers.get('content-type') === 'image/png' && r.headers.get('cache-control').includes('immutable') && (await r.arrayBuffer()).byteLength === 4, 'status=' + r.status);
r = await front('/api/ticket/qr?k=code-9');
check('an unknown key is a 404', r.status === 404, 'status=' + r.status);
r = await front('/api/ticket/qr?k=../etc');
check('a malformed key is refused', r.status === 400, 'status=' + r.status);
check('the sheet got one row per person with the header on offer',
  outbound.sheet.length === 1 && outbound.sheet[0].body.mode === 'append' &&
  outbound.sheet[0].body.rows.length === 3 &&
  outbound.sheet[0].body.rows[0][1] === 'Loco Motive' &&
  outbound.sheet[0].body.rows[0][9] === 'WestSoc; RailSoc', JSON.stringify(outbound.sheet[0].body.rows[0]));
check('two z0000000 visitors never collide',
  outbound.checkin[2].body.zid === 'z0000000', '');

// ---------------- the terms and waiver ----------------
const keys = raw.prepare("SELECT name, terms_key, terms_at FROM participants ORDER BY position").all();
const keyOf = name => keys.find(k => k.name === name).terms_key;
check('the form asks nobody to agree: each person has their own terms link, in their own email only, and the signer gets theirs back',
  keys.length === 3 && new Set(keys.map(k => k.terms_key)).size === 3 && keys.every(k => k.terms_key && !k.terms_at) &&
  data.terms_url === 'https://scs.andyrew.space/terms/?k=' + keyOf('Alice Park') &&
  outbound.emails[1].body.html.includes('/terms/?k=' + keyOf('Ben Ho')) &&
  outbound.emails[1].body.text.includes('/terms/?k=' + keyOf('Ben Ho')) &&
  !outbound.emails[1].body.html.includes(keyOf('Alice Park')), JSON.stringify(keys));
r = await front('/api/rego/terms?k=' + keyOf('Ben Ho'));
data = await r.json();
check('the link says who it is for and that they have not accepted yet',
  r.status === 200 && r.headers.get('cache-control') === 'no-store' &&
  data.name === 'Ben Ho' && data.team === 'Loco Motive' && data.accepted_at === null, JSON.stringify(data));
r = await jpost('/api/rego/terms', { k: keyOf('Ben Ho') });
data = await r.json();
const firstAt = data.accepted_at;
await jpost('/api/rego/terms', { k: keyOf('Ben Ho') });
check('accepting stamps that one person, once: a second press keeps the first time and logs nothing more',
  r.status === 200 && !!firstAt &&
  raw.prepare("SELECT terms_at FROM participants WHERE name = 'Ben Ho'").get().terms_at === firstAt &&
  raw.prepare("SELECT COUNT(*) AS n FROM participants WHERE terms_at IS NOT NULL").get().n === 1 &&
  raw.prepare("SELECT COUNT(*) AS n FROM submission_log WHERE action = 'rego-terms'").get().n === 1, JSON.stringify(data));
// the photo answer is each person's own, from the same page: a change
// with accept: false records the answer and accepts nothing
r = await jpost('/api/rego/terms', { k: keyOf('Alice Park'), photo: false, accept: false });
const photoOnly = await r.json();
await jpost('/api/rego/terms', { k: keyOf('Ben Ho'), photo: true });
r = await front('/api/rego/terms?k=' + keyOf('Ben Ho'));
const benPhoto = await r.json();
const photoRow = n => raw.prepare('SELECT photo_ok, terms_at FROM participants WHERE name = ?').get(n);
check('each person\'s own photo answer is stored and read back, and an answer alone accepts nothing',
  photoOnly.photo === false && photoOnly.accepted_at === null &&
  photoRow('Alice Park').photo_ok === 0 && photoRow('Alice Park').terms_at === null &&
  photoRow('Ben Ho').photo_ok === 1 && photoRow('Ben Ho').terms_at === firstAt && benPhoto.photo === true &&
  photoRow('Cass Visitor').photo_ok === null,
  JSON.stringify({ photoOnly, benPhoto, alice: photoRow('Alice Park'), cass: photoRow('Cass Visitor') }));
r = await jpost('/api/rego/terms', { k: 'A'.repeat(24) });
const unknownStatus = r.status;
r = await front('/api/rego/terms?k=short');
check('a key that matches nobody is a 404 and a malformed one a 400',
  unknownStatus === 404 && r.status === 400, unknownStatus + ' ' + r.status);

// ---------------- the door holds ----------------
r = await jpost('/api/rego/create', signup({ team_name: 'loco motive', members: [member({ zid: 'z5999999' })] }));
check('a taken team name is refused case-insensitively', r.status === 409, 'status=' + r.status);
r = await jpost('/api/rego/create', signup({ team_name: 'Rat Race' }));
{
  const said = (await r.json()).error || '';
  check('a zID cannot register twice, and the public form does not say which team has it',
    r.status === 409 && /already registered/.test(said) && !said.includes('Loco Motive'), said);
}
r = await jpost('/api/rego/create', {
  team_name: 'Too Small', website: '', societies: [], photo_permission: true, questions: '',
  members: [member({ zid: 'z5444441', email: 'small1@example.com' }), member({ name: 'Pair', zid: 'z5444442', email: 'small2@example.com' })]
}, null, '203.0.113.77');
check('the public form takes no team of fewer than three',
  r.status === 400 && /at least three/.test((await r.json()).error || ''), 'status=' + r.status);
r = await jpost('/api/rego/create', signup({ team_name: 'Rat Race', members: [member({ zid: 'nope', email: 'x@y.com' })] }));
check('a mangled zID is refused', r.status === 400, 'status=' + r.status);
{
  const unsw = [];
  for (const email of ['z5333333@ad.unsw.edu.au', 'Someone@UNSW.edu.au']) {
    const res = await jpost('/api/rego/create', signup({ team_name: 'Rat Race',
      members: [member({ zid: 'z5333333', email }), member({ name: 'Ben Ho', zid: 'z5333334', email: 'ben2@example.com' }),
        member({ name: 'Cass Visitor', zid: 'z0000000', email: 'cass2@example.com' })] }), null, '203.0.113.50');
    unsw.push(res.status + ' ' + ((await res.json()).error || ''));
  }
  check('the public form takes no UNSW address, and says which person\'s it was',
    unsw.every(u => /^400 Alice Park's email is a UNSW address/.test(u)), unsw.join(' | '));
}
{
  // the form is refused rather than trimmed: a sixth person, a society
  // the worker does not know, and the name check-in gives people with no team
  const six = [1, 2, 3, 4, 5, 6].map(n => member({ name: 'Six ' + n, zid: 'z571000' + n, email: 'six' + n + '@example.com' }));
  const refused = [];
  for (const body of [
    signup({ team_name: 'Six Pack', members: six }),
    signup({ team_name: 'Odd Soc', societies: ['RailSoc', 'NotARealSoc'], members: six.slice(0, 3) }),
    signup({ team_name: 'No Team  Yet', members: six.slice(0, 3) })
  ]) {
    const res = await jpost('/api/rego/create', body, null, '203.0.113.60');
    refused.push(res.status + ' ' + ((await res.json()).error || ''));
  }
  check('a sixth person, an unknown society and the name kept for people without a team are each refused, and nothing is written',
    /^400 A team is at most 5/.test(refused[0]) && /^400 "NotARealSoc"/.test(refused[1]) && /^400 "No team yet"/.test(refused[2]) &&
    !raw.prepare("SELECT 1 FROM participants WHERE name LIKE 'Six %'").get(), refused.join(' | '));
}
{
  // two signups as one name in different cases at the same moment: one
  // team, and the other is told the name is taken
  const twin = (name, k) => signup({ team_name: name, members: [1, 2, 3].map(n =>
    member({ name: 'Twin ' + k + n, zid: 'z572' + k + '00' + n, email: 'twin' + k + n + '@example.com' })) });
  const both = await Promise.all([
    jpost('/api/rego/create', twin('Twin Peaks', 1), null, '203.0.113.61'),
    jpost('/api/rego/create', twin('twin peaks', 2), null, '203.0.113.62')
  ]);
  await settle();
  const statuses = both.map(x => x.status).sort();
  check('two signups as one name in two cases at once make one team, and the other is refused as taken',
    statuses.join() === '200,409' && raw.prepare("SELECT COUNT(*) AS n FROM teams WHERE name = 'Twin Peaks' COLLATE NOCASE").get().n === 1,
    statuses.join());
  // off again, so the counts below are the ones they were written for
  raw.exec("DELETE FROM participants WHERE name LIKE 'Twin %'; DELETE FROM registrations WHERE team_name = 'Twin Peaks' COLLATE NOCASE; " +
    "DELETE FROM teams WHERE name = 'Twin Peaks' COLLATE NOCASE; DELETE FROM submission_log WHERE team_name = 'Twin Peaks' COLLATE NOCASE");
}
const before = raw.prepare('SELECT COUNT(*) AS n FROM registrations').get().n;
r = await jpost('/api/rego/create', signup({ team_name: 'Bot Farm', website: 'https://spam.example' }));
check('the honeypot swallows bots without a trace',
  (await r.json()).ok === true && raw.prepare('SELECT COUNT(*) AS n FROM registrations').get().n === before, '');

// a write that fails part way leaves nothing: not the team name, not a
// registration with nobody on it, and no email sent for anyone
{
  raw.exec("CREATE TRIGGER rego_breaks BEFORE INSERT ON participants WHEN NEW.name = 'Breaks Here' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
  const mailed = outbound.emails.length;
  const broken = signup({ team_name: 'Half Written', members: [
    member({ zid: 'z5600001', email: 'hw1@example.com' }), member({ name: 'Breaks Here', zid: 'z5600002', email: 'hw2@example.com' }),
    member({ name: 'Hw Three', zid: 'z5600003', email: 'hw3@example.com' })
  ] });
  r = await jpost('/api/rego/create', broken, null, '203.0.113.91');
  const failedStatus = r.status;
  await settle();
  check('a signup whose rows cannot all be written leaves no team, no registration and no email behind',
    failedStatus === 500 && !raw.prepare("SELECT id FROM teams WHERE name = 'Half Written'").get() &&
    !raw.prepare("SELECT id FROM registrations WHERE team_name = 'Half Written'").get() && outbound.emails.length === mailed,
    'status=' + failedStatus);
  raw.exec('DROP TRIGGER rego_breaks');
  r = await jpost('/api/rego/create', broken, null, '203.0.113.91');
  await settle();
  check('so sending it again goes through', r.status === 200 && (await r.json()).members === 3, 'status=' + r.status);
}

for (let i = 0; i < 3; i++) {
  await jpost('/api/rego/create', signup({
    team_name: 'Filler ' + i,
    members: [member({ zid: 'z580000' + i, email: 'f' + i + '@example.com' })]
  }));
}
r = await jpost('/api/rego/create', signup({ team_name: 'One Too Many', members: [member({ zid: 'z5900001' })] }));
check('the same connection cannot flood signups', r.status === 429, 'status=' + r.status);
r = await jpost('/api/rego/create', signup({ team_name: 'Neighbours', members: [member({ zid: 'z5900002', email: 'n@example.com' })] }), null, '198.51.100.9');
check('a different connection still gets through', (await r.json()).ok === true, '');

// ---------------- console side ----------------
const regoSignIn = await consoleSignIn(jpost, 'Tab', 'tab-pass');
r = { status: regoSignIn.session ? 200 : 401, json: async () => regoSignIn };
const sess = (await r.json()).session;
r = await front('/api/console/rego', { headers: { authorization: 'Bearer ' + sess } });
data = await r.json();
check('the console overview counts teams, people and dietary needs',
  data.teams === 6 && data.people === 18 && data.dietary.Vegetarian >= 4 &&
  data.registrations[0].members.length === 3, JSON.stringify({ teams: data.teams, people: data.people }));
check('and says who has accepted the terms, with the link to pass on rather than the bare key',
  !!data.registrations[0].members[1].terms_at && data.registrations[0].members[0].terms_at === null &&
  data.registrations[0].members[0].terms_url.endsWith('/terms/?k=' + keyOf('Alice Park')) &&
  !('terms_key' in data.registrations[0].members[0]), JSON.stringify(data.registrations[0].members[1]));
// a field typed into the public form that a spreadsheet would read as
// a formula goes out as text
raw.prepare("UPDATE participants SET dietary = '=HYPERLINK(\"https://x.example\",\"x\")' WHERE zid = 'z5222222'").run();
r = await front('/api/console/rego/csv', { headers: { authorization: 'Bearer ' + sess } });
const csv = await r.text();
raw.prepare("UPDATE participants SET dietary = 'Halal; peanuts — carries epipen' WHERE zid = 'z5222222'").run();
check('a signup field starting = goes into the CSV as text, not a formula',
  csv.includes('"\'=HYPERLINK(""https://x.example"",""x"")"') && !/(^|,)"?=HYPERLINK/m.test(csv), '');
check('the CSV export ships every person with the header row',
  r.headers.get('content-type').includes('text/csv') &&
  csv.split('\r\n')[0].startsWith('Submitted (UTC),Team,#,Name,zID') &&
  csv.includes('Loco Motive') && csv.includes('Vegetarian') &&
  csv.split('\r\n')[0].endsWith(',Terms accepted (UTC),Own photo answer'), '');
r = await front('/api/console/rego/csv');
check('the export needs a console session', r.status === 401, 'status=' + r.status);

outbound.sheet.length = 0;
r = await jpost('/api/console/rego/resync', {}, sess);
data = await r.json();
check('resync rewrites the whole sheet',
  data.ok && data.rows === 18 && outbound.sheet.length === 1 && outbound.sheet[0].body.mode === 'replace', JSON.stringify(data));

// Apps Script refusals come back as HTTP 200 with 'no' in the body —
// the worker must not count those as delivered
const wrongTokenEnv = Object.assign({}, ENV, { SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/hook?token=wrong' });
r = await mod.default.fetch(new Request('https://bot.example/api/console/rego/resync', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sess, 'cf-connecting-ip': '192.0.2.57' },
  body: '{}'
}), wrongTokenEnv, ctx);
check('a sheet that answers no (wrong token) reads as a failure, not a send, and says it is the token',
  r.status === 502 && /refused the token/.test((await r.json()).error || ''), 'status=' + r.status);

// what Google actually does: the answer behind a redirect, read with a
// GET; and a script that crashed names what failed rather than a bare
// "did not answer ok"
const sheetAt = (token) => mod.default.fetch(new Request('https://bot.example/api/console/rego/resync', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sess, 'cf-connecting-ip': '192.0.2.57' },
  body: '{}'
}), Object.assign({}, ENV, { SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/hook?token=' + token }), ctx);
const moved = await sheetAt('moved');
const movedBody = await moved.json();
const broken = await sheetAt('broken');
const brokenBody = await broken.json();
check('a resync follows Google\'s redirect with a GET, and a script that crashed says what failed',
  moved.status === 200 && movedBody.ok && broken.status === 502 &&
  /script failed: TypeError: Cannot read properties of null \(reading 'clearContents'\)/.test(brokenBody.error || ''),
  JSON.stringify({ moved: movedBody, broken: brokenBody }));

outbound.emails.length = 0;
const person = raw.prepare("SELECT id FROM participants WHERE zid = 'z5222222'").get();
r = await jpost('/api/console/rego/email', { id: person.id }, sess);
data = await r.json();
check('one person\'s confirmation can be resent from the console',
  data.ok && data.name === 'Ben Ho' && data.qr === 'attached' && outbound.emails.length === 1 &&
  outbound.emails[0].body.to === 'ben@example.com', JSON.stringify(data));

// ---------------- readable failure when check-in is not wired ----------------
const bareEnv = Object.assign({}, ENV, { CHECKIN_API: 'PASTE-YOUR-CHECKIN-WORKER-URL', CHECKIN_KEY: undefined });
const bareFront = (path, opts) => {
  opts = opts || {};
  opts.headers = Object.assign({ 'cf-connecting-ip': '192.0.2.55' }, opts.headers || {});
  return mod.default.fetch(new Request('https://bot.example' + path, opts), bareEnv, ctx);
};
r = await bareFront('/api/rego/create', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify(signup({ team_name: 'No QR Crew', members: [member({ zid: 'z5777777', email: 'noqr@example.com' })] }))
});
data = await r.json();
check('with check-in unconfigured, registration still lands but mints no QRs',
  data.ok && data.qrs === 0, JSON.stringify(data));
const noQr = raw.prepare("SELECT id FROM participants WHERE zid = 'z5777777'").get();
r = await bareFront('/api/console/rego/email', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sess },
  body: JSON.stringify({ id: noQr.id })
});
data = await r.json();
check('the resend says exactly why the QR is missing',
  data.qr === 'missing' && /CHECKIN_API/.test(data.qr_note || ''), JSON.stringify(data));
// a scheme-less URL (the classic paste mistake) gets named, not a vague failure
const schemelessEnv = Object.assign({}, ENV, { CHECKIN_API: 'scs-checkin.example.workers.dev' });
r = await mod.default.fetch(new Request('https://bot.example/api/console/rego/email', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sess, 'cf-connecting-ip': '192.0.2.56' },
  body: JSON.stringify({ id: noQr.id })
}), schemelessEnv, ctx);
data = await r.json();
check('a CHECKIN_API missing https:// is called out by name',
  data.qr === 'missing' && /https:\/\//.test(data.qr_note || ''), JSON.stringify(data));

r = await jpost('/api/console/rego/email', { id: noQr.id }, sess);
data = await r.json();
check('once check-in is wired, the same button mints and attaches the QR',
  data.qr === 'attached' && !data.qr_note, JSON.stringify(data));

// ---------------- the three sending paths ----------------
const emailMod = await import(BOT + '/src/email.ts');
const probe = { to: 'a@example.com', subject: 'S', html: '<p>h</p>', text: 'h' };
let bindingMsgs = [];
let status = await emailMod.sendEmail({
  EMAIL: { send: async m => { bindingMsgs.push(m); } },
  EMAIL_FROM: 'X <x@example.com>', EMAIL_REPLY_TO: 'org@example.com'
}, probe);
check('the Cloudflare Email Service binding is the first-choice sender',
  status === 'sent' && bindingMsgs.length === 1 &&
  bindingMsgs[0].to === 'a@example.com' && bindingMsgs[0].replyTo === 'org@example.com', JSON.stringify(bindingMsgs));
bindingMsgs = [];
status = await emailMod.sendEmail({
  EMAIL: { send: async m => { if (m.replyTo) throw new Error('unknown field'); bindingMsgs.push(m); } }
}, probe);
check('a binding that refuses replyTo still delivers without it (routing forwards replies anyway)',
  status === 'sent' && bindingMsgs.length === 1 && !bindingMsgs[0].replyTo, '');
const resendBefore = outbound.emails.length;
status = await emailMod.sendEmail({ EMAIL_API_KEY: 're_fallback' }, probe);
check('without the binding a Resend key still works as the fallback',
  status === 'sent' && outbound.emails.length === resendBefore + 1 &&
  outbound.emails[resendBefore].auth === 'Bearer re_fallback', '');
status = await emailMod.sendEmail({}, probe);
check('with neither, sends report skipped for a later retry', status === 'skipped', status);

// ---------------- the scheduled ticket sweep ----------------
// A ticket that did not go out used to sit there until the person said
// so at the door: the registration had succeeded, the row recorded
// 'skipped', and the only cure was an organiser noticing. This is the
// cure running on a timer.
{
  const { regoRetryTick, ticketsOutstanding } = await import(BOT + '/src/rego.ts');
  // every signup above is settled, so what follows is all the sweep sees
  raw.prepare("UPDATE participants SET email_status = 'sent', qr_url = COALESCE(NULLIF(qr_url, ''), '/qr/earlier.png')").run();
  // a person registered but never emailed, and one never given a code
  const regId = raw.prepare('SELECT id FROM registrations ORDER BY id LIMIT 1').get().id;
  // a signup still being sent out belongs to the request doing it, so the
  // sweep only looks at ones a couple of minutes old
  raw.prepare("UPDATE registrations SET submitted_at = datetime('now', '-5 minutes') WHERE id = ?").run(regId);
  raw.prepare(
    "INSERT INTO participants (registration_id, position, name, zid, email, arc, qr_url, email_status) " +
    "VALUES (?, 9, 'Missed Out', 'z5999901', 'missed@example.com', 0, '/qr/have.png', 'failed')"
  ).run(regId);
  raw.prepare(
    "INSERT INTO participants (registration_id, position, name, zid, email, arc, qr_url, email_status) " +
    "VALUES (?, 8, 'No Code', 'z5999902', 'nocode@example.com', 0, '', 'skipped')"
  ).run(regId);
  // one whose email went out without a code, which it said would follow
  raw.prepare(
    "INSERT INTO participants (registration_id, position, name, zid, email, arc, qr_url, email_status) " +
    "VALUES (?, 10, 'Told Later', 'z5999905', 'later@example.com', 0, '', 'sent')"
  ).run(regId);
  // and one nobody is waiting on: already sent
  raw.prepare(
    "INSERT INTO participants (registration_id, position, name, zid, email, arc, qr_url, email_status) " +
    "VALUES (?, 7, 'All Good', 'z5999903', 'fine@example.com', 0, '/qr/fine.png', 'sent')"
  ).run(regId);

  check('the dashboard can see how many tickets are outstanding',
    (await ticketsOutstanding(db)) === 3, String(await ticketsOutstanding(db)));

  const before = outbound.emails.length;
  let out = await regoRetryTick(ENV);
  check('a tick picks up the ones that failed and leaves the ones that went',
    out.ran && out.tried === 3 && out.fixed === 3 && outbound.emails.length === before + 3,
    JSON.stringify(out));
  const later = raw.prepare("SELECT qr_url FROM participants WHERE zid = 'z5999905'").get().qr_url;
  check('the person told their code would come separately is sent it once it exists',
    /\/qr\//.test(later || '') && outbound.emails.slice(before).some(e => e.body.to === 'later@example.com' && e.body.html.includes(later)),
    String(later));
  // these rows were written with no terms key, as rows from before the
  // terms link were: the email still has to carry one
  const missed = raw.prepare("SELECT terms_key FROM participants WHERE zid = 'z5999901'").get().terms_key;
  check('a person written without a terms link is given one before their email goes',
    !!missed && outbound.emails.slice(before).some(e => e.body.html.includes('/terms/?k=' + missed)), String(missed));
  const gained = raw.prepare("SELECT qr_url FROM participants WHERE zid = 'z5999902'").get().qr_url;
  check('the one with no code was given one on the way past', /\/qr\//.test(gained || ''), String(gained));
  check('and both now read as sent, so nothing is left outstanding',
    (await ticketsOutstanding(db)) === 0, String(await ticketsOutstanding(db)));

  out = await regoRetryTick(ENV);
  check('a second tick finds nothing to do', out.ran === false, JSON.stringify(out));

  // an address that will never accept mail must not be tried forever
  raw.prepare(
    "INSERT INTO participants (registration_id, position, name, zid, email, arc, qr_url, email_status, email_tries) " +
    "VALUES (?, 6, 'Never Works', 'z5999904', 'never@example.com', 0, '/qr/n.png', 'failed', 5)"
  ).run(regId);
  out = await regoRetryTick(ENV);
  check('one that has been tried five times is left alone rather than retried every minute',
    out.ran === false, JSON.stringify(out));
}

// ---------------- signing up without a team ----------------
// One person, or two who want to stay together, sign up with no team;
// the organisers put them in one from the Rego tab.
{
  const soloSignup = (people, ip) => jpost('/api/rego/create', {
    solo: true, societies: ['PhotoSoc'], photo_permission: true, questions: 'Happy to go anywhere.', website: '',
    members: people
  }, null, ip);
  outbound.emails.length = 0;
  outbound.checkin.length = 0;
  r = await soloSignup([member({ name: 'Sol Oh', zid: 'z5700001', email: 'sol@example.com', discord: 'soloh' })], '198.51.100.71');
  data = await r.json();
  await settle();
  const solReg = raw.prepare("SELECT r.* FROM registrations r JOIN participants p ON p.registration_id = r.id WHERE p.zid = 'z5700001'").get();
  const solMail = outbound.emails.find(e => (e.body.to === 'sol@example.com'));
  check('one person signs up without a team: no team on the tab, a code under no team, and the ordinary email with no team row',
    r.status === 200 && data.ok && data.solo === true && data.members === 1 &&
    solReg.team_id === null && solReg.team_name === '' &&
    raw.prepare("SELECT team_id FROM participants WHERE zid = 'z5700001'").get().team_id === null &&
    outbound.checkin.some(c => c.body.zid === 'z5700001' && c.body.team_name === 'No team yet') &&
    !!solMail && solMail.body.subject === "You're In! You are registered for SCS.2" && !/Team:/.test(solMail.body.text) && !/without a team/.test(solMail.body.text + solMail.body.html),
    JSON.stringify({ status: r.status, data, reg: solReg, subject: solMail && solMail.body.subject }));
  r = await soloSignup([
    member({ name: 'Pia Ir', zid: 'z5700002', email: 'pia@example.com', discord: 'piair' }),
    member({ name: 'Rey Ir', zid: 'z5700003', email: 'rey@example.com', discord: '' })
  ], '198.51.100.72');
  data = await r.json();
  await settle();
  check('two sign up together the same way', r.status === 200 && data.solo === true && data.members === 2, JSON.stringify(data));
  r = await soloSignup([1, 2, 3].map(n => member({ name: 'Trio ' + n, zid: 'z570001' + n, email: 'trio' + n + '@example.com' })), '198.51.100.73');
  check('three people are a team, not two people without one', r.status === 400 && /as a team/.test((await r.json()).error || ''), 'status=' + r.status);

  let overview = await (await front('/api/console/rego', { headers: { authorization: 'Bearer ' + sess } })).json();
  const unplaced = overview.registrations.filter(x => x.solo === 1);
  check('the Rego tab is told who has no team, and does not count them as teams',
    unplaced.length === 2 && unplaced.every(x => x.members.length >= 1) &&
    overview.teams === overview.registrations.filter(x => !x.solo).length, JSON.stringify({ teams: overview.teams, unplaced: unplaced.length }));
  const ids = unplaced.map(x => x.id);

  // placing them: a new team
  r = await jpost('/api/console/rego/place', { registration_ids: ids, team_name: 'Loco Motive' }, sess);
  check('a new team cannot take a name already on the tab', r.status === 409, 'status=' + r.status);
  const teamReg = raw.prepare("SELECT id FROM registrations WHERE team_name = 'Loco Motive'").get();
  r = await jpost('/api/console/rego/place', { registration_ids: [teamReg.id], team_name: 'Odd Lot' }, sess);
  check('only signups without a team can be placed', r.status === 400, 'status=' + r.status);
  outbound.emails.length = 0;
  outbound.checkin.length = 0;
  r = await jpost('/api/console/rego/place', { registration_ids: ids, team_name: 'Late Joiners' }, sess);
  data = await r.json();
  await settle();
  const joined = raw.prepare("SELECT p.name, p.position, p.team_id, p.registration_id FROM participants p JOIN teams t ON t.id = p.team_id WHERE t.name = 'Late Joiners' ORDER BY p.position").all();
  const newReg = raw.prepare("SELECT * FROM registrations WHERE team_name = 'Late Joiners'").get();
  check('placing them makes the team and its registration and moves all three across, numbered from one',
    r.status === 200 && data.created === true && data.moved === 3 &&
    joined.map(x => x.name).join() === 'Sol Oh,Pia Ir,Rey Ir' && joined.map(x => x.position).join() === '1,2,3' &&
    joined.every(x => x.registration_id === newReg.id) &&
    raw.prepare('SELECT COUNT(*) AS n FROM registrations WHERE id IN (' + ids.join(',') + ')').get().n === 0,
    JSON.stringify({ data, joined }));
  check('and keeps what they answered on the form',
    newReg.societies === 'PhotoSoc' && newReg.photo_permission === 1 && /anywhere/.test(newReg.questions || ''), JSON.stringify(newReg));
  check('each of them is emailed their ticket under the team\'s name',
    data.emails === 3 && outbound.emails.length === 3 &&
    outbound.emails.every(e => e.body.subject === "You're In! You are on team Late Joiners for SCS.2" && /assigned to team Late Joiners\. Please get in contact/.test(e.body.text)),
    JSON.stringify(outbound.emails.map(e => e.body.subject)));
  const renamed = outbound.checkin.find(c => Array.isArray(c.body.people));
  check('and check-in is told their team, found by their own id',
    !!renamed && renamed.body.people.length === 3 && renamed.body.people.every(x => x.team_name === 'Late Joiners' && x.was_team === 'No team yet' && x.participant_id > 0),
    JSON.stringify(renamed && renamed.body));

  // placing into a team that already exists, as far as it has room
  r = await soloSignup([member({ name: 'Una Late', zid: 'z5700004', email: 'una@example.com', discord: 'unalate' })], '198.51.100.74');
  await settle();
  const una = raw.prepare("SELECT registration_id FROM participants WHERE zid = 'z5700004'").get().registration_id;
  const loco = raw.prepare("SELECT id FROM teams WHERE name = 'Loco Motive'").get().id;
  r = await jpost('/api/console/rego/place', { registration_ids: [una], team_id: loco, email: false }, sess);
  data = await r.json();
  const locoPeople = raw.prepare('SELECT name, position FROM participants WHERE team_id = ? ORDER BY position').all(loco);
  check('one can join a team already on the tab, after the people on it',
    r.status === 200 && data.created === false && locoPeople.length === 4 && locoPeople[3].name === 'Una Late' && locoPeople[3].position === 4,
    JSON.stringify(locoPeople));
  r = await soloSignup([
    member({ name: 'Vic Late', zid: 'z5700005', email: 'vic@example.com', discord: 'viclate' }),
    member({ name: 'Wes Late', zid: 'z5700006', email: 'wes@example.com' })
  ], '198.51.100.75');
  await settle();
  const pair = raw.prepare("SELECT registration_id FROM participants WHERE zid = 'z5700005'").get().registration_id;

  // The form holds three to five; from the dashboard a team that asks
  // goes past five, one person at a time from its card or by placing,
  // up to ten and no further.
  const person = (n) => ({ name: 'Big Table ' + n, zid: 'z59100' + String(n).padStart(2, '0'), email: 'big' + n + '@example.com' });
  const made = await (await jpost('/api/console/rego/team/create', { team_name: 'Big Table', members: [person(1)] }, sess)).json();
  const bigTeam = raw.prepare("SELECT id FROM teams WHERE name = 'Big Table'").get().id;
  const addTo = (n) => jpost('/api/console/rego/person/save', Object.assign({ id: 0, registration_id: made.registration_id }, person(n)), sess);
  const grew = [];
  for (let n = 2; n <= 9; n++) { const g = await addTo(n); grew.push(g.status === 200 ? 200 : g.status + ' ' + ((await g.json()).error || '')); }
  r = await jpost('/api/console/rego/place', { registration_ids: [pair], team_id: bigTeam, email: false }, sess);
  const placeOver = { status: r.status, error: (await r.json()).error || '' };
  const tenth = (await addTo(10)).status;
  r = await addTo(11);
  const eleventh = { status: r.status, error: (await r.json()).error || '' };
  check('from the dashboard a team goes past five, up to ten and no further',
    grew.every(s => s === 200) && placeOver.status === 400 && /more than 10/.test(placeOver.error) &&
    tenth === 200 && eleventh.status === 400 && /at most 10/.test(eleventh.error) &&
    raw.prepare('SELECT COUNT(*) AS n FROM participants WHERE team_id = ?').get(bigTeam).n === 10,
    JSON.stringify({ made: made.ok, grew, placeOver, tenth, eleventh }));

  // a test signup: off the public count while nobody on it is in a team
  const { peopleSignedUp } = await import(BOT + '/src/rego.ts');
  const before = await peopleSignedUp(db);
  const hid = await (await jpost('/api/console/rego/hide', { ids: [pair], hidden: true }, sess)).json();
  const after = await peopleSignedUp(db);
  r = await jpost('/api/console/rego/hide', { ids: [teamReg.id], hidden: true }, sess);
  overview = await (await front('/api/console/rego', { headers: { authorization: 'Bearer ' + sess } })).json();
  check('a signup with nobody in a team can be hidden as a test, taking its people off the public count; a team\'s signup is hidden with its team instead',
    hid.ok && hid.count === 1 && after === before - 2 && r.status === 400 &&
    overview.registrations.find(x => x.id === pair).hidden === 1, JSON.stringify({ before, after, hid }));

  // Moving somebody already in a team: to another team on the tab, or
  // out to no team. Only an account with the Rego tab may, and an admin
  // can make it ask for the second password.
  const solId = raw.prepare("SELECT id FROM participants WHERE zid = 'z5700001'").get().id;
  const lateTeam = raw.prepare("SELECT id FROM teams WHERE name = 'Late Joiners'").get().id;
  const signedOut = (await jpost('/api/console/rego/person/move', { id: solId, team_id: loco })).status;
  await jpost('/api/console/accounts/save', { create: true, name: 'Lee', password: 'lee-password', perms: ['log'], require_2fa: false }, sess);
  const lee = (await consoleSignIn(jpost, 'Lee', 'lee-password')).session;
  r = await jpost('/api/console/rego/person/move', { id: solId, team_id: loco }, lee);
  const noTab = { status: r.status, body: await r.json() };
  ENV.PUSH_PASSWORD = 'second-pass';
  const withSecond = (path, body) => front(path, { method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sess, 'x-second-password': 'second-pass' } });
  await withSecond('/api/console/guards/set', { key: 'move-signup', on: true });
  r = await jpost('/api/console/rego/person/move', { id: solId, team_id: loco }, sess);
  const unasked = await r.json();
  check('moving a person needs a signed-in account with the Rego tab, and the second password once an admin asks for it',
    signedOut === 401 && noTab.status === 403 && noTab.body.no_access === true &&
    r.status === 403 && unasked.second_password === true &&
    raw.prepare('SELECT team_id FROM participants WHERE id = ?').get(solId).team_id === lateTeam,
    JSON.stringify({ signedOut, noTab, unasked }));

  const move = (body) => withSecond('/api/console/rego/person/move', body);
  outbound.emails.length = 0;
  outbound.checkin.length = 0;
  r = await move({ id: solId, team_id: loco });
  data = await r.json();
  await settle();
  const sol = raw.prepare('SELECT team_id, registration_id, position FROM participants WHERE id = ?').get(solId);
  const locoReg = raw.prepare('SELECT id FROM registrations WHERE team_id = ? ORDER BY id LIMIT 1').get(loco).id;
  const moveMail = outbound.emails.find(e => e.body.to === 'sol@example.com');
  const told = outbound.checkin.find(c => Array.isArray(c.body.people));
  check('with it they move into the team\'s registration after its people; check-in is told, and they are emailed their ticket under the new team',
    r.status === 200 && data.from === 'Late Joiners' && data.team === 'Loco Motive' && data.left === 2 && data.emailed === true &&
    sol.team_id === loco && sol.registration_id === locoReg && sol.position === 5 &&
    !!moveMail && moveMail.body.subject === "You're In! You are on team Loco Motive for SCS.2" && /moved to team Loco Motive\./.test(moveMail.body.text) &&
    !!told && told.body.people[0].team_name === 'Loco Motive' && told.body.people[0].was_team === 'Late Joiners',
    JSON.stringify({ data, sol }));

  const vic = raw.prepare("SELECT id FROM participants WHERE zid = 'z5700005'").get().id;
  const refused = [];
  for (const b of [{ id: solId, team_id: loco }, { id: solId, team_id: bigTeam }, { id: vic, team_id: loco }, { id: solId, team_id: 99999 }]) {
    const x = await move(b);
    refused.push(x.status + ' ' + ((await x.json()).error || ''));
  }
  check('a move is refused to the team they are on, to a full team, for somebody with no team yet, and to a team not on the tab',
    /^400 .*already on Loco Motive/.test(refused[0]) && /^400 .*already has 10/.test(refused[1]) &&
    /^400 .*Without a team/.test(refused[2]) && /^404 /.test(refused[3]), JSON.stringify(refused));

  r = await move({ id: solId, team_id: 0, email: false });
  data = await r.json();
  const solOut = raw.prepare('SELECT p.team_id, r.team_id AS reg_team, r.team_name, r.hidden FROM participants p ' +
    'JOIN registrations r ON r.id = p.registration_id WHERE p.id = ?').get(solId);
  check('and out of a team to none: a signup of their own, as if they had come in without one',
    r.status === 200 && data.team === 'No team yet' && solOut.team_id === null && solOut.reg_team === null &&
    solOut.team_name === '' && solOut.hidden === 0, JSON.stringify({ data, solOut }));
  delete ENV.PUSH_PASSWORD;
}

// ---------------- email off on the Settings tab ----------------
// A signup still goes through, and its confirmations are recorded as
// held rather than sent; a resend is refused; the sweep spends no tries.
// Once email is back on, the sweep sends the held confirmations.
{
  const { regoRetryTick } = await import(BOT + '/src/rego.ts');
  const { trySendEmail } = await import(BOT + '/src/email.ts');
  const setHold = async (held) => (await jpost('/api/console/email/hold', { held }, sess)).json();
  const HELD = ['held1@example.com', 'held2@example.com', 'held3@example.com'];
  const mailedTo = (list) => outbound.emails.filter(e => list.includes(e.body.to));
  outbound.emails.length = 0;
  outbound.checkin.length = 0;
  const off = await setHold(true);
  r = await jpost('/api/rego/create', signup({ team_name: 'Quiet Carriage', members: HELD.map((email, i) =>
    member({ name: 'Held ' + (i + 1), zid: 'z598000' + (i + 1), email, discord: 'held' + (i + 1) })) }), null, '198.51.100.90');
  data = await r.json();
  await settle();
  const heldRows = () => raw.prepare("SELECT email, email_status, email_tries FROM participants WHERE email LIKE 'held%' ORDER BY id").all();
  check('with email off a team still registers and gets its codes, its confirmations held, not sent and no try spent',
    off.ok && off.held === true && r.status === 200 && data.ok && data.emails === 0 && data.qrs === 3 &&
    outbound.checkin.length === 3 && outbound.emails.length === 0 &&
    heldRows().length === 3 && heldRows().every(p => p.email_status === 'held' && p.email_tries === 0),
    JSON.stringify({ data, rows: heldRows() }));

  // a person added on the Rego tab goes the same way, through the one
  // gate every message passes
  const quietReg = raw.prepare("SELECT id FROM registrations WHERE team_name = 'Quiet Carriage'").get().id;
  r = await jpost('/api/console/rego/person/save', { id: 0, registration_id: quietReg, name: 'Held 4', zid: 'z5980004', email: 'held4@example.com' }, sess);
  data = await r.json();
  HELD.push('held4@example.com');
  const gate = await trySendEmail({ DB: db, EMAIL: ENV.EMAIL }, { to: 'probe@example.com', subject: 'S', html: '<p>h</p>', text: 'h' });
  check('anything else that would send an email is held at trySendEmail',
    data.ok && data.person.email_status === 'held' && gate.status === 'held' && outbound.emails.length === 0,
    JSON.stringify({ person: data.person && data.person.email_status, gate: gate.status }));

  const someone = raw.prepare("SELECT id FROM participants WHERE email = 'held1@example.com'").get().id;
  r = await jpost('/api/console/rego/email', { id: someone }, sess);
  data = await r.json();
  const overview = await (await front('/api/console/rego', { headers: { authorization: 'Bearer ' + sess } })).json();
  check('a resend is refused with the reason, and the Rego tab is told email is off',
    r.status === 409 && data.email_off === true && data.error === 'Email sending is off. Turn it on in Settings.' &&
    outbound.emails.length === 0 && overview.email_off === true, JSON.stringify(data));

  // old enough for the sweep, which leaves a signup under two minutes
  // to the request that made it
  raw.prepare("UPDATE registrations SET submitted_at = datetime('now', '-5 minutes') WHERE id = ?").run(quietReg);
  const sweptOff = await regoRetryTick(ENV);
  check('the sweep sends nothing while email is off and spends no tries',
    sweptOff.ran === false && sweptOff.held === true && outbound.emails.length === 0 &&
    heldRows().every(p => p.email_status === 'held' && p.email_tries === 0), JSON.stringify({ sweptOff, rows: heldRows() }));

  await setHold(false);
  for (let i = 0; i < 3; i++) await regoRetryTick(ENV);
  const got = mailedTo(HELD).map(e => e.body.to).sort();
  check('once it is back on, the sweep sends each held confirmation once, with the code in it',
    got.join() === HELD.slice().sort().join() && heldRows().every(p => p.email_status === 'sent') &&
    mailedTo(HELD).every(e => /\/ticket\/\?/.test(e.body.html)), JSON.stringify({ got, rows: heldRows() }));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
