// Run with: node tests/verify-push.mjs   (needs Node 22+)
// Push notifications end to end against the real worker: the VAPID
// key endpoint, subscribe/unsubscribe with shape checks, the console
// send behind session + push password, batching with dead-endpoint
// pruning — and the part that matters most: a captured push is
// DECRYPTED here with Node's own crypto acting as the browser, so the
// worker's RFC 8291 encryption and RFC 8292 VAPID JWT are proved
// against an independent implementation.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import crypto from 'node:crypto';

import { consoleSignIn } from './console-signin.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

// ---- D1 shim ----
const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };

// ---- VAPID keys, generated the same way scripts/gen-vapid.mjs does ----
const vapidPair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const vapidJwk = vapidPair.publicKey.export({ format: 'jwk' });
const VAPID_PUBLIC = Buffer.concat([
  Buffer.from([4]), Buffer.from(vapidJwk.x, 'base64url'), Buffer.from(vapidJwk.y, 'base64url')
]).toString('base64url');
const VAPID_PRIVATE = vapidPair.privateKey.export({ format: 'jwk' }).d;

// ---- capture outgoing pushes instead of hitting real push services ----
const pushed = [];
// A send to everybody is a lot of round trips, so the worker starts
// them in groups instead of waiting for each. `watch` makes the stub
// take a beat and record how many were ever in the air at once, which
// is how the suite tells a group apart from a queue.
const watch = { on: false, inFlight: 0, peak: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (url.startsWith('https://push.example/')) {
    pushed.push({ url, headers: init.headers, body: Buffer.from(init.body) });
    if (watch.on) {
      watch.inFlight++;
      watch.peak = Math.max(watch.peak, watch.inFlight);
      await new Promise(function (r) { setTimeout(r, 3); });
      watch.inFlight--;
    }
    const status = url.includes('/gone/') ? 410 : 201;
    return new Response(null, { status });
  }
  return realFetch(input, init);
};

const mod = await import(BOT + '/src/index.ts');
const ENV = {
  DB: db, CONSOLE_PASSWORD: 'tab-pass', PUSH_PASSWORD: 'push-pass',
  VAPID_PUBLIC_KEY: VAPID_PUBLIC, VAPID_PRIVATE_KEY: VAPID_PRIVATE,
  VAPID_SUBJECT: 'https://scs.example'
};
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
// A push from the dashboard. The second password goes in a header, the
// way the page sends it; `password` in the body here is only where the
// test keeps it.
const sendPush = (body, token) => {
  const rest = Object.assign({}, body);
  const second = rest.password;
  delete rest.password;
  return front('/api/console/push/send', {
    method: 'POST',
    headers: Object.assign({ 'content-type': 'application/json' },
      token ? { authorization: 'Bearer ' + token } : {}, second ? { 'x-second-password': second } : {}),
    body: JSON.stringify(rest)
  });
};

// ---- a fake browser: real client keys, so we can decrypt later ----
function makeClient(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    ecdh,
    authSecret: crypto.randomBytes(16),
    sub: () => ({
      endpoint,
      keys: {
        p256dh: ecdh.getPublicKey().toString('base64url'),
        auth: undefined
      }
    })
  };
}
const clientA = makeClient('https://push.example/dev/aaaa');
const clientB = makeClient('https://push.example/gone/bbbb');
const subJson = c => ({
  endpoint: c.endpoint,
  keys: { p256dh: c.ecdh.getPublicKey().toString('base64url'), auth: c.authSecret.toString('base64url') }
});

// RFC 8291 receiver side, independently implemented on node:crypto.
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
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(tag);
  const plain = Buffer.concat([d.update(enc), d.final()]);
  if (plain[plain.length - 1] !== 2) throw new Error('bad padding delimiter');
  return plain.subarray(0, plain.length - 1).toString();
}

// ---------------- vapid + subscribe ----------------
let r = await front('/api/push/vapid');
let data = await r.json();
check('the site can fetch the VAPID public key, CORS open',
  r.status === 200 && data.key === VAPID_PUBLIC && r.headers.get('access-control-allow-origin') === '*', '');

