// Check a redesigned page for the faults that read as a rendering
// failure rather than a design choice.
//
//   node tests/verify-redesign.cjs              every page that is across
//   node tests/verify-redesign.cjs /welfare/    one
//
// Two things it does on purpose:
//
//   - It looks at the page's own content only. The studies draw their
//     own chrome; the real site has the shared nav, footer, tab bar,
//     settings menu and floating button on every page, and those carry
//     their own edges, their own hidden elements and their own type
//     sizes. Auditing them once per page says nothing about the page.
//   - It runs each page four ways: 1280 and 390, light and dark. A
//     study is one drawing at one width. A real page has to hold up at
//     both ends of both, and dark mode is where a colour written as a
//     literal rather than as a token shows up.
//
// PAGES is the list of pages that have been moved onto the study
// designs. Add a page to it when it lands.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

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

// The ticket page draws nothing without a ticket in the link, so it is
// listed twice. The blob is built the way rego.js builds a real one —
// the version byte, the token's length, the token's raw bytes, then the
// name and the team — and the bare address is the page's first error
// state, which is now drawn like every other state on it.
var TICKET = 'AhALMFV6n8TpDjNYfaLH7BE2UHJpeWEgUmFnaGF2YW4KUGxhdGZvcm0gTmluZQ';

// The submit page draws its sign-in card until a team session is in
// localStorage, so what this sees of it is its signed-out state.
var PAGES = ['/', '/info/', '/welfare/', '/tab/', '/tab/team/', '/tab/replay/', '/recap/', '/recap/quest/', '/messages/', '/gallery/', '/albums/', '/questlist/', '/plan/',
  '/questlist/full/', '/submit/', '/compress/', '/404.html', '/ticket/?' + TICKET, '/ticket/', '/terms/'];

// The chrome is shared and is not what this is checking. Anything
// inside one of these is skipped.
var CHROME = ['.site-nav', '.site-footer', '.tab-bar',
  '.settings-panel', '.toast-stack', '.app-splash', '.ptr', '.urgent-wrap'];

(async () => {
  var only = process.argv[2];
  var list = only ? [only] : PAGES;
  var fail = 0;

  var server = null;
  var up = await fetch(BASE + '/').then(function () { return true; }).catch(function () { return false; });
  if (!up) {
    server = spawn('python3', ['-m', 'http.server', '8123', '--directory', SITE], { stdio: 'ignore' });
    await new Promise(function (r) { setTimeout(r, 1200); });
  }

  var chromium = browser().chromium;
  var exe = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : null);
  var b = await chromium.launch(exe ? { executablePath: exe } : {});

  for (var i = 0; i < list.length; i++) {
    for (var w of [1280, 390]) {
      for (var theme of ['light', 'dark']) {
        var r = await run(b, list[i], w, theme);
        fail += r;
      }
    }
  }

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  if (server) server.kill();
  await b.close();
  process.exit(fail ? 1 : 0);
})();

