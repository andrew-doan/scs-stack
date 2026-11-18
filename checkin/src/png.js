// A tiny PNG writer for the QR images. Workers have no canvas, so the
// QR matrix is written out as an 8-bit grayscale PNG by hand. The
// zlib stream uses stored (uncompressed) deflate blocks — a QR code
// is a few hundred pixels square, so the bytes saved by real
// compression are not worth carrying an inflater around.

var CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

function crc32(bytes) {
  var table = crcTable();
  var c = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  var a = 1, b = 0;
  for (var i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function be32(n) {
  return [ (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff ];
}

function chunk(type, data) {
  var typeBytes = [];
  for (var i = 0; i < 4; i++) typeBytes.push(type.charCodeAt(i));
  var body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, 4);
  var out = new Uint8Array(8 + data.length + 4);
  out.set(be32(data.length), 0);
  out.set(body, 4);
  out.set(be32(crc32(body)), 8 + data.length);
  return out;
}

// pixels: Uint8Array of width*height gray values (0 black, 255 white)
export function grayPng(width, height, pixels) {
  // filter byte 0 in front of every scanline
  var stride = width + 1;
  var raw = new Uint8Array(stride * height);
  for (var y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * stride + 1);
  }

  // zlib wrapper around stored deflate blocks (max 65535 bytes each)
  var parts = [[0x78, 0x01]];
  var zlibLen = 2;
  for (var off = 0; off < raw.length; off += 65535) {
    var len = Math.min(65535, raw.length - off);
    var last = off + len >= raw.length ? 1 : 0;
    parts.push([last, len & 0xff, (len >>> 8) & 0xff, (~len) & 0xff, ((~len) >>> 8) & 0xff]);
    parts.push(raw.subarray(off, off + len));
    zlibLen += 5 + len;
  }
  parts.push(be32(adler32(raw)));
  zlibLen += 4;
  var zlib = new Uint8Array(zlibLen);
  var at = 0;
  for (var p = 0; p < parts.length; p++) { zlib.set(parts[p], at); at += parts[p].length; }

  var ihdr = new Uint8Array(13);
  ihdr.set(be32(width), 0);
  ihdr.set(be32(height), 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // grayscale
  // compression, filter, interlace all 0

  var sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  var ihdrChunk = chunk('IHDR', ihdr);
  var idatChunk = chunk('IDAT', zlib);
  var iendChunk = chunk('IEND', new Uint8Array(0));
  var png = new Uint8Array(sig.length + ihdrChunk.length + idatChunk.length + iendChunk.length);
  var o = 0;
  [sig, ihdrChunk, idatChunk, iendChunk].forEach(function (part) { png.set(part, o); o += part.length; });
  return png;
}
