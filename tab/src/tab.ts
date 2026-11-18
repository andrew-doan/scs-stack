// The tab's standings and the number formatting every reader shares:
// the Discord commands, the dashboard's Discord posts and the public
// API all rank teams the same way.
import { EOI_CODE } from './eoi.ts';
import { DELETED_CODE } from './deleted.ts';
import { normQuest } from './shared.ts';
import type { TeamRow, QuestRow, HeldRow, SubmissionRow } from './types.ts';

// A visible team on the board, best first (standings).
export interface Standing {
  id: number;
  name: string;
  dnf: boolean;
  pts: number;
  quests_done: number;
  // its place among the teams that finished; null when it did not
  rank: number | null;
}

// The Recap tab's boards (questsDone, submitTimes, customBoard).
export interface QuestsDoneTeam { id: number; name: string; hidden: boolean; quests: number; keys: string[] }
export interface SubmitTimesTeam { id: number; name: string; hidden: boolean; submissions: number; average: number; quickest: number }
export interface BoardTeam { id: number; name: string; hidden: boolean; value: number }

// Loose codes that put points on a team without being a quest: the EOI
// award and an adjustment made with no quest. They count in a total and
// never as a quest done or as what a team last scored. DELETED holds
// what deleted quests leave behind (deleted.ts) and never counts at all.
export var ADJUST_CODE = 'ADJ';
export var NOT_QUESTS = [EOI_CODE, ADJUST_CODE, DELETED_CODE];
var NOT_QUESTS_SQL = "('" + NOT_QUESTS.join("', '") + "')";
export function notQuest(code: string): boolean { return NOT_QUESTS.indexOf(code) !== -1; }

// What each of those codes is kept for. A quest that took one, or a code
// that reads as one (`adj`), would take over the points and submissions
// the code holds, so no quest may: the refusal, or '' for any other code.
var KEPT_FOR: Record<string, string> = {};
KEPT_FOR[EOI_CODE] = 'the expression of interest award';
KEPT_FOR[ADJUST_CODE] = 'adjustments';
KEPT_FOR[DELETED_CODE] = 'what deleted quests leave behind';
export function reservedCode(code: unknown): string {
  var norm = normQuest(code == null ? '' : code);
  for (var i = 0; i < NOT_QUESTS.length; i++) {
    if (norm && norm === normQuest(NOT_QUESTS[i])) {
      return NOT_QUESTS[i] + ' is kept for ' + KEPT_FOR[NOT_QUESTS[i]] + ', so a quest cannot use it. Pick another code.';
    }
  }
  return '';
}

