// Run with: node tests/verify-points.mjs   (needs Node 22+ for node:sqlite)
// Points organisers record: every change to a score is a submission row
// — the Points tab's form, a take-back, a score set by hand — and an
// account can be limited to some quests, which it alone scores and
// reviews.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
import { pretendR2 } from './pretend-r2.mjs';
import { credit, uncredit, ledgerAgrees } from './ledger-fixture.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

function database(behind) {
  const raw = new DatabaseSync(':memory:');
  raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
  raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
  if (behind) {
    raw.exec("DROP VIEW held; DROP TABLE entries; DROP TABLE awards; DELETE FROM site_flags WHERE name = 'ledger_seeded';");
  }
  const g = Number(raw.prepare("INSERT INTO quest_groups (key, name, submit_kind, prompt) VALUES ('XQ1', 'Harbour Bridge Climb', 'count', 'How many climbed?')").run().lastInsertRowid);
  raw.prepare("INSERT INTO quests (code, norm, points, group_id, label) VALUES ('XQ1', 'XQ1', 300, ?, 'Climbed'), ('XQ1-2', 'XQ1-2', 150, ?, 'Whole team')").run(g, g);
  return raw;
}

const bucket = new Map();
const SUBMIT = {
  async put(key, value, opts) {
    bucket.set(key, { bytes: new Uint8Array(await new Response(value).arrayBuffer()), meta: (opts && opts.httpMetadata) || {}, custom: (opts && opts.customMetadata) || {} });
  },
  async delete(key) { bucket.delete(key); },
  async get(key) {
    const hit = bucket.get(key);
    if (!hit) return null;
    const bytes = hit.bytes;
    return { body: bytes, size: bytes.length, httpMetadata: hit.meta, customMetadata: hit.custom,
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
  }
};
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };

const mod = await import(BOT + '/src/index.ts');
const waits = [];
const ctx = { waitUntil(p) { waits.push(p); } };
function worker(raw, more) {
  const ENV = Object.assign({ DB: d1Shim(raw), SUBMIT, CONSOLE_PASSWORD: 'tab-pass' }, more);
  const front = (path, opts) => mod.default.fetch(new Request('https://tab.example' + path, opts), ENV, ctx);
  const post = (path, body, token) => front(path, {
    method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
    body: JSON.stringify(body)
  });
  const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
  const form = (path, fields, token) => {
    const fd = new FormData();
    Object.keys(fields).forEach(k => {
      const v = fields[k];
      if (v instanceof File) fd.append(k, v, v.name); else fd.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    });
    return front(path, { method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body: fd });
  };
  return { front, post, get, form };
}

// a picture whose first bytes say PNG
const PNG = new File([new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1])], 'top.png', { type: 'image/png' });
// a small copy the browser made of one, and a GPX track, sent with no type as a browser sends one
const thumbBytes = new Uint8Array(64);
thumbBytes.set([0xFF, 0xD8, 0xFF, 0xDA, 0, 2]);
thumbBytes.set([0xFF, 0xD9], 62);
const THUMB = new File([thumbBytes], 'thumb.jpg', { type: 'image/jpeg' });
const TRACK = new File(['<?xml version="1.0"?><gpx version="1.1"><trk><trkseg><trkpt lat="-33.9" lon="151.2"/></trkseg></trk></gpx>'], 'coast.gpx');

const raw = database(false);
const w = worker(raw);
const admin = (await consoleSignIn(w.post, 'Alex', 'tab-pass')).session;
const total = id => raw.prepare('SELECT COALESCE(SUM(c.amount * q.points), 0) AS n FROM held c JOIN quests q ON q.code = c.quest_code WHERE c.team_id = ?').get(id).n;
const [teamA, teamB] = raw.prepare('SELECT id, name FROM teams ORDER BY id LIMIT 2').all();

// ---------------- an account for one quest ----------------
await w.post('/api/console/accounts/save', { create: true, name: 'Marshal', password: 'marshal-pass-1', perms: ['points'], quests: ['XQ1'], require_2fa: false }, admin);
await w.post('/api/console/accounts/save', { create: true, name: 'Checker', password: 'checker-pass-1', perms: ['review'], quests: ['XQ1'], require_2fa: false }, admin);
const marshal = (await (await w.post('/api/console/login', { name: 'Marshal', password: 'marshal-pass-1' })).json()).session;
const checker = (await (await w.post('/api/console/login', { name: 'Checker', password: 'checker-pass-1' })).json()).session;

// ---------------- recording points ----------------
const before = total(teamA.id);
const added = await (await w.form('/api/console/points/add', {
  team_id: String(teamA.id), quest: 'XQ1', codes: ['XQ1', 'XQ1-2'], amount: '1',
  answer: { kind: 'count', value: 4 }, note: 'Whole team at the top', files: PNG
}, marshal)).json();
await Promise.all(waits.splice(0));
const row = raw.prepare('SELECT * FROM submissions WHERE id = ?').get(added.id) || {};
const files = raw.prepare('SELECT r2_key FROM submission_files WHERE submission_id = ?').all(added.id);
check('points recorded on the Points tab are a submission already accepted, with what it credited, its photo, and the tab moved by exactly that',
  added.ok && added.gained === 450 && row.status === 'accepted' && row.added_by === 'Marshal' && row.reviewed_by === 'Marshal' &&
  row.credit === JSON.stringify({ codes: ['XQ1', 'XQ1-2'], amount: 1 }) && JSON.parse(row.answer).value === 4 &&
  files.length === 1 && bucket.has(files[0].r2_key) && total(teamA.id) === before + 450,
  JSON.stringify({ added, status: row.status, credit: row.credit }));

const offered = await (await w.get('/api/console/points/form', marshal)).json();
const outside = await w.form('/api/console/points/add', { team_id: String(teamA.id), quest: 'S1' }, marshal);
const bySideDoor = await w.form('/api/console/points/add', { team_id: String(teamA.id), quest: 'XQ1', codes: ['S1'] }, marshal);
const setOutside = await w.post('/api/console/ledger/adjust', { team_id: teamA.id, code: 'S1', points: 20, reason: 'x' }, marshal);
const noReview = await w.get('/api/console/submissions?status=all', marshal);
check('an account limited to one quest is offered that quest alone, and refused points, a score or a tab anywhere else',
  offered.quests.map(q => q.key).join() === 'XQ1' && outside.status === 403 && bySideDoor.status === 400 &&
  setOutside.status === 403 && noReview.status === 403,
  [offered.quests.map(q => q.key).join(), outside.status, bySideDoor.status, setOutside.status, noReview.status].join(' '));

