// The two organiser pages, served straight from the worker so they
// live on the check-in domain, not the website. Both are a login card
// until the server hands back a session; the pages never see the
// passwords again and every request is re-checked server-side. All
// attendee data goes into the DOM through textContent, never markup.

var SHELL_CSS = `
  :root {
    color-scheme: light dark;
    --page-bg: #f2f3f5; --surface: #ffffff; --tint: #e7e8eb; --text: #111111;
    --muted: #616161; --border: #d5d5d5; --border-strong: #8a8a8a;
    --accent: #00933c; --accent-dark: #00752f; --on-accent: #ffffff;
    --accent-soft: #e8f2e8; --accent-soft-border: #b5d6bc;
    --warn: #fccc0a; --warn-soft: #fff6d1; --warn-border: #e5c23a;
    --danger: #ee352e; --danger-soft: #fdf0ef; --danger-border: #eeb4ae;
    --sign-bg: #131313; --sign-ink: #ffffff;
    --shadow: 3px 3px 0 rgba(17, 17, 17, 0.14);
    --duration-micro: 80ms; --duration-quick: 150ms; --duration-fast: 250ms;
    --duration-medium: 350ms; --duration-slow: 400ms; --duration-stagger: 40ms;
    --ease-smooth-out: cubic-bezier(0.22, 1, 0.36, 1); --ease-in-out: ease-in-out;
    --ease-bounce: cubic-bezier(0.34, 1.36, 0.64, 1);
    --shake-distance: 6px; --shake-overshoot: 4px; --shake-dur-a: 80ms; --shake-dur-b: 60ms;
    --digit-dur: 500ms; --digit-distance: 8px; --digit-stagger: 70ms; --digit-blur: 2px;
    --digit-ease: cubic-bezier(0.34, 1.45, 0.64, 1);
    --swap-dur: 150ms; --swap-distance: 4px; --swap-blur: 2px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --page-bg: #121212; --surface: #1b1b1b; --tint: #121212; --text: #eeeeee;
      --muted: #a3a3a3; --border: #333333; --border-strong: #4a4a4a;
      --accent: #2fb063; --accent-dark: #55c581; --on-accent: #0a130e;
      --accent-soft: #142a1b; --accent-soft-border: #26513a;
      --warn-soft: #2e2a12; --warn-border: #6a5a1a;
      --danger: #f2b8b5; --danger-soft: #2a1716; --danger-border: #5b302d;
      --sign-bg: #0c0c0c; --shadow: 3px 3px 0 rgba(0, 0, 0, 0.5);
    }
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
  body {
    margin: 0; padding: 0 0 40px; background: var(--page-bg); color: var(--text);
    font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif;
    font-size: 16px; line-height: 1.45;
  }
  header {
    background: var(--sign-bg); color: var(--sign-ink); padding: 12px 16px;
    display: flex; align-items: baseline; justify-content: space-between; gap: 12px;
    border-bottom: 6px solid;
    border-image: linear-gradient(to right, #ee352e 0 20%, #ff6319 20% 40%,
      #fccc0a 40% 60%, #00933c 60% 80%, #0039a6 80% 100%) 1;
  }
  header h1 { margin: 0; font-size: 1.15rem; font-weight: 800; }
  header h1 span { font-weight: 600; opacity: 0.7; margin-left: 8px; }
  #who-line { font-size: 0.85rem; opacity: 0.85; margin: 0; }
  #who-line a { color: inherit; }
  main { max-width: 640px; margin: 0 auto; padding: 18px 14px; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 2px; box-shadow: var(--shadow); padding: 16px; margin: 0 0 14px;
  }
  label.field { display: block; margin: 0 0 12px; }
  label.field span {
    display: block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--muted); margin: 0 0 6px;
  }
  input, button, select { font: inherit; color: var(--text); border-radius: 2px; }
  input[type="password"], input[type="search"] {
    width: 100%; padding: 10px 12px; background: var(--tint);
    border: 1px solid var(--border-strong); min-height: 44px;
    transition: border-color var(--duration-quick) var(--ease-smooth-out);
  }
  input:focus-visible, select:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button {
    border: 1px solid var(--accent-dark); background: var(--accent); color: var(--on-accent);
    font-weight: 700; padding: 10px 18px; min-height: 44px; cursor: pointer; box-shadow: var(--shadow);
    transition: transform var(--duration-quick) var(--ease-smooth-out),
      box-shadow var(--duration-quick) var(--ease-smooth-out),
      opacity var(--duration-quick) var(--ease-smooth-out);
  }
  button:active { transform: translate(1px, 1px); box-shadow: none; }
  button:disabled { opacity: 0.45; cursor: default; }
  button.quiet {
    background: var(--surface); color: var(--text); border-color: var(--border-strong);
    font-weight: 600;
  }
  .error { color: var(--danger); margin: 10px 0 0; min-height: 1.4em; }
  .hidden { display: none !important; }
  .status-line { color: var(--muted); margin: 10px 0 0; min-height: 1.4em; }

  /* tabs: a segmented bar whose black pill slides to the active tab */
  .tabs { position: relative; display: flex; gap: 2px; padding: 3px; margin: 0 0 14px;
    background: var(--surface); border: 1px solid var(--border-strong); border-radius: 2px; box-shadow: var(--shadow); }
  .tabs button {
    position: relative; z-index: 1; flex: 1; background: transparent; border: 0; box-shadow: none;
    color: var(--muted); font-weight: 700; min-height: 40px; padding: 6px 10px;
    transition: color var(--duration-fast) var(--ease-smooth-out);
  }
  .tabs button:active { transform: none; }
  .tabs button.is-active { color: var(--sign-ink); }
  .tabs-pill {
    position: absolute; top: 3px; left: 0; bottom: 3px; width: 0; z-index: 0;
    background: var(--sign-bg); border-radius: 2px; transform: translateX(0);
    transition: transform var(--duration-fast) var(--ease-smooth-out), width var(--duration-fast) var(--ease-smooth-out);
    will-change: transform, width; pointer-events: none;
  }

  /* first load: the page fades up once it has data */
  #main { opacity: 0; transition: opacity var(--duration-slow) var(--ease-in-out); }
  #main.is-ready { opacity: 1; }
  .view { animation: view-in var(--duration-fast) var(--ease-smooth-out) both; }
  @keyframes view-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

  /* wrong password: shake the card */
  .t-input.is-shaking { animation: t-input-shake calc(var(--shake-dur-a) * 2 + var(--shake-dur-b) * 2) linear; }
  @keyframes t-input-shake {
    0% { transform: translateX(0); animation-timing-function: var(--ease-smooth-out); }
    28.57% { transform: translateX(var(--shake-distance)); animation-timing-function: var(--ease-smooth-out); }
    57.14% { transform: translateX(calc(var(--shake-distance) * -1)); animation-timing-function: var(--ease-smooth-out); }
    78.57% { transform: translateX(var(--shake-overshoot)); animation-timing-function: var(--ease-smooth-out); }
    100% { transform: translateX(0); }
  }

  /* numbers that change pop their digits in */
  @keyframes t-digit-pop-in {
    0% { transform: translateY(var(--digit-distance)); opacity: 0; filter: blur(var(--digit-blur)); }
    100% { transform: none; opacity: 1; filter: blur(0); }
  }
  .t-digit-group { display: inline-flex; align-items: baseline; }
  .t-digit { display: inline-block; will-change: transform, opacity, filter; }
  .t-digit-group.is-animating .t-digit { animation: t-digit-pop-in var(--digit-dur) var(--digit-ease) both; }
  .t-digit-group.is-animating .t-digit[data-stagger="1"] { animation-delay: var(--digit-stagger); }
  .t-digit-group.is-animating .t-digit[data-stagger="2"] { animation-delay: calc(var(--digit-stagger) * 2); }

  /* a line of text that swaps in place with a small blurred rise */
  .t-swap { display: inline-block; will-change: transform, opacity, filter; }
  .t-swap.is-swapping { animation: t-swap-in var(--swap-dur) var(--ease-in-out) both; }
  @keyframes t-swap-in {
    0% { opacity: 0; transform: translateY(var(--swap-distance)); filter: blur(var(--swap-blur)); }
    100% { opacity: 1; transform: none; filter: blur(0); }
  }

  @media (prefers-reduced-motion: reduce) {
    .tabs-pill, #main, button, input { transition: none !important; }
    .view, .t-input.is-shaking, .t-digit-group .t-digit, .t-swap.is-swapping { animation: none !important; }
  }
`;

