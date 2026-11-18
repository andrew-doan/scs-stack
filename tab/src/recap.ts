// After the event: a page for each team (the quests it did, linked
// from the leaderboard), a recap of the whole day (submissions by
// hour, when each quest was done, the rest of the numbers) and the
// replay of the routes teams recorded. Each is behind a switch the
// dashboard flips, since the tab is a race while the day runs and none
// should give anything away before the organisers say so. Off, the
// reads answer 404 and the site shows nothing to tap.
import { json, corsJson, cleanText, cleanBody, readStamp, prop, fields } from './shared.ts';
import { standings, lastPlace, SUM_POINTS, showsPoints, customBoard, questsDone, submitTimes, notQuest, bandsScore } from './tab.ts';
import { challengeCounts } from './tally.ts';
import { mysteryIds, parseCoords } from './quests.ts';
import { filePath } from './drop.ts';
import { routeStamps, routeFor } from './tracks.ts';
import { placeFor, cleanPins, chosenCodes, km } from './team-map.ts';
import { metaBlock } from './photoserve.ts';
import { readExif } from './strip.ts';
import { photoVisits, viewedQuests, questViews, forgetNear, VIEWS } from './visits.ts';
import type { View } from './visits.ts';
import type { ConsoleSession, DateRule, DropFileRow, Env, JsonBody, LogAction, QuestGroupRow, SiteFlagRow, SiteTextRow, TeamArrivalRow, TeamCheckinRow, TeamRow } from './types.ts';

// The hours the charts cover, and what happens to an hour outside them.
interface HourWindow {
  from: string;
  to: string;
  mode: string;
}
// A time frame, either end '' for open.
interface Frame {
  from: string;
  to: string;
}
// Submissions sent and accepted in one hour or minute.
type Sent = { sent: number; accepted: number };
type StepRow = { hour: string; sent: number; accepted: number };
// A leaderboard made on the Ranks tab.
interface Board {
  title: string;
  quest: string;
  measure: string;
  recap: boolean;
}
// A section of the recap the organisers write.
interface Section {
  title: string;
  text: string;
  items: { title: string; text: string; media: { key: string; alt: string }[] }[];
}
// One quest's day, as the recap counts it.
interface GroupDay {
  key: string;
  name: string;
  region: string;
  done_by: number;
  completions: number;
  hours: Record<string, number>;
  source: string;
  peak_hour: string;
  peak_count: number;
  points: number;
}
// The whole day's numbers (recapPayload), which the dashboard also
// reads with whether the site shows them.
type RecapOut = NonNullable<Awaited<ReturnType<typeof recapPayload>>>;
type Totals = { sent: number; accepted: number; rejected: number; pending: number; first_at: string | null; last_at: string | null };
type Span = { first_at: string | null; last_at: string | null };

var NO_STORE = { 'cache-control': 'no-store' };
// push_off is the other way round: on, no push notification goes out
export var FLAGS = ['team_pages', 'recap', 'replay', 'push_off'];

// ---------- the switches ----------

export async function flagValues(db: D1Database): Promise<Record<string, boolean>> {
  var out: Record<string, boolean> = { team_pages: false, recap: false, replay: false, push_off: false };
  try {
    var rows = await db.prepare('SELECT name, value FROM site_flags').all<Pick<SiteFlagRow, 'name' | 'value'>>();
    rows.results.forEach(function (r) {
      if (FLAGS.indexOf(r.name) !== -1) out[r.name] = !!r.value;
    });
  } catch (err) { /* a read that fails leaves everything off */ }
  return out;
}

// Whether the after-the-event pages answer nothing whatever their
// switches say: while the tab is closed or frozen, since they read the
// live tables and would show past the freeze.
export async function afterPagesShut(db: D1Database): Promise<boolean> {
  // the two switches alone: the frozen copy beside them is three payloads
  // nobody reads here
  var row = await db.prepare('SELECT frozen, closed FROM tab_freeze WHERE id = 1').first<{ frozen: number; closed: number }>();
  return !!(row && (row.frozen || row.closed));
}

export async function flagsRead(env: Env): Promise<Response> {
  return json({ ok: true, flags: await flagValues(env.DB) });
}

// GET /api/console/recap: the recap's numbers for organisers, with
// whether the site shows them
export async function recapConsole(env: Env): Promise<Response> {
  // the dashboard's read always answers
  var d = await recapPayload(env.DB, { always: true }) as RecapOut & { public?: boolean };
  d.public = (await flagValues(env.DB)).recap;
  return json(d, 200, NO_STORE);
}

export async function flagSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var name = String(body.name || '');
  if (FLAGS.indexOf(name) === -1) return json({ error: 'The switch must be team_pages, recap, replay or push_off.' }, 400);
  var on = body.value === true || body.value === 1 || body.value === '1';
  await env.DB.prepare(
    'INSERT INTO site_flags (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = ?2'
  ).bind(name, on ? 1 : 0).run();
  await logAction(env.DB, session.name, 'flag-set', name + ' = ' + (on ? 'on' : 'off'), '-', 0, 0, 0);
  return json({ ok: true, flags: await flagValues(env.DB) });
}

// ---------- what the after-the-event reads leave out ----------
// Four settings, rows of site_text: the hours the charts cover
// ('recap_hours', JSON {from, to, mode}, UTC hours, either end '' for
// open), the time frame the review times count in ('recap_review', JSON
// {from, to}: a submission counts when it was sent and decided inside
// it), the time frame a quest's time shows in on a team's page
// ('team_times', JSON {from, to}) and the time after which nothing
// counts as a team's last scored quest on the leaderboard
// ('last_quest_until'). The tab team records
// entries before and after the day: real scores, but not the day's shape.
// An hour outside the window is added to the nearest hour inside it
// (merge) or left off the charts (hide). Totals are not changed.

async function textSetting(db: D1Database, name: string): Promise<string> {
  try {
    var row = await db.prepare('SELECT value FROM site_text WHERE name = ?1').bind(name).first<Pick<SiteTextRow, 'value'>>();
    return (row && row.value) || '';
  } catch (err) { return ''; }
}
// '' takes the setting away
async function writeTextSetting(db: D1Database, name: string, value: string): Promise<void> {
  if (value) {
    await db.prepare('INSERT INTO site_text (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = excluded.value')
      .bind(name, value).run();
  } else {
    await db.prepare('DELETE FROM site_text WHERE name = ?1').bind(name).run();
  }
}
// a typed time as its hour, '' for nothing and null for a time that
// cannot be read
function hourStamp(v: unknown): string | null {
  var t = readStamp(v);
  if (t === null) return null;
  return t ? t.slice(0, 13) + ':00' : '';
}

export async function hourWindow(db: D1Database): Promise<HourWindow | null> {
  var raw = await textSetting(db, 'recap_hours');
  if (!raw) return null;
  var w: unknown;
  try { w = JSON.parse(raw); } catch (err) { return null; }
  var from = hourStamp(prop(w, 'from')) || '';
  var to = hourStamp(prop(w, 'to')) || '';
  if (!from && !to) return null;
  return { from: from, to: to, mode: prop(w, 'mode') === 'hide' ? 'hide' : 'merge' };
}

// where an hour goes on the charts: itself, the nearest hour of the
// window, or nowhere ('')
function placeHour(h: string, win: HourWindow | null): string {
  if (!win || !h) return h;
  if (win.from && h < win.from) return win.mode === 'hide' ? '' : win.from;
  if (win.to && h > win.to) return win.mode === 'hide' ? '' : win.to;
  return h;
}
function addHour(counts: Record<string, Sent>, h: string, row: Sent, win: HourWindow | null): void {
  var at = placeHour(h, win);
  if (!at) return;
  var c = counts[at] || (counts[at] = { sent: 0, accepted: 0 });
  c.sent += row.sent;
  c.accepted += row.accepted;
}
// the window as two stamps for a WHERE: its first second, and the start
// of the hour after its last
function windowBounds(win: HourWindow): [string, string] {
  var hi = '9999-12-31 23:59:59';
  if (win.to) hi = new Date(new Date(win.to.replace(' ', 'T') + ':00Z').getTime() + 3600000).toISOString().replace('T', ' ').slice(0, 19);
  return [win.from ? win.from + ':00' : '0000-01-01 00:00:00', hi];
}

// a {from, to} row of stamps, null when neither end is set
async function stampWindow(db: D1Database, name: string): Promise<Frame | null> {
  var raw = await textSetting(db, name);
  if (!raw) return null;
  var w: unknown;
  try { w = JSON.parse(raw); } catch (err) { return null; }
  var from = readStamp(prop(w, 'from')) || '';
  var to = readStamp(prop(w, 'to')) || '';
  return from || to ? { from: from, to: to } : null;
}
export async function reviewWindow(db: D1Database): Promise<Frame | null> { return stampWindow(db, 'recap_review'); }
// the time frame a quest's time shows in on a team's page ('team_times');
// a time outside it is left off, the quest and its points stay
export async function timesWindow(db: D1Database): Promise<Frame | null> { return stampWindow(db, 'team_times'); }
function insideWindow(stamp: unknown, w: Frame | null): boolean {
  if (!w) return true;
  var t = String(stamp || '').replace('T', ' ').slice(0, 19);
  return !(w.from && t < w.from) && !(w.to && t > w.to);
}

