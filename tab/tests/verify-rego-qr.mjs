// Run with: node tests/verify-rego-qr.mjs
// What happens when a person's check-in QR cannot be made: the shared
// not-a-UNSW-student marker that used to make it fail, the
// confirmation email that is held back rather than sent without a
// ticket, the QR-only retry, the send that mints first, the guard
// against a second email with no code, and the ticket links the
// dashboard opens.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKIN = join(BOT, '..', 'checkin');

let fail = 0;
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) fail++;
};

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);

// the real check-in worker, with its own database and a stand-in for
// the R2 bucket the QR images go into
const ciRaw = new DatabaseSync(':memory:');
ciRaw.exec(readFileSync(CHECKIN + '/schema.sql', 'utf8'));
const checkin = await import(CHECKIN + '/src/index.js');
const CI_ENV = {
  DB: d1Shim(ciRaw), REGISTRATION_KEY: 'checkin-key', SCAN_PASSWORD: 'scan-pass',
  // the put takes a moment, as a real one does, so two registrations of
  // one person at once overlap between looking them up and writing them
  QR: { async put() { await new Promise((done) => setTimeout(done, 5)); return {}; }, async get() { return null; }, async delete() {} }
};

globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };

const emails = [];
const reports = []; // what the check-in worker tells the tab
// 'live' hands the request to the real check-in worker; the other
// modes stand in for a worker that is down or refusing
let checkinMode = 'live';
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.indexOf('https://checkin.example') === 0) {
    if (checkinMode === 'down') throw new Error('connection refused');
    if (checkinMode === 'refusing') return Response.json({ error: 'no thanks' }, { status: 500 });
    return checkin.default.fetch(new Request(url, init), CI_ENV, { waitUntil() {} });
  }
  if (url.indexOf('https://tab.example/api/team-checkin') === 0) {
    reports.push(JSON.parse(init.body));
    return mod.default.fetch(new Request(url, init), ENV, ctx);
  }
  if (url.indexOf('https://api.resend.com/') === 0) {
    let body = null;
    try { body = JSON.parse(init.body); } catch (err) { /* not JSON */ }
    emails.push(body);
    return Response.json({ id: 'e' + emails.length });
  }
  return new Response('not found', { status: 404 });
};

const mod = await import(BOT + '/src/index.ts');
const ENV = {
  DB: db, CONSOLE_PASSWORD: 'tab-pass', EMAIL_API_KEY: 're_test',
  CHECKIN_API: 'https://checkin.example', CHECKIN_KEY: 'checkin-key'
};
const waits = [];
const ctx = { waitUntil(p) { waits.push(p); } };
const settle = () => Promise.all(waits.splice(0));

let ipn = 0;
const front = (path, opts) => {
  ipn += 1;
  opts = opts || {};
  opts.headers = Object.assign({ 'cf-connecting-ip': '198.51.100.' + (ipn % 250) }, opts.headers || {});
  return mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, ctx);
};
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
const session = (await consoleSignIn(jpost, 'Tab', 'tab-pass')).session;

const answer = async (r) => ({ status: r.status, data: await r.json() });
const personRow = (zid) => raw.prepare('SELECT * FROM participants WHERE zid = ? ORDER BY id DESC LIMIT 1').get(zid);
const logLines = (action) => raw.prepare('SELECT * FROM submission_log WHERE action = ?').all(action);

let teamn = 0;
let padn = 0;
// a team is three to five people on the public form, so one naming
// fewer is filled out to three with people of its own
const signUp = async (members) => {
  teamn += 1;
  const name = 'QR Team ' + teamn;
  members = members.slice();
  while (members.length < 3) {
    padn += 1;
    members.push({ name: 'Pad Person ' + padn, zid: 'z591' + String(padn).padStart(4, '0'), email: 'pad' + padn + '@example.com' });
  }
  const r = await jpost('/api/rego/create', {
    team_name: name, societies: [], questions: '', website: '', photo_permission: true,
    members: members.map((m, i) => Object.assign({ discord: 'someone' + i, arc: true, dietary: '', agreed: true }, m))
  });
  const d = await r.json();
  await settle();
  return { name, status: r.status, data: d, reg: raw.prepare('SELECT id FROM registrations WHERE team_name = ?').get(name) };
};
const addPerson = async (regId, m) => answer(await jpost('/api/console/rego/person/save',
  Object.assign({ id: 0, registration_id: regId, discord: 'added', dietary: '', arc: true }, m), session));
const sendEmailFor = (id, force) => jpost('/api/console/rego/email', force ? { id, force: true } : { id }, session);
const makeQr = (id) => jpost('/api/console/rego/person/qr', { id }, session);