function pageShell(title, subtitle, bodyHtml, extraCss, script) {
  return '<!doctype html>\n' +
    '<html lang="en">\n<head>\n' +
    '<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '<meta name="robots" content="noindex" />\n' +
    '<title>' + title + '</title>\n' +
    '<style>' + SHELL_CSS + (extraCss || '') + '</style>\n' +
    '</head>\n<body>\n' +
    '<header><h1>SCS.2 <span>' + subtitle + '</span></h1>' +
    '<p id="who-line" class="hidden"><a id="sign-out" href="#">Sign out</a></p></header>\n' +
    '<main>\n' + bodyHtml + '\n</main>\n' +
    '<script>\n' + script + '\n</script>\n' +
    '</body>\n</html>\n';
}

// Shared page JS: session storage, API calls that bounce back to the
// login card the moment the server stops accepting the session, and
// the small motion helpers both pages use.
var SESSION_JS = `
  function el(id) { return document.getElementById(id); }
  function h(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function sessionKey(role) { return 'scs-checkin-' + role; }
  function getSession(role) {
    try { return localStorage.getItem(sessionKey(role)) || ''; } catch (err) { return ''; }
  }
  function setSession(role, token) {
    try {
      if (token) localStorage.setItem(sessionKey(role), token);
      else localStorage.removeItem(sessionKey(role));
    } catch (err) {}
  }
  function api(path, options, role, onAuthFail) {
    options = options || {};
    options.headers = options.headers || {};
    options.headers['authorization'] = 'Bearer ' + getSession(role);
    if (options.body && !options.headers['content-type']) {
      options.headers['content-type'] = 'application/json';
    }
    return fetch(path, options).then(function (resp) {
      if (resp.status === 401) {
        setSession(role, '');
        if (onAuthFail) onAuthFail();
        throw new Error('signed out');
      }
      return resp.json();
    });
  }
  function busy(button, promise) {
    button.disabled = true;
    return promise.then(function (v) { button.disabled = false; return v; },
      function (e) { button.disabled = false; throw e; });
  }
  function shake(node) {
    node.classList.remove('is-shaking');
    void node.offsetWidth;
    node.classList.add('is-shaking');
    setTimeout(function () { node.classList.remove('is-shaking'); }, 320);
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
  // a line of text that swaps in place, only when it actually changes
  function swapText(target, text) {
    if (target.textContent === text) return;
    target.classList.remove('is-swapping');
    target.textContent = text;
    void target.offsetWidth;
    if (text) target.classList.add('is-swapping');
  }
  function wireLogin(role, onReady) {
    var loginCard = el('login');
    var mainView = el('main');
    var errorEl = el('login-error');
    var input = el('password');
    var button = el('login-btn');
    function show(signedIn) {
      loginCard.classList.toggle('hidden', signedIn);
      mainView.classList.toggle('hidden', !signedIn);
      el('who-line').classList.toggle('hidden', !signedIn);
      if (signedIn) onReady();
      else if (input) input.focus();
    }
    button.addEventListener('click', doLogin);
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
    function doLogin() {
      errorEl.textContent = '';
      busy(button, fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: input.value, role: role })
      }).then(function (r) { return r.json().then(function (data) { return { status: r.status, data: data }; }); }))
        .then(function (res) {
          if (res.status === 200 && res.data.session) {
            input.value = '';
            setSession(role, res.data.session);
            show(true);
          } else {
            errorEl.textContent = res.data.error || 'Could not sign in.';
            shake(loginCard);
          }
        })
        .catch(function () { errorEl.textContent = 'Could not reach the server.'; shake(loginCard); });
    }
    el('sign-out').addEventListener('click', function (e) {
      e.preventDefault();
      setSession(role, '');
      location.reload();
    });
    show(!!getSession(role));
    return { backToLogin: function () { show(false); } };
  }
  // a segmented control whose pill slides to the active button
  function wireTabs(bar, onChange) {
    var pill = bar.querySelector('.tabs-pill');
    var buttons = Array.prototype.slice.call(bar.querySelectorAll('button[data-tab]'));
    function active() {
      return buttons.filter(function (b) { return b.classList.contains('is-active'); })[0] || buttons[0];
    }
    function place(animate) {
      var tab = active();
      if (!animate) pill.style.transition = 'none';
      pill.style.transform = 'translateX(' + tab.offsetLeft + 'px)';
      pill.style.width = tab.offsetWidth + 'px';
      if (!animate) { void pill.offsetWidth; pill.style.transition = ''; }
    }
    buttons.forEach(function (b) {
      b.addEventListener('click', function () {
        if (b.classList.contains('is-active')) return;
        buttons.forEach(function (x) {
          var on = x === b;
          x.classList.toggle('is-active', on);
          x.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        place(true);
        onChange(b.dataset.tab);
      });
    });
    window.addEventListener('resize', function () { place(false); });
    return { place: place, current: function () { return active().dataset.tab; } };
  }
  function fmtTime(sqlUtc) {
    if (!sqlUtc) return '';
    var d = new Date(sqlUtc.replace(' ', 'T') + 'Z');
    if (isNaN(d)) return sqlUtc;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
`;

