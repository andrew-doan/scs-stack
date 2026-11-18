// The site's shared script, part four of five: slide to confirm, leaving a
// busy page, the loading bar, the bottom bar's taps and haptics.
(window.scsSite = window.scsSite || { parts: [] }).parts.push(function (site) {
  'use strict';

  // from the parts before this one
  var root = site.root;
  var DATES_KEY = site.DATES_KEY;
  var CLOCK_KEY = site.CLOCK_KEY;
  var handheld = site.handheld;
  var themeBtn = site.themeBtn;
  var isHapticEcho = site.isHapticEcho;
  var settingsBtn = site.settingsBtn;

  // functions the other parts call
  site.leaveReason = leaveReason;
  site.askBeforeLeaving = askBeforeLeaving;
  site.creepOn = creepOn;
  site.hapticHost = hapticHost;
  site.placeTapSwitches = placeTapSwitches;

  // ---------------- Slide to confirm ----------------
  // Some things must not happen by accident: a wet screen taps on its
  // own, and one stray tap should not clear a day of ticks or throw
  // away a video half way through being compressed. Those take two
  // deliberate steps — a thumb slid the whole way across and RELEASED
  // at the far end (letting go anywhere earlier, or after sliding back,
  // does nothing), then a plain button on a second panel.
  //
  //   window.scs.confirmSlide({
  //     title:        'Clear all ticked-off quests?',
  //     slideLabel:   'Slide to clear',
  //     confirmTitle: 'Last check',
  //     confirmCopy:  'This clears all 12 ticked-off quests on this device.',
  //     confirmLabel: 'Clear progress',
  //     cancelLabel:  'Cancel',
  //     onConfirm: function () { … },   // the second panel's button
  //     onCancel:  function () { … }    // optional
  //   });
  //
  // Every value has a default, so a caller need only pass what it has
  // something to say about. It returns { close: fn } for a caller that
  // has to take the panel away itself. Any dismissal that is not the
  // confirm — Cancel, Escape, the ground around the card, the system
  // back gesture — runs onCancel once and nothing else.
  var SLIDE_ARROW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>';
  var SLIDE_ARMED = 0.92; // how much of the run counts as the far end

  // The panel is modal, so there is never a right time for a second one
  // behind it: whoever answers the one on screen finds another waiting
  // and has to slide the whole way again. A caller that asks while one
  // is up gets a handle that does nothing, which is what its close()
  // should do when it never opened anything.
  var confirmOpen = false;

  window.scs.confirmSlide = function (opts) {
    if (confirmOpen) return { close: function () {} };
    confirmOpen = true;
    opts = opts || {};
    var slideLabel = opts.slideLabel || 'Slide to confirm';
    var cancelLabel = opts.cancelLabel || 'Cancel';

    var overlay = document.createElement('div');
    overlay.className = 'confirm-overlay';
    var card = document.createElement('div');
    card.className = 'confirm-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', opts.title || 'Confirm');
    overlay.appendChild(card);

    var layer = null;
    var closed = false;
    var confirmed = false;
    var openedAt = Date.now();

    function close(viaBack) {
      if (closed) return;
      closed = true;
      confirmOpen = false;
      document.removeEventListener('keydown', onKey);
      overlay.classList.remove('is-open');
      window.setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, window.scs.ms('--duration-fast', 250) + 40);
      if (!viaBack && layer && window.scsBackLayer) window.scsBackLayer.disarm(layer);
      if (!confirmed && typeof opts.onCancel === 'function') opts.onCancel();
    }
    function onKey(e) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (layer && !window.scsBackLayer.isTop(layer)) return;
      e.preventDefault();
      close(false);
    }
    overlay.addEventListener('click', function (e) {
      if (e.target !== overlay) return;
      // The tap that opened this sends its click a moment later, and it
      // lands on the ground the card is sitting on. The first breath
      // ignores the ground, so the panel cannot close itself.
      if (Date.now() - openedAt < 400) return;
      close(false);
    });
    document.addEventListener('keydown', onKey);
    if (window.scsBackLayer) layer = window.scsBackLayer.arm(function () { close(true); });

    // The frame both panels share: the question on the card's sign bar,
    // the copy under it, and a row of actions at the foot.
    function panel(titleText, copyText) {
      card.textContent = '';
      var title = document.createElement('h2');
      title.className = 'confirm-title sign-bar';
      title.textContent = titleText;
      var body = document.createElement('div');
      body.className = 'confirm-body';
      if (copyText) {
        var copy = document.createElement('p');
        copy.className = 'confirm-copy';
        copy.textContent = copyText;
        body.appendChild(copy);
      }
      var actions = document.createElement('div');
      actions.className = 'confirm-actions';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn';
      cancel.textContent = cancelLabel;
      cancel.addEventListener('click', function () { close(false); });
      actions.appendChild(cancel);
      body.appendChild(actions);
      card.appendChild(title);
      card.appendChild(body);
      return { body: body, actions: actions, cancel: cancel };
    }

    // Step one becomes step two in the same card. It used to be an
    // outright replacement — the contents wiped and rebuilt — so the
    // box jumped from one height to the other with nothing to follow,
    // which is the one moment in the flow where the reader has to look
    // again to work out what changed. The card tweens between the two
    // heights while the arriving panel raises itself out of a blur,
    // both on the same clock. The height it is going to is only known
    // once the new panel is in, which is why this is here rather than
    // in the stylesheet.
    function step(build) {
      var from = card.offsetHeight;
      build();
      if (window.scs.reducedMotion || !card.animate) return;
      var to = card.offsetHeight;
      card.classList.add('is-stepping');
      var dur = window.scs.ms('--duration-fast', 250);
      var run = card.animate(
        [{ height: from + 'px' }, { height: to + 'px' }],
        { duration: dur, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' }
      );
      var done = function () { card.classList.remove('is-stepping'); };
      if (run && run.finished && run.finished.then) run.finished.then(done, done);
      else window.setTimeout(done, dur + 40);
    }

    // step 2: a plain button, now that the slide has said it was meant
    function confirmStep() { step(buildConfirm); }

    function buildConfirm() {
      var parts = panel(opts.confirmTitle || 'Last check', opts.confirmCopy || '');
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'btn btn-danger';
      go.textContent = opts.confirmLabel || 'Confirm';
      go.addEventListener('click', function () {
        confirmed = true;
        close(false);
        if (typeof opts.onConfirm === 'function') opts.onConfirm();
      });
      parts.actions.appendChild(go);
      parts.cancel.focus(); // a stray key press must land on the safe answer
    }

    // step 1: the slide
    function slideStep() {
      var parts = panel(opts.title || '', opts.copy || '');
      var track = document.createElement('div');
      track.className = 'confirm-slide';
      var label = document.createElement('span');
      label.className = 'confirm-slide-label';
      label.textContent = slideLabel;
      var thumb = document.createElement('button');
      thumb.type = 'button';
      thumb.className = 'confirm-slide-thumb';
      thumb.setAttribute('aria-label', slideLabel +
        '. Hold and drag to the right, or press the right arrow key.');
      thumb.innerHTML = SLIDE_ARROW;
      track.appendChild(label);
      track.appendChild(thumb);
      parts.body.insertBefore(track, parts.actions);

      // Only where the thumb sits when the finger LIFTS decides: past
      // the arm line goes on to step 2, anywhere else eases home.
      // Sliding across and back before letting go decides nothing.
      var sliding = null; // pointer x at grab, thumb x at grab
      var thumbX = 0;
      function slideMax() { return Math.max(1, track.clientWidth - thumb.offsetWidth - 6); }
      function paintSlide() {
        thumb.style.transform = 'translateX(' + thumbX + 'px)';
        var frac = thumbX / slideMax();
        label.style.opacity = String(Math.max(0, 1 - frac * 1.6));
        var armed = frac >= SLIDE_ARMED;
        if (armed !== thumb.classList.contains('is-armed')) {
          thumb.classList.toggle('is-armed', armed);
          if (armed && window.scsHaptic) window.scsHaptic('light');
        }
      }
      function releaseSlide() {
        if (sliding === null) return;
        sliding = null;
        if (thumbX / slideMax() >= SLIDE_ARMED) { confirmStep(); return; }
        thumb.classList.add('is-settling');
        thumbX = 0;
        paintSlide();
        window.setTimeout(function () {
          thumb.classList.remove('is-settling');
        }, window.scs.ms('--duration-fast', 250) + 40);
      }
      thumb.addEventListener('pointerdown', function (e) {
        e.preventDefault();
        sliding = { px: e.clientX, tx: thumbX };
        thumb.classList.remove('is-settling');
        try { thumb.setPointerCapture(e.pointerId); } catch (err) { /* synthetic pointer */ }
      });
      thumb.addEventListener('pointermove', function (e) {
        if (sliding === null) return;
        thumbX = Math.max(0, Math.min(slideMax(), sliding.tx + (e.clientX - sliding.px)));
        paintSlide();
      });
      thumb.addEventListener('pointerup', releaseSlide);
      thumb.addEventListener('pointercancel', releaseSlide);
      // keyboard: the arrow keys walk the thumb; the far end confirms
      thumb.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        e.preventDefault();
        thumbX = Math.max(0, Math.min(slideMax(), thumbX + (e.key === 'ArrowRight' ? 1 : -1) * slideMax() / 10));
        paintSlide();
        if (thumbX >= slideMax() - 0.5) confirmStep();
      });
    }

    slideStep();
    document.body.appendChild(overlay);
    if (window.scs.reducedMotion) overlay.classList.add('is-open');
    else window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () { overlay.classList.add('is-open'); });
    });
    return { close: function () { close(false); } };
  };

  // ---------------- Leaving a page that is busy ----------------
  // A page with work in flight says so before a link takes the reader
  // off it:
  //
  //   window.scs.guardLeaving(function () {
  //     return busy ? 'Compressing a video.' : '';   // '' or null lets them go
  //   });
  //
  // While the function returns a reason, a click on any link that would
  // leave the page opens the slide-to-confirm above instead, and the
  // page only changes once the reader has slid across and confirmed.
  // Cancelling stays put. It returns a function that takes the guard
  // off again.
  //
  // An in-page #anchor, a javascript: or mailto: href, anything with a
  // target, a download and a modified click (ctrl/cmd/shift/middle) all
  // leave the page where it is, so they are let through untouched.
  // Closing the tab and typing an address are the browser's to catch
  // and nobody else's: the first guard arms a beforeunload as the
  // backstop for those, which is the one place the browser's own dialog
  // is unavoidable.
  var leaveGuards = [];
  var leavingNow = false;
  var backstopArmed = false;

  function leaveReason() {
    for (var i = 0; i < leaveGuards.length; i++) {
      var why = '';
      try { why = leaveGuards[i](); } catch (e) { why = ''; }
      if (why) return String(why);
    }
    return '';
  }

  // The href a click would actually take the page to, or null if this
  // click was never going to leave it.
  function leavingHref(node) {
    var a = node && node.closest ? node.closest('a[href]') : null;
    if (!a || typeof a.href !== 'string') return null; // an SVG <a> has no string href
    if (a.hasAttribute('target') || a.hasAttribute('download')) return null;
    if (a.protocol !== 'http:' && a.protocol !== 'https:') return null;
    // the same page, with or without a #hash, is not leaving it
    if (a.href.split('#')[0] === location.href.split('#')[0]) return null;
    return a.href;
  }

  // One tap, one question. Two paths reach this for a single tap on the
  // bottom bar of an iPhone: the touch release opens the panel and
  // preventDefaults the click that would follow, but the invisible
  // haptic switch over the bar forwards the tap with host.click(), and
  // a click the page dispatched itself is not the one preventDefault
  // was holding back. A stutter tap does the same on any device. Both
  // opened a second panel under the first, so answering the one on
  // screen left the reader looking at another and the slide had to be
  // done the whole way twice. The event is still stopped when the
  // question is refused — the point is that the second one navigates
  // nowhere, not that it is ignored.
  var asking = false;

  // url: where the page goes, or a function that takes it there (a reload)
  function askBeforeLeaving(why, url) {
    // a panel already up would hand back one that never answers
    if (asking || leavingNow || confirmOpen) return;
    asking = true;
    if (window.scsHaptic) window.scsHaptic('warning');
    window.scs.confirmSlide({
      title: 'Leave this page?',
      copy: why,
      slideLabel: 'Slide to leave',
      confirmTitle: 'Last check',
      confirmCopy: why + ' Leaving this page stops it.',
      confirmLabel: 'Leave the page',
      cancelLabel: 'Stay here',
      onConfirm: function () {
        asking = false;
        // the browser's own dialog would be a second question about an
        // answer already given
        leavingNow = true;
        window.setTimeout(function () { leavingNow = false; }, 2000);
        if (typeof url === 'function') { url(); return; }
        startLoadBar(url);
        location.href = url;
      },
      onCancel: function () { asking = false; }
    });
  }

  window.scs.guardLeaving = function (fn) {
    if (typeof fn !== 'function') return function () {};
    leaveGuards.push(fn);
    if (!backstopArmed) {
      backstopArmed = true;
      window.addEventListener('beforeunload', function (e) {
        if (leavingNow || !leaveReason()) return;
        e.preventDefault();
        e.returnValue = ''; // older browsers want the string
      });
    }
    return function () {
      var i = leaveGuards.indexOf(fn);
      if (i >= 0) leaveGuards.splice(i, 1);
    };
  };

  // Every ordinary link: the nav, the footer, the bottom bar and the
  // floating button all send a click, and this one runs in the capture
  // phase on the document, so it is ahead of every listener below it.
  document.addEventListener('click', function (e) {
    if (!leaveGuards.length || e.defaultPrevented) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.button && e.button !== 0) return;
    var url = leavingHref(hapticHost(e.target));
    if (!url) return;
    var why = leaveReason();
    if (!why) return;
    e.preventDefault();
    e.stopPropagation();
    askBeforeLeaving(why, url);
  }, true);

  // The bottom bar navigates on the *release* of a tap made mid-scroll,
  // before any click arrives (see the next section), so the guard has
  // to be there first. A capture listener on the document is ahead of
  // the bar's own: preventDefault takes the click that would otherwise
  // follow, and stopPropagation keeps the bar's release from
  // navigating. Only a tap that did not travel reaches that point, and
  // a touch that moved less than the pull's own 12px slop never started
  // a pull, so stopping it here leaves nothing half done.
  var guardTouch = null;
  document.addEventListener('touchstart', function (e) {
    // nothing to guard: the listener costs nothing on every other page
    var t = leaveGuards.length && e.touches.length === 1 ? e.touches[0] : null;
    guardTouch = t ? { x: t.clientX, y: t.clientY, at: Date.now() } : null;
  }, { capture: true, passive: true });
  document.addEventListener('touchend', function (e) {
    var start = guardTouch;
    guardTouch = null;
    if (!leaveGuards.length || !start) return;
    var t = e.changedTouches && e.changedTouches[0];
    if (!t) return;
    // a tap, not a drag that happened to end here — the bar's own test
    if (Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10) return;
    if (Date.now() - start.at > 700) return;
    var hit = hapticHost(e.target);
    if (!hit || !hit.closest || !hit.closest('.tab-bar')) return;
    var url = leavingHref(hit);
    if (!url) return;
    var why = leaveReason();
    if (!why) return;
    e.preventDefault();
    e.stopPropagation();
    askBeforeLeaving(why, url);
  }, true);

  // ---------------- The loading bar ----------------
  // A tap on a link to another page gets no answer from the page it was
  // made on: the screen stays exactly as it was until the next page
  // draws. When that takes a while — a slow connection, or Safari slow
  // to start the navigation — the tap reads as one that did not
  // register, even though the haptic has already ticked. So if the page
  // is still here 250ms after the tap, the pull's own bar comes in under
  // the top bar and its green creeps across while the next page loads.
  // It never reaches the end: the next page replacing this one is the
  // end. A page that changes inside the 250ms shows nothing. A page with
  // no pull is given the same bar. In the app layout only.
  //
  // Three paths start a navigation and all three come through here: an
  // ordinary click (including the one the invisible haptic switch
  // forwards to its link), the bottom bar's release during a scroll,
  // and the slide-to-confirm's Leave. A click is only asked about once
  // the 250ms are up, so one that a listener further down cancelled —
  // the tab you are already on scrolls to the top instead — shows
  // nothing.
  var LOAD_WAIT = 250;
  site.LOAD_WAIT = LOAD_WAIT;
  var loadBar = null;   // built on first use
  var loadFor = '';     // the address the bar is waiting on
  var loadWait = 0;
  var loadTick = 0;
  var loadGiveUp = 0;
  var LOAD_STEP = 300;  // the fill's width transition in site.css
  site.LOAD_STEP = LOAD_STEP;

  // the next width of a creeping fill: a tenth of what is left each
  // time, quick at first, slower as it goes, and never all the way
  function creepOn(at) {
    return at ? Math.min(0.94, at + (1 - at) * 0.1) : 0.2;
  }

  function stopLoadBar() {
    window.clearTimeout(loadWait);
    window.clearInterval(loadTick);
    window.clearTimeout(loadGiveUp);
    loadWait = loadTick = loadGiveUp = 0;
    loadFor = '';
    if (loadBar) {
      loadBar.classList.remove('is-going');
      loadBar.firstChild.style.width = '';
    }
  }

  function showLoadBar() {
    // not the photo viewer's own (lb-load), which goes with the viewer
    if (!loadBar) loadBar = document.querySelector('.ptr-bar:not(.lb-load)');
    if (!loadBar) {
      loadBar = document.createElement('div');
      loadBar.className = 'ptr-bar';
      loadBar.setAttribute('aria-hidden', 'true');
      loadBar.appendChild(document.createElement('span'));
      document.body.appendChild(loadBar);
    }
    var fill = loadBar.firstChild;
    var at = 0;
    fill.style.transition = 'none';
    fill.style.width = '0%';
    void fill.offsetWidth;
    fill.style.transition = '';
    loadBar.classList.add('is-going');
    var step = function () {
      at = creepOn(at);
      fill.style.width = (at * 100).toFixed(1) + '%';
    };
    step();
    loadTick = window.setInterval(step, LOAD_STEP);
    // A navigation the browser dropped leaves this page where it was: a
    // download, or the browser's own "leave this page?" answered no.
    // The bar goes after a while rather than creeping for ever.
    loadGiveUp = window.setTimeout(stopLoadBar, 20000);
  }

  // A link to a page pushed over this one (assets/push.js) keeps this
  // page's main as it is, where it is scrolled, for that page to draw
  // under itself as it slides in and out
  document.addEventListener('click', function (e) {
    if (!root.classList.contains('is-pwa')) return;
    var link = e.target.closest && e.target.closest('a[data-push]');
    var main = document.querySelector('main');
    if (!link || !main) return;
    var box = main.getBoundingClientRect();
    var path = function (p) { return p.replace(/index\.html$/, ''); };
    try {
      sessionStorage.setItem('scs2-under:' + path(new URL(link.href).pathname), JSON.stringify({
        from: path(location.pathname), html: main.outerHTML,
        top: box.top, left: box.left, width: box.width, w: window.innerWidth, at: Date.now()
      }));
    } catch (err) { /* not kept: the page slides over bare paper */ }
  }, true);

  // stillGoing, when given, is asked once the 250ms are up
  function startLoadBar(url, stillGoing) {
    // The app layout only. A desktop browser shows a page on its way in
    // its own tab and address bar, so a second bar there says nothing;
    // the installed app has neither. Asked at the tap, since the
    // settings switch changes the layout without a reload.
    if (!document.documentElement.classList.contains('is-pwa')) return;
    // the forwarded click after a release that already navigated
    if (url === loadFor && (loadWait || loadTick)) return;
    stopLoadBar();
    loadFor = url;
    loadWait = window.setTimeout(function () {
      loadWait = 0;
      if (stillGoing && !stillGoing()) { loadFor = ''; return; }
      showLoadBar();
    }, LOAD_WAIT);
  }

  window.addEventListener('pagehide', stopLoadBar);
  // a page kept in the back-forward cache comes back exactly as it was
  // left, bar and all
  window.addEventListener('pageshow', function (e) { if (e.persisted) stopLoadBar(); });

  document.addEventListener('click', function (e) {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (e.button && e.button !== 0) return;
    // a haptic switch's own click: the click it forwards to its link
    // comes straight after, and that is the one that navigates or not
    if (e.target && e.target.classList && e.target.classList.contains('haptic-tap')) return;
    var url = leavingHref(e.target);
    if (!url) return;
    startLoadBar(url, function () { return !e.defaultPrevented; });
  }, true);

  // ------------- Tapping the bottom bar during a scroll -------------
  // iOS spends the first tap of a momentum scroll on stopping it, so a
  // tab-bar tap made while the page was still flying could be swallowed
  // and the page only changed once the scroll had run down. The bar is
  // fixed, outside the scroller, so a touch there was never meant to
  // stop anything. Only in that case — a finger going down while the
  // page is actually moving — the release navigates itself instead of
  // waiting for a click the browser may not send. Every other tap is
  // left completely alone, which keeps the ordinary click, its haptic
  // and the browser's own handling.
  var lastScrollAt = 0;
  document.addEventListener('scroll', function () { lastScrollAt = Date.now(); }, { passive: true, capture: true });

  var tapNav = document.querySelector('.tab-bar');
  if (tapNav) {
    var navTouch = null;
    var navGoingTo = '';
    tapNav.addEventListener('touchstart', function (e) {
      var t = e.touches[0];
      navTouch = t && (Date.now() - lastScrollAt) < 250
        ? { x: t.clientX, y: t.clientY, at: Date.now() }
        : null;
    }, { passive: true });
    tapNav.addEventListener('touchend', function (e) {
      var start = navTouch;
      navTouch = null;
      var t = start && e.changedTouches && e.changedTouches[0];
      if (!t) return;
      // a tap, not a drag that happened to end here
      if (Math.abs(t.clientX - start.x) > 10 || Math.abs(t.clientY - start.y) > 10) return;
      if (Date.now() - start.at > 700) return;
      var hit = hapticHost(e.target);
      var link = hit && hit.closest ? hit.closest('.tab-bar > a') : null;
      if (!link || !link.href || link.href === location.href) return;
      navGoingTo = link.href;
      // only the click that follows this release is the same trip
      window.setTimeout(function () { navGoingTo = ''; }, 1000);
      startLoadBar(link.href);
      location.href = link.href;
    }, { passive: true });
    window.addEventListener('pageshow', function (e) { if (e.persisted) navGoingTo = ''; });
    tapNav.addEventListener('click', function (e) {
      var hit = hapticHost(e.target);
      var link = hit && hit.closest ? hit.closest('.tab-bar > a') : null;
      if (!link) return;
      // the click the browser sends after a release that already
      // navigated would be a second trip to the same page
      if (navGoingTo && link.href === navGoingTo) { e.preventDefault(); return; }
      // Tapping the tab you are already on reloaded the page. Spam one
      // and it reloads over and over: the chrome animates in every
      // time, the floating button with it, and on a phone the safe
      // area behind the notch flashes between paints. There is nothing
      // to load — go back to the top instead, the way an app does.
      // the tab for the page you are on; a page further in under the
      // same tab (a team's page under the tab) is left to go back to it
      if (link.pathname.replace(/index\.html$/, '') !== location.pathname.replace(/index\.html$/, '')) return;
      e.preventDefault();
      var scroller = document.body;
      if (!scroller.scrollTop && !window.pageYOffset) return;
      if (scroller.scrollTo) scroller.scrollTo({ top: 0, behavior: window.scs.reducedMotion ? 'auto' : 'smooth' });
      else scroller.scrollTop = 0;
    }, true);
  }

  // ---------------- Haptic feedback (installed app) ----------------
  // web-haptics (github.com/lochie/web-haptics, vendored in assets/haptics):
  // Vibration API where it exists, hidden switch-toggle haptics on iOS.
  // Real taps on real controls only, intensity matched to the action, and
  // the settings menu can turn the whole thing off.
  var HAPTICS_KEY = 'scs2-haptics';
  var hapticsOn = true;
  try { hapticsOn = localStorage.getItem(HAPTICS_KEY) !== '0'; } catch (e) { /* default on */ }
  var hapticsEngine = null;

  window.scsHaptic = function (kind) {
    if (hapticsEngine && hapticsOn) hapticsEngine.trigger(kind || 'light');
  };

  // iOS 26.5 took the scripted path away: the engine buzzes by clicking
  // a switch from script, and the tick now only comes from a finger
  // landing on a real native switch. Where that is the case the engine
  // cannot work at all, so it is not even fetched and the controls wear
  // invisible switches of their own instead (below). The test is a
  // handheld with native switches and no Vibration API, which leaves
  // Android and desktop exactly as they were.
  var tapHaptics = ('switch' in document.createElement('input')) &&
    !navigator.vibrate && handheld();

  // Runs on the web too now: phones buzz in the browser as well, and the
  // engine silently does nothing on hardware without haptics.
  var hapticsManifest = document.querySelector('link[rel="manifest"]');
  if (hapticsManifest && !tapHaptics) {
    import(new URL('assets/haptics/index.mjs', hapticsManifest.href).toString())
      .then(function (mod) { hapticsEngine = new mod.WebHaptics(); })
      .catch(function () { /* haptics are a bonus, never an error */ });
  }

  document.addEventListener('click', function (e) {
    if (!e.isTrusted || !e.target || !e.target.closest) return;
    if (isHapticEcho(e)) return; // a buzz must not trigger another buzz
    var el = e.target.closest('a, button, input[type="checkbox"], input[type="radio"], select, summary');
    if (!el || el.id === 'set-haptics') return; // the on/off switch speaks through its own change handler
    if (el.closest('.tab-bar')) { window.scsHaptic('selection'); return; } // tab switch
    window.scsHaptic('light'); // buttons, toggles, links, menu rows
  }, true);

  var hapticsCheck = document.getElementById('set-haptics');
  if (hapticsCheck) {
    hapticsCheck.checked = hapticsOn;
    hapticsCheck.addEventListener('change', function () {
      hapticsOn = hapticsCheck.checked;
      try { localStorage.setItem(HAPTICS_KEY, hapticsOn ? '1' : '0'); } catch (err) { /* not persisted */ }
      syncTapSwitches(); // the tap path answers to this rocker too
      if (hapticsOn) window.scsHaptic('light'); // a little "it's back on" tick
    });
  }

  // An invisible native switch laid over a control: rendered, native
  // appearance untouched, only the opacity is zero, so the finger lands
  // on a real switch and iOS ticks. It is hidden from screen readers
  // and skipped by the keyboard — the control underneath is still the
  // real one — and it hands the tap straight on. A forwarded click is
  // untrusted, so the buzz listener above skips it and nothing doubles.
  // No intensity to choose here: the tick belongs to the switch, and
  // the system decides what it feels like.
  function tapSwitch(host) {
    var sw = document.createElement('input');
    sw.type = 'checkbox';
    sw.setAttribute('switch', '');
    sw.className = 'haptic-tap';
    sw.tabIndex = -1;
    sw.setAttribute('aria-hidden', 'true');
    sw._scsHost = host;
    sw.addEventListener('click', function () { host.click(); });
    return sw;
  }

  // which control an invisible switch stands for (see the menu's
  // outside-tap listener)
  function hapticHost(node) {
    var sw = node && node.closest ? node.closest('.haptic-tap') : null;
    return (sw && sw._scsHost) || node;
  }

  // Controls that are buttons or links rather than checkboxes, and so
  // cannot hold a switch inside them, get one beside them instead,
  // laid over their box. offsetLeft/offsetTop are the untransformed
  // layout position, so the nav sliding away on scroll or the settings
  // menu animating open never slides a switch off its button.
  var laidOver = [];
  var tapWatcher = null;

  function layOver(host) {
    if (!host || !host.parentNode) return;
    var sw = tapSwitch(host);
    sw.classList.add('haptic-tap-over');
    host.parentNode.appendChild(sw);
    laidOver.push(sw);
  }

  function placeTapSwitches() {
    for (var i = 0; i < laidOver.length; i++) {
      var sw = laidOver[i];
      var host = sw._scsHost;
      // A hidden control has no box. Its switch keeps the last one it
      // had and is hidden too: when whatever hides the control is not
      // also the switch's container — the app bar's Welfare heart, which
      // a setting takes away on its own — a switch left showing would
      // still send taps to a control nobody can see.
      if (!host.offsetWidth && !host.offsetHeight) {
        sw.style.visibility = 'hidden';
        continue;
      }
      sw.style.visibility = '';
      sw.style.left = host.offsetLeft + 'px';
      sw.style.top = host.offsetTop + 'px';
      sw.style.width = host.offsetWidth + 'px';
      sw.style.height = host.offsetHeight + 'px';
      // a control nudged off its layout position by a transform of its
      // own — the app bar's bell is — takes its switch with it
      var shift = window.getComputedStyle(host);
      sw.style.transform = shift.transform === 'none' ? '' : shift.transform;
      sw.style.transformOrigin = shift.transformOrigin;
    }
  }

  // The settings menu's Haptic feedback rocker turns this path off as
  // well: a checkbox without the switch attribute is an ordinary
  // checkbox, and an ordinary checkbox does not tick. The switches
  // stay where they are and keep passing taps on, so nothing else
  // about the chrome changes.
  function syncTapSwitches() {
    if (!tapHaptics) return;
    [].forEach.call(document.querySelectorAll('input.haptic-tap, .settings-switch'), function (el) {
      var box = el.classList.contains('haptic-tap') ? el : el.previousElementSibling;
      if (!box || box.tagName !== 'INPUT' || box.type !== 'checkbox') return;
      if (hapticsOn) box.setAttribute('switch', '');
      else box.removeAttribute('switch');
    });
  }

  if (tapHaptics) {
    document.documentElement.classList.add('haptic-taps');

    // The rockers need no overlay: their own hidden checkbox becomes the
    // switch, grown by the stylesheet from a pixel to the whole row.
    [].forEach.call(document.querySelectorAll('.settings-switch'), function (art) {
      var box = art.previousElementSibling;
      if (box && box.tagName === 'INPUT' && box.type === 'checkbox') box.setAttribute('switch', '');
    });

    // The app's bottom bar: one switch in each link's grid cell. Both
    // are placed by hand, or the added switches would flow into new
    // columns of their own and halve the bar. The bar holds six links
    // and shows five — Submit or Welfare, by the Visual page's rocker —
    // so the columns are counted over the shown ones, and the hidden
    // link's switch goes with it.
    var tapBar = document.querySelector('.tab-bar');
    if (tapBar) {
      var barLinks = [].slice.call(tapBar.querySelectorAll(':scope > a'));
      var barSwitches = barLinks.map(function (link) {
        var sw = tapSwitch(link);
        tapBar.appendChild(sw);
        return sw;
      });
      var placeBarSwitches = function () {
        var hidden = 'tab-welfare';
        var col = 0;
        barLinks.forEach(function (link, i) {
          var shown = !link.classList.contains(hidden);
          barSwitches[i].style.display = shown ? '' : 'none';
          if (!shown) return;
          col += 1;
          link.style.gridArea = '1 / ' + col;
          barSwitches[i].style.gridArea = '1 / ' + col;
        });
      };
      placeBarSwitches();
    }

    // The chrome's own three: the messages bell, the settings gear and
    // the light/dark switch inside the menu.
    layOver(document.querySelector('.bell-toggle'));
    layOver(document.querySelector('.welfare-toggle'));
    layOver(settingsBtn);
    layOver(themeBtn);
    layOver(document.getElementById('set-font-dec'));
    layOver(document.getElementById('set-font-inc'));
    // The bar is still settling at this point — the app layout lands,
    // --nav-h is measured, the splash comes off — and a switch measured
    // against a box that then moves would sit beside its button instead
    // of on it. Watching each switch's own container catches every one
    // of those; the timers cover a browser without the observer.
    placeTapSwitches();
    window.requestAnimationFrame(placeTapSwitches);
    window.setTimeout(placeTapSwitches, 400);
    window.addEventListener('resize', placeTapSwitches);
    window.addEventListener('orientationchange', placeTapSwitches);
    window.addEventListener('load', placeTapSwitches);
    if (window.ResizeObserver) {
      var watchBoxes = new window.ResizeObserver(function () { placeTapSwitches(); });
      laidOver.forEach(function (sw) { if (sw.parentNode) watchBoxes.observe(sw.parentNode); });
      tapWatcher = watchBoxes;
    }
  }

  // A page's own control can ask for one of these. The list above is
  // the chrome's, and the chrome is all site.js knows about; the submit
  // page's two view tabs are the same kind of thing — a button a thumb
  // presses to change what is on the screen — and are nowhere near it.
  // Does nothing where the engine still works, since there the ordinary
  // click listener buzzes and a second path would double it.
  window.scs.hapticTap = function (host) {
    if (!tapHaptics || !host || !host.parentNode) return;
    layOver(host);
    placeTapSwitches();
    window.requestAnimationFrame(placeTapSwitches);
    var sw = laidOver[laidOver.length - 1];
    if (tapWatcher && sw && sw.parentNode) tapWatcher.observe(sw.parentNode);
  };
  // the settings menu's way into its second page and back out of it
  window.scs.hapticTap(document.getElementById('set-visual-open'));
  window.scs.hapticTap(document.getElementById('set-visual-back'));

  // Quest sheet animation style: I is the container morph (the tapped
  // card grows into the sheet and the sheet shrinks back into it), O is
  // the classic slide-up. The quest page reads the stored choice live
  // on every open and close, so flipping it needs no reload.
  var ANIM_KEY = 'scs2-anim';
  var animCheck = document.getElementById('set-anim');
  if (animCheck) {
    var morphOn = true;
    try { morphOn = localStorage.getItem(ANIM_KEY) !== 'slide'; } catch (err) { /* default morph */ }
    animCheck.checked = morphOn;
    animCheck.addEventListener('change', function () {
      try { localStorage.setItem(ANIM_KEY, animCheck.checked ? 'morph' : 'slide'); } catch (err) { /* not persisted */ }
    });
  }

  // Where the quest list starts: the page, or the map filling the
  // screen. The class is stamped on every page rather than only on the
  // quest list, because it is the stylesheet that decides what full
  // screen means — with this on, full screen is the page rather than a
  // layer over it, so the chrome stays. The quest page reads the class
  // at boot and opens the map itself.
  var MAPFULL_KEY = 'scs2-map-full';
  var mapFullCheck = document.getElementById('set-map-full');
  var mapFullOn = false;
  try { mapFullOn = localStorage.getItem(MAPFULL_KEY) === '1'; } catch (err) { /* default off */ }
  document.documentElement.classList.toggle('ql-map-home', mapFullOn);
  if (mapFullCheck) {
    mapFullCheck.checked = mapFullOn;
    mapFullCheck.addEventListener('change', function () {
      var on = mapFullCheck.checked;
      try { localStorage.setItem(MAPFULL_KEY, on ? '1' : '0'); } catch (err) { /* not persisted */ }
      // A map already full screen gains or loses its bars from here;
      // starting full screen is the next load's job.
      document.documentElement.classList.toggle('ql-map-home', on);
    });
  }

  // Sharper Map: the quest and replay maps drawn at the screen's full
  // density rather than at most 2x (scs.mapPixelRatio). A map on screen
  // takes the change at once.
  var SHARP_KEY = 'scs2-map-sharp';
  var sharpCheck = document.getElementById('set-map-sharp');
  if (sharpCheck) {
    try { sharpCheck.checked = localStorage.getItem(SHARP_KEY) === '1'; } catch (err) { /* default off */ }
    sharpCheck.addEventListener('change', function () {
      try { localStorage.setItem(SHARP_KEY, sharpCheck.checked ? '1' : '0'); } catch (err) { /* not persisted */ }
      document.dispatchEvent(new CustomEvent('scs-map-sharp-changed'));
    });
  }

  // Group Map Pins: on the quest map, pins close together drawn as one
  // disc with their count. On unless turned off; a map on screen takes
  // the change at once.
  var GROUPS_KEY = 'scs2-map-groups';
  var groupsCheck = document.getElementById('set-map-groups');
  if (groupsCheck) {
    try { groupsCheck.checked = localStorage.getItem(GROUPS_KEY) !== '0'; } catch (err) { /* default on */ }
    groupsCheck.addEventListener('change', function () {
      try { localStorage.setItem(GROUPS_KEY, groupsCheck.checked ? '1' : '0'); } catch (err) { /* not persisted */ }
      document.dispatchEvent(new CustomEvent('scs-map-groups-changed'));
    });
  }

  // Justified text. The class is stamped on every page; what it reaches
  // is whatever that page has marked data-justify, which is the running
  // prose on the home, info and welfare pages and nothing else.
  var JUSTIFY_KEY = 'scs2-justify';
  var justifyCheck = document.getElementById('set-justify');
  var justifyOn = false;
  try { justifyOn = localStorage.getItem(JUSTIFY_KEY) === '1'; } catch (err) { /* default off */ }
  document.documentElement.classList.toggle('justify-text', justifyOn);
  if (justifyCheck) {
    justifyCheck.checked = justifyOn;
    justifyCheck.addEventListener('change', function () {
      var on = justifyCheck.checked;
      try { localStorage.setItem(JUSTIFY_KEY, on ? '1' : '0'); } catch (err) { /* not persisted */ }
      document.documentElement.classList.toggle('justify-text', on);
    });
  }

  // Hide Checklist: the quest list's tick boxes, its total and its done
  // marks go, and what was ticked stays saved. The quest page stamps the
  // class at boot and redraws on the event.
  var CHECKLIST_KEY = 'scs2-hide-checklist';
  var checklistCheck = document.getElementById('set-hide-checklist');
  if (checklistCheck) {
    try { checklistCheck.checked = localStorage.getItem(CHECKLIST_KEY) === '1'; } catch (err) { /* default shown */ }
    checklistCheck.addEventListener('change', function () {
      var on = checklistCheck.checked;
      try { localStorage.setItem(CHECKLIST_KEY, on ? '1' : '0'); } catch (err) { /* not persisted */ }
      document.documentElement.classList.toggle('hide-checklist', on);
      document.dispatchEvent(new CustomEvent('scs-checklist-changed'));
    });
  }

  // The 24-hour clock. Every time on the site comes out of fmtTime and
  // fmtHour, so this is one key, and the pages that print times redraw
  // on the same event the Hide dates rocker sends.
  var clockCheck = document.getElementById('set-24h');
  if (clockCheck) {
    clockCheck.checked = window.scs.hour24();
    clockCheck.addEventListener('change', function () {
      try { localStorage.setItem(CLOCK_KEY, clockCheck.checked ? '24' : '12'); }
      catch (err) { /* not persisted */ }
      document.dispatchEvent(new CustomEvent('scs-dates-changed'));
    });
  }

  // Hide dates. Nothing on the page reruns itself, so flipping it says
  // so and the pages that print times draw them again — the live tab,
  // the messages list and the submit page's sent list. Anything else
  // takes it on its next render, which is the next time it is opened.
  var datesCheck = document.getElementById('set-hide-dates');
  if (datesCheck) {
    datesCheck.checked = window.scs.hideDates();
    datesCheck.addEventListener('change', function () {
      try { localStorage.setItem(DATES_KEY, datesCheck.checked ? '1' : '0'); }
      catch (err) { /* not persisted */ }
      document.dispatchEvent(new CustomEvent('scs-dates-changed'));
    });
  }
});
