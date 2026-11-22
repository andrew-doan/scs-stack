# The compress page

Shrinking a video before it is sent: two sets of choices, the browser's
own codecs, and ffmpeg.wasm whenever they cannot do it. Sending proof is
the submit page (`website/submit/CLAUDE.md`); the encoder that makes the
worker's own copies of a video is `tab/ENCODER.md`.

- **A page of its own** (`compress/`: index.html, compress.js,
  compress.css, webcodecs.js). It was a second view of the submit page,
  kept there because walking to another page threw a run away; it moved
  out so this page alone can be cross-origin isolated (below) while the
  proof form and the worker's files stay as they are. The submit page
  links here from a line under the file field ("Large video? Compress
  it…"), from the nudge on a file row over 500MB, and, signed out, from a
  line under the sign-in card. `/submit/#compress`, the old address, is
  sent here by a line in the submit page's head before anything draws.
  The back row and the top bar's back arrow go to the submit page, and
  the nav and the tab bar mark Submit, the section it sits in. A run
  writes its share into the tab's title (`report()`), and
  `scs.guardLeaving` asks before any link while one runs. ffmpeg.wasm's
  core is fetched by `ff.load()` on the first run that needs it, and
  `webcodecs.js`'s demuxer and muxer when a run starts, so only
  `ffmpeg.js` (4KB) loads with the page. The file cannot be changed
  during a run (the input is disabled and Change hidden), or the run's
  result landed under the next file's row. **A compressed video is not
  handed to the submit page**: the finished state is Save video (the
  share sheet on a phone, a download elsewhere) and Compress another,
  with a line saying to attach the saved video on the Submit page.
- **The multi-threaded engine** (`assets/ffmpeg-mt/`, `@ffmpeg/core-mt`
  0.12.10; `assets/CLAUDE.md` has the vendored files). ffmpeg.wasm with
  threads needs `SharedArrayBuffer`, which a browser gives only to a
  cross-origin isolated page. `netlify.toml` sends
  `Cross-Origin-Opener-Policy: same-origin` and
  `Cross-Origin-Embedder-Policy: require-corp` on `/compress/*` and
  nowhere else, and `require-corp` again on the engine's worker scripts
  (`/assets/ffmpeg/814.ffmpeg.js`, `/assets/ffmpeg-mt/*`): a worker an
  isolated page starts is refused unless its own response says the same,
  and the run then sits on Loading the engine with nothing in the
  console but a failed request. `loadEngine` fetches ffmpeg's worker script and the core's scripts first through `scs.fetch`, because a worker script that fails to load leaves `ff.load()` waiting for ever and the page on Loading the engine. `ensureEngine` takes the threaded core
  when `crossOriginIsolated`, `SharedArrayBuffer` and more than one core
  are all there, and the single-threaded one in `assets/ffmpeg/`
  otherwise, or when the threaded one does not load (said with
  `console.info`). Only the ffmpeg path gains, since WebCodecs needs
  neither: in headless Chromium a 6-second 720p HEVC clip took 4.6s
  threaded against 10.3s single. The fallback is iOS 15, older Firefox
  and an iPhone's HEVC in a browser that cannot decode it. Isolation
  means anything cross-origin the page loads needs CORS or a
  `Cross-Origin-Resource-Policy` header; it loads nothing cross-origin
  but the worker's JSON, which carries CORS. The service
  worker keeps the page's response with its headers, so a page it
  serves is isolated too. `verify-compress.cjs` serves the page with the
  headers read from `netlify.toml` and checks a real run is isolated,
  fetches the threaded core and does not fall back.
- **Threads, and the pool they come from.** The threaded core starts its
  workers before the first run and cannot add one once ffmpeg is running:
  a thread asked for past the last worker waits for good, and the run sits
  on Compressing at 0%. Left to choose, ffmpeg sizes its threads from the
  core count (`navigator.hardwareConcurrency`), and on a 4-core machine a
  1080p run took 20 at once, 32 at a reported 8 cores and 33 at 12, one
  more than the 32 the core shipped with, which hung. So a run always
  passes `-threads`, `-filter_threads` and the encoder's `-threads`
  (`threadCount()`: the core count, at most `MAX_THREADS`, 4), and with
  `-threads n` ffmpeg runs 4n - 1 threads at once, measured the same on
  HEVC, H.264 and 4K sources (7 at 2, 11 at 3, 15 at 4). The vendored
  core's pool is cut from 32 to 18 for that (`pthreadPoolSize` in
  `ffmpeg-mt/ffmpeg-core.js`, the one value changed from the published
  file), and `verify-compress.cjs` holds the two together. If a run on the
  threaded engine reports no progress for `STALL_MS` (60 seconds),
  `watched()` ends it and the run starts again on the single-threaded
  engine (`state.noThreads`, logged with `console.info`), so a pool that
  turns out too small costs time rather than the run. Measured in headless
  Chromium on 4 cores, a 10-second 1080p HEVC clip, against the renderer's
  memory with the page open: the single engine +158 MB loaded and +248 MB
  at its peak, 33s; the threaded one as shipped +405 MB and +579 MB, 11s;
  capped at 4 with 18 workers +334 MB and +531 MB, 13s. Each idle worker is
  about 4.5 MB. The core's 1 GB of shared memory is fixed (it cannot grow,
  unlike the single core's) and is not all used: a 5-second 4K clip peaked
  near +1 GB of the renderer's memory in all. A phone short of memory may
  refuse that block, which fails the load and falls back.
