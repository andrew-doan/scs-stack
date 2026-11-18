// A video the encoder has not reached, as it was uploaded but with what
// the phone wrote into it blanked out: where it was filmed, the phone,
// the software. The team gallery and the albums play this until the
// encoder's copies exist (`uploaded=1` on /api/submit/file and
// /api/albums/file).
//
// An MP4 or a QuickTime file is a run of boxes, each a length and a
// four-letter type, and that metadata lives in boxes of its own: `udta`
// (user data, where ©xyz is the location), `meta` (Apple's keyed
// metadata, location and phone model included) and `uuid` (XMP). A
// player skips a box it has no use for, and `free` is the box type that
// says so. Each of those boxes keeps its length, takes the name `free`
// and has everything inside it written as zeros, so not a byte moves,
// every offset in the file stays right and nothing is re-encoded, and
// the location is not in the file at all, not only out of a player's
// sight.
//
// Which boxes those are is worked out once per file from a few small
// reads (each top-level box header, then the moov box whole) and kept
// in the edge cache; serving is the original's bytes with those boxes
// blanked as they stream past, so a Range request costs what it does
// for any other file.
//
// The same boxes are also read (videoBlock), for an album's video
// details and the dashboard's: what they say goes into the block kept
// beside a photo (`<key>.x`), written as XMP.

import { xmpOf, creationTime } from './strip.ts';
import type { Env } from './types.ts';

// A box to blank: [where it starts, its header's length, its length].
type Patch = [number, number, number];
export interface Patches {
  size: number;
  patches: Patch[];
}
interface TopBox {
  at: number;
  len: number;
  hdr: number;
  type: string;
}
interface Child {
  type: string;
  at: number;
  start: number;
  end: number;
}

var BLANK = ['udta', 'meta', 'uuid'];
// the boxes that hold the ones above: the movie, each track and its media
var CONTAINERS = ['moov', 'trak', 'edts', 'mdia', 'minf'];
// what a file this can read starts with
var FIRST = ['ftyp', 'wide', 'free', 'skip', 'mdat', 'moov', 'pnot', 'uuid'];
var MOOV_MAX = 32 * 1024 * 1024;
var FREE = [0x66, 0x72, 0x65, 0x65];

function typeAt(b: Uint8Array, i: number): string { return String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]); }
function u32(b: Uint8Array, i: number): number { return b[i] * 16777216 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]); }

// a box's length and header size at i, or null when it does not fit
function boxAt(b: Uint8Array, i: number, end: number): { len: number; hdr: number; type: string } | null {
  if (i + 8 > end) return null;
  var len = u32(b, i);
  var hdr = 8;
  if (len === 1) {
    if (i + 16 > end) return null;
    len = u32(b, i + 8) * 4294967296 + u32(b, i + 12);
    hdr = 16;
  } else if (len === 0) {
    len = end - i;
  }
  return { len: len, hdr: hdr, type: typeAt(b, i + 4) };
}

async function readRange(bucket: R2Bucket, key: string, offset: number, length: number): Promise<{ bytes: Uint8Array; size: number } | null> {
  var obj = await bucket.get(key, { range: { offset: offset, length: length } });
  if (!obj) return null;
  return { bytes: new Uint8Array(await obj.arrayBuffer()), size: obj.size };
}

function walk(b: Uint8Array, from: number, to: number, base: number, patches: Patch[]): boolean {
  var i = from;
  while (i + 8 <= to) {
    var box = boxAt(b, i, to);
    if (!box || box.len < box.hdr || i + box.len > to) return false;
    if (BLANK.indexOf(box.type) !== -1) patches.push([base + i, box.hdr, box.len]);
    else if (CONTAINERS.indexOf(box.type) !== -1 && !walk(b, i + box.hdr, i + box.len, base, patches)) return false;
    i += box.len;
  }
  return true;
}