// ---------------- the marker that stands for no zID at all ----------------
// z0000000 is shared: several people carry it, and each still needs a
// code of their own. A UNIQUE column made the second one impossible.
let team = await signUp([
  { name: 'Marker One', zid: 'z0000000', email: 'm1@example.com' },
  { name: 'Marker Two', zid: 'z0000000', email: 'm2@example.com' }
]);
check('two people marked as not-at-UNSW both get a code from the sign-up form',
  team.status === 200 && team.data.qrs === 3 &&
  ciRaw.prepare("SELECT COUNT(*) AS n FROM attendees WHERE zid = 'z0000000'").get().n === 2, JSON.stringify(team.data));

let out = await addPerson(team.reg.id, { name: 'Marker Three', zid: 'z0000000', email: 'm3@example.com' });
check('and so does a third added from the dashboard',
  out.status === 200 && out.data.qr === 'attached' && !out.data.qr_note, JSON.stringify(out.data));

const codes = ciRaw.prepare("SELECT token, qr_key FROM attendees WHERE zid = 'z0000000'").all();
check('each of them holds a separate code',
  codes.length === 3 && new Set(codes.map(c => c.token)).size === 3 && new Set(codes.map(c => c.qr_key)).size === 3,
  JSON.stringify(codes.map(c => c.token.slice(0, 6))));

out = await addPerson(team.reg.id, { name: 'Marker Three', zid: 'z0000000', email: 'm3@example.com' });
check('the same marked person registered again is handed the code they already have',
  out.status === 200 && out.data.qr === 'attached' && out.data.person.qr_url.indexOf(codes[2].qr_key) !== -1 &&
  ciRaw.prepare("SELECT COUNT(*) AS n FROM attendees WHERE zid = 'z0000000'").get().n === 3,
  JSON.stringify({ qr: out.data.qr, url: out.data.person.qr_url }));

// asking check-in for the same person twice hands back the same code
const before = ciRaw.prepare("SELECT token FROM attendees WHERE name = 'Marker Two'").get();
await makeQr(personRow('z0000000').id);
const after = ciRaw.prepare("SELECT COUNT(*) AS n FROM attendees WHERE zid = 'z0000000'").get();
check('a repeat registration of a marked person mints nothing new',
  after.n === 3 && !!before, JSON.stringify(after));

// two registrations of a person with no code at once (the sweep and a
// Create QR press, say) make one row at the door, not two
ciRaw.prepare("DELETE FROM attendees WHERE name = 'Marker Two'").run();
const markerTwo = raw.prepare("SELECT id FROM participants WHERE name = 'Marker Two'").get().id;
const twoQr = await Promise.all([makeQr(markerTwo), makeQr(markerTwo)]);
const urls = await Promise.all(twoQr.map(async (x) => (await x.json()).ticket_url));
check('two registrations of one person at once make one code between them',
  ciRaw.prepare("SELECT COUNT(*) AS n FROM attendees WHERE name = 'Marker Two'").get().n === 1 && !!urls[0] && urls[0] === urls[1],
  JSON.stringify(urls));

// ---------------- a real zID still gets one code and only one ----------------
team = await signUp([{ name: 'Real One', zid: 'z5900001', email: 'r1@example.com' }]);
out = await addPerson(team.reg.id, { name: 'Real One Again', zid: 'z5900001', email: 'r1b@example.com' });
check('a real zID cannot be signed up twice', out.status === 409, JSON.stringify(out.data));
check('and check-in holds exactly one row for it',
  ciRaw.prepare("SELECT COUNT(*) AS n FROM attendees WHERE zid = 'z5900001'").get().n === 1, '');

// ---------------- no code, no email ----------------
checkinMode = 'down';
emails.length = 0;
team = await signUp([{ name: 'Lead Person', zid: 'z5900010', email: 'lead@example.com' }]);
emails.length = 0;
out = await addPerson(team.reg.id, { name: 'No Code', zid: 'z5900011', email: 'nocode@example.com' });
let person = personRow('z5900011');
check('adding a person whose code cannot be made sends no email at all',
  out.status === 200 && out.data.qr === 'missing' && emails.length === 0, JSON.stringify({ qr: out.data.qr, emails: emails.length }));
check('the email is recorded as skipped, so it stays resendable',
  person.email_status === 'skipped' && person.qr_url === null, JSON.stringify(person));
check('the answer says an email is being held and why',
  out.data.email_held === true && /check-in/.test(out.data.qr_note || '') && out.data.ticket_url === '',
  JSON.stringify({ held: out.data.email_held, note: out.data.qr_note, ticket: out.data.ticket_url }));

