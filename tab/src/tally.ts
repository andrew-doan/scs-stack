// Challenges: a quest won by how much a team does across all of its
// submissions for it ("visit the most stations") rather than by any one
// of them. What is counted is the quest's rules.tally (rules.ts):
//
//   picks        the different entries picked in the quest's first pick
//                question, a station sent twice counting once, matched
//                without regard to case or the spaces around it
//   sum          the numbers given to its first count question, added up
//   highest      the highest number given to that question: a team sends
//                again through the day to beat its own best ("the most
//                people in one photo"), and only its best counts
//   submissions  the accepted submissions themselves
//
// Only accepted submissions count, on any of the quest's codes, an
// organiser's entries included. Pending and queued ones are shown apart
// as what they would add and are never counted. Teams are placed by
// their count, a tie sharing a place (1, 1, 3), and a team with nothing
// counted is not placed. Hidden teams (tests) are flagged, never placed
// and left out of everything public.
//
// A challenge is worked out from one read of the quest's submissions,
// however many teams there are, and the dashboard's view of one team
// adds the read of that team's files: never a query per team or per
// submission.
//
// Awarding the places is an award on the ledger (ledger.ts), made once
// the way a wager is settled: the unique index on a live award of its
// kind on its code refuses a second. A quest whose challenge is one of
// its parts (a counted part, parts.ts) is awarded on that part, each team
// the band its count reached and the points for its place, in one line.

import { json, corsJson, normQuest } from './shared.ts';
import { rulesOf } from './rules.ts';
import { questionsOf } from './quests.ts';
import { requireTeam, attachMedia, parseAnswer } from './submit.ts';
import { rowVisibleTo } from './access.ts';
import { tabState } from './freeze.ts';
import { scopeCodes, inScope, outOfScope } from './points.ts';
import { ledgerReady, LEDGER_BEHIND, awardStatements, voidAward, liveAward, awardGiven, awardUndoable, isTaken } from './ledger.ts';
import { partsFor, bandFor } from './parts.ts';
import type { Answer, AnswerEntry, Band, ConsoleSession, Env, JsonBody, LogAction, QuestGroupRow, QuestRow, SubmissionRow, TallyKind } from './types.ts';

// A quest read as a challenge (COLS).
type ChallengeRow = Pick<QuestGroupRow, 'id' | 'key' | 'name' | 'hidden' | 'visibility' | 'submit_kind' | 'questions' | 'rules' | 'tally_settled'>;
// Once the places are awarded: when, by whom, and whether undoing it
// would move anything.
interface Settled {
  at: string;
  by: string;
  undoable: boolean;
  id?: number;
  code?: string;
}
// The quest as a challenge (challengeFor).
interface Challenge {
  id: number;
  key: string;
  name: string;
  hidden: number;
  visibility: string;
  kind: TallyKind;
  awards: number[];
  public: boolean;
  want: string;
  at: number;
  settled: Settled | null;
  counted: { code: string; bands: Band[] } | null;
}
// One of the quest's codes, and the first the site shows.
type Lead = Pick<QuestRow, 'code' | 'points' | 'hidden'>;
// One submission as countTeams reads it, its answer read back in place
// and, on a running total or a highest number, what it counted.
type TallySub = Pick<SubmissionRow, 'id' | 'team_id' | 'quest_code' | 'status' | 'submitted_at' | 'note' | 'added_by' | 'credit'> &
  { answer: Answer | null; team_name: string; team_hidden: number; amount?: number };
// An entry a picks challenge counted, with the submission that first
// brought it in.
interface Item {
  name: string;
  id: number;
  at: string;
}
// One team's part in a challenge.
interface TallyTeam {
  id: number;
  name: string;
  hidden: number;
  place: number | null;
  award: number;
  band: number;
  count: number;
  waiting: number;
  items: Item[];
  waiting_items: Item[];
  accepted: TallySub[];
  pending: TallySub[];
  seen?: Record<string, boolean>;
  best?: number;
}

