// Run with: node tests/verify-ask.mjs   (needs Node 22+ for node:sqlite)
// The quests organisers run live: files hung on a quest, and the
// question a quest asks every team — buttons, a sealed number, a typed
// answer, or a wager that is settled into points afterwards. End to end
// against the real worker, plus the two things that would quietly break
// everything else: a quest saved or re-imported must keep its question,
// and a frozen tab must still take answers.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';

import { consoleSignIn } from './console-signin.mjs';
import { pretendR2 } from './pretend-r2.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

// ---------------- the migration, on a database that lacks all of it ----------------
// Built by hand in the shape quest_groups had before any of this
// existed, so the file is applied the way an older database would
// apply it.
{
  const old = new DatabaseSync(':memory:');
  old.exec(`CREATE TABLE quest_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
    region TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
    flavour TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
    coords TEXT NOT NULL DEFAULT '[]', submit_kind TEXT NOT NULL DEFAULT 'none',
    prompt TEXT NOT NULL DEFAULT '', options TEXT NOT NULL DEFAULT '[]',
    sort INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0)`);
  old.prepare('INSERT INTO quest_groups (key, name) VALUES (?, ?)').run('OLD1', 'Made before all this');
  let applied = true;
  let why = '';
  try {
    old.exec(readFileSync(BOT + '/migrations/2026-10-quest-extras.sql', 'utf8'));
  } catch (err) { applied = false; why = String(err && err.message); }
  check('the migration applies to a database without any of the new columns', applied, why);
  const cols = old.prepare('PRAGMA table_info(quest_groups)').all().map(c => c.name);
  check('quest_groups gains the four ask columns',
    ['ask_kind', 'ask_prompt', 'ask_options', 'ask_open'].every(c => cols.includes(c)), JSON.stringify(cols.slice(-5)));
  const kept = old.prepare('SELECT key, ask_kind, ask_options, ask_open FROM quest_groups WHERE key = ?').get('OLD1');
  check('an existing quest reads as one that asks nothing',
    kept.ask_kind === '' && kept.ask_options === '[]' && kept.ask_open === 0, JSON.stringify(kept));
  old.prepare('INSERT INTO quest_files (group_id, key, name, type, bytes, sort) VALUES (?, ?, ?, ?, ?, ?)')
    .run(1, 'qst/one', 'photo.jpg', 'image/jpeg', 1234, 0);
  old.prepare('INSERT INTO quest_responses (group_id, team_id, choice, amount) VALUES (?, ?, ?, ?)').run(1, 7, 'Red', 25);
  const resp = old.prepare('SELECT choice, amount, created_at, updated_at FROM quest_responses').get();
  check('quest_files and quest_responses are there, with their defaults filled in',
    old.prepare('SELECT bytes FROM quest_files').get().bytes === 1234 &&
    resp.choice === 'Red' && resp.amount === 25 &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(resp.updated_at), JSON.stringify(resp));
  let twice = false;
  try {
    old.prepare('INSERT INTO quest_responses (group_id, team_id, choice) VALUES (?, ?, ?)').run(1, 7, 'Blue');
    twice = true;
  } catch (err) { /* the unique index did its job */ }
  check('a team cannot hold two answers to the same question', !twice, '');
}

// ---------------- the worker ----------------
const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);

// R2: put, ranged get, delete
const bucket = new Map();
async function drain(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(0);
}
const SUBMIT = {
  async put(key, value, opts) {
    bucket.set(key, { bytes: await drain(value), meta: (opts && opts.httpMetadata) || {}, custom: (opts && opts.customMetadata) || {} });
  },
  async get(key, opts) {
    const hit = bucket.get(key);
    if (!hit) return null;
    let bytes = hit.bytes;
    if (opts && opts.range) {
      const r = opts.range;
      if (r.suffix != null) bytes = bytes.slice(bytes.length - r.suffix);
      else bytes = bytes.slice(r.offset, r.length != null ? r.offset + r.length : undefined);
    }
    // a real R2 object reads its own bytes back, and the worker uses
    // that to make the copy with the metadata taken out
    return {
      body: bytes, size: hit.bytes.length, httpMetadata: hit.meta, customMetadata: hit.custom || {},
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
    };
  },
  async delete(key) { bucket.delete(key); }
};

const purged = [];
globalThis.caches = { default: {
  async match() { return undefined; },
  async put() {},
  async delete(key) { purged.push(typeof key === 'string' ? key : key.url); return true; }
} };

