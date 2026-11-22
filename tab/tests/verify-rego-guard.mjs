// Run with: node tests/verify-rego-guard.mjs
// The sign-up guard on the public registration endpoint, worker side:
// the status read, the dashboard's closed switch and people cap, the
// Turnstile human check, the per-IP and hourly rate limits, the
// Discord alerts they raise, and the confirmation-email caps that
// apply to the public form but not to the dashboard's own team add.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let fail = 0;
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) fail++;
};

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);

globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };

// Everything the worker sends out, by destination. Reset between
// sections so a count means what it says.
const calls = { siteverify: [], resend: [], discord: [] };
const resetCalls = () => { calls.siteverify.length = 0; calls.resend.length = 0; calls.discord.length = 0; };
let siteverifyThrows = false;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  init = init || {};
  let body = null;
  try { body = init.body ? JSON.parse(init.body) : null; } catch (err) { /* not JSON */ }
  if (url.indexOf('https://challenges.cloudflare.com/turnstile/v0/siteverify') === 0) {
    calls.siteverify.push(body);
    // Cloudflare unreachable is a real case: the form must not lock
    if (siteverifyThrows) throw new Error('siteverify unreachable');
    return Response.json({ success: !!(body && body.response === 'good-token') });
  }
  if (url.indexOf('https://api.resend.com/') === 0) {
    calls.resend.push({ auth: (init.headers || {}).authorization, body });
    return Response.json({ id: 'x' });
  }
  if (url.indexOf('https://discord.com/api') === 0) {
    calls.discord.push({ path: url.replace(/^https:\/\/discord\.com\/api\/v\d+/, ''), body });
    return Response.json({});
  }
  return new Response('not found', { status: 404 });
};

const mod = await import(BOT + '/src/index.ts');
// Check-in and the sheet stay unconfigured, so no QR is minted and no
// row is pushed; email is switched on in the email section.
const ENV = { DB: db, CONSOLE_PASSWORD: 'tab-pass' };
const waits = [];
const ctx = { waitUntil(p) { waits.push(p); } };
const settle = () => Promise.all(waits.splice(0));

let ipn = 0;
// a fresh address for each signup, so one section's traffic never
// spends another's per-IP allowance
const nextIp = () => { ipn += 1; return '10.' + Math.floor(ipn / 250) + '.' + (ipn % 250) + '.1'; };

const front = (path, opts, ip) => {
  opts = opts || {};
  opts.headers = Object.assign({ 'cf-connecting-ip': ip || nextIp() }, opts.headers || {});
  return mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, ctx);
};
const jpost = (path, body, token, ip) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
}, ip);
const get = (path, token, ip) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} }, ip);
const session = (await consoleSignIn(jpost, 'Tab', 'tab-pass')).session;

let peoplen = 0;
let zidn = 5100000;
let teamn = 0;
const member = (over) => {
  peoplen += 1;
  zidn += 1;
  return Object.assign({
    name: 'Person ' + peoplen, zid: 'z' + zidn, email: 'p' + peoplen + '@example.com',
    discord: 'someone', arc: true, dietary: '', agreed: true
  }, over || {});
};
// a team is three to five people on the public form, so a signup
// naming fewer is filled out to three with people of its own
const signup = (over) => {
  teamn += 1;
  const body = Object.assign({
    team_name: 'Team ' + teamn, societies: [], questions: '', website: '',
    photo_permission: true, members: []
  }, over || {});
  while (body.members.length < 3) body.members.push(member());
  return body;
};
// one signup, its background work finished before anything is asserted
const create = async (body, ip) => {
  const r = await jpost('/api/rego/create', body || signup(), null, ip);
  const d = await r.json();
  await settle();
  return { status: r.status, data: d };
};
const settings = async () => (await (await get('/api/console/rego/settings', session)).json());
const setSettings = (body) => jpost('/api/console/rego/settings/set', body, session);
// the hourly windows are what the guard counts in, so pushing the
// existing rows back an hour empties them without deleting anything
const ageSignups = () => db.prepare("UPDATE registrations SET submitted_at = datetime('now', '-3 hours')").run();
const setAlerted = (value) => db.prepare(
  "INSERT INTO site_flags (name, value) VALUES ('rego_alerted', ?1) ON CONFLICT(name) DO UPDATE SET value = ?1"
).bind(value).run();

