// Putting a region's quests in order, on the Quests tab.
(function (dash) {
  // core.js
  var btn = dash.btn, busy = dash.busy, chip = dash.chip, done = dash.done, flash = dash.flash, h = dash.h,
    post = dash.post, state = dash.state;

  dash.orderPanel = orderPanel;

  // ---- one region's quests put in order ----
  // state.ordering is {region, was, ids}: the ids as the region showed
  // them and as they stand now. Rows are dragged by the handle (a mouse
  // can take a row anywhere) or moved with the arrows.
  state.ordering = null;
  function gripMark() {
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '10'); svg.setAttribute('height', '16'); svg.setAttribute('viewBox', '0 0 10 16');
    svg.setAttribute('aria-hidden', 'true');
    [0, 6].forEach(function (x) {
      [0, 6, 12].forEach(function (y) {
        var r = document.createElementNS(NS, 'rect');
        r.setAttribute('x', x); r.setAttribute('y', y); r.setAttribute('width', '4'); r.setAttribute('height', '4');
        svg.appendChild(r);
      });
    });
    return svg;
  }
  function orderPanel(name) {
    var o = state.ordering;
    var card = h('div', 'card qo');
    var listEl = h('ol', 'qo-list');
    listEl.setAttribute('aria-label', (name || 'No region') + ' in order');
    var said = h('p', 'qo-said');
    said.setAttribute('aria-live', 'polite');
    var actions = h('div', 'qg-actions');
    var save = btn('Save order', null, function () {
      busy(save, post('/api/console/quests/order', { region: o.region, ids: o.ids })).then(function (r) {
        if (done(r, 'Order saved')) { state.ordering = null; dash.paintQuestGroups(r); }
        else if (!r.cancelled) dash.loadQuestGroups();
      }).catch(function () {});
    });
    var cancel = btn('Cancel', 'quiet', function () { state.ordering = null; dash.renderQuestGroups(); });
    actions.appendChild(save); actions.appendChild(cancel);
    card.appendChild(listEl); card.appendChild(said); card.appendChild(actions);
    var byId = {};
    function paint() {
      byId = {};
      // a quest deleted or moved to another region since drops out
      state.groups.forEach(function (g) {
        if ((g.region || '').toUpperCase() === o.region.toUpperCase()) byId[g.id] = g;
      });
      o.ids = o.ids.filter(function (id) { return byId[id]; });
      o.was = o.was.filter(function (id) { return byId[id]; });
      listEl.textContent = '';
      o.ids.forEach(function (id, i) {
        var g = byId[id];
        var li = h('li', 'qo-row');
        li.setAttribute('data-id', id);
        var grip = h('span', 'qo-grip');
        grip.appendChild(gripMark());
        li.appendChild(grip);
        li.appendChild(h('span', 'qo-pos', String(i + 1)));
        li.appendChild(chip(g.key, dash.whoOf(g) === 'organisers'));
        li.appendChild(h('span', 'qo-name', g.name));
        var moves = h('span', 'qo-moves');
        var up = btn('↑', 'quiet small qo-up', function () { step(id, -1); });
        var down = btn('↓', 'quiet small qo-down', function () { step(id, 1); });
        up.setAttribute('aria-label', 'Move ' + g.key + ' up');
        down.setAttribute('aria-label', 'Move ' + g.key + ' down');
        up.disabled = i === 0;
        down.disabled = i === o.ids.length - 1;
        moves.appendChild(up); moves.appendChild(down);
        li.appendChild(moves);
        li.addEventListener('pointerdown', function (e) { dragRow(e, li, panel); });
        listEl.appendChild(li);
      });
      save.disabled = o.ids.join() === o.was.join();
    }
    function step(id, by) {
      var i = o.ids.indexOf(id);
      var j = i + by;
      if (i < 0 || j < 0 || j >= o.ids.length) return;
      o.ids.splice(j, 0, o.ids.splice(i, 1)[0]);
      paint();
      said.textContent = byId[id].key + ' is ' + (j + 1) + ' of ' + o.ids.length + '.';
      var row = listEl.children[j];
      var same = row.querySelector(by < 0 ? '.qo-up' : '.qo-down');
      (same.disabled ? row.querySelector(by < 0 ? '.qo-down' : '.qo-up') : same).focus();
      flash(row);
    }
    var panel = {
      paint: paint,
      // a dragged row lands at index to
      moved: function (from, to) {
        if (from !== to) o.ids.splice(to, 0, o.ids.splice(from, 1)[0]);
        paint();
        if (from !== to) said.textContent = byId[o.ids[to]].key + ' is ' + (to + 1) + ' of ' + o.ids.length + '.';
      }
    };
    paint();
    return card;
  }
  // The row follows the pointer and the rows it passes step out of its
  // way; near the top or bottom of the window the page scrolls under it.
  // Positions are kept in page coordinates so a scroll during the drag
  // is counted.
  function dragRow(e, li, panel) {
    if (e.button !== 0 || e.target.closest('button')) return;
    if (e.pointerType !== 'mouse' && !e.target.closest('.qo-grip')) return;
    e.preventDefault();
    var listEl = li.parentNode;
    var rows = Array.prototype.slice.call(listEl.children);
    var from = rows.indexOf(li);
    var spots = rows.map(function (r) {
      var b = r.getBoundingClientRect();
      return { top: b.top + window.scrollY, height: b.height };
    });
    var start = e.clientY + window.scrollY;
    var pointerY = e.clientY;
    var to = from;
    var dy = 0;
    var tick = 0;
    var ended = false;
    li.classList.add('is-lifted');
    listEl.classList.add('is-sorting');
    try { li.setPointerCapture(e.pointerId); } catch (err) {}
    function offsetFor(index) {
      var d = 0;
      var i;
      for (i = from + 1; i <= index; i++) d += spots[i].height;
      for (i = index; i < from; i++) d -= spots[i].height;
      return d;
    }
    function place() {
      var lastSpot = spots[spots.length - 1];
      var least = spots[0].top - spots[from].top;
      var most = lastSpot.top + lastSpot.height - spots[from].top - spots[from].height;
      dy = Math.max(least, Math.min(most, pointerY + window.scrollY - start));
      li.style.transform = 'translateY(' + dy + 'px)';
      // a row steps aside once the dragged row's leading edge passes its middle
      var topNow = spots[from].top + dy;
      var bottomNow = topNow + spots[from].height;
      to = from;
      spots.forEach(function (s, i) {
        var middle = s.top + s.height / 2;
        if (i < from && topNow < middle) to--;
        if (i > from && bottomNow > middle) to++;
      });
      var gap = spots[from].height;
      rows.forEach(function (r, i) {
        if (i === from) return;
        var shift = (i < from && i >= to) ? gap : (i > from && i <= to) ? -gap : 0;
        r.style.transform = shift ? 'translateY(' + shift + 'px)' : '';
      });
    }
    function edge() {
      tick = 0;
      if (ended) return;
      var zone = 56;
      var v = pointerY < zone ? pointerY - zone : pointerY > window.innerHeight - zone ? pointerY - window.innerHeight + zone : 0;
      if (!v) return;
      var was = window.scrollY;
      window.scrollBy(0, v < 0 ? Math.floor(v / 3) : Math.ceil(v / 3));
      if (window.scrollY === was) return;
      place();
      tick = requestAnimationFrame(edge);
    }
    function move(ev) {
      if (ev.pointerId !== e.pointerId) return;
      pointerY = ev.clientY;
      place();
      if (!tick) tick = requestAnimationFrame(edge);
    }
    function end(keep) {
      if (ended) return;
      ended = true;
      cancelAnimationFrame(tick);
      li.removeEventListener('pointermove', move);
      li.removeEventListener('pointerup', up);
      li.removeEventListener('pointercancel', drop);
      document.removeEventListener('keydown', key, true);
      listEl.classList.remove('is-sorting');
      var target = keep ? to : from;
      if (!keep) rows.forEach(function (r) { if (r !== li) r.style.transform = ''; });
      var land = offsetFor(target);
      var landed = false;
      function settle() {
        if (landed) return;
        landed = true;
        panel.moved(from, target);
      }
      if (Math.abs(land - dy) < 1) { settle(); return; }
      li.classList.add('is-settling');
      li.style.transform = 'translateY(' + land + 'px)';
      li.addEventListener('transitionend', settle);
      window.setTimeout(settle, 400);
    }
    function up(ev) { if (ev.pointerId === e.pointerId) end(true); }
    function drop(ev) { if (ev.pointerId === e.pointerId) end(false); }
    function key(ev) { if (ev.key === 'Escape') { ev.preventDefault(); end(false); } }
    li.addEventListener('pointermove', move);
    li.addEventListener('pointerup', up);
    li.addEventListener('pointercancel', drop);
    document.addEventListener('keydown', key, true);
  }
})(window.dash);
