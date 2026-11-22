// Files OrgComm shares, and the short links that point at them.
//
// Two things that turn out to be one. The drop is a file uploaded from
// the dashboard with nothing attached to it — a poster, a map, a
// schedule — which gets a link anyone can open. It comes whole in the
// save, up to 90MB, or with the R2 token set the dashboard sends it
// straight to R2 first (src/staged.ts) and the save names it by id, up
// to 4GB. The shortener turns a long address into
// `go.<domain>/<something-you-chose>`, and a file is one of the things
// it can point at.
//
// **The embedding rule is what shapes this.** Discord works out whether
// a link is a picture from the URL itself, so a short link to a file
// serves the bytes at the short address rather than bouncing to another
// one: no redirect to follow, and if the slug ends in the file's own
// extension the URL reads as a picture too. A short link to an ordinary
// address redirects, because there is nothing else it could do.
import { serveStoredFile, corsJson, json, cleanText, randomKey, fileNameFor, DERIVED, deleteStored, isBlobLike, safeDecode } from './shared.ts';
import { servePublicCopy } from './submit.ts';
import { readStaged, claimStaged, unclaimStaged, releaseStaged } from './staged.ts';
import { directCopy } from './r2direct.ts';
import { wantsPage, mediaPage, VARY, isMedia } from './sharepage.ts';
import { linkPageRoute } from './linkpage.ts';
import type { StagedFile } from './staged.ts';
import type { ConsoleSession, Ctx, DropFileRow, Env, JsonBody, LogAction, ShortLinkRow } from './types.ts';

// The file a form carries (formFile): sent whole, or staged in R2 and
// described by its row.
interface FormFile {
  file: File | { name: string; size: number };
  type: string;
  staged: StagedFile | null;
}

var MAX_DROP_BYTES = 90 * 1024 * 1024;   // one request, the same cap the submit page has
var MAX_SLUG = 64;
var MAX_TARGET = 2000;
var MAX_NOTE = 120;
// A file can be replaced under the same key, so what an address answers
// can change: five minutes, not immutable, or a phone that opened the
// old one would keep it for a year.
var DROP_CACHE = 'public, max-age=300';
var CORS: Record<string, string> = Object.assign({ 'access-control-allow-origin': '*' }, VARY);
// Slugs that would shadow something, or read as a mistake.
var RESERVED = ['api', 'dash', 'console', 'admin', 'go', 'favicon.ico', 'robots.txt'];

// What may go after `go./`: lower case, and only characters that
// survive being pasted into a chat window and read back out. A dot is
// allowed because a slug ending in the file's extension is what makes
// Discord treat the link as a picture.
export function cleanSlug(raw: unknown): string {
  var slug = String(raw == null ? '' : raw).trim().toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '');
  slug = slug.replace(/^[._-]+/, '').replace(/[._-]+$/, '');
  if (!slug || slug.length > MAX_SLUG) return '';
  if (RESERVED.indexOf(slug) !== -1) return '';
  return slug;
}

// A slug the dashboard offers for a file: its own name, tidied, with
// the extension left on.
export function slugFor(name: string | null | undefined, type: string | null | undefined): string {
  var whole = fileNameFor(name, type);
  var dot = whole.lastIndexOf('.');
  var base = dot > 0 ? whole.slice(0, dot) : whole;
  var ext = dot > 0 ? whole.slice(dot) : '';
  return cleanSlug(base.slice(0, MAX_SLUG - ext.length) + ext);
}

