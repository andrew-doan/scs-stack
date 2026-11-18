/* The slideshow: every photo and video in a list, one at a time, in a
   paper frame over a sign plate. Used by the gallery and the albums.
   scsSlideshow.start(slides) takes slides of the form
   { type, photo(), video(), sizes(), alt, plate() -> { code, name, right } }. */
(function () {
  'use strict';

  var scs = window.scs;
  var SET_KEY = 'scs2-slideshow';
  var settings = {
    photoSecs: 6,
    videoSecs: 12,
    speed: 1.5,
    muted: true,
    random: true
  };
  try {
    var saved = JSON.parse(localStorage.getItem(SET_KEY) || '{}');
    if (saved && typeof saved === 'object') {
      ['photoSecs', 'videoSecs', 'speed'].forEach(function (k) {
        if (typeof saved[k] === 'number' && isFinite(saved[k])) settings[k] = saved[k];
      });
      if (typeof saved.muted === 'boolean') settings.muted = saved.muted;
      if (typeof saved.random === 'boolean') settings.random = saved.random;
    }
  } catch (err) { /* defaults */ }
  function saveSettings() {
    try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (err) { /* this visit only */ }
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function videoPref() { return window.scsVideo ? window.scsVideo.pref() : 'auto'; }

  var slides = [];
  var show = {
    on: false,
    order: [],
    at: 0,
    timer: null,
    paused: false,
    layer: null,
    wake: null,
    node: null,
    root: null,
    stage: null,
    panelOpen: false
  };

  function shuffled(n) {
    var list = [];
    var i;
    for (i = 0; i < n; i++) list.push(i);
    for (i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }
    return list;
  }
  function orderFor() {
    if (settings.random) return shuffled(slides.length);
    var list = [];
    for (var i = 0; i < slides.length; i++) list.push(i);
    return list;
  }

  // the next slides download while one is on screen, pooled by slide
  var PRELOAD_AHEAD = 3;
  var prepared = {};

  function isVideo(item) { return String(item.type).indexOf('video/') === 0; }
  function slideSrc(item) { return isVideo(item) ? item.video() : item.photo(); }

  function makeNode(item) {
    var node;
    if (isVideo(item)) {
      node = document.createElement('video');
      node.preload = 'auto';
      node.playsInline = true;
      node.muted = true;
      node.src = item.video();
      try { node.load(); } catch (err) { /* errors again on show */ }
    } else {
      node = document.createElement('img');
      node.alt = item.alt || '';
      node.crossOrigin = 'anonymous';
      node.src = item.photo();
      if (node.decode) node.decode().catch(function () { /* shows anyway */ });
    }
    return node;
  }

  // a video holds memory until its src is dropped
  function releaseEntry(entry) {
    if (!entry) return;
    var node = entry.node;
    if (node && node.tagName === 'VIDEO') {
      try { node.pause(); node.removeAttribute('src'); node.load(); } catch (err) { /* already free */ }
    }
  }
  function clearPrepared() {
    Object.keys(prepared).forEach(function (pos) { releaseEntry(prepared[pos]); });
    prepared = {};
  }
  function primeAhead() {
    if (!show.on || !show.order.length) return;
    var want = {};
    for (var i = 1; i <= PRELOAD_AHEAD && i < show.order.length; i++) {
      var idx = show.order[(show.at + i) % show.order.length];
      var item = slides[idx];
      want[idx] = true;
      var have = prepared[idx];
      if (have && have.src === slideSrc(item)) continue;
      releaseEntry(have);
      prepared[idx] = { src: slideSrc(item), node: makeNode(item) };
    }
    Object.keys(prepared).forEach(function (idx) {
      if (!want[idx]) { releaseEntry(prepared[idx]); delete prepared[idx]; }
    });
  }
  function takeNode(idx, item) {
    var have = prepared[idx];
    delete prepared[idx];
    if (have && have.src === slideSrc(item)) return have.node;
    releaseEntry(have);
    return makeNode(item);
  }

  function buildShow() {
    var root = el('div', 'ss-overlay');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Slideshow');

    var stage = el('div', 'ss-stage');
    root.appendChild(stage);

    var bar = el('div', 'ss-bar');
    var prev = el('button', 'ss-btn ss-square', '←');
    prev.type = 'button';
    prev.title = 'Previous';
    var playBtn = el('button', 'ss-btn ss-square ss-play', '‖');
    playBtn.type = 'button';
    playBtn.title = 'Pause';
    var next = el('button', 'ss-btn ss-square', '→');
    next.type = 'button';
    next.title = 'Next';
    var count = el('span', 'ss-count');
    var gear = el('button', 'ss-btn', 'Settings');
    gear.type = 'button';
    var close = el('button', 'ss-btn', 'Close');
    close.type = 'button';
    bar.appendChild(prev);
    bar.appendChild(playBtn);
    bar.appendChild(next);
    bar.appendChild(count);
    bar.appendChild(gear);
    bar.appendChild(close);
    root.appendChild(bar);

    var panel = el('div', 'ss-panel is-hidden');
    panel.appendChild(el('p', 'ss-panel-title', 'Slideshow'));

    function slider(label, min, max, step, value, fmt, onInput) {
      var wrap = el('label', 'ss-field');
      var top = el('span', 'ss-field-top');
      top.appendChild(el('span', null, label));
      var out = el('strong', null, fmt(value));
      top.appendChild(out);
      wrap.appendChild(top);
      var input = document.createElement('input');
      input.type = 'range';
      input.min = String(min);
      input.max = String(max);
      input.step = String(step);
      input.value = String(value);
      input.addEventListener('input', function () {
        var v = Number(input.value);
        out.textContent = fmt(v);
        onInput(v);
        saveSettings();
      });
      wrap.appendChild(input);
      return wrap;
    }

    function choice(label, options, value, onChange) {
      var wrap = el('label', 'ss-field');
      var top = el('span', 'ss-field-top');
      top.appendChild(el('span', null, label));
      wrap.appendChild(top);
      var select = document.createElement('select');
      select.className = 'ss-select';
      options.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o.value;
        opt.textContent = o.text;
        if (o.value === value) opt.selected = true;
        select.appendChild(opt);
      });
      select.addEventListener('change', function () { onChange(select.value); });
      wrap.appendChild(select);
      return wrap;
    }

    panel.appendChild(slider('Photo on screen', 3, 20, 1, settings.photoSecs,
      function (v) { return v + 's'; }, function (v) { settings.photoSecs = v; }));
    panel.appendChild(slider('First seconds of a video', 3, 60, 1, settings.videoSecs,
      function (v) { return v + 's'; }, function (v) { settings.videoSecs = v; }));
    panel.appendChild(slider('Video speed', 0.5, 3, 0.25, settings.speed,
      function (v) { return v + '×'; }, function (v) {
        settings.speed = v;
        var vid = show.stage && show.stage.querySelector('video');
        if (vid) vid.playbackRate = v;
      }));

    // the video on screen keeps its size; the pooled ones are fetched again
    panel.appendChild(choice('Video quality', [
      { value: 'auto', text: 'Auto' },
      { value: '1080', text: '1080p' },
      { value: '720', text: '720p' },
      { value: '480', text: '480p' },
      { value: 'original', text: 'Original' }
    ], videoPref(), function (v) {
      if (window.scsVideo) window.scsVideo.setPref(v);
      primeAhead();
    }));

    var random = scs.rocker('sub-check ss-check', 'Random order');
    random.input.checked = !!settings.random;
    random.input.addEventListener('change', function () {
      settings.random = random.input.checked;
      saveSettings();
      if (!show.on) return;
      var current = show.order[show.at];
      show.order = orderFor();
      show.at = show.order.indexOf(current);
      if (show.at === -1) show.at = 0;
      primeAhead();
      show.count.textContent = (show.at + 1) + ' / ' + show.order.length;
    });
    panel.appendChild(random.label);

    var sound = scs.rocker('sub-check ss-check', 'Sound on');
    sound.input.checked = !settings.muted;
    sound.input.addEventListener('change', function () {
      settings.muted = !sound.input.checked;
      var vid = show.stage && show.stage.querySelector('video');
      if (vid) vid.muted = settings.muted;
      saveSettings();
    });
    panel.appendChild(sound.label);
    root.appendChild(panel);

    prev.addEventListener('click', function () { step(-1); });
    next.addEventListener('click', function () { step(1); });
    playBtn.addEventListener('click', function () { setPaused(!show.paused); });
    gear.addEventListener('click', function () {
      show.panelOpen = !show.panelOpen;
      panel.classList.toggle('is-hidden', !show.panelOpen);
    });
    close.addEventListener('click', function () { endShow(); });
    stage.addEventListener('click', function () { setPaused(!show.paused); });

    show.root = root;
    show.stage = stage;
    show.count = count;
    show.playBtn = playBtn;
    return root;
  }

  function setPaused(on) {
    show.paused = on;
    show.playBtn.textContent = on ? '▶' : '‖';
    show.playBtn.title = on ? 'Play' : 'Pause';
    show.root.classList.toggle('is-paused', on);
    var vid = show.stage.querySelector('video');
    if (vid) { if (on) vid.pause(); else vid.play().catch(function () {}); }
    if (on) {
      window.clearTimeout(show.timer);
    } else if (!vid) {
      show.timer = window.setTimeout(function () { step(1); }, settings.photoSecs * 1000);
    }
  }

  // listeners, sound and speed go on at show time: pooled elements are bare
  function drawSlide(item) {
    window.clearTimeout(show.timer);
    if (show.sizer) { show.sizer.destroy(); show.sizer = null; }
    var frame = el('div', 'ss-frame');
    var mat = el('div', 'ss-mat');
    var node = takeNode(show.order[show.at], item);
    // a slide that has left the stage still fires events (taking a video
    // off pauses it, which reports its time once more): only the one on
    // screen moves the show on
    show.node = node;
    var onStage = function () { return show.on && show.node === node; };
    var next = function () { if (onStage()) step(1); };
    if (isVideo(item)) {
      var list = item.sizes ? item.sizes() : null;
      if (list && window.scsVideo) show.sizer = window.scsVideo.play(node, list, {});
      node.muted = settings.muted;
      node.playbackRate = settings.speed;
      node.addEventListener('loadedmetadata', function () {
        node.playbackRate = settings.speed; // some browsers reset it on load
      });
      // counted in played seconds, so a slow start does not use it up
      node.addEventListener('timeupdate', function () {
        if (node.currentTime >= settings.videoSecs) next();
      });
      node.addEventListener('ended', next);
      node.addEventListener('error', next);
      // one that failed in the pool fires no second error
      if (node.error) {
        show.timer = window.setTimeout(function () { step(1); }, 400);
      } else {
        node.play().catch(function () { /* starts muted, or moves on */ });
      }
    } else {
      node.addEventListener('error', next);
      if (node.complete && node.naturalWidth === 0 && node.src) {
        show.timer = window.setTimeout(function () { step(1); }, 400);
      } else {
        show.timer = window.setTimeout(function () { step(1); }, settings.photoSecs * 1000);
      }
    }
    mat.appendChild(node);
    frame.appendChild(mat);

    var words = (item.plate && item.plate()) || {};
    var plate = el('div', 'ss-plate');
    var line = el('div', 'ss-plate-line');
    if (words.code) line.appendChild(el('span', 'ss-code', words.code));
    if (words.name) line.appendChild(el('span', 'ss-quest-name', words.name));
    plate.appendChild(line);
    if (words.right) plate.appendChild(el('strong', 'ss-team', words.right));
    frame.appendChild(plate);

    show.stage.textContent = '';
    show.stage.appendChild(frame);
    show.count.textContent = (show.at + 1) + ' / ' + show.order.length;
    if (show.paused) setPaused(true);
    primeAhead();
  }

  function step(by) {
    if (!show.on) return;
    show.at = (show.at + by + show.order.length) % show.order.length;
    drawSlide(slides[show.order[show.at]]);
  }

  function start(list) {
    if (show.on || !list || !list.length) return;
    slides = list;
    show.on = true;
    show.order = orderFor();
    show.at = 0;
    show.paused = false;
    document.documentElement.classList.add('ss-open');
    document.body.appendChild(buildShow());
    drawSlide(slides[show.order[0]]);
    if (window.scsBackLayer) show.layer = window.scsBackLayer.arm(function () { show.layer = null; endShow(); });
    keepAwake();
    document.addEventListener('keydown', onKey);
  }

  // Keeps a projector awake where the browser allows it. The browser lets
  // the lock go whenever the page is hidden, so it is asked for again on
  // the way back.
  function keepAwake() {
    if (!show.on || document.hidden || !navigator.wakeLock || !navigator.wakeLock.request) return;
    if (show.wake && !show.wake.released) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      if (show.on) show.wake = lock;
      else lock.release().catch(function () {});
    }).catch(function () {});
  }
  document.addEventListener('visibilitychange', keepAwake);

  function endShow() {
    if (!show.on) return;
    show.on = false;
    window.clearTimeout(show.timer);
    if (show.sizer) { show.sizer.destroy(); show.sizer = null; }
    clearPrepared();
    document.removeEventListener('keydown', onKey);
    document.documentElement.classList.remove('ss-open');
    if (show.root && show.root.parentNode) show.root.parentNode.removeChild(show.root);
    show.root = null;
    show.stage = null;
    show.node = null;
    show.panelOpen = false;
    slides = [];
    if (show.wake) { try { show.wake.release(); } catch (err) { /* gone already */ } show.wake = null; }
    if (show.layer && window.scsBackLayer) {
      var layer = show.layer;
      show.layer = null;
      window.scsBackLayer.disarm(layer);
    }
  }

  function onKey(e) {
    if (!show.on || e.defaultPrevented) return;
    // a layer opened over the show has the keys
    if (show.layer && !window.scsBackLayer.isTop(show.layer)) return;
    if (e.key === 'Escape') { e.preventDefault(); endShow(); return; }
    if (e.key === 'ArrowRight') { step(1); return; }
    if (e.key === 'ArrowLeft') { step(-1); return; }
    if (e.key === ' ') { e.preventDefault(); setPaused(!show.paused); }
  }

  window.scsSlideshow = { start: start, stop: endShow, isOn: function () { return show.on; } };
})();
