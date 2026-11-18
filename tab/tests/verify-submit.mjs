// Run with: node tests/verify-submit.mjs   (needs Node 22+)
// Web submissions end to end against the real worker: team codes,
// team login, multipart uploads with every guard, the console review
// flow (list, file serving with ranges, accept, reject), and the
// integration seams — accepted submissions score like /submit, quest
// renames carry submissions along, CORS stays open for the site.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';

import { consoleSignIn } from './console-signin.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const mod = await import(BOT + '/src/index.ts');
const { promoteQueued, MAX_QUEUED } = await import(BOT + '/src/submit.ts');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);

// ---- R2 shim with range support ----
const bucket = new Map();
async function drain(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer()); // Blob/File
  const reader = value.getReader();
  const parts = [];
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    parts.push(chunk);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
const multi = new Map(); // uploadId -> { key, parts, meta }
let mpSeq = 0;
let failPut = null; // set to make the bucket refuse a write
const SUBMIT = {
  async put(key, value, opts) {
    if (failPut && failPut(key)) throw new Error('R2 refused the write');
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
        const chunks = parts.map(p => {
          const got = up.parts.get(p.partNumber);
          if (!got || got.etag !== p.etag) throw new Error('bad part list');
          return got.bytes;
        });
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let at = 0;
        for (const c of chunks) { out.set(c, at); at += c.length; }
        bucket.set(key, { bytes: out, meta: up.meta });
        multi.delete(uploadId);
        return { key, size: out.length };
      },
      async abort() { multi.delete(uploadId); }
    };
  },
  async delete(key) { bucket.delete(key); },
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
  }
};

globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };

