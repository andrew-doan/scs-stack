/* Which copy of a video plays. The encoder makes copies at 1080p, 720p
   and 480p (never above the video's own size); Original is the file as
   it was sent. Auto starts at the largest copy, or lower on a connection
   the browser says is slow, moves down a copy when playback keeps
   stopping to load and back up when the download stays well ahead.
   The choice is kept on this device. Loaded by the site's pages that
   play video, by the dashboard and by a shared video's page. */
(function () {
  'use strict';

  var PREF_KEY = 'scs2-video-size';
  var OLD_KEY = 'scs2-gallery-res';
  var AUTO_KEY = 'scs2-video-auto';
  var CHOICES = ['auto', '1080', '720', '480', 'original'];

  function pref() {
    var v = '';
    try { v = localStorage.getItem(PREF_KEY) || localStorage.getItem(OLD_KEY) || ''; } catch (err) { /* none kept */ }
    return CHOICES.indexOf(v) === -1 ? 'auto' : v;
  }
  function setPref(v) {
    if (CHOICES.indexOf(v) === -1) return;
    try { localStorage.setItem(PREF_KEY, v); } catch (err) { /* this visit only */ }
  }
  function bucket(h) { return h >= 1080 ? '1080' : h >= 720 ? '720' : '480'; }

  // Every copy the encoder made, largest first, then the file as sent.
  // url(res) is the address for one res value. A copy under 480 is asked
  // for as 480, which the worker answers with the largest copy below it.
  function sizes(heights, url) {
    var seen = {};
    var out = [];
    (heights || []).map(Number).sort(function (a, b) { return b - a; }).forEach(function (h) {
      h = Math.round(h);
      if (!h || seen[h]) return;
      seen[h] = true;
      out.push({ h: h, label: h + 'p', url: url(bucket(h)) });
    });
    out.push({ h: 0, label: 'Original', url: url('original') });
    return out;
  }

  function levelsOf(list) { return list.filter(function (s) { return s.h > 0; }); }
  function originalOf(list) { return list.filter(function (s) { return !s.h; })[0] || null; }

  // the copy at or under a res, else the smallest there is
  function levelFor(levels, res) {
    var want = Number(res);
    for (var i = 0; i < levels.length; i++) if (levels[i].h <= want) return i;
    return levels.length - 1;
  }

  // where Auto starts: the largest copy, less on a connection the
  // browser reports as slow, and no higher than this visit last settled
  function autoStart(levels) {
    var at = 0;
    var c = navigator.connection || {};
    var type = String(c.effectiveType || '');
    if (c.saveData || type === 'slow-2g' || type === '2g') at = levels.length - 1;
    else if (type === '3g') at = levelFor(levels, 480);
    var kept = 0;
    try { kept = Number(sessionStorage.getItem(AUTO_KEY)) || 0; } catch (err) { /* none kept */ }
    if (kept) at = Math.max(at, levelFor(levels, kept));
    return at;
  }

  // The copy a video would start at, for a player that loads it ahead
  // of time.
  function pick(list) {
    var levels = levelsOf(list);
    var p = pref();
    if (p === 'original' || !levels.length) return originalOf(list) || list[0];
    return levels[p === 'auto' ? autoStart(levels) : levelFor(levels, p)];
  }

  // Plays list on video and keeps it on the right copy. opts.control
  // builds a select for changing it (controller.control); opts.note(text)
  // hears anything the viewer should be told.
  function play(video, list, opts) {
    opts = opts || {};
    var levels = levelsOf(list);
    var original = originalOf(list);
    var mode = levels.length ? pref() : 'original';
    var at = 0;
    var current = null;
    var started = false;
    // asked to play: a video waiting for its first frame reads as paused
    var wanted = !!video.autoplay;
    var swapping = false;
    var loadStart = 0;
    var stallAt = 0;
    var stalls = [];
    var lastChange = 0;
    var lastUp = 0;
    var upBlocked = false;
    var lastEnd = -1;
    var lastSample = 0;
    var rate = 0;
    var timer = null;
    var failed = 0;
    var netTries = 0;
    var select = null;

    function now() { return Date.now(); }
    function remember() {
      if (mode !== 'auto' || !current || !current.h) return;
      try { sessionStorage.setItem(AUTO_KEY, String(current.h)); } catch (err) { /* this video only */ }
    }

    function load(entry, keepTime) {
      if (keepTime && entry === current) { paint(); return; }
      var t = keepTime ? video.currentTime || 0 : 0;
      var playing = keepTime && wanted && !video.ended;
      var speed = video.playbackRate;
      current = entry;
      started = !keepTime ? false : started;
      stallAt = 0;
      lastEnd = -1;
      rate = 0;
      loadStart = now();
      swapping = !!keepTime;
      // one already loading this copy (prepared ahead, or written in the
      // page) is left to carry on
      if (keepTime || video.src !== new URL(entry.url, location.href).href) video.src = entry.url;
      if (keepTime) {
        var resume = function () {
          video.removeEventListener('loadedmetadata', resume);
          try { if (t) video.currentTime = t; } catch (err) { /* from the start */ }
          video.playbackRate = speed;
          if (playing) {
            var p = video.play();
            if (p && p.catch) p.catch(function () { /* the controls are there */ });
          }
          swapping = false;
        };
        video.addEventListener('loadedmetadata', resume);
      }
      paint();
    }

    function move(to, why) {
      if (to < 0 || to >= levels.length || levels[to] === current) return;
      if (why === 'down' && now() - lastUp < 15000) upBlocked = true;
      if (why === 'up') lastUp = now();
      at = to;
      lastChange = now();
      stalls = [];
      load(levels[at], true);
      remember();
    }

    function ahead() {
      var b = video.buffered;
      var t = video.currentTime;
      for (var i = 0; i < b.length; i++) {
        if (b.start(i) <= t + 0.5 && b.end(i) >= t) return { end: b.end(i), secs: b.end(i) - t };
      }
      return { end: t, secs: 0 };
    }

    function tick() {
      if (mode !== 'auto' || !current || !current.h) return;
      var n = now();
      // how fast the download is getting ahead, in seconds of video a
      // second, smoothed
      var a = ahead();
      if (lastSample && lastEnd >= 0 && a.end >= lastEnd) {
        var r = (a.end - lastEnd) / ((n - lastSample) / 1000);
        rate = rate ? rate * 0.6 + r * 0.4 : r;
      }
      lastEnd = a.end;
      lastSample = n;
      if (swapping || video.paused && started) return;
      // nothing to show yet, long after being asked to play
      if (!started && wanted && n - loadStart > 6000 && video.readyState < 3) return move(at + 1, 'down');
      // stopped to load: one long wait, or a run of short ones
      var stalled = stallAt ? n - stallAt : 0;
      stalls = stalls.filter(function (s) { return n - s.at < 30000; });
      var waited = stalled + stalls.reduce(function (sum, s) { return sum + s.ms; }, 0);
      if (stalled > 2500 || waited > 3500) return move(at + 1, 'down');
      // well ahead with no trouble for a while: try the next copy up
      var dur = video.duration || 0;
      var whole = dur && a.end >= dur - 0.5;
      var left = dur ? dur - video.currentTime : 0;
      if (at > 0 && !upBlocked && started && n - lastChange > 12000 && !stalls.length && !stallAt &&
        ((whole && left > 8) || (a.secs > 20 && rate > 3))) {
        move(at - 1, 'up');
      }
    }

    function onWaiting() {
      if (!started || swapping || video.seeking) return;
      if (!stallAt) stallAt = now();
    }
    function onPlaying() {
      started = true;
      failed = 0;
      netTries = 0;
      if (stallAt) {
        stalls.push({ at: now(), ms: now() - stallAt });
        stallAt = 0;
      }
    }
    function onSeeking() { stallAt = 0; }
    function onPlay() { wanted = true; }
    function onPause() { if (started) wanted = false; }
    function onError() {
      if (!current) return;
      // the connection dropped: the same copy again, from where it was
      if (video.error && video.error.code === 2 && netTries < 5) {
        var same = current;
        netTries += 1;
        setTimeout(function () {
          if (current !== same) return;
          current = null;
          load(same, true);
        }, 1000 * netTries);
        return;
      }
      failed += 1;
      if (current === original && levels.length) {
        // some phones film in a format other browsers cannot play
        mode = 'auto';
        setPref('auto');
        if (opts.note) opts.note('This browser cannot play the original file.');
        load(levels[at = autoStart(levels)], true);
        return;
      }
      if (failed > 2) return;
      if (current.h && at < levels.length - 1) load(levels[++at], true);
      else if (current.h && original) load(original, true);
    }

    function paint() {
      if (!select) return;
      var auto = select.querySelector('option[value="auto"]');
      if (auto) auto.textContent = mode === 'auto' && current && current.h ? 'Auto · ' + current.label : 'Auto';
      select.value = mode === 'auto' ? 'auto' : current === original ? 'original' : String(current && current.h);
    }

    function choose(v) {
      if (v === 'auto') {
        mode = 'auto';
        setPref('auto');
        upBlocked = false;
        lastChange = now();
        if (current === original) load(levels[at = autoStart(levels)], true);
        else paint();
        return;
      }
      if (v === 'original') {
        mode = 'original';
        setPref('original');
        load(original, true);
        return;
      }
      var h = Number(v);
      var i = 0;
      while (i < levels.length - 1 && levels[i].h !== h) i++;
      mode = bucket(h);
      setPref(mode);
      at = i;
      load(levels[at], true);
    }

    if (opts.control && list.length > 1) {
      select = document.createElement('select');
      select.className = opts.className || 'video-size';
      select.setAttribute('aria-label', 'Video quality');
      if (levels.length) select.appendChild(new Option('Auto', 'auto'));
      levels.forEach(function (s) { select.appendChild(new Option(s.label, String(s.h))); });
      if (original) select.appendChild(new Option('Original', 'original'));
      select.addEventListener('change', function () { choose(select.value); });
      // a change of copy is not a tap on the video behind it
      select.addEventListener('click', function (e) { e.stopPropagation(); });
    }

    video.addEventListener('waiting', onWaiting);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('error', onError);
    if (mode === 'original') load(original || list[0], false);
    else {
      at = mode === 'auto' ? autoStart(levels) : levelFor(levels, mode);
      load(levels[at], false);
    }
    timer = window.setInterval(tick, 1000);

    return {
      control: select,
      current: function () { return current; },
      destroy: function () {
        window.clearInterval(timer);
        video.removeEventListener('waiting', onWaiting);
        video.removeEventListener('playing', onPlaying);
        video.removeEventListener('seeking', onSeeking);
        video.removeEventListener('play', onPlay);
        video.removeEventListener('pause', onPause);
        video.removeEventListener('error', onError);
      }
    };
  }

  window.scsVideo = { sizes: sizes, pick: pick, play: play, pref: pref, setPref: setPref };
})();
