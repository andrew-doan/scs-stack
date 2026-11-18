// Photo metadata: taking it out of what everyone sees, and reading it
// for the people who should.
//
// A phone writes a great deal into every photo — where it was taken to
// a few metres, which phone took it, when, and enough of a trail to
// say whether it was edited since. That is worth keeping (it is how an
// organiser tells a real photo from a screenshot of someone else's)
// and it is not worth handing to every team that can open the gallery.
// So the original is kept and shown only in the dashboard, and what
// the site serves has the metadata taken out.
//
// It is taken out by deleting bytes, not by re-encoding. A JPEG is a
// flat chain of labelled segments and nothing in it refers to an
// absolute position in the file, so dropping the segment that holds
// EXIF leaves a valid file with pixel-for-pixel the same picture. PNG
// is the same idea with chunks. That means no quality loss, no work
// beyond copying bytes, and it can be done to files that are already
// in the bucket.
//
// The cut is made as the photo is served (photoserve.ts), so only the
// original is stored. Beside it, `<key>.x` is the metadata block on its
// own, a few KB rather than a few MB, so the dashboard can say where a
// photo was taken without downloading the photo.

// Which version of the rules a cut was worked out under. The edge cache
// keeps each photo's cut under this number, so a change here reaches
// every photo the next time it is asked for. Bump it whenever what
// comes out of stripImage changes.
//   1 — the first pass: every metadata segment deleted
//   2 — orientation put back, so portrait photos are not on their side
//   3 — GIFs cleaned too, and a file with nothing to take out still
//       gets its copy
// Bytes as callers hold them.
export type Bytes = Uint8Array | ArrayBuffer | ArrayLike<number>;

// A stretch of the original to copy, [start, end), or bytes to put in
// its place.
export type Keep = [number, number] | Uint8Array;

// One of a PNG's text chunks, kept as it came.
export interface PngText {
  type: string;
  data: Uint8Array;
}

// What a cutter worked out: what to keep, what came out, and the
// metadata it held (the EXIF, the XMP packet, a PNG's text chunks), the
// orientation put back, and for a JPEG whether its picture data was
// reached.
export interface Cut {
  keep: Keep[];
  removed: string[];
  exif: Uint8Array | null;
  xmp?: Uint8Array | null;
  texts?: PngText[];
  orientation: number;
  scan?: boolean;
}

// stripImage's answer.
export interface Stripped {
  bytes: Uint8Array;
  exif: Uint8Array | null;
  xmp?: Uint8Array | null;
  texts?: PngText[];
  removed: string[];
  orientation: number;
  changed: boolean;
  parsed: boolean;
}

// What a photo's metadata block says (readExif); the dashboard's
// details panel and an album showing details read it.
export interface ExifFacts {
  has_exif: boolean;
  taken_at: string;
  modified_at: string;
  gps: { lat: number; lng: number; alt?: number } | null;
  make: string;
  model: string;
  software: string;
  lens: string;
  maker_note: boolean;
  signals: string[];
  verdict: string;
  offset: string;
  exposure: number;
  fnumber: number;
  iso: number;
  focal: number;
  focal35: number;
  width: number;
  height: number;
}

interface Reader {
  u16(at: number): number;
  u32(at: number): number;
}

// One directory entry: its type, its count and where its value is.
interface IfdEntry {
  type: number;
  count: number;
  at: number;
}

export var STRIP_VERSION = 3;

// ---------- what may be served, and what can be cleaned ----------

export function baseType(type: unknown): string {
  return String(type || '').toLowerCase().split(';')[0].trim();
}

// The three formats the byte surgery below understands. A GIF used to
// be served as it was on the grounds that it had nowhere to put a
// location, but it carries comments and application blocks, and XMP —
// which can hold anything EXIF can — rides in one of those.
export function strippable(type: unknown): boolean {
  var t = baseType(type);
  return t === 'image/jpeg' || t === 'image/jpg' || t === 'image/png' || t === 'image/gif';
}

// What a file's first bytes say it is, for the picture types anything
// here takes in: 'jpeg', 'png', 'gif', 'webp', 'isobmff' (HEIC, AVIF)
// or ''. The type a browser sends is only what the file's name said.
export function sniffImage(bytes: Bytes | null | undefined): string {
  var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
  if (startsWith(b, 0, PNG_SIG)) return 'png';
  if (startsWith(b, 0, [0x47, 0x49, 0x46, 0x38])) return 'gif';           // GIF8
  if (startsWith(b, 0, [0x52, 0x49, 0x46, 0x46]) && startsWith(b, 8, [0x57, 0x45, 0x42, 0x50])) return 'webp'; // RIFF....WEBP
  if (startsWith(b, 4, [0x66, 0x74, 0x79, 0x70])) return 'isobmff';       // ....ftyp
  return '';
}

// The image types whose bytes are what the type says they are.
var SNIFFED: Record<string, string> = {
  'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/heic': 'isobmff', 'image/heif': 'isobmff', 'image/avif': 'isobmff'
};
export function imageMatches(type: unknown, bytes: Bytes | null | undefined): boolean {
  var want = SNIFFED[baseType(type)];
  return !!want && sniffImage(bytes) === want;
}

// The file a page turned into a JPEG, kept beside it (submit.ts,
// storePicked): a HEIC, a HEIF or a WebP, read more closely than
// imageMatches reads one, since `....ftyp` alone also starts every MP4.
// A HEIF names its brands in that first box: the major brand at byte
// 8, a version at 12, then the brands it is compatible with up to the
// box's own length. One of them has to be a HEIF image or sequence
// brand. Wants the first 64 bytes.
var HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'hevm', 'hevs', 'mif1', 'mif2', 'msf1'];
export function pickedMatches(type: unknown, bytes: Bytes | null | undefined): boolean {
  var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  var t = baseType(type);
  if (t === 'image/webp') return sniffImage(b) === 'webp';
  if (t !== 'image/heic' && t !== 'image/heif') return false;
  if (!startsWith(b, 4, [0x66, 0x74, 0x79, 0x70])) return false;
  var end = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0);
  for (var at = 8; at + 4 <= end; at += 4) {
    if (at === 12) continue;
    if (HEIF_BRANDS.indexOf(String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])) !== -1) return true;
  }
  return false;
}

