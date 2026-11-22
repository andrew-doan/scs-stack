// Run with: node tests/verify-console-auth.mjs   (needs Node 22+)
//
// What the dashboard's sign-in refuses, what it hands out when it does
// not, and what each account may do once in. The worker holds every
// score on the day: these are the properties somebody editing
// console.js or dash-access.js could break without noticing.
//
// The codes here are worked out from node:crypto rather than from the
// worker's own totp.js — a test that asks the worker to check its own
// arithmetic proves nothing — and the first check is the published RFC
// 6238 vector, so both implementations are pinned to the standard
// rather than to each other.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { totpAt, totpNow, consoleSignIn } from './console-signin.mjs';

const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);

globalThis.caches = { default: {
  async match() { return undefined; }, async put() {}, async delete() { return true; }
} };

// Cloudflare's siteverify, stubbed. `verdict` is what it says about the
// next token, and 'down' is the endpoint being unreachable.
let verdict = 'pass';
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.indexOf('challenges.cloudflare.com') !== -1) {
    if (verdict === 'down') throw new Error('unreachable');
    return new Response(JSON.stringify({ success: verdict === 'pass' }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};

const mod = await import(BOT + '/src/index.ts');
const ENV = { DB: db, CONSOLE_PASSWORD: 'tab-pass' };
const ctx = { waitUntil() {} };
const front = (path, opts, env) =>
  mod.default.fetch(new Request('https://bot.example' + path, opts), env || ENV, ctx);
const jpost = (path, body, token, env) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
}, env);
const get = (path, token, env) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} }, env);

// The throttle counts every failure from this address, and a test makes
// a lot of them on purpose. Sections that have to succeed start clean;
// the throttle gets a section of its own at the end.
const clearThrottle = () => raw.exec('DELETE FROM console_attempts');
// A code is refused once its step has been used, so the code after the
// one just spent is the next one that can open anything. The worker
// takes one step either side of now, so this is live already.
const nextCode = (secret) => totpAt(secret, Math.floor(Date.now() / 30000) + 1);

// ---------------- the arithmetic ----------------
// RFC 6238 Appendix B: the ASCII secret "12345678901234567890" is
// base32 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ, and at T = 59 seconds
// (step 1) SHA-1 gives 287082.
check('the code matches the published RFC 6238 vector',
  totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1) === '287082',
  totpAt('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1));

// ---------------- enrolment ----------------
let r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex' });
const enrol = await r.json();
check('a name nobody has used is handed a secret and no session',
  r.status === 200 && !enrol.session && !!enrol.secret &&
  enrol.otpauth.includes('otpauth://totp/') && enrol.qr.startsWith('data:image/svg+xml;base64,'),
  JSON.stringify({ session: !!enrol.session }));
const secret = enrol.secret.replace(/\s/g, '');

r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex' });
const again = await r.json();
check('asking again mid-enrolment hands back the same secret, not a new one',
  again.secret.replace(/\s/g, '') === secret, '');

r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: '000000' });
check('a wrong code opens nothing, even mid-enrolment',
  r.status === 401 && !(await r.json()).session, 'status=' + r.status);

r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: totpNow(secret) });
const opened = await r.json();
check('the first right code confirms the enrolment and opens a session',
  r.status === 200 && /^[A-Za-z0-9_-]{20,}$/.test(opened.session || ''), '');
check('and prints ten backup codes, once',
  Array.isArray(opened.backup_codes) && opened.backup_codes.length === 10 &&
  new Set(opened.backup_codes).size === 10, JSON.stringify(opened.backup_codes || []));
const backup = opened.backup_codes;
const sess = opened.session;

// ---------------- what the password alone does not do ----------------
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex' });
const bare = await r.json();
check('the password alone no longer opens a session for an enrolled name',
  r.status === 401 && !bare.session && bare.needs_code === true, 'status=' + r.status);

