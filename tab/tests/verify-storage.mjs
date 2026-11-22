// Run with: node tests/verify-storage.mjs   (needs Node 22+)
//
// The dashboard's Storage card, against the real worker: every object
// in the bucket is listed once across however many requests the page
// makes, and each lands in the area and kind its key, its type and the
// rows pointing at it say it is — a file as sent, a copy beside it, a
// video copy at its height, an upload not saved yet, or nothing at all.
// The bucket here answers a few objects a list call, as R2 may, so the
// cursor is followed across requests with a couple of dozen objects.
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
const db = d1Shim(raw);

// ---- a bucket that lists in key order, a few objects a call ----
const bucket = new Map();
const PER_CALL = 4;
let listCalls = 0;
const SUBMIT = {
  async put(key, size, type) { bucket.set(key, { size, type }); },
  async list(opts) {
    listCalls++;
    const keys = [...bucket.keys()].sort();
    const from = opts && opts.cursor ? Number(opts.cursor) : 0;
    const take = keys.slice(from, from + Math.min(PER_CALL, (opts && opts.limit) || 1000));
    const next = from + take.length;
    const withMeta = opts && opts.include && opts.include.indexOf('httpMetadata') !== -1;
    return {
      objects: take.map(k => ({ key: k, size: bucket.get(k).size, httpMetadata: withMeta ? { contentType: bucket.get(k).type } : undefined })),
      truncated: next < keys.length,
      cursor: next < keys.length ? String(next) : undefined
    };
  }
};

// ---- what the event holds ----
raw.exec("INSERT INTO teams (id, name) VALUES (1, 'Opal Tappers'), (2, 'Test Team')");
raw.exec('UPDATE teams SET hidden = 1 WHERE id = 2');
raw.exec("INSERT INTO submissions (id, team_id, quest_code, status) VALUES (1, 1, 'SQ1', 'accepted'), (2, 2, 'SQ1', 'pending')");
raw.exec("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES " +
  "(1, 'sub/photo1', 'image/jpeg', 3000, 'IMG_1.jpg'), (1, 'sub/video1', 'video/quicktime', 90000, 'IMG_2.mov'), " +
  "(1, 'sub/track1', 'application/gpx+xml', 700, 'run.gpx'), (2, 'sub/photo2', 'image/jpeg', 2000, 'test.jpg')");
raw.exec("INSERT INTO submission_renditions (file_key, height, key, bytes) VALUES " +
  "('sub/video1', 480, 'rnd/a480', 9000), ('sub/video1', 720, 'rnd/b720', 20000), ('alb/vid', 1080, 'rnd/c1080', 40000)");
raw.exec("INSERT INTO albums (id, name, slug) VALUES (1, 'The day', 'the-day')");
raw.exec("INSERT INTO album_photos (album_id, r2_key, content_type, bytes, name) VALUES " +
  "(1, 'alb/pic', 'image/jpeg', 5000, 'a.jpg'), (1, 'alb/vid', 'video/mp4', 80000, 'b.mp4')");
raw.exec("INSERT INTO message_files (message_id, key, name, type, bytes) VALUES (1, 'msg/m1', 'map.pdf', 'application/pdf', 400)");
raw.exec("INSERT INTO home_slides (key, name, type, bytes) VALUES ('slide/s1', 'crowd.jpg', 'image/jpeg', 6000)");
raw.exec("INSERT INTO drop_files (key, name, type, bytes) VALUES ('drop/d1', 'poster.png', 'image/png', 7000)");
raw.exec("INSERT INTO staged_uploads (r2_key, purpose, name, content_type, bytes, part_size, actor, status) VALUES " +
  "('drop/d2', 'drop', 'big.mov', 'video/quicktime', 100, 100, 'Comms', 'ready')");