// ---------- JPEG ----------
// FFD8 starts the file, then segments: FF, a marker byte, two bytes of
// length, the payload. A few markers stand alone with no length at
// all. FFDA (start of scan) is followed by the compressed image data,
// which is not length-prefixed, so once it is reached the rest of the
// file is copied as it stands.

var JPEG_DROP: Record<number, string> = {
  0xE1: 'APP1',   // EXIF and XMP — where the location and the camera live
  0xED: 'APP13',  // IPTC / Photoshop
  0xFE: 'COM'     // a free-text comment, which can hold anything
};
// APP0 (JFIF), APP2 (the colour profile) and APP14 (Adobe's colour
// transform) all change how the picture decodes, so they stay.

var EXIF_MAGIC = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
// what an XMP segment opens with, before its NUL and the packet
var XMP_NS = [104, 116, 116, 112, 58, 47, 47, 110, 115, 46, 97, 100, 111, 98, 101, 46, 99, 111, 109,
  47, 120, 97, 112, 47, 49, 46, 48, 47]; // "http://ns.adobe.com/xap/1.0/"

function startsWith(bytes: ArrayLike<number>, at: number, magic: ArrayLike<number>): boolean {
  if (at + magic.length > bytes.length) return false;
  for (var i = 0; i < magic.length; i++) {
    if (bytes[at + i] !== magic[i]) return false;
  }
  return true;
}

// ---------- the one tag that has to survive ----------
// A phone does not rotate the pixels when you turn it. It writes the
// picture the way the sensor read it and records which way up the
// phone was in EXIF tag 0x0112, and every browser turns the picture to
// match. Take the tag away and a portrait photo renders on its side —
// which is what happened when the whole EXIF block went.
//
// Orientation is a number from 1 to 8. It says nothing about who, when
// or where, so keeping it gives nothing away: the block is rebuilt
// from scratch with that one tag in it and nothing else, rather than
// any of the original being kept.
//
// Nothing else in EXIF changes what is on the screen. The colour
// profile that does is in APP2, which is never removed. Resolution
// tags only set the size on paper.
function orientationOf(exifBytes: Uint8Array | null): number {
  if (!exifBytes || exifBytes.length < 14) return 0;
  var base = startsWith(exifBytes, 0, EXIF_MAGIC) ? 6 : 0;
  if (base + 8 > exifBytes.length) return 0;
  var order = String.fromCharCode(exifBytes[base], exifBytes[base + 1]);
  if (order !== 'II' && order !== 'MM') return 0;
  var r = reader(exifBytes, order === 'II');
  if (r.u16(base + 2) !== 42) return 0;
  var ifd0 = readIfd(exifBytes, r, base, base + r.u32(base + 4));
  var entry = ifd0[0x0112];
  if (!entry || entry.type !== 3) return 0;
  var value = r.u16(entry.at);
  return value >= 1 && value <= 8 ? value : 0;
}

// The smallest valid EXIF segment there is: the marker, a length, the
// magic, a little-endian TIFF header, one directory holding one tag,
// and the end of the chain. 34 bytes all told.
function orientationSegment(value: number): Uint8Array {
  var payload = ([] as number[]).concat(
    EXIF_MAGIC,
    [0x49, 0x49, 42, 0, 8, 0, 0, 0],          // "II", 42, IFD0 at offset 8
    [1, 0],                                    // one entry
    [0x12, 0x01, 3, 0, 1, 0, 0, 0, value & 255, (value >> 8) & 255, 0, 0],
    [0, 0, 0, 0]                               // no directory after this one
  );
  var len = payload.length + 2;
  return new Uint8Array([0xFF, 0xE1, (len >> 8) & 255, len & 255].concat(payload));
}

function stripJpeg(bytes: Uint8Array): Cut | null {
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return null;
  // each entry is either [start, end) of the original to copy, or a
  // run of bytes to put in its place
  var keep: Keep[] = [];
  var removed: string[] = [];
  var exif: Uint8Array | null = null;
  var xmp: Uint8Array | null = null;
  var orientation = 0;
  var scan = false;   // whether the picture data was reached
  var runFrom = 0;    // the start of the stretch being kept
  var i = 2;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xFF) return null; // not where a marker should be
    // fill bytes: any number of FFs may pad the gap before a marker
    var j = i;
    while (j + 1 < bytes.length && bytes[j + 1] === 0xFF) j++;
    var marker = bytes[j + 1];
    if (marker === 0xD9 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) {
      i = j + 2;                       // stands alone, no length
      if (marker === 0xD9) break;      // end of image
      continue;
    }
    if (j + 3 >= bytes.length) break;
    var len = (bytes[j + 2] << 8) | bytes[j + 3];
    if (len < 2) return null;
    var end = j + 2 + len;
    if (end > bytes.length) return null;
    if (marker === 0xDA) { scan = true; break; } // the scan: everything after it is image data
    var name = JPEG_DROP[marker];
    if (name) {
      keep.push([runFrom, j]);
      if (marker === 0xE1 && startsWith(bytes, j + 4, EXIF_MAGIC)) {
        name = 'EXIF';
        exif = bytes.slice(j + 4, end);   // the block itself, magic included
        // put back a block holding only which way up the phone was
        var turn = orientationOf(exif);
        if (turn > 1) {
          keep.push(orientationSegment(turn));
          orientation = turn;
        }
      } else if (marker === 0xE1) {
        name = 'XMP';
        if (!xmp && startsWith(bytes, j + 4, XMP_NS)) {
          var from = j + 4 + XMP_NS.length;
          if (bytes[from] === 0) from++;
          xmp = bytes.slice(from, end);
        }
      }
      removed.push(name);
      runFrom = end;
    }
    i = end;
  }
  keep.push([runFrom, bytes.length]);
  return { keep: keep, removed: removed, exif: exif, xmp: xmp, orientation: orientation, scan: scan };
}

// Which way up a JPEG says it is (1-8), from its first bytes: the
// segments before the picture data, which is all this reads. 0 when it
// says nothing or cannot be read.
export function jpegOrientation(bytes: Uint8Array): number {
  var parsed: Cut | null = null;
  try { parsed = stripJpeg(bytes); } catch (err) { parsed = null; }
  return parsed ? parsed.orientation : 0;
}

