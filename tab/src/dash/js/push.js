// The Push tab: a notification to everyone, one team or one device, and the devices.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, busy = dash.busy, digits = dash.digits, done = dash.done, el = dash.el,
    emptyRow = dash.emptyRow, fill = dash.fill, fmtTime = dash.fmtTime, h = dash.h, post = dash.post,
    row = dash.row, shake = dash.shake, state = dash.state, teamShown = dash.teamShown, toast = dash.toast;

  dash.loadPush = loadPush;

  // ---- push ----
  state.devices = [];

  function loadPush() {
    api('/api/console/push/stats').then(function (d) {
      if (!d.ok) return;
      paintPush(d);
    }).catch(function () {});
  }

  function paintPush(d) {
    var line = el('push-count');
    line.textContent = '';
    var num = h('span', 't-digit-group');
    line.appendChild(num);
    digits(num, d.subscribers);
    line.appendChild(h('span', null, ' device' + (d.subscribers === 1 ? '' : 's') + ' subscribed'));
    state.devices = d.devices || [];
    paintDevices();
    fillPushPickers();
    paintPushTarget();
  }

  function deviceName(v) {
    return v.label || v.service + ' device';
  }

  function paintDevices() {
    var rows = state.devices;
    fill(el('push-devices'), rows.length ? rows.map(function (v) {
      var name = h('td');
      var box = h('input');
      box.type = 'text';
      box.maxLength = 40;
      box.value = v.label;
      box.placeholder = v.service + ' device';
      box.setAttribute('aria-label', 'Device name');
      name.appendChild(box);

      var actions = h('td', 'num');
      var wrap = h('span', 'inline');
      var save = btn('Save', 'quiet small', function () {
        busy(save, post('/api/console/push/name', { id: v.id, label: box.value })).then(function (r) {
          if (done(r, 'Saved')) paintPush(r);
        }).catch(function () {});
      });
      box.addEventListener('keydown', function (e) { if (e.key === 'Enter') save.click(); });
      wrap.appendChild(save);
      wrap.appendChild(btn('Send here', 'quiet small', function () {
        el('push-target').value = 'device';
        el('push-device').value = String(v.id);
        paintPushTarget();
        el('push-title').focus();
      }));
      actions.appendChild(wrap);

      return row([
        name,
        h('td', null, v.service),
        h('td', v.team_name ? null : 'muted', v.team_name || 'not linked to a team'),
        h('td', null, fmtTime(v.created_at)),
        actions
      ]);
    }) : [emptyRow('Nobody has turned notifications on yet.', 5)]);
  }

  // ---- who a push goes to ----
  function fillPushPickers() {
    var teams = el('push-team');
    var heldTeam = teams.value;
    teams.textContent = '';
    state.teams.filter(teamShown).forEach(function (t) {
      var opt = h('option', null, t.name);
      opt.value = String(t.id);
      teams.appendChild(opt);
    });
    if (heldTeam) teams.value = heldTeam;
    if (teams.selectedIndex === -1 && teams.options.length) teams.selectedIndex = 0;

    var devices = el('push-device');
    var heldDevice = devices.value;
    devices.textContent = '';
    state.devices.forEach(function (v) {
      var opt = h('option', null, deviceName(v) + (v.team_name ? ' — ' + v.team_name : ''));
      opt.value = String(v.id);
      devices.appendChild(opt);
    });
    if (heldDevice) devices.value = heldDevice;
    if (devices.selectedIndex === -1 && devices.options.length) devices.selectedIndex = 0;
  }

  function pushAim() {
    var kind = el('push-target').value;
    return kind === 'team' || kind === 'device' ? kind : 'all';
  }
  function pushAimText() {
    var kind = pushAim();
    if (kind === 'team') {
      var picked = el('push-team');
      var teamOpt = picked.options[picked.selectedIndex];
      return teamOpt ? teamOpt.textContent : 'a team';
    }
    if (kind === 'device') {
      var device = el('push-device');
      var devOpt = device.options[device.selectedIndex];
      return devOpt ? devOpt.textContent : 'a device';
    }
    return 'everyone';
  }
  // Every repaint disarms the button: it is called whenever the target,
  // the team, the device or the lists under them change, and an armed
  // button may only send to the audience its confirmation named.
  function paintPushTarget() {
    var kind = pushAim();
    clearTimeout(armTimer);
    el('push-send').classList.remove('is-armed');
    el('push-team').classList.toggle('hidden', kind !== 'team');
    el('push-device').classList.toggle('hidden', kind !== 'device');
    el('push-send').textContent = 'Send to ' + pushAimText();
  }
  el('push-target').addEventListener('change', paintPushTarget);
  el('push-team').addEventListener('change', paintPushTarget);
  el('push-device').addEventListener('change', paintPushTarget);
  // first click arms the button, second click sends — no dialog
  var armTimer = null;
  el('push-send').addEventListener('click', function () {
    var send = el('push-send');
    var title = el('push-title').value.trim();
    var message = el('push-body').value.trim();
    if (!title || !message) { toast('A title and a message are both needed.', true); return; }
    var aim = pushAim();
    var who = pushAimText();
    if (aim === 'team' && !el('push-team').value) { shake(el('push-team')); return; }
    if (aim === 'device' && !el('push-device').value) { shake(el('push-device')); return; }
    if (!send.classList.contains('is-armed')) {
      send.classList.add('is-armed');
      send.textContent = 'Confirm: send to ' + who;
      clearTimeout(armTimer);
      armTimer = setTimeout(function () { send.classList.remove('is-armed'); paintPushTarget(); }, 5000);
      return;
    }
    clearTimeout(armTimer);
    send.classList.remove('is-armed');
    paintPushTarget();
    var status = el('push-status');
    status.textContent = '';
    send.disabled = true;
    var target = { kind: aim };
    if (aim === 'team') target.team_id = Number(el('push-team').value);
    if (aim === 'device') target.sub_id = Number(el('push-device').value);
    // a send to everyone answers with the first batch; the worker sends
    // the rest from its outbox whether or not this tab stays open
    post('/api/console/push/send', {
      title: title, body: message,
      url: el('push-url').value.trim(), kind: el('push-kind').value,
      target: target
    }).then(function (r) {
      if (!done(r)) { status.textContent = ''; return; }
      var total = r.sent;
      var gone = r.dead;
      status.textContent = 'Sent to ' + total + ' device' + (total === 1 ? '' : 's') +
        (aim === 'all' ? '.' : ' (' + who + ').') +
        (r.queued && r.remaining > 0 ? ' The other ' + r.remaining + ' go out over the next few minutes.' : '') +
        (gone ? ' Removed ' + gone + ' dead subscription' + (gone === 1 ? '' : 's') + '.' : '');
      toast(status.textContent);
      // a test send to one device is a draft you are about to send
      // again: clearing the boxes would mean retyping the whole thing
      if (aim === 'all') {
        el('push-title').value = ''; el('push-body').value = ''; el('push-url').value = '';
      }
      loadPush();
    }).catch(function () {}).then(function () { send.disabled = false; });
  });
})(window.dash);
