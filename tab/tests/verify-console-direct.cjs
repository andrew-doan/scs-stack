// The dashboard's saves sending their files straight to R2, in a real
// browser against the real worker: the page asks the mode, sends each
// file to the addresses the worker signs, and the save names it by id.
// The worker runs here in node and the browser's requests to it are
// handed over by page.route; the R2 is tests/pretend-r2.mjs, reached
// the same way, so a slice the page sends is checked for its signature
// by code that is not the worker's.
// Run with: node tests/verify-console-direct.cjs
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
  const { pretendR2, HOST } = await import('./pretend-r2.mjs');
  const raw = new DatabaseSync(':memory:');
  raw.exec(fs.readFileSync(BOT + '/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync(BOT + '/seed.sql', 'utf8'));
  const db = d1Shim(raw);
  globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };
  const r2 = pretendR2();
  const mod = await import('../src/index.ts');
  const env = Object.assign({ DB: db, SUBMIT: r2.SUBMIT, CONSOLE_PASSWORD: 'tab-pass',
    PUBLIC_API: 'https://files.example', SITE_URL: 'https://scs.example' }, r2.env);
  const front = (req) => mod.default.fetch(req, env, { waitUntil() {} });
  const jpost = (p2, body) => front(new Request('https://bot.example' + p2, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  }));
  const session = (await consoleSignIn(jpost, 'Comms', 'tab-pass')).session;

  const exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  const b = await chromium.launch(exe ? { executablePath: exe } : {});
  const p = await b.newPage({ serviceWorkers: 'block', viewport: { width: 1100, height: 900 } });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));

  // what each save carried, by action: the multipart field names
  const saves = {};
  await p.route('https://bot.example/**', async (route) => {
    const req = route.request();
    const headers = req.headers();
    const body = ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer();
    const action = (new URL(req.url()).pathname.match(/^\/api\/console\/(.+)$/) || [])[1];
    if (action && body && /multipart/.test(headers['content-type'] || '')) {
      (saves[action] = saves[action] || []).push([...body.toString('latin1').matchAll(/name="([^"]+)"/g)].map((m) => m[1]));
    }
    const res = await front(new Request(req.url(), { method: req.method(), headers, body }));
    await route.fulfill({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: Buffer.from(await res.arrayBuffer()) });
  });
  // the bucket's CORS rule allows PUT from anywhere; the slice goes to
  // the pretend R2 in node, which answers as R2 would
  await p.route('https://' + HOST + '/**', async (route) => {
    const req = route.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const res = await fetch(req.url(), { method: req.method(), headers: req.headers(), body: req.postDataBuffer() || undefined });
    await route.fulfill({ status: res.status, headers: Object.assign({}, cors, Object.fromEntries(res.headers.entries())), body: Buffer.from(await res.arrayBuffer()) });
  });

  await p.addInitScript((s) => { try { localStorage.setItem('scs-console-session', s); } catch (e) { /* none */ } }, session);
  await p.goto('https://bot.example/dash');
  await p.waitForSelector('#main.is-ready', { timeout: 15000 });

  // a PNG with a text chunk, so its clean copy is a different file
  const chunk = (type, data) => {
    const len = data.length;
    return [(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255]
      .concat([...type].map((c) => c.charCodeAt(0)), data, [0, 0, 0, 0]);
  };
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10].concat(
    chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    chunk('tEXt', [...'Comment taken at 33.8688 S'].map((c) => c.charCodeAt(0))),
    chunk('IEND', [])
  ));

  // ---- the home page's pictures ----
  await p.evaluate(() => document.querySelector('[data-tab="settings"]').click());
  await p.waitForTimeout(300);
  await p.setInputFiles('#slide-file', { name: 'harbour.png', mimeType: 'image/png', buffer: png });
  await p.fill('#slide-alt', 'The harbour at dusk');
  await p.click('#slide-send');
  await p.waitForFunction(() => /Added/.test((document.getElementById('toast') || {}).textContent || ''), null, { timeout: 10000 });
  const slide = raw.prepare('SELECT key, bytes FROM home_slides').get();
  const fields = (saves['slides/save'] || [])[0] || [];
  check('a home page picture goes to R2 in slices and the save names it rather than carrying it',
    !!slide && /^slide\//.test(slide.key) && slide.bytes === png.length && r2.seen.part === 1 &&
    fields.includes('staged') && !fields.includes('file') &&
    raw.prepare('SELECT COUNT(*) AS n FROM staged_uploads').get().n === 0,
    JSON.stringify({ slide, fields, parts: r2.seen.part }));

  // ---- a message's attachments and a quest's files ----
  {
    // the staged files waiting when each save arrives, so the row it
    // writes can be matched to one of them
    const waiting = {};
    for (const action of ['messages/save', 'quests/group/files']) {
      await p.route('https://bot.example/api/console/' + action, (route) => {
        waiting[action] = raw.prepare("SELECT r2_key FROM staged_uploads WHERE status = 'ready'").all().map((r) => r.r2_key);
        return route.fallback();
      });
    }
    const toastSays = (re) => p.waitForFunction((src) => new RegExp(src).test((document.getElementById('toast') || {}).textContent || ''),
      re.source, { timeout: 10000 });

    await p.evaluate(() => document.querySelector('[data-tab="messages"]').click());
    await p.waitForTimeout(300);
    await p.fill('#msg-title', 'Route change');
    await p.setInputFiles('#msg-files', { name: 'route.png', mimeType: 'image/png', buffer: png });
    await p.click('#msg-post');
    await toastSays(/Posted Route change/);
    const attached = raw.prepare('SELECT key, bytes FROM message_files').get();
    const msgFields = (saves['messages/save'] || [])[0] || [];
    check('a message\'s attachment goes to R2 first and the save names it rather than carrying it',
      !!attached && (waiting['messages/save'] || []).includes(attached.key) && attached.bytes === png.length &&
      msgFields.includes('staged0') && !msgFields.includes('file0') &&
      raw.prepare('SELECT COUNT(*) AS n FROM staged_uploads').get().n === 0,
      JSON.stringify({ attached, fields: msgFields, waiting: waiting['messages/save'] }));

    await front(new Request('https://bot.example/api/console/quests/group/save', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session },
      body: JSON.stringify({ key: 'DQ1', name: 'Direct files', region: 'Direct Region', codes: [{ code: 'DQ1', label: '', points: 5 }] })
    }));
    // the quest list is read when the page opens
    await p.reload();
    await p.waitForSelector('#main.is-ready', { timeout: 15000 });
    await p.evaluate(() => document.querySelector('[data-tab="quests"]').click());
    await p.waitForSelector('#quest-list .qg .qg-row', { timeout: 10000 });
    await p.click('#quest-list .qg .qg-row');
    await p.setInputFiles('#quest-list .qg input[type=file]', { name: 'clue.png', mimeType: 'image/png', buffer: png });
    await p.click('#quest-list .qg .qg-waiting .qg-actions button');
    await toastSays(/1 file added/);
    const hung = raw.prepare('SELECT key, bytes FROM quest_files').get();
    const qstFields = (saves['quests/group/files'] || [])[0] || [];
    check('a quest\'s file goes to R2 first and the save names it rather than carrying it',
      !!hung && (waiting['quests/group/files'] || []).includes(hung.key) && hung.bytes === png.length &&
      qstFields.includes('staged0') && !qstFields.includes('file0') &&
      raw.prepare('SELECT COUNT(*) AS n FROM staged_uploads').get().n === 0,
      JSON.stringify({ hung, fields: qstFields, waiting: waiting['quests/group/files'] }));
  }

  // ---- the drop, organiser points and the album uploads ----
  // an album to add to, made before the Files tab opens so its list has it
  await front(new Request('https://bot.example/api/console/albums/save', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session },
    body: JSON.stringify({ name: 'The day', adding: 'closed', visibility: 'listed' })
  }));
  const albumId = raw.prepare("SELECT id FROM albums WHERE name = 'The day'").get().id;
  const staging = () => raw.prepare('SELECT COUNT(*) AS n FROM staged_uploads').get().n;

  await p.evaluate(() => document.querySelector('[data-tab="files"]').click());
  await p.waitForTimeout(300);
  await p.setInputFiles('#drop-file', { name: 'route.png', mimeType: 'image/png', buffer: png });
  await p.click('#drop-send');
  await p.waitForFunction(() => /Uploaded/.test((document.getElementById('toast') || {}).textContent || ''), null, { timeout: 10000 });
  const dropped = raw.prepare('SELECT key, bytes FROM drop_files').get();
  const dropFields = (saves['drop/upload'] || [])[0] || [];
  check('a file for the drop goes to R2 and the save names it rather than carrying it',
    !!dropped && /^drop\//.test(dropped.key) && dropped.bytes === png.length && r2.bucket.has(dropped.key) &&
    dropFields.includes('staged') && !dropFields.includes('file') && staging() === 0,
    JSON.stringify({ dropped, dropFields }));

  const partsBefore = r2.seen.part;
  await p.click('#alb-rows button:has-text("Photos")');
  await p.waitForSelector('#album-open:not(.hidden)', { timeout: 5000 });
  await p.setInputFiles('#album-files', { name: 'crowd.png', mimeType: 'image/png', buffer: png });
  await p.click('#album-upload');
  await p.waitForFunction(() => /Added 1 file/.test((document.getElementById('toast') || {}).textContent || ''), null, { timeout: 10000 });
  const photo = raw.prepare('SELECT r2_key, status FROM album_photos WHERE album_id = ?').get(albumId);
  const albumFields = (saves['album/upload'] || [])[0] || [];
  check('an album upload asks for every file in slices, the slice goes to R2, and the photo is ready',
    albumFields.includes('whole') && !albumFields.includes('files') && r2.seen.part > partsBefore &&
    !!photo && photo.status === 'ready' && r2.bucket.has(photo.r2_key),
    JSON.stringify({ albumFields, photo, parts: r2.seen.part - partsBefore }));

  // who added them: the album's own uploads picked on its grid and a
  // name set on them
  {
    await p.waitForSelector('#album-photos .alb-ph-pic', { timeout: 5000 });
    await p.click('#album-author-start');
    await p.click('#album-photos .alb-ph.is-choosable .alb-ph-pic');
    await p.selectOption('#album-author-who', 'name');
    await p.fill('#album-author-name', 'Platform Nine');
    await p.click('#album-author-set');
    await p.waitForFunction(() => /now from Platform Nine/.test((document.getElementById('toast') || {}).textContent || ''), null, { timeout: 5000 });
    const row = raw.prepare('SELECT team_id, added_by FROM album_photos WHERE r2_key = ?').get(photo.r2_key);
    const tile = await p.textContent('#album-photos .alb-ph-who');
    check('uploads picked on an album\'s grid take the name chosen, and the grid shows it',
      !!row && row.team_id === null && row.added_by === 'Platform Nine' && /Platform Nine/.test(tile),
      JSON.stringify({ row, tile }));
    await p.click('#album-author-done');
  }

  // a WebP picked on the dashboard goes in as a JPEG carrying its EXIF,
  // so the album's details still say where it was taken
  {
    const tiff = Buffer.alloc(140);
    tiff.write('MM', 0, 'latin1'); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x8825, 10); tiff.writeUInt16BE(4, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt32BE(26, 18);
    tiff.writeUInt16BE(4, 26);
    const tag = (i, id, type, count) => { const at = 28 + i * 12; tiff.writeUInt16BE(id, at); tiff.writeUInt16BE(type, at + 2); tiff.writeUInt32BE(count, at + 4); return at + 8; };
    tiff.write('S', tag(0, 1, 2, 2), 'latin1');
    tiff.writeUInt32BE(80, tag(1, 2, 5, 3));
    tiff.write('E', tag(2, 3, 2, 2), 'latin1');
    tiff.writeUInt32BE(104, tag(3, 4, 5, 3));
    [33, 1, 54, 1, 3600, 100, 151, 1, 13, 1, 1200, 100].forEach((v, i) => tiff.writeUInt32BE(v, 80 + i * 4));
    const webp = Buffer.from(await p.evaluate(async (exif) => {
      const c = document.createElement('canvas');
      c.width = 40; c.height = 30;
      c.getContext('2d').fillRect(0, 0, 40, 30);
      const plain = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/webp'))).arrayBuffer());
      const chunk = (t, data) => {
        const out = new Uint8Array(8 + data.length + (data.length & 1));
        out.set([...t].map(ch => ch.charCodeAt(0)));
        new DataView(out.buffer).setUint32(4, data.length, true);
        out.set(data, 8);
        return out;
      };
      let chunks = plain.slice(12);
      if (String.fromCharCode(...chunks.subarray(0, 4)) !== 'VP8X') {
        const vp8x = new Uint8Array(10);
        vp8x[4] = 39; vp8x[7] = 29;
        chunks = new Uint8Array([...chunk('VP8X', vp8x), ...chunks]);
      }
      chunks[8] |= 0x08;
      const body = [...new TextEncoder().encode('WEBP'), ...chunks, ...chunk('EXIF', new Uint8Array(exif))];
      return [82, 73, 70, 70, body.length & 255, (body.length >> 8) & 255, (body.length >> 16) & 255, 0, ...body];
    }, [...tiff]));
    const count = () => raw.prepare("SELECT COUNT(*) AS n FROM album_photos WHERE album_id = ? AND status = 'ready'").get(albumId).n;
    const before = count();
    await p.setInputFiles('#album-files', { name: 'harbour.webp', mimeType: 'image/webp', buffer: webp });
    await p.click('#album-upload');
    for (let i = 0; i < 100 && count() === before; i++) await p.waitForTimeout(100);
    const { readExif } = await import('../src/strip.ts');
    const { metaBlock } = await import('../src/photoserve.ts');
    const sent = raw.prepare('SELECT r2_key, content_type, name FROM album_photos WHERE album_id = ? ORDER BY id DESC').get(albumId);
    const said = readExif(await metaBlock(env, sent.r2_key, sent.content_type));
    check('a WebP picked on the dashboard goes into the album as a JPEG carrying the original\'s EXIF',
      sent.content_type === 'image/jpeg' && sent.name === 'harbour.jpg' && !!said.gps && said.gps.lat === -33.91 && said.gps.lng === 151.22,
      JSON.stringify({ sent, gps: said.gps }));
  }

  // one upload pointed at the other on the open album: Point to, then a
  // click on the other photo; the worker leaves it out of the album and
  // sends its share link on, and Undo puts it back
  {
    const [crowd, harbour] = raw.prepare('SELECT r2_key, name FROM album_photos WHERE album_id = ? ORDER BY id').all(albumId);
    const tile = (key) => '#album-photos .alb-ph:has(img[src*="' + key.slice(4) + '"])';
    await p.waitForSelector(tile(harbour.r2_key), { timeout: 5000 });
    await p.click(tile(crowd.r2_key) + ' button:has-text("Point to")');
    const bar = await p.isVisible('#album-pointing');
    await p.click(tile(harbour.r2_key) + ' .alb-ph-pic');
    await p.waitForFunction(() => /now points to/.test((document.getElementById('toast') || {}).textContent || ''), null, { timeout: 5000 });
    const pointed = raw.prepare('SELECT points_to FROM album_photos WHERE r2_key = ?').get(crowd.r2_key).points_to;
    const line = await p.textContent(tile(crowd.r2_key));
    const share = await front(new Request('https://bot.example/photo/' + crowd.r2_key.slice(4)));
    await p.click(tile(crowd.r2_key) + ' button:has-text("Undo")');
    await p.waitForFunction(() => /back in the album/.test((document.getElementById('toast') || {}).textContent || ''), null, { timeout: 5000 });
    const undone = raw.prepare('SELECT points_to FROM album_photos WHERE r2_key = ?').get(crowd.r2_key).points_to;
    check('on the dashboard a photo is pointed at another with Point to and a click, its share link goes there, and Undo puts it back',
      bar && pointed === harbour.r2_key && /Points to harbour\.jpg/.test(line) &&
      share.status === 302 && (share.headers.get('location') || '').endsWith('/photo/' + harbour.r2_key.slice(4)) && undone === '',
      JSON.stringify({ bar, pointed, line, share: [share.status, share.headers.get('location')], undone }));
  }

  await p.evaluate(() => document.querySelector('[data-tab="desk"]').click());
  await p.waitForSelector('#pt-team option:not([value=""])', { state: 'attached', timeout: 5000 });
  await p.selectOption('#desk-quest', await p.$eval('#desk-quest option:not([value=""])', (o) => o.value));
  await p.selectOption('#pt-team', await p.$eval('#pt-team option:not([value=""])', (o) => o.value));
  await p.setInputFiles('#pt-files', { name: 'summit.png', mimeType: 'image/png', buffer: png });
  await p.waitForFunction(() => document.querySelectorAll('#pt-files-list .file-row').length === 1, null, { timeout: 5000 });
  await p.click('#pt-add');
  await p.waitForFunction(() => /Their total/.test((document.getElementById('toast') || {}).textContent || ''), null, { timeout: 10000 });
  const proof = raw.prepare("SELECT f.r2_key, f.bytes FROM submission_files f JOIN submissions s ON s.id = f.submission_id WHERE s.added_by != ''").get();
  const pointFields = (saves['points/add'] || [])[0] || [];
  check('points with a photo send it to R2 and the save names it rather than carrying it',
    !!proof && /^sub\//.test(proof.r2_key) && proof.bytes === png.length && r2.bucket.has(proof.r2_key) &&
    pointFields.includes('staged') && !pointFields.includes('files') && staging() === 0,
    JSON.stringify({ proof, pointFields }));

  // ---- a challenge's standings on its desk ----
  await front(new Request('https://bot.example/api/console/quests/group/save', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session },
    body: JSON.stringify({ key: 'TQ1', name: 'Most stations', region: 'Direct Region',
      questions: [{ kind: 'pick', prompt: 'Stations', options: ['@stations'] }],
      rules: { tally: { kind: 'picks', awards: [100], public: false } }, codes: [{ code: 'TQ1', label: '', points: 10 }] })
  }));
  const runner = raw.prepare('SELECT id, name FROM teams WHERE hidden = 0 ORDER BY id LIMIT 1').get();
  const sent = raw.prepare("INSERT INTO submissions (team_id, quest_code, status, answer) VALUES (?, 'TQ1', 'accepted', ?)")
    .run(runner.id, JSON.stringify({ kind: 'pick', value: ['Central', 'Redfern'] })).lastInsertRowid;
  raw.prepare('INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, ?, ?, ?, ?)')
    .run(sent, proof ? proof.r2_key : 'sub/none', 'image/png', png.length, 'platform.png');
  await p.evaluate(() => document.querySelector('[data-tab="review"]').click());
  await p.evaluate(() => document.querySelector('[data-tab="desk"]').click());
  await p.waitForSelector('#desk-quest option[value="TQ1"]', { state: 'attached', timeout: 5000 });
  await p.selectOption('#desk-quest', 'TQ1');
  await p.waitForSelector('#desk-standings:not(.hidden) .tally-team', { timeout: 5000 });
  await p.click('#desk-standings .tally-team');
  await p.waitForSelector('#desk-standings .tally-detail .review-media img', { timeout: 5000 });
  const standing = await p.evaluate(() => ({
    row: [...document.querySelectorAll('#desk-standings tbody tr:first-child td')].map((td) => td.textContent),
    items: [...document.querySelectorAll('#desk-standings .tally-items strong')].map((s) => s.textContent),
    shots: document.querySelectorAll('#desk-standings .tally-detail .review-media img').length
  }));
  check('a challenge\'s desk shows its standings, and a team\'s row opens what it counted and its photos',
    JSON.stringify(standing.row) === JSON.stringify(['1', runner.name, '2', '']) &&
    standing.items.join() === 'Central,Redfern' && standing.shots === 1, JSON.stringify(standing));

  check('every slice R2 saw was signed correctly', r2.seen.refused === 0, 'refused=' + r2.seen.refused);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await b.close();
  r2.restore();
  console.log(fail ? '\n' + fail + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
