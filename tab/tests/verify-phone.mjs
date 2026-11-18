// Run with: node tests/verify-phone.mjs
// The payphone quest: the phone worker reports a PIN and a caller's
// number, and the tab turns that into one capture per team and
// payphone, recorded on the quest's code through the ledger.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
import { ledgerAgrees } from './ledger-fixture.mjs';
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
const ENV = { DB: db, CONSOLE_PASSWORD: 'tab-pass', PHONE_SYNC_KEY: 'phone-key-phone-key' };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
const session = (await consoleSignIn(jpost, 'Tab', 'tab-pass')).session;
const step = (body, key) => jpost('/api/phone/step', Object.assign({ call: 'CA1' }, body), key === undefined ? ENV.PHONE_SYNC_KEY : key);
const call = (pin, from, key) => step({ node: 'capture', digits: pin, from }, key);
// what a call with a PIN came to: the result, the words and the count in them
const result = async (pin, from) => {
  const d = await (await call(pin, from)).json();
  const said = (d.actions || []).map(a => a.say || (a.gather && a.gather.say) || '').join(' ');
  const n = /That is (\d+) payphone/.exec(said);
  return { result: d.result, said, count: n ? Number(n[1]) : undefined, name: (/^(.*) captured\./.exec(said) || [])[1] };
};

raw.exec(`
  INSERT INTO teams (id, name) VALUES (1, 'Opal Tappers'), (2, 'Running Rocks');
  INSERT INTO quest_groups (id, key, name) VALUES (1, 'PHONES', 'Payphone tag');
  INSERT INTO quests (code, norm, points, group_id, scoring, most) VALUES ('PH', 'PH', 10, 1, 'unit', 2), ('FIX', 'FIX', 5, 1, '', NULL);
  INSERT INTO submit_sessions (token, team_id, expires_at) VALUES ('team-one', 1, datetime('now', '+1 hour')), ('team-two', 2, datetime('now', '+1 hour'));
  INSERT INTO site_flags (name, value) VALUES ('ledger_seeded', 1);
`);
const A = '+61293850001', B = '+61293850002', C = '+61293850003';

// ---------------- the door ----------------
let r = await call('123456', A, 'wrong-key');
check('a call’s step without the phone worker’s key is refused', r.status === 401, String(r.status));
let d = await result('123456', A);
check('nothing is taken while calls are off', d.result === 'closed', JSON.stringify(d));
r = await get('/api/phone/mine', 'team-one');
check('and a team’s read says nothing is open', r.status === 404, String(r.status));

// ---------------- settings ----------------
r = await jpost('/api/console/phone/settings', { code: 'FIX' }, session);
check('a code credited once cannot be the phone’s', r.status === 400, String(r.status));
r = await jpost('/api/console/phone/settings', { code: 'PH', number: '02 9385 0000', open: true, staff_pin: true }, session);
d = await r.json();
const staff = d.settings.staff_pin;
check('the code, the number and the switch are saved, with an organiser PIN',
  r.status === 200 && d.settings.code === 'PH' && d.settings.open === true && /^\d{6}$/.test(staff), JSON.stringify(d.settings));
const ql = await (await get('/api/questlist')).json();
check('the quest list names the phone’s quest and its number',
  ql.groups.length === 1 && ql.groups[0].phone && ql.groups[0].phone.number === '02 9385 0000', JSON.stringify(ql.groups[0] && ql.groups[0].phone));

// ---------------- a team's PIN ----------------
d = await (await get('/api/phone/mine', 'team-one')).json();
const pin1 = d.pin;
const pin2 = (await (await get('/api/phone/mine', 'team-two')).json()).pin;
check('each team is given a six-digit PIN of its own, the same one each time it asks',
  /^\d{6}$/.test(pin1) && /^\d{6}$/.test(pin2) && pin1 !== pin2 && (await (await get('/api/phone/mine', 'team-one')).json()).pin === pin1 && d.count === 0,
  pin1 + ' ' + pin2);
check('signed out, the read is refused', (await get('/api/phone/mine')).status === 401, '');

// ---------------- who may capture ----------------
const kinds = [(await result(pin1, 'anonymous')).result, (await result(pin1, '+61412345678')).result, (await result(pin1, '+14155550100')).result, (await result('000000', A)).result];
check('a withheld number, a mobile, an overseas number and a wrong PIN capture nothing',
  kinds.join() === 'private,mobile,not_payphone,bad_pin' && raw.prepare('SELECT COUNT(*) AS n FROM phone_captures').get().n === 0, kinds.join());

