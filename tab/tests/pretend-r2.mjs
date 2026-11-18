// A pretend R2 for the suites that send files straight to storage
// (src/r2direct.ts). It answers the S3 API on the account's R2 host by
// standing in for fetch, and checks every request's signature by
// working it out again — header-signed ones with scripts/backup.mjs's
// node:crypto signer, presigned addresses with the check below — never
// with the worker's own code, so a signature wrong the same way on both
// sides cannot pass.
//
//   const r2 = pretendR2();            // or pretendR2({ store })
//   env = Object.assign({ DB, SUBMIT: r2.SUBMIT }, r2.env)
//   r2.seen.part, r2.bucket.get(key), r2.restore()
//
// `store` lets a suite keep its own bucket shim: {set(key, bytes, type),
// get(key) -> {bytes, type} | null, delete(key)}. Without one the
// objects live in r2.bucket, and r2.SUBMIT is a binding over the same
// objects that refuses multipart uploads, since a direct upload must
// never go through the binding.
import { createHash, createHmac } from 'node:crypto';
import { sign } from '../scripts/backup.mjs';

export const ACCOUNT = 'acct123';
export const HOST = ACCOUNT + '.r2.cloudflarestorage.com';
export const KEY_ID = 'test-key-id';
export const SECRET = 'test-secret-value';
export const BUCKET = 'scs-submissions';
export const R2_ENV = { R2_ACCOUNT_ID: ACCOUNT, R2_ACCESS_KEY_ID: KEY_ID, R2_SECRET_ACCESS_KEY: SECRET, R2_BUCKET: BUCKET };

export async function drain(value) {
  if (value == null) return new Uint8Array(0);
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'string') return new TextEncoder().encode(value);
  if (typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer());
  const reader = value.getReader();
  const parts = [];
  for (;;) { const { done, value: c } = await reader.read(); if (done) break; parts.push(c); }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const hmacOf = (key, data) => createHmac('sha256', key).update(data).digest();