// the quests left out of the recap's Most done side quests
// ('recap_most_skip', a JSON list of quest keys)
export async function mostSkip(db: D1Database): Promise<string[]> {
  var v: unknown;
  try { v = JSON.parse((await textSetting(db, 'recap_most_skip')) || '[]'); } catch (err) { v = []; }
  return Array.isArray(v) ? v.map(function (k) { return String(k); }) : [];
}
// the time frame the recap's Arrivals count check-ins in ('recap_arrivals')
export async function arrivalsWindow(db: D1Database): Promise<Frame | null> { return stampWindow(db, 'recap_arrivals'); }

// ---------- leaderboards made on the Ranks tab ----------
// Kept on the worker ('rank_boards', a JSON list of {title, quest,
// measure, recap}) so every organiser sees the same boards, and the
// recap shows the ones with `recap` on. A quest is a group key or a code
// in no quest, '' for every quest; the measure is accepted submissions,
// points, or a challenge's own count (stations visited, say).
export var BOARD_MEASURES = ['accepted', 'points', 'count'];
var MAX_BOARDS = 12;
function cleanBoards(list: unknown): Board[] | null {
  if (!Array.isArray(list)) return null;
  var out: Board[] = [];
  for (var i = 0; i < list.length && out.length < MAX_BOARDS; i++) {
    var b = fields(list[i]);
    out.push({
      title: cleanText(b.title, 60),
      quest: cleanText(b.quest, 40),
      measure: (BOARD_MEASURES as unknown[]).indexOf(b.measure) >= 0 ? b.measure as string : 'accepted',
      recap: !!b.recap
    });
  }
  return out;
}
export async function rankBoards(db: D1Database): Promise<Board[]> {
  var v: unknown;
  try { v = JSON.parse((await textSetting(db, 'rank_boards')) || '[]'); } catch (err) { v = []; }
  return cleanBoards(v) || [];
}
// every team a board ranks, highest first; null when the measure is a
// challenge's count and the quest is not a challenge
export async function boardTeams(db: D1Database, quest: string, measure: string | null): Promise<{ name: string; hidden: boolean; value: number }[] | null> {
  if (measure === 'count') return challengeCounts(db, quest);
  return customBoard(db, quest, measure === 'points' ? 'points' : 'accepted');
}
// POST /api/console/ranks/boards {boards}: the whole list, in order
export async function rankBoardsSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var boards = cleanBoards(body.boards);
  if (!boards) return json({ error: 'The boards have to arrive as a list.' }, 400);
  await writeTextSetting(env.DB, 'rank_boards', boards.length ? JSON.stringify(boards) : '');
  var shown = boards.filter(function (b) { return b.recap; }).length;
  await logAction(env.DB, session.name, 'rank-boards', boards.length + (boards.length === 1 ? ' board' : ' boards') + ', ' + shown + ' on the recap', '-', 0, 0, 0);
  return json({ ok: true, boards: boards });
}

// The Ranks tab's own two boards on the recap ('rank_recap', JSON
// {quests_done, submit_times}): Quests done, and Photo to submission as
// the three fastest and the three slowest teams
export async function rankRecap(db: D1Database): Promise<{ quests_done: boolean; submit_times: boolean }> {
  var v: unknown;
  try { v = JSON.parse((await textSetting(db, 'rank_recap')) || '{}'); } catch (err) { v = {}; }
  return { quests_done: !!prop(v, 'quests_done'), submit_times: !!prop(v, 'submit_times') };
}
// POST /api/console/ranks/recap {quests_done, submit_times}
export async function rankRecapSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var v = { quests_done: !!body.quests_done, submit_times: !!body.submit_times };
  await writeTextSetting(env.DB, 'rank_recap', v.quests_done || v.submit_times ? JSON.stringify(v) : '');
  var on = [v.quests_done ? 'Quests done' : '', v.submit_times ? 'Photo to submission' : ''].filter(Boolean);
  await logAction(env.DB, session.name, 'rank-recap', on.length ? on.join(' and ') + ' on the recap' : 'Neither on the recap', '-', 0, 0, 0);
  return json({ ok: true, builtin: v });
}
// the first `n` places of a ranked list, level teams sharing a place
function topPlaces<T extends { name: string }>(list: T[], valueOf: (t: T) => unknown, n: number): { place: number; name: string; value: number }[] {
  var place = 0;
  var last: unknown = null;
  var top: { place: number; name: string; value: number }[] = [];
  list.forEach(function (t, i) {
    var v = valueOf(t);
    if (v !== last) { place = i + 1; last = v; }
    if (place <= n) top.push({ place: place, name: t.name, value: round2(Number(v)) });
  });
  return top;
}

// ---------- sections the organisers write ----------
// Kept as 'recap_sections' in site_text: a list of {title, text, items:
// [{title, text, media: [{key, alt}]}]}, the way SCS.1's recap had a
// section for each competition with its winners and their photos. A
// file is one on the Files tab (the drop), named by key; the recap reads
// each with its address and type, and leaves out one since deleted.
var MAX_SECTIONS = 12;
var MAX_ITEMS = 20;
var MAX_MEDIA = 6;
function cleanSections(list: unknown): Section[] | null {
  if (!Array.isArray(list)) return null;
  return list.slice(0, MAX_SECTIONS).map(function (one) {
    var sec = fields(one);
    return {
      title: cleanText(sec.title, 80),
      text: cleanBody(sec.text, 2000),
      items: (Array.isArray(sec.items) ? sec.items : []).slice(0, MAX_ITEMS).map(function (entry) {
        var it = fields(entry);
        return {
          title: cleanText(it.title, 120),
          text: cleanBody(it.text, 1000),
          media: (Array.isArray(it.media) ? it.media : []).slice(0, MAX_MEDIA).map(function (m) {
            return { key: String(prop(m, 'key') || '').slice(0, 80), alt: cleanText(prop(m, 'alt'), 200) };
          }).filter(function (m) { return m.key.indexOf('drop/') === 0; })
        };
      }).filter(function (it) { return it.title || it.text || it.media.length; })
    };
  }).filter(function (sec) { return sec.title || sec.text || sec.items.length; });
}
export async function recapSections(db: D1Database): Promise<Section[]> {
  var v: unknown;
  try { v = JSON.parse((await textSetting(db, 'recap_sections')) || '[]'); } catch (err) { v = []; }
  return cleanSections(v) || [];
}
// the pictures and videos on the Files tab, for the editor's picker and
// to read a section's files by
async function dropMedia(db: D1Database): Promise<Pick<DropFileRow, 'key' | 'name' | 'type'>[]> {
  return (await db.prepare(
    "SELECT key, name, type FROM drop_files WHERE type LIKE 'image/%' OR type LIKE 'video/%' ORDER BY id DESC LIMIT 500"
  ).all<Pick<DropFileRow, 'key' | 'name' | 'type'>>()).results;
}
// the sections as the page draws them: each file with its address and
// type, a file no longer on the Files tab left out
async function sectionsOut(db: D1Database) {
  var sections = await recapSections(db);
  if (!sections.length) return [];
  var byKey: Record<string, Pick<DropFileRow, 'key' | 'name' | 'type'>> = {};
  (await dropMedia(db)).forEach(function (f) { byKey[f.key] = f; });
  return sections.map(function (sec) {
    return {
      title: sec.title,
      text: sec.text,
      items: sec.items.map(function (it) {
        return {
          title: it.title,
          text: it.text,
          media: it.media.filter(function (m) { return byKey[m.key]; }).map(function (m) {
            var f = byKey[m.key];
            return { url: filePath(f.key, f.name), type: f.type, alt: m.alt || it.title || sec.title };
          })
        };
      })
    };
  });
}
// GET /api/console/recap/sections: the sections and the files to pick from
export async function recapSectionsRead(env: Env): Promise<Response> {
  return json({
    ok: true,
    sections: await recapSections(env.DB),
    files: (await dropMedia(env.DB)).map(function (f) {
      return { key: f.key, name: f.name, type: f.type, url: filePath(f.key, f.name) };
    }),
    api: String(env.PUBLIC_API || '').replace(/\/+$/, '')
  });
}
// POST /api/console/recap/sections {sections}: the whole list, in order
export async function recapSectionsSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var sections = cleanSections(body.sections);
  if (!sections) return json({ error: 'The sections have to arrive as a list.' }, 400);
  await writeTextSetting(env.DB, 'recap_sections', sections.length ? JSON.stringify(sections) : '');
  var items = sections.reduce(function (n, sec) { return n + sec.items.length; }, 0);
  await logAction(env.DB, session.name, 'recap-sections', sections.length + (sections.length === 1 ? ' section' : ' sections') + ', ' + items + (items === 1 ? ' entry' : ' entries'), '-', 0, 0, 0);
  return json({ ok: true, sections: sections });
}

// ---------- which days print without their date ----------
// 'date_rules' in site_text: [{kind: 'on' | 'from' | 'until', date:
// 'YYYY-MM-DD'}], any one of them enough. A one-day event needs no date
// beside every time; the pulse carries them and the site's time
// formatter reads them, and the tab's own public reads leave the date
// out of every stamp they match (undated, below).
var DATE_KINDS = ['on', 'from', 'until'];
function cleanDateRules(list: unknown): DateRule[] | null {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 12).map(function (r) {
    var date = String(prop(r, 'date') || '').trim().slice(0, 10);
    var kind = prop(r, 'kind');
    return { kind: (DATE_KINDS as unknown[]).indexOf(kind) >= 0 ? kind as string : 'on', date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '' };
  }).filter(function (r) { return r.date; });
}
export async function dateRules(db: D1Database): Promise<DateRule[]> {
  var v: unknown;
  try { v = JSON.parse((await textSetting(db, 'date_rules')) || '[]'); } catch (err) { v = []; }
  return cleanDateRules(v) || [];
}
// POST /api/console/recap/dates {rules}: the whole list
export async function dateRulesSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var rules = cleanDateRules(body.rules);
  if (!rules) return json({ error: 'The rules have to arrive as a list.' }, 400);
  await writeTextSetting(env.DB, 'date_rules', rules.length ? JSON.stringify(rules) : '');
  await logAction(env.DB, session.name, 'date-rules', rules.map(function (r) { return r.kind + ' ' + r.date; }).join(', ') || 'none', '-', 0, 0, 0);
  return json({ ok: true, rules: rules });
}

