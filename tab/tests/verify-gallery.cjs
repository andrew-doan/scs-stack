// The gallery slideshow: the next three slides download while one is
// on screen and their elements are reused (no fetch when they show),
// and the Random order rocker switches between shuffled and the
// gallery's listing order without losing the slide on screen. Then the
// viewer: the loading bar while a zoom's whole picture comes, and an
// album that comes a page at a time counted whole and walked on into
// its next page. Last, a shared photo's page with the site's full-screen
// view and details.
// Run with: node tests/verify-gallery.cjs
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

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS'
};

// six photos across six submissions, so every slide is identifiable
// by the code on its plate
const SUBS = [1, 2, 3, 4, 5, 6].map(n => ({
  id: n, quest_code: 'SQ' + n, team_name: 'Team ' + n, note: '', submitted_at: '2026-10-20 0' + n + ':00:00',
  media: [{ key: 'sub/p' + n, type: 'image/png', bytes: 1000, name: 'p' + n + '.png' }]
}));

(async () => {
  let server = null;
  const up = await fetch(BASE + '/').then(() => true).catch(() => false);
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await sleep(1200);
  }
  const exe = process.env.CHROMIUM_PATH || (require('fs').existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 800 } });
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('scs2-submit-session', 'gal-session');
      // a long photo hold so the timer never advances under the test,
      // and the listing order so which slide is which is knowable
      localStorage.setItem('scs2-slideshow', JSON.stringify({ photoSecs: 20, random: false }));
    } catch (e) {}
  });
  const p = await ctx.newPage();
  const errors = []; p.on('pageerror', e => errors.push(e.message));

  // 1x1 png; a count per key of full-file requests (thumb=1 is the
  // grid's own loading and does not matter here)
  const dot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64');
  const fullHits = {};
  // how long the whole picture (no res, no thumb) takes to answer
  let wholeDelay = 0;
  // an album of 130, and where each page asked for began
  const ALBUM_SIZE = 130;
  const albumPages = [];
  // who each first page of the album was asked for
  const albumAsks = [];
  // how long a page after the first takes to answer
  let albumDelay = 0;
  // how long an album photo's bigger copies take to answer
  let viewDelay = 0;
  // album pictures whose first ask fails
  const failOnce = { 'alb/crowd2': true };

  await p.route('**/unpkg.com/**', r => r.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await p.route('**/tiles.scs.andyrew.space/**', r => r.fulfill({ status: 404, body: '' }));
  await p.route('**/files.scs.andyrew.space/**', r => {
    const u = new URL(r.request().url());
    const json = o => r.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(o) });
    if (u.pathname === '/api/pulse') return json({ quests: 1, messages: 0, urgent: 0 });
    if (u.pathname === '/api/questlist') return json({ regions: [], groups: [], places: {} });
    if (u.pathname === '/api/submit/gallery') return json({ ok: true, submissions: SUBS });
    if (u.pathname === '/api/album/upload/mode') return json({ ok: true, direct: false });
    if (u.pathname === '/api/album') {
      const from = Number(u.searchParams.get('from') || 0);
      const n = Number(u.searchParams.get('n') || 60);
      albumPages.push(from);
      if (!from) albumAsks.push({ by: u.searchParams.getAll('by'), not: u.searchParams.getAll('not') });
      const keys = [];
      for (let i = from; i < Math.min(ALBUM_SIZE, from + n); i++) keys.push(i);
      const page = () => json({ ok: true, order: 'added', count: ALBUM_SIZE, videos: 0, next: from + n < ALBUM_SIZE ? from + n : null,
        people: from ? undefined : [{ name: 'Team 1', n: ALBUM_SIZE - 4 }, { name: 'Sam', n: 4 }],
        album: { slug: 'crowd', name: 'Crowd', about: '', adding: 'closed', gallery: false, details: false, sort: 1 },
        photos: keys.map(i => ({ key: 'alb/crowd' + i, type: 'image/png', from: 'album', team: 'Team 1', by: '', at: '2026-10-20 01:00:00', w: 4, h: 3 })) });
      return from && albumDelay ? sleep(albumDelay).then(page) : page();
    }
    if (u.pathname === '/api/albums/file') {
      if (failOnce[u.searchParams.get('key')]) {
        delete failOnce[u.searchParams.get('key')];
        return r.fulfill({ status: 503, headers: CORS, body: '' });
      }
      const send = () => r.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: dot });
      return viewDelay && !u.searchParams.get('thumb') ? sleep(viewDelay).then(send) : send();
    }
    if (u.pathname === '/api/submit/file') {
      const key = u.searchParams.get('key');
      if (u.searchParams.get('thumb') !== '1') fullHits[key] = (fullHits[key] || 0) + 1;
      const send = () => r.fulfill({ status: 200, contentType: 'image/png', headers: CORS, body: dot });
      if (wholeDelay && !u.searchParams.get('res') && u.searchParams.get('thumb') !== '1') return sleep(wholeDelay).then(send);
      return send();
    }
    return r.fulfill({ status: 404, contentType: 'application/json', headers: CORS, body: '{}' });
  });

  await p.goto(BASE + '/gallery/');
  await sleep(1200);
  await p.click('#gal-slideshow');
  await sleep(900);

  const plate = () => p.evaluate(() => (document.querySelector('.ss-code') || {}).textContent || '');
  const countText = () => p.evaluate(() => (document.querySelector('.ss-count') || {}).textContent || '');

  check('the show opens on the first listed slide (random off)', await plate() === 'SQ1', await plate());
  check('a photo asks for its viewing copy, not the original',
    await p.evaluate(() => { const s = (document.querySelector('.ss-mat img') || {}).src || ''; return /[?&]res=/.test(s) && !s.includes('res=original'); }), '');
  check('slide and grid photos are CORS-readable, so the worker can keep copies',
    await p.evaluate(() =>
      document.querySelector('.ss-mat img').crossOrigin === 'anonymous' &&
      [...document.querySelectorAll('.gal-open img')].every(i => i.crossOrigin === 'anonymous')), '');

  // ---------- the next three are down before they show ----------
  check('the slide on screen and the next three are fetched, and no more',
    fullHits['sub/p1'] === 1 && fullHits['sub/p2'] === 1 && fullHits['sub/p3'] === 1 &&
    fullHits['sub/p4'] === 1 && !fullHits['sub/p5'] && !fullHits['sub/p6'],
    JSON.stringify(fullHits));

  await p.keyboard.press('ArrowRight');
  await sleep(500);
  check('stepping on shows the next slide', await plate() === 'SQ2', await plate());
  check('its picture was not fetched again — the prepared element is reused',
    fullHits['sub/p2'] === 1, JSON.stringify(fullHits));
  check('and the window moves: one more slide starts downloading',
    fullHits['sub/p5'] === 1 && !fullHits['sub/p6'], JSON.stringify(fullHits));

  // ---------- the bar does not move when you press play ----------
  // Play and pause are different widths as glyphs, so a button sized
  // to its content changed width on every press and shoved the rest of
  // the bar sideways.
  const barBefore = await p.evaluate(() => {
    const b = document.querySelector('.ss-play').getBoundingClientRect();
    const c = document.querySelector('.ss-count').getBoundingClientRect();
    return { w: Math.round(b.width), countLeft: Math.round(c.left), glyph: document.querySelector('.ss-play').textContent };
  });
  await p.click('.ss-play');
  await sleep(200);
  const barAfter = await p.evaluate(() => {
    const b = document.querySelector('.ss-play').getBoundingClientRect();
    const c = document.querySelector('.ss-count').getBoundingClientRect();
    return { w: Math.round(b.width), countLeft: Math.round(c.left), glyph: document.querySelector('.ss-play').textContent };
  });
  await p.click('.ss-play');
  await sleep(200);

  // ---------- the random order rocker ----------
  await p.evaluate(() => { [...document.querySelectorAll('.ss-btn')].find(b => b.textContent === 'Settings').click(); });
  await sleep(200);
  const rocker = await p.evaluate(() => {
    const label = [...document.querySelectorAll('.ss-panel label')].find(l => /Random order/.test(l.textContent));
    if (!label) return null;
    const input = label.querySelector('input');
    return { checked: input.checked };
  });
  check('the settings panel has a Random order rocker, off as stored',
    rocker && rocker.checked === false, JSON.stringify(rocker));

  const before = await plate();
  await p.evaluate(() => {
    const label = [...document.querySelectorAll('.ss-panel label')].find(l => /Random order/.test(l.textContent));
    const input = label.querySelector('input');
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(300);
  check('flipping it on keeps the slide on screen', await plate() === before, await plate());
  check('and stores the choice', await p.evaluate(() => JSON.parse(localStorage.getItem('scs2-slideshow')).random) === true, '');

  // back to the listing order: the count line says where this slide
  // sits in it, and stepping continues from there in order
  await p.evaluate(() => {
    const label = [...document.querySelectorAll('.ss-panel label')].find(l => /Random order/.test(l.textContent));
    const input = label.querySelector('input');
    input.checked = false;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await sleep(300);
  check('off again, the count line places the slide in the listing order',
    await countText() === '2 / 6', await countText());
  // the order changes re-primed the pool; whatever the coming-up
  // slides cost is already spent, so showing them must fetch nothing
  await sleep(300);
  const snap3 = fullHits['sub/p3'] || 0;
  const snap4 = fullHits['sub/p4'] || 0;
  await p.keyboard.press('ArrowRight');
  await sleep(400);
  await p.keyboard.press('ArrowRight');
  await sleep(400);
  check('and stepping continues down the listing', await plate() === 'SQ4', await plate());
  check('the slides shown after the order changes came from the pool, not the network',
    fullHits['sub/p3'] === snap3 && fullHits['sub/p4'] === snap4, JSON.stringify(fullHits));

  await p.keyboard.press('Escape');
  await sleep(400);
  check('Escape ends the show', await p.evaluate(() => !document.querySelector('.ss-overlay')), '');

  // ---------- the whole picture's loading bar ----------
  // A zoom in the viewer asks for the whole picture. While it comes the
  // site's loading bar runs along the top; once it is in, the bar goes
  // and the photo shows it.
  wholeDelay = 1500;
  await p.click('.gal-open');
  await sleep(600);
  await p.keyboard.press('Equal');
  await sleep(700);
  const loading = await p.evaluate(() => {
    const bar = document.querySelector('.lb-overlay .lb-load');
    return !!bar && bar.classList.contains('is-going') && getComputedStyle(bar).opacity === '1';
  });
  await sleep(1700);
  const landed = await p.evaluate(() => ({
    going: document.querySelector('.lb-overlay .lb-load').classList.contains('is-going'),
    src: document.querySelector('.lb-overlay img.lb-media').src.slice(0, 5)
  }));
  check('the loading bar runs while the whole picture comes, and goes once the photo shows it',
    loading && !landed.going && landed.src === 'blob:', JSON.stringify({ loading, landed }));
  wholeDelay = 0;
  await p.keyboard.press('Escape');
  await sleep(400);

  // ---------- an album's viewer runs on past the page it opened in ----------
  await p.goto(BASE + '/albums/?a=crowd');
  await p.waitForSelector('.alb-tile img');
  await sleep(1600);
  const cameBack = await p.evaluate(() => {
    const img = document.querySelector('.alb-tile img[data-src*="crowd2&"]');
    return img ? { loaded: img.complete && img.naturalWidth > 0, src: img.getAttribute('src') } : null;
  });
  check('a picture whose first request fails is asked for again rather than left grey',
    !!cameBack && cameBack.loaded && /again=/.test(cameBack.src), JSON.stringify(cameBack));
  viewDelay = 900;
  await p.click('.alb-tile');
  await p.waitForSelector('.lb-overlay .lb-counter');
  const shownSrc = () => p.evaluate(() => document.querySelector('.lb-overlay img.lb-media').src.replace(/^.*\?/, ''));
  const atOnce = await shownSrc();
  await sleep(1300);
  const later = await shownSrc();
  viewDelay = 0;
  check('a photo opens on the small copy the grid already has, and a bigger one takes over once it has come',
    /thumb=1/.test(atOnce) && !/thumb=1/.test(later), JSON.stringify({ atOnce, later }));
  const opened = await p.textContent('.lb-counter');
  await p.keyboard.press('ArrowLeft');
  await sleep(150);
  const stayed = await p.textContent('.lb-counter');
  for (let i = 0; i < 61; i++) { await p.keyboard.press('ArrowRight'); await sleep(20); }
  await sleep(600);
  const ranOn = await p.textContent('.lb-counter');
  check('an album\'s viewer counts the whole album, stays put back from the first, and runs on into the next page rather than going round',
    opened === '1 / 130' && stayed === '1 / 130' && ranOn === '62 / 130' && albumPages.includes(60),
    JSON.stringify({ opened, stayed, ranOn, albumPages }));
  await p.keyboard.press('Escape');
  await sleep(300);

  // the foot of the album: a bar while the last page is on its way, and
  // the count once everything has come
  albumDelay = 1500;
  const foot = () => p.evaluate(() => { const f = document.querySelector('.alb-more'); return { cls: f.className, role: f.getAttribute('role'), text: f.textContent }; });
  const toBottom = () => p.evaluate(() => { document.body.scrollTop = document.body.scrollHeight; });
  let waiting = null;
  for (let i = 0; i < 40 && !waiting; i++) {
    await toBottom();
    await sleep(150);
    if (albumPages.includes(120)) waiting = await foot();
  }
  albumDelay = 0;
  let ended = await foot();
  for (let i = 0; i < 40 && !/is-end/.test(ended.cls); i++) {
    await toBottom();
    await sleep(150);
    ended = await foot();
  }
  check('an album\'s foot runs a bar while the rest is on its way and says what the album holds once it has all come',
    !!waiting && /is-loading/.test(waiting.cls) && waiting.role === 'progressbar' &&
    /is-end/.test(ended.cls) && ended.text === '130 photos' && ended.role === null,
    JSON.stringify({ waiting, ended }));

  // ---------- whose photos ----------
  // by= in the address goes into the album's read, a tap on a person
  // reads it again with them and writes them into the address, Leave out
  // turns by= into not=, and a name's cross under the counts takes it off
  {
    albumAsks.length = 0;
    await p.goto(BASE + '/albums/?a=crowd&by=Team%201');
    await p.waitForSelector('.alb-tile img');
    await sleep(300);
    const first = JSON.stringify(albumAsks[0]);
    await p.click('#alb-who-btn');
    await sleep(500);
    const pressed = await p.evaluate(() => [...document.querySelectorAll('.alb-person')].map(b => b.getAttribute('data-name') + ':' + b.getAttribute('aria-pressed')).join());
    const state = async () => ({ ask: JSON.stringify(albumAsks[albumAsks.length - 1]), url: await p.evaluate(() => decodeURIComponent(location.search.replace(/\+/g, ' '))),
      tags: await p.evaluate(() => [...document.querySelectorAll('.alb-tag')].map(t => t.getAttribute('data-name')).join()) });
    await p.click('.alb-person[data-name="Sam"]');
    await sleep(700);
    const both = await state();
    await p.click('#alb-mode button[data-mode="not"]');
    await sleep(700);
    const leftOut = await state();
    await p.click('.alb-tag[data-name="Team 1"]');
    await sleep(700);
    const one = await state();
    check('an album filters by who added its photos from its address, a tap on a person and the way it goes, and the address follows',
      first === '{"by":["Team 1"],"not":[]}' && pressed === 'Team 1:true,Sam:false' &&
      both.ask === '{"by":["Team 1","Sam"],"not":[]}' && both.url === '?a=crowd&by=Team 1&by=Sam' && both.tags === 'Team 1,Sam' &&
      leftOut.ask === '{"by":[],"not":["Team 1","Sam"]}' && leftOut.url === '?a=crowd&not=Team 1&not=Sam' &&
      one.ask === '{"by":[],"not":["Sam"]}' && one.url === '?a=crowd&not=Sam' && one.tags === 'Sam',
      JSON.stringify({ first, pressed, both, leftOut, one }));
  }

  // ---------- a video with no still ----------
  // The worker answers 404 for its thumbnail; the page takes a frame from
  // the smallest copy for the tile and the viewer's poster. The copy is a
  // WebM recorded here, since this Chromium plays no H.264.
  {
    const clip = Buffer.from(await p.evaluate(() => new Promise(resolve => {
      const c = document.createElement('canvas');
      c.width = 320; c.height = 240;
      const g = c.getContext('2d');
      const rec = new MediaRecorder(c.captureStream(15), { mimeType: 'video/webm;codecs=vp8' });
      const parts = [];
      rec.ondataavailable = e => parts.push(e.data);
      rec.onstop = () => new Blob(parts).arrayBuffer().then(buf => {
        let s = '';
        new Uint8Array(buf).forEach(x => { s += String.fromCharCode(x); });
        resolve(btoa(s));
      });
      const paint = setInterval(() => { g.fillStyle = '#e8701a'; g.fillRect(0, 0, 320, 240); }, 30);
      rec.start();
      setTimeout(() => { rec.stop(); clearInterval(paint); }, 2500);
    })), 'base64');
    const vp = await ctx.newPage();
    vp.on('pageerror', e => errors.push(e.message));
    await vp.route('**/files.scs.andyrew.space/**', r => {
      const u = new URL(r.request().url());
      const json = (o, status) => r.fulfill({ status: status || 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(o) });
      if (u.pathname === '/api/album') {
        return json({ ok: true, order: 'added', count: 1, videos: 1, next: null,
          album: { slug: 'clips', name: 'Clips', about: '', adding: 'closed', gallery: false, details: false, sort: 1 },
          photos: [{ key: 'alb/clip1', type: 'video/mp4', from: 'album', team: 'Team 1', by: '', at: '2026-10-20 01:00:00', w: 4, h: 3, heights: [480] }] });
      }
      if (u.pathname === '/api/albums/file') {
        if (u.searchParams.get('thumb')) return json({ error: 'no still' }, 404);
        return r.fulfill({ status: 200, contentType: 'video/webm', headers: CORS, body: clip });
      }
      if (u.pathname === '/api/pulse') return json({ quests: 1, messages: 0, urgent: 0 });
      return json({}, 404);
    });
    await vp.goto(BASE + '/albums/?a=clips');
    await vp.waitForSelector('.alb-tile img');
    let tile = null;
    for (let i = 0; i < 40 && !(tile && tile.drawn); i++) {
      await sleep(250);
      tile = await vp.evaluate(() => {
        const img = document.querySelector('.alb-tile img');
        const c = document.createElement('canvas');
        c.width = c.height = 1;
        let px = null;
        if (img.complete && img.naturalWidth) {
          c.getContext('2d').drawImage(img, 0, 0, 1, 1);
          px = [...c.getContext('2d').getImageData(0, 0, 1, 1).data].slice(0, 3);
        }
        return { src: (img.getAttribute('src') || '').slice(0, 5), w: img.naturalWidth, px, drawn: !!px && !img.classList.contains('is-missing') };
      });
    }
    await vp.click('.alb-tile');
    await vp.waitForSelector('.lb-overlay video.lb-media');
    const poster = await vp.evaluate(() => document.querySelector('.lb-overlay video.lb-media').poster.slice(0, 5));
    check('a video with no still gets a frame from its smallest copy on its tile and as the viewer\'s poster',
      tile && tile.drawn && tile.src === 'blob:' && tile.w === 320 &&
      tile.px[0] > 180 && tile.px[2] < 80 && poster === 'blob:',
      JSON.stringify({ tile, poster }));
    await vp.close();
  }

  // ---------- a shared photo's page: the worker's page, the site's viewer ----------
  // The page is the worker's (sharepage.js) and the full-screen view and
  // the details rows are the site's files, loaded from SITE_URL, so the
  // two halves have to agree. A made-up photo in an album showing details.
  {
    const { mediaPage } = await import(path.join(ROOT, 'tab', 'src', 'sharepage.ts'));
    const held = { details: 1, hidden: 0, team_hidden: 0, show_hidden: 0, file_status: 'ready', content_type: 'image/jpeg',
      file_name: 'IMG_0412.jpg', bytes: 2400000, width: 1600, height: 1200, added_at: '2026-10-24 23:10:00', added_by: '', taken_at: '', team: 'Platform Nine' };
    const db = { prepare: () => ({ bind: () => ({ first: async () => held, all: async () => ({ results: [] }) }) }) };
    const API = 'http://files.test';
    // the site's files under a host of their own: a page on a public
    // address may not load from this machine's server
    const SITE_HOST = 'http://site.test';
    const shareHtml = await (await mediaPage({ SITE_URL: SITE_HOST, PUBLIC_API: API, DB: db }, new URL(API + '/photo/abc'),
      { key: 'alb/sharedphoto01', type: 'image/jpeg', from: 'album', who: 'Platform Nine', by: 'team', w: 1600, h: 1200 })).text();
    const pic = '<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1200"><rect width="1600" height="1200" fill="#7ab"/>' +
      '<circle cx="1100" cy="380" r="140" fill="#fff4c2"/><rect y="860" width="1600" height="340" fill="#2d4a3a"/></svg>';
    const info = { ok: true, name: 'IMG_0412.jpg', type: 'image/jpeg', bytes: 2400000, w: 1600, h: 1200, taken: '2026-10-24 22:41:07',
      offset: '+11:00', at: '2026-10-24 23:10:00', by: 'Platform Nine', quest: '', camera: 'Pixel 9', fnumber: 1.7, exposure: 0.004, iso: 64,
      focal: 6.9, gps: { lat: -33.91732, lng: 151.23112, alt: 41 } };
    const phone = await b.newContext({ serviceWorkers: 'block', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const sp = await phone.newPage();
    const shareErrors = [];
    sp.on('pageerror', e => shareErrors.push(e.message));
    await sp.route(API + '/photo/abc', r => r.fulfill({ status: 200, contentType: 'text/html', body: shareHtml }));
    await sp.route(SITE_HOST + '/**', r => {
      const file = path.join(SITE, new URL(r.request().url()).pathname);
      if (!/\.js$/.test(file) || !require('fs').existsSync(file)) return r.fulfill({ status: 404, body: '' });
      return r.fulfill({ status: 200, contentType: 'text/javascript', body: require('fs').readFileSync(file) });
    });
    await sp.route(API + '/api/albums/file/**', r => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: pic }));
    await sp.route(API + '/api/albums/info**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(info) }));
    await sp.goto(API + '/photo/abc');
    await sleep(600);
    await sp.tap('#ph-i');
    await sp.waitForSelector('.pv img.pv-media');
    await sleep(700);
    const cdp = await phone.newCDPSession(sp);
    const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((q, i) => ({ x: q[0], y: q[1], id: i })) });
    for (let i = 0; i < 2; i++) { await touch('touchStart', [[195, 422]]); await touch('touchEnd', []); await sleep(120); }
    await sleep(400);
    const zoom = await sp.evaluate(() => new DOMMatrix(getComputedStyle(document.querySelector('.pv-media')).transform).a);
    await sp.tap('.pv-acts [aria-label="Details"]');
    await sleep(600);
    const rows = await sp.evaluate(() => [...document.querySelectorAll('#ph-info .qs-info-title')].map(n => n.textContent));
    await sp.keyboard.press('Escape');
    await sleep(400);
    const afterEscape = await sp.evaluate(() => ({ sheet: !document.getElementById('ph-info').hidden, viewer: !!document.querySelector('.pv') }));
    await sp.goBack();
    await sleep(500);
    const afterBack = await sp.evaluate(() => ({ viewer: !!document.querySelector('.pv'), at: location.href }));
    check('a shared photo\'s page opens it on the whole screen with the site\'s viewer, which zooms, shows its details over it, and closes on back without leaving the page',
      Math.abs(zoom - 2.5) < 0.01 && rows.length === 5 && rows[3] === '-33.91732, 151.23112' && !afterEscape.sheet && afterEscape.viewer &&
      !afterBack.viewer && afterBack.at === API + '/photo/abc' && !shareErrors.length,
      JSON.stringify({ zoom, rows, afterEscape, afterBack, shareErrors }));
    await phone.close();
  }

  // ---------- a PDF's page: the worker's controls, the site's PDF.js ----------
  // The page loads PDF.js from SITE_URL and leans on its TextLayer, its
  // --scale-factor and its link annotations and destinations, so a new
  // copy of PDF.js can break the text, the zoom or the links from another
  // folder. A made-up three-page PDF with a web link and a page link.
  {
    const { mediaPage } = await import(path.join(ROOT, 'tab', 'src', 'sharepage.ts'));
    const maker = await b.newPage();
    await maker.setContent('<style>section{page-break-after:always;padding:20mm;font:14pt Helvetica,Arial}</style>' +
      [1, 2, 3].map(i => '<section><h1 id="p' + i + '">Rules page ' + i + '</h1><p>Keep the receipt from every station.</p>' +
        (i === 1 ? '<p><a href="https://example.com/rules">Full rules</a> and <a href="#p2">page two</a></p>' : '') + '</section>').join(''));
    const pdfBytes = await maker.pdf({ format: 'A4' });
    await maker.close();
    const API = 'http://files.test', SITE_HOST = 'http://site.test', at = API + '/api/drop/rulesbook0001/rules.pdf';
    const html = await (await mediaPage({ SITE_URL: SITE_HOST, PUBLIC_API: API, DB: null }, new URL(at),
      { key: 'drop/rulesbook0001', type: 'application/pdf', base: '/api/drop/rulesbook0001/', name: 'rules.pdf', bytes: pdfBytes.length })).text();
    const ctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
    const pp = await ctx.newPage();
    const pdfErrors = [];
    pp.on('pageerror', e => pdfErrors.push(e.message));
    await pp.route(API + '/**', r => new URL(r.request().url()).searchParams.get('raw') === '1' ?
      r.fulfill({ status: 200, contentType: 'application/pdf', body: pdfBytes }) : r.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await pp.route(SITE_HOST + '/**', r => {
      const file = path.join(SITE, new URL(r.request().url()).pathname);
      if (!/\.m?js$/.test(file) || !require('fs').existsSync(file)) return r.fulfill({ status: 404, body: '' });
      return r.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'access-control-allow-origin': '*' }, body: require('fs').readFileSync(file) });
    });
    await pp.goto(at);
    await pp.waitForSelector('.ph-page canvas', { timeout: 15000 }).catch(() => {});
    await sleep(600);
    const first = await pp.evaluate(() => {
      const page = document.querySelector('.ph-page'), words = page && page.querySelector('.textLayer');
      const sel = getSelection(), range = document.createRange();
      if (words) { range.selectNodeContents(words); sel.removeAllRanges(); sel.addRange(range); }
      const web = document.querySelector('.ph-links a[href="https://example.com/rules"]'), r = web && web.getBoundingClientRect();
      return { of: document.getElementById('ph-of').textContent, w: page ? page.offsetWidth : 0, text: sel.toString().replace(/\s+/g, ' ').trim(),
        web: !!web && web.rel === 'noopener noreferrer' && web.target === '_blank' && document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === web };
    });
    await pp.click('.ph-links a[href="#"]').catch(() => {});
    await sleep(300);
    first.linked = await pp.evaluate(() => document.getElementById('ph-at-n').value);
    await pp.fill('#ph-at-n', '3');
    await pp.press('#ph-at-n', 'Enter');
    await sleep(300);
    await pp.click('#ph-in');
    await sleep(500);
    const after = await pp.evaluate(() => {
      const view = document.getElementById('ph-view'), third = document.querySelectorAll('.ph-page')[2];
      return { zoom: document.getElementById('ph-zoom').value, w: third.offsetWidth, top: Math.round(third.getBoundingClientRect().top - view.getBoundingClientRect().top),
        words: !!third.querySelector('.textLayer span') };
    });
    check('a PDF\'s page draws its pages with the site\'s PDF.js and lays their text and links over them; the page box, a page link and zoom move and scale it',
      first.of === '/ 3' && first.w > 700 && /^Rules page 1 Keep the receipt from every station\./.test(first.text) && first.web && first.linked === '2' &&
      after.zoom === '1.25' && Math.abs(after.w - first.w * 1.25) < 2 && after.top > -after.w && after.top < 200 && after.words && !pdfErrors.length,
      JSON.stringify({ first, after, pdfErrors }));
    await ctx.close();
  }

  console.log('errors', errors);
  check('no page errors', errors.length === 0, errors.join(' | '));

  await b.close();
  if (server) server.kill();
  console.log(fail ? 'FAILURES: ' + fail : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})();
