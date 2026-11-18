// Run with: node tests/verify-strip.mjs   (needs Node 22+)
// The metadata stripper on its own: that a JPEG with EXIF comes out
// valid and shorter, that the pixels are untouched, that the location
// and the camera can still be read from the block it took out, and
// that a file it cannot read is handed back rather than guessed at.
import { stripImage, readExif, strippable, sniffImage, imageMatches, planJpegHead, pngWalker, keepLength, keepStream, takenUtc, metaBlockOf } from '../src/strip.ts';
import { u32, ascii, buildExif, seg } from './exif-sample.mjs';

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

// ---- a JPEG with real EXIF in it ----
// The block is built by hand in exif-sample.mjs, so the offsets are
// known to be right.

// A JPEG shaped like one a phone writes: JFIF, EXIF, an XMP block, a
// colour profile, a comment, then the tables and the scan.
const exifBlock = buildExif();
const xmp = [...ascii('http://ns.adobe.com/xap/1.0/'), ...ascii('<x:xmpmeta>edited</x:xmpmeta>')];
const icc = [...ascii('ICC_PROFILE'), 1, 1, 9, 9, 9];
const scanData = [];
for (let i = 0; i < 400; i++) scanData.push((i * 7) % 251);
const jpeg = new Uint8Array([
  0xFF, 0xD8,
  ...seg(0xE0, [...ascii('JFIF'), 1, 2, 0, 0, 1, 0, 1, 0, 0]),
  ...seg(0xE1, [...exifBlock]),
  ...seg(0xE1, xmp),
  ...seg(0xE2, icc),
  ...seg(0xFE, [...ascii('taken by someone')]),
  ...seg(0xDB, new Array(65).fill(3)),
  ...seg(0xC0, [8, 0, 16, 0, 16, 1, 1, 17, 0]),
  ...seg(0xC4, new Array(20).fill(1)),
  ...seg(0xDA, [1, 1, 0, 0, 63, 0]),
  ...scanData,
  0xFF, 0xD9
]);

// ---- what it takes out ----
const out = stripImage(jpeg, 'image/jpeg');
check('a JPEG with EXIF is changed', out.changed && out.bytes.length < jpeg.length,
  JSON.stringify({ was: jpeg.length, now: out.bytes.length, removed: out.removed }));
check('EXIF, XMP and the comment all go, and nothing else does',
  JSON.stringify(out.removed) === JSON.stringify(['EXIF', 'XMP', 'COM']), JSON.stringify(out.removed));
check('the file still opens and closes as a JPEG',
  out.bytes[0] === 0xFF && out.bytes[1] === 0xD8 &&
  out.bytes[out.bytes.length - 2] === 0xFF && out.bytes[out.bytes.length - 1] === 0xD9, '');

// the scan is the picture: it has to come through byte for byte
const clean = Buffer.from(out.bytes);
const tail = Buffer.from([...seg(0xDA, [1, 1, 0, 0, 63, 0]), ...scanData, 0xFF, 0xD9]);
check('the image data is untouched — this is not a re-encode',
  clean.slice(-tail.length).equals(tail), JSON.stringify({ tail: tail.length, clean: clean.length }));

// ---- which way up the phone was has to survive ----
// A phone does not rotate the pixels when you turn it; it records
// which way up it was and every browser turns the picture to match.
// Take that away and a portrait photo renders on its side.
check('the orientation tag comes back, on its own, in a block of its own',
  out.orientation === 6 && clean.includes(Buffer.from([0xFF, 0xE1, 0x00, 0x22])),
  JSON.stringify({ orientation: out.orientation }));
const putBack = readExif(clean.slice(clean.indexOf(Buffer.from([0xFF, 0xE1])) + 4, clean.indexOf(Buffer.from([0xFF, 0xE1])) + 4 + 32));
check('and the block it went back in carries nothing else at all',
  putBack.has_exif && !putBack.gps && !putBack.make && !putBack.model &&
  !putBack.software && !putBack.taken_at && !putBack.maker_note,
  JSON.stringify(putBack));
check('the picture it belongs to is still the same bytes',
  clean.slice(-tail.length).equals(tail), '');
// a photo that was the right way up already needs nothing put back
const upright = new Uint8Array([
  0xFF, 0xD8,
  ...seg(0xE1, [...buildExif({ turn: 1 })]),
  ...seg(0xDB, new Array(65).fill(3)),
  ...seg(0xDA, [1, 1, 0, 0, 63, 0]), 1, 2, 3, 0xFF, 0xD9
]);
const uprightOut = stripImage(upright, 'image/jpeg');
check('a photo already the right way up gets no block back',
  uprightOut.changed && uprightOut.orientation === 0 &&
  !Buffer.from(uprightOut.bytes).includes(Buffer.from([0xFF, 0xE1])), '');

