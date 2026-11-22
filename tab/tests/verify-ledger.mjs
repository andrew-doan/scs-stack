// Run with: node tests/verify-ledger.mjs   (needs Node 22+ for node:sqlite)
// The ledger (src/ledger.ts): every change to a score is a line, the
// tab's copy is rebuilt from the lines, and the migration fills the
// ledger in from what a live database already holds without moving any
// team's points.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
import { ledgerAgrees } from './ledger-fixture.mjs';
import { statements } from '../scripts/migrate.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };
const mod = await import(BOT + '/src/index.ts');
const ledger = await import(BOT + '/src/ledger.ts');
const ctx = { waitUntil() {} };
function worker(raw) {
  const ENV = { DB: d1Shim(raw), CONSOLE_PASSWORD: 'tab-pass' };
  const front = (path, opts) => mod.default.fetch(new Request('https://tab.example' + path, opts), ENV, ctx);
  const post = (path, body, token) => front(path, {
    method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify(body)
  });
  const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
  return { ENV, post, get };
}
// each team's total as the tab reads it (`held`), or as the table the
// tab read before the ledger held it (`completions`)
const totals = (raw, from = 'held') => {
  const out = {};
  raw.prepare('SELECT t.name, ROUND(COALESCE(SUM(' + (from === 'held' ? 'c.points' : 'c.amount * q.points') + '), 0), 2) AS pts FROM teams t ' +
    'LEFT JOIN ' + from + ' c ON c.team_id = t.id LEFT JOIN quests q ON q.code = c.quest_code GROUP BY t.id').all()
    .forEach(r => { out[r.name] = r.pts; });
  return out;
};
const ledgerTotals = raw => {
  const out = {};
  raw.prepare('SELECT t.name, ROUND(COALESCE(SUM(e.points), 0), 2) AS pts FROM teams t ' +
    'LEFT JOIN entries e ON e.team_id = t.id AND e.voided_at IS NULL GROUP BY t.id').all()
    .forEach(r => { out[r.name] = r.pts; });
  return out;
};
const MIGRATION = readFileSync(BOT + '/migrations/2026-11-ledger.sql', 'utf8');
function migrate(raw) { for (const stmt of statements(MIGRATION)) if (stmt) raw.exec(stmt); }

