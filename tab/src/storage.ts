// What the event keeps and how much room it takes (the dashboard's
// Settings tab, Storage). The bucket is listed object by object, a few
// thousand a request, and each object is put in an area (proof, albums,
// messages...) and a kind (the file as sent, its thumbnail, a video
// copy at 720p...) from its key, its type and the rows that point at
// it. The page asks again with the cursor until the listing is done and
// adds the answers up. The first answer also carries the database's
// size and rows, and the files as sent by team and by album, read from
// the rows rather than the bucket.

import { json, DERIVED } from './shared.ts';
import type { Env, SubmissionRenditionRow } from './types.ts';

// Every key a row points at: the files with their names, the video
// copies with their height and the file they copy, and the uploads not
// saved yet.
interface KeyMaps {
  files: Record<string, string>;
  copies: Record<string, { height: number; of: string }>;
  staged: Record<string, string>;
}

var LIST_LIMIT = 1000;   // the most one R2 list call returns
var LIST_CALLS = 5;      // list calls a request makes before it answers
var LARGEST = 12;        // the biggest objects kept from each answer

// key prefix -> area, and the table that holds an area's files. A deleted
// quest's files are kept and named for it, "SQ12 (deleted)".
var AREAS: { prefix: string; area: string; sql: string }[] = [
  { prefix: 'sub/', area: 'proof', sql: 'SELECT r2_key AS key, name FROM submission_files' },
  { prefix: 'alb/', area: 'albums', sql: 'SELECT r2_key AS key, name FROM album_photos' },
  { prefix: 'msg/', area: 'messages', sql: 'SELECT key, name FROM message_files' },
  { prefix: 'qst/', area: 'quests',
    sql: "SELECT key, CASE WHEN deleted_key != '' THEN deleted_key || ' (deleted): ' || name ELSE name END AS name FROM quest_files" },
  { prefix: 'slide/', area: 'slides', sql: 'SELECT key, name FROM home_slides' },
  { prefix: 'drop/', area: 'files', sql: 'SELECT key, name FROM drop_files' },
  { prefix: 'trk/', area: 'routes', sql: 'SELECT gpx_key AS key, source AS name FROM team_tracks' },
  { prefix: 'phn/', area: 'phone', sql: "SELECT r2_key AS key, 'Phone message ' || id AS name FROM phone_messages" }
];

// what sits beside a file under its own key with a suffix
var SUFFIX_KINDS: Record<string, string> = { '.t': 'thumb', '.v': 'view', '.x': 'meta', '.p': 'picked' };

async function rowsOf<T>(db: D1Database, sql: string): Promise<T[]> {
  return (await db.prepare(sql).all<T>()).results || [];
}

// Every key a row points at, with its name: the files of each area, the
// video copies with their height and the file they are a copy of, and
// the dashboard uploads not saved yet.
async function keyMaps(db: D1Database): Promise<KeyMaps> {
  var areaQueries = AREAS.map(function (a) { return rowsOf<{ key: string; name: string | null }>(db, a.sql); });
  var copiesQuery = rowsOf<Pick<SubmissionRenditionRow, 'key' | 'height' | 'file_key'>>(db, 'SELECT key, height, file_key FROM submission_renditions');
  var stagedQuery = rowsOf<{ key: string; name: string }>(db, 'SELECT r2_key AS key, name FROM staged_uploads');
  var results = await Promise.all([Promise.all(areaQueries), copiesQuery, stagedQuery]);
  var files: Record<string, string> = {};
  results[0].forEach(function (list) {
    list.forEach(function (r) { files[r.key] = r.name || ''; });
  });
  var copies: Record<string, { height: number; of: string }> = {};
  results[1].forEach(function (r) {
    copies[r.key] = { height: r.height, of: r.file_key };
  });
  var staged: Record<string, string> = {};
  results[2].forEach(function (r) { staged[r.key] = r.name || ''; });
  return { files: files, copies: copies, staged: staged };
}

function areaOf(key: string): string {
  for (var i = 0; i < AREAS.length; i++) {
    if (key.indexOf(AREAS[i].prefix) === 0) return AREAS[i].area;
  }
  return '';
}