// ---------------- replay ----------------
// A code lasts thirty seconds, so somebody reading one over a shoulder
// has the rest of that window. The step it belonged to is stored, and
// the same code is refused after it has been used. The enrolment above
// already spent this step, which is why the next one is what opens
// anything at all.
clearThrottle();
const used = nextCode(secret);
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: used });
check('a fresh code opens a session', r.status === 200 && !!(await r.json()).session, 'status=' + r.status);
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: used });
check('the same code a second time does not', r.status === 401, 'status=' + r.status);
// and sent twice at the same moment, it opens one session between them
raw.prepare("UPDATE console_users SET last_step = 0 WHERE name = 'Alex'").run();
clearThrottle();
const pair = await Promise.all([1, 2].map(() => jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: used })));
const opens = (await Promise.all(pair.map(x => x.json()))).filter(x => x.session).length;
check('the same code sent twice at once opens one session, not two', opens === 1, String(opens));

// ---------------- backup codes ----------------
clearThrottle();
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: backup[0] });
const viaBackup = await r.json();
check('a printed code stands in for the app',
  r.status === 200 && !!viaBackup.session && viaBackup.used_backup === true &&
  viaBackup.backup_left === 9, JSON.stringify({ left: viaBackup.backup_left }));
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: backup[0] });
check('and is spent: the same one never works twice', r.status === 401, 'status=' + r.status);
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: backup[1].toLowerCase().replace('-', ' ') });
check('a printed code is read the way it is typed, not the way it is stored',
  r.status === 200 && !!(await r.json()).session, 'status=' + r.status);

// ---------------- accounts an admin makes ----------------
// Once anybody has signed in, the shared password makes nobody new: an
// admin makes each account, with a password of its own.
clearThrottle();
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Sam' });
const stranger = await r.json();
check('once somebody has signed in, a new name gets nothing from the shared password',
  r.status === 401 && !stranger.secret && !stranger.session, 'status=' + r.status);

r = await jpost('/api/console/accounts/save',
  { create: true, name: 'Sam', password: 'short', perms: ['review'], require_2fa: true }, sess);
check('a password under ten characters is refused', r.status === 400, 'status=' + r.status);
r = await jpost('/api/console/accounts/save',
  { create: true, name: 'Sam', password: 'sam-password', perms: ['review'], require_2fa: true }, sess);
check('an admin makes an account with its own password and its tabs',
  r.status === 200 && (await r.json()).users.some(u => u.name === 'Sam' && u.perms.join() === 'review' && !u.admin),
  'status=' + r.status);
r = await jpost('/api/console/accounts/save',
  { create: true, name: 'sam', password: 'sam-password', perms: ['review'] }, sess);
check('and a second account under the same name in other capitals is refused', r.status === 409, 'status=' + r.status);

clearThrottle();
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Sam' });
check('an account with its own password does not open with the shared one', r.status === 401, 'status=' + r.status);
const sam = await consoleSignIn(jpost, 'sam', 'sam-password');
check('it sets its code up on the spot at its first sign-in, on its own secret, whatever the capitals',
  !!sam.session && sam.name === 'Sam' && sam.secret !== enrol.secret && Array.isArray(sam.backup_codes), '');
r = await jpost('/api/console/login', { password: 'sam-password', name: 'Sam', code: totpNow(secret) });
check("and Alex's code does not open Sam's session", r.status === 401, 'status=' + r.status);

// ---------------- what an account may do ----------------
r = await get('/api/console/me', sam.session);
const samMe = await r.json();
check('the page is told which tabs the account has',
  samMe.ok && samMe.admin === false && samMe.perms.join() === 'review' && samMe.code === true, JSON.stringify(samMe));
const samCan = {};
for (const [label, path] of [['review', '/api/console/submissions'], ['log', '/api/console/log'],
  ['accounts', '/api/console/accounts'], ['scores', '/api/console/board'], ['overview', '/api/console/overview']]) {
  samCan[label] = (await get(path, sam.session)).status;
}
r = await jpost('/api/console/ledger/adjust', { team_id: 1, code: 'MQ1', points: 10, reason: 'A test' }, sam.session);
samCan.write = r.status;
check('every request is checked against the tabs: its own open, the rest 403, the shared reads open',
  samCan.review === 200 && samCan.log === 403 && samCan.accounts === 403 && samCan.scores === 403 &&
  samCan.overview === 200 && samCan.write === 403, JSON.stringify(samCan));