// A stamp on a day the rules match goes out as 'HH:MM' on the event's
// own clock, with no date in it at all. The page can no longer move a
// time without its date into the reader's zone, so it is given in
// Sydney's, which is where the day is.
var EVENT_ZONE = 'Australia/Sydney';
export function dateHider(rules: DateRule[]): (stamp: unknown) => unknown {
  if (!rules || !rules.length) return function (stamp) { return stamp; };
  var clock = new Intl.DateTimeFormat('en-CA', {
    timeZone: EVENT_ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
  });
  return function (stamp) {
    var m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(typeof stamp === 'string' ? stamp : '');
    if (!m) return stamp;
    var at = new Date(m[1] + 'T' + m[2] + ':' + m[3] + ':00Z');
    if (isNaN(at.getTime())) return stamp;
    var p: Record<string, string> = {};
    clock.formatToParts(at).forEach(function (x) { p[x.type] = x.value; });
    var day = p.year + '-' + p.month + '-' + p.day;
    var ruled = rules.some(function (r) {
      return r.kind === 'on' ? day === r.date : r.kind === 'from' ? day >= r.date : day <= r.date;
    });
    return ruled ? ('0' + (Number(p.hour) % 24)).slice(-2) + ':' + p.minute : stamp;
  };
}
// Every stamp in a public answer, wherever it sits: the keys the tab's
// reads give a time under. A copy, so a frozen snapshot is never changed.
var STAMP_KEYS = ['at', 'first_at', 'last_at', 'checked_in_at', 'frozen_at', 'hour', 'peak_hour'];
export async function undated(db: D1Database, body: unknown): Promise<unknown> {
  if (!body || typeof body !== 'object') return body;
  return undatedBy(await dateRules(db), body);
}
export function undatedBy(rules: DateRule[], body: unknown): unknown {
  if (!body || typeof body !== 'object' || !rules.length) return body;
  var hide = dateHider(rules);
  function walk(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(walk);
    if (!v || typeof v !== 'object') return v;
    var o = v as Record<string, unknown>;
    var out: Record<string, unknown> = {};
    Object.keys(o).forEach(function (k) {
      out[k] = STAMP_KEYS.indexOf(k) !== -1 && typeof o[k] === 'string' ? hide(o[k]) : walk(o[k]);
    });
    return out;
  }
  return walk(body);
}

export async function lastQuestUntil(db: D1Database): Promise<string> {
  return readStamp(await textSetting(db, 'last_quest_until')) || '';
}

// GET /api/console/recap/hours: both settings, with the first and last
// time anything was sent, for the form
export async function afterSettings(env: Env): Promise<Response> {
  var win = await hourWindow(env.DB);
  var seen = await env.DB.prepare(
    'SELECT MIN(s.submitted_at) AS first, MAX(s.submitted_at) AS last FROM submissions s JOIN teams t ON t.id = s.team_id WHERE t.hidden = 0'
  ).first<{ first: string | null; last: string | null }>();
  return json({
    ok: true,
    hours: win || { from: '', to: '', mode: 'merge' },
    review: (await reviewWindow(env.DB)) || { from: '', to: '' },
    times: (await timesWindow(env.DB)) || { from: '', to: '' },
    arrivals: (await arrivalsWindow(env.DB)) || { from: '', to: '' },
    most_skip: await mostSkip(env.DB),
    quest_views: await questViews(env.DB),
    date_rules: await dateRules(env.DB),
    seen: { first: (seen && seen.first) || '', last: (seen && seen.last) || '' },
    last_until: await lastQuestUntil(env.DB)
  }, 200, NO_STORE);
}

// POST /api/console/recap/hours {from, to, mode}: both blank charts
// every hour
export async function recapHoursSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var from = hourStamp(body.from);
  var to = hourStamp(body.to);
  if (from === null || to === null) return json({ error: 'That time could not be read.' }, 400);
  if (from && to && from > to) return json({ error: 'The first hour has to come before the last.' }, 400);
  var mode = body.mode === 'hide' ? 'hide' : 'merge';
  var value = from || to ? JSON.stringify({ from: from, to: to, mode: mode }) : '';
  await writeTextSetting(env.DB, 'recap_hours', value);
  await logAction(env.DB, session.name, 'recap-hours', value ? (from || 'start') + ' to ' + (to || 'end') : 'every hour', value ? mode : '-', 0, 0, 0);
  return afterSettings(env);
}

// POST /api/console/recap/review {from, to}: both blank counts every
// decision
export async function recapReviewSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var from = readStamp(body.from);
  var to = readStamp(body.to);
  if (from === null || to === null) return json({ error: 'That time could not be read.' }, 400);
  if (from && to && from > to) return json({ error: 'The start has to come before the end.' }, 400);
  var value = from || to ? JSON.stringify({ from: from, to: to }) : '';
  await writeTextSetting(env.DB, 'recap_review', value);
  await logAction(env.DB, session.name, 'recap-review', value ? (from || 'start') + ' to ' + (to || 'end') : 'every decision', '-', 0, 0, 0);
  return afterSettings(env);
}

// POST /api/console/recap/times {from, to}: both blank shows every time
export async function teamTimesSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var from = readStamp(body.from);
  var to = readStamp(body.to);
  if (from === null || to === null) return json({ error: 'That time could not be read.' }, 400);
  if (from && to && from > to) return json({ error: 'The start has to come before the end.' }, 400);
  var value = from || to ? JSON.stringify({ from: from, to: to }) : '';
  await writeTextSetting(env.DB, 'team_times', value);
  await logAction(env.DB, session.name, 'team-times', value ? (from || 'start') + ' to ' + (to || 'end') : 'every time', '-', 0, 0, 0);
  return afterSettings(env);
}

// POST /api/console/recap/arrivals {from, to}: both blank counts every
// check-in
export async function arrivalsSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var from = readStamp(body.from);
  var to = readStamp(body.to);
  if (from === null || to === null) return json({ error: 'That time could not be read.' }, 400);
  if (from && to && from > to) return json({ error: 'The start has to come before the end.' }, 400);
  var value = from || to ? JSON.stringify({ from: from, to: to }) : '';
  await writeTextSetting(env.DB, 'recap_arrivals', value);
  await logAction(env.DB, session.name, 'recap-arrivals', value ? (from || 'start') + ' to ' + (to || 'end') : 'every check-in', '-', 0, 0, 0);
  return afterSettings(env);
}

// POST /api/console/recap/most-skip {keys}: the quests Most done leaves out
export async function mostSkipSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  if (!Array.isArray(body.keys)) return json({ error: 'The quests have to arrive as a list.' }, 400);
  var seen: Record<string, boolean> = {};
  var keys: string[] = [];
  body.keys.forEach(function (k) {
    var key = cleanText(k, 40);
    if (key && !seen[key.toLowerCase()] && keys.length < 200) { seen[key.toLowerCase()] = true; keys.push(key); }
  });
  await writeTextSetting(env.DB, 'recap_most_skip', keys.length ? JSON.stringify(keys) : '');
  await logAction(env.DB, session.name, 'recap-most-skip', keys.length ? keys.join(', ') : 'none', '-', 0, 0, 0);
  return afterSettings(env);
}

// POST /api/console/recap/views {key, view}: how a quest's page and the
// replay show it (visits.ts); 'sent', or nothing, is the way every quest
// shows unless set. A changed setting reads the quest's photos again.
export async function questViewSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var g = await env.DB.prepare('SELECT id, key FROM quest_groups WHERE key = ?1 COLLATE NOCASE')
    .bind(cleanText(body.key, 40)).first<Pick<QuestGroupRow, 'id' | 'key'>>();
  if (!g) return json({ error: 'There is no quest with that key.' }, 404);
  var view = String(body.view || 'sent');
  if (view !== 'sent' && VIEWS.indexOf(view as View) === -1) return json({ error: 'That is not a way to show a quest.' }, 400);
  var key = g.key;
  var views = await questViews(env.DB);
  Object.keys(views).forEach(function (k) { if (k.toLowerCase() === key.toLowerCase()) delete views[k]; });
  if (view !== 'sent') views[g.key] = view as View;
  await writeTextSetting(env.DB, 'recap_quest_views', Object.keys(views).length ? JSON.stringify(views) : '');
  await forgetNear(env.DB, g.id);
  await logAction(env.DB, session.name, 'recap-view', g.key, view, 0, 0, 0);
  return afterSettings(env);
}

// POST /api/console/tab/last-until {until}: blank shows the newest
export async function lastUntilSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var until = readStamp(body.until);
  if (until === null) return json({ error: 'That time could not be read.' }, 400);
  await writeTextSetting(env.DB, 'last_quest_until', until);
  await logAction(env.DB, session.name, 'last-until', until || 'none', '-', 0, 0, 0);
  return afterSettings(env);
}

// ---------- shared pieces ----------

function round2(n: number): number { return Math.round(n * 100) / 100; }
function hourOf(stamp: unknown): string { return String(stamp || '').replace('T', ' ').slice(0, 13) + ':00'; }