// ---------------- the form is open until something closes it ----------------
let r = await get('/api/rego/status');
let d = await r.json();
check('the status read says the form is open, with no-store and open CORS',
  r.status === 200 && d.ok === true && d.open === true && d.message === '' && d.turnstile === '' &&
  r.headers.get('cache-control') === 'no-store' && r.headers.get('access-control-allow-origin') === '*',
  JSON.stringify(d));

// ---------------- the dashboard's own view of the guard ----------------
r = await get('/api/console/rego/settings');
check('the settings read needs a dashboard session', r.status === 401, 'status=' + r.status);
const seeded = (await db.prepare(
  'SELECT COUNT(*) AS n FROM participants p LEFT JOIN teams t ON t.id = p.team_id WHERE COALESCE(t.hidden, 0) = 0'
).first()).n;
d = await settings();
check('with one it reads the switch, the cap, the count and whether the human check is on',
  d.ok === true && d.closed === false && d.cap === 0 && d.people === seeded && d.turnstile === false, JSON.stringify(d));
r = await jpost('/api/console/rego/settings/set', { closed: false, cap: 0 });
check('changing the settings needs a session too', r.status === 401, 'status=' + r.status);
r = await setSettings({ closed: false, cap: -1 });
check('a negative cap is refused', r.status === 400, 'status=' + r.status);
r = await setSettings({ closed: false, cap: 1.5 });
check('so is a fraction of a person', r.status === 400, 'status=' + r.status);

// ---------------- closed by hand ----------------
r = await setSettings({ closed: true, cap: 0 });
d = await r.json();
check('an organiser can close the form', r.status === 200 && d.ok === true && d.closed === true, JSON.stringify(d));
ENV.TURNSTILE_SITE_KEY = 'site-key';
ENV.TURNSTILE_SECRET = 'turnstile-secret';
d = await (await get('/api/rego/status')).json();
check('the status read says why, and hands out no site key while it is closed',
  d.ok === true && d.open === false && d.message === 'Registrations are closed.' && d.turnstile === '', JSON.stringify(d));
delete ENV.TURNSTILE_SITE_KEY;
delete ENV.TURNSTILE_SECRET;
let out = await create();
check('a signup is turned away with a readable reason',
  out.status === 403 && /closed/.test(out.data.error || ''), JSON.stringify(out));
const logged = await db.prepare("SELECT action, team_name FROM submission_log WHERE action = 'rego-settings' ORDER BY id DESC LIMIT 1").first();
check('the flip is in the log', !!logged && /closed/.test(logged.team_name || ''), JSON.stringify(logged));
await setSettings({ closed: false, cap: 0 });
d = await (await get('/api/rego/status')).json();
check('and reopening lets signups through again', d.open === true && d.message === '', JSON.stringify(d));

// ---------------- the cap closes the form on its own ----------------
let people = (await settings()).people;
await setSettings({ closed: false, cap: people + 2 });
out = await create();
check('a team of three is turned away with two places left, the whole team counted, not its first person',
  out.status === 403 && /2 places left and this team has 3 people/.test(out.data.error || '') && (await settings()).people === people,
  JSON.stringify(out));
await setSettings({ closed: false, cap: people + 3 });
d = await (await get('/api/rego/status')).json();
check('three spots short of the cap the form is still open', d.open === true, JSON.stringify(d));
out = await create();
check('the team that takes the last three spots is accepted', out.status === 200 && out.data.ok === true, JSON.stringify(out));
d = await (await get('/api/rego/status')).json();
check('the cap closes the form behind it',
  d.open === false && d.message === 'Registrations are full.', JSON.stringify(d));
