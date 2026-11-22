// The ledger: every change to a team's score is a line in `entries`, and
// a team's score is the sum of its lines that are not voided. A line is
// never edited and never deleted: one that was wrong is voided, with who
// did it, when and why, and stays on the team's ledger struck through.
//
// A line belongs to what made it (`source_kind`, `source_id`):
//
//   submission  a team's submission an organiser accepted, or a result an
//               organiser recorded (a quest's desk, an adjustment on a
//               team's ledger, Discord's /submit and /unsubmit), one line
//               per code
//   award       a batch made by a rule rather than a review: a challenge's
//               places, a wager's settlement, the EOI (`awards`)
//   balance     what a team held before the ledger existed that nothing
//               else explains, written once by the migration
//
// `units` is how much of the code the line credits (a count, or part of
// one for a part mark) and `points` what it is worth when it was written,
// by the code's type (parts.ts): units times the code's points for a
// fixed, per-unit or judged part, the band its number reached for a
// tiered one, nothing for a submission on a counted one, and for an
// award or an adjustment whatever it was set to. Changing a code's points
// or a tiered code's bands re-scores the lines on it that follow them:
// each is voided and written again at the new worth, under the same
// source, so undoing the submission still finds it. An adjustment's line
// and the lines of a challenge's places or a wager's settlement keep what
// they were given; of the awards, only the EOI's follows its code.
//
// The tab's readers read the view `held` (schema.sql): each team's live
// lines on each code added up. The table `completions` it replaced is
// left with what it last held and is never written.

import { json, randomKey, noSuchTable, noSuchColumn, settingValue, setSetting, utcStamp, errorMessage, fields } from './shared.ts';
import { bandSql, bandFor } from './parts.ts';
import type { AwardRow, Credit, EntryRow, QuestRow, TeamRow, SiteTextRow } from './types.ts';

// One line for lineInsert: `units` of `code` for `team`, from source
// `kind` and `id` (or `idSql`), worth `points` when given.
export interface LineSpec extends LineOpts {
  team: number;
  code: string;
  units: number;
  kind: string;
  id?: number | null;
  points?: number | null;
  number?: number | null;
  input?: string;
}

// What a caller adds to a line besides the code and the units. `atSql`
// and `noteSql` take the place of `at` and `note` with an expression.
export interface LineOpts {
  idSql?: string;
  by?: string;
  at?: string | null;
  note?: string;
  atSql?: string;
  noteSql?: string;
  where?: string;
  args?: unknown[];
}

// An award and the line each team gets from it: [team, units] or
// [team, units, points].
export interface AwardSpec {
  kind: string;
  group_id?: number | null;
  code: string;
  basis?: unknown;
  note?: string;
  by?: string;
  given: ([number, number] | [number, number, number])[];
}

// A team and code whose lines differ from what the code is worth now.
export interface LedgerProblem {
  team: string;
  code: string;
  what: string;
  tab: number;
  ledger: number;
}

// The check as kept in site_text.ledger_check.
export interface LedgerCheck {
  at: string;
  problems: LedgerProblem[];
  count: number;
}

export var LEDGER_BEHIND = 'The database is behind. Run npm run db:migrate in tab/ first.';

// Whether the ledger is there and the migration has filled it in from
// what the tab held before (which is the one reason `completions` is
// still read). A database made from schema.sql that has never scored
// anything has nothing to fill in, and is marked ready the first time it
// is asked.
// Once ready it stays ready, so each database is asked until it says yes
// and not again in this isolate.
var readyOnce = new WeakSet<object>();
export async function ledgerReady(db: D1Database): Promise<boolean> {
  if (readyOnce.has(db)) return true;
  var ready = await ledgerAsked(db);
  if (ready) readyOnce.add(db);
  return ready;
}
async function ledgerAsked(db: D1Database): Promise<boolean> {
  try {
    await db.prepare('SELECT id FROM entries WHERE 0').first();
    await db.prepare('SELECT id FROM awards WHERE 0').first();
    await db.prepare('SELECT scoring, most, bands FROM quests WHERE 0').first();
    var flag = await db.prepare("SELECT value FROM site_flags WHERE name = 'ledger_seeded'").first();
    if (flag) return true;
    if (await db.prepare('SELECT 1 FROM completions LIMIT 1').first()) return false;
    await db.prepare("INSERT INTO site_flags (name, value) VALUES ('ledger_seeded', 1) ON CONFLICT(name) DO NOTHING").run();
    return true;
  } catch (err) {
    if (noSuchTable(err) || noSuchColumn(err)) return false;
    throw err;
  }
}

