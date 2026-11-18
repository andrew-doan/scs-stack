// The route each team recorded for the GPS quest, as the replay draws
// it. The dashboard's Routes tab cleans a GPX file in the browser with
// the site's cleaner (website/tab/replay/track-clean.js) and saves
// what comes out here, one row a team; the GPX file it came from is kept
// in the bucket under trk/, or named by its key when it is one the team
// sent as proof, so it can be cleaned again. The replay reads the routes
// through /api/replay and /api/replay/route, behind the replay switch
// (recap.ts). tracks/CLAUDE.md says how the cleaning decides.

import { json, cleanText, randomKey, deleteStored } from './shared.ts';
import { fileKindOf } from './rules.ts';
import type { ConsoleSession, Env, JsonBody, LogAction, SubmissionFileRow, TeamRow } from './types.ts';

/** `team_tracks` */
export interface TeamTrackRow {
  team_id: number;
  route: string;
  points: number;
  started_at: string;
  ended_at: string;
  source: string;
  gpx_key: string;
  edits: string;
  notes: string;
  saved_at: string;
  saved_by: string;
}

// The replay's copy of a route: times in seconds from t0 and positions
// in 1e-5 degrees, each the difference from the one before, then the
// rides and the stops.
export interface Route {
  v: 1;
  team: string;
  t0: number;
  t: number[];
  y: number[];
  x: number[];
  legs: { mode: string; from: string; to: string; t0: number; t1: number; filled?: 1 }[];
  stays: { t0: number; t1: number; lat: number; lon: number }[];
}

var MAX_POINTS = 20000;
var MAX_ROUTE_BYTES = 600 * 1024;
var MAX_GPX_BYTES = 25 * 1024 * 1024;
var MODES = ['train', 'metro', 'tram'];

function whole(v: unknown): v is number { return typeof v === 'number' && isFinite(v) && Math.round(v) === v; }
function stamp(t: number): string { return new Date(t * 1000).toISOString().slice(0, 19).replace('T', ' '); }

// A route as the cleaner writes it, rebuilt from what was sent with
// nothing else kept, or why it is not one. The positions have to stay in
// Greater Sydney and the times inside one day.
export function checkRoute(raw: unknown): { route: Route } | { error: string } {
  var bad = { error: 'That is not a route the cleaner made.' };
  if (!raw || typeof raw !== 'object') return bad;
  var r = raw as Record<string, unknown>;
  if (r.v !== 1 || !whole(r.t0) || !Array.isArray(r.t) || !Array.isArray(r.y) || !Array.isArray(r.x)) return bad;
  var t = r.t as unknown[], y = r.y as unknown[], x = r.x as unknown[];
  var n = t.length;
  if (n < 2 || n > MAX_POINTS || y.length !== n || x.length !== n) return { error: 'A route needs 2 to ' + MAX_POINTS + ' points.' };
  if (!t.every(whole) || !y.every(whole) || !x.every(whole)) return bad;
  var at = r.t0 as number, lat = 0, lon = 0;
  for (var i = 0; i < n; i++) {
    at += t[i] as number; lat += y[i] as number; lon += x[i] as number;
    if (i && (t[i] as number) <= 0) return { error: 'The route\'s times have to go forwards.' };
    if (lat < -3500000 || lat > -3250000 || lon < 14950000 || lon > 15250000) return { error: 'The route leaves Sydney.' };
  }
  if (at - (r.t0 as number) > 86400) return { error: 'A route covers one day at most.' };
  var legs: Route['legs'] = [];
  if (!Array.isArray(r.legs) || !Array.isArray(r.stays)) return bad;
  for (var j = 0; j < Math.min(r.legs.length, 400); j++) {
    var l = r.legs[j] as Record<string, unknown>;
    if (!l || MODES.indexOf(String(l.mode)) === -1 || !whole(l.t0) || !whole(l.t1)) return bad;
    var leg: Route['legs'][number] = { mode: String(l.mode), from: cleanText(l.from, 60), to: cleanText(l.to, 60), t0: l.t0, t1: l.t1 };
    if (l.filled) leg.filled = 1;
    legs.push(leg);
  }
  var stays: Route['stays'] = [];
  for (var k = 0; k < Math.min(r.stays.length, 1000); k++) {
    var s = r.stays[k] as Record<string, unknown>;
    if (!s || !whole(s.t0) || !whole(s.t1) || typeof s.lat !== 'number' || typeof s.lon !== 'number') return bad;
    stays.push({ t0: s.t0, t1: s.t1, lat: Math.round(s.lat * 1e5) / 1e5, lon: Math.round(s.lon * 1e5) / 1e5 });
  }
  return { route: { v: 1, team: cleanText(r.team, 120), t0: r.t0 as number, t: t as number[], y: y as number[], x: x as number[], legs: legs, stays: stays } };
}