const mod = await import(BOT + '/src/index.ts');
const ENV = { DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass' };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
const sendFiles = (form, token) => front('/api/console/quests/group/files', {
  method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body: form
});
const file = (name, type, bytes) => new File([bytes], name, { type });
// a JPEG with nothing to take out, as a canvas makes one
const thumbJpeg = new Uint8Array(64);
thumbJpeg.set([0xFF, 0xD8, 0xFF, 0xDA, 0, 2]);
thumbJpeg.set([0xFF, 0xD9], 62);
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

const sess = (await consoleSignIn(jpost, 'Runner', 'tab-pass')).session;

// the quests this suite runs: a photo quest, a sealed bid, a typed
// answer, and two casinos whose codes are worth different points
async function makeQuest(key, name, codes, hidden) {
  const r = await jpost('/api/console/quests/group/save', {
    key: key, name: name, region: 'Live Region', hidden: hidden ? 1 : 0,
    codes: codes
  }, sess);
  return r.json();
}
await makeQuest('LQ1', 'Red or blue', [{ code: 'LQ1-A', label: '', points: 5 }]);
await makeQuest('LQ2', 'Sealed bid', [{ code: 'LQ2', label: '', points: 3 }]);
await makeQuest('LQ3', 'Name the place', [{ code: 'LQ3', label: '', points: 4 }]);
await makeQuest('LQ4', 'Casino, penny a point', [{ code: 'LQ4', label: '', points: 1 }]);
await makeQuest('LQ5', 'Casino, two a point', [{ code: 'LQ5', label: '', points: 2 }]);
await makeQuest('LQ6', 'Worth nothing yet', [{ code: 'LQ6', label: '', points: 0 }]);
await makeQuest('LQ7', 'Kept off the site', [{ code: 'LQ7', label: '', points: 1 }], true);

// two teams, signed in the way the submit page signs them in
await jpost('/api/console/codes/generate', {}, sess);
const codeList = (await (await get('/api/console/codes', sess)).json()).codes;
const teams = raw.prepare('SELECT id, name FROM teams WHERE hidden = 0 ORDER BY id LIMIT 2').all();
async function teamLogin(team) {
  const code = codeList.find(c => c.name === team.name).code;
  const r = await jpost('/api/submit/login', { team_name: team.name, code: code });
  return (await r.json()).session;
}
const teamA = teams[0];
const teamB = teams[1];
const sessA = await teamLogin(teamA);
const sessB = await teamLogin(teamB);
check('two teams are signed in', !!sessA && !!sessB && sessA !== sessB, teamA.name + ' / ' + teamB.name);

// ---------------- files hung on a quest ----------------
let r;
let d;
{
  const f = new FormData();
  f.append('key', 'LQ1');
  f.append('file0', file('scene.png', 'image/png', png), 'scene.png');
  f.append('thumb0', file('thumb.jpg', 'image/jpeg', thumbJpeg), 'thumb.jpg');
  f.append('file1', file('rules.pdf', 'application/pdf', new Uint8Array(2048)), 'rules.pdf');
  r = await sendFiles(f);
  check('hanging files on a quest needs a dashboard session', r.status === 401, 'status=' + r.status);
  r = await sendFiles(f, sess);
  d = await r.json();
  check('a picture and a PDF go onto the quest',
    r.status === 200 && d.ok && d.files.length === 2 && d.files[0].name === 'scene.png' &&
    d.files[1].bytes === 2048 && d.files[0].key.indexOf('qst/') === 0, JSON.stringify(d));
}
const questFiles = d.files;
check('the bytes and the preview are both in the bucket',
  bucket.has(questFiles[0].key) && bucket.has(questFiles[0].key + '.t') && bucket.has(questFiles[1].key), '');

{
  const f = new FormData();
  f.append('key', 'LQ1');
  f.append('file0', file('macro.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', png), 'macro.docx');
  r = await sendFiles(f, sess);
  check('anything that is not a picture or a PDF is refused in plain words',
    r.status === 400 && /not a JPEG, PNG or GIF, or a PDF/.test((await r.json()).error), 'status=' + r.status);
}
{
  const f = new FormData();
  f.append('key', 'LQ1');
  const huge = new Uint8Array(26 * 1024 * 1024);
  huge.set(png);
  f.append('file0', file('huge.png', 'image/png', huge), 'huge.png');
  r = await sendFiles(f, sess);
  check('a file over 25MB is refused', r.status === 413, 'status=' + r.status);
}
{
  const held = bucket.size;
  const f = new FormData();
  f.append('key', 'LQ1');
  for (let i = 0; i < 7; i++) f.append('file' + i, file(i + '.png', 'image/png', png), i + '.png');
  r = await sendFiles(f, sess);
  check('the ninth file on a quest is refused', r.status === 400 && /at most 8 files/.test((await r.json()).error), 'status=' + r.status);
  check('and nothing from that send was stored',
    bucket.size === held &&
    raw.prepare('SELECT COUNT(*) AS n FROM quest_files').get().n === 2, 'objects=' + bucket.size);
}
{
  const f = new FormData();
  f.append('key', 'NOPE');
  f.append('file0', file('scene.png', 'image/png', png), 'scene.png');
  r = await sendFiles(f, sess);
  check('files for a quest that is not there are refused', r.status === 404, 'status=' + r.status);
}

r = await front('/api/quests/file?key=' + encodeURIComponent(questFiles[0].key));
check('a quest file serves to anyone holding its key, cached forever',
  r.status === 200 && (await r.arrayBuffer()).byteLength === png.length &&
  (r.headers.get('cache-control') || '').includes('immutable') &&
  r.headers.get('access-control-allow-origin') === '*', 'status=' + r.status);
r = await front('/api/quests/file?key=' + encodeURIComponent(questFiles[0].key) + '&thumb=1');
check('thumb=1 serves the small copy', r.status === 200 && (await r.arrayBuffer()).byteLength === 64, 'status=' + r.status);
r = await front('/api/quests/file?key=' + encodeURIComponent(questFiles[1].key) + '&thumb=1');
check('a file with no small copy falls back to the whole thing',
  r.status === 200 && (await r.arrayBuffer()).byteLength === 2048, 'status=' + r.status);
r = await front('/api/quests/file?key=' + encodeURIComponent(questFiles[0].key) + '&thumb=1', {
  headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' }
});
check('a link preview asking for the thumbnail is handed the whole picture',
  r.status === 200 && (await r.arrayBuffer()).byteLength === png.length &&
  r.headers.get('cache-control') === 'private, no-store', 'status=' + r.status);
r = await front('/api/quests/file?key=qst/not-a-real-key');
check('a key that is not in the table is not found', r.status === 404, 'status=' + r.status);
r = await front('/api/quests/file?key=' + encodeURIComponent('sub/1/abc'));
check('nothing outside the qst/ prefix is reachable here', r.status === 404, 'status=' + r.status);
bucket.set('qst/orphan', { bytes: new Uint8Array([9, 9, 9]), meta: {} });
r = await front('/api/quests/file?key=qst/orphan');
check('a stray object with no row stays unreachable', r.status === 404, 'status=' + r.status);
bucket.delete('qst/orphan');

// ---------------- the payload the site reads ----------------
r = await get('/api/questlist');
d = await r.json();
let lq1 = d.groups.find(g => g.key === 'LQ1');
check('the quest carries its files in the public list, in order',
  lq1.files.length === 2 && lq1.files[0].name === 'scene.png' && lq1.files[0].type === 'image/png' &&
  lq1.files[1].name === 'rules.pdf', JSON.stringify(lq1.files));
check('a quest that asks nothing says so plainly', lq1.ask === null, JSON.stringify(lq1.ask));
check('a quest with no files carries an empty list, not a missing one',
  Array.isArray(d.groups.find(g => g.key === 'LQ2').files) &&
  d.groups.find(g => g.key === 'LQ2').files.length === 0, '');
check('a hidden quest is still off the list', !d.groups.some(g => g.key === 'LQ7'), '');

// ---------------- setting the question ----------------
r = await jpost('/api/console/quests/group/ask/save', { key: 'LQ1', kind: 'shouting' }, sess);
check('an unknown kind of question is refused', r.status === 400, 'status=' + r.status);
r = await jpost('/api/console/quests/group/ask/save', { key: 'LQ1', kind: 'choice', options: [] }, sess);
check('a choice with no options is refused', r.status === 400, 'status=' + r.status);
r = await jpost('/api/console/quests/group/ask/save', {
  key: 'LQ1', kind: 'choice', options: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
}, sess);
check('more than eight options is refused', r.status === 400 && /at most 8 options/.test((await r.json()).error), 'status=' + r.status);
r = await jpost('/api/console/quests/group/ask/save', { key: 'NOPE', kind: 'choice', options: ['Red'] }, sess);
check('a question for a quest that is not there is a 404', r.status === 404, 'status=' + r.status);

const pulseBefore = (await (await get('/api/pulse')).json()).quests;
purged.length = 0;
r = await jpost('/api/console/quests/group/ask/save', {
  key: 'LQ1', kind: 'choice', prompt: 'Red door or blue door?', options: ['Red', 'Blue'], open: false
}, sess);
d = await r.json();
check('a choice question saves, closed to begin with',
  r.status === 200 && d.ok && d.ask.kind === 'choice' && d.ask.options.join('|') === 'Red|Blue' && d.ask.open === false,
  JSON.stringify(d.ask));
check('setting a question moves the quests counter the site polls',
  (await (await get('/api/pulse')).json()).quests === pulseBefore + 1, '');
check('and purges the quest list from the edge cache',
  purged.some(u => u.endsWith('/api/questlist')), JSON.stringify(purged));

// A question that is not open is a secret: it is usually written well
// before the moment it is asked, and both public reads are open to
// anyone. Until it opens, the payload and the ask endpoint must give
// away nothing — not even that a question exists.
r = await get('/api/questlist');
lq1 = (await r.json()).groups.find(g => g.key === 'LQ1');
check('a question that is not open yet stays out of the quest list',
  lq1.ask === null, JSON.stringify(lq1.ask));

// ---------------- reading the question ----------------
r = await get('/api/quest/ask?quest=LQ1');
d = await r.json();
check('and the ask endpoint reads as no question at all',
  r.status === 200 && d.kind === '' && d.prompt === undefined && d.options === undefined,
  JSON.stringify(d));
r = await get('/api/quest/ask?quest=LQ1', sessA);
d = await r.json();
check('a signed-in team with no answer on record learns nothing either',
  d.kind === '' && d.prompt === undefined, JSON.stringify(d));
r = await get('/api/quest/ask?quest=LQ2');
check('a quest with no question answers with an empty kind', (await r.json()).kind === '', '');
r = await get('/api/quest/ask?quest=NOPE');
check('an unknown quest is a 404 with a plain reason',
  r.status === 404 && typeof (await r.json()).error === 'string', 'status=' + r.status);
r = await get('/api/quest/ask?quest=LQ7');
check('a hidden quest cannot be reached this way either', r.status === 404, 'status=' + r.status);

// ---------------- answering ----------------
check('the four kinds of question are the ones the site codes against',
  (await import(BOT + '/src/quests.ts')).ASK_KINDS.join('|') === '|choice|number|wager|text', '');
r = await front('/api/quest/ask', {
  method: 'OPTIONS',
  headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' }
});
check('the browser\'s preflight is answered before it sends the answer',
  r.status === 204 && r.headers.get('access-control-allow-origin') === '*' &&
  (r.headers.get('access-control-allow-methods') || '').includes('POST') &&
  (r.headers.get('access-control-allow-headers') || '').includes('authorization'), 'status=' + r.status);
r = await jpost('/api/quest/ask', { quest: 'LQ1', choice: 'Red' });
check('answering without a team session is refused',
  r.status === 401 && typeof (await r.json()).error === 'string', 'status=' + r.status);
r = await jpost('/api/quest/ask', { quest: 'LQ1', choice: 'Red' }, sessA);
check('a closed question takes nothing',
  r.status === 409 && (await r.json()).error === 'Responses are closed.', 'status=' + r.status);

await jpost('/api/console/quests/group/ask/save', {
  key: 'LQ1', kind: 'choice', prompt: 'Red door or blue door?', options: ['Red', 'Blue'], open: true
}, sess);
r = await get('/api/questlist');
lq1 = (await r.json()).groups.find(g => g.key === 'LQ1');
check('opened, the quest list carries the question',
  lq1.ask && lq1.ask.kind === 'choice' && lq1.ask.prompt === 'Red door or blue door?' &&
  lq1.ask.open === true && lq1.ask.options.length === 2, JSON.stringify(lq1.ask));
r = await get('/api/quest/ask?quest=LQ1');
d = await r.json();
check('and anyone can read what it is asking, uncached, CORS open',
  r.status === 200 && d.kind === 'choice' && d.options.join('|') === 'Red|Blue' && d.open === true &&
  d.response === null && (r.headers.get('cache-control') || '').includes('no-store') &&
  r.headers.get('access-control-allow-origin') === '*', JSON.stringify(d));
r = await get('/api/quest/ask?quest=lq1-a');
check('one of the quest\'s codes finds the same question', (await r.json()).kind === 'choice', '');
r = await jpost('/api/quest/ask', { quest: 'LQ1', choice: 'Green' }, sessA);
check('an option that is not on offer is refused', r.status === 400, 'status=' + r.status);
r = await jpost('/api/quest/ask', { quest: 'LQ2', choice: 'Red' }, sessA);
check('a quest asking nothing takes no answer', r.status === 404, 'status=' + r.status);
r = await jpost('/api/quest/ask', { quest: 'LQ1', choice: 'Red' }, sessA);
d = await r.json();
check('a team presses a button', r.status === 200 && d.ok && d.choice === 'Red' && d.amount === 0, JSON.stringify(d));
r = await jpost('/api/quest/ask', { quest: 'LQ1', choice: 'Blue' }, sessA);
check('and may change its mind while the question is open', (await r.json()).choice === 'Blue', '');
await jpost('/api/quest/ask', { quest: 'lq1-a', choice: 'Red' }, sessB);
check('one row per team, however many times they answer',
  raw.prepare('SELECT COUNT(*) AS n FROM quest_responses r JOIN quest_groups g ON g.id = r.group_id WHERE g.key = ?')
    .get('LQ1').n === 2, '');
r = await get('/api/quest/ask?quest=LQ1', sessA);
d = await r.json();
check('a signed-in team reads its own answer back',
  d.response && d.response.choice === 'Blue' && d.open === true, JSON.stringify(d.response));
r = await get('/api/quest/ask?quest=LQ1');
check('and nobody else sees it', (await r.json()).response === null, '');

// ---------------- a sealed number ----------------
await jpost('/api/console/quests/group/ask/save', {
  key: 'LQ2', kind: 'number', prompt: 'Your bid', open: true
}, sess);
for (const bad of [-1, 1.5, 100001, 'lots', undefined]) {
  r = await jpost('/api/quest/ask', { quest: 'LQ2', amount: bad }, sessA);
  check('a bid of ' + JSON.stringify(bad) + ' is refused', r.status === 400, 'status=' + r.status);
}
r = await jpost('/api/quest/ask', { quest: 'LQ2', amount: 250, choice: 'ignored' }, sessA);
d = await r.json();
check('a number answer stores the number and no choice', d.ok && d.amount === 250 && d.choice === '', JSON.stringify(d));
await jpost('/api/quest/ask', { quest: 'LQ2', amount: 0 }, sessB);
check('zero is a bid like any other',
  raw.prepare("SELECT amount, choice FROM quest_responses r JOIN quest_groups g ON g.id = r.group_id WHERE g.key = 'LQ2' AND r.team_id = ?")
    .get(teamB.id).amount === 0, '');

// ---------------- a typed answer ----------------
await jpost('/api/console/quests/group/ask/save', {
  key: 'LQ3', kind: 'text', prompt: 'Where was this taken?', open: true
}, sess);
r = await get('/api/quest/ask?quest=LQ3');
check('a text question needs no options', (await r.json()).kind === 'text', '');
r = await jpost('/api/quest/ask', { quest: 'LQ3', choice: '   ' }, sessA);
check('an empty answer is refused', r.status === 400, 'status=' + r.status);
r = await jpost('/api/quest/ask', { quest: 'LQ3', choice: 'x'.repeat(250) }, sessA);
check('an answer over 200 characters is refused rather than cut short',
  r.status === 400 && /200 characters/.test((await r.json()).error), 'status=' + r.status);
r = await jpost('/api/quest/ask', { quest: 'LQ3', choice: 'Wynyard, under the wooden escalators' }, sessA);
d = await r.json();
check('a typed answer is stored as written',
  d.ok && d.choice === 'Wynyard, under the wooden escalators' && d.amount === 0, JSON.stringify(d));
r = await get('/api/quest/ask?quest=LQ3', sessA);
d = await r.json();
check('and reads back the same way',
  d.response.choice === 'Wynyard, under the wooden escalators' && d.response.amount === 0, JSON.stringify(d.response));
await jpost('/api/quest/ask', { quest: 'LQ3', choice: 'Town Hall' }, sessB);

r = await jpost('/api/console/quests/group/ask/responses', { key: 'LQ3' }, sess);
d = await r.json();
const first = d.responses.find(x => x.team === teamA.name);
check('the text answers come back with who said what and when',
  d.kind === 'text' && d.total === 2 && d.counts.length === 0 &&
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(first.updated_at) &&
  first.choice === 'Wynyard, under the wooden escalators', JSON.stringify(d.responses));

// ---------------- what the organisers see ----------------
r = await jpost('/api/console/quests/group/ask/responses', { key: 'LQ1' }, sess);
d = await r.json();
check('a choice question tallies every option, teams named and flagged',
  d.kind === 'choice' && d.total === 2 && d.counts.length === 2 &&
  d.counts[0].choice === 'Red' && d.counts[0].teams === 1 && d.counts[1].choice === 'Blue' &&
  d.counts[1].teams === 1 && d.responses.every(x => typeof x.team === 'string' && x.hidden === 0),
  JSON.stringify(d.counts));
r = await jpost('/api/console/quests/group/ask/responses', { key: 'LQ2' }, sess);
d = await r.json();
check('a number question sums the answers under one blank row',
  d.counts.length === 1 && d.counts[0].choice === '' && d.counts[0].teams === 2 && d.counts[0].points === 250,
  JSON.stringify(d.counts));
r = await jpost('/api/console/quests/group/ask/responses', { key: 'NOPE' }, sess);
check('responses for a quest that is not there is a 404', r.status === 404, 'status=' + r.status);
{
  const was = (await (await get('/api/pulse')).json()).quests;
  await jpost('/api/console/quests/group/ask/responses', { key: 'LQ1' }, sess);
  check('reading the responses changes nothing, so the counter stays put',
    (await (await get('/api/pulse')).json()).quests === was, 'was ' + was);
}

// ---------------- the casino ----------------
async function points(name) {
  const board = await (await get('/api/leaderboard')).json();
  const row = board.teams.find(t => t.name === name);
  return row ? row.points : 0;
}
async function wager(key, options) {
  await jpost('/api/console/quests/group/ask/save', {
    key: key, kind: 'wager', prompt: 'Red or black?', options: options, open: true
  }, sess);
}

// a code worth one point: the amount written is the stake itself
await wager('LQ4', ['Red', 'Black']);
r = await jpost('/api/quest/ask', { quest: 'LQ4', choice: 'Red' }, sessA);
check('a wager needs a stake', r.status === 400, 'status=' + r.status);
r = await jpost('/api/quest/ask', { quest: 'LQ4', choice: 'Red', amount: 0 }, sessA);
check('staking nothing is refused', r.status === 400, 'status=' + r.status);
r = await jpost('/api/quest/ask', { quest: 'LQ4', choice: 'Red', amount: 30.5 }, sessA);
check('so is half a point', r.status === 400, 'status=' + r.status);
r = await jpost('/api/quest/ask', { quest: 'LQ4', choice: 'Green', amount: 30 }, sessA);
check('and a colour that is not on the table', r.status === 400, 'status=' + r.status);
r = await jpost('/api/quest/ask', { quest: 'LQ4', choice: 'Red', amount: 30 }, sessA);
check('a team stakes 30 on red', (await r.json()).amount === 30, '');
await jpost('/api/quest/ask', { quest: 'LQ4', choice: 'Black', amount: 30 }, sessB);

r = await jpost('/api/console/quests/group/ask/settle', { key: 'LQ1', winner: 'Red' }, sess);
check('only a wager can be settled', r.status === 400 && /wager/.test((await r.json()).error), 'status=' + r.status);
r = await jpost('/api/console/quests/group/ask/settle', { key: 'LQ4', winner: 'Purple' }, sess);
check('the winning option has to be one of the options', r.status === 400, 'status=' + r.status);

const beforeA = await points(teamA.name);
const beforeB = await points(teamB.name);
r = await jpost('/api/console/quests/group/ask/settle', { key: 'LQ4', winner: 'Red' }, sess);
d = await r.json();
check('settling answers with how many were settled and what won',
  r.status === 200 && d.ok && d.settled === 2 && d.winner === 'Red', JSON.stringify(d));
check('the winner gains exactly what it staked and the loser loses it',
  Math.round((await points(teamA.name) - beforeA) * 100) / 100 === 30 &&
  Math.round((await points(teamB.name) - beforeB) * 100) / 100 === -30,
  JSON.stringify({ a: await points(teamA.name) - beforeA, b: await points(teamB.name) - beforeB }));
check('on a one-point code the amount written is the stake itself',
  raw.prepare('SELECT amount FROM held WHERE team_id = ? AND quest_code = ?').get(teamA.id, 'LQ4').amount === 30 &&
  raw.prepare('SELECT amount FROM held WHERE team_id = ? AND quest_code = ?').get(teamB.id, 'LQ4').amount === -30, '');
// a wager pays out once: a second press, or a change of mind about who
// won, moves nothing
{
  const settledA = await points(teamA.name);
  const settledB = await points(teamB.name);
  const again = await jpost('/api/console/quests/group/ask/settle', { key: 'LQ4', winner: 'Red' }, sess);
  const other = await jpost('/api/console/quests/group/ask/settle', { key: 'LQ4', winner: 'Black' }, sess);
  check('settling a wager again, on the same winner or another, is refused and moves nothing',
    again.status === 409 && other.status === 409 && /settled on Red/.test((await other.json()).error) &&
    await points(teamA.name) === settledA && await points(teamB.name) === settledB, 'status=' + again.status + ',' + other.status);
  const resp = await (await jpost('/api/console/quests/group/ask/responses', { key: 'LQ4' }, sess)).json();
  check('and the dashboard is told what it was settled on and by whom',
    resp.settled && resp.settled.winner === 'Red' && !!resp.settled.by && resp.settled.undoable === true, JSON.stringify(resp.settled));
  // taken back, every team is moved back once, and it can be settled again
  const unsettles = await Promise.all([
    jpost('/api/console/quests/group/ask/unsettle', { key: 'LQ4' }, sess),
    jpost('/api/console/quests/group/ask/unsettle', { key: 'LQ4' }, sess)
  ]);
  const backA = await points(teamA.name), backB = await points(teamB.name);
  const cleared = await (await jpost('/api/console/quests/group/ask/responses', { key: 'LQ4' }, sess)).json();
  const noRows = !raw.prepare("SELECT 1 FROM held WHERE quest_code = 'LQ4'").get();
  const resettled = await jpost('/api/console/quests/group/ask/settle', { key: 'LQ4', winner: 'Red' }, sess);
  check('a settlement can be taken back once, leaving every team as it was, and settled again',
    unsettles.map(x => x.status).sort().join() === '200,409' && backA === beforeA && backB === beforeB && !cleared.settled && noRows &&
    resettled.status === 200 && await points(teamA.name) === settledA && await points(teamB.name) === settledB,
    JSON.stringify({ unsettles: unsettles.map(x => x.status), backA, beforeA, backB, beforeB, settled: cleared.settled, again: resettled.status }));
}
r = await get('/api/quest/ask?quest=LQ4');
check('settled, the question leaves the public read', (await r.json()).kind === '', '');
r = await get('/api/quest/ask?quest=LQ4', sessA);
d = await r.json();
check('but a team that wagered still reads its answer back',
  d.kind === 'wager' && d.open === false && d.response && d.response.choice === 'Red' &&
  d.response.amount === 30, JSON.stringify(d));
r = await jpost('/api/quest/ask', { quest: 'LQ4', choice: 'Red', amount: 5 }, sessA);
check('and takes no more answers', r.status === 409, 'status=' + r.status);

// a code worth two points: the amount is halved so the points still land on the nose
await wager('LQ5', ['Red', 'Black']);
await jpost('/api/quest/ask', { quest: 'LQ5', choice: 'Red', amount: 40 }, sessA);
await jpost('/api/quest/ask', { quest: 'LQ5', choice: 'Black', amount: 10 }, sessB);
const before2A = await points(teamA.name);
const before2B = await points(teamB.name);
r = await jpost('/api/console/quests/group/ask/settle', { key: 'LQ5', winner: 'Black' }, sess);
check('the second casino settles', (await r.json()).settled === 2, '');
check('the standings move by the points staked whatever the code is worth',
  Math.round((await points(teamA.name) - before2A) * 100) / 100 === -40 &&
  Math.round((await points(teamB.name) - before2B) * 100) / 100 === 10,
  JSON.stringify({ a: await points(teamA.name) - before2A, b: await points(teamB.name) - before2B }));
check('which means half the amount on a two-point code',
  raw.prepare('SELECT amount FROM held WHERE team_id = ? AND quest_code = ?').get(teamA.id, 'LQ5').amount === -20 &&
  raw.prepare('SELECT amount FROM held WHERE team_id = ? AND quest_code = ?').get(teamB.id, 'LQ5').amount === 5, '');

// a code worth nothing cannot carry a wager
await wager('LQ6', ['Red', 'Black']);
await jpost('/api/quest/ask', { quest: 'LQ6', choice: 'Red', amount: 10 }, sessA);
r = await jpost('/api/console/quests/group/ask/settle', { key: 'LQ6', winner: 'Red' }, sess);
check('a wager on a code worth 0 points is refused, not silently lost',
  r.status === 400 && /0 points/.test((await r.json()).error), 'status=' + r.status);
check('and nothing was written for it',
  raw.prepare('SELECT COUNT(*) AS n FROM held WHERE quest_code = ?').get('LQ6').n === 0, '');

// a settled wager stays shut until the settlement is undone, from the
// desk or from the list, and a question teams have answered keeps its
// kind: LQ2's numbers read as stakes would each be taken off the team
{
  const fromDesk = await jpost('/api/console/quests/group/ask/open', { key: 'LQ4', open: true }, sess);
  const fromList = await jpost('/api/console/quests/group/ask/save', {
    key: 'LQ4', kind: 'wager', prompt: 'Red or black?', options: ['Red', 'Black'], open: true
  }, sess);
  const deskSaid = (await fromDesk.json()).error || '';
  const kindChange = await jpost('/api/console/quests/group/ask/save', { key: 'LQ2', kind: 'wager', prompt: 'Your bid', options: ['Yes', 'No'] }, sess);
  check('a settled wager is not opened again until its settlement is undone, and an answered question cannot change kind',
    fromDesk.status === 409 && fromList.status === 409 && /Undo the settlement/.test(deskSaid) &&
    raw.prepare("SELECT ask_open FROM quest_groups WHERE key = 'LQ4'").get().ask_open === 0 &&
    kindChange.status === 409 && raw.prepare("SELECT ask_kind FROM quest_groups WHERE key = 'LQ2'").get().ask_kind === 'number',
    JSON.stringify({ desk: fromDesk.status, list: fromList.status, kind: kindChange.status }));
}

// a question taken off and another put on starts with no answers, rather
// than refusing the new one because of answers to the one that went
{
  const off = await jpost('/api/console/quests/group/ask/save', { key: 'LQ6', kind: '' }, sess);
  const kept = raw.prepare("SELECT COUNT(*) AS n FROM quest_responses r JOIN quest_groups g ON g.id = r.group_id WHERE g.key = 'LQ6'").get().n;
  const on = await jpost('/api/console/quests/group/ask/save', { key: 'LQ6', kind: 'number', prompt: 'How many?' }, sess);
  check('a new question after one was taken off is saved, and the old answers go with the old question',
    off.status === 200 && kept === 1 && on.status === 200 &&
    raw.prepare("SELECT ask_kind FROM quest_groups WHERE key = 'LQ6'").get().ask_kind === 'number' &&
    raw.prepare("SELECT COUNT(*) AS n FROM quest_responses r JOIN quest_groups g ON g.id = r.group_id WHERE g.key = 'LQ6'").get().n === 0,
    JSON.stringify({ off: off.status, kept: kept, on: on.status }));
}

// ---------------- what teams see of each other's answers ----------------
// A question can show teams how many picked each option, or every
// team's answer: once it closes, or while it is open too. Hidden teams
// are test runs and stay out of it, and the reader's own answer is
// marked by the worker rather than matched by name on the page.
{
  await makeQuest('LQ8', 'Left or right', [{ code: 'LQ8', label: '', points: 1 }]);
  await makeQuest('LQ9', 'Asked later', [{ code: 'LQ9', label: '', points: 1 }]);
  const more = raw.prepare('SELECT id, name FROM teams WHERE hidden = 0 ORDER BY id LIMIT 2 OFFSET 2').all();
  const teamC = more[0]; // answers, then is hidden as a test run
  const sessC = await teamLogin(teamC);
  const sessD = await teamLogin(more[1]); // never answers
  const ask8 = extra => jpost('/api/console/quests/group/ask/save', Object.assign({
    key: 'LQ8', kind: 'choice', prompt: 'Left or right?', options: ['Left', 'Right'], open: true
  }, extra), sess);
  const read8 = async token => (await get('/api/quest/ask?quest=LQ8', token)).json();

  await ask8({});
  await jpost('/api/quest/ask', { quest: 'LQ8', choice: 'Left' }, sessA);
  await jpost('/api/quest/ask', { quest: 'LQ8', choice: 'Right' }, sessB);
  await jpost('/api/quest/ask', { quest: 'LQ8', choice: 'Right' }, sessC);
  raw.prepare('UPDATE teams SET hidden = 1 WHERE id = ?').run(teamC.id);
  const offOpen = await read8(sessA);
  await ask8({ open: false });
  const offClosed = await read8(sessA);
  check('a question that shows nothing of the others answers no results, open or closed',
    offOpen.kind === 'choice' && !('results' in offOpen) && offClosed.response.choice === 'Left' && !('results' in offClosed),
    JSON.stringify({ offOpen, offClosed }));

  r = await ask8({ reveal: 'tally' });
  d = await r.json();
  const dash8 = (await (await get('/api/console/quests', sess)).json()).groups.find(g => g.key === 'LQ8');
  check('what it shows comes back on the save and on the dashboard\'s quest list',
    d.ask.reveal === 'tally' && d.ask.reveal_live === false && dash8.ask.reveal === 'tally' && dash8.ask.reveal_live === false,
    JSON.stringify({ saved: d.ask, dash: dash8.ask }));
  check('a tally is not shown while the question is open', !('results' in await read8(sessA)), '');

  await ask8({ reveal: 'tally', open: false });
  const tally = (await read8(sessA)).results;
  check('once it closes the tally lists every option, the reader\'s own pick marked',
    tally && tally.counts.length === 2 && tally.counts[0].choice === 'Left' && tally.counts[0].teams === 1 &&
    tally.counts[0].mine === true && tally.counts[1].choice === 'Right' && !tally.counts[1].mine && !('answers' in tally),
    JSON.stringify(tally));
  check('a hidden team\'s answer is left out of the count',
    tally && tally.total === 2 && tally.counts[1].teams === 1, JSON.stringify(tally));

  await ask8({ reveal: 'tally', reveal_live: true });
  const live = await (await get('/api/quest/ask?quest=LQ8')).json();
  check('with While it is open too, the tally shows while the question is open',
    live.open === true && live.results && live.results.total === 2, JSON.stringify(live.results));

  await ask8({ reveal: 'answers', open: false });
  const every = (await read8(sessB)).results;
  check('every team\'s answer is listed by team, the reader\'s own marked and no hidden team in it',
    every && JSON.stringify(every.answers) === JSON.stringify([
      { team: teamA.name, choice: 'Left', amount: 0 }, { team: teamB.name, choice: 'Right', amount: 0, mine: true }
    ].sort((x, y) => x.team.toLowerCase() < y.team.toLowerCase() ? -1 : 1)), JSON.stringify(every));

  const stranger = await read8(sessD);
  check('a team that never answered reads the closed question and its answers',
    stranger.kind === 'choice' && stranger.prompt === 'Left or right?' && stranger.response === null &&
    stranger.results.total === 2 && stranger.results.answers.every(a => !a.mine) &&
    stranger.results.counts.every(c => !c.mine), JSON.stringify(stranger));

  await jpost('/api/console/quests/group/ask/save', {
    key: 'LQ9', kind: 'choice', prompt: 'Not asked yet', options: ['Yes', 'No'], open: false, reveal: 'answers'
  }, sess);
  const early = await (await get('/api/quest/ask?quest=LQ9', sessD)).json();
  check('a question written ahead that shows its answers still reads as none until teams have answered it',
    early.kind === '' && early.prompt === undefined, JSON.stringify(early));

  await jpost('/api/console/quests/group/ask/save', {
    key: 'LQ5', kind: 'wager', prompt: 'Red or black?', options: ['Red', 'Black'], open: false, reveal: 'tally'
  }, sess);
  const wagered = (await (await get('/api/quest/ask?quest=LQ5')).json()).results;
  check('a settled wager\'s tally names the winner and the points staked on each side',
    wagered && wagered.winner === 'Black' && wagered.counts[0].choice === 'Red' && wagered.counts[0].points === 40 &&
    wagered.counts[1].points === 10, JSON.stringify(wagered));

  raw.prepare('UPDATE teams SET hidden = 0 WHERE id = ?').run(teamC.id);
}

const actions = (await (await get('/api/console/log?limit=60', sess)).json()).entries.map(e => e.action);
check('every organiser action is in the log, the settle included',
  ['ask-settle', 'quest-ask', 'quest-files'].every(a => actions.includes(a)),
  JSON.stringify([...new Set(actions)]));

// ---------------- a question survives everything else ----------------
// The one write path for a quest must not know about the ask columns:
// an ordinary save, and a re-import of the same quest from a file,
// both leave the question and the files exactly as they were.
r = await jpost('/api/console/quests/group/save', {
  id: raw.prepare('SELECT id FROM quest_groups WHERE key = ?').get('LQ1').id,
  key: 'LQ1', name: 'Red or blue', region: 'Live Region',
  description: 'Edited while the question was open.',
  codes: [{ was: 'LQ1-A', code: 'LQ1-A', label: '', points: 5 }]
}, sess);
check('the quest saves', (await r.json()).ok === true, '');
r = await get('/api/quest/ask?quest=LQ1');
d = await r.json();
check('an ordinary save leaves the question alone',
  d.kind === 'choice' && d.prompt === 'Red door or blue door?' && d.open === true &&
  d.options.join('|') === 'Red|Blue', JSON.stringify(d));

r = await jpost('/api/console/quests/file/commit', {
  text: JSON.stringify({ quests: [{
    code: 'LQ1', name: 'Red or blue, re-imported', region: 'Live Region',
    description: 'From a file.', codes: [{ code: 'LQ1-A', label: '', points: 5 }]
  }] })
}, sess);
d = await r.json();
check('a file import updates the quest', r.status === 200 && d.updated === 1, JSON.stringify(d));
r = await get('/api/quest/ask?quest=LQ1');
d = await r.json();
check('and the question is still there afterwards',
  d.kind === 'choice' && d.prompt === 'Red door or blue door?' && d.open === true, JSON.stringify(d));
r = await get('/api/questlist');
lq1 = (await r.json()).groups.find(g => g.key === 'LQ1');
check('so are its files, and the new name took',
  lq1.name === 'Red or blue, re-imported' && lq1.files.length === 2, JSON.stringify(lq1.files.length));
check('the answers teams gave are untouched too',
  raw.prepare('SELECT COUNT(*) AS n FROM quest_responses r JOIN quest_groups g ON g.id = r.group_id WHERE g.key = ?')
    .get('LQ1').n === 2, '');

// ---------------- a frozen tab still runs the quest ----------------
r = await jpost('/api/console/freeze', { frozen: true }, sess);
check('the tab freezes', (await r.json()).frozen === true, '');
check('the standings serve the copy taken at the freeze',
  (await (await get('/api/leaderboard')).json()).frozen === true, '');
r = await get('/api/quest/ask?quest=LQ3', sessB);
d = await r.json();
check('a live question still answers while the tab is frozen',
  r.status === 200 && d.kind === 'text' && d.frozen === undefined && d.response.choice === 'Town Hall',
  JSON.stringify(d));
r = await jpost('/api/quest/ask', { quest: 'LQ3', choice: 'Museum, by the lift' }, sessB);
check('and teams can still answer it',
  r.status === 200 && (await r.json()).choice === 'Museum, by the lift', 'status=' + r.status);
r = await front('/api/quests/file?key=' + encodeURIComponent(questFiles[0].key));
check('the files a quest is about still serve while the tab is frozen',
  r.status === 200 && (await r.arrayBuffer()).byteLength === png.length, 'status=' + r.status);
await jpost('/api/console/freeze', { frozen: false }, sess);

// ---------------- taking a file off again ----------------
r = await jpost('/api/console/quests/group/file/delete', { key: 'qst/not-a-real-key' }, sess);
check('removing a file that is not there says so', r.status === 404, 'status=' + r.status);
r = await jpost('/api/console/quests/group/file/delete', { key: questFiles[0].key }, sess);
check('a file comes off the quest, bytes and preview with it',
  (await r.json()).ok === true && !bucket.has(questFiles[0].key) && !bucket.has(questFiles[0].key + '.t') &&
  raw.prepare('SELECT COUNT(*) AS n FROM quest_files').get().n === 1, '');
r = await front('/api/quests/file?key=' + encodeURIComponent(questFiles[0].key));
check('and stops serving', r.status === 404, 'status=' + r.status);
r = await get('/api/questlist');
check('the site sees the quest with its remaining file',
  (await r.json()).groups.find(g => g.key === 'LQ1').files.length === 1, '');

// ---------------- a file sent straight to R2 ----------------
// With the R2 token set the dashboard sends a quest's file to the
// bucket first and the save names it by id (src/staged.ts). The bucket
// is tests/pretend-r2.mjs, so the slice goes to an address the worker
// signed.
{
  const r2 = pretendR2();
  const denv = Object.assign({}, ENV, { SUBMIT: r2.SUBMIT }, r2.env);
  const dfront = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), denv, { waitUntil() {} });
  const auth = { authorization: 'Bearer ' + sess };
  const djson = { 'content-type': 'application/json', authorization: 'Bearer ' + sess };
  const start = await (await dfront('/api/console/upload/start', { method: 'POST', headers: djson,
    body: JSON.stringify({ purpose: 'qst', name: 'clue.png', type: 'image/png', size: png.length }) })).json();
  const signed = await (await dfront('/api/console/upload/sign?id=' + start.id + '&n=1', { headers: auth })).json();
  await fetch(signed.url, { method: 'PUT', body: png });
  await dfront('/api/console/upload/finish', { method: 'POST', headers: djson, body: JSON.stringify({ id: start.id }) });
  const key = raw.prepare('SELECT r2_key FROM staged_uploads WHERE id = ?').get(start.id).r2_key;

  const f = new FormData();
  f.append('key', 'LQ2');
  f.append('staged0', String(start.id));
  f.append('thumb0', file('thumb.jpg', 'image/jpeg', thumbJpeg), 'thumb.jpg');
  const saved = await (await dfront('/api/console/quests/group/files', { method: 'POST', headers: auth, body: f })).json();
  const whole = await dfront('/api/quests/file?key=' + encodeURIComponent(key));
  const small = await dfront('/api/quests/file?key=' + encodeURIComponent(key) + '&thumb=1');
  check('a file sent straight to R2 and saved by its id is the quest\'s file where it already is, its small copy beside it',
    saved.ok && saved.files.length === 1 && saved.files[0].key === key && saved.files[0].name === 'clue.png' &&
    saved.files[0].bytes === png.length && !raw.prepare('SELECT id FROM staged_uploads WHERE id = ?').get(start.id) &&
    whole.status === 200 && (await whole.arrayBuffer()).byteLength === png.length &&
    small.status === 200 && (await small.arrayBuffer()).byteLength === thumbJpeg.length &&
    r2.seen.part === 1 && r2.seen.refused === 0,
    JSON.stringify({ saved, whole: whole.status, small: small.status }));
  r2.restore();
}