var PRIVATE = { 'cache-control': 'private, no-store' };
var STANDINGS_PATH = '/api/quest/standings';

var COLS = 'g.id, g.key, g.name, g.hidden, g.visibility, g.submit_kind, g.questions, g.rules, g.tally_settled';

// The quest a key or one of its codes names, matched the way the tab
// matches codes, since the site sends either.
async function challengeRow(db: D1Database, quest: unknown): Promise<ChallengeRow | null> {
  var norm = normQuest(quest == null ? '' : quest);
  if (!norm) return null;
  return (await db.prepare('SELECT ' + COLS + " FROM quest_groups g WHERE UPPER(REPLACE(g.key, ' ', '')) = ?1")
    .bind(norm).first<ChallengeRow>()) ||
    (await db.prepare('SELECT ' + COLS + ' FROM quests q JOIN quest_groups g ON g.id = q.group_id WHERE q.norm = ?1')
      .bind(norm).first<ChallengeRow>());
}

// {at, by, undoable} once the places are awarded, null before: the live
// award, or on a database behind the ledger the stamp the quest kept. An
// award carried over from before awards kept what they gave never had
// lines, and undoing it would move nothing (awardUndoable).
async function settledOf(db: D1Database, row: ChallengeRow): Promise<Settled | null> {
  var award = await liveAward(db, 'challenge', row.id);
  if (award) {
    return { at: award.made_at, by: award.made_by, undoable: await awardUndoable(db, award), id: award.id, code: award.code };
  }
  if (!row.tally_settled || await ledgerReady(db)) return null;
  try {
    var s = JSON.parse(row.tally_settled) as { at?: string; by?: string } | null;
    return { at: (s && s.at) || '', by: (s && s.by) || '', undoable: false };
  } catch (err) {
    return { at: '', by: '', undoable: false };
  }
}

// The quest as a challenge: what it counts, where in a stored answer
// that question sits (its position among the quest's questions, 'codes'
// first when there is one, as the submit form asks them; -1 when the
// quest asks none of that kind), the points by place and whether they
// are awarded.
async function challengeFor(db: D1Database, quest: unknown): Promise<Challenge | null> {
  var row = await challengeRow(db, quest);
  if (!row) return null;
  var tally = rulesOf(row.rules).tally;
  var want = tally.kind === 'picks' ? 'pick' : tally.kind === 'sum' || tally.kind === 'highest' ? 'count' : '';
  var at = -1;
  if (want) {
    var stored: unknown = null;
    try { stored = JSON.parse(row.questions || 'null'); } catch (err) { stored = null; }
    questionsOf(row, [], stored).some(function (q, i) {
      if (q && q.kind === want) { at = i; return true; }
      return false;
    });
  }
  return {
    id: row.id, key: row.key, name: row.name, hidden: row.hidden, visibility: row.visibility,
    kind: tally.kind, awards: tally.awards, public: tally.public, want: want, at: at,
    settled: await settledOf(db, row), counted: await countedPart(db, row.id)
  };
}

// The quest's counted part, {code, bands}, or null for a challenge
// awarded on its lead code.
async function countedPart(db: D1Database, groupId: number): Promise<{ code: string; bands: Band[] } | null> {
  var codes = (await db.prepare('SELECT code FROM quests WHERE group_id = ?1 ORDER BY sort, code').bind(groupId).all<Pick<QuestRow, 'code'>>()).results
    .map(function (r) { return r.code; });
  var parts = await partsFor(db, codes);
  for (var i = 0; i < codes.length; i++) {
    var p = parts[codes[i]];
    if (p && p.scoring === 'counted' && !p.hidden) return { code: p.code, bands: p.bands };
  }
  return null;
}

