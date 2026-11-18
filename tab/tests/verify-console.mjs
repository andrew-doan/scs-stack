// Run with: node tests/verify-console.mjs   (needs Node 22+ for node:sqlite)
// The tab console, end to end against the real worker module: login
// and sessions, team and quest management with the typed-confirm
// guards, score entry, the paste-review-commit importer, the audit
// log, and cache purging on every write.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { totpNow } from './console-signin.mjs';
import { credit } from './ledger-fixture.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(BOT + '/src/index.ts');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);

// edge cache mock so purges are observable
const store = new Map();
let deletes = 0;
globalThis.caches = { default: {
  async match() { return undefined; },
  async put(req, res) { store.set(typeof req === 'string' ? req : req.url, res); },
  async delete(key) { deletes++; return store.delete(typeof key === 'string' ? key : key.url); }
} };

const ENV = { DB: db, CONSOLE_PASSWORD: 'tab-pass' };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const post = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });

// ---------------- page + login ----------------
let r = await front('/dash');
let html = await r.text();
const reopened = await front('/dash', { headers: { 'if-none-match': r.headers.get('etag') || 'none' } });
check('/dash serves the page, and a browser that holds it is told it has not changed',
  r.status === 200 && html.includes('Dashboard') && html.includes('id="login-pass"') &&
  r.headers.get('cache-control') === 'private, no-cache' && reopened.status === 304,
  r.headers.get('cache-control') + ' ' + reopened.status);
r = await front('/console');
check('and /console, where it used to be, sends you there rather than 404ing a bookmark',
  r.status === 302 && r.headers.get('location') === '/dash', 'status=' + r.status);