// ---------------- the migration ----------------
// A database as a live one stands before the ledger: the tables made by
// db:schema and empty, the flag unset, and points held every way the tab
// came to hold them.
const old = new DatabaseSync(':memory:');
old.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
old.exec(`
  INSERT INTO teams (id, name) VALUES (1, 'Opal Tappers'), (2, 'Ferry Folk'), (3, 'Late Starters');
  INSERT INTO quest_groups (id, key, name) VALUES (1, 'MQ1', 'Parramatta'), (2, 'SQ1', 'Stations'), (3, 'W1', 'Coin toss'), (4, 'C2', 'Old challenge');
  INSERT INTO quests (code, norm, points, group_id, sort) VALUES
    ('MQ1', 'MQ1', 400, 1, 0), ('MQ1-B', 'MQ1-B', 50, 1, 1), ('SQ1', 'SQ1', 100, 2, 0), ('Make 21', 'MAKE21', 30, NULL, 0),
    ('W1', 'W1', 10, 3, 0), ('C2', 'C2', 200, 4, 0), ('EOI', 'EOI', 25, NULL, 0);
  -- an accept with part marks and a count
  INSERT INTO submissions (id, team_id, quest_code, status, reviewed_by, reviewed_at, credit) VALUES
    (1, 1, 'MQ1', 'accepted', 'Alex', '2026-10-20 01:00:00', '{"codes":["MQ1","MQ1-B"],"amount":1,"counts":{"MQ1-B":3},"amounts":{"MQ1":0.5}}'),
    (2, 1, 'Make 21', 'accepted', 'Alex', '2026-10-20 02:00:00', '{"codes":["Make 21"],"amount":2}'),
    (3, 2, 'SQ1', 'accepted', 'Sam', '2026-10-20 03:00:00', '{"codes":["SQ1"],"amount":1}'),
    (4, 2, 'SQ1', 'deleted', 'Sam', '2026-10-20 04:00:00', '{"codes":["SQ1"],"amount":1}'),
    (5, 3, 'SQ1', 'accepted', 'Sam', '2026-10-20 05:00:00', NULL);
  -- an organiser's entry, and one taken back
  INSERT INTO submissions (id, team_id, quest_code, status, reviewed_by, reviewed_at, added_by, credit, reason, submitted_at) VALUES
    (6, 2, 'Make 21', 'accepted', 'Alex', '2026-10-20 06:00:00', 'Alex', '{"codes":["Make 21"],"amount":1}', NULL, '2026-10-20 06:00:00'),
    (7, 2, 'Make 21', 'deleted', 'Alex', '2026-10-20 07:00:00', 'Alex', '{"codes":["Make 21"],"amount":4}', 'Taken back', '2026-10-20 07:00:00');
  -- a wager settled with what it moved, a challenge from before awards kept it
  UPDATE quest_groups SET ask_settled = '{"winner":"Heads","at":"2026-10-20 08:00:00","by":"Alex","id":"w","code":"W1","given":[[1,2],[2,-1.5]]}' WHERE id = 3;
  UPDATE quest_groups SET tally_settled = '{"at":"2026-10-20 09:00:00","by":"Alex","id":"c"}' WHERE id = 4;
  INSERT INTO completions (team_id, quest_code, amount, updated_at) VALUES
    (1, 'MQ1', 0.5, '2026-10-20 01:00:00'), (1, 'MQ1-B', 3, '2026-10-20 01:00:00'), (1, 'Make 21', 2, '2026-10-20 02:00:00'),
    (2, 'SQ1', 2, '2026-10-20 04:00:00'), (2, 'Make 21', 1, '2026-10-20 06:00:00'),
    (3, 'SQ1', 1, '2026-10-20 05:00:00'),
    (1, 'W1', 2, '2026-10-20 08:00:00'),
    (3, 'C2', 0.75, '2026-10-20 09:00:00'),
    (1, 'EOI', 3, '2026-10-19 00:00:00'), (3, 'EOI', 1, '2026-10-19 00:00:00');
`);
// team 2's wager loss took W1 below nothing, and the tab dropped the row
// back then: its line comes to -1.5 with nothing on the tab
const before = totals(old, 'completions');
check('a database behind the migration is not ready, so nothing is scored on it',
  !(await ledger.ledgerReady(d1Shim(old))), '');
migrate(old);
const afterOnce = totals(old);
const lines = old.prepare('SELECT COUNT(*) AS n FROM entries').get().n;
check('the migration fills the ledger in without moving anybody: every team and code adds up to what the tab held',
  JSON.stringify(ledgerTotals(old)) === JSON.stringify(before) && JSON.stringify(afterOnce) === JSON.stringify(before) &&
  !ledgerAgrees(old).length && !!old.prepare("SELECT 1 FROM site_flags WHERE name = 'ledger_seeded'").get(),
  JSON.stringify({ before, ledger: ledgerTotals(old), off: ledgerAgrees(old) }));
const sub1 = old.prepare("SELECT code, units, points, made_by, at FROM entries WHERE source_kind = 'submission' AND source_id = 1 ORDER BY code").all();
check('an accepted submission becomes a line a code: its part mark, its count, who accepted it and when',
  JSON.stringify(sub1) === JSON.stringify([
    { code: 'MQ1', units: 0.5, points: 200, made_by: 'Alex', at: '2026-10-20 01:00:00' },
    { code: 'MQ1-B', units: 3, points: 150, made_by: 'Alex', at: '2026-10-20 01:00:00' }]),
  JSON.stringify(sub1));
const kept = old.prepare("SELECT note, voided_at FROM entries WHERE source_kind = 'submission' AND source_id = 4").get();
const back = old.prepare("SELECT units, void_reason FROM entries WHERE source_kind = 'submission' AND source_id = 7").get();
check('a deleted submission whose points stayed keeps a live line saying so, and an entry taken back is a voided line',
  kept && kept.note === 'Deleted, points kept' && !kept.voided_at && back && back.units === 4 && back.void_reason === 'Taken back',
  JSON.stringify({ kept, back }));