export function fmtPts(n: number): string {
  var rounded = Math.round(n * 100) / 100;
  return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function fmtAmount(n: number): string {
  return Math.round(n * 100) / 100 + '';
}

// A team's points summed in SQL over `held c`: what its lines were worth
// when they were written, to the hundredth.
export var SUM_POINTS = 'ROUND(COALESCE(SUM(c.points), 0), 2)';

// How many times a credit counted a code, and what it put on it: parts.ts.
export { countFor, amountFor } from './parts.ts';

// Whether a code's amount and points can be shown together. On a
// mystery quest a part mark cannot: the two give the full points away.
// A part mark taken back can leave a whole amount a hair off whole.
export function showsPoints(mystery: unknown, amount: unknown): boolean {
  var n = Number(amount);
  return !mystery || Math.abs(n - Math.round(n)) < 1e-6;
}

// A tiered or counted code's lines are worth their bands and places, so
// its amount times its points says nothing: readers show what it came to.
export function bandsScore(scoring: string | null | undefined): boolean { return scoring === 'tiered' || scoring === 'counted'; }

export function ordinal(n: number): string {
  var tail = n % 100;
  if (tail >= 11 && tail <= 13) return n + 'th';
  var last = n % 10;
  return n + (last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th');
}

var STANDINGS_SQL = 'SELECT t.id, t.name, t.dnf, ' + SUM_POINTS + ' AS pts, ' +
    "COUNT(CASE WHEN c.amount > 0 AND c.quest_code NOT IN " + NOT_QUESTS_SQL + " THEN 1 END) AS quests_done " +
    'FROM teams t ' +
    'LEFT JOIN held c ON c.team_id = t.id ' +
    'LEFT JOIN quests q ON q.code = c.quest_code ' +
    'WHERE t.hidden = 0 ' +
    'GROUP BY t.id ' +
    'ORDER BY pts DESC, t.name COLLATE NOCASE';

// Every visible team with its total, best first, and its rank: its
// position among the teams that finished. A team that did not finish
// (teams.dnf) keeps its spot in the order with no rank, and the teams
// under it are ranked as if it were not there: 100, 90 (DNF) and 80
// are 1, null and 2.
export async function standings(db: D1Database): Promise<Standing[]> {
  type Raw = Pick<TeamRow, 'id' | 'name' | 'dnf'> & { pts: number; quests_done: number };
  var rows = (await db.prepare(STANDINGS_SQL).all<Raw>()).results;
  var place = 0;
  return rows.map(function (r) {
    var dnf = !!r.dnf;
    return { id: r.id, name: r.name, dnf: dnf, pts: r.pts, quests_done: r.quests_done, rank: dnf ? null : ++place };
  });
}

// The tab as a sheet, in the shape of the committee's spreadsheet
// (data/quest-tracker.csv): a row per code as written on the tab, a
// column per team, each cell the team's amount on the code and empty
// where it holds none. Only the teams on the public board and only the
// codes anyone may see: not hidden, and in no quest kept from anyone.
function csvCell(v: unknown): string {
  var t = String(v == null ? '' : v);
  return /[",\r\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t;
}
export async function tabCsv(db: D1Database): Promise<string> {
  var teams = (await db.prepare('SELECT id, name FROM teams WHERE hidden = 0 ORDER BY id').all<Pick<TeamRow, 'id' | 'name'>>()).results;
  var codes = (await db.prepare(
    'SELECT q.code FROM quests q LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    "WHERE q.hidden = 0 AND COALESCE(g.hidden, 0) = 0 AND COALESCE(g.visibility, 'everyone') = 'everyone' " +
    'ORDER BY g.sort, q.sort, q.norm'
  ).all<Pick<QuestRow, 'code'>>()).results;
  var held: Record<string, number> = {};
  (await db.prepare(
    'SELECT c.team_id, c.quest_code, c.amount FROM held c JOIN teams t ON t.id = c.team_id WHERE t.hidden = 0'
  ).all<Pick<HeldRow, 'team_id' | 'quest_code' | 'amount'>>()).results.forEach(function (r) { held[r.quest_code + '\n' + r.team_id] = r.amount; });
  var lines = [['Challenge'].concat(teams.map(function (t) { return t.name; })).map(csvCell).join(',')];
  codes.forEach(function (q) {
    lines.push([q.code].concat(teams.map(function (t) {
      var a = held[q.code + '\n' + t.id];
      return a == null ? '' : fmtAmount(a);
    })).map(csvCell).join(','));
  });
  return lines.join('\r\n') + '\r\n';
}

// How many different quests each team has done. A quest's codes count
// once between them (S24-1 and S24-12 are both S24), a code in no quest
// is a quest of its own, and only credit counts: an amount above zero
// on a code worth points, so a penalty is not a quest done. EOI and an
// adjustment are not quests. Every team is in it, hidden ones flagged; the dashboard
// leaves them out with Hide hidden teams everywhere and ranks the rest.
export async function questsDone(db: D1Database): Promise<QuestsDoneTeam[]> {
  var teams = (await db.prepare('SELECT id, name, hidden FROM teams ORDER BY name COLLATE NOCASE').all<Pick<TeamRow, 'id' | 'name' | 'hidden'>>()).results;
  var done: Record<number, string[]> = {};
  (await db.prepare(
    'SELECT DISTINCT c.team_id, COALESCE(g.key, q.code) AS quest FROM held c ' +
    'JOIN quests q ON q.code = c.quest_code LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    'WHERE c.amount > 0 AND q.points > 0 AND c.quest_code NOT IN ' + NOT_QUESTS_SQL
  ).all<{ team_id: number; quest: string }>()).results.forEach(function (r) {
    (done[r.team_id] = done[r.team_id] || []).push(r.quest);
  });
  return teams.map(function (t) {
    var keys = (done[t.id] || []).sort(function (a, b) { return a.localeCompare(b, 'en', { numeric: true }); });
    return { id: t.id, name: t.name, hidden: !!t.hidden, quests: keys.length, keys: keys };
  }).sort(function (a, b) { return b.quests - a.quests; });
}

// How long each team takes from taking a photo or video to sending it
// on the site. Every accepted submission the team sent itself counts
// when a file of it says when it was taken: the gap runs from the newest
// such file to the moment the submission was sent. A gap under none or
// over a day is a phone clock set wrong or a picture from before the
// day, and is left out. Teams with nothing counted are not in it; hidden
// ones are flagged, as in questsDone.
var DAY_SECONDS = 86400;
function utcMs(stamp: string | null | undefined): number { return Date.parse(String(stamp || '').replace(' ', 'T') + 'Z'); }
export async function submitTimes(db: D1Database): Promise<SubmitTimesTeam[]> {
  var rows = (await db.prepare(
    'SELECT s.team_id, s.submitted_at, MAX(f.taken_at) AS taken FROM submissions s ' +
    'JOIN submission_files f ON f.submission_id = s.id ' +
    "WHERE s.status = 'accepted' AND s.added_by = '' AND f.taken_at IS NOT NULL AND f.taken_at != '' " +
    'GROUP BY s.id'
  ).all<Pick<SubmissionRow, 'team_id' | 'submitted_at'> & { taken: string }>()).results;
  var by: Record<number, { n: number; sum: number; best: number }> = {};
  rows.forEach(function (r) {
    var secs = (utcMs(r.submitted_at) - utcMs(r.taken)) / 1000;
    if (!isFinite(secs) || secs < 0 || secs > DAY_SECONDS) return;
    var t = by[r.team_id] = by[r.team_id] || { n: 0, sum: 0, best: Infinity };
    t.n++;
    t.sum += secs;
    t.best = Math.min(t.best, secs);
  });
  var teams = (await db.prepare('SELECT id, name, hidden FROM teams ORDER BY name COLLATE NOCASE').all<Pick<TeamRow, 'id' | 'name' | 'hidden'>>()).results;
  return teams.filter(function (t) { return by[t.id]; }).map(function (t) {
    var s = by[t.id];
    return { id: t.id, name: t.name, hidden: !!t.hidden, submissions: s.n, average: Math.round(s.sum / s.n), quickest: Math.round(s.best) };
  }).sort(function (a, b) { return a.average - b.average; });
}

// A board the dashboard makes up: every team ranked by one measure on
// one quest, named by its key (or a code in no quest, matched the way
// Review's quest filter matches), or on every quest when none is named.
// `accepted` counts the team's accepted submissions; `points` adds up
// what the quest's codes put on its total. Teams with nothing are left
// out; hidden ones are flagged, as in questsDone.
export async function customBoard(db: D1Database, quest: string | null | undefined, measure: string | null | undefined): Promise<BoardTeam[]> {
  var sql = measure === 'points'
    ? 'SELECT t.id, t.name, t.hidden, ' + SUM_POINTS + ' AS value FROM held c ' +
      'JOIN teams t ON t.id = c.team_id JOIN quests q ON q.code = c.quest_code LEFT JOIN quest_groups g ON g.id = q.group_id ' +
      "WHERE (?1 = '' OR COALESCE(g.key, q.code) = ?1 COLLATE NOCASE) GROUP BY t.id HAVING value != 0"
    : 'SELECT t.id, t.name, t.hidden, COUNT(*) AS value FROM submissions s JOIN teams t ON t.id = s.team_id ' +
      'LEFT JOIN quests q ON q.code = s.quest_code LEFT JOIN quest_groups g ON g.id = q.group_id ' +
      "WHERE s.status = 'accepted' AND (?1 = '' OR COALESCE(g.key, s.quest_code) = ?1 COLLATE NOCASE) GROUP BY t.id";
  var rows = (await db.prepare(sql + ' ORDER BY value DESC, t.name COLLATE NOCASE').bind(String(quest || '')).all<Pick<TeamRow, 'id' | 'name' | 'hidden'> & { value: number }>()).results;
  return rows.map(function (r) { return { id: r.id, name: r.name, hidden: !!r.hidden, value: r.value }; });
}

// The last place on the board: how many teams finished.
export function lastPlace(rows: { rank: number | null }[]): number {
  var last = 0;
  rows.forEach(function (r) { if (r.rank) last = r.rank; });
  return last;
}

// The rows from place `from` to place `to`, with every team that did
// not finish where its points put it: those above 1st when the list
// starts there, and those under the last place when it ends there.
export function placeRows<T extends { rank: number | null }>(rows: T[], from: number, to: number): T[] {
  var last = lastPlace(rows);
  var start = from <= 1 ? 0 : -1;
  var end = to >= last ? rows.length - 1 : -1;
  for (var i = 0; i < rows.length; i++) {
    if (start === -1 && rows[i].rank === from) start = i;
    if (end === -1 && rows[i].rank === to) end = i;
  }
  return start === -1 || end < start ? [] : rows.slice(start, end + 1);
}

// The leaderboard as Discord shows it: a code block of places from..to.
// A team that did not finish has a dash for its place and a * after its
// points, and the line under the block says what the * means.
export function leaderboardText(rows: Standing[], from: number, to: number): string {
  var top = Math.min(to, lastPlace(rows));
  var shown = placeRows(rows, from, top);
  var lines = shown.map(function (r) {
    var name = r.name.length > 26 ? r.name.slice(0, 25) + '…' : r.name;
    var place = r.dnf ? ' -  ' : String(r.rank).padStart(2) + '. ';
    return place + name.padEnd(27) + fmtPts(r.pts).padStart(9) + (r.dnf ? '*' : '');
  });
  var title = from === 1 ? 'Top ' + top : 'Places ' + from + '-' + top;
  var note = shown.some(function (r) { return r.dnf; }) ? '\n\\* Did not finish.' : '';
  return '**' + title + '**\n```\n' + lines.join('\n') + '\n```' + note;
}