r = await jpost('/api/console/accounts/save',
  { create: true, name: 'Mallory', password: 'mallory-password', admin: true }, sam.session);
check('and only an admin makes accounts', r.status === 403, 'status=' + r.status);

// the switch that stops every email is on the Settings tab; the Email
// tab learns of it from its own read and cannot turn it back on
clearThrottle();
for (const [name, perms] of [['Kit', ['settings']], ['Lou', ['email']]]) {
  await jpost('/api/console/accounts/save', { create: true, name, password: name.toLowerCase() + '-password', perms, require_2fa: false }, sess);
}
const kit = (await (await jpost('/api/console/login', { password: 'kit-password', name: 'Kit' })).json()).session;
const lou = (await (await jpost('/api/console/login', { password: 'lou-password', name: 'Lou' })).json()).session;
const mailSwitch = { kitSet: await (await jpost('/api/console/email/hold', { held: true }, kit)).json() };
mailSwitch.kitRead = await (await get('/api/console/email/hold', kit)).json();
mailSwitch.louRead = (await get('/api/console/email/hold', lou)).status;
mailSwitch.louSet = (await jpost('/api/console/email/hold', { held: false }, lou)).status;
mailSwitch.louTab = await (await get('/api/console/announce', lou)).json();
mailSwitch.samSet = (await jpost('/api/console/email/hold', { held: false }, sam.session)).status;
mailSwitch.adminSet = await (await jpost('/api/console/email/hold', { held: false }, sess)).json();
check('the switch that stops every email is read and set with the Settings tab or as an admin, and no other tab',
  mailSwitch.kitSet.ok && mailSwitch.kitSet.held === true && mailSwitch.kitRead.held === true &&
  mailSwitch.louRead === 403 && mailSwitch.louSet === 403 && mailSwitch.louTab.ok && mailSwitch.louTab.email_off === true &&
  mailSwitch.samSet === 403 && mailSwitch.adminSet.ok && mailSwitch.adminSet.held === false &&
  raw.prepare("SELECT value FROM site_flags WHERE name = 'email_held'").get().value === 0,
  JSON.stringify(Object.assign({}, mailSwitch, { louTab: mailSwitch.louTab.email_off })));

// an account without the code: the password is the whole sign-in
clearThrottle();
await jpost('/api/console/accounts/save',
  { create: true, name: 'Robin', password: 'robin-password', perms: ['messages'], require_2fa: false }, sess);
r = await jpost('/api/console/login', { password: 'robin-password', name: 'Robin' });
const robin = await r.json();
check('an account that does not need a code opens on its password alone',
  r.status === 200 && !!robin.session && !robin.secret, 'status=' + r.status);
await jpost('/api/console/accounts/save', { name: 'Robin', perms: ['log'], require_2fa: false }, sess);
const robinNow = [(await get('/api/console/log', robin.session)).status,
  (await get('/api/console/messages/list', robin.session)).status];
check('a change to its tabs holds from its next request', robinNow.join() === '200,403', robinNow.join());
// a desk's previews read a photo and then its details: both are open to it
await jpost('/api/console/accounts/save', { name: 'Robin', perms: ['points'], require_2fa: false }, sess);
const deskReads = [(await get('/api/console/file?key=sub%2Fnothing', robin.session)).status,
  (await get('/api/console/file/meta?key=sub%2Fnothing', robin.session)).status];
