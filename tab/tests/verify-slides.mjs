// Run with: node tests/verify-slides.mjs   (needs Node 22+)
//
// The home page's slideshow, end to end against the real worker: the
// public list, the file endpoint and the four console actions behind
// them.
//
// Two things here are load-bearing. The list is site chrome, not
// standings, so it has to keep answering while the tab is frozen — the
// same argument the countdown and the pulse are routed on. And the
// pictures are photographs of real people at a real event, so what
// leaves the worker is the copy with the metadata taken out, never the
// file the camera wrote. A GIF goes through the same stripper and is
// served whole even when a thumbnail is asked for, because a still of
// an animation is the animation not playing.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';

import { consoleSignIn } from './console-signin.mjs';
import { stripImage } from '../src/strip.ts';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
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
    bucket.set(key, {
      bytes: await drain(value),
      meta: (opts && opts.httpMetadata) || {},
      custom: (opts && opts.customMetadata) || {}
    });
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
    return {
      body: bytes, size: hit.bytes.length, httpMetadata: hit.meta, customMetadata: hit.custom || {},
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
    };
  },
  async delete(key) { bucket.delete(key); }
};

// The edge cache, so a purge can be counted rather than assumed.
const purged = [];
globalThis.caches = { default: {
  async match() { return undefined; },
  async put() {},
  async delete(url) { purged.push(String(url)); return true; }
} };

const mod = await import(BOT + '/src/index.ts');
const ENV = {
  DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass',
  PUBLIC_API: 'https://files.example',
  SITE_URL: 'https://scs.example'
};
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

const sess = (await consoleSignIn(jpost, 'Comms', 'tab-pass')).session;

// ---------------- with nothing set ----------------
let r = await get('/api/slides');
let d = await r.json();
check('with no pictures the list is empty and still says ok — the state the site ships in',
  r.status === 200 && d.ok === true && Array.isArray(d.slides) && d.slides.length === 0,
  JSON.stringify(d));
check('and it is open CORS and cached like the rest of the public API',
  r.headers.get('access-control-allow-origin') === '*' &&
  (r.headers.get('cache-control') || '').includes('s-maxage'),
  r.headers.get('cache-control'));

// ---------------- the pictures ----------------
// A real-shaped PNG carrying a tEXt chunk, so the stripper has
// something to take out and the clean copy is provably a different
// file from the one that was uploaded.
function chunk(type, data) {
  const len = data.length;
  return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255]
    .concat([...type].map(c => c.charCodeAt(0)), data, [0, 0, 0, 0]);
}
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10].concat(
  chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
  chunk('tEXt', [...'Comment taken at 33.8688 S'].map(c => c.charCodeAt(0))),
  // an eXIf chunk, so there is a block to come out and be kept at .x
  chunk('eXIf', [73, 73, 42, 0, 8, 0, 0, 0, 0, 0]),
  chunk('IEND', [])
));
// GIF87a, one pixel, with nothing in it to take out: its clean copy is
// itself.
const gif = new Uint8Array([
  71, 73, 70, 56, 55, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255,
  44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59
]);
const thumbBytes = new Uint8Array([255, 216, 255, 217]);

function upload(name, type, bytes, alt, caption, token, withThumb) {
  const form = new FormData();
  form.append('file', new File([bytes], name, { type }));
  if (alt != null) form.append('alt', alt);
  if (caption != null) form.append('caption', caption);
  if (withThumb) form.append('thumb', new File([thumbBytes], 'thumb.jpg', { type: 'image/jpeg' }));
  return front('/api/console/slides/save', {
    method: 'POST',
    headers: token ? { authorization: 'Bearer ' + token } : {},
    body: form
  });
}

r = await upload('quad.png', 'image/png', png, 'Teams in the quad', '', '', true);
check('an upload without a session is refused', r.status === 401, 'status=' + r.status);

r = await upload('quad.png', 'image/png', png, '   ', '', sess, true);
check('a picture with no alt text is refused, because nobody using a screen reader could know it is there',
  r.status === 400 && /screen reader/.test((await r.json()).error), 'status=' + r.status);

r = await upload('team.webp', 'image/webp', png, 'A team at the finish', '', sess, true);
check('a picture type the stripper cannot read is refused at the door rather than left unservable',
  r.status === 400 && /JPEG, PNG or GIF/.test((await r.json()).error), 'status=' + r.status);

