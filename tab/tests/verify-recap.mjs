// Run with: node tests/verify-recap.mjs
// After the event: the two dashboard switches, the team page behind
// one and the recap behind the other. Off, both reads are 404 and the
// pulse says so; on, a team's quests and the day's numbers come back.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
import { credit } from './ledger-fixture.mjs';
import { cameraJpeg } from './exif-sample.mjs';
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
// a bucket holding one photo: put, ranged get, delete
const bucket = new Map();
const SUBMIT = {
  async put(key, value, opts) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value instanceof ArrayBuffer ? value : await new Response(value).arrayBuffer());
    bucket.set(key, { bytes, meta: (opts && opts.httpMetadata) || {}, custom: (opts && opts.customMetadata) || {} });
  },
  async get(key, opts) {
    const hit = bucket.get(key);
    if (!hit) return null;
    let bytes = hit.bytes;
    if (opts && opts.range) bytes = bytes.slice(opts.range.offset || 0, opts.range.length != null ? (opts.range.offset || 0) + opts.range.length : undefined);
    return { body: new Response(bytes).body, size: hit.bytes.length, etag: 'e' + hit.bytes.length, httpEtag: '"e' + hit.bytes.length + '"',
      httpMetadata: hit.meta, customMetadata: hit.custom,
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
  },
  async head(key) { const hit = bucket.get(key); return hit ? { size: hit.bytes.length, etag: 'e' + hit.bytes.length, customMetadata: hit.custom } : null; },
  async delete(key) { bucket.delete(key); }
};
const ENV = { DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass', TAB_SYNC_KEY: 'sync-key' };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
const session = (await consoleSignIn(jpost, 'Tab', 'tab-pass')).session;

// the real quest list, so quests have groups and regions
await jpost('/api/console/quests/import-scs2', {}, session);

// ---------------- everything starts off ----------------
let r = await get('/api/pulse');
let d = await r.json();
check('the pulse carries both switches, off', d.team_pages === false && d.recap === false, JSON.stringify(d));

const board = await mod.apiResponse('/api/leaderboard', db);
const leader = board.teams[0].name;
r = await get('/api/team?name=' + encodeURIComponent(leader));
check('a team page is 404 while the switch is off', r.status === 404, 'status=' + r.status);
r = await get('/api/recap');
check('the recap is 404 while its switch is off', r.status === 404, 'status=' + r.status);

r = await get('/api/console/flags', session);
d = await r.json();
check('the dashboard reads both switches', d.ok && d.flags.team_pages === false && d.flags.recap === false, JSON.stringify(d));
r = await jpost('/api/console/flags/set', { name: 'team_pages', value: true });
check('flipping one needs a dashboard session', r.status === 401, 'status=' + r.status);
r = await jpost('/api/console/flags/set', { name: 'nope', value: true }, session);
check('and a known switch', r.status === 400, 'status=' + r.status);

// ---------------- some day-of history to summarise ----------------
const teamRow = await db.prepare('SELECT id FROM teams WHERE name = ?1').bind(leader).first();
const other = await db.prepare('SELECT id, name FROM teams WHERE hidden = 0 AND id != ?1 ORDER BY id LIMIT 1').bind(teamRow.id).first();
const q1 = await db.prepare("SELECT q.code, q.points, g.key, g.name FROM quests q JOIN quest_groups g ON g.id = q.group_id WHERE g.key = 'SQ18'").first();
// a second quest with a group: the seed already holds some codes, and
// the import skips those, so it is picked rather than named
const grouped = (await db.prepare("SELECT q.code, q.points, g.key, g.name FROM quests q JOIN quest_groups g ON g.id = q.group_id WHERE g.key != 'SQ18' AND g.hidden = 0 ORDER BY g.id LIMIT 2").all()).results;
const q2 = grouped[0];
const q3 = grouped[1]; // scored on Discord alone: a completion, no submission
const ins = (team, code, status, at, reviewed) => db.prepare(
  'INSERT INTO submissions (team_id, quest_code, status, submitted_at, reviewed_at, reviewed_by, gallery) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)'
).bind(team, code, status, at, reviewed || null, reviewed ? 'Tab' : null).run();
await ins(teamRow.id, q1.code, 'accepted', '2026-10-20 01:10:00', '2026-10-20 01:25:00');
await ins(teamRow.id, q2.code, 'accepted', '2026-10-20 03:05:00', '2026-10-20 03:15:00');
await ins(other.id, q1.code, 'accepted', '2026-10-20 01:40:00', '2026-10-20 02:00:00');
await ins(other.id, q1.code, 'rejected', '2026-10-20 00:30:00', '2026-10-20 00:50:00');
await ins(other.id, q2.code, 'pending', '2026-10-20 03:20:00');
const subIds = (await db.prepare('SELECT id FROM submissions ORDER BY id').all()).results.map(x => x.id);
await db.prepare("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?1, 'sub/a', 'image/jpeg', 120000, 'a.jpg')").bind(subIds[0]).run();
await db.prepare("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?1, 'sub/b', 'video/mp4', 9000000, 'b.mp4')").bind(subIds[1]).run();

credit(raw, teamRow.id, q1.code, 1, { at: '2026-10-20 01:26:00' });
credit(raw, teamRow.id, q2.code, 1, { at: '2026-10-20 03:16:00' });
credit(raw, other.id, q1.code, 1, { at: '2026-10-20 02:01:00' });
credit(raw, other.id, q3.code, 1, { at: '2026-10-20 04:40:00' });
// the standings as they are now, with those lines on them
const boardNow = await mod.apiResponse('/api/leaderboard', db);
await db.prepare("INSERT INTO team_checkins (team_name, completed_at, people) VALUES (?1, '2026-10-19 23:05:00', 4)").bind(leader).run();

// ---------------- team pages on ----------------
r = await jpost('/api/console/flags/set', { name: 'team_pages', value: true }, session);
d = await r.json();
check('an organiser opens the team pages', r.status === 200 && d.ok && d.flags.team_pages === true && d.flags.recap === false, JSON.stringify(d));
const logged = await db.prepare("SELECT action, team_name FROM submission_log WHERE action = 'flag-set' ORDER BY id DESC LIMIT 1").first();
check('and the flip is logged', !!logged && logged.team_name === 'team_pages = on', JSON.stringify(logged));
d = await (await get('/api/pulse')).json();
check('the pulse says so at once', d.team_pages === true && d.recap === false, JSON.stringify(d));

r = await get('/api/team?name=' + encodeURIComponent(leader.toLowerCase()));
d = await r.json();
check('a team page answers, matched by name whatever the case, with no-store and open CORS',
  r.status === 200 && d.ok && d.team === leader && r.headers.get('cache-control') === 'no-store' &&
  r.headers.get('access-control-allow-origin') === '*', 'status=' + r.status);
check('it carries the place, the total and every quest with when it was recorded',
  d.rank === 1 && d.teams === boardNow.teams.length && d.total === boardNow.teams[0].points &&
  d.lines.length === boardNow.teams[0].quests_done &&
  d.lines.some(l => l.code === q1.code && l.name === q1.name && l.at === '2026-10-20 01:26:00' && l.region), JSON.stringify({ rank: d.rank, lines: d.lines.length, one: d.lines.find(l => l.code === q1.code) }));
check('and the team\'s own submissions, files and arrival',
  d.submissions.sent === 2 && d.submissions.accepted === 2 && d.by_hour.length === 3 && d.by_hour[0].hour === '2026-10-20 01:00' &&
  d.by_hour[0].sent === 1 && d.by_hour[1].sent === 0 && d.files.photos === 1 && d.files.videos === 1 && d.checked_in_at === '2026-10-19 23:05:00',
  JSON.stringify({ subs: d.submissions, hours: d.by_hour, files: d.files, ck: d.checked_in_at }));
{
  // the team page's step picker reads the same three finer steps the
  // recap does, each evenly spaced and adding up to the team's submissions
  const at = rows => rows.map(x => x.hour.slice(11) + '=' + x.sent).join(' ');
  const even = (rows, mins) => rows.every((x, i) => !i || Date.parse(x.hour.replace(' ', 'T') + 'Z') - Date.parse(rows[i - 1].hour.replace(' ', 'T') + 'Z') === mins * 60000);
  const sum = rows => rows.reduce((a, x) => a + x.sent, 0);
  check('and its submissions by the half hour, the quarter and the minute, from its first to its last',
    at(d.by_half) === '01:00=1 01:30=0 02:00=0 02:30=0 03:00=1' &&
    d.by_quarter.length === 9 && even(d.by_quarter, 15) && sum(d.by_quarter) === 2 &&
    d.by_minute.length === 116 && even(d.by_minute, 1) && sum(d.by_minute) === 2 && d.by_minute[0].hour === '2026-10-20 01:10',
    JSON.stringify({ half: d.by_half, quarter: d.by_quarter.length, minute: d.by_minute.length, first: d.by_minute[0] }));
}
r = await get('/api/team?name=' + encodeURIComponent('No Such Team'));
check('an unknown team is 404', r.status === 404, 'status=' + r.status);
await db.prepare('UPDATE teams SET hidden = 1 WHERE id = ?1').bind(other.id).run();
r = await get('/api/team?name=' + encodeURIComponent(other.name));
check('a hidden team is 404 too', r.status === 404, 'status=' + r.status);
r = await get('/api/team?id=' + other.id);
check('and asked by its id as well', r.status === 404, 'status=' + r.status);
await db.prepare('UPDATE teams SET hidden = 0 WHERE id = ?1').bind(other.id).run();
{
  // the leaderboard carries each team's id, which is what the live tab
  // links with, and a team renamed since a copy was frozen still answers to it
  const row = (await mod.apiResponse('/api/leaderboard', db)).teams.find(t => t.name === leader);
  await jpost('/api/console/teams/rename', { id: teamRow.id, name: leader + ' Again' }, session);
  const byId = await get('/api/team?id=' + row.id + '&name=' + encodeURIComponent(leader));
  const byIdBody = await byId.json();
  const byOldName = (await get('/api/team?name=' + encodeURIComponent(leader))).status;
  await jpost('/api/console/teams/rename', { id: teamRow.id, name: leader }, session);
  check('a team page answers to the id on the leaderboard after a rename, and an old name alone does not',
    row.id === teamRow.id && byId.status === 200 && byIdBody.team === leader + ' Again' && byOldName === 404,
    JSON.stringify({ id: row.id, status: byId.status, team: byIdBody.team, byOldName }));
}
// part-way in: the time is the last arrival's, with how many are in,
// until the team is complete
const report = body => jpost('/api/team-checkin', Object.assign({ team_name: other.name, people: 3 }, body), 'sync-key');
await report({ checked_in: 1, last_at: '2026-10-19 22:40:00', person: 'A', event: 'in' });
await report({ checked_in: 2, last_at: '2026-10-19 22:52:00', person: 'B', event: 'in' });
let part = await (await get('/api/team?name=' + encodeURIComponent(other.name))).json();
await report({ checked_in: 3, last_at: '2026-10-19 23:01:00', completed_at: '2026-10-19 23:01:00', person: 'C', event: 'in' });
const whole = await (await get('/api/team?name=' + encodeURIComponent(other.name))).json();
check('a team part-way in shows when the last of it arrived and how many, and the completion once it is whole',
  part.checked_in_at === '2026-10-19 22:52:00' && part.checked_in && part.checked_in.n === 2 && part.checked_in.of === 3 &&
  whole.checked_in_at === '2026-10-19 23:01:00' && whole.checked_in === null,
  JSON.stringify({ part: [part.checked_in_at, part.checked_in], whole: [whole.checked_in_at, whole.checked_in] }));
// B's report arriving after C's, as separate requests can
await report({ checked_in: 2, last_at: '2026-10-19 22:52:00', person: 'B', event: 'in' });
const late = await (await get('/api/team?name=' + encodeURIComponent(other.name))).json();
check('a report older than the one the tab has changes nothing: the team stays complete',
  late.checked_in_at === '2026-10-19 23:01:00' && late.checked_in === null, JSON.stringify([late.checked_in_at, late.checked_in]));
// a "2 of 3" made in the same second as the "3 of 3" and landing after
// it: the stamps are whole seconds, and the one with fewer in is older
await report({ checked_in: 2, last_at: '2026-10-19 22:52:00', at: '2026-10-19 23:01:00', completed_at: null, person: 'B', event: 'in' });
const tie = await (await get('/api/team?name=' + encodeURIComponent(other.name))).json();
check('a report from the same second with fewer people in changes nothing either',
  tie.checked_in_at === '2026-10-19 23:01:00' && tie.checked_in === null, JSON.stringify([tie.checked_in_at, tie.checked_in]));
await report({ checked_in: 0, completed_at: null, person: 'C', event: 'out' });
part = await (await get('/api/team?name=' + encodeURIComponent(other.name))).json();
check('and with everybody taken back off it shows nothing', part.checked_in_at === '' && part.checked_in === null,
  JSON.stringify([part.checked_in_at, part.checked_in]));
r = await get('/api/recap');
check('the recap stays 404 until its own switch', r.status === 404, 'status=' + r.status);

// ---------------- the replay ----------------
r = await get('/api/replay');
check('the replay is 404 until its own switch, team pages or not', r.status === 404, 'status=' + r.status);
await jpost('/api/console/flags/set', { name: 'replay', value: true }, session);
d = await (await get('/api/pulse')).json();
check('the pulse carries the replay switch', d.replay === true, JSON.stringify(d));
await db.prepare('UPDATE teams SET hidden = 1 WHERE id = ?1').bind(other.id).run();
r = await get('/api/replay');
d = await r.json();
{
  // a quest's time is when its proof was sent, not when the line was
  // written; the rejected and the pending ones are not on it
  const mine = d.teams && d.teams.find(t => t.name === leader);
  const sq18 = mine && mine.quests.find(q => q.key === 'SQ18');
  check('the replay answers every visible team with each quest at the time its proof was sent, and the quests\' pins',
    r.status === 200 && r.headers.get('access-control-allow-origin') === '*' && r.headers.get('cache-control') === 'no-store' &&
    !!sq18 && sq18.at === '2026-10-20 01:10:00' && sq18.name === q1.name && mine.quests.length === 2 && mine.rank === 1 &&
    Array.isArray(d.pins.SQ18) && !d.teams.some(t => t.name === other.name),
    JSON.stringify({ status: r.status, mine, pins: d.pins && d.pins.SQ18 }));
}
{
  // where a quest is put for a team with no route: the quest's one pin,
  // or the pin of the code it was sent for, or nowhere
  const g1 = raw.prepare('SELECT group_id FROM quests WHERE code = ?').get(q1.code).group_id;
  const g2 = raw.prepare('SELECT group_id FROM quests WHERE code = ?').get(q2.code).group_id;
  const kept = raw.prepare('SELECT id, coords FROM quest_groups WHERE id IN (?, ?)').all(g1, g2);
  const label2 = raw.prepare('SELECT label FROM quests WHERE code = ?').get(q2.code).label;
  raw.prepare('UPDATE quest_groups SET coords = ? WHERE id = ?').run(JSON.stringify([{ label: 'The Snout', lat: -33.81, lng: 151.21 }]), g1);
  raw.prepare('UPDATE quest_groups SET coords = ? WHERE id = ?').run(JSON.stringify([
    { label: 'Chatswood Interchange', lat: -33.79, lng: 151.18 }, { label: 'Hurstville Plaza', lat: -33.96, lng: 151.1 }]), g2);
  raw.prepare("UPDATE quests SET label = 'Hurstville' WHERE code = ?").run(q2.code);
  // a photo taken at Central (cameraJpeg's location) on the leader's q2
  const shot = cameraJpeg(64);
  await SUBMIT.put('sub/gps', shot, { httpMetadata: { contentType: 'image/jpeg' } });
  raw.prepare("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, 'sub/gps', 'image/jpeg', ?, 'gps.jpg')").run(subIds[1], shot.length);
  const spots = async () => {
    const mine = (await (await get('/api/replay')).json()).teams.find(t => t.name === leader);
    return [q1.key, q2.key].map(k => { const q = mine.quests.find(x => x.key === k); return q && q.spot ? q.spot.place : null; });
  };
  const matched = await spots();
  raw.prepare("UPDATE quests SET label = 'Nowhere' WHERE code = ?").run(q2.code);
  const unmatched = await spots();
  // the photo was taken at Central: with a place there, it picks that one,
  // and what goes out is the place, not where the photo says it was
  raw.prepare('UPDATE quest_groups SET coords = ? WHERE id = ?').run(JSON.stringify([
    { label: 'Chatswood Interchange', lat: -33.79, lng: 151.18 }, { label: 'Central Station', lat: -33.8840, lng: 151.2075 }]), g2);
  const byPhoto = await spots();
  const replayText = await (await get('/api/replay')).text();
  const fromPhoto = raw.prepare('SELECT lat, lng FROM photo_places WHERE submission_id = ?').get(subIds[1]);
  raw.prepare('UPDATE quests SET label = ? WHERE code = ?').run(label2, q2.code);
  kept.forEach(k => raw.prepare('UPDATE quest_groups SET coords = ? WHERE id = ?').run(k.coords, k.id));
  raw.prepare("DELETE FROM submission_files WHERE r2_key = 'sub/gps'").run();
  raw.prepare('DELETE FROM photo_places').run();
  check('a quest is placed at its one pin or at the pin its code names, and not at all when its pins cannot be told apart',
    matched[0] === 'The Snout' && matched[1] === 'Hurstville Plaza' && unmatched[0] === 'The Snout' && unmatched[1] === null,
    JSON.stringify({ matched, unmatched }));
  check('failing those, the place nearest where the photo was taken, if it is within a kilometre, and the photo\'s own location never goes out',
    byPhoto[1] === 'Central Station' && fromPhoto && Math.abs(fromPhoto.lat + 33.883) < 0.001 &&
    replayText.indexOf(String(fromPhoto.lat)) === -1 && replayText.indexOf('-33.884') !== -1,
    JSON.stringify({ byPhoto, fromPhoto }));
}
{
  // the leaderboard's log: every team's adds up to its total, and each
  // submission the team sent is in it at when it was sent, worth what its
  // lines are (the leader's SQ18 line is the submission's for this check)
  const line = raw.prepare("SELECT id, source_kind, source_id FROM entries WHERE team_id = ? AND code = ? AND voided_at IS NULL ORDER BY id LIMIT 1").get(teamRow.id, q1.code);
  raw.prepare("UPDATE entries SET source_kind = 'submission', source_id = ? WHERE id = ?").run(subIds[0], line.id);
  const d = await (await get('/api/replay')).json();
  const sums = d.teams.map(t => [t.name, Math.round(t.log.reduce((n, i) => n + i.points, 0) * 100) / 100, t.total]);
  const mine = d.teams.find(t => t.name === leader);
  const sent = mine.log.filter(i => i.sent).length;
  const expectSent = raw.prepare("SELECT COUNT(*) AS n FROM submissions WHERE team_id = ? AND status <> 'deleted' AND (added_by IS NULL OR added_by = '')").get(teamRow.id).n;
  // past the Quest times frame an item says which edge it is past instead
  raw.prepare("INSERT OR REPLACE INTO site_text (name, value) VALUES ('team_times', ?)").run(JSON.stringify({ from: '2026-10-20 01:30:00', to: '' }));
  const framed = (await (await get('/api/replay')).json()).teams.find(t => t.name === leader).log;
  raw.prepare("DELETE FROM site_text WHERE name = 'team_times'").run();
  raw.prepare('UPDATE entries SET source_kind = ?, source_id = ? WHERE id = ?').run(line.source_kind, line.source_id, line.id);
  check('the replay\'s points log adds up to each team\'s total, has each submission the team sent at when it was sent, and the frame\'s edge for one outside it',
    sums.every(x => x[1] === x[2]) && sent === expectSent && sent > 0 &&
    mine.log.some(i => i.at === '2026-10-20 01:10:00' && i.sent === 1 && i.accepted === 1 && i.points > 0) &&
    framed.some(i => i.edge === 'start' && i.sent === 1) && !framed.some(i => i.at && i.at < '2026-10-20 01:30:00'),
    JSON.stringify({ sums: sums.filter(x => x[1] !== x[2]), sent, expectSent, log: mine.log, framed }));
}
await db.prepare('UPDATE teams SET hidden = 0 WHERE id = ?1').bind(other.id).run();
await jpost('/api/console/freeze/close', { closed: true }, session);
r = await get('/api/replay');
await jpost('/api/console/freeze/close', { closed: false }, session);
check('a closed tab closes the replay too', r.status === 404, 'status=' + r.status);
await jpost('/api/console/flags/set', { name: 'replay', value: false }, session);

// ---------------- the recap on ----------------
await jpost('/api/console/flags/set', { name: 'recap', value: 1 }, session);
r = await get('/api/recap');
d = await r.json();
check('the recap answers once its switch is on', r.status === 200 && d.ok && r.headers.get('cache-control') === 'no-store', 'status=' + r.status);
check('headline numbers: teams, quests, completions, points',
  d.teams === boardNow.teams.length && d.quests > 50 && d.completions > 0 && d.points > 0, JSON.stringify({ teams: d.teams, quests: d.quests, completions: d.completions, points: d.points }));
check('submissions by hour run from the first to the last with no gaps, and the busiest hour is named',
  d.submissions.sent === 5 && d.submissions.accepted === 3 && d.submissions.rejected === 1 && d.submissions.pending === 1 &&
  d.submissions.by_hour.length === 4 && d.submissions.by_hour[0].hour === '2026-10-20 00:00' && d.submissions.by_hour[1].sent === 2 &&
  d.submissions.by_hour[2].sent === 0 && d.submissions.busiest_hour.hour === '2026-10-20 01:00',
  JSON.stringify(d.submissions));
{
  // the same day by the half hour, the quarter and the minute, for the
  // recap's step picker: each step its own row from the first to the last
  const subs = d.submissions;
  const at = rows => rows.map(x => x.hour.slice(11) + '=' + x.sent).join(' ');
  const apart = (rows, mins) => rows.every((x, i) => !i || Date.parse(x.hour.replace(' ', 'T') + 'Z') - Date.parse(rows[i - 1].hour.replace(' ', 'T') + 'Z') === mins * 60000);
  const total = rows => rows.reduce((a, x) => a + x.sent, 0);
  check('the half hours, quarters and minutes run from the first to the last with no gaps, each adding up to every submission, with the busiest of each named',
    at(subs.by_half) === '00:30=1 01:00=1 01:30=1 02:00=0 02:30=0 03:00=2' && subs.busiest_half.hour === '2026-10-20 03:00' && subs.busiest_half.sent === 2 &&
    subs.by_quarter.length === 12 && apart(subs.by_quarter, 15) && total(subs.by_quarter) === 5 && subs.busiest_quarter.hour === '2026-10-20 00:30' &&
    subs.by_minute.length === 171 && apart(subs.by_minute, 1) && total(subs.by_minute) === 5 && subs.busiest_minute.sent === 1,
    JSON.stringify({ half: subs.by_half, quarter: subs.by_quarter.length, minute: subs.by_minute.length }));
}
check('review times: median and mean minutes from send to verdict',
  d.review.reviewed === 4 && d.review.median_minutes === 17.5 && d.review.fastest_minutes === 10 && d.review.slowest_minutes === 20, JSON.stringify(d.review));
const sq18 = d.quests_by_time.find(q => q.key === 'SQ18');
const mq1 = d.quests_by_time.find(q => q.key === q2.key);
check('each quest done says by how many teams and the hour it was most often done',
  sq18 && sq18.done_by === 2 && sq18.peak_hour === '2026-10-20 01:00' && sq18.source === 'submissions' &&
  mq1 && mq1.done_by === 1 && mq1.peak_hour === '2026-10-20 03:00', JSON.stringify({ sq18, mq1 }));
// one quest's page, from the recap's quest table
let qp = await (await get('/api/recap/quest?key=sq18')).json();
check('a quest\'s page counts what was sent, who did it out of how many, and lists the accepted ones in order',
  qp.ok && qp.quest.key === 'SQ18' && qp.submissions.sent === 3 && qp.submissions.accepted === 2 && qp.submissions.rejected === 1 &&
  qp.submissions.teams === 2 && qp.done_by === 2 && qp.teams === boardNow.teams.length &&
  qp.accepted.map(a => a.team).join('|') === [leader, other.name].join('|') && qp.accepted.every(a => a.at),
  JSON.stringify(qp));
await jpost('/api/console/recap/times', { from: '2026-10-20 01:30', to: '' }, session);
qp = await (await get('/api/recap/quest?key=SQ18')).json();
await jpost('/api/console/recap/times', { from: '', to: '' }, session);
check('one sent outside the Quest times frame goes to the end of the list with no time',
  qp.accepted.length === 2 && qp.accepted[0].team === other.name && qp.accepted[0].at &&
  qp.accepted[1].team === leader && qp.accepted[1].at === '', JSON.stringify(qp.accepted));
check('an unknown quest is 404', (await get('/api/recap/quest?key=NOPE')).status === 404);
await jpost('/api/console/codes/generate', {}, session);
const codeRow = (await (await get('/api/console/codes', session)).json()).codes.find(c => c.name === leader);
const teamSess = (await (await jpost('/api/submit/login', { team_name: leader, code: codeRow.code })).json()).session;
const mineAll = await (await get('/api/submit/mine', teamSess)).json();
const mineOne = await (await get('/api/submit/mine?quest=sq18', teamSess)).json();
check('a signed-in team can ask for its own submissions for one quest',
  mineAll.submissions.length === 2 && mineOne.submissions.length === 1 && mineOne.submissions[0].quest_code === q1.code,
  JSON.stringify(mineOne.submissions.map(x => x.quest_code)));
const seeded = d.quests_by_time.find(q => q.key === q3.key);
check('a quest scored on Discord alone takes its hour from the completion',
  !!seeded && seeded.source === 'completions' && seeded.peak_hour === '2026-10-20 04:00' && seeded.done_by === 1, JSON.stringify(seeded));
check('most done, least done and never done are listed',
  d.most_done.length > 0 && d.most_done[0].done_by >= d.most_done[d.most_done.length - 1].done_by &&
  d.least_done.length > 0 && d.never_done.length > 0 && d.never_done[0].key, JSON.stringify({ most: d.most_done[0], never: d.never_done.length }));
const sq18Region = d.regions.find(x => x.quests.some(q => q.key === 'SQ18'));
const sq18InRegion = sq18Region && sq18Region.quests.find(q => q.key === 'SQ18');
check('regions, each with its quests and what each brought in, the top teams, the busiest senders, the biggest single score and the spread',
  d.regions.length > 0 && sq18InRegion.completions === 2 && sq18InRegion.teams === 2 && sq18InRegion.points === 2 * q1.points &&
  d.regions.every(x => x.quests.reduce((a, q) => a + q.completions, 0) <= x.completions) &&
  d.top_teams[0].name === leader && d.most_active[0].sent === 3 &&
  d.biggest_score && d.biggest_score.worth > 0 && d.points_spread.max >= d.points_spread.median,
  JSON.stringify({ regions: d.regions.length, active: d.most_active[0], biggest: d.biggest_score, spread: d.points_spread }));
check('files, gallery opt-ins and arrivals',
  d.files.photos === 1 && d.files.videos === 1 && d.files.bytes === 9120000 && d.files.gallery === 3 && d.checkins.n === 1 &&
  d.checkins.first_at === '2026-10-19 23:05:00', JSON.stringify({ files: d.files, ck: d.checkins }));

// a hidden team leaves every number
await db.prepare('UPDATE teams SET hidden = 1 WHERE id = ?1').bind(other.id).run();
d = await (await get('/api/recap')).json();
check('a hidden team is out of the recap', d.submissions.sent === 2 && d.quests_by_time.find(q => q.key === 'SQ18').done_by === 1, JSON.stringify(d.submissions));
await db.prepare('UPDATE teams SET hidden = 0 WHERE id = ?1').bind(other.id).run();

// what the tab team recorded outside the day: the hours the charts
// cover, the time frame the review times count in, and the time after
// which nothing is a team's last scored quest
{
  const hoursOf = (rows) => rows.map(h => h.hour.slice(11) + '=' + h.sent).join(' ');
  const lastBefore = (await mod.apiResponse('/api/leaderboard', db)).teams.find(t => t.name === leader).last_quest;
  await jpost('/api/console/recap/hours', { from: '2026-10-20 01:00', to: '2026-10-20 02:00', mode: 'merge' }, session);
  const merged = await (await get('/api/recap')).json();
  const teamMerged = await (await get('/api/team?name=' + encodeURIComponent(leader))).json();
  await jpost('/api/console/recap/hours', { from: '2026-10-20 01:00', to: '2026-10-20 02:00', mode: 'hide' }, session);
  const hid = await (await get('/api/recap')).json();
  await jpost('/api/console/recap/review', { from: '2026-10-20 01:00', to: '2026-10-20 02:30' }, session);
  const review = (await (await get('/api/recap')).json()).review;
  await jpost('/api/console/recap/times', { from: '2026-10-20 02:00', to: '' }, session);
  const teamTimed = await (await get('/api/team?name=' + encodeURIComponent(leader))).json();
  await jpost('/api/console/tab/last-until', { until: '2026-10-20 03:00' }, session);
  const lastNow = (await mod.apiResponse('/api/leaderboard', db)).teams.find(t => t.name === leader).last_quest;
  const read = await (await get('/api/console/recap/hours', session)).json();
  const backwards = (await jpost('/api/console/recap/hours', { from: '2026-10-20 05:00', to: '2026-10-20 01:00' }, session)).status;
  await jpost('/api/console/recap/hours', { from: '', to: '' }, session);
  await jpost('/api/console/recap/review', { from: '', to: '' }, session);
  await jpost('/api/console/recap/times', { from: '', to: '' }, session);
  const teamUntimed = await (await get('/api/team?name=' + encodeURIComponent(leader))).json();
  await jpost('/api/console/tab/last-until', { until: '' }, session);
  const cleared = await (await get('/api/recap')).json();
  const lastAgain = (await mod.apiResponse('/api/leaderboard', db)).teams.find(t => t.name === leader).last_quest;
  check('hours outside the window go to its nearest hour or off the charts, first and last sent are inside it, the review times count what was sent and decided in their time frame, a team page leaves out a quest time outside its time frame and keeps the quest, and nothing after the cutoff is a team\'s last scored; clearing puts every one back',
    hoursOf(merged.submissions.by_hour) === '01:00=3 02:00=2' && merged.submissions.busiest_hour.hour === '2026-10-20 01:00' &&
    merged.submissions.first_at === '2026-10-20 01:10:00' && merged.submissions.last_at === '2026-10-20 01:40:00' &&
    merged.quests_by_time.find(q => q.key === q2.key).peak_hour === '2026-10-20 02:00' && merged.submissions.sent === 5 &&
    hoursOf(teamMerged.by_hour) === '01:00=1 02:00=1' && teamMerged.first_at === '2026-10-20 01:10:00' &&
    hoursOf(hid.submissions.by_hour) === '01:00=2' && hid.quests_by_time.find(q => q.key === q2.key).peak_hour === '' &&
    review.reviewed === 2 && review.fastest_minutes === 15 && review.slowest_minutes === 20 &&
    lastNow.code === q1.code && read.hours.mode === 'hide' && read.review.from === '2026-10-20 01:00:00' &&
    read.last_until === '2026-10-20 03:00:00' && read.times.from === '2026-10-20 02:00:00' && backwards === 400 &&
    teamTimed.lines.length === teamUntimed.lines.length && teamTimed.lines.find(l => l.code === q1.code).at === '' &&
    teamTimed.lines.every(l => l.at === '' || l.at >= '2026-10-20 02:00:00') &&
    teamUntimed.lines.find(l => l.code === q1.code).at === '2026-10-20 01:26:00' &&
    cleared.submissions.by_hour.length === 4 && cleared.review.reviewed === 4 && JSON.stringify(lastAgain) === JSON.stringify(lastBefore),
    JSON.stringify({ merged: hoursOf(merged.submissions.by_hour), team: hoursOf(teamMerged.by_hour), hid: hoursOf(hid.submissions.by_hour), review, times: teamTimed.lines.map(l => l.at), lastNow, read, backwards, lastAgain }));
}

// boards made on the Ranks tab: kept on the worker for every organiser,
// and the ones ticked for the recap listed there, top five, by place
{
  const saved = await (await jpost('/api/console/ranks/boards', { boards: [
    { title: 'Most SQ18', quest: 'SQ18', measure: 'accepted', recap: true },
    { title: '', quest: q2.key, measure: 'points', recap: true },
    { title: 'Dashboard only', quest: 'SQ18', measure: 'accepted', recap: false },
    { title: 'Stations', quest: 'SQ18', measure: 'count', recap: true }
  ] }, session)).json();
  const kept = await (await get('/api/console/ranks/boards', session)).json();
  const notChallenge = await get('/api/console/ranks/custom?quest=SQ18&measure=count', session);
  const boards = (await (await get('/api/recap')).json()).boards;
  check('boards made on the Ranks tab are kept for every organiser, and the recap lists the ones ticked for it, named by their title or else their quest',
    saved.ok && kept.boards.length === 4 && kept.boards[2].recap === false && notChallenge.status === 400 &&
    boards.length === 3 && boards[0].title === 'Most SQ18' && boards[0].teams.length === 2 && boards[0].teams[0].place === 1 &&
    boards[1].title === q2.name && boards[1].measure === 'points' && boards[1].teams[0].value > 0 &&
    boards[2].title === 'Stations' && boards[2].teams.length === 0,
    JSON.stringify({ kept: kept.boards.length, status: notChallenge.status, boards }));

  // the Ranks tab's own two boards: Quests done, and Photo to submission
  // as the three fastest and three slowest, a team never on both
  await db.prepare("UPDATE submission_files SET taken_at = '2026-10-20 01:05:00' WHERE submission_id = ?1").bind(subIds[0]).run();
  await db.prepare("UPDATE submission_files SET taken_at = '2026-10-20 03:00:00' WHERE submission_id = ?1").bind(subIds[1]).run();
  await jpost('/api/console/ranks/boards', { boards: [] }, session);
  const builtinSaved = await (await jpost('/api/console/ranks/recap', { quests_done: true, submit_times: true }, session)).json();
  const builtinKept = (await (await get('/api/console/ranks/boards', session)).json()).builtin;
  const builtinBoards = (await (await get('/api/recap')).json()).boards;
  await jpost('/api/console/ranks/recap', { quests_done: false, submit_times: false }, session);
  const builtinOff = (await (await get('/api/recap')).json()).boards;
  await db.prepare('UPDATE submission_files SET taken_at = NULL').run();
  check('Quests done and Photo to submission go on the recap when ticked, the fastest and the slowest three apart, and come off again',
    builtinSaved.ok && builtinKept.quests_done === true && builtinKept.submit_times === true &&
    builtinBoards.map(x => x.title).join('|') === 'Top 3 Fastest Submitting Teams|Top 3 Slowest Submitting Teams|Quests Done' &&
    builtinBoards[0].teams.length === 1 && builtinBoards[0].teams[0].name === leader && builtinBoards[0].teams[0].value === 300 &&
    builtinBoards[1].teams.length === 0 &&
    builtinBoards[2].teams.length >= 5 && builtinBoards[2].teams[0].place === 1 && builtinBoards[2].teams.every((t, i) => t.place <= 5 && (!i || t.value <= builtinBoards[2].teams[i - 1].value)) &&
    builtinOff.length === 0,
    JSON.stringify({ builtinKept, builtinBoards, builtinOff }));

  // the days the site prints without their date, carried on the pulse
  const savedRules = await (await jpost('/api/console/recap/dates', { rules: [{ kind: 'on', date: '2026-10-20' }, { kind: 'from', date: 'nope' }, { kind: 'odd', date: '2026-10-21' }] }, session)).json();
  const pulseRules = (await (await get('/api/pulse')).json()).date_rules;
  await jpost('/api/console/recap/dates', { rules: [] }, session);
  const clearedRules = (await (await get('/api/pulse')).json()).date_rules;
  check('date rules are kept, a date that cannot be read is dropped, and the pulse carries them',
    savedRules.ok && JSON.stringify(pulseRules) === JSON.stringify([{ kind: 'on', date: '2026-10-20' }, { kind: 'on', date: '2026-10-21' }]) &&
    clearedRules.length === 0, JSON.stringify({ pulseRules, clearedRules }));

  // and the tab's public reads send a time on a matched day as Sydney's
  // hour and minute, with no date anywhere in the answer
  const reads = async () => ({
    team: await (await get('/api/team?name=' + encodeURIComponent(leader))).json(),
    recap: await (await get('/api/recap')).json(),
    quest: await (await get('/api/recap/quest?key=SQ18')).json(),
    board: await (await get('/api/leaderboard')).json()
  });
  await jpost('/api/console/recap/dates', { rules: [{ kind: 'on', date: '2001-01-01' }] }, session);
  const whole = await reads();
  await jpost('/api/console/recap/dates', { rules: [{ kind: 'until', date: '2099-12-31' }] }, session);
  const bare = await reads();
  await jpost('/api/console/recap/dates', { rules: [] }, session);
  const dated = /\d{4}-\d{2}-\d{2}/;
  const sydney = (stamp) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Australia/Sydney', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .format(new Date(stamp.replace(' ', 'T') + 'Z'));
  check('a time on a day the date rules match goes out of the team, recap, quest and leaderboard reads as Sydney\'s hour and minute with no date left in the answer; a rule matching another day leaves them whole',
    Object.keys(bare).every(k => !dated.test(JSON.stringify(bare[k]))) && Object.keys(whole).every(k => dated.test(JSON.stringify(whole[k]))) &&
    bare.team.first_at === sydney(whole.team.first_at) && bare.recap.checkins.first_at === sydney(whole.recap.checkins.first_at) &&
    bare.quest.accepted.length > 0 && bare.quest.accepted[0].at === sydney(whole.quest.accepted[0].at),
    JSON.stringify({ team: [whole.team.first_at, bare.team.first_at], ck: [whole.recap.checkins.first_at, bare.recap.checkins.first_at], left: Object.keys(bare).filter(k => dated.test(JSON.stringify(bare[k]))) }));

  // sections written on the dashboard, with files from the Files tab
  await db.prepare("INSERT INTO drop_files (key, name, type, bytes) VALUES ('drop/aaaa1111bbbb', 'winners.jpg', 'image/jpeg', 100), ('drop/cccc2222dddd', 'gone.jpg', 'image/jpeg', 100)").run();
  const savedSecs = await (await jpost('/api/console/recap/sections', { sections: [
    { title: 'We are so cool', text: 'Line one.\nLine two.', items: [
      { title: 'Coolest Group Photo: Galahs', text: '', media: [{ key: 'drop/aaaa1111bbbb', alt: 'Galahs on the steps' }, { key: 'drop/cccc2222dddd' }, { key: 'sub/not-a-drop' }] },
      { title: '', text: '', media: [] }
    ] },
    { title: '', text: '', items: [] }
  ] }, session)).json();
  await db.prepare("DELETE FROM drop_files WHERE key = 'drop/cccc2222dddd'").run();
  const shownSecs = (await (await get('/api/recap')).json()).sections;
  const editor = await (await get('/api/console/recap/sections', session)).json();
  check('sections written on the dashboard reach the recap with their files, keeping line breaks, and leave out empty entries, files that are not the Files tab\'s and files since deleted',
    savedSecs.ok && savedSecs.sections.length === 1 && savedSecs.sections[0].items.length === 1 &&
    savedSecs.sections[0].items[0].media.length === 2 && shownSecs.length === 1 && shownSecs[0].text === 'Line one.\nLine two.' &&
    shownSecs[0].items[0].media.length === 1 && shownSecs[0].items[0].media[0].url === '/api/drop/drop/aaaa1111bbbb/winners.jpg' &&
    shownSecs[0].items[0].media[0].alt === 'Galahs on the steps' && editor.files.length === 1,
    JSON.stringify({ savedSecs, shownSecs, files: editor.files }));
  await jpost('/api/console/ranks/boards', { boards: [] }, session);
}

// quests Most done leaves out, and the time frame the arrivals count in
{
  const before = await (await get('/api/recap')).json();
  await jpost('/api/console/recap/most-skip', { keys: ['SQ18'] }, session);
  const skipRead = await (await get('/api/console/recap/hours', session)).json();
  await jpost('/api/console/recap/arrivals', { from: '2026-10-19 23:10', to: '' }, session);
  const after = await (await get('/api/recap')).json();
  await jpost('/api/console/recap/most-skip', { keys: [] }, session);
  await jpost('/api/console/recap/arrivals', { from: '', to: '' }, session);
  const cleared = await (await get('/api/recap')).json();
  check('Most done and Rarely done leave out the quests picked; Arrivals count only check-ins in their time frame; clearing puts both back',
    before.most_done.some(q => q.key === 'SQ18') && !after.most_done.some(q => q.key === 'SQ18') &&
    before.least_done.some(q => q.key === 'SQ18') && !after.least_done.some(q => q.key === 'SQ18') && skipRead.most_skip.join() === 'SQ18' &&
    before.checkins.n === 1 && after.checkins.n === 0 && cleared.checkins.n === 1 && cleared.most_done.some(q => q.key === 'SQ18'),
    JSON.stringify({ most: after.most_done.map(q => q.key), arrivals: after.checkins, skip: skipRead.most_skip }));
}

const shownOnSite = await (await get('/api/recap')).json();

// off again
await jpost('/api/console/flags/set', { name: 'recap', value: false }, session);
await jpost('/api/console/flags/set', { name: 'team_pages', value: 0 }, session);
r = await get('/api/recap');
const r2 = await get('/api/team?name=' + encodeURIComponent(leader));
check('both close again when switched off', r.status === 404 && r2.status === 404, r.status + '/' + r2.status);

// the dashboard reads the same numbers whatever the switch says and
// while the tab is closed, and only with the Scores tab
await jpost('/api/console/freeze/close', { closed: true }, session);
const dashRecap = await (await get('/api/console/recap', session)).json();
await jpost('/api/console/freeze/close', { closed: false }, session);
await jpost('/api/console/accounts/save', { create: true, name: 'Pointer', password: 'pointer-pass-12', perms: ['points'], require_2fa: false }, session);
const pointer = (await (await jpost('/api/console/login', { name: 'Pointer', password: 'pointer-pass-12' })).json()).session;
check('the dashboard reads the recap with the site switch off and the tab closed, and only with the Scores tab',
  dashRecap.ok && dashRecap.public === false && dashRecap.submissions.sent === shownOnSite.submissions.sent &&
  dashRecap.points === shownOnSite.points && (await get('/api/console/recap', pointer)).status === 403,
  JSON.stringify({ ok: dashRecap.ok, public: dashRecap.public, sent: dashRecap.submissions && dashRecap.submissions.sent }));

// ---------------- the countdown on the home page ----------------
// A run of stops the dashboard holds. The page has its own date built
// in, so an empty list and a missing table both have to read as
// "nothing to say" rather than as an error.
{
  d = await (await get('/api/countdown')).json();
  check('with nothing saved the public read answers an empty list, not a failure',
    Array.isArray(d.stops) && d.stops.length === 0, JSON.stringify(d));

  r = await jpost('/api/console/countdown/set', { stops: [{ label: 'Starts', at: '2026-10-20 09:00' }] });
  check('saving the countdown needs a dashboard session', r.status === 401, 'status=' + r.status);

  r = await jpost('/api/console/countdown/set', { stops: [{ label: '', at: '2026-10-20 09:00' }] }, session);
  check('a stop with nothing to call it is refused', r.status === 400, 'status=' + r.status);
  r = await jpost('/api/console/countdown/set', { stops: [{ label: 'Starts', at: 'soon' }] }, session);
  check('and so is one whose time cannot be read — a mistyped deadline must not read as no deadline',
    r.status === 400, 'status=' + r.status);
  r = await jpost('/api/console/countdown/set', { stops: 'nope' }, session);
  check('the stops have to arrive as a list', r.status === 400, 'status=' + r.status);

  // saved out of order on purpose: the page counts in time order
  r = await jpost('/api/console/countdown/set', { stops: [
    { label: 'Closing ceremony', at: '2026-10-20 07:00' },
    { label: 'SCS.2 starts', at: '2026-10-19 22:00' },
    { label: 'Submissions close', at: '2026-10-20 06:00' }
  ] }, session);
  d = await r.json();
  check('a run of stops saves and comes back in time order, whatever order it went in',
    r.status === 200 && d.ok &&
    JSON.stringify(d.stops.map(s => s.label)) === '["SCS.2 starts","Submissions close","Closing ceremony"]',
    JSON.stringify(d.stops));
  check('and the times come back as stored stamps the page can read',
    d.stops[0].at === '2026-10-19 22:00:00', JSON.stringify(d.stops[0]));

  d = await (await get('/api/countdown')).json();
  check('the public read carries the same three',
    d.stops.length === 3 && d.stops[0].label === 'SCS.2 starts', JSON.stringify(d.stops.map(s => s.label)));

  d = await (await get('/api/console/countdown', session)).json();
  check('the dashboard reads them back to edit', d.ok && d.stops.length === 3, JSON.stringify(d.stops.length));

  const logged = (await (await get('/api/console/log?limit=10', session)).json()).entries
    .filter(e => e.action === 'countdown-set');
  check('the change is in the log', logged.length >= 1 && logged[0].team_name === '3 stops',
    JSON.stringify(logged[0] && logged[0].team_name));

  // the line after the last stop: saved with the stops, read by the
  // page, and blank goes back to the page's own
  r = await jpost('/api/console/countdown/set', { stops: [], over: '  That was SCS.2.  ' }, session);
  const setOver = (await r.json()).over;
  const readOver = (await (await get('/api/countdown')).json()).over;
  await jpost('/api/console/countdown/set', { stops: [] }, session);
  const keptOver = (await (await get('/api/countdown')).json()).over;
  await jpost('/api/console/countdown/set', { stops: [], over: '' }, session);
  const clearedOver = (await (await get('/api/countdown')).json()).over;
  check('the line after the last stop is saved with the stops, kept when not sent, and blank goes back to the page\'s own',
    setOver === 'That was SCS.2.' && readOver === 'That was SCS.2.' && keptOver === 'That was SCS.2.' && clearedOver === '',
    JSON.stringify({ setOver, readOver, keptOver, clearedOver }));

  // saving an empty list is how it goes back to the page's own date
  r = await jpost('/api/console/countdown/set', { stops: [] }, session);
  d = await r.json();
  check('an empty list clears it rather than failing', r.status === 200 && d.ok && d.stops.length === 0, JSON.stringify(d));
  d = await (await get('/api/countdown')).json();
  check('and the public read is empty again', d.stops.length === 0, JSON.stringify(d));
}

console.log(fail ? 'FAILURES: ' + fail : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
