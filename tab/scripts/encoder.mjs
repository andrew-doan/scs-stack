// The video encoder. Cloudflare Workers cannot run ffmpeg, so on the
// day this runs on somebody's laptop: it asks the worker for proof
// videos, downloads one, makes 480p/720p/1080p H.264 copies with
// ffmpeg and sends the copies back. The site then serves whichever
// size the viewer asked for, and falls back to the original whenever
// nothing is running — nothing on the site depends on it.
//
//   node scripts/encoder.mjs --api https://files.scs.andyrew.space --key <ENCODER_KEY>
//
// Run it on as many computers as you like. Each one takes a single
// video at a time and comes back for another when it is done, so a
// faster machine ends up doing more without anything having to decide
// that. Each names itself (the computer's own name unless --name says
// otherwise) and the dashboard lists them.
//
// The key is the worker's ENCODER_KEY secret. Both values can come
// from the environment instead (TAB_API and ENCODER_KEY), which is
// how scs-encoder.command starts it. Node 18+, ffmpeg and ffprobe on
// the PATH, nothing to install from npm.

import { spawn } from 'node:child_process';
import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const HEIGHTS = [480, 720, 1080];
// As much as one request carries. A copy over this is not too big to
// send, it just travels in slices instead.
const ONE_REQUEST_BYTES = 90 * 1024 * 1024;
const MAX_BYTES = 90 * 1024 * 1024;   // over this a rendition is encoded again smaller
const PART_BYTES = 20 * 1024 * 1024;  // one slice; the worker says the size it wants
const PART_TRIES = 3;                 // a slice that does not land is worth another go
const POLL_MS = 10000;
// The launchers download ffmpeg into a folder of their own and say
// where it went; on a machine that already has it, the bare names are
// found on the PATH (Windows included — Node adds .exe itself).
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

// ---------- things worth testing on their own ----------

// What this machine calls itself on the dashboard.
export function cleanName(raw) {
  return String(raw == null ? '' : raw)
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.local$/i, '')   // what a Mac calls itself on the network
    .trim()
    .slice(0, 40)
    .trim();
}

// Never upscale: the buckets at or below the source height, and for
// anything smaller than 480 a single copy at its own height, filed
// under 480 — re-encoding still normalises the bitrate and moves the
// index to the front of the file.
export function plan(height) {
  const targets = HEIGHTS.filter((h) => h <= height);
  if (targets.length) return targets.map((h) => ({ bucket: h, scale: h }));
  return [{ bucket: 480, scale: Math.max(2, height - (height % 2)) }];
}

export function mb(bytes) {
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// The line printed at startup, before asking whether to get going.
export function describeQueue(count, bytes) {
  if (!count) return 'Nothing is waiting for encoding right now.';
  const megs = Math.max(1, Math.round((bytes || 0) / (1024 * 1024)));
  const size = megs >= 1024 ? (megs / 1024).toFixed(1) + ' GB' : megs + ' MB';
  return count + (count === 1 ? ' video is' : ' videos are') +
    ' waiting for encoding (about ' + size + ').';
}

// ---------- configuration ----------

function flag(name) {
  const at = process.argv.indexOf('--' + name);
  return at !== -1 && process.argv[at + 1] ? process.argv[at + 1] : '';
}

let API = '';
let KEY = '';
let NAME = '';
// The worker has its R2 token: the original came from R2 and every copy
// goes back to R2 in slices, whatever its size. Set by each download and
// by each upload/start.
let straightToR2 = false;

// ---------- small helpers ----------

function say(text) {
  const now = new Date().toTimeString().slice(0, 8);
  console.log(now + '  ' + text);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(new Error(cmd + ' would not start: ' + e.message)));
    child.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(cmd + ' exited ' + code + ': ' + err.trim().split('\n').slice(-3).join(' ')));
    });
  });
}

async function apiJson(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    body: JSON.stringify(Object.assign({ name: NAME }, body || {}))
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data && data.error) || ('the worker answered ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

async function apiGet(path) {
  const res = await fetch(API + path, { headers: { authorization: 'Bearer ' + KEY } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data && data.error) || ('the worker answered ' + res.status));
    err.status = res.status;
    throw err;
  }
  return data;
}

