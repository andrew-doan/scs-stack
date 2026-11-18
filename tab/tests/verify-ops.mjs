// Run with: node tests/verify-ops.mjs   (needs Node 22+)
// The things that only matter on the day, end to end against the real
// worker: a team reading its own score sheet, why a submission was
// rejected reaching the team that sent it, two reviewers not landing on
// the same card, the warning before a team is credited twice, the board
// of numbers the dashboard opens on, a message written ahead of time
// publishing itself, a question that closes at a set time, and the one
// file that holds everything afterwards.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import crypto from 'node:crypto';

import { consoleSignIn } from './console-signin.mjs';
import { credit, uncredit } from './ledger-fixture.mjs';
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

// ---- R2 shim: enough for proof files ----
const bucket = new Map();
async function drain(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(0);
}
const SUBMIT = {
  async put(key, value, opts) {
    bucket.set(key, { bytes: await drain(value), meta: (opts && opts.httpMetadata) || {} });
  },
  async get(key) {
    const hit = bucket.get(key);
    return hit ? { body: hit.bytes, size: hit.bytes.length, httpMetadata: hit.meta } : null;
  },
  async delete(key) { bucket.delete(key); }
};

const purged = [];
globalThis.caches = { default: {
  async match() { return undefined; },
  async put() {},
  async delete(key) { purged.push(typeof key === 'string' ? key : key.url); return true; }
} };

// ---- VAPID keys, so a rejection push can be read back ----
const vapidPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const vapidJwk = vapidPair.publicKey.export({ format: 'jwk' });
const VAPID_PUBLIC = Buffer.concat([
  Buffer.from([4]), Buffer.from(vapidJwk.x, 'base64url'), Buffer.from(vapidJwk.y, 'base64url')
]).toString('base64url');
const VAPID_PRIVATE = vapidPair.privateKey.export({ format: 'jwk' }).d;

// ---- stand in for the push service and the check-in worker ----
const pushed = [];
let checkinUp = true;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://push.example/')) {
    pushed.push({ url, headers: init.headers, body: Buffer.from(init.body) });
    return new Response(null, { status: 201 });
  }
  if (url.startsWith('https://checkin.example/')) {
    if (!checkinUp) return new Response('down', { status: 503 });
    return new Response(JSON.stringify({
      ok: true, people: 12, people_checked_in: 7, teams: 3, teams_complete: 1,
      team_list: [], people_list: []
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return realFetch(input, init);
};

const mod = await import(BOT + '/src/index.ts');
const ENV = {
  DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass', PUSH_PASSWORD: 'push-pass',
  CHECKIN_API: 'https://checkin.example', CHECKIN_KEY: 'checkin-key',
  VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE,
  VAPID_SUBJECT: 'https://scs.example'
};
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); } };
const settle = () => Promise.all(pending.splice(0));
const front = (path, opts, env) => mod.default.fetch(new Request('https://bot.example' + path, opts), env || ENV, ctx);
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
const sess = (await consoleSignIn(jpost, 'Alex', 'tab-pass')).session;
// a second organiser, made by the first and setting a code up on their own password
await jpost('/api/console/accounts/save',
  { create: true, name: 'Sam', password: 'sam-password', admin: true, require_2fa: true }, sess);
const sess2 = (await consoleSignIn(jpost, 'Sam', 'sam-password')).session;

// a team, signed in to the submit page the way the site signs one in
await jpost('/api/console/codes/generate', {}, sess);
const codes = (await (await get('/api/console/codes', sess)).json()).codes;
const TEAM = 'Galahs';
const teamRow = raw.prepare('SELECT id FROM teams WHERE name = ?').get(TEAM);
const teamSess = (await (await jpost('/api/submit/login', {
  team_name: TEAM, code: codes.find(c => c.name === TEAM).code
})).json()).session;

// ---------------- a team's own score sheet ----------------
let r = await get('/api/submit/score');
check('the score sheet needs the team session', r.status === 401 && (await r.json()).error, 'status=' + r.status);
r = await get('/api/submit/score', 'not-a-session');
check('and a made-up one will not do', r.status === 401, 'status=' + r.status);

r = await get('/api/submit/score', teamSess);
let d = await r.json();
check('a signed-in team reads its own sheet, never cached, CORS open',
  r.status === 200 && d.ok && d.frozen === false && d.team === TEAM &&
  (r.headers.get('cache-control') || '').includes('no-store') &&
  r.headers.get('access-control-allow-origin') === '*', JSON.stringify({ ok: d.ok, team: d.team }));

// the same sums worked out here, from the rows, rather than by the code under test
const ownRows = raw.prepare(
  'SELECT c.quest_code AS code, c.amount, q.points FROM held c ' +
  'JOIN quests q ON q.code = c.quest_code WHERE c.team_id = ?'
).all(teamRow.id);
const expectTotal = Math.round(ownRows.reduce((n, x) => n + x.amount * x.points, 0) * 100) / 100;
check('the total is every entry it holds, amount times points',
  d.total === expectTotal && d.lines.length === ownRows.length,
  JSON.stringify({ got: d.total, expected: expectTotal, lines: d.lines.length, rows: ownRows.length }));

const byCode = {};
ownRows.forEach(x => { byCode[x.code] = x; });
check('every line carries its code, what it is worth and the quest it belongs to',
  d.lines.every(l => byCode[l.code] &&
    l.amount === byCode[l.code].amount && l.points === byCode[l.code].points &&
    l.worth === Math.round(byCode[l.code].amount * byCode[l.code].points * 100) / 100 &&
    typeof l.group_key === 'string' && l.group_key.length > 0 &&
    typeof l.name === 'string' && l.name.length > 0),
  JSON.stringify(d.lines[0]));
check('the biggest earner is first',
  d.lines.every((l, i) => i === 0 || d.lines[i - 1].worth >= l.worth), JSON.stringify(d.lines.map(l => l.worth)));
// a code with no quest group falls back to its own code for both
{
  raw.prepare("INSERT INTO quests (code, norm, points) VALUES ('LOOSE1', 'LOOSE1', 7)").run();
  credit(raw, teamRow.id, 'LOOSE1', 2);
  const sheet = await (await get('/api/submit/score', teamSess)).json();
  const loose = sheet.lines.find(l => l.code === 'LOOSE1');
  check('a code that belongs to no quest names itself',
    loose && loose.group_key === 'LOOSE1' && loose.name === 'LOOSE1' && loose.worth === 14,
    JSON.stringify(loose));
  raw.prepare("DELETE FROM entries WHERE code = 'LOOSE1'").run();
  raw.prepare("DELETE FROM quests WHERE code = 'LOOSE1'").run();
}