// the colour profile changes how the picture looks, so it stays
check('the colour profile survives',
  clean.includes(Buffer.from('ICC_PROFILE')) && !clean.includes(Buffer.from('Apple')) &&
  !clean.includes(Buffer.from('xmpmeta')) && !clean.includes(Buffer.from('taken by someone')), '');

// ---- what it hands back ----
const meta = readExif(out.exif);
check('the camera and the version come back out of the block it removed',
  meta.has_exif && meta.make === 'Apple' && meta.model === 'iPhone 15 Pro' && meta.software === '18.2' &&
  meta.lens === 'iPhone 15 Pro back camera' && meta.maker_note === true,
  JSON.stringify({ make: meta.make, model: meta.model, software: meta.software, lens: meta.lens }));
check('so do both timestamps',
  meta.taken_at === '2026-10-20 09:14:02' && meta.modified_at === '2026-10-20 11:03:11',
  JSON.stringify({ taken: meta.taken_at, modified: meta.modified_at }));
check('and the location, with south read as a minus',
  !!meta.gps && meta.gps.lat === -33.883 && meta.gps.lng === 151.2063, JSON.stringify(meta.gps));
check('a photo written after it was taken reads as re-saved, with the reason said plainly',
  meta.verdict === 'edited or re-saved' && meta.signals.some(s => /last written/.test(s)),
  JSON.stringify({ verdict: meta.verdict, signals: meta.signals }));

check('so do the camera settings, the zone and the height, and the time taken turns into UTC, by Sydney\'s clock when no zone is written',
  meta.exposure === 0.008333 && meta.fnumber === 1.78 && meta.iso === 80 && meta.focal === 6.86 && meta.offset === '+11:00' &&
  meta.gps.alt === 52 && takenUtc(meta) === '2026-10-19 22:14:02' &&
  takenUtc({ taken_at: '2026-10-20 09:14:02' }) === '2026-10-19 22:14:02' && takenUtc({ taken_at: '2026-07-01 12:00:00' }) === '2026-07-01 02:00:00' &&
  takenUtc({ taken_at: '' }) === '',
  JSON.stringify({ exposure: meta.exposure, fnumber: meta.fnumber, iso: meta.iso, focal: meta.focal, offset: meta.offset, gps: meta.gps, utc: takenUtc(meta) }));

// big-endian is the other half of the format and phones use both
const beExif = buildExif({ little: false });
const beMeta = readExif(beExif);
check('a big-endian block reads the same', beMeta.make === 'Apple' && !!beMeta.gps,
  JSON.stringify({ make: beMeta.make, gps: beMeta.gps }));

// ---- a picture with nothing in it to find ----
const bareJpeg = new Uint8Array([
  0xFF, 0xD8,
  ...seg(0xDB, new Array(65).fill(3)),
  ...seg(0xC0, [8, 0, 16, 0, 16, 1, 1, 17, 0]),
  ...seg(0xDA, [1, 1, 0, 0, 63, 0]),
  1, 2, 3, 4, 0xFF, 0xD9
]);
const bare = stripImage(bareJpeg, 'image/jpeg');
check('a JPEG with no metadata is left exactly as it was, and read through, so it is its own clean copy',
  !bare.changed && bare.parsed && bare.bytes.length === bareJpeg.length && bare.exif === null, '');
check('and reading nothing says so rather than throwing',
  readExif(null).verdict === 'no camera data' && readExif(new Uint8Array(3)).has_exif === false, '');

// ---- PNG ----
function crc() { return [0, 0, 0, 0]; } // nothing here checks it
function chunk(type, data) {
  return [...u32(data.length, false), ...ascii(type).slice(0, 4), ...data, ...crc()];
}
const png = new Uint8Array([
  0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
  ...chunk('IHDR', [0, 0, 0, 16, 0, 0, 0, 16, 8, 2, 0, 0, 0]),
  ...chunk('tEXt', [...ascii('Author'), ...'someone'.split('').map(c => c.charCodeAt(0))]),
  ...chunk('eXIf', [...buildExif().slice(6)]),
  ...chunk('sRGB', [0]),
  ...chunk('IDAT', [1, 2, 3, 4, 5, 6, 7, 8]),
  ...chunk('IEND', [])
]);
const pout = stripImage(png, 'image/png');
const pclean = Buffer.from(pout.bytes);
check('a PNG loses its text and EXIF chunks and keeps the rest',
  pout.changed && JSON.stringify(pout.removed) === JSON.stringify(['tEXt', 'eXIf']) &&
  pclean.includes(Buffer.from('IHDR')) && pclean.includes(Buffer.from('sRGB')) &&
  pclean.includes(Buffer.from('IDAT')) && pclean.includes(Buffer.from('IEND')) &&
  !pclean.includes(Buffer.from('Author')), JSON.stringify(pout.removed));