// a reviewer limited to the same quest sees and decides those alone
const subXQ = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'XQ1')").run(teamB.id).lastInsertRowid);
const subS1 = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'S1')").run(teamB.id).lastInsertRowid);
const queue = await (await w.get('/api/console/submissions?status=pending', checker)).json();
const notMine = await w.post('/api/console/submissions/accept', { id: subS1 }, checker);
const mine = await w.post('/api/console/submissions/accept', { id: subXQ }, checker);
check('a reviewer limited to a quest sees only its submissions, in the list and the counts, and can decide only those',
  queue.submissions.map(s => s.id).join() === String(subXQ) && queue.team_counts.map(t => t.id + ':' + t.n).join() === teamB.id + ':1' &&
  queue.pending.n === 1 &&
  notMine.status === 403 && mine.status === 200,
  JSON.stringify({ queue: queue.submissions.map(s => s.quest_code), teams: queue.team_counts, notMine: notMine.status, mine: mine.status }));
check('an accepted submission keeps what it credited',
  raw.prepare('SELECT credit FROM submissions WHERE id = ?').get(subXQ).credit === JSON.stringify({ codes: ['XQ1'], amount: 1 }), '');

// ---------------- part marks ----------------
// A judged code takes part of its points, stored as points given over
// points: 28 of 50 is 0.56, which multiplies back to 28.000000000000004,
// so the total has to come out of the sums rounded.
const partGroup = Number(raw.prepare("INSERT INTO quest_groups (key, name) VALUES ('XQ3', 'Opera House steps')").run().lastInsertRowid);
raw.prepare("INSERT INTO quests (code, norm, points, group_id, scoring) VALUES ('XQ3', 'XQ3', 50, ?, 'judged')").run(partGroup);
const crew = Number(raw.prepare("INSERT INTO teams (name) VALUES ('Part Mark Crew')").run().lastInsertRowid);
const pending = quest => Number(raw.prepare('INSERT INTO submissions (team_id, quest_code) VALUES (?, ?)').run(crew, quest).lastInsertRowid);
const offSwitch = pending('XQ1');
const refusedOff = await w.post('/api/console/submissions/accept', { id: offSwitch, awarded: { XQ1: 100 } }, admin);
const weak = pending('XQ3');
const refusedOver = await w.post('/api/console/submissions/accept', { id: weak, awarded: { XQ3: 51 } }, admin);
check('a part mark is refused on a code that is not judged and above the full points, and nothing is decided or credited',
  refusedOff.status === 400 && refusedOver.status === 400 &&
  raw.prepare("SELECT COUNT(*) AS n FROM submissions WHERE id IN (?, ?) AND status = 'pending'").get(offSwitch, weak).n === 2 &&
  !raw.prepare('SELECT 1 FROM held WHERE team_id = ?').get(crew),
  [refusedOff.status, refusedOver.status].join(' '));

const partly = await (await w.post('/api/console/submissions/accept', { id: weak, awarded: { XQ3: 28 } }, admin)).json();
await Promise.all(waits.splice(0));
const board = await (await w.get('/api/leaderboard')).json();
const teamsTab = await (await w.get('/api/console/overview', admin)).json();
const onBoard = board.teams.find(t => t.name === 'Part Mark Crew');
const onTab = (teamsTab.teams || []).find(t => t.id === crew);
check('a part mark on a judged code lands as exactly the points given: on the leaderboard, the dashboard and the accept',
  partly.ok && partly.gained === 28 && partly.full === 50 && partly.total === 28 && onBoard && onBoard.points === 28 &&
  onTab && onTab.pts === 28 && raw.prepare("SELECT amount FROM held WHERE team_id = ? AND quest_code = 'XQ3'").get(crew).amount === 28 / 50 &&
  JSON.parse(raw.prepare('SELECT credit FROM submissions WHERE id = ?').get(weak).credit).amounts.XQ3 === 28 / 50,
  JSON.stringify({ partly, board: onBoard, tab: onTab && onTab.pts }));

const organised = await (await w.form('/api/console/points/add', { team_id: String(crew), quest: 'XQ3', awarded: { XQ3: 29 } }, admin)).json();
await Promise.all(waits.splice(0));
const withBoth = total(crew);
const undone = await (await w.post('/api/console/points/undo', { id: organised.id }, admin)).json();
check('a part mark recorded on the Points tab gives exactly that, and taking it back takes off exactly that',
  organised.ok && organised.gained === 29 && organised.full === 50 && organised.total === 57 &&
  Math.round(withBoth * 100) / 100 === 57 && undone.ok && undone.total === 28,
  JSON.stringify({ organised, undone }));

// on a mystery quest a part mark must not give the full points away
raw.prepare('UPDATE quest_groups SET mystery = 1 WHERE id = ?').run(partGroup);
await w.post('/api/console/codes/generate', {}, admin);
const crewCode = ((await (await w.get('/api/console/codes', admin)).json()).codes || []).find(c => c.name === 'Part Mark Crew');
const crewSession = (await (await w.post('/api/submit/login', { team: 'Part Mark Crew', code: crewCode && crewCode.code })).json()).session;
const sheet = await (await w.get('/api/submit/score', crewSession)).json();
const sent = await (await w.get('/api/submit/mine', crewSession)).json();
const line = (sheet.lines || []).find(l => l.code === 'XQ3');
const partSent = (sent.submissions || []).find(s => s.id === weak);
check('on a mystery quest the team reads what a part mark gave and not the points it was out of',
  line && line.worth === 28 && line.points == null && line.amount == null &&
  partSent && partSent.part && partSent.part.given === 28 && partSent.part.of == null && !/"of":50|"points":50/.test(JSON.stringify([sheet, sent])),
  JSON.stringify({ line, part: partSent && partSent.part }));
raw.prepare('UPDATE quest_groups SET mystery = 0 WHERE id = ?').run(partGroup);

// ---------------- changing a decision ----------------
// An accepted submission's credit can be changed, it can be rejected
// after all, and a decided one can go back to pending. Each moves the
// team's points by what the submission gave, once, so the total always
// matches what its accepted rows say they gave.
// XQ4 is judged, its bonus counted per unit
const hopGroup = Number(raw.prepare("INSERT INTO quest_groups (key, name) VALUES ('XQ4', 'Ferry hop')").run().lastInsertRowid);
raw.prepare("INSERT INTO quests (code, norm, points, group_id, scoring) VALUES ('XQ4', 'XQ4', 100, ?, 'judged'), ('XQ4-B', 'XQ4-B', 40, ?, 'unit')").run(hopGroup, hopGroup);
const hop = Number(raw.prepare("INSERT INTO teams (name) VALUES ('Second Look')").run().lastInsertRowid);
const hopSub = () => Number(raw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'XQ4')").run(hop).lastInsertRowid);
const hopTotal = () => Math.round(total(hop) * 100) / 100;
const heldOn = c => Math.round((raw.prepare('SELECT amount FROM held WHERE team_id = ? AND quest_code = ?').get(hop, c) || { amount: 0 }).amount * 1e6) / 1e6;
const fromCredits = () => Math.round(raw.prepare("SELECT credit FROM submissions WHERE team_id = ? AND status = 'accepted' AND credit IS NOT NULL").all(hop)
  .reduce((sum, r) => {
    const c = JSON.parse(r.credit);
    return sum + c.codes.reduce((s, code) => s + raw.prepare('SELECT points FROM quests WHERE code = ?').get(code).points *
      (c.amounts && c.amounts[code] != null ? c.amounts[code] : c.amount), 0);
  }, 0) * 100) / 100;
