// Payphones, on the Quests tab: the quest scored by calls from
// payphones. Its settings, the numbers that have called, each team's
// PIN and the last calls.
(function (dash) {
  // core.js
  var api = dash.api, armed = dash.armed, btn = dash.btn, busy = dash.busy, done = dash.done, el = dash.el, field = dash.field,
    fmtTime = dash.fmtTime, h = dash.h, post = dash.post, row = dash.row, session = dash.session, state = dash.state,
    textInput = dash.textInput, toast = dash.toast;

  var RESULTS = {
    captured: 'Captured', already: 'Already had it', waiting: 'Waiting on the payphone', capped: 'Captured, past the most',
    registered: 'Registered by an organiser', message: 'Left a message', bad_pin: 'Wrong PIN', locked: 'Too many wrong PINs', 'private': 'Number withheld',
    mobile: 'From a mobile', not_payphone: 'Not a payphone', closed: 'Captures were off', error: 'Went wrong'
  };
  var STATES = [['new', 'Not checked'], ['ok', 'Payphone'], ['no', 'Not a payphone']];
  var KINDS = [['capture', 'Capture a payphone'], ['menu', 'Menu'], ['record', 'Record a message'], ['say', 'Say something']];
  var data = null;
  // the tree as it is being edited: [{id, kind, say, next, keys, max, pin}]
  var steps = null;
  var startAt = '';

  el('quest-phones-toggle').addEventListener('click', function () {
    var box = el('quest-phones');
    box.classList.toggle('hidden');
    el('quest-phones-toggle').textContent = box.classList.contains('hidden') ? 'Payphones' : 'Close payphones';
    if (!box.classList.contains('hidden')) load();
  });

  function load() {
    return api('/api/console/phone').then(function (d) {
      if (d && d.ok) { data = d; render(); }
    }).catch(function () {});
  }
  function took(r, said) {
    if (done(r, said)) { data = r; render(); }
  }

  // ---- the phone tree ----
  function stepsOf(tree) {
    return Object.keys(tree.nodes).map(function (id) {
      var n = tree.nodes[id];
      var keys = Object.keys(n.options || {}).map(function (k) { return k + '=' + n.options[k]; }).join(' ');
      return { id: id, kind: n.kind, say: n.say || '', next: n.next || '', keys: keys, max: n.max || 60, pin: !!n.pin };
    });
  }
  function treeOf() {
    var nodes = {};
    steps.forEach(function (s) {
      var n = { kind: s.kind, say: s.say };
      if (s.kind !== 'menu' && s.next) n.next = s.next;
      if (s.kind === 'menu') {
        n.options = {};
        s.keys.split(/[\s,]+/).forEach(function (pair) {
          var at = pair.indexOf('=');
          if (at > 0) n.options[pair.slice(0, at)] = pair.slice(at + 1);
        });
      }
      if (s.kind === 'record') { n.max = Number(s.max) || 60; n.pin = !!s.pin; }
      nodes[s.id] = n;
    });
    return { start: startAt, nodes: nodes };
  }
  function drawTree(box) {
    if (!steps) { steps = stepsOf(data.tree); startAt = data.tree.start; }
    box.appendChild(h('h4', null, 'What a call hears'));
    box.appendChild(h('p', 'note', 'A saved change is heard by the next call. A menu’s keys are written as key=step, like 1=capture 2=message.'));
    var first = h('select');
    steps.forEach(function (s) { first.appendChild(new Option(s.id, s.id)); });
    first.value = startAt;
    first.addEventListener('change', function () { startAt = first.value; });
    var top = h('div', 'row-form');
    top.appendChild(field('A call starts at', first));
    box.appendChild(top);

    steps.forEach(function (s, i) {
      var card = h('div', 'phone-step');
      var line = h('div', 'row-form');
      var name = textInput(s.id, 'step-name', true);
      name.addEventListener('change', function () {
        var to = name.value.trim().toLowerCase();
        if (!to || to === s.id) { name.value = s.id; return; }
        // the steps that named it follow the new name
        steps.forEach(function (o) {
          if (o.next === s.id) o.next = to;
          o.keys = o.keys.split(/\s+/).map(function (pair) {
            var eq = pair.indexOf('=');
            return eq > 0 && pair.slice(eq + 1) === s.id ? pair.slice(0, eq + 1) + to : pair;
          }).join(' ');
        });
        if (startAt === s.id) startAt = to;
        s.id = to;
        redraw();
      });
      var kind = h('select');
      KINDS.forEach(function (k) { kind.appendChild(new Option(k[1], k[0])); });
      kind.value = s.kind;
      kind.addEventListener('change', function () { s.kind = kind.value; redraw(); });
      line.appendChild(field('Step', name));
      line.appendChild(field('It does', kind));
      line.appendChild(btn('Remove', 'quiet small fixed', function () { steps.splice(i, 1); redraw(); }));
      card.appendChild(line);
      var words = h('textarea');
      words.rows = 2;
      words.value = s.say;
      words.placeholder = s.kind === 'capture' ? 'Asks for the team’s PIN. Leave empty for the usual words.' : 'What the voice says';
      words.addEventListener('input', function () { s.say = words.value; });
      card.appendChild(field('Words', words));
      var more = h('div', 'row-form');
      if (s.kind === 'menu') {
        var keys = textInput(s.keys, '1=capture 2=message');
        keys.addEventListener('input', function () { s.keys = keys.value.trim(); });
        more.appendChild(field('Keys', keys));
      } else {
        var next = h('select');
        next.appendChild(new Option('End the call', ''));
        steps.forEach(function (o) { if (o !== s) next.appendChild(new Option(o.id, o.id)); });
        next.value = s.next;
        next.addEventListener('change', function () { s.next = next.value; });
        more.appendChild(field('Then', next));
      }
      if (s.kind === 'record') {
        var max = h('input'); max.type = 'number'; max.min = '5'; max.max = '120'; max.value = String(s.max);
        max.addEventListener('input', function () { s.max = Number(max.value) || 60; });
        more.appendChild(field('Seconds at most', max));
        var pin = h('input'); pin.type = 'checkbox'; pin.checked = s.pin;
        pin.addEventListener('change', function () { s.pin = pin.checked; });
        var pinLabel = h('label', 'check-inline'); pinLabel.appendChild(pin); pinLabel.appendChild(document.createTextNode(' Ask for the team’s PIN first'));
        more.appendChild(pinLabel);
      }
      card.appendChild(more);
      box.appendChild(card);
    });

    var foot = h('div', 'row-form');
    foot.appendChild(btn('Add a step', 'quiet fixed', function () {
      var n = 1;
      while (steps.some(function (s) { return s.id === 'step-' + n; })) n++;
      steps.push({ id: 'step-' + n, kind: 'say', say: '', next: '', keys: '', max: 60, pin: false });
      redraw();
    }));
    var save = btn('Save what a call hears', 'primary fixed', function () {
      busy(save, post('/api/console/phone/tree', { tree: treeOf() })).then(function (r) { if (r && r.ok) steps = null; took(r, 'Saved. The next call hears it.'); }).catch(function () {});
    });
    foot.appendChild(save);
    if (!data.tree_default) {
      foot.appendChild(armed('Put back the one capture step', 'Put it back', function (go) {
        busy(go, post('/api/console/phone/tree', { reset: true })).then(function (r) { if (r && r.ok) steps = null; took(r, 'Put back.'); }).catch(function () {});
      }));
    }
    box.appendChild(foot);
  }
  function redraw() { render(); }

  // ---- messages ----
  var audioUrls = [];
  function dropAudioUrls() {
    audioUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    audioUrls = [];
  }
  function length(seconds) {
    var s = Math.max(0, Number(seconds) || 0);
    return Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }
  function play(m, host, button) {
    button.disabled = true;
    fetch('/api/console/phone/message?id=' + m.id, { headers: { authorization: 'Bearer ' + session() } }).then(function (r) {
      if (!r.ok) throw new Error('audio ' + r.status);
      return r.blob();
    }).then(function (blob) {
      var audio = h('audio');
      audio.controls = true;
      var u = URL.createObjectURL(blob);
      audioUrls.push(u);
      audio.src = u;
      host.textContent = '';
      host.appendChild(audio);
      var p = audio.play();
      if (p && p.catch) p.catch(function () { /* the controls are there */ });
      if (!m.heard) post('/api/console/phone/message/heard', { id: m.id, heard: true }).then(function (r) { if (r && r.ok) { data = r; m.heard = 1; } }).catch(function () {});
    }).catch(function () {
      button.disabled = false;
      toast('The message could not be loaded.', true);
    });
  }
  function drawMessages(box) {
    box.appendChild(h('h4', null, 'Messages'));
    if (!data.messages.length) { box.appendChild(h('p', 'note', 'Nobody has left a message.')); return; }
    var table = h('table');
    var head = h('thead');
    head.appendChild(row([h('th', null, 'Left'), h('th', null, 'Team'), h('th', null, 'From'), h('th', null, 'Length'), h('th', null, ''), h('th', null, '')]));
    table.appendChild(head);
    var body = h('tbody');
    data.messages.forEach(function (m) {
      var host = h('td');
      var go = btn(m.heard ? 'Play' : 'Play (new)', 'small', function () { play(m, host, go); });
      host.appendChild(go);
      var gone = h('td');
      gone.appendChild(armed('Delete', 'Delete the message', function (b) {
        busy(b, post('/api/console/phone/message/delete', { id: m.id })).then(function (r) { took(r, 'Deleted.'); }).catch(function () {});
      }));
      body.appendChild(row([cell(fmtTime(m.at)), cell(m.team || 'Not a team'), cell(m.payphone), cell(length(m.seconds)), host, gone]));
    });
    table.appendChild(body);
    box.appendChild(table);
  }
  function cell(text, cls) { return h('td', cls || null, text == null ? '' : String(text)); }

  function render() {
    dropAudioUrls();
    var box = el('quest-phones');
    box.textContent = '';
    box.appendChild(h('h3', null, 'Payphones'));
    var set = data.settings;

    // ---- settings ----
    var code = h('select');
    code.appendChild(new Option('No code picked', ''));
    (state.quests || []).forEach(function (q) { code.appendChild(new Option(q.code, q.code)); });
    code.value = set.code;
    if (set.code && code.value !== set.code) { code.appendChild(new Option(set.code + ' (not on the tab)', set.code)); code.value = set.code; }
    var number = textInput(set.number, '02 9385 0000');
    var form = h('div', 'row-form');
    form.appendChild(field('Each capture credits', code));
    form.appendChild(field('Number teams call', number));
    var save = btn('Save', 'fixed', function () {
      busy(save, post('/api/console/phone/settings', { code: code.value, number: number.value.trim() })).then(function (r) { took(r, 'Saved.'); }).catch(function () {});
    });
    form.appendChild(save);
    box.appendChild(form);
    if (data.code_missing) box.appendChild(h('p', 'error', set.code + ' is not on the tab any more, so no call counts. Pick the code again.'));

    var open = h('input'); open.type = 'checkbox'; open.checked = !!set.open;
    dash.savesAtOnce(open, function (want) {
      return post('/api/console/phone/settings', { open: want }).then(function (r) {
        took(r, want ? 'Captures count.' : 'Captures are off.');
        return !!(r && r.ok);
      });
    });
    var openLabel = h('label', 'check-inline'); openLabel.appendChild(open); openLabel.appendChild(document.createTextNode(' Count captures'));
    var line = h('div', 'row-form');
    line.appendChild(openLabel);
    line.appendChild(h('span', 'muted', set.staff_pin ? 'Organiser PIN ' + set.staff_pin + ': keyed in at a payphone, it registers that phone.' : 'No organiser PIN yet.'));
    var mint = btn(set.staff_pin ? 'New organiser PIN' : 'Make an organiser PIN', 'quiet small fixed', function () {
      busy(mint, post('/api/console/phone/settings', { staff_pin: true })).then(function (r) { took(r, 'New organiser PIN.'); }).catch(function () {});
    });
    line.appendChild(mint);
    box.appendChild(line);

    drawTree(box);
    drawMessages(box);

    // ---- the numbers ----
    box.appendChild(h('h4', null, 'Numbers that have called'));
    var add = h('div', 'row-form');
    var addNumber = textInput('', 'A payphone’s number, with its area code');
    var addName = textInput('', 'Where it is');
    var addBtn = btn('Add a payphone', 'fixed', function () {
      busy(addBtn, post('/api/console/phone/payphone', { number: addNumber.value.trim(), name: addName.value.trim() })).then(function (r) { took(r, 'Added.'); }).catch(function () {});
    });
    add.appendChild(addNumber); add.appendChild(addName); add.appendChild(addBtn);
    box.appendChild(add);
    if (!data.payphones.length) {
      box.appendChild(h('p', 'note', 'No number has called yet.'));
    } else {
      var table = h('table');
      var head = h('thead');
      head.appendChild(row([h('th', null, 'Number'), h('th', null, 'Where it is'), h('th', null, 'Teams'), h('th', null, ''), h('th', null, '')]));
      table.appendChild(head);
      var body = h('tbody');
      data.payphones.forEach(function (p) {
        var name = textInput(p.name, 'Where it is');
        var pick = h('select');
        STATES.forEach(function (s) { pick.appendChild(new Option(s[1], s[0])); });
        pick.value = p.state;
        var keep = btn('Save', 'small', function () {
          busy(keep, post('/api/console/phone/payphone', { id: p.id, name: name.value.trim(), state: pick.value })).then(function (r) {
            took(r, r && r.recorded ? r.recorded + (r.recorded === 1 ? ' capture recorded.' : ' captures recorded.') : 'Saved.');
          }).catch(function () {});
        });
        var nameCell = h('td'); nameCell.appendChild(name);
        var pickCell = h('td'); pickCell.appendChild(pick);
        var keepCell = h('td'); keepCell.appendChild(keep);
        var teams = p.teams + (p.waiting ? ' (' + p.waiting + ' waiting)' : '');
        body.appendChild(row([cell(p.number, 'mono'), nameCell, cell(teams), pickCell, keepCell]));
      });
      table.appendChild(body);
      box.appendChild(table);
    }

    // ---- PINs ----
    box.appendChild(h('h4', null, 'Team PINs'));
    var pins = h('table');
    var pinHead = h('thead');
    pinHead.appendChild(row([h('th', null, 'Team'), h('th', null, 'PIN'), h('th', null, 'Payphones'), h('th', null, '')]));
    pins.appendChild(pinHead);
    var pinBody = h('tbody');
    data.teams.forEach(function (t) {
      var fresh = btn(t.pin ? 'New PIN' : 'Make a PIN', 'quiet small', function () {
        busy(fresh, post('/api/console/phone/pin', { team_id: t.id })).then(function (r) { took(r, 'New PIN for ' + t.name + '.'); }).catch(function () {});
      });
      var freshCell = h('td'); freshCell.appendChild(fresh);
      pinBody.appendChild(row([cell(t.name + (t.hidden ? ' (hidden)' : '')), cell(t.pin || 'none yet', 'mono'), cell(t.captures), freshCell]));
    });
    pins.appendChild(pinBody);
    box.appendChild(pins);

    // ---- calls ----
    box.appendChild(h('h4', null, 'Last calls'));
    if (!data.calls.length) {
      box.appendChild(h('p', 'note', 'No calls yet.'));
    } else {
      var calls = h('table');
      var callBody = h('tbody');
      data.calls.forEach(function (c) {
        callBody.appendChild(row([cell(fmtTime(c.at)), cell(RESULTS[c.result] || c.result), cell(c.team), cell(c.payphone)]));
      });
      calls.appendChild(callBody);
      box.appendChild(calls);
    }
  }
})(window.dash);