var SCAN_CSS = `
  .cam-box {
    position: relative; background: #000; border: 1px solid var(--border-strong);
    border-radius: 2px; overflow: hidden; aspect-ratio: 3 / 4; max-height: 60vh;
  }
  .cam-box video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .cam-box .frame {
    position: absolute; inset: 18%; border: 2px solid rgba(255, 255, 255, 0.85);
    border-radius: 2px; pointer-events: none;
    box-shadow: 0 0 0 999px rgba(0, 0, 0, 0.25);
    transition: border-color var(--duration-fast) var(--ease-smooth-out);
  }
  .cam-box.is-paused .frame { border-color: rgba(255, 255, 255, 0.3); }
  /* the verdict: a panel that rises under the camera, coloured by outcome */
  .result {
    margin: 12px 0 0; padding: 14px 16px; border: 1px solid var(--border-strong);
    border-left-width: 8px; border-radius: 2px; background: var(--surface);
    animation: result-in var(--duration-fast) var(--ease-smooth-out) both;
  }
  @keyframes result-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
  .result .kicker {
    margin: 0 0 2px; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.1em; text-transform: uppercase;
  }
  .result h2 { margin: 0 0 2px; font-size: 1.6rem; font-weight: 800; line-height: 1.15; }
  .result h2:empty { display: none; }
  .result .who { color: var(--muted); margin: 0 0 8px; }
  .result .who:empty { display: none; }
  .result .team-line { margin: 0 0 12px; }
  .result .team-line:empty { display: none; }
  .result.is-in { border-color: var(--accent); background: var(--accent-soft); }
  .result.is-in .kicker { color: var(--accent-dark); }
  .result.is-already { border-color: var(--warn-border); background: var(--warn-soft); }
  .result.is-bad { border-color: var(--danger); background: var(--danger-soft); }
  .result.is-bad .kicker { color: var(--danger); }
  .row {
    display: flex; align-items: center; gap: 10px; padding: 8px 0;
    border-bottom: 1px solid var(--border);
    animation: view-in var(--duration-fast) var(--ease-smooth-out) both;
  }
  .row:last-child { border-bottom: 0; }
  .row .info { flex: 1; min-width: 0; }
  .row .info strong { display: block; }
  .row .info span { color: var(--muted); font-size: 0.85rem; }
  .row .state { font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; white-space: nowrap; }
  .row .state.in { color: var(--accent); }
  .row .state.out { color: var(--muted); }
  .row button { padding: 8px 12px; font-size: 0.9rem; }
  @media (prefers-reduced-motion: reduce) { .result, .row { animation: none !important; } }
`;