// every hour from the first to the last, zero-filled, so a chart has
// no gaps; capped so a stray old row cannot ask for a year of bars
function fillHours(counts: Record<string, Record<string, number>>, keys: string[], cap: number): Record<string, unknown>[] {
  var hours = Object.keys(counts).sort();
  if (!hours.length) return [];
  var start = new Date(hours[0].replace(' ', 'T') + ':00Z').getTime();
  var end = new Date(hours[hours.length - 1].replace(' ', 'T') + ':00Z').getTime();
  if (!isFinite(start) || !isFinite(end)) return [];
  var n = Math.floor((end - start) / 3600000) + 1;
  if (n > cap) {
    // too spread out to fill: the hours that have something, as they are
    return hours.map(function (h) { return Object.assign({ hour: h }, counts[h]); });
  }
  var out: Record<string, unknown>[] = [];
  for (var i = 0; i < n; i++) {
    var d = new Date(start + i * 3600000);
    var h = d.toISOString().slice(0, 13).replace('T', ' ') + ':00';
    var row: Record<string, unknown> = { hour: h };
    keys.forEach(function (k) { row[k] = (counts[h] && counts[h][k]) || 0; });
    out.push(row);
  }
  return out;
}

// where a minute goes on the charts, by the hours window: itself, the
// window's first or last minute, or nowhere ('')
function placeMinute(m: string, win: HourWindow | null): string {
  if (!win || !m) return m;
  var h = m.slice(0, 13) + ':00';
  if (win.from && h < win.from) return win.mode === 'hide' ? '' : win.from;
  if (win.to && h > win.to) return win.mode === 'hide' ? '' : win.to.slice(0, 14) + '59';
  return m;
}
// minute counts gathered into steps of `step` minutes, every step from
// the first to the last zero-filled while they span a day at most (past
// that, the steps that have something), and the busiest step; each row's
// `hour` is the step's first minute
function stepRows(minutes: Record<string, Sent>, step: number): { rows: StepRow[]; busiest: StepRow | null } {
  var size = step * 60000;
  var byStep: Record<number, Sent> = {};
  Object.keys(minutes).forEach(function (m) {
    var t = new Date(m.replace(' ', 'T') + ':00Z').getTime();
    if (!isFinite(t)) return;
    var at = Math.floor(t / size) * size;
    var c = byStep[at] || (byStep[at] = { sent: 0, accepted: 0 });
    c.sent += minutes[m].sent;
    c.accepted += minutes[m].accepted;
  });
  var keys = Object.keys(byStep).map(Number).sort(function (a, b) { return a - b; });
  if (!keys.length) return { rows: [], busiest: null };
  var stamp = function (t: number) { return new Date(t).toISOString().slice(0, 16).replace('T', ' '); };
  var n = (keys[keys.length - 1] - keys[0]) / size + 1;
  var rows: StepRow[] = [];
  if (n > Math.ceil(24 * 60 / step)) {
    keys.forEach(function (t) { rows.push({ hour: stamp(t), sent: byStep[t].sent, accepted: byStep[t].accepted }); });
  } else {
    for (var i = 0; i < n; i++) {
      var t = keys[0] + i * size;
      var c = byStep[t];
      rows.push({ hour: stamp(t), sent: c ? c.sent : 0, accepted: c ? c.accepted : 0 });
    }
  }
  var busiest = null as StepRow | null;
  rows.forEach(function (r) { if (!busiest || r.sent > busiest.sent) busiest = r; });
  return { rows: rows, busiest: busiest };
}

function median(nums: number[]): number | null {
  if (!nums.length) return null;
  var s = nums.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------- one team ----------

// The team by its id, which a rename does not change (the live tab links
// with it), else by its name in any case, which older links carry.
export async function teamPage(db: D1Database, name: unknown, id?: unknown) {
  var flags = await flagValues(db);
  if (!flags.team_pages) return null;
  var teamId = Math.round(Number(id));
  var team = teamId > 0
    ? await db.prepare('SELECT id, name FROM teams WHERE id = ?1 AND hidden = 0').bind(teamId).first<Pick<TeamRow, 'id' | 'name'>>()
    : null;
  var wanted = cleanText(name, 120);
  if (!team && wanted) {
    team = await db.prepare('SELECT id, name FROM teams WHERE name = ?1 COLLATE NOCASE AND hidden = 0')
      .bind(wanted).first<Pick<TeamRow, 'id' | 'name'>>();
  }
  if (!team) return null;

  var rows = await standings(db);
  var rank: number | null = null;
  var dnf = false;
  var total = 0;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === team.id) { rank = rows[i].rank; dnf = rows[i].dnf; total = rows[i].pts; break; }
  }

  var entries = (await db.prepare(
    'SELECT c.quest_code AS code, c.amount, c.points AS worth, c.updated_at, q.points, q.scoring, q.label, q.group_id, ' +
    'g.key AS group_key, g.name AS name, g.region AS region ' +
    'FROM held c JOIN quests q ON q.code = c.quest_code ' +
    'LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    'WHERE c.team_id = ?1 AND (c.amount > 0 OR c.points > 0) ORDER BY c.updated_at'
  ).bind(team.id).all<{ code: string; amount: number; worth: number; updated_at: string; points: number; scoring: string; label: string;
    group_id: number | null; group_key: string | null; name: string | null; region: string | null }>()).results;
  var mystery = await mysteryIds(db);
  var times = await timesWindow(db);
  var lines = entries.map(function (r) {
    var eoi = notQuest(r.code);
    // a part mark on a mystery quest says what it was worth and no more,
    // and a tiered or counted code says only what it came to
    var shown = showsPoints(mystery[String(r.group_id)], r.amount) && !bandsScore(r.scoring);
    return {
      code: r.code,
      group_key: r.group_key || r.code,
      name: eoi ? r.label : (r.name || r.code),
      label: eoi ? '' : (r.label || ''),
      region: eoi ? 'Non-Quest Tasks' : (r.region || ''),
      award: eoi,
      amount: shown ? r.amount : null,
      points: shown ? r.points : null,
      worth: round2(r.worth),
      at: insideWindow(r.updated_at, times) ? r.updated_at : ''
    };
  });

  var subs = await db.prepare(
    'SELECT COUNT(*) AS sent, ' +
    "COUNT(CASE WHEN status = 'accepted' THEN 1 END) AS accepted, " +
    "COUNT(CASE WHEN status = 'rejected' THEN 1 END) AS rejected, " +
    "COUNT(CASE WHEN status IN ('pending', 'queued') THEN 1 END) AS pending, " +
    'MIN(submitted_at) AS first_at, MAX(submitted_at) AS last_at ' +
    'FROM submissions WHERE team_id = ?1'
  ).bind(team.id).first<Totals>() as Totals;
  var perHour = (await db.prepare(
    "SELECT strftime('%Y-%m-%d %H:00', submitted_at) AS hour, COUNT(*) AS sent, " +
    "COUNT(CASE WHEN status = 'accepted' THEN 1 END) AS accepted " +
    'FROM submissions WHERE team_id = ?1 GROUP BY hour'
  ).bind(team.id).all<{ hour: string } & Sent>()).results;
  var win = await hourWindow(db);
  var counts: Record<string, Sent> = {};
  perHour.forEach(function (r) { addHour(counts, r.hour, r, win); });
  // the same by the minute, for the half hour, quarter and minute charts
  var perMinute = (await db.prepare(
    "SELECT strftime('%Y-%m-%d %H:%M', submitted_at) AS minute, COUNT(*) AS sent, " +
    "COUNT(CASE WHEN status = 'accepted' THEN 1 END) AS accepted " +
    'FROM submissions WHERE team_id = ?1 GROUP BY minute'
  ).bind(team.id).all<{ minute: string } & Sent>()).results;
  var minutes: Record<string, Sent> = {};
  perMinute.forEach(function (r) {
    var m = placeMinute(r.minute, win);
    if (!m) return;
    var c = minutes[m] || (minutes[m] = { sent: 0, accepted: 0 });
    c.sent += r.sent;
    c.accepted += r.accepted;
  });
  // the first and last sent inside the hours shown
  var span: Span | null = subs;
  if (win) {
    var b = windowBounds(win);
    span = await db.prepare(
      'SELECT MIN(submitted_at) AS first_at, MAX(submitted_at) AS last_at FROM submissions ' +
      'WHERE team_id = ?1 AND submitted_at >= ?2 AND submitted_at < ?3'
    ).bind(team.id, b[0], b[1]).first<Span>();
  }

  var files = await db.prepare(
    "SELECT COUNT(CASE WHEN f.content_type LIKE 'image/%' THEN 1 END) AS photos, " +
    "COUNT(CASE WHEN f.content_type LIKE 'video/%' THEN 1 END) AS videos, " +
    'COALESCE(SUM(f.bytes), 0) AS bytes ' +
    'FROM submission_files f JOIN submissions s ON s.id = f.submission_id WHERE s.team_id = ?1'
  ).bind(team.id).first<{ photos: number; videos: number; bytes: number }>() as { photos: number; videos: number; bytes: number };

  // when the team was all in, or, part-way in, when the last of it
  // arrived; a time outside the Arrivals frame is a test run and is left off
  var checkedAt = '';
  var partial: { n: number; of: number } | null = null;
  var checkin = await db.prepare('SELECT completed_at FROM team_checkins WHERE team_name = ?1 COLLATE NOCASE')
    .bind(team.name).first<Pick<TeamCheckinRow, 'completed_at'>>();
  if (checkin) checkedAt = checkin.completed_at;
  if (!checkedAt) {
    var arrived = await db.prepare(
      'SELECT last_at, checked_in, people FROM team_arrivals WHERE team_name = ?1 COLLATE NOCASE'
    ).bind(team.name).first<Pick<TeamArrivalRow, 'last_at' | 'checked_in' | 'people'>>();
    if (arrived && arrived.checked_in > 0) {
      checkedAt = arrived.last_at;
      partial = { n: arrived.checked_in, of: arrived.people };
    }
  }
  if (checkedAt && !insideWindow(checkedAt, await arrivalsWindow(db))) { checkedAt = ''; partial = null; }

  return {
    ok: true,
    team: team.name,
    rank: rank,
    dnf: dnf,
    teams: lastPlace(rows),
    total: round2(total),
    quests_done: lines.filter(function (l) { return !notQuest(l.code); }).length,
    lines: lines,
    submissions: { sent: subs.sent, accepted: subs.accepted, rejected: subs.rejected, pending: subs.pending },
    first_at: (span && span.first_at) || '',
    last_at: (span && span.last_at) || '',
    by_hour: fillHours(counts, ['sent', 'accepted'], 72),
    by_half: stepRows(minutes, 30).rows,
    by_quarter: stepRows(minutes, 15).rows,
    by_minute: stepRows(minutes, 1).rows,
    files: { photos: files.photos, videos: files.videos, bytes: files.bytes },
    checked_in_at: checkedAt,
    checked_in: partial
  };
}