// ---------------- a number nobody has confirmed ----------------
d = await result(pin1, A);
check('a call from a number not yet confirmed waits, with nothing on the tab',
  d.result === 'waiting' && d.count === 1 && !raw.prepare("SELECT 1 FROM held WHERE quest_code = 'PH'").get(), JSON.stringify(d));
await result(pin2, A);
const phoneA = raw.prepare('SELECT id FROM payphones WHERE number = ?').get(A).id;
r = await jpost('/api/console/phone/payphone', { id: phoneA, name: 'Anzac Parade', state: 'ok' }, session);
d = await r.json();
const heldPH = () => raw.prepare("SELECT team_id, amount, points FROM held WHERE quest_code = 'PH' ORDER BY team_id").all();
check('confirming it records every capture that was waiting on it',
  r.status === 200 && d.recorded === 2 && JSON.stringify(heldPH()) === JSON.stringify([{ team_id: 1, amount: 1, points: 10 }, { team_id: 2, amount: 1, points: 10 }]),
  JSON.stringify({ recorded: d.recorded, held: heldPH() }));
const entry = raw.prepare("SELECT status, added_by, note FROM submissions WHERE team_id = 1").get();
check('as an organiser’s entry naming the payphone',
  entry.status === 'accepted' && entry.added_by === 'phone' && entry.note === 'Payphone: Anzac Parade', JSON.stringify(entry));

// ---------------- once a team and payphone ----------------
d = await result(pin1, A);
check('the same team at the same payphone again is told it has it', d.result === 'already' && d.count === 1 && heldPH()[0].amount === 1, JSON.stringify(d));
await jpost('/api/console/phone/payphone', { number: '02 9385 0002', name: 'High Street' }, session);
const both = await Promise.all([result(pin1, B), result(pin1, B)]);
check('two calls at the same moment make one capture',
  both.map(x => x.result).sort().join() === 'already,captured' && heldPH()[0].amount === 2 &&
  raw.prepare('SELECT COUNT(*) AS n FROM phone_captures WHERE team_id = 1').get().n === 2, JSON.stringify(both));

// ---------------- the code's most ----------------
await jpost('/api/console/phone/payphone', { number: '02 9385 0003', name: 'Library' }, session);
d = await result(pin1, C);
check('past the code’s most a capture is kept and adds no points',
  d.result === 'capped' && d.count === 3 && heldPH()[0].amount === 2 && heldPH()[0].points === 20, JSON.stringify(d));
check('and the tab still agrees with its lines', ledgerAgrees(raw), '');

// ---------------- the team's list ----------------
d = await (await get('/api/phone/mine', 'team-one')).json();
check('the team reads its payphones by name, and none of their numbers',
  d.count === 3 && d.captures.map(c => c.name).join() === 'Anzac Parade,High Street,Library' && !JSON.stringify(d).includes('9385000'),
  JSON.stringify(d));

// ---------------- an organiser at a phone ----------------
const D = '+61293850004';
await result(pin2, D);
d = await result(staff, D);
check('the organiser PIN from a new payphone registers it and records what was waiting',
  d.result === 'registered' && d.said.includes('registered') && raw.prepare('SELECT state FROM payphones WHERE number = ?').get(D).state === 'ok' && heldPH()[1].amount === 2,
  JSON.stringify(d));

// ---------------- not a payphone ----------------
const E = '+61293850005';
await result(pin2, E);
const phoneE = raw.prepare('SELECT id FROM payphones WHERE number = ?').get(E).id;
await jpost('/api/console/phone/payphone', { id: phoneE, state: 'no' }, session);
d = await (await get('/api/phone/mine', 'team-two')).json();
check('a number an organiser says is not a payphone is refused and comes off the team’s list',
  (await result(pin1, E)).result === 'not_payphone' && d.count === 2, JSON.stringify(d));

// ---------------- guessing ----------------
const F = '+61293850006';
let last = '';
for (let i = 0; i < 9; i++) last = (await result('11111' + (i % 10), F)).result;
check('a run of wrong PINs from one number locks that number, and no other',
  last === 'locked' && (await result(pin1, F)).result === 'locked' && (await result(pin1, A)).result === 'already', last);
check('no call’s number is kept in the call log',
  !raw.prepare("SELECT 1 FROM phone_calls WHERE caller LIKE '+%' OR caller LIKE '%9385%'").get(), '');

// ---------------- the phone tree ----------------
d = await (await step({ from: A })).json();
check('with no tree saved a call starts by asking for the PIN',
  d.actions[0].gather && d.actions[0].gather.digits === 6 && d.actions[0].gather.to.node === 'capture', JSON.stringify(d.actions));
