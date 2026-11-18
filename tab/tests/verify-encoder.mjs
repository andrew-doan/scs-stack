// Run with: node tests/verify-encoder.mjs   (needs Node 22+)
// The video renditions, end to end against the real worker: the
// encoder endpoints and what locks them, several machines sharing the
// work by claiming one video at a time (including the claim that two
// of them race for), the claim that expires when a machine dies,
// renditions landing in R2 and replacing an older copy of the same
// height, and — the part the site depends on — a file endpoint that
// always answers with something, falling down or up the sizes it has
// and back to the original.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { pretendR2, HOST } from './pretend-r2.mjs';

import { consoleSignIn } from './console-signin.mjs';
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

// ---- R2 shim: put, ranged get, delete, multipart ----
const bucket = new Map();
async function drain(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(0);
}
function stitch(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}
const multi = new Map(); // uploadId -> { key, parts, meta }
let mpSeq = 0;
const SUBMIT = {
  async put(key, value, opts) {
    bucket.set(key, { bytes: await drain(value), meta: (opts && opts.httpMetadata) || {}, custom: (opts && opts.customMetadata) || {} });
  },
  async createMultipartUpload(key, opts) {
    const uploadId = 'mp' + (++mpSeq);
    multi.set(uploadId, { key, parts: new Map(), meta: (opts && opts.httpMetadata) || {} });
    return { key, uploadId };
  },
  resumeMultipartUpload(key, uploadId) {
    return {
      async uploadPart(n, value) {
        const up = multi.get(uploadId);
        if (!up || up.key !== key) throw new Error('no such upload');
        const bytes = await drain(value);
        const etag = 'et' + n + '-' + bytes.length;
        up.parts.set(n, { bytes, etag });
        return { partNumber: n, etag };
      },
      async complete(parts) {
        const up = multi.get(uploadId);
        if (!up || up.key !== key) throw new Error('no such upload');
        const out = stitch(parts.map(p => {
          const got = up.parts.get(p.partNumber);
          if (!got || got.etag !== p.etag) throw new Error('bad part list');
          return got.bytes;
        }));
        bucket.set(key, { bytes: out, meta: up.meta, custom: {} });
        multi.delete(uploadId);
        return { key, size: out.length };
      },
      async abort() { multi.delete(uploadId); }
    };
  },
  async get(key, opts) {
    const hit = bucket.get(key);
    if (!hit) return null;
    let bytes = hit.bytes;
    if (opts && opts.range) {
      const r = opts.range;
      if (r.suffix != null) bytes = bytes.slice(bytes.length - r.suffix);
      else bytes = bytes.slice(r.offset, r.length != null ? r.offset + r.length : undefined);
    }
    // a real R2 object reads its own bytes back, and the worker uses
    // that to make the copy with the metadata taken out
    return {
      body: bytes, size: hit.bytes.length, httpMetadata: hit.meta, customMetadata: hit.custom || {},
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
    };
  },
  async head(key) { return bucket.has(key) ? { size: bucket.get(key).bytes.length } : null; },
  async delete(key) { bucket.delete(key); }
};

globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };

const ENV = { DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass', ENCODER_KEY: 'encoder-secret' };
const LOCKED = { DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass' };                       // no key at all
const PLACEHOLDER = { DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass', ENCODER_KEY: 'PASTE a long random string' };
const ctx = { waitUntil() {} };
const front = (path, opts, env) => mod.default.fetch(new Request('https://bot.example' + path, opts), env || ENV, ctx);
const jpost = (path, body, token, env) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
}, env);
const get = (path, token, extra) => front(path, {
  headers: Object.assign(token ? { authorization: 'Bearer ' + token } : {}, extra || {})
});
// every encoder call names its machine
const MAC = 'studio-mac';
const named = (body, name) => Object.assign({ name: name || MAC }, body || {});
const poll = (body, token, env, name) =>
  jpost('/api/encoder/poll', named(body || { state: 'idle', working_on: '' }, name), token || 'encoder-secret', env);
const claim = (key, name) => jpost('/api/encoder/claim', named({ key: key }, name), 'encoder-secret');
const finish = (body, name) => jpost('/api/encoder/finish', named(body, name), 'encoder-secret');
const putRendition = (key, height, bytes, token, name) => front(
  '/api/encoder/rendition?key=' + encodeURIComponent(key) + '&height=' + height +
  '&name=' + encodeURIComponent(name || MAC),
  { method: 'PUT', headers: { authorization: 'Bearer ' + (token || 'encoder-secret'), 'content-type': 'video/mp4' }, body: bytes }
);

const KEY = 'encoder-secret';
const consoleSess = (await consoleSignIn(jpost, 'Tab', 'tab-pass')).session;

// ---------------- a team with a video to encode ----------------
await jpost('/api/console/codes/generate', {}, consoleSess);
const codes = (await (await get('/api/console/codes', consoleSess)).json()).codes;
const garb = codes.find(c => c.name === 'Galahs');
const teamSess = (await (await jpost('/api/submit/login', { team_name: 'Galahs', code: garb.code })).json()).session;

// a real PNG with a text chunk in it, so the worker's stripper has
// something true to take out — a photo is served as the copy with its
// metadata gone, never as the file that was uploaded
function pngChunk(type, data) {
  const len = data.length;
  return [(len >>> 24) & 255, (len >> 16) & 255, (len >> 8) & 255, len & 255,
    ...[...type].map(c => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
}
const png = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10,
  ...pngChunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0]),
  ...pngChunk('tEXt', [...'Author'].map(c => c.charCodeAt(0)).concat([0, 109, 101])),
  ...pngChunk('IDAT', [1, 2, 3, 4, 5, 6, 7, 8]),
  ...pngChunk('IEND', [])
]);
// the same picture once the text chunk is off it
const PNG_CLEAN = png.length - (12 + 9);
const clip = new Uint8Array(4096).fill(9);
clip[clip.length - 1] = 77;
const form = new FormData();
form.append('quest', 'make 21');
form.append('files', new File([clip], 'clip.mp4', { type: 'video/mp4' }), 'clip.mp4');
form.append('files', new File([png], 'photo.png', { type: 'image/png' }), 'photo.png');
const thumbJpeg = new Uint8Array(64);
thumbJpeg.set([0xFF, 0xD8, 0xFF, 0xDA, 0, 2]);
thumbJpeg.set([0xFF, 0xD9], 62);
form.append('thumb0', new File([thumbJpeg], 'thumb.jpg', { type: 'image/jpeg' }), 'thumb.jpg');
let r = await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: form });
let d = await r.json();
check('a submission with a video and a photo lands', r.status === 200 && d.files === 2, JSON.stringify(d));
const subId = d.id;
const fileRows = raw.prepare('SELECT r2_key, content_type FROM submission_files WHERE submission_id = ? ORDER BY id').all(subId);
const videoKey = fileRows.find(f => f.content_type.startsWith('video/')).r2_key;
const photoKey = fileRows.find(f => f.content_type.startsWith('image/')).r2_key;

