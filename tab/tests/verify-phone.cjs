// The dashboard's Payphones card, the real page against the real
// worker: what the card sends is what the worker keeps, for the
// settings, a payphone and the phone tree.
// Run with: node tests/verify-phone.cjs
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BOT = path.join(__dirname, '..');
let fail = 0;
const check = (l, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + l + (d ? '  ' + d : '')); if (!ok) fail++; };

(async () => {
  const { DatabaseSync } = require('node:sqlite');
  const { d1Shim } = await import('./d1-shim.mjs');
  const { consoleSignIn } = await import('./console-signin.mjs');
  const raw = new DatabaseSync(':memory:');
  raw.exec(fs.readFileSync(BOT + '/schema.sql', 'utf8'));
  raw.exec(`
    INSERT INTO teams (id, name) VALUES (1, 'Opal Tappers');
    INSERT INTO quest_groups (id, key, name) VALUES (1, 'PHONES', 'Payphone tag');
    INSERT INTO quests (code, norm, points, group_id, scoring, most) VALUES ('PH', 'PH', 10, 1, 'unit', 30);
    INSERT INTO site_flags (name, value) VALUES ('ledger_seeded', 1);
  `);
  const db = d1Shim(raw);
  globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };
  const mod = await import('../src/index.ts');
  const env = { DB: db, CONSOLE_PASSWORD: 'tab-pass', PHONE_SYNC_KEY: 'phone-key-phone-key' };
  const front = (req) => mod.default.fetch(req, env, { waitUntil() {} });
  const jpost = (p2, body, key) => front(new Request('https://bot.example' + p2, {
    method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, key ? { authorization: 'Bearer ' + key } : {}), body: JSON.stringify(body)
  }));
  const session = (await consoleSignIn(jpost, 'Tab', 'tab-pass')).session;

  const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const p = await b.newPage({ serviceWorkers: 'block', viewport: { width: 1100, height: 1400 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.route('https://bot.example/**', async (route) => {
    const req = route.request();
    const body = ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer();
    const res = await front(new Request(req.url(), { method: req.method(), headers: req.headers(), body }));
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) });
  });
  await p.addInitScript((s) => { try { localStorage.setItem('scs-console-session', s); } catch (e) { /* none */ } }, session);
  await p.goto('https://bot.example/dash');
  await p.waitForSelector('#main.is-ready', { timeout: 15000 });
  await p.evaluate(() => document.querySelector('[data-tab="quests"]').click());
  await p.click('#quest-phones-toggle');
  const card = p.locator('#quest-phones');
  await card.locator('h4', { hasText: 'What a call hears' }).waitFor({ timeout: 10000 });
  const said = (re) => p.waitForFunction((src) => new RegExp(src).test((document.getElementById('toast') || {}).textContent || ''), re, { timeout: 10000 });

  // ---- settings ----
  await card.locator('select').first().selectOption('PH');
  await card.locator('input[placeholder="02 9385 0000"]').fill('02 9385 0000');
  await card.locator('button', { hasText: /^Save$/ }).first().click();
  await said('Saved');
  await card.locator('label', { hasText: 'Count captures' }).locator('input').check();
  await said('Captures count');
  const text = (name) => (raw.prepare('SELECT value FROM site_text WHERE name = ?').get(name) || {}).value;
  check('the code, the number and the switch the card sends are what the worker keeps',
    text('phone_code') === 'PH' && text('phone_number') === '02 9385 0000' && text('phone_open') === '1', JSON.stringify([text('phone_code'), text('phone_number'), text('phone_open')]));

  // ---- a payphone ----
  await card.locator('input[placeholder^="A payphone"]').fill('02 9385 0001');
  await card.locator('input[placeholder="Where it is"]').first().fill('Anzac Parade');
  await card.locator('button', { hasText: 'Add a payphone' }).click();
  await said('Added');
  const phone = raw.prepare('SELECT number, name, state FROM payphones').get();
  check('a payphone typed in is kept as one, under its full number',
    !!phone && phone.number === '+61293850001' && phone.name === 'Anzac Parade' && phone.state === 'ok', JSON.stringify(phone));

  // ---- the tree ----
  await card.locator('button', { hasText: 'Add a step' }).click();
  await card.locator('button', { hasText: 'Add a step' }).click();
  const stepCards = card.locator('.phone-step');
  // step-1 becomes the menu a call starts at, step-2 a message from a team
  await stepCards.nth(1).locator('select').first().selectOption('menu');
  await stepCards.nth(1).locator('textarea').fill('Press 1 to capture. Press 2 to leave a message.');
  await stepCards.nth(1).locator('input[placeholder="1=capture 2=message"]').fill('1=capture 2=step-2');
  await stepCards.nth(2).locator('select').first().selectOption('record');
  await stepCards.nth(2).locator('textarea').fill('Leave your message after the beep.');
  await stepCards.nth(2).locator('input[type="number"]').fill('30');
  await stepCards.nth(2).locator('label', { hasText: 'Ask for the team' }).locator('input').check();
  await card.locator('label', { hasText: 'A call starts at' }).locator('select').selectOption('step-1');
  await p.screenshot({ path: process.env.PHONE_SHOT || path.join(require('os').tmpdir(), 'phone-card.png'), fullPage: true });
  await card.locator('button', { hasText: 'Save what a call hears' }).click();
  await said('The next call hears it');
  const tree = JSON.parse(text('phone_tree') || '{}');
  check('the tree built on the card is the tree the worker keeps',
    tree.start === 'step-1' && tree.nodes['step-1'].kind === 'menu' && tree.nodes['step-1'].options['2'] === 'step-2' &&
    tree.nodes['step-2'].kind === 'record' && tree.nodes['step-2'].max === 30 && tree.nodes['step-2'].pin === true &&
    tree.nodes.capture.kind === 'capture', JSON.stringify(tree));
  const d = await (await jpost('/api/phone/step', { from: '+61293850001', call: 'CA1' }, env.PHONE_SYNC_KEY)).json();
  check('and the next call hears it', d.actions[0].gather && d.actions[0].gather.say.startsWith('Press 1'), JSON.stringify(d.actions));
  check('the page raised no errors', errors.length === 0, errors.join(' | '));

  await b.close();
  if (fail) { console.log('\n' + fail + ' check(s) failed'); process.exit(1); }
  console.log('\nALL CHECKS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
