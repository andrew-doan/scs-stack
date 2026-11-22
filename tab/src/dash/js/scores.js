// The Scores tab: freezing and closing the tab, the saved copies of the
// standings, the ledger check, the schedule and the day board.
(function (dash) {
  // core.js
  var amountText = dash.amountText, api = dash.api, btn = dash.btn, busy = dash.busy, can = dash.can,
    done = dash.done, el = dash.el, fmtTime = dash.fmtTime, fromLocalInput = dash.fromLocalInput, h = dash.h,
    post = dash.post, row = dash.row, session = dash.session, setSession = dash.setSession,
    statCard = dash.statCard, toast = dash.toast;
  // share.js
  var copyStandings = dash.copyStandings, nowStamp = dash.nowStamp;
  // tabs.js
  var show = dash.show;

  dash.loadFreeze = loadFreeze;
  dash.loadLedgerCheck = loadLedgerCheck;
  dash.loadSchedule = loadSchedule;
  dash.loadBoard = loadBoard;

  // ---- freezing and closing the tab, and the saved standings ----
  // Freezing and closing are two taps each, so neither can happen by
  // accident mid-event, and the line under the title says plainly which
  // way round things are.
  var freezeBtn = el('freeze-btn');
  var closeBtn = el('close-btn');
  var freezeState = el('freeze-state');
  var freezeCard = freezeBtn && freezeBtn.closest('.freeze-card');
  var tabNow = { frozen: false, closed: false };
  var KIND_NAMES = { freeze: 'At the freeze', hand: 'Saved by hand', hour: 'On the hour' };
  var copies = { list: [], at: -1, shown: null };

  function paintFreeze(d) {
    if (!freezeBtn) return;
    tabNow = { frozen: !!d.frozen, closed: !!d.closed, frozen_at: d.frozen_at, closed_at: d.closed_at };
    freezeCard.classList.toggle('is-frozen', tabNow.frozen || tabNow.closed);
    disarm(freezeBtn);
    disarm(closeBtn);
    var line;
    if (tabNow.closed) {
      line = 'Closed since ' + fmtTime(d.closed_at) + '. Teams see no standings at all.' +
        (tabNow.frozen ? ' Opening it goes back to the copy frozen at ' + fmtTime(d.frozen_at) + '.' : '');
    } else if (tabNow.frozen) {
      line = 'Frozen since ' + fmtTime(d.frozen_at) + '. Teams see the standings as they were then.';
    } else {
      line = 'Live: teams see the standings move.';
    }
    freezeState.textContent = line;
    if (Array.isArray(d.copies)) renderCopies(d.copies);
  }

  function loadFreeze() {
    if (!freezeBtn) return;
    api('/api/console/freeze').then(function (d) { if (d.ok) paintFreeze(d); }).catch(function () {});
  }

  // what each button says when it is not waiting for its second tap
  function restLabel(button) {
    if (button === freezeBtn) return tabNow.frozen ? 'Unfreeze the tab' : 'Freeze the tab';
    if (button === closeBtn) return tabNow.closed ? 'Open the tab' : 'Close the tab';
    if (button === copyFreeze) return 'Freeze the tab with this';
    return 'Delete';
  }
  function disarm(button) {
    if (!button) return;
    clearTimeout(button._arm);
    button.classList.remove('is-armed');
    button.textContent = restLabel(button);
  }
  // The first tap arms the button for five seconds; the second does it.
  function twoTaps(button, armedText, go) {
    button.addEventListener('click', function () {
      if (!button.classList.contains('is-armed')) {
        button.classList.add('is-armed');
        button.textContent = armedText();
        clearTimeout(button._arm);
        button._arm = setTimeout(function () { disarm(button); }, 5000);
        return;
      }
      disarm(button);
      go();
    });
  }

  // The second tap reads the tab's state again before it sends anything:
  // another organiser may have frozen or closed it since this page
  // loaded it. If so the card shows how it is now and nothing is sent;
  // otherwise what goes is the change the button said.
  function whenUnchanged(button, which, send) {
    var shown = !!tabNow[which];
    busy(button, api('/api/console/freeze').then(function (d) {
      if (!d || !d.ok) return d;
      if (!!d[which] === shown) return send(!shown);
      paintFreeze(d);
      return { error: which === 'frozen'
        ? (d.frozen ? 'The tab was already frozen, at ' + fmtTime(d.frozen_at) + '. Nothing was changed.' : 'The tab was already unfrozen. Nothing was changed.')
        : (d.closed ? 'The tab was already closed, at ' + fmtTime(d.closed_at) + '. Nothing was changed.' : 'The tab was already open. Nothing was changed.') };
    })).then(function (r) {
      if (done(r, function () {
        if (which === 'frozen') return r.frozen ? 'The tab is frozen. The public sees it as it stands now.' : 'The tab is unfrozen.';
        return r.closed ? 'The tab is closed. The public sees no standings.' : 'The tab is open again.';
      })) {
        loadFreeze();
        if (which === 'frozen') loadBoard();
      }
    }).catch(function () {});
  }
  if (freezeBtn) {
    twoTaps(freezeBtn, function () { return tabNow.frozen ? 'Tap again to unfreeze' : 'Tap again to freeze'; }, function () {
      whenUnchanged(freezeBtn, 'frozen', function (want) { return post('/api/console/freeze', { frozen: want }); });
    });
    twoTaps(closeBtn, function () { return tabNow.closed ? 'Tap again to open' : 'Tap again to close'; }, function () {
      whenUnchanged(closeBtn, 'closed', function (want) { return post('/api/console/freeze/close', { closed: want }); });
    });
  }

  // The saved copies: one at every freeze, one each hour the standings
  // moved, and any saved by hand. Picking one shows the board as it
  // stood, with what changed since the copy before it; Earlier and Later
  // step through them hour by hour.
  var copyPick = el('copy-pick');
  var copyPrev = el('copy-prev');
  var copyNext = el('copy-next');
  var copyView = el('copy-view');
  var copySince = el('copy-since');
  var copyFreeze = el('copy-freeze');
  var copyDelete = el('copy-delete');
  var copyEmpty = el('copy-empty');
  var copyTools = el('copy-tools');

  function kindName(c) {
    return c.kind === 'hand' && c.taken_by ? 'Saved by ' + c.taken_by : (KIND_NAMES[c.kind] || c.kind);
  }

  function renderCopies(list) {
    if (!copyPick) return;
    var keep = copies.shown;
    copies.list = list;
    copyPick.textContent = '';
    list.forEach(function (c) {
      var o = h('option', null, fmtTime(c.taken_at) + ' · ' + kindName(c) +
        (c.top && c.top[0] ? ' · ' + c.top[0].name + ' leads on ' + fmtPoints(c.top[0].points) : ''));
      o.value = c.id;
      copyPick.appendChild(o);
    });
    copyEmpty.classList.toggle('hidden', list.length > 0);
    copyTools.classList.toggle('hidden', !list.length);
    copyPick.classList.toggle('hidden', !list.length);
    el('copy-step').classList.toggle('hidden', !list.length);
    if (!list.length) { copies.at = -1; copies.shown = null; copies.data = null; copyView.textContent = ''; copySince.textContent = ''; return; }
    var at = 0;
    list.forEach(function (c, i) { if (c.id === keep) at = i; });
    showCopy(at);
  }

  function fmtPoints(n) {
    return (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  function showCopy(at) {
    var c = copies.list[at];
    if (!c) return;
    copies.at = at;
    copies.shown = c.id;
    copyPick.value = String(c.id);
    // the list is newest first: Earlier is further down it
    copyPrev.disabled = at >= copies.list.length - 1;
    copyNext.disabled = at <= 0;
    disarm(copyFreeze);
    disarm(copyDelete);
    api('/api/console/freeze/copy?id=' + c.id).then(function (d) {
      if (!d.ok || copies.shown !== c.id) return;
      drawCopy(d.copy, d.before);
    }).catch(function () {});
  }

  function drawCopy(copy, before) {
    copies.data = copy;
    copyView.textContent = '';
    copySince.textContent = before ? 'Change since the copy from ' + fmtTime(before.taken_at) + '.' : '';
    if (!copy.teams.length) { copyView.appendChild(h('p', 'muted', 'Nobody was on the tab then.')); return; }
    var was = {};
    if (before) before.teams.forEach(function (t) { was[t.name] = t; });
    var table = h('table');
    var head = [h('th', 'num', 'Place'), h('th', null, 'Team'), h('th', 'num', 'Points')];
    if (before) head.push(h('th', null, 'Change'));
    table.appendChild(h('thead')).appendChild(row(head));
    var body = h('tbody');
    copy.teams.forEach(function (t) {
      var name = h('td', null, t.name);
      if (t.dnf) name.appendChild(h('span', 'muted', ' (DNF)'));
      var cells = [h('td', 'num', t.dnf ? '-' : String(t.rank)), name, h('td', 'num', fmtPoints(t.points))];
      if (before) {
        var then = was[t.name];
        var moved = '';
        if (!then) moved = 'new';
        else {
          var gain = Math.round((Number(t.points) - Number(then.points)) * 100) / 100;
          var places = t.dnf || then.dnf ? 0 : then.rank - t.rank;
          moved = (gain > 0 ? '+' + fmtPoints(gain) : gain < 0 ? '−' + fmtPoints(-gain) : '');
          if (places) moved += (moved ? ', ' : '') + (places > 0 ? 'up ' + places : 'down ' + (-places));
        }
        cells.push(h('td', 'muted', moved));
      }
      body.appendChild(row(cells));
    });
    table.appendChild(body);
    copyView.appendChild(table);
  }

  if (copyPick) {
    copyPick.addEventListener('change', function () {
      var id = Number(copyPick.value);
      copies.list.forEach(function (c, i) { if (c.id === id) showCopy(i); });
    });
    copyPrev.addEventListener('click', function () { showCopy(copies.at + 1); });
    copyNext.addEventListener('click', function () { showCopy(copies.at - 1); });
    el('copy-image').addEventListener('click', function () {
      var c = copies.data;
      if (c && c.id === copies.shown) copyStandings(Promise.resolve({ teams: c.teams, at: c.taken_at }));
    });
    el('copy-save').addEventListener('click', function () {
      var b = el('copy-save');
      busy(b, post('/api/console/freeze/save', {})).then(function (r) {
        if (done(r, 'Saved the standings as they are now.')) { copies.shown = r.id; loadFreeze(); }
      }).catch(function () {});
    });
    twoTaps(copyFreeze, function () { return 'Tap again to freeze with it'; }, function () {
      var id = copies.shown;
      busy(copyFreeze, post('/api/console/freeze', { frozen: true, copy_id: id })).then(function (r) {
        if (done(r, function () { return 'The tab is frozen with the copy from ' + fmtTime(r.frozen_at) + '.'; })) {
          loadFreeze();
          loadBoard();
        }
      }).catch(function () {});
    });
    twoTaps(copyDelete, function () { return 'Tap again to delete'; }, function () {
      var id = copies.shown;
      busy(copyDelete, post('/api/console/freeze/copy/delete', { id: id })).then(function (r) {
        if (done(r, 'Deleted that copy.')) { copies.shown = null; loadFreeze(); }
      }).catch(function () {});
    });
  }

  // The hourly check of each line's points against what its quest is worth
  // now. Nothing shows while they match.
  function paintLedgerCheck(check) {
    var box = el('ledger-state');
    if (!box) return;
    box.textContent = '';
    var found = check && check.problems ? check.problems : [];
    box.classList.toggle('hidden', !found.length);
    if (!found.length) return;
    var n = check.count || found.length;
    box.appendChild(h('p', 'review-warn', n + (n === 1 ? ' team and code has' : ' teams and codes have') +
      ' lines worth something other than the quest\'s points, checked ' + fmtTime(check.at) + '.'));
    var list = h('ul', 'ledger-problems');
    found.slice(0, 12).forEach(function (p) {
      list.appendChild(h('li', null, p.team + ' · ' + p.code + ': the lines say ' + amountText(p.ledger) +
        ', the quest\'s points ' + amountText(p.tab)));
    });
    box.appendChild(list);
    var again = btn('Check again', 'quiet small', function () {
      busy(again, post('/api/console/ledger/check', {})).then(function (r) {
        if (r.ok) { paintLedgerCheck(r); if (!r.count) toast('Every line matches its quest\'s points.'); }
        else toast(r.error || 'The check did not run.', true);
      }).catch(function () {});
    });
    box.appendChild(again);
  }
  function loadLedgerCheck() {
    if (!el('ledger-state') || !can('scores')) return;
    api('/api/console/ledger/check').then(function (d) {
      if (d.ok) paintLedgerCheck(d.check);
    }).catch(function () {});
  }

  // What the worker still has in hand. Both of these finish on their
  // own a minute at a time, so this is a progress line, not a to-do.
  function loadSchedule() {
    api('/api/console/schedule').then(function (d) {
      if (!d.ok || !el('sched-state')) return;
      var bits = [];
      if (d.push_waiting) bits.push(d.push_waiting + ' push announcement' + (d.push_waiting === 1 ? '' : 's') + ' still going out');
      if (d.emails_waiting) bits.push(d.emails_waiting + ' email' + (d.emails_waiting === 1 ? '' : 's') + ' of an announcement still to send');
      if (d.tickets_waiting) bits.push(d.tickets_waiting + ' ticket email' + (d.tickets_waiting === 1 ? '' : 's') + ' still being retried');
      el('sched-state').textContent = bits.length
        ? 'Still going: ' + bits.join(', ') + '. The worker finishes these a batch a minute.' +
          (d.email_off && (d.emails_waiting || d.tickets_waiting) ? ' Email sending is off in Settings, so the emails wait.' : '')
        : '';
      el('sched-state').classList.toggle('hidden', !bits.length);
    }).catch(function () {});
  }

  // ---- the day board ----
  // The numbers an organiser wants without asking: what is waiting on
  // review, how busy it is, who has arrived, and whether the parts that
  // run elsewhere are answering.
  // how long ago a stamp was, in words, for the oldest waiting file
  function agoText(utc) {
    var t = String(utc == null ? '' : utc).trim();
    var m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/);
    if (!m) return '';
    var then = new Date(m[1] + 'T' + m[2] + (m[3] || ':00') + 'Z').getTime();
    if (isNaN(then)) return '';
    var mins = Math.max(0, Math.round((Date.now() - then) / 60000));
    if (mins < 1) return 'oldest just now';
    if (mins < 60) return 'oldest ' + mins + ' min ago';
    var hrs = Math.floor(mins / 60);
    return 'oldest ' + hrs + 'h' + (mins % 60 ? ' ' + (mins % 60) + 'm' : '') + ' ago';
  }
  function paintBoard(d) {
    var board = el('board');
    if (!board) return;
    board.textContent = '';
    var hours = d.per_hour || [];
    var thisHour = hours.length ? hours[hours.length - 1].submissions : 0;
    var lastHour = hours.length > 1 ? hours[hours.length - 2].submissions : 0;
    board.appendChild(statCard('Waiting on review', d.pending,
      d.pending ? (agoText(d.oldest_pending_at) || 'since ' + fmtTime(d.oldest_pending_at)) : 'nothing waiting',
      d.pending >= 10));
    board.appendChild(statCard('Submissions this hour', thisHour, lastHour + ' in the hour before'));
    board.appendChild(statCard('Checked in', d.checkin.checked_in,
      d.checkin.live ? 'of ' + d.checkin.registered + ' registered' : 'check-in is not answering'));
    board.appendChild(statCard('Teams', d.teams.total,
      d.teams.hidden ? d.teams.hidden + ' hidden' : 'none hidden'));
    board.appendChild(statCard('Push subscribers', d.push_subs, 'devices'));
    board.appendChild(statCard('Encoders online', d.encoder.online,
      d.encoder.waiting + ' video' + (d.encoder.waiting === 1 ? '' : 's') + ' waiting'));
  }
  function loadBoard() {
    if (!el('board')) return;
    api('/api/console/board').then(function (d) { if (d.ok) paintBoard(d); }).catch(function () {});
  }
  el('last-until-save').addEventListener('click', function () {
    var until = fromLocalInput(el('last-until').value);
    busy(el('last-until-save'), post('/api/console/tab/last-until', { until: until })).then(function (r) {
      if (done(r, 'Saved.')) dash.paintAfter(r);
    }).catch(function () {});
  });

  // the tab as a sheet: the teams on the public board across, the codes
  // everyone may see down, each team's amount in its column
  el('tab-export').addEventListener('click', function () {
    busy(el('tab-export'), fetch('/api/console/tab/export', { headers: { authorization: 'Bearer ' + session() } }).then(function (r) {
      if (r.status === 401) { setSession(''); show(false); throw new Error('signed out'); }
      if (!r.ok) throw new Error('export ' + r.status);
      return r.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'scs2-tab.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    }).catch(function (err) { if (err.message !== 'signed out') toast('Export failed.', true); }));
  });
  if (el('standings-image')) {
    el('standings-image').addEventListener('click', function () {
      copyStandings(api('/api/console/standings').then(function (d) {
        if (!d.ok) throw new Error(d.error || 'no standings');
        return { teams: d.teams, at: nowStamp() };
      }));
    });
  }
})(window.dash);
