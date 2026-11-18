/* Compressing a video with the browser's own decoder and encoder
   (WebCodecs). compress.js loads this when a run starts; whenever it
   refuses or fails, the run goes to ffmpeg.wasm instead. */
(function () {
  'use strict';

  var DEMUXER = '../assets/mp4box/mp4box.all.mjs';
  var MUXER = '../assets/mp4-muxer/mp4-muxer.js';
  var MOOV_MAX = 64 * 1024 * 1024;
  var WINDOW = 4 * 1024 * 1024;   // read the file this much at a time
  var KEY_EVERY = 250;            // the longest run between keyframes, as x264's default
  var DECODE_AHEAD = 10;
  var ENCODE_AHEAD = 6;
  var STALL_MS = 30000;
  var FIRST = ['ftyp', 'wide', 'free', 'skip', 'mdat', 'moov', 'pnot', 'uuid'];
  var APPLE = [
    ['location', 'com.apple.quicktime.location.ISO6709'],
    ['make', 'com.apple.quicktime.make'],
    ['model', 'com.apple.quicktime.model']
  ];
  var PLAIN = { '\u00A9xyz': 'location', '\u00A9mak': 'make', '\u00A9mod': 'model',
    location: 'location', make: 'make', model: 'model' };

  function refuse(why) { return new Error(why); }

  // ---------------- Boxes ----------------

  function u32(b, i) { return b[i] * 16777216 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]); }
  function u64(b, i) { return u32(b, i) * 4294967296 + u32(b, i + 4); }
  function put32(b, i, v) {
    if (v < 0) v += 4294967296;
    b[i] = Math.floor(v / 16777216) & 255;
    b[i + 1] = (v >>> 16) & 255;
    b[i + 2] = (v >>> 8) & 255;
    b[i + 3] = v & 255;
  }
  function put64(b, i, v) { put32(b, i, Math.floor(v / 4294967296)); put32(b, i + 4, v % 4294967296); }
  function typeAt(b, i) { return String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]); }

  function boxAt(b, i, end) {
    if (i + 8 > end) return null;
    var len = u32(b, i);
    var hdr = 8;
    if (len === 1) {
      if (i + 16 > end) return null;
      len = u64(b, i + 8);
      hdr = 16;
    } else if (len === 0) {
      len = end - i;
    }
    if (len < hdr || i + len > end) return null;
    return { type: typeAt(b, i + 4), at: i, start: i + hdr, end: i + len };
  }
  function kids(b, from, to) {
    var out = [];
    var k;
    for (var i = from; (k = boxAt(b, i, to)); i = k.end) out.push(k);
    return out;
  }
  function find(list, type) {
    for (var i = 0; i < list.length; i++) if (list[i].type === type) return list[i];
    return null;
  }
  function within(b, box, path) {
    for (var i = 0; box && i < path.length; i++) box = find(kids(b, box.start, box.end), path[i]);
    return box;
  }
  function cat(parts) {
    var n = 0;
    var i;
    for (i = 0; i < parts.length; i++) n += parts[i].length;
    var out = new Uint8Array(n);
    var at = 0;
    for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
    return out;
  }
  function word(v) { var b = new Uint8Array(4); put32(b, 0, v); return b; }
  function ascii(s) {
    var b = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
    return b;
  }
  // a box of the given type (four letters, or four bytes) around parts
  function box(type, parts) {
    var body = cat(parts);
    return cat([word(body.length + 8), typeof type === 'string' ? ascii(type) : type, body]);
  }
  function text(b, from, to) {
    return new TextDecoder().decode(b.subarray(from, Math.max(from, to))).replace(/\0+$/, '');
  }

  // QuickTime's meta box starts with its children, an MP4's with four
  // bytes of version and flags first
  function metaStart(b, meta) {
    return meta.start + 8 <= meta.end && typeAt(b, meta.start + 4) !== 'hdlr' ? meta.start + 4 : meta.start;
  }
  function handlerOf(b, meta) {
    var h = find(kids(b, metaStart(b, meta), meta.end), 'hdlr');
    return h && h.start + 12 <= h.end ? typeAt(b, h.start + 8) : '';
  }
  function dataText(b, item) {
    var d = find(kids(b, item.start, item.end), 'data');
    return d && d.start + 8 <= d.end ? text(b, d.start + 8, d.end) : '';
  }
  // a meta box's entries as [name, value]: Apple's keyed names, or the
  // item's own type in an iTunes-style list
  function metaEntries(b, meta) {
    var ch = kids(b, metaStart(b, meta), meta.end);
    var keys = find(ch, 'keys');
    var ilst = find(ch, 'ilst');
    var names = [];
    if (keys && keys.start + 8 <= keys.end) {
      var count = u32(b, keys.start + 4);
      var at = keys.start + 8;
      for (var n = 0; n < count && at + 8 <= keys.end; n++) {
        var size = u32(b, at);
        if (size < 8 || at + size > keys.end) break;
        names.push(text(b, at + 8, at + size));
        at += size;
      }
    }
    return (ilst ? kids(b, ilst.start, ilst.end) : []).map(function (item) {
      var index = u32(b, item.at + 4);
      var name = keys ? names[index - 1] : item.type;
      return [name || '', dataText(b, item)];
    });
  }

  // ---------------- Reading the file ----------------

  function read(file, at, len) {
    return file.slice(at, at + len).arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
  }

  // Where the ftyp and moov boxes are, from a read of each top-level
  // header up to the moov.
  function topBoxes(file) {
    var size = file.size;
    var found = {};
    function next(at, n) {
      if (found.moov || at + 8 > size) return Promise.resolve(found);
      if (n >= 64) return Promise.reject(refuse('too many boxes'));
      return read(file, at, 16).then(function (h) {
        if (h.length < 8) throw refuse('cut short');
        var len = u32(h, 0);
        var hdr = 8;
        var type = typeAt(h, 4);
        if (len === 1) { len = u64(h, 8); hdr = 16; } else if (len === 0) { len = size - at; }
        if (n === 0 && FIRST.indexOf(type) === -1) throw refuse('not an MP4 or a QuickTime file');
        if (len < hdr || at + len > size) throw refuse('box past the end of the file');
        if (type === 'moof') throw refuse('fragmented');
        if (type === 'ftyp' || type === 'moov') found[type] = { at: at, len: len };
        return next(at + len, n + 1);
      });
    }
    return next(0, 0).then(function (f) {
      if (!f.moov) throw refuse('no movie header');
      if (f.moov.len > MOOV_MAX) throw refuse('movie header too big');
      return Promise.all([
        f.ftyp && f.ftyp.len < 4096 ? read(file, f.ftyp.at, f.ftyp.len) : Promise.resolve(new Uint8Array(0)),
        read(file, f.moov.at, f.moov.len)
      ]);
    });
  }

  // What is copied into the result as it is: the movie header's times,
  // and the moov's own meta and udta boxes, where a phone writes when and
  // where it filmed and on what.
  function sourceFacts(m) {
    var moov = boxAt(m, 0, m.length);
    if (!moov || moov.type !== 'moov') throw refuse('no movie header');
    var top = kids(m, moov.start, moov.end);
    if (find(top, 'mvex')) throw refuse('fragmented');
    var mvhd = find(top, 'mvhd');
    var meta = find(top, 'meta');
    var udta = find(top, 'udta');
    var facts = { created: 0, modified: 0, top: top, meta: null, udta: null };
    if (mvhd) {
      var v1 = m[mvhd.start] === 1;
      facts.created = v1 ? u64(m, mvhd.start + 4) : u32(m, mvhd.start + 4);
      facts.modified = v1 ? u64(m, mvhd.start + 12) : u32(m, mvhd.start + 8);
    }
    if (meta) facts.meta = m.slice(meta.at, meta.end);
    if (udta) facts.udta = m.slice(udta.at, udta.end);
    return facts;
  }

  // The moov without any meta or udta box, for the demuxer, which only
  // needs the tracks.
  function bareMovie(m, facts) {
    var skip = function (k) { return k.type !== 'meta' && k.type !== 'udta'; };
    return box('moov', facts.top.filter(skip).map(function (k) {
      if (k.type !== 'trak') return m.subarray(k.at, k.end);
      return box('trak', kids(m, k.start, k.end).filter(skip).map(function (t) {
        return m.subarray(t.at, t.end);
      }));
    }));
  }

  // ---------------- The libraries ----------------

  var loading = null;
  function script(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(refuse('could not load ' + src)); };
      document.head.appendChild(s);
    });
  }
  function libraries() {
    if (!loading) {
      loading = Promise.all([
        import(new URL(DEMUXER, window.location.href).href),
        window.Mp4Muxer ? Promise.resolve() : script(new URL(MUXER, window.location.href).href)
      ]).then(function (got) {
        if (!window.Mp4Muxer) throw refuse('no muxer');
        return got[0];
      });
      loading.catch(function () { loading = null; });
    }
    return loading;
  }

  // ---------------- What is in the file ----------------

  // An edit list's start: how long the track waits before it plays, in
  // seconds, and how far into its media it starts, in its own units.
  function editOf(trak, movieScale, firstCts) {
    var list = trak.edts && trak.edts.elst ? trak.edts.elst.entries : [];
    var delay = 0;
    var i = 0;
    while (i < list.length && list[i].media_time === -1) { delay += list[i].segment_duration / movieScale; i++; }
    if (i >= list.length) return { delay: delay, skip: Math.min(0, firstCts) };
    var real = list.slice(i).filter(function (e) { return e.media_time !== -1; });
    if (real.length > 1) throw refuse('an edited movie');
    if (list[i].media_rate_integer !== 1) throw refuse('a slowed or still edit');
    return { delay: delay, skip: list[i].media_time };
  }

  function rotationOf(matrix) {
    var a = matrix[0] / 65536;
    var b = matrix[1] / 65536;
    var c = matrix[3] / 65536;
    var d = matrix[4] / 65536;
    var angle = (Math.round(Math.atan2(b, a) * 2 / Math.PI) * 90 + 360) % 360;
    var cos = Math.round(Math.cos(angle * Math.PI / 180));
    var sin = Math.round(Math.sin(angle * Math.PI / 180));
    var near = function (x, y) { return Math.abs(x - y) < 0.01; };
    if (!(near(a, cos) && near(b, sin) && near(c, -sin) && near(d, cos))) throw refuse('a flipped or skewed picture');
    return angle;
  }

  // the channels an AAC setup names, 0 where it leaves them to the stream
  function ascChannels(c) {
    var bit = 0;
    var take = function (n) {
      var v = 0;
      for (var i = 0; i < n; i++, bit++) v = v * 2 + ((c[bit >> 3] >> (7 - (bit & 7))) & 1);
      return v;
    };
    if (take(5) === 31) take(6);
    if (take(4) === 15) take(24);
    return [0, 1, 2, 3, 4, 5, 6, 8][take(4)] || 0;
  }

  // a frame by the timestamp a codec handed back, allowing for one that
  // rounded it by a microsecond or two
  function frameAt(frames, ts) {
    for (var d = 0; d <= 2; d++) {
      if (frames[ts + d]) return frames[ts + d];
      if (d && frames[ts - d]) return frames[ts - d];
    }
    return null;
  }

  function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

  // The picture to encode: the stored picture, its short edge brought
  // down to the size chosen, as compress.js works out for the ffmpeg run.
  function encodeSize(w, h, edge) {
    var shortest = Math.min(w, h);
    if (!edge || edge >= shortest) return { w: even(w), h: even(h) };
    var k = edge / shortest;
    return { w: even(w * k), h: even(h * k) };
  }

  // Everything the run needs, from the demuxer's reading of the moov.
  function plan(M, ftyp, m, facts, opts) {
    var fed = cat([ftyp, bareMovie(m, facts)]);
    var buf = fed.buffer;
    buf.fileStart = 0;
    var mp = M.createFile();
    var info = null;
    mp.onError = function () {};
    mp.onReady = function (i) { info = i; };
    // the demuxer logs the end marker in a QuickTime sound description
    // as an error, though it reads the rest of it
    var log = console.error;
    console.error = function () {};
    try {
      mp.appendBuffer(buf);
      mp.flush();
    } finally {
      console.error = log;
    }
    if (!info) throw refuse('the demuxer could not read it');

    var enabled = function (t) { return (mp.getTrackById(t.id).tkhd.flags & 1) === 1; };
    var vt = info.videoTracks.filter(enabled)[0] || info.videoTracks[0];
    if (!vt) throw refuse('no video track');
    var vtrak = mp.getTrackById(vt.id);
    var ventries = vtrak.mdia.minf.stbl.stsd.entries;
    if (ventries.length !== 1) throw refuse('more than one kind of picture');
    var ventry = ventries[0];
    var cfg = ventry.avcC || ventry.hvcC;
    if (!cfg) throw refuse('video codec ' + vt.codec);
    var vts = vt.timescale;
    var vs = vtrak.samples;
    if (!vs.length || !vs[0].is_sync) throw refuse('no first keyframe');

    var minAll = Infinity;
    vs.forEach(function (s) { if (s.cts < minAll) minAll = s.cts; });
    var vEdit = editOf(vtrak, info.timescale, minAll);
    var kept = vs.filter(function (s) { return s.cts >= vEdit.skip; });
    if (!kept.length) throw refuse('no frames to show');
    kept.sort(function (x, y) { return x.cts - y.cts; });
    var base = kept[0].cts;
    // every frame's timestamp as the decoder and encoder carry it (whole
    // microseconds), and the exact one the muxer is given
    var frames = {};
    vs.forEach(function (s) {
      var us = Math.round((s.cts - base) / vts * 1e6);
      if (frames[us]) throw refuse('two frames at one time');
      frames[us] = { keep: s.cts >= vEdit.skip, exact: (s.cts - base) / vts * 1e6 };
    });
    var span = kept[kept.length - 1].cts + kept[kept.length - 1].duration - base;
    if (span <= 0) throw refuse('no length');

    var angle = rotationOf(vt.matrix);
    var size = encodeSize(ventry.width, ventry.height, opts.edge);

    var p = {
      file: opts.file,
      decoder: {
        codec: vt.codec,
        codedWidth: ventry.width,
        codedHeight: ventry.height,
        description: fed.slice(cfg.start + cfg.hdr_size, cfg.start + cfg.size)
      },
      vts: vts,
      video: vs,
      base: base,
      frames: frames,
      count: kept.length,
      fps: kept.length / (span / vts),
      videoDelay: vEdit.delay + (base - vEdit.skip) / vts,
      angle: angle,
      width: size.w,
      height: size.h,
      bitrate: opts.bitrate,
      audio: null
    };

    // AAC goes across as it is; any other audio is ffmpeg's to convert
    var aacs = info.audioTracks.filter(function (t) { return /^mp4a\.40\./.test(t.codec || ''); });
    var at = aacs.filter(enabled)[0] || aacs[0];
    if (info.audioTracks.length && !at) throw refuse('audio codec ' + info.audioTracks[0].codec);
    if (at) {
      var atrak = mp.getTrackById(at.id);
      var aentries = atrak.mdia.minf.stbl.stsd.entries;
      var aentry = aentries[0];
      var esds = aentries.length === 1 && (aentry.esds || (aentry.wave && aentry.wave.esds));
      var dcd = esds && esds.esd && esds.esd.findDescriptor(4);
      var dsi = dcd && dcd.findDescriptor(5);
      if (!dcd || dcd.oti !== 0x40 || !dsi || !dsi.data || !dsi.data.length) throw refuse('audio without its setup');
      var rate = at.timescale;
      if (rate !== Math.round(rate) || rate < 8000 || rate > 65535) throw refuse('audio clock ' + rate);
      var as = atrak.samples;
      if (as.length) {
        var config = new Uint8Array(dsi.data);
        var channels = ascChannels(config) || aentry.channel_count || 2;
        var first = as[0].cts;
        var aEdit = editOf(atrak, info.timescale, first);
        var skip = (aEdit.skip - first) / rate;
        var delay = aEdit.delay;
        if (skip < 0) { delay -= skip; skip = 0; }
        p.audio = {
          rate: rate,
          channels: channels,
          config: config,
          samples: as,
          first: first,
          skip: skip,
          delay: delay,
          // where a packet falls on the movie's time, to interleave with the frames
          presentBase: aEdit.delay - (aEdit.skip / rate)
        };
      }
    }
    return p;
  }

  // ---------------- What the browser can do ----------------

  // H.264 levels: [level, most macroblocks a frame, most a second]
  var LEVELS = [[0x1E, 1620, 40500], [0x1F, 3600, 108000], [0x20, 5120, 216000],
    [0x28, 8192, 245760], [0x2A, 8704, 522240], [0x32, 22080, 589824],
    [0x33, 36864, 983040], [0x34, 36864, 2073600], [0x3C, 139264, 4177920],
    [0x3D, 139264, 8355840], [0x3E, 139264, 16711680]];
  // High, then Main, then Constrained Baseline
  var PROFILES = ['6400', '4d00', '42e0'];

  function levelFor(w, h, fps) {
    var mbs = Math.ceil(w / 16) * Math.ceil(h / 16);
    var side = Math.max(Math.ceil(w / 16), Math.ceil(h / 16));
    for (var i = 0; i < LEVELS.length; i++) {
      var l = LEVELS[i];
      if (mbs <= l[1] && mbs * fps <= l[2] && side * side <= l[1] * 8) return l[0];
    }
    return 0;
  }

  function hex2(n) { return (n < 16 ? '0' : '') + n.toString(16); }

  function encoderConfig(p) {
    var level = levelFor(p.width, p.height, p.fps);
    if (!level) return Promise.reject(refuse('too big for H.264'));
    var tries = [];
    ['prefer-hardware', 'no-preference'].forEach(function (accel) {
      PROFILES.forEach(function (profile) {
        tries.push({
          codec: 'avc1.' + profile + hex2(level),
          width: p.width,
          height: p.height,
          bitrate: p.bitrate,
          framerate: p.fps,
          hardwareAcceleration: accel,
          latencyMode: 'quality',
          avc: { format: 'avc' }
        });
      });
    });
    function next(i) {
      if (i >= tries.length) return Promise.reject(refuse('no H.264 encoder'));
      return VideoEncoder.isConfigSupported(tries[i]).then(function (r) {
        return r && r.supported ? tries[i] : next(i + 1);
      }, function () { return next(i + 1); });
    }
    return next(0);
  }

  function check(p) {
    return VideoDecoder.isConfigSupported(p.decoder).then(function (r) {
      if (!r || !r.supported) throw refuse('this browser cannot decode ' + p.decoder.codec);
      return encoderConfig(p);
    });
  }

  // ---------------- The run ----------------

  // colour descriptions the muxer can write; it writes zeros for others
  var COLOURS = {
    primaries: ['bt709', 'bt470bg', 'smpte170m'],
    transfer: ['bt709', 'smpte170m', 'iec61966-2-1'],
    matrix: ['rgb', 'bt709', 'bt470bg', 'smpte170m']
  };
  function muxable(meta) {
    var cs = meta && meta.decoderConfig && meta.decoderConfig.colorSpace;
    if (!cs) return meta;
    var ok = Object.keys(COLOURS).every(function (k) { return COLOURS[k].indexOf(cs[k]) !== -1; });
    if (ok) return meta;
    var config = {};
    Object.keys(meta.decoderConfig).forEach(function (k) { if (k !== 'colorSpace') config[k] = meta.decoderConfig[k]; });
    return { decoderConfig: config };
  }

  function wideColour(frame) {
    var cs = frame.colorSpace || {};
    return cs.transfer === 'pq' || cs.transfer === 'hlg' || cs.primaries === 'bt2020' ||
      /P1[02]/.test(frame.format || '');
  }

  function encode(p, config, onProgress) {
    return new Promise(function (resolve, reject) {
      var Mux = window.Mp4Muxer;
      var muxer = new Mux.Muxer({
        target: new Mux.ArrayBufferTarget(),
        // the muxer takes frameRate as the track's clock, so the source's
        // own keeps every timestamp exact
        video: { codec: 'avc', width: p.width, height: p.height, rotation: p.angle, frameRate: p.vts },
        audio: p.audio ? { codec: 'aac', numberOfChannels: p.audio.channels, sampleRate: p.audio.rate } : undefined,
        fastStart: 'in-memory',
        firstTimestampBehavior: 'strict'
      });
      var failed = null;
      var settled = false;
      var decoded = 0;
      var encoded = 0;
      var shown = -1;
      var lastMove = Date.now();
      var canvas = null;
      var ctx = null;
      var queue = [];      // audio packets read and not yet muxed
      var firstAudio = true;
      var vi = 0;
      var ai = 0;
      var win = null;
      var audio = p.audio;
      var as = audio ? audio.samples : [];
      var encoder = null;
      var decoder = null;
      var dog = null;

      function stop() {
        clearInterval(dog);
        [decoder, encoder].forEach(function (c) {
          try { if (c && c.state !== 'closed') c.close(); } catch (e) { /* already closed */ }
        });
      }
      function fail(err) {
        if (failed || settled) return;
        failed = err || new Error('failed');
        stop();
        reject(failed);
      }

      function progress() {
        var pct = Math.floor(encoded / p.count * 100);
        if (pct !== shown) { shown = pct; onProgress(encoded / p.count); }
      }

      function muxAudio(until) {
        while (queue.length && queue[0].at <= until) {
          var a = queue.shift();
          muxer.addAudioChunkRaw(a.data, 'key', a.ts, a.dur, firstAudio ? {
            decoderConfig: { codec: 'mp4a.40.2', numberOfChannels: audio.channels, sampleRate: audio.rate, description: audio.config }
          } : undefined);
          firstAudio = false;
        }
      }

      function onChunk(chunk, meta) {
        if (failed) return;
        lastMove = Date.now();
        try {
          var f = frameAt(p.frames, chunk.timestamp);
          if (!f || !f.keep) throw new Error('a frame the source does not have');
          muxAudio(f.exact / 1e6 + p.videoDelay);
          muxer.addVideoChunk(chunk, muxable(meta), f.exact);
          encoded++;
          progress();
        } catch (e) { fail(e); }
      }

      function scaled(frame) {
        if (!canvas) {
          if (typeof OffscreenCanvas === 'function') {
            canvas = new OffscreenCanvas(p.width, p.height);
          } else {
            canvas = document.createElement('canvas');
            canvas.width = p.width;
            canvas.height = p.height;
          }
          ctx = canvas.getContext('2d', { alpha: false });
          ctx.imageSmoothingEnabled = true;
          ctx.imageSmoothingQuality = 'high';
        }
        ctx.drawImage(frame, 0, 0, p.width, p.height);
        var init = { timestamp: frame.timestamp };
        if (frame.duration != null) init.duration = frame.duration;
        return new VideoFrame(canvas, init);
      }

      function onFrame(frame) {
        if (failed) { frame.close(); return; }
        lastMove = Date.now();
        var f = frameAt(p.frames, frame.timestamp);
        if (!f || !f.keep) { frame.close(); return; }
        var out = frame;
        try {
          // straight to the encoder when nothing has to change, through a
          // canvas to resize it or to bring a wide-colour picture into the
          // colours an 8-bit H.264 file is shown in
          if (frame.displayWidth !== p.width || frame.displayHeight !== p.height || wideColour(frame)) {
            out = scaled(frame);
            frame.close();
          }
          encoder.encode(out, { keyFrame: decoded % KEY_EVERY === 0 });
          decoded++;
        } catch (e) { fail(e); }
        out.close();
      }

      function busy() {
        return decoder.decodeQueueSize > DECODE_AHEAD || encoder.encodeQueueSize > ENCODE_AHEAD;
      }
      // until the decoder or the encoder takes the next piece of work;
      // events rather than a timer, since a timer slows to once a second
      // in a tab in the background
      function wait() {
        return new Promise(function (go) {
          var done = false;
          var t = null;
          function on() {
            if (done) return;
            done = true;
            clearTimeout(t);
            if (decoder.removeEventListener) {
              decoder.removeEventListener('dequeue', on);
              encoder.removeEventListener('dequeue', on);
            }
            go();
          }
          if (decoder.addEventListener) {
            decoder.addEventListener('dequeue', on);
            encoder.addEventListener('dequeue', on);
          }
          t = setTimeout(on, 20);
        });
      }

      function finish() {
        decoder.flush().then(function () {
          return encoder.flush();
        }).then(function () {
          if (failed) return;
          if (decoded !== p.count || encoded !== p.count) {
            throw new Error('frames lost: ' + encoded + ' of ' + p.count);
          }
          muxAudio(Infinity);
          muxer.finalize();
          settled = true;
          stop();
          resolve(new Uint8Array(muxer.target.buffer));
        }).catch(fail);
      }

      // The file is read front to back once, a window at a time, each
      // track's samples in their own order.
      function pump() {
        while (!failed) {
          var v = p.video[vi];
          var a = as[ai];
          if (!v && !a) { finish(); return; }
          var isVideo = !!v && (!a || v.offset <= a.offset);
          var s = isVideo ? v : a;
          if (isVideo && busy()) { wait().then(pump); return; }
          if (!win || s.offset < win.at || s.offset + s.size > win.at + win.bytes.length) {
            read(p.file, s.offset, Math.max(WINDOW, s.size)).then(function (bytes) {
              if (bytes.length < s.size) throw new Error('the file is cut short');
              win = { at: s.offset, bytes: bytes };
              lastMove = Date.now();
              pump();
            }).catch(fail);
            return;
          }
          var data = win.bytes.subarray(s.offset - win.at, s.offset - win.at + s.size);
          try {
            if (isVideo) {
              vi++;
              decoder.decode(new EncodedVideoChunk({
                type: s.is_sync ? 'key' : 'delta',
                timestamp: Math.round((s.cts - p.base) / p.vts * 1e6),
                duration: Math.round(s.duration / p.vts * 1e6),
                data: data
              }));
            } else {
              ai++;
              queue.push({
                data: data.slice(),
                ts: (s.cts - audio.first) / audio.rate * 1e6,
                dur: s.duration / audio.rate * 1e6,
                at: s.cts / audio.rate + audio.presentBase
              });
            }
          } catch (e) { fail(e); return; }
        }
      }

      try {
        encoder = new VideoEncoder({ output: onChunk, error: fail });
        encoder.configure(config);
        decoder = new VideoDecoder({ output: onFrame, error: fail });
        decoder.configure(p.decoder);
      } catch (e) { fail(e); return; }
      dog = setInterval(function () {
        if (Date.now() - lastMove > STALL_MS) fail(new Error('stalled'));
      }, 5000);
      onProgress(0);
      pump();
    });
  }

  // ---------------- The finished file ----------------

  // creation and modification times, which mvhd, tkhd and mdhd all start with
  function stamp(b, start, created, modified) {
    if (b[start] === 1) {
      put64(b, start + 4, created);
      put64(b, start + 12, modified);
    } else if (created < 4294967296 && modified < 4294967296) {
      put32(b, start + 4, created);
      put32(b, start + 8, modified);
    }
  }
  // where a duration sits in mvhd/mdhd (after the timescale) and in tkhd
  function setDuration(b, start, kind, value) {
    var v1 = b[start] === 1;
    var at = kind === 'tkhd' ? start + (v1 ? 28 : 20) : start + (v1 ? 24 : 16);
    if (v1) put64(b, at, value); else if (value < 4294967296) put32(b, at, value);
  }
  function durationOf(b, start, kind) {
    var v1 = b[start] === 1;
    var at = kind === 'tkhd' ? start + (v1 ? 28 : 20) : start + (v1 ? 24 : 16);
    return v1 ? u64(b, at) : u32(b, at);
  }
  function scaleOf(b, start) { return u32(b, start + (b[start] === 1 ? 20 : 12)); }

  function edits(list) {
    var body = [new Uint8Array(4), word(list.length)];
    list.forEach(function (e) { body.push(word(e[0]), word(e[1]), new Uint8Array([0, 1, 0, 0])); });
    return box('edts', [box('elst', body)]);
  }

  // A track's edit list, so it plays against the other as it did in the
  // source: how long it waits, then where in its media it starts.
  function trackEdits(delay, skip, mediaSecs, movieScale, mediaScale) {
    var list = [];
    if (delay > 0.0005) list.push([Math.round(delay * movieScale), -1]);
    if (!list.length && skip <= 0) return null;
    list.push([Math.max(0, Math.round((mediaSecs - skip) * movieScale)), Math.round(skip * mediaScale)]);
    return list;
  }

  function utf8(s) { return new TextEncoder().encode(s); }
  function keyEntries(list) {
    return list.map(function (e) { var n = utf8(e[0]); return cat([word(n.length + 8), ascii('mdta'), n]); });
  }
  function itemBoxes(list, from) {
    return list.map(function (e, i) {
      return box(word(from + i), [box('data', [word(1), word(0), utf8(e[1])])]);
    });
  }
  function keyedMeta(list) {
    var hdlr = box('hdlr', [new Uint8Array(8), ascii('mdta'), new Uint8Array(13)]);
    return box('meta', [hdlr, box('keys', [new Uint8Array(4), word(list.length)].concat(keyEntries(list))),
      box('ilst', itemBoxes(list, 1))]);
  }
  // a keyed meta box with more entries on the end
  function addKeys(b, list) {
    var meta = boxAt(b, 0, b.length);
    var from = metaStart(b, meta);
    var ch = kids(b, from, meta.end);
    var keys = find(ch, 'keys');
    var ilst = find(ch, 'ilst');
    var count = keys ? u32(b, keys.start + 4) : 0;
    var newKeys = box('keys', [keys ? b.subarray(keys.start, keys.start + 4) : new Uint8Array(4), word(count + list.length),
      keys ? b.subarray(keys.start + 8, keys.end) : new Uint8Array(0)].concat(keyEntries(list)));
    var newItems = box('ilst', [ilst ? b.subarray(ilst.start, ilst.end) : new Uint8Array(0)].concat(itemBoxes(list, count + 1)));
    var parts = [b.subarray(meta.start, from)];
    ch.forEach(function (k) {
      parts.push(k.type === 'keys' ? newKeys : k.type === 'ilst' ? newItems : b.subarray(k.at, k.end));
    });
    if (!keys) parts.push(newKeys);
    if (!ilst) parts.push(newItems);
    return box('meta', parts);
  }

  // The phone's meta and udta boxes go into the result as they are. A
  // place, make or model written only under a plain name, as Android
  // writes them, is written again under Apple's name, which is what a
  // phone and the worker's reader look for in an MP4.
  function metadata(facts) {
    var meta = facts.meta;
    var udta = facts.udta;
    var have = {};
    var plain = {};
    var note = function (pair) {
      if (/^com\.apple\.quicktime\./.test(pair[0])) have[pair[0]] = true;
      else if (PLAIN[pair[0]] && pair[1] && !plain[PLAIN[pair[0]]]) plain[PLAIN[pair[0]]] = pair[1];
    };
    var top = meta && boxAt(meta, 0, meta.length);
    if (top) metaEntries(meta, top).forEach(note);
    var udtaBox = udta && boxAt(udta, 0, udta.length);
    var udtaKids = udtaBox ? kids(udta, udtaBox.start, udtaBox.end) : [];
    udtaKids.forEach(function (k) {
      if (k.type === 'meta') { metaEntries(udta, k).forEach(note); return; }
      if (!PLAIN[k.type] || k.start + 4 > k.end) return;
      var value = k.start + 8 <= k.end && typeAt(udta, k.start + 4) === 'data' ? dataText(udta, k)
        : text(udta, k.start + 4, Math.min(k.end, k.start + 4 + ((udta[k.start] << 8) | udta[k.start + 1])));
      note([k.type, value]);
    });
    var add = [];
    APPLE.forEach(function (pair) {
      if (!have[pair[1]] && plain[pair[0]]) add.push([pair[1], plain[pair[0]]]);
    });
    if (add.length) {
      if (top && handlerOf(meta, top) === 'mdta') {
        meta = addKeys(meta, add);
      } else if (!top) {
        meta = keyedMeta(add);
      } else if (udtaBox && !find(udtaKids, 'meta')) {
        udta = box('udta', [udta.subarray(udtaBox.start, udtaBox.end), keyedMeta(add)]);
      }
    }
    return [meta, udta].filter(Boolean);
  }

  function shiftOffsets(m, delta) {
    kids(m, 8, m.length).forEach(function (t) {
      if (t.type !== 'trak') return;
      var stbl = within(m, t, ['mdia', 'minf', 'stbl']);
      if (!stbl) return;
      kids(m, stbl.start, stbl.end).forEach(function (k) {
        var n = u32(m, k.start + 4);
        var i;
        var v;
        if (k.type === 'stco') {
          for (i = 0; i < n; i++) {
            v = u32(m, k.start + 8 + i * 4) + delta;
            if (v >= 4294967296) throw new Error('too big for 32-bit offsets');
            put32(m, k.start + 8 + i * 4, v);
          }
        } else if (k.type === 'co64') {
          for (i = 0; i < n; i++) put64(m, k.start + 8 + i * 8, u64(m, k.start + 8 + i * 8) + delta);
        }
      });
    });
  }

  // The muxer's file with the source's times, edit lists that keep the
  // tracks in step, and the phone's metadata, its chunk offsets moved on
  // by however much bigger the movie header became.
  function finished(out, p, facts) {
    var top = kids(out, 0, out.length);
    var moov = find(top, 'moov');
    var mdat = find(top, 'mdat');
    if (!moov || !mdat || mdat.at < moov.at) throw new Error('unexpected layout');
    var children = kids(out, moov.start, moov.end);
    var mvhdBox = find(children, 'mvhd');
    var movieScale = scaleOf(out, mvhdBox.start);
    var longest = 0;
    var parts = [];
    children.forEach(function (k) {
      if (k.type !== 'trak') return;
      var tk = kids(out, k.start, k.end);
      var tkhd = find(tk, 'tkhd');
      var mdia = find(tk, 'mdia');
      var mdhd = within(out, mdia, ['mdhd']);
      var hdlr = within(out, mdia, ['hdlr']);
      var tkhdBytes = out.slice(tkhd.at, tkhd.end);
      var mediaScale = scaleOf(out, mdhd.start);
      var mediaSecs = durationOf(out, mdhd.start, 'mdhd') / mediaScale;
      var list = null;
      if (typeAt(out, hdlr.start + 8) === 'vide') {
        list = trackEdits(p.videoDelay, 0, mediaSecs, movieScale, mediaScale);
      } else if (p.audio) {
        list = trackEdits(p.audio.delay, p.audio.skip, mediaSecs, movieScale, mediaScale);
      }
      stamp(tkhdBytes, 8, facts.created, facts.modified);
      if (list) setDuration(tkhdBytes, 8, 'tkhd', list.reduce(function (s, e) { return s + e[0]; }, 0));
      longest = Math.max(longest, durationOf(tkhdBytes, 8, 'tkhd'));
      var rest = [];
      tk.forEach(function (c) {
        if (c.type === 'tkhd') return;
        var bytes = out.slice(c.at, c.end);
        if (c.type === 'mdia') {
          var md = kids(bytes, 8, bytes.length);
          var h = find(md, 'mdhd');
          stamp(bytes, h.start, facts.created, facts.modified);
        }
        rest.push(bytes);
      });
      parts.push(box('trak', [tkhdBytes].concat(list ? [edits(list)] : [], rest)));
    });
    var mvhd = out.slice(mvhdBox.at, mvhdBox.end);
    stamp(mvhd, 8, facts.created, facts.modified);
    setDuration(mvhd, 8, 'mvhd', longest);
    var movie = box('moov', [mvhd].concat(parts, metadata(facts)));
    shiftOffsets(movie, movie.length - (moov.end - moov.at));
    return cat([out.subarray(0, moov.at), movie, out.subarray(moov.end)]);
  }

  // ---------------- The way in ----------------

  // Resolves with the compressed MP4 as a Blob, or rejects with the
  // reason this run has to go to ffmpeg. onProgress gets 0 once
  // encoding starts and the share done after that.
  function compress(file, opts) {
    var ftyp;
    var m;
    var facts;
    var p;
    return topBoxes(file).then(function (got) {
      ftyp = got[0];
      m = got[1];
      facts = sourceFacts(m);
      return libraries();
    }).then(function (M) {
      p = plan(M, ftyp, m, facts, {
        file: file,
        edge: opts.edge,
        bitrate: opts.bitrate
      });
      return check(p);
    }).then(function (config) {
      return encode(p, config, opts.onProgress || function () {});
    }).then(function (out) {
      return new Blob([finished(out, p, facts)], { type: 'video/mp4' });
    });
  }

  window.scsWebCodecs = { compress: compress };
})();