// The video as the phone sent it. Nothing public can reach an original
// any more — that is the point of the clean copies this runner makes —
// so the source comes through the encoder's own key. A worker with its
// R2 token answers with an address to read it from R2 instead of the
// bytes; one without sends the bytes, as a worker from before does.
export async function download(key, to) {
  const res = await fetch(API + '/api/encoder/source?signed=1&key=' + encodeURIComponent(key), {
    headers: { authorization: 'Bearer ' + KEY }
  });
  if (!res.ok || !res.body) {
    const why = res.status === 401 || res.status === 403
      ? 'the worker did not accept the key — check ENCODER_KEY matches the one set on it'
      : 'the worker answered ' + res.status;
    throw new Error('could not download the original: ' + why);
  }
  straightToR2 = /^application\/json/i.test(res.headers.get('content-type') || '');
  let body = res.body;
  if (straightToR2) {
    const data = await res.json().catch(() => ({}));
    if (!data.url) throw new Error('could not download the original: the worker gave no address for it');
    // the signed address is all R2 needs; the encoder key stays between
    // this machine and the worker
    const fromR2 = await fetch(data.url);
    if (!fromR2.ok || !fromR2.body) {
      throw new Error('could not download the original: storage answered ' + fromR2.status);
    }
    body = fromR2.body;
  }
  await pipeline(Readable.fromWeb(body), createWriteStream(to));
}

// height is a number for one of the smaller copies, or the string
// 'clean' for the full-size one with the metadata taken out
export async function upload(key, height, file) {
  const size = (await stat(file)).size;
  if (straightToR2 || size > ONE_REQUEST_BYTES) return uploadInSlices(key, height, file, size);
  const bytes = await readFile(file);
  const res = await fetch(API + '/api/encoder/rendition?key=' + encodeURIComponent(key) +
    '&height=' + height + '&name=' + encodeURIComponent(NAME), {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'video/mp4' },
    body: bytes
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || ('the worker answered ' + res.status));
  return data;
}

// A still for the video's tile, for a video the page could not take a
// frame from as it went up. The worker keeps one already there.
export async function sendStill(key, file) {
  const bytes = await readFile(file);
  const res = await fetch(API + '/api/encoder/still?key=' + encodeURIComponent(key) +
    '&name=' + encodeURIComponent(NAME), {
    method: 'PUT',
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'image/jpeg' },
    body: bytes
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data && data.error) || ('the worker answered ' + res.status));
  return data;
}

// A copy bigger than one request, or any copy once the worker has its
// R2 token: R2 takes it in parts and stitches it itself, which is how
// the phone's video got here in the first place. Only one slice is ever
// in memory, so the size of the video stops mattering. A slice that
// does not land is tried again — the point of sending a long video in
// pieces is that one bad moment on a venue connection costs a piece
// rather than the whole thing.
async function uploadSlice(started, whole, n, body) {
  const where = API + '/api/encoder/upload/part?' + new URLSearchParams({
    upload: started.upload, stored: started.stored,
    n: String(n), bytes: String(whole), name: NAME
  });
  let last = null;
  for (let attempt = 1; attempt <= PART_TRIES; attempt++) {
    let res = null;
    try {
      res = await fetch(where, {
        method: 'PUT',
        headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/octet-stream' },
        body
      });
    } catch (err) {
      last = err;
    }
    if (res) {
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data.etag;
      last = new Error((data && data.error) || ('the worker answered ' + res.status));
      // the worker has made up its mind about this slice; sending it
      // again will not change the answer
      if (res.status >= 400 && res.status < 500) break;
    }
    if (attempt < PART_TRIES) await sleep(2000 * attempt);
  }
  throw new Error('slice ' + n + ' would not send: ' + (last ? last.message : 'no answer'));
}