// the place, counted here from the teams and their entries
const visible = raw.prepare('SELECT id, name FROM teams WHERE hidden = 0').all().map(t => ({
  id: t.id,
  pts: raw.prepare(
    'SELECT COALESCE(SUM(c.amount * q.points), 0) AS p FROM held c ' +
    'JOIN quests q ON q.code = c.quest_code WHERE c.team_id = ?'
  ).get(t.id).p
}));
const mine = visible.find(t => t.id === teamRow.id);
const above = visible.filter(t => t.pts > mine.pts).length;
const level = visible.filter(t => t.pts === mine.pts).length;
d = await (await get('/api/submit/score', teamSess)).json();
check('the rank is that team\'s place among the visible teams',
  d.rank >= above + 1 && d.rank <= above + level && d.teams === visible.length,
  JSON.stringify({ rank: d.rank, above, level, teams: d.teams, visible: visible.length }));

// ---------------- what is waiting on a reviewer ----------------
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const file = (name, type, bytes) => new File([bytes], name, { type });
async function submit(quest, note) {
  const f = new FormData();
  f.append('quest', quest);
  f.append('note', note || '');
  f.append('files', file('proof.png', 'image/png', png), 'proof.png');
  const res = await front('/api/submit/create', {
    method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: f
  });
  return (await res.json()).id;
}
const subA = await submit('make 21', 'Both casinos');
const subB = await submit('make 21', 'Second try');
d = await (await get('/api/submit/score', teamSess)).json();
check('the sheet counts what is still waiting on review', d.pending === 2, JSON.stringify(d.pending));

// ---------------- a hidden team, and a frozen tab ----------------
raw.prepare('UPDATE teams SET hidden = 1 WHERE id = ?').run(teamRow.id);
d = await (await get('/api/submit/score', teamSess)).json();
check('a hidden team still reads its own sheet, with no place on the tab',
  d.ok && d.rank === null && d.total === expectTotal && d.lines.length === ownRows.length,
  JSON.stringify({ rank: d.rank, total: d.total }));
raw.prepare('UPDATE teams SET hidden = 0 WHERE id = ?').run(teamRow.id);

await jpost('/api/console/freeze', { frozen: true }, sess);
r = await get('/api/submit/score', teamSess);
d = await r.json();
check('while the tab is frozen the sheet says so and nothing else — a place is what the freeze hides',
  r.status === 200 && d.ok === true && d.frozen === true &&
  d.rank === undefined && d.total === undefined && d.lines === undefined && d.team === undefined,
  JSON.stringify(d));
await jpost('/api/console/freeze', { frozen: false }, sess);
d = await (await get('/api/submit/score', teamSess)).json();
check('and it comes back when the freeze lifts', d.frozen === false && d.rank !== null, JSON.stringify(d.rank));

// ---------------- a team that did not finish ----------------
// A board of its own, so the places can be read straight off it. Bravo
// and Echo do not finish: each stays where its points put it with no
// place, and the teams under it are ranked as if it were not there.
// Delta, Echo and Foxtrot are level; level teams take places in name
// order, as they always have.
{
  const dRaw = new DatabaseSync(':memory:');
  dRaw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
  const dDb = d1Shim(dRaw);
  const DENV = { DB: dDb, CONSOLE_PASSWORD: 'tab-pass' };
  const dPost = (path, body, token) => front(path, {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify(body)
  }, DENV);
  const dGet = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} }, DENV);
  dRaw.prepare("INSERT INTO quests (code, norm, points) VALUES ('DQ', 'DQ', 10)").run();
  const board = [['Alpha', 10], ['Bravo', 9], ['Charlie', 8], ['Delta', 7], ['Echo', 7], ['Foxtrot', 7], ['Golf', 6]];
  const ids = {};
  for (const [name, amount] of board) {
    ids[name] = Number(dRaw.prepare('INSERT INTO teams (name) VALUES (?)').run(name).lastInsertRowid);
    credit(dRaw, ids[name], 'DQ', amount);
    dRaw.prepare('INSERT INTO team_codes (team_id, code) VALUES (?, ?)').run(ids[name], 'code-' + name);
  }
  const dSess = (await consoleSignIn(dPost, 'Alex', 'tab-pass')).session;
  const sheetFor = async (name) => {
    const s = (await (await dPost('/api/submit/login', { team_name: name, code: 'code-' + name })).json()).session;
    return (await dGet('/api/submit/score', s)).json();
  };
  const say = async (name, opts) => mod.runCommand({ type: 2, data: { name, options: (opts || []).map(([n, v]) => ({ name: n, value: v, type: 3 })) } }, DENV);

  const one = await (await dPost('/api/console/teams/dnf', { id: ids.Bravo, dnf: true }, dSess)).json();
  const many = await (await dPost('/api/console/teams/dnf', { ids: [ids.Echo], dnf: true }, dSess)).json();
  let lb = await mod.apiResponse('/api/leaderboard', dDb);
  check('a team marked as not finishing keeps its spot in score order with no place, and the places skip it',
    one.ok && one.dnf === 1 && many.ok && many.count === 1 &&
    JSON.stringify(lb.teams.map(t => [t.name, t.rank, t.dnf, t.points])) === JSON.stringify([
      ['Alpha', 1, false, 100], ['Bravo', null, true, 90], ['Charlie', 2, false, 80], ['Delta', 3, false, 70],
      ['Echo', null, true, 70], ['Foxtrot', 4, false, 70], ['Golf', 5, false, 60]]),
    JSON.stringify(lb.teams.map(t => [t.name, t.rank, t.dnf])));

  const bravoSheet = await sheetFor('Bravo');
  const charlieSheet = await sheetFor('Charlie');
  const top = await say('leaderboard');
  const third = await say('leaderboard', [['place', '3']]);
  const bravoScore = await say('score', [['team', 'Bravo']]);
  const charlieScore = await say('score', [['team', 'Charlie']]);
  const overview = await (await dGet('/api/console/overview', dSess)).json();
  check('the score sheet, Discord and the dashboard agree with the leaderboard',
    bravoSheet.rank === null && bravoSheet.dnf === true && bravoSheet.total === 90 && bravoSheet.teams === 5 &&
    charlieSheet.rank === 2 && charlieSheet.dnf === false && charlieSheet.teams === 5 &&
    / -  Bravo\s+90\*\n/.test(top) && / 2\. Charlie\s+80\n/.test(top) && / 4\. Foxtrot/.test(top) &&
    top.endsWith('\n\\* Did not finish.') && /^\*\*Top 5\*\*/.test(top) &&
    /^3rd right now: \*\*Delta\*\*/.test(third) &&
    /Did not finish\.$/.test(bravoScore) && !/sitting/.test(bravoScore) && /sitting 2nd of 5\./.test(charlieScore) &&
    overview.teams.find(t => t.name === 'Bravo').dnf === 1 && overview.teams.find(t => t.name === 'Charlie').dnf === 0,
    JSON.stringify({ bravo: bravoSheet.rank, charlie: charlieSheet.rank, top, third, bravoScore, charlieScore }));

  await dPost('/api/console/freeze', { frozen: true }, dSess);
  const frozenLb = await mod.apiResponse('/api/leaderboard', dDb);
  const frozenTop = await say('leaderboard');
  const frozenBravo = await say('score', [['team', 'Bravo']]);
  await dPost('/api/console/freeze', { frozen: false }, dSess);
  const kept = JSON.parse(dRaw.prepare('SELECT summary FROM tab_snapshots ORDER BY id DESC LIMIT 1').get().summary);
  check('a frozen copy carries the board as it was, places and all, and Discord reads it the same way',
    frozenLb.frozen === true && JSON.stringify(frozenLb.teams) === JSON.stringify(lb.teams) &&
    JSON.stringify(kept.top.map(t => t.name)) === JSON.stringify(['Alpha', 'Charlie', 'Delta']) &&
    frozenTop.includes('\n**-** Bravo — 90\\*\n**2nd** Charlie — 80\n') && frozenTop.endsWith('\n\\* Did not finish.') &&
    /\*\*Bravo\*\* did not finish, on 90 points\.$/.test(frozenBravo),
    JSON.stringify({ frozenTop, frozenBravo }));

  const back = await (await dPost('/api/console/teams/dnf', { ids: [ids.Echo], dnf: false }, dSess)).json();
  lb = await mod.apiResponse('/api/leaderboard', dDb);
  const logged = dRaw.prepare("SELECT action, team_name FROM submission_log WHERE action IN ('team-dnf', 'team-finish') ORDER BY id").all();
  check('marking a team as finished again gives it its place back, and both are in the log',
    back.ok && back.dnf === 0 &&
    JSON.stringify(lb.teams.map(t => t.rank)) === JSON.stringify([1, null, 2, 3, 4, 5, 6]) &&
    JSON.stringify(logged.map(x => [x.action, x.team_name])) ===
      JSON.stringify([['team-dnf', 'Bravo'], ['team-dnf', 'Echo'], ['team-finish', 'Echo']]),
    JSON.stringify(logged));
}