// The file's top-level boxes, from a small read of each header, and its
// size; null for a file that is not a run of boxes.
async function topBoxes(bucket: R2Bucket, key: string): Promise<{ size: number; boxes: TopBox[] } | null> {
  var first = await readRange(bucket, key, 0, 16);
  if (!first || first.bytes.length < 8) return null;
  var size = first.size;
  if (FIRST.indexOf(typeAt(first.bytes, 4)) === -1) return null;
  var boxes: TopBox[] = [];
  var at = 0;
  for (var n = 0; at + 8 <= size; n++) {
    if (n >= 64) return null;
    var head = at === 0 ? first : await readRange(bucket, key, at, Math.min(16, size - at));
    if (!head) return null;
    var box = boxAt(head.bytes, 0, size - at);
    if (!box || box.len < box.hdr || at + box.len > size) return null;
    boxes.push({ at: at, len: box.len, hdr: box.hdr, type: box.type });
    at += box.len;
  }
  return { size: size, boxes: boxes };
}

// Every box to blank, as [where it starts, its header's length, its
// length], and the file's size; null for a file this cannot read (WebM, a broken file, a movie
// header too big to read whole), which the page shows as processing.
export async function metadataPatches(bucket: R2Bucket, key: string): Promise<Patches | null> {
  var top = await topBoxes(bucket, key);
  if (!top) return null;
  var size = top.size;
  var patches: Patch[] = [];
  var moov = null as TopBox | null;
  top.boxes.forEach(function (box) {
    if (BLANK.indexOf(box.type) !== -1) patches.push([box.at, box.hdr, box.len]);
    if (box.type === 'moov') moov = box;
  });
  if (!moov || moov.len > MOOV_MAX) return null;
  var whole = await readRange(bucket, key, moov.at, moov.len);
  if (!whole || whole.bytes.length !== moov.len) return null;
  if (!walk(whole.bytes, moov.hdr, moov.len, moov.at, patches)) return null;
  return { size: size, patches: patches };
}

