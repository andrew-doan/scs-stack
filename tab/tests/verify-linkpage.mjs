// Run with: node tests/verify-linkpage.mjs   (needs Node 22+)
// The link page at go.<domain>/, end to end against the real worker:
// off, the bare domain still goes to the site; on, it draws the links in
// their order with hidden ones left out; a link opened through /l/<id>
// is counted and redirected; a link preview is not counted as a view;
// an address that could run script is refused; the actions belong to
// the Files tab; and with the database failing, the page and its links
// come from the snapshot every save writes to KV.
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
globalThis.caches = { default: { async match() { return undefined; }, async put() {}, async delete() { return true; } } };

const mod = await import(BOT + '/src/index.ts');
const kv = new Map();
const LINK_PAGE_KV = {
  async get(key, type) { const v = kv.get(key); return v == null ? null : (type === 'json' ? JSON.parse(v) : v); },
  async put(key, value) { kv.set(key, String(value)); },
  async delete(key) { kv.delete(key); }
};
const ENV = {
  DB: d1Shim(raw), LINK_PAGE_KV, CONSOLE_PASSWORD: 'tab-pass',
  PUBLIC_API: 'https://files.example', SHORT_HOST: 'go.example', SITE_URL: 'https://scs.example'
};
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); } };
const settle = () => Promise.all(pending.splice(0));
const at = (host, path, opts) => mod.default.fetch(new Request('https://' + host + path, opts), ENV, ctx);
const jpost = (path, body, token) => at('bot.example', path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => at('bot.example', path, { headers: token ? { authorization: 'Bearer ' + token } : {} });

const sess = (await consoleSignIn(jpost, 'Comms', 'tab-pass')).session;

// ---------------- off ----------------
let r = await at('go.example', '/');
check('with the page off, the bare short domain still goes to the site',
  r.status === 302 && r.headers.get('location') === 'https://scs.example/', r.status + ' ' + r.headers.get('location'));

// ---------------- building the page ----------------
const save = async (body) => (await jpost('/api/console/linkpage/save', body, sess)).json();
await save({ kind: 'heading', label: 'Season 2' });
await save({ kind: 'link', label: 'The quest list', url: 'https://scs.example/questlist/', featured: true });
await save({ kind: 'link', label: 'Not yet', url: 'https://scs.example/secret/', hidden: true });
await save({ kind: 'social', icon: 'instagram', url: 'https://instagram.com/scs' });
let d = await save({ kind: 'social', icon: 'email', url: 'scs@example.org' });
const bad = await jpost('/api/console/linkpage/save', { kind: 'link', label: 'Run', url: 'javascript:alert(1)' }, sess);
check('links are kept in order, an email address becomes a mailto link, and an address that could run script is refused',
  d.ok && d.items.map(i => i.kind).join(',') === 'heading,link,link,social,social' &&
  d.items[4].url === 'mailto:scs@example.org' && bad.status === 400, JSON.stringify(d.items && d.items.map(i => [i.kind, i.url])));

await jpost('/api/console/linkpage/settings', { on: true, title: 'SCS on the web', bio: 'Everything in one place.' }, sess);
r = await at('go.example', '/');
const html = await r.text();
await settle();
const link = d.items.find(i => i.label === 'The quest list');
const hiddenOne = d.items.find(i => i.label === 'Not yet');
check('turned on, the bare domain draws the page: the title, the line, the links through /l/, no hidden link, the icons',
  r.status === 200 && /text\/html/.test(r.headers.get('content-type')) &&
  html.includes('SCS on the web') && html.includes('Everything in one place.') &&
  html.includes('href="l/' + link.id + '"') && html.includes('is-featured') &&
  !html.includes('Not yet') && html.includes('aria-label="Instagram"') && html.includes('aria-label="Email"'),
  r.status + ' ' + html.length);

// ---------------- the header picture ----------------
// a picture from the drop under a shade, the numbers held to their range;
// a key that is not a picture in the drop is refused
raw.prepare("INSERT INTO drop_files (key, name, type, bytes, note, created_by) VALUES ('drop/pic1', 'header.jpg', 'image/jpeg', 10, '', 'x')").run();
raw.prepare("INSERT INTO drop_files (key, name, type, bytes, note, created_by) VALUES ('drop/doc1', 'rules.pdf', 'application/pdf', 10, '', 'x')").run();
const notPic = await jpost('/api/console/linkpage/settings', { bg: 'drop/doc1' }, sess);
const look = await (await jpost('/api/console/linkpage/settings', { bg: 'drop/pic1', dim: 300, blur: 6 }, sess)).json();
const withPic = await (await at('go.example', '/')).text();
await settle();
check('a header picture from Files is drawn under its shade and blur, the darkness is held to 90%, and a file that is not a picture is refused',
  notPic.status === 404 && look.look.bg === 'drop/pic1' && look.look.dim === 90 && look.look.blur === 6 &&
  look.pictures.length === 1 && withPic.includes('has-picture') &&
  withPic.includes("url('https://files.example/api/drop/drop/pic1/header.jpg')") &&
  withPic.includes('filter:blur(6px)') && withPic.includes('opacity:0.9'),
  JSON.stringify(look.look));
await jpost('/api/console/linkpage/settings', { bg: '' }, sess);

// ---------------- counting ----------------
r = await at('go.example', '/l/' + link.id);
await settle();
const hiddenClick = await at('go.example', '/l/' + hiddenOne.id);
const missing = await at('go.example', '/l/99999');
await at('go.example', '/', { headers: { 'user-agent': 'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)' } });
await settle();
d = await (await get('/api/console/linkpage', sess)).json();
const counted = d.items.find(i => i.id === link.id);
check('a link opened is counted and redirected, a hidden or unknown one is a 404, and a link preview is not a view',
  r.status === 302 && r.headers.get('location') === 'https://scs.example/questlist/' &&
  counted.clicks === 1 && counted.recent === 1 && hiddenClick.status === 404 && missing.status === 404 &&
  d.views === 2 && d.days.length === 1 && d.days[0].views === 2 && d.days[0].clicks === 1,
  JSON.stringify({ status: r.status, clicks: counted.clicks, views: d.views, days: d.days }));

// ---------------- order, delete, who may ----------------
const ids = d.items.map(i => i.id).reverse();
d = await (await jpost('/api/console/linkpage/order', { ids }, sess)).json();
const afterOrder = d.items.map(i => i.id).join(',') === ids.join(',');
d = await (await jpost('/api/console/linkpage/delete', { id: link.id }, sess)).json();
const gone = !d.items.some(i => i.id === link.id) &&
  raw.prepare('SELECT COUNT(*) AS n FROM link_page_days WHERE item_id = ?').get(link.id).n === 0;
const anon = await jpost('/api/console/linkpage/save', { kind: 'link', label: 'x', url: 'https://x.example/' });
check('the order is saved, a delete takes the link and its counts, and the actions need a signed-in organiser',
  afterOrder && gone && anon.status === 401, anon.status);

// ---------------- the database away ----------------
// the snapshot is the page as last saved, with each shown link's address
const shown = d.items.filter(i => !i.hidden && i.kind !== 'heading');
const hiddenNow = d.items.find(i => i.hidden);
const snap = JSON.parse(kv.get('snapshot') || 'null');
const working = ENV.DB;
const down = () => Promise.reject(new Error('D1_ERROR: network connection lost'));
const broken = { prepare() { const st = { bind() { return st; }, first: down, run: down, all: down }; return st; }, batch: down };
ENV.DB = broken;
r = await at('go.example', '/');
const fromSnap = await r.text();
const viaSnap = await at('go.example', '/l/' + shown[0].id);
const hiddenDown = await at('go.example', '/l/' + hiddenNow.id);
await settle();
ENV.DB = working;
const afterViews = (await (await get('/api/console/linkpage', sess)).json()).views;
check('with the database failing, the page comes from the last save and its links still redirect; a hidden link does not, and nothing is counted',
  !!snap && r.status === 200 && fromSnap === snap.html && fromSnap.includes('SCS on the web') &&
  viaSnap.status === 302 && viaSnap.headers.get('location') === shown[0].url &&
  hiddenDown.status === 404 && afterViews === d.views,
  JSON.stringify({ snap: !!snap, page: r.status, click: viaSnap.status, hidden: hiddenDown.status, views: [afterViews, d.views] }));

await jpost('/api/console/linkpage/settings', { on: false }, sess);
ENV.DB = broken;
r = await at('go.example', '/');
ENV.DB = working;
check('turned off, the snapshot goes, so an outage sends the bare domain to the site',
  !kv.has('snapshot') && r.status === 302 && r.headers.get('location') === 'https://scs.example/', r.status);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
