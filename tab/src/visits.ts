// How a quest shows on the recap's quest page and the replay. Every quest
// shows each team once, when it sent its first accepted submission. The
// dashboard's Recap card can set a quest to show each photo instead
// (`recap_quest_views` in site_text, {KEY: view}), for a quest done at
// many places where one submission often carries photos taken at
// several of them:
//
//   stations  each photo at the station on the submit page's list it was
//             taken at (src/data/stations.ts)
//   places    each photo at the one of the quest's own places it was
//             taken at (its pins)
//
// A photo's place is the one nearest where it was taken, within reach,
// or the place the submission picked when that one is within reach too
// (two stops a street apart, a location read underground); a photo with
// no location in it, or none near, stands for the place the submission
// picked. Its time is when it was taken, unless the camera's clock puts
// that implausibly far from when it was sent. Read by recap.ts. What is
// kept of each file is the places within reach (photo_near), never the
// location.
import { cleanText } from './shared.ts';
import { metaBlock } from './photoserve.ts';
import { readExif, takenUtc } from './strip.ts';
import { videoTakenAt } from './videostrip.ts';
import { recordTaken, parseAnswer } from './submit.ts';
import { km, cleanPins, placeFor, chosenCodes } from './team-map.ts';
import { STATION_POINTS } from './data/stations.ts';
import type { AnswerEntry, Env } from './types.ts';

export type View = 'stations' | 'places';
export var VIEWS: View[] = ['stations', 'places'];
var REACH_KM: Record<View, number> = { stations: 0.5, places: 1 };
var FILE_READS = 24;           // files read from the bucket in one request; the rest on the next
var TAKEN_BEFORE_HOURS = 12;   // a photo dated longer than this before it was sent, or
var TAKEN_AFTER_MINUTES = 5;   // after it, has a camera clock set wrong

interface Place { name: string; points: { lat: number; lng: number }[] }
var STATIONS: Place[] = Object.keys(STATION_POINTS).map(function (name) {
  return { name: name, points: STATION_POINTS[name].map(function (p) { return { lat: p[0], lng: p[1] }; }) };
});

// The places within reach of a point, nearest first.
function near(places: Place[], lat: number, lng: number, reach: number): string[] {
  var found: { name: string; d: number }[] = [];
  places.forEach(function (pl) {
    var d = Infinity;
    pl.points.forEach(function (p) { d = Math.min(d, km({ lat: lat, lng: lng }, p)); });
    if (d <= reach) found.push({ name: pl.name, d: d });
  });
  found.sort(function (a, b) { return a.d - b.d; });
  return found.map(function (f) { return f.name; });
}

// ---------- the setting ----------
export async function questViews(db: D1Database): Promise<Record<string, View>> {
  var out: Record<string, View> = {};
  try {
    var row = await db.prepare("SELECT value FROM site_text WHERE name = 'recap_quest_views'").first<{ value: string }>();
    var v = JSON.parse((row && row.value) || '{}') as Record<string, unknown>;
    Object.keys(v || {}).forEach(function (k) {
      if (VIEWS.indexOf(v[k] as View) !== -1) out[k] = v[k] as View;
    });
  } catch (err) { /* no table, or nothing readable: every quest as sent */ }
  return out;
}

interface Viewed { id: number; key: string; name: string; region: string; view: View; places: Place[]; codes: { code: string; label: string }[] }

// The quests set to show photo by photo, by group id, with what each needs.
export async function viewedQuests(db: D1Database): Promise<Record<number, Viewed>> {
  var views = await questViews(db);
  var byKey: Record<string, View> = {};
  Object.keys(views).forEach(function (k) { byKey[k.toLowerCase()] = views[k]; });
  var out: Record<number, Viewed> = {};
  if (!Object.keys(byKey).length) return out;
  var groups = (await db.prepare('SELECT id, key, name, region, coords FROM quest_groups')
    .all<{ id: number; key: string; name: string; region: string | null; coords: string | null }>()).results;
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    var view = byKey[String(g.key).toLowerCase()];
    if (!view) continue;
    var pins = cleanPins(g.coords);
    out[g.id] = {
      id: g.id, key: g.key, name: g.name, region: g.region || '', view: view,
      places: view === 'stations' ? STATIONS : pins.map(function (p) { return { name: p.label, points: [{ lat: p.lat, lng: p.lng }] }; }),
      codes: view === 'places'
        ? (await db.prepare('SELECT code, label FROM quests WHERE group_id = ?1 ORDER BY sort, norm').bind(g.id).all<{ code: string; label: string }>()).results
        : []
    };
  }
  return out;
}

// Where a visit to a place is drawn: its first point.
function pointOf(q: Viewed, name: string): { lat: number; lng: number } | null {
  for (var i = 0; i < q.places.length; i++) if (q.places[i].name === name) return q.places[i].points[0] || null;
  return null;
}