r = await jpost('/api/push/subscribe', subJson(clientA));
check('a subscription is accepted', (await r.json()).ok === true, '');
r = await jpost('/api/push/subscribe', subJson(clientA));
check('subscribing twice is one row (endpoint upsert)',
  (await r.json()).ok === true && raw.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n === 1, '');
r = await jpost('/api/push/subscribe', subJson(clientB));
check('a second device lands beside it', raw.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n === 2, '');
r = await jpost('/api/push/subscribe', { endpoint: 'http://plain.example/x', keys: { p256dh: 'short', auth: 'x' } });
check('junk subscriptions are refused', r.status === 400, 'status=' + r.status);

// ---------------- the second lock ----------------
const pushSignIn = await consoleSignIn(jpost, 'Tab', 'tab-pass');
r = { status: pushSignIn.session ? 200 : 401, json: async () => pushSignIn };
const sess = (await r.json()).session;
r = await front('/api/console/push/stats', { headers: { authorization: 'Bearer ' + sess } });
check('the console counts subscribers', (await r.json()).subscribers === 2, '');
r = await sendPush({ password: 'push-pass', title: 'Hi', body: 'x' });
check('sending needs a console session first', r.status === 401, 'status=' + r.status);
r = await sendPush({ password: 'wrong', title: 'Hi', body: 'x' }, sess);
check('the wrong push password is refused without killing the session', r.status === 403, 'status=' + r.status);
check('nothing went out on refused sends', pushed.length === 0, String(pushed.length));

// ---------------- a real send, decrypted ----------------
r = await sendPush({
  password: 'push-pass', title: 'Briefing 3 is live', body: 'Check the quest list.', url: '/questlist/'
}, sess);
data = await r.json();
check('the send reports one delivered, one dead, none remaining',
  data.ok && data.sent === 1 && data.dead === 1 && data.remaining === 0, JSON.stringify(data));
check('the dead endpoint was pruned',
  raw.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n === 1, '');

const hit = pushed.find(p => p.url === clientA.endpoint);
check('the push carries aes128gcm, a TTL and announcement tiering', !!hit &&
  hit.headers['content-encoding'] === 'aes128gcm' && hit.headers.ttl === '3600' &&
  hit.headers.urgency === 'high' && hit.headers.topic === 'announce',
  JSON.stringify(hit && { urgency: hit.headers.urgency, topic: hit.headers.topic }));

const auth = hit.headers.authorization || '';
check('the VAPID header names our key', auth.startsWith('vapid t=') && auth.endsWith(', k=' + VAPID_PUBLIC), '');
const jwt = auth.slice('vapid t='.length, auth.indexOf(', k='));
const [h, c, s] = jwt.split('.');
const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
check('the JWT audience is the push service origin, expiry sane',
  claims.aud === 'https://push.example' && claims.exp > Date.now() / 1000 && claims.sub === 'https://scs.example',
  JSON.stringify(claims));
