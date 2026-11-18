// Run with: node tests/verify-email.mjs
//
// The confirmation email: that it is built out of the site's own
// colours, that it is HTML an email client will actually render, and
// that the dashboard's three test sends send what they say they do.
//
// Why a suite of its own. An email is the one thing here nobody can
// look at after the fact — it is in somebody's inbox, rendered by a
// client we do not control, and by the time a team says it looked
// wrong the send is days old. Every other page can be opened again.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { d1Shim } from './d1-shim.mjs';
import * as E from '../src/email-html.ts';
import { regoEmail, demoQrUrl } from '../src/rego.ts';

import { consoleSignIn } from './console-signin.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = join(BOT, '..');
const CHECKIN = join(REPO, 'checkin');

let fail = 0;
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) fail++;
};

// ---------------- the colours are the site's ----------------
// email-html.js holds them as literals because var() does not resolve
// in mail. That is the one copy of the palette outside site.css, so it
// is the one that can drift.
const css = readFileSync(join(REPO, 'website', 'assets', 'site.css'), 'utf8');
const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)[1];
const token = name => {
  const m = new RegExp('--' + name + '\\s*:\\s*([^;]+);').exec(root);
  return m ? m[1].trim() : null;
};
const MAP = {
  page: 'page-bg', card: 'card-bg', text: 'text', muted: 'muted', border: 'border', tint: 'tint',
  accent: 'accent', onAccent: 'on-accent', sign: 'sign-bg', signInk: 'sign-ink',
  signMuted: 'sign-muted', red: 'line-red', orange: 'line-orange',
  yellow: 'line-yellow', green: 'line-green', blue: 'line-blue'
};
const drifted = Object.keys(MAP).filter(k => token(MAP[k]) !== E.INK[k]);
check('every colour in the email is the site.css token of the same name',
  drifted.length === 0,
  drifted.map(k => k + ': email ' + E.INK[k] + ', site ' + token(MAP[k])).join(', '));

check('the stripe is the five routes, in the order the site runs them',
  E.STRIPE.join(',') === [E.INK.red, E.INK.orange, E.INK.yellow, E.INK.green, E.INK.blue].join(','));

// ---------------- what the client is handed ----------------
const member = {
  name: 'Alex Nguyen', email: 'alex@example.com', position: 1,
  qr_url: 'https://checkin.example/qr/abc123.png'
};
const mail = regoEmail(member, { name: 'Alex Nguyen' }, 'Night Owls');
const html = mail.html;

check('the message is a whole document, not a fragment',
  /^<!DOCTYPE html>/.test(html) && html.indexOf('</html>') === html.length - 7);

// Apple Mail and iOS invert a message in dark mode unless it says not
// to, and aged paper inverted is a grey-brown nobody chose.
check('it asks not to be inverted in dark mode',
  /name="color-scheme" content="light only"/.test(html) &&
  /name="supported-color-schemes"/.test(html));

// Outlook renders through Word. Anything below lays out as a stack of
// unstyled blocks there, which is worse than plain text.
const banned = ['display:flex', 'display:grid', 'position:absolute', 'position:fixed', 'var(--'];
const found = banned.filter(b => html.indexOf(b) !== -1);
check('nothing in it needs a layout engine Outlook does not have', found.length === 0, found.join(', '));

const tables = html.match(/<table[^>]*>/g) || [];
const bareTables = tables.filter(t =>
  !/role="presentation"/.test(t) || !/cellpadding="0"/.test(t) || !/cellspacing="0"/.test(t));
check('every table is a layout table, spaced by its own attributes',
  bareTables.length === 0 && tables.length > 3,
  bareTables.length ? bareTables[0] : tables.length + ' tables');

// The one <style> block is a width media query. Gmail strips <style>
// from a forwarded message, so nothing may depend on it.
const styleBlock = (/<style>([\s\S]*?)<\/style>/.exec(html) || ['', ''])[1];
check('the only rule in <style> is the phone width, so losing it changes nothing',
  /max-width: 620px/.test(styleBlock) && !/color|background|font-family/.test(styleBlock),
  styleBlock.trim());

