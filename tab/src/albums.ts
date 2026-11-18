// Albums: photo albums anyone can look at on the site's /albums page,
// made on the dashboard. Each says who may add to it: teams signed in
// with their submit code, anyone at all, or nobody but the organisers.
// One can also show the gallery — accepted submissions whose team
// ticked the gallery box — or only the gallery submissions of the teams
// picked for it (album_teams), read live, so a submission accepted later
// appears without anyone copying it in. An organiser takes a photo out
// of an album: an uploaded one is deleted, a gallery one is only kept
// out of that album (album_skips) and can be put back. An album is on
// the list, or seen only by those with its link (/albums/?k=<link_key>,
// random, where the address made from its name answers not found), or
// seen only by organisers.
//
// Uploads go in the proof bucket under alb/ the way proof does under
// sub/: the original, the metadata block that came out of it (.x), the
// small copy and viewing copy the sender's browser made (.t, .v), and
// for a photo the page made a JPEG of, the HEIC or WebP it was picked as
// (.p, see submit.ts), handed out only where the album shows details.
// The file endpoint serves a photo with its metadata cut out as it
// streams (photoserve.ts) and never the original as it is, so where a
// photo was taken is never handed out. A video goes through the proof
// videos' encoder (see submit.ts): it is on the site once the encoder
// has made its smaller copies and its clean one, and not before, since
// until then there is nothing of it that can be served. A file over
// MAX_FILE_BYTES comes in slices after the upload that names it, each
// carrying the token that upload handed back; a photo sent that way is
// checked by its first bytes when its last slice lands.
//
// One photo can be shared on its own: /photo/<share> on the worker is a
// page with that photo and nothing of the album, carrying the Open
// Graph tags a chat app reads, so a link pasted into Discord shows the
// picture. It answers only while the photo is somewhere it can be seen.
// /view/<key> draws the same page for any proof or album file by its
// key, and is where a shared video's link goes: the video plays there
// in the site's player (assets/video-sizes.js), Auto and a menu of its
// sizes included.

import { corsJson, json, cleanText, randomKey, b64url, serveStoredFile, animatedType, secretMatches, asDownload, deleteStored, servePickedFile, settingValue, configured, fileNameFor, fields, isBlobLike } from './shared.ts';
import { requireTeam, storePreview, bytesMatch, wantsSmaller, renditionFor, largestRendition, STAND_IN_CACHE, takenOf, recordTaken, noteTaken,
  storePicked, pickedDeclared, recordPicked, pickedOf, pickedUrl, settlePicked } from './submit.ts';
import { serveCleanPhoto, metaBlock, writeBlock } from './photoserve.ts';
import { baseType, imageMatches, readExif, takenUtc } from './strip.ts';
import { turnstileOk, turnstileSiteKey } from './rego.ts';
import { SHOWN, heightsFor, viewedFile, mediaPage, gonePage, wantsPage, VARY, teamPicked, showsGallery, detailsHolder, photoVersion } from './sharepage.ts';
import { directReady, directStart, directPartUrl, directAbort, directJoin, directCopy, markDirect, isDirect, directIdOf } from './r2direct.ts';
import { bumpCounter } from './messages.ts';
import { serveUploadedVideo } from './videostrip.ts';
import { zipPlan, zipStream, zipNames } from './zip.ts';
import { nameDeleted } from './deleted.ts';
import type { PickedNote, Taken } from './submit.ts';
import type { MediaItem } from './sharepage.ts';
import type { AlbumPhotoRow, AlbumRow, AlbumTeamRow, AlbumUploadPartRow, ConsoleSession, Env, JsonBody, LogAction, SubmissionRenditionRow,
  TeamRow } from './types.ts';

// An album as the dashboard and the site read it (albumOut).
interface AlbumOut {
  id: number;
  slug: string;
  name: string;
  about: string;
  adding: string;
  gallery: boolean;
  hidden: boolean;
  show_hidden: boolean;
  details: boolean;
  sort: number;
  created_at: string;
  default_order: string;
  visibility: string;
  link_key: string;
  merges: number[];
  turnstile?: string;
}
// The albums merged into one, read once.
interface Merge {
  ids: number[];
  gallery: boolean;
  showHidden: boolean;
  names: Record<number, string>;
  hidden: Record<number, boolean>;
}
// One item of an album as ITEMS reads it.
type ItemRow = { src: string; id: number; key: string; type: string; at: string; taken: string; status: string; encode: string; w: number; h: number;
  added_by: string; name: string | null; team: string | null; team_hidden: number; quest: string; skipped: number; picked: string; ver: number;
  points_to: string; album_id: number };
// One photo or video as the album page and the Files tab list it.
interface PhotoOut {
  key: string;
  type: string;
  from: string;
  team: string;
  by: string;
  at: string;
  share?: string;
  quest?: string;
  via?: string;
  taken?: string;
  picked?: string;
  processing?: boolean;
  w?: number;
  h?: number;
  ver?: number;
  hidden_team?: boolean;
  skipped?: boolean;
  state?: string;
  name?: string;
  points_to?: string;
  heights?: number[];
}
// The people a page asked for, by= and not=.
type Filter = { by: string[]; not: string[] };
// An upload's row for the file route, with the photo it points to.
type OwnRow = Pick<AlbumPhotoRow, 'content_type' | 'status' | 'name'> & { encode_state?: string; to_key?: string | null; to_ver?: number | null };
// A photo an upload may replace, with the team that added it.
type TargetRow = AlbumPhotoRow & { team: string | null };
// Who is adding: a team, a name typed, and the address for the hourly limit.
type Who = { team_id: number | null; by: string; ip: string };
// What an upload stored: how many went in, which photos were replaced,
// and the large files whose slices are still to come.
interface Stored {
  added: number;
  replaced: { name: string; png: boolean }[];
  uploads: { file: number; name: string; size: number; part_size: number; token: string; direct: boolean; picked?: boolean; replaces?: { png: boolean } }[];
}
// A file still arriving in slices. Every such row has its slice size
// and its upload's id.
type AlbumUpload = Pick<AlbumPhotoRow, 'id' | 'r2_key' | 'content_type' | 'name' | 'bytes' | 'upload_token' | 'status'> &
  { part_size: number; upload_id: string };
// A gallery file shown in an album the public can see.
type GalleryHit = { r2_key: string; content_type: string; encode_state: string; quest_code: string; team: string };
// One file of an album's ZIP, and the parts they are split into.
type ZipRow = { key: string; type: string; name: string | null; at: string; taken: string; src: string; id: number; bytes: number };
type ZipPart = { items: ZipRow[]; bytes: number };

export var ADDING = ['teams', 'anyone', 'closed'];
var PHOTO_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
var MAX_FILES = 10;                       // in one upload
var MAX_FILE_BYTES = 25 * 1024 * 1024;    // sent whole; anything larger goes in slices
var MAX_REQUEST_BYTES = 90 * 1024 * 1024; // under the Workers request cap
var MAX_BIG_BYTES = 4 * 1024 * 1024 * 1024; // per file, as for proof
var PART_BYTES = 20 * 1024 * 1024;        // one slice, as for proof
var MAX_THUMB_BYTES = 300 * 1024;
var MAX_VIEW_BYTES = 2 * 1024 * 1024;
// photos and videos one address may add to "anyone" albums in an hour,
// until the Settings tab says otherwise (album_anyone_per_hour)
export var ANYONE_PER_HOUR = 40;
// how long the pass an upload hands back lets the rest of a pick through
var PASS_MINUTES = 30;
var LIST_MAX = 2000;
var FOREVER = 'public, max-age=31536000, immutable';
// an original goes out only while its album shows details, so it is not
// kept for long anywhere
var ORIGINAL_CACHE = 'private, max-age=3600';
// the originals a browser can show
var ORIGINAL_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
var CORS = Object.assign({ 'access-control-allow-origin': '*' }, VARY);
var NO_STORE = { 'cache-control': 'no-store' };

function slugFrom(name: unknown): string {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'album';
}

function isVideoType(type: unknown): boolean { return /^video\/[\w.+-]+$/.test(baseType(type)); }
function typeOk(type: unknown): boolean { return PHOTO_TYPES.indexOf(baseType(type)) !== -1 || isVideoType(type); }
function size(raw: unknown): number {
  var n = Math.round(Number(raw));
  return isFinite(n) && n > 0 && n < 100000 ? n : 0;
}

async function ipHash(request: Request): Promise<string> {
  var ip = request.headers.get('cf-connecting-ip') || 'unknown';
  var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('scs2-album:' + ip));
  var arr = new Uint8Array(digest).slice(0, 6);
  var hex = '';
  for (var i = 0; i < arr.length; i++) hex += (arr[i] + 256).toString(16).slice(1);
  return hex;
}

export var VISIBILITY = ['listed', 'link', 'hidden'];

// What a photo's share link carries in place of its key: the album
// upload's random part, or g/ and a gallery file's.
function shareId(key: string): string {
  return key.indexOf('alb/') === 0 ? key.slice(4) : 'g/' + key.slice(4);
}
function keyOfShare(id: unknown): string {
  var given = String(id || '');
  if (/^g\/(\d+\/)?[A-Za-z0-9_-]{6,64}$/.test(given)) return 'sub/' + given.slice(2);
  if (/^[A-Za-z0-9_-]{6,64}$/.test(given)) return 'alb/' + given;
  return '';
}

function albumOut(a: AlbumRow): AlbumOut {
  return {
    id: a.id, slug: a.slug, name: a.name, about: a.about, adding: a.adding,
    gallery: !!a.gallery, hidden: !!a.hidden, show_hidden: !!a.show_hidden, details: !!a.details, sort: a.sort, created_at: a.created_at,
    default_order: a.photo_order === 'taken' ? 'taken' : 'added',
    visibility: a.hidden ? 'hidden' : a.unlisted ? 'link' : 'listed', link_key: a.link_key || '',
    merges: mergeIds(a)
  };
}

// ---------- merged albums ----------
// An album can show other albums' photos and videos as well as its own
// (albums.merges, a JSON list of their ids): their uploads, and their
// part of the gallery — the whole of it where one of them shows it, the
// teams they picked otherwise — with a gallery file taken out of any of
// them left out. One level: an album merged in brings its own, not the
// albums merged into it.
function mergeIds(a: Pick<AlbumRow, 'id' | 'merges'>): number[] {
  var list: unknown;
  try { list = JSON.parse((a && a.merges) || '[]'); } catch (err) { return []; }
  if (!Array.isArray(list)) return [];
  return list.map(Number).filter(function (n, i, all) { return n > 0 && Math.floor(n) === n && n !== a.id && all.indexOf(n) === i; });
}
async function mergeOf(db: D1Database, album: AlbumRow): Promise<Merge> {
  var ids = mergeIds(album);
  var out: Merge = { ids: [], gallery: false, showHidden: false, names: {}, hidden: {} };
  if (!ids.length) return out;
  var rows = (await db.prepare('SELECT id, name, gallery, show_hidden, hidden FROM albums WHERE id IN (SELECT value FROM json_each(?1))')
    .bind(JSON.stringify(ids)).all<Pick<AlbumRow, 'id' | 'name' | 'gallery' | 'show_hidden' | 'hidden'>>()).results;
  rows.forEach(function (r) {
    out.ids.push(r.id);
    out.names[r.id] = r.name;
    if (r.hidden) out.hidden[r.id] = true;
    if (r.gallery) out.gallery = true;
    if (r.show_hidden) out.showHidden = true;
  });
  return out;
}

// Where a video is up to, for the dashboard: still arriving, waiting
// for the encoder, being encoded, done, or tried with nothing to show.
function videoState(status: string, encode: string): string {
  if (status === 'uploading') return 'uploading';
  return encode === 'encoding' ? 'encoding' : encode === 'done' ? 'done' : encode === 'skipped' ? 'skipped' : 'waiting';
}

// Every photo and video in an album as one list the database orders and
// pages: its own uploads and, when it shows the gallery or picked teams'
// part of it, the gallery's.
// The public read leaves out a hidden team's (unless the album is set to
// show them), a gallery file taken out of this album and anything still
// uploading. A video the encoder has not finished is in it as
// `processing`, with no share id: the page plays it as it was sent
// (`uploaded=1`), and shows its still where the browser cannot play that.
// `everything` is the organisers' view: all of those are in it and say so.
// /photo/ answers 404 for a video the encoder has not finished, so the
// public read gives such a one no share id
function stillProcessing(p: PhotoOut, everything: boolean): void {
  p.processing = true;
  if (!everything) delete p.share;
}

