// A GPX track read for the dashboard's review card: how far it goes,
// when it started and ended, and a line short enough to draw.
//
// A worker has no XML parser, so this reads the file with regular
// expressions. GPX from a phone, a watch or an app is regular enough
// for that: every point is a trkpt, rtept or wpt element carrying lat
// and lon attributes, with its time inside it. Anything it cannot read
// is skipped rather than refused, so a file with a few odd points still
// draws.

// What the review card draws (readTrack).
export interface Track {
  points: number;
  distance_m: number;
  started: string;
  ended: string;
  line: number[][];
}

var MAX_LINE = 300;          // points in the line handed to the page
var EARTH_M = 6371008.8;     // mean radius

var POINT = /<(?:[\w-]+:)?(trkpt|rtept|wpt)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[\w-]+:)?\1\s*>)/gi;
var TIME = /<(?:[\w-]+:)?time\s*>\s*([^<]+?)\s*</i;

function attr(attrs: string, name: string): number {
  var m = new RegExp('\\b' + name + '\\s*=\\s*["\']\\s*([^"\']*?)\\s*["\']', 'i').exec(attrs);
  return m ? Number(m[1]) : NaN;
}

function metres(a: number[], b: number[]): number {
  var rad = Math.PI / 180;
  var dLat = (b[0] - a[0]) * rad;
  var dLng = (b[1] - a[1]) * rad;
  var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

// the worker's own stamp shape, UTC: '2026-10-20 03:15:00'
function stamp(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// {points, distance_m, started, ended, line}: the track's points (a
// route's, or the waypoints', when the file has no track), the distance
// along them in metres, the first and last time any point carries ('' when
// none does) and up to MAX_LINE [lat, lng] pairs spread along it.
export function readTrack(text: unknown): Track {
  type Point = { at: number[]; ms: number };
  var found: Record<string, Point[]> = { trkpt: [], rtept: [], wpt: [] };
  var m;
  POINT.lastIndex = 0;
  while ((m = POINT.exec(String(text || '')))) {
    var lat = attr(m[2], 'lat');
    var lng = attr(m[2], 'lon');
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
    var t = m[3] ? TIME.exec(m[3]) : null;
    var at = t ? Date.parse(t[1]) : NaN;
    found[m[1].toLowerCase()].push({ at: [lat, lng], ms: at });
  }
  var list = found.trkpt.length ? found.trkpt : found.rtept.length ? found.rtept : found.wpt;
  var distance = 0;
  var first = NaN;
  var last = NaN;
  list.forEach(function (p, i) {
    if (i) distance += metres(list[i - 1].at, p.at);
    if (isFinite(p.ms)) {
      if (!isFinite(first) || p.ms < first) first = p.ms;
      if (!isFinite(last) || p.ms > last) last = p.ms;
    }
  });
  var line: number[][] = [];
  if (list.length <= MAX_LINE) {
    line = list.map(function (p) { return p.at; });
  } else {
    var step = (list.length - 1) / (MAX_LINE - 1);
    for (var i = 0; i < MAX_LINE; i++) line.push(list[Math.round(i * step)].at);
  }
  return {
    points: list.length,
    distance_m: Math.round(distance),
    started: isFinite(first) ? stamp(first) : '',
    ended: isFinite(last) ? stamp(last) : '',
    line: line.map(function (p) { return [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5]; })
  };
}