function shortHost(env: Env): string {
  return String(env.SHORT_HOST || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function shortUrl(env: Env, slug: string): string {
  var host = shortHost(env);
  return host ? 'https://' + host + '/' + slug : '';
}

// ---------- the files ----------

// The file a form carries, checked the same way for a new upload and
// for one replacing a file already there: `file`, sent whole in this
// request and so held to what one request carries, or `staged`, the id
// of one the dashboard sent straight to R2 (src/staged.ts), which can be
// as large as staged.ts allows for the drop. Answers {file, type,
// staged} or a refusal ready to send.
async function formFile(env: Env, session: ConsoleSession, form: FormData): Promise<FormFile | { refused: Response }> {
  if (form.get('staged')) {
    var staged = await readStaged(env, session, form.get('staged'), 'drop');
    if ('error' in staged) return { refused: json({ error: staged.error }, staged.status) };
    return { file: { name: staged.name, size: staged.bytes }, type: staged.type, staged: staged };
  }
  var file = form.get('file');
  if (!isBlobLike(file)) return { refused: json({ error: 'Attach a file.' }, 400) };
  if (!file.size) return { refused: json({ error: 'That file is empty.' }, 400) };
  if (file.size > MAX_DROP_BYTES) {
    return { refused: json({ error: (file.name || 'That file') + ' is over 90MB, which is more than one request carries.' }, 413) };
  }
  return { file: file, type: String(file.type || 'application/octet-stream'), staged: null };
}

// One file: sent whole in this request, or staged in R2 by the
// dashboard first, in which case it is already under its drop/ key and
// the row points at it there.
export async function dropUpload(env: Env, session: ConsoleSession, request: Request, logAction: LogAction): Promise<Response> {
  if (!env.SUBMIT) return json({ error: 'Uploads are not switched on (the worker has no SUBMIT bucket).' }, 503);
  var form;
  try { form = await request.formData(); } catch (err) {
    return json({ error: 'expected a multipart form' }, 400);
  }
  var picked = await formFile(env, session, form);
  if ('refused' in picked) return picked.refused;
  var file = picked.file;
  var type = picked.type;
  var staged = picked.staged;
  var name = cleanText(form.get('name'), 120) || String(file.name || 'file');
  var note = cleanText(form.get('note'), MAX_NOTE);
  var key: string;
  if (staged) {
    var taken = await claimStaged(env, [staged]);
    if (taken) return json({ error: taken.error }, taken.status);
    key = staged.key;
  } else {
    key = 'drop/' + randomKey(12);
    // with nothing staged, the file is the form's
    await env.SUBMIT.put(key, file as File, { httpMetadata: { contentType: type } });
  }
  var writes = [env.DB.prepare(
    'INSERT INTO drop_files (key, name, type, bytes, note, created_by) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
  ).bind(key, fileNameFor(name, type), type, file.size, note, session.name)];
  if (staged) writes.push(releaseStaged(env, staged));
  try { await env.DB.batch(writes); } catch (err) {
    if (staged) await unclaimStaged(env, [staged]);
    else await deleteStored(env.SUBMIT, key);
    throw err;
  }
  await logAction(env.DB, session.name, 'drop-upload', fileNameFor(name, type).slice(0, 60), '-', 0, 0, 0);
  return json({ ok: true, key: key, name: fileNameFor(name, type), type: type, bytes: file.size,
    url: filePath(key, fileNameFor(name, type)), suggest: slugFor(name, type) });
}

// A name without the extension its type gives it, so a replacement of
// another type swaps the extension rather than adding a second one.
function withoutExt(name: string, type: string): string {
  var ext = fileNameFor('f', type).slice(1);
  if (ext && name.toLowerCase().slice(-ext.length) === ext) return name.slice(0, -ext.length);
  return name;
}

// A file changed after it went up: its name, its note, or the file
// itself. A replacement goes in under the same key, so the address it
// was handed out at and every short link pointing at it serve the new
// one. What was made from the old file goes as soon as it is in: its
// metadata block would otherwise go on describing the old one, and the
// next read makes one from the new file.
export async function dropEdit(env: Env, session: ConsoleSession, request: Request, logAction: LogAction): Promise<Response> {
  var form;
  try { form = await request.formData(); } catch (err) {
    return json({ error: 'expected a multipart form' }, 400);
  }
  var key = String(form.get('key') || '');
  if (key.indexOf('drop/') !== 0) return json({ error: 'no such file' }, 404);
  var row = await env.DB.prepare('SELECT name, type, bytes, note FROM drop_files WHERE key = ?1').bind(key).first<Pick<DropFileRow, 'name' | 'type' | 'bytes' | 'note'>>();
  if (!row) return json({ error: 'no such file' }, 404);

  var sent = form.get('file');
  var replacing = !!form.get('staged') || isBlobLike(sent);
  var type = row.type;
  var bytes = row.bytes;
  var staged: StagedFile | null = null;
  var picked: FormFile | { refused: Response } | undefined;
  if (replacing) {
    if (!env.SUBMIT) return json({ error: 'Uploads are not switched on (the worker has no SUBMIT bucket).' }, 503);
    picked = await formFile(env, session, form);
    if ('refused' in picked) return picked.refused;
    type = picked.type;
    bytes = picked.file.size;
    staged = picked.staged;
  }
  var name = cleanText(form.get('name'), 120) || row.name;
  if (type !== row.type) name = withoutExt(name, row.type);
  name = fileNameFor(name, type);
  var note = form.get('note') == null ? row.note : cleanText(form.get('note'), MAX_NOTE);

  if (staged) {
    // a staged file is under a key of its own, and this one has to keep
    // its key: R2 copies it across without it passing through here
    var taken = await claimStaged(env, [staged]);
    if (taken) return json({ error: taken.error }, taken.status);
    try { await directCopy(env, staged.key, key); } catch (err) {
      await unclaimStaged(env, [staged]);
      return json({ error: 'The new file could not be put in place. Try again.' }, 502);
    }
  } else if (replacing) {
    // replacing with nothing staged: the form's file
    await env.SUBMIT.put(key, (picked as FormFile).file as File, { httpMetadata: { contentType: type } });
  }
  if (replacing) {
    await Promise.all(DERIVED.map(function (s) {
      return Promise.resolve().then(function () { return env.SUBMIT.delete(key + s); }).catch(function () { /* never made */ });
    }));
  }
  var writes = [env.DB.prepare('UPDATE drop_files SET name = ?2, type = ?3, bytes = ?4, note = ?5 WHERE key = ?1')
    .bind(key, name, type, bytes, note)];
  if (staged) writes.push(releaseStaged(env, staged));
  try { await env.DB.batch(writes); } catch (err) {
    if (staged) await unclaimStaged(env, [staged]);
    throw err;
  }
  // The staged copy goes once the row is written, so a save that failed
  // before then can be sent again with the same file.
  if (staged) await deleteStored(env.SUBMIT, staged.key);
  await logAction(env.DB, session.name, replacing ? 'drop-replace' : 'drop-edit', name.slice(0, 60), '-', 0, 0, 0);
  return dropList(env);
}

// The path a drop file is served at. The name on the end is decorative
// — the random half of the key is the whole credential — but Discord
// reads the URL's shape to decide whether a link is a picture, so it
// has to be there.
export function filePath(key: string, name: string): string {
  return '/api/drop/' + key.split('/').map(encodeURIComponent).join('/') + '/' + encodeURIComponent(name);
}

export async function dropList(env: Env): Promise<Response> {
  var files = await env.DB.prepare(
    'SELECT id, key, name, type, bytes, note, created_at, created_by FROM drop_files ORDER BY id DESC LIMIT 200'
  ).all<DropFileRow>();
  var links = await env.DB.prepare(
    'SELECT slug, kind, target, file_key, hits, created_at, created_by FROM short_links ORDER BY slug LIMIT 300'
  ).all<ShortLinkRow>();
  var host = shortHost(env);
  return json({
    ok: true,
    host: host,
    // the dashboard answers on its own hostname; a link copied out of it
    // is pasted somewhere public, so it is built from the public name
    api: String(env.PUBLIC_API || '').replace(/\/+$/, ''),
    files: files.results.map(function (f) {
      return {
        key: f.key, name: f.name, type: f.type, bytes: f.bytes, note: f.note,
        created_at: f.created_at, created_by: f.created_by,
        url: filePath(f.key, f.name), suggest: slugFor(f.name, f.type)
      };
    }),
    links: links.results.map(function (l) {
      return {
        slug: l.slug, kind: l.kind, target: l.target, file_key: l.file_key,
        hits: l.hits, created_at: l.created_at, created_by: l.created_by,
        url: shortUrl(env, l.slug)
      };
    })
  });
}

// The file goes, and so does every short link pointing at it: a link
// left behind would answer 404 under a name somebody had already
// shared, which is worse than the name being free again.
export async function dropDelete(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var key = String(body.key || '');
  if (key.indexOf('drop/') !== 0) return json({ error: 'no such file' }, 404);
  var row = await env.DB.prepare('SELECT name FROM drop_files WHERE key = ?1').bind(key).first<Pick<DropFileRow, 'name'>>();
  if (!row) return json({ error: 'no such file' }, 404);
  await deleteStored(env.SUBMIT, key);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM drop_files WHERE key = ?1').bind(key),
    env.DB.prepare('DELETE FROM short_links WHERE file_key = ?1').bind(key)
  ]);
  await logAction(env.DB, session.name, 'drop-delete', String(row.name).slice(0, 60), '-', 0, 0, 0);
  return dropList(env);
}

