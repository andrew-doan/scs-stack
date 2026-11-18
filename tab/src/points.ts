// Points an organiser records. Every change to a score is a submission,
// whoever makes it: a team sends one in and a reviewer accepts it, or an
// organiser records one already accepted — at a main quest across the
// city, from a quest's desk on the dashboard, with a photo or without.
// An adjustment on a team's ledger, and a /submit typed in Discord, are
// recorded the same way. So the tab never holds a point with no row
// behind it saying who gave it and for what.
//
// An account can be limited to some quests (console_users.quests): it
// scores those and nothing else, here and in the Queue.

import { json, cleanText, randomKey, readStamp, utcStamp, isBlobLike } from './shared.ts';
import { proofFilesProblem, fileCountProblem, proofKind, storedMatches, storeProofFiles, stagedProofFiles, discard, cleanAnswer, recordTaken, recordPicked } from './submit.ts';
import { readStaged, claimStaged, unclaimStaged, releaseStaged } from './staged.ts';
import { allGroups, rulesForGroup, mysteryIds } from './quests.ts';
import { rulesOf, kindsText, storedTypeFor } from './rules.ts';
import { PLACES } from './data/places.ts';
import { postVerdict } from './discord.ts';
import { tabState } from './freeze.ts';
import { SUM_POINTS, ADJUST_CODE } from './tab.ts';
import { DELETED_CODE } from './deleted.ts';
import { ledgerReady, behind, creditLines, relineSubmission, codesThere } from './ledger.ts';
import { partsFor, buildCredit, creditJson, creditWorth, negated } from './parts.ts';
import type { Into, PickedNote, Taken } from './submit.ts';
import type { StagedFile } from './staged.ts';
import type { Part, Worth } from './parts.ts';
import type { ProofFile, Verdict } from './discord.ts';
import type { ConsoleSession, Credit, Ctx, EntryRow, Env, JsonBody, LogAction, QuestRow, SubmissionRow, TeamRow } from './types.ts';

// An organiser's entry as recordPoints writes it.
export interface RecordOpts {
  teamId: number;
  quest: string;
  credit: Credit;
  by: string;
  note?: string;
  answer?: string | null;
  reason?: string;
  fileRows?: D1PreparedStatement[];
  // the stamp the file rows were made to find it by (recordClaim)
  claim?: string;
}

// Who the team's channel is told about (tellTeam): the submission, when
// there is one to link files from, and the team.
export interface TellSub {
  id: number | null;
  team_id: number;
  team_name: string;
}
// What happened: every verdict but a rejection carries its credit and
// the team's total after it; a rejection names its codes and why.
export interface TellWhat {
  verdict: string;
  quest: string;
  credit?: Credit;
  codes?: string[];
  total?: number;
  reason?: string;
}

// The proof files a dashboard save carries, read and checked.
export interface DashProof {
  files: File[];
  staged: StagedFile[];
}

export async function teamTotal(db: D1Database, teamId: number): Promise<number> {
  var row = await db.prepare(
    'SELECT ' + SUM_POINTS + ' AS pts ' +
    'FROM held c JOIN quests q ON q.code = c.quest_code WHERE c.team_id = ?1'
  ).bind(teamId).first<{ pts: number }>();
  return row ? row.pts : 0;
}

function round(n: number): number { return Math.round(n * 1e6) / 1e6; }
function round2(n: number): number { return Math.round(n * 100) / 100; }

// ---------- which quests an account may score ----------

// Quest keys (a quest's lead code, or a code with no quest round it).
export function parseQuestKeys(raw: unknown): string[] {
  var list = Array.isArray(raw) ? raw : String(raw || '').split(',');
  var out: string[] = [];
  list.forEach(function (item) {
    var k = cleanText(item, 40);
    if (k && out.indexOf(k) === -1) out.push(k);
  });
  return out.slice(0, 100);
}

// The codes an account may score, or null for every one.
export async function scopeCodes(db: D1Database, session: ConsoleSession | null | undefined): Promise<string[] | null> {
  if (!session || session.admin || !session.quests || !session.quests.length) return null;
  var rows = await db.prepare(
    'SELECT q.code FROM quests q LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    'WHERE COALESCE(g.key, q.code) IN (SELECT value FROM json_each(?1))'
  ).bind(JSON.stringify(session.quests)).all<Pick<QuestRow, 'code'>>();
  return rows.results.map(function (r) { return r.code; });
}

export function inScope(scope: string[] | null, code: string): boolean {
  return !scope || scope.indexOf(code) !== -1;
}

export function outOfScope(): Response {
  return json({ error: 'Your account does not score that quest.', no_access: true }, 403);
}

// ---------- what to credit ----------