check('a desk account may read a photo\'s details as well as the photo', deskReads.every(s => s !== 403), deskReads.join());
await jpost('/api/console/accounts/save', { name: 'Robin', password: 'robin-password-2', perms: ['log'] }, sess);
check('a new password signs it out', (await get('/api/console/me', robin.session)).status === 401, '');
r = await jpost('/api/console/accounts/save', { name: 'Alex', perms: ['log'] }, sess);
check('the last admin cannot stop being one', r.status === 400, 'status=' + r.status);
r = await jpost('/api/console/accounts/delete', { name: 'Alex' }, sess);
check('nobody deletes their own account', r.status === 400, 'status=' + r.status);
r = await jpost('/api/console/accounts/delete', { name: 'Robin' }, sess);
clearThrottle();
const gone = await jpost('/api/console/login', { password: 'robin-password-2', name: 'Robin' });
check('a deleted account cannot sign in', r.status === 200 && gone.status === 401, 'status=' + gone.status);

// an account from before accounts, with no code: the shared password is
// all that stands in front of its secret, so it gets none
raw.exec("INSERT INTO console_users (name, secret) VALUES ('Old', 'JBSWY3DPEHPK3PXP')");
clearThrottle();
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Old' });
const old = await r.json();
check('an older account with no code and no password of its own is not handed a secret',
  r.status === 403 && !old.secret && !old.session, 'status=' + r.status);
raw.exec("DELETE FROM console_users WHERE name = 'Old'");

// ---------------- resets ----------------
clearThrottle();
r = await jpost('/api/console/auth/reset', { name: 'Alex' }, sess);
check('nobody resets themselves', r.status === 400, 'status=' + r.status);
r = await jpost('/api/console/auth/reset', { name: 'Alex' }, sam.session);
check('and only an admin resets anybody', r.status === 403, 'status=' + r.status);
r = await jpost('/api/console/auth/reset', { name: 'Sam' }, sess);
check('an admin can, for a phone that is gone', r.status === 200, 'status=' + r.status);
check('which signs them out', (await get('/api/console/me', sam.session)).status === 401, '');
r = await jpost('/api/console/login', { password: 'sam-password', name: 'Sam', code: totpNow(sam.secret.replace(/\s/g, '')) });
check('after a reset the old secret is worthless', r.status === 401 && !(await r.json()).session, 'status=' + r.status);
r = await jpost('/api/console/login', { password: 'sam-password', name: 'Sam' });
const afterReset = await r.json();
check('and setting a code up starts again, on a new secret',
  !afterReset.session && !!afterReset.secret && afterReset.secret !== sam.secret, JSON.stringify({ session: !!afterReset.session }));

// ---------------- the Accounts tab reads ----------------
// A known mix to read back: one refused code and one that works. The
// step used above is spent and the clock has not moved on within a test
// run, so this stands in for the half-minute that would have passed.
clearThrottle();
raw.exec("UPDATE console_users SET last_step = 0 WHERE name = 'Alex'");
await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: '000000' });
await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: nextCode(secret) });
r = await get('/api/console/accounts', sess);
const view = await r.json();
check('the card lists who is enrolled, with codes left and when they were last seen',
  r.status === 200 && view.users.some(u => u.name === 'Alex' && u.confirmed_at && u.codes_left === 8 && u.last_seen),
  JSON.stringify(view.users));
check('and the attempts, newest first, with the outcome and an address hash',
  view.attempts.length >= 2 && /^ip:[0-9a-f]{8}$/.test(view.attempts[0].ip) &&
  view.attempts[0].outcome === 'ok' && view.attempts.some(a => a.outcome === 'bad-code'),
  JSON.stringify(view.attempts.slice(0, 3)));
check('nothing in it is the secret or a code',
  !JSON.stringify(view).includes(secret) && !backup.some(c => JSON.stringify(view).includes(c)), '');
r = await get('/api/console/accounts');
check('and none of it without a session', r.status === 401, 'status=' + r.status);

clearThrottle();
r = await jpost('/api/console/auth/backup', {}, sess);
const fresh = await r.json();
check('new printed codes can be made, and replace the old ones',
  r.status === 200 && fresh.backup_codes.length === 10 && !fresh.backup_codes.includes(backup[2]), '');
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: backup[2] });
check('so an unused old one stops working', r.status === 401, 'status=' + r.status);