const hopRow = () => raw.prepare('SELECT status, reason, credit FROM submissions WHERE id = ?').get(hopped);
const earlier = hopSub();
await w.post('/api/console/submissions/accept', { id: earlier, codes: ['XQ4-B'] }, admin);
const hopped = hopSub();
await w.post('/api/console/submissions/accept', { id: hopped, codes: ['XQ4', 'XQ4-B'], awarded: { XQ4: 60 } }, admin);
const beforeRevise = hopTotal();
const revised = await (await w.post('/api/console/submissions/revise', { id: hopped, codes: ['XQ4'], awarded: { XQ4: 80 } }, admin)).json();
check('changing what was accepted moves the total by the difference, a part mark included, and a code dropped goes back to what it held before',
  beforeRevise === 140 && revised.ok && revised.gained === 80 && revised.was === 100 && hopTotal() === 120 && revised.total === 120 &&
  heldOn('XQ4') === 0.8 && heldOn('XQ4-B') === 1 && fromCredits() === 120 &&
  hopRow().credit === JSON.stringify({ codes: ['XQ4'], amount: 1, amounts: { XQ4: 0.8 } }),
  JSON.stringify({ beforeRevise, revised, held: [heldOn('XQ4'), heldOn('XQ4-B')] }));

const twice = await Promise.all([1, 2].map(() => w.post('/api/console/submissions/revise', { id: hopped, codes: ['XQ4', 'XQ4-B'] }, admin).then(r => r.json())));
await Promise.all(waits.splice(0));
check('a code added gets its amount, and the same change sent twice moves the score once',
  hopTotal() === 180 && heldOn('XQ4') === 1 && heldOn('XQ4-B') === 2 && fromCredits() === 180 &&
  twice.filter(r => r.ok && !r.unchanged).length === 1 && twice.every(r => r.ok || /changed since/.test(r.error)),
  JSON.stringify({ total: hopTotal(), twice }));

const reopened = await w.post('/api/console/submissions/reopen', { id: hopped }, admin);
const pendingAgain = hopRow();
const accepts = await Promise.all([1, 2].map(() => w.post('/api/console/submissions/accept', { id: hopped, codes: ['XQ4'] }, admin)));
const acceptedAgain = hopTotal();
const reopenAccepted = await w.post('/api/console/submissions/reopen', { id: hopped }, admin);
check('reopening sends a decision back to pending: accepting it then credits it once, and reopening an accepted one takes its points off',
  reopened.status === 200 && pendingAgain.status === 'pending' && pendingAgain.reason === null &&
  accepts.map(r => r.status).sort().join() === '200,409' && acceptedAgain === 140 &&
  reopenAccepted.status === 200 && hopTotal() === 40 && fromCredits() === 40 && hopRow().status === 'pending' && hopRow().credit === null,
  JSON.stringify({ reopened: reopened.status, pendingAgain, accepts: accepts.map(r => r.status), acceptedAgain, now: hopTotal() }));

await w.post('/api/console/submissions/accept', { id: hopped, codes: ['XQ4'] }, admin);
const uncredited = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code, status) VALUES (?, 'XQ4', 'accepted')").run(hop).lastInsertRowid);
const recorded = await (await w.form('/api/console/points/add', { team_id: String(hop), quest: 'XQ4', codes: ['XQ4-B'] }, admin)).json();
const refused = [
  ['revise', hopped, checker], ['reopen', hopped, checker],
  ['revise', uncredited, admin], ['reopen', uncredited, admin],
  ['reopen', recorded.id, admin]
];
const refusedStatus = [];
for (const [action, id, who] of refused) refusedStatus.push((await w.post('/api/console/submissions/' + action, { id, codes: ['XQ4'] }, who)).status);
const noCredit = await (await w.post('/api/console/submissions/revise', { id: uncredited }, admin)).json();
const recordedChanged = await (await w.post('/api/console/submissions/revise', { id: recorded.id, codes: ['XQ4-B'], amount: 2 }, admin)).json();
await Promise.all(waits.splice(0));
check('an account outside the quest, a submission accepted before its credit was kept and an organiser’s entry are refused what they cannot have, and an organiser’s entry can still be changed',
  JSON.stringify(refusedStatus) === '[403,403,409,409,409]' && /Scores/.test(noCredit.error) &&
  hopRow().status === 'accepted' && recordedChanged.ok && hopTotal() === 220 && fromCredits() === 220,
  JSON.stringify({ refusedStatus, noCredit, recordedChanged, total: hopTotal() }));

// ---------------- each code its own count ----------------
// one of the quest's code and three of its bonus, a part mark refused on
// the per-unit bonus, and the desk's form the same
const twoCounts = Number(raw.prepare("INSERT INTO teams (name) VALUES ('Two Counts')").run().lastInsertRowid);
const heldBy = c => (raw.prepare('SELECT amount FROM held WHERE team_id = ? AND quest_code = ?').get(twoCounts, c) || { amount: 0 }).amount;
const countedSub = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'XQ4')").run(twoCounts).lastInsertRowid);
const countRefusals = [
  (await w.post('/api/console/submissions/accept', { id: countedSub, codes: ['XQ4'], counts: { 'XQ4-B': 2 } }, admin)).status,
  (await w.post('/api/console/submissions/accept', { id: countedSub, codes: ['XQ4', 'XQ4-B'], counts: { 'XQ4-B': 0 } }, admin)).status
];
const countedAccept = await (await w.post('/api/console/submissions/accept',
  { id: countedSub, codes: ['XQ4', 'XQ4-B'], amount: 1, counts: { XQ4: 1, 'XQ4-B': 3 } }, admin)).json();
const countedHeld = [heldBy('XQ4'), heldBy('XQ4-B')];
const countedCredit = raw.prepare('SELECT credit FROM submissions WHERE id = ?').get(countedSub).credit;
const overCount = (await w.post('/api/console/submissions/revise',
  { id: countedSub, codes: ['XQ4', 'XQ4-B'], amount: 1, counts: { 'XQ4-B': 3 }, awarded: { 'XQ4-B': 121 } }, admin)).status;
const twiceJudged = (await w.post('/api/console/submissions/revise',
  { id: countedSub, codes: ['XQ4', 'XQ4-B'], amount: 1, counts: { XQ4: 2, 'XQ4-B': 3 } }, admin)).status;
