// Files sent from the phone straight to R2 (src/r2direct.ts): the
// worker signs, R2 holds the bytes, the worker joins and checks them.
//
// The signature is held to AWS's own published examples, and the
// pretend R2 below checks every request it is sent by working the
// signature out again with scripts/backup.mjs's node:crypto copy and a
// presigned-address check written here, not with the worker's own code
// — so a signature that is wrong in the same way on both sides cannot
// pass.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { pretendR2, drain, HOST } from './pretend-r2.mjs';
import { consoleSignIn } from './console-signin.mjs';

const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(BOT + '/src/index.ts');
const { signHeaders, presignUrl, sha256Hex } = await import(BOT + '/src/r2direct.ts');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

// ---------------- the signature ----------------
// "get-vanilla" from AWS's signature version 4 test suite, which
// verify-backup.mjs holds the backup script's copy to as well
{
  const empty = await sha256Hex('');
  const v = await signHeaders({
    method: 'GET', host: 'example.amazonaws.com', path: '/', query: {}, payloadHash: empty,
    now: new Date('2015-08-30T12:36:00Z'), region: 'us-east-1', service: 'service',
    keyId: 'AKIDEXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY'
  });
  check('a request signed in its headers matches AWS\'s published example',
    v.authorization === 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, ' +
      'SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31', v.authorization);
  // the presigned GET in Amazon S3's documentation
  const u = await presignUrl({
    method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', query: {},
    now: new Date('2013-05-24T00:00:00Z'), expires: 86400, region: 'us-east-1', service: 's3',
    keyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'
  });
  check('an address signed for a browser matches the presigned example in S3\'s documentation',
    new URL(u).searchParams.get('X-Amz-Signature') === 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404', u);
}

// ---------------- the worker, a bucket and a pretend R2 ----------------
const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };

// the account's R2 host, checking every signature it is sent, and the
// worker's binding over the same objects (tests/pretend-r2.mjs)
const r2 = pretendR2();
const { SUBMIT, bucket, seen } = r2;
const R2_ENV = r2.env;

const team = raw.prepare("SELECT id FROM teams WHERE name = 'Galahs'").get().id;
raw.prepare("INSERT INTO submit_sessions (token, team_id, expires_at) VALUES ('tok-direct', ?, datetime('now', '+1 day'))").run(team);
const workerHits = [];
function front(env, path, opts) {
  workerHits.push(path);
  return mod.default.fetch(new Request('https://bot.example' + path, opts), Object.assign({ DB: db, SUBMIT }, env), { waitUntil() {} });
}
const auth = { authorization: 'Bearer tok-direct' };
const getJ = async (env, path) => { const r = await front(env, path, { headers: auth }); return { status: r.status, data: await r.json() }; };
const postJ = async (env, path, body) => {
  const r = await front(env, path, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth), body: JSON.stringify(body) });
  return { status: r.status, data: await r.json() };
};
function manifest(list) {
  const f = new FormData();
  f.append('quest', 'make 21');
  f.append('whole', '1');
  f.append('bigfiles', JSON.stringify(list.map((x) => ({ name: x.name, type: x.type, size: x.bytes.length }))));
  return f;
}
const PART = 20 * 1024 * 1024;
function patterned(n, seed) { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * seed + 7) % 251; return b; }
function jpeg(n) { const b = patterned(n, 13); b.set([0xFF, 0xD8, 0xFF, 0xDA, 0, 2], 0); b.set([0xFF, 0xD9], n - 2); return b; }
// what the page does with one slice: ask for its address, send it there
async function sendSlice(env, fileId, n, bytes) {
  const s = await getJ(env, '/api/submit/upload/sign?file=' + fileId + '&n=' + n);
  if (s.status !== 200) return { status: s.status, url: '' };
  const r = await fetch(s.data.url, { method: 'PUT', body: bytes });
  return { status: r.status, url: s.data.url };
}