export function behind(): Response {
  return json({ error: LEDGER_BEHIND }, 503);
}

// ---------- writing lines ----------

// One line: `units` of `code` for `team`. Its points are `o.points` when
// given, and otherwise worked out in the statement from the code's type
// and what it is worth now: a tiered code's band for `o.number`, nothing
// for a counted one, units times the points for the rest. A code that is
// not on the tab writes nothing. `o.where` is a condition the line lands
// under and `o.idSql` takes the place of the source id; both number their
// placeholders from ?10, bound from `o.args`.
export function lineInsert(db: D1Database, o: LineSpec): D1PreparedStatement {
  var worth = o.points != null && isFinite(Number(o.points))
    ? String(Math.round(Number(o.points) * 100) / 100)
    : "CASE q.scoring WHEN 'counted' THEN 0 WHEN 'tiered' THEN " + bandSql(numberSql(o.number)) +
      ' * (CASE WHEN ?3 < 0 THEN -1 ELSE 1 END) ELSE ROUND(?3 * q.points, 2) END';
  var stmt = db.prepare(
    'INSERT INTO entries (team_id, code, units, points, input, source_kind, source_id, note, made_by, at) ' +
    'SELECT ?1, q.code, ?3, ' + worth + ', ?4, ?5, ' + (o.idSql || '?6') + ', ' + (o.noteSql || '?7') + ', ?8, ' +
    (o.atSql || "COALESCE(?9, datetime('now'))") + ' ' +
    'FROM quests q WHERE q.code = ?2' + (o.where ? ' AND ' + o.where : '')
  );
  return stmt.bind.apply(stmt, ([o.team, o.code, o.units, o.input || '', o.kind, o.id == null ? null : o.id,
    o.note || '', o.by || '', o.at || null] as unknown[]).concat(o.args || []));
}

// A number written into SQL: only ever one Number() made finite.
function numberSql(n: unknown): string {
  var x = Number(n);
  return String(isFinite(x) ? x : 0);
}

// Voids every live line a source made, under `where` (placeholders from
// ?5, bound from `args`) when one is given.
export function voidSource(db: D1Database, kind: string, id: number | null, by: string | null | undefined, reason: string | null | undefined, where?: string, args?: unknown[]): D1PreparedStatement {
  var stmt = db.prepare(
    "UPDATE entries SET voided_at = datetime('now'), voided_by = ?3, void_reason = ?4 " +
    'WHERE source_kind = ?1 AND source_id = ?2 AND voided_at IS NULL' + (where ? ' AND ' + where : '')
  );
  return stmt.bind.apply(stmt, ([kind, id, by || '', reason || ''] as unknown[]).concat(args || []));
}

// The condition every change to a submission's lines lands under: the
// stamp its batch put in claimed_at, the way Accept claims a submission.
// `n` is the number of its first placeholder.
export function claimed(n: number): string {
  return 'EXISTS (SELECT 1 FROM submissions WHERE id = ?' + n + ' AND claimed_at = ?' + (n + 1) + ')';
}

// The condition that every code a credit names is still on the tab,
// `credit` being SQL for the credit's JSON. A claim made under it cannot
// land after a rename or a delete took a code away, which would leave the
// credit naming a code its lines could not be written on.
export function codesThere(credit: string): string {
  return 'NOT EXISTS (SELECT 1 FROM json_each(' + credit + ", '$.codes') j WHERE NOT EXISTS (SELECT 1 FROM quests q WHERE q.code = j.value))";
}

// ---------- a submission's lines ----------

// What a credit (submissions.credit) puts on one of its codes: the part
// of it a reviewer gave that code, else its own count, else the amount.
export function unitsFor(credit: Credit | null | undefined, code: string): number {
  var parts = credit && credit.amounts;
  if (parts && parts[code] != null && isFinite(Number(parts[code]))) return Number(parts[code]);
  var counts = credit && credit.counts;
  if (counts && counts[code] != null && isFinite(Number(counts[code]))) return Number(counts[code]);
  return Number(credit && credit.amount) || 0;
}

