// Run with: node tests/verify-freeze.mjs
// Freezing the tab. The point of the freeze is that no team can see
// past it, so most of what follows is trying to: every public read,
// the Discord commands, and the cases where a freeze is half set up.
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
const mod = await import(BOT + '/src/index.ts');
const ENV = { DB: db, CONSOLE_PASSWORD: 'tab-pass' };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });

const session = (await consoleSignIn(jpost, 'Tab', 'tab-pass')).session;

// two submissions sitting in the review queue before anything is
// frozen, so the waiting count the tab shows is a real number rather
// than a zero that cannot move
const queueTeam = raw.prepare('SELECT id FROM teams WHERE hidden = 0 ORDER BY id LIMIT 1').get();
const addPending = (code) => raw.prepare(
  "INSERT INTO submissions (team_id, quest_code, status, submitted_at) VALUES (?, ?, 'pending', '2026-10-20 10:00:00')"
).run(queueTeam.id, code);
addPending('SQ1');
addPending('SQ2');

// ---------------- live to begin with ----------------
let r = await get('/api/console/freeze', session);
let d = await r.json();
check('the tab starts live', d.ok && d.frozen === false, JSON.stringify(d));

const liveBoard = await mod.apiResponse('/api/leaderboard', db);
const liveQuests = await mod.apiResponse('/api/quests', db);
const liveStats = await mod.apiResponse('/api/stats', db);
check('a live read carries no freeze mark and has real standings',
  liveBoard.frozen === undefined && liveBoard.teams.length > 1, JSON.stringify(liveBoard.teams.slice(0, 1)));

const leader = liveBoard.teams[0];
const runnerUp = liveBoard.teams[1];

// ---------------- freezing ----------------
r = await jpost('/api/console/freeze', { frozen: true });
check('freezing needs a dashboard session', r.status === 401, 'status=' + r.status);
r = await jpost('/api/console/freeze', { frozen: true }, 'not-a-session');
check('and a real one', r.status === 401, 'status=' + r.status);

r = await jpost('/api/console/freeze', { frozen: true }, session);
d = await r.json();
check('an organiser freezes the tab and gets the moment it stopped',
  r.status === 200 && d.ok && d.frozen === true && /^\d{4}-\d{2}-\d{2} /.test(d.frozen_at), JSON.stringify(d));
const frozenAt = d.frozen_at;

// ---------------- the tab moves underneath ----------------
// a big score lands after the freeze: nothing public may show it
const bump = await db.prepare('SELECT id FROM teams WHERE name = ?1').bind(runnerUp.name).first();
const quest = await db.prepare('SELECT code, points FROM quests WHERE hidden = 0 ORDER BY points DESC LIMIT 1').first();
r = await jpost('/api/console/ledger/adjust', { team_id: bump.id, code: quest.code, points: 40 * quest.points, reason: 'A big score' }, session);
check('scoring carries on for organisers while the tab is frozen', (await r.json()).ok === true, '');

const afterBoard = await mod.apiResponse('/api/leaderboard', db);
const afterTab = await mod.apiResponse('/api/tab', db);
check('the public leaderboard is the copy taken at the freeze, not the tab as it is now, in the live tab\'s one read too',
  afterBoard.frozen === true && afterBoard.frozen_at === frozenAt &&
  JSON.stringify(afterBoard.teams) === JSON.stringify(liveBoard.teams) &&
  JSON.stringify(afterTab.leaderboard) === JSON.stringify(afterBoard),
  JSON.stringify({ frozen: afterBoard.frozen, top: afterBoard.teams[0] }));

// the dashboard's standings picture is drawn from the tab as it is
const dashBoard = await (await get('/api/console/standings', session)).json();
const bumpedNow = (dashBoard.teams || []).find(t => t.name === runnerUp.name);
const bumpedThen = liveBoard.teams.find(t => t.name === runnerUp.name);
check('the dashboard reads the standings as they are while the public tab is frozen',
  dashBoard.ok === true && bumpedNow && bumpedNow.points > bumpedThen.points,
  JSON.stringify({ now: bumpedNow, then: bumpedThen }));