// The quest's codes in order, and the first one the site shows, which is
// the one the places are credited on.
async function codesOf(db: D1Database, c: Pick<Challenge, 'id'>): Promise<{ all: Lead[]; lead: Lead | null }> {
  var codes = (await db.prepare('SELECT code, points, hidden FROM quests WHERE group_id = ?1 ORDER BY sort, code')
    .bind(c.id).all<Lead>()).results;
  return { all: codes, lead: codes.filter(function (q) { return !q.hidden; })[0] || null };
}

// The answer to the counted question in a stored answer: the first
// question's is at the top and the rest under `more`, in order. An answer
// sent before the quest's questions were changed may hold it somewhere
// else, so a slot holding another kind falls back to the first answer of
// the right kind. A quest that asks no such question is counted from the
// number a reviewer typed on Review or the Points tab, kept in the answer
// as an entry of that kind (`prompt` Counted).
function answerTo(answer: Answer | null, at: number, kind: string): AnswerEntry | null {
  if (!answer) return null;
  var list = ([answer] as (AnswerEntry | null)[]).concat(Array.isArray(answer.more) ? answer.more : []);
  if (at >= 0 && at < list.length && list[at] === null) return null;
  var slot = at >= 0 ? list[at] : null;
  if (slot && slot.kind === kind) return slot;
  for (var i = 0; i < list.length; i++) {
    var one = list[i];
    if (one && one.kind === kind) return one;
  }
  return null;
}

// An organiser's entry that took points off is a correction, not
// something the team did, and so is an adjustment, which sets its worth
// outright (`points`) and on a tiered or counted code credits nothing.
function tookOff(r: Pick<SubmissionRow, 'added_by' | 'credit'>): boolean {
  if (!r.added_by) return false;
  try {
    var credit = JSON.parse(r.credit || 'null') as { amount?: unknown; points?: unknown } | null;
    return !!credit && (Number(credit.amount) < 0 || credit.points != null);
  } catch (err) {
    return false;
  }
}

function round(n: number): number { return Math.round(n * 100) / 100; }

