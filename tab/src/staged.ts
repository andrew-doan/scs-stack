// The dashboard's own uploads, straight to R2 (src/r2direct.ts): a
// message's attachments, a quest's files, a home page picture, a file
// for the drop, and proof: the photos on points an organiser records and
// the files Review adds to a submission.
//
// Each of those saves is one multipart request carrying the files, so
// the files pass through the worker and a request's 100MB caps them.
// With the R2 token set, the page first sends each file here instead:
// upload/start names what the file is for and opens an R2 multipart
// upload under the key it will be kept at, upload/sign hands the page a
// signed address for each 20MB slice, and upload/finish joins the slices
// and checks a picture's first bytes. The save then names the file by
// its id (`staged<i>` in place of `file<i>`) and the route adopts it
// (readStaged, claimStaged, releaseStaged below): the row it writes
// points at the key the file is already under, and nothing is read or
// copied.
//
// A file staged and never saved is cleared by the scheduled run a day
// later (stagedSweep). The album uploads do not come through here: they
// have their own upload rows and go straight to R2 the same way the
// submit page's do (albums.ts).
import { json, cleanText, randomKey, utcStamp, deleteStored } from './shared.ts';
import {
  directReady, directStart, directPartUrl, directJoin, directAbort, markDirect, isDirect, directIdOf
} from './r2direct.ts';
import { imageMatches } from './strip.ts';
import { metaBlock } from './photoserve.ts';
import { can } from './dash-access.ts';
import type { ConsoleSession, Env, JsonBody, Refusal, StagedUploadRow } from './types.ts';

type StagedRow = Omit<StagedUploadRow, 'created_at'>;

// A staged file a route may adopt (readStaged).
export interface StagedFile {
  id: number;
  key: string;
  name: string;
  type: string;
  bytes: number;
}

var PART_BYTES = 20 * 1024 * 1024;
var GB = 1024 * 1024 * 1024;
var MB = 1024 * 1024;

// What a staged file may be for: the key it is kept under, the tab an
// account needs to send one, and the most it may weigh. The route that
// adopts it checks the type and its own limits again; these only stop
// an upload nobody could save from being sent.
var PURPOSES: Record<string, { prefix: string; perms: string[]; max: number }> = {
  msg: { prefix: 'msg/', perms: ['messages'], max: 25 * MB },
  qst: { prefix: 'qst/', perms: ['quests'], max: 25 * MB },
  slide: { prefix: 'slide/', perms: ['settings'], max: 25 * MB },
  drop: { prefix: 'drop/', perms: ['files'], max: 4 * GB },
  // proof, for points/add and submissions/files
  points: { prefix: 'sub/', perms: ['points', 'scores', 'review'], max: 4 * GB }
};

// how long a staged file waits to be saved before the sweep clears it
var KEEP_HOURS = 24;

function partsOf(bytes: number): number { return Math.max(1, Math.ceil(bytes / PART_BYTES)); }

function allowedFor(session: ConsoleSession, purpose: string): boolean {
  var p = PURPOSES[purpose];
  return !!p && p.perms.some(function (perm) { return can(session, perm); });
}

async function stagedRow(env: Env, session: ConsoleSession, id: unknown): Promise<StagedRow | null> {
  var n = Number(id);
  if (!n || n !== Math.round(n)) return null;
  return env.DB.prepare(
    'SELECT id, r2_key, upload_id, purpose, name, content_type, bytes, part_size, actor, status ' +
    'FROM staged_uploads WHERE id = ?1 AND actor = ?2'
  ).bind(n, session.name).first<StagedRow>();
}

export async function stagedConsole(env: Env, session: ConsoleSession, verb: string, action: string, body: JsonBody, url: URL): Promise<Response | null> {
  if (verb === 'GET' && action === 'upload/mode') {
    return json({ ok: true, direct: directReady(env), part_size: PART_BYTES });
  }
  if (verb === 'GET' && action === 'upload/sign') return stagedSign(env, session, url);
  if (verb === 'POST' && action === 'upload/start') return stagedStart(env, session, body);
  if (verb === 'POST' && action === 'upload/finish') return stagedFinish(env, session, body);
  if (verb === 'POST' && action === 'upload/abort') return stagedAbort(env, session, body);
  return null;
}

