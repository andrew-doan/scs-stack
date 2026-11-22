(function () {
  'use strict';
  // The dashboard's own sign-in, read from the same place it keeps it.
  var KEY = 'scs-console-session';
  // the teams taken off the wheel on this device, by id, so a team added
  // later starts on it
  var OFF_KEY = 'scs2-spinner-off';
  // the route colours, in the order the stripe runs
  var COLOURS = ['#ee352e', '#ff6319', '#fccc0a', '#00933c', '#0039a6', '#b933ad', '#996633', '#6cbe45', '#00a1de', '#a7a9ac'];
  var DARK_INK = { '#fccc0a': true, '#6cbe45': true, '#a7a9ac': true, '#ff6319': true };
  var TURN = Math.PI * 2;
  var SPIN_MS = 6000;

  var teams = [];
  var off = {};
  var rot = 0;          // the wheel's turn, radians clockwise from the pointer
  var spinning = false;
  var winner = null;

  function el(id) { return document.getElementById(id); }
  function session() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  function signOut() { try { localStorage.removeItem(KEY); } catch (e) {} }
  function readOff() {
    try {
      var ids = JSON.parse(localStorage.getItem(OFF_KEY) || '[]');
      off = {};
      if (Array.isArray(ids)) ids.forEach(function (id) { off[id] = true; });
    } catch (e) { off = {}; }
  }
  function saveOff() {
    var ids = Object.keys(off).filter(function (id) { return off[id]; }).map(Number);
    try { localStorage.setItem(OFF_KEY, JSON.stringify(ids)); } catch (e) {}
  }
  function reducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function fmt(n) { return (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }); }

  function showSignIn() {
    el('sp-app').classList.add('hidden');
    el('sp-side-toggle').classList.add('hidden');
    el('sp-signin').classList.remove('hidden');
  }
  function showError(text) {
    var p = el('sp-error');
    p.textContent = text;
    p.classList.toggle('hidden', !text);
  }

  // A team's weight is its points; nothing at or under zero can win.
  function slices() {
    var on = teams.filter(function (t) { return !off[t.id] && t.points > 0; });
    var total = on.reduce(function (s, t) { return s + t.points; }, 0);
    var at = 0;
    return on.map(function (t, i) {
      var colour = COLOURS[i % COLOURS.length];
      // the last slice meets the first: never the same colour twice
      if (i === on.length - 1 && i > 0 && i % COLOURS.length === 0) colour = COLOURS[1];
      var s = { team: t, from: at / total * TURN, to: (at + t.points) / total * TURN, colour: colour };
      at += t.points;
      return s;
    });
  }

  // ---- drawing ----
  var canvas = el('sp-wheel');
  var ctx = canvas.getContext('2d');
  var size = 0;
  function fit() {
    var box = el('sp-wheel-box');
    var css = Math.max(200, Math.floor(box.clientWidth));
    var dpr = window.devicePixelRatio || 1;
    size = css;
    canvas.style.width = css + 'px';
    canvas.style.height = css + 'px';
    canvas.width = Math.round(css * dpr);
    canvas.height = Math.round(css * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }
  function draw() {
    var list = slices();
    var c = size / 2;
    var r = c - 4;
    ctx.clearRect(0, 0, size, size);
    var ink = getComputedStyle(document.body).color;
    if (!list.length) {
      ctx.beginPath();
      ctx.arc(c, c, r, 0, TURN);
      ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--tint') || '#e7e8eb';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = ink;
      ctx.stroke();
      return;
    }
    // canvas angles run from three o'clock; the pointer is at twelve
    var base = rot - Math.PI / 2;
    list.forEach(function (s) {
      var dim = winner && !spinning && s.team.id !== winner.id;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, r, base + s.from, base + s.to);
      ctx.closePath();
      ctx.fillStyle = s.colour;
      ctx.globalAlpha = dim ? 0.35 : 1;
      ctx.fill();
      ctx.globalAlpha = 1;
      if (list.length > 1) {
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    });
    list.forEach(function (s) { label(s, c, r, base); });
    ctx.beginPath();
    ctx.arc(c, c, r, 0, TURN);
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#131313';
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(c, c, Math.max(10, r * 0.07), 0, TURN);
    ctx.fillStyle = '#131313';
    ctx.fill();
  }
  // the name along the middle of its slice, from the rim inward, turned
  // over on the left half so it never reads upside down, and left off a
  // slice too thin to hold it
  function label(s, c, r, base) {
    var sweep = s.to - s.from;
    var mid = base + s.from + sweep / 2;
    var px = Math.min(20, Math.max(0, sweep * r * 0.62 * 0.8));
    if (px < 9) return;
    var room = r * 0.78;
    var name = s.team.name;
    var left = Math.cos(mid) < 0;
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate(left ? mid + Math.PI : mid);
    ctx.font = '700 ' + px + 'px "Helvetica Neue", Helvetica, Arial, sans-serif';
    ctx.textAlign = left ? 'left' : 'right';
    ctx.textBaseline = 'middle';
    while (name.length > 1 && ctx.measureText(name).width > room) name = name.slice(0, -2) + '…';
    ctx.fillStyle = DARK_INK[s.colour] ? '#131313' : '#ffffff';
    ctx.globalAlpha = winner && !spinning && s.team.id !== winner.id ? 0.5 : 1;
    ctx.fillText(name, left ? -(r - 12) : r - 12, 0);
    ctx.restore();
  }

  // ---- the list ----
  function paintList() {
    var list = el('sp-list');
    list.textContent = '';
    teams.forEach(function (t) {
      var li = document.createElement('li');
      var lab = document.createElement('label');
      lab.className = 'sp-row' + (t.points > 0 ? '' : ' is-empty');
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = !off[t.id];
      box.disabled = spinning;
      box.addEventListener('change', function () {
        off[t.id] = !box.checked;
        saveOff();
        settle();
      });
      var name = document.createElement('span');
      name.className = 'sp-name';
      name.textContent = t.name;
      var pts = document.createElement('span');
      pts.className = 'sp-pts';
      pts.textContent = fmt(t.points);
      lab.appendChild(box);
      lab.appendChild(name);
      lab.appendChild(pts);
      li.appendChild(lab);
      list.appendChild(li);
    });
  }
  function settle() {
    var on = teams.filter(function (t) { return !off[t.id]; });
    var live = slices();
    el('sp-count').textContent = on.length + ' of ' + teams.length + ' on the wheel' +
      (on.length > live.length ? ', ' + (on.length - live.length) + ' with no points' : '') + '.';
    el('sp-spin').disabled = spinning || !live.length;
    if (!spinning && !live.length) el('sp-winner').textContent = on.length ? 'None of the ticked teams has points.' : 'Tick a team to put it on the wheel.';
    else if (!spinning && !winner) el('sp-winner').textContent = '';
    draw();
  }
  function setAll(on) {
    teams.forEach(function (t) { off[t.id] = !on; });
    saveOff();
    paintList();
    settle();
  }

  // ---- spinning ----
  // A point on the wheel picked uniformly at random decides the winner,
  // so each team's chance is its slice, which is its share of the points.
  function random() {
    if (window.crypto && window.crypto.getRandomValues) {
      var a = new Uint32Array(1);
      window.crypto.getRandomValues(a);
      return a[0] / 4294967296;
    }
    return Math.random();
  }
  function spin() {
    var list = slices();
    if (spinning || !list.length) return;
    var at = random() * TURN;
    var hit = list[list.length - 1];
    for (var i = 0; i < list.length; i++) { if (at < list[i].to) { hit = list[i]; break; } }
    // turn on until that point sits under the pointer, five turns and more
    var start = rot;
    var gap = ((-at - start) % TURN + TURN) % TURN;
    var end = start + TURN * 5 + gap;
    winner = null;
    spinning = true;
    el('sp-winner').textContent = '';
    el('sp-drop').classList.add('hidden');
    paintList();
    settle();
    var ms = reducedMotion() ? 0 : SPIN_MS;
    var t0 = performance.now();
    function frame(now) {
      var k = ms ? Math.min(1, (now - t0) / ms) : 1;
      rot = start + (end - start) * (1 - Math.pow(1 - k, 4));
      draw();
      if (k < 1) { requestAnimationFrame(frame); return; }
      rot = end % TURN;
      spinning = false;
      winner = hit.team;
      el('sp-winner').textContent = hit.team.name;
      el('sp-drop').classList.remove('hidden');
      paintList();
      settle();
    }
    requestAnimationFrame(frame);
  }
  function dropWinner() {
    if (!winner) return;
    off[winner.id] = true;
    saveOff();
    winner = null;
    el('sp-winner').textContent = '';
    el('sp-drop').classList.add('hidden');
    paintList();
    settle();
  }

  // ---- loading ----
  var loadTries = 0;
  var loadTimer = 0;
  function load() {
    clearTimeout(loadTimer);
    if (!session()) { showSignIn(); return Promise.resolve(); }
    return fetch('/api/console/spinner', { headers: { authorization: 'Bearer ' + session() } }).then(function (r) {
      if (r.status === 401) { signOut(); showSignIn(); return null; }
      return r.json();
    }).then(function (d) {
      if (!d) return;
      if (!d.ok) { showError(d.error || 'The teams could not be read.'); return; }
      showError('');
      loadTries = 0;
      teams = d.teams || [];
      if (winner && !teams.some(function (t) { return t.id === winner.id; })) winner = null;
      el('sp-app').classList.remove('hidden');
      el('sp-side-toggle').classList.remove('hidden');
      paintList();
      fit();
      settle();
    }).catch(function () {
      showError('The teams could not be read. Trying again.');
      loadTimer = setTimeout(load, Math.min(30000, 1000 * Math.pow(2, loadTries++)));
    });
  }
  window.addEventListener('online', function () { if (loadTimer) load(); });

  readOff();
  el('sp-spin').addEventListener('click', spin);
  el('sp-drop').addEventListener('click', dropWinner);
  el('sp-all').addEventListener('click', function () { setAll(true); });
  el('sp-none').addEventListener('click', function () { setAll(false); });
  el('sp-reload').addEventListener('click', function () { if (!spinning) load(); });
  el('sp-side-toggle').addEventListener('click', function () {
    var hide = !el('sp-app').classList.contains('is-bare');
    el('sp-app').classList.toggle('is-bare', hide);
    el('sp-side-toggle').textContent = hide ? 'Show the teams' : 'Hide the teams';
    fit();
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    var t = e.target;
    if (t && /^(input|button|a|select|textarea)$/i.test(t.tagName || '')) return;
    e.preventDefault();
    spin();
  });
  window.addEventListener('resize', function () { if (!el('sp-app').classList.contains('hidden')) fit(); });
  load();
})();
