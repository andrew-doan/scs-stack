// SCS.2 check-in — its own Cloudflare Worker, its own D1 database, its
// own R2 bucket. Nothing here is reachable from the public website on
// purpose: registration needs a bearer key, the scanner and the board
// need a password (checked here, never in the page), and the QR
// images live under random names so the bucket cannot be walked.
//
// The flow: something with the registration key (the Discord bot, a
// mail-merge script) POSTs a person's details to /api/register and
// gets back a QR image URL to send them. On the day, door crew open
// /scan on their phones, type the scan password once, and point the
// camera at codes — or look people up by name when someone arrives
// without one. /board shows the running totals for the wall. When the
// last member of a team checks in, the worker tells the tab bot, with
// the time, so on-time teams can be given their points.

import { qrcode } from './vendor/qrcode.js';
import jsqrSource from './vendor/jsqr-source.js';
import { grayPng } from './png.js';
import { scanPage, boardPage } from './pages.js';

// ---------- input hygiene ----------
// Everything in the register body is typed by strangers. Queries are
// all bound parameters so injection is off the table; this trims the
// text down to something safe to store, show, and put in an email.

export function cleanText(value, max) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ') // control characters
    .replace(/[<>&"'`]/g, '')                // never meaningful in a name
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

export function cleanEmail(value) {
  var email = String(value == null ? '' : value).trim().slice(0, 120);
  if (!/^[^\s@<>,;"']+@[^\s@<>,;"']+\.[^\s@<>,;"']+$/.test(email)) return null;
  return email;
}

export function cleanZid(value) {
  var m = String(value == null ? '' : value).trim().match(/^z?(\d{7})$/i);
  return m ? 'z' + m[1] : null;
}

// The tab worker's participants.id for the same person. It is the one
// thing about them that does not change when an organiser edits a name
// or renames a team, so it is what the two databases match on. Anything
// that is not a positive whole number counts as no id at all.
export function cleanParticipantId(value) {
  var n = Number(value);
  return isFinite(n) && n > 0 && n === Math.round(n) ? n : null;
}

// ---------- randomness ----------

function randomKey(bytes) {
  var buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  var bin = '';
  for (var i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  // base64url: safe in URLs and QR payloads, no padding
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------- secret comparison ----------
// Hash both sides first so the byte-by-byte compare cannot leak how
// much of a guess was right.

async function secretMatches(given, expected) {
  if (!given || !expected) return false;
  var enc = new TextEncoder();
  var a = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(given))));
  var b = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(expected))));
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function configured(secret) {
  return !!secret && String(secret).indexOf('PASTE') !== 0;
}

// ---------- QR rendering ----------

export function qrPngFor(text) {
  var qr = qrcode(0, 'M'); // 0 = smallest version that fits
  qr.addData(text);
  qr.make();
  var n = qr.getModuleCount();
  var scale = 8;
  var quiet = 4; // modules of white border, per the QR spec
  var size = (n + quiet * 2) * scale;
  var px = new Uint8Array(size * size).fill(255);
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      var x0 = (quiet + c) * scale;
      for (var dy = 0; dy < scale; dy++) {
        var rowStart = ((quiet + r) * scale + dy) * size + x0;
        px.fill(0, rowStart, rowStart + scale);
      }
    }
  }
  return grayPng(size, size, px);
}

// ---------- responses ----------

function json(payload, status) {
  return new Response(JSON.stringify(payload), {
    status: status || 200,
    headers: { 'content-type': 'application/json' }
  });
}

function page(html) {
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-robots-tag': 'noindex',
      'cache-control': 'no-store'
    }
  });
}

// ---------- sessions ----------

async function createSession(db, role) {
  var token = randomKey(32);
  await db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  await db.prepare(
    "INSERT INTO sessions (token, role, expires_at) VALUES (?1, ?2, datetime('now', '+18 hours'))"
  ).bind(token, role).run();
  return token;
}

// roles: which session roles may use the endpoint
async function requireSession(request, db, roles) {
  var header = request.headers.get('authorization') || '';
  var token = header.indexOf('Bearer ') === 0 ? header.slice(7).trim() : '';
  if (!token) return null;
  var row = await db.prepare(
    "SELECT role FROM sessions WHERE token = ?1 AND expires_at > datetime('now')"
  ).bind(token).first();
  if (!row || roles.indexOf(row.role) === -1) return null;
  return row;
}