// ---------------- off until the secrets are set ----------------
{
  let m = await getJ({}, '/api/submit/upload/mode');
  check('without the R2 secrets the page is told to send through the worker',
    m.status === 200 && m.data.direct === false && m.data.part_size === PART, JSON.stringify(m.data));
  m = await getJ(Object.assign({}, R2_ENV, { R2_SECRET_ACCESS_KEY: 'PASTE that token\'s Secret Access Key' }), '/api/submit/upload/mode');
  check('a secret still reading PASTE counts as unset', m.data.direct === false, '');
  m = await getJ(R2_ENV, '/api/submit/upload/mode');
  check('with them it is told to send straight to R2', m.data.direct === true, '');
}

// ---------------- a video in two slices and a photo in one ----------------
{
  const video = { name: 'run.mp4', type: 'video/mp4', bytes: patterned(PART + 5 * 1024 * 1024, 3) };
  const photo = { name: 'sign.jpg', type: 'image/jpeg', bytes: jpeg(300 * 1024) };
  const before = workerHits.length;
  let r = await front(R2_ENV, '/api/submit/create', { method: 'POST', headers: auth, body: manifest([video, photo]) });
  const made = await r.json();
  check('the create carries no file and starts an R2 upload for each',
    r.status === 200 && made.ok && made.uploads.length === 2 && made.uploads.every((u) => u.direct === true) &&
    seen.create === 2 && seen.refused === 0, JSON.stringify(made));
  const [vid, pic] = made.uploads;

  let s = await sendSlice(R2_ENV, vid.file, 1, video.bytes.slice(0, PART));
  check('a slice goes to R2 at the address the worker signed', s.status === 200 && new URL(s.url).host === HOST && seen.part === 1, s.url);
  const tampered = s.url.replace('partNumber=1', 'partNumber=2');
  r = await fetch(tampered, { method: 'PUT', body: video.bytes.slice(PART) });
  check('an address changed after signing is refused', r.status === 403 && seen.refused === 1, 'status=' + r.status);

  let st = await getJ(R2_ENV, '/api/submit/upload/status?file=' + vid.file);
  check('picking it up again asks R2 which slices it already has', st.data.direct === true && JSON.stringify(st.data.parts) === '[1]', JSON.stringify(st.data));
  let fin = await postJ(R2_ENV, '/api/submit/upload/finish', { file: vid.file });
  check('finishing with a slice missing says how far it got', fin.status === 409 && /1 of 2/.test(fin.data.error), JSON.stringify(fin.data));
  s = await sendSlice(R2_ENV, vid.file, 2, video.bytes.slice(PART));
  fin = await postJ(R2_ENV, '/api/submit/upload/finish', { file: vid.file });
  const row = raw.prepare('SELECT r2_key, status, upload_id FROM submission_files WHERE id = ?').get(vid.file);
  const stored = bucket.get(row.r2_key);
  check('finishing joins the slices into the file, byte for byte, and marks it ready',
    fin.status === 200 && row.status === 'ready' && row.upload_id === null && stored &&
    stored.bytes.length === video.bytes.length && Buffer.compare(Buffer.from(stored.bytes), Buffer.from(video.bytes)) === 0 &&
    stored.meta.contentType === 'video/mp4', JSON.stringify({ fin: fin.data, row }));

  s = await sendSlice(R2_ENV, pic.file, 1, photo.bytes);
  fin = await postJ(R2_ENV, '/api/submit/upload/finish', { file: pic.file });
  const prow = raw.prepare('SELECT r2_key, status FROM submission_files WHERE id = ?').get(pic.file);
  check('a photo in one slice finishes with its metadata block read at once, and no second copy of it kept',
    fin.status === 200 && prow.status === 'ready' && bucket.has(prow.r2_key) && bucket.has(prow.r2_key + '.x') && !bucket.has(prow.r2_key + '.c'), JSON.stringify(fin.data));
  check('no slice of either file passed through the worker',
    !workerHits.slice(before).some((p) => p.indexOf('/upload/part') !== -1), JSON.stringify(workerHits.slice(before)));
}