// ---------------- rejection reasons ----------------
// a device subscribed as this team, so the notification can be read back
function makeClient(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, ecdh, authSecret: crypto.randomBytes(16) };
}
const phone = makeClient('https://push.example/dev/galahs');
await front('/api/push/subscribe', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + teamSess },
  body: JSON.stringify({
    endpoint: phone.endpoint,
    keys: { p256dh: phone.ecdh.getPublicKey().toString('base64url'), auth: phone.authSecret.toString('base64url') }
  })
});
function decryptPush(client, body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  const shared = client.ecdh.computeSecret(asPublic);
  const NUL = Buffer.from([0]);
  const info = Buffer.concat([Buffer.from('WebPush: info'), NUL, client.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, client.authSecret, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), NUL]), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.concat([Buffer.from('Content-Encoding: nonce'), NUL]), 12));
  const tag = cipher.subarray(cipher.length - 16);
  const enc = cipher.subarray(0, cipher.length - 16);
  const dec = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(tag);
  const plain = Buffer.concat([dec.update(enc), dec.final()]);
  return plain.subarray(0, plain.length - 1).toString();
}

pushed.length = 0;
r = await jpost('/api/console/submissions/reject', { id: subB, reason: 'The second casino is out of frame.' }, sess);
d = await r.json();
check('a rejection takes a reason', r.status === 200 && d.ok && d.reason === 'The second casino is out of frame.', JSON.stringify(d));
check('the reason is stored on the submission',
  raw.prepare('SELECT reason, status FROM submissions WHERE id = ?').get(subB).reason === 'The second casino is out of frame.', '');
check('the team is told, with the reason in the notification',
  pushed.length === 1 &&
  JSON.parse(decryptPush(phone, pushed[0].body)).title === 'Submission rejected' &&
  JSON.parse(decryptPush(phone, pushed[0].body)).body.includes('The second casino is out of frame.'),
  pushed.length ? decryptPush(phone, pushed[0].body) : 'nothing sent');
d = await (await get('/api/submit/mine', teamSess)).json();
const mineRow = d.submissions.find(s => s.id === subB);
check('and reads it on their own submissions list',
  mineRow.status === 'rejected' && mineRow.reason === 'The second casino is out of frame.', JSON.stringify(mineRow.reason));

const subC = await submit('make 21', 'No reason given');
pushed.length = 0;
r = await jpost('/api/console/submissions/reject', { id: subC }, sess);
d = await r.json();
check('a rejection with nothing typed still goes through', r.status === 200 && d.ok && d.reason === '', JSON.stringify(d));
check('and still tells the team, without a reason on the end',
  pushed.length === 1 && !JSON.parse(decryptPush(phone, pushed[0].body)).body.includes('—'),
  pushed.length ? decryptPush(phone, pushed[0].body) : 'nothing sent');
{
  const long = 'x'.repeat(400);
  const subD = await submit('make 21', 'Long reason');
  const res = await (await jpost('/api/console/submissions/reject', { id: subD, reason: long }, sess)).json();
  check('a very long reason is cut to what a card can hold', res.reason.length === 200, String(res.reason.length));
}