const ENV = { DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass' };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token, extra) => front(path, { headers: Object.assign(token ? { authorization: 'Bearer ' + token } : {}, extra || {}) });

// ---------------- codes ----------------
let subSignIn = await consoleSignIn(jpost, 'Tab', 'tab-pass');
let r = { status: subSignIn.session ? 200 : 401, json: async () => subSignIn };
const consoleSess = (await r.json()).session;
r = await jpost('/api/console/codes/generate', {}, consoleSess);
let data = await r.json();
check('the console mints a code for every team', data.ok && data.minted === 43, JSON.stringify(data));
r = await jpost('/api/console/codes/generate', {}, consoleSess);
check('minting again is a no-op', (await r.json()).minted === 0, '');
r = await get('/api/console/codes', consoleSess);
data = await r.json();
const garb = data.codes.find(c => c.name === 'Galahs');
check('codes list every team, readable eight characters',
  data.codes.length === 43 && /^[A-HJ-NP-Z2-9]{8}$/.test(garb.code), garb && garb.code);

// ---------------- team login ----------------
r = await jpost('/api/submit/login', { team_name: 'No Such Team', code: garb.code });
check('an unknown team is refused without saying which half failed', r.status === 401, 'status=' + r.status);
r = await jpost('/api/submit/login', { team_name: 'Galahs', code: 'WRONGCOD' });
check('a wrong code is refused', r.status === 401, 'status=' + r.status);
r = await jpost('/api/submit/login', { team_name: 'galahs', code: garb.code });
data = await r.json();
const teamSess = data.session;
check('team name (any case) plus code signs the team in',
  r.status === 200 && data.team === 'Galahs' && /^[A-Za-z0-9_-]{20,}$/.test(teamSess || ''), '');
check('submit responses carry open CORS for the site',
  r.headers.get('access-control-allow-origin') === '*', '');

r = await front('/api/submit/mine', { method: 'OPTIONS' });
check('the preflight now allows POST with authorization',
  (r.headers.get('access-control-allow-methods') || '').includes('POST') &&
  (r.headers.get('access-control-allow-headers') || '').includes('authorization'), '');

// ---------------- create: guards ----------------
const file = (name, type, bytes) => new File([bytes], name, { type });
const form = (quest, note, files) => {
  const f = new FormData();
  f.append('quest', quest);
  f.append('note', note);
  for (const x of files) f.append('files', x, x.name);
  return f;
};
const send = (fd, token) => front('/api/submit/create', {
  method: 'POST',
  headers: token ? { authorization: 'Bearer ' + token } : {},
  body: fd
});

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

// A real JPEG, padded to whatever size a test wants, with a real EXIF
// block in it. The worker takes that block out before it serves the
// picture to anyone, so a fixture of arbitrary bytes would exercise
// none of the path that matters — it would only prove the worker
// refuses a file it cannot read.
const EXIF_BLOCK = [
  0x45, 0x78, 0x69, 0x66, 0, 0,             // "Exif\0\0"
  0x49, 0x49, 42, 0, 8, 0, 0, 0,            // little-endian TIFF, IFD0 at 8
  1, 0,                                      // one entry
  0x0F, 0x01, 2, 0, 6, 0, 0, 0, 26, 0, 0, 0, // Make, 6 bytes, at 26
  0, 0, 0, 0,                                // no next IFD
  0x41, 0x70, 0x70, 0x6C, 0x65, 0            // "Apple\0"
];
function jpegOf(totalBytes) {
  const head = [0xFF, 0xD8, 0xFF, 0xE1, ((EXIF_BLOCK.length + 2) >> 8) & 255, (EXIF_BLOCK.length + 2) & 255, ...EXIF_BLOCK];
  const scanHead = [0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 63, 0];
  const pad = Math.max(1, totalBytes - head.length - scanHead.length - 2);
  const out = new Uint8Array(head.length + scanHead.length + pad + 2);
  out.set(head, 0);
  out.set(scanHead, head.length);
  for (let i = 0; i < pad; i++) out[head.length + scanHead.length + i] = (i * 31) % 251;
  out.set([0xFF, 0xD9], out.length - 2);
  return out;
}
// what the same picture weighs once the block is gone
const STRIPPED = (n) => n - (EXIF_BLOCK.length + 4);
// A JPEG with nothing in it to take out, as a browser's canvas makes
// one: the previews must be real pictures now, and this one comes out
// of the stripper the size it went in.
function plainJpeg(totalBytes) {
  const out = new Uint8Array(totalBytes);
  out.set([0xFF, 0xD8, 0xFF, 0xDA, 0, 2], 0);
  for (let i = 6; i < totalBytes - 2; i++) out[i] = (i * 7) % 251;
  out.set([0xFF, 0xD9], totalBytes - 2);
  return out;
}
// A GIF that loops, with a comment and an XMP block in it saying where
// it was made. Both come out; the loop and the frame stay.
const ascii = (t) => [...t].map(c => c.charCodeAt(0));
const GIF_COMMENT = [0x21, 0xFE, 23, ...ascii('taken at -33.917,151.231'.slice(0, 23)), 0];
const GIF_XMP = [0x21, 0xFF, 11, ...ascii('XMP DataXMP'), 12, ...ascii('<x:gps 1,2/>'), 0];
const GIF_BYTES = new Uint8Array([
  ...ascii('GIF89a'), 1, 0, 1, 0, 0x80, 0, 0, 0, 0, 0, 255, 255, 255,
  0x21, 0xFF, 11, ...ascii('NETSCAPE2.0'), 3, 1, 0, 0, 0,
  ...GIF_COMMENT, ...GIF_XMP,
  0x21, 0xF9, 4, 0, 0, 0, 0, 0,
  0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0,
  0x3B
]);
const GIF_CLEAN = GIF_BYTES.length - GIF_COMMENT.length - GIF_XMP.length;
// the keys a submission's files were stored under, and everything
// stored beside them
async function forgetFiles(subId) {
  const rows = (await db.prepare('SELECT r2_key FROM submission_files WHERE submission_id = ?1').bind(subId).all()).results;
  for (const row of rows) for (const k of [...bucket.keys()]) if (k === row.r2_key || k.startsWith(row.r2_key + '.')) bucket.delete(k);
}
r = await send(form('S1', '', [file('a.png', 'image/png', png)]));
check('no session, no upload', r.status === 401, 'status=' + r.status);
r = await send(form('S999X', '', [file('a.png', 'image/png', png)]), teamSess);
check('an unknown quest is refused', r.status === 400, 'status=' + r.status);
r = await send(form('S1', '', []), teamSess);
check('no files, no submission', r.status === 400, 'status=' + r.status);
r = await send(form('S1', '', [1, 2, 3, 4, 5].map(i => file(i + '.png', 'image/png', png))), teamSess);
check('five files is one too many', r.status === 400, 'status=' + r.status);
r = await send(form('S1', '', [file('a.txt', 'text/plain', png)]), teamSess);
check('only photos and videos get through', r.status === 400, 'status=' + r.status);
r = await send(form('S1', '', [file('a.svg', 'image/svg+xml', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'))]), teamSess);
check('an SVG is not a photo: it is a document that can run script', r.status === 400, 'status=' + r.status);
r = await send(form('S1', '', [file('a.jpg', 'image/jpeg', new TextEncoder().encode('<html><script>1</script></html>'))]), teamSess);
check('and a file called a JPEG has to start like one', r.status === 400, 'status=' + r.status);
r = await send(form('S1', '', [file('big.mp4', 'video/mp4', new Uint8Array(49 * 1024 * 1024))]), teamSess);
check('a 49MB file is pointed at the compress page', r.status === 413, 'status=' + r.status);
r = await send(form('S1', '', [
  file('a.mp4', 'video/mp4', new Uint8Array(47 * 1024 * 1024)),
  file('b.mp4', 'video/mp4', new Uint8Array(47 * 1024 * 1024))
]), teamSess);
check('94MB combined is over the request budget', r.status === 413, 'status=' + r.status);

// ---------------- create: the real thing ----------------
r = await send(form('make 21', 'Both casinos in frame', [
  file('proof.png', 'image/png', png),
  file('clip.mp4', 'video/mp4', new Uint8Array(2048))
]), teamSess);
data = await r.json();
check('a good submission lands pending, quest code canonicalised',
  r.status === 200 && data.ok && data.quest === 'Make 21' && data.files === 2, JSON.stringify(data));

// ---------------- thumbnails ----------------
// the page sends a small browser-made preview per file; it lands next
// to the original under key.t and thumb=1 serves it, or falls back
{
  const f = new FormData();
  f.append('quest', 'make 21');
  const big = new File([jpegOf(2 * 1024 * 1024)], 'big.jpg', { type: 'image/jpeg' });
  const small = new File([plainJpeg(64)], 'thumb.jpg', { type: 'image/jpeg' });
  const noThumb = new File([jpegOf(1024)], 'plain.jpg', { type: 'image/jpeg' });
  const oversized = new File([plainJpeg(400 * 1024)], 'thumb.jpg', { type: 'image/jpeg' });
  const fourth = new File([plainJpeg(512)], 'y.jpg', { type: 'image/jpeg' });
  const notAPicture = new File([new Uint8Array(64).fill(3)], 'thumb.jpg', { type: 'image/jpeg' });
  const wrongTypeThumb = new File([new Uint8Array([9])], 'thumb.txt', { type: 'text/plain' });
  f.append('files', big, big.name);
  f.append('files', noThumb, noThumb.name);
  f.append('files', oversized, 'x.jpg');
  f.append('files', fourth, fourth.name);
  f.append('thumb0', small, 'thumb.jpg');
  f.append('thumb2', oversized, 'thumb.jpg');   // over the 300KB cap: ignored
  f.append('thumb3', wrongTypeThumb, 'thumb.txt'); // not an image: ignored
  f.append('thumb1', notAPicture, 'thumb.jpg');     // called a JPEG, is not one: ignored
  const tr = await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: f });
  const tdata = await tr.json();
  check('a submission with thumbnails is accepted', tr.status === 200 && tdata.files === 4, JSON.stringify(tdata));
  const withThumbs = [...bucket.keys()].filter(k => k.endsWith('.t'));
  check('only the valid thumbnail is stored (size and type capped)', withThumbs.length === 1, JSON.stringify(withThumbs));
  const rows2 = await db.prepare('SELECT r2_key FROM submission_files WHERE submission_id = ?1 ORDER BY id').bind(tdata.id).all();
  const keys2 = rows2.results.map(x => x.r2_key);
  let tf = await front('/api/submit/file?key=' + encodeURIComponent(keys2[0]) + '&thumb=1');
  check('thumb=1 serves the small copy', tf.status === 200 && (await tf.arrayBuffer()).byteLength === 64, 'status=' + tf.status);
  check('a stored file opened on its own is a sandboxed document the browser takes at its word',
    tf.headers.get('content-security-policy') === 'sandbox' && tf.headers.get('x-content-type-options') === 'nosniff', '');
  tf = await front('/api/submit/file?key=' + encodeURIComponent(keys2[1]) + '&thumb=1');
  check('a file with no thumbnail falls back to the whole picture, with its metadata gone',
    tf.status === 200 && (await tf.arrayBuffer()).byteLength === STRIPPED(1024), 'status=' + tf.status);
  tf = await front('/api/submit/file?key=' + encodeURIComponent(keys2[0]));
  check('and the plain URL is the clean copy too, never the file the camera wrote',
    tf.status === 200 && (await tf.arrayBuffer()).byteLength === STRIPPED(2 * 1024 * 1024), '');
  // The URL people copy out of a page is the one in its img tag, so a
  // photo pasted into Discord was embedding at thumbnail size. Asked
  // by an unfurler, the same URL answers with the whole picture.
  const unfurl = (path) => front(path, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' } });
  tf = await unfurl('/api/submit/file?key=' + encodeURIComponent(keys2[0]) + '&thumb=1');
  check('a link preview asking for the thumbnail is handed the whole picture instead',
    tf.status === 200 && (await tf.arrayBuffer()).byteLength === STRIPPED(2 * 1024 * 1024), 'status=' + tf.status);
  check('and that answer is not cached under the small URL',
    tf.headers.get('cache-control') === 'private, no-store', tf.headers.get('cache-control'));
  tf = await front('/api/submit/file?key=' + encodeURIComponent(keys2[0]) + '&thumb=1');
  check('while a browser asking the same URL still gets the small copy, cached for a year',
    (await tf.arrayBuffer()).byteLength === 64 && /immutable/.test(tf.headers.get('cache-control')), '');
  tf = await unfurl('/api/submit/file?key=' + encodeURIComponent(keys2[0]));
  check('the plain URL is unchanged for an unfurler: same bytes, same year-long cache',
    (await tf.arrayBuffer()).byteLength === STRIPPED(2 * 1024 * 1024) &&
    /immutable/.test(tf.headers.get('cache-control')), tf.headers.get('cache-control'));

  // The edge keeps a browser's plain ask for a small copy and answers the
  // next one from it, with the same headers; a range, a link preview and
  // a person opening the address are neither kept nor answered from it.
  {
    const kept = new Map();
    const keyOf = (k) => typeof k === 'string' ? k : k.url;
    const was = globalThis.caches;
    globalThis.caches = { default: {
      async match(k) { const h = kept.get(keyOf(k)); return h ? new Response(h.body, { headers: h.headers }) : undefined; },
      async put(k, res) { kept.set(keyOf(k), { body: await res.arrayBuffer(), headers: [...res.headers] }); },
      async delete(k) { return kept.delete(keyOf(k)); }
    } };
    const small = '/api/submit/file?key=' + encodeURIComponent(keys2[0]) + '&thumb=1';
    const plain = '/api/submit/file?key=' + encodeURIComponent(keys2[0]);
    const first = await front(small);
    await first.arrayBuffer();
    await new Promise(r => setTimeout(r, 20));
    const stored = bucket.get(keys2[0] + '.t');
    bucket.delete(keys2[0] + '.t');
    const again = await front(small);
    const againBytes = (await again.arrayBuffer()).byteLength;
    const previewBytes = (await (await unfurl(small)).arrayBuffer()).byteLength;
    bucket.set(keys2[0] + '.t', stored);
    const ranged = await front(small, { headers: { range: 'bytes=0-9' } });
    const opened = await front(plain, { headers: { 'sec-fetch-dest': 'document' } });
    await opened.arrayBuffer();
    await new Promise(r => setTimeout(r, 20));
    globalThis.caches = was;
    check('the edge answers a small copy asked again, and keeps nothing a range, a preview or a page ask is given',
      againBytes === 64 && again.headers.get('cache-control') === first.headers.get('cache-control') &&
      ranged.status === 206 && previewBytes === STRIPPED(2 * 1024 * 1024) &&
      [...kept.keys()].filter(k => !k.includes('/__photo-plan/')).length === 1,
      JSON.stringify({ againBytes, cc: again.headers.get('cache-control'), ranged: ranged.status, previewBytes, kept: [...kept.keys()] }));
  }
  // the shape the Discord posts link to: the key as a path, a name on the end
  tf = await front('/api/submit/file/' + keys2[0].split('/').map(encodeURIComponent).join('/') + '/proof.jpg');
  const madeUp = await front('/api/submit/file/sub/AAAAAAAAAAAAAAAA/proof.jpg');
  check('a file linked as a path with its name on the end is the same clean copy, and only for a real key',
    tf.status === 200 && (await tf.arrayBuffer()).byteLength === STRIPPED(2 * 1024 * 1024) && madeUp.status === 404,
    tf.status + ' ' + madeUp.status);
  // the original is still there, and the dashboard is the only way in
  tf = await get('/api/console/file?key=' + encodeURIComponent(keys2[0]), consoleSess);
  check('the dashboard still gets the original, metadata and all',
    tf.status === 200 && (await tf.arrayBuffer()).byteLength === 2 * 1024 * 1024, 'status=' + tf.status);
  // a download is that file handed over to be saved, under the name it was sent with
  tf = await front('/api/submit/file?key=' + encodeURIComponent(keys2[0]) + '&download=1');
  const dlTeam = { status: tf.status, bytes: (await tf.arrayBuffer()).byteLength, saved: tf.headers.get('content-disposition') };
  tf = await get('/api/console/file?key=' + encodeURIComponent(keys2[0]) + '&download=1', consoleSess);
  const dlDash = { status: tf.status, bytes: (await tf.arrayBuffer()).byteLength, saved: tf.headers.get('content-disposition') };
  check('a download is the clean copy from the site and the original from the dashboard, saved under the name it was sent with',
    dlTeam.bytes === STRIPPED(2 * 1024 * 1024) && /^attachment; filename="[^"]+\.jpg"/.test(dlTeam.saved || '') &&
    dlDash.bytes === 2 * 1024 * 1024 && /^attachment; filename="[^"]+\.jpg"/.test(dlDash.saved || ''),
    JSON.stringify({ dlTeam, dlDash }));
  tf = await get('/api/console/file/meta?key=' + encodeURIComponent(keys2[0]), consoleSess);
  const shot = await tf.json();
  check('and can read the camera out of the block that was taken off it',
    shot.ok && shot.has_exif && shot.make === 'Apple', JSON.stringify(shot));
  // this block leaves no trace: the rest of the suite counts submissions
  await forgetFiles(tdata.id);
  await db.prepare('DELETE FROM submission_files WHERE submission_id = ?1').bind(tdata.id).run();
  await db.prepare('DELETE FROM submissions WHERE id = ?1').bind(tdata.id).run();
}
// ---------------- the file a photo was picked as ----------------
// The HEIC a JPEG was made from rides with it as picked0 and is kept at
// .p. Review says so and the dashboard hands it over; the team's own
// file route never does; deleting the submission takes it.
{
  const heic = new Uint8Array([0, 0, 0, 24, ...ascii('ftypheic'), 0, 0, 0, 0, ...ascii('mif1heic'), ...new Array(300).fill(3)]);
  const f = new FormData();
  f.append('quest', 'make 21');
  f.append('files', new File([jpegOf(4096)], 'IMG_0007.jpg', { type: 'image/jpeg' }), 'IMG_0007.jpg');
  f.append('picked0', new Blob([heic], { type: 'image/heic' }), 'IMG_0007.HEIC');
  const pr = await (await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: f })).json();
  const key = (await db.prepare('SELECT r2_key FROM submission_files WHERE submission_id = ?1').bind(pr.id).first()).r2_key;
  const listed = (await (await get('/api/console/submissions', consoleSess)).json()).submissions.find(s => s.id === pr.id);
  const dash = await get('/api/console/file?key=' + encodeURIComponent(key) + '&picked=1', consoleSess);
  const dashBytes = Buffer.from(await dash.arrayBuffer());
  const teamAsk = await front('/api/submit/file?key=' + encodeURIComponent(key) + '&picked=1');
  check('the HEIC sent beside a JPEG is kept, Review says so, and the dashboard hands it over under its own type and name while the team\'s file route does not',
    pr.ok && listed && listed.media[0].picked === 'image/heic' && dash.status === 200 && dashBytes.equals(Buffer.from(heic)) &&
    dash.headers.get('content-type') === 'image/heic' && /^attachment; filename="IMG_0007\.heic"/.test(dash.headers.get('content-disposition') || '') &&
    teamAsk.status === 404,
    JSON.stringify({ media: listed && listed.media, dash: dash.status, saved: dash.headers.get('content-disposition'), team: teamAsk.status }));
  const del = await jpost('/api/console/submissions/delete', { id: pr.id, note: 'test' }, consoleSess);
  check('deleting the submission takes the file it was picked as with the rest',
    del.status === 200 && !bucket.has(key) && !bucket.has(key + '.p'), 'status=' + del.status);
  await db.prepare('DELETE FROM submissions WHERE id = ?1').bind(pr.id).run();
}

