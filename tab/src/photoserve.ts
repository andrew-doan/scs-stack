// Photos are served with their metadata cut out as they stream past,
// rather than from a second, cleaned copy kept beside each one.
//
// What comes out is the same as stripImage makes (strip.ts): the same
// bytes with the segments or chunks that carry the location, the camera
// and the comments taken out, and a JPEG's orientation put back on its
// own. The cut — which stretches of the original to send and what goes
// in between — is worked out once and kept in the edge cache: from a
// JPEG's first bytes, where all of its metadata sits; by walking a
// PNG's chunk headers; or from a GIF read whole. Serving is then one
// read of the original, through keepStream. A file the cutter cannot
// read is never sent as it is: the caller falls back to the copies the
// sender's browser drew (.v, .t), which carry nothing.
//
// The block that came out (its EXIF and XMP, metaBlockOf) is kept at
// `<key>.x`, a few KB, for the dashboard's location panel, an album's
// photo details and the time a photo was taken. Upload writes it
// (writeBlock in submit.ts); metaBlock writes it the first time it is
// asked for, for a photo from before. A video's is what its own boxes
// say, written as XMP (videoBlock in videostrip.ts).

import { strippable, baseType, STRIP_VERSION, planJpegHead, planWhole, pngWalker, keepLength, keepStream, stripImage, metaBlockOf } from './strip.ts';
import { videoBlock } from './videostrip.ts';
import { isBlobLike } from './shared.ts';
import type { Cut, Keep, Stripped } from './strip.ts';
import type { Env } from './types.ts';

// The cut as the edge cache keeps it, read back: a range is [from, to],
// bytes put in its place were stored as {b: [...]}.
interface StoredPlan {
  size: number;
  etag?: string;
  keep: Keep[];
}

// Which reading of a file a stored block came from, on the block as R2
// metadata. 2 read a PNG's text chunks and a JPEG's XMP as well as the
// EXIF; 3 reads a GIF's XMP, a PNG's XMP profile and Creation Time, and
// a video's own metadata. A block from an earlier reading is read again
// once, the first time it is asked for, since a file that said little
// then may say more now; one that cannot be read again stays as it was.
var BLOCK_READ = '3';
function putBlock(env: Env, key: string, block: Uint8Array): Promise<R2Object | null> {
  return env.SUBMIT.put(key + '.x', block, {
    httpMetadata: { contentType: 'application/octet-stream' },
    customMetadata: { read: BLOCK_READ }
  });
}

// a GIF is read whole to be cut; past this it is not served at all
var MAX_GIF_BYTES = 32 * 1024 * 1024;
var PLAN_CACHE = 'public, max-age=604800';

function readable(object: R2ObjectBody): ReadableStream {
  return object.body && typeof object.body.pipeThrough === 'function' ? object.body : new Response(object.body).body as ReadableStream;
}

// The cut for one stored photo: {size, etag, keep, exif}, or null when
// it cannot be read as its type.
async function computePlan(env: Env, key: string, type: string, size: number): Promise<Pick<Cut, 'keep' | 'exif' | 'xmp' | 'texts'> | null> {
  var t = baseType(type);
  var found: Cut | null = null;
  if (t === 'image/jpeg' || t === 'image/jpg') {
    var lengths = [256 * 1024, 4 * 1024 * 1024];
    for (var i = 0; i < lengths.length && !found; i++) {
      var head = await env.SUBMIT.get(key, { range: { offset: 0, length: Math.min(size, lengths[i]) } });
      if (!head) return null;
      found = planJpegHead(new Uint8Array(await head.arrayBuffer()), size);
      if (lengths[i] >= size) break;
    }
  } else if (t === 'image/png') {
    var walk = pngWalker();
    var whole = await env.SUBMIT.get(key);
    if (!whole) return null;
    var reader = readable(whole).getReader();
    for (;;) {
      var piece = await reader.read();
      if (piece.done) break;
      walk.push(piece.value);
    }
    found = walk.finish(size);
  } else if (t === 'image/gif' && size <= MAX_GIF_BYTES) {
    var gif = await env.SUBMIT.get(key);
    if (!gif) return null;
    found = planWhole(new Uint8Array(await gif.arrayBuffer()), type);
  }
  return found ? { keep: found.keep, exif: found.exif || null, xmp: found.xmp || null, texts: found.texts || [] } : null;
}

// The plan as the edge cache keeps it: a range is [from, to], bytes put
// in its place are {b: [...]}.
function packPlan(plan: Pick<Cut, 'keep'>, size: number, etag: string | undefined): string {
  return JSON.stringify({
    size: size, etag: etag || '',
    keep: plan.keep.map(function (k) { return k instanceof Uint8Array ? { b: Array.from(k) } : k; })
  });
}
function unpackPlan(text: string): StoredPlan {
  var p = JSON.parse(text) as { size: number; etag: string; keep: ([number, number] | { b: number[] } | Keep)[] };
  p.keep = p.keep.map(function (k) { return Array.isArray(k) ? k as [number, number] : new Uint8Array((k as { b: number[] }).b); });
  return p as StoredPlan;
}

