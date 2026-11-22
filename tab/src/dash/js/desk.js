// The Desk tab: one quest at a time, recording a result, the challenge's
// standings and award, the question's answers, and every team's lines on
// the quest.
(function (dash) {
  // core.js
  var api = dash.api, armed = dash.armed, btn = dash.btn, busy = dash.busy, can = dash.can, chip = dash.chip,
    done = dash.done, el = dash.el, fmtTime = dash.fmtTime, fromLocalInput = dash.fromLocalInput, h = dash.h,
    LEDGER_VOIDED = dash.LEDGER_VOIDED, placeText = dash.placeText, post = dash.post,
    postForm = dash.postForm, row = dash.row, shake = dash.shake, state = dash.state,
    teamShown = dash.teamShown, timeBox = dash.timeBox, toast = dash.toast, toLocalInput = dash.toLocalInput;
  // uploads.js
  var appendProof = dash.appendProof, jpegPicks = dash.jpegPicks, PT_ACCEPT = dash.PT_ACCEPT,
    PT_KIND = dash.PT_KIND, PT_KINDS = dash.PT_KINDS, renameRow = dash.renameRow, sendName = dash.sendName;
  // preview.js
  var reviewMedia = dash.reviewMedia;
  // parts.js
  var answerFrom = dash.answerFrom, answerInput = dash.answerInput, countAt = dash.countAt,
    partInput = dash.partInput, partWords = dash.partWords, withCount = dash.withCount,
    worthWords = dash.worthWords;
  // tabs.js
  var activeTab = dash.activeTab, openTab = dash.openTab, refreshTeamsOnly = dash.refreshTeamsOnly,
    rememberTab = dash.rememberTab;

  dash.canRecord = canRecord;
  dash.loadDesk = loadDesk;
  dash.openDesk = openDesk;

  // ---- a quest's desk ----
  // One quest at a time: recording a result for a team (a submission
  // that is already accepted, the form a team sends proof with, from this
  // side, the photos optional), the challenge's standings and its award,
  // the question's answers and its settlement, and every team's lines on
  // the quest the way a team's ledger shows them. An account limited to
  // one quest has nothing to pick and opens on it.
  var DESK_QUEST = 'scs2-dashboard-desk-quest';
  var pts = { form: null, files: [], names: [], answer: null, codeBoxes: [], drawn: '' };
  function deskQuest() { return el('desk-quest').value; }
  function canRecord() { return can('points') || can('scores'); }
  function loadDesk() {
    api('/api/console/points/form').then(function (d) {
      if (!d || !d.ok) return;
      pts.form = d;
      drawPointsTeams();
      drawDeskQuests();
    }).catch(function () {});
  }
  // the desk on one quest, from a quest's editor or a ledger's heading
  function openDesk(key) {
    try { localStorage.setItem(DESK_QUEST, key || ''); } catch (e) {}
    el('desk-quest').value = key;
    if (activeTab().dataset.tab === 'desk') loadDesk();
    else if (openTab('desk')) rememberTab('desk');
  }
  function ptQuest() {
    var key = deskQuest();
    return pts.form ? pts.form.quests.filter(function (q) { return q.key === key; })[0] || null : null;
  }
  function drawPointsTeams() {
    var sel = el('pt-team');
    var keep = sel.value;
    sel.textContent = '';
    var none = h('option', null, 'Pick a team'); none.value = ''; sel.appendChild(none);
    pts.form.teams.filter(teamShown).forEach(function (t) {
      var o = h('option', null, t.name + (t.hidden ? ' (hidden)' : ''));
      o.value = t.id;
      sel.appendChild(o);
    });
    sel.value = keep;
  }
  function drawDeskQuests() {
    var sel = el('desk-quest');
    var keep = sel.value;
    if (!keep) { try { keep = localStorage.getItem(DESK_QUEST) || ''; } catch (e) {} }
    sel.textContent = '';
    var quests = pts.form.quests;
    if (quests.length !== 1) { var none = h('option', null, 'Pick a quest'); none.value = ''; sel.appendChild(none); }
    quests.forEach(function (q) {
      var o = h('option', null, q.key + ' · ' + q.name + (q.hidden ? ' (hidden)' : ''));
      o.value = q.key;
      sel.appendChild(o);
    });
    if (quests.some(function (q) { return q.key === keep; })) sel.value = keep;
    drawDesk();
  }
  el('desk-quest').addEventListener('change', function () {
    try { localStorage.setItem(DESK_QUEST, deskQuest()); } catch (e) {}
    drawDesk();
  });
  // everything under the picker, for the quest picked. The form keeps
  // what is filled in across a reload of the same quest, as it keeps the
  // team, the note and the files; a quest whose parts changed since is
  // drawn again.
  function drawDesk() {
    var key = deskQuest();
    el('desk-empty').classList.toggle('hidden', !!key);
    el('desk-record').classList.toggle('hidden', !key || !canRecord());
    if (key && canRecord() && pts.drawn !== formFor(ptQuest())) drawPointsQuest();
    loadDeskLines();
    var q = ptQuest();
    loadStandings(key && q && q.tally ? key : '');
    loadDeskQuestion(key);
  }
  // the quest's parts to credit, the first ticked, each with the box its
  // type takes, and its answer box
  function formFor(q) { return q ? JSON.stringify(q) : ''; }
  function drawPointsQuest() {
    var q = ptQuest();
    pts.drawn = formFor(q);
    var box = el('pt-codes');
    box.textContent = '';
    pts.codeBoxes = [];
    if (q) {
      q.codes.forEach(function (c, i) {
        var lab = h('label');
        var tick = h('input');
        tick.type = 'checkbox';
        tick.checked = i === 0;
        tick.disabled = q.codes.length === 1;
        tick.addEventListener('change', ptWorth);
        lab.appendChild(tick);
        lab.appendChild(chip(c.code));
        var words = partWords(c);
        lab.appendChild(document.createTextNode(' ' + (c.label || q.name) + (words ? ' (' + words + ')' : '')));
        var input = partInput(c, null, ptWorth, null);
        var one = h('span', 'review-code');
        one.appendChild(lab);
        if (input.node) one.appendChild(input.node);
        var able = function () { input.enable(tick.checked); };
        able();
        tick.addEventListener('change', able);
        box.appendChild(one);
        pts.codeBoxes.push({ code: c.code, scoring: c.scoring || '', input: tick, part: input });
      });
    }
    drawPointsAnswer(q);
    drawPointsFileField();
    ptWorth();
  }
  // What the quest takes (points/form's files, the quest's rules): which
  // kinds of file and how many. None is ever required here. A form from
  // a worker without rules says nothing, and the worker decides.
  function ptFileRules() {
    var q = ptQuest();
    return q && q.files && Array.isArray(q.files.kinds) ? q.files : null;
  }
  function ptKindsText(f) {
    var list = (f ? f.kinds : ['photo', 'video']).map(function (k) { return (f && f.max === 1 ? PT_KIND : PT_KINDS)[k]; });
    var last = list.pop();
    return list.length ? list.join(', ') + ' or ' + last : last;
  }
  function drawPointsFileField() {
    var f = ptFileRules();
    var takes = !f || (f.kinds.length > 0 && f.max > 0);
    el('pt-files').accept = (f ? f.kinds : ['photo', 'video']).map(function (k) { return PT_ACCEPT[k]; }).join(',');
    el('pt-files').multiple = !f || f.max > 1;
    el('pt-files-btn').parentNode.classList.toggle('hidden', !takes);
    if (!takes) {
      pts.files = []; pts.names = [];
    } else if (f && pts.files.length > f.max) {
      pts.files = pts.files.slice(0, f.max);
      pts.names = pts.names.slice(0, f.max);
    }
    drawPointsFiles();
  }
  function ptCodes() {
    return pts.codeBoxes.filter(function (b) { return b.input.checked; });
  }
  function ptWorth() {
    var sum = 0;
    var full = 0;
    ptCodes().forEach(function (b) {
      var w = b.part.worth();
      sum += w.given;
      full += w.full;
    });
    var worth = Math.round(sum * 100) / 100;
    full = Math.round(full * 100) / 100;
    var ticked = ptCodes();
    var counting = ticked.length && ticked.every(function (b) { return b.scoring === 'counted'; });
    el('pt-worth').textContent = !ptQuest() ? '' : counting ? 'Counts towards the challenge' : worthWords(worth, full);
  }
  // What the quest asks a team for, asked of the organiser instead, one
  // box per question. None of it is required here; ticking codes is
  // the codes above.
  function questionsOf(q) {
    if (q.questions && q.questions.length) return q.questions;
    return q.submit && q.submit !== 'none' ? [{ kind: q.submit, prompt: q.prompt, options: q.options }] : [];
  }
  function drawPointsAnswer(q) {
    var box = el('pt-answer');
    box.textContent = '';
    pts.answer = null;
    if (!q) return;
    var list = questionsOf(q);
    var reads = list.map(function (question) { return question.kind === 'codes' ? null : pointsQuestion(box, question); });
    // a challenge counting numbers with no number question of its own
    // takes the number here, as Review does
    var counted = (q.tally === 'sum' || q.tally === 'highest') && countAt(list) === -1
      ? pointsQuestion(box, { kind: 'count', prompt: 'Counted' }) : null;
    pts.answer = function (codes) {
      var answer = answerFrom(list, list.map(function (question, i) {
        if (question.kind === 'codes') return codes.length ? codes : null;
        return reads[i]();
      }));
      return counted ? withCount(answer, list, counted()) : answer;
    };
  }
  function pointsQuestion(box, q) { return answerInput(box, q, pts.form.places, null); }

  function drawPointsFiles() {
    var list = el('pt-files-list');
    list.textContent = '';
    pts.files.forEach(function (f, i) {
      list.appendChild(renameRow(f, pts.names, i, function () {
        pts.files.splice(i, 1);
        pts.names.splice(i, 1);
        drawPointsFiles();
      }));
    });
    el('pt-files-btn').textContent = pts.files.length ? 'Add more' : 'Add ' + ptKindsText(ptFileRules());
  }
  el('pt-files-btn').addEventListener('click', function () { el('pt-files').click(); });
  el('pt-files').addEventListener('change', function () {
    var picked = Array.prototype.slice.call(el('pt-files').files);
    el('pt-files').value = '';
    jpegPicks(picked).then(function (ready) {
      var f = ptFileRules();
      var all = pts.files.concat(ready);
      if (f && all.length > f.max) toast('At most ' + f.max + (f.max === 1 ? ' file' : ' files') + ' for this quest.', true);
      pts.files = f ? all.slice(0, f.max) : all;
      pts.names = pts.names.slice(0, pts.files.length);
      drawPointsFiles();
    });
  });

  el('pt-add').addEventListener('click', function () {
    var q = ptQuest();
    var teamId = el('pt-team').value;
    if (!teamId) { toast('Pick a team.', true); shake(el('pt-team')); return; }
    if (!q) { toast('Pick a quest.', true); shake(el('desk-quest')); return; }
    var codes = ptCodes().map(function (b) { return b.code; });
    if (!codes.length) { toast('Tick at least one code.', true); return; }
    var form = new FormData();
    form.append('team_id', teamId);
    form.append('quest', q.codes[0].code);
    form.append('codes', JSON.stringify(codes));
    form.append('amount', '1');
    var sent = { counts: {}, awarded: {}, numbers: {} };
    ptCodes().forEach(function (b) { b.part.fill(sent); });
    ['counts', 'awarded', 'numbers'].forEach(function (k) { if (Object.keys(sent[k]).length) form.append(k, JSON.stringify(sent[k])); });
    form.append('note', el('pt-note').value);
    var answer = pts.answer ? pts.answer(codes) : null;
    if (answer) form.append('answer', JSON.stringify(answer));
    var files = pts.files.slice();
    var names = files.map(function (f, i) { return sendName(f, pts.names[i]); });
    busy(el('pt-add'), appendProof(form, files, names, function (share) {
      el('pt-worth').textContent = 'Sending ' + Math.round(share * 100) + '%';
    }).then(function () {
      return postForm('/api/console/points/add', form);
    })).then(function (r) {
      ptWorth();
      if (!done(r, function () {
        var part = r.full != null && r.gained !== r.full ? ' of ' + Math.abs(r.full) : '';
        if (r.gained < 0) return 'Took ' + (-r.gained) + part + (r.gained === -1 && !part ? ' point' : ' points') + ' off ' + r.team + '. Their total is ' + r.total + '.';
        return 'Added ' + r.gained + part + (r.gained === 1 && !part ? ' point' : ' points') + ' to ' + r.team + '. Their total is ' + r.total + '.';
      })) return;
      // the team goes back to blank, so the next press cannot land on the
      // same team by accident; the quest stays, for the next team at it
      el('pt-team').value = '';
      el('pt-note').value = '';
      pts.files = []; pts.names = [];
      drawPointsFiles();
      drawPointsQuest();
      deskChanged();
    }).catch(function (err) {
      ptWorth();
      if (err && err.error) toast(err.error, true);
    });
  });

  // ---- a challenge's standings, over the list while its quest is picked ----
  // Each team's count, its place and what is waiting on review; a row
  // opens that team's part in it, and the places are awarded from the
  // foot of the card.
  function tallyKindText(kind) {
    var hit = dash.TALLY_KINDS.filter(function (k) { return k[0] === kind; })[0];
    return hit ? hit[1] : '';
  }
  function loadStandings(quest) {
    var box = el('desk-standings');
    if (!quest) { box.textContent = ''; box.classList.add('hidden'); return; }
    api('/api/console/tally?quest=' + encodeURIComponent(quest)).then(function (d) {
      if (deskQuest() !== quest) return;
      if (!d || !d.ok || !d.kind) { box.textContent = ''; box.classList.add('hidden'); return; }
      drawStandings(box, d, quest);
    }).catch(function () {});
  }

  // every team's lines on the desk's quest, best first, under what waits
  // on review for it and what gave nothing
  function loadDeskLines() {
    var key = deskQuest();
    var box = el('desk-teams');
    if (!key) { state.desk = null; box.textContent = ''; box.classList.add('hidden'); return; }
    api('/api/console/desk?quest=' + encodeURIComponent(key)).then(function (d) {
      if (deskQuest() !== key) return;
      box.classList.remove('hidden');
      if (!d || !d.ok) { box.textContent = ''; box.appendChild(h('p', 'review-warn', (d && d.error) || 'That quest could not be read.')); return; }
      state.desk = d;
      drawDeskLines(d);
    }).catch(function () {});
  }
  function deskChanged() { loadDeskLines(); refreshTeamsOnly(); var q = ptQuest(); if (q && q.tally) loadStandings(q.key); }
  function drawDeskLines(d) {
    var box = el('desk-teams');
    var showVoided = el('desk-voided').checked;
    box.textContent = '';
    var shown = function (t) { return !(state.hideHidden && (t.hidden || t.team_hidden)); };
    var teams = d.teams.filter(shown).filter(function (t) {
      return showVoided || t.lines.some(function (l) { return !l.voided; });
    });
    var head = h('div', 'card-head');
    head.appendChild(h('h2', 'card-title', 'Teams'));
    head.appendChild(h('span', 'muted', teams.length + (teams.length === 1 ? ' team has points here' : ' teams have points here')));
    box.appendChild(head);
    var waiting = d.waiting.filter(shown);
    if (waiting.length) {
      box.appendChild(dash.subLinks('Waiting on review', waiting, function (w) { return w.team_name + ', sent ' + fmtTime(w.submitted_at); }));
    }
    var closed = d.closed.filter(shown);
    if (closed.length) box.appendChild(dash.subLinks('Rejected or deleted', closed, function (w) { return w.team_name + ', ' + dash.closedText(w); }));
    if (!teams.length) { box.appendChild(h('p', 'muted', 'No team has points on it yet.')); return; }
    var list = h('div', 'lg-list desk-list');
    teams.forEach(function (t) {
      var title = h('span', 'lg-quest-title');
      // a team's name opens its ledger
      title.appendChild(btn(t.name, 'tally-team lg-quest-link', function () { dash.openLedger(t.id); }));
      if (t.hidden) title.appendChild(h('span', 'muted', 'hidden'));
      list.appendChild(dash.lineBlock(title, t.worth, t.lines, showVoided, { id: t.id, name: t.name }, deskChanged, d.media));
    });
    box.appendChild(list);
  }
  try { el('desk-voided').checked = localStorage.getItem(LEDGER_VOIDED) === '1'; } catch (e) {}
  // one setting with a box on the Desk and the Ledger: each sets the other
  el('desk-voided').addEventListener('change', function () {
    try { localStorage.setItem(LEDGER_VOIDED, el('desk-voided').checked ? '1' : '0'); } catch (e) {}
    if (el('ledger-voided')) el('ledger-voided').checked = el('desk-voided').checked;
    if (state.desk) drawDeskLines(state.desk);
  });
  // the question the quest asks: whether it is taking answers and until
  // when, its answers and, for a wager, the settlement
  function loadDeskQuestion(key) {
    var box = el('desk-question');
    var q = ptQuest();
    if (!key || !q || !q.ask) { box.textContent = ''; box.classList.add('hidden'); return; }
    post('/api/console/quests/group/ask/responses', { key: key }).then(function (d) {
      if (deskQuest() !== key) return;
      if (!d || !d.ok || !d.kind) { box.textContent = ''; box.classList.add('hidden'); return; }
      box.textContent = '';
      box.classList.remove('hidden');
      var head = h('div', 'card-head');
      head.appendChild(h('h2', 'card-title', 'The question'));
      head.appendChild(h('span', 'muted', d.prompt || ''));
      box.appendChild(head);
      box.appendChild(askRunBar(key, d));
      var results = h('div', 'qg-ask-responses');
      box.appendChild(results);
      dash.drawAskResults(results, key, d, { reload: function () { loadDeskQuestion(key); deskChanged(); } });
    }).catch(function () {});
  }
  // Taking answers is an O/I rocker that saves at once; the time it
  // closes at is saved with it, or on its own with Set.
  function askRunBar(key, d) {
    var bar = h('div', 'qg-actions ask-run');
    if (!(can('quests') || can('points') || can('scores'))) { bar.appendChild(h('span', 'muted', dash.askStateText(d.open, d.open_until))); return bar; }
    // beside the switch only the time says anything more
    function deadline(open, until) {
      if (!until) return '';
      if (open) return 'Until ' + fmtTime(until);
      return dash.stampMs(until) <= Date.now() ? 'Closed at ' + fmtTime(until) : '';
    }
    var stateLine = h('span', 'muted ask-state', deadline(d.open, d.open_until));
    var open = h('input');
    open.type = 'checkbox';
    open.checked = !!d.open;
    var openLabel = h('label', 'rocker');
    var switchBox = h('span', 'rocker-switch');
    switchBox.setAttribute('aria-hidden', 'true');
    switchBox.appendChild(h('span', 'rocker-o', 'O'));
    switchBox.appendChild(h('span', 'rocker-i', 'I'));
    openLabel.appendChild(open);
    openLabel.appendChild(switchBox);
    openLabel.appendChild(h('span', null, 'Taking answers'));
    // a deadline in this device's time; the worker holds UTC
    var until = h('input');
    timeBox(until);
    until.value = toLocalInput(d.open_until);
    until.setAttribute('aria-label', 'Closes at');
    // one request at a time: the switch and Set are held still until it answers
    function send(button) {
      var asked = post('/api/console/quests/group/ask/open', { key: key, open: open.checked, open_until: fromLocalInput(until.value) });
      open.disabled = true;
      set.disabled = true;
      (button ? busy(button, asked) : asked).then(function (r) {
        open.disabled = false;
        set.disabled = false;
        if (!done(r, function () { return key + ': ' + dash.askStateText(r.ask.open, r.ask.open_until).toLowerCase(); })) {
          open.checked = !!d.open;
          return;
        }
        d.open = r.ask.open; d.open_until = r.ask.open_until;
        open.checked = !!r.ask.open;
        stateLine.textContent = deadline(r.ask.open, r.ask.open_until);
      }).catch(function () { open.disabled = false; set.disabled = false; open.checked = !!d.open; });
    }
    open.addEventListener('change', function () { send(null); });
    var set = btn('Set', 'quiet small', function () { send(set); });
    bar.appendChild(openLabel);
    bar.appendChild(h('span', 'muted', 'Closes at'));
    bar.appendChild(until);
    bar.appendChild(set);
    bar.appendChild(stateLine);
    return bar;
  }
  function drawStandings(box, d, quest) {
    box.textContent = '';
    box.classList.remove('hidden');
    var head = h('div', 'card-head');
    head.appendChild(h('h2', 'card-title', 'Standings'));
    head.appendChild(h('span', 'muted', tallyKindText(d.kind)));
    box.appendChild(head);
    var shown = d.teams.filter(function (t) { return !(state.hideHidden && t.hidden); });
    if (!shown.length) {
      box.appendChild(h('p', 'muted', 'Nothing sent for it yet.'));
    } else {
      var table = h('table', 'tally-table');
      var thead = h('thead');
      var banded = !!(d.bands && d.bands.length);
      thead.appendChild(row([h('th', 'num', 'Place'), h('th', null, 'Team'), h('th', 'num', d.kind === 'highest' ? 'Best' : d.kind === 'sum' ? 'Total' : 'Counted'), h('th', 'num', 'Waiting')]
        .concat(banded ? [h('th', 'num', 'Band')] : [])));
      table.appendChild(thead);
      var tbody = h('tbody');
      shown.forEach(function (t) {
        var open = btn(t.name, 'tally-team', function () { toggleTallyTeam(t, tr, quest); });
        open.setAttribute('aria-expanded', 'false');
        var name = h('td');
        name.appendChild(open);
        if (t.hidden) name.appendChild(h('span', 'muted', ' · hidden'));
        var tr = row([h('td', 'num', t.place ? String(t.place) : ''), name,
          h('td', 'num', String(t.count)), h('td', 'num muted', t.waiting ? String(t.waiting) : '')]
          .concat(banded ? [h('td', 'num', t.band ? String(t.band) : '')] : []));
        if (t.hidden) tr.classList.add('is-hidden-team');
        tr.tallyButton = open;
        tbody.appendChild(tr);
        if (state.tallyOpen === quest + ' ' + t.id) toggleTallyTeam(t, tr, quest);
      });
      table.appendChild(tbody);
      var scroll = h('div', 'table-scroll');
      scroll.appendChild(table);
      box.appendChild(scroll);
    }
    var foot = tallyAwardBar(d, quest);
    if (foot) box.appendChild(foot);
  }
  // One team's part in the challenge, in a row under its own: what was
  // counted and when each came in, then every photo and video it had
  // accepted for the quest in one grid.
  function toggleTallyTeam(t, tr, quest) {
    var next = tr.nextSibling;
    if (next && next.classList.contains('tally-detail')) {
      next.remove();
      tr.tallyButton.setAttribute('aria-expanded', 'false');
      if (state.tallyOpen === quest + ' ' + t.id) state.tallyOpen = '';
      return;
    }
    state.tallyOpen = quest + ' ' + t.id;
    tr.tallyButton.setAttribute('aria-expanded', 'true');
    var cell = h('td');
    cell.colSpan = tr.children.length || 4;
    var detail = row([cell]);
    detail.className = 'tally-detail';
    tr.parentNode.insertBefore(detail, tr.nextSibling);
    api('/api/console/tally/team?quest=' + encodeURIComponent(quest) + '&team_id=' + t.id).then(function (d) {
      if (!d || !d.ok) { cell.appendChild(h('p', 'muted', (d && d.error) || 'That did not load.')); return; }
      fillTallyTeam(cell, d);
    }).catch(function () {});
  }
  function fillTallyTeam(cell, d) {
    var view = h('div', 'tally-view');
    var list = h('ul', 'tally-items');
    if (d.kind === 'picks') {
      d.items.forEach(function (item) {
        var li = h('li');
        li.appendChild(h('strong', null, item.name));
        li.appendChild(h('span', 'muted', fmtTime(item.at)));
        list.appendChild(li);
      });
    } else if (d.kind === 'sum' || d.kind === 'highest') {
      d.accepted.forEach(function (s) {
        if (s.amount == null) return;
        var li = h('li');
        li.appendChild(h('strong', null, String(s.amount)));
        // under highest only the best counts, and it says so
        li.appendChild(h('span', 'muted', fmtTime(s.submitted_at) + (d.kind === 'highest' && s.id === d.best ? ' · best' : '')));
        list.appendChild(li);
      });
    }
    if (list.childNodes.length) {
      view.appendChild(h('h3', 'sub-title', d.kind === 'highest' ? 'Numbers sent (best ' + d.count + ')'
        : d.kind === 'sum' ? 'Numbers sent (total ' + d.count + ')' : 'Counted (' + d.count + ')'));
      view.appendChild(list);
    }
    if (d.pending.length) {
      var waiting = 'Waiting on review: ' + d.pending.length + (d.pending.length === 1 ? ' submission' : ' submissions');
      if (d.waiting_items.length) waiting += ', which would add ' + d.waiting_items.map(function (i) { return i.name; }).join(', ');
      else if (d.kind === 'highest' && d.waiting) waiting += ', the highest of them ' + d.waiting;
      view.appendChild(h('p', 'note', waiting + '.'));
    }
    var files = [];
    d.accepted.forEach(function (s) { files = files.concat(s.media || []); });
    view.appendChild(h('h3', 'sub-title', 'Photos and videos (' + files.length + ')'));
    if (files.length) view.appendChild(reviewMedia(files));
    cell.appendChild(view);
  }
  // Awarding the places: the points each placed team gets are named
  // before the second press, and once done the card says when and who.
  function tallyAwardBar(d, quest) {
    if (!can('scores') && !d.settled) return null;
    var bar = h('div', 'set-foot tally-award');
    var banded = !!(d.bands && d.bands.length);
    var placed = d.teams.filter(function (t) { return t.award + (t.band || 0) > 0; });
    var host = h('span', 'inline');
    var arm = btn(banded ? 'Award bands and places' : 'Award points by place', 'quiet', function () {
      var plan = placed.map(function (t) { return (t.place ? placeText(t.place) + ' ' : '') + t.name + ', ' + (t.award + (t.band || 0)) + ' points'; }).join('; ');
      var go = btn('Award', null, function () {
        busy(go, post('/api/console/tally/award', { quest: quest })).then(function (r) {
          if (!done(r, function () { return 'Points awarded to ' + r.awarded.length + (r.awarded.length === 1 ? ' team' : ' teams'); })) return;
          loadStandings(quest);
          refreshTeamsOnly();
        }).catch(function () {});
      });
      var cancel = btn('Cancel', 'quiet', function () { host.textContent = ''; host.appendChild(arm); });
      host.textContent = '';
      host.appendChild(h('span', null, plan + '.'));
      host.appendChild(go);
      host.appendChild(cancel);
    });
    host.appendChild(arm);
    bar.appendChild(host);
    var line = '';
    if (d.settled) {
      host.textContent = '';
      line = 'Awarded' + (d.settled.at ? ' ' + fmtTime(d.settled.at) : '') + (d.settled.by ? ' by ' + d.settled.by : '') +
        (d.settled.undoable ? '.' : '. A correction goes on the team\'s ledger.');
      // undoing the award takes each team's points off, and the places
      // can be awarded again
      if (d.settled.undoable) {
        host.appendChild(armed('Undo the award', 'Take the award off every team', function (go) {
          busy(go, post('/api/console/tally/unaward', { quest: quest })).then(function (r) {
            if (!done(r, function () { return 'Award undone for ' + r.teams + (r.teams === 1 ? ' team' : ' teams'); })) return;
            loadStandings(quest);
            refreshTeamsOnly();
          }).catch(function () {});
        }));
      }
    } else if (!d.awards.some(function (n) { return n > 0; }) && !banded) {
      arm.disabled = true;
      line = 'No points by place are set. They are in the quest editor.';
    } else if (!placed.length) {
      arm.disabled = true;
      line = 'No team has anything counted yet.';
    }
    if (!can('scores')) host.classList.add('hidden');
    if (line) bar.appendChild(h('span', 'muted', line));
    return bar;
  }
})(window.dash);
