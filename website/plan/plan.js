// The route planner: a saved list of quests put in order, with the
// distance between one stop and the next, a drawing of the route and
// directions for each leg. The lists are the quest list's own, kept on
// this device, so a change here shows there.
(function () {
  'use strict';
  var scs = window.scs;
  var LISTS_KEY = 'scs2-questlist-lists';
  var PLAN_KEY = 'scs2-plan';
  var SAVED = 'saved';
  // a walk is longer than the straight line between its ends
  var DETOUR = 1.3;
  var WALK_KMH = 4.8;
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  var quests = {};   // key -> {key, name, points, pins: [{label, lat, lng}], search}
  var order = [];    // every quest, in the list's order, for the search
  var lists = [];
  var plan = { list: SAVED, pins: {}, here: false };
  var here = null;   // {lat, lng} once the device has said where it is

  // ---- what is kept ----
  function readLists() {
    var out = [];
    try {
      var kept = JSON.parse(localStorage.getItem(LISTS_KEY) || 'null');
      (kept && Array.isArray(kept.lists) ? kept.lists : []).forEach(function (l) {
        if (l && l.id && Array.isArray(l.keys)) out.push({ id: String(l.id), name: String(l.name || ''), keys: l.keys.map(String) });
      });
    } catch (e) { out = []; }
    if (!out.some(function (l) { return l.id === SAVED; })) out.unshift({ id: SAVED, name: 'Saved', keys: [] });
    return out;
  }
  function saveLists() {
    try { localStorage.setItem(LISTS_KEY, JSON.stringify({ lists: lists })); } catch (e) { /* not kept */ }
  }
  function readPlan() {
    try {
      var kept = JSON.parse(localStorage.getItem(PLAN_KEY) || 'null');
      if (kept && typeof kept === 'object') {
        plan.list = String(kept.list || SAVED);
        plan.pins = kept.pins && typeof kept.pins === 'object' ? kept.pins : {};
        plan.here = !!kept.here;
      }
    } catch (e) { /* the defaults */ }
  }
  function savePlan() {
    try { localStorage.setItem(PLAN_KEY, JSON.stringify(plan)); } catch (e) { /* not kept */ }
  }
  function current() {
    return lists.filter(function (l) { return l.id === plan.list; })[0] || lists[0];
  }

  // ---- distance ----
  function km(a, b) {
    var R = 6371;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLng = (b.lng - a.lng) * Math.PI / 180;
    var s = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function fmtKm(d) {
    return d < 1 ? Math.round(d * 1000 / 10) * 10 + ' m' : (Math.round(d * 10) / 10) + ' km';
  }
  function fmtWalk(d) {
    var mins = Math.round(d * DETOUR / WALK_KMH * 60);
    return mins < 60 ? mins + ' min' : Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min';
  }

  // The stops of the list in order: each quest still on the quest list,
  // with the place picked for it, or none for a quest with no pin.
  function stops() {
    return current().keys.map(function (key) { return quests[key]; }).filter(Boolean).map(function (q) {
      var at = Math.max(0, Math.min(q.pins.length - 1, Number(plan.pins[q.key]) || 0));
      return { quest: q, pin: q.pins.length ? q.pins[at] : null, pinAt: at };
    });
  }
  // the places the route passes, the device's own first when asked for
  function path(list) {
    var pts = list.filter(function (s) { return s.pin; }).map(function (s) { return s.pin; });
    return plan.here && here ? [here].concat(pts) : pts;
  }
  function length(pts) {
    var d = 0;
    for (var i = 1; i < pts.length; i++) d += km(pts[i - 1], pts[i]);
    return d;
  }

  // ---- the shortest order ----
  // Nearest stop next, then pairs of legs uncrossed until none shortens
  // the route. Quests with no pin keep their order, after the rest.
  function shortest() {
    var all = stops();
    var placed = all.filter(function (s) { return s.pin; });
    var loose = all.filter(function (s) { return !s.pin; });
    if (placed.length < 3 && !(plan.here && here && placed.length > 1)) return;
    var start = plan.here && here ? here : null;
    var left = placed.slice();
    var route = [];
    var at = start;
    if (!at) { route.push(left.shift()); at = route[0].pin; }
    while (left.length) {
      var best = 0;
      for (var i = 1; i < left.length; i++) if (km(at, left[i].pin) < km(at, left[best].pin)) best = i;
      at = left[best].pin;
      route.push(left.splice(best, 1)[0]);
    }
    var first = start ? 0 : 1; // with no start of its own the first stop stays
    var total = function (r) { return length((start ? [start] : []).concat(r.map(function (s) { return s.pin; }))); };
    var improved = true;
    var rounds = 0;
    while (improved && rounds++ < 50) {
      improved = false;
      for (var a = first; a < route.length - 1; a++) {
        for (var b = a + 1; b < route.length; b++) {
          var tried = route.slice(0, a).concat(route.slice(a, b + 1).reverse(), route.slice(b + 1));
          if (total(tried) + 1e-9 < total(route)) { route = tried; improved = true; }
        }
      }
    }
    var keys = route.concat(loose).map(function (s) { return s.quest.key; });
    var list = current();
    // quests the quest list no longer carries keep their place at the end
    list.keys = keys.concat(list.keys.filter(function (k) { return keys.indexOf(k) === -1; }));
    saveLists();
    draw();
    if (window.scsToast) window.scsToast('Stops put in the shortest order.');
  }

  // ---- drawing ----
  function drawFigures(list) {
    var box = $('pl-figures');
    box.textContent = '';
    var pts = path(list);
    var d = length(pts);
    var points = 0;
    list.forEach(function (s) { points += s.quest.points; });
    box.appendChild(scs.figure([list.length, list.length === 1 ? 'Stop' : 'Stops']));
    box.appendChild(scs.figure([points, points === 1 ? 'Point' : 'Points']));
    box.appendChild(scs.figure([Math.round(d * 10) / 10, 'Kilometres']));
    var mins = Math.round(d * DETOUR / WALK_KMH * 60);
    box.appendChild(scs.figure([mins, mins === 1 ? 'Minute on Foot' : 'Minutes on Foot']));
    var loose = list.filter(function (s) { return !s.pin; }).length;
    var mystery = list.some(function (s) { return s.quest.mystery; });
    $('pl-note').textContent = 'Distances are straight lines between pins, and the time on foot is a guess from them. Directions on a stop opens the way there in Google Maps.' +
      (loose ? ' ' + loose + (loose === 1 ? ' stop has no pin and can be done anywhere.' : ' stops have no pin and can be done anywhere.') : '') +
      (mystery ? ' A quest whose points are hidden counts as 0.' : '');
  }

  function drawMap(list) {
    var host = $('pl-map');
    host.textContent = '';
    var pts = path(list);
    $('pl-map-section').hidden = pts.length < 2;
    if (pts.length < 2) return;
    var W = 600, H = 360, PAD = 34;
    var midLat = 0;
    pts.forEach(function (p) { midLat += p.lat; });
    var squash = Math.cos(midLat / pts.length * Math.PI / 180);
    var xs = pts.map(function (p) { return p.lng * squash; });
    var ys = pts.map(function (p) { return -p.lat; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var scale = Math.min((W - 2 * PAD) / Math.max(maxX - minX, 1e-6), (H - 2 * PAD) / Math.max(maxY - minY, 1e-6));
    var offX = (W - (maxX - minX) * scale) / 2, offY = (H - (maxY - minY) * scale) / 2;
    var at = function (i) { return [offX + (xs[i] - minX) * scale, offY + (ys[i] - minY) * scale]; };
    var NS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'The route, stop by stop');
    var line = document.createElementNS(NS, 'polyline');
    line.setAttribute('class', 'pl-line');
    line.setAttribute('points', pts.map(function (p, i) { return at(i).join(','); }).join(' '));
    svg.appendChild(line);
    var fromHere = plan.here && here;
    pts.forEach(function (p, i) {
      var xy = at(i);
      var disc = document.createElementNS(NS, 'circle');
      disc.setAttribute('cx', String(xy[0]));
      disc.setAttribute('cy', String(xy[1]));
      disc.setAttribute('r', '13');
      disc.setAttribute('class', fromHere && i === 0 ? 'pl-disc pl-disc-here' : 'pl-disc');
      svg.appendChild(disc);
      if (fromHere && i === 0) return;
      var n = document.createElementNS(NS, 'text');
      n.setAttribute('x', String(xy[0]));
      n.setAttribute('y', String(xy[1]));
      n.setAttribute('class', 'pl-disc-n');
      n.textContent = String(fromHere ? i : i + 1);
      svg.appendChild(n);
    });
    host.appendChild(svg);
  }

  function directions(from, to) {
    var url = 'https://www.google.com/maps/dir/?api=1&travelmode=transit&destination=' + to.lat + ',' + to.lng;
    if (from) url += '&origin=' + from.lat + ',' + from.lng;
    return url;
  }

  function move(key, by) {
    var list = current();
    var shown = list.keys.filter(function (k) { return quests[k]; });
    var i = shown.indexOf(key);
    var j = i + by;
    if (i < 0 || j < 0 || j >= shown.length) return;
    var a = list.keys.indexOf(shown[i]), b = list.keys.indexOf(shown[j]);
    list.keys[a] = shown[j];
    list.keys[b] = shown[i];
    saveLists();
    draw();
  }

  function drawStops(list) {
    var box = $('pl-stops');
    box.textContent = '';
    $('pl-empty').hidden = list.length > 0;
    var before = plan.here && here ? here : null;
    var n = 0;
    list.forEach(function (s, i) {
      var li = el('li', 'pl-stop');
      var disc = el('span', 'bullet pl-stop-n', s.pin ? String(++n) : '');
      if (!s.pin) disc.classList.add('is-loose');
      li.appendChild(disc);
      var body = el('div', 'pl-stop-body');
      var name = el('a', 'pl-stop-name', s.quest.name);
      name.href = '../questlist/#' + encodeURIComponent(s.quest.key);
      body.appendChild(name);
      var where = s.pin ? s.pin.label : 'Anywhere';
      var leg = s.pin && before ? fmtKm(km(before, s.pin)) + ' from ' + (n === 1 ? 'you' : 'the last stop') + ', about ' + fmtWalk(km(before, s.pin)) + ' on foot' : '';
      body.appendChild(el('span', 'pl-stop-meta', (s.quest.mystery ? '??? points' : s.quest.points + (s.quest.points === 1 ? ' point' : ' points')) + ' · ' + where));
      if (leg) body.appendChild(el('span', 'pl-stop-meta', leg));
      if (s.quest.pins.length > 1) {
        var pick = el('select', 'pl-stop-place');
        pick.setAttribute('aria-label', 'Which place for ' + s.quest.name);
        s.quest.pins.forEach(function (p, at) {
          var o = el('option', null, p.label);
          o.value = String(at);
          pick.appendChild(o);
        });
        pick.value = String(s.pinAt);
        pick.addEventListener('change', function () {
          plan.pins[s.quest.key] = Number(pick.value) || 0;
          savePlan();
          draw();
        });
        body.appendChild(pick);
      }
      li.appendChild(body);
      var tools = el('div', 'pl-stop-tools');
      if (s.pin) {
        var go = el('a', 'pl-tool', 'Directions');
        go.href = directions(before, s.pin);
        go.target = '_blank';
        go.rel = 'noopener';
        tools.appendChild(go);
      }
      var up = el('button', 'pl-tool', 'Up');
      up.type = 'button';
      up.disabled = i === 0;
      up.setAttribute('aria-label', 'Move ' + s.quest.name + ' up');
      up.addEventListener('click', function () { move(s.quest.key, -1); });
      var down = el('button', 'pl-tool', 'Down');
      down.type = 'button';
      down.disabled = i === list.length - 1;
      down.setAttribute('aria-label', 'Move ' + s.quest.name + ' down');
      down.addEventListener('click', function () { move(s.quest.key, 1); });
      var off = el('button', 'pl-tool', 'Remove');
      off.type = 'button';
      off.setAttribute('aria-label', 'Remove ' + s.quest.name);
      off.addEventListener('click', function () {
        var l = current();
        l.keys = l.keys.filter(function (k) { return k !== s.quest.key; });
        saveLists();
        draw();
      });
      tools.appendChild(up);
      tools.appendChild(down);
      tools.appendChild(off);
      li.appendChild(tools);
      box.appendChild(li);
      if (s.pin) before = s.pin;
    });
  }

  function drawPicker() {
    var pick = $('pl-list');
    pick.textContent = '';
    lists.forEach(function (l) {
      var n = l.keys.filter(function (k) { return quests[k]; }).length;
      var o = el('option', null, l.name + ' (' + n + ')');
      o.value = l.id;
      pick.appendChild(o);
    });
    pick.value = current().id;
  }

  function drawResults() {
    var box = $('pl-results');
    box.textContent = '';
    var typed = $('pl-search').value.trim();
    if (!typed) return;
    var on = current().keys;
    var hits = scs.questSearch(order, typed, function (q) { return q.search; }).slice(0, 8);
    if (!hits.length) { box.appendChild(el('li', 'pl-note', 'No quest matches.')); return; }
    hits.forEach(function (q) {
      var li = el('li', 'pl-result');
      li.appendChild(el('span', 'code', q.key));
      li.appendChild(el('span', 'pl-result-name', q.name));
      var has = on.indexOf(q.key) !== -1;
      var add = el('button', 'pl-tool', has ? 'On the List' : 'Add');
      add.type = 'button';
      add.disabled = has;
      add.addEventListener('click', function () {
        current().keys.push(q.key);
        saveLists();
        draw();
      });
      li.appendChild(add);
      box.appendChild(li);
    });
  }

  function draw() {
    var list = stops();
    drawPicker();
    drawFigures(list);
    drawMap(list);
    drawStops(list);
    drawResults();
    var btn = $('pl-here');
    btn.textContent = plan.here && here ? 'Starting From Here' : 'Start From Here';
    btn.classList.toggle('btn-dark', !!(plan.here && here));
    $('pl-short').disabled = list.filter(function (s) { return s.pin; }).length < 2;
  }

  // ---- where the device is ----
  function locate(quiet) {
    if (!navigator.geolocation) { if (!quiet && window.scsToast) window.scsToast('This device does not say where it is.'); return; }
    navigator.geolocation.getCurrentPosition(function (pos) {
      here = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      plan.here = true;
      savePlan();
      draw();
    }, function () {
      plan.here = false;
      savePlan();
      draw();
      if (!quiet && window.scsToast) window.scsToast('Your location could not be read. Check the browser’s permission for this site.');
    }, { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 });
  }

  // ---- start ----
  function load() {
    scs.questList().then(function (data) {
      if (!data || !Array.isArray(data.groups)) throw new Error('no quest list');
      scs.gotIt('plan');
      quests = {};
      order = [];
      data.groups.forEach(function (g) {
        var codes = g.codes || [];
        if (!codes.length) return;
        var q = {
          key: String(g.key), id: String(g.key), name: String(g.name || g.key), mystery: !!g.mystery,
          points: g.mystery ? 0 : Number(codes[0].points) || 0,
          codes: codes.map(function (c) { return c.code; }),
          keywords: Array.isArray(g.keywords) ? g.keywords.map(String) : [],
          pins: (g.coords || []).map(function (c) {
            return { label: String(c.label || g.location || g.name), lat: Number(c.lat), lng: Number(c.lng) };
          }).filter(function (p) { return isFinite(p.lat) && isFinite(p.lng); }),
          search: [g.region, g.location, g.description].join(' ')
        };
        quests[q.key] = q;
        order.push(q);
      });
      lists = readLists();
      readPlan();
      var asked = new URLSearchParams(window.location.search).get('list');
      if (asked && lists.some(function (l) { return l.id === asked; })) { plan.list = asked; savePlan(); }
      $('pl-lead').textContent = 'Put a list of quests in order.';
      $('pl-error').classList.add('is-hidden');
      $('pl-body').hidden = false;
      draw();
      // a start from here is asked for again, quietly, on a later visit
      if (plan.here) locate(true);
    }).catch(function () {
      $('pl-lead').textContent = 'Could not load.';
      $('pl-error').classList.remove('is-hidden');
      scs.again('plan', load);
    });
  }

  $('pl-list').addEventListener('change', function () {
    plan.list = $('pl-list').value;
    savePlan();
    draw();
  });
  $('pl-here').addEventListener('click', function () {
    if (plan.here && here) { plan.here = false; savePlan(); draw(); return; }
    locate(false);
  });
  $('pl-short').addEventListener('click', shortest);
  $('pl-search').addEventListener('input', drawResults);
  // the quest list changing the lists in another tab
  window.addEventListener('storage', function (e) {
    if (e.key !== LISTS_KEY && e.key !== null) return;
    lists = readLists();
    draw();
  });
  load();
})();