// The places a submission picked, in the order picked: its pick answers
// that name one of the quest's places, and for a quest's own places also
// the one its codes name (placeFor, which also gives a quest's only place).
function picked(q: Viewed, s: { answer: string | null; credit: string | null; quest_code: string }): string[] {
  var lower: Record<string, string> = {};
  q.places.forEach(function (pl) { lower[pl.name.toLowerCase()] = pl.name; });
  var out: string[] = [];
  var a = parseAnswer(s.answer);
  if (a) {
    ([a] as (AnswerEntry | null)[]).concat(Array.isArray(a.more) ? a.more : []).forEach(function (e) {
      if (!e || e.kind !== 'pick') return;
      (Array.isArray(e.value) ? e.value : [e.value]).forEach(function (v) {
        var name = lower[cleanText(v, 120).toLowerCase()];
        if (name && out.indexOf(name) === -1) out.push(name);
      });
    });
  }
  if (q.view === 'places') {
    var pins = q.places.map(function (pl) { return { label: pl.name, lat: pl.points[0].lat, lng: pl.points[0].lng }; });
    var spot = placeFor(pins, q.codes, chosenCodes(s), false);
    if (spot && out.indexOf(spot.place) === -1) out.push(spot.place);
  }
  return out;
}

interface FileRow { id: number; submission_id: number; group_id: number; r2_key: string; content_type: string; taken_at: string | null }
type Near = { stations: string[]; places: string[] };

// The places within reach of where each file was taken, read from its
// metadata the first time and kept; a file whose taken time was never
// read has it read on the way. A file not read yet is missing from the
// answer, and counts as placed by nothing until it is.
async function fileNear(env: Env, files: FileRow[], quests: Record<number, Viewed>): Promise<Record<number, Near>> {
  var out: Record<number, Near> = {};
  if (!files.length) return out;
  var db = env.DB;
  var list = function (text: string): string[] {
    try { var v = JSON.parse(text || '[]'); return Array.isArray(v) ? v.map(String) : []; } catch (err) { return []; }
  };
  (await db.prepare('SELECT file_id, stations, places FROM photo_near WHERE file_id IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(files.map(function (f) { return f.id; }))).all<{ file_id: number; stations: string; places: string }>()).results.forEach(function (r) {
    out[r.file_id] = { stations: list(r.stations), places: list(r.places) };
  });
  var missing = files.filter(function (f) { return !(f.id in out); }).slice(0, FILE_READS);
  if (!missing.length || !env.SUBMIT) return out;
  var writes: D1PreparedStatement[] = [];
  var times: { key: string; taken: string }[] = [];
  for (var i = 0; i < missing.length; i++) {
    var f = missing[i];
    var q = quests[f.group_id];
    var found: Near = { stations: [], places: [] };
    try {
      var exif = readExif(await metaBlock(env, f.r2_key, f.content_type));
      if (exif.gps) {
        found.stations = near(STATIONS, exif.gps.lat, exif.gps.lng, REACH_KM.stations);
        if (q && q.view === 'places') found.places = near(q.places, exif.gps.lat, exif.gps.lng, REACH_KM.places);
      }
      if (f.taken_at === null) {
        var taken = takenUtc(exif) || (f.content_type.indexOf('video/') === 0 ? await videoTakenAt(env.SUBMIT, f.r2_key) : '');
        times.push({ key: f.r2_key, taken: taken });
        f.taken_at = taken;
      }
    } catch (err) { /* a file that cannot be read says nothing */ }
    out[f.id] = found;
    writes.push(db.prepare('INSERT OR REPLACE INTO photo_near (file_id, stations, places) VALUES (?1, ?2, ?3)')
      .bind(f.id, JSON.stringify(found.stations), JSON.stringify(found.places)));
  }
  // and nothing kept for a file that has gone with its submission
  writes.push(db.prepare('DELETE FROM photo_near WHERE file_id NOT IN (SELECT id FROM submission_files)'));
  await db.batch(writes);
  await recordTaken(env, times);
  return out;
}

// What a quest's files are read against changes with its setting (a
// quest's own places, or none), so they are read again.
export async function forgetNear(db: D1Database, groupId: number): Promise<void> {
  await db.prepare(
    'DELETE FROM photo_near WHERE file_id IN (SELECT f.id FROM submission_files f JOIN submissions s ON s.id = f.submission_id ' +
    'JOIN quests q ON q.code = s.quest_code WHERE q.group_id = ?1)'
  ).bind(groupId).run();
}

function stampMs(stamp: string | null | undefined): number {
  var t = Date.parse(String(stamp || '').replace(' ', 'T').slice(0, 19) + 'Z');
  return isNaN(t) ? NaN : t;
}
function stampOf(ms: number): string { return new Date(ms).toISOString().replace('T', ' ').slice(0, 19); }

