// Run with: node tests/verify-staged.mjs   (needs Node 22+)
//
// The dashboard's own files sent straight to R2 (src/staged.ts): a file
// is started for what it is for, its slices go to addresses the worker
// signs, the worker joins and checks them, and a save names it by id.
// The home page's pictures are the save used here; the other saves
// adopt a staged file the same three steps, and their own suites hold
// them to it. The R2 is tests/pretend-r2.mjs, which checks every
// signature with code that is not the worker's.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
import { pretendR2 } from './pretend-r2.mjs';

const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
const db = d1Shim(raw);
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };

const r2 = pretendR2();
const mod = await import(BOT + '/src/index.ts');
const { stagedSweep, claimStaged } = await import(BOT + '/src/staged.ts');
const BASE = { DB: db, SUBMIT: r2.SUBMIT, CONSOLE_PASSWORD: 'tab-pass', PUBLIC_API: 'https://files.example', SITE_URL: 'https://scs.example' };
let env = Object.assign({}, BASE, r2.env);
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), env, { waitUntil() {} });
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const answer = async (r) => ({ status: r.status, data: await r.json() });
const post = async (path, body, token) => answer(await jpost(path, body, token));
const get = async (path, token) => answer(await front(path, { headers: { authorization: 'Bearer ' + token } }));

const admin = (await consoleSignIn(jpost, 'Comms', 'tab-pass')).session;
await post('/api/console/accounts/save', { create: true, name: 'Reviewer', password: 'reviewer-pass-1', perms: ['review'], require_2fa: false }, admin);
const reviewer = (await consoleSignIn(jpost, 'Reviewer', 'reviewer-pass-1')).session;
await post('/api/console/accounts/save', { create: true, name: 'Settings', password: 'settings-pass-1', perms: ['settings'], require_2fa: false }, admin);
const other = (await consoleSignIn(jpost, 'Settings', 'settings-pass-1')).session;

// a PNG with a text chunk in it, so its clean copy is a different file
function chunk(type, data) {
  const len = data.length;
  return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255]
    .concat([...type].map(c => c.charCodeAt(0)), data, [0, 0, 0, 0]);
}
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10].concat(
  chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  chunk('tEXt', [...'Comment taken at 33.8688 S'].map(c => c.charCodeAt(0))),
  chunk('IEND', [])
));

// what the page does: start, a signed address per slice, the slice
// sent there with nothing else on it, then finish
async function stage(purpose, name, type, bytes, token) {
  const start = await post('/api/console/upload/start', { purpose, name, type, size: bytes.length }, token || admin);
  if (start.status !== 200) return { start };
  const PART = start.data.part_size;
  for (let n = 1; n <= start.data.parts; n++) {
    const s = await get('/api/console/upload/sign?id=' + start.data.id + '&n=' + n, token || admin);
    await fetch(s.data.url, { method: 'PUT', body: bytes.slice((n - 1) * PART, n * PART) });
  }
  const fin = await post('/api/console/upload/finish', { id: start.data.id }, token || admin);
  return { start, fin, id: start.data.id };
}
function slideForm(fields) {
  const form = new FormData();
  Object.keys(fields).forEach((k) => form.append(k, fields[k]));
  return form;
}
const saveSlide = async (fields, token) => answer(await front('/api/console/slides/save', {
  method: 'POST', headers: { authorization: 'Bearer ' + (token || admin) }, body: slideForm(fields)
}));
const stagedRow = (id) => raw.prepare('SELECT * FROM staged_uploads WHERE id = ?').get(id);

// ---------------- off until the secrets are set ----------------
{
  env = BASE;
  const m = await get('/api/console/upload/mode', admin);
  const s = await post('/api/console/upload/start', { purpose: 'slide', name: 'a.png', type: 'image/png', size: 10 }, admin);
  check('without the R2 secrets the dashboard is told to send files with its saves, and nothing can be started',
    m.status === 200 && m.data.direct === false && s.status === 503, JSON.stringify({ m: m.data, s }));
  env = Object.assign({}, BASE, r2.env);
}

// ---------------- what may be started ----------------
{
  const odd = await post('/api/console/upload/start', { purpose: 'secrets', name: 'a.png', type: 'image/png', size: 10 }, admin);
  const big = await post('/api/console/upload/start', { purpose: 'slide', name: 'huge.png', type: 'image/png', size: 26 * 1024 * 1024 }, admin);
  const noTab = await post('/api/console/upload/start', { purpose: 'slide', name: 'a.png', type: 'image/png', size: 10 }, reviewer);
  const wrongTab = await post('/api/console/upload/start', { purpose: 'msg', name: 'a.png', type: 'image/png', size: 10 }, other);
  check('a file is only started for something the dashboard saves, within its size, by an account with that tab',
    odd.status === 400 && big.status === 413 && noTab.status === 403 && wrongTab.status === 403 && r2.seen.create === 0,
    JSON.stringify({ odd: odd.status, big: big.status, noTab: noTab.status, wrongTab: wrongTab.status }));
}