function kindOfType(type: string): string {
  if (/^image\//.test(type)) return 'photo';
  if (/^video\//.test(type)) return 'video';
  return 'other';
}

// One object's place: {area, kind, type (the file as sent), name}
export function placeObject(obj: Pick<R2Object, 'key' | 'httpMetadata'>, maps: KeyMaps): { area: string; kind: string; type?: string; name: string } {
  var key = obj.key;
  var type = String((obj.httpMetadata && obj.httpMetadata.contentType) || '').toLowerCase();
  if (key.indexOf('rnd/') === 0) {
    var copy = maps.copies[key];
    if (!copy) return { area: 'other', kind: 'unlinked', name: key };
    return { area: areaOf(copy.of) || 'other', kind: 'copy' + copy.height, name: maps.files[copy.of] || copy.of };
  }
  var area = areaOf(key);
  if (!area) return { area: 'other', kind: 'other', name: key };
  if (Object.prototype.hasOwnProperty.call(maps.files, key)) {
    return { area: area, kind: kindOfType(type), type: type || 'unknown', name: maps.files[key] || key };
  }
  if (Object.prototype.hasOwnProperty.call(maps.staged, key)) {
    return { area: area, kind: 'staged', name: maps.staged[key] || key };
  }
  var suffix = key.slice(-2);
  if (DERIVED.indexOf(suffix) !== -1) {
    var base = key.slice(0, -2);
    var known = Object.prototype.hasOwnProperty.call(maps.files, base);
    if (!known) return { area: area, kind: 'unlinked', name: key };
    // a video's .c is the encoder's full-size copy with the metadata out;
    // a photo's is a copy from before photos were cut as they are served
    var kind = suffix === '.c' ? (/^video\//.test(type) ? 'clean' : 'oldclean') : SUFFIX_KINDS[suffix];
    return { area: area, kind: kind, name: maps.files[base] || base };
  }
  return { area: area, kind: 'unlinked', name: key };
}

function add(totals: Record<string, { n: number; bytes: number }>, name: string, size: number): void {
  var t = totals[name] || (totals[name] = { n: 0, bytes: 0 });
  t.n++;
  t.bytes += size;
}

// The database: its size as D1 reports it, and the rows in each table,
// most first.
async function databaseOf(db: D1Database): Promise<{ bytes: number | null; tables: { name: string; rows: number }[] }> {
  var first = await db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name"
  ).all<{ name: string }>();
  var size = first.meta && typeof first.meta.size_after === 'number' ? first.meta.size_after : null;
  var tables = await Promise.all((first.results || []).map(function (t) {
    return db.prepare('SELECT COUNT(*) AS n FROM "' + String(t.name).replace(/"/g, '""') + '"').first<{ n: number }>()
      .then(function (r) { return { name: t.name, rows: r ? r.n : 0 }; });
  }));
  tables.sort(function (a, b) { return b.rows - a.rows || (a.name < b.name ? -1 : 1); });
  return { bytes: size, tables: tables };
}

// The files as sent, by the team that sent them and by album
async function holdersOf(db: D1Database): Promise<{ teams: { name: string; hidden: boolean; n: number; bytes: number }[]; albums: { name: string; n: number; bytes: number }[] }> {
  var both = await Promise.all([
    rowsOf<{ name: string; hidden: number; n: number; bytes: number }>(db,
      'SELECT t.name AS name, t.hidden AS hidden, COUNT(f.id) AS n, COALESCE(SUM(f.bytes), 0) AS bytes ' +
      'FROM submission_files f JOIN submissions s ON s.id = f.submission_id JOIN teams t ON t.id = s.team_id ' +
      'GROUP BY t.id ORDER BY bytes DESC, t.name'),
    rowsOf<{ name: string; n: number; bytes: number }>(db,
      'SELECT a.name AS name, COUNT(p.id) AS n, COALESCE(SUM(p.bytes), 0) AS bytes ' +
      'FROM album_photos p JOIN albums a ON a.id = p.album_id GROUP BY a.id ORDER BY bytes DESC, a.name')
  ]);
  return {
    teams: both[0].map(function (t) { return { name: t.name, hidden: !!t.hidden, n: t.n, bytes: t.bytes }; }),
    albums: both[1].map(function (a) { return { name: a.name, n: a.n, bytes: a.bytes }; })
  };
}

// GET /api/console/storage?cursor=
export async function storageScan(env: Env, url: URL): Promise<Response> {
  if (!env.SUBMIT) return json({ error: 'no SUBMIT bucket bound' }, 503);
  var cursor = url.searchParams.get('cursor') || '';
  var firstPage = !cursor;
  var extraPromise = firstPage ? Promise.all([databaseOf(env.DB), holdersOf(env.DB)]) : null;
  var maps = await keyMaps(env.DB);
  var places: Record<string, { n: number; bytes: number }> = {};      // area|kind
  var types: Record<string, { n: number; bytes: number }> = {};       // the files as sent, by type
  var largest: { key: string; name: string; area: string; kind: string; bytes: number }[] = [];
  var listed = 0;
  var done = false;
  for (var call = 0; call < LIST_CALLS; call++) {
    var page = await env.SUBMIT.list({ limit: LIST_LIMIT, cursor: cursor || undefined, include: ['httpMetadata'] });
    (page.objects || []).forEach(function (obj) {
      var size = Number(obj.size) || 0;
      var at = placeObject(obj, maps);
      add(places, at.area + '|' + at.kind, size);
      if (at.type) add(types, at.type, size);
      listed++;
      largest.push({ key: obj.key, name: at.name, area: at.area, kind: at.kind, bytes: size });
    });
    if (largest.length > LARGEST * 4) {
      largest.sort(function (a, b) { return b.bytes - a.bytes; });
      largest.length = LARGEST;
    }
    if (!page.truncated) { done = true; cursor = ''; break; }
    cursor = page.cursor;
  }
  largest.sort(function (a, b) { return b.bytes - a.bytes; });
  largest.length = Math.min(largest.length, LARGEST);
  var out: Record<string, unknown> = { ok: true, done: done, cursor: cursor, listed: listed, places: places, types: types, largest: largest };
  if (extraPromise) {
    var extra = await extraPromise;
    out.database = extra[0];
    out.teams = extra[1].teams;
    out.albums = extra[1].albums;
  }
  return json(out);
}
