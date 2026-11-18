// Run with: node tests/verify-submit-page.cjs
// Drives the site's /submit page: the floating button, team sign-in,
// the quest picker fed by the real SCS.2 list, its answer boxes, file selection with
// its size warnings, the multipart send, and the verdicts table.
// Then the /gallery/ page: its team-only gate and the closing-night
// slideshow, and the compress page's picture-size and target-size rows.
// Needs playwright nearby and a static server on 8123 serving
// website/ (the test starts one if the port is free).
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
  const p = await b.newPage({ serviceWorkers: 'block', viewport: { width: 1100, height: 950 } });
  // the quest box is hidden while a quest is picked; change brings it back
  const searchFor = async (q, page = p) => {
    if (!(await page.isVisible('#sub-quest-search'))) await page.click('#sub-quest-picked a');
    await page.fill('#sub-quest-search', q);
  };

  // the quest list the worker serves, built from the same data file
  const questData = await import(path.join(ROOT, 'tab/src/data/scs2-quests.ts'));
  const placeData = await import(path.join(ROOT, 'tab/src/data/places.ts'));
  const questList = {
    regions: questData.REGIONS,
    groups: questData.QUESTS.map(g => ({
      key: g.key, name: g.name, region: g.region, description: g.description, flavour: g.flavour,
      location: g.location, coords: g.coords, submit: g.submit, prompt: g.prompt, options: g.options,
      codes: g.codes.map(c => ({ code: c.code, label: c.label, points: c.points }))
    })),
    places: placeData.PLACES
  };
  // a quest that asks several questions, one of them multiple choice
  questList.groups.push({
    key: 'XQ9', name: 'Ferry quiz', region: questData.REGIONS[0], description: '', flavour: '', location: '', coords: [],
    submit: 'count', prompt: 'How many crossed?', options: [],
    questions: [{ kind: 'count', prompt: 'How many crossed?', options: [] }, { kind: 'choice', prompt: 'Which ferry?', options: ['Manly', 'Taronga'] },
      { kind: 'text', prompt: 'Who steered?', options: [] }],
    codes: [{ code: 'XQ9', label: '', points: 10 }]
  });

  const calls = { login: [], create: [], mine: 0, gallery: [], parts: [], finish: 0, score: 0 };
  let mineRows = [];
  let galleryRows = [];
  let galleryMore = false;
  let statusAnswer = null; // what upload/status should say; null = 404
  let statusCode = 0;      // a status upload/status answers with instead, when set
  const statusAsks = [];   // the files upload/status was asked about
  let finishAnswer = null; // what upload/finish should say instead of done: [status, body]
  let scoreAnswer = null;  // what /api/submit/score should say; null = 401
  let queueNext = false;   // the next create answers as the worker does past the team's review cap
  let directMode = false;  // what upload/mode says: files straight to R2 or through the worker
  const r2Puts = [];       // slices that reached the pretend R2
  const dot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABh6FO1AAAAABJRU5ErkJggg==', 'base64');
  await p.route('**/files.scs.andyrew.space/**', async r => {
    const u = r.request().url();
    if (u.includes('/api/questlist')) {
      await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(questList) });
    } else if (u.includes('/api/submit/file')) {
      await r.fulfill({ status: 200, contentType: 'image/png', headers: { 'access-control-allow-origin': '*' }, body: dot });
    } else if (u.includes('/api/submit/gallery') && r.request().method() === 'GET' && !r.request().headers()['authorization']) {
      // the listing takes a sign-in now
      await r.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ error: 'not signed in' }) });
    } else if (u.includes('/api/submit/gallery') && r.request().method() === 'POST') {
      calls.gallery.push(r.request().postDataJSON());
      await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: true }) });
    } else if (u.includes('/api/submit/gallery')) {
      await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: true, submissions: galleryRows, more: galleryMore || undefined }) });
    } else if (u.includes('/api/submit/login')) {
      const body = r.request().postDataJSON();
      calls.login.push(body);
      if (body.code === 'GOODCODE') {
        await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ ok: true, session: 'team-sess-1', team: 'Team Ferrous' }) });
      } else {
        await r.fulfill({ status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
          body: JSON.stringify({ error: 'No match for that team and code.' }) });
      }
    } else if (u.includes('/api/submit/create')) {
      calls.create.push({ auth: r.request().headers()['authorization'], body: r.request().postData() });
      const quest = /name="quest"\r\n\r\n([^\r]+)/.exec(r.request().postData() || '');
      const answer = /name="answer"\r\n\r\n([^\r]+)/.exec(r.request().postData() || '');
      const bigm = /name="bigfiles"\r\n\r\n([^\r]+)/.exec(r.request().postData() || '');
      const whole = /name="whole"\r\n\r\n1\r/.test(r.request().postData() || '');
      const ups = bigm ? JSON.parse(bigm[1]).map((f2, i2) => ({ file: 77 + i2, name: f2.name, size: f2.size, part_size: 20 * 1024 * 1024, direct: whole })) : [];
      mineRows.unshift({ id: 9 + calls.create.length, quest_code: quest ? quest[1] : '?', note: '', status: queueNext ? 'queued' : 'pending', submitted_at: '2026-10-20 01:00:00', reason: null, files: 1,
        answer: answer ? JSON.parse(answer[1]) : null });
      await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: true, id: 9, quest: quest ? quest[1] : '?', files: 1 + ups.length, uploads: ups, queued: queueNext }) });
    } else if (u.includes('/api/submit/upload/mode')) {
      await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: true, direct: directMode, part_size: 20 * 1024 * 1024 }) });
    } else if (u.includes('/api/submit/upload/sign')) {
      const q3 = new URL(u);
      await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: true, n: Number(q3.searchParams.get('n')),
          url: 'https://acct.r2.cloudflarestorage.com/scs-submissions/sub/k' + q3.searchParams.get('file') +
            '?partNumber=' + q3.searchParams.get('n') + '&uploadId=u1&X-Amz-Signature=sig' }) });
    } else if (u.includes('/api/submit/upload/part')) {
      const q2 = new URL(u);
      const buf2 = r.request().postDataBuffer();
      calls.parts.push({ file: q2.searchParams.get('file'), n: q2.searchParams.get('n'), bytes: buf2 ? buf2.length : -1 });
      await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: true }) });
    } else if (u.includes('/api/submit/upload/finish')) {
      calls.finish++;
      await r.fulfill({ status: finishAnswer ? finishAnswer[0] : 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify(finishAnswer ? finishAnswer[1] : { ok: true, done: true }) });
    } else if (u.includes('/api/submit/upload/status')) {
      statusAsks.push(Number(new URL(u).searchParams.get('file')));
      if (statusCode) {
        await r.fulfill({ status: statusCode, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"Storage could not be reached. Try again."}' });
        return;
      }
      await r.fulfill(statusAnswer
        ? { status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(statusAnswer) }
        : { status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"not found"}' });
    } else if (u.includes('/api/submit/score')) {
      calls.score++;
      await r.fulfill(scoreAnswer
        ? { status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(scoreAnswer) }
        : { status: 401, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{"error":"not signed in"}' });
    } else if (u.includes('/api/submit/mine')) {
      calls.mine++;
      await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
        body: JSON.stringify({ ok: true, team: 'Team Ferrous', submissions: mineRows }) });
    } else {
      await r.fulfill({ status: 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
    }
  });

  // the pretend R2 a slice goes to when the worker says direct
  await p.route('https://acct.r2.cloudflarestorage.com/**', async r => {
    const req = r.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT', 'access-control-allow-headers': '*' };
    if (req.method() === 'OPTIONS') { await r.fulfill({ status: 204, headers: cors }); return; }
    const buf = req.postDataBuffer();
    r2Puts.push({ url: req.url(), bytes: buf ? buf.length : -1, auth: !!req.headers()['authorization'], type: req.headers()['content-type'] || '' });
    await r.fulfill({ status: 200, headers: Object.assign({ etag: '"e1"' }, cors), body: '' });
  });

  // ---- sign in ----
  await p.goto(BASE + '/submit/');
  await p.waitForTimeout(900);
  check('the page gates on team sign-in', await p.isVisible('#sub-login') && !(await p.isVisible('#sub-main')), '');
  // The compressor was a view of this page at #compress, and links to
  // that address are out in chats and on the camera page.
  const toCompress = await p.evaluate(() => {
    const a = document.querySelector('#sub-login a[href$="compress/"]');
    return a && a.getBoundingClientRect().height > 0 ? new URL(a.href).pathname : null;
  });
  // from another page: on this one only the hash would change
  await p.goto('about:blank');
  await p.goto(BASE + '/submit/#compress');
  await p.waitForURL('**/compress/', { timeout: 5000 }).catch(() => {});
  const oldAddress = new URL(p.url()).pathname;
  check('signed out, the compress page is a link away, and the old address lands on it',
    toCompress === '/compress/' && oldAddress === '/compress/', JSON.stringify({ toCompress, oldAddress }));
  await p.goto(BASE + '/submit/');
  await p.waitForTimeout(900);
  await p.fill('#sub-team', 'Team Ferrous');
  await p.fill('#sub-code', 'WRONG');
  await p.click('#sub-login-btn');
  await p.waitForTimeout(400);
  check('a bad code shows the server message',
    (await p.textContent('#sub-login-error')).includes('No match'), '');
  await p.fill('#sub-code', 'GOODCODE');
  await p.click('#sub-login-btn');
  await p.waitForTimeout(500);
  check('the code signs the team in',
    await p.isVisible('#sub-main') && (await p.textContent('#sub-team-name')) === 'Team Ferrous', '');

  // ---- quest picker from the real list ----
  await searchFor('wondabyne');
  await p.waitForTimeout(400);
  const matches = await p.$$eval('#sub-quest-matches button', els => els.map(e => e.textContent));
  check('typing a name finds the quest in the real list',
    matches.length >= 1 && matches[0].includes('SQ40') && matches[0].includes('Wondabyne'), JSON.stringify(matches));
  // loose matching: a typo still finds it, a number alone lists every
  // code carrying it, and the whole list is there to scroll rather
  // than a top few
  await searchFor('wondabine');
  await p.waitForTimeout(300);
  const typo = await p.$$eval('#sub-quest-matches button', els => els.map(e => e.textContent));
  check('a name a letter off still finds the quest first', typo.length >= 1 && typo[0].includes('SQ40'), JSON.stringify(typo.slice(0, 3)));
  await searchFor('18');
  await p.waitForTimeout(300);
  const num = await p.$$eval('#sub-quest-matches .sub-match-code', els => els.map(e => e.textContent));
  check('a number alone lists every quest with it in the code, SQ18 first',
    num.length >= 1 && num[0] === 'SQ18' && num.every(c => /18/.test(c)), JSON.stringify(num));
  await searchFor('the');
  await p.waitForTimeout(300);
  const many = await p.evaluate(() => {
    const list = document.getElementById('sub-quest-matches');
    const cs = getComputedStyle(list);
    const over = [...list.querySelectorAll('button')].some(b => b.getBoundingClientRect().right > list.getBoundingClientRect().right + 1);
    return { n: list.children.length, scrolls: cs.overflowY === 'auto' && list.scrollHeight > list.clientHeight, over };
  });
  check('a broad search lists every match in a list that scrolls and stays inside its edge',
    many.n > 10 && many.scrolls && !many.over, JSON.stringify(many));
  await searchFor('wondabyne');
  await p.waitForTimeout(300);
  await p.click('#sub-quest-matches button');
  const pickedText = await p.textContent('#sub-quest-picked');

  // ---- HEIC and WebP go up as JPEG, carrying their EXIF ----
  {
    // a TIFF block: Orientation 6 in IFD0 and a GPS directory at 38
    // reading 33°54'36"S 151°13'12"E
    const tiffBlock = (le) => {
      const b = Buffer.alloc(140);
      const u16 = (v, at) => le ? b.writeUInt16LE(v, at) : b.writeUInt16BE(v, at);
      const u32 = (v, at) => le ? b.writeUInt32LE(v, at) : b.writeUInt32BE(v, at);
      b.write(le ? 'II' : 'MM', 0, 'latin1'); u16(42, 2); u32(8, 4);
      u16(2, 8);
      u16(0x0112, 10); u16(3, 12); u32(1, 14); u16(6, 18);
      u16(0x8825, 22); u16(4, 24); u32(1, 26); u32(38, 30);
      u16(4, 38);
      const tag = (i, id, type, count) => { const at = 40 + i * 12; u16(id, at); u16(type, at + 2); u32(count, at + 4); return at + 8; };
      b.write('S', tag(0, 1, 2, 2), 'latin1');
      u32(92, tag(1, 2, 5, 3));
      b.write('E', tag(2, 3, 2, 2), 'latin1');
      u32(116, tag(3, 4, 5, 3));
      [33, 1, 54, 1, 3600, 100, 151, 1, 13, 1, 1200, 100].forEach((v, i) => u32(v, 92 + i * 4));
      return b;
    };

    // a WebP the page makes, as a VP8X file with an EXIF chunk on the end
    const tiffMM = tiffBlock(false);
    const webp = await p.evaluate(async (tiff) => {
      const c = document.createElement('canvas');
      c.width = 40; c.height = 30;
      c.getContext('2d').fillRect(0, 0, 40, 30);
      const plain = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/webp'))).arrayBuffer());
      const chunk = (tag, data) => {
        const out = new Uint8Array(8 + data.length + (data.length & 1));
        out.set([...tag].map(ch => ch.charCodeAt(0)));
        new DataView(out.buffer).setUint32(4, data.length, true);
        out.set(data, 8);
        return out;
      };
      // Chromium writes VP8X already, for its colour profile; a plain
      // VP8 or VP8L file gets a VP8X header in front of its one chunk
      let chunks = plain.slice(12);
      if (String.fromCharCode(...chunks.subarray(0, 4)) !== 'VP8X') {
        const vp8x = new Uint8Array(10);
        vp8x[4] = 39; vp8x[7] = 29;   // width and height, less one
        chunks = new Uint8Array([...chunk('VP8X', vp8x), ...chunks]);
      }
      chunks[8] |= 0x08;              // the EXIF flag
      const body = [new TextEncoder().encode('WEBP'), chunks, chunk('EXIF', new Uint8Array(tiff))];
      const head = new Uint8Array(8);
      head.set([82, 73, 70, 70]);
      new DataView(head.buffer).setUint32(4, body.reduce((n, part) => n + part.length, 0), true);
      const out = await scs.toJpeg(new File([head, ...body], 'IMG_0001.webp', { type: 'image/webp' }));
      return { name: out.name, type: out.type, bytes: [...new Uint8Array(await out.arrayBuffer())] };
    }, [...tiffMM]);
    const { stripImage, readExif } = await import(path.join(ROOT, 'tab/src/strip.ts'));
    const jpeg = Uint8Array.from(webp.bytes);
    const app1 = jpeg[2] === 0xFF && jpeg[3] === 0xE1 ? Buffer.from(jpeg.subarray(6, 4 + ((jpeg[4] << 8) | jpeg[5]))) : Buffer.alloc(0);
    const upright = Buffer.from(tiffMM);
    upright.writeUInt16BE(1, 18);
    const seen = readExif(stripImage(jpeg, 'image/jpeg').exif);
    check('a WebP goes up as a JPEG whose EXIF is the original\'s, GPS and all, with Orientation 1',
      webp.name === 'IMG_0001.jpg' && webp.type === 'image/jpeg' &&
      app1.subarray(0, 6).toString('latin1') === 'Exif\0\0' && app1.subarray(6).equals(upright) &&
      !!seen.gps && seen.gps.lat === -33.91 && seen.gps.lng === 151.22,
      JSON.stringify({ name: webp.name, type: webp.type, app1: app1.length, gps: seen.gps }));

    // a HEIC: ftyp, then meta naming an Exif item in iinf and placing
    // it in iloc, then the mdat holding it
    const tiffII = tiffBlock(true);
    const box = (type, ...parts) => {
      const body = Buffer.concat(parts);
      const h = Buffer.alloc(8);
      h.writeUInt32BE(8 + body.length);
      h.write(type, 4, 'latin1');
      return Buffer.concat([h, body]);
    };
    const full = (type, version, ...parts) => box(type, Buffer.from([version, 0, 0, 0]), ...parts);
    const u16b = v => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
    const u32b = v => { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; };
    const infe = (id, type) => full('infe', 2, u16b(id), u16b(0), Buffer.from(type, 'latin1'), Buffer.from([0]));
    const picture = Buffer.alloc(64, 7);
    const exifData = Buffer.concat([u32b(6), Buffer.from('Exif\0\0', 'latin1'), tiffII]);
    const meta = (picAt, exifAt) => full('meta', 0,
      full('hdlr', 0, u32b(0), Buffer.from('pict', 'latin1'), Buffer.alloc(13)),
      full('iinf', 0, u16b(2), infe(1, 'hvc1'), infe(2, 'Exif')),
      full('iloc', 1, Buffer.from([0x44, 0x00]), u16b(2),
        u16b(1), u16b(0), u16b(0), u16b(1), u32b(picAt), u32b(picture.length),
        u16b(2), u16b(0), u16b(0), u16b(1), u32b(exifAt), u32b(exifData.length)));
    const ftyp = box('ftyp', Buffer.from('heic\0\0\0\0mif1heic', 'latin1'));
    const mdatAt = ftyp.length + meta(0, 0).length + 8;
    const heic = Buffer.concat([ftyp, meta(mdatAt, mdatAt + picture.length), box('mdat', picture, exifData)]);
    const fromHeic = await p.evaluate(async (bytes) => {
      const tiff = await scs.exifOf(new File([new Uint8Array(bytes)], 'IMG_0002.HEIC', { type: 'image/heic' }));
      return tiff && [...tiff];
    }, [...heic]);
    check('a HEIC\'s EXIF is found through its meta box, as the TIFF block it holds',
      !!fromHeic && Buffer.from(fromHeic).equals(tiffII), fromHeic ? fromHeic.length + ' bytes' : 'null');
  }

  // ---- files, including the oversize warning ----
  await p.setInputFiles('#sub-files', [
    { name: 'platform.jpg', mimeType: 'image/png', buffer: dot }
  ]);
  await p.waitForTimeout(200);
  const fileRow = await p.evaluate(() => {
    const box = document.querySelector('#sub-file-list .sub-file-rename');
    return { name: box && box.value, ext: (document.querySelector('#sub-file-list .sub-file-ext') || {}).textContent, size: document.querySelector('#sub-file-list').textContent };
  });
  check('a chosen file lists with its name in a box to type over, the extension fixed after it',
    fileRow.name === 'platform' && fileRow.ext === '.jpg' && /KB/.test(fileRow.size), JSON.stringify(fileRow));
  await p.fill('#sub-file-list .sub-file-rename', 'whole team at Wondabyne');

  // ---- send, with the gallery box ticked ----
  await p.fill('#sub-note', 'Whole team on the platform');
  await p.evaluate(() => document.getElementById('sub-gallery').click());
  await p.click('#sub-send');
  await p.waitForTimeout(600);
  const sent = calls.create[0];
  check('the send is a multipart POST with the session attached',
    calls.create.length === 1 && sent.auth === 'Bearer team-sess-1' &&
    sent.body.includes('name="quest"') && sent.body.includes('SQ40') && !sent.body.includes('name="answer"') &&
    sent.body.includes('Whole team on the platform') && sent.body.includes('filename="whole team at Wondabyne.jpg"') && !sent.body.includes('platform.jpg'), '');
  check('the browser sends a downscaled preview beside the photo',
    sent.body.includes('name="thumb0"') && sent.body.includes('thumb.jpg'), '');
  // Every photo sends one now, whatever it weighs. It used to be held
  // back unless it was clearly lighter than the original — which meant
  // a small photo had no clean copy at all, and a request for a
  // smaller size fell through to the file the camera wrote, metadata
  // and all.
  check('every photo sends a viewing copy, not only the ones it saves bytes on',
    sent.body.includes('name="view0"'), '');
  check('the ticked gallery box rides along and resets after',
    sent.body.includes('name="gallery"') &&
    !(await p.$eval('#sub-gallery', el => el.checked)), '');
  check('success resets the form and reports plainly',
    (await p.textContent('#sub-status')).includes('Sent: SQ40') &&
    (await p.textContent('#sub-quest-picked')) === '' || (await p.$eval('#sub-quest-picked', el => el.classList.contains('is-hidden'))), '');

  // ---- answer boxes ----
  await searchFor('sq1');
  await p.waitForTimeout(300);
  const sq1 = await p.$$eval('#sub-quest-matches button', els => els.map(e => e.textContent));
  check('a code prefix lists that quest first, tiers and all', sq1.length >= 1 && sq1[0].startsWith('SQ1'), JSON.stringify(sq1));
  await p.click('#sub-quest-matches button');
  await p.waitForTimeout(200);
  check('a station quest opens a pick box over the station list',
    await p.isVisible('#sub-answer') && (await p.$$eval('#sub-answer input[type=search]', els => els.length)) === 1, '');
  await p.click('#sub-send');
  await p.waitForTimeout(200);
  check('an empty pick is refused before upload', (await p.textContent('#sub-status')).includes('Pick at least one'), '');
  await p.fill('#sub-answer input[type=search]', 'redfern');
  await p.waitForTimeout(150);
  await p.click('#sub-answer .sub-pick-results button');
  await p.fill('#sub-answer input[type=search]', 'central');
  await p.waitForTimeout(150);
  await p.click('#sub-answer .sub-pick-results button');
  const chips = await p.$$eval('#sub-answer .sub-chip', els => els.map(e => e.textContent));
  check('picked stations stack as chips', chips.length === 2 && chips[0] === 'Redfern' && chips[1] === 'Central', JSON.stringify(chips));
  await p.setInputFiles('#sub-files', [{ name: 'stations.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(2048, 1) }]);
  await p.click('#sub-send');
  await p.waitForTimeout(600);
  const pickSent = calls.create[1];
  check('the pick rides along as a JSON answer',
    calls.create.length === 2 && pickSent.body.includes('name="answer"') &&
    pickSent.body.includes('"kind":"pick"') && pickSent.body.includes('Redfern') && /name="quest"\r\n\r\nSQ1\r/.test(pickSent.body),
    pickSent ? pickSent.body.slice(0, 300) : '');

  await searchFor('sq46');
  await p.waitForTimeout(300);
  await p.click('#sub-quest-matches button');
  await p.waitForTimeout(200);
  const rockers = await p.$$eval('#sub-answer .sub-check', els => els.map(e => e.textContent));
  check('a multi-code quest lists a rocker per code', rockers.length === 11 && rockers[0].includes('SQ46-1') && rockers[0].includes('Lighthouse'),
    JSON.stringify(rockers.slice(0, 2)));
  await p.$$eval('#sub-answer .sub-check input', els => { els[0].click(); els[6].click(); });
  await p.setInputFiles('#sub-files', [{ name: 'macq.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(2048, 1) }]);
  await p.click('#sub-send');
  await p.waitForTimeout(600);
  const codesSent = calls.create[2];
  check('ticked codes are sent under the lead code',
    !!codesSent && codesSent.body.includes('"kind":"codes"') && codesSent.body.includes('SQ46-7') && codesSent.body.includes('SQ46-1'),
    codesSent ? codesSent.body.slice(0, 300) : '');

  await searchFor('sq4');
  await p.waitForTimeout(300);
  await p.click('#sub-quest-matches button');
  await p.waitForTimeout(200);
  check('a count quest asks for a number', (await p.$$eval('#sub-answer input[type=number]', els => els.length)) === 1, '');
  const mineAnswer = await p.$$eval('#sub-mine-rows tr', trs => trs.map(t => t.textContent));
  check('the table shows each submission with its answer',
    mineAnswer.length === 3 && mineAnswer[1].includes('Redfern, Central') && mineAnswer[0].includes('SQ46-1, SQ46-7'),
    JSON.stringify(mineAnswer));

  // ---- a large photo gets a viewing copy made in the browser ----
  await searchFor('wondabyne');
  await p.waitForTimeout(300);
  await p.click('#sub-quest-matches button');
  await p.waitForTimeout(200);
  // a photo-like original: grain over a gradient, saved at JPEG
  // quality 1.0 — the viewing copy (smaller and at 0.8) is then
  // reliably lighter, the way it is for a real camera photo
  await p.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 2600; canvas.height = 1600;
    const g = canvas.getContext('2d');
    const data = g.createImageData(2600, 1600);
    let seed = 7;
    for (let i = 0; i < data.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const grain = (seed % 61) - 30;
      const x = (i / 4) % 2600;
      data.data[i] = Math.max(0, Math.min(255, 90 + x / 20 + grain));
      data.data[i + 1] = Math.max(0, Math.min(255, 120 + grain));
      data.data[i + 2] = Math.max(0, Math.min(255, 150 - x / 30 + grain));
      data.data[i + 3] = 255;
    }
    g.putImageData(data, 0, 0);
    return new Promise(res => canvas.toBlob(b => {
      const dt = new DataTransfer();
      dt.items.add(new File([b], 'big-photo.jpg', { type: 'image/jpeg' }));
      const input = document.getElementById('sub-files');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      res();
    }, 'image/jpeg', 1));
  });
  await p.waitForTimeout(300);
  await p.click('#sub-send');
  await p.waitForTimeout(1200);
  const bigSent = calls.create[3];
  check('a large photo rides with its viewing copy',
    !!bigSent && bigSent.body.includes('name="view0"') && bigSent.body.includes('view.jpg') &&
    bigSent.body.includes('name="thumb0"'), bigSent ? String(bigSent.body.length) : 'no create');

  // ---- a WebP goes up as a JPEG, the WebP beside it as the worker reads it ----
  await searchFor('wondabyne');
  await p.waitForTimeout(300);
  await p.click('#sub-quest-matches button');
  await p.waitForTimeout(200);
  await p.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 48;
    canvas.getContext('2d').fillRect(0, 0, 32, 24);
    return new Promise(res => canvas.toBlob(b => {
      const dt = new DataTransfer();
      dt.items.add(new File([b], 'IMG_0009.webp', { type: 'image/webp' }));
      const input = document.getElementById('sub-files');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      res();
    }, 'image/webp'));
  });
  await p.waitForTimeout(800);
  await p.click('#sub-send');
  await p.waitForTimeout(800);
  const twinSent = calls.create[4];
  check('a WebP goes up as a JPEG with the WebP it was picked as beside it, as picked0 under its own type',
    !!twinSent && /name="files"; filename="IMG_0009\.jpg"\r\nContent-Type: image\/jpeg/.test(twinSent.body) &&
    /name="picked0"; filename="IMG_0009\.webp"\r\nContent-Type: image\/webp/.test(twinSent.body),
    twinSent ? (twinSent.body.match(/name="[^"]+"(; filename="[^"]+"\r\nContent-Type: [^\r]+)?/g) || []).join(' | ') : 'no create');

  // ---- verdicts table ----
  mineRows = [
    { id: 9, quest_code: 'SQ40', note: '', status: 'accepted', submitted_at: '2026-10-20 01:00:00', reason: null, files: 1, gallery: 1,
      media: [{ key: 'sub/9/imgkey', type: 'image/jpeg', name: 'platform.jpg' }, { key: 'sub/9/vidkey', type: 'video/mp4', name: 'clip.mp4', renditions: [], skipped: true }] },
    { id: 8, quest_code: 'S1', note: '', status: 'rejected', submitted_at: '2026-10-20 00:40:00', reason: 'Script missing a line', files: 2, gallery: 0 }
  ];
  await p.reload();
  await p.waitForTimeout(800);
  const table = await p.evaluate(() => ({
    pills: [...document.querySelectorAll('#sub-mine-rows .pill')].map(el => el.className.replace('pill ', '') + ':' + el.textContent),
    reason: (document.querySelector('#sub-mine-rows .sub-reason') || {}).textContent || ''
  }));
  check('the verdicts land as pills, rejection reason shown',
    JSON.stringify(table.pills) === JSON.stringify(['accepted:accepted', 'rejected:rejected']) &&
    table.reason === 'Script missing a line', JSON.stringify(table));
  const reasonInk = await p.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--alert-ink)';
    document.body.appendChild(probe);
    const alert = getComputedStyle(probe).color;
    probe.remove();
    const el = document.querySelector('#sub-mine-rows .sub-reason');
    return { alert, colour: getComputedStyle(el).color, ownLine: getComputedStyle(el).display };
  });

  // ---- proof thumbnails and the per-row gallery rocker ----
  const proof = await p.evaluate(() => ({
    thumbs: [...document.querySelectorAll('#sub-mine-rows img.sub-thumb')].map(i => i.getAttribute('src')),
    vids: document.querySelectorAll('#sub-mine-rows .sub-thumb-vid').length,
    fallback: [...document.querySelectorAll('#sub-mine-rows tr')].map(tr => tr.children[2].textContent.trim())[1],
    rockers: [...document.querySelectorAll('#sub-mine-rows .sub-gal input')].map(b => b.checked)
  }));
  const thumbSrcs = await p.$$eval('#sub-mine-rows img.sub-thumb', els => els.map(e => e.src));
  check('the table thumbnails ask for the small copy', thumbSrcs.length >= 1 && thumbSrcs.every(s2 => s2.includes('thumb=1')), JSON.stringify(thumbSrcs));
  await p.click('#sub-mine-rows .sub-thumb-btn');
  await p.waitForTimeout(400);
  const lb = await p.evaluate(() => {
    const o = document.querySelector('.lb-overlay');
    if (!o) return null;
    const m = o.querySelector('.lb-media');
    return { media: m.tagName, full: m.src.includes('/api/submit/file') && !m.src.includes('thumb=1'),
      view: m.src.includes('res=1080'), counter: (o.querySelector('.lb-counter') || {}).textContent || '' };
  });
  check('tapping proof previews the full file over the page, no new tab',
    !!lb && lb.media === 'IMG' && lb.full && lb.counter === '1 / 2', JSON.stringify(lb));
  check('a photo opens as its viewing copy, not the original', !!lb && lb.view, JSON.stringify(lb));
  await p.keyboard.press('ArrowRight');
  await p.waitForTimeout(400);
  const gaveUp = await p.evaluate(() => (document.querySelector('.lb-overlay .lb-processing-note') || {}).textContent || '');
  check('a video the encoder gave up on says it cannot be played, not that it is processing',
    gaveUp === 'This video cannot be played here.', JSON.stringify(gaveUp));
  await p.keyboard.press('Escape');
  await p.waitForTimeout(400);
  check('Escape closes the preview', await p.evaluate(() => !document.querySelector('.lb-overlay')), '');
  check('proof renders as thumbnails, plain counts as fallback',
    proof.thumbs.length === 1 && proof.thumbs[0].includes('key=sub%2F9%2Fimgkey') &&
    proof.vids === 1 && proof.fallback === '2', JSON.stringify(proof));
  check('gallery rockers mirror each submission', JSON.stringify(proof.rockers) === JSON.stringify([true, false]), '');
  await p.evaluate(() => document.querySelectorAll('#sub-mine-rows .sub-gal input')[1].click());
  await p.waitForTimeout(400);
  check('flipping a rocker tells the worker which submission',
    calls.gallery.length === 1 && calls.gallery[0].id === 8 && calls.gallery[0].gallery === true,
    JSON.stringify(calls.gallery));

  // session survives reload (already proved by the table render above)
  check('the session survives a reload', await p.isVisible('#sub-main'), '');

  // ---- the team's own score sheet ----
  // it has been asked for on every sign-in so far, and answered 401 —
  // an unanswerable score says nothing rather than showing an empty box
  check('a refused score leaves the section off the page',
    calls.score > 0 && (await p.$eval('#sub-score', el => el.classList.contains('is-hidden'))),
    'asked ' + calls.score + ' times');

  scoreAnswer = {
    ok: true, frozen: false, team: 'Team Ferrous', rank: 4, teams: 61, total: 1240.5,
    lines: [
      { code: 'SQ40', group_key: 'SQ40', name: 'Wondabyne', amount: 1, points: 900, worth: 900 },
      { code: 'SQ70', group_key: 'SQ70', name: 'Every school', amount: 3, points: 113.5, worth: 340.5 },
      { code: 'SQ39', group_key: 'SQ39', name: 'Suburbs', scoring: 'tiered', amount: null, points: null, worth: 120 }
    ],
    pending: 2
  };
  await p.reload();
  await p.waitForTimeout(900);
  const score = await p.evaluate(() => {
    const sec = document.getElementById('sub-score');
    const total = document.getElementById('sub-score-total');
    return {
      shown: !sec.classList.contains('is-hidden'),
      heading: sec.querySelector('.section-heading').textContent,
      frozenLine: !document.getElementById('sub-score-frozen').classList.contains('is-hidden'),
      rank: document.getElementById('sub-score-rank').textContent,
      total: total.textContent,
      popped: total.classList.contains('t-digit-group') || matchMedia('(prefers-reduced-motion: reduce)').matches,
      value: total.getAttribute('data-value'),
      rows: [...document.querySelectorAll('#sub-score-rows tr')].map(tr => [...tr.children].map(td => td.textContent)),
      chips: [...document.querySelectorAll('#sub-score-rows .code')].map(c => c.textContent),
      pending: document.getElementById('sub-score-pending').textContent,
      // it sits above the submissions table
      aboveMine: document.getElementById('sub-score')
        .compareDocumentPosition(document.getElementById('sub-mine')) === 4
    };
  });
  check('the score sheet names the team\'s place out of the field',
    score.shown && score.heading === 'Your score' && !score.frozenLine &&
    score.rank === '4th of 61 teams' && score.aboveMine, JSON.stringify(score.rank));
  check('every line behind it is a row: code chip, quest, what it scored and what it is worth, a tiered code what it came to',
    score.rows.length === 3 &&
    JSON.stringify(score.rows[0]) === JSON.stringify(['SQ40Wondabyne', '1 × 900', '900']) &&
    JSON.stringify(score.rows[1]) === JSON.stringify(['SQ70Every school', '3 × 113.5', '340.5']) &&
    JSON.stringify(score.rows[2]) === JSON.stringify(['SQ39Suburbs', '120', '120']) &&
    JSON.stringify(score.chips) === JSON.stringify(['SQ40', 'SQ70', 'SQ39']), JSON.stringify(score.rows));
  check('what is still waiting for review is one plain line',
    score.pending === '2 waiting for review.', JSON.stringify(score.pending));

  // a team with no place on the tab (a hidden test team) still reads its total
  scoreAnswer = { ok: true, frozen: false, team: 'Team Ferrous', rank: null, teams: 61, total: 40, lines: [], pending: 0 };
  await p.reload();
  await p.waitForTimeout(900);
  const noRank = await p.evaluate(() => ({
    rankStat: document.getElementById('sub-score-rank-stat').classList.contains('is-hidden'),
    total: document.getElementById('sub-score-total').textContent,
    table: document.getElementById('sub-score-table').classList.contains('is-hidden'),
    empty: !document.getElementById('sub-score-empty').classList.contains('is-hidden'),
    pending: document.getElementById('sub-score-pending').classList.contains('is-hidden')
  }));
  check('with no place on the tab it shows the total alone',
    noRank.rankStat && noRank.total === '40' && noRank.table && noRank.empty && noRank.pending,
    JSON.stringify(noRank));

  // frozen: one line, no numbers at all
  scoreAnswer = { ok: true, frozen: true };
  await p.reload();
  await p.waitForTimeout(900);
  const frozen = await p.evaluate(() => ({
    shown: !document.getElementById('sub-score').classList.contains('is-hidden'),
    line: document.getElementById('sub-score-frozen').textContent,
    lineShown: !document.getElementById('sub-score-frozen').classList.contains('is-hidden'),
    numbers: !document.getElementById('sub-score-live').classList.contains('is-hidden')
  }));
  check('a frozen tab says so in one line and shows nothing else',
    frozen.shown && frozen.lineShown && !frozen.numbers &&
    frozen.line === 'Scores are frozen until the ceremony.', JSON.stringify(frozen));

  // and a fresh send asks for the score again
  scoreAnswer = { ok: true, frozen: false, team: 'Team Ferrous', rank: 2, teams: 61, total: 2000, lines: [], pending: 1 };
  await p.reload();
  await p.waitForTimeout(900);
  const scoreBefore = calls.score;
  await searchFor('SQ40');
  await p.waitForTimeout(300);
  await p.click('#sub-quest-matches button');
  await p.setInputFiles('#sub-files', [{ name: 'again.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(2048, 1) }]);
  await p.click('#sub-send');
  await p.waitForTimeout(800);
  check('a sent submission refreshes the score',
    calls.score > scoreBefore &&
    (await p.$eval('#sub-score-rank', el => el.textContent)) === '2nd of 61 teams',
    'score asked ' + (calls.score - scoreBefore) + ' more times');

  // ---- past the team's review cap the tab still takes it ----
  // the worker answers queued: true and lists it as queued; the page has
  // to say the tab has it rather than read as a failed send
  queueNext = true;
  scoreAnswer = { ok: true, frozen: false, team: 'Team Ferrous', rank: 2, teams: 61, total: 2000, lines: [], pending: 12, queued: 1 };
  await searchFor('SQ40');
  await p.waitForTimeout(300);
  await p.click('#sub-quest-matches button');
  await p.setInputFiles('#sub-files', [{ name: 'later.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(2048, 1) }]);
  await p.click('#sub-send');
  await p.waitForTimeout(800);
  const queuedView = await p.evaluate(() => {
    const st = document.getElementById('sub-status');
    const row = document.querySelector('#sub-mine-rows tr');
    const pill = row && row.querySelector('.pill');
    return {
      line: st.textContent, marked: st.classList.contains('is-queued'),
      pill: pill ? pill.className + ' ' + pill.textContent : '', row: row ? row.textContent : '',
      score: document.getElementById('sub-score-pending').textContent
    };
  });
  check('a queued send says the tab has it, and the list and the score line say it is queued',
    queuedView.marked && /^Sent: SQ40, 1 file\. Queued: it goes to review/.test(queuedView.line) &&
    queuedView.pill === 'pill queued queued' && /Received\./.test(queuedView.row) &&
    queuedView.score === '12 waiting for review and 1 queued behind them.', JSON.stringify(queuedView));
  queueNext = false;
  mineRows.shift();
  scoreAnswer = null;

  // ---- a file too big for one request goes up in slices ----
  // the submission is created at once (the tab sees it), the bytes
  // follow as 20MB PUTs, and a reload offers to resume from the
  // slices the worker already holds
  const BIG_SIZE = 49 * 1024 * 1024;
  const bigBuf = Buffer.alloc(BIG_SIZE, 7);
  calls.parts.length = 0; calls.finish = 0;
  await p.goto(BASE + '/submit/');
  await p.waitForTimeout(600);
  await searchFor('SQ40');
  await p.waitForTimeout(300);
  await p.click('#sub-quest-matches button');
  await p.setInputFiles('#sub-files', [{ name: 'long-cut.mp4', mimeType: 'video/mp4', buffer: bigBuf }]);
  await p.waitForTimeout(200);
  check('a big file is listed for the background, not refused',
    (await p.textContent('#sub-file-list')).includes('uploads in the background'), '');
  await p.click('#sub-send');
  await p.waitForFunction(() => (document.getElementById('sub-status').textContent || '').includes('finished uploading'), null, { timeout: 30000 });
  const sentCreate = calls.create[calls.create.length - 1].body || '';
  check('the create request carries the manifest, not the bytes',
    sentCreate.includes('name="bigfiles"') && sentCreate.includes('long-cut.mp4') && sentCreate.length < 5000, 'len=' + sentCreate.length);
  check('the bytes follow as three slices of the agreed size',
    JSON.stringify(calls.parts.map(x => [x.n, x.bytes])) ===
    JSON.stringify([['1', 20971520], ['2', 20971520], ['3', 9437184]]) && calls.finish === 1,
    JSON.stringify(calls.parts));
  check('a finished upload leaves nothing to resume',
    await p.evaluate(() => localStorage.getItem('scs2-submit-uploads')) === '[]', '');

  // resume: the entry survives, the page asks for the same file again
  calls.parts.length = 0; calls.finish = 0;
  // the stored entry carries no quest, the way one written by an older
  // build does: the worker's answer is where it gets one
  statusAnswer = {
    ok: true, file: 77, size: BIG_SIZE, part_size: 20 * 1024 * 1024, parts: [1, 3],
    name: 'long-cut.mp4', quest: 'SQ40'
  };
  await p.evaluate((size) => {
    localStorage.setItem('scs2-submit-uploads', JSON.stringify([{ file: 77, name: 'long-cut.mp4', size: size, part_size: 20 * 1024 * 1024 }]));
  }, BIG_SIZE);
  await p.reload();
  await p.waitForTimeout(800);
  const resumeText = await p.textContent('#sub-resume');
  check('an interrupted upload is offered for resume, with the quest it belongs to and how far it got',
    !(await p.$eval('#sub-resume', el => el.classList.contains('is-hidden'))) &&
    resumeText.includes('long-cut.mp4') && resumeText.includes('2 of 3 slices sent (67%)') &&
    (await p.textContent('#sub-resume .sub-up-quest')) === 'SQ40', JSON.stringify(resumeText));
  await p.setInputFiles('#sub-resume input[type=file]', [{ name: 'other.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(1024) }]);
  await p.waitForTimeout(300);
  check('a different file is turned away by its size',
    (await p.textContent('#sub-status')).includes('different size'), '');
  await p.setInputFiles('#sub-resume input[type=file]', [{ name: 'long-cut.mp4', mimeType: 'video/mp4', buffer: bigBuf }]);
  // choosing the file used to change nothing on screen; now a box opens
  // that names the quest, the file and the slice it is on
  await p.waitForFunction(() => {
    const box = document.getElementById('sub-uploads');
    return box && !box.classList.contains('is-hidden');
  }, null, { timeout: 10000 });
  const upText = await p.textContent('#sub-uploads');
  check('choosing it opens the upload box, naming the quest, the file and the slice count',
    (await p.textContent('#sub-uploads .sub-up-quest')) === 'SQ40' &&
    upText.includes('long-cut.mp4') && /Slice \d+ of 3/.test(upText), JSON.stringify(upText.slice(0, 160)));
  check('and it says what closing the page would do',
    upText.includes('Keep this page open'), '');
  await p.waitForFunction(() => (document.getElementById('sub-status').textContent || '').includes('finished uploading'), null, { timeout: 30000 });
  check('only the missing slice goes up, then finish',
    JSON.stringify(calls.parts.map(x => [x.n, x.bytes])) === JSON.stringify([['2', 20971520]]) && calls.finish === 1,
    JSON.stringify(calls.parts));
  check('the resume card clears and nothing is left stored',
    (await p.$eval('#sub-resume', el => el.classList.contains('is-hidden'))) &&
    (await p.evaluate(() => localStorage.getItem('scs2-submit-uploads'))) === '[]', '');
  statusAnswer = null;

  // Each entry names its team: another team's is not asked about on this
  // team's sign-in, and an unreachable tab or store drops nothing. Only a
  // 404 on this team's own entry does; one from before entries named a
  // team is kept, and this team does not ask about it again.
  {
    const stored = () => p.evaluate(() => JSON.parse(localStorage.getItem('scs2-submit-uploads') || '[]'));
    const entry = (file, team) => Object.assign({ file, name: 'f' + file + '.mp4', size: BIG_SIZE, part_size: 20 * 1024 * 1024, quest: 'SQ40' }, team ? { team } : {});
    await p.evaluate((list) => localStorage.setItem('scs2-submit-uploads', JSON.stringify(list)), [entry(81, 'Team Rival'), entry(82, 'Team Ferrous')]);
    statusAsks.length = 0;
    // a 500 rather than a 502, which scs.fetch asks again for some seconds
    statusCode = 500;
    await p.reload();
    await p.waitForTimeout(900);
    const unreachable = { asks: statusAsks.slice(), kept: (await stored()).map(e => e.file) };
    await p.evaluate((e) => localStorage.setItem('scs2-submit-uploads', JSON.stringify(JSON.parse(localStorage.getItem('scs2-submit-uploads')).concat([e]))), entry(83));
    statusAsks.length = 0;
    statusCode = 404;
    await p.reload();
    await p.waitForTimeout(900);
    const gone = { asks: statusAsks.slice().sort(), kept: (await stored()).map(e => e.file + ':' + (e.team || (e.not || []).join(','))) };
    statusAsks.length = 0;
    await p.reload();
    await p.waitForTimeout(900);
    const again = statusAsks.slice();
    statusCode = 0;
    check('a stored upload is asked about only by its own team, kept while the tab cannot answer, and dropped on a 404 only when it is this team\'s',
      JSON.stringify(unreachable) === JSON.stringify({ asks: [82], kept: [81, 82] }) &&
      JSON.stringify(gone) === JSON.stringify({ asks: [82, 83], kept: ['81:Team Rival', '83:team ferrous'] }) && again.length === 0,
      JSON.stringify({ unreachable, gone, again }));
    await p.evaluate(() => localStorage.setItem('scs2-submit-uploads', '[]'));
  }

  // ---- straight to R2 ----
  // With the R2 secrets set the worker says so, and every file follows
  // the create as slices sent to the addresses it signs: the create
  // carries the form and the previews, and no slice touches the worker.
  directMode = true;
  calls.parts.length = 0; calls.finish = 0;
  await p.goto(BASE + '/submit/');
  await p.waitForTimeout(700);
  await searchFor('SQ40');
  await p.waitForTimeout(300);
  await p.click('#sub-quest-matches button');
  await p.setInputFiles('#sub-files', [{ name: 'direct.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(4096, 3) }]);
  await p.click('#sub-send');
  await p.waitForFunction(() => (document.getElementById('sub-status').textContent || '').includes('finished uploading'), null, { timeout: 15000 });
  const directCreate = calls.create[calls.create.length - 1].body || '';
  check('in direct mode a photo goes to R2 in a slice of its own, never through the worker',
    /name="whole"\r\n\r\n1\r/.test(directCreate) && !/name="files"/.test(directCreate) && directCreate.includes('direct.jpg') &&
    r2Puts.length === 1 && r2Puts[0].bytes === 4096 && !r2Puts[0].auth && r2Puts[0].type === '' &&
    /partNumber=1/.test(r2Puts[0].url) && calls.parts.length === 0 && calls.finish === 1,
    JSON.stringify({ r2Puts, parts: calls.parts.length, finish: calls.finish }));
  // a file the finish turns down for good is said so in the tab's words,
  // and nothing is left to carry on from
  finishAnswer = [400, { error: 'odd.jpg is not a photo.' }];
  await searchFor('SQ40');
  await p.waitForTimeout(300);
  await p.click('#sub-quest-matches button');
  await p.setInputFiles('#sub-files', [{ name: 'odd.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(4096, 5) }]);
  await p.click('#sub-send');
  await p.waitForFunction(() => (document.getElementById('sub-status').textContent || '').includes('not a photo'), null, { timeout: 15000 }).catch(() => {});
  const turnedDown = await p.evaluate(() => ({
    status: document.getElementById('sub-status').textContent,
    stored: localStorage.getItem('scs2-submit-uploads')
  }));
  finishAnswer = null;
  check('a file the finish refuses is reported in the tab\'s words, not as a dropped connection, and is not kept to resume',
    turnedDown.status === 'odd.jpg is not a photo.' && turnedDown.stored === '[]', JSON.stringify(turnedDown));
  directMode = false;

  // ---- the gallery page ----
  // signed out first: no proof, no request for it, just the way in
  await p.goto(BASE + '/gallery/');
  await p.evaluate(() => localStorage.removeItem('scs2-submit-session'));
  await p.reload();
  await p.waitForTimeout(700);
  check('signed out, the gallery shows the sign-in and asks for nothing',
    !(await p.$eval('#gal-gate', el => el.classList.contains('is-hidden'))) &&
    (await p.textContent('#gal-gate')).includes('Teams only') &&
    !(await p.$eval('#gal-login', el => el.classList.contains('is-hidden'))) &&
    (await p.$$eval('.gal-tile', els => els.length)) === 0, '');
  // the sign-in there is the submit page's: the same request and the
  // same stored session, and the gallery loads without leaving the page
  await p.fill('#gal-team', 'Team Ferrous');
  await p.fill('#gal-code', 'GOODCODE');
  await p.click('#gal-login-btn');
  await p.waitForFunction(() => (document.getElementById('gal-status').textContent || '').includes('Nothing here yet'), null, { timeout: 5000 });
  check('signing in on the gallery stores the submit page\'s session and loads the gallery in place',
    (await p.evaluate(() => localStorage.getItem('scs2-submit-session'))) === 'team-sess-1' &&
    (await p.$eval('#gal-login', el => el.classList.contains('is-hidden'))) &&
    new URL(p.url()).pathname === '/gallery/', p.url());
  check('an empty gallery says so plainly',
    (await p.textContent('#gal-status')).includes('Nothing here yet'), '');
  galleryRows = [{ id: 9, quest_code: 'SQ40', note: 'Platform crew', submitted_at: '2026-10-20 01:00:00', team_name: 'Team Ferrous',
    media: [{ key: 'sub/9/imgkey', type: 'image/jpeg', name: 'a.jpg' }, { key: 'sub/9/vidkey', type: 'video/mp4', name: 'b.mp4' }] }];
  galleryMore = true;
  await p.reload();
  await p.waitForTimeout(700);
  // the day in hours, one square tile per photo and video, each with its
  // code on a black plate and the time and team under it
  const gal = await p.evaluate(() => ({
    hour: (document.querySelector('.gal-hour-time') || {}).textContent,
    quest: (document.querySelector('.gal-quest') || {}).textContent,
    tiles: document.querySelectorAll('.gal-tile').length,
    imgs: document.querySelectorAll('.gal-tile img').length,
    plays: document.querySelectorAll('.gal-play').length,
    meta: (document.querySelector('.gal-meta') || {}).textContent,
    name: (document.querySelector('.gal-name') || {}).textContent,
    holds: (document.getElementById('gal-status') || {}).textContent
  }));
  check('the gallery is the day in hours, with a tile per photo and video',
    /^\d{2}:00$/.test(gal.hour) && gal.quest === 'SQ40' && gal.tiles === 2 && gal.imgs === 2 &&
    gal.plays === 1 && /Team Ferrous$/.test(gal.meta) && gal.name === 'Wondabyne' &&
    gal.holds === '2 photos and videos from 1 team. Showing the newest 1 submission.', JSON.stringify(gal));
  await p.click('.gal-tile');
  await p.waitForTimeout(600);
  check('a tile opens the picture in the viewer, on its own',
    await p.evaluate(() => !!document.querySelector('.lb-overlay img.lb-media') && !document.querySelector('.lb-sheet')), '');
  await p.keyboard.press('Escape');
  await p.waitForTimeout(500);

  // ---- the compress page's choices ----
  // ffmpeg never runs here; the metadata is stubbed so the rows of
  // options can be read for a given shape of video
  const fs2 = require('fs');
  const os2 = require('os');
  const bigPath = path.join(os2.tmpdir(), 'scs-cp-4k.mp4');
  const smallPath = path.join(os2.tmpdir(), 'scs-cp-small.mp4');
  fs2.writeFileSync(bigPath, '');
  fs2.truncateSync(bigPath, 500 * 1024 * 1024); // sparse: costs no real disk
  fs2.writeFileSync(smallPath, '');
  fs2.truncateSync(smallPath, 9 * 1024 * 1024);
  const openCompress = async (dur, w, h, filePath) => {
    // a fresh load each time, or the wait below would find the last
    // video's rows
    await p.goto('about:blank');
    await p.goto(BASE + '/compress/');
    await p.waitForTimeout(400);
    await p.evaluate(({ dur, w, h }) => {
      Object.defineProperty(HTMLVideoElement.prototype, 'duration', { configurable: true, get() { return dur; } });
      Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get() { return w; } });
      Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get() { return h; } });
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        set(v) { this.setAttribute('src', v); setTimeout(() => this.onloadedmetadata && this.onloadedmetadata(), 10); },
        get() { return this.getAttribute('src'); }
      });
    }, { dur, w, h });
    await p.setInputFiles('#cp-file', filePath);
    await p.waitForFunction(() => document.querySelectorAll('#cp-scales .cp-size').length > 0, null, { timeout: 10000 });
    await p.waitForTimeout(150);
    return p.evaluate(() => ({
      scales: [...document.querySelectorAll('#cp-scales .cp-size')].map(b => b.textContent),
      scaleSel: (document.querySelector('#cp-scales .is-selected') || {}).textContent,
      sizes: [...document.querySelectorAll('#cp-sizes .cp-size')].filter(b => !b.classList.contains('is-hidden')).map(b => b.textContent),
      hidden: [...document.querySelectorAll('#cp-sizes .cp-size.is-hidden')].map(b => b.textContent),
      guess: document.getElementById('cp-guess').textContent
    }));
  };
  const cp = await openCompress(240, 3840, 2160, bigPath);
  check('a 4K video is offered 1440p, 1080p, 720p and 480p beside keeping it',
    cp.scales.length === 5 && /^Keep3840×2160/.test(cp.scales[0]) &&
    /^1440p2560×1440/.test(cp.scales[1]) && /^1080p1920×1080/.test(cp.scales[2]), JSON.stringify(cp.scales));
  check('each picture size predicts what it would come to',
    cp.scales.every(s => /about \d+(\.\d)? MB/.test(s)), JSON.stringify(cp.scales));
  check('1080p is picked for a video shot bigger than that', /^1080p/.test(cp.scaleSel || ''), cp.scaleSel);
  check('20 MB for a 500 MB four-minute video at 1080p is not on offer',
    !cp.sizes.some(t => /^20 MB/.test(t)) && cp.hidden.some(t => /^20 MB/.test(t)),
    JSON.stringify({ shown: cp.sizes, hidden: cp.hidden }));
  check('the percentages show what they come to for this file',
    cp.sizes.some(t => /^75%375 MB/.test(t)) && cp.sizes.some(t => /^25%125 MB/.test(t)), JSON.stringify(cp.sizes));
  check('the line under the rows names the target and the picture size',
    /Aiming for/.test(cp.guess) && /1920×1080/.test(cp.guess), JSON.stringify(cp.guess));
  await p.evaluate(() => [...document.querySelectorAll('#cp-scales .cp-size')].find(b => b.textContent.startsWith('480p')).click());
  await p.waitForTimeout(250);
  const smaller = await p.$$eval('#cp-sizes .cp-size:not(.is-hidden)', els => els.map(e => e.textContent));
  check('a smaller picture brings back targets the 4K frame could not carry',
    smaller.some(t => /^20 MB/.test(t)), JSON.stringify(smaller));
  const cp2 = await openCompress(12, 1280, 720, smallPath);
  check('a 720p video is never offered an upscale',
    !cp2.scales.some(s => /^(1440p|1080p)/.test(s)), JSON.stringify(cp2.scales));
  check('targets at or above the file it already is are dropped',
    !cp2.sizes.some(t => /^(20|50|100) MB/.test(t)), JSON.stringify({ shown: cp2.sizes, hidden: cp2.hidden }));
  fs2.unlinkSync(bigPath);
  fs2.unlinkSync(smallPath);

  // ---- a quest that asks several questions ----
  await p.goto(BASE + '/submit/');
  await p.waitForTimeout(800);
  await searchFor('xq9');
  await p.waitForTimeout(300);
  await p.click('#sub-quest-matches button');
  await p.waitForTimeout(200);
  await p.fill('#sub-answer input[type=number]', '4');
  await p.setInputFiles('#sub-files', [{ name: 'ferry.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(2048, 1) }]);
  await p.click('#sub-send');
  await p.waitForTimeout(200);
  const unanswered = await p.textContent('#sub-status');
  await p.click('#sub-answer .sub-choice-opt:nth-child(2)');
  await p.fill('#sub-answer .sub-q:nth-child(3) input[type=text]', 'Sam');
  const sentBefore = calls.create.length;
  await p.click('#sub-send');
  await p.waitForTimeout(800);
  const multiBody = calls.create.length > sentBefore ? calls.create[calls.create.length - 1].body : '';
  const multiRaw = /name="answer"\r\n\r\n([^\r]+)/.exec(multiBody);
  const multi = multiRaw ? JSON.parse(multiRaw[1]) : null;
  const { cleanAnswer } = await import(path.join(ROOT, 'tab/src/submit.ts'));
  check('a quest with several questions asks each, multiple choice as tiles, and sends every answer in the shape the worker keeps',
    unanswered.includes('Pick an answer: Which ferry?') && !!multi && multi.kind === 'count' && multi.value === 4 &&
    multi.more.length === 2 && multi.more[0].value === 'Taronga' && multi.more[1].value === 'Sam' &&
    cleanAnswer(multiRaw[1]) === JSON.stringify(multi),
    JSON.stringify({ unanswered: unanswered, multi: multi }));

  // ---- leaving the page with something in flight ----
  // Two things can be going and they do not cost the same: the create
  // request carries the whole submission and exists nowhere else, and
  // the slices of a large file follow it. Each gets its own wording,
  // neither promises the upload can be picked back up, and while
  // either is running every link on the page asks first.
  //
  // The tap that matters most is the bottom bar's. iOS spends the
  // first tap of a momentum scroll on stopping it, so the bar
  // navigates on the RELEASE of a tap made mid-scroll and no click is
  // ever sent — which is exactly the accidental navigation this is
  // for, and the one a click listener alone would miss. The same jab
  // is made twice: idle it must navigate, which is what proves the
  // release path is live, and busy it must open the panel instead.
  const gctx = await b.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true,        // the app layout, so the bottom bar is there
    serviceWorkers: 'block'
  });
  const gp = await gctx.newPage();
  let holdCreate = false;   // the create request never answers: it stays in flight
  let holdPart = false;     // ditto one slice of a large file
  const held = [];
  const cors = { 'access-control-allow-origin': '*' };
  await gp.route('**/files.scs.andyrew.space/**', async r => {
    const u = r.request().url();
    if (u.includes('/api/questlist')) {
      await r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(questList) });
    } else if (u.includes('/api/submit/create')) {
      if (holdCreate) { held.push(r); return; }
      await r.fulfill({ status: 200, contentType: 'application/json', headers: cors,
        body: JSON.stringify({ ok: true, id: 9, quest: 'SQ40', files: 1, uploads: [] }) });
    } else if (u.includes('/api/submit/upload/part')) {
      if (holdPart) { held.push(r); return; }
      await r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true}' });
    } else if (u.includes('/api/submit/upload/finish')) {
      await r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true,"done":true}' });
    } else if (u.includes('/api/submit/upload/status')) {
      await r.fulfill({ status: 200, contentType: 'application/json', headers: cors,
        body: JSON.stringify({ ok: true, file: 77, size: BIG_SIZE, part_size: 20 * 1024 * 1024,
          parts: [1, 3], name: 'long-cut.mp4', quest: 'SQ40' }) });
    } else if (u.includes('/api/submit/mine')) {
      await r.fulfill({ status: 200, contentType: 'application/json', headers: cors,
        body: JSON.stringify({ ok: true, team: 'Team Ferrous', submissions: [] }) });
    } else {
      await r.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{}' });
    }
  });

  const gerrs = [];
  gp.on('pageerror', e => gerrs.push(e.message));
  const at = () => new URL(gp.url()).pathname;

  // The panel as it stands, or null when there is none.
  const panelNow = () => gp.evaluate(() => {
    const o = document.querySelector('.confirm-overlay');
    if (!o) return null;
    return {
      title: (o.querySelector('.confirm-title') || {}).textContent || '',
      copy: (o.querySelector('.confirm-copy') || {}).textContent || '',
      buttons: [...o.querySelectorAll('.confirm-actions button')].map(x => x.textContent),
      slide: !!o.querySelector('.confirm-slide-thumb')
    };
  });
  const press = (label) => gp.evaluate((label) => {
    [...document.querySelectorAll('.confirm-actions button')].forEach(b2 => {
      if (b2.textContent === label) b2.click();
    });
  }, label);
  // Step one: dragged the whole way and RELEASED at the far end.
  // Synthetic pointers, so setPointerCapture throws and the control's
  // own catch takes it.
  const slideAcross = () => gp.evaluate(() => {
    const track = document.querySelector('.confirm-slide');
    const thumb = document.querySelector('.confirm-slide-thumb');
    const box = track.getBoundingClientRect();
    const fire = (type, x) => thumb.dispatchEvent(new PointerEvent(type, {
      bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientX: x, clientY: box.top + 10
    }));
    fire('pointerdown', box.left + 20);
    fire('pointermove', box.left + 80);
    fire('pointermove', box.right + 300);   // past the end; the thumb clamps
    fire('pointerup', box.right + 300);
  });
  // A tab-bar tap made while the page is still moving. No click is
  // synthesised, deliberately — a synthetic TouchEvent does not
  // produce one, which is the whole point.
  const jabTabBar = (href) => gp.evaluate((href) => {
    const link = document.querySelector('.tab-bar a[href="' + href + '"]');
    if (!link) return Promise.resolve({ ok: false, why: 'no bar link for ' + href });
    let seen = 0;
    const count = () => { seen += 1; };
    document.addEventListener('scroll', count, true);
    document.body.scrollTop = 400;
    return new Promise(done => {
      setTimeout(() => {
        document.removeEventListener('scroll', count, true);
        // a page too short to scroll still has to be able to make the
        // moment: the bar reads the clock, not the distance
        if (!seen) document.body.dispatchEvent(new Event('scroll', { bubbles: true }));
        const box = link.getBoundingClientRect();
        const x = Math.round(box.left + box.width / 2);
        const y = Math.round(box.top + box.height / 2);
        const t = new Touch({ identifier: 3, target: link, clientX: x, clientY: y, pageX: x, pageY: y });
        link.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t]
        }));
        setTimeout(() => {
          link.dispatchEvent(new TouchEvent('touchend', {
            bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t]
          }));
          done({ ok: true, realScroll: seen > 0, to: link.href });
        }, 40);
      }, 80);
    });
  }, href);

  const signIn = async () => {
    await gp.goto(BASE + '/submit/');
    await gp.evaluate(() => {
      localStorage.setItem('scs2-submit-session', 'team-sess-1');
      localStorage.setItem('scs2-submit-team', 'Team Ferrous');
    });
    await gp.reload();
    await gp.waitForTimeout(800);
  };
  const pickAndAttach = async () => {
    await searchFor('SQ40', gp);
    await gp.waitForTimeout(350);
    await gp.click('#sub-quest-matches button');
    await gp.setInputFiles('#sub-files', [{ name: 'proof.jpg', mimeType: 'image/jpeg', buffer: Buffer.alloc(2048, 1) }]);
    await gp.waitForTimeout(200);
  };

  // ---- idle: every link is an ordinary link ----
  await signIn();
  check('the bottom bar is there to be tapped',
    (await gp.$eval('.tab-bar', el => getComputedStyle(el).display)) === 'grid', '');
  await gp.click('.tab-bar a[href="../questlist/"]');
  await gp.waitForTimeout(600);
  check('nothing in flight: a link just goes',
    at() === '/questlist/' && (await panelNow()) === null, at());
  await signIn();
  const idleJab = await jabTabBar('../').catch(() => ({ ok: true, navigated: true }));
  await gp.waitForTimeout(700);
  check('nothing in flight: the bar still navigates on the release of a mid-scroll tap',
    at() === '/' && (await panelNow()) === null, JSON.stringify(idleJab) + ' at ' + at());

  // ---- the create request: the whole submission, and not resumable ----
  holdCreate = true;
  await signIn();
  await pickAndAttach();
  await gp.click('#sub-send');
  await gp.waitForTimeout(700);
  check('a send that has not landed leaves the button busy',
    await gp.$eval('#sub-send', el => el.disabled && el.classList.contains('is-busy')), '');
  await gp.click('.tab-bar a[href="../questlist/"]');
  await gp.waitForTimeout(400);
  const sendAsk = await panelNow();
  check('mid-send: a link opens the panel instead of leaving',
    !!sendAsk && at() === '/submit/' && sendAsk.slide && sendAsk.title === 'Leave this page?',
    JSON.stringify(sendAsk && sendAsk.title) + ' at ' + at());
  // The shared slide panel's own sentence has gone with it: the thumb,
  // the arrow and the word Slide on the track are the instruction, and
  // a line repeating them a size larger was the label said twice. The
  // submit page's own half of the copy is what this check is for and is
  // unchanged.
  check('and it says the submission is not saved anywhere yet',
    !!sendAsk && sendAsk.copy === 'This submission is still being sent. Nothing is kept until it ' +
      'arrives, so it would have to be filled in and sent again.',
    JSON.stringify(sendAsk && sendAsk.copy));
  await press('Stay here');
  await gp.waitForTimeout(500);
  check('Stay here closes the panel and leaves the send alone',
    (await panelNow()) === null && at() === '/submit/' &&
    (await gp.$eval('#sub-send', el => el.disabled && el.classList.contains('is-busy'))), at());
  const sendJab = await jabTabBar('../');
  await gp.waitForTimeout(400);
  const sendJabbed = await panelNow();
  check('mid-send: a tab-bar tap made mid-scroll is caught before the bar can navigate',
    !!sendJabbed && at() === '/submit/' && sendJabbed.copy === (sendAsk && sendAsk.copy),
    JSON.stringify(sendJab) + ' at ' + at());
  await press('Stay here');
  await gp.waitForTimeout(400);
  holdCreate = false;

  // ---- the slices of a large file: the other cost, and its own words ----
  holdPart = true;
  await signIn();
  await gp.evaluate((size) => {
    localStorage.setItem('scs2-submit-uploads', JSON.stringify([
      { file: 77, name: 'long-cut.mp4', size: size, part_size: 20 * 1024 * 1024, quest: 'SQ40' }
    ]));
  }, BIG_SIZE);
  await gp.reload();
  await gp.waitForTimeout(900);
  await gp.setInputFiles('#sub-resume input[type=file]', [{ name: 'long-cut.mp4', mimeType: 'video/mp4', buffer: bigBuf }]);
  await gp.waitForFunction(() => {
    const box = document.getElementById('sub-uploads');
    return box && !box.classList.contains('is-hidden');
  }, null, { timeout: 15000 });
  await gp.waitForTimeout(400);
  const upJab = await jabTabBar('../');
  await gp.waitForTimeout(400);
  const upAsk = await panelNow();
  check('mid-upload: a tab-bar tap made mid-scroll is caught before the bar can navigate',
    !!upAsk && at() === '/submit/' && upAsk.slide && upAsk.title === 'Leave this page?',
    JSON.stringify(upJab) + ' at ' + at());
  await press('Stay here');
  await gp.waitForTimeout(500);
  check('Stay here closes the panel and leaves the upload alone',
    (await panelNow()) === null && at() === '/submit/' &&
    !(await gp.$eval('#sub-uploads', el => el.classList.contains('is-hidden'))), at());

  // ---- the far end, then the second panel, then away ----
  await gp.click('.tab-bar a[href="../questlist/"]');
  await gp.waitForTimeout(400);
  await slideAcross();
  await gp.waitForTimeout(300);
  const upLast = await panelNow();
  check('sliding to the far end and letting go there opens the last check',
    !!upLast && !upLast.slide && upLast.title === 'Last check' &&
    JSON.stringify(upLast.buttons) === JSON.stringify(['Stay here', 'Leave the page']),
    JSON.stringify(upLast && upLast.buttons));
  check('the last check says the same thing and what leaving does',
    !!upLast && upLast.copy === 'A file is still uploading. The submission is already with ' +
      'the tab team but the file is not, and it will not finish on its own. Leaving this page stops it.',
    JSON.stringify(upLast && upLast.copy));
  check('no page errors', gerrs.length === 0, gerrs.slice(0, 3).join(' | '));
  await press('Leave the page');
  await gp.waitForTimeout(1500);
  check('Leave the page finally leaves it', at() === '/questlist/', at());

  for (const r of held) { try { await r.abort(); } catch (e) { /* the context is going */ } }
  await gctx.close();

  // ---- what a quest takes ----
  // Each quest's rules (`rules.files` in the quest list) set what the
  // picker offers and how many files are kept; a quest answered with its
  // questions alone has no file field, and its send is the answer alone.
  const ruled = (key, name, more) => Object.assign({
    key: key, name: name, region: questData.REGIONS[0], description: '', flavour: '', location: '', coords: [],
    submit: 'none', prompt: '', options: [], codes: [{ code: key, label: '', points: 50 }]
  }, more);
  questList.groups.push(
    ruled('ASK7', 'Ferry count', { submit: 'count', prompt: 'How many ferries?', rules: { files: { kinds: [], max: 0, required: false } } }),
    ruled('RUN7', 'Coastal run', { rules: { files: { kinds: ['photo', 'gpx'], max: 6, required: true } } })
  );
  await p.evaluate(() => localStorage.removeItem('scs2-questlist-cache'));
  await p.goto(BASE + '/submit/');
  await p.waitForTimeout(800);
  const pickQuest = async (key) => {
    await searchFor(key);
    await p.waitForTimeout(300);
    await p.click('#sub-quest-matches button');
    await p.waitForTimeout(200);
  };
  await pickQuest('ASK7');
  const noField = await p.$eval('#sub-files-field', el => getComputedStyle(el).display === 'none');
  await p.fill('#sub-answer input[type=number]', '3');
  const sendsBefore = calls.create.length;
  await p.click('#sub-send');
  await p.waitForTimeout(600);
  const askBody = calls.create.length > sendsBefore ? calls.create[calls.create.length - 1].body : '';
  check('a quest that takes no files has no file field, and its send carries the answer alone',
    noField && /name="quest"\r\n\r\nASK7\r/.test(askBody) && askBody.includes('name="answer"') &&
    !askBody.includes('name="files"') && !askBody.includes('name="bigfiles"'), JSON.stringify({ noField, sent: askBody.length }));

  await pickQuest('RUN7');
  await p.setInputFiles('#sub-files', Array.from({ length: 7 }, (_, i) => ({
    name: 'leg' + i + '.gpx', mimeType: 'application/octet-stream', buffer: Buffer.from('<?xml version="1.0"?><gpx></gpx>')
  })));
  await p.waitForTimeout(200);
  const run = await p.evaluate(() => ({
    accept: document.getElementById('sub-files').accept,
    label: document.getElementById('sub-files-label').textContent,
    rows: document.querySelectorAll('#sub-file-list li').length
  }));
  check('a quest taking photos and GPX tracks offers those in the picker, and keeps no more files than it takes',
    run.accept.includes('.gpx') && run.accept.includes('image/*') && !run.accept.includes('video/') &&
    run.rows === 6 && run.label.includes('6'), JSON.stringify(run));
  // ---- a challenge: the team's count under the quest ----
  {
    const tctx = await b.newContext({ serviceWorkers: 'block', viewport: { width: 1100, height: 950 } });
    const tp = await tctx.newPage();
    const challengeList = Object.assign({}, questList, { groups: questList.groups.concat([{
      key: 'XQ8', name: 'Most stations', region: questData.REGIONS[0], description: '', flavour: '', location: '', coords: [],
      submit: 'pick', prompt: 'Stations', options: ['@stations'], codes: [{ code: 'XQ8', label: '', points: 10 }],
      rules: { files: { kinds: ['photo'], max: 4, required: true }, tally: { kind: 'picks', awards: [100], public: false } }
    }]) });
    const tallyAsks = [];
    await tp.route('**/files.scs.andyrew.space/**', async r => {
      const u = r.request().url();
      const cors = { 'access-control-allow-origin': '*' };
      if (u.includes('/api/questlist')) {
        await r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(challengeList) });
      } else if (u.includes('/api/submit/tally')) {
        tallyAsks.push({ quest: new URL(u).searchParams.get('quest'), auth: r.request().headers()['authorization'] });
        await r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({
          ok: true, frozen: false, key: 'XQ8', kind: 'picks', count: 3, waiting: 1,
          items: ['Central', 'Redfern', 'Town Hall'], waiting_items: ['Wynyard'] }) });
      } else if (u.includes('/api/submit/mine')) {
        await r.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: '{"ok":true,"submissions":[]}' });
      } else {
        await r.fulfill({ status: 404, contentType: 'application/json', headers: cors, body: '{}' });
      }
    });
    await tp.addInitScript(() => {
      localStorage.setItem('scs2-submit-session', 'team-sess-1');
      localStorage.setItem('scs2-submit-team', 'Team Ferrous');
    });
    await tp.goto(BASE + '/submit/#XQ8');
    await tp.waitForSelector('#sub-tally:not(.is-hidden)', { timeout: 8000 }).catch(() => {});
    const said = await tp.$eval('#sub-tally', el => [...el.querySelectorAll('p')].map(p => p.textContent));
    check('a challenge picked on the submit page says the team\'s count, what is waiting and what it has so far',
      JSON.stringify(said) === JSON.stringify(['Your count: 3 · 1 waiting for review', 'So far: Central, Redfern, Town Hall']) &&
      tallyAsks.length === 1 && tallyAsks[0].quest === 'XQ8' && tallyAsks[0].auth === 'Bearer team-sess-1',
      JSON.stringify({ said, tallyAsks }));
    await tctx.close();
  }

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  await b.close();
  if (server) server.kill();
  process.exit(fail === 0 ? 0 : 1);
})();