// ---------------- the QR-only retry ----------------
out = await answer(await makeQr(person.id));
check('Create QR code on its own says it failed and why, and sends nothing',
  out.status === 200 && out.data.ok === false && out.data.qr === 'missing' &&
  /check-in/.test(out.data.error || '') && emails.length === 0, JSON.stringify(out.data));

// ---------------- Send email mints first, and asks before sending ----------------
out = await answer(await sendEmailFor(person.id));
check('Send email with no code answers needs_qr instead of sending',
  out.status === 200 && out.data.needs_qr === true && out.data.qr === 'missing' &&
  emails.length === 0 && personRow('z5900011').email_status === 'skipped', JSON.stringify(out.data));

// ---------------- sending anyway, once ----------------
out = await answer(await sendEmailFor(person.id, true));
check('saying send it anyway sends exactly one email, with no ticket link',
  out.status === 200 && out.data.ok === true && out.data.sent_without_qr === true &&
  emails.length === 1 && !/ticket/.test(emails[0].html), JSON.stringify({ sent: emails.length, ok: out.data.ok }));
check('and the row records it as sent', personRow('z5900011').email_status === 'sent', '');
check('a send with no code is written to the log',
  logLines('rego-email-no-qr').length === 1, JSON.stringify(logLines('rego-email-no-qr').map(l => l.quest_code)));

out = await answer(await sendEmailFor(person.id, true));
check('a second one is refused in words, not silently dropped',
  out.status === 409 && /already had an email without a QR code/.test(out.data.error || '') && emails.length === 1,
  JSON.stringify(out.data));

// two taps at once still only get one email through
emails.length = 0;
raw.prepare("UPDATE participants SET email_status = 'skipped' WHERE id = ?").run(person.id);
const both = await Promise.all([sendEmailFor(person.id, true), sendEmailFor(person.id, true)]);
const statuses = both.map(r => r.status).sort();
check('two taps at once send one email between them',
  emails.length === 1 && statuses.join() === '200,409', JSON.stringify({ statuses, sent: emails.length }));

// ---------------- once the code exists, everything is ordinary again ----------------
checkinMode = 'live';
emails.length = 0;
out = await answer(await makeQr(person.id));
check('Create QR code works once check-in answers again, and hands back a ticket link',
  out.status === 200 && out.data.ok === true && out.data.qr === 'attached' &&
  out.data.ticket_url.indexOf('https://scs.andyrew.space/ticket/?') === 0 && emails.length === 0,
  JSON.stringify(out.data));
check('the code is stored against the person',
  (personRow('z5900011').qr_url || '').indexOf('/qr/') !== -1, personRow('z5900011').qr_url || '');
check('making the code is written to the log', logLines('rego-qr').length >= 1, '');

out = await answer(await sendEmailFor(person.id));
check('Send email now goes through with the ticket in it',
  out.status === 200 && out.data.ok === true && out.data.qr === 'attached' &&
  emails.length === 1 && /ticket/.test(emails[0].html), JSON.stringify({ ok: out.data.ok, sent: emails.length }));
check('a person who has a code can be emailed as often as anyone likes',
  (await (await sendEmailFor(person.id)).json()).ok === true && emails.length === 2, 'sent=' + emails.length);

// ---------------- someone with no email address ----------------
out = await addPerson(team.reg.id, { name: 'No Address', zid: 'z5900012', email: '' });
check('a person with no email address is told that is what is missing',
  out.status === 200 && out.data.qr === 'missing' && /no email address on file/.test(out.data.qr_note || '') &&
  out.data.email_held === false, JSON.stringify(out.data));
out = await answer(await sendEmailFor(personRow('z5900012').id));
check('and sending to them is refused up front', out.status === 400 && /no email address/.test(out.data.error || ''), JSON.stringify(out.data));

// ---------------- ticket links on the overview ----------------
const overview = (await (await get('/api/console/rego', session)).json());
const everyone = overview.registrations.reduce((all, r) => all.concat(r.members), []);
const withCode = everyone.filter(m => m.qr_url);
const withoutCode = everyone.filter(m => !m.qr_url);
check('the overview hands the dashboard a ready-made ticket link for everyone who has a code',
  withCode.length > 0 && withCode.every(m => String(m.ticket_url).indexOf('https://scs.andyrew.space/ticket/?') === 0),
  withCode.length + ' with a code');
check('and none for anyone without one',
  withoutCode.length > 0 && withoutCode.every(m => !m.ticket_url), withoutCode.length + ' without');
check('a ticket link carries no key or password of any kind',
  withCode.every(m => m.ticket_url.indexOf('checkin-key') === -1 && m.ticket_url.indexOf('tab-pass') === -1), '');

// ---------------- the new action is behind the dashboard session ----------------
check('making a QR needs a dashboard session',
  (await jpost('/api/console/rego/person/qr', { id: person.id })).status === 401, '');