const partHeld = heldBy('XQ4-B');
const countedAdd = await (await w.form('/api/console/points/add',
  { team_id: String(twoCounts), quest: 'XQ4', codes: ['XQ4', 'XQ4-B'], amount: '1', counts: { 'XQ4-B': 2 } }, admin)).json();
await Promise.all(waits.splice(0));
check('a per-unit code takes its own count and no part mark, a judged one is credited once, and the desk sends counts the same way',
  JSON.stringify(countRefusals) === '[400,400]' &&
  countedAccept.ok && countedAccept.gained === 220 && countedAccept.full === 220 && countedHeld.join() === '1,3' &&
  countedCredit === JSON.stringify({ codes: ['XQ4', 'XQ4-B'], amount: 1, counts: { 'XQ4-B': 3 } }) &&
  overCount === 400 && twiceJudged === 400 && partHeld === 3 &&
  countedAdd.ok && countedAdd.gained === 180 && heldBy('XQ4') === 2 && heldBy('XQ4-B') === 5,
  JSON.stringify({ countRefusals, countedAccept, countedHeld, countedCredit, overCount, twiceJudged, partHeld, countedAdd, now: [heldBy('XQ4'), heldBy('XQ4-B')] }));

// ---------------- a team's receipt ----------------
// Three accepted rows credit XQ4 for Second Look; a balance from before
// the ledger shows apart, labelled; voided lines are listed with why; an
// account outside the quest sees none of it.
credit(raw, hop, 'XQ4', 1);
const receipt = await (await w.get('/api/console/team/receipt?team_id=' + hop, admin)).json();
const hopQuest = (receipt.quests || []).find(q => q.key === 'XQ4') || {};
const narrowReceipt = await (await w.get('/api/console/team/receipt?team_id=' + hop, checker)).json();
raw.prepare("UPDATE entries SET voided_at = datetime('now'), void_reason = 'test' WHERE team_id = ? AND code = 'XQ4' AND source_kind = 'balance'").run(hop);
check('a team’s receipt lists each submission that credited a quest in order, counts them, adds up to its total, and shows what no submission gave',
  receipt.ok && receipt.total === hopTotal() + 100 && hopQuest.times === 3 &&
  JSON.stringify(hopQuest.entries.map(e => e.id)) === JSON.stringify([earlier, hopped, recorded.id]) &&
  hopQuest.entries[2].organiser === true && hopQuest.worth === hopTotal() + 100 &&
  JSON.stringify(hopQuest.other) === JSON.stringify([{ code: 'XQ4', amount: 1, worth: 100, label: 'From before the ledger' }]) &&
  hopQuest.lines.some(l => l.voided && l.voided.reason === 'Changed') &&
  narrowReceipt.ok && narrowReceipt.quests.length === 0,
  JSON.stringify({ total: receipt.total, hopQuest, narrow: narrowReceipt.quests }));

// ---------------- a team's answers, edited ----------------
const answerOf = id => JSON.parse(raw.prepare('SELECT answer FROM submissions WHERE id = ?').get(id).answer || 'null');
const listed = await (await w.get('/api/console/submissions?status=all&quest=XQ1', admin)).json();
const climbed = listed.submissions.find(s => s.id === added.id) || {};
const edited = await (await w.post('/api/console/submissions/answer', { id: added.id, answer: { kind: 'count', value: 5 } }, checker)).json();
const badAnswer = await w.post('/api/console/submissions/answer', { id: added.id, answer: { kind: 'count', value: -1 } }, admin);
const otherQuest = await w.post('/api/console/submissions/answer', { id: subS1, answer: { kind: 'text', value: 'x' } }, checker);
const deletedSub = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code, status) VALUES (?, 'XQ1', 'deleted')").run(teamB.id).lastInsertRowid);
const onDeleted = await w.post('/api/console/submissions/answer', { id: deletedSub, answer: { kind: 'count', value: 1 } }, admin);
const answerLog = raw.prepare("SELECT quest_code, actor FROM submission_log WHERE action = 'submit-answer'").all();
check('a team’s answer can be edited after it was sent, by an account that scores the quest, cleaned as a team’s is, logged with what it was, and never on a deleted one',
  (listed.questions[climbed.group_id] || []).map(q => q.kind).join() === 'count' &&
  edited.ok && answerOf(added.id).value === 5 && total(teamA.id) === before + 450 &&
  badAnswer.status === 400 && answerOf(added.id).value === 5 &&
  otherQuest.status === 403 && onDeleted.status === 409 &&
  answerLog.length === 1 && answerLog[0].quest_code === 'XQ1 4 → 5' && answerLog[0].actor === 'console:Checker',
  JSON.stringify({ questions: listed.questions, edited, bad: badAnswer.status, other: otherQuest.status, deleted: onDeleted.status, answerLog }));

// ---------------- adding files to a submission already sent ----------------
// Proof the team sent another way goes onto the submission at any status
// but deleted, by an account that scores its quest. The quest's kinds
// apply; its most does not, but no submission holds more than 20 files.
const addFiles = (w2, id, parts, token) => {
  const fd = new FormData();
  fd.append('id', String(id));
  parts.forEach(([k, v]) => { if (v instanceof File) fd.append(k, v, v.name); else fd.append(k, v); });
  return w2.front('/api/console/submissions/files', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: fd });
};
const albumsAt = () => (raw.prepare("SELECT value FROM counters WHERE name = 'albums'").get() || { value: 0 }).value;
raw.prepare('UPDATE submissions SET gallery = 1 WHERE id = ?').run(subXQ);
const albumsBefore = albumsAt();
const addedTo = await (await addFiles(w, subXQ, [['files', PNG], ['thumb0', THUMB]], checker)).json();
const withFiles = ((await (await w.get('/api/console/submissions?status=accepted', checker)).json()).submissions || []).find(s => s.id === subXQ) || {};
const listedMedia = withFiles.media || [];
check('a file added to an accepted submission is kept under a key its files list then carries, with its small copy; the list says what the quest takes, and the gallery albums move on',
  addedTo.ok && addedTo.added === 1 && listedMedia.length === 1 && bucket.has(listedMedia[0].key) && bucket.has(listedMedia[0].key + '.t') &&
  withFiles.files && withFiles.files.kinds.join() === 'photo,video' && albumsAt() === albumsBefore + 1,
  JSON.stringify({ addedTo, media: listedMedia, files: withFiles.files, albums: [albumsBefore, albumsAt()] }));