// Every team's count, placed. With teamId, that team's submissions
// alone, unplaced. Each team carries its count, what its waiting
// submissions would add (`waiting`), its submissions in two lists, and
// for picks each entry with the submission that first brought it in.
async function countTeams(db: D1Database, c: Challenge, teamId?: number): Promise<TallyTeam[]> {
  var sql = 'SELECT s.id, s.team_id, s.quest_code, s.status, s.submitted_at, s.note, s.answer, s.added_by, s.credit, ' +
    't.name AS team_name, t.hidden AS team_hidden FROM submissions s JOIN teams t ON t.id = s.team_id ' +
    "WHERE s.status IN ('accepted', 'pending', 'queued') AND s.quest_code IN (SELECT code FROM quests WHERE group_id = ?1) " +
    (teamId ? 'AND s.team_id = ?2 ' : '') + 'ORDER BY s.submitted_at, s.id';
  var stmt = db.prepare(sql);
  var rows = (await (teamId ? stmt.bind(c.id, teamId) : stmt.bind(c.id)).all<Omit<TallySub, 'answer'> & { answer: string | null }>()).results;

  var teams: TallyTeam[] = [];
  var byId: Record<number, TallyTeam> = {};
  function teamOf(r: TallySub): TallyTeam {
    var t = byId[r.team_id];
    if (!t) {
      t = byId[r.team_id] = {
        id: r.team_id, name: r.team_name, hidden: r.team_hidden ? 1 : 0, place: null, award: 0, band: 0,
        count: 0, waiting: 0, items: [], waiting_items: [], accepted: [], pending: [], seen: {}
      };
      teams.push(t);
    }
    return t;
  }
  // accepted first, so what a waiting submission would add is only what
  // is not counted already
  var accepted = rows.filter(function (r) { return r.status === 'accepted'; });
  var waiting = rows.filter(function (r) { return r.status !== 'accepted'; });
  accepted.concat(waiting).forEach(function (row) {
    // the answer is read back in place
    var r = row as unknown as TallySub;
    r.answer = parseAnswer(row.answer);
    var t = teamOf(r);
    var counted = r.status === 'accepted';
    (counted ? t.accepted : t.pending).push(r);
    if (c.kind === 'submissions') {
      if (!counted) t.waiting += 1;
      else if (!tookOff(r)) t.count += 1;
      return;
    }
    var entry = answerTo(r.answer, c.at, c.want);
    if (!entry || entry.value == null) return;
    if (c.kind === 'sum' || c.kind === 'highest') {
      var n = Number(entry.value);
      if (!isFinite(n) || n <= 0) return;
      r.amount = n;
      if (c.kind === 'sum') {
        if (counted) t.count += n;
        else t.waiting += n;
      } else if (counted) {
        // the first to reach the best is the one that holds it
        if (n > t.count) { t.count = n; t.best = r.id; }
      } else {
        t.waiting = Math.max(t.waiting, n);
      }
      return;
    }
    // set when the team is made, taken off once it is counted
    var seen = t.seen as Record<string, boolean>;
    (Array.isArray(entry.value) ? entry.value : []).forEach(function (v) {
      var name = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
      var match = name.toLowerCase();
      if (!match || seen[match]) return;
      seen[match] = true;
      (counted ? t.items : t.waiting_items).push({ name: name, id: r.id, at: r.submitted_at });
    });
  });
  teams.forEach(function (t) {
    if (c.kind === 'picks') {
      t.count = t.items.length;
      t.waiting = t.waiting_items.length;
    }
    // a waiting number that would not beat the best changes nothing
    if (c.kind === 'highest' && t.waiting <= t.count) t.waiting = 0;
    t.count = round(t.count);
    t.waiting = round(t.waiting);
    delete t.seen;
  });
  if (teamId) return teams;

  teams.sort(function (a, b) {
    return (b.count - a.count) || (a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1);
  });
  var place = 0;
  var placed = 0;
  var last: number | null = null;
  teams.forEach(function (t) {
    if (t.hidden || !(t.count > 0)) return;
    placed += 1;
    if (t.count !== last) { place = placed; last = t.count; }
    t.place = place;
    t.award = c.awards[place - 1] || 0;
    t.band = c.counted ? bandFor(c.counted.bands, t.count) : 0;
  });
  return teams;
}

// ---------- the dashboard ----------

// An account limited to some quests sees the challenges among them.
async function outsideScope(db: D1Database, session: ConsoleSession, codes: Lead[]): Promise<boolean> {
  var scope = await scopeCodes(db, session);
  return !!scope && !codes.some(function (q) { return inScope(scope, q.code); });
}

function board(c: Challenge, codes: { all: Lead[]; lead: Lead | null }, teams: TallyTeam[]): object {
  return {
    ok: true, key: c.key, name: c.name, kind: c.kind, awards: c.awards, public: c.public,
    code: c.counted ? { code: c.counted.code, points: 0 } : codes.lead ? { code: codes.lead.code, points: codes.lead.points } : null,
    bands: c.counted ? c.counted.bands : [],
    settled: c.settled,
    teams: teams.map(function (t) {
      return { id: t.id, name: t.name, hidden: t.hidden, place: t.place, count: t.count, waiting: t.waiting, award: t.award, band: t.band };
    })
  };
}

// GET tally?quest=KEY: every team with anything for the challenge,
// placed, with the points by place and whether they are awarded.
export async function tallyBoard(env: Env, session: ConsoleSession, url: URL): Promise<Response> {
  var db = env.DB;
  var c = await challengeFor(db, url.searchParams.get('quest'));
  if (!c) return json({ error: 'no such quest' }, 404);
  var codes = await codesOf(db, c);
  if (await outsideScope(db, session, codes.all)) return outOfScope();
  if (!c.kind) return json({ ok: true, key: c.key, name: c.name, kind: '' });
  return json(board(c, codes, await countTeams(db, c)));
}