// The submitted quest's own code, or any of its quest's codes (a tier,
// a bonus, several places at once).
export async function creditCodes(db: D1Database, quest: Pick<QuestRow, 'code'>, wanted: unknown): Promise<{ error: string } | { codes: string[] }> {
  var want = (Array.isArray(wanted) ? wanted : [quest.code])
    .map(function (c) { return cleanText(c, 40); }).filter(Boolean);
  if (!want.length) return { error: 'Pick at least one code to credit.' };
  // the quest's own row
  var group = await db.prepare('SELECT group_id FROM quests WHERE code = ?1').bind(quest.code).first<Pick<QuestRow, 'group_id'>>() as Pick<QuestRow, 'group_id'>;
  var codes: string[] = [];
  for (var i = 0; i < want.length; i++) {
    var row = await db.prepare('SELECT code, group_id FROM quests WHERE code = ?1').bind(want[i]).first<Pick<QuestRow, 'code' | 'group_id'>>();
    if (!row || (row.code !== quest.code && (!group.group_id || row.group_id !== group.group_id))) {
      return { error: want[i] + ' is not one of this quest\'s codes.' };
    }
    if (codes.indexOf(row.code) === -1) codes.push(row.code);
  }
  return { codes: codes };
}

// The codes a request names and what it gives each, read against each
// code's scoring type (parts.ts): {credit, parts} or {error}.
export async function readCreditFrom(db: D1Database, quest: Pick<QuestRow, 'code'>, body: Record<string, unknown>): Promise<{ error: string } | { credit: Credit; parts: Record<string, Part> }> {
  var picked = await creditCodes(db, quest, Array.isArray(body.codes) ? body.codes : (body.code ? [body.code] : null));
  if ('error' in picked) return picked;
  var parts = await partsFor(db, picked.codes);
  var built = buildCredit(parts, picked.codes, body);
  if ('error' in built) return built;
  return { credit: built.credit, parts: parts };
}

// For each credit that gave part marks, what it gave and what its full
// points were, {given, of}; null for the rest.
export async function partMarks(db: D1Database, credits: (Credit | null)[]): Promise<({ given: number; of: number } | null)[]> {
  var codes: string[] = [];
  credits.forEach(function (c) { if (c && c.amounts) codes = codes.concat(c.codes); });
  if (!codes.length) return credits.map(function () { return null; });
  var parts = await partsFor(db, codes);
  return credits.map(function (c) {
    if (!c || !c.amounts) return null;
    var w = creditWorth(parts, c);
    return w.given === w.full ? null : { given: w.given, of: w.full };
  });
}

// What a credit was worth, and what it would have been at its full
// points: the two differ only for a part mark.
export async function worthOf(db: D1Database, credit: Credit): Promise<Worth> {
  return creditWorth(await partsFor(db, credit.codes), credit);
}

// ---------- the write ----------

// A stamp for one organiser's entry, put in its claimed_at while its batch
// writes it, so its lines and its file rows find that row and no other
// (`claim` in RecordOpts, `claim` in storeProofFiles' Into).
export function recordClaim(): string {
  return 'recording:' + randomKey(9);
}

// The one write behind every organiser's change to a score: the
// submission, its files and its lines on the ledger, as one batch. The
// amount may be below zero (a correction). The submission goes in only
// while every code it credits is on the tab, so a rename or a delete since
// the codes were read records nothing rather than an entry its lines
// cannot be written on, and answers 0. Its lines and file rows find it by
// the stamp it lands with, which the last statement clears.
export async function recordPoints(db: D1Database, o: RecordOpts): Promise<number> {
  var credit = o.credit;
  var claim = o.claim || recordClaim();
  var stmts = [db.prepare(
    'INSERT INTO submissions (team_id, quest_code, note, status, reviewed_by, reviewed_at, answer, added_by, credit, reason, claimed_at) ' +
    "SELECT ?1, ?2, ?3, 'accepted', ?4, datetime('now'), ?5, ?4, ?6, ?7, ?8 WHERE " + codesThere('?6')
  ).bind(o.teamId, o.quest, o.note || null, o.by, o.answer || null, creditJson(credit), o.reason || null, claim)]
    .concat(creditLines(db, { team_id: o.teamId }, credit, {
      idSql: '(SELECT id FROM submissions WHERE claimed_at = ?10)', where: 'EXISTS (SELECT 1 FROM submissions WHERE claimed_at = ?10)',
      args: [claim], by: o.by, note: o.reason || o.note || ''
    }), o.fileRows || [], [db.prepare("UPDATE submissions SET claimed_at = '' WHERE claimed_at = ?1").bind(claim)]);
  var done = await db.batch(stmts);
  return done[0].meta && done[0].meta.changes ? done[0].meta.last_row_id : 0;
}

