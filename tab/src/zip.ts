// A ZIP of stored files, streamed as it is written: each file read from
// R2 once and sent straight on, nothing compressed (photos and videos
// are compressed already, so deflate would spend CPU to save almost
// nothing), the CRC worked out as the bytes pass. Sizes are known before
// the first byte goes out, so the whole length is known too and the
// download carries a content-length: a stream cut short is a failed
// download in the browser rather than a broken archive that looks done.
//
// Each entry has a data descriptor after its bytes (bit 3), since the CRC
// is only known once they have gone. ZIP64 is used only where a size or
// an offset needs it, so an ordinary album is a plain ZIP that every tool
// opens. Names are UTF-8 (bit 11) and every entry carries the extended
// timestamp field (0x5455) beside its DOS time, so the files come out
// with the time they were taken.

// CRC-32 by slicing eight bytes at a time: about 1GB a second in V8,
// against a third of that a byte at a time.
// A file going into the archive: its name there, its size, when it was
// taken (seconds since the epoch) and its key in the bucket.
export interface ZipEntry {
  name: string;
  size: number;
  mtime?: number;
  key: string;
}

// An entry with its headers worked out (zipPlan); the CRC is filled in
// once its bytes have gone.
interface Planned {
  e: ZipEntry;
  name: Uint8Array;
  big: boolean;
  mtime: number;
  stamp: { time: number; date: number };
  offset: number;
  localSize: number;
  descriptor: number;
  farOffset?: boolean;
  extra64?: number;
  crc?: number;
}

export interface ZipPlan {
  entries: Planned[];
  cdStart: number;
  cdSize: number;
  end64: boolean;
  total: number;
  at64: number;
}

interface Writer {
  u16(v: number): void;
  u32(v: number): void;
  u64(v: number): void;
  bytes(b: ArrayLike<number>): void;
  done(): Uint8Array;
}

var TABLE = (function () {
  var t = new Int32Array(256 * 8);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  for (var m = 0; m < 256; m++) {
    var d = t[m];
    for (var s = 1; s < 8; s++) { d = t[d & 0xff] ^ (d >>> 8); t[s * 256 + m] = d; }
  }
  return t;
})();