function planSlot(request: Request, key: string): Request {
  return new Request(new URL('/__photo-plan/' + STRIP_VERSION + '/' + encodeURIComponent(key), request.url).toString());
}

// The photo with its metadata cut out, as a response: null when the
// photo is not one this can cut, is not in the bucket, or cannot be
// read as its type. Range is not taken: a picture is asked for whole.
export async function serveCleanPhoto(env: Env, request: Request, key: string, type: string | null, cacheControl: string, extraHeaders?: Record<string, string>): Promise<Response | null> {
  if (!type || !strippable(type)) return null;
  var obj = await env.SUBMIT.get(key);
  if (!obj) return null;
  var cache = typeof caches !== 'undefined' && caches.default;
  var slot = planSlot(request, key);
  var plan: StoredPlan | null = null;
  if (cache) {
    var hit = await cache.match(slot);
    if (hit) {
      try { plan = unpackPlan(await hit.text()); } catch (err) { plan = null; }
      // a file replaced under the same key gets a new cut
      if (plan && (plan.size !== obj.size || (obj.etag && plan.etag && plan.etag !== obj.etag))) plan = null;
    }
  }
  if (!plan) {
    var made;
    try { made = await computePlan(env, key, type, obj.size); } catch (err) { made = null; }
    if (!made) return null;
    plan = { size: obj.size, keep: made.keep };
    if (cache) {
      await cache.put(slot, new Response(packPlan(made, obj.size, obj.etag), {
        headers: { 'content-type': 'application/json', 'cache-control': PLAN_CACHE }
      }));
    }
  }
  var length = keepLength(plan.keep);
  var headers: Record<string, string> = {
    'content-type': type,
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox'
  };
  var k;
  if (extraHeaders) for (k in extraHeaders) headers[k] = extraHeaders[k];
  var cut = readable(obj).pipeThrough(keepStream(plan.keep));
  // R2 and the runtime send a length only for a stream whose length is known
  if (typeof FixedLengthStream === 'function') {
    var fixed = new FixedLengthStream(length);
    cut.pipeTo(fixed.writable).catch(function () { /* the reader went away */ });
    headers['content-length'] = String(length);
    return new Response(fixed.readable, { status: 200, headers: headers });
  }
  return new Response(cut, { status: 200, headers: headers });
}

// The metadata block a photo or video carried, written to `<key>.x` the
// first time it is asked for if the upload did not write it, or if it
// was written by an earlier reading; an empty block when the file
// carried none. Null for a file this cannot read.
export async function metaBlock(env: Env, key: string, type: string): Promise<Uint8Array | null> {
  var stored = await env.SUBMIT.get(key + '.x');
  var kept = stored ? new Uint8Array(await stored.arrayBuffer()) : null;
  if (stored && stored.customMetadata && stored.customMetadata.read === BLOCK_READ) return kept;
  var video = baseType(type).indexOf('video/') === 0;
  if (!strippable(type) && !video) return kept;
  var block: Uint8Array | null = null;
  if (video) {
    try { block = await videoBlock(env.SUBMIT, key); } catch (err) { block = null; }
  } else {
    var probe = await env.SUBMIT.get(key, { range: { offset: 0, length: 1 } });
    var plan: Awaited<ReturnType<typeof computePlan>> = null;
    if (probe) {
      try { plan = await computePlan(env, key, type, probe.size); } catch (err) { plan = null; }
    }
    if (plan) block = await metaBlockOf(plan);
  }
  if (!block) return kept;
  await putBlock(env, key, block);
  return block;
}

// For a file that arrives whole: its block written now, from the bytes
// already in hand, and the cut read through once to say the file is
// what its type says. Answers what stripImage found (`parsed`) with the
// block it wrote (`block`), or null for a file it cannot read, a type
// it does not cut or one too big to hold, which metaBlock reads later
// instead.
var MAX_HELD_BYTES = 32 * 1024 * 1024;
export async function writeBlock(env: Env, key: string, type: string, source: Blob | Uint8Array | null | undefined): Promise<(Stripped & { block?: Uint8Array }) | null> {
  if (!strippable(type)) return null;
  try {
    var bytes = isBlobLike(source)
      ? new Uint8Array(await source.arrayBuffer())
      : source;
    if (!bytes || !bytes.length || bytes.length > MAX_HELD_BYTES) return null;
    var out: Stripped & { block?: Uint8Array } = stripImage(bytes, type);
    if (!out.parsed) return null;
    out.block = await metaBlockOf(out);
    await putBlock(env, key, out.block);
    return out;
  } catch (err) {
    // the file itself is fine to keep; the block is read later instead
    return null;
  }
}