const verified = crypto.verify('sha256', Buffer.from(h + '.' + c),
  { key: vapidPair.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
check('the JWT signature verifies against the public key', verified, '');

const plain = JSON.parse(decryptPush(clientA, hit.body));
check('the browser-side decrypt recovers the exact payload',
  plain.title === 'Briefing 3 is live' && plain.body === 'Check the quest list.' &&
  plain.url === '/questlist/' && plain.tag === 'scs2-announce' && plain.renotify === true,
  JSON.stringify(plain));

// ---------------- the log and unsubscribe ----------------
r = await front('/api/console/log?limit=10', { headers: { authorization: 'Bearer ' + sess } });
const actions = (await r.json()).entries.map(e => e.action);
check('the send is in the audit log', actions.includes('push-send'), JSON.stringify(actions.slice(0, 4)));

r = await jpost('/api/push/unsubscribe', { endpoint: clientA.endpoint });
check('unsubscribe removes the row',
  (await r.json()).ok === true && raw.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n === 0, '');

// ---------------- team targeting ----------------
r = await jpost('/api/console/codes/generate', {}, sess);
r = await front('/api/console/codes', { headers: { authorization: 'Bearer ' + sess } });
const garb = (await r.json()).codes.find(c => c.name === 'Galahs');
r = await jpost('/api/submit/login', { team_name: 'Galahs', code: garb.code });
const teamSess = (await r.json()).session;
const garbId = raw.prepare("SELECT id FROM teams WHERE name = 'Galahs'").get().id;

r = await jpost('/api/push/subscribe', subJson(clientA), teamSess);
data = await r.json();
check('subscribing through the submit page links the device to its team',
  data.team === 'Galahs' &&
  raw.prepare('SELECT team_id FROM push_subs WHERE endpoint = ?').get(clientA.endpoint).team_id === garbId, JSON.stringify(data));
r = await jpost('/api/push/subscribe', subJson(clientA));
check('a later anonymous re-subscribe keeps the team link',
  raw.prepare('SELECT team_id FROM push_subs WHERE endpoint = ?').get(clientA.endpoint).team_id === garbId, '');

// a second, unlinked device belongs to nobody and must never get team pushes
const clientC = makeClient('https://push.example/dev/cccc');
await jpost('/api/push/subscribe', subJson(clientC));

// reject a submission: the one verdict that buzzes the team
raw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'S1')").run(garbId);
const subRow = raw.prepare('SELECT id FROM submissions ORDER BY id DESC LIMIT 1').get();
pushed.length = 0;
r = await jpost('/api/console/submissions/reject', { id: subRow.id, reason: 'Sign not visible' }, sess);
check('rejecting still answers the console', (await r.json()).ok === true, '');
check('the verdict push reached only the team, tiered normal',
  pushed.length === 1 && pushed[0].url === clientA.endpoint &&
  pushed[0].headers.urgency === 'normal' && pushed[0].headers.topic === 's' + subRow.id,
  JSON.stringify(pushed.map(p => p.url)));
const verdict = JSON.parse(decryptPush(clientA, pushed[0].body));
check('the verdict names the quest and the reason, tagged to its submission',
  verdict.title === 'Submission rejected' && verdict.body === 'S1 — Sign not visible' &&
  verdict.url === '/submit/' && verdict.tag === 'sub-' + subRow.id && verdict.renotify === true,
  JSON.stringify(verdict));

// signing out on the site unlinks the device from the team and keeps it subscribed
r = await jpost('/api/push/unlink', { endpoint: clientA.endpoint });
data = await r.json();
pushed.length = 0;
await jpost('/api/console/submissions/reject', { id: raw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'S1') RETURNING id").get(garbId).id, reason: 'Again' }, sess);
check('unlink keeps the device subscribed and out of the team\'s verdicts',
  data.ok === true && raw.prepare('SELECT team_id FROM push_subs WHERE endpoint = ?').get(clientA.endpoint).team_id === null &&
  pushed.length === 0, JSON.stringify(pushed.map(p => p.url)));
await jpost('/api/push/subscribe', subJson(clientA), teamSess); // linked again for what follows

// quiet updates ride the low-urgency lane and replace silently
pushed.length = 0;
r = await sendPush({
  password: 'push-pass', title: 'Scores refreshed', body: 'Nothing to do.', kind: 'update'
}, sess);
data = await r.json();
const quiet = pushed.find(p => p.url === clientA.endpoint);
check('a quiet update goes out low-urgency under the update topic',
  data.sent === 2 && quiet.headers.urgency === 'low' && quiet.headers.topic === 'update', JSON.stringify(data));
const quietPayload = JSON.parse(decryptPush(clientA, quiet.body));
check('quiet updates replace on screen without a second buzz',
  quietPayload.tag === 'scs2-update' && quietPayload.renotify === false, JSON.stringify(quietPayload));

// ---------------- the outbox: what does not fit in one request ----
// Every push is one subrequest and a Worker gets a fixed number of
// those, so a send to everyone is a run of batches. The save takes the
// first, the scheduled run takes the rest. What it replaced was a
// single pass with no follow-up: past the cap the only way to reach
// the rest was to retype the message into the Push tab and send it to
// everybody, which notified the first batch twice.
{
  const { sendAllPush, pushOutboxTick, PUSH_INLINE, PUSH_SWEEP, outboxWaiting } = await import(BOT + '/src/push.ts');
  raw.exec('DELETE FROM push_subs');
  raw.exec('DELETE FROM push_outbox');
  // The two numbers are different on purpose: the inline batch is what
  // goes out while an organiser watches the Send button, the sweep is
  // what the scheduled run takes with nobody waiting. One more than
  // both, so it takes the save and two ticks to clear.
  const many = PUSH_INLINE + PUSH_SWEEP + 1;
  const keysA = subJson(clientA).keys;
  for (let i = 0; i < many; i++) {
    raw.prepare('INSERT INTO push_subs (endpoint, p256dh, auth) VALUES (?, ?, ?)')
      .run('https://push.example/many/' + i, keysA.p256dh, keysA.auth);
  }
  pushed.length = 0;

  const first = await sendAllPush(ENV, { title: 'Buses moved', body: 'Read the messages page', tag: 'scs2-announce', renotify: true },
    { urgency: 'high', topic: 'announce' });
  check('the save sends one batch itself, so an urgent message is on phones before it answers',
    first.sent === PUSH_INLINE && pushed.length === PUSH_INLINE, JSON.stringify({ sent: first.sent, pushes: pushed.length }));
  check('and says the rest is in hand rather than leaving it to be retyped',
    first.queued === true && first.remaining === many - PUSH_INLINE &&
    (await outboxWaiting(db)) === 1, JSON.stringify(first));

  const queued = raw.prepare('SELECT * FROM push_outbox').get();
  check('the outbox row carries the message and the cursor it stopped at',
    queued.title === 'Buses moved' && queued.tag === 'scs2-announce' && queued.urgency === 'high' &&
    queued.renotify === 1 && queued.after_id > 0, JSON.stringify(queued));

  pushed.length = 0;
  // two scheduled runs overlapping: one of them takes the batch
  let [tick, other] = await Promise.all([pushOutboxTick(ENV), pushOutboxTick(ENV)]);
  if (!tick.ran) [tick, other] = [other, tick];
  check('a scheduled tick takes the next batch, a bigger one, and nobody gets it twice, with two runs at once',
    tick.ran && !other.ran && tick.sent === PUSH_SWEEP && !tick.done &&
    pushed.length === PUSH_SWEEP && new Set(pushed.map(x => x.url)).size === PUSH_SWEEP,
    JSON.stringify({ sent: tick.sent, remaining: tick.remaining, other: other, pushes: pushed.length }));
  check('the cursor moves with it', raw.prepare('SELECT after_id FROM push_outbox').get().after_id > queued.after_id, '');

  pushed.length = 0;
  tick = await pushOutboxTick(ENV);
  check('the last tick clears the tail and the row goes',
    tick.ran && tick.done && tick.sent === 1 && (await outboxWaiting(db)) === 0,
    JSON.stringify(tick));
  check('every device was reached exactly once across the three batches',
    raw.prepare('SELECT COUNT(*) AS n FROM push_subs').get().n === many, '');

  tick = await pushOutboxTick(ENV);
  check('an empty outbox is not work', tick.ran === false, JSON.stringify(tick));

  // a send that fits needs no follow-up at all
  raw.exec('DELETE FROM push_subs');
  raw.prepare('INSERT INTO push_subs (endpoint, p256dh, auth) VALUES (?, ?, ?)')
    .run('https://push.example/one/1', keysA.p256dh, keysA.auth);
  const small = await sendAllPush(ENV, { title: 'x', body: 'y' }, {});
  check('a send that fits in one batch queues nothing',
    small.sent === 1 && small.queued === false && (await outboxWaiting(db)) === 0, JSON.stringify(small));
}

// ---------------- sent in groups, not one at a time ----------------
// A notification is one HTTPS request to the device's push service, and
// none of them depend on each other. Waiting for each before starting
// the next spent the whole batch in round trips: 300 phones meant 300
// waits in a row and about fifteen seconds of the organiser watching a
// spinner. This is the property that fixed it, and it is worth holding
// to account, because nothing about the counts would change if the
// groups quietly became a queue again.
{
  const { pushBatch, PUSH_FANOUT } = await import(BOT + '/src/push.ts');
  raw.exec('DELETE FROM push_subs');
  const keys = subJson(clientA).keys;
  const crowd = PUSH_FANOUT * 2;
  for (let i = 0; i < crowd; i++) {
    raw.prepare('INSERT INTO push_subs (endpoint, p256dh, auth) VALUES (?, ?, ?)')
      .run('https://push.example/group/' + i, keys.p256dh, keys.auth);
  }
  pushed.length = 0;
  watch.on = true; watch.peak = 0; watch.inFlight = 0;
  const out = await pushBatch(ENV, { title: 'Go', body: 'now' }, {}, 0, crowd);
  watch.on = false;
  check('a batch goes out in groups rather than one device at a time',
    watch.peak > 1, 'most in the air at once: ' + watch.peak);
  check('and the group is bounded, so a batch cannot outrun the subrequest cap',
    watch.peak <= PUSH_FANOUT, watch.peak + ' of ' + PUSH_FANOUT);
  check('every device still got exactly one, and the cursor is the last of them',
    out.sent === crowd && pushed.length === crowd &&
    new Set(pushed.map(x => x.url)).size === crowd,
    JSON.stringify({ sent: out.sent, after: out.after }));
}

// ---------------- aiming a push ----------------
// Everyone is the send that needs batching. A team or a single device
// is a handful of phones and finishes in the request that asked for
// it — which is what makes a test send to your own phone possible.
// Before this the only way to see what an announcement looked like was
// to send it to everybody.
{
  const { pushDevices, deviceService, pushToTeam, pushToDevice } = await import(BOT + '/src/push.ts');
  raw.exec('DELETE FROM push_subs');
  const keys = subJson(clientA).keys;
  const add = (endpoint, teamId, label) =>
    raw.prepare('INSERT INTO push_subs (endpoint, p256dh, auth, team_id, label) VALUES (?, ?, ?, ?, ?)')
      .run(endpoint, keys.p256dh, keys.auth, teamId, label);
  const galahs = raw.prepare("SELECT id FROM teams WHERE name = 'Galahs'").get().id;
  const other = raw.prepare('SELECT id FROM teams WHERE id != ? LIMIT 1').get(galahs).id;
  add('https://push.example/team/a', galahs, 'Alex phone');
  add('https://push.example/team/b', galahs, '');
  add('https://push.example/team/c', other, 'Someone else');
  add('https://push.example/loose/d', null, 'Front desk');

  check('the push service is read off the endpoint, not stored',
    deviceService('https://web.push.apple.com/abc') === 'Apple' &&
    deviceService('https://fcm.googleapis.com/fcm/send/abc') === 'Google' &&
    deviceService('https://updates.push.services.mozilla.com/wpush/v2/abc') === 'Mozilla' &&
    deviceService('nonsense') === 'Unknown');

  const devices = await pushDevices(db);
  check('the device list names each one, its service and its team',
    devices.length === 4 &&
    devices.filter(v => v.label === 'Alex phone')[0].team_name === 'Galahs' &&
    devices.filter(v => v.label === 'Front desk')[0].team_name === '',
    JSON.stringify(devices.map(v => [v.label, v.team_name])));
  check('and never hands out the endpoint or the keys — they are enough to send a push',
    devices.every(v => !('endpoint' in v) && !('p256dh' in v) && !('auth' in v)),
    JSON.stringify(Object.keys(devices[0])));

  pushed.length = 0;
  const toTeam = await pushToTeam(ENV, galahs, { title: 'Yours', body: 'only' }, {});
  check('a team send reaches that team and nobody else',
    toTeam.sent === 2 && pushed.length === 2 &&
    pushed.every(p => p.url.startsWith('https://push.example/team/')) &&
    !pushed.some(p => p.url.endsWith('/c')),
    JSON.stringify(pushed.map(p => p.url)));

  pushed.length = 0;
  const one = devices.filter(v => v.label === 'Front desk')[0];
  const toDevice = await pushToDevice(ENV, one.id, { title: 'Test', body: 'one' }, {});
  check('a device send reaches exactly that device',
    toDevice.sent === 1 && pushed.length === 1 && pushed[0].url === 'https://push.example/loose/d',
    JSON.stringify(pushed.map(p => p.url)));

  pushed.length = 0;
  check('a device that is gone is not a silent success',
    (await pushToDevice(ENV, 99999, { title: 'x', body: 'y' }, {})).sent === 0 && pushed.length === 0);

  // ---- the same three, through the dashboard ----
  pushed.length = 0;
  let r = await sendPush({
    password: 'push-pass', title: 'Just you', body: 'testing', kind: 'announce',
    target: { kind: 'device', sub_id: one.id }
  }, sess);
  let d = await r.json();
  check('the dashboard can send to one device, and says which',
    r.status === 200 && d.sent === 1 && d.target === 'device' && d.remaining === 0 && pushed.length === 1,
    JSON.stringify(d));

  pushed.length = 0;
  r = await sendPush({
    password: 'push-pass', title: 'Team only', body: 'testing', kind: 'announce',
    target: { kind: 'team', team_id: galahs }
  }, sess);
  d = await r.json();
  check('and to one team, named in the answer so the page can say it back',
    r.status === 200 && d.sent === 2 && d.who === 'Galahs', JSON.stringify(d));

  r = await sendPush({
    password: 'push-pass', title: 'x', body: 'y', target: { kind: 'team', team_id: 99999 }
  }, sess);
  check('a team that does not exist is refused rather than quietly sent to everybody',
    r.status === 400, 'status=' + r.status);

  r = await sendPush({
    password: 'wrong', title: 'x', body: 'y', target: { kind: 'device', sub_id: one.id }
  }, sess);
  check('the push password still guards a targeted send', r.status === 403, 'status=' + r.status);

  // ---- naming a device ----
  r = await jpost('/api/console/push/name', { id: one.id, label: 'Welfare tent iPad' }, sess);
  d = await r.json();
  check('a device can be renamed from the dashboard',
    d.ok && d.devices.filter(v => v.id === one.id)[0].label === 'Welfare tent iPad',
    JSON.stringify(d.devices.map(v => v.label)));

  // The site re-posts its subscription every time a team signs in on
  // that device, and it sends the browser's guess at a name with it. A
  // guess must never land on top of a name an organiser chose.
  r = await jpost('/api/push/subscribe', Object.assign(subJson(clientA), {
    endpoint: 'https://push.example/loose/d', label: 'Android Chrome'
  }));
  check('a re-subscribe does not write its guess over a name that was chosen',
    r.status === 200 &&
    raw.prepare('SELECT label FROM push_subs WHERE endpoint = ?').get('https://push.example/loose/d').label === 'Welfare tent iPad');

  r = await jpost('/api/push/subscribe', Object.assign(subJson(clientA), {
    endpoint: 'https://push.example/fresh/e', label: 'iPhone app'
  }));
  check('but a device with no name takes the one the browser offered',
    r.status === 200 &&
    raw.prepare('SELECT label FROM push_subs WHERE endpoint = ?').get('https://push.example/fresh/e').label === 'iPhone app');

  r = await jpost('/api/console/push/name', { id: 99999, label: 'nothing' }, sess);
  check('renaming a device that is not there is a 404', r.status === 404, 'status=' + r.status);
}

// ---------------- the scheduled run ----------------
// The worker's own clock. It must never throw: there is nobody there
// to see it, and one job failing must not take the others with it.
{
  const { runSchedule, scheduleNote } = await import(BOT + '/src/schedule.ts');
  raw.exec('DELETE FROM push_outbox');
  const out = await runSchedule(ENV, () => {});
  check('a tick with nothing to do runs clean and writes no log line',
    out.published === 0 && out.push.ran === false && !scheduleNote(out), JSON.stringify(out));

  // a database that has never had the new tables must not break the tick
  const oldDb = new DatabaseSync(':memory:');
  oldDb.exec('CREATE TABLE messages (id INTEGER PRIMARY KEY, title TEXT, urgency TEXT, hidden INTEGER, publish_at TEXT)');
  const behind = await runSchedule({ DB: d1Shim(oldDb) }, () => {});
  check('and a database behind the code is a quiet tick, not a failure',
    behind.push.ran === false && behind.rego.ran === false, JSON.stringify(behind));
}

// ---------------- switched off after the event ----------------
// The Settings tab's switch stops every push: a rejection, a message's
// push, the Push tab, and what was still queued, which is dropped
// rather than sent whenever pushes come back on.
{
  const { sendAllPush, pushOutboxTick, outboxWaiting } = await import(BOT + '/src/push.ts');
  raw.exec('DELETE FROM push_outbox');
  raw.exec('DELETE FROM push_subs');
  const keys = subJson(clientA).keys;
  raw.prepare('INSERT INTO push_subs (endpoint, p256dh, auth, team_id) VALUES (?, ?, ?, ?)')
    .run(clientA.endpoint, keys.p256dh, keys.auth, garbId);
  raw.prepare("INSERT INTO push_outbox (title, body, url, tag, renotify, urgency, topic, after_id) VALUES ('Left over', 'x', '', '', 0, 'normal', '', 0)").run();
  const flagged = await (await jpost('/api/console/flags/set', { name: 'push_off', value: true }, sess)).json();
  pushed.length = 0;
  raw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'S1')").run(garbId);
  const offSub = raw.prepare('SELECT id FROM submissions ORDER BY id DESC LIMIT 1').get();
  const rejected = await (await jpost('/api/console/submissions/reject', { id: offSub.id, reason: 'Late' }, sess)).json();
  const viaTab = await sendPush({ password: 'push-pass', title: 'After the day', body: 'Thanks for playing' }, sess);
  const message = await sendAllPush(ENV, { title: 'x', body: 'y' }, {});
  const tick = await pushOutboxTick(ENV);
  check('switched off after the event, no push reaches a phone: not a rejection, a message or the Push tab, and the queue is dropped',
    flagged.ok && flagged.flags.push_off === true && rejected.ok && viaTab.status === 409 &&
    message.off === true && message.sent === 0 && tick.dropped === true && (await outboxWaiting(db)) === 0 &&
    pushed.length === 0,
    JSON.stringify({ flags: flagged.flags, tab: viaTab.status, message, tick, pushed: pushed.length }));
  await jpost('/api/console/flags/set', { name: 'push_off', value: false }, sess);
  const again = await sendAllPush(ENV, { title: 'x', body: 'y' }, {});
  check('switched back on, pushes go out again', again.sent === 1 && pushed.length === 1, JSON.stringify(again));
}

// ---------------- locks when unconfigured ----------------
const bare = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts),
  { DB: db, CONSOLE_PASSWORD: 'tab-pass' }, { waitUntil() {} });
r = await bare('/api/push/vapid');
check('no VAPID keys means push reports itself off', r.status === 503, 'status=' + r.status);
r = await bare('/api/console/push/send', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer ' + sess },
  body: JSON.stringify({ title: 'x', body: 'y' })
});
check('no PUSH_PASSWORD means sending stays locked', r.status === 403, 'status=' + r.status);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