export function crc32(crc: number, b: Uint8Array): number {
  var T = TABLE;
  crc = ~crc;
  var i = 0;
  var end = b.length - 8;
  for (; i <= end; i += 8) {
    var a = (b[i] | b[i + 1] << 8 | b[i + 2] << 16 | b[i + 3] << 24) ^ crc;
    crc = T[1792 + (a & 0xff)] ^ T[1536 + ((a >>> 8) & 0xff)] ^ T[1280 + ((a >>> 16) & 0xff)] ^ T[1024 + (a >>> 24)] ^
      T[768 + b[i + 4]] ^ T[512 + b[i + 5]] ^ T[256 + b[i + 6]] ^ T[b[i + 7]];
  }
  for (; i < b.length; i++) crc = T[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}

var MAX32 = 0xFFFFFFFF;
var enc = new TextEncoder();

// A little-endian writer over a fixed-size buffer.
function writer(size: number): Writer {
  var buf = new Uint8Array(size);
  var view = new DataView(buf.buffer);
  var at = 0;
  return {
    u16: function (v: number) { view.setUint16(at, v, true); at += 2; },
    u32: function (v: number) { view.setUint32(at, v >>> 0, true); at += 4; },
    u64: function (v: number) { view.setUint32(at, v % 0x100000000, true); view.setUint32(at + 4, Math.floor(v / 0x100000000), true); at += 8; },
    bytes: function (b: ArrayLike<number>) { buf.set(b, at); at += b.length; },
    done: function () { return buf; }
  };
}

// The date and time as a DOS stamp, in the time zone given: the clock a
// file manager shows the time on. A tool that reads 0x5455 uses the
// exact moment instead.
function dosStamp(seconds: number, zone: string): { time: number; date: number } {
  var parts: Record<string, number> = {};
  try {
    new Intl.DateTimeFormat('en-GB', {
      timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).formatToParts(new Date(seconds * 1000)).forEach(function (p) { parts[p.type] = Number(p.value); });
  } catch (err) {
    var d = new Date(seconds * 1000);
    parts = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
      hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds() };
  }
  var year = Math.min(Math.max(parts.year || 1980, 1980), 2107);
  return {
    time: (parts.hour << 11) | (parts.minute << 5) | Math.floor(parts.second / 2),
    date: ((year - 1980) << 9) | (parts.month << 5) | parts.day
  };
}

// Works out every header from the entries ({name, size, mtime, key}) and
// the total length, before anything is read. `zip64At` is where a size or
// offset goes over to ZIP64; only a test changes it.
export function zipPlan(entries: ZipEntry[], opts?: { zip64At?: number; zone?: string }): ZipPlan {
  opts = opts || {};
  var at64 = opts.zip64At || MAX32;
  var zone = opts.zone || 'UTC';
  var offset = 0;
  var planned = entries.map(function (e) {
    var name = enc.encode(e.name);
    var big = e.size >= at64;
    var mtime = Math.max(0, Math.floor(e.mtime || 0));
    var stamp = dosStamp(mtime, zone);
    var local = 30 + name.length + (big ? 20 : 0) + 9;
    var descriptor = big ? 24 : 16;
    var p: Planned = { e: e, name: name, big: big, mtime: mtime, stamp: stamp, offset: offset, localSize: local, descriptor: descriptor };
    offset += local + e.size + descriptor;
    return p;
  });
  var cdStart = offset;
  var cdSize = 0;
  planned.forEach(function (p) {
    p.farOffset = p.offset >= at64;
    p.extra64 = (p.big ? 16 : 0) + (p.farOffset ? 8 : 0);
    cdSize += 46 + p.name.length + (p.extra64 ? 4 + p.extra64 : 0) + 9;
  });
  var end64 = planned.length > 0xFFFF || cdStart >= at64 || cdSize >= at64;
  var total = cdStart + cdSize + (end64 ? 56 + 20 : 0) + 22;
  return { entries: planned, cdStart: cdStart, cdSize: cdSize, end64: end64, total: total, at64: at64 };
}

function localHeader(p: Planned): Uint8Array {
  var w = writer(p.localSize);
  w.u32(0x04034b50);
  w.u16(p.big ? 45 : 20);
  w.u16(0x0808);                 // data descriptor follows, UTF-8 name
  w.u16(0);                      // stored
  w.u16(p.stamp.time); w.u16(p.stamp.date);
  w.u32(0);                      // CRC, in the descriptor
  w.u32(p.big ? MAX32 : 0); w.u32(p.big ? MAX32 : 0);
  w.u16(p.name.length);
  w.u16((p.big ? 20 : 0) + 9);
  w.bytes(p.name);
  if (p.big) { w.u16(0x0001); w.u16(16); w.u64(0); w.u64(0); }
  w.u16(0x5455); w.u16(5); w.bytes([1]); w.u32(p.mtime);
  return w.done();
}

function descriptor(p: Planned, crc: number): Uint8Array {
  var w = writer(p.descriptor);
  w.u32(0x08074b50);
  w.u32(crc);
  if (p.big) { w.u64(p.e.size); w.u64(p.e.size); } else { w.u32(p.e.size); w.u32(p.e.size); }
  return w.done();
}

function centralDirectory(plan: ZipPlan): Uint8Array {
  var w = writer(plan.cdSize + (plan.end64 ? 76 : 0) + 22);
  plan.entries.forEach(function (p) {
    var need64 = p.big || p.farOffset;
    w.u32(0x02014b50);
    w.u16((3 << 8) | (need64 ? 45 : 20));   // made on Unix, so the mode below is read
    w.u16(need64 ? 45 : 20);
    w.u16(0x0808);
    w.u16(0);
    w.u16(p.stamp.time); w.u16(p.stamp.date);
    w.u32(p.crc as number);
    w.u32(p.big ? MAX32 : p.e.size); w.u32(p.big ? MAX32 : p.e.size);
    w.u16(p.name.length);
    w.u16((p.extra64 ? 4 + p.extra64 : 0) + 9);
    w.u16(0); w.u16(0); w.u16(0);
    w.u32(0o100644 * 0x10000);
    w.u32(p.farOffset ? MAX32 : p.offset);
    w.bytes(p.name);
    if (p.extra64) {
      w.u16(0x0001); w.u16(p.extra64);
      if (p.big) { w.u64(p.e.size); w.u64(p.e.size); }
      if (p.farOffset) w.u64(p.offset);
    }
    w.u16(0x5455); w.u16(5); w.bytes([1]); w.u32(p.mtime);
  });
  var n = plan.entries.length;
  if (plan.end64) {
    var at = plan.cdStart + plan.cdSize;
    w.u32(0x06064b50); w.u64(44); w.u16((3 << 8) | 45); w.u16(45); w.u32(0); w.u32(0);
    w.u64(n); w.u64(n); w.u64(plan.cdSize); w.u64(plan.cdStart);
    w.u32(0x07064b50); w.u32(0); w.u64(at); w.u32(1);
  }
  // each field that does not fit says so, and is read from the ZIP64 record
  var count = n > 0xFFFF ? 0xFFFF : n;
  w.u32(0x06054b50); w.u16(0); w.u16(0);
  w.u16(count); w.u16(count);
  w.u32(plan.cdSize >= plan.at64 ? MAX32 : plan.cdSize); w.u32(plan.cdStart >= plan.at64 ? MAX32 : plan.cdStart);
  w.u16(0);
  return w.done();
}

function bodyOf(object: R2ObjectBody): ReadableStream<Uint8Array | ArrayBuffer> {
  return object.body && typeof object.body.getReader === 'function' ? object.body : new Response(object.body).body as ReadableStream;
}

// The archive as a stream, pulled one piece at a time so a slow download
// holds one chunk of one file and no more. A file missing from the
// bucket, or a different size from the one planned, ends the stream with
// an error, which the browser shows as a failed download.
export function zipStream(bucket: R2Bucket, plan: ZipPlan): ReadableStream<Uint8Array> {
  var i = 0;
  var reader: ReadableStreamDefaultReader<Uint8Array | ArrayBuffer> | null = null;
  var crc = 0;
  var sent = 0;
  return new ReadableStream({
    async pull(controller) {
      try {
        for (;;) {
          if (i >= plan.entries.length) {
            controller.enqueue(centralDirectory(plan));
            controller.close();
            return;
          }
          var p = plan.entries[i];
          if (!reader) {
            var object = await bucket.get(p.e.key);
            if (!object) throw new Error('missing ' + p.e.key);
            reader = bodyOf(object).getReader();
            crc = 0;
            sent = 0;
            controller.enqueue(localHeader(p));
            return;
          }
          var got = await reader.read();
          if (got.done) {
            reader = null;
            if (sent !== p.e.size) throw new Error('size changed ' + p.e.key);
            p.crc = crc;
            controller.enqueue(descriptor(p, crc));
            i++;
            return;
          }
          var chunk = got.value instanceof Uint8Array ? got.value : new Uint8Array(got.value);
          if (!chunk.length) continue;
          crc = crc32(crc, chunk);
          sent += chunk.length;
          controller.enqueue(chunk);
          return;
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      if (reader) reader.cancel().catch(function () {});
    }
  }, { highWaterMark: 0 });
}

// A name safe to be a file's name in the archive and nowhere else: no
// folders, no characters a file system refuses, and one of each, with
// " (2)" before the extension of a second.
export function zipNames(names: unknown[]): string[] {
  var seen: Record<string, boolean> = {};
  return names.map(function (raw) {
    var name = String(raw || '').replace(/[\x00-\x1f\x7f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
      .replace(/ (\.[^.]*)$/, '$1').replace(/^\.+/, '').slice(0, 150) || 'file';
    var dot = name.lastIndexOf('.');
    var stem = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '';
    var out = name;
    for (var n = 2; seen[out.toLowerCase()]; n++) out = stem + ' (' + n + ')' + ext;
    seen[out.toLowerCase()] = true;
    return out;
  });
}
