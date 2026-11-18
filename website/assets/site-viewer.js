// The site's shared script, part two of five: the photo viewer and pull tabs.
(window.scsSite = window.scsSite || { parts: [] }).parts.push(function (site) {
  'use strict';

  // from the parts before this one
  var handheld = site.handheld;

  // A pane that slides back off the edge it came from by its pull tab.
  // A finger on the tab, or on opts.handle, drags it either way; one
  // anywhere else on the pane drags it once the pane's content can
  // scroll no further that way, and is otherwise left to scroll it.
  // Released past a third of its height, or flicked, it closes, and
  // short of that it springs back. The tab's halves fold into a v
  // pointing the way the finger is going, and lie flat and stretch
  // with the rubber band against the way that closes. opts: edge, the
  // screen edge the pane is against ('bottom', or 'top'); tab; handle;
  // active(), whether it applies now; close(), what closing does, run
  // once the pane has slid out; onMove(px), how far out it is, each
  // move; onEnd(closing), the release.
  window.scs.pullTab = function (panel, opts) {
    var dir = opts.edge === 'top' ? -1 : 1;
    var tab = opts.tab;
    var startY = 0, lastY = 0, lastT = 0, vel = 0, out = 0;
    var mode = '';   // 'grab' from the tab, 'wait' for the first move, 'drag', 'native'
    function rubber(excess, limit) { return (1 - 1 / (excess * 0.55 / limit + 1)) * limit; }
    function shape(name, stretch) {
      tab.classList.toggle('is-vee', name === 'vee');
      tab.classList.toggle('is-up', name === 'up');
      tab.classList.toggle('is-stretching', stretch > 1);
      tab.style.setProperty('--stretch', String(stretch));
    }
    function clear() {
      panel.style.transition = '';
      panel.style.transform = '';
    }
    function begin() {
      mode = 'drag';
      panel.style.transition = 'none';
    }
    function start(y, grabbed) {
      if (opts.active && !opts.active()) { mode = ''; return; }
      startY = lastY = y;
      lastT = Date.now();
      vel = 0;
      out = 0;
      mode = grabbed ? 'grab' : 'wait';
    }
    function move(y, e) {
      if (!mode || mode === 'native') return;
      if (mode === 'wait') {
        var scroller = opts.scroller || panel;
        var atEdge = dir > 0 ? scroller.scrollTop <= 0
          : scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1;
        if (!((y - startY) * dir > 0 && atEdge)) { mode = 'native'; return; }
        begin();
      } else if (mode === 'grab') {
        begin();
      }
      if (e && e.cancelable) e.preventDefault();
      var now = Date.now();
      vel = 0.8 * ((y - lastY) / Math.max(1, now - lastT)) + 0.2 * vel;
      lastY = y;
      lastT = now;
      var d = (y - startY) * dir;
      if (d >= 0) {
        out = d;
        if (Math.abs(vel) > 0.05) shape(vel > 0 ? 'vee' : 'up', 1);
      } else {
        var band = rubber(-d, 48);
        out = -band;
        shape('', 1 + (band / 48) * 0.35);
      }
      panel.style.transform = 'translateY(' + (out * dir) + 'px)';
      if (opts.onMove) opts.onMove(Math.max(0, out));
    }
    function end() {
      if (mode !== 'drag') { mode = ''; return; }
      mode = '';
      var h = panel.offsetHeight || 1;
      var closing = out > h / 3 || (vel * dir > 0.5 && out > 12);
      shape('', 1);
      var reduced = window.scs.reducedMotion;
      if (opts.onEnd) opts.onEnd(closing);
      if (closing) {
        panel.style.transition = reduced ? 'none' : 'transform 200ms cubic-bezier(0.22, 1, 0.36, 1)';
        panel.style.transform = 'translateY(' + (dir * (h + 24)) + 'px)';
        window.setTimeout(function () {
          opts.close();
          // it is gone by now, so its own styles can come back
          window.setTimeout(clear, 400);
        }, reduced ? 0 : 200);
      } else {
        panel.style.transition = reduced ? 'none' : 'transform 300ms cubic-bezier(0.22, 1.25, 0.36, 1)';
        panel.style.transform = '';
        window.setTimeout(function () { if (!mode) panel.style.transition = ''; }, 320);
      }
    }
    function grabbedBy(target) {
      return !!(target && (tab.contains(target) || (opts.handle && opts.handle.contains(target))));
    }
    panel.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { mode = ''; return; }
      start(e.touches[0].clientY, grabbedBy(e.target));
    }, { passive: true });
    panel.addEventListener('touchmove', function (e) {
      if (e.touches.length !== 1) return;
      move(e.touches[0].clientY, e);
    }, { passive: false });
    panel.addEventListener('touchend', end);
    panel.addEventListener('touchcancel', end);
    // a mouse drags it by the tab alone
    tab.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      e.preventDefault();
      start(e.clientY, true);
      function onMove(ev) { move(ev.clientY, null); }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        end();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    return { tab: tab };
  };

  // A full-screen preview instead of leaving the page: photos and
  // videos open over the content, close on tap, Escape or the
  // system back. media = [{url, type, name}], index picks which.
  // opts.advance moves on by itself every that many ms (the home
  // page's photos), opts.onShow(i) hears each change, opts.onClose()
  // the closing, and opts.originFor(i) is what photo i shrinks back
  // into on closing. opts.shareUrl(i), when given, is photo i's own
  // link, and a Share button sends it; opts.downloadUrl(i) is where
  // a Download button saves photo i from, or a list of {url, label}
  // when there is a choice of file, which the button opens as a menu.
  // An item's thumb is the small copy the page already shows: a photo
  // opens on it and its viewing copy takes its place once loaded, and a
  // video shows it until it plays.
  // A video item with sizes
  // (scsVideo.sizes) plays through video-sizes.js, with a menu of them;
  // a photo item with full has that whole picture swapped in on a zoom,
  // or as soon as it opens with opts.whole. opts.info(i), when given,
  // puts a Details button up that opens a panel beside the photo: it
  // answers a promise of rows, {icon, title, lines, href, link}.
  // A list that comes a page at a time passes opts.total() for the
  // count and opts.more(), a promise that settles once the next page
  // is on the end of media (the same array): the viewer asks for it
  // as it nears the last one in, and goes round only when every item
  // is in.
  window.scs.lightbox = function (media, index, origin, opts) {
    opts = opts || {};
    var old = document.querySelector('.lb-overlay');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var at = Math.max(0, Math.min(media.length - 1, index || 0));
    // the thumbnail that was tapped: the photo grows out of it on
    // the way in and shrinks back into it on the way out
    var originEl = origin && origin.getBoundingClientRect ? origin : null;
    var originAt = at;
    var shownOnce = false;
    var reduced = window.scs.reducedMotion;
    var overlay = document.createElement('div');
    overlay.className = 'lb-overlay';
    // The photo's own area: the whole screen, with room kept top and
    // bottom for the controls. The file name sits
    // top left and the buttons top right, floating over the photo
    // in a layer of their own, so a zoomed photo never covers them.
    var frame = document.createElement('figure');
    frame.className = 'lb-frame';
    var bar = document.createElement('div');
    bar.className = 'lb-bar';
    var barInner = document.createElement('div');
    barInner.className = 'lb-bar-inner';
    function totalCount() { return opts.total ? Math.max(opts.total() || 0, media.length) : media.length; }
    var counter = document.createElement('span');
    counter.className = 'lb-counter';
    if (totalCount() < 2) counter.hidden = true;
    var caption = document.createElement('span');
    caption.className = 'lb-caption';
    barInner.appendChild(caption);
    barInner.appendChild(counter);
    bar.appendChild(barInner);
    var topLayer = document.createElement('div');
    topLayer.className = 'lb-top';
    var topInner = document.createElement('div');
    topInner.className = 'lb-bar-inner';
    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'lb-close';
    close.setAttribute('aria-label', 'Close');
    // a drawn cross centres exactly; a glyph never quite does
    close.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    var sizeSlot = document.createElement('span');
    sizeSlot.className = 'lb-size-slot';
    topInner.appendChild(sizeSlot);
    var sizer = null;
    var download = null;
    var saveMenu = null;
    var saveChoices = null;
    if (opts.downloadUrl) {
      download = document.createElement('a');
      download.className = 'lb-download';
      download.setAttribute('aria-label', 'Download');
      download.setAttribute('download', '');
      download.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';
      topInner.appendChild(download);
      // a choice of file: the button opens a list under the buttons
      saveMenu = document.createElement('div');
      saveMenu.className = 'lb-save-menu';
      saveMenu.hidden = true;
      topInner.appendChild(saveMenu);
      download.addEventListener('click', function (e) {
        if (!saveChoices) return;
        e.preventDefault();
        setSaveMenu(saveMenu.hidden);
      });
    }
    var share = null;
    if (opts.shareUrl) {
      share = document.createElement('button');
      share.type = 'button';
      share.className = 'lb-share';
      share.setAttribute('aria-label', 'Share this photo');
      share.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
      topInner.appendChild(share);
    }
    // the photo's details, in a panel beside it (below it on a phone)
    var infoBtn = null;
    var infoPanel = null;
    var infoBody = null;
    var infoAsked = 0;
    if (opts.info) {
      infoBtn = document.createElement('button');
      infoBtn.type = 'button';
      infoBtn.className = 'lb-info-btn';
      infoBtn.setAttribute('aria-label', 'Details');
      infoBtn.setAttribute('aria-pressed', 'false');
      infoBtn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M11.95 7.5h.1"/></svg>';
      topInner.appendChild(infoBtn);
      infoPanel = document.createElement('aside');
      infoPanel.className = 'lb-info';
      infoPanel.setAttribute('aria-label', 'Details');
      var infoHead = document.createElement('div');
      infoHead.className = 'lb-info-head';
      var infoTitle = document.createElement('h2');
      infoTitle.textContent = 'Details';
      var infoClose = document.createElement('button');
      infoClose.type = 'button';
      infoClose.className = 'lb-info-close';
      infoClose.setAttribute('aria-label', 'Close details');
      infoClose.innerHTML = close.innerHTML;
      infoHead.appendChild(infoTitle);
      infoHead.appendChild(infoClose);
      infoBody = document.createElement('div');
      infoBody.className = 'lb-info-body';
      // on a phone the panel is a sheet, dragged down by its tab to close
      var infoTab = document.createElement('div');
      infoTab.className = 'pull-tab lb-info-tab';
      infoTab.setAttribute('aria-hidden', 'true');
      infoPanel.appendChild(infoTab);
      infoPanel.appendChild(infoHead);
      infoPanel.appendChild(infoBody);
      infoClose.addEventListener('click', function () { setInfo(false); });
      var sheetForm = window.matchMedia ? window.matchMedia('(max-width: 760px)') : null;
      var frameLoose = function () {
        frame.style.transition = '';
        frame.style.bottom = '';
      };
      window.scs.pullTab(infoPanel, {
        tab: infoTab,
        handle: infoHead,
        active: function () { return !!(sheetForm && sheetForm.matches) && overlay.classList.contains('has-info'); },
        // the photo grows into the room the sheet gives up
        onMove: function (px) {
          frame.style.transition = 'none';
          frame.style.bottom = 'calc(48vh - ' + px + 'px)';
        },
        onEnd: function (closing) { if (!closing) frameLoose(); },
        close: function () {
          setInfo(false);
          frameLoose();
        }
      });
      infoBtn.addEventListener('click', function () { setInfo(!overlay.classList.contains('has-info')); });
    }
    topInner.appendChild(close);
    topLayer.appendChild(topInner);
    overlay.appendChild(bar);
    overlay.appendChild(frame);
    overlay.appendChild(topLayer);
    if (infoPanel) overlay.appendChild(infoPanel);
    // the site's loading bar, while the whole picture is on its way
    var wholeBar = document.createElement('div');
    wholeBar.className = 'ptr-bar lb-load';
    wholeBar.setAttribute('aria-hidden', 'true');
    var wholeFill = document.createElement('span');
    wholeBar.appendChild(wholeFill);
    overlay.appendChild(wholeBar);

    var layer = null;
    var closed = false;
    var zoomApi = null;  // the slide's zoom, for the keyboard
    // What the reader points with decides the gestures: a finger gets
    // the tap-for-a-black-screen and the swipe to dismiss, a mouse
    // gets neither — a click zooms where it landed, the way every
    // picture viewer on a computer works, and dragging a photo that
    // is not zoomed does nothing.
    var mouse = !handheld();
    if (mouse) overlay.classList.add('is-mouse');

    // The name and the buttons follow a swipe on the photo, lifting
    // in step with the finger, and come back with it if the swipe is
    // let go early.
    function pullChrome(dy) {
      var away = Math.abs(dy);
      bar.style.transform = away ? 'translateY(' + (-away * 0.6) + 'px)' : '';
      topLayer.style.transform = bar.style.transform;
    }
    function chromeDragging(on) {
      overlay.classList.toggle('is-chrome-dragging', on);
    }

    // A photo or a video leaving the screen gives up its picture at
    // once rather than whenever the page next tidies its memory: a
    // whole photo decoded is tens of megabytes, and a phone looking
    // through an album ran out.
    function letGo(box) {
      var gone = box.querySelectorAll('img, video');
      for (var g = 0; g < gone.length; g++) {
        var el = gone[g];
        if (el.tagName === 'VIDEO') {
          try { el.pause(); } catch (err) { /* already stopped */ }
          el.removeAttribute('src');
          while (el.firstChild) el.removeChild(el.firstChild);
          try { el.load(); } catch (err) { /* nothing left to load */ }
        } else {
          el.removeAttribute('src');
        }
      }
    }

    // whether shrinking back into the tapped thumbnail makes sense:
    // same slide, not zoomed, and the thumbnail still on screen
    function originOf(i) {
      if (opts.originFor) {
        var el = opts.originFor(i);
        return el && el.getBoundingClientRect ? el : null;
      }
      return i === originAt ? originEl : null;
    }
    function morphBackTarget() {
      var backEl = originOf(at);
      if (reduced || !backEl) return null;
      if (frame.style.transform) return null; // a swipe is carrying it away
      if (overlay.classList.contains('is-immersive')) return null;
      var img = frame.querySelector('img.lb-media');
      if (!img || img.classList.contains('is-zoomed')) return null;
      if (!backEl.isConnected) return null;
      var r = backEl.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > window.innerHeight) return null;
      return r;
    }
    function dismiss(viaBack) {
      if (closed) return;
      closed = true;
      holdAdvance();
      endWhole(false);
      if (opts.onClose) opts.onClose(at);
      var playing = frame.querySelector('video');
      if (playing) playing.pause();
      var wait = reduced ? 0 : 240;
      var back = morphBackTarget();
      var morph = null;
      if (back) {
        var img = frame.querySelector('img.lb-media');
        var last = img.getBoundingClientRect();
        if (last.width) {
          img.classList.add('lb-morphing');
          morph = img.animate([
            { transform: 'none' },
            { transform: 'translate(' + ((back.left + back.width / 2) - (last.left + last.width / 2)) + 'px, ' +
              ((back.top + back.height / 2) - (last.top + last.height / 2)) + 'px) ' +
              'scale(' + (back.width / last.width) + ', ' + (back.height / last.height) + ')' }
          ], { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });
        }
      }
      // the name and the buttons lift off the top with the photo, the
      // way they arrived
      chromeDragging(false);
      bar.style.transform = '';
      topLayer.style.transform = '';
      // a swipe left the backdrop part faded: it fades on from there
      overlay.classList.add('is-leaving');
      overlay.style.opacity = '';
      window.setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        if (!document.querySelector('.lb-overlay')) document.documentElement.classList.remove('lb-open', 'lb-info-on');
        if (morph) morph.cancel();
        if (sizer) { sizer.destroy(); sizer = null; }
        letGo(frame);
        dropWhole();
      }, wait);
      document.removeEventListener('keydown', onKey);
      if (!viaBack && layer && window.scsBackLayer) window.scsBackLayer.disarm(layer);
    }

    // One tap on the photo puts it alone on a black screen: the name,
    // the buttons and the arrows leave, and the photo takes the whole
    // screen. Another tap brings everything back. A swipe still
    // dismisses the lot.
    function setImmersive(on) {
      if (on === overlay.classList.contains('is-immersive')) return;
      overlay.classList.toggle('is-immersive', on);
    }
    // zoomed, the photo has the screen and the name steps out of its way
    function setZoomed(on) {
      if (on === overlay.classList.contains('is-zoomed')) return;
      overlay.classList.toggle('is-zoomed', on);
      if (on) holdAdvance(); else planAdvance();
    }

    function setSaveMenu(on) {
      if (!saveMenu) return;
      if (!on || !saveChoices) {
        saveMenu.hidden = true;
        if (saveChoices) download.setAttribute('aria-expanded', 'false');
        return;
      }
      saveMenu.textContent = '';
      saveChoices.forEach(function (c) {
        var a = document.createElement('a');
        a.href = c.url;
        a.setAttribute('download', '');
        a.textContent = c.label;
        a.addEventListener('click', function () { window.setTimeout(function () { setSaveMenu(false); }, 0); });
        saveMenu.appendChild(a);
      });
      saveMenu.hidden = false;
      download.setAttribute('aria-expanded', 'true');
    }

    function setInfo(on) {
      if (!infoPanel || on === overlay.classList.contains('has-info')) return;
      overlay.classList.toggle('has-info', on);
      document.documentElement.classList.toggle('lb-info-on', on);
      infoBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) fillInfo();
    }
    function infoLine(cls, text) {
      var p = document.createElement('p');
      p.className = cls;
      p.textContent = text;
      return p;
    }
    // the open panel shows the photo on screen; an answer for a photo
    // since stepped past is dropped
    function fillInfo() {
      if (!infoPanel || !overlay.classList.contains('has-info')) return;
      var asked = ++infoAsked;
      infoBody.textContent = '';
      infoBody.appendChild(infoLine('lb-info-note', 'Loading…'));
      var answer = null;
      try { answer = opts.info(at); } catch (err) { answer = null; }
      Promise.resolve(answer).then(function (rows) {
        if (asked !== infoAsked) return;
        infoBody.textContent = '';
        if (!rows || !rows.length) {
          infoBody.appendChild(infoLine('lb-info-note', 'No details for this one.'));
          return;
        }
        rows.forEach(function (r) {
          var row = document.createElement('div');
          row.className = 'lb-info-row';
          var icon = document.createElement('span');
          icon.className = 'lb-info-icon';
          icon.innerHTML = r.icon || '';
          var text = document.createElement('div');
          text.className = 'lb-info-text';
          text.appendChild(infoLine('lb-info-title', r.title || ''));
          (r.lines || []).forEach(function (line) { if (line) text.appendChild(infoLine('lb-info-line', line)); });
          if (r.href) {
            var a = document.createElement('a');
            a.className = 'lb-info-link';
            a.href = r.href;
            a.target = '_blank';
            a.rel = 'noopener';
            a.textContent = r.link || r.href;
            text.appendChild(a);
          }
          row.appendChild(icon);
          row.appendChild(text);
          infoBody.appendChild(row);
        });
      }, function () {
        if (asked !== infoAsked) return;
        infoBody.textContent = '';
        infoBody.appendChild(infoLine('lb-info-note', 'Could not load the details.'));
      });
    }

    // Moving on by itself, for a run of photos shown as a slideshow.
    // A photo's time starts once it has loaded, and nothing moves
    // while it is zoomed, while a finger is on it, or while the page
    // is out of sight. Any change by hand starts the time again.
    var advanceMs = opts.advance > 0 && media.length > 1 && !reduced ? opts.advance : 0;
    var advanceTimer = null;
    function holdAdvance() {
      if (advanceTimer) { window.clearTimeout(advanceTimer); advanceTimer = null; }
    }
    function planAdvance() {
      holdAdvance();
      if (!advanceMs || closed || overlay.classList.contains('is-zoomed')) return;
      var img = frame.querySelector('img.lb-media');
      if (!img) return;
      function wait() {
        if (closed || !img.isConnected) return;
        holdAdvance();
        advanceTimer = window.setTimeout(function () {
          advanceTimer = null;
          if (closed || !img.isConnected) return;
          if (document.hidden || overlay.classList.contains('is-zoomed')) { wait(); return; }
          step(1);
        }, advanceMs);
      }
      if (img.complete && img.naturalWidth) wait();
      else {
        img.addEventListener('load', wait);
        img.addEventListener('error', wait);
      }
    }

    // Pinch, wheel and double-tap zoom on a photo, with panning
    // while zoomed — all in place, never a new tab. The transform
    // scales about the centre; zoomAt keeps the point under the
    // finger or cursor where it is. Videos keep their controls and
    // native behaviour. A fresh slide starts back at 1. photo-view.js
    // carries a copy for the worker's file pages.
    function armZoom(img, onZoom) {
      var scale = 1, tx = 0, ty = 0;
      var pointers = {};
      var count = 0;
      var startDist = 0, startScale = 1;
      var panX = 0, panY = 0;
      var moved = 0;
      var lastTap = 0, lastTapX = 0, lastTapY = 0;
      var tapTimer = null;
      // dragging an unzoomed photo up or down carries the whole
      // frame with the finger and thins the backdrop, the way the
      // quest sheet goes; past the threshold the release closes
      var swiping = false;
      var swipeDy = 0;
      // dragging it sideways carries it off to the next or the last
      // photo instead, past a fifth of the screen or on a flick
      var sliding = false;
      var slideDx = 0;
      var downAt = 0;

      function settleSwipe(closeIt) {
        frame.classList.remove('is-dragging');
        if (closeIt) {
          frame.style.transform = 'translateY(' + (swipeDy > 0 ? 90 : -90) + 'vh)';
          dismiss(false);
        } else {
          frame.style.transform = '';
          overlay.style.opacity = '';
          chromeDragging(false);
          pullChrome(0);
        }
        swiping = false;
        swipeDy = 0;
      }

      function forget() {
        for (var id in pointers) delete pointers[id];
        count = 0;
        if (swiping) settleSwipe(false);
        if (sliding) { sliding = false; slideDx = 0; frame.classList.remove('is-dragging'); frame.style.transform = ''; }
        pinched = false;
        held = false;
      }

      function settleSlide() {
        var w = window.innerWidth || 1;
        var quick = Date.now() - downAt < 300 && Math.abs(slideDx) > 44;
        var dir = Math.abs(slideDx) > w * 0.2 || quick ? (slideDx < 0 ? 1 : -1) : 0;
        frame.classList.remove('is-dragging');
        sliding = false;
        slideDx = 0;
        if (!dir) { frame.style.transform = ''; planAdvance(); return; }
        if (reduced) { frame.style.transform = ''; step(dir); return; }
        frame.style.transform = 'translateX(' + (-dir * w) + 'px)';
        window.setTimeout(function () {
          if (closed) return;
          frame.classList.add('is-dragging');
          frame.style.transform = '';
          step(dir);
          void frame.offsetWidth;
          frame.classList.remove('is-dragging');
        }, 200);
      }

      img.draggable = false;

      // A finger on the photo moves it directly; a double tap or a
      // wheel step is a jump, so those glide there over a short
      // transition instead of snapping. The transition comes off
      // after it has run, so the next pinch or pan is direct again.
      var glideTimer = null;
      function glide(ms) {
        if (glideTimer) { clearTimeout(glideTimer); glideTimer = null; }
        if (!ms || reduced) { img.style.transition = ''; return; }
        img.style.transition = 'transform ' + ms + 'ms cubic-bezier(0.22, 1, 0.36, 1)';
        glideTimer = setTimeout(function () {
          glideTimer = null;
          img.style.transition = '';
        }, ms + 20);
      }

      // The feel of a phone's own photo viewer. Past an edge, or past
      // the smallest or largest size, the photo gives on a rubber band
      // and springs back when let go. A pan let go while moving carries
      // on and slows, and one that runs into an edge stops on a spring
      // there. Two fingers keep the point of the photo between them
      // under them, so a pinch moves the photo as well as sizing it.
      var MAX_SCALE = 5;
      var BAND = 0.55;          // how hard the rubber band pulls
      var DECEL = 0.998;        // the momentum kept each millisecond
      var SPRING = 0.012;       // the edge spring's rate, each millisecond
      var fling = 0;
      var lim = null;           // the pan's bounds while a finger is down
      var rawX = 0, rawY = 0;   // where the finger has put it, before the band
      var trail = [];           // where it has been lately, for the speed on release
      var pinchQ = null;        // the point of the photo the pinch holds
      var pinchC = null;
      var lastMid = null;
      var pinched = false;
      var held = false;         // the finger left on a pinch that is springing back
      var caught = false;       // the finger that went down stopped a fling
      var zoomedNow = false;

      function band(over, dim) { return (1 - 1 / (over * BAND / dim + 1)) * dim; }
      function unband(shown, dim) {
        var f = Math.min(shown / dim, 0.95);
        return dim / BAND * (1 / (1 - f) - 1);
      }
      function banded(raw, lo, hi, dim) {
        return raw > hi ? hi + band(raw - hi, dim) : raw < lo ? lo - band(lo - raw, dim) : raw;
      }
      function unbanded(pos, lo, hi, dim) {
        return pos > hi ? hi + unband(pos - hi, dim) : pos < lo ? lo - unband(lo - pos, dim) : pos;
      }
      // the photo's middle on screen before any transform, and the frame
      function centre() {
        var fr = frame.getBoundingClientRect();
        return { x: fr.left + img.offsetLeft + img.offsetWidth / 2, y: fr.top + img.offsetTop + img.offsetHeight / 2, fr: fr };
      }
      // how far it may move at scale s: along a side it does not fill
      // it stays in the middle, and along one it overfills it goes
      // until its edge meets the frame's
      function limits(s) {
        var c = centre();
        function axis(lo, hi, mid, size) {
          var span = s * size;
          return span <= hi - lo ? [0, 0] : [hi - mid - span / 2, lo - mid + span / 2];
        }
        return {
          x: axis(c.fr.left, c.fr.right, c.x, img.offsetWidth),
          y: axis(c.fr.top, c.fr.bottom, c.y, img.offsetHeight),
          w: c.fr.width || 1,
          h: c.fr.height || 1
        };
      }
      function render() {
        img.style.transform = scale === 1 && !tx && !ty ? '' : 'translate(' + tx + 'px, ' + ty + 'px) scale(' + scale + ')';
        var on = scale > 1.01;
        if (on !== zoomedNow) {
          zoomedNow = on;
          img.classList.toggle('is-zoomed', on);
          setZoomed(on);
        }
        if (on && onZoom) { onZoom(); onZoom = null; }
      }
      function stopFling() {
        if (fling) { window.cancelAnimationFrame(fling); fling = 0; }
      }
      function apply(ms) {
        stopFling();
        glide(ms);
        if (scale < 1.02) {
          scale = 1; tx = 0; ty = 0;
        } else {
          var l = limits(scale);
          tx = Math.min(l.x[1], Math.max(l.x[0], tx));
          ty = Math.min(l.y[1], Math.max(l.y[0], ty));
        }
        render();
      }
      function zoomAt(cx, cy, next, ms) {
        next = Math.max(1, Math.min(MAX_SCALE, next));
        if (next === scale) return;
        var c = centre();
        var c0x = c.x;
        var c0y = c.y;
        var r = next / scale;
        tx = (cx - c0x) * (1 - r) + r * tx;
        ty = (cy - c0y) * (1 - r) + r * ty;
        scale = next;
        apply(ms);
      }
      function pinchState() {
        var ids = Object.keys(pointers);
        var a = pointers[ids[0]];
        var b = pointers[ids[1]];
        return {
          dist: Math.max(24, Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y))),
          midX: (a.x + b.x) / 2,
          midY: (a.y + b.y) / 2
        };
      }

      // a pan from wherever the photo is now, on the band or not
      function beginPan(x, y) {
        stopFling();
        glide(0);
        panX = x; panY = y;
        lim = limits(scale);
        rawX = unbanded(tx, lim.x[0], lim.x[1], lim.w);
        rawY = unbanded(ty, lim.y[0], lim.y[1], lim.h);
        trail = [{ t: Date.now(), x: tx, y: ty }];
      }
      // how fast it was going over the last tenth of a second, in
      // pixels a millisecond; nothing if the finger had stopped
      function speed() {
        var now = Date.now();
        var recent = trail.filter(function (p) { return now - p.t < 100; });
        if (recent.length < 2) return { x: 0, y: 0 };
        var a = recent[0];
        var b = recent[recent.length - 1];
        var dt = Math.max(10, b.t - a.t);
        return { x: (b.x - a.x) / dt, y: (b.y - a.y) / dt };
      }
      // Let go: the momentum carries on and slows, and anything past an
      // edge comes back to it on a spring that does not overshoot.
      function throwPan(v) {
        stopFling();
        glide(0);
        if (reduced) { apply(0); return; }
        var l = limits(scale);
        var axes = [
          { pos: tx, v: v.x, lo: l.x[0], hi: l.x[1], done: false },
          { pos: ty, v: v.y, lo: l.y[0], hi: l.y[1], done: false }
        ];
        function stepAxis(a, dt) {
          if (a.done) return;
          var edge = a.pos < a.lo ? a.lo : a.pos > a.hi ? a.hi : null;
          if (edge === null) {
            a.v *= Math.pow(DECEL, dt);
            a.pos += a.v * dt;
            if (Math.abs(a.v) < 0.01 && a.pos >= a.lo && a.pos <= a.hi) a.done = true;
            return;
          }
          a.v += (-SPRING * SPRING * (a.pos - edge) - 2 * SPRING * a.v) * dt;
          a.pos += a.v * dt;
          var home = edge === a.lo ? a.pos >= a.lo : a.pos <= a.hi;
          if (home || (Math.abs(a.pos - edge) < 0.5 && Math.abs(a.v) < 0.02)) {
            a.pos = edge;
            a.v = 0;
            a.done = true;
          }
        }
        var last = window.performance.now();
        function tick(now) {
          var dt = Math.min(64, now - last);
          last = now;
          for (var t = 0; t < dt; t += 4) {
            stepAxis(axes[0], Math.min(4, dt - t));
            stepAxis(axes[1], Math.min(4, dt - t));
          }
          tx = axes[0].pos;
          ty = axes[1].pos;
          render();
          fling = axes[0].done && axes[1].done ? 0 : window.requestAnimationFrame(tick);
        }
        fling = window.requestAnimationFrame(tick);
      }
      // a pinch let go: back within its sizes with the point between
      // the fingers held where it was, then within its edges
      function settle(ms) {
        stopFling();
        var s = Math.max(1, Math.min(MAX_SCALE, scale));
        if (s < 1.02) {
          scale = 1; tx = 0; ty = 0;
        } else {
          if (s !== scale && lastMid) {
            var c = centre();
            var qx = (lastMid.x - c.x - tx) / scale;
            var qy = (lastMid.y - c.y - ty) / scale;
            scale = s;
            tx = lastMid.x - c.x - s * qx;
            ty = lastMid.y - c.y - s * qy;
          }
          var l = limits(scale);
          tx = Math.min(l.x[1], Math.max(l.x[0], tx));
          ty = Math.min(l.y[1], Math.max(l.y[0], ty));
        }
        glide(ms);
        render();
      }
      img.addEventListener('wheel', function (e) {
        e.preventDefault();
        zoomAt(e.clientX, e.clientY, scale * (e.deltaY < 0 ? 1.25 : 0.8), 120);
      }, { passive: false });

      img.addEventListener('pointerdown', function (e) {
        // a first finger down means no other is down: a touch whose end
        // never came (the system took it for the home bar or Control
        // Centre) is let go here rather than counted for good, which
        // left a tap or a swipe on the photo doing nothing
        if (e.isPrimary && count) forget();
        pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        count = Object.keys(pointers).length;
        moved = 0;
        downAt = Date.now();
        holdAdvance();
        try { img.setPointerCapture(e.pointerId); } catch (err) { /* mouse without capture still pans */ }
        if (count === 1) {
          caught = !!fling;
          pinched = false;
          held = false;
          beginPan(e.clientX, e.clientY);
        } else if (count === 2) {
          stopFling();
          pinched = true;
          trail = [];
          var p = pinchState();
          startDist = p.dist;
          startScale = scale;
          pinchC = centre();
          pinchQ = { x: (p.midX - pinchC.x - tx) / scale, y: (p.midY - pinchC.y - ty) / scale };
          lastMid = { x: p.midX, y: p.midY };
        }
        if (scale > 1) e.preventDefault();
      });
      img.addEventListener('pointermove', function (e) {
        var p = pointers[e.pointerId];
        if (!p) return;
        moved += Math.abs(e.clientX - p.x) + Math.abs(e.clientY - p.y);
        p.x = e.clientX; p.y = e.clientY;
        if (count === 2) {
          if (swiping) settleSwipe(false);
          if (sliding) { sliding = false; slideDx = 0; frame.classList.remove('is-dragging'); frame.style.transform = ''; }
          var pin = pinchState();
          // past 1 and past the largest size it gives, in steps of size
          var size = Math.log(startScale * (pin.dist / startDist));
          var top = Math.log(MAX_SCALE);
          if (size > top) size = top + band(size - top, 0.4);
          else if (size < 0) size = -band(-size, 0.5);
          scale = Math.exp(size);
          tx = pin.midX - pinchC.x - scale * pinchQ.x;
          ty = pin.midY - pinchC.y - scale * pinchQ.y;
          lastMid = { x: pin.midX, y: pin.midY };
          glide(0);
          render();
        } else if (count === 1 && scale > 1) {
          if (held) return;
          tx = banded(rawX + (e.clientX - panX), lim.x[0], lim.x[1], lim.w);
          ty = banded(rawY + (e.clientY - panY), lim.y[0], lim.y[1], lim.h);
          trail.push({ t: Date.now(), x: tx, y: ty });
          if (trail.length > 12) trail.shift();
          render();
        } else if (count === 1 && !mouse && !pinched) {
          var dy = e.clientY - panY;
          var dx = e.clientX - panX;
          if (!swiping && !sliding && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
            swiping = true;
            frame.classList.add('is-dragging');
            chromeDragging(true);
          } else if (!swiping && !sliding && media.length > 1 && Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) {
            sliding = true;
            frame.classList.add('is-dragging');
          }
          if (sliding) {
            e.preventDefault();
            slideDx = dx;
            frame.style.transform = 'translateX(' + dx + 'px)';
          } else if (swiping) {
            e.preventDefault();
            swipeDy = dy;
            frame.style.transform = 'translateY(' + dy + 'px)';
            overlay.style.opacity = String(Math.max(0.3, 1 - Math.abs(dy) / 380));
            pullChrome(dy);
          }
        }
      });
      function release(e) {
        if (!pointers[e.pointerId]) return;
        delete pointers[e.pointerId];
        count = Object.keys(pointers).length;
        if (swiping && count === 0) {
          settleSwipe(Math.abs(swipeDy) > 90);
          return;
        }
        if (sliding && count === 0) {
          settleSlide();
          return;
        }
        if (count === 0) planAdvance();
        if (count === 1) {
          // one finger left after a pinch: it pans from here, once the
          // photo is back within its sizes
          var ids = Object.keys(pointers);
          if (scale < 1 || scale > MAX_SCALE) { held = true; settle(300); }
          else beginPan(pointers[ids[0]].x, pointers[ids[0]].y);
          return;
        }
        if (count !== 0) return;
        if (pinched) {
          pinched = false;
          if (held || scale < 1 || scale > MAX_SCALE) settle(300);
          else if (scale > 1) throwPan(speed());
          held = false;
          return;
        }
        if (scale > 1 && (moved >= 14 || caught || e.type !== 'pointerup')) {
          // a pan let go, or a fling stopped by a touch
          throwPan(moved >= 14 ? speed() : { x: 0, y: 0 });
          return;
        }
        if (count === 0 && moved < 14 && e.type === 'pointerup' && mouse) {
          // A click zooms in where it landed and a second click zooms
          // back out. No waiting to find out whether a second click
          // is coming, and no black-screen toggle: on a computer a
          // click on a photo means zoom.
          if (scale > 1) { scale = 1; tx = 0; ty = 0; apply(200); }
          else zoomAt(e.clientX, e.clientY, 2.5, 200);
          return;
        }
        if (count === 0 && moved < 14 && e.type === 'pointerup') {
          var now = Date.now();
          var near = Math.abs(e.clientX - lastTapX) < 40 && Math.abs(e.clientY - lastTapY) < 40;
          if (now - lastTap < 320 && near) {
            // a double tap: in to 2.5 where it landed, or back out,
            // gliding either way — and never the single tap's toggle
            if (tapTimer) { clearTimeout(tapTimer); tapTimer = null; }
            if (scale > 1) { scale = 1; tx = 0; ty = 0; apply(280); }
            else zoomAt(e.clientX, e.clientY, 2.5, 280);
            lastTap = 0;
          } else {
            lastTap = now; lastTapX = e.clientX; lastTapY = e.clientY;
            // a single tap toggles the black screen, once it is clear
            // no second tap is coming
            if (tapTimer) clearTimeout(tapTimer);
            tapTimer = setTimeout(function () {
              tapTimer = null;
              setImmersive(!overlay.classList.contains('is-immersive'));
            }, 330);
          }
        }
      }
      img.addEventListener('pointerup', release);
      img.addEventListener('pointercancel', release);

      // what the keyboard drives: + and - step about the middle of
      // the screen, 0 puts the photo back where it started
      zoomApi = {
        step: function (factor) {
          zoomAt(window.innerWidth / 2, window.innerHeight / 2, scale * factor, 160);
        },
        reset: function () {
          if (scale === 1) return;
          scale = 1; tx = 0; ty = 0;
          apply(200);
        }
      };
    }

    // the photo grows out of the tapped thumbnail: measured once the
    // full image is there to measure, skipped if it is slow so the
    // morph never plays on an empty box
    function morphIn(node) {
      if (reduced || !originEl) return;
      function run() {
        var first = originEl.getBoundingClientRect();
        var last = node.getBoundingClientRect();
        if (!first.width || !last.width) return;
        node.classList.add('lb-morphing');
        var anim = node.animate([
          { transform: 'translate(' + ((first.left + first.width / 2) - (last.left + last.width / 2)) + 'px, ' +
            ((first.top + first.height / 2) - (last.top + last.height / 2)) + 'px) ' +
            'scale(' + (first.width / last.width) + ', ' + (first.height / last.height) + ')' },
          { transform: 'none' }
        ], { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
        anim.onfinish = function () { node.classList.remove('lb-morphing'); };
      }
      if (node.complete && node.naturalWidth) { window.setTimeout(run, 0); return; } // measured after the overlay lands
      var missed = window.setTimeout(function () {
        node.removeEventListener('load', onLoad);
      }, 350);
      function onLoad() {
        window.clearTimeout(missed);
        // once: the whole picture swapped in on a zoom loads again
        node.removeEventListener('load', onLoad);
        run();
      }
      node.addEventListener('load', onLoad);
    }

    // A zoomed photo swaps its viewing copy for the whole picture
    // once that has loaded, so the zoom shows what the camera took.
    // The loading bar runs while it comes: as far as the download has
    // got where the answer gives its length, creeping where it does
    // not, and not at all for one that lands inside the wait (from a
    // cache). It is read as a blob so the bytes can be counted.
    var wholeJob = null;   // the photo on screen's download
    var wholeShown = '';   // the object URL that photo is showing
    var wholeFade = 0;
    function fillTo(part) { wholeFill.style.width = (part * 100).toFixed(1) + '%'; }
    function endWhole(landed) {
      var job = wholeJob;
      if (!job) return;
      wholeJob = null;
      job.over = true;
      window.clearTimeout(job.wait);
      window.clearInterval(job.creep);
      if (!landed && job.abort) job.abort.abort();
      if (!job.shown) return;
      if (landed) fillTo(1);
      // a landed fill reaches the end before the bar goes
      wholeFade = window.setTimeout(function () {
        wholeBar.classList.remove('is-going');
      }, landed && !reduced ? site.LOAD_STEP : 0);
    }
    // leaving a photo: its download stops and its copy is let go
    function dropWhole() {
      endWhole(false);
      if (wholeShown) { URL.revokeObjectURL(wholeShown); wholeShown = ''; }
    }
    function sharpen(img, src) {
      endWhole(false);
      var job = { over: false, shown: false, sized: false, part: 0, wait: 0, creep: 0, abort: null };
      wholeJob = job;
      function creep() {
        job.part = site.creepOn(job.part);
        fillTo(job.part);
      }
      function progress(part) {
        job.part = Math.max(job.part, part);
        if (job.shown) fillTo(job.part);
      }
      job.wait = window.setTimeout(function () {
        job.shown = true;
        window.clearTimeout(wholeFade);
        wholeFill.style.transition = 'none';
        fillTo(job.part);
        void wholeFill.offsetWidth;
        wholeFill.style.transition = '';
        wholeBar.classList.add('is-going');
        if (job.sized) return;
        creep();
        job.creep = window.setInterval(creep, site.LOAD_STEP);
      }, site.LOAD_WAIT);
      // decoded before it goes in, so the swap does not flash
      function land(url, own) {
        var probe = new Image();
        if (!own) probe.crossOrigin = 'anonymous';
        probe.onload = function () {
          var put = function () {
            probe.onload = probe.onerror = null;
            probe.removeAttribute('src');
            if (job.over || !img.isConnected) {
              if (own) URL.revokeObjectURL(url);
              if (!job.over) endWhole(false);
              return;
            }
            var was = wholeShown;
            wholeShown = own ? url : '';
            img.src = url;
            if (was) URL.revokeObjectURL(was);
            endWhole(true);
          };
          if (probe.decode) probe.decode().then(put, put); else put();
        };
        probe.onerror = function () {
          if (own) URL.revokeObjectURL(url);
          if (!job.over) endWhole(false);
        };
        probe.src = url;
      }
      if (!window.fetch || !window.URL || !URL.createObjectURL) { land(src, false); return; }
      if (window.AbortController) job.abort = new AbortController();
      var answered = false;
      fetch(src, job.abort ? { signal: job.abort.signal } : {}).then(function (r) {
        answered = true;
        if (job.over) return null;
        if (!r.ok) throw new Error('whole');
        var type = r.headers.get('content-type') || '';
        var total = Number(r.headers.get('content-length')) || 0;
        if (!r.body || !r.body.getReader) return r.blob();
        if (total) {
          job.sized = true;
          window.clearInterval(job.creep);
        }
        var reader = r.body.getReader();
        var parts = [];
        var got = 0;
        function pump() {
          return reader.read().then(function (piece) {
            if (job.over) {
              reader.cancel().catch(function () { /* stopped already */ });
              return null;
            }
            if (piece.done) return new Blob(parts, { type: type });
            parts.push(piece.value);
            got += piece.value.length;
            if (total) progress(Math.min(0.98, got / total));
            return pump();
          });
        }
        return pump();
      }).then(function (blob) {
        if (blob && !job.over) land(URL.createObjectURL(blob), true);
      }).catch(function () {
        if (job.over) return;
        // refused before any answer: asked for the way an img asks
        if (!answered) land(src, false);
        else endWhole(false);
      });
    }

    // a video with nothing that plays yet, or one the encoder gave up on
    // (`skipped`): its still, dimmed, and a line saying so
    function processingView(m) {
      var box = document.createElement('div');
      box.className = 'lb-media lb-processing';
      if (m.still) {
        var still = document.createElement('img');
        still.alt = '';
        still.crossOrigin = 'anonymous';
        still.src = m.still;
        still.addEventListener('error', function () { if (still.parentNode) still.parentNode.removeChild(still); });
        box.appendChild(still);
      }
      var note = document.createElement('p');
      note.className = 'lb-processing-note';
      note.textContent = m.skipped ? 'This video cannot be played here.' : 'Video is processing. Check back soon.';
      box.appendChild(note);
      return box;
    }

    // The small copy is on screen at once, drawn at the frame's size,
    // and the viewing copy goes in once it has loaded and decoded, so
    // the swap does not flash. A small copy that fails gives way to it
    // at once; a whole picture already swapped in is left alone.
    function viewLater(img, url) {
      var early = img.src;
      var probe = new Image();
      probe.crossOrigin = 'anonymous';
      function put() {
        probe.onload = probe.onerror = null;
        if (img.isConnected && img.src === early) img.src = url;
        probe.removeAttribute('src');
      }
      probe.onload = function () {
        if (probe.decode) probe.decode().then(put, put); else put();
      };
      probe.onerror = put;
      img.addEventListener('error', function failed() {
        img.removeEventListener('error', failed);
        if (img.src === early) img.src = url;
      });
      probe.src = url;
    }

    // a photo or video drawn at the frame's size, not its own: an img
    // or video is never drawn larger than its own pixels by max-width
    function fitMedia(node) {
      function fit() {
        var w = node.naturalWidth || node.videoWidth;
        var hh = node.naturalHeight || node.videoHeight;
        if (!w || !hh) return;
        node.style.setProperty('--lb-ratio', String(w / hh));
        node.classList.add('is-fitted');
      }
      node.addEventListener(node.tagName === 'VIDEO' ? 'loadedmetadata' : 'load', fit);
      if (node.tagName === 'VIDEO') node.addEventListener('resize', fit);
      return fit;
    }

    function show(i, dir) {
      at = (i + media.length) % media.length;
      var m = media[at];
      letGo(frame);
      dropWhole();
      frame.textContent = '';
      zoomApi = null; // a video has none; a new photo arms its own
      setZoomed(false);
      var node;
      if (m.processing) {
        node = processingView(m);
      } else if (String(m.type || '').indexOf('video/') === 0) {
        node = document.createElement('video');
        node.controls = true;
        node.autoplay = true;
        node.playsInline = true;
        if (m.thumb) node.poster = m.thumb;
      } else {
        node = document.createElement('img');
        node.alt = m.name || '';
        node.crossOrigin = 'anonymous'; // readable to the worker, so it can keep a copy
        var wholeLater = m.full && m.full !== m.url && !opts.whole;
        armZoom(node, wholeLater ? function () { sharpen(node, m.full); } : null);
      }
      if (!m.processing) node.className = 'lb-media';
      var fitNow = m.processing ? null : fitMedia(node);
      if (sizer) { sizer.destroy(); sizer = null; }
      sizeSlot.textContent = '';
      if (node.tagName === 'VIDEO' && m.sizes && m.sizes.length > 1 && window.scsVideo) {
        sizer = window.scsVideo.play(node, m.sizes, { control: true, className: 'lb-size', note: window.scsToast });
        if (sizer.control) sizeSlot.appendChild(sizer.control);
      } else if (!m.processing) {
        var early = node.tagName === 'IMG' && m.thumb && m.thumb !== m.url;
        node.src = early ? m.thumb : m.url;
        if (early) viewLater(node, m.url);
        if (node.tagName === 'IMG' && opts.whole && m.full && m.full !== m.url) sharpen(node, m.full);
        // a video sent as it was, which this browser may not play
        // (an iPhone's HEVC in Firefox): its still and the line instead
        if (node.tagName === 'VIDEO' && m.still) {
          var played = node;
          played.addEventListener('error', function () {
            if (played.parentNode !== frame) return;
            frame.replaceChild(processingView(m), played);
          });
        }
      }
      frame.appendChild(node);
      if (fitNow && (node.complete || node.readyState >= 1)) fitNow();
      if (at === originAt && node.tagName === 'IMG' && !shownOnce) morphIn(node);
      else if (dir && !reduced && node.animate) {
        node.animate([{ transform: 'translateX(' + (dir * 48) + 'px)' }, { transform: 'none' }],
          { duration: 280, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      }
      shownOnce = true;
      caption.textContent = m.name || '';
      counter.textContent = (at + 1) + ' / ' + totalCount();
      if (opts.more && at >= media.length - 4 && totalCount() > media.length) opts.more();
      if (share) share.hidden = !opts.shareUrl(at);
      if (download) {
        var saveFrom = opts.downloadUrl(at);
        if (Array.isArray(saveFrom)) {
          saveChoices = saveFrom.length > 1 ? saveFrom : null;
          saveFrom = saveFrom.length ? saveFrom[0].url : '';
        } else {
          saveChoices = null;
        }
        setSaveMenu(false);
        download.hidden = !saveFrom;
        if (saveFrom) download.href = saveFrom; else download.removeAttribute('href');
        if (saveChoices) {
          download.setAttribute('aria-haspopup', 'true');
          download.setAttribute('aria-expanded', 'false');
        } else {
          download.removeAttribute('aria-haspopup');
          download.removeAttribute('aria-expanded');
        }
      }
      // the name keeps clear of however many buttons there are
      overlay.style.setProperty('--lb-top-w', topInner.offsetWidth + 'px');
      fillInfo();
      planAdvance();
      if (opts.onShow) opts.onShow(at);
    }
    function step(dir) {
      var to = at + dir;
      if ((to < 0 || to >= media.length) && totalCount() > media.length) {
        if (to < 0 || !opts.more) return;
        var from = at;
        opts.more().then(function () {
          if (!closed && at === from && to < media.length) show(to, dir);
        });
        return;
      }
      show(to, dir);
    }

    if (totalCount() > 1) {
      var prev = document.createElement('button');
      prev.type = 'button';
      prev.className = 'lb-nav lb-prev';
      prev.setAttribute('aria-label', 'Previous');
      prev.textContent = '‹';
      prev.addEventListener('click', function (e) { e.stopPropagation(); step(-1); });
      var next = document.createElement('button');
      next.type = 'button';
      next.className = 'lb-nav lb-next';
      next.setAttribute('aria-label', 'Next');
      next.textContent = '›';
      next.addEventListener('click', function (e) { e.stopPropagation(); step(1); });
      overlay.appendChild(prev);
      overlay.appendChild(next);
    }
    function onKey(e) {
      // a layer opened over the viewer has the keys
      if (e.defaultPrevented || (layer && !window.scsBackLayer.isTop(layer))) return;
      if (e.key === 'Escape') e.preventDefault();
      if (e.key === 'Escape' && saveMenu && !saveMenu.hidden) { setSaveMenu(false); return; }
      if (e.key === 'Escape' && overlay.classList.contains('has-info')) { setInfo(false); return; }
      if (e.key === 'Escape') dismiss(false);
      if ((e.key === 'i' || e.key === 'I') && infoPanel) setInfo(!overlay.classList.contains('has-info'));
      if (e.key === 'ArrowLeft') step(-1);
      if (e.key === 'ArrowRight') step(1);
      // the zoom keys every picture viewer has
      if (!zoomApi) return;
      if (e.key === '+' || e.key === '=') zoomApi.step(1.25);
      else if (e.key === '-' || e.key === '_') zoomApi.step(0.8);
      else if (e.key === '0') zoomApi.reset();
    }
    // With the download menu open, a press anywhere else closes the
    // menu and does nothing more. Caught on the way down, ahead of the
    // photo's own gestures, and the click it ends in goes too.
    var eatClick = false;
    overlay.addEventListener('pointerdown', function (e) {
      eatClick = false;
      if (!saveMenu || saveMenu.hidden) return;
      if (e.target.closest && e.target.closest('.lb-download, .lb-save-menu')) return;
      e.stopPropagation();
      setSaveMenu(false);
      eatClick = true;
    }, true);
    overlay.addEventListener('click', function (e) {
      if (!eatClick) return;
      eatClick = false;
      e.stopPropagation();
      e.preventDefault();
    }, true);
    overlay.addEventListener('click', function (e) {
      // the media itself stays put (a video needs its controls), and
      // so do the name and the buttons — only the backdrop closes
      if (e.target.closest && e.target.closest('.lb-media, .lb-bar, .lb-top, .lb-info')) return;
      dismiss(false);
    });
    close.addEventListener('click', function () { dismiss(false); });
    document.addEventListener('keydown', onKey);
    if (window.scsBackLayer) layer = window.scsBackLayer.arm(function () { dismiss(true); });
    // the phone's own share sheet where there is one, otherwise the
    // link goes on the clipboard
    if (share) {
      share.addEventListener('click', function () {
        var link = opts.shareUrl(at);
        if (!link) return;
        if (navigator.share && handheld()) {
          navigator.share({ url: link }).catch(function () { /* closed without sharing */ });
          return;
        }
        var done = function () { if (window.scsToast) window.scsToast('Link copied'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(link).then(done, function () { window.prompt('Copy this link', link); });
        } else {
          window.prompt('Copy this link', link);
        }
      });
    }
    show(at);
    document.body.appendChild(overlay);
    document.documentElement.classList.add('lb-open');
    document.documentElement.classList.remove('lb-info-on');
  };
});
