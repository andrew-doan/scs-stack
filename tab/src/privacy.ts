// Personal data: the sign-ups' email addresses, zIDs and dietary needs,
// the EOI list and the addresses announcements went to, here and in the
// check-in worker's own copy, taken off both databases into a file an
// organiser keeps, and put back from that file.
//
// GET privacy          what is stored now, and whether it has been taken off
// GET privacy/export   the file: every value that removing would take off
// POST privacy/remove  {copy}: take them off, only when the copy holds every
//                      one of them as it is now, so nothing goes that the
//                      organiser does not have in hand
// POST privacy/restore {copy}: put them back where the field is empty now,
//                      so anything typed in since is kept
//
// All admin only (dash-access.ts lists none of them), and the second
// password can be asked for each (GUARDS, privacy).
import { json, configured, cleanText, utcStamp } from './shared.ts';
import type { ConsoleSession, Env, JsonBody, LogAction, SiteTextRow } from './types.ts';

export var COPY_KIND = 'scs2-personal-data';
var COPY_VERSION = 1;
// site_text row holding {at, by, people} while the data is off
var REMOVED = 'personal_removed';
// what one copy may hold, well past one event's worth
var MAX_ROWS = 20000;

interface Person { id: number; name: string; team: string; zid: string; email: string; dietary: string }
interface EoiRow { id: number; email: string; zid: string }
interface QueueRow { id: number; send_id: number; email: string; status: string; claimed_at: string | null; error: string }
// a row of the check-in worker's attendees
interface DoorRow { id: number; participant_id: number | null; name: string; team_name: string; email: string; zid: string }

interface Copy {
  kind: string;
  version: number;
  exported_at: string;
  exported_by: string;
  people: Person[];
  eoi: EoiRow[];
  email_queue: QueueRow[];
  checkin: { people: DoorRow[] } | null;
  checkin_note?: string;
}

interface Stored { people: Person[]; eoi: EoiRow[]; queue: QueueRow[] }

export interface RemovedMark { at: string; by: string; people: number }

// What is stored now. A person counts when any of the three is there.
async function stored(db: D1Database): Promise<Stored> {
  var people = (await db.prepare(
    "SELECT p.id, p.name, COALESCE(r.team_name, '') AS team, COALESCE(p.zid, '') AS zid, " +
    "COALESCE(p.email, '') AS email, COALESCE(p.dietary, '') AS dietary " +
    'FROM participants p LEFT JOIN registrations r ON r.id = p.registration_id ' +
    "WHERE COALESCE(p.zid, '') != '' OR COALESCE(p.email, '') != '' OR COALESCE(p.dietary, '') != '' ORDER BY p.id"
  ).all<Person>()).results;
  var eoi = (await db.prepare("SELECT id, email, zid FROM eoi_people WHERE email != '' OR zid != '' ORDER BY id").all<EoiRow>()).results;
  var queue = (await db.prepare('SELECT id, send_id, email, status, claimed_at, error FROM email_queue ORDER BY id').all<QueueRow>()).results;
  return { people: people, eoi: eoi, queue: queue };
}

// Whether the data is off the database now, and who took it off.
export async function personalRemoved(db: D1Database): Promise<RemovedMark | null> {
  try {
    var row = await db.prepare('SELECT value FROM site_text WHERE name = ?1').bind(REMOVED).first<Pick<SiteTextRow, 'value'>>();
    if (!row) return null;
    var mark = JSON.parse(row.value) as Record<string, unknown> | null;
    return mark && typeof mark === 'object' ? { at: String(mark.at || ''), by: String(mark.by || ''), people: Number(mark.people) || 0 } : null;
  } catch (err) {
    return null;
  }
}

// ---------- the check-in worker's copy ----------
// null: check-in is not connected here at all. Otherwise whether it
// answered, with its answer or why not.
type DoorAnswer = { ok: true; data: Record<string, unknown> } | { ok: false; note: string; status?: number };