const awards = old.prepare('SELECT kind, code, made_by FROM awards ORDER BY kind').all();
const wagerLines = old.prepare("SELECT team_id, units, points FROM entries WHERE source_kind = 'award' AND code = 'W1' ORDER BY team_id").all();
check('a settled wager, an old award and the EOI become awards, the wager with a line for each team it moved',
  JSON.stringify(awards) === JSON.stringify([
    { kind: 'challenge', code: 'C2', made_by: 'Alex' }, { kind: 'eoi', code: 'EOI', made_by: 'migration' }, { kind: 'wager', code: 'W1', made_by: 'Alex' }]) &&
  JSON.stringify(wagerLines) === JSON.stringify([{ team_id: 1, units: 2, points: 20 }, { team_id: 2, units: -1.5, points: -15 }]),
  JSON.stringify({ awards, wagerLines }));
const balances = old.prepare("SELECT team_id, code, units FROM entries WHERE source_kind = 'balance' ORDER BY team_id, code").all();
check('what nothing explains is written as balances, both ways: an accept from before credits, an old award, a wager loss the tab dropped',
  JSON.stringify(balances) === JSON.stringify([
    { team_id: 2, code: 'W1', units: 1.5 }, { team_id: 3, code: 'C2', units: 0.75 }, { team_id: 3, code: 'SQ1', units: 1 }]),
  JSON.stringify(balances));
migrate(old);
check('running the migration again changes nothing', old.prepare('SELECT COUNT(*) AS n FROM entries').get().n === lines &&
  JSON.stringify(totals(old)) === JSON.stringify(before), '');
// a deleted submission whose points stayed has no other way to be
// undone, so its line is undone on its own; an accepted one's is not
{
  const ow = worker(old);
  const oldAdmin = (await consoleSignIn(ow.post, 'Alex', 'tab-pass')).session;
  const keptLine = old.prepare("SELECT id FROM entries WHERE source_kind = 'submission' AND source_id = 4 AND voided_at IS NULL").get().id;
  const acceptedLine = old.prepare("SELECT id FROM entries WHERE source_kind = 'submission' AND source_id = 3 AND voided_at IS NULL").get().id;
  const was = totals(old)['Ferry Folk'];
  const refusedVoid = await ow.post('/api/console/ledger/void', { id: acceptedLine, reason: 'x' }, oldAdmin);
  const keptVoid = await ow.post('/api/console/ledger/void', { id: keptLine, reason: 'Deleted at the team’s request' }, oldAdmin);
  check('a line kept by a deleted submission is undone on its own, and an accepted submission’s is still refused',
    refusedVoid.status === 409 && keptVoid.status === 200 && totals(old)['Ferry Folk'] === was - 100 &&
    old.prepare('SELECT void_reason FROM entries WHERE id = ?').get(keptLine).void_reason === 'Deleted at the team’s request',
    JSON.stringify({ refused: refusedVoid.status, kept: keptVoid.status, was, now: totals(old)['Ferry Folk'] }));
}

// ---------------- the worker on the ledger ----------------
const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const g = Number(raw.prepare("INSERT INTO quest_groups (key, name) VALUES ('LQ1', 'Ledger quest')").run().lastInsertRowid);
// LQ1 is counted per unit, so a result can credit it twice
raw.prepare("INSERT INTO quests (code, norm, points, group_id, label, sort, scoring) VALUES ('LQ1', 'LQ1', 80, ?, '', 0, 'unit'), ('LQ1-B', 'LQ1-B', 20, ?, 'Bonus', 1, '')").run(g, g);
const team = Number(raw.prepare("INSERT INTO teams (name) VALUES ('Ledger Crew')").run().lastInsertRowid);
const other = Number(raw.prepare("INSERT INTO teams (name) VALUES ('Second Crew')").run().lastInsertRowid);
const w = worker(raw);
const admin = (await consoleSignIn(w.post, 'Alex', 'tab-pass')).session;
const sub = () => Number(raw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'LQ1')").run(team).lastInsertRowid);

