// Run with: node tests/verify-encoder-orientation.mjs
// Needs ffmpeg and ffprobe on the machine (FFMPEG/FFPROBE to point at
// them); it says so and passes when they are missing, since this is
// for the machines that run the encoder.
//
// A phone films in landscape whichever way you hold it and writes the
// turn into the track header rather than rotating the frames. A photo
// lost exactly that once, to a step that looked like it only touched
// metadata, so the same question is asked of video here against a real
// ffmpeg rather than reasoned about: does the clean copy keep the turn,
// does a rendition bake it into the frames, and is a copy that lost it
// actually caught.
import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const FFPROBE = process.env.FFPROBE || 'ffprobe';

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(err.slice(-300)))));
  });
}

try {
  await run(FFMPEG, ['-version']);
  await run(FFPROBE, ['-version']);
} catch (err) {
  console.log('SKIP  ffmpeg and ffprobe are not on this machine — run this where the encoder runs');
  process.exit(0);
}

// The two functions the encoder decides with, taken out of its own
// source so this cannot drift from what actually runs. Importing the
// module would start its command line instead.
const text = readFileSync(join(BOT, 'scripts', 'encoder.mjs'), 'utf8');
function lift(name, kind) {
  const at = text.indexOf(kind + ' ' + name);
  if (at === -1) throw new Error('encoder.mjs has no ' + name);
  return text.slice(at, text.indexOf('\n}', at) + 2);
}
const { probeVideo, sameWayUp } = new Function('run', 'FFPROBE',
  lift('probeVideo', 'async function') + lift('sameWayUp', 'function') +
  ' return { probeVideo, sameWayUp };')(run, FFPROBE);

const dir = mkdtempSync(join(tmpdir(), 'scs2-turn-'));
const at = (name) => join(dir, name);
try {
  // a clip shaped the way a phone writes one: landscape frames, a turn
  // asked for in the container, a location and a time in the tags
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', at('flat.mp4')]);
  await run(FFMPEG, ['-y', '-display_rotation', '90', '-i', at('flat.mp4'), '-c', 'copy',
    '-metadata', 'location=+33.8830+151.2063/',
    '-metadata', 'creation_time=2026-10-20T09:14:02Z', at('phone.mp4')]);

  const source = await probeVideo(at('phone.mp4'));
  check('the probe reads the turn, and what a player will show',
    source.rotation === 90 && source.width === 320 && source.height === 240 &&
    source.shownWidth === 240 && source.shownHeight === 320, JSON.stringify(source));

  // ---- the clean copy: repackage(), exactly as the encoder runs it ----
  await run(FFMPEG, ['-y', '-i', at('phone.mp4'), '-map_metadata', '-1', '-c', 'copy',
    '-movflags', '+faststart', at('clean.mp4')]);
  const clean = await probeVideo(at('clean.mp4'));
  check('the clean copy keeps the turn, so it plays the way it was filmed',
    sameWayUp(source, clean) && clean.rotation === 90, JSON.stringify(clean));
  const cleanTags = await run(FFPROBE, ['-v', 'error', '-show_entries',
    'format_tags=location,creation_time', '-of', 'default=nw=1', at('clean.mp4')]);
  check('and loses the location and the time it was taken',
    !/location|creation_time/.test(cleanTags), JSON.stringify(cleanTags.trim()));

  // ---- a rendition: encode(), exactly as the encoder runs it ----
  await run(FFMPEG, ['-y', '-i', at('phone.mp4'), '-map_metadata', '-1',
    '-vf', 'scale=-2:480', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', at('r480.mp4')]);
  const rendition = await probeVideo(at('r480.mp4'));
  check('a rendition comes out the same way up, the turn baked into the frames',
    sameWayUp(source, rendition) && !rendition.rotation &&
    rendition.shownHeight === 480 && rendition.shownWidth === 360, JSON.stringify(rendition));

  // what a player really puts on the screen, rather than what the
  // numbers say it should
  for (const name of ['phone', 'clean', 'r480']) {
    await run(FFMPEG, ['-y', '-i', at(name + '.mp4'), '-frames:v', '1', at(name + '.png')]);
  }
  const shape = (name) => {
    const png = readFileSync(at(name + '.png'));
    return png.readUInt32BE(16) + 'x' + png.readUInt32BE(20);
  };
  check('and a frame pulled out of each really is upright',
    shape('phone') === '240x320' && shape('clean') === '240x320' && shape('r480') === '360x480',
    JSON.stringify({ phone: shape('phone'), clean: shape('clean'), r480: shape('r480') }));

  // ---- the case the check exists for ----
  // ffmpeg 7 keeps the turn on a stream copy; this makes a copy that
  // lost it anyway, which is what a different build could hand back,
  // and the encoder has to refuse that rather than upload it sideways
  await run(FFMPEG, ['-y', '-display_rotation', '0', '-i', at('phone.mp4'), '-c', 'copy', at('sideways.mp4')]);
  const sideways = await probeVideo(at('sideways.mp4'));
  check('a copy that lost the turn is caught, not uploaded',
    !sameWayUp(source, sideways) && sideways.shownWidth === 320, JSON.stringify(sideways));

  // a clip that was never turned must not be flagged by any of this
  const flat = await probeVideo(at('flat.mp4'));
  await run(FFMPEG, ['-y', '-i', at('flat.mp4'), '-map_metadata', '-1', '-c', 'copy', at('flatclean.mp4')]);
  check('a clip that was filmed the right way up passes through untouched',
    sameWayUp(flat, await probeVideo(at('flatclean.mp4'))) && !flat.rotation, JSON.stringify(flat));

  // ---- HDR from a phone ----
  // An HLG clip, the way an iPhone films by default. The copies have to
  // come out as SDR, or Firefox on a Mac flickers drawing them. This
  // depends on the ffmpeg build having zscale, so it is asked of the
  // ffmpeg on this machine.
  const toSdr = /const TO_SDR = [\s\S]*?;\n/.exec(text)[0];
  const { encode, colourTransfer, canConvertHdr } = new Function('run', 'FFMPEG', 'FFPROBE',
    toSdr + 'let hasZscale = null;' + lift('encode(', 'function') +
    lift('colourTransfer', 'async function') + lift('canConvertHdr', 'async function') +
    ' return { encode, colourTransfer, canConvertHdr };')(run, FFMPEG, FFPROBE);
  await run(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=15:duration=1',
    '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le',
    '-x265-params', 'colorprim=bt2020:transfer=arib-std-b67:colormatrix=bt2020nc:log-level=error',
    '-color_primaries', 'bt2020', '-color_trc', 'arib-std-b67', '-colorspace', 'bt2020nc', at('hlg.mp4')]);
  if (!(await canConvertHdr())) {
    console.log('SKIP  this ffmpeg has no zscale, so the encoder leaves HDR copies as HDR here');
  } else {
    await encode(at('hlg.mp4'), at('sdr.mp4'), 240, 23, true);
    const was = (await colourTransfer(at('hlg.mp4'))).trim();
    const now = (await colourTransfer(at('sdr.mp4'))).trim();
    check('an HDR video\'s copies come out as SDR', was === 'arib-std-b67' && now === 'bt709',
      JSON.stringify({ was, now }));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
