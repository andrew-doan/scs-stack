// Run with: node tests/verify-eoi.mjs
// The EOI award: a CSV of the people who filled in the expression of
// interest, matched to signups by zID or email address, worth a set
// number of points per person to their team. It adds to the team's
// total everywhere a total is read, counts as no quest, is never a
// team's last score, and shows on the team page in a table of its own.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
import { credit, ledgerAgrees } from './ledger-fixture.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let fail = 0;
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) fail++;
};

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
const db = d1Shim(raw);
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };
const mod = await import(BOT + '/src/index.ts');
const { parseEoi } = await import(BOT + '/src/eoi.ts');
const ENV = { DB: db, CONSOLE_PASSWORD: 'tab-pass' };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
const session = (await consoleSignIn(jpost, 'Tab', 'tab-pass')).session;

// two teams on the tab, one signup still without a team, and a quest done
raw.exec(`
  INSERT INTO teams (id, name) VALUES (1, 'Opal Tappers'), (2, 'Running Rocks');
  INSERT INTO registrations (id, team_id, team_name) VALUES (1, 1, 'Opal Tappers'), (2, 2, 'Running Rocks'), (3, NULL, '');
  INSERT INTO participants (registration_id, team_id, position, name, zid, email) VALUES
    (1, 1, 1, 'Ann', 'z5000001', 'ann@ad.unsw.edu.au'),
    (1, 1, 2, 'Bo',  'z5000002', 'BO@example.com'),
    (1, 1, 3, 'Cy',  'z0000000', 'cy@example.com'),
    (2, 2, 1, 'Di',  'z5000004', 'di@example.com'),
    (2, 2, 2, 'Ed',  'z5000005', 'ed@example.com'),
    (3, NULL, 1, 'Fi', 'z5000006', 'fi@example.com');
  INSERT INTO quests (code, norm, points) VALUES ('S1', 'S1', 100);
`);
credit(raw, 2, 'S1', 1, { at: '2026-10-20 03:00:00' });

// ---------------- reading the file ----------------
const parsed = parseEoi([
  'Timestamp,Email address,zID,Name',
  '"20/09/2026 10:00",someone@else.com,5000001,Ann',   // a different address, the zID matches
  '20/09/2026 10:01,bo@example.com,,Bo',                // no zID, the address matches whatever its case
  'cy@example.com;z0000000',                            // the placeholder zID is not a zID
  '"Di, the second",z5000004',
  'Fi,fi@example.com',
  'nobody@nowhere.com,z5999999',
  'bo@example.com,,Bo again',                           // the same person twice
  'just a name'
].join('\r\n'));
check('a row is read for its email and zID whatever the columns, headings and blank rows passed over',
  parsed.rows.length === 6 && parsed.rows[0].z === 'z5000001' && parsed.rows[0].e === 'someone@else.com' &&
  parsed.rows[2].e === 'cy@example.com' && parsed.rows[2].z === '' && parsed.rows[3].z === 'z5000004' && parsed.skipped === 2,
  JSON.stringify(parsed));

// ---------------- the list on its own gives nothing ----------------
const list = ['Email,zID', 'someone@else.com,5000001', 'bo@example.com,', 'cy@example.com,', 'Di,z5000004', 'fi@example.com', 'nobody@nowhere.com,z5999999'].join('\n');
let r = await jpost('/api/console/eoi/list', { csv: list }, session);
let d = await r.json();
check('uploading the list with no points set stores it and gives nobody anything',
  r.status === 200 && d.listed === 6 && d.points === null && !raw.prepare("SELECT 1 FROM held WHERE quest_code = 'EOI'").get(),
  JSON.stringify(d));
check('and says how many signed up, how many are in a team and how many have not signed up',
  d.signed_up === 5 && d.in_teams === 4 && d.not_signed_up === 1, JSON.stringify(d));

// ---------------- points per person, then the award ----------------
r = await jpost('/api/console/eoi/points', { points: 50 }, session);
d = await r.json();
check('setting the points gives nobody anything until the points are awarded',
  r.status === 200 && !raw.prepare("SELECT 1 FROM held WHERE quest_code = 'EOI'").get() && d.award === null && d.waiting === 2,
  JSON.stringify(d));