// ---------------- viewing copies ----------------
// the page also sends a ~1920px copy of each photo; it lands under
// key.v and any res short of the original serves it, so the lightbox
// and slideshow stop pulling multi-megabyte originals
{
  const f = new FormData();
  f.append('quest', 'make 21');
  const photo = new File([jpegOf(3 * 1024 * 1024)], 'photo.jpg', { type: 'image/jpeg' });
  const plain = new File([jpegOf(2048)], 'plain.jpg', { type: 'image/jpeg' });
  const view = new File([plainJpeg(8 * 1024)], 'view.jpg', { type: 'image/jpeg' });
  const tooBig = new File([new Uint8Array(3 * 1024 * 1024).fill(2)], 'view.jpg', { type: 'image/jpeg' });
  const wrongType = new File([new Uint8Array([7])], 'view.txt', { type: 'text/plain' });
  f.append('files', photo, photo.name);
  f.append('files', plain, plain.name);
  f.append('view0', view, 'view.jpg');
  f.append('view1', tooBig, 'view.jpg');   // over the 2MB cap: ignored
  f.append('view2', wrongType, 'view.txt'); // not an image (and no third file): ignored
  const vr = await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: f });
  const vdata = await vr.json();
  check('a submission with a viewing copy is accepted', vr.status === 200 && vdata.files === 2, JSON.stringify(vdata));
  const withViews = [...bucket.keys()].filter(k => k.endsWith('.v'));
  check('only the valid viewing copy is stored (size and type capped)', withViews.length === 1, JSON.stringify(withViews));
  const vrows = await db.prepare('SELECT r2_key FROM submission_files WHERE submission_id = ?1 ORDER BY id').bind(vdata.id).all();
  const vkeys = vrows.results.map(x => x.r2_key);
  let vf = await front('/api/submit/file?key=' + encodeURIComponent(vkeys[0]) + '&res=720');
  check('any res short of the original serves the viewing copy',
    vf.status === 200 && (await vf.arrayBuffer()).byteLength === 8 * 1024, 'status=' + vf.status);
  vf = await front('/api/submit/file?key=' + encodeURIComponent(vkeys[0]) + '&res=original');
  check('res=original means the whole picture at full size — with the metadata off it',
    (await vf.arrayBuffer()).byteLength === STRIPPED(3 * 1024 * 1024), '');
  vf = await front('/api/submit/file?key=' + encodeURIComponent(vkeys[0]));
  check('and so does no res at all', (await vf.arrayBuffer()).byteLength === STRIPPED(3 * 1024 * 1024), '');
  vf = await front('/api/submit/file?key=' + encodeURIComponent(vkeys[1]) + '&res=720');
  check('a photo with no viewing copy falls back to the clean one, still not the original',
    vf.status === 200 && (await vf.arrayBuffer()).byteLength === STRIPPED(2048), 'status=' + vf.status);
  // this block leaves no trace either
  await forgetFiles(vdata.id);
  await db.prepare('DELETE FROM submission_files WHERE submission_id = ?1').bind(vdata.id).run();
  await db.prepare('DELETE FROM submissions WHERE id = ?1').bind(vdata.id).run();
}
// ---------------- a GIF is never served as a still ----------------
// A browser can only draw one frame of a GIF onto a canvas, so both
// small copies would be a still of an animation. Neither is kept, and
// neither is reached for: the clean copy serves whatever is asked —
// with the comment and the XMP block out of it, which a GIF can carry
// as well as any photo.
{
  const f = new FormData();
  f.append('quest', 'make 21');
  const gif = new File([GIF_BYTES], 'wave.gif', { type: 'image/gif' });
  f.append('files', gif, gif.name);
  f.append('thumb0', new File([plainJpeg(64)], 't.jpg', { type: 'image/jpeg' }), 't.jpg');
  f.append('view0', new File([plainJpeg(512)], 'v.jpg', { type: 'image/jpeg' }), 'v.jpg');
  const gr = await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: f });
  const gdata = await gr.json();
  check('a submission with a GIF is accepted', gr.status === 200 && gdata.files === 1, JSON.stringify(gdata));
  const grow = await db.prepare('SELECT r2_key FROM submission_files WHERE submission_id = ?1').bind(gdata.id).first();
  check('neither small copy is stored beside a GIF',
    !bucket.has(grow.r2_key + '.t') && !bucket.has(grow.r2_key + '.v'), grow.r2_key);
  let gf = await front('/api/submit/file?key=' + encodeURIComponent(grow.r2_key) + '&thumb=1');
  const served = new Uint8Array(await gf.arrayBuffer());
  const text = new TextDecoder('latin1').decode(served);
  check('thumb=1 on a GIF serves the whole GIF, without its comment or its XMP',
    gf.status === 200 && served.length === GIF_CLEAN && !/taken at|XMP|gps/.test(text) && /NETSCAPE2\.0/.test(text) && served[served.length - 1] === 0x3B,
    'status=' + gf.status + ' len=' + served.length);
  gf = await front('/api/submit/file?key=' + encodeURIComponent(grow.r2_key) + '&res=720');
  check('and so does a smaller res', (await gf.arrayBuffer()).byteLength === GIF_CLEAN, '');
  // this block leaves no trace either
  await forgetFiles(gdata.id);
  await db.prepare('DELETE FROM submission_files WHERE submission_id = ?1').bind(gdata.id).run();
  await db.prepare('DELETE FROM submissions WHERE id = ?1').bind(gdata.id).run();
}
// ---------------- the image stripper leaves video alone ----------------
// It reads JPEG and PNG and nothing else. A video that went through it
// would come out as bytes it had guessed at, so the guard is that it
// never sees one: no clean copy and no metadata block are written for
// a video at upload, and the encoder is what makes its clean copy.
{
  const f = new FormData();
  f.append('quest', 'make 21');
  const clip = new File([new Uint8Array(9000).fill(3)], 'clip.mp4', { type: 'video/mp4' });
  f.append('files', clip, clip.name);
  const vr = await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: f });
  const vd = await vr.json();
  const vkey = (await db.prepare('SELECT r2_key FROM submission_files WHERE submission_id = ?1').bind(vd.id).first()).r2_key;
  check('a video gets no clean copy and no metadata block from the image stripper',
    !bucket.has(vkey + '.c') && !bucket.has(vkey + '.x') &&
    bucket.get(vkey).bytes.length === 9000, vkey);
  // the encoder's copy of a video is what plays, so the tidy leaves it
  bucket.set(vkey + '.c', { bytes: new Uint8Array(1200).fill(5), meta: { contentType: 'video/mp4' }, custom: {} });
  const sweep = await jpost('/api/console/files/reclean', { after: 0 }, consoleSess);
  check('and the dashboard\'s tidy leaves a video\'s encoded copy where it is',
    (await sweep.json()).ok && bucket.has(vkey + '.c') && bucket.get(vkey).bytes.length === 9000, '');
  await forgetFiles(vd.id);
  await db.prepare('DELETE FROM submission_files WHERE submission_id = ?1').bind(vd.id).run();
  await db.prepare('DELETE FROM submissions WHERE id = ?1').bind(vd.id).run();
}