- **The compressor** is one column: the file as a row (name, size, length,
  picture; Change), then two sets of tiles — Picture size (Keep and every
  short edge below the video's own, each with the size it predicts) and
  File size (20 MB for Discord's limit, 50 MB, 100 MB, 75%, 50%, 25%, each
  showing the other unit) — with the picked tile in the sign's black, the
  way a picked chip is. Options that would upscale, not shrink, or starve
  the bitrate are hidden (`targetUsable`). The tiles keep their DOM order
  name, note, figure, because `verify-submit-page.cjs` reads them as text.
  The options stay on screen with a result so an over-target run can be
  tried again smaller; the run button steps down to a keyline then, since
  Save is the green one.
- **Two ways to compress, the browser's own codecs first**
  (`webcodecs.js`, `window.scsWebCodecs.compress`; the demuxer is vendored
  **mp4box 2.4.1**, the muxer **mp4-muxer 5.2.2**, both in
  `assets/CLAUDE.md`). An iPhone's 8-second 1080p60 HEVC clip took about
  70s through ffmpeg.wasm, 21s of it decoding HEVC in single-threaded wasm,
  and the speed was to come from the device's video hardware rather than
  from a faster preset or fewer frames (that was tried and reverted). Where
  the browser has WebCodecs, a run reads the file's top-level box headers
  up to the moov, reads the moov whole, and hands mp4box that moov without
  its meta and udta boxes, for the tracks and their sample tables. Then it
  reads the file front to back once, 4MB at a time, decodes the video with
  `VideoDecoder` and encodes H.264 with `VideoEncoder` at the bitrate
  `targetBitrates()` gives and the picture `outputSize()` gives (worked out
  on the stored picture, so a turned one is encoded as stored): High
  profile, then Main, then Constrained Baseline, each with
  `hardwareAcceleration: 'prefer-hardware'` and then `'no-preference'`,
  which is what lets a computer with no hardware H.264 encoder use the
  browser's software one; `latencyMode: 'quality'`; a keyframe at least
  every 250 frames, as x264's default. A frame that has to be resized, or
  is wide colour (HLG, PQ, BT.2020, 10-bit), is drawn on a 2D canvas with
  `imageSmoothingQuality: 'high'`; one already the right size goes to the
  encoder as it is. **Every frame the source shows keeps its timestamp**:
  the muxer is given the source track's timescale as its clock (its
  `frameRate` option is that), frames an edit list hides are decoded and
  dropped as a player drops them, and a count that comes out short is a
  failure. **AAC is copied packet for packet**, never decoded. mp4-muxer
  writes the file with fast start, and webcodecs.js then rebuilds its
  moov: the source's times on mvhd, tkhd and mdhd, edit lists that keep
  the audio's priming skip and any delay the source had, the phone's
  rotation in the track header (`rotationOf`, quarter turns only), and the
  metadata below, with every chunk offset moved on by however much the
  moov grew. Backpressure waits on the codecs' `dequeue` events, not a
  timer, because a timer in a background tab fires once a second.
