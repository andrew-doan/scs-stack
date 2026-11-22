// The site's shared script, part five of five: the offline map, the service
// worker, updates, push and the countdown. Runs all five parts.
(window.scsSite = window.scsSite || { parts: [] }).parts.push(function (site) {
  'use strict';

  // from the parts before this one
  var TAB_API = site.TAB_API;
  var fetchRetry = site.fetchRetry;
  var leaveReason = site.leaveReason;
  var askBeforeLeaving = site.askBeforeLeaving;

  // ---------------- Offline map ----------------
  // The service worker keeps the map tiles it has drawn in a cache of
  // its own, so the map still works with no signal. That cache holds a
  // few hundred megabytes at most, which is more than some phones have
  // spare — so the first visit asks the browser how much room there is
  // and starts the feature off on a full device. The switch is stored
  // here and mirrored into a cache the worker reads (it cannot see
  // localStorage), and turning it off throws the tiles away.
  var TILE_KEY = 'scs2-tile-cache';
  var TILE_CACHE = 'scs2-tiles-v1';
  var TILE_CFG = 'scs2-tiles-cfg';
  var TILE_CFG_URL = '/__tiles';
  var TILE_ROOM = 250 * 1024 * 1024; // less free than this: start it off

  function tilePref() {
    try { return localStorage.getItem(TILE_KEY); } catch (err) { return null; }
  }
  function storeTilePref(on) {
    try { localStorage.setItem(TILE_KEY, on ? '1' : '0'); } catch (err) { /* not persisted */ }
  }
  function writeTileFlag(on) {
    if (!window.caches) return Promise.resolve();
    return caches.open(TILE_CFG).then(function (cache) {
      return cache.put(TILE_CFG_URL, new Response(on ? 'on' : 'off'));
    }).catch(function () { /* the worker's default is on */ });
  }
  function dropTileCache() {
    if (!window.caches) return Promise.resolve();
    return caches.delete(TILE_CACHE).catch(function () { /* nothing stored */ });
  }

  // What the switch should read on this device. A stored answer wins;
  // otherwise the room left decides it once, and that answer is stored.
  function decideTiles() {
    var stored = tilePref();
    if (stored === '0' || stored === '1') return Promise.resolve(stored === '1');
    var estimate = null;
    try {
      if (navigator.storage && navigator.storage.estimate) estimate = navigator.storage.estimate();
    } catch (err) { estimate = null; }
    if (!estimate || !estimate.then) { storeTilePref(true); return Promise.resolve(true); }
    return estimate.then(function (info) {
      var quota = Number(info && info.quota) || 0;
      var usage = Number(info && info.usage) || 0;
      var on = !(quota && quota - usage < TILE_ROOM);
      storeTilePref(on);
      return on;
    }).catch(function () { storeTilePref(true); return true; });
  }

  var tileCheck = document.getElementById('set-tile-cache');
  decideTiles().then(function (on) {
    if (tileCheck) tileCheck.checked = on;
    return writeTileFlag(on);
  });
  // The worker reads the flag at most once a minute, so it is told too,
  // or it keeps storing tiles in the cache just thrown away.
  function tellWorkerTiles(on) {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistration().then(function (reg) {
      if (reg && reg.active) reg.active.postMessage({ type: 'scs-tiles', on: on });
    }).catch(function () { /* the worker reads the flag on its own */ });
  }
  if (tileCheck) {
    tileCheck.addEventListener('change', function () {
      var on = tileCheck.checked;
      storeTilePref(on);
      tellWorkerTiles(on);
      writeTileFlag(on);
      if (!on) dropTileCache(); // off means gone, not just unused
    });
  }

  // ---------------- PWA service worker ----------------
  // sw.js lives next to the manifest at the site root; deriving its URL from
  // the manifest link keeps registration working from any sub-page.
  // Three seconds after load: a first install fetches every file in
  // PRECACHE, and the page's own pictures and reads come first.
  if ('serviceWorker' in navigator) {
    var manifestLink = document.querySelector('link[rel="manifest"]');
    if (manifestLink) {
      var registerSw = function () {
        window.setTimeout(function () {
          navigator.serviceWorker
            .register(new URL('sw.js', manifestLink.href).toString())
            .catch(function () { /* offline support is a bonus, never an error */ });
        }, 3000);
      };
      if (document.readyState === 'complete') registerSw();
      else window.addEventListener('load', registerSw);
    }
  }

  // ---------------- A new version of the site ----------------
  // Every deploy of the site bumps CACHE in sw.js, so a new worker
  // installs and takes over this page (skipWaiting, clients.claim). The
  // page on screen is still the build it loaded with, so it offers a
  // reload. A page with no worker when it loaded is a first visit: the
  // worker taking over then is its first install, not an update.
  if ('serviceWorker' in navigator && document.querySelector('link[rel="manifest"]')) {
    var hadWorker = !!navigator.serviceWorker.controller;
    var updatePill = null;
    var reloadForUpdate = function () {
      var why = leaveReason();
      if (why) { askBeforeLeaving(why, function () { location.reload(); }); return; }
      location.reload();
    };
    var offerUpdate = function () {
      if (updatePill) return;
      updatePill = document.createElement('div');
      updatePill.className = 'update-banner site-update';
      updatePill.setAttribute('role', 'status');
      updatePill.innerHTML =
        '<button class="site-update-go" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 0 1-14.7 5.8"/><path d="M3.5 12A8.5 8.5 0 0 1 18.2 6.2"/><path d="M18.5 2.5v4h-4"/><path d="M5.5 21.5v-4h4"/></svg>SCS.2 updated. Tap to reload</button>' +
        '<button class="site-update-close" type="button" aria-label="Not now">&times;</button>';
      updatePill.querySelector('.site-update-go').addEventListener('click', reloadForUpdate);
      updatePill.querySelector('.site-update-close').addEventListener('click', function () {
        // the next page opened is the new build anyway
        updatePill.classList.remove('is-shown');
        window.setTimeout(function () { updatePill.hidden = true; }, 400);
      });
      document.body.appendChild(updatePill);
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () { updatePill.classList.add('is-shown'); });
      });
    };
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!navigator.serviceWorker.controller) return;
      if (!hadWorker) { hadWorker = true; return; }
      offerUpdate();
    });
    // The browser looks for a new worker on every page load. A page left
    // open (the installed app, the live tab) asks as well when it comes
    // back after a minute away and every half hour while it is open.
    var askForUpdate = function () {
      if (!hadWorker || updatePill || navigator.onLine === false) return;
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (reg) return reg.update();
      }).catch(function () { /* asked again next time */ });
    };
    var hiddenSince = 0;
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') { hiddenSince = Date.now(); return; }
      if (hiddenSince && Date.now() - hiddenSince > 60000) askForUpdate();
      hiddenSince = 0;
    });
    window.setInterval(function () {
      if (document.visibilityState === 'visible') askForUpdate();
    }, 30 * 60000);
  }

  // ---------------- Push notifications ----------------
  // The settings rocker asks for permission inside the tap itself —
  // iOS refuses prompts that don't come from a user gesture — then
  // subscribes with the tab worker's VAPID key and stores the
  // subscription there. iOS only offers push to the installed app, so
  // a plain Safari tab gets the install hint instead of a prompt.
  var pushCheck = document.getElementById('set-push');
  if (pushCheck) {
    var pushSub = window.scs.pushSub;
    var pushHint = document.getElementById('set-push-hint');
    // The row's own line says what notifications are. While there is
    // something to say about the state — the browser has none, they
    // are blocked, they just went on, the last try failed — the line
    // says that instead, and goes back to the explanation when there
    // is not.
    var pushRest = pushHint ? pushHint.textContent : '';
    var pushBusy = false;

    var setPushHint = function (text) {
      if (!pushHint) return;
      pushSub.paint(pushHint, text || pushRest);
    };

    if (!pushSub.supported()) {
      pushCheck.disabled = true;
      setPushHint(pushSub.hint('unsupported'));
    } else {
      var syncPushCheck = function () {
        pushSub.state().then(function (state) {
          pushCheck.checked = state === 'on';
        }).catch(function () { /* stays off */ });
      };
      syncPushCheck();
      // the messages page's own switch changed it
      document.addEventListener('scs-push-changed', function () {
        if (!pushBusy) syncPushCheck();
      });

      pushCheck.addEventListener('change', function () {
        // the browser has already flipped the box: one change at a time,
        // across both switches, so it goes back
        if (pushBusy || pushSub.busy()) { pushCheck.checked = !pushCheck.checked; return; }
        pushBusy = true;
        setPushHint('');
        var want = pushCheck.checked;
        (want ? pushSub.enable() : pushSub.disable()).then(function () {
          if (want) setPushHint(pushSub.hint('on'));
        }).catch(function (err) {
          pushCheck.checked = !want;
          setPushHint(err && err.message === 'denied'
            ? pushSub.hint('denied')
            : 'That did not work. Try again.');
        }).then(function () { pushBusy = false; });
      });
    }
  }

  // ---------------- Event countdown ----------------
  // Markup contract:
  //   <section data-countdown="ISO start" data-countdown-end="ISO end">
  //     <h2 data-cd-label>what it is counting to</h2>
  //     <div class="countdown-grid"> tiles with [data-cd-days|hours|mins|secs] </div>
  //     <p class="countdown-message is-hidden" data-cd-message></p>
  //   </section>
  //
  // The date in the markup is the one built in, and it is on screen at
  // the first paint with nothing fetched. The dashboard holds a run of
  // stops instead — the day starting, submissions closing, the
  // ceremony — and the page counts to the first one still ahead, moving
  // to the next as each passes. Those arrive in three steps, and only
  // the last of them touches the network: the markup, then the copy
  // kept from the last visit, then the worker's answer. Nothing here
  // ever shows a loading state, and a worker that cannot be reached
  // changes nothing on screen.
  var box = document.querySelector('[data-countdown]');
  if (!box) return;

  var CD_KEY = 'scs2-countdown';
  // what it says once every stop has passed: the dashboard's line, kept
  // from the last visit, or this one
  var OVER_KEY = 'scs2-countdown-over';
  var OVER_DEFAULT = 'SCS.2 is over. Results are on Discord.';
  var overText = OVER_DEFAULT;
  try { overText = localStorage.getItem(OVER_KEY) || OVER_DEFAULT; } catch (err) { /* the page's own */ }
  var labelEl = box.querySelector('[data-cd-label]');
  var endAttr = box.getAttribute('data-countdown-end');
  var endAt = endAttr ? new Date(endAttr) : null;

  var els = {
    days: box.querySelector('[data-cd-days]'),
    hours: box.querySelector('[data-cd-hours]'),
    mins: box.querySelector('[data-cd-mins]'),
    secs: box.querySelector('[data-cd-secs]')
  };
  var grid = box.querySelector('.countdown-grid');
  var msg = box.querySelector('[data-cd-message]');

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  // ---- split-flap modules ----
  // One module per digit. At rest all three faces carry the same
  // numeral, so nothing shows; a change hands the old numeral to the
  // falling leaf and the new one to everything else.
  var FLAP_FALL = 130; // one half of the turn, matching --flap-fall

  function buildFlap(ch) {
    var flap = document.createElement('span');
    flap.className = 'flap';
    flap.setAttribute('data-value', ch);
    ['flap-upper', 'flap-lower', 'flap-upper flap-leaf flap-leaf-a', 'flap-lower flap-leaf flap-leaf-b']
      .forEach(function (cls) {
        var half = document.createElement('span');
        half.className = 'flap-half ' + cls;
        var glyph = document.createElement('b');
        glyph.textContent = ch;
        half.appendChild(glyph);
        flap.appendChild(half);
      });
    return flap;
  }

  function setFlap(flap, ch) {
    if (flap.getAttribute('data-value') === ch) return;
    flap.setAttribute('data-value', ch);
    var faces = flap.querySelectorAll('b'); // upper, lower, leaf a, leaf b
    if (window.scs.reducedMotion) {
      for (var i = 0; i < faces.length; i++) faces[i].textContent = ch;
      return;
    }
    faces[0].textContent = ch;  // waits behind the falling leaf
    faces[3].textContent = ch;  // rises into place over the old lower half
    window.clearTimeout(flap.timer);
    flap.classList.remove('is-flipping');
    void flap.offsetWidth;      // so a digit changing again mid-turn restarts
    flap.classList.add('is-flipping');
    flap.timer = window.setTimeout(function () {
      faces[1].textContent = ch; // the lower half is the new numeral now
      faces[2].textContent = ch;
      flap.classList.remove('is-flipping');
    }, FLAP_FALL * 2);
  }

  // a value's worth of modules, rebuilt only when it needs more digits
  function setFlaps(host, text) {
    if (!host) return;
    // a plain numeral, where the markup asks for one rather than for
    // a run of flap modules. The leading zero is a flap-module
    // convention — every module has to carry a digit — and reads as a
    // broken readout when it is set as an ordinary number.
    if (!host.classList.contains('count-num')) {
      var plain = text.length > 1 ? String(parseInt(text, 10)) : text;
      if (host.textContent !== plain) host.textContent = plain;
      return;
    }
    if (host.childElementCount !== text.length) {
      host.textContent = '';
      for (var i = 0; i < text.length; i++) host.appendChild(buildFlap(text.charAt(i)));
      return;
    }
    for (var j = 0; j < text.length; j++) setFlap(host.children[j], text.charAt(j));
  }

  // ---- the stops ----
  // The worker keeps UTC as "YYYY-MM-DD HH:MM:SS"; the markup carries an
  // ISO string with an offset on it. Both have to read as the same
  // instant, so a stamp with no zone in it is taken as the worker's UTC.
  function stopTime(raw) {
    var text = String(raw == null ? '' : raw).trim();
    if (!text) return null;
    var d = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text)
      ? new Date(text.replace(' ', 'T') + 'Z')
      : new Date(text);
    return isNaN(d.getTime()) ? null : d;
  }

  // a list worth counting to, in time order — or null, which every
  // caller reads as "keep whatever is on screen"
  function cleanStops(list) {
    if (!list || typeof list.length !== 'number') return null;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i] || {};
      var at = stopTime(s.at);
      if (!at || !s.label) continue;
      out.push({ label: String(s.label), at: s.at, time: at });
    }
    out.sort(function (a, b) { return a.time - b.time; });
    return out.length ? out : null;
  }

  // the heading in the markup, read now: it is written over as stops pass
  var builtLabel = labelEl ? labelEl.textContent : '';
  // the stop the markup itself is: the built-in date under the heading
  // the markup gives it, which is what shows before anything is read
  function builtIn() {
    return cleanStops([{
      label: builtLabel,
      at: box.getAttribute('data-countdown')
    }]);
  }

  function sameStops(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (a[i].label !== b[i].label || +a[i].time !== +b[i].time) return false;
    }
    return true;
  }

  function readStored() {
    try { return cleanStops(JSON.parse(localStorage.getItem(CD_KEY) || 'null')); }
    catch (err) { return null; }
  }
  function writeStored(list) {
    try { localStorage.setItem(CD_KEY, JSON.stringify(list)); } catch (err) { /* not persisted */ }
  }

  var stops = readStored() || builtIn();
  var shown = null;   // the stop the grid is counting to right now
  var timer = null;

  function currentStop(now) {
    for (var i = 0; i < stops.length; i++) {
      if (stops[i].time > now) return stops[i];
    }
    return null;
  }

  function tick() {
    var now = new Date();
    var stop = currentStop(now);

    if (!stop) {
      if (grid) grid.classList.add('is-hidden');
      box.classList.add('is-over');
      if (msg) {
        msg.classList.remove('is-hidden');
        msg.textContent = (endAt && now <= endAt)
          ? 'SCS.2 is on right now.'
          : overText;
      }
      // while the day itself is still running the message has one more
      // change to make, so the clock keeps going; after that it stops
      if (!(endAt && now <= endAt)) window.clearInterval(timer);
      return;
    }

    // a stop passing moves the whole board to the next one
    if (stop !== shown) {
      shown = stop;
      if (labelEl && stop.label) labelEl.textContent = stop.label;
      if (grid) grid.classList.remove('is-hidden');
      box.classList.remove('is-over');
      if (msg) msg.classList.add('is-hidden');
    }

    var totalSecs = Math.floor((stop.time - now.getTime()) / 1000);
    var d = Math.floor(totalSecs / 86400);
    var h = Math.floor((totalSecs % 86400) / 3600);
    var m = Math.floor((totalSecs % 3600) / 60);
    var s = totalSecs % 60;
    // a module only turns when its own digit changes: the seconds
    // every second, the tens of seconds every ten, the days once a day
    setFlaps(els.days, pad(d));
    setFlaps(els.hours, pad(h));
    setFlaps(els.mins, pad(m));
    setFlaps(els.secs, pad(s));
    unit(els.days, d, 'day', 'days');
    unit(els.hours, h, 'hr', 'hrs');
    unit(els.mins, m, 'min', 'mins');
    unit(els.secs, s, 'sec', 'secs');
  }

  // The word after a plain numeral, where the markup gives it an element
  // of its own: "1 mins" was the board's one typo.
  function unit(host, n, one, many) {
    var word = host && !host.classList.contains('count-num') && host.nextElementSibling;
    if (!word) return;
    var text = n === 1 ? one : many;
    if (word.textContent !== text) word.textContent = text;
  }

  function run() {
    window.clearInterval(timer);
    shown = null;
    tick();
    timer = window.setInterval(tick, 1000);
  }

  run();

  // The worker's copy, behind the one already on screen. A list that
  // says the same thing changes nothing — no reflow, no flap turning
  // over for a value it already had.
  fetchRetry(TAB_API + '/api/countdown').then(function (r) {
    return r.ok ? r.json() : null;
  }).then(function (d) {
    if (!d) return;
    var sent = d.stops && typeof d.stops.length === 'number' ? d.stops : [];
    // no stops set means the dashboard has none: back to the markup
    var next = cleanStops(sent) || builtIn();
    writeStored(sent);
    var said = typeof d.over === 'string' && d.over ? d.over : '';
    try {
      if (said) localStorage.setItem(OVER_KEY, said); else localStorage.removeItem(OVER_KEY);
    } catch (err) { /* not kept */ }
    var over = said || OVER_DEFAULT;
    if (sameStops(next, stops) && over === overText) return;
    overText = over;
    stops = next;
    run();
  }).catch(function () { /* the built-in date is already counting */ });
});

// every part is in: run them in order, as one script
window.scsSite.parts.forEach(function (part) { part(window.scsSite); });
