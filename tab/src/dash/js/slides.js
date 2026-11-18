// The home page's pictures, on the Settings tab: the list, the board for
// putting them in order, and adding one.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, busy = dash.busy, done = dash.done, el = dash.el,
    emptyRow = dash.emptyRow, fill = dash.fill, fmtTime = dash.fmtTime, h = dash.h, post = dash.post,
    postForm = dash.postForm, row = dash.row, shake = dash.shake, state = dash.state, toast = dash.toast;
  // uploads.js
  var imageThumb = dash.imageThumb, needsConverting = dash.needsConverting, pngPicks = dash.pngPicks,
    sizeText = dash.sizeText, stageFiles = dash.stageFiles;

  dash.loadSlides = loadSlides;

  // ---- the home page's pictures ----
  // The order of the rows is the order they play in. The alt box is
  // required everywhere it appears: a picture with no alt is one that
  // somebody using a screen reader has no way to know about.
  state.slides = [];

  function loadSlides() {
    api('/api/console/slides').then(function (d) {
      if (!d.ok) return;
      paintSlides(d.slides);
      paintSlideStep(d.step_ms);
    }).catch(function () {});
  }

  // Seconds in the field, milliseconds over the wire. A whole number
  // shows as one, so the ordinary case is 3 rather than 3.0.
  function paintSlideStep(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) return;
    el('slide-step').value = String(Math.round(n / 100) / 10);
  }

  function slideThumbUrl(key) {
    return '/api/slides/file?key=' + encodeURIComponent(key) + '&thumb=1';
  }

  function paintSlides(slides) {
    state.slides = slides || [];
    fill(el('slide-rows'), state.slides.length ? state.slides.map(function (s, i) {
      var shot = h('td');
      shot.appendChild(slideFocus(s));

      var words = h('td');
      var box = h('div', 'slide-words');
      var alt = h('input');
      alt.type = 'text';
      alt.maxLength = 200;
      alt.value = s.alt || '';
      alt.placeholder = 'What the picture shows';
      alt.setAttribute('aria-label', 'What the picture shows');
      var cap = h('input');
      cap.type = 'text';
      cap.maxLength = 160;
      cap.value = s.caption || '';
      cap.placeholder = 'Caption (optional)';
      cap.setAttribute('aria-label', 'Caption');
      box.appendChild(alt);
      box.appendChild(cap);
      box.appendChild(h('div', 'muted', (s.hidden ? 'Hidden · ' : '') + s.name + ' · ' + sizeText(s.bytes) +
        ' · ' + fmtTime(s.created_at) + (s.created_by ? ' · ' + s.created_by : '')));
      words.appendChild(box);

      var order = h('td');
      var moves = h('span', 'inline');
      var up = btn('Up', 'quiet small', function () { moveSlide(i, -1, up); });
      var down = btn('Down', 'quiet small', function () { moveSlide(i, 1, down); });
      up.disabled = i === 0;
      down.disabled = i === state.slides.length - 1;
      moves.appendChild(up);
      moves.appendChild(down);
      order.appendChild(moves);

      var actions = h('td', 'num');
      var wrap = h('span', 'inline');
      var save = btn('Save', 'quiet small', function () {
        if (!alt.value.trim()) { shake(alt); toast('Say what the picture shows.', true); return; }
        busy(save, post('/api/console/slides/edit', {
          key: s.key, alt: alt.value, caption: cap.value
        })).then(function (r) {
          if (done(r, 'Saved ' + s.name)) paintSlides(r.slides);
        }).catch(function () {});
      });
      wrap.appendChild(save);
      var flip = btn(s.hidden ? 'Show' : 'Hide', 'quiet small', function () { hideSlides([s.key], !s.hidden, flip); });
      wrap.appendChild(flip);
      wrap.appendChild(btn('Delete', 'danger small', function () { askSlideDelete(s, actions); }));
      actions.appendChild(wrap);

      var tr = row([shot, words, order, actions]);
      if (s.hidden) tr.classList.add('is-hidden-slide');
      return tr;
    }) : [emptyRow('No pictures on the home page.', 4)]);
    var hidden = state.slides.filter(function (s) { return s.hidden; }).length;
    el('slide-count').textContent = state.slides.length
      ? state.slides.length + (state.slides.length === 1 ? ' picture' : ' pictures') + (hidden ? ', ' + hidden + ' hidden' : '')
      : '';
    el('slide-edit').disabled = !state.slides.length;
    if (slideEditing) repaintBoard();
  }

  // Taken out of the slideshow or put back in it; the picture stays on
  // this card either way.
  function hideSlides(keys, hide, button) {
    return busy(button, post('/api/console/slides/hide', { keys: keys, hidden: hide })).then(function (r) {
      var n = keys.length + (keys.length === 1 ? ' picture' : ' pictures');
      if (done(r, hide ? n + ' hidden from the slideshow' : n + ' back in the slideshow')) {
        slidePicked = {};
        paintSlides(r.slides);
      }
    }).catch(function () {});
  }

  // ---- edit mode: the pictures as tiles ----
  // Drag a tile to move it (the order saves when it lands); click tiles
  // to pick them, then Hide or Show the picked ones. A finger holds a
  // tile still for a moment to lift it, so a swipe over the board
  // scrolls the page as it does anywhere else.
  var slideEditing = false;
  var slidePicked = {};
  // A tile being dragged is not drawn over: the board is drawn again once
  // it lands. One order goes up at a time; a drop made while one is out
  // goes up after it, with the order the board then shows.
  var slideDragging = false;
  var boardStale = false;
  var orderSaving = false;
  var orderAgain = false;
  function repaintBoard() {
    if (slideDragging) { boardStale = true; return; }
    boardStale = false;
    paintSlideBoard();
  }
  function saveOrder() {
    if (orderSaving) { orderAgain = true; return; }
    orderSaving = true;
    post('/api/console/slides/order', { keys: boardKeys() }).then(function (r) {
      orderSaving = false;
      if (orderAgain) { orderAgain = false; saveOrder(); return; }
      if (done(r, 'Order saved')) paintSlides(r.slides);
      else repaintBoard();
    }, function () {
      orderSaving = false;
      if (orderAgain) { orderAgain = false; saveOrder(); return; }
      repaintBoard();
    });
  }
  function setSlideEditing(on) {
    slideEditing = on;
    slidePicked = {};
    el('slide-board').hidden = !on;
    el('slide-edit-bar').hidden = !on;
    el('slide-table').hidden = on;
    el('slide-tools').hidden = on;
    if (on) paintSlideBoard();
  }
  function paintSlideBoard() {
    var board = el('slide-board');
    board.textContent = '';
    state.slides.forEach(function (s) {
      var tile = h('button', 'slide-tile' + (s.hidden ? ' is-hidden' : '') + (slidePicked[s.key] ? ' is-picked' : ''));
      tile.type = 'button';
      tile.setAttribute('data-key', s.key);
      tile.setAttribute('aria-pressed', slidePicked[s.key] ? 'true' : 'false');
      tile.setAttribute('aria-label', (s.alt || s.name) + (s.hidden ? ', hidden' : ''));
      var img = h('img');
      img.src = slideThumbUrl(s.key);
      img.alt = '';
      img.draggable = false;
      img.style.objectPosition = (s.focus_x == null ? 50 : s.focus_x) + '% ' + (s.focus_y == null ? 50 : s.focus_y) + '%';
      tile.appendChild(img);
      if (s.hidden) tile.appendChild(h('span', 'slide-tag', 'Hidden'));
      board.appendChild(tile);
    });
    paintPicked();
  }
  function paintPicked() {
    var keys = Object.keys(slidePicked);
    el('slide-picked').textContent = keys.length
      ? keys.length + ' picked'
      : window.matchMedia('(pointer: coarse)').matches ? 'Hold and drag to move. Tap to pick.' : 'Drag to move. Click to pick.';
    el('slide-hide').disabled = !keys.length;
    el('slide-show').disabled = !keys.length;
  }
  function togglePick(tile) {
    var key = tile.getAttribute('data-key');
    if (slidePicked[key]) delete slidePicked[key]; else slidePicked[key] = true;
    tile.classList.toggle('is-picked', !!slidePicked[key]);
    tile.setAttribute('aria-pressed', slidePicked[key] ? 'true' : 'false');
    paintPicked();
  }
  function boardKeys() {
    return Array.prototype.map.call(el('slide-board').children, function (t) { return t.getAttribute('data-key'); });
  }
  (function () {
    var board = el('slide-board');
    if (!board) return;
    var drag = null;
    var tick = 0;
    var HOLD_MS = 300;
    board.addEventListener('pointerdown', function (e) {
      var tile = e.target.closest ? e.target.closest('.slide-tile') : null;
      if (!tile || e.button > 0) return;
      var r = tile.getBoundingClientRect();
      var d = drag = { tile: tile, id: e.pointerId, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY,
        gx: e.clientX - r.left, gy: e.clientY - r.top, moved: false, was: boardKeys(),
        mouse: e.pointerType === 'mouse', timer: 0 };
      if (!d.mouse) d.timer = setTimeout(function () { if (drag === d) lift(d); }, HOLD_MS);
    });
    function lift(d) {
      d.moved = true;
      slideDragging = true;
      try { board.setPointerCapture(d.id); } catch (err) { /* moves still arrive */ }
      d.tile.classList.add('is-dragging');
      follow();
    }
    // the dragged tile takes no pointer, so the one found here is the one under it
    function follow() {
      var d = drag;
      var under = document.elementFromPoint(d.x, d.y);
      var over = under && under.closest ? under.closest('.slide-tile') : null;
      if (over && over !== d.tile && over.parentNode === board) {
        var r = over.getBoundingClientRect();
        board.insertBefore(d.tile, d.x > r.left + r.width / 2 ? over.nextSibling : over);
      }
      // held under the pointer wherever it now sits in the grid
      d.tile.style.transform = 'none';
      var home = d.tile.getBoundingClientRect();
      d.tile.style.transform = 'translate(' + (d.x - d.gx - home.left) + 'px, ' + (d.y - d.gy - home.top) + 'px)';
    }
    // near the top or bottom of the window the page scrolls under the tile
    function edge() {
      tick = 0;
      if (!drag || !drag.moved) return;
      var zone = 56;
      var v = drag.y < zone ? drag.y - zone : drag.y > window.innerHeight - zone ? drag.y - window.innerHeight + zone : 0;
      if (!v) return;
      var was = window.scrollY;
      window.scrollBy(0, v < 0 ? Math.floor(v / 3) : Math.ceil(v / 3));
      if (window.scrollY === was) return;
      follow();
      tick = requestAnimationFrame(edge);
    }
    board.addEventListener('pointermove', function (e) {
      if (!drag || e.pointerId !== drag.id) return;
      drag.x = e.clientX;
      drag.y = e.clientY;
      if (!drag.moved) {
        var far = Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0);
        if (!drag.mouse) {
          // a finger that moves before the hold is up is scrolling the page
          if (far > 10) { clearTimeout(drag.timer); drag = null; }
          return;
        }
        if (far < 6) return;
        lift(drag);
      }
      e.preventDefault();
      follow();
      if (!tick) tick = requestAnimationFrame(edge);
    });
    // a tile lifted by a finger keeps the page still under it
    board.addEventListener('touchmove', function (e) { if (drag && drag.moved) e.preventDefault(); }, { passive: false });
    board.addEventListener('contextmenu', function (e) { if (drag && !drag.mouse) e.preventDefault(); });
    function end(e, cancelled) {
      if (!drag || e.pointerId !== drag.id) return;
      var d = drag;
      drag = null;
      clearTimeout(d.timer);
      cancelAnimationFrame(tick);
      tick = 0;
      d.tile.style.transform = '';
      d.tile.classList.remove('is-dragging');
      if (!d.moved) {
        if (!cancelled) togglePick(d.tile);
        return;
      }
      slideDragging = false;
      if (boardKeys().join() !== d.was.join()) saveOrder();
      else if (boardStale) repaintBoard();
    }
    board.addEventListener('pointerup', function (e) { end(e, false); });
    board.addEventListener('pointercancel', function (e) { end(e, true); });
    // a key press on a tile picks it
    board.addEventListener('click', function (e) {
      var tile = e.target.closest ? e.target.closest('.slide-tile') : null;
      if (tile && !e.detail) togglePick(tile);
    });
  })();
  if (el('slide-edit')) {
    el('slide-edit').addEventListener('click', function () { setSlideEditing(true); });
    el('slide-done').addEventListener('click', function () { setSlideEditing(false); paintSlides(state.slides); });
    el('slide-hide').addEventListener('click', function () { hideSlides(Object.keys(slidePicked), true, el('slide-hide')); });
    el('slide-show').addEventListener('click', function () { hideSlides(Object.keys(slidePicked), false, el('slide-show')); });
  }

  // The point the home page crops a picture around. The page covers a box
  // about twice as wide as it is tall on a computer and a little taller
  // than wide on a phone, and keeps this point in the frame on both. A
  // click on the picture sets it and saves it; the arrow keys move it.
  function slideFocus(s) {
    var at = { x: s.focus_x == null ? 50 : s.focus_x, y: s.focus_y == null ? 50 : s.focus_y };
    var wrap = h('div', 'slide-focus');
    var pick = h('button', 'slide-pick');
    pick.type = 'button';
    var img = h('img', 'slide-whole');
    img.src = slideThumbUrl(s.key);
    img.alt = s.alt || '';
    img.loading = 'lazy';
    var mark = h('span', 'slide-mark');
    pick.appendChild(img);
    pick.appendChild(mark);
    var crops = h('div', 'slide-crops');
    var shown = [['is-wide', 'Computer'], ['is-tall', 'Phone']].map(function (c) {
      var fig = h('figure', 'slide-crop ' + c[0]);
      var shot = h('img');
      shot.src = slideThumbUrl(s.key);
      shot.alt = '';
      shot.loading = 'lazy';
      fig.appendChild(shot);
      fig.appendChild(h('figcaption', 'muted', c[1]));
      crops.appendChild(fig);
      return shot;
    });
    wrap.appendChild(pick);
    wrap.appendChild(crops);
    function paint() {
      mark.style.left = at.x + '%';
      mark.style.top = at.y + '%';
      shown.forEach(function (shot) { shot.style.objectPosition = at.x + '% ' + at.y + '%'; });
      pick.setAttribute('aria-label', 'Crop point ' + at.x + '% across, ' + at.y + '% down. Arrow keys move it.');
    }
    var saving = 0;
    function save() {
      clearTimeout(saving);
      saving = setTimeout(function () {
        post('/api/console/slides/focus', { key: s.key, x: at.x, y: at.y }).then(function (r) {
          if (done(r, 'Crop point saved')) state.slides = r.slides;
        }).catch(function () {});
      }, 400);
    }
    pick.addEventListener('click', function (e) {
      // a key press arrives as a click with no position
      if (!e.detail) return;
      var box = img.getBoundingClientRect();
      if (!box.width || !box.height) return;
      at.x = Math.round(Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * 100);
      at.y = Math.round(Math.max(0, Math.min(1, (e.clientY - box.top) / box.height)) * 100);
      paint();
      save();
    });
    pick.addEventListener('keydown', function (e) {
      var by = { ArrowLeft: [-5, 0], ArrowRight: [5, 0], ArrowUp: [0, -5], ArrowDown: [0, 5] }[e.key];
      if (!by) return;
      e.preventDefault();
      at.x = Math.max(0, Math.min(100, at.x + by[0]));
      at.y = Math.max(0, Math.min(100, at.y + by[1]));
      paint();
      save();
    });
    paint();
    return wrap;
  }

  // The whole list goes up in its new order, the same way the messages
  // reorder works: one number per picture, so nothing can end up
  // sharing a place with anything else.
  function moveSlide(index, by, button) {
    var list = state.slides.slice();
    var to = index + by;
    if (to < 0 || to >= list.length) return;
    list.splice(to, 0, list.splice(index, 1)[0]);
    busy(button, post('/api/console/slides/order', {
      keys: list.map(function (s) { return s.key; })
    })).then(function (r) {
      if (done(r, 'Order saved')) paintSlides(r.slides);
    }).catch(function () {});
  }

  // Deleting takes the picture off the home page and out of the bucket,
  // so the file's name is typed back first.
  function askSlideDelete(s, cell) {
    var input = h('input');
    input.placeholder = 'Type the file name to confirm';
    input.setAttribute('aria-label', 'Type the file name to confirm');
    var go = btn('Delete', 'danger small', function () {
      if (input.value.trim() !== s.name) { shake(input); return; }
      busy(go, post('/api/console/slides/delete', { key: s.key })).then(function (r) {
        if (done(r, 'Deleted ' + s.name)) paintSlides(r.slides);
      }).catch(function () {});
    });
    var cancel = btn('Cancel', 'quiet small', function () { paintSlides(state.slides); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') go.click();
      if (e.key === 'Escape') paintSlides(state.slides);
    });
    cell.textContent = '';
    var wrap = h('span', 'inline');
    wrap.appendChild(input);
    wrap.appendChild(go);
    wrap.appendChild(cancel);
    cell.appendChild(wrap);
    input.focus();
  }

  el('slide-step-save').addEventListener('click', function () {
    var field = el('slide-step');
    var secs = parseFloat(field.value);
    if (!isFinite(secs) || secs < 1 || secs > 60) { shake(field); return; }
    busy(el('slide-step-save'), post('/api/console/slides/step', {
      step_ms: Math.round(secs * 1000)
    })).then(function (r) {
      if (!done(r, 'Saved')) return;
      paintSlideStep(r.step_ms);
      paintSlides(r.slides);
    }).catch(function () {});
  });

  el('slide-send').addEventListener('click', function () {
    var input = el('slide-file');
    var picked = input.files && input.files[0];
    if (!picked) { shake(input); return; }
    var alt = el('slide-alt');
    if (!alt.value.trim()) { shake(alt); toast('Say what the picture shows.', true); return; }
    if (needsConverting(picked)) el('slide-state').textContent = 'Converting to PNG…';
    var file;
    // the small copy is made here, the same way a message attachment's
    // is: a worker cannot resize a picture. Send stays off from the first
    // press, conversion included.
    busy(el('slide-send'), pngPicks([picked]).then(function (ready) {
      file = ready[0];
      el('slide-state').textContent = 'Sending ' + sizeText(file.size) + '…';
      return imageThumb(file);
    }).then(function (small) {
      var form = new FormData();
      form.append('alt', alt.value);
      form.append('caption', el('slide-caption').value);
      if (small) form.append('thumb', small, 'thumb.jpg');
      return stageFiles([file], 'slide', function (share) {
        el('slide-state').textContent = 'Sending ' + Math.round(share * 100) + '%';
      }).then(function (ids) {
        if (ids) form.append('staged', String(ids[0]));
        else form.append('file', file);
        return postForm('/api/console/slides/save', form);
      });
    })).then(function (r) {
      el('slide-state').textContent = '';
      if (!done(r, function () { return 'Added ' + r.name; })) return;
      input.value = '';
      alt.value = '';
      el('slide-caption').value = '';
      paintSlides(r.slides);
    }).catch(function (err) {
      el('slide-state').textContent = '';
      if (err && err.error) toast(err.error, true);
    });
  });
})(window.dash);