const bad = [
  { start: 'menu', nodes: { menu: { kind: 'menu', say: 'Pick.', options: { 1: 'nowhere' } } } },
  { start: 'gone', nodes: { hello: { kind: 'say', say: 'Hello.' } } },
  { start: 'menu', nodes: { menu: { kind: 'menu', say: 'Pick.', options: { 12: 'menu' } } } },
  { start: 'Hello', nodes: { Hello: { kind: 'say', say: 'Hello.' } } },
  { start: 'hello', nodes: { hello: { kind: 'say', say: '' } } }
];
const refusedTrees = [];
for (const t of bad) refusedTrees.push((await jpost('/api/console/phone/tree', { tree: t }, session)).status);
check('a tree that points at a step that is not there, has a bad key or name, or says nothing is refused',
  refusedTrees.join() === '400,400,400,400,400', refusedTrees.join());
const tree = {
  start: 'menu',
  nodes: {
    menu: { kind: 'menu', say: 'Press 1 to capture this payphone. Press 2 to leave a message.', options: { 1: 'tag', 2: 'voice' } },
    tag: { kind: 'capture', say: 'Key in your PIN.', next: 'after' },
    after: { kind: 'record', say: 'Tell us where you are after the beep.', max: 20 },
    voice: { kind: 'record', say: 'Leave your message after the beep.', max: 300, pin: true, next: 'bye' },
    bye: { kind: 'say', say: 'Goodbye from SCS.' }
  }
};
r = await jpost('/api/console/phone/tree', { tree }, session);
d = await r.json();
check('a tree is saved as checked, with a message held to two minutes',
  r.status === 200 && d.tree.start === 'menu' && d.tree.nodes.voice.max === 120 && d.tree_default === false, JSON.stringify(d.tree));
d = await (await step({ from: A })).json();
check('the next call hears the new tree', d.actions[0].gather.digits === 1 && d.actions[0].gather.say.startsWith('Press 1'), JSON.stringify(d.actions));
const menuBack = d.actions[0].gather.to;
d = await (await step({ node: menuBack.node, state: menuBack.state, digits: '9', from: A })).json();
check('a key the menu does not have asks again', d.actions[0].gather && d.actions[0].gather.say.startsWith('That is not one of the choices'), JSON.stringify(d.actions));
d = await (await step({ node: 'menu', state: menuBack.state, digits: '1', from: A })).json();
check('a key goes to its step', d.actions[0].gather.to.node === 'tag' && d.actions[0].gather.say === 'Key in your PIN.', JSON.stringify(d.actions));

// ---------------- a message after a capture ----------------
const pinNow = raw.prepare('SELECT pin FROM phone_pins WHERE team_id = 1').get().pin;
const G = '+61293850007';
await jpost('/api/console/phone/payphone', { number: '02 9385 0007', name: 'The Quad' }, session);
d = await (await step({ node: 'tag', digits: pinNow, from: G })).json();
const rec = d.actions.find(a => a.record);
check('a capture goes on to its next step, which records a message for that team',
  d.result === 'capped' && d.actions[0].say.startsWith('Captured.') && d.actions[1].say === 'Tell us where you are after the beep.' &&
  !!rec && rec.record.max === 20 && rec.record.to.node === 'after' && JSON.parse(rec.record.to.state).t === 1, JSON.stringify(d.actions));
const audio = new Uint8Array(2000).fill(7);
const message = (query, body, key) => front('/api/phone/message?' + query, {
  method: 'POST', headers: { 'content-type': 'audio/mpeg', authorization: 'Bearer ' + (key === undefined ? ENV.PHONE_SYNC_KEY : key) }, body
});
const stored = new Map();
ENV.SUBMIT = {
  async put(key, bytes, opts) { stored.set(key, { bytes: new Uint8Array(bytes), type: opts && opts.httpMetadata && opts.httpMetadata.contentType }); },
  async delete(key) { stored.delete(key); },
  async get(key) {
    const f = stored.get(key);
    if (!f) return null;
    return { body: new Blob([f.bytes]).stream(), size: f.bytes.length, httpMetadata: { contentType: f.type }, httpEtag: '"x"', writeHttpMetadata() {} };
  },
  async head(key) { const f = stored.get(key); return f ? { size: f.bytes.length, httpMetadata: { contentType: f.type }, httpEtag: '"x"' } : null; }
};
const q = 'rec=RE1&call=CA1&node=after&seconds=9&state=' + encodeURIComponent(rec.record.to.state);
check('a message without the phone worker’s key is refused', (await message(q, audio, 'wrong')).status === 401 && stored.size === 0, '');
const sent = await Promise.all([message(q, audio), message(q, audio)]);
const rows = raw.prepare('SELECT * FROM phone_messages').all();
check('a message is kept once however often it is sent: its audio in the bucket, its team, payphone and length on its row',
  sent.every(x => x.status === 200) && rows.length === 1 && stored.size === 1 && rows[0].team_id === 1 && rows[0].seconds === 9 &&
  rows[0].bytes === 2000 && rows[0].node === 'after' && rows[0].r2_key.startsWith('phn/') && stored.has(rows[0].r2_key) &&
  rows[0].payphone_id === raw.prepare('SELECT id FROM payphones WHERE number = ?').get(G).id, JSON.stringify(rows));