var SCAN_BODY = `
  <div id="login" class="card t-input">
    <label class="field"><span>Scan password</span>
      <input id="password" type="password" autocomplete="current-password" />
    </label>
    <button id="login-btn" type="button">Sign in</button>
    <p id="login-error" class="error"></p>
  </div>

  <div id="main" class="hidden">
    <div class="tabs" role="tablist">
      <span class="tabs-pill" aria-hidden="true"></span>
      <button type="button" data-tab="scan" class="is-active" role="tab" aria-selected="true">Scan</button>
      <button type="button" data-tab="search" role="tab" aria-selected="false">Search</button>
    </div>

    <div id="view-scan" class="view">
      <div id="cam" class="cam-box">
        <video id="video" playsinline muted></video>
        <div class="frame"></div>
      </div>
      <p id="scan-status" class="status-line">Starting the camera…</p>
      <div id="result" class="result hidden">
        <p id="result-kicker" class="kicker"></p>
        <h2 id="result-name"></h2>
        <p id="result-who" class="who"></p>
        <p id="result-team" class="team-line"></p>
        <button id="scan-next" type="button">Scan next</button>
      </div>
    </div>

    <div id="view-search" class="view hidden">
      <input id="search" type="search" placeholder="Name, team or zID" autocomplete="off" aria-label="Find a person" />
      <div id="search-results"></div>
      <p id="search-status" class="status-line"></p>
    </div>
  </div>
`;