// ---------------- the list of polls and wagers, and the desk ----------------
r = await get('/api/console/quests/asks', sess);
d = await r.json();
const asking = raw.prepare("SELECT key FROM quest_groups WHERE ask_kind != '' ORDER BY key").all().map(x => x.key);
const lq1Answers = raw.prepare('SELECT COUNT(*) AS n FROM quest_responses r JOIN teams t ON t.id = r.team_id ' +
  'JOIN quest_groups g ON g.id = r.group_id WHERE g.key = ? AND t.hidden = 0').get('LQ1').n;
const listed = key => d.asks.find(a => a.key === key) || {};
check('the list of polls and wagers is every quest that asks something, with how many teams answered and a wager\'s settlement',
  r.status === 200 && d.asks.map(a => a.key).sort().join() === asking.slice().sort().join() &&
  listed('LQ1').kind === 'choice' && listed('LQ1').answers === lq1Answers && listed('LQ1').settled === null &&
  listed('LQ4').kind === 'wager' && listed('LQ4').settled && listed('LQ4').settled.winner === 'Red',
  JSON.stringify(d.asks.map(a => [a.key, a.kind, a.answers, a.settled && a.settled.winner])));

// the words saved again leave whether it is taking answers alone
await jpost('/api/console/quests/group/ask/save', { key: 'LQ1', kind: 'choice', prompt: 'Red door or blue door?', options: ['Red', 'Blue'], open: true, open_until: '' }, sess);
r = await jpost('/api/console/quests/group/ask/save', { key: 'LQ1', kind: 'choice', prompt: 'Red or blue?', options: ['Red', 'Blue'] }, sess);
d = await r.json();
check('saving the words without the switch leaves the question taking answers',
  d.ok && d.ask.prompt === 'Red or blue?' && d.ask.open === true, JSON.stringify(d));