// ---------------- the key is the whole credential ----------------
r = await jpost('/api/encoder/poll', { state: 'idle' });
check('the encoder endpoints refuse a caller with no key', r.status === 401, 'status=' + r.status);
r = await poll(null, 'not-the-key');
check('and one with the wrong key', r.status === 401, 'status=' + r.status);
r = await poll(null, KEY, LOCKED);
d = await r.json();
check('with no ENCODER_KEY set they answer 503 in plain words',
  r.status === 503 && /ENCODER_KEY/.test(d.error), 'status=' + r.status + ' ' + JSON.stringify(d));
r = await poll(null, 'PASTE a long random string', PLACEHOLDER);
check('a key still reading PASTE counts as unset', r.status === 503, 'status=' + r.status);
r = await putRendition(videoKey, 720, new Uint8Array(10), 'not-the-key');
check('so does the rendition upload', r.status === 401, 'status=' + r.status);
r = await jpost('/api/encoder/finish', { key: videoKey, heights: [] }, 'not-the-key');
check('and finish', r.status === 401, 'status=' + r.status);
r = await jpost('/api/encoder/nonsense', named({}), KEY);
check('an unknown encoder action is not found', r.status === 404, 'status=' + r.status);

// every call says which machine it is
r = await jpost('/api/encoder/poll', { state: 'idle' }, KEY);
check('a poll that does not name its machine is refused',
  r.status === 400 && /name/.test((await r.json()).error), 'status=' + r.status);
r = await jpost('/api/encoder/claim', { key: videoKey }, KEY);
check('nor can a claim be anonymous', r.status === 400, 'status=' + r.status);
r = await front('/api/encoder/rendition?key=' + encodeURIComponent(videoKey) + '&height=480',
  { method: 'PUT', headers: { authorization: 'Bearer ' + KEY, 'content-type': 'video/mp4' }, body: new Uint8Array(4) });
check('nor a rendition upload', r.status === 400, 'status=' + r.status);

// ---------------- poll: the heartbeat and the queue ----------------
r = await poll({ state: 'idle', working_on: '' }, KEY);
d = await r.json();
check('the poll lists the video and leaves the photo alone',
  r.status === 200 && d.ok && d.jobs.length === 1 && d.jobs[0].key === videoKey &&
  d.jobs[0].name === 'clip.mp4' && d.jobs[0].bytes === clip.length && d.jobs[0].type === 'video/mp4',
  JSON.stringify(d.jobs));
check('and says how much is waiting altogether',
  d.waiting === 1 && d.waiting_bytes === clip.length, JSON.stringify({ waiting: d.waiting, bytes: d.waiting_bytes }));
check('polling wrote that machine down',
  raw.prepare('SELECT name, last_seen, state FROM encoders WHERE name = ?').get(MAC).state === 'idle', '');
check('the poll writes nothing to the log — it fires every ten seconds',
  raw.prepare("SELECT COUNT(*) AS n FROM submission_log WHERE action = 'encode-done'").get().n === 0, '');

// ---------------- claim ----------------
r = await claim('sub/1/nothing-here');
check('claiming a file that is not there says so', r.status === 404, 'status=' + r.status);
r = await claim(videoKey);
const firstClaim = await r.json();
check('claiming marks the file encoding, and hands back when', firstClaim.ok === true && !!firstClaim.claimed_at, JSON.stringify(firstClaim));
{
  const claimed = raw.prepare('SELECT encode_state, encode_claimed_at FROM submission_files WHERE r2_key = ?').get(videoKey);
  check('and stamps when', claimed.encode_state === 'encoding' && /^\d{4}-\d{2}-\d{2} /.test(claimed.encode_claimed_at),
    JSON.stringify(claimed));
}
r = await poll({ state: 'encoding', working_on: videoKey }, KEY);
check('a claimed file is not offered again', (await r.json()).jobs.length === 0, '');

r = await get('/api/console/submissions?status=pending', consoleSess);
let sub = (await r.json()).submissions.find(s => s.id === subId);
let vid = sub.media.find(m => m.key === videoKey);
check('review says the video is encoding, and says nothing of the sort about the photo',
  vid.encoding === true && sub.media.find(m => m.key === photoKey).encoding === undefined,
  JSON.stringify(sub.media));

// two machines will ask for the same video sooner or later: the claim
// itself is what keeps them apart
await poll({ state: 'idle', working_on: '' }, KEY, null, 'kitchen-laptop');
r = await claim(videoKey, 'kitchen-laptop');
check('a second machine claiming the same video is turned away',
  r.status === 409 && /another encoder/.test((await r.json()).error), 'status=' + r.status);
check('and the machine that got there first keeps it',
  raw.prepare('SELECT working_on FROM encoders WHERE name = ?').get(MAC).working_on === videoKey &&
  raw.prepare('SELECT working_on FROM encoders WHERE name = ?').get('kitchen-laptop').working_on === '', '');

// a machine that died mid-file must not leave the video stuck
raw.prepare("UPDATE submission_files SET encode_claimed_at = datetime('now', '-30 minutes') WHERE r2_key = ?").run(videoKey);
// the first claim as it stands now, half an hour old
const ranOut = raw.prepare('SELECT encode_claimed_at FROM submission_files WHERE r2_key = ?').get(videoKey).encode_claimed_at;
r = await poll({ state: 'idle', working_on: '' }, KEY);
check('a claim older than fifteen minutes is offered again',
  (await r.json()).jobs.length === 1, '');
r = await claim(videoKey, 'kitchen-laptop');
check('and whichever machine asks next takes it over', (await r.json()).ok === true, '');
r = await finish({ key: videoKey, heights: [], note: 'gave up', claimed_at: ranOut });
check('the machine whose claim ran out cannot mark it skipped under the one that took it over',
  r.status === 200 && raw.prepare('SELECT encode_state FROM submission_files WHERE r2_key = ?').get(videoKey).encode_state === 'encoding',
  JSON.stringify(raw.prepare('SELECT encode_state FROM submission_files WHERE r2_key = ?').get(videoKey)));