const fullSub = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code, status) VALUES (?, 'XQ1', 'rejected')").run(teamB.id).lastInsertRowid);
const heldRow = raw.prepare("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, ?, 'image/png', 20, 'held.png')");
for (let i = 0; i < 19; i++) heldRow.run(fullSub, 'sub/held' + i);
const keysBefore = bucket.size;
const rowsBefore = raw.prepare('SELECT COUNT(*) AS n FROM submission_files').get().n;
const addRefusals = [];
for (const [id, parts] of [
  [subXQ, [['files', TRACK]]],               // a GPX track on a quest that takes photos and videos
  [deletedSub, [['files', PNG]]],
  [subS1, [['files', PNG]]],                 // outside the Checker's quest
  [fullSub, [['files', PNG], ['files', PNG]]], // 19 held and two more
  [subXQ, []]
]) addRefusals.push((await addFiles(w, id, parts, checker)).status);
check('a kind the quest does not take, a deleted submission, an account outside its quest, past 20 files in all and no file at all are refused, and nothing is stored',
  JSON.stringify(addRefusals) === '[400,409,403,400,400]' && bucket.size === keysBefore &&
  raw.prepare('SELECT COUNT(*) AS n FROM submission_files').get().n === rowsBefore,
  JSON.stringify({ addRefusals, keys: [keysBefore, bucket.size] }));

// ---------------- a Discord entry taken back from Review ----------------
// /submit in Discord records an entry as discord:<username>; a reviewer
// takes it back from the Review card without the Points tab
const viaDiscord = Number(raw.prepare("INSERT INTO teams (name) VALUES ('Discord Crew')").run().lastInsertRowid);
const fromDiscord = Number(raw.prepare(
  "INSERT INTO submissions (team_id, quest_code, status, added_by, reviewed_by, credit) VALUES (?, 'XQ1', 'accepted', 'discord:sam', 'discord:sam', ?)"
).run(viaDiscord, JSON.stringify({ codes: ['XQ1'], amount: 1 })).lastInsertRowid);
credit(raw, viaDiscord, 'XQ1', 1, { kind: 'submission', id: fromDiscord, by: 'discord:sam' });
const backed = await w.post('/api/console/points/undo', { id: fromDiscord }, checker);
check('a reviewer can take back an entry Discord recorded, and the team loses exactly what it gave',
  backed.status === 200 && total(viaDiscord) === 0 &&
  raw.prepare('SELECT status FROM submissions WHERE id = ?').get(fromDiscord).status === 'deleted',
  JSON.stringify({ status: backed.status, total: total(viaDiscord) }));

// /unsubmit records an entry that took the point off again, and the code
// went with it; taking that back gives the point back, putting it back
// takes it off again, once
const xq1 = id => (raw.prepare("SELECT amount FROM held WHERE team_id = ? AND quest_code = 'XQ1'").get(id) || { amount: 0 }).amount;
credit(raw, viaDiscord, 'XQ1', 1);
const offDiscord = Number(raw.prepare(
  "INSERT INTO submissions (team_id, quest_code, status, added_by, reviewed_by, credit) VALUES (?, 'XQ1', 'accepted', 'discord:sam', 'discord:sam', ?)"
).run(viaDiscord, JSON.stringify({ codes: ['XQ1'], amount: -1 })).lastInsertRowid);
credit(raw, viaDiscord, 'XQ1', -1, { kind: 'submission', id: offDiscord, by: 'discord:sam' });
const gaveBack = await w.post('/api/console/points/undo', { id: offDiscord }, checker);
const heldAfterUndo = xq1(viaDiscord);
const putAgain = await Promise.all([
  w.post('/api/console/points/redo', { id: offDiscord }, checker),
  w.post('/api/console/points/redo', { id: offDiscord }, admin)
]);
const heldAfterRedo = xq1(viaDiscord);
const goneAfterRedo = !raw.prepare("SELECT 1 FROM held WHERE team_id = ? AND quest_code = 'XQ1'").get(viaDiscord);
const notTaken = await w.post('/api/console/points/redo', { id: offDiscord }, checker);
const firstBack = await w.post('/api/console/points/redo', { id: fromDiscord }, checker);
check('an entry that took points off can be taken back, giving them back to a code the team no longer held, and put back once',
  gaveBack.status === 200 && heldAfterUndo === 1 && putAgain.map(r => r.status).sort().join() === '200,409' &&
  heldAfterRedo === 0 && goneAfterRedo &&
  raw.prepare('SELECT status, reason FROM submissions WHERE id = ?').get(offDiscord).status === 'accepted' &&
  notTaken.status === 409 && firstBack.status === 200 && xq1(viaDiscord) === 1 && !ledgerAgrees(raw).length,
  JSON.stringify({ gaveBack: gaveBack.status, heldAfterUndo, putAgain: putAgain.map(r => r.status), heldAfterRedo, notTaken: notTaken.status, firstBack: firstBack.status, now: xq1(viaDiscord) }));

// ---------------- taking it back ----------------
const backs = await Promise.all([
  w.post('/api/console/points/undo', { id: added.id }, marshal),
  w.post('/api/console/points/undo', { id: added.id }, admin)
]);
const after = raw.prepare('SELECT status, reason FROM submissions WHERE id = ?').get(added.id);
check('taking points back takes off exactly what they gave, once, and leaves the row saying so',
  backs.map(r => r.status).sort().join() === '200,409' && total(teamA.id) === before &&
  !raw.prepare("SELECT 1 FROM held WHERE team_id = ? AND quest_code LIKE 'XQ1%'").get(teamA.id) &&
  after.status === 'deleted' && after.reason === 'Taken back',
  JSON.stringify({ statuses: backs.map(r => r.status), after }));

// ---------------- adjusting by hand ----------------
// An adjustment is an organiser's entry carrying its reason where the team
// reads it; on a quest it is part of the code, with no quest it goes on
// the hidden loose code ADJ, which an account limited to some quests
// cannot use.
const held = () => (raw.prepare("SELECT amount FROM held WHERE team_id = ? AND quest_code = 'S1'").get(teamB.id) || { amount: 0 }).amount;
const s1Points = raw.prepare("SELECT points FROM quests WHERE code = 'S1'").get().points;
const startS1 = held();
const beforeAdjust = total(teamB.id);
const adjusted = await (await w.post('/api/console/ledger/adjust', { team_id: teamB.id, code: 'S1', points: 3 * s1Points, reason: 'Three by hand' }, admin)).json();
const noQuest = await (await w.post('/api/console/ledger/adjust', { team_id: teamB.id, code: '', points: -25, reason: 'Late to the finish' }, admin)).json();
const adjRow = raw.prepare('SELECT status, added_by, reason, credit FROM submissions WHERE id = ?').get(noQuest.id);
const adjCode = raw.prepare("SELECT hidden, group_id, points, label FROM quests WHERE code = 'ADJ'").get();
const limitedNoQuest = (await w.post('/api/console/ledger/adjust', { team_id: teamB.id, code: '', points: 5, reason: 'x' }, marshal)).status;
await Promise.all(waits.splice(0));
check('an adjustment is an organiser\u2019s entry with its reason, on a quest or on ADJ with none, and an account limited to some quests cannot use ADJ',
  adjusted.ok && held() === startS1 + 3 && noQuest.ok && noQuest.code === 'ADJ' &&
  adjRow.status === 'accepted' && adjRow.added_by === 'Alex' && adjRow.reason === 'Late to the finish' &&
  adjCode.hidden === 1 && adjCode.group_id === null && adjCode.points === 1 && adjCode.label === 'Adjustment' &&
  total(teamB.id) === beforeAdjust + 3 * s1Points - 25 && limitedNoQuest === 403,
  JSON.stringify({ adjusted, noQuest, adjRow, adjCode, limitedNoQuest }));
