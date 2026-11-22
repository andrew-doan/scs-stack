// Helpers shared by every module in the worker: responses, input
// cleaning, secrets, randomness, and R2 streaming.

import type { SiteFlagRow } from './types.ts';

var JSON_HEADERS: Record<string, string> = { 'content-type': 'application/json' };
export var CORS_JSON: Record<string, string> = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*'
};

export function json(payload: unknown, status?: number, extra?: Record<string, string>): Response {
  return respond(payload, status, JSON_HEADERS, extra);
}

// Same, with open CORS: for the endpoints the website calls directly.
export function corsJson(payload: unknown, status?: number, extra?: Record<string, string>): Response {
  return respond(payload, status, CORS_JSON, extra);
}

function respond(payload: unknown, status: number | undefined, base: Record<string, string>, extra: Record<string, string> | undefined): Response {
  var headers: Record<string, string> = {};
  var k;
  for (k in base) headers[k] = base[k];
  if (extra) for (k in extra) headers[k] = extra[k];
  return new Response(JSON.stringify(payload), { status: status || 200, headers: headers });
}

// The lookup key for quest codes: uppercased with spaces removed, so
// make 21 and MAKE21 land on the same quest. Hyphens stay: SQ2-3 (three
// Sushi Hubs) and SQ23 are different codes.
export function normQuest(code: unknown): string {
  return String(code).toUpperCase().replace(/\s+/g, '');
}

// Free text typed by strangers: control characters and runs of
// whitespace collapsed, trimmed, capped.
export function cleanText(value: unknown, max?: number): string {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

// Markdown keeps its line breaks — it is markdown — so this drops only
// the control characters that are not one, and normalises the line
// endings a pasted document brings with it.
export function cleanBody(value: unknown, max?: number): string {
  return String(value == null ? '' : value)
    .split('\r\n').join('\n')
    .split('\r').join('\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .slice(0, max)
    .trim();
}

// Now, written the way the database writes datetime('now'):
// 'YYYY-MM-DD HH:MM:SS' in UTC. Stamps in that shape compare as
// strings exactly as they compare as times, which is how a deadline is
// checked without asking the database.
export function utcStamp(date?: Date): string {
  return (date || new Date()).toISOString().replace('T', ' ').slice(0, 19);
}

// A time typed into the dashboard, read back in that same shape, or ''
// when there is nothing usable in it. Seconds are optional and a T
// separator is fine; anything else is refused so a mistyped deadline
// cannot read as "no deadline".
export function readStamp(value: unknown): string | null {
  var text = String(value == null ? '' : value).trim();
  if (!text) return '';
  var m = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  var parsed = new Date(m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + (m[6] || '00') + 'Z');
  if (isNaN(parsed.getTime())) return null;
  if (parsed.getUTCFullYear() !== Number(m[1]) || parsed.getUTCMonth() + 1 !== Number(m[2]) || parsed.getUTCDate() !== Number(m[3])) return null;
  return utcStamp(parsed);
}

// Decodes a URI component without throwing on malformed percent-escapes.
export function safeDecode(s: string): string | null {
  try { return decodeURIComponent(s); } catch (err) { return null; }
}

// A secret counts as set once it is no longer the wrangler.toml
// placeholder.
export function configured(secret: string | null | undefined): secret is string {
  return !!secret && String(secret).indexOf('PASTE') !== 0;
}

// Hash both sides before comparing so the byte-by-byte loop cannot
// leak how much of a guess was right.
export async function secretMatches(given: unknown, expected: string | null | undefined): Promise<boolean> {
  if (!given || !expected) return false;
  var enc = new TextEncoder();
  var a = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(given))));
  var b = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(String(expected))));
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export function bearerToken(request: Request): string {
  var header = request.headers.get('authorization') || '';
  return header.indexOf('Bearer ') === 0 ? header.slice(7).trim() : '';
}