out = await create();
check('the next signup is turned away as full',
  out.status === 403 && /full/.test(out.data.error || ''), JSON.stringify(out));

const lastTeam = await db.prepare('SELECT id FROM teams ORDER BY id DESC LIMIT 1').first();
await db.prepare('UPDATE teams SET hidden = 1 WHERE id = ?1').bind(lastTeam.id).run();
const hiddenPeople = (await settings()).people;
check('a hidden team takes no spots, so the count drops back', hiddenPeople === people, 'people=' + hiddenPeople);
await db.prepare('UPDATE teams SET hidden = 0 WHERE id = ?1').bind(lastTeam.id).run();
await setSettings({ closed: false, cap: 0 });

// ---------------- the human check ----------------
ENV.TURNSTILE_SITE_KEY = 'site-key';
ENV.TURNSTILE_SECRET = 'turnstile-secret';
resetCalls();
d = await (await get('/api/rego/status')).json();
check('with both keys set the status read hands the page the site key',
  d.open === true && d.turnstile === 'site-key', JSON.stringify(d));
check('and the dashboard says the check is on', (await settings()).turnstile === true);
out = await create();
check('a signup with no token is refused in words a person can act on, without asking Cloudflare',
  out.status === 403 && /person/.test(out.data.error || '') && calls.siteverify.length === 0, JSON.stringify(out));
out = await create(signup({ turnstile: 'bad' }));
check('a token Cloudflare rejects is refused', out.status === 403, JSON.stringify(out));
check('and the secret and the token both reached Cloudflare',
  calls.siteverify.length === 1 && calls.siteverify[0].secret === 'turnstile-secret' && calls.siteverify[0].response === 'bad',
  JSON.stringify(calls.siteverify));
out = await create(signup({ turnstile: 'good-token' }));
check('a token it accepts goes through', out.status === 200 && out.data.ok === true, JSON.stringify(out));
siteverifyThrows = true;
out = await create(signup({ turnstile: 'anything' }));
check('with Cloudflare unreachable the form fails open rather than locking',
  out.status === 200 && out.data.ok === true, JSON.stringify(out));
siteverifyThrows = false;
delete ENV.TURNSTILE_SITE_KEY;
delete ENV.TURNSTILE_SECRET;
resetCalls();
out = await create();
check('with the keys unset nothing is asked of Cloudflare at all',
  out.status === 200 && calls.siteverify.length === 0, JSON.stringify({ out, asked: calls.siteverify.length }));
check('and the status read hands out no site key', (await (await get('/api/rego/status')).json()).turnstile === '');

// ---------------- rate limits ----------------
const oneIp = '203.0.113.42';
for (let i = 0; i < 4; i++) {
  out = await create(signup(), oneIp);
  check('signup ' + (i + 1) + ' of four from one connection lands', out.status === 200 && out.data.ok === true, JSON.stringify(out));
}
out = await create(signup(), oneIp);
check('the fifth in the hour from that connection is refused',
  out.status === 429 && /connection/.test(out.data.error || ''), JSON.stringify(out));