// What was cut from the GPX file before it was cleaned, in Sydney's
// clock times on the day: everything before `from` and after `to`, and
// each stretch in `cut`. Kept so the route can be cleaned again the same
// way. Anything else sent is dropped; '' when nothing was cut.
export interface Edits { from: string; to: string; cut: [string, string][] }
var CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;
export function cleanEdits(raw: unknown): string {
  var got: unknown = raw;
  if (typeof raw === 'string') {
    try { got = raw ? JSON.parse(raw) : null; } catch (err) { got = null; }
  }
  if (!got || typeof got !== 'object') return '';
  var e = got as Record<string, unknown>;
  var out: Edits = { from: '', to: '', cut: [] };
  if (CLOCK.test(String(e.from))) out.from = String(e.from);
  if (CLOCK.test(String(e.to))) out.to = String(e.to);
  if (Array.isArray(e.cut)) {
    e.cut.slice(0, 20).forEach(function (c: unknown) {
      if (Array.isArray(c) && CLOCK.test(String(c[0])) && CLOCK.test(String(c[1])) && String(c[0]) < String(c[1])) out.cut.push([String(c[0]), String(c[1])]);
    });
  }
  return out.from || out.to || out.cut.length ? JSON.stringify(out) : '';
}

// when a route starts and ends, as UTC stamps
function span(route: Route): { from: string; to: string } {
  var end = route.t0;
  for (var i = 0; i < route.t.length; i++) end += route.t[i];
  return { from: stamp(route.t0), to: stamp(end) };
}

// ---------- what the replay reads ----------

// Which visible teams have a route, by team id, with when it was saved.
export async function routeStamps(db: D1Database): Promise<Record<number, string>> {
  var out: Record<number, string> = {};
  (await db.prepare('SELECT team_id, saved_at FROM team_tracks').all<Pick<TeamTrackRow, 'team_id' | 'saved_at'>>()).results
    .forEach(function (r) { out[r.team_id] = r.saved_at; });
  return out;
}

// One visible team's route by its name, any case, with the team's name
// as the tab has it.
export async function routeFor(db: D1Database, name: unknown): Promise<Route | null> {
  var wanted = cleanText(name, 120);
  if (!wanted) return null;
  var row = await db.prepare(
    'SELECT r.route, t.name FROM team_tracks r JOIN teams t ON t.id = r.team_id WHERE t.name = ?1 COLLATE NOCASE AND t.hidden = 0'
  ).bind(wanted).first<{ route: string; name: string }>();
  if (!row) return null;
  var route = JSON.parse(row.route) as Route;
  route.team = row.name;
  return route;
}

// ---------- the dashboard ----------

// GET tracks: every saved route without its points, and the GPX files
// teams sent as proof, which the tab offers to clean.
async function listTracks(env: Env): Promise<Response> {
  var rows = (await env.DB.prepare('SELECT * FROM team_tracks').all<TeamTrackRow>()).results;
  var sent = (await env.DB.prepare(
    'SELECT s.team_id, s.submitted_at, s.status, f.r2_key, f.name, f.content_type, f.bytes, f.status AS file_status ' +
    "FROM submission_files f JOIN submissions s ON s.id = f.submission_id WHERE s.status <> 'deleted' ORDER BY s.submitted_at"
  ).all<{ team_id: number; submitted_at: string; status: string; r2_key: string; name: string | null; content_type: string; bytes: number; file_status: string }>()).results
    .filter(function (f) { return f.file_status !== 'uploading' && fileKindOf(f.content_type, f.name) === 'gpx'; })
    .map(function (f) { return { team_id: f.team_id, key: f.r2_key, name: f.name || 'track.gpx', bytes: f.bytes, sent_at: f.submitted_at, status: f.status }; });
  return json({
    ok: true,
    tracks: rows.map(function (r) {
      return { team_id: r.team_id, points: r.points, started_at: r.started_at, ended_at: r.ended_at, source: r.source,
        has_gpx: !!r.gpx_key, sent_key: r.gpx_key.indexOf('sub/') === 0 ? r.gpx_key : '', edits: r.edits ? JSON.parse(r.edits) : null, notes: r.notes, saved_at: r.saved_at, saved_by: r.saved_by };
    }),
    sent: sent
  }, 200, { 'cache-control': 'no-store' });
}

