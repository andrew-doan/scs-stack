// Run with: node tests/verify-albums.mjs   (needs Node 22+ for node:sqlite)
// Albums: made on the dashboard, read by anyone on the site, added to
// by teams with their submit code or by anyone, with the gallery's
// submissions shown in one when it asks for them, and videos going
// through the proof videos' encoder.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
import { cameraJpeg, buildExif } from './exif-sample.mjs';
import { deflateSync } from 'node:zlib';
import { stripImage } from '../src/strip.ts';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec("INSERT INTO teams (id, name) VALUES (1, 'Galahs'), (2, 'Red Rattlers'), (3, 'Test Team')");
raw.exec('UPDATE teams SET hidden = 1 WHERE id = 3');
raw.exec("INSERT INTO team_codes (team_id, code) VALUES (1, 'aaaa-1111'), (3, 'cccc-3333')");
raw.exec("INSERT INTO quests (code, norm, points) VALUES ('SQ8', 'SQ8', 50)");
// one gallery photo, one not opted in, one not yet accepted
raw.exec("INSERT INTO submissions (id, team_id, quest_code, status, gallery) VALUES (1, 1, 'SQ8', 'accepted', 1), (2, 2, 'SQ8', 'accepted', 0), (3, 2, 'SQ8', 'pending', 1)");
raw.exec("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes) VALUES (1, 'sub/galleryone', 'image/jpeg', 10), (2, 'sub/notopted', 'image/jpeg', 10), (3, 'sub/pending', 'image/jpeg', 10)");

const bucket = new Map();
const SUBMIT = {
  async put(key, value) { bucket.set(key, new Uint8Array(await new Response(value).arrayBuffer())); },
  async delete(key) { bucket.delete(key); },
  async get(key, opts) {
    const all = bucket.get(key);
    if (!all) return null;
    const r = opts && opts.range;
    const bytes = r ? all.subarray(r.offset, r.length == null ? all.length : r.offset + r.length) : all;
    return { body: bytes, size: all.length, httpMetadata: { contentType: 'image/jpeg' }, customMetadata: { strip: '99' },
      async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
  },
  async head(key) { return bucket.has(key) ? { size: bucket.get(key).length } : null; },
  async createMultipartUpload(key) {
    const uploadId = 'mp' + (++mpSeq);
    multi.set(uploadId, new Map());
    return { key, uploadId };
  },
  resumeMultipartUpload(key, uploadId) {
    return {
      async uploadPart(n, value) {
        multi.get(uploadId).set(n, new Uint8Array(await new Response(value).arrayBuffer()));
        return { partNumber: n, etag: 'e' + n };
      },
      async complete(parts) {
        const chunks = parts.map(p => multi.get(uploadId).get(p.partNumber));
        const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let at = 0;
        for (const c of chunks) { out.set(c, at); at += c.length; }
        bucket.set(key, out);
        multi.delete(uploadId);
        return { size: out.length };
      },
      async abort() { multi.delete(uploadId); }
    };
  }
};
const multi = new Map();
let mpSeq = 0;
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };
const mod = await import(BOT + '/src/index.ts');
const ENV = { DB: d1Shim(raw), SUBMIT, CONSOLE_PASSWORD: 'tab-pass', ENCODER_KEY: 'enc-key' };
const front = (path, opts, ip) => mod.default.fetch(new Request('https://tab.example' + path,
  Object.assign({}, opts, { headers: Object.assign({ 'cf-connecting-ip': ip || '203.0.113.9' }, (opts && opts.headers) || {}) })), ENV, { waitUntil() {} });
const post = (path, body, token) => front(path, {
  method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });

// a JPEG: SOI, a comment segment, SOS, EOI
function jpeg(name) {
  const b = new Uint8Array([0xFF, 0xD8, 0xFF, 0xFE, 0x00, 0x04, 0x68, 0x69, 0xFF, 0xDA, 0x00, 0x02, 0x11, 0x22, 0xFF, 0xD9]);
  return new File([b], name, { type: 'image/jpeg' });
}
function upload(slug, files, token, extra, ip) {
  const fd = new FormData();
  fd.append('a', slug);
  files.forEach(f => fd.append('files', f, f.name));
  Object.keys(extra || {}).forEach(k => fd.append(k, extra[k]));
  return front('/api/album/upload', { method: 'POST', headers: token ? { authorization: 'Bearer ' + token } : {}, body: fd }, ip);
}

const admin = (await consoleSignIn(post, 'Alex', 'tab-pass')).session;
await post('/api/console/albums/save', { name: 'Team Photos', about: 'From the day.', adding: 'teams', gallery: true }, admin);
await post('/api/console/albums/save', { name: 'Everyone', adding: 'anyone' }, admin);
await post('/api/console/albums/save', { name: 'Closed Album', adding: 'closed' }, admin);
await post('/api/console/albums/save', { name: 'Secret', adding: 'teams', hidden: true }, admin);
const made = await (await get('/api/console/albums', admin)).json();
const slugs = made.albums.map(a => a.slug);

const team = (await (await post('/api/submit/login', { team_name: 'Galahs', code: 'aaaa-1111' })).json()).session;
const testTeam = (await (await post('/api/submit/login', { team_name: 'Test Team', code: 'cccc-3333' })).json()).session;
let signedInBody = {};
let hiddenTeamBody = {};
const statuses = {
  teamsNoSignIn: (await upload('team-photos', [jpeg('a.jpg')])).status,
  teamsSignedIn: await upload('team-photos', [jpeg('b.jpg'), jpeg('c.jpg')], team).then(async r => { signedInBody = await r.json(); return r.status; }),
  hiddenTeam: await upload('team-photos', [jpeg('t.jpg')], testTeam).then(async r => { hiddenTeamBody = await r.json(); return r.status; }),
  anyone: (await upload('everyone', [jpeg('d.jpg')], null, { by: 'Sam' })).status,
  closed: (await upload('closed-album', [jpeg('e.jpg')], team)).status,
  notAPhoto: (await upload('everyone', [new File([new Uint8Array([60, 104, 116, 109, 108, 62])], 'x.jpg', { type: 'image/jpeg' })])).status,
  hiddenAlbum: (await upload('secret', [jpeg('f.jpg')], team)).status
};
check('who may add follows the album: a team signed in, anyone where anyone may, nobody where it is closed, and only photos and videos; a hidden team is told so',
  JSON.stringify(slugs) === JSON.stringify(['team-photos', 'everyone', 'closed-album', 'secret']) &&
  statuses.teamsNoSignIn === 401 && statuses.teamsSignedIn === 200 && statuses.anyone === 200 && statuses.closed === 403 &&
  statuses.notAPhoto === 400 && statuses.hiddenAlbum === 404 && statuses.hiddenTeam === 200 &&
  hiddenTeamBody.hidden_team === true && !signedInBody.hidden_team,
  JSON.stringify({ slugs, statuses, hiddenTeamBody, signedInBody }));

const list = await (await get('/api/albums')).json();
const album = await (await get('/api/album?a=team-photos')).json();
const keys = album.photos.map(p => p.key);
check('the site lists the albums that are shown and an album its photos, the gallery read in and a hidden team left out',
  list.albums.map(a => a.slug).join() === 'team-photos,everyone,closed-album' &&
  list.albums[0].count === 3 && album.album.name === 'Team Photos' && album.photos.length === 3 &&
  keys.includes('sub/galleryone') && !keys.includes('sub/notopted') && !keys.includes('sub/pending') &&
  album.photos.filter(p => p.from === 'album').every(p => p.team === 'Galahs') &&
  (await get('/api/album?a=secret')).status === 404,
  JSON.stringify({ list: list.albums.map(a => [a.slug, a.count]), photos: album.photos.map(p => [p.from, p.team]) }));

// Served photos have their metadata cut out as they stream, by a cut
// kept in the edge cache: a file replaced under the same key gets a new
// one rather than the old cut applied to different bytes.
const own = album.photos.find(p => p.from === 'album').key;
const plans = new Map();
const noCache = globalThis.caches;
// only the cuts are kept here: the bytes below change behind the album's
// back, which moves no version, and the cut is what is under test
const keyOf = (k) => typeof k === 'string' ? k : k.url;
globalThis.caches = { default: {
  async match(req) { const hit = plans.get(keyOf(req)); return hit ? new Response(hit) : undefined; },
  async put(req, res) { if (keyOf(req).includes('/__photo-plan/')) plans.set(keyOf(req), await res.text()); },
  async delete(req) { return plans.delete(keyOf(req)); }
} };
const firstShot = cameraJpeg(64);
const secondShot = cameraJpeg(300);
bucket.set(own, firstShot);
bucket.set(own + '.t', new Uint8Array([0xFF, 0xD8, 0x03]));   // the small copy
const served = new Uint8Array(await (await get('/api/albums/file?key=' + encodeURIComponent(own))).arrayBuffer());
const thumb = new Uint8Array(await (await get('/api/albums/file?key=' + encodeURIComponent(own) + '&thumb=1')).arrayBuffer());
const plansKept = [...plans.keys()].filter(k => k.includes('/__photo-plan/')).length;
bucket.set(own, secondShot);
const servedAgain = new Uint8Array(await (await get('/api/albums/file?key=' + encodeURIComponent(own))).arrayBuffer());
globalThis.caches = noCache;
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
check('a photo is served with its metadata cut out as it streams, nothing kept but the cut, a replaced file cut afresh, the small copy as it is, and an unknown key is not found',
  same(served, stripImage(firstShot, 'image/jpeg').bytes) && !Buffer.from(served).includes('iPhone') &&
  same(servedAgain, stripImage(secondShot, 'image/jpeg').bytes) && plansKept === 1 && !bucket.has(own + '.c') &&
  thumb[2] === 0x03 && (await get('/api/albums/file?key=alb/nope')).status === 404,
  JSON.stringify({ served: served.length, servedAgain: servedAgain.length, plansKept }));
// many thumbnails in one answer (thumbs.ts): a length, the parts as JSON, their bytes
{
  const unpack = buf => {
    const n = new DataView(buf).getUint32(0);
    const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, n)));
    let at = 4 + n;
    return head.parts.map(p => { if (p.missing) return null; const b = new Uint8Array(buf, at, p.size); at += p.size; return b; });
  };
  const batch = await get('/api/thumbs?k=' + encodeURIComponent(own) + '&v=&k=alb%2Fnope&v=&k=msg%2Felsewhere&v=');
  const parts = unpack(await batch.arrayBuffer());
  const whole = await get('/api/thumbs?k=' + encodeURIComponent(own) + '&v=');
  const tooMany = await get('/api/thumbs?' + Array.from({ length: 31 }, () => 'k=' + encodeURIComponent(own)).join('&'));
  check('a batch of thumbnails holds what the single route serves for each key and nothing for a key it would not serve, kept for good only when nothing is missing',
    parts.length === 3 && !!parts[0] && same(parts[0], thumb) && parts[1] === null && parts[2] === null &&
    batch.headers.get('cache-control') === 'public, max-age=300' && /immutable/.test(whole.headers.get('cache-control') || '') &&
    tooMany.status === 400,
    JSON.stringify({ parts: parts.map(p => p && p.length), cc: batch.headers.get('cache-control'), whole: whole.headers.get('cache-control'), tooMany: tooMany.status }));
}