async function stagedStart(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  if (!directReady(env)) return json({ error: 'Storage is not set up for direct uploads.' }, 503);
  var purpose = String(body.purpose || '');
  if (!PURPOSES[purpose]) return json({ error: 'unknown purpose' }, 400);
  if (!allowedFor(session, purpose)) return json({ error: 'Your account cannot upload these.', no_access: true }, 403);
  var size = Number(body.size);
  if (!size || size !== Math.round(size) || size < 1) return json({ error: 'That file is empty.' }, 400);
  if (size > PURPOSES[purpose].max) {
    return json({ error: (cleanText(body.name, 120) || 'That file') + ' is too large.' }, 413);
  }
  var type = String(body.type || '').toLowerCase().split(';')[0].trim() || 'application/octet-stream';
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(type)) return json({ error: 'unknown file type' }, 400);
  var name = cleanText(body.name, 120) || 'file';
  var key = PURPOSES[purpose].prefix + randomKey(12);
  var uploadId: string;
  try { uploadId = await directStart(env, key, type); } catch (err) {
    return json({ error: 'Storage could not be reached. Try again.' }, 502);
  }
  var res = await env.DB.prepare(
    'INSERT INTO staged_uploads (r2_key, upload_id, purpose, name, content_type, bytes, part_size, actor, status, created_at) ' +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'uploading', ?9)"
  ).bind(key, markDirect(uploadId), purpose, name, type, size, PART_BYTES, session.name, utcStamp()).run();
  return json({ ok: true, id: res.meta && res.meta.last_row_id, part_size: PART_BYTES, parts: partsOf(size) });
}

async function stagedSign(env: Env, session: ConsoleSession, url: URL): Promise<Response> {
  var row = await stagedRow(env, session, url.searchParams.get('id'));
  if (!row) return json({ error: 'not found' }, 404);
  if (row.status !== 'uploading') return json({ error: 'already finished' }, 409);
  var n = Number(url.searchParams.get('n'));
  if (!n || n !== Math.round(n) || n < 1 || n > partsOf(row.bytes)) return json({ error: 'bad part number' }, 400);
  if (!directReady(env)) return json({ error: 'Storage is not set up for direct uploads.' }, 503);
  return json({ ok: true, id: row.id, n: n, url: await directPartUrl(env, row.r2_key, directIdOf(row.upload_id), n) },
    200, { 'cache-control': 'no-store' });
}

// The worker never saw a slice: R2 is asked what arrived, the slices are
// joined, and a picture's first bytes have to be what its type says —
// the check every route makes of a file sent through the worker. A
// photo's metadata block is written now, as one sent the other way has
// it at once.
async function stagedFinish(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var row = await stagedRow(env, session, body.id);
  if (!row) return json({ error: 'not found' }, 404);
  if (row.status !== 'uploading') return json({ ok: true, id: row.id, done: true });
  var problem = await directJoin(env, row.r2_key, directIdOf(row.upload_id), row.bytes, row.part_size);
  if (problem) {
    var again = await env.DB.prepare('SELECT status FROM staged_uploads WHERE id = ?1').bind(row.id).first<Pick<StagedUploadRow, 'status'>>();
    if (again && again.status !== 'uploading') return json({ ok: true, id: row.id, done: true });
    return json({ error: problem.error }, problem.status);
  }
  if (row.content_type.indexOf('image/') === 0) {
    var head = await env.SUBMIT.get(row.r2_key, { range: { offset: 0, length: 16 } });
    var first = head ? new Uint8Array(await head.arrayBuffer()) : new Uint8Array(0);
    if (!imageMatches(row.content_type, first)) {
      try { await env.SUBMIT.delete(row.r2_key); } catch (err) { /* already gone */ }
      await env.DB.prepare('DELETE FROM staged_uploads WHERE id = ?1').bind(row.id).run();
      return json({ error: row.name + ' is not the picture its type says.' }, 400);
    }
    try { await metaBlock(env, row.r2_key, row.content_type); } catch (err) { /* the first read makes it */ }
  }
  var flipped = await env.DB.prepare("UPDATE staged_uploads SET status = 'ready', upload_id = NULL WHERE id = ?1 AND status = 'uploading'")
    .bind(row.id).run();
  if (!(flipped.meta && flipped.meta.changes)) {
    // aborted while the slices were being joined: the file just joined
    // is nobody's
    var now = await env.DB.prepare('SELECT status FROM staged_uploads WHERE id = ?1').bind(row.id).first<Pick<StagedUploadRow, 'status'>>();
    if (now) return json({ ok: true, id: row.id, done: true });
    await deleteStored(env.SUBMIT, row.r2_key);
    return json({ error: row.name + ' was cancelled.' }, 409);
  }
  return json({ ok: true, id: row.id, done: true });
}

async function stagedAbort(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  // the status read can be out of date by the time forget writes, so it
  // reads again when it loses (a finish moved it on)
  for (var i = 0; i < 3; i++) {
    var row = await stagedRow(env, session, body.id);
    // a file a save has taken is that save's now
    if (!row || row.status === 'used') return json({ ok: true });
    if (await forget(env, row)) return json({ ok: true });
  }
  return json({ ok: true });
}