// ---------------- photos cut as they are served ----------------
// A photo is stored once, as it arrived, with the block that came out
// of it beside it; what is served is cut as it streams. The cleaned
// copies photos used to be served from are deleted by the dashboard's
// tidy, a bounded batch at a time.
{
  const f = new FormData();
  f.append('quest', 'make 21');
  const shot = new File([jpegOf(4096)], 'turned.jpg', { type: 'image/jpeg' });
  f.append('files', shot, shot.name);
  const rr = await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: f });
  const rdata = await rr.json();
  const rkey = (await db.prepare('SELECT r2_key FROM submission_files WHERE submission_id = ?1').bind(rdata.id).first()).r2_key;
  const rf = await front('/api/submit/file?key=' + encodeURIComponent(rkey));
  check('a photo is stored once with its metadata block, and served cut, its orientation put back',
    !bucket.has(rkey + '.c') && bucket.has(rkey + '.x') && bucket.get(rkey).bytes.length === jpegOf(4096).length &&
    rf.status === 200 && (await rf.arrayBuffer()).byteLength === STRIPPED(4096), 'status=' + rf.status);

  // a copy left from before
  bucket.set(rkey + '.c', { bytes: new Uint8Array([1, 2, 3]), meta: { contentType: 'image/jpeg' }, custom: {} });
  let after = 0;
  let removed = 0;
  let rounds = 0;
  let biggest = 0;
  let moved = false;
  for (;;) {
    const sweep = await jpost('/api/console/files/reclean', { after }, consoleSess);
    const sdata = await sweep.json();
    removed += sdata.removed;
    if (sdata.after > after) moved = true;
    biggest = Math.max(biggest, sdata.checked);
    after = sdata.after;
    rounds++;
    if (sdata.done || rounds > 40) break;
  }
  const afterTidy = await front('/api/submit/file?key=' + encodeURIComponent(rkey));
  check('the dashboard\'s tidy deletes the old cleaned copy, a bounded batch at a time, and the photo still serves cut',
    removed >= 1 && moved && biggest <= 12 && !bucket.has(rkey + '.c') &&
    afterTidy.status === 200 && (await afterTidy.arrayBuffer()).byteLength === STRIPPED(4096),
    JSON.stringify({ removed, rounds, biggest, moved }));

  // pressing it again finds nothing
  let again = 0;
  after = 0;
  for (;;) {
    const sweep = await jpost('/api/console/files/reclean', { after }, consoleSess);
    const sdata = await sweep.json();
    again += sdata.removed;
    after = sdata.after;
    if (sdata.done) break;
  }
  check('and pressing it a second time deletes nothing', again === 0, String(again));

  await forgetFiles(rdata.id);
  await db.prepare('DELETE FROM submission_files WHERE submission_id = ?1').bind(rdata.id).run();
  await db.prepare('DELETE FROM submissions WHERE id = ?1').bind(rdata.id).run();
}

// ---------------- large files: uploads in slices ----------------
// a file over 48MB is registered at create time — the tab team sees
// the submission at once, marked still uploading — and its bytes
// follow in 20MB slices; a broken upload resumes from the slices the
// worker already holds
{
  const PART = 20 * 1024 * 1024;
  const bigBytes = new Uint8Array(50 * 1024 * 1024);
  for (let i = 0; i < bigBytes.length; i += 1024 * 1024) bigBytes[i] = (i / (1024 * 1024)) % 251;
  bigBytes[bigBytes.length - 1] = 77;
  const lf = new FormData();
  lf.append('quest', 'make 21');
  lf.append('files', file('small.png', 'image/png', png), 'small.png');
  lf.append('bigfiles', JSON.stringify([{ name: 'big clip.mp4', type: 'video/mp4', size: bigBytes.length }]));
  lf.append('bigthumb0', new File([plainJpeg(64)], 'thumb.jpg', { type: 'image/jpeg' }), 'thumb.jpg');
  let lr = await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: lf });
  let ldata = await lr.json();
  check('a large file is registered at create time',
    lr.status === 200 && ldata.ok && ldata.files === 2 && ldata.uploads.length === 1 &&
    ldata.uploads[0].part_size === PART && ldata.uploads[0].size === bigBytes.length, JSON.stringify(ldata));
  const bigSubId = ldata.id;
  const upFile = ldata.uploads[0].file;

  lr = await get('/api/console/submissions?status=pending', consoleSess);
  ldata = await lr.json();
  const lsub = ldata.submissions.find(s => s.id === bigSubId);
  const upMedia = lsub && lsub.media.find(m => m.uploading);
  check('the tab team sees it at once, the large file marked uploading',
    !!lsub && lsub.media.length === 2 && !!upMedia && upMedia.bytes === bigBytes.length,
    JSON.stringify(lsub && lsub.media));
  lr = await front('/api/submit/file?key=' + encodeURIComponent(upMedia.key) + '&thumb=1');
  check('its preview serves while the slices are still coming',
    lr.status === 200 && (await lr.arrayBuffer()).byteLength === 64, 'status=' + lr.status);
  lr = await front('/api/submit/file?key=' + encodeURIComponent(upMedia.key));
  check('the full file does not serve yet', lr.status === 404, 'status=' + lr.status);

  const putPart = (id, n, bytes, token) => front('/api/submit/upload/part?file=' + id + '&n=' + n, {
    method: 'PUT', headers: { authorization: 'Bearer ' + (token || teamSess) }, body: bytes
  });

  lr = await putPart(upFile, 1, bigBytes.slice(0, PART - 5));
  check('a slice of the wrong size is refused', lr.status === 400, 'status=' + lr.status);
  lr = await putPart(upFile, 4, bigBytes.slice(0, PART));
  check('a slice number past the end is refused', lr.status === 400, 'status=' + lr.status);
  const codes2 = await (await get('/api/console/codes', consoleSess)).json();
  const other = codes2.codes.find(c => c.name !== 'Galahs');
  const otherSess = (await (await jpost('/api/submit/login', { team_name: other.name, code: other.code })).json()).session;
  lr = await putPart(upFile, 1, bigBytes.slice(0, PART), otherSess);
  check("another team's session cannot send slices", lr.status === 404, 'status=' + lr.status);
  lr = await get('/api/submit/upload/status?file=' + upFile, otherSess);
  check("or read the upload's progress", lr.status === 404, 'status=' + lr.status);

  lr = await putPart(upFile, 3, bigBytes.slice(2 * PART));
  check('the last, short slice lands', lr.status === 200, 'status=' + lr.status);
  lr = await putPart(upFile, 1, bigBytes.slice(0, PART));
  check('slices land out of order', lr.status === 200, 'status=' + lr.status);
  lr = await jpost('/api/submit/upload/finish', { file: upFile }, teamSess);
  check('finish with a slice missing says how far it got',
    lr.status === 409 && /2 of 3/.test((await lr.json()).error), 'status=' + lr.status);
  lr = await get('/api/submit/upload/status?file=' + upFile, teamSess);
  ldata = await lr.json();
  check('status lists the landed slices for resume',
    ldata.ok && ldata.part_size === PART && JSON.stringify(ldata.parts) === '[1,3]', JSON.stringify(ldata));
  await putPart(upFile, 2, bigBytes.slice(PART, 2 * PART));
  lr = await jpost('/api/submit/upload/finish', { file: upFile }, teamSess);
  ldata = await lr.json();
  check('the last slice completes the file', lr.status === 200 && ldata.done === true, JSON.stringify(ldata));

  // the slices really did reassemble: read it back from the one
  // endpoint that still hands over an original
  lr = await get('/api/console/file?key=' + encodeURIComponent(upMedia.key), consoleSess);
  const gotBytes = new Uint8Array(await lr.arrayBuffer());
  check('the whole file serves to the dashboard, byte for byte',
    lr.status === 200 && lr.headers.get('content-type') === 'video/mp4' &&
    gotBytes.length === bigBytes.length && gotBytes[41 * 1024 * 1024] === 41 && gotBytes[gotBytes.length - 1] === 77,
    'len=' + gotBytes.length);
  // and the public endpoint does not, because nothing has taken the
  // location out of it yet — that is the encoder's job
  lr = await front('/api/submit/file?key=' + encodeURIComponent(upMedia.key));
  check('but nobody else gets it until the encoder has cleaned it',
    lr.status === 200 && (await lr.arrayBuffer()).byteLength === 64, 'status=' + lr.status);
  lr = await get('/api/submit/upload/status?file=' + upFile, teamSess);
  check('status answers done afterwards', (await lr.json()).done === true, '');
  lr = await get('/api/console/submissions?status=pending', consoleSess);
  ldata = await lr.json();
  const lsub2 = ldata.submissions.find(s => s.id === bigSubId);
  check('review no longer marks it uploading', !!lsub2 && lsub2.media.every(m => !m.uploading), '');

  // giving up takes the file, and a submission left with nothing goes too
  const af = new FormData();
  af.append('quest', 'make 21');
  af.append('bigfiles', JSON.stringify([{ name: 'huge.mp4', type: 'video/mp4', size: 60 * 1024 * 1024 }]));
  lr = await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: af });
  ldata = await lr.json();
  const abortSub = ldata.id;
  lr = await jpost('/api/submit/upload/abort', { file: ldata.uploads[0].file }, teamSess);
  check('a discarded upload is aborted', (await lr.json()).ok === true, '');
  const gone = await db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE id = ?1').bind(abortSub).first();
  check('a submission that only held the discarded file goes with it', gone.n === 0, JSON.stringify(gone));

  const of = new FormData();
  of.append('quest', 'make 21');
  of.append('bigfiles', JSON.stringify([{ name: 'x.mp4', type: 'video/mp4', size: 5 * 1024 * 1024 * 1024 }]));
  lr = await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: of });
  check('a 5GB file is over the ceiling', lr.status === 413, 'status=' + lr.status);

  // no trace: the rest of the suite counts submissions
  await forgetFiles(bigSubId);
  await db.prepare('DELETE FROM submission_upload_parts WHERE 1 = 1').run();
  await db.prepare('DELETE FROM submission_files WHERE submission_id = ?1').bind(bigSubId).run();
  await db.prepare('DELETE FROM submissions WHERE id = ?1').bind(bigSubId).run();
  await db.prepare('DELETE FROM submit_sessions WHERE token = ?1').bind(otherSess).run();
}

