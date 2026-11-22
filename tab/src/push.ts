// Push subscriptions — the site's settings rocker talks to these.
// Subscribing is open (it's opt-in notifications, the endpoint is the
// device's own), capped and deduped by endpoint. Sending lives on the
// console API behind the console session plus the push password.
// A subscribe carrying a valid team session (the submit page re-posts
// the subscription once a team signs in) links the device to that
// team, which is what lets verdicts reach just the team they concern.

import { requireTeam } from './submit.ts';
import { sendPush } from './webpush.ts';
import { corsJson as json, configured, cleanText, fields } from './shared.ts';
import type { PushOpts } from './webpush.ts';
import type { Env, JsonBody, PushOutboxRow, PushPayload, PushSubRow, SiteFlagRow, TeamRow } from './types.ts';

// A subscriber as a send needs it.
type Device = Pick<PushSubRow, 'id' | 'endpoint' | 'p256dh' | 'auth'>;

// One batch of a send to everybody (or to some teams' devices), and the
// cursor it stopped at.
export interface PushBatch {
  sent: number;
  failed: number;
  dead: number;
  after: number;
  remaining: number;
  off: boolean;
}

var MAX_SUBS = 20000;

export function pushConfigured(env: Env): boolean {
  return configured(env.VAPID_PUBLIC_KEY) && configured(env.VAPID_PRIVATE_KEY);
}