const afterQuests = await mod.apiResponse('/api/quests', db);
check('the per-quest counts are frozen too, so progress cannot be read off them',
  afterQuests.frozen === true &&
  JSON.stringify(afterQuests.quests) === JSON.stringify(liveQuests.quests) &&
  JSON.stringify(afterQuests.groups) === JSON.stringify(liveQuests.groups), '');

const afterStats = await mod.apiResponse('/api/stats', db);
check('and the headline stats, which would otherwise give the movement away',
  afterStats.frozen === true &&
  afterStats.total_points === liveStats.total_points &&
  afterStats.total_completions === liveStats.total_completions,
  JSON.stringify({ was: liveStats.total_points, now: afterStats.total_points }));

// ---------------- the three fields the live tab added ----------------
// Last scored, the total the tab is showing and the waiting count all
// ride the same stored copy. They are checked here rather than assumed
// from the freeze being a snapshot.
check('the frozen board carried the last quest each team had scored',
  liveBoard.teams[0].last_quest && liveBoard.teams[0].last_quest.code &&
  typeof liveBoard.teams[0].last_quest.at === 'string',
  JSON.stringify(liveBoard.teams[0].last_quest));
check('and the frozen stats carried the waiting count',
  liveStats.submissions_pending === 2, JSON.stringify(liveStats.submissions_pending));

// something is scored after the freeze, later than anything before it
const laterQuest = await db.prepare(
  'SELECT code, points FROM quests WHERE hidden = 0 AND points != 0 AND code NOT IN ' +
  '(SELECT quest_code FROM held WHERE team_id = ?1) LIMIT 1'
).bind(bump.id).first();
// recorded on its desk, which Last scored reads where an adjustment it does not
const later = new FormData();
later.append('team_id', String(bump.id));
later.append('quest', laterQuest.code);
later.append('amount', '1');
await front('/api/console/points/add', { method: 'POST', headers: { authorization: 'Bearer ' + session }, body: later });
raw.prepare('UPDATE submissions SET submitted_at = ? WHERE team_id = ? AND quest_code = ?')
  .run('2027-01-01 12:00:00', bump.id, laterQuest.code);
// and another team sends proof in, so the queue is longer than the copy says
addPending('SQ3');

const movedBoard = await mod.apiResponse('/api/leaderboard', db);
const movedRow = movedBoard.teams.find(t => t.name === runnerUp.name);
check('last scored is frozen with the rest — the quest scored during the freeze does not show',
  movedRow.last_quest.code !== laterQuest.code &&
  JSON.stringify(movedRow.last_quest) === JSON.stringify(runnerUp.last_quest),
  JSON.stringify({ frozenShows: movedRow.last_quest, scoredSince: laterQuest.code }));
const movedStats = await mod.apiResponse('/api/stats', db);
check('the waiting count is frozen too, so the queue length gives nothing away',
  movedStats.submissions_pending === 2, JSON.stringify(movedStats.submissions_pending));
const reallyWaiting = raw.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'pending'").get();
check('meanwhile the real queue really is longer',
  reallyWaiting.n === 3, JSON.stringify(reallyWaiting));

// the real tab really did move — the freeze is hiding something
const realNow = await db.prepare(
  'SELECT COALESCE(SUM(c.amount * q.points), 0) AS pts FROM held c JOIN quests q ON q.code = c.quest_code'
).first();
check('meanwhile the tab underneath really has moved',
  realNow.pts > liveStats.total_points, JSON.stringify({ frozenShows: liveStats.total_points, actually: realNow.pts }));

// ---------------- over HTTP, the way a team would ----------------
r = await get('/api/leaderboard');
d = await r.json();
check('the public HTTP leaderboard is frozen as well',
  d.frozen === true && JSON.stringify(d.teams) === JSON.stringify(liveBoard.teams), '');