var SCAN_JS = SESSION_JS + `
  var scanning = false;
  var stream = null;
  var lastPayload = '';
  var lastPayloadAt = 0;
  var video = el('video');
  var camBox = el('cam');
  var canvas = document.createElement('canvas');
  var canvasCtx = canvas.getContext('2d', { willReadFrequently: true });
  var scanStatus = el('scan-status');
  var resultCard = el('result');
  var login;

  function authFailed() { stopCamera(); login.backToLogin(); }

  function startCamera() {
    if (stream) { scanning = true; return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      scanStatus.textContent = 'This browser cannot open the camera. Use Search instead.';
      return;
    }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false
    }).then(function (s) {
      stream = s;
      video.srcObject = s;
      video.play();
      scanning = true;
      scanStatus.textContent = 'Point the camera at a check-in code.';
      requestAnimationFrame(tick);
    }).catch(function () {
      scanStatus.textContent = 'Camera blocked. Allow camera access, or use Search.';
    });
  }
  function stopCamera() {
    scanning = false;
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
      video.srcObject = null;
    }
  }

  var lastDecode = 0;
  function tick() {
    if (stream) requestAnimationFrame(tick);
    if (!scanning || !stream || video.readyState < 2) return;
    var now = Date.now();
    if (now - lastDecode < 140) return; // decoding every frame melts phones
    lastDecode = now;
    var w = video.videoWidth;
    var h = video.videoHeight;
    if (!w || !h) return;
    var scale = Math.min(1, 640 / Math.max(w, h));
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    canvasCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
    var image = canvasCtx.getImageData(0, 0, canvas.width, canvas.height);
    var code = window.jsQR ? jsQR(image.data, image.width, image.height, { inversionAttempts: 'dontInvert' }) : null;
    if (code && code.data) onPayload(code.data);
  }

  function onPayload(payload) {
    var now = Date.now();
    if (payload === lastPayload && now - lastPayloadAt < 3000) return;
    lastPayload = payload;
    lastPayloadAt = now;
    if (payload.indexOf('scs2:') !== 0) {
      showResult('bad', 'Not a check-in code', '', 'That QR code is something else.');
      return;
    }
    scanning = false;
    scanStatus.textContent = 'Checking…';
    api('/api/checkin', { method: 'POST', body: JSON.stringify({ token: payload }) }, 'scan', authFailed)
      .then(function (data) {
        if (!data.ok && data.hidden) {
          showResult('bad', 'Test ticket', data.name, 'Hidden as a test team, so not checked in.');
          return;
        }
        if (!data.ok) {
          showResult('bad', 'Not found', '', 'This code is not on the list.');
          return;
        }
        showPerson(data);
      })
      .catch(function (err) {
        if (err.message !== 'signed out') {
          showResult('bad', 'No connection', '', 'Could not reach the server. Try again.');
        }
      });
  }

  function teamLine(team, name) {
    if (!team || !team.size) return '';
    if (team.complete) return 'Everyone from ' + name + ' is in.';
    return team.checked_in + ' of ' + team.size + ' from ' + name + ' checked in.';
  }

  function showPerson(data) {
    if (data.already) {
      showResult('already', 'Already in' + (data.checked_in_at ? ' since ' + fmtTime(data.checked_in_at) : ''),
        data.name, teamLine(data.team, data.team_name), data.zid);
      return;
    }
    if (navigator.vibrate) navigator.vibrate(60);
    showResult('in', 'Checked in', data.name, teamLine(data.team, data.team_name), data.zid);
  }

  function showResult(kind, kicker, name, teamText, who) {
    scanning = false;
    camBox.classList.add('is-paused');
    resultCard.classList.remove('hidden', 'is-in', 'is-already', 'is-bad');
    void resultCard.offsetWidth; // replay the rise
    resultCard.classList.add('is-' + kind);
    el('result-kicker').textContent = kicker;
    el('result-name').textContent = name || '';
    el('result-who').textContent = who || '';
    el('result-team').textContent = teamText || '';
    scanStatus.textContent = '';
    el('scan-next').focus();
  }

  el('scan-next').addEventListener('click', function () {
    resultCard.classList.add('hidden');
    camBox.classList.remove('is-paused');
    lastPayload = '';
    scanning = true;
    scanStatus.textContent = 'Point the camera at a check-in code.';
  });

  // ---- search / manual check-in ----
  var searchInput = el('search');
  var searchResults = el('search-results');
  var searchStatus = el('search-status');
  var searchTimer = null;

  searchInput.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 250);
  });

  function runSearch() {
    var q = searchInput.value.trim();
    searchStatus.textContent = 'Looking…';
    return api('/api/attendees?q=' + encodeURIComponent(q), {}, 'scan', authFailed)
      .then(function (data) {
        renderRows(data.attendees || []);
        searchStatus.textContent = data.attendees && data.attendees.length ? '' : 'Nobody matches that.';
      })
      .catch(function (err) {
        if (err.message !== 'signed out') searchStatus.textContent = 'Could not reach the server.';
      });
  }

  function renderRows(rows) {
    searchResults.textContent = '';
    rows.forEach(function (row) {
      var wrap = h('div', 'row');
      var info = h('div', 'info');
      info.appendChild(h('strong', null, row.name));
      info.appendChild(h('span', null, row.team_name + ' · ' + row.zid));
      wrap.appendChild(info);

      wrap.appendChild(h('span', 'state ' + (row.checked_in_at ? 'in' : 'out'),
        row.checked_in_at ? 'In ' + fmtTime(row.checked_in_at) : 'Not in'));

      var btn = h('button', row.checked_in_at ? 'quiet' : null, row.checked_in_at ? 'Undo' : 'Check in');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        busy(btn, changeRow(row.checked_in_at ? '/api/uncheckin' : '/api/checkin', row));
      });
      wrap.appendChild(btn);
      searchResults.appendChild(wrap);
    });
  }

  function changeRow(path, row) {
    return api(path, { method: 'POST', body: JSON.stringify({ id: row.id }) }, 'scan', authFailed)
      .then(function (data) {
        if (!data.ok) { searchStatus.textContent = 'That did not go through.'; return; }
        if (path === '/api/checkin' && !data.already && navigator.vibrate) navigator.vibrate(60);
        // refresh the list first: runSearch writes its own status, so
        // the confirmation has to land after it or it vanishes
        return runSearch().then(function () {
          searchStatus.textContent = path === '/api/checkin'
            ? data.name + ' checked in. ' + teamLine(data.team, data.team_name)
            : 'Undone for ' + data.name + '.';
        });
      })
      .catch(function (err) {
        if (err.message !== 'signed out') searchStatus.textContent = 'Could not reach the server.';
      });
  }

  // ---- tabs ----
  var tabs = wireTabs(document.querySelector('.tabs'), function (tab) {
    var scan = tab === 'scan';
    var scanView = el('view-scan');
    var searchView = el('view-search');
    scanView.classList.toggle('hidden', !scan);
    searchView.classList.toggle('hidden', scan);
    // re-run the view rise on the one coming in
    var view = scan ? scanView : searchView;
    view.classList.remove('view'); void view.offsetWidth; view.classList.add('view');
    if (scan) startCamera();
    else { scanning = false; runSearch(); searchInput.focus(); }
  });

  // the QR reader, asked for again until it arrives
  (function needJsqr(n) {
    var tag = document.createElement('script');
    tag.src = '/scan/jsqr.js' + (n ? '?r=' + n : '');
    tag.onerror = function () {
      if (tag.parentNode) tag.parentNode.removeChild(tag);
      setTimeout(function () { needJsqr(n + 1); }, Math.min(8000, 500 * Math.pow(2, n)));
    };
    document.head.appendChild(tag);
  })(0);

  login = wireLogin('scan', function () {
    tabs.place(false);
    el('main').classList.add('is-ready');
    startCamera();
  });
`;