// ?1 the album, ?2 everything, ?3 show a hidden team's, ?4 show the whole
// gallery, ?5 the albums merged in (a JSON list of ids).
var MERGED = 'SELECT value FROM json_each(?5)';
var SKIPPED = 'EXISTS (SELECT 1 FROM album_skips k WHERE k.r2_key = f.r2_key AND (k.album_id = ?1 OR k.album_id IN (' + MERGED + ')))';
var ITEMS = "SELECT 'album' AS src, p.id AS id, p.r2_key AS key, p.content_type AS type, p.added_at AS at, p.taken_at AS taken, " +
  'p.status AS status, p.encode_state AS encode, p.width AS w, p.height AS h, p.added_by AS added_by, p.name AS name, ' +
  "t.name AS team, COALESCE(t.hidden, 0) AS team_hidden, '' AS quest, 0 AS skipped, p.picked_type AS picked, p.version AS ver, " +
  'p.points_to AS points_to, p.album_id AS album_id ' +
  'FROM album_photos p LEFT JOIN teams t ON t.id = p.team_id ' +
  "WHERE (p.album_id = ?1 OR p.album_id IN (" + MERGED + ")) AND (?2 = 1 OR (p.status != 'uploading' AND (COALESCE(t.hidden, 0) = 0 OR ?3 = 1) AND p.points_to = '')) " +
  'UNION ALL ' +
  "SELECT 'gallery', f.id, f.r2_key, f.content_type, s.submitted_at, f.taken_at, 'ready', f.encode_state, 0, 0, '', f.name, " +
  't.name, t.hidden, s.quest_code, CASE WHEN ' + SKIPPED + " THEN 1 ELSE 0 END, f.picked_type, 0, '', 0 " +
  'FROM submission_files f JOIN submissions s ON s.id = f.submission_id JOIN teams t ON t.id = s.team_id ' +
  'WHERE (?4 = 1 OR ' + teamPicked('?1') + ' OR ' +
  'EXISTS (SELECT 1 FROM album_teams m WHERE m.album_id IN (' + MERGED + ') AND m.team_id = s.team_id))' +
  " AND s.gallery = 1 AND s.status = 'accepted' AND (t.hidden = 0 OR ?3 = 1) AND f.status != 'uploading' AND " + SHOWN +
  ' AND (?2 = 1 OR NOT ' + SKIPPED + ')';
// Newest added first, or newest taken first with one that gave no time
// going by when it was added.
var ORDERS: Record<string, string> = {
  added: ' ORDER BY at DESC, src, id DESC',
  taken: " ORDER BY COALESCE(NULLIF(taken, ''), at) DESC, at DESC, src, id DESC"
};
var PAGE_MAX = 200;

// A query over the album's items.
async function overItems<T>(db: D1Database, album: AlbumRow, everything: boolean, wrap: (items: string) => string, extra?: unknown[], merge?: Merge): Promise<T[]> {
  var m = merge || await mergeOf(db, album);
  var args = ([album.id, everything ? 1 : 0, album.show_hidden || m.showHidden ? 1 : 0, album.gallery || m.gallery ? 1 : 0,
    JSON.stringify(m.ids)] as unknown[]).concat(extra || []);
  var stmt = db.prepare(wrap(ITEMS));
  return (await stmt.bind.apply(stmt, args).all<T>()).results;
}

// Who an item is credited to, the way the page credits it: the team, or
// the name typed, '' for neither.
var WHO = "COALESCE(NULLIF(team, ''), added_by, '')";
// Only the people in one JSON list (empty for everyone) and none of the
// people in the other, matched in any case: `at` is the first list's
// parameter number and the second's follows it.
function whoFilter(at: number): string {
  var who = 'LOWER(TRIM(' + WHO + '))';
  var names = function (n: number) { return '(SELECT LOWER(TRIM(value)) FROM json_each(?' + n + '))'; };
  return ' WHERE (?' + at + " = '[]' OR " + who + ' IN ' + names(at) + ') AND ' + who + ' NOT IN ' + names(at + 1);
}
var NO_FILTER = { by: [], not: [] };
var FILTER_MAX = 50;
// The people a page asked for, from repeated by= and not= in its address.
function filterOf(params: URLSearchParams): Filter {
  function names(key: string): string[] {
    var seen: Record<string, boolean> = {};
    return params.getAll(key).map(function (v) { return cleanText(v, 80); }).filter(function (v) {
      var k = v.toLowerCase();
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    }).slice(0, FILTER_MAX);
  }
  return { by: names('by'), not: names('not') };
}
function filterArgs(f?: Filter): string[] {
  f = f || NO_FILTER;
  return [JSON.stringify(f.by), JSON.stringify(f.not)];
}

// One page of an album, from `from` in `order`, with only the people the
// filter lets through.
async function albumPhotos(db: D1Database, album: AlbumRow, everything: boolean, order?: string, from?: number, n?: number, filter?: Filter): Promise<PhotoOut[]> {
  var merge = await mergeOf(db, album);
  var rows = await overItems<ItemRow>(db, album, everything, function (items) {
    return 'SELECT * FROM (' + items + ')' + whoFilter(8) + (ORDERS[order as string] || ORDERS.added) + ' LIMIT ?6 OFFSET ?7';
  }, ([Math.max(1, Math.min(n || LIST_MAX, LIST_MAX)), Math.max(0, from || 0)] as unknown[]).concat(filterArgs(filter)), merge);
  var photos = rows.map(function (r) {
    var video = isVideoType(r.type);
    var state = video ? videoState(r.status, r.encode) : (r.status === 'uploading' ? 'uploading' : '');
    var p: PhotoOut = { key: r.key, type: r.type, from: r.src, team: r.team || '', by: r.added_by || '', at: r.at, share: shareId(r.key) };
    if (r.src === 'gallery') p.quest = r.quest;
    // from an album merged into this one
    if (r.src === 'album' && r.album_id && r.album_id !== album.id) {
      p.via = merge.names[r.album_id] || '';
      // /photo/ shows only a photo whose own album is not hidden
      if (merge.hidden[r.album_id]) delete p.share;
    }
    if (r.taken && (album.details || everything)) p.taken = r.taken;
    // the file it was picked as, where it may be saved
    if (r.picked && (album.details || everything)) p.picked = r.picked;
    if (video && state !== 'done' && state !== 'uploading') stillProcessing(p, everything);
    if (r.w && r.h) { p.w = r.w; p.h = r.h; }
    // replaced in place: the page puts this on the file's addresses
    if (r.ver) p.ver = r.ver;
    if (everything) {
      if (r.src === 'album' && r.team_hidden && !album.show_hidden) p.hidden_team = true;
      if (r.skipped) p.skipped = true;
      if (state) p.state = state;
      p.name = r.name || '';
      if (r.points_to) p.points_to = r.points_to;
    }
    return p;
  });
  // the sizes a player can offer for each video
  var heights = await heightsFor(db, photos.filter(function (p) { return isVideoType(p.type); }).map(function (p) { return p.key; }));
  photos.forEach(function (p) { if (isVideoType(p.type)) p.heights = heights[p.key] || []; });
  // a deleted quest's photo reads as the quest it came from
  await nameDeleted(db, photos, 'quest', 'files', function (p) { return p.key; });
  return photos;
}

// How many photos and videos the public sees in an album, and its cover:
// the newest photo, or the newest video where there is no photo.
async function albumSummary(db: D1Database, album: AlbumRow, filter?: Filter) {
  var counted = overItems<{ n: number; videos: number }>(db, album, false, function (items) {
    return "SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN type LIKE 'video/%' THEN 1 ELSE 0 END), 0) AS videos FROM (" + items + ')' + whoFilter(6);
  }, filterArgs(filter));
  var covered = overItems<{ key: string; type: string; src: string; ver: number }>(db, album, false, function (items) {
    return "SELECT key, type, src, ver FROM (" + items + ") ORDER BY (type LIKE 'image/%') DESC, at DESC LIMIT 1";
  });
  var got = await Promise.all([counted, covered]);
  var c = got[0][0] || { n: 0, videos: 0 };
  var cover = got[1][0];
  return {
    count: c.n, photos: c.n - c.videos, videos: c.videos,
    cover: cover ? Object.assign({ key: cover.key, type: cover.type, from: cover.src }, cover.ver ? { ver: cover.ver } : {}) : null
  };
}

// Everyone the public sees credited in an album, the most photos first,
// with how many each: what the page's filter offers. One name typed in
// different cases is one person, under the newest spelling. '' is the
// photos nobody put a name to.
var PEOPLE_MAX = 200;
async function albumPeople(db: D1Database, album: AlbumRow): Promise<{ name: string; n: number }[]> {
  var rows = await overItems<{ who: string | null; n: number }>(db, album, false, function (items) {
    return 'SELECT who, n FROM (SELECT who, COUNT(*) OVER (PARTITION BY k) AS n, ' +
      'ROW_NUMBER() OVER (PARTITION BY k ORDER BY at DESC, id DESC) AS newest FROM (' +
      'SELECT ' + WHO + ' AS who, LOWER(TRIM(' + WHO + ')) AS k, at, id FROM (' + items + '))) ' +
      'WHERE newest = 1 ORDER BY n DESC, who COLLATE NOCASE LIMIT ' + PEOPLE_MAX;
  });
  return rows.map(function (r) { return { name: String(r.who || '').trim(), n: r.n }; });
}

// A number that anything changing what an album shows moves on; the
// public reads are kept under the number it is at.
export function albumsMoved(db: D1Database): Promise<void> { return bumpCounter(db, 'albums'); }
async function albumsVersion(db: D1Database): Promise<number> {
  try {
    var row = await db.prepare("SELECT value FROM counters WHERE name = 'albums'").first<{ value: number }>();
    return row ? row.value : 0;
  } catch (err) { return 0; }
}

// The public reads, kept at the edge for a minute under the albums'
// number and the address asked for, so a change shows at once and the
// gallery's own changes (a submission accepted, a team hidden) within
// the minute. The answer to the browser is not kept.
var KEPT = 'public, max-age=60';
async function keptRead(env: Env, url: URL, make: () => Promise<{ status: number; body: object }>): Promise<Response> {
  var cache = typeof caches !== 'undefined' && caches.default;
  var slot: Request | null = null;
  if (cache) {
    var q = new URLSearchParams(url.search);
    q.sort();
    slot = new Request(url.origin + '/__albums/' + (await albumsVersion(env.DB)) + url.pathname + '?' + q.toString());
    var hit = await cache.match(slot);
    if (hit) return corsJson(await hit.json(), 200, NO_STORE);
  }
  var out = await make();
  if (cache && slot && out.status === 200) {
    await cache.put(slot, new Response(JSON.stringify(out.body), {
      headers: { 'content-type': 'application/json', 'cache-control': KEPT }
    }));
  }
  return corsJson(out.body, out.status, NO_STORE);
}

// An organiser's pass to one album: made on the dashboard (GET
// album/pass), it opens that album on the site whoever can see it, a
// merged album included, until it runs out. <id>.<expiry>.<signature>,
// signed with the console password, so a new password ends every pass.
var VIEW_HOURS = 24;
async function viewSig(env: Env, albumId: unknown, expiry: unknown): Promise<string> {
  var enc = new TextEncoder();
  var key = await crypto.subtle.importKey('raw', enc.encode(String(env.CONSOLE_PASSWORD)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode('album-view:' + albumId + ':' + expiry)));
}
async function makeViewPass(env: Env, albumId: number): Promise<string> {
  var expiry = Math.floor(Date.now() / 1000) + VIEW_HOURS * 3600;
  return albumId + '.' + expiry + '.' + (await viewSig(env, albumId, expiry));
}
async function viewPassAlbum(env: Env, pass: unknown): Promise<AlbumRow | null> {
  var m = /^(\d{1,12})\.(\d{9,12})\.([A-Za-z0-9_-]{20,64})$/.exec(String(pass || ''));
  if (!m || !configured(env.CONSOLE_PASSWORD) || Number(m[2]) < Date.now() / 1000) return null;
  if (!(await secretMatches(m[3], await viewSig(env, m[1], m[2])))) return null;
  return env.DB.prepare('SELECT * FROM albums WHERE id = ?1').bind(Number(m[1])).first<AlbumRow>();
}

// The album at an address the public was given: by its link's key, or
// by the address made from its name when it is on the list.
async function albumFor(db: D1Database, slug: unknown, key: unknown): Promise<AlbumRow | null> {
  var k = cleanText(key, 40);
  if (k) {
    var linked = await db.prepare("SELECT * FROM albums WHERE link_key = ?1 AND link_key != ''").bind(k).first<AlbumRow>();
    return linked && !linked.hidden ? linked : null;
  }
  var want = cleanText(slug, 60).toLowerCase();
  if (!want) return null;
  var named = await db.prepare('SELECT * FROM albums WHERE slug = ?1').bind(want).first<AlbumRow>();
  return named && !named.hidden && !named.unlisted ? named : null;
}

// ---------- the site ----------

// GET /api/albums: the albums on the site, each with how many photos
// and videos it has and the newest photo as its cover.
async function publicList(env: Env, url: URL): Promise<Response> {
  return keptRead(env, url, async function () {
    var albums = (await env.DB.prepare('SELECT * FROM albums WHERE hidden = 0 AND unlisted = 0 ORDER BY sort, id').all<AlbumRow>()).results;
    var sums = await Promise.all(albums.map(function (a) { return albumSummary(env.DB, a); }));
    return { status: 200, body: { ok: true, albums: albums.map(function (a, i) { return Object.assign(albumOut(a), sums[i]); }) } };
  });
}

