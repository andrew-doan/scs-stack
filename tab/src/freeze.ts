// Freezing the tab.
//
// Partway through the day the tab stops moving in public: teams see the
// standings exactly as they were at the moment of the freeze and
// nothing that happens after it, while organisers carry on scoring in
// the dashboard as usual.
//
// The freeze is a copy, not a filter. When it goes on, the public
// payloads are rendered once and stored as they stand; every frozen
// read afterwards serves that stored copy and never touches the live
// tables. There is no query a team could tilt to see through it,
// because while the freeze is on nothing asks the live tables the
// public's questions at all.
//
// Closing the tab goes further: the same reads answer that it is
// closed and nothing else. It sits on top of a freeze rather than
// replacing it, so opening the tab again goes back to the frozen copy.
//
// Every copy is also kept in tab_snapshots: the one taken at each
// freeze, one an organiser saves by hand, and one each hour when the
// standings have moved. Any of them can be put back as the frozen copy,
// which is how a thaw by mistake is undone.
//
// Everything that can answer the public's questions goes through here:
// the JSON API, the team's score sheet, the after-the-event pages and
// the Discord commands that read the tab.

import { settingValue, errorMessage } from './shared.ts';
import type { LeaderboardTeam, RenderPayload, Snapshot, TabFreezeRow, TabSnapshotRow } from './types.ts';

// The one tab_freeze row, as far as the database has its columns.
type FreezeRow = Pick<TabFreezeRow, 'frozen' | 'frozen_at' | 'snapshot'> & Partial<Pick<TabFreezeRow, 'closed' | 'closed_at'>>;

// The freeze, while it is on: when, and the copy every frozen read answers with.
export interface FreezeState {
  frozen_at: string | null;
  snapshot: Snapshot;
}

export interface TabState {
  frozen: FreezeState | null;
  closed: { closed_at: string } | null;
}

// A saved copy (tab_snapshots) with its payloads read back.
export interface SavedCopy {
  id: number;
  taken_at: string;
  kind: string;
  taken_by: string;
  snapshot: Snapshot;
}

// A saved copy as the list shows it, without the payloads.
export interface CopyListing {
  id: number;
  taken_at: string;
  kind: string;
  taken_by: string;
  teams: number;
  top: { name: string; points: number }[];
}

// the public reads that would give the game away
export var FROZEN_PATHS = ['/api/leaderboard', '/api/quests', '/api/stats'];

// Hourly copies kept, ten days of them; copies taken at a freeze or by
// hand stay until an organiser deletes them.
var HOURLY_KEEP = 240;