check('the page holds no secrets', !html.includes('tab-pass'), '');
// The page script is the files in src/dash/js/, which Node only reads as
// text: a syntax error there is one the browser sees and Node does not.
// Each part has to parse on its own, and the page runs them joined in
// the order the two loaders list.
const { JS: parts } = await import(BOT + '/src/dash/files-node.js');
const pageScript = html.slice(html.lastIndexOf('<script>') + 8, html.lastIndexOf('</script>'));
const broken = parts.map(([name, text]) => {
  try { new Function(text); return ''; } catch (err) { return name + '.js: ' + err.message; }
}).filter(Boolean);
check('every part of the page script parses on its own', broken.length === 0, broken.join(' | '));
check('and the page runs them joined in order, as one script',
  pageScript === '\n\n' + parts.map(([, text]) => text).join('\n') + '\n', '');
{
  const listed = parts.map(([name]) => name + '.js');
  const onDisk = readdirSync(BOT + '/src/dash/js').filter(f => f.endsWith('.js')).sort();
  const imported = [...readFileSync(BOT + '/src/dash/files.js', 'utf8').matchAll(/from '\.\/js\/([a-z-]+\.js)'/g)].map(m => m[1]);
  const tableOrder = [...readFileSync(BOT + '/src/dash/files.js', 'utf8').matchAll(/\['([a-z-]+)', [A-Z_]+\]/g)].map(m => m[1] + '.js');
  check('files.js and files-node.js list every file in src/dash/js/, in the same order',
    listed.slice().sort().join() === onDisk.join() && imported.join() === listed.join() && tableOrder.join() === listed.join(),
    JSON.stringify({ listed: listed.length, onDisk: onDisk.length, imported: imported.length, tableOrder: tableOrder.length }));
}
// The dashboard runs on the browsers of September 2021 (Chrome 93,
// Firefox 92, Safari 15.0 on an iPad on iOS 15) and the suites run on a
// new Chromium, which has everything: so nothing newer, by name. A
// selector list holding :focus-visible is dropped whole before Safari
// 15.4, so it only goes in a rule of its own.
{
  const styles = html.slice(html.indexOf('<style>') + 7, html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
  const NEWER_JS = /\.at\(|Object\.hasOwn\(|structuredClone\(|\.findLast(Index)?\(|\.to(Sorted|Reversed|Spliced)\(|randomUUID\(|withResolvers\(|AbortSignal\.(timeout|any)\(|requestIdleCallback\(|\.showModal\(|\.showPicker\(|\(\?<[=!]/;
  const tooNew = parts.map(([name, text]) => [text, NEWER_JS, name + '.js: ']).concat([
    [styles, /:has\(|color-mix\(|\d[dsl]vh\b|@container|subgrid/, ''],
    [html, /<dialog\b/, '']
  ]).map(([text, re, where]) => { const hit = text.match(re); return hit ? where + hit[0] : ''; }).filter(Boolean);
  styles.split('}').forEach((block) => {
    const head = block.slice(0, block.lastIndexOf('{'));
    const list = head.slice(head.lastIndexOf('{') + 1);
    if (/:focus-visible/.test(list) && list.split(',').some((s) => !/:focus-visible/.test(s))) tooNew.push(list.trim());
  });
  check('the page uses nothing newer than the browsers of September 2021', tooNew.length === 0, tooNew.join(' | '));
}

// A name nobody has used gets a secret rather than a session: the
// password alone is not a sign-in any more.
r = await post('/api/console/login', { password: 'tab-pass', name: 'Alex' });
const enrol = await r.json();
check('a new name is handed a secret to enrol, and no session',
  r.status === 200 && !enrol.session && /^[A-Z2-7 ]{30,}$/.test(enrol.secret || '') &&
  (enrol.otpauth || '').startsWith('otpauth://totp/') && (enrol.qr || '').startsWith('data:image/svg+xml;base64,'),
  JSON.stringify({ session: !!enrol.session, secret: enrol.secret }));
const alexSecret = enrol.secret.replace(/\s/g, '');
r = await post('/api/console/login', { password: 'tab-pass', name: 'Alex', code: totpNow(alexSecret) });
const opened = await r.json();
const sess = opened.session;
check('the first code confirms the enrolment, opens a session and prints the backup codes',
  r.status === 200 && /^[A-Za-z0-9_-]{20,}$/.test(sess || '') &&
  Array.isArray(opened.backup_codes) && opened.backup_codes.length === 10 &&
  opened.backup_codes.every(c => /^[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(c)),
  JSON.stringify({ session: !!sess, codes: (opened.backup_codes || []).length }));
r = await post('/api/console/login', { password: 'nope', name: 'Mallory' });
check('a wrong password is refused', r.status === 401, 'status=' + r.status);
const attempts = raw.prepare("SELECT action, actor, quest_code FROM submission_log WHERE action LIKE 'login%' ORDER BY id").all();
check('every sign-in attempt is logged with the name typed and an address hash',
  attempts.some(a => a.action === 'login' && a.actor === 'console:Alex' && /^ip:[0-9a-f]{8}$/.test(a.quest_code)) &&
  attempts.some(a => a.action === 'login-failed' && a.actor === 'console:Mallory'), JSON.stringify(attempts));
r = await mod.default.fetch(new Request('https://bot.example/api/console/login', {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'anything' })
}), { DB: db }, { waitUntil() {} });
check('no CONSOLE_PASSWORD means locked, not open', r.status === 403, 'status=' + r.status);
r = await get('/api/console/overview');
check('no session, no data', r.status === 401, 'status=' + r.status);

// ---------------- overview ----------------
r = await get('/api/console/overview', sess);
let data = await r.json();
const teamCount = data.teams.length;
const questCount = data.quests.length;
check('overview lists the seeded tab', teamCount === 43 && questCount > 100 && data.teams[0].pts >= data.teams[1].pts,
  JSON.stringify({ teams: teamCount, quests: questCount }));
check('console reads are never edge-cached', (r.headers.get('cache-control') || '').indexOf('s-maxage') === -1, '');

// ---------------- teams ----------------
deletes = 0;
r = await post('/api/console/teams/add', { name: 'Console Test Crew' }, sess);
data = await r.json();
const crewId = data.id;
check('a team can be added', data.ok === true && typeof crewId === 'number', JSON.stringify(data));
check('writes purge the public api cache', deletes >= 3, 'deletes=' + deletes);
r = await post('/api/console/teams/add', { name: 'console test crew' }, sess);
check('a case-insensitive name clash is refused', r.status === 409, 'status=' + r.status);
r = await post('/api/console/teams/rename', { id: crewId, name: 'Console Crew' }, sess);
check('renaming works', (await r.json()).name === 'Console Crew', '');
r = await post('/api/console/teams/delete', { id: crewId, confirm: 'wrong name' }, sess);
check('deleting a team demands its exact name', r.status === 428, 'status=' + r.status);

// ---------------- quests ----------------
r = await post('/api/console/quests/add', { code: 'S200', points: 125 }, sess);
check('a quest can be added', (await r.json()).ok === true, '');
r = await post('/api/console/quests/add', { code: 's 200', points: 50 }, sess);
check('normalised code clashes are refused (s 200 vs S200)', r.status === 409, 'status=' + r.status);
r = await post('/api/console/quests/edit', { code: 'S200', points: 150 }, sess);
check('points can be edited', (await r.json()).points === 150, '');

// ---------------- adjusting a team's points ----------------
r = await post('/api/console/ledger/adjust', { team_id: crewId, code: 'S200', points: 300, reason: 'Two by hand' }, sess);
data = await r.json();
check('an adjustment lands with the right total', data.ok === true && data.total === 300, JSON.stringify(data));
r = await get('/api/console/team/receipt?team_id=' + crewId, sess);
data = await r.json();
const s200 = (data.quests || []).find(x => x.key === 'S200');
check('the team\u2019s ledger shows it, with why', data.total === 300 && s200 && s200.held[0].amount === 2 &&
  s200.lines[0].sub.adjust === true && s200.lines[0].sub.reason === 'Two by hand', JSON.stringify(s200));
r = await post('/api/console/ledger/adjust', { team_id: crewId, code: 'S200', points: -300, reason: 'Not after all' }, sess);
data = await r.json();
check('taking the same points off brings the team back to nothing', data.ok === true && data.total === 0, JSON.stringify(data));
const refusedAdjust = [
  (await post('/api/console/ledger/adjust', { team_id: crewId, code: 'S200', points: 0, reason: 'x' }, sess)).status,
  (await post('/api/console/ledger/adjust', { team_id: crewId, code: 'S200', points: 10, reason: '' }, sess)).status
];
check('an adjustment needs points and a reason', refusedAdjust.join() === '400,400', refusedAdjust.join());

// rename cascade: score again, rename the quest, total must survive
await post('/api/console/ledger/adjust', { team_id: crewId, code: 'S200', points: 150, reason: 'Once' }, sess);
r = await post('/api/console/quests/edit', { code: 'S200', points: 150, new_code: 'S201' }, sess);
check('renaming a quest keeps its code unique and applies', (await r.json()).code === 'S201', '');
r = await get('/api/console/team/receipt?team_id=' + crewId, sess);
data = await r.json();
check('a quest rename carries the tab entries with it', data.total === 150 && data.quests.some(x => x.held.some(c => c.code === 'S201' && c.amount === 1)), JSON.stringify(data.quests));

// delete guard on a quest that is on the tab
r = await post('/api/console/quests/delete', { code: 'S201', confirm: 'nope' }, sess);
data = await r.json();
check('deleting a scored quest warns how many entries go with it', r.status === 428 && /1 team/.test(data.error), data.error);
r = await post('/api/console/quests/delete', { code: 'S201', confirm: 'S201' }, sess);
check('typed confirmation deletes quest and entries', (await r.json()).ok === true, '');
r = await get('/api/console/team/receipt?team_id=' + crewId, sess);
check('the entries went with it', (await r.json()).total === 0, '');

// clean up the crew with proper confirmation
// a person and a Discord channel left keyed by its id, as a signup's
// people and a server's channel are kept after a delete
raw.prepare("INSERT INTO participants (registration_id, team_id, position, name, zid) VALUES (0, ?, 1, 'Paper Trail', 'z5999001')").run(crewId);
raw.prepare("INSERT INTO discord_teams (guild_id, team_id, role_id, channel_id) VALUES ('g-old', ?, 'role-old', 'chan-old')").run(crewId);
r = await post('/api/console/teams/delete', { id: crewId, confirm: 'Console Crew' }, sess);
check('typed confirmation deletes the team', (await r.json()).ok === true, '');
{
  // the newest team deleted, its id is not the next team's: the rows
  // still keyed by it would otherwise become that team's
  const next = await (await post('/api/console/teams/add', { name: 'After The Crew' }, sess)).json();
  check('a deleted team\'s id is never given to the next team, so its people and channel do not go with it',
    next.ok && next.id > crewId && raw.prepare('SELECT MAX(id) AS m FROM teams').get().m === next.id &&
    !raw.prepare('SELECT 1 FROM participants WHERE team_id = ?').get(next.id) &&
    !raw.prepare('SELECT 1 FROM discord_teams WHERE team_id = ?').get(next.id),
    JSON.stringify({ deleted: crewId, next: next.id }));
  // every way a team is made names its id, so none can hand an old one out
  const src = join(BOT, 'src');
  const inserts = [];
  for (const f of readdirSync(src).filter(n => /\.(ts|js)$/.test(n))) {
    const text = readFileSync(join(src, f), 'utf8');
    const re = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+teams\s*\(([^)]*)\)([^;]{0,80})/gi;
    let m;
    while ((m = re.exec(text))) inserts.push({ f, cols: m[1].trim(), rest: m[2] });
  }
  check('every INSERT INTO teams in the worker gives the id, from NEXT_TEAM_ID',
    inserts.length >= 3 && inserts.every(x => /^id\s*,/.test(x.cols) && /NEXT_TEAM_ID/.test(x.rest)), JSON.stringify(inserts));
  // two adds of one name in two cases at once: one team, never a 500
  const twins = await Promise.all([post('/api/console/teams/add', { name: 'Twin Crew' }, sess), post('/api/console/teams/add', { name: 'twin crew' }, sess)]);
  const reserved = [
    (await post('/api/console/teams/add', { name: 'No Team Yet' }, sess)).status,
    (await post('/api/console/teams/rename', { id: next.id, name: 'no team yet' }, sess)).status
  ];
  check('a name in another case added at the same moment is refused as taken, and the name check-in gives people without a team is refused',
    twins.map(x => x.status).sort().join() === '200,409' &&
    raw.prepare("SELECT COUNT(*) AS n FROM teams WHERE name = 'twin crew' COLLATE NOCASE").get().n === 1 && reserved.join() === '400,400',
    JSON.stringify({ twins: twins.map(x => x.status), reserved }));
  for (const name of ['After The Crew', 'Twin Crew', 'twin crew']) {
    const t = raw.prepare('SELECT id, name FROM teams WHERE name = ?').get(name);
    if (t) await post('/api/console/teams/delete', { id: t.id, confirm: t.name }, sess);
  }
  raw.prepare("DELETE FROM participants WHERE name = 'Paper Trail'").run();
  raw.prepare("DELETE FROM discord_teams WHERE guild_id = 'g-old'").run();
}
// ---------------- the log ----------------
r = await get('/api/console/log?limit=100', sess);
data = await r.json();
const actions = data.entries.map(e => e.action);
check('every console action is in the log with the actor',
  data.entries.every(e => e.actor && e.actor.indexOf('console:') === 0) &&
  ['team-add', 'team-rename', 'team-delete', 'quest-add', 'quest-edit', 'quest-delete',
   'ledger-adjust', 'login', 'login-failed'].every(a => actions.includes(a)),
  JSON.stringify([...new Set(actions)]));
const firstPage = await (await get('/api/console/log?limit=5', sess)).json();
const secondPage = await (await get('/api/console/log?limit=5&before=' + firstPage.entries[4].id, sess)).json();
check('the log pages cleanly', secondPage.entries.length === 5 && secondPage.entries[0].id < firstPage.entries[4].id, '');

// the Discord side still answers
const score = await mod.runCommand({ type: 2, data: { name: 'score', options: [{ name: 'team', value: 'Galahs', type: 3 }] } }, ENV);
check('the Discord commands still work beside the console', /points/.test(score), '');

// ---------------- hiding test teams ----------------
r = await get('/api/console/overview', sess);
const garb = (await r.json()).teams.find(t => t.name === 'Galahs');
const lbBefore = await mod.apiResponse('/api/leaderboard', db);
const questsBefore = await mod.apiResponse('/api/quests', db);
r = await post('/api/console/teams/hide', { id: garb.id, hidden: true }, sess);
check('the console can hide a team', (await r.json()).hidden === 1, '');
const lbHidden = await mod.apiResponse('/api/leaderboard', db);
check('a hidden team vanishes from the leaderboard',
  lbBefore.teams.some(t => t.name === 'Galahs') && !lbHidden.teams.some(t => t.name === 'Galahs'), '');
const questsHidden = await mod.apiResponse('/api/quests', db);
check('quest counts stop counting it, denominator included',
  questsHidden.total_teams === questsBefore.total_teams - 1 &&
  questsHidden.quests.reduce((n, q) => n + q.teams_done, 0) ===
    questsBefore.quests.reduce((n, q) => n + q.teams_done, 0) - garb.quests_done,
  JSON.stringify({ before: questsBefore.total_teams, after: questsHidden.total_teams }));
const statsHidden = await mod.apiResponse('/api/stats', db);
check('stats count only visible teams', statsHidden.total_teams === questsHidden.total_teams, '');
const hiddenScore = await mod.runCommand({ type: 2, data: { name: 'score', options: [{ name: 'team', value: 'Galahs', type: 3 }] } }, ENV);
check('Discord reads treat a hidden team as unknown', !/points from/.test(hiddenScore), hiddenScore);
r = await get('/api/console/overview', sess);
check('the console still sees it, flagged hidden',
  (await r.json()).teams.find(t => t.name === 'Galahs').hidden === 1, '');
// by list, the way the Access tab shows every team in a team group
r = await post('/api/console/teams/hide', { ids: [garb.id], hidden: false }, sess);
const lbBack = await mod.apiResponse('/api/leaderboard', db);
const shown = await r.json();
check('showing it again restores every read',
  shown.hidden === 0 && shown.count === 1 && lbBack.teams.some(t => t.name === 'Galahs'), JSON.stringify(shown));
r = await get('/api/console/log?limit=10', sess);
const hideActions = (await r.json()).entries.map(e => e.action);
check('hide and show are in the audit log',
  hideActions.includes('team-hide') && hideActions.includes('team-show'), JSON.stringify(hideActions.slice(0, 4)));

// ---------------- what the live tab reads ----------------
// Last scored on the leaderboard, and the count of submissions still
// waiting on the stats.
r = await post('/api/console/teams/add', { name: 'Last Scored Crew' }, sess);
const lastCrew = (await r.json()).id;
r = await post('/api/console/teams/add', { name: 'Never Scored Crew' }, sess);
const emptyCrew = (await r.json()).id;
// a quest that belongs to a group, so the name comes off the group
// rather than falling back to the code
raw.prepare("INSERT INTO quest_groups (key, name, region) VALUES ('SQX', 'Across the Coathanger', 'Harbour')").run();
const sqxGroup = raw.prepare("SELECT id FROM quest_groups WHERE key = 'SQX'").get().id;
await post('/api/console/quests/add', { code: 'SQX-1', points: 40 }, sess);
raw.prepare('UPDATE quests SET group_id = ? WHERE code = ?').run(sqxGroup, 'SQX-1');
await post('/api/console/quests/add', { code: 'SQX-0', points: 10 }, sess);
raw.prepare('UPDATE quests SET group_id = ? WHERE code = ?').run(sqxGroup, 'SQX-0');
// each is an accepted submission with its line, and Last scored reads
// when it was sent
const accepted = (code, at) => {
  const id = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code, status, submitted_at, credit) VALUES (?, ?, 'accepted', ?, ?)")
    .run(lastCrew, code, at, JSON.stringify({ codes: [code], amount: 1 })).lastInsertRowid);
  credit(raw, lastCrew, code, 1, { kind: 'submission', id, at });
};
accepted('SQX-0', '2026-10-20 09:10:00');
accepted('SQX-1', '2026-10-20 14:21:00');
const sentAt = (code, at) => raw.prepare('UPDATE submissions SET submitted_at = ? WHERE team_id = ? AND quest_code = ?').run(at, lastCrew, code);

let board = await mod.apiResponse('/api/leaderboard', db);
let lastRow = board.teams.find(t => t.name === 'Last Scored Crew');
check('the leaderboard says which quest a team last had accepted, and when it was sent',
  lastRow.last_quest && lastRow.last_quest.code === 'SQX-1' &&
  lastRow.last_quest.at === '2026-10-20 14:21:00',
  JSON.stringify(lastRow.last_quest));
check('and gives it the quest name rather than the bare code',
  lastRow.last_quest.name === 'Across the Coathanger', JSON.stringify(lastRow.last_quest));
check('a team that has scored nothing has no last quest rather than a made-up one',
  board.teams.find(t => t.name === 'Never Scored Crew').last_quest === null, '');

// the pick follows the stamp, not the order the rows went in: the
// first-inserted code gets the newest time and has to win
sentAt('SQX-0', '2026-10-20 15:02:00');
board = await mod.apiResponse('/api/leaderboard', db);
check('the last quest is the newest one, whatever order the entries were made in',
  board.teams.find(t => t.name === 'Last Scored Crew').last_quest.code === 'SQX-0',
  JSON.stringify(board.teams.find(t => t.name === 'Last Scored Crew').last_quest));
sentAt('SQX-0', '2026-10-20 09:10:00');

// None moves it: an award with no submission behind it, landing on a
// code the team already holds (which restamps that completion), an entry
// that took points off and an adjustment that put some on. None changes
// what the team sent last.
credit(raw, lastCrew, 'SQX-0', 1, { kind: 'award', at: '2026-10-21 10:00:00' });
const newest = raw.prepare('UPDATE submissions SET submitted_at = ? WHERE id = (SELECT MAX(id) FROM submissions WHERE team_id = ? AND quest_code = ?)');
await post('/api/console/ledger/adjust', { team_id: lastCrew, code: 'SQX-0', points: -10, reason: 'Not done' }, sess);
newest.run('2026-10-20 15:30:00', lastCrew, 'SQX-0');
await post('/api/console/ledger/adjust', { team_id: lastCrew, code: 'SQX-0', points: 5, reason: 'Ruling' }, sess);
newest.run('2026-10-20 16:00:00', lastCrew, 'SQX-0');
board = await mod.apiResponse('/api/leaderboard', db);
lastRow = board.teams.find(t => t.name === 'Last Scored Crew');
check('an award by place, an entry taking points off or an adjustment does not become the last quest scored',
  lastRow.last_quest.code === 'SQX-1' && lastRow.last_quest.at === '2026-10-20 14:21:00', JSON.stringify(lastRow.last_quest));

// the waiting count
const hiddenCrew = (await (await post('/api/console/teams/add', { name: 'Hidden Queue Crew' }, sess)).json()).id;
await post('/api/console/teams/hide', { id: hiddenCrew, hidden: true }, sess);
const queue = (teamId, status) => raw.prepare(
  'INSERT INTO submissions (team_id, quest_code, status, submitted_at) VALUES (?, ?, ?, ?)'
).run(teamId, 'SQX-1', status, '2026-10-20 12:00:00');
let statsNow = await mod.apiResponse('/api/stats', db);
check('nothing waiting reads as zero rather than missing',
  statsNow.submissions_pending === 0, JSON.stringify(statsNow.submissions_pending));
queue(lastCrew, 'pending');
queue(lastCrew, 'pending');
queue(lastCrew, 'accepted');
queue(lastCrew, 'rejected');
statsNow = await mod.apiResponse('/api/stats', db);
check('the stats count submissions still waiting on review, and only those',
  statsNow.submissions_pending === 2, JSON.stringify(statsNow.submissions_pending));
queue(hiddenCrew, 'pending');
statsNow = await mod.apiResponse('/api/stats', db);
check('a hidden team’s waiting submissions are out of the count like every other public number',
  statsNow.submissions_pending === 2, JSON.stringify(statsNow.submissions_pending));

// ---------------- an unmigrated database explains itself ----------------
const boom = await mod.default.fetch(new Request('https://bot.example/api/stats'),
  { DB: { prepare() { throw new Error('no such column: hidden'); } } }, { waitUntil() {} });
const boomBody = await boom.json();
check('a database behind the code answers with the reason and the command that fixes it',
  boom.status === 500 && boomBody.error.includes('no such column: hidden') &&
  boomBody.error.includes('db:migrate'), JSON.stringify(boomBody));

// ---------------- check-in reports ----------------
// The check-in worker POSTs here with the shared key. It has to be
// routed ahead of the Discord signature check or it 401s.
ENV.TAB_SYNC_KEY = 'sync-key';
r = await front('/api/team-checkin', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ team_name: 'galahs', completed_at: '2026-10-20 00:15:00', people: 4 }) });
check('a report without the key is refused', r.status === 401, 'status=' + r.status);
r = await front('/api/team-checkin', { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sync-key' },
  body: JSON.stringify({ team_name: 'galahs', completed_at: '2026-10-20 00:15:00', people: 4 }) });
data = await r.json();
check('a keyed report lands and takes the tab spelling',
  r.status === 200 && data.ok && data.team_name === 'Galahs' && data.matched_tab_team === true, JSON.stringify(data));
const arrived = (await db.prepare('SELECT team_name, people FROM team_checkins').all()).results;
check('the report is kept', arrived.length === 1 && arrived[0].team_name === 'Galahs' &&
  arrived[0].people === 4, JSON.stringify(arrived));
r = await front('/api/team-checkin', { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer sync-key' },
  body: JSON.stringify({ team_name: 'Galahs', completed_at: null, people: 4 }) });
check('an undo takes the row back out',
  (await db.prepare('SELECT COUNT(*) AS n FROM team_checkins').first()).n === 0, '');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