// The lines a credit writes for a submission. A code given nothing
// writes no line, unless its worth was set outright. A tiered code's line
// keeps the number it reached in `input`, which is what a change to its
// bands re-scores it from. `o` carries what lineInsert takes besides the
// code and the units: the source id (or idSql), who, when, the note, and
// the condition with its args.
export function creditLines(db: D1Database, sub: { id?: number; team_id: number }, credit: Credit, o: LineOpts): D1PreparedStatement[] {
  var out: D1PreparedStatement[] = [];
  credit.codes.forEach(function (code) {
    var units = unitsFor(credit, code);
    var set = credit.points && credit.points[code] != null ? Number(credit.points[code]) : null;
    if (!units && set == null) return;
    var number = credit.numbers && credit.numbers[code] != null ? Number(credit.numbers[code]) : null;
    out.push(lineInsert(db, {
      team: sub.team_id, code: code, units: units, kind: 'submission', id: sub.id,
      points: set, number: number, input: number != null ? JSON.stringify({ number: number }) : '',
      idSql: o.idSql, by: o.by, at: o.at, note: o.note, atSql: o.atSql, noteSql: o.noteSql, where: o.where, args: o.args
    }));
  });
  return out;
}

// The time and the note of the newest line a submission wrote, ?10 being
// its id: what a new line takes from the ones it replaces, so a time
// moved with Time and an organiser's note survive a Change or a Put back.
var LAST_LINE = "FROM entries x WHERE x.source_kind = 'submission' AND x.source_id = ?10 ORDER BY x.id DESC LIMIT 1";

// Moving a submission to what it gives now (`now`, a credit, or null for
// nothing): its live lines are voided, with `why`, and the new ones
// written with the time and note the old ones had, all only while the
// submission holds `mark` in claimed_at.
export function relineSubmission(db: D1Database, sub: { id: number; team_id: number }, now: Credit | null, mark: string, by: string, why: string): D1PreparedStatement[] {
  var stmts = [voidSource(db, 'submission', sub.id, by, why, claimed(5), [sub.id, mark])];
  if (now) {
    stmts = stmts.concat(creditLines(db, sub, now, {
      by: by, where: claimed(10), args: [sub.id, mark],
      atSql: "COALESCE((SELECT x.at " + LAST_LINE + "), datetime('now'))",
      noteSql: "COALESCE((SELECT x.note " + LAST_LINE + "), '')"
    }));
  }
  return stmts;
}

// A line whose worth its submission's credit set outright (an
// adjustment's `points`), `t` being the entries table or its alias. No
// change to the code's points moves it.
function setOutright(t: string): string {
  return "EXISTS (SELECT 1 FROM submissions s WHERE " + t + ".source_kind = 'submission' AND s.id = " + t + '.source_id ' +
    "AND json_valid(s.credit) AND json_extract(s.credit, '$.points.' || json_quote(" + t + '.code)) IS NOT NULL)';
}

// A line a challenge's places or a wager's settlement wrote, `t` being the
// entries table or its alias. It is worth the points the award gave when
// it was made, so no change to the code's points moves it. The EOI award
// is the one whose lines are its code's points per person.
function setByAward(t: string): string {
  return "EXISTS (SELECT 1 FROM awards a WHERE " + t + ".source_kind = 'award' AND a.id = " + t + ".source_id AND a.kind != 'eoi')";
}

// ---------- re-scoring ----------