// ---------- PNG ----------
// Eight signature bytes, then chunks: four bytes of length, four of
// type, the data, four of checksum. Nothing refers to a position in
// the file, so a chunk can be dropped whole.

var PNG_SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
var PNG_DROP: Record<string, number> = { tEXt: 1, zTXt: 1, iTXt: 1, eXIf: 1, tIME: 1 };
// A PNG's EXIF is not always in its eXIf chunk. ImageMagick and GIMP
// write it as hex in a text chunk ("Raw profile type exif"), and Apple's
// screenshots, Photoshop and Lightroom write XMP in an iTXt chunk. The
// text chunks are kept as they come (up to this much) and read by
// metaBlockOf, which can inflate the compressed ones.
var PNG_TEXT: Record<string, number> = { tEXt: 1, zTXt: 1, iTXt: 1 };
var PNG_TEXT_MAX = 1024 * 1024;

function stripPng(bytes: Uint8Array): Cut | null {
  if (!startsWith(bytes, 0, PNG_SIG)) return null;
  var keep: Keep[] = [];
  var removed: string[] = [];
  var exif: Uint8Array | null = null;
  var texts: PngText[] = [];
  var runFrom = 0;
  var i = 8;
  while (i + 8 <= bytes.length) {
    var len = (bytes[i] * 16777216) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
    if (len < 0 || i + 12 + len > bytes.length) break;
    var type = String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);
    var end = i + 12 + len;
    if (PNG_DROP[type]) {
      if (type === 'eXIf' && !exif) exif = bytes.slice(i + 8, i + 8 + len);
      if (PNG_TEXT[type] && len <= PNG_TEXT_MAX) texts.push({ type: type, data: bytes.slice(i + 8, i + 8 + len) });
      keep.push([runFrom, i]);
      removed.push(type);
      runFrom = end;
    }
    i = end;
    if (type === 'IEND') break;
  }
  keep.push([runFrom, bytes.length]);
  return { keep: keep, removed: removed, exif: exif, texts: texts, orientation: 0 };
}

// ---------- GIF ----------
// Six bytes of signature, the screen descriptor and its colour table,
// then blocks: 0x2C a frame (descriptor, colour table, then data in
// sub-blocks), 0x21 an extension (a label, then sub-blocks), 0x3B the
// end. A sub-block is a length byte and that many bytes; a zero length
// ends the run. Nothing refers to a position in the file, so a block
// can be dropped whole.
//
// What goes: comments (0xFE), plain text (0x01, which no browser draws)
// and every application block except the two that say how many times
// to loop — XMP rides in an application block, and so can anything
// else. Graphic control (0xF9), which times the frames, stays. So does
// the colour profile's block, which changes how the picture looks.
//
// The XMP block ("XMP DataXMP") is the packet written straight in, not
// in sub-blocks, followed by 258 bytes that make a reader skipping
// sub-blocks land on the end; its bytes are kept (up to PNG_TEXT_MAX)
// for the block beside the copy, where the packet is found by its tags.
var GIF_KEEP_APP: Record<string, number> = { 'NETSCAPE2.0': 1, 'ANIMEXTS1.0': 1, 'ICCRGBG1012': 1 };

function skipSubBlocks(bytes: Uint8Array, i: number): number {
  while (i < bytes.length) {
    var n = bytes[i];
    if (n === 0) return i + 1;
    i += 1 + n;
  }
  return -1;
}

function stripGif(bytes: Uint8Array): Cut | null {
  if (bytes.length < 13 || !startsWith(bytes, 0, [0x47, 0x49, 0x46, 0x38])) return null;
  var i = 13;
  var packed = bytes[10];
  if (packed & 0x80) i += 3 * (1 << ((packed & 7) + 1));
  var keep: Keep[] = [];
  var removed: string[] = [];
  var xmp: Uint8Array | null = null;
  var runFrom = 0;
  while (i < bytes.length) {
    var block = bytes[i];
    if (block === 0x3B) {                  // the end: nothing after it is the picture
      keep.push([runFrom, i + 1]);
      if (i + 1 < bytes.length) removed.push('trailing');
      return { keep: keep, removed: removed, exif: null, xmp: xmp, orientation: 0 };
    }
    var end: number;
    if (block === 0x2C) {
      if (i + 10 > bytes.length) return null;
      var lp = bytes[i + 9];
      var at = i + 10 + ((lp & 0x80) ? 3 * (1 << ((lp & 7) + 1)) : 0) + 1; // + the LZW code size
      end = skipSubBlocks(bytes, at);
      if (end < 0) return null;
    } else if (block === 0x21) {
      if (i + 2 > bytes.length) return null;
      var label = bytes[i + 1];
      end = skipSubBlocks(bytes, i + 2);
      if (end < 0) return null;
      var drop = label === 0xFE ? 'comment' : label === 0x01 ? 'text' : '';
      if (label === 0xFF) {
        var id = bytes[i + 2] === 11 ? String.fromCharCode(...bytes.subarray(i + 3, i + 14)) : '';
        if (!GIF_KEEP_APP[id]) drop = id.indexOf('XMP') === 0 ? 'XMP' : 'application';
        if (id === 'XMP DataXMP' && !xmp && end - (i + 14) <= PNG_TEXT_MAX) xmp = bytes.slice(i + 14, end);
      }
      if (drop) {
        keep.push([runFrom, i]);
        removed.push(drop);
        runFrom = end;
      }
    } else {
      return null;                          // not a block a GIF has
    }
    i = end;
  }
  return null;                              // ran out before the end marker
}

// ---------- the one entry point ----------

function join(bytes: Uint8Array, keep: Keep[]): Uint8Array {
  var parts: Uint8Array[] = [];
  var total = 0;
  for (var i = 0; i < keep.length; i++) {
    var piece = keep[i];
    var part = piece instanceof Uint8Array
      ? piece
      : bytes.subarray(piece[0], piece[1]);
    parts.push(part);
    total += part.length;
  }
  var out = new Uint8Array(total);
  var at = 0;
  for (var k = 0; k < parts.length; k++) {
    out.set(parts[k], at);
    at += parts[k].length;
  }
  return out;
}