export var CODES_GONE = 'A code on this entry is no longer on the tab, so nothing was recorded. Refresh and try again.';

// ---------- telling the team ----------

// The verdict, in the team's own Discord channel, after the dashboard
// has its answer. What it was worth is worked out from the credit (`v.credit`)
// rather than from the total before and after, which a score set at the
// same moment would throw off. A part mark says what the full points
// were, except on a mystery quest. Never throws.
export async function tellTeam(env: Env, origin: string, sub: TellSub, v: TellWhat): Promise<void> {
  try {
    var db = env.DB;
    var named = await db.prepare(
      'SELECT g.id, COALESCE(g.name, NULLIF(q.label, \'\')) AS name FROM quests q LEFT JOIN quest_groups g ON g.id = q.group_id WHERE q.code = ?1'
    ).bind(v.quest).first<{ id: number | null; name: string | null }>();
    var files = sub.id ? (await db.prepare(
      "SELECT r2_key AS key, name, content_type AS type FROM submission_files WHERE submission_id = ?1 AND status = 'ready' ORDER BY id"
    ).bind(sub.id).all<ProofFile>()).results : [];
    // a rejection names its codes
    var codes = (v.credit ? v.credit.codes : v.codes) as string[];
    var post: Verdict = {
      verdict: v.verdict, team_id: sub.team_id, team: sub.team_name, files: files,
      title: (named && named.name) || codes.join(' + '), codes: codes.join(' + ')
    };
    if (v.verdict === 'rejected') {
      post.reason = v.reason;
    } else {
      if (v.reason) post.reason = v.reason;
      var parts = await partsFor(db, codes);
      var worth = creditWorth(parts, v.credit as Credit);
      post.gained = worth.given;
      // a submission on a counted part adds to the count and is worth
      // nothing until the challenge is awarded
      post.counted = !worth.given && codes.every(function (c) { return parts[c] && parts[c].scoring === 'counted'; });
      if ((v.verdict === 'accepted' || v.verdict === 'revised') && worth.given !== worth.full) {
        var hidden = !!(named && named.id && (await mysteryIds(db))[named.id]);
        post.part = { of: hidden ? null : worth.full };
      }
      var gate = await tabState(db);
      post.total = gate.frozen || gate.closed ? null : v.total;
    }
    await postVerdict(env, origin, post);
  } catch (err) { /* the change went through; the post is extra */ }
}

function later(ctx: Ctx, promise: Promise<unknown>): Promise<unknown> | undefined {
  if (ctx && ctx.waitUntil) ctx.waitUntil(promise);
  else return promise;
}

// ---------- a quest's desk ----------

// What the desk's form offers: the teams, the quests this account scores with
// their codes, answer boxes and the files they take, and the place
// lists behind @stations.
export async function pointsForm(env: Env, session: ConsoleSession): Promise<Response> {
  var db = env.DB;
  var scope = await scopeCodes(db, session);
  var all = await allGroups(db);
  var quests: object[] = [];
  all.groups.forEach(function (g) {
    var codes = g.codes.filter(function (c) { return !c.hidden && inScope(scope, c.code); });
    if (!codes.length) return;
    quests.push({
      key: g.key, name: g.name, region: g.region, hidden: !!g.hidden,
      submit: g.submit || 'none', prompt: g.prompt || '', options: g.options || [], questions: g.questions || [],
      files: (g.rules || rulesOf('')).files,
      tally: (g.rules || rulesOf('')).tally.kind, ask: g.ask && g.ask.kind || '',
      codes: codes.map(partFields)
    });
  });
  all.loose.forEach(function (c) {
    if (c.hidden || !inScope(scope, c.code)) return;
    quests.push({
      key: c.code, name: c.label || c.code, region: '', hidden: false, submit: 'none', prompt: '', options: [], questions: [],
      files: rulesOf('').files,
      codes: [partFields(c)]
    });
  });
  var teams = (await db.prepare('SELECT id, name, hidden FROM teams ORDER BY name COLLATE NOCASE').all<Pick<TeamRow, 'id' | 'name' | 'hidden'>>()).results;
  return json({
    ok: true, quests: quests, teams: teams, places: PLACES,
    limited: !!scope
  });
}

// What a form needs of a part to draw its boxes.
export function partFields(c: Pick<Part, 'code' | 'label' | 'points' | 'scoring' | 'most' | 'bands'>): Pick<Part, 'code' | 'label' | 'points' | 'scoring' | 'most' | 'bands'> {
  return { code: c.code, label: c.label, points: c.points, scoring: c.scoring || '', most: c.most == null ? null : c.most, bands: c.bands || [] };
}