- **When it goes to ffmpeg instead**: no WebCodecs; a file that is not an
  MP4 or a QuickTime file, is fragmented, has a moov over 64MB, an edit
  list with more than one segment, more than one sample description or a
  mirrored picture; a video codec other than H.264 or HEVC; audio that is
  not AAC; `isConfigSupported` refusing the decoder or every encoder
  config; a decoder, encoder or muxer error; a frame missing at the end;
  nothing moving for 30 seconds. compress.js catches every one of those,
  writes the reason with `console.info`, and runs the ffmpeg path from the
  start, so a failure part way costs the time spent and nothing else; the
  bar starts again from Loading the engine. The leaving guard mentions the
  31MB engine only while the ffmpeg path is the one running
  (`state.engine`).
- **What was measured**, in headless Chromium on a machine with no GPU
  and no video hardware, so WebCodecs ran OpenH264 in software, and which
  cannot decode HEVC at all (which is how the suite tests the fall back). End to end from Compress to the result, 8-second 1080p H.264
  clips with sensor-like noise: 1080p30 to 720p, 4.1s against 29.9s for
  ffmpeg.wasm; 1080p60 to 720p, 8.0s against 45.2s; 1080p60 kept at 1080p,
  5.1s against 51.8s. Against the source: kept at 1080p, SSIM 0.964
  against x264 superfast's 0.972, PSNR the same (40.4dB). Scaled to 720p
  through the canvas, luma SSIM 0.991 against 0.993, with chroma a few
  levels off on saturated colours; that error is already in the RGB the
  canvas gets from the decoded frame in a software-rendered browser (a
  75% yellow comes back with blue at 9 rather than 0), and a GPU's
  conversion should not have it. A canvas's frames come out of the encoder
  full range with an sRGB transfer, and the file says so. The encoder's
  own scaling was tried too: exact colours, but 4dB lower luma PSNR, so the
  canvas stays. A hardware encoder and a GPU will change all of these.
- **What is not known yet**: nothing here has run on hardware codecs, on
  an HEVC source, on HDR, or in Safari or Firefox. Safari has WebCodecs
  video from 16.4 on macOS and iOS (H.264 encoding through VideoToolbox),
  and the demuxer's class static blocks need 16.4 as well; whether it
  decodes HEVC through WebCodecs, accepts a VideoFrame made from an
  OffscreenCanvas, fires `dequeue` (a 20ms timer covers it if not) and
  tone-maps an HDR frame drawn on a canvas are all unverified, and each
  either works or sends the run to ffmpeg except the last, which would
  show as colour. Firefox (130+) has WebCodecs video but no HEVC decoding,
  so an iPhone's clip goes to ffmpeg there.
- **A compressed video keeps everything the phone wrote** — when and where
  it was filmed, the make, model and software. **The WebCodecs path**
  copies the source moov's own `meta` and `udta` boxes into the result as
  they are, so what an iPhone or an Android phone wrote there is carried
  whole, and puts the source's movie header times on the result. A place,
  make or model the source names only under a plain name (`©xyz`, `©mak`,
  `©mod`, or keys called that) and not under Apple's is added under
  Apple's name, into the source's moov-level keyed meta when there is one
  and in a new one otherwise. `verify-compress.cjs` makes an iPhone-style
  MOV and an Android-style MP4 with those boxes and checks the worker's
  reader (videostrip.ts) reads the same time, place and phone from the
  result as from the source. **The ffmpeg path** does it at every picture
  size and every target, since they are all one ffmpeg run. `-map_metadata 0` takes
  the source's tags and `-movflags use_metadata_tags` writes every one
  into the MP4; without it the MP4 writer keeps a few standard tags and
  none of those, and the compressor used to hand back a file with nothing
  in it at all, not even the movie header's time. An Android phone writes
  its place, make and model under plain names, which an MP4 has no slot
  for, so the compressor reads the source's tags first (`sourceTags`, an
  `-f ffmetadata` pass over the header, its progress kept off the bar)
  and writes them again under Apple's names, which a phone and the
  worker's reader (videostrip.ts) take from an MP4. Checked against the
  real ffmpeg.wasm with an iPhone-style MOV and an Android-style file:
  the worker reads the same time, place and phone from the result as
  from the source. Timed metadata tracks (an iPhone's per-frame data)
  are not carried: the MP4 writer cannot take them.