r = await upload('empty.png', 'image/png', new Uint8Array(0), 'Nothing', '', sess, true);
check('an empty file is refused', r.status === 400, 'status=' + r.status);

r = await front('/api/console/slides/save', {
  method: 'POST', headers: { authorization: 'Bearer ' + sess },
  body: JSON.stringify({ file: 'not a form' })
});
check('a body that is not a form is refused rather than throwing', r.status === 400, 'status=' + r.status);

purged.length = 0;
r = await upload('Quad at 09:15.png', 'image/png', png, 'Teams waiting in the quad', 'Before the start', sess, true);
const first = await r.json();
check('a picture uploads with its alt text and caption',
  r.status === 200 && first.ok && first.key.startsWith('slide/') &&
  first.slides.length === 1 && first.slides[0].alt === 'Teams waiting in the quad' &&
  first.slides[0].caption === 'Before the start',
  JSON.stringify(first.slides[0]));
check('the file name is kept and tidied', first.name === 'Quad at 09_15.png', first.name);
check('the bytes, the block that came out and the small copy are in the bucket, and no second copy of the picture',
  bucket.has(first.key) && !bucket.has(first.key + '.c') &&
  bucket.has(first.key + '.x') && bucket.has(first.key + '.t'));
await settle();
check('and the cached list was purged on every hostname a read might be sitting under',
  purged.includes('https://bot.example/api/slides') &&
  purged.includes('https://files.example/api/slides'),
  JSON.stringify(purged.filter(u => u.endsWith('/api/slides'))));

r = await upload('finish.png', 'image/png', png, 'The finish line', '', sess, true);
const second = await r.json();
r = await upload('loop.gif', 'image/gif', gif, 'The countdown clock running down', '', sess, true);
const moving = await r.json();
check('three pictures are up', moving.slides.length === 3, String(moving.slides.length));
check('a GIF is stored without a small copy: a still of an animation is not the picture',
  bucket.has(moving.key) && !bucket.has(moving.key + '.t'),
  JSON.stringify({ file: bucket.has(moving.key), thumb: bucket.has(moving.key + '.t') }));

// ---------------- the public list ----------------
r = await get('/api/slides');
d = await r.json();
check('the list is in display order, as uploaded',
  d.ok && d.slides.length === 3 &&
  d.slides.map(s => s.name).join(' | ') === 'Quad at 09_15.png | finish.png | loop.gif',
  JSON.stringify(d.slides.map(s => s.name)));
check('and carries exactly what the page reads: key, name, alt and caption',
  d.slides.every(s => 'key' in s && 'name' in s && 'alt' in s && 'caption' in s) &&
  d.slides[0].alt === 'Teams waiting in the quad',
  JSON.stringify(d.slides[0]));

// ---------------- the file endpoint ----------------
const fileUrl = (key, extra) => '/api/slides/file?key=' + encodeURIComponent(key) + (extra || '');

r = await get(fileUrl(first.key));
check('the picture serves, open CORS and cached forever',
  r.status === 200 && r.headers.get('access-control-allow-origin') === '*' &&
  (r.headers.get('cache-control') || '').includes('immutable'), 'status=' + r.status);
const slideServed = (await r.arrayBuffer()).byteLength;
check('what it serves is the picture with the metadata cut out, not the file that was uploaded',
  slideServed === stripImage(png, 'image/png').bytes.length && slideServed < png.length,
  slideServed + ' of ' + png.length + ' bytes');

r = await get(fileUrl(first.key, '&thumb=1'));
check('thumb=1 serves the small copy',
  r.status === 200 && (await r.arrayBuffer()).byteLength === thumbBytes.length, 'status=' + r.status);

r = await get(fileUrl(moving.key, '&thumb=1'));
check('a GIF is served whole even when a thumbnail is asked for',
  r.status === 200 && (await r.arrayBuffer()).byteLength === gif.length, 'status=' + r.status);

r = await get(fileUrl('slide/nothingheretoday'));
check('a key with no row is a 404, whatever is in the bucket',
  r.status === 404, 'status=' + r.status);

// a key that is real but not a slide key cannot be read through here
await SUBMIT.put('sub/someproof', png, { httpMetadata: { contentType: 'image/png' } });
r = await get(fileUrl('sub/someproof'));
check('and nor is a key belonging to something else in the same bucket',
  r.status === 404, 'status=' + r.status);

r = await get('/api/slides/file');
check('with no key at all it is a 404 rather than an error', r.status === 404, 'status=' + r.status);