// ---------------- deleting a submission ----------------
{
  const subE = await submit('make 21', 'Wrong photo');
  const keysOf = (id) => raw.prepare('SELECT r2_key FROM submission_files WHERE submission_id = ?').all(id).map(x => x.r2_key);
  const keys = keysOf(subE);
  const stored = () => [...bucket.keys()].filter(k => keys.some(key => k === key || k.startsWith(key + '.')));
  const before = stored().length;
  r = await jpost('/api/console/submissions/delete', { id: subE, note: 'Deleted at the team\'s request.' }, sess);
  d = await r.json();
  const mineE = (await (await get('/api/submit/mine', teamSess)).json()).submissions.find(s => s.id === subE);
  check('a reviewer deletes a submission with a note: its files leave the bucket and the team reads the note',
    r.status === 200 && d.ok && before > 0 && stored().length === 0 && keysOf(subE).length === 0 &&
    mineE.status === 'deleted' && mineE.reason === 'Deleted at the team\'s request.' && mineE.files === 0,
    JSON.stringify({ d, before, after: stored(), mineE }));
  r = await jpost('/api/console/submissions/delete', { id: subE }, sess);
  check('deleting it again is refused', r.status === 409, 'status=' + r.status);
  // an accepted one's points come off with it, once, however many presses
  const subF = await submit('make 21', 'Accepted, then asked to be taken down');
  const held = () => (raw.prepare("SELECT amount FROM held WHERE team_id = ? AND quest_code = 'Make 21'").get(teamRow.id) || {}).amount || 0;
  const pointsBefore = held();
  await jpost('/api/console/submissions/accept', { id: subF }, sess);
  const pointsAccepted = held();
  const both = await Promise.all([
    jpost('/api/console/submissions/delete', { id: subF, note: '' }, sess),
    jpost('/api/console/submissions/delete', { id: subF, note: '' }, sess)
  ]);
  const statuses = both.map(x => x.status).sort();
  d = await both.find(x => x.status === 200).json();
  const listed = (await (await get('/api/console/submissions?status=deleted', sess)).json()).submissions.map(s => s.id);
  check('deleting an accepted submission takes its points off, once when pressed twice at once, and the review list has a Deleted view',
    statuses.join() === '200,409' && d.was === 'accepted' && pointsAccepted === pointsBefore + 1 && held() === pointsBefore &&
    d.off > 0 && raw.prepare('SELECT credit FROM submissions WHERE id = ?').get(subF).credit === null &&
    listed.includes(subE) && listed.includes(subF),
    JSON.stringify({ statuses, d, pointsBefore, pointsAccepted, after: held(), listed }));
  // put the team back as it was for the checks after this
  uncredit(raw, teamRow.id, 'Make 21');
}

// ---------------- claiming a submission ----------------
r = await jpost('/api/console/review/claim', { id: 999999 }, sess);
check('claiming something that is not there says so', r.status === 404, 'status=' + r.status);
r = await jpost('/api/console/review/claim', { id: subA }, sess);
d = await r.json();
check('opening a submission claims it in the reviewer\'s name',
  r.status === 200 && d.ok && d.claimed_by === 'Alex' && /^\d{4}-\d{2}-\d{2} /.test(d.claimed_at), JSON.stringify(d));
r = await jpost('/api/console/review/claim', { id: subA }, sess2);
d = await r.json();
check('a second reviewer is told who has it',
  r.status === 409 && d.claimed_by === 'Alex' && /Alex/.test(d.error), JSON.stringify(d));
r = await jpost('/api/console/review/claim', { id: subA }, sess);
check('the holder can keep it without a fight', (await r.json()).ok === true, '');

d = await (await get('/api/console/submissions?status=pending', sess)).json();
let listed = d.submissions.find(s => s.id === subA);
check('the review list says who holds it and since when',
  listed.claimed_by === 'Alex' && listed.claimed_at !== '', JSON.stringify({ by: listed.claimed_by, at: listed.claimed_at }));

raw.prepare("UPDATE submissions SET claimed_at = datetime('now', '-11 minutes') WHERE id = ?").run(subA);
d = await (await get('/api/console/submissions?status=pending', sess)).json();
listed = d.submissions.find(s => s.id === subA);
check('a claim older than ten minutes reads as nobody\'s',
  listed.claimed_by === '' && listed.claimed_at === '', JSON.stringify(listed.claimed_by));
r = await jpost('/api/console/review/claim', { id: subA }, sess2);
check('so somebody else can take it', (await r.json()).claimed_by === 'Sam', '');

// ---------------- what the team already holds ----------------
const groupId = raw.prepare("SELECT group_id FROM quests WHERE code = 'Make 21'").get();
d = await (await get('/api/console/submissions?status=pending', sess)).json();
listed = d.submissions.find(s => s.id === subA);
check('a quest the team has nothing on warns about nothing',
  listed && JSON.stringify(listed.credited) === '{}', JSON.stringify(listed && listed.credited));
const make21 = raw.prepare("SELECT points FROM quests WHERE code = 'Make 21'").get().points;
r = await jpost('/api/console/ledger/adjust', { team_id: teamRow.id, code: 'Make 21', points: 3 * make21, reason: 'Three' }, sess);
check('the team is given points on that quest', (await r.json()).ok === true, '');
d = await (await get('/api/console/submissions?status=pending', sess)).json();
listed = d.submissions.find(s => s.id === subA);
check('now the card carries what they already have on it',
  listed.credited['Make 21'] === 3, JSON.stringify(listed.credited));
check('and a submission from a team with nothing on the quest still carries an empty map',
  d.submissions.filter(s => s.id !== subA).every(s => typeof s.credited === 'object'), '');