// One slice of a direct upload: the worker signs an address for it and
// the slice goes to R2 there, with no key of ours on it. A fresh address
// on every try, so a retry after a long wait is not sent to one that has
// run out. R2 keeps the tags; the worker asks R2 for them at finish.
async function sliceToR2(started, n, body) {
  const where = '/api/encoder/upload/sign?' + new URLSearchParams({
    upload: started.upload, stored: started.stored, n: String(n), name: NAME
  });
  let last = null;
  for (let attempt = 1; attempt <= PART_TRIES; attempt++) {
    let signed = null;
    try {
      signed = await apiGet(where);
    } catch (err) {
      last = err;
      // the worker has made up its mind about this slice
      if (err.status >= 400 && err.status < 500) break;
    }
    if (signed) {
      try {
        const res = await fetch(signed.url, { method: 'PUT', body });
        if (res.ok) return;
        last = new Error('storage answered ' + res.status);
      } catch (err) {
        last = err;
      }
    }
    if (attempt < PART_TRIES) await sleep(2000 * attempt);
  }
  throw new Error('slice ' + n + ' would not send: ' + (last ? last.message : 'no answer'));
}

export async function uploadInSlices(key, height, file, size) {
  const started = await apiJson('/api/encoder/upload/start', { key, height, bytes: size });
  straightToR2 = !!started.direct;
  const partSize = started.part_size || PART_BYTES;
  const count = Math.max(1, Math.ceil(size / partSize));
  if (count > 1) say('  ' + mb(size) + ' — sending it in ' + count + ' slices');
  const handle = await open(file);
  const parts = [];
  try {
    for (let n = 1; n <= count; n++) {
      const at = (n - 1) * partSize;
      const slice = Buffer.allocUnsafe(Math.min(partSize, size - at));
      const { bytesRead } = await handle.read(slice, 0, slice.length, at);
      if (bytesRead !== slice.length) throw new Error('the copy on disk got shorter while it was being sent');
      if (started.direct) await sliceToR2(started, n, slice);
      else parts.push({ n, etag: await uploadSlice(started, size, n, slice) });
      if (count > 1) say('  slice ' + n + ' of ' + count + ' sent');
    }
  } catch (err) {
    await apiJson('/api/encoder/upload/abort', { upload: started.upload, stored: started.stored })
      .catch(() => {});
    throw err;
  } finally {
    await handle.close();
  }
  return apiJson('/api/encoder/upload/finish', {
    key, height, upload: started.upload, stored: started.stored, bytes: size, parts
  });
}

// ---------- one video ----------

// What a player will actually show: the frame size, and the turn the
// container asks for. A phone films in landscape whichever way you
// hold it and writes the turn into the track header, so the numbers
// that matter are the ones after it is applied.
async function probeVideo(file) {
  const out = await run(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:stream_side_data=rotation',
    '-of', 'default=nk=1:nw=1', file
  ]);
  const nums = String(out).trim().split(/\s+/).map(n => parseInt(n, 10));
  const width = nums[0];
  const height = nums[1];
  if (!height || height < 1) throw new Error('ffprobe found no video track');
  const turn = Math.abs(nums[2] || 0) % 180;
  const sideways = turn === 90;
  return {
    width, height, rotation: nums[2] || 0,
    // what the viewer sees
    shownWidth: sideways ? height : width,
    shownHeight: sideways ? width : height
  };
}

async function sourceHeight(file) {
  return (await probeVideo(file)).shownHeight;
}

// Is this copy the same way up as the one it was made from? A photo's
// orientation was lost once already, by a step that looked like it
// only touched metadata, and a sideways video is the same mistake in
// a place nobody would think to look. So each copy is measured rather
// than assumed: a stream copy has to keep the turn the container asks
// for, and a re-encode has to have baked it into the frames instead,
// which shows up as the frame going portrait. Both were true of
// ffmpeg 7.0; this says so out loud if a different build disagrees.
function sameWayUp(source, copy) {
  const want = source.shownWidth / source.shownHeight;
  const got = copy.shownWidth / copy.shownHeight;
  return Math.abs(want - got) < 0.02;
}

