// The Email tab: an announcement to everyone, one team or a list of
// addresses, and the sends so far.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, busy = dash.busy, can = dash.can, done = dash.done, el = dash.el,
    emptyRow = dash.emptyRow, fill = dash.fill, fmtTime = dash.fmtTime, h = dash.h, post = dash.post,
    row = dash.row, shake = dash.shake, state = dash.state, teamShown = dash.teamShown, toast = dash.toast;
  // markdown.js
  var markdownTools = dash.markdownTools;

  dash.loadAnnounce = loadAnnounce;

  // ---- email announcements ----
  // The worker builds the message and the preview is its HTML in a
  // sandboxed frame, so what is on screen is what arrives. Sending is the
  // push button's two taps; after the first batch the tab asks for the
  // next until the announcement is done, and the worker's scheduled run
  // finishes one this tab was closed on.
  state.ann = { counts: { all: 0, teams: {} }, configured: true, emailOff: false, sends: [], stepping: {} };
  el('ann-tools').appendChild(markdownTools(el('ann-body'), null));

  // Email sending switched off on the Settings tab: a line at the top for
  // as long as it is, Send and the test off, an announcement part way out
  // shown as paused, and a pop-up each time the tab is opened.
  function paintAnnOff() {
    el('ann-mail-off').classList.toggle('hidden', !state.ann.emailOff);
    el('ann-mail-off-go').classList.toggle('hidden', !can('settings'));
  }
  // a send the worker refused because email is off
  function refusedOff(r) {
    if (!r || !r.email_off) return;
    state.ann.emailOff = true;
    paintAnnOff();
    paintAnnTarget();
    paintAnnRows();
  }
  function askAnnOff() {
    var settings = can('settings');
    el('email-off-text').textContent = settings
      ? 'Nothing can be sent from this tab until it is turned back on in Settings.'
      : 'Nothing can be sent from this tab until someone with the Settings tab turns it back on.';
    el('email-off-go').classList.toggle('hidden', !settings);
    el('email-off').classList.remove('hidden');
    el(settings ? 'email-off-go' : 'email-off-close').focus();
  }
  function closeAnnOff() { el('email-off').classList.add('hidden'); }
  // Go to Settings is a data-anchor link as well: tabs.js opens the card
  el('email-off-go').addEventListener('click', closeAnnOff);
  el('email-off-close').addEventListener('click', closeAnnOff);
  el('email-off').addEventListener('click', function (e) { if (e.target === el('email-off')) closeAnnOff(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && !el('email-off').classList.contains('hidden')) closeAnnOff();
  });

  function annDraft() {
    return { subject: el('ann-subject').value.trim(), format: el('ann-format').value, body: el('ann-body').value,
      footer: el('ann-footer').value, reply_to: el('ann-reply').value.trim() };
  }
  // Where replies go starts as the worker's own address and, once
  // changed, as whatever was last typed on this device.
  var REPLY_KEY = 'scs2-dashboard-ann-reply';
  function fillAnnReply(fallback) {
    var box = el('ann-reply');
    if (box.dataset.filled) return;
    var kept = null;
    try { kept = localStorage.getItem(REPLY_KEY); } catch (e) { /* not kept */ }
    box.value = kept || fallback || '';
    box.placeholder = fallback || '';
    box.dataset.filled = '1';
  }
  el('ann-reply').addEventListener('input', function () {
    try { localStorage.setItem(REPLY_KEY, el('ann-reply').value.trim()); } catch (e) { /* not kept */ }
    el('ann-reply').dataset.filled = '1';
  });
  // The line at the bottom starts as the worker's default and, once
  // changed, as whatever was last typed on this device; emptied, the
  // email has no line there.
  var FOOTER_KEY = 'scs2-dashboard-ann-footer';
  function fillAnnFooter(fallback) {
    var box = el('ann-footer');
    if (box.dataset.filled) return;
    var kept = null;
    try { kept = localStorage.getItem(FOOTER_KEY); } catch (e) { /* not kept */ }
    box.value = kept !== null ? kept : (fallback || '');
    box.dataset.filled = '1';
  }
  el('ann-footer').addEventListener('input', function () {
    try { localStorage.setItem(FOOTER_KEY, el('ann-footer').value); } catch (e) { /* not kept */ }
    el('ann-footer').dataset.filled = '1';
    annPreview();
  });
  function annAim() {
    var v = el('ann-target').value;
    return v === 'team' || v === 'list' ? v : 'all';
  }
  // The typed or pasted box read the way the worker reads it
  // (pastedAddresses in announce.js): every piece that is an address,
  // once each, and the pieces with an @ that are not.
  function annAddr(piece) {
    var e = piece.replace(/^mailto:/i, '').toLowerCase();
    var at = e.indexOf('@');
    if (e.length > 120 || at < 1 || at !== e.lastIndexOf('@')) return '';
    if (e.indexOf(':') !== -1 || e.indexOf(String.fromCharCode(92)) !== -1) return '';
    var dot = e.slice(at + 1).indexOf('.');
    return dot > 0 && dot < e.length - at - 2 ? e : '';
  }
  function annList() {
    var seen = {};
    var out = { emails: [], bad: [] };
    el('ann-list').value.split(/[\s,;<>()"'\[\]]+/).forEach(function (piece) {
      if (!piece) return;
      var e = annAddr(piece);
      if (e) {
        if (!seen[e]) { seen[e] = true; out.emails.push(e); }
        return;
      }
      if (piece.indexOf('@') !== -1) out.bad.push(piece);
    });
    return out;
  }
  function addresses(n) { return n + (n === 1 ? ' address' : ' addresses'); }
  function annReach() {
    if (annAim() === 'team') return state.ann.counts.teams[el('ann-team').value] || 0;
    if (annAim() === 'list') return annList().emails.length;
    return state.ann.counts.all;
  }
  function annWho() {
    if (annAim() === 'team') {
      var pick = el('ann-team');
      return pick.options.length ? pick.options[pick.selectedIndex].dataset.name : 'a team';
    }
    return 'everyone';
  }
  function people(n) { return n + (n === 1 ? ' person' : ' people'); }
  function paintAnnTarget() {
    var aim = annAim();
    el('ann-team').classList.toggle('hidden', aim !== 'team');
    el('ann-list-box').classList.toggle('hidden', aim !== 'list');
    el('ann-tools').classList.toggle('hidden', el('ann-format').value === 'html');
    if (aim === 'list') {
      var got = annList();
      el('ann-list-note').textContent = got.emails.length || got.bad.length
        ? addresses(got.emails.length) + (got.bad.length ? '. Not read as addresses: ' + got.bad.slice(0, 5).join(', ') + (got.bad.length > 5 ? ' and ' + (got.bad.length - 5) + ' more' : '') : '') + '.'
        : '';
    }
    var send = el('ann-send');
    // armed for one audience, it is not armed for another: the second
    // click sends only to what the first one named
    if (send.classList.contains('is-armed') && annArmedFor !== annTarget()) {
      clearTimeout(annArm);
      send.classList.remove('is-armed');
    }
    if (!send.classList.contains('is-armed')) {
      send.textContent = aim === 'list' ? 'Send to ' + addresses(annReach()) : 'Send to ' + annWho() + ' (' + people(annReach()) + ')';
    }
    send.disabled = !state.ann.configured || state.ann.emailOff || annSending;
    el('ann-test').disabled = !state.ann.configured || state.ann.emailOff;
  }
  // who a send goes to, as the confirmation names them
  function annTarget() {
    var aim = annAim();
    return aim + ' ' + (aim === 'team' ? el('ann-team').value : aim === 'list' ? annList().emails.join(',') : '') + ' ' + annReach();
  }
  function fillAnnTeams() {
    var pick = el('ann-team');
    var held = pick.value;
    pick.textContent = '';
    state.teams.filter(teamShown).forEach(function (t) {
      var n = state.ann.counts.teams[t.id] || 0;
      var opt = h('option', null, t.name + ' (' + n + ')');
      opt.value = String(t.id);
      opt.dataset.name = t.name;
      pick.appendChild(opt);
    });
    if (held) pick.value = held;
  }

  // The preview frame is made when there is a draft to show and taken
  // away when there is not, so the page never carries an empty
  // sandboxed document. Sandboxed with nothing allowed: no script in a
  // draft runs, and nothing in it can reach this page.
  function annFrame(html) {
    var frame = el('ann-preview');
    if (html === null) {
      if (frame) frame.parentNode.removeChild(frame);
      return;
    }
    if (!frame) {
      frame = document.createElement('iframe');
      frame.id = 'ann-preview';
      frame.className = 'ann-preview';
      frame.setAttribute('sandbox', '');
      frame.title = 'Preview of the email';
      el('ann-preview-slot').appendChild(frame);
    }
    frame.srcdoc = html;
  }

  var annTimer = null;
  function annPreview() {
    clearTimeout(annTimer);
    annTimer = setTimeout(function () {
      var d = annDraft();
      var empty = !d.body.trim();
      el('ann-preview-head').classList.toggle('hidden', empty);
      if (empty) { annFrame(null); return; }
      post('/api/console/announce/preview', d).then(function (r) {
        // the box may have been emptied while this was on its way
        if (r.ok && annDraft().body.trim()) annFrame(r.html);
      }).catch(function () {});
    }, 400);
  }
  ['ann-subject', 'ann-body'].forEach(function (id) { el(id).addEventListener('input', annPreview); });
  el('ann-format').addEventListener('change', function () { paintAnnTarget(); annPreview(); });
  el('ann-target').addEventListener('change', paintAnnTarget);
  el('ann-team').addEventListener('change', paintAnnTarget);
  el('ann-list').addEventListener('input', paintAnnTarget);

  // opts.opened: the tab has just been opened, which is when the pop-up
  // about email being off goes up
  function loadAnnounce(opts) {
    api('/api/console/announce').then(function (d) {
      if (!d.ok) return;
      state.ann.counts = d.counts;
      state.ann.configured = d.configured;
      state.ann.emailOff = !!d.email_off;
      state.ann.sends = d.sends;
      fillAnnFooter(d.default_footer);
      fillAnnReply(d.default_reply_to);
      el('ann-off').classList.toggle('hidden', d.configured);
      el('ann-reach').textContent = people(d.counts.all) + ' with an email address';
      paintAnnOff();
      fillAnnTeams();
      paintAnnTarget();
      paintAnnRows();
      if (opts && opts.opened && d.email_off) askAnnOff();
    }).catch(function () {});
  }

  function annProgress(s) {
    return s.sent + ' of ' + s.total + (s.failed ? ', ' + s.failed + ' failed' : '');
  }
  function paintAnnRows() {
    fill(el('ann-rows'), state.ann.sends.length ? state.ann.sends.map(function (s) {
      var actions = h('td', 'num');
      var wrap = h('span', 'inline');
      if (s.status === 'sending' && !state.ann.stepping[s.id] && !state.ann.emailOff) {
        wrap.appendChild(btn('Carry on', 'quiet small', function () { stepAnn(s.id); }));
      }
      if (s.status === 'sending') {
        wrap.appendChild(btn('Stop', 'quiet small', function (e) {
          busy(e.currentTarget, post('/api/console/announce/stop', { id: s.id })).then(function (r) {
            if (done(r, 'Stopped. ' + annProgress(r.send || s) + ' went out.')) loadAnnounce();
          }).catch(function () {});
        }));
      }
      if (s.status !== 'sending' && s.failed && !state.ann.emailOff) {
        wrap.appendChild(btn('Try the failed ones again', 'quiet small', function (e) {
          busy(e.currentTarget, post('/api/console/announce/retry', { id: s.id })).then(function (r) {
            if (done(r)) stepAnn(s.id); else refusedOff(r);
          }).catch(function () {});
        }));
      }
      actions.appendChild(wrap);
      var where = s.status === 'stopped' ? ' (stopped)' : s.status !== 'sending' ? '' : state.ann.emailOff ? ' (paused)' : ' (sending)';
      return row([
        h('td', null, s.subject),
        h('td', null, s.audience === 'team' ? (s.team_name || 'a team') : s.audience === 'list' ? addresses(s.total) : 'Everyone'),
        h('td', null, fmtTime(s.created_at) + (s.created_by ? ', ' + s.created_by : '')),
        h('td', 'num', annProgress(s) + where),
        actions
      ]);
    }) : [emptyRow('Nothing has been emailed from here yet.', 5)]);
  }

  // asks for the next batch until there is none, saying how far it has got
  function stepAnn(id, onDone) {
    state.ann.stepping[id] = true;
    paintAnnRows();
    var status = el('ann-status');
    function next() {
      return post('/api/console/announce/step', { id: id }).then(function (r) {
        // paused while email is off: the rows say so once the list reloads
        if (!done(r)) { if (r && r.email_off) status.textContent = ''; return; }
        var s = r.send;
        if (s.status === 'sending') {
          status.textContent = 'Sending: ' + annProgress(s);
          return next();
        }
        status.textContent = (s.status === 'stopped' ? 'Stopped: ' : 'Sent: ') + annProgress(s) + '.';
        toast(status.textContent);
        if (onDone) onDone(s);
      });
    }
    return next().catch(function () {}).then(function () {
      delete state.ann.stepping[id];
      loadAnnounce();
    });
  }

  el('ann-test').addEventListener('click', function () {
    var d = annDraft();
    if (!d.subject || !d.body.trim()) { toast('A subject and a message are both needed.', true); return; }
    var to = el('ann-test-to').value.trim();
    if (!to) { shake(el('ann-test-to')); return; }
    d.to = to;
    busy(el('ann-test'), post('/api/console/announce/test', d)).then(function (r) {
      if (!done(r, function () { return 'Test sent to ' + r.to; })) refusedOff(r);
    }).catch(function () {});
  });

  // first click arms the button, second click sends; Send stays off
  // while the send itself is on its way
  var annArm = null;
  var annArmedFor = '';
  var annSending = false;
  el('ann-send').addEventListener('click', function () {
    var send = el('ann-send');
    if (annSending) return;
    var d = annDraft();
    if (!d.subject || !d.body.trim()) { toast('A subject and a message are both needed.', true); return; }
    if (annAim() === 'team' && !el('ann-team').value) { shake(el('ann-team')); return; }
    if (annAim() === 'list' && !annReach()) { shake(el('ann-list')); return; }
    if (!annReach()) { toast('Nobody there has an email address.', true); return; }
    if (!send.classList.contains('is-armed') || annArmedFor !== annTarget()) {
      send.classList.add('is-armed');
      annArmedFor = annTarget();
      send.textContent = 'Confirm: email ' + (annAim() === 'list' ? addresses(annReach()) : people(annReach()));
      clearTimeout(annArm);
      annArm = setTimeout(function () { send.classList.remove('is-armed'); paintAnnTarget(); }, 5000);
      return;
    }
    clearTimeout(annArm);
    send.classList.remove('is-armed');
    annSending = true;
    paintAnnTarget();
    d.audience = annAim();
    if (d.audience === 'team') d.team_id = Number(el('ann-team').value);
    if (d.audience === 'list') d.emails = el('ann-list').value;
    var everyone = d.audience === 'all';
    var status = el('ann-status');
    status.textContent = '';
    var going = busy(send, post('/api/console/announce/send', d));
    function settled() { annSending = false; paintAnnTarget(); }
    going.then(settled, settled);
    going.then(function (r) {
      if (!done(r)) { refusedOff(r); return; }
      // a send to one team is often the test of one about to go to
      // everybody: the boxes stay filled for that
      if (everyone) {
        el('ann-subject').value = ''; el('ann-body').value = ''; annPreview();
      }
      if (r.send.status === 'sending') {
        status.textContent = 'Sending: ' + annProgress(r.send);
        return stepAnn(r.send.id);
      }
      status.textContent = 'Sent: ' + annProgress(r.send) + '.';
      toast(status.textContent);
      loadAnnounce();
    }).catch(function () {});
  });
})(window.dash);
