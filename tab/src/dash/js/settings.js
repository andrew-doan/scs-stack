// The Settings tab: the after-the-event switches, the numbers it can
// change, EOI, the countdown, sign-up settings, stopping every email and
// the confirmation email test, the version counters and the tools.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, busy = dash.busy, byName = dash.byName, done = dash.done, el = dash.el,
    fmtTime = dash.fmtTime, fromLocalInput = dash.fromLocalInput, h = dash.h, post = dash.post,
    savesAtOnce = dash.savesAtOnce, timeBox = dash.timeBox, toast = dash.toast, toLocalInput = dash.toLocalInput;

  dash.loadFlags = loadFlags;
  dash.loadLimits = loadLimits;
  dash.loadEoi = loadEoi;
  dash.loadCountdown = loadCountdown;
  dash.loadRegoSettings = loadRegoSettings;
  dash.loadEmailHold = loadEmailHold;
  dash.loadCounters = loadCounters;

  // ---- the after-the-event switches ----
  // Four plain switches: team pages, the recap, the replay and push
  // notifications off. Each flip goes to the worker straight away and the
  // site sees it on its next pulse.
  var flagBoxes = { team_pages: el('flag-team-pages'), recap: el('flag-recap'), replay: el('flag-replay'), push_off: el('flag-push-off') };
  var FLAG_DONE = {
    team_pages: ['Team pages are open on the site.', 'Team pages are closed.'],
    recap: ['The recap page is open on the site.', 'The recap page is closed.'],
    replay: ['The replay is open on the site.', 'The replay is closed.'],
    push_off: ['Push notifications are off.', 'Push notifications are on again.']
  };
  function paintFlags(flags) {
    Object.keys(flagBoxes).forEach(function (k) { if (flagBoxes[k]) flagBoxes[k].checked = !!flags[k]; });
    var on = [];
    if (flags.team_pages) on.push('team pages');
    if (flags.recap) on.push('the recap');
    if (flags.replay) on.push('the replay');
    var list = on.length > 1 ? on.slice(0, -1).join(', ') + ' and ' + on[on.length - 1] : on.join('');
    el('flag-state').textContent = (on.length ? 'Open on the site: ' + list + '.' : 'All closed.') +
      (flags.push_off ? ' No push notifications.' : '');
  }
  function loadFlags() {
    api('/api/console/flags').then(function (d) { if (d.ok) paintFlags(d.flags); }).catch(function () {});
  }
  Object.keys(flagBoxes).forEach(function (k) {
    if (!flagBoxes[k]) return;
    savesAtOnce(flagBoxes[k], function (want) {
      return post('/api/console/flags/set', { name: k, value: want }).then(function (r) {
        if (!done(r, function () { return FLAG_DONE[k][want ? 0 : 1]; })) return false;
        paintFlags(r.flags);
        return true;
      });
    });
  });

  // ---- the numbers the Settings tab can change, by the name the worker
  // knows each one by: its box, its note, its button and what saving says ----
  var LIMIT_ROWS = {
    submit_max_pending: ['lim-submit-max-pending', 'lim-state', 'lim-save',
      function (n) { return 'A team may now have ' + n + ' submissions waiting.'; }],
    album_anyone_per_hour: ['lim-album-per-hour', 'lim-album-state', 'lim-album-save',
      function (n) { return 'One connection may now add ' + n + ' an hour.'; }]
  };
  function paintLimits(d) {
    Object.keys(LIMIT_ROWS).forEach(function (name) {
      var row = LIMIT_ROWS[name];
      var now = d.limits && d.limits[name];
      var was = d.defaults && d.defaults[name];
      if (el(row[0]) && now != null) el(row[0]).value = String(now);
      if (el(row[1])) el(row[1]).textContent = now != null && was != null && now !== was ? 'Changed from ' + was + '.' : '';
    });
  }
  function loadLimits() {
    api('/api/console/limits').then(function (d) { if (d.ok) paintLimits(d); }).catch(function () {});
  }
  Object.keys(LIMIT_ROWS).forEach(function (name) {
    var row = LIMIT_ROWS[name];
    if (!el(row[2])) return;
    el(row[2]).addEventListener('click', function () {
      var typed = el(row[0]).value.trim();
      if (typed === '') { toast('Type a number first.', true); return; }
      var send = {};
      send[name] = Number(typed);
      busy(el(row[2]), post('/api/console/limits/set', { limits: send }))
        .then(function (r) { if (done(r, row[3](typed))) paintLimits(r); })
        .catch(function () {});
    });
  });

  // ---- EOI ----
  function paintEoi(d) {
    if (d.points != null && document.activeElement !== el('eoi-points')) el('eoi-points').value = String(d.points);
    var bits = [];
    if (d.points == null) bits.push('No points set yet, so nobody has been given any.');
    if (d.listed) {
      bits.push(d.listed + (d.listed === 1 ? ' person' : ' people') + ' on the list. ' +
        d.signed_up + ' signed up, ' + d.in_teams + ' of them in a team. ' + d.not_signed_up + ' not signed up.');
    } else {
      bits.push('No list uploaded.');
    }
    el('eoi-state').textContent = bits.join(' ');
    // the points go on when somebody presses the button, and again only
    // when they press it again
    var said = d.award ? 'Awarded ' + fmtTime(d.award.at) + ' by ' + byName(d.award.by) + '.' : 'Not awarded yet.';
    if (d.award && d.waiting) said += ' ' + d.waiting + (d.waiting === 1 ? ' team has' : ' teams have') + ' a different count now.';
    el('eoi-award-state').textContent = said;
    el('eoi-award').textContent = d.award ? 'Award again' : 'Award the EOI points';
    el('eoi-award').disabled = d.points == null || (!!d.award && !d.waiting);
    var box = el('eoi-teams');
    box.textContent = '';
    if (!d.teams || !d.teams.length) return;
    var table = h('table');
    var head = h('tr');
    head.appendChild(h('th', null, 'Team'));
    head.appendChild(h('th', 'num', 'People'));
    head.appendChild(h('th', 'num', 'Awarded'));
    var thead = h('thead'); thead.appendChild(head); table.appendChild(thead);
    var body = h('tbody');
    d.teams.forEach(function (t) {
      var tr = h('tr');
      tr.appendChild(h('td', null, t.name));
      tr.appendChild(h('td', 'num', String(t.people)));
      tr.appendChild(h('td', 'num' + (t.awarded !== t.people ? ' rc-twice' : ''), String(t.awarded)));
      body.appendChild(tr);
    });
    table.appendChild(body);
    box.appendChild(table);
  }
  function loadEoi() {
    if (!el('eoi-state')) return;
    api('/api/console/eoi').then(function (d) {
      if (d.ok) paintEoi(d); else el('eoi-state').textContent = d.error || '';
    }).catch(function () {});
  }
  if (el('eoi-points-save')) {
    el('eoi-points-save').addEventListener('click', function () {
      var typed = el('eoi-points').value.trim();
      if (typed === '') { toast('Type the points first.', true); return; }
      busy(el('eoi-points-save'), post('/api/console/eoi/points', { points: Number(typed) })).then(function (r) {
        if (done(r, 'Each person on the EOI list is worth ' + typed + ' points.')) paintEoi(r);
      }).catch(function () {});
    });
    el('eoi-award').addEventListener('click', function () {
      busy(el('eoi-award'), post('/api/console/eoi/award', {})).then(function (r) {
        if (done(r, r.unchanged ? 'Every team already has its EOI points.' : 'EOI points awarded.')) paintEoi(r);
      }).catch(function () {});
    });
    el('eoi-upload').addEventListener('click', function () {
      var file = el('eoi-file').files && el('eoi-file').files[0];
      if (!file) { toast('Pick the CSV first.', true); return; }
      var reader = new FileReader();
      reader.onload = function () {
        busy(el('eoi-upload'), post('/api/console/eoi/list', { csv: String(reader.result || '') })).then(function (r) {
          if (done(r, function () {
            return r.listed + (r.listed === 1 ? ' person' : ' people') + ' on the EOI list' +
              (r.skipped ? ', ' + r.skipped + (r.skipped === 1 ? ' row' : ' rows') + ' with no email or zID left out' : '') + '.';
          })) { paintEoi(r); el('eoi-file').value = ''; }
        }).catch(function () {});
      };
      reader.onerror = function () { toast('That file could not be read.', true); };
      reader.readAsText(file);
    });
  }

  // ---- the countdown on the home page ----
  // A run of stops in time order: the day starting, submissions
  // closing, the ceremony. The whole list is saved at once — editing
  // one row of a handful through its own endpoint would need ids and a
  // merge, and there is nothing on this card a resend cannot put right.
  var cdRows = el('cd-rows');
  function cdRow(label, at) {
    var row = h('div', 'cd-row');
    var name = document.createElement('input');
    name.type = 'text';
    name.className = 'cd-label';
    name.maxLength = 60;
    name.placeholder = 'What it counts to';
    name.value = label || '';
    var when = document.createElement('input');
    timeBox(when);
    when.className = 'cd-at';
    when.value = toLocalInput(at || '');
    var drop = btn('Remove', 'quiet fixed', function () { row.parentNode.removeChild(row); });
    row.appendChild(name);
    row.appendChild(when);
    row.appendChild(drop);
    return row;
  }
  function cdState(stops) {
    var list = (stops || []).slice();
    var now = new Date();
    for (var i = 0; i < list.length; i++) {
      var t = new Date(String(list[i].at).replace(' ', 'T') + 'Z');
      if (!isNaN(t.getTime()) && t > now) {
        el('cd-state').textContent = 'Counting to ' + list[i].label + ', ' + fmtTime(list[i].at) + '.';
        return;
      }
    }
    el('cd-state').textContent = list.length
      ? 'Every stop has passed; the page says the event is over.'
      : 'No stops saved: the page counts to the date written into it.';
  }
  // The rows as drawn from the last answer, to tell whether anything has
  // been typed since: a reload leaves rows being edited alone.
  var cdDrawn = '';
  function cdTyped() {
    var all = Array.prototype.map.call(cdRows.querySelectorAll('input'), function (i) { return i.value; });
    if (el('cd-over')) all.push(el('cd-over').value);
    return JSON.stringify(all);
  }
  // the line the page shows once every stop has passed; blank is the
  // page's own, which is the field's placeholder
  function paintCountdown(stops, over, saved) {
    cdState(stops);
    if (!saved && cdDrawn && cdTyped() !== cdDrawn) return;
    cdRows.textContent = '';
    (stops || []).forEach(function (s) { cdRows.appendChild(cdRow(s.label, s.at)); });
    if (el('cd-over')) el('cd-over').value = over || '';
    cdDrawn = cdTyped();
  }
  function loadCountdown() {
    api('/api/console/countdown').then(function (d) { if (d.ok) paintCountdown(d.stops, d.over); }).catch(function () {});
  }
  if (el('cd-add')) {
    el('cd-add').addEventListener('click', function () { cdRows.appendChild(cdRow('', '')); });
    el('cd-save').addEventListener('click', function () {
      var stops = [];
      var rows = cdRows.querySelectorAll('.cd-row');
      for (var i = 0; i < rows.length; i++) {
        var label = rows[i].querySelector('.cd-label').value.trim();
        var at = fromLocalInput(rows[i].querySelector('.cd-at').value);
        // a row someone added and then left alone is not a stop
        if (!label && !at) continue;
        stops.push({ label: label, at: at });
      }
      busy(el('cd-save'), post('/api/console/countdown/set', { stops: stops, over: el('cd-over').value })).then(function (r) {
        if (done(r, stops.length ? 'The countdown is saved.' : 'The countdown is back to the date on the page.')) {
          paintCountdown(r.stops, r.over, true);
        }
      }).catch(function () {});
    });
  }


  // one JSON file of every table, kept as the day's record
  // Delete the old cleaned photo copies. Each call does a bounded batch
  // and says how far it got, so the page keeps asking until the worker
  // says it is done.
  if (el('reclean')) {
    el('reclean').addEventListener('click', function () {
      var out = el('reclean-out');
      var removed = 0;
      var checked = 0;
      var dated = 0;
      function round(after) {
        return post('/api/console/files/reclean', { after: after }).then(function (r) {
          if (!r || !r.ok) {
            out.textContent = (r && r.error) || 'The tidy did not finish.';
            return null;
          }
          removed += r.removed || 0;
          checked += r.checked;
          dated += r.dated || 0;
          out.textContent = 'Checked ' + checked + ', deleted ' + removed + '…';
          if (r.done) return r;
          return round(r.after);
        });
      }
      busy(el('reclean'), round(0)).then(function (r) {
        if (!r) return;
        out.textContent = (removed
          ? 'Deleted ' + removed + (removed === 1 ? ' old copy' : ' old copies') + ' from ' + checked + ' files.'
          : 'Checked ' + checked + ' files. There were no old copies left.') +
          (dated ? ' Read when ' + dated + (dated === 1 ? ' photo was' : ' photos were') + ' taken.' : '');
        toast(removed ? 'Deleted ' + removed + (removed === 1 ? ' copy' : ' copies') : 'Nothing to tidy');
      }).catch(function () {
        out.textContent = 'The tidy did not finish.';
      });
    });
  }

  if (el('export-all')) {
    el('export-all').addEventListener('click', function () {
      var go = el('export-all');
      busy(go, api('/api/console/export/all')).then(function (d) {
        if (!d || !d.ok) { done(d); return; }
        var blob = new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'scs2-export-' + String(d.exported_at).slice(0, 10) + '.json';
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
        var rows = 0;
        Object.keys(d.tables).forEach(function (t) { rows += d.tables[t].length; });
        toast('Exported ' + rows + ' row' + (rows === 1 ? '' : 's') +
          ' across ' + Object.keys(d.tables).length + ' tables');
      }).catch(function () {});
    });
  }
  // The Sign-ups card: whether the form is taking signups, the cap it
  // closes itself at, where the count stands, and whether the human
  // check (Turnstile) is on. The worker holds the truth; this paints
  // and saves it.
  // the four rate limits, by the name the worker knows each one by
  var REGO_LIMIT_BOXES = {
    rego_per_hour: 'lim-rego-per-hour',
    rego_per_ip_hour: 'lim-rego-per-ip-hour',
    rego_email_per_hour: 'lim-rego-email-per-hour',
    rego_email_per_day: 'lim-rego-email-per-day'
  };
  function paintRegoSettings(d) {
    el('rego-open').checked = !d.closed;
    el('rego-cap').value = d.cap ? String(d.cap) : '';
    Object.keys(REGO_LIMIT_BOXES).forEach(function (k) {
      var box = el(REGO_LIMIT_BOXES[k]);
      if (box && d.limits && d.limits[k] != null) box.value = String(d.limits[k]);
    });
    var line;
    if (d.closed) line = 'Closed by hand. The form is refusing sign-ups.';
    else if (d.cap && d.people >= d.cap) line = 'Full: ' + d.people + ' of ' + d.cap + ' spots taken. The form has closed itself.';
    else if (d.cap) line = d.people + ' of ' + d.cap + ' spots taken.';
    else line = d.people + ' ' + (d.people === 1 ? 'person' : 'people') + ' signed up, no cap.';
    el('rego-open-state').textContent = line;
    // the same standing over the sign-ups themselves, on the Rego tab
    var standing = el('rego-standing');
    if (standing) {
      standing.textContent = '';
      standing.appendChild(h('strong', null, d.closed || (d.cap && d.people >= d.cap) ? 'Sign-ups closed.' : 'Sign-ups open.'));
      standing.appendChild(document.createTextNode(' ' + line));
    }
    el('rego-guard-note').textContent = d.turnstile ? 'The human check is on.'
      : 'The human check is off until the two Turnstile secrets are set.';
  }
  function loadRegoSettings() {
    api('/api/console/rego/settings').then(function (d) { if (d.ok) paintRegoSettings(d); }).catch(function () {});
  }
  el('rego-settings-save').addEventListener('click', function () {
    var raw = el('rego-cap').value.trim();
    var cap = raw === '' ? 0 : Number(raw);
    // a box left empty keeps what it had rather than reading as zero
    var limits = {};
    Object.keys(REGO_LIMIT_BOXES).forEach(function (k) {
      var box = el(REGO_LIMIT_BOXES[k]);
      var typed = box ? box.value.trim() : '';
      if (typed !== '') limits[k] = Number(typed);
    });
    busy(el('rego-settings-save'), post('/api/console/rego/settings/set', { closed: !el('rego-open').checked, cap: cap, limits: limits }))
      .then(function (r) {
        if (done(r, function () {
          if (r.closed) return 'Registrations closed.';
          return r.cap ? 'Registrations open, closing at ' + r.cap + ' people.' : 'Registrations open, no cap.';
        })) paintRegoSettings(r);
      }).catch(function () {});
  });

  // ---- stop sending email: saved as soon as it is ticked ----
  function loadEmailHold() {
    api('/api/console/email/hold').then(function (d) { if (d.ok) el('email-hold').checked = !!d.held; }).catch(function () {});
  }
  savesAtOnce(el('email-hold'), function (want) {
    return post('/api/console/email/hold', { held: want }).then(function (r) {
      return done(r, want ? 'Email sending is off.' : 'Email sending is on again.');
    });
  });

  // A test send, reported in full. Confirmation emails go out through
  // three shapes in turn and only the first two carry the sender's
  // name, so an inbox showing the bare address means the send fell
  // through to the third — which nothing used to record. This says
  // which way it went out, which shape was accepted and what the
  // refused ones said.
  function emailTestReport(r) {
    var lines = [];
    if (r.ok) {
      lines.push('Sent through ' + r.via + (r.shape ? ', ' + r.shape + '.' : '.'));
      lines.push(r.name_kept
        ? 'The sender name survived: inboxes will show ' + r.from + '.'
        : 'The sender name was dropped: inboxes will show the bare address. Everything that carries the name was refused.');
    } else {
      lines.push(r.error || 'The message did not go out.');
    }
    if (r.note) lines.push(r.note);
    (r.refused || []).forEach(function (x) {
      lines.push('Refused (' + x.shape + '): ' + x.error);
    });
    return lines.join('\n');
  }
  // All three buttons send through the same action; what changes is
  // the kind and what rides with it.
  function sendEmailTest(button, kind, extra) {
    var to = el('email-test-to').value.trim();
    var out = el('email-test-out');
    if (!to) { toast('Type an address to send the test to.'); return; }
    var payload = Object.assign({ to: to, kind: kind }, extra || {});
    busy(button, post('/api/console/rego/email/test', payload))
      .then(function (r) {
        out.classList.toggle('bad', !r.ok);
        out.classList.toggle('muted', !!r.ok);
        out.textContent = emailTestReport(r);
        if (r.ok) toast('Test sent to ' + to + '.');
        else toast(r.error || 'The test did not go out.', true);
      }).catch(function () {});
  }
  el('email-test-send').addEventListener('click', function () {
    sendEmailTest(el('email-test-send'), 'plain');
  });
  el('email-test-ticket').addEventListener('click', function () {
    sendEmailTest(el('email-test-ticket'), 'ticket', {
      name: el('email-test-name').value.trim(),
      team: el('email-test-team').value.trim()
    });
  });
  el('email-test-banner-send').addEventListener('click', function () {
    var banner = el('email-test-banner').value.trim();
    if (!banner) { toast('Paste the link to the picture first.'); return; }
    sendEmailTest(el('email-test-banner-send'), 'banner', {
      name: el('email-test-name').value.trim(),
      team: el('email-test-team').value.trim(),
      banner: banner
    });
  });

  function paintCounters(counters) {
    el('counter-quests').value = counters.quests;
    el('counter-messages').value = counters.messages;
  }
  function loadCounters() {
    api('/api/console/counters').then(function (d) {
      if (d.ok) paintCounters(d.counters);
    }).catch(function () {});
  }
  function setCounter(name, button) {
    busy(button, post('/api/console/counters/set', { name: name, value: el('counter-' + name).value }))
      .then(function (r) {
        if (done(r, 'The ' + name + ' counter is now ' + r.counters[name])) paintCounters(r.counters);
      }).catch(function () {});
  }
  el('counter-quests-set').addEventListener('click', function () { setCounter('quests', el('counter-quests-set')); });
  el('counter-messages-set').addEventListener('click', function () { setCounter('messages', el('counter-messages-set')); });
})(window.dash);