const s1 = sub();
const twice = await Promise.all([
  w.post('/api/console/submissions/accept', { id: s1, codes: ['LQ1', 'LQ1-B'] }, admin),
  w.post('/api/console/submissions/accept', { id: s1, codes: ['LQ1', 'LQ1-B'] }, admin)
]);
const live = id => raw.prepare("SELECT code, units, points FROM entries WHERE source_kind = 'submission' AND source_id = ? AND voided_at IS NULL ORDER BY code").all(id);
check('two Accepts at once write one line a code, and the tab agrees with the ledger',
  twice.map(r => r.status).sort().join() === '200,409' && JSON.stringify(live(s1)) === JSON.stringify([
    { code: 'LQ1', units: 1, points: 80 }, { code: 'LQ1-B', units: 1, points: 20 }]) && !ledgerAgrees(raw).length,
  JSON.stringify({ statuses: twice.map(r => r.status), lines: live(s1) }));
let dup = null;
try {
  raw.prepare("INSERT INTO entries (team_id, code, units, points, source_kind, source_id) VALUES (?, 'LQ1', 1, 80, 'submission', ?)").run(team, s1);
} catch (err) { dup = err.message; }
check('the database itself refuses a second live line for one submission and code', /UNIQUE/.test(dup || ''), dup || 'inserted');

await w.post('/api/console/submissions/revise', { id: s1, codes: ['LQ1'], amount: 2 }, admin);
const changed = raw.prepare("SELECT code, units, void_reason FROM entries WHERE source_kind = 'submission' AND source_id = ? ORDER BY id").all(s1);
check('Change voids the old lines with why and writes the new ones',
  JSON.stringify(changed.map(l => [l.code, l.units, l.void_reason])) ===
    JSON.stringify([['LQ1', 1, 'Changed'], ['LQ1-B', 1, 'Changed'], ['LQ1', 2, null]]) && !ledgerAgrees(raw).length,
  JSON.stringify(changed));
await w.post('/api/console/submissions/reopen', { id: s1 }, admin);
check('Undo voids them and the code leaves the tab', !live(s1).length &&
  !raw.prepare("SELECT 1 FROM held WHERE team_id = ? AND quest_code LIKE 'LQ1%'").get(team) && !ledgerAgrees(raw).length, '');

// ---------------- new points re-score every team ----------------
const s2 = sub();
await w.post('/api/console/submissions/accept', { id: s2, codes: ['LQ1'], amount: 2 }, admin);
const s3 = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'LQ1')").run(other).lastInsertRowid);
await w.post('/api/console/submissions/accept', { id: s3, codes: ['LQ1'] }, admin);
const held = id => raw.prepare("SELECT ROUND(SUM(points), 2) AS p FROM entries WHERE team_id = ? AND code = 'LQ1' AND voided_at IS NULL").get(id).p;
const saved = await w.post('/api/console/quests/group/save', {
  id: g, key: 'LQ1', name: 'Ledger quest', codes: [{ was: 'LQ1', code: 'LQ1', points: 100 }, { was: 'LQ1-B', code: 'LQ1-B', label: 'Bonus', points: 20 }]
}, admin);
const rescored = raw.prepare("SELECT team_id, units, points, source_id, void_reason FROM entries WHERE code = 'LQ1' AND source_id IN (?, ?) ORDER BY id").all(s2, s3);
check('new points re-score every team holding the code: each line voided and written again at them, under the same submission',
  saved.status === 200 && held(team) === 200 && held(other) === 100 &&
  rescored.filter(l => l.void_reason === 'Re-scored: LQ1 80 → 100 points').length === 2 &&
  rescored.filter(l => !l.void_reason).every(l => l.points === l.units * 100) && !ledgerAgrees(raw).length,
  JSON.stringify(rescored));