// A photo's address opened the way a browser opens a page — which is
// also how a browser asks again for a picture it is saving — is the
// photo at the ?key= address the viewers use, and the page only at the
// named address people are given; the page's own picture is asked for
// at an address that is never a page.
const asPage = { headers: { 'sec-fetch-dest': 'document', accept: 'text/html,application/xhtml+xml' } };
const keyAddress = await front('/api/albums/file?key=' + encodeURIComponent(own), asPage);
const namedPage = await front('/api/albums/file/' + own + '/photo.jpg', asPage);
const pageHtml = namedPage.status === 200 ? await namedPage.text() : '';
const pictureSrc = ((pageHtml.match(/<img id="ph-i" src="([^"]+)"/) || [])[1] || '').replace(/&amp;/g, '&');
const savedFromPage = pictureSrc ? await front(new URL(pictureSrc).pathname + new URL(pictureSrc).search, asPage) : null;
// Safari asks for a download link the way it opens a page
const saveHref = ((pageHtml.match(/class="ph-save[^"]*" href="([^"]+)"/) || [])[1] || '').replace(/&amp;/g, '&');
const downloaded = saveHref ? await front(new URL(saveHref).pathname + new URL(saveHref).search, asPage) : null;
check('a photo saved from a viewer, from its page or with its page\'s Download is the photo, and only the address people are given opens the page',
  keyAddress.status === 200 && (keyAddress.headers.get('content-type') || '').startsWith('image/') &&
  (namedPage.headers.get('content-type') || '').startsWith('text/html') && /raw=1/.test(pictureSrc) &&
  !!savedFromPage && savedFromPage.status === 200 && (savedFromPage.headers.get('content-type') || '').startsWith('image/') &&
  !!downloaded && downloaded.status === 200 && (downloaded.headers.get('content-type') || '').startsWith('image/') &&
  /attachment/.test(downloaded.headers.get('content-disposition') || ''),
  JSON.stringify({ key: keyAddress.headers.get('content-type'), named: namedPage.headers.get('content-type'), pictureSrc,
    saved: savedFromPage && savedFromPage.headers.get('content-type'), saveHref,
    downloaded: downloaded && [downloaded.headers.get('content-type'), downloaded.headers.get('content-disposition')] }));

// the small copy and the viewing copy the page makes ride with the photo
const withCopies = new FormData();
withCopies.append('a', 'team-photos');
withCopies.append('files', jpeg('g.jpg'), 'g.jpg');
// a JPEG whose picture data is two bytes of `mark`, to tell the copies apart
const marked = (mark, name) => new File([new Uint8Array([0xFF, 0xD8, 0xFF, 0xDA, 0x00, 0x02, mark, mark, 0xFF, 0xD9])], name, { type: 'image/jpeg' });
withCopies.append('thumb0', marked(0x07, 'thumb.jpg'));
withCopies.append('view0', marked(0x08, 'view.jpg'));
withCopies.append('w0', '1600');
withCopies.append('h0', '1200');
await front('/api/album/upload', { method: 'POST', headers: { authorization: 'Bearer ' + team }, body: withCopies });
const copied = raw.prepare("SELECT r2_key FROM album_photos WHERE name = 'g.jpg'").get().r2_key;
const small = new Uint8Array(await (await get('/api/albums/file?key=' + encodeURIComponent(copied) + '&thumb=1')).arrayBuffer());
const viewing = new Uint8Array(await (await get('/api/albums/file?key=' + encodeURIComponent(copied) + '&res=1080')).arrayBuffer());
const measured = (await (await get('/api/album?a=team-photos')).json()).photos.find(p => p.key === copied);
check('the small and viewing copies sent with a photo as thumb0 and view0 are kept and served, and its size is in the list',
  small.includes(0x07) && viewing.includes(0x08) && measured.w === 1600 && measured.h === 1200,
  JSON.stringify([Array.from(small), Array.from(viewing), measured]));
raw.prepare('DELETE FROM album_photos WHERE r2_key = ?').run(copied);

const albumId = made.albums[0].id;
await post('/api/console/album/photo/remove', { id: albumId, key: 'sub/galleryone' }, admin);
await post('/api/console/album/photo/remove', { id: albumId, key: own }, admin);
const after = (await (await get('/api/album?a=team-photos')).json()).photos.map(p => p.key);
const dash = (await (await get('/api/console/album?id=' + albumId, admin)).json()).photos;
await post('/api/console/album/photo/remove', { id: albumId, key: 'sub/galleryone', back: true }, admin);
const back = (await (await get('/api/album?a=team-photos')).json()).photos.map(p => p.key);
check('an organiser takes a photo out: an upload is deleted, a gallery one is kept out of the album and can be put back',
  !after.includes('sub/galleryone') && !after.includes(own) && !bucket.has(own) && !bucket.has(own + '.c') &&
  dash.some(p => p.key === 'sub/galleryone' && p.skipped) && dash.some(p => p.hidden_team) && back.includes('sub/galleryone'),
  JSON.stringify({ after, back }));

// an album's video goes through the proof videos' encoder, and is on the
// site once its copies are made
const enc = (path, body) => front('/api/encoder/' + path, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer enc-key' },
  body: JSON.stringify(Object.assign({ name: 'laptop' }, body))
});
const encPut = (query, bytes) => front('/api/encoder/rendition?name=laptop&' + query, {
  method: 'PUT', headers: { authorization: 'Bearer enc-key' }, body: bytes
});
await upload('team-photos', [new File([new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 1, 2, 3, 4])], 'clip.mp4', { type: 'video/mp4' })], team);
const clip = raw.prepare("SELECT r2_key FROM album_photos WHERE name = 'clip.mp4'").get().r2_key;
const beforeEncode = (await (await get('/api/album?a=team-photos')).json()).photos.find(p => p.key === clip);
const queued = (await (await enc('poll', {})).json()).jobs.map(j => j.key);
const claimed = (await enc('claim', { key: clip })).status;
const source = (await front('/api/encoder/source?key=' + encodeURIComponent(clip), { headers: { authorization: 'Bearer enc-key' } })).status;
await encPut('key=' + encodeURIComponent(clip) + '&height=720', new Uint8Array([7, 2, 0]));
// mid-encode, the 720 copy stands in for a 1080 and for the clean copy,
// and the address will answer otherwise once the encoder is done
const clipAsk = (extra) => get('/api/albums/file?key=' + encodeURIComponent(clip) + (extra || ''));
const midHeight = (await clipAsk('&res=1080')).headers.get('cache-control');
const midWhole = (await clipAsk()).headers.get('cache-control');
await encPut('key=' + encodeURIComponent(clip) + '&height=clean', new Uint8Array([7, 0, 0]));
await enc('finish', { key: clip, heights: [720] });
const doneHeight = (await clipAsk('&res=1080')).headers.get('cache-control');
check('an album video\'s nearest height is kept by nobody while the encoder is at work, and for good once it is done',
  midHeight === 'private, no-store' && midWhole === 'private, no-store' && /immutable/.test(doneHeight || ''),
  JSON.stringify({ midHeight, midWhole, doneHeight }));
const afterEncode = (await (await get('/api/album?a=team-photos')).json()).photos.find(p => p.key === clip);
const at720 = new Uint8Array(await (await get('/api/albums/file?key=' + encodeURIComponent(clip) + '&res=720')).arrayBuffer());
const whole = new Uint8Array(await (await get('/api/albums/file?key=' + encodeURIComponent(clip))).arrayBuffer());
check('an album video waits in the encoder\'s queue listed as processing with nothing to share, and once its copies are made plays on the site at the height asked for',
  !!beforeEncode && beforeEncode.processing === true && !beforeEncode.share && !afterEncode.processing && !!afterEncode.share && queued.includes(clip) && claimed === 200 && source === 200 && !!afterEncode && afterEncode.type === 'video/mp4' &&
  at720[1] === 2 && whole[1] === 0, JSON.stringify({ beforeEncode, queued, claimed, source, at720: Array.from(at720), whole: Array.from(whole) }));
// before the encoder reaches one, the page plays it as it was sent, with
// what the phone wrote into it blanked
{
  const box = (type, ...parts) => {
    const body = Buffer.concat(parts.map(p => Buffer.from(p)));
    const head = Buffer.alloc(8);
    head.writeUInt32BE(8 + body.length, 0);
    head.write(type, 4, 'latin1');
    return Buffer.concat([head, body]);
  };
  const PLACE = '+33.8688+151.2093/';
  const mdat = box('mdat', Buffer.alloc(64, 7));
  const movie = Buffer.concat([
    box('ftyp', 'qt  ', Buffer.alloc(4), 'qt  '),
    mdat,
    box('moov', box('mvhd', Buffer.alloc(100, 1)), box('udta', box('©xyz', PLACE)), box('meta', 'iPhone 15 ' + PLACE))
  ]);
  await upload('team-photos', [new File([movie], 'IMG_2.mov', { type: 'video/quicktime' })], team);
  const mov = raw.prepare("SELECT r2_key FROM album_photos WHERE name = 'IMG_2.mov'").get().r2_key;
  const listedMov = (await (await get('/api/album?a=team-photos')).json()).photos.find(p => p.key === mov);
  const sent = await get('/api/albums/file?key=' + encodeURIComponent(mov) + '&uploaded=1');
  const sentBytes = Buffer.from(await sent.arrayBuffer());
  const plainMov = await get('/api/albums/file?key=' + encodeURIComponent(mov));
  check('an album video the encoder has not reached is served as it was sent with uploaded=1, its location and phone blanked and every other byte where it was; the plain address still serves no original',
    !!listedMov && listedMov.processing === true && sent.status === 200 && sentBytes.length === movie.length &&
    !sentBytes.includes(PLACE) && !sentBytes.includes('iPhone') && sentBytes.includes(mdat) && plainMov.status === 404,
    JSON.stringify({ listed: listedMov, sent: sent.status, len: [sentBytes.length, movie.length], plain: plainMov.status }));
  await post('/api/console/album/photo/remove', { id: made.albums[0].id, key: mov }, admin);
}
// a video's sizes, for a player to offer, and its own page with the
// player on it, which is where a shared video's link goes
const listed = (await (await get('/api/album?a=team-photos')).json()).photos.find(p => p.key === clip);
const viewPage = await get('/view/' + clip + '/clip.mp4');
const viewHtml = await viewPage.text();
check('a video in an album lists the sizes it was encoded at, and /view/ opens it on a page with a player; nothing else opens there',
  JSON.stringify(listed && listed.heights) === '[720]' && viewPage.status === 200 &&
  /property="og:video" content="[^"]+\/clip\.mp4\?res=1080"/.test(viewHtml) && viewHtml.includes('"heights":[720]') &&
  viewHtml.includes('/assets/video-sizes.js') &&
  (await get('/view/sub/nothinghere12345/x.mp4')).status === 404 && (await get('/view/alb/x')).status === 404,
  JSON.stringify({ heights: listed && listed.heights, status: viewPage.status }));
const renditionKeys = raw.prepare('SELECT key FROM submission_renditions WHERE file_key = ?').all(clip).map(r => r.key);
await post('/api/console/album/photo/remove', { id: made.albums[0].id, key: clip }, admin);
check('deleting an album video deletes its smaller copies with it',
  renditionKeys.length === 1 && !bucket.has(renditionKeys[0]) && !bucket.has(clip + '.c') &&
  raw.prepare('SELECT COUNT(*) AS n FROM submission_renditions WHERE file_key = ?').get(clip).n === 0, JSON.stringify(renditionKeys));

// a video too big for one request: named in the upload, its bytes after
const bigForm = new FormData();
bigForm.append('a', 'team-photos');
bigForm.append('bigfiles', JSON.stringify([{ name: 'long.mp4', type: 'video/mp4', size: 30 * 1024 * 1024, w: 1920, h: 1080 }]));
const started = await (await front('/api/album/upload', { method: 'POST', headers: { authorization: 'Bearer ' + team }, body: bigForm })).json();
const u = started.uploads && started.uploads[0];
const sliceUrl = (n, token) => '/api/album/upload/part?file=' + u.file + '&token=' + encodeURIComponent(token) + '&n=' + n;
const wrongToken = (await front(sliceUrl(1, 'not-the-token'), { method: 'PUT', body: new Uint8Array(u.part_size) })).status;
const slice1 = (await front(sliceUrl(1, u.token), { method: 'PUT', body: new Uint8Array(u.part_size) })).status;
const slice2 = (await front(sliceUrl(2, u.token), { method: 'PUT', body: new Uint8Array(30 * 1024 * 1024 - u.part_size) })).status;
const finished = (await post('/api/album/upload/finish', { file: u.file, token: u.token })).status;
const longRow = raw.prepare('SELECT r2_key, status, width, height FROM album_photos WHERE id = ?').get(u.file);
check('a video too big to send whole comes in slices carrying the token its upload handed back, and nothing else does',
  wrongToken === 404 && slice1 === 200 && slice2 === 200 && finished === 200 && longRow.status === 'ready' &&
  longRow.width === 1920 && bucket.get(longRow.r2_key).length === 30 * 1024 * 1024 &&
  (await (await enc('poll', {})).json()).jobs.some(j => j.key === longRow.r2_key),
  JSON.stringify({ wrongToken, slice1, slice2, finished, longRow }));