const eoiAt = () => raw.prepare("SELECT team_id, amount FROM held WHERE quest_code = 'EOI' ORDER BY team_id").all();
const presses = await Promise.all([jpost('/api/console/eoi/award', {}, session), jpost('/api/console/eoi/award', {}, session)]);
d = await presses[0].json();
const eoiRows = eoiAt();
check('awarding gives each team one award per person on the list, once however often it is pressed at the same moment',
  presses.map(x => x.status).sort().join() === '200,409' && eoiRows.length === 2 && eoiRows[0].amount === 3 && eoiRows[1].amount === 1 &&
  d.teams.map(t => t.name + ' ' + t.people + ' ' + t.awarded).join() === 'Opal Tappers 3 3,Running Rocks 1 1' &&
  !!d.award && d.waiting === 0 &&
  raw.prepare("SELECT COUNT(*) AS n FROM awards WHERE kind = 'eoi' AND voided_at IS NULL").get().n === 1,
  JSON.stringify({ statuses: presses.map(x => x.status), eoiRows, d }));
const quest = raw.prepare("SELECT * FROM quests WHERE code = 'EOI'").get();
check('the award is a hidden code with no quest round it',
  quest.hidden === 1 && quest.group_id === null && quest.points === 50, JSON.stringify(quest));

// ---------------- where it shows ----------------
const lb = await (await get('/api/leaderboard')).json();
const opal = lb.teams.find(t => t.name === 'Opal Tappers');
const sucks = lb.teams.find(t => t.name === 'Running Rocks');
check('it is on the team\'s total, but it is not a quest done and not what they last scored',
  !!opal && !!sucks && opal.points === 150 && opal.quests_done === 0 && !opal.last_quest &&
  sucks.points === 150 && sucks.quests_done === 1 && sucks.last_quest.code === 'S1', JSON.stringify(lb).slice(0, 600));
const ql = await (await get('/api/questlist')).json();
check('it is not in the quest list', !JSON.stringify(ql).includes('"EOI"'), '');

await jpost('/api/console/flags/set', { name: 'team_pages', value: true }, session);
const team = await (await get('/api/team?name=Opal%20Tappers')).json();
const award = (team.lines || []).find(l => l.code === 'EOI');
check('the team page lists it under Non-Quest Tasks, by its name, three times over',
  !!award && award.region === 'Non-Quest Tasks' && award.name === 'Expression of interest' && award.amount === 3 && award.worth === 150 && team.quests_done === 0,
  JSON.stringify(team.lines));

// ---------------- keeping up ----------------
r = await jpost('/api/console/eoi/points', { points: 20 }, session);
check('changing the points re-scores every team the award gave points',
  (await (await get('/api/team?name=Opal%20Tappers')).json()).total === 60 &&
  raw.prepare("SELECT COUNT(*) AS n FROM entries WHERE code = 'EOI' AND void_reason LIKE 'Re-scored%'").get().n === 2, '');
raw.prepare("UPDATE participants SET team_id = 2 WHERE name = 'Fi'").run();
d = await (await get('/api/console/eoi', session)).json();
const unmoved = eoiAt();
r = await jpost('/api/console/eoi/award', {}, session);
const again = await r.json();
const after = eoiAt();
check('somebody put in a team later waits for the next award, which voids the last one and counts again',
  d.waiting === 1 && unmoved[1].amount === 1 && r.status === 200 && after[1].amount === 2 && after[0].amount === 3 &&
  raw.prepare("SELECT COUNT(*) AS n FROM awards WHERE kind = 'eoi' AND voided_at IS NOT NULL").get().n === 1 &&
  (await (await jpost('/api/console/eoi/award', {}, session)).json()).unchanged === true,
  JSON.stringify({ waiting: d.waiting, unmoved, after, again }));
r = await jpost('/api/console/eoi/list', { csv: 'fi@example.com' }, session);
d = await r.json();
await jpost('/api/console/eoi/award', {}, session);
const left = eoiAt();
check('a new list replaces the old one, and once awarded a team with nobody left on it loses the award',
  d.listed === 1 && left.length === 1 && left[0].team_id === 2 && left[0].amount === 1 && !ledgerAgrees(raw).length, JSON.stringify(left));
r = await jpost('/api/console/eoi/list', { csv: 'Name\njust words' }, session);
check('a file with no address or zID in it is refused and the list is kept',
  r.status === 400 && raw.prepare('SELECT COUNT(*) AS n FROM eoi_people').get().n === 1, '');
r = await jpost('/api/console/eoi/points', { points: -5 }, session);
check('points below zero are refused', r.status === 400, '');
r = await get('/api/console/eoi');
check('the dashboard needs a session for all of it', r.status === 401, String(r.status));

console.log(fail ? '\n' + fail + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