// ---------- serving a drop file ----------

export async function serveDropFile(env: Env, request: Request, key: string, name: string): Promise<Response> {
  if (!env.SUBMIT) return corsJson({ error: 'not found' }, 404);
  if (key.indexOf('drop/') !== 0) return corsJson({ error: 'not found' }, 404);
  var row = await env.DB.prepare('SELECT type, name, bytes FROM drop_files WHERE key = ?1').bind(key).first<Pick<DropFileRow, 'type' | 'name' | 'bytes'>>();
  if (!row) return corsJson({ error: 'not found' }, 404);
  // a person opening the address, or a short link to it, gets the file's page
  var url = new URL(request.url);
  if (wantsPage(request, url, { named: true, media: isMedia(row.type) })) {
    return mediaPage(env, url, { key: key, type: row.type, name: row.name, bytes: row.bytes,
      base: '/api/drop/' + key.split('/').map(encodeURIComponent).join('/') + '/' });
  }
  // A photo taken by OrgCom carries a location like anyone else's, so
  // it goes through the same cutter, and a picture it cannot read is
  // never served as it was uploaded. A file that is not a picture (a
  // PDF, a schedule, a video) is: that is what the drop is for.
  return (await servePublicCopy(env, request, key, row.type, DROP_CACHE, CORS)) ||
    corsJson({ error: 'not found' }, 404);
}