// a photo too big to send whole goes the same way, and has to be a photo
async function sliced(name, type, first) {
  const form = new FormData();
  form.append('a', 'team-photos');
  form.append('bigfiles', JSON.stringify([{ name, type, size: 26 * 1024 * 1024 }]));
  const up = (await (await front('/api/album/upload', { method: 'POST', headers: { authorization: 'Bearer ' + team }, body: form })).json()).uploads[0];
  const one = new Uint8Array(up.part_size);
  one.set(first);
  await front('/api/album/upload/part?file=' + up.file + '&token=' + encodeURIComponent(up.token) + '&n=1', { method: 'PUT', body: one });
  await front('/api/album/upload/part?file=' + up.file + '&token=' + encodeURIComponent(up.token) + '&n=2', { method: 'PUT', body: new Uint8Array(26 * 1024 * 1024 - up.part_size) });
  return { status: (await post('/api/album/upload/finish', { file: up.file, token: up.token })).status, row: raw.prepare('SELECT status FROM album_photos WHERE id = ?').get(up.file) };
}
const bigPhoto = await sliced('huge.png', 'image/png', [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const notPhoto = await sliced('fake.jpg', 'image/jpeg', [0x3C, 0x68, 0x74, 0x6D, 0x6C, 0x3E]);
check('a photo too big to send whole comes in slices as well, and one whose first bytes are not a photo is refused and dropped',
  bigPhoto.status === 200 && bigPhoto.row.status === 'ready' && notPhoto.status === 400 && !notPhoto.row,
  JSON.stringify({ bigPhoto, notPhoto }));

// one photo shared on its own: a page of its own for a chat app to
// preview, with nothing of the album on it
const shown = (await (await get('/api/album?a=team-photos')).json()).photos;
const upload1 = shown.find(p => p.from === 'album' && p.type === 'image/jpeg');
const fromGallery = shown.find(p => p.from === 'gallery');
const sharePage = await get('/photo/' + upload1.share);
const shareHtml = await sharePage.text();
const picture = (shareHtml.match(/property="og:image" content="([^"]+)"/) || [])[1] || '';
const named = await get(new URL(picture.replace(/&amp;/g, '&')).pathname + new URL(picture.replace(/&amp;/g, '&')).search);
const galleryShare = (await get('/photo/' + fromGallery.share)).status;
await post('/api/console/album/photo/remove', { id: made.albums[0].id, key: fromGallery.key }, admin);
const galleryOut = (await get('/photo/' + fromGallery.share)).status;
await post('/api/console/album/photo/remove', { id: made.albums[0].id, key: fromGallery.key, back: true }, admin);
check('a photo shared on its own is a page a chat app can preview, naming no album, and ends when the photo leaves the albums',
  sharePage.status === 200 && /summary_large_image/.test(shareHtml) && /\/api\/albums\/file\/alb\/[^/]+\/photo\.jpg\?res=1080/.test(picture) &&
  named.status === 200 && !shareHtml.includes('team-photos') && !shareHtml.includes('Team Photos') &&
  galleryShare === 200 && galleryOut === 404 && (await get('/photo/not-a-photo')).status === 404,
  JSON.stringify({ status: sharePage.status, picture, named: named.status, galleryShare, galleryOut }));

// an album seen only by those with its link
await post('/api/console/albums/save', { name: 'After Party', adding: 'teams', visibility: 'link' }, admin);
const party = (await (await get('/api/console/albums', admin)).json()).albums.find(a => a.name === 'After Party');
const partyForm = new FormData();
partyForm.append('k', party.link_key);
partyForm.append('files', jpeg('party.jpg'), 'party.jpg');
const partyUpload = (await front('/api/album/upload', { method: 'POST', headers: { authorization: 'Bearer ' + team }, body: partyForm })).status;
const byKey = await get('/api/album?k=' + party.link_key);
check('an album shown only with its link is off the list and not at its name, and opens and takes photos at its link',
  party.visibility === 'link' && party.link_key.length >= 12 &&
  !(await (await get('/api/albums')).json()).albums.some(a => a.slug === party.slug) &&
  (await get('/api/album?a=' + party.slug)).status === 404 && byKey.status === 200 &&
  (await byKey.json()).photos.length === 1 && partyUpload === 200 && !('link_key' in (await (await get('/api/album?k=' + party.link_key)).json()).album),
  JSON.stringify({ party, partyUpload }));

// an address adding to an open album is held to forty photos an hour
let lastStatus = 0;
for (let i = 0; i < 4; i++) lastStatus = (await upload('everyone', Array.from({ length: 10 }, (_, n) => jpeg('p' + i + n + '.jpg')), null, {}, '198.51.100.7')).status;
const over = (await upload('everyone', [jpeg('one-more.jpg')], null, {}, '198.51.100.7')).status;
const otherPlace = (await upload('everyone', [jpeg('elsewhere.jpg')], null, {}, '198.51.100.8')).status;
check('one address can add forty photos an hour to an album open to anyone, and no more',
  lastStatus === 200 && over === 429 && otherPlace === 200, JSON.stringify({ lastStatus, over, otherPlace }));
// the Settings tab moves the line: at 45 the same address has five more
const raised = await (await post('/api/console/limits/set', { limits: { album_anyone_per_hour: 45 } }, admin)).json();
const fiveMore = (await upload('everyone', Array.from({ length: 5 }, (_, n) => jpeg('more' + n + '.jpg')), null, {}, '198.51.100.7')).status;
const sixth = (await upload('everyone', [jpeg('sixth.jpg')], null, {}, '198.51.100.7')).status;
check('the hourly number is the one the Settings tab holds',
  raised.limits && raised.limits.album_anyone_per_hour === 45 && fiveMore === 200 && sixth === 429,
  JSON.stringify({ raised: raised.limits, fiveMore, sixth }));

// a team signed in is known, so on an open album it is not held to the
// number and leaves its address's allowance to everyone else there
await post('/api/console/limits/set', { limits: { album_anyone_per_hour: 2 } }, admin);
const asTeam = (await upload('everyone', [jpeg('t1.jpg'), jpeg('t2.jpg'), jpeg('t3.jpg')], team, {}, '198.51.100.9')).status;
const sameRoom = (await upload('everyone', [jpeg('r1.jpg'), jpeg('r2.jpg')], null, {}, '198.51.100.9')).status;
const pastIt = (await upload('everyone', [jpeg('r3.jpg')], null, {}, '198.51.100.9')).status;
await post('/api/console/limits/set', { limits: { album_anyone_per_hour: 45 } }, admin);
check('a team signed in on an open album is not counted by its address, and uses up none of the address\'s number',
  asTeam === 200 && sameRoom === 200 && pastIt === 429, JSON.stringify({ asTeam, sameRoom, pastIt }));

// The page sends a file to a request and the person check is good for
// one, so the upload that passes it hands back a pass for that album
// from that address, which the rest of the pick carries instead.
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).includes('challenges.cloudflare.com')) {
    return new Response(JSON.stringify({ success: JSON.parse(init.body).response === 'good-token' }), { headers: { 'content-type': 'application/json' } });
  }
  return realFetch(url, init);
};
Object.assign(ENV, { TURNSTILE_SECRET: 'ts-secret', TURNSTILE_SITE_KEY: 'ts-site' });
await post('/api/console/albums/save', { name: 'Open Two', adding: 'anyone' }, admin);
const here = '192.0.2.44';
const noCheck = (await upload('everyone', [jpeg('q0.jpg')], null, {}, here)).status;
const checked = await (await upload('everyone', [jpeg('q1.jpg')], null, { turnstile: 'good-token' }, here)).json();
const withPass = (await upload('everyone', [jpeg('q2.jpg')], null, { pass: checked.pass }, here)).status;
const passElsewhere = (await upload('everyone', [jpeg('q3.jpg')], null, { pass: checked.pass }, '192.0.2.45')).status;
const passOtherAlbum = (await upload('open-two', [jpeg('q4.jpg')], null, { pass: checked.pass }, here)).status;
const forged = (await upload('everyone', [jpeg('q5.jpg')], null, { pass: checked.pass.replace(/^\d+/, n => String(Number(n) + 600)) }, here)).status;
delete ENV.TURNSTILE_SECRET;
delete ENV.TURNSTILE_SITE_KEY;
globalThis.fetch = realFetch;
check('an album open to anyone asks for the person check once, and its pass covers that album from that address only',
  noCheck === 400 && checked.ok && /^\d+\.[\w-]+$/.test(checked.pass || '') && withPass === 200 &&
  passElsewhere === 400 && passOtherAlbum === 400 && forged === 400,
  JSON.stringify({ noCheck, checked, withPass, passElsewhere, passOtherAlbum, forged }));

await post('/api/console/accounts/save', { create: true, name: 'Reviewer', password: 'reviewer-pass-1', perms: ['review'], require_2fa: false }, admin);
const reviewer = (await (await post('/api/console/login', { name: 'Reviewer', password: 'reviewer-pass-1' })).json()).session;
const refused = [(await get('/api/console/albums', reviewer)).status, (await post('/api/console/albums/save', { name: 'Nope' }, reviewer)).status];
const delNoConfirm = (await post('/api/console/albums/delete', { id: made.albums[1].id }, admin)).status;
const delConfirm = (await post('/api/console/albums/delete', { id: made.albums[1].id, confirm: 'everyone' }, admin)).status;
check('albums are for accounts with the Files tab, and deleting one with photos takes its name typed',
  refused.join() === '403,403' && delNoConfirm === 428 && delConfirm === 200 &&
  !(await (await get('/api/albums')).json()).albums.some(a => a.slug === 'everyone') &&
  raw.prepare('SELECT COUNT(*) AS n FROM album_photos WHERE album_id = ?').get(made.albums[1].id).n === 0,
  JSON.stringify({ refused, delNoConfirm, delConfirm }));

// an album set to show hidden teams shows what they add, and says
// nothing to them about it
const teamAlbum = made.albums[0];
const hiddenBefore = (await (await get('/api/album?a=team-photos')).json()).photos.some(p => p.team === 'Test Team');
await post('/api/console/albums/save', { id: teamAlbum.id, name: 'Team Photos', about: 'From the day.', adding: 'teams', gallery: true, show_hidden: true }, admin);
const shownNow = (await (await get('/api/album?a=team-photos')).json()).photos.filter(p => p.team === 'Test Team');
const toldNow = await (await upload('team-photos', [jpeg('t2.jpg')], testTeam)).json();
const sharedNow = shownNow[0] ? (await get('/photo/' + shownNow[0].share)).status : 0;
await post('/api/console/albums/save', { id: teamAlbum.id, name: 'Team Photos', about: 'From the day.', adding: 'teams', gallery: true, show_hidden: false }, admin);
const sharedAfter = shownNow[0] ? (await get('/photo/' + shownNow[0].share)).status : 0;
check('an album set to show hidden teams shows their photos and lets them be shared, and tells the team nothing; set back, it hides them again',
  !hiddenBefore && shownNow.length >= 1 && toldNow.ok && !toldNow.hidden_team && sharedNow === 200 && sharedAfter === 404 &&
  !(await (await get('/api/album?a=team-photos')).json()).photos.some(p => p.team === 'Test Team'),
  JSON.stringify({ hiddenBefore, shown: shownNow.length, toldNow, sharedNow, sharedAfter }));

// a shared file's page carries its quest's details only while the
// public quest list would
raw.exec("INSERT INTO quest_groups (key, name, description) VALUES ('SQ8', 'Station hop', 'Visit **three** stations')");
raw.exec("UPDATE quests SET group_id = (SELECT id FROM quest_groups WHERE key = 'SQ8') WHERE code = 'SQ8'");
// each change made here moves the quests' version, as a dashboard quest write does
const questsMoved = () => raw.exec("INSERT INTO counters (name, value) VALUES ('quests', 1) ON CONFLICT(name) DO UPDATE SET value = value + 1");
questsMoved();
const questShown = await (await get('/view/sub/galleryone/p.jpg')).text();
raw.exec("UPDATE quest_groups SET hidden = 1 WHERE key = 'SQ8'");
questsMoved();
const questKept = await (await get('/view/sub/galleryone/p.jpg')).text();
check('a shared file\'s page shows its quest while the public can see the quest, and nothing of it once the quest is hidden',
  questShown.includes('id="ph-quest-open"') && questShown.includes('Station hop') && questShown.includes('<strong>three</strong>') &&
  !questKept.includes('id="ph-quest-open"') && !questKept.includes('Station hop') && !questKept.includes('three'), '');

