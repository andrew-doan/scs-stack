// Uploads that go from the phone straight to R2, with the worker out of
// the file's path.
//
// A file sent through the worker is held in its memory on the way, and
// one worker instance has 128MB however many uploads it is serving, so a
// few large sends landing together could push it over; Cloudflare also
// caps one request at 100MB. Here the worker only starts the upload,
// hands the page a signed address for each slice, and at the end asks R2
// which slices arrived and joins them. The bytes never pass through it.
//
// R2's S3 API checks every request against an API token's secret with
// AWS signature version 4. This is the same signature as `sign()` in
// scripts/backup.mjs, on WebCrypto because a worker has no node:crypto;
// tests/verify-direct.mjs holds it to AWS's own published examples, and
// the pretend R2 there checks every request with the backup script's
// independent copy.
//
// Off until R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are
// set as secrets (R2_BUCKET is the bucket's name, in wrangler.toml); the
// pages then send files through the worker as they always did.
import { configured, prop } from './shared.ts';
import type { Env } from './types.ts';

// A request to sign: what it is, who signs it and when.
export interface SignOpts {
  method: string;
  host: string;
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  payloadHash: string;
  keyId: string;
  secret: string;
  region: string;
  service: string;
  now: Date;
}

// A slice R2 holds of an upload.
export interface DirectPart {
  n: number;
  etag: string;
  size: number;
}

var TEXT = new TextEncoder();
// how long a signed address for one slice stays good
export var SIGNED_SECONDS = 15 * 60;

function hex(buf: ArrayBuffer): string {
  var b = new Uint8Array(buf);
  var out = '';
  for (var i = 0; i < b.length; i++) out += (b[i] < 16 ? '0' : '') + b[i].toString(16);
  return out;
}
export async function sha256Hex(data: string | ArrayBuffer | ArrayBufferView): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? TEXT.encode(data) : data));
}
async function hmac(key: string | Uint8Array, data: string): Promise<Uint8Array> {
  var k = await crypto.subtle.importKey('raw', typeof key === 'string' ? TEXT.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, TEXT.encode(data)));
}

// RFC 3986: encodeURIComponent leaves these five alone and AWS does not
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, function (c) { return '%' + c.charCodeAt(0).toString(16).toUpperCase(); });
}
function canonicalPath(path: string): string { return path.split('/').map(uriEncode).join('/'); }
function canonicalQuery(query: Record<string, unknown> | null | undefined): string {
  var q = query || {};
  return Object.keys(q).sort().map(function (k) { return uriEncode(k) + '=' + uriEncode(String(q[k])); }).join('&');
}
function amzDateOf(now: Date): string { return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); }