// ---------------- what is not a photo is thrown away ----------------
{
  const fake = { name: 'not.jpg', type: 'image/jpeg', bytes: patterned(4096, 5) };
  let r = await front(R2_ENV, '/api/submit/create', { method: 'POST', headers: auth, body: manifest([fake]) });
  const made = await r.json();
  const f = made.uploads[0];
  await sendSlice(R2_ENV, f.file, 1, fake.bytes);
  const key = raw.prepare('SELECT r2_key FROM submission_files WHERE id = ?').get(f.file).r2_key;
  const fin = await postJ(R2_ENV, '/api/submit/upload/finish', { file: f.file });
  check('a "photo" whose first bytes are not one is refused once it lands, file and row gone',
    fin.status === 400 && !bucket.has(key) &&
    !raw.prepare('SELECT 1 FROM submission_files WHERE id = ?').get(f.file) &&
    !raw.prepare('SELECT 1 FROM submissions WHERE id = ?').get(made.id), JSON.stringify(fin.data));
}

// ---------------- giving up ----------------
{
  const clip = { name: 'clip.mp4', type: 'video/mp4', bytes: patterned(1024, 9) };
  let r = await front(R2_ENV, '/api/submit/create', { method: 'POST', headers: auth, body: manifest([clip]) });
  const f = (await r.json()).uploads[0];
  const aborted = seen.abort;
  const ab = await postJ(R2_ENV, '/api/submit/upload/abort', { file: f.file });
  check('abandoning a direct upload tells R2 to drop it', ab.status === 200 && seen.abort === aborted + 1, JSON.stringify(ab.data));
  const sg = await getJ(R2_ENV, '/api/submit/upload/sign?file=' + f.file + '&n=1');
  check('and no more slices can be signed for it', sg.status === 404, 'status=' + sg.status);
}

// ---------------- with the secrets unset, the same request goes through the worker ----------------
{
  const binding = new Map();
  const viaWorker = Object.assign({}, SUBMIT, {
    async createMultipartUpload(key) { binding.set(key, []); return { key, uploadId: 'w1' }; },
    resumeMultipartUpload(key) {
      return {
        async uploadPart(n, value) { binding.get(key).push(await drain(value)); return { partNumber: n, etag: 'w' + n }; },
        async complete() { bucket.set(key, { bytes: binding.get(key)[0], meta: {} }); return {}; },
        async abort() {}
      };
    }
  });
  const small = { name: 'small.mp4', type: 'video/mp4', bytes: patterned(2048, 11) };
  const r = await mod.default.fetch(new Request('https://bot.example/api/submit/create', { method: 'POST', headers: auth, body: manifest([small]) }),
    { DB: db, SUBMIT: viaWorker }, { waitUntil() {} });
  const made = await r.json();
  const f = made.uploads && made.uploads[0];
  const put = await mod.default.fetch(new Request('https://bot.example/api/submit/upload/part?file=' + f.file + '&n=1',
    { method: 'PUT', headers: auth, body: small.bytes }), { DB: db, SUBMIT: viaWorker }, { waitUntil() {} });
  const sg = await mod.default.fetch(new Request('https://bot.example/api/submit/upload/sign?file=' + f.file + '&n=1', { headers: auth }),
    { DB: db, SUBMIT: viaWorker }, { waitUntil() {} });
  check('without the secrets a whole-file manifest falls back to slices through the worker, and is never signed',
    r.status === 200 && f.direct === false && put.status === 200 && sg.status === 409, JSON.stringify({ made, put: put.status, sign: sg.status }));
}