var BOARD_CSS = `
  main { max-width: 1280px; }
  /* the counts stay at the top of the screen and the wall scrolls under them */
  .stats {
    position: sticky; top: 0; z-index: 2;
    display: flex; gap: 28px; flex-wrap: wrap; align-items: flex-end;
    margin: 0 0 16px; padding: 12px 0;
    background: var(--page-bg); border-bottom: 1px solid var(--border);
  }
  .stat .big { font-size: 2.8rem; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; margin: 0; }
  .stat .big small { font-size: 1.2rem; font-weight: 700; color: var(--muted); }
  .stat .lbl { margin: 4px 0 0; }
  .stat-time { margin-left: auto; color: var(--muted); font-size: 0.85rem; text-align: right; }
  .controls { display: flex; gap: 14px 20px; flex-wrap: wrap; align-items: center; margin: 0 0 18px; }
  .controls input[type="search"] { flex: 1 1 240px; width: auto; }
  .check { position: relative; display: flex; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; }
  .check input { position: absolute; opacity: 0; width: 1px; height: 1px; }
  /* the site's rocker (site.css), same look and the same travelling
     block: a paper box, no shadow, equal halves so one block can land
     squarely on either side, the letters in the label voice and the box
     measured in em. The block is grey over the O and accent green over
     the I; the covered letter takes the ink that reads on its block and
     the uncovered one is muted on the paper. */
  .settings-switch {
    flex: none; position: relative; display: inline-grid;
    grid-auto-flow: column; grid-auto-columns: 1fr;
    border: 1px solid var(--border-strong);
    border-radius: 2px; overflow: hidden;
    background: var(--surface);
    font-size: 0.72rem; font-weight: 800; line-height: 1; user-select: none;
  }
  .settings-switch::before {
    content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 50%;
    background: var(--border-strong);
    transition: transform var(--duration-fast) var(--ease-bounce),
      background-color var(--duration-fast) var(--ease-smooth-out);
  }
  .check input:checked + .settings-switch::before { transform: translateX(100%); background: var(--accent); }
  .settings-switch span { position: relative; min-width: 2.6em; padding: 0.6em 0; text-align: center; color: var(--muted);
    transition: color var(--duration-micro) var(--ease-in-out); }
  .check input:not(:checked) + .settings-switch span:first-child,
  .check input:checked + .settings-switch span:last-child {
    transition: color var(--duration-micro) var(--ease-in-out) 140ms;
  }
  .check input:not(:checked) + .settings-switch span:first-child { color: var(--text); }
  .check input:checked + .settings-switch span:last-child { color: var(--on-accent); }
  .check input:focus-visible + .settings-switch { outline: 2px solid var(--accent); outline-offset: 2px; }
  .check select {
    font: inherit; border: 1px solid var(--border-strong); border-radius: 2px;
    background: var(--surface); color: var(--text); padding: 8px 10px; min-height: 40px;
  }
  .lbl {
    font-size: 0.72rem; font-weight: 700; letter-spacing: 0.1em;
    text-transform: uppercase; color: var(--muted);
  }
  /* the wall: one chip per person, Tabbycat-style, in signage colours */
  .group { margin: 0 0 14px; }
  .group-head {
    display: flex; justify-content: space-between; align-items: baseline; gap: 12px;
    background: var(--sign-bg); color: var(--sign-ink); padding: 7px 12px; border-radius: 2px;
    font-size: 0.78rem; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase;
    transition: background var(--duration-medium) var(--ease-smooth-out), color var(--duration-medium) var(--ease-smooth-out);
  }
  .group-head .n { font-variant-numeric: tabular-nums; }
  .group-head.done { background: var(--accent); color: var(--on-accent); }
  .wall-row { display: flex; flex-wrap: wrap; gap: 6px; padding: 8px 0 2px; }
  .chip {
    display: inline-flex; align-items: baseline; gap: 7px;
    border: 1px solid var(--border-strong); background: var(--surface); color: var(--text);
    padding: 6px 11px; border-radius: 2px; font-size: 0.92rem; font-weight: 650;
    transition: background var(--duration-fast) var(--ease-smooth-out), color var(--duration-fast) var(--ease-smooth-out),
      border-color var(--duration-fast) var(--ease-smooth-out), box-shadow var(--duration-fast) var(--ease-smooth-out);
  }
  .chip.in {
    background: var(--accent); border-color: var(--accent-dark);
    color: var(--on-accent); box-shadow: var(--shadow);
  }
  .chip .t {
    font-size: 0.72rem; font-weight: 800; opacity: 0.85;
    font-variant-numeric: tabular-nums; letter-spacing: 0.03em;
  }
  .chip .t:empty { display: none; }
  /* arrivals: a chip that just turned green pops; a brand-new chip rises in */
  .chip.is-arrived { animation: chip-pop var(--duration-slow) var(--ease-bounce) both; }
  @keyframes chip-pop { 0% { transform: scale(0.9); } 60% { transform: scale(1.06); } 100% { transform: none; } }
  .chip.is-new { animation: view-in var(--duration-fast) var(--ease-smooth-out) both; }
  @media (prefers-reduced-motion: reduce) {
    .chip, .group-head, .settings-switch span, .settings-switch::before { transition: none !important; }
    .chip.is-arrived, .chip.is-new { animation: none !important; }
  }
`;