// HDR video from a phone (HLG, or PQ) is converted to SDR in the
// smaller copies. Encoded as it was, a copy kept the HDR colour tags on
// 8-bit video, which looks washed out, and Firefox on a Mac flickers
// while it draws one. The clean copy is a repackage and stays HDR.
const HDR_TRANSFERS = ['arib-std-b67', 'smpte2084'];
const TO_SDR = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,' +
  'tonemap=tonemap=mobius:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

async function colourTransfer(file) {
  try {
    return await run(FFPROBE, [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=color_transfer', '-of', 'default=nk=1:nw=1', file
    ]);
  } catch (err) {
    return '';
  }
}

// zscale needs ffmpeg built with zimg. Without it the copies are
// encoded as before, still tagged HDR.
let hasZscale = null;
async function canConvertHdr() {
  if (hasZscale === null) {
    const filters = await run(FFMPEG, ['-hide_banner', '-filters']).catch(() => '');
    hasZscale = /\szscale\s/.test(filters) && /\stonemap\s/.test(filters);
  }
  return hasZscale;
}

// -map_metadata -1 takes the metadata from no input at all. Without
// it ffmpeg copies the source's, so every smaller copy inherited the
// phone's GPS from the video it was made out of.
function encode(input, output, scale, crf, toSdr) {
  return run(FFMPEG, [
    '-y', '-i', input,
    '-map_metadata', '-1',
    '-vf', 'scale=-2:' + scale + (toSdr ? ',' + TO_SDR : ''),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf), '-pix_fmt', 'yuv420p'
  ].concat(toSdr ? ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'] : [], [
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
    output
  ]));
}

// The clean copy: the same video at its own size, with nothing in it
// saying where it was taken. `-c copy` repackages the container
// without touching a frame — no quality lost and seconds rather than
// minutes, whatever the file's size — and -map_metadata -1 is what
// drops the location atom on the way through. This is what the site
// serves at Original; the file the phone made is kept, and only the
// dashboard can reach it.
function repackage(input, output) {
  return run(FFMPEG, [
    '-y', '-i', input,
    '-map_metadata', '-1',
    '-c', 'copy',
    '-movflags', '+faststart',
    output
  ]);
}

// One frame a second in, or the first frame of a video shorter than
// that, at the size the page makes its own stills (480 on the long
// edge). ffmpeg turns it upright on the way through.
const STILL_EDGE = 480;
async function makeStill(input, output) {
  for (const at of ['1', '0']) {
    await rm(output, { force: true });
    try {
      await run(FFMPEG, [
        '-y', '-ss', at, '-i', input,
        '-map_metadata', '-1', '-frames:v', '1',
        '-vf', 'scale=' + STILL_EDGE + ':' + STILL_EDGE + ':force_original_aspect_ratio=decrease',
        '-q:v', '4',
        output
      ]);
      if ((await stat(output)).size > 0) return true;
    } catch (err) { /* try the first frame */ }
  }
  return false;
}