// hand it back to this suite's machine for the rest
raw.prepare("UPDATE submission_files SET encode_claimed_at = datetime('now', '-30 minutes') WHERE r2_key = ?").run(videoKey);
await claim(videoKey);
check('the file is claimed again either way',
  raw.prepare('SELECT encode_state FROM submission_files WHERE r2_key = ?').get(videoKey).encode_state === 'encoding', '');

// ---------------- renditions ----------------
const r480 = new Uint8Array(600).fill(4);
const r720 = new Uint8Array(1200).fill(7);
const r720again = new Uint8Array(1500).fill(8);

r = await putRendition(videoKey, 999, r480);
check('a height outside the three buckets is refused', r.status === 400, 'status=' + r.status);
r = await putRendition('sub/1/nothing-here', 720, r720);
check('a rendition for a file that is not there is refused', r.status === 404, 'status=' + r.status);
r = await putRendition(videoKey, 480, new Uint8Array(96 * 1024 * 1024));
check('a copy too big for one request is told to come in slices, not turned away',
  r.status === 413 && /in slices/.test((await r.json()).error), 'status=' + r.status);

r = await putRendition(videoKey, 480, r480);
d = await r.json();
check('a 480p copy is stored', r.status === 200 && d.ok && d.height === 480 && d.bytes === 600, JSON.stringify(d));
r = await putRendition(videoKey, 720, r720);
check('and a 720p copy', (await r.json()).bytes === 1200, '');
const stored = raw.prepare('SELECT height, key, bytes FROM submission_renditions WHERE file_key = ? ORDER BY height').all(videoKey);
check('both rows point at objects under rnd/',
  stored.length === 2 && stored.every(s => s.key.startsWith('rnd/') && bucket.has(s.key)), JSON.stringify(stored));
const oldKey = stored.find(s => s.height === 720).key;
r = await putRendition(videoKey, 720, r720again);
check('sending 720p again replaces it', (await r.json()).bytes === 1500, '');
const after = raw.prepare('SELECT height, key, bytes FROM submission_renditions WHERE file_key = ? ORDER BY height').all(videoKey);
check('one row per height, the new bytes, and the old object deleted',
  after.length === 2 && after.find(s => s.height === 720).bytes === 1500 && !bucket.has(oldKey),
  JSON.stringify(after));

// ---------------- serving ----------------
const bytesOf = async (res) => new Uint8Array(await res.arrayBuffer());
const fileUrl = (res) => '/api/submit/file?key=' + encodeURIComponent(videoKey) + (res ? '&res=' + res : '');

r = await get(fileUrl(720));
check('res=720 serves the 720p copy',
  r.status === 200 && (await bytesOf(r)).length === 1500 && r.headers.get('content-type') === 'video/mp4',
  'status=' + r.status);
r = await get(fileUrl(480));
check('res=480 serves the 480p copy', (await bytesOf(r)).length === 600, '');
// A picture asked for by a link unfurler is bumped to the full clean
// copy; a video is not, or an embed would pull a whole original down
// whatever connection the venue has.
r = await front(fileUrl(480), {
  headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' }
});
check('and still does for a link preview: a video is left at the size it asked for',
  (await bytesOf(r)).length === 600, '');
r = await get(fileUrl(1080));
check('res=1080 with only 480 and 720 falls back to the largest below it',
  (await bytesOf(r)).length === 1500, '');
// The original is never handed out here — the clean copy the encoder
// makes stands in for it, and until that exists the largest rendition
// does. Both have had the location taken out of them.
r = await get(fileUrl());
check('no res at all serves the largest clean copy there is, not the original',
  (await bytesOf(r)).length === 1500, '');
r = await get(fileUrl('original'));
check('and res=original means the same thing', (await bytesOf(r)).length === 1500, '');
// the encoder sends the full-size clean copy under its own name
bucket.set(videoKey + '.c', { bytes: new Uint8Array(4321).fill(6), meta: { contentType: 'video/mp4' } });
r = await get(fileUrl('original'));
check('once the clean copy lands it is what Original means',
  (await bytesOf(r)).length === 4321, '');
bucket.delete(videoKey + '.c');
// ---- handing a stuck claim back ----
// A claim expires by itself after fifteen minutes, which covers a
// runner that died — but waiting that out to retry a video is a long
// time on the day, so the dashboard can hand them all back at once.
{
  const held = await jpost('/api/encoder/claim', { key: videoKey, name: 'studio-mac' }, 'encoder-secret');
  const wasHeld = held.status === 200 || held.status === 409; // either way it is claimed now
  let poll = await jpost('/api/encoder/poll', { name: 'studio-mac', state: 'idle' }, 'encoder-secret');
  const beforeFree = (await poll.json()).waiting;
  check('a claimed video is not offered to anyone while the claim is fresh',
    wasHeld && !(await raw.prepare('SELECT encode_state FROM submission_files WHERE r2_key = ?').get(videoKey).encode_state === ''),
    'waiting=' + beforeFree);

  let rel = await jpost('/api/console/encoder/release', {}, consoleSess);
  const rd = await rel.json();
  check('the dashboard hands back every video a machine is holding',
    rel.status === 200 && rd.ok && rd.held >= 1, JSON.stringify(rd));
  check('and the row really is free again',
    raw.prepare('SELECT encode_state, encode_claimed_at FROM submission_files WHERE r2_key = ?').get(videoKey).encode_state === '',
    '');
  poll = await jpost('/api/encoder/poll', { name: 'studio-mac', state: 'idle' }, 'encoder-secret');
  check('so the next poll offers it straight away, without waiting the claim out',
    (await poll.json()).waiting > beforeFree, '');
  rel = await jpost('/api/console/encoder/release', {}, consoleSess);
  check('pressing it with nothing held frees nothing and says so',
    (await rel.json()).freed === 0, '');
  check('it needs a dashboard session', (await jpost('/api/console/encoder/release', {})).status === 401, '');

}

