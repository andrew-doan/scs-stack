// Run with: node tests/verify-visibility.mjs   (needs Node 22+ for node:sqlite)
// Who can see a quest, end to end against the real worker: the public
// list, a signed-in team's list, the team groups, a quest that opens by
// itself at its time, tags opened together, everything opened at once,
// and the other ways a quest could be read — the stats feed, the submit
// form, the question a quest asks and Discord's code suggestions. Plus
// the migration that files the quests hidden before this as Old.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
import { credit } from './ledger-fixture.mjs';
import { statements, alreadyApplied } from '../scripts/migrate.mjs';

const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

// ---------------- the migration ----------------
// A database from before: quests hidden the old way go under Old, once.
// The runner reruns migrations, and on a rerun a quest hidden since (a
// bonus quest waiting to drop) must not be filed as Old with them.
{
  const old = new DatabaseSync(':memory:');
  old.exec(`CREATE TABLE quest_groups (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0)`);
  old.prepare('INSERT INTO quest_groups (key, name, hidden) VALUES (?, ?, ?)').run('OLD1', 'Retired', 1);
  old.prepare('INSERT INTO quest_groups (key, name, hidden) VALUES (?, ?, ?)').run('NEW1', 'Showing', 0);
  const sql = readFileSync(BOT + '/migrations/2026-10-visibility.sql', 'utf8');
  const run = () => {
    for (const stmt of statements(sql)) {
      try { old.exec(stmt); } catch (err) { if (!alreadyApplied(err.message)) throw err; }
    }
  };
  run();
  old.prepare('INSERT INTO quest_groups (key, name, hidden) VALUES (?, ?, ?)').run('BONUS1', 'Waiting to drop', 1);
  run();
  const tag = old.prepare("SELECT id, dash_hidden FROM quest_tags WHERE name = 'Old'").get();
  const filed = old.prepare('SELECT g.key FROM quest_group_tags gt JOIN quest_groups g ON g.id = gt.group_id WHERE gt.tag_id = ?')
    .all(tag ? tag.id : 0).map(r => r.key);
  const showing = old.prepare("SELECT visibility, opens_at FROM quest_groups WHERE key = 'NEW1'").get();
  check('the migration files the quests hidden before it as Old, hidden from the dashboard, once only',
    !!tag && tag.dash_hidden === 1 && filed.join() === 'OLD1' && showing.visibility === 'everyone' && showing.opens_at === '',
    JSON.stringify({ tag, filed, showing }));
}

// ---------------- the worker ----------------
const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };
const mod = await import(BOT + '/src/index.ts');
// a bucket that takes nothing: the submit form checks for one before it
// reads the quest
const ENV = { DB: db, CONSOLE_PASSWORD: 'tab-pass', SUBMIT: { async put() {}, async get() { return null; }, async delete() {} } };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
const sess = (await consoleSignIn(jpost, 'Runner', 'tab-pass')).session;

async function makeQuest(key, hidden) {
  const r = await jpost('/api/console/quests/group/save', {
    key, name: 'Quest ' + key, region: 'Access', hidden: hidden ? 1 : 0, codes: [{ code: key, label: '', points: 10 }]
  }, sess);
  return (await r.json()).group.id;
}
const id = {};
for (const k of ['VQ1', 'VQ2', 'VQ3', 'VQ5', 'VQ6', 'VQ7']) id[k] = await makeQuest(k, false);
id.VQ4 = await makeQuest('VQ4', true);

await jpost('/api/console/codes/generate', {}, sess);
const codeList = (await (await get('/api/console/codes', sess)).json()).codes;
const teams = raw.prepare('SELECT id, name FROM teams WHERE hidden = 0 ORDER BY id LIMIT 2').all();
async function teamLogin(team) {
  const code = codeList.find(c => c.name === team.name).code;
  return (await (await jpost('/api/submit/login', { team_name: team.name, code })).json()).session;
}
const sessA = await teamLogin(teams[0]);
const sessB = await teamLogin(teams[1]);

let r = await jpost('/api/console/quests/team-groups/save', { name: 'Preview', team_ids: [teams[0].id] }, sess);
const preview = (await r.json()).id;
const access = async (key, body) => (await jpost('/api/console/quests/group/access', Object.assign({ id: id[key] }, body), sess)).json();
await access('VQ2', { visibility: 'teams' });
await access('VQ3', { visibility: 'groups', audiences: [preview] });
const past = '2020-01-01 09:00:00';
await access('VQ5', { visibility: 'organisers', opens_at: past });
await access('VQ6', { visibility: 'teams', tags: ['Wave 1'] });
await access('VQ7', { visibility: 'organisers', tags: ['Old stock'] });