// ---------------- the throttle ----------------
// Per address, not worker-wide: a lock everybody shares is a lock any
// stranger who finds the dashboard can put on the committee.
clearThrottle();
for (let i = 0; i < 3; i++) {
  await jpost('/api/console/login', { password: 'nope', name: 'Mallory' });
}
r = await jpost('/api/console/login', { password: 'nope', name: 'Mallory' });
const held = await r.json();
check('a run of wrong passwords from one address starts costing time',
  r.status === 429 && held.retry_after > 0, 'status=' + r.status + ' after=' + held.retry_after);
// A turned-away request is not itself a guess, so reading the wait
// twice does not extend it.
r = await jpost('/api/console/login', { password: 'nope', name: 'Mallory' });
const same = await r.json();
check('reading the wait again does not make it longer',
  same.retry_after <= held.retry_after, held.retry_after + 's then ' + same.retry_after + 's');
// More guesses do. They have to get past the hold to count, which is
// what a run of them looks like from the far side of a slow script.
raw.exec("UPDATE console_attempts SET at = datetime('now', '-60 seconds')");
for (let i = 0; i < 4; i++) {
  await jpost('/api/console/login', { password: 'nope', name: 'Mallory' });
  raw.exec("UPDATE console_attempts SET at = datetime('now', '-60 seconds')");
}
r = await jpost('/api/console/login', { password: 'nope', name: 'Mallory' });
const longer = await r.json();
check('and the wait grows with the run',
  r.status === 429 && longer.retry_after > held.retry_after,
  held.retry_after + 's then ' + longer.retry_after + 's');
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: nextCode(secret) });
check('the right password does not get past it either — the address is what is held',
  r.status === 429, 'status=' + r.status);

// ---------------- the second password ----------------
// A password apart from the sign-in, asked for by the actions an admin
// ticks. It travels in a header, and a wrong one is a 403, never a 401,
// because the page signs out on a 401.
clearThrottle();
const SECOND = { DB: db, CONSOLE_PASSWORD: 'tab-pass', PUSH_PASSWORD: 'second-pass' };
const withSecond = (pass) => ({ authorization: 'Bearer ' + sess, 'x-second-password': pass });
r = await jpost('/api/console/guards/set', { key: 'export', on: true }, sess, ENV);
check('an action cannot be made to ask for a second password the worker does not have',
  r.status === 400, 'status=' + r.status);
r = await jpost('/api/console/guards/set', { key: 'export', on: true }, sess, SECOND);
const unasked = await r.json();
check('changing which actions ask for it asks for it too',
  r.status === 403 && unasked.second_password === true, JSON.stringify(unasked));
r = await front('/api/console/guards/set', { method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, withSecond('second-pass')),
  body: JSON.stringify({ key: 'export', on: true }) }, SECOND);
check('and with it the switch goes on',
  r.status === 200 && (await r.json()).guards.some(g => g.key === 'export' && g.on), 'status=' + r.status);

r = await get('/api/console/export/all', sess, SECOND);
const asked = await r.json();
check('a ticked action is refused without it, saying what asked',
  r.status === 403 && asked.second_password === true && asked.wrong === false && /Exporting/.test(asked.what), JSON.stringify(asked));
r = await front('/api/console/export/all', { headers: withSecond('nope') }, SECOND);
check('a wrong one is refused and says so, and the session stays',
  r.status === 403 && (await r.json()).wrong === true && (await get('/api/console/me', sess, SECOND)).status === 200, '');
r = await front('/api/console/export/all', { headers: withSecond('second-pass') }, SECOND);
check('the right one lets it through', r.status === 200 && !!(await r.json()).tables, 'status=' + r.status);
r = await get('/api/console/export/all', sess, ENV);
check('a ticked action with no second password on the worker stays locked',
  r.status === 403 && /PUSH_PASSWORD/.test((await r.json()).error), 'status=' + r.status);

