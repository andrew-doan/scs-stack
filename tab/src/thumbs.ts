// GET /api/thumbs?k=<key>&v=<version>&k=…: many grid thumbnails in one
// answer, so a page scrolling through an album or the gallery makes one
// request for a screenful rather than one per picture. Each part is asked
// of the worker exactly as the page would ask for it on its own
// (`/api/albums/file?key=…&v=…&thumb=1` or `/api/submit/file?key=…&thumb=1`)
// through `one`, which is the worker's own fetch, so a batch opens nothing
// the single route does not and shares its edge copies. A part the single
// route would not hand out whole and for good (a stand-in, a failure, a
// file too big) is listed as missing and the page asks for it on its own.
//
// The answer is a four-byte big-endian length, that many bytes of JSON
// `{parts: [{key, type, size} | {key, missing: true}]}` in the order asked,
// then the parts' bytes one after another.

export var THUMBS_MAX = 30;
var PART_MAX = 1000000;
var FOREVER = 'public, max-age=31536000, immutable';
var SHORT = 'public, max-age=300';

type Part = { key: string; type?: string; size?: number; missing?: true };

function innerPath(key: string, version: string): string {
  var k = encodeURIComponent(key);
  if (key.indexOf('alb/') === 0) return '/api/albums/file?key=' + k + (version ? '&v=' + encodeURIComponent(version) : '') + '&thumb=1';
  if (key.indexOf('sub/') === 0) return '/api/submit/file?key=' + k + '&thumb=1';
  return '';
}

export async function thumbBatch(url: URL, one: (request: Request) => Promise<Response>): Promise<Response> {
  var keys = url.searchParams.getAll('k');
  var versions = url.searchParams.getAll('v');
  var headers = { 'access-control-allow-origin': '*', 'x-content-type-options': 'nosniff' };
  if (!keys.length || keys.length > THUMBS_MAX) {
    return new Response(JSON.stringify({ error: 'Ask for 1 to ' + THUMBS_MAX + ' pictures.' }), {
      status: 400, headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, headers)
    });
  }
  var answers = await Promise.all(keys.map(async function (key, i) {
    var path = innerPath(key, versions[i] || '');
    if (!path) return { key: key, bytes: null as Uint8Array | null, type: '' };
    try {
      var resp = await one(new Request(url.origin + path));
      var type = resp.headers.get('content-type') || '';
      var cc = resp.headers.get('cache-control') || '';
      var rawLen = resp.headers.get('content-length');
      var length = rawLen !== null ? Number(rawLen) : NaN;
      if (resp.status !== 200 || type.indexOf('image/') !== 0 || !/\bimmutable\b/.test(cc) || (rawLen !== null && !(length >= 0 && length <= PART_MAX))) {
        if (resp.body) await resp.body.cancel();
        return { key: key, bytes: null, type: '' };
      }
      var bytes: Uint8Array | null = null;
      if (rawLen !== null || !resp.body) {
        var buf = new Uint8Array(await resp.arrayBuffer());
        if (buf.length <= PART_MAX) bytes = buf;
      } else {
        var reader = resp.body.getReader();
        var chunks: Uint8Array[] = [];
        var seen = 0;
        var over = false;
        while (true) {
          var step = await reader.read();
          if (step.done) break;
          seen += step.value.length;
          if (seen > PART_MAX) { over = true; await reader.cancel(); break; }
          chunks.push(step.value);
        }
        if (!over) {
          bytes = new Uint8Array(seen);
          var pos = 0;
          for (var c = 0; c < chunks.length; c++) { bytes.set(chunks[c], pos); pos += chunks[c].length; }
        }
      }
      return { key: key, bytes: bytes, type: bytes ? type : '' };
    } catch (err) {
      return { key: key, bytes: null, type: '' };
    }
  }));
  var parts: Part[] = answers.map(function (a) {
    return a.bytes ? { key: a.key, type: a.type, size: a.bytes.length } : { key: a.key, missing: true };
  });
  var head = new TextEncoder().encode(JSON.stringify({ parts: parts }));
  var total = 4 + head.length;
  answers.forEach(function (a) { if (a.bytes) total += a.bytes.length; });
  var out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  var at = 4 + head.length;
  answers.forEach(function (a) {
    if (!a.bytes) return;
    out.set(a.bytes, at);
    at += a.bytes.length;
  });
  // with a part missing the batch is kept briefly: the part may be there later
  var whole = parts.every(function (p) { return !p.missing; });
  return new Response(out, {
    status: 200,
    headers: Object.assign({ 'content-type': 'application/octet-stream', 'cache-control': whole ? FOREVER : SHORT }, headers)
  });
}
