/* A photo on the whole screen, for a page without the site's own viewer:
   a shared photo's page on the tab worker loads it from the site. It
   moves the way the site's viewer does (scs.lightbox in site-viewer.js): a
   pinch or a double tap zooms, a zoomed photo pans to its edges, gives
   on a rubber band past them and carries on when thrown, one tap leaves
   the photo alone on black, a swipe up or down closes it, and a mouse
   clicks to zoom about the point clicked. The zoom is a copy of the
   lightbox's armZoom; a fix to one goes in the other.

   SCSPhotoView.open({src, alt, caption, ratio, origin, buttons, onClose})
   answers {swap(url), close()}. `origin` is the element it grows out of
   and back into, `buttons` a list of {label, icon, onClick} or {label,
   icon, href, download} for the row beside Close, and swap() puts a
   larger copy of the same picture in place without moving the zoom. */
(function () {
  'use strict';

  var CSS =
    '.pv{position:fixed;inset:0;z-index:15;background:#0b0d0f;touch-action:none;-webkit-user-select:none;user-select:none;' +
    'animation:pv-in 150ms cubic-bezier(0.22,1,0.36,1);transition:background 350ms cubic-bezier(0.22,1,0.36,1)}' +
    '.pv.is-leaving{opacity:0;pointer-events:none;transition:opacity 240ms cubic-bezier(0.22,1,0.36,1)}' +
    '@keyframes pv-in{from{opacity:0}}' +
    // the photo's area is the whole screen, with room kept for the buttons
    '.pv-frame{padding:calc(64px + env(safe-area-inset-top,0px)) 16px calc(64px + env(safe-area-inset-bottom,0px));' +
    'position:fixed;inset:0;z-index:2;box-sizing:border-box;container-type:size;display:flex;align-items:center;justify-content:center;pointer-events:none;will-change:transform;' +
    'transition:transform 240ms cubic-bezier(0.22,1,0.36,1),padding 300ms cubic-bezier(0.22,1,0.36,1)}' +
    '.pv-frame.is-dragging{transition:none}' +
    '.pv-media{display:block;max-width:100%;max-height:100%;pointer-events:auto;border-radius:2px;background:#000000;' +
    'box-shadow:0 0 0 1px rgba(255,255,255,0.14);touch-action:none;cursor:zoom-in;animation:pv-media-in 250ms cubic-bezier(0.22,1,0.36,1)}' +
    // once its shape is known, as large as the frame allows
    '.pv-media.is-fitted{width:min(100cqw,100cqh * var(--pv-ratio));height:auto}' +
    '.pv-media.is-zoomed{cursor:grab}' +
    '.pv.is-mouse .pv-media.is-zoomed:active{cursor:grabbing}' +
    '.pv-media.pv-morphing{animation:none}' +
    '@keyframes pv-media-in{from{opacity:0;transform:translateY(6px)}}' +
    '.pv-bar,.pv-top{position:fixed;top:0;left:0;right:0;z-index:4;display:flex;align-items:flex-start;pointer-events:none;' +
    'padding-top:env(safe-area-inset-top,0px);animation:pv-bar-in 260ms cubic-bezier(0.2,0.7,0.3,1);' +
    'transition:transform 240ms cubic-bezier(0.22,1,0.36,1),opacity 250ms cubic-bezier(0.22,1,0.36,1)}' +
    '.pv-top{justify-content:flex-end}' +
    '@keyframes pv-bar-in{from{transform:translateY(-110%)}}' +
    '.pv-caption{min-width:0;max-width:calc(100% - var(--pv-top-w,132px));padding:14px 16px;box-sizing:border-box;' +
    'color:#ffffff;font-size:0.9rem;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.pv-acts{display:flex;gap:8px;padding:12px 16px}' +
    '.pv-acts button,.pv-acts a{box-sizing:border-box;width:40px;height:40px;padding:0;display:grid;place-items:center;' +
    'border:1px solid #484848;border-radius:2px;background:#0c0c0c;color:#ffffff;cursor:pointer;pointer-events:auto;text-decoration:none}' +
    '.pv-acts button:hover,.pv-acts a:hover{border-color:#ffffff}' +
    '.pv-acts button:focus-visible,.pv-acts a:focus-visible{outline:2px solid #ffffff;outline-offset:2px}' +
    '.pv-acts svg{display:block;width:18px;height:18px}' +
    '.pv.is-chrome-dragging .pv-bar,.pv.is-chrome-dragging .pv-top{transition:none}' +
    '.pv.is-leaving .pv-bar,.pv.is-leaving .pv-top{transform:translateY(-110%)}' +
    // zoomed, the photo has the screen and the name steps out of its way
    '.pv.is-zoomed .pv-bar{opacity:0}' +
    // one tap: alone on black, edge to edge, until the next tap
    '.pv.is-immersive{background:#000000}' +
    '.pv.is-immersive .pv-frame{padding:0}' +
    '.pv.is-immersive .pv-media{border-radius:0;box-shadow:none}' +
    '.pv.is-immersive .pv-bar,.pv.is-immersive .pv-top{transform:translateY(-110%)!important}' +
    '.pv.is-immersive .pv-acts > *{pointer-events:none}' +
    '@media (prefers-reduced-motion:reduce){.pv,.pv-media,.pv-bar,.pv-top{animation:none}' +
    '.pv,.pv-frame,.pv-bar,.pv-top{transition:none}}';

  var CLOSE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  var styled = false;
  function style() {
    if (styled) return;
    styled = true;
    var s = document.createElement('style');
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  // what the reader points with: a finger, or a mouse that hovers
  function handheld() {
    if (!window.matchMedia) return false;
    return window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches;
  }

  function open(o) {
    style();
    var reduced = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    var mouse = !handheld();
    var origin = o.origin || null;

    var overlay = document.createElement('div');
    overlay.className = 'pv' + (mouse ? ' is-mouse' : '');
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', o.alt || 'Photo');
    var frame = document.createElement('div');
    frame.className = 'pv-frame';
    var img = document.createElement('img');
    img.className = 'pv-media';
    img.alt = o.alt || '';
    img.draggable = false;
    function fit() {
      var w = img.naturalWidth;
      var h = img.naturalHeight;
      if (!w || !h) return;
      img.style.setProperty('--pv-ratio', (w / h).toFixed(5));
      img.classList.add('is-fitted');
    }
    if (o.ratio > 0) {
      img.style.setProperty('--pv-ratio', Number(o.ratio).toFixed(5));
      img.classList.add('is-fitted');
    }
    img.addEventListener('load', fit);
    img.src = o.src;
    frame.appendChild(img);

    var bar = document.createElement('div');
    bar.className = 'pv-bar';
    if (o.caption) {
      var caption = document.createElement('span');
      caption.className = 'pv-caption';
      caption.textContent = o.caption;
      bar.appendChild(caption);
    }
    var top = document.createElement('div');
    top.className = 'pv-top';
    var acts = document.createElement('div');
    acts.className = 'pv-acts';
    (o.buttons || []).forEach(function (b) {
      var n = document.createElement(b.href ? 'a' : 'button');
      if (b.href) {
        n.setAttribute('href', b.href);
        if (b.download) n.setAttribute('download', '');
      } else {
        n.type = 'button';
      }
      n.setAttribute('aria-label', b.label);
      n.innerHTML = b.icon || '';
      if (b.onClick) n.addEventListener('click', function (e) { b.onClick(e, n); });
      acts.appendChild(n);
    });
    var close = document.createElement('button');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = CLOSE_ICON;
    acts.appendChild(close);
    top.appendChild(acts);
    overlay.appendChild(frame);
    overlay.appendChild(bar);
    overlay.appendChild(top);
    document.body.appendChild(overlay);
    bar.style.setProperty('--pv-top-w', acts.offsetWidth + 'px');

    var closed = false;

    // The name and the buttons follow a swipe on the photo, lifting in
    // step with the finger, and come back with it if the swipe is let go
    // early.
    function pullChrome(dy) {
      var away = Math.abs(dy);
      bar.style.transform = away ? 'translateY(' + (-away * 0.6) + 'px)' : '';
      top.style.transform = bar.style.transform;
    }
    function chromeDragging(on) { overlay.classList.toggle('is-chrome-dragging', on); }
    function setImmersive(on) { overlay.classList.toggle('is-immersive', on); }
    function setZoomed(on) { overlay.classList.toggle('is-zoomed', on); }

    // it grows out of the picture it was opened from, once there is a
    // picture to measure, and not at all if that is slow
    function morphIn() {
      if (reduced || !origin) return;
      function run() {
        var first = origin.getBoundingClientRect();
        var last = img.getBoundingClientRect();
        if (!first.width || !last.width) return;
        img.classList.add('pv-morphing');
        var anim = img.animate([
          { transform: 'translate(' + ((first.left + first.width / 2) - (last.left + last.width / 2)) + 'px, ' +
            ((first.top + first.height / 2) - (last.top + last.height / 2)) + 'px) ' +
            'scale(' + (first.width / last.width) + ', ' + (first.height / last.height) + ')' },
          { transform: 'none' }
        ], { duration: 300, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
        anim.onfinish = function () { img.classList.remove('pv-morphing'); };
      }
      if (img.complete && img.naturalWidth) { window.setTimeout(run, 0); return; }
      var missed = window.setTimeout(function () { img.removeEventListener('load', onLoad); }, 350);
      function onLoad() {
        window.clearTimeout(missed);
        // once: the larger copy swapped in loads again
        img.removeEventListener('load', onLoad);
        run();
      }
      img.addEventListener('load', onLoad);
    }
    // whether shrinking back into that picture makes sense: not zoomed,
    // not swiped away, not on black, and the picture still on screen
    function morphBackTarget() {
      if (reduced || !origin || !origin.isConnected) return null;
      if (frame.style.transform || overlay.classList.contains('is-immersive')) return null;
      if (img.classList.contains('is-zoomed')) return null;
      var r = origin.getBoundingClientRect();
      if (!r.width || r.bottom < 0 || r.top > window.innerHeight) return null;
      return r;
    }

    // the back gesture closes it rather than leaving the page
    var pushed = false;
    try {
      window.history.pushState({ pv: 1 }, '');
      pushed = true;
    } catch (err) { /* closes by its button and Escape only */ }
    function onPop() { dismiss(true); }
    window.addEventListener('popstate', onPop);

    function dismiss(viaBack) {
      if (closed) return;
      closed = true;
      zoom.stop();
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      var back = morphBackTarget();
      if (back) {
        var last = img.getBoundingClientRect();
        if (last.width) {
          img.classList.add('pv-morphing');
          img.animate([
            { transform: 'none' },
            { transform: 'translate(' + ((back.left + back.width / 2) - (last.left + last.width / 2)) + 'px, ' +
              ((back.top + back.height / 2) - (last.top + last.height / 2)) + 'px) ' +
              'scale(' + (back.width / last.width) + ', ' + (back.height / last.height) + ')' }
          ], { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });
        }
      }
      chromeDragging(false);
      bar.style.transform = '';
      top.style.transform = '';
      // a swipe left the backdrop part faded: it fades on from there
      overlay.classList.add('is-leaving');
      overlay.style.opacity = '';
      window.setTimeout(function () {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, reduced ? 0 : 240);
      if (!viaBack && pushed && window.history.state && window.history.state.pv) window.history.back();
      if (o.onClose) o.onClose();
    }

    // Pinch, wheel and double-tap zoom, with panning while zoomed. The
    // transform scales about the photo's middle; zoomAt keeps the point
    // under the finger or the pointer where it is.
    function armZoom() {
      var scale = 1, tx = 0, ty = 0;
      var pointers = {};
      var count = 0;
      var startDist = 0, startScale = 1;
      var panX = 0, panY = 0;
      var moved = 0;
      var lastTap = 0, lastTapX = 0, lastTapY = 0;
      var tapTimer = null;
      // dragging a photo that is not zoomed up or down carries the frame
      // with the finger and thins the ground; past 90px it closes
      var swiping = false;
      var swipeDy = 0;

      function forget() {
        for (var id in pointers) delete pointers[id];
        count = 0;
        if (swiping) settleSwipe(false);
        pinched = false;
        held = false;
      }

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

      // a double tap or a wheel step glides there; the transition comes
      // off after it has run, so the next pinch or pan is direct again
      var glideTimer = null;
      function glide(ms) {
        if (glideTimer) { window.clearTimeout(glideTimer); glideTimer = null; }
        if (!ms || reduced) { img.style.transition = ''; return; }
        img.style.transition = 'transform ' + ms + 'ms cubic-bezier(0.22, 1, 0.36, 1)';
        glideTimer = window.setTimeout(function () {
          glideTimer = null;
          img.style.transition = '';
        }, ms + 20);
      }

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
      // how far it may move at scale s: along a side it does not fill it
      // stays in the middle, and along one it overfills it goes until its
      // edge meets the frame's
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
        var r = next / scale;
        tx = (cx - c.x) * (1 - r) + r * tx;
        ty = (cy - c.y) * (1 - r) + r * ty;
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
      // how fast it was going over the last tenth of a second, in pixels
      // a millisecond; nothing if the finger had stopped
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
      // a pinch let go: back within its sizes with the point between the
      // fingers held where it was, then within its edges
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
        // never came (the system took it for the home bar) is let go
        if (e.isPrimary && count) forget();
        pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
        count = Object.keys(pointers).length;
        moved = 0;
        try { img.setPointerCapture(e.pointerId); } catch (err) { /* a mouse without capture still pans */ }
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
          var pin = pinchState();
          // past 1 and past the largest size it gives, in steps of size
          var size = Math.log(startScale * (pin.dist / startDist));
          var topSize = Math.log(MAX_SCALE);
          if (size > topSize) size = topSize + band(size - topSize, 0.4);
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
          if (!swiping && Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) {
            swiping = true;
            frame.classList.add('is-dragging');
            chromeDragging(true);
          }
          if (swiping) {
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
        if (moved < 14 && e.type === 'pointerup' && mouse) {
          // a click zooms in where it landed and a second click zooms back out
          if (scale > 1) { scale = 1; tx = 0; ty = 0; apply(200); }
          else zoomAt(e.clientX, e.clientY, 2.5, 200);
          return;
        }
        if (moved < 14 && e.type === 'pointerup') {
          var now = Date.now();
          var near = Math.abs(e.clientX - lastTapX) < 40 && Math.abs(e.clientY - lastTapY) < 40;
          if (now - lastTap < 320 && near) {
            // a double tap: in to 2.5 where it landed, or back out
            if (tapTimer) { window.clearTimeout(tapTimer); tapTimer = null; }
            if (scale > 1) { scale = 1; tx = 0; ty = 0; apply(280); }
            else zoomAt(e.clientX, e.clientY, 2.5, 280);
            lastTap = 0;
          } else {
            lastTap = now; lastTapX = e.clientX; lastTapY = e.clientY;
            // a single tap puts it alone on black, once it is clear no
            // second tap is coming
            if (tapTimer) window.clearTimeout(tapTimer);
            tapTimer = window.setTimeout(function () {
              tapTimer = null;
              setImmersive(!overlay.classList.contains('is-immersive'));
            }, 330);
          }
        }
      }
      img.addEventListener('pointerup', release);
      img.addEventListener('pointercancel', release);

      return {
        // + and - step about the middle of the screen, 0 puts it back
        step: function (factor) { zoomAt(window.innerWidth / 2, window.innerHeight / 2, scale * factor, 160); },
        reset: function () {
          if (scale === 1) return;
          scale = 1; tx = 0; ty = 0;
          apply(200);
        },
        stop: function () {
          stopFling();
          if (tapTimer) { window.clearTimeout(tapTimer); tapTimer = null; }
        }
      };
    }
    var zoom = armZoom();

    // a key a layer over this one has used (a sheet's Escape) is not
    // used again here
    function onKey(e) {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') { dismiss(false); return; }
      if (e.key === '+' || e.key === '=') zoom.step(1.25);
      else if (e.key === '-' || e.key === '_') zoom.step(0.8);
      else if (e.key === '0') zoom.reset();
    }
    document.addEventListener('keydown', onKey);
    close.addEventListener('click', function () { dismiss(false); });
    // the ground beside the photo closes it
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay) dismiss(false);
    });

    morphIn();
    close.focus({ preventScroll: true });

    return {
      swap: function (url) { if (!closed) img.src = url; },
      close: function () { dismiss(false); }
    };
  }

  window.SCSPhotoView = { open: open };
})();