// A code's points changing re-scores every line on it that was worth its
// units times the old points: the line is voided and written again at
// the new points under the same source. Lines whose points were set some
// other way are left as they are: an adjustment's, since its credit says
// what it is worth and a Change or a Put back writes that again, and a
// challenge's or a wager's award, which gave what it gave. Goes after the
// statement that changes the points.
export function rescoreLines(db: D1Database, code: string, from: unknown, to: unknown, by: string | null | undefined): D1PreparedStatement[] {
  if (!isFinite(Number(from)) || Number(from) === Number(to)) return [];
  var reason = 'Re-scored: ' + code + ' ' + fmt(from) + ' → ' + fmt(to) + ' points';
  var token = 'rescore:' + randomKey(9);
  return [
    // the old lines are voided under a token first, since a source holds
    // one live line a code, then written again from it. A tiered or
    // counted code's points follow its bands, and its lines are not
    // worth units times them
    db.prepare(
      "UPDATE entries SET voided_at = datetime('now'), voided_by = ?3, void_reason = ?4 " +
      'WHERE code = ?1 AND voided_at IS NULL AND units != 0 AND ABS(points - ROUND(units * ?2, 2)) < 0.005 ' +
      "AND (SELECT scoring FROM quests WHERE code = ?1) NOT IN ('tiered', 'counted') AND NOT " + setOutright('entries') +
      ' AND NOT ' + setByAward('entries')
    ).bind(code, Number(from), by || '', token),
    db.prepare(
      'INSERT INTO entries (team_id, code, units, points, input, source_kind, source_id, note, made_by, at) ' +
      'SELECT team_id, code, units, ROUND(units * ?2, 2), input, source_kind, source_id, note, made_by, at ' +
      'FROM entries WHERE code = ?1 AND void_reason = ?3'
    ).bind(code, Number(to), token),
    db.prepare('UPDATE entries SET void_reason = ?3 WHERE code = ?1 AND void_reason = ?2').bind(code, token, reason)
  ];
}

// A tiered code's bands changing re-scores every line a submission wrote
// on it from the number it reached, the same way. Goes after the
// statement that changes the bands.
export function rebandLines(db: D1Database, code: string, by: string | null | undefined): D1PreparedStatement[] {
  var token = 'reband:' + randomKey(9);
  var bands = '(SELECT bands FROM quests WHERE code = ?1)';
  var worth = bandSql("json_extract(input, '$.number')", bands) + ' * (CASE WHEN units < 0 THEN -1 ELSE 1 END)';
  return [
    db.prepare(
      "UPDATE entries SET voided_at = datetime('now'), voided_by = ?2, void_reason = ?3 " +
      "WHERE code = ?1 AND voided_at IS NULL AND source_kind = 'submission' AND json_valid(input) " +
      "AND json_extract(input, '$.number') IS NOT NULL AND ABS(points - " + worth + ') >= 0.005'
    ).bind(code, by || '', token),
    db.prepare(
      'INSERT INTO entries (team_id, code, units, points, input, source_kind, source_id, note, made_by, at) ' +
      'SELECT team_id, code, units, ' + worth + ', input, source_kind, source_id, note, made_by, at ' +
      'FROM entries WHERE code = ?1 AND void_reason = ?2'
    ).bind(code, token),
    db.prepare('UPDATE entries SET void_reason = ?3 WHERE code = ?1 AND void_reason = ?2').bind(code, token, 'Re-scored: ' + code + '’s bands changed')
  ];
}

function fmt(n: unknown): string { return String(Math.round(Number(n) * 100) / 100); }

// ---------- awards ----------

// An award row and its lines, one per team in `given` ([team, units] or
// [team, units, points] when the award sets what each line is worth).
// It is made once: only while no live award of its kind is on its quest
// group (which liveAward looks up) or on its code (which the unique index
// holds), so the first statement says whether this batch made it, and
// the lines land only under it. The index still fails a batch that gets
// past that (`isTaken`).
export function awardStatements(db: D1Database, a: AwardSpec): D1PreparedStatement[] {
  var token = 'award:' + randomKey(9);
  var stmts = [db.prepare(
    'INSERT INTO awards (kind, group_id, code, token, basis, note, made_by) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7 ' +
    'WHERE NOT EXISTS (SELECT 1 FROM awards WHERE kind = ?1 AND voided_at IS NULL AND (group_id = ?2 OR code = ?3))'
  ).bind(a.kind, a.group_id == null ? null : a.group_id, a.code, token, JSON.stringify(a.basis || {}), a.note || '', a.by || '')];
  a.given.forEach(function (g) {
    if (!g[1] && !g[2]) return;
    stmts.push(lineInsert(db, {
      team: g[0], code: a.code, units: g[1], points: g[2], kind: 'award', idSql: '(SELECT id FROM awards WHERE token = ?10)',
      note: a.note || '', by: a.by, where: 'EXISTS (SELECT 1 FROM awards WHERE token = ?10)', args: [token]
    }));
  });
  return stmts;
}

