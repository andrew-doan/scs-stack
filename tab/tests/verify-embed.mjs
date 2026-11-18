// Run with: node tests/verify-embed.mjs   (needs Node 22+)
//
// What a link to the site looks like in Discord: the card the worker
// builds for /api/embed/<page>, and the tags in each page's head that
// point at it.
//
// Discord throws the whole card away over one key it does not allow,
// so the card is checked against the rules Discord publishes rather
// than against its own shape: one Container at the top, no more than
// 40 components or 3,000 bytes, link buttons only, and pictures whose
// addresses end in their extension. The words are checked the other
// way: each page carries its own copy of its title and line for the
// apps that only read Open Graph, and the two have to say the same.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
import { stripImage } from '../src/strip.ts';

const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(BOT, '..', 'website');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
const db = d1Shim(raw);

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
  async get(key) {
    const hit = bucket.get(key);
    if (!hit) return null;
    const bytes = hit.bytes;
    return {
      body: bytes, size: bytes.length, httpMetadata: hit.meta, customMetadata: hit.custom,
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); }
    };
  },
  async head(key) { const hit = bucket.get(key); return hit ? { size: hit.bytes.length, httpMetadata: hit.meta, customMetadata: hit.custom } : null; },
  async delete(key) { bucket.delete(key); }
};
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };

const mod = await import(BOT + '/src/index.ts');
const { PAGES } = await import(BOT + '/src/embed.ts');
const ENV = { DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass', PUBLIC_API: 'https://files.scs.andyrew.space' };
const ctx = { waitUntil() {} };
const front = (path, opts) => mod.default.fetch(new Request('https://files.scs.andyrew.space' + path, opts), ENV, ctx);
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const sess = (await consoleSignIn(jpost, 'Comms', 'tab-pass')).session;

// ---- Discord's rules for a component embed ----
const ALLOWED = new Set([1, 2, 9, 10, 11, 12, 14, 17]);
const BUTTON_KEYS = new Set(['id', 'type', 'url', 'style', 'label', 'emoji', 'disabled']);
const PICTURE = /\.(png|gif|jpe?g|webp|avif)$/i;
function rulesBroken(payload, text) {
  const out = [];
  if (Buffer.byteLength(text, 'utf8') > 3000) out.push('over 3,000 bytes');
  if (!payload || Object.keys(payload).join() !== 'component') out.push('the top level is not {component}');
  const top = payload && payload.component;
  if (!top || top.type !== 17) out.push('the component is not a Container');
  let count = 0;
  const walk = (c, depth) => {
    count++;
    if (!ALLOWED.has(c.type)) out.push('type ' + c.type + ' is not allowed');
    if (c.type === 17 && depth > 0) out.push('a Container inside a Container');
    if (c.type === 2) {
      for (const k of Object.keys(c)) if (!BUTTON_KEYS.has(k)) out.push('button key ' + k);
      if (c.style !== 5) out.push('a button that is not a link');
      if (!c.label && !c.emoji) out.push('a button with nothing on it');
      if (!/^https:\/\//.test(c.url || '')) out.push('a button with no address');
    }
    const media = [];
    if (c.type === 11) media.push(c.media && c.media.url);
    if (c.type === 12) for (const it of c.items || []) media.push(it.media && it.media.url);
    for (const u of media) {
      if (!/^https?:\/\//.test(u || '') || u.length > 2048) out.push('a picture address Discord will not take: ' + u);
      else if (!PICTURE.test(new URL(u).pathname)) out.push('a picture address without its extension: ' + u);
    }
    for (const k of ['components']) for (const child of c[k] || []) walk(child, depth + 1);
    if (c.accessory) walk(c.accessory, depth + 1);
  };
  if (top) walk(top, 0);
  if (count > 40) out.push(count + ' components');
  return out;
}
const flat = (c, out = []) => { out.push(c); (c.components || []).forEach(x => flat(x, out)); if (c.accessory) flat(c.accessory, out); return out; };
const buttons = p => flat(p.component).filter(c => c.type === 2).map(b => b.label + ' ' + b.url);

// ---------------- no pictures uploaded ----------------
let r = await front('/api/embed/info');
let text = await r.text();
let card = JSON.parse(text);
check('a page\'s card keeps to every rule Discord publishes, with no pictures uploaded',
  r.status === 200 && rulesBroken(card, text).length === 0, rulesBroken(card, text).join('; '));
check('it carries the page\'s name and line, and the three buttons',
  JSON.stringify(card).includes('Event Info') && JSON.stringify(card).includes(PAGES.info.line) &&
  buttons(card).join(' | ') === 'Home https://scs.andyrew.space/ | Event Info https://scs.andyrew.space/info/ | Sign Up https://scs.andyrew.space/rego/',
  buttons(card).join(' | '));
r = await front('/api/slides/cover');
check('with no pictures the cover address sends the app\'s icon instead',
  r.status === 302 && /icon-512\.png$/.test(r.headers.get('location') || ''), r.status + ' ' + r.headers.get('location'));
r = await front('/api/embed/nowhere');
check('a page the worker does not know is a 404', r.status === 404, String(r.status));

// ---------------- with a picture ----------------
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
async function upload(name, alt) {
  const form = new FormData();
  form.append('file', new File([png], name, { type: 'image/png' }));
  form.append('alt', alt);
  return (await front('/api/console/slides/save', { method: 'POST', headers: { authorization: 'Bearer ' + sess }, body: form })).json();
}
const one = await upload('quad.png', 'Teams waiting in the quad');
await upload('finish.png', 'The finish line');

r = await front('/api/embed/questlist');
text = await r.text();
card = JSON.parse(text);
const gallery = flat(card.component).find(c => c.type === 12);
const url = gallery && gallery.items[0].media.url;
check('with pictures up, the card still keeps to the rules and shows the slideshow\'s first',
  rulesBroken(card, text).length === 0 && gallery && gallery.items.length === 1 &&
  url.includes(encodeURIComponent(one.key.split('/')[1])) && gallery.items[0].description === 'Teams waiting in the quad',
  rulesBroken(card, text).join('; ') + ' ' + url);
r = await front(new URL(url).pathname);
const served = new Uint8Array(await r.arrayBuffer());
check('and the address it names serves that picture with what was in it taken out',
  r.status === 200 && served.length === stripImage(png, 'image/png').bytes.length && served.length < png.length,
  r.status + ' ' + served.length + ' of ' + png.length);
r = await front('/api/slides/cover');
const cover = new Uint8Array(await r.arrayBuffer());
check('the cover address serves the same first picture, cleaned, kept five minutes rather than forever',
  r.status === 200 && cover.length === served.length && r.headers.get('cache-control') === 'public, max-age=300',
  r.status + ' ' + r.headers.get('cache-control'));

// ---------------- sign-ups closed ----------------
await jpost('/api/console/rego/settings/set', { closed: true, cap: 0 }, sess);
card = await (await front('/api/embed/home')).json();
check('once the sign-up form is shut the third button goes to the quest list instead',
  buttons(card).join(' | ').endsWith('Quest List https://scs.andyrew.space/questlist/') &&
  !buttons(card).some(b => b.startsWith('Sign Up')), buttons(card).join(' | '));

// ---------------- the pages ----------------
// Each main page points Discord at its own card and says the same title
// and line in its Open Graph tags.
const FILES = { home: 'index.html', info: 'info/index.html', questlist: 'questlist/index.html',
  tab: 'tab/index.html', submit: 'submit/index.html', welfare: 'welfare/index.html',
  rego: 'rego/index.html', messages: 'messages/index.html', gallery: 'gallery/index.html' };
const attr = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const meta = (html, prop) => {
  const m = html.match(new RegExp('<meta property="' + prop + '" content="([^"]*)"'));
  return m ? attr(m[1]) : null;
};
const wrong = [];
for (const [page, file] of Object.entries(FILES)) {
  const html = readFileSync(join(SITE, file), 'utf8');
  const head = html.slice(0, html.indexOf('</head>'));
  const spec = PAGES[page];
  const link = head.match(/<link rel="discord:component-embed" type="application\/json" href="([^"]+)"/);
  if (!spec) { wrong.push(page + ': not in PAGES'); continue; }
  if (!link || link[1] !== 'https://files.scs.andyrew.space/api/embed/' + page) wrong.push(page + ': link ' + (link && link[1]));
  if (meta(head, 'og:title') !== spec.title) wrong.push(page + ': og:title ' + meta(head, 'og:title'));
  if (meta(head, 'og:description') !== spec.line) wrong.push(page + ': og:description ' + meta(head, 'og:description'));
  if (meta(head, 'og:url') !== 'https://scs.andyrew.space' + spec.path) wrong.push(page + ': og:url ' + meta(head, 'og:url'));
  if (meta(head, 'og:image') !== 'https://files.scs.andyrew.space/api/slides/cover') wrong.push(page + ': og:image ' + meta(head, 'og:image'));
}
check('every main page names its own card and says the same title and line as it',
  wrong.length === 0 && Object.keys(FILES).length === Object.keys(PAGES).length, wrong.join('; '));

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