// GET /api/album?a=<slug> or ?k=<link key>: one album and a page of its
// photos — `order` added or taken, `from` where the page starts, `n`
// how many (every one when it is not given), and `by` and `not`, each as
// many times as there are people, for only their photos or everyone's
// but theirs. `count` and `next` are of what the filter lets through;
// the first page also carries `people`, everyone in the album whatever
// the filter. A hidden album is not found, and nor is one shown only
// with its link asked for by its name.
async function publicAlbum(env: Env, url: URL): Promise<Response> {
  return keptRead(env, url, async function () {
    var passed = url.searchParams.get('pass') ? await viewPassAlbum(env, url.searchParams.get('pass')) : null;
    var album = passed || await albumFor(env.DB, url.searchParams.get('a'), url.searchParams.get('k'));
    if (!album) return { status: 404, body: { error: 'There is no album at this address.' } };
    var out: Partial<AlbumOut> = albumOut(album);
    (['id', 'hidden', 'visibility', 'link_key', 'merges'] as const).forEach(function (k) { delete out[k]; });
    // an organiser's look: nothing is added through it, and no photo is
    // handed a share link from it
    if (passed) out.adding = 'closed';
    if (album.adding === 'anyone' && !passed) out.turnstile = turnstileSiteKey(env);
    // the order a photo was taken in is one of the details, so an album
    // not showing them is in the order photos were added whatever is asked;
    // a page that asks for neither gets the album's own
    var asked = url.searchParams.get('order');
    var order = !album.details ? 'added' : asked === 'taken' || asked === 'added' ? asked :
      album.photo_order === 'taken' ? 'taken' : 'added';
    var from = Math.max(0, Math.floor(Number(url.searchParams.get('from')) || 0));
    var wanted = Math.floor(Number(url.searchParams.get('n')) || 0);
    var n = wanted > 0 ? Math.min(wanted, PAGE_MAX) : LIST_MAX;
    var filter = filterOf(url.searchParams);
    var got = await Promise.all([albumPhotos(env.DB, album, false, order, from, n, filter), albumSummary(env.DB, album, filter),
      from ? null : albumPeople(env.DB, album)]);
    var photos = got[0];
    if (passed) photos.forEach(function (p) { delete p.share; });
    var sum = got[1];
    var body: { ok: boolean; album: Partial<AlbumOut>; photos: PhotoOut[]; order: string; count: number; videos: number; next: number | null;
      people?: { name: string; n: number }[]; filter?: Filter } = {
      ok: true, album: out, photos: photos, order: order,
      count: sum.count, videos: sum.videos,
      next: from + photos.length < sum.count && photos.length === n ? from + photos.length : null
    };
    if (got[2]) body.people = got[2];
    if (filter.by.length || filter.not.length) body.filter = filter;
    return { status: 200, body: body };
  });
}

// GET /api/albums/file?key=alb/…: an uploaded photo or video by its
// unguessable key — thumb=1 for the small copy; res for a video's copy
// at that height or a photo's viewing copy; otherwise the whole photo
// cut, or a video's clean copy. orig=1 is the photo as it was sent,
// metadata and all, while an album that shows details holds it
// (detailsHolder), a gallery photo's too; anything else asked for that
// way gets the cut. picked=1 is the HEIC or WebP it was picked as, under
// the same rule, and not found anywhere else.
// ---------- a photo that points to another ----------
// A duplicate an organiser has pointed at another photo in the same
// album. It is left out of the album, and every address it had (its
// share link, its file and every copy of it, /view/ and the details)
// answers with a redirect to that photo, so a link already posted lands
// on the one that stays. One hop: pointing a photo elsewhere moves
// whatever pointed at it along too (pointPhoto).

// An upload's row for the file route, with the photo it points to
// (to_key, to_ver) where it points to one.
async function ownRow(db: D1Database, key: string): Promise<OwnRow | null> {
  return db.prepare(
    'SELECT p.content_type, p.status, p.name, p.encode_state, t.r2_key AS to_key, t.version AS to_ver ' +
    'FROM album_photos p LEFT JOIN album_photos t ON t.r2_key = p.points_to AND t.album_id = p.album_id ' +
    'WHERE p.r2_key = ?1'
  ).bind(key).first<OwnRow>();
}
// The photo `key` points to, {key, ver}, or null.
async function pointedAt(db: D1Database, key: string): Promise<{ key: string; ver: number } | null> {
  if (key.indexOf('alb/') !== 0) return null;
  var row = await ownRow(db, key);
  return row && row.to_key ? { key: row.to_key, ver: row.to_ver || 0 } : null;
}
// Not kept anywhere: pointing a photo back where it was has to work at
// once. Open CORS, because the pages ask for these from another origin.
function movedTo(to: URL): Response {
  return new Response(null, { status: 302, headers: {
    location: to.toString(), 'cache-control': 'no-store', 'access-control-allow-origin': '*'
  } });
}
// The same ask of the photo pointed to: its key in place of this one's,
// and its version, so nothing cached answers with the picture before.
function pointedFile(url: URL, pathKey: string | undefined, row: OwnRow): Response {
  var to = new URL(url);
  var toKey = String(row.to_key);
  if (row.to_ver) to.searchParams.set('v', String(row.to_ver)); else to.searchParams.delete('v');
  if (!pathKey) {
    to.searchParams.set('key', toKey);
    return movedTo(to);
  }
  // the address ending in a name: the share page's photo-<version>.jpg is
  // named for the version of the photo it is
  var name = url.pathname.split('/').pop() as string;
  var m = decodeURIComponent(name).match(/^photo(?:-\d+)?(\.\w+)$/);
  if (m) name = encodeURIComponent('photo' + (row.to_ver ? '-' + row.to_ver : '') + m[1]);
  to.pathname = '/api/albums/file/' + toKey + '/' + name;
  return movedTo(to);
}