check('the answer says when it stopped, so a page can explain itself',
  d.frozen_at === frozenAt, JSON.stringify(d.frozen_at));

// the dashboard still sees the truth
r = await get('/api/console/overview', session);
d = await r.json();
const dashTeam = d.teams.find(t => t.name === runnerUp.name);
check('the dashboard shows organisers the real total, frozen or not',
  dashTeam.pts > runnerUp.points, JSON.stringify({ frozenShows: runnerUp.points, dashboard: dashTeam.pts }));

// ---------------- Discord ----------------
const interaction = (name, opts) => ({
  type: 2, guild_id: 'g1', member: { roles: [] },
  data: { name, options: (opts || []).map(([n, v]) => ({ name: n, value: v })) }
});
let text = await mod.runCommand(interaction('leaderboard'), ENV, { waitUntil() {} });
text = typeof text === 'string' ? text : JSON.stringify(text);
check('Discord /leaderboard says it is frozen and shows the frozen board',
  /frozen/i.test(text) && text.includes(leader.name) && !text.includes('' + Math.round(realNow.pts)),
  JSON.stringify(text.slice(0, 90)));

text = await mod.runCommand(interaction('score', [['team', runnerUp.name]]), ENV, { waitUntil() {} });
check('Discord /score answers from the frozen copy, not the tab',
  /frozen/i.test(text) && text.includes(runnerUp.points.toLocaleString('en-US')), JSON.stringify(text));

text = await mod.runCommand(interaction('quest', [['team', runnerUp.name], ['quest', quest.code]]), ENV, { waitUntil() {} });
check('Discord /quest refuses while frozen — a yes there is live progress',
  /frozen/i.test(text) && !/^Yes/.test(text), JSON.stringify(text));

// an organiser still sees the live tab, but only they see it: a reply in
// a channel is read by everyone in it, and channel: is refused
raw.prepare("INSERT INTO discord_guilds (guild_id, organiser_role_id) VALUES ('g1', 'org-role')").run();
{
  const asOrganiser = (name, opts) => mod.runCommand(Object.assign(interaction(name, opts), { member: { roles: ['org-role'] } }), ENV, { waitUntil() {} });
  const live = await asOrganiser('score', [['team', runnerUp.name]]);
  const board = await asOrganiser('leaderboard');
  const posted = await asOrganiser('leaderboard', [['channel', '400000000000000009']]);
  const readerStill = await mod.runCommand(interaction('leaderboard'), ENV, { waitUntil() {} });
  check('frozen, an organiser\'s /score and /leaderboard answer live and only to them, and channel: is refused',
    live.flags === 64 && /points from/.test(live.content) && !/frozen/i.test(live.content) &&
    board.flags === 64 && !/frozen/i.test(board.content) &&
    posted.flags === 64 && /frozen/.test(posted.content) && /channel/.test(posted.content) && !posted.content.includes(leader.name) &&
    typeof readerStill === 'string' && /frozen/i.test(readerStill),
    JSON.stringify({ live, board: board.flags, posted, readerStill: String(readerStill).slice(0, 40) }));
}

// the after-the-event pages read the live tables, so a freeze shuts them
// whatever their switches say, and the pulse links to none of them
{
  for (const name of ['team_pages', 'recap', 'replay']) await jpost('/api/console/flags/set', { name, value: true }, session);
  const shut = [];
  for (const p of ['/api/team?name=' + encodeURIComponent(runnerUp.name), '/api/team?id=' + bump.id, '/api/recap',
    '/api/recap/quest?key=SQ1', '/api/replay']) shut.push((await get(p)).status);
  const pulse = await (await get('/api/pulse')).json();
  for (const name of ['team_pages', 'recap', 'replay']) await jpost('/api/console/flags/set', { name, value: false }, session);
  check('frozen, team pages, the recap, its quest pages and the replay are 404 with their switches on, and the pulse says they are off',
    shut.every(s => s === 404) && pulse.team_pages === false && pulse.recap === false && pulse.replay === false,
    JSON.stringify({ shut, pulse: [pulse.team_pages, pulse.recap, pulse.replay] }));
}