// Returns the picture with its metadata removed, the metadata on its
// own, and what was taken out. `parsed` says the file was read through
// as what it claims to be, so `bytes` is safe to serve; `changed` says
// something came out. A file read through with nothing to take out is
// parsed and unchanged, and its bytes are what is served. A file this
// cannot read is neither, and `bytes` is the input, untouched — it is
// never guessed at, because a half-understood JPEG is not thereby one
// with nothing in it.
export function stripImage(bytes: Uint8Array | ArrayBuffer, type: unknown): Stripped {
  var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  var t = baseType(type);
  var found: Cut | null = null;
  if (t === 'image/jpeg' || t === 'image/jpg') found = stripJpeg(input);
  else if (t === 'image/png') found = stripPng(input);
  else if (t === 'image/gif') found = stripGif(input);
  if (!found || !found.removed.length) {
    return { bytes: input, exif: null, removed: [], orientation: 0, changed: false, parsed: !!found };
  }
  return {
    bytes: join(input, found.keep),
    exif: found.exif,
    xmp: found.xmp || null,
    texts: found.texts || [],
    removed: found.removed,
    orientation: found.orientation || 0,
    changed: true,
    parsed: true
  };
}

// ---------- a picture too big to hold ----------
// The same cut as stripImage, worked out without the whole file in
// memory, for a picture larger than a worker should read in one go.
// What comes out is the same list of stretches to keep; keepStream then
// copies those stretches as the original streams past.

// A JPEG's metadata all sits before the picture data, so its first
// bytes are enough: `head` is the start of a file `total` bytes long.
// Null when the head ends before the picture data starts, or the file
// cannot be read.
export function planJpegHead(head: Uint8Array, total: number): Cut | null {
  var found: Cut | null = null;
  try { found = stripJpeg(head); } catch (err) { found = null; }
  if (!found || !found.scan) return null;
  var last = found.keep[found.keep.length - 1] as [number, number];
  last[1] = total;
  return found;
}

// The cut for a whole file held in memory, the same list stripImage
// joins: null when the file cannot be read as its type.
export function planWhole(bytes: Uint8Array | ArrayBuffer, type: unknown): Cut | null {
  var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  var t = baseType(type);
  try {
    if (t === 'image/jpeg' || t === 'image/jpg') return stripJpeg(input);
    if (t === 'image/png') return stripPng(input);
    if (t === 'image/gif') return stripGif(input);
  } catch (err) { /* not readable as its type */ }
  return null;
}

// A PNG can carry text after its picture data, so every chunk is
// looked at: push() each piece of the file in order, then finish()
// with its length. Only the eight-byte chunk headers are read; the
// data is skipped over, except an eXIf chunk's and the text chunks',
// which are what the block beside the copy is made from.
export function pngWalker(): { push(piece: Uint8Array): void; finish(total: number): Cut | null } {
  var pos = 0;
  var next = 8;                 // where the next chunk starts
  var sig: number[] = [];
  var hdr = new Uint8Array(8);
  var have = 0;                 // bytes of the current header so far
  var keep: Keep[] = [];
  var removed: string[] = [];
  var grabs: { type: string; at: number; data: Uint8Array }[] = [];  // the chunks whose data is kept
  var grab: { type: string; at: number; data: Uint8Array } | null = null;              // the one being filled
  var held = 0;
  var runFrom = 0;
  var ended = false;
  var bad = false;
  return {
    push: function (piece: Uint8Array) {
      var start = pos;
      pos += piece.length;
      var i = 0;
      while (sig.length < 8 && i < piece.length) sig.push(piece[i++]);
      if (sig.length === 8 && !startsWith(sig, 0, PNG_SIG)) bad = true;
      while (i < piece.length && !ended && !bad) {
        var abs = start + i;
        if (grab && abs >= grab.at && abs < grab.at + grab.data.length) {
          var n = Math.min(grab.at + grab.data.length - abs, piece.length - i);
          grab.data.set(piece.subarray(i, i + n), abs - grab.at);
          i += n;
          continue;
        }
        if (abs < next) { i = Math.min(piece.length, next - start); continue; }
        hdr[have++] = piece[i++];
        if (have < 8) continue;
        have = 0;
        var len = (hdr[0] * 16777216) + (hdr[1] << 16) + (hdr[2] << 8) + hdr[3];
        var type = String.fromCharCode(hdr[4], hdr[5], hdr[6], hdr[7]);
        var end = next + 12 + len;
        grab = null;
        if (PNG_DROP[type]) {
          keep.push([runFrom, next]);
          removed.push(type);
          runFrom = end;
          if ((type === 'eXIf' || PNG_TEXT[type]) && len <= PNG_TEXT_MAX && held + len <= 4 * PNG_TEXT_MAX) {
            grab = { type: type, at: next + 8, data: new Uint8Array(len) };
            grabs.push(grab);
            held += len;
          }
        }
        next = end;
        if (type === 'IEND') ended = true;
      }
    },
    finish: function (total: number) {
      if (bad || sig.length < 8 || runFrom > total) return null;
      keep.push([runFrom, total]);
      var exif: Uint8Array | null = null;
      var texts: PngText[] = [];
      grabs.forEach(function (g) {
        if (g.type === 'eXIf') { if (!exif) exif = g.data; } else texts.push({ type: g.type, data: g.data });
      });
      return { keep: keep, removed: removed, exif: exif, texts: texts, orientation: 0 };
    }
  };
}