// ---------------- the freeze does not stop it ----------------
r = await jpost('/api/console/freeze', { frozen: true }, sess);
check('the tab freezes', (await r.json()).frozen === true);
r = await get('/api/leaderboard');
check('the standings answer with the frozen copy', (await r.json()).frozen === true);
r = await get('/api/slides');
d = await r.json();
check('the home page pictures go on answering live while the tab is frozen: they are chrome, not standings',
  d.ok && d.slides.length === 3 && d.frozen === undefined, JSON.stringify({ n: d.slides.length, frozen: d.frozen }));
r = await get(fileUrl(first.key));
check('and the pictures themselves still serve', r.status === 200, 'status=' + r.status);
r = await jpost('/api/console/freeze', { frozen: false }, sess);
await r.json();

// ---------------- editing ----------------
r = await jpost('/api/console/slides/edit', { key: first.key, alt: '', caption: 'x' }, sess);
check('an edit cannot blank the alt text either', r.status === 400, 'status=' + r.status);

r = await jpost('/api/console/slides/edit', {
  key: first.key, alt: 'Teams waiting in the quad before the start', caption: 'Kensington, 09:15'
}, sess);
d = await r.json();
check('alt and caption save',
  r.status === 200 && d.slides[0].alt === 'Teams waiting in the quad before the start' &&
  d.slides[0].caption === 'Kensington, 09:15', JSON.stringify(d.slides[0]));

r = await get('/api/slides');
d = await r.json();
check('and the alt text survives the round trip to the page',
  d.slides[0].alt === 'Teams waiting in the quad before the start' &&
  d.slides[0].caption === 'Kensington, 09:15', JSON.stringify(d.slides[0]));

r = await jpost('/api/console/slides/edit', { key: 'slide/notreal', alt: 'Something' }, sess);
check('editing a picture that is not there is a 404', r.status === 404, 'status=' + r.status);

// ---------------- the order ----------------
r = await jpost('/api/console/slides/order', {
  keys: [moving.key, first.key, second.key]
}, sess);
d = await r.json();
check('the order is the list as sent, one number each',
  r.status === 200 && d.slides.map(s => s.key).join() === [moving.key, first.key, second.key].join() &&
  d.slides.map(s => s.sort).join() === '1,2,3',
  JSON.stringify(d.slides.map(s => [s.name, s.sort])));

r = await get('/api/slides');
d = await r.json();
check('and the public list is in that order',
  d.slides.map(s => s.name).join(' | ') === 'loop.gif | Quad at 09_15.png | finish.png',
  JSON.stringify(d.slides.map(s => s.name)));

r = await upload('after.png', 'image/png', png, 'The ceremony', '', sess, true);
d = await r.json();
check('a picture added afterwards lands on the end rather than jumping the order',
  d.slides[d.slides.length - 1].name === 'after.png', JSON.stringify(d.slides.map(s => s.name)));
const added = d.slides[d.slides.length - 1];
r = await jpost('/api/console/slides/delete', { key: added.key }, sess);
await r.json();

r = await jpost('/api/console/slides/order', { keys: [] }, sess);
check('an empty order is refused rather than clearing every number', r.status === 400, 'status=' + r.status);

// ---------------- where a picture is cropped ----------------
// The home page covers a wide box on a computer and a tall one on a
// phone; the point set here is what stays in the frame on both.
r = await get('/api/slides');
const middle = (await r.json()).slides.every(s => s.x === 50 && s.y === 50);
r = await jpost('/api/console/slides/focus', { key: moving.key, x: 22.4, y: 140 }, sess);
d = await r.json();
const onCard = d.slides && d.slides.find(s => s.key === moving.key);
r = await get('/api/slides');
const onPage = (await r.json()).slides.find(s => s.key === moving.key);
const refused = [];
for (const bad of [{ key: moving.key, x: 'left', y: 10 }, { key: moving.key, x: 10 }, { key: 'slide/notreal', x: 10, y: 10 }]) {
  refused.push((await jpost('/api/console/slides/focus', bad, sess)).status);
}
const cropped = 
  middle && !!onCard && onCard.focus_x === 22 && onCard.focus_y === 100 &&
  !!onPage && onPage.x === 22 && onPage.y === 100 && refused.join() === '400,400,404';
check('a picture is cropped round the middle until a point is set, which the card and the page both carry, whole and inside the picture',
  cropped, JSON.stringify({ middle, onCard: onCard && [onCard.focus_x, onCard.focus_y], onPage: onPage && [onPage.x, onPage.y], refused }));

