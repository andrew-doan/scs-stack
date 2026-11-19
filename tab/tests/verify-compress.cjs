// The compress page, in all five of its states.
//
//   node tests/verify-compress.cjs
//
// verify-redesign.cjs covers /compress/ as it loads, whose first state
// draws almost nothing. Everything it is for is behind a file picker,
// so it needs a suite that walks the states and audits each one:
// nothing chosen, a file chosen, running, done, failed.
//
// The engine is a 31MB download and the sandbox has no network, so
// FFmpegWASM is replaced after each load by a stub that reports
// progress and hands back a blob of a size the test chooses. Nothing
// else is stubbed: the metadata probe is answered the way
// verify-submit-page.cjs answers it, and the page's own script runs.
//
// The browser's own codecs (webcodecs.js) are tried before the engine.
// This Chromium decodes and encodes H.264 in software and cannot decode
// HEVC, so real clips made with the system's ffmpeg take each way: an
// iPhone-style MOV and an Android-style MP4 through WebCodecs, read back
// with ffprobe and the worker's own video reader, and an HEVC clip falls
// back to the engine. That part is skipped where ffmpeg is not installed.
//
// The page is served with the headers netlify.toml gives it, read from
// that file, for one real run: isolated, it loads the multi-threaded
// engine from assets/ffmpeg-mt/, which needs those headers on the page
// and on every worker script the engine starts.
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { pathToFileURL } = require('url');

function browser() {
  for (const t of [
    path.join(__dirname, '..', 'node_modules', 'playwright'),
    path.join(__dirname, '..', '..', 'checkin', 'node_modules', 'playwright'),
    'playwright'
  ]) { try { return require(t); } catch (e) { /* next */ } }
  throw new Error('playwright not found');
}

var ROOT = path.join(__dirname, '..', '..');
var SITE = path.join(ROOT, 'website');
var BASE = 'http://127.0.0.1:8123';

var CHROME = ['.site-nav', '.site-footer', '.tab-bar',
  '.settings-panel', '.toast-stack', '.app-splash', '.ptr', '.urgent-wrap'];

var fail = 0;
function check(name, ok, detail) {
  if (!ok) fail++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '  ' + detail : ''));
}

(async () => {
  var server = null;
  var up = await fetch(BASE + '/').then(function () { return true; }).catch(function () { return false; });
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await new Promise(function (r) { setTimeout(r, 1200); });
  }

  // A sparse file: it costs no real disk and the page only ever reads
  // its size and its name.
  var big = path.join(require('os').tmpdir(), 'scs-verify-compress-4k.mp4');
  fs.writeFileSync(big, '');
  fs.truncateSync(big, 120 * 1024 * 1024);
  var bad = path.join(require('os').tmpdir(), 'scs-verify-compress-bad.mp4');
  fs.writeFileSync(bad, 'not a video');

  var chromium = browser().chromium;
  var exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  var b = await chromium.launch(exe ? { executablePath: exe } : {});

  for (var w of [1280, 390]) {
    for (var theme of ['light', 'dark']) {
      await walk(b, w, theme, big, bad);
    }
  }
  await guarded(b, big);
  poolCoversThreads();
  await ownCodecs(b);

  fs.unlinkSync(big);
  fs.unlinkSync(bad);
  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  if (server) server.kill();
  await b.close();
  process.exit(fail ? 1 : 0);
})();

// The metadata probe and the engine, stubbed. The engine is a 31MB
// download and the sandbox has no network, so FFmpegWASM is replaced
// with something that reports progress and hands back a blob of a size
// the test chooses. `__ffHold` parks it at 62% so the running state can
// be read — and held there for as long as a test needs the page busy.
function stubEngine(p) {
  return p.evaluate(function () {
    Object.defineProperty(HTMLVideoElement.prototype, 'duration', { configurable: true, get: function () { return 240; } });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', { configurable: true, get: function () { return 3840; } });
    Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', { configurable: true, get: function () { return 2160; } });
    // The src is held rather than put on the element: a blob of
    // zeros is not a video, so a real load fires onerror and the
    // probe reads a duration of 0 — which is the failure state, and
    // it raced the metadata answer.
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      set: function (v) {
        this.__src = v;
        var self = this;
        setTimeout(function () { if (self.onloadedmetadata) self.onloadedmetadata(); }, 10);
      },
      get: function () { return this.__src || ''; }
    });
    window.__ffOut = 3.2 * 1024 * 1024;  // what the stub hands back
    window.__ffFail = false;
    window.__ffHold = false;             // stop at 62% so the running state can be read
    window.FFmpegWASM = {
      FFmpeg: function () {
        var listeners = {};
        this.on = function (n, fn) { listeners[n] = fn; };
        this.load = function () { return new Promise(function (r) { setTimeout(r, 40); }); };
        this.writeFile = function () { return Promise.resolve(); };
        this.deleteFile = function () { return Promise.resolve(); };
        // the header's tags, read before the run: a place, make and
        // model under the plain names an Android phone writes
        this.readFile = function (name) {
          if (name === 'tags.txt') return Promise.resolve(new TextEncoder().encode(';FFMETADATA1\nlocation=-33.8688+151.2093/\nmake=Google\nmodel=Pixel 9\n'));
          return Promise.resolve(new Uint8Array(window.__ffOut));
        };
        this.exec = function (args) {
          window.__ffRuns = (window.__ffRuns || []).concat([args]);
          if (args.indexOf('ffmetadata') !== -1) return Promise.resolve(0);
          return new Promise(function (res, rej) {
            var pct = 0;
            var tick = setInterval(function () {
              pct += 31;
              if (window.__ffHold && pct > 62) pct = 62;
              if (listeners.progress) listeners.progress({ progress: Math.min(pct, 100) / 100 });
              if (window.__ffHold && pct >= 62) return;
              if (pct >= 100) {
                clearInterval(tick);
                if (window.__ffFail) rej(new Error('out of memory'));
                else res(0);
              }
            }, 60);
          });
        };
      }
    };
  });
}