// Every literal colour in the body has to be one of the tokens above.
// A hex that is nobody's token is a colour somebody typed.
const palette = Object.keys(E.INK).map(k => E.INK[k].toLowerCase());
const strays = (html.match(/#[0-9a-fA-F]{6}\b/g) || [])
  .map(h => h.toLowerCase())
  .filter(h => palette.indexOf(h) === -1);
check('no colour in it was invented on the spot',
  strays.length === 0, Array.from(new Set(strays)).join(', '));

// And nothing outside email-html.js writes one down: a hex typed into
// rego.js is a colour that will not follow the tokens when they move.
const composed = readFileSync(join(BOT, 'src', 'rego.ts'), 'utf8');
const typed = composed.match(/#[0-9a-fA-F]{6}\b/g) || [];
check('the message that says what it says names no colour of its own',
  typed.length === 0, typed.join(', '));

// ---------------- what it says ----------------
check('the ticket link and the code are both in it',
  html.indexOf('https://scs.andyrew.space/ticket/?') !== -1 &&
  html.indexOf('src="https://checkin.example/qr/abc123.png"') !== -1);
check('the team and the date read off it without opening a link',
  html.indexOf('Night Owls') !== -1 && html.indexOf('Tuesday 20 October') !== -1 &&
  html.indexOf('UNSW Kensington') !== -1);
check('the subject names the team',
  mail.subject === "You're In! Team Night Owls is registered for SCS.2", mail.subject);
check('the plain-text alternative is plain text',
  mail.text.indexOf('<') === -1 && mail.text.indexOf('Night Owls') !== -1 &&
  mail.text.indexOf('/ticket/?') !== -1);

// A team name is typed by the public. It reaches an inbox, so it is
// escaped on the way in rather than trusted.
const nasty = regoEmail(member, { name: 'A' }, 'Team <script>alert(1)</script>');
check('a team name cannot carry markup into an inbox',
  nasty.html.indexOf('<script>') === -1 && nasty.html.indexOf('&lt;script&gt;') !== -1);

// Without a code the ticket block has to go entirely: a button that
// opens an empty ticket is worse than a line saying it is coming.
const noCode = regoEmail({ name: 'Sam Lee', email: 's@example.com', position: 2 },
  { name: 'Alex Nguyen' }, 'Night Owls');
check('with no code there is no ticket button and no broken picture',
  noCode.html.indexOf('/ticket/?') === -1 && noCode.html.indexOf('alt="Your check-in QR code"') === -1 &&
  noCode.html.indexOf('separate email') !== -1);
check('and the person who did not sign the team up is told who did',
  noCode.html.indexOf('Alex Nguyen signed your team up') !== -1);

// ---------------- the header ----------------
// The picture is on the site, not in the worker, so the email names a
// file somebody editing website/ could move without knowing a message
// points at it.
const head = E.HEADER.src.replace('https://scs.andyrew.space/', '');
const png = existsSync(join(BOT, '..', 'website', head)) ? readFileSync(join(BOT, '..', 'website', head)) : null;
const size = png ? [png.readUInt32BE(16), png.readUInt32BE(20)] : null;
check('the header is the 3:1 banner, from a file the site serves, with words for a client that holds pictures back',
  html.indexOf('<img src="' + E.HEADER.src + '" alt="' + E.HEADER.alt + '"') !== -1 &&
  png && png.slice(1, 4).toString() === 'PNG' && size[0] === 1200 && size[1] === 400 &&
  Math.round(600 * size[1] / size[0]) === E.HEADER.height,
  head + ' ' + JSON.stringify(size));

// The icons are the same: files on the site the email names, drawn at
// three times their 24px.
const iconFiles = Array.from(new Set(html.match(/assets\/email\/icon-[a-z]+\.png/g) || []));
const badIcons = iconFiles.filter(f => {
  const file = join(BOT, '..', 'website', f);
  if (!existsSync(file)) return true;
  const b = readFileSync(file);
  return b.slice(1, 4).toString() !== 'PNG' || b.readUInt32BE(16) !== 72 || b.readUInt32BE(20) !== 72;
});
check('every icon the email names is a file the site serves, drawn at three times its size',
  iconFiles.length >= 3 && badIcons.length === 0,
  badIcons.length ? 'missing or wrong: ' + badIcons.join(', ') : iconFiles.join(', '));

// ---------------- the banner ----------------
const withBanner = regoEmail(member, { name: 'A' }, 'Night Owls',
  { banner: 'https://files.example/api/drop/k/title.gif' });
check('a banner stands in for the header picture instead of sitting above it',
  withBanner.html.indexOf('<img src="https://files.example/api/drop/k/title.gif"') !== -1 &&
  withBanner.html.indexOf(E.HEADER.src) === -1);
const tail = s => s.slice(s.indexOf('Hi Alex'));
check('and nothing below it changes', tail(withBanner.html) === tail(html));
check('the confirmation a team gets never has one', html.indexOf('<img src="https://files') === -1);

// ---------------- the three test sends ----------------
const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(join(BOT, 'schema.sql'), 'utf8'));
raw.exec(readFileSync(join(BOT, 'seed.sql'), 'utf8'));
const db = d1Shim(raw);

const ciRaw = new DatabaseSync(':memory:');
ciRaw.exec(readFileSync(join(CHECKIN, 'schema.sql'), 'utf8'));
const checkin = await import(join(CHECKIN, 'src', 'index.js'));
const CI_ENV = { DB: d1Shim(ciRaw), REGISTRATION_KEY: 'checkin-key', QR: {} };

globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };
const sent = [];
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.indexOf('https://api.resend.com/') === 0) {
    sent.push(JSON.parse(init.body));
    return Response.json({ id: 'e' + sent.length });
  }
  if (url.indexOf('https://checkin.example') === 0) {
    return checkin.default.fetch(new Request(url, init), CI_ENV, { waitUntil() {} });
  }
  return new Response('not found', { status: 404 });
};