// ---------- the whole day ----------

// opts.always: the dashboard's read, which answers whatever the switch
// says and while the tab is closed
export async function recapPayload(db: D1Database, opts?: { always?: boolean }) {
  var flags = await flagValues(db);
  if (!flags.recap && !(opts && opts.always)) return null;

  var rows = await standings(db);
  var pts = rows.map(function (r) { return r.pts; });
  var groupsTotal = await db.prepare('SELECT COUNT(*) AS n FROM quest_groups WHERE hidden = 0').first<{ n: number }>() as { n: number };
  var agg = await db.prepare(
    'SELECT COUNT(CASE WHEN c.amount > 0 THEN 1 END) AS completions, ' +
    SUM_POINTS + ' AS points ' +
    'FROM held c JOIN quests q ON q.code = c.quest_code ' +
    'JOIN teams t ON t.id = c.team_id WHERE t.hidden = 0'
  ).first<{ completions: number; points: number }>() as { completions: number; points: number };

  // submissions: how many, when, and the hour-by-hour shape of the day
  var subs = await db.prepare(
    'SELECT COUNT(*) AS sent, ' +
    "COUNT(CASE WHEN s.status = 'accepted' THEN 1 END) AS accepted, " +
    "COUNT(CASE WHEN s.status = 'rejected' THEN 1 END) AS rejected, " +
    "COUNT(CASE WHEN s.status IN ('pending', 'queued') THEN 1 END) AS pending, " +
    'MIN(s.submitted_at) AS first_at, MAX(s.submitted_at) AS last_at ' +
    'FROM submissions s JOIN teams t ON t.id = s.team_id WHERE t.hidden = 0'
  ).first<Totals>() as Totals;
  var perHour = (await db.prepare(
    "SELECT strftime('%Y-%m-%d %H:00', s.submitted_at) AS hour, COUNT(*) AS sent, " +
    "COUNT(CASE WHEN s.status = 'accepted' THEN 1 END) AS accepted " +
    'FROM submissions s JOIN teams t ON t.id = s.team_id WHERE t.hidden = 0 GROUP BY hour'
  ).all<{ hour: string } & Sent>()).results;
  var win = await hourWindow(db);
  var counts: Record<string, Sent> = {};
  perHour.forEach(function (r) { addHour(counts, r.hour, r, win); });
  var busiest = null as StepRow | null;
  Object.keys(counts).sort().forEach(function (h) {
    if (!busiest || counts[h].sent > busiest.sent) busiest = { hour: h, sent: counts[h].sent, accepted: counts[h].accepted };
  });
  // the same day by the minute, for the recap's quarter, half hour and
  // minute charts; a minute outside the hours window goes where its hour
  // would (the window's first or last minute) or nowhere
  var perMinute = (await db.prepare(
    "SELECT strftime('%Y-%m-%d %H:%M', s.submitted_at) AS minute, COUNT(*) AS sent, " +
    "COUNT(CASE WHEN s.status = 'accepted' THEN 1 END) AS accepted " +
    'FROM submissions s JOIN teams t ON t.id = s.team_id WHERE t.hidden = 0 GROUP BY minute'
  ).all<{ minute: string } & Sent>()).results;
  var minutes: Record<string, Sent> = {};
  perMinute.forEach(function (r) {
    var m = placeMinute(r.minute, win);
    if (!m) return;
    var c = minutes[m] || (minutes[m] = { sent: 0, accepted: 0 });
    c.sent += r.sent;
    c.accepted += r.accepted;
  });
  var quarter = stepRows(minutes, 15);
  var half = stepRows(minutes, 30);
  var minute = stepRows(minutes, 1);
  var span: Span | null = subs;
  if (win) {
    var b = windowBounds(win);
    span = await db.prepare(
      'SELECT MIN(s.submitted_at) AS first_at, MAX(s.submitted_at) AS last_at ' +
      'FROM submissions s JOIN teams t ON t.id = s.team_id WHERE t.hidden = 0 AND s.submitted_at >= ?1 AND s.submitted_at < ?2'
    ).bind(b[0], b[1]).first<Span>();
  }

  // how long a verdict took, from the moment it was sent. Points an
  // organiser recorded never waited for one, and their time may have been
  // moved to when the quest was done, so they are left out. With a time
  // frame set, only what was sent and decided inside it counts.
  var rw = await reviewWindow(db);
  var waitRows = (await db.prepare(
    'SELECT (julianday(s.reviewed_at) - julianday(s.submitted_at)) * 1440 AS mins ' +
    'FROM submissions s JOIN teams t ON t.id = s.team_id ' +
    "WHERE t.hidden = 0 AND s.reviewed_at IS NOT NULL AND s.reviewed_at != '' AND s.status != 'pending'" +
    " AND (?1 = '' OR s.submitted_at >= ?1) AND (?2 = '' OR s.reviewed_at <= ?2)" +
    " AND COALESCE(s.added_by, '') = ''"
  ).bind(rw ? rw.from : '', rw ? rw.to : '').all<{ mins: number }>()).results;
  var waits = waitRows.map(function (r) { return Number(r.mins); }).filter(function (m) { return isFinite(m) && m >= 0; });
  var review = {
    reviewed: waits.length,
    // never empty here
    median_minutes: waits.length ? round2(median(waits) as number) : null,
    mean_minutes: waits.length ? round2(waits.reduce(function (a, b) { return a + b; }, 0) / waits.length) : null,
    fastest_minutes: waits.length ? round2(Math.min.apply(null, waits)) : null,
    slowest_minutes: waits.length ? round2(Math.max.apply(null, waits)) : null
  };

  // each quest: how many teams did it, and the hour it was most often
  // done — from accepted submissions where there are any, else from
  // when the completion was recorded (a /submit on Discord)
  var groups = (await db.prepare(
    'SELECT g.id, g.key, g.name, g.region, g.sort FROM quest_groups g WHERE g.hidden = 0 ORDER BY g.sort, g.id'
  ).all<Pick<QuestGroupRow, 'id' | 'key' | 'name' | 'region' | 'sort'>>()).results;
  var byGroup: Record<number, GroupDay> = {};
  groups.forEach(function (g) {
    byGroup[g.id] = { key: g.key, name: g.name, region: g.region || '', done_by: 0, completions: 0, hours: {}, source: '', peak_hour: '', peak_count: 0, points: 0 };
  });
  (await db.prepare(
    'SELECT q.group_id, COUNT(DISTINCT c.team_id) AS teams_done, COUNT(*) AS completions, ' + SUM_POINTS + ' AS points ' +
    'FROM held c JOIN quests q ON q.code = c.quest_code ' +
    'JOIN teams t ON t.id = c.team_id AND t.hidden = 0 ' +
    'WHERE c.amount > 0 GROUP BY q.group_id'
  ).all<{ group_id: number; teams_done: number; completions: number; points: number }>()).results.forEach(function (r) {
    if (byGroup[r.group_id]) {
      byGroup[r.group_id].done_by = r.teams_done;
      byGroup[r.group_id].completions = r.completions;
      byGroup[r.group_id].points = round2(r.points);
    }
  });
  (await db.prepare(
    "SELECT q.group_id, strftime('%Y-%m-%d %H:00', s.submitted_at) AS hour, COUNT(*) AS n " +
    'FROM submissions s JOIN quests q ON q.code = s.quest_code ' +
    'JOIN teams t ON t.id = s.team_id AND t.hidden = 0 ' +
    "WHERE s.status = 'accepted' GROUP BY q.group_id, hour"
  ).all<{ group_id: number; hour: string; n: number }>()).results.forEach(function (r) {
    var g = byGroup[r.group_id];
    if (!g) return;
    g.source = 'submissions';
    var at = placeHour(r.hour, win);
    if (at) g.hours[at] = (g.hours[at] || 0) + r.n;
  });
  (await db.prepare(
    "SELECT q.group_id, strftime('%Y-%m-%d %H:00', c.updated_at) AS hour, COUNT(*) AS n " +
    'FROM held c JOIN quests q ON q.code = c.quest_code ' +
    'JOIN teams t ON t.id = c.team_id AND t.hidden = 0 ' +
    'WHERE c.amount > 0 GROUP BY q.group_id, hour'
  ).all<{ group_id: number; hour: string; n: number }>()).results.forEach(function (r) {
    var g = byGroup[r.group_id];
    if (!g || g.source === 'submissions') return;
    g.source = 'completions';
    var at = placeHour(r.hour, win);
    if (at) g.hours[at] = (g.hours[at] || 0) + r.n;
  });
  var quests: Pick<GroupDay, 'key' | 'name' | 'region' | 'done_by' | 'points' | 'peak_hour' | 'peak_count' | 'source'>[] = [];
  var never: Pick<GroupDay, 'key' | 'name' | 'region'>[] = [];
  groups.forEach(function (row) {
    var g = byGroup[row.id];
    Object.keys(g.hours).sort().forEach(function (h) {
      if (g.hours[h] > g.peak_count) { g.peak_count = g.hours[h]; g.peak_hour = h; }
    });
    var out = { key: g.key, name: g.name, region: g.region, done_by: g.done_by, points: g.points, peak_hour: g.peak_hour, peak_count: g.peak_count, source: g.source };
    if (g.done_by > 0) quests.push(out);
    else never.push({ key: g.key, name: g.name, region: g.region });
  });
  var skip: Record<string, boolean> = {};
  (await mostSkip(db)).forEach(function (k) { skip[k.toLowerCase()] = true; });
  var mostDone = quests.filter(function (q) { return !skip[String(q.key).toLowerCase()]; }).sort(function (a, b) { return b.done_by - a.done_by || a.key.localeCompare(b.key); }).slice(0, 10);
  // Rarely done leaves out the same quests
  var leastDone = quests.filter(function (q) { return !skip[String(q.key).toLowerCase()]; }).sort(function (a, b) { return a.done_by - b.done_by || a.key.localeCompare(b.key); }).slice(0, 10);

  // regions: where the points came from
  var regions = (await db.prepare(
    'SELECT COALESCE(g.region, \'\') AS region, COUNT(*) AS completions, ' +
    SUM_POINTS + ' AS points, COUNT(DISTINCT c.team_id) AS teams ' +
    'FROM held c JOIN quests q ON q.code = c.quest_code ' +
    'LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    'JOIN teams t ON t.id = c.team_id AND t.hidden = 0 ' +
    'WHERE c.amount > 0 GROUP BY region ORDER BY points DESC'
  ).all<{ region: string; completions: number; points: number; teams: number }>()).results.map(function (r) {
    // each quest in the region, with what it brought in
    var inRegion = groups.filter(function (g) { return (g.region || '') === r.region; }).map(function (g) {
      var q = byGroup[g.id];
      return { key: q.key, name: q.name, completions: q.completions, teams: q.done_by, points: q.points };
    }).sort(function (a, b) { return b.points - a.points || b.completions - a.completions || a.key.localeCompare(b.key); });
    return { region: r.region || 'Other Quests', completions: r.completions, points: round2(r.points), teams: r.teams, quests: inRegion };
  });

  // teams: the top of the table, the busiest senders, the spread
  var active = (await db.prepare(
    'SELECT t.name, COUNT(*) AS sent, ' +
    "COUNT(CASE WHEN s.status = 'accepted' THEN 1 END) AS accepted, " +
    "COUNT(CASE WHEN s.status = 'rejected' THEN 1 END) AS rejected " +
    'FROM submissions s JOIN teams t ON t.id = s.team_id WHERE t.hidden = 0 ' +
    'GROUP BY t.id ORDER BY sent DESC, t.name LIMIT 5'
  ).all<{ name: string; sent: number; accepted: number; rejected: number }>()).results;
  var mystery = await mysteryIds(db);
  var biggest = await db.prepare(
    'SELECT t.name AS team, c.quest_code AS code, g.name AS quest, c.amount, q.points, q.scoring, q.group_id, c.points AS worth ' +
    'FROM held c JOIN quests q ON q.code = c.quest_code ' +
    'LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    'JOIN teams t ON t.id = c.team_id AND t.hidden = 0 ' +
    'WHERE c.amount > 0 ORDER BY worth DESC LIMIT 1'
  ).first<{ team: string; code: string; quest: string | null; amount: number; points: number; scoring: string; group_id: number | null; worth: number }>();

  // proof: what came in
  var files = await db.prepare(
    "SELECT COUNT(CASE WHEN f.content_type LIKE 'image/%' THEN 1 END) AS photos, " +
    "COUNT(CASE WHEN f.content_type LIKE 'video/%' THEN 1 END) AS videos, " +
    'COALESCE(SUM(f.bytes), 0) AS bytes, COALESCE(MAX(f.bytes), 0) AS biggest_bytes ' +
    'FROM submission_files f JOIN submissions s ON s.id = f.submission_id ' +
    'JOIN teams t ON t.id = s.team_id WHERE t.hidden = 0'
  ).first<{ photos: number; videos: number; bytes: number; biggest_bytes: number }>() as { photos: number; videos: number; bytes: number; biggest_bytes: number };
  var gallery = await db.prepare(
    "SELECT COUNT(*) AS n FROM submissions s JOIN teams t ON t.id = s.team_id WHERE t.hidden = 0 AND s.gallery = 1 AND s.status = 'accepted'"
  ).first<{ n: number }>() as { n: number };

  // arrivals, from the check-in worker's reports
  var arrive = (await arrivalsWindow(db)) || { from: '', to: '' };
  var ck = await db.prepare(
    'SELECT COUNT(*) AS n, MIN(completed_at) AS first_at, MAX(completed_at) AS last_at FROM team_checkins tc ' +
    'WHERE NOT EXISTS (SELECT 1 FROM teams x WHERE x.name = tc.team_name COLLATE NOCASE AND x.hidden = 1) ' +
    "AND (?1 = '' OR REPLACE(tc.completed_at, 'T', ' ') >= ?1) AND (?2 = '' OR REPLACE(tc.completed_at, 'T', ' ') <= ?2)"
  ).bind(arrive.from, arrive.to).first<{ n: number; first_at: string | null; last_at: string | null }>() as { n: number; first_at: string | null; last_at: string | null };
  var checkins = { n: ck.n, first_at: ck.first_at || '', last_at: ck.last_at || '' };

  // the questions live quests asked, if any were
  var ak = await db.prepare(
    "SELECT (SELECT COUNT(*) FROM quest_groups WHERE ask_kind != '' AND hidden = 0) AS questions, " +
    '(SELECT COUNT(*) FROM quest_responses r JOIN teams t ON t.id = r.team_id WHERE t.hidden = 0) AS answers'
  ).first<{ questions: number; answers: number }>() as { questions: number; answers: number };
  var asks = { questions: ak.questions, answers: ak.answers };

  // the Ranks tab's boards picked for the recap, the first five places
  // of each and the three fastest and slowest; hidden teams are left out
  var boards: { title: string; measure: string; teams: { place: number; name: string; value: number }[] }[] = [];
  var builtin = await rankRecap(db);
  if (builtin.submit_times) {
    // the slowest are counted from the teams not already among the
    // fastest, so a handful of teams is not listed twice
    var times = (await submitTimes(db)).filter(function (t) { return !t.hidden; });
    var average = function (t: (typeof times)[number]) { return t.average; };
    var fastest = topPlaces(times, average, 3);
    var slow = times.slice(fastest.length).reverse();
    boards.push({ title: 'Top 3 Fastest Submitting Teams', measure: 'time', teams: fastest });
    boards.push({ title: 'Top 3 Slowest Submitting Teams', measure: 'time', teams: topPlaces(slow, average, 3) });
  }
  if (builtin.quests_done) {
    var doneBy = (await questsDone(db)).filter(function (t) { return !t.hidden && t.quests > 0; });
    boards.push({ title: 'Quests Done', measure: 'quests', teams: topPlaces(doneBy, function (t) { return t.quests; }, 5) });
  }
  var picked = (await rankBoards(db)).filter(function (b) { return b.recap; });
  for (var bi = 0; bi < picked.length; bi++) {
    var board = picked[bi];
    var ranked = ((await boardTeams(db, board.quest, board.measure)) || []).filter(function (t) { return !t.hidden && Number(t.value) > 0; });
    var top = topPlaces(ranked, function (t) { return t.value; }, 5);
    var named = board.title;
    if (!named && board.quest) {
      var qrow = await db.prepare('SELECT name FROM quest_groups WHERE key = ?1 COLLATE NOCASE').bind(board.quest).first<Pick<QuestGroupRow, 'name'>>();
      named = (qrow && qrow.name) || board.quest;
    }
    boards.push({ title: named || 'Every quest', measure: board.measure, teams: top });
  }

  return {
    ok: true,
    teams: rows.length,
    quests: groupsTotal.n,
    completions: agg.completions,
    points: round2(agg.points),
    submissions: {
      sent: subs.sent, accepted: subs.accepted, rejected: subs.rejected, pending: subs.pending,
      first_at: (span && span.first_at) || '', last_at: (span && span.last_at) || '',
      busiest_hour: busiest,
      by_hour: fillHours(counts, ['sent', 'accepted'], 72),
      by_half: half.rows, busiest_half: half.busiest,
      by_quarter: quarter.rows, busiest_quarter: quarter.busiest,
      by_minute: minute.rows, busiest_minute: minute.busiest
    },
    review: review,
    quests_by_time: quests,
    most_done: mostDone,
    least_done: leastDone,
    never_done: never,
    regions: regions,
    // the places: a team that did not finish has none
    top_teams: rows.filter(function (r) { return !r.dnf; }).slice(0, 5).map(function (r) {
      return { rank: r.rank, name: r.name, points: round2(r.pts), quests_done: r.quests_done };
    }),
    most_active: active,
    biggest_score: biggest ? {
      team: biggest.team, code: biggest.code, quest: biggest.quest || biggest.code,
      amount: showsPoints(mystery[String(biggest.group_id)], biggest.amount) ? biggest.amount : null,
      points: showsPoints(mystery[String(biggest.group_id)], biggest.amount) ? biggest.points : null,
      worth: round2(biggest.worth)
    } : null,
    points_spread: pts.length ? {
      min: round2(Math.min.apply(null, pts)), max: round2(Math.max.apply(null, pts)),
      median: round2(median(pts) as number), mean: round2(pts.reduce(function (a, b) { return a + b; }, 0) / pts.length)
    } : null,
    files: { photos: files.photos, videos: files.videos, bytes: files.bytes, biggest_bytes: files.biggest_bytes, gallery: gallery.n },
    checkins: checkins,
    asks: asks,
    boards: boards,
    sections: await sectionsOut(db)
  };
}