export function b64url(bytes: ArrayBuffer | ArrayLike<number>): string {
  var arr = new Uint8Array(bytes);
  var bin = '';
  for (var i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// N random bytes as base64url: session tokens, R2 keys.
export function randomKey(bytes: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

// ---------- numbers the dashboard can change ----------
// Kept in site_flags beside the switches, which is an integer store, so
// these are whole numbers only. A setting nobody has touched has to
// read as the value the code shipped with — so a missing row and a
// database that cannot be reached both fall back to the caller's
// default rather than to zero. A limit that silently became zero would
// turn everybody away.
export async function settingValue(db: D1Database, name: string, fallback: number): Promise<number> {
  try {
    var row = await db.prepare('SELECT value FROM site_flags WHERE name = ?1').bind(name).first<Pick<SiteFlagRow, 'value'>>();
    if (!row) return fallback;
    var n = Number(row.value);
    return isFinite(n) ? n : fallback;
  } catch (err) {
    return fallback;
  }
}

export async function setSetting(db: D1Database, name: string, value: number): Promise<void> {
  await db.prepare(
    'INSERT INTO site_flags (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = ?2'
  ).bind(name, Math.round(value)).run();
}

// ---------- the Settings tab's switch that stops every email ----------
// `site_flags.email_held`: while it is on, nothing reaches the mail
// service. trySendEmail in email.ts asks on every message, so that is
// the gate; the dashboard's sends ask first as well, so they can refuse
// with this reason before anything is queued. No row, a read that
// fails or no database (a test handing trySendEmail a bare env) reads
// as not held.
export var EMAIL_OFF = 'Email sending is off. Turn it on in Settings.';

export async function emailsHeld(db: D1Database | null | undefined): Promise<boolean> {
  if (!db) return false;
  try {
    var row = await db.prepare("SELECT value FROM site_flags WHERE name = 'email_held'").first<Pick<SiteFlagRow, 'value'>>();
    return !!(row && row.value);
  } catch (err) {
    return false;
  }
}

// The answer to a send the dashboard asked for while email is off.
export function emailOffRefusal(): Response {
  return json({ error: EMAIL_OFF, email_off: true }, 409);
}

// Read and discard a response body so the connection can be reused.
export async function drain(resp: Response | null | undefined): Promise<void> {
  if (resp && resp.body) { try { await resp.arrayBuffer(); } catch (err) { /* already gone */ } }
}

export function delay(ms: number): Promise<void> {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// The id a new team is given, as an SQL expression for the INSERT
// itself: one past every id a team has had. teams.id is a plain INTEGER
// PRIMARY KEY, which would hand the newest team's id on once it is
// deleted, and rows still keyed by it (its people, its Discord role and
// channel, its team groups, its answers, its phones) would go with it.
// deleteTeam raises `team_id_high` in site_flags; every INSERT INTO
// teams names its id from this, which verify-console.mjs checks.
export var NEXT_TEAM_ID =
  "(SELECT MAX(COALESCE((SELECT value FROM site_flags WHERE name = 'team_id_high'), 0), " +
  'COALESCE((SELECT MAX(id) FROM teams), 0)) + 1)';

// The statement that keeps a deleted team's id from coming back.
export function retireTeamId(db: D1Database, id: number): D1PreparedStatement {
  return db.prepare(
    "INSERT INTO site_flags (name, value) VALUES ('team_id_high', ?1) " +
    'ON CONFLICT(name) DO UPDATE SET value = MAX(site_flags.value, excluded.value)'
  ).bind(id);
}

// A write that broke a unique index: for a team, a name already taken
// in another case by a team written at the same moment.
export function uniqueClash(err: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String(errorMessage(err)));
}

// A test person is one whose team is hidden or, in no team yet, whose
// signup is. The condition for everyone else, over participants p with
// teams t and registrations r left-joined.
export var PERSON_SHOWN =
  'CASE WHEN p.team_id IS NULL THEN COALESCE(r.hidden, 0) ELSE COALESCE(t.hidden, 0) END = 0';

// A read of a column `npm run db:migrate` has not added yet, on a
// worker deployed before it ran; the caller falls back to the query
// without it.
export function noSuchColumn(err: unknown): boolean {
  return /no such column/i.test(String(errorMessage(err)));
}

export function noSuchTable(err: unknown): boolean {
  return /no such table/i.test(String(errorMessage(err)));
}

// What `obj && obj[key]` reads, for a value of unknown shape: the falsy
// value itself, else the property, which is undefined on a primitive.
export function prop(obj: unknown, key: string): unknown {
  if (!obj) return obj;
  return (obj as Record<string, unknown>)[key];
}

// A value of unknown shape read field by field, as `value || {}` is.
export function fields(value: unknown): Record<string, unknown> {
  return (value || {}) as Record<string, unknown>;
}

// A form field holding a file, or anything else with a Blob's
// arrayBuffer(): what `v && typeof v.arrayBuffer === 'function'` asks.
export function isBlobLike(v: unknown): v is Blob {
  return !!v && typeof (v as { arrayBuffer?: unknown }).arrayBuffer === 'function';
}

// What `err && err.message` reads for whatever was thrown: the falsy
// value itself, the message of anything with one, else undefined.
export function errorMessage(err: unknown): unknown {
  if (!err) return err;
  return typeof err === 'object' && 'message' in err ? err.message : undefined;
}

// A picture that moves. Browsers and the pages that upload files make
// previews by drawing a frame onto a canvas, which for a GIF is the
// first frame and nothing else — so the small copies stored at .t and
// .v are a still of an animation, and serving one in the animation's
// place is what stopped GIFs playing. Every file endpoint asks this
// before it reaches for a smaller copy, and the upload paths ask it
// before storing one at all. GIF only: WebP and PNG may be animated
// but usually are not, and treating every one of them as animated
// would send full-size photos wherever a thumbnail was asked for.
export function animatedType(type: string | null | undefined): boolean {
  return String(type || '').toLowerCase().split(';')[0].trim() === 'image/gif';
}

// Discord, Slack and the rest fetch a URL themselves to draw the
// preview under a pasted link. What they get is what everyone in the
// channel sees, and for a lot of them it is the only look they take —
// so a preview is never handed a thumbnail. The URL people copy out
// of a page is the one in its `img` tag, which is the small copy; a
// picture pasted into Discord was embedding at a few hundred pixels
// because of that. Asked by one of these, every picture endpoint
// skips its smaller copies and answers with the full clean one.
var LINK_PREVIEW = new RegExp([
  'discordbot', 'slackbot', 'twitterbot', 'facebookexternalhit', 'whatsapp',
  'telegrambot', 'linkedinbot', 'redditbot', 'skypeuripreview', 'embedly',
  'iframely', 'bingpreview', 'mastodon', 'bsky', 'signal-desktop'
].join('|'), 'i');

export function isLinkPreview(request: Request): boolean {
  return LINK_PREVIEW.test(request.headers.get('user-agent') || '');
}

// A file name that ends in the extension its type implies. Discord
// decides whether a link is a picture from the URL's own shape, so a
// cross-posted attachment needs a path ending in .gif rather than a
// query string — see messages.ts. Falls back to the name as typed
// when the type is one this does not know.
var TYPE_EXT: Record<string, string> = {
  'image/gif': 'gif', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/avif': 'avif', 'image/heic': 'heic', 'image/heif': 'heif', 'image/svg+xml': 'svg', 'application/pdf': 'pdf',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm'
};
// A served file handed over as a download: the same response, saved
// under the name it was sent with and the extension of the copy served.
// A video asked for before the encoder has made anything of it would be
// handed its still, so that is refused instead.
export function asDownload(resp: Response, name: string | null | undefined, video?: boolean): Response;
export function asDownload(resp: Response | null, name: string | null | undefined, video?: boolean): Response | null;
export function asDownload(resp: Response | null, name: string | null | undefined, video?: boolean): Response | null {
  if (!resp || resp.status !== 200) return resp;
  var type = String(resp.headers.get('content-type') || '').toLowerCase().split(';')[0].trim();
  if (video && type.indexOf('video/') !== 0) {
    if (resp.body) { try { resp.body.cancel().catch(function () {}); } catch (err) { /* ignore */ } }
    return new Response('This video is still being processed. Try again later.', {
      status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
    });
  }
  var out = new Response(resp.body, resp);
  var given = String(name || 'file').replace(/[\\/?#"\r\n]+/g, ' ').trim() || 'file';
  var file = TYPE_EXT[type] ? fileNameFor(given.replace(/\.[A-Za-z0-9]{1,5}$/, ''), type) : given;
  out.headers.set('content-disposition', 'attachment; filename="' + file.replace(/[^\x20-\x7e]/g, '_') +
    '"; filename*=UTF-8\'\'' + encodeURIComponent(file));
  return out;
}

export function fileNameFor(name: string | null | undefined, type: string | null | undefined): string {
  var clean = String(name || '').replace(/[\\/?#]+/g, ' ').trim() || 'file';
  var ext = TYPE_EXT[String(type || '').toLowerCase().split(';')[0].trim()] || '';
  if (ext && clean.slice(-(ext.length + 1)).toLowerCase() !== '.' + ext) clean += '.' + ext;
  return clean;
}

// Streams an R2 object, passing Range through so videos scrub instead
// of downloading whole. Callers do their own access checks first.
// Returns null when the object is missing.
//
// Everything stored was sent by somebody, and the same worker answers
// on the dashboard's hostname, where an organiser's session sits in
// the page's storage. So a stored file opened in a tab of its own is a
// sandboxed document — no script runs in it and it has no origin to
// read storage from — and the browser takes its type as given rather
// than guessing. A picture or a video shown in a page is untouched by
// either. PDFs are left out of the sandbox: Chrome will not open its
// PDF viewer in one, and a PDF's own script runs in the viewer, not on
// the page's origin.
export async function serveStoredFile(bucket: R2Bucket, request: Request, key: string, cacheControl: string, extraHeaders?: Record<string, string>): Promise<Response | null> {
  function headers(object: R2Object, more: Record<string, string>): Record<string, string> {
    var type = (object.httpMetadata && object.httpMetadata.contentType) || 'application/octet-stream';
    var h: Record<string, string> = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'cache-control': cacheControl,
      'x-content-type-options': 'nosniff'
    };
    if (type.toLowerCase().split(';')[0].trim() !== 'application/pdf') {
      h['content-security-policy'] = 'sandbox';
    }
    var k;
    if (extraHeaders) for (k in extraHeaders) h[k] = extraHeaders[k];
    for (k in more) h[k] = more[k];
    return h;
  }
  var rangeHeader = request.headers.get('range');
  var object;
  if (rangeHeader) {
    var m = rangeHeader.match(/bytes=(\d*)-(\d*)/);
    if (m && (m[1] || m[2])) {
      var opts: R2Range | null = null;
      if (m[1] && m[2]) {
        if (+m[2] >= +m[1]) opts = { offset: +m[1], length: +m[2] - +m[1] + 1 };
      } else if (m[1]) {
        opts = { offset: +m[1] };
      } else if (+m[2] > 0) {
        opts = { suffix: +m[2] };
      }
      if (!opts) {
        var meta = await bucket.head(key);
        if (!meta) return null;
        return new Response(null, { status: 416, headers: headers(meta, { 'content-range': 'bytes */' + meta.size }) });
      }
      object = await bucket.get(key, { range: opts });
      if (!object) return null;
      var start = m[1] ? +m[1] : Math.max(0, object.size - +m[2]);
      var end = m[1] && m[2] ? Math.min(+m[2], object.size - 1) : object.size - 1;
      if (object.size === 0 || start >= object.size || start > end) {
        if (object.body) { try { object.body.cancel().catch(function () {}); } catch (err) { /* ignore */ } }
        return new Response(null, { status: 416, headers: headers(object, { 'content-range': 'bytes */' + object.size }) });
      }
      return new Response(object.body, {
        status: 206,
        headers: headers(object, {
          'content-range': 'bytes ' + start + '-' + end + '/' + object.size,
          'content-length': String(end - start + 1)
        })
      });
    }
  }
  object = await bucket.get(key);
  if (!object) return null;
  return new Response(object.body, {
    headers: headers(object, { 'content-length': String(object.size) })
  });
}

// What is kept beside a stored file under its key with a suffix: the
// small copy the sender's browser made (.t), its viewing copy (.v), the
// metadata block (.x), a video's clean copy (.c) and the HEIC or WebP a
// photo was picked as before the page made it a JPEG (.p). Every delete
// goes through deleteStored, so nothing made from a file outlives it.
export var DERIVED = ['.t', '.v', '.x', '.c', '.p'];

// Checks an object's existence and size without reading its body. Uses
// R2 head() where available and cancels the body on fallback mocks.
export async function headStored(bucket: R2Bucket | null | undefined, key: string): Promise<{ size: number } | null> {
  if (!bucket || !key) return null;
  if (typeof bucket.head === 'function') return bucket.head(key);
  var obj = await bucket.get(key, { range: { offset: 0, length: 1 } });
  if (!obj) return null;
  if (obj.body) { try { obj.body.cancel().catch(function () {}); } catch (err) { /* ignore */ } }
  return { size: obj.size };
}

// A stored file and everything kept beside it. One already gone, or a
// bucket that fails on one, does not stop the rest.
export async function deleteStored(bucket: R2Bucket | null | undefined, key: string | null | undefined): Promise<void> {
  if (!bucket || typeof bucket.delete !== 'function' || !key) return;
  var keys = [key].concat(DERIVED.map(function (s) { return key + s; }));
  await Promise.all(keys.map(function (k) {
    return Promise.resolve().then(function () { return bucket.delete(k); }).catch(function () { /* already gone */ });
  }));
}

// The file a photo was picked as (.p), handed over to be saved: under
// its own type, whatever R2 has on the object (one sent straight to R2
// carries none), and under the photo's name with that type's extension.
// Callers decide who may have it. Null when there is none.
export async function servePickedFile(bucket: R2Bucket, request: Request, key: string, type: string, name: string | null | undefined, cacheControl: string, extraHeaders?: Record<string, string>): Promise<Response | null> {
  var resp = await serveStoredFile(bucket, request, key + '.p', cacheControl, extraHeaders);
  if (!resp) return null;
  resp.headers.set('content-type', type);
  return asDownload(resp, name);
}

// A team's submit code: eight characters with nothing that reads as
// something else (no 0/O, 1/I/L).
export function mintCode(): string {
  var alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  var buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  var out = '';
  for (var i = 0; i < 8; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}