async function openView(p, base) {
  await p.goto((base || BASE) + '/compress/', { waitUntil: 'load' });
  await p.waitForTimeout(400);
}

async function walk(b, width, theme, big, bad) {
  console.log('\n/compress/  ' + width + 'px  ' + theme);

  var ctx = await b.newContext({
    viewport: { width: width, height: 900 },
    serviceWorkers: 'block'
  });
  var p = await ctx.newPage();
  await p.route('**://files.scs.andyrew.space/**', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  var errs = [];
  var missing = [];
  p.on('pageerror', function (e) { errs.push(e.message); });
  p.on('requestfailed', function (req) {
    // the preview's blob: url is a stub blob the fake engine made, and
    // a video element refusing to decode it is not the page's fault
    if (req.url().indexOf(BASE) === 0) missing.push(req.url().slice(BASE.length));
  });
  p.on('response', function (res) {
    if (res.url().indexOf(BASE) === 0 && res.status() >= 400) {
      missing.push(res.status() + ' ' + res.url().slice(BASE.length));
    }
  });
  if (theme === 'dark') {
    await p.addInitScript(function () {
      try { localStorage.setItem('scs2-theme', 'dark'); } catch (e) {}
    });
  }

  var stubs = function () { return stubEngine(p); };

  var stage = function () { return p.$eval('#cp-tool', function (el) { return el.getAttribute('data-stage'); }); };

  // ---- 1. nothing chosen ----
  await openView(p);
  await stubs();
  check('it opens with nothing chosen', await stage() === 'idle', await stage());
  // the picker is a <label for>, and the file row was moved above it,
  // so the wiring is worth proving rather than assuming
  var chooser = null;
  try {
    chooser = await Promise.all([
      p.waitForEvent('filechooser', { timeout: 4000 }),
      p.click('.cp-pick')
    ]);
  } catch (e) { /* reported below */ }
  check('the picker opens the file chooser', !!chooser, '');
  await audit(p, 'nothing chosen', width);

  // ---- 2. a file chosen ----
  await p.setInputFiles('#cp-file', big);
  await p.waitForFunction(function () {
    return document.querySelectorAll('#cp-scales .cp-size').length > 0;
  }, null, { timeout: 20000 });
  await p.waitForTimeout(250);
  check('a file chosen', await stage() === 'ready', await stage());
  check('the file row carries the size, the length and the picture',
    /120\.00 MB · 4:00 long · 3840×2160/.test(await p.$eval('#cp-details', function (e) { return e.textContent; })),
    await p.$eval('#cp-details', function (e) { return e.textContent; }));
  check('every picture size says what it would come to',
    await p.$$eval('#cp-scales .cp-size .cp-size-fig', function (els) {
      return els.length > 0 && els.every(function (e) { return /^about \d/.test(e.textContent); });
    }), '');
  check('every target on offer says what it is in the other unit',
    await p.$$eval('#cp-sizes .cp-size:not(.is-hidden) .cp-size-fig', function (els) {
      return els.length > 0 && els.every(function (e) { return /\d/.test(e.textContent); });
    }), '');
  check('one picture size and one target are picked',
    (await p.$$eval('#cp-scales .is-selected', function (e) { return e.length; })) === 1 &&
    (await p.$$eval('#cp-sizes .is-selected:not(.is-hidden)', function (e) { return e.length; })) === 1, '');
  await audit(p, 'a file chosen', width);

  // ---- 3. running ----
  await p.evaluate(function () { window.__ffHold = true; });
  await p.click('#cp-run');
  await p.waitForFunction(function () {
    return document.getElementById('cp-pct').textContent === '62%';
  }, null, { timeout: 20000 });
  await p.waitForTimeout(150);
  check('running', await stage() === 'busy', await stage());
  check('the bar and the tab\'s title have moved to match the percentage',
    (await p.$eval('#cp-bar', function (e) { return e.style.width; })) === '62%' &&
    /^62% compressing a video \| /.test(await p.title()),
    (await p.$eval('#cp-bar', function (e) { return e.style.width; })) + ' ' + (await p.title()));
  await audit(p, 'running', width);

  // ---- 4. done ----
  await p.evaluate(function () { window.__ffHold = false; });
  await p.waitForFunction(function () {
    return document.getElementById('cp-tool').getAttribute('data-stage') === 'done';
  }, null, { timeout: 20000 });
  await p.waitForTimeout(300);
  check('done', await stage() === 'done', await stage());
  // what the phone wrote goes into the smaller file, under the names the
  // worker's video reader (videostrip.js) takes from an MP4
  var ran = await p.evaluate(function () { var r = window.__ffRuns || []; return r[r.length - 1].join(' '); });
  check('the run keeps every tag the phone wrote, its place under the name the worker reads',
    / -map_metadata 0 /.test(ran) && /use_metadata_tags/.test(ran) &&
    ran.indexOf('-metadata com.apple.quicktime.location.ISO6709=-33.8688+151.2093/') !== -1 &&
    ran.indexOf('-metadata com.apple.quicktime.model=Pixel 9') !== -1, ran);
  check('the result is what it was against what it is',
    (await p.$eval('#cp-result-line', function (e) { return e.textContent; })) === '120.00 MB→3.20 MB',
    await p.$eval('#cp-result-line', function (e) { return e.textContent; }));
  check('the title goes back', (await p.title()).indexOf('compressing') === -1, await p.title());
  await audit(p, 'done', width);

  // ---- 4b. done, over the target ----
  await p.evaluate(function () { window.__ffOut = 80 * 1024 * 1024; });
  await p.click('#cp-run');
  await p.waitForFunction(function () {
    return document.getElementById('cp-tool').getAttribute('data-stage') === 'done';
  }, null, { timeout: 20000 });
  await p.waitForTimeout(200);

  // ---- 5. failed ----
  await p.evaluate(function () { window.__ffFail = true; });
  await p.click('#cp-run');
  await p.waitForFunction(function () {
    return document.getElementById('cp-tool').getAttribute('data-stage') === 'failed';
  }, null, { timeout: 20000 });
  await p.waitForTimeout(250);
  check('failed', await stage() === 'failed', await stage());
  check('the stale result went with it',
    await p.$eval('#cp-result', function (e) { return e.classList.contains('is-hidden'); }), '');
  await audit(p, 'failed', width);

  // ---- a file that is not a video ----
  await openView(p);
  await stubs();
  await p.evaluate(function () {
    Object.defineProperty(HTMLVideoElement.prototype, 'duration', { configurable: true, get: function () { return 0; } });
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      configurable: true,
      set: function (v) {
        this.__src = v;
        var self = this;
        setTimeout(function () { if (self.onerror) self.onerror(); }, 10);
      },
      get: function () { return this.__src || ''; }
    });
  });
  await p.setInputFiles('#cp-file', bad);
  await p.waitForFunction(function () {
    return document.getElementById('cp-tool').getAttribute('data-stage') === 'failed';
  }, null, { timeout: 20000 });
  await p.waitForTimeout(200);
  check('a file that is not a video fails, and the dead choices come away with it',
    (await p.$eval('#cp-target-wrap', function (e) { return e.classList.contains('is-hidden'); })) &&
    /could not be read as a video/.test(await p.$eval('#cp-status', function (e) { return e.textContent; })), '');
  await audit(p, 'not a video', width);

  // ---- and round again ----
  await openView(p);
  await stubs();
  await p.setInputFiles('#cp-file', big);
  await p.waitForFunction(function () {
    return document.querySelectorAll('#cp-scales .cp-size').length > 0;
  }, null, { timeout: 20000 });
  await p.click('#cp-run');
  await p.waitForFunction(function () {
    return document.getElementById('cp-tool').getAttribute('data-stage') === 'done';
  }, null, { timeout: 20000 });

  check('the link under the result goes to the submit page',
    (await p.$eval('.cp-then a', function (a) { return new URL(a.href).pathname; })) === '/submit/',
    await p.$eval('.cp-then a', function (a) { return a.href; }));

  await p.click('#cp-again');
  await p.waitForTimeout(200);
  check('Compress another puts it back to a chosen file with no result',
    (await stage()) === 'ready' &&
    (await p.$eval('#cp-result', function (e) { return e.classList.contains('is-hidden'); })), await stage());

  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
  check('every same-origin request answered', missing.length === 0, missing.slice(0, 3).join(' | '));

  await ctx.close();
}