// a quest with tiers: the warning is about the whole quest, not only
// the code that was submitted
{
  raw.prepare("INSERT INTO quest_groups (key, name, region) VALUES ('SQ-TIER', 'Stations', 'Testing')").run();
  const tierGroup = raw.prepare("SELECT id FROM quest_groups WHERE key = 'SQ-TIER'").get().id;
  raw.prepare('INSERT INTO quests (code, norm, points, group_id, sort) VALUES (?, ?, ?, ?, ?)')
    .run('SQ-TIER-5', 'SQ-TIER-5', 50, tierGroup, 0);
  raw.prepare('INSERT INTO quests (code, norm, points, group_id, sort) VALUES (?, ?, ?, ?, ?)')
    .run('SQ-TIER-10', 'SQ-TIER-10', 90, tierGroup, 1);
  raw.prepare('INSERT INTO quests (code, norm, points, group_id, sort, hidden) VALUES (?, ?, ?, ?, ?, 1)')
    .run('SQ-TIER-o', 'SQ-TIER-O', 10, tierGroup, 2);
  credit(raw, teamRow.id, 'SQ-TIER-10', 1);
  credit(raw, teamRow.id, 'SQ-TIER-o', 1);
  const tierSub = await submit('SQ-TIER-5', 'The lower tier');
  const list = await (await get('/api/console/submissions?status=pending', sess)).json();
  const row = list.submissions.find(s => s.id === tierSub);
  check('a tiered quest reports the tier the team already holds, retired codes left out',
    row.credited['SQ-TIER-10'] === 1 && row.credited['SQ-TIER-5'] === undefined &&
    row.credited['SQ-TIER-o'] === undefined, JSON.stringify(row.credited));
  await jpost('/api/console/submissions/reject', { id: tierSub, reason: 'Tidying up' }, sess);
  raw.prepare("DELETE FROM entries WHERE code LIKE 'SQ-TIER%'").run();
}

// accepting clears the claim and adds to what they hold
r = await jpost('/api/console/submissions/accept', { id: subA, amount: 1 }, sess);
d = await r.json();
check('accepting scores it', d.ok && d.total > 0, JSON.stringify(d.quest));
check('and lets go of the claim',
  raw.prepare('SELECT claimed_by, claimed_at FROM submissions WHERE id = ?').get(subA).claimed_by === '', '');
check('rejecting lets go of it too',
  raw.prepare('SELECT claimed_by FROM submissions WHERE id = ?').get(subB).claimed_by === '', '');

// A decision is made once. Two reviewers pressing Accept together, or
// one request sent twice, credit the submission once; an Accept racing
// a Reject leaves the tab agreeing with whichever won.
{
  const held = () => raw.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM held WHERE team_id = ? AND quest_code = 'Make 21'").get(teamRow.id).n;
  const subR = await submit('make 21', 'Pressed twice');
  let before = held();
  const both = await Promise.all([
    jpost('/api/console/submissions/accept', { id: subR, amount: 1 }, sess),
    jpost('/api/console/submissions/accept', { id: subR, amount: 1 }, sess2)
  ]);
  check('two Accepts at once credit the submission once',
    both.map(x => x.status).sort().join() === '200,409' && held() - before === 1,
    JSON.stringify({ statuses: both.map(x => x.status), moved: held() - before }));
  const subS = await submit('make 21', 'Accepted and rejected at once');
  before = held();
  const race = await Promise.all([
    jpost('/api/console/submissions/accept', { id: subS, amount: 1 }, sess),
    jpost('/api/console/submissions/reject', { id: subS, reason: 'No' }, sess2)
  ]);
  const verdict = raw.prepare('SELECT status FROM submissions WHERE id = ?').get(subS).status;
  check('an Accept racing a Reject: one of them wins and the points match it',
    race.map(x => x.status).sort().join() === '200,409' &&
    ((verdict === 'accepted' && held() - before === 1) || (verdict === 'rejected' && held() - before === 0)),
    JSON.stringify({ statuses: race.map(x => x.status), verdict, moved: held() - before }));
}

// D1 takes at most 100 bound parameters a statement, and the review
// queue lists 200 and the gallery 300: past a hundred submissions both
// have to keep answering.
{
  const lots = raw.prepare('SELECT id FROM teams WHERE hidden = 0 AND id != ? ORDER BY id LIMIT 1').get(teamRow.id).id;
  const many = [];
  for (let i = 0; i < 130; i++) {
    const id = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code, status, gallery) VALUES (?, 'Make 21', 'accepted', 1)").run(lots).lastInsertRowid);
    raw.prepare("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, ?, 'image/png', 12, 'p.png')").run(id, 'sub/bulk' + String(i).padStart(12, '0'));
    many.push(id);
  }
  const list = await get('/api/console/submissions?status=all', sess);
  const listed = await list.json();
  const gal = await get('/api/submit/gallery', sess);
  const shown = await gal.json();
  check('the review queue and the gallery both answer with well over a hundred submissions, files attached',
    list.status === 200 && listed.submissions.length > 100 && listed.submissions.every(x => Array.isArray(x.media)) &&
    gal.status === 200 && shown.submissions.length >= 130 && shown.submissions.filter(x => many.includes(x.id)).every(x => x.media.length === 1),
    JSON.stringify({ list: list.status, gallery: gal.status }));
  for (const id of many) {
    raw.prepare('DELETE FROM submission_files WHERE submission_id = ?').run(id);
    raw.prepare('DELETE FROM submissions WHERE id = ?').run(id);
  }
}
// a correction that brought the code back to nothing
credit(raw, teamRow.id, 'Make 21', -(raw.prepare("SELECT COALESCE(SUM(amount), 0) AS n FROM held WHERE team_id = ? AND quest_code = 'Make 21'").get(teamRow.id).n));
{
  const subE = await submit('make 21', 'After a zero');
  const list = await (await get('/api/console/submissions?status=pending', sess)).json();
  const row = list.submissions.find(s => s.id === subE);
  check('a code whose lines come to nothing is not reported as held',
    row.credited['Make 21'] === undefined, JSON.stringify(row.credited));
}
uncredit(raw, teamRow.id, 'Make 21');

// ---------------- the day board ----------------
r = await get('/api/console/board', sess);
d = await r.json();
const pendingNow = raw.prepare("SELECT COUNT(*) AS n, MIN(submitted_at) AS oldest FROM submissions WHERE status = 'pending'").get();
check('the board counts what is waiting and how long the oldest has waited',
  r.status === 200 && d.ok && d.pending === pendingNow.n && d.oldest_pending_at === pendingNow.oldest,
  JSON.stringify({ pending: d.pending, oldest: d.oldest_pending_at }));
const nowHour = new Date().toISOString().slice(0, 13).replace('T', ' ') + ':00';
check('twelve hours of submissions, oldest first, this hour last',
  d.per_hour.length === 12 && d.per_hour[11].hour === nowHour &&
  d.per_hour[11].submissions === raw.prepare(
    "SELECT COUNT(*) AS n FROM submissions WHERE strftime('%Y-%m-%d %H:00', submitted_at) = ?"
  ).get(nowHour).n,
  JSON.stringify(d.per_hour.slice(-2)));