async function run(b, url, width, theme) {
  var ctx = await b.newContext({
    viewport: { width: width, height: 900 },
    serviceWorkers: 'block'
  });
  var p = await ctx.newPage();

  // The suite runs with no network and the shared script polls the
  // tab worker on every page. Answering it here keeps a real failure
  // (a same-origin file that is not there) separate from the expected
  // one.
  await p.route('**://files.scs.andyrew.space/**', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  var errs = [];
  var missing = [];
  p.on('pageerror', function (e) { errs.push(e.message); });
  p.on('requestfailed', function (req) {
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

  await p.goto(BASE + url, { waitUntil: 'load' });
  await p.waitForTimeout(400);

  var d = await p.evaluate(function (chrome) {
    var W = document.documentElement.clientWidth;
    var main = document.querySelector('main') || document.body;
    var all = [].slice.call(main.querySelectorAll('*')).filter(function (el) {
      for (var i = 0; i < chrome.length; i++) if (el.closest(chrome[i])) return false;
      // A loading skeleton is a decorative layer stacked under the real
      // content by design, so its cells sit exactly over the real ones.
      // It is aria-hidden, which is the page saying it is not to be
      // read, and that is the right signal to skip it by.
      if (el.closest('[aria-hidden="true"]')) return false;
      return true;
    });
    var shown = function (el) {
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.opacity !== '0';
    };
    var name = function (el) {
      return el.tagName.toLowerCase() +
        (el.id ? '#' + el.id : '') +
        (el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    };

    // --- anything reaching past the page's own width
    var overflow = all.filter(function (el) {
      if (!shown(el)) return false;
      var r = el.getBoundingClientRect();
      return r.right > W + 1 || r.left < -1;
    }).map(name);

    // --- a margin or a text-align on a box that is still inline, where
    // the browser drops it and the words stay where the line put them
    var inlineMargin = all.filter(function (el) {
      var cs = getComputedStyle(el);
      if (cs.display !== 'inline') return false;
      return parseFloat(cs.marginTop) || parseFloat(cs.marginBottom);
    }).map(name);
    var inlineAlign = all.filter(function (el) {
      var cs = getComputedStyle(el);
      return cs.display === 'inline' && cs.textAlign !== 'start' &&
        cs.textAlign !== getComputedStyle(el.parentElement || document.body).textAlign;
    }).map(name);

    // --- two pieces of text drawn over each other, or touching with no
    // gap, which renders FILESSTATUS as one word
    var leaves = all.filter(function (el) {
      if (!shown(el)) return false;
      if (!el.textContent || !el.textContent.trim()) return false;
      for (var i = 0; i < el.children.length; i++) {
        if (el.children[i].textContent && el.children[i].textContent.trim()) return false;
      }
      return true;
    });
    // An inline box that wraps has one rect per line, and
    // getBoundingClientRect returns the union of them — a two-line
    // <strong> then "overlaps" everything else on either line. Compare
    // the line rects instead.
    var linesOf = function (el) { return [].slice.call(el.getClientRects()); };
    var over = [], touch = [];
    for (var i = 0; i < leaves.length; i++) {
      for (var j = i + 1; j < leaves.length; j++) {
        var a = leaves[i], c = leaves[j];
        if (a.contains(c) || c.contains(a)) continue;
        var la = linesOf(a), lc = linesOf(c);
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

    // Two cells whose words run together, which renders FILESSTATUS as
    // one word. Measure the text, not the box: a grid cell sized to its
    // track butts against the next cell by design, and the slack inside
    // the track is what keeps the words apart. A Range over the
    // element's contents gives where the text actually is.
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
            var gap = ta[m2].left < tc[n2].left
              ? tc[n2].left - ta[m2].right
              : ta[m2].left - tc[n2].right;
            if (oy2 > 4 && gap > -0.5 && gap <= 0.5) touch.push(name(a2) + ' / ' + name(c2));
          }
        }
      }
    }

    // --- type nobody can read
    var tiny = all.filter(function (el) {
      if (!shown(el)) return false;
      if (!el.textContent || !el.textContent.trim()) return false;
      return parseFloat(getComputedStyle(el).fontSize) < 10.5;
    }).map(function (el) { return name(el) + ' ' + getComputedStyle(el).fontSize; });

    // --- text the ground behind it swallows: a colour that only works
    // in one theme shows up here
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
      var ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      return ratio < 1.6;
    }).map(name);

    // --- the page paints its own ground rather than borrowing one
    var bodyBg = getComputedStyle(document.body).backgroundColor;

    // --- the page's own left edges. Four or fewer, each with one job.
    // Measured from the element's layout edge, which means adding back
    // a negative left margin. Display type is pulled left by a few
    // pixels on purpose so that its first glyph optically lines up with
    // the body text under it — the home page's date carries
    // margin-left: -3.05px at 55px — and the painted edge then sits
    // just off the page margin, which is exactly the shape this check
    // is looking for. The two are meant to look aligned, and the pull
    // is what makes them.
    var edges = {};
    leaves.forEach(function (el) {
      var r = el.getBoundingClientRect();
      if (r.width < 8) return;
      var pull = 0;
      for (var n = el; n && n !== document.body; n = n.parentElement) {
        var ml = parseFloat(getComputedStyle(n).marginLeft);
        if (ml < 0) pull += ml;
      }
      var x = Math.round(r.left - pull);
      edges[x] = (edges[x] || 0) + 1;
    });
    var main2 = Object.keys(edges).map(Number).filter(function (x) { return edges[x] >= 3; }).sort(function (a, c) { return a - c; });
    var near = [];
    for (var k = 1; k < main2.length; k++) {
      if (main2[k] - main2[k - 1] <= 3) near.push(main2[k - 1] + '/' + main2[k]);
    }

    return {
      overflow: dedup(overflow), inlineMargin: dedup(inlineMargin), inlineAlign: dedup(inlineAlign),
      over: dedup(over), touch: dedup(touch), tiny: dedup(tiny), invisible: dedup(invisible),
      edges: main2, near: near, bodyBg: bodyBg,
      docW: document.documentElement.scrollWidth
    };

    function dedup(a) { var s = {}; return a.filter(function (x) { if (s[x]) return false; s[x] = 1; return true; }); }
  }, CHROME);

  var fail = 0;
  var say = function (ok, label, detail) {
    if (!ok) fail++;
    console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail ? '  ' + detail : ''));
  };
  console.log('\n' + url + '  ' + width + 'px  ' + theme);
  say(d.docW <= width + 1, 'the page is no wider than the window', d.docW + ' vs ' + width);
  say(d.overflow.length === 0, 'nothing runs off the page', d.overflow.slice(0, 3).join(' | '));
  say(d.inlineMargin.length === 0, 'no margin on an inline box', d.inlineMargin.slice(0, 3).join(' | '));
  say(d.inlineAlign.length === 0, 'no text-align on an inline box', d.inlineAlign.slice(0, 3).join(' | '));
  say(d.over.length === 0, 'no text drawn over other text', d.over.slice(0, 3).join(' | '));
  say(d.touch.length === 0, 'no two words running together', d.touch.slice(0, 3).join(' , '));
  say(d.tiny.length === 0, 'nothing set below 10.5px', d.tiny.slice(0, 3).join(' | '));
  say(d.invisible.length === 0, 'no text its own ground swallows', d.invisible.slice(0, 3).join(' | '));
  say(d.bodyBg !== 'rgba(0, 0, 0, 0)', 'the page paints its own ground', d.bodyBg);
  // The edges are printed rather than capped. "Four left edges" is a
  // rule about one column, and a two-column page has every edge twice
  // by design — the count alone cannot tell the two apart. Two edges
  // within 3px is the fault worth failing on: that reads as a
  // misalignment rather than as a second column.
  console.log('  --   left edges  ' + d.edges.join(', '));
  say(d.near.length === 0, 'no two edges within 3px of each other', d.near.join(' | '));
  say(errs.length === 0, 'no page errors', errs.slice(0, 2).join(' | '));
  say(missing.length === 0, 'every same-origin request answered', missing.slice(0, 3).join(' | '));

  await ctx.close();
  return fail;
}