var BOARD_BODY = `
  <div id="login" class="card t-input">
    <label class="field"><span>Board password</span>
      <input id="password" type="password" autocomplete="current-password" />
    </label>
    <button id="login-btn" type="button">Sign in</button>
    <p id="login-error" class="error"></p>
  </div>

  <div id="main" class="hidden">
    <div class="stats">
      <div class="stat">
        <p class="big"><span id="people-in" class="t-digit-group">0</span><small> / <span id="people-total">0</span></small></p>
        <p class="lbl">People in</p>
      </div>
      <div class="stat">
        <p class="big"><span id="teams-in" class="t-digit-group">0</span><small> / <span id="teams-total">0</span></small></p>
        <p class="lbl">Teams complete</p>
      </div>
      <p class="stat-time"><span id="board-status" class="t-swap"></span></p>
    </div>
    <div class="controls">
      <input id="filter" type="search" placeholder="Filter names and teams" autocomplete="off" aria-label="Filter names and teams" />
      <label class="check"><input id="hide-in" type="checkbox" /><span class="settings-switch" aria-hidden="true"><span>O</span><span>I</span></span>Hide checked in</label>
      <label class="check"><input id="hide-out" type="checkbox" /><span class="settings-switch" aria-hidden="true"><span>O</span><span>I</span></span>Hide absent</label>
      <label class="check"><input id="auto-scroll" type="checkbox" /><span class="settings-switch" aria-hidden="true"><span>O</span><span>I</span></span>Auto scroll</label>
      <label class="check"><span class="lbl">Sort</span>
        <select id="sort">
          <option value="team">By team</option>
          <option value="name">By name</option>
          <option value="time">By time</option>
        </select>
      </label>
    </div>
    <div id="wall"></div>
    <p id="board-empty" class="status-line"></p>
  </div>
`;