// ---------- team status ----------

async function teamStatus(db, teamName) {
  var row = await db.prepare(
    'SELECT COUNT(*) AS size, COUNT(checked_in_at) AS checked_in, MAX(checked_in_at) AS last_at ' +
    'FROM attendees WHERE team_name = ?1 COLLATE NOCASE AND hidden = 0'
  ).bind(teamName).first();
  return {
    size: row.size,
    checked_in: row.checked_in,
    complete: row.size > 0 && row.checked_in === row.size,
    completed_at: row.size > 0 && row.checked_in === row.size ? row.last_at : null,
    last_at: row.last_at || null
  };
}

// Tell the tab worker who just checked in (or was taken back off) and
// where their team stands: whether it is fully in, how many of how many,
// and when the last of those in arrived.
// The tab keeps the complete teams and posts the line in the team's
// Discord channel. Signed with the shared TAB_SYNC_KEY; if either side
// is missing its key nothing is sent and check-in carries on.
// `at` is when the change happened (the check-in, the undo or the
// hide), which the tab uses to pass over a report that arrives after a
// newer one.
function reportTeam(env, ctx, teamName, status, person, event, at) {
  if (!env.TAB_API || !configured(env.TAB_SYNC_KEY)) return;
  var send = fetch(env.TAB_API.replace(/\/$/, '') + '/api/team-checkin', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + env.TAB_SYNC_KEY
    },
    body: JSON.stringify({
      team_name: teamName,
      completed_at: status.complete ? status.completed_at : null,
      people: status.size,
      checked_in: status.checked_in,
      last_at: status.last_at,
      at: at || null,
      person: person || '',
      event: event || ''
    })
  }).then(function (resp) {
    // a report is sent once. A completion lost this way (a TAB_SYNC_KEY
    // that does not match, say) is recorded by the tab the next time its
    // dashboard reads /api/status; the log is where the loss shows
    if (!resp.ok) console.error('team check-in report for "' + teamName + '" refused by the tab: HTTP ' + resp.status);
  }).catch(function (err) {
    console.error('team check-in report for "' + teamName + '" did not reach the tab: ' + String(err && err.message || err));
  });
  if (ctx && ctx.waitUntil) ctx.waitUntil(send);
}

// ---------- handlers ----------

// The tab worker's key, shared by everything it calls here. An unset
// key means the endpoint is not open yet (403); a wrong one is 401.
// Returns null when the caller may pass, a refusal otherwise.
async function requireRegistrationKey(request, env) {
  var auth = request.headers.get('authorization') || '';
  var key = auth.indexOf('Bearer ') === 0 ? auth.slice(7).trim() : '';
  if (!configured(env.REGISTRATION_KEY)) {
    return json({ error: 'registration is locked until REGISTRATION_KEY is set on the worker' }, 403);
  }
  if (!(await secretMatches(key, env.REGISTRATION_KEY))) {
    return json({ error: 'bad registration key' }, 401);
  }
  return null;
}

var ATTENDEE_COLUMNS = 'id, name, email, team_name, zid, qr_key, token, participant_id';

// The row a registration matches, by the rules handleRegister explains.
// MATCH is the same rules as one condition, for the insert below, which
// adds a row only while none matches: ?1 name, ?3 team, ?4 zID, ?7
// participant id.
// A row already claimed by a different participant is never matched by
// zID or name: it belongs to someone else. For z0000000 that is someone
// who shares a name and a team; for a real zID it is a person whose zID
// the tab has since corrected (it does not send the change here), and
// the zID's real owner must not take over their code.
async function findAttendee(db, participantId, zid, name, team) {
  var existing = participantId
    ? await db.prepare('SELECT ' + ATTENDEE_COLUMNS + ' FROM attendees WHERE participant_id = ?1').bind(participantId).first()
    : null;
  if (existing) return existing;
  return zid === 'z0000000'
    ? db.prepare(
        'SELECT ' + ATTENDEE_COLUMNS + ' FROM attendees ' +
        "WHERE zid = 'z0000000' AND name = ?1 COLLATE NOCASE AND team_name = ?2 COLLATE NOCASE " +
        'AND (participant_id IS NULL OR ?3 IS NULL OR participant_id = ?3)'
      ).bind(name, team, participantId).first()
    : db.prepare(
        'SELECT ' + ATTENDEE_COLUMNS + ' FROM attendees WHERE zid = ?1 ' +
        'AND (participant_id IS NULL OR ?2 IS NULL OR participant_id = ?2)'
      ).bind(zid, participantId).first();
}
var MATCH =
  '(?7 IS NOT NULL AND participant_id = ?7) ' +
  "OR (?4 <> 'z0000000' AND zid = ?4 AND (participant_id IS NULL OR ?7 IS NULL OR participant_id = ?7)) " +
  "OR (?4 = 'z0000000' AND zid = 'z0000000' AND name = ?1 COLLATE NOCASE AND team_name = ?3 COLLATE NOCASE " +
  'AND (participant_id IS NULL OR ?7 IS NULL OR participant_id = ?7))';