// ---------- the block kept beside the copy ----------
// What a picture says about itself, as one block: its EXIF as it was
// (TIFF, "Exif\0\0" first or not), then its XMP packet if it had one.
// readExif reads the TIFF from the start and looks for the packet
// anywhere, so a block holding only one of the two reads as before.
// `found` is what the cutter answered: exif, xmp (a JPEG's or a GIF's)
// and texts (a PNG's text chunks). Async because a compressed chunk has
// to be inflated.
//
// A PNG's text chunks are read for: its EXIF as a hex profile ("Raw
// profile type exif", or "APP1", which ImageMagick also uses for XMP),
// its XMP as Adobe writes it or as a hex profile, and the PNG
// standard's "Creation Time", which goes in as an XMP packet of its own
// when the picture has no other.
export async function metaBlockOf(found: Pick<Cut, 'exif' | 'xmp' | 'texts'> | null | undefined): Promise<Uint8Array> {
  if (!found) return new Uint8Array(0);
  var exif = found.exif || null;
  var xmp = found.xmp || null;
  var created = '';
  var texts = found.texts || [];
  for (var i = 0; i < texts.length; i++) {
    var t = await pngText(texts[i]);
    if (!t) continue;
    if (/^Raw profile type (exif|APP1)$/i.test(t.keyword)) {
      var raw = rawProfile(t.bytes);
      if (!exif && asExif(raw)) exif = raw;
      else if (!xmp && raw && xmpPacket(raw)) xmp = raw;
    } else if (!xmp && t.keyword === 'XML:com.adobe.xmp') {
      xmp = t.bytes;
    } else if (!xmp && /^Raw profile type xmp$/i.test(t.keyword)) {
      xmp = rawProfile(t.bytes);
    } else if (!created && t.keyword === 'Creation Time') {
      created = creationTime(new TextDecoder().decode(t.bytes));
    }
  }
  if (!xmp && created) xmp = xmpOf({ 'xmp:CreateDate': created });
  if (!exif && !xmp) return new Uint8Array(0);
  if (!xmp) return exif as Uint8Array;
  if (!exif) return xmp;
  var out = new Uint8Array(exif.length + xmp.length);
  out.set(exif, 0);
  out.set(xmp, exif.length);
  return out;
}

// An XMP packet holding the facts given, as {name: text}, for a file
// whose metadata is neither EXIF nor XMP of its own: a video's, or a
// PNG's Creation Time. readXmp reads it like any other packet.
export function xmpOf(facts: Record<string, unknown>): Uint8Array {
  var attrs = '';
  Object.keys(facts).forEach(function (name) {
    var v = facts[name];
    if (v === '' || v == null) return;
    attrs += ' ' + name + '="' + String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') + '"';
  });
  if (!attrs) return new Uint8Array(0);
  return new TextEncoder().encode('<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" ' +
    'xmlns:exif="http://ns.adobe.com/exif/1.0/"' + attrs + '/></rdf:RDF></x:xmpmeta>');
}

var MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function pad2(n: number): string { return (n < 10 ? '0' : '') + n; }

// A time as the PNG standard's Creation Time or a video's creation date
// write it, as XMP writes one ("2026-10-21T09:14:02+11:00"), or '' when
// it does not say the time of day. Read: ISO 8601, with or without its
// punctuation; the EXIF form "2026:10:21 09:14:02"; and the e-mail form
// "Tue, 21 Oct 2026 09:14:02 +1100" that the PNG standard suggests.
export function creationTime(text: unknown): string {
  var s = String(text || '').trim();
  var m = s.match(/^(\d{4})[-:]?(\d{2})[-:]?(\d{2})[T ](\d{2}):?(\d{2})(?::?(\d{2}))?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2}|GMT|UTC)?$/i);
  var date: string[];
  var zone: string;
  if (m) {
    date = [m[1], m[2], m[3], m[4], m[5], m[6] || '00'];
    zone = m[7] || '';
  } else {
    m = s.match(/^(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?\s*(Z|[+-]\d{2}:?\d{2}|GMT|UTC)?$/);
    if (!m || !MONTHS[m[2].toLowerCase()]) return '';
    date = [m[3], pad2(MONTHS[m[2].toLowerCase()]), pad2(Number(m[1])), m[4], m[5], m[6] || '00'];
    zone = m[7] || '';
  }
  if (/^(Z|GMT|UTC)$/i.test(zone)) zone = 'Z';
  else if (zone.length === 5) zone = zone.slice(0, 3) + ':' + zone.slice(3);
  var out = date[0] + '-' + date[1] + '-' + date[2] + 'T' + date[3] + ':' + date[4] + ':' + date[5] + zone;
  return xmpStamp(out) ? out : '';
}

// One text chunk as {keyword, bytes}: tEXt is a keyword, a NUL and the
// text; zTXt adds a compression byte and is always compressed; iTXt adds
// a compression flag and method, a language and a translated keyword,
// each ended by a NUL. Null for one that cannot be read.
async function pngText(chunk: PngText): Promise<{ keyword: string; bytes: Uint8Array } | null> {
  var d = chunk.data;
  var nul = d.indexOf(0);
  if (nul < 1 || nul > 79) return null;
  var keyword = String.fromCharCode(...d.subarray(0, nul));
  var at = nul + 1;
  var compressed = false;
  if (chunk.type === 'zTXt') {
    compressed = true;
    at += 1;
  } else if (chunk.type === 'iTXt') {
    compressed = d[at] === 1;
    at += 2;
    for (var skip = 0; skip < 2; skip++) {
      var stop = d.indexOf(0, at);
      if (stop < 0) return null;
      at = stop + 1;
    }
  }
  if (at > d.length) return null;
  var body: Uint8Array | null = d.subarray(at);
  if (compressed) body = await inflate(body);
  return body ? { keyword: keyword, bytes: body } : null;
}

// zlib data inflated, no more than 4MB of it; null when it will not
async function inflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream !== 'function') return null;
  try {
    var reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
    var parts: Uint8Array[] = [];
    var total = 0;
    for (;;) {
      var piece = await reader.read();
      if (piece.done) break;
      total += piece.value.length;
      if (total > 4 * PNG_TEXT_MAX) { try { await reader.cancel(); } catch (e) { /* gone */ } return null; }
      parts.push(piece.value);
    }
    var out = new Uint8Array(total);
    var off = 0;
    parts.forEach(function (p) { out.set(p, off); off += p.length; });
    return out;
  } catch (err) {
    return null;
  }
}