// The upload and anything already made from it. The row goes first,
// and only while it is in the state that was read: a save that claimed
// the file in between keeps it, and nothing is deleted from under the
// row that save wrote. Answers whether it went.
async function forget(env: Env, row: Pick<StagedRow, 'id' | 'r2_key' | 'upload_id' | 'status'>): Promise<boolean> {
  var gone = await env.DB.prepare('DELETE FROM staged_uploads WHERE id = ?1 AND status = ?2').bind(row.id, row.status).run();
  if (!(gone.meta && gone.meta.changes)) return false;
  if (row.status === 'uploading' && isDirect(row.upload_id)) {
    try { await directAbort(env, row.r2_key, directIdOf(row.upload_id)); } catch (err) { /* R2 clears it in time */ }
  } else if (row.status === 'ready') {
    await deleteStored(env.SUBMIT, row.r2_key);
  }
  return true;
}

// A route saving a file the page staged, in three steps:
//   readStaged   while it reads the form: the file, finished and sent by
//                this account for this purpose, as {id, key, name, type,
//                bytes}, else {error, status}
//   claimStaged  once everything else has been checked and just before
//                it writes, so a save refused for any other reason leaves
//                the files to be sent again; a second save naming the
//                same file is refused here
//   releaseStaged  in the batch that writes the route's own rows
// The route does not store the file, check its first bytes or write
// its metadata block: the file is under its key already and
// upload/finish did the other two.
export async function readStaged(env: Env, session: ConsoleSession, id: unknown, purpose: string): Promise<StagedFile | Refusal> {
  var row = await stagedRow(env, session, id);
  if (!row || row.purpose !== purpose) return { error: 'That upload is not here any more. Add the file again.', status: 404 };
  if (row.status === 'uploading') return { error: row.name + ' has not finished uploading.', status: 409 };
  if (row.status !== 'ready') return { error: row.name + ' is already saved.', status: 409 };
  return { id: row.id, key: row.r2_key, name: row.name, type: row.content_type, bytes: row.bytes };
}

export async function claimStaged(env: Env, list: Pick<StagedFile, 'id'>[]): Promise<Refusal | null> {
  if (!list.length) return null;
  var ids = JSON.stringify(list.map(function (s) { return s.id; }));
  var claimed = (await env.DB.prepare(
    "UPDATE staged_uploads SET status = 'used' WHERE status = 'ready' AND id IN (SELECT value FROM json_each(?1)) RETURNING id"
  ).bind(ids).all<Pick<StagedUploadRow, 'id'>>()).results;
  if (claimed.length === list.length) return null;
  // one went in the meantime: give back only the ones this save took,
  // never one another save has just claimed
  if (claimed.length) await unclaimStaged(env, claimed);
  return { error: 'Those files are already saved.', status: 409 };
}

// for a save that claimed its files and then failed to write
export async function unclaimStaged(env: Env, list: Pick<StagedFile, 'id'>[]): Promise<void> {
  if (!list.length) return;
  await env.DB.prepare(
    "UPDATE staged_uploads SET status = 'ready' WHERE status = 'used' AND id IN (SELECT value FROM json_each(?1))"
  ).bind(JSON.stringify(list.map(function (s) { return s.id; }))).run();
}

// `where`, with its placeholders from ?2 bound from `args`, is a condition
// the release waits on: the route's own row having gone in, so a save
// whose row did not land can give the file back.
export function releaseStaged(env: Env, staged: Pick<StagedFile, 'id'>, where?: string, args?: unknown[]): D1PreparedStatement {
  var stmt = env.DB.prepare('DELETE FROM staged_uploads WHERE id = ?1' + (where ? ' AND ' + where : ''));
  return stmt.bind.apply(stmt, ([staged.id] as unknown[]).concat(args || []));
}

// What the scheduled run clears: uploads started and never finished,
// and files finished and never saved, a day on. A row the route claimed
// and never released has its file pointed at by a row of the route's,
// or by nothing if the save failed part way; either way only the row
// goes, since deleting the file could take it from under a save.
export async function stagedSweep(env: Env): Promise<number> {
  var rows = (await env.DB.prepare(
    'SELECT id, r2_key, upload_id, status FROM staged_uploads ' +
    "WHERE created_at < datetime('now', ?1) ORDER BY id LIMIT 20"
  ).bind('-' + KEEP_HOURS + ' hours').all<Pick<StagedRow, 'id' | 'r2_key' | 'upload_id' | 'status'>>()).results;
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].status === 'used') await env.DB.prepare("DELETE FROM staged_uploads WHERE id = ?1 AND status = 'used'").bind(rows[i].id).run();
    // one a save claimed since it was read is left; the next run reads it again
    else await forget(env, rows[i]);
  }
  return rows.length;
}