// ---------------- an album open to anyone ----------------
// the same three steps behind the album's own routes, where the token
// the upload hands back is the whole credential
{
  raw.prepare("INSERT INTO albums (slug, name, adding) VALUES ('open-day', 'Open day', 'anyone')").run();
  const photo = jpeg(64 * 1024);
  const f = new FormData();
  f.append('a', 'open-day');
  f.append('whole', '1');
  f.append('bigfiles', JSON.stringify([{ name: 'crowd.jpg', type: 'image/jpeg', size: photo.length, w: 800, h: 600 }]));
  const before = { create: seen.create, part: seen.part, complete: seen.complete };
  let r = await front(R2_ENV, '/api/album/upload', { method: 'POST', body: f, headers: { 'cf-connecting-ip': '203.0.113.9' } });
  const made = await r.json();
  const u = made.uploads && made.uploads[0];
  const q = '?file=' + (u && u.file) + '&token=' + encodeURIComponent((u && u.token) || '');
  const signed = await front(R2_ENV, '/api/album/upload/sign' + q + '&n=1', {});
  const url = (await signed.json()).url;
  const put = await fetch(url, { method: 'PUT', body: photo });
  r = await front(R2_ENV, '/api/album/upload/finish', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: u.file, token: u.token }) });
  const fin = await r.json();
  const row = raw.prepare('SELECT r2_key, status FROM album_photos WHERE id = ?').get(u.file);
  check('an album photo goes to R2 the same way: started, sent to a signed address, joined and made ready',
    made.ok && u.direct === true && put.status === 200 && fin.ok === true && row.status === 'ready' &&
    bucket.has(row.r2_key) && bucket.get(row.r2_key).bytes.length === photo.length &&
    seen.create === before.create + 1 && seen.part === before.part + 1 && seen.complete === before.complete + 1,
    JSON.stringify({ made, fin, row }));
  const wrong = await front(R2_ENV, '/api/album/upload/sign?file=' + u.file + '&token=nope&n=1', {});
  check('no address is signed without the upload\'s token', wrong.status === 404, 'status=' + wrong.status);
  r = await front(R2_ENV, '/api/album/upload/mode', {});
  check('the album page can ask the mode without signing in', (await r.json()).direct === true, '');
}

// ---------------- the file a photo was picked as ----------------
// A HEIC or WebP the page made a JPEG of is named in the manifest, sent
// whole to an address the worker signs once the JPEG's slices are in,
// and read at finish: kept when it is what it says, thrown away when not.
{
  const ascii = (t) => [...t].map(c => c.charCodeAt(0));
  const heic = new Uint8Array([0, 0, 0, 24, ...ascii('ftypheic'), 0, 0, 0, 0, ...ascii('mif1heic'), ...patterned(4000, 7)]);
  const photo = jpeg(64 * 1024);
  const refused = seen.refused;
  const f = new FormData();
  f.append('a', 'open-day');
  f.append('whole', '1');
  f.append('bigfiles', JSON.stringify([{ name: 'IMG_0003.jpg', type: 'image/jpeg', size: photo.length, picked: { type: 'image/heic', size: heic.length } }]));
  const u = (await (await front(R2_ENV, '/api/album/upload', { method: 'POST', body: f, headers: { 'cf-connecting-ip': '203.0.113.9' } })).json()).uploads[0];
  const q = '?file=' + u.file + '&token=' + encodeURIComponent(u.token);
  await fetch((await (await front(R2_ENV, '/api/album/upload/sign' + q + '&n=1', {})).json()).url, { method: 'PUT', body: photo });
  const signed = await (await front(R2_ENV, '/api/album/upload/sign' + q + '&picked=1', {})).json();
  const sent = await fetch(signed.url, { method: 'PUT', body: heic });
  const fin = await front(R2_ENV, '/api/album/upload/finish', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: u.file, token: u.token }) });
  const row = raw.prepare('SELECT r2_key, status, picked_type FROM album_photos WHERE id = ?').get(u.file);
  const twin = bucket.get(row.r2_key + '.p');
  check('an album photo going straight to R2 names the file it was picked as, which goes whole to an address the worker signs and is kept once the finish has read it',
    u.picked === true && new URL(signed.url).host === HOST && sent.status === 200 && fin.status === 200 && row.status === 'ready' &&
    row.picked_type === 'image/heic' && !!twin && Buffer.from(twin.bytes).equals(Buffer.from(heic)) && seen.refused === refused,
    JSON.stringify({ u, row, sent: sent.status, fin: fin.status }));

  const g = new FormData();
  g.append('quest', 'make 21');
  g.append('whole', '1');
  g.append('bigfiles', JSON.stringify([
    { name: 'IMG_0004.jpg', type: 'image/jpeg', size: photo.length, picked: { type: 'image/webp', size: 3000 } },
    { name: 'IMG_0005.jpg', type: 'image/jpeg', size: photo.length }
  ]));
  const [a, b] = (await (await front(R2_ENV, '/api/submit/create', { method: 'POST', headers: auth, body: g })).json()).uploads;
  await sendSlice(R2_ENV, a.file, 1, photo);
  const s1 = await getJ(R2_ENV, '/api/submit/upload/sign?file=' + a.file + '&picked=1');
  await fetch(s1.data.url, { method: 'PUT', body: patterned(3000, 9) });
  const finA = await postJ(R2_ENV, '/api/submit/upload/finish', { file: a.file });
  const rowA = raw.prepare('SELECT r2_key, status, picked_type FROM submission_files WHERE id = ?').get(a.file);
  const noneNamed = await getJ(R2_ENV, '/api/submit/upload/sign?file=' + b.file + '&picked=1');
  check('proof whose picked file is not what the manifest said goes in without it, that file thrown away at finish; nothing is signed for a photo that named none',
    a.picked === true && !b.picked && s1.status === 200 && finA.status === 200 && rowA.status === 'ready' && rowA.picked_type === '' &&
    bucket.has(rowA.r2_key) && !bucket.has(rowA.r2_key + '.p') && noneNamed.status === 404,
    JSON.stringify({ a, b, finA: finA.data, rowA, noneNamed: noneNamed.status }));
  await postJ(R2_ENV, '/api/submit/upload/abort', { file: b.file });
}

