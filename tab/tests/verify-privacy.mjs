// Run with: node tests/verify-privacy.mjs   (needs Node 22+)
// Taking people's data off the databases and putting it back
// (src/privacy.ts, with the check-in worker's /api/personal/*), and the
// proof videos as teams sent them downloaded and deleted
// (src/originals.ts). Both workers run here against their own sqlite
// databases, the way verify-rego-qr.mjs runs them.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECKIN = join(BOT, '..', 'checkin');

let fail = 0;
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) fail++;
};

// ---------- the check-in worker ----------
const ciRaw = new DatabaseSync(':memory:');
ciRaw.exec(readFileSync(CHECKIN + '/schema.sql', 'utf8'));
const checkin = await import(CHECKIN + '/src/index.js');
const CI_ENV = { DB: d1Shim(ciRaw), REGISTRATION_KEY: 'checkin-key' };
let checkinMode = 'live';
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.indexOf('https://checkin.example') === 0) {
    if (checkinMode === 'down') throw new Error('connection refused');
    return checkin.default.fetch(new Request(url, init), CI_ENV, { waitUntil() {} });
  }
  throw new Error('unexpected fetch ' + url);
};

// ---------- the tab worker ----------
const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);
const bucket = new Map();
const SUBMIT = {
  async put(key, value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(await new Response(value).arrayBuffer());
    bucket.set(key, bytes);
  },
  async get(key) {
    const hit = bucket.get(key);
    if (!hit) return null;
    return {
      size: hit.length, httpMetadata: {}, customMetadata: {},
      body: new Response(hit).body,
      async arrayBuffer() { return hit.buffer.slice(hit.byteOffset, hit.byteOffset + hit.byteLength); }
    };
  },
  async head(key) { return bucket.has(key) ? { size: bucket.get(key).length, httpMetadata: {} } : null; },
  async delete(key) { bucket.delete(key); }
};
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };
const mod = await import(BOT + '/src/index.ts');
const ENV = { DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass', CHECKIN_API: 'https://checkin.example', CHECKIN_KEY: 'checkin-key' };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
const admin = (await consoleSignIn(jpost, 'Tab', 'tab-pass')).session;
await jpost('/api/console/accounts/save', { create: true, name: 'Settings', password: 'settings-pass-1', perms: ['settings', 'rego'], require_2fa: false }, admin);
const settings = (await (await jpost('/api/console/login', { name: 'Settings', password: 'settings-pass-1' })).json()).session;

// ---------- people on both sides ----------
raw.exec(`
  INSERT INTO registrations (id, team_id, team_name) VALUES (901, 1, '1296'), (902, NULL, '');
  INSERT INTO participants (id, registration_id, team_id, position, name, zid, email, dietary) VALUES
    (9001, 901, 1, 1, 'Alice Park', 'z1234567', 'alice@example.com', 'Vegetarian'),
    (9002, 901, 1, 2, 'Ben Ho', 'z7654321', 'ben@example.com', NULL),
    (9003, 902, NULL, 1, 'Cass Lee', 'z0000000', 'cass@example.com', 'No nuts');
  INSERT INTO eoi_people (id, email, zid) VALUES (1, 'alice@example.com', 'z1234567'), (2, '', 'z1111111');
  INSERT INTO email_sends (id, subject, body, total, sent, status) VALUES (1, 'Hello', 'Hi', 2, 2, 'done');
  INSERT INTO email_queue (id, send_id, email, status) VALUES (1, 1, 'alice@example.com', 'sent'), (2, 1, 'ben@example.com', 'sent');
`);
ciRaw.exec(`
  INSERT INTO attendees (id, name, email, team_name, zid, token, qr_key, participant_id) VALUES
    (1, 'Alice Park', 'alice@example.com', '1296', 'z1234567', 'tok-alice-0000000001', 'qr-alice-00000000000000001', 9001),
    (2, 'Ben Ho', 'ben@example.com', '1296', 'z7654321', 'tok-ben-00000000000002', 'qr-ben-0000000000000000002', 9002),
    (3, 'Cass Lee', 'cass@example.com', 'No team yet', 'z0000000', 'tok-cass-0000000000003', 'qr-cass-000000000000000003', 9003);
`);
const tabRows = () => raw.prepare('SELECT id, zid, email, dietary FROM participants WHERE id >= 9001 ORDER BY id').all();
const doorRows = () => ciRaw.prepare('SELECT id, email, zid FROM attendees ORDER BY id').all();
const count = (sql) => raw.prepare(sql).get().n;

// ---------- who may ----------
const locked = [
  (await get('/api/console/privacy', settings)).status,
  (await get('/api/console/privacy/export', settings)).status,
  (await jpost('/api/console/privacy/remove', { copy: {} }, settings)).status,
  (await get('/api/console/originals', settings)).status,
  (await jpost('/api/console/originals/delete', {}, settings)).status
];
check('personal data and original videos are for admins only', locked.every((s) => s === 403), JSON.stringify(locked));

// ---------- the copy ----------
const status = await (await get('/api/console/privacy', admin)).json();
check('the card counts what is stored here and at the door',
  status.stored.emails === 3 && status.stored.zids === 3 && status.stored.dietary === 2 && status.stored.eoi === 2 &&
  status.stored.queue === 2 && status.checkin.reached && status.checkin.emails === 3 && status.checkin.zids === 2 && !status.removed,
  JSON.stringify(status));
let copy = (await (await get('/api/console/privacy/export', admin)).json()).copy;
check('the copy holds every value removing takes off, both databases',
  copy.kind === 'scs2-personal-data' && copy.people.length === 3 && copy.people[0].email === 'alice@example.com' &&
  copy.people[0].dietary === 'Vegetarian' && copy.eoi.length === 2 && copy.email_queue.length === 2 &&
  copy.checkin && copy.checkin.people.length === 3 && copy.checkin.people[2].zid === '');

// a copy that is not ours, and one gone stale
const notOurs = (await jpost('/api/console/privacy/remove', { copy: { kind: 'something', people: [] } }, admin)).status;
raw.exec("UPDATE participants SET dietary = 'Vegan' WHERE id = 9002");
const stale = await jpost('/api/console/privacy/remove', { copy }, admin);
const staleBody = await stale.json();
check('a copy that is not one, or that misses a change made since, removes nothing',
  notOurs === 400 && stale.status === 409 && staleBody.changed === 1 && tabRows()[1].dietary === 'Vegan' &&
  doorRows()[0].email === 'alice@example.com', staleBody.error);

// the door's copy is cleared first, so a door that cannot be reached stops it all
copy = (await (await get('/api/console/privacy/export', admin)).json()).copy;
checkinMode = 'down';
const unreached = await jpost('/api/console/privacy/remove', { copy }, admin);
checkinMode = 'live';
check('when the check-in worker cannot take its copy off, nothing is removed here either',
  unreached.status === 502 && tabRows()[0].email === 'alice@example.com');

// an announcement still going out holds it back
raw.exec("UPDATE email_sends SET status = 'sending' WHERE id = 1");
const going = (await jpost('/api/console/privacy/remove', { copy }, admin)).status;
raw.exec("UPDATE email_sends SET status = 'done' WHERE id = 1");
check('nothing is removed while an announcement is going out', going === 409);

// ---------- removing ----------
const removed = await (await jpost('/api/console/privacy/remove', { copy }, admin)).json();
const afterTab = tabRows();
const afterDoor = doorRows();
check('removing takes the emails, zIDs and dietary needs off the tab',
  removed.ok && removed.people === 3 && afterTab.every((r) => r.zid === '' && r.email === null && r.dietary === null) &&
  count('SELECT COUNT(*) AS n FROM eoi_people') === 0 && count('SELECT COUNT(*) AS n FROM email_queue') === 0,
  JSON.stringify(afterTab));
check('and off the check-in worker, a real zID kept unique by its row and the not-at-UNSW marker left',
  removed.checkin === 3 && afterDoor.every((r) => r.email === '') && afterDoor[0].zid === 'removed-1' &&
  afterDoor[1].zid === 'removed-2' && afterDoor[2].zid === 'z0000000', JSON.stringify(afterDoor));
const after = await (await get('/api/console/privacy', admin)).json();
check('the card says it was removed, and by whom', after.removed && after.removed.by === 'Tab' && after.stored.people === 0);
const eoiAward = await jpost('/api/console/eoi/award', {}, admin);
const edit = await jpost('/api/console/rego/person/save', { id: 9001, name: 'Alice Park', zid: 'z1234567', email: 'a@example.com' }, admin);
check('the EOI award and editing a person wait until it is back', eoiAward.status === 409 && edit.status === 409);

// ---------- putting it back ----------
raw.exec("UPDATE participants SET email = 'new-ben@example.com' WHERE id = 9002");
const back = await (await jpost('/api/console/privacy/restore', { copy }, admin)).json();
const restoredTab = tabRows();
const restoredDoor = doorRows();
check('putting it back fills every empty field from the copy and keeps what was typed since',
  back.ok && back.people === 3 && restoredTab[0].zid === 'z1234567' && restoredTab[0].email === 'alice@example.com' &&
  restoredTab[0].dietary === 'Vegetarian' && restoredTab[1].email === 'new-ben@example.com' && restoredTab[1].dietary === 'Vegan' &&
  restoredTab[2].zid === 'z0000000' && count('SELECT COUNT(*) AS n FROM eoi_people') === 2 &&
  count('SELECT COUNT(*) AS n FROM email_queue') === 2, JSON.stringify(restoredTab));
check('and puts the check-in worker\'s copy back',
  back.checkin === 3 && restoredDoor[0].email === 'alice@example.com' && restoredDoor[0].zid === 'z1234567' &&
  restoredDoor[2].zid === 'z0000000', JSON.stringify(restoredDoor));
const clear = await (await get('/api/console/privacy', admin)).json();
check('and the mark comes off, so the EOI award works again', !clear.removed && (await jpost('/api/console/eoi/award', {}, admin)).status !== 409);

// ---------- original videos ----------
const bytes = (n, fill) => new Uint8Array(n).fill(fill);
raw.exec(`
  INSERT INTO submissions (id, team_id, quest_code, status) VALUES (7001, 1, 'SQ1', 'accepted'), (7002, 2, 'SQ2', 'accepted'), (7003, 2, 'SQ3', 'accepted');
  INSERT INTO submission_files (id, submission_id, r2_key, content_type, bytes, name, encode_state) VALUES
    (8001, 7001, 'sub/vidaaaaaaaaaaaaaa', 'video/quicktime', 3000, 'IMG_0001.MOV', 'done'),
    (8002, 7002, 'sub/vidbbbbbbbbbbbbbb', 'video/mp4', 2000, 'clip.mp4', ''),
    (8003, 7003, 'sub/vidcccccccccccccc', 'video/mp4', 1000, 'gone.mp4', 'done');
  INSERT INTO submission_renditions (file_key, height, key, bytes) VALUES
    ('sub/vidaaaaaaaaaaaaaa', 720, 'rnd/aaaa720', 500), ('sub/vidcccccccccccccc', 720, 'rnd/cccc720', 300);
`);
bucket.set('sub/vidaaaaaaaaaaaaaa', bytes(3000, 1));
bucket.set('sub/vidaaaaaaaaaaaaaa.c', bytes(2900, 2));
bucket.set('sub/vidaaaaaaaaaaaaaa.x', bytes(40, 3));
bucket.set('sub/vidaaaaaaaaaaaaaa.t', bytes(60, 4));
bucket.set('rnd/aaaa720', bytes(500, 5));
bucket.set('sub/vidbbbbbbbbbbbbbb', bytes(2000, 6));
// encoded, by the rows, but its copies are not in the bucket
bucket.set('sub/vidcccccccccccccc', bytes(1000, 7));

const first = await (await get('/api/console/originals', admin)).json();
check('the card counts the originals kept, none saved and none to delete yet',
  first.kept === 3 && first.kept_bytes === 6000 && first.saved === 0 && first.deletable === 0 && first.unencoded === 1,
  JSON.stringify(first));
const early = await (await jpost('/api/console/originals/delete', { after: 0 }, admin)).json();
check('nothing is deleted before it has been downloaded', early.deleted === 0 && bucket.has('sub/vidaaaaaaaaaaaaaa'));

const links = await (await get('/api/console/originals/zip', admin)).json();
const link = new URL(links.parts[0].url);
check('the download is one part with a link signed for a few hours', links.ok && links.parts.length === 1 && links.parts[0].files === 3);
const pass = link.searchParams.get('pass');
const forged = (await front(link.pathname + '?pass=' + pass.slice(0, -1) + (pass.slice(-1) === 'x' ? 'y' : 'x') + '&part=1')).status;
check('a link with its signature changed does not download', forged === 403);

// a download given up part way saves nothing
const partial = await front(link.pathname + link.search);
const reader = partial.body.getReader();
await reader.read();
await reader.cancel();
check('a download stopped part way counts nothing as saved', (await (await get('/api/console/originals', admin)).json()).saved === 0);

const whole = await front(link.pathname + link.search);
const zip = new Uint8Array(await whole.arrayBuffer());
const names = new TextDecoder().decode(zip);
check('the whole download is a ZIP of the originals, named for the team and the quest',
  whole.status === 200 && zip[0] === 0x50 && zip[1] === 0x4b && names.indexOf('1296 - SQ1 - IMG_0001.MOV') !== -1 &&
  names.indexOf('Galahs - SQ2 - clip.mp4') !== -1);
const saved = await (await get('/api/console/originals', admin)).json();
check('once it has gone out whole every video in it counts as saved, and only the encoded one with a copy can go',
  saved.saved === 3 && saved.deletable === 2, JSON.stringify(saved));

const del = await (await jpost('/api/console/originals/delete', { after: 0 }, admin)).json();
check('deleting takes the original and its metadata block, and keeps the copies and the still',
  del.ok && del.deleted === 1 && del.kept === 1 && del.done && !bucket.has('sub/vidaaaaaaaaaaaaaa') && !bucket.has('sub/vidaaaaaaaaaaaaaa.x') &&
  bucket.has('sub/vidaaaaaaaaaaaaaa.c') && bucket.has('sub/vidaaaaaaaaaaaaaa.t') && bucket.has('rnd/aaaa720'), JSON.stringify(del));
check('a video with no copy in the bucket, or none from the encoder, keeps its original',
  bucket.has('sub/vidcccccccccccccc') && bucket.has('sub/vidbbbbbbbbbbbbbb'));
const shown = await get('/api/console/file?key=' + encodeURIComponent('sub/vidaaaaaaaaaaaaaa'), admin);
const shownBytes = new Uint8Array(await shown.arrayBuffer());
check('the dashboard shows the clean copy where the original was', shown.status === 200 && shownBytes.length === 2900 && shownBytes[0] === 2);
const end = await (await get('/api/console/originals', admin)).json();
check('the card counts it as deleted', end.gone === 1 && end.kept === 2 && end.deletable === 1, JSON.stringify(end));

console.log(fail ? fail + ' check(s) failed' : 'all checks passed');
process.exit(fail ? 1 : 0);