check('and a person who is not there is a plain 404',
  (await makeQr(999999)).status === 404, '');

// ---------------- a check-in worker that answers an error ----------------
// (a team of its own: the one above is full)
team = await signUp([{ name: 'Refused Lead', zid: 'z5900014', email: 'rlead@example.com' }]);
checkinMode = 'refusing';
emails.length = 0;
out = await addPerson(team.reg.id, { name: 'Refused Person', zid: 'z5900013', email: 'refused@example.com' });
check('a check-in worker that refuses reads back as the status it answered, with no email sent',
  out.status === 200 && out.data.qr === 'missing' && /answered 500/.test(out.data.qr_note || '') &&
  out.data.email_held === true && emails.length === 0, JSON.stringify(out.data));

// ---------------- the shared id, and pushing renames across ----------------
// The two databases hold their own row for the same person. They used
// to be matched on name and team alone, so a dashboard edit left the
// check-in row under the old name: the check-in mark stopped showing on
// the Rego tab, and a z0000000 person — found by name and team, because
// the marker cannot tell two people apart — was minted a second code
// the next time they were registered. participants.id is shared now,
// and a rename is pushed over.

checkinMode = 'live';
const attendeeById = (id) => ciRaw.prepare('SELECT * FROM attendees WHERE id = ?').get(id);
const attendeeNamed = (name) => ciRaw.prepare('SELECT * FROM attendees WHERE name = ? COLLATE NOCASE').get(name);
const attendeeCount = () => ciRaw.prepare('SELECT COUNT(*) AS n FROM attendees').get().n;
const editPerson = (id, fields) => jpost('/api/console/rego/person/save', Object.assign({ id: id, discord: 'edited', dietary: '', arc: true }, fields), session);
const saveTeam = (regId, teamName) => jpost('/api/console/rego/team/save',
  { id: regId, team_name: teamName, societies: [], questions: '', photo_permission: true }, session);
const seenOnRegoTab = async (name) => {
  const data = await (await get('/api/console/rego', session)).json();
  return data.registrations.reduce((all, r) => all.concat(r.members), []).find((m) => m.name === name) || {};
};

team = await signUp([{ name: 'Ida Moss', zid: 'z5900020', email: 'ida@example.com' }]);
const ida = personRow('z5900020');
let idaRow = attendeeNamed('Ida Moss');
check('a first registration carries the shared id: the participants rows are written before the codes are minted',
  !!idaRow && idaRow.participant_id === ida.id, JSON.stringify({ id: idaRow && idaRow.id, participant_id: idaRow && idaRow.participant_id }));

// a row from before the column existed looks exactly like that one
ciRaw.prepare('UPDATE attendees SET participant_id = NULL WHERE id = ?').run(idaRow.id);
let rosterWas = attendeeCount();
await makeQr(ida.id);
idaRow = attendeeById(idaRow.id);
check('registering again fills the shared id onto a row that predates the column',
  idaRow.participant_id === ida.id && attendeeCount() === rosterWas,
  JSON.stringify({ participant_id: idaRow.participant_id, expected: ida.id }));

ciRaw.prepare("UPDATE attendees SET checked_in_at = '2026-10-20 07:55:00' WHERE id = ?").run(idaRow.id);
check('the Rego tab shows their check-in before anything is renamed',
  (await seenOnRegoTab('Ida Moss')).checked_in_at === '2026-10-20 07:55:00', '');

rosterWas = attendeeCount();
out = await answer(await editPerson(ida.id, { name: 'Ida Moss-Webb', zid: 'z5900020', email: 'ida@example.com' }));
await settle();
idaRow = attendeeById(idaRow.id);
check('renaming a person on the dashboard renames their check-in row too',
  out.status === 200 && idaRow.name === 'Ida Moss-Webb' && attendeeCount() === rosterWas,
  JSON.stringify({ name: idaRow.name, rows: attendeeCount(), was: rosterWas }));
check('and their check-in mark still shows on the Rego tab afterwards',
  (await seenOnRegoTab('Ida Moss-Webb')).checked_in_at === '2026-10-20 07:55:00', '');

// with the check-in worker unreachable the two names drift apart, which
// is what the shared id is for: the mark is found by the number
checkinMode = 'down';
await editPerson(ida.id, { name: 'Ida Webb', zid: 'z5900020', email: 'ida@example.com' });
await settle();
checkinMode = 'live';
check('a rename the check-in worker missed leaves the two names apart',
  attendeeById(idaRow.id).name === 'Ida Moss-Webb' && personRow('z5900020').name === 'Ida Webb',
  JSON.stringify({ checkin: attendeeById(idaRow.id).name, tab: personRow('z5900020').name }));