const undoAfter = await w.post('/api/console/submissions/reopen', { id: s2 }, admin);
check('undoing a submission after a re-score takes off what it is worth now', undoAfter.status === 200 && !held(team) && !ledgerAgrees(raw).length, '');
// an adjustment is worth what it was given: new points leave its line
// alone, and the check does not call that a difference
{
  const aj = Number(raw.prepare("INSERT INTO quest_groups (key, name) VALUES ('AJ1', 'Adjusted quest')").run().lastInsertRowid);
  raw.prepare("INSERT INTO quests (code, norm, points, group_id, label, sort) VALUES ('AJ1', 'AJ1', 50, ?, '', 0)").run(aj);
  const adj = await (await w.post('/api/console/ledger/adjust', { team_id: other, code: 'AJ1', points: 20, reason: 'Ruling' }, admin)).json();
  await w.post('/api/console/quests/group/save', { id: aj, key: 'AJ1', name: 'Adjusted quest', codes: [{ was: 'AJ1', code: 'AJ1', points: 100 }] }, admin);
  const lines = raw.prepare("SELECT points, voided_at FROM entries WHERE source_kind = 'submission' AND source_id = ?").all(adj.id);
  const checked = await (await w.post('/api/console/ledger/check', {}, admin)).json();
  check('new points leave an adjustment’s line at what it was given, and the check finds nothing',
    adj.ok && lines.length === 1 && lines[0].points === 20 && !lines[0].voided_at && checked.count === 0,
    JSON.stringify({ lines, problems: checked.problems }));
}

// ---------------- a quest's desk and the queue ----------------
// Ledger Crew's s1 and s2 are back in the queue with their lines voided,
// Second Crew holds s3; a rejected s4 gave nothing. The queue is oldest
// first, one submission can be read whatever its state, and an account
// limited to another quest cannot read this one's desk.
raw.prepare("UPDATE submissions SET submitted_at = datetime('now', '-1 hour') WHERE id = ?").run(s2);
const s4 = sub();
await w.post('/api/console/submissions/reject', { id: s4, reason: 'Blurry' }, admin);
const desk = await (await w.get('/api/console/desk?quest=lq1', admin)).json();
const crews = Object.fromEntries((desk.teams || []).map(t => [t.name, t]));
await w.post('/api/console/accounts/save', { create: true, name: 'Elsewhere', password: 'elsewhere-pass-1', perms: ['points'], quests: ['SQ1'], require_2fa: false }, admin);
const elsewhere = (await (await w.post('/api/console/login', { name: 'Elsewhere', password: 'elsewhere-pass-1' })).json()).session;
const refused = await w.get('/api/console/desk?quest=LQ1', elsewhere);
check('a quest\'s desk lists each team\'s lines on its codes, best first, what waits on review and what gave nothing, and refuses an account for another quest',
  desk.ok && desk.quest.key === 'LQ1' && desk.teams[0].name === 'Second Crew' && crews['Second Crew'].worth === 100 &&
  crews['Ledger Crew'].worth === 0 && crews['Ledger Crew'].lines.every(l => l.voided) &&
  desk.waiting.map(x => x.id).join() === [s2, s1].join() && desk.closed.map(x => [x.id, x.reason]).join() === [s4, 'Blurry'].join() &&
  refused.status === 403,
  JSON.stringify({ teams: desk.teams && desk.teams.map(t => [t.name, t.worth]), waiting: desk.waiting, closed: desk.closed, refused: refused.status }));
const queue = await (await w.get('/api/console/submissions?status=pending&quest=LQ1', admin)).json();
const one = await (await w.get('/api/console/submissions?id=' + s3, admin)).json();
const receipt = await (await w.get('/api/console/team/receipt?team_id=' + team, admin)).json();
check('the queue is oldest first, one submission reads whatever its state, and a team\'s ledger lists what gave nothing',
  queue.submissions.map(x => x.id).join() === [s2, s1].join() &&
  one.submissions.length === 1 && one.submissions[0].id === s3 && one.submissions[0].status === 'accepted' &&
  receipt.closed.map(x => x.id).join() === String(s4),
  JSON.stringify({ queue: queue.submissions.map(x => x.id), one: one.submissions.map(x => [x.id, x.status]), closed: receipt.closed }));