// ---- the encoder reads originals; nothing else does ----
// Nothing public can reach an original any more, but the encoder is
// what makes the copy everyone else is served, so it has to be able
// to read the thing it is copying. Its own key is what separates the
// two — and getting this wrong stops every video being encoded at all.
{
  const srcUrl = '/api/encoder/source?key=' + encodeURIComponent(videoKey);
  let sr = await front(srcUrl);
  check('the source endpoint refuses a call with no encoder key', sr.status === 401, 'status=' + sr.status);
  sr = await front(srcUrl, { headers: { authorization: 'Bearer wrong-key' } });
  const why = (await sr.json()).error;
  check('and one with the wrong key, saying what did not match rather than just no',
    sr.status === 401 && /ENCODER_KEY/.test(why) && /secrets\.json/.test(why),
    'status=' + sr.status + ' ' + JSON.stringify(why));
  sr = await front(srcUrl, { headers: { authorization: 'Bearer encoder-secret' } });
  const srcBytes = await bytesOf(sr);
  check('with the right key it hands over the original, whole, uncached',
    sr.status === 200 && srcBytes.length === clip.length &&
    (sr.headers.get('cache-control') || '').includes('no-store'),
    'status=' + sr.status + ' len=' + srcBytes.length);
  sr = await front('/api/encoder/source?key=' + encodeURIComponent('sub/1/not-a-real-key'),
    { headers: { authorization: 'Bearer encoder-secret' } });
  check('a key with no row behind it is not found', sr.status === 404, 'status=' + sr.status);
}

r = await get(fileUrl('nonsense'));
check('a res that means nothing still serves something rather than failing',
  r.status === 200 && (await bytesOf(r)).length === 1500, 'status=' + r.status);
r = await get('/api/submit/file?key=' + encodeURIComponent(videoKey) + '&thumb=1&res=480');
check('thumb=1 still wins over res', (await bytesOf(r)).length === 64, '');

// ---------------- a still from the encoder ----------------
{
  const putStill = (key, bytes, type, name) => front('/api/encoder/still?key=' + encodeURIComponent(key) +
    (name === '' ? '' : '&name=' + encodeURIComponent(name || MAC)),
    { method: 'PUT', headers: { authorization: 'Bearer ' + KEY, 'content-type': type || 'image/jpeg' }, body: bytes });
  const stillJpeg = new Uint8Array(96);
  stillJpeg.set([0xFF, 0xD8, 0xFF, 0xDA, 0, 2]);
  stillJpeg.set([0xFF, 0xD9], 94);
  const t = videoKey + '.t';
  const pageMade = bucket.get(t).bytes;
  const a = await putStill(videoKey, stillJpeg, 'image/jpeg', '');
  const b = await putStill('sub/1/nothing-here', stillJpeg);
  const c = await putStill(photoKey, stillJpeg);
  const kept = await putStill(videoKey, stillJpeg);
  const keptBody = await kept.json();
  check('a still names its machine, has a video behind it, and does not replace the one the page made',
    a.status === 400 && b.status === 404 && c.status === 400 &&
    keptBody.kept === true && bucket.get(t).bytes === pageMade,
    [a.status, b.status, c.status, JSON.stringify(keptBody)].join(' '));
  bucket.delete(t);
  r = await get('/api/submit/file?key=' + encodeURIComponent(videoKey) + '&thumb=1');
  const none = r.status;
  const notPicture = await putStill(videoKey, new Uint8Array(96).fill(1));
  const sent = await (await putStill(videoKey, stillJpeg)).json();
  r = await get('/api/submit/file?key=' + encodeURIComponent(videoKey) + '&thumb=1');
  check('a video with no still takes the encoder\'s, and its tile has a picture',
    none === 404 && notPicture.status === 400 && sent.stored === true &&
    r.status === 200 && (await bytesOf(r)).length === 96,
    [none, notPicture.status, JSON.stringify(sent), r.status].join(' '));
  bucket.set(t, { bytes: pageMade, meta: { contentType: 'image/jpeg' }, custom: {} });
}

r = await get(fileUrl(720), null, { range: 'bytes=0-99' });
check('a rendition scrubs like the original',
  r.status === 206 && r.headers.get('content-length') === '100', 'status=' + r.status);
r = await get('/api/submit/file?key=' + encodeURIComponent(photoKey) + '&res=480');
check('a photo has no renditions, so res is ignored and the clean copy answers',
  r.status === 200 && (await bytesOf(r)).length === PNG_CLEAN, 'status=' + r.status);

// falling up: a file that only has a 720p copy answers a request for 480
raw.prepare('DELETE FROM submission_renditions WHERE file_key = ? AND height = 480').run(videoKey);
r = await get(fileUrl(480));
check('res=480 with only a 720p copy falls back up to it', (await bytesOf(r)).length === 1500, '');
// a row whose object has gone falls through to the next thing down,
// and the original is not one of them
const ghost = raw.prepare('SELECT key FROM submission_renditions WHERE file_key = ?').get(videoKey).key;
bucket.delete(ghost);
r = await get(fileUrl(720));
const ghostBytes = (await bytesOf(r)).length;
check('a rendition row whose bytes are gone falls back down the chain, never to the original',
  r.status === 200 && ghostBytes !== clip.length, 'status=' + r.status + ' len=' + ghostBytes);
await SUBMIT.put(ghost, r720again, { httpMetadata: { contentType: 'video/mp4' } });
await putRendition(videoKey, 480, r480);

// the console reviewer gets the same fallback chain
r = await get('/api/console/file?key=' + encodeURIComponent(videoKey) + '&res=720', consoleSess);
check('the dashboard file endpoint takes res too', (await bytesOf(r)).length === 1500, '');

// ---------------- what the site is handed ----------------
r = await get('/api/submit/mine', teamSess);
sub = (await r.json()).submissions.find(s => s.id === subId);
vid = sub.media.find(m => m.key === videoKey);
check('the video carries its renditions, smallest first',
  JSON.stringify(vid.renditions) === '[480,720]', JSON.stringify(vid.renditions));
check('the photo carries none of it',
  sub.media.find(m => m.key === photoKey).renditions === undefined, '');

// ---------------- finish ----------------
r = await finish({ key: 'sub/1/nothing-here', heights: [480] });
check('finishing a file that is not there says so', r.status === 404, 'status=' + r.status);
r = await finish({ key: videoKey, heights: [480, 720], note: '', took_ms: 42000 });
d = await r.json();
check('finishing with heights marks the file done', r.status === 200 && d.ok && d.state === 'done', JSON.stringify(d));
check('and clears what that machine was working on, keeping its tally',
  JSON.stringify(raw.prepare('SELECT working_on, state, jobs_done, encode_ms FROM encoders WHERE name = ?').get(MAC)) ===
  JSON.stringify({ working_on: '', state: 'idle', jobs_done: 1, encode_ms: 42000 }),
  JSON.stringify(raw.prepare('SELECT * FROM encoders WHERE name = ?').get(MAC)));