const keysOf = (d) => (d.groups || []).map(g => g.key).filter(k => /^VQ/.test(k)).sort().join(' ');
const counterBefore = raw.prepare("SELECT value FROM counters WHERE name = 'quests'").get();

// ---------------- the lists ----------------
r = await get('/api/questlist');
let pub = await r.json();
check('the public list has what everyone may see, and a quest whose time has come, and says there is more',
  keysOf(pub) === 'VQ1 VQ5' && pub.more === true, keysOf(pub) + ' more=' + pub.more);
const opened = raw.prepare("SELECT hidden, visibility, opens_at FROM quest_groups WHERE key = 'VQ5'").get();
const counterAfter = raw.prepare("SELECT value FROM counters WHERE name = 'quests'").get();
check('opening on time takes the time off, records it and moves the quests counter',
  opened.hidden === 0 && opened.visibility === 'everyone' && opened.opens_at === '' &&
  (counterAfter ? counterAfter.value : 0) > (counterBefore ? counterBefore.value : 0) &&
  !!raw.prepare("SELECT 1 FROM submission_log WHERE action = 'quest-open' AND actor = 'schedule'").get(),
  JSON.stringify({ opened, counterBefore, counterAfter }));
// two callers at once (a page's read and the scheduled run) open a quest
// once: one line in the log and one move of the counter
{
  const { releaseDue } = await import(BOT + '/src/quests.ts');
  await makeQuest('RD1', true);
  raw.prepare("UPDATE quest_groups SET opens_at = '2020-01-01 09:00:00' WHERE key = 'RD1'").run();
  const was = raw.prepare("SELECT value FROM counters WHERE name = 'quests'").get().value;
  const both = await Promise.all([releaseDue(db), releaseDue(db)]);
  const logged = raw.prepare("SELECT COUNT(*) AS n FROM submission_log WHERE action = 'quest-open' AND quest_code LIKE '%RD1%'").get().n;
  check('two callers at once open a due quest once, log it once and move the counter once',
    both.slice().sort().join() === '0,1' && logged === 1 && raw.prepare("SELECT value FROM counters WHERE name = 'quests'").get().value === was + 1 &&
    raw.prepare("SELECT hidden FROM quest_groups WHERE key = 'RD1'").get().hidden === 0,
    JSON.stringify({ both, logged }));
}

r = await get('/api/questlist/team', sessA);
const listA = await r.json();
const listB = await (await get('/api/questlist/team', sessB)).json();
const unsigned = await get('/api/questlist/team');
check('a signed-in team gets its own list, never cached: the Preview group sees VQ3, the other team does not',
  r.headers.get('cache-control').includes('no-store') && listA.team === teams[0].name &&
  keysOf(listA) === 'VQ1 VQ2 VQ3 VQ5 VQ6' && keysOf(listB) === 'VQ1 VQ2 VQ5 VQ6' && unsigned.status === 401,
  keysOf(listA) + ' | ' + keysOf(listB) + ' | ' + unsigned.status);
check('no list says who else can see a quest',
  [pub, listA].every(d => d.groups.every(g => !('visibility' in g) && !('audiences' in g) && !('tags' in g) && !('hidden' in g))), '');

// ---------------- the other ways in ----------------
const stats = await (await get('/api/quests')).json();
const statCodes = stats.quests.map(q => q.code).filter(c => /^VQ/.test(c)).sort().join(' ');
check('the stats feed has only what everyone may see', statCodes === 'VQ1 VQ5', statCodes);

// the dashboard's export of the tab: the board's teams across, the codes
// everyone may see down, a team's amount where it holds one
raw.prepare("INSERT INTO teams (name, hidden) VALUES ('Test run', 1)").run();
const testRun = raw.prepare("SELECT id FROM teams WHERE name = 'Test run'").get().id;
credit(raw, teams[0].id, 'VQ1', 2);
credit(raw, teams[0].id, 'VQ2', 1);
credit(raw, testRun, 'VQ1', 1);
const { parseCsv } = await import(BOT + '/src/quests.ts');
const sheet = parseCsv(await (await get('/api/console/tab/export', sess)).text());
const head = sheet[0];
const shown = raw.prepare('SELECT name FROM teams WHERE hidden = 0 ORDER BY id').all().map(t => t.name);
const vqRows = sheet.filter(row => /^VQ/.test(row[0]));
const vq1 = vqRows.find(row => row[0] === 'VQ1') || [];
check('the tab export has the shown teams across, only the codes everyone may see, and each team\'s amount',
  head[0] === 'Challenge' && head.slice(1).join('|') === shown.join('|') &&
  vqRows.map(row => row[0]).sort().join(' ') === 'VQ1 VQ5' &&
  vq1[1 + shown.indexOf(teams[0].name)] === '2' && vq1[1 + shown.indexOf(teams[1].name)] === '',
  JSON.stringify({ head: head.length, shown: shown.length, codes: vqRows.map(row => row[0]), vq1: vq1.filter(Boolean) }));