// GET tracks/gpx?key= (a GPX file a team sent as proof) or ?team_id=
// (the one a saved route came from): its words, to clean in the browser
// or save as a file
async function gpxText(env: Env, url: URL): Promise<Response> {
  if (!env.SUBMIT) return json({ error: 'no SUBMIT bucket bound' }, 503);
  var key = url.searchParams.get('key') || '';
  var name = 'track.gpx';
  if (url.searchParams.get('team_id')) {
    var row = await env.DB.prepare('SELECT gpx_key, source FROM team_tracks WHERE team_id = ?1')
      .bind(Number(url.searchParams.get('team_id')) || 0).first<Pick<TeamTrackRow, 'gpx_key' | 'source'>>();
    if (!row || !row.gpx_key) return json({ error: 'not found' }, 404);
    key = row.gpx_key;
    name = row.source || name;
  } else {
    if (key.indexOf('sub/') !== 0) return json({ error: 'not found' }, 404);
    var file = await env.DB.prepare('SELECT content_type, name, status FROM submission_files WHERE r2_key = ?1')
      .bind(key).first<Pick<SubmissionFileRow, 'content_type' | 'name' | 'status'>>();
    if (!file || file.status === 'uploading' || fileKindOf(file.content_type, file.name) !== 'gpx') return json({ error: 'not found' }, 404);
    name = file.name || name;
  }
  var stored = await env.SUBMIT.get(key);
  if (!stored) return json({ error: 'not found' }, 404);
  if (stored.size > MAX_GPX_BYTES) return json({ error: 'That GPX file is too large to clean here.' }, 413);
  return json({ ok: true, name: name, text: new TextDecoder().decode(await stored.arrayBuffer()) }, 200, { 'cache-control': 'no-store' });
}

