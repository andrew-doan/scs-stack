// The dashboard's script is every file in this folder, run as one script
// in the order src/dash/files.js gives (files-node.js under Node). Each
// file is a function handed dash, which this one makes as window.dash. A
// file puts on dash what other files use: a function at the file's top, a
// value where it is declared. It takes what it needs from the shared files
// (core.js to tabs.js) in a var at its top, and writes dash.name where it
// uses anything from a tab's file, or a value set again after it is
// declared (dash.access).
//
// This one: the session, requests to the worker, the toast, small DOM
// helpers, times and time boxes, hidden teams, what this account may use,
// and the small pieces several tabs draw.
window.dash = {};
(function (dash) {
  dash.session = session;
  dash.whoAmI = whoAmI;
  dash.setSession = setSession;
  dash.setFileCookie = setFileCookie;
  dash.el = el;
  dash.h = h;
  dash.btn = btn;
  dash.row = row;
  dash.fill = fill;
  dash.holdPlace = holdPlace;
  dash.flash = flash;
  dash.digits = digits;
  dash.toast = toast;
  dash.done = done;
  dash.busy = busy;
  dash.shake = shake;
  dash.api = api;
  dash.post = post;
  dash.postForm = postForm;
  dash.fmtTime = fmtTime;
  dash.toLocalInput = toLocalInput;
  dash.fromLocalInput = fromLocalInput;
  dash.timeBox = timeBox;
  dash.teamShown = teamShown;
  dash.hiddenTeamNames = hiddenTeamNames;
  dash.hiddenTeamIds = hiddenTeamIds;
  dash.can = can;
  dash.canTab = canTab;
  dash.statCard = statCard;
  dash.byName = byName;
  dash.chip = chip;
  dash.field = field;
  dash.textInput = textInput;
  dash.armed = armed;
  dash.amountText = amountText;
  dash.placeText = placeText;
  dash.labelled = labelled;
  dash.copyLink = copyLink;
  dash.emptyRow = emptyRow;
  dash.holdOpen = holdOpen;
  dash.letGo = letGo;
  dash.heldIn = heldIn;
  dash.savesAtOnce = savesAtOnce;

  var KEY = dash.KEY = 'scs-console-session';
  dash.state = { teams: [], quests: [], teamId: null, logBefore: null, ready: false, regoMax: 5 };
  var state = dash.state;

  function session() { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } }
  // the name typed at sign-in: it is the actor on every log row, and
  // what a claim on a submission is held under
  function whoAmI() { try { return localStorage.getItem(KEY + '-name') || 'console'; } catch (e) { return 'console'; } }
  function setSession(t) {
    try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY); } catch (e) {}
    setFileCookie(t);
  }
  // media tags can't send the session header, so review previews ride on
  // a cookie scoped to the one endpoint that serves proof files
  function setFileCookie(t) {
    try {
      document.cookie = 'scs_console=' + (t || '') +
        '; Path=/api/console/file; Max-Age=' + (t ? 64800 : 0) + '; SameSite=Strict; Secure';
    } catch (e) {}
  }
  function el(id) { return document.getElementById(id); }

  // ---- tiny DOM helpers: h(tag, className, text) and cell() ----
  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function btn(label, className, onClick) {
    var b = h('button', className, label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }
  function row(cells) {
    var tr = h('tr');
    cells.forEach(function (c) { tr.appendChild(c); });
    return tr;
  }
  function fill(tbody, rows) {
    tbody.textContent = '';
    tbody.classList.remove('rows-in');
    rows.forEach(function (r) { tbody.appendChild(r); });
    void tbody.offsetHeight;
    tbody.classList.add('rows-in');
  }
  // Keeps a list's place on the screen while it is drawn again: the
  // first item starting on the screen (or, when one item fills it, the
  // one showing) is noted with its height on the screen, and once
  // the list is redrawn that item, or the next one still there, is put
  // back at that height. Safari has no scroll anchoring to do this, and a
  // phone's keyboard closing moves the page after the redraw, so it is
  // put back again while the visible area changes size.
  function holdPlace(list, selector) {
    var items = Array.prototype.slice.call(list.querySelectorAll(selector));
    var at = -1;
    var showing = -1;
    for (var i = 0; i < items.length; i++) {
      var box = items[i].getBoundingClientRect();
      if (showing === -1 && box.bottom > 0) showing = i;
      if (box.top >= 0) { if (box.top < window.innerHeight) at = i; break; }
    }
    if (at === -1) at = showing;
    if (at === -1) return function () {};
    var top = items[at].getBoundingClientRect().top;
    var ids = items.slice(at).map(function (n) { return n.getAttribute('data-id'); });
    function put() {
      for (var j = 0; j < ids.length; j++) {
        var n = list.querySelector(selector + '[data-id="' + ids[j] + '"]');
        if (n) { window.scrollBy(0, n.getBoundingClientRect().top - top); return; }
      }
    }
    return function () {
      put();
      var vv = window.visualViewport;
      if (!vv) return;
      vv.addEventListener('resize', put);
      window.setTimeout(function () { vv.removeEventListener('resize', put); }, 1000);
    };
  }
  function flash(tr) {
    tr.classList.remove('is-flash');
    void tr.offsetWidth;
    tr.classList.add('is-flash');
  }
  // a number that pops its digits in when it changes
  function digits(target, text) {
    text = String(text);
    if (target.getAttribute('data-value') === text) return;
    target.setAttribute('data-value', text);
    target.classList.remove('is-animating');
    target.textContent = '';
    var chars = text.split('');
    chars.forEach(function (ch, i) {
      var span = h('span', 't-digit', ch);
      if (i === chars.length - 2) span.setAttribute('data-stagger', '1');
      else if (i === chars.length - 1) span.setAttribute('data-stagger', '2');
      target.appendChild(span);
    });
    void target.offsetHeight;
    target.classList.add('is-animating');
  }

  // ---- toast: one line for every outcome ----
  var toastTimer = null;
  function toast(text, isError) {
    var t = el('toast');
    t.textContent = text;
    t.classList.toggle('is-error', !!isError);
    t.classList.add('is-open');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('is-open'); }, isError ? 6000 : 3500);
  }
  // report an API reply: success text or the server's error
  // okText may be a function: it is only called on success, so it can
  // read fields an error response does not have. Building the text
  // inline used to throw on those fields and the catch swallowed it,
  // which is why some failures showed nothing at all.
  function done(r, okText) {
    if (r && r.ok) {
      var text = typeof okText === 'function' ? okText() : okText;
      if (text) toast(text);
    } else {
      toast((r && r.error) || 'That did not go through.', true);
    }
    return !!(r && r.ok);
  }
  // disable a button while its promise runs, with a ticking ellipsis
  function busy(button, promise) {
    button.disabled = true;
    button.classList.add('is-busy');
    function rest() { button.disabled = false; button.classList.remove('is-busy'); }
    return promise.then(function (v) { rest(); return v; },
      function (e) { rest(); throw e; });
  }
  function shake(node) {
    node.classList.remove('is-shaking');
    void node.offsetWidth;
    node.classList.add('is-shaking');
    setTimeout(function () { node.classList.remove('is-shaking'); }, 320);
  }

  // Every request to the worker. An action that asks for the second
  // password is answered 403 with second_password: the prompt goes up
  // and the same request goes again with what was typed, in a header. A
  // wrong one is asked for again; Cancel gives up on the action.
  // opts.hold keeps what was typed for the requests after this one, for
  // an action that runs as a run of requests (the Submit codes, one
  // request a team).
  // Signed out, nothing is sent: a run of requests stops at its next one.
  // Cloudflare turning requests away answers 429 with a page of its own
  // (error 1015), which comes back as {status: 429, error}.
  var LIMITED = dash.LIMITED = 'Cloudflare is turning requests away. Try again in a few minutes.';
  // A read is asked again when the request does not arrive or a gateway
  // answers for the worker (502, 503, 504). A write is sent once.
  var READ_WAITS = [400, 1200, 3000];
  function ask(path, init, n) {
    var read = !init.method || init.method === 'GET';
    function later() {
      return new Promise(function (resolve) { setTimeout(resolve, READ_WAITS[n]); })
        .then(function () { return ask(path, init, n + 1); });
    }
    return fetch(path, init).then(function (r) {
      if (read && n < READ_WAITS.length && (r.status === 502 || r.status === 503 || r.status === 504)) return later();
      return r;
    }, function (err) {
      if (read && n < READ_WAITS.length) return later();
      throw err;
    });
  }

  function api(path, opts) {
    opts = opts || {};
    var hold = opts.hold || null;
    if (!session()) return Promise.reject(new Error('signed out'));
    function send(second) {
      var headers = Object.assign({}, opts.headers || {});
      headers['authorization'] = 'Bearer ' + session();
      // a multipart body sets its own content type, boundary and all
      if (typeof opts.body === 'string') headers['content-type'] = 'application/json';
      if (second) headers['x-second-password'] = second;
      return ask(path, Object.assign({}, opts, { headers: headers }), 0).then(function (r) {
        if (r.status === 401) { setSession(''); dash.show(false); throw new Error('signed out'); }
        if (r.status === 429) {
          return r.json().catch(function () { return null; }).then(function (d) {
            d = d && typeof d === 'object' ? d : {};
            d.status = 429;
            if (!d.error) d.error = LIMITED;
            return d;
          });
        }
        return r.json().then(function (d) {
          if (r.status !== 403 || !d || !d.second_password) return d;
          return askSecond(d).then(function (typed) {
            if (typed === null) return { error: 'Cancelled.', cancelled: true };
            if (hold) hold.value = typed;
            return send(typed);
          });
        });
      });
    }
    return send(hold ? hold.value : '').catch(function (err) {
      if (err.message !== 'signed out') toast('Could not reach the worker.', true);
      throw err;
    });
  }
  function post(path, body, hold) { return api(path, { method: 'POST', body: JSON.stringify(body || {}), hold: hold }); }
  function postForm(path, form) { return api(path, { method: 'POST', body: form }); }

  // The prompt itself: one at a time, so two actions asking at once are
  // asked in turn.
  var secondQueue = Promise.resolve();
  function askSecond(d) {
    var asked = secondQueue.then(function () { return askSecondNow(d); });
    secondQueue = asked.then(function () {}, function () {});
    return asked;
  }
  function askSecondNow(d) {
    return new Promise(function (resolve) {
      var box = el('second');
      var input = el('second-pass');
      el('second-what').textContent = d.what || '';
      el('second-error').textContent = d.wrong ? 'Wrong second password.' : '';
      input.value = '';
      box.classList.remove('hidden');
      if (d.wrong) shake(box.querySelector('.second-card'));
      input.focus();
      function finish(value) {
        box.classList.add('hidden');
        el('second-go').removeEventListener('click', go);
        el('second-cancel').removeEventListener('click', cancel);
        input.removeEventListener('keydown', key);
        box.removeEventListener('click', outside);
        resolve(value);
      }
      function go() { if (!input.value) { shake(input); return; } finish(input.value); }
      function cancel() { finish(null); }
      function key(e) { if (e.key === 'Enter') go(); if (e.key === 'Escape') cancel(); }
      function outside(e) { if (e.target === box) cancel(); }
      el('second-go').addEventListener('click', go);
      el('second-cancel').addEventListener('click', cancel);
      input.addEventListener('keydown', key);
      box.addEventListener('click', outside);
    });
  }
  // worker stamps are UTC ('2026-10-20 03:15:00'); shown in this device's time zone
  function fmtTime(utc, withYear) {
    var t = String(utc == null ? '' : utc).trim();
    var m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/);
    if (!m) return t;
    var d = new Date(m[1] + 'T' + m[2] + (m[3] || ':00') + 'Z');
    if (isNaN(d.getTime())) return t;
    var opts = { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
    if (withYear) opts.year = 'numeric';
    return d.toLocaleString(undefined, opts);
  }
  // The two directions a datetime-local input needs. The worker stores
  // and reads UTC; the box shows and takes this device's time, the same
  // way fmtTime reads a stamp.
  function pad2(n) { n = Number(n); return (n < 10 ? '0' : '') + n; }
  function toLocalInput(utc) {
    var t = String(utc == null ? '' : utc).trim();
    var m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    if (!m) return '';
    var d = new Date(m[1] + 'T' + m[2] + ':00Z');
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      (TIME_BOX ? 'T' : ' ') + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fromLocalInput(value) {
    var t = String(value || '').trim();
    if (!t) return '';
    var d = new Date(t.replace(' ', 'T')); // a datetime-local value is read in this zone
    if (isNaN(d.getTime())) return '';
    return d.toISOString().replace('T', ' ').slice(0, 19);
  }
  // Firefox before 93 has no date and time box and shows a text box in
  // its place. There the time is typed as 2026-10-20 14:30: it is tidied
  // when the box is left, and a box holding something else is emptied
  // and says so, rather than sent as no time at all.
  var TIME_BOX = (function () {
    var probe = document.createElement('input');
    probe.setAttribute('type', 'datetime-local');
    return probe.type === 'datetime-local';
  })();
  function timeBox(input) {
    input.setAttribute('type', 'datetime-local');
    if (TIME_BOX || input.getAttribute('data-typed')) return input;
    input.setAttribute('data-typed', '1');
    input.placeholder = 'YYYY-MM-DD HH:MM';
    input.addEventListener('change', function () {
      var t = input.value.trim();
      var m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/);
      if (m) input.value = m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]) + ' ' + pad2(m[4]) + ':' + m[5];
      else if (t) { input.value = ''; toast('Write the time as 2026-10-20 14:30.', true); }
    });
    return input;
  }
  // first, so the tidying runs before any other change listener reads the box
  Array.prototype.forEach.call(document.querySelectorAll('input[type=datetime-local]'), timeBox);

  // hidden teams (test runs) can be kept out of every tab
  var HIDE_KEY = dash.HIDE_KEY = 'scs2-dashboard-hide-hidden';
  state.hideHidden = true;
  try { state.hideHidden = localStorage.getItem(HIDE_KEY) !== '0'; } catch (e) {}
  function teamShown(t) { return !(state.hideHidden && t.hidden); }
  function hiddenTeamNames() {
    var names = {};
    if (state.hideHidden) state.teams.forEach(function (t) { if (t.hidden) names[t.name.toLowerCase()] = true; });
    return names;
  }
  function hiddenTeamIds() {
    var ids = {};
    if (state.hideHidden) state.teams.forEach(function (t) { if (t.hidden) ids[t.id] = true; });
    return ids;
  }

  // ---- what this account may use ----
  // The worker checks every request against the account. This only
  // leaves out the tabs it cannot use, so nobody is shown a control that
  // will refuse them. loadMe (tabs.js) replaces this once the worker has
  // said; until then the page has every tab.
  var TAB_PERM = { tab: 'scores', ranks: 'scores', accounts: 'admin' };
  dash.access = { admin: true, perms: [], quests: [] };
  function can(perm) { return dash.access.admin || dash.access.perms.indexOf(perm) !== -1; }
  function canTab(name) {
    // a quest's desk: recording on it is Points or Scores, reading it
    // Review as well
    if (name === 'desk') return can('points') || can('scores') || can('review');
    // a team's ledger is read by everyone who scores or reviews
    if (name === 'ledger') return can('review') || can('points') || can('scores');
    var perm = TAB_PERM[name] || name;
    return perm === 'admin' ? dash.access.admin : can(perm);
  }
  function statCard(label, value, note, alert) {
    var card = h('div', 'stat' + (alert ? ' is-alert' : ''));
    card.appendChild(h('span', 'stat-label', label));
    var num = h('span', 'stat-num t-digit-group');
    card.appendChild(num);
    digits(num, value);
    card.appendChild(h('span', 'stat-note', note || ''));
    return card;
  }

  // who recorded or decided something: a Discord command's entry is
  // stored as discord:<username>
  function byName(by) {
    var m = /^discord:(.*)$/.exec(String(by || ''));
    return m ? m[1] + ' (Discord)' : String(by || '?');
  }
  function chip(code, muted) { return h('span', 'code-chip' + (muted ? ' muted-chip' : ''), code); }
  function field(labelText, node) {
    var l = h('label'); l.appendChild(h('span', null, labelText)); l.appendChild(node); return l;
  }
  function textInput(value, placeholder, mono) {
    var i = h('input', mono ? 'mono' : null); i.type = 'text'; i.value = value == null ? '' : value;
    if (placeholder) i.placeholder = placeholder; return i;
  }
  // a button that asks again before it does anything
  function armed(label, armedLabel, run) {
    var host = h('span', 'inline');
    var first = btn(label, 'quiet small', function () {
      var go = btn(armedLabel, 'danger small', function () { run(go); });
      var back = btn('Cancel', 'quiet small', function () { host.textContent = ''; host.appendChild(first); });
      host.textContent = '';
      host.appendChild(go); host.appendChild(back);
    });
    host.appendChild(first);
    return host;
  }
  // A list drawn again from fresh data keeps what is half typed in it. A
  // node holding an open form is marked with a key (holdOpen); before the
  // list is emptied, heldIn(list) takes the marked nodes out, and the
  // function it returns hands one back by its key, so the redraw puts the
  // same node, typed values and all, where its fresh copy would go. A
  // form that is done with (saved, cancelled) lets go first, so the next
  // redraw draws it fresh.
  function holdOpen(node, key) { node.setAttribute('data-keep', String(key)); }
  function letGo(node) {
    var held = node.closest ? node.closest('[data-keep]') : null;
    if (held) held.removeAttribute('data-keep');
  }
  function heldIn(list) {
    var held = {};
    Array.prototype.forEach.call(list.querySelectorAll('[data-keep]'), function (n) {
      held[n.getAttribute('data-keep')] = n;
    });
    return function (key) {
      var n = held[String(key)] || null;
      delete held[String(key)];
      return n;
    };
  }
  // A tick box that saves as soon as it is flipped: it is held still
  // while its request is out, and goes back if the request does not go
  // through. send(checked) returns the request; it resolves true when the
  // change went through.
  function savesAtOnce(box, send) {
    box.addEventListener('change', function () {
      var want = box.checked;
      box.disabled = true;
      function settle(ok) {
        box.disabled = false;
        if (!ok) box.checked = !want;
      }
      send(want).then(function (ok) { settle(!!ok); }, function () { settle(false); });
    });
  }
  function amountText(n) {
    return String(Math.round(Number(n) * 100) / 100);
  }
  dash.LEDGER_VOIDED = 'scs2-dashboard-ledger-voided';
  function placeText(n) {
    var tail = n % 100;
    if (tail >= 11 && tail <= 13) return n + 'th';
    return n + ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  }
  dash.SITE = 'https://scs.andyrew.space';
  function labelled(text, node) {
    var l = h('label'); l.appendChild(h('span', null, text)); l.appendChild(node); return l;
  }

  function copyLink(text) {
    function byHand() {
      var box = h('textarea');
      box.value = text;
      box.style.position = 'fixed';
      box.style.opacity = '0';
      document.body.appendChild(box);
      box.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(box);
      if (ok) toast('Link copied');
      else toast('Could not copy it. Open the link and take it from the address bar.', true);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Link copied'); }, byHand);
    } else byHand();
  }

  function emptyRow(text, columns) {
    var cell = h('td', 'muted', text);
    cell.colSpan = columns;
    return row([cell]);
  }
})(window.dash);
