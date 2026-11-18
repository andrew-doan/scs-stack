// The Routes tab: the route each team recorded for the GPS quest. A GPX
// file is cleaned here, in the browser, by the site's own cleaner
// (tab/replay/track-clean.js, the file tracks/clean.mjs runs too),
// drawn over the file as recorded, and saved on the worker for the
// replay (src/tracks.ts). What the cleaner does is in tracks/CLAUDE.md.
(function (dash) {
  // core.js
  var api = dash.api, armed = dash.armed, btn = dash.btn, busy = dash.busy, done = dash.done, el = dash.el,
    emptyRow = dash.emptyRow, fill = dash.fill, fmtTime = dash.fmtTime, h = dash.h, post = dash.post,
    postForm = dash.postForm, row = dash.row, shake = dash.shake, SITE = dash.SITE, state = dash.state,
    toast = dash.toast;

  dash.loadRoutes = loadRoutes;

  state.routes = null;
  var MAX_GPX = 25 * 1024 * 1024;
  var TRIPS_HINT = 'TransportSeek’s string-line files for the day. Without them, rides underground run at a typical speed.';
  var rt = {
    ready: null,     // the cleaner and the rail network, loading or loaded
    lib: null,
    net: null,
    trips: [],       // recorded trips from the string-line files
    teams: [],       // the team list, when the overview has not come yet
    queue: [],       // files waiting their turn in the editor
    job: null,       // the file in the editor: {name, text, file, key, team_id, edits, notes, keep}
    res: null,       // what the cleaner made of it
    mapReady: null,
    map: null,
    timer: null
  };

  function teams() { return state.teams.length ? state.teams : rt.teams; }
  function teamById(id) {
    return teams().filter(function (t) { return String(t.id) === String(id); })[0] || null;
  }
  function teamName(id) {
    var t = teamById(id);
    return t ? t.name : 'Team ' + id;
  }
  function savedFor(id) {
    return state.routes ? state.routes.tracks.filter(function (t) { return String(t.team_id) === String(id); })[0] || null : null;
  }
  // a UTC stamp as a clock time on this device
  function clockText(utc) {
    var m = String(utc || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    if (!m) return '';
    return new Date(m[1] + 'T' + m[2] + ':00Z').toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  function kb(bytes) { return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + 'MB' : Math.max(1, Math.round(bytes / 1024)) + 'KB'; }

  // ---- the cleaner, from the site ----
  function cleaner() {
    if (rt.ready) return rt.ready;
    rt.ready = new Promise(function (resolve, reject) {
      if (window.SCSTrackClean) { resolve(window.SCSTrackClean); return; }
      var tag = h('script');
      tag.src = SITE + '/tab/replay/track-clean.js';
      tag.onload = function () { if (window.SCSTrackClean) resolve(window.SCSTrackClean); else reject(new Error('no cleaner')); };
      tag.onerror = function () { reject(new Error('The cleaner did not load from the site.')); };
      document.head.appendChild(tag);
    }).then(function (lib) {
      return fetch(SITE + '/assets/transit.geojson').then(function (r) {
        if (!r.ok) throw new Error('The rail lines did not load from the site.');
        return r.json();
      }).then(function (geo) {
        rt.lib = lib;
        rt.net = lib.network(geo);
        return lib;
      });
    });
    rt.ready.catch(function () { rt.ready = null; });
    return rt.ready;
  }

  // ---- the list ----
  function loadRoutes() {
    var named = state.teams.length ? Promise.resolve() : api('/api/console/overview').then(function (d) {
      if (d.ok) rt.teams = d.teams;
    });
    return Promise.all([named, api('/api/console/tracks')]).then(function (got) {
      var d = got[1];
      if (!d.ok) return;
      state.routes = d;
      paintRoutes();
      if (rt.map) rt.map.resize();
    }).catch(function () {});
  }

  function paintRoutes() {
    var d = state.routes;
    var list = d.tracks.slice().sort(function (a, b) { return teamName(a.team_id).localeCompare(teamName(b.team_id)); });
    fill(el('routes-rows'), list.length ? list.map(routeRow) : [emptyRow('No routes saved yet.', 4)]);
    var used = {};
    d.tracks.forEach(function (t) { if (t.sent_key) used[t.sent_key] = true; });
    fill(el('routes-sent'), d.sent.length ? d.sent.map(function (f) {
      var file = h('td');
      file.appendChild(h('div', null, f.name));
      file.appendChild(h('div', 'muted', kb(f.bytes)));
      var sent = h('td');
      sent.appendChild(h('div', null, fmtTime(f.sent_at)));
      sent.appendChild(h('div', 'muted', f.status));
      var actions = h('td', 'num');
      if (used[f.key]) actions.appendChild(h('span', 'muted', 'Saved '));
      var go = btn('Clean', 'quiet small', function () {
        busy(go, api('/api/console/tracks/gpx?key=' + encodeURIComponent(f.key))).then(function (r) {
          if (!r.ok) { done(r); return; }
          startQueue([{ name: r.name, text: r.text, key: f.key, team_id: f.team_id }]);
        });
      });
      actions.appendChild(go);
      return row([h('td', null, teamName(f.team_id)), file, sent, actions]);
    }) : [emptyRow('No team has sent a GPX file.', 4)]);
  }

  function routeRow(t) {
    var name = h('td', null, teamName(t.team_id));
    var team = teamById(t.team_id);
    if (team && team.hidden) name.appendChild(h('span', 'muted', ' (hidden)'));
    var when = h('td');
    when.appendChild(h('div', null, fmtTime(t.started_at) + ' to ' + clockText(t.ended_at)));
    when.appendChild(h('div', 'muted', t.points + ' points' + (t.source ? ', from ' + t.source : '')));
    var saved = h('td');
    saved.appendChild(h('div', null, fmtTime(t.saved_at) + ' by ' + (t.saved_by || '?')));
    if (t.notes) saved.appendChild(h('div', 'muted', t.notes));
    var actions = h('td', 'num');
    var wrap = h('span', 'inline');
    if (t.has_gpx) {
      var edit = btn('Edit', 'quiet small', function () {
        busy(edit, api('/api/console/tracks/gpx?team_id=' + t.team_id)).then(function (r) {
          if (!r.ok) { done(r); return; }
          startQueue([{ name: r.name, text: r.text, team_id: t.team_id, edits: t.edits, notes: t.notes, keep: true }]);
        });
      });
      wrap.appendChild(edit);
    }
    wrap.appendChild(armed('Delete', 'Delete route', function (go) {
      busy(go, post('/api/console/tracks/delete', { team_id: t.team_id })).then(function (r) {
        if (done(r, 'Route deleted')) loadRoutes();
      });
    }));
    actions.appendChild(wrap);
    return row([name, when, saved, actions]);
  }

  // ---- files in, one at a time through the editor ----
  el('routes-add').addEventListener('click', function () { el('routes-files').click(); });
  el('routes-files').addEventListener('change', function () {
    var input = this;
    var files = Array.prototype.slice.call(input.files || []);
    input.value = '';
    var big = files.filter(function (f) { return f.size > MAX_GPX; });
    if (big.length) toast(big.map(function (f) { return f.name; }).join(', ') + ': larger than 25MB.', true);
    files = files.filter(function (f) { return f.size <= MAX_GPX; });
    Promise.all(files.map(function (f) {
      return f.text().then(function (text) { return { name: f.name, text: text, file: f, team_id: null }; });
    })).then(function (jobs) { if (jobs.length) startQueue(jobs); });
  });

  // A file already in the editor stays there: more files join the end of
  // the queue behind it.
  function startQueue(jobs) {
    if (rt.job) {
      rt.queue = rt.queue.concat(jobs);
      rt.total += jobs.length;
      paintQueue();
      toast(jobs.length === 1 ? jobs[0].name + ' is waiting behind ' + rt.job.name + '.'
        : jobs.length + ' files are waiting behind ' + rt.job.name + '.');
      return;
    }
    rt.queue = jobs.slice(1);
    rt.total = jobs.length;
    show(jobs[0]);
  }
  function paintQueue() {
    var at = rt.total - rt.queue.length;
    el('routes-queue').textContent = rt.total > 1 ? 'File ' + at + ' of ' + rt.total : '';
    el('routes-skip').classList.toggle('hidden', !rt.queue.length);
  }
  function next() {
    if (rt.queue.length) { show(rt.queue.shift()); return; }
    closeEditor();
  }
  function closeEditor() {
    rt.job = null;
    rt.res = null;
    rt.queue = [];
    el('routes-editor').classList.add('hidden');
  }

  // a team whose name is in the file's name or the track's own name, the
  // longest such name winning
  function norm(s) { return String(s || '').toLowerCase().replace(/\.gpx$/, '').replace(/[^a-z0-9]+/g, ' ').trim(); }
  function guessTeam(job) {
    var hay = ' ' + norm(job.name) + ' ' + norm(rt.lib.gpxName(job.text)) + ' ';
    var best = null;
    teams().forEach(function (t) {
      var n = norm(t.name);
      if (n.length < 3 || hay.indexOf(' ' + n + ' ') === -1) return;
      if (!best || n.length > norm(best.name).length) best = t;
    });
    return best ? best.id : '';
  }

  function show(job) {
    rt.job = job;
    rt.res = null;
    el('routes-editor').classList.remove('hidden');
    el('routes-file').textContent = job.name;
    paintQueue();
    var e = job.edits || { from: '', to: '', cut: [] };
    el('routes-from').value = e.from || '';
    el('routes-to').value = e.to || '';
    el('routes-cuts').textContent = '';
    (e.cut || []).forEach(function (c) { addCut(c[0], c[1]); });
    el('routes-notes-box').value = job.notes || '';
    el('routes-summary').textContent = 'Cleaning…';
    el('routes-notes').textContent = '';
    el('routes-save').disabled = true;
    el('routes-gpx').disabled = true;
    paintTrips();
    el('routes-editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
    cleaner().then(function () {
      if (job.team_id == null) job.team_id = guessTeam(job);
      fillTeams(job);
      return routeMap().then(function () { rt.map.resize(); }, function () { /* the route still cleans without a map */ });
    }).then(function () {
      if (rt.job === job) runClean();
    }, function (err) {
      el('routes-summary').textContent = err.message;
    });
  }

  function fillTeams(job) {
    var pick = el('routes-team');
    pick.textContent = '';
    var none = h('option', null, 'Pick a team');
    none.value = '';
    pick.appendChild(none);
    teams().slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (t) {
      var o = h('option', null, t.name + (t.hidden ? ' (hidden)' : '') + (savedFor(t.id) && !job.keep ? ' (has a route)' : ''));
      o.value = String(t.id);
      pick.appendChild(o);
    });
    pick.value = job.team_id ? String(job.team_id) : '';
    // a saved route stays with its team; its file can be cleaned again
    pick.disabled = !!job.keep;
    saveLabel();
  }
  function saveLabel() {
    var id = el('routes-team').value;
    el('routes-save').textContent = id && savedFor(id) && !(rt.job && rt.job.keep) ? 'Replace its route' : 'Save route';
  }
  el('routes-team').addEventListener('change', saveLabel);

  // ---- what is cut before cleaning ----
  function addCut(a, b) {
    var line = h('span', 'rt-cut');
    var from = h('input'); from.type = 'time'; from.value = a || ''; from.setAttribute('aria-label', 'Leave out from');
    var to = h('input'); to.type = 'time'; to.value = b || ''; to.setAttribute('aria-label', 'Leave out until');
    line.appendChild(from);
    line.appendChild(document.createTextNode('to'));
    line.appendChild(to);
    line.appendChild(btn('Remove', 'quiet small', function () { line.parentNode.removeChild(line); soon(); }));
    from.addEventListener('change', soon);
    to.addEventListener('change', soon);
    el('routes-cuts').appendChild(line);
  }
  el('routes-cut-add').addEventListener('click', function () { addCut('', ''); });
  el('routes-from').addEventListener('change', soon);
  el('routes-to').addEventListener('change', soon);

  function readEdits() {
    var cut = [];
    Array.prototype.forEach.call(el('routes-cuts').querySelectorAll('.rt-cut'), function (line) {
      var boxes = line.querySelectorAll('input');
      if (boxes[0].value && boxes[1].value && boxes[0].value < boxes[1].value) cut.push([boxes[0].value, boxes[1].value]);
    });
    return { from: el('routes-from').value, to: el('routes-to').value, cut: cut };
  }
  // keep the points inside the edits, by Sydney's clock on the day
  function applyEdits(raw, e) {
    return raw.filter(function (p) {
      var c = rt.lib.clock(p.t).slice(0, 5);
      if (e.from && c < e.from) return false;
      if (e.to && c > e.to) return false;
      for (var i = 0; i < e.cut.length; i++) if (c >= e.cut[i][0] && c < e.cut[i][1]) return false;
      return true;
    });
  }

  // ---- recorded trips ----
  el('routes-trips-add').addEventListener('click', function () { el('routes-trips').click(); });
  el('routes-trips').addEventListener('change', function () {
    var input = this;
    var files = Array.prototype.slice.call(input.files || []);
    input.value = '';
    Promise.all(files.map(function (f) {
      return f.text().then(function (text) { return { name: f.name, data: JSON.parse(text) }; }).catch(function () { return null; });
    })).then(function (got) {
      return cleaner().then(function (lib) {
        rt.trips = lib.trips(got.filter(Boolean));
        if (!rt.trips.length) toast('None of those are string-line files.', true);
        paintTrips();
        if (rt.job) runClean();
      });
    }).catch(function (err) { toast(err.message, true); });
  });
  function paintTrips() {
    el('routes-trips-state').textContent = rt.trips.length
      ? 'Loaded: ' + rt.trips.map(function (l) { return l.line; }).join(', ') + '.'
      : TRIPS_HINT;
  }

  // ---- cleaning and drawing ----
  function soon() {
    clearTimeout(rt.timer);
    rt.timer = setTimeout(function () { if (rt.job && rt.lib) runClean(); }, 250);
  }

  function runClean() {
    var job = rt.job;
    var lib = rt.lib;
    var raw = applyEdits(lib.readGpx(job.text), readEdits());
    var res = raw.length >= 2 ? lib.clean(rt.net, raw, { trips: rt.trips }) : null;
    var ok = !!(res && res.pts.length >= 2);
    rt.res = ok ? res : null;
    el('routes-save').disabled = !ok;
    el('routes-gpx').disabled = !ok;
    el('routes-notes').textContent = '';
    if (!ok) {
      el('routes-summary').textContent = raw.length < 2 ? 'Nothing is left to clean.' : 'No points between 09:00 and 18:30 on the day.';
      draw(raw, null);
      return;
    }
    var pts = res.pts;
    el('routes-summary').textContent = raw.length + ' points recorded, ' + pts.length + ' kept, ' +
      lib.clock(pts[0].t).slice(0, 5) + ' to ' + lib.clock(pts[pts.length - 1].t).slice(0, 5) + ' Sydney time.';
    res.notes.forEach(function (n) { el('routes-notes').appendChild(h('li', null, n)); });
    draw(raw, res);
  }

  var EMPTY = { type: 'FeatureCollection', features: [] };
  function line(coords) { return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } }; }
  // the cleaned route in runs, dashed where a ride was filled in with no
  // fixes on it
  function runs(res) {
    var filled = res.legs.filter(function (l) { return l.filled; });
    function isFilled(t) { return filled.some(function (l) { return t >= l.t0 && t <= l.t1; }); }
    var solid = [], dashed = [], cur = null, curKind = null;
    for (var i = 1; i < res.pts.length; i++) {
      var a = res.pts[i - 1], b = res.pts[i];
      var kind = isFilled(a.t) && isFilled(b.t) ? 'dashed' : 'solid';
      if (kind !== curKind) {
        cur = [[a.lon, a.lat]];
        (kind === 'dashed' ? dashed : solid).push(line(cur));
        curKind = kind;
      }
      cur.push([b.lon, b.lat]);
    }
    return { solid: { type: 'FeatureCollection', features: solid }, dashed: { type: 'FeatureCollection', features: dashed } };
  }

  function draw(raw, res) {
    var map = rt.map;
    if (!map || !map.getSource('rt-raw')) return;
    map.getSource('rt-raw').setData(raw.length >= 2 ? { type: 'FeatureCollection', features: [line(raw.map(function (p) { return [p.lon, p.lat]; }))] } : EMPTY);
    var r = res ? runs(res) : { solid: EMPTY, dashed: EMPTY };
    map.getSource('rt-clean').setData(r.solid);
    map.getSource('rt-filled').setData(r.dashed);
    var pts = res ? res.pts : raw;
    if (pts.length < 2) return;
    var w = 180, e = -180, s = 90, n = -90;
    pts.forEach(function (p) { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); });
    map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 0, maxZoom: 15 });
  }

  var INK = '#111111';
  function routeMap() {
    if (rt.mapReady) return rt.mapReady;
    rt.mapReady = Promise.all([dash.loadMapLib(), dash.teamMapStyle()]).then(function (got) {
      var lib = got[0];
      var map = new lib.Map({
        container: 'routes-map', style: got[1], center: [151.12, -33.87], zoom: 10,
        maxBounds: dash.MAP_BOUNDS, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false,
        cooperativeGestures: window.matchMedia('(pointer: coarse)').matches
      });
      map.touchZoomRotate.disableRotation();
      map.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
      dash.addTransit(map, { under: 'rt-raw', opacity: 0.35 });
      return new Promise(function (resolve) {
        var added = false;
        function ready() {
          if (added) return;
          added = true;
          ['rt-raw', 'rt-clean', 'rt-filled'].forEach(function (id) { map.addSource(id, { type: 'geojson', data: EMPTY }); });
          var round = { 'line-cap': 'round', 'line-join': 'round' };
          map.addLayer({ id: 'rt-raw', type: 'line', source: 'rt-raw', layout: round,
            paint: { 'line-color': '#8d8f93', 'line-width': 2, 'line-opacity': 0.9 } });
          map.addLayer({ id: 'rt-casing', type: 'line', source: 'rt-clean', layout: round,
            paint: { 'line-color': '#ffffff', 'line-width': 7 } });
          map.addLayer({ id: 'rt-clean', type: 'line', source: 'rt-clean', layout: round,
            paint: { 'line-color': INK, 'line-width': 3.5 } });
          map.addLayer({ id: 'rt-filled', type: 'line', source: 'rt-filled', layout: { 'line-join': 'round' },
            paint: { 'line-color': INK, 'line-width': 3.5, 'line-dasharray': [1.6, 1.2] } });
          rt.map = map;
          resolve(map);
        }
        map.once('style.load', ready);
        map.once('load', ready);
        if (map.isStyleLoaded()) ready();
      });
    });
    rt.mapReady.catch(function () { rt.mapReady = null; });
    return rt.mapReady;
  }

  // ---- saving ----
  el('routes-save').addEventListener('click', function () {
    var job = rt.job;
    var pick = el('routes-team');
    if (!job || !rt.res) return;
    if (!pick.value) { shake(pick); return; }
    var team = teamById(pick.value);
    var form = new FormData();
    form.append('team_id', pick.value);
    form.append('route', JSON.stringify(rt.lib.toReplay(team ? team.name : '', rt.res)));
    form.append('source', job.name);
    form.append('edits', JSON.stringify(readEdits()));
    form.append('notes', el('routes-notes-box').value);
    if (job.file) form.append('gpx', job.file, job.name);
    else if (job.key) form.append('gpx_key', job.key);
    var team = teamName(pick.value);
    // Skip waits for the save, which moves on by itself
    el('routes-skip').disabled = true;
    busy(el('routes-save'), postForm('/api/console/tracks/save', form)).then(function (r) {
      el('routes-skip').disabled = false;
      if (!done(r, 'Route saved for ' + team)) return;
      loadRoutes();
      // closed or moved on while it was saving: nothing more to do here
      if (rt.job === job) next();
    }, function () { el('routes-skip').disabled = false; });
  });
  el('routes-skip').addEventListener('click', next);
  el('routes-cancel').addEventListener('click', closeEditor);
  el('routes-gpx').addEventListener('click', function () {
    if (!rt.res) return;
    var id = el('routes-team').value;
    var label = id ? teamName(id) : rt.job.name.replace(/\.gpx$/i, '');
    var url = URL.createObjectURL(new Blob([rt.lib.toGpx(label, rt.res.pts)], { type: 'application/gpx+xml' }));
    var a = h('a');
    a.href = url;
    a.download = rt.job.name.replace(/\.gpx$/i, '') + ' (cleaned).gpx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });
})(window.dash);