// What the edge copy of an album file's answer is kept under, beside its
// address (index.ts, edgeFile): an upload can be replaced in place under
// the same key, or pointed at another photo, and neither changes the
// address, so the version and the pointer go in the key. A key with no
// row is kept under 'none', and its answer is a 404, which is not kept.
export async function albumEdgeMark(db: D1Database, url: URL): Promise<string> {
  var named = url.pathname.match(/^\/api\/albums\/file\/(alb\/[^/]+)\//);
  var key = named ? decodeURIComponent(named[1]) : (url.searchParams.get('key') || '');
  if (key.indexOf('alb/') !== 0) return 'other';
  var row = await db.prepare('SELECT version, points_to FROM album_photos WHERE r2_key = ?1')
    .bind(key).first<{ version: number | null; points_to: string | null }>();
  return row ? (row.version || 0) + '.' + (row.points_to || '') : 'none';
}

async function serveAlbumFile(env: Env, request: Request, url: URL, pathKey?: string): Promise<Response> {
  if (!env.SUBMIT) return corsJson({ error: 'Uploads are not switched on.' }, 503);
  var key = pathKey || url.searchParams.get('key') || '';
  if (url.searchParams.get('picked') === '1') return servePicked(env, request, key);
  var original = url.searchParams.get('orig') === '1';
  var gallery = key.indexOf('sub/') === 0 && original;
  if (key.indexOf('alb/') !== 0 && !gallery) return corsJson({ error: 'not found' }, 404);
  var own = gallery ? null : await ownRow(env.DB, key);
  if (own && own.to_key) return pointedFile(url, pathKey, own);
  // a person opening the address gets the photo's page
  if (!gallery && wantsPage(request, url, { named: !!pathKey, media: true })) {
    var shown = await viewedFile(env.DB, key);
    if (shown) return mediaPage(env, url, shown);
  }
  var holder = original ? await detailsHolder(env.DB, key) : null;
  var row = gallery ? holder && { content_type: holder.type, status: 'ready', name: holder.name } : own;
  if (!row) return corsJson({ error: 'not found' }, 404);
  // download=1: the whole file as the public sees it, or the original, saved as a file
  if (url.searchParams.get('download')) {
    var whole = new URL(url);
    ['download', 'thumb', 'res'].forEach(function (p) { whole.searchParams.delete(p); });
    // the inner ask is never the page: a download a browser makes the way it
    // opens a page (Safari) was given the page's HTML under the photo's name
    whole.searchParams.set('raw', '1');
    return asDownload(await serveAlbumFile(env, request, whole, pathKey), row.name, isVideoType(row.content_type));
  }
  if (holder && ORIGINAL_TYPES.indexOf(baseType(holder.type)) !== -1) {
    var sent = await serveStoredFile(env.SUBMIT, request, key, ORIGINAL_CACHE, CORS);
    if (sent) return sent;
  }
  if (gallery) {
    var cleaned = (await serveCleanPhoto(env, request, key, row.content_type, FOREVER, CORS)) ||
      (await serveStoredFile(env.SUBMIT, request, key + '.v', FOREVER, CORS));
    return cleaned || corsJson({ error: 'not found' }, 404);
  }
  var moves = animatedType(row.content_type);
  var video = isVideoType(row.content_type);
  var res = url.searchParams.get('res');
  function serve(k: string, cacheControl?: string): Promise<Response | null> {
    return serveStoredFile(env.SUBMIT, request, k, cacheControl || FOREVER, CORS);
  }
  // another height, or a still, in place of the video asked for
  // (STAND_IN_CACHE in submit.ts)
  var NEAREST = own && own.encode_state === 'done' ? FOREVER : STAND_IN_CACHE;
  var STILL = video ? STAND_IN_CACHE : FOREVER;
  // uploaded=1: a video as it was sent with its metadata boxes blanked
  // (videostrip.ts), which the album page plays until the encoder's copies
  // exist; a file it cannot read falls through to the copies
  if (url.searchParams.get('uploaded') && video && row.status !== 'uploading') {
    var asSent = await serveUploadedVideo(env, request, key, row.content_type, CORS);
    if (asSent) return asSent;
  }
  if (url.searchParams.get('thumb') && !moves) {
    var small = await serve(key + '.t');
    if (small) return small;
    // one with no small copy: the viewing copy, never the whole photo,
    // which three hundred of on one page is more than a phone can hold;
    // and a video with no still has no thumbnail at all, since Safari
    // takes a video in an img and downloads every byte of it
    if (video) return corsJson({ error: 'no still' }, 404);
    var viewing = await serve(key + '.v');
    if (viewing) return viewing;
  }
  var alt = video ? await renditionFor(env, key, res) : { key: '', exact: false };
  if (alt.key) {
    var smaller = await serve(alt.key, alt.exact ? FOREVER : NEAREST);
    if (smaller) return smaller;
  }
  if (wantsSmaller(res) && !moves && !video) {
    var view = await serve(key + '.v');
    if (view) return view;
  }
  // a photo cut as it is served, a video the encoder's clean copy
  var clean = video ? await serve(key + '.c') : await serveCleanPhoto(env, request, key, row.content_type, FOREVER, CORS);
  if (clean) return clean;
  if (video) {
    var biggest = await largestRendition(env, key);
    if (biggest) {
      var best = await serve(biggest, NEAREST);
      if (best) return best;
    }
  }
  if (row.status === 'uploading') return corsJson({ error: 'still uploading' }, 404);
  var fallback = (await serve(key + '.v', STILL)) || (await serve(key + '.t', STILL));
  if (fallback) return fallback;
  return corsJson({ error: 'not found' }, 404);
}

// The file a photo was picked as, saved under its own type and the
// photo's name, while an album showing details holds the photo.
async function servePicked(env: Env, request: Request, key: string): Promise<Response> {
  var holder = key.indexOf('alb/') === 0 || key.indexOf('sub/') === 0 ? await detailsHolder(env.DB, key) : null;
  var type = holder ? await pickedOf(env, key) : '';
  var sent = type && holder ? await servePickedFile(env.SUBMIT, request, key, type, holder.name || 'photo', ORIGINAL_CACHE, CORS) : null;
  return sent || corsJson({ error: 'not found' }, 404);
}

// The zone a photo's time is shown in, beside the time: the one the
// phone wrote, but not UTC, which is what software that saves a PNG or
// re-saves a photo writes. That says when the photo was taken and not
// where, and shown as GMT+00:00 it read eleven hours out beside the
// photos around it. The page shows a time with no zone on the device's
// clock.
function localZone(offset: string | undefined): string {
  return offset === '+00:00' ? '' : offset || '';
}

// GET /api/albums/info?key=…: what a photo or video says about itself,
// for the album page's details panel, while an album that shows details
// holds it: when it was taken and in which zone, the camera and its
// settings, where (with the height above sea level), its size, and who
// added it. The same fields the dashboard reads for proof (readExif),
// from the file's metadata block.
async function photoInfo(env: Env, url: URL): Promise<Response> {
  var key = url.searchParams.get('key') || '';
  var to = await pointedAt(env.DB, key);
  if (to) {
    var moved = new URL(url);
    moved.searchParams.set('key', to.key);
    return movedTo(moved);
  }
  var holder = await detailsHolder(env.DB, key);
  if (!holder) return corsJson({ error: 'not found' }, 404, NO_STORE);
  var meta = readExif(null);
  if (/^(image|video)\//.test(holder.type)) {
    var block = await metaBlock(env, key, holder.type);
    if (block) meta = readExif(block);
  }
  var taken = takenUtc(meta);
  // a photo whose block is read again here (metaBlock) may have a time
  // now that it did not have when it was added; the order by time taken
  // reads the row
  if (taken && !holder.taken) {
    try { await recordTaken(env, [{ key: key, taken: taken }]); } catch (err) { /* the details still show it */ }
  }
  var out = {
    ok: true, name: holder.name, type: holder.type, bytes: holder.bytes || 0,
    w: meta.width || holder.w || 0, h: meta.height || holder.h || 0,
    taken: taken || holder.taken, offset: localZone(meta.offset), at: holder.at, by: holder.who, quest: holder.quest,
    camera: [meta.make, meta.model].filter(Boolean).join(' '), lens: meta.lens,
    exposure: meta.exposure, fnumber: meta.fnumber, iso: meta.iso, focal: meta.focal, focal35: meta.focal35,
    gps: meta.gps
  };
  // a phone's model often starts with its maker's name already
  if (meta.make && meta.model && meta.model.toLowerCase().indexOf(meta.make.toLowerCase()) === 0) out.camera = meta.model;
  return corsJson(out, 200, NO_STORE);
}

// The large videos an upload names, from its `bigfiles` field: null
// when the field is not a list.
function bigList(form: FormData): unknown[] | null {
  var raw = form.get('bigfiles');
  if (!raw) return [];
  var list: unknown;
  try { list = JSON.parse(String(raw).slice(0, 4000)); } catch (err) { return null; }
  return Array.isArray(list) ? list : null;
}

// Stores the photos and videos in one upload and writes their rows.
// `who` is {team_id, by, ip}. Answers {added, uploads} — uploads being
// the large videos whose slices are still to come — or {error, status}.
// ---------- an organiser replacing a photo in place ----------
// A dashboard upload with `replace` on takes the place of the album's
// photo of the same name rather than going in beside it. The file goes
// in under that photo's key, so its share link keeps working, and the
// metadata block, small and viewing copies and cleaned copy made from
// the old one go, so the details and the time taken are read from the
// new file. A JPEG named as a PNG is but for the ending takes that PNG's
// place, and the PNG is kept as it was sent, as the file the photo was
// picked as (.p), which is what lets Download offer both. The row's
// version goes up by one and the pages put it on the file's addresses,
// since every copy is served as never changing. A photo sent in slices
// arrives under a key of its own on a row that `replaces` the photo, and
// is copied onto the photo's key at finish, once its first bytes have
// been checked, so a broken upload never touches the photo. Names may
// repeat: where more than one photo answers to the name, nothing is
// stored and the upload is answered with them (`choose`), and the page
// sends it again naming the one to replace (`replace_key`).

// A photo in the album an upload may replace, with the team that added it.
var TARGET_SQL = 'SELECT p.*, t.name AS team FROM album_photos p LEFT JOIN teams t ON t.id = p.team_id ' +
  "WHERE p.album_id = ?1 AND p.status != 'uploading' AND p.content_type LIKE 'image/%' ";

// The photo an upload called `name` replaces: the one named by `key`
// when the page picked one, else the one with its name; null for none,
// or {clash: rows} where more than one has it.
async function replaceTarget(db: D1Database, albumId: number, name: unknown, type: string, key: string): Promise<TargetRow | { gone: true } | { clash: TargetRow[] } | null> {
  if (baseType(type).indexOf('image/') !== 0) return null;
  if (key) {
    var picked = await db.prepare(TARGET_SQL + 'AND p.r2_key = ?2').bind(albumId, key).first<TargetRow>();
    return picked || { gone: true as const };
  }
  var given = String(cleanText(name, 120) || '');
  if (!given) return null;
  var jpeg = type === 'image/jpeg';
  var asPng = given.replace(/\.[A-Za-z0-9]{1,5}$/, '') + '.png';
  var rows = (await db.prepare(TARGET_SQL + 'AND LOWER(p.name) IN (?2, ?3) ORDER BY p.added_at, p.id')
    .bind(albumId, given.toLowerCase(), (jpeg ? asPng : given).toLowerCase()).all<TargetRow>()).results;
  function only(found: TargetRow[]): TargetRow | { clash: TargetRow[] } | null { return found.length > 1 ? { clash: found } : found[0] || null; }
  var same = only(rows.filter(function (r) { return String(r.name).toLowerCase() === given.toLowerCase(); }));
  if (same || !jpeg) return same;
  return only(rows.filter(function (r) { return baseType(r.content_type) === 'image/png'; }));
}

// What the page shows of each photo an upload could replace.
function candidates(rows: TargetRow[]): object[] {
  return rows.map(function (r) {
    var c: Record<string, unknown> = { key: r.r2_key, type: r.content_type, name: r.name, at: r.added_at, by: r.team || r.added_by || '',
      bytes: r.bytes || 0, w: r.width || 0, h: r.height || 0, taken: r.taken_at || '' };
    if (r.version) c.ver = r.version;
    return c;
  });
}

// A JPEG taking a PNG's place keeps the PNG.
function keepsPng(oldType: string, newType: string): boolean {
  return baseType(oldType) === 'image/png' && newType === 'image/jpeg';
}

// One stored object copied onto another key: inside R2 where the worker
// has the R2 secrets, else streamed through the worker.
async function copyStored(env: Env, from: string, to: string, type: string): Promise<void> {
  if (directReady(env)) return directCopy(env, from, to);
  var obj = await env.SUBMIT.get(from);
  if (!obj) throw new Error(from + ' is not in storage');
  var body = obj.body;
  var piping: Promise<void> | null = null;
  if (typeof FixedLengthStream === 'function') {
    var fixed = new FixedLengthStream(obj.size);
    piping = obj.body.pipeTo(fixed.writable);
    body = fixed.readable;
  }
  await env.SUBMIT.put(to, body, { httpMetadata: { contentType: type } });
  if (piping) await piping;
}

// The copies made from a photo's old file.
async function forgetCopies(env: Env, key: string): Promise<void> {
  var gone = ['.x', '.t', '.v', '.c'];
  for (var g = 0; g < gone.length; g++) await env.SUBMIT.delete(key + gone[g]);
}

// The row after a replacement: the new file's type, size, name, shape
// and time, the file it was picked as, and one more version.
function replacedRow(env: Env, row: Pick<AlbumPhotoRow, 'id' | 'width' | 'height'>, type: string, bytes: number, name: string | null, w: number, h: number, taken: string, picked: string): Promise<D1Result> {
  return env.DB.prepare(
    'UPDATE album_photos SET content_type = ?2, bytes = ?3, name = ?4, width = ?5, height = ?6, taken_at = ?7, ' +
    'picked_type = ?8, version = version + 1 WHERE id = ?1'
  ).bind(row.id, type, bytes, name, w || row.width || 0, h || row.height || 0, taken || '', picked).run();
}

async function replaceInPlace(env: Env, row: TargetRow, file: File, ftype: string, form: FormData, j: number): Promise<{ name: string; png: boolean }> {
  var key = row.r2_key;
  var png = keepsPng(row.content_type, ftype);
  var picked = row.picked_type || '';
  if (png) {
    await copyStored(env, key, key + '.p', 'image/png');
    picked = 'image/png';
  }
  await env.SUBMIT.put(key, file, { httpMetadata: { contentType: ftype } });
  await forgetCopies(env, key);
  var clean = await writeBlock(env, key, ftype, file);
  if (!animatedType(ftype)) {
    await storePreview(env, key + '.t', form.get('thumb' + j), MAX_THUMB_BYTES);
    await storePreview(env, key + '.v', form.get('view' + j), MAX_VIEW_BYTES);
  }
  if (!png) picked = (await storePicked(env, key, ftype, form.get('picked' + j), MAX_FILE_BYTES)) || picked;
  if (ftype !== 'image/jpeg' && picked) {
    await env.SUBMIT.delete(key + '.p');
    picked = '';
  }
  var taken = clean ? takenUtc(readExif(clean.block)) : await takenOf(env, key, ftype);
  await replacedRow(env, row, ftype, file.size, cleanText(file.name, 120), size(form.get('w' + j)), size(form.get('h' + j)), taken, picked);
  return { name: cleanText(file.name, 120), png: png };
}

// At finish: a photo that came in slices to replace another. Its row and
// its own key go once the file is under the photo's.
async function swapIn(env: Env, stagedId: number, target: AlbumPhotoRow): Promise<void> {
  // the row the slices came in on, which finish read a moment ago
  var staged = await env.DB.prepare('SELECT * FROM album_photos WHERE id = ?1').bind(stagedId).first<AlbumPhotoRow>() as AlbumPhotoRow;
  var key = target.r2_key;
  var type = staged.content_type;
  var picked = target.picked_type || '';
  if (keepsPng(target.content_type, type)) {
    await copyStored(env, key, key + '.p', 'image/png');
    picked = 'image/png';
  }
  await copyStored(env, staged.r2_key, key, type);
  await forgetCopies(env, key);
  var smalls = ['.t', '.v'];
  for (var i = 0; i < smalls.length; i++) {
    var small = await env.SUBMIT.get(staged.r2_key + smalls[i]);
    if (small) await env.SUBMIT.put(key + smalls[i], await small.arrayBuffer(), { httpMetadata: small.httpMetadata });
  }
  if (type !== 'image/jpeg' && picked) {
    await env.SUBMIT.delete(key + '.p');
    picked = '';
  }
  await replacedRow(env, target, type, staged.bytes, staged.name, staged.width, staged.height, await takenOf(env, key, type), picked);
  await dropPhoto(env, { r2_key: staged.r2_key, upload_id: null });
}

// The photo a row still arriving in slices is to replace, 0 for none.
async function replacesOf(db: D1Database, id: number): Promise<number> {
  var row = await db.prepare('SELECT replaces FROM album_photos WHERE id = ?1').bind(id).first<Pick<AlbumPhotoRow, 'replaces'>>();
  return (row && row.replaces) || 0;
}

async function storePhotos(env: Env, form: FormData, album: AlbumRow, who: Who, opts?: { replace?: boolean }): Promise<Stored | { error: string; status: number; choose?: object[] }> {
  if (!env.SUBMIT) return { error: 'Uploads are not switched on.', status: 503 };
  var files = form.getAll('files').filter(function (f): f is File { return isBlobLike(f); });
  var bigs = bigList(form);
  if (!bigs) return { error: 'bad large-file list', status: 400 };
  var replacing = !!(opts && opts.replace);
  // `whole`: every file follows as slices, whatever its size, sent
  // straight to R2 when the worker has the R2 secrets (r2direct.ts)
  var whole = form.get('whole') === '1';
  var direct = whole && directReady(env);
  if (whole && files.length) return { error: 'bad file list', status: 400 };
  if (!files.length && !bigs.length) return { error: 'Pick at least one photo or video.', status: 400 };
  if (files.length + bigs.length > MAX_FILES) return { error: 'At most ' + MAX_FILES + ' at a time.', status: 400 };
  var total = 0;
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var type = baseType(f.type);
    if (!typeOk(type) || !(await bytesMatch(f, type))) {
      return { error: (cleanText(f.name, 80) || 'File ' + (i + 1)) + ' is not a photo or a video.', status: 400 };
    }
    if (f.size > MAX_FILE_BYTES) return { error: (cleanText(f.name, 80) || 'A file') + ' is too big to send in one go.', status: 413 };
    total += f.size;
  }
  if (total > MAX_REQUEST_BYTES) return { error: 'Those add up to more than 90MB. Send fewer at a time.', status: 413 };
  if (bigs.length && !direct && typeof env.SUBMIT.createMultipartUpload !== 'function') {
    return { error: 'Large uploads are not switched on.', status: 503 };
  }
  for (var b = 0; b < bigs.length; b++) {
    var big = fields(bigs[b]);
    var bsize = Math.round(Number(big.size) || 0);
    var bname = cleanText(big.name, 80) || 'A file';
    if (!typeOk(big.type)) return { error: bname + ' is not a photo or a video.', status: 400 };
    if (bsize < 1) return { error: bname + ' is empty.', status: 400 };
    if (bsize <= MAX_FILE_BYTES && !whole) return { error: bname + ' is small enough to send directly.', status: 400 };
    if (bsize > MAX_BIG_BYTES) return { error: bname + ' is over 4GB.', status: 413 };
  }
  // what each file replaces, settled before anything is stored: a name
  // more than one photo has is sent back with them to pick from
  var asKey = replacing ? String(form.get('replace_key') || '') : '';
  if (asKey && files.length + bigs.length !== 1) return { error: 'Pick one file to replace a photo with.', status: 400 };
  function typeOf(t: unknown): string { return baseType(t) === 'image/jpg' ? 'image/jpeg' : baseType(t); }
  var targets: (TargetRow | null)[] = [];
  // each is checked above
  var sent = (files.map(function (x) { return { name: x.name, type: x.type }; }) as Record<string, unknown>[]).concat(bigs as Record<string, unknown>[]);
  for (var t = 0; t < sent.length; t++) {
    var found = replacing ? await replaceTarget(env.DB, album.id, sent[t].name, typeOf(sent[t].type), asKey) : null;
    if (found && 'gone' in found) return { error: 'That photo is not in this album any more.', status: 404 };
    if (found && 'clash' in found) {
      return {
        error: found.clash.length + ' photos in this album are called ' + cleanText(sent[t].name, 120) + '.',
        status: 409, choose: candidates(found.clash)
      };
    }
    targets.push(found);
  }
  var rows: D1PreparedStatement[] = [];
  var taken: Taken[] = [];
  var picked: PickedNote[] = [];
  var replaced: { name: string; png: boolean }[] = [];
  for (var j = 0; j < files.length; j++) {
    var file = files[j];
    var ftype = typeOf(file.type);
    var target = targets[j];
    if (target) {
      replaced.push(await replaceInPlace(env, target, file, ftype, form, j));
      continue;
    }
    var key = 'alb/' + randomKey(12);
    var name = cleanText(file.name, 120);
    await env.SUBMIT.put(key, file, { httpMetadata: { contentType: ftype } });
    var clean = await writeBlock(env, key, ftype, file);
    if (clean) taken.push({ key: key, taken: takenUtc(readExif(clean.block)) });
    else if (isVideoType(ftype)) taken.push({ key: key, taken: await takenOf(env, key, ftype) });
    if (!animatedType(ftype)) {
      await storePreview(env, key + '.t', form.get('thumb' + j), MAX_THUMB_BYTES);
      if (!isVideoType(ftype)) await storePreview(env, key + '.v', form.get('view' + j), MAX_VIEW_BYTES);
    }
    var twin = await storePicked(env, key, ftype, form.get('picked' + j), MAX_FILE_BYTES);
    if (twin) picked.push({ key: key, picked: twin });
    rows.push(env.DB.prepare(
      'INSERT INTO album_photos (album_id, r2_key, content_type, bytes, name, team_id, added_by, ip, width, height) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)'
    ).bind(album.id, key, ftype, file.size, name, who.team_id || null, who.by || '', who.ip || '',
      size(form.get('w' + j)), size(form.get('h' + j))));
  }
  var uploads: { name: string; size: number; part_size: number; token: string; at: number; key: string; replaces: { png: boolean } | null }[] = [];
  for (var k = 0; k < bigs.length; k++) {
    // checked above
    var v = bigs[k] as Record<string, unknown>;
    var vtype = baseType(v.type) === 'image/jpg' ? 'image/jpeg' : baseType(v.type);
    var vkey = 'alb/' + randomKey(12);
    var vname = cleanText(v.name, 120);
    var replaces = targets[files.length + k];
    var uploadId = direct ? markDirect(await directStart(env, vkey, vtype))
      : (await env.SUBMIT.createMultipartUpload(vkey, { httpMetadata: { contentType: vtype } })).uploadId;
    if (!animatedType(vtype)) {
      await storePreview(env, vkey + '.t', form.get('bigthumb' + k), MAX_THUMB_BYTES);
      if (!isVideoType(vtype)) await storePreview(env, vkey + '.v', form.get('bigview' + k), MAX_VIEW_BYTES);
    }
    // the file it was picked as: sent now when the slices come through
    // the worker, named here when they go straight to R2; a replacement
    // keeps the photo's
    var vtwin = replaces ? '' : direct ? pickedDeclared(v, vtype, MAX_FILE_BYTES)
      : await storePicked(env, vkey, vtype, form.get('bigpicked' + k), MAX_FILE_BYTES);
    if (vtwin) picked.push({ key: vkey, picked: vtwin, declared: direct });
    var token = randomKey(16);
    var vsize = Math.round(Number(v.size));
    uploads.push({ name: vname, size: vsize, part_size: PART_BYTES, token: token, at: rows.length, key: vkey,
      replaces: replaces ? { png: keepsPng(replaces.content_type, vtype) } : null });
    var insert = env.DB.prepare(
      'INSERT INTO album_photos (album_id, r2_key, content_type, bytes, name, team_id, added_by, ip, width, height, ' +
      'status, upload_id, part_size, upload_token' + (replaces ? ', replaces' : '') +
      ") VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'uploading', ?11, ?12, ?13" + (replaces ? ', ?14' : '') + ')'
    );
    rows.push(insert.bind.apply(insert, [album.id, vkey, vtype, vsize, vname, who.team_id || null, who.by || '', who.ip || '',
      size(v.w), size(v.h), uploadId, PART_BYTES, token].concat(replaces ? [replaces.id] : [])));
  }
  var done = rows.length ? await env.DB.batch(rows) : [];
  try { await recordTaken(env, taken); } catch (err) { /* the dashboard's tidy fills it in */ }
  // the page sends a file it named only when its row can say so
  var named = await recordPicked(env, picked);
  return {
    added: rows.length,
    replaced: replaced,
    uploads: uploads.map(function (u) {
      var res = done[u.at];
      var out: Stored['uploads'][number] = { file: res && res.meta && res.meta.last_row_id, name: u.name, size: u.size, part_size: u.part_size, token: u.token, direct: direct };
      if (named && picked.some(function (p) { return p.key === u.key && p.declared; })) out.picked = true;
      if (u.replaces) out.replaces = u.replaces;
      return out;
    })
  };
}