// ---------------- a half-set-up freeze still refuses ----------------
// if the copy is missing or unreadable the read must not fall through
// to live data
await db.prepare("UPDATE tab_freeze SET snapshot = 'not json at all' WHERE id = 1").run();
const broken = await mod.apiResponse('/api/leaderboard', db);
check('a freeze whose copy cannot be read shows nothing rather than the live tab',
  broken.frozen === true && broken.teams === undefined, JSON.stringify(broken));
await db.prepare('UPDATE tab_freeze SET snapshot = NULL WHERE id = 1').run();
const empty = await mod.apiResponse('/api/quests', db);
check('and a freeze with no copy at all does the same',
  empty.frozen === true && empty.quests === undefined, JSON.stringify(empty));

// put the copy back for the thaw check
await jpost('/api/console/freeze', { frozen: false }, session);
await jpost('/api/console/freeze', { frozen: true }, session);

// ---------------- thawing ----------------
r = await jpost('/api/console/freeze', { frozen: false }, session);
d = await r.json();
check('an organiser thaws it again', r.status === 200 && d.frozen === false, JSON.stringify(d));
const thawed = await mod.apiResponse('/api/leaderboard', db);
check('the public tab comes back live, showing everything scored during the freeze',
  thawed.frozen === undefined && JSON.stringify(thawed.teams) !== JSON.stringify(liveBoard.teams), '');
const thawedStats = await mod.apiResponse('/api/stats', db);
check('and the stats catch up too',
  thawedStats.total_points > liveStats.total_points, JSON.stringify(thawedStats.total_points));
const thawedRow = thawed.teams.find(t => t.name === runnerUp.name);
check('last scored catches up as well, showing what was scored during the freeze',
  thawedRow.last_quest.code === laterQuest.code && thawedRow.last_quest.at === '2027-01-01 12:00:00',
  JSON.stringify(thawedRow.last_quest));
check('and so does the waiting count',
  thawedStats.submissions_pending === 3, JSON.stringify(thawedStats.submissions_pending));
text = await mod.runCommand(interaction('leaderboard'), ENV, { waitUntil() {} });
check('Discord goes back to the live board', !/frozen/i.test(text), JSON.stringify(text.slice(0, 60)));

// ---------------- saved copies ----------------
// Every freeze is kept, so a thaw by mistake can be undone: freezing
// with the first freeze's copy puts back exactly what the public saw,
// as of the time it was taken.
r = await get('/api/console/freeze', session);
d = await r.json();
// newest first, and both freezes can land in the same second
const firstCopy = d.copies.filter(c => c.kind === 'freeze').pop();
r = await jpost('/api/console/freeze', { frozen: true, copy_id: firstCopy && firstCopy.id }, session);
const restored = await mod.apiResponse('/api/leaderboard', db);
check('a thaw by mistake is undone: freezing with the copy taken at the freeze shows that board again, as of then',
  d.copies.filter(c => c.kind === 'freeze').length === 2 && !!firstCopy && firstCopy.taken_at === frozenAt &&
  firstCopy.top[0].name === leader.name &&
  r.status === 200 && restored.frozen === true && restored.frozen_at === frozenAt &&
  JSON.stringify(restored.teams) === JSON.stringify(liveBoard.teams),
  JSON.stringify({ copies: d.copies.length, at: restored.frozen_at }));