// An album that shows details: when each photo was taken and the order
// that makes, the original for a full view or a download, and what the
// photo says about itself, a gallery photo's too. One that does not
// keeps the times and the originals back and still gives the order.
await post('/api/console/albums/save', { name: 'Details On', adding: 'teams', gallery: true }, admin);
await post('/api/console/albums/save', { name: 'Details Off', adding: 'teams', details: false }, admin);
const camera = () => new File([cameraJpeg()], 'camera.jpg', { type: 'image/jpeg' });
await upload('details-on', [jpeg('plain.jpg')], team);
await upload('details-on', [camera()], team);
await upload('details-off', [camera()], team);
bucket.set('sub/galleryone', cameraJpeg());
const onList = (await (await get('/api/album?a=details-on')).json());
const offList = (await (await get('/api/album?a=details-off')).json());
const shot = onList.photos.find(p => p.from === 'album' && p.taken);
const plainOne = onList.photos.find(p => p.from === 'album' && !p.taken);
const offShot = offList.photos[0];
const onByTaken = (await (await get('/api/album?a=details-on&order=taken')).json()).photos.map(p => p.key);
const offByTaken = await (await get('/api/album?a=details-off&order=taken')).json();
const bytesOf = async (path) => Buffer.from(await (await get(path)).arrayBuffer());
const origOn = await bytesOf('/api/albums/file?key=' + encodeURIComponent(shot.key) + '&orig=1');
const saved = await get('/api/albums/file?key=' + encodeURIComponent(shot.key) + '&orig=1&download=1');
const origOff = await bytesOf('/api/albums/file?key=' + encodeURIComponent(offShot.key) + '&orig=1');
const origGallery = await bytesOf('/api/albums/file?key=sub%2Fgalleryone&orig=1');
const info = await (await get('/api/albums/info?key=' + encodeURIComponent(shot.key))).json();
const galleryInfo = await (await get('/api/albums/info?key=sub%2Fgalleryone')).json();
check('an album showing details lists when each photo was taken and the order that makes, hands out the original and says what the photo does about itself; one that does not keeps all that back but the order',
  onList.album.details === true && offList.album.details === false &&
  shot.taken === '2026-10-19 22:14:02' && onList.photos.indexOf(shot) < onList.photos.indexOf(plainOne) &&
  onByTaken.indexOf(shot.key) > onByTaken.indexOf(plainOne.key) &&
  origOn.includes('Apple') && (saved.headers.get('content-disposition') || '').includes('attachment') &&
  info.camera === 'Apple iPhone 15 Pro' && info.fnumber === 1.78 && info.iso === 80 && info.offset === '+11:00' &&
  info.gps.lat === -33.883 && info.gps.alt === 52 && info.taken === '2026-10-19 22:14:02' && info.by === 'Galahs' &&
  origGallery.includes('Apple') && galleryInfo.quest === 'SQ8' &&
  !('taken' in offShot) && offByTaken.order === 'added' &&
  JSON.stringify(offByTaken.photos.map(p => p.key)) === JSON.stringify(offList.photos.map(p => p.key)) &&
  !offByTaken.photos.some(p => 'taken' in p) && !origOff.includes('Apple') && origOff.length > 0 &&
  (await get('/api/albums/info?key=' + encodeURIComponent(offShot.key))).status === 404 &&
  (await get('/api/albums/file?key=sub%2Fnotopted&orig=1')).status === 404,
  JSON.stringify({ shot, plainOne, offShot, info, galleryQuest: galleryInfo.quest }));

// An album opens in its own order, recently added or date taken, unless
// the page asks for the other; an album not showing details is always in
// the order photos were added.
{
  const albumsNow = (await (await get('/api/console/albums', admin)).json()).albums;
  const onRow = albumsNow.find(a => a.slug === 'details-on');
  const offRow = albumsNow.find(a => a.slug === 'details-off');
  const save = (row, extra) => post('/api/console/albums/save', Object.assign({
    id: row.id, name: row.name, adding: row.adding, gallery: row.gallery, details: row.details, teams: row.teams, visibility: row.visibility
  }, extra), admin);
  await save(onRow, { order: 'taken' });
  await save(offRow, { order: 'taken' });
  const opened = await (await get('/api/album?a=details-on')).json();
  const asked = await (await get('/api/album?a=details-on&order=added')).json();
  const byTaken = (await (await get('/api/album?a=details-on&order=taken')).json()).photos.map(p => p.key);
  const byAdded = (await (await get('/api/album?a=details-off&order=added')).json()).photos.map(p => p.key);
  await save(onRow, {});
  const kept = (await (await get('/api/console/albums', admin)).json()).albums.find(a => a.slug === 'details-on');
  const offOpened = await (await get('/api/album?a=details-off')).json();
  check('an album opens in the order set for it and the page can still ask for the other; one not showing details opens by when photos were added; an edit that does not say keeps it',
    onRow.default_order === 'added' && opened.order === 'taken' && opened.album.default_order === 'taken' &&
    JSON.stringify(opened.photos.map(p => p.key)) === JSON.stringify(byTaken) && byTaken.join() !== asked.photos.map(p => p.key).join() &&
    asked.order === 'added' && JSON.stringify(asked.photos.map(p => p.key)) === JSON.stringify(onList.photos.map(p => p.key)) &&
    kept.default_order === 'taken' && offOpened.order === 'added' && JSON.stringify(offOpened.photos.map(p => p.key)) === JSON.stringify(byAdded),
    JSON.stringify({ opened: opened.order, asked: asked.order, kept: kept.default_order, off: offOpened.order }));
  await save(onRow, { order: 'added' });
}

// A shared photo's page offers its details under the same rule: an album
// showing details holds it, a gallery photo's too, and one that does not
// has no button and no address to ask.
{
  const pageOf = async (path) => (await get(path)).text();
  const onPage = await pageOf('/photo/' + shot.share);
  const galleryPage = await pageOf('/view/sub/galleryone/photo.jpg');
  const offPage = await pageOf('/photo/' + offShot.share);
  check('a shared photo\'s page offers Details only where an album showing details holds the photo',
    onPage.includes('id="ph-info-open"') && onPage.includes('/api/albums/info?key=' + encodeURIComponent(shot.key)) &&
    galleryPage.includes('id="ph-info-open"') &&
    !offPage.includes('id="ph-info') && !offPage.includes('/api/albums/info') && offPage.includes('id="ph-share"'),
    JSON.stringify({ on: onPage.includes('ph-info-open'), gallery: galleryPage.includes('ph-info-open'), off: offPage.includes('id="ph-info') }));
}

// A PNG has its EXIF in an eXIf chunk only some of the time: ImageMagick
// and GIMP write it as hex in a compressed text chunk, and Apple and
// Adobe write XMP. The details read both, the time is listed at once,
// a block from before that said nothing is read again, and the copy
// served carries none of it.
{
  const be = (v) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  const txt = (t) => [...t].map(c => c.charCodeAt(0));
  const chunk = (type, data) => [...be(data.length), ...txt(type), ...data, 0, 0, 0, 0];
  const png = (type, data) => new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    ...chunk('IHDR', [...be(4), ...be(4), 8, 2, 0, 0, 0]), ...chunk(type, data),
    ...chunk('IDAT', [...deflateSync(new Uint8Array(52))]), ...chunk('IEND', [])]);
  const exif = buildExif();
  const profile = '\nexif\n' + String(exif.length).padStart(8) + '\n' + Buffer.from(exif).toString('hex').replace(/(.{72})/g, '$1\n') + '\n';
  const magick = png('zTXt', [...txt('Raw profile type exif'), 0, 0, ...deflateSync(Buffer.from(profile))]);
  const packet = '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" ' +
    'xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:tiff="http://ns.adobe.com/tiff/1.0/" ' +
    'exif:DateTimeOriginal="2026-10-20T13:05:40+11:00" exif:GPSLatitude="33,53.0700S" exif:GPSLongitude="151,13.2360E" tiff:Make="Apple">' +
    '<tiff:Model>iPhone 15 Pro</tiff:Model><exif:ISOSpeedRatings><rdf:Seq><rdf:li>125</rdf:li></rdf:Seq></exif:ISOSpeedRatings>' +
    '</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
  const adobe = png('iTXt', [...txt('XML:com.adobe.xmp'), 0, 0, 0, 0, 0, ...new TextEncoder().encode(packet)]);
  const keys = async () => (await (await get('/api/album?a=details-on')).json()).photos;
  const added = async (file) => {
    const before = new Set((await keys()).map(p => p.key));
    await upload('details-on', [file], team);
    return (await keys()).find(p => !before.has(p.key));
  };
  const fromMagick = await added(new File([magick], 'magick.png', { type: 'image/png' }));
  const fromAdobe = await added(new File([adobe], 'adobe.png', { type: 'image/png' }));
  const infoOf = async (key) => (await get('/api/albums/info?key=' + encodeURIComponent(key))).json();
  const magickInfo = await infoOf(fromMagick.key);
  // as a block written before the text chunks were read would be: empty
  bucket.set(fromAdobe.key + '.x', new Uint8Array(0));
  const adobeInfo = await infoOf(fromAdobe.key);
  const served = Buffer.from(await (await get('/api/albums/file?key=' + encodeURIComponent(fromAdobe.key))).arrayBuffer());
  check('a PNG\'s EXIF in a text chunk and its XMP are both read for the details, and neither is in the copy served',
    fromMagick.taken === '2026-10-19 22:14:02' && magickInfo.camera === 'Apple iPhone 15 Pro' && magickInfo.gps.lat === -33.883 &&
    fromAdobe.taken === '2026-10-20 02:05:40' && adobeInfo.camera === 'Apple iPhone 15 Pro' && adobeInfo.iso === 125 &&
    adobeInfo.offset === '+11:00' && adobeInfo.gps.lat === -33.8845 && adobeInfo.gps.lng === 151.2206 &&
    served.length > 0 && !served.includes('iPhone') && !served.includes('xmpmeta'),
    JSON.stringify({ fromMagick, magickInfo, fromAdobe, adobeInfo }));
}

// A HEIC or WebP the page made a JPEG of comes up beside it, whole or in
// slices, and is kept at .p when its first bytes say what it is. It is
// handed out only where the album shows details, as a download under its
// own type, and goes when the photo goes.
{
  const ascii = (t) => [...t].map(c => c.charCodeAt(0));
  const heicBytes = new Uint8Array([0, 0, 0, 24, ...ascii('ftypheic'), 0, 0, 0, 0, ...ascii('mif1heic'), ...new Array(200).fill(7)]);
  const mp4Bytes = new Uint8Array([0, 0, 0, 24, ...ascii('ftypisom'), 0, 0, 0, 0, ...ascii('isomavc1'), ...new Array(200).fill(7)]);
  const webpBytes = new Uint8Array([...ascii('RIFF'), 200, 0, 0, 0, ...ascii('WEBPVP8 '), ...new Array(200).fill(5)]);
  const withTwin = async (slug, twin, type) => {
    const fd = new FormData();
    fd.append('a', slug);
    fd.append('files', new File([cameraJpeg()], 'IMG_0001.jpg', { type: 'image/jpeg' }), 'IMG_0001.jpg');
    fd.append('picked0', new Blob([twin], { type }), 'IMG_0001.HEIC');
    await front('/api/album/upload', { method: 'POST', headers: { authorization: 'Bearer ' + team }, body: fd });
    return raw.prepare('SELECT r2_key, picked_type FROM album_photos ORDER BY id DESC LIMIT 1').get();
  };
  const kept = await withTwin('details-on', heicBytes, 'image/heic');
  const notHeic = await withTwin('details-on', mp4Bytes, 'image/heic');
  const keptOff = await withTwin('details-off', heicBytes, 'image/heic');
  // a JPEG too big to send whole, with the file it was picked as beside its manifest
  const bigForm = new FormData();
  bigForm.append('a', 'details-on');
  bigForm.append('bigfiles', JSON.stringify([{ name: 'wide.jpg', type: 'image/jpeg', size: 26 * 1024 * 1024 }]));
  bigForm.append('bigpicked0', new Blob([webpBytes], { type: 'image/webp' }), 'wide.webp');
  const up = (await (await front('/api/album/upload', { method: 'POST', headers: { authorization: 'Bearer ' + team }, body: bigForm })).json()).uploads[0];
  const first = new Uint8Array(up.part_size);
  first.set([0xFF, 0xD8, 0xFF, 0xDA, 0, 2]);
  await front('/api/album/upload/part?file=' + up.file + '&token=' + encodeURIComponent(up.token) + '&n=1', { method: 'PUT', body: first });
  await front('/api/album/upload/part?file=' + up.file + '&token=' + encodeURIComponent(up.token) + '&n=2', { method: 'PUT', body: new Uint8Array(26 * 1024 * 1024 - up.part_size) });
  await post('/api/album/upload/finish', { file: up.file, token: up.token });
  const wide = raw.prepare('SELECT r2_key, picked_type, status FROM album_photos WHERE id = ?').get(up.file);
  check('a HEIC or WebP sent beside its JPEG is kept at .p whether the JPEG comes whole or in slices, and one that is not what it says is left out while the photo goes in',
    kept.picked_type === 'image/heic' && Buffer.from(bucket.get(kept.r2_key + '.p')).equals(Buffer.from(heicBytes)) &&
    notHeic.picked_type === '' && !bucket.has(notHeic.r2_key + '.p') && bucket.has(notHeic.r2_key) &&
    wide.status === 'ready' && wide.picked_type === 'image/webp' && bucket.has(wide.r2_key + '.p'),
    JSON.stringify({ kept, notHeic, wide }));

  raw.prepare("UPDATE submission_files SET picked_type = 'image/heic' WHERE r2_key IN ('sub/galleryone', 'sub/notopted')").run();
  bucket.set('sub/galleryone.p', heicBytes);
  bucket.set('sub/notopted.p', heicBytes);
  const onListed = (await (await get('/api/album?a=details-on')).json()).photos;
  const offListed = (await (await get('/api/album?a=details-off')).json()).photos;
  const saved = await get('/api/albums/file?key=' + encodeURIComponent(kept.r2_key) + '&picked=1');
  const savedBytes = Buffer.from(await saved.arrayBuffer());
  const pickedStatus = async (key) => (await get('/api/albums/file?key=' + encodeURIComponent(key) + '&picked=1')).status;
  const elsewhere = [await pickedStatus(keptOff.r2_key), await pickedStatus('sub/notopted'), await pickedStatus(notHeic.r2_key),
    (await get('/api/submit/file?key=sub%2Fgalleryone&picked=1')).status];
  check('the file a photo was picked as is listed and handed out only where the album shows details, a gallery photo\'s too, as a download under its own type and name; anywhere else it is not found',
    onListed.find(p => p.key === kept.r2_key).picked === 'image/heic' && onListed.find(p => p.key === 'sub/galleryone').picked === 'image/heic' &&
    !('picked' in onListed.find(p => p.key === notHeic.r2_key)) && !offListed.some(p => 'picked' in p) &&
    saved.status === 200 && savedBytes.equals(Buffer.from(heicBytes)) && saved.headers.get('content-type') === 'image/heic' &&
    /^attachment; filename="IMG_0001\.heic"/.test(saved.headers.get('content-disposition') || '') &&
    (await pickedStatus('sub/galleryone')) === 200 && elsewhere.every(s => s === 404),
    JSON.stringify({ status: saved.status, type: saved.headers.get('content-type'), saved: saved.headers.get('content-disposition'), elsewhere }));

  const onId = raw.prepare("SELECT id FROM albums WHERE slug = 'details-on'").get().id;
  await post('/api/console/album/photo/remove', { id: onId, key: kept.r2_key }, admin);
  check('taking the photo out takes the file it was picked as with it',
    !bucket.has(kept.r2_key) && !bucket.has(kept.r2_key + '.p'), '');
  raw.prepare("UPDATE submission_files SET picked_type = '' WHERE r2_key IN ('sub/galleryone', 'sub/notopted')").run();
  bucket.delete('sub/galleryone.p');
  bucket.delete('sub/notopted.p');
}