// ---------- proof files from the dashboard ----------
// The desk's photos and the Queue's Add files send proof the same way.

// The files a save carries: in the request (`files`, with thumb<j>,
// view<j> and picked<j> beside each), or, with the R2 token set, sent
// straight to R2 first and named by id (`staged`, repeated, in the order
// thumb<j> and view<j> are numbered); those are held to the size
// staged.ts allows rather than to one request's. Each has to be one of
// `kinds`, and `counted(n)` is the route's own rule on how many: a
// refusal, or null. Answers {files, staged}, or {res} to answer with.
export async function dashProofFiles(env: Env, session: ConsoleSession, form: FormData, kinds: readonly string[], counted: (n: number) => string | null): Promise<{ res: Response } | DashProof> {
  var files = form.getAll('files').filter(function (f): f is File { return isBlobLike(f); });
  var ids = form.getAll('staged').map(String).filter(Boolean);
  if (files.length && ids.length) return { res: json({ error: 'bad file list' }, 400) };
  var many = counted(files.length + ids.length);
  if (many) return { res: json({ error: many }, 400) };
  if ((files.length || ids.length) && !env.SUBMIT) {
    return { res: json({ error: 'Files cannot be stored: the worker has no SUBMIT bucket.' }, 503) };
  }
  var staged: StagedFile[] = [];
  for (var i = 0; i < ids.length; i++) {
    var one = await readStaged(env, session, ids[i], 'points');
    if ('error' in one) return { res: json({ error: one.error }, one.status) };
    var kind = proofKind(one.type, one.name);
    // upload/finish read a picture's first bytes; a GPX track's or a
    // PDF's are read here, where it is known to be proof
    if (kinds.indexOf(kind) === -1 || !(await storedMatches(env, one.key, storedTypeFor(kind, one.type)))) {
      return { res: json({ error: one.name + ' is not ' + kindsText(kinds) + '.' }, 400) };
    }
    staged.push(one);
  }
  var problem = await proofFilesProblem(files, kinds);
  if (problem) return { res: json({ error: problem.error }, problem.status) };
  return { files: files, staged: staged };
}

// Stores what dashProofFiles read, once the route has made every other
// check: the staged files are claimed, the rest go in the bucket, and
// `write(rows)` runs the route's batch with the file rows in it and
// answers what the route wants back. `into` is which submission the rows
// belong to (storeProofFiles in submit.ts); with `into.claim` the staged
// files are let go only if the submission holding that stamp went in. A
// write that fails takes back what was stored, gives the staged files
// back to be sent again and answers `failed`, and so does one whose value
// `kept` says did not land, answering {value} for the route to say why.
// Answers {value}, or {res}.
export async function writeDashProof<T>(env: Env, form: FormData, got: DashProof, into: Into, write: (rows: D1PreparedStatement[]) => Promise<T>, failed: string, kept?: (value: T) => boolean): Promise<{ res: Response } | { value: T }> {
  var claimed = await claimStaged(env, got.staged);
  if (claimed) return { res: json({ error: claimed.error }, claimed.status) };
  var written: string[] = [];
  var found: Taken[] = [];
  var picked: PickedNote[] = [];
  var value: T;
  try {
    var rows = got.files.length ? await storeProofFiles(env, form, got.files, into, written, found, picked)
      : await stagedProofFiles(env, form, got.staged, into, written, found);
    value = await write(rows.concat(got.staged.map(function (s) {
      return into.claim ? releaseStaged(env, s, 'EXISTS (SELECT 1 FROM submissions WHERE claimed_at = ?2)', [into.claim]) : releaseStaged(env, s);
    })));
  } catch (err) {
    await discard(env, written, []);
    await unclaimStaged(env, got.staged);
    return { res: json({ error: failed }, 500) };
  }
  if (kept && !kept(value)) {
    await discard(env, written, []);
    await unclaimStaged(env, got.staged);
    return { value: value };
  }
  try { await recordTaken(env, found); } catch (err) { /* the dashboard's tidy fills it in */ }
  await recordPicked(env, picked);
  return { value: value };
}