d = await (await step({ node: 'after', state: rec.record.to.state, from: G, recorded: true })).json();
check('and the caller is thanked', d.result === 'message' && d.actions[0].say.startsWith('Thank you'), JSON.stringify(d.actions));

// ---------------- a message that asks whose it is ----------------
d = await (await step({ node: 'voice', from: '+61412345678' })).json();
const pinBack = d.actions[0].gather.to;
check('a message step that wants a team asks for the PIN first, from any phone', d.actions[0].gather.digits === 6 && !d.actions.some(a => a.record), JSON.stringify(d.actions));
d = await (await step({ node: 'voice', state: pinBack.state, digits: '000000', from: '+61412345678' })).json();
check('a wrong PIN is asked for again and nothing is recorded', d.result === 'bad_pin' && !!d.actions[0].gather && !d.actions.some(a => a.record), JSON.stringify(d.actions));
d = await (await step({ node: 'voice', state: pinBack.state, digits: pinNow, from: '+61412345678' })).json();
const rec2 = d.actions.find(a => a.record);
check('the right PIN goes on to the recording, held to the step’s length', !!rec2 && rec2.record.max === 120 && JSON.parse(rec2.record.to.state).t === 1, JSON.stringify(d.actions));
d = await (await step({ node: 'voice', state: rec2.record.to.state, from: '+61412345678', recorded: true })).json();
check('and after it the call goes on to the step that follows', d.actions.map(a => a.say || '').join(' ').includes('Goodbye from SCS.') && d.actions[d.actions.length - 1].hangup === true, JSON.stringify(d.actions));

// ---------------- the dashboard's messages ----------------
d = await (await get('/api/console/phone', session)).json();
check('the dashboard lists the message with its team and where it was left',
  d.messages.length === 1 && d.messages[0].team === 'Opal Tappers' && d.messages[0].payphone === 'The Quad' && d.messages[0].heard === 0, JSON.stringify(d.messages));
r = await get('/api/console/phone/message?id=' + d.messages[0].id, session);
check('and plays its audio to a signed-in organiser only',
  r.status === 200 && r.headers.get('content-type') === 'audio/mpeg' && (await r.arrayBuffer()).byteLength === 2000 &&
  (await get('/api/console/phone/message?id=' + d.messages[0].id)).status === 401, String(r.status));
r = await jpost('/api/console/phone/message/delete', { id: d.messages[0].id }, session);
check('deleting a message takes its audio out of the bucket', r.status === 200 && stored.size === 0 && !raw.prepare('SELECT 1 FROM phone_messages').get(), '');
r = await jpost('/api/console/phone/tree', { reset: true }, session);
check('the tree can be put back to the one capture step', (await r.json()).tree_default === true && (await (await step({ from: A })).json()).actions[0].gather.to.node === 'capture', '');

// ---------------- a new PIN, and a deleted team ----------------
await jpost('/api/console/phone/pin', { team_id: 1 }, session);
check('a new PIN replaces the old one', (await result(pinNow, D)).result === 'bad_pin', '');
r = await jpost('/api/console/teams/delete', { id: 2, confirm: 'Running Rocks' }, session);
check('a team with captures can be deleted, and they go with it',
  r.status === 200 && raw.prepare('SELECT COUNT(*) AS n FROM phone_captures WHERE team_id = 2').get().n === 0 &&
  !raw.prepare('SELECT 1 FROM phone_pins WHERE team_id = 2').get(), String(r.status) + ' ' + JSON.stringify(await r.clone().json().catch(() => null)));

if (fail) { console.log('\n' + fail + ' check(s) failed'); process.exit(1); }
console.log('\nALL CHECKS PASSED');