// ---------- the short links ----------

export async function linkSave(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var slug = cleanSlug(body.slug);
  if (!slug) return json({ error: 'That link name will not work. Letters, numbers, dots and dashes.' }, 400);
  var was = cleanSlug(body.was);
  var kind = body.kind === 'file' ? 'file' : 'url';
  var target = '';
  var fileKey = '';

  if (kind === 'file') {
    fileKey = String(body.file_key || '');
    var file = await env.DB.prepare('SELECT key FROM drop_files WHERE key = ?1').bind(fileKey).first<Pick<DropFileRow, 'key'>>();
    if (!file) return json({ error: 'That file is not in the drop.' }, 404);
  } else {
    target = String(body.target || '').trim().slice(0, MAX_TARGET);
    if (!/^https?:\/\/\S+$/.test(target)) {
      return json({ error: 'The address has to start with http:// or https://' }, 400);
    }
  }

  var clash = await env.DB.prepare('SELECT slug FROM short_links WHERE slug = ?1').bind(slug).first<Pick<ShortLinkRow, 'slug'>>();
  if (clash && slug !== was) return json({ error: '/' + slug + ' is taken.' }, 409);

  // One batch, and a link to a file is written only while the file is
  // there: a delete of the file running at the same time takes its
  // links in its own batch, so the two cannot leave a link to nothing.
  // A rename takes the old name off in the same batch, on the same
  // condition, so a refused save leaves the old link as it was.
  var fileThere = "(?2 != 'file' OR EXISTS (SELECT 1 FROM drop_files WHERE key = ?3))";
  var writes: D1PreparedStatement[] = [];
  if (was && was !== slug) {
    writes.push(env.DB.prepare('DELETE FROM short_links WHERE slug = ?1 AND ' + fileThere).bind(was, kind, fileKey));
  }
  writes.push(env.DB.prepare(
    'INSERT INTO short_links (slug, kind, target, file_key, created_by) SELECT ?1, ?2, ?4, ?3, ?5 WHERE ' + fileThere + ' ' +
    'ON CONFLICT(slug) DO UPDATE SET kind = ?2, target = ?4, file_key = ?3'
  ).bind(slug, kind, fileKey, target, session.name));
  var saved = await env.DB.batch(writes);
  var put = saved[saved.length - 1];
  if (!(put.meta && put.meta.changes)) return json({ error: 'That file is not in the drop.' }, 404);
  await logAction(env.DB, session.name, 'link-save', '/' + slug, kind, 0, 0, 0);
  return dropList(env);
}