async function encodeOne(job, dir) {
  const original = join(dir, 'in');
  await download(job.key, original);
  const source = await probeVideo(original);
  const height = source.shownHeight;
  const made = [];
  const notes = [];
  if (source.rotation) {
    say('  filmed on its side (' + source.rotation + ' degrees); every copy has to come out ' +
      source.shownWidth + 'x' + source.shownHeight);
  }

  // The clean copy first: it is a repackage, not an encode, so it
  // takes seconds, and until it lands the site cannot show the video
  // at all — the original is never served to anyone but an organiser.
  const cleanOut = join(dir, 'clean.mp4');
  try {
    const started = Date.now();
    await repackage(original, cleanOut);
    const cleanSize = (await stat(cleanOut)).size;
    const cleanShape = await probeVideo(cleanOut);
    if (!sameWayUp(source, cleanShape)) {
      say('  the clean copy came out ' + cleanShape.shownWidth + 'x' + cleanShape.shownHeight +
        ' when it should be ' + source.shownWidth + 'x' + source.shownHeight + ' — not uploading it');
      notes.push('clean copy came out the wrong way up');
      throw new Error('orientation lost');
    }
    // the clean copy is the source repackaged, so it is the source's
    // size — a long video's goes up in slices
    await upload(job.key, 'clean', cleanOut);
    say('  cleaned in ' + Math.round((Date.now() - started) / 1000) + 's, ' + mb(cleanSize));
  } catch (err) {
    say('  could not make the clean copy: ' + err.message);
    notes.push('no clean copy');
  }

  const transfer = await colourTransfer(original);
  let toSdr = HDR_TRANSFERS.includes(transfer);
  if (toSdr && !(await canConvertHdr())) {
    say('  HDR video, and this ffmpeg has no zscale filter to convert it: the copies stay HDR');
    notes.push('HDR kept (ffmpeg has no zscale)');
    toSdr = false;
  } else if (toSdr) {
    say('  HDR video (' + transfer + '): the copies are converted to SDR');
  }

  for (const target of plan(height)) {
    const out = join(dir, target.bucket + '.mp4');
    const started = Date.now();
    try {
      await encode(original, out, target.scale, 23, toSdr);
    } catch (err) {
      if (!toSdr) throw err;
      say('  converting to SDR failed, so the copies stay HDR: ' + err.message);
      notes.push('HDR kept (conversion failed)');
      toSdr = false;
      await encode(original, out, target.scale, 23, false);
    }
    let size = (await stat(out)).size;
    if (size > MAX_BYTES) {
      // the point of a smaller copy is that it is smaller: worth one
      // more go at a lower bitrate before sending whatever comes out
      say('  ' + target.bucket + 'p came out ' + mb(size) + ' — encoding it again smaller');
      await encode(original, out, target.scale, 28, toSdr);
      size = (await stat(out)).size;
    }
    const shape = await probeVideo(out);
    if (!sameWayUp(source, shape)) {
      say('  ' + target.bucket + 'p came out ' + shape.shownWidth + 'x' + shape.shownHeight +
        ' when it should be the shape of ' + source.shownWidth + 'x' + source.shownHeight +
        ' — leaving that size out');
      notes.push(target.bucket + 'p came out the wrong way up');
      continue;
    }
    say('  encoded ' + target.bucket + 'p in ' + Math.round((Date.now() - started) / 1000) + 's, ' + mb(size));
    await upload(job.key, target.bucket, out);
    say('  uploaded ' + target.bucket + 'p');
    made.push(target.bucket);
  }

  // from the smallest copy, which is already upright and, for HDR,
  // already converted; the original when no copy was made
  const stillOut = join(dir, 'still.jpg');
  try {
    if (!(await makeStill(made.length ? join(dir, made[0] + '.mp4') : original, stillOut))) {
      throw new Error('ffmpeg gave no frame');
    }
    const sent = await sendStill(job.key, stillOut);
    if (sent.stored) say('  sent a still');
  } catch (err) {
    say('  could not make a still: ' + err.message);
    notes.push('no still');
  }
  return { made, note: notes.join(', ') };
}

// ---------- the loop ----------

