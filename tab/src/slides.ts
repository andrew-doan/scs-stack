// The pictures on the home page.
//
// A run of photographs from the event, uploaded in the dashboard's
// Files tab and read by the home page as a slideshow. The page draws
// the list it kept from the last visit before it asks for a new one,
// so an empty answer is an ordinary answer: with no rows the section
// is not on the page at all, which is the state the site ships in.
//
// Files go into the same R2 bucket as proof and message attachments,
// under their own slide/ prefix, and are served by their keys — the
// random half of a key is the capability, exactly as it is everywhere
// else here.
//
// `alt` is not optional. A picture with no alt is a picture nobody
// using a screen reader can know anything about, and the home page is
// the first thing anyone reads. It is required on upload and cannot be
// blanked by an edit.

import { serveStoredFile, corsJson, json, cleanText, randomKey, animatedType, isLinkPreview, settingValue, setSetting, deleteStored, isBlobLike } from './shared.ts';
import { storePreview, bytesMatch, servePublicCopy } from './submit.ts';
import { writeBlock } from './photoserve.ts';
import { readStaged, claimStaged, unclaimStaged, releaseStaged } from './staged.ts';
import type { StagedFile } from './staged.ts';
import type { ConsoleSession, Env, HomeSlideRow, JsonBody, LogAction, Refusal, SlidesPayload } from './types.ts';

// A picture as the dashboard's card lists it.
type SlideListing = Pick<HomeSlideRow, 'key' | 'name' | 'type' | 'bytes' | 'alt' | 'caption' | 'sort' | 'created_at' | 'created_by' | 'focus_x' | 'focus_y' | 'hidden'>;

var MAX_FILE_BYTES = 25 * 1024 * 1024;    // the same cap a message attachment has
var MAX_THUMB_BYTES = 300 * 1024;         // a browser-made preview, not a photo
var MAX_ALT = 200;
var MAX_CAPTION = 160;

var FOREVER = 'public, max-age=31536000, immutable';
var CORS: Record<string, string> = { 'access-control-allow-origin': '*' };

// How long a picture stays on screen, in milliseconds. site_flags holds
// integers, so the dashboard's seconds-with-a-decimal-point is stored
// as the millisecond count and turned back in the field. Under a second
// nobody can read a caption; over a minute it has stopped being a
// slideshow.
var STEP_FLAG = 'slide_step_ms';
var STEP_DEFAULT = 3000;
var STEP_MIN = 1000;
var STEP_MAX = 60000;

function cleanStep(ms: unknown): number | null {
  var n = Math.round(Number(ms));
  if (!isFinite(n)) return null;
  if (n < STEP_MIN || n > STEP_MAX) return null;
  return n;
}

export async function slideStep(db: D1Database): Promise<number> {
  return cleanStep(await settingValue(db, STEP_FLAG, STEP_DEFAULT)) || STEP_DEFAULT;
}

// What may be uploaded: the three formats the stripper can clean
// (strip.ts), so exactly the pictures that can be served without
// handing out where they were taken. WebP, AVIF and HEIC can all carry
// EXIF and the stripper cannot read any of them, so they are refused at
// the door rather than uploaded and then unservable.
var ALLOWED = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];

function baseType(type: unknown): string {
  return String(type || '').toLowerCase().split(';')[0].trim();
}

function typeAllowed(type: unknown): boolean {
  return ALLOWED.indexOf(baseType(type)) !== -1;
}

// ---------- the public read ----------

// The point a picture is cropped around, in percent across and down
// (`x`, `y`): the home page draws each one to cover a box that is wide on
// a computer and tall on a phone, and the point stays in the frame on
// both. `hidden` is a picture kept on the dashboard and left out of the
// slideshow.
var SLIDE_COLUMNS = 'key, name, type, bytes, alt, caption, sort, created_at, created_by, focus_x, focus_y, hidden';

// GET /api/slides: the array is the display order, so the page renders
// it as given.
export async function slidesPayload(db: D1Database): Promise<SlidesPayload> {
  var step = await slideStep(db);
  var rows = (await db.prepare(
    'SELECT key, name, alt, caption, focus_x, focus_y FROM home_slides WHERE hidden = 0 ORDER BY sort, id'
  ).all<Pick<HomeSlideRow, 'key' | 'name' | 'alt' | 'caption' | 'focus_x' | 'focus_y'>>()).results;
  return {
    ok: true,
    step_ms: step,
    slides: rows.map(function (r) {
      return { key: r.key, name: r.name, alt: r.alt, caption: r.caption, x: r.focus_x, y: r.focus_y };
    })
  };
}