// ---------------- Cloudflare's human check ----------------
// It is on the sign-in, and it has to pass once anything from this
// address has been refused. A first, correct sign-in never depends on
// it: the way it fails for an organiser is a venue that cannot reach
// challenges.cloudflare.com, and that must not be able to keep the
// committee out on the morning of the event.
clearThrottle();
raw.exec("UPDATE console_users SET last_step = 0 WHERE name = 'Alex'");
const HUMAN = { DB: db, CONSOLE_PASSWORD: 'tab-pass', TURNSTILE_SITE_KEY: 'site-key', TURNSTILE_SECRET: 'secret' };
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: nextCode(secret) }, null, HUMAN);
check('a clean address signs in with no token at all',
  r.status === 200 && !!(await r.json()).session, 'status=' + r.status);

clearThrottle();
await jpost('/api/console/login', { password: 'nope', name: 'Alex' }, null, HUMAN);
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: '000000' }, null, HUMAN);
const noToken = await r.json();
check('after a refusal, the next try without a token is turned away',
  r.status === 403 && noToken.needs_turnstile === true && !noToken.session, 'status=' + r.status);

raw.exec("UPDATE console_users SET last_step = 0 WHERE name = 'Alex'");
verdict = 'fail';
r = await jpost('/api/console/login',
  { password: 'tab-pass', name: 'Alex', code: nextCode(secret), turnstile: 'nope' }, null, HUMAN);
check('and a token Cloudflare rejects is no better', r.status === 403, 'status=' + r.status);

verdict = 'pass';
r = await jpost('/api/console/login',
  { password: 'tab-pass', name: 'Alex', code: nextCode(secret), turnstile: 'good' }, null, HUMAN);
check('a token it accepts gets through', r.status === 200 && !!(await r.json()).session, 'status=' + r.status);

clearThrottle();
await jpost('/api/console/login', { password: 'nope', name: 'Alex' }, null, HUMAN);
raw.exec("UPDATE console_users SET last_step = 0 WHERE name = 'Alex'");
verdict = 'down';
r = await jpost('/api/console/login',
  { password: 'tab-pass', name: 'Alex', code: nextCode(secret), turnstile: 'good' }, null, HUMAN);
check('and siteverify being unreachable lets a real sign-in through rather than locking the day',
  r.status === 200 && !!(await r.json()).session, 'status=' + r.status);
verdict = 'pass';

// A failed check is recorded, but it does not add to the wait: the way
// it fails for an organiser is a widget that will not load, and
// compounding that into a lockout is the opposite of the point.
clearThrottle();
await jpost('/api/console/login', { password: 'nope', name: 'Alex' }, null, HUMAN);
for (let i = 0; i < 6; i++) {
  await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: '000000' }, null, HUMAN);
}
raw.exec("UPDATE console_users SET last_step = 0 WHERE name = 'Alex'");
r = await jpost('/api/console/login',
  { password: 'tab-pass', name: 'Alex', code: nextCode(secret), turnstile: 'good' }, null, HUMAN);
check('a run of failed checks does not throttle the address',
  r.status === 200 && !!(await r.json()).session, 'status=' + r.status);

r = await get('/api/console/accounts', sess, HUMAN);
const humanView = await r.json();
check('the card says the check is on, and shows the refusals',
  humanView.human_check === true && humanView.attempts.some(a => a.outcome === 'bad-human'), '');

// Unset secrets stand the whole thing down.
clearThrottle();
await jpost('/api/console/login', { password: 'nope', name: 'Alex' });
raw.exec("UPDATE console_users SET last_step = 0 WHERE name = 'Alex'");
r = await jpost('/api/console/login', { password: 'tab-pass', name: 'Alex', code: nextCode(secret) });
check('with no Turnstile secrets there is no check to pass',
  r.status === 200 && !!(await r.json()).session, 'status=' + r.status);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures ? 1 : 0);