// the photos behind each submission's lines, for the desk and the ledger
const addFile = (id, key, type, name) => raw.prepare('INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, ?, ?, 10, ?)').run(id, key, type, name);
addFile(s3, 'sub/LedgerPhoto0001', 'image/jpeg', 'platform.jpg');
addFile(s3, 'sub/LedgerVideo0001', 'video/mp4', 'run.mp4');
addFile(s1, 'sub/LedgerPhoto0002', 'image/png', 'undone.png');
const deskMedia = (await (await w.get('/api/console/desk?quest=LQ1', admin)).json()).media || {};
const ledgerMedia = (await (await w.get('/api/console/team/receipt?team_id=' + crews['Second Crew'].id, admin)).json()).media || {};
check('the desk and a team\'s ledger carry the files of each submission behind their lines, an undone one\'s too',
  JSON.stringify((deskMedia[s3] || []).map(f => [f.key, f.type, f.name])) ===
    JSON.stringify([['sub/LedgerPhoto0001', 'image/jpeg', 'platform.jpg'], ['sub/LedgerVideo0001', 'video/mp4', 'run.mp4']]) &&
  (deskMedia[s1] || []).length === 1 && JSON.stringify(ledgerMedia[s3]) === JSON.stringify(deskMedia[s3]) && !ledgerMedia[s1],
  JSON.stringify({ deskMedia, ledgerMedia }));

// ---------------- the tab is read off the lines ----------------
// The public board built here from the lines themselves, and as the
// worker builds it through the view: every visible team's total agrees.
const board = await (await w.get('/api/leaderboard')).json();
const fromLines = {};
raw.prepare('SELECT t.name, ROUND(COALESCE(SUM(e.points), 0), 2) AS pts FROM teams t ' +
  'LEFT JOIN entries e ON e.team_id = t.id AND e.voided_at IS NULL AND e.code IN (SELECT code FROM quests) ' +
  'WHERE t.hidden = 0 GROUP BY t.id').all().forEach(r => { fromLines[r.name] = r.pts; });
const offBoard = board.teams.filter(t => Math.abs(t.points - fromLines[t.name]) > 0.005);
check('the public board is each team\'s live lines added up, and every code\'s amount on it is the lines\' units',
  board.teams.length === Object.keys(fromLines).length && !offBoard.length && !ledgerAgrees(raw).length,
  JSON.stringify({ offBoard, off: ledgerAgrees(raw) }));

// ---------------- renames and deletes ----------------
await w.post('/api/console/quests/group/save', {
  id: g, key: 'LQ1', name: 'Ledger quest', codes: [{ was: 'LQ1', code: 'LQ2', points: 100 }, { was: 'LQ1-B', code: 'LQ1-B', label: 'Bonus', points: 20 }]
}, admin);
check('a renamed code takes its lines with it', !raw.prepare("SELECT 1 FROM entries WHERE code = 'LQ1'").get() &&
  raw.prepare("SELECT COUNT(*) AS n FROM entries WHERE code = 'LQ2' AND voided_at IS NULL").get().n === 1 && !ledgerAgrees(raw).length, '');