// ---------------- a bucket that fails part way ----------------
// The files go in before the rows, and the rows go in together, so a
// write that fails part way leaves no pending submission with no proof
// in it counting against the team, and nothing stranded in the bucket.
{
  const subsBefore = raw.prepare('SELECT COUNT(*) AS n FROM submissions').get().n;
  const keysBefore = bucket.size;
  let originals = 0;
  failPut = (key) => !/\.[a-z]$/.test(key) && ++originals === 2; // the first file lands, the second does not
  const fr = await send(form('make 21', '', [file('a.png', 'image/png', png), file('b.png', 'image/png', png)]), teamSess);
  failPut = null;
  check('a bucket that fails part way leaves no submission and nothing in the bucket',
    fr.status === 500 && raw.prepare('SELECT COUNT(*) AS n FROM submissions').get().n === subsBefore && bucket.size === keysBefore,
    JSON.stringify({ status: fr.status, keys: bucket.size - keysBefore }));
}

check('gallery defaults to off', data.gallery === 0, JSON.stringify(data));
const subId = data.id;
const keys = [...bucket.keys()].filter(k => !/\.[a-z]$/.test(k));
check('the files sit in R2 under random sub/ keys with their types',
  keys.length === 2 && keys.every(k => /^sub\/[\w-]{16}$/.test(k)) &&
  bucket.get(keys[0]).meta.contentType === 'image/png', JSON.stringify(keys));

r = await get('/api/submit/mine', teamSess);
data = await r.json();
check('the team sees its submission pending with 2 files',
  data.team === 'Galahs' && data.submissions.length === 1 &&
  data.submissions[0].status === 'pending' && data.submissions[0].files === 2, JSON.stringify(data.submissions));
check('mine carries media keys and the gallery flag',
  data.submissions[0].media.length === 2 &&
  data.submissions[0].media.every(m => keys.includes(m.key)) &&
  data.submissions[0].gallery === 0, JSON.stringify(data.submissions[0].media));

// ---------------- console review ----------------
r = await get('/api/console/submissions?status=pending', consoleSess);
data = await r.json();
const make21Points = raw.prepare("SELECT points FROM quests WHERE code = 'Make 21'").get().points;
check('review lists the pending submission with team, points and files',
  data.submissions.length === 1 && data.submissions[0].team_name === 'Galahs' &&
  data.submissions[0].points === make21Points && data.submissions[0].media.length === 2,
  JSON.stringify({ points: data.submissions[0] && data.submissions[0].points }));
const fileKey = data.submissions[0].media[1].key;

r = await get('/api/console/file?key=' + encodeURIComponent(fileKey));
check('proof files need a console session', r.status === 401, 'status=' + r.status);
r = await get('/api/console/file?key=' + encodeURIComponent(fileKey), consoleSess);
check('the reviewer streams the file with its type',
  r.status === 200 && r.headers.get('content-type') === 'video/mp4' &&
  r.headers.get('content-length') === '2048' && r.headers.get('accept-ranges') === 'bytes', '');
r = await get('/api/console/file?key=' + encodeURIComponent(fileKey), consoleSess, { range: 'bytes=100-299' });
check('range requests come back 206 so videos scrub',
  r.status === 206 && r.headers.get('content-range') === 'bytes 100-299/2048' &&
  r.headers.get('content-length') === '200', r.headers.get('content-range'));
r = await get('/api/console/file?key=' + encodeURIComponent(fileKey), null, { cookie: 'scs_console=' + consoleSess });
check('media tags stream files on the session cookie alone',
  r.status === 200 && r.headers.get('content-length') === '2048', 'status=' + r.status);
r = await get('/api/console/file?key=' + encodeURIComponent(fileKey), null, { cookie: 'scs_console=stale-token' });
check('a stale cookie is refused', r.status === 401, 'status=' + r.status);
r = await get('/api/console/submissions?status=pending', null, { cookie: 'scs_console=' + consoleSess });
check('the cookie unlocks nothing but the file endpoint', r.status === 401, 'status=' + r.status);
r = await get('/api/console/file?key=../secrets', consoleSess);
check('keys outside sub/ are refused', r.status === 404, 'status=' + r.status);

// ---------------- the team-facing file endpoint ----------------
r = await get('/api/submit/file?key=' + encodeURIComponent(fileKey));
check('a video the encoder has not reached is not handed out at all',
  r.status === 404, 'status=' + r.status);
// once the clean copy exists — the encoder puts it there — it is what
// answers, and it scrubs like any video
bucket.set(fileKey + '.c', { bytes: new Uint8Array(1500).fill(4), meta: { contentType: 'video/mp4' } });
r = await get('/api/submit/file?key=' + encodeURIComponent(fileKey));
check('teams and the gallery fetch files by their unguessable key alone',
  r.status === 200 && r.headers.get('content-length') === '1500' &&
  (r.headers.get('cache-control') || '').includes('immutable'), 'status=' + r.status);
r = await get('/api/submit/file?key=' + encodeURIComponent(fileKey), null, { range: 'bytes=0-99' });
check('the public file endpoint scrubs too', r.status === 206 && r.headers.get('content-length') === '100', '');
r = await get('/api/submit/file?key=sub/1/notarealkey');
check('made-up keys 404 against the database', r.status === 404, 'status=' + r.status);

// quest rename carries the submission with it
r = await jpost('/api/console/quests/edit', { code: 'Make 21', points: make21Points, new_code: 'Make 22' }, consoleSess);
check('the quest renames cleanly', (await r.json()).code === 'Make 22', '');
r = await get('/api/console/submissions?status=pending', consoleSess);
check('the pending submission follows the rename',
  (await r.json()).submissions[0].quest_code === 'Make 22', '');
await jpost('/api/console/quests/edit', { code: 'Make 22', points: make21Points, new_code: 'Make 21' }, consoleSess);

// ---------------- accept ----------------
const before = raw.prepare(
  'SELECT COALESCE(amount, 0) AS n FROM held WHERE quest_code = ? AND team_id = (SELECT id FROM teams WHERE name = ?)'
).get('Make 21', 'Galahs') || { n: 0 };
r = await jpost('/api/console/submissions/accept', { id: subId, amount: 2 }, consoleSess);
data = await r.json();
check('accepting adds the amount onto the tab', data.ok && data.quest === 'Make 21', JSON.stringify(data));
const after = raw.prepare(
  'SELECT amount FROM held WHERE quest_code = ? AND team_id = (SELECT id FROM teams WHERE name = ?)'
).get('Make 21', 'Galahs');
check('the completion moved by exactly the amount', after.amount === before.n + 2,
  JSON.stringify({ before: before.n, after: after.amount }));
r = await jpost('/api/console/submissions/accept', { id: subId, amount: 1 }, consoleSess);
check('a submission cannot be accepted twice', r.status === 409, 'status=' + r.status);

// ---------------- gallery ----------------
// reading it takes a sign-in now: teams in the race, or an organiser
r = await get('/api/submit/gallery');
check('the gallery is closed to callers with no session', r.status === 401, 'status=' + r.status);
r = await get('/api/submit/gallery', 'not-a-real-session');
check('and to a made-up one', r.status === 401, 'status=' + r.status);
r = await get('/api/submit/gallery', teamSess);
check('the gallery starts empty — accepted but not opted in', (await r.json()).submissions.length === 0, '');
check('the listing is never cached at the edge',
  (r.headers.get('cache-control') || '').includes('no-store'), r.headers.get('cache-control'));
r = await get('/api/console/codes', consoleSess);
const other = (await r.json()).codes.find(c => c.name !== 'Galahs');
r = await jpost('/api/submit/login', { team_name: other.name, code: other.code });
const otherSess = (await r.json()).session;
r = await jpost('/api/submit/gallery', { id: subId, gallery: true }, otherSess);
check('another team cannot touch the flag', r.status === 404, 'status=' + r.status);
r = await jpost('/api/submit/gallery', { id: subId, gallery: true }, teamSess);
check('the team flips its proof into the gallery', (await r.json()).gallery === 1, '');
r = await get('/api/submit/gallery', teamSess);
data = await r.json();
check('a signed-in team sees it with its media',
  data.submissions.length === 1 && data.submissions[0].team_name === 'Galahs' &&
  data.submissions[0].media.length === 2 && data.submissions[0].media[0].key.startsWith('sub/'),
  JSON.stringify(data.submissions));
r = await get('/api/submit/gallery', consoleSess);
check('an organiser on a dashboard session sees it too — the closing-night slideshow runs on one',
  (await r.json()).submissions.length === 1, '');