// GET tally/team?quest=KEY&team_id=N: one team's part in it in one
// place — every entry counted with the submission it came from, every
// accepted submission with its files, and the waiting ones apart.
export async function tallyTeam(env: Env, session: ConsoleSession, url: URL): Promise<Response> {
  var db = env.DB;
  var c = await challengeFor(db, url.searchParams.get('quest'));
  if (!c) return json({ error: 'no such quest' }, 404);
  var codes = await codesOf(db, c);
  if (await outsideScope(db, session, codes.all)) return outOfScope();
  var team = await db.prepare('SELECT id, name, hidden FROM teams WHERE id = ?1')
    .bind(Number(url.searchParams.get('team_id')) || 0).first<{ id: number; name: string; hidden: number }>();
  if (!team) return json({ error: 'no such team' }, 404);
  if (!c.kind) return json({ ok: true, key: c.key, name: c.name, kind: '' });

  var teamId = team.id;
  var t: Pick<TallyTeam, 'place' | 'count' | 'waiting' | 'items' | 'waiting_items' | 'accepted' | 'pending' | 'best'> =
    (await countTeams(db, c)).filter(function (one) { return one.id === teamId; })[0] ||
    { place: null, count: 0, waiting: 0, items: [], waiting_items: [], accepted: [], pending: [] };
  var subs = await attachMedia(env, t.accepted.concat(t.pending).map(function (r) {
    return {
      id: r.id, quest_code: r.quest_code, status: r.status, submitted_at: r.submitted_at, note: r.note || '',
      added_by: r.added_by || '', answer: r.answer, amount: r.amount != null ? r.amount : null
    };
  }));
  var byId: Record<number, (typeof subs)[number]> = {};
  subs.forEach(function (s) { byId[s.id] = s; });
  // each entry with the first file of the submission that brought it in
  var withFile = function (item: Item) {
    var first = (byId[item.id] && byId[item.id].media[0]) || null;
    return { name: item.name, id: item.id, at: item.at, key: first ? first.key : '', type: first ? first.type : '' };
  };
  return json({
    ok: true, key: c.key, name: c.name, kind: c.kind,
    team: { id: team.id, name: team.name, hidden: team.hidden ? 1 : 0 },
    place: t.place, count: t.count, waiting: t.waiting, best: t.best || null,
    items: t.items.map(withFile), waiting_items: t.waiting_items.map(withFile),
    accepted: subs.filter(function (s) { return s.status === 'accepted'; }),
    pending: subs.filter(function (s) { return s.status !== 'accepted'; })
  });
}

