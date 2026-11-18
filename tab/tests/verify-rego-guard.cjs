// The rego page's side of the sign-up guard (the worker side is
// verify-rego-guard.mjs; the form itself is verify-rego-page.cjs):
// the status read decides
// whether the form shows at all, the Turnstile widget mounts only
// when the worker hands over a site key, the token rides the send,
// and a failed send resets the widget for a fresh token.
// Run with: node tests/verify-rego-guard.cjs
// Needs playwright nearby and a static server on 8123 serving
// website/ (the test starts one if the port is free).
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'website');   // the site is served from here
const BASE = 'http://127.0.0.1:8123';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fail = 0;
const check = (l, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + l + (d ? '  ' + d : '')); if (!ok) fail++; };
const CORS = { 'access-control-allow-origin': '*' };

// a stand-in for Cloudflare's widget script: records the render, hands
// out a token, counts resets, and calls the page's onload callback
const FAKE_TURNSTILE = `
  window.__ts = { rendered: null, resets: 0 };
  window.turnstile = {
    render: function (el, opts) { window.__ts.rendered = opts.sitekey; el.innerHTML = '<i id="fake-ts"></i>'; return 7; },
    getResponse: function (id) { return 'tok-' + id; },
    reset: function (id) { window.__ts.resets++; }
  };
  var m = /onload=([A-Za-z0-9_]+)/.exec(document.currentScript.src);
  if (m && window[m[1]]) window[m[1]]();
`;

(async () => {
  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await sleep(1200);
  }
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const p = await b.newPage({ serviceWorkers: 'block', viewport: { width: 1100, height: 950 } });
  const errors = []; p.on('pageerror', e => errors.push(e.message));

  let status = { ok: true, open: true, message: '', turnstile: '' };
  let createAnswer = { status: 200, body: { ok: true, team: 'Team Ferrous', members: 1, emails: 1, qrs: 0 } };
  const calls = { create: [], script: 0 };
  await p.route('**/challenges.cloudflare.com/**', r => { calls.script++; r.fulfill({ status: 200, contentType: 'application/javascript', body: FAKE_TURNSTILE }); });
  await p.route('**/files.scs.andyrew.space/**', r => {
    const u = new URL(r.request().url());
    if (u.pathname === '/api/rego/status') return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(status) });
    if (u.pathname === '/api/rego/create') {
      calls.create.push(r.request().postDataJSON());
      return r.fulfill({ status: createAnswer.status, contentType: 'application/json', headers: CORS, body: JSON.stringify(createAnswer.body) });
    }
    return r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: '{}' });
  });

  const fillForm = () => p.evaluate(() => {
    document.getElementById('rg-team').value = 'Team Ferrous';
    document.querySelector('input[name="rg-photo"][value="1"]').click();
    // a team is three people at the least, so every card on the page
    document.querySelectorAll('.rg-member').forEach((card, i) => {
      const boxes = card.querySelectorAll('input[type=text], input[type=email]');
      boxes[0].value = ['Alice Park', 'Ben Ho', 'Cass Fe'][i] || 'Dee Ng';
      boxes[1].value = 'z511111' + i;
      boxes[2].value = 'member' + i + '@example.com';
      if (i === 0) boxes[3].value = 'alicep';
      card.querySelector('input[type=radio]').click();
    });
  });

  // ---------------- open, with the human check on ----------------
  status = { ok: true, open: true, message: '', turnstile: 'site-key-1' };
  await p.goto(BASE + '/rego/');
  await sleep(900);
  const mounted = await p.evaluate(() => ({
    key: window.__ts && window.__ts.rendered,
    widget: !!document.querySelector('#rg-turnstile #fake-ts'),
    formShown: !document.getElementById('rego-form').classList.contains('is-hidden'),
    closedShown: !document.getElementById('rg-closed').classList.contains('is-hidden')
  }));
  check('with a site key from the worker the widget mounts in the form',
    calls.script === 1 && mounted.key === 'site-key-1' && mounted.widget && mounted.formShown && !mounted.closedShown, JSON.stringify(mounted));

  await fillForm();
  await p.click('#rg-send');
  await sleep(400);
  check('the send carries the widget token',
    calls.create.length === 1 && calls.create[0].turnstile === 'tok-7' && calls.create[0].team_name === 'Team Ferrous', JSON.stringify({ t: calls.create[0] && calls.create[0].turnstile }));
  check('a successful send shows the done card', await p.evaluate(() =>
    document.getElementById('rego-form').classList.contains('is-hidden') &&
    document.getElementById('rg-done-line').textContent.includes('Team Ferrous')), '');

  // ---------------- a failed send resets the widget ----------------
  createAnswer = { status: 403, body: { error: 'The check that you are a person did not pass. Reload the page and try again.' } };
  await p.goto(BASE + '/rego/');
  await sleep(900);
  await fillForm();
  await p.click('#rg-send');
  await sleep(400);
  const failed = await p.evaluate(() => ({
    resets: window.__ts.resets,
    line: document.getElementById('rg-status').textContent,
    formShown: !document.getElementById('rego-form').classList.contains('is-hidden')
  }));
  check('a refused send shows the worker\'s message and resets the widget for a fresh token',
    failed.resets >= 1 && failed.line.includes('did not pass') && failed.formShown, JSON.stringify(failed));

  // ---------------- closed ----------------
  status = { ok: true, open: false, message: 'Registrations are full.', turnstile: '' };
  await p.goto(BASE + '/rego/');
  await sleep(900);
  const closed = await p.evaluate(() => ({
    closedShown: !document.getElementById('rg-closed').classList.contains('is-hidden'),
    msg: document.getElementById('rg-closed-msg').textContent,
    formShown: !document.getElementById('rego-form').classList.contains('is-hidden')
  }));
  check('closed, the page says why and the form is gone',
    closed.closedShown && closed.msg === 'Registrations are full.' && !closed.formShown, JSON.stringify(closed));

  // ---------------- open with the check off ----------------
  calls.script = 0;
  status = { ok: true, open: true, message: '', turnstile: '' };
  createAnswer = { status: 200, body: { ok: true, team: 'Team Ferrous', members: 1, emails: 1, qrs: 0 } };
  await p.goto(BASE + '/rego/');
  await sleep(900);
  await fillForm();
  await p.click('#rg-send');
  await sleep(400);
  const plain = calls.create[calls.create.length - 1];
  check('with no site key the widget script never loads and the send carries an empty token',
    calls.script === 0 && plain.turnstile === '' && plain.team_name === 'Team Ferrous', JSON.stringify({ script: calls.script, t: plain.turnstile }));

  console.log('errors', errors);
  check('no page errors', errors.length === 0, errors.join(' | '));

  await b.close();
  if (server) server.kill();
  console.log(fail ? 'FAILURES: ' + fail : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