// a wager's settlement gave what was staked: new points on its code
// leave its lines, and the check does not call that a difference
await w.post('/api/console/quests/group/ask/save', { key: 'LQ1', kind: 'wager', prompt: 'Red or black?', options: ['Red', 'Black'] }, admin);
raw.prepare("INSERT INTO quest_responses (group_id, team_id, choice, amount) VALUES (?, ?, 'Red', 30), (?, ?, 'Black', 20)").run(g, team, g, other);
const settled = await w.post('/api/console/quests/group/ask/settle', { key: 'LQ1', winner: 'Red' }, admin);
await w.post('/api/console/quests/group/save', {
  id: g, key: 'LQ1', name: 'Ledger quest', codes: [{ was: 'LQ2', code: 'LQ2', points: 50 }, { was: 'LQ1-B', code: 'LQ1-B', label: 'Bonus', points: 20 }]
}, admin);
const staked = raw.prepare("SELECT team_id, points, voided_at FROM entries WHERE source_kind = 'award' AND code = 'LQ2' ORDER BY team_id").all();
const afterWager = await (await w.post('/api/console/ledger/check', {}, admin)).json();
const subPoints = raw.prepare("SELECT ROUND(SUM(points), 2) AS p FROM entries WHERE team_id = ? AND code = 'LQ2' AND source_kind = 'submission' AND voided_at IS NULL").get(other).p;
check('new points leave a wager’s lines at what was staked, re-score the submissions on the code, and the check finds nothing',
  settled.status === 200 && JSON.stringify(staked.map(l => [l.team_id, l.points, l.voided_at])) === JSON.stringify([[team, 30, null], [other, -20, null]]) &&
  subPoints === 50 && afterWager.count === 0 && !ledgerAgrees(raw).length,
  JSON.stringify({ settled: settled.status, staked, problems: afterWager.problems }));

// ---------------- deleting a quest ----------------
// What it leaves behind moves to DELETED, its key comes out of the
// accounts limited to it, and a new quest given its codes starts clean.
raw.prepare("INSERT INTO quest_files (group_id, key, name, type, bytes) VALUES (?, 'qst/LedgerSheet01', 'sheet.pdf', 'application/pdf', 10)").run(g);
await w.post('/api/console/accounts/save', { create: true, name: 'Only LQ1', password: 'only-lq1-pass', perms: ['points'], quests: ['LQ1'], require_2fa: false }, admin);
await w.post('/api/console/accounts/save', { create: true, name: 'Two quests', password: 'two-quests-pass', perms: ['points'], quests: ['LQ1', 'SQ1'], require_2fa: false }, admin);
const stranded = await w.post('/api/console/quests/group/delete', { id: g, confirm: 'LQ1' }, admin);
const strandedSaid = (await stranded.json()).error || '';
const scopeOf = name => raw.prepare('SELECT quests FROM console_users WHERE name = ?').get(name).quests;
// an empty list is every quest, so it is taken only when that is what is asked
const emptied = await w.post('/api/console/accounts/save', { name: 'Only LQ1', perms: ['points'], quests: [] }, admin);
const emptiedTo = scopeOf('Only LQ1');
await w.post('/api/console/accounts/save', { name: 'Only LQ1', perms: ['points'], quests: ['SQ1'] }, admin);
const gone = await w.post('/api/console/quests/group/delete', { id: g, confirm: 'LQ1' }, admin);
const twoAfter = scopeOf('Two quests');
await w.post('/api/console/accounts/save', { name: 'Two quests', perms: ['points'], quests: [], all_quests: true }, admin);
check('a quest that is some account’s only one is not deleted until it has another, its key leaves the rest, and an empty list is every quest only when asked for',
  stranded.status === 409 && /Only LQ1/.test(strandedSaid) && emptied.status === 400 && emptiedTo === 'LQ1' &&
  gone.status === 200 && twoAfter === 'SQ1' && scopeOf('Two quests') === '',
  JSON.stringify({ stranded: stranded.status, strandedSaid, emptied: emptied.status, emptiedTo, gone: gone.status, twoAfter, all: scopeOf('Two quests') }));
const moved = raw.prepare("SELECT deleted_from, COUNT(*) AS n, SUM(voided_at IS NULL) AS live FROM entries WHERE code = 'DELETED' GROUP BY deleted_from").all();
check('deleting a quest voids its lines, so the team loses what they gave, and moves them off its codes',
  !raw.prepare("SELECT 1 FROM entries WHERE code IN ('LQ2', 'LQ1-B')").get() &&
  moved.map(m => m.deleted_from).join() === 'LQ1-B,LQ2' && moved.every(m => m.live === 0) &&
  raw.prepare("SELECT COUNT(*) AS n FROM entries WHERE code = 'DELETED' AND void_reason = 'Quest deleted'").get().n === 3 && !ledgerAgrees(raw).length,
  JSON.stringify(moved));