const undoAdjust = await w.post('/api/console/points/undo', { id: noQuest.id, reason: 'Was on time' }, admin);
const adjLine = raw.prepare("SELECT void_reason FROM entries WHERE source_kind = 'submission' AND source_id = ?").get(noQuest.id);
check('an adjustment is undone like any organiser\u2019s entry, the reason given kept on its line',
  undoAdjust.status === 200 && adjLine.void_reason === 'Taken back: Was on time' && total(teamB.id) === beforeAdjust + 3 * s1Points,
  JSON.stringify(adjLine));
// put back, it reads its reason again, and its line keeps the time it
// had (here set by hand, as a Time move before the take back would have)
// and its note
raw.prepare("UPDATE entries SET at = '2026-10-20 02:00:00' WHERE source_kind = 'submission' AND source_id = ?").run(noQuest.id);
const putBack = await w.post('/api/console/points/redo', { id: noQuest.id }, admin);
const backRow = raw.prepare('SELECT status, reason FROM submissions WHERE id = ?').get(noQuest.id);
const backLine = raw.prepare("SELECT at, note FROM entries WHERE source_kind = 'submission' AND source_id = ? AND voided_at IS NULL").get(noQuest.id);
check('an adjustment put back reads its reason again, and its line keeps its time and its note',
  putBack.status === 200 && backRow.status === 'accepted' && backRow.reason === 'Late to the finish' &&
  !!backLine && backLine.at === '2026-10-20 02:00:00' && backLine.note === 'Late to the finish' &&
  total(teamB.id) === beforeAdjust + 3 * s1Points - 25,
  JSON.stringify({ status: putBack.status, backRow, backLine }));

// a balance or an award's line is undone on its own, with a reason; a
// submission's line is undone with the submission
credit(raw, teamB.id, 'S1', 1, { note: 'From before the ledger' });
const balance = raw.prepare("SELECT id FROM entries WHERE team_id = ? AND source_kind = 'balance' AND voided_at IS NULL ORDER BY id DESC").get(teamB.id).id;
const subLine = raw.prepare("SELECT id FROM entries WHERE team_id = ? AND source_kind = 'submission' AND voided_at IS NULL ORDER BY id DESC").get(teamB.id).id;
const beforeVoid = total(teamB.id);
const voidRefusals = [
  (await w.post('/api/console/ledger/void', { id: balance, reason: '' }, admin)).status,
  (await w.post('/api/console/ledger/void', { id: subLine, reason: 'x' }, admin)).status,
  (await w.post('/api/console/ledger/void', { id: balance, reason: 'x' }, checker)).status
];
const voids = await Promise.all([
  w.post('/api/console/ledger/void', { id: balance, reason: 'Counted twice' }, admin),
  w.post('/api/console/ledger/void', { id: balance, reason: 'Counted twice' }, admin)
]);
check('a balance line is undone once, with a reason, by an account that scores; a submission\u2019s line is not undone on its own',
  JSON.stringify(voidRefusals) === '[400,409,403]' && voids.map(r => r.status).sort().join() === '200,409' &&
  total(teamB.id) === beforeVoid - s1Points && !ledgerAgrees(raw).length,
  JSON.stringify({ voidRefusals, voids: voids.map(r => r.status) }));

// ---------------- a quest worth negative points ----------------
// a penalty: crediting it once takes its points off, and the team's own
// list says so, though the amount recorded is a plain 1
await w.post('/api/console/quests/add', { code: 'PEN1', points: -50 }, admin);
const beforePenalty = total(teamB.id);
await w.post('/api/console/ledger/adjust', { team_id: teamB.id, code: 'PEN1', points: -50, reason: 'Ran a red light' }, admin);
check('a quest worth negative points takes them off the team once credited',
  total(teamB.id) === beforePenalty - 50 && held() === startS1 + 3, JSON.stringify({ beforePenalty, now: total(teamB.id) }));

// ---------------- what the team sees ----------------
await w.post('/api/console/codes/generate', {}, admin);
const codes = await (await w.get('/api/console/codes', admin)).json();
const code = (codes.codes || []).find(c => c.name === teamB.name);
const teamSession = (await (await w.post('/api/submit/login', { team: teamB.name, code: code && code.code })).json()).session;
const theirs = await (await w.get('/api/submit/mine', teamSession)).json();
const kinds = {};
theirs.submissions.forEach(s => { kinds[s.id] = s.organiser; });
const recordedForThem = raw.prepare("SELECT id, credit FROM submissions WHERE team_id = ? AND added_by != ''").all(teamB.id);
const worthOf = credit => credit.codes.reduce((sum, c) => sum + raw.prepare('SELECT points FROM quests WHERE code = ?').get(c).points, 0) * credit.amount;
check('the team’s own list carries what organisers recorded for them, marked added or taken off by what it was worth, without saying which organiser',
  !!teamSession && kinds[subXQ] === '' && kinds[subS1] === '' && recordedForThem.length === 3 &&
  recordedForThem.every(r => kinds[r.id] === (worthOf(JSON.parse(r.credit)) < 0 ? 'taken' : 'added')) &&
  recordedForThem.some(r => JSON.parse(r.credit).codes[0] === 'PEN1' && kinds[r.id] === 'taken') &&
  !JSON.stringify(theirs).includes('"Alex"'),
  JSON.stringify(theirs.submissions && theirs.submissions.map(s => [s.id, s.organiser])));

