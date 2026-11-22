// The Teams tab: the teams, their submit codes and team groups.
(function (dash) {
  // core.js
  var api = dash.api, armed = dash.armed, btn = dash.btn, busy = dash.busy, can = dash.can,
    canTab = dash.canTab, done = dash.done, el = dash.el, fill = dash.fill, h = dash.h,
    hiddenTeamNames = dash.hiddenTeamNames, HIDE_KEY = dash.HIDE_KEY, post = dash.post, row = dash.row,
    state = dash.state, teamShown = dash.teamShown, textInput = dash.textInput;
  // tabs.js
  var refresh = dash.refresh;

  dash.renderTeams = renderTeams;
  dash.renderTeamGroups = renderTeamGroups;

  // ---- teams ----
  el('teams-hide-hidden').checked = state.hideHidden;
  el('teams-hide-hidden').addEventListener('change', function () {
    state.hideHidden = el('teams-hide-hidden').checked;
    try { localStorage.setItem(HIDE_KEY, state.hideHidden ? '1' : '0'); } catch (e) {}
    renderTeams(); dash.ledgerTeams(); if (can('review')) dash.loadReview(); renderCodes(); renderTeamGroups(); dash.renderViewAs();
    if (state.rego.length) dash.renderRego();
    if (state.discord) dash.renderDiscord();
    if (state.teamMap) dash.renderMap();
    if (dash.loadDesk && canTab('desk')) dash.loadDesk();
    dash.paintRanks();
  });
  function renderTeams() {
    // a team that did not finish (or is hidden) has no place, and tied
    // teams share one
    var ranked = 0;
    var place = 0;
    var lastPts = null;
    var rows = state.teams.filter(teamShown).map(function (t) {
      var name = h('td', null, t.name);
      var act = h('td', 'actions');
      var pts = Math.round(t.pts * 100) / 100;
      var shownPlace = '-';
      if (!t.dnf && !t.hidden) {
        ranked += 1;
        if (pts !== lastPts) { place = ranked; lastPts = pts; }
        shownPlace = String(place);
      }
      var tr = row([h('td', 'num', shownPlace), name, h('td', 'num', pts), h('td', 'num', t.quests_done), act]);
      if (t.hidden) { tr.className = 'is-hidden-team'; name.appendChild(h('span', 'muted', ' (hidden)')); }
      if (t.dnf) name.appendChild(h('span', 'muted', ' (DNF)'));

      var vis = btn(t.hidden ? 'Show' : 'Hide', 'quiet small', function () {
        busy(vis, post('/api/console/teams/hide', { id: t.id, hidden: !t.hidden })).then(function (r) {
          if (done(r, r.hidden ? r.name + ' is hidden from the tab' : r.name + ' is back on the tab')) refresh();
        }).catch(function () {});
      });
      var dnf = btn(t.dnf ? 'Finished' : 'DNF', 'quiet small', function () {
        busy(dnf, post('/api/console/teams/dnf', { id: t.id, dnf: !t.dnf })).then(function (r) {
          if (done(r, function () { return r.dnf ? r.name + ' did not finish' : r.name + ' has a place again'; })) refresh();
        }).catch(function () {});
      });
      var ren = btn('Rename', 'quiet small', function () { editName(); });
      var del = btn('Delete', 'danger small', function () { confirmDelete(); });
      if (canTab('ledger')) act.appendChild(btn('Ledger', 'quiet small', function () { dash.openLedger(t.id); }));
      act.appendChild(vis); act.appendChild(dnf); act.appendChild(ren); act.appendChild(del);

      // rename in place: the name cell becomes an input with Save / Cancel
      function editName() {
        var input = h('input'); input.value = t.name;
        var save = btn('Save', 'small', function () {
          if (!input.value.trim() || input.value.trim() === t.name) return renderTeams();
          busy(save, post('/api/console/teams/rename', { id: t.id, name: input.value })).then(function (r) {
            if (done(r, 'Renamed to ' + r.name)) refresh(); else renderTeams();
          }).catch(renderTeams);
        });
        var cancel = btn('Cancel', 'quiet small', renderTeams);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') save.click(); if (e.key === 'Escape') renderTeams(); });
        name.textContent = '';
        var wrap = h('span', 'inline'); wrap.appendChild(input); wrap.appendChild(save); wrap.appendChild(cancel);
        name.appendChild(wrap);
        input.focus(); input.select();
      }
      // delete needs the name typed back, in the row itself
      function confirmDelete() {
        var input = h('input'); input.placeholder = 'Type ' + t.name + ' to confirm';
        var go = btn('Delete', 'danger small', function () {
          busy(go, post('/api/console/teams/delete', { id: t.id, confirm: input.value })).then(function (r) {
            if (done(r, 'Deleted ' + t.name)) refresh();
          }).catch(function () {});
        });
        var cancel = btn('Cancel', 'quiet small', renderTeams);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); if (e.key === 'Escape') renderTeams(); });
        act.textContent = '';
        var wrap = h('span', 'inline'); wrap.appendChild(input); wrap.appendChild(go); wrap.appendChild(cancel);
        act.appendChild(wrap);
        input.focus();
      }
      return tr;
    });
    fill(el('team-rows'), rows);
  }
  el('team-add').addEventListener('click', function () {
    busy(el('team-add'), post('/api/console/teams/add', { name: el('team-name').value })).then(function (r) {
      if (done(r, 'Added ' + r.name)) { el('team-name').value = ''; refresh(); }
    }).catch(function () {});
  });
  el('team-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') el('team-add').click(); });

  // ---- team groups (on the Teams tab) ----
  function renderTeamGroups() {
    var box = el('team-groups');
    if (!box) return;
    box.textContent = '';
    var shownTeams = state.teams.filter(teamShown).slice().sort(function (x, y) {
      return x.name.localeCompare(y.name, undefined, { sensitivity: 'base' });
    });
    (state.audiences || []).forEach(function (a) {
      // one line each until opened: the name, who is in it, what it sees
      var block = h('details', 'tg-row tg-group');
      if (state.openGroups && state.openGroups[a.id]) block.open = true;
      block.addEventListener('toggle', function () {
        state.openGroups = state.openGroups || {};
        state.openGroups[a.id] = block.open;
      });
      var quests = state.groups.filter(function (g) { return (g.audiences || []).indexOf(a.id) !== -1; }).length;
      var members = state.teams.filter(function (t) { return a.team_ids.indexOf(t.id) !== -1; }).map(function (t) { return t.name; });
      var summary = h('summary');
      summary.appendChild(h('strong', null, a.name));
      summary.appendChild(h('span', 'muted', ' · ' + (members.length ? members.join(', ') : 'no teams yet') +
        ' · ' + quests + (quests === 1 ? ' quest' : ' quests')));
      block.appendChild(summary);
      var head = h('div', 'tg-line');
      var name = textInput(a.name, 'Team group name');
      var count = h('span', 'count', a.team_ids.length + (a.team_ids.length === 1 ? ' team' : ' teams'));
      var picks = h('div', 'qg-picks');
      var checks = shownTeams.map(function (t) {
        var l = h('label');
        var c = h('input');
        c.type = 'checkbox';
        c.checked = a.team_ids.indexOf(t.id) !== -1;
        l.appendChild(c);
        l.appendChild(document.createTextNode(t.name));
        picks.appendChild(l);
        return { box: c, id: t.id };
      });
      if (!checks.length) picks.appendChild(h('span', 'muted', 'No teams yet.'));
      var save = btn('Save', 'quiet small', function () {
        // members kept out of sight by the hidden-teams switch stay in
        var seen = {};
        checks.forEach(function (c) { seen[c.id] = true; });
        var ids = checks.filter(function (c) { return c.box.checked; }).map(function (c) { return c.id; })
          .concat(a.team_ids.filter(function (id) { return !seen[id]; }));
        busy(save, post('/api/console/quests/team-groups/save', { id: a.id, name: name.value, team_ids: ids })).then(function (res) {
          if (done(res, 'Saved ' + name.value.trim())) dash.loadQuestGroups();
        }).catch(function () {});
      });
      name.addEventListener('keydown', function (e) { if (e.key === 'Enter') save.click(); });
      // every team in the group hidden at once, the way the Teams tab
      // hides one: a group of test teams, say
      var inGroup = state.teams.filter(function (t) { return a.team_ids.indexOf(t.id) !== -1; });
      var allHidden = inGroup.length && inGroup.every(function (t) { return t.hidden; });
      var vis = btn(allHidden ? 'Show these teams' : 'Hide these teams', 'quiet small', function () {
        busy(vis, post('/api/console/teams/hide', { ids: a.team_ids, hidden: !allHidden })).then(function (res) {
          if (done(res, function () { return (res.hidden ? 'Hid ' : 'Showed ') + res.count + (res.count === 1 ? ' team' : ' teams'); })) refresh();
        }).catch(function () {});
      });
      vis.disabled = !inGroup.length;
      head.appendChild(name); head.appendChild(count); head.appendChild(save); head.appendChild(vis);
      head.appendChild(armed('Delete', quests ? 'Delete, and take ' + quests + (quests === 1 ? ' quest' : ' quests') + ' from its teams' : 'Delete ' + a.name, function (go) {
        busy(go, post('/api/console/quests/team-groups/delete', { id: a.id })).then(function (res) {
          if (done(res, 'Deleted ' + a.name)) dash.loadQuestGroups();
        }).catch(function () {});
      }));
      block.appendChild(head);
      block.appendChild(picks);
      box.appendChild(block);
    });
  }
  el('team-group-add').addEventListener('click', function () {
    var input = el('team-group-name');
    busy(el('team-group-add'), post('/api/console/quests/team-groups/save', { name: input.value, team_ids: [] })).then(function (res) {
      if (done(res, 'Added ' + input.value.trim())) { input.value = ''; dash.loadQuestGroups(); }
    }).catch(function () {});
  });
  el('team-group-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') el('team-group-add').click(); });

  // ---- submit codes ----
  el('codes-generate').addEventListener('click', function () {
    busy(el('codes-generate'), post('/api/console/codes/generate')).then(function (r) {
      done(r, r.minted ? 'Minted ' + r.minted + ' new codes' : 'Every team already has a code');
    }).catch(function () {});
  });
  // hidden teams are hidden here too, on the same switch as the teams
  // table — the codes come back keyed by team name, so that is what
  // they are matched on. Kept in state so flipping the switch while
  // the table is open redraws it instead of leaving a stale list.
  state.codes = null;
  function renderCodes() {
    if (!state.codes) return;
    var hiddenNames = hiddenTeamNames();
    var codes = state.codes.filter(function (c) { return !hiddenNames[String(c.name || '').toLowerCase()]; });
    fill(el('codes-rows'), codes.map(function (c) {
      return row([h('td', null, c.name), h('td', c.code ? null : 'muted', c.code || 'no code yet')]);
    }));
    el('codes-table').classList.remove('hidden');
  }
  el('codes-show').addEventListener('click', function () {
    api('/api/console/codes').then(function (d) {
      if (!d.ok) return;
      state.codes = d.codes;
      renderCodes();
    }).catch(function () {});
  });
})(window.dash);
