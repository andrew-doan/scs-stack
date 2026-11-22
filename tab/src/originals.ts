// The proof videos as teams sent them: the files their phones wrote,
// location and all. Nothing public ever serves one (the site plays the
// encoder's copies), so once an organiser has them saved somewhere else
// they can come off the bucket.
//
// GET originals          how many are kept, how many are saved, how many can go
// GET originals/zip      links to download them, in parts, as ZIPs
// GET /api/originals/zip/<name>.zip?pass=&part=   one part; when it has
//                        gone out whole, each video in it counts as saved
// POST originals/delete  {after}: delete the originals that are saved and
//                        have a copy to play, a batch a request
//
// Admin only (dash-access.ts lists none of them); the second password can
// be asked for the delete (GUARDS, originals).
import { json, configured, secretMatches, b64url, fileNameFor, utcStamp } from './shared.ts';
import { zipPlan, zipStream, zipNames } from './zip.ts';
import { nameDeleted } from './deleted.ts';
import type { ConsoleSession, Env, JsonBody, LogAction } from './types.ts';

// the album download's numbers (albums.ts): parts small enough that no
// one request runs for hours, links good for long enough to finish
var ZIP_FILES = 300;
var ZIP_BYTES = 2 * 1024 * 1024 * 1024;
var ZIP_HOURS = 6;
var ZIP_ZONE = 'Australia/Sydney';
// originals deleted a request: two heads and two deletes each
var DELETE_BATCH = 40;

interface Original {
  id: number;
  r2_key: string;
  content_type: string;
  bytes: number;
  name: string | null;
  encode_state: string;
  taken_at: string | null;
  submitted_at: string;
  quest: string;
  team: string | null;
  copies: number;
  saved_at: string | null;
  gone_at: string | null;
}

// Every proof video that has finished uploading, with whether its
// original has been saved and deleted.
async function originals(db: D1Database): Promise<Original[]> {
  var rows = (await db.prepare(
    'SELECT f.id, f.r2_key, f.content_type, f.bytes, f.name, f.encode_state, f.taken_at, s.submitted_at, ' +
    's.quest_code AS quest, t.name AS team, ' +
    '(SELECT COUNT(*) FROM submission_renditions r WHERE r.file_key = f.r2_key) AS copies, o.saved_at, o.gone_at ' +
    'FROM submission_files f JOIN submissions s ON s.id = f.submission_id LEFT JOIN teams t ON t.id = s.team_id ' +
    'LEFT JOIN video_originals o ON o.r2_key = f.r2_key ' +
    "WHERE f.content_type LIKE 'video/%' AND f.status = 'ready' ORDER BY f.id"
  ).all<Original>()).results;
  // a deleted quest's video reads as the quest it came from
  await nameDeleted(db, rows, 'quest', 'files', function (r) { return r.r2_key; });
  return rows;
}

// a copy every page can play in its place: the encoder made one
function encoded(r: Original): boolean { return r.encode_state === 'done' && Number(r.copies) > 0; }
function deletable(r: Original): boolean { return !r.gone_at && !!r.saved_at && encoded(r); }

function sum(rows: Original[]): number {
  return rows.reduce(function (t, r) { return t + (Number(r.bytes) || 0); }, 0);
}

// GET originals
async function originalsStatus(env: Env): Promise<Response> {
  var got = await originals(env.DB);
  var kept = got.filter(function (r) { return !r.gone_at; });
  var saved = kept.filter(function (r) { return r.saved_at; });
  var ready = kept.filter(deletable);
  var unencoded = kept.filter(function (r) { return !encoded(r); });
  return json({
    ok: true,
    kept: kept.length, kept_bytes: sum(kept),
    saved: saved.length,
    deletable: ready.length, deletable_bytes: sum(ready),
    unencoded: unencoded.length,
    gone: got.length - kept.length
  });
}

// ---------- the download ----------
interface Part { items: Original[]; bytes: number }

function parts(rows: Original[]): Part[] {
  var out: Part[] = [];
  var cur = null as Part | null;
  rows.forEach(function (r) {
    var size = Number(r.bytes) || 0;
    if (!cur || cur.items.length >= ZIP_FILES || (cur.items.length && cur.bytes + size > ZIP_BYTES)) {
      cur = { items: [], bytes: 0 };
      out.push(cur);
    }
    cur.items.push(r);
    cur.bytes += size;
  });
  return out;
}

async function kept(db: D1Database): Promise<Original[]> {
  return (await originals(db)).filter(function (r) { return !r.gone_at; });
}