check('the mark still reaches the right person, matched on the shared id rather than the name',
  (await seenOnRegoTab('Ida Webb')).checked_in_at === '2026-10-20 07:55:00', '');

// ---------------- a whole team moves ----------------
team = await signUp([
  { name: 'Jo Park', zid: 'z5900021', email: 'jo@example.com' },
  { name: 'Kit Lane', zid: 'z5900022', email: 'kit@example.com' }
]);
const crewBefore = ciRaw.prepare('SELECT id, name, team_name FROM attendees WHERE team_name = ? ORDER BY name').all(team.name);
out = await answer(await saveTeam(team.reg.id, 'Renamed Crew'));
await settle();
const crewAfter = ciRaw.prepare("SELECT name, team_name, participant_id FROM attendees WHERE team_name = 'Renamed Crew' ORDER BY name").all();
check('renaming a team moves every one of its members on the check-in roster',
  out.status === 200 && crewBefore.length === 3 && crewAfter.length === 3 &&
  crewAfter.every((p) => p.participant_id > 0), JSON.stringify(crewAfter));
check('and nobody was left behind under the old team name',
  ciRaw.prepare('SELECT COUNT(*) AS n FROM attendees WHERE team_name = ?').get(team.name).n === 0, team.name);

// ---------------- one code, through two renames ----------------
team = await signUp([{ name: 'Lee Vance', zid: 'z0000000', email: 'lee@example.com' }]);
const lee = personRow('z0000000');
const leeCode = attendeeNamed('Lee Vance');
await editPerson(lee.id, { name: 'Lee Vance-Doyle', zid: 'z0000000', email: 'lee@example.com' });
await settle();
// the second rename never reaches check-in, so its row keeps the middle
// name while the tab moves on — only the shared id joins them now
checkinMode = 'down';
await editPerson(lee.id, { name: 'Lee Doyle', zid: 'z0000000', email: 'lee@example.com' });
await settle();
checkinMode = 'live';
const rosterBefore = attendeeCount();
out = await answer(await makeQr(lee.id));
const leeNow = attendeeById(leeCode.id);
check('a renamed z0000000 person registered again is handed their original code, not a second one',
  out.status === 200 && out.data.ok === true && attendeeCount() === rosterBefore &&
  leeNow.token === leeCode.token && leeNow.qr_key === leeCode.qr_key &&
  raw.prepare('SELECT qr_url FROM participants WHERE id = ?').get(lee.id).qr_url.indexOf(leeCode.qr_key) !== -1,
  JSON.stringify({ rows: attendeeCount(), was: rosterBefore, token: leeNow.token === leeCode.token }));
check('and that registration brings their check-in row back in step with the tab',
  leeNow.name === 'Lee Doyle' && leeNow.participant_id === lee.id, JSON.stringify({ name: leeNow.name, participant_id: leeNow.participant_id }));

// two people who share a name on one team: for the shared marker, name
// and team cannot tell them apart, so the id has to
team = await signUp([
  { name: 'Sam Lee', zid: 'z0000000', email: 'sam1@example.com' },
  { name: 'Sam Lee', zid: 'z0000000', email: 'sam2@example.com' }
]);
const sams = raw.prepare('SELECT id FROM participants WHERE registration_id = ? ORDER BY position').all(team.reg.id);
await makeQr(sams[0].id);
await makeQr(sams[1].id);
const samRows = ciRaw.prepare("SELECT participant_id, token FROM attendees WHERE team_name = ? AND name = 'Sam Lee' ORDER BY id").all(team.name);
check('two people sharing a name on one team end up with a code each, claimed by the shared id',
  samRows.length === 2 && samRows[0].participant_id === sams[0].id &&
  samRows[1].participant_id === sams[1].id && samRows[0].token !== samRows[1].token,
  JSON.stringify(samRows.map((r) => r.participant_id)));

// ---------------- the rename endpoint on its own ----------------
const renameApi = (body, opts) => {
  opts = opts || {};
  const headers = { 'content-type': 'application/json' };
  if (!opts.noKey) headers.authorization = 'Bearer ' + (opts.key || 'checkin-key');
  return checkin.default.fetch(
    new Request('https://checkin.example/api/rename', { method: 'POST', headers: headers, body: JSON.stringify(body) }),
    opts.env || CI_ENV, { waitUntil() {} });
};

out = await answer(await renameApi({ people: [
  { participant_id: 999999, name: 'Nobody Here', team_name: 'Nowhere', was_name: 'Nobody Here', was_team: 'Nowhere' }
] }));
check('a rename that matches nobody is an ordinary answer with the entry listed, not an error',
  out.status === 200 && out.data.ok === true && out.data.updated === 0 &&
  out.data.missed.length === 1 && out.data.missed[0].participant_id === 999999, JSON.stringify(out.data));