r = await get('/api/submit/gallery', otherSess);
check('any other team in the race sees it as well', (await r.json()).submissions.length === 1, '');
// hiding the team pulls its proof from the gallery and its counts
const garbId = raw.prepare("SELECT id FROM teams WHERE name = 'Galahs'").get().id;
const make21Before = (await mod.apiResponse('/api/quests', db)).quests.find(q => q.code === 'Make 21').teams_done;
await jpost('/api/console/teams/hide', { id: garbId, hidden: true }, consoleSess);
r = await get('/api/submit/gallery', teamSess);
check('a hidden team\'s proof leaves the gallery', (await r.json()).submissions.length === 0, '');
const questsHidden = await mod.apiResponse('/api/quests', db);
check('a hidden team leaves the quest counts too',
  questsHidden.quests.find(q => q.code === 'Make 21').teams_done === make21Before - 1,
  'before=' + make21Before);
await jpost('/api/console/teams/hide', { id: garbId, hidden: false }, consoleSess);
r = await get('/api/submit/gallery', teamSess);
check('showing the team brings its proof back', (await r.json()).submissions.length === 1, '');

r = await jpost('/api/submit/gallery', { id: subId, gallery: false }, teamSess);
check('and flips it back out', (await r.json()).gallery === 0, '');
r = await get('/api/submit/gallery', teamSess);
check('gone from the gallery again', (await r.json()).submissions.length === 0, '');

// ---------------- reject ----------------
const rejForm = form('S1', '', [file('x.png', 'image/png', png)]);
rejForm.append('gallery', '1');
r = await send(rejForm, teamSess);
check('opting in at upload sticks', (await r.json()).gallery === 1, '');
r = await get('/api/console/submissions?status=pending', consoleSess);
const rejId = (await r.json()).submissions[0].id;
r = await jpost('/api/console/submissions/reject', { id: rejId, reason: 'Sign not visible — reshoot' }, consoleSess);
check('rejecting stamps a reason', (await r.json()).ok === true, '');
r = await get('/api/submit/mine', teamSess);
data = await r.json();
const rejected = data.submissions.find(s => s.id === rejId);
check('the team sees the verdict and the reason',
  rejected.status === 'rejected' && rejected.reason === 'Sign not visible — reshoot', JSON.stringify(rejected));
r = await get('/api/submit/gallery', teamSess);
check('the gallery stays accepted-only — a rejected opt-in never shows',
  (await r.json()).submissions.length === 0, '');

// ---------------- past the cap: queued, not refused ----------------
// A team with a full review queue used to be turned away. Now the send
// is stored as queued, the reviewers see it once a place frees, and
// only a runaway queue is refused.
{
  const garbId = raw.prepare("SELECT id FROM teams WHERE name = 'Galahs'").get().id;
  const count = st => raw.prepare('SELECT COUNT(*) AS n FROM submissions WHERE team_id = ? AND status = ?').get(garbId, st).n;
  const statusOf = id => raw.prepare('SELECT status FROM submissions WHERE id = ?').get(id).status;
  for (let i = count('pending'); i < 12; i++) {
    raw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'S1')").run(garbId);
  }
  r = await send(form('S1', '', [file('y.png', 'image/png', png)]), teamSess);
  let d = await r.json();
  check('a send past the cap is taken in and queued, not refused',
    r.status === 200 && d.ok === true && d.queued === true && statusOf(d.id) === 'queued', 'status=' + r.status + ' ' + JSON.stringify(d));
  const firstQueued = d.id;
  r = await get('/api/console/submissions?status=pending', consoleSess);
  check('the reviewers do not see it while the team is at the cap',
    !(await r.json()).submissions.some(x => x.id === firstQueued), '');
  r = await get('/api/submit/mine', teamSess);
  check('the team sees it in its list as queued',
    (await r.json()).submissions.some(x => x.id === firstQueued && x.status === 'queued'), '');
  r = await get('/api/submit/score', teamSess);
  d = await r.json();
  check('the score sheet counts the queue apart from what is in review',
    d.pending === 12 && d.queued === 1, JSON.stringify({ pending: d.pending, queued: d.queued }));

  // a reviewer clears one: the team's next read moves the queue on
  raw.prepare("UPDATE submissions SET status = 'rejected' WHERE id = (SELECT MIN(id) FROM submissions WHERE team_id = ? AND status = 'pending')").run(garbId);
  r = await get('/api/submit/mine', teamSess);
  check('a freed place goes to the oldest queued submission',
    statusOf(firstQueued) === 'pending' && count('pending') === 12 && count('queued') === 0, 'status=' + statusOf(firstQueued));

  // the scheduled run does the same for every team at once
  r = await send(form('S1', '', [file('y.png', 'image/png', png)]), teamSess);
  d = await r.json();
  const secondQueued = d.id;
  raw.prepare("UPDATE submissions SET status = 'accepted' WHERE id = (SELECT MIN(id) FROM submissions WHERE team_id = ? AND status = 'pending')").run(garbId);
  const moved = await promoteQueued(db);
  check('the scheduled pass promotes across every team', d.queued === true && moved === 1 && statusOf(secondQueued) === 'pending',
    'queued=' + d.queued + ' moved=' + moved);

  // only a runaway queue is turned away
  for (let i = 0; i < MAX_QUEUED; i++) {
    raw.prepare("INSERT INTO submissions (team_id, quest_code, status) VALUES (?, 'S1', 'queued')").run(garbId);
  }
  r = await send(form('S1', '', [file('y.png', 'image/png', png)]), teamSess);
  check('past the queue\'s own ceiling a send is refused',
    r.status === 429 && /waiting on review/.test((await r.json()).error), 'status=' + r.status);
  raw.prepare("DELETE FROM submissions WHERE team_id = ? AND status = 'queued'").run(garbId);

  // two sends at once with one place left: the insert decides, so one
  // goes to review and the other waits behind it
  raw.prepare("UPDATE submissions SET status = 'rejected' WHERE id = (SELECT MIN(id) FROM submissions WHERE team_id = ? AND status = 'pending')").run(garbId);
  const pair = await Promise.all([1, 2].map(() => send(form('S1', '', [file('y.png', 'image/png', png)]), teamSess).then(x => x.json())));
  check('two sends at once with one place left put one in review and queue the other',
    pair.every(x => x.ok) && pair.map(x => x.queued).sort().join() === 'false,true' && count('pending') === 12 && count('queued') === 1,
    JSON.stringify({ pair: pair.map(x => [x.queued, x.ahead]), pending: count('pending'), queued: count('queued') }));
}

// the log tells the story
r = await get('/api/console/log?limit=30', consoleSess);
const actions = (await r.json()).entries.map(e => e.action);
r = await get('/api/console/submissions?status=all', consoleSess);
data = await r.json();
check('the review list can show every status at once',
  r.status === 200 && data.submissions.length >= 3 && ['pending', 'accepted', 'rejected'].every(st => data.submissions.some(x => x.status === st)),
  JSON.stringify(data.submissions.map(x => x.status)));
check('accept and reject are in the audit log',
  actions.includes('submit-accept') && actions.includes('submit-reject') && actions.includes('codes-generate'),
  JSON.stringify([...new Set(actions)].slice(0, 8)));

// ---------------- how far behind review may get ----------------
// The pending cap counts submissions *waiting on review*, so it is
// really a limit on the reviewers, not on the team: past it a team
// stops being able to play because organisers are behind. That makes
// it a number the Scores tab can move rather than a deploy.
{
  r = await get('/api/console/limits', consoleSess);
  let lim = await r.json();
  check('the dashboard reads the pending cap and what it ships as',
    r.status === 200 && lim.ok && lim.limits.submit_max_pending === 12 && lim.defaults.submit_max_pending === 12,
    JSON.stringify(lim));

  r = await get('/api/console/limits');
  check('reading it needs a dashboard session', r.status === 401, 'status=' + r.status);
  r = await jpost('/api/console/limits/set', { limits: { submit_max_pending: 0 } }, consoleSess);
  check('zero is refused: no team could send anything', r.status === 400, 'status=' + r.status);
  r = await jpost('/api/console/limits/set', { limits: { nonsense: 4 } }, consoleSess);
  lim = await r.json();
  check('a name nothing reads is ignored rather than stored',
    r.status === 200 && lim.limits.submit_max_pending === 12 && lim.limits.nonsense === undefined, JSON.stringify(lim.limits));

  // drop it to one and the next send waits in the queue
  await jpost('/api/console/limits/set', { limits: { submit_max_pending: 1 } }, consoleSess);
  const tooMany = new FormData();
  tooMany.append('quest', 'make 21');
  tooMany.append('files', new File([jpegOf(600)], 'one.jpg', { type: 'image/jpeg' }), 'one.jpg');
  r = await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: tooMany });
  check('with the cap at one, a team already holding one is queued',
    r.status === 200 && (await r.json()).queued === true, 'status=' + r.status);

  // this team is holding more than a dozen by now, so raising it past
  // that is what proves the setting works in both directions: the queue
  // moves on and the next send goes straight to review
  await jpost('/api/console/limits/set', { limits: { submit_max_pending: 99 } }, consoleSess);
  const fine = new FormData();
  fine.append('quest', 'make 21');
  fine.append('files', new File([jpegOf(600)], 'two.jpg', { type: 'image/jpeg' }), 'two.jpg');
  r = await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: fine });
  const fineBody = await r.json();
  check('and raising it moves the queue on and lets the next send straight in',
    r.status === 200 && fineBody.ok === true && fineBody.queued === false &&
    raw.prepare("SELECT COUNT(*) AS n FROM submissions WHERE status = 'queued'").get().n === 0, 'status=' + r.status);
}