// ---- leaving the page while it is compressing ----
// Nothing is written out until a run finishes, so a link followed by
// accident costs the whole thing. `scs.guardLeaving` stands the
// slide-and-confirm in front of every link while the page is busy and
// lets them all through when it is not.
//
// The case that matters most is the bottom bar. iOS spends the first
// tap of a momentum scroll on stopping it, so the bar navigates on the
// RELEASE of a tap made mid-scroll and no click is ever sent — which is
// exactly the accidental navigation this guard is for, and the one a
// click listener alone would miss. Both jabs below are the same
// gesture: idle it must navigate (which is what proves the release
// path is live), busy it must open the panel instead.

// The panel as it stands, or null when there is none.
function panelNow(p) {
  return p.evaluate(function () {
    var o = document.querySelector('.confirm-overlay');
    if (!o) return null;
    return {
      title: (o.querySelector('.confirm-title') || {}).textContent || '',
      copy: (o.querySelector('.confirm-copy') || {}).textContent || '',
      buttons: [].map.call(o.querySelectorAll('.confirm-actions button'), function (b) { return b.textContent; }),
      slide: !!o.querySelector('.confirm-slide-thumb')
    };
  });
}

// How many panels are up. One tap must never leave two.
function panelCount(p) {
  return p.evaluate(function () { return document.querySelectorAll('.confirm-overlay').length; });
}

// Answer whichever panel is on screen with the safe button.
function stayHere(p) {
  return p.evaluate(function () {
    [].forEach.call(document.querySelectorAll('.confirm-actions button'), function (b) {
      if (b.textContent === 'Stay here') b.click();
    });
  });
}

// Step one: the thumb has to be dragged the whole way and RELEASED at
// the far end. Synthetic pointers, so setPointerCapture throws and the
// control's own catch takes it — the same path a test harness always
// gets.
function slideAcross(p) {
  return p.evaluate(function () {
    var track = document.querySelector('.confirm-slide');
    var thumb = document.querySelector('.confirm-slide-thumb');
    var box = track.getBoundingClientRect();
    var fire = function (type, x) {
      thumb.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 1, pointerType: 'touch', clientX: x, clientY: box.top + 10
      }));
    };
    fire('pointerdown', box.left + 20);
    fire('pointermove', box.left + 80);
    fire('pointermove', box.right + 300);   // past the end; the thumb clamps
    fire('pointerup', box.right + 300);
  });
}

