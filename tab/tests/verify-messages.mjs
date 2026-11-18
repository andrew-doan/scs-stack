// Run with: node tests/verify-messages.mjs   (needs Node 22+)
// Organiser messages and the version counters the site polls, end to
// end against the real worker: the pulse and what moves it, the public
// messages payload, attachments by their keys, the push that goes out
// with a message (and the save that is refused whole when its password
// is wrong), and the one thing that matters most about both — a frozen
// tab still answers them, because the freeze stops the standings, not
// the organisers.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import crypto from 'node:crypto';

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
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);

// ---- R2 shim: put, ranged get, delete ----
const bucket = new Map();
async function drain(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  return new Uint8Array(0);
}
const SUBMIT = {
  async put(key, value, opts) {
    bucket.set(key, { bytes: await drain(value), meta: (opts && opts.httpMetadata) || {}, custom: (opts && opts.customMetadata) || {} });
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
  async delete(key) { bucket.delete(key); }
};

// ---- edge cache mock, so purges are countable ----
const purged = [];
globalThis.caches = { default: {
  async match() { return undefined; },
  async put() {},
  async delete(key) { purged.push(typeof key === 'string' ? key : key.url); return true; }
} };

// ---- VAPID keys, the way scripts/gen-vapid.mjs makes them ----
const vapidPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const vapidJwk = vapidPair.publicKey.export({ format: 'jwk' });
const VAPID_PUBLIC = Buffer.concat([
  Buffer.from([4]), Buffer.from(vapidJwk.x, 'base64url'), Buffer.from(vapidJwk.y, 'base64url')
]).toString('base64url');
const VAPID_PRIVATE = vapidPair.privateKey.export({ format: 'jwk' }).d;

// ---- stand in for the push services and for Discord ----
const pushed = [];
const discordCalls = [];
let discordFails = false;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://push.example/')) {
    pushed.push({ url, headers: init.headers, body: Buffer.from(init.body) });
    return new Response(null, { status: 201 });
  }
  if (url.startsWith('https://discord.com/api/')) {
    discordCalls.push({ url, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    const json = discordFails ? { message: 'Missing Access' } : { id: '900' };
    return new Response(JSON.stringify(json), {
      status: discordFails ? 403 : 200, headers: { 'content-type': 'application/json' }
    });
  }
  return realFetch(input, init);
};

const mod = await import(BOT + '/src/index.ts');
const ENV = {
  DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass', PUSH_PASSWORD: 'push-pass',
  DISCORD_BOT_TOKEN: 'bot-token',
  VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE,
  VAPID_SUBJECT: 'https://scs.example'
};
// the worker hands background work to ctx.waitUntil; the suite keeps
// the promises so it can wait for them before looking at what happened
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); } };
const settle = () => Promise.all(pending.splice(0));
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, ctx);
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
// the second password, when a push asks for it, rides in a header the
// way the dashboard sends it
const sendForm = (form, token, second) => front('/api/console/messages/save', {
  method: 'POST',
  headers: Object.assign(token ? { authorization: 'Bearer ' + token } : {}, second ? { 'x-second-password': second } : {}),
  body: form
});
const file = (name, type, bytes) => new File([bytes], name, { type });
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
// a JPEG with nothing to take out, as a canvas makes one
const thumbJpeg = new Uint8Array(64);
thumbJpeg.set([0xFF, 0xD8, 0xFF, 0xDA, 0, 2]);
thumbJpeg.set([0xFF, 0xD9], 62);
// a one-frame GIF with nothing in it to take out
const gifBytes = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0,
  0x2C, 0, 0, 0, 0, 1, 0, 1, 0, 0x80, 0, 0, 0, 255, 255, 255, 2, 2, 0x44, 0x01, 0, 0x3B]);

const sess = (await consoleSignIn(jpost, 'Comms', 'tab-pass')).session;

// ---------------- the pulse ----------------
let r = await get('/api/pulse');
let d = await r.json();
check('the pulse answers two numbers, open CORS, edge cached',
  r.status === 200 && d.quests === 0 && d.messages === 0 &&
  r.headers.get('access-control-allow-origin') === '*' &&
  (r.headers.get('cache-control') || '').includes('s-maxage=30'), JSON.stringify(d));

// the live tab polls these two every 10 seconds (scs2-tab.js REFRESH_MS),
// so the edge keeps them for 10, not the 30 every other read gets
{
  const live = [await get('/api/leaderboard'), await get('/api/stats')].map(x => x.headers.get('cache-control') || '');
  check('the leaderboard and the stats are edge cached for the 10 seconds the live tab polls at',
    live.every(c => c.includes('s-maxage=10')), JSON.stringify(live));
}