// ---------- the file ----------

// GET /api/slides/file?key= (+&thumb=1). The key must exist in
// home_slides, contents never change under a key, and Range passes
// through like every other file endpoint here.
//
// The chain is the message attachment's: the small copy when one was
// asked for and one exists, then the copy with the metadata taken out,
// then the file itself. Reaching the file means one of three things —
// there was nothing in it to take out, it is a GIF, or the stripper
// could not parse it. Only the last is a risk, and it can only happen
// to a JPEG or a PNG an organiser uploaded themselves; refusing would
// mean a picture that draws everywhere else shows as a broken box on
// the home page.
//
// A GIF is served whole whatever is asked for. Its thumbnail would be
// one frame drawn onto a canvas, and a still in place of an animation
// is the animation not playing — which is also why no thumb is stored
// for one.
export async function serveSlideFile(env: Env, request: Request, url: URL, pathKey?: string): Promise<Response> {
  if (!env.SUBMIT) return corsJson({ error: 'not found' }, 404);
  var key = pathKey || url.searchParams.get('key') || '';
  if (key.indexOf('slide/') !== 0) return corsJson({ error: 'not found' }, 404);
  var row = await env.DB.prepare('SELECT id, type FROM home_slides WHERE key = ?1').bind(key).first<Pick<HomeSlideRow, 'id' | 'type'>>();
  if (!row) return corsJson({ error: 'not found' }, 404);

  // A link unfurler is answered with the whole picture rather than the
  // page's thumbnail: the URL people copy out of a page is the one in
  // its img tag, which is the small copy.
  var whole = isLinkPreview(request) && baseType(row.type).indexOf('image/') === 0;
  var asked = !!url.searchParams.get('thumb');
  var cache = whole && asked ? 'private, no-store' : FOREVER;

  if (asked && !animatedType(row.type) && !whole) {
    var small = await serveStoredFile(env.SUBMIT, request, key + '.t', cache, CORS);
    if (small) return small;
  }
  return (await servePublicCopy(env, request, key, row.type, cache, CORS)) ||
    corsJson({ error: 'not found' }, 404);
}

// ---------- the dashboard ----------

// Everything the Files tab's card draws, in the order the page plays
// them. Every write answers with the same rows, so the card redraws
// from the answer rather than asking again.
async function slideRows(env: Env): Promise<SlideListing[]> {
  return (await env.DB.prepare('SELECT ' + SLIDE_COLUMNS + ' FROM home_slides ORDER BY sort, id').all<SlideListing>()).results;
}

export async function slidesList(env: Env): Promise<Response> {
  return json({ ok: true, slides: await slideRows(env), step_ms: await slideStep(env.DB) });
}

// How long a picture stays up. The field is in seconds and takes a
// decimal point; what crosses the wire and what is stored is the
// millisecond count, because site_flags holds integers.
export async function slideStepSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var ms = cleanStep(body.step_ms);
  if (ms === null) {
    return json({ error: 'Between ' + (STEP_MIN / 1000) + ' and ' + (STEP_MAX / 1000) + ' seconds.' }, 400);
  }
  await setSetting(env.DB, STEP_FLAG, ms);
  await logAction(env.DB, session.name, 'slide-step', (ms / 1000) + 's', '-', 0, 0, 0);
  return json({ ok: true, slides: await slideRows(env), step_ms: ms });
}

// A file and its copies leave the bucket together. A bucket that has
// already lost them is not worth failing a delete over.
async function dropStored(env: Env, key: string): Promise<void> {
  await deleteStored(env.SUBMIT, key);
}