// ---------- router ----------
// Neither read is cached: a switch flipped in the dashboard has to
// take at once, and the recap is read a few times, not by a room full
// of phones every thirty seconds.

// ---------- one quest, opened from the recap's quest table ----------
// Behind the recap's switch: how many teams sent it and did it, and the
// accepted submissions in the order they came in. One sent at a time
// outside the team pages' Quest times frame goes at the end with no
// time, the way a team page leaves its time off.
export async function questPage(env: Env, key: unknown) {
  var db = env.DB;
  var flags = await flagValues(db);
  if (!flags.recap) return null;
  var wanted = cleanText(key, 40);
  if (!wanted) return null;
  var g = await db.prepare('SELECT id, key, name, region FROM quest_groups WHERE key = ?1 COLLATE NOCASE AND hidden = 0')
    .bind(wanted).first<Pick<QuestGroupRow, 'id' | 'key' | 'name' | 'region'>>();
  if (!g) return null;
  var teams = (await standings(db)).length;
  var done = await db.prepare(
    'SELECT COUNT(DISTINCT c.team_id) AS n FROM held c JOIN quests q ON q.code = c.quest_code ' +
    'JOIN teams t ON t.id = c.team_id AND t.hidden = 0 WHERE q.group_id = ?1 AND c.amount > 0'
  ).bind(g.id).first<{ n: number }>();
  var subs = await db.prepare(
    "SELECT COUNT(CASE WHEN s.status <> 'deleted' THEN 1 END) AS sent, " +
    "COUNT(CASE WHEN s.status = 'accepted' THEN 1 END) AS accepted, " +
    "COUNT(CASE WHEN s.status = 'rejected' THEN 1 END) AS rejected, " +
    "COUNT(CASE WHEN s.status IN ('pending', 'queued') THEN 1 END) AS waiting, " +
    "COUNT(DISTINCT CASE WHEN s.status <> 'deleted' THEN s.team_id END) AS teams " +
    'FROM submissions s JOIN quests q ON q.code = s.quest_code ' +
    'JOIN teams t ON t.id = s.team_id AND t.hidden = 0 WHERE q.group_id = ?1'
  ).bind(g.id).first<{ sent: number; accepted: number; rejected: number; waiting: number; teams: number }>() as { sent: number; accepted: number; rejected: number; waiting: number; teams: number };
  var rows = (await db.prepare(
    'SELECT t.name AS team, s.submitted_at AS at FROM submissions s JOIN quests q ON q.code = s.quest_code ' +
    "JOIN teams t ON t.id = s.team_id AND t.hidden = 0 WHERE q.group_id = ?1 AND s.status = 'accepted' " +
    'ORDER BY s.submitted_at, s.id'
  ).bind(g.id).all<{ team: string; at: string }>()).results;
  var win = await timesWindow(db);
  var timed = function (r: { at: string }) { return r.at && insideWindow(r.at, win); };
  var page: Record<string, unknown> = {
    ok: true,
    quest: { key: g.key, name: g.name, region: g.region || '' },
    teams: teams,
    done_by: done ? done.n : 0,
    submissions: { sent: subs.sent, accepted: subs.accepted, rejected: subs.rejected, waiting: subs.waiting, teams: subs.teams },
    accepted: rows.filter(timed).map(function (r) { return { team: r.team, at: r.at }; })
      .concat(rows.filter(function (r) { return !timed(r); }).map(function (r) { return { team: r.team, at: '' }; }))
  };
  // a quest the Recap card shows photo by photo (visits.ts): each team's
  // places in the order visited, most first; a time outside the Quest
  // times frame is left off and the place kept
  var viewed = (await viewedQuests(db))[g.id];
  if (viewed) {
    page.visits = {
      kind: viewed.view,
      teams: (await photoVisits(env, g.id)).map(function (t) {
        return { team: t.team, visits: t.visits.map(function (v) { return { place: v.place, at: insideWindow(v.at, win) ? v.at : '' }; }) };
      }).sort(function (a, b) { return b.visits.length - a.visits.length || a.team.localeCompare(b.team); })
    };
  }
  return page;
}