// ---------------- a picture straight to R2, then saved ----------------
let firstKey = '';
{
  const t = await stage('slide', 'harbour.png', 'image/png', png);
  const row = stagedRow(t.id);
  firstKey = row.r2_key;
  const held = r2.bucket.get(row.r2_key);
  check('a staged picture is joined under a key of its own kind, its metadata block read, and waits to be saved',
    t.fin.status === 200 && /^slide\//.test(row.r2_key) && row.status === 'ready' &&
    held && held.bytes.length === png.length && r2.bucket.has(row.r2_key + '.x') && !r2.bucket.has(row.r2_key + '.c') && r2.seen.part === 1,
    JSON.stringify({ fin: t.fin, row }));

  const saved = await saveSlide({ staged: String(t.id), alt: 'The harbour at dusk', caption: '' });
  const slide = raw.prepare('SELECT key, name, type, bytes FROM home_slides').get();
  check('the save points at the file where it already is, and the staged row goes',
    saved.status === 200 && slide && slide.key === row.r2_key && slide.bytes === png.length &&
    slide.type === 'image/png' && !stagedRow(t.id), JSON.stringify({ saved: saved.data, slide }));

  const again = await saveSlide({ staged: String(t.id), alt: 'Twice' });
  check('the same file cannot be saved twice', again.status === 404 &&
    raw.prepare('SELECT COUNT(*) AS n FROM home_slides').get().n === 1, JSON.stringify(again));

  const served = await front('/api/slides/file?key=' + encodeURIComponent(row.r2_key));
  const body = new Uint8Array(await served.arrayBuffer());
  check('the public file is the clean copy, not the file as sent',
    served.status === 200 && body.length > 0 && body.length < png.length, 'status=' + served.status + ' bytes=' + body.length);
}

// ---------------- only for what, and by whom, it was sent ----------------
{
  const t = await stage('slide', 'mine.png', 'image/png', png, admin);
  const byOther = await saveSlide({ staged: String(t.id), alt: 'Not yours' }, other);
  const m = await stage('msg', 'notice.png', 'image/png', png, admin);
  const wrongKind = await saveSlide({ staged: String(m.id), alt: 'A message file' });
  check('a staged file is saved only by the account that sent it, and only as what it was sent for',
    byOther.status === 404 && wrongKind.status === 404 && stagedRow(t.id).status === 'ready' && stagedRow(m.id).status === 'ready',
    JSON.stringify({ byOther, wrongKind }));
  const half = await post('/api/console/upload/start', { purpose: 'slide', name: 'half.png', type: 'image/png', size: png.length }, admin);
  const early = await saveSlide({ staged: String(half.data.id), alt: 'Not there yet' });
  check('a save naming a file still uploading is refused', early.status === 409, JSON.stringify(early));
}

// ---------------- not what its type says ----------------
{
  const fake = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
  const t = await stage('slide', 'fake.png', 'image/png', fake);
  const row = raw.prepare("SELECT r2_key FROM staged_uploads WHERE name = 'fake.png'").get();
  check('a "picture" whose first bytes are not one is refused when it lands, and nothing of it is kept',
    t.fin.status === 400 && !row && ![...r2.bucket.keys()].some((k) => r2.bucket.get(k).bytes.length === fake.length),
    JSON.stringify(t.fin));
}

// ---------------- giving up ----------------
{
  const s = await post('/api/console/upload/start', { purpose: 'drop', name: 'big.mp4', type: 'video/mp4', size: 30 * 1024 * 1024 }, admin);
  const before = r2.seen.abort;
  const ab = await post('/api/console/upload/abort', { id: s.data.id }, admin);
  const sign = await get('/api/console/upload/sign?id=' + s.data.id + '&n=1', admin);
  check('abandoning a staged file tells R2 to drop it, and no more slices are signed for it',
    ab.status === 200 && r2.seen.abort === before + 1 && !stagedRow(s.data.id) && sign.status === 404,
    JSON.stringify({ ab, sign: sign.status }));
}

// ---------------- two saves naming the same file ----------------
// A save that gets only some of its files gives back the ones it took,
// and never one the other save has just claimed.
{
  const a = await stage('slide', 'a.png', 'image/png', png);
  const b = await stage('slide', 'b.png', 'image/png', png);
  const first = await claimStaged(env, [{ id: b.id }]);
  const second = await claimStaged(env, [{ id: a.id }, { id: b.id }]);
  check('a save refused over a file another save took gives back only its own',
    first === null && second && second.status === 409 &&
    stagedRow(a.id).status === 'ready' && stagedRow(b.id).status === 'used',
    JSON.stringify({ a: stagedRow(a.id).status, b: stagedRow(b.id).status }));
  raw.prepare('DELETE FROM staged_uploads WHERE id IN (?, ?)').run(a.id, b.id);
}

// ---------------- the sweep ----------------
// a day on: one never finished, one finished and never saved, one a
// save claimed and never released
{
  const open = await post('/api/console/upload/start', { purpose: 'drop', name: 'open.mp4', type: 'video/mp4', size: 1024 }, admin);
  const left = await stage('slide', 'left.png', 'image/png', png);
  const claimed = await stage('slide', 'claimed.png', 'image/png', png);
  raw.prepare("UPDATE staged_uploads SET status = 'used' WHERE id = ?").run(claimed.id);
  const leftKey = stagedRow(left.id).r2_key;
  const claimedKey = stagedRow(claimed.id).r2_key;
  raw.prepare("UPDATE staged_uploads SET created_at = datetime('now', '-25 hours') WHERE id IN (?, ?, ?)").run(open.data.id, left.id, claimed.id);
  const fresh = await stage('slide', 'fresh.png', 'image/png', png);
  const before = r2.seen.abort;
  const swept = await stagedSweep(env);
  check('a day on, the sweep drops what was never finished or saved and leaves a claimed file where it is',
    swept === 3 && r2.seen.abort === before + 1 && !r2.bucket.has(leftKey) && !r2.bucket.has(leftKey + '.c') &&
    r2.bucket.has(claimedKey) && !stagedRow(open.data.id) && !stagedRow(left.id) && !stagedRow(claimed.id) &&
    stagedRow(fresh.id).status === 'ready' && r2.bucket.has(firstKey),
    JSON.stringify({ swept }));
}

check('every request R2 saw was signed correctly', r2.seen.refused === 0, 'refused=' + r2.seen.refused);
r2.restore();

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
