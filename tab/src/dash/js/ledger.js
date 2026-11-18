// The Ledger tab: every line on one team's score, quest by quest, and
// what each line can do.
(function (dash) {
  // core.js
  var amountText = dash.amountText, api = dash.api, armed = dash.armed, btn = dash.btn, busy = dash.busy,
    byName = dash.byName, can = dash.can, canTab = dash.canTab, done = dash.done, el = dash.el,
    fmtTime = dash.fmtTime, fromLocalInput = dash.fromLocalInput, h = dash.h,
    LEDGER_VOIDED = dash.LEDGER_VOIDED, placeText = dash.placeText, post = dash.post, shake = dash.shake,
    state = dash.state, teamShown = dash.teamShown, timeBox = dash.timeBox, toast = dash.toast,
    toLocalInput = dash.toLocalInput;
  // preview.js
  var reviewMedia = dash.reviewMedia;
  // share.js
  var copyReceipt = dash.copyReceipt, RECEIPT_DETAIL = dash.RECEIPT_DETAIL,
    receiptDetail = dash.receiptDetail, shareImageLib = dash.shareImageLib;
  // tabs.js
  var activeTab = dash.activeTab, openTab = dash.openTab, refreshTeamsOnly = dash.refreshTeamsOnly,
    rememberTab = dash.rememberTab;

  dash.openLedger = openLedger;
  dash.ledgerTeams = ledgerTeams;
  dash.loadLedger = loadLedger;
  dash.lineBlock = lineBlock;
  dash.subLinks = subLinks;
  dash.closedText = closedText;

  // ---- a team's ledger ----
  // Every line on one team's score, quest by quest: what made it, who,
  // when and what it was worth. Undo on a line undoes what made it: a
  // team's submission goes back to the queue, an organiser's entry is
  // taken back, and an award's or a balance's line comes off this team
  // alone. Adjust puts points on, or takes them off, for a reason the
  // team reads. Undone lines stay, and show on request.
  var LEDGER_TEAM = 'scs2-dashboard-ledger-team';
  function ledgerTeamId() {
    if (state.ledgerTeam == null) {
      try { state.ledgerTeam = localStorage.getItem(LEDGER_TEAM) || ''; } catch (e) { state.ledgerTeam = ''; }
    }
    return state.ledgerTeam;
  }
  function openLedger(teamId) {
    state.ledgerTeam = String(teamId || '');
    try { localStorage.setItem(LEDGER_TEAM, state.ledgerTeam); } catch (e) {}
    if (activeTab().dataset.tab === 'ledger') loadLedger();
    else if (openTab('ledger')) rememberTab('ledger');
  }
  function ledgerTeams() {
    var sel = el('ledger-team');
    if (!sel) return;
    var want = ledgerTeamId();
    sel.textContent = '';
    var none = h('option', null, 'Pick a team');
    none.value = '';
    sel.appendChild(none);
    state.teams.filter(teamShown).slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (t) {
      var o = h('option', null, t.name + (t.hidden ? ' (hidden)' : ''));
      o.value = String(t.id);
      sel.appendChild(o);
    });
    sel.value = want;
    if (sel.value !== want) sel.value = '';
  }
  if (el('ledger-team')) {
    el('ledger-team').addEventListener('change', function () { openLedger(el('ledger-team').value); });
    try { el('ledger-voided').checked = localStorage.getItem(LEDGER_VOIDED) === '1'; } catch (e) {}
    el('ledger-voided').addEventListener('change', function () {
      try { localStorage.setItem(LEDGER_VOIDED, el('ledger-voided').checked ? '1' : '0'); } catch (e) {}
      if (el('desk-voided')) el('desk-voided').checked = el('ledger-voided').checked;
      // the lines alone: an Adjust half typed stays
      if (state.ledger) drawLedgerLines(state.ledger);
    });
  }
  function loadLedger() {
    ledgerTeams();
    var team = ledgerTeamId();
    var box = el('ledger-view');
    if (!team) { state.ledger = null; box.textContent = ''; box.appendChild(h('p', 'muted', 'Pick a team to see every line on its score.')); return; }
    api('/api/console/team/receipt?team_id=' + encodeURIComponent(team)).then(function (d) {
      if (ledgerTeamId() !== team) return;
      if (!d.ok) { box.textContent = ''; box.appendChild(h('p', 'review-warn', d.error || 'That team could not be read.')); return; }
      state.ledger = d;
      drawLedger(d);
    }).catch(function () {});
  }
  function ledgerChanged() { loadLedger(); refreshTeamsOnly(); }
  function signedPoints(n) {
    var v = Math.round(Number(n) * 100) / 100;
    return (v > 0 ? '+' : '') + v;
  }
  function codesText(lines) {
    // a deleted quest's line always says which quest it was
    if (lines.length === 1 && Number(lines[0].units) === 1 && !lines[0].deleted_from) return '';
    return lines.map(function (l) { return l.code + ' ×' + amountText(l.units); }).join(', ');
  }
  // what made a group of lines, in words
  function lineSource(l) {
    var sub = l.sub || {};
    if (l.kind === 'award') return l.label + ', awarded by ' + byName(l.by) + ' ' + fmtTime(l.made_at);
    if (l.kind === 'balance') return l.label;
    if (sub.adjust) return 'Adjusted by ' + byName(l.by) + ' ' + fmtTime(l.at) + ': ' + sub.reason;
    if (l.organiser) return 'Recorded by ' + byName(l.by) + ' ' + fmtTime(l.at);
    return 'Sent ' + fmtTime(sub.sent || l.at) + ', accepted by ' + byName(l.by) + ' ' + fmtTime(sub.decided || l.made_at);
  }
  // A confirmation on a row of its own under the line: a reason box and
  // the button naming the points it moves. A reason the action needs is
  // asked for.
  function confirmRow(acts, o) {
    var form = h('span', 'lg-confirm');
    var why = h('input', 'lg-why');
    why.type = 'text';
    why.maxLength = 200;
    why.placeholder = o.need ? 'Why' : 'Why (optional)';
    why.setAttribute('aria-label', 'Why');
    var go = btn(o.label, 'danger small', function () {
      if (o.need && !why.value.trim()) { why.focus(); shake(why); return; }
      o.run(go, why.value.trim());
    });
    var back = btn('Cancel', 'quiet small', function () { form.remove(); acts.classList.remove('hidden'); });
    why.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); if (e.key === 'Escape') back.click(); });
    form.appendChild(why); form.appendChild(go); form.appendChild(back);
    acts.classList.add('hidden');
    acts.parentNode.appendChild(form);
    why.focus();
  }
  // What a row of lines can do: Open its submission, Undo it, Put back
  // an organiser's entry taken back, or move an organiser's entry's time.
  // team is {id, name}; changed runs after anything moved.
  function lineActions(group, team, changed) {
    var first = group.lines[0];
    var worth = group.worth;
    var acts = h('span', 'lg-acts');
    if (group.voided) {
      // an organiser's entry taken back can be put back
      if (first.kind === 'submission' && first.organiser && first.sub && first.sub.status === 'deleted' && !first.deleted_from &&
          /^Taken back/.test(first.voided.reason) && (can('points') || can('scores') || can('review'))) {
        acts.appendChild(armed('Put back', dash.putBackLabel(worth), function (go) {
          busy(go, post('/api/console/points/redo', { id: first.source_id })).then(function (r) {
            if (done(r, 'Put back.')) changed();
          }).catch(function () {});
        }));
      }
      return acts;
    }
    if (first.kind === 'submission') {
      if (canTab('review')) acts.appendChild(btn('Open', 'quiet small', function () { dash.openSubmission(first.source_id); }));
      // a deleted submission whose points stayed: its lines come off one by one, for a reason
      if (first.sub && first.sub.status === 'deleted' && (can('points') || can('scores'))) {
        acts.appendChild(btn('Undo', 'quiet small', function () {
          confirmRow(acts, { label: dash.undoLabel(worth), need: true, run: function (go, why) {
            voidLines(go, group.lines, why, dash.takenBackText(worth, team.name), changed);
          } });
        }));
        return acts;
      }
      var mayUndo = first.organiser ? (can('points') || can('scores') || can('review')) : can('review');
      if (mayUndo && first.sub && first.sub.status === 'accepted') {
        acts.appendChild(btn('Undo', 'quiet small', function () {
          confirmRow(acts, { label: dash.undoLabel(worth), need: false, run: function (go, why) {
            var url = first.organiser ? '/api/console/points/undo' : '/api/console/submissions/reopen';
            busy(go, post(url, { id: first.source_id, reason: why })).then(function (r) {
              if (done(r, first.organiser ? dash.takenBackText(worth, team.name) : 'It is back in the queue.')) changed();
            }).catch(function () {});
          } });
        }));
      }
      // when an organiser's entry happened, which the recap's hours read
      if (first.organiser && first.sub && first.sub.status === 'accepted' && dash.canRecord()) {
        acts.appendChild(btn('Time', 'quiet small', function () { timeRow(acts, first, changed); }));
      }
    } else if (can('points') || can('scores')) {
      acts.appendChild(btn('Undo', 'quiet small', function () {
        confirmRow(acts, { label: dash.undoLabel(worth), need: true, run: function (go, why) {
          voidLines(go, group.lines, why, dash.takenBackText(worth, team.name), changed);
        } });
      }));
    }
    return acts;
  }
  // Every line of a row undone, one request a line, so a row of several
  // codes comes off whole; the second password is asked for once, and the
  // first refusal stops the rest. Anything undone redraws the ledger.
  function voidLines(go, lines, why, text, changed) {
    var hold = { value: '' };
    var undone = 0;
    busy(go, lines.reduce(function (chain, l) {
      return chain.then(function (r) {
        if (!r || !r.ok) return r;
        return post('/api/console/ledger/void', { id: l.id, reason: why }, hold).then(function (a) {
          if (a && a.ok) undone++;
          return a;
        });
      });
    }, Promise.resolve({ ok: true }))).then(function (r) {
      if (done(r, text) || undone) changed();
    }).catch(function () { if (undone) changed(); });
  }
  // Moving an organiser's entry to when the quest was done, on a row of
  // its own under the line: a time read in this device's zone.
  function timeRow(acts, line, changed) {
    var form = h('span', 'lg-confirm');
    var when = h('input', 'lg-when');
    timeBox(when);
    when.value = toLocalInput(line.sub.sent || line.at);
    when.setAttribute('aria-label', 'When it happened');
    var back = btn('Cancel', 'quiet small', function () { form.remove(); acts.classList.remove('hidden'); });
    var save = btn('Save time', 'primary small', function () {
      var at = fromLocalInput(when.value);
      if (!at) { toast('Give a date and a time.', true); shake(when); return; }
      busy(save, post('/api/console/points/time', { id: line.source_id, at: at })).then(function (r) {
        if (done(r, 'Moved to ' + fmtTime(r.at) + '.')) changed();
      }).catch(function () {});
    });
    form.appendChild(when); form.appendChild(save); form.appendChild(back);
    acts.classList.add('hidden');
    acts.parentNode.appendChild(form);
    when.focus();
  }
  // Lines in groups: one per submission or award and per undoing, a
  // balance on its own.
  function lineGroups(lines, showVoided) {
    var out = [];
    var byKey = {};
    lines.forEach(function (l) {
      if (l.voided && !showVoided) return;
      var key = l.kind === 'balance' || l.source_id == null ? 'line:' + l.id
        : l.kind + ':' + l.source_id + ':' + (l.voided ? l.voided.at + l.voided.reason : 'live');
      var g = byKey[key];
      if (!g) { g = byKey[key] = { lines: [], worth: 0, voided: !!l.voided }; out.push(g); }
      g.lines.push(l);
      g.worth = Math.round((g.worth + Number(l.points)) * 100) / 100;
    });
    return out;
  }
  // a block of lines under its heading: a quest on a team's ledger, a
  // team on a quest's desk; `media` is each submission's files by its id
  function lineBlock(title, worth, lines, showVoided, team, changed, media) {
    var block = h('div', 'lg-quest');
    var qh = h('div', 'lg-quest-head');
    qh.appendChild(title);
    qh.appendChild(h('strong', 'num lg-pts', amountText(worth)));
    block.appendChild(qh);
    var ul = h('ul', 'lg-lines');
    lineGroups(lines, showVoided).forEach(function (g) {
      var li = h('li', g.voided ? 'is-voided' : '');
      var what = h('span', 'lg-what');
      what.appendChild(h('span', null, lineSource(g.lines[0])));
      var codes = codesText(g.lines);
      if (codes) what.appendChild(h('span', 'muted', codes));
      if (g.voided) {
        var v = g.lines[0].voided;
        what.appendChild(h('span', 'muted', 'Undone ' + fmtTime(v.at) + (v.by ? ' by ' + byName(v.by) : '') + (v.reason ? ': ' + v.reason : '')));
      }
      var files = g.lines[0].kind === 'submission' && media ? media[g.lines[0].source_id] : null;
      if (files && files.length) {
        var grid = reviewMedia(files);
        grid.classList.add('lg-media');
        what.appendChild(grid);
      }
      li.appendChild(what);
      li.appendChild(h('span', 'num lg-pts', g.voided ? '(' + amountText(g.worth) + ')' : signedPoints(g.worth)));
      li.appendChild(lineActions(g, team, changed));
      ul.appendChild(li);
    });
    block.appendChild(ul);
    return block;
  }
  // Submissions as one line of links, each opening its card: what waits
  // on review, and what gave nothing.
  function subLinks(label, list, text) {
    var p = h('p', 'lg-waiting');
    p.appendChild(h('span', 'muted', label + ': '));
    list.forEach(function (w, i) {
      if (i) p.appendChild(document.createTextNode(', '));
      var link = btn(text(w), 'tally-team', function () { dash.openSubmission(w.id); });
      link.disabled = !canTab('review');
      p.appendChild(link);
    });
    return p;
  }
  function closedText(w) {
    return (w.status === 'rejected' ? 'rejected' : 'deleted') + (w.reason ? ' (' + w.reason + ')' : '');
  }
  function drawLedger(d) {
    var box = el('ledger-view');
    box.textContent = '';
    var head = h('div', 'card lg-head');
    var top = h('div', 'card-head');
    top.appendChild(h('h2', 'card-title', d.team.name));
    var where = d.team.dnf ? 'did not finish' : d.team.hidden ? 'hidden' : d.place ? placeText(d.place) + ' of ' + d.of : '';
    top.appendChild(h('span', 'muted', amountText(d.total) + ' points' + (where ? ' · ' + where : '')));
    top.appendChild(h('span', 'grow'));
    var detail = h('select');
    detail.setAttribute('aria-label', 'How much the picture shows');
    [['compact', 'Quests only'], ['standard', 'With codes'], ['detailed', 'Detailed']].forEach(function (o) {
      detail.appendChild(new Option(o[1], o[0]));
    });
    detail.value = receiptDetail();
    detail.addEventListener('change', function () {
      try { localStorage.setItem(RECEIPT_DETAIL, detail.value); } catch (e) { /* not kept */ }
    });
    top.appendChild(detail);
    top.appendChild(btn('Copy as image', 'quiet small', function () { copyReceipt(d); }));
    shareImageLib();
    var adjust = null;
    if (can('points') || can('scores')) {
      adjust = adjustForm(d);
      top.appendChild(btn('Adjust', 'quiet small', function () {
        adjust.classList.toggle('hidden');
        if (!adjust.classList.contains('hidden')) adjust.querySelector('input[type=number]').focus();
      }));
    }
    head.appendChild(top);
    if (adjust) head.appendChild(adjust);
    if (d.waiting && d.waiting.length) {
      head.appendChild(subLinks('Waiting on review', d.waiting, function (w) { return w.quest_code + ' ' + w.name + ', sent ' + fmtTime(w.submitted_at); }));
    }
    if (d.closed && d.closed.length) {
      head.appendChild(subLinks('Rejected or deleted', d.closed, function (w) { return w.quest_code + ' ' + w.name + ', ' + closedText(w); }));
    }
    box.appendChild(head);
    drawLedgerLines(d);
  }
  // the team's lines quest by quest, under the head, drawn again on their
  // own when Show undone lines is flipped
  function drawLedgerLines(d) {
    var box = el('ledger-view');
    var showVoided = el('ledger-voided').checked;
    var was = box.querySelector('.lg-list');
    var list = h('div', 'card lg-list');
    var quests = d.quests.filter(function (q) { return showVoided ? q.lines.length : q.lines.some(function (l) { return !l.voided; }); });
    if (!quests.length) list.appendChild(h('p', 'muted', 'No points yet.'));
    var team = { id: d.team.id, name: d.team.name };
    quests.forEach(function (q) {
      var title = h('span', 'lg-quest-title');
      var name = q.key === q.name ? q.key : q.key + ' · ' + q.name;
      // a quest's heading opens its desk
      title.appendChild(canTab('desk') ? btn(name, 'tally-team lg-quest-link', function () { dash.openDesk(q.key); }) : h('strong', null, name));
      if (q.times > 1) title.appendChild(h('span', 'review-warn', 'Given by ' + q.times + ' submissions'));
      list.appendChild(lineBlock(title, q.worth, q.lines, showVoided, team, ledgerChanged, d.media));
    });
    if (was) box.replaceChild(list, was); else box.appendChild(list);
  }
  // Adjust: a quest (or none) to put the points on, the points, and why.
  function adjustForm(d) {
    var form = h('div', 'lg-adjust hidden');
    var quest = h('select');
    quest.setAttribute('aria-label', 'Quest');
    if (!dash.access.quests || !dash.access.quests.length || dash.access.admin) quest.appendChild(new Option('No quest', ''));
    (state.quests || []).filter(function (q) { return !/-o$/.test(q.code) && q.code !== 'ADJ' && Number(q.points); }).forEach(function (q) {
      quest.appendChild(new Option(q.code + (q.label ? ' · ' + q.label : '') + ' (' + q.points + ')', q.code));
    });
    var points = h('input');
    points.type = 'number'; points.step = 'any'; points.placeholder = 'Points, below 0 to take off';
    points.setAttribute('aria-label', 'Points');
    var why = h('input', 'lg-why');
    why.type = 'text'; why.maxLength = 200; why.placeholder = 'Why (the team reads this)';
    why.setAttribute('aria-label', 'Why');
    var go = btn('Adjust', 'primary small', function () {
      var n = Number(points.value);
      if (!points.value.trim() || !n) { points.focus(); shake(points); return; }
      if (!why.value.trim()) { why.focus(); shake(why); return; }
      busy(go, post('/api/console/ledger/adjust', { team_id: d.team.id, code: quest.value, points: n, reason: why.value.trim() })).then(function (r) {
        if (done(r, function () { return (r.points > 0 ? 'Added ' + r.points + ' to ' : 'Took ' + (-r.points) + ' off ') + r.team + '.'; })) ledgerChanged();
      }).catch(function () {});
    });
    function label() {
      var n = Math.round(Number(points.value) * 100) / 100;
      go.textContent = !n ? 'Adjust' : n > 0 ? 'Add ' + n + (n === 1 ? ' point' : ' points') : 'Take ' + (-n) + (n === -1 ? ' point' : ' points') + ' off';
    }
    points.addEventListener('input', label);
    form.appendChild(quest); form.appendChild(points); form.appendChild(why); form.appendChild(go);
    return form;
  }
})(window.dash);