// A tab-bar tap made while the page is still moving: scroll, then a
// touch that goes down and comes up in the same place within 250ms of
// the scroll. No click is synthesised, deliberately — a synthetic
// TouchEvent does not produce one, which is the whole point.
function jabTabBar(p, href) {
  return p.evaluate(function (href) {
    var link = document.querySelector('.tab-bar a[href="' + href + '"]');
    if (!link) return Promise.resolve({ ok: false, why: 'no bar link for ' + href });
    var seen = 0;
    var count = function () { seen += 1; };
    document.addEventListener('scroll', count, true);
    document.body.scrollTop = 400;
    return new Promise(function (done) {
      setTimeout(function () {
        document.removeEventListener('scroll', count, true);
        // a page too short to scroll still has to be able to make the
        // moment: the bar reads the clock, not the distance
        if (!seen) document.body.dispatchEvent(new Event('scroll', { bubbles: true }));
        var box = link.getBoundingClientRect();
        var x = Math.round(box.left + box.width / 2);
        var y = Math.round(box.top + box.height / 2);
        var t = new Touch({ identifier: 3, target: link, clientX: x, clientY: y, pageX: x, pageY: y });
        link.dispatchEvent(new TouchEvent('touchstart', {
          bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t]
        }));
        setTimeout(function () {
          link.dispatchEvent(new TouchEvent('touchend', {
            bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t]
          }));
          done({ ok: true, realScroll: seen > 0, to: link.href });
        }, 40);
      }, 80);
    });
  }, href);
}

async function guarded(b, big) {
  console.log('\n/compress/  leaving a run');

  var ctx = await b.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true, hasTouch: true,       // the app layout, so the bottom bar is there
    serviceWorkers: 'block'
  });
  var p = await ctx.newPage();
  await p.route('**://files.scs.andyrew.space/**', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  var errs = [];
  p.on('pageerror', function (e) { errs.push(e.message); });

  var here = function () { return new URL(p.url()).pathname; };
  var start = async function () {
    await openView(p);
    await stubEngine(p);
    await p.evaluate(function () { window.__ffHold = true; });
    await p.setInputFiles('#cp-file', big);
    await p.waitForFunction(function () {
      return document.querySelectorAll('#cp-scales .cp-size').length > 0;
    }, null, { timeout: 20000 });
    await p.click('#cp-run');
    await p.waitForFunction(function () {
      return document.getElementById('cp-tool').getAttribute('data-stage') === 'busy';
    }, null, { timeout: 20000 });
    await p.waitForTimeout(150);
  };

  // ---- idle: every link is an ordinary link ----
  await openView(p);
  check('the bottom bar is there to be tapped',
    (await p.$eval('.tab-bar', function (el) { return getComputedStyle(el).display; })) === 'grid', '');
  await p.click('.tab-bar a[href="../questlist/"]');
  await p.waitForTimeout(600);
  check('nothing running: a link just goes',
    here() === '/questlist/' && (await panelNow(p)) === null, here());

  await openView(p);
  var idleJab = await jabTabBar(p, '../').catch(function () { return { ok: true, navigated: true }; });
  await p.waitForTimeout(700);
  check('nothing running: the bar still navigates on the release of a mid-scroll tap',
    here() === '/' && (await panelNow(p)) === null, JSON.stringify(idleJab) + ' at ' + here());

  // ---- running: the same two taps ask first ----
  await start();
  await p.click('.tab-bar a[href="../questlist/"]');
  await p.waitForTimeout(400);
  var asked = await panelNow(p);
  check('running: a link opens the panel instead of leaving',
    !!asked && here() === '/compress/' && asked.slide && asked.title === 'Leave this page?',
    JSON.stringify(asked && asked.title) + ' at ' + here());
  check('the panel says what is running and what stopping it costs',
    // "Slide all the way to the right and let go there." came off the
    // shared panel: the thumb, the arrow and the word Slide on the
    // track are the instruction, and the line was saying them again a
    // size larger. What is left is this page's own half.
    !!asked && asked.copy === 'A video is being compressed. Stopping it loses the work — the next run starts from the beginning, and the 31 MB engine downloads again if the browser has not kept it.',
    JSON.stringify(asked && asked.copy));

  // ---- cancelling stays put, and stays busy ----
  await stayHere(p);
  await p.waitForTimeout(500);
  check('Stay here closes the panel and leaves the run alone',
    (await panelNow(p)) === null && here() === '/compress/' &&
    (await p.$eval('#cp-tool', function (el) { return el.getAttribute('data-stage'); })) === 'busy' &&
    (await p.$eval('#cp-pct', function (el) { return el.textContent; })) === '62%', here());

  // ---- one tap, one question ----
  // Two paths reach the guard for a single tap on the bottom bar of an
  // iPhone: the touch release opens the panel and preventDefaults the
  // click that would follow, but the invisible haptic switch over the
  // bar forwards the tap with host.click(), and a click the page
  // dispatched itself is not the one preventDefault was holding back. A
  // stutter tap does the same on any device. Both opened a second panel
  // under the first, so answering the one on screen left the reader
  // looking at another and the slide had to be done the whole way twice.
  await p.evaluate(function () {
    var a = document.querySelector('.tab-bar a[href="../"]');
    var box = a.getBoundingClientRect();
    var x = Math.round(box.left + box.width / 2);
    var y = Math.round(box.top + box.height / 2);
    var t = new Touch({ identifier: 5, target: a, clientX: x, clientY: y, pageX: x, pageY: y });
    a.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true, cancelable: true, touches: [t], targetTouches: [t], changedTouches: [t]
    }));
    a.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t]
    }));
    a.click();     // what the invisible haptic switch forwards
  });
  await p.waitForTimeout(400);
  check('a release the haptic switch also forwards as a click asks once, not twice',
    (await panelCount(p)) === 1 && here() === '/compress/',
    (await panelCount(p)) + ' panel(s) at ' + here());

  await stayHere(p);
  await p.waitForTimeout(500);
  await p.evaluate(function () {
    var a = document.querySelector('.tab-bar a[href="../questlist/"]');
    a.click(); a.click();       // a stutter, or a double tap
  });
  await p.waitForTimeout(400);

  // A refused second question must not leave the guard thinking a panel
  // is still up: the next tap has to be asked about as well, or the page
  // quietly stops guarding itself.
  await stayHere(p);
  await p.waitForTimeout(500);
  await p.click('.tab-bar a[href="../questlist/"]');
  await p.waitForTimeout(400);
  check('the tap after that is still asked about',
    (await panelCount(p)) === 1 && here() === '/compress/',
    (await panelCount(p)) + ' panel(s) at ' + here());
  await stayHere(p);
  await p.waitForTimeout(500);

  // ---- the mid-scroll jab, which is what this is for ----
  var jab = await jabTabBar(p, '../');
  await p.waitForTimeout(400);
  var jabbed = await panelNow(p);
  check('running: a tab-bar tap made mid-scroll is caught before the bar can navigate',
    !!jabbed && here() === '/compress/' && jabbed.title === 'Leave this page?',
    JSON.stringify(jab) + ' at ' + here());
  check('and it is the same panel, with the same reason on it',
    !!jabbed && jabbed.slide && jabbed.copy === (asked && asked.copy) &&
    JSON.stringify(jabbed.buttons) === JSON.stringify(['Stay here']),
    JSON.stringify(jabbed && jabbed.buttons));

  // ---- the far end, then the second panel ----
  await slideAcross(p);
  await p.waitForTimeout(300);
  var last = await panelNow(p);
  check('sliding to the far end and letting go there opens the last check',
    !!last && !last.slide && last.title === 'Last check' &&
    JSON.stringify(last.buttons) === JSON.stringify(['Stay here', 'Leave the page']),
    JSON.stringify(last && last.buttons));
  check('the last check says the same thing and what leaving does',
    !!last && last.copy === 'A video is being compressed. Stopping it loses the work — the next run ' +
      'starts from the beginning, and the 31 MB engine downloads again if the browser has not kept it. ' +
      'Leaving this page stops it.',
    JSON.stringify(last && last.copy));

  // asked before the last step, because what follows lands on another
  // page and its errors are not this page's
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));

  // ---- and confirming goes ----
  await p.evaluate(function () {
    [].forEach.call(document.querySelectorAll('.confirm-actions button'), function (b) {
      if (b.textContent === 'Leave the page') b.click();
    });
  });
  await p.waitForTimeout(1500);
  check('Leave the page finally leaves it', here() === '/', here());

  await ctx.close();
}