async function zipSig(env: Env, expiry: unknown): Promise<string> {
  var te = new TextEncoder();
  var key = await crypto.subtle.importKey('raw', te.encode(String(env.CONSOLE_PASSWORD)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(await crypto.subtle.sign('HMAC', key, te.encode('video-originals:' + expiry)));
}

function zipFileName(n: number, of: number): string {
  return 'scs2-original-videos' + (of > 1 ? '-part-' + n + '-of-' + of : '') + '.zip';
}

// GET originals/zip: a link to each part
async function originalsZipLinks(env: Env, session: ConsoleSession, url: URL, logAction: LogAction): Promise<Response> {
  if (!configured(env.CONSOLE_PASSWORD)) return json({ error: 'Set CONSOLE_PASSWORD to download the videos.' }, 503);
  if (!env.SUBMIT) return json({ error: 'Uploads are not switched on.' }, 503);
  var got = await originals(env.DB);
  var split = parts(got.filter(function (r) { return !r.gone_at; }));
  if (!split.length) return json({ error: 'There are no original videos left to download.' }, 409);
  var expiry = Math.floor(Date.now() / 1000) + ZIP_HOURS * 3600;
  var pass = expiry + '.' + (await zipSig(env, expiry));
  var out = split.map(function (p, i) {
    var n = i + 1;
    return {
      n: n, files: p.items.length, bytes: p.bytes,
      saved: p.items.every(function (r) { return r.saved_at; }),
      url: url.origin + '/api/originals/zip/' + zipFileName(n, split.length) + '?pass=' + encodeURIComponent(pass) + '&part=' + n
    };
  });
  var files = split.reduce(function (t, p) { return t + p.items.length; }, 0);
  await logAction(env.DB, session.name, 'originals-zip', '-', files + ' videos in ' + split.length + (split.length === 1 ? ' part' : ' parts'), 0, 0, 0);
  return json({ ok: true, parts: out, hours: ZIP_HOURS });
}

// A stream that runs `then` once the last byte has been taken from it,
// and not when the reader gives up part way.
function whenRead(stream: ReadableStream<Uint8Array>, then: () => Promise<void>): ReadableStream<Uint8Array> {
  var reader = stream.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        var got = await reader.read();
        if (got.done) {
          try { await then(); } catch (err) { /* the download still finished */ }
          controller.close();
          return;
        }
        controller.enqueue(got.value);
      } catch (err) {
        controller.error(err);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(function () {});
    }
  }, { highWaterMark: 0 });
}

// GET /api/originals/zip/<name>.zip?pass=&part=
async function serveOriginalsZip(env: Env, url: URL): Promise<Response> {
  var plain = function (msg: string, status: number) {
    return new Response(msg, { status: status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  };
  var m = /^(\d{9,12})\.([A-Za-z0-9_-]{20,64})$/.exec(String(url.searchParams.get('pass') || ''));
  if (!m || !configured(env.CONSOLE_PASSWORD) || !env.SUBMIT) return plain('This download link does not work.', 403);
  if (Number(m[1]) < Date.now() / 1000) return plain('This download link has run out. Make a new one on the dashboard.', 403);
  if (!(await secretMatches(m[2], await zipSig(env, m[1])))) return plain('This download link does not work.', 403);
  var split = parts(await kept(env.DB));
  var n = Math.floor(Number(url.searchParams.get('part')) || 1);
  var part = split[n - 1];
  if (!part) return plain('There are fewer parts now. Make a new link on the dashboard.', 404);
  // the real sizes, a few at a time, since the length goes out first; a
  // video gone since it was listed is left out
  var found: { r: Original; size: number }[] = [];
  for (var i = 0; i < part.items.length; i += 8) {
    var batch = part.items.slice(i, i + 8);
    var heads = await Promise.all(batch.map(function (r) { return env.SUBMIT.head(r.r2_key); }));
    batch.forEach(function (r, j) { if (heads[j]) found.push({ r: r, size: (heads[j] as R2Object).size }); });
  }
  if (!found.length) return plain('These videos are not there any more. Make a new link on the dashboard.', 404);
  // named for who sent it and what for, since the name on the phone says neither
  var names = zipNames(found.map(function (f) {
    var sent = String(f.r.name || '').trim() || 'video';
    return fileNameFor((f.r.team || 'Team') + ' - ' + (f.r.quest || 'quest') + ' - ' + sent, f.r.content_type);
  }));
  var plan = zipPlan(found.map(function (f, k) {
    var when = Date.parse(String(f.r.taken_at || f.r.submitted_at || '').replace(' ', 'T') + 'Z');
    return { key: f.r.r2_key, size: f.size, name: names[k], mtime: isNaN(when) ? 0 : when / 1000 };
  }), { zone: ZIP_ZONE });
  var saved = JSON.stringify(found.map(function (f) { return { k: f.r.r2_key, b: f.size }; }));
  var stream = whenRead(zipStream(env.SUBMIT, plan), async function () {
    await env.DB.prepare(
      "INSERT INTO video_originals (r2_key, bytes, saved_at) SELECT json_extract(value, '$.k'), json_extract(value, '$.b'), ?2 " +
      'FROM json_each(?1) WHERE true ON CONFLICT(r2_key) DO UPDATE SET saved_at = excluded.saved_at, bytes = excluded.bytes'
    ).bind(saved, utcStamp()).run();
  });
  var headers: Record<string, string> = {
    'content-type': 'application/zip',
    'content-disposition': 'attachment; filename="' + zipFileName(n, split.length) + '"',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff'
  };
  // the runtime sends a length only for a stream whose length is known
  if (typeof FixedLengthStream === 'function') {
    var fixed = new FixedLengthStream(plan.total);
    stream.pipeTo(fixed.writable).catch(function () { /* the download was stopped, or a file could not be read */ });
    headers['content-length'] = String(plan.total);
    return new Response(fixed.readable, { status: 200, headers: headers });
  }
  return new Response(stream, { status: 200, headers: headers });
}

export async function handleOriginalsApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method !== 'GET' || !/^\/api\/originals\/zip(\/[^/]*)?$/.test(url.pathname)) return null;
  return serveOriginalsZip(env, url);
}