check('the teams, hidden ones counted separately',
  d.teams.total === raw.prepare('SELECT COUNT(*) AS n FROM teams').get().n && d.teams.hidden === 0,
  JSON.stringify(d.teams));
check('the check-in worker\'s roster, when it answers',
  d.checkin.live === true && d.checkin.registered === 12 && d.checkin.checked_in === 7, JSON.stringify(d.checkin));
check('the subscribed devices and the encoders',
  d.push_subs === 1 && d.encoder.online === 0 && typeof d.encoder.waiting === 'number', JSON.stringify({ subs: d.push_subs, enc: d.encoder }));
check('and whether the public tab is frozen', d.frozen === false, JSON.stringify(d.frozen));

checkinUp = false;
d = await (await get('/api/console/board', sess)).json();
check('a check-in worker that will not answer reads as not answering, not as an error',
  d.ok && d.checkin.live === false && d.checkin.registered === 0 && d.checkin.checked_in === 0, JSON.stringify(d.checkin));
checkinUp = true;
{
  const bare = Object.assign({}, ENV, { CHECKIN_API: undefined, CHECKIN_KEY: undefined });
  const res = await front('/api/console/board', { headers: { authorization: 'Bearer ' + sess } }, bare);
  const body = await res.json();
  check('and so does one that was never connected', body.ok && body.checkin.live === false, JSON.stringify(body.checkin));
}
await jpost('/api/console/freeze', { frozen: true }, sess);
d = await (await get('/api/console/board', sess)).json();
check('the board follows the freeze', d.frozen === true, '');
await jpost('/api/console/freeze', { frozen: false }, sess);
r = await get('/api/console/board');
check('the board is behind the dashboard sign-in', r.status === 401, 'status=' + r.status);

// ---------------- a message that publishes itself ----------------
const stamp = (msFromNow) => new Date(Date.now() + msFromNow).toISOString().replace('T', ' ').slice(0, 19);
async function postMessage(fields) {
  const f = new FormData();
  Object.keys(fields).forEach(k => f.append(k, fields[k]));
  const res = await front('/api/console/messages/save', {
    method: 'POST', headers: { authorization: 'Bearer ' + sess }, body: f
  });
  await settle();
  return { status: res.status, data: await res.json() };
}
const pulse = async () => (await (await get('/api/pulse')).json());
const publicMessages = async () => (await (await get('/api/messages')).json()).messages;

let out = await postMessage({ title: 'Bad time', body: 'x', publish_at: 'half past four' });
check('a time the worker cannot read is refused', out.status === 400 && /Publish at/.test(out.data.error), JSON.stringify(out.data));

const beforeCounter = (await pulse()).messages;
const later = await postMessage({ title: 'Halfway briefing', body: 'Read this at noon.', publish_at: stamp(3600000) });
check('a message with a time on it saves, held back',
  later.status === 200 && later.data.ok && later.data.hidden === 1 && later.data.publish_at === stamp(3600000),
  JSON.stringify(later.data));
check('it is not on the site yet',
  !(await publicMessages()).some(m => m.id === later.data.id), '');
check('and it has moved nothing', (await pulse()).messages === beforeCounter, '');
out = await postMessage({ title: 'Announce me', body: 'x', publish_at: stamp(3600000), push: '1' });
check('a scheduled message cannot also be announced', out.status === 400 && /time on it/.test(out.data.error), JSON.stringify(out.data));

// the day moves on: the first public read after the time publishes it
raw.prepare("UPDATE messages SET publish_at = datetime('now', '-1 minute') WHERE id = ?").run(later.data.id);
purged.length = 0;
// several pages polling at that moment publish it once between them
await Promise.all([pulse(), pulse(), pulse()]);
const afterPulse = await pulse();
check('the first pulse after its time moves the counter for it',
  afterPulse.messages === beforeCounter + 1, JSON.stringify({ was: beforeCounter, now: afterPulse.messages }));
check('and it is on the site, no longer hidden and with the time cleared',
  (await publicMessages()).some(m => m.id === later.data.id) &&
  raw.prepare('SELECT hidden, publish_at FROM messages WHERE id = ?').get(later.data.id).hidden === 0 &&
  raw.prepare('SELECT publish_at FROM messages WHERE id = ?').get(later.data.id).publish_at === '', '');
check('publishing itself drops the cached public reads',
  purged.some(u => u.endsWith('/api/pulse')) && purged.some(u => u.endsWith('/api/messages')), JSON.stringify(purged));
check('the log says it went up on its own',
  raw.prepare("SELECT COUNT(*) AS n FROM submission_log WHERE action = 'message-publish' AND actor = 'schedule'").get().n === 1, '');
const steady = (await pulse()).messages;
check('reading again does not publish it twice', steady === beforeCounter + 1, JSON.stringify(steady));

// a silent one appears without moving anything
const quiet = await postMessage({ title: 'Water at the halfway point', body: 'By the fountain.', urgency: 'silent', publish_at: stamp(3600000) });
raw.prepare("UPDATE messages SET publish_at = datetime('now', '-1 minute') WHERE id = ?").run(quiet.data.id);
const beforeQuiet = (await pulse()).messages;
check('a silent scheduled message goes up without moving the counter',
  beforeQuiet === steady && (await publicMessages()).some(m => m.id === quiet.data.id), JSON.stringify(beforeQuiet));
check('two publishes are in the log',
  raw.prepare("SELECT COUNT(*) AS n FROM submission_log WHERE action = 'message-publish'").get().n === 2, '');

// a draft with no time on it stays a draft, whatever anyone reads, and
// so does a scheduled one that was archived
const draft = await postMessage({ title: 'Not ready', body: 'Later.', hidden: '1' });
const shelved = await postMessage({ title: 'Shelved', body: 'Not now.', publish_at: stamp(3600000) });
raw.prepare("UPDATE messages SET archived = 1, publish_at = datetime('now', '-1 minute') WHERE id = ?").run(shelved.data.id);
await pulse();
check('an ordinary draft is left alone, and an archived scheduled one does not go up',
  raw.prepare('SELECT hidden FROM messages WHERE id = ?').get(draft.data.id).hidden === 1 &&
  raw.prepare('SELECT hidden, seq FROM messages WHERE id = ?').get(shelved.data.id).hidden === 1 &&
  !raw.prepare('SELECT seq FROM messages WHERE id = ?').get(shelved.data.id).seq, '');