r = await poll(null, KEY);
check('a finished video leaves the queue', (await r.json()).jobs.length === 0, '');
r = await claim(videoKey);
check('and cannot be claimed again', r.status === 409, 'status=' + r.status);

r = await get('/api/console/submissions?status=pending', consoleSess);
sub = (await r.json()).submissions.find(s => s.id === subId);
check('review stops saying it is encoding',
  sub.media.find(m => m.key === videoKey).encoding === undefined, '');

const logged = (await (await get('/api/console/log?limit=20', consoleSess)).json()).entries
  .filter(e => e.action === 'encode-done');
check('one encode-done row lands in the log, naming the machine',
  logged.length === 1 && logged[0].actor === 'encoder:' + MAC && logged[0].team_name === 'Galahs' &&
  logged[0].quest_code === '480p + 720p', JSON.stringify(logged));

// ---- a run that gave up must not vanish ----
{
  // A run that came back with nothing is recorded 'skipped'. That was
  // meant for a video that cannot be encoded, but it catches every
  // passing failure too — a closed laptop, a wrong key, a download
  // that broke — and it took the video out of the queue AND out of
  // every count, so a batch of them looked like videos that had
  // stopped existing.
  // The video is done already, and a finish with nothing made only lands
  // on a live claim, so it goes back on the pile to be claimed first.
  raw.prepare("UPDATE submission_files SET encode_state = '' WHERE r2_key = ?").run(videoKey);
  await jpost('/api/encoder/claim', { key: videoKey, name: 'studio-mac' }, 'encoder-secret');
  await jpost('/api/encoder/finish',
    { key: videoKey, heights: [], note: 'could not download the original', took_ms: 10, name: 'studio-mac' },
    'encoder-secret');
  const gaveUp = raw.prepare('SELECT encode_state FROM submission_files WHERE r2_key = ?').get(videoKey).encode_state;
  let stat = await (await get('/api/console/encoder/status', consoleSess)).json();
  check('a run that gave up is counted where someone will see it, not silently dropped',
    gaveUp === 'skipped' && stat.skipped >= 1, JSON.stringify({ gaveUp, skipped: stat.skipped }));
  let idle = await jpost('/api/encoder/poll', { name: 'studio-mac', state: 'idle' }, 'encoder-secret');
  const strandedAt = (await idle.json()).waiting;

  const retried = await (await jpost('/api/console/encoder/release', {}, consoleSess)).json();
  check('and retrying puts it back on the pile rather than leaving it stranded',
    retried.failed >= 1 &&
    raw.prepare('SELECT encode_state FROM submission_files WHERE r2_key = ?').get(videoKey).encode_state === '',
    JSON.stringify(retried));
  idle = await jpost('/api/encoder/poll', { name: 'studio-mac', state: 'idle' }, 'encoder-secret');
  check('so the next machine is offered it again',
    (await idle.json()).waiting > strandedAt, '');
  stat = await (await get('/api/console/encoder/status', consoleSess)).json();
  check('and nothing is left counted as given up', stat.skipped === 0, JSON.stringify(stat.skipped));
  // this video was already encoded before the block borrowed it; put
  // it back so the counts the rest of the suite reads still add up
  raw.prepare("UPDATE submission_files SET encode_state = 'done' WHERE r2_key = ?").run(videoKey);
}

// a second video, this one nothing could be made of
{
  const f = new FormData();
  f.append('quest', 'make 21');
  f.append('files', new File([new Uint8Array(512).fill(3)], 'broken.mp4', { type: 'video/mp4' }), 'broken.mp4');
  const cr = await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: f });
  const created = await cr.json();
  const brokenKey = raw.prepare('SELECT r2_key FROM submission_files WHERE submission_id = ?').get(created.id).r2_key;
  await claim(brokenKey);
  r = await finish({ key: brokenKey, heights: [], note: 'ffprobe found no video track', took_ms: 3000 });
  check('finishing with nothing marks the file skipped', (await r.json()).state === 'skipped', '');
  check('a skipped video does not count towards that machine\'s pace',
    raw.prepare('SELECT jobs_done, encode_ms FROM encoders WHERE name = ?').get(MAC).jobs_done === 1, '');
  r = await poll(null, KEY);
  check('a skipped video is not offered again either', (await r.json()).jobs.length === 0, '');
  const skipLog = (await (await get('/api/console/log?limit=20', consoleSess)).json()).entries
    .find(e => e.action === 'encode-done' && e.quest_code.indexOf('nothing made') === 0);
  check('the log says what went wrong',
    !!skipLog && /ffprobe found no video track/.test(skipLog.quest_code), JSON.stringify(skipLog && skipLog.quest_code));
}

// ---------------- what the dashboard shows ----------------
const status = async () => (await (await get('/api/console/encoder/status', consoleSess)).json());
r = await get('/api/console/encoder/status');
check('the encoder status needs a dashboard session', r.status === 401, 'status=' + r.status);
r = await get('/api/console/encoder/status', consoleSess);
d = await r.json();
const mac = d.encoders.find(e => e.name === MAC);
check('it lists every machine with the counts across all of them',
  r.status === 200 && d.ok && d.waiting === 0 && d.encoding === 0 && d.done === 1 &&
  d.encoders.length === 2, JSON.stringify(d));
check('this one is online and idle, with its tally and its pace',
  mac.online === true && mac.state === 'idle' && mac.jobs_done === 1 && mac.avg_ms === 42000,
  JSON.stringify(mac));

await poll({ state: 'encoding', working_on: videoKey }, KEY);
d = await status();
check('and names the file a machine is working on',
  d.encoders.find(e => e.name === MAC).working_name === 'clip.mp4', JSON.stringify(d.encoders));

// two machines, each with its own last call and its own state
await poll({ state: 'idle', working_on: '' }, KEY, null, 'kitchen-laptop');
d = await status();
check('both machines are listed, each with its own state',
  d.encoders.length === 2 &&
  d.encoders.find(e => e.name === 'kitchen-laptop').state === 'idle' &&
  d.encoders.find(e => e.name === MAC).state === 'encoding' &&
  d.encoders.every(e => e.online), JSON.stringify(d.encoders));
check('and the machine that has done nothing yet shows no pace',
  d.encoders.find(e => e.name === 'kitchen-laptop').jobs_done === 0 &&
  d.encoders.find(e => e.name === 'kitchen-laptop').avg_ms === 0, '');

