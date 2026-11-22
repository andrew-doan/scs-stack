// Expressions of interest. People who filled in the EOI before sign-ups
// opened earn their team points: one award per person, worth what the
// dashboard sets. The list is a CSV with a person a row, and a person
// on it counts when either their zID or their email address matches
// their signup — not everyone is a UNSW student, and people give
// different addresses in different forms.
//
// The points go on a loose quest code, EOI, with no group: hidden from
// the quest list and worth the set points. They are an award on the
// ledger (ledger.ts), made when an organiser presses the button: a line
// per team crediting how many of its people are on the list. Pressing it
// again voids the last award and makes a new one from the list as it is
// then, so a team's score only moves when somebody chose to move it. A
// count of quests done leaves the code out, and so does Last scored.
import { json } from './shared.ts';
import { ledgerReady, LEDGER_BEHIND, awardStatements, voidAward, liveAward, awardGiven, rescoreLines, isTaken } from './ledger.ts';
import { personalRemoved } from './privacy.ts';
import type { AwardRow, ConsoleSession, Env, JsonBody, LogAction, QuestRow, TeamRow } from './types.ts';

// The EOI card: the points, who is on the list and found, each team's
// people against what the last award gave it, and how many differ now.
interface EoiSummary {
  ok: true;
  points: number | null;
  listed: number;
  signed_up: number;
  in_teams: number;
  not_signed_up: number;
  teams: { name: string; people: number; awarded: number }[];
  award: { at: string; by: string } | null;
  waiting: number;
  skipped?: number;
}

export var EOI_CODE = 'EOI';
var EOI_LABEL = 'Expression of interest';
var MAX_ROWS = 5000;

function normZid(v: unknown): string {
  var m = String(v == null ? '' : v).trim().match(/^z?(\d{7})$/i);
  // z0000000 is the placeholder for somebody without one
  return m && m[1] !== '0000000' ? 'z' + m[1] : '';
}

