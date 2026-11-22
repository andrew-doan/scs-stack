// What a quest's codes score. Each code of a quest is a part, and each
// part has a scoring type (`quests.scoring`):
//
//   fixed    its points, once ('' in the column)
//   unit     its points for each one counted, up to `most`
//   judged   up to its points: the reviewer gives what it earned
//   tiered   the points of the band the reviewer's number reaches
//            (`bands`, [{from, points}])
//   counted  nothing on its own: each accepted submission adds to the
//            team's count for the quest's challenge (rules.tally), and the
//            band the count reaches and the place it earns are awarded
//            once, at the end
//
// A line on the ledger is worth what its part said when it was written,
// and the tab sums the lines. `buildCredit` is the one reading of what a
// reviewer or an organiser sent against those types, for Accept, Change
// and a quest's desk alike.

import { cleanText, prop } from './shared.ts';
import type { Band, Credit, QuestRow, Scoring } from './types.ts';

// A code of a quest as a part (partOf).
export interface Part {
  code: string;
  label: string;
  points: number;
  hidden: number;
  scoring: Scoring;
  most: number | null;
  bands: Band[];
}

// The quests columns a part is read from.
export type PartRow = Pick<QuestRow, 'code' | 'label' | 'points' | 'hidden' | 'scoring' | 'most' | 'bands'>;

// A code read for its scoring alone; a missing label or hidden reads as
// none.
export type PartIn = Pick<QuestRow, 'code' | 'points'> & Partial<Pick<QuestRow, 'label' | 'hidden' | 'scoring' | 'most' | 'bands'>>;

// What the editor or a file sent for one part, checked (cleanPart).
export interface CleanPart {
  scoring: Scoring;
  most: number | null;
  bands: string;
  points: number;
}

// What a credit gave a code, and what it would have at its full points.
export interface Worth {
  given: number;
  full: number;
}

export var SCORING: Scoring[] = ['', 'unit', 'judged', 'tiered', 'counted'];
export var SCORING_NAMES: Record<Scoring, string> = { '': 'Fixed', unit: 'Per unit', judged: 'Judged', tiered: 'Tiered', counted: 'Counted' };
export var MAX_BANDS = 10;
export var MAX_COUNT = 1000;
export var MAX_NUMBER = 100000;
var MAX_POINTS = 100000;

function round2(n: number): number { return Math.round(n * 100) / 100; }

function isScoring(s: string): s is Scoring {
  return (SCORING as string[]).indexOf(s) !== -1;
}

// A stored scoring type, anything unknown read as fixed.
function scoringOf(raw: unknown): Scoring {
  var s = String(raw || '');
  return isScoring(s) ? s : '';
}

// A part's bands as stored, read back cleaned and in order: the lowest
// `from` first, one band a `from`.
export function bandsOf(raw: unknown): Band[] {
  var list = raw;
  if (typeof list === 'string') {
    if (!list.trim()) return [];
    try { list = JSON.parse(list); } catch (err) { return []; }
  }
  if (!Array.isArray(list)) return [];
  var seen: Record<number, boolean> = {};
  return list.map(function (b) {
    return { from: Number(prop(b, 'from')), points: Number(prop(b, 'points')) };
  }).filter(function (b) {
    if (!isFinite(b.from) || !isFinite(b.points) || seen[b.from]) return false;
    seen[b.from] = true;
    return true;
  }).sort(function (a, b) { return a.from - b.from; }).slice(0, MAX_BANDS);
}

// The points of the highest band `n` reaches, or 0 under the first.
export function bandFor(bands: unknown, n: unknown): number {
  var x = Number(n);
  var out = 0;
  if (!isFinite(x)) return 0;
  bandsOf(bands).forEach(function (b) { if (b.from <= x) out = b.points; });
  return out;
}