// ---------- the replay ----------
// The routes teams recorded are saved on the dashboard's Routes tab
// (tracks.ts); each team here says whether it has one (`route`, when it
// was saved, which the page adds to the route's address so a route saved
// again is fetched again). On top of them: each team's quests with when
// the proof was sent, which is
// where the team was when it did the quest (the time a line holds is when
// it was reviewed, which can be an hour later), and each quest's pins.
// A quest counts once, at its first accepted submission. One sent outside
// the dashboard's Quest times frame is left out, as on a team's page.
// Where a team's proof was taken, for a quest with several places that
// its codes cannot choose between: the location in the photo's (or the
// video's) own metadata, read once and kept in photo_places, so the
// replay can put the quest on the nearest of its places. Only the place
// goes out; the photo's location never leaves the worker. Null for a
// submission whose files carry none.
var PHOTO_NEAR_KM = 1;   // a photo this close to one of the quest's places was taken there
var PHOTO_READS = 12;    // submissions read from the bucket in one request; the rest on the next
async function photoPlaces(env: Env, ids: number[]): Promise<Record<number, { lat: number; lng: number } | null>> {
  var out: Record<number, { lat: number; lng: number } | null> = {};
  if (!ids.length) return out;
  var db = env.DB;
  (await db.prepare('SELECT submission_id, lat, lng FROM photo_places WHERE submission_id IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(ids)).all<{ submission_id: number; lat: number | null; lng: number | null }>()).results.forEach(function (r) {
    out[r.submission_id] = r.lat === null || r.lng === null ? null : { lat: r.lat, lng: r.lng };
  });
  var missing = ids.filter(function (id) { return !(id in out); }).slice(0, PHOTO_READS);
  if (!missing.length || !env.SUBMIT) return out;
  var files = (await db.prepare(
    "SELECT submission_id, r2_key, content_type FROM submission_files WHERE submission_id IN (SELECT value FROM json_each(?1)) AND status <> 'uploading' ORDER BY submission_id, id"
  ).bind(JSON.stringify(missing)).all<{ submission_id: number; r2_key: string; content_type: string }>()).results;
  var writes: D1PreparedStatement[] = [];
  for (var i = 0; i < missing.length; i++) {
    var id = missing[i];
    var found: { lat: number; lng: number } | null = null;
    var mine = files.filter(function (f) { return f.submission_id === id && /^(image|video)\//.test(f.content_type); });
    for (var j = 0; j < mine.length && !found; j++) {
      try {
        var gps = readExif(await metaBlock(env, mine[j].r2_key, mine[j].content_type)).gps;
        if (gps) found = { lat: Math.round(gps.lat * 1e5) / 1e5, lng: Math.round(gps.lng * 1e5) / 1e5 };
      } catch (err) { /* a file that cannot be read says nothing */ }
    }
    out[id] = found;
    writes.push(db.prepare('INSERT OR REPLACE INTO photo_places (submission_id, lat, lng) VALUES (?1, ?2, ?3)')
      .bind(id, found ? found.lat : null, found ? found.lng : null));
  }
  // and nothing kept for a submission that is no longer accepted
  writes.push(db.prepare("DELETE FROM photo_places WHERE submission_id NOT IN (SELECT id FROM submissions WHERE status = 'accepted')"));
  await db.batch(writes);
  return out;
}

// What photo_places holds for submissions that have gone, when a team is
// deleted.
export async function forgetPhotoPlaces(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM photo_places WHERE submission_id NOT IN (SELECT id FROM submissions WHERE status = 'accepted')").run();
}

// Each team's points over the day, for the replay's leaderboard: one
// item for each submission the team sent (`sent`, `accepted`), each
// organiser's entry, and each award or balance on the ledger, with the
// points its live lines are worth now. A submission counts from when it
// was sent, not when it was reviewed; an award or a balance from the time
// its line holds. A time outside the Quest times frame goes out as the
// edge it is past (`edge: 'start'` or `'end'`) instead, so the day's
// first and last moments carry it and the last moment of the replay adds
// up to the tab.
type LogItem = { at?: string; edge?: string; points: number; sent: number; accepted: number };
async function pointsLog(db: D1Database, times: Frame | null): Promise<Record<number, LogItem[]>> {
  var subs = (await db.prepare(
    "SELECT s.id, s.team_id, s.submitted_at AS at, s.status, s.added_by FROM submissions s JOIN teams t ON t.id = s.team_id AND t.hidden = 0 WHERE s.status <> 'deleted'"
  ).all<{ id: number; team_id: number; at: string | null; status: string; added_by: string | null }>()).results;
  var lines = (await db.prepare(
    'SELECT e.team_id, e.source_kind, e.source_id, e.points, e.at FROM entries e JOIN teams t ON t.id = e.team_id AND t.hidden = 0 WHERE e.voided_at IS NULL'
  ).all<{ team_id: number; source_kind: string; source_id: number | null; points: number; at: string }>()).results;
  var worth: Record<number, number> = {};
  var loose: Record<string, { team: number; at: string; points: number }> = {};
  var sentIds: Record<number, boolean> = {};
  subs.forEach(function (r) { sentIds[r.id] = true; });
  lines.forEach(function (l) {
    if (l.source_kind === 'submission' && l.source_id !== null && sentIds[l.source_id]) {
      worth[l.source_id] = (worth[l.source_id] || 0) + Number(l.points || 0);
      return;
    }
    // an award, a balance, or a line whose submission has gone: at its own time
    var k = l.team_id + '|' + l.source_kind + '|' + l.source_id + '|' + l.at;
    var g = loose[k] || (loose[k] = { team: l.team_id, at: l.at, points: 0 });
    g.points += Number(l.points || 0);
  });
  var out: Record<number, LogItem[]> = {};
  function add(team: number, at: string | null, item: LogItem) {
    var stamp = String(at || '').replace('T', ' ').slice(0, 19);
    if (!stamp) item.edge = 'end';
    else if (times && times.from && stamp < times.from) item.edge = 'start';
    else if (times && times.to && stamp > times.to) item.edge = 'end';
    else item.at = stamp;
    item.points = round2(item.points);
    (out[team] = out[team] || []).push(item);
  }
  subs.forEach(function (r) {
    var mine = !r.added_by;
    var points = worth[r.id] || 0;
    if (!mine && !points) return;
    add(r.team_id, r.at, { points: points, sent: mine ? 1 : 0, accepted: mine && r.status === 'accepted' ? 1 : 0 });
  });
  Object.keys(loose).forEach(function (k) {
    var g = loose[k];
    if (g.points) add(g.team, g.at, { points: g.points, sent: 0, accepted: 0 });
  });
  Object.keys(out).forEach(function (team) {
    out[Number(team)].sort(function (a, b) { return String(a.at || a.edge).localeCompare(String(b.at || b.edge)); });
  });
  return out;
}

export async function replayPayload(env: Env) {
  var db = env.DB;
  var flags = await flagValues(db);
  if (!flags.replay) return null;
  var board = await standings(db);
  var routes = await routeStamps(db);
  var rows = (await db.prepare(
    'SELECT s.id, s.team_id, s.quest_code AS code, s.quest_code, s.submitted_at AS at, s.answer, s.credit, g.id AS group_id, ' +
    'g.key AS group_key, g.name AS name, g.region AS region, g.coords AS coords ' +
    'FROM submissions s JOIN teams t ON t.id = s.team_id AND t.hidden = 0 ' +
    'JOIN quests q ON q.code = s.quest_code LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    "WHERE s.status = 'accepted' ORDER BY s.submitted_at, s.id"
  ).all<{ id: number; team_id: number; code: string; quest_code: string; at: string | null; answer: string | null; credit: string | null; group_id: number | null;
    group_key: string | null; name: string | null; region: string | null; coords: string | null }>()).results;
  // each quest's codes with their labels, which name the pin each code is
  // for when a quest has several (team-map.ts matches them)
  var codesOf: Record<number, { code: string; label: string }[]> = {};
  (await db.prepare('SELECT code, label, group_id FROM quests WHERE hidden = 0 AND group_id IS NOT NULL ORDER BY group_id, sort, norm')
    .all<{ code: string; label: string; group_id: number }>()).results.forEach(function (q) {
    (codesOf[q.group_id] = codesOf[q.group_id] || []).push({ code: q.code, label: q.label });
  });
  var times = await timesWindow(db);
  // spot: where the quest was done, for a team with no route: the pin of
  // the code it was sent for, or the quest's only pin, or the one of its
  // pins nearest where the photo was taken; none otherwise
  type Quest = { key: string; code: string; name: string; region: string; at: string; spot?: { lat: number; lng: number; place: string };
    stop?: string; taken?: boolean };
  var byTeam: Record<string, { seen: Record<string, boolean>; quests: Quest[] }> = {};
  var pins: Record<string, { label: string; lat: number; lng: number }[]> = {};
  var undecided: { quest: Quest; id: number; pins: { label: string; lat: number; lng: number }[] }[] = [];
  // a quest the Recap card shows photo by photo is a ring at each place
  // the team's photos were taken at, added below, rather than one for it
  var viewed = await viewedQuests(db);
  rows.forEach(function (r) {
    var at = r.at;
    if (notQuest(r.code) || !at || !insideWindow(at, times)) return;
    if (r.group_id && viewed[r.group_id]) return;
    var key = r.group_key || r.code;
    var list = byTeam[r.team_id] || (byTeam[r.team_id] = { seen: {}, quests: [] });
    if (list.seen[key]) return;
    list.seen[key] = true;
    var quest: Quest = { key: key, code: r.code, name: r.name || r.code, region: r.region || '', at: at };
    var spot = r.group_id ? placeFor(cleanPins(r.coords), codesOf[r.group_id] || [], chosenCodes(r), false) : null;
    if (spot) quest.spot = { lat: Math.round(spot.lat * 1e5) / 1e5, lng: Math.round(spot.lng * 1e5) / 1e5, place: spot.place };
    else if (r.group_id && cleanPins(r.coords).length > 1) undecided.push({ quest: quest, id: r.id, pins: cleanPins(r.coords) });
    list.quests.push(quest);
    if (!(key in pins)) {
      var p: { label: string; lat: number; lng: number }[] = [];
      try { p = parseCoords(r.coords || '[]'); } catch (err) { p = []; }
      pins[key] = p.map(function (c) { return { label: c.label, lat: c.lat, lng: c.lng }; });
    }
  });
  (await photoVisits(env)).forEach(function (t) {
    var q = viewed[t.group_id];
    var list = byTeam[t.team_id] || (byTeam[t.team_id] = { seen: {}, quests: [] });
    t.visits.forEach(function (v) {
      if (!q || !insideWindow(v.at, times)) return;
      list.quests.push({
        key: q.key, code: q.key, name: q.name, region: q.region, at: v.at,
        spot: { lat: v.lat, lng: v.lng, place: v.place }, stop: v.place, taken: v.taken
      });
    });
  });
  var log = await pointsLog(db, times);
  // the last way to pick one of several places: where the photo was taken
  var taken = await photoPlaces(env, undecided.map(function (u) { return u.id; }));
  undecided.forEach(function (u) {
    var at = taken[u.id];
    if (!at) return;
    var best: { label: string; lat: number; lng: number } | null = null;
    var bestKm = Infinity;
    u.pins.forEach(function (p) { var d = km(at as { lat: number; lng: number }, p); if (d < bestKm) { bestKm = d; best = p; } });
    if (best && bestKm <= PHOTO_NEAR_KM) {
      var pin = best as { label: string; lat: number; lng: number };
      u.quest.spot = { lat: Math.round(pin.lat * 1e5) / 1e5, lng: Math.round(pin.lng * 1e5) / 1e5, place: pin.label };
    }
  });
  return {
    ok: true,
    teams: board.map(function (t) {
      return { name: t.name, rank: t.rank, dnf: t.dnf, total: round2(t.pts), route: routes[t.id] || '', quests: byTeam[t.id] ? byTeam[t.id].quests : [],
        log: log[t.id] || [] };
    }),
    pins: pins
  };
}

export async function handleRecapApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  if (url.pathname !== '/api/team' && url.pathname !== '/api/recap' && url.pathname !== '/api/recap/quest' && url.pathname !== '/api/replay' && url.pathname !== '/api/replay/route') return null;
  // a closed tab shows no standings anywhere, and a frozen one only its
  // frozen copy: these are read live, so they wait for the thaw
  if (await afterPagesShut(env.DB)) return corsJson({ error: 'not found' }, 404, NO_STORE);
  if (url.pathname === '/api/team') {
    var page = await teamPage(env.DB, url.searchParams.get('name') || '', url.searchParams.get('id'));
    return page ? corsJson(await undated(env.DB, page), 200, NO_STORE) : corsJson({ error: 'not found' }, 404, NO_STORE);
  }
  if (url.pathname === '/api/recap/quest') {
    var quest = await questPage(env, url.searchParams.get('key') || '');
    return quest ? corsJson(await undated(env.DB, quest), 200, NO_STORE) : corsJson({ error: 'not found' }, 404, NO_STORE);
  }
  if (url.pathname === '/api/replay') {
    var replay = await replayPayload(env);
    return replay ? corsJson(await undated(env.DB, replay), 200, NO_STORE) : corsJson({ error: 'not found' }, 404, NO_STORE);
  }
  // one team's route, by the team's name, behind the same switch
  if (url.pathname === '/api/replay/route') {
    var route = (await flagValues(env.DB)).replay ? await routeFor(env.DB, url.searchParams.get('name')) : null;
    return route ? corsJson({ ok: true, route: route }, 200, NO_STORE) : corsJson({ error: 'not found' }, 404, NO_STORE);
  }
  if (url.pathname === '/api/recap') {
    var recap = await recapPayload(env.DB);
    return recap ? corsJson(await undated(env.DB, recap), 200, NO_STORE) : corsJson({ error: 'not found' }, 404, NO_STORE);
  }
  return null;
}