const stamp = (d) => new Date(String(d).replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'));

// a presigned address worked out again from what arrived
export function presignOk(url, method) {
  const q = Object.fromEntries(url.searchParams.entries());
  const sig = q['X-Amz-Signature'];
  delete q['X-Amz-Signature'];
  const amzDate = q['X-Amz-Date'] || '';
  const day = amzDate.slice(0, 8);
  const scope = day + '/auto/s3/aws4_request';
  if (q['X-Amz-Credential'] !== KEY_ID + '/' + scope || q['X-Amz-SignedHeaders'] !== 'host') return false;
  const canonical = [
    method, url.pathname.split('/').map((p) => enc(decodeURIComponent(p))).join('/'),
    Object.keys(q).sort().map((k) => enc(k) + '=' + enc(q[k])).join('&'),
    'host:' + url.host + '\n', 'host', 'UNSIGNED-PAYLOAD'
  ].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  let k = hmacOf('AWS4' + SECRET, day);
  k = hmacOf(k, 'auto'); k = hmacOf(k, 's3'); k = hmacOf(k, 'aws4_request');
  const expires = stamp(amzDate).getTime() + Number(q['X-Amz-Expires']) * 1000;
  return createHmac('sha256', k).update(toSign).digest('hex') === sig && Date.now() < expires;
}

// a header-signed request worked out again with the backup script's signer
export function headersOk(url, method, headers) {
  const auth = headers.get('authorization') || '';
  const names = ((auth.match(/SignedHeaders=([^,]+)/) || [])[1] || '').split(';');
  const extra = {};
  names.forEach((n) => { if (n !== 'host' && n !== 'x-amz-date') extra[n] = headers.get(n); });
  const again = sign({
    method, host: url.host, path: decodeURIComponent(url.pathname), query: Object.fromEntries(url.searchParams.entries()),
    headers: extra, payloadHash: headers.get('x-amz-content-sha256'),
    keyId: KEY_ID, secret: SECRET, region: 'auto', service: 's3', now: stamp(headers.get('x-amz-date') || '')
  });
  return again.authorization === auth;
}

const xml = (body, status) => new Response(body, { status: status || 200, headers: { 'content-type': 'application/xml' } });

export function pretendR2(opts) {
  opts = opts || {};
  const bucket = new Map();
  const store = opts.store || {
    set(key, bytes, type) { bucket.set(key, { bytes, meta: { contentType: type } }); },
    get(key) { const hit = bucket.get(key); return hit ? { bytes: hit.bytes, type: hit.meta.contentType } : null; },
    delete(key) { bucket.delete(key); }
  };
  const SUBMIT = {
    async put(key, value, o) { bucket.set(key, { bytes: await drain(value), meta: (o && o.httpMetadata) || {}, custom: (o && o.customMetadata) || {} }); },
    async delete(key) { bucket.delete(key); },
    async head(key) { return bucket.has(key) ? { size: bucket.get(key).bytes.length } : null; },
    async get(key, o) {
      const hit = bucket.get(key);
      if (!hit) return null;
      let bytes = hit.bytes;
      if (o && o.range) bytes = bytes.slice(o.range.offset, o.range.length != null ? o.range.offset + o.range.length : undefined);
      return { body: bytes, size: hit.bytes.length, httpMetadata: hit.meta, customMetadata: hit.custom || {},
        async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
    },
    createMultipartUpload() { throw new Error('a direct upload must not go through the binding'); },
    resumeMultipartUpload() { throw new Error('a direct upload must not go through the binding'); }
  };

  const uploads = new Map(); // id -> { key, type, parts: Map(n -> bytes) }
  const seen = { create: 0, part: 0, list: 0, complete: 0, abort: 0, copy: 0, get: 0, put: 0, refused: 0 };
  let upSeq = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.host !== HOST) return realFetch(input, init);
    const method = req.method;
    const presigned = url.searchParams.has('X-Amz-Signature');
    const body = await drain(await req.arrayBuffer());
    if (presigned ? !presignOk(url, method) : !headersOk(url, method, req.headers)) {
      seen.refused++;
      return xml('<Error><Code>SignatureDoesNotMatch</Code></Error>', 403);
    }
    const prefix = '/' + BUCKET + '/';
    const path = decodeURIComponent(url.pathname);
    if (path.indexOf(prefix) !== 0) return xml('<Error><Code>NoSuchBucket</Code></Error>', 404);
    const key = path.slice(prefix.length);
    const id = url.searchParams.get('uploadId');
    if (method === 'POST' && url.searchParams.has('uploads')) {
      seen.create++;
      const up = 'up' + (++upSeq);
      uploads.set(up, { key, type: req.headers.get('content-type'), parts: new Map() });
      return xml('<InitiateMultipartUploadResult><Key>' + key + '</Key><UploadId>' + up + '</UploadId></InitiateMultipartUploadResult>');
    }
    if (!id) {
      // a whole object: read with a presigned GET, sent whole to a
      // presigned PUT, or copied server side
      if (method === 'GET') {
        seen.get++;
        const hit = store.get(key);
        if (!hit) return xml('<Error><Code>NoSuchKey</Code></Error>', 404);
        return new Response(hit.bytes, { status: 200, headers: { 'content-type': hit.type || 'application/octet-stream' } });
      }
      if (method === 'PUT' && req.headers.get('x-amz-copy-source')) {
        seen.copy++;
        const from = decodeURIComponent(req.headers.get('x-amz-copy-source')).replace(/^\//, '');
        if (from.indexOf(BUCKET + '/') !== 0) return xml('<Error><Code>NoSuchBucket</Code></Error>', 404);
        const hit = store.get(from.slice(BUCKET.length + 1));
        if (!hit) return xml('<Error><Code>NoSuchKey</Code></Error>', 404);
        store.set(key, hit.bytes, hit.type);
        return xml('<CopyObjectResult><ETag>&quot;c&quot;</ETag></CopyObjectResult>');
      }
      if (method === 'PUT' && presigned) {
        seen.put++;
        store.set(key, body, req.headers.get('content-type') || null);
        return new Response(null, { status: 200, headers: { etag: '"w' + body.length + '"' } });
      }
      return xml('<Error><Code>NotImplemented</Code></Error>', 501);
    }
    const up = uploads.get(id);
    if (!up || up.key !== key) return xml('<Error><Code>NoSuchUpload</Code></Error>', 404);
    if (method === 'PUT') {
      seen.part++;
      const n = Number(url.searchParams.get('partNumber'));
      up.parts.set(n, body);
      return new Response(null, { status: 200, headers: { etag: '"e' + n + '-' + body.length + '"' } });
    }
    if (method === 'GET') {
      seen.list++;
      const parts = [...up.parts.entries()].sort((a, b) => a[0] - b[0]).map(([n, b]) =>
        '<Part><PartNumber>' + n + '</PartNumber><ETag>&quot;e' + n + '-' + b.length + '&quot;</ETag><Size>' + b.length + '</Size></Part>').join('');
      return xml('<ListPartsResult><UploadId>' + id + '</UploadId><IsTruncated>false</IsTruncated>' + parts + '</ListPartsResult>');
    }
    if (method === 'POST') {
      seen.complete++;
      const listed = [...new TextDecoder().decode(body).matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag>/g)];
      const chunks = [];
      for (const [, n, etag] of listed) {
        const b = up.parts.get(Number(n));
        if (!b || etag.replace(/&quot;/g, '"') !== '"e' + n + '-' + b.length + '"') return xml('<Error><Code>InvalidPart</Code></Error>', 400);
        chunks.push(b);
      }
      const out = new Uint8Array(chunks.reduce((t, c) => t + c.length, 0));
      let at = 0;
      for (const c of chunks) { out.set(c, at); at += c.length; }
      store.set(key, out, up.type);
      uploads.delete(id);
      return xml('<CompleteMultipartUploadResult><Key>' + key + '</Key></CompleteMultipartUploadResult>');
    }
    if (method === 'DELETE') {
      seen.abort++;
      uploads.delete(id);
      return new Response(null, { status: 204 });
    }
    return xml('<Error><Code>NotImplemented</Code></Error>', 501);
  };
  return { env: R2_ENV, SUBMIT, bucket, uploads, seen, restore() { globalThis.fetch = realFetch; } };
}
