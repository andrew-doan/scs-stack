/* Compress a video. It runs on the device, with the browser's own video
   codecs where they can do it and ffmpeg.wasm where they cannot; the file
   never leaves the browser. */
(function () {
  'use strict';

  var scs = window.scs;

  var toolEl = document.getElementById('cp-tool');
  if (!toolEl) return;
  var fileInput = document.getElementById('cp-file');
  var pickLabel = document.getElementById('cp-pick-label');
  var metaEl = document.getElementById('cp-meta');
  var nameEl = document.getElementById('cp-name');
  var detailsEl = document.getElementById('cp-details');
  var targetWrap = document.getElementById('cp-target-wrap');
  var sizesEl = document.getElementById('cp-sizes');
  var scalesEl = document.getElementById('cp-scales');
  var guessEl = document.getElementById('cp-guess');
  var runBtn = document.getElementById('cp-run');
  var progressEl = document.getElementById('cp-progress');
  var stageLabel = document.getElementById('cp-stage');
  var pctEl = document.getElementById('cp-pct');
  var barEl = document.getElementById('cp-bar');
  var statusEl = document.getElementById('cp-status');
  var resultEl = document.getElementById('cp-result');
  var resultLine = document.getElementById('cp-result-line');
  var resultNote = document.getElementById('cp-result-note');
  var previewEl = document.getElementById('cp-preview');
  var againBtn = document.getElementById('cp-again');
  var saveBtn = document.getElementById('cp-save');

  var state = {
    file: null,
    duration: 0,
    width: 0,
    height: 0,
    shortEdge: 0,   // 0 = keep the picture as it is
    targetMB: 20,
    busy: false,
    outBlob: null,
    outName: '',
    outUrl: null,
    ffmpeg: null,
    engine: null,   // 'webcodecs' or 'ffmpeg' while a run is using one
    threads: false, // the engine loaded is the multi-threaded one
    noThreads: false, // the multi-threaded one stalled on this page; use the single one
    lastProgress: 0
  };

  // The picture sizes offered, by their short edge — the one that is
  // 1080 in "1080p", whichever way up the video was shot.
  var SCALES = [
    { edge: 1440, label: '1440p' },
    { edge: 1080, label: '1080p' },
    { edge: 720, label: '720p' },
    { edge: 480, label: '480p' }
  ];
  var AUDIO_BITS = 96000;

  function setStatus(msg) { statusEl.textContent = msg || ''; }
  function show(el, on) { el.classList.toggle('is-hidden', !on); }

  // Which of the five states the view is in: nothing chosen, a file
  // chosen, running, done, failed. The CSS reads it.
  function stage(name) { toolEl.setAttribute('data-stage', name); }

  // The running field: what it is doing, and how far in. A null
  // percentage means there is nothing to report yet.
  function setStage(label, pct) {
    stageLabel.textContent = label;
    pctEl.textContent = pct == null ? '' : pct + '%';
    barEl.style.width = (pct == null ? 0 : pct) + '%';
    report(true, pct);
  }

  // A run says so in the browser's tab title, which is the only thing a
  // page in the background can say.
  var pageTitle = document.title;
  function report(running, pct) {
    document.title = !running ? pageTitle
      : (pct == null ? '' : pct + '% ') + 'compressing a video | ' + pageTitle;
  }

  function cell(tag, cls, text) {
    var el = document.createElement(tag);
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function fmtMB(bytes) { return (bytes / (1024 * 1024)).toFixed(2) + ' MB'; }
  function fmtSize(mb) { return mb >= 10 ? Math.round(mb) + ' MB' : (Math.round(mb * 10) / 10) + ' MB'; }

  // The output picture for a chosen short edge, aspect kept and both
  // sides even (H.264 needs that). A video already smaller is left be.
  function outputSize(edge) {
    var w = state.width;
    var h = state.height;
    if (!w || !h) return null;
    var shortest = Math.min(w, h);
    if (!edge || edge >= shortest) return { w: even(w), h: even(h), scaled: false };
    var k = edge / shortest;
    return { w: even(w * k), h: even(h * k), scaled: true };
  }
  function even(n) { return Math.max(2, Math.round(n / 2) * 2); }

  // What a picture that size costs per second, roughly: bits per pixel
  // per frame from x264 at this preset, times the pixels, times 30fps.
  // It is an estimate and says so on the page.
  function guessMB(size) {
    if (!size || !state.duration) return 0;
    var videoBits = size.w * size.h * 30 * 0.07;
    return (videoBits + AUDIO_BITS) * state.duration / 8 / (1024 * 1024);
  }
  function fmtDuration(secs) {
    var total = Math.round(secs);
    var m = Math.floor(total / 60);
    var s = total % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  // Duration and picture size from metadata, with the currentTime
  // nudge for files (like some in-browser recordings) that report
  // Infinity at first.
  function probeVideo(file) {
    return new Promise(function (resolve) {
      var v = document.createElement('video');
      var done = false;
      var finish = function (d) {
        if (done) return;
        done = true;
        var out = {
          duration: isFinite(d) && d > 0 ? d : 0,
          width: v.videoWidth || 0,
          height: v.videoHeight || 0
        };
        URL.revokeObjectURL(v.src);
        resolve(out);
      };
      v.preload = 'metadata';
      v.onloadedmetadata = function () {
        if (isFinite(v.duration) && v.duration > 0) { finish(v.duration); return; }
        v.ondurationchange = function () {
          if (isFinite(v.duration) && v.duration > 0) finish(v.duration);
        };
        v.currentTime = 1e101;
        window.setTimeout(function () { finish(v.duration); }, 4000);
      };
      v.onerror = function () { finish(0); };
      v.src = URL.createObjectURL(file);
    });
  }

  // ---------------- The two rows of choices ----------------
  // Picture size first (it decides how much detail there is to keep),
  // then the target size. Options that make no sense for this video
  // are left out rather than shown and refused: a size bigger than the
  // file already is, a fraction so small the result would be mush, or
  // a picture larger than the video was shot at.

  // One row: the option's name, what it notes about itself, and the
  // figure it comes to. Three cells rather than a label with the
  // numbers as small print under it, so the figures line up down a
  // column and can be read against each other.
  function sizeRow(name, note, fig) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cp-size';
    var n = document.createElement('span');
    n.className = 'cp-size-name';
    n.textContent = name;
    var small = document.createElement('small');
    small.textContent = note;
    var f = document.createElement('span');
    f.className = 'cp-size-fig';
    f.textContent = fig;
    btn.appendChild(n);
    btn.appendChild(small);
    btn.appendChild(f);
    return btn;
  }

  function renderScales() {
    scalesEl.textContent = '';
    if (!state.width || !state.height) return;
    var opts = [{ edge: 0, label: 'Keep' }].concat(SCALES.filter(function (s) {
      return s.edge < Math.min(state.width, state.height); // no upscaling
    }));
    opts.forEach(function (opt) {
      var size = outputSize(opt.edge);
      var btn = sizeRow(opt.label, size.w + '×' + size.h, 'about ' + fmtSize(guessMB(size)));
      if (opt.edge === state.shortEdge) btn.classList.add('is-selected');
      btn.setAttribute('data-edge', String(opt.edge));
      scalesEl.appendChild(btn);
    });
  }

  // A target is worth offering when it actually shrinks the file, is
  // not a drastic fraction of it, and leaves enough bitrate for the
  // picture to hold up at the chosen size.
  function targetUsable(mb) {
    var originalMB = state.file.size / (1024 * 1024);
    if (mb >= originalMB * 0.95) return false;   // nothing to gain
    if (mb < originalMB * 0.03) return false;    // drastic
    var bits = mb * 1024 * 1024 * 8 * 0.94;
    var videoBits = bits / state.duration - AUDIO_BITS;
    var size = outputSize(state.shortEdge);
    var floor = size ? Math.max(150000, size.w * size.h * 30 * 0.012) : 150000;
    return videoBits >= floor;
  }

  function renderSizes() {
    if (!state.file || !state.duration) return;
    var originalMB = state.file.size / (1024 * 1024);
    var usable = [];
    Array.prototype.forEach.call(sizesEl.children, function (btn) {
      var pct = btn.getAttribute('data-pct');
      var mb = pct ? originalMB * (Number(pct) / 100) : Number(btn.getAttribute('data-mb'));
      mb = Math.max(0.5, Math.round(mb * 10) / 10);
      btn.setAttribute('data-value', String(mb));
      // Each row carries the reading its name does not: a named size
      // says what share of the file it is, a fraction says what it
      // comes to.
      var fig = btn.querySelector('.cp-size-fig');
      if (fig) fig.textContent = pct ? fmtSize(mb) : Math.round(mb / originalMB * 100) + '%';
      var ok = targetUsable(mb);
      btn.classList.toggle('is-hidden', !ok);
      if (ok) usable.push({ btn: btn, mb: mb });
    });
    // keep the selection on something still offered — otherwise the
    // middle of what is left
    var stillThere = usable.filter(function (u) { return Math.abs(u.mb - state.targetMB) < 0.05; });
    if (!stillThere.length && usable.length) {
      state.targetMB = usable[Math.floor(usable.length / 2)].mb;
    }
    usable.forEach(function (u) {
      u.btn.classList.toggle('is-selected', Math.abs(u.mb - state.targetMB) < 0.05);
    });
    Array.prototype.forEach.call(sizesEl.children, function (btn) {
      if (btn.classList.contains('is-hidden')) btn.classList.remove('is-selected');
    });
    if (!usable.length) {
      state.targetMB = Math.max(0.5, Math.round(originalMB * 0.5 * 10) / 10);
    }
    renderGuess(usable.length);
  }

  // The prediction, in the same shape the result is written in later:
  // one figure for what comes out. The percentage is not repeated here
  // because the row that was picked is already carrying it.
  function renderGuess(usableCount) {
    var size = outputSize(state.shortEdge);
    var at = size ? size.w + '×' + size.h : '';
    guessEl.textContent = '';
    if (!usableCount) {
      guessEl.appendChild(document.createTextNode(
        'This video is already small for its length.'));
      return;
    }
    var fig = document.createElement('b');
    fig.textContent = 'about ' + fmtSize(state.targetMB);
    guessEl.appendChild(document.createTextNode('Aiming for '));
    guessEl.appendChild(fig);
    guessEl.appendChild(document.createTextNode((at ? ' at ' + at : '') + '.'));
  }

  // ---------------- File selection ----------------

  fileInput.addEventListener('change', function () {
    var f = fileInput.files && fileInput.files[0];
    // the file is kept until the run on it has finished
    if (!f || state.busy) return;
    resetOutput();
    state.file = f;
    state.duration = 0;
    state.width = 0;
    state.height = 0;
    nameEl.textContent = f.name;
    detailsEl.textContent = fmtMB(f.size) + ' · reading length…';
    show(metaEl, true); scs.rise(metaEl);
    show(targetWrap, true); scs.rise(targetWrap);
    runBtn.disabled = true;
    pickLabel.textContent = 'Choose a different video';
    setStatus('');
    stage('ready');
    probeVideo(f).then(function (info) {
      if (state.file !== f) return;
      state.duration = info.duration;
      state.width = info.width;
      state.height = info.height;
      if (!info.duration) {
        detailsEl.textContent = fmtMB(f.size) + ' · could not read this video';
        // The choices mean nothing without a length, so they come away
        // rather than standing there with no figures in them.
        show(targetWrap, false);
        setStatus('That file could not be read as a video. Try a different one.');
        stage('failed');
        return;
      }
      detailsEl.textContent = fmtMB(f.size) + ' · ' + fmtDuration(info.duration) + ' long' +
        (info.width ? ' · ' + info.width + '×' + info.height : '');
      // start at 1080p when the video is bigger than that, which is
      // the size most of these end up wanting anyway
      var shortest = Math.min(info.width || 0, info.height || 0);
      state.shortEdge = shortest > 1080 ? 1080 : 0;
      runBtn.disabled = false;
      renderScales();
      renderSizes();
    });
  });

  scalesEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.cp-size');
    if (!btn || state.busy) return;
    state.shortEdge = Number(btn.getAttribute('data-edge'));
    Array.prototype.forEach.call(scalesEl.children, function (b) {
      b.classList.toggle('is-selected', b === btn);
    });
    // a smaller picture makes smaller targets workable, and the other
    // way round, so the size row is worked out again
    renderSizes();
  });

  sizesEl.addEventListener('click', function (e) {
    var btn = e.target.closest('.cp-size');
    if (!btn || state.busy || btn.classList.contains('is-hidden')) return;
    state.targetMB = Number(btn.getAttribute('data-value'));
    Array.prototype.forEach.call(sizesEl.children, function (b) {
      b.classList.toggle('is-selected', b === btn);
    });
    renderGuess(1);
  });

  // ---------------- Engine ----------------

  // The multi-threaded engine needs SharedArrayBuffer, which a browser
  // gives only to a cross-origin isolated page: this one, through the
  // headers netlify.toml sends for /compress/. Anywhere else, or if it
  // will not load, the single-threaded one runs.
  function threaded() {
    return !state.noThreads && !!window.crossOriginIsolated && typeof SharedArrayBuffer === 'function' &&
      (navigator.hardwareConcurrency || 1) > 1;
  }

  // ffmpeg starts about four threads for each one it is told to use, and
  // the engine has 18 (pthreadPoolSize in ffmpeg-mt/ffmpeg-core.js). One
  // more than it has and the run stops, so the count is always given.
  var MAX_THREADS = 4;
  function threadCount() {
    return Math.max(1, Math.min(MAX_THREADS, navigator.hardwareConcurrency || 1));
  }
  // No progress for this long on the multi-threaded engine and the run
  // starts again on the single one.
  var STALL_MS = 60000;

  function loadEngine(useThreads) {
    var dir = useThreads ? '../assets/ffmpeg-mt/' : '../assets/ffmpeg/';
    var at = function (name) { return new URL(dir + name, window.location.href).href; };
    var urls = { coreURL: at('ffmpeg-core.js'), wasmURL: at('ffmpeg-core.wasm') };
    if (useThreads) urls.workerURL = at('ffmpeg-core.worker.js');
    // ffmpeg's own worker and the core's script are fetched first, with
    // retries, so the service worker holds them: a worker script that
    // fails to load leaves ff.load() waiting for ever
    var first = [new URL('../assets/ffmpeg/814.ffmpeg.js', window.location.href).href, urls.coreURL];
    if (urls.workerURL) first.push(urls.workerURL);
    return Promise.all(first.map(function (u) {
      return window.scs.fetch(u).then(function (r) { if (!r.ok) throw new Error('engine ' + r.status); return r.blob(); });
    })).then(function () { return startEngine(urls, useThreads); });
  }

  function startEngine(urls, useThreads) {
    var ff = new FFmpegWASM.FFmpeg();
    ff.on('progress', function (ev) {
      state.lastProgress = Date.now();
      if (state.readingTags) return;
      var pct = Math.max(0, Math.min(100, Math.round((ev.progress || 0) * 100)));
      setStage('Compressing', pct);
    });
    return ff.load(urls).then(function () {
      state.ffmpeg = ff;
      state.threads = useThreads;
      return ff;
    }, function (err) {
      try { ff.terminate(); } catch (e) { /* not started */ }
      throw err;
    });
  }

  function ensureEngine() {
    if (state.ffmpeg) return Promise.resolve(state.ffmpeg);
    setStage('Loading the engine', null);
    setStatus('The engine is about 31 MB and downloads once.');
    var useThreads = threaded();
    return loadEngine(useThreads).catch(function (err) {
      if (!useThreads) throw err;
      if (window.console && console.info) console.info('compress: the threaded engine did not load, using the single one', err);
      return loadEngine(false);
    });
  }

  // ---------------- Compression ----------------

  function targetBitrates() {
    // Budget ~94% of the target for container overhead, split audio/video.
    var budgetBits = state.targetMB * 1024 * 1024 * 8 * 0.94;
    var audio = AUDIO_BITS;
    var video = Math.floor(budgetBits / state.duration) - audio;
    if (video < 200000) { audio = 64000; video = Math.floor(budgetBits / state.duration) - audio; }
    if (video < 100000) video = 100000;
    return { video: video, audio: audio };
  }

  // The phone's own tags go into the smaller file: -map_metadata 0 takes
  // them and use_metadata_tags writes all of them into the MP4, which
  // keeps a few standard ones otherwise. A place, make or model under
  // plain names, as Android writes them, is written again under Apple's,
  // the names an MP4 is read for.
  var APPLE_NAMES = [
    ['location', 'com.apple.quicktime.location.ISO6709'],
    ['make', 'com.apple.quicktime.make'],
    ['model', 'com.apple.quicktime.model']
  ];
  function sourceTags(ff, inName) {
    state.readingTags = true;
    return ff.exec(['-i', inName, '-f', 'ffmetadata', '-y', 'tags.txt'])
      .then(function () { return ff.readFile('tags.txt'); })
      .then(function (bytes) {
        ff.deleteFile('tags.txt').catch(function () {});
        var tags = {};
        new TextDecoder().decode(bytes).split('\n').some(function (line) {
          if (line.charAt(0) === '[') return true; // the streams' own come after
          var m = /^([^=;#][^=]*)=(.*)$/.exec(line);
          if (m) tags[m[1]] = m[2].replace(/\\(.)/g, '$1');
          return false;
        });
        return tags;
      })
      .catch(function () { return {}; })
      .then(function (tags) {
        state.readingTags = false;
        return tags;
      });
  }
  function keptTags(tags) {
    var out = [];
    APPLE_NAMES.forEach(function (pair) {
      if (tags[pair[0]] && !tags[pair[1]]) out.push('-metadata', pair[1] + '=' + tags[pair[0]]);
    });
    return out;
  }

  function inputName(file) {
    var m = /\.([A-Za-z0-9]{2,5})$/.exec(file.name || '');
    return 'input.' + (m ? m[1].toLowerCase() : 'mp4');
  }

  // Named after what went in, so the saved file says what it is.
  function outputName(name) {
    var base = String(name || '').replace(/\.[A-Za-z0-9]{1,5}$/, '').replace(/[\\/:*?"<>|]/g, '');
    return (base || 'video').slice(0, 60) + '-small.mp4';
  }

  // The browser's own decoder and encoder, through webcodecs.js: the
  // device's video hardware where it has it. It is tried first, and
  // anything it refuses or fails part way through goes to ffmpeg.
  var webCodecsLoad = null;
  function webCodecs() {
    if (!(window.VideoDecoder && window.VideoEncoder && window.EncodedVideoChunk && window.VideoFrame)) {
      return Promise.reject(new Error('no WebCodecs'));
    }
    if (!webCodecsLoad) {
      webCodecsLoad = new Promise(function (resolve, reject) {
        var s = document.createElement('script');
        s.src = 'webcodecs.js';
        s.onload = function () { resolve(window.scsWebCodecs); };
        s.onerror = function () {
          webCodecsLoad = null;
          reject(new Error('webcodecs.js did not load'));
        };
        document.head.appendChild(s);
      });
    }
    return webCodecsLoad;
  }

  function viaWebCodecs(file, rates) {
    return webCodecs().then(function (wc) {
      return wc.compress(file, {
        edge: state.shortEdge,
        bitrate: rates.video,
        onProgress: function (share) {
          if (state.engine !== 'webcodecs') {
            state.engine = 'webcodecs';
            setStatus('Keep this page open until it finishes.');
          }
          setStage('Compressing', Math.round(share * 100));
        }
      });
    });
  }

  function viaFfmpeg(file, rates) {
    var inName = inputName(file);
    var ff;
    state.engine = 'ffmpeg';
    return ensureEngine().then(function (engine) {
      ff = engine;
      setStage('Reading your video', null);
      setStatus('');
      return file.arrayBuffer();
    }).then(function (buf) {
      return ff.writeFile(inName, new Uint8Array(buf));
    }).then(function () {
      return sourceTags(ff, inName);
    }).then(function (tags) {
      setStage('Compressing', 0);
      setStatus('Keep this page open until it finishes.');
      var size = outputSize(state.shortEdge);
      var n = String(state.threads ? threadCount() : 1);
      return watched(ff, ff.exec([
        '-threads', n,
        '-i', inName,
        '-filter_threads', n,
        '-map_metadata', '0',
        '-c:v', 'libx264',
        '-threads', n,
        '-preset', 'superfast',
        '-b:v', String(rates.video),
        '-maxrate', String(Math.floor(rates.video * 1.45)),
        '-bufsize', String(rates.video * 2),
        '-vf', 'scale=' + (size ? size.w + ':' + size.h : '-2:-2'),
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', String(rates.audio),
        '-movflags', '+faststart+use_metadata_tags'
      ].concat(keptTags(tags), ['-y', 'output.mp4'])));
    }).then(function () {
      return ff.readFile('output.mp4');
    }).then(function (out) {
      ff.deleteFile(inName).catch(function () {});
      ff.deleteFile('output.mp4').catch(function () {});
      if (!out || !out.length) throw new Error('empty output');
      return new Blob([new Uint8Array(out)], { type: 'video/mp4' });
    }).catch(function (err) {
      if (!(err && err.stalled)) {
        if (ff) {
          ff.deleteFile(inName).catch(function () {});
          ff.deleteFile('output.mp4').catch(function () {});
        }
        throw err;
      }
      if (window.console && console.info) console.info('compress: the threaded engine stalled, using the single one');
      state.noThreads = true;
      state.ffmpeg = null;
      return viaFfmpeg(file, rates);
    });
  }

  // A run on the multi-threaded engine that stops reporting progress is
  // ended, and rejects with `stalled` so the caller can start again.
  function watched(ff, run) {
    if (!state.threads) return run;
    state.lastProgress = Date.now();
    var timer = null;
    var stall = new Promise(function (resolve, reject) {
      timer = setInterval(function () {
        if (Date.now() - state.lastProgress < STALL_MS) return;
        clearInterval(timer);
        try { ff.terminate(); } catch (e) { /* already gone */ }
        reject(Object.assign(new Error('the engine stopped responding'), { stalled: true }));
      }, 2000);
    });
    return Promise.race([run, stall]).then(function (v) {
      clearInterval(timer);
      return v;
    }, function (err) {
      clearInterval(timer);
      if (err && !err.stalled && Date.now() - state.lastProgress >= STALL_MS) err.stalled = true;
      throw err;
    });
  }

  runBtn.addEventListener('click', function () {
    if (!state.file || !state.duration || state.busy) return;
    state.busy = true;
    runBtn.disabled = true;
    fileInput.disabled = true;
    resetOutput();
    stage('busy');
    setStage('Starting', null);
    show(progressEl, true); scs.rise(progressEl);

    var file = state.file;
    var rates = targetBitrates();

    viaWebCodecs(file, rates).catch(function (err) {
      if (window.console) console.info('Compressing with ffmpeg.wasm: ' + ((err && err.message) || err));
      return viaFfmpeg(file, rates);
    }).then(function (blob) {
      state.outBlob = blob;
      state.outName = outputName(file.name);
      state.outUrl = URL.createObjectURL(state.outBlob);
      previewEl.src = state.outUrl;

      var fits = state.outBlob.size <= state.targetMB * 1024 * 1024;
      var outSize = outputSize(state.shortEdge);
      // The page's one large figure: what it was against what it is.
      resultLine.textContent = '';
      resultLine.appendChild(cell('span', 'cp-was', fmtMB(file.size)));
      resultLine.appendChild(cell('span', 'cp-arrow', '→'));
      resultLine.appendChild(cell('span', 'cp-now good', fmtMB(state.outBlob.size)));
      resultNote.textContent = (outSize ? 'At ' + outSize.w + '×' + outSize.h + '. ' : '') +
        (fits ? 'Under the ' + fmtSize(state.targetMB) + ' target.'
              : 'Over the ' + fmtSize(state.targetMB) + ' target. Try a smaller one.');
      resultEl.classList.toggle('is-over', !fits);
      show(resultEl, true); scs.rise(resultEl);
      show(progressEl, false);
      setStatus('');
      stage('done');
    }).catch(function (err) {
      show(progressEl, false);
      setStatus('Compression failed: ' + ((err && err.message) || 'unknown error') +
        '. Try a shorter clip, or reload the page and start again.');
      stage('failed');
    }).then(function () {
      state.busy = false;
      fileInput.disabled = false;
      state.engine = null;
      report(false);
      runBtn.disabled = !(state.file && state.duration);
    });
  });

  // ---------------- Leaving while it is running ----------------
  // Nothing is written out until the run finishes, so there is no
  // half-compressed file to pick back up: a link followed by accident
  // costs the whole run, and the engine has to be fetched again if the
  // browser has dropped it. The shared guard puts the slide-and-confirm
  // in front of any link that would leave the page, and arms the
  // browser's own dialog for the tab being closed.
  if (scs.guardLeaving) {
    scs.guardLeaving(function () {
      if (!state.busy) return '';
      return 'A video is being compressed. Stopping it loses the work. The next run ' +
        'starts from the beginning' + (state.engine === 'ffmpeg'
          ? ', and the 31 MB engine downloads again if the browser has not kept it.' : '.');
    });
  }

  function resetOutput() {
    if (state.outUrl) { URL.revokeObjectURL(state.outUrl); state.outUrl = null; }
    state.outBlob = null;
    previewEl.removeAttribute('src');
    resultEl.classList.remove('is-over');
    show(resultEl, false);
    stage(state.file && state.duration ? 'ready' : 'idle');
  }

  againBtn.addEventListener('click', function () {
    resetOutput();
    setStatus('');
    fileInput.value = '';
    fileInput.click();
  });

  function outputFile() {
    try { return new File([state.outBlob], state.outName, { type: 'video/mp4' }); }
    catch (e) { return null; }
  }

  // ---------------- Save: the share sheet on a phone, a download elsewhere ----------------

  saveBtn.addEventListener('click', function () {
    if (!state.outBlob) return;
    var f = outputFile();
    if (f && navigator.canShare && navigator.share && navigator.canShare({ files: [f] })) {
      navigator.share({ files: [f] }).then(function () {
        setStatus('Shared.');
      }).catch(function (err) {
        if (err && err.name === 'AbortError') { setStatus(''); return; }
        downloadOutput();
      });
    } else {
      downloadOutput();
    }
  });

  function downloadOutput() {
    var a = document.createElement('a');
    a.href = state.outUrl;
    a.download = state.outName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setStatus('Downloaded as ' + state.outName + '.');
  }
})();