// Points for one team on one quest, with the files the quest takes
// (its kinds, up to its most; never required here). Multipart, the way
// a team's own submission is, the files as dashProofFiles reads them.
export async function pointsAdd(env: Env, session: ConsoleSession, request: Request, ctx: Ctx, origin: string, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var form: FormData;
  try { form = await request.formData(); } catch (err) { return json({ error: 'expected a multipart form' }, 400); }
  var team = await db.prepare('SELECT id, name FROM teams WHERE id = ?1').bind(Number(form.get('team_id')) || 0).first<Pick<TeamRow, 'id' | 'name'>>();
  if (!team) return json({ error: 'Pick a team.' }, 400);
  var quest = await db.prepare('SELECT code, points, group_id FROM quests WHERE code = ?1').bind(cleanText(form.get('quest'), 40)).first<Pick<QuestRow, 'code' | 'points' | 'group_id'>>();
  if (!quest || quest.code === DELETED_CODE) return json({ error: 'Pick a quest.' }, 400);
  var wanted: unknown = null;
  try { wanted = JSON.parse(String(form.get('codes') || 'null')); } catch (err) { wanted = null; }
  var read = await readCreditFrom(db, quest, {
    codes: wanted, amount: form.get('amount'), counts: form.get('counts'), awarded: form.get('awarded'), numbers: form.get('numbers')
  });
  if ('error' in read) return json({ error: read.error }, 400);
  var credit = read.credit;
  var scope = await scopeCodes(db, session);
  if (!credit.codes.every(function (c) { return inScope(scope, c); })) return outOfScope();
  var refused: { error?: string } = {};
  var answer = cleanAnswer(form.get('answer'), refused);
  if (answer === false) return json({ error: refused.error || 'That answer is not valid.' }, 400);
  var given = answer;
  var note = cleanText(form.get('note'), 500);

  var rules = (await rulesForGroup(db, quest.group_id)).files;
  var got = await dashProofFiles(env, session, form, rules.kinds, function (n) { return fileCountProblem(rules, n, false); });
  if ('res' in got) return got.res;
  if (!(await ledgerReady(db))) return behind();

  var teamId = team.id;
  var code = quest.code;
  var oldTotal = await teamTotal(db, team.id);
  var claim = recordClaim();
  var stored = await writeDashProof(env, form, got, { claim: claim }, function (fileRows) {
    return recordPoints(db, {
      teamId: teamId, quest: code, credit: credit, by: session.name, note: note, answer: given, fileRows: fileRows, claim: claim
    });
  }, 'Nothing was recorded. Try again.', function (id) { return !!id; });
  if ('res' in stored) return stored.res;
  var id = stored.value;
  if (!id) return json({ error: CODES_GONE }, 409);
  var total = await teamTotal(db, team.id);
  await logAction(db, session.name, 'points-add', team.name, credit.codes.join(' + '), total - oldTotal, oldTotal, total);
  await later(ctx, tellTeam(env, origin, { id: id, team_id: team.id, team_name: team.name },
    { verdict: 'accepted', quest: quest.code, credit: credit, total: total }));
  var worth = creditWorth(read.parts, credit);
  return json({
    ok: true, id: id, team: team.name, codes: credit.codes, amount: credit.amount,
    gained: worth.given, full: worth.full, total: total, files: got.files.length + got.staged.length
  });
}

export function readCredit(text: string | null | undefined): Credit | null {
  try {
    var c = JSON.parse(text || 'null') as Record<string, unknown> | null;
    if (c && Array.isArray(c.codes) && isFinite(Number(c.amount))) {
      var map = function (v: unknown) { return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, number> : null; };
      return { codes: c.codes as string[], amount: Number(c.amount), amounts: map(c.amounts), counts: map(c.counts),
        numbers: map(c.numbers), points: map(c.points) };
    }
  } catch (err) { /* fall through */ }
  return null;
}

// What a taken-back entry's reason says, which is also how Put back
// knows one.
var TAKEN_BACK = 'Taken back';
var ENTRY_MOVED = 'That entry has changed since it was loaded. Refresh and try again.';