// "Raw profile type exif": a newline, the profile's name, a newline, its
// length in decimal, a newline, then the bytes in hex over many lines.
// Null when there is not enough of it to be anything.
function rawProfile(bytes: Uint8Array): Uint8Array | null {
  var text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4 * PNG_TEXT_MAX)));
  var m = text.match(/^\s*[A-Za-z0-9]+\s*\n\s*(\d+)\s*\n([\s\S]*)$/);
  if (!m) return null;
  var hex = m[2].replace(/[^0-9a-fA-F]/g, '');
  var n = Math.min(Number(m[1]), Math.floor(hex.length / 2));
  if (!(n > 8)) return null;
  var out = new Uint8Array(n);
  for (var i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
// whether bytes start as EXIF does, "Exif\0\0" first or not
function asExif(bytes: Uint8Array | null): boolean {
  if (!bytes) return false;
  var base = startsWith(bytes, 0, EXIF_MAGIC) ? 6 : 0;
  if (base + 2 > bytes.length) return false;
  var order = String.fromCharCode(bytes[base], bytes[base + 1]);
  return order === 'II' || order === 'MM';
}

// How long the copy made from a keep list comes out.
export function keepLength(keep: Keep[]): number {
  var n = 0;
  for (var i = 0; i < keep.length; i++) { var part = keep[i]; n += part instanceof Uint8Array ? part.length : part[1] - part[0]; }
  return n;
}

// A stream that lets through only the kept stretches of what is piped
// into it, with any bytes the list puts in their place.
export function keepStream(keep: Keep[]): TransformStream<Uint8Array, Uint8Array> {
  var pos = 0;
  var k = 0;
  return new TransformStream<Uint8Array, Uint8Array>({
    transform: function (piece, out) {
      var start = pos;
      var end = pos + piece.length;
      pos = end;
      while (k < keep.length) {
        var part = keep[k];
        if (part instanceof Uint8Array) { out.enqueue(part); k++; continue; }
        if (part[0] >= end) break;
        var a = Math.max(part[0], start);
        var b = Math.min(part[1], end);
        if (b > a) out.enqueue(piece.subarray(a - start, b - start));
        if (part[1] > end) break;
        k++;
      }
    },
    flush: function (out) {
      for (; k < keep.length; k++) { var part = keep[k]; if (part instanceof Uint8Array) out.enqueue(part); }
    }
  });
}

// ---------- reading what was taken out ----------
// EXIF is a TIFF file in miniature: two bytes saying which way round
// the numbers are, then a chain of directories, each a list of tagged
// entries. Only the handful of tags that answer "where, when, on what,
// and has it been touched since" are read here.

function reader(bytes: Uint8Array, little: boolean): Reader {
  return {
    u16: function (at: number) {
      return little ? bytes[at] | (bytes[at + 1] << 8) : (bytes[at] << 8) | bytes[at + 1];
    },
    u32: function (at: number) {
      return little
        ? (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) + (bytes[at + 3] * 16777216)
        : (bytes[at] * 16777216) + ((bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]);
    }
  };
}

var TYPE_SIZE: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };

// One directory's entries as {tag: {type, count, at}}; `at` points at
// the value, wherever it ended up — inline when it fits in four bytes,
// somewhere else in the block when it does not.
function readIfd(bytes: Uint8Array, r: Reader, base: number, at: number): Record<number, IfdEntry> {
  var out: Record<number, IfdEntry> = {};
  if (at + 2 > bytes.length) return out;
  var count = r.u16(at);
  var p = at + 2;
  for (var i = 0; i < count && p + 12 <= bytes.length; i++, p += 12) {
    var tag = r.u16(p);
    var type = r.u16(p + 2);
    var n = r.u32(p + 4);
    var size = (TYPE_SIZE[type] || 0) * n;
    var valueAt = size > 4 ? base + r.u32(p + 8) : p + 8;
    if (valueAt < 0 || valueAt > bytes.length) continue;
    out[tag] = { type: type, count: n, at: valueAt };
  }
  return out;
}

function readText(bytes: Uint8Array, entry: IfdEntry | undefined): string {
  if (!entry || (entry.type !== 2 && entry.type !== 7)) return '';
  var end = Math.min(bytes.length, entry.at + entry.count);
  var text = '';
  for (var i = entry.at; i < end; i++) {
    if (bytes[i] === 0) break;
    text += String.fromCharCode(bytes[i]);
  }
  return text.trim();
}

function readRational(bytes: Uint8Array, r: Reader, entry: IfdEntry | undefined, index: number): number | null {
  if (!entry || entry.type !== 5) return null;
  var at = entry.at + index * 8;
  if (at + 8 > bytes.length) return null;
  var den = r.u32(at + 4);
  if (!den) return null;
  return r.u32(at) / den;
}

// Degrees, minutes and seconds as three rationals, with a letter
// saying which side of the equator or the meridian.
function readCoord(bytes: Uint8Array, r: Reader, entry: IfdEntry | undefined, refEntry: IfdEntry | undefined): number | null {
  if (!entry || entry.count < 3) return null;
  var d = readRational(bytes, r, entry, 0);
  var m = readRational(bytes, r, entry, 1);
  var s = readRational(bytes, r, entry, 2);
  if (d === null) return null;
  var value = d + (m || 0) / 60 + (s || 0) / 3600;
  var ref = readText(bytes, refEntry).toUpperCase();
  if (ref === 'S' || ref === 'W') value = -value;
  return Math.round(value * 1000000) / 1000000;
}

// "2026:10:20 09:14:02" is EXIF's own shape; the rest of the system
// stores UTC as "YYYY-MM-DD HH:MM:SS", so it is written that way here
// too. The camera's clock is local time, and the zone it was in, when
// the phone wrote one, is a separate tag (`offset`); takenUtc puts the
// two together.
function readStampField(bytes: Uint8Array, entry: IfdEntry | undefined): string {
  var raw = readText(bytes, entry);
  var m = raw.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  return m && Number(m[1]) >= 1990 ? m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] : '';
}

// A count or a size: a short or a long, whichever the camera wrote.
function readCount(r: Reader, entry: IfdEntry | undefined): number {
  if (!entry) return 0;
  if (entry.type === 3) return r.u16(entry.at);
  if (entry.type === 4) return r.u32(entry.at);
  return 0;
}

function rounded(value: number | null, places: number): number {
  if (value === null || !isFinite(value) || value <= 0) return 0;
  var k = Math.pow(10, places);
  return Math.round(value * k) / k;
}

// How far a zone is ahead of UTC at a moment, in milliseconds.
function zoneAhead(ms: number, zone: string): number {
  var parts: Record<string, number> = {};
  new Intl.DateTimeFormat('en-AU', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(new Date(ms)).forEach(function (p) { parts[p.type] = Number(p.value); });
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second) - ms;
}