// The dashboard's tidy deletes the cleaned copies photos used to be
// served from and reads when the photos already there were taken; a
// photo too big to read whole is still cut as it streams.
raw.prepare('UPDATE album_photos SET taken_at = NULL WHERE r2_key = ?').run(shot.key);
const bigKey = 'alb/bigpicture01';
const pngChunk = (type, data) => {
  const b = new Uint8Array(12 + data.length);
  new DataView(b.buffer).setUint32(0, data.length);
  b.set([...type].map(c => c.charCodeAt(0)), 4);
  b.set(data, 8);
  return b;
};
const bigParts = [
  new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  pngChunk('IHDR', new Uint8Array(13)),
  pngChunk('IDAT', new Uint8Array(33 * 1024 * 1024).fill(9)),
  pngChunk('tEXt', new TextEncoder().encode('Author\0someone')),
  pngChunk('IEND', new Uint8Array(0))
];
const bigPng = new Uint8Array(bigParts.reduce((n, b) => n + b.length, 0));
bigParts.reduce((at, b) => { bigPng.set(b, at); return at + b.length; }, 0);
bucket.set(bigKey, bigPng);
raw.prepare("INSERT INTO album_photos (album_id, r2_key, content_type, bytes, name) VALUES ((SELECT id FROM albums WHERE slug = 'details-off'), ?, 'image/png', ?, 'big.png')").run(bigKey, bigPng.length);
bucket.set(shot.key + '.c', new Uint8Array([0xFF, 0xD8, 0x02]));   // a cleaned copy from before photos were cut as served
raw.prepare("INSERT INTO album_photos (album_id, r2_key, content_type, bytes, name) VALUES ((SELECT id FROM albums WHERE slug = 'details-off'), 'alb/tidyclip01', 'video/mp4', 10, 'tidy.mp4')").run();
bucket.set('alb/tidyclip01', new Uint8Array(10));
bucket.set('alb/tidyclip01.c', new Uint8Array(10));            // a video's encoded copy, which is what plays
// a PNG added before its Creation Time was read: listed with no time
const stamped = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, ...pngChunk('IHDR', new Uint8Array(13)),
  ...pngChunk('tEXt', new TextEncoder().encode('Creation Time\0Tue, 21 Oct 2026 09:14:02 +1100')), ...pngChunk('IEND', new Uint8Array(0))]);
bucket.set('alb/stampedpng01', stamped);
bucket.set('alb/stampedpng01.x', new Uint8Array(0));
raw.prepare("INSERT INTO album_photos (album_id, r2_key, content_type, bytes, name, taken_at) VALUES ((SELECT id FROM albums WHERE slug = 'details-off'), 'alb/stampedpng01', 'image/png', ?, 'stamped.png', '')").run(stamped.length);
let rebuilt = { done: false, after: 0 };
for (let round = 0; round < 50 && !rebuilt.done; round++) {
  rebuilt = await (await post('/api/console/files/reclean', { after: rebuilt.after }, admin)).json();
}
const bigServed = await bytesOf('/api/albums/file?key=' + encodeURIComponent(bigKey));
check('the tidy deletes a photo\'s old cleaned copy but never a video\'s, reads when photos already in an album were taken, again for one that gave no time before, and a photo too big to read whole is cleaned as it streams',
  rebuilt.done && !bucket.has(shot.key + '.c') && bucket.has('alb/tidyclip01.c') && raw.prepare('SELECT taken_at FROM album_photos WHERE r2_key = ?').get(shot.key).taken_at === '2026-10-19 22:14:02' &&
  raw.prepare("SELECT taken_at FROM album_photos WHERE r2_key = 'alb/stampedpng01'").get().taken_at === '2026-10-20 22:14:02' &&
  bigServed.length === bigPng.length - 12 - 'Author someone'.length && !bigServed.includes('someone') && bigServed.includes('IEND'),
  JSON.stringify({ rebuilt, served: bigServed.length, was: bigPng.length }));
// Safari takes a video in an img and downloads every byte of it
const stillless = await get('/api/albums/file?key=alb%2Ftidyclip01&thumb=1');
check('a video with no still has no thumbnail, rather than the video itself', stillless.status === 404, 'status=' + stillless.status);

// ---------------- pages, and the copy kept at the edge ----------------
// An album comes a page at a time, every item once and in the order the
// whole list has; the read is kept at the edge under the albums' number,
// so an upload shows at once while a change made behind the worker's
// back waits for the copy to run out.
const entire = await (await get('/api/album?a=team-photos')).json();
let paged = [];
let pageFrom = 0;
let firstPage = null;
for (let guard = 0; pageFrom !== null && guard < 20; guard++) {
  const pg = await (await get('/api/album?a=team-photos&n=2&from=' + pageFrom)).json();
  if (!firstPage) firstPage = pg;
  paged = paged.concat(pg.photos.map(p => p.key));
  pageFrom = pg.next;
}
check('an album comes two at a time, every item once and in the order of the whole list, with the count on every page',
  entire.photos.length > 2 && JSON.stringify(paged) === JSON.stringify(entire.photos.map(p => p.key)) &&
  firstPage.next === 2 && firstPage.count === entire.photos.length && entire.next === null,
  JSON.stringify({ paged: paged.length, entire: entire.photos.length, next: firstPage.next, count: firstPage.count }));

const keptReads = new Map();
const noEdge = globalThis.caches;
globalThis.caches = { default: {
  async match(req) { const hit = keptReads.get(keyOf(req)); return hit ? new Response(hit) : undefined; },
  async put(req, res) { keptReads.set(keyOf(req), await res.arrayBuffer()); },
  async delete(req) { return keptReads.delete(keyOf(req)); }
} };
await post('/api/console/albums/save', { name: 'Edge Test', adding: 'anyone' }, admin);
await upload('edge-test', [jpeg('g.jpg')], null, { by: 'Sam' });
const edgeId = raw.prepare("SELECT id FROM albums WHERE slug = 'edge-test'").get().id;
const shownFirst = (await (await get('/api/album?a=edge-test')).json()).photos.length;
raw.prepare("INSERT INTO album_photos (album_id, r2_key, content_type, bytes, name, added_by) VALUES (?, 'alb/behindback01', 'image/jpeg', 10, 'quiet.jpg', 'Sam')").run(edgeId);
const shownKept = (await (await get('/api/album?a=edge-test')).json()).photos.length;
await upload('edge-test', [jpeg('h.jpg')], null, { by: 'Sam' });
const shownAfter = (await (await get('/api/album?a=edge-test')).json()).photos.length;
globalThis.caches = noEdge;
check('the album read is kept at the edge, and an upload moves it on at once',
  shownKept === shownFirst && shownAfter === shownFirst + 2 && [...keptReads.keys()].some(k => k.includes('/__albums/')),
  JSON.stringify({ shownFirst, shownKept, shownAfter }));

