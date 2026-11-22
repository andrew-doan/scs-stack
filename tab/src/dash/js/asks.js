// Polls and wagers, on the Quests tab: what a quest asks every team on
// the day, its answers and the settlement.
(function (dash) {
  // core.js
  var api = dash.api, armed = dash.armed, btn = dash.btn, busy = dash.busy, canTab = dash.canTab,
    chip = dash.chip, done = dash.done, el = dash.el, field = dash.field, fmtTime = dash.fmtTime, h = dash.h,
    post = dash.post, row = dash.row, shake = dash.shake, state = dash.state, textInput = dash.textInput,
    toast = dash.toast;
  // tabs.js
  var refreshTeamsOnly = dash.refreshTeamsOnly;

  dash.askStateText = askStateText;
  dash.drawAskResults = drawAskResults;

  // ---- polls and wagers: what a quest asks every team on the day ----
  // A list of its own on the Quests tab, which holds the words; taking
  // answers, the answers and the settlement are on the quest's desk.
  var ASK_KINDS = [
    ['choice', 'Buttons'],
    ['text', 'Text answer'],
    ['number', 'Number entry'],
    ['wager', 'Points wager']
  ];
  var ASK_REVEALS = [
    ['', 'Only their own answer'],
    ['tally', 'How many picked each option'],
    ['answers', 'Every team\'s answer']
  ];
  state.asks = null; state.askEditing = null;
  function askKindName(kind) {
    var k = ASK_KINDS.filter(function (x) { return x[0] === kind; })[0];
    return k ? k[1] : kind;
  }
  // whether teams can answer, in one line: the switch and the deadline
  // together, which is how the worker reads it too
  function askStateText(open, until) {
    if (open) return until ? 'Taking answers until ' + fmtTime(until) : 'Taking answers';
    return until && dash.stampMs(until) <= Date.now() ? 'Closed at ' + fmtTime(until) : 'Not taking answers';
  }

  el('quest-asks-toggle').addEventListener('click', function () {
    var box = el('quest-asks');
    box.classList.toggle('hidden');
    el('quest-asks-toggle').textContent = box.classList.contains('hidden') ? 'Polls and wagers' : 'Close polls and wagers';
    if (!box.classList.contains('hidden')) loadAsks();
  });
  function loadAsks() {
    return api('/api/console/quests/asks').then(function (d) {
      if (!d || !d.ok) return;
      state.asks = d.asks;
      renderAsks();
    }).catch(function () {});
  }
  function renderAsks() {
    var box = el('quest-asks');
    box.textContent = '';
    box.appendChild(h('h3', null, 'Polls and wagers'));
    var asks = state.asks || [];
    if (!asks.length && state.askEditing !== '') box.appendChild(h('p', 'note', 'No quest asks anything yet.'));
    asks.forEach(function (a) {
      var block = h('div', 'tg-row ask-row');
      if (state.askEditing === a.key) { block.appendChild(askEditor(a)); box.appendChild(block); return; }
      var head = h('div', 'tg-line');
      head.appendChild(chip(a.key));
      head.appendChild(h('strong', null, a.name));
      head.appendChild(h('span', 'muted', askKindName(a.kind)));
      head.appendChild(h('span', 'grow'));
      head.appendChild(btn('Edit', 'quiet small', function () { state.askEditing = a.key; renderAsks(); }));
      if (canTab('desk')) head.appendChild(btn('Its desk', 'quiet small', function () { dash.openDesk(a.key); }));
      block.appendChild(head);
      block.appendChild(h('p', null, a.prompt || ''));
      var facts = [askStateText(a.open, a.open_until), a.answers + (a.answers === 1 ? ' team has answered' : ' teams have answered')];
      if (a.settled) facts.push('settled on ' + a.settled.winner);
      block.appendChild(h('p', 'muted', facts.join(' · ')));
      box.appendChild(block);
    });
    if (state.askEditing === '') {
      var adding = h('div', 'tg-row ask-row');
      adding.appendChild(askEditor(null));
      box.appendChild(adding);
    } else {
      var bar = h('div', 'qg-actions');
      bar.appendChild(btn('Add a poll or wager', 'quiet', function () { state.askEditing = ''; renderAsks(); }));
      box.appendChild(bar);
    }
  }

  // The words of one question: which quest it shows on (picked only when
  // adding), its kind, what it asks, its options and what teams see of
  // the other answers.
  function askEditor(a) {
    var wrap = h('div', 'qg-sect qg-ask');
    var cur = a || { kind: 'choice', prompt: '', options: [], reveal: '', reveal_live: false };
    if (a) {
      var head = h('div', 'tg-line');
      head.appendChild(chip(a.key));
      head.appendChild(h('strong', null, a.name));
      wrap.appendChild(head);
    }
    var grid = h('div', 'qg-grid');
    var quest = null;
    if (!a) {
      var taken = {};
      (state.asks || []).forEach(function (x) { taken[x.key.toLowerCase()] = true; });
      quest = h('select');
      quest.appendChild(new Option('Pick a quest', ''));
      (state.groups || []).filter(function (g) { return !taken[g.key.toLowerCase()]; }).forEach(function (g) {
        quest.appendChild(new Option(g.key + ' · ' + g.name, g.key));
      });
      grid.appendChild(field('Quest', quest));
    }
    var kind = h('select');
    ASK_KINDS.forEach(function (k) { var o = h('option', null, k[1]); o.value = k[0]; kind.appendChild(o); });
    kind.value = cur.kind || 'choice';
    var prompt = textInput(cur.prompt, 'The question the teams read');
    var reveal = h('select');
    ASK_REVEALS.forEach(function (k) { var o = h('option', null, k[1]); o.value = k[0]; reveal.appendChild(o); });
    reveal.value = cur.reveal || '';
    var tallyOption = reveal.options[1];
    grid.appendChild(field('Question', kind));
    grid.appendChild(field('What it asks', prompt));
    grid.appendChild(field('Teams see', reveal));
    wrap.appendChild(grid);

    var revealLive = h('input');
    revealLive.type = 'checkbox';
    revealLive.checked = !!cur.reveal_live;
    var liveRow = h('div', 'qg-picks');
    var liveLabel = h('label');
    liveLabel.appendChild(revealLive);
    liveLabel.appendChild(document.createTextNode('While it is open too'));
    liveRow.appendChild(liveLabel);
    wrap.appendChild(liveRow);

    var options = h('textarea');
    options.placeholder = 'One option per line';
    options.value = (cur.options || []).join('\n');
    var optionsField = field('Options', options);
    wrap.appendChild(optionsField);

    function sync() {
      var k = kind.value;
      optionsField.classList.toggle('hidden', k !== 'choice' && k !== 'wager');
      liveRow.classList.toggle('hidden', !reveal.value);
      // a number or a typed answer has no options to count
      tallyOption.textContent = k === 'choice' || k === 'wager' ? 'How many picked each option' : 'How many answered';
    }
    kind.addEventListener('change', sync);
    reveal.addEventListener('change', sync);
    sync();

    var bar = h('div', 'qg-actions');
    var save = btn(a ? 'Save' : 'Add', null, function () {
      var key = a ? a.key : quest.value;
      if (!key) { shake(quest); quest.focus(); return; }
      busy(save, post('/api/console/quests/group/ask/save', {
        key: key, kind: kind.value, prompt: prompt.value, options: options.value,
        reveal: reveal.value, reveal_live: revealLive.checked
      })).then(function (r) {
        if (!done(r, function () { return r.note || (a ? 'Saved the question on ' : 'Added a question to ') + key; })) return;
        state.askEditing = null;
        loadAsks();
      }).catch(function () {});
    });
    bar.appendChild(save);
    bar.appendChild(btn('Cancel', 'quiet', function () { state.askEditing = null; renderAsks(); }));
    if (a) {
      bar.appendChild(h('span', 'grow'));
      bar.appendChild(armed('Remove', 'Remove the question from ' + a.key, function (go) {
        busy(go, post('/api/console/quests/group/ask/save', { key: a.key, kind: '' })).then(function (r) {
          if (!done(r, a.key + ' asks nothing now')) return;
          state.askEditing = null;
          loadAsks();
        }).catch(function () {});
      }));
    }
    wrap.appendChild(bar);
    return wrap;
  }

  // What a question's teams answered, counted, and for a wager the
  // settlement, on the quest's desk. o.reload draws it again after a
  // settlement.
  function drawAskResults(respBox, key, d, o) {
    respBox.textContent = '';
    respBox.classList.remove('hidden');
    // hidden teams (test runs) are kept out here like everywhere else,
    // counts included, so the tally matches the table under it
    var shown = (d.responses || []).filter(function (r) { return !(state.hideHidden && r.hidden); });
    respBox.appendChild(h('p', 'note', shown.length + (shown.length === 1 ? ' team has answered' : ' teams have answered')));

    if (d.kind !== 'text' && (d.counts || []).length) {
      var counts = h('div', 'qg-ask-counts');
      d.counts.forEach(function (c) {
        var teams = 0;
        var points = 0;
        shown.forEach(function (r) {
          if (r.choice === c.choice) { teams++; points += Number(r.amount) || 0; }
        });
        var pill = h('span', 'qg-ask-count');
        pill.appendChild(h('strong', null, c.choice || 'Answers'));
        var tail = ' — ' + teams + (teams === 1 ? ' team' : ' teams');
        if (points) tail += ' · ' + (Math.round(points * 100) / 100) + ' points';
        pill.appendChild(document.createTextNode(tail));
        counts.appendChild(pill);
      });
      respBox.appendChild(counts);
    }

    if (!shown.length) { respBox.appendChild(h('p', 'note', 'No answers yet.')); return; }
    var table = h('table');
    var thead = h('thead');
    thead.appendChild(row([h('th', null, 'Team'), h('th', null, 'Answer'), h('th', 'num', 'Points'), h('th', null, 'When')]));
    table.appendChild(thead);
    var tbody = h('tbody');
    shown.forEach(function (r) {
      var amount = Number(r.amount) || 0;
      tbody.appendChild(row([
        h('td', null, r.team),
        h('td', null, r.choice || ''),
        h('td', 'num', amount ? String(amount) : ''),
        h('td', null, fmtTime(r.updated_at))
      ]));
    });
    table.appendChild(tbody);
    var scroll = h('div', 'table-scroll');
    scroll.appendChild(table);
    respBox.appendChild(scroll);
    if (d.kind === 'wager') respBox.appendChild(settleBar(d, key, o));
  }

  // Settling pays the teams that picked the winner and takes the
  // stake off the rest, so the winning option is typed back first.
  function settleBar(d, key, o) {
    var bar = h('div', 'qg-actions');
    if (d.settled) {
      bar.appendChild(h('span', 'muted', 'Settled on ' + d.settled.winner + (d.settled.by ? ' by ' + d.settled.by : '') +
        (d.settled.at ? ', ' + fmtTime(d.settled.at) : '') + (d.settled.undoable ? '.' : '. A correction goes on the team\'s ledger.')));
      // undoing it moves every team back, and it can be settled again
      if (d.settled.undoable) {
        bar.appendChild(armed('Undo the settlement', 'Move every team back', function (go) {
          busy(go, post('/api/console/quests/group/ask/unsettle', { key: key })).then(function (r) {
            if (!done(r, function () { return 'Settlement on ' + r.winner + ' undone for ' + r.teams + (r.teams === 1 ? ' team' : ' teams'); })) return;
            o.reload();
            refreshTeamsOnly();
          }).catch(function () {});
        }));
      }
      return bar;
    }
    bar.appendChild(h('span', 'muted', 'Settling gives every team that picked the winner its stake and takes it off the rest.'));
    var pick = h('select');
    (d.options || []).forEach(function (choice) { var op = h('option', null, choice); op.value = choice; pick.appendChild(op); });
    bar.appendChild(pick);
    var host = h('span', 'inline');
    var arm = btn('Settle', 'danger', function () {
      var winner = pick.value;
      if (!winner) { toast('Pick the winning option first.', true); return; }
      var typed = h('input');
      typed.placeholder = 'Type ' + winner;
      var go = btn('Settle', 'danger', function () {
        if (typed.value.trim() !== winner) { shake(typed); return; }
        busy(go, post('/api/console/quests/group/ask/settle', { key: key, winner: winner })).then(function (r) {
          if (!done(r, 'Settled on ' + r.winner + ' — ' + r.settled + (r.settled === 1 ? ' team moved' : ' teams moved'))) return;
          host.textContent = '';
          host.appendChild(arm);
          o.reload();
          refreshTeamsOnly();
        }).catch(function () {});
      });
      var cancel = btn('Cancel', 'quiet', function () { host.textContent = ''; host.appendChild(arm); });
      typed.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); if (e.key === 'Escape') cancel.click(); });
      host.textContent = '';
      host.appendChild(typed); host.appendChild(go); host.appendChild(cancel);
      typed.focus();
    });
    host.appendChild(arm);
    bar.appendChild(host);
    return bar;
  }
})(window.dash);
