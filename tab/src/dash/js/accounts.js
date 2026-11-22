// The Accounts tab: every organiser's account, the editor, and the
// second password's switches.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, busy = dash.busy, chip = dash.chip, done = dash.done, el = dash.el,
    fill = dash.fill, fmtTime = dash.fmtTime, h = dash.h, post = dash.post, row = dash.row,
    shake = dash.shake, state = dash.state, toast = dash.toast, whoAmI = dash.whoAmI;
  // tabs.js
  var loadMe = dash.loadMe, restoreTab = dash.restoreTab;

  dash.loadAccounts = loadAccounts;

  // ---- accounts ----
  // Who can sign in, which tabs each may use, and whether each needs a
  // code from an authenticator app. Admins only, and the worker says no
  // to anybody else whatever this page does. The sign-in attempts are
  // their own table rather than rows in the log: the log is a scoring
  // audit read by the hour, and a run of refused codes at 3am is a
  // different question asked in a hurry.
  var OUTCOMES = {
    ok: 'Signed in', 'bad-password': 'Wrong name or password', 'bad-code': 'Wrong code',
    'bad-enrol': 'Wrong enrolment password', throttled: 'Turned away, too many tries',
    'enrol-started': 'Shown a code to set up', reset: 'Code reset', 'bad-human': 'Failed the person check',
    'no-setup': 'Has no code and no password of its own', trying: 'Being checked'
  };
  var TAB_NAMES = { scores: 'Scores', points: 'Desk', review: 'Queue', map: 'Map', routes: 'Routes', quests: 'Quests', teams: 'Teams', messages: 'Messages',
    push: 'Push', email: 'Email', rego: 'Rego', files: 'Files', discord: 'Discord', settings: 'Settings', log: 'Log' };
  state.accounts = null;
  state.accEditing = null;   // the account in the editor, '' for a new one
  state.accPicks = null;     // the tabs ticked before Admin was

  (function buildPicks() {
    var box = el('acc-perms');
    Object.keys(TAB_NAMES).forEach(function (p) {
      var label = h('label');
      var input = h('input');
      input.type = 'checkbox';
      input.value = p;
      label.appendChild(input);
      label.appendChild(document.createTextNode(TAB_NAMES[p]));
      box.appendChild(label);
    });
  })();
  function permBoxes() { return Array.prototype.slice.call(el('acc-perms').querySelectorAll('input')); }
  function accountByName(name) {
    return ((state.accounts && state.accounts.users) || []).filter(function (u) { return u.name === name; })[0] || null;
  }

  function codeText(u) {
    if (!u.require_2fa) return 'Not needed';
    if (u.confirmed_at) return 'Set up · ' + u.codes_left + ' backup left';
    return u.own_password ? 'Set up at next sign-in' : 'Needs a password of its own first';
  }

  function loadAccounts() {
    api('/api/console/accounts').then(paintAccounts).catch(function () {});
  }
  function paintAccounts(d) {
    if (!d || !d.ok) return;
    state.accounts = d;
    var me = whoAmI();
    fill(el('acc-rows'), d.users.map(function (u) {
      var act = h('td', 'actions');
      act.appendChild(btn('Edit', 'quiet small', function () { openAccount(u); }));
      return row([
        h('td', null, u.name + (u.name === me ? ' (you)' : '')),
        h('td', null, u.admin ? 'Admin' : u.perms.map(function (p) { return TAB_NAMES[p] || p; }).join(', ') +
          (u.quests && u.quests.length ? ' · ' + u.quests.join(', ') + ' only' : '')),
        h('td', 'muted', u.own_password ? 'Its own' : 'Shared'),
        h('td', 'muted', codeText(u)),
        h('td', 'muted', u.last_seen ? fmtTime(u.last_seen, true) : 'Never'),
        act
      ]);
    }));
    var mine = accountByName(me);
    el('auth-backup-new').classList.toggle('hidden', !(mine && mine.require_2fa && mine.confirmed_at));

    var guardBox = el('guard-rows');
    guardBox.textContent = '';
    d.guards.forEach(function (g) {
      var label = h('label');
      var input = h('input');
      input.type = 'checkbox';
      input.checked = !!g.on;
      input.addEventListener('change', function () {
        var want = input.checked;
        input.disabled = true;
        post('/api/console/guards/set', { key: g.key, on: want }).then(function (r) {
          input.disabled = false;
          if (!done(r, g.label + (want ? ' now asks for the second password' : ' no longer asks for the second password'))) {
            input.checked = !want;
            return;
          }
          paintAccounts(r);
        }).catch(function () { input.disabled = false; input.checked = !want; });
      });
      label.appendChild(input);
      label.appendChild(document.createTextNode(g.label));
      guardBox.appendChild(label);
    });
    el('guard-sub').textContent = d.second_password
      ? 'Ticked actions ask for it before they go through.'
      : 'The worker has no second password yet. Set PUSH_PASSWORD with npm run secrets, and ticked actions ask for it.';

    fill(el('auth-attempts'), d.attempts.map(function (a) {
      return row([
        h('td', 'muted', fmtTime(a.at, true)),
        h('td', null, a.name || '—'),
        h('td', 'muted', a.ip),
        h('td', a.outcome === 'ok' ? '' : 'danger',
          (OUTCOMES[a.outcome] || a.outcome) + (a.detail ? ' · ' + a.detail : ''))
      ]);
    }));
    el('auth-standing').textContent = d.failed_last_hour + ' refused in the last hour' +
      (d.human_check ? ' · person check on' : '');
  }

  // ---- one account, in the editor ----
  function syncAdmin() {
    var all = el('acc-admin').checked;
    var boxes = permBoxes();
    if (all && !state.accPicks) {
      state.accPicks = boxes.filter(function (i) { return i.checked; }).map(function (i) { return i.value; });
    }
    boxes.forEach(function (i) {
      if (all) i.checked = true;
      else if (state.accPicks) i.checked = state.accPicks.indexOf(i.value) !== -1;
      i.disabled = all;
      i.parentNode.classList.toggle('is-off', all);
    });
    if (!all) state.accPicks = null;
  }
  // The quests an account scores and reviews: every one, or the ones
  // ticked. Drawn from the quest list each time the editor opens, with
  // any key the account holds that is no longer a quest kept on the end.
  function drawQuestPicks(keys) {
    var box = el('acc-quests');
    box.textContent = '';
    var known = [];
    (state.groups || []).forEach(function (g) { known.push({ key: g.key, name: g.name }); });
    (state.loose || []).forEach(function (c) { if (!c.hidden) known.push({ key: c.code, name: c.label || c.code }); });
    keys.forEach(function (k) {
      if (!known.some(function (q) { return q.key === k; })) known.push({ key: k, name: 'no longer a quest' });
    });
    known.forEach(function (q) {
      var label = h('label');
      var input = h('input');
      input.type = 'checkbox';
      input.value = q.key;
      input.checked = keys.indexOf(q.key) !== -1;
      label.appendChild(input);
      label.appendChild(chip(q.key));
      if (q.name && q.name !== q.key) label.appendChild(document.createTextNode(' ' + q.name));
      label.dataset.find = (q.key + ' ' + q.name).toLowerCase();
      box.appendChild(label);
    });
    el('acc-quests-find').value = '';
  }
  el('acc-quests-find').addEventListener('input', function () {
    var term = el('acc-quests-find').value.trim().toLowerCase();
    Array.prototype.forEach.call(el('acc-quests').children, function (label) {
      label.classList.toggle('hidden', !!term && label.dataset.find.indexOf(term) === -1 && !label.querySelector('input').checked);
    });
  });
  function questBoxes() { return Array.prototype.slice.call(el('acc-quests').querySelectorAll('input')); }
  function syncQuests() {
    var admin = el('acc-admin').checked;
    el('acc-quests-box').classList.toggle('hidden', admin);
    el('acc-quests').classList.toggle('hidden', el('acc-all-quests').checked);
    el('acc-quests-find').classList.toggle('hidden', el('acc-all-quests').checked);
  }
  el('acc-all-quests').addEventListener('change', syncQuests);
  el('acc-admin').addEventListener('change', syncQuests);
  function sync2fa() {
    var u = accountByName(state.accEditing);
    el('acc-2fa-hint').classList.toggle('hidden', !el('acc-2fa').checked || !!(u && u.confirmed_at));
  }
  el('acc-admin').addEventListener('change', syncAdmin);
  el('acc-2fa').addEventListener('change', sync2fa);

  function openAccount(u) {
    state.accEditing = u ? u.name : '';
    state.accPicks = null;
    el('acc-edit-title').textContent = u ? u.name : 'New account';
    el('acc-name').value = u ? u.name : '';
    el('acc-name').disabled = !!u;
    el('acc-pass').value = '';
    el('acc-pass').placeholder = !u ? 'At least 10 characters'
      : (u.own_password ? 'Empty keeps it' : 'Empty keeps the shared one');
    el('acc-admin').checked = !!(u && u.admin);
    permBoxes().forEach(function (i) { i.checked = !!(u && !u.admin && u.perms.indexOf(i.value) !== -1); });
    el('acc-2fa').checked = u ? !!u.require_2fa : true;
    var keys = (u && u.quests) || [];
    drawQuestPicks(keys);
    el('acc-all-quests').checked = !keys.length;
    el('acc-save').textContent = u ? 'Save' : 'Create account';
    syncAdmin();
    syncQuests();
    sync2fa();
    dangerButtons(u);
    el('acc-edit').classList.remove('hidden');
    el('acc-edit').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    (u ? el('acc-pass') : el('acc-name')).focus();
  }
  function closeAccount() {
    state.accEditing = null;
    el('acc-edit').classList.add('hidden');
  }
  el('acc-new').addEventListener('click', function () { openAccount(null); });
  el('acc-cancel').addEventListener('click', closeAccount);

  // Resetting a code and deleting an account are each typed out: the
  // name goes in the box before the button does anything.
  function dangerButtons(u) {
    var zone = el('acc-danger');
    zone.textContent = '';
    if (!u || u.name === whoAmI()) return;
    if (u.confirmed_at) {
      zone.appendChild(btn('Reset code', 'danger', function () {
        confirmTyped(u, 'Reset ' + u.name, function () {
          return post('/api/console/auth/reset', { name: u.name }).then(function (r) {
            if (!done(r, u.own_password
              ? 'Reset. ' + u.name + ' sets up a new code next time they sign in.'
              : 'Reset. Give ' + u.name + ' a password of their own so they can set up a new code.')) return;
            closeAccount();
            loadAccounts();
          });
        });
      }));
    }
    zone.appendChild(btn('Delete account', 'danger', function () {
      confirmTyped(u, 'Delete ' + u.name, function () {
        return post('/api/console/accounts/delete', { name: u.name }).then(function (r) {
          if (!done(r, 'Deleted ' + u.name)) return;
          closeAccount();
          paintAccounts(r);
        });
      });
    }));
  }
  function confirmTyped(u, label, go) {
    var zone = el('acc-danger');
    zone.textContent = '';
    var input = h('input');
    input.placeholder = 'Type ' + u.name;
    var yes = btn(label, 'danger', function () {
      if (input.value.trim() !== u.name) { shake(input); return; }
      busy(yes, go()).catch(function () {});
    });
    var no = btn('Cancel', 'quiet', function () { dangerButtons(u); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') yes.click();
      if (e.key === 'Escape') no.click();
    });
    zone.appendChild(input);
    zone.appendChild(yes);
    zone.appendChild(no);
    input.focus();
  }

  el('acc-save').addEventListener('click', function () {
    var creating = state.accEditing === '';
    var body = {
      create: creating,
      name: el('acc-name').value.trim(),
      password: el('acc-pass').value,
      admin: el('acc-admin').checked,
      perms: permBoxes().filter(function (i) { return i.checked; }).map(function (i) { return i.value; }),
      require_2fa: el('acc-2fa').checked,
      quests: el('acc-all-quests').checked ? [] : questBoxes().filter(function (i) { return i.checked; }).map(function (i) { return i.value; }),
      all_quests: el('acc-all-quests').checked
    };
    if (!body.name) { shake(el('acc-name')); el('acc-name').focus(); return; }
    if (!body.admin && !el('acc-all-quests').checked && !body.quests.length) {
      shake(el('acc-quests')); toast('Tick at least one quest, or Every quest.', true); return;
    }
    if ((creating || body.password) && body.password.length < 10) {
      shake(el('acc-pass'));
      toast('A password needs at least 10 characters.', true);
      return;
    }
    if (!body.admin && !body.perms.length) { shake(el('acc-perms')); toast('Tick at least one tab, or Admin.', true); return; }
    busy(el('acc-save'), post('/api/console/accounts/save', body)).then(function (r) {
      if (!done(r, r && r.note ? r.note : (creating ? 'Made an account for ' + body.name : 'Saved ' + body.name))) { shake(el('acc-edit')); return; }
      closeAccount();
      paintAccounts(r);
      // your own account: what you can see may have changed with it
      if (body.name === whoAmI()) loadMe().then(restoreTab);
    }).catch(function () {});
  });

  el('auth-backup-new').addEventListener('click', function () {
    var b = el('auth-backup-new');
    busy(b, post('/api/console/auth/backup', {})).then(function (r) {
      if (!done(r, 'Ten new backup codes. The old ones stopped working.')) return;
      el('backup-list').textContent = r.backup_codes.join('\n');
      el('backup').classList.remove('hidden');
      el('backup').scrollIntoView({ block: 'center' });
      loadAccounts();
    }).catch(function () {});
  });
})(window.dash);