// An organiser's upload with replace on takes the place of the album's
// photo of the same name under its key, so its share link holds, and the
// time taken is read from the new file; a JPEG named as a PNG is takes
// that PNG's place and keeps the PNG to download, whole or in slices.
// Names may repeat, and a name more than one photo has is answered with
// them to pick from.
{
  await post('/api/console/albums/save', { name: 'Replace Me', adding: 'teams' }, admin);
  const albumId = raw.prepare("SELECT id FROM albums WHERE slug = 'replace-me'").get().id;
  const organiser = async (bytes, name, replace, key) => {
    const fd = new FormData();
    fd.append('id', String(albumId));
    fd.append('files', new File([bytes], name, { type: name.endsWith('.png') ? 'image/png' : 'image/jpeg' }), name);
    if (replace) fd.append('replace', '1');
    if (key) fd.append('replace_key', key);
    const res = await front('/api/console/album/upload', { method: 'POST', headers: { authorization: 'Bearer ' + admin }, body: fd });
    return { status: res.status, body: await res.json() };
  };
  const retimed = cameraJpeg();
  retimed.set([...'2026:10:20 10:30:00'].map(c => c.charCodeAt(0)), Buffer.from(retimed).indexOf('2026:10:20 09:14:02'));
  // the same photo taken later on another phone, and longer
  const later = Buffer.from(cameraJpeg(400));
  later.write('2026:10:20 10:30:00', later.indexOf('2026:10:20 09:14:02'), 'latin1');
  for (let at = later.indexOf('iPhone 15'); at !== -1; at = later.indexOf('iPhone 15', at + 1)) later.write('iPhone 16', at, 'latin1');
  const be = (v) => [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  const chunk = (type, data) => [...be(data.length), ...[...type].map(c => c.charCodeAt(0)), ...data, 0, 0, 0, 0];
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    ...chunk('IHDR', [...be(4), ...be(4), 8, 2, 0, 0, 0]), ...chunk('IDAT', [...deflateSync(new Uint8Array(52))]), ...chunk('IEND', [])]);
  const rowOf = (name) => raw.prepare('SELECT * FROM album_photos WHERE album_id = ? AND name = ?').get(albumId, name);
  await organiser(cameraJpeg(), 'IMG_0101.jpg');
  await organiser(pngBytes, 'IMG_0102.png');
  const jpgBefore = rowOf('IMG_0101.jpg');
  const pngBefore = rowOf('IMG_0102.png');
  const shareOf = async (key) => (await (await get('/api/album?a=replace-me')).json()).photos.find(p => p.key === key);
  const shared = (await shareOf(jpgBefore.r2_key)).share;
  // what the album page and a pasted link read, with the edge holding
  // the cut it served before
  const edge = new Map();
  const noEdge = globalThis.caches;
  globalThis.caches = { default: {
    async match(req) { const hit = edge.get(keyOf(req)); return hit ? new Response(hit.body, { headers: hit.headers }) : undefined; },
    async put(req, res) { edge.set(keyOf(req), { body: await res.arrayBuffer(), headers: [...res.headers] }); },
    async delete(req) { return edge.delete(keyOf(req)); }
  } };
  const infoOf = async (key) => (await get('/api/albums/info?key=' + encodeURIComponent(key))).json();
  const cutOf = async (path) => Buffer.from(await (await get(path)).arrayBuffer());
  const byKey = '/api/albums/file?key=' + encodeURIComponent(jpgBefore.r2_key);
  const byName = '/api/albums/file/' + jpgBefore.r2_key + '/IMG_0101.jpg';
  const infoBefore = await infoOf(jpgBefore.r2_key);
  const cutBefore = await cutOf(byKey);
  const sameName = await organiser(later, 'IMG_0101.jpg', true);
  const infoAfter = await infoOf(jpgBefore.r2_key);
  const cutAfter = [await cutOf(byKey), await cutOf(byName)];
  const pageStatus = (await get('/photo/' + shared)).status;
  globalThis.caches = noEdge;
  const fromPng = await organiser(cameraJpeg(), 'img_0102.jpg', true);
  const noMatch = await organiser(cameraJpeg(), 'IMG_0103.jpg', true);
  const jpgAfter = rowOf('IMG_0101.jpg');
  const pngAfter = raw.prepare('SELECT * FROM album_photos WHERE id = ?').get(pngBefore.id);
  const listed = await shareOf(jpgBefore.r2_key);
  const page = await (await get('/photo/' + shared)).text();
  const served = Buffer.from(await (await get('/api/albums/file?key=' + encodeURIComponent(pngBefore.r2_key) + '&orig=1')).arrayBuffer());
  const png = await get('/api/albums/file?key=' + encodeURIComponent(pngBefore.r2_key) + '&picked=1');
  const pngSaved = Buffer.from(await png.arrayBuffer());
  check('replacing by name keeps the key and share link, reads the new time and moves the version; a JPEG takes its PNG\'s place and keeps the PNG to download',
    sameName.status === 200 && sameName.body.added === 0 && sameName.body.replaced[0].png === false &&
    jpgAfter.r2_key === jpgBefore.r2_key && jpgAfter.version === 1 && jpgBefore.taken_at === '2026-10-19 22:14:02' &&
    jpgAfter.taken_at === '2026-10-19 23:30:00' && listed.ver === 1 && listed.share === shared && listed.taken === '2026-10-19 23:30:00' &&
    page.includes('/photo-1.jpg') &&
    fromPng.body.replaced[0].png === true && pngAfter.r2_key === pngBefore.r2_key && pngAfter.content_type === 'image/jpeg' &&
    pngAfter.name === 'img_0102.jpg' && pngAfter.picked_type === 'image/png' && served[0] === 0xFF && served[1] === 0xD8 &&
    png.status === 200 && png.headers.get('content-type') === 'image/png' && pngSaved.equals(Buffer.from(pngBytes)) &&
    /filename="img_0102\.png"/.test(png.headers.get('content-disposition') || '') &&
    noMatch.body.added === 1 && noMatch.body.replaced.length === 0,
    JSON.stringify({ sameName, fromPng, noMatch, jpgAfter: [jpgAfter.version, jpgAfter.taken_at], listed, pngAfter: [pngAfter.name, pngAfter.picked_type] }));

  check('a replacement refreshes what the album says of the photo (time, phone) and what its links serve, cut, even with the old cut kept at the edge, and the share page still opens',
    infoBefore.camera === 'Apple iPhone 15 Pro' && infoBefore.taken === '2026-10-19 22:14:02' && !!infoBefore.gps &&
    infoAfter.camera === 'Apple iPhone 16 Pro' && infoAfter.taken === '2026-10-19 23:30:00' && infoAfter.lens === 'iPhone 16 Pro back camera' &&
    cutAfter.every(b => b.subarray(-120).equals(later.subarray(-120)) && !b.includes('iPhone') && b.length > cutBefore.length) &&
    !cutBefore.subarray(-120).equals(later.subarray(-120)) && pageStatus === 200,
    JSON.stringify({ infoBefore: [infoBefore.camera, infoBefore.taken], infoAfter: [infoAfter.camera, infoAfter.taken, infoAfter.lens], cut: [cutBefore.length, cutAfter[0].length, cutAfter[1].length], pageStatus }));

  // a team cannot replace, and its photo keeps the name it was sent with
  const teamSent = await (await upload('replace-me', [jpeg('img_0101.JPG')], team, { replace: '1' })).json();
  const teamRow = rowOf('img_0101.JPG');
  const again = await organiser(cameraJpeg(), 'IMG_0103.jpg');
  const count = () => raw.prepare('SELECT COUNT(*) AS n FROM album_photos WHERE album_id = ?').get(albumId).n;
  const before = { rows: count(), keys: bucket.size };
  const ask = await organiser(retimed, 'IMG_0101.jpg', true);
  const askBigForm = new FormData();
  askBigForm.append('id', String(albumId));
  askBigForm.append('replace', '1');
  askBigForm.append('bigfiles', JSON.stringify([{ name: 'IMG_0101.jpg', type: 'image/jpeg', size: 26 * 1024 * 1024 }]));
  const askBig = await front('/api/console/album/upload', { method: 'POST', headers: { authorization: 'Bearer ' + admin }, body: askBigForm });
  const after = { rows: count(), keys: bucket.size };
  const chosen = await organiser(retimed, 'IMG_0101.jpg', true, teamRow.r2_key);
  const gone = await organiser(retimed, 'IMG_0101.jpg', true, 'alb/notinthisone1');
  const picks = ask.body.choose || [];
  check('names may repeat; a replacement two photos answer to stores nothing and lists both to pick from, whole or in slices, and sent again naming one replaces that one',
    teamSent.ok && teamRow && rowOf('IMG_0101.jpg').version === 1 && again.body.added === 1 &&
    raw.prepare("SELECT COUNT(*) AS n FROM album_photos WHERE name = 'IMG_0103.jpg'").get().n === 2 &&
    ask.status === 409 && picks.length === 2 && picks[0].key === jpgBefore.r2_key && picks[1].key === teamRow.r2_key &&
    picks[0].by === 'Alex' && picks[1].by === 'Galahs' && picks[0].taken === '2026-10-19 23:30:00' && picks[0].ver === 1 &&
    askBig.status === 409 && (await askBig.json()).choose.length === 2 && after.rows === before.rows && after.keys === before.keys &&
    chosen.status === 200 && chosen.body.replaced.length === 1 && chosen.body.added === 0 &&
    raw.prepare('SELECT version, r2_key FROM album_photos WHERE id = ?').get(teamRow.id).version === 1 &&
    rowOf('IMG_0101.jpg').version === 1 && gone.status === 404,
    JSON.stringify({ teamSent, ask: ask.body, before, after, chosen: chosen.body, gone: gone.status }));

  // a photo too big to send whole replaces a PNG in slices: the PNG is
  // kept, and nothing of the photo changes until the slices are checked
  await organiser(pngBytes, 'IMG_0106.png');
  const bigPng = rowOf('IMG_0106.png');
  const pngInfo = await (await get('/api/albums/info?key=' + encodeURIComponent(bigPng.r2_key))).json();
  const BIG = 26 * 1024 * 1024;
  const bigForm = (name) => {
    const fd = new FormData();
    fd.append('id', String(albumId));
    fd.append('replace', '1');
    fd.append('bigthumb0', new Blob([jpeg('t.jpg')], { type: 'image/jpeg' }), 'thumb.jpg');
    fd.append('bigfiles', JSON.stringify([{ name, type: 'image/jpeg', size: BIG, w: 4000, h: 3000 }]));
    return fd;
  };
  const sendSlices = async (up, first) => {
    const one = new Uint8Array(up.part_size);
    one.set(first);
    await front('/api/album/upload/part?file=' + up.file + '&token=' + encodeURIComponent(up.token) + '&n=1', { method: 'PUT', body: one });
    await front('/api/album/upload/part?file=' + up.file + '&token=' + encodeURIComponent(up.token) + '&n=2', { method: 'PUT', body: new Uint8Array(BIG - up.part_size) });
    return (await post('/api/album/upload/finish', { file: up.file, token: up.token })).json();
  };
  const startBig = async (name) => (await (await front('/api/console/album/upload', { method: 'POST', headers: { authorization: 'Bearer ' + admin }, body: bigForm(name) })).json()).uploads[0];
  // first one that is not a photo at all: refused, and the PNG untouched
  const junk = await startBig('IMG_0106.jpg');
  const junkDone = await sendSlices(junk, [1, 2, 3, 4]);
  const afterJunk = rowOf('IMG_0106.png');
  const up = await startBig('IMG_0106.jpg');
  const stagedKey = raw.prepare('SELECT r2_key FROM album_photos WHERE id = ?').get(up.file).r2_key;
  const midway = (await (await get('/api/album?a=replace-me')).json()).photos.filter(p => p.key === bigPng.r2_key).length;
  const bigDone = await sendSlices(up, retimed);
  const bigAfter = raw.prepare('SELECT * FROM album_photos WHERE id = ?').get(bigPng.id);
  const bigInfo = await (await get('/api/albums/info?key=' + encodeURIComponent(bigPng.r2_key))).json();
  const bigShare = (await (await get('/api/album?a=replace-me')).json()).photos.find(p => p.key === bigPng.r2_key);
  const stagedLeft = raw.prepare('SELECT COUNT(*) AS n FROM album_photos WHERE id IN (?, ?)').get(junk.file, up.file).n;
  check('a photo sent in slices replaces another once the slices are checked, under the same key: the PNG kept, its time read, the slices\' own row and key gone; a file that is not a photo changes nothing',
    junk.replaces && junk.replaces.png === true && junkDone.ok !== true && afterJunk.r2_key === bigPng.r2_key &&
    afterJunk.content_type === 'image/png' && afterJunk.version === 0 &&
    midway === 1 && bigDone.ok && bigDone.replaced && bigAfter.r2_key === bigPng.r2_key && bigAfter.content_type === 'image/jpeg' &&
    bigAfter.bytes === BIG && bigAfter.name === 'IMG_0106.jpg' && bigAfter.version === 1 && bigAfter.picked_type === 'image/png' &&
    bigAfter.width === 4000 && bigAfter.taken_at === '2026-10-19 23:30:00' &&
    Buffer.from(bucket.get(bigPng.r2_key + '.p')).equals(Buffer.from(pngBytes)) && bucket.get(bigPng.r2_key).length === BIG &&
    bucket.get(bigPng.r2_key)[0] === 0xFF && bucket.has(bigPng.r2_key + '.t') &&
    stagedLeft === 0 && ![...bucket.keys()].some(k => k.startsWith(stagedKey)) && /not a photo/.test(junkDone.error || '') &&
    pngInfo.camera === '' && !pngInfo.taken && bigInfo.camera === 'Apple iPhone 15 Pro' && bigInfo.taken === '2026-10-19 23:30:00' &&
    bigInfo.type === 'image/jpeg' && bigShare.share === bigPng.r2_key.slice(4) && bigShare.ver === 1,
    JSON.stringify({ junk, junkDone, up, bigDone, bigAfter: bigAfter && [bigAfter.content_type, bigAfter.bytes, bigAfter.version, bigAfter.taken_at], stagedLeft, pngInfo: [pngInfo.camera, pngInfo.taken], bigInfo: [bigInfo.camera, bigInfo.taken, bigInfo.type] }));
}