// POST tracks/save (multipart): team_id, route (the cleaner's JSON),
// source (the GPX file's name), edits, notes, and the GPX file as `gpx`,
// or as `gpx_key` when it is one the team sent as proof. With neither,
// the route keeps the GPX file it had.
async function saveTrack(env: Env, session: ConsoleSession, request: Request, logAction: LogAction): Promise<Response> {
  var form: FormData;
  try { form = await request.formData(); } catch (err) { return json({ error: 'Send the route as a form.' }, 400); }
  var team = await env.DB.prepare('SELECT id, name FROM teams WHERE id = ?1')
    .bind(Number(form.get('team_id')) || 0).first<Pick<TeamRow, 'id' | 'name'>>();
  if (!team) return json({ error: 'Pick a team.' }, 400);
  var text = String(form.get('route') || '');
  if (text.length > MAX_ROUTE_BYTES) return json({ error: 'That route is too long.' }, 413);
  var parsed: unknown;
  try { parsed = JSON.parse(text); } catch (err) { return json({ error: 'That is not a route the cleaner made.' }, 400); }
  var checked = checkRoute(parsed);
  if ('error' in checked) return json({ error: checked.error }, 400);
  var route = checked.route;
  route.team = team.name;

  var old = await env.DB.prepare('SELECT gpx_key FROM team_tracks WHERE team_id = ?1').bind(team.id).first<Pick<TeamTrackRow, 'gpx_key'>>();

  // the GPX file it came from: sent here and kept under trk/, or one of
  // the team's own proof files, named by its key
  var gpxKey = old ? old.gpx_key : '';
  var upload = form.get('gpx');
  var sentKey = String(form.get('gpx_key') || '');
  if (upload && typeof upload === 'object' && 'arrayBuffer' in upload) {
    var gpxFile = upload as File;
    if (gpxFile.size > MAX_GPX_BYTES) return json({ error: 'That GPX file is larger than 25MB.' }, 413);
    var bytes = await gpxFile.arrayBuffer();
    var head = new TextDecoder().decode(bytes.slice(0, 2048));
    if (!/<gpx\b/i.test(head)) return json({ error: 'That file is not a GPX file.' }, 400);
    if (!env.SUBMIT) return json({ error: 'no SUBMIT bucket bound' }, 503);
    gpxKey = 'trk/' + randomKey(12);
    await env.SUBMIT.put(gpxKey, bytes, { httpMetadata: { contentType: 'application/gpx+xml' } });
  } else if (sentKey) {
    var file = await env.DB.prepare('SELECT f.content_type, f.name FROM submission_files f JOIN submissions s ON s.id = f.submission_id WHERE f.r2_key = ?1 AND s.team_id = ?2')
      .bind(sentKey, team.id).first<Pick<SubmissionFileRow, 'content_type' | 'name'>>();
    if (!file || fileKindOf(file.content_type, file.name) !== 'gpx') return json({ error: 'That is not a GPX file this team sent.' }, 400);
    gpxKey = sentKey;
  }

  var when = span(route);
  await env.DB.prepare(
    'INSERT INTO team_tracks (team_id, route, points, started_at, ended_at, source, gpx_key, edits, notes, saved_at, saved_by) ' +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, datetime('now'), ?10) " +
    'ON CONFLICT(team_id) DO UPDATE SET route = ?2, points = ?3, started_at = ?4, ended_at = ?5, source = ?6, gpx_key = ?7, edits = ?8, notes = ?9, ' +
    "saved_at = datetime('now'), saved_by = ?10"
  ).bind(team.id, JSON.stringify(route), route.t.length, when.from, when.to, cleanText(form.get('source'), 120),
    gpxKey, cleanEdits(String(form.get('edits') || '')), String(form.get('notes') || '').slice(0, 4000), session.name).run();
  // a GPX file of ours that nothing points at any more
  if (old && old.gpx_key && old.gpx_key !== gpxKey && old.gpx_key.indexOf('trk/') === 0) await deleteStored(env.SUBMIT, old.gpx_key);
  await logAction(env.DB, session.name, 'track-save', team.name, '-', 0, 0, 0);
  return json({ ok: true, points: route.t.length, started_at: when.from, ended_at: when.to });
}

// POST tracks/delete {team_id}
async function deleteTrack(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var team = await env.DB.prepare('SELECT id, name FROM teams WHERE id = ?1').bind(Number(body.team_id) || 0).first<Pick<TeamRow, 'id' | 'name'>>();
  if (!team) return json({ error: 'no such team' }, 404);
  var gone = await forgetTrack(env, team.id);
  if (!gone) return json({ error: 'That team has no route.' }, 404);
  await logAction(env.DB, session.name, 'track-delete', team.name, '-', 0, 0, 0);
  return json({ ok: true });
}

// A team's route and its GPX file of ours, when the team is deleted too.
export async function forgetTrack(env: Env, teamId: number): Promise<boolean> {
  var row = await env.DB.prepare('SELECT gpx_key FROM team_tracks WHERE team_id = ?1').bind(teamId).first<Pick<TeamTrackRow, 'gpx_key'>>();
  if (!row) return false;
  await env.DB.prepare('DELETE FROM team_tracks WHERE team_id = ?1').bind(teamId).run();
  if (row.gpx_key.indexOf('trk/') === 0) await deleteStored(env.SUBMIT, row.gpx_key);
  return true;
}

// Every tracks/ action, before the router reads a JSON body: a save
// comes as a form.
export async function tracksConsole(env: Env, session: ConsoleSession, request: Request, action: string, url: URL, logAction: LogAction): Promise<Response | null> {
  if (request.method === 'GET') {
    if (action === 'tracks') return listTracks(env);
    if (action === 'tracks/gpx') return gpxText(env, url);
    return null;
  }
  if (request.method !== 'POST') return null;
  if (action === 'tracks/save') return saveTrack(env, session, request, logAction);
  if (action === 'tracks/delete') {
    var body: JsonBody;
    try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
    return deleteTrack(env, session, body, logAction);
  }
  return null;
}
