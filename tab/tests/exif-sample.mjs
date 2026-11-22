// A photo's EXIF block laid out by hand, so the offsets are known to be
// right, and a JPEG carrying it. Shared by verify-strip.mjs and
// verify-albums.mjs.
//
// The block: IFD0 with which way up, Make, Model, Software, ModifyDate
// and pointers to the Exif and GPS directories; the Exif directory with
// when it was taken and in which zone, the exposure, aperture, ISO,
// focal length, the lens and a maker note; GPS with Central's location
// and its height.

export function u16(v, little) { return little ? [v & 255, (v >> 8) & 255] : [(v >> 8) & 255, v & 255]; }
export function u32(v, little) {
  return little
    ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]
    : [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
}
export function ascii(text) {
  const out = [...text].map(c => c.charCodeAt(0));
  out.push(0);
  return out;
}

// where (lat and lng, south and east) and when (taken, in the EXIF form,
// Sydney's clock) can be given; the defaults are the bytes every suite reads
export function buildExif({ little = true, gps = true, turn = 6, at = null, taken = '2026:10:20 09:14:02' } = {}) {
  const strings = [];          // the pool everything long points into
  let poolAt = 0;
  const pool = (bytes) => { const at = poolAt; strings.push(bytes); poolAt += bytes.length; return at; };
  const rational = (top, bottom) => pool([...u32(top, little), ...u32(bottom, little)]);

  const make = pool(ascii('Apple'));
  const model = pool(ascii('iPhone 15 Pro'));
  const software = pool(ascii('18.2'));
  const modifyDate = pool(ascii('2026:10:20 11:03:11'));
  const takenDate = pool(ascii(taken));
  const zone = pool(ascii('+11:00'));
  const lens = pool(ascii('iPhone 15 Pro back camera'));
  const makerNote = pool([1, 2, 3, 4, 5, 6, 7, 8]);
  const exposure = rational(1, 120);
  const fnumber = rational(178, 100);
  const focal = rational(686, 100);
  // Central: 33 deg 52 min 58.8 sec south, 151 deg 12 min 22.68 sec
  // east — which is -33.883000, 151.206300. Each number is a pair:
  // the top of the fraction then the bottom.
  const dms = (v) => {
    const a = Math.abs(v);
    const deg = Math.floor(a);
    const min = Math.floor((a - deg) * 60);
    const sec = Math.round(((a - deg) * 60 - min) * 60 * 100);
    return [...u32(deg, little), ...u32(1, little), ...u32(min, little), ...u32(1, little), ...u32(sec, little), ...u32(100, little)];
  };
  const latVal = pool(at ? dms(at.lat) : [...u32(33, little), ...u32(1, little), ...u32(52, little), ...u32(1, little), ...u32(588, little), ...u32(10, little)]);
  const lngVal = pool(at ? dms(at.lng) : [...u32(151, little), ...u32(1, little), ...u32(12, little), ...u32(1, little), ...u32(2268, little), ...u32(100, little)]);
  const altitude = rational(52, 1);

  const entry = (tag, type, count, valueBytes) => [...u16(tag, little), ...u16(type, little), ...u32(count, little), ...valueBytes];

  // header(8) + ifd0 + exifIfd + gpsIfd, then the pool
  const IFD0_ENTRIES = 7;
  const EXIF_ENTRIES = 9;
  const GPS_ENTRIES = gps ? 6 : 0;
  const ifd0At = 8;
  const ifd0Size = 2 + IFD0_ENTRIES * 12 + 4;
  const exifAt = ifd0At + ifd0Size;
  const exifSize = 2 + EXIF_ENTRIES * 12 + 4;
  const gpsAt = exifAt + exifSize;
  const gpsSize = gps ? 2 + GPS_ENTRIES * 12 + 4 : 0;
  const poolBase = gpsAt + gpsSize;
  const ref = (at) => u32(poolBase + at, little);

  const ifd0 = [
    ...u16(IFD0_ENTRIES, little),
    // 6 = the phone was held on its side; a browser turns the picture
    ...entry(0x0112, 3, 1, [...u16(turn, little), 0, 0]),
    ...entry(0x010F, 2, 6, ref(make)),
    ...entry(0x0110, 2, 14, ref(model)),
    ...entry(0x0131, 2, 5, ref(software)),
    ...entry(0x0132, 2, 20, ref(modifyDate)),
    ...entry(0x8769, 4, 1, u32(exifAt, little)),
    ...entry(0x8825, 4, 1, u32(gps ? gpsAt : 0, little)),
    ...u32(0, little)
  ];
  const exifIfd = [
    ...u16(EXIF_ENTRIES, little),
    ...entry(0x829A, 5, 1, ref(exposure)),
    ...entry(0x829D, 5, 1, ref(fnumber)),
    ...entry(0x8827, 3, 1, [...u16(80, little), 0, 0]),
    ...entry(0x9003, 2, 20, ref(takenDate)),
    ...entry(0x9004, 2, 20, ref(takenDate)),
    ...entry(0x9011, 2, 7, ref(zone)),
    ...entry(0x920A, 5, 1, ref(focal)),
    ...entry(0x927C, 7, 8, ref(makerNote)),
    ...entry(0xA434, 2, 26, ref(lens)),
    ...u32(0, little)
  ];
  const gpsIfd = gps ? [
    ...u16(GPS_ENTRIES, little),
    ...entry(0x0001, 2, 2, [...ascii('S'), 0, 0]),
    ...entry(0x0002, 5, 3, ref(latVal)),
    ...entry(0x0003, 2, 2, [...ascii('E'), 0, 0]),
    ...entry(0x0004, 5, 3, ref(lngVal)),
    ...entry(0x0005, 1, 1, [0, 0, 0, 0]),
    ...entry(0x0006, 5, 1, ref(altitude)),
    ...u32(0, little)
  ] : [];

  const header = [...(little ? [0x49, 0x49] : [0x4D, 0x4D]), ...u16(42, little), ...u32(ifd0At, little)];
  return new Uint8Array([0x45, 0x78, 0x69, 0x66, 0, 0, ...header, ...ifd0, ...exifIfd, ...gpsIfd, ...strings.flat()]);
}

export function seg(marker, payload) {
  const len = payload.length + 2;
  return [0xFF, marker, (len >> 8) & 255, len & 255, ...payload];
}

// A small JPEG a phone could have written: the EXIF block above, the
// tables, and a scan of `scanBytes` bytes.
export function cameraJpeg(scanBytes = 64, exif = {}) {
  const scan = [];
  for (let i = 0; i < scanBytes; i++) scan.push((i * 7) % 251);
  return new Uint8Array([
    0xFF, 0xD8,
    ...seg(0xE1, [...buildExif(exif)]),
    ...seg(0xDB, new Array(65).fill(3)),
    ...seg(0xC0, [8, 0, 16, 0, 16, 1, 1, 17, 0]),
    ...seg(0xDA, [1, 1, 0, 0, 63, 0]),
    ...scan,
    0xFF, 0xD9
  ]);
}