// A photo taken with the phone upright is stored on its side with a
// tag saying so. Discord sizes its preview from the stored shape and
// then turns the picture, which squashed it, so an unfurler is handed
// the viewing copy the browser drew the right way up instead.
{
  const exif = [0x45, 0x78, 0x69, 0x66, 0, 0, 0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0,
    0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
  const turned = new Uint8Array(4096);
  turned.set([0xFF, 0xD8, 0xFF, 0xE1, 0, exif.length + 2, ...exif, 0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 63, 0]);
  turned.set([0xFF, 0xD9], turned.length - 2);
  const view = new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0, 8, 1, 1, 0, 0, 63, 0, 5, 6, 7, 8, 9, 0xFF, 0xD9]);
  const fv = new FormData();
  fv.append('quest', 'make 21');
  fv.append('files', new File([turned], 'upright.jpg', { type: 'image/jpeg' }));
  fv.append('view0', new File([view], 'view.jpg', { type: 'image/jpeg' }));
  const made = await (await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: fv })).json();
  const turnedKey = (await db.prepare('SELECT r2_key FROM submission_files WHERE submission_id = ?1').bind(made.id).first()).r2_key;
  const path = '/api/submit/file/' + turnedKey.split('/').map(encodeURIComponent).join('/') + '/upright.jpg';
  const toDiscord = await front(path, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' } });
  const toBrowser = await front(path);
  const sizes = { discord: (await toDiscord.arrayBuffer()).byteLength, browser: (await toBrowser.arrayBuffer()).byteLength };
  check('an unfurler is handed the upright viewing copy of a photo stored on its side, a browser the clean copy',
    toDiscord.status === 200 && sizes.discord === view.length && sizes.browser > view.length &&
    toDiscord.headers.get('cache-control') === 'private, no-store', JSON.stringify(sizes));
}

// ---------------- what a quest takes ----------------
// Each quest's rules say which kinds of file its form takes, how many
// and whether one is needed (rules.js). A GPX track is proof for the
// organisers alone: the dashboard serves it and reads it, and nothing
// public lists or serves it.
{
  const quest = (key, rules) => {
    const id = Number(raw.prepare('INSERT INTO quest_groups (key, name, rules) VALUES (?, ?, ?)').run(key, key, JSON.stringify(rules)).lastInsertRowid);
    raw.prepare('INSERT INTO quests (code, norm, points, group_id) VALUES (?, ?, 10, ?)').run(key, key, id);
  };
  quest('RUN1', { files: { kinds: ['photo', 'gpx'], max: 6, required: true } });
  quest('ASK1', { files: { kinds: [] } });
  const TRACK = '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="watch"><trk><trkseg>' +
    '<trkpt lat="-33.9000" lon="151.2000"><ele>4</ele><time>2026-10-20T01:00:00Z</time></trkpt>' +
    '<trkpt lon="151.2000" lat="-33.9100"><time>2026-10-20T01:10:00Z</time></trkpt>' +
    '</trkseg></trk></gpx>';
  // a phone hands a GPX over with no type of its own; the name says what it is
  const gpx = (bytes) => file('run.gpx', 'application/octet-stream', new TextEncoder().encode(bytes || TRACK));
  const photos = (n) => Array.from({ length: n }, (_, i) => file('p' + i + '.png', 'image/png', png));
  const sendTo = (code, list, answer) => {
    const f = form(code, '', list);
    if (answer) f.append('answer', JSON.stringify(answer));
    return send(f, teamSess);
  };

  r = await sendTo('RUN1', [gpx(), ...photos(5)]);
  const took = await r.json();
  const rows = raw.prepare('SELECT r2_key, content_type FROM submission_files WHERE submission_id = ? ORDER BY id').all(took.id);
  const trackKey = rows.length ? rows[0].r2_key : '';
  check('a quest taking photos and GPX tracks, six at most, takes a track sent with no type of its own and stores it as one, with no copies beside it',
    r.status === 200 && took.files === 6 && rows[0].content_type === 'application/gpx+xml' &&
    ![...bucket.keys()].some(k => k.startsWith(trackKey + '.')), 'status=' + r.status + ' ' + JSON.stringify(rows[0]));
  r = await sendTo('RUN1', [gpx(), ...photos(6)]);
  check('a seventh file is one too many', r.status === 400, 'status=' + r.status);
  r = await sendTo('RUN1', [gpx('lat,lon\n-33.9,151.2\n')]);
  check('a file named .gpx has to start like a track', r.status === 400, 'status=' + r.status);
  r = await sendTo('RUN1', []);
  check('a quest that needs a file refuses a send with none', r.status === 400, 'status=' + r.status);

  r = await sendTo('ASK1', [], { kind: 'text', value: 'Circular Quay' });
  const answered = await r.json();
  const refused = await sendTo('ASK1', photos(1));
  check('a quest that takes no files is sent with its answer alone, and a file sent to it is refused',
    r.status === 200 && answered.files === 0 && refused.status === 400 &&
    raw.prepare('SELECT answer FROM submissions WHERE id = ?').get(answered.id).answer.includes('Circular Quay'),
    JSON.stringify(answered));

  raw.prepare("UPDATE submissions SET status = 'accepted', gallery = 1 WHERE id = ?").run(took.id);
  const listed = (await (await get('/api/submit/gallery', teamSess)).json()).submissions.find(s => s.id === took.id);
  const site = await front('/api/submit/file?key=' + encodeURIComponent(trackKey));
  const named = await front('/api/submit/file/' + trackKey + '/run.gpx');
  const dash = await get('/api/console/file?key=' + encodeURIComponent(trackKey), consoleSess);
  check('nothing public lists or serves a GPX track, and the dashboard serves it whole',
    !!listed && listed.media.length === 5 && listed.media.every(m => m.type === 'image/png') &&
    site.status === 404 && named.status === 404 && dash.status === 200 && (await dash.text()) === TRACK,
    JSON.stringify({ listed: listed && listed.media.length, site: site.status, named: named.status, dash: dash.status }));

  r = await get('/api/console/file/track?key=' + encodeURIComponent(trackKey), consoleSess);
  const track = await r.json();
  check('the dashboard reads a track: its points, how far it goes, when it started and ended, and a line to draw',
    r.status === 200 && track.points === 2 && Math.abs(track.distance_m - 1112) <= 1 &&
    track.started === '2026-10-20 01:00:00' && track.ended === '2026-10-20 01:10:00' &&
    JSON.stringify(track.line) === '[[-33.9,151.2],[-33.91,151.2]]', JSON.stringify(track));
}

// ---------------- a video as sent, with its metadata blanked ----------------
{
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts.map(p => Buffer.from(p)));
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
  };
  const PLACE = '+33.8688+151.2093/';
  const mvhd = box('mvhd', Buffer.alloc(100, 1));
  const tkhd = box('tkhd', Buffer.alloc(84, 2));
  const mdat = box('mdat', Buffer.alloc(64, 7));
  const movie = Buffer.concat([
    box('ftyp', 'qt  ', Buffer.alloc(4), 'qt  '),
    box('wide'),
    mdat,
    box('moov', mvhd,
      box('trak', tkhd, box('udta', box('©xyz', PLACE)), box('mdia', box('mdhd', Buffer.alloc(24, 3)))),
      box('udta', box('©xyz', PLACE)),
      box('meta', 'com.apple.quicktime.model iPhone 15 ' + PLACE))
  ]);
  const team = raw.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get().id;
  const subId = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code, status, gallery) VALUES (?, 'SQ40', 'accepted', 1)").run(team).lastInsertRowid);
  const put = (key, bytes) => {
    raw.prepare("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, ?, 'video/quicktime', ?, 'IMG_1.mov')").run(subId, key, bytes.length);
    bucket.set(key, { bytes: new Uint8Array(bytes), meta: { contentType: 'video/quicktime' }, custom: {} });
  };
  put('sub/uploadedmovie01', movie);
  put('sub/unreadablemov01', Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(PLACE)]));
  const url = (key, extra) => '/api/submit/file?key=' + encodeURIComponent(key) + (extra || '');
  const whole = await front(url('sub/uploadedmovie01', '&uploaded=1'));
  const out = Buffer.from(await whole.arrayBuffer());
  const part = await front(url('sub/uploadedmovie01', '&uploaded=1'), { headers: { range: 'bytes=100-' } });
  const tail = Buffer.from(await part.arrayBuffer());
  const plain = await front(url('sub/uploadedmovie01'));
  const unreadable = await front(url('sub/unreadablemov01', '&uploaded=1'));
  check('uploaded=1 serves a video as sent with its udta and meta boxes blanked, the same length and every other box intact, and by range; a file it cannot read, and the plain address, never hand out the original',
    whole.status === 200 && out.length === movie.length && !out.includes(PLACE) && !out.includes('iPhone') &&
    !out.includes('udta') && !out.includes('meta') && out.includes(mvhd) && out.includes(tkhd) && out.includes(mdat) &&
    part.status === 206 && tail.equals(out.subarray(100)) && plain.status === 404 && unreadable.status === 404,
    JSON.stringify({ whole: whole.status, len: [out.length, movie.length], part: part.status, plain: plain.status, unreadable: unreadable.status }));
}