// ---------------- hidden pictures ----------------
// Kept on the dashboard and left out of the slideshow, the link preview
// and the Discord card, which all play the first picture shown.
{
  const order = (await (await get('/api/console/slides', sess)).json()).slides.map(s => s.key);
  r = await jpost('/api/console/slides/hide', { keys: [order[0]], hidden: true }, sess);
  d = await r.json();
  const cardKeeps = d.slides.length === order.length && d.slides.find(s => s.key === order[0]).hidden === 1;
  const pageKeys = (await (await get('/api/slides')).json()).slides.map(s => s.key);
  const nextRow = raw.prepare('SELECT type FROM home_slides WHERE key = ?').get(order[1]);
  const cover = await front('/api/slides/cover');
  const coverType = cover.headers.get('content-type');
  const embed = JSON.stringify(await (await front('/api/embed/home')).json());
  const refusedHide = (await jpost('/api/console/slides/hide', { keys: [], hidden: true }, sess)).status;
  r = await jpost('/api/console/slides/hide', { keys: [order[0]], hidden: false }, sess);
  const back = (await (await get('/api/slides')).json()).slides.map(s => s.key);
  check('a hidden picture stays on the card and leaves the slideshow, its preview and its Discord card, and comes back when shown',
    cardKeeps && pageKeys.length === order.length - 1 && !pageKeys.includes(order[0]) &&
    coverType === nextRow.type && nextRow.type !== raw.prepare('SELECT type FROM home_slides WHERE key = ?').get(order[0]).type && !embed.includes(order[0].split('/')[1]) && embed.includes(order[1].split('/')[1]) &&
    refusedHide === 400 && back.join() === order.join(),
    JSON.stringify({ cardKeeps, pageKeys, coverType, refusedHide, back, order }));
}

// ---------------- how long a picture stays up ----------------
// The page counts in milliseconds and site_flags holds integers, so
// that is what crosses the wire; the dashboard's field is in seconds.
// The bounds are the point of the route: a zero would advance the
// slideshow as fast as the browser can repaint.
r = await get('/api/slides');
check('the public list says how long a picture stays up, three seconds by default',
  (await r.json()).step_ms === 3000, 'default');

r = await jpost('/api/console/slides/step', { step_ms: 4500 }, sess);
check('the dashboard can set it to a fraction of a second',
  r.status === 200 && (await r.json()).step_ms === 4500, 'status=' + r.status);
r = await get('/api/slides');
check('and the public list carries the new one', (await r.json()).step_ms === 4500, 'set');

for (const bad of [0, 999, 60001, 'soon', null]) {
  r = await jpost('/api/console/slides/step', { step_ms: bad }, sess);
  check('an interval of ' + JSON.stringify(bad) + ' is refused', r.status === 400, 'status=' + r.status);
}
r = await get('/api/slides');
check('and a refused one changes nothing', (await r.json()).step_ms === 4500, 'unchanged');

// ---------------- deleting ----------------
r = await jpost('/api/console/slides/delete', { key: 'slide/notreal' }, sess);
check('deleting a picture that is not there is a 404', r.status === 404, 'status=' + r.status);

purged.length = 0;
r = await jpost('/api/console/slides/delete', { key: first.key }, sess);
d = await r.json();
check('deleting takes the row out and hands back what is left',
  r.status === 200 && d.slides.length === 2 && !d.slides.some(s => s.key === first.key),
  JSON.stringify(d.slides.map(s => s.name)));
check('and the file, the block that came out and the small copy all go with it',
  !bucket.has(first.key) && !bucket.has(first.key + '.c') &&
  !bucket.has(first.key + '.x') && !bucket.has(first.key + '.t'));
await settle();
check('a delete purges the cached list too',
  purged.includes('https://files.example/api/slides'),
  JSON.stringify(purged.filter(u => u.endsWith('/api/slides'))));

r = await get(fileUrl(first.key));
check('a deleted picture stops serving', r.status === 404, 'status=' + r.status);

// ---------------- the log ----------------
r = await get('/api/console/log', sess);
const actions = (await r.json()).entries.map(x => x.action);
check('every one of those is in the audit log',
  ['slide-add', 'slide-edit', 'slide-order', 'slide-focus', 'slide-hide', 'slide-show', 'slide-step', 'slide-delete'].every(a => actions.includes(a)),
  JSON.stringify(actions.slice(0, 8)));

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