out = await answer(await renameApi({ participant_id: lee.id, name: 'Lee Doyle-Vance', team_name: leeNow.team_name }));
check('one person sent bare, without the people list, is renamed too',
  out.status === 200 && out.data.updated === 1 && attendeeById(leeCode.id).name === 'Lee Doyle-Vance', JSON.stringify(out.data));

const tooMany = [];
for (let i = 0; i < 201; i++) tooMany.push({ participant_id: i + 1, name: 'Person ' + i, team_name: 'Crowd' });
check('more people than one save could hold is refused',
  (await renameApi({ people: tooMany })).status === 400, '');

check('a rename with no key at all is refused',
  (await renameApi({ people: [] }, { noKey: true })).status === 401, '');
check('and so is one with the wrong key',
  (await renameApi({ people: [] }, { key: 'not-the-key' })).status === 401, '');
check('with no key set on the worker the endpoint is closed, not open',
  (await renameApi({ people: [] }, { env: Object.assign({}, CI_ENV, { REGISTRATION_KEY: 'PASTE-A-LONG-RANDOM-KEY' }) })).status === 403, '');

// ---------------- test teams stay off the door ----------------
// Hiding a team on the tab makes its people test people at the door
// too: off the board, out of the scanner's list and its counts, and
// their codes check nobody in. The tab sets the check-in worker's flag
// on a hide, and puts any flag right whenever it reads the roster.
team = await signUp([{ name: 'Tess Hart', zid: 'z5900040', email: 'tess@example.com' }]);
const tess = personRow('z5900040');
const tessRow = () => ciRaw.prepare('SELECT * FROM attendees WHERE participant_id = ?').get(tess.id);
const tabTeam = raw.prepare('SELECT id FROM teams WHERE name = ?').get(team.name);
const ciFront = (path, opts) => checkin.default.fetch(new Request('https://checkin.example' + path, opts), CI_ENV, { waitUntil() {} });
const scanSession = (await (await ciFront('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ role: 'scan', password: 'scan-pass' }) })).json()).session;
const scanGet = async (path) => (await ciFront(path, { headers: { authorization: 'Bearer ' + scanSession } })).json();
const scanCode = (token) => ciFront('/api/checkin', { method: 'POST',
  headers: { authorization: 'Bearer ' + scanSession, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'scs2:' + token }) });
const peopleBefore = (await scanGet('/api/status')).people;

await jpost('/api/console/teams/hide', { id: tabTeam.id, hidden: true }, session);
await settle();
const hiddenStatus = await scanGet('/api/status');
const listed = await scanGet('/api/attendees?q=Tess');
const scanned = await answer(await scanCode(tessRow().token));
check('hiding a team keeps its people off the board, the scanner\'s list and the counts, and their code checks nobody in',
  tessRow().hidden === 1 && hiddenStatus.people === peopleBefore - 3 &&
  !hiddenStatus.people_list.some((p) => p.name === 'Tess Hart') && listed.attendees.length === 0 &&
  scanned.status === 409 && scanned.data.hidden === true && !tessRow().checked_in_at,
  JSON.stringify({ hidden: tessRow().hidden, people: hiddenStatus.people, was: peopleBefore, listed: listed.attendees.length, scanned }));

await jpost('/api/console/teams/hide', { id: tabTeam.id, hidden: false }, session);
await settle();
ciRaw.prepare('UPDATE attendees SET hidden = 1 WHERE participant_id = ?').run(tess.id);
await get('/api/console/rego', session);
await settle();
check('showing it again puts them back, and a flag the check-in worker got wrong is put right when the roster is read',
  tessRow().hidden === 0 && (await scanGet('/api/status')).people === peopleBefore, String(tessRow().hidden));

// A team renamed before renames were sent across: check-in still has the
// old names and no shared id, so neither the id nor the name finds them.
// The zID does, and for the shared z0000000 the email.
const stale = await signUp([
  { name: 'Remy Vale', zid: 'z5900050', email: 'remy@example.com' },
  { name: 'Nova Quill', zid: 'z0000000', email: 'nova@example.com' }
]);
const staleTeam = raw.prepare('SELECT id FROM teams WHERE name = ?').get(stale.name);
const staleIds = raw.prepare('SELECT id FROM participants WHERE registration_id = ? ORDER BY id').all(stale.reg.id).map((p) => p.id);
ciRaw.prepare("UPDATE attendees SET team_name = 'Crew Before', participant_id = NULL WHERE team_name = ?").run(stale.name);
ciRaw.prepare("UPDATE attendees SET name = 'Remy V' WHERE name = 'Remy Vale'").run();
ciRaw.prepare("UPDATE attendees SET name = 'Nova Q' WHERE name = 'Nova Quill'").run();
await jpost('/api/console/teams/hide', { id: staleTeam.id, hidden: true }, session);
await settle();
const staleRows = ciRaw.prepare('SELECT name, team_name, participant_id, hidden FROM attendees WHERE participant_id IN (' +
  staleIds.join(',') + ') ORDER BY participant_id').all();
const staleBoard = await scanGet('/api/status');
check('a team renamed before renames reached check-in is still hidden there, and its rows take the tab\'s names and ids',
  staleRows.length === 3 && staleRows.every((r) => r.hidden === 1 && r.team_name === stale.name) &&
  staleRows.some((r) => r.name === 'Remy Vale') && staleRows.some((r) => r.name === 'Nova Quill') &&
  ciRaw.prepare("SELECT COUNT(*) AS n FROM attendees WHERE team_name = 'Crew Before'").get().n === 0 &&
  !staleBoard.people_list.some((p) => p.team_name === stale.name || p.team_name === 'Crew Before'),
  JSON.stringify(staleRows));

// check-in stores a name without <>&"'` — a read that compared the tab's
// own spelling would rename that team again every time it looked
await jpost('/api/console/teams/hide', { id: staleTeam.id, hidden: false }, session);
await jpost('/api/console/teams/rename', { id: staleTeam.id, name: "Remy's Crew" }, session);
await settle();
const { syncCheckinHidden } = await import(BOT + '/src/rego.ts');
const again = await syncCheckinHidden(ENV);
check('a roster already in step is left alone, a name check-in spells differently included',
  again.renamed === 0 && again.sent === 0 &&
  ciRaw.prepare("SELECT COUNT(*) AS n FROM attendees WHERE team_name = 'Remys Crew' AND hidden = 0").get().n === 3,
  JSON.stringify(again));

// ---------------- the tab hears about each person ----------------
// Every check-in and every undo is reported with who it was and where
// the team stands, which is what the tab posts in the team's channel.
CI_ENV.TAB_API = 'https://tab.example';
CI_ENV.TAB_SYNC_KEY = ENV.TAB_SYNC_KEY = 'sync-key';
// two scanners on the same code at once, and an undo tapped twice
const tessToken = tessRow().token;
const scans = await Promise.all([scanCode(tessToken), scanCode(tessToken)]);
const tessIn = await answer(scans[0]);
const tessAgain = await answer(scans[1]);
const undo = () => ciFront('/api/uncheckin', { method: 'POST',
  headers: { authorization: 'Bearer ' + scanSession, 'content-type': 'application/json' }, body: JSON.stringify({ id: tessRow().id }) });
const undos = await Promise.all([undo(), undo()]);
const tessOut = await answer(undos[0]);
await answer(undos[1]);
await settle();
check('each check-in and each undo is reported to the tab once, with the person, the event, when and the team\'s count',
  tessIn.status === 200 && tessAgain.status === 200 && [tessIn, tessAgain].filter((a) => a.data.already).length === 1 &&
  tessOut.status === 200 && reports.length === 2 && !!reports[0].at && !!reports[1].at &&
  reports[0].person === 'Tess Hart' && reports[0].event === 'in' && reports[0].checked_in === 1 && reports[0].people === 3 &&
  reports[0].team_name === team.name && reports[0].completed_at === null &&
  reports[1].person === 'Tess Hart' && reports[1].event === 'out' && reports[1].checked_in === 0,
  JSON.stringify(reports));

// check-in's own reports, waited for: the tab's answer to each is part of
// what is checked
const ciScan = (token) => checkin.default.fetch(new Request('https://checkin.example/api/checkin', { method: 'POST',
  headers: { authorization: 'Bearer ' + scanSession, 'content-type': 'application/json' }, body: JSON.stringify({ token: 'scs2:' + token }) }), CI_ENV, ctx);

// ---------------- a name check-in stores differently ----------------
// Check-in drops <>&"'` from names, so a report is matched to the tab's
// team by the name as check-in stores it, and kept under the tab's own
// spelling, which is what the team page and the recap read.
{
  const odd = 'Salt & Pepper\'s "Crew"';
  await jpost('/api/console/rego/team/create', { team_name: odd, members: [
    { name: 'Sal One', zid: 'z5900101', email: 'sal1@example.com' }, { name: 'Sal Two', zid: 'z5900102', email: 'sal2@example.com' }] }, session);
  await settle();
  const sal = ciRaw.prepare("SELECT token, team_name FROM attendees WHERE name LIKE 'Sal %' ORDER BY name").all();
  reports.length = 0;
  for (const row of sal) { await ciScan(row.token); await settle(); }
  const kept = raw.prepare('SELECT team_name, people FROM team_checkins WHERE team_name = ?').get(odd);
  const arrived = raw.prepare('SELECT team_name FROM team_arrivals WHERE team_name = ?').get(odd);
  check('a team whose name check-in stores without & \' and " has its check-ins kept under the tab\'s own name',
    sal.length === 2 && sal[0].team_name === 'Salt Peppers Crew' && reports.length === 2 && !!reports[1].completed_at &&
    !!kept && kept.people === 2 && !!arrived &&
    !raw.prepare("SELECT 1 FROM team_checkins WHERE team_name = 'Salt Peppers Crew' UNION SELECT 1 FROM team_arrivals WHERE team_name = 'Salt Peppers Crew'").get(),
    JSON.stringify({ sal, kept, reports: reports.map(x => [x.team_name, x.checked_in]) }));
}

// ---------------- a report the tab never got ----------------
// Check-in sends each report once. One the tab refuses (a key that does
// not match) is logged there, and the completion is recorded by the
// tab's next read of the roster.
{
  const lost = await signUp([{ name: 'Lou One', zid: 'z5900111', email: 'lou1@example.com' }]);
  const lostTokens = ciRaw.prepare('SELECT token FROM attendees WHERE team_name = ?').all(lost.name).map(x => x.token);
  const logged = [];
  const realError = console.error;
  console.error = (...args) => { logged.push(args.join(' ')); };
  CI_ENV.TAB_SYNC_KEY = 'not-the-key';
  for (const t of lostTokens) { await ciScan(t); await settle(); }
  CI_ENV.TAB_SYNC_KEY = 'sync-key';
  console.error = realError;
  const missing = !raw.prepare('SELECT 1 FROM team_checkins WHERE team_name = ?').get(lost.name);
  await get('/api/console/rego', session);
  await settle();
  await get('/api/console/rego', session);
  await settle();
  const caught = raw.prepare('SELECT completed_at, people FROM team_checkins WHERE team_name = ?').all(lost.name);
  const doorTime = ciRaw.prepare('SELECT MAX(checked_in_at) AS at FROM attendees WHERE team_name = ?').get(lost.name).at;
  check('a refused report is logged by check-in, and the tab records the completion from its next roster read, once',
    lostTokens.length === 3 && missing && logged.length === 3 && logged.every(l => /HTTP 401/.test(l) && l.includes(lost.name)) &&
    caught.length === 1 && caught[0].people === 3 && caught[0].completed_at === doorTime,
    JSON.stringify({ missing, logged, caught, doorTime }));
}

// ---------------- a zID corrected on the tab ----------------
// The tab does not send a zID change to check-in, so a person whose zID
// was wrong still holds it there. Its real owner signing up must not
// take over that person's code.
{
  const wrong = await signUp([{ name: 'Zed Wrong', zid: 'z5900201', email: 'zed@example.com' }]);
  const zed = personRow('z5900201');
  const zedRow = () => ciRaw.prepare('SELECT * FROM attendees WHERE participant_id = ?').get(zed.id);
  const zedToken = zedRow().token;
  await jpost('/api/console/rego/person/save', { id: zed.id, name: 'Zed Wrong', zid: 'z5900202', email: 'zed@example.com',
    discord: 'zed', dietary: '', arc: true }, session);
  const owner = await signUp([{ name: 'Zoe Real', zid: 'z5900201', email: 'zoe@example.com' }]);
  const zoe = personRow('z5900201');
  const zedKept = zedRow();
  const refusedQr = zoe.qr_url;
  // Create QR code for the corrected person carries their zID across,
  // which frees the old one for its owner
  await makeQr(zed.id);
  const zoeQr = await answer(await makeQr(zoe.id));
  const zoeRow = ciRaw.prepare('SELECT * FROM attendees WHERE participant_id = ?').get(zoe.id);
  check('the real owner of a corrected zID never gets the corrected person\'s code, and gets their own once the correction is carried across',
    wrong.status === 200 && owner.status === 200 && zed.id !== zoe.id &&
    zedKept.name === 'Zed Wrong' && zedKept.team_name === wrong.name && zedKept.token === zedToken && !refusedQr &&
    zedRow().zid === 'z5900202' && zoeQr.data.qr === 'attached' && !!zoeRow && zoeRow.zid === 'z5900201' && zoeRow.token !== zedToken,
    JSON.stringify({ zedKept: zedKept && [zedKept.name, zedKept.zid], refusedQr, zedNow: zedRow().zid, zoeQr: zoeQr.data, zoeRow: zoeRow && zoeRow.zid }));
}

console.log(fail ? '\nFAILURES: ' + fail : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