export async function handlePushApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  var path = url.pathname;
  if (path.indexOf('/api/push/') !== 0) return null;
  var action = path.slice('/api/push/'.length);

  if (request.method === 'GET' && action === 'vapid') {
    if (!configured(env.VAPID_PUBLIC_KEY)) {
      return json({ error: 'Push is not switched on (the worker has no VAPID keys).' }, 503);
    }
    return json({ key: env.VAPID_PUBLIC_KEY });
  }

  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }

  if (action === 'subscribe') {
    var endpoint = String(body.endpoint || '');
    var keys = fields(body.keys);
    var p256dh = String(keys.p256dh || '');
    var auth = String(keys.auth || '');
    // shape checks: an https endpoint, a 65-byte P-256 point and a
    // 16-byte auth secret, both base64url
    if (endpoint.indexOf('https://') !== 0 || endpoint.length > 1024 ||
        !/^[A-Za-z0-9_-]{80,90}$/.test(p256dh) || !/^[A-Za-z0-9_-]{16,32}$/.test(auth)) {
      return json({ error: 'That is not a push subscription.' }, 400);
    }
    var count = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs').first<{ n: number }>() as { n: number };
    if (count.n >= MAX_SUBS) return json({ error: 'The subscription list is full.' }, 429);
    // a team session on the request links this device to that team;
    // without one an existing link is left alone, never cleared
    var team = await requireTeam(request, env.DB);
    var teamId = team ? team.team_id : null;
    await env.DB.prepare(
      'INSERT INTO push_subs (endpoint, p256dh, auth, team_id) VALUES (?1, ?2, ?3, ?4) ' +
      'ON CONFLICT(endpoint) DO UPDATE SET p256dh = ?2, auth = ?3, team_id = COALESCE(?4, team_id)'
    ).bind(endpoint, p256dh, auth, teamId).run();
    // The name for this device is written separately and never over the
    // top of one already there: the dashboard can rename a device, and
    // the site re-posts its subscription every time a team signs in on
    // it.
    var label = cleanText(body.label, 40);
    if (label) {
      await env.DB.prepare(
        "UPDATE push_subs SET label = ?2 WHERE endpoint = ?1 AND COALESCE(label, '') = ''"
      ).bind(endpoint, label).run();
    }
    return json({ ok: true, team: team ? team.team_name : null });
  }

  if (action === 'unsubscribe') {
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?1').bind(String(body.endpoint || '')).run();
    return json({ ok: true });
  }

  // A team signing out on the site: the device keeps its subscription and
  // loses the team. The endpoint is the device's own capability, the same
  // as for unsubscribe, so no session is asked for (the one signing out
  // may already have run out).
  if (action === 'unlink') {
    await env.DB.prepare('UPDATE push_subs SET team_id = NULL WHERE endpoint = ?1').bind(String(body.endpoint || '')).run();
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

// ---------- how many at once, and how many in a batch ----------
// There is no send-to-everybody call. A notification is one HTTPS
// request to the push service the device belongs to — Apple's, Google's
// or Mozilla's — so reaching 300 phones is 300 outbound requests, and a
// Worker invocation may make a fixed number of those. Hence batches
// with a cursor between them rather than one loop.
//
// **The sends do not depend on each other**, which is what the first
// version of this missed: waiting for each before starting the next
// spent the whole batch in round trips, about 50ms of nothing per
// device. In groups, a batch costs roughly one round trip per group,
// so 300 devices take about as long as 12 used to.
export var PUSH_FANOUT = 25;

// Two numbers, because the two callers are in different situations.
// PUSH_INLINE goes out while an organiser watches a Send button: big
// enough that most phones have it before the page answers, small
// enough that the page answers. PUSH_SWEEP is what the scheduled run
// takes, where nobody is waiting — bounded by the 1000 subrequests an
// invocation may make, with room left for the queries around it.
export var PUSH_INLINE = 100;
export var PUSH_SWEEP = 500;

// The Settings tab's switch for after the event: on, nothing is sent to
// any phone. Every send comes through pushMany, so this is the one gate.
export async function pushesOff(db: D1Database): Promise<boolean> {
  try {
    var row = await db.prepare("SELECT value FROM site_flags WHERE name = 'push_off'").first<Pick<SiteFlagRow, 'value'>>();
    return !!(row && row.value);
  } catch (err) {
    return false;
  }
}

// One list of subscribers, sent to in groups of PUSH_FANOUT. Answers
// what happened and the highest id it reached, which is the cursor.
async function pushMany(env: Env, rows: Device[], payload: PushPayload, opts: PushOpts | undefined): Promise<{ sent: number; failed: number; dead: number[]; after: number; off?: boolean }> {
  if (rows.length && await pushesOff(env.DB)) {
    return { sent: 0, failed: 0, dead: [], after: rows[rows.length - 1].id, off: true };
  }
  var sent = 0;
  var failed = 0;
  var dead: number[] = [];
  for (var i = 0; i < rows.length; i += PUSH_FANOUT) {
    var group = rows.slice(i, i + PUSH_FANOUT);
    // sendPush swallows everything and answers 'fail', the subrequest
    // cap included, so a breach shows up here as failures rather than
    // as a thrown request — which is why the count has to be reported
    var outcomes = await Promise.all(group.map(function (sub) {
      return sendPush(env, sub, payload, opts);
    }));
    for (var j = 0; j < outcomes.length; j++) {
      if (outcomes[j] === 'ok') sent++;
      else if (outcomes[j] === 'dead') dead.push(group[j].id);
      else failed++;
    }
  }
  if (dead.length) await pruneSubs(env, dead);
  return {
    sent: sent, failed: failed, dead: dead,
    after: rows.length ? rows[rows.length - 1].id : 0
  };
}

// One batch from a cursor, for a send to everybody — or, given a list
// of team ids, to every device linked to one of those teams (a message
// some teams read). It answers with where it got to, so the caller can
// decide whether to go round again itself, leave the rest to the
// scheduled run, or stop.
export async function pushBatch(env: Env, payload: PushPayload, opts: PushOpts | undefined, after: number, limit?: number, teamIds?: number[] | null): Promise<PushBatch> {
  var from = after || 0;
  var subs = await batchSubs(env, from, limit, teamIds);
  var out = await pushMany(env, subs, payload, opts);
  var last = out.after || from;
  var left = await subsAfter(env, last, teamIds);
  return { sent: out.sent, failed: out.failed, dead: out.dead.length, after: last, remaining: left, off: !!out.off };
}

// The next batch past a cursor, and how many are left past one: every
// device, or those linked to one of the teams given.
function aimedAt(teamIds: number[] | null | undefined): string {
  return Array.isArray(teamIds) ? ' AND team_id IN (SELECT value FROM json_each(?2))' : '';
}

async function batchSubs(env: Env, after: number, limit: number | undefined, teamIds: number[] | null | undefined): Promise<Device[]> {
  var pick = env.DB.prepare(
    'SELECT id, endpoint, p256dh, auth FROM push_subs WHERE id > ?1' + aimedAt(teamIds) + ' ORDER BY id LIMIT ' +
    Math.max(1, Math.round(Number(limit) || PUSH_INLINE))
  );
  return (await (Array.isArray(teamIds) ? pick.bind(after, JSON.stringify(teamIds)) : pick.bind(after)).all<Device>()).results;
}

async function subsAfter(env: Env, after: number, teamIds: number[] | null | undefined): Promise<number> {
  var count = env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE id > ?1' + aimedAt(teamIds));
  return (await (Array.isArray(teamIds) ? count.bind(after, JSON.stringify(teamIds)) : count.bind(after)).first<{ n: number }>() as { n: number }).n;
}

// ---------- aimed at one team, or at one device ----------
// Both are small enough to finish inside the request that asked for
// them, so neither goes near the outbox or a cursor.
export async function pushToTeam(env: Env, teamId: number | null | undefined, payload: PushPayload, opts?: PushOpts): Promise<{ sent: number; failed: number; dead: number[]; after: number; off?: boolean }> {
  if (!teamId) return { sent: 0, failed: 0, dead: [], after: 0 };
  var subs = await env.DB.prepare(
    'SELECT id, endpoint, p256dh, auth FROM push_subs WHERE team_id = ?1 ORDER BY id LIMIT ?2'
  ).bind(teamId, PUSH_INLINE).all<Device>();
  return pushMany(env, subs.results, payload, opts);
}

export async function pushToDevice(env: Env, subId: unknown, payload: PushPayload, opts?: PushOpts): Promise<{ sent: number; failed: number; dead: number[]; after: number; off?: boolean }> {
  var row = await env.DB.prepare(
    'SELECT id, endpoint, p256dh, auth FROM push_subs WHERE id = ?1'
  ).bind(Math.round(Number(subId) || 0)).first<Device>();
  return pushMany(env, row ? [row] : [], payload, opts);
}

// A push to every device linked to one team — a rejected submission
// reaching the team it concerns. Quiet when push isn't configured.
export async function sendTeamPush(env: Env, teamId: number | null | undefined, payload: PushPayload, opts?: PushOpts): Promise<number> {
  if (!pushConfigured(env) || !teamId) return 0;
  return (await pushToTeam(env, teamId, payload, opts)).sent;
}

// One announcement to every subscribed device. The first batch goes out
// here, so an urgent message is on most phones before the save answers
// and the dashboard has a real count to show. Anything past that batch
// is left in push_outbox with the cursor, and the scheduled run works
// through it a batch a minute.
//
// It used to be a single pass of 400 with no follow-up: past that, the
// only way to reach the rest was to retype the message into the Push
// tab and send to everybody, which notified the first 400 twice.
//
// teamIds, when given, keeps the whole send to the devices linked to
// those teams, the queued rest included.
export async function sendAllPush(env: Env, payload: PushPayload, opts: PushOpts | undefined, teamIds?: number[] | null): Promise<{ sent: number; failed: number; dead: number; remaining: number; queued: boolean; off?: boolean }> {
  if (!pushConfigured(env)) return { sent: 0, failed: 0, dead: 0, remaining: 0, queued: false };
  var first = await pushBatch(env, payload, opts, 0, PUSH_INLINE, teamIds);
  if (first.off) return { sent: 0, failed: 0, dead: 0, remaining: 0, queued: false, off: true };
  var queued = false;
  if (first.remaining > 0) {
    await queuePush(env, payload, opts, first.after, teamIds);
    queued = true;
  }
  return {
    sent: first.sent, failed: first.failed, dead: first.dead,
    remaining: first.remaining, queued: queued
  };
}

// ---------- what the dashboard is allowed to know about a device ----------
// The endpoint and the two keys never leave the worker. They are
// enough to send a notification to that phone, which is exactly why
// push_subs is left out of the full export. So a device is described
// by what can be said safely: the name it was given, the push service
// its endpoint belongs to, and the team it linked itself to.
//
// The service is not the same thing as the device — Safari on a Mac
// and Safari on an iPhone both go through Apple, Chrome on Windows and
// Chrome on Android both through Google — which is why the site sends
// a name at all.
export function deviceService(endpoint: unknown): string {
  var host = '';
  try { host = new URL(String(endpoint)).hostname.toLowerCase(); } catch (err) { return 'Unknown'; }
  if (/(^|\.)push\.apple\.com$/.test(host)) return 'Apple';
  if (/(^|\.)googleapis\.com$/.test(host) || /(^|\.)fcm\.google(apis)?\.com$/.test(host)) return 'Google';
  if (/mozilla\.(com|org)$/.test(host)) return 'Mozilla';
  if (/notify\.windows\.com$/.test(host)) return 'Microsoft';
  return 'Unknown';
}

export async function pushDevices(db: D1Database): Promise<{ id: number; label: string; service: string; team_id: number | null; team_name: string; created_at: string }[]> {
  type Listed = Pick<PushSubRow, 'id' | 'endpoint' | 'team_id' | 'created_at' | 'label'> & { team_name: TeamRow['name'] | null };
  var rows = await db.prepare(
    'SELECT p.id, p.endpoint, p.team_id, p.created_at, t.name AS team_name, p.label ' +
    'FROM push_subs p LEFT JOIN teams t ON t.id = p.team_id ORDER BY p.id DESC LIMIT 500'
  ).all<Listed>();
  return rows.results.map(function (r) {
    return {
      id: r.id, label: r.label || '', service: deviceService(r.endpoint),
      team_id: r.team_id || null, team_name: r.team_name || '', created_at: r.created_at
    };
  });
}

// Renaming is the only edit the dashboard makes to a subscription, and
// it is the reason the list is worth having: two iPhones on the same
// team are otherwise told apart only by the minute they subscribed.
export async function nameDevice(db: D1Database, id: unknown, label: unknown): Promise<number | null> {
  var subId = Math.round(Number(id) || 0);
  if (!subId) return null;
  // an UPDATE that matches nothing is not an error, so the row is
  // looked for rather than the write being taken as proof it was there
  var row = await db.prepare('SELECT id FROM push_subs WHERE id = ?1').bind(subId).first<Pick<PushSubRow, 'id'>>();
  if (!row) return null;
  await db.prepare('UPDATE push_subs SET label = ?2 WHERE id = ?1')
    .bind(subId, cleanText(label, 40)).run();
  return subId;
}

// ---------- the outbox ----------
// What is left of an announcement, with the cursor it stopped at. One
// row per unfinished send; the scheduled run takes the oldest first,
// so two announcements in a minute go out in the order they were made.
export async function queuePush(env: Env, payload: PushPayload, opts: PushOpts | undefined, after: number, teamIds?: number[] | null): Promise<void> {
  opts = opts || {};
  var values: unknown[] = [
    String(payload.title || ''), String(payload.body || ''), String(payload.url || ''),
    String(payload.tag || ''), payload.renotify ? 1 : 0,
    String(opts.urgency || 'normal'), String(opts.topic || ''), after || 0
  ];
  // team_ids stays NULL for a send to everyone
  var stmt = env.DB.prepare(
    'INSERT INTO push_outbox (title, body, url, tag, renotify, urgency, topic, after_id, team_ids) ' +
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)'
  );
  await stmt.bind.apply(stmt, values.concat([Array.isArray(teamIds) ? JSON.stringify(teamIds) : null])).run();
}