// The same in SQL, for a line written in a batch: the band of `numberSql`
// in the bands `bandsSql` holds. `numberSql` is a column or a number the
// caller has made one with Number().
export function bandSql(numberSql: string, bandsSql?: string): string {
  var bands = bandsSql || 'q.bands';
  return "COALESCE((SELECT json_extract(b.value, '$.points') FROM json_each(CASE WHEN json_valid(" + bands + ') THEN ' + bands +
    " ELSE '[]' END) b WHERE json_extract(b.value, '$.from') <= " + numberSql +
    " ORDER BY json_extract(b.value, '$.from') DESC LIMIT 1), 0)";
}

// A quests row as a part.
export function partOf(row: PartRow | PartIn): Part {
  var scoring = scoringOf(row && row.scoring);
  var most = row && row.most != null && isFinite(Number(row.most)) ? Number(row.most) : null;
  return {
    code: row.code, label: row.label || '', points: Number(row.points) || 0, hidden: row.hidden ? 1 : 0,
    scoring: scoring, most: scoring === 'unit' ? most : null,
    bands: scoring === 'tiered' || scoring === 'counted' ? bandsOf(row.bands) : []
  };
}

// What the editor or a file sent for one part, checked: {scoring, most,
// bands, points} or {error}. A tiered part is worth its top band, and a
// counted one its top band and its first place, so the points a page
// shows as the most there is follow the bands; `places` is the quest's
// points by place.
export function cleanPart(r: Record<string, unknown>, places: unknown[] | null | undefined): CleanPart | { error: string } {
  var code = cleanText(r && r.code, 40) || 'This part';
  var asked = String(r && r.scoring || '');
  if (asked === 'fixed') asked = '';
  if (!isScoring(asked)) return { error: code + ' needs a way to score: fixed, per unit, judged, tiered or counted.' };
  var scoring = asked;
  var points = Number(r.points);
  var out: CleanPart = { scoring: scoring, most: null, bands: '', points: points };
  if (scoring === 'unit' && r.most != null && String(r.most).trim() !== '') {
    var most = Number(r.most);
    if (!isFinite(most) || most !== Math.round(most) || most < 1 || most > MAX_COUNT) {
      return { error: code + ' can count up to a whole number from 1 to ' + MAX_COUNT + '.' };
    }
    out.most = most;
  }
  if (scoring === 'tiered' || scoring === 'counted') {
    var raw: unknown = r.bands;
    if (typeof raw === 'string' && raw.trim() && raw.trim()[0] !== '[') raw = bandsFromText(raw);
    if (prop(raw, 'error')) return { error: code + ': ' + prop(raw, 'error') };
    var bands = bandsOf(raw);
    if (Array.isArray(raw) && raw.length > MAX_BANDS) return { error: code + ' has more than ' + MAX_BANDS + ' bands.' };
    if (bands.some(function (b) { return b.from < 0 || b.from > MAX_NUMBER || Math.abs(b.points) > MAX_POINTS; })) {
      return { error: code + '’s bands start from 0 to ' + MAX_NUMBER + ' and are worth at most ' + MAX_POINTS + ' points.' };
    }
    if (scoring === 'tiered' && !bands.length) return { error: code + ' is tiered and needs at least one band.' };
    out.bands = bands.length ? JSON.stringify(bands) : '';
    var top = bands.reduce(function (m, b) { return Math.max(m, b.points); }, 0);
    out.points = scoring === 'counted' ? round2(top + Math.max(0, Number((places || [])[0]) || 0)) : top;
  } else if (!isFinite(points)) {
    return { error: 'Points for ' + code + ' must be a number.' };
  }
  return out;
}

// Bands typed as "10: 100, 15: 175" or one a line, into the stored form.
export function bandsFromText(text: unknown): Band[] | { error: string } {
  var out: Band[] = [];
  var bad = false;
  String(text || '').split(/[\n,;]+/).forEach(function (piece) {
    var t = piece.trim();
    if (!t) return;
    var m = t.match(/^(-?[\d.]+)\s*\+?\s*(?:[:=→>-]+|\s)\s*(-?[\d.]+)$/);
    if (!m) { bad = true; return; }
    out.push({ from: Number(m[1]), points: Number(m[2]) });
  });
  return bad ? { error: 'write each band as the number it starts from and its points, as 10: 100.' } : out;
}