// POST tally/award {quest}: each placed team is credited the points for
// its place, as one award: on a counted part, a line worth its band and
// its place; otherwise on the quest's lead code, each line crediting the
// award divided by what the code is worth. Once only: a second press or a
// retried request is a 409; undo the award to award again.
export async function tallyAward(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var c = await challengeFor(db, body.quest);
  if (!c) return json({ error: 'no such quest' }, 404);
  if (!c.kind) return json({ error: 'That quest is not a challenge.' }, 400);
  if (!(await ledgerReady(db))) return json({ error: LEDGER_BEHIND }, 503);
  if (c.settled) return json({ error: 'The points for this challenge were awarded already.', settled: c.settled }, 409);
  var bands = c.counted ? c.counted.bands : [];
  if (!c.awards.some(function (n) { return n > 0; }) && !bands.some(function (b) { return b.points; })) {
    return json({ error: 'This challenge has no points by place' + (c.counted ? ' or bands' : '') + '. Set them in the quest editor first.' }, 400);
  }
  var codes = await codesOf(db, c);
  var code: Pick<QuestRow, 'code' | 'points'> | null = c.counted ? { code: c.counted.code, points: 0 } : codes.lead;
  if (!code) return json({ error: 'This quest has no visible code to score against.' }, 400);
  if (!inScope(await scopeCodes(db, session), code.code)) return outOfScope();
  if (!c.counted && !code.points) {
    return json({ error: code.code + ' is worth 0 points, so there is nothing to divide the award by. Give it points first.' }, 400);
  }
  var teams = await countTeams(db, c);
  var worth = code.points;
  var placed = teams.filter(function (t) { return t.award + t.band !== 0; });
  if (!placed.length) return json({ error: 'No team has anything counted yet.' }, 400);

  var total = 0;
  var counted = c.counted;
  placed.forEach(function (t) { total += t.award + t.band; });
  var made: D1Result[];
  try {
    made = await db.batch(awardStatements(db, {
      kind: 'challenge', group_id: c.id, code: code.code, by: session.name, note: c.counted ? 'Bands and places' : 'Points by place',
      basis: { kind: c.kind, awards: c.awards, bands: bands, teams: teams.filter(function (t) { return t.count > 0; }).map(function (t) {
        return { id: t.id, place: t.place, count: t.count, award: t.award, band: t.band };
      }) },
      given: placed.map(function (t): [number, number] | [number, number, number] { return counted ? [t.id, 0, t.award + t.band] : [t.id, t.award / worth]; })
    }));
  } catch (err) {
    if (!isTaken(err)) throw err;
    made = [];
  }
  // the award row is the first statement, made only while there is none
  if (!made.length || !made[0].meta || !made[0].meta.changes) {
    var other = await challengeFor(db, c.key);
    return json({ error: 'The points for this challenge were awarded already.', settled: other && other.settled }, 409);
  }
  var now = await challengeFor(db, c.key);
  await logAction(db, session.name, 'tally-award', c.key,
    code.code + ', ' + placed.length + ' team' + (placed.length === 1 ? '' : 's'), round(total), 0, 0);
  return json({
    ok: true, code: code.code, settled: now && now.settled,
    awarded: placed.map(function (t) { return { name: t.name, place: t.place, points: round(t.award + t.band) }; })
  });
}

// Taking an award back voids it: each team loses what the award gave it,
// once, and the challenge can be awarded again. One whose lines were all
// undone one at a time is voided the same way, moving nothing more.
export async function tallyUnaward(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var c = await challengeFor(db, body.quest);
  if (!c) return json({ error: 'no such quest' }, 404);
  if (!(await ledgerReady(db))) return json({ error: LEDGER_BEHIND }, 503);
  var award = await liveAward(db, 'challenge', c.id);
  if (!award) return json({ error: 'Nothing has been awarded for this challenge.' }, 409);
  if (!(await awardUndoable(db, award))) {
    return json({ error: 'This award was made before the dashboard kept what it gave each team, so take it off on the Points tab.' }, 409);
  }
  var lines = await awardGiven(db, award.id);
  if (!inScope(await scopeCodes(db, session), award.code)) return outOfScope();
  var done = await db.batch(voidAward(db, award, session.name, 'Award undone'));
  if (!done[0].meta || !done[0].meta.changes) return json({ error: 'That award was taken back already.' }, 409);
  var off = lines.reduce(function (sum, l) { return sum + Number(l.points); }, 0);
  await logAction(db, session.name, 'tally-unaward', c.key,
    award.code + ', ' + lines.length + ' team' + (lines.length === 1 ? '' : 's'), -round(off), 0, 0);
  return json({ ok: true, code: award.code, teams: lines.length });
}

// ---------- the site ----------

