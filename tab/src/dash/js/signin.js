// The sign-in form: name, password, the authenticator code when the
// worker asks for one, setting a code up, the backup codes and
// Cloudflare's human check.
(function (dash) {
  // core.js
  var busy = dash.busy, el = dash.el, KEY = dash.KEY, setSession = dash.setSession, shake = dash.shake,
    toast = dash.toast;
  // tabs.js
  var show = dash.show;

  // ---- sign in ----
  // A name and a password, and then, for an account that needs one, a
  // code from the organiser's own authenticator app: the code box only
  // appears once the worker asks for it. An account with no code set up
  // yet is handed a secret instead of a session — the same call,
  // answered differently — and the QR goes up until the first code
  // comes back. The backup codes appear once, after that first code, and
  // never again.
  el('login-btn').addEventListener('click', doLogin);
  el('login-pass').addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    if (el('login-code').classList.contains('hidden')) doLogin();
    else el('login-code').focus();
  });
  el('login-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  el('login-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') el('login-pass').focus(); });
  el('backup-print').addEventListener('click', function () { window.print(); });
  // The codes are shown at a first sign-in, and again from Accounts when
  // new ones are made. Done after a sign-in opens the page; on Accounts it
  // only puts them away.
  el('backup-done').addEventListener('click', function () {
    el('backup').classList.add('hidden');
    if (el('main').classList.contains('hidden')) show(true);
  });

  // ---- Cloudflare's human check ----
  // Rendered whenever the worker is set up for it, and sent with every
  // attempt. The worker only insists on it once something from this
  // address has been refused, so a venue that cannot reach Cloudflare
  // cannot keep an organiser out on a first, correct sign-in. The
  // token is single use, so the widget is reset after every answer.
  var turnstileId = null;
  (function mountTurnstile() {
    var key = document.body.getAttribute('data-turnstile') || '';
    var slot = el('login-turnstile');
    if (!key || !slot) return;
    window.scsTurnstileReady = function () {
      try { turnstileId = window.turnstile.render(slot, { sitekey: key, theme: 'auto' }); }
      catch (err) { /* the widget is Cloudflare's; a render failure reads as no token */ }
    };
    if (window.turnstile) { window.scsTurnstileReady(); return; }
    var tag = document.createElement('script');
    tag.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=scsTurnstileReady&render=explicit';
    tag.async = true;
    tag.defer = true;
    document.head.appendChild(tag);
  })();
  function turnstileToken() {
    if (!window.turnstile || turnstileId === null) return '';
    try { return window.turnstile.getResponse(turnstileId) || ''; } catch (err) { return ''; }
  }
  function resetTurnstile() {
    if (!window.turnstile || turnstileId === null) return;
    try { window.turnstile.reset(turnstileId); } catch (err) { /* a fresh token next try */ }
  }

  function askCode() {
    el('login-code').classList.remove('hidden');
    el('login-code').focus();
  }
  function showEnrol(d) {
    askCode();
    el('enrol').classList.remove('hidden');
    el('enrol-qr').src = d.qr;
    el('enrol-secret').textContent = d.secret;
    el('login-code').focus();
  }

  function doLogin() {
    el('login-error').textContent = '';
    var body = { password: el('login-pass').value, name: el('login-name').value };
    var code = el('login-code').value.trim();
    if (code) body.code = code;
    body.turnstile = turnstileToken();
    busy(el('login-btn'), fetch('/api/console/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (d) { return { s: r.status, d: d }; }); }))
      .then(function (res) {
        // single use, whatever the answer was — the code step is a
        // second request and needs a token of its own
        resetTurnstile();
        if (res.s === 200 && res.d.session) {
          setSession(res.d.session);
          try { localStorage.setItem(KEY + '-name', res.d.name); } catch (e) {}
          el('login-pass').value = '';
          el('login-code').value = '';
          el('login-code').classList.add('hidden');
          el('enrol').classList.add('hidden');
          // The ten printed codes are shown once, here. Nothing else on
          // the page is worth holding a sign-in open for, so this is
          // the one thing that waits for a button.
          if (res.d.backup_codes) {
            el('enrol').classList.add('hidden');
            el('login').classList.add('hidden');
            el('backup').classList.remove('hidden');
            el('backup-list').textContent = res.d.backup_codes.join('\n');
            el('login-error').textContent = '';
            return;
          }
          if (res.d.used_backup) {
            toast('Signed in with a backup code. ' + res.d.backup_left + ' left.');
          }
          show(true);
          return;
        }
        if (res.d.enrol) { showEnrol(res.d); return; }
        if (res.d.needs_code) askCode();
        el('login-error').textContent = res.d.error || 'Could not sign in.';
        shake(el('login'));
      })
      .catch(function () { el('login-error').textContent = 'Could not reach the worker.'; shake(el('login')); });
  }
  el('sign-out').addEventListener('click', function (e) {
    e.preventDefault(); setSession(''); location.reload();
  });
  el('sign-out-menu').addEventListener('click', function (e) {
    e.preventDefault(); setSession(''); location.reload();
  });
})(window.dash);