// ---------------- merged albums ----------------
// An album with others merged into it shows their uploads and their part
// of the gallery beside its own, is for organisers only whatever the save
// asked, and is opened on the site with an organiser's pass. One level:
// a merged album cannot be merged into another.
{
  const dashAlbums = async () => (await (await get('/api/console/albums', admin)).json()).albums;
  const named = async (name) => (await dashAlbums()).find(a => a.name === name);
  const add = (id, name) => {
    const fd = new FormData();
    fd.append('id', String(id));
    fd.append('files', new File([cameraJpeg()], name, { type: 'image/jpeg' }), name);
    return front('/api/console/album/upload', { method: 'POST', headers: { authorization: 'Bearer ' + admin }, body: fd });
  };
  await post('/api/console/albums/save', { name: 'Merge One', adding: 'teams' }, admin);
  await post('/api/console/albums/save', { name: 'Merge Two', adding: 'closed' }, admin);
  const one = (await named('Merge One')).id, two = (await named('Merge Two')).id, teamPhotos = (await named('Team Photos')).id;
  await add(one, 'm1.jpg');
  await add(two, 'm2.jpg');
  await post('/api/console/albums/save', { name: 'Everything', adding: 'anyone', visibility: 'link', merges: [one, two, teamPhotos, 99999] }, admin);
  const all = await named('Everything');
  await add(all.id, 'own.jpg');
  await post('/api/console/albums/save', { name: 'Nested', adding: 'closed', merges: [all.id, one] }, admin);
  const nested = await named('Nested');
  const ownKey = raw.prepare('SELECT r2_key FROM album_photos WHERE album_id = ?').get(all.id).r2_key;
  const publicKeys = async (q) => (await (await get('/api/album?' + q)).json()).photos.map(p => p.key);
  const expected = [ownKey, ...await publicKeys('a=team-photos'), ...await publicKeys('a=merge-one'), ...await publicKeys('a=merge-two')].sort().join();
  const dash = (await (await get('/api/console/album?id=' + all.id, admin)).json()).photos;
  const vias = dash.filter(p => p.from === 'album').map(p => p.via || '').sort().join();
  const passBody = await (await get('/api/console/album/pass?id=' + all.id, admin)).json();
  const pass = new URL(passBody.url).searchParams.get('pass');
  const viaPass = await (await get('/api/album?pass=' + encodeURIComponent(pass))).json();
  const passKeys = viaPass.photos.map(p => p.key).sort().join();
  const tampered = pass.slice(0, -1) + (pass.slice(-1) === 'A' ? 'B' : 'A');
  const refused = [
    (await get('/api/album?a=everything')).status,
    (await get('/api/album?k=' + all.link_key)).status,
    (await get('/api/album?pass=' + encodeURIComponent(tampered))).status,
    (await get('/api/album?pass=' + encodeURIComponent(pass.replace(/^\d+/, String(one))))).status,
    (await get('/api/console/album/pass?id=' + all.id)).status,
    (await upload('everything', [jpeg('x.jpg')], null, { by: 'Sam' })).status
  ];
  const onList = (await (await get('/api/albums')).json()).albums.some(a => a.name === 'Everything');
  check('a merged album shows its own and the merged albums\' uploads and gallery, marks where each came from, keeps the visibility it was given, and merges one level',
    all.visibility === 'link' && all.merges.slice().sort().join() === [one, two, teamPhotos].sort().join() &&
    JSON.stringify(nested.merges) === JSON.stringify([one]) &&
    expected.split(',').every(k => dash.some(p => p.key === k)) &&
    vias.includes('Merge One') && vias.includes('Merge Two') && vias.includes('Team Photos') && dash.find(p => p.key === ownKey).via === undefined &&
    !onList,
    JSON.stringify({ all, nested: nested.merges, dash: dash.map(p => [p.key, p.via, p.from]), expected, vias }));
  check('a merged album opens at its link, the dashboard\'s pass opens it with nothing added or shared through it, and a pass for another album or a changed one opens nothing',
    passBody.hours === 24 && passBody.url.indexOf('/albums/?pass=') !== -1 && passKeys === expected &&
    viaPass.album.adding === 'closed' && !viaPass.album.turnstile && viaPass.album.id === undefined && viaPass.album.merges === undefined &&
    viaPass.photos.every(p => p.share === undefined) && refused.join() === '404,200,404,404,401,404',
    JSON.stringify({ passBody, passKeys, expected, album: viaPass.album, refused }));
  // deleting an album takes it out of every album it was merged into
  await post('/api/console/albums/delete', { id: two, confirm: 'Merge Two' }, admin);
  const left = (await named('Everything')).merges.slice().sort().join();
  const afterKeys = (await (await get('/api/console/album?id=' + all.id, admin)).json()).photos.map(p => p.via || '').join();
  check('a deleted album comes off every album it was merged into, and its photos with it',
    left === [one, teamPhotos].sort().join() && !afterKeys.includes('Merge Two'), JSON.stringify({ left, afterKeys }));
  for (const [id, name] of [[nested.id, 'Nested'], [all.id, 'Everything'], [one, 'Merge One']]) {
    await post('/api/console/albums/delete', { id, confirm: name }, admin);
  }
}

// An album showing the gallery photos of the teams picked for it rather
// than the whole gallery, read live as the gallery is. Every read that
// decides whether a gallery file is in an album has to agree: the list
// and its count, the dashboard's, the original where the album shows
// details, and /photo/.
{
  // no album shows the whole gallery from here on, so the one with teams
  // picked is the only one holding a gallery photo
  raw.exec('UPDATE albums SET gallery = 0');
  raw.exec("INSERT INTO teams (id, name) VALUES (4, 'Abra'), (5, 'Stray Cats')");
  raw.exec("INSERT INTO submissions (id, team_id, quest_code, status, gallery) VALUES (40, 2, 'SQ8', 'accepted', 1), (41, 2, 'SQ8', 'pending', 1), (42, 3, 'SQ8', 'accepted', 1)");
  raw.exec("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES " +
    "(40, 'sub/rattlers01', 'image/jpeg', 10, 'r1.jpg'), (41, 'sub/rattlers02', 'image/jpeg', 10, 'r2.jpg'), (42, 'sub/testteam01', 'image/jpeg', 10, 't1.jpg')");
  bucket.set('sub/rattlers01', cameraJpeg());
  await post('/api/console/albums/save', { name: 'Rattlers', adding: 'closed', teams: [2, 3, 999] }, admin);
  const dashList = async () => (await get('/api/console/albums', admin)).json();
  const pickedAlbum = async () => (await dashList()).albums.find(a => a.name === 'Rattlers');
  const readKeys = async () => (await (await get('/api/album?a=rattlers')).json()).photos.map(p => p.key);
  const publicEntry = async () => (await (await get('/api/albums')).json()).albums.find(a => a.slug === 'rattlers');

  const form = await dashList();
  const rattlers = form.albums.find(a => a.name === 'Rattlers');
  check('the album form lists every team with how many gallery photos it has, those with any first and a hidden one marked, and an album keeps the teams picked for it',
    JSON.stringify(rattlers.teams) === '[2,3]' && !rattlers.gallery &&
    JSON.stringify(form.teams.map(t => [t.name, t.gallery, t.hidden])) ===
      JSON.stringify([['Galahs', 1, false], ['Red Rattlers', 1, false], ['Test Team', 1, true], ['Abra', 0, false], ['Stray Cats', 0, false]]),
    JSON.stringify({ teams: rattlers.teams, form: form.teams }));

  const firstRead = await readKeys();
  raw.exec("UPDATE submissions SET status = 'accepted' WHERE id = 41");
  const laterRead = await readKeys();
  const entry = await publicEntry();
  check('an album with a team picked shows that team\'s accepted gallery photos and nobody else\'s, a hidden team\'s left out; one accepted later appears; the public count and cover and the dashboard\'s count agree',
    JSON.stringify(firstRead) === '["sub/rattlers01"]' &&
    laterRead.length === 2 && laterRead.includes('sub/rattlers01') && laterRead.includes('sub/rattlers02') &&
    entry.count === 2 && entry.cover.from === 'gallery' && laterRead.includes(entry.cover.key) && (await pickedAlbum()).count === 2,
    JSON.stringify({ firstRead, laterRead, entry: [entry.count, entry.cover] }));

  await post('/api/console/album/photo/remove', { id: rattlers.id, key: 'sub/rattlers01' }, admin);
  const skippedRead = await readKeys();
  const skippedDash = (await (await get('/api/console/album?id=' + rattlers.id, admin)).json()).photos;
  const skippedCounts = [(await publicEntry()).count, (await pickedAlbum()).count];
  await post('/api/console/album/photo/remove', { id: rattlers.id, key: 'sub/rattlers01', back: true }, admin);
  check('a picked team\'s photo taken out of the album is off the site and marked on the dashboard, both counts drop, and it can be put back',
    !skippedRead.includes('sub/rattlers01') && skippedRead.includes('sub/rattlers02') &&
    skippedDash.some(p => p.key === 'sub/rattlers01' && p.from === 'gallery' && p.skipped) &&
    skippedCounts.join() === '1,1' && (await readKeys()).includes('sub/rattlers01'),
    JSON.stringify({ skippedRead, skippedCounts }));

  const original = Buffer.from(await (await get('/api/albums/file?key=sub%2Frattlers01&orig=1')).arrayBuffer());
  const about = await (await get('/api/albums/info?key=sub%2Frattlers01')).json();
  const status = async (path, token) => (await get(path, token)).status;
  const shares = [await status('/photo/g/rattlers01'), await status('/photo/g/galleryone'), await status('/photo/g/testteam01'),
    await status('/api/albums/file?key=sub%2Fgalleryone&orig=1')];
  check('a picked team\'s photo is handed out whole where the album shows details and can be shared on its own; a team not picked and a hidden team cannot',
    original.includes('Apple') && about.quest === 'SQ8' && about.by === 'Red Rattlers' && shares.join() === '200,404,404,404',
    JSON.stringify({ about: [about.quest, about.by], shares }));

  await post('/api/console/albums/save', { id: rattlers.id, name: 'Rattlers', adding: 'closed', show_hidden: true }, admin);
  const kept = await pickedAlbum();
  const withHidden = await readKeys();
  const hiddenShare = await status('/photo/g/testteam01');
  await post('/api/console/albums/save', { id: rattlers.id, name: 'Rattlers', adding: 'closed', show_hidden: true, teams: [1] }, admin);
  const replaced = await readKeys();
  check('a save that does not send the teams keeps them, and one that does replaces them; a hidden team picked shows where the album shows hidden teams',
    JSON.stringify(kept.teams) === '[2,3]' && withHidden.includes('sub/testteam01') && hiddenShare === 200 &&
    JSON.stringify(replaced) === '["sub/galleryone"]',
    JSON.stringify({ kept: kept.teams, withHidden, hiddenShare, replaced }));

  await post('/api/console/albums/save', { id: rattlers.id, name: 'Rattlers', adding: 'closed', teams: [1, 5] }, admin);
  const deletedTeam = (await post('/api/console/teams/delete', { id: 5, confirm: 'Stray Cats' }, admin)).status;
  const afterTeam = raw.prepare('SELECT team_id FROM album_teams WHERE album_id = ?').all(rattlers.id).map(r => r.team_id);
  const deletedAlbum = (await post('/api/console/albums/delete', { id: rattlers.id }, admin)).status;
  check('a deleted team comes off the albums it was picked for, and a deleted album takes its teams with it',
    deletedTeam === 200 && JSON.stringify(afterTeam) === '[1]' && deletedAlbum === 200 &&
    raw.prepare('SELECT COUNT(*) AS n FROM album_teams').get().n === 0,
    JSON.stringify({ deletedTeam, afterTeam, deletedAlbum }));
}

// ---------------- a photo pointed at another ----------------
// A duplicate pointed at another photo in its album leaves the album, and
// every address it had (its share link, its file and copies by key and by
// name, /view/ and its details) redirects to that photo. Pointing goes
// one hop, and deleting the photo pointed to brings back what pointed at it.
{
  await post('/api/console/albums/save', { name: 'Point Me', adding: 'teams' }, admin);
  const albumId = raw.prepare("SELECT id FROM albums WHERE slug = 'point-me'").get().id;
  for (const name of ['A.jpg', 'B.jpg', 'C.jpg']) {
    const fd = new FormData();
    fd.append('id', String(albumId));
    fd.append('files', new File([cameraJpeg()], name, { type: 'image/jpeg' }), name);
    await front('/api/console/album/upload', { method: 'POST', headers: { authorization: 'Bearer ' + admin }, body: fd });
  }
  const keyOf = (name) => raw.prepare('SELECT r2_key FROM album_photos WHERE album_id = ? AND name = ?').get(albumId, name).r2_key;
  const A = keyOf('A.jpg'), B = keyOf('B.jpg'), C = keyOf('C.jpg');
  const point = async (key, to) => post('/api/console/album/photo/point', { id: albumId, key: key, to: to }, admin);
  const keys = async () => (await (await get('/api/album?a=point-me')).json()).photos.map(p => p.key).sort().join();
  await point(C, A);
  const dash = (await (await point(A, B)).json()).photos;
  const listed = await keys();
  const moved = async (path) => {
    const res = await get(path);
    return { status: res.status, to: (res.headers.get('location') || '').replace('https://tab.example', ''), cors: res.headers.get('access-control-allow-origin') };
  };
  const moves = {
    share: await moved('/photo/' + A.slice(4)),
    file: await moved('/api/albums/file?key=' + encodeURIComponent(A) + '&thumb=1'),
    named: await moved('/api/albums/file/' + A + '/photo.jpg?res=1080'),
    view: await moved('/view/' + A + '/A.jpg'),
    info: await moved('/api/albums/info?key=' + encodeURIComponent(A)),
    chained: await moved('/photo/' + C.slice(4))
  };
  const refused = [(await point(B, B)).status, (await point(B, A)).status, (await point(B, 'alb/notinhere1')).status];
  await point(C, '');
  const undone = await keys();
  await post('/api/console/album/photo/remove', { id: albumId, key: B }, admin);
  const afterDelete = await keys();
  const fileTo = new URL('https://tab.example' + moves.file.to);
  check('a photo pointed at another leaves the album and its share link, file, copies, /view/ and details all go to that photo; one hop, refused at itself or in a loop, undone, and back when that photo is deleted',
    dash.find(p => p.key === A).points_to === B && dash.find(p => p.key === C).points_to === B &&
    listed === B &&
    moves.share.status === 302 && moves.share.to === '/photo/' + B.slice(4) &&
    moves.file.status === 302 && fileTo.searchParams.get('key') === B && fileTo.searchParams.get('thumb') === '1' && moves.file.cors === '*' &&
    moves.named.to === '/api/albums/file/' + B + '/photo.jpg?res=1080' &&
    moves.view.to === '/view/' + B + '/A.jpg' && moves.info.to === '/api/albums/info?key=' + encodeURIComponent(B) &&
    moves.chained.to === '/photo/' + B.slice(4) &&
    refused.join() === '400,409,404' && undone === [B, C].sort().join() && afterDelete === [A, C].sort().join(),
    JSON.stringify({ dash: dash.map(p => [p.name, p.points_to]), listed, moves, refused, undone, afterDelete }));
}