// When a photo was taken, in UTC as the system stores it: the camera's
// clock moved by the zone the phone wrote beside it, or by Sydney's
// when it wrote none, since that is where the day is. '' when the photo
// does not say.
export function takenUtc(meta: { taken_at?: string; offset?: string } | null | undefined): string {
  var m = String((meta && meta.taken_at) || '').match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return '';
  var wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  var off = String((meta && meta.offset) || '').match(/^([+-])(\d{2}):(\d{2})$/);
  var at: number;
  if (off) {
    at = wall - (off[1] === '-' ? -1 : 1) * (Number(off[2]) * 60 + Number(off[3])) * 60000;
  } else {
    try {
      var first = zoneAhead(wall, 'Australia/Sydney');
      at = wall - first;
      var second = zoneAhead(at, 'Australia/Sydney');
      if (second !== first) at = wall - second;
    } catch (err) {
      at = wall - 10 * 3600000;
    }
  }
  if (!isFinite(at)) return '';
  return new Date(at).toISOString().slice(0, 19).replace('T', ' ');
}

// The block kept beside a photo (metaBlockOf): its EXIF, its XMP, or
// the two one after the other. What the EXIF does not say, the XMP may.
export function readExif(block: Uint8Array | null | undefined): ExifFacts {
  var out: ExifFacts = {
    has_exif: false,
    taken_at: '',
    modified_at: '',
    gps: null,
    make: '',
    model: '',
    software: '',
    lens: '',
    maker_note: false,
    signals: [],
    verdict: 'no camera data',
    // the zone the clock was in, the exposure in seconds, the aperture,
    // ISO, the focal length in mm and its 35mm equivalent, and the size
    // the camera recorded
    offset: '',
    exposure: 0,
    fnumber: 0,
    iso: 0,
    focal: 0,
    focal35: 0,
    width: 0,
    height: 0
  };
  if (!block || !block.length) return out;
  var bytes = block instanceof Uint8Array ? block : new Uint8Array(block);
  var tiff = readTiff(bytes, out);
  var xmp = readXmp(bytes, out);
  if (!tiff && !xmp) return out;
  out.has_exif = true;
  judge(out, tiff);
  return out;
}

// The EXIF at the start of the block into `out`; false when the block
// does not start with one. A JPEG's opens with "Exif\0\0"; a PNG's
// eXIf chunk does not.
function readTiff(bytes: Uint8Array, out: ExifFacts): boolean {
  var base = startsWith(bytes, 0, EXIF_MAGIC) ? 6 : 0;
  if (base + 8 > bytes.length) return false;
  var order = String.fromCharCode(bytes[base], bytes[base + 1]);
  if (order !== 'II' && order !== 'MM') return false;
  var r = reader(bytes, order === 'II');
  if (r.u16(base + 2) !== 42) return false;
  var ifd0 = readIfd(bytes, r, base, base + r.u32(base + 4));
  out.modified_at = readStampField(bytes, ifd0[0x0132]);
  out.make = readText(bytes, ifd0[0x010F]);
  out.model = readText(bytes, ifd0[0x0110]);
  out.software = readText(bytes, ifd0[0x0131]);

  if (ifd0[0x8769]) {
    var exifIfd = readIfd(bytes, r, base, base + r.u32(ifd0[0x8769].at));
    out.taken_at = readStampField(bytes, exifIfd[0x9003]);
    out.lens = readText(bytes, exifIfd[0xA434]);
    out.maker_note = !!exifIfd[0x927C];
    if (!out.modified_at) out.modified_at = readStampField(bytes, exifIfd[0x9004]);
    var zone = readText(bytes, exifIfd[0x9011]) || readText(bytes, exifIfd[0x9010]);
    if (/^[+-]\d{2}:\d{2}$/.test(zone)) out.offset = zone;
    out.exposure = rounded(readRational(bytes, r, exifIfd[0x829A], 0), 6);
    out.fnumber = rounded(readRational(bytes, r, exifIfd[0x829D], 0), 2);
    out.iso = readCount(r, exifIfd[0x8827]);
    out.focal = rounded(readRational(bytes, r, exifIfd[0x920A], 0), 2);
    out.focal35 = readCount(r, exifIfd[0xA405]);
    out.width = readCount(r, exifIfd[0xA002]);
    out.height = readCount(r, exifIfd[0xA003]);
  }
  if (ifd0[0x8825]) {
    var gpsIfd = readIfd(bytes, r, base, base + r.u32(ifd0[0x8825].at));
    var lat = readCoord(bytes, r, gpsIfd[0x0002], gpsIfd[0x0001]);
    var lng = readCoord(bytes, r, gpsIfd[0x0004], gpsIfd[0x0003]);
    if (lat !== null && lng !== null) {
      out.gps = { lat: lat, lng: lng };
      // metres above sea level; a ref of 1 says below it
      var alt = readRational(bytes, r, gpsIfd[0x0006], 0);
      if (alt !== null && isFinite(alt)) {
        var below = gpsIfd[0x0005] && gpsIfd[0x0005].type === 1 && bytes[gpsIfd[0x0005].at] === 1;
        out.gps.alt = Math.round((below ? -alt : alt) * 10) / 10;
      }
    }
  }
  return true;
}

// ---------- XMP ----------
// A packet of RDF/XML. The same facts as EXIF under names like
// exif:DateTimeOriginal and tiff:Model, each written either as an
// attribute or as an element (holding an rdf:Seq or rdf:Alt for a list).
// Read with patterns rather than a parser: a worker has no XML parser,
// and these few names are all that is wanted. Fills only what is still
// empty in `out`; false when there is no packet.
function xmpPacket(bytes: Uint8Array): string {
  var text = new TextDecoder().decode(bytes);
  var at = text.search(/<x:xmpmeta[\s>]|<rdf:RDF[\s>]/);
  if (at < 0) return '';
  var end = text.indexOf('</x:xmpmeta>', at);
  if (end < 0) end = text.indexOf('</rdf:RDF>', at);
  return end < 0 ? text.slice(at) : text.slice(at, end);
}

function xmlText(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, function (m: string, n: string) { return String.fromCharCode(Number(n)); }).replace(/&amp;/g, '&');
}