// Taking back points an organiser recorded — the wrong team, the wrong
// quest — whichever way they went: an entry that took points off gives
// them back. The row stays, marked deleted with "Taken back", and what
// it did to the tab is undone in the same batch, once: the stamp in
// claimed_at is the same guard Accept uses against a second press, and
// the row is taken only from the credit it was read with, as Change is.
export async function pointsUndo(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, origin: string, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var row = await db.prepare(
    'SELECT s.id, s.status, s.added_by, s.credit, s.quest_code, s.team_id, t.name AS team_name ' +
    'FROM submissions s JOIN teams t ON t.id = s.team_id WHERE s.id = ?1'
  ).bind(Number(body.id) || 0).first<Pick<SubmissionRow, 'id' | 'status' | 'added_by' | 'credit' | 'quest_code' | 'team_id'> & { team_name: string }>();
  if (!row || !row.added_by) return json({ error: 'No such entry.' }, 404);
  if (row.status !== 'accepted') return json({ error: 'That entry was already taken back.' }, 409);
  var credit = readCredit(row.credit);
  if (!credit) return json({ error: 'That entry does not say what it gave, so take it off by hand.' }, 409);
  var scope = await scopeCodes(db, session);
  if (!credit.codes.every(function (c) { return inScope(scope, c); })) return outOfScope();

  if (!(await ledgerReady(db))) return behind();

  var oldTotal = await teamTotal(db, row.team_id);
  var mark = 'undoing:' + randomKey(9);
  var why = cleanText(body.reason, 200);
  var done = await db.batch([db.prepare(
    "UPDATE submissions SET status = 'deleted', reason = ?2, claimed_at = ?3 WHERE id = ?1 AND status = 'accepted' AND credit IS ?4"
  ).bind(row.id, TAKEN_BACK, mark, row.credit)].concat(
    relineSubmission(db, row, null, mark, session.name, TAKEN_BACK + (why ? ': ' + why : '')),
    [db.prepare("UPDATE submissions SET claimed_at = '' WHERE id = ?1 AND claimed_at = ?2").bind(row.id, mark)]
  ));
  if (!done[0].meta || !done[0].meta.changes) {
    var now = await db.prepare('SELECT status FROM submissions WHERE id = ?1').bind(row.id).first<Pick<SubmissionRow, 'status'>>();
    return json({ error: now && now.status === 'accepted' ? ENTRY_MOVED : 'That entry was already taken back.' }, 409);
  }
  var total = await teamTotal(db, row.team_id);
  await logAction(db, session.name, 'points-undo', row.team_name, credit.codes.join(' + '), total - oldTotal, oldTotal, total);
  await later(ctx, tellTeam(env, origin, { id: null, team_id: row.team_id, team_name: row.team_name },
    { verdict: 'adjusted', quest: row.quest_code, credit: negated(credit), total: total }));
  return json({ ok: true, id: row.id, team: row.team_name, total: total });
}

// Putting back an entry that was taken back: it is accepted again and
// does to the tab what it did before, once, under the same guard. An
// adjustment gets its reason back, which Take back put "Taken back" in
// place of: recordPoints wrote it as the note on the entry's first line,
// where a desk's entry has its own note instead, and a line is never
// edited.
export async function pointsRedo(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, origin: string, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var row = await db.prepare(
    'SELECT s.id, s.status, s.reason, s.note, s.added_by, s.credit, s.quest_code, s.team_id, t.name AS team_name ' +
    'FROM submissions s JOIN teams t ON t.id = s.team_id WHERE s.id = ?1'
  ).bind(Number(body.id) || 0).first<Pick<SubmissionRow, 'id' | 'status' | 'reason' | 'note' | 'added_by' | 'credit' | 'quest_code' | 'team_id'> & { team_name: string }>();
  if (!row || !row.added_by) return json({ error: 'No such entry.' }, 404);
  if (row.status !== 'deleted' || row.reason !== TAKEN_BACK) return json({ error: 'That entry is not one that was taken back.' }, 409);
  // its credit names codes a new quest may have since been given
  if (row.quest_code === DELETED_CODE) return json({ error: 'Its quest was deleted, so this entry cannot be put back.' }, 409);
  var credit = readCredit(row.credit);
  if (!credit) return json({ error: 'That entry does not say what it gave, so put it back by hand.' }, 409);
  var scope = await scopeCodes(db, session);
  if (!credit.codes.every(function (c) { return inScope(scope, c); })) return outOfScope();

  if (!(await ledgerReady(db))) return behind();
  var gone = (await db.prepare('SELECT value FROM json_each(?1) WHERE value NOT IN (SELECT code FROM quests)')
    .bind(JSON.stringify(credit.codes)).all<{ value: string }>()).results.map(function (r) { return r.value; });
  if (gone.length) return json({ error: gone.join(', ') + ' is no longer on the tab, so this entry cannot be put back.' }, 409);
  var first = await db.prepare("SELECT note FROM entries WHERE source_kind = 'submission' AND source_id = ?1 ORDER BY id LIMIT 1")
    .bind(row.id).first<Pick<EntryRow, 'note'>>();
  var reason = first && first.note && first.note !== (row.note || '') ? first.note : null;

  var oldTotal = await teamTotal(db, row.team_id);
  var mark = 'redoing:' + randomKey(9);
  var done = await db.batch([db.prepare(
    "UPDATE submissions SET status = 'accepted', reason = ?4, claimed_at = ?3 WHERE id = ?1 AND status = 'deleted' AND reason = ?2 " +
    'AND credit IS ?5 AND ' + codesThere('submissions.credit')
  ).bind(row.id, TAKEN_BACK, mark, reason, row.credit)].concat(
    relineSubmission(db, row, credit, mark, session.name, ''),
    [db.prepare("UPDATE submissions SET claimed_at = '' WHERE id = ?1 AND claimed_at = ?2").bind(row.id, mark)]
  ));
  if (!done[0].meta || !done[0].meta.changes) {
    var now = await db.prepare('SELECT status, reason FROM submissions WHERE id = ?1').bind(row.id).first<Pick<SubmissionRow, 'status' | 'reason'>>();
    return json({ error: now && now.status === 'deleted' && now.reason === TAKEN_BACK ? ENTRY_MOVED : 'That entry was put back already.' }, 409);
  }
  var total = await teamTotal(db, row.team_id);
  await logAction(db, session.name, 'points-redo', row.team_name, credit.codes.join(' + '), total - oldTotal, oldTotal, total);
  var told: TellWhat = { verdict: 'adjusted', quest: row.quest_code, credit: credit, total: total };
  if (reason) told.reason = reason;
  await later(ctx, tellTeam(env, origin, { id: null, team_id: row.team_id, team_name: row.team_name }, told));
  return json({ ok: true, id: row.id, team: row.team_name, total: total });
}

