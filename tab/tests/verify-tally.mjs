// Run with: node tests/verify-tally.mjs   (needs Node 22+ for node:sqlite)
// Challenges counted across a team's submissions (src/tally.ts): what
// is counted for each kind, what waits apart, how teams are placed, the
// award by place made once, and what the site is told — the team's own
// count and the public standings, both stopped by the freeze. End to end
// against the real worker, the submissions written straight into the
// database as review would have left them.
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
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);

// the edge cache: what was kept and what a purge reached
const kept = [];
const purged = [];
globalThis.caches = { default: {
  async match() { return undefined; },
  async put(key) { kept.push(typeof key === 'string' ? key : key.url); },
  async delete(key) { purged.push(typeof key === 'string' ? key : key.url); return true; }
} };

const mod = await import(BOT + '/src/index.ts');
const ENV = { DB: db, CONSOLE_PASSWORD: 'tab-pass' };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
const getJson = async (path, token) => (await get(path, token)).json();

const sess = (await consoleSignIn(jpost, 'Runner', 'tab-pass')).session;

// Three challenges. The first asks a line of text before the stations,
// so the counted answer is the second one, under `more`.
async function makeQuest(key, questions, tally, points) {
  const r = await jpost('/api/console/quests/group/save', {
    key, name: 'Challenge ' + key, region: 'Challenge Region', hidden: 0,
    questions, rules: { tally }, codes: [{ code: key, label: '', points: points == null ? 10 : points }]
  }, sess);
  const d = await r.json();
  if (!d.ok) throw new Error(key + ': ' + JSON.stringify(d));
}
await makeQuest('CQ1', [{ kind: 'text', prompt: 'Team motto' }, { kind: 'pick', prompt: 'Stations', options: ['@stations'] }],
  { kind: 'picks', awards: [100, 60, 30], public: false });
await makeQuest('CQ2', [{ kind: 'count', prompt: 'How many bridges?' }], { kind: 'sum', awards: [50], public: false });
await makeQuest('CQ3', [], { kind: 'submissions', awards: [20], public: false }, 0);
await makeQuest('CQ4', [{ kind: 'count', prompt: 'How many people in the photo?' }], { kind: 'highest', awards: [30], public: false });
await makeQuest('CQ5', [], { kind: 'sum', awards: [], public: false });

const teams = raw.prepare('SELECT id, name FROM teams ORDER BY id LIMIT 5').all();
const [A, B, C, D, H] = teams;
raw.prepare('UPDATE teams SET hidden = 1 WHERE id = ?').run(H.id);