// The threaded core cannot add a worker once ffmpeg is running, and a
// run told to use n threads starts 4n - 1 of them at once, so the pool
// compress.js caps its runs at has to cover that.
function poolCoversThreads() {
  var page = fs.readFileSync(path.join(SITE, 'compress', 'compress.js'), 'utf8');
  var core = fs.readFileSync(path.join(SITE, 'assets', 'ffmpeg-mt', 'ffmpeg-core.js'), 'utf8');
  var max = +((/var MAX_THREADS = (\d+);/.exec(page) || [])[1]);
  var pool = +((/var pthreadPoolSize=(\d+);/.exec(core) || [])[1]);
  check('the threaded engine has a worker for every thread a run can start',
    max > 0 && pool >= 4 * max - 1, 'MAX_THREADS ' + max + ', pthreadPoolSize ' + pool);
}

// ---- the browser's own codecs ----

function mp4Box(type, parts) {
  var body = Buffer.concat(parts);
  var head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8, 0);
  (Buffer.isBuffer(type) ? type : Buffer.from(type, 'latin1')).copy(head, 4);
  return Buffer.concat([head, body]);
}
function word(n) { var b = Buffer.alloc(4); b.writeUInt32BE(n); return b; }
// Apple's keyed metadata, as an iPhone writes it at the top of the moov
function keyedMeta(pairs) {
  return mp4Box('meta', [
    mp4Box('hdlr', [Buffer.alloc(8), Buffer.from('mdta'), Buffer.alloc(13)]),
    mp4Box('keys', [Buffer.alloc(4), word(pairs.length)].concat(pairs.map(function (kv) {
      return mp4Box('mdta', [Buffer.from(kv[0], 'utf8')]);
    }))),
    mp4Box('ilst', pairs.map(function (kv, i) {
      return mp4Box(word(i + 1), [mp4Box('data', [word(1), word(0), Buffer.from(kv[1], 'utf8')])]);
    }))
  ]);
}
// a QuickTime user-data string: its length, a language, then the text
function qtString(type, value) {
  var text = Buffer.from(value, 'utf8');
  var head = Buffer.alloc(4);
  head.writeUInt16BE(text.length, 0);
  head.writeUInt16BE(0x15c7, 2);
  return mp4Box(Buffer.from(type, 'latin1'), [head, text]);
}
// An ffmpeg clip, its moov last so nothing before it moves, with the
// boxes a phone writes in place of ffmpeg's own: an iPhone's keyed
// metadata, or Android's place in user data with its own keys beside it.
function asPhone(from, to, phone) {
  var buf = fs.readFileSync(from);
  var at = 0;
  var moov = -1;
  while (at + 8 <= buf.length) {
    if (buf.toString('latin1', at + 4, at + 8) === 'moov') moov = at;
    at += buf.readUInt32BE(at);
  }
  if (moov < 0 || moov + buf.readUInt32BE(moov) !== buf.length) throw new Error('the moov is not last in ' + from);
  var kids = [];
  for (var i = moov + 8; i < buf.length; i += buf.readUInt32BE(i)) {
    var type = buf.toString('latin1', i + 4, i + 8);
    if (type !== 'udta' && type !== 'meta') kids.push(buf.subarray(i, i + buf.readUInt32BE(i)));
  }
  if (phone === 'iphone') {
    kids.push(keyedMeta([
      ['com.apple.quicktime.location.ISO6709', '-33.8688+151.2093+012.000/'],
      ['com.apple.quicktime.make', 'Apple'],
      ['com.apple.quicktime.model', 'iPhone 15 Pro'],
      ['com.apple.quicktime.software', '18.1'],
      ['com.apple.quicktime.creationdate', '2026-10-24T12:02:03+1100']
    ]));
  } else {
    kids.push(mp4Box('udta', [qtString('©xyz', '-33.8688+151.2093/'),
      qtString('©mak', 'Google'), qtString('©mod', 'Pixel 9')]));
    kids.push(keyedMeta([['com.android.version', '15'], ['com.android.capture.fps', '30.000000']]));
  }
  fs.writeFileSync(to, Buffer.concat([buf.subarray(0, moov), mp4Box('moov', kids)]));
  return to;
}