var BOARD_JS = SESSION_JS + `
  var login;
  var timer = null;
  var main = el('main');

  function authFailed() {
    clearInterval(timer);
    timer = null;
    stopAuto();
    login.backToLogin();
  }

  var last = null;
  var view = { q: '', sort: 'team', hideIn: false, hideOut: false };
  // chips are kept between renders, keyed by person, so a change of
  // state animates on the chip itself instead of rebuilding the wall
  var chips = {};
  var firstRender = true;

  function chipFor(person) {
    var key = person.team_name + '|' + person.name;
    var entry = chips[key];
    var wasIn = entry ? entry.in : null;
    if (!entry) {
      var node = h('span', 'chip');
      node.appendChild(h('span', null, person.name));
      node.appendChild(h('span', 't'));
      entry = chips[key] = { node: node, in: false };
      if (!firstRender) node.classList.add('is-new');
    }
    var nowIn = !!person.checked_in_at;
    entry.node.classList.toggle('in', nowIn);
    entry.node.lastChild.textContent = nowIn ? fmtTime(person.checked_in_at) : '';
    if (wasIn === false && nowIn && !firstRender) {
      entry.node.classList.remove('is-arrived');
      void entry.node.offsetWidth;
      entry.node.classList.add('is-arrived');
    }
    entry.in = nowIn;
    return entry.node;
  }

  function render() {
    if (!last) return;
    digits(el('people-in'), last.people_checked_in);
    el('people-total').textContent = last.people;
    digits(el('teams-in'), last.teams_complete);
    el('teams-total').textContent = last.teams;

    var q = view.q.toLowerCase();
    var people = (last.people_list || []).filter(function (p) {
      if (view.hideIn && p.checked_in_at) return false;
      if (view.hideOut && !p.checked_in_at) return false;
      if (q && p.name.toLowerCase().indexOf(q) === -1 &&
          p.team_name.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });

    var wall = el('wall');
    var fresh = document.createDocumentFragment();
    el('board-empty').textContent = people.length ? ''
      : (last.people_list && last.people_list.length ? 'Nobody matches those filters.' : 'Nobody registered yet.');

    if (view.sort === 'team') {
      // grouped wall: a sign bar per team with its count, chips beneath
      var byTeam = {};
      var order = [];
      people.forEach(function (p) {
        if (!byTeam[p.team_name]) { byTeam[p.team_name] = []; order.push(p.team_name); }
        byTeam[p.team_name].push(p);
      });
      var meta = {};
      (last.team_list || []).forEach(function (t) { meta[t.team_name] = t; });
      order.forEach(function (teamName) {
        var group = h('section', 'group');
        var m = meta[teamName];
        var head = h('div', 'group-head' + (m && m.complete ? ' done' : ''));
        head.appendChild(h('span', null, teamName));
        head.appendChild(h('span', 'n', m ? m.checked_in + '/' + m.size : ''));
        group.appendChild(head);
        var row = h('div', 'wall-row');
        byTeam[teamName].forEach(function (p) { row.appendChild(chipFor(p)); });
        group.appendChild(row);
        fresh.appendChild(group);
      });
    } else {
      var flat = people.slice();
      if (view.sort === 'name') {
        flat.sort(function (a, b) { return a.name.localeCompare(b.name); });
      } else {
        // by time: latest arrivals first, absentees after, by name
        flat.sort(function (a, b) {
          if (!!a.checked_in_at !== !!b.checked_in_at) return a.checked_in_at ? -1 : 1;
          if (a.checked_in_at) return a.checked_in_at < b.checked_in_at ? 1 : -1;
          return a.name.localeCompare(b.name);
        });
      }
      var row = h('div', 'wall-row');
      flat.forEach(function (p) { row.appendChild(chipFor(p)); });
      fresh.appendChild(row);
    }
    wall.textContent = '';
    wall.appendChild(fresh);
    firstRender = false;
    main.classList.add('is-ready');
    swapText(el('board-status'),
      'Updated ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  }

  function refresh() {
    api('/api/status', {}, 'board', authFailed)
      .then(function (data) {
        if (data.ok) { last = data; render(); }
      })
      .catch(function (err) {
        if (err.message !== 'signed out') swapText(el('board-status'), 'Could not reach the server. Retrying.');
      });
  }

  el('filter').addEventListener('input', function (e) { view.q = e.target.value.trim(); render(); });
  el('hide-in').addEventListener('change', function (e) { view.hideIn = e.target.checked; render(); });
  el('hide-out').addEventListener('change', function (e) { view.hideOut = e.target.checked; render(); });
  el('sort').addEventListener('change', function (e) { view.sort = e.target.value; render(); });

  // ---------- auto scroll, for the board on a wall ----------
  // Down the page at a steady pace, a rest at the bottom, back to the top
  // and round again. A hand on the page holds it for a while, so someone
  // reading it can scroll for themselves.
  var AUTO_KEY = 'scs-checkin-board-auto';
  var AUTO_SPEED = 40;    // px a second
  var AUTO_REST = 4000;   // ms at the top and at the bottom
  var AUTO_HELD = 10000;  // ms a person's own scrolling holds it
  var AUTO_BACK = 1200;   // ms the glide back to the top is given
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var auto = { on: false, frame: 0, last: 0, wait: 0, pos: 0, state: 'resume' };
  function scroller() { return document.scrollingElement || document.documentElement; }
  function autoFrame(now) {
    auto.frame = requestAnimationFrame(autoFrame);
    var dt = auto.last ? Math.min(now - auto.last, 100) : 0;
    auto.last = now;
    if (now < auto.wait) return;
    var s = scroller();
    var max = s.scrollHeight - s.clientHeight;
    if (max < 4) return; // the whole wall fits on the screen
    if (auto.state === 'resume') { auto.pos = s.scrollTop; auto.state = 'down'; }
    if (auto.state === 'down') {
      auto.pos = Math.min(max, auto.pos + AUTO_SPEED * dt / 1000);
      s.scrollTop = auto.pos;
      if (auto.pos >= max) { auto.state = 'bottom'; auto.wait = now + AUTO_REST; }
    } else if (auto.state === 'bottom') {
      if (calm) s.scrollTop = 0;
      else window.scrollTo({ top: 0, behavior: 'smooth' });
      auto.state = 'top';
      auto.wait = now + (calm ? 0 : AUTO_BACK) + AUTO_REST;
    } else if (auto.state === 'top') {
      auto.pos = 0;
      auto.state = 'down';
    }
  }
  function stopAuto() {
    cancelAnimationFrame(auto.frame);
    auto.on = false;
  }
  function setAuto(on) {
    stopAuto();
    try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); } catch (err) {}
    if (!on) return;
    auto.on = true;
    auto.state = 'resume';
    auto.last = 0;
    auto.wait = performance.now() + AUTO_REST;
    auto.frame = requestAnimationFrame(autoFrame);
  }
  ['wheel', 'touchstart', 'mousedown', 'keydown'].forEach(function (type) {
    window.addEventListener(type, function () {
      if (!auto.on) return;
      auto.state = 'resume';
      auto.wait = performance.now() + AUTO_HELD;
    }, { passive: true });
  });
  el('auto-scroll').addEventListener('change', function (e) { setAuto(e.target.checked); });

  login = wireLogin('board', function () {
    refresh();
    // a board left in a hidden tab asks nothing; it catches up when shown
    if (!timer) {
      timer = setInterval(function () { if (!document.hidden) refresh(); }, 10000);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
    }
    var kept = false;
    try { kept = localStorage.getItem(AUTO_KEY) === '1'; } catch (err) {}
    el('auto-scroll').checked = kept;
    if (kept && !auto.on) setAuto(true);
  });
`;

export function scanPage() {
  return pageShell('SCS.2 door scanner', 'Door scanner', SCAN_BODY, SCAN_CSS, SCAN_JS);
}

export function boardPage() {
  return pageShell('SCS.2 check-in board', 'Check-in board', BOARD_BODY, BOARD_CSS, BOARD_JS);
}
