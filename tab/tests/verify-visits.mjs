// Run with: node tests/verify-visits.mjs   (needs Node 22+)
// How a quest shows on the recap's quest page and the replay
// (src/visits.ts): each team once, when it sent the quest, unless the
// dashboard's Recap card sets it to show photo by photo, each photo or
// video at the station, or the quest's place, nearest where it was taken,
// at the time it was taken, and the place picked where the file says
// nothing. The photos here are real JPEGs carrying a location and a time
// in their EXIF, read the way the worker reads every proof file.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
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
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };
const mod = await import(BOT + '/src/index.ts');
const ENV = { DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass' };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path) => front(path, {});
const session = (await consoleSignIn(jpost, 'Tab', 'tab-pass')).session;
await jpost('/api/console/quests/import-scs2', {}, session);
await jpost('/api/console/flags/set', { name: 'recap', value: true }, session);
await jpost('/api/console/flags/set', { name: 'replay', value: true }, session);
const view = async (key, v) => (await jpost('/api/console/recap/views', { key, view: v }, session)).json();

const REDFERN = { lat: -33.89205, lng: 151.19842 };
const TOWN_HALL = { lat: -33.87357, lng: 151.20685 };
const CENTRAL = { lat: -33.88402, lng: 151.2062 };
const NEWTOWN = { lat: -33.89787, lng: 151.17913 };
const pick = (station) => JSON.stringify({ kind: 'pick', value: station, prompt: 'Which station is this submission for?' });
let n = 0;
async function sent(team, code, at, answer, files, status) {
  const id = raw.prepare('INSERT INTO submissions (team_id, quest_code, status, submitted_at, answer) VALUES (?, ?, ?, ?, ?)')
    .run(team, code, status || 'accepted', at, answer).lastInsertRowid;
  for (const f of files) {
    const key = 'sub/visit' + (++n);
    const bytes = cameraJpeg(64, { gps: !!f.at, at: f.at || null, taken: f.taken });
    await SUBMIT.put(key, bytes, { httpMetadata: { contentType: 'image/jpeg' } });
    raw.prepare("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, ?, 'image/jpeg', ?, 'p.jpg')")
      .run(id, key, bytes.length);
  }
  return id;
}
// times sent are UTC; the photos' are Sydney's clock (+11:00), as a phone writes them
// one submission, three photos at three stations, one of them saying nowhere
await sent(1, 'SQ1', '2026-10-20 00:00:00', pick('Central'), [
  { at: REDFERN, taken: '2026:10:20 10:40:00' },
  { at: TOWN_HALL, taken: '2026:10:20 10:50:00' },
  { taken: '2026:10:20 10:55:00' }
]);
// Central again, later, this time with a location: the first visit stands
await sent(1, 'SQ1', '2026-10-20 01:00:00', pick('Central'), [{ at: CENTRAL, taken: '2026:10:20 11:58:00' }]);
// a station sent again with no photo, and one whose camera clock was days out
await sent(1, 'SQ1', '2026-10-20 02:00:00', pick('Redfern'), []);
await sent(1, 'SQ1', '2026-10-20 03:00:00', pick('Newtown'), [{ at: NEWTOWN, taken: '2026:10:17 09:00:00' }]);
// another team picked Museum but its photo says Central; a rejected one does not count
await sent(2, 'SQ1', '2026-10-20 00:30:00', pick('Museum'), [{ at: CENTRAL, taken: '2026:10:20 11:20:00' }]);
await sent(2, 'SQ1', '2026-10-20 00:40:00', pick('Redfern'), [{ at: REDFERN, taken: '2026:10:20 11:35:00' }], 'rejected');
// a quest of places with pins of its own: one photo at one of them, one saying nowhere
raw.prepare("UPDATE quest_groups SET coords = ? WHERE key = 'SQ47'").run(JSON.stringify([
  { label: 'Redfern Park', lat: -33.8935, lng: 151.2045 }, { label: 'Newtown Square', lat: -33.8975, lng: 151.1795 }]));
await sent(1, 'SQ47', '2026-10-20 04:00:00', null, [{ at: NEWTOWN, taken: '2026:10:20 14:50:00' }, { taken: '2026:10:20 14:55:00' }]);
const t1 = raw.prepare('SELECT name FROM teams WHERE id = 1').get().name;
const t2 = raw.prepare('SELECT name FROM teams WHERE id = 2').get().name;

// ---------- as every quest shows, until the Recap card says otherwise ----------
const plain = await (await get('/api/recap/quest?key=SQ1')).json();
const plainReplay = (await (await get('/api/replay')).json()).teams.find(t => t.name === t1).quests.filter(q => q.key === 'SQ1');
check('a quest shows each team once, when it sent it, until it is set to show photo by photo',
  plain.ok && !plain.visits && plainReplay.length === 1 && plainReplay[0].at === '2026-10-20 00:00:00' && !plainReplay[0].stop &&
  !raw.prepare('SELECT COUNT(*) AS n FROM photo_near').get().n, JSON.stringify(plainReplay));

const set = await view('sq1', 'stations');
const refused = [(await jpost('/api/console/recap/views', { key: 'SQ1', view: 'everywhere' }, session)).status,
  (await jpost('/api/console/recap/views', { key: 'NOPE', view: 'stations' }, session)).status];
check('the Recap card sets a quest by its key, in any case, and refuses a way it does not know or a quest that is not there',
  set.ok && set.quest_views && set.quest_views.SQ1 === 'stations' && refused[0] === 400 && refused[1] === 404,
  JSON.stringify({ views: set.quest_views, refused }));

// ---------- at the stations ----------
const page = await (await get('/api/recap/quest?key=SQ1')).json();
const st = page.visits ? page.visits.teams.map(t => [t.team, t.visits.map(v => v.place + ' ' + v.at.slice(11, 16)).join(', ')]) : [];
check('its page lists each team\'s stations in the order visited, most first',
  page.visits && page.visits.kind === 'stations' && st.length === 2 && st[0][0] === t1 && st[1][0] === t2, JSON.stringify(st));
check('each photo is the station it was taken at, at the time it was taken, and one with no location is the station picked',
  st[0] && st[0][1] === 'Redfern 23:40, Town Hall 23:50, Central 23:55, Newtown 03:00', st[0] && st[0][1]);
check('a photo whose station is not the one picked counts where it was taken, and the station picked when it was sent',
  st[1] && st[1][1] === 'Central 00:20, Museum 00:30', st[1] && st[1][1]);
const kept = raw.prepare('SELECT stations, places FROM photo_near ORDER BY file_id').all();
check('what is kept of each accepted file is the places within reach, never the location, and its taken time is recorded on the way',
  kept.length === 6 && kept[0].stations.indexOf('Redfern') !== -1 && kept[2].stations === '[]' &&
  kept.every(k => !/\d/.test(k.stations + k.places)) &&
  raw.prepare("SELECT COUNT(*) AS n FROM submission_files f JOIN submissions s ON s.id = f.submission_id WHERE s.quest_code = 'SQ1' AND s.status = 'accepted' AND f.taken_at IS NOT NULL").get().n === 6,
  JSON.stringify(kept.map(k => k.stations)));
const replay = await (await get('/api/replay')).json();
const stops = replay.teams.find(t => t.name === t1).quests.filter(q => q.key === 'SQ1');
check('the replay has a ring for each station at the station, at the time its photo was taken, in place of one for the quest',
  stops.length === 4 && stops.every(q => q.spot && q.stop === q.spot.place) &&
  stops.find(q => q.stop === 'Redfern').spot.lat === REDFERN.lat && stops.find(q => q.stop === 'Redfern').taken === true &&
  stops.find(q => q.stop === 'Newtown').taken === false && stops.find(q => q.stop === 'Redfern').at === '2026-10-19 23:40:00',
  JSON.stringify(stops.map(q => [q.stop, q.at, q.taken])));

// ---------- at the quest's own places ----------
await view('SQ47', 'places');
const places = await (await get('/api/recap/quest?key=SQ47')).json();
check('a quest set to its own places lists each photo at the one of them it was taken near, and a photo near none places nothing',
  places.visits && places.visits.kind === 'places' && places.visits.teams.length === 1 &&
  places.visits.teams[0].visits.map(v => v.place + ' ' + v.at.slice(11, 16)).join(', ') === 'Newtown Square 03:50',
  JSON.stringify(places.visits));

// ---------- and back ----------
const back = await view('SQ1', 'sent');
const again = await (await get('/api/recap/quest?key=SQ1')).json();
const read = raw.prepare("SELECT COUNT(*) AS n FROM photo_near p JOIN submission_files f ON f.id = p.file_id JOIN submissions s ON s.id = f.submission_id WHERE s.quest_code = 'SQ1'").get().n;
check('set back, the quest shows each team once again, and its photos are read afresh if it is set again',
  back.ok && !back.quest_views.SQ1 && back.quest_views.SQ47 === 'places' && !again.visits && read === 0, JSON.stringify(back.quest_views));

console.log(fail ? fail + ' check(s) failed' : 'all checks passed');
process.exit(fail ? 1 : 0);