// a time already past is a message posted now
const nowish = await postMessage({ title: 'Posted straight away', body: 'x', publish_at: stamp(-60000) });
check('a time already gone posts the message there and then',
  nowish.data.hidden === 0 && nowish.data.publish_at === '' &&
  (await publicMessages()).some(m => m.id === nowish.data.id), JSON.stringify(nowish.data));
check('the dashboard list carries the publish time so a scheduled one can be seen',
  (await (await get('/api/console/messages/list', sess)).json()).messages.every(m => 'publish_at' in m), '');

// ---------------- a question that closes at a set time ----------------
const askKey = 'SQ-ASK';
raw.prepare("INSERT INTO quest_groups (key, name, region) VALUES (?, 'Colour call', 'Testing')").run(askKey);
const askGroup = raw.prepare('SELECT id FROM quest_groups WHERE key = ?').get(askKey).id;
raw.prepare("INSERT INTO quests (code, norm, points, group_id) VALUES (?, ?, 40, ?)").run(askKey, askKey, askGroup);
r = await jpost('/api/console/quests/group/ask/save', {
  key: askKey, kind: 'choice', prompt: 'Red or blue?', options: 'Red\nBlue',
  open: true, open_until: stamp(3600000)
}, sess);
d = await r.json();
check('a question saves with a deadline on it',
  r.status === 200 && d.ok && d.ask.open === true && d.ask.open_until === stamp(3600000), JSON.stringify(d.ask));
r = await jpost('/api/console/quests/group/ask/save', {
  key: askKey, kind: 'choice', prompt: 'Red or blue?', options: 'Red\nBlue', open: true, open_until: 'soon'
}, sess);
check('a deadline the worker cannot read is refused', r.status === 400, 'status=' + r.status);

let list = await (await get('/api/questlist')).json();
let asked = list.groups.find(g => g.key === askKey);
check('the quest list says the question is open, and until when',
  asked.ask.kind === 'choice' && asked.ask.open === true && asked.ask.open_until === stamp(3600000),
  JSON.stringify(asked.ask));
r = await get('/api/quest/ask?quest=' + askKey, teamSess);
d = await r.json();
check('the sheet reads the same', d.open === true && d.open_until === stamp(3600000), JSON.stringify(d));
r = await jpost('/api/quest/ask', { quest: askKey, choice: 'Red' }, teamSess);
check('a team can answer while it is open', (await r.json()).ok === true, '');

raw.prepare("UPDATE quest_groups SET ask_open_until = datetime('now', '-1 minute') WHERE id = ?").run(askGroup);
list = await (await get('/api/questlist')).json();
asked = list.groups.find(g => g.key === askKey);
check('past the deadline the list holds the question back, with the switch untouched',
  asked.ask === null &&
  raw.prepare('SELECT ask_open FROM quest_groups WHERE id = ?').get(askGroup).ask_open === 1,
  JSON.stringify(asked.ask));
d = await (await get('/api/quest/ask?quest=' + askKey)).json();
check('and to anyone without an answer on record it reads as no question',
  d.kind === '' && d.prompt === undefined, JSON.stringify(d));
d = await (await get('/api/quest/ask?quest=' + askKey, teamSess)).json();
check('while the team that answered still sees it closed, answer intact',
  d.open === false && d.kind === 'choice' && d.response && d.response.choice === 'Red',
  JSON.stringify(d));
r = await jpost('/api/quest/ask', { quest: askKey, choice: 'Blue' }, teamSess);
check('an answer after the deadline is refused', r.status === 409, 'status=' + r.status);
check('and nothing was written',
  raw.prepare('SELECT choice FROM quest_responses WHERE group_id = ?').get(askGroup).choice === 'Red', '');
d = await (await jpost('/api/console/quests/group/ask/responses', { key: askKey }, sess)).json();
check('the dashboard sees it closed and knows when it closed',
  d.ok && d.open === false && /^\d{4}-\d{2}-\d{2} /.test(d.open_until), JSON.stringify({ open: d.open, until: d.open_until }));
r = await jpost('/api/console/quests/group/ask/save', {
  key: askKey, kind: 'choice', prompt: 'Red or blue?', options: 'Red\nBlue', open: true, open_until: ''
}, sess);
check('clearing the deadline opens it again', (await r.json()).ask.open === true, '');
// one stamp for the save and the compare, or a second ticking over between them fails it
const askUntil = stamp(3600000);
check('a quest saved through the ordinary editor keeps its deadline',
  (await (await jpost('/api/console/quests/group/ask/save', {
    key: askKey, kind: 'choice', prompt: 'Red or blue?', options: 'Red\nBlue', open: true, open_until: askUntil
  }, sess)).json()).ok &&
  (await (await jpost('/api/console/quests/group/save', {
    id: askGroup, key: askKey, name: 'Colour call', region: 'Testing',
    codes: [{ code: askKey, was: askKey, points: 40 }]
  }, sess)).json()).ok &&
  raw.prepare('SELECT ask_open_until FROM quest_groups WHERE id = ?').get(askGroup).ask_open_until === askUntil, '');