// GET /api/submit/tally?quest=KEY: the signed-in team's own count, what
// its waiting submissions would add and, for picks, what it has so far.
// A count is standings, so the freeze and the closed tab stop it the way
// they stop the team's score sheet.
export async function teamTally(request: Request, env: Env, url: URL): Promise<Response> {
  var team = await requireTeam(request, env.DB);
  if (!team) return corsJson({ error: 'not signed in' }, 401, PRIVATE);
  var gate = await tabState(env.DB);
  if (gate.closed) return corsJson({ ok: true, closed: true }, 200, PRIVATE);
  if (gate.frozen) return corsJson({ ok: true, frozen: true }, 200, PRIVATE);
  var c = await challengeFor(env.DB, url.searchParams.get('quest'));
  if (!c || !(await rowVisibleTo(env.DB, c, team.team_id))) {
    return corsJson({ error: 'No quest by that code.' }, 404, PRIVATE);
  }
  if (!c.kind) return corsJson({ ok: true, frozen: false, kind: '' }, 200, PRIVATE);
  var t: Pick<TallyTeam, 'count' | 'waiting' | 'items' | 'waiting_items'> = (await countTeams(env.DB, c, team.team_id))[0] || { count: 0, waiting: 0, items: [], waiting_items: [] };
  var names = function (list: Item[]) { return list.map(function (item) { return item.name; }); };
  return corsJson({
    ok: true, frozen: false, key: c.key, kind: c.kind, count: t.count, waiting: t.waiting,
    items: c.kind === 'picks' ? names(t.items) : [],
    waiting_items: c.kind === 'picks' ? names(t.waiting_items) : []
  }, 200, PRIVATE);
}

// GET /api/quest/standings?quest=KEY: the placed teams, for the quest
// page, when the quest shows its standings and the reader can see the
// quest. It is not one of the frozen paths, since the freeze keeps a
// copy of three payloads and none of them is this, so it stops itself:
// frozen it answers that and nothing else, closed the same. Answers
// {status, body, everyone}; `everyone` says the answer is the same for
// any reader and may be kept at the edge.
export async function standingsPayload(db: D1Database, quest: unknown, teamId: number): Promise<{ status: number; body: object; everyone: boolean }> {
  var c = await challengeFor(db, quest);
  if (!c || !c.kind || !c.public || !(await rowVisibleTo(db, c, teamId))) {
    return { status: 404, body: { error: 'No standings for that quest.' }, everyone: false };
  }
  var everyone = !c.hidden && (c.visibility || 'everyone') === 'everyone';
  var gate = await tabState(db);
  if (gate.closed) return { status: 200, body: { closed: true }, everyone: everyone };
  if (gate.frozen) return { status: 200, body: { frozen: true, frozen_at: gate.frozen.frozen_at }, everyone: everyone };
  var teams = (await countTeams(db, c)).filter(function (t) { return t.place; });
  return {
    status: 200, everyone: everyone,
    body: {
      key: c.key, name: c.name, kind: c.kind,
      teams: teams.map(function (t) { return { place: t.place, name: t.name, count: t.count }; })
    }
  };
}

// The address of every challenge whose standings the site shows, for
// the purge after a score changes: the edge keeps each one under its
// own address, quest and all.
export async function standingsPaths(db: D1Database): Promise<string[]> {
  try {
    var rows = (await db.prepare("SELECT key, rules FROM quest_groups WHERE rules != ''").all<Pick<QuestGroupRow, 'key' | 'rules'>>()).results;
    return rows.filter(function (r) { return rulesOf(r.rules).tally.public; })
      .map(function (r) { return STANDINGS_PATH + '?quest=' + encodeURIComponent(r.key); });
  } catch (err) {
    return [];
  }
}

// A challenge's own count for every team that has one, highest first,
// for a board somewhere else (the Ranks tab's, the recap's); null when
// the quest is not a challenge. Hidden teams are flagged, as in
// customBoard.
export async function challengeCounts(db: D1Database, quest: unknown): Promise<{ id: number; name: string; hidden: boolean; value: number }[] | null> {
  var c = await challengeFor(db, quest);
  if (!c || !c.kind) return null;
  return (await countTeams(db, c)).filter(function (t) { return t.count > 0; }).map(function (t) {
    return { id: t.id, name: t.name, hidden: !!t.hidden, value: t.count };
  });
}