const mod = await import(join(BOT, 'src', 'index.ts'));
const ENV = {
  DB: db, CONSOLE_PASSWORD: 'tab-pass', EMAIL_API_KEY: 're_test',
  CHECKIN_API: 'https://checkin.example', CHECKIN_KEY: 'checkin-key'
};
const ctx = { waitUntil() {} };
const post = (path, body, token) => mod.default.fetch(new Request('https://bot.example' + path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' },
    token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
}), ENV, ctx);
const session = (await consoleSignIn(post, 'Tab', 'tab-pass')).session;
const test = async body => {
  const r = await post('/api/console/rego/email/test', body, session);
  return { status: r.status, data: await r.json(), mail: sent[sent.length - 1] };
};

const plain = await test({ to: 'org@example.com' });
check('the plain test is still one bare message about the sender',
  plain.status === 200 && plain.data.ok && plain.data.kind === 'plain' &&
  plain.mail.html.indexOf('<table') === -1 && plain.mail.subject === 'SCS.2 test message',
  plain.mail.subject);

const ticket = await test({ to: 'org@example.com', kind: 'ticket', name: 'Jo Tran', team: 'Dry Run' });
check('the ticket test sends the real confirmation, with the typed name and team',
  ticket.data.ok && ticket.data.kind === 'ticket' &&
  ticket.mail.subject === "You're In! Team Dry Run is registered for SCS.2" &&
  ticket.mail.html.indexOf('Jo Tran') !== -1 && ticket.mail.html.indexOf('Dry Run') !== -1,
  ticket.mail.subject);
check('and it carries a code, from the check-in worker rather than the roster',
  ticket.mail.html.indexOf('src="https://checkin.example/qr/demo.png"') !== -1 &&
  ciRaw.prepare('SELECT COUNT(*) n FROM attendees').get().n === 0,
  'attendees: ' + ciRaw.prepare('SELECT COUNT(*) n FROM attendees').get().n);

// The demo code has to be a real picture, or the test email shows a
// broken box and the layout cannot be judged at all.
const demo = await checkin.default.fetch(
  new Request('https://checkin.example/qr/demo.png'), CI_ENV, { waitUntil() {} });
const bytes = new Uint8Array(await demo.arrayBuffer());
check('the check-in worker draws that code on the spot, as a PNG',
  demo.status === 200 && demo.headers.get('content-type') === 'image/png' &&
  bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length > 200,
  bytes.length + ' bytes');
check('and the ticket page falls back to the same image',
  demoQrUrl(ENV) === 'https://checkin.example/qr/demo.png' &&
  (await (await mod.default.fetch(new Request('https://bot.example/api/ticket/qr?k=demo'), ENV, ctx))
    .headers.get('content-type')) === 'image/png');

const withHeader = await test({
  to: 'org@example.com', kind: 'banner', name: 'Jo Tran', team: 'Dry Run',
  banner: 'https://files.example/api/drop/k/title.gif'
});
check('the banner test is the same message with the picture on top',
  withHeader.data.ok && withHeader.data.kind === 'banner' &&
  withHeader.mail.html.indexOf('title.gif') !== -1 &&
  withHeader.mail.html.indexOf('Jo Tran') !== -1);

const httpBanner = await test({ to: 'org@example.com', kind: 'banner', banner: 'http://files.example/a.gif' });
check('an http:// picture is refused rather than sent to be blocked as mixed content',
  httpBanner.status === 400 && /banner address/.test(httpBanner.data.error), httpBanner.data.error);
const noBanner = await test({ to: 'org@example.com', kind: 'banner', banner: 'not a url' });
check('and so is anything that is not a link', noBanner.status === 400);

const unknown = await test({ to: 'org@example.com', kind: 'something-else' });
check('an unknown kind falls back to the plain message rather than erroring',
  unknown.data.ok && unknown.data.kind === 'plain');

const noCheckin = await (async () => {
  const saved = ENV.CHECKIN_API;
  ENV.CHECKIN_API = 'PASTE the check-in worker address';
  const r = await test({ to: 'org@example.com', kind: 'ticket', name: 'Jo', team: 'Dry Run' });
  ENV.CHECKIN_API = saved;
  return r;
})();
check('with no check-in worker the test still sends and says why there is no code',
  noCheckin.data.ok && /no code in it/.test(noCheckin.data.note || '') &&
  noCheckin.mail.html.indexOf('alt="Your check-in QR code"') === -1,
  noCheckin.data.note);

const logged = raw.prepare("SELECT quest_code FROM submission_log WHERE action = 'email-test'").all();
check('every test send is logged with which kind it was',
  logged.length >= 5 && logged.some(r => r.quest_code.indexOf('ticket ') === 0) &&
  logged.some(r => r.quest_code.indexOf('banner ') === 0),
  logged.map(r => r.quest_code.split(' ')[0]).join(', '));

console.log(fail ? '\nFAILURES: ' + fail : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