// Voiding an award voids every line it made. The first statement is the
// one that says whether this request did it.
export function voidAward(db: D1Database, award: { id: number }, by: string | null | undefined, reason: string | null | undefined): D1PreparedStatement[] {
  return [
    db.prepare("UPDATE awards SET voided_at = datetime('now'), voided_by = ?2, void_reason = ?3 WHERE id = ?1 AND voided_at IS NULL")
      .bind(award.id, by || '', reason || ''),
    voidSource(db, 'award', award.id, by, reason)
  ];
}

// The live award of a kind for a quest group, or with no group the live
// one on a code (the EOI's), or null. A group's is the one made for it,
// or one on any of its codes: an award stays on its code when the code
// moves to another quest, and the unique index on kind and code is what
// would refuse a new one there.
export async function liveAward(db: D1Database, kind: string, groupId: number | null | undefined, code?: string): Promise<AwardRow | null> {
  var row = groupId != null
    ? await db.prepare(
      'SELECT * FROM awards WHERE kind = ?1 AND voided_at IS NULL AND (group_id = ?2 OR code IN (SELECT code FROM quests WHERE group_id = ?2)) ' +
      'ORDER BY id DESC'
    ).bind(kind, groupId).first<AwardRow>()
    : await db.prepare('SELECT * FROM awards WHERE kind = ?1 AND code = ?2 AND voided_at IS NULL ORDER BY id DESC').bind(kind, code).first<AwardRow>();
  return row || null;
}

// What an award gave each team, from its live lines: [team, units].
export async function awardGiven(db: D1Database, id: number): Promise<{ team_id: number; units: number; points: number }[]> {
  return (await db.prepare(
    "SELECT team_id, SUM(units) AS units, SUM(points) AS points FROM entries WHERE source_kind = 'award' AND source_id = ?1 AND voided_at IS NULL GROUP BY team_id"
  ).bind(id).all<{ team_id: number; units: number; points: number }>()).results;
}

// Whether undoing an award does what it says. One the migration carried
// over from before awards kept what they gave (its token `seed-…`) that
// never wrote a line holds its points as balances, and undoing it would
// move nothing. Any other is undone by voiding it, one whose lines were
// all undone one at a time included, and one that gave nobody anything.
export async function awardUndoable(db: D1Database, award: Pick<AwardRow, 'id' | 'token'>): Promise<boolean> {
  if (String(award.token || '').indexOf('seed-') !== 0) return true;
  return !!(await db.prepare("SELECT 1 FROM entries WHERE source_kind = 'award' AND source_id = ?1 LIMIT 1").bind(award.id).first());
}

// A batch failed on a unique index: the award was made already, or a
// submission already holds a live line on the code.
export function isTaken(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String(errorMessage(err)));
}

// ---------- checking ----------