// a copy saved by hand while frozen is of the tab, not of the frozen copy
r = await jpost('/api/console/freeze/save', {}, session);
d = await r.json();
const handCopy = await (await get('/api/console/freeze/copy?id=' + d.id, session)).json();
const realBoard = await mod.livePayload('/api/leaderboard', db);
check('a copy saved while frozen holds the standings as they really are, and comes with the copy before it',
  handCopy.ok && handCopy.copy.kind === 'hand' && handCopy.copy.taken_by === 'Tab' &&
  JSON.stringify(handCopy.copy.teams.map(t => [t.name, t.points])) === JSON.stringify(realBoard.teams.map(t => [t.name, t.points])) &&
  JSON.stringify(handCopy.copy.teams.map(t => t.name)) !== JSON.stringify(liveBoard.teams.map(t => t.name)) &&
  handCopy.before && handCopy.before.kind === 'freeze', JSON.stringify(handCopy.copy.teams.slice(0, 2)));

// the scheduled run saves one an hour, and only when the standings moved
const { hourlyCopy } = await import(BOT + '/src/freeze.ts');
const renderLive = (p) => mod.livePayload(p, db);
const newHour = () => raw.prepare("DELETE FROM site_flags WHERE name = 'tab_copy_hour'").run();
newHour();
const firstHour = await hourlyCopy(db, renderLive);
const sameHour = await hourlyCopy(db, renderLive);
newHour();
const quietHour = await hourlyCopy(db, renderLive);
await jpost('/api/console/ledger/adjust', { team_id: bump.id, code: quest.code, points: quest.points, reason: 'One more' }, session);
newHour();
const ticking = [];
await mod.default.scheduled({}, ENV, { waitUntil(p) { ticking.push(p); } });
await Promise.all(ticking);
const hourCopies = raw.prepare("SELECT COUNT(*) AS n FROM tab_snapshots WHERE kind = 'hour'").get().n;
check('an hourly copy is saved once an hour by the scheduled run, and an hour that moved nothing saves nothing',
  firstHour.saved === true && sameHour.ran === false && quietHour.saved === false && hourCopies === 2,
  JSON.stringify({ firstHour, sameHour, quietHour, hourCopies }));
{
  // two runs overlapping on a new hour: one claims it, the other leaves it
  await jpost('/api/console/ledger/adjust', { team_id: bump.id, code: quest.code, points: quest.points, reason: 'Once more' }, session);
  raw.prepare("UPDATE site_flags SET value = value - 1 WHERE name = 'tab_copy_hour'").run();
  const both = await Promise.all([hourlyCopy(db, renderLive), hourlyCopy(db, renderLive)]);
  const copiesNow = raw.prepare("SELECT COUNT(*) AS n FROM tab_snapshots WHERE kind = 'hour'").get().n;
  check('two scheduled runs at once save the hour\'s copy once',
    both.filter(x => x.ran).length === 1 && copiesNow === hourCopies + 1, JSON.stringify({ both, copiesNow }));
}

// ---------------- closed ----------------
// Closed shows nothing at all, frozen or not; opening it again goes
// back to the frozen copy.
await jpost('/api/console/codes/generate', {}, session);
const coded = raw.prepare('SELECT t.name, c.code FROM team_codes c JOIN teams t ON t.id = c.team_id WHERE t.hidden = 0 LIMIT 1').get();
const teamSession = (await (await jpost('/api/submit/login', { team_name: coded.name, code: coded.code })).json()).session;
await jpost('/api/console/flags/set', { name: 'recap', value: 1 }, session);

r = await jpost('/api/console/freeze/close', { closed: true }, session);
d = await r.json();
const shut = [];
for (const p of ['/api/leaderboard', '/api/quests', '/api/stats']) shut.push(await (await get(p)).json());
const shutTab = await (await get('/api/tab')).json();
shut.push(shutTab.leaderboard, shutTab.stats);
const shutSheet = await (await get('/api/submit/score', teamSession)).json();
const shutRecap = (await get('/api/recap')).status;
check('closed, the public reads, the team score sheet and the recap show nothing',
  d.ok && d.closed === true && shut.every(x => JSON.stringify(x) === '{"closed":true}') &&
  shutSheet.ok === true && shutSheet.closed === true && shutSheet.total === undefined &&
  shutRecap === 404,
  JSON.stringify({ shut, shutSheet, shutRecap }));