// The page sends one file to a request, and a person check is good for
// one request, so an upload to an album open to anyone that passed the
// check is handed a pass: signed with the Turnstile secret, for that
// album and that address, until it runs out. The rest of the pick
// carries it in place of the check.
async function passSig(env: Env, albumId: number, ip: string, expiry: unknown): Promise<string> {
  var enc = new TextEncoder();
  var key = await crypto.subtle.importKey('raw', enc.encode(String(env.TURNSTILE_SECRET)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  var sig = await crypto.subtle.sign('HMAC', key, enc.encode('album-pass:' + albumId + ':' + ip + ':' + expiry));
  return b64url(sig);
}
async function makePass(env: Env, albumId: number, ip: string): Promise<string> {
  var expiry = Math.floor(Date.now() / 1000) + PASS_MINUTES * 60;
  return expiry + '.' + (await passSig(env, albumId, ip, expiry));
}
async function passOk(env: Env, pass: unknown, albumId: number, ip: string): Promise<boolean> {
  var m = /^(\d{9,12})\.([A-Za-z0-9_-]{20,64})$/.exec(String(pass || ''));
  if (!m || Number(m[1]) < Date.now() / 1000) return false;
  return secretMatches(m[2], await passSig(env, albumId, ip, m[1]));
}

// POST /api/album/upload: who may is up to the album. A team signs in
// with its submit code; an album open to anyone asks for the person
// check when one is set up, and holds each address to ANYONE_PER_HOUR.
// A team signed in on an album open to anyone is known, so it skips
// both, and what it adds is not counted against its address: everybody
// on the campus wifi shares one.
async function publicUpload(request: Request, env: Env): Promise<Response> {
  var form: FormData;
  try { form = await request.formData(); } catch (err) { return corsJson({ error: 'expected a multipart form' }, 400); }
  var album = await albumFor(env.DB, form.get('a'), form.get('k'));
  if (!album) return corsJson({ error: 'There is no album at this address.' }, 404);
  if (album.adding === 'closed') return corsJson({ error: 'This album is not taking photos.' }, 403);
  var who: Who = { team_id: null, by: '', ip: '' };
  var pass = '';
  if (album.adding === 'teams') {
    var session = await requireTeam(request, env.DB);
    if (!session) return corsJson({ error: 'Sign in with your team name and submit code to add to this album.' }, 401);
    who.team_id = session.team_id;
  } else {
    var session2 = await requireTeam(request, env.DB);
    var ip = await ipHash(request);
    var checking = !!turnstileSiteKey(env);
    who.by = cleanText(form.get('by'), 60);
    if (session2) {
      who.team_id = session2.team_id;
      // the pass lets the page send the rest of a pick side by side, and
      // carries the upload through if the sign-in runs out part way
      if (checking && !(await passOk(env, form.get('pass'), album.id, ip))) pass = await makePass(env, album.id, ip);
    } else {
      who.ip = ip;
      var passed = checking && (await passOk(env, form.get('pass'), album.id, ip));
      if (!passed) {
        if (!(await turnstileOk(env, request, form.get('turnstile')))) {
          return corsJson({ error: 'The check that you are a person did not go through. Try again.' }, 400);
        }
        if (checking) pass = await makePass(env, album.id, ip);
      }
      var recent = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM album_photos WHERE ip = ?1 AND added_at > datetime('now', '-1 hour')"
      ).bind(ip).first<{ n: number }>() as { n: number };
      var sending = form.getAll('files').length + ((bigList(form) || []).length);
      var perHour = await settingValue(env.DB, 'album_anyone_per_hour', ANYONE_PER_HOUR);
      if (recent.n + sending > perHour) {
        return corsJson({ error: 'That is a lot from one place. Try again in an hour.' }, 429);
      }
    }
  }
  var res = await storePhotos(env, form, album, who);
  if ('error' in res) return corsJson({ error: res.error }, res.status);
  await albumsMoved(env.DB);
  var out: { ok: boolean; added: number; uploads: Stored['uploads']; pass?: string; hidden_team?: boolean } = { ok: true, added: res.added, uploads: res.uploads };
  if (pass) out.pass = pass;
  // a hidden team's photos are for organisers only, and the page says so
  if (who.team_id) {
    var team = await env.DB.prepare('SELECT hidden FROM teams WHERE id = ?1').bind(who.team_id).first<Pick<TeamRow, 'hidden'>>();
    if (team && team.hidden && !album.show_hidden) out.hidden_team = true;
  }
  return corsJson(out);
}

// ---------- a large video's slices ----------
// The token the upload handed back is the whole credential, so the
// slices of an upload open to anyone need no session, and the
// dashboard sends its own the same way.

async function uploadRow(env: Env, id: unknown, token: unknown): Promise<AlbumUpload | null> {
  id = Math.round(Number(id));
  if (!id || !token) return null;
  var row = await env.DB.prepare(
    'SELECT id, r2_key, content_type, name, bytes, part_size, upload_id, upload_token, status FROM album_photos WHERE id = ?1'
  ).bind(id).first<AlbumUpload>();
  if (!row || row.status !== 'uploading' || !(await secretMatches(String(token), row.upload_token))) return null;
  return row;
}

function partsOf(bytes: number, partSize: number): number { return Math.max(1, Math.ceil(bytes / partSize)); }

// The address one slice of a file going straight to R2 is sent to.
async function uploadSign(env: Env, url: URL): Promise<Response> {
  var row = await uploadRow(env, url.searchParams.get('file'), url.searchParams.get('token'));
  if (!row) return corsJson({ error: 'not found' }, 404);
  if (!isDirect(row.upload_id)) return corsJson({ error: 'this file goes through the worker' }, 409);
  if (!directReady(env)) return corsJson({ error: 'Storage is not set up for direct uploads.' }, 503);
  // picked=1: the file the photo was picked as, sent whole before finish
  if (url.searchParams.get('picked') === '1') {
    var twin = await pickedUrl(env, row.r2_key);
    return twin ? corsJson({ ok: true, url: twin }) : corsJson({ error: 'not found' }, 404);
  }
  var n = Math.round(Number(url.searchParams.get('n')));
  if (!n || n < 1 || n > partsOf(row.bytes, row.part_size)) return corsJson({ error: 'bad slice number' }, 400);
  return corsJson({ ok: true, n: n, url: await directPartUrl(env, row.r2_key, directIdOf(row.upload_id), n) });
}

async function uploadPart(request: Request, env: Env, url: URL): Promise<Response> {
  var row = await uploadRow(env, url.searchParams.get('file'), url.searchParams.get('token'));
  if (!row) return corsJson({ error: 'not found' }, 404);
  if (isDirect(row.upload_id)) return corsJson({ error: 'this file goes straight to storage' }, 409);
  var n = Math.round(Number(url.searchParams.get('n')));
  var count = partsOf(row.bytes, row.part_size);
  if (!n || n < 1 || n > count) return corsJson({ error: 'bad slice number' }, 400);
  var body = await request.arrayBuffer();
  var expect = n < count ? row.part_size : row.bytes - row.part_size * (count - 1);
  if (body.byteLength !== expect) {
    return corsJson({ error: 'slice ' + n + ' should be ' + expect + ' bytes, got ' + body.byteLength }, 400);
  }
  var sent = await env.SUBMIT.resumeMultipartUpload(row.r2_key, row.upload_id).uploadPart(n, body);
  // one that lands after finish is not written back beside it
  var kept = await env.DB.prepare(
    'INSERT OR REPLACE INTO album_upload_parts (photo_id, part_n, etag) SELECT ?1, ?2, ?3 ' +
    "WHERE EXISTS (SELECT 1 FROM album_photos WHERE id = ?1 AND status = 'uploading')"
  ).bind(row.id, n, sent.etag).run();
  if (!(kept.meta && kept.meta.changes)) return corsJson({ error: 'not found' }, 404);
  return corsJson({ ok: true, n: n });
}

async function uploadFinish(request: Request, env: Env): Promise<Response> {
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return corsJson({ error: 'body must be JSON' }, 400); }
  var row = await uploadRow(env, body.file, body.token);
  if (!row) return corsJson({ error: 'not found' }, 404);
  if (isDirect(row.upload_id)) {
    var problem = await directJoin(env, row.r2_key, directIdOf(row.upload_id), row.bytes, row.part_size);
    if (problem) return corsJson({ error: problem.error }, problem.status);
  } else {
    var count = partsOf(row.bytes, row.part_size);
    var parts = (await env.DB.prepare(
      'SELECT part_n, etag FROM album_upload_parts WHERE photo_id = ?1 ORDER BY part_n'
    ).bind(row.id).all<Pick<AlbumUploadPartRow, 'part_n' | 'etag'>>()).results;
    if (parts.length !== count) return corsJson({ error: parts.length + ' of ' + count + ' slices arrived' }, 409);
    try {
      await env.SUBMIT.resumeMultipartUpload(row.r2_key, row.upload_id).complete(
        parts.map(function (p) { return { partNumber: p.part_n, etag: p.etag }; })
      );
    } catch (err) {
      return corsJson({ error: 'The slices could not be put together. Send it again.' }, 500);
    }
  }
  // a photo's first bytes have to say it is one, as a photo sent whole does
  if (!isVideoType(row.content_type)) {
    var stored = await env.SUBMIT.get(row.r2_key, { range: { offset: 0, length: 16 } });
    var head = stored ? new Uint8Array(await stored.arrayBuffer()).slice(0, 16) : new Uint8Array(0);
    if (!imageMatches(row.content_type, head)) {
      await dropPhoto(env, { r2_key: row.r2_key, upload_id: null });
      return corsJson({ error: (row.name || 'That file') + ' is not a photo or a video.' }, 400);
    }
  }
  // one sent to replace a photo goes in under the photo's key; with the
  // photo gone since, it stays as an upload of its own
  var replaces = await replacesOf(env.DB, row.id);
  var target = replaces ? await env.DB.prepare(
    "SELECT * FROM album_photos WHERE id = ?1 AND status != 'uploading'"
  ).bind(replaces).first<AlbumPhotoRow>() : null;
  if (target) {
    // Two finishes of one upload can both get this far. Taking the
    // token is the claim: the one that takes it does the swap, and the
    // other answers as the swap will (an abort cannot follow either,
    // since it needs the token too).
    var mine = await env.DB.prepare(
      "UPDATE album_photos SET upload_token = '' WHERE id = ?1 AND status = 'uploading' AND upload_token = ?2"
    ).bind(row.id, row.upload_token).run();
    if (!(mine.meta && mine.meta.changes)) return corsJson({ ok: true, replaced: true });
    try {
      await swapIn(env, row.id, target);
    } catch (err) {
      await dropPhoto(env, { r2_key: row.r2_key, upload_id: null });
      return corsJson({ error: (row.name || 'That photo') + ' could not be put in place of the old one. Send it again.' }, 502);
    }
    await albumsMoved(env.DB);
    return corsJson({ ok: true, replaced: true });
  }
  var flipped = await env.DB.batch([
    env.DB.prepare("UPDATE album_photos SET status = 'ready', upload_id = NULL, upload_token = '' WHERE id = ?1 AND status = 'uploading'").bind(row.id),
    env.DB.prepare('DELETE FROM album_upload_parts WHERE photo_id = ?1').bind(row.id)
  ]);
  // a second finish has nothing more to do, and one whose row was taken
  // away while it ran (an abort, a delete on the dashboard) leaves the
  // file to whatever took the row, which deletes it
  if (!(flipped[0].meta && flipped[0].meta.changes)) return corsJson({ ok: true });
  // when it was taken, which for a photo writes its metadata block, and
  // the file it was picked as read
  await noteTaken(env, row.r2_key, row.content_type);
  await settlePicked(env, row.r2_key, MAX_FILE_BYTES);
  await albumsMoved(env.DB);
  return corsJson({ ok: true });
}