// key -> [size, type, the place it should land in]
const OBJECTS = {
  'sub/photo1': [3000, 'image/jpeg', 'proof|photo'],
  'sub/photo1.t': [30, 'image/jpeg', 'proof|thumb'],
  'sub/photo1.v': [300, 'image/jpeg', 'proof|view'],
  'sub/photo1.x': [10, 'application/octet-stream', 'proof|meta'],
  'sub/photo1.c': [2900, 'image/jpeg', 'proof|oldclean'],
  'sub/photo1.p': [4000, 'image/heic', 'proof|picked'],
  'sub/photo2': [2000, 'image/jpeg', 'proof|photo'],
  'sub/video1': [90000, 'video/quicktime', 'proof|video'],
  'sub/video1.c': [89000, 'video/quicktime', 'proof|clean'],
  'sub/video1.t': [40, 'image/jpeg', 'proof|thumb'],
  'sub/track1': [700, 'application/gpx+xml', 'proof|other'],
  'sub/lost': [500, 'image/jpeg', 'proof|unlinked'],
  'sub/lost.t': [5, 'image/jpeg', 'proof|unlinked'],
  'rnd/a480': [9000, 'video/mp4', 'proof|copy480'],
  'rnd/b720': [20000, 'video/mp4', 'proof|copy720'],
  'rnd/c1080': [40000, 'video/mp4', 'albums|copy1080'],
  'rnd/gone': [100, 'video/mp4', 'other|unlinked'],
  'alb/pic': [5000, 'image/jpeg', 'albums|photo'],
  'alb/pic.t': [50, 'image/jpeg', 'albums|thumb'],
  'alb/vid': [80000, 'video/mp4', 'albums|video'],
  'msg/m1': [400, 'application/pdf', 'messages|other'],
  'slide/s1': [6000, 'image/jpeg', 'slides|photo'],
  'slide/s1.x': [12, 'application/octet-stream', 'slides|meta'],
  'drop/d1': [7000, 'image/png', 'files|photo'],
  'drop/d2': [100, 'video/quicktime', 'files|staged'],
  'backup/old.json': [800, 'application/json', 'other|other']
};
for (const [key, [size, type]] of Object.entries(OBJECTS)) await SUBMIT.put(key, size, type);

const want = {};
for (const [size, , place] of Object.values(OBJECTS)) {
  const w = want[place] || (want[place] = { n: 0, bytes: 0 });
  w.n++;
  w.bytes += size;
}

const mod = await import(BOT + '/src/index.ts');
const ENV = { DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass' };
const ctx = { waitUntil() {} };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, ctx);
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
const sess = (await consoleSignIn(jpost, 'Comms', 'tab-pass')).session;

let r = await get('/api/console/storage');
check('the count needs a dashboard session', r.status === 401, 'status=' + r.status);

// the page's loop: ask again with the cursor until the worker is done
const answers = [];
let cursor = '';
for (let i = 0; i < 20; i++) {
  r = await get('/api/console/storage' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : ''), sess);
  const d = await r.json();
  answers.push(d);
  if (!d.ok || d.done) break;
  cursor = d.cursor;
}
const places = {};
const types = {};
let listed = 0;
for (const d of answers) {
  listed += d.listed || 0;
  for (const [k, v] of Object.entries(d.places || {})) {
    const p = places[k] || (places[k] = { n: 0, bytes: 0 });
    p.n += v.n;
    p.bytes += v.bytes;
  }
  for (const [k, v] of Object.entries(d.types || {})) {
    const t = types[k] || (types[k] = { n: 0, bytes: 0 });
    t.n += v.n;
    t.bytes += v.bytes;
  }
}
const sorted = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k].n, o[k].bytes]));
check('across several requests every object is counted once, in the area and kind its key, type and rows say',
  answers.length >= 2 && answers.every(d => d.ok) && answers[answers.length - 1].done && listed === bucket.size &&
  sorted(places) === sorted(want),
  JSON.stringify({ requests: answers.length, listed, got: places }));

const first = answers[0];
const later = answers.slice(1);
check('the files as sent are counted by type, and the biggest objects are named',
  types['image/jpeg'] && types['image/jpeg'].n === 4 && types['video/quicktime'].bytes === 90000 && types['image/png'].n === 1 &&
  first.largest[0].bytes >= first.largest[first.largest.length - 1].bytes &&
  answers.some(d => d.largest.some(x => x.key === 'sub/video1' && x.name === 'IMG_2.mov' && x.kind === 'video')),
  JSON.stringify({ types, largest: first.largest.slice(0, 3) }));
check('the first answer alone carries the database, its tables, and the files as sent by team and by album',
  typeof first.database.bytes === 'number' && first.database.bytes > 0 &&
  first.database.tables.some(t => t.name === 'submission_files' && t.rows === 4) &&
  JSON.stringify(first.teams.map(t => [t.name, t.n, t.bytes, t.hidden])) === JSON.stringify([['Opal Tappers', 3, 93700, false], ['Test Team', 1, 2000, true]]) &&
  JSON.stringify(first.albums) === JSON.stringify([{ name: 'The day', n: 2, bytes: 85000 }]) &&
  later.every(d => d.database === undefined && d.teams === undefined),
  JSON.stringify({ db: first.database && first.database.bytes, teams: first.teams, albums: first.albums }));

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
