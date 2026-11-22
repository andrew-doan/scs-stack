// The site's shared script, part one of five: the helpers on window.scs.
// site-viewer.js, site-chrome.js, site-input.js and site-app.js follow it,
// in that order, and the last of them runs all five.
(window.scsSite = window.scsSite || { parts: [] }).parts.push(function (site) {
  'use strict';

  // functions the other parts call
  site.handheld = handheld;
  site.appLayoutWanted = appLayoutWanted;
  site.syncAppLayout = syncAppLayout;
  site.fetchRetry = fetchRetry;
  site.sitePath = sitePath;
  site.readAs = readAs;
  site.fetchPulse = fetchPulse;

  var root = document.documentElement;
  // Installed as an app, or a browser tab? The boot script has already
  // decided and stamped the document, but a page served without it
  // still has to work.
  var installed = root.classList.contains('is-installed') ||
    (function () {
      try { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }
      catch (e) { return false; }
    })();
  if (installed) root.classList.add('is-installed');

  // On a phone-sized browser the app layout is what you get unless the
  // setting says otherwise — `is-pwa` is the layout, `is-installed` is
  // the fact. Everything below that belongs to launching a real app
  // (the splash, the scroll restore, asking for persistent storage)
  // keys off the fact; the chrome keys off the layout.
  var APP_LAYOUT_KEY = 'scs2-app-layout';
  // The whole event is one day, so on the day every stamp on the site
  // is from today and the date beside it says nothing. fmtTime drops it
  // by itself on the day; this is the rocker that drops it whatever the
  // day, for a reader who already knows.
  var DATES_KEY = 'scs2-hide-dates';
  var CLOCK_KEY = 'scs2-clock';
  // A handheld, rather than a small window. Width alone said phone
  // whenever a desktop window was dragged narrow, which put the app
  // chrome on, locked page zoom and offered to install the app. So ask
  // the device what it points with instead: a phone or tablet's primary
  // pointer is coarse and has nothing to hover with, and that is a
  // better question than the user agent — iPadOS calls itself a Mac,
  // any browser's string can be changed, and a touchscreen laptop with
  // a trackpad answers these two honestly (fine, and it hovers).
  var coarseMq = window.matchMedia('(pointer: coarse)');
  var hoverlessMq = window.matchMedia('(hover: none)');
  var narrowMq = window.matchMedia('(max-width: 840px)');
  function handheld() { return coarseMq.matches || hoverlessMq.matches; }
  function appLayoutWanted() {
    try { return localStorage.getItem(APP_LAYOUT_KEY) !== '0'; } catch (err) { return true; }
  }
  // The installed app keeps the app layout whatever the switch says,
  // up to the same width: wider (a tablet on its side) it is the
  // desktop page, since the app layout is drawn for a phone.
  site.afterLayout = null;
  function syncAppLayout() {
    root.classList.toggle('is-pwa', installed ? narrowMq.matches : handheld() && narrowMq.matches && appLayoutWanted());
    if (site.afterLayout) site.afterLayout();
  }
  syncAppLayout();
  // width can change with the window, and what you point with can
  // change too when a mouse is plugged in
  var layoutMqs = [narrowMq, coarseMq, hoverlessMq];
  for (var mqi = 0; mqi < layoutMqs.length; mqi++) {
    if (layoutMqs[mqi].addEventListener) layoutMqs[mqi].addEventListener('change', syncAppLayout);
    else if (layoutMqs[mqi].addListener) layoutMqs[mqi].addListener(syncAppLayout);
  }

  var isPwa = root.classList.contains('is-pwa');
  // handhelds and the installed app share the app-style chrome
  // behaviour; a narrow desktop window is still a desktop window
  var phoneish = isPwa || (handheld() && narrowMq.matches);

  // Nothing in the two bars fades until the page has loaded
  // (html.chrome-ready, site.css): a style change made while the page is
  // still arriving would otherwise play as a fade. Two frames
  // after the load event, or a second after this script runs if a slow
  // picture is holding the load event up, so a tap is not left without
  // its fade for long.
  var chromeReady = function () {
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () { root.classList.add('chrome-ready'); });
    });
  };
  if (document.readyState === 'complete') chromeReady();
  else {
    window.addEventListener('load', chromeReady);
    window.setTimeout(chromeReady, 1000);
  }

  // ---------------- Shared helpers for the page scripts ----------------
  // The tab worker's address, the quest code normaliser the worker
  // uses, the quest list it serves, and the O/I rocker markup.
  var TAB_API = 'https://files.scs.andyrew.space';

  // ---- a read that tries again ----
  // A phone that has just woken or changed networks often loses its
  // first request and gets the second: the page said it could not load
  // and a reload fixed it. `scs.fetch` is fetch with up to six more
  // tries over about sixteen seconds, for reads from the tab worker. It
  // tries again when no answer came back at all, when none has come in
  // eight seconds (`timeout` in the options sets another limit), and on
  // 502, 503 and 504, which are a gateway saying the same thing; any
  // other answer or an abort goes straight back to the caller. Only GET: a POST that failed may still
  // have arrived, and sending it again is not the same as asking again.
  // The site's own pages and files are tried again by sw.js instead.
  var RETRY_DELAYS = [250, 500, 1000, 2000, 4000, 8000];
  var ANSWER_WITHIN = 8000;
  function fetchRetry(url, opts) {
    var method = String((opts && opts.method) || 'GET').toUpperCase();
    if (method !== 'GET') return fetch(url, opts);
    var signal = opts && opts.signal;
    var wait = (opts && opts.timeout) || ANSWER_WITHIN;
    function more(i) {
      return i < RETRY_DELAYS.length && !(signal && signal.aborted);
    }
    function later(i) {
      return new Promise(function (resolve, reject) {
        if (signal && signal.aborted) {
          var aborted = new Error('Aborted');
          aborted.name = 'AbortError';
          return reject(aborted);
        }
        function onAbort() {
          clearTimeout(waitTimer);
          var err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        }
        var waitTimer = setTimeout(function () {
          if (signal) signal.removeEventListener('abort', onAbort);
          resolve();
        }, RETRY_DELAYS[i]);
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
      }).then(function () { return attempt(i + 1); });
    }
    // one try, given up when no answer has come in time; the caller's
    // own abort still reaches it, the body included
    function once() {
      if (typeof AbortController !== 'function') return fetch(url, opts);
      var ctl = new AbortController();
      var own = {};
      var timedOut = false;
      for (var k in opts) {
        if (k !== 'timeout' && Object.prototype.hasOwnProperty.call(opts, k)) own[k] = opts[k];
      }
      own.signal = ctl.signal;
      var onAbort = null;
      if (signal) {
        if (signal.aborted) ctl.abort();
        else {
          onAbort = function () { ctl.abort(); };
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      var timer = setTimeout(function () { timedOut = true; ctl.abort(); }, wait);
      function clean() {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      }
      return fetch(url, own).then(function (response) {
        clean();
        return response;
      }, function (err) {
        clean();
        if (!timedOut) throw err;
        var late = new Error('No answer in time');
        late.name = 'TimeoutError';
        throw late;
      });
    }
    function attempt(i) {
      return once().then(function (response) {
        var busy = response.status === 502 || response.status === 503 || response.status === 504;
        return busy && more(i) ? later(i) : response;
      }, function (err) {
        if ((err && err.name === 'AbortError') || !more(i)) throw err;
        return later(i);
      });
    }
    return attempt(0);
  }

  // ---- a load that gave up, asked again ----
  // `scs.again(key, fn)` is for a page whose load has run out of tries:
  // fn runs after 3, 10, 30 and then every 60 seconds, and at once when
  // the device comes back online or the page is looked at again. A load
  // that fails again calls it again; one that works calls
  // `scs.gotIt(key)`. `{timer: false}` leaves the clock out, for an fn
  // that reloads the page.
  var AGAIN_WAITS = [3000, 10000, 30000, 60000];
  var againFor = {};
  function again(key, fn, opts) {
    var w = againFor[key] || (againFor[key] = { tries: 0, timer: 0, fn: null });
    clearTimeout(w.timer);
    w.fn = fn;
    if (opts && opts.timer === false) return;
    w.timer = setTimeout(function () { runAgain(key); }, AGAIN_WAITS[Math.min(w.tries, AGAIN_WAITS.length - 1)]);
    w.tries += 1;
  }
  function runAgain(key) {
    var w = againFor[key];
    if (!w || !w.fn || document.hidden) return;
    clearTimeout(w.timer);
    var fn = w.fn;
    w.fn = null;
    fn();
  }
  function gotIt(key) {
    var w = againFor[key];
    if (!w) return;
    clearTimeout(w.timer);
    delete againFor[key];
  }
  function allAgain() { Object.keys(againFor).forEach(runAgain); }

  // A script from another site (the human check), asked for again when
  // it does not arrive.
  function needScript(src) {
    var tag = document.createElement('script');
    tag.src = src;
    tag.async = true;
    tag.onload = function () { gotIt('script:' + src); };
    tag.onerror = function () {
      if (tag.parentNode) tag.parentNode.removeChild(tag);
      again('script:' + src, function () { needScript(src); });
    };
    document.head.appendChild(tag);
  }
  window.addEventListener('online', allAgain);
  document.addEventListener('visibilitychange', allAgain);
  window.addEventListener('pageshow', function (e) { if (e.persisted) allAgain(); });

  // Words typed beside the one that matters, for the quest search.
  var SEARCH_FILLER = ['the', 'a', 'an', 'of', 'in', 'at', 'on', 'to', 'for', 'with', 'and', 'or', 'quest', 'public', 'one', 'some', 'that', 'thing'];

  // The way to another page of the site from whichever page this is.
  // Every page carries the bell, and the bell's href is the path to
  // /messages/ from here, so the site's root is that minus the last
  // segment. Relative URLs are the rule everywhere (a Netlify preview
  // and a GitHub Pages project site are both served from a
  // subdirectory), and this is how a link built in script keeps to it.
  function sitePath(page) {
    var bell = document.querySelector('.bell-toggle');
    var href = bell ? bell.getAttribute('href') : '';
    if (/messages\/$/.test(href)) return href.replace(/messages\/$/, '') + page;
    return '../' + page; // the messages page itself carries no way up
  }
  var QUESTLIST_CACHE = 'scs2-questlist-cache';
  var questListPromise = null;

  // ---- the quest list a team sees ----
  // Some quests show only to teams signed in with their submit code (the
  // submit page's session, which the gallery and the quest page share).
  // Signed in, the list comes from /api/questlist/team and carries what
  // that team may see; signed out, or with a session the
  // worker no longer knows, it is the public list. Each copy kept on the
  // device says whose it is (`seenBy`, the start of the session), so a
  // team's list is never painted for somebody signed out or for another
  // team signed in on the same phone.
  function teamSession() {
    try { return localStorage.getItem('scs2-submit-session') || ''; } catch (err) { return ''; }
  }
  function sessionMark(token) { return token ? token.slice(0, 12) : ''; }
  // The quest list, the pulse and the messages each come in two copies:
  // the public one and a signed-in team's own. The team's is asked for
  // when this device has a session, and the public one when it has none
  // or the worker no longer knows it.
  // `no-cache` has the browser send the copy it holds back to the worker
  // as a tag, so an unchanged answer comes back as a 304 with no body.
  function readAs(publicPath, teamPath) {
    var token = teamSession();
    function get(signedIn) {
      return fetchRetry(TAB_API + (signedIn ? teamPath : publicPath), {
        cache: 'no-cache',
        headers: signedIn ? { authorization: 'Bearer ' + token } : {}
      }).then(function (r) {
        if (signedIn && r.status === 401) return get(false);
        if (!r.ok) throw new Error(publicPath + ' ' + r.status);
        return r.json();
      });
    }
    return get(!!token);
  }
  // `version` is the pulse's quests number when the page knows it. It
  // goes on the address, so the worker's edge copy from before that
  // version is never the one handed back.
  var listFetching = {}; // one request per version at a time
  function fetchQuestList(version) {
    var token = teamSession();
    var q = typeof version === 'number' ? '?v=' + version : '';
    var key = sessionMark(token) + q;
    if (listFetching[key]) return listFetching[key];
    var job = readAs('/api/questlist' + q, '/api/questlist/team' + q).then(function (data) {
      if (!data || !data.groups) throw new Error('questlist shape');
      // an expired session gets the public list, and that is this
      // session's copy until it signs in again
      data.seenBy = sessionMark(token);
      data.keptAt = Date.now();
      try { localStorage.setItem(QUESTLIST_CACHE, JSON.stringify(data)); } catch (err) { /* not persisted */ }
      return data;
    });
    listFetching[key] = job;
    var done = function () { delete listFetching[key]; };
    job.then(done, done);
    return job;
  }

  // ---- what the worker has, in three numbers ----
  // GET /api/pulse answers {quests, messages, message_seqs, urgent}: the
  // quest list's version, the newest messages and the id of the live
  // urgent message (0 for none). A signed-in team asks /api/pulse/team,
  // whose messages are the ones that team can read. One fetch per visit,
  // and one more when a page comes back after a spell in the background
  // or a team signs in or out. A failure resolves null — nothing on the
  // page depends on it, so an offline visit simply says nothing.
  var MSG_READ_KEY = 'scs2-msg-read';
  var MSG_READ_CAP = 200;
  var MSG_SEEN_KEY = 'scs2-msg-seen'; // read once, to build the set
  var PULSE_STALE = 60000; // how long away counts as worth asking again
  site.pulsePromise = null;
  site.lastPulse = null;
  site.hiddenAt = 0;

  // A kept quest list is current while the pulse's quests number is the
  // one it was built at, either way. A question with a closing time
  // leaves the list when it closes, which moves no number, and a new
  // deploy may change what the list carries, so such a copy and one over
  // half an hour old are asked for again.
  var LIST_KEEP_MS = 30 * 60 * 1000;
  function listCurrent(copy, version) {
    if (typeof copy.version !== 'number' || copy.version !== version) return false;
    if (!(Date.now() - (copy.keptAt || 0) < LIST_KEEP_MS)) return false;
    return !(copy.groups || []).some(function (g) { return g.ask && g.ask.open_until; });
  }
  function pulseOnce() {
    if (!site.pulsePromise) site.pulsePromise = fetchPulse();
    return site.pulsePromise;
  }

  function fetchPulse() {
    return readAs('/api/pulse', '/api/pulse/team')
      .then(function (data) {
        site.lastPulse = (data && typeof data === 'object') ? data : null;
        if (site.lastPulse && Array.isArray(site.lastPulse.date_rules)) keepDateRules(site.lastPulse.date_rules);
        // every answer, the first included, for a page that has to follow
        // the pulse after its first look (the live tab, the quest list)
        if (site.lastPulse) window.dispatchEvent(new CustomEvent('scs-pulse', { detail: site.lastPulse }));
        return site.lastPulse;
      })
      .catch(function () { return null; });
  }

  // The organisers' rules for which days print without their date (the
  // dashboard's Dates card): {kind: 'on' | 'from' | 'until', date}. Kept
  // on the device so the first paint already follows them; a change
  // redraws every time on the page.
  var DATE_RULES_KEY = 'scs2-date-rules';
  var dateRules = [];
  try { dateRules = JSON.parse(localStorage.getItem(DATE_RULES_KEY) || '[]') || []; } catch (err) { dateRules = []; }
  function keepDateRules(rules) {
    var next = JSON.stringify(rules);
    if (next === JSON.stringify(dateRules)) return;
    dateRules = rules;
    try { localStorage.setItem(DATE_RULES_KEY, next); } catch (err) { /* not kept */ }
    document.dispatchEvent(new CustomEvent('scs-dates-changed'));
  }
  function ruledOut(d) {
    if (!dateRules.length) return false;
    var day = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
    return dateRules.some(function (r) {
      if (!r || !r.date) return false;
      if (r.kind === 'on') return day === r.date;
      if (r.kind === 'from') return day >= r.date;
      if (r.kind === 'until') return day <= r.date;
      return false;
    });
  }
  // a chart's stamp as a Date: "2026-10-20 03:15" is UTC, a bare "14:15"
  // (the worker took its date off) is already on the event's clock
  function stampDate(t) {
    var bare = t.match(/^(\d{2}):(\d{2})$/);
    var m = bare ? null : t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/);
    if (!bare && !m) return null;
    var d = bare ? new Date(2000, 0, 1, +bare[1], +bare[2]) : new Date(m[1] + 'T' + m[2] + ':' + m[3] + ':00Z');
    return isNaN(d.getTime()) ? null : d;
  }

  // the message seqs a pulse names; a worker with no list names the newest
  function pulseSeqs(pulse) {
    var list = Array.isArray(pulse.message_seqs) ? pulse.message_seqs
      : (typeof pulse.messages === 'number' ? [pulse.messages] : []);
    return list.filter(function (s) { return typeof s === 'number' && s > 0; });
  }
  // The seqs this device has read. Built once: a first visit has read
  // nothing, so what is there lights the dot, and the old single mark
  // takes everything at or below it.
  function msgRead(seqs) {
    var read = window.scs.seenSet(MSG_READ_KEY);
    if (read) return read;
    var was = window.scs.seen(MSG_SEEN_KEY);
    return window.scs.addSeen(MSG_READ_KEY,
      was === null ? [] : seqs.filter(function (s) { return s <= was; }), MSG_READ_CAP);
  }

  // The installed app's icon carries the number of unread messages,
  // where the platform offers it (Chrome, Edge, Safari on a home-screen
  // app). Anything else simply never sees a badge.
  function setAppBadge(count) {
    try {
      if (!navigator.setAppBadge) return;
      var res;
      if (count > 0) res = navigator.setAppBadge(count);
      else if (navigator.clearAppBadge) res = navigator.clearAppBadge();
      else res = navigator.setAppBadge(0);
      // a platform that refuses (no home-screen app yet) says nothing
      if (res && res.catch) res.catch(function () {});
    } catch (err) { /* badges are a bonus, never an error */ }
  }

  // The VAPID key arrives base64url; the subscribe call wants bytes.
  function b64ToKey(b64) {
    var pad = '===='.slice(0, (4 - (b64.length % 4)) % 4);
    var raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  // Push is turned on or off from two switches (the settings menu and
  // the messages page). One change at a time, and each says when it has
  // landed, so the other switch can read the state again.
  var pushRuns = 0;
  function pushRun(run) {
    pushRuns += 1;
    var done = function () {
      pushRuns -= 1;
      document.dispatchEvent(new CustomEvent('scs-push-changed'));
    };
    run.then(done, done);
    return run;
  }

  // ---- HEIC and WebP go up as JPEG ----
  // The worker's stripper reads neither format, so they are redrawn as
  // JPEG here, with the original's EXIF copied into the new file.
  // Only Safari draws HEIC; elsewhere the vendored libheif build
  // (assets/heic, 3MB) is fetched the first time one is picked.
  // Over MAX_CONVERT_PIXELS a picture is scaled down: iOS Safari will
  // not make a bigger canvas.
  var MAX_CONVERT_PIXELS = 16000000;
  var JPEG_QUALITY = 0.92;
  function heicFile(file) {
    var type = String(file && file.type || '').toLowerCase();
    return type === 'image/heic' || type === 'image/heif' || /\.(heic|heif)$/i.test(String(file && file.name || ''));
  }
  function needsConverting(file) {
    return heicFile(file) || String(file && file.type || '').toLowerCase() === 'image/webp' ||
      /\.webp$/i.test(String(file && file.name || ''));
  }
  // What a file that is made a JPEG is, from its type or, where a browser
  // gives none, its name. The file as picked goes up beside the JPEG
  // under this type.
  function pickedType(file) {
    var type = String(file && file.type || '').toLowerCase();
    if (type === 'image/heic' || type === 'image/heif' || type === 'image/webp') return type;
    var ext = /\.(heic|heif|webp)$/i.exec(String(file && file.name || ''));
    return ext ? 'image/' + ext[1].toLowerCase() : '';
  }
  var heicLib = null;
  function loadHeic() {
    if (window.HeicTo) return Promise.resolve(window.HeicTo);
    if (heicLib) return heicLib;
    heicLib = new Promise(function (resolve, reject) {
      var me = document.querySelector('script[src*="assets/site.js"]');
      var tag = document.createElement('script');
      tag.src = new URL('heic/heic-to.js', me ? me.src : location.href).toString();
      tag.onload = function () { if (window.HeicTo) resolve(window.HeicTo); else reject(new Error('no HEIC decoder')); };
      tag.onerror = function () { heicLib = null; reject(new Error('the HEIC decoder did not load')); };
      document.head.appendChild(tag);
    });
    return heicLib;
  }
  // an ImageBitmap, then an <img>, then for HEIC the vendored decoder
  function decodePicture(file) {
    function bitmap(bmp) { return { pic: bmp, done: function () { if (bmp.close) bmp.close(); } }; }
    function viaImg() {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () { resolve({ pic: img, done: function () { URL.revokeObjectURL(url); } }); };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('not a picture this browser draws')); };
        img.src = url;
      });
    }
    var drawn = window.createImageBitmap ? window.createImageBitmap(file).then(bitmap, viaImg) : viaImg();
    return drawn.catch(function (err) {
      if (!heicFile(file)) throw err;
      return loadHeic().then(function (HeicTo) {
        return HeicTo({ blob: file, type: 'bitmap' });
      }).then(bitmap);
    });
  }
  function drawJpeg(got) {
    var w = got.pic.naturalWidth || got.pic.width;
    var h = got.pic.naturalHeight || got.pic.height;
    var scale = Math.min(1, Math.sqrt(MAX_CONVERT_PIXELS / Math.max(1, w * h)));
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    var ctx = canvas.getContext('2d');
    // white first, or a transparent part comes out black
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(got.pic, 0, 0, canvas.width, canvas.height);
    got.done();
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        canvas.width = 0;
        canvas.height = 0;
        if (blob) resolve(blob); else reject(new Error('could not make a JPEG'));
      }, 'image/jpeg', JPEG_QUALITY);
    });
  }

  // ---- the EXIF of a WebP or a HEIC, as a TIFF block ----
  function readBytes(blob, start, end) {
    var part = blob.slice(start, end);
    if (part.arrayBuffer) return part.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(new Uint8Array(reader.result)); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsArrayBuffer(part);
    });
  }
  function fourcc(b, at) {
    return at + 4 > b.length ? '' : String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);
  }
  // an unsigned big-endian number of n bytes
  function uintBE(b, at, n) {
    if (at + n > b.length) throw new Error('past the end');
    var v = 0;
    for (var i = 0; i < n; i++) v = v * 256 + b[at + i];
    return v;
  }
  function uint32LE(b, at) {
    if (at + 4 > b.length) throw new Error('past the end');
    return b[at] + b[at + 1] * 256 + b[at + 2] * 65536 + b[at + 3] * 16777216;
  }
  // "Exif\0\0"; its first four bytes are also the HEIC item type
  var EXIF_MAGIC = [0x45, 0x78, 0x69, 0x66, 0, 0];
  function startsExif(b, at, n) {
    n = n || 6;
    if (at + n > b.length) return false;
    for (var i = 0; i < n; i++) if (b[at + i] !== EXIF_MAGIC[i]) return false;
    return true;
  }
  // the bytes from `at` on, if a TIFF header starts there
  function tiffFrom(b, at) {
    if (at < 0 || at + 8 > b.length) return null;
    var ii = b[at] === 0x49 && b[at + 1] === 0x49 && b[at + 2] === 42 && b[at + 3] === 0;
    var mm = b[at] === 0x4D && b[at + 1] === 0x4D && b[at + 2] === 0 && b[at + 3] === 42;
    return ii || mm ? new Uint8Array(b.subarray(at)) : null;
  }

  // WebP: an 'EXIF' chunk in a VP8X file, flagged in the VP8X header
  function webpExif(file) {
    return readBytes(file, 0, 30).then(function (head) {
      if (fourcc(head, 12) !== 'VP8X' || !(head[20] & 0x08)) return null;
      var end = Math.min(file.size, uint32LE(head, 4) + 8);
      var hops = 0;
      function chunkAt(at) {
        if (at + 8 > end || ++hops > 256) return null;
        return readBytes(file, at, at + 8).then(function (h) {
          var size = uint32LE(h, 4);
          if (fourcc(h, 0) !== 'EXIF') return chunkAt(at + 8 + size + (size & 1));
          if (at + 8 + size > end) return null;
          return readBytes(file, at + 8, at + 8 + size).then(function (data) {
            return tiffFrom(data, startsExif(data, 0) ? 6 : 0);
          });
        });
      }
      return chunkAt(12);
    });
  }

  // ISO-BMFF boxes between two offsets, by type (the first of each)
  function boxesIn(b, from, to) {
    var out = {};
    var at = from;
    while (at + 8 <= to) {
      var size = uintBE(b, at, 4);
      var head = 8;
      if (size === 1) { size = uintBE(b, at + 8, 8); head = 16; } else if (size === 0) size = to - at;
      if (size < head || at + size > to) break;
      var type = fourcc(b, at + 4);
      if (!out[type]) out[type] = { start: at + head, end: at + size };
      at += size;
    }
    return out;
  }
  // HEIC: the item typed 'Exif' in the meta box's iinf, found through iloc
  function exifItem(file, meta, head) {
    var kids = boxesIn(meta, head + 4, meta.length);
    var iinf = kids.iinf;
    var iloc = kids.iloc;
    if (!iinf || !iloc) return null;
    var id = -1;
    var p = iinf.start + 4 + (meta[iinf.start] === 0 ? 2 : 4);
    while (p + 8 <= iinf.end && id < 0) {
      var size = uintBE(meta, p, 4);
      if (size < 8 || p + size > iinf.end) break;
      var v = meta[p + 8];
      if (fourcc(meta, p + 4) === 'infe' && v >= 2) {
        var q = p + 12;
        var itemId = uintBE(meta, q, v === 2 ? 2 : 4);
        q += (v === 2 ? 2 : 4) + 2;
        if (q + 4 <= p + size && startsExif(meta, q, 4)) id = itemId;
      }
      p += size;
    }
    if (id < 0) return null;

    var lv = meta[iloc.start];
    if (lv > 2) return null;
    var at = iloc.start + 4;
    var offSize = meta[at] >> 4;
    var lenSize = meta[at] & 15;
    var baseSize = meta[at + 1] >> 4;
    var idxSize = lv > 0 ? meta[at + 1] & 15 : 0;
    if ([offSize, lenSize, baseSize, idxSize].some(function (k) { return k !== 0 && k !== 4 && k !== 8; })) return null;
    at += 2;
    var idBytes = lv < 2 ? 2 : 4;
    var count = uintBE(meta, at, idBytes);
    at += idBytes;
    var found = null;
    for (var n = 0; n < count && !found; n++) {
      var item = uintBE(meta, at, idBytes);
      at += idBytes;
      var method = 0;
      if (lv > 0) { method = uintBE(meta, at, 2) & 15; at += 2; }
      var dataRef = uintBE(meta, at, 2);
      var base = uintBE(meta, at + 2, baseSize);
      var extents = uintBE(meta, at + 2 + baseSize, 2);
      at += 4 + baseSize;
      var list = [];
      for (var e = 0; e < extents; e++) {
        at += idxSize;
        list.push([base + uintBE(meta, at, offSize), uintBE(meta, at + offSize, lenSize)]);
        at += offSize + lenSize;
      }
      if (item === id) found = { method: method, dataRef: dataRef, extents: list };
    }
    if (!found || found.dataRef !== 0 || !found.extents.length) return null;
    var total = 0;
    var bad = found.extents.some(function (x) { total += x[1]; return x[1] <= 0; });
    if (bad || total > 1048576) return null;

    var parts;
    if (found.method === 0) {
      parts = Promise.all(found.extents.map(function (x) {
        if (x[0] + x[1] > file.size) throw new Error('past the end');
        return readBytes(file, x[0], x[0] + x[1]);
      }));
    } else if (found.method === 1 && kids.idat) {
      parts = Promise.resolve(found.extents.map(function (x) {
        var from = kids.idat.start + x[0];
        if (from + x[1] > kids.idat.end) throw new Error('past the end');
        return meta.subarray(from, from + x[1]);
      }));
    } else {
      return null;
    }
    return parts.then(function (pieces) {
      var data = new Uint8Array(total);
      var off = 0;
      pieces.forEach(function (piece) { data.set(piece, off); off += piece.length; });
      // four bytes saying how far past them the TIFF header starts
      return tiffFrom(data, 4 + uintBE(data, 0, 4)) || (startsExif(data, 4) ? tiffFrom(data, 10) : null);
    });
  }
  function heicExif(file) {
    var hops = 0;
    function boxAt(at) {
      if (at + 8 > file.size || ++hops > 64) return null;
      return readBytes(file, at, at + 16).then(function (h) {
        var size = uintBE(h, 0, 4);
        var head = 8;
        if (size === 1) { size = uintBE(h, 8, 8); head = 16; } else if (size === 0) size = file.size - at;
        if (size < head) return null;
        if (fourcc(h, 4) !== 'meta') return boxAt(at + size);
        if (size > 4194304 || at + size > file.size) return null;
        return readBytes(file, at, at + size).then(function (meta) { return exifItem(file, meta, head); });
      });
    }
    return boxAt(0);
  }

  // Resolves the TIFF block (the EXIF without "Exif\0\0") of a WebP or
  // a HEIC, or null when there is none or it cannot be read.
  function exifOf(file) {
    return Promise.resolve().then(function () {
      return readBytes(file, 0, 12);
    }).then(function (head) {
      if (fourcc(head, 0) === 'RIFF' && fourcc(head, 8) === 'WEBP') return webpExif(file);
      if (fourcc(head, 4) === 'ftyp') return heicExif(file);
      return null;
    }).then(function (tiff) { return tiff || null; }, function () { return null; });
  }

  // a copy with Orientation (0x0112 in IFD0) set to 1, because the
  // canvas has already turned the picture upright
  function uprightExif(tiff) {
    var out = new Uint8Array(tiff);
    var le = out[0] === 0x49;
    function u16(at) {
      if (at + 2 > out.length) throw new Error('past the end');
      return le ? out[at] + out[at + 1] * 256 : out[at] * 256 + out[at + 1];
    }
    var ifd = le ? uint32LE(out, 4) : uintBE(out, 4, 4);
    var count = u16(ifd);
    if (ifd + 2 + count * 12 > out.length) throw new Error('past the end');
    for (var i = 0; i < count; i++) {
      var at = ifd + 2 + i * 12;
      if (u16(at) === 0x0112 && u16(at + 2) === 3) {
        out[at + 8] = le ? 1 : 0;
        out[at + 9] = le ? 0 : 1;
      }
    }
    return out;
  }
  // The TIFF block as an APP1 segment straight after the JPEG's SOI.
  // One segment holds 65533 bytes, "Exif\0\0" included.
  function withExif(jpeg, tiff) {
    if (!tiff || tiff.length + 8 > 65535) return Promise.resolve(jpeg);
    return readBytes(jpeg, 0, 2).then(function (soi) {
      if (soi[0] !== 0xFF || soi[1] !== 0xD8) return jpeg;
      var len = tiff.length + 8;
      var head = new Uint8Array([0xFF, 0xE1, len >> 8, len & 255].concat(EXIF_MAGIC));
      return new Blob([jpeg.slice(0, 2), head, tiff, jpeg.slice(2)], { type: 'image/jpeg' });
    });
  }

  function toJpeg(file) {
    if (!needsConverting(file)) return Promise.resolve(file);
    var exif = exifOf(file);
    return decodePicture(file).then(drawJpeg).then(function (jpeg) {
      // a metadata copy that fails sends the picture without it
      return exif.then(function (tiff) {
        return withExif(jpeg, tiff && uprightExif(tiff));
      }).then(null, function () { return jpeg; });
    }).then(function (blob) {
      var name = String(file.name || 'photo').replace(/\.[A-Za-z0-9]{1,5}$/, '') + '.jpg';
      return new File([blob], name, { type: 'image/jpeg', lastModified: file.lastModified || Date.now() });
    });
  }

  // ---- pictures that come back ----
  // A picture in a grid (scs.keepPicture) is asked for once it is within
  // a screen and a half of being seen, and on a long grid (letGo) let go
  // again beyond that, so the page holds a few screens of pictures. The
  // body is the scroller, so it is the observer's root: a margin on the
  // viewport does not reach past the body's own edge. One that fails is
  // hidden and asked for again after 1, 3, 8, 30 and 60 seconds, and every picture
  // near the screen that is not there is asked for afresh when the page
  // is looked at again, comes back from the back-forward cache or the
  // device comes back online: a phone that puts the browser away lets go
  // of pictures and fails the requests in flight.
  var PICTURE_RETRY = [1000, 3000, 8000, 30000, 60000];
  // several failing at once is the server turning requests away for a
  // minute, not a dropped connection: those wait longer, spread out
  var CROWD = 6;
  var CROWD_MS = 3000;
  var misses = [];
  function retryAfter(n) {
    var now = Date.now();
    misses = misses.filter(function (t) { return now - t < CROWD_MS; });
    misses.push(now);
    var crowd = misses.length >= CROWD;
    var wait = crowd ? Math.max(PICTURE_RETRY[n], PICTURE_RETRY[3]) : PICTURE_RETRY[n];
    return n || crowd ? wait * (0.75 + Math.random() * 0.5) : wait;
  }
  var keptPictures = [];
  var picturesNear = null;
  function pictureObserver() {
    if (picturesNear || !('IntersectionObserver' in window) || !document.body) return picturesNear;
    picturesNear = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { pictureNear(e.target, e.isIntersecting); });
    }, { root: document.body, rootMargin: '150% 0px' });
    return picturesNear;
  }
  function pictureNear(img, on) {
    if (!img.isConnected) {
      picturesNear.unobserve(img);
      var at = keptPictures.indexOf(img);
      if (at !== -1) keptPictures.splice(at, 1);
      return;
    }
    img.scsNear = on;
    if (on && !img.getAttribute('src')) askPicture(img, '');
    else if (!on && img.scsLetGo && img.getAttribute('src')) {
      window.clearTimeout(img.scsRetry);
      img.removeAttribute('src');
    }
  }
  function askPicture(img, again) {
    window.clearTimeout(img.scsRetry);
    var url = img.getAttribute('data-src');
    if (batchMade[url]) {
      img.src = batchMade[url];
      return;
    }
    if (img.scsBatch && !batchOff && batchPart(url)) {
      queueBatch(img, url);
      return;
    }
    var made = url.indexOf('blob:') === 0;
    img.src = again && !made ? url + (url.indexOf('?') === -1 ? '?' : '&') + 'again=' + again : url;
  }
  // opts.instead is asked on a failure before any retry: a promise of
  // another address, '' for none (the retries go on), or a rejection to
  // be asked again on the next failure
  function pictureMissed(img) {
    if (!img.getAttribute('src')) return;
    // a batched picture that will not draw is asked for on its own
    var shown = img.getAttribute('data-src');
    if (batchMade[shown] && img.getAttribute('src') === batchMade[shown]) {
      dropBatched(shown);
      img.scsBatch = false;
    }
    img.classList.add('is-missing');
    var instead = img.scsInstead;
    if (instead) {
      img.scsInstead = null;
      instead().then(function (url) {
        if (!url) return retryPicture(img);
        img.setAttribute('data-src', url);
        img.scsTries = 0;
        if (img.isConnected && img.scsNear !== false) askPicture(img, '');
      }, function () {
        img.scsInstead = instead;
        retryPicture(img);
      });
      return;
    }
    retryPicture(img);
  }
  function retryPicture(img) {
    var n = img.scsTries || 0;
    if (n >= PICTURE_RETRY.length) return;
    img.scsTries = n + 1;
    img.scsRetry = window.setTimeout(function () {
      if (img.isConnected && img.scsNear !== false) askPicture(img, String(img.scsTries));
    }, retryAfter(n));
  }
  // ---- thumbnails in batches ----
  // A grid's thumbnails (keepPicture's opts.batch) are asked for together
  // from /api/thumbs: the tiles near the screen go in one request, nearest
  // the middle of the screen first, two requests at most at once, so a
  // tile flung past before its turn is never asked for. Each picture is
  // kept for the page as a blob address, so a tile scrolled away and back
  // is drawn again with no request. A part the batch leaves out is asked
  // for on its own, and so is everything once the worker answers that it
  // has no such route.
  var BATCH_MAX = 24;
  var BATCH_WAIT = 60;
  var BATCH_OUT = 2;
  var BATCH_KEEP = 1000;
  var BATCH_RETRY = [3000, 10000, 30000, 60000, 60000];
  var batchMade = {};     // thumbnail address -> blob address
  var batchOrder = [];    // thumbnail addresses in the order kept
  var batchWaiting = {};  // thumbnail address -> imgs waiting for it
  var batchQueued = [];   // addresses waiting for a request
  var batchSending = {};  // addresses in a request now
  var batchTimer = 0;
  var batchesOut = 0;
  var batchOff = false;
  function batchPart(url) {
    var m = /^(.+)\/api\/(albums|submit)\/file\?key=([^&]+)(?:&v=([^&]+))?&thumb=1$/.exec(url);
    if (!m || (m[2] === 'submit' && m[4])) return null;
    return { origin: m[1], key: decodeURIComponent(m[3]), v: m[4] ? decodeURIComponent(m[4]) : '' };
  }
  function batchWanted(img, url) {
    return img.isConnected && img.scsNear !== false && img.getAttribute('data-src') === url &&
      img.getAttribute('src') !== batchMade[url];
  }
  function queueBatch(img, url) {
    var list = batchWaiting[url] || (batchWaiting[url] = []);
    if (list.indexOf(img) === -1) list.push(img);
    if (batchSending[url] || batchQueued.indexOf(url) !== -1) return;
    batchQueued.push(url);
    if (!batchTimer) batchTimer = window.setTimeout(flushBatch, BATCH_WAIT);
  }
  function stillWanted(url) {
    var list = (batchWaiting[url] || []).filter(function (img) { return batchWanted(img, url); });
    if (list.length) batchWaiting[url] = list;
    else delete batchWaiting[url];
    return list;
  }
  function flushBatch() {
    window.clearTimeout(batchTimer);
    batchTimer = 0;
    if (batchesOut >= BATCH_OUT) return;
    var middle = window.innerHeight / 2;
    var ranked = batchQueued.map(function (url) {
      var list = stillWanted(url);
      if (!list.length) return null;
      var r = list[0].getBoundingClientRect();
      return { url: url, away: Math.abs(r.top + r.height / 2 - middle) };
    }).filter(Boolean);
    ranked.sort(function (a, b) { return a.away - b.away; });
    batchQueued = ranked.map(function (x) { return x.url; });
    if (!batchQueued.length) return;
    // one origin a request
    var origin = batchPart(batchQueued[0]).origin;
    var take = [];
    batchQueued = batchQueued.filter(function (url) {
      if (take.length < BATCH_MAX && batchPart(url).origin === origin) { take.push(url); return false; }
      return true;
    });
    sendBatch(origin, take, 0);
    if (batchQueued.length) batchTimer = window.setTimeout(flushBatch, BATCH_WAIT);
  }
  function sendBatch(origin, urls, tries) {
    batchesOut += 1;
    urls.forEach(function (url) { batchSending[url] = true; });
    var q = urls.map(function (url) {
      var part = batchPart(url);
      return 'k=' + encodeURIComponent(part.key) + '&v=' + encodeURIComponent(part.v);
    }).join('&');
    var done = function () {
      batchesOut -= 1;
      urls.forEach(function (url) { delete batchSending[url]; });
      if (batchQueued.length && !batchTimer) batchTimer = window.setTimeout(flushBatch, BATCH_WAIT);
    };
    fetch(origin + '/api/thumbs?' + q + (tries ? '&again=' + tries : ''), { credentials: 'omit' }).then(function (res) {
      if (res.status === 404 || res.status === 400) {
        batchOff = true;
        throw new Error('no batches');
      }
      if (!res.ok) throw new Error('batch ' + res.status);
      return res.arrayBuffer();
    }).then(function (buf) {
      var parts = unpackBatch(buf);
      done();
      urls.forEach(function (url, i) {
        var part = parts[i];
        var list = batchWaiting[url] || [];
        delete batchWaiting[url];
        if (part && part.blob) {
          keepBatched(url, URL.createObjectURL(part.blob));
          list.forEach(function (img) { if (batchWanted(img, url)) img.src = batchMade[url]; });
        } else {
          list.forEach(function (img) {
            img.scsBatch = false;
            if (batchWanted(img, url)) askPicture(img, '');
          });
        }
      });
    }).catch(function () {
      done();
      var left = urls.filter(function (url) { return stillWanted(url).length; });
      if (!left.length) return;
      if (batchOff || tries >= BATCH_RETRY.length) {
        // on their own from here, with the usual retries
        left.forEach(function (url) {
          (batchWaiting[url] || []).forEach(function (img) {
            img.scsBatch = false;
            img.scsTries = 0;
            if (batchOff) askPicture(img, '');
            else retryPicture(img);
          });
          delete batchWaiting[url];
        });
        return;
      }
      // a refused or dropped batch: the same pictures again, later and spread out
      window.setTimeout(function () {
        var again = left.filter(function (url) { return stillWanted(url).length && !batchMade[url] && !batchSending[url]; });
        if (!again.length) return;
        if (batchesOut < BATCH_OUT) {
          sendBatch(origin, again, tries + 1);
        } else {
          again.forEach(function (url) {
            if (batchQueued.indexOf(url) === -1) batchQueued.push(url);
          });
          if (!batchTimer) batchTimer = window.setTimeout(flushBatch, BATCH_WAIT);
        }
      }, BATCH_RETRY[tries] * (0.75 + Math.random() * 0.5));
    });
  }
  // a four-byte length, that much JSON naming the parts, then their bytes
  function unpackBatch(buf) {
    var view = new DataView(buf);
    var headLength = view.getUint32(0);
    var head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headLength)));
    var at = 4 + headLength;
    return (head.parts || []).map(function (p) {
      if (p.missing || !p.size) return null;
      var blob = new Blob([new Uint8Array(buf, at, p.size)], { type: p.type });
      at += p.size;
      return { blob: blob };
    });
  }
  function keepBatched(url, blobUrl) {
    if (batchMade[url]) {
      URL.revokeObjectURL(batchMade[url]);
      var idx = batchOrder.indexOf(url);
      if (idx !== -1) batchOrder.splice(idx, 1);
    }
    batchMade[url] = blobUrl;
    batchOrder.push(url);
    if (batchOrder.length <= BATCH_KEEP) return;
    // the oldest let go first, leaving any a tile is showing
    var showing = {};
    keptPictures.forEach(function (img) { if (img.isConnected) showing[img.getAttribute('src')] = true; });
    var over = batchOrder.length - BATCH_KEEP;
    batchOrder = batchOrder.filter(function (u) {
      if (over <= 0 || showing[batchMade[u]]) return true;
      over -= 1;
      dropBatched(u, true);
      return false;
    });
  }
  function dropBatched(url, kept) {
    if (!batchMade[url]) return;
    URL.revokeObjectURL(batchMade[url]);
    delete batchMade[url];
    if (!kept) batchOrder = batchOrder.filter(function (u) { return u !== url; });
  }

  function askPicturesAgain() {
    if (document.hidden) return;
    // one that has left the page is let go of, once it has had a minute
    // to be put on it
    var now = Date.now();
    keptPictures = keptPictures.filter(function (img) { return img.isConnected || now - img.scsSince < 60000; });
    keptPictures.forEach(function (img) {
      if (!img.isConnected || img.scsNear === false) return;
      if (img.getAttribute('src') && img.complete && img.naturalWidth) return;
      img.scsTries = 0;
      askPicture(img, String(Date.now()));
    });
  }
  window.addEventListener('online', askPicturesAgain);
  document.addEventListener('visibilitychange', askPicturesAgain);
  window.addEventListener('pageshow', function (e) { if (e.persisted) askPicturesAgain(); });

  // A frame from a video, as the address of a small JPEG, for a video
  // with no still. A second in, or halfway through a shorter one; two at
  // a time, and each address once.
  var FRAME_EDGE = 480;
  var framesMade = {};
  var frameQueue = [];
  var framing = 0;
  function nextFrame() {
    while (framing < 2 && frameQueue.length) {
      framing += 1;
      var job = frameQueue.shift();
      grabFrame(job.url).then(job.resolve, job.reject).then(function () {
        framing -= 1;
        nextFrame();
      });
    }
  }
  function grabFrame(url) {
    return new Promise(function (resolve, reject) {
      var video = document.createElement('video');
      var settled = false;
      var drawing = false;
      var timer = window.setTimeout(function () { done(''); }, 20000);
      var nudge = 0;
      function done(out) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.clearTimeout(nudge);
        video.removeAttribute('src');
        try { video.load(); } catch (err) { /* already let go */ }
        if (out) resolve(out); else reject(new Error('no frame'));
      }
      video.crossOrigin = 'anonymous';
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.addEventListener('loadedmetadata', function () {
        try { video.currentTime = Math.min(1, (video.duration || 0.2) / 2); } catch (err) { done(''); }
        // a browser that will not seek a video nobody has played
        nudge = window.setTimeout(function () {
          var p = video.play();
          if (p && p.catch) p.catch(function () { /* the time limit ends it */ });
        }, 4000);
      });
      video.addEventListener('playing', function () { window.setTimeout(draw, 150); });
      video.addEventListener('seeked', draw);
      function draw() {
        if (settled || drawing) return;
        var w = video.videoWidth;
        var h = video.videoHeight;
        if (!w || !h) return done('');
        drawing = true;
        var scale = Math.min(1, FRAME_EDGE / Math.max(w, h));
        var canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        try {
          canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) {
            canvas.width = 0;
            canvas.height = 0;
            if (settled) return;
            done(blob ? URL.createObjectURL(blob) : '');
          }, 'image/jpeg', 0.8);
        } catch (err) {
          canvas.width = 0;
          canvas.height = 0;
          done('');
        }
      }
      video.addEventListener('error', function () { done(''); });
      video.src = url;
    });
  }
  function videoFrame(url) {
    if (!framesMade[url]) {
      framesMade[url] = new Promise(function (resolve, reject) {
        frameQueue.push({ url: url, resolve: resolve, reject: reject });
        nextFrame();
      });
      framesMade[url].then(null, function () { delete framesMade[url]; });
    }
    return framesMade[url];
  }

  window.scs = {
    TAB_API: TAB_API,
    fetch: fetchRetry,
    again: again,
    needScript: needScript,
    gotIt: gotIt,
    // HEIC and WebP redrawn as JPEG with their EXIF before an upload
    // (above); anything else resolves as it is
    needsConverting: needsConverting,
    toJpeg: toJpeg,
    exifOf: exifOf,
    pickedType: pickedType,
    fileUrl: function (key) { return TAB_API + '/api/submit/file?key=' + encodeURIComponent(key); },
    // A GIF has no thumbnail worth asking for: the only still a
    // browser can make of one is its first frame, so a grid that asked
    // for a small copy got a picture that does not move. Pass the type
    // and a GIF is asked for whole. The worker refuses to serve a
    // still for one either, but a caller that knows the type should
    // not be making the request in the first place.
    animatedType: function (type) {
      return String(type || '').toLowerCase().split(';')[0].trim() === 'image/gif';
    },
    // A picture that comes back (above): img gets url once it nears the
    // screen. opts.letGo lets it go again far from the screen, for a long
    // grid; opts.near false asks for it at once and leaves when to the
    // browser's lazy loading, for one inside a scroller of its own, which
    // the body's observer cannot see into. opts.batch asks for an album or
    // proof thumbnail with others in one request and keeps it for the
    // page (thumbnails in batches, above). opts.instead: see pictureMissed.
    keepPicture: function (img, url, opts) {
      opts = opts || {};
      img.setAttribute('data-src', url);
      img.scsLetGo = !!opts.letGo;
      img.scsBatch = !!opts.batch;
      img.scsInstead = opts.instead || null;
      if (!img.scsKept) {
        img.scsKept = true;
        img.addEventListener('load', function () {
          img.scsTries = 0;
          img.classList.remove('is-missing');
        });
        img.addEventListener('error', function () { pictureMissed(img); });
        img.scsSince = Date.now();
        keptPictures.push(img);
      }
      var io = opts.near === false ? null : pictureObserver();
      if (io) io.observe(img);
      else {
        img.loading = 'lazy';
        askPicture(img, '');
      }
      return img;
    },
    videoFrame: videoFrame,
    thumbUrl: function (key, type) {
      return TAB_API + '/api/submit/file?key=' + encodeURIComponent(key) +
        (window.scs.animatedType(type) ? '' : '&thumb=1');
    },
    // same as the worker: case and spaces do not matter, hyphens do
    normQuest: function (text) { return String(text).toUpperCase().replace(/\s+/g, ''); },

    // ---- quest search ----
    // One matcher for every place a quest is looked up by typing: the
    // quest list's filter, the map's search panel and the submit page's
    // picker. A code matches anywhere inside it ("18" finds SQ18,
    // SQ18-1 and SQ118, with or without the letters), and text matches
    // loosely: a substring, a word that starts the way the query does,
    // a word one or two letters off, or the query's letters in order
    // inside a word. Higher scores are better matches; 0 is no match.
    textScore: function (query, text) {
      var q = String(query || '').trim().toLowerCase();
      var t = String(text || '').toLowerCase();
      if (!q || !t) return 0;
      var at = t.indexOf(q);
      if (at !== -1) return (at === 0 || /[^a-z0-9]/.test(t.charAt(at - 1))) ? 180 : 150;
      var words = t.split(/[^a-z0-9]+/).filter(Boolean);
      var parts = q.split(/[^a-z0-9]+/).filter(Boolean);
      if (!parts.length || !words.length) return 0;
      var total = 0;
      var skipped = 0;
      for (var i = 0; i < parts.length; i++) {
        var best = 0;
        for (var j = 0; j < words.length && best < 120; j++) {
          var s = wordScore(parts[i], words[j]);
          if (s > best) best = s;
        }
        // a filler word typed beside one that matched is passed over
        if (!best && parts.length > 1 && SEARCH_FILLER.indexOf(parts[i]) !== -1) { skipped += 1; continue; }
        if (!best) return 0; // every word typed has to land somewhere
        total += best;
      }
      if (skipped === parts.length) return 0;
      return Math.round(total / (parts.length - skipped));


      function wordScore(p, w) {
        if (w.indexOf(p) === 0) return 120;
        if (w.indexOf(p) !== -1) return 100;
        if (p.length >= 4) {
          // two letters typed the wrong way round
          for (var k = 0; k + 1 < p.length; k++) {
            if (w.indexOf(p.slice(0, k) + p.charAt(k + 1) + p.charAt(k) + p.slice(k + 2)) === 0) return 95;
          }
          var allow = p.length >= 7 ? 2 : 1;
          if (editDistance(p, w.slice(0, p.length), allow) <= allow) return 95; // a typo at the start of a word
          if (editDistance(p, w, allow) <= allow) return 90;
        }
        if (p.length >= 3 && subsequence(p, w)) return 60;
        return 0;
      }
      function subsequence(p, w) {
        var k = 0;
        for (var i = 0; i < w.length && k < p.length; i++) if (w.charAt(i) === p.charAt(k)) k++;
        return k === p.length;
      }
      // Levenshtein with an early exit once the cap is passed
      function editDistance(a, b, cap) {
        if (Math.abs(a.length - b.length) > cap) return cap + 1;
        var prev = [];
        for (var j = 0; j <= b.length; j++) prev.push(j);
        for (var i = 1; i <= a.length; i++) {
          var cur = [i];
          var low = cap + 1;
          for (var jj = 1; jj <= b.length; jj++) {
            var cost = a.charAt(i - 1) === b.charAt(jj - 1) ? 0 : 1;
            var v = Math.min(prev[jj] + 1, cur[jj - 1] + 1, prev[jj - 1] + cost);
            cur.push(v);
            if (v < low) low = v;
          }
          if (low > cap) return cap + 1;
          prev = cur;
        }
        return prev[b.length];
      }
    },
    // a quest {id, name, codes: [{code} | 'CODE']} against a typed
    // query; extra is more text (description, place, region) that
    // counts for less and only as plain words
    questScore: function (quest, query, extra) {
      var q = String(query || '').trim();
      if (!q) return 1;
      var nq = window.scs.normQuest(q);
      var best = 0;
      var codes = [quest.id].concat(quest.codes || []);
      for (var i = 0; i < codes.length; i++) {
        var c = codes[i] && codes[i].code !== undefined ? codes[i].code : codes[i];
        if (!c) continue;
        var n = window.scs.normQuest(c);
        var s = n === nq ? 300 : n.indexOf(nq) === 0 ? 250 : n.indexOf(nq) !== -1 ? 200 : 0;
        if (s > best) best = s;
      }
      // a number alone is a code lookup: it must not find every
      // description with that number in it
      if (/^[0-9-]+$/.test(nq)) return best;
      var name = window.scs.textScore(q, quest.name);
      if (name > best) best = name;
      // its search tags count nearly as its name does
      if (quest.keywords && quest.keywords.length) {
        var tagged = Math.round(window.scs.textScore(q, quest.keywords.join(' ')) * 0.9);
        if (tagged > best) best = tagged;
      }
      if (extra) {
        var more = Math.round(window.scs.textScore(q, extra) * 0.5);
        if (more > best) best = more;
      }
      return best;
    },
    // the matching quests, best first, ties in the order given
    questSearch: function (quests, query, extraOf) {
      var q = String(query || '').trim();
      if (!q) return quests.slice();
      var scored = [];
      for (var i = 0; i < quests.length; i++) {
        var s = window.scs.questScore(quests[i], q, extraOf ? extraOf(quests[i]) : '');
        if (s > 0) scored.push({ q: quests[i], s: s, i: i });
      }
      scored.sort(function (a, b) { return b.s - a.s || a.i - b.i; });
      return scored.map(function (x) { return x.q; });
    },
    // The one quest list: {regions, groups, places, more} from the tab
    // worker, the signed-in team's when there is one. The copy in
    // localStorage answers first, so the page never blanks; the
    // network copy is fetched behind it and kept as the copy for next
    // time. With no copy yet, or only one made for somebody else, the
    // network is waited for. Resolves the same promise per visit;
    // `{fresh: true}` asks again, which is what signing in does.
    questList: function (opts) {
      if (opts && opts.fresh) questListPromise = null;
      if (questListPromise) return questListPromise;
      var cached = null;
      try { cached = JSON.parse(localStorage.getItem(QUESTLIST_CACHE) || 'null'); } catch (err) { cached = null; }
      if (cached && !cached.groups) cached = null;
      if (cached && (cached.seenBy || '') !== sessionMark(teamSession())) cached = null;
      if (opts && opts.fresh) cached = null;
      // Kept as the copy this device reads from next time. Nothing is
      // announced from here: the worker's edge cache is per colo, so an
      // answer from a colo that has not caught up looks like a change
      // and would start the "new quests" banner over and over. The
      // quest page compares the pulse version instead.
      if (cached) {
        questListPromise = Promise.resolve(cached);
        // asked again only when the pulse has moved off the copy
        pulseOnce().then(function (pulse) {
          var now = pulse && typeof pulse.quests === 'number' ? pulse.quests : undefined;
          if (now !== undefined && listCurrent(cached, now)) return null;
          return fetchQuestList(now);
        }).catch(function () { /* offline: the copy stands */ });
      } else {
        questListPromise = fetchQuestList().catch(function (err) { questListPromise = null; throw err; });
      }
      return questListPromise;
    },
    // The list straight from the worker, stored as this device's copy:
    // what the quest page's update banner takes before it reloads.
    fetchQuestList: function (version) {
      return fetchQuestList(version);
    },
    // Kept so an older cached page that registers a listener still
    // runs; nothing calls them any more.

    // {quests, messages, urgent} from the worker, or null when it
    // cannot be reached. One fetch per visit, shared by every asker;
    // `fresh` asks again, for a page left open that has to see a change.
    pulse: function (fresh) {
      if (fresh) site.pulsePromise = fetchPulse();
      return pulseOnce();
    },
    // The team signed in on this device (the submit page's sign-in, which
    // the gallery and the albums share): its session, and the one way to
    // set or clear it.
    teamSession: teamSession,
    setTeamSession: function (token, team) {
      try {
        if (token) {
          localStorage.setItem('scs2-submit-session', token);
          localStorage.setItem('scs2-submit-team', team || '');
        } else {
          localStorage.removeItem('scs2-submit-session');
          localStorage.removeItem('scs2-submit-team');
        }
      } catch (err) { /* not persisted */ }
      // the menu's link says Sign In or Submit a Quest by this
      document.dispatchEvent(new CustomEvent('scs-session-changed'));
    },
    // A read with a public copy and a signed-in team's own, and whose
    // copy this device would be shown now: what a page keeps beside the
    // copy it stores, so it never paints one team's for another.
    readAs: readAs,
    reader: function () { return sessionMark(teamSession()); },
    // The version this device has already taken, or null when it has
    // taken none yet.
    seen: function (key) {
      var raw = null;
      try { raw = localStorage.getItem(key); } catch (err) { return null; }
      if (raw === null || raw === '') return null;
      var n = parseInt(raw, 10);
      return isFinite(n) ? n : null;
    },
    // Written as given, lower or higher: a counter set back is followed.
    markSeen: function (key, value) {
      var was = window.scs.seen(key);
      if (typeof value !== 'number' || !isFinite(value)) return was;
      var next = Math.floor(value);
      try { localStorage.setItem(key, String(next)); } catch (err) { return was; }
      return next;
    },
    // A set of numbers this device has seen (message seqs, urgent ids),
    // oldest first, or null when nothing is stored yet.
    seenSet: function (key) {
      var list = null;
      try { list = JSON.parse(localStorage.getItem(key) || 'null'); } catch (err) { return null; }
      if (!Array.isArray(list)) return null;
      return list.filter(function (n) { return typeof n === 'number' && isFinite(n); });
    },
    // Adds to the set, keeping the newest `cap`, and returns it.
    addSeen: function (key, values, cap) {
      var list = window.scs.seenSet(key) || [];
      (values || []).forEach(function (v) {
        if (typeof v !== 'number' || !isFinite(v)) return;
        var n = Math.floor(v);
        var at = list.indexOf(n);
        if (at !== -1) list.splice(at, 1);
        list.push(n);
      });
      if (cap && list.length > cap) list = list.slice(list.length - cap);
      try { localStorage.setItem(key, JSON.stringify(list)); } catch (err) { /* not kept */ }
      return list;
    },
    // The messages a page drew, by seq: read on this device.
    readMessages: function (seqs) {
      if (site.lastPulse) msgRead(pulseSeqs(site.lastPulse));
      window.scs.addSeen(MSG_READ_KEY, (seqs || []).filter(function (s) { return s > 0; }), MSG_READ_CAP);
      window.scs.syncBell();
    },
    // The dot on the nav bell: on while the pulse names a message this
    // device has not read. The app icon's badge counts the same
    // messages. Returns whether the dot is showing.
    syncBell: function () {
      var dot = document.querySelector('.bell-dot');
      var pulse = site.lastPulse;
      if (!pulse || (typeof pulse.messages !== 'number' && !Array.isArray(pulse.message_seqs))) {
        if (dot) dot.hidden = true;
        return false;
      }
      var seqs = pulseSeqs(pulse);
      var read = msgRead(seqs);
      var waiting = seqs.filter(function (s) { return read.indexOf(s) === -1; }).length;
      if (dot) dot.hidden = waiting === 0;
      setAppBadge(waiting);
      return waiting > 0;
    },
    // Everything the site knows about push notifications, in one
    // place: the settings rocker and the messages page both drive it.
    // Permission has to be asked for inside the tap itself (iOS
    // refuses otherwise), so enable() is called from a change handler.
    pushSub: {
      supported: function () {
        return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
      },
      // A first guess at what this device is, sent with the
      // subscription. All the worker otherwise holds is an opaque
      // endpoint, so without this the dashboard's device list cannot
      // tell two phones on the same team apart. It is only a guess:
      // organisers rename devices from the dashboard, and a rename is
      // never written over.
      label: function () {
        var ua = navigator.userAgent || '';
        var device = 'Device';
        if (/iPad/.test(ua)) device = 'iPad';
        else if (/iPhone|iPod/.test(ua)) device = 'iPhone';
        else if (/Android/.test(ua)) device = 'Android';
        else if (/Macintosh|Mac OS X/.test(ua)) device = 'Mac';
        else if (/Windows/.test(ua)) device = 'Windows';
        else if (/Linux|CrOS/.test(ua)) device = 'Linux';
        // order matters: Edge says Chrome and Safari, Chrome says Safari
        var browser = '';
        if (/Edg[A-Z]?\//.test(ua)) browser = 'Edge';
        else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
        else if (/Firefox\/|FxiOS/.test(ua)) browser = 'Firefox';
        else if (/CriOS|Chrome\//.test(ua)) browser = 'Chrome';
        else if (/Safari\//.test(ua)) browser = 'Safari';
        // on iOS notifications only work in the installed app, so
        // saying so is worth more than naming the browser
        if (document.documentElement.classList.contains('is-installed')) return device + ' app';
        return browser ? device + ' ' + browser : device;
      },
      // 'on', 'off', 'denied' or 'unsupported'
      state: function () {
        if (!window.scs.pushSub.supported()) return Promise.resolve('unsupported');
        if (Notification.permission === 'denied') return Promise.resolve('denied');
        return navigator.serviceWorker.ready
          .then(function (reg) { return reg.pushManager.getSubscription(); })
          .then(function (sub) { return sub ? 'on' : 'off'; })
          .catch(function () { return 'off'; });
      },
      // a change still going, from either switch
      busy: function () { return pushRuns > 0; },
      enable: function () {
        if (!window.scs.pushSub.supported()) return Promise.reject(new Error('unsupported'));
        return pushRun(Notification.requestPermission().then(function (perm) {
          if (perm !== 'granted') throw new Error('denied');
          return fetch(TAB_API + '/api/push/vapid').then(function (r) { return r.json(); });
        }).then(function (data) {
          if (!data || !data.key) throw new Error('no key');
          return navigator.serviceWorker.ready.then(function (reg) {
            return reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToKey(data.key) });
          });
        }).then(function (sub) {
          var body = sub.toJSON();
          body.label = window.scs.pushSub.label();
          return window.scs.postJson(TAB_API + '/api/push/subscribe', body).then(function (res) {
            if (res.status !== 200) throw new Error('store failed');
            return true;
          });
        }));
      },
      disable: function () {
        if (!window.scs.pushSub.supported()) return Promise.resolve(null);
        return pushRun(navigator.serviceWorker.ready.then(function (reg) {
          return reg.pushManager.getSubscription();
        }).then(function (sub) {
          if (!sub) return null;
          var endpoint = sub.endpoint;
          return sub.unsubscribe().then(function () {
            return window.scs.postJson(TAB_API + '/api/push/unsubscribe', { endpoint: endpoint })
              .catch(function () { /* the dead endpoint gets pruned on the next send anyway */ });
          });
        }));
      },
      // A team signing out of this device: its verdicts stop reaching
      // it. The subscription stays, so announcements still do.
      unlink: function () {
        if (!window.scs.pushSub.supported()) return Promise.resolve(null);
        return navigator.serviceWorker.getRegistration().then(function (reg) {
          return reg ? reg.pushManager.getSubscription() : null;
        }).then(function (sub) {
          if (!sub) return null;
          return window.scs.postJson(TAB_API + '/api/push/unlink', { endpoint: sub.endpoint });
        }).catch(function () { return null; });
      },
      // Which phone the hints are about: iOS only offers push to the
      // installed app, and Android only in a browser that has it.
      platform: function () {
        var ua = navigator.userAgent || '';
        if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
        if (/Android/.test(ua)) return 'android';
        return 'other';
      },
      // one wording for a state, so every switch says the same thing;
      // [share] and [add] are where paint() draws Safari's two icons
      hint: function (state) {
        if (state === 'unsupported') {
          var p = window.scs.pushSub.platform();
          if (p === 'ios') {
            return 'On iPhone notifications can only be enabled on the installed app. Install the app by tapping ' +
              'Share [share] and Add to Home Screen [add], then return to enable.';
          }
          if (p === 'android') {
            return 'On Android notifications need a browser that supports them, such as Chrome. Open the website in ' +
              'Chrome, then install the app from the menu and tap Install app. Then return to enable.';
          }
          return 'This browser does not support notifications.';
        }
        if (state === 'denied') return 'Notifications are blocked for this site in your browser settings.';
        if (state === 'on') return 'Announcements reach this device.';
        return '';
      },
      // Puts a hint into a line, drawing Safari's icons where the iPhone
      // hint names them: [share] the Share button, [add] the square with
      // a plus on the Add to Home Screen row. The words are already
      // there, so the icons are hidden from screen readers.
      paint: function (el, text) {
        if (!el) return;
        var glyphs = {
          share: '<path d="M8 9H5v12h14V9h-3"/><path d="M12 15V3"/><path d="M8 7l4-4 4 4"/>',
          add: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8v8"/><path d="M8 12h8"/>'
        };
        el.textContent = '';
        // the capture keeps each icon's name in the list, between the words
        String(text || '').split(/\[(share|add)\]/).forEach(function (bit, i) {
          if (i % 2) {
            var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('class', 'share-glyph');
            svg.setAttribute('viewBox', '0 0 24 24');
            svg.setAttribute('aria-hidden', 'true');
            svg.innerHTML = glyphs[bit];
            el.appendChild(svg);
          } else {
            el.appendChild(document.createTextNode(bit));
          }
        });
      }
    },
    // an hour stamp ("2026-10-20 03:00", UTC) as the device's local
    // hour: "1 pm", or with withMinutes "1:15 pm"; one the worker sent
    // without its date ("14:00") is on the event's clock already and is
    // printed as it is
    fmtHour: function (utc, withMinutes) {
      var t = String(utc || '');
      var d = stampDate(t);
      if (!d) return t;
      if (window.scs.hour24()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      return d.toLocaleTimeString(undefined, withMinutes ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' });
    },
    // A figure: parts is [number, words, number, words, ...]; the first
    // number is set large and the words under it, any number among the
    // words a size down (the recap, the team and quest pages)
    figure: function (parts) {
      var fmtN = function (n) { return (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }); };
      var li = document.createElement('li');
      li.className = 'figure';
      var big = document.createElement('span');
      big.className = 'figure-n';
      big.textContent = fmtN(parts[0]);
      li.appendChild(big);
      var words = document.createElement('span');
      words.className = 'figure-words';
      // a number keeps the word after it on its line
      var afterNumber = false;
      parts.slice(1).forEach(function (p) {
        if (typeof p === 'number') {
          var b = document.createElement('b');
          b.textContent = fmtN(p);
          words.appendChild(b);
          afterNumber = true;
        } else {
          words.appendChild(document.createTextNode(afterNumber ? p.replace(/^ /, '\u00a0') : p));
          afterNumber = false;
        }
      });
      li.appendChild(words);
      return li;
    },
    // A name and its value as a row of a dl.facts
    fact: function (list, name, value) {
      if (!value) return;
      var dt = document.createElement('dt');
      dt.textContent = name;
      var dd = document.createElement('dd');
      dd.textContent = value;
      list.appendChild(dt);
      list.appendChild(dd);
    },
    // A bar per step of time: rows are [{hour, <key>, <inner key>}], each
    // row's stamp the start of its step (UTC, or a bare HH:MM the worker
    // took the date off); opts.step is the minutes a row covers (60 by
    // default) and opts.line draws the two counts as lines rather than
    // bars, for a chart with too many rows for bars. The tallest value
    // fills the box. Labels sit on the clock (on the hour, the half
    // hour...) as often as there is room for them. Plain elements, no
    // library.
    hourBars: function (container, rows, opts) {
      opts = opts || {};
      var key = opts.key || 'sent';
      var inner = opts.inner || '';
      var step = opts.step || 60;
      var line = !!opts.line;
      container.textContent = '';
      if (!rows || !rows.length) {
        var none = document.createElement('p');
        none.className = 'hour-bars-none';
        none.textContent = opts.empty || 'Nothing to show yet.';
        container.appendChild(none);
        return;
      }
      var scs = window.scs;
      var max = 0;
      rows.forEach(function (r) { if (Number(r[key]) > max) max = Number(r[key]); });
      // a step's time: the hour alone for hours, with its minutes otherwise
      var timeOf = function (r, minutes) { return scs.fmtHour(r.hour, minutes == null ? step < 60 : minutes); };
      var says = function (r) {
        return (Number(r[key]) || 0) + ' ' + key + (inner ? ', ' + (Number(r[inner]) || 0) + ' ' + inner : '');
      };
      var chart = document.createElement('div');
      chart.className = 'hour-bars' + (line ? ' is-line' : rows.length > 36 ? ' is-dense' : '');
      var ticks = [];
      if (line) {
        // each count a line with its area filled under it, across a box
        // the chart's size; the strokes keep their width however the box
        // is stretched
        var n = rows.length;
        var top = max || 1;
        var xAt = function (i) { return n > 1 ? i / (n - 1) * 1000 : 500; };
        var path = function (k) {
          return rows.map(function (r, i) {
            return (i ? 'L' : 'M') + xAt(i).toFixed(1) + ' ' + (100 - (Number(r[k]) || 0) / top * 100).toFixed(2);
          }).join('');
        };
        var svgNs = 'http://www.w3.org/2000/svg';
        var svg = document.createElementNS(svgNs, 'svg');
        svg.setAttribute('class', 'hour-line');
        svg.setAttribute('viewBox', '0 0 1000 100');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', timeOf(rows[0]) + ' to ' + timeOf(rows[n - 1]) + ', at most ' + max + ' ' + key + ' in a minute');
        [[key, 'hour-line-outer'], [inner, 'hour-line-inner']].forEach(function (p) {
          if (!p[0]) return;
          var d = path(p[0]);
          var area = document.createElementNS(svgNs, 'path');
          area.setAttribute('class', p[1] + ' hour-area');
          area.setAttribute('d', d + 'L' + xAt(n - 1).toFixed(1) + ' 100L' + xAt(0).toFixed(1) + ' 100Z');
          svg.appendChild(area);
          var stroke = document.createElementNS(svgNs, 'path');
          stroke.setAttribute('class', p[1]);
          stroke.setAttribute('d', d);
          svg.appendChild(stroke);
        });
        chart.appendChild(svg);
        // the minute picked: a rule down the chart and a dot on each line
        var guide = document.createElement('div');
        guide.className = 'hour-guide';
        guide.hidden = true;
        var dots = [key, inner].filter(Boolean).map(function (k, j) {
          var dot = document.createElement('span');
          dot.className = 'hour-dot' + (j ? ' is-inner' : '');
          guide.appendChild(dot);
          return { key: k, node: dot };
        });
        chart.appendChild(guide);
        rows.forEach(function (r, i) {
          var tick = document.createElement('span');
          tick.className = 'hour-tick';
          tick.style.left = (n > 1 ? i / (n - 1) * 100 : 50) + '%';
          ticks.push(tick);
        });
      } else {
        rows.forEach(function (r) {
          var col = document.createElement('div');
          col.className = 'hour-col';
          var bar = document.createElement('div');
          bar.className = 'hour-bar';
          var v = Number(r[key]) || 0;
          bar.style.height = (max ? Math.max(v ? 2 : 0, Math.round(v / max * 100)) : 0) + '%';
          if (inner) {
            var part = document.createElement('div');
            part.className = 'hour-bar-inner';
            part.style.height = (v ? Math.round((Number(r[inner]) || 0) / v * 100) : 0) + '%';
            bar.appendChild(part);
          }
          col.setAttribute('aria-label', timeOf(r) + ': ' + says(r));
          col.appendChild(bar);
          var tick = document.createElement('span');
          tick.className = 'hour-tick';
          col.appendChild(tick);
          ticks.push(tick);
          chart.appendChild(col);
        });
      }
      container.appendChild(chart);

      // Labels on the clock: every I minutes for the smallest I (a whole
      // number of steps) whose spacing clears the widest label, measured
      // once the chart is on screen; drawn hidden, it goes by the count.
      // A label on the hour is the hour alone.
      var clock = rows.map(function (r) {
        var d = stampDate(String(r.hour || ''));
        return d ? d.getHours() * 60 + d.getMinutes() : -1;
      });
      var gaps = [1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 480, 720, 1440].filter(function (g) { return g >= step && g % step === 0; });
      var pitch = chart.clientWidth / (line ? Math.max(1, rows.length - 1) : rows.length);
      var every = gaps[gaps.length - 1];
      if (pitch > 0) {
        var widest = function (minutes) {
          var wrap = document.createElement('div');
          wrap.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;left:0;top:0;white-space:nowrap';
          var seen = {};
          var spans = [];
          for (var i = 0; i < rows.length && i < 200; i++) {
            var label = timeOf(rows[i], minutes);
            if (seen[label]) continue;
            seen[label] = true;
            var s = document.createElement('span');
            s.className = 'hour-tick';
            s.textContent = label;
            wrap.appendChild(s);
            spans.push(s);
          }
          chart.appendChild(wrap);
          var w = 0;
          for (var k = 0; k < spans.length; k++) w = Math.max(w, spans[k].offsetWidth);
          chart.removeChild(wrap);
          return w;
        };
        var wide = { hour: widest(false), minute: step < 60 ? widest(true) : 0 };
        for (var g = 0; g < gaps.length; g++) {
          var w = gaps[g] % 60 === 0 ? wide.hour : wide.minute;
          if (gaps[g] / step * pitch >= w + 10) { every = gaps[g]; break; }
        }
      } else {
        var count = rows.length > 36 ? 6 : rows.length > 18 ? 3 : rows.length > 9 ? 2 : 1;
        for (var c = 0; c < gaps.length; c++) { if (gaps[c] >= count * step) { every = gaps[c]; break; } }
      }
      var labelled = 0;
      ticks.forEach(function (tick, i) {
        if (clock[i] < 0 || clock[i] % every !== 0) return;
        tick.textContent = timeOf(rows[i], every % 60 !== 0);
        labelled++;
      });
      if (!labelled) ticks[0].textContent = timeOf(rows[0]);
      if (line) ticks.forEach(function (tick) { if (tick.textContent) chart.appendChild(tick); });
      // a label at either end stays inside the chart's width, and one
      // that then runs into the label before it goes
      var box = chart.getBoundingClientRect();
      if (box.width) {
        var activeTicks = ticks.filter(function (tick) { return !!tick.textContent; });
        var rects = activeTicks.map(function (tick) { return tick.getBoundingClientRect(); });
        var last = null;
        activeTicks.forEach(function (tick, idx) {
          var t = rects[idx];
          var shift = t.left < box.left ? box.left - t.left : t.right > box.right ? box.right - t.right : 0;
          if (shift) tick.style.marginLeft = shift + 'px';
          var left = t.left + shift;
          if (last !== null && left < last + 6) { tick.textContent = ''; return; }
          last = t.right + shift;
        });
      }

      // A step's time and figures over the chart: the step under a mouse,
      // or the one a finger taps or runs along, kept until a tap elsewhere
      var tip = document.createElement('div');
      tip.className = 'hour-tip';
      tip.hidden = true;
      tip.setAttribute('aria-hidden', 'true');
      chart.appendChild(tip);
      var cols = chart.querySelectorAll('.hour-col');
      var picked = -1;
      var held = false;
      function pick(i) {
        if (i === picked) return;
        if (picked >= 0 && cols[picked]) cols[picked].classList.remove('is-picked');
        picked = i;
        chart.classList.toggle('has-pick', i >= 0);
        if (i < 0) {
          tip.hidden = true;
          if (guide) guide.hidden = true;
          return;
        }
        var r = rows[i];
        var mid;
        if (line) {
          mid = rows.length > 1 ? i / (rows.length - 1) * chart.clientWidth : chart.clientWidth / 2;
          guide.style.left = mid + 'px';
          dots.forEach(function (dot) { dot.node.style.bottom = ((Number(r[dot.key]) || 0) / (max || 1) * 100) + '%'; });
          guide.hidden = false;
        } else {
          cols[i].classList.add('is-picked');
          mid = cols[i].offsetLeft + cols[i].offsetWidth / 2;
        }
        tip.textContent = '';
        var head = document.createElement('strong');
        head.textContent = timeOf(r);
        tip.appendChild(head);
        tip.appendChild(document.createTextNode(says(r)));
        tip.hidden = false;
        tip.style.left = Math.max(0, Math.min(chart.clientWidth - tip.offsetWidth, mid - tip.offsetWidth / 2)) + 'px';
      }
      function colAt(x) {
        var box = chart.getBoundingClientRect();
        if (!box.width) return -1;
        var i = line
          ? Math.round((x - box.left) / box.width * (rows.length - 1))
          : Math.floor((x - box.left) / box.width * rows.length);
        return Math.max(0, Math.min(rows.length - 1, i));
      }
      chart.addEventListener('pointermove', function (e) {
        if (e.pointerType === 'mouse' || held) pick(colAt(e.clientX));
      });
      chart.addEventListener('pointerleave', function (e) {
        if (e.pointerType === 'mouse') pick(-1);
      });
      chart.addEventListener('pointerdown', function (e) {
        if (e.pointerType === 'mouse') return;
        held = true;
        pick(colAt(e.clientX));
      });
      chart.addEventListener('pointerup', function () { held = false; });
      chart.addEventListener('pointercancel', function () { held = false; });
      function away(e) {
        if (!chart.isConnected) { document.removeEventListener('pointerdown', away, true); return; }
        if (!chart.contains(e.target)) pick(-1);
      }
      document.addEventListener('pointerdown', away, true);
    },
    // The steps a submissions chart is drawn at, with the answer's rows
    // and busiest step for each (the recap and the team page)
    CHART_STEPS: {
      '60': { name: 'Hour', rows: 'by_hour', busiest: 'busiest_hour' },
      '30': { name: 'Half Hour', rows: 'by_half', busiest: 'busiest_half' },
      '15': { name: 'Quarter', rows: 'by_quarter', busiest: 'busiest_quarter' },
      '1': { name: 'Minute', rows: 'by_minute', busiest: 'busiest_minute' }
    },
    // A chart's step picked in its heading (.chart-step): the word opens
    // a list of the four under it, its chevron turning over while the
    // list is open. The pick is kept under storeKey and handed to onPick;
    // answers {step()}.
    chartStep: function (box, storeKey, onPick) {
      var scs = window.scs;
      var STEPS = scs.CHART_STEPS;
      var step = '60';
      try { if (STEPS[localStorage.getItem(storeKey)]) step = localStorage.getItem(storeKey); } catch (err) { /* hour */ }
      var btn = box.querySelector('.chart-step-btn');
      var text = box.querySelector('.chart-step-text');
      var menu = box.querySelector('.chart-step-menu');
      var opts = [].slice.call(menu.querySelectorAll('[role="option"]'));
      var closing = 0;
      function mark() {
        text.textContent = STEPS[step].name;
        opts.forEach(function (o) { o.setAttribute('aria-selected', String(o.getAttribute('data-step') === step)); });
      }
      function shut() { return menu.hidden || menu.classList.contains('is-closing'); }
      function open() {
        window.clearTimeout(closing);
        menu.classList.remove('is-closing');
        menu.hidden = false;
        box.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
        var on = opts.filter(function (o) { return o.getAttribute('aria-selected') === 'true'; })[0] || opts[0];
        on.focus();
      }
      function close(refocus) {
        if (shut()) return;
        box.classList.remove('is-open');
        btn.setAttribute('aria-expanded', 'false');
        menu.classList.add('is-closing');
        closing = window.setTimeout(function () {
          menu.hidden = true;
          menu.classList.remove('is-closing');
        }, scs.reducedMotion ? 0 : scs.ms('--dropdown-close-dur', 150));
        if (refocus) btn.focus();
      }
      function pick(o) {
        var next = o.getAttribute('data-step');
        close(true);
        if (!STEPS[next] || next === step) return;
        step = next;
        mark();
        try { localStorage.setItem(storeKey, step); } catch (err) { /* not kept */ }
        if (onPick) onPick(step);
      }
      btn.addEventListener('click', function () {
        if (shut()) open(); else close(true);
      });
      btn.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
      });
      menu.addEventListener('click', function (e) {
        var o = e.target.closest && e.target.closest('[role="option"]');
        if (o) pick(o);
      });
      menu.addEventListener('keydown', function (e) {
        var at = opts.indexOf(document.activeElement);
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          opts[(at + (e.key === 'ArrowDown' ? 1 : opts.length - 1)) % opts.length].focus();
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault();
          opts[e.key === 'Home' ? 0 : opts.length - 1].focus();
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (at >= 0) pick(opts[at]);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          close(true);
        } else if (e.key === 'Tab') {
          close(false);
        }
      });
      function awayStep(e) {
        if (!box.isConnected) { document.removeEventListener('pointerdown', awayStep); return; }
        if (!menu.hidden && !box.contains(e.target)) close(false);
      }
      document.addEventListener('pointerdown', awayStep);
      mark();
      return { step: function () { return step; } };
    },
    // A stamp read on the day it was made needs no date: SCS.2 runs
    // inside one day, so on the day every time on the site is today's
    // and the date beside it is a word nobody reads. Anything from
    // another day still says which, because "14:21" would otherwise be
    // read as today — that is the whole reason the date is there. The
    // settings menu's Hide dates rocker takes it off either way, for a
    // reader who knows every one of these is from today.
    fmtTime: function (utc, withYear) {
      var t = String(utc == null ? '' : utc).trim();
      // the 24-hour clock writes 14:05 rather than 2:05 pm
      var clock = window.scs.hour24() ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' } : { hour: 'numeric', minute: '2-digit' };
      // a time the worker sent without its date ("14:05", the organisers'
      // date rules) is on the event's clock already
      var bare = t.match(/^(\d{2}):(\d{2})$/);
      if (bare) return new Date(2000, 0, 1, +bare[1], +bare[2]).toLocaleTimeString(undefined, clock);
      var m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/);
      if (!m) return t;
      var d = new Date(m[1] + 'T' + m[2] + (m[3] || ':00') + 'Z');
      if (isNaN(d.getTime())) return t;
      if (window.scs.hideDates() || window.scs.isToday(d) || ruledOut(d)) {
        return d.toLocaleTimeString(undefined, clock);
      }
      var opts = { day: 'numeric', month: 'short', hour: clock.hour, minute: '2-digit' };
      if (clock.hourCycle) opts.hourCycle = clock.hourCycle;
      if (withYear) opts.year = 'numeric';
      return d.toLocaleString(undefined, opts);
    },
    // the date on its own, for the few places that want the day rather
    // than the moment — those are never dropped, because a date is what
    // was asked for; a time the worker sent without one has none to give
    // ('')
    fmtDay: function (utc, withYear) {
      var t = String(utc == null ? '' : utc).trim();
      if (/^\d{2}:\d{2}$/.test(t)) return '';
      var m = t.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
      if (!m) return t;
      // A stamp with a time is a UTC moment, and its day is the one the
      // device was in then: 9am in Sydney is the evening before in UTC.
      // A bare date is that calendar day.
      var d = m[4]
        ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]))
        : new Date(+m[1], +m[2] - 1, +m[3]);
      if (isNaN(d.getTime())) return t;
      var opts = { day: 'numeric', month: 'short' };
      if (withYear) opts.year = 'numeric';
      return d.toLocaleDateString(undefined, opts);
    },
    isToday: function (d) {
      var now = new Date();
      return d.getFullYear() === now.getFullYear() &&
        d.getMonth() === now.getMonth() &&
        d.getDate() === now.getDate();
    },
    hideDates: function () {
      try { return localStorage.getItem(DATES_KEY) === '1'; }
      catch (err) { return false; }
    },
    hour24: function () {
      try { return localStorage.getItem(CLOCK_KEY) === '24'; }
      catch (err) { return false; }
    },
    // Quest text is markdown-lite: **bold**, __underline__, *italic*,
    // `code`, [links](https://…), paragraphs and - lists. Escaped
    // first, so the output is safe to set as innerHTML.
    markdown: function (text) {
      var esc = String(text == null ? '' : text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      var codeRe = new RegExp(String.fromCharCode(96) + '([^' + String.fromCharCode(96) + ']+)' + String.fromCharCode(96), 'g');
      function inline(t) {
        var held = [];
        function hold(html) {
          var idx = held.length;
          held.push(html);
          return '\x00' + idx + '\x00';
        }
        function style(s) {
          return s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
            .replace(/__(.+?)__/g, '<u>$1</u>')
            .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>');
        }
        var out = t
          .replace(codeRe, function (_, body) { return hold('<code>' + body + '</code>'); })
          .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (_, label, href) {
            return hold('<a href="' + href + '" target="_blank" rel="noopener">' + style(label) + '</a>');
          });
        return style(out).replace(/\x00(\d+)\x00/g, function (_, i) { return held[Number(i)]; });
      }
      return esc.split(/\n{2,}/).map(function (block) {
        var lines = block.split('\n');
        if (lines.every(function (l) { return /^\s*[-*] /.test(l); })) {
          return '<ul>' + lines.map(function (l) { return '<li>' + inline(l.replace(/^\s*[-*] /, '')) + '</li>'; }).join('') + '</ul>';
        }
        return '<p>' + lines.map(inline).join('<br>') + '</p>';
      }).join('');
    },
    // A message body is the markdown above plus embeds: a line of its
    // own reading [[quest:SQ40]] becomes a card for that quest — its
    // chip and name, a link to it on the quest list, and the submit
    // page with the quest already picked. The card is built at once
    // with working links; the quest list fills the name in behind it.
    messageBody: function (container, text) {
      var S = window.scs;
      var pageHref = sitePath;
      function questCard(key) {
        var box = document.createElement('div');
        box.className = 'mq';
        var head = document.createElement('p');
        head.className = 'mq-head';
        var chip = document.createElement('span');
        chip.className = 'code';
        chip.textContent = key;
        var name = document.createElement('span');
        name.className = 'mq-name';
        var points = document.createElement('span');
        points.className = 'mq-points';
        head.appendChild(chip);
        head.appendChild(name);
        head.appendChild(points);
        box.appendChild(head);
        var meta = document.createElement('p');
        meta.className = 'mq-meta';
        meta.hidden = true;
        box.appendChild(meta);
        var actions = document.createElement('p');
        actions.className = 'mq-actions';
        var open = document.createElement('a');
        open.className = 'btn';
        open.href = pageHref('questlist/') + '#' + encodeURIComponent(key);
        open.textContent = 'Open quest';
        var send = document.createElement('a');
        send.className = 'btn btn-accent';
        send.href = pageHref('submit/') + '#' + encodeURIComponent(key);
        send.textContent = 'Submit proof';
        actions.appendChild(open);
        actions.appendChild(send);
        box.appendChild(actions);
        S.questList().then(function (data) {
          var nk = S.normQuest(key);
          var hit = null;
          (data.groups || []).forEach(function (g) {
            if (hit || !g.codes || !g.codes.length) return;
            if (S.normQuest(g.key) === nk) { hit = g; return; }
            for (var i = 0; i < g.codes.length; i++) {
              if (S.normQuest(g.codes[i].code) === nk) { hit = g; return; }
            }
          });
          if (!hit) { name.textContent = 'Not on the quest list'; return; }
          chip.textContent = hit.key;
          name.textContent = hit.name;
          var pts = Number(hit.codes[0].points) || 0;
          if (hit.mystery) points.textContent = '??? points';
          else if (pts) points.textContent = pts + ' points';
          if (hit.location) { meta.textContent = hit.location; meta.hidden = false; }
        }).catch(function () { /* the links work without the name */ });
        return box;
      }
      container.textContent = '';
      var tokenRe = /^\s*\[\[quest:\s*([^\]]+?)\s*\]\]\s*$/;
      var lines = String(text == null ? '' : text).split('\n');
      var held = [];
      function flush() {
        if (!held.length) return;
        // blank lines around a card belong to the card, not the text —
        // left on, a trailing one turns the chunk's last list into prose
        var chunk = held.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
        held = [];
        if (!chunk.replace(/\s/g, '')) return;
        var md = document.createElement('div');
        md.className = 'md';
        md.innerHTML = S.markdown(chunk); // escaped by the renderer
        container.appendChild(md);
      }
      for (var i = 0; i < lines.length; i++) {
        var m = lines[i].match(tokenRe);
        if (m) { flush(); container.appendChild(questCard(m[1])); }
        else held.push(lines[i]);
      }
      flush();
    },
    // <label class="sub-check"><input type=checkbox>[rocker][text]</label>
    rocker: function (className, text) {
      var label = document.createElement('label');
      label.className = className || 'sub-check';
      var box = document.createElement('input');
      box.type = 'checkbox';
      // a rocker built after boot still gets the native switch that
      // makes iOS tick (see the direct-tap haptics below)
      if (document.documentElement.classList.contains('haptic-taps')) box.setAttribute('switch', '');
      var sw = document.createElement('span');
      sw.className = 'settings-switch';
      sw.setAttribute('aria-hidden', 'true');
      var o = document.createElement('span'); o.className = 'switch-o'; o.textContent = 'O';
      var i = document.createElement('span'); i.className = 'switch-i'; i.textContent = 'I';
      sw.appendChild(o); sw.appendChild(i);
      label.appendChild(box);
      label.appendChild(sw);
      if (text) {
        var caption = document.createElement('span');
        if (typeof text === 'string') caption.textContent = text; else caption.appendChild(text);
        label.appendChild(caption);
      }
      return { label: label, input: box };
    },
    // JSON POST; resolves { status, data }
    postJson: function (url, body, token) {
      var headers = { 'content-type': 'application/json' };
      if (token) headers.authorization = 'Bearer ' + token;
      return fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); });
    },

    // ---- motion helpers (the t-* utilities in site.css) ----
    reducedMotion: !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches),
    // a motion token in ms, for timers that follow the CSS
    ms: function (name, fallback) {
      var v = parseFloat(getComputedStyle(root).getPropertyValue(name));
      return isFinite(v) ? v : fallback;
    },
    // How many pixels a map draws per point: no more than 2, or the
    // screen's own density with the Sharper Map setting on. A 3x phone's
    // full-screen map is 2.25 times the pixels at full density.
    mapPixelRatio: function () {
      var dpr = window.devicePixelRatio || 1;
      var sharp = false;
      try { sharp = localStorage.getItem('scs2-map-sharp') === '1'; } catch (err) { /* default off */ }
      return sharp ? dpr : Math.min(dpr, 2);
    },
    // re-add a class so its animation plays again
    replay: function (node, className) {
      node.classList.remove(className);
      void node.offsetWidth;
      node.classList.add(className);
    },
    // an element that has just appeared rises into place
    rise: function (node) {
      if (!node || window.scs.reducedMotion) return;
      window.scs.replay(node, 't-rise');
    },
    // the error shake, over in ~300ms
    shake: function (node) {
      if (!node || window.scs.reducedMotion) return;
      window.scs.replay(node, 'is-shaking');
      window.setTimeout(function () { node.classList.remove('is-shaking'); }, 320);
    },
    // a status line whose text changed enters from below; unchanged
    // text is left alone so a repeated message never flickers
    swapText: function (node, text) {
      if (!node) return;
      text = text == null ? '' : String(text);
      if (node.textContent === text) return;
      node.textContent = text;
      if (!text || window.scs.reducedMotion) return;
      node.classList.add('t-swap');
      window.scs.replay(node, 'is-swapping');
    },
    // a number whose digits pop in when it changes (number pop-in)
    digits: function (node, text) {
      if (!node) return;
      text = String(text);
      if (node.getAttribute('data-value') === text) return;
      node.setAttribute('data-value', text);
      if (window.scs.reducedMotion) { node.textContent = text; return; }
      node.classList.add('t-digit-group');
      node.classList.remove('is-animating');
      node.textContent = '';
      var chars = text.split('');
      chars.forEach(function (ch, i) {
        var span = document.createElement('span');
        span.className = 't-digit';
        // an inline-block collapses a lone space; keep the gap
        span.textContent = ch === ' ' ? String.fromCharCode(160) : ch;
        if (i === chars.length - 2) span.setAttribute('data-stagger', '1');
        else if (i === chars.length - 1) span.setAttribute('data-stagger', '2');
        node.appendChild(span);
      });
      void node.offsetHeight;
      node.classList.add('is-animating');
    }
  };

  // for the parts after this one
  site.root = root;
  site.installed = installed;
  site.APP_LAYOUT_KEY = APP_LAYOUT_KEY;
  site.DATES_KEY = DATES_KEY;
  site.CLOCK_KEY = CLOCK_KEY;
  site.phoneish = phoneish;
  site.TAB_API = TAB_API;
  site.PULSE_STALE = PULSE_STALE;
});