// ---------------- an organiser replacing an album photo ----------------
// Straight to R2 the photo arrives under a key of its own, and at finish
// R2 copies it onto the old photo's key, the PNG it replaces copied to
// .p first: the bytes never pass through the worker.
{
  const ORG = Object.assign({}, R2_ENV, { CONSOLE_PASSWORD: 'tab-pass' });
  const jpost = (path, body) => front(ORG, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const admin = (await consoleSignIn(jpost, 'Alex', 'tab-pass')).session;
  const album = raw.prepare("SELECT id FROM albums WHERE slug = 'open-day'").get().id;
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...patterned(500, 3)]);
  bucket.set('alb/oldpngphoto1', { bytes: png, meta: { contentType: 'image/png' }, custom: {} });
  raw.prepare("INSERT INTO album_photos (album_id, r2_key, content_type, bytes, name) VALUES (?, 'alb/oldpngphoto1', 'image/png', ?, 'DSC_0042.png')").run(album, png.length);
  const photo = jpeg(64 * 1024);
  const f = new FormData();
  f.append('id', String(album));
  f.append('whole', '1');
  f.append('replace', '1');
  f.append('bigfiles', JSON.stringify([{ name: 'DSC_0042.jpg', type: 'image/jpeg', size: photo.length }]));
  const made = await (await front(ORG, '/api/console/album/upload', { method: 'POST', headers: { authorization: 'Bearer ' + admin }, body: f })).json();
  const u = made.uploads[0];
  const q = '?file=' + u.file + '&token=' + encodeURIComponent(u.token);
  await fetch((await (await front(ORG, '/api/album/upload/sign' + q + '&n=1', {})).json()).url, { method: 'PUT', body: photo });
  const copies = seen.copy;
  const hits = workerHits.length;
  const fin = await (await front(ORG, '/api/album/upload/finish', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ file: u.file, token: u.token }) })).json();
  const row = raw.prepare("SELECT * FROM album_photos WHERE r2_key = 'alb/oldpngphoto1'").get();
  check('an organiser\'s JPEG sent straight to R2 takes its PNG\'s place by copies inside R2: the PNG kept at .p, the key and row the same, the upload\'s own row gone',
    u.direct === true && u.replaces && u.replaces.png === true && fin.ok && fin.replaced && seen.copy === copies + 2 &&
    workerHits.length === hits + 1 && Buffer.from(bucket.get('alb/oldpngphoto1').bytes).equals(Buffer.from(photo)) &&
    Buffer.from(bucket.get('alb/oldpngphoto1.p').bytes).equals(Buffer.from(png)) &&
    row.content_type === 'image/jpeg' && row.picked_type === 'image/png' && row.version === 1 && row.name === 'DSC_0042.jpg' &&
    !raw.prepare('SELECT 1 FROM album_photos WHERE id = ?').get(u.file),
    JSON.stringify({ u, fin, copies: seen.copy - copies, row: row && [row.content_type, row.picked_type, row.version] }));
}

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