// Moving an entry to when it happened. Results are often typed in after
// the fact — a marshal's sheet at the end of the day — and the recap's
// hours read when each entry was made. When it was typed in
// (reviewed_at) stays. A code's own time on the tab moves with it where
// this entry was the last thing to change that code.
var FUTURE_SLACK_MS = 5 * 60 * 1000;
export async function pointsTime(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var at = readStamp(body.at);
  if (!at) return json({ error: 'Give a date and a time.' }, 400);
  if (at > utcStamp(new Date(Date.now() + FUTURE_SLACK_MS))) return json({ error: 'That time has not happened yet.' }, 400);
  if (at < '2020-01-01 00:00:00') return json({ error: 'That date is too early.' }, 400);
  var row = await db.prepare(
    'SELECT s.id, s.added_by, s.credit, s.quest_code, s.submitted_at, s.team_id, t.name AS team_name ' +
    'FROM submissions s JOIN teams t ON t.id = s.team_id WHERE s.id = ?1'
  ).bind(Number(body.id) || 0).first<Pick<SubmissionRow, 'id' | 'added_by' | 'credit' | 'quest_code' | 'submitted_at' | 'team_id'> & { team_name: string }>();
  if (!row || !row.added_by) return json({ error: 'No such entry.' }, 404);
  var credit = readCredit(row.credit);
  var codes = credit ? credit.codes : [row.quest_code];
  var scope = await scopeCodes(db, session);
  if (!codes.every(function (c) { return inScope(scope, c); })) return outOfScope();
  if (!(await ledgerReady(db))) return behind();
  var was = row.submitted_at;
  await db.batch([
    db.prepare('UPDATE submissions SET submitted_at = ?2 WHERE id = ?1').bind(row.id, at),
    db.prepare("UPDATE entries SET at = ?2 WHERE source_kind = 'submission' AND source_id = ?1 AND voided_at IS NULL").bind(row.id, at)
  ]);
  await logAction(db, session.name, 'points-time', row.team_name, codes.join(' + ') + ' ' + was + ' → ' + at, 0, 0, 0);
  return json({ ok: true, id: row.id, at: at, was: was });
}

// ---------- the team's ledger ----------