// When a video was filmed, in UTC as the system stores it: the movie
// header's creation time, which a phone writes in UTC, counted in
// seconds from 1904. '' when the file does not say or cannot be read.
export async function videoTakenAt(bucket: R2Bucket, key: string): Promise<string> {
  var top = await topBoxes(bucket, key);
  var moov = top && top.boxes.filter(function (b) { return b.type === 'moov'; })[0];
  if (!moov || moov.len < moov.hdr + 28) return '';
  var head = await readRange(bucket, key, moov.at + moov.hdr, 28);
  if (!head || head.bytes.length < 28) return '';
  var b = head.bytes;
  if (typeAt(b, 4) !== 'mvhd') return '';
  var secs = b[8] === 1 ? u32(b, 12) * 4294967296 + u32(b, 16) : u32(b, 12);
  var ms = (secs - 2082844800) * 1000;
  if (!secs || ms < Date.UTC(1990, 0, 1) || ms > Date.now() + 2 * 86400000) return '';
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// ---------- what the phone wrote, read ----------
// Apple's keyed metadata is a meta box whose `keys` names each entry
// and whose `ilst` holds them by number, each value in a `data` box (a
// type, a locale, then the bytes). The older user data in udta is a box
// per fact, ©xyz the location and ©day the time, each a two-byte length,
// a two-byte language and the text; an MP4 may put an iTunes-style meta
// box there instead, named the same way as udta's.

// the boxes directly inside from..to, as {type, at, start, end}
function children(b: Uint8Array, from: number, to: number): Child[] {
  var out: Child[] = [];
  var i = from;
  while (i + 8 <= to) {
    var box = boxAt(b, i, to);
    if (!box || box.len < box.hdr || i + box.len > to) break;
    out.push({ type: box.type, at: i, start: i + box.hdr, end: i + box.len });
    i += box.len;
  }
  return out;
}
function text(b: Uint8Array, from: number, to: number): string {
  return new TextDecoder().decode(b.subarray(from, Math.max(from, to))).replace(/\0+$/, '').trim();
}
// QuickTime's meta box starts with its children, an MP4's with four
// bytes of version and flags first
function metaChildren(b: Uint8Array, box: Child): Child[] {
  var from = box.start;
  if (from + 8 <= box.end && typeAt(b, from + 4) !== 'hdlr') from += 4;
  return children(b, from, box.end);
}
function dataText(b: Uint8Array, box: Child): string {
  var d = children(b, box.start, box.end).filter(function (k) { return k.type === 'data'; })[0];
  return d && d.start + 8 <= d.end ? text(b, d.start + 8, d.end) : '';
}
var NAMED: Record<string, string> = {
  'com.apple.quicktime.location.ISO6709': 'location', 'com.apple.quicktime.make': 'make',
  'com.apple.quicktime.model': 'model', 'com.apple.quicktime.software': 'software',
  'com.apple.quicktime.creationdate': 'taken',
  '\u00A9xyz': 'location', '\u00A9mak': 'make', '\u00A9mod': 'model', '\u00A9swr': 'software',
  '\u00A9too': 'software', '\u00A9day': 'taken'
};
function readKeyed(b: Uint8Array, box: Child, said: Record<string, string>): void {
  var kids = metaChildren(b, box);
  var keys = kids.filter(function (k) { return k.type === 'keys'; })[0];
  var ilst = kids.filter(function (k) { return k.type === 'ilst'; })[0];
  if (!ilst) return;
  var names: string[] = [];
  if (keys && keys.start + 8 <= keys.end) {
    var count = u32(b, keys.start + 4);
    var at = keys.start + 8;
    for (var n = 0; n < count && at + 8 <= keys.end; n++) {
      var size = u32(b, at);
      if (size < 8 || at + size > keys.end) break;
      names.push(text(b, at + 8, at + size));
      at += size;
    }
  }
  children(b, ilst.start, ilst.end).forEach(function (item) {
    var index = u32(b, item.at + 4);
    var fact = NAMED[index >= 1 && index <= names.length ? names[index - 1] : item.type];
    if (fact && !said[fact]) said[fact] = dataText(b, item);
  });
}
function readUserData(b: Uint8Array, box: Child, said: Record<string, string>): void {
  children(b, box.start, box.end).forEach(function (k) {
    if (k.type === 'meta') { readKeyed(b, k, said); return; }
    var fact = NAMED[k.type];
    if (!fact || said[fact]) return;
    if (k.start + 8 <= k.end && typeAt(b, k.start + 4) === 'data') { said[fact] = dataText(b, k); return; }
    if (k.start + 4 > k.end) return;
    said[fact] = text(b, k.start + 4, Math.min(k.end, k.start + 4 + ((b[k.start] << 8) | b[k.start + 1])));
  });
}

// What a video says about itself, as the block kept beside it: the time
// it was filmed with its zone, the phone and its software, and where,
// from "+33.8688+151.2093+012.000/" (degrees, then metres). A time in
// UTC is left out, as the movie header's is: the details give the zone
// it was filmed in, and UTC is not that. An empty block when the video
// says none of it; null when it cannot be read.
export async function videoBlock(bucket: R2Bucket, key: string): Promise<Uint8Array | null> {
  var top = await topBoxes(bucket, key);
  var moov = top && top.boxes.filter(function (box) { return box.type === 'moov'; })[0];
  if (!moov || moov.len > MOOV_MAX) return null;
  var whole = await readRange(bucket, key, moov.at, moov.len);
  if (!whole || whole.bytes.length !== moov.len) return null;
  var b = whole.bytes;
  var said: Record<string, string> = {};
  children(b, moov.hdr, moov.len).forEach(function (box) {
    if (box.type === 'meta') readKeyed(b, box, said);
    else if (box.type === 'udta') readUserData(b, box, said);
  });
  var facts: Record<string, string> = { 'tiff:Make': said.make || '', 'tiff:Model': said.model || '', 'xmp:CreatorTool': said.software || '' };
  var taken = creationTime(said.taken);
  if (taken && !/Z$/.test(taken)) facts['exif:DateTimeOriginal'] = taken;
  var where = String(said.location || '').match(/^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/);
  if (where && Math.abs(Number(where[1])) <= 90 && Math.abs(Number(where[2])) <= 180) {
    facts['exif:GPSLatitude'] = String(Number(where[1]));
    facts['exif:GPSLongitude'] = String(Number(where[2]));
    if (where[3]) {
      facts['exif:GPSAltitude'] = String(Math.abs(Number(where[3])));
      facts['exif:GPSAltitudeRef'] = Number(where[3]) < 0 ? '1' : '0';
    }
  }
  return xmpOf(facts);
}

async function patchesFor(request: Request, bucket: R2Bucket, key: string): Promise<Patches | null> {
  var cache = typeof caches !== 'undefined' && caches.default;
  var slot = new Request(new URL('/__video-patches/' + encodeURIComponent(key), request.url).toString());
  if (cache) {
    var hit = await cache.match(slot);
    if (hit) return hit.json<Patches>();
  }
  var found = await metadataPatches(bucket, key);
  if (found && cache) {
    await cache.put(slot, new Response(JSON.stringify(found), {
      headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=86400' }
    }));
  }
  return found;
}

// bytes=a-b, bytes=a- or bytes=-n: {start, end}, null for the whole
// file, or false for one that cannot be served
function rangeOf(header: string | null, size: number): { start: number; end: number } | null | false {
  if (!header) return null;
  var m = String(header).match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  var start: number;
  var end: number;
  if (!m[1]) {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return false;
  return { start: start, end: end };
}

// The answer for one request, or null to fall through to the copies.
export async function serveUploadedVideo(env: Env, request: Request, key: string, type: string, extraHeaders?: Record<string, string>): Promise<Response | null> {
  var found = await patchesFor(request, env.SUBMIT, key);
  if (!found) return null;
  var size = found.size;
  var range = rangeOf(request.headers.get('range'), size);
  var h: Record<string, string> = {
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox'
  };
  var k;
  if (extraHeaders) for (k in extraHeaders) h[k] = extraHeaders[k];
  if (range === false) {
    h['content-range'] = 'bytes */' + size;
    return new Response(null, { status: 416, headers: h });
  }
  var start = range ? range.start : 0;
  var end = range ? range.end : size - 1;
  var obj = await env.SUBMIT.get(key, { range: { offset: start, length: end - start + 1 } });
  if (!obj) return null;
  var boxes = found.patches.filter(function (p) { return p[0] + p[2] > start && p[0] <= end; });
  var pos = start;
  var body = obj.body && typeof obj.body.pipeThrough === 'function' ? obj.body : new Response(obj.body).body as ReadableStream;
  var stream = body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform: function (chunk, out) {
      var c = chunk;
      var copied = false;
      function own() { if (!copied) { c = new Uint8Array(chunk); copied = true; } }
      boxes.forEach(function (p) {
        // the name
        for (var j = 0; j < 4; j++) {
          var abs = p[0] + 4 + j;
          if (abs < pos || abs >= pos + chunk.length) continue;
          own();
          c[abs - pos] = FREE[j];
        }
        // everything after the header
        var from = Math.max(p[0] + p[1], pos);
        var to = Math.min(p[0] + p[2], pos + chunk.length);
        if (from < to) { own(); c.fill(0, from - pos, to - pos); }
      });
      pos += chunk.length;
      out.enqueue(c);
    }
  }));
  h['content-length'] = String(end - start + 1);
  if (range) h['content-range'] = 'bytes ' + start + '-' + end + '/' + size;
  return new Response(stream, { status: range ? 206 : 200, headers: h });
}