// ---------- the delete ----------
// POST originals/delete {after}: the next batch after that file id. Only
// an original a download sent whole is deleted, and only while a copy to
// play stands in for it — the clean copy or the largest of the smaller
// ones, looked for in the bucket rather than taken from the rows. Its
// metadata block (.x) goes with it, since that is where the location is
// written; the still, the copies and the row stay.
async function originalsDelete(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  if (!env.SUBMIT) return json({ error: 'Uploads are not switched on.' }, 503);
  var got = await originals(env.DB);
  var after = Math.max(0, Math.floor(Number(body.after) || 0));
  var todo = got.filter(function (r) { return r.id > after && deletable(r); });
  var batch = todo.slice(0, DELETE_BATCH);
  var deleted = 0;
  var freed = 0;
  var skipped = 0;
  var gone: string[] = [];
  if (batch.length) {
    var topByKey: Record<string, string> = {};
    var rends = await env.DB.prepare(
      'SELECT file_key, key FROM submission_renditions WHERE file_key IN (SELECT value FROM json_each(?1)) ORDER BY height DESC'
    ).bind(JSON.stringify(batch.map(function (r) { return r.r2_key; }))).all<{ file_key: string; key: string }>();
    rends.results.forEach(function (row) {
      if (!topByKey[row.file_key]) topByKey[row.file_key] = row.key;
    });
    for (var i = 0; i < batch.length; i += 8) {
      var chunk = batch.slice(i, i + 8);
      var checked = await Promise.all(chunk.map(async function (r) {
        var topKey = topByKey[r.r2_key];
        var stand = (await env.SUBMIT.head(r.r2_key + '.c')) || (topKey ? await env.SUBMIT.head(topKey) : null);
        if (!stand) return null;
        await Promise.all([env.SUBMIT.delete(r.r2_key), env.SUBMIT.delete(r.r2_key + '.x')]);
        return r;
      }));
      checked.forEach(function (r) {
        if (!r) { skipped++; return; }
        gone.push(r.r2_key);
        deleted++;
        freed += Number(r.bytes) || 0;
      });
    }
  }
  if (gone.length) {
    await env.DB.prepare(
      'UPDATE video_originals SET gone_at = ?2, gone_by = ?3 WHERE r2_key IN (SELECT value FROM json_each(?1))'
    ).bind(JSON.stringify(gone), utcStamp(), session.name).run();
    await logAction(env.DB, session.name, 'originals-delete', '-', deleted + (deleted === 1 ? ' video, ' : ' videos, ') +
      Math.round(freed / 1048576) + ' MB', 0, 0, 0);
  }
  var last = batch.length ? batch[batch.length - 1].id : after;
  return json({ ok: true, deleted: deleted, freed: freed, kept: skipped, after: last, done: todo.length <= DELETE_BATCH });
}

export async function originalsConsole(env: Env, session: ConsoleSession, request: Request, action: string, url: URL, logAction: LogAction): Promise<Response | null> {
  if (request.method === 'GET') {
    if (action === 'originals') return originalsStatus(env);
    if (action === 'originals/zip') return originalsZipLinks(env, session, url, logAction);
    return null;
  }
  if (request.method !== 'POST') return null;
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  if (action === 'originals/delete') return originalsDelete(env, session, body, logAction);
  return null;
}