// ---------------- a photo sent straight to R2 ----------------
// With the R2 token set the dashboard sends each photo to R2 first
// (src/staged.ts) and the save names it by id. The pretend R2 keeps its
// objects in this suite's bucket.
const r2 = pretendR2({ store: {
  set(key, bytes, type) { bucket.set(key, { bytes, meta: { contentType: type }, custom: {} }); },
  get(key) { const hit = bucket.get(key); return hit ? { bytes: hit.bytes, type: hit.meta.contentType } : null; },
  delete(key) { bucket.delete(key); }
} });
const direct = worker(raw, r2.env);
// what the page does: start, the one slice to its signed address, finish
async function stagePng(name, token) {
  const start = await (await direct.post('/api/console/upload/start', { purpose: 'points', name, type: 'image/png', size: PNG.size }, token)).json();
  const signed = await (await direct.get('/api/console/upload/sign?id=' + start.id + '&n=1', token)).json();
  if (signed.url) await fetch(signed.url, { method: 'PUT', body: PNG });
  await direct.post('/api/console/upload/finish', { id: start.id }, token);
  return { id: start.id, key: (raw.prepare('SELECT r2_key FROM staged_uploads WHERE id = ?').get(start.id) || {}).r2_key };
}
const summit = await stagePng('summit.png', marshal);
const viaR2 = await (await direct.form('/api/console/points/add', {
  team_id: String(teamA.id), quest: 'XQ1', amount: '1', staged: String(summit.id)
}, marshal)).json();
await Promise.all(waits.splice(0));
const stagedFiles = raw.prepare('SELECT r2_key FROM submission_files WHERE submission_id = ?').all(viaR2.id);
check('points recorded with a photo sent straight to R2 point at it where it already is, and its staged row goes',
  viaR2.ok && stagedFiles.length === 1 && stagedFiles[0].r2_key === summit.key && bucket.has(summit.key) &&
  !raw.prepare('SELECT 1 FROM staged_uploads WHERE id = ?').get(summit.id),
  JSON.stringify({ viaR2, stagedFiles }));

// a reviewer sends one the same way and adds it to a submission
const lateFile = await stagePng('late.png', checker);
const lateAdd = await (await addFiles(direct, subXQ, [['staged', String(lateFile.id)]], checker)).json();
check('an account with Review alone can send a file straight to R2 and add it to a submission, which then points at it where it already is',
  lateAdd.ok && !!lateFile.key && bucket.has(lateFile.key) &&
  !!raw.prepare('SELECT 1 FROM submission_files WHERE submission_id = ? AND r2_key = ?').get(subXQ, lateFile.key) &&
  !raw.prepare('SELECT 1 FROM staged_uploads WHERE id = ?').get(lateFile.id),
  JSON.stringify({ lateFile, lateAdd }));
r2.restore();

// ---------------- what the quest takes ----------------
// The quest's kinds and most apply to an organiser's entry as they do to
// a team's; a file is never required here.
const runGroup = Number(raw.prepare("INSERT INTO quest_groups (key, name, rules) VALUES ('XQ2', 'Coastal run', ?)")
  .run(JSON.stringify({ files: { kinds: ['gpx'], max: 1 } })).lastInsertRowid);
raw.prepare("INSERT INTO quests (code, norm, points, group_id) VALUES ('XQ2', 'XQ2', 200, ?)").run(runGroup);
const photoThere = await w.form('/api/console/points/add', { team_id: String(teamB.id), quest: 'XQ2', files: PNG }, admin);
const trackThere = await (await w.form('/api/console/points/add', { team_id: String(teamB.id), quest: 'XQ2', files: TRACK }, admin)).json();
const nothingThere = await w.form('/api/console/points/add', { team_id: String(teamB.id), quest: 'XQ2' }, admin);
await Promise.all(waits.splice(0));
const trackRow = raw.prepare('SELECT content_type FROM submission_files WHERE submission_id = ?').get(trackThere.id) || {};
check('an organiser’s entry takes what its quest takes: a photo is refused where the quest takes GPX tracks, a track is kept as one, and none at all is fine',
  photoThere.status === 400 && trackThere.ok && trackRow.content_type === 'application/gpx+xml' && nothingThere.status === 200,
  JSON.stringify({ photo: photoThere.status, track: trackThere, row: trackRow, nothing: nothingThere.status }));

// ---------------- a code gone between the read and the write ----------------
// An entry goes in only while every code it credits is on the tab, and its
// lines and files find it by its own stamp, never as the team's newest.
{
  const pts = await import(BOT + '/src/points.ts');
  const sent = await import(BOT + '/src/submit.ts');
  const env = { DB: d1Shim(raw), SUBMIT };
  const count = (sql, ...args) => raw.prepare(sql).get(...args).n;
  const lastId = raw.prepare('SELECT MAX(id) AS id FROM submissions WHERE team_id = ?').get(teamB.id).id;
  const before = [count('SELECT COUNT(*) AS n FROM submissions'), count('SELECT COUNT(*) AS n FROM submission_files WHERE submission_id = ?', lastId),
    count("SELECT COUNT(*) AS n FROM entries WHERE source_kind = 'submission' AND source_id = ?", lastId)];
  const claim = pts.recordClaim();
  const rows = await sent.storeProofFiles(env, new FormData(), [PNG], { claim }, []);
  const id = await pts.recordPoints(env.DB, { teamId: teamB.id, quest: 'XQ1', credit: { codes: ['XQ1', 'GONE1'], amount: 1 }, by: 'Alex', fileRows: rows, claim });
  const after = [count('SELECT COUNT(*) AS n FROM submissions'), count('SELECT COUNT(*) AS n FROM submission_files WHERE submission_id = ?', lastId),
    count("SELECT COUNT(*) AS n FROM entries WHERE source_kind = 'submission' AND source_id = ?", lastId)];
  check('an entry naming a code no longer on the tab records nothing, and none of its lines or files lands on the team’s last submission',
    id === 0 && JSON.stringify(after) === JSON.stringify(before), JSON.stringify({ id, before, after }));
}

// ---------------- deleting a team ----------------
const filesBefore = bucket.size;
const gone = await w.post('/api/console/teams/delete', { id: teamA.id, confirm: teamA.name }, admin);
await Promise.all(waits.splice(0));
check('deleting a team takes its submissions, their files and its code with it',
  gone.status === 200 && !raw.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamA.id) &&
  !raw.prepare('SELECT 1 FROM submissions WHERE team_id = ?').get(teamA.id) &&
  !raw.prepare('SELECT 1 FROM team_codes WHERE team_id = ?').get(teamA.id) && bucket.size < filesBefore,
  'status ' + gone.status);

// ---------------- renaming the quest ----------------
// Its submissions and scores move with the codes, and an account
// limited to it is limited to it under its new key.
const xq = raw.prepare("SELECT id FROM quest_groups WHERE key = 'XQ1'").get().id;
const renamed = await w.post('/api/console/quests/group/save', {
  id: xq, key: 'XQ9', name: 'Harbour Bridge Climb', region: '', submit_kind: 'count', prompt: 'How many climbed?',
  codes: [{ was: 'XQ1', code: 'XQ9', label: 'Climbed', points: 300 }, { was: 'XQ1-2', code: 'XQ1-2', label: 'Whole team', points: 150 }]
}, admin);
const offeredAfter = await (await w.get('/api/console/points/form', marshal)).json();
check('renaming a quest moves its submissions and scores to the new code, and an account limited to it keeps it',
  renamed.status === 200 && raw.prepare('SELECT quest_code FROM submissions WHERE id = ?').get(subXQ).quest_code === 'XQ9' &&
  !raw.prepare("SELECT 1 FROM held WHERE quest_code = 'XQ1'").get() &&
  raw.prepare("SELECT quests FROM console_users WHERE name = 'Marshal'").get().quests === 'XQ9' &&
  offeredAfter.quests.map(q => q.key).join() === 'XQ9',
  JSON.stringify({ status: renamed.status, offered: (offeredAfter.quests || []).map(q => q.key) }));