check('and its EXIF is readable too, with no Exif\\0\\0 in front of it',
  readExif(pout.exif).make === 'Apple', JSON.stringify(readExif(pout.exif).make));

// ---- a picture too big to hold ----
// The same cut worked out from a JPEG's first bytes, or a PNG walked a
// few bytes at a time, and copied as it streams past, has to come out
// as the bytes stripImage makes from the whole file.
async function streamed(bytes, keep, size) {
  const pieces = [];
  for (let i = 0; i < bytes.length; i += size) pieces.push(bytes.slice(i, i + size));
  const source = new ReadableStream({ start(c) { pieces.forEach(p => c.enqueue(p)); c.close(); } });
  return new Uint8Array(await new Response(source.pipeThrough(keepStream(keep))).arrayBuffer());
}
const same = (a, b) => Buffer.from(a).equals(Buffer.from(b));
const jplan = planJpegHead(jpeg.slice(0, jpeg.length - 100), jpeg.length);
const walker = pngWalker();
for (let i = 0; i < png.length; i += 5) walker.push(png.slice(i, i + 5));
const pplan = walker.finish(png.length);
check('a photo too big to read whole comes out the same streamed in pieces as read whole, its EXIF kept beside it',
  !!jplan && same(await streamed(jpeg, jplan.keep, 7), out.bytes) && keepLength(jplan.keep) === out.bytes.length &&
  !!pplan && same(await streamed(png, pplan.keep, 3), pout.bytes) && keepLength(pplan.keep) === pout.bytes.length &&
  readExif(pplan.exif).make === 'Apple' && planJpegHead(jpeg.slice(0, 60), jpeg.length) === null,
  JSON.stringify({ jpeg: !!jplan, png: !!pplan }));

// ---- files it cannot read ----
const unread = (o) => o.changed === false && o.parsed === false;
check('something that is not a JPEG at all is handed back untouched, and not called clean',
  unread(stripImage(new Uint8Array([1, 2, 3, 4, 5]), 'image/jpeg')), '');
const truncated = jpeg.slice(0, 40);
check('a JPEG that stops partway is handed back rather than guessed at',
  unread(stripImage(truncated, 'image/jpeg')), '');
check('a type this does not understand is never touched',
  unread(stripImage(png, 'image/webp')) && unread(stripImage(jpeg, 'video/mp4')), '');

// ---- GIF ----
// A GIF carries comments and application blocks, and XMP rides in one.
// They come out; the loop count, the frame timing and the frame stay.
const chars = (text) => [...text].map(c => c.charCodeAt(0));
const sub = (bytes) => { const out = []; for (let i = 0; i < bytes.length; i += 255) { const part = bytes.slice(i, i + 255); out.push(part.length, ...part); } out.push(0); return out; };
const gifComment = [0x21, 0xFE, ...sub(chars('shot at -33.88,151.20 by someone'))];
const gifXmp = [0x21, 0xFF, 11, ...chars('XMP DataXMP'), ...sub(chars('<x:xmpmeta><exif:GPSLatitude>33,52.98S</exif:GPSLatitude></x:xmpmeta>'))];
const gifOther = [0x21, 0xFF, 11, ...chars('MYAPPDATA01'), ...sub(chars('anything at all'))];
const gifLoop = [0x21, 0xFF, 11, ...chars('NETSCAPE2.0'), 3, 1, 0, 0, 0];
const gifFrame = [0x21, 0xF9, 4, 4, 10, 0, 0, 0, 0x2C, 0, 0, 0, 0, 2, 0, 2, 0, 0x80, 0, 0, 0, 255, 255, 255, 2, 2, 0x44, 0x01, 0];
const gif = new Uint8Array([
  ...chars('GIF89a'), 2, 0, 2, 0, 0, 0, 0,
  ...gifLoop, ...gifComment, ...gifFrame, ...gifXmp, ...gifOther, ...gifFrame, 0x3B,
  ...chars('tail after the end')
]);
const gout = stripImage(gif, 'image/gif');
const gclean = Buffer.from(gout.bytes);
check('a GIF loses its comment, its XMP, other application blocks and anything after the end',
  gout.changed && gout.parsed && JSON.stringify(gout.removed) === JSON.stringify(['comment', 'XMP', 'application', 'trailing']) &&
  !gclean.includes(Buffer.from('someone')) && !gclean.includes(Buffer.from('GPS')) && !gclean.includes(Buffer.from('anything')) &&
  !gclean.includes(Buffer.from('tail')) && gclean[gclean.length - 1] === 0x3B, JSON.stringify(gout.removed));