raw.prepare("UPDATE encoders SET last_seen = datetime('now', '-5 minutes') WHERE name = ?").run(MAC);
d = await status();
check('a machine that stopped calling in reads as offline, last seen kept',
  d.encoders.find(e => e.name === MAC).online === false &&
  !!d.encoders.find(e => e.name === MAC).last_seen &&
  d.encoders.find(e => e.name === 'kitchen-laptop').online === true, JSON.stringify(d.encoders));

// a second finished video moves that machine's average
{
  const f = new FormData();
  f.append('quest', 'make 21');
  f.append('files', new File([new Uint8Array(256).fill(1)], 'waiting.mp4', { type: 'video/mp4' }), 'waiting.mp4');
  await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: f });
  d = await status();
  check('a new video shows up as waiting', d.waiting === 1, JSON.stringify({ waiting: d.waiting }));
  const answer = (await (await poll(null, KEY)).json());
  check('and is what a machine is offered next',
    answer.jobs.length === 1 && answer.jobs[0].name === 'waiting.mp4' && answer.waiting === 1,
    JSON.stringify(answer.jobs));
  const nextKey = answer.jobs[0].key;
  await claim(nextKey);
  await putRendition(nextKey, 480, new Uint8Array(300).fill(2));
  await finish({ key: nextKey, heights: [480], took_ms: 18000 });
  d = await status();
  check('the pace is the average over the videos that machine has done',
    d.encoders.find(e => e.name === MAC).jobs_done === 2 &&
    d.encoders.find(e => e.name === MAC).avg_ms === 30000, JSON.stringify(d.encoders));
  check('and sending a copy counts as calling in',
    d.encoders.find(e => e.name === MAC).online === true, '');
  check('the counts move with it', d.waiting === 0 && d.done === 2, JSON.stringify(d));
}

// ---------------- a half-uploaded video is not encodable yet ----------------
{
  raw.prepare(
    'INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name, status) ' +
    "VALUES (?, ?, 'video/mp4', ?, 'huge.mp4', 'uploading')"
  ).run(subId, 'sub/' + subId + '/still-coming', 60 * 1024 * 1024);
  const jobs = (await (await poll(null, KEY)).json()).jobs;
  check('a file whose slices are still coming is left out of the queue',
    !jobs.some(j => j.name === 'huge.mp4'), JSON.stringify(jobs.map(j => j.name)));
}

// ---------------- a copy too big for one request ----------------
// A long video's clean copy is the source repackaged, so it is the
// source's size, and a Workers request does not carry that. R2 takes
// it in slices and stitches them itself, the same way the phone's
// video reached the bucket in the first place.
{
  const PART = 20 * 1024 * 1024;
  const startUpload = (key, height, bytes) =>
    jpost('/api/encoder/upload/start', named({ key, height, bytes }), KEY);
  const sendSlice = (up, n, body, whole) => front(
    '/api/encoder/upload/part?' + new URLSearchParams({
      upload: up.upload, stored: up.stored, n: String(n), bytes: String(whole), name: MAC
    }),
    { method: 'PUT', headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/octet-stream' }, body }
  );
  const finishUpload = (body) => jpost('/api/encoder/upload/finish', named(body), KEY);
  const slice = new Uint8Array(PART).fill(11);   // one whole part, reused

  r = await startUpload('sub/1/nothing-here', 'clean', 1000);
  check('a sliced upload for a file that is not there is refused', r.status === 404, 'status=' + r.status);
  r = await startUpload(videoKey, 999, 1000);
  check('nor one for a height outside the buckets', r.status === 400, 'status=' + r.status);

  const whole = PART + 1234;
  const up = await (await startUpload(videoKey, 'clean', whole)).json();
  check('starting one says where the copy goes and how many slices to send',
    up.ok && up.stored === videoKey + '.c' && up.part_size === PART && up.parts === 2,
    JSON.stringify({ stored: up.stored, part_size: up.part_size, parts: up.parts }));

  r = await sendSlice(up, 2, new Uint8Array(999), whole);
  check('a slice that is not the size it should be is caught on the way in',
    r.status === 400 && /1234 bytes, got 999/.test((await r.json()).error), 'status=' + r.status);
  r = await sendSlice({ upload: up.upload, stored: 'rnd/not-a-key' }, 1, slice, whole);
  check('and a destination this endpoint never handed out is refused', r.status === 404, 'status=' + r.status);

  const p1 = await (await sendSlice(up, 1, slice, whole)).json();
  const p2 = await (await sendSlice(up, 2, new Uint8Array(1234).fill(22), whole)).json();
  check('both slices land, each with its own tag',
    p1.ok && p2.ok && !!p1.etag && !!p2.etag && p1.etag !== p2.etag, JSON.stringify([p1.etag, p2.etag]));

  r = await finishUpload({ key: videoKey, height: 'clean', upload: up.upload, stored: up.stored, bytes: whole, parts: [p1] });
  check('finishing without every slice says how many are missing',
    r.status === 409 && /1 of 2 slices/.test((await r.json()).error), 'status=' + r.status);

  d = await (await finishUpload({
    key: videoKey, height: 'clean', upload: up.upload, stored: up.stored, bytes: whole, parts: [p1, p2]
  })).json();
  check('with all of them it becomes one object the size of the whole copy',
    d.ok && d.clean === true && d.bytes === whole, JSON.stringify(d));
  const built = bucket.get(videoKey + '.c').bytes;
  check('which is the slices in order, end to end',
    built.length === whole && built[0] === 11 && built[PART - 1] === 11 &&
    built[PART] === 22 && built[whole - 1] === 22, String(built.length));
  r = await get('/api/submit/file?key=' + encodeURIComponent(videoKey) + '&res=original');
  check('and it is what the site serves at Original',
    r.status === 200 && (await bytesOf(r)).length === whole, 'status=' + r.status);

  // a rendition goes the same way, under a key of its own
  const rWhole = PART + 5;
  const rUp = await (await startUpload(videoKey, 1080, rWhole)).json();
  check('a rendition sliced the same way gets its own key, not the file\'s',
    /^rnd\/[A-Za-z0-9_-]{16}$/.test(rUp.stored), rUp.stored);
  const q1 = await (await sendSlice(rUp, 1, slice, rWhole)).json();
  const q2 = await (await sendSlice(rUp, 2, new Uint8Array(5).fill(4), rWhole)).json();
  d = await (await finishUpload({
    key: videoKey, height: 1080, upload: rUp.upload, stored: rUp.stored, bytes: rWhole, parts: [q1, q2]
  })).json();
  const row = raw.prepare('SELECT key, bytes FROM submission_renditions WHERE file_key = ? AND height = 1080').get(videoKey);
  check('and lands as a row like any copy sent whole',
    d.ok && d.height === 1080 && !!row && row.key === rUp.stored && row.bytes === rWhole,
    JSON.stringify(row));

  const dropped = await (await startUpload(videoKey, 720, PART + 1)).json();
  await sendSlice(dropped, 1, slice, PART + 1);
  r = await jpost('/api/encoder/upload/abort', named({ upload: dropped.upload, stored: dropped.stored }), KEY);
  check('a copy given up on part-way takes its slices with it',
    (await r.json()).ok === true && !multi.has(dropped.upload) && !bucket.has(dropped.stored), '');

  r = await front('/api/encoder/upload/start', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key: videoKey, height: 'clean', bytes: 10, name: MAC })
  });
  check('and none of these calls work without the encoder key', r.status === 401, 'status=' + r.status);
}

