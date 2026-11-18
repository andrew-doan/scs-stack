// Run with: node tests/verify-rego-page.cjs
// Drives the site's /rego page in a real browser: the member cards,
// client-side guardrails, the exact JSON that reaches the worker, and
// the success state. Then the /terms page a confirmation email links
// to: what it asks the worker and what it sends back to accept. Needs playwright nearby and a static server on
// 8123 serving website/ (started here if the port is free).
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const SITE = path.join(ROOT, 'website');   // the site is served from here
const BASE = 'http://127.0.0.1:8123';
let fail = 0;
const check = (l, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + l + (d ? '  ' + d : '')); if (!ok) fail++; };

(async () => {
  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await new Promise(res => setTimeout(res, 1200));
  }

  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const p = await b.newPage({ serviceWorkers: 'block', viewport: { width: 1100, height: 1200 } });

  const posts = [];
  await p.route('**/files.scs.andyrew.space/**', async r => {
    if (r.request().url().includes('/api/rego/create')) {
      posts.push(r.request().postDataJSON());
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: true, team: 'Loco Motive', members: 2, emails: 2,
          terms_url: 'https://scs.andyrew.space/terms/?k=lead-key-0123456789abcd' }) });
    }
    return r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });

  await p.goto(BASE + '/rego/');
  await p.waitForTimeout(700);

  // a team is three to five, so the smallest one is already on the page
  check('the page opens on three member cards, the first of them the filler',
    (await p.$$eval('.rg-member', els => els.length)) === 3 &&
    (await p.textContent('.rg-member-head span')) === 'You', '');
  check('all eleven societies are on offer, and none of them',
    (await p.$$eval('#rg-societies label', els => els.map(e => e.textContent.trim()))).includes('GeoGuessrSoc') &&
    (await p.$$eval('#rg-societies input', els => els.length)) === 12, '');

  await p.click('#rg-add');
  await p.click('#rg-add');
  await p.waitForTimeout(200);
  check('members can be added up to five',
    (await p.$$eval('.rg-member', els => els.length)) === 5, '');
  await p.$$eval('.rg-member-head button', btns => btns[btns.length - 1].click());
  await p.waitForTimeout(200);
  check('the fourth and fifth can be taken off again, and only they',
    (await p.$$eval('.rg-member', els => els.length)) === 4 &&
    (await p.$$eval('.rg-member-head button', els => els.filter(e => !e.hidden).length)) === 1, '');

  // fill the form
  await p.fill('#rg-team', 'Loco Motive');
  await p.evaluate(() => {
    document.querySelectorAll('#rg-societies input')[0].click(); // WestSoc
    document.querySelector('input[name="rg-photo"][value="1"]').click();
  });
  await p.evaluate(() => {
    const cards = document.querySelectorAll('.rg-member');
    cards.forEach((card, i) => {
      const inputs = card.querySelectorAll('input[type="text"], input[type="email"]');
      inputs[0].value = i === 0 ? 'Alice Park' : 'Ben Ho';        // name
      inputs[1].value = i === 0 ? 'z5111111' : 'z0000000';        // zid
      inputs[2].value = i === 0 ? 'alice@example.com' : 'ben@example.com';
      inputs[3].value = i === 0 ? 'alicep' : '';                  // discord
      card.querySelectorAll('.rg-radio input')[0].click();        // arc yes
      card.querySelectorAll('.rg-checks input')[1].click();       // Vegan
    });
  });

  // nobody agrees to the terms on anybody else's behalf: each person
  // accepts from their own email, so the form has nothing to tick
  await p.click('#rg-send');
  await p.waitForTimeout(500);

  const sent = posts[0];
  check('the signup posts the whole team in one JSON body',
    posts.length === 1 && sent.team_name === 'Loco Motive' && sent.members.length === 4 &&
    sent.photo_permission === true && JSON.stringify(sent.societies) === '["WestSoc"]', JSON.stringify(sent && sent.societies));
  check('members carry zID, email, arc and dietary, and no agreement made for them',
    sent.members[0].zid === 'z5111111' && sent.members[0].discord === 'alicep' &&
    sent.members[1].zid === 'z0000000' && sent.members[1].email === 'ben@example.com' &&
    sent.members.every(m => m.arc === true && !('agreed' in m) && m.dietary === 'Vegan'),
    JSON.stringify(sent.members));
  check('the honeypot stays empty for people', sent.website === '', '');
  check('success swaps the form for the confirmation, with the signer\'s own terms link',
    await p.$eval('#rego-form', el => el.classList.contains('is-hidden')) &&
    (await p.textContent('#rg-done-line')).includes('Loco Motive') &&
    (await p.getAttribute('#rg-done-terms-link', 'href')) === 'https://scs.andyrew.space/terms/?k=lead-key-0123456789abcd' &&
    await p.isVisible('#rg-done-terms-link'), '');

  // ---- without a team: one or two people and no team name, and None
  // of the above sends no society rather than one called that ----
  const s = await b.newPage({ serviceWorkers: 'block', viewport: { width: 1100, height: 1200 } });
  const soloPosts = [];
  await s.route('**/files.scs.andyrew.space/**', async r => {
    const create = r.request().url().includes('/api/rego/create');
    if (create) soloPosts.push(r.request().postDataJSON());
    return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(create ? { ok: true, solo: true, team: '', members: 2, emails: 2 } : { ok: true, open: true }) });
  });
  await s.goto(BASE + '/rego/');
  await s.waitForTimeout(500);
  await s.check('input[name="rg-mode"][value="solo"]');
  await s.click('#rg-add');
  await s.evaluate(() => {
    const boxes = document.querySelectorAll('#rg-societies input');
    boxes[0].click();
    boxes[boxes.length - 1].click(); // None of the above, which takes WestSoc off
    document.querySelector('input[name="rg-photo"][value="0"]').click();
    document.querySelectorAll('.rg-member').forEach((card, i) => {
      if (card.hidden) return;
      const inputs = card.querySelectorAll('input[type="text"], input[type="email"]');
      inputs[0].value = ['Sol Oh', 'Pia Ir'][i];
      inputs[1].value = 'z570000' + (i + 1);
      inputs[2].value = 'p' + i + '@example.com';
      card.querySelectorAll('.rg-radio input')[0].click();
    });
  });
  await s.click('#rg-send');
  await s.waitForTimeout(500);
  const solo = soloPosts[0];
  check('a signup without a team posts solo, no team name, its two people and no societies',
    !!solo && solo.solo === true && solo.team_name === '' && solo.members.length === 2 &&
    solo.members[1].name === 'Pia Ir' && solo.societies.length === 0,
    JSON.stringify(solo && { solo: solo.solo, team: solo.team_name, n: solo.members.length, soc: solo.societies }));
  await s.close();

  // ---- the terms page ----
  const KEY = 'ben-key-0123456789abcdefg';
  const termsCalls = [];
  let acceptedAt = null;
  const t = await b.newPage({ serviceWorkers: 'block', viewport: { width: 1100, height: 1000 } });
  await t.route('**/files.scs.andyrew.space/**', async r => {
    const req = r.request();
    if (req.url().includes('/api/rego/terms')) {
      termsCalls.push({ method: req.method(), url: req.url(), body: req.method() === 'POST' ? req.postDataJSON() : null });
      if (req.method() === 'POST' && req.postDataJSON().accept !== false) acceptedAt = '2026-10-07 01:02:03';
      const photo = req.method() === 'POST' ? req.postDataJSON().photo : null;
      return r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: true, name: 'Ben Ho', team: 'Loco Motive', accepted_at: acceptedAt, photo: photo }) });
    }
    return r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
  await t.goto(BASE + '/terms/?k=' + KEY);
  await t.waitForTimeout(500);
  check('opened from an email, the terms page asks the worker who the key is for and says so',
    termsCalls.length === 1 && termsCalls[0].method === 'GET' && termsCalls[0].url.endsWith('/api/rego/terms?k=' + KEY) &&
    (await t.textContent('#tc-who-line')).includes('Ben Ho') && await t.isVisible('#tc-accept-btn'),
    JSON.stringify(termsCalls));
  // each person answers the photo question for themselves, with the
  // acceptance; accepting without an answer sends nothing
  await t.click('#tc-accept-btn');
  await t.waitForTimeout(300);
  const unanswered = termsCalls.length;
  await t.check('input[name="tc-photo"][value="0"]');
  await t.click('#tc-accept-btn');
  await t.waitForTimeout(500);
  check('accepting posts that key with their own photo answer and shows it accepted',
    unanswered === 1 && termsCalls.length === 2 && termsCalls[1].method === 'POST' && termsCalls[1].body.k === KEY &&
    termsCalls[1].body.photo === false && termsCalls[1].body.accept !== false &&
    !(await t.isVisible('#tc-accept-btn')) && (await t.textContent('#tc-status')).includes('Accepted') &&
    (await t.textContent('#tc-who-line')).includes('accepted'), JSON.stringify(termsCalls));
  await t.check('input[name="tc-photo"][value="1"]');
  await t.waitForTimeout(400);
  check('after accepting, changing the answer saves it on its own without accepting again',
    termsCalls.length === 3 && termsCalls[2].body.photo === true && termsCalls[2].body.accept === false &&
    (await t.textContent('#tc-photo-status')).includes('Saved'), JSON.stringify(termsCalls[2]));
  await t.goto(BASE + '/terms/');
  await t.waitForTimeout(300);
  check('without a key it is the terms and nothing to accept',
    termsCalls.length === 3 && !(await t.isVisible('#tc-accept')) && !(await t.isVisible('#tc-photo')) && !(await t.isVisible('#tc-who-line')) &&
    (await t.textContent('#tc-terms')).includes('Governing law'), '');

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  await b.close();
  if (server) server.kill();
  process.exit(fail === 0 ? 0 : 1);
})();