async function signature(o: Pick<SignOpts, 'region' | 'service' | 'secret'>, amzDate: string, canonical: string): Promise<{ scope: string; value: string }> {
  var day = amzDate.slice(0, 8);
  var scope = day + '/' + o.region + '/' + o.service + '/aws4_request';
  var toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n');
  var key = await hmac('AWS4' + o.secret, day);
  key = await hmac(key, o.region);
  key = await hmac(key, o.service);
  key = await hmac(key, 'aws4_request');
  return { scope: scope, value: hex(await crypto.subtle.sign('HMAC',
    await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']), TEXT.encode(toSign))) };
}

// A request signed in its headers: {method, host, path, query, headers,
// payloadHash, keyId, secret, region, service, now}. Answers the headers
// to send, authorization included.
export async function signHeaders(o: SignOpts): Promise<Record<string, string>> {
  var amzDate = amzDateOf(o.now);
  var headers: Record<string, string> = Object.assign({ host: o.host, 'x-amz-date': amzDate }, o.headers || {});
  var names = Object.keys(headers).sort();
  var canonical = [
    o.method, canonicalPath(o.path), canonicalQuery(o.query),
    names.map(function (n) { return n + ':' + String(headers[n]).trim() + '\n'; }).join(''),
    names.join(';'), o.payloadHash
  ].join('\n');
  var sig = await signature(o, amzDate, canonical);
  return Object.assign({}, headers, {
    authorization: 'AWS4-HMAC-SHA256 Credential=' + o.keyId + '/' + sig.scope +
      ', SignedHeaders=' + names.join(';') + ', Signature=' + sig.value
  });
}

// A request signed in its address, so a page can make it with nothing
// but the URL: the same fields plus `expires` in seconds. Only the host
// is signed and the body is not, which is what lets a browser send it.
export async function presignUrl(o: Omit<SignOpts, 'headers' | 'payloadHash'> & { expires: number }): Promise<string> {
  var amzDate = amzDateOf(o.now);
  var query: Record<string, string> = Object.assign({}, o.query || {}, {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': o.keyId + '/' + amzDate.slice(0, 8) + '/' + o.region + '/' + o.service + '/aws4_request',
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(o.expires),
    'X-Amz-SignedHeaders': 'host'
  });
  var canonical = [
    o.method, canonicalPath(o.path), canonicalQuery(query),
    'host:' + o.host + '\n', 'host', 'UNSIGNED-PAYLOAD'
  ].join('\n');
  var sig = await signature(o, amzDate, canonical);
  query['X-Amz-Signature'] = sig.value;
  return 'https://' + o.host + canonicalPath(o.path) + '?' + canonicalQuery(query);
}

// ---------------- R2 ----------------

export function directReady(env: Env | null | undefined): boolean {
  return !!env && configured(env.R2_ACCOUNT_ID) && configured(env.R2_ACCESS_KEY_ID) &&
    configured(env.R2_SECRET_ACCESS_KEY) && !!String(env.R2_BUCKET || '').trim();
}

function where(env: Env, key: string): { host: string; path: string } {
  return { host: String(env.R2_ACCOUNT_ID).trim() + '.r2.cloudflarestorage.com', path: '/' + String(env.R2_BUCKET).trim() + '/' + key };
}
function who(env: Env): { keyId: string; secret: string; region: string; service: string } {
  return { keyId: String(env.R2_ACCESS_KEY_ID).trim(), secret: String(env.R2_SECRET_ACCESS_KEY).trim(), region: 'auto', service: 's3' };
}

async function call(env: Env, method: string, key: string, query: Record<string, string>, extra?: Record<string, string>, body?: string): Promise<string> {
  var at = where(env, key);
  var payload = await sha256Hex(body == null ? '' : body);
  var headers = await signHeaders(Object.assign(who(env), {
    method: method, host: at.host, path: at.path, query: query,
    headers: Object.assign({ 'x-amz-content-sha256': payload }, extra || {}),
    payloadHash: payload, now: new Date()
  }));
  delete headers.host;
  var qs = canonicalQuery(query);
  var res = await fetch('https://' + at.host + canonicalPath(at.path) + (qs ? '?' + qs : ''),
    { method: method, headers: headers, body: body == null ? undefined : body });
  var text = await res.text();
  // S3 can answer 200 with an error in the body when a join fails late
  if (!res.ok || /<Error>/.test(text)) {
    var code = (text.match(/<Code>([^<]*)<\/Code>/) || [])[1] || '';
    throw Object.assign(new Error('R2 ' + method + ' ' + res.status + (code ? ' ' + code : '')), { status: res.status, code: code });
  }
  return text;
}

function unxml(s: unknown): string {
  return String(s).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function tag(xml: unknown, name: string): string {
  var m = String(xml).match(new RegExp('<' + name + '>([^<]*)</' + name + '>'));
  return m ? unxml(m[1]) : '';
}

// Starts the upload R2 keeps the slices under. Answers its id.
export async function directStart(env: Env, key: string, type: string | null | undefined): Promise<string> {
  var xml = await call(env, 'POST', key, { uploads: '' }, { 'content-type': type || 'application/octet-stream' });
  var id = tag(xml, 'UploadId');
  if (!id) throw new Error('R2 gave no upload id');
  return id;
}

// The address one slice is sent to, good for SIGNED_SECONDS.
export function directPartUrl(env: Env, key: string, uploadId: string, n: number): Promise<string> {
  var at = where(env, key);
  return presignUrl(Object.assign(who(env), {
    method: 'PUT', host: at.host, path: at.path,
    query: { partNumber: String(n), uploadId: uploadId },
    expires: SIGNED_SECONDS, now: new Date()
  }));
}

// The address a small file is sent to whole, in one PUT, good for
// SIGNED_SECONDS. Signed for the host alone like a slice, so the page
// sends it with no content type and R2 stores it without one.
export function directPutUrl(env: Env, key: string): Promise<string> {
  var at = where(env, key);
  return presignUrl(Object.assign(who(env), {
    method: 'PUT', host: at.host, path: at.path, expires: SIGNED_SECONDS, now: new Date()
  }));
}

// What R2 holds of an upload so far: [{n, etag, size}] in order.
export async function directParts(env: Env, key: string, uploadId: string): Promise<DirectPart[]> {
  var out: DirectPart[] = [];
  var marker = '';
  for (var guard = 0; guard < 20; guard++) {
    var query: Record<string, string> = { uploadId: uploadId, 'max-parts': '1000' };
    if (marker) query['part-number-marker'] = marker;
    var xml = await call(env, 'GET', key, query);
    var parts = String(xml).match(/<Part>[\s\S]*?<\/Part>/g) || [];
    parts.forEach(function (p) {
      out.push({ n: Number(tag(p, 'PartNumber')), etag: tag(p, 'ETag'), size: Number(tag(p, 'Size')) });
    });
    if (tag(xml, 'IsTruncated') !== 'true') break;
    marker = tag(xml, 'NextPartNumberMarker');
    if (!marker) break;
  }
  out.sort(function (a, b) { return a.n - b.n; });
  return out;
}

function esc(s: unknown): string { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Joins the slices into the object.
export async function directComplete(env: Env, key: string, uploadId: string, parts: DirectPart[]): Promise<void> {
  var body = '<CompleteMultipartUpload>' + parts.map(function (p) {
    return '<Part><PartNumber>' + p.n + '</PartNumber><ETag>' + esc(p.etag) + '</ETag></Part>';
  }).join('') + '</CompleteMultipartUpload>';
  await call(env, 'POST', key, { uploadId: uploadId }, { 'content-type': 'application/xml' }, body);
}

// Copies an object inside the bucket without it passing through the
// worker: how a file staged under a key of its own replaces one that
// has to keep its address. R2 copies up to 5GB this way.
export async function directCopy(env: Env, fromKey: string, toKey: string): Promise<void> {
  var bucket = String(env.R2_BUCKET).trim();
  await call(env, 'PUT', toKey, {}, { 'x-amz-copy-source': canonicalPath('/' + bucket + '/' + fromKey) });
}

// An address an object can be read from for SIGNED_SECONDS, for a
// reader that is not a browser (the encoder). Checked when the read
// starts, so a long download is not cut off part way.
export function directGetUrl(env: Env, key: string): Promise<string> {
  var at = where(env, key);
  return presignUrl(Object.assign(who(env), {
    method: 'GET', host: at.host, path: at.path, expires: SIGNED_SECONDS, now: new Date()
  }));
}

// Gives up on an upload and its slices. One that is already gone is fine.
export async function directAbort(env: Env, key: string, uploadId: string): Promise<void> {
  try { await call(env, 'DELETE', key, { uploadId: uploadId }); } catch (err) {
    if (prop(err, 'status') !== 404) throw err;
  }
}

// ---------------- what the upload routes share ----------------

// A file sent straight to R2 keeps R2's own id for the upload behind
// this mark in its row's upload_id; the rest go through the binding.
var MARK = 'r2:';
export function markDirect(uploadId: string): string { return MARK + uploadId; }
export function isDirect(uploadId: unknown): boolean { return String(uploadId || '').indexOf(MARK) === 0; }
export function directIdOf(uploadId: unknown): string { return String(uploadId).slice(MARK.length); }

function partsOf(bytes: number, partSize: number): number { return Math.max(1, Math.ceil(bytes / partSize)); }
// how long slice n of a file is: the part size, and what is left for
// the last one
export function partBytes(bytes: number, partSize: number, n: number): number {
  var total = partsOf(bytes, partSize);
  return n < total ? partSize : bytes - partSize * (total - 1);
}

// The slices R2 holds at their full size. One cut off part way does not
// count, so a resumed upload sends it again.
export async function directLanded(env: Env, key: string, uploadId: string, bytes: number, partSize: number): Promise<DirectPart[]> {
  var total = partsOf(bytes, partSize);
  return (await directParts(env, key, uploadId)).filter(function (p) {
    return p.n >= 1 && p.n <= total && p.size === partBytes(bytes, partSize, p.n);
  });
}

// The worker never saw a slice, so it asks R2 what arrived, checks every
// one is there at its full size, and joins them. Answers null when the
// file is whole, else {error, status, missing}.
export async function directJoin(env: Env, key: string, uploadId: string, bytes: number, partSize: number): Promise<{ error: string; status: number; missing?: boolean } | null> {
  var total = partsOf(bytes, partSize);
  var whole: DirectPart[];
  try { whole = await directLanded(env, key, uploadId, bytes, partSize); } catch (err) {
    return { error: 'Storage could not be reached. Try again.', status: 502 };
  }
  if (whole.length !== total) return { error: whole.length + ' of ' + total + ' parts uploaded', status: 409, missing: true };
  try { await directComplete(env, key, uploadId, whole); } catch (err) {
    return { error: 'The parts could not be stitched together. Try the upload again.', status: 500 };
  }
  return null;
}
