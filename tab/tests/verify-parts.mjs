// Run with: node tests/verify-parts.mjs   (needs Node 22+ for node:sqlite)
// Each code of a quest is a part with a scoring type (src/parts.ts):
// what Accept takes for each type, what a line is worth, a tiered code
// re-scored when its bands change, a counted part awarded its bands and
// places, and what a save refuses.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
import { ledgerAgrees } from './ledger-fixture.mjs';
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
const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const ENV = { DB: d1Shim(raw), CONSOLE_PASSWORD: 'tab-pass' };
const front = (path, opts) => mod.default.fetch(new Request('https://tab.example' + path, opts), ENV, ctx);
const post = (path, body, token) => front(path, {
  method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
const admin = (await consoleSignIn(post, 'Alex', 'tab-pass')).session;
const save = async body => { const r = await post('/api/console/quests/group/save', body, admin); return { status: r.status, body: await r.json() }; };
const team = Number(raw.prepare("INSERT INTO teams (name) VALUES ('Part Crew')").run().lastInsertRowid);
const rival = Number(raw.prepare("INSERT INTO teams (name) VALUES ('Rival Crew')").run().lastInsertRowid);
const sub = (code, who = team) => Number(raw.prepare('INSERT INTO submissions (team_id, quest_code) VALUES (?, ?)').run(who, code).lastInsertRowid);
const accept = async body => { const r = await post('/api/console/submissions/accept', body, admin); return { status: r.status, body: await r.json() }; };
const held = (code, who = team) => raw.prepare('SELECT amount, points FROM held WHERE team_id = ? AND quest_code = ?').get(who, code) || { amount: 0, points: 0 };
const total = (who = team) => raw.prepare('SELECT ROUND(COALESCE(SUM(points), 0), 2) AS p FROM held WHERE team_id = ?').get(who).p;

// ---------------- saving parts ----------------
const tiered = await save({ key: 'PQ1', name: 'Mount suburbs', region: '', codes: [
  { code: 'PQ1', label: 'Suburbs', scoring: 'tiered', bands: '1: 50, 2: 100, 3: 175' },
  { code: 'PQ1-M', label: 'Mount Druitt', scoring: 'fixed', points: 50 }
] });
const pq1 = (tiered.body.group && tiered.body.group.codes || []).find(c => c.code === 'PQ1') || {};
const refusals = await Promise.all([
  save({ key: 'PQ9', name: 'No bands', region: '', codes: [{ code: 'PQ9', scoring: 'tiered', bands: '' }] }),
  save({ key: 'PQ9', name: 'Two counted', region: '', rules: { tally: { kind: 'submissions' } },
    codes: [{ code: 'PQ9', scoring: 'counted' }, { code: 'PQ9-B', scoring: 'counted' }] }),
  save({ key: 'PQ9', name: 'Counted with nothing to count', region: '', codes: [{ code: 'PQ9', scoring: 'counted' }] }),
  save({ key: 'PQ9', name: 'Bad type', region: '', codes: [{ code: 'PQ9', scoring: 'sometimes', points: 5 }] })
]);
check('a tiered part is worth its top band, and a save refuses a tiered part with no bands, two counted parts, a counted part with nothing counted and a type that is not one',
  tiered.status === 200 && pq1.scoring === 'tiered' && pq1.points === 175 && JSON.stringify(pq1.bands) === JSON.stringify([
    { from: 1, points: 50 }, { from: 2, points: 100 }, { from: 3, points: 175 }]) &&
  refusals.every(r => r.status === 400) && !raw.prepare("SELECT 1 FROM quests WHERE code = 'PQ9'").get(),
  JSON.stringify({ status: tiered.status, pq1, refusals: refusals.map(r => r.body.error) }));

// ---------------- what Accept takes for each type ----------------
await save({ key: 'PQ2', name: 'Per floor', region: '', codes: [{ code: 'PQ2', scoring: 'unit', points: 5, most: 10 }] });
const s1 = sub('PQ1');
const noNumber = await accept({ id: s1, codes: ['PQ1'] });
const twiceFixed = await accept({ id: s1, codes: ['PQ1', 'PQ1-M'], counts: { 'PQ1-M': 2 }, numbers: { PQ1: 2 } });
const s2 = sub('PQ2');
const overMost = await accept({ id: s2, amount: 11 });
const partOnUnit = await accept({ id: s2, amount: 3, awarded: { PQ2: 10 } });
check('Accept refuses a tiered code with no number, a fixed code counted twice, a per-unit count over its most and a part mark on a code that is not judged, deciding nothing',
  [noNumber, twiceFixed, overMost, partOnUnit].every(r => r.status === 400) &&
  raw.prepare("SELECT COUNT(*) AS n FROM submissions WHERE id IN (?, ?) AND status = 'pending'").get(s1, s2).n === 2,
  JSON.stringify([noNumber, twiceFixed, overMost, partOnUnit].map(r => r.body.error)));

const tierAccept = await accept({ id: s1, codes: ['PQ1', 'PQ1-M'], numbers: { PQ1: 2 } });
const unitAccept = await accept({ id: s2, amount: 7 });
const tierLine = raw.prepare("SELECT units, points, input FROM entries WHERE code = 'PQ1' AND source_id = ? AND voided_at IS NULL").get(s1);
check('a tiered code is worth the band its number reached and keeps the number on its line, and a per-unit code its points for each one',
  tierAccept.status === 200 && tierAccept.body.gained === 150 && held('PQ1').points === 100 && held('PQ1-M').points === 50 &&
  tierLine && tierLine.units === 1 && JSON.parse(tierLine.input).number === 2 &&
  unitAccept.body.gained === 35 && held('PQ2').amount === 7 && held('PQ2').points === 35 && total() === 185 && !ledgerAgrees(raw).length,
  JSON.stringify({ tierAccept: tierAccept.body, unitAccept: unitAccept.body, tierLine, total: total() }));

// ---------------- a tiered code's bands change ----------------
const s3 = sub('PQ1', rival);
await accept({ id: s3, codes: ['PQ1'], numbers: { PQ1: 5 } });
await save({ id: tiered.body.group.id, key: 'PQ1', name: 'Mount suburbs', region: '', codes: [
  { was: 'PQ1', code: 'PQ1', label: 'Suburbs', scoring: 'tiered', bands: '1: 60, 2: 120, 4: 250' },
  { was: 'PQ1-M', code: 'PQ1-M', label: 'Mount Druitt', scoring: 'fixed', points: 50 }
] });
const rebanded = raw.prepare("SELECT team_id, points, void_reason FROM entries WHERE code = 'PQ1' ORDER BY id").all();
const check1 = await ledger.ledgerCheck(ENV.DB);
check('new bands re-score every line a submission wrote on the code from the number it reached, and the check finds nothing wrong',
  held('PQ1').points === 120 && held('PQ1', rival).points === 250 &&
  rebanded.filter(l => /bands changed/.test(l.void_reason || '')).length === 2 && !check1.length && !ledgerAgrees(raw).length,
  JSON.stringify({ rebanded, check1 }));
raw.prepare("UPDATE entries SET points = 999 WHERE code = 'PQ1' AND team_id = ? AND voided_at IS NULL").run(rival);
const check2 = await ledger.ledgerCheck(ENV.DB);
check('the check catches a tiered line worth something other than its band',
  check2.length === 1 && check2[0].code === 'PQ1' && check2[0].tab === 250, JSON.stringify(check2));
raw.prepare("UPDATE entries SET points = 250 WHERE code = 'PQ1' AND team_id = ? AND voided_at IS NULL").run(rival);

// ---------------- a counted part ----------------
const counted = await save({ key: 'PQ3', name: 'Stations', region: '',
  rules: { tally: { kind: 'submissions', awards: '300, 100' } },
  codes: [{ code: 'PQ3', label: 'Stations', scoring: 'counted', bands: '2: 100, 3: 175' }, { code: 'PQ3-B', label: 'Longest word', scoring: 'fixed', points: 100 }] });
const pq3 = (counted.body.group && counted.body.group.codes || []).find(c => c.code === 'PQ3') || {};
const before = total();
for (let i = 0; i < 3; i++) await accept({ id: sub('PQ3'), codes: ['PQ3'] });
const rivalSubs = [];
for (let i = 0; i < 2; i++) { const id = sub('PQ3', rival); rivalSubs.push(id); await accept({ id, codes: ['PQ3'] }); }
check('a counted part is worth its top band and first place, and each accepted submission on it adds to the count and is worth nothing yet',
  pq3.points === 475 && total() === before && held('PQ3').amount === 3 && held('PQ3').points === 0, JSON.stringify({ pq3, held: held('PQ3') }));
const awarded = await (await post('/api/console/tally/award', { quest: 'PQ3' }, admin)).json();
const again = await post('/api/console/tally/award', { quest: 'PQ3' }, admin);
check('awarding gives each team its band and its place on the counted part as one line, once',
  awarded.ok && held('PQ3').points === 475 && held('PQ3', rival).points === 200 && again.status === 409 &&
  raw.prepare("SELECT COUNT(*) AS n FROM entries WHERE source_kind = 'award' AND code = 'PQ3' AND voided_at IS NULL").get().n === 2 &&
  !ledgerAgrees(raw).length && !(await ledger.ledgerCheck(ENV.DB)).length,
  JSON.stringify({ awarded, mine: held('PQ3'), rival: held('PQ3', rival) }));
const unaward = await (await post('/api/console/tally/unaward', { quest: 'PQ3' }, admin)).json();
check('undoing the award takes the bands and places off together',
  unaward.ok && held('PQ3').points === 0 && held('PQ3', rival).points === 0, JSON.stringify(unaward));

// ---------------- an adjustment on a tiered code ----------------
const adjust = await (await post('/api/console/ledger/adjust', { team_id: team, code: 'PQ1', points: 30, reason: 'Fourth suburb seen late' }, admin)).json();
check('an adjustment on a tiered code is worth exactly the points given',
  adjust.ok && held('PQ1').points === 150 && !ledgerAgrees(raw).length, JSON.stringify({ adjust, held: held('PQ1') }));

// ---------------- the team's own score sheet ----------------
// A tiered or counted line carries no amount or points, only what it came
// to, and says which it is so the page does not read it as a part mark.
{
  await post('/api/console/codes/generate', {}, admin);
  const code = ((await (await get('/api/console/codes', admin)).json()).codes || []).find(c => c.name === 'Part Crew');
  const crew = (await (await post('/api/submit/login', { team_name: 'Part Crew', code: code && code.code })).json()).session;
  const sheet = await (await get('/api/submit/score', crew)).json();
  const line = c => (sheet.lines || []).find(l => l.code === c) || {};
  check('the score sheet names each line\'s type, and a tiered or counted line gives only what it came to',
    line('PQ1').scoring === 'tiered' && line('PQ1').amount === null && line('PQ1').points === null && line('PQ1').worth === 150 &&
    line('PQ3').scoring === 'counted' && line('PQ3').points === null &&
    line('PQ2').scoring === 'unit' && line('PQ2').amount === 7 && line('PQ2').points === 5,
    JSON.stringify(sheet.lines));
}

// ---------------- what a save, a Change and the old edit refuse ----------------
// A held code's lines were written for its type, a save that leaves codes
// out is held to the codes it leaves, an adjustment keeps its set worth,
// and a tiered code's points follow its bands.
{
  const pq1Id = tiered.body.group.id;
  const pq3Id = counted.body.group.id;
  const refused = [
    // Part Crew holds PQ1-M, which is fixed
    await save({ id: pq1Id, key: 'PQ1', name: 'Mount suburbs', region: '', codes: [{ was: 'PQ1-M', code: 'PQ1-M', label: 'Mount Druitt', scoring: 'tiered', bands: '1: 50' }] }),
    // both crews hold PQ3, which is counted
    await save({ id: pq3Id, key: 'PQ3', name: 'Stations', region: '', codes: [{ was: 'PQ3', code: 'PQ3', scoring: 'fixed', points: 10 }] }),
    // PQ3, left out of the save, is counted already
    await save({ id: pq3Id, key: 'PQ3', name: 'Stations', region: '', codes: [{ was: 'PQ3-B', code: 'PQ3-B', label: 'Longest word', scoring: 'counted', bands: '1: 10' }] }),
    await save({ id: pq3Id, key: 'PQ3', name: 'Stations', region: '', rules: { tally: { kind: '' } },
      codes: [{ was: 'PQ3-B', code: 'PQ3-B', label: 'Longest word', scoring: 'fixed', points: 100 }] })
  ];
  const types = raw.prepare("SELECT code, scoring FROM quests WHERE code IN ('PQ1-M', 'PQ3', 'PQ3-B') ORDER BY code").all().map(q => q.code + ':' + q.scoring).join();
  check('a save refuses a held code moving into or out of bands, and a second counted part or a counted part with nothing counted when the save leaves the counted part out',
    refused.map(r => r.status).join() === '409,409,400,400' && /on the tab for 1 team/.test(refused[0].body.error) && types === 'PQ1-M:,PQ3:counted,PQ3-B:',
    JSON.stringify({ refused: refused.map(r => [r.status, r.body.error]), types }));
  const revise = await post('/api/console/submissions/revise', { id: adjust.id, codes: ['PQ1'], numbers: { PQ1: 3 } }, admin);
  const edit = await post('/api/console/quests/edit', { code: 'PQ1', points: 500 }, admin);
  check('Change refuses an adjustment, and the old edit a tiered code, changing nothing',
    revise.status === 409 && edit.status === 409 && held('PQ1').points === 150 &&
    raw.prepare("SELECT points FROM quests WHERE code = 'PQ1'").get().points === 250,
    JSON.stringify({ revise: revise.status, edit: edit.status, held: held('PQ1') }));
}

// ---------------- the public list ----------------
const pub = (await (await get('/api/questlist')).json()).groups.find(g => g.key === 'PQ1');
raw.prepare("UPDATE quest_groups SET mystery = 1 WHERE key = 'PQ1'").run();
const hush = (await (await get('/api/questlist')).json()).groups.find(g => g.key === 'PQ1');
const pubCode = pub.codes.find(c => c.code === 'PQ1');
const hushCode = hush.codes.find(c => c.code === 'PQ1');
check('the public list carries a part\'s type and bands, and a mystery quest\'s bands keep their points to themselves',
  pubCode.scoring === 'tiered' && pubCode.bands.length === 3 && pubCode.bands[2].points === 250 &&
  hushCode.points === null && hushCode.bands.every(b => b.points === null && b.from > 0), JSON.stringify({ pubCode, hushCode }));

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