await jpost('/api/console/accounts/save', { create: true, name: 'Desk LQ1', password: 'desk-pass-one', perms: ['points'], quests: ['LQ1'], require_2fa: false }, sess);
await jpost('/api/console/accounts/save', { create: true, name: 'Reader', password: 'reader-pass-one', perms: ['review'], require_2fa: false }, sess);
const deskOne = (await (await jpost('/api/console/login', { name: 'Desk LQ1', password: 'desk-pass-one' })).json()).session;
const reader = (await (await jpost('/api/console/login', { name: 'Reader', password: 'reader-pass-one' })).json()).session;
const later = new Date(Date.now() + 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const closed = await (await jpost('/api/console/quests/group/ask/open', { key: 'LQ1', open: false }, deskOne)).json();
const answerClosed = await jpost('/api/quest/ask', { quest: 'LQ1', choice: 'Red' }, sessA);
const reopened = await (await jpost('/api/console/quests/group/ask/open', { key: 'LQ1', open: true, open_until: later }, deskOne)).json();
const answerOpen = await jpost('/api/quest/ask', { quest: 'LQ1', choice: 'Red' }, sessA);
check('the desk of an account that scores the quest stops and starts the answers, with a time it closes at, and the words stay as they were',
  closed.ok && closed.ask.open === false && answerClosed.status === 409 &&
  reopened.ok && reopened.ask.open === true && reopened.ask.open_until === later + ':00' && answerOpen.status === 200 &&
  raw.prepare("SELECT ask_prompt FROM quest_groups WHERE key = 'LQ1'").get().ask_prompt === 'Red or blue?',
  JSON.stringify({ closed, reopened, answerClosed: answerClosed.status }));

const refusedOpen = await Promise.all([
  jpost('/api/console/quests/group/ask/open', { key: 'LQ4', open: true }, deskOne),
  jpost('/api/console/quests/group/ask/open', { key: 'LQ1', open: true }, reader),
  jpost('/api/console/quests/group/ask/open', { key: 'LQ7', open: true }, sess),
  jpost('/api/console/quests/group/ask/open', { key: 'LQ1', open: true, open_until: '2020-01-01 09:00' }, sess),
  get('/api/console/quests/asks', deskOne)
]);
check('it refuses another quest\'s desk, an account without the desk, a quest that asks nothing and a time already past, and the list is the Quests tab\'s',
  refusedOpen.map(x => x.status).join() === '403,403,409,400,403' &&
  raw.prepare("SELECT ask_open FROM quest_groups WHERE key = 'LQ7'").get().ask_open === 0,
  refusedOpen.map(x => x.status).join());

// an account that scores LQ1 alone cannot read, settle or undo LQ4's wager
await jpost('/api/console/accounts/save', { create: true, name: 'Scores LQ1', password: 'scores-pass-one', perms: ['scores'], quests: ['LQ1'], require_2fa: false }, sess);
const scoresOne = (await (await jpost('/api/console/login', { name: 'Scores LQ1', password: 'scores-pass-one' })).json()).session;
const awardBefore = raw.prepare("SELECT id, voided_at FROM awards WHERE kind = 'wager' AND voided_at IS NULL AND group_id = (SELECT id FROM quest_groups WHERE key = 'LQ4')").get();
const refusedWager = await Promise.all([
  jpost('/api/console/quests/group/ask/unsettle', { key: 'LQ4' }, scoresOne),
  jpost('/api/console/quests/group/ask/responses', { key: 'LQ4' }, scoresOne)
]);
const refusedSettle = await jpost('/api/console/quests/group/ask/settle', { key: 'LQ4', winner: 'Black' }, scoresOne);
const awardAfter = raw.prepare("SELECT id, voided_at FROM awards WHERE kind = 'wager' AND voided_at IS NULL AND group_id = (SELECT id FROM quest_groups WHERE key = 'LQ4')").get();
check('an account limited to other quests cannot undo, read or settle a quest\'s wager',
  refusedWager.map(x => x.status).join() === '403,403' && refusedSettle.status === 403 &&
  !!awardBefore && !!awardAfter && awardAfter.id === awardBefore.id,
  JSON.stringify({ refused: refusedWager.map(x => x.status), settle: refusedSettle.status, awardBefore, awardAfter }));

// ---------------- turning a question off ----------------
r = await jpost('/api/console/quests/group/ask/save', { key: 'LQ1', kind: '' }, sess);
check('a question can be taken off a quest', (await r.json()).ask.kind === '', '');
r = await get('/api/questlist');
check('and the site goes back to seeing none',
  (await r.json()).groups.find(g => g.key === 'LQ1').ask === null, '');
r = await get('/api/quest/ask?quest=LQ1');
check('the public read says so too', (await r.json()).kind === '', '');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