// When a file was taken, or when it was sent if the file says nothing
// or its clock was wrong.
function whenTaken(taken: string | null, sent: string): { at: string; taken: boolean } {
  var t = stampMs(taken);
  var s = stampMs(sent);
  if (isFinite(t) && isFinite(s) && t <= s + TAKEN_AFTER_MINUTES * 60000 && t >= s - TAKEN_BEFORE_HOURS * 3600000) {
    return { at: stampOf(t), taken: true };
  }
  return { at: sent, taken: false };
}

export interface Visit {
  place: string;
  at: string;
  lat: number;
  lng: number;
  // the time is when the photo was taken, not when it was sent
  taken: boolean;
}
export interface TeamVisits { team_id: number; team: string; group_id: number; view: View; visits: Visit[] }

// Each visible team's places for each quest set to show photo by photo,
// in the order visited, a place counted at its first visit. Every photo
// or video of an accepted submission is a visit (its place, as above),
// and a place the submission picked that none of its files placed is a
// visit at the time of its earliest file placed by nothing, or when it
// was sent. Nothing here changes a score.
export async function photoVisits(env: Env, only?: number): Promise<TeamVisits[]> {
  var quests = await viewedQuests(env.DB);
  var ids = Object.keys(quests).map(Number).filter(function (id) { return !only || id === only; });
  if (!ids.length) return [];
  var subs = (await env.DB.prepare(
    'SELECT s.id, s.team_id, t.name AS team, q.group_id, s.quest_code, s.submitted_at AS sent, s.answer, s.credit FROM submissions s ' +
    'JOIN quests q ON q.code = s.quest_code JOIN teams t ON t.id = s.team_id AND t.hidden = 0 ' +
    "WHERE s.status = 'accepted' AND q.group_id IN (SELECT value FROM json_each(?1)) ORDER BY s.submitted_at, s.id"
  ).bind(JSON.stringify(ids)).all<{ id: number; team_id: number; team: string; group_id: number; quest_code: string; sent: string;
    answer: string | null; credit: string | null }>()).results;
  if (!subs.length) return [];
  var groupOf: Record<number, number> = {};
  subs.forEach(function (s) { groupOf[s.id] = s.group_id; });
  var files = (await env.DB.prepare(
    'SELECT id, submission_id, r2_key, content_type, taken_at FROM submission_files ' +
    "WHERE submission_id IN (SELECT value FROM json_each(?1)) AND status = 'ready' " +
    "AND (content_type LIKE 'image/%' OR content_type LIKE 'video/%') ORDER BY id"
  ).bind(JSON.stringify(subs.map(function (s) { return s.id; }))).all<FileRow>()).results;
  files.forEach(function (f) { f.group_id = groupOf[f.submission_id]; });
  var nearBy = await fileNear(env, files, quests);
  var bySub: Record<number, FileRow[]> = {};
  files.forEach(function (f) { (bySub[f.submission_id] = bySub[f.submission_id] || []).push(f); });

  var out: Record<string, TeamVisits & { seen: Record<string, number> }> = {};
  function add(s: { team_id: number; team: string; group_id: number }, place: string, when: { at: string; taken: boolean }) {
    var q = quests[s.group_id];
    var point = pointOf(q, place);
    if (!point) return;
    var k = s.team_id + '|' + s.group_id;
    var t = out[k] || (out[k] = { team_id: s.team_id, team: s.team, group_id: s.group_id, view: q.view, visits: [], seen: {} });
    var v: Visit = { place: place, at: when.at, lat: point.lat, lng: point.lng, taken: when.taken };
    var was = t.seen[place];
    if (was === undefined) { t.seen[place] = t.visits.length; t.visits.push(v); }
    else if (v.at < t.visits[was].at) t.visits[was] = v;
  }
  subs.forEach(function (s) {
    var q = quests[s.group_id];
    var picks = picked(q, s);
    var placed: Record<string, boolean> = {};
    var spare: { at: string; taken: boolean } | null = null;
    (bySub[s.id] || []).forEach(function (f) {
      var n = nearBy[f.id];
      var close = n ? (q.view === 'stations' ? n.stations : n.places) : [];
      var when = whenTaken(f.taken_at, s.sent);
      var place = picks.filter(function (p) { return close.indexOf(p) !== -1; })[0] || close[0] || '';
      if (place) {
        placed[place] = true;
        add(s, place, when);
      } else if (!spare || when.at < spare.at) {
        spare = when;
      }
    });
    var fallback: { at: string; taken: boolean } = spare || { at: s.sent, taken: false };
    picks.forEach(function (p) { if (!placed[p]) add(s, p, fallback); });
  });
  return Object.keys(out).map(function (k) {
    var t = out[k];
    t.visits.sort(function (a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; });
    return { team_id: t.team_id, team: t.team, group_id: t.group_id, view: t.view, visits: t.visits };
  });
}