// whose photos: by= for only some people, not= for everyone's but
// theirs, a name in any case, the count and the pages of what is let
// through, and everyone in the album on the first page whatever the
// filter; then the dashboard putting a team or a name on several at once
{
  await post('/api/console/albums/save', { name: 'Who Took It', adding: 'anyone', gallery: true }, admin);
  for (const [i, by] of ['sam', 'Sam', 'Sam', 'Jo', ''].entries()) await upload('who-took-it', [jpeg('w.jpg')], null, { by }, '198.51.100.' + (i + 1));
  await upload('who-took-it', [jpeg('k.jpg')], team, { by: 'Kim' });
  const read = async (q) => (await get('/api/album?a=who-took-it' + q)).json();
  const whole = await read('');
  const people = whole.people.map(p => p.name + ':' + p.n);
  const galahs = whole.people.find(p => p.name === 'Galahs').n;
  const only = await read('&by=SAM');
  const two = await read('&by=sam&by=galahs');
  const leftOut = await read('&not=Sam');
  const noName = await read('&by=');
  const page1 = await read('&by=Sam&n=2');
  const page2 = await read('&by=Sam&n=2&from=2');
  const byOf = (d) => d.photos.map(p => p.team || p.by).join();
  check('an album filters to some people\'s photos or everyone\'s but theirs, a name in any case, counting and paging what is let through, and lists everyone on its first page',
    people[0] === 'Sam:3' && people.includes(':1') && people.includes('Jo:1') && galahs >= 2 &&
    whole.people.reduce((n, p) => n + p.n, 0) === whole.count &&
    only.count === 3 && byOf(only) === 'Sam,Sam,sam' && JSON.stringify(only.filter) === '{"by":["SAM"],"not":[]}' &&
    only.people.length === whole.people.length &&
    two.count === 3 + galahs && leftOut.count === whole.count - 3 && !/sam/i.test(byOf(leftOut)) &&
    noName.count === 1 && noName.photos[0].by === '' && !noName.photos[0].team &&
    page1.photos.length === 2 && page1.next === 2 && page2.photos.length === 1 && page2.next === null && !('people' in page2) &&
    !('filter' in whole),
    JSON.stringify({ people, only: [only.count, byOf(only)], two: two.count, leftOut: [leftOut.count, byOf(leftOut)], noName: noName.count,
      page1: page1.next, page2: [page2.photos.length, page2.next] }));

  const albumId = raw.prepare("SELECT id FROM albums WHERE slug = 'who-took-it'").get().id;
  const keyOf = (by) => raw.prepare('SELECT r2_key FROM album_photos WHERE album_id = ? AND added_by = ? AND team_id IS NULL').get(albumId, by).r2_key;
  const jo = keyOf('Jo');
  const blank = keyOf('');
  const elsewhere = raw.prepare("SELECT r2_key FROM album_photos WHERE album_id != ? AND r2_key LIKE 'alb/%' LIMIT 1").get(albumId).r2_key;
  const toTeam = await post('/api/console/album/photos/author', { id: albumId, keys: [jo, blank], team_id: 2 }, admin);
  const toTeamBody = await toTeam.json();
  const afterTeam = (await read('')).photos.filter(p => p.key === jo || p.key === blank);
  const toName = await post('/api/console/album/photos/author', { id: albumId, keys: [jo], name: '  Jo Bloggs ' }, admin);
  const afterName = (await read('')).photos.find(p => p.key === jo);
  const refused = [
    (await post('/api/console/album/photos/author', { id: albumId, keys: ['sub/galleryone'], name: 'X' }, admin)).status,
    (await post('/api/console/album/photos/author', { id: albumId, keys: [blank, elsewhere], name: 'X' }, admin)).status,
    (await post('/api/console/album/photos/author', { id: albumId, keys: [blank], team_id: 999 }, admin)).status,
    (await post('/api/console/album/photos/author', { id: albumId, keys: [] }, admin)).status
  ];
  const untouched = raw.prepare('SELECT team_id, added_by FROM album_photos WHERE r2_key = ?').get(blank);
  const logged = raw.prepare("SELECT quest_code FROM submission_log WHERE action = 'album-author' ORDER BY id").all().map(r => r.quest_code);
  check('the dashboard puts a team or a name on several of an album\'s own uploads at once, all or none, refusing a gallery file, another album\'s photo and a team that is not there, and logs it',
    toTeam.status === 200 && toTeamBody.changed === 2 && Array.isArray(toTeamBody.photos) &&
    afterTeam.length === 2 && afterTeam.every(p => p.team === 'Red Rattlers' && p.by === '') &&
    toName.status === 200 && afterName.team === '' && afterName.by === 'Jo Bloggs' &&
    refused.join() === '400,409,404,400' && untouched.team_id === 2 && untouched.added_by === '' &&
    logged.join('|') === '2 files to Red Rattlers|1 file to Jo Bloggs',
    JSON.stringify({ status: toTeam.status, toTeamBody: toTeamBody.changed, afterTeam, afterName, refused, untouched, logged }));
}

// the whole album as a ZIP, from a link the dashboard makes: read back
// with node's own CRC rather than the worker's
{
  const { crc32: zcrc } = await import('node:zlib');
  const { createHmac } = await import('node:crypto');
  const readZip = (buf) => {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let e = buf.length - 22;
    while (e > 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    const out = [];
    for (let k = 0, p = dv.getUint32(e + 16, true); k < dv.getUint16(e + 10, true); k++) {
      const size = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), off = dv.getUint32(p + 42, true);
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      const data = buf.subarray(start, start + size);
      out.push({ name: new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nl)), data, crcOk: zcrc(data) === dv.getUint32(p + 16, true) });
      p += 46 + nl + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    return out;
  };
  const fill = (n, seed) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 255; return b; };
  await post('/api/console/albums/save', { name: 'Zip Me', adding: 'teams' }, admin);
  const zipId = raw.prepare("SELECT id FROM albums WHERE slug = 'zip-me'").get().id;
  const put = raw.prepare('INSERT INTO album_photos (album_id, r2_key, content_type, bytes, name, added_at, status) VALUES (?, ?, ?, ?, ?, ?, ?)');
  [['alb/zipone00001', 'image/jpeg', 'IMG_1.jpg', 70000, '2026-10-25 01:00:00', 'ready'],
    ['alb/ziptwo00002', 'image/jpeg', 'img_1.jpg', 50, '2026-10-25 01:01:00', 'ready'],
    ['alb/zipvid00003', 'video/mp4', 'clip', 1234, '2026-10-25 01:02:00', 'ready'],
    ['alb/zipupl00004', 'video/mp4', 'half.mp4', 99, '2026-10-25 01:03:00', 'uploading']].forEach(([key, type, name, n, at, status], i) => {
    bucket.set(key, fill(n, i));
    put.run(zipId, key, type, n, name, at, status);
  });
  const made = await get('/api/console/album/zip?id=' + zipId, admin);
  const links = await made.json();
  const one = links.parts && links.parts[0];
  const res = one ? await front(new URL(one.url).pathname + new URL(one.url).search) : null;
  const files = res && res.status === 200 ? readZip(new Uint8Array(await res.arrayBuffer())) : [];
  const byName = Object.fromEntries(files.map(f => [f.name, f]));
  const same = (name, key) => byName[name] && Buffer.compare(Buffer.from(byName[name].data), Buffer.from(bucket.get(key))) === 0;
  check('the dashboard makes a link that downloads the album as one ZIP of the files as stored, names made unique and given their extension, leaving out one still uploading, and logs it',
    made.status === 200 && links.parts.length === 1 && one.files === 3 && res.status === 200 &&
    res.headers.get('content-type') === 'application/zip' && /attachment; filename="zip-me\.zip"/.test(res.headers.get('content-disposition') || '') &&
    files.length === 3 && files.every(f => f.crcOk) && same('IMG_1.jpg', 'alb/zipone00001') &&
    same('img_1 (2).jpg', 'alb/ziptwo00002') && same('clip.mp4', 'alb/zipvid00003') &&
    raw.prepare("SELECT COUNT(*) AS n FROM submission_log WHERE action = 'album-zip'").get().n === 1,
    JSON.stringify({ status: made.status, parts: links.parts && links.parts.length, got: res && res.status, names: files.map(f => [f.name, f.crcOk]) }));

  // the link opens nothing once its signature or its time is wrong
  const u = new URL(one.url);
  const pass = u.searchParams.get('pass');
  const forged = pass.slice(0, -2) + (pass.slice(-2) === 'AA' ? 'BB' : 'AA');
  const past = Math.floor(Date.now() / 1000) - 60;
  const oldSig = createHmac('sha256', 'tab-pass').update('album-zip:' + zipId + ':' + past).digest('base64url');
  const tries = [forged, zipId + '.' + past + '.' + oldSig, ''].map(p => front(u.pathname + '?pass=' + encodeURIComponent(p) + '&part=1'));
  const refused = await Promise.all(tries);
  check('a download link with its signature changed, past its time or missing opens nothing',
    refused.every(r => r.status === 403), refused.map(r => r.status).join());

  // past 300 files the album comes in parts, the oldest first, so a photo
  // added later lands in the last part
  const many = raw.prepare('INSERT INTO album_photos (album_id, r2_key, content_type, bytes, name, added_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 300; i++) {
    const key = 'alb/zipmany' + String(i).padStart(4, '0');
    bucket.set(key, fill(3, i));
    many.run(zipId, key, 'image/jpeg', 3, 'many.jpg', '2026-10-25 02:' + String(Math.floor(i / 60)).padStart(2, '0') + ':' + String(i % 60).padStart(2, '0'));
  }
  const split = await (await get('/api/console/album/zip?id=' + zipId, admin)).json();
  const last = split.parts && split.parts[1] ? readZip(new Uint8Array(await (await front(new URL(split.parts[1].url).pathname + new URL(split.parts[1].url).search)).arrayBuffer())) : [];
  const beyond = split.parts ? await front(new URL(split.parts[0].url).pathname + '?pass=' + encodeURIComponent(new URL(split.parts[0].url).searchParams.get('pass')) + '&part=3') : null;
  check('an album of more than 300 files comes in parts, the oldest first, each its own ZIP, and a part that is not there is a 404',
    split.parts && split.parts.length === 2 && split.parts[0].files === 300 && split.parts[1].files === 3 &&
    /zip-me-part-2-of-2\.zip/.test(split.parts[1].url) && last.length === 3 && last.every(f => f.crcOk) &&
    last.every(f => /^many( \(\d+\))?\.jpg$/.test(f.name)) && beyond.status === 404,
    JSON.stringify({ parts: split.parts && split.parts.map(p => p.files), last: last.map(f => f.name), beyond: beyond && beyond.status }));
}

if (failures) { console.log('\n' + failures + ' FAILED'); process.exit(1); }
console.log('\nALL CHECKS PASSED');