// ---------------- quests done, and the spinner's read ----------------
// a quest's sub codes count once between them; a penalty is not a quest
{
  await jpost('/api/console/quests/group/save', { key: 'QD1', name: 'Sub codes', region: 'Testing',
    codes: [{ code: 'QD1-1', label: '', points: 10 }, { code: 'QD1-12', label: '', points: 20 }] }, sess);
  const doneFor = async () => (await (await get('/api/console/quests-done', sess)).json()).teams.find(t => t.id === teamRow.id);
  const before = await doneFor();
  ['QD1-1', 'QD1-12', 'MQ1Penalty'].forEach(code => credit(raw, teamRow.id, code, 1));
  const after = await doneFor();
  check('quests done counts a quest\'s sub codes once and a penalty not at all',
    after.quests === before.quests + 1 && after.keys.includes('QD1') &&
    !after.keys.some(k => /^QD1-/.test(k)) && !after.keys.includes('MQ1Penalty'),
    JSON.stringify({ before: before.quests, after: after.quests, keys: after.keys.filter(k => /QD1|Penalty/.test(k)) }));

  // photo to submission: from the newest file taken to the send, over the
  // team's own accepted submissions; a clock set wrong, an organiser's
  // entry and a rejected one are left out
  {
    const team = raw.prepare("INSERT INTO teams (name) VALUES ('Quick Draw')").run().lastInsertRowid;
    const sub = raw.prepare('INSERT INTO submissions (team_id, quest_code, status, submitted_at, added_by) VALUES (?, ?, ?, ?, ?)');
    const file = raw.prepare("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, taken_at) VALUES (?, ?, 'image/jpeg', 10, ?)");
    let n = 0;
    const send = (status, at, by, taken) => {
      const id = sub.run(team, 'S1', status, at, by).lastInsertRowid;
      taken.forEach(t => file.run(id, 'sub/qd' + (n++), t));
    };
    send('accepted', '2026-11-07 01:10:00', '', ['2026-11-07 01:00:00', '2026-11-07 01:08:00']);  // 2 min from the newer
    send('accepted', '2026-11-07 02:04:00', '', ['2026-11-07 02:00:00', '']);                      // 4 min
    send('accepted', '2026-11-07 03:00:00', '', ['2026-11-07 03:30:00']);                          // taken after: a wrong clock
    send('accepted', '2026-11-07 04:00:00', 'Alex', ['2026-11-07 03:00:00']);                      // an organiser's entry
    send('rejected', '2026-11-07 05:00:00', '', ['2026-11-07 04:00:00']);
    const times = (await (await get('/api/console/ranks/times', sess)).json()).teams;
    const mine = times.find(t => t.id === Number(team)) || {};
    check('photo to submission averages a team\'s own accepted sends from the newest file taken, and leaves out a clock set wrong',
      mine.submissions === 2 && mine.average === 180 && mine.quickest === 120 &&
      times.every((t, i) => !i || times[i - 1].average <= t.average),
      JSON.stringify(mine));

    // a board made on the dashboard: accepted submissions on one code,
    // and points from one quest's codes, its key in any case
    const board = async (q) => (await (await get('/api/console/ranks/custom?' + q, sess)).json()).teams;
    const accepted = (await board('quest=S1&measure=accepted')).find(t => t.id === Number(team)) || {};
    const fromQuest = (await board('quest=qd1&measure=points')).find(t => t.id === teamRow.id) || {};
    check('a custom board counts accepted submissions on a quest, or the points its codes gave',
      accepted.value === 4 && fromQuest.value === 30, JSON.stringify({ accepted, fromQuest }));
  }

  // any account signed in may read the spinner's teams, and gets names
  // and points of the teams on the board and nothing more
  await jpost('/api/console/accounts/save', { create: true, name: 'Rae', password: 'rae-password', perms: ['review'], require_2fa: false }, sess);
  const raeSess = (await consoleSignIn(jpost, 'Rae', 'rae-password')).session;
  raw.prepare("INSERT INTO teams (name, hidden) VALUES ('Spinner test run', 1)").run();
  const spun = await get('/api/console/spinner', raeSess);
  const spin = await spun.json();
  const shownTeams = raw.prepare('SELECT COUNT(*) AS n FROM teams WHERE hidden = 0').get().n;
  const galahs = (spin.teams || []).find(t => t.id === teamRow.id) || {};
  check('the spinner\'s read is open to any account, has the board\'s teams with their points and nothing else',
    spun.status === 200 && spin.teams.length === shownTeams &&
    !spin.teams.some(t => t.name === 'Spinner test run') &&
    spin.teams.every(t => Object.keys(t).sort().join() === 'id,name,points') &&
    typeof galahs.points === 'number' && (await get('/api/console/spinner')).status === 401,
    JSON.stringify({ status: spun.status, n: (spin.teams || []).length, shownTeams, galahs }));
}

// ---------------- one file with everything in it ----------------
r = await get('/api/console/export/all');
check('the export is behind the dashboard sign-in', r.status === 401, 'status=' + r.status);
r = await get('/api/console/export/all', sess);
d = await r.json();
const EXPECTED = ['teams', 'quests', 'quest_groups', 'quest_regions', 'completions', 'submissions',
  'submission_files', 'submission_renditions', 'quest_files', 'quest_responses', 'messages',
  'message_files', 'counters', 'registrations', 'participants', 'discord_guilds', 'discord_teams',
  'discord_members', 'submission_log', 'encoders'];
check('every table an organiser would want is in it',
  r.status === 200 && d.ok && EXPECTED.every(t => Array.isArray(d.tables[t])),
  JSON.stringify(EXPECTED.filter(t => !Array.isArray(d.tables[t]))));
check('with the rows themselves',
  d.tables.teams.length === raw.prepare('SELECT COUNT(*) AS n FROM teams').get().n &&
  d.tables.completions.length === raw.prepare('SELECT COUNT(*) AS n FROM completions').get().n &&
  d.tables.submissions.some(s => s.id === subA),
  JSON.stringify({ teams: d.tables.teams.length, completions: d.tables.completions.length }));
check('push subscriptions are counted, never handed over',
  d.tables.push_subs === undefined && d.push_subs_count === 1 &&
  !JSON.stringify(d).includes('push.example'), JSON.stringify(d.push_subs_count));
check('and the session tables are not in it at all',
  d.tables.console_sessions === undefined && d.tables.submit_sessions === undefined &&
  !JSON.stringify(d).includes(sess), '');
check('it is stamped and never cached',
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d.exported_at) &&
  (r.headers.get('cache-control') || '').includes('no-store'), JSON.stringify(d.exported_at));
check('taking a copy is in the log',
  raw.prepare("SELECT COUNT(*) AS n FROM submission_log WHERE action = 'export-all'").get().n === 1, '');

// ---------------- a database behind the code ----------------
// the pulse is the call every page makes: the scheduled-message check
// in front of it must not be what takes it down
{
  const bare = new DatabaseSync(':memory:');
  bare.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
  bare.exec('DROP TABLE messages');
  const barePulse = await mod.apiResponse('/api/pulse', d1Shim(bare));
  check('a database without the messages table still answers the pulse',
    barePulse && barePulse.quests === 0, JSON.stringify(barePulse));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