// A video the page gave up on: its slices, its small copy and its row.
async function uploadAbort(request: Request, env: Env): Promise<Response> {
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return corsJson({ error: 'body must be JSON' }, 400); }
  var row = await uploadRow(env, body.file, body.token);
  if (!row) return corsJson({ error: 'not found' }, 404);
  // the row goes first, and only while it is still uploading: a finish
  // that got there first keeps its photo
  var gone = await env.DB.batch([
    env.DB.prepare("DELETE FROM album_photos WHERE id = ?1 AND status = 'uploading' AND upload_token = ?2").bind(row.id, row.upload_token),
    env.DB.prepare('DELETE FROM album_upload_parts WHERE photo_id = ?1 AND NOT EXISTS (SELECT 1 FROM album_photos WHERE id = ?1)').bind(row.id)
  ]);
  if (!(gone[0].meta && gone[0].meta.changes)) return corsJson({ error: 'not found' }, 404);
  await dropPhoto(env, row);
  return corsJson({ ok: true });
}

// ---------- one photo, shared ----------

// The photo behind a share link, while it is on the site somewhere: an
// upload in an album that is not hidden, or a gallery file shown in such
// an album (the whole gallery or its team picked) and not taken out of
// it. A hidden team's (where the album does not show them), or a video
// the encoder has not finished, is not.
async function sharedPhoto(db: D1Database, key: string): Promise<MediaItem | null> {
  if (key.indexOf('alb/') === 0) {
    var r = await db.prepare(
      'SELECT a.*, p.r2_key, p.content_type, p.width, p.height, p.status, p.encode_state, p.added_by, ' +
      't.name AS team, COALESCE(t.hidden, 0) AS team_hidden, a.hidden AS album_hidden ' +
      'FROM album_photos p JOIN albums a ON a.id = p.album_id LEFT JOIN teams t ON t.id = p.team_id WHERE p.r2_key = ?1'
    ).bind(key).first<AlbumRow & Pick<AlbumPhotoRow, 'r2_key' | 'content_type' | 'width' | 'height' | 'status' | 'encode_state' | 'added_by'> &
      { team: string | null; team_hidden: number; album_hidden: number }>();
    if (!r || r.album_hidden || (r.team_hidden && !r.show_hidden) || r.status === 'uploading') return null;
    if (isVideoType(r.content_type) && r.encode_state !== 'done') return null;
    return { key: key, type: r.content_type, from: 'album', who: r.team || r.added_by || '', by: r.team ? 'team' : 'person', w: r.width, h: r.height,
      ver: await photoVersion(db, key) };
  }
  var g = await db.prepare(
    'SELECT f.r2_key, f.content_type, f.encode_state, s.quest_code, t.name AS team ' +
    'FROM submission_files f JOIN submissions s ON s.id = f.submission_id JOIN teams t ON t.id = s.team_id ' +
    "WHERE f.r2_key = ?1 AND s.gallery = 1 AND s.status = 'accepted' AND f.status != 'uploading' AND " + SHOWN + ' ' +
    'AND EXISTS (SELECT 1 FROM albums a WHERE ' + showsGallery() + ' AND a.hidden = 0 AND (t.hidden = 0 OR a.show_hidden = 1) ' +
    'AND NOT EXISTS (SELECT 1 FROM album_skips k WHERE k.album_id = a.id AND k.r2_key = f.r2_key))'
  ).bind(key).first<GalleryHit>();
  if (!g) return null;
  if (isVideoType(g.content_type) && g.encode_state !== 'done') return null;
  await nameDeleted(db, [g], 'quest_code', 'files', function (hit) { return hit.r2_key; });
  return { key: key, type: g.content_type, from: 'gallery', who: g.team, quest: g.quest_code, w: 0, h: 0 };
}

// GET /photo/<share>: a photo or video from an album, on a page of its own.
async function sharePage(env: Env, url: URL): Promise<Response> {
  var key = keyOfShare(decodeURIComponent(url.pathname.slice('/photo/'.length)).replace(/\/+$/, ''));
  var to = key ? await pointedAt(env.DB, key) : null;
  if (to) {
    var moved = new URL(url);
    moved.pathname = '/photo/' + shareId(to.key);
    return movedTo(moved);
  }
  var photo = key ? await sharedPhoto(env.DB, key) : null;
  if (!photo) return gonePage(env, 'This photo is not shared any more.');
  return mediaPage(env, url, photo);
}

// GET /view/<key>/<name>: a proof or album file on a page of its own,
// which is where a video's Share and Copy link go.
async function viewPage(env: Env, url: URL): Promise<Response> {
  var m = decodeURIComponent(url.pathname).match(/^\/view\/((?:sub|alb)\/(?:\d+\/)?[A-Za-z0-9_-]{6,64})(\/[^/]*)?\/?$/);
  var to = m ? await pointedAt(env.DB, m[1]) : null;
  if (to) {
    var moved = new URL(url);
    moved.pathname = '/view/' + to.key + ((m && m[2]) || '');
    return movedTo(moved);
  }
  var item = m ? await viewedFile(env.DB, m[1]) : null;
  if (!item) return gonePage(env, 'There is nothing at this address.');
  return mediaPage(env, url, item);
}

// ---------- the whole album as a ZIP ----------
// Everything the album shows, as the files were sent (the dashboard's own
// read serves originals too), in parts of at most ZIP_FILES files and
// about ZIP_BYTES, so no one request runs for hours or reads more than a
// few hundred objects; a file bigger than that is a part on its own. The
// oldest first, so a photo added later lands in the last part and the
// earlier parts stay as they were. The link is made on the dashboard and
// signed with the console password, good for ZIP_HOURS: a download is a
// plain address the browser fetches, so it cannot carry the session.
var ZIP_FILES = 300;
var ZIP_BYTES = 2 * 1024 * 1024 * 1024;
var ZIP_HOURS = 6;
var ZIP_ZONE = 'Australia/Sydney';

async function zipItems(db: D1Database, album: AlbumRow): Promise<ZipRow[]> {
  var rows = await overItems<ZipRow>(db, album, false, function (items) {
    return 'SELECT i.key, i.type, i.name, i.at, i.taken, i.src, i.id, ' +
      "COALESCE(CASE WHEN i.src = 'album' THEN (SELECT bytes FROM album_photos WHERE id = i.id) " +
      'ELSE (SELECT bytes FROM submission_files WHERE id = i.id) END, 0) AS bytes ' +
      "FROM (" + items + ") i WHERE i.status != 'uploading' ORDER BY i.at, i.src, i.id";
  });
  return rows.filter(function (r) { return r.key && (isVideoType(r.type) || baseType(r.type).indexOf('image/') === 0); });
}

function zipParts(items: ZipRow[]): ZipPart[] {
  var parts: ZipPart[] = [];
  var cur = null as ZipPart | null;
  items.forEach(function (r) {
    var size = Number(r.bytes) || 0;
    if (!cur || cur.items.length >= ZIP_FILES || (cur.items.length && cur.bytes + size > ZIP_BYTES)) {
      cur = { items: [], bytes: 0 };
      parts.push(cur);
    }
    cur.items.push(r);
    cur.bytes += size;
  });
  return parts;
}

async function zipSig(env: Env, albumId: unknown, expiry: unknown): Promise<string> {
  var te = new TextEncoder();
  var key = await crypto.subtle.importKey('raw', te.encode(String(env.CONSOLE_PASSWORD)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, te.encode('album-zip:' + albumId + ':' + expiry)));
}

function zipFileName(album: Pick<AlbumRow, 'slug' | 'name'>, n: number, of: number): string {
  var base = String(album.slug || album.name || 'album').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'album';
  return base + (of > 1 ? '-part-' + n + '-of-' + of : '') + '.zip';
}

// GET album/zip?id=: the parts and a link to each.
async function albumZipLinks(env: Env, session: ConsoleSession, url: URL, logAction: LogAction): Promise<Response> {
  if (!configured(env.CONSOLE_PASSWORD)) return json({ error: 'Set CONSOLE_PASSWORD to download an album.' }, 503);
  if (!env.SUBMIT) return json({ error: 'Uploads are not switched on.' }, 503);
  var album = await env.DB.prepare('SELECT * FROM albums WHERE id = ?1').bind(Number(url.searchParams.get('id')) || 0).first<AlbumRow>();
  if (!album) return json({ error: 'no such album' }, 404);
  var albumRow = album;
  var parts = zipParts(await zipItems(env.DB, album));
  if (!parts.length) return json({ error: 'There is nothing in this album to download.' }, 409);
  var expiry = Math.floor(Date.now() / 1000) + ZIP_HOURS * 3600;
  var pass = album.id + '.' + expiry + '.' + (await zipSig(env, album.id, expiry));
  var out = parts.map(function (p, i) {
    var n = i + 1;
    return {
      n: n, files: p.items.length, bytes: p.bytes,
      url: url.origin + '/api/albums/zip/' + zipFileName(albumRow, n, parts.length) + '?pass=' + encodeURIComponent(pass) + '&part=' + n
    };
  });
  var total = parts.reduce(function (t, p) { return t + p.items.length; }, 0);
  await logAction(env.DB, session.name, 'album-zip', album.name, total + ' files in ' + parts.length + (parts.length === 1 ? ' part' : ' parts'), 0, 0, 0);
  return json({ ok: true, parts: out, hours: ZIP_HOURS });
}

