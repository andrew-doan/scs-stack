/* A page pushed over another in the app layout: a team's page and the
   recap over the tab, a quest's page over the recap. It slides in over
   the page it was opened from, and a swipe in from the left edge, the
   back arrow or the bottom bar's way back carry it off again, with that
   page drawn under it from the copy it kept as the link was tapped
   (data-push links, site-input.js). Loaded at the top of the body, so the
   first frame painted is the first frame of the slide. */
(function () {
  'use strict';

  var root = document.documentElement;
  var KEY = 'scs2-under:';
  var EDGE = 24;
  var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  function norm(path) { return String(path || '').replace(/index\.html$/, ''); }
  function app() { return root.classList.contains('is-pwa'); }
  function ms(name, fallback) {
    var v = parseFloat(getComputedStyle(root).getPropertyValue(name));
    return isFinite(v) ? v : fallback;
  }

  var here = norm(location.pathname);
  var kept = null;
  try { kept = JSON.parse(sessionStorage.getItem(KEY + here) || 'null'); } catch (err) { kept = null; }
  var from = '';
  try {
    var ref = new URL(document.referrer);
    if (ref.origin === location.origin) from = norm(ref.pathname);
  } catch (err) { from = ''; }

  // the copy is of the page this one was opened from, at this width
  function fits() {
    return !!(kept && kept.html && kept.from === from && kept.w === window.innerWidth);
  }

  var under = null;
  var sheet = null;
  function build() {
    if (under || !fits()) return !!under;
    var tpl = document.createElement('template');
    tpl.innerHTML = kept.html;
    var copy = tpl.content.firstElementChild;
    if (!copy) return false;
    copy.removeAttribute('data-pull');
    copy.style.cssText = 'position: absolute; margin: 0; box-sizing: border-box; top: ' + kept.top +
      'px; left: ' + kept.left + 'px; width: ' + kept.width + 'px;';
    under = document.createElement('div');
    under.className = 'push-under';
    under.setAttribute('aria-hidden', 'true');
    under.inert = true;
    under.appendChild(copy);
    sheet = document.createElement('div');
    sheet.className = 'push-sheet';
    sheet.setAttribute('aria-hidden', 'true');
    document.body.appendChild(under);
    document.body.appendChild(sheet);
    // the copy is a main too, so it goes after the page's own, where every
    // look-up for the page's main still finds that one first; built before
    // the page's main is parsed, it moves there the moment it is
    if (!afterMain() && window.MutationObserver) {
      var watch = new MutationObserver(function () { if (afterMain()) watch.disconnect(); });
      watch.observe(document.body, { childList: true });
    }
    return true;
  }
  function pageMain() { return document.querySelector('body > main'); }
  function afterMain() {
    var page = pageMain();
    if (!page) return false;
    page.after(under, sheet);
    return true;
  }

  // the page at x across, the sheet with it, the page under a third as far
  function place(page, x, dur) {
    var how = dur ? 'transform ' + dur + 'ms cubic-bezier(0.22, 1, 0.36, 1)' : 'none';
    page.style.transition = how;
    page.style.transform = x ? 'translateX(' + x + 'px)' : '';
    if (!under) return;
    sheet.style.transition = how;
    sheet.style.transform = 'translateX(' + x + 'px)';
    under.style.transition = how;
    under.style.transform = 'translateX(' + Math.round((x - window.innerWidth) * 0.3) + 'px)';
  }
  function rest(page) {
    page.style.transition = '';
    root.classList.remove('push-moving');
  }

  // ---- the way in ----
  // Only straight after the tap that kept the copy: a reload, a return
  // through history or a link from anywhere else just shows the page.
  var entry = window.performance && performance.getEntriesByType ? performance.getEntriesByType('navigation')[0] : null;
  var arriving = app() && !reduced && fits() && kept.at && Date.now() - kept.at < 8000 &&
    (!entry || entry.type === 'navigate') && build();
  var settled;
  var ready = new Promise(function (done) { settled = done; });
  // the slide in is still running: a swipe waits for it
  var inbound = !!arriving;
  if (arriving) {
    kept.at = 0;
    try { sessionStorage.setItem(KEY + here, JSON.stringify(kept)); } catch (err) { /* slides again on a reload */ }
    // a page arrived at is read from its top
    try { sessionStorage.removeItem('scs2-scroll:' + location.pathname); } catch (err) { /* nothing kept */ }
    root.classList.remove('scroll-restoring');
    root.classList.add('push-in', 'push-moving');
    sheet.style.transform = 'translateX(' + window.innerWidth + 'px)';
    var started = false;
    var go = function () {
      var page = pageMain();
      if (!page || started) return;
      started = true;
      var dur = ms('--duration-slow', 400);
      place(page, window.innerWidth, 0);
      root.classList.remove('push-in');
      void page.offsetWidth;
      place(page, 0, dur);
      window.setTimeout(function () {
        inbound = false;
        rest(page);
        settled();
      }, dur + 30);
    };
    // the slide starts on the frame after the page's content is in
    var look = function () {
      if (pageMain()) window.requestAnimationFrame(go);
      else window.requestAnimationFrame(look);
    };
    window.requestAnimationFrame(look);
    document.addEventListener('DOMContentLoaded', go);
  } else {
    settled();
  }

  // ---- the way back ----
  var swiped = false;
  function parentHref() {
    var link = document.querySelector('.back-toggle, .back-link');
    return link ? link.href : '../';
  }
  // back through history when the page before is the one this was opened
  // from, so it comes back where it was scrolled; to its address otherwise
  function cameBack() {
    if (history.length < 2 || !from) return false;
    if (kept && kept.from === from) return true;
    try { return norm(new URL(parentHref()).pathname) === from; } catch (err) { return false; }
  }
  var leaving = false;
  function leave() {
    if (leaving) return;
    leaving = true;
    // past any entries a layer on this page is holding (site-chrome.js),
    // or the step back only closes the layer
    var st = history.state;
    var held = st && typeof st.scsLayer === 'number' ? st.scsLayer : 0;
    if (cameBack()) history.go(-1 - held);
    else location.href = parentHref();
  }
  function slideOff(page) {
    if (leaving || swiped) return;
    if (!app() || reduced || !page || !build()) { leave(); return; }
    swiped = true;
    root.classList.add('push-moving');
    var dur = ms('--duration-slow', 400);
    place(page, 0, 0);
    void page.offsetWidth;
    place(page, window.innerWidth, dur);
    window.setTimeout(leave, dur + 20);
  }

  function wire() {
    var page = pageMain();
    var backBtn = document.querySelector('.back-toggle');
    if (backBtn && window.scs && window.scs.hapticTap) window.scs.hapticTap(backBtn);
    var parentPath = '';
    try { parentPath = norm(new URL(parentHref()).pathname); } catch (err) { parentPath = ''; }
    // the arrow, the web's line over the name, and the bottom bar's link
    // to the page this one sits over
    [].forEach.call(document.querySelectorAll('.back-toggle, .back-link, .tab-bar a'), function (link) {
      if (link.closest('.tab-bar') && norm(new URL(link.href, location.href).pathname) !== parentPath) return;
      link.addEventListener('click', function (e) {
        if (!cameBack() && !app()) return;
        e.preventDefault();
        if (link.classList.contains('back-link')) leave();
        else slideOff(page);
      });
    });

    // a swipe in from the left edge carries the page with the finger; let
    // go far enough over, or flicked, it goes back
    if (!page) return;
    var start = null;
    var moving = false;
    var dx = 0;
    function settle(to, then) {
      var dur = reduced ? 0 : ms('--duration-fast', 250);
      place(page, to, dur);
      window.setTimeout(function () {
        if (!to) rest(page);
        if (then) then();
      }, dur + 20);
    }
    // the viewer, a pop-up, the settings menu or any other layer is open
    function covered() {
      if (window.scsBackLayer && window.scsBackLayer.isOpen()) return true;
      return root.classList.contains('lb-open') || root.classList.contains('settings-open') ||
        !!document.querySelector('.confirm-overlay:not([hidden]):not(.is-hidden), .urgent-overlay');
    }
    document.addEventListener('touchstart', function (e) {
      start = null;
      if (!app() || inbound || e.touches.length !== 1 || covered()) return;
      var t = e.touches[0];
      if (t.clientX > EDGE) return;
      start = { x: t.clientX, y: t.clientY, at: Date.now() };
      moving = false;
      dx = 0;
    }, { passive: true });
    document.addEventListener('touchmove', function (e) {
      if (!start || e.touches.length !== 1) return;
      var t = e.touches[0];
      var mx = t.clientX - start.x;
      var my = t.clientY - start.y;
      if (!moving) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        if (mx <= 0 || Math.abs(my) > Math.abs(mx)) { start = null; return; }
        moving = true;
        build();
        root.classList.add('push-moving');
      }
      if (e.cancelable) e.preventDefault();
      dx = Math.max(0, mx);
      place(page, dx, 0);
    }, { passive: false });
    function release() {
      if (!start) return;
      var began = start;
      start = null;
      if (!moving) return;
      moving = false;
      var flicked = dx > 40 && Date.now() - began.at < 300;
      if (dx > window.innerWidth * 0.35 || flicked) {
        swiped = true;
        settle(window.innerWidth, leave);
      } else {
        settle(0);
      }
    }
    document.addEventListener('touchend', release);
    document.addEventListener('touchcancel', release);
    // back from the browser's cache, the page is where the slide left it
    window.addEventListener('pageshow', function (e) {
      if (!e.persisted && !swiped) return;
      swiped = false;
      leaving = false;
      place(page, 0, 0);
      rest(page);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
  else wire();

  window.scsPush = {
    // resolves once the way in has finished (at once when there was none)
    ready: ready,
    back: function () { slideOff(pageMain()); }
  };
})();