let stopping = false;
let workingOn = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The video is already claimed by the time this runs.
async function handle(job) {
  workingOn = job.key;
  const started = Date.now();
  let dir = '';
  try {
    dir = await mkdtemp(join(tmpdir(), 'scs2-encode-'));
    const { made, note } = await encodeOne(job, dir);
    await apiJson('/api/encoder/finish', {
      key: job.key, heights: made, note, took_ms: Date.now() - started, claimed_at: job.claimed_at || ''
    });
    say(made.length
      ? 'Done in ' + Math.round((Date.now() - started) / 1000) + 's: ' + made.map((h) => h + 'p').join(', ')
      : 'Nothing usable came out — moving on');
  } catch (err) {
    // one bad file must not stop the day
    say('Gave up on ' + (job.name || job.key) + ': ' + err.message);
    try {
      await apiJson('/api/encoder/finish', {
        key: job.key, heights: [], note: err.message, took_ms: Date.now() - started, claimed_at: job.claimed_at || ''
      });
    } catch (err2) {
      say('And the worker would not take the report: ' + err2.message);
    }
  } finally {
    workingOn = '';
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function askToStart() {
  // no keyboard (a script, a launcher, a pipe) means yes
  if (process.argv.includes('--yes') || !process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question('Encode them? [Y/n] ')).trim().toLowerCase();
  rl.close();
  return answer === '' || answer === 'y' || answer === 'yes';
}

// Which worker this runner talks to, and as whom. The command works
// it out from its flags and its environment; a test points the same
// code at a worker of its own.
export function connect(api, key, name) {
  API = String(api || '').replace(/\/+$/, '');
  KEY = String(key || '');
  NAME = cleanName(name) || 'encoder';
}

async function main() {
  connect(flag('api') || process.env.TAB_API,
    flag('key') || process.env.ENCODER_KEY,
    flag('name') || process.env.SCS2_ENCODER_NAME || hostname());

  if (!API || !KEY) {
    console.error('The encoder needs the worker address and the encoder key.');
    console.error('');
    console.error('  node scripts/encoder.mjs --api https://files.scs.andyrew.space --key <ENCODER_KEY>');
    console.error('');
    console.error('Or set TAB_API and ENCODER_KEY in the environment. See ENCODER.md.');
    process.exit(1);
  }

  process.on('SIGINT', () => {
    if (stopping) process.exit(1);
    stopping = true;
    say('Stopping after this video. Press Ctrl+C again to stop now.');
  });

  say('Encoder "' + NAME + '" starting. Worker: ' + API);
  try {
    await run(FFMPEG, ['-version']);
    await run(FFPROBE, ['-version']);
  } catch (err) {
    console.error('ffmpeg and ffprobe could not be run: ' + err.message);
    console.error('On a Mac: brew install ffmpeg. On Windows: winget install ffmpeg.');
    process.exit(1);
  }

  // What is there, in plain words, before anything starts
  let first;
  try {
    first = await apiJson('/api/encoder/poll', { state: 'idle', working_on: '' });
  } catch (err) {
    console.error('Could not reach the worker: ' + err.message);
    process.exit(1);
  }
  say(describeQueue(first.waiting || 0, first.waiting_bytes || 0));
  if (first.waiting) {
    if (!(await askToStart())) {
      say('Left alone. Nothing was encoded.');
      return;
    }
  } else {
    say('Watching for new ones. Ctrl+C to stop.');
  }

  // A long encode would otherwise go minutes without calling in, and
  // the dashboard would say the machine had gone. While a video is in
  // hand this keeps the heartbeat going; when nothing is, the loop
  // below is already polling.
  const heartbeat = setInterval(() => {
    if (!workingOn) return;
    apiJson('/api/encoder/poll', { state: 'encoding', working_on: workingOn }).catch(() => {});
  }, POLL_MS);

  let quiet = false;   // say "waiting" once, not every ten seconds
  while (!stopping) {
    let jobs = [];
    try {
      const answer = await apiJson('/api/encoder/poll', { state: 'idle', working_on: '' });
      jobs = answer.jobs || [];
    } catch (err) {
      say('Could not reach the worker: ' + err.message);
      quiet = false;
      await sleep(POLL_MS);
      continue;
    }
    if (!jobs.length) {
      if (!quiet) { say('Nothing to encode. Waiting.'); quiet = true; }
      await sleep(POLL_MS);
      continue;
    }
    quiet = false;

    // one at a time: whoever's claim lands first has it, and losing
    // the race just means asking again
    const job = jobs[0];
    try {
      // the claim's stamp goes back with finish, so a finish after this
      // claim has run out cannot undo another machine's work
      job.claimed_at = (await apiJson('/api/encoder/claim', { key: job.key })).claimed_at || '';
    } catch (err) {
      if (err.status === 409) continue;
      say('Could not take ' + (job.name || job.key) + ': ' + err.message);
      await sleep(POLL_MS);
      continue;
    }
    say('Claimed ' + (job.name || job.key) + ' (' + mb(job.bytes) + ')');
    await handle(job);
  }

  clearInterval(heartbeat);
  try {
    await apiJson('/api/encoder/poll', { state: 'idle', working_on: '' });
  } catch (err) { /* the worker works this out from last_seen anyway */ }
  say('Encoder stopped.');
}

// importable for its helpers; only the real command runs the loop
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (invoked === import.meta.url) await main();