// ---------------- straight to R2 ----------------
// With the R2 token set, the runner reads the original from R2 and
// sends its copies there itself; the worker signs the addresses and
// joins the slices, and no video passes through it. The pretend R2
// checks every signature with code that is not the worker's and keeps
// its objects in this suite's bucket.
const r2 = pretendR2({
  store: {
    set(key, bytes, type) { bucket.set(key, { bytes, meta: { contentType: type }, custom: {} }); },
    get(key) { const hit = bucket.get(key); return hit ? { bytes: hit.bytes, type: hit.meta.contentType } : null; },
    delete(key) { bucket.delete(key); }
  }
});
const DIRECT = Object.assign({}, ENV, r2.env);
{
  const PART = 20 * 1024 * 1024;
  const bearer = { authorization: 'Bearer ' + KEY };
  const startUpload = (env, height, bytes) =>
    jpost('/api/encoder/upload/start', named({ key: videoKey, height, bytes }), KEY, env);
  const signSlice = (env, up, n) => front('/api/encoder/upload/sign?' + new URLSearchParams({
    upload: up.upload, stored: up.stored, n: String(n), name: MAC
  }), { headers: bearer }, env);

  let sr = await front('/api/encoder/source?key=' + encodeURIComponent(videoKey), { headers: bearer }, DIRECT);
  check('a runner that does not ask for an address is still sent the bytes',
    sr.status === 200 && (await bytesOf(sr)).length === clip.length, 'status=' + sr.status);
  sr = await front('/api/encoder/source?signed=1&key=' + encodeURIComponent(videoKey), { headers: bearer }, DIRECT);
  const src = await sr.json();
  const fromR2 = src.url ? await fetch(src.url) : null;
  const srcBytes = fromR2 ? Buffer.from(await fromR2.arrayBuffer()) : Buffer.alloc(0);
  check('one that asks is given a signed address on R2, uncached, that reads back the original',
    sr.status === 200 && (sr.headers.get('cache-control') || '').includes('no-store') &&
    new URL(src.url).host === HOST && fromR2.status === 200 && Buffer.compare(srcBytes, Buffer.from(clip)) === 0,
    JSON.stringify(src));

  const whole = PART + 99;
  const before = Object.assign({ mp: mpSeq }, r2.seen);
  const up = await (await startUpload(DIRECT, 1080, whole)).json();
  for (const [n, body] of [[1, new Uint8Array(PART).fill(31)], [2, new Uint8Array(99).fill(32)]]) {
    const s = await (await signSlice(DIRECT, up, n)).json();
    await fetch(s.url, { method: 'PUT', body });
  }
  r = await jpost('/api/encoder/upload/finish',
    named({ key: videoKey, height: 1080, upload: up.upload, stored: up.stored, bytes: whole }), KEY, DIRECT);
  d = await r.json();
  const row = raw.prepare('SELECT key, bytes FROM submission_renditions WHERE file_key = ? AND height = 1080').get(videoKey);
  const landed = bucket.get(up.stored);
  check('a copy started on R2, sent to the addresses the worker signs and joined there is recorded like any other',
    up.direct === true && d.ok && d.height === 1080 && row.key === up.stored && row.bytes === whole &&
    !!landed && landed.bytes.length === whole && landed.bytes[0] === 31 && landed.bytes[whole - 1] === 32 &&
    r2.seen.create === before.create + 1 && r2.seen.part === before.part + 2 &&
    r2.seen.complete === before.complete + 1 && mpSeq === before.mp,
    JSON.stringify({ up, d, row }));

  const viaR2 = await (await startUpload(DIRECT, 720, 5000)).json();
  const viaWorker = await (await startUpload(ENV, 720, 5000)).json();
  const part = await front('/api/encoder/upload/part?' + new URLSearchParams({
    upload: viaR2.upload, stored: viaR2.stored, n: '1', bytes: '5000', name: MAC
  }), {
    method: 'PUT', headers: Object.assign({ 'content-type': 'application/octet-stream' }, bearer),
    body: new Uint8Array(5000)
  }, DIRECT);
  const signed = await signSlice(DIRECT, viaWorker, 1);
  check('the two ways do not mix: a direct copy\'s slice is not taken through the worker, nor a worker copy\'s signed',
    part.status === 409 && signed.status === 409, 'part=' + part.status + ' sign=' + signed.status);
  await jpost('/api/encoder/upload/abort', named({ upload: viaWorker.upload, stored: viaWorker.stored }), KEY);

  const aborted = r2.seen.abort;
  r = await jpost('/api/encoder/upload/abort', named({ upload: viaR2.upload, stored: viaR2.stored }), KEY, DIRECT);
  check('a direct copy given up on part-way is dropped on R2',
    (await r.json()).ok === true && r2.seen.abort === aborted + 1 && !r2.uploads.has(viaR2.upload.slice(3)), '');
}