// GET /api/albums/zip/<name>.zip?pass=&part=: one part, streamed.
async function serveAlbumZip(env: Env, url: URL): Promise<Response> {
  var plain = function (msg: string, status: number) {
    return new Response(msg, { status: status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  };
  var m = /^(\d{1,12})\.(\d{9,12})\.([A-Za-z0-9_-]{20,64})$/.exec(String(url.searchParams.get('pass') || ''));
  if (!m || !configured(env.CONSOLE_PASSWORD) || !env.SUBMIT) return plain('This download link does not work.', 403);
  if (Number(m[2]) < Date.now() / 1000) return plain('This download link has run out. Make a new one on the dashboard.', 403);
  if (!(await secretMatches(m[3], await zipSig(env, m[1], m[2])))) return plain('This download link does not work.', 403);
  var album = await env.DB.prepare('SELECT * FROM albums WHERE id = ?1').bind(Number(m[1])).first<AlbumRow>();
  if (!album) return plain('This album is not there any more.', 404);
  var parts = zipParts(await zipItems(env.DB, album));
  var n = Math.floor(Number(url.searchParams.get('part')) || 1);
  var part = parts[n - 1];
  if (!part) return plain('This album has fewer parts now. Make a new link on the dashboard.', 404);
  // the real sizes, a few at a time, since the length goes out first; a
  // file gone since it was listed is left out, and a video whose original
  // has been deleted (originals.ts) goes in as its clean copy
  var found: { r: ZipRow; key: string; size: number }[] = [];
  for (var i = 0; i < part.items.length; i += 8) {
    var batch = part.items.slice(i, i + 8);
    var heads = await Promise.all(batch.map(async function (r) {
      var head = await env.SUBMIT.head(r.key);
      if (head || !isVideoType(r.type)) return head ? { key: r.key, size: head.size } : null;
      var clean = await env.SUBMIT.head(r.key + '.c');
      return clean ? { key: r.key + '.c', size: clean.size } : null;
    }));
    batch.forEach(function (r, j) { var h = heads[j]; if (h) found.push({ r: r, key: h.key, size: h.size }); });
  }
  var names = zipNames(found.map(function (f) {
    var name = String(f.r.name || '').trim() || (isVideoType(f.r.type) ? 'video' : 'photo');
    return fileNameFor(name, f.r.type);
  }));
  var plan = zipPlan(found.map(function (f, k) {
    var when = Date.parse(String(f.r.taken || f.r.at || '').replace(' ', 'T') + 'Z');
    return { key: f.key, size: f.size, name: names[k], mtime: isNaN(when) ? 0 : when / 1000 };
  }), { zone: ZIP_ZONE });
  var file = zipFileName(album, n, parts.length);
  var headers: Record<string, string> = {
    'content-type': 'application/zip',
    'content-disposition': 'attachment; filename="' + file + '"',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff'
  };
  var stream = zipStream(env.SUBMIT, plan);
  // the runtime sends a length only for a stream whose length is known
  if (typeof FixedLengthStream === 'function') {
    var fixed = new FixedLengthStream(plan.total);
    stream.pipeTo(fixed.writable).catch(function () { /* the download was stopped, or a file could not be read */ });
    headers['content-length'] = String(plan.total);
    return new Response(fixed.readable, { status: 200, headers: headers });
  }
  return new Response(stream, { status: 200, headers: headers });
}

var PUBLIC_PATHS = ['/api/albums', '/api/album', '/api/albums/file', '/api/albums/info', '/api/album/upload',
  '/api/album/upload/part', '/api/album/upload/finish', '/api/album/upload/abort',
  '/api/album/upload/mode', '/api/album/upload/sign'];

export async function handleAlbumsApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  var path = url.pathname;
  // the file again at a path ending in its name, which is how a chat
  // app tells a picture from a page
  var named = path.match(/^\/api\/albums\/file\/(alb\/[A-Za-z0-9_-]+)\/[^/]*$/);
  var zipped = request.method === 'GET' && /^\/api\/albums\/zip(\/[^/]*)?$/.test(path);
  var shared = request.method === 'GET' && path.indexOf('/photo/') === 0;
  var viewed = request.method === 'GET' && path.indexOf('/view/') === 0;
  if (PUBLIC_PATHS.indexOf(path) === -1 && !named && !shared && !viewed && !zipped) return null;
  if (zipped) return await serveAlbumZip(env, url);
  if (shared) return await sharePage(env, url);
  if (viewed) return await viewPage(env, url);
  if (request.method === 'GET' && named) return await serveAlbumFile(env, request, url, decodeURIComponent(named[1]));
  if (request.method === 'GET' && path === '/api/albums') return await publicList(env, url);
  if (request.method === 'GET' && path === '/api/album') return await publicAlbum(env, url);
  if (request.method === 'GET' && path === '/api/albums/file') return await serveAlbumFile(env, request, url);
  if (request.method === 'GET' && path === '/api/albums/info') return await photoInfo(env, url);
  if (request.method === 'POST' && path === '/api/album/upload') return await publicUpload(request, env);
  // whether files go straight to R2, asked before a send
  if (request.method === 'GET' && path === '/api/album/upload/mode') {
    return corsJson({ ok: true, direct: directReady(env), part_size: PART_BYTES });
  }
  if (request.method === 'GET' && path === '/api/album/upload/sign') return await uploadSign(env, url);
  if (request.method === 'PUT' && path === '/api/album/upload/part') return await uploadPart(request, env, url);
  if (request.method === 'POST' && path === '/api/album/upload/finish') return await uploadFinish(request, env);
  if (request.method === 'POST' && path === '/api/album/upload/abort') return await uploadAbort(request, env);
  return null;
}

// ---------- the dashboard (the Files tab) ----------

// A deleted team comes off every album it was picked for.
export async function forgetTeam(db: D1Database, teamId: number): Promise<void> {
  await db.prepare('DELETE FROM album_teams WHERE team_id = ?1').bind(teamId).run();
}

// The teams picked for each album, by the album's id.
async function pickedTeams(db: D1Database): Promise<Record<number, number[]>> {
  var out: Record<number, number[]> = {};
  (await db.prepare('SELECT album_id, team_id FROM album_teams ORDER BY album_id, team_id').all<AlbumTeamRow>()).results.forEach(function (r) {
    (out[r.album_id] = out[r.album_id] || []).push(r.team_id);
  });
  return out;
}

// Every team, for the album form to pick from, with how many photos and
// videos it has in the gallery; the teams with any come first.
async function galleryTeams(db: D1Database): Promise<{ id: number; name: string; hidden: boolean; gallery: number }[]> {
  return (await db.prepare(
    'SELECT t.id, t.name, t.hidden, COUNT(f.id) AS n FROM teams t ' +
    "LEFT JOIN submissions s ON s.team_id = t.id AND s.gallery = 1 AND s.status = 'accepted' " +
    "LEFT JOIN submission_files f ON f.submission_id = s.id AND f.status != 'uploading' AND " + SHOWN + ' ' +
    'GROUP BY t.id ORDER BY COUNT(f.id) = 0, t.name COLLATE NOCASE'
  ).all<Pick<TeamRow, 'id' | 'name' | 'hidden'> & { n: number }>()).results.map(function (t) { return { id: t.id, name: t.name, hidden: !!t.hidden, gallery: t.n }; });
}

// Replaces the teams picked for an album.
async function setAlbumTeams(db: D1Database, albumId: number, ids: number[]): Promise<void> {
  var writes = [db.prepare('DELETE FROM album_teams WHERE album_id = ?1').bind(albumId)];
  if (ids.length) {
    writes.push(db.prepare(
      'INSERT OR IGNORE INTO album_teams (album_id, team_id) SELECT ?1, id FROM teams WHERE id IN (SELECT value FROM json_each(?2))'
    ).bind(albumId, JSON.stringify(ids)));
  }
  await db.batch(writes);
}

async function consoleList(env: Env): Promise<Response> {
  // an album made before links had keys gets one the first time it is listed
  await env.DB.prepare("UPDATE albums SET link_key = lower(hex(randomblob(9))) WHERE link_key = ''").run();
  var albums = (await env.DB.prepare('SELECT * FROM albums ORDER BY sort, id').all<AlbumRow>()).results;
  // what the public sees in full, and what was added to the album itself
  var counts = await Promise.all(albums.map(function (a) {
    return overItems<{ shown: number; uploads: number }>(env.DB, a, true, function (items) {
      return 'SELECT COALESCE(SUM(CASE WHEN skipped = 0 AND NOT (src = ' + "'album'" + ' AND team_hidden = 1 AND ?3 = 0) ' +
        "AND status != 'uploading' AND (type NOT LIKE 'video/%' OR encode = 'done') THEN 1 ELSE 0 END), 0) AS shown, " +
        "COALESCE(SUM(CASE WHEN src = 'album' AND album_id = ?1 THEN 1 ELSE 0 END), 0) AS uploads FROM (" + items + ')';
    });
  }));
  var picked = await pickedTeams(env.DB);
  var out = albums.map(function (a, i) {
    var c = counts[i][0] || { shown: 0, uploads: 0 };
    return Object.assign(albumOut(a), { count: c.shown, uploads: c.uploads, teams: picked[a.id] || [] });
  });
  return json({ ok: true, albums: out, teams: await galleryTeams(env.DB), turnstile: !!turnstileSiteKey(env),
    site: String(env.SITE_URL || 'https://scs.andyrew.space') });
}

// A pass that opens the album on the site for a day: the way an organiser
// sees an album the public cannot, a merged one above all, and runs its
// slideshow there.
async function albumPass(env: Env, url: URL): Promise<Response> {
  if (!configured(env.CONSOLE_PASSWORD)) return json({ error: 'Set CONSOLE_PASSWORD to open an album this way.' }, 503);
  var album = await env.DB.prepare('SELECT id FROM albums WHERE id = ?1').bind(Number(url.searchParams.get('id')) || 0).first<Pick<AlbumRow, 'id'>>();
  if (!album) return json({ error: 'no such album' }, 404);
  var pass = await makeViewPass(env, album.id);
  return json({ ok: true, url: String(env.SITE_URL || 'https://scs.andyrew.space') + '/albums/?pass=' + encodeURIComponent(pass), hours: VIEW_HOURS });
}

async function consoleAlbum(env: Env, url: URL): Promise<Response> {
  var album = await env.DB.prepare('SELECT * FROM albums WHERE id = ?1').bind(Number(url.searchParams.get('id')) || 0).first<AlbumRow>();
  if (!album) return json({ error: 'no such album' }, 404);
  return json({ ok: true, album: albumOut(album), photos: await albumPhotos(env.DB, album, true) });
}

// The albums merged into one, written on their own. Only albums that are
// there, not the album itself and not merged albums themselves; and an
// album merged into another merges nothing itself, so merges stay one
// level. Both are asked in the write, so two saves at once cannot nest
// one inside the other.
async function setMerges(db: D1Database, id: number, ids: number[]): Promise<void> {
  await db.prepare(
    'UPDATE albums SET merges = CASE WHEN EXISTS (SELECT 1 FROM albums a, ' +
    "json_each(CASE WHEN a.merges IN ('', '[]') THEN '[]' ELSE a.merges END) j WHERE a.id != ?1 AND j.value = ?1) " +
    "THEN '' ELSE COALESCE(NULLIF((SELECT json_group_array(id) FROM albums WHERE id IN (SELECT value FROM json_each(?2)) " +
    "AND id != ?1 AND merges IN ('', '[]')), '[]'), '') END WHERE id = ?1"
  ).bind(id, JSON.stringify(ids)).run();
}

// The order an album opens in, left as it is when none is given.
async function setPhotoOrder(db: D1Database, id: number, order: string): Promise<void> {
  if (!order) return;
  await db.prepare('UPDATE albums SET photo_order = ?2 WHERE id = ?1').bind(id, order).run();
}

async function saveAlbum(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var name = cleanText(body.name, 80);
  if (!name) return json({ error: 'The album needs a name.' }, 400);
  var adding = (ADDING as unknown[]).indexOf(body.adding) !== -1 ? body.adding as string : 'teams';
  var about = String(body.about == null ? '' : body.about).replace(/\r\n/g, '\n').slice(0, 1000).trim();
  var gallery = body.gallery ? 1 : 0;
  var showHidden = body.show_hidden ? 1 : 0;
  // on unless said otherwise, for a new album; an edit that does not say
  // keeps what the album had
  var details = body.details === undefined ? null : body.details ? 1 : 0;
  // the order it opens in, kept as it was when an edit does not say
  var opensIn = body.order === 'taken' || body.order === 'added' ? body.order : '';
  // the teams whose gallery submissions it shows without the whole
  // gallery; an edit that does not send them keeps what the album had
  var teams = Array.isArray(body.teams) ? body.teams.map(Number).filter(function (n) {
    return n > 0 && Math.floor(n) === n;
  }).slice(0, 1000) : null;
  // the albums merged into it; an edit that does not send them keeps them
  var merges = Array.isArray(body.merges) ? body.merges.map(Number).filter(function (n) {
    return n > 0 && Math.floor(n) === n;
  }).slice(0, 200) : null;
  var seen = (VISIBILITY as unknown[]).indexOf(body.visibility) !== -1 ? body.visibility as string : body.hidden ? 'hidden' : 'listed';
  var hidden = seen === 'hidden' ? 1 : 0;
  var unlisted = seen === 'link' ? 1 : 0;
  var id = Number(body.id) || 0;
  if (id) {
    var cur = await db.prepare('SELECT id FROM albums WHERE id = ?1').bind(id).first();
    if (!cur) return json({ error: 'no such album' }, 404);
    await db.prepare('UPDATE albums SET name = ?2, about = ?3, adding = ?4, gallery = ?5, hidden = ?6, unlisted = ?7, show_hidden = ?8, ' +
      'details = COALESCE(?9, details) WHERE id = ?1')
      .bind(id, name, about, adding, gallery, hidden, unlisted, showHidden, details).run();
    if (teams) await setAlbumTeams(db, id, teams);
    await setPhotoOrder(db, id, opensIn);
    if (merges) await setMerges(db, id, merges);
    await logAction(db, session.name, 'album-save', name, '-', 0, 0, 0);
  } else {
    // the address is made once from the name and kept, so a link that
    // has been shared keeps working after a rename
    var base = slugFrom(name);
    var slug = base;
    for (var n = 2; await db.prepare('SELECT 1 FROM albums WHERE slug = ?1').bind(slug).first(); n++) slug = base + '-' + n;
    var last = await db.prepare('SELECT COALESCE(MAX(sort), 0) AS n FROM albums').first<{ n: number }>() as { n: number };
    var made = await db.prepare(
      'INSERT INTO albums (slug, name, about, adding, gallery, hidden, sort, created_by, unlisted, link_key, show_hidden, details) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)'
    ).bind(slug, name, about, adding, gallery, hidden, last.n + 1, session.name, unlisted, randomKey(12), showHidden, details === null ? 1 : details).run();
    var madeId = made.meta && made.meta.last_row_id;
    if (teams && teams.length && madeId) await setAlbumTeams(db, madeId, teams);
    if (madeId) await setPhotoOrder(db, madeId, opensIn);
    if (madeId && merges) await setMerges(db, madeId, merges);
    await logAction(db, session.name, 'album-add', name, '-', 0, 0, 0);
  }
  return consoleList(env);
}

// An upload and everything made from it: its row, its slices if it was
// still arriving, its copies, and a video's smaller copies.
async function dropPhoto(env: Env, row: { r2_key: string; upload_id: string | null }): Promise<void> {
  var db = env.DB;
  var key = row.r2_key;
  // what pointed here comes back into the album
  await db.prepare("UPDATE album_photos SET points_to = '' WHERE points_to = ?1").bind(key).run();
  var made = (await db.prepare('SELECT key FROM submission_renditions WHERE file_key = ?1').bind(key).all<Pick<SubmissionRenditionRow, 'key'>>()).results;
  await db.batch([
    db.prepare('DELETE FROM album_upload_parts WHERE photo_id = (SELECT id FROM album_photos WHERE r2_key = ?1)').bind(key),
    db.prepare('DELETE FROM submission_renditions WHERE file_key = ?1').bind(key),
    db.prepare('DELETE FROM album_photos WHERE r2_key = ?1').bind(key)
  ]);
  if (!env.SUBMIT) return;
  if (row.upload_id && isDirect(row.upload_id)) {
    try { await directAbort(env, key, directIdOf(row.upload_id)); } catch (err) { /* R2 clears it in time */ }
  } else if (row.upload_id && typeof env.SUBMIT.resumeMultipartUpload === 'function') {
    try { await env.SUBMIT.resumeMultipartUpload(key, row.upload_id).abort(); } catch (err) { /* already gone */ }
  }
  await deleteStored(env.SUBMIT, key);
  for (var i = 0; i < made.length; i++) {
    try { await env.SUBMIT.delete(made[i].key); } catch (err) { /* already gone */ }
  }
}

// Deleting an album with uploads in it takes its name typed back.
async function deleteAlbum(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var album = await db.prepare('SELECT * FROM albums WHERE id = ?1').bind(Number(body.id) || 0).first<AlbumRow>();
  if (!album) return json({ error: 'no such album' }, 404);
  var albumId = album.id;
  var rows = (await db.prepare('SELECT r2_key, upload_id FROM album_photos WHERE album_id = ?1').bind(album.id).all<Pick<AlbumPhotoRow, 'r2_key' | 'upload_id'>>()).results;
  if (rows.length && cleanText(body.confirm, 80).toLowerCase() !== album.name.toLowerCase()) {
    return json({ error: 'Type ' + album.name + ' to delete it and the ' + rows.length + (rows.length === 1 ? ' file' : ' files') + ' added to it.' }, 428);
  }
  for (var i = 0; i < rows.length; i++) await dropPhoto(env, rows[i]);
  await db.prepare('DELETE FROM album_teams WHERE album_id = ?1').bind(album.id).run();
  await db.batch([
    db.prepare('DELETE FROM album_skips WHERE album_id = ?1').bind(album.id),
    db.prepare('DELETE FROM albums WHERE id = ?1').bind(album.id)
  ]);
  // and out of every album it was merged into
  var merged = (await db.prepare("SELECT id, merges FROM albums WHERE merges NOT IN ('', '[]')").all<Pick<AlbumRow, 'id' | 'merges'>>()).results;
  for (var j = 0; j < merged.length; j++) {
    var left = mergeIds(merged[j]).filter(function (n) { return n !== albumId; });
    if (left.length !== mergeIds(merged[j]).length) {
      await db.prepare('UPDATE albums SET merges = ?2 WHERE id = ?1').bind(merged[j].id, left.length ? JSON.stringify(left) : '').run();
    }
  }
  await logAction(db, session.name, 'album-delete', album.name, rows.length + ' files', 0, 0, 0);
  return consoleList(env);
}

// Takes a photo or video out of an album: an upload is deleted, a
// gallery file is kept out of this album. `back` puts a gallery file
// back.
async function removePhoto(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var album = await db.prepare('SELECT * FROM albums WHERE id = ?1').bind(Number(body.id) || 0).first<AlbumRow>();
  if (!album) return json({ error: 'no such album' }, 404);
  var key = String(body.key || '');
  if (key.indexOf('alb/') === 0) {
    var row = await db.prepare('SELECT r2_key, upload_id FROM album_photos WHERE album_id = ?1 AND r2_key = ?2').bind(album.id, key).first<Pick<AlbumPhotoRow, 'r2_key' | 'upload_id'>>();
    if (!row) return json({ error: 'That is not in this album.' }, 404);
    await dropPhoto(env, row);
    await logAction(db, session.name, 'album-photo-delete', album.name, key, 0, 0, 0);
  } else if (key.indexOf('sub/') === 0) {
    if (body.back) await db.prepare('DELETE FROM album_skips WHERE album_id = ?1 AND r2_key = ?2').bind(album.id, key).run();
    else await db.prepare('INSERT OR IGNORE INTO album_skips (album_id, r2_key) VALUES (?1, ?2)').bind(album.id, key).run();
    await logAction(db, session.name, body.back ? 'album-photo-back' : 'album-photo-skip', album.name, key, 0, 0, 0);
  } else {
    return json({ error: 'That is not in this album.' }, 404);
  }
  return json({ ok: true, album: albumOut(album), photos: await albumPhotos(db, album, true) });
}

// Points an upload at another photo in the same album, or (to '') back
// at itself. One hop: anything already pointing at the photo moves to
// where it now points, and a photo that points elsewhere passes on where
// it points.
async function pointPhoto(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var album = await db.prepare('SELECT * FROM albums WHERE id = ?1').bind(Number(body.id) || 0).first<AlbumRow>();
  if (!album) return json({ error: 'no such album' }, 404);
  var key = String(body.key || '');
  var to = String(body.to || '');
  if (key.indexOf('alb/') !== 0) return json({ error: 'Only a photo or video added to this album can point to another.' }, 400);
  var mine = 'SELECT r2_key, name, points_to FROM album_photos WHERE album_id = ?1 AND r2_key = ?2';
  var row = await db.prepare(mine).bind(album.id, key).first<Pick<AlbumPhotoRow, 'r2_key' | 'name' | 'points_to'>>();
  if (!row) return json({ error: 'That is not in this album.' }, 404);
  if (!to) {
    await db.prepare("UPDATE album_photos SET points_to = '' WHERE r2_key = ?1").bind(key).run();
    await logAction(db, session.name, 'album-photo-unpoint', album.name, row.name, 0, 0, 0);
    return json({ ok: true, album: albumOut(album), photos: await albumPhotos(db, album, true) });
  }
  if (to === key) return json({ error: 'A photo cannot point to itself.' }, 400);
  var target = await db.prepare(mine).bind(album.id, to).first<Pick<AlbumPhotoRow, 'r2_key' | 'name' | 'points_to'>>();
  if (!target) return json({ error: 'Pick a photo in this album.' }, 404);
  var end = target.points_to || target.r2_key;
  if (end === key) return json({ error: target.name + ' already points to this one.' }, 409);
  // Only while the photo pointed at still points nowhere itself: two
  // photos pointed at each other at the same moment would each pass
  // the check above, and the pair would hide each other.
  var free = "(SELECT points_to FROM album_photos WHERE r2_key = ?2) = ''";
  var moved = await db.batch([
    db.prepare('UPDATE album_photos SET points_to = ?2 WHERE album_id = ?3 AND points_to = ?1 AND ' + free).bind(key, end, album.id),
    db.prepare('UPDATE album_photos SET points_to = ?2 WHERE r2_key = ?1 AND ' + free).bind(key, end)
  ]);
  if (!(moved[1].meta && moved[1].meta.changes)) {
    return json({ error: target.name + ' was pointed at another photo a moment ago. Look again and pick.' }, 409);
  }
  await logAction(db, session.name, 'album-photo-point', album.name, row.name + ' > ' + target.name, 0, 0, 0);
  return json({ ok: true, album: albumOut(album), photos: await albumPhotos(db, album, true) });
}

// Puts who added them on photos and videos added to an album: a team, or
// a name typed (empty for none). The album's own uploads only: a gallery
// file is its team's, and a merged album's photo is changed in its own
// album. All of them or none.
var AUTHOR_MAX = 500;
async function setAuthor(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var album = await db.prepare('SELECT * FROM albums WHERE id = ?1').bind(Number(body.id) || 0).first<AlbumRow>();
  if (!album) return json({ error: 'no such album' }, 404);
  var keys = Array.isArray(body.keys) ? body.keys.map(String).filter(function (k, i, all) {
    return k.indexOf('alb/') === 0 && all.indexOf(k) === i;
  }) : [];
  if (!keys.length) return json({ error: 'Pick the photos and videos to change.' }, 400);
  if (keys.length > AUTHOR_MAX) return json({ error: 'Change at most ' + AUTHOR_MAX + ' at a time.' }, 400);
  var teamId = Number(body.team_id) || 0;
  var name = '';
  var who = '';
  if (teamId) {
    var team = await db.prepare('SELECT id, name FROM teams WHERE id = ?1').bind(teamId).first<Pick<TeamRow, 'id' | 'name'>>();
    if (!team) return json({ error: 'There is no such team.' }, 404);
    who = team.name;
  } else {
    name = cleanText(body.name, 60);
    who = name || 'no name';
  }
  var list = JSON.stringify(keys);
  var mine = await db.prepare('SELECT COUNT(*) AS n FROM album_photos WHERE album_id = ?1 AND r2_key IN (SELECT value FROM json_each(?2))')
    .bind(album.id, list).first<{ n: number }>();
  var missing = keys.length - (mine ? mine.n : 0);
  if (missing) return json({ error: (missing === 1 ? 'One of those is' : missing + ' of those are') + ' not in this album any more.' }, 409);
  await db.prepare('UPDATE album_photos SET team_id = ?3, added_by = ?4 WHERE album_id = ?1 AND r2_key IN (SELECT value FROM json_each(?2))')
    .bind(album.id, list, teamId || null, name).run();
  await logAction(db, session.name, 'album-author', album.name, keys.length + (keys.length === 1 ? ' file' : ' files') + ' to ' + who, 0, 0, 0);
  return json({ ok: true, changed: keys.length, album: albumOut(album), photos: await albumPhotos(db, album, true) });
}

async function organiserUpload(env: Env, session: ConsoleSession, request: Request, logAction: LogAction): Promise<Response> {
  var form: FormData;
  try { form = await request.formData(); } catch (err) { return json({ error: 'expected a multipart form' }, 400); }
  var album = await env.DB.prepare('SELECT * FROM albums WHERE id = ?1').bind(Number(form.get('id')) || 0).first<AlbumRow>();
  if (!album) return json({ error: 'no such album' }, 404);
  var res = await storePhotos(env, form, album, { team_id: null, by: session.name, ip: '' }, { replace: form.get('replace') === '1' });
  if ('error' in res) return json(res.choose ? { error: res.error, choose: res.choose } : { error: res.error }, res.status);
  if (res.added) await logAction(env.DB, session.name, 'album-upload', album.name, res.added + ' files', 0, 0, 0);
  var swaps = res.replaced.map(function (r) { return r.name; }).concat(
    res.uploads.filter(function (u) { return u.replaces; }).map(function (u) { return u.name; }));
  for (var r = 0; r < swaps.length; r++) await logAction(env.DB, session.name, 'album-replace', album.name, swaps[r], 0, 0, 0);
  return json({ ok: true, added: res.added, replaced: res.replaced, uploads: res.uploads });
}

// The Files tab's albums. Answers null for an action that is not one
// of these.
export async function albumsConsole(env: Env, session: ConsoleSession, request: Request, action: string, url: URL, logAction: LogAction): Promise<Response | null> {
  if (request.method === 'GET' && action === 'albums') return await consoleList(env);
  if (request.method === 'GET' && action === 'album') return await consoleAlbum(env, url);
  if (request.method === 'GET' && action === 'album/pass') return await albumPass(env, url);
  if (request.method === 'GET' && action === 'album/zip') return await albumZipLinks(env, session, url, logAction);
  if (request.method !== 'POST') return null;
  var res: Response | null = null;
  if (action === 'album/upload') res = await organiserUpload(env, session, request, logAction);
  else {
    var body: JsonBody;
    try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
    if (action === 'albums/save') res = await saveAlbum(env, session, body, logAction);
    else if (action === 'albums/delete') res = await deleteAlbum(env, session, body, logAction);
    else if (action === 'album/photo/remove') res = await removePhoto(env, session, body, logAction);
    else if (action === 'album/photo/point') res = await pointPhoto(env, session, body, logAction);
    else if (action === 'album/photos/author') res = await setAuthor(env, session, body, logAction);
  }
  if (res && res.status === 200) await albumsMoved(env.DB);
  return res;
}