function normEmail(v: unknown): string {
  var s = String(v == null ? '' : v).trim().toLowerCase().replace(/^mailto:/, '').replace(/^<|>$/g, '');
  return /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[^\s@,;<>"']+$/.test(s) ? s : '';
}

// Rows of cells, quotes respected; commas, semicolons and tabs all
// separate cells, since a list saved from a spreadsheet may use any.
function csvRows(text: string): string[][] {
  var rows: string[][] = [];
  var row: string[] = [];
  var cell = '';
  var quoted = false;
  for (var i = 0; i < text.length; i++) {
    var ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',' || ch === ';' || ch === '\t') {
      row.push(cell); cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

// Each row's email address and zID, whichever columns they are in. A
// heading row has neither and is passed over, and so is a blank one.
export function parseEoi(text: unknown): { rows: { e: string; z: string }[]; skipped: number } {
  var seen: Record<string, boolean> = {};
  var out: { e: string; z: string }[] = [];
  var skipped = 0;
  csvRows(String(text == null ? '' : text)).forEach(function (cells) {
    var email = '';
    var zid = '';
    var any = false;
    cells.forEach(function (c) {
      if (String(c).trim()) any = true;
      if (!email) email = normEmail(c);
      if (!zid) zid = normZid(c);
    });
    if (!email && !zid) { if (any) skipped++; return; }
    var key = email + '|' + zid;
    if (seen[key]) return;
    seen[key] = true;
    out.push({ e: email, z: zid });
  });
  return { rows: out, skipped: skipped };
}

// Whether a participant is on the list: their zID or their address.
var ON_LIST =
  'EXISTS (SELECT 1 FROM eoi_people e WHERE ' +
  "(e.zid != '' AND e.zid = LOWER(TRIM(p.zid))) OR " +
  "(e.email != '' AND e.email = LOWER(TRIM(p.email))))";

// How many people each team has on the list, by team id.
async function eoiCounts(db: D1Database): Promise<Record<string, number>> {
  var want: Record<string, number> = {};
  (await db.prepare(
    'SELECT p.team_id AS team_id, COUNT(*) AS n FROM participants p JOIN teams t ON t.id = p.team_id ' +
    'WHERE ' + ON_LIST + ' GROUP BY p.team_id'
  ).all<{ team_id: number; n: number }>()).results.forEach(function (r) { want[r.team_id] = r.n; });
  return want;
}

// What the live award gave each team, by team id, and the award.
async function awarded(db: D1Database): Promise<{ award: AwardRow | null; given: Record<string, number> }> {
  var award = await liveAward(db, 'eoi', null, EOI_CODE);
  var given: Record<string, number> = {};
  if (award) (await awardGiven(db, award.id)).forEach(function (r) { given[r.team_id] = r.units; });
  return { award: award, given: given };
}

// The teams whose count on the list differs from what the last award
// gave them: what pressing the button would change.
function changes(want: Record<string, number>, given: Record<string, number>): number {
  var n = 0;
  Object.keys(want).forEach(function (id) { if (Number(given[id] || 0) !== want[id]) n++; });
  Object.keys(given).forEach(function (id) { if (!want[id] && Number(given[id])) n++; });
  return n;
}

async function summary(db: D1Database): Promise<EoiSummary> {
  var quest = await db.prepare('SELECT points FROM quests WHERE code = ?1').bind(EOI_CODE).first<Pick<QuestRow, 'points'>>();
  var listed = await db.prepare('SELECT COUNT(*) AS n FROM eoi_people').first<{ n: number }>() as { n: number };
  var found = await db.prepare(
    'SELECT COUNT(*) AS people, COUNT(p.team_id) AS placed FROM participants p WHERE ' + ON_LIST
  ).first<{ people: number; placed: number }>() as { people: number; placed: number };
  var nobody = await db.prepare(
    'SELECT COUNT(*) AS n FROM eoi_people e WHERE NOT EXISTS (SELECT 1 FROM participants p WHERE ' +
    "(e.zid != '' AND e.zid = LOWER(TRIM(p.zid))) OR (e.email != '' AND e.email = LOWER(TRIM(p.email))))"
  ).first<{ n: number }>() as { n: number };
  var want = await eoiCounts(db);
  var names: Record<string, string> = {};
  (await db.prepare('SELECT id, name FROM teams').all<Pick<TeamRow, 'id' | 'name'>>()).results.forEach(function (t) { names[t.id] = t.name; });
  var got: { award: AwardRow | null; given: Record<string, number> } = (await ledgerReady(db)) ? await awarded(db) : { award: null, given: {} };
  var teams = Object.keys(want).map(function (id) {
    return { name: names[id] || '', people: want[id], awarded: Number(got.given[id] || 0) };
  });
  Object.keys(got.given).forEach(function (id) {
    if (!want[id] && Number(got.given[id])) teams.push({ name: names[id] || '', people: 0, awarded: Number(got.given[id]) });
  });
  teams.sort(function (a, b) { return (b.people - a.people) || a.name.localeCompare(b.name); });
  return {
    ok: true,
    points: quest ? quest.points : null,
    listed: listed.n,
    signed_up: found.people,
    in_teams: found.placed,
    not_signed_up: nobody.n,
    teams: teams,
    award: got.award ? { at: got.award.made_at, by: got.award.made_by } : null,
    waiting: changes(want, got.given)
  };
}

// ---------- the dashboard: GET eoi, POST eoi/list, POST eoi/points ----------

export async function eoiRead(env: Env): Promise<Response> {
  return json(await summary(env.DB));
}

// The uploaded list replaces the one before it. Nobody's score moves
// until the points are awarded.
export async function eoiList(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var parsed = parseEoi(body && body.csv);
  if (!parsed.rows.length) return json({ error: 'No email addresses or zIDs in that file.' }, 400);
  if (parsed.rows.length > MAX_ROWS) return json({ error: 'That is more than ' + MAX_ROWS + ' people.' }, 400);
  await db.batch([
    db.prepare('DELETE FROM eoi_people'),
    db.prepare("INSERT INTO eoi_people (email, zid) SELECT json_extract(value, '$.e'), json_extract(value, '$.z') FROM json_each(?1)")
      .bind(JSON.stringify(parsed.rows))
  ]);
  await logAction(db, session.name, 'eoi-list', '-', parsed.rows.length + ' people', 0, 0, 0);
  var out = await summary(db);
  out.skipped = parsed.skipped;
  return json(out);
}

// What one person on the list is worth. The first save makes the code;
// a change re-scores every team the last award gave points.
export async function eoiPoints(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var points = Number(body && body.points);
  if (!isFinite(points) || points < 0 || points > 100000) return json({ error: 'Points should be a number from 0 to 100000.' }, 400);
  if (!(await ledgerReady(db))) return json({ error: LEDGER_BEHIND }, 503);
  var before = await db.prepare('SELECT points FROM quests WHERE code = ?1').bind(EOI_CODE).first<Pick<QuestRow, 'points'>>();
  await db.batch([db.prepare(
    'INSERT INTO quests (code, norm, points, group_id, label, sort, hidden) VALUES (?1, ?1, ?2, NULL, ?3, 0, 1) ' +
    'ON CONFLICT(code) DO UPDATE SET points = ?2'
  ).bind(EOI_CODE, points, EOI_LABEL)].concat(before ? rescoreLines(db, EOI_CODE, before.points, points, session.name) : []));
  await logAction(db, session.name, 'eoi-points', EOI_CODE, String(points), 0, 0, 0);
  return json(await summary(db));
}

// Awarding the EOI points: the last award is voided and a new one made
// from the list as it is now, in one batch, so a team counted twice or
// a second press at the same moment cannot pay twice. The new award is
// made only while no other is live (awardStatements), so a press that
// lost to another changes nothing, and whether this one made it is read
// from its own statement.
export async function eoiAward(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  if (!(await ledgerReady(db))) return json({ error: LEDGER_BEHIND }, 503);
  // the list is matched on zIDs and emails, so with them off the
  // database every count would read as nobody
  if (await personalRemoved(db)) {
    return json({ error: "The sign-ups' zIDs and emails are off the database. Put them back on the Settings tab before awarding." }, 409);
  }
  var quest = await db.prepare('SELECT points FROM quests WHERE code = ?1').bind(EOI_CODE).first<Pick<QuestRow, 'points'>>();
  if (!quest) return json({ error: 'Set the points per person first.' }, 400);
  var want = await eoiCounts(db);
  var got = await awarded(db);
  if (!changes(want, got.given)) return json(Object.assign(await summary(db), { unchanged: true }));
  var ids = Object.keys(want);
  var stmts: D1PreparedStatement[] = got.award ? voidAward(db, got.award, session.name, 'Awarded again') : [];
  var made = stmts.length;
  stmts = stmts.concat(awardStatements(db, {
    kind: 'eoi', code: EOI_CODE, by: session.name, note: 'Expression of interest',
    basis: { people: want }, given: ids.map(function (id): [number, number] { return [Number(id), want[id]]; })
  }));
  var done;
  try {
    done = await db.batch(stmts);
  } catch (err) {
    if (isTaken(err)) return json({ error: 'The EOI points were awarded at the same moment. Refresh to see them.' }, 409);
    throw err;
  }
  if (!done[made].meta || !done[made].meta.changes) {
    return json({ error: 'The EOI points were awarded at the same moment. Refresh to see them.' }, 409);
  }
  var people = ids.reduce(function (n, id) { return n + want[id]; }, 0);
  await logAction(db, session.name, 'eoi-award', EOI_CODE, ids.length + ' teams, ' + people + ' people', people * quest.points, 0, 0);
  return json(await summary(db));
}