export async function linkDelete(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var slug = cleanSlug(body.slug);
  if (!slug) return json({ error: 'no such link' }, 404);
  await env.DB.prepare('DELETE FROM short_links WHERE slug = ?1').bind(slug).run();
  await logAction(env.DB, session.name, 'link-delete', '/' + slug, '-', 0, 0, 0);
  return dropList(env);
}

// ---------- go.<domain>/<slug> ----------

// Both spellings of a slug resolve. Save it as `poster.png` and
// `go./poster` still works; save it as `poster` and `go./poster.png`
// works too — which matters because the second is the one that embeds.
// Whichever way somebody was told the link, it answers.
var LINK_COLUMNS = 'SELECT slug, kind, target, file_key FROM short_links WHERE ';

// A path is whatever was typed, so the two LIKE wildcards and the
// escape character itself are taken out of it before it becomes a
// pattern: `po_ter` must not find `poster.png`.
function likeLiteral(text: string): string {
  return text.replace(/[\\%_]/g, function (ch) { return '\\' + ch; });
}

async function findLink(db: D1Database, path: string): Promise<Pick<ShortLinkRow, 'slug' | 'kind' | 'target' | 'file_key'> | null> {
  type Link = Pick<ShortLinkRow, 'slug' | 'kind' | 'target' | 'file_key'>;
  var row = await db.prepare(LINK_COLUMNS + 'slug = ?1').bind(path).first<Link>();
  if (row) return row;
  var dot = path.lastIndexOf('.');
  if (dot > 0) {
    return db.prepare(LINK_COLUMNS + 'slug = ?1').bind(path.slice(0, dot)).first<Link>();
  }
  // no extension typed: the shortest slug that is this name plus one
  return db.prepare(
    LINK_COLUMNS + "slug LIKE ?1 ESCAPE '\\' ORDER BY length(slug), slug LIMIT 1"
  ).bind(likeLiteral(path) + '.%').first<Link>();
}

export async function handleShortLink(request: Request, env: Env, ctx: Ctx, url: URL): Promise<Response | null> {
  var host = shortHost(env);
  if (!host || url.hostname !== host) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
  }
  var decoded = safeDecode(url.pathname.replace(/^\/+/, '').replace(/\/+$/, ''));
  if (decoded === null) {
    return new Response('No link here.', {
      status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
  }
  var path = decoded.toLowerCase();
  // the link page at the bare domain, and its counted links at /l/<id>
  var page = await linkPageRoute(request, env, ctx, path);
  if (page) return page;
  if (!path) {
    return Response.redirect(String(env.SITE_URL || 'https://scs.andyrew.space'), 302);
  }

  var row: Awaited<ReturnType<typeof findLink>>;
  try { row = await findLink(env.DB, path); } catch (err) { row = null; }
  if (!row) {
    return new Response('No link here.', {
      status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  // counting is not worth making anyone wait for, and a count that
  // fails is not worth failing the link over
  var count = env.DB.prepare('UPDATE short_links SET hits = hits + 1 WHERE slug = ?1')
    .bind(row.slug).run().catch(function () {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(count);

  if (row.kind === 'file') {
    var file = await env.DB.prepare('SELECT key, name FROM drop_files WHERE key = ?1')
      .bind(row.file_key).first<Pick<DropFileRow, 'key' | 'name'>>();
    if (!file) {
      return new Response('That file is gone.', {
        status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
      });
    }
    // the bytes, here, at this address: a redirect is one more thing
    // for an unfurler to follow and one more way for an embed to fail
    return serveDropFile(env, request, file.key, file.name);
  }
  return Response.redirect(row.target, 302);
}