// A device that holds the answer already is told so with no body, from
// the edge copy and from a fresh build alike, weak tag or strong, and
// the 304 keeps the CORS header the browser checks it against.
{
  const store = new Map();
  const keyOf = k => typeof k === 'string' ? k : k.url;
  const was = globalThis.caches;
  globalThis.caches = { default: {
    async match(k) { const hit = store.get(keyOf(k)); return hit ? hit.clone() : undefined; },
    async put(k, res) { store.set(keyOf(k), res); },
    async delete(k) { return store.delete(keyOf(k)); }
  } };
  const ask = (tag) => front('/api/questlist', { headers: { 'if-none-match': tag } });
  const first = await get('/api/questlist');
  const list = await first.json();
  const tag = first.headers.get('etag') || '';
  const answers = [await ask(tag), await ask(tag.replace(/^W\//, ''))];
  store.clear();
  answers.push(await ask(tag));
  const other = await ask('W/"0"');
  globalThis.caches = was;
  check('a cached read answers 304 with its CORS header to the tag it gave, and the body to any other',
    /^W\/"[0-9a-f]+"$/.test(tag) && typeof list.version === 'number' &&
    answers.every(a => a.status === 304 && a.headers.get('access-control-allow-origin') === '*' &&
      a.headers.get('etag') === tag) &&
    other.status === 200 && Array.isArray((await other.json()).groups),
    JSON.stringify({ tag, version: list.version, statuses: answers.map(a => a.status), other: other.status }));
}

r = await get('/api/messages');
d = await r.json();
check('the messages payload starts empty and carries CORS',
  r.status === 200 && Array.isArray(d.messages) && d.messages.length === 0 &&
  r.headers.get('access-control-allow-origin') === '*', JSON.stringify(d));

// ---------------- posting ----------------
{
  const f = new FormData();
  f.append('title', 'Briefing 1');
  f.append('body', 'The **west** run opens at noon.\nBring a printed map.');
  r = await sendForm(f);
  check('posting needs a dashboard session', r.status === 401, 'status=' + r.status);
}
{
  const f = new FormData();
  f.append('body', 'No title on this one.');
  r = await sendForm(f, sess);
  check('a message without a title is refused', r.status === 400, 'status=' + r.status);
}

purged.length = 0;
let first;
{
  const f = new FormData();
  f.append('title', 'Briefing 1');
  f.append('body', 'The **west** run opens at noon.\nBring a printed map.');
  r = await sendForm(f, sess);
  first = await r.json();
  check('a message posts', r.status === 200 && first.ok && typeof first.id === 'number', JSON.stringify(first));
}
check('posting purges the pulse and the messages from the edge cache',
  purged.some(u => u.endsWith('/api/pulse')) && purged.some(u => u.endsWith('/api/messages')),
  JSON.stringify(purged));

d = await (await get('/api/pulse')).json();
check('a new message moves the messages counter and leaves quests alone',
  d.messages === 1 && d.quests === 0, JSON.stringify(d));

// editing must not move it: the page already has the message
{
  const f = new FormData();
  f.append('id', String(first.id));
  f.append('title', 'Briefing 1 — corrected');
  f.append('body', 'The west run opens at one.');
  r = await sendForm(f, sess);
  check('an edit saves', (await r.json()).ok === true, '');
}
d = await (await get('/api/pulse')).json();
check('editing a message does not move the counter', d.messages === 1, JSON.stringify(d));

// a quest write moves the other one, once per request
{
  r = await jpost('/api/console/quests/add', { code: 'MSG1', points: 10 }, sess);
  check('a quest can be added beside all this', (await r.json()).ok === true, '');
}
d = await (await get('/api/pulse')).json();
check('a quests/* write moves the quests counter', d.quests === 1 && d.messages === 1, JSON.stringify(d));
await jpost('/api/console/quests/edit', { code: 'MSG1', points: 20 }, sess);
d = await (await get('/api/pulse')).json();
check('each quest write is one step, not several', d.quests === 2, JSON.stringify(d));
await jpost('/api/console/teams/add', { name: 'Messages Test Crew' }, sess);
d = await (await get('/api/pulse')).json();
check('a write that is not about quests leaves the quests counter alone', d.quests === 2, JSON.stringify(d));

// ---------------- the manual setter ----------------
r = await jpost('/api/console/counters/set', { name: 'nonsense', value: 3 }, sess);
check('only the two counters can be set', r.status === 400, 'status=' + r.status);
r = await jpost('/api/console/counters/set', { name: 'quests', value: -1 }, sess);
check('a negative value is refused', r.status === 400, 'status=' + r.status);
r = await jpost('/api/console/counters/set', { name: 'quests', value: 2.5 }, sess);
check('so is a fraction', r.status === 400, 'status=' + r.status);
r = await jpost('/api/console/counters/set', { name: 'quests', value: 41 }, sess);
d = await r.json();
check('an organiser can set a counter to any whole number', d.ok && d.counters.quests === 41, JSON.stringify(d));
d = await (await get('/api/pulse')).json();
check('the pulse answers with the set value', d.quests === 41, JSON.stringify(d));
r = await get('/api/console/counters', sess);
check('the dashboard reads both counters back', (await r.json()).counters.messages === 1, '');

// ---------------- the public payload ----------------
let second;
{
  const f = new FormData();
  f.append('title', 'Briefing 2');
  f.append('body', 'Checkpoint moved to Redfern.');
  f.append('file0', file('map.png', 'image/png', png), 'map.png');
  f.append('thumb0', file('thumb.jpg', 'image/jpeg', thumbJpeg), 'thumb.jpg');
  f.append('file1', file('times.pdf', 'application/pdf', new Uint8Array(2048)), 'times.pdf');
  r = await sendForm(f, sess);
  second = await r.json();
  check('a message with a picture and a PDF posts', r.status === 200 && second.added === 2, JSON.stringify(second));
}
let draft;
{
  const beforeDraft = (await (await get('/api/pulse')).json()).messages;
  const f = new FormData();
  f.append('title', 'Draft for later');
  f.append('body', 'Not ready yet.');
  f.append('hidden', '1');
  r = await sendForm(f, sess);
  draft = await r.json();
  check('a draft saves too', draft.hidden === 1, '');
  check('a draft moves nothing: it is not on the site yet',
    (await (await get('/api/pulse')).json()).messages === beforeDraft, '');
}
{
  const f = new FormData();
  f.append('title', 'Draft for later');
  f.append('push', '1');
  f.append('hidden', '1');
  r = await sendForm(f, sess, 'push-pass');
  check('a draft cannot be pushed', r.status === 400, 'status=' + r.status);
}

d = await (await get('/api/messages')).json();
check('the site sees published messages newest first, drafts left out',
  d.messages.length === 2 && d.messages[0].title === 'Briefing 2' &&
  d.messages[1].title === 'Briefing 1 — corrected',
  JSON.stringify(d.messages.map(m => m.title)));
check('the body goes out as written, markdown and line breaks intact',
  d.messages[1].body === 'The west run opens at one.' &&
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d.messages[0].created_at),
  JSON.stringify(d.messages[0].created_at));
const files = d.messages[0].files;
check('attachments come with the message, in order, without row ids',
  files.length === 2 && files[0].name === 'map.png' && files[0].type === 'image/png' &&
  files[1].name === 'times.pdf' && files[1].bytes === 2048 && files[0].id === undefined &&
  files[0].key.indexOf('msg/') === 0, JSON.stringify(files));
check('the dashboard list carries the drafts and the file row ids',
  (await (await get('/api/console/messages/list', sess)).json()).messages.length === 3, '');

// ---------------- attachments by their keys ----------------
r = await front('/api/messages/file?key=' + encodeURIComponent(files[0].key));
check('an attachment serves to anyone holding its key, cached forever',
  r.status === 200 && (await r.arrayBuffer()).byteLength === png.length &&
  (r.headers.get('cache-control') || '').includes('immutable') &&
  r.headers.get('access-control-allow-origin') === '*', 'status=' + r.status);
r = await front('/api/messages/file?key=' + encodeURIComponent(files[0].key) + '&thumb=1');
check('thumb=1 serves the small copy', r.status === 200 && (await r.arrayBuffer()).byteLength === 64, 'status=' + r.status);
r = await front('/api/messages/file?key=' + encodeURIComponent(files[1].key) + '&thumb=1');
check('a file with no small copy falls back to the whole thing',
  r.status === 200 && (await r.arrayBuffer()).byteLength === 2048, 'status=' + r.status);
// what a channel sees under a pasted link is the picture, not the
// page's thumbnail — and that answer is not cached under the small URL
r = await front('/api/messages/file?key=' + encodeURIComponent(files[0].key) + '&thumb=1', {
  headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' }
});
check('a link preview asking for the thumbnail is handed the whole picture',
  r.status === 200 && (await r.arrayBuffer()).byteLength === png.length &&
  r.headers.get('cache-control') === 'private, no-store', 'status=' + r.status);
r = await front('/api/messages/file?key=msg/not-a-real-key');
check('a key that is not in the table is not found', r.status === 404, 'status=' + r.status);
r = await front('/api/messages/file?key=' + encodeURIComponent('sub/1/abc'));
check('nothing outside the msg/ prefix is reachable here', r.status === 404, 'status=' + r.status);
// the bytes really are gated on the row, not just on the prefix
bucket.set('msg/orphan', { bytes: new Uint8Array([9, 9, 9]), meta: {} });
r = await front('/api/messages/file?key=msg/orphan');
check('a stray object with no row stays unreachable', r.status === 404, 'status=' + r.status);

// ---------------- what a message may carry ----------------
{
  const f = new FormData();
  f.append('title', 'Wrong sort of file');
  f.append('file0', file('run.exe', 'application/x-msdownload', png), 'run.exe');
  r = await sendForm(f, sess);
  check('an executable is refused in plain words',
    r.status === 400 && /not a JPEG, PNG or GIF, a PDF or a document/.test((await r.json()).error), 'status=' + r.status);
}
for (const [name, type, bytes] of [
  ['map.webp', 'image/webp', new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80])],
  ['map.svg', 'image/svg+xml', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')],
  ['map.png', 'image/png', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')]
]) {
  const f = new FormData();
  f.append('title', 'Wrong sort of picture');
  f.append('file0', file(name, type, bytes), name);
  r = await sendForm(f, sess);
  check('a picture the stripper cannot clean, or one that is not what it says, is refused: ' + name + ' as ' + type, r.status === 400, 'status=' + r.status);
}
{
  const f = new FormData();
  f.append('title', 'Too big');
  const huge = new Uint8Array(26 * 1024 * 1024);
  huge.set(png);
  f.append('file0', file('huge.png', 'image/png', huge), 'huge.png');
  r = await sendForm(f, sess);
  check('a file over 25MB is refused', r.status === 413, 'status=' + r.status);
}
{
  const f = new FormData();
  f.append('title', 'Seven files');
  for (let i = 0; i < 7; i++) f.append('file' + i, file(i + '.png', 'image/png', png), i + '.png');
  r = await sendForm(f, sess);
  check('seven files is one too many', r.status === 400, 'status=' + r.status);
}
check('none of the refused saves left a message behind',
  raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n === 3, '');

// ---------------- the push that rides with a message ----------------
// two real subscriptions, so a send can be decrypted the way a browser
// would decrypt it
function makeClient(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, ecdh, authSecret: crypto.randomBytes(16) };
}
const clientA = makeClient('https://push.example/dev/aaaa');
const clientB = makeClient('https://push.example/dev/bbbb');
for (const c of [clientA, clientB]) {
  await jpost('/api/push/subscribe', {
    endpoint: c.endpoint,
    keys: { p256dh: c.ecdh.getPublicKey().toString('base64url'), auth: c.authSecret.toString('base64url') }
  });
}
function decryptPush(client, body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipher = body.subarray(21 + idlen);
  const shared = client.ecdh.computeSecret(asPublic);
  const NUL = Buffer.from([0]);
  const info = Buffer.concat([Buffer.from('WebPush: info'), NUL, client.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, client.authSecret, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.concat([Buffer.from('Content-Encoding: aes128gcm'), NUL]), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.concat([Buffer.from('Content-Encoding: nonce'), NUL]), 12));
  const tag = cipher.subarray(cipher.length - 16);
  const enc = cipher.subarray(0, cipher.length - 16);
  const dec = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  dec.setAuthTag(tag);
  const plain = Buffer.concat([dec.update(enc), dec.final()]);
  return plain.subarray(0, plain.length - 1).toString();
}

const before = raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
pushed.length = 0;
{
  const f = new FormData();
  f.append('title', 'Course change');
  f.append('body', 'Redfern is out.');
  f.append('push', '1');
  r = await sendForm(f, sess, 'not-the-password');
  check('a wrong push password is refused without killing the session', r.status === 403, 'status=' + r.status);
}
check('a refused push saves nothing at all',
  raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n === before && pushed.length === 0,
  JSON.stringify({ messages: raw.prepare('SELECT COUNT(*) AS n FROM messages').get().n, pushed: pushed.length }));

{
  const f = new FormData();
  f.append('title', 'Course change');
  f.append('body', '## Heading\n\nRedfern is **out**. Use [Waterloo](https://example.com) instead.');
  f.append('push', '1');
  r = await sendForm(f, sess, 'push-pass');
  d = await r.json();
  check('the right password posts the message and sends the push',
    r.status === 200 && d.ok && d.push && d.push.sent === 2 && d.push.remaining === 0, JSON.stringify(d));
}
check('one push per subscribed device, at announcement urgency',
  pushed.length === 2 && pushed.every(p => p.headers.urgency === 'high' && p.headers.topic === 'announce'),
  JSON.stringify(pushed.map(p => p.url)));
const plain = JSON.parse(decryptPush(clientA, pushed.find(p => p.url === clientA.endpoint).body));
check('the notification carries the title and the body as words, pointed at the messages page',
  plain.title === 'Course change' && plain.url === '/messages/' &&
  plain.body === 'Heading Redfern is out. Use Waterloo instead.' &&
  plain.tag === 'scs2-announce' && plain.renotify === true, JSON.stringify(plain));
d = await (await get('/api/pulse')).json();
check('the pushed message moved the counter like any other', d.messages === 3, JSON.stringify(d));

// with no PUSH_PASSWORD set, the tick is locked the same way the tab is
{
  const f = new FormData();
  f.append('title', 'Locked out');
  f.append('push', '1');
  r = await mod.default.fetch(new Request('https://bot.example/api/console/messages/save', {
    method: 'POST', headers: { authorization: 'Bearer ' + sess, 'x-second-password': 'anything' }, body: f
  }), { DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass' }, { waitUntil() {} });
  check('no PUSH_PASSWORD means the tick refuses rather than posting quietly',
    r.status === 403 && /PUSH_PASSWORD/.test((await r.json()).error), 'status=' + r.status);
}

// ---------------- removing things ----------------
r = await jpost('/api/console/messages/file/delete', { id: 999999 }, sess);
check('removing an attachment that is not there says so', r.status === 404, 'status=' + r.status);
const consoleList = (await (await get('/api/console/messages/list', sess)).json()).messages;
const withFiles = consoleList.find(m => m.title === 'Briefing 2');
const pdfRow = withFiles.files.find(f => f.name === 'times.pdf');
r = await jpost('/api/console/messages/file/delete', { id: pdfRow.id }, sess);
check('an attachment can be taken off a message',
  (await r.json()).ok === true && !bucket.has(pdfRow.key), '');
d = await (await get('/api/messages')).json();
check('the message keeps its other file', d.messages.find(m => m.title === 'Briefing 2').files.length === 1, '');

const pictureKey = withFiles.files.find(f => f.name === 'map.png').key;
r = await jpost('/api/console/messages/delete', { id: withFiles.id }, sess);
check('deleting a message takes its rows and its bytes with it',
  (await r.json()).ok === true && !bucket.has(pictureKey) && !bucket.has(pictureKey + '.t') &&
  raw.prepare('SELECT COUNT(*) AS n FROM message_files WHERE message_id = ?').get(withFiles.id).n === 0, '');
r = await front('/api/messages/file?key=' + encodeURIComponent(pictureKey));
check('its files stop serving', r.status === 404, 'status=' + r.status);
d = await (await get('/api/pulse')).json();
check('deleting does not move the counter either', d.messages === 3, JSON.stringify(d));

// ---------------- the audit log ----------------
const actions = (await (await get('/api/console/log?limit=60', sess)).json()).entries.map(e => e.action);
check('every message action is in the log',
  ['message-post', 'message-edit', 'message-delete', 'counter-set'].every(a => actions.includes(a)),
  JSON.stringify([...new Set(actions)]));

// ---------------- a frozen tab still talks ----------------
r = await jpost('/api/console/freeze', { frozen: true }, sess);
check('the tab freezes', (await r.json()).frozen === true, '');
const board = await (await get('/api/leaderboard')).json();
check('the standings serve the copy taken at the freeze', board.frozen === true, JSON.stringify(board.frozen));

// a message posted during the freeze must still reach everyone
{
  const f = new FormData();
  f.append('title', 'Frozen but talking');
  f.append('body', 'The tab is stopped; the run is not.');
  r = await sendForm(f, sess);
  check('an organiser can still post while the tab is frozen', (await r.json()).ok === true, '');
}
r = await get('/api/pulse');
d = await r.json();
check('the pulse answers live while the tab is frozen',
  r.status === 200 && d.messages === 4 && d.frozen === undefined, JSON.stringify(d));
r = await get('/api/messages');
d = await r.json();
check('and the messages themselves, the new one included',
  r.status === 200 && d.frozen === undefined && d.messages[0].title === 'Frozen but talking',
  JSON.stringify(d.messages.map(m => m.title)));
// ---------------- a GIF is never served as a still ----------------
// The preview a browser can make of a GIF is its first frame, so
// serving one in the animation's place is the animation not playing.
let gifFile;
{
  const f = new FormData();
  f.append('title', 'It moves');
  f.append('file0', file('wave.gif', 'image/gif', gifBytes), 'wave.gif');
  f.append('thumb0', file('wave.jpg', 'image/jpeg', thumbJpeg), 'wave.jpg');
  r = await sendForm(f, sess);
  check('a message with a GIF posts', (await r.json()).added === 1, 'status=' + r.status);
  const list = (await (await get('/api/messages')).json()).messages;
  gifFile = list[0].files[0];
}
check('the still sent beside a GIF is not kept at all',
  !bucket.has(gifFile.key + '.t'), gifFile.key);
r = await front('/api/messages/file?key=' + encodeURIComponent(gifFile.key) + '&thumb=1');
check('asking for a GIF thumbnail serves the whole GIF',
  r.status === 200 && (await r.arrayBuffer()).byteLength === gifBytes.length &&
  r.headers.get('content-type') === 'image/gif', 'status=' + r.status);
// Discord decides whether a link is a picture from the URL's shape,
// so the same file also answers at a path that ends in its name
r = await front('/api/messages/file/' + gifFile.key + '/wave.gif');
check('the same file answers at a path ending in its name',
  r.status === 200 && (await r.arrayBuffer()).byteLength === gifBytes.length &&
  r.headers.get('content-type') === 'image/gif', 'status=' + r.status);
r = await front('/api/messages/file/msg/not-a-real-key/wave.gif');
check('the path form checks the key like the query form does', r.status === 404, 'status=' + r.status);

check('the two live paths are not in the frozen list',
  (await import(BOT + '/src/freeze.ts')).FROZEN_PATHS.indexOf('/api/pulse') === -1 &&
  (await import(BOT + '/src/freeze.ts')).FROZEN_PATHS.indexOf('/api/messages') === -1, '');
await jpost('/api/console/freeze', { frozen: false }, sess);

// ---------------- urgency ----------------
const pulse = async () => (await (await get('/api/pulse')).json());
const publicMessages = async () => (await (await get('/api/messages')).json()).messages;
async function postMessage(fields) {
  const f = new FormData();
  Object.keys(fields).forEach(k => f.append(k, fields[k]));
  const res = await sendForm(f, sess);
  await settle();
  return { status: res.status, data: await res.json() };
}

check('the pulse names no urgent message when there is none', (await pulse()).urgent === 0, '');

// publishing a draft is not an ordinary edit: it is the first time
// anyone can read it, so the counter moves then
const beforePublish = (await pulse()).messages;
{
  const f = new FormData();
  f.append('id', String(draft.id));
  f.append('title', 'Draft for later');
  f.append('body', 'Ready now.');
  f.append('hidden', '0');
  r = await sendForm(f, sess);
  await settle();
  check('a draft can be published', (await r.json()).hidden === 0, '');
}
check('publishing a draft moves the counter', (await pulse()).messages === beforePublish + 1, '');
check('and it is on the site', (await publicMessages()).some(m => m.id === draft.id), '');
{
  const f = new FormData();
  f.append('id', String(draft.id));
  f.append('title', 'Draft for later');
  f.append('body', 'Ready now, with a typo fixed.');
  r = await sendForm(f, sess);
  await settle();
}
check('a later edit of it moves nothing', (await pulse()).messages === beforePublish + 1, '');

let before5 = (await pulse()).messages;
let silent = await postMessage({ title: 'Water at the halfway point', body: 'By the fountain.', urgency: 'silent' });
check('a silent message posts', silent.status === 200 && silent.data.urgency === 'silent', JSON.stringify(silent.data));
d = await pulse();
check('a silent message moves nothing: no counter, no urgent mark',
  d.messages === before5 && d.urgent === 0, JSON.stringify(d));
check('but it is on the site all the same, marked silent',
  (await publicMessages()).some(m => m.id === silent.data.id && m.urgency === 'silent'), '');

const urgent1 = await postMessage({ title: 'Stay clear of Central', body: 'Police are closing the concourse.', urgency: 'urgent' });
d = await pulse();
check('an urgent message moves the counter and names itself in the pulse',
  d.messages === before5 + 1 && d.urgent === urgent1.data.id, JSON.stringify(d));
const urgent2 = await postMessage({ title: 'Central is open again', body: 'Carry on.', urgency: 'urgent' });
check('the newest urgent one is the one named', (await pulse()).urgent === urgent2.data.id, '');

r = await jpost('/api/console/messages/archive', { id: urgent2.data.id, archived: true }, sess);
check('archiving answers with the new state', (await r.json()).archived === 1, '');
check('an archived urgent message is not named any more',
  (await pulse()).urgent === urgent1.data.id, '');
await postMessage({ id: String(urgent1.data.id), title: 'Stay clear of Central', body: 'Old news.', urgency: 'urgent', hidden: '1' });
check('nor is a hidden one', (await pulse()).urgent === 0, '');
{
  const f = new FormData();
  f.append('title', 'Nonsense urgency');
  f.append('urgency', 'shouting');
  r = await sendForm(f, sess);
  check('urgency has to be one of the three', r.status === 400, 'status=' + r.status);
}

// ---------------- archiving ----------------
let live = await publicMessages();
check('neither the archived nor the hidden one is on the site',
  !live.some(m => m.id === urgent1.data.id) && !live.some(m => m.id === urgent2.data.id),
  JSON.stringify(live.map(m => m.title)));
let dash = (await (await get('/api/console/messages/list', sess)).json()).messages;
check('the dashboard keeps both, flagged',
  dash.find(m => m.id === urgent2.data.id).archived === 1 &&
  dash.find(m => m.id === urgent1.data.id).hidden === 1, '');
r = await jpost('/api/console/messages/archive', { id: urgent2.data.id, archived: false }, sess);
check('unarchiving puts it back on the site',
  (await r.json()).archived === 0 && (await publicMessages()).some(m => m.id === urgent2.data.id), '');
check('and it is named in the pulse again', (await pulse()).urgent === urgent2.data.id, '');
r = await jpost('/api/console/messages/archive', { id: 999999, archived: true }, sess);
check('archiving something that is not there says so', r.status === 404, 'status=' + r.status);
const archiveActions = (await (await get('/api/console/log?limit=20', sess)).json()).entries.map(e => e.action);
check('archiving and unarchiving are both in the log',
  archiveActions.includes('message-archive') && archiveActions.includes('message-unarchive'),
  JSON.stringify([...new Set(archiveActions)]));

// ---------------- the order the site shows them in ----------------
live = await publicMessages();
const reversed = live.slice().reverse().map(m => m.id);
r = await jpost('/api/console/messages/order', { ids: reversed }, sess);
check('the whole visible list can be put in an order',
  (await r.json()).ordered === reversed.length, '');
check('the payload comes back in exactly that order',
  JSON.stringify((await publicMessages()).map(m => m.id)) === JSON.stringify(reversed),
  JSON.stringify((await publicMessages()).map(m => m.id)));
const afterOrder = await postMessage({ title: 'Posted after the reshuffle', body: 'Newest.' });
check('a message posted afterwards still lands on top',
  (await publicMessages())[0].id === afterOrder.data.id, '');
r = await jpost('/api/console/messages/order', { ids: [] }, sess);
check('an empty order is refused', r.status === 400, 'status=' + r.status);

// ---------------- cross-posting to Discord ----------------
r = await jpost('/api/console/discord/guild/save', {
  guild_id: '123456789012', name: 'SCS.2', organiser_role_id: '987654321098',
  category_name: 'Private Channels', enabled: true, announce_channel_id: '555000111222'
}, sess);
check('a server can be given an announcement channel', (await r.json()).ok === true, '');
check('and it is stored',
  raw.prepare('SELECT announce_channel_id FROM discord_guilds WHERE guild_id = ?').get('123456789012')
    .announce_channel_id === '555000111222', '');

discordCalls.length = 0;
{
  const f = new FormData();
  f.append('title', 'Checkpoint 4 has moved');
  f.append('body', 'It is now under the **Goods Line** bridge.');
  f.append('file0', file('where.png', 'image/png', png), 'where.png');
  r = await sendForm(f, sess);
  d = await r.json();
  await settle();
  check('the message saves', r.status === 200 && d.ok, JSON.stringify(d));
}
const posted = discordCalls.filter(c => c.url.indexOf('/channels/555000111222/messages') !== -1);
check('the bot posted it in the announcement channel, once', posted.length === 1,
  JSON.stringify(discordCalls.map(c => c.url)));
check('the post carries the title in bold, the body, and a link to the file',
  posted[0].body.content.indexOf('**Checkpoint 4 has moved**') === 0 &&
  posted[0].body.content.includes('It is now under the **Goods Line** bridge.') &&
  /where\.png: https:\/\/bot\.example\/api\/messages\/file\/msg\/[\w-]+\/where\.png/.test(posted[0].body.content),
  JSON.stringify(posted[0].body.content));
check('and pings nobody',
  JSON.stringify(posted[0].body.allowed_mentions) === JSON.stringify({ parse: [] }), '');

// ---- a quest token in the body: the site gets the card, Discord and
// notifications get the quest's name (with a link for Discord) ----
raw.prepare('INSERT INTO quest_groups (key, name) VALUES (?, ?)').run('SQ40', 'Ride the ferry');
const groupId = raw.prepare('SELECT id FROM quest_groups WHERE key = ?').get('SQ40').id;
raw.prepare('INSERT INTO quests (code, norm, points, group_id) VALUES (?, ?, ?, ?)')
  .run('SQ40-B', 'SQ40-B', 5, groupId);
const msgMod = await import(BOT + '/src/messages.ts');
const withLink = await msgMod.expandQuestTokens(db, 'Do this one:\n[[quest:SQ40]]\nGo.', true);
check('a quest token becomes the quest and a link to it',
  withLink === 'Do this one:\nSQ40 — Ride the ferry: https://scs.andyrew.space/questlist/#SQ40\nGo.',
  JSON.stringify(withLink));
check('a token naming any of its codes finds the same quest',
  (await msgMod.expandQuestTokens(db, '[[quest:sq40-b]]', false)) === 'SQ40 — Ride the ferry', '');
check('for a notification the name comes without the link',
  (await msgMod.expandQuestTokens(db, '[[quest:SQ40]]', false)) === 'SQ40 — Ride the ferry', '');
check('an unknown key passes through as typed, still a working link',
  (await msgMod.expandQuestTokens(db, '[[quest:ZZ9]]', true)) === 'ZZ9: https://scs.andyrew.space/questlist/#ZZ9', '');
check('a token in running text is left alone — only a line of its own embeds',
  (await msgMod.expandQuestTokens(db, 'see [[quest:SQ40]] here', true)) === 'see [[quest:SQ40]] here', '');

discordCalls.length = 0;
{
  const f = new FormData();
  f.append('title', 'Ferry quest is live');
  f.append('body', 'Points doubled until noon.\n\n[[quest:SQ40]]');
  r = await sendForm(f, sess);
  d = await r.json();
  await settle();
}
const tokenPost = discordCalls.filter(c => c.url.indexOf('/channels/555000111222/messages') !== -1);
check('the cross-post carries the quest, not the token',
  tokenPost.length === 1 &&
  tokenPost[0].body.content.includes('SQ40 — Ride the ferry: https://scs.andyrew.space/questlist/#SQ40') &&
  !tokenPost[0].body.content.includes('[[quest:'),
  JSON.stringify(tokenPost.length ? tokenPost[0].body.content : discordCalls.map(c => c.url)));
check('while the site payload keeps the token for the page to render',
  (await publicMessages()).some(m => (m.body || '').includes('[[quest:SQ40]]')),
  '');

discordCalls.length = 0;
await postMessage({ id: String(afterOrder.data.id), title: 'Posted after the reshuffle', body: 'Edited.' });
check('an edit is not posted to Discord again', discordCalls.length === 0, JSON.stringify(discordCalls.length));

discordCalls.length = 0;
await postMessage({ title: 'Kept off Discord', body: 'Site only.', discord: '0' });
check('the tick can be turned off', discordCalls.length === 0, JSON.stringify(discordCalls.length));

// Discord being unreachable or unwilling must not cost the message
discordFails = true;
discordCalls.length = 0;
const troubled = await postMessage({ title: 'Discord will refuse this one', body: 'It saves anyway.' });
discordFails = false;
check('a Discord failure does not fail the save',
  troubled.status === 200 && troubled.data.ok &&
  (await publicMessages()).some(m => m.id === troubled.data.id), JSON.stringify(troubled.data));
check('the bot did try', discordCalls.length > 0, String(discordCalls.length));
const failLog = (await (await get('/api/console/log?limit=20', sess)).json()).entries
  .filter(e => e.action === 'message-discord');
check('the cross-post writes what happened to the log, refusals included',
  failLog.length >= 2 && failLog.some(e => /Missing Access|cannot/i.test(e.quest_code)),
  JSON.stringify(failLog.map(e => e.quest_code)));

// a server with no announcement channel is simply left out
await jpost('/api/console/discord/guild/save', {
  guild_id: '123456789012', name: 'SCS.2', organiser_role_id: '987654321098',
  category_name: 'Private Channels', enabled: true, announce_channel_id: ''
}, sess);
discordCalls.length = 0;
await postMessage({ title: 'Nowhere to post it', body: 'No channel set.' });
check('no announcement channel means no cross-post at all', discordCalls.length === 0, String(discordCalls.length));

// ---------------- one worker, several hostnames ----------------
// The site and the dashboard both reach this worker.
// Two things must not be left to whichever one a request arrived on:
// the links the bot posts in a public channel, and the edge cache,
// which is keyed by the whole URL — so a copy stored under one
// hostname is invisible to a purge aimed at another.
{
  ENV.PUBLIC_API = 'https://files.example';
  await jpost('/api/console/discord/guild/save', {
    guild_id: '123456789012', name: 'SCS.2', organiser_role_id: '987654321098',
    category_name: 'Private Channels', enabled: true, announce_channel_id: '555000111222'
  }, sess);
  discordCalls.length = 0;
  purged.length = 0;
  const f = new FormData();
  f.append('title', 'Posted from the dashboard');
  f.append('body', 'The link must not carry this hostname.');
  f.append('file0', file('plan.png', 'image/png', png), 'plan.png');
  // as if an organiser saved it from the dashboard's own hostname
  r = await mod.default.fetch(new Request('https://dashboard.example/api/console/messages/save', {
    method: 'POST', headers: { authorization: 'Bearer ' + sess }, body: f
  }), ENV, ctx);
  check('a save from the dashboard hostname goes through', r.status === 200, 'status=' + r.status);
  await settle();
  const link = discordCalls.filter(c => c.url.indexOf('/channels/555000111222/messages') !== -1);
  check('the link posted in Discord carries the public hostname, not the dashboard one',
    link.length === 1 && /https:\/\/files\.example\/api\/messages\/file\/msg\/[\w-]+\/plan\.png/.test(link[0].body.content) &&
    link[0].body.content.indexOf('dashboard.example') === -1,
    JSON.stringify(link.length ? link[0].body.content : null));
  const hosts = {};
  purged.forEach(u => { hosts[new URL(u).origin] = true; });
  check('and the purge reaches every hostname a reader might be cached under',
    hosts['https://dashboard.example'] && hosts['https://files.example'] &&
    purged.some(u => u === 'https://files.example/api/leaderboard'),
    JSON.stringify(Object.keys(hosts)));
  delete ENV.PUBLIC_API;
}

// ---------------- who reads a message ----------------
// The same audiences a quest has. Two teams, a team group holding the
// first, a phone linked to each, and a team channel each on the server.
{
  await jpost('/api/console/codes/generate', {}, sess);
  const codeList = (await (await get('/api/console/codes', sess)).json()).codes;
  const [teamA, teamB] = raw.prepare('SELECT id, name FROM teams WHERE hidden = 0 ORDER BY id LIMIT 2').all();
  const login = async t => (await (await jpost('/api/submit/login', {
    team_name: t.name, code: codeList.find(c => c.name === t.name).code
  })).json()).session;
  const sessA = await login(teamA);
  const sessB = await login(teamB);
  const group = (await (await jpost('/api/console/quests/team-groups/save', { name: 'Night crew', team_ids: [teamA.id] }, sess)).json()).id;
  const phoneA = makeClient('https://push.example/dev/team-a');
  const phoneB = makeClient('https://push.example/dev/team-b');
  for (const [c, s] of [[phoneA, sessA], [phoneB, sessB]]) {
    await jpost('/api/push/subscribe', {
      endpoint: c.endpoint,
      keys: { p256dh: c.ecdh.getPublicKey().toString('base64url'), auth: c.authSecret.toString('base64url') }
    }, s);
  }
  raw.prepare("INSERT INTO discord_teams (guild_id, team_id, role_id, channel_id) VALUES ('123456789012', ?, 'r1', '700000000001')").run(teamA.id);
  raw.prepare("INSERT INTO discord_teams (guild_id, team_id, role_id, channel_id) VALUES ('123456789012', ?, 'r2', '700000000002')").run(teamB.id);

  const teamPulse = async s => (await (await get('/api/pulse/team', s)).json());
  const teamMessages = async s => (await (await get('/api/messages/team', s)).json()).messages;
  const publicBefore = await pulse();
  const bBefore = await teamPulse(sessB);

  r = await postMessage({ title: 'For the night crew', body: 'Meet at Central.', visibility: 'groups', audiences: '' });
  check('a message for team groups with none picked is refused', r.status === 400, JSON.stringify(r.data));

  pushed.length = 0;
  discordCalls.length = 0;
  {
    const f = new FormData();
    f.append('title', 'For the night crew');
    f.append('body', 'Meet at Central.');
    f.append('visibility', 'groups');
    f.append('audiences', String(group));
    f.append('push', '1');
    r = await sendForm(f, sess, 'push-pass');
    d = await r.json();
    await settle();
  }
  const crew = d.id;
  const signedOut = await get('/api/messages/team');
  check('a team only reads its own list signed in', signedOut.status === 401, 'status=' + signedOut.status);
  const seenBy = {
    public: (await publicMessages()).some(m => m.id === crew),
    a: (await teamMessages(sessA)).some(m => m.id === crew),
    b: (await teamMessages(sessB)).some(m => m.id === crew)
  };
  check('a message for a team group is read by that group\'s teams and nobody else',
    !seenBy.public && seenBy.a && !seenBy.b, JSON.stringify(seenBy));
  const lit = { public: await pulse(), a: await teamPulse(sessA), b: await teamPulse(sessB) };
  check('and it lights the bell of those teams only',
    lit.public.messages === publicBefore.messages && lit.b.messages === bBefore.messages &&
    lit.a.messages > publicBefore.messages && lit.a.message_seqs[0] === lit.a.messages,
    JSON.stringify({ public: lit.public.messages, a: lit.a.messages, b: lit.b.messages }));
  check('its push reaches the phones signed in to those teams and no others',
    d.push && d.push.sent === 1 && pushed.length === 1 && pushed[0].url === phoneA.endpoint,
    JSON.stringify(pushed.map(p => p.url)));
  check('and Discord gets it in those teams\' channels, not the announcements channel',
    discordCalls.length === 1 && discordCalls[0].url.indexOf('/channels/700000000001/messages') !== -1,
    JSON.stringify(discordCalls.map(c => c.url)));

  const forTeams = await postMessage({ title: 'Teams only', body: 'Keep this off the public page.', visibility: 'teams', urgency: 'urgent' });
  const urgent = { public: (await pulse()).urgent, b: (await teamPulse(sessB)).urgent };
  check('a message for signed-in teams reaches every team, and its urgent mark too',
    !(await publicMessages()).some(m => m.id === forTeams.data.id) &&
    (await teamMessages(sessB)).some(m => m.id === forTeams.data.id) &&
    urgent.b === forTeams.data.id && urgent.public !== forTeams.data.id, JSON.stringify(urgent));

  const listed = (await (await get('/api/console/messages/list', sess)).json());
  const row = listed.messages.find(m => m.id === crew);
  check('the dashboard list says who reads each message and names the team groups',
    row.visibility === 'groups' && JSON.stringify(row.audiences) === JSON.stringify([group]) &&
    listed.team_groups.some(g => g.id === group && g.name === 'Night crew' && g.teams === 1),
    JSON.stringify({ row: { visibility: row.visibility, audiences: row.audiences }, groups: listed.team_groups }));

  await jpost('/api/console/quests/team-groups/delete', { id: group }, sess);
  check('deleting the team group takes the message away from its teams',
    !(await teamMessages(sessA)).some(m => m.id === crew), '');
}

// ---------------- a file sent straight to R2 ----------------
// With the R2 token set the dashboard sends an attachment to the bucket
// first and the save names it by id (src/staged.ts). The bucket is
// tests/pretend-r2.mjs, so the slice goes to an address the worker signed.
{
  const r2 = pretendR2();
  const denv = Object.assign({}, ENV, { SUBMIT: r2.SUBMIT }, r2.env);
  const dfront = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), denv, ctx);
  const auth = { authorization: 'Bearer ' + sess };
  const djson = { 'content-type': 'application/json', authorization: 'Bearer ' + sess };
  const start = await (await dfront('/api/console/upload/start', { method: 'POST', headers: djson,
    body: JSON.stringify({ purpose: 'msg', name: 'route.png', type: 'image/png', size: png.length }) })).json();
  const signed = await (await dfront('/api/console/upload/sign?id=' + start.id + '&n=1', { headers: auth })).json();
  await fetch(signed.url, { method: 'PUT', body: png });
  await dfront('/api/console/upload/finish', { method: 'POST', headers: djson, body: JSON.stringify({ id: start.id }) });
  const key = raw.prepare('SELECT r2_key FROM staged_uploads WHERE id = ?').get(start.id).r2_key;

  const f = new FormData();
  f.append('title', 'Straight to storage');
  f.append('discord', '0');
  f.append('staged0', String(start.id));
  f.append('thumb0', file('thumb.jpg', 'image/jpeg', thumbJpeg), 'thumb.jpg');
  const saved = await (await dfront('/api/console/messages/save', { method: 'POST', headers: auth, body: f })).json();
  const row = raw.prepare('SELECT key, name, bytes FROM message_files WHERE message_id = ?').get(saved.id);
  const whole = await dfront('/api/messages/file?key=' + encodeURIComponent(key));
  const small = await dfront('/api/messages/file?key=' + encodeURIComponent(key) + '&thumb=1');
  check('a file sent straight to R2 and saved by its id is the message\'s attachment where it already is, its small copy beside it',
    saved.ok && row && row.key === key && row.name === 'route.png' && row.bytes === png.length &&
    !raw.prepare('SELECT id FROM staged_uploads WHERE id = ?').get(start.id) &&
    whole.status === 200 && (await whole.arrayBuffer()).byteLength === png.length &&
    small.status === 200 && (await small.arrayBuffer()).byteLength === thumbJpeg.length &&
    r2.seen.part === 1 && r2.seen.refused === 0,
    JSON.stringify({ saved, row, whole: whole.status, small: small.status }));
  r2.restore();
}

// ---------------- the order messages went live in ----------------
// The site keeps the seqs it has read and the urgent ids it has put
// away, so both ends have to agree on what a seq is: the list carries
// the numbers the pulse names, a new one is above every one before it
// whatever the counter was set to, and the urgent message named is the
// one that went live last, not the one written last.
{
  const seqOf = id => raw.prepare('SELECT seq FROM messages WHERE id = ?').get(id).seq;
  const top = raw.prepare('SELECT MAX(seq) AS s FROM messages').get().s;
  await jpost('/api/console/counters/set', { name: 'messages', value: 1 }, sess);
  const plain = await postMessage({ title: 'After the counter went back', body: 'x', discord: '0' });
  const counted = (await (await get('/api/console/counters', sess)).json()).counters.messages;
  const now = await pulse();
  const listed = await publicMessages();
  check('a message posted after the counter is set back is numbered above every one before it, the counter follows, and the list carries the seqs the pulse names',
    seqOf(plain.data.id) === top + 1 && counted === top + 1 && now.messages === top + 1 &&
    now.message_seqs.every(s => listed.some(m => m.seq === s)) && listed.every(m => typeof m.seq === 'number'),
    JSON.stringify({ top, seq: seqOf(plain.data.id), counted, pulse: now.messages }));

  const named = [];
  // a draft written first, published after a newer urgent message
  const early = await postMessage({ title: 'Written first', body: 'x', urgency: 'urgent', hidden: '1', discord: '0' });
  const later = await postMessage({ title: 'Written second', body: 'x', urgency: 'urgent', discord: '0' });
  await postMessage({ id: String(early.data.id), title: 'Written first', body: 'x', urgency: 'urgent', hidden: '0' });
  named.push([(await pulse()).urgent, early.data.id]);
  // an older live message edited to urgent; editing it again renumbers nothing
  await postMessage({ id: String(plain.data.id), title: 'After the counter went back', body: 'x', urgency: 'urgent' });
  named.push([(await pulse()).urgent, plain.data.id]);
  const stamped = seqOf(plain.data.id);
  await postMessage({ id: String(plain.data.id), title: 'After the counter went back', body: 'y', urgency: 'urgent' });
  named.push([seqOf(plain.data.id), stamped]);
  // an urgent message unarchived while a newer one is live
  await jpost('/api/console/messages/archive', { id: later.data.id, archived: true }, sess);
  await jpost('/api/console/messages/archive', { id: later.data.id, archived: false }, sess);
  named.push([(await pulse()).urgent, later.data.id]);
  // a scheduled message going up after one written later
  const timed = await postMessage({ title: 'Goes up at noon', body: 'x', urgency: 'urgent', hidden: '1', discord: '0' });
  const after = await postMessage({ title: 'Posted before noon', body: 'x', urgency: 'urgent', discord: '0' });
  named.push([(await pulse()).urgent, after.data.id]);
  raw.prepare("UPDATE messages SET publish_at = datetime('now', '-1 minute') WHERE id = ?").run(timed.data.id);
  named.push([(await pulse()).urgent, timed.data.id]);
  check('the urgent message named is the one that went live last: a draft published, a message turned urgent, one unarchived, one scheduled; an ordinary edit renumbers nothing',
    named.every(([got, want]) => got === want), JSON.stringify(named));
}

// ---------------- a database behind the code ----------------
// the pulse is the one call every page makes: it answers zeros rather
// than failing when the tables are not there yet
const bare = new DatabaseSync(':memory:');
bare.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
bare.exec('DROP TABLE counters');
const barePulse = await mod.apiResponse('/api/pulse', d1Shim(bare));
check('a database without the counters table still answers the pulse',
  barePulse.quests === 0 && barePulse.messages === 0, JSON.stringify(barePulse));

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
