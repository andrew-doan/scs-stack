// Run with: node tests/verify-team-map.mjs   (needs Node 22+ for node:sqlite)
// The dashboard's Map tab: each team placed at the pin of the newest
// submission that can say where it was, when it last sent anything,
// and who may read it.
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
function group(key, name, kind, pins, codes) {
  const id = Number(raw.prepare('INSERT INTO quest_groups (key, name, submit_kind, coords) VALUES (?, ?, ?, ?)')
    .run(key, name, kind, JSON.stringify(pins)).lastInsertRowid);
  codes.forEach((c, i) => raw.prepare('INSERT INTO quests (code, norm, points, group_id, label, sort) VALUES (?, ?, 100, ?, ?, ?)')
    .run(c[0], c[0], id, c[1], i));
}
group('PQ1', 'Central stairs', 'none', [{ label: 'Central Station', lat: -33.8832, lng: 151.207 }], [['PQ1', '']]);
group('PQ2', 'Casino', 'none', [{ label: 'The Star', lat: -33.8677, lng: 151.195 }, { label: 'Crown Sydney', lat: -33.8614, lng: 151.201 }], [['PQ2', '']]);
group('PQ3', 'Two suburbs', 'codes', [{ label: 'Hurstville Plaza', lat: -33.9673, lng: 151.1023 }, { label: 'Burwood Chinatown', lat: -33.8775, lng: 151.1039 }],
  [['PQ3-H', 'Hurstville'], ['PQ3-B', 'Burwood']]);
group('PQ4', 'Anywhere', 'none', [], [['PQ4', '']]);
group('PQ5', 'Either end', 'none', [{ label: 'Wondabyne', lat: -33.4939, lng: 151.2506 }, { label: 'Engadine', lat: -34.0651, lng: 151.0125 }], [['PQ5', '']]);

const teams = raw.prepare('SELECT id, name FROM teams ORDER BY id LIMIT 6').all();
function sent(team, code, at, extra) {
  const e = extra || {};
  raw.prepare('INSERT INTO submissions (team_id, quest_code, status, submitted_at, answer, added_by, credit) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(team.id, code, e.status || 'pending', at, e.answer ? JSON.stringify(e.answer) : null, e.by || '', e.credit ? JSON.stringify(e.credit) : null);
}
const [a, b, c, d, e, f] = teams;
sent(a, 'PQ1', '2026-10-20 00:00:00');
sent(a, 'PQ4', '2026-10-20 00:30:00');
sent(b, 'PQ3-H', '2026-10-20 00:05:00', { answer: { kind: 'codes', value: ['PQ3-B'] } });
sent(c, 'PQ2', '2026-10-20 00:10:00', { status: 'rejected' });
sent(d, 'PQ1', '2026-10-19 23:00:00', { status: 'accepted' });
sent(d, 'PQ2', '2026-10-19 23:30:00', { status: 'deleted' });
sent(e, 'PQ4', '2026-10-20 00:00:00');
sent(e, 'PQ3-H', '2026-10-20 01:00:00', { status: 'accepted', by: 'Alex', credit: { codes: ['PQ3-H'], amount: 1 } });
sent(f, 'PQ1', '2026-10-19 22:00:00');
sent(f, 'PQ5', '2026-10-19 22:30:00');

globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };
const mod = await import(BOT + '/src/index.ts');
const ENV = { DB: d1Shim(raw), CONSOLE_PASSWORD: 'tab-pass' };
const ctx = { waitUntil() {} };
const front = (path, opts) => mod.default.fetch(new Request('https://tab.example' + path, opts), ENV, ctx);
const post = (path, body, token) => front(path, {
  method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });

const admin = (await consoleSignIn(post, 'Alex', 'tab-pass')).session;
const map = await (await get('/api/console/map', admin)).json();
const byId = {};
(map.teams || []).forEach(t => { byId[t.id] = t; });
const seen = t => byId[t.id] && byId[t.id].seen;
const got = [a, b, c, d, e, f].map(t => [seen(t) ? seen(t).place : null, byId[t.id] && byId[t.id].last_sent, seen(t) ? seen(t).organiser : null]);
const want = [
  ['Central Station', '2026-10-20 00:30:00', false],          // a later quest with no pin does not move it
  ['Burwood Chinatown', '2026-10-20 00:05:00', false],        // the ticked code picks the pin
  ['The Star or Crown Sydney', '2026-10-20 00:10:00', false], // two pins close together and nothing to choose
  ['Central Station', '2026-10-19 23:30:00', false],          // a deleted submission places nobody
  ['Hurstville Plaza', '2026-10-20 00:00:00', true],          // an organiser's entry places, but is not sent
  ['Central Station', '2026-10-19 22:30:00', false]           // pins too far apart to choose between are passed over
];
check('each team is at the pin of its newest submission that can say where it was, and its last sent time is what it sent itself',
  JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
check('a team with nothing sent is listed with no pin and no time',
  map.teams.length === raw.prepare('SELECT COUNT(*) AS n FROM teams').get().n &&
  map.teams.filter(t => ![a, b, c, d, e, f].some(x => x.id === t.id)).every(t => !t.seen && t.last_sent === ''), '');

await post('/api/console/accounts/save', { create: true, name: 'Marshal', password: 'marshal-pass-1', perms: ['review'], require_2fa: false }, admin);
await post('/api/console/accounts/save', { create: true, name: 'Watcher', password: 'watcher-pass-1', perms: ['map'], require_2fa: false }, admin);
const marshal = (await (await post('/api/console/login', { name: 'Marshal', password: 'marshal-pass-1' })).json()).session;
const watcher = (await (await post('/api/console/login', { name: 'Watcher', password: 'watcher-pass-1' })).json()).session;
const statuses = [(await get('/api/console/map', marshal)).status, (await get('/api/console/map', watcher)).status];
check('the map is for accounts given the Map tab', statuses.join() === '403,200', statuses.join());

if (failures) { console.log('\n' + failures + ' FAILED'); process.exit(1); }
console.log('\nALL CHECKS PASSED');