function stamp(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

// The one row, read once. No row reads as live.
function readRow(db: D1Database): Promise<FreezeRow | null> {
  return db.prepare('SELECT frozen, frozen_at, snapshot, closed, closed_at FROM tab_freeze WHERE id = 1').first<FreezeRow>();
}

function frozenOf(row: FreezeRow | null): FreezeState | null {
  if (!row || !row.frozen) return null;
  var snapshot: Snapshot = {};
  try { snapshot = (JSON.parse(row.snapshot || '{}') || {}) as Snapshot; } catch (err) { snapshot = {}; }
  return { frozen_at: row.frozen_at, snapshot: snapshot };
}

// Both halves at once: `frozen` is the freeze or null, `closed` is
// {closed_at} or null.
export async function tabState(db: D1Database): Promise<TabState> {
  var row = await readRow(db);
  return {
    frozen: frozenOf(row),
    closed: row && row.closed ? { closed_at: row.closed_at || '' } : null
  };
}

// The freeze as it stands, or null when the tab is live.
export async function freezeState(db: D1Database): Promise<FreezeState | null> {
  return frozenOf(await readRow(db));
}

// What a frozen read answers with for one path: the copy taken when
// the freeze went on, marked so pages can say so. A path with nothing
// captured answers with the mark alone rather than falling through to
// live data.
export function frozenPayload(state: FreezeState, pathname: string): Record<string, unknown> {
  var copy = state.snapshot && (state.snapshot as Record<string, unknown>)[pathname];
  var out: Record<string, unknown> = {};
  if (copy && typeof copy === 'object') {
    for (var k in copy) if (Object.prototype.hasOwnProperty.call(copy, k)) out[k] = (copy as Record<string, unknown>)[k];
  }
  out.frozen = true;
  out.frozen_at = state.frozen_at;
  return out;
}

// What a closed read answers with: that it is closed, and nothing else.
export function closedPayload(): { closed: true } {
  return { closed: true };
}

// The three public payloads as they stand. The renderer is handed in so
// this module never has to know how they are built, and it has to be
// the live one: a copy saved while the tab is frozen is of the tab, not
// of the frozen copy.
export async function renderSnapshot(renderPayload: RenderPayload): Promise<Snapshot> {
  var built = await Promise.all(FROZEN_PATHS.map(function (path) { return renderPayload(path); }));
  var snapshot: Record<string, unknown> = {};
  for (var i = 0; i < FROZEN_PATHS.length; i++) {
    snapshot[FROZEN_PATHS[i]] = built[i];
  }
  return snapshot as Snapshot;
}

// Turning it on takes the copy, or puts back a saved one with the time
// it was taken; turning it off throws the frozen copy away (the saved
// ones stay). A fresh freeze is saved as a copy too. Closing is left as
// it was either way. A fresh freeze while frozen, or a thaw while live,
// changes nothing (`changed` false): two presses at once freeze once and
// save one copy. Putting a saved copy back works while frozen.
export async function setFrozen(db: D1Database, on: boolean, renderPayload: RenderPayload, opts?: { copy?: SavedCopy | null; by?: string }): Promise<{ frozen: boolean; frozen_at?: string | null; copy_id?: number | null; changed: boolean }> {
  opts = opts || {};
  if (!on) {
    var thawed = await db.prepare(
      'INSERT INTO tab_freeze (id, frozen, frozen_at, snapshot) VALUES (1, 0, NULL, NULL) ' +
      'ON CONFLICT(id) DO UPDATE SET frozen = 0, frozen_at = NULL, snapshot = NULL WHERE COALESCE(tab_freeze.frozen, 0) != 0'
    ).run();
    return { frozen: false, changed: !!(thawed.meta && thawed.meta.changes) };
  }
  var snapshot = opts.copy ? opts.copy.snapshot : await renderSnapshot(renderPayload);
  var at = opts.copy ? opts.copy.taken_at : stamp();
  var froze = await db.prepare(
    'INSERT INTO tab_freeze (id, frozen, frozen_at, snapshot) VALUES (1, 1, ?1, ?2) ' +
    'ON CONFLICT(id) DO UPDATE SET frozen = 1, frozen_at = ?1, snapshot = ?2' + (opts.copy ? '' : ' WHERE COALESCE(tab_freeze.frozen, 0) = 0')
  ).bind(at, JSON.stringify(snapshot)).run();
  if (!froze.meta || !froze.meta.changes) {
    var was = await freezeState(db);
    return { frozen: true, frozen_at: was ? was.frozen_at : null, copy_id: null, changed: false };
  }
  var saved: number | null = null;
  if (!opts.copy) saved = await saveCopy(db, 'freeze', opts.by, snapshot, at);
  return { frozen: true, frozen_at: at, copy_id: saved, changed: true };
}

// Closing or opening the tab; closing it again keeps the time it closed
// (`changed` false).
export async function setClosed(db: D1Database, on: boolean): Promise<{ closed: boolean; closed_at: string | null; changed: boolean }> {
  var at = on ? stamp() : null;
  var res = await db.prepare(
    'INSERT INTO tab_freeze (id, frozen, closed, closed_at) VALUES (1, 0, ?1, ?2) ' +
    'ON CONFLICT(id) DO UPDATE SET closed = ?1, closed_at = ?2 WHERE COALESCE(tab_freeze.closed, 0) != ?1'
  ).bind(on ? 1 : 0, at).run();
  if (!res.meta || !res.meta.changes) {
    var state = await tabState(db);
    return { closed: !!on, closed_at: state.closed ? state.closed.closed_at : null, changed: false };
  }
  return { closed: !!on, closed_at: at, changed: true };
}

// ---------- saved copies ----------

// A short hash of the standings: two copies with the same one show the
// same board.
function hash(text: string): string {
  var h1 = 0xdeadbeef;
  var h2 = 0x41c6ce57;
  for (var i = 0; i < text.length; i++) {
    var c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}

function boardOf(snapshot: Snapshot | null | undefined): LeaderboardTeam[] {
  var board = snapshot && snapshot['/api/leaderboard'];
  return (board && board.teams) || [];
}

function summarise(snapshot: Snapshot): { teams: number; scored: boolean; top: { name: string; points: number }[]; digest: string } {
  var teams = boardOf(snapshot);
  return {
    teams: teams.length,
    scored: teams.some(function (t) { return Number(t.points); }),
    // the first three places: a team that did not finish has none
    top: teams.filter(function (t) { return !t.dnf; }).slice(0, 3).map(function (t) { return { name: t.name, points: t.points }; }),
    // a team marked as not finishing is a change too; boards without
    // one hash as they did before
    digest: hash(teams.map(function (t) { return t.name + '\t' + t.points + '\t' + t.quests_done + (t.dnf ? '\tdnf' : ''); }).join('\n'))
  };
}

export async function saveCopy(db: D1Database, kind: string, by: string | null | undefined, snapshot: Snapshot, at?: string): Promise<number | null> {
  var s = summarise(snapshot);
  var res = await db.prepare(
    'INSERT INTO tab_snapshots (taken_at, kind, taken_by, digest, summary, snapshot) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
  ).bind(at || stamp(), kind, String(by || ''), s.digest, JSON.stringify({ teams: s.teams, top: s.top }),
    JSON.stringify(snapshot)).run();
  if (kind === 'hour') {
    await db.prepare(
      "DELETE FROM tab_snapshots WHERE kind = 'hour' AND id NOT IN " +
      "(SELECT id FROM tab_snapshots WHERE kind = 'hour' ORDER BY taken_at DESC, id DESC LIMIT ?1)"
    ).bind(HOURLY_KEEP).run();
  }
  return (res.meta && res.meta.last_row_id) || null;
}

// Newest first, without the payloads.
export async function listCopies(db: D1Database): Promise<CopyListing[]> {
  var rows = (await db.prepare(
    'SELECT id, taken_at, kind, taken_by, summary FROM tab_snapshots ORDER BY taken_at DESC, id DESC LIMIT 400'
  ).all<Pick<TabSnapshotRow, 'id' | 'taken_at' | 'kind' | 'taken_by' | 'summary'>>()).results;
  return rows.map(function (r) {
    var s: { teams?: number; top?: { name: string; points: number }[] } = {};
    try { s = (JSON.parse(r.summary || '{}') || {}) as typeof s; } catch (err) { s = {}; }
    return { id: r.id, taken_at: r.taken_at, kind: r.kind, taken_by: r.taken_by, teams: s.teams || 0, top: s.top || [] };
  });
}

export async function readCopy(db: D1Database, id: unknown): Promise<SavedCopy | null> {
  var row = await db.prepare('SELECT id, taken_at, kind, taken_by, snapshot FROM tab_snapshots WHERE id = ?1')
    .bind(Number(id) || 0).first<Pick<TabSnapshotRow, 'id' | 'taken_at' | 'kind' | 'taken_by' | 'snapshot'>>();
  if (!row) return null;
  var snapshot: Snapshot = {};
  try { snapshot = (JSON.parse(row.snapshot || '{}') || {}) as Snapshot; } catch (err) { snapshot = {}; }
  return { id: row.id, taken_at: row.taken_at, kind: row.kind, taken_by: row.taken_by, snapshot: snapshot };
}

// The copy taken just before this one, for what changed between them.
export async function copyBefore(db: D1Database, copy: SavedCopy): Promise<SavedCopy | null> {
  var row = await db.prepare(
    'SELECT id FROM tab_snapshots WHERE taken_at < ?1 OR (taken_at = ?1 AND id < ?2) ORDER BY taken_at DESC, id DESC LIMIT 1'
  ).bind(copy.taken_at, copy.id).first<Pick<TabSnapshotRow, 'id'>>();
  return row ? readCopy(db, row.id) : null;
}

// Just the board, which is all the dashboard draws of a copy.
export function copyBoard(copy: SavedCopy): Omit<LeaderboardTeam, 'last_quest'>[] {
  return boardOf(copy.snapshot).map(function (t) {
    return { rank: t.rank, dnf: !!t.dnf, name: t.name, points: t.points, quests_done: t.quests_done };
  });
}

// The scheduled run's copy: the first tick of each hour saves the live
// standings, unless nobody has scored yet or nothing has moved since the
// last hourly copy. The hour is marked as checked in site_flags, so the
// other ticks of the hour cost one small read; the mark is claimed only
// where it is older, so two runs at once save one copy. Never throws.
export async function hourlyCopy(db: D1Database, renderLive: RenderPayload): Promise<{ ran: boolean; saved?: boolean; id?: number | null; error?: string }> {
  try {
    var hour = Math.floor(Date.now() / 3600000);
    if ((await settingValue(db, 'tab_copy_hour', 0)) >= hour) return { ran: false };
    var claim = await db.prepare(
      "INSERT INTO site_flags (name, value) VALUES ('tab_copy_hour', ?1) " +
      'ON CONFLICT(name) DO UPDATE SET value = ?1 WHERE site_flags.value < ?1'
    ).bind(hour).run();
    if (!claim.meta || claim.meta.changes !== 1) return { ran: false };
    var snapshot = await renderSnapshot(renderLive);
    var s = summarise(snapshot);
    if (!s.scored) return { ran: true, saved: false };
    var last = await db.prepare(
      "SELECT digest FROM tab_snapshots WHERE kind = 'hour' ORDER BY taken_at DESC, id DESC LIMIT 1"
    ).first<Pick<TabSnapshotRow, 'digest'>>();
    if (last && last.digest === s.digest) return { ran: true, saved: false };
    return { ran: true, saved: true, id: await saveCopy(db, 'hour', 'schedule', snapshot) };
  } catch (err) {
    return { ran: false, error: 'tab copy: ' + (errorMessage(err) || String(err)) };
  }
}