async function handleRegister(request, env) {
  var refused = await requireRegistrationKey(request, env);
  if (refused) return refused;

  var body;
  try { body = await request.json(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }

  var name = cleanText(body.name, 80);
  var email = cleanEmail(body.email);
  var team = cleanText(body.team_name != null ? body.team_name : body.team, 80);
  var zid = cleanZid(body.zid != null ? body.zid : body.student_id);
  var participantId = cleanParticipantId(body.participant_id);
  if (!name) return json({ error: 'name is required' }, 400);
  if (!email) return json({ error: 'that email address does not look right' }, 400);
  if (!team) return json({ error: 'team_name is required' }, 400);
  if (!zid) return json({ error: 'zid must be a zID: z followed by seven digits' }, 400);

  var origin = new URL(request.url).origin;

  // one person, one code: registering the same person again returns the
  // QR they already have instead of minting a second identity.
  // participant_id is the first thing tried because it is the only key
  // that survives a rename. Without one (a row from before the column
  // existed, or a person whose participants row did not exist yet when
  // they were first registered) the zID does the job — except for
  // z0000000, the shared not-a-UNSW-student marker, which stands for no
  // zID at all and cannot tell two people apart, so those are matched on
  // their name and team and each still gets a code of their own.
  var existing = await findAttendee(env.DB, participantId, zid, name, team);
  if (existing) return registered(env.DB, origin, existing, participantId, name, email, team, zid);

  // 16 bytes = 128 bits, still unguessable, and short enough that the
  // ticket link carrying it stays compact (older 24-byte tokens keep
  // working — the scan accepts 16 to 64 characters)
  var token = randomKey(16);
  var qrKey = randomKey(24);
  var png = qrPngFor('scs2:' + token);
  await env.QR.put('qr/' + qrKey + '.png', png, {
    httpMetadata: { contentType: 'image/png' }
  });
  // Two registrations of one person at once (the scheduled sweep and a
  // Create QR, say) both find nobody above. The insert asks again in the
  // same statement, so the second adds nothing and answers with the row
  // the first made; its image is taken back.
  var inserted;
  try {
    inserted = await env.DB.prepare(
      'INSERT INTO attendees (name, email, team_name, zid, token, qr_key, participant_id) ' +
      'SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 WHERE NOT EXISTS (SELECT 1 FROM attendees WHERE ' + MATCH + ')'
    ).bind(name, email, team, zid, token, qrKey, participantId).run();
  } catch (err) {
    // the zID is on a row another participant holds (MATCH leaves it
    // alone), and real zIDs are unique
    if (!/UNIQUE constraint failed/i.test(String(err && err.message)) || zid === 'z0000000') throw err;
    try { await env.QR.delete('qr/' + qrKey + '.png'); } catch (err2) { /* nothing points at it */ }
    return json({ error: zid + ' is on another person\'s code. Correct the zID of whichever of the two has it wrong.' }, 409);
  }
  if (!(inserted.meta && inserted.meta.changes)) {
    try { await env.QR.delete('qr/' + qrKey + '.png'); } catch (err) { /* nothing points at it */ }
    existing = await findAttendee(env.DB, participantId, zid, name, team);
    if (!existing) return json({ error: 'Something went wrong. Try again.' }, 500);
    return registered(env.DB, origin, existing, participantId, name, email, team, zid);
  }

  return json({
    ok: true,
    id: inserted.meta && inserted.meta.last_row_id,
    participant_id: participantId,
    name: name,
    team_name: team,
    zid: zid,
    qr_url: origin + '/qr/' + qrKey + '.png',
    token: token
  });
}

// A registration that matched someone already here. What was just sent
// is the truth: the dashboard may have edited this person, or their
// team, since the row was written. Refreshing it here is what makes the
// Rego tab's "Create QR code" repair a stale row, and it fills in the
// participant id when the row predates one. The token and the image
// never change — a match must never hand out a second identity.
async function registered(db, origin, existing, participantId, name, email, team, sentZid) {
  var changed = existing.name !== name || existing.team_name !== team || existing.email !== email ||
    (participantId && existing.participant_id !== participantId);
  if (changed) {
    await db.prepare(
      'UPDATE attendees SET name = ?2, email = ?3, team_name = ?4, participant_id = COALESCE(?5, participant_id) WHERE id = ?1'
    ).bind(existing.id, name, email, team, participantId).run();
  }
  // The same person by the shared id with a zID the tab has corrected:
  // the row takes it, so the zID it held is free for its real owner. One
  // still on somebody else's row is left as it was.
  var zid = existing.zid;
  if (participantId && existing.participant_id === participantId && sentZid && sentZid !== existing.zid &&
      !/^removed-/.test(existing.zid)) {
    var moved = await db.prepare('UPDATE OR IGNORE attendees SET zid = ?2 WHERE id = ?1').bind(existing.id, sentZid).run();
    if (moved.meta && moved.meta.changes) zid = sentZid;
  }
  return json({
    ok: true,
    already_registered: true,
    id: existing.id,
    participant_id: participantId || existing.participant_id || null,
    name: name,
    team_name: team,
    zid: zid,
    qr_url: origin + '/qr/' + existing.qr_key + '.png',
    token: existing.token
  });
}

// ---------- keeping the names in step ----------
// The tab worker owns the names; this roster only holds a copy of them.
// When an organiser edits a person or renames a team on the dashboard,
// the tab worker posts the change here. Without it the row at the door
// keeps the old name: the check-in mark stops showing on the Rego tab,
// and a person carrying the shared z0000000 marker — who is found by
// name and team — gets a second code minted next time they are
// registered while the first one still works.

var MAX_RENAMES = 200;  // one dashboard save, not a bulk import

async function handleRename(request, env) {
  var refused = await requireRegistrationKey(request, env);
  if (refused) return refused;

  var body;
  try { body = await request.json(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }

  var list;
  if (Array.isArray(body.people)) list = body.people;
  else if (body.people && typeof body.people === 'object') list = [body.people];
  else if (body.name != null || body.participant_id != null) list = [body];  // one person, sent bare
  else list = [];
  if (list.length > MAX_RENAMES) {
    return json({ error: 'at most ' + MAX_RENAMES + ' people at a time' }, 400);
  }

  var updates = [];
  var missed = [];
  for (var i = 0; i < list.length; i++) {
    var entry = list[i] || {};
    var pid = cleanParticipantId(entry.participant_id);
    var name = cleanText(entry.name, 80);
    var team = cleanText(entry.team_name != null ? entry.team_name : entry.team, 80);
    var wasName = cleanText(entry.was_name, 80);
    var wasTeam = cleanText(entry.was_team, 80);
    var row = null;
    if (name && team) {
      if (pid) {
        row = await env.DB.prepare('SELECT id FROM attendees WHERE participant_id = ?1').bind(pid).first();
      }
      // A row written before the shared id existed carries none, so the
      // first rename has to find it under the name it still has. Every
      // lookup runs before any of the writes below, so a whole team
      // moving at once still finds each member under the old team name.
      if (!row && wasName && wasTeam) {
        row = await env.DB.prepare(
          'SELECT id FROM attendees WHERE name = ?1 COLLATE NOCASE AND team_name = ?2 COLLATE NOCASE'
        ).bind(wasName, wasTeam).first();
      }
    }
    // Nobody to rename is an ordinary answer, not a failure: the person
    // may have no code yet, or belong to a database this worker has
    // never seen. The caller gets them back in `missed`.
    if (!row) { missed.push({ participant_id: pid, name: name, team_name: team }); continue; }
    updates.push(env.DB.prepare(
      'UPDATE attendees SET name = ?2, team_name = ?3, participant_id = COALESCE(?4, participant_id) WHERE id = ?1'
    ).bind(row.id, name, team, pid));
  }
  if (updates.length) await env.DB.batch(updates);

  return json({ ok: true, updated: updates.length, missed: missed });
}

// The tab worker's word on who is a test person: {people: [{participant_id,
// name, team_name, hidden}]}, each found by the shared id and then by name
// and team, the way a rename is. A hidden person is kept off the board,
// out of the scanner's list and out of the counts, and their code checks
// nobody in.
async function handleHide(request, env, ctx) {
  var refused = await requireRegistrationKey(request, env);
  if (refused) return refused;
  var body;
  try { body = await request.json(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  var list = Array.isArray(body.people) ? body.people : [];
  if (list.length > MAX_RENAMES) {
    return json({ error: 'at most ' + MAX_RENAMES + ' people at a time' }, 400);
  }
  var updates = [];
  var missed = [];
  for (var i = 0; i < list.length; i++) {
    var entry = list[i] || {};
    var pid = cleanParticipantId(entry.participant_id);
    var name = cleanText(entry.name, 80);
    var team = cleanText(entry.team_name, 80);
    var row = null;
    if (pid) row = await env.DB.prepare('SELECT id FROM attendees WHERE participant_id = ?1').bind(pid).first();
    if (!row && name && team) {
      row = await env.DB.prepare(
        'SELECT id FROM attendees WHERE name = ?1 COLLATE NOCASE AND team_name = ?2 COLLATE NOCASE'
      ).bind(name, team).first();
    }
    if (!row) { missed.push({ participant_id: pid, name: name, team_name: team }); continue; }
    updates.push(env.DB.prepare('UPDATE attendees SET hidden = ?2 WHERE id = ?1 AND hidden != ?2 RETURNING team_name')
      .bind(row.id, entry.hidden ? 1 : 0));
  }
  if (!updates.length) return json({ ok: true, updated: 0, missed: missed });
  // Hidden people are left out of a team's count, so a team whose people
  // changed is reported to the tab as a check-in would be: hiding the
  // one person not yet in completes a team, hiding one who is in takes
  // them off its count.
  var teams = {};
  for (var u = 0; u < updates.length; u++) {
    var moved = await updates[u].first();
    if (moved) teams[moved.team_name.toLowerCase()] = moved.team_name;
  }
  var stamp = await env.DB.prepare("SELECT datetime('now') AS at").first();
  var names = Object.keys(teams);
  for (var t = 0; t < names.length; t++) {
    reportTeam(env, ctx, teams[names[t]], await teamStatus(env.DB, teams[names[t]]), '', '', stamp.at);
  }
  return json({ ok: true, updated: updates.length, missed: missed });
}

// ---------- personal data ----------
// The tab worker's dashboard takes every person's email address and zID
// off both databases into a file an organiser keeps, and puts them back
// from that file (tab/src/privacy.ts). A zID taken off becomes
// removed-<id> rather than empty: the column is NOT NULL and real zIDs
// are unique, so an empty one could stand on one row only. z0000000 is
// the not-at-UNSW marker, nobody's number, and stays as it is.
var MAX_PERSONAL = 20000;
var REMOVED_ZID = /^removed-\d+$/;

function realZid(zid) { return !!zid && zid !== 'z0000000' && !REMOVED_ZID.test(zid); }

// everyone holding an email address or a zID
async function personalRows(db) {
  var rows = (await db.prepare('SELECT id, participant_id, name, team_name, email, zid FROM attendees ORDER BY id').all()).results;
  return rows.filter(function (r) { return (r.email || '') !== '' || realZid(r.zid); }).map(function (r) {
    return {
      id: r.id, participant_id: r.participant_id == null ? null : r.participant_id, name: r.name, team_name: r.team_name,
      email: r.email || '', zid: realZid(r.zid) ? r.zid : ''
    };
  });
}

async function readPeople(request) {
  var body;
  try { body = await request.json(); } catch (err) { return { refused: json({ error: 'body must be JSON' }, 400) }; }
  var list = body && Array.isArray(body.people) ? body.people : [];
  if (list.length > MAX_PERSONAL) return { refused: json({ error: 'at most ' + MAX_PERSONAL + ' people at a time' }, 400) };
  return { list: list };
}

async function handlePersonalExport(request, env) {
  var refused = await requireRegistrationKey(request, env);
  if (refused) return refused;
  return json({ ok: true, people: await personalRows(env.DB) });
}

// {people: [{id, email, zid}]}: takes them off, but only when the list
// holds every person holding either, as they are now
async function handlePersonalClear(request, env) {
  var refused = await requireRegistrationKey(request, env);
  if (refused) return refused;
  var read = await readPeople(request);
  if (read.refused) return read.refused;
  var given = {};
  read.list.forEach(function (p) {
    var id = cleanParticipantId(p && p.id);
    if (id) given[id] = p;
  });
  var rows = await personalRows(env.DB);
  var changed = rows.filter(function (r) {
    var p = given[r.id];
    return !p || String(p.email == null ? '' : p.email) !== r.email || String(p.zid == null ? '' : p.zid) !== r.zid;
  }).length;
  if (changed) {
    return json({ error: changed + (changed === 1 ? ' person here has' : ' people here have') + ' changed since the copy was made', changed: changed }, 409);
  }
  if (rows.length) {
    await env.DB.prepare(
      "UPDATE attendees SET email = '', zid = CASE WHEN zid = 'z0000000' OR zid LIKE 'removed-%' THEN zid ELSE 'removed-' || id END " +
      'WHERE id IN (SELECT value FROM json_each(?1))'
    ).bind(JSON.stringify(rows.map(function (r) { return r.id; }))).run();
  }
  return json({ ok: true, cleared: rows.length });
}

// {people: [{id, email, zid}]}: each put back where it was taken off, so
// someone registered or edited since keeps what they have now, and a zID
// somebody else has taken since is left off rather than failing the rest
async function handlePersonalRestore(request, env) {
  var refused = await requireRegistrationKey(request, env);
  if (refused) return refused;
  var read = await readPeople(request);
  if (read.refused) return read.refused;
  var back = [];
  read.list.forEach(function (p) {
    var id = cleanParticipantId(p && p.id);
    if (id) back.push({ id: id, email: cleanEmail(p.email) || '', zid: cleanZid(p.zid) || '' });
  });
  if (!back.length) return json({ ok: true, restored: 0 });
  var pick = function (field) {
    return "(SELECT NULLIF(json_extract(value, '$." + field + "'), '') FROM json_each(?1) WHERE json_extract(value, '$.id') = attendees.id)";
  };
  var res = await env.DB.prepare(
    "UPDATE OR IGNORE attendees SET email = CASE WHEN email = '' THEN COALESCE(" + pick('email') + ", '') ELSE email END, " +
    "zid = CASE WHEN zid LIKE 'removed-%' THEN COALESCE(" + pick('zid') + ', zid) ELSE zid END ' +
    "WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1)) AND (email = '' OR zid LIKE 'removed-%')"
  ).bind(JSON.stringify(back)).run();
  var meta = res && res.meta ? res.meta : {};
  return json({ ok: true, restored: (meta.changes != null ? meta.changes : meta.rows_written) || 0 });
}

async function handleQrImage(env, pathname) {
  var m = pathname.match(/^\/qr\/([A-Za-z0-9_-]{16,64})\.png$/);
  if (!m) return new Response('not found', { status: 404 });
  var object = await env.QR.get('qr/' + m[1] + '.png');
  if (!object) return new Response('not found', { status: 404 });
  return new Response(object.body, {
    headers: {
      'content-type': 'image/png',
      // the name is the secret; the image itself never changes
      'cache-control': 'public, max-age=31536000, immutable'
    }
  });
}

async function handleLogin(request, env) {
  var body;
  try { body = await request.json(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  var role = body.role === 'board' ? 'board' : 'scan';
  var expected = role === 'board' ? env.BOARD_PASSWORD : env.SCAN_PASSWORD;
  if (!configured(expected)) {
    return json({ error: 'this page is locked until its password is set on the worker' }, 403);
  }
  if (!(await secretMatches(String(body.password || ''), expected))) {
    // a beat of delay keeps guessing slow without hurting real logins
    await new Promise(function (resolve) { setTimeout(resolve, 400); });
    return json({ error: 'wrong password' }, 401);
  }
  var token = await createSession(env.DB, role);
  return json({ ok: true, session: token, role: role });
}

async function handleCheckin(request, env, ctx) {
  var session = await requireSession(request, env.DB, ['scan']);
  if (!session) return json({ error: 'not signed in' }, 401);

  var body;
  try { body = await request.json(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }

  var attendee = null;
  var cols = 'SELECT id, name, team_name, zid, checked_in_at, hidden FROM attendees ';
  if (body.token != null) {
    var token = String(body.token).replace(/^scs2:/, '').trim();
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return json({ ok: false, error: 'not a check-in code' }, 404);
    attendee = await env.DB.prepare(cols + 'WHERE token = ?1').bind(token).first();
  } else if (body.id != null) {
    attendee = await env.DB.prepare(cols + 'WHERE id = ?1').bind(Number(body.id) || 0).first();
  }
  if (!attendee) return json({ ok: false, error: 'no such person' }, 404);
  if (attendee.hidden) {
    return json({ ok: false, hidden: true, error: 'a test ticket', name: attendee.name, team_name: attendee.team_name }, 409);
  }

  var already = !!attendee.checked_in_at;
  var at = attendee.checked_in_at;
  if (!already) {
    // Two scanners on the same code at once: the stamp only lands on a
    // person not yet in, so one of them checks them in and reports it,
    // and the other reads as already in.
    var stamped = await env.DB.prepare(
      "UPDATE attendees SET checked_in_at = datetime('now'), checked_in_by = ?2 WHERE id = ?1 AND checked_in_at IS NULL RETURNING checked_in_at"
    ).bind(attendee.id, body.token != null ? 'qr' : 'manual').first();
    if (stamped) {
      at = stamped.checked_in_at;
    } else {
      already = true;
      var now = await env.DB.prepare('SELECT checked_in_at FROM attendees WHERE id = ?1').bind(attendee.id).first();
      at = now ? now.checked_in_at : null;
    }
  }
  var team = await teamStatus(env.DB, attendee.team_name);
  if (!already) reportTeam(env, ctx, attendee.team_name, team, attendee.name, 'in', at);

  return json({
    ok: true,
    already: already,
    id: attendee.id,
    name: attendee.name,
    team_name: attendee.team_name,
    zid: attendee.zid,
    checked_in_at: at,
    team: team
  });
}

// The undo for a mis-tap on the manual list. The tab is told, as it is
// of every check-in.
async function handleUncheckin(request, env, ctx) {
  var session = await requireSession(request, env.DB, ['scan']);
  if (!session) return json({ error: 'not signed in' }, 401);
  var body;
  try { body = await request.json(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  var attendee = await env.DB.prepare(
    'SELECT id, name, team_name, checked_in_at FROM attendees WHERE id = ?1'
  ).bind(Number(body.id) || 0).first();
  if (!attendee) return json({ ok: false, error: 'no such person' }, 404);
  // only a person still in is taken back off, so a second tap reports
  // nothing
  var undone = attendee.checked_in_at ? await env.DB.prepare(
    "UPDATE attendees SET checked_in_at = NULL, checked_in_by = NULL WHERE id = ?1 AND checked_in_at IS NOT NULL RETURNING datetime('now') AS at"
  ).bind(attendee.id).first() : null;
  var team = await teamStatus(env.DB, attendee.team_name);
  if (undone) reportTeam(env, ctx, attendee.team_name, team, attendee.name, 'out', undone.at);
  return json({ ok: true, id: attendee.id, name: attendee.name, team_name: attendee.team_name, team: team });
}

async function handleAttendees(request, env, url) {
  var session = await requireSession(request, env.DB, ['scan']);
  if (!session) return json({ error: 'not signed in' }, 401);
  var q = cleanText(url.searchParams.get('q'), 60).replace(/[%_\\]/g, ' ').trim();
  var rows;
  // test people are not on the scanner's list
  if (q) {
    rows = await env.DB.prepare(
      'SELECT id, name, team_name, zid, checked_in_at FROM attendees ' +
      "WHERE hidden = 0 AND (name LIKE ?1 ESCAPE '\\' COLLATE NOCASE " +
      "   OR team_name LIKE ?1 ESCAPE '\\' COLLATE NOCASE " +
      "   OR zid LIKE ?1 ESCAPE '\\' COLLATE NOCASE) " +
      'ORDER BY team_name COLLATE NOCASE, name COLLATE NOCASE LIMIT 50'
    ).bind('%' + q + '%').all();
  } else {
    rows = await env.DB.prepare(
      'SELECT id, name, team_name, zid, checked_in_at FROM attendees WHERE hidden = 0 ' +
      'ORDER BY team_name COLLATE NOCASE, name COLLATE NOCASE LIMIT 50'
    ).all();
  }
  return json({ ok: true, attendees: rows.results });
}

async function handleStatus(request, env) {
  // a scanner or board session, or the tab worker with the
  // registration key (the dashboard shows who has checked in)
  var session = await requireSession(request, env.DB, ['scan', 'board']);
  var tabWorker = !session;
  if (!session) {
    var auth = request.headers.get('authorization') || '';
    var key = auth.indexOf('Bearer ') === 0 ? auth.slice(7).trim() : '';
    if (!configured(env.REGISTRATION_KEY) || !(await secretMatches(key, env.REGISTRATION_KEY))) {
      return json({ error: 'not signed in' }, 401);
    }
  }
  // one read of the roster; totals and the per-team rollup fall out of
  // it. Names and times only — the board is a wall display, zIDs stay
  // off it. participant_id rides along so the tab worker can mark the
  // right person even after a rename, and the tab worker alone also gets
  // the zID and the email, which find a row written before either worker
  // kept the shared id.
  // Test people are left out of every count and, for the board and the
  // scanner, out of the list too; the tab worker gets them back marked,
  // which is how it knows whose flag to put right.
  var people = await env.DB.prepare(
    'SELECT name, team_name, checked_in_at, participant_id, zid, email, hidden FROM attendees ' +
    'ORDER BY team_name COLLATE NOCASE, name COLLATE NOCASE'
  ).all();
  var shown = people.results.filter(function (p) { return !p.hidden; });
  var teams = [];
  var byTeam = {};
  var checkedIn = 0;
  shown.forEach(function (p) {
    var key = p.team_name.toLowerCase();
    var t = byTeam[key];
    if (!t) {
      t = byTeam[key] = { team_name: p.team_name, size: 0, checked_in: 0, complete: false, completed_at: null };
      teams.push(t);
    }
    t.size++;
    if (p.checked_in_at) {
      t.checked_in++;
      checkedIn++;
      if (!t.completed_at || p.checked_in_at > t.completed_at) t.completed_at = p.checked_in_at;
    }
  });
  var complete = 0;
  teams.forEach(function (t) {
    t.complete = t.checked_in === t.size;
    if (t.complete) complete++; else t.completed_at = null;
  });
  return json({
    ok: true,
    people: shown.length,
    people_checked_in: checkedIn,
    teams: teams.length,
    teams_complete: complete,
    team_list: teams,
    people_list: tabWorker ? people.results : shown.map(function (p) {
      delete p.hidden; delete p.zid; delete p.email;
      return p;
    })
  });
}

export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);
    var path = url.pathname;

    if (request.method === 'GET') {
      if (path === '/scan' || path === '/scan/') return page(scanPage());
      if (path === '/board' || path === '/board/') return page(boardPage());
      if (path === '/scan/jsqr.js') {
        return new Response(jsqrSource, {
          headers: {
            'content-type': 'application/javascript; charset=utf-8',
            'cache-control': 'public, max-age=86400'
          }
        });
      }
      // A code to look at, not to scan anybody in with. The dashboard's
      // test ticket email needs a picture the right shape and size in
      // the place the real one goes; minting a real code for it would
      // put a person who does not exist on the board, and there is no
      // way to take them off it again. Nothing is written or read: the
      // image is drawn on the spot from a fixed string, and a scanner
      // pointed at it answers "not found" like any other stranger.
      if (path === '/qr/demo.png') {
        return new Response(qrPngFor('scs2:demo'), {
          headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }
        });
      }
      if (path.indexOf('/qr/') === 0) return handleQrImage(env, path);
      if (path === '/api/status') return handleStatus(request, env);
      if (path === '/api/attendees') return handleAttendees(request, env, url);
      return new Response('SCS.2 check-in. /scan and /board for organisers; everything else needs a key.', { status: 200 });
    }

    if (request.method === 'POST') {
      try {
        if (path === '/api/register') return await handleRegister(request, env);
        if (path === '/api/rename') return await handleRename(request, env);
        if (path === '/api/hide') return await handleHide(request, env, ctx);
        if (path === '/api/personal/export') return await handlePersonalExport(request, env);
        if (path === '/api/personal/clear') return await handlePersonalClear(request, env);
        if (path === '/api/personal/restore') return await handlePersonalRestore(request, env);
        if (path === '/api/login') return await handleLogin(request, env);
        if (path === '/api/checkin') return await handleCheckin(request, env, ctx);
        if (path === '/api/uncheckin') return await handleUncheckin(request, env, ctx);
      } catch (err) {
        return json({ error: 'Something went wrong. Try again.' }, 500);
      }
      return json({ error: 'not found' }, 404);
    }

    return new Response('method not allowed', { status: 405 });
  }
};