let inHour = (await db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE submitted_at > datetime('now', '-1 hour')").first()).n;
for (let i = inHour; i < 15; i++) {
  await db.prepare("INSERT INTO registrations (team_name, submitted_at) VALUES (?1, datetime('now'))").bind('Flood ' + i).run();
}
out = await create();
check('fifteen signups in an hour closes the form to everyone for the rest of it',
  out.status === 429 && /Too many signups right now/.test(out.data.error || ''), JSON.stringify(out));

// ---------------- telling the organisers ----------------
await db.prepare(
  "INSERT INTO discord_guilds (guild_id, name, organiser_role_id, enabled, announce_channel_id) VALUES ('900100', 'Test Server', '5', 1, '424242')"
).run();
ENV.DISCORD_BOT_TOKEN = 'bot-token';
resetCalls();
out = await create();
check('the hourly limit tripping puts one line in the announce channel',
  out.status === 429 && calls.discord.length === 1 && calls.discord[0].path === '/channels/424242/messages' &&
  /cap/.test(calls.discord[0].body.content) && /15/.test(calls.discord[0].body.content),
  JSON.stringify(calls.discord));
resetCalls();
out = await create();
check('tripping it again straight after says nothing more',
  out.status === 429 && calls.discord.length === 0, JSON.stringify(calls.discord));

await setAlerted(0);
await ageSignups();
people = (await settings()).people;
await setSettings({ closed: false, cap: people + 3 });
resetCalls();
out = await create();
check('the signup that fills the cap is accepted', out.status === 200 && out.data.ok === true, JSON.stringify(out));
check('and the organisers are told the form has closed itself',
  calls.discord.length === 1 && /cap/.test(calls.discord[0].body.content) && /closed itself/.test(calls.discord[0].body.content),
  JSON.stringify(calls.discord));

await setAlerted(0);
delete ENV.DISCORD_BOT_TOKEN;
resetCalls();
out = await create();
const alerted = await db.prepare("SELECT value FROM site_flags WHERE name = 'rego_alerted'").first();
check('without a bot token no alert is sent and the once-an-hour gate is left unspent',
  out.status === 403 && calls.discord.length === 0 && Number(alerted.value) === 0,
  JSON.stringify({ discord: calls.discord.length, alerted }));
await setSettings({ closed: false, cap: 0 });

// ---------------- the confirmation emails the public form may send ----------------
ENV.EMAIL_API_KEY = 're_test';
await ageSignups();
const statusOf = async (email) => (await db.prepare(
  'SELECT email_status FROM participants WHERE email = ?1 ORDER BY id'
).bind(email).all()).results.map(x => x.email_status);

resetCalls();
out = await create(signup({ members: [member({ email: 'first@example.com' })] }));
check('an ordinary signup sends its confirmations',
  out.status === 200 && out.data.emails === 3 && (await statusOf('first@example.com')).join() === 'sent' &&
  calls.resend.length === 3 && calls.resend[0].auth === 'Bearer re_test' && calls.resend[0].body.to[0] === 'first@example.com',
  JSON.stringify({ data: out.data, sent: calls.resend.length }));

// three confirmations already sent to one address today
const busy = 'busy@example.com';
const busyReg = await db.prepare("INSERT INTO registrations (team_name, submitted_at) VALUES ('Busy Inbox', datetime('now'))").run();
for (let i = 0; i < 3; i++) {
  await db.prepare(
    "INSERT INTO participants (registration_id, position, name, zid, email, email_status) VALUES (?1, ?2, ?3, 'z0000000', ?4, 'sent')"
  ).bind(busyReg.meta.last_row_id, i + 1, 'Busy ' + i, busy).run();
}
const mixed = signup({ members: [member({ email: busy }), member({ email: 'fresh@example.com' })] });
out = await create(mixed);
const shape = out.data;
check('a signup naming the saturated address has that one email skipped, the fresh ones still sent',
  out.status === 200 && out.data.emails === 2 &&
  (await statusOf(busy)).slice(3).join() === 'skipped' && (await statusOf('fresh@example.com')).join() === 'sent',
  JSON.stringify({ data: out.data, busy: await statusOf(busy) }));

const twin = 'twin@example.com';
out = await create(signup({ members: [
  member({ email: twin }), member({ email: twin, zid: 'z0000000' }),
  member({ email: twin, zid: 'z0000000' }), member({ email: twin, zid: 'z0000000' })
] }));
check('one signup listing the same address four times counts them against each other',
  out.status === 200 && out.data.emails === 3 && (await statusOf(twin)).join() === 'sent,sent,sent,skipped',
  JSON.stringify({ data: out.data, twin: await statusOf(twin) }));

// the hour's ceiling, whatever addresses they went to
const bulkReg = await db.prepare("INSERT INTO registrations (team_name, submitted_at) VALUES ('Bulk Hour', datetime('now'))").run();
for (let i = 0; i < 60; i++) {
  await db.prepare(
    "INSERT INTO participants (registration_id, position, name, zid, email, email_status) VALUES (?1, ?2, ?3, 'z0000000', ?4, 'sent')"
  ).bind(bulkReg.meta.last_row_id, i + 1, 'Bulk ' + i, 'bulk' + i + '@example.com').run();
}
out = await create(signup({ members: [member({ email: 'late@example.com' })] }));
check('past sixty confirmations in an hour the form stops sending them',
  out.status === 200 && out.data.emails === 0 && (await statusOf('late@example.com')).join() === 'skipped', JSON.stringify(out));

r = await jpost('/api/console/rego/team/create', {
  team_name: 'Added By Hand', societies: [], questions: '', photo_permission: 1,
  members: [{ name: 'Console Person', zid: 'z0000000', email: busy, discord: 'someone', arc: 1, dietary: '' }]
}, session);
d = await r.json();
await settle();
check('the dashboard\'s own team add is not capped and sends anyway',
  r.status === 200 && d.ok === true && d.emails === 1 && (await statusOf(busy)).slice(4).join() === 'sent',
  JSON.stringify({ d, busy: await statusOf(busy) }));

// ---------------- what a successful signup answers ----------------
check('the success response is ok, team, whether it has one, members, emails, qrs and the signer\'s own terms link',
  Object.keys(shape).sort().join() === 'emails,members,ok,qrs,solo,team,terms_url' && shape.ok === true && shape.solo === false &&
  shape.team === mixed.team_name && shape.members === 3 && shape.emails === 2 && shape.qrs === 0 &&
  /^https:\/\/scs\.andyrew\.space\/terms\/\?k=[A-Za-z0-9_-]{24}$/.test(shape.terms_url), JSON.stringify(shape));

// ---------------- the rate limits are settings now ----------------
// They were written for signups that trickle in. Society signups spike,
// and past a limit real teams are turned away — so they are numbers the
// Rego tab can change rather than a deploy.
{
  d = await settings();
  check('the dashboard reads the four rate limits and what they ship as',
    d.limits && d.limits.rego_per_hour === 15 && d.limits.rego_per_ip_hour === 4 &&
    d.limits.rego_email_per_hour === 60 && d.limits.rego_email_per_day === 3 &&
    d.defaults.rego_per_hour === 15, JSON.stringify(d.limits));

  r = await setSettings({ closed: false, cap: 0, limits: { rego_per_hour: 0 } });
  check('zero is refused: a limit that reads as zero turns everybody away',
    r.status === 400, 'status=' + r.status);
  r = await setSettings({ closed: false, cap: 0, limits: { rego_per_hour: 12.5 } });
  check('and so is a fraction', r.status === 400, 'status=' + r.status);

  r = await setSettings({ closed: false, cap: 0, limits: { rego_per_hour: 60, rego_per_ip_hour: 20 } });
  d = await r.json();
  check('raising two of them keeps the other two where they were',
    r.status === 200 && d.limits.rego_per_hour === 60 && d.limits.rego_per_ip_hour === 20 &&
    d.limits.rego_email_per_hour === 60 && d.limits.rego_email_per_day === 3, JSON.stringify(d.limits));
  check('and the change says which numbers moved, in the log',
    /rego_per_hour 60/.test((await (await get('/api/console/log?limit=5', session)).json())
      .entries.filter(e => e.action === 'rego-settings')[0].team_name), '');

  const back = await settings();
  check('a limit nobody has touched still reads as the value the code ships with',
    back.limits.rego_email_per_day === back.defaults.rego_email_per_day, JSON.stringify(back.limits));
}

console.log(fail ? '\nFAILURES: ' + fail : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