// the quest export cut to what everyone sees: the public list's quests,
// in the file the full export writes
const openFile = await get('/api/console/quests/export?format=json&only=everyone', sess);
const openKeys = (await openFile.json()).quests.map(q => q.code).filter(k => /^VQ/.test(k)).sort().join(' ');
check('the quest export can be cut to the quests everyone sees',
  openKeys === 'VQ1 VQ5' && /scs2-quests-everyone\.json/.test(openFile.headers.get('content-disposition') || ''), openKeys);

const submit = async (token, quest) => {
  const f = new FormData();
  f.append('quest', quest);
  return (await (await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: f })).json()).error;
};
const errB = await submit(sessB, 'VQ3');
const errA = await submit(sessA, 'VQ3');
const errHidden = await submit(sessA, 'VQ4');
check('a team cannot send proof for a quest it cannot see; one that can gets past the quest',
  errB === 'Pick a quest.' && errHidden === 'Pick a quest.' && /Attach/.test(errA || ''), [errB, errHidden, errA].join(' | '));

const askB = await get('/api/quest/ask?quest=VQ3', sessB);
const askA = await get('/api/quest/ask?quest=VQ3', sessA);
check('the question endpoint answers a quest the team cannot see as one that is not there',
  askB.status === 404 && askA.status === 200, askB.status + ' / ' + askA.status);

const suggest = async (command) => (await mod.autocompleteChoices({
  data: { name: command, options: [{ name: 'quest', value: 'VQ', focused: true }] }
}, db)).map(c => c.value).sort().join(' ');
const forAll = await suggest('quest');
const forOrganisers = await suggest('submit');
check("Discord's /quest suggests only codes everyone can see; /submit, the organisers', suggests them all",
  forAll === 'VQ1 VQ5' && forOrganisers === 'VQ1 VQ2 VQ3 VQ4 VQ5 VQ6 VQ7', forAll + ' | ' + forOrganisers);

// ---------------- saves, tags, everything ----------------
await jpost('/api/console/quests/group/save', { id: id.VQ2, key: 'VQ2', name: 'Renamed', region: 'Access', codes: [{ was: 'VQ2', code: 'VQ2', points: 10 }] }, sess);
check('saving a quest leaves who can see it alone',
  raw.prepare("SELECT visibility FROM quest_groups WHERE key = 'VQ2'").get().visibility === 'teams', '');

const all = await (await get('/api/console/quests', sess)).json();
const wave = all.tags.find(t => t.name === 'Wave 1');
const oldStock = all.tags.find(t => t.name === 'Old stock');
r = await jpost('/api/console/quests/tags/apply', { id: wave.id, do: 'open' }, sess);
pub = await (await get('/api/questlist')).json();
check('opening a tag opens its quests to everyone', r.status === 200 && keysOf(pub) === 'VQ1 VQ5 VQ6', keysOf(pub));

await jpost('/api/console/quests/tags/save', { id: oldStock.id, name: 'Old stock', dash_hidden: true }, sess);
await access('VQ3', { visibility: 'organisers', opens_at: '2099-01-01 09:00:00' });
r = await jpost('/api/console/quests/open-all', { confirm: 'nope' }, sess);
const refused = r.status;
r = await jpost('/api/console/quests/open-all', { confirm: 'OPEN' }, sess);
pub = await (await get('/api/questlist')).json();
check('opening everything needs OPEN typed, and leaves the dashboard-hidden tag and a later time alone',
  refused === 428 && r.status === 200 && keysOf(pub) === 'VQ1 VQ2 VQ4 VQ5 VQ6' &&
  raw.prepare("SELECT opens_at FROM quest_groups WHERE key = 'VQ3'").get().opens_at === '2099-01-01 09:00:00',
  keysOf(pub));

// a team group gone takes its quests from its teams with it
await access('VQ3', { visibility: 'groups', audiences: [preview], opens_at: '' });
await jpost('/api/console/quests/team-groups/delete', { id: preview }, sess);
const afterA = await (await get('/api/questlist/team', sessA)).json();
check('deleting a team group takes its quests away from its teams', !keysOf(afterA).includes('VQ3'), keysOf(afterA));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