check('and keeps the loop and both frames, byte for byte',
  gclean.length === 13 + gifLoop.length + 2 * gifFrame.length + 1 && gclean.includes(Buffer.from(gifLoop)) &&
  gclean.indexOf(Buffer.from(gifFrame)) !== gclean.lastIndexOf(Buffer.from(gifFrame)), String(gclean.length));
check('a GIF that stops before its end marker is not called clean',
  unread(stripImage(gif.slice(0, 60), 'image/gif')), '');

// ---- what else a GIF or a PNG says about itself ----
// A GIF's XMP is the packet written straight into its block with a run
// of bytes after it that a reader skipping sub-blocks lands on the end
// of. ImageMagick writes a PNG's XMP as a hex profile, and the PNG
// standard's Creation Time is a plain text chunk; that one is read when
// the picture says nothing else.
{
  const packet = '<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description ' +
    'xmlns:tiff="http://ns.adobe.com/tiff/1.0/" xmlns:exif="http://ns.adobe.com/exif/1.0/" tiff:Make="Canon" tiff:Model="Canon EOS R6" ' +
    'exif:DateTimeOriginal="2026-10-21T10:00:00+11:00" exif:GPSLatitude="33,52.98S" exif:GPSLongitude="151,12.30E"/></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const landing = [1];
  for (let b = 255; b >= 0; b--) landing.push(b);
  landing.push(0);
  const rawGif = new Uint8Array([
    ...chars('GIF89a'), 2, 0, 2, 0, 0, 0, 0,
    0x21, 0xFF, 11, ...chars('XMP DataXMP'), ...new TextEncoder().encode(packet), ...landing,
    ...gifFrame, 0x3B
  ]);
  const gifCut = stripImage(rawGif, 'image/gif');
  const gifMeta = readExif(await metaBlockOf(gifCut));
  const hex = Buffer.from(packet).toString('hex').replace(/(.{72})/g, '$1\n');
  const pngOf = (keyword, text) => new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    ...chunk('IHDR', [0, 0, 0, 16, 0, 0, 0, 16, 8, 2, 0, 0, 0]),
    ...chunk('tEXt', [...ascii(keyword), ...chars(text)]),
    ...chunk('IDAT', [1, 2, 3, 4]),
    ...chunk('IEND', [])
  ]);
  const profiled = readExif(await metaBlockOf(stripImage(pngOf('Raw profile type xmp', '\nxmp\n' + String(packet.length).padStart(8) + '\n' + hex + '\n'), 'image/png')));
  const created = readExif(await metaBlockOf(stripImage(pngOf('Creation Time', 'Tue, 21 Oct 2026 09:14:02 +1100'), 'image/png')));
  check('a GIF\'s XMP, a PNG\'s XMP written as a hex profile and a PNG\'s Creation Time are all read from the block, and none of it is in the copy',
    JSON.stringify(gifCut.removed) === JSON.stringify(['XMP']) && Buffer.from(gifCut.bytes).indexOf('Canon') === -1 &&
    gifMeta.model === 'Canon EOS R6' && takenUtc(gifMeta) === '2026-10-20 23:00:00' && gifMeta.gps.lat === -33.883 &&
    profiled.model === 'Canon EOS R6' && profiled.gps.lng === 151.205 &&
    takenUtc(created) === '2026-10-20 22:14:02' && created.offset === '+11:00' && !created.make,
    JSON.stringify({ gif: [gifMeta.model, takenUtc(gifMeta), gifMeta.gps], profiled: [profiled.model, profiled.gps], created: [created.taken_at, created.offset] }));
}

// ---- which files get which treatment ----
check('JPEG, PNG and GIF are the ones it cleans',
  strippable('image/jpeg') && strippable('image/png') && strippable('IMAGE/JPEG; charset=binary') &&
  strippable('image/gif') && !strippable('image/webp') && !strippable('video/mp4'), '');
check('a picture is what its first bytes say, not what its name says',
  sniffImage(jpeg) === 'jpeg' && sniffImage(png) === 'png' && sniffImage(gif) === 'gif' &&
  imageMatches('image/jpeg', jpeg) && !imageMatches('image/png', jpeg) &&
  !imageMatches('image/jpeg', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>')) &&
  !imageMatches('image/svg+xml', new TextEncoder().encode('<svg/>')), '');

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