// a new quest with the same key and code
const fresh = await (await w.post('/api/console/quests/group/save', { key: 'LQ1', name: 'A new quest', codes: [{ code: 'LQ2', points: 10 }] }, admin)).json();
const freshDesk = await (await w.get('/api/console/desk?quest=LQ1', admin)).json();
const freshQueue = await (await w.get('/api/console/submissions?status=all&quest=LQ1', admin)).json();
const freshTally = raw.prepare("SELECT COUNT(*) AS n FROM submissions WHERE quest_code = 'LQ2'").get().n +
  raw.prepare("SELECT COUNT(*) AS n FROM entries WHERE code = 'LQ2'").get().n + raw.prepare("SELECT COUNT(*) AS n FROM awards WHERE code = 'LQ2'").get().n;
check('a new quest given a deleted one’s code starts with no submissions, lines, awards or files',
  fresh.ok && freshTally === 0 && freshDesk.ok && !freshDesk.teams.length && !freshDesk.waiting.length && !freshDesk.closed.length &&
  !freshQueue.submissions.length && !fresh.group.files.length,
  JSON.stringify({ freshTally, desk: freshDesk.teams, queue: freshQueue.submissions.length, files: fresh.group && fresh.group.files }));
const keptSub = raw.prepare('SELECT quest_code, deleted_from, status FROM submissions WHERE id = ?').get(s3);
const keptAward = raw.prepare("SELECT code, deleted_from, voided_at FROM awards WHERE kind = 'wager'").get();
const keptFile = raw.prepare("SELECT group_id, deleted_key FROM quest_files WHERE key = 'qst/LedgerSheet01'").get();
const readBack = (await (await w.get('/api/console/submissions?id=' + s3, admin)).json()).submissions[0];
const crewLedger = await (await w.get('/api/console/team/receipt?team_id=' + other, admin)).json();
const heldBlock = crewLedger.quests.find(q => q.key === 'DELETED');
const acceptHeld = await w.post('/api/console/submissions/accept', { id: s1, codes: ['DELETED'] }, admin);
check('the old submissions, award and file are kept with where they came from, and read as the deleted quest',
  keptSub.quest_code === 'DELETED' && keptSub.deleted_from === 'LQ2' && keptSub.status === 'accepted' &&
  keptAward.code === 'DELETED' && keptAward.deleted_from === 'LQ2' && !!keptAward.voided_at &&
  keptFile.group_id === g && keptFile.deleted_key === 'LQ1' &&
  readBack.quest_code === 'LQ2 (deleted)' && readBack.deleted_from === 'LQ2' &&
  !!heldBlock && heldBlock.name === 'LQ2 (deleted)' && heldBlock.lines.every(l => l.code === 'LQ2 (deleted)' && l.voided) &&
  acceptHeld.status === 409,
  JSON.stringify({ keptSub, keptAward, keptFile, quest: readBack.quest_code, block: heldBlock && heldBlock.name, accept: acceptHeld.status }));

// ---------------- the check ----------------
const quiet = await (await w.post('/api/console/ledger/check', {}, admin)).json();
const firstLine = "(SELECT MIN(id) FROM entries WHERE voided_at IS NULL AND team_id IN (SELECT id FROM teams) AND code IN (SELECT code FROM quests))";
raw.prepare('UPDATE entries SET points = points + 1 WHERE id = ' + firstLine).run();
const loud = await (await w.post('/api/console/ledger/check', {}, admin)).json();
const read = await (await w.get('/api/console/ledger/check', admin)).json();
check('the check finds nothing on a ledger that agrees, and a line whose points were changed behind its back',
  quiet.ok && quiet.count === 0 && loud.count === 1 && loud.problems[0].what === 'points' &&
  read.ok && read.ready && read.check.count === 1,
  JSON.stringify({ quiet, loud, read }));
raw.prepare('UPDATE entries SET points = points - 1 WHERE id = ' + firstLine).run();

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
