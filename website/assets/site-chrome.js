// The site's shared script, part three of five: the bell, the menus and
// settings, the theme, pull to refresh and the bars.
(window.scsSite = window.scsSite || { parts: [] }).parts.push(function (site) {
  'use strict';

  // from the parts before this one
  var root = site.root;
  var installed = site.installed;
  var APP_LAYOUT_KEY = site.APP_LAYOUT_KEY;
  var appLayoutWanted = site.appLayoutWanted;
  var syncAppLayout = site.syncAppLayout;
  var phoneish = site.phoneish;
  var sitePath = site.sitePath;
  var readAs = site.readAs;
  var PULSE_STALE = site.PULSE_STALE;
  var fetchPulse = site.fetchPulse;

  // ---------------- Messages bell ----------------
  // The bell in the top bar carries a red dot while OrgComm has posted
  // something this device has not opened. Asking costs one small
  // request per visit; a page left open in the background asks again on
  // its way back, so the dot can arrive without a reload.
  if (document.querySelector('.bell-toggle')) {
    // A tap fills the bell in — the solid face cross-fades up while the
    // messages page is on its way, and that page's own markup keeps it
    // filled once there. Coming back through the back/forward cache
    // would otherwise keep the solid bell on a page that is not the
    // messages page, so a restored page puts the outline back.
    var bellLink = document.querySelector('.bell-toggle');
    if (!bellLink.classList.contains('is-filled')) {
      bellLink.addEventListener('click', function () {
        bellLink.classList.add('is-filled');
        bellLink.classList.add('is-ringing');
        // the page switch cuts the swing short, so the messages page
        // finishes it on arrival
        try { sessionStorage.setItem('scs2-bell-rung', '1'); } catch (err) { /* rings here only */ }
      });
      window.addEventListener('pageshow', function (e) {
        if (e.persisted) {
          bellLink.classList.remove('is-filled');
          bellLink.classList.remove('is-ringing');
        }
      });
    } else {
      // the messages page's own bell: ring on arrival when a tap sent
      // us here, and ring in place on a tap — the link only points at
      // this page, so a reload would say less than the swing does
      var cameByTap = false;
      try {
        cameByTap = sessionStorage.getItem('scs2-bell-rung') === '1';
        sessionStorage.removeItem('scs2-bell-rung');
      } catch (err) { cameByTap = false; }
      if (cameByTap) bellLink.classList.add('is-ringing');
      bellLink.addEventListener('click', function (e) {
        e.preventDefault();
        window.scs.replay(bellLink, 'is-ringing');
      });
    }
    var askAgain = function () {
      site.pulsePromise = fetchPulse();
      site.pulsePromise.then(landed);
    };
    // no answer: asked again later and when the device is back online
    var landed = function (pulse) {
      if (!pulse) { window.scs.again('pulse', askAgain); return; }
      window.scs.gotIt('pulse');
      window.scs.syncBell();
      checkUrgent(pulse);
    };
    window.scs.pulse().then(function (pulse) {
      if (pulse) { window.scs.syncBell(); checkUrgent(pulse); }
      else landed(pulse);
    });
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) { site.hiddenAt = Date.now(); return; }
      if (!site.hiddenAt || Date.now() - site.hiddenAt < PULSE_STALE) return;
      site.hiddenAt = 0;
      askAgain();
    });
    // a team signing in can read messages the public could not
    document.addEventListener('scs-session-changed', askAgain);
  }

  // ---------------- Welfare heart ----------------
  // The app layout's way to the welfare page from the top bar does what
  // the bell does: a tap fills it in and it beats, the welfare page
  // finishes the beat on arrival, and on the welfare page itself a tap
  // beats in place rather than reloading the page it is on.
  var heartLink = document.querySelector('.welfare-toggle');
  if (heartLink) {
    if (!heartLink.classList.contains('is-active')) {
      heartLink.addEventListener('click', function () {
        heartLink.classList.add('is-filled');
        heartLink.classList.add('is-beating');
        try { sessionStorage.setItem('scs2-heart-beat', '1'); } catch (err) { /* beats here only */ }
      });
      window.addEventListener('pageshow', function (e) {
        if (e.persisted) {
          heartLink.classList.remove('is-filled');
          heartLink.classList.remove('is-beating');
        }
      });
    } else {
      var heartByTap = false;
      try {
        heartByTap = sessionStorage.getItem('scs2-heart-beat') === '1';
        sessionStorage.removeItem('scs2-heart-beat');
      } catch (err) { heartByTap = false; }
      if (heartByTap) heartLink.classList.add('is-beating');
      heartLink.addEventListener('click', function (e) {
        e.preventDefault();
        window.scs.replay(heartLink, 'is-beating');
      });
    }
  }

  // ---------------- Urgent message ----------------
  // OrgComm can mark one message urgent, and that one opens over
  // whatever page the reader is on. The pulse carries the id of the
  // urgent message that went live last; the device keeps the ids it has
  // put away and leaves those alone.
  var URGENT_KEY = 'scs2-urgent-dismissed';
  var URGENT_CAP = 50;
  var URGENT_SEEN_KEY = 'scs2-urgent-seen'; // read once, to build the set
  var urgentOpen = false;

  function urgentAway() {
    var list = window.scs.seenSet(URGENT_KEY);
    if (list) return list;
    var was = window.scs.seen(URGENT_SEEN_KEY);
    return window.scs.addSeen(URGENT_KEY, was === null ? [] : [was], URGENT_CAP);
  }
  function urgentPutAway(id) { return urgentAway().indexOf(id) !== -1; }
  function putUrgentAway(id) {
    urgentAway();
    window.scs.addSeen(URGENT_KEY, [id], URGENT_CAP);
  }

  // Every page carries the bell, and the bell knows the way to the
  // messages page from wherever this page sits.
  function messagesHref() {
    var bell = document.querySelector('.bell-toggle');
    return bell ? bell.getAttribute('href') : 'messages/';
  }

  function openUrgent(msg, id) {
    if (urgentOpen) return;
    // put away while this one was waiting to open
    if (urgentPutAway(id)) return;
    urgentOpen = true;
    var lastFocus = document.activeElement;
    var overlay = document.createElement('div');
    overlay.className = 'urgent-overlay';
    var card = document.createElement('div');
    card.className = 'urgent-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'Message from OrgCom');

    var head = document.createElement('p');
    head.className = 'urgent-head';
    head.textContent = 'From OrgCom';
    card.appendChild(head);

    var body = document.createElement('div');
    body.className = 'urgent-body';
    var title = document.createElement('h2');
    title.className = 'urgent-title';
    title.textContent = msg.title || '';
    body.appendChild(title);
    if (msg.body) {
      var text = document.createElement('div');
      text.className = 'urgent-text md';
      window.scs.messageBody(text, msg.body); // markdown + quest embeds
      // following any link in the body — a quest embed's, say — is
      // reading the message; on this very page a hash link would
      // otherwise open a sheet under the still-open pop-up
      text.addEventListener('click', function (e) {
        var a = e.target.closest ? e.target.closest('a') : null;
        if (a) dismiss(false);
      });
      body.appendChild(text);
    }
    var actions = document.createElement('div');
    actions.className = 'urgent-actions';
    var go = document.createElement('a');
    go.className = 'btn btn-accent';
    go.href = messagesHref();
    go.textContent = 'Open messages';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn urgent-dismiss';
    close.textContent = 'Dismiss';
    actions.appendChild(go);
    actions.appendChild(close);
    body.appendChild(actions);
    card.appendChild(body);
    overlay.appendChild(card);

    var layer = null;
    var closed = false;
    function markRead() { putUrgentAway(id); }
    function dismiss(viaBack) {
      if (closed) return;
      closed = true;
      urgentOpen = false;
      markRead();
      document.removeEventListener('keydown', onKey);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      // the popstate does the single stack pop; disarming here would eat
      // the layer beneath
      if (!viaBack && layer && window.scsBackLayer) window.scsBackLayer.disarm(layer);
      if (lastFocus && lastFocus.focus) { try { lastFocus.focus(); } catch (err) { /* gone from the page */ } }
    }
    function onKey(e) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (layer && !window.scsBackLayer.isTop(layer)) return;
      e.preventDefault();
      dismiss(false);
    }
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) dismiss(false); // the ground around the card
    });
    close.addEventListener('click', function () { dismiss(false); });
    // following the link is reading it too
    go.addEventListener('click', function () { markRead(); });
    document.addEventListener('keydown', onKey);
    if (window.scsBackLayer) layer = window.scsBackLayer.arm(function () { dismiss(true); });

    document.body.appendChild(overlay);
    close.focus();
    if (window.scs.reducedMotion) {
      overlay.classList.add('is-open');
    } else {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () { overlay.classList.add('is-open'); });
      });
    }
  }

  function checkUrgent(pulse) {
    if (!pulse || typeof pulse.urgent !== 'number' || pulse.urgent <= 0) return;
    var id = Math.floor(pulse.urgent);
    if (urgentPutAway(id)) return;
    // the messages page is where this would send the reader anyway:
    // being on it counts as having seen it
    if (document.getElementById('msg-list')) { putUrgentAway(id); return; }
    if (urgentOpen) return;
    readAs('/api/messages', '/api/messages/team')
      .then(function (data) {
        var list = (data && data.messages) || [];
        var msg = null;
        for (var i = 0; i < list.length; i++) {
          if (Number(list[i].id) === id) { msg = list[i]; break; }
        }
        if (!msg) return; // nothing to show, so show nothing
        // the launch splash gets the screen first, and the slideshow,
        // which covers the screen above this, keeps it until it ends
        var tryOpen = function () {
          if (window.scsSlideshow && window.scsSlideshow.isOn()) { window.setTimeout(tryOpen, 2000); return; }
          openUrgent(msg, id);
        };
        var show = function () { window.setTimeout(tryOpen, 700); };
        if (document.readyState === 'complete') show();
        else window.addEventListener('load', show, { once: true });
      })
      .catch(function () { /* nothing to show */ });
  }

  // ---------------- Pull to refresh (phones) ----------------
  // Pages that opt in (main[data-pull]) reload on a pull from the top
  // of the page: the page follows the finger down on a rubber band and
  // brings an arrow out from under the top bar with it (the arrow is
  // part of the page, parked in the strip the bar covers); the arrow
  // flips up once the pull is far enough, and letting go there runs a
  // short bar and reloads. Letting go earlier eases everything back.
  // Touches that start on the map, a sheet, a panel or a slider are
  // left alone.
  var pullMain = document.querySelector('main[data-pull]');
  // Does the touch belong to something that scrolls sideways? Both
  // gesture guards below have to stand down for one: the pull, which
  // claims a downward drag before it can tell how far sideways it is
  // going, and the swipe killer, which cancels every horizontal drag on
  // the page to stop iOS reading it as a back gesture. Measured rather
  // than matched against a list of class names, so the next side-scroller
  // built does not have to be remembered.
  function scrollsSideways(node) {
    for (var el = node; el && el.nodeType === 1 && el !== document.body; el = el.parentElement) {
      if (el.scrollWidth - el.clientWidth > 4) {
        var ox = window.getComputedStyle(el).overflowX;
        if (ox === 'auto' || ox === 'scroll') return true;
      }
    }
    return false;
  }

  if (pullMain && phoneish && 'ontouchstart' in window) {
    document.documentElement.classList.add('has-pull');
    var ptr = document.createElement('div');
    ptr.className = 'ptr';
    ptr.setAttribute('aria-hidden', 'true');
    ptr.innerHTML = '<span class="ptr-disc"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v16"/><path d="m5 13 7 7 7-7"/></svg></span>';
    var ptrBar = document.createElement('div');
    ptrBar.className = 'ptr-bar';
    ptrBar.setAttribute('aria-hidden', 'true');
    ptrBar.appendChild(document.createElement('span'));
    pullMain.insertBefore(ptr, pullMain.firstChild); // rides with the page
    document.body.appendChild(ptrBar);
    // A page can have a row under the bar — the quest list's chips, the
    // submit page's view switch; fixed to the screen in the app layout
    // (.app-pin), stuck to the top on the web. The arrow parks with its
    // bottom edge on the row's rather than 44px above the page's
    // content, which in the app layout is inside that row's own band;
    // and the row is marked (.ptr-still) so a pull moves everything in
    // the page but it, or the two travel together and the arrow never
    // comes out from anywhere. Only a row at the very top of the page
    // counts: under the web layout's title band the row is further down
    // and moves with the page like everything else. It is measured at
    // the top of the page, before a pull moves anything, because
    // scrolled down a stuck row's box says nothing about where it sits
    // in the page.
    var measurePtr = function () {
      if (pullScroller.scrollTop > 0) return;
      var lift = 0;
      var top = pullMain.getBoundingClientRect().top;
      var kids = pullMain.children;
      for (var i = 0; i < kids.length; i++) {
        var el = kids[i];
        if (el === ptr) continue;
        var still = false;
        var pos = window.getComputedStyle(el).position;
        if (pos === 'sticky' || pos === 'fixed') {
          var r = el.getBoundingClientRect();
          if (r.height && r.top - top < 1) {
            still = true;
            if (r.bottom - top > lift) lift = r.bottom - top;
          }
        }
        el.classList.toggle('ptr-still', still);
      }
      document.documentElement.style.setProperty('--ptr-lift', Math.round(lift) + 'px');
    };
    var pullScroller = document.body;
    measurePtr();
    window.addEventListener('resize', measurePtr);
    window.addEventListener('load', measurePtr);
    var PULL_ARM = 72;
    var PULL_SLOP = 12;
    var PULL_LIMIT = 240; // the page's travel approaches this and never passes it
    var pullStartY = null;
    var pulling = false;
    var pullNative = false;    // the browser owns this touch's pan; we only watch
    var pullNativeBase = null; // where the finger was when the top came back
    var pullArmed = false;
    var pullBusy = false;
    // Touches that begin on any layer over the page belong to that
    // layer, never to the pull — the slide-to-confirm taught this:
    // dragging its thumb also fed the pull, which moved the page under
    // the overlay, armed the arrow, and a long enough slide reloaded.
    var pullSkip = '.maplibregl-map, .ql-map-card, .ql-search, .rp-pane, .ql-detail-overlay, .settings-panel, .urgent-overlay, .confirm-overlay, .lb-overlay, .install-nudge, .update-banner, .toast-stack, input[type=range], textarea';
    var setPullArmed = function (armed) {
      if (armed === pullArmed) return;
      pullArmed = armed;
      ptr.classList.toggle('is-armed', armed);
      if (armed && window.scsHaptic) window.scsHaptic('light');
    };
    document.addEventListener('touchstart', function (e) {
      pullStartY = null;
      pullNative = false;
      pullNativeBase = null;
      if (pullBusy || e.touches.length !== 1 || pullScroller.scrollTop > 0) return;
      if (document.documentElement.classList.contains('ql-sheet-open') ||
          document.documentElement.classList.contains('ql-map-full')) return;
      if (e.target.closest && e.target.closest(pullSkip)) return;
      // A drag that starts on the chip row is the row's, and the pull
      // cannot tell: it claims the first downward move outright, because
      // once the browser has begun its own pan no later cancel stops it,
      // and a sideways finger drifts down a pixel or two like any other.
      if (scrollsSideways(e.target)) return;
      pullStartY = e.touches[0].clientY;
      pulling = false;
      measurePtr();
    }, { passive: true });
    // Letting go short of the mark, or taking the page back up the other
    // way: everything eases back, and the transform comes off afterwards.
    var easeBack = function () {
      pulling = false;
      ptr.classList.remove('is-pulling');
      ptr.classList.remove('is-armed');
      pullArmed = false;
      document.documentElement.classList.add('is-pull-settling');
      document.documentElement.style.setProperty('--pull', '0px');
      window.setTimeout(function () {
        if (pulling) return;
        document.documentElement.classList.remove('is-pulling');
        document.documentElement.classList.remove('is-pull-settling');
      }, 300);
    };
    document.addEventListener('touchmove', function (e) {
      if (pullStartY === null || pullBusy) return;
      var cy = e.touches[0].clientY;
      var dy = cy - pullStartY;
      if (!pulling && !pullNative) {
        // The very first downward move at the top of the page is
        // claimed: once the browser has begun its own pan (the rubber
        // band that dragged the whole page down) no later cancel stops
        // it. A first move upward, sideways or already in a native pan
        // leaves the page to the browser — but the touch is still
        // watched: if the finger scrolls back to the top and keeps
        // pulling, the browser's own bounce carries the arrow out, and
        // the arrow can still arm and reload from the finger alone.
        if (dy <= 0 || pullScroller.scrollTop > 0 || !e.cancelable) {
          pullNative = true;
        } else {
          e.preventDefault();
          if (dy < PULL_SLOP) return;
          pulling = true;
          ptr.classList.add('is-pulling');
        }
      }
      if (pullNative) {
        if (pullScroller.scrollTop > 0) {
          pullNativeBase = null;
          setPullArmed(false);
          return;
        }
        if (pullNativeBase === null) pullNativeBase = cy;
        setPullArmed(cy - pullNativeBase - PULL_SLOP >= PULL_ARM);
        return;
      }
      if (e.cancelable) e.preventDefault();
      var dist = Math.max(0, dy - PULL_SLOP);
      // rubber band: the page moves ever less the further the finger
      // goes, and carries the arrow out from under the top bar
      var shown = PULL_LIMIT * dist / (dist + PULL_LIMIT);
      document.documentElement.classList.add('is-pulling');
      document.documentElement.classList.remove('is-pull-settling');
      document.documentElement.style.setProperty('--pull', shown + 'px');
      setPullArmed(dist >= PULL_ARM);
    }, { passive: false });
    var endPull = function () {
      if (pullStartY === null) return;
      pullStartY = null;
      var wasNative = pullNative;
      pullNative = false;
      pullNativeBase = null;
      if (!pulling && !(wasNative && pullArmed)) {
        setPullArmed(false);
        return;
      }
      var wasPulling = pulling;
      pulling = false;
      if (pullArmed) {
        pullBusy = true;
        ptr.classList.add('is-loading');
        ptrBar.classList.add('is-loading');
        // the page eases back up (its own bounce does it on a watched
        // native pan), the bar runs, then reload
        if (wasPulling) {
          document.documentElement.classList.add('is-pull-settling');
          document.documentElement.style.setProperty('--pull', '0px');
        }
        window.setTimeout(reloadPulled, 650);
        return;
      }
      easeBack();
    };
    // the pull put back as it was, for a reload that did not happen
    var settlePull = function () {
      pullBusy = false;
      ptr.classList.remove('is-loading');
      ptrBar.classList.remove('is-loading');
      easeBack();
    };
    // A page with work in flight asks first, the way its links do. The
    // browser's own leave question can still stop a reload, so the pull
    // comes back if the page is still here a while later.
    var reloadPulled = function () {
      var why = site.leaveReason ? site.leaveReason() : '';
      if (why && site.askBeforeLeaving) {
        settlePull();
        site.askBeforeLeaving(why, function () { location.reload(); });
        return;
      }
      location.reload();
      window.setTimeout(settlePull, 10000);
    };
    document.addEventListener('touchend', endPull);
    document.addEventListener('touchcancel', endPull);
  }

  // ---------------- Launch splash & zoom lock (installed app) ----------------
  var splash = document.getElementById('app-splash');
  if (splash) {
    if (document.documentElement.classList.contains('show-splash')) {
      var splashGone = false;
      var dismissSplash = function () {
        if (splashGone) return;
        splashGone = true;
        splash.classList.add('is-leaving');
        window.setTimeout(function () {
          if (splash.parentNode) splash.parentNode.removeChild(splash);
          document.documentElement.classList.remove('show-splash');
        }, 240);
      };
      // two frames = the page underneath has painted; no artificial delay
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(dismissSplash);
      });
      window.setTimeout(dismissSplash, 4000); // safety net
    } else if (splash.parentNode) {
      splash.parentNode.removeChild(splash);
    }
  }

  // Page zoom is locked in the app and in phone browsers alike (the map
  // keeps its own pinch zoom, and the text size setting stays available).
  if (phoneish) {
    var vp = document.querySelector('meta[name="viewport"]');
    if (vp && vp.getAttribute('content').indexOf('maximum-scale') === -1) {
      // maximum-scale alone is the lock. user-scalable=no is honoured
      // fully inside home-screen apps on older iOS, where it has a
      // history of keeping the keyboard from coming up on a focused
      // input — and it adds nothing maximum-scale does not already do.
      vp.setAttribute('content', vp.getAttribute('content') + ', maximum-scale=1');
    }
  }

  if (installed && navigator.storage && navigator.storage.persist) {
    // Ask the browser to treat the offline cache as persistent, so iOS
    // keeps the app working without internet instead of evicting it.
    navigator.storage.persist().catch(function () { /* best effort */ });
  }

  // Swiping in from the screen edges must not page back/forward like a
  // browser tab. overscroll-behavior-x (in the stylesheet) stops the
  // scroll-chained version everywhere, but iOS runs its interactive
  // history swipe regardless unless the edge touch itself is cancelled
  // — so in the app and in phone browsers alike, a touch that starts
  // in the narrow edge band is cancelled. Android's system back
  // gesture is OS level and keeps working. Touches on real controls,
  // the map and side-scrolling tables are left alone so the tab bar,
  // camera button, map and wide tables stay usable near the edges.
  if (phoneish) {
    // Things that genuinely move sideways keep every gesture they get.
    // The map and a text field pan without being scrollers, so they are
    // named; everything else is ASKED of the DOM rather than listed,
    // because the list went stale the moment the quest list's chip row
    // was built. A row that scrolls sideways and has its every
    // touchmove cancelled is a row with most of its chips out of reach,
    // and it was that on every phone, on the page and in the fullscreen
    // map's search panel alike.
    // .hs-well is the home page's slideshow: a sideways drag there is
    // the pictures being moved, and it reads the drag through pointer
    // events, which a cancelled touchmove does not stop — but the
    // guard has no business in it either way, and naming it here is
    // what says so.
    var PANS_SIDEWAYS = '.maplibregl-map, .hs-well, input, textarea, select';
    var swipeX = 0;
    var swipeY = 0;
    var swipeWatch = false;
    var swipeKill = false;

    document.addEventListener('touchstart', function (e) {
      swipeWatch = false;
      swipeKill = false;
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      var el = e.target;
      if (el && el.closest && el.closest(PANS_SIDEWAYS)) return;
      if (scrollsSideways(el)) return;
      swipeX = t.clientX;
      swipeY = t.clientY;
      swipeWatch = true;
      // A touch that starts in the edge band is iOS's history swipe
      // beginning: cancel it before the gesture is recognised. Real
      // controls are left alone so the tab bar and the camera button
      // stay tappable right at the screen edges.
      if (t.clientX > 18 && t.clientX < window.innerWidth - 18) return;
      if (el && el.closest && el.closest('a, button, label, summary')) return;
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    // iOS will also start its swipe from a press that began well away
    // from the edge — hold still for a moment, then drag sideways. So
    // any drag that turns out to be horizontal is cancelled as soon as
    // it shows its direction, wherever it started. A drag that reads
    // as vertical is released immediately and scrolls as usual.
    document.addEventListener('touchmove', function (e) {
      if (!swipeWatch || e.touches.length !== 1) return;
      if (!swipeKill) {
        var dx = Math.abs(e.touches[0].clientX - swipeX);
        var dy = Math.abs(e.touches[0].clientY - swipeY);
        if (dy > 10 && dy >= dx) { swipeWatch = false; return; } // a scroll
        if (dx <= 10 || dx <= dy) return; // no clear direction yet
        swipeKill = true;
      }
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
  }

  // ---------------- Scroll position memory (app layout) ----------------
  // Each tab switch is a fresh document, so remember where you were per page
  // for this session and jump back there on return — in the installed app
  // and in the app layout in a phone's browser alike, since switching
  // pages from the bottom bar is the same thing in both. A link to a place
  // on a page (a #) goes there instead.
  // Restores can land late (the quest list renders after this script), and
  // that programmatic jump must not read as the user scrolling down.
  var scrollRestoredAt = 0;
  if (installed || document.documentElement.classList.contains('is-pwa')) {
    var SCROLL_KEY = 'scs2-scroll:' + window.location.pathname;
    var scrollRestored = false;
    var userScrolled = false;

    // The boot script hides the content (html.scroll-restoring) whenever a
    // position is saved for this page, so the top of the page never flashes
    // into view for a frame before a late restore lands.
    var revealContent = function () {
      document.documentElement.classList.remove('scroll-restoring');
    };
    ['touchstart', 'wheel', 'keydown'].forEach(function (ev) {
      window.addEventListener(ev, function () { userScrolled = true; revealContent(); }, { once: true, passive: true });
    });

    var restoreScroll = function () {
      if (scrollRestored || userScrolled) return;
      var saved = 0;
      try { saved = parseInt(sessionStorage.getItem(SCROLL_KEY), 10) || 0; } catch (e) { revealContent(); return; }
      if (saved <= 0) { scrollRestored = true; revealContent(); return; }
      var scroller = document.body;
      scrollRestoredAt = Date.now();
      scroller.scrollTop = saved;
      window.scrollTo(0, saved);
      if (Math.abs((scroller.scrollTop || window.scrollY) - saved) < 2) {
        scrollRestored = true;
        revealContent();
      }
    };

    if (window.location.hash) { scrollRestored = true; revealContent(); }
    restoreScroll();
    window.setTimeout(restoreScroll, 80);
    window.setTimeout(restoreScroll, 250);
    window.addEventListener('load', restoreScroll);
    // The quest list builds its list in a script that runs after this one,
    // and the load event waits for the map's library, which can come after
    // the deadline. A try at fixed moments fell between the two on a phone
    // and the list came back at the top: this tries again every time the
    // page changes height, which catches the list the moment it lands.
    var restoreMain = document.querySelector('main');
    if (restoreMain && typeof ResizeObserver === 'function' && !scrollRestored) {
      var restoreWatch = new ResizeObserver(function () {
        if (scrollRestored || userScrolled) { restoreWatch.disconnect(); return; }
        restoreScroll();
      });
      restoreWatch.observe(restoreMain);
    }
    // Deadline: if the page never grows tall enough (content still loading,
    // or it genuinely shrank), show it where it is rather than yank later.
    // The same 900ms the boot script gives the veil.
    window.setTimeout(function () { scrollRestored = true; revealContent(); }, 900);
    window.addEventListener('pageshow', function (e) {
      if (e.persisted) { scrollRestored = true; revealContent(); }
    });

    window.addEventListener('pagehide', function () {
      try {
        sessionStorage.setItem(SCROLL_KEY, String(Math.round(document.body.scrollTop || window.scrollY || 0)));
        // the next page animates its bar in only if the chrome was hidden here
        var hiddenAtExit = (exitChromeHidden !== null)
          ? exitChromeHidden
          : document.documentElement.classList.contains('nav-up');
        sessionStorage.setItem('scs2-chrome-hidden', hiddenAtExit ? '1' : '0');
      } catch (e) { /* storage unavailable */ }
    });
  }

  // ---------------- Light / dark theme toggle ----------------
  // The <head> boot script applies the saved (or system) theme before paint;
  // this wires the menu button and keeps the browser UI colour in sync.
  var THEME_KEY = 'scs2-theme';
  var themeBtn = document.querySelector('.theme-toggle');

  function syncThemeUi() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var meta = document.querySelector('meta[name="theme-color"]');
      // The bar follows the theme now, so the browser's own chrome has to
    // follow it as well. Read rather than written down twice: the
    // computed value of a custom property has its var() substituted, so
    // this is whatever --bar-bg resolved to for this theme.
    var bar = getComputedStyle(document.documentElement).getPropertyValue('--bar-bg').trim();
    if (meta) meta.setAttribute('content', bar || (dark ? '#1b1b1b' : '#ffffff'));
    if (themeBtn) {
      themeBtn.setAttribute('aria-pressed', dark ? 'true' : 'false');
      themeBtn.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
      var label = themeBtn.querySelector('.theme-toggle-label');
      if (label) label.textContent = dark ? 'Light mode' : 'Dark mode';
    }
  }

  var themeFadeTimer = null;

  function flipTheme() {
    var root = document.documentElement;
    var wasDark = root.getAttribute('data-theme') === 'dark';
    if (wasDark) root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', 'dark');
    try { localStorage.setItem(THEME_KEY, wasDark ? 'light' : 'dark'); } catch (e) { /* not persisted */ }
    syncThemeUi();
  }

  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var root = document.documentElement;
      if (window.scs.reducedMotion) { flipTheme(); return; }
      // A view transition cross-fades the whole rendering: the browser
      // snapshots the page as it stands, we flip the theme, and the old
      // picture dissolves into the new one. Everything changes on one
      // clock — icons, the map, images, the browser's own controls —
      // and no list of properties has to be kept up to date.
      if (document.startViewTransition) {
        var run = document.startViewTransition(flipTheme);
        // a transition the browser skips rejects this; that is not an error
        if (run && run.finished && run.finished.catch) run.finished.catch(function () { });
        return;
      }
      // Without one, every element eases its own colours for a beat and
      // the class comes off again. Close, but it cannot reach a canvas
      // or a native control, which is why it is the fallback.
      root.classList.add('theme-fading');
      window.clearTimeout(themeFadeTimer);
      themeFadeTimer = window.setTimeout(function () {
        root.classList.remove('theme-fading');
      }, window.scs.ms('--duration-fast', 250) + 80);
      flipTheme();
    });
  }
  // Nothing stored is the device's own setting, so the page keeps
  // following it while it is open, until the button is pressed.
  var darkQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  if (darkQuery) {
    var followDevice = function () {
      var stored = null;
      try { stored = localStorage.getItem(THEME_KEY); } catch (e) { /* nothing stored */ }
      if (stored === 'light' || stored === 'dark') return;
      if (darkQuery.matches) document.documentElement.setAttribute('data-theme', 'dark');
      else document.documentElement.removeAttribute('data-theme');
      syncThemeUi();
    };
    if (darkQuery.addEventListener) darkQuery.addEventListener('change', followDevice);
    else if (darkQuery.addListener) darkQuery.addListener(followDevice);
  }
  syncThemeUi();

  // The iOS haptics engine buzzes by clicking a hidden switch label, and
  // the browser forwards that as a click on its input, which even reports
  // as trusted. Menus must never treat those echoes as outside taps.
  var isHapticEcho = function (e) {
    return !!(e.target && e.target.closest && e.target.closest('label[for^="web-haptics"]'));
  };

  // ---------------- Back-gesture layers ----------------
  // Transient UI (menus, sheets, the full screen map, camera review)
  // owns one history entry apiece, so the system back gesture closes the
  // top layer instead of leaving the page. UI closes consume their entry
  // through history.back() to keep the stack honest. Menus that navigate
  // (burger, camera menu) stay out: their taps leave the page anyway.
  var backStack = [];
  var backPopping = false;

  var backClosing = 0;
  // Entries this page load pushed carry its mark: one left by an earlier
  // load of the page (a reload, a phone restoring the tab) sits under
  // every layer this load opens.
  var backMark = String(Date.now()) + Math.random().toString(36).slice(2);
  // the popstate a disarm's history.back() caused, for page code that
  // keeps history entries of its own
  var backOwnPop = null;
  function topOpenLayer() {
    for (var i = backStack.length - 1; i >= 0; i--) {
      if (backStack[i].open) return backStack[i];
    }
    return null;
  }
  window.scsBackLayer = {
    arm: function (closeFn) {
      var layer = { close: closeFn, open: true, href: location.href };
      backStack.push(layer);
      try {
        window.history.pushState({ scsLayer: backStack.length, scsMark: backMark }, '');
      } catch (e) { layer.noHistory = true; }
      return layer;
    },
    disarm: function (layer) {
      if (!layer || !layer.open) return;
      layer.open = false;
      if (layer.noHistory || backPopping) return;
      // the popstate that follows pops this now-dead entry; popping the
      // stack here too would eat the layer beneath
      if (backStack[backStack.length - 1] === layer) {
        backClosing++;
        window.history.back();
      }
      // closed out of order: the stale entry becomes one silent back press
    },
    // A layer that replaces another waits for the first one's pop.
    // disarm leaves a history.back() in flight and the stack pops on
    // the popstate, not on the call — so arming straight away puts the
    // new layer on top and that pop closes IT, which is how tapping
    // full screen with the drawer open opened the map and shut it again
    // in one gesture.
    after: function (fn) {
      if (!backClosing) return fn();
      var done = false;
      var go = function () {
        if (done) return;
        done = true;
        window.removeEventListener('popstate', go);
        fn();
      };
      window.addEventListener('popstate', go);
      // a browser that refused the pushState never pops
      window.setTimeout(go, 140);
    },
    // Only the top open layer answers a key: a keydown reaches every
    // listener, and the layer opened first hears it first.
    isTop: function (layer) {
      return !!layer && topOpenLayer() === layer;
    },
    isOpen: function () {
      return !!topOpenLayer();
    },
    ownPop: function (e) {
      return !!e && e === backOwnPop;
    }
  };

  // The history now stands on some entry: every layer above it closes,
  // the top one first. A step to an entry that is not one of this load's
  // layers (the page itself, an entry of the page's own, one left by an
  // earlier load) is below them all. A fragment link is a step to
  // another address rather than back out of the layers, and takes the
  // top one only.
  window.addEventListener('popstate', function (e) {
    backOwnPop = null;
    if (backClosing) { backClosing--; backOwnPop = e; }
    var st = e.state;
    var depth = 0;
    if (st && st.scsMark === backMark && typeof st.scsLayer === 'number') depth = st.scsLayer;
    else if (backStack.length && backStack[backStack.length - 1].href !== location.href) depth = backStack.length - 1;
    if (backStack.length <= depth) return;
    // taken off before any closes, so a layer armed by a close stays
    var above = backStack.splice(depth);
    var failed = null;
    for (var i = above.length - 1; i >= 0; i--) {
      var layer = above[i];
      if (!layer.open) continue;
      layer.open = false;
      backPopping = true;
      try { layer.close(); } catch (err) { failed = failed || err; } finally { backPopping = false; }
    }
    if (failed) throw failed;
  });

  // ---------------- The menu's way to the submit page ----------------
  // It says what a tap there is for: a team that is not signed in is
  // going there to sign in. The submit page and the gallery send
  // scs-session-changed when they sign a team in or out, and another
  // tab doing it arrives as a storage event.
  function submitLinkSignedIn() {
    try { return !!localStorage.getItem('scs2-submit-session'); } catch (err) { return false; }
  }
  function syncSubmitLink() {
    var signedIn = submitLinkSignedIn();
    // a page can leave out what only someone not yet signed up needs
    document.documentElement.classList.toggle('team-signed-in', signedIn);
    // the link carries both names and the class picks one, set before the
    // first paint by the page's boot script; a page from an older build
    // has the bare name
    [].forEach.call(document.querySelectorAll('.site-menu a'), function (a) {
      if (!/(^|\/)submit\/?$/.test(a.pathname || '')) return;
      if (a.querySelector('.menu-signin')) return;
      a.textContent = signedIn ? 'Submit a Quest' : 'Sign In';
    });
  }
  syncSubmitLink();
  document.addEventListener('scs-session-changed', syncSubmitLink);
  window.addEventListener('storage', function (e) {
    if (!e.key || e.key === 'scs2-submit-session') syncSubmitLink();
  });

  // ---------------- Settings menu ----------------
  var settingsBtn = document.querySelector('.settings-toggle');
  var settingsPanel = document.getElementById('site-settings');
  var setPanelOpen = function (open) {};
  var showSetPage = function (name, animate) {};
  if (settingsBtn && settingsPanel) {
    var settingsLayer = null;
    var settingsBackable = phoneish;
    var settingsCloseTimer = null;
    setPanelOpen = function (open) {
      if (open) {
        if (settingsCloseTimer) { clearTimeout(settingsCloseTimer); settingsCloseTimer = null; }
        settingsPanel.classList.remove('is-closing');
        document.documentElement.classList.remove('settings-closing');
        settingsPanel.classList.remove('is-hidden');
        // the panel was display:none, so anything laid over a control
        // inside it had no box to measure until now
        site.placeTapSwitches();
        settingsBtn.classList.add('is-open');
        settingsBtn.setAttribute('aria-expanded', 'true');
        // dims the page content behind the menu (the bars sit above the veil)
        document.documentElement.classList.add('settings-open');
        // the system back gesture closes the open menu on phones
        if (settingsBackable && !settingsLayer) {
          settingsLayer = window.scsBackLayer.arm(function () { setPanelOpen(false); });
        }
      } else {
        if (settingsLayer) {
          var layer = settingsLayer;
          settingsLayer = null;
          window.scsBackLayer.disarm(layer);
        }
        if (settingsPanel.classList.contains('is-hidden') || settingsCloseTimer) return;
        settingsBtn.classList.remove('is-open');
        settingsBtn.setAttribute('aria-expanded', 'false');
        // menu and veil ease out together before display:none lands
        settingsPanel.classList.add('is-closing');
        document.documentElement.classList.remove('settings-open');
        document.documentElement.classList.add('settings-closing');
        settingsCloseTimer = setTimeout(function () {
          settingsCloseTimer = null;
          settingsPanel.classList.remove('is-closing');
          settingsPanel.classList.add('is-hidden');
          document.documentElement.classList.remove('settings-closing');
          // back to the first page, so the gear always opens the same
          // menu rather than wherever it was last left
          showSetPage('main', false);
        }, 160);
      }
    };
    settingsBtn.addEventListener('click', function () {
      // a panel on its way out counts as closed, so tapping the gear
      // mid-close brings it back instead of re-closing it
      var want = settingsPanel.classList.contains('is-hidden') ||
        settingsPanel.classList.contains('is-closing');
      if (!want) { setPanelOpen(false); return; }
      window.scs.closePanels('settings');
      window.scsBackLayer.after(function () { setPanelOpen(true); });
    });

    // The menu's second page. Nine rows is more than a menu can hold
    // on a phone without scrolling, and the four that say how the site
    // looks are the four nobody opens the gear for. They moved behind
    // the Visual row; this is what walks between the two. The panel is
    // the window — one page leaves to the side while the next arrives
    // from the other, and the panel's own height is tweened between
    // them, because they are different lengths.
    var setMain = document.getElementById('set-page-main');
    var setVisual = document.getElementById('set-page-visual');
    var visualOpen = document.getElementById('set-visual-open');
    var visualBack = document.getElementById('set-visual-back');
    var pageTween = null;
    var pageTimer = 0;
    var pageDone = null;
    if (setMain && setVisual) {
      showSetPage = function (name, animate) {
        // a crossing still under way lands first, so the page asked for
        // is weighed against the one that is really showing
        if (pageTimer) {
          window.clearTimeout(pageTimer);
          pageTimer = 0;
          pageDone();
        }
        var to = name === 'visual' ? setVisual : setMain;
        var from = to === setMain ? setVisual : setMain;
        if (!to.hidden) return;
        if (visualOpen) visualOpen.setAttribute('aria-expanded', to === setVisual ? 'true' : 'false');
        if (pageTween) { pageTween.cancel(); pageTween = null; }
        from.classList.remove('is-leaving', 'is-arriving');
        to.classList.remove('is-leaving', 'is-arriving');
        if (!animate || window.scs.reducedMotion || !settingsPanel.animate) {
          from.hidden = true;
          to.hidden = false;
          site.placeTapSwitches();
          return;
        }
        var was = settingsPanel.getBoundingClientRect().height;
        settingsPanel.style.setProperty('--page-dir', to === setVisual ? '1' : '-1');
        // the leaving page comes out of the flow first, so what the
        // panel measures from here on is the arriving page's height
        from.classList.add('is-leaving');
        to.hidden = false;
        to.classList.add('is-arriving');
        var now = settingsPanel.getBoundingClientRect().height;
        var dur = window.scs.ms('--duration-fast', 250);
        if (Math.abs(now - was) > 1) {
          pageTween = settingsPanel.animate(
            [{ height: was + 'px' }, { height: now + 'px' }],
            { duration: dur, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
          );
          pageTween.onfinish = function () { pageTween = null; };
        }
        pageDone = function () {
          from.classList.remove('is-leaving');
          from.hidden = true;
          to.classList.remove('is-arriving');
          // the rows have moved, so the invisible switches laid over
          // them have to be measured onto their controls again
          site.placeTapSwitches();
        };
        pageTimer = window.setTimeout(function () {
          pageTimer = 0;
          pageDone();
        }, dur);
      };
      if (visualOpen) {
        visualOpen.addEventListener('click', function () { showSetPage('visual', true); });
      }
      if (visualBack) {
        visualBack.addEventListener('click', function () { showSetPage('main', true); });
      }
    }

    // App layout on a phone browser: on by default, off puts the
    // ordinary site chrome back. The class does the whole job, so the
    // switch takes effect on the spot.
    var appCheck = document.getElementById('set-app-layout');
    if (appCheck) {
      appCheck.checked = appLayoutWanted();
      appCheck.addEventListener('change', function () {
        try { localStorage.setItem(APP_LAYOUT_KEY, appCheck.checked ? '1' : '0'); } catch (err) { /* not persisted */ }
        syncAppLayout();
        // the ordinary chrome is spaced by its measured height, which
        // is only taken when it is the layout in use
        window.dispatchEvent(new Event('resize'));
      });
    }


    // Text size (rem-based layout scales from the root font size)
    var FONT_KEY = 'scs2-font-scale';
    // Stops rather than a fixed step: a third of the size and twice it
    // are both useful, and a step that reads as small at 100% is a
    // third of the whole thing at 33%. They bunch up around 100 where
    // most people stay. Every page's boot script clamps to the same
    // 33-200, so widening this means widening those too.
    var FONT_STOPS = [33, 50, 67, 80, 90, 100, 110, 125, 150, 175, 200];
    var fontVal = document.getElementById('set-font-val');
    var snapScale = function (v) {
      var best = 100;
      var gap = Infinity;
      for (var i = 0; i < FONT_STOPS.length; i++) {
        var d = Math.abs(FONT_STOPS[i] - v);
        if (d < gap) { gap = d; best = FONT_STOPS[i]; }
      }
      return best;
    };
    var readScale = function () {
      var v = parseInt(String(document.documentElement.style.fontSize || '100').replace('%', ''), 10);
      // a size stored before the stops existed lands on the nearest one
      return v >= 33 && v <= 200 ? snapScale(v) : 100;
    };
    var fontDec = document.getElementById('set-font-dec');
    var fontInc = document.getElementById('set-font-inc');
    // the size on the row's line, and the end of the ladder greyed: a
    // press past it did nothing before, and now looks like it
    var showScale = function (v) {
      if (fontVal) fontVal.textContent = v + '%';
      if (fontDec) fontDec.disabled = v === FONT_STOPS[0];
      if (fontInc) fontInc.disabled = v === FONT_STOPS[FONT_STOPS.length - 1];
    };
    var applyScale = function (v) {
      v = snapScale(v);
      document.documentElement.style.fontSize = (v === 100) ? '' : v + '%';
      showScale(v);
      try { localStorage.setItem(FONT_KEY, String(v)); } catch (err) { /* not persisted */ }
      window.dispatchEvent(new Event('resize'));
    };
    showScale(readScale());
    var stepScale = function (dir) {
      var at = FONT_STOPS.indexOf(readScale());
      applyScale(FONT_STOPS[Math.max(0, Math.min(FONT_STOPS.length - 1, at + dir))]);
    };
    if (fontDec) fontDec.addEventListener('click', function () { stepScale(-1); });
    if (fontInc) fontInc.addEventListener('click', function () { stepScale(1); });
  }

  // Set by menu clicks so the recorded exit state survives the wake-up
  // (a tab tapped while hidden should still animate the next page's bar in).
  var exitChromeHidden = null;

  // Real taps outside the settings menu close it; Escape does too. The
  // iOS haptics engine's echoed clicks never count as outside taps.
  document.addEventListener('click', function (e) {
    if (!e.isTrusted || isHapticEcho(e)) return;
    // A tap on one of the invisible haptic switches belongs to the
    // control it covers: without this the gear's own switch would open
    // the menu and then count as a tap outside it, shutting it again.
    var hit = site.hapticHost(e.target);
    if (settingsPanel && !settingsPanel.classList.contains('is-hidden') &&
        !settingsPanel.contains(hit) && !settingsBtn.contains(hit)) {
      setPanelOpen(false);
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented || !settingsPanel) return;
    if (settingsPanel.classList.contains('is-hidden') || settingsPanel.classList.contains('is-closing')) return;
    if (settingsLayer && !window.scsBackLayer.isTop(settingsLayer)) return;
    e.preventDefault();
    setPanelOpen(false);
  });

  // One panel at a time. The settings menu and a page's own panel — the
  // quest list's filters — both dim the page and both take the back
  // gesture, and having two of them up at once is a stack nobody asked
  // for. Whichever is opening says so, closes the other, and waits for
  // the pop that closing leaves in flight before arming its own layer.
  window.scs.closePanels = function (except) {
    if (except !== 'settings') setPanelOpen(false);
    document.dispatchEvent(new CustomEvent('scs-close-panels',
      { detail: { except: except || '' } }));
  };

  // ---------------- Scroll-linked chrome (app + mobile web) ----------------
  // The top bar slides away on downward scroll and returns on an ordinary upward
  // scroll (or near the top), like the X mobile app. The Season 1 archive
  // page keeps its bar (its nav carries site-nav--static).
  if (phoneish) {
    var appScroller = document.body;
    var appNav = document.querySelector('.site-nav');
    var navAutoHide = !!(appNav && !appNav.classList.contains('site-nav--static'));
    var lastScrollY = appScroller.scrollTop;
    var lastScrollT = Date.now();
    var downRun = 0;

    // The bottom bar fades with html.nav-up (pure CSS),
    // so hiding the top bar dims the rest of the chrome in one state.
    var onAppScroll = function () {
      var now = Date.now();
      var maxY = appScroller.scrollHeight - appScroller.clientHeight;
      var y = Math.max(0, Math.min(appScroller.scrollTop, maxY));
      // A freshly restored position arrives as one big jump — swallow it.
      if (now - scrollRestoredAt < 400) {
        lastScrollY = y;
        lastScrollT = now;
        downRun = 0;
        return;
      }
      var delta = y - lastScrollY;
      var dt = Math.max(now - lastScrollT, 1);
      lastScrollT = now;
      lastScrollY = y;
      if (delta === 0) return;

      if (!navAutoHide) return;
      // An open menu pins the whole chrome awake: scrolling neither hides
      // the bars nor dismisses the menu. Tapping the page, the button, or
      // Escape is what closes it.
      if (settingsPanel && !settingsPanel.classList.contains('is-hidden')) return;
      // on the web the full bar scrolls away with the page instead, and
      // near the top syncFloatNav decides which bar shows
      if (!document.documentElement.classList.contains('is-pwa')) {
        if (!document.documentElement.classList.contains('nav-float')) { downRun = 0; return; }
        // within the full bar's height syncFloatNav has the bar
        if (y <= fullNavHeight()) return;
      }
      if (y < 64) {
        document.documentElement.classList.remove('nav-up');
        downRun = 0;
        return;
      }
      if (delta > 0) {
        downRun += delta;
        if (downRun > 28) document.documentElement.classList.add('nav-up');
      } else {
        downRun = 0;
        // an ordinary upward scroll brings the chrome back (slow drifts don't)
        if ((-delta / dt) > 0.9) document.documentElement.classList.remove('nav-up');
      }
    };
    appScroller.addEventListener('scroll', onAppScroll, { passive: true });

    // ---- what colour the cutout cover is ----
    // The band under the notch (html.is-pwa::after) is only there to stop
    // the page scrolling up into the strip once the bar has gone, so it
    // has to be the colour of whatever is behind it. Written down it is
    // wrong on any page with a full-bleed black object at the top: the
    // home page's board is under the notch for its whole first screen,
    // and the page's own paper painted across it was a pale band on the
    // black — white in the light theme, grey in the dark one.
    // It asks the page instead. Only while the bar is away, because
    // that is the only time the band is drawn, and only when the answer
    // changes, so the ordinary case is one hit test and no style write.
    var cutoutWas = '';
    var cutoutTick = 0;
    var readCutout = function () {
      if (!document.documentElement.classList.contains('nav-up')) return;
      // the bar's own top padding IS env(safe-area-inset-top), which is
      // the band's height and is not readable any other way
      var bar = document.querySelector('.site-nav');
      var inset = bar ? (parseFloat(window.getComputedStyle(bar).paddingTop) || 0) : 0;
      var el = document.elementFromPoint(Math.round(window.innerWidth / 2), inset + 2);
      var bg = '';
      for (var n = el; n && n !== document.documentElement; n = n.parentElement) {
        var c = window.getComputedStyle(n).backgroundColor;
        if (c && c !== 'transparent' && c.indexOf('rgba(0, 0, 0, 0)') === -1) { bg = c; break; }
      }
      if (bg === cutoutWas) return;
      cutoutWas = bg;
      if (bg) document.documentElement.style.setProperty('--cutout-bg', bg);
      else document.documentElement.style.removeProperty('--cutout-bg');
    };
    appScroller.addEventListener('scroll', function () {
      if (cutoutTick) return;
      cutoutTick = window.requestAnimationFrame(function () {
        cutoutTick = 0;
        readCutout();
      });
    }, { passive: true });

    // Tapping a navigating link (bottom bar or camera menu) while the
    // chrome is dimmed snaps the bar solid instantly (no fade) but leaves
    // the top bar parked up: the destination page plays the one entrance
    // animation, instead of this page starting a slide the next page
    // would restart from the top.
    var tabBarEl = document.querySelector('.tab-bar');
    var wakeForNav = function () {
      if (exitChromeHidden === null) {
        exitChromeHidden = document.documentElement.classList.contains('nav-up');
      }
      downRun = 0;
      if (!document.documentElement.classList.contains('nav-up')) return;
      if (tabBarEl) {
        tabBarEl.style.transition = 'none';
        tabBarEl.style.opacity = '1';
      }
      // A tab tap always navigates; if that somehow falls through, wake
      // the chrome normally (and forget the exit snapshot) so the page
      // is not left half dimmed.
      var fallback = window.setTimeout(function () {
        document.documentElement.classList.remove('nav-up');
        if (tabBarEl) { tabBarEl.style.transition = ''; tabBarEl.style.opacity = ''; }
        exitChromeHidden = null;
      }, 800);
      window.addEventListener('pagehide', function () { window.clearTimeout(fallback); }, { once: true });
    };
    Array.prototype.forEach.call(document.querySelectorAll('.tab-bar a'), function (el) {
      el.addEventListener('click', wakeForNav);
    });

    // Pages resurrected from the back-forward cache would otherwise keep
    // the held state from their last unload — land them fully active.
    window.addEventListener('pageshow', function (e) {
      if (!e.persisted) return;
      document.documentElement.classList.remove('nav-up');
      if (tabBarEl) { tabBarEl.style.transition = ''; tabBarEl.style.opacity = ''; }
      exitChromeHidden = null;
      downRun = 0;
      lastScrollY = appScroller.scrollTop;
    });
  }

  // ---------------- The on-screen keyboard ----------------
  // A phone's keyboard takes the bottom of the screen, and the app's own
  // bar was left sitting in the gap between it and the field being typed
  // into — a row of places to go, in the way, while somebody is typing.
  // It goes while a text field has focus, and the floating search drops
  // into the space it leaves.
  //
  // What the browser does with the viewport differs, so both are
  // covered. The installed app and Android resize the view, which puts
  // a fixed bottom above the keyboard already; Safari in a tab leaves
  // the layout viewport at its full height and lays the keyboard over
  // it, so --kb-inset is how much of it is covered and everything
  // pinned to the bottom adds that. Where the view was resized it is 0.
  var vview = window.visualViewport;
  var KB_TYPES = /^(text|search|email|tel|url|number|password)$/;
  var takesKeyboard = function (el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && KB_TYPES.test(String(el.type || 'text').toLowerCase());
  };
  var syncKeyboard = function () {
    var up = phoneish && takesKeyboard(document.activeElement);
    document.documentElement.classList.toggle('kb-up', up);
    var inset = 0;
    if (up && vview) inset = Math.round(window.innerHeight - (vview.height + vview.offsetTop));
    document.documentElement.style.setProperty('--kb-inset', (inset > 0 ? inset : 0) + 'px');
  };
  document.addEventListener('focusin', syncKeyboard);
  // a beat, so moving between two fields of the same form does not
  // flash the bar back in between them
  document.addEventListener('focusout', function () { window.setTimeout(syncKeyboard, 80); });
  if (vview) {
    vview.addEventListener('resize', syncKeyboard);
    vview.addEventListener('scroll', syncKeyboard);
  }

  // ---------------- Pop-up notifications (toasts) ----------------
  // Square dark pop-ups in the elevation-maker tooltip style, dropping
  // in under the top bar and fading back up.
  // Usage from any page script: window.scsToast('Message');
  window.scsToast = function (message) {
    var stack = document.querySelector('.toast-stack');
    if (!stack) {
      stack = document.createElement('div');
      stack.className = 'toast-stack';
      document.body.appendChild(stack);
    }
    var toast = document.createElement('div');
    toast.className = 'toast';
    toast.setAttribute('role', 'status');
    toast.textContent = message;
    stack.appendChild(toast);
    while (stack.children.length > 3) stack.removeChild(stack.firstChild);
    // the pre-state has to paint once before the rise can transition
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () { toast.classList.add('is-open'); });
    });
    window.setTimeout(function () {
      toast.classList.remove('is-open');
      window.setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, window.scs.ms('--toast-close', 250));
    }, 2600);
  };

  // ---------------- Install nudge (mobile web) ----------------
  // One gentle pointer per session that the site works as a real app.
  // "Don't show again" sticks for good. A page marked data-no-install
  // (the ticket, which is held up to a scanner) never shows it.
  (function () {
    if (!phoneish || installed) return; // in the app already
    if (document.body && document.body.hasAttribute('data-no-install')) return;
    try {
      if (localStorage.getItem('scs2-install-dismissed') === '1') return;
      if (sessionStorage.getItem('scs2-install-nudged') === '1') return;
    } catch (e) { return; }
    var isApple = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    // the iPhone line carries Safari's two icons, drawn by pushSub.paint
    var how = isApple
      ? 'Tap Share [share], then Add to Home Screen [add].'
      : 'Open the website in Chrome, then install the app from the menu and tap Install app.';
    var card = document.createElement('div');
    card.className = 'install-nudge';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Install the app');
    // The page's own shape: the name on a black sign bar, the reason on
    // the paper under it. The one line of instruction stays — a link is
    // a second step and most people only need the one sentence — with
    // the full walkthrough on the event info page behind it.
    card.innerHTML =
      '<p class="install-nudge-head sign-bar">Install SCS.2 App</p>' +
      '<div class="install-nudge-body">' +
      '<p class="install-nudge-why"></p>' +
      '<p class="install-nudge-more"><a href="' + sitePath('info/') + '#install">How to install it</a></p>' +
      '<div class="install-nudge-row">' +
      '<button type="button" class="install-nudge-never">Don’t show again</button>' +
      '<button type="button" class="install-nudge-later">Not now</button>' +
      '</div>' +
      '</div>';
    var nudgeLayer = null;
    var nudgeClosed = false;
    var closeNudge = function (forever, viaBack) {
      if (nudgeClosed) return;
      nudgeClosed = true;
      if (forever) {
        try { localStorage.setItem('scs2-install-dismissed', '1'); } catch (e) { /* not persisted */ }
      }
      card.classList.remove('is-open');
      window.setTimeout(function () {
        if (card.parentNode) card.parentNode.removeChild(card);
      }, window.scs.ms('--duration-medium', 350));
      if (!viaBack && nudgeLayer) window.scsBackLayer.disarm(nudgeLayer);
      nudgeLayer = null;
    };
    window.scs.pushSub.paint(card.querySelector('.install-nudge-why'), 'You can install the SCS.2 website as an app. This will enable offline mode and push notifications. ' + how);
    card.querySelector('.install-nudge-never').addEventListener('click', function () { closeNudge(true); });
    card.querySelector('.install-nudge-later').addEventListener('click', function () { closeNudge(false); });
    window.setTimeout(function () {
      // spent only once it has been shown
      try { sessionStorage.setItem('scs2-install-nudged', '1'); } catch (e) { /* asks again next page */ }
      document.body.appendChild(card);
      window.scsBackLayer.after(function () {
        if (!nudgeClosed) nudgeLayer = window.scsBackLayer.arm(function () { closeNudge(false, true); });
      });
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(function () { card.classList.add('is-open'); });
      });
    }, 1200);
  })();

  // ---------------- Mobile nav toggle ----------------
  // The menu is display:none until opened, so its height is measured
  // once shown and the bar grows to fit (the rows rise in via CSS);
  // closing runs the same tween backwards on the quick clock.
  var toggle = document.querySelector('.site-nav-toggle');
  var menu = document.getElementById('site-menu');
  var menuTween = null;
  var setMenuOpen = function (open) {
    if (menuTween) { menuTween.cancel(); menuTween = null; }
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    var animate = !window.scs.reducedMotion && typeof menu.animate === 'function';
    if (open) {
      menu.classList.remove('is-closing');
      menu.classList.add('is-open');
      if (!animate) return;
      var cs = getComputedStyle(menu);
      var frames = [
        { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', opacity: 0 },
        { height: menu.offsetHeight + 'px', paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, marginTop: cs.marginTop, opacity: 1 }
      ];
      menu.style.overflow = 'hidden';
      menuTween = menu.animate(frames, { duration: window.scs.ms('--duration-fast', 250), easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      menuTween.onfinish = function () { menu.style.overflow = ''; menuTween = null; };
    } else {
      if (!menu.classList.contains('is-open')) return;
      var finish = function () {
        menu.style.overflow = '';
        menu.classList.remove('is-open', 'is-closing');
        menuTween = null;
        if (typeof syncChromePad === 'function') syncChromePad();
      };
      if (!animate) { finish(); return; }
      var from = getComputedStyle(menu);
      menu.classList.add('is-closing');
      menu.style.overflow = 'hidden';
      menuTween = menu.animate([
        { height: menu.offsetHeight + 'px', paddingTop: from.paddingTop, paddingBottom: from.paddingBottom, marginTop: from.marginTop, opacity: 1 },
        { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', opacity: 0 }
      ], { duration: window.scs.ms('--duration-quick', 150), easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      menuTween.onfinish = finish;
    }
  };
  if (toggle && menu) {
    toggle.addEventListener('click', function () {
      var open = !(menu.classList.contains('is-open') && !menu.classList.contains('is-closing'));
      if (open) window.scs.closePanels('menu');
      setMenuOpen(open);
    });
    // the settings menu opening folds this one away as it comes down
    document.addEventListener('scs-close-panels', function (e) {
      if (!e.detail || e.detail.except !== 'menu') setMenuOpen(false);
    });
  }

  // ---------------- The app bar's title ----------------
  // In the app layout the bar reads the page's name instead of the
  // brand. The name is already in the markup on both sides, so the bar
  // is right at first paint and nothing here runs for a page whose
  // title never changes. The team page is the one that fills its title
  // in after the tab answers, so the bar follows its h1.
  (function () {
    var barName = document.querySelector('.site-brand-page');
    var pageName = document.querySelector('main h1.app-titled');
    if (!barName || !pageName || typeof MutationObserver !== 'function') return;
    var follow = function () {
      var text = (pageName.textContent || '').trim();
      if (text && text !== barName.textContent) barName.textContent = text;
    };
    new MutationObserver(follow).observe(pageName, {
      childList: true, characterData: true, subtree: true
    });
  })();
  // The name is a title in the app layout and not a link home, which the
  // bottom bar has. The stylesheet lets a tap through it; this stops a
  // key press on it.
  (function () {
    var brand = document.querySelector('.site-brand');
    if (!brand || !window.matchMedia) return;
    var narrow = window.matchMedia('(max-width: 840px)');
    brand.addEventListener('click', function (e) {
      if (document.documentElement.classList.contains('is-pwa') && narrow.matches) e.preventDefault();
    });
  })();

  // ---------------- Fixed chrome spacing (web) ----------------
  // The bar and the footer sit outside the body scroller so the bounce
  // cannot drag them; the content is spaced by their real heights, which
  // the text size setting and the viewport width both change. The
  // installed app sizes its chrome in CSS, and the Season 1 archive
  // keeps its in-flow bar. A browser tab measures either way, since the
  // app layout can be switched off without reloading and the ordinary
  // chrome needs its numbers the moment it comes back.
  // The bottom bar's height is its content and follows the text size;
  // it carries the safe area in its own padding.
  // A row fixed under the app bar (.app-pin: the quest list's chips, the
  // submit page's Submit/Compress row) is out of the page's flow there,
  // so the page makes room for it with its own top padding, --pin-h.
  // Its height follows the text size and, on the quest list, the chips
  // arriving with the list, so it is watched rather than read once. The
  // chips also travel into the full-screen map's search panel, and
  // their height there is that panel's business, not the page's.
  var pinRow = document.querySelector('main > .app-pin');
  if (pinRow) {
    var pinHome = pinRow.parentNode;
    pinHome.classList.add('has-app-pin');
    var syncPin = function () {
      if (pinRow.parentNode !== pinHome) return;
      var h = pinRow.offsetHeight;
      if (h) document.documentElement.style.setProperty('--pin-h', h + 'px');
    };
    syncPin();
    if (typeof ResizeObserver === 'function') new ResizeObserver(syncPin).observe(pinRow);
    window.addEventListener('resize', syncPin);
  }

  // what site.css reads with :has(), as classes for Safari before 15.4
  var backLink = document.querySelector('.site-nav .back-toggle');
  if (backLink) backLink.closest('.site-nav').classList.add('has-back');
  if (document.querySelector('body > .site-footer')) document.body.classList.add('has-footer');

  var tabBar = document.querySelector('.tab-bar');
  if (tabBar) {
    var syncBarH = function () {
      var h = tabBar.offsetHeight;
      if (h) document.documentElement.style.setProperty('--tabbar-h', h + 'px');
    };
    syncBarH();
    window.addEventListener('resize', syncBarH);
    window.addEventListener('load', syncBarH);
    // a turn is not one resize — the same lesson as the chrome above
    window.addEventListener('orientationchange', function () {
      window.setTimeout(syncBarH, 120);
      window.setTimeout(syncBarH, 450);
    });
  }

  // The body is the scroller, so its scrollbar is inside the body and
  // the fixed top bar was drawn across the top of it. The bar stops
  // where the scrollbar starts (--sbw).
  (function () {
    var body = document.body;
    var last = -1;
    var sync = function () {
      var w = Math.max(0, body.offsetWidth - body.clientWidth);
      if (w === last) return;
      last = w;
      document.documentElement.style.setProperty('--sbw', w + 'px');
    };
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('load', sync);
    if (typeof ResizeObserver === 'function') new ResizeObserver(sync).observe(body);
  })();

  var padNav = document.querySelector('.site-nav:not(.site-nav--static)');
  var pinFooter = document.querySelector('body > .site-footer');
  // a change asked for while the bar could not be measured, taken once
  // the full bar is back
  var padStale = false;
  if (padNav) {
    var syncChromePad = function () {
      // an open menu grows the bar, and the floating bar is not the full one
      if ((menu && menu.classList.contains('is-open')) || root.classList.contains('nav-float')) {
        padStale = true;
        return;
      }
      padStale = false;
      // the installed app's own bar is sized in CSS
      if (installed && root.classList.contains('is-pwa')) {
        root.style.removeProperty('--nav-h');
        root.style.removeProperty('--footer-h');
        return;
      }
      document.documentElement.style.setProperty('--nav-h', padNav.offsetHeight + 'px');
      if (pinFooter) {
        document.documentElement.style.setProperty('--footer-h', pinFooter.offsetHeight + 'px');
      }
    };
    syncChromePad();
    window.addEventListener('resize', syncChromePad);
    window.addEventListener('load', syncChromePad);
    // Turning a phone is not one resize. iOS fires it partway
    // through the rotation, and Safari's own bars — one row or two,
    // depending on which way round it is — settle after that, so
    // the height measured during the turn is not the height the bar
    // ends up at, and the content was left spaced for the old one.
    // Measure again once it has landed.
    window.addEventListener('orientationchange', function () {
      window.setTimeout(syncChromePad, 120);
      window.setTimeout(syncChromePad, 450);
    });
    if (toggle) toggle.addEventListener('click', function () { window.setTimeout(syncChromePad, 0); });
  }
  site.afterLayout = function () {
    if (syncChromePad) syncChromePad();
    syncThemeUi();
  };

  // ---------------- The web's top bar: full, then floating ----------------
  // At the top of a page the bar is the full one, and it scrolls away
  // with the page (--nav-scroll). Once it has gone a floating bar takes
  // its place (html.nav-float): dropped in at once on a computer; on a
  // phone hidden while the page goes down (html.nav-up, below) and
  // dropped in when it comes back up. Back at the very top the floating
  // bar widens into the full one. The installed app keeps its own bar.
  var floatScroller = document.body;
  var floatLastY = floatScroller.scrollTop;
  var floatTick = 0;
  var fullNavHeight = function () {
    return parseFloat(window.getComputedStyle(root).getPropertyValue('--nav-h')) || (padNav ? padNav.offsetHeight : 65);
  };
  var syncFloatNav = function () {
    floatTick = 0;
    if (!padNav || root.classList.contains('is-pwa')) {
      if (root.classList.contains('nav-float')) root.classList.remove('nav-float');
      root.style.removeProperty('--nav-scroll');
      return;
    }
    // an open menu pins the bar where it is
    if ((settingsPanel && !settingsPanel.classList.contains('is-hidden')) ||
        (menu && menu.classList.contains('is-open'))) return;
    var y = Math.max(0, floatScroller.scrollTop);
    var down = y > floatLastY;
    floatLastY = y;
    var h = fullNavHeight();
    var floating = root.classList.contains('nav-float');
    if (!floating && y > h) {
      if (phoneish && down) root.classList.add('nav-up');
      root.classList.add('nav-float');
    } else if (floating && (y <= 0 || (y <= h && root.classList.contains('nav-up')))) {
      root.classList.remove('nav-float', 'nav-up');
      // measured once its padding has finished widening back
      if (padStale && syncChromePad) window.setTimeout(syncChromePad, window.scs.ms('--duration-fast', 250) + 50);
    }
    root.style.setProperty('--nav-scroll', Math.min(y, h) + 'px');
  };
  floatScroller.addEventListener('scroll', function () {
    if (!floatTick) floatTick = window.requestAnimationFrame(syncFloatNav);
  }, { passive: true });
  syncFloatNav();

  // for the parts after this one
  site.themeBtn = themeBtn;
  site.isHapticEcho = isHapticEcho;
  site.settingsBtn = settingsBtn;
});