// One picture: multipart, with the alt text and the caption beside it
// and the browser-made preview as `thumb`. The picture is `file`, or
// `staged`, the id of one the dashboard sent straight to R2
// (src/staged.ts), which is already under its key with its first bytes
// checked.
export async function slideSave(env: Env, session: ConsoleSession, request: Request, logAction: LogAction): Promise<Response> {
  if (!env.SUBMIT) return json({ error: 'Uploads are not switched on (the worker has no SUBMIT bucket).' }, 503);
  var form;
  try { form = await request.formData(); } catch (err) {
    return json({ error: 'expected a multipart form' }, 400);
  }

  var staged: StagedFile | Refusal | null = null;
  var file: File | string | null | { name: string; type: string; size: number } = form.get('file');
  if (form.get('staged')) {
    staged = await readStaged(env, session, form.get('staged'), 'slide');
    if ('error' in staged) return json({ error: staged.error }, staged.status);
    file = { name: staged.name, type: staged.type, size: staged.bytes };
  } else if (!isBlobLike(file)) {
    return json({ error: 'Choose a picture.' }, 400);
  }
  if (!file.size) return json({ error: 'That file is empty.' }, 400);
  var type = baseType(file.type);
  // with nothing staged, the file is the form's
  if (!typeAllowed(type) || (!staged && !(await bytesMatch(file as File, type)))) {
    return json({ error: (file.name || 'That file') + ' is not a JPEG, PNG or GIF. Save it as one of those and try again.' }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return json({ error: (file.name || 'That file') + ' is over 25MB.' }, 413);
  }
  var alt = cleanText(form.get('alt'), MAX_ALT);
  if (!alt) return json({ error: 'Say what the picture shows. It is what a screen reader reads out.' }, 400);
  var caption = cleanText(form.get('caption'), MAX_CAPTION);

  var name = cleanText(file.name, 120).replace(/[^\w. ()-]/g, '_') || 'picture';
  var key: string;
  if (staged) {
    var taken = await claimStaged(env, [staged]);
    if (taken) return json({ error: taken.error }, taken.status);
    key = staged.key;
  } else {
    key = 'slide/' + randomKey(12);
    await env.SUBMIT.put(key, await (file as File).arrayBuffer(), { httpMetadata: { contentType: type } });
    // the copy with the location taken out: what the home page reads
    await writeBlock(env, key, type, file as File);
  }

  // The worker cannot resize a picture, so the dashboard makes the
  // small copy in the browser and it sits beside the file under the
  // same key with .t added. A GIF gets none, for the reason given at
  // the serving end.
  if (!animatedType(type)) await storePreview(env, key + '.t', form.get('thumb'), MAX_THUMB_BYTES);

  // A new picture goes on the end: the ones already in an order the
  // organisers chose stay where they were put.
  var last = await env.DB.prepare('SELECT MAX(sort) AS n FROM home_slides').first<{ n: number | null }>();
  var writes = [env.DB.prepare(
    'INSERT INTO home_slides (key, name, type, bytes, alt, caption, sort, created_by) ' +
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
  ).bind(key, name, type, file.size, alt, caption, ((last && last.n) || 0) + 1, session.name)];
  if (staged) writes.push(releaseStaged(env, staged));
  try { await env.DB.batch(writes); } catch (err) {
    if (staged) await unclaimStaged(env, [staged]);
    throw err;
  }

  await logAction(env.DB, session.name, 'slide-add', name.slice(0, 60), '-', 0, 0, 0);
  return json({ ok: true, key: key, name: name, slides: await slideRows(env) });
}

// The alt text and the caption on a picture already up. The picture
// itself never changes — a different picture is a different upload,
// so there is no key to keep in step and nothing in the bucket to
// replace.
export async function slideEdit(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var key = String(body.key || '');
  var row = await env.DB.prepare('SELECT key, name FROM home_slides WHERE key = ?1').bind(key).first<Pick<HomeSlideRow, 'key' | 'name'>>();
  if (!row) return json({ error: 'no such picture' }, 404);
  var alt = cleanText(body.alt, MAX_ALT);
  if (!alt) return json({ error: 'Say what the picture shows. It is what a screen reader reads out.' }, 400);
  var caption = cleanText(body.caption, MAX_CAPTION);
  await env.DB.prepare('UPDATE home_slides SET alt = ?2, caption = ?3 WHERE key = ?1')
    .bind(key, alt, caption).run();
  await logAction(env.DB, session.name, 'slide-edit', String(row.name).slice(0, 60), '-', 0, 0, 0);
  return json({ ok: true, key: key, slides: await slideRows(env) });
}

// The point a picture is cropped around, set by a click on it in the
// dashboard. Whole percents, kept inside the picture.
function focusPart(v: unknown): number | null {
  var n = Math.round(Number(v));
  return isFinite(n) ? Math.max(0, Math.min(100, n)) : null;
}
export async function slideFocus(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var key = String(body.key || '');
  var x = focusPart(body.x);
  var y = focusPart(body.y);
  if (x === null || y === null) return json({ error: 'Pick a point on the picture.' }, 400);
  var row = await env.DB.prepare('SELECT key, name FROM home_slides WHERE key = ?1').bind(key).first<Pick<HomeSlideRow, 'key' | 'name'>>();
  if (!row) return json({ error: 'no such picture' }, 404);
  await env.DB.prepare('UPDATE home_slides SET focus_x = ?2, focus_y = ?3 WHERE key = ?1').bind(key, x, y).run();
  await logAction(env.DB, session.name, 'slide-focus', String(row.name).slice(0, 60), x + ',' + y, 0, 0, 0);
  return json({ ok: true, key: key, slides: await slideRows(env) });
}

// Pictures kept on the dashboard and taken out of the slideshow, or put
// back in it: one or several at once, from the card's edit mode.
export async function slideHide(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var keys = Array.isArray(body.keys)
    ? body.keys.map(String).filter(function (k) { return k.indexOf('slide/') === 0; })
    : [];
  if (!keys.length) return json({ error: 'Pick the pictures first.' }, 400);
  var hide = body.hidden ? 1 : 0;
  await env.DB.batch(keys.map(function (key) {
    return env.DB.prepare('UPDATE home_slides SET hidden = ?2 WHERE key = ?1').bind(key, hide);
  }));
  await logAction(env.DB, session.name, hide ? 'slide-hide' : 'slide-show',
    keys.length + (keys.length === 1 ? ' picture' : ' pictures'), '-', 0, 0, 0);
  return json({ ok: true, slides: await slideRows(env) });
}

export async function slideDelete(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var key = String(body.key || '');
  if (key.indexOf('slide/') !== 0) return json({ error: 'no such picture' }, 404);
  var row = await env.DB.prepare('SELECT key, name FROM home_slides WHERE key = ?1').bind(key).first<Pick<HomeSlideRow, 'key' | 'name'>>();
  if (!row) return json({ error: 'no such picture' }, 404);
  await dropStored(env, key);
  await env.DB.prepare('DELETE FROM home_slides WHERE key = ?1').bind(key).run();
  await logAction(env.DB, session.name, 'slide-delete', String(row.name).slice(0, 60), '-', 0, 0, 0);
  return json({ ok: true, key: key, slides: await slideRows(env) });
}

// The whole list in the order the page now shows it, written as sort
// 1, 2, 3 … A picture added afterwards takes the next number and lands
// on the end.
export async function slideOrder(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var keys = Array.isArray(body.keys)
    ? body.keys.map(String).filter(function (k) { return k.indexOf('slide/') === 0; })
    : [];
  if (!keys.length) return json({ error: 'Send the pictures in order.' }, 400);
  await env.DB.batch(keys.map(function (key, i) {
    return env.DB.prepare('UPDATE home_slides SET sort = ?2 WHERE key = ?1').bind(key, i + 1);
  }));
  await logAction(env.DB, session.name, 'slide-order',
    keys.length + (keys.length === 1 ? ' picture' : ' pictures'), '-', 0, 0, 0);
  return json({ ok: true, slides: await slideRows(env) });
}

// ---------- router: the one slides path that is not a cached read ----------
// /api/slides itself is built in apiResponse with the other public
// payloads; the file needs the bucket and the request, so it comes
// through here.

export async function handleSlidesApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  if (url.pathname === '/api/slides/file') return serveSlideFile(env, request, url);
  // /api/slides/file/slide/<key>/<name> — the same file at a path that
  // ends in its name, so Discord takes it for a picture (embed.ts).
  // The key between the two is what is checked; the name is ignored.
  var path = url.pathname.match(/^\/api\/slides\/file\/(slide\/[^/]+)\/[^/]*$/);
  if (path) return serveSlideFile(env, request, url, decodeURIComponent(path[1]));
  if (url.pathname === '/api/slides/cover') return serveCover(env, request);
  return null;
}

