// The Recap tab: every leaderboard, the boards made on the tab, and the
// recap page's numbers, hours and sections.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, busy = dash.busy, done = dash.done, el = dash.el,
    fmtTime = dash.fmtTime, fromLocalInput = dash.fromLocalInput, h = dash.h, post = dash.post,
    shake = dash.shake, statCard = dash.statCard, state = dash.state, teamShown = dash.teamShown,
    toast = dash.toast, toLocalInput = dash.toLocalInput;
  // uploads.js
  var sizeText = dash.sizeText;

  dash.recapTable = recapTable;
  dash.paintAfter = paintAfter;
  dash.loadAfter = loadAfter;
  dash.paintRanks = paintRanks;
  dash.fillCustomQuests = fillCustomQuests;
  dash.loadRanks = loadRanks;

  // ---- the recap, for organisers ----
  // The numbers the site's recap page shows, read whatever its switch
  // says, so the committee can look before the page is opened.
  function recapMinutes(m) {
    if (m == null) return '';
    if (m < 1) return 'under a minute';
    if (m < 90) return Math.round(m) + ' min';
    return (Math.round(m / 6) / 10) + ' h';
  }
  function recapNum(n) { return (Math.round((n || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  // an hour of the day in this device's zone
  function recapHour(hour) {
    var d = new Date(String(hour).replace(' ', 'T') + ':00Z');
    if (isNaN(d.getTime())) return hour;
    return d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric' });
  }
  function recapTable(title, head, rows) {
    var card = h('div', 'card rg-chart');
    card.appendChild(h('p', 'rg-chart-title', title));
    if (!rows.length) { card.appendChild(h('p', 'note', 'Nothing yet.')); return card; }
    var table = h('table');
    if (head) {
      var thead = h('thead');
      var tr = h('tr');
      head.forEach(function (c, i) { tr.appendChild(h('th', i ? 'num' : null, c)); });
      thead.appendChild(tr);
      table.appendChild(thead);
    }
    var body = h('tbody');
    rows.forEach(function (r) {
      var row = h('tr');
      r.forEach(function (c, i) { row.appendChild(h('td', i ? 'num' : null, String(c))); });
      body.appendChild(row);
    });
    table.appendChild(body);
    card.appendChild(table);
    return card;
  }
  function questLabel(q) { return q.key + ' ' + q.name; }
  function paintRecap(d) {
    var view = el('recap-view');
    view.textContent = '';
    var s = d.submissions;
    var stats = h('div', 'board');
    stats.appendChild(statCard('Teams', d.teams, d.quests + ' quests on the list'));
    stats.appendChild(statCard('Quests done', d.completions, recapNum(d.points) + ' points in all'));
    stats.appendChild(statCard('Submissions', s.sent, s.accepted + ' accepted · ' + s.rejected + ' rejected · ' + s.pending + ' waiting'));
    stats.appendChild(statCard('Review time', d.review.reviewed ? recapMinutes(d.review.median_minutes) : '–',
      d.review.reviewed ? 'median; fastest ' + recapMinutes(d.review.fastest_minutes) + ', slowest ' + recapMinutes(d.review.slowest_minutes) : 'nothing reviewed yet'));
    stats.appendChild(statCard('Photos and videos', d.files.photos + d.files.videos,
      d.files.photos + ' photos · ' + d.files.videos + ' videos · ' + sizeText(d.files.bytes)));
    stats.appendChild(statCard('Checked in', d.checkins.n,
      d.checkins.n ? 'teams, from ' + fmtTime(d.checkins.first_at) : 'no team yet'));
    view.appendChild(stats);

    var charts = h('div', 'rg-charts');
    var busy = s.busiest_hour;
    charts.appendChild(dash.regoBarChart('Submissions by hour',
      busy ? 'Busiest: ' + recapHour(busy.hour) + ', ' + busy.sent + ' sent' : '',
      s.by_hour.map(function (r) { return { label: recapHour(r.hour), n: r.sent }; }), s.sent, ['submission', 'submissions']));
    charts.appendChild(dash.regoBarChart('Most done', 'Teams that did each quest',
      d.most_done.map(function (q) { return { label: questLabel(q), n: q.done_by }; }), d.teams, ['team', 'teams']));
    charts.appendChild(recapTable('Top of the tab', ['Team', 'Points', 'Quests'],
      d.top_teams.map(function (t) { return [t.rank + '. ' + t.name, recapNum(t.points), t.quests_done]; })));
    charts.appendChild(recapTable('Busiest senders', ['Team', 'Sent', 'Accepted', 'Rejected'],
      d.most_active.map(function (t) { return [t.name, t.sent, t.accepted, t.rejected]; })));
    charts.appendChild(recapTable('By region', ['Region', 'Points', 'Done', 'Teams'],
      d.regions.map(function (r) { return [r.region, recapNum(r.points), r.completions, r.teams]; })));
    charts.appendChild(recapTable('Rarely done', ['Quest', 'Teams'],
      d.least_done.map(function (q) { return [questLabel(q), q.done_by]; })));
    var never = d.never_done.slice(0, 15).map(function (q) { return [questLabel(q), q.region || '']; });
    if (d.never_done.length > 15) never.push(['and ' + (d.never_done.length - 15) + ' more', '']);
    charts.appendChild(recapTable('Never done', ['Quest', 'Region'], never));
    var odds = [];
    if (d.biggest_score) odds.push(['Biggest single score', d.biggest_score.team + ', ' + d.biggest_score.code + ' (' + recapNum(d.biggest_score.worth) + ')']);
    if (d.points_spread) odds.push(['Points across teams', recapNum(d.points_spread.min) + ' to ' + recapNum(d.points_spread.max) + ', median ' + recapNum(d.points_spread.median)]);
    if (s.first_at) odds.push(['First submission', fmtTime(s.first_at)]);
    if (s.last_at) odds.push(['Last submission', fmtTime(s.last_at)]);
    odds.push(['In the gallery', d.files.gallery]);
    if (d.asks.questions) odds.push(['Questions asked', d.asks.questions + ', ' + d.asks.answers + ' answers']);
    charts.appendChild(recapTable('Odds and ends', null, odds));
    view.appendChild(charts);
    view.classList.remove('hidden');
  }
  function loadRecap() {
    return api('/api/console/recap').then(function (d) {
      if (!d.ok) { toast(d.error || 'Could not count the recap.', true); return; }
      paintRecap(d);
      el('recap-state').textContent = (d.public ? 'The recap page is on the site.' : 'The recap page is not on the site yet.') +
        ' Counted at ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '.';
      el('recap-load').textContent = 'Count again';
    });
  }
  el('recap-load').addEventListener('click', function () { busy(el('recap-load'), loadRecap()).catch(function () {}); });

  // What the after-the-event pages leave out: the hours the recap and team
  // pages chart, the decisions the review times count, the quest times a
  // team's page shows, and the time after which nothing shows as a team's
  // last scored quest on the live tab. Empty leaves everything in.
  function paintAfter(d) {
    el('recap-from').value = toLocalInput(d.hours.from);
    el('recap-to').value = toLocalInput(d.hours.to);
    el('recap-mode').value = d.hours.mode === 'hide' ? 'hide' : 'merge';
    el('review-from').value = toLocalInput(d.review.from);
    el('review-to').value = toLocalInput(d.review.to);
    el('team-times-from').value = toLocalInput(d.times.from);
    el('team-times-to').value = toLocalInput(d.times.to);
    el('arrivals-from').value = toLocalInput(d.arrivals.from);
    el('arrivals-to').value = toLocalInput(d.arrivals.to);
    state.mostSkip = d.most_skip || [];
    paintMostSkip();
    state.questViews = d.quest_views || {};
    paintQuestViews();
    state.dateRules = (d.date_rules || []).slice();
    paintDateRules();
    el('recap-seen').textContent = d.seen.first ? 'Sent from ' + fmtTime(d.seen.first) + ' to ' + fmtTime(d.seen.last) + '.' : '';
    el('last-until').value = toLocalInput(d.last_until);
  }
  function loadAfter() {
    api('/api/console/recap/hours').then(function (d) { if (d.ok) paintAfter(d); }).catch(function () {});
    loadSections();
  }

  // The recap's own sections: a heading, a few words, and entries, each a
  // line, some words and photos or videos picked from the Files tab
  state.sections = [];
  state.secFiles = [];
  function loadSections() {
    api('/api/console/recap/sections').then(function (d) {
      if (!d.ok) return;
      state.sections = d.sections || [];
      state.secFiles = d.files || [];
      paintSections();
    }).catch(function () {});
  }
  function secField(tag, value, placeholder, onInput) {
    var f = document.createElement(tag);
    if (tag === 'input') f.type = 'text';
    else f.rows = 2;
    f.value = value || '';
    f.placeholder = placeholder;
    f.setAttribute('aria-label', placeholder);
    f.addEventListener('input', function () { onInput(f.value); });
    return f;
  }
  function secButton(text, label, onClick) {
    var b = h('button', 'quiet small', text);
    b.type = 'button';
    if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', onClick);
    return b;
  }
  function moveIn(list, i, by) {
    var j = i + by;
    if (j < 0 || j >= list.length) return;
    var x = list[i];
    list[i] = list[j];
    list[j] = x;
    paintSections();
  }
  function paintSections() {
    var list = el('sec-list');
    list.textContent = '';
    if (!state.sections.length) { list.appendChild(h('p', 'muted', 'No sections yet.')); return; }
    state.sections.forEach(function (sec, i) {
      var box = h('div', 'sec-box');
      var head = h('div', 'sec-head');
      head.appendChild(secField('input', sec.title, 'Heading', function (v) { sec.title = v; }));
      head.appendChild(secButton('\u2191', 'Move the section up', function () { moveIn(state.sections, i, -1); }));
      head.appendChild(secButton('\u2193', 'Move the section down', function () { moveIn(state.sections, i, 1); }));
      head.appendChild(secButton('Remove', 'Remove the section', function () { state.sections.splice(i, 1); paintSections(); }));
      box.appendChild(head);
      box.appendChild(secField('textarea', sec.text, 'Words under the heading', function (v) { sec.text = v; }));
      (sec.items = sec.items || []).forEach(function (it, k) {
        var row = h('div', 'sec-item');
        var top = h('div', 'sec-head');
        top.appendChild(secField('input', it.title, 'Entry, such as Coolest group photo: Galahs', function (v) { it.title = v; }));
        top.appendChild(secButton('\u2191', 'Move the entry up', function () { moveIn(sec.items, k, -1); }));
        top.appendChild(secButton('\u2193', 'Move the entry down', function () { moveIn(sec.items, k, 1); }));
        top.appendChild(secButton('Remove', 'Remove the entry', function () { sec.items.splice(k, 1); paintSections(); }));
        row.appendChild(top);
        row.appendChild(secField('textarea', it.text, 'Words', function (v) { it.text = v; }));
        var media = h('p', 'most-skip-list');
        (it.media = it.media || []).forEach(function (m, n) {
          var f = state.secFiles.filter(function (x) { return x.key === m.key; })[0];
          media.appendChild(secButton((f ? f.name : 'A deleted file') + ' \u00d7', 'Take it off', function () { it.media.splice(n, 1); paintSections(); }));
        });
        row.appendChild(media);
        var pick = h('div', 'row-form');
        var sel = document.createElement('select');
        sel.setAttribute('aria-label', 'Photo or video');
        sel.appendChild(new Option(state.secFiles.length ? 'Pick a photo or video' : 'Nothing on the Files tab yet', ''));
        state.secFiles.forEach(function (f) { sel.appendChild(new Option(f.name, f.key)); });
        pick.appendChild(sel);
        pick.appendChild(secButton('Add', null, function () {
          if (!sel.value) { shake(sel); return; }
          it.media.push({ key: sel.value, alt: '' });
          paintSections();
        }));
        row.appendChild(pick);
        box.appendChild(row);
      });
      box.appendChild(secButton('Add an entry', null, function () {
        sec.items.push({ title: '', text: '', media: [] });
        paintSections();
      }));
      list.appendChild(box);
    });
  }
  el('sec-add').addEventListener('click', function () {
    state.sections.push({ title: '', text: '', items: [{ title: '', text: '', media: [] }] });
    paintSections();
  });
  el('sec-save').addEventListener('click', function () {
    busy(el('sec-save'), post('/api/console/recap/sections', { sections: state.sections })).then(function (r) {
      if (done(r, 'Saved the sections.')) {
        state.sections = r.sections;
        paintSections();
      }
    }).catch(function () {});
  });
  el('recap-hours-save').addEventListener('click', function () {
    var body = { from: fromLocalInput(el('recap-from').value), to: fromLocalInput(el('recap-to').value), mode: el('recap-mode').value };
    busy(el('recap-hours-save'), post('/api/console/recap/hours', body)).then(function (r) {
      if (done(r, body.from || body.to ? 'Saved the hours.' : 'The charts show every hour.')) {
        paintAfter(r);
        if (!el('recap-view').classList.contains('hidden')) loadRecap();
      }
    }).catch(function () {});
  });
  el('review-save').addEventListener('click', function () {
    var body = { from: fromLocalInput(el('review-from').value), to: fromLocalInput(el('review-to').value) };
    busy(el('review-save'), post('/api/console/recap/review', body)).then(function (r) {
      if (done(r, 'Saved.')) {
        paintAfter(r);
        if (!el('recap-view').classList.contains('hidden')) loadRecap();
      }
    }).catch(function () {});
  });
  // the days whose times show without a date: a kind and a day each
  state.dateRules = [];
  function paintDateRules() {
    var list = el('date-rules');
    list.textContent = '';
    if (!state.dateRules.length) { list.appendChild(h('p', 'muted', 'No rules. Times from another day show their date.')); return; }
    state.dateRules.forEach(function (r, i) {
      var row = h('div', 'row-form');
      var kind = document.createElement('select');
      kind.setAttribute('aria-label', 'Which days');
      [['on', 'On'], ['from', 'On and after'], ['until', 'On and before']].forEach(function (o) { kind.appendChild(new Option(o[1], o[0])); });
      kind.value = r.kind;
      kind.addEventListener('change', function () { r.kind = kind.value; });
      var day = document.createElement('input');
      day.type = 'date';
      day.value = r.date;
      day.setAttribute('aria-label', 'Day');
      day.addEventListener('change', function () { r.date = day.value; });
      row.appendChild(kind);
      row.appendChild(day);
      row.appendChild(btn('Remove', 'quiet small', function () { state.dateRules.splice(i, 1); paintDateRules(); }));
      list.appendChild(row);
    });
  }
  el('date-rule-add').addEventListener('click', function () {
    state.dateRules.push({ kind: 'on', date: '' });
    paintDateRules();
  });
  el('date-rules-save').addEventListener('click', function () {
    busy(el('date-rules-save'), post('/api/console/recap/dates', { rules: state.dateRules })).then(function (r) {
      if (done(r, 'Saved the rules.')) {
        state.dateRules = r.rules.slice();
        paintDateRules();
      }
    }).catch(function () {});
  });

  // the quests Most done side quests and Rarely done leave out, each a
  // chip that puts it back
  state.mostSkip = [];
  function saveMostSkip(keys, button) {
    return busy(button, post('/api/console/recap/most-skip', { keys: keys })).then(function (r) {
      if (done(r, 'Saved.')) paintAfter(r);
    }).catch(function () {});
  }
  function paintMostSkip() {
    var list = el('most-skip-list');
    list.textContent = '';
    if (!state.mostSkip.length) { list.appendChild(h('span', 'muted', 'None left out.')); return; }
    state.mostSkip.forEach(function (key) {
      var chip = h('button', 'quiet small most-skip-chip', key + ' \u00d7');
      chip.type = 'button';
      chip.setAttribute('aria-label', 'Put ' + key + ' back');
      chip.addEventListener('click', function () {
        saveMostSkip(state.mostSkip.filter(function (k) { return k !== key; }), chip);
      });
      list.appendChild(chip);
    });
  }
  el('most-skip-add').addEventListener('click', function () {
    var key = el('most-skip-pick').value;
    if (!key) { shake(el('most-skip-pick')); return; }
    if (state.mostSkip.indexOf(key) >= 0) return;
    saveMostSkip(state.mostSkip.concat([key]), el('most-skip-add'));
  });
  // the quests shown photo by photo, each a chip that shows it as sent again
  var VIEW_WORDS = { stations: 'at the stations', places: 'at its places' };
  state.questViews = {};
  function saveQuestView(key, view, button) {
    return busy(button, post('/api/console/recap/views', { key: key, view: view })).then(function (r) {
      if (done(r, 'Saved.')) paintAfter(r);
    }).catch(function () {});
  }
  function paintQuestViews() {
    var list = el('quest-view-list');
    list.textContent = '';
    var keys = Object.keys(state.questViews).sort();
    if (!keys.length) { list.appendChild(h('span', 'muted', 'Every quest shows each team once.')); return; }
    keys.forEach(function (key) {
      var chip = h('button', 'quiet small most-skip-chip', key + ' ' + (VIEW_WORDS[state.questViews[key]] || '') + ' \u00d7');
      chip.type = 'button';
      chip.setAttribute('aria-label', 'Show ' + key + ' as sent');
      chip.addEventListener('click', function () { saveQuestView(key, 'sent', chip); });
      list.appendChild(chip);
    });
  }
  el('quest-view-set').addEventListener('click', function () {
    var key = el('quest-view-pick').value;
    if (!key) { shake(el('quest-view-pick')); return; }
    saveQuestView(key, el('quest-view-kind').value, el('quest-view-set'));
  });
  el('arrivals-save').addEventListener('click', function () {
    var body = { from: fromLocalInput(el('arrivals-from').value), to: fromLocalInput(el('arrivals-to').value) };
    busy(el('arrivals-save'), post('/api/console/recap/arrivals', body)).then(function (r) {
      if (done(r, 'Saved.')) {
        paintAfter(r);
        if (!el('recap-view').classList.contains('hidden')) loadRecap();
      }
    }).catch(function () {});
  });
  el('team-times-save').addEventListener('click', function () {
    var body = { from: fromLocalInput(el('team-times-from').value), to: fromLocalInput(el('team-times-to').value) };
    busy(el('team-times-save'), post('/api/console/recap/times', body)).then(function (r) {
      if (done(r, 'Saved.')) paintAfter(r);
    }).catch(function () {});
  });

  // ---- ranks: every leaderboard on one tab ----
  // Points from the tab as it is now, quests done with a quest's sub
  // codes counted once, and the average time from taking a photo to
  // sending it. Hidden teams follow Hide hidden teams everywhere.
  state.ranks = null;
  function placesBy(rows, key) {
    // level teams share a place: 1, 2, 2, 4
    var place = 0;
    return rows.map(function (r, i) {
      if (!i || key(r) !== key(rows[i - 1])) place = i + 1;
      return String(place);
    });
  }
  function rankTable(view, rows, places, cols) {
    view.textContent = '';
    if (!rows.length) { view.appendChild(h('p', 'note', 'Nobody yet.')); return; }
    var table = h('table', 'rank-table');
    var thead = h('thead');
    var head = h('tr');
    head.appendChild(h('th', 'num', 'Place'));
    head.appendChild(h('th', null, 'Team'));
    cols.forEach(function (c) { head.appendChild(h('th', 'num', c.label)); });
    thead.appendChild(head);
    table.appendChild(thead);
    var body = h('tbody');
    rows.forEach(function (r, i) {
      var tr = h('tr');
      tr.appendChild(h('td', 'num', places[i]));
      var cell = h('td');
      var name = r.name + (r.hidden ? ' (hidden)' : '') + (r.dnf ? ' (DNF)' : '');
      if (r.keys && r.keys.length) {
        var more = h('details', 'done-keys');
        more.appendChild(h('summary', null, name));
        more.appendChild(h('p', 'note', r.keys.join(', ')));
        cell.appendChild(more);
      } else {
        cell.textContent = name;
      }
      tr.appendChild(cell);
      cols.forEach(function (c) { tr.appendChild(h('td', 'num', c.value(r))); });
      body.appendChild(tr);
    });
    table.appendChild(body);
    view.appendChild(table);
  }
  // a span of seconds as people say it: 40 s, 4 min 12 s, 1 h 05 min
  function spanText(secs) {
    secs = Math.round(secs);
    if (secs < 60) return secs + ' s';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + ' min ' + (secs % 60) + ' s';
    var m = mins % 60;
    return Math.floor(mins / 60) + ' h ' + (m < 10 ? '0' : '') + m + ' min';
  }
  function paintRanks() {
    var r = state.ranks;
    if (!r) return;
    rankTable(el('rank-points'), r.points, r.points.map(function (t) { return t.dnf ? '–' : String(t.rank); }), [
      { label: 'Points', value: function (t) { return (Math.round(t.points * 100) / 100).toLocaleString('en-US'); } }
    ]);
    var done = r.done.filter(teamShown);
    rankTable(el('done-view'), done, placesBy(done, function (t) { return t.quests; }), [
      { label: 'Quests', value: function (t) { return String(t.quests); } }
    ]);
    var times = r.times.filter(teamShown);
    if (el('times-order').value === 'slow') times = times.slice().reverse();
    rankTable(el('times-view'), times, placesBy(times, function (t) { return t.average; }), [
      { label: 'Average', value: function (t) { return spanText(t.average); } },
      { label: 'Counted', value: function (t) { return String(t.submissions); } }
    ]);
    Array.prototype.slice.call(document.querySelectorAll('.custom-card .rank-view')).forEach(function (v) {
      if (v.scsRows) paintCustom(v);
    });
  }
  // Boards made here: a quest (or every quest), what to count on it
  // (accepted submissions, points, or a challenge's own count, such as
  // stations visited) and a title. Kept on the worker, so every organiser
  // sees the same ones, and a board ticked On the recap page is one of
  // the leaderboards on the site's recap. A card each after the three
  // above.
  var OLD_BOARDS_KEY = 'scs2-dashboard-boards';
  var MEASURES = [['accepted', 'Accepted submissions'], ['points', 'Points'], ['count', 'Challenge count']];
  state.boards = [];
  function measureOf(m) { return m === 'points' || m === 'count' ? m : 'accepted'; }
  function saveBoards() {
    var list = state.boards.map(function (b) {
      return { title: b.title || '', quest: b.quest || '', measure: measureOf(b.measure), recap: !!b.recap };
    });
    return post('/api/console/ranks/boards', { boards: list }).then(function (r) {
      if (!r.ok) toast(r.error || 'Could not save the boards.', true);
    }).catch(function () {});
  }
  function loadBoards() {
    return api('/api/console/ranks/boards').then(function (d) {
      if (!d.ok) return;
      state.boards = d.boards || [];
      var builtin = d.builtin || {};
      el('done-on-recap').checked = !!builtin.quests_done;
      el('times-on-recap').checked = !!builtin.submit_times;
      // boards this device kept for itself before the worker kept them
      var kept = [];
      try { kept = JSON.parse(localStorage.getItem(OLD_BOARDS_KEY) || '[]'); } catch (e) { kept = []; }
      try { localStorage.removeItem(OLD_BOARDS_KEY); } catch (e) {}
      if (!state.boards.length && Array.isArray(kept) && kept.length) {
        state.boards = kept.filter(function (b) { return b && typeof b === 'object'; }).map(function (b) {
          return { title: '', quest: b.quest || '', measure: measureOf(b.measure), recap: false };
        });
        return saveBoards();
      }
    });
  }
  function questChoices(select, value) {
    var opts = [['', 'Every quest']];
    (state.groups || []).slice().sort(function (a, b) { return a.key.localeCompare(b.key, 'en', { numeric: true }); })
      .forEach(function (g) { opts.push([g.key, g.key + ' ' + g.name]); });
    (state.loose || []).forEach(function (c) { opts.push([c.code, c.code]); });
    if (value && !opts.some(function (o) { return o[0] === value; })) opts.push([value, value]);
    select.textContent = '';
    opts.forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; select.appendChild(op); });
    select.value = value || '';
  }
  // the quest list arrives on its own clock: the pickers follow it
  function fillCustomQuests() {
    Array.prototype.slice.call(document.querySelectorAll('.custom-card select.custom-quest')).forEach(function (sel) {
      questChoices(sel, sel.value);
    });
    var skip = el('most-skip-pick');
    questChoices(skip, skip.value);
    skip.options[0].textContent = 'Pick a quest';
    // a quest with a group only: a loose code has no page of its own
    var viewed = el('quest-view-pick');
    var keep = viewed.value;
    viewed.textContent = '';
    viewed.appendChild(h('option', null, 'Pick a quest'));
    viewed.options[0].value = '';
    (state.groups || []).slice().sort(function (a, b) { return a.key.localeCompare(b.key, 'en', { numeric: true }); })
      .forEach(function (g) { var op = h('option', null, g.key + ' ' + g.name); op.value = g.key; viewed.appendChild(op); });
    viewed.value = keep;
  }
  function paintCustom(view) {
    var b = view.scsBoard;
    var rows = (view.scsRows || []).filter(teamShown);
    rankTable(view, rows, placesBy(rows, function (t) { return t.value; }), [
      b.measure === 'points'
        ? { label: 'Points', value: function (t) { return (Math.round(t.value * 100) / 100).toLocaleString('en-US'); } }
        : { label: b.measure === 'count' ? 'Count' : 'Accepted', value: function (t) { return String(t.value); } }
    ]);
  }
  function loadCustom(view) {
    var b = view.scsBoard;
    var seq = (view.scsSeq || 0) + 1;
    view.scsSeq = seq;
    return api('/api/console/ranks/custom?quest=' + encodeURIComponent(b.quest || '') + '&measure=' + measureOf(b.measure))
      .then(function (d) {
        if (view.scsSeq !== seq) return;
        if (!d.ok) { view.textContent = ''; view.appendChild(h('p', 'note', d.error || 'Could not count this board.')); return; }
        view.scsRows = d.teams;
        paintCustom(view);
      }).catch(function () {});
  }
  function addCustomCard(b) {
    var card = h('div', 'card rank-card custom-card');
    var head = h('div', 'card-head');
    var quest = h('select', 'custom-quest');
    quest.setAttribute('aria-label', 'Quest');
    questChoices(quest, b.quest);
    var measure = h('select', 'custom-measure');
    measure.setAttribute('aria-label', 'Count');
    MEASURES.forEach(function (o) {
      var op = h('option', null, o[1]); op.value = o[0]; measure.appendChild(op);
    });
    measure.value = measureOf(b.measure);
    var remove = h('button', 'quiet small', 'Remove');
    remove.type = 'button';
    head.appendChild(quest);
    head.appendChild(measure);
    head.appendChild(remove);
    // its name on the recap, and whether it is there
    var recapRow = h('div', 'row-form custom-recap');
    var title = h('input', 'custom-title');
    title.type = 'text';
    title.maxLength = 60;
    title.placeholder = 'Title, such as Most stations';
    title.setAttribute('aria-label', 'Title');
    title.value = b.title || '';
    var onRecap = h('label', 'check-inline');
    var tick = h('input', 'custom-on-recap');
    tick.type = 'checkbox';
    tick.checked = !!b.recap;
    onRecap.appendChild(tick);
    onRecap.appendChild(document.createTextNode(' On the recap page'));
    recapRow.appendChild(title);
    recapRow.appendChild(onRecap);
    var view = h('div', 'rank-view');
    view.scsBoard = b;
    card.appendChild(head);
    card.appendChild(recapRow);
    card.appendChild(view);
    el('ranks-grid').appendChild(card);
    function change() { b.quest = quest.value; b.measure = measure.value; saveBoards(); loadCustom(view); }
    quest.addEventListener('change', change);
    measure.addEventListener('change', change);
    title.addEventListener('change', function () { b.title = title.value.trim(); saveBoards(); });
    tick.addEventListener('change', function () { b.recap = tick.checked; saveBoards(); });
    remove.addEventListener('click', function () {
      state.boards.splice(state.boards.indexOf(b), 1);
      saveBoards();
      card.parentNode.removeChild(card);
    });
    return loadCustom(view);
  }
  function renderCustom() {
    return loadBoards().then(function () {
      Array.prototype.slice.call(document.querySelectorAll('.custom-card')).forEach(function (c) { c.parentNode.removeChild(c); });
      return Promise.all(state.boards.map(addCustomCard));
    });
  }
  el('custom-add').addEventListener('click', function () {
    var b = { title: '', quest: '', measure: 'accepted', recap: false };
    state.boards.push(b);
    saveBoards();
    addCustomCard(b);
  });
  function loadRanks() {
    return Promise.all([
      api('/api/console/standings'), api('/api/console/quests-done'), api('/api/console/ranks/times'), renderCustom()
    ]).then(function (d) {
      if (!d[0].ok || !d[1].ok || !d[2].ok) { toast(d[0].error || d[1].error || d[2].error || 'Could not count the boards.', true); return; }
      state.ranks = { points: d[0].teams, done: d[1].teams, times: d[2].teams };
      paintRanks();
      el('ranks-state').textContent = 'Counted at ' + new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '.';
    });
  }
  el('ranks-load').addEventListener('click', function () { busy(el('ranks-load'), loadRanks()).catch(function () {}); });
  // Quests done and Photo to submission on the recap
  function saveRankRecap() {
    var body = { quests_done: el('done-on-recap').checked, submit_times: el('times-on-recap').checked };
    return post('/api/console/ranks/recap', body).then(function (r) {
      if (!r.ok) { toast(r.error || 'Could not save.', true); return false; }
      return true;
    }).catch(function () { return false; });
  }
  dash.savesAtOnce(el('done-on-recap'), saveRankRecap);
  dash.savesAtOnce(el('times-on-recap'), saveRankRecap);
  el('times-order').addEventListener('change', paintRanks);
})(window.dash);
