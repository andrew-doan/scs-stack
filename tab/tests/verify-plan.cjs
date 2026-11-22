// The route planner: it reads and writes the quest list's own lists,
// so what is ordered or added here is what the quest list shows.
// Run with: node tests/verify-plan.cjs
// Needs playwright nearby and a static server on 8123 serving
// website/ (the test starts one if the port is free).
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const SITE = path.join(__dirname, '..', '..', 'website');
const BASE = 'http://127.0.0.1:8123';
let fail = 0;
const check = (l, ok, d) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + l + (d ? '  ' + d : '')); if (!ok) fail++; };
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };

const q = (key, name, pts, pins, extra) => Object.assign({
  key, name, region: 'City', description: 'Do it.', flavour: '', location: '', coords: pins, submit: 'none', prompt: '', options: [],
  codes: [{ code: key, label: '', points: pts }], files: [], ask: null, keywords: []
}, extra || {});
const list = { regions: ['City'], places: {}, groups: [
  q('SQ1', 'Opera House steps', 50, [{ label: 'Opera House', lat: -33.8568, lng: 151.2153 }]),
  q('SQ2', 'Central clock', 30, [{ label: 'Central Station', lat: -33.8832, lng: 151.2065 }]),
  q('SQ3', 'Bondi lifeguard tower', 80, [{ label: 'Bondi Beach', lat: -33.8908, lng: 151.2743 }]),
  q('SQ4', 'Any campus library', 40, [{ label: 'UNSW Library', lat: -33.9173, lng: 151.2335 }, { label: 'Fisher Library', lat: -33.8866, lng: 151.1903 }]),
  q('SQ5', 'Sing a song', 20, []),
  q('SQ6', 'Tram to the end', 25, [{ label: 'Randwick', lat: -33.9146, lng: 151.2437 }], { keywords: ['train'] })
] };

(async () => {
  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await new Promise(res => setTimeout(res, 1200));
  }
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 },
    geolocation: { latitude: -33.8705, longitude: 151.2090 }, permissions: ['geolocation'] });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('scs2-install-dismissed', '1');
      if (!localStorage.getItem('scs2-questlist-lists')) {
        localStorage.setItem('scs2-questlist-lists', JSON.stringify({ lists: [
          { id: 'saved', name: 'Saved', keys: ['SQ3', 'SQ1', 'SQ5', 'SQ4', 'SQ2', 'GONE'] },
          { id: 'l1', name: 'East', keys: ['SQ3'] }
        ] }));
      }
    } catch (e) { /* none */ }
  });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));
  await p.route(/andyrew\.space/, r => {
    if (r.request().url().includes('/api/questlist')) return r.fulfill({ status: 200, headers: CORS, contentType: 'application/json', body: JSON.stringify(list) });
    return r.fulfill({ status: 404, headers: CORS, body: '{}' });
  });
  const kept = () => p.evaluate(() => JSON.parse(localStorage.getItem('scs2-questlist-lists')).lists);
  const names = () => p.$$eval('.pl-stop-name', els => els.map(e => e.textContent));
  const figure = (i) => p.$eval('#pl-figures', (e, at) => Number(e.querySelectorAll('.figure-n')[at].textContent.replace(/,/g, '')), i);

  await p.goto(BASE + '/plan/?list=saved');
  await p.waitForSelector('#pl-body:not([hidden])', { timeout: 15000 });
  const before = await figure(2);
  check('a list opens as its stops in the list\'s order, a quest no longer on the quest list left out',
    (await names()).join() === 'Bondi lifeguard tower,Opera House steps,Sing a song,Any campus library,Central clock' && (await figure(1)) === 220,
    (await names()).join());

  await p.click('#pl-here');
  await p.waitForFunction(() => document.getElementById('pl-here').textContent === 'Starting From Here');
  await p.click('#pl-short');
  await p.waitForFunction(() => document.querySelector('.pl-stop-name').textContent === 'Opera House steps');
  const lists = await kept();
  check('the shortest order is shorter, puts a quest with no pin last, and is the order the quest list\'s own storage now holds',
    (await figure(2)) < before && (await names()).pop() === 'Sing a song' &&
    lists[0].keys.join() === 'SQ1,SQ2,SQ4,SQ3,SQ5,GONE' && lists[1].keys.join() === 'SQ3',
    JSON.stringify({ before, after: await figure(2), keys: lists[0].keys }));

  await p.fill('#pl-search', 'train');
  await p.waitForSelector('.pl-result');
  await p.click('.pl-result button');
  check('a quest found by its tag is added to the list',
    (await kept())[0].keys.includes('SQ6') && (await names()).includes('Tram to the end'), (await names()).join());

  const href = await p.$eval('.pl-stop .pl-tool[href]', a => a.href);
  check('a stop\'s directions go from where the route was to the stop',
    href.includes('travelmode=transit') && href.includes('destination=-33.8568,151.2153') && href.includes('origin=-33.8705,151.209'), href);

  await p.reload();
  await p.waitForSelector('#pl-body:not([hidden])');
  check('a reload keeps the order', (await names())[0] === 'Opera House steps' && (await names()).length === 6, (await names()).join());
  check('the page raised no errors', errors.length === 0, errors.join(' | '));

  await b.close();
  if (server) server.kill();
  if (fail) { console.log('\n' + fail + ' check(s) failed'); process.exit(1); }
  console.log('\nALL CHECKS PASSED');
})().catch((e) => { console.error(e); process.exit(1); });