const said = [];
for (const [n, o] of [['leaderboard'], ['score', [['team', leader.name]]], ['quest', [['team', leader.name], ['quest', quest.code]]], ['list', [['team', leader.name]]]]) {
  const t = await mod.runCommand(interaction(n, o), ENV, { waitUntil() {} });
  said.push(typeof t === 'string' ? t : JSON.stringify(t));
}
check('and the four Discord reads say the tab is closed, naming no team',
  said.every(t => /closed/i.test(t) && !t.includes(leader.name)), JSON.stringify(said));

r = await jpost('/api/console/freeze/close', { closed: false }, session);
const reopened = await mod.apiResponse('/api/leaderboard', db);
text = await mod.runCommand(interaction('list', [['team', runnerUp.name]]), ENV, { waitUntil() {} });
check('opening it again goes back to the frozen copy, and /list waits for the thaw like /quest',
  (await r.json()).closed === false && reopened.frozen === true && reopened.frozen_at === frozenAt &&
  JSON.stringify(reopened.teams) === JSON.stringify(liveBoard.teams) && /frozen/i.test(text),
  JSON.stringify({ at: reopened.frozen_at, text }));
await jpost('/api/console/freeze', { frozen: false }, session);

// a press repeated changes nothing: two fresh freezes at once freeze
// once, keep one copy and log once, and closing a closed tab keeps the
// time it closed and is not logged again
{
  const logged = action => raw.prepare('SELECT COUNT(*) AS n FROM submission_log WHERE action = ?').get(action).n;
  const copies = () => raw.prepare("SELECT COUNT(*) AS n FROM tab_snapshots WHERE kind = 'freeze'").get().n;
  const [freezesBefore, copiesBefore] = [logged('tab-freeze'), copies()];
  const presses = await Promise.all([1, 2].map(() => jpost('/api/console/freeze', { frozen: true }, session).then(x => x.json())));
  const frozenRow = raw.prepare('SELECT frozen_at FROM tab_freeze WHERE id = 1').get();
  await jpost('/api/console/freeze', { frozen: false }, session);
  await jpost('/api/console/freeze/close', { closed: true }, session);
  const firstClose = raw.prepare('SELECT closed_at FROM tab_freeze WHERE id = 1').get().closed_at;
  raw.prepare("UPDATE tab_freeze SET closed_at = '2026-10-20 09:00:00' WHERE id = 1").run();
  const closesBefore = logged('tab-close');
  const again = await (await jpost('/api/console/freeze/close', { closed: true }, session)).json();
  check('a freeze or a close pressed again changes nothing and is logged once',
    presses.every(p => p.ok && p.frozen === true && p.frozen_at === frozenRow.frozen_at) &&
    logged('tab-freeze') === freezesBefore + 1 && copies() === copiesBefore + 1 && !!firstClose &&
    again.closed === true && again.closed_at === '2026-10-20 09:00:00' && logged('tab-close') === closesBefore &&
    raw.prepare('SELECT closed_at FROM tab_freeze WHERE id = 1').get().closed_at === '2026-10-20 09:00:00',
    JSON.stringify({ presses, freezes: logged('tab-freeze') - freezesBefore, copies: copies() - copiesBefore, again }));
  await jpost('/api/console/freeze/close', { closed: false }, session);
}

// ---------------- the log ----------------
r = await get('/api/console/log', session);
const actions = (await r.json()).entries.map(x => x.action);
check('freezing, thawing, closing, opening and saving a copy are all in the audit log',
  ['tab-freeze', 'tab-unfreeze', 'tab-close', 'tab-open', 'tab-copy'].every(a => actions.includes(a)),
  JSON.stringify([...new Set(actions)]));

console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
process.exit(fail === 0 ? 0 : 1);