// One tick's worth: the oldest unfinished announcement, one batch on
// from where it stopped. The row goes when the cursor passes the last
// subscriber. Nothing here throws — it runs on a timer with nobody
// watching, and a send that cannot be made is not worth losing the
// rest of the schedule over.
export async function pushOutboxTick(env: Env): Promise<{ ran: boolean; dropped?: boolean; title?: string; sent?: number; failed?: number; remaining?: number; done?: boolean }> {
  if (!pushConfigured(env)) return { ran: false };
  var row: PushOutboxRow | null;
  try {
    row = await env.DB.prepare(
      'SELECT * FROM push_outbox ORDER BY id LIMIT 1'
    ).first<PushOutboxRow>();
  } catch (err) {
    return { ran: false };
  }
  if (!row) return { ran: false };
  // switched off part way through a send: what is left is dropped rather
  // than going out whenever pushes come back on
  if (await pushesOff(env.DB)) {
    await env.DB.prepare('DELETE FROM push_outbox').run();
    return { ran: false, dropped: true };
  }
  var payload: PushPayload = { title: row.title, body: row.body, tag: row.tag, renotify: !!row.renotify };
  if (row.url) payload.url = row.url;
  var opts: PushOpts = { urgency: row.urgency || 'normal' };
  if (row.topic) opts.topic = row.topic;
  var teamIds: number[] | null = null;
  if (row.team_ids) {
    var parsed: unknown;
    try { parsed = JSON.parse(row.team_ids); } catch (err) { parsed = []; }
    teamIds = Array.isArray(parsed) ? parsed as number[] : [];
  }
  // Two scheduled runs can overlap, so the batch is claimed before any of
  // it is sent: the cursor moves past it only if it is still where this
  // run read it. The run that loses sends nothing. One that dies after
  // claiming loses that batch rather than anybody getting it twice.
  var subs = await batchSubs(env, row.after_id, PUSH_SWEEP, teamIds);
  var last = subs.length ? subs[subs.length - 1].id : row.after_id;
  var claim = await env.DB.prepare('UPDATE push_outbox SET after_id = ?2 WHERE id = ?1 AND after_id = ?3')
    .bind(row.id, last, row.after_id).run();
  if (!(claim.meta && claim.meta.changes)) return { ran: false };
  var out = await pushMany(env, subs, payload, opts);
  var remaining = await subsAfter(env, last, teamIds);
  if (remaining > 0) {
    await env.DB.prepare(
      'UPDATE push_outbox SET sent = sent + ?2, failed = failed + ?3 WHERE id = ?1'
    ).bind(row.id, out.sent, out.failed).run();
  } else {
    await env.DB.prepare('DELETE FROM push_outbox WHERE id = ?1').bind(row.id).run();
  }
  return {
    ran: true, title: row.title, sent: out.sent, failed: out.failed,
    remaining: remaining, done: remaining === 0
  };
}

// What the dashboard shows about work still in hand.
export async function outboxWaiting(db: D1Database): Promise<number> {
  try {
    var row = await db.prepare('SELECT COUNT(*) AS n FROM push_outbox').first<{ n: number }>();
    return row ? row.n : 0;
  } catch (err) {
    return 0;
  }
}

// Drops subscriptions whose push service said they are gone.
export async function pruneSubs(env: Env, ids: number[]): Promise<void> {
  if (!ids.length) return;
  await env.DB.prepare('DELETE FROM push_subs WHERE id IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(ids)).run();
}