function xmpValue(x: string, name: string): string {
  var quoted = name.replace(':', '\\:');
  var attr = x.match(new RegExp('\\s' + quoted + '\\s*=\\s*"([^"]*)"')) || x.match(new RegExp('\\s' + quoted + "\\s*=\\s*'([^']*)'"));
  if (attr) return xmlText(attr[1]).trim();
  var el = x.match(new RegExp('<' + quoted + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + quoted + '>'));
  if (!el) return '';
  var li = el[1].match(/<rdf:li(?:\s[^>]*)?>([\s\S]*?)<\/rdf:li>/);
  return xmlText((li ? li[1] : el[1]).replace(/<[^>]*>/g, '')).trim();
}

// "2026-10-20T09:14:02+11:00" as the wall-clock stamp and the zone, the
// way readStampField and the offset tags give them; a date with no time
// says nothing about when in the day, so it is not taken.
function xmpStamp(value: unknown): { at: string; zone: string } | null {
  var m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m || Number(m[1]) < 1990) return null;
  var zone = '';
  if (m[7] === 'Z') zone = '+00:00';
  else if (m[7]) zone = m[7].length === 5 ? m[7].slice(0, 3) + ':' + m[7].slice(3) : m[7];
  return { at: m[1] + '-' + m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5] + ':' + (m[6] || '00'), zone: zone };
}

// "1/125", "18/10" or "4.2"
function xmpNumber(value: unknown): number | null {
  var m = String(value || '').match(/^\s*(-?\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?\s*$/);
  if (!m) return null;
  var n = m[2] ? Number(m[1]) / Number(m[2]) : Number(m[1]);
  return isFinite(n) ? n : null;
}

// "33,52.3456S" (degrees, then minutes) or "33,52,20.7S", or a plain
// signed number of degrees
function xmpCoord(value: unknown): number | null {
  var s = String(value || '').trim();
  var m = s.match(/^(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:,(\d+(?:\.\d+)?))?([NSEW])$/i);
  var v: number;
  if (m) {
    v = Number(m[1]) + Number(m[2]) / 60 + (m[3] ? Number(m[3]) / 3600 : 0);
    if (/[SW]/i.test(m[4])) v = -v;
  } else if (/^-?\d+(\.\d+)?$/.test(s)) {
    v = Number(s);
  } else {
    return null;
  }
  return isFinite(v) ? Math.round(v * 1000000) / 1000000 : null;
}

function readXmp(bytes: Uint8Array, out: ExifFacts): boolean {
  var x = xmpPacket(bytes);
  if (!x) return false;
  var taken = xmpStamp(xmpValue(x, 'exif:DateTimeOriginal')) || xmpStamp(xmpValue(x, 'photoshop:DateCreated')) ||
    xmpStamp(xmpValue(x, 'xmp:CreateDate'));
  if (!out.taken_at && taken) {
    out.taken_at = taken.at;
    if (!out.offset && taken.zone) out.offset = taken.zone;
  }
  var modified = xmpStamp(xmpValue(x, 'xmp:ModifyDate'));
  if (!out.modified_at && modified) out.modified_at = modified.at;
  if (!out.make) out.make = xmpValue(x, 'tiff:Make');
  if (!out.model) out.model = xmpValue(x, 'tiff:Model');
  if (!out.software) out.software = xmpValue(x, 'xmp:CreatorTool') || xmpValue(x, 'tiff:Software');
  if (!out.lens) out.lens = xmpValue(x, 'exifEX:LensModel') || xmpValue(x, 'aux:Lens');
  if (!out.exposure) out.exposure = rounded(xmpNumber(xmpValue(x, 'exif:ExposureTime')), 6);
  if (!out.fnumber) out.fnumber = rounded(xmpNumber(xmpValue(x, 'exif:FNumber')), 2);
  if (!out.iso) out.iso = Math.round(xmpNumber(xmpValue(x, 'exif:ISOSpeedRatings') || xmpValue(x, 'exifEX:PhotographicSensitivity')) || 0);
  if (!out.focal) out.focal = rounded(xmpNumber(xmpValue(x, 'exif:FocalLength')), 2);
  if (!out.focal35) out.focal35 = Math.round(xmpNumber(xmpValue(x, 'exif:FocalLengthIn35mmFilm')) || 0);
  if (!out.width) out.width = Math.round(xmpNumber(xmpValue(x, 'exif:PixelXDimension') || xmpValue(x, 'tiff:ImageWidth')) || 0);
  if (!out.height) out.height = Math.round(xmpNumber(xmpValue(x, 'exif:PixelYDimension') || xmpValue(x, 'tiff:ImageLength')) || 0);
  if (!out.gps) {
    var lat = xmpCoord(xmpValue(x, 'exif:GPSLatitude'));
    var lng = xmpCoord(xmpValue(x, 'exif:GPSLongitude'));
    if (lat !== null && lng !== null) {
      out.gps = { lat: lat, lng: lng };
      var alt = xmpNumber(xmpValue(x, 'exif:GPSAltitude'));
      if (alt !== null) out.gps.alt = Math.round((xmpValue(x, 'exif:GPSAltitudeRef') === '1' ? -alt : alt) * 10) / 10;
    }
  }
  return true;
}

// What the tags add up to. None of this is proof — anyone who knows to
// strip a file before uploading defeats all of it — but the thing it
// catches is the thing that happens: a screenshot of someone else's
// photo, or a picture off the internet, arrives with no camera data in
// it at all, and that is very visible.
// The maker note is an EXIF tag, so its absence says something only
// where there was EXIF; a video, or a picture with XMP alone, never
// had one.
function judge(out: ExifFacts, tiff: boolean): ExifFacts {
  var camera = !!(out.make && out.model);
  if (camera) out.signals.push('camera: ' + out.make + ' ' + out.model);
  if (out.software) out.signals.push('software: ' + out.software);
  if (camera && tiff && !out.maker_note) out.signals.push('the camera’s own data block is gone, so it has been re-saved');
  if (out.taken_at && out.modified_at && out.modified_at > out.taken_at) {
    out.signals.push('last written ' + out.modified_at + ', taken ' + out.taken_at);
  }
  if (!camera) out.verdict = 'no camera data';
  else if (out.signals.length > 1) out.verdict = 'edited or re-saved';
  else out.verdict = 'camera original';
  return out;
}