// ---------------- the runner and its launchers ----------------
// The launchers cannot be run here (no Mac, no Windows, no network),
// so what can be checked is that they parse and that the runner's own
// arithmetic is right.
{
  const runner = await import(BOT + '/scripts/encoder.mjs');
  check('the runner names a machine after itself, tidily',
    runner.cleanName('  Studio  MacBook.local ') === 'Studio MacBook' &&
    runner.cleanName('') === '' && runner.cleanName('x'.repeat(80)).length === 40,
    JSON.stringify(runner.cleanName('  Studio  MacBook.local ')));
  check('it never encodes a video larger than it came',
    JSON.stringify(runner.plan(2160).map(p => p.bucket)) === '[480,720,1080]' &&
    JSON.stringify(runner.plan(720).map(p => p.bucket)) === '[480,720]' &&
    JSON.stringify(runner.plan(360)) === '[{"bucket":480,"scale":360}]', '');
  check('and says what is waiting in plain words',
    runner.describeQueue(0, 0) === 'Nothing is waiting for encoding right now.' &&
    runner.describeQueue(1, 4 * 1024 * 1024) === '1 video is waiting for encoding (about 4 MB).' &&
    runner.describeQueue(3, 300 * 1024 * 1024) === '3 videos are waiting for encoding (about 300 MB).',
    runner.describeQueue(3, 300 * 1024 * 1024));

  // The sliced upload is the one piece of the runner that has to agree
  // with the worker call for call, so it is run against the real one:
  // a socket in front of the same handler the rest of this file drives.
  const { createServer } = await import('node:http');
  const { mkdtemp, rm, writeFile, readFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const listen = async (env) => {
    const server = createServer(async (req, res) => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const answer = await mod.default.fetch(new Request('http://127.0.0.1' + req.url, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks)
      }), env, ctx);
      res.writeHead(answer.status, Object.fromEntries(answer.headers));
      res.end(Buffer.from(await answer.arrayBuffer()));
    });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    return server;
  };
  {
    const server = await listen(ENV);
    const dir = await mkdtemp(join(tmpdir(), 'scs2-slice-'));
    const copy = join(dir, 'clean.mp4');
    const whole = 20 * 1024 * 1024 + 777;
    await writeFile(copy, Buffer.alloc(whole, 7));
    try {
      runner.connect('http://127.0.0.1:' + server.address().port + '/', KEY, 'slice-tester');
      const sent = await runner.uploadInSlices(videoKey, 'clean', copy, whole);
      const landed = bucket.get(videoKey + '.c').bytes;
      check('the runner sends a copy too big for one request in slices, and the worker rebuilds it',
        sent.ok && sent.bytes === whole && landed.length === whole &&
        landed[0] === 7 && landed[whole - 1] === 7, JSON.stringify(sent));

      const pageMade = bucket.get(videoKey + '.t');
      bucket.delete(videoKey + '.t');
      const still = join(dir, 'still.jpg');
      await writeFile(still, Buffer.from(thumbJpeg));
      const stillSent = await runner.sendStill(videoKey, still);
      check('and sends a still the worker takes where there is none',
        stillSent.stored === true && bucket.get(videoKey + '.t').bytes.length === thumbJpeg.length,
        JSON.stringify(stillSent));
      bucket.set(videoKey + '.t', pageMade);
    } finally {
      await rm(dir, { recursive: true, force: true });
      server.close();
    }
  }

  // The same runner against a worker with the R2 token: the original
  // comes from R2, and a copy small enough for one request goes back
  // there in slices too. Every request this process sends to R2 is
  // watched for the encoder key, which must stay with the worker.
  {
    const server = await listen(DIRECT);
    const dir = await mkdtemp(join(tmpdir(), 'scs2-r2-'));
    const keyed = [];
    const passOn = globalThis.fetch;
    globalThis.fetch = (input, init) => {
      const req = input instanceof Request ? input : null;
      const url = String(req ? req.url : input);
      const auth = new Headers((req && req.headers) || (init && init.headers) || {}).get('authorization') || '';
      if (new URL(url).host === HOST && (auth.includes(KEY) || url.includes(KEY))) keyed.push(url);
      return passOn(input, init);
    };
    try {
      runner.connect('http://127.0.0.1:' + server.address().port, KEY, 'r2-tester');
      const before = Object.assign({}, r2.seen);
      const original = join(dir, 'in');
      await runner.download(videoKey, original);
      const copy = join(dir, '480.mp4');
      await writeFile(copy, Buffer.alloc(3000, 5));
      const sent = await runner.upload(videoKey, 480, copy);
      const row = raw.prepare('SELECT key, bytes FROM submission_renditions WHERE file_key = ? AND height = 480').get(videoKey);
      check('the runner reads the original from R2 and sends even a small copy back there, and the worker records it',
        Buffer.compare(await readFile(original), Buffer.from(clip)) === 0 &&
        sent.ok && sent.height === 480 && row.bytes === 3000 && bucket.get(row.key).bytes.length === 3000 &&
        r2.seen.get === before.get + 1 && r2.seen.part === before.part + 1, JSON.stringify(sent));
      check('and never hands R2 the encoder key', keyed.length === 0, JSON.stringify(keyed));
    } finally {
      globalThis.fetch = passOn;
      await rm(dir, { recursive: true, force: true });
      server.close();
    }
  }

  const mac = spawnSync('bash', ['-n', BOT + '/scripts/scs-encoder.command']);
  check('the Mac launcher is valid bash', mac.status === 0, String(mac.stderr || ''));
  const cmd = readFileSync(BOT + '/scripts/scs-encoder.cmd', 'utf8');
  check('the Windows launcher has the labels its jumps look for',
    ['have_node', 'need_ffmpeg', 'have_ffmpeg', 'old_format', 'ask', 'saved', 'load',
      'bad_config', 'fail']
      .every(l => cmd.includes('\r\n:' + l + '\r\n') && cmd.includes('goto ' + l)), '');
  check('and ships with Windows line endings', cmd.indexOf('\r\n') !== -1, '');
  // a key is a password: it can hold any punctuation, and cmd reads an
  // unquoted echo and a for /f line as syntax
  check('it never puts the key on a cmd command line',
    !/echo\s+(ENCODER_KEY|TAB_API)/i.test(cmd) && !/for \/f[^\r\n]*CONFIG/i.test(cmd), '');
  check('and writes and reads it whole',
    cmd.includes('> "%KEY_FILE%" <nul set /p "=%TYPED_KEY%"') &&
    cmd.includes('< "%KEY_FILE%" set /p "ENCODER_KEY="') &&
    cmd.includes('< "%API_FILE%" set /p "TAB_API="'), '');

  const sh = readFileSync(BOT + '/scripts/scs-encoder.command', 'utf8');
  check('the Mac launcher does the same rather than sourcing its settings',
    !/^\s*\.\s+"\$[A-Z_]*CONFIG"/m.test(sh) &&
    sh.includes("printf '%s' \"$TYPED_KEY\" > \"$KEY_FILE\"") &&
    sh.includes('ENCODER_KEY="$(cat "$KEY_FILE"'), '');
  check('and both forget an older config file rather than parsing it',
    /del \/q "%OLD_CONFIG%"/.test(cmd) && /rm -f "\$OLD_CONFIG"/.test(sh), '');
}

r2.restore();
console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