let minute = 0;
function sub(team, code, status, answer, by, credit) {
  minute += 1;
  const at = '2026-10-20 01:' + String(minute).padStart(2, '0') + ':00';
  return Number(raw.prepare(
    'INSERT INTO submissions (team_id, quest_code, status, answer, submitted_at, added_by, credit) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(team.id, code, status, answer ? JSON.stringify(answer) : null, at, by || '', credit ? JSON.stringify(credit) : null).lastInsertRowid);
}
const stations = (list) => ({ kind: 'text', value: 'Onward', more: [{ kind: 'pick', value: list }] });
const bridges = (n) => ({ kind: 'count', value: n });

const firstA = sub(A, 'CQ1', 'accepted', stations(['Central', 'Redfern']));
raw.prepare('INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, ?, ?, ?, ?)')
  .run(firstA, 'sub/central-photo', 'image/jpeg', 1000, 'central.jpg');
sub(A, 'CQ1', 'accepted', stations([' central ', 'Town Hall']));
sub(A, 'CQ1', 'pending', stations(['REDFERN', 'Wynyard']));
sub(B, 'CQ1', 'accepted', stations(['Central', 'Redfern', 'Museum']));
sub(C, 'CQ1', 'accepted', stations(['Central']));
sub(C, 'CQ1', 'accepted', stations(['Martin Place']), 'Runner', { codes: ['CQ1'], amount: 1 });
sub(D, 'CQ1', 'rejected', stations(['Central', 'Museum', 'Redfern', 'Wynyard']));
sub(D, 'CQ1', 'queued', stations(['Central']));
sub(H, 'CQ1', 'accepted', stations(['Central', 'Redfern', 'Museum', 'Wynyard', 'Town Hall']));

sub(A, 'CQ2', 'accepted', bridges(4));
sub(A, 'CQ2', 'accepted', bridges(6));
sub(A, 'CQ2', 'pending', bridges(3));
sub(B, 'CQ2', 'accepted', bridges(2));

// highest: a team's best, sent again through the day to beat it
const bestA = sub(A, 'CQ4', 'accepted', bridges(4));
sub(A, 'CQ4', 'accepted', bridges(9));
sub(A, 'CQ4', 'accepted', bridges(6));
sub(A, 'CQ4', 'pending', bridges(12));
sub(B, 'CQ4', 'accepted', bridges(9));
sub(B, 'CQ4', 'pending', bridges(5));
sub(C, 'CQ4', 'accepted', bridges(3));

// a running total with no number question: the reviewer types the count
sub(A, 'CQ5', 'accepted', { kind: 'count', value: 34, prompt: 'Counted' });
sub(A, 'CQ5', 'accepted', { kind: 'text', value: 'Near the bridge', more: [{ kind: 'count', value: 5, prompt: 'Counted' }] });
sub(B, 'CQ5', 'accepted', null);

sub(A, 'CQ3', 'accepted', null);
sub(A, 'CQ3', 'accepted', null);
sub(A, 'CQ3', 'queued', null);
sub(A, 'CQ3', 'accepted', null, 'Runner', { codes: ['CQ3'], amount: -1 });
// an adjustment on a code scored by bands credits nothing and sets its worth
sub(A, 'CQ3', 'accepted', null, 'Runner', { codes: ['CQ3'], amount: 0, points: { CQ3: 15 } });

// ---------------- what is counted ----------------
const board1 = await getJson('/api/console/tally?quest=CQ1', sess);
const row = (b, team) => (b.teams || []).find(t => t.id === team.id) || {};
const teamA = await getJson('/api/console/tally/team?quest=CQ1&team_id=' + A.id, sess);
check('a station counts once however many times it is sent, whatever its case or spacing',
  teamA.count === 3 && JSON.stringify(teamA.items.map(i => i.name)) === JSON.stringify(['Central', 'Redfern', 'Town Hall']),
  JSON.stringify(teamA.items));
check('each station names the submission that first brought it in, with that submission\'s first file',
  teamA.items[0].id === firstA && teamA.items[0].key === 'sub/central-photo' && teamA.items[0].at === '2026-10-20 01:01:00',
  JSON.stringify(teamA.items[0]));
check('a waiting submission is shown apart, as what it would add, and is not counted',
  teamA.waiting === 1 && teamA.waiting_items.map(i => i.name).join() === 'Wynyard' && row(board1, A).count === 3 &&
  teamA.pending.length === 1 && teamA.accepted.length === 2,
  JSON.stringify({ waiting: teamA.waiting, items: teamA.waiting_items, count: row(board1, A).count }));
check('an organiser\'s entry counts like the team\'s own, and a rejected one not at all',
  row(board1, C).count === 2 && row(board1, D).count === 0 && row(board1, D).waiting === 1,
  JSON.stringify({ C: row(board1, C), D: row(board1, D) }));
check('teams on the same count share a place and the next is placed after both; nothing counted is not placed',
  row(board1, A).place === 1 && row(board1, B).place === 1 && row(board1, C).place === 3 && row(board1, D).place === null,
  JSON.stringify(board1.teams.map(t => [t.name, t.count, t.place])));
check('a hidden team is counted and flagged but never placed',
  row(board1, H).count === 5 && row(board1, H).hidden === 1 && row(board1, H).place === null,
  JSON.stringify(row(board1, H)));

const board2 = await getJson('/api/console/tally?quest=CQ2', sess);
check('sum adds up the numbers given, with the waiting ones apart',
  row(board2, A).count === 10 && row(board2, A).waiting === 3 && row(board2, B).count === 2 && row(board2, A).place === 1,
  JSON.stringify(board2.teams));
const board4 = await getJson('/api/console/tally?quest=CQ4', sess);
const teamA4 = await getJson('/api/console/tally/team?quest=CQ4&team_id=' + A.id, sess);
check('highest counts a team\'s best number, places teams on their best, and a waiting number shows only if it would beat it',
  row(board4, A).count === 9 && row(board4, A).waiting === 12 && row(board4, B).count === 9 && row(board4, B).waiting === 0 &&
  row(board4, A).place === 1 && row(board4, B).place === 1 && row(board4, C).place === 3 &&
  teamA4.best === bestA + 1 && teamA4.accepted.map(x => x.amount).join() === '4,9,6',
  JSON.stringify({ teams: board4.teams, best: teamA4.best }));
const board5 = await getJson('/api/console/tally?quest=CQ5', sess);
check('a running total with no number question adds up the numbers reviewers typed, 34 and 5 making 39',
  row(board5, A).count === 39 && row(board5, A).place === 1 && row(board5, B).count === 0,
  JSON.stringify(board5.teams));
const reviewed = await getJson('/api/console/submissions?status=all&quest=CQ2', sess);
check('the review list says what a challenge counts, for the number box beside Accept',
  reviewed.submissions.length > 0 && reviewed.submissions.every(x => x.tally === 'sum'),
  JSON.stringify(reviewed.submissions.map(x => x.tally)));
const board3 = await getJson('/api/console/tally?quest=CQ3', sess);
check('submissions counts the accepted ones, leaving out an organiser\'s entry that took points off and an adjustment',
  row(board3, A).count === 2 && row(board3, A).waiting === 1, JSON.stringify(board3.teams));

// ---------------- the award ----------------
const held = (team, code) => (raw.prepare('SELECT amount FROM held WHERE team_id = ? AND quest_code = ?').get(team.id, code) || {}).amount || 0;
let r = await jpost('/api/console/tally/award', { quest: 'CQ3' }, sess);
check('a challenge on a code worth 0 points is not awarded', r.status === 400 && held(A, 'CQ3') === 0, 'status=' + r.status);

purged.length = 0;
r = await jpost('/api/console/tally/award', { quest: 'CQ1' }, sess);
let d = await r.json();
check('the award credits each placed team the points for its place, ties alike, on the lead code',
  r.status === 200 && held(A, 'CQ1') * 10 === 100 && held(B, 'CQ1') * 10 === 100 && held(C, 'CQ1') * 10 === 30 &&
  held(D, 'CQ1') === 0 && held(H, 'CQ1') === 0,
  JSON.stringify({ status: r.status, d, A: held(A, 'CQ1'), B: held(B, 'CQ1'), C: held(C, 'CQ1') }));
r = await jpost('/api/console/tally/award', { quest: 'CQ1' }, sess);
check('a second award is a 409 and moves nothing',
  r.status === 409 && held(A, 'CQ1') === 10 && held(C, 'CQ1') === 3, 'status=' + r.status);
const after = await getJson('/api/console/tally?quest=CQ1', sess);
check('the standings say when the places were awarded and by whom',
  !!after.settled && after.settled.by === 'Runner' && /^\d{4}-\d{2}-\d{2} /.test(after.settled.at) && after.settled.undoable === true,
  JSON.stringify(after.settled));
// taking the award back takes off what it gave, once, and it can be
// awarded again
const unawards = await Promise.all([
  jpost('/api/console/tally/unaward', { quest: 'CQ1' }, sess),
  jpost('/api/console/tally/unaward', { quest: 'CQ1' }, sess)
]);
const cleared = await getJson('/api/console/tally?quest=CQ1', sess);
const heldCleared = [held(A, 'CQ1'), held(B, 'CQ1'), held(C, 'CQ1')];
r = await jpost('/api/console/tally/award', { quest: 'CQ1' }, sess);
check('an award can be taken back once, leaving each team as it was, and awarded again',
  unawards.map(x => x.status).sort().join() === '200,409' && heldCleared.join() === '0,0,0' && !cleared.settled &&
  r.status === 200 && held(A, 'CQ1') === 10 && held(C, 'CQ1') === 3,
  JSON.stringify({ unawards: unawards.map(x => x.status), heldCleared, settled: cleared.settled, again: r.status }));
// one carried over from before awards kept what they gave holds no
// lines (the migration wrote its points as balances, and the award's
// token is its seed-), and is not taken back: undoing it would move
// nothing
const liveAward = raw.prepare("SELECT id, token FROM awards WHERE kind = 'challenge' AND voided_at IS NULL").get();
const liveId = liveAward.id;
raw.prepare("UPDATE entries SET source_kind = 'balance', source_id = NULL WHERE source_kind = 'award' AND source_id = ?").run(liveId);
raw.prepare("UPDATE awards SET token = 'seed-challenge-' || group_id WHERE id = ?").run(liveId);
r = await jpost('/api/console/tally/unaward', { quest: 'CQ1' }, sess);
const carried = await getJson('/api/console/tally?quest=CQ1', sess);
check('an award from before it kept what it gave is not taken back', r.status === 409 && held(A, 'CQ1') === 10 &&
  carried.settled && carried.settled.undoable === false, 'status=' + r.status);
raw.prepare("UPDATE entries SET source_kind = 'award', source_id = ? WHERE source_kind = 'balance' AND code = 'CQ1' AND source_id IS NULL AND made_by = 'Runner'").run(liveId);
raw.prepare('UPDATE awards SET token = ? WHERE id = ?').run(liveAward.token, liveId);

// one whose every line was undone on its own on the ledger is not
// stuck: it is undone like any other, and the places can be awarded again
{
  const lineIds = raw.prepare("SELECT id FROM entries WHERE source_kind = 'award' AND source_id = ? AND voided_at IS NULL").all(liveId).map(x => x.id);
  for (const id of lineIds) await jpost('/api/console/ledger/void', { id, reason: 'Wrong count' }, sess);
  const emptied = await getJson('/api/console/tally?quest=CQ1', sess);
  const undone = await jpost('/api/console/tally/unaward', { quest: 'CQ1' }, sess);
  const again = await jpost('/api/console/tally/award', { quest: 'CQ1' }, sess);
  check('an award whose lines were all undone one at a time can still be undone, and the places awarded again',
    lineIds.length > 0 && emptied.settled && emptied.settled.undoable === true && undone.status === 200 &&
    raw.prepare('SELECT voided_at FROM awards WHERE id = ?').get(liveId).voided_at !== null &&
    again.status === 200 && held(A, 'CQ1') === 10,
    JSON.stringify({ lines: lineIds.length, undoable: emptied.settled && emptied.settled.undoable, undone: undone.status, again: again.status }));
}

// ---------------- the site ----------------
r = await get('/api/quest/standings?quest=CQ1');
check('the standings are not public while the quest does not show them', r.status === 404, 'status=' + r.status);

raw.prepare('UPDATE quest_groups SET rules = ? WHERE key = ?')
  .run(JSON.stringify({ tally: { kind: 'picks', awards: [100, 60, 30], public: true } }), 'CQ1');
kept.length = 0;
r = await get('/api/quest/standings?quest=CQ1');
d = await r.json();
check('the public standings list the placed teams, the hidden team left out',
  r.status === 200 && JSON.stringify(d.teams) === JSON.stringify([
    { place: 1, name: A.name, count: 3 }, { place: 1, name: B.name, count: 3 }, { place: 3, name: C.name, count: 2 }]),
  JSON.stringify(d));
check('the public standings are kept at the edge under their address',
  kept.includes('https://bot.example/api/quest/standings?quest=CQ1') && /s-maxage=10/.test(r.headers.get('cache-control') || ''),
  JSON.stringify(kept));
await jpost('/api/console/tally/award', { quest: 'CQ2' }, sess);
check('a score change purges the standings address with the rest',
  purged.includes('https://bot.example/api/quest/standings?quest=CQ1'), JSON.stringify(purged.filter(p => /standings/.test(p))));

// a team signed in, the way the submit page signs it in
await jpost('/api/console/codes/generate', {}, sess);
const codeA = (await getJson('/api/console/codes', sess)).codes.find(c => c.name === A.name).code;
const teamSess = (await (await jpost('/api/submit/login', { team_name: A.name, code: codeA })).json()).session;

r = await get('/api/submit/tally?quest=CQ1');
check('the team\'s own count needs its sign-in', r.status === 401, 'status=' + r.status);
d = await getJson('/api/submit/tally?quest=CQ1', teamSess);
check('the team reads its own count, what is waiting, and the stations it has',
  d.ok && d.count === 3 && d.waiting === 1 && d.items.join() === 'Central,Redfern,Town Hall' && d.waiting_items.join() === 'Wynyard',
  JSON.stringify(d));

raw.prepare("UPDATE quest_groups SET visibility = 'teams' WHERE key = ?").run('CQ1');
kept.length = 0;
const outside = await get('/api/quest/standings?quest=CQ1');
const inside = await get('/api/quest/standings?quest=CQ1', teamSess);
check('a quest only signed-in teams see: its standings go to a team, are kept by nobody, and are not public',
  outside.status === 404 && inside.status === 200 && kept.length === 0 &&
  /private/.test(inside.headers.get('cache-control') || ''),
  JSON.stringify({ outside: outside.status, inside: inside.status, kept }));
raw.prepare("UPDATE quest_groups SET visibility = 'everyone' WHERE key = ?").run('CQ1');

await jpost('/api/console/freeze', { frozen: true }, sess);
const frozenPublic = await getJson('/api/quest/standings?quest=CQ1');
const frozenTeam = await getJson('/api/submit/tally?quest=CQ1', teamSess);
check('while the tab is frozen both answer that and nothing else',
  frozenPublic.frozen === true && !('teams' in frozenPublic) && frozenTeam.frozen === true && !('count' in frozenTeam),
  JSON.stringify({ frozenPublic, frozenTeam }));
await jpost('/api/console/freeze', { frozen: false }, sess);

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