// An adjustment: points put on a team, or taken off, for a reason that is
// no quest's doing or that the quest's own scoring cannot say — a ruling,
// a bonus the committee decided on the day. It is an organiser's entry
// like any other, carrying the reason where a rejection's reason goes, so
// the team reads it on its own list. Its line is worth exactly the points
// given, whatever the code's points become (rescoreLines leaves it); on a
// fixed, per-unit or judged quest it also credits that share of the code
// (50 on a 100-point code is half of it). With no quest it goes on ADJ, a
// hidden loose code worth 1, which an account limited to some quests
// cannot use.
export async function ledgerAdjust(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, origin: string, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var team = await db.prepare('SELECT id, name FROM teams WHERE id = ?1').bind(Number(body.team_id) || 0).first<Pick<TeamRow, 'id' | 'name'>>();
  if (!team) return json({ error: 'Pick a team.' }, 400);
  var reason = cleanText(body.reason, 200);
  if (!reason) return json({ error: 'Say why. The team reads it.' }, 400);
  var points = Math.round(Number(body.points) * 100) / 100;
  if (!isFinite(points) || !points || Math.abs(points) > 100000) {
    return json({ error: 'Give the points to add, or a number below zero to take points off.' }, 400);
  }
  var scope = await scopeCodes(db, session);
  var code = cleanText(body.code, 40);
  if (!(await ledgerReady(db))) return behind();
  var quest: Pick<QuestRow, 'code' | 'points'> | null;
  if (!code) {
    if (scope) return outOfScope();
    await db.prepare(
      "INSERT INTO quests (code, norm, points, group_id, label, sort, hidden) VALUES (?1, ?1, 1, NULL, 'Adjustment', 0, 1) " +
      'ON CONFLICT(code) DO NOTHING'
    ).bind(ADJUST_CODE).run();
    // just made, or already there
    quest = await db.prepare('SELECT code, points FROM quests WHERE code = ?1').bind(ADJUST_CODE).first<Pick<QuestRow, 'code' | 'points'>>() as Pick<QuestRow, 'code' | 'points'>;
  } else {
    quest = await db.prepare('SELECT code, points FROM quests WHERE code = ?1').bind(code).first<Pick<QuestRow, 'code' | 'points'>>();
    if (!quest) return json({ error: 'Pick a quest.' }, 400);
    if (!inScope(scope, quest.code)) return outOfScope();
  }
  var part = (await partsFor(db, [quest.code]))[quest.code];
  var byBands = part.scoring === 'tiered' || part.scoring === 'counted';
  if (!byBands && !Number(quest.points)) {
    return json({ error: quest.code + ' is worth 0 points, so it cannot carry points. Adjust with no quest instead.' }, 400);
  }
  var units = byBands ? 0 : points / Number(quest.points);
  var set: Record<string, number> = {};
  set[quest.code] = points;
  var credit: Credit = { codes: [quest.code], amount: units, points: set };
  var oldTotal = await teamTotal(db, team.id);
  var id = await recordPoints(db, { teamId: team.id, quest: quest.code, credit: credit, by: session.name, reason: reason });
  if (!id) return json({ error: CODES_GONE }, 409);
  var total = await teamTotal(db, team.id);
  await logAction(db, session.name, 'ledger-adjust', team.name, quest.code + ': ' + reason, total - oldTotal, oldTotal, total);
  await later(ctx, tellTeam(env, origin, { id: null, team_id: team.id, team_name: team.name },
    { verdict: 'adjusted', quest: quest.code, credit: credit, total: total, reason: reason }));
  return json({ ok: true, id: id, team: team.name, code: quest.code, points: points, total: total });
}

// Undoing one line that no submission made: an award's line for one team,
// or a balance from before the ledger. A submission's lines are undone
// with the submission, which keeps what it says it gave true; the one
// exception is a submission already deleted whose lines are still live
// ("Deleted, points kept", from the ledger migration), which says it
// gives nothing and has no other way to be undone.
var LINE_ALONE = "(e.source_kind != 'submission' OR NOT EXISTS (SELECT 1 FROM submissions s WHERE s.id = e.source_id AND s.status != 'deleted'))";
export async function ledgerVoid(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, origin: string, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  if (!(await ledgerReady(db))) return behind();
  var line = await db.prepare(
    'SELECT e.id, e.team_id, e.code, e.units, e.points, e.source_kind, e.voided_at, t.name AS team_name, ' + LINE_ALONE + ' AS alone ' +
    'FROM entries e JOIN teams t ON t.id = e.team_id WHERE e.id = ?1'
  ).bind(Number(body.id) || 0).first<Pick<EntryRow, 'id' | 'team_id' | 'code' | 'units' | 'points' | 'source_kind' | 'voided_at'> & { team_name: string; alone: number }>();
  if (!line) return json({ error: 'No such line.' }, 404);
  if (line.voided_at) return json({ error: 'That line was undone already.' }, 409);
  if (!line.alone) return json({ error: 'Undo the submission it came from instead.' }, 409);
  var reason = cleanText(body.reason, 200);
  if (!reason) return json({ error: 'Say why.' }, 400);
  if (!inScope(await scopeCodes(db, session), line.code)) return outOfScope();
  var oldTotal = await teamTotal(db, line.team_id);
  var done = await db.batch([db.prepare(
    "UPDATE entries AS e SET voided_at = datetime('now'), voided_by = ?2, void_reason = ?3 WHERE e.id = ?1 AND e.voided_at IS NULL AND " + LINE_ALONE
  ).bind(line.id, session.name, reason)]);
  if (!done[0].meta || !done[0].meta.changes) return json({ error: 'That line was undone already.' }, 409);
  var total = await teamTotal(db, line.team_id);
  await logAction(db, session.name, 'ledger-void', line.team_name, line.code + ': ' + reason, total - oldTotal, oldTotal, total);
  var off: Record<string, number> = {};
  off[line.code] = -Number(line.points);
  await later(ctx, tellTeam(env, origin, { id: null, team_id: line.team_id, team_name: line.team_name },
    { verdict: 'adjusted', quest: line.code, credit: { codes: [line.code], amount: -line.units, points: off }, total: total, reason: reason }));
  return json({ ok: true, id: line.id, team: line.team_name, total: total });
}