// ---------------- what a phone video says about itself ----------------
// Apple writes the place, the phone and the time with its zone as keyed
// metadata (keys names each entry, ilst holds them by number); the older
// user data box carries the same as one box per fact. The dashboard's
// details read both, from the block kept beside the video.
{
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts.map(p => Buffer.from(p)));
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    if (typeof type === 'number') head.writeUInt32BE(type, 4); else head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
  };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
  const names = ['com.apple.quicktime.location.ISO6709', 'com.apple.quicktime.make', 'com.apple.quicktime.model', 'com.apple.quicktime.creationdate'];
  const values = ['-33.8688+151.2093+012.000/', 'Apple', 'iPhone 15 Pro', '2026-10-21T09:30:00+1100'];
  const keyed = box('meta',
    box('hdlr', Buffer.alloc(8), 'mdta', Buffer.alloc(13)),
    box('keys', Buffer.alloc(4), u32(names.length), ...names.map(n => box('mdta', n))),
    box('ilst', ...values.map((v, i) => box(i + 1, box('data', u32(1), Buffer.alloc(4), v)))));
  const said = (text) => Buffer.concat([Buffer.from([0, text.length, 0x15, 0xC7]), Buffer.from(text)]);
  const movie = Buffer.concat([
    box('ftyp', 'qt  ', Buffer.alloc(4), 'qt  '),
    box('mdat', Buffer.alloc(64, 7)),
    box('moov', box('mvhd', Buffer.alloc(100, 1)), box('udta', box('\u00A9swr', said('17.1'))), keyed)
  ]);
  const team = raw.prepare('SELECT id FROM teams ORDER BY id LIMIT 1').get().id;
  const subId = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code, status, gallery) VALUES (?, 'SQ40', 'accepted', 1)").run(team).lastInsertRowid);
  raw.prepare("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, 'sub/phonemovie01', 'video/quicktime', ?, 'IMG_2.mov')").run(subId, movie.length);
  bucket.set('sub/phonemovie01', { bytes: new Uint8Array(movie), meta: { contentType: 'video/quicktime' }, custom: {} });
  const d = await (await get('/api/console/file/meta?key=sub%2Fphonemovie01', consoleSess)).json();
  check('a phone video\'s place, phone, software and the time it was filmed in its own zone are read for the dashboard\'s details',
    d.ok && d.make === 'Apple' && d.model === 'iPhone 15 Pro' && d.software === '17.1' &&
    d.gps && d.gps.lat === -33.8688 && d.gps.lng === 151.2093 && d.gps.alt === 12 &&
    d.taken_at === '2026-10-21 09:30:00' && d.offset === '+11:00' && bucket.has('sub/phonemovie01.x'),
    JSON.stringify(d));
}

// ---------------- a stand-in is never kept ----------------
// Until the encoder is done, a video's address can answer with its still
// or with another height than the one asked for, and later the same
// address serves the real copy. Neither the browser nor the edge keeps
// those; once the encoder is done the nearest height is the answer for
// good. The team's list says which videos the encoder gave up on.
{
  const kept = new Map();
  const keyOf = (k) => typeof k === 'string' ? k : k.url;
  const was = globalThis.caches;
  globalThis.caches = { default: {
    async match(k) { const h = kept.get(keyOf(k)); return h ? new Response(h.body, { headers: h.headers }) : undefined; },
    async put(k, res) { kept.set(keyOf(k), { body: await res.arrayBuffer(), headers: [...res.headers] }); },
    async delete(k) { return kept.delete(keyOf(k)); }
  } };
  const f = new FormData();
  f.append('quest', 'make 21');
  f.append('files', new File([new Uint8Array(5000).fill(6)], 'wait.mp4', { type: 'video/mp4' }), 'wait.mp4');
  f.append('thumb0', new File([plainJpeg(64)], 't.jpg', { type: 'image/jpeg' }), 't.jpg');
  const made = await (await front('/api/submit/create', { method: 'POST', headers: { authorization: 'Bearer ' + teamSess }, body: f })).json();
  const key = raw.prepare('SELECT r2_key FROM submission_files WHERE submission_id = ?').get(made.id).r2_key;
  const at = (extra) => '/api/submit/file?key=' + encodeURIComponent(key) + (extra || '');
  const read = async (path) => {
    const res = await front(path);
    const bytes = (await res.arrayBuffer()).byteLength;
    await new Promise(r => setTimeout(r, 20));
    return { status: res.status, cc: res.headers.get('cache-control'), bytes };
  };
  const state = (s) => raw.prepare('UPDATE submission_files SET encode_state = ? WHERE r2_key = ?').run(s, key);
  const listed = async () => (await (await get('/api/submit/mine', teamSess)).json()).submissions.find(s => s.id === made.id).media[0];
  const still = await read(at());
  state('skipped');
  const gaveUp = await listed();
  raw.prepare('INSERT INTO submission_renditions (file_key, height, key, bytes) VALUES (?, 480, ?, 900)').run(key, 'rnd/standin480');
  bucket.set('rnd/standin480', { bytes: new Uint8Array(900).fill(1), meta: { contentType: 'video/mp4' }, custom: {} });
  state('encoding');
  const busy = await listed();
  const other = await read(at('&res=720'));
  const instead = await read(at('&res=original'));
  const exact = await read(at('&res=480'));
  state('done');
  const settled = await read(at('&res=1080'));
  globalThis.caches = was;
  const STAND = 'private, no-store';
  const keptKeys = [...kept.keys()].sort();
  const wantKept = [at('&res=1080'), at('&res=480')].map(p => new URL('https://bot.example' + p).toString()).sort();
  check('until the encoder is done, a still or another height standing in for a video is kept by neither the browser nor the edge, and the height asked for, or the nearest once it is done, is',
    still.bytes === 64 && still.cc === STAND && other.bytes === 900 && other.cc === STAND && instead.bytes === 900 && instead.cc === STAND &&
    /immutable/.test(exact.cc) && /immutable/.test(settled.cc) && JSON.stringify(keptKeys) === JSON.stringify(wantKept),
    JSON.stringify({ still, other, instead, exact, settled, keptKeys }));
  check('the team\'s list says a video the encoder gave up on is skipped, and one a machine has is encoding',
    gaveUp.skipped === true && !gaveUp.encoding && busy.encoding === true && !busy.skipped, JSON.stringify({ gaveUp, busy }));
  raw.prepare('DELETE FROM submission_renditions WHERE file_key = ?').run(key);
  await forgetFiles(made.id);
  raw.prepare('DELETE FROM submission_files WHERE submission_id = ?').run(made.id);
  raw.prepare('DELETE FROM submissions WHERE id = ?').run(made.id);
}

// ---------------- the newest only, and saying so ----------------
// A team's list stops at 100 and the gallery at 300, each answering
// more: true when there are older ones; the gallery leaves out a
// submission with nothing it can show.
{
  const crew = Number(raw.prepare("INSERT INTO teams (name) VALUES ('Busy Crew')").run().lastInsertRowid);
  await jpost('/api/console/codes/generate', {}, consoleSess);
  const code = (await (await get('/api/console/codes', consoleSess)).json()).codes.find(c => c.name === 'Busy Crew').code;
  const crewSess = (await (await jpost('/api/submit/login', { team_name: 'Busy Crew', code })).json()).session;
  const add = raw.prepare("INSERT INTO submissions (team_id, quest_code, status, gallery) VALUES (?, 'S1', 'accepted', 1)");
  const addFile = raw.prepare('INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, ?, ?, 10, ?)');
  const ids = [];
  for (let i = 0; i < 301; i++) {
    const id = Number(add.run(crew).lastInsertRowid);
    ids.push(id);
    // the newest has no file, the one before it only a GPX track
    if (i === 300) continue;
    if (i === 299) addFile.run(id, 'sub/busytrack' + i, 'application/gpx+xml', 'run.gpx');
    else addFile.run(id, 'sub/busyphoto' + i, 'image/png', 'p.png');
  }
  const mine = await (await get('/api/submit/mine', crewSess)).json();
  const gallery = await (await get('/api/submit/gallery', crewSess)).json();
  raw.prepare('DELETE FROM submission_files WHERE submission_id IN (SELECT id FROM submissions WHERE team_id = ? AND id > ?)').run(crew, ids[1]);
  raw.prepare('DELETE FROM submissions WHERE team_id = ? AND id > ?').run(crew, ids[1]);
  const few = await (await get('/api/submit/mine', crewSess)).json();
  check('a team\'s list is its newest 100 and the gallery the newest 300, each saying only then that there are more, and the gallery lists no submission with nothing to show',
    mine.submissions.length === 100 && mine.more === true && mine.submissions[0].id === ids[300] &&
    gallery.more === true && gallery.submissions.length === 298 && gallery.submissions.every(s => s.media.length > 0) &&
    gallery.submissions[0].id === ids[298] && few.submissions.length === 2 && few.more === undefined,
    JSON.stringify({ mine: [mine.submissions.length, mine.more], gallery: [gallery.submissions.length, gallery.more], few: [few.submissions.length, few.more] }));
  raw.prepare('DELETE FROM submission_files WHERE submission_id IN (SELECT id FROM submissions WHERE team_id = ?)').run(crew);
  raw.prepare('DELETE FROM submissions WHERE team_id = ?').run(crew);
}

// ---------------- a picks answer is never cut short ----------------
{
  const picks = (n) => {
    const f = form('make 21', '', [file('a.png', 'image/png', png)]);
    f.append('answer', JSON.stringify({ kind: 'pick', value: Array.from({ length: n }, (_, i) => 'Station ' + i) }));
    return send(f, teamSess);
  };
  const over = await picks(61);
  const overBody = await over.json();
  const most = await picks(60);
  const mostBody = await most.json();
  const stored = mostBody.id ? JSON.parse(raw.prepare('SELECT answer FROM submissions WHERE id = ?').get(mostBody.id).answer) : null;
  check('an answer with more than 60 picks is refused, naming the limit, and one with 60 is kept whole',
    over.status === 400 && /60/.test(overBody.error || '') && most.status === 200 && stored && stored.value.length === 60,
    JSON.stringify({ over: [over.status, overBody.error], most: most.status, stored: stored && stored.value.length }));
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