async function door(env: Env, what: 'export' | 'clear' | 'restore', body: unknown): Promise<DoorAnswer | null> {
  if (!configured(env.CHECKIN_KEY) || !configured(env.CHECKIN_API)) return null;
  var base = String(env.CHECKIN_API).replace(/\/+$/, '');
  if (base.indexOf('https://') !== 0) return { ok: false, note: 'CHECKIN_API must start with https://' };
  try {
    var resp = await fetch(base + '/api/personal/' + what, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.CHECKIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    var data: Record<string, unknown> | null = null;
    try { data = await resp.json(); } catch (err) { /* not JSON */ }
    if (data && data.ok) return { ok: true, data: data };
    if (resp.status === 404 && !(data && data.error)) {
      return { ok: false, status: 404, note: 'the check-in worker is older than this and has to be deployed again' };
    }
    return { ok: false, status: resp.status, note: data && data.error ? String(data.error) : 'the check-in worker answered ' + resp.status };
  } catch (err) {
    return { ok: false, note: 'the check-in worker could not be reached' };
  }
}

function doorPeople(answer: DoorAnswer | null): DoorRow[] | null {
  if (!answer || !answer.ok || !Array.isArray(answer.data.people)) return null;
  return answer.data.people as DoorRow[];
}

// ---------- the file ----------
function int(v: unknown): number {
  var n = Math.floor(Number(v));
  return isFinite(n) && n > 0 ? n : 0;
}
// Every value goes through the cleaning it had on the way in, which
// leaves a stored value as it was, so a copy compares equal to the rows
// it was made from.
function text(v: unknown, max: number): string { return cleanText(v, max); }
function zidOf(v: unknown): string { return cleanText(v, 20); }
function emailOf(v: unknown): string { return cleanText(v, 200); }

// The copy as it came back from the organiser's device: anything that is
// not one of ours, or not this version, is refused rather than guessed at.
function readCopy(raw: unknown): Copy | { error: string } {
  var c = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  if (!c || c.kind !== COPY_KIND) return { error: 'That is not a copy of the personal data from this dashboard.' };
  if (Number(c.version) !== COPY_VERSION) return { error: 'That copy was made by another version of the dashboard.' };
  var lists = [c.people, c.eoi, c.email_queue];
  if (lists.some(function (l) { return !Array.isArray(l); })) return { error: 'That copy is not whole.' };
  if (lists.some(function (l) { return (l as unknown[]).length > MAX_ROWS; })) return { error: 'That copy is too big.' };
  var door = c.checkin && typeof c.checkin === 'object' && Array.isArray((c.checkin as Record<string, unknown>).people)
    ? (c.checkin as Record<string, unknown>).people as unknown[] : null;
  if (door && door.length > MAX_ROWS) return { error: 'That copy is too big.' };
  var rec = function (x: unknown): Record<string, unknown> { return x && typeof x === 'object' ? x as Record<string, unknown> : {}; };
  return {
    kind: COPY_KIND,
    version: COPY_VERSION,
    exported_at: text(c.exported_at, 40),
    exported_by: text(c.exported_by, 80),
    people: (c.people as unknown[]).map(rec).map(function (p) {
      return { id: int(p.id), name: text(p.name, 80), team: text(p.team, 80), zid: zidOf(p.zid), email: emailOf(p.email), dietary: text(p.dietary, 200) };
    }).filter(function (p) { return p.id; }),
    eoi: (c.eoi as unknown[]).map(rec).map(function (e) {
      return { id: int(e.id), email: emailOf(e.email), zid: zidOf(e.zid) };
    }).filter(function (e) { return e.id && (e.email || e.zid); }),
    email_queue: (c.email_queue as unknown[]).map(rec).map(function (q) {
      return {
        id: int(q.id), send_id: int(q.send_id), email: emailOf(q.email), status: text(q.status, 20),
        claimed_at: q.claimed_at == null ? null : text(q.claimed_at, 40), error: text(q.error, 400)
      };
    }).filter(function (q) { return q.id && q.send_id && q.email; }),
    checkin: door ? {
      people: door.map(rec).map(function (d) {
        return {
          id: int(d.id), participant_id: int(d.participant_id) || null, name: text(d.name, 80), team_name: text(d.team_name, 80),
          email: emailOf(d.email), zid: zidOf(d.zid)
        };
      }).filter(function (d) { return d.id; })
    } : null
  };
}

// How many rows stored now are not in the copy with the same values.
function changedSince<T extends { id: number }>(now: T[], copy: T[], fields: (keyof T)[]): number {
  var byId: Record<number, T> = {};
  copy.forEach(function (r) { byId[r.id] = r; });
  return now.filter(function (r) {
    var kept = byId[r.id];
    return !kept || fields.some(function (f) { return String(r[f] == null ? '' : r[f]) !== String(kept[f] == null ? '' : kept[f]); });
  }).length;
}

function plural(n: number, one: string, many: string): string { return n + ' ' + (n === 1 ? one : many); }

function counts(s: Stored): Record<string, number> {
  return {
    people: s.people.length,
    emails: s.people.filter(function (p) { return p.email; }).length,
    zids: s.people.filter(function (p) { return p.zid; }).length,
    dietary: s.people.filter(function (p) { return p.dietary; }).length,
    eoi: s.eoi.length,
    queue: s.queue.length
  };
}

async function sending(db: D1Database): Promise<boolean> {
  return !!(await db.prepare("SELECT id FROM email_sends WHERE status = 'sending' LIMIT 1").first());
}

// GET privacy
async function privacyStatus(env: Env): Promise<Response> {
  var s = await stored(env.DB);
  var answer = await door(env, 'export', {});
  var people = doorPeople(answer);
  return json({
    ok: true,
    stored: counts(s),
    removed: await personalRemoved(env.DB),
    checkin: answer === null ? { connected: false }
      : people ? {
        connected: true, reached: true, people: people.length,
        emails: people.filter(function (p) { return p.email; }).length,
        zids: people.filter(function (p) { return p.zid && p.zid !== 'z0000000'; }).length
      }
      : { connected: true, reached: false, note: (answer as { note: string }).note }
  });
}

// GET privacy/export
async function privacyExport(env: Env, session: ConsoleSession, logAction: LogAction): Promise<Response> {
  var s = await stored(env.DB);
  var answer = await door(env, 'export', {});
  var people = doorPeople(answer);
  var copy: Copy = {
    kind: COPY_KIND,
    version: COPY_VERSION,
    exported_at: utcStamp(),
    exported_by: session.name,
    people: s.people,
    eoi: s.eoi,
    email_queue: s.queue,
    checkin: people ? { people: people } : null
  };
  if (answer && !people) copy.checkin_note = 'The check-in worker was not reached: ' + (answer as { note: string }).note + '.';
  await logAction(env.DB, session.name, 'privacy-export', '-',
    plural(s.people.length, 'person', 'people') + (people ? ', check-in ' + people.length : ''), 0, 0, 0);
  return json({ ok: true, copy: copy, file: 'scs2-personal-data-' + copy.exported_at.slice(0, 10) + '.json' }, 200,
    { 'cache-control': 'no-store' });
}

// POST privacy/remove {copy}
async function privacyRemove(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var copy = readCopy(body.copy);
  if ('error' in copy) return json({ error: copy.error }, 400);
  if (await sending(env.DB)) return json({ error: 'An email announcement is still going out. Remove the data once it has finished.' }, 409);
  var s = await stored(env.DB);
  var changed = changedSince(s.people, copy.people, ['zid', 'email', 'dietary']) +
    changedSince(s.eoi, copy.eoi, ['email', 'zid']) +
    changedSince(s.queue, copy.email_queue, ['send_id', 'email']);
  if (changed) {
    return json({
      error: 'That copy does not hold everything stored now: ' + plural(changed, 'row has', 'rows have') +
        ' changed since it was made. Download a new copy and remove with that one.',
      changed: changed
    }, 409);
  }
  // the check-in worker's copy first, so a refusal there leaves both
  // databases as they were
  var cleared: number | null = null;
  var note = '';
  if (copy.checkin) {
    var gone = await door(env, 'clear', { people: copy.checkin.people });
    if (gone === null) {
      note = 'Check-in is not connected here, so its copy was left as it is.';
    } else if (!gone.ok) {
      var why = gone.status === 409 ? gone.note + '. Download a new copy and remove with that one.' : gone.note + '.';
      return json({ error: 'The check-in worker did not take its copy off, so nothing was removed: ' + why }, gone.status === 409 ? 409 : 502);
    } else {
      cleared = Number(gone.data.cleared) || 0;
    }
  } else {
    var now = doorPeople(await door(env, 'export', {}));
    if (now && now.length) {
      return json({
        error: 'That copy has nothing from the check-in worker, which holds ' + plural(now.length, "person's", "people's") +
          ' emails and zIDs now. Download a new copy and remove with that one.'
      }, 409);
    }
    if (configured(env.CHECKIN_API)) note = 'The check-in worker was not reached, so its copy was left as it is.';
  }
  var ids = function (rows: { id: number }[]) { return JSON.stringify(rows.map(function (r) { return r.id; })); };
  var mark: RemovedMark = { at: utcStamp(), by: session.name, people: s.people.length };
  var writes = [
    env.DB.prepare("UPDATE participants SET zid = '', email = NULL, dietary = NULL WHERE id IN (SELECT value FROM json_each(?1))")
      .bind(ids(s.people)),
    env.DB.prepare('INSERT INTO site_text (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = ?2')
      .bind(REMOVED, JSON.stringify(mark))
  ];
  if (s.eoi.length) writes.push(env.DB.prepare('DELETE FROM eoi_people WHERE id IN (SELECT value FROM json_each(?1))').bind(ids(s.eoi)));
  if (s.queue.length) writes.push(env.DB.prepare('DELETE FROM email_queue WHERE id IN (SELECT value FROM json_each(?1))').bind(ids(s.queue)));
  await env.DB.batch(writes);
  await logAction(env.DB, session.name, 'privacy-remove', '-',
    plural(s.people.length, 'person', 'people') + (cleared != null ? ', check-in ' + cleared : ''), 0, 0, 0);
  return json({ ok: true, people: s.people.length, eoi: s.eoi.length, queue: s.queue.length, checkin: cleared, note: note });
}

// POST privacy/restore {copy}
async function privacyRestore(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var copy = readCopy(body.copy);
  if ('error' in copy) return json({ error: copy.error }, 400);
  var people = JSON.stringify(copy.people.map(function (p) { return { id: p.id, zid: p.zid, email: p.email, dietary: p.dietary }; }));
  var pick = function (field: string) {
    return "(SELECT NULLIF(json_extract(value, '$." + field + "'), '') FROM json_each(?1) WHERE json_extract(value, '$.id') = participants.id)";
  };
  // each field only where it is empty now, so an edit made since stays
  var writes = [
    env.DB.prepare(
      "UPDATE participants SET zid = CASE WHEN COALESCE(zid, '') = '' THEN COALESCE(" + pick('zid') + ", '') ELSE zid END, " +
      "email = CASE WHEN COALESCE(email, '') = '' THEN " + pick('email') + ' ELSE email END, ' +
      "dietary = CASE WHEN COALESCE(dietary, '') = '' THEN " + pick('dietary') + ' ELSE dietary END ' +
      "WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))"
    ).bind(people),
    env.DB.prepare('DELETE FROM site_text WHERE name = ?1').bind(REMOVED)
  ];
  var found = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM participants WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?1))"
  ).bind(people).first<{ n: number }>();
  var back = (found && found.n) || 0;
  var notes: string[] = [];
  if (back < copy.people.length) {
    notes.push(plural(copy.people.length - back, 'person in the copy is', 'people in the copy are') + ' not signed up any more and were left out.');
  }
  // the EOI list goes back only into an empty table: a list uploaded since
  // is the one that counts
  var eoiBack = 0;
  if (copy.eoi.length) {
    var eoiNow = await env.DB.prepare('SELECT id FROM eoi_people LIMIT 1').first<{ id: number }>();
    if (eoiNow) {
      notes.push('The EOI list was left as it is, since another list has been uploaded since.');
    } else {
      eoiBack = copy.eoi.length;
      writes.push(env.DB.prepare(
        "INSERT OR IGNORE INTO eoi_people (id, email, zid) SELECT json_extract(value, '$.id'), json_extract(value, '$.email'), " +
        "json_extract(value, '$.zid') FROM json_each(?1)"
      ).bind(JSON.stringify(copy.eoi)));
    }
  }
  if (copy.email_queue.length) {
    writes.push(env.DB.prepare(
      'INSERT OR IGNORE INTO email_queue (id, send_id, email, status, claimed_at, error) ' +
      "SELECT json_extract(value, '$.id'), json_extract(value, '$.send_id'), json_extract(value, '$.email'), " +
      "json_extract(value, '$.status'), json_extract(value, '$.claimed_at'), COALESCE(json_extract(value, '$.error'), '') " +
      "FROM json_each(?1) WHERE json_extract(value, '$.send_id') IN (SELECT id FROM email_sends)"
    ).bind(JSON.stringify(copy.email_queue)));
  }
  await env.DB.batch(writes);
  var restored: number | null = null;
  if (copy.checkin) {
    var answer = await door(env, 'restore', { people: copy.checkin.people });
    if (answer === null) notes.push('Check-in is not connected here, so its copy was not put back.');
    else if (!answer.ok) notes.push('The check-in worker did not put its copy back (' + answer.note + '). Put it back again once it answers.');
    else restored = Number(answer.data.restored) || 0;
  }
  await logAction(env.DB, session.name, 'privacy-restore', '-',
    plural(back, 'person', 'people') + (restored != null ? ', check-in ' + restored : ''), 0, 0, 0);
  return json({ ok: true, people: back, eoi: eoiBack, queue: copy.email_queue.length, checkin: restored, note: notes.join(' ') });
}

export async function privacyConsole(env: Env, session: ConsoleSession, request: Request, action: string, logAction: LogAction): Promise<Response | null> {
  if (request.method === 'GET') {
    if (action === 'privacy') return privacyStatus(env);
    if (action === 'privacy/export') return privacyExport(env, session, logAction);
    return null;
  }
  if (request.method !== 'POST') return null;
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  if (action === 'privacy/remove') return privacyRemove(env, session, body, logAction);
  if (action === 'privacy/restore') return privacyRestore(env, session, body, logAction);
  return null;
}