function streams(file) {
  var got = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_type,codec_name,width,height,nb_frames:stream_side_data=rotation', '-of', 'json', file]).toString());
  var out = {};
  got.streams.forEach(function (s) { out[s.codec_type] = s; });
  if (out.video) out.video.rotation = ((out.video.side_data_list || [])[0] || {}).rotation || 0;
  return out;
}
// the audio's packets, hashed: equal only when they went across as they were
function audioHash(file) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-map', '0:a', '-c', 'copy', '-f', 'md5', '-']).toString().trim();
}
// what the worker's video reader takes from a file
async function readBack(reader, file) {
  var buf = fs.readFileSync(file);
  var bucket = {
    get: async function (key, opts) {
      var r = opts && opts.range;
      var start = r ? r.offset : 0;
      var part = buf.subarray(start, r ? Math.min(buf.length, start + r.length) : buf.length);
      return { size: buf.length, arrayBuffer: async function () { return part.buffer.slice(part.byteOffset, part.byteOffset + part.length); } };
    }
  };
  var block = await reader.videoBlock(bucket, 'k');
  return JSON.stringify({ taken: await reader.videoTakenAt(bucket, 'k'), block: block ? Buffer.from(block).toString() : null });
}

async function ownCodecs(b) {
  console.log('\n/compress/  the browser\'s own codecs');
  var dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'scs-verify-compress-'));
  var clip = function (name) { return path.join(dir, name); };
  try {
    var make = function (args) { execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y'].concat(args), { stdio: 'ignore' }); };
    var src = ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2'];
    var avc = ['-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac'];
    var when = ['-metadata', 'creation_time=2026-10-24T01:02:03Z'];
    make(src.concat(avc, [clip('flat.mov')]));
    // a phone films landscape and writes a quarter turn into the track
    make(['-display_rotation:v:0', '-90', '-i', clip('flat.mov'), '-c', 'copy'].concat(when, [clip('turned.mov')]));
    make(src.concat(avc, when, [clip('plain.mp4')]));
    make(src.concat(['-c:v', 'libx265', '-preset', 'ultrafast', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clip('hevc.mov')]));
  } catch (e) {
    console.log('  skipped: no ffmpeg and ffprobe to make the clips with (' + e.message.split('\n')[0] + ')');
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  var reader = await import(pathToFileURL(path.join(ROOT, 'tab', 'src', 'videostrip.ts')).href);
  var phones = [
    { label: 'an iPhone-style MOV', file: asPhone(clip('turned.mov'), clip('iphone.mov'), 'iphone') },
    { label: 'an Android-style MP4', file: asPhone(clip('plain.mp4'), clip('android.mp4'), 'android') }
  ];

  var open = async function () {
    var ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    var p = await ctx.newPage();
    await p.route('**://files.scs.andyrew.space/**', function (route) {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    var errs = [];
    p.on('pageerror', function (e) { errs.push(e.message); });
    await openView(p);
    return { ctx: ctx, p: p, errs: errs };
  };
  var runTo = async function (p, file, edge) {
    await p.setInputFiles('#cp-file', file);
    await p.waitForFunction(function () {
      return document.querySelectorAll('#cp-scales .cp-size').length > 0;
    }, null, { timeout: 20000 });
    if (edge) await p.click('#cp-scales .cp-size[data-edge="' + edge + '"]');
    await p.click('#cp-run');
    await p.waitForFunction(function () {
      return /done|failed/.test(document.getElementById('cp-tool').getAttribute('data-stage'));
    }, null, { timeout: 60000 });
    return p.evaluate(function () {
      return { stage: document.getElementById('cp-tool').getAttribute('data-stage'), status: document.getElementById('cp-status').textContent };
    });
  };

  for (var phone of phones) {
    var s = await open();
    // the engine must not be needed: one that is asked for says so and fails
    await s.p.evaluate(function () {
      window.FFmpegWASM = {
        FFmpeg: function () {
          window.__ffAsked = true;
          this.on = function () {};
          this.load = function () { return Promise.reject(new Error('the engine was asked for')); };
        }
      };
    });
    var end = await runTo(s.p, phone.file, 720);
    var out = clip(path.basename(phone.file) + '-small.mp4');
    var asked = await s.p.evaluate(function () { return !!window.__ffAsked; });
    if (end.stage === 'done') {
      var bytes = await s.p.evaluate(async function () {
        var buf = await fetch(document.getElementById('cp-preview').src).then(function (r) { return r.arrayBuffer(); });
        var u8 = new Uint8Array(buf);
        var bin = '';
        for (var i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
        return btoa(bin);
      });
      fs.writeFileSync(out, Buffer.from(bytes, 'base64'));
    }
    var made = end.stage === 'done' && !asked;
    var a = streams(phone.file);
    var o = made ? streams(out) : {};
    check(phone.label + ' goes through the browser\'s own codecs: H.264 at 720p, every frame, turned as it was, its AAC untouched',
      made && s.errs.length === 0 && o.video && o.video.codec_name === 'h264' &&
      o.video.width === 1280 && o.video.height === 720 && o.video.nb_frames === a.video.nb_frames &&
      o.video.rotation === a.video.rotation && o.audio && audioHash(out) === audioHash(phone.file),
      made ? JSON.stringify({ video: o.video, audio: o.audio && o.audio.nb_frames }) : JSON.stringify(end) + (asked ? ' (went to the engine)' : '') + ' ' + s.errs.join(' | '));
    var was = await readBack(reader, phone.file);
    var now = made ? await readBack(reader, out) : '';
    check(phone.label + ': the worker reads the same time, place and phone from the result as from the source',
      made && now === was && /GPSLatitude=\W+-33\.8688/.test(was) && /2026-10-24 01:02:03/.test(was),
      now === was ? '' : now + ' vs ' + was);
    await s.ctx.close();
  }

  // This Chromium cannot decode HEVC, or play it, so the video element's
  // reading is answered as the other states answer it.
  var h = await open();
  await stubEngine(h.p);
  var hend = await runTo(h.p, clip('hevc.mov'), 0);
  var ran = await h.p.evaluate(function () {
    return (window.__ffRuns || []).some(function (args) { return args.indexOf('libx264') !== -1; });
  });
  check('an HEVC clip this browser cannot decode goes to the engine and finishes',
    hend.stage === 'done' && ran && h.errs.length === 0, JSON.stringify(hend) + ' ' + h.errs.join(' | '));
  await h.ctx.close();

  // The same clip through the real engine, on a page served with the
  // headers netlify.toml gives it.
  var served = await isolatedServer();
  var t = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  var tp = await t.newPage();
  await tp.route('**://files.scs.andyrew.space/**', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: '{}' });
  });
  var terrs = [];
  var fellBack = [];
  var asked = [];
  tp.on('pageerror', function (e) { terrs.push(e.message); });
  tp.on('console', function (m) { if (/did not load/.test(m.text())) fellBack.push(m.text()); });
  tp.on('request', function (r) { if (/\/assets\/ffmpeg(-mt)?\/ffmpeg-core\.wasm$/.test(r.url())) asked.push(r.url().replace(served.base, '')); });
  await openView(tp, served.base);
  var isolated = await tp.evaluate(function () { return window.crossOriginIsolated; });
  // this browser cannot read the clip, so it offers no picture sizes
  await tp.setInputFiles('#cp-file', clip('hevc.mov'));
  await tp.waitForFunction(function () {
    return document.getElementById('cp-tool').getAttribute('data-stage') === 'ready';
  }, null, { timeout: 20000 });
  await tp.click('#cp-run');
  await tp.waitForFunction(function () {
    return /done|failed/.test(document.getElementById('cp-tool').getAttribute('data-stage'));
  }, null, { timeout: 120000 });
  var tend = await tp.evaluate(function () {
    return { stage: document.getElementById('cp-tool').getAttribute('data-stage'), status: document.getElementById('cp-status').textContent };
  });
  check('isolated by its headers, the page runs the multi-threaded engine',
    isolated && tend.stage === 'done' && asked.join() === '/assets/ffmpeg-mt/ffmpeg-core.wasm' &&
    fellBack.length === 0 && terrs.length === 0,
    JSON.stringify({ isolated: isolated, end: tend, asked: asked, fellBack: fellBack, errs: terrs }));
  await t.close();
  served.server.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// website/ served with the headers netlify.toml gives each path, read
// from the file itself, on a port of its own.
function isolatedServer() {
  var text = fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8');
  var rules = [];
  text.split('[[headers]]').slice(1).forEach(function (block) {
    var m = /for\s*=\s*"([^"]+)"/.exec(block);
    if (!m) return;
    var values = {};
    (block.split('[headers.values]')[1] || '').split('\n').forEach(function (line) {
      var kv = /^\s*([A-Za-z-]+)\s*=\s*"([^"]*)"/.exec(line);
      if (kv) values[kv[1].toLowerCase()] = kv[2];
    });
    rules.push({ re: new RegExp('^' + m[1].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$'), values: values });
  });
  var types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json',
    '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };
  var server = http.createServer(function (req, res) {
    var urlPath = decodeURIComponent(req.url.split('?')[0]);
    var f = path.join(SITE, urlPath.endsWith('/') ? urlPath + 'index.html' : urlPath);
    if (f.indexOf(SITE) !== 0 || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
    var h = { 'content-type': types[path.extname(f)] || 'application/octet-stream' };
    rules.forEach(function (r) { if (r.re.test(urlPath)) Object.assign(h, r.values); });
    delete h['cache-control'];
    res.writeHead(200, h);
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(function (done) {
    server.listen(0, '127.0.0.1', function () { done({ server: server, base: 'http://127.0.0.1:' + server.address().port }); });
  });
}

// The same audit verify-redesign.cjs runs, applied to a state rather
// than to a page: nothing off the side, no text over or hard against
// other text, nothing too small to read, nothing the ground behind it
// swallows.
async function audit(p, label, width) {
  // Read from the top of the page.
  await p.evaluate(function () { document.body.scrollTop = 0; });
  await p.waitForTimeout(150);
  var d = await p.evaluate(function (chrome) {
    var W = document.documentElement.clientWidth;
    var main = document.querySelector('main') || document.body;
    var all = [].slice.call(main.querySelectorAll('*')).filter(function (el) {
      for (var i = 0; i < chrome.length; i++) if (el.closest(chrome[i])) return false;
      return true;
    });
    var shown = function (el) {
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0';
    };
    var name = function (el) {
      return el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
        (el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    };
    var overflow = all.filter(function (el) {
      if (!shown(el)) return false;
      var r = el.getBoundingClientRect();
      return r.right > W + 1 || r.left < -1;
    }).map(name);

    var leaves = all.filter(function (el) {
      if (!shown(el)) return false;
      if (!el.textContent || !el.textContent.trim()) return false;
      for (var i = 0; i < el.children.length; i++) {
        if (el.children[i].textContent && el.children[i].textContent.trim()) return false;
      }
      return true;
    });
    var over = [], touch = [];
    for (var i = 0; i < leaves.length; i++) {
      for (var j = i + 1; j < leaves.length; j++) {
        var a = leaves[i], c = leaves[j];
        if (a.contains(c) || c.contains(a)) continue;
        var la = [].slice.call(a.getClientRects());
        var lc = [].slice.call(c.getClientRects());
        var hit = false;
        for (var m = 0; m < la.length && !hit; m++) {
          for (var n = 0; n < lc.length && !hit; n++) {
            var ox = Math.min(la[m].right, lc[n].right) - Math.max(la[m].left, lc[n].left);
            var oy = Math.min(la[m].bottom, lc[n].bottom) - Math.max(la[m].top, lc[n].top);
            if (ox > 1 && oy > 1) { over.push(name(a) + ' / ' + name(c)); hit = true; }
          }
        }
      }
    }
    var textBox = function (el) {
      var rg = document.createRange();
      rg.selectNodeContents(el);
      var rs = [].slice.call(rg.getClientRects()).filter(function (r) { return r.width > 0; });
      rg.detach && rg.detach();
      return rs;
    };
    var cells = leaves.filter(function (el) {
      var disp = getComputedStyle(el).display;
      return disp !== 'inline' && disp !== 'contents';
    });
    for (var i2 = 0; i2 < cells.length; i2++) {
      for (var j2 = i2 + 1; j2 < cells.length; j2++) {
        var a2 = cells[i2], c2 = cells[j2];
        if (a2.contains(c2) || c2.contains(a2)) continue;
        if (a2.parentElement !== c2.parentElement) continue;
        var ta = textBox(a2), tc = textBox(c2);
        for (var m2 = 0; m2 < ta.length; m2++) {
          for (var n2 = 0; n2 < tc.length; n2++) {
            var oy2 = Math.min(ta[m2].bottom, tc[n2].bottom) - Math.max(ta[m2].top, tc[n2].top);
            var gap = ta[m2].left < tc[n2].left ? tc[n2].left - ta[m2].right : ta[m2].left - tc[n2].right;
            if (oy2 > 4 && gap > -0.5 && gap <= 0.5) touch.push(name(a2) + ' / ' + name(c2));
          }
        }
      }
    }
    var tiny = all.filter(function (el) {
      if (!shown(el)) return false;
      if (!el.textContent || !el.textContent.trim()) return false;
      return parseFloat(getComputedStyle(el).fontSize) < 10.5;
    }).map(function (el) { return name(el) + ' ' + getComputedStyle(el).fontSize; });

    var chan = function (s) { var m = String(s).match(/[\d.]+/g); return m ? m.map(Number) : null; };
    var lum = function (c) {
      var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    var ground = function (el) {
      var n = el;
      while (n && n !== document.documentElement) {
        var bg = chan(getComputedStyle(n).backgroundColor);
        if (bg && (bg.length < 4 || bg[3] > 0.5)) return bg;
        n = n.parentElement;
      }
      return [255, 255, 255];
    };
    var invisible = leaves.filter(function (el) {
      var fg = chan(getComputedStyle(el).color);
      if (!fg) return false;
      if (fg.length > 3 && fg[3] < 0.1) return true;
      var bg = ground(el);
      var l1 = lum(fg), l2 = lum(bg);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05) < 1.6;
    }).map(name);

    var dedup = function (a) { var s = {}; return a.filter(function (x) { if (s[x]) return false; s[x] = 1; return true; }); };
    return {
      overflow: dedup(overflow), over: dedup(over), touch: dedup(touch),
      tiny: dedup(tiny), invisible: dedup(invisible),
      docW: document.documentElement.scrollWidth
    };
  }, CHROME);

  check(label + ': nothing runs off the page',
    d.overflow.length === 0 && d.docW <= width + 1, d.overflow.slice(0, 3).join(' | '));
  check(label + ': no text over or hard against other text',
    d.over.length === 0 && d.touch.length === 0, d.over.concat(d.touch).slice(0, 3).join(' | '));
  check(label + ': nothing set below 10.5px', d.tiny.length === 0, d.tiny.slice(0, 3).join(' | '));
  check(label + ': no text its own ground swallows', d.invisible.length === 0, d.invisible.slice(0, 3).join(' | '));
}