// a code with no quest round it is its own key, and the old edit renames it
// in the accounts limited to it the same way
{
  await w.post('/api/console/quests/add', { code: 'LOOSE1', points: 20 }, admin);
  await w.post('/api/console/accounts/save', { name: 'Marshal', perms: ['points'], quests: ['XQ9', 'LOOSE1'] }, admin);
  const edited = await w.post('/api/console/quests/edit', { code: 'LOOSE1', new_code: 'LOOSE2', points: 20 }, admin);
  check('renaming a code with no quest on the old edit renames it in an account limited to it',
    edited.status === 200 && raw.prepare("SELECT quests FROM console_users WHERE name = 'Marshal'").get().quests === 'XQ9,LOOSE2',
    JSON.stringify({ status: edited.status, quests: raw.prepare("SELECT quests FROM console_users WHERE name = 'Marshal'").get().quests }));
}

// ---------------- moving an entry to when it happened ----------------
// Results typed in after the fact keep the time they were typed in as
// well, the recap reads the moved one, and a team's own submission or a
// quest outside an account's list cannot be moved.
const lateTeam = Number(raw.prepare("INSERT INTO teams (name) VALUES ('Late Sheet')").run().lastInsertRowid);
const late = await (await w.form('/api/console/points/add', { team_id: String(lateTeam), quest: 'XQ9', codes: ['XQ9'], amount: '1' }, admin)).json();
const beforeMove = raw.prepare('SELECT submitted_at, reviewed_at FROM submissions WHERE id = ?').get(late.id);
const moved = await w.post('/api/console/points/time', { id: late.id, at: '2026-10-20 01:30' }, admin);
const afterMove = raw.prepare('SELECT submitted_at, reviewed_at FROM submissions WHERE id = ?').get(late.id);
const codeTime = raw.prepare("SELECT updated_at FROM held WHERE team_id = ? AND quest_code = 'XQ9'").get(lateTeam).updated_at;
const s1Entry = await (await w.form('/api/console/points/add', { team_id: String(teamB.id), quest: 'S1', amount: '1' }, admin)).json();
const teamOwn = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'XQ9')").run(teamB.id).lastInsertRowid);
const refusals = [
  (await w.post('/api/console/points/time', { id: late.id, at: '2099-01-01 09:00' }, admin)).status,
  (await w.post('/api/console/points/time', { id: teamOwn, at: '2026-10-20 01:30' }, admin)).status,
  (await w.post('/api/console/points/time', { id: s1Entry.id, at: '2026-10-20 01:30' }, marshal)).status
];
const { recapPayload } = await import(BOT + '/src/recap.ts');
const recap = await recapPayload(d1Shim(raw), { always: true });
check('an entry moves to when it happened: the recap reads the new time, the time it was typed in stays, the code moves with it, and hand entries are not counted as review waits',
  moved.status === 200 && afterMove.submitted_at === '2026-10-20 01:30:00' && afterMove.reviewed_at === beforeMove.reviewed_at &&
  codeTime === '2026-10-20 01:30:00' && recap.submissions.first_at === '2026-10-20 01:30:00' &&
  recap.review.reviewed === raw.prepare("SELECT COUNT(*) AS n FROM submissions s JOIN teams t ON t.id = s.team_id WHERE t.hidden = 0 AND s.reviewed_at IS NOT NULL AND s.reviewed_at != '' AND s.status != 'pending' AND s.added_by = ''").get().n &&
  JSON.stringify(refusals) === '[400,404,403]',
  JSON.stringify({ status: moved.status, afterMove, codeTime, first: recap.submissions.first_at, reviewed: recap.review.reviewed, refusals }));
{
  const sheet = await (await w.form('/api/console/points/add', { team_id: String(lateTeam), quest: 'XQ4', codes: ['XQ4-B'], amount: '1', note: 'Marshal sheet' }, admin)).json();
  await w.post('/api/console/points/time', { id: sheet.id, at: '2026-10-20 02:15' }, admin);
  const changed = await w.post('/api/console/submissions/revise', { id: sheet.id, codes: ['XQ4-B'], amount: 2 }, admin);
  const line = raw.prepare("SELECT at, note, units FROM entries WHERE source_kind = 'submission' AND source_id = ? AND voided_at IS NULL").get(sheet.id);
  check('a change writes the entry’s line again at the time it was moved to, with its note',
    changed.status === 200 && !!line && line.units === 2 && line.at === '2026-10-20 02:15:00' && line.note === 'Marshal sheet',
    JSON.stringify({ status: changed.status, line }));
}

// ---------------- a database behind db:migrate ----------------
const oldRaw = database(true);
const old = worker(oldRaw);
const oldAdmin = (await consoleSignIn(old.post, 'Alex', 'tab-pass')).session;
const oldTeam = oldRaw.prepare('SELECT id FROM teams LIMIT 1').get().id;
const oldSet = await old.post('/api/console/ledger/adjust', { team_id: oldTeam, code: 'XQ1', points: 300, reason: 'x' }, oldAdmin);
const oldSub = Number(oldRaw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'XQ1')").run(oldTeam).lastInsertRowid);
const oldAccept = await old.post('/api/console/submissions/accept', { id: oldSub }, oldAdmin);
const oldAdd = await old.form('/api/console/points/add', { team_id: String(oldTeam), quest: 'XQ1' }, oldAdmin);
const behindSaid = [await oldSet.json(), await oldAccept.json(), await oldAdd.json()].every(r => /db:migrate/.test(r.error || ''));
check('behind the migration nothing is scored: setting, accepting and recording all say what to run, and the tab is as it was',
  oldSet.status === 503 && oldAccept.status === 503 && oldAdd.status === 503 && behindSaid &&
  !oldRaw.prepare("SELECT 1 FROM completions WHERE team_id = ? AND quest_code = 'XQ1'").get(oldTeam) &&
  oldRaw.prepare('SELECT status FROM submissions WHERE id = ?').get(oldSub).status === 'pending',
  [oldSet.status, oldAccept.status, oldAdd.status].join(' '));

check('after everything above, the ledger and the tab agree for every team and code', !ledgerAgrees(raw).length, JSON.stringify(ledgerAgrees(raw)));

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