// Every part of these codes, by code.
export async function partsFor(db: D1Database, codes: string[] | null | undefined): Promise<Record<string, Part>> {
  var out: Record<string, Part> = {};
  if (!codes || !codes.length) return out;
  var rows = (await db.prepare(
    'SELECT code, label, points, hidden, scoring, most, bands FROM quests WHERE code IN (SELECT value FROM json_each(?1))'
  ).bind(JSON.stringify(codes)).all<PartRow>()).results;
  rows.forEach(function (r) { out[r.code] = partOf(r); });
  return out;
}

// ---------- what a credit is worth ----------

// A credit (submissions.credit) is {codes, amount}, with `counts` where
// a code was counted apart, `amounts` where one was given part of its
// points, `numbers` the number a tiered part reached and `points` where a
// line's worth was set outright (an adjustment).

// How many times a credit counted one of its codes: its own count where
// the reviewer gave the codes different ones (`counts`, kept only where it
// differs from `amount`), else the amount. That is the code's full
// points; a part mark is measured against it.
export function countFor(credit: Credit | null | undefined, code: string): number {
  var counts = credit && credit.counts;
  if (counts && counts[code] != null && isFinite(Number(counts[code]))) return Number(counts[code]);
  return Number(credit && credit.amount) || 0;
}

// What a credit put on one of its codes: the part of it a reviewer gave
// that code (`amounts`, kept only where it differs), else its count.
export function amountFor(credit: Credit | null | undefined, code: string): number {
  var parts = credit && credit.amounts;
  if (parts && parts[code] != null && isFinite(Number(parts[code]))) return Number(parts[code]);
  return countFor(credit, code);
}

// What one code of a credit is worth, and what it would be at its full
// points; the two differ only for a part mark.
export function codeWorth(part: Part | undefined, credit: Credit, code: string): Worth {
  var set = credit && credit.points;
  if (set && set[code] != null) { var p = round2(Number(set[code]) || 0); return { given: p, full: p }; }
  if (!part) return { given: 0, full: 0 };
  if (part.scoring === 'counted') return { given: 0, full: 0 };
  if (part.scoring === 'tiered') {
    var n = credit && credit.numbers && credit.numbers[code];
    var b = round2(bandFor(part.bands, n) * (countFor(credit, code) < 0 ? -1 : 1));
    return { given: b, full: b };
  }
  return { given: round2(part.points * amountFor(credit, code)), full: round2(part.points * countFor(credit, code)) };
}

export function creditWorth(parts: Record<string, Part>, credit: Credit): Worth {
  var given = 0;
  var full = 0;
  (credit && credit.codes || []).forEach(function (code) {
    var w = codeWorth(parts[code], credit, code);
    given += w.given;
    full += w.full;
  });
  return { given: round2(given), full: round2(full) };
}

// ---------- reading what was sent ----------

function parseMap(raw: unknown, what: string): Record<string, unknown> {
  var v = raw;
  if (typeof v === 'string') {
    if (!v.trim()) return {};
    try { v = JSON.parse(v); } catch (err) { return { error: what }; }
  }
  if (v == null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) return { error: what };
  return v as Record<string, unknown>;
}

function readCount(raw: unknown): number | null {
  var n = raw == null || String(raw).trim() === '' ? 1 : Number(raw);
  if (!isFinite(n) || n <= 0 || n > MAX_COUNT) return null;
  return n;
}