// The first picture the home page plays, or null: a hidden one is not
// played.
export async function firstShown<K extends keyof HomeSlideRow>(db: D1Database, columns: string): Promise<Pick<HomeSlideRow, K> | null> {
  return db.prepare('SELECT ' + columns + ' FROM home_slides WHERE hidden = 0 ORDER BY sort, id LIMIT 1').first<Pick<HomeSlideRow, K>>();
}

// GET /api/slides/cover: whichever picture the home page plays first,
// at one address that does not change, for the pages' og:image — a
// static page cannot name the picture, and every app that previews a
// link reads that tag. Five minutes rather than forever, since the
// picture under the address changes when the slides are reordered.
// With no pictures uploaded it sends the app's icon instead.
async function serveCover(env: Env, request: Request): Promise<Response> {
  var row = await firstShown<'key' | 'type'>(env.DB, 'key, type');
  if (!row || !env.SUBMIT) {
    return new Response(null, { status: 302, headers: {
      location: 'https://scs.andyrew.space/assets/icons/icon-512.png',
      'cache-control': 'public, max-age=300'
    } });
  }
  var cache = 'public, max-age=300';
  return (await servePublicCopy(env, request, row.key, row.type, cache, CORS)) ||
    corsJson({ error: 'not found' }, 404);
}