// The ledger against what the quests are worth now, code by code: the
// points of each team's live lines on a fixed, per-unit or judged code
// against their units at the code's points, and each line a submission
// wrote on a tiered code against the band its number reaches. They differ
// only if a code changed without going through the ledger (re-scoring),
// or a line was written or changed by hand. A counted code's lines are
// set by its award and are not checked, nor is an adjustment's line or a
// challenge's or a wager's award line, whose worth is what it was given
// whatever the code is worth now.
export async function ledgerCheck(db: D1Database): Promise<LedgerProblem[]> {
  var problems: LedgerProblem[] = [];
  (await db.prepare(
    'SELECT e.team_id, e.code, SUM(e.units) AS units, SUM(e.points) AS points, COUNT(*) AS n, q.points AS each, t.name ' +
    'FROM entries e JOIN teams t ON t.id = e.team_id JOIN quests q ON q.code = e.code ' +
    "WHERE e.voided_at IS NULL AND q.scoring NOT IN ('tiered', 'counted') AND NOT " + setOutright('e') +
    ' AND NOT ' + setByAward('e') + ' GROUP BY e.team_id, e.code'
  ).all<Pick<EntryRow, 'team_id' | 'code' | 'units' | 'points'> & { n: number; each: number; name: string }>()).results.forEach(function (r) {
    var units = Number(r.units) || 0;
    if (Math.abs(Number(r.points) - units * Number(r.each)) > 0.006 * r.n) {
      problems.push({ team: r.name, code: r.code, what: 'points', tab: round2(units * Number(r.each)), ledger: round2(Number(r.points)) });
    }
  });
  var tiered: Record<string, { team: string; code: string; tab: number; ledger: number }> = {};
  (await db.prepare(
    'SELECT e.team_id, e.code, e.units, e.points, e.input, q.bands, t.name FROM entries e JOIN teams t ON t.id = e.team_id ' +
    "JOIN quests q ON q.code = e.code WHERE e.voided_at IS NULL AND q.scoring = 'tiered' AND e.source_kind = 'submission'"
  ).all<Pick<EntryRow, 'team_id' | 'code' | 'units' | 'points' | 'input'> & Pick<QuestRow, 'bands'> & Pick<TeamRow, 'name'>>()).results.forEach(function (r) {
    var number: unknown = null;
    try { number = fields(JSON.parse(r.input || 'null')).number; } catch (err) { number = null; }
    if (number == null) return;
    var key = r.team_id + '\n' + r.code;
    var t = tiered[key] = tiered[key] || { team: r.name, code: r.code, tab: 0, ledger: 0 };
    t.tab += bandFor(r.bands, number) * (Number(r.units) < 0 ? -1 : 1);
    t.ledger += Number(r.points);
  });
  Object.keys(tiered).forEach(function (k) {
    var t = tiered[k];
    if (Math.abs(t.tab - t.ledger) > 0.006) problems.push({ team: t.team, code: t.code, what: 'points', tab: round2(t.tab), ledger: round2(t.ledger) });
  });
  return problems;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

// The check, once an hour on the scheduled run and whenever the
// dashboard asks, kept in site_text so the Scores tab can say when it
// last ran and what it found.
export async function runLedgerCheck(db: D1Database): Promise<LedgerCheck> {
  var problems = await ledgerCheck(db);
  var out = { at: utcStamp(), problems: problems.slice(0, 50), count: problems.length };
  await db.prepare(
    "INSERT INTO site_text (name, value) VALUES ('ledger_check', ?1) ON CONFLICT(name) DO UPDATE SET value = ?1"
  ).bind(JSON.stringify(out)).run();
  return out;
}

export async function hourlyLedgerCheck(db: D1Database): Promise<{ ran: boolean; problems?: number }> {
  if (!(await ledgerReady(db))) return { ran: false };
  var hour = Math.floor(Date.now() / 3600000);
  if ((await settingValue(db, 'ledger_check_hour', 0)) >= hour) return { ran: false };
  await setSetting(db, 'ledger_check_hour', hour);
  var out = await runLedgerCheck(db);
  return { ran: true, problems: out.count };
}

export async function lastLedgerCheck(db: D1Database): Promise<LedgerCheck | null> {
  try {
    var row = await db.prepare("SELECT value FROM site_text WHERE name = 'ledger_check'").first<Pick<SiteTextRow, 'value'>>();
    return row ? JSON.parse(row.value) as LedgerCheck : null;
  } catch (err) {
    return null;
  }
}

// A code taken off the tab: every live line and award on it is voided.
export function codeGone(db: D1Database, code: string, by: string | null | undefined): D1PreparedStatement[] {
  return [
    db.prepare("UPDATE entries SET voided_at = datetime('now'), voided_by = ?2, void_reason = 'Quest deleted' WHERE code = ?1 AND voided_at IS NULL")
      .bind(code, by || ''),
    db.prepare("UPDATE awards SET voided_at = datetime('now'), voided_by = ?2, void_reason = 'Quest deleted' WHERE code = ?1 AND voided_at IS NULL")
      .bind(code, by || '')
  ];
}

// A code renamed: its lines and awards follow it.
export function codeRenamed(db: D1Database, oldCode: string, newCode: string): D1PreparedStatement[] {
  return [
    db.prepare('UPDATE entries SET code = ?2 WHERE code = ?1').bind(oldCode, newCode),
    db.prepare('UPDATE awards SET code = ?2 WHERE code = ?1').bind(oldCode, newCode)
  ];
}