// What Accept, Change or a desk's Record sent, read against each code's
// type: `amount` (the count of a code not named in `counts`), `counts`
// {code: n}, `awarded` {code: points} for judged parts and `numbers`
// {code: n} for tiered ones. A fixed, judged, tiered or counted part is
// credited once; a per-unit part counts up to its most; a judged part is
// given 0 to its points; a tiered part needs its number. Answers
// {credit} or {error}.
export function buildCredit(parts: Record<string, Part>, codes: string[], body: Record<string, unknown>): { credit: Credit } | { error: string } {
  var amount = readCount(body.amount);
  if (amount == null) return { error: 'Amount must be a positive number.' };
  var counts = parseMap(body.counts, 'Counts must be a number for each code.');
  if (counts.error) return { error: counts.error as string };
  var awarded = parseMap(body.awarded, 'Part marks must be points for each code.');
  if (awarded.error) return { error: awarded.error as string };
  var numbers = parseMap(body.numbers, 'Give each tiered code its number.');
  if (numbers.error) return { error: numbers.error as string };
  var named = Object.keys(counts).concat(Object.keys(awarded), Object.keys(numbers));
  for (var k = 0; k < named.length; k++) {
    if (codes.indexOf(named[k]) === -1) return { error: named[k] + ' is not one of the codes being credited.' };
  }
  var credit: Credit = { codes: codes, amount: amount };
  var keptCounts: Record<string, number> = {};
  var keptAmounts: Record<string, number> = {};
  var keptNumbers: Record<string, number> = {};
  for (var i = 0; i < codes.length; i++) {
    var code = codes[i];
    var part: Pick<Part, 'scoring' | 'points'> & { most?: number | null } = parts[code] || { scoring: '', points: 0 };
    var n: number | null = counts[code] != null ? readCount(counts[code]) : amount;
    if (n == null) return { error: 'Give ' + code + ' a count above 0 and at most ' + MAX_COUNT + '.' };
    if (part.scoring === 'unit') {
      if (part.most != null && n > part.most) return { error: code + ' counts up to ' + part.most + '.' };
    } else if (n !== 1) {
      return { error: code + ' is credited once. Make it per unit in the quest editor to count it.' };
    }
    if (n !== amount) keptCounts[code] = n;
    if (part.scoring === 'tiered') {
      var raw = numbers[code];
      var num = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
      if (!isFinite(num) || num < 0 || num > MAX_NUMBER) return { error: 'Give ' + code + ' the number it reached, from 0 to ' + MAX_NUMBER + '.' };
      keptNumbers[code] = num;
    }
    if (awarded[code] != null && String(awarded[code]).trim() !== '') {
      var given = round2(Number(awarded[code]));
      var full = round2(part.points * n);
      if (!isFinite(given)) return { error: 'Give ' + code + ' its points as a number.' };
      if (given === full) continue;
      if (part.scoring !== 'judged') return { error: code + ' takes its full points. Make it judged in the quest editor to give part of them.' };
      if (given < Math.min(0, full) || given > Math.max(0, full)) {
        return { error: code + ' can be given ' + (full < 0 ? 'from 0 down to ' : 'from 0 to ') + full + ' points.' };
      }
      // a code worth 0 has nothing to give part of, and its full mark is
      // the only one in range
      keptAmounts[code] = given / part.points;
    }
  }
  if (Object.keys(keptCounts).length) credit.counts = keptCounts;
  if (Object.keys(keptAmounts).length) credit.amounts = keptAmounts;
  if (Object.keys(keptNumbers).length) credit.numbers = keptNumbers;
  return { credit: credit };
}

// A credit the other way round, for telling a team what came off.
export function negated(credit: Credit): Credit {
  var flip = function (m: Record<string, number> | null | undefined) {
    if (!m) return m;
    var out: Record<string, number> = {};
    Object.keys(m).forEach(function (k) { out[k] = -Number(m[k]); });
    return out;
  };
  return { codes: credit.codes, amount: -Number(credit.amount), counts: flip(credit.counts), amounts: flip(credit.amounts),
    numbers: credit.numbers, points: flip(credit.points) };
}

// The credit as stored on the submission.
export function creditJson(credit: Credit): string {
  var out: Credit = { codes: credit.codes, amount: credit.amount };
  (['counts', 'amounts', 'numbers', 'points'] as const).forEach(function (k) {
    var m = credit[k];
    if (m && Object.keys(m).length) out[k] = m;
  });
  return JSON.stringify(out);
}
