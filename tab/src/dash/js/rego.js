// The Rego tab: the sign-ups, one card per team, the people without a
// team, and editing a person in place.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, busy = dash.busy, can = dash.can, copyLink = dash.copyLink, done = dash.done,
    el = dash.el, fmtTime = dash.fmtTime, h = dash.h, heldIn = dash.heldIn, hiddenTeamIds = dash.hiddenTeamIds,
    holdOpen = dash.holdOpen, labelled = dash.labelled, letGo = dash.letGo, post = dash.post,
    session = dash.session, setSession = dash.setSession, statCard = dash.statCard, state = dash.state,
    textInput = dash.textInput, toast = dash.toast;
  // tabs.js
  var refreshTeamsOnly = dash.refreshTeamsOnly, show = dash.show;

  dash.loadRego = loadRego;
  dash.regoBarChart = regoBarChart;
  dash.renderRego = renderRego;

  // ---- registrations: one card per team, editable in place ----
  var SOCIETY_LIST = ['WestSoc', 'WanderSoc', 'PuzzleSoc', 'Asian Studies Association', 'PhotoSoc', 'RailSoc',
    'Rhythm Games Society', 'Tabletop Games Society', 'Queer Students in STEM', 'GeoGuessrSoc', 'Chess Club'];
  state.rego = [];
  state.regoOpen = {};
  // the person whose QR could not be made, waiting on an answer about
  // their email; kept in state so a refresh does not drop the question
  state.regoAsk = null;
  function loadRego() {
    api('/api/console/rego').then(function (d) {
      if (!d.ok) return;
      state.rego = d.registrations;
      state.regoCheckinLive = !!d.checkin_live;
      // email sending switched off in Settings: nothing here offers to send
      state.regoMailOff = !!d.email_off;
      el('rego-mail-off').classList.toggle('hidden', !state.regoMailOff);
      el('rego-mail-off-go').classList.toggle('hidden', !can('settings'));
      // the most the worker lets the dashboard put in one team
      state.regoMax = d.max_team || 5;
      el('rego-empty').textContent = d.registrations.length ? '' : 'No registrations yet.';
      renderRego();
      dash.loadRegoSettings();
    }).catch(function () {});
  }

  // The sign-up summary above the team cards: how a form's response
  // page reads them. Counted here from the same registrations the
  // cards draw, with hidden teams left out, so the two always agree;
  // the Google Sheet holds these same rows (every signup appends and
  // every edit resyncs it), so this is the sheet's data too.
  function regoBarChart(title, note, rows, total, unit) {
    var card = h('div', 'card rg-chart');
    card.appendChild(h('p', 'rg-chart-title', title));
    if (note) card.appendChild(h('p', 'rg-chart-note', note));
    var max = 0;
    rows.forEach(function (r) { if (r.n > max) max = r.n; });
    rows.forEach(function (r) {
      var row = h('div', 'rg-bar-row' + (r.n ? '' : ' is-zero'));
      var label = h('span', 'rg-bar-label', r.label);
      label.title = r.label;
      row.appendChild(label);
      var track = h('div', 'rg-bar-track');
      var fill = h('div', 'rg-bar-fill');
      fill.style.width = max ? Math.round(r.n / max * 100) + '%' : '0%';
      track.appendChild(fill);
      row.appendChild(track);
      var pct = total ? Math.round(r.n / total * 100) : 0;
      row.appendChild(h('span', 'rg-bar-n', r.n + ' ' + (r.n === 1 ? unit[0] : unit[1]) + ' (' + pct + '%)'));
      card.appendChild(row);
    });
    if (!rows.length) card.appendChild(h('p', 'note', 'Nothing yet.'));
    return card;
  }
  // a signup with nobody in a team yet, marked as a test, goes with the
  // hidden-teams switch
  function soloShown(reg) { return !(reg.solo && reg.hidden && state.hideHidden); }
  function renderRegoSummary() {
    var box = el('rego-summary');
    box.textContent = '';
    var hiddenIds = hiddenTeamIds();
    var all = state.rego.filter(function (reg) { return !(reg.team_id && hiddenIds[reg.team_id]) && soloShown(reg); });
    if (!all.length) return;
    // the team-level counts are of teams; somebody not yet placed is in
    // every count of people and none of teams
    var regs = all.filter(function (reg) { return !reg.solo; });
    var people = 0, checkedIn = 0, photoYes = 0, photoNo = 0, arcYes = 0, termsYes = 0, unplaced = 0;
    var socCounts = {}, socNone = 0, sizeCounts = {}, dietCounts = {}, dietNone = 0;
    all.forEach(function (reg) {
      if (reg.solo) unplaced += reg.members.length;
      if (!reg.solo) {
        var socs = String(reg.societies || '').split(';').map(function (x) { return x.trim(); }).filter(Boolean);
        if (!socs.length) socNone++;
        socs.forEach(function (name) { socCounts[name] = (socCounts[name] || 0) + 1; });
        sizeCounts[reg.members.length] = (sizeCounts[reg.members.length] || 0) + 1;
      }
      reg.members.forEach(function (m) {
        people++;
        if (m.checked_in_at) checkedIn++;
        if (m.terms_at) termsYes++;
        // each person's own answer, from the terms page
        if (m.photo_ok === 1) photoYes++;
        else if (m.photo_ok === 0) photoNo++;
        if (m.arc) arcYes++;
        var diets = String(m.dietary || '').split(';').map(function (x) { return x.trim(); }).filter(Boolean);
        if (!diets.length) dietNone++;
        diets.forEach(function (d) { dietCounts[d] = (dietCounts[d] || 0) + 1; });
      });
    });

    var stats = h('div', 'rg-sum-stats');
    stats.appendChild(statCard('Teams', regs.length, ''));
    stats.appendChild(statCard('People signed up', people, ''));
    if (unplaced) stats.appendChild(statCard('Without a team', unplaced, 'to be placed'));
    stats.appendChild(statCard('Accepted the terms', termsYes, 'of ' + people));
    if (state.regoCheckinLive) stats.appendChild(statCard('Checked in', checkedIn, 'of ' + people));
    stats.appendChild(statCard('Photo permission', photoYes, 'of ' + people));
    box.appendChild(stats);

    var charts = h('div', 'rg-charts');
    // which societies brought the teams in — the form's multi-pick,
    // one answer per team, so the counts sum past the team total
    var socRows = SOCIETY_LIST.map(function (name) { return { label: name, n: socCounts[name] || 0 }; });
    Object.keys(socCounts).forEach(function (name) {
      if (SOCIETY_LIST.indexOf(name) === -1) socRows.push({ label: name, n: socCounts[name] });
    });
    socRows.sort(function (a, b) { return b.n - a.n || (a.label < b.label ? -1 : 1); });
    if (socNone) socRows.push({ label: 'None picked', n: socNone });
    charts.appendChild(regoBarChart('Societies', 'Pick any that apply, so a team can count more than once.', socRows, regs.length, ['team', 'teams']));

    var sizeRows = Object.keys(sizeCounts).map(Number).sort(function (a, b) { return a - b; }).map(function (n) {
      return { label: n + (n === 1 ? ' person' : ' people'), n: sizeCounts[n] };
    });
    charts.appendChild(regoBarChart('Team size', '', sizeRows, regs.length, ['team', 'teams']));

    // each person accepts from the link in their own email
    charts.appendChild(regoBarChart('Terms and waiver', '', [
      { label: 'Accepted', n: termsYes }, { label: 'Not yet', n: people - termsYes }
    ], people, ['person', 'people']));

    charts.appendChild(regoBarChart('Arc members', '', [
      { label: 'Yes', n: arcYes }, { label: 'No', n: people - arcYes }
    ], people, ['person', 'people']));

    charts.appendChild(regoBarChart('Photo permission', 'Each person answers on the terms page.', [
      { label: 'Yes', n: photoYes }, { label: 'No', n: photoNo }, { label: 'Not answered yet', n: people - photoYes - photoNo }
    ], people, ['person', 'people']));

    // dietary is typed, so the long tail is lumped rather than listed
    var dietRows = Object.keys(dietCounts).map(function (d) { return { label: d, n: dietCounts[d] }; })
      .sort(function (a, b) { return b.n - a.n || (a.label < b.label ? -1 : 1); });
    if (dietRows.length > 10) {
      var rest = dietRows.slice(10);
      var restN = 0;
      rest.forEach(function (r) { restN += r.n; });
      dietRows = dietRows.slice(0, 10);
      dietRows.push({ label: rest.length + ' other answers', n: restN });
    }
    if (dietNone) dietRows.push({ label: 'None given', n: dietNone });
    charts.appendChild(regoBarChart('Dietary requirements', '', dietRows, people, ['person', 'people']));

    if (state.regoCheckinLive) {
      charts.appendChild(regoBarChart('Checked in', '', [
        { label: 'Checked in', n: checkedIn }, { label: 'Not yet', n: people - checkedIn }
      ], people, ['person', 'people']));
    }
    // the totals stay up; the bars fold away under them, remembered here
    var fold = h('details', 'rg-fold');
    try { fold.open = localStorage.getItem('scs2-dashboard-rego-charts') === '1'; } catch (e) {}
    fold.addEventListener('toggle', function () {
      try { localStorage.setItem('scs2-dashboard-rego-charts', fold.open ? '1' : '0'); } catch (e) {}
    });
    fold.appendChild(h('summary', null, 'Breakdown by society, team size, terms, Arc, photos and diet'));
    fold.appendChild(charts);
    box.appendChild(fold);
  }

  state.regoPick = {};
  state.regoNewTeam = '';
  function regoNames(reg) {
    return reg.members.map(function (m) { return m.name; }).join(' and ') || 'Nobody';
  }
  // An open editor, and the new team form, keep what is typed in them
  // when the list is drawn again (a search, another card's Edit, a save
  // elsewhere). An action inside an editor that reloads lets it go first,
  // so that one comes back drawn from the fresh answer.
  var takeHeld = heldIn(h('div'));
  function reload(from) { letGo(from); loadRego(); }
  function renderRego() {
    renderRegoSummary();
    var q = el('rego-filter').value.trim().toLowerCase();
    var list = el('rego-list');
    takeHeld = heldIn(list);
    var adding = takeHeld('new');
    list.textContent = '';
    if (adding) list.appendChild(adding);
    var hiddenIds = hiddenTeamIds();
    var solos = state.rego.filter(function (reg) { return reg.solo && soloShown(reg); });
    if (solos.length) list.appendChild(soloBox(solos, q));
    state.rego.forEach(function (reg) {
      if (reg.solo) return;
      if (reg.team_id && hiddenIds[reg.team_id]) return;
      var hay = (reg.team_name + ' ' + reg.members.map(function (m) { return m.name + ' ' + m.zid + ' ' + (m.email || '') + ' ' + (m.discord || ''); }).join(' ')).toLowerCase();
      // a card open for editing stays whatever the search says
      if (q && hay.indexOf(q) === -1 && !state.regoOpen[reg.id]) return;
      list.appendChild(regoCard(reg));
    });
  }
  // People who signed up without a team, one row per signup (a pair
  // stays one row, so it is placed together), and the two ways to place
  // the ones ticked: a new team, or a team on the tab with room for all
  // of them. The ticks only redraw the bar, so the focus stays put.
  function soloBox(solos, q) {
    var box = h('div', 'card rg-solo');
    var head = h('div', 'card-head');
    var everyone = 0;
    solos.forEach(function (reg) { everyone += reg.members.length; });
    head.appendChild(h('h2', 'card-title', 'Without a team'));
    head.appendChild(h('span', 'muted', everyone + (everyone === 1 ? ' person' : ' people')));
    box.appendChild(head);
    Object.keys(state.regoPick).forEach(function (id) {
      if (!solos.some(function (reg) { return String(reg.id) === id; })) delete state.regoPick[id];
    });
    solos.forEach(function (reg) {
      var hay = reg.members.map(function (m) { return m.name + ' ' + m.zid + ' ' + (m.email || '') + ' ' + (m.discord || ''); }).join(' ').toLowerCase();
      if (q && hay.indexOf(q) === -1 && !state.regoOpen[reg.id]) return;
      box.appendChild(regoCard(reg, sync));
    });

    var bar = h('div', 'rg-place');
    var count = h('span', 'rg-place-n');
    var name = textInput(state.regoNewTeam, 'New team name');
    name.addEventListener('input', function () { state.regoNewTeam = name.value; });
    var make = btn('Make the team', 'fixed', function () {
      if (!name.value.trim()) { toast('Name the new team.', true); name.focus(); return; }
      place({ team_name: name.value.trim() }, make);
    });
    var into = h('select');
    var add = btn('Add to team', 'quiet fixed', function () {
      if (!into.value) { toast('Pick a team to add them to.', true); return; }
      place({ team_id: Number(into.value) }, add);
    });
    var mailLabel = h('label', 'rg-place-mail');
    var mail = h('input');
    mail.type = 'checkbox';
    mail.checked = true;
    mailLabel.appendChild(mail);
    mailLabel.appendChild(document.createTextNode('Email them their team'));
    mailLabel.hidden = !!state.regoMailOff;
    var hide = btn('Hide', 'quiet fixed', function () {
      var regs = picked();
      var want = !regs.every(function (reg) { return reg.hidden; });
      busy(hide, post('/api/console/rego/hide', { ids: regs.map(function (reg) { return reg.id; }), hidden: want })).then(function (r) {
        if (!done(r, function () { return (want ? 'Hid ' : 'Showed ') + r.count + (r.count === 1 ? ' signup' : ' signups'); })) return;
        state.regoPick = {};
        loadRego();
      }).catch(function () {});
    });
    [count, name, make, into, add, hide, mailLabel].forEach(function (n) { bar.appendChild(n); });
    box.appendChild(bar);

    function picked() { return solos.filter(function (reg) { return state.regoPick[reg.id]; }); }
    function sync() {
      var n = 0;
      picked().forEach(function (reg) { n += reg.members.length; });
      count.textContent = n ? n + (n === 1 ? ' person picked' : ' people picked') : 'Nobody picked';
      var keep = into.value;
      into.textContent = '';
      var none = h('option', null, 'Add to a team with room');
      none.value = '';
      into.appendChild(none);
      state.rego.filter(function (reg) { return !reg.solo && reg.team_id && reg.members.length + Math.max(n, 1) <= state.regoMax; })
        .sort(function (a, b) { return a.team_name.toLowerCase() < b.team_name.toLowerCase() ? -1 : 1; })
        .forEach(function (reg) {
          var o = h('option', null, reg.team_name + ' (' + reg.members.length + ' of ' + state.regoMax + ')');
          o.value = String(reg.team_id);
          into.appendChild(o);
        });
      into.value = keep;
      if (into.value !== keep) into.value = '';
      make.disabled = add.disabled = hide.disabled = !n;
      hide.textContent = n && picked().every(function (reg) { return reg.hidden; }) ? 'Show' : 'Hide';
    }
    function place(target, button) {
      var ids = picked().map(function (reg) { return reg.id; });
      var mailed = mail.checked && !state.regoMailOff;
      busy(button, post('/api/console/rego/place', Object.assign({ registration_ids: ids, email: mailed }, target))).then(function (r) {
        if (!done(r, function () {
          return (r.created ? 'Made ' : 'Added to ') + r.team + ': ' + r.moved + (r.moved === 1 ? ' person' : ' people') +
            (mailed && !r.email_off ? ', ' + r.emails + ' emailed' : '') + '.' + (r.email_off ? ' Email sending is off, so nobody was emailed.' : '');
        })) return;
        state.regoPick = {};
        state.regoNewTeam = '';
        loadRego();
        refreshTeamsOnly();
      }).catch(function () {});
    }
    sync();
    return box;
  }

  // a team, then its people as branches; Edit opens the fields. A
  // signup without a team carries a tick for placing it (onPick).
  function regoCard(reg, onPick) {
    var card = h('div', 'card rg');
    var head = h('div', 'rg-head');
    if (reg.solo) {
      var pick = h('input');
      pick.type = 'checkbox';
      pick.checked = !!state.regoPick[reg.id];
      pick.setAttribute('aria-label', 'Pick ' + regoNames(reg));
      pick.addEventListener('change', function () {
        if (pick.checked) state.regoPick[reg.id] = true; else delete state.regoPick[reg.id];
        if (onPick) onPick();
      });
      head.appendChild(pick);
    }
    head.appendChild(h('span', 'rg-name', reg.solo ? regoNames(reg) : reg.team_name));
    if (reg.solo && reg.hidden) head.appendChild(h('span', 'muted', '(hidden)'));
    var checkedIn = reg.members.filter(function (m) { return m.checked_in_at; }).length;
    var meta = reg.members.length + (reg.members.length === 1 ? ' person' : ' people');
    var accepted = reg.members.filter(function (m) { return m.terms_at; }).length;
    meta += ' · ' + (accepted === reg.members.length ? 'all accepted the terms' : accepted + ' of ' + reg.members.length + ' accepted the terms');
    if (state.regoCheckinLive) meta += ' · ' + checkedIn + ' checked in';
    meta += ' · ' + fmtTime(reg.submitted_at);
    head.appendChild(h('span', 'rg-meta', meta));
    head.appendChild(h('span', 'grow'));
    // a test signup is hidden on its own row; someone in a team goes with the team
    if (reg.solo) {
      var hideOne = btn(reg.hidden ? 'Show' : 'Hide', 'quiet small', function () {
        var want = !reg.hidden;
        busy(hideOne, post('/api/console/rego/hide', { ids: [reg.id], hidden: want })).then(function (r) {
          if (!done(r, (want ? 'Hid ' : 'Showing ') + regoNames(reg) + (want ? '' : ' again'))) return;
          delete state.regoPick[reg.id];
          loadRego();
        }).catch(function () {});
      });
      head.appendChild(hideOne);
    }
    var edit = btn(state.regoOpen[reg.id] ? 'Close' : 'Edit', 'quiet small', function () {
      state.regoOpen[reg.id] = !state.regoOpen[reg.id];
      renderRego();
    });
    head.appendChild(edit);
    card.appendChild(head);
    if (state.regoOpen[reg.id]) { card.appendChild(takeHeld('rg' + reg.id) || regoEditor(reg)); return card; }
    var tree = h('ul', 'rg-tree');
    reg.members.forEach(function (m) {
      var li = h('li');
      li.appendChild(h('span', 'rg-who', m.name));
      var detail = [m.zid];
      if (m.discord) detail.push('@' + m.discord);
      if (!m.qr_url) detail.push('no QR');
      if (m.email_status && m.email_status !== 'sent') detail.push('email ' + m.email_status);
      li.appendChild(h('span', 'rg-detail', detail.join(' · ')));
      li.appendChild(m.terms_at
        ? h('span', 'rg-in', '✓ terms accepted')
        : h('span', 'rg-todo', 'terms not accepted'));
      li.appendChild(m.photo_ok === 1 ? h('span', 'rg-in', '✓ photos')
        : m.photo_ok === 0 ? h('span', 'rg-todo', 'no photos')
          : h('span', 'rg-out', 'photos not answered'));
      if (state.regoCheckinLive) {
        li.appendChild(m.checked_in_at
          ? h('span', 'rg-in', '✓ checked in ' + fmtTime(m.checked_in_at))
          : h('span', 'rg-out', 'not checked in'));
      }
      tree.appendChild(li);
    });
    card.appendChild(tree);
    return card;
  }
  function regoEditor(reg) {
    var body = h('div', 'rg-body');
    holdOpen(body, 'rg' + reg.id);
    // ---- the team ----
    var grid = h('div', 'rg-grid');
    var name = textInput(reg.team_name, 'Team name');
    var photo = h('select');
    [['1', 'Photos allowed'], ['0', 'No photos']].forEach(function (o) { var opt = h('option', null, o[1]); opt.value = o[0]; photo.appendChild(opt); });
    photo.value = reg.photo_permission ? '1' : '0';
    if (!reg.solo) grid.appendChild(labelled('Team name', name));
    grid.appendChild(labelled('Photo permission on the form', photo));
    body.appendChild(grid);
    var socWrap = h('div');
    socWrap.appendChild(h('p', 'section-title', 'Societies'));
    var socBox = h('div', 'rg-socs');
    var chosen = String(reg.societies || '').split(';').map(function (x) { return x.trim(); });
    var socInputs = [];
    SOCIETY_LIST.forEach(function (soc) {
      var l = h('label'); var c = h('input'); c.type = 'checkbox'; c.checked = chosen.indexOf(soc) !== -1;
      l.appendChild(c); l.appendChild(document.createTextNode(soc)); socBox.appendChild(l); socInputs.push({ soc: soc, input: c });
    });
    socWrap.appendChild(socBox);
    body.appendChild(socWrap);
    var qWrap = h('div');
    qWrap.appendChild(h('p', 'section-title', 'Questions'));
    var questions = h('textarea'); questions.rows = 2; questions.value = reg.questions || ''; questions.placeholder = 'Questions they asked';
    questions.style.width = '100%'; questions.style.boxSizing = 'border-box';
    qWrap.appendChild(questions);
    body.appendChild(qWrap);
    var teamActions = h('div', 'rg-actions');
    var saveTeam = btn('Save team', null, function () {
      busy(saveTeam, post('/api/console/rego/team/save', {
        id: reg.id, team_name: name.value, photo_permission: photo.value === '1', questions: questions.value,
        societies: socInputs.filter(function (x) { return x.input.checked; }).map(function (x) { return x.soc; })
      })).then(function (r) {
        if (done(r, 'Saved ' + (r.team_name || regoNames(reg)) + (r.discord_renamed ? ', Discord role and channel renamed' : ''))) { reload(saveTeam); refreshTeamsOnly(); }
      }).catch(function () {});
    });
    teamActions.appendChild(saveTeam);
    body.appendChild(teamActions);
    // ---- the people ----
    reg.members.forEach(function (m) { body.appendChild(personEditor(reg, m)); });
    var addRow = h('div', 'rg-actions');
    var add = btn('Add a person', 'quiet', function () {
      addRow.parentNode.insertBefore(personEditor(reg, { id: 0, name: '', zid: '', email: '', arc: 0, dietary: '', discord: '', position: reg.members.length + 1 }), addRow);
      add.disabled = true;
    });
    if (reg.members.length >= state.regoMax) add.disabled = true;
    addRow.appendChild(add);
    body.appendChild(addRow);
    return body;
  }
  function personEditor(reg, m) {
    var box = h('div', 'rg-person');
    var top = h('div', 'rg-person-top');
    top.appendChild(h('strong', null, m.id ? '#' + m.position + ' ' + m.name : 'New person'));
    if (m.id) {
      top.appendChild(h('span', 'muted', 'QR ' + (m.qr_url ? 'attached' : 'missing') + ' · email ' + (m.email_status || 'not sent') +
        ' · terms ' + (m.terms_at ? 'accepted ' + fmtTime(m.terms_at) : 'not accepted') +
        ' · photos ' + (m.photo_ok === 1 ? 'yes' : m.photo_ok === 0 ? 'no' : 'not answered')));
      if (m.qr_url) { var a = h('a', null, 'Open QR'); a.href = m.qr_url; a.target = '_blank'; a.rel = 'noopener'; top.appendChild(a); }
      // the worker builds the ticket link; the page only opens it, and
      // nobody without a code has one
      if (m.ticket_url) {
        var tk = h('a', 'rg-ticket', 'Open ticket');
        tk.href = m.ticket_url; tk.target = '_blank'; tk.rel = 'noopener';
        top.appendChild(tk);
      }
      // their own link, to pass on to someone whose email did not
      // arrive; it is copied rather than opened, because opening it
      // puts the accept button in front of the wrong person
      if (m.terms_url && !m.terms_at) {
        top.appendChild(btn('Copy terms link', 'quiet small', function () { copyLink(m.terms_url); }));
      }
    }
    box.appendChild(top);
    var grid = h('div', 'rg-grid');
    var name = textInput(m.name, 'Full name');
    var zid = textInput(m.zid, 'z1234567 (z0000000 if not at UNSW)');
    var email = textInput(m.email, 'Email');
    var discord = textInput(m.discord, 'Discord username');
    var dietary = textInput(m.dietary, 'Dietary');
    var arc = h('select');
    [['1', 'Arc member'], ['0', 'Not an Arc member']].forEach(function (o) { var opt = h('option', null, o[1]); opt.value = o[0]; arc.appendChild(opt); });
    arc.value = m.arc ? '1' : '0';
    grid.appendChild(labelled('Name', name)); grid.appendChild(labelled('zID', zid)); grid.appendChild(labelled('Email', email));
    grid.appendChild(labelled('Discord', discord)); grid.appendChild(labelled('Dietary', dietary)); grid.appendChild(labelled('Arc', arc));
    box.appendChild(grid);
    var actions = h('div', 'rg-actions');
    var save = btn(m.id ? 'Save' : state.regoMailOff ? 'Add' : 'Add and send their QR', null, function () {
      busy(save, post('/api/console/rego/person/save', {
        id: m.id || 0, registration_id: reg.id, name: name.value, zid: zid.value, email: email.value,
        discord: discord.value, dietary: dietary.value, arc: arc.value === '1'
      })).then(function (r) {
        if (!done(r, function () { return (m.id ? 'Saved ' : 'Added ') + r.person.name + (m.id ? '' : (r.qr === 'attached' ? ' with their QR' : ', no QR')); })) return;
        // no code means no email went out: ask before one does
        if (r.email_held) askQr(r.person.id, r.person.name, r.qr_note);
        else if (r.qr !== 'attached' && r.qr_note) toast('No QR: ' + r.qr_note, true);
        reload(save);
      }).catch(function () {});
    });
    actions.appendChild(save);
    if (m.id && !m.qr_url) {
      var mint = btn('Create QR code', 'quiet', function () {
        busy(mint, post('/api/console/rego/person/qr', { id: m.id })).then(function (r) {
          if (!done(r, function () { return 'QR code made for ' + r.name; })) return;
          state.regoAsk = null;
          reload(mint);
        }).catch(function () {});
      });
      actions.appendChild(mint);
    }
    if (m.id && m.email) {
      // the code is made first and the email only follows a real one;
      // if it cannot be made, the question comes up instead of a send
      var resend = btn('Send email', 'quiet', function () {
        busy(resend, post('/api/console/rego/email', { id: m.id })).then(function (r) {
          if (r && r.needs_qr) { askQr(m.id, r.name, r.qr_note); letGo(resend); renderRego(); return; }
          if (!done(r, function () { return 'Sent to ' + r.name + (r.qr === 'attached' ? ' with their QR' : ''); })) {
            if (r && r.email_off) reload(resend);
            return;
          }
          state.regoAsk = null;
          reload(resend);
        }).catch(function () {});
      });
      resend.disabled = !!state.regoMailOff;
      actions.appendChild(resend);
    }
    actions.appendChild(h('span', 'grow'));
    // to another team, or out of one; someone with no team is placed
    // from the Without a team box instead
    if (m.id && !reg.solo) {
      var moveHost = h('span', 'inline');
      var move = btn('Move', 'quiet small', function () {
        var to = h('select');
        to.setAttribute('aria-label', 'Move ' + m.name + ' to');
        var pick = h('option', null, 'Move to');
        pick.value = '';
        to.appendChild(pick);
        state.rego.filter(function (r) { return !r.solo && r.team_id && r.team_id !== reg.team_id && r.members.length < state.regoMax; })
          .sort(function (a, b) { return a.team_name.toLowerCase() < b.team_name.toLowerCase() ? -1 : 1; })
          .forEach(function (r) {
            var o = h('option', null, r.team_name + ' (' + r.members.length + ' of ' + state.regoMax + ')');
            o.value = String(r.team_id);
            to.appendChild(o);
          });
        var none = h('option', null, 'No team');
        none.value = '0';
        to.appendChild(none);
        var mailLabel = h('label', 'rg-place-mail');
        var mail = h('input');
        mail.type = 'checkbox';
        mail.checked = true;
        mailLabel.appendChild(mail);
        mailLabel.appendChild(document.createTextNode('Email them their new team'));
        mailLabel.hidden = !!state.regoMailOff;
        to.addEventListener('change', function () { mailLabel.hidden = to.value === '0' || !!state.regoMailOff; });
        var go = btn('Move ' + m.name, 'small', function () {
          if (!to.value) { toast('Pick where to move ' + m.name + '.', true); return; }
          busy(go, post('/api/console/rego/person/move', { id: m.id, team_id: Number(to.value), email: mail.checked && !state.regoMailOff })).then(function (r) {
            if (!done(r, function () {
              return 'Moved ' + r.name + ' from ' + r.from + ' to ' + r.team + (r.emailed ? ', emailed' : '') +
                (r.left ? '' : '. ' + r.from + ' has nobody left on it') + (r.email_off ? '. Email sending is off, so they were not emailed' : '');
            })) return;
            reload(go);
            refreshTeamsOnly();
          }).catch(function () {});
        });
        var back = btn('Cancel', 'quiet small', function () { moveHost.textContent = ''; moveHost.appendChild(move); });
        moveHost.textContent = '';
        [to, mailLabel, go, back].forEach(function (n) { moveHost.appendChild(n); });
        to.focus();
      });
      moveHost.appendChild(move);
      actions.appendChild(moveHost);
    }
    if (m.id) {
      var removeHost = h('span', 'inline');
      var remove = btn('Remove', 'danger small', function () {
        var go = btn('Remove ' + m.name, 'danger small', function () {
          busy(go, post('/api/console/rego/person/delete', { id: m.id })).then(function (r) {
            if (done(r, 'Removed ' + m.name)) reload(go);
          }).catch(function () {});
        });
        var back = btn('Cancel', 'quiet small', function () { removeHost.textContent = ''; removeHost.appendChild(remove); });
        removeHost.textContent = ''; removeHost.appendChild(go); removeHost.appendChild(back);
      });
      removeHost.appendChild(remove);
      actions.appendChild(removeHost);
    } else {
      actions.appendChild(btn('Cancel', 'quiet', function () { letGo(box); box.parentNode.removeChild(box); loadRego(); }));
    }
    box.appendChild(actions);
    if (m.id && state.regoAsk && state.regoAsk.id === m.id) box.appendChild(qrAskPanel(m));
    return box;
  }
  // hold the question until it is answered; it is drawn on the person's
  // own row, so a reload keeps it in place
  function askQr(id, name, note) {
    state.regoAsk = { id: id, name: name, note: note || '' };
  }
  // the QR could not be made, so nothing was emailed: two plain
  // choices, in place, the way the rest of the dashboard confirms
  function qrAskPanel(m) {
    var panel = h('div', 'rg-ask');
    panel.appendChild(h('p', 'rg-ask-head', 'The QR code could not be made, so no email was sent.'));
    if (state.regoAsk.note) panel.appendChild(h('p', 'rg-ask-note', state.regoAsk.note));
    panel.appendChild(h('p', 'rg-ask-line',
      'Send the confirmation email anyway? It will arrive with no ticket link. '
      + 'Leave it unsent and it can go once the code is made.'));
    var row = h('div', 'rg-actions');
    var send = btn('Send the email anyway', null, function () {
      busy(send, post('/api/console/rego/email', { id: m.id, force: true })).then(function (r) {
        state.regoAsk = null;
        done(r, function () { return 'Sent to ' + r.name + (r.sent_without_qr ? ', with no ticket link' : ' with their QR'); });
        reload(send);
      }).catch(function () {});
    });
    send.disabled = !!state.regoMailOff;
    row.appendChild(send);
    row.appendChild(btn('Leave it unsent', 'quiet', function () { state.regoAsk = null; panel.remove(); }));
    panel.appendChild(row);
    return panel;
  }
  el('rego-filter').addEventListener('input', renderRego);
  // a whole team from here: name plus the first person; more people
  // are added on the card afterwards
  el('rego-new').addEventListener('click', function () {
    var list = el('rego-list');
    var card = h('div', 'card rg');
    var body = h('div', 'rg-body');
    body.appendChild(h('h3', null, 'New team'));
    var grid = h('div', 'rg-grid');
    var team = textInput('', 'Team name');
    var name = textInput('', 'First person: full name');
    var zid = textInput('', 'zID');
    var email = textInput('', 'Email');
    var discord = textInput('', 'Discord username');
    grid.appendChild(labelled('Team name', team)); grid.appendChild(labelled('Name', name)); grid.appendChild(labelled('zID', zid));
    grid.appendChild(labelled('Email', email)); grid.appendChild(labelled('Discord', discord));
    body.appendChild(grid);
    var actions = h('div', 'rg-actions');
    var go = btn('Register the team', null, function () {
      busy(go, post('/api/console/rego/team/create', {
        team_name: team.value, members: [{ name: name.value, zid: zid.value, email: email.value, discord: discord.value }]
      })).then(function (r) {
        if (done(r, 'Registered ' + r.team + (r.qrs ? ' with a QR' : '') + (r.emails ? ', email sent' : ''))) {
          state.regoOpen[r.registration_id] = true; reload(card); refreshTeamsOnly();
        }
      }).catch(function () {});
    });
    actions.appendChild(go);
    actions.appendChild(btn('Cancel', 'quiet', function () { card.remove(); }));
    body.appendChild(actions);
    card.appendChild(body);
    holdOpen(card, 'new');
    list.insertBefore(card, list.firstChild);
    team.focus();
  });
  el('rego-export').addEventListener('click', function () {
    fetch('/api/console/rego/csv', { headers: { authorization: 'Bearer ' + session() } })
      .then(function (r) {
        if (r.status === 401) { setSession(''); show(false); throw new Error('signed out'); }
        return r.blob();
      })
      .then(function (blob) {
        var a = h('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'scs2-registrations.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
      }).catch(function () {});
  });
  el('rego-resync').addEventListener('click', function () {
    busy(el('rego-resync'), post('/api/console/rego/resync')).then(function (r) {
      done(r, 'Sheet rewritten with ' + r.rows + ' rows');
    }).catch(function () {});
  });
})(window.dash);
