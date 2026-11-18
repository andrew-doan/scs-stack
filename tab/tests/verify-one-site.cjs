// Do the redesigned pages still look like one site?
//
//   node tests/verify-one-site.cjs
//
// verify-redesign.cjs asks whether a page is drawn correctly. This asks
// a different question: whether the pages agree with each other. They
// were redesigned one at a time, from one design language but by
// different hands, and the failure that produces is not a broken page —
// it is eight pages that are each fine and that are visibly not the
// same site.
//
// It reports rather than passing or failing most of what it measures,
// because pages legitimately differ: the tab is a table and welfare is
// a sign, and they are not supposed to have the same shape. What it
// fails on is the small number of things that are the system rather
// than the page:
//
//   - the type ladder. site.css has six stops (--t-display, --t-head,
//     --t-lede, --t-body, --t-small, --t-micro) and the studies' whole
//     argument was that a page uses a handful of sizes that each mean
//     something. A page carrying a dozen sizes has stopped using the
//     ladder and is setting type by eye.
//   - the label voice. Uppercase 0.72rem muted is the site's label, and
//     it is in the hard rules. A page that invents a second label
//     treatment has two voices for one job.
//   - the section heading. h2.section-heading is one size under one
//     rule, and it is also in the hard rules. A page with headings that
//     are not that has left the system.
//   - square corners. 2px, and round is reserved for .bullet route
//     discs. Anything else round is a fault wherever it appears.
//   - the face. Every word is Helvetica Neue or, on a device without
//     it, the stand-in the site serves (SCS Heros), and nothing falls
//     past them to Arial or Roboto. This browser has no Helvetica, as a
//     Windows or Android phone has none, so a stack that leaves the
//     stand-in out or a font file that has gone shows here, when on a
//     Mac it would look right.
//
// The rest is printed so two pages can be read against each other.
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

var SITE = path.join(__dirname, '..', '..', 'website');
var BASE = 'http://127.0.0.1:8123';

// Kept in step with verify-redesign.cjs by hand: a page belongs here
// once it is across.
var PAGES = ['/', '/info/', '/welfare/', '/tab/', '/tab/team/', '/tab/replay/', '/recap/', '/recap/quest/', '/messages/', '/gallery/', '/albums/', '/questlist/', '/plan/',
  '/questlist/full/', '/submit/', '/compress/', '/terms/'];

var CHROME = ['.site-nav', '.site-footer', '.tab-bar',
  '.settings-panel', '.toast-stack', '.app-splash', '.ptr', '.urgent-wrap'];

// How many distinct type sizes a page may carry before it has stopped
// using the ladder. Six stops, plus room for a page's own display
// figure and a couple of deliberate exceptions.
var SIZE_CAP = 9;

(async () => {
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
  var ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
  var p = await ctx.newPage();
  await p.route('**://files.scs.andyrew.space/**', function (route) {
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });

  var cdp = await ctx.newCDPSession(p);
  var rows = [];
  for (var i = 0; i < PAGES.length; i++) {
    await p.goto(BASE + PAGES[i], { waitUntil: 'load' });
    await p.waitForTimeout(400);
    var d = await p.evaluate(read, CHROME);
    d.page = PAGES[i];
    d.faces = await facesUsed(cdp, p);
    rows.push(d);
  }

  var say = function (ok, label, detail) {
    if (!ok) fail++;
    console.log((ok ? '  ok   ' : '  FAIL ') + label + (detail ? '  ' + detail : ''));
  };

  for (var j = 0; j < rows.length; j++) {
    var r = rows[j];
    console.log('\n' + r.page);
    say(r.sizes.length <= SIZE_CAP, 'the page stays on the type ladder',
      r.sizes.length + ' sizes: ' + r.sizes.join(', '));
    say(r.labelVoices.length <= 1, 'one label voice', r.labelVoices.join(' | '));
    say(r.oddHeadings.length === 0, 'section headings are the site\'s',
      r.oddHeadings.slice(0, 3).join(' | '));
    say(r.round.length === 0, 'round is only on route discs', r.round.slice(0, 3).join(' | '));
    var faces = Object.keys(r.faces);
    var stray = faces.filter(function (f) { return !/^(Helvetica Neue|SCS Heros)$|Mono|Emoji/.test(f); });
    say(stray.length === 0 && (r.faces['SCS Heros'] > 0 || r.faces['Helvetica Neue'] > 0),
      'every word is in Helvetica Neue or its stand-in', faces.map(function (f) { return f + ' ' + r.faces[f]; }).join(', '));
    // A page with no running prose — the tab is a table — has no
    // measure, which is not the same as a measure of nought.
    console.log('  --   body ' + (r.body || '—') +
      '  measure ' + (r.measure ? r.measure + 'ch' : '— (no running prose)') +
      '  gutter ' + r.gutter);
  }

  // Read the pages against each other. Printed, not failed: a table and
  // a sign are not supposed to have the same shape.
  console.log('\nacross the pages');
  var all = {};
  rows.forEach(function (r) { r.sizes.forEach(function (s) { all[s] = (all[s] || 0) + 1; }); });
  var shared = Object.keys(all).map(Number).sort(function (a, c) { return c - a; });
  console.log('  sizes, and how many pages use each:');
  shared.forEach(function (s) { console.log('    ' + s + 'px  on ' + all[s] + ' of ' + rows.length); });
  console.log('  body size per page:   ' + rows.map(function (r) { return r.page + ' ' + (r.body || '—'); }).join(' | '));
  console.log('  measure per page:     ' + rows.map(function (r) {
    return r.page + ' ' + (r.measure ? r.measure + 'ch' : '—');
  }).join(' | '));

  // A selector list that holds :has() or :focus-visible is dropped whole
  // by Safari before 15.4, taking the other selectors' styles with it:
  // each of those goes in a rule of its own. Read off every stylesheet
  // and <style> block, so it needs no page to be open.
  var listed = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (d) {
      var f = path.join(dir, d.name);
      if (d.isDirectory()) { if (!/^(tests|maplibre|pdfjs|ffmpeg|heic)$/.test(d.name)) walk(f); return; }
      if (!/\.(css|html)$/.test(d.name)) return;
      var text = fs.readFileSync(f, 'utf8');
      if (/\.html$/.test(d.name)) text = (text.match(/<style[^>]*>[\s\S]*?<\/style>/g) || []).join('\n');
      text = text.replace(/\/\*[\s\S]*?\*\//g, '');
      var re = /([^{}]+)\{/g, m;
      while ((m = re.exec(text))) {
        var sel = m[1].trim();
        if (sel.charAt(0) === '@') continue;
        var parts = sel.split(/,(?![^()]*\))/);
        var newer = parts.filter(function (x) { return /:has\(|:focus-visible/.test(x); }).length;
        if (newer && newer < parts.length) {
          listed.push(path.relative(SITE, f) + ': ' + sel.replace(/\s+/g, ' ').slice(0, 90));
        }
      }
    });
  })(SITE);
  console.log('\nacross the stylesheets');
  say(listed.length === 0, 'no selector list holds :has() or :focus-visible beside other selectors', listed.slice(0, 5).join(' | '));

  console.log(fail === 0 ? '\nALL CHECKS PASSED' : '\n' + fail + ' CHECK(S) FAILED');
  if (server) server.kill();
  await b.close();
  process.exit(fail ? 1 : 0);
})();

// The faces the page's text is actually drawn in, glyphs per face, as
// the browser reports them. Only elements holding text of their own are
// asked, which is what keeps it to a second a page.
async function facesUsed(cdp, p) {
  await p.evaluate(function () {
    [].slice.call(document.body.querySelectorAll('*')).forEach(function (el) {
      var own = [].slice.call(el.childNodes).some(function (n) { return n.nodeType === 3 && n.textContent.trim(); });
      if (own) el.setAttribute('data-face-probe', '');
    });
  });
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  var doc = await cdp.send('DOM.getDocument', { depth: 1 });
  var found = await cdp.send('DOM.querySelectorAll', { nodeId: doc.root.nodeId, selector: '[data-face-probe]' });
  var faces = {};
  for (var i = 0; i < found.nodeIds.length; i++) {
    var got;
    try { got = await cdp.send('CSS.getPlatformFontsForNode', { nodeId: found.nodeIds[i] }); } catch (e) { continue; }
    got.fonts.forEach(function (f) { faces[f.familyName] = (faces[f.familyName] || 0) + f.glyphCount; });
  }
  return faces;
}

function read(chrome) {
  var main = document.querySelector('main') || document.body;
  var all = [].slice.call(main.querySelectorAll('*')).filter(function (el) {
    for (var i = 0; i < chrome.length; i++) if (el.closest(chrome[i])) return false;
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden';
  });
  var withText = all.filter(function (el) {
    if (!el.textContent || !el.textContent.trim()) return false;
    for (var i = 0; i < el.children.length; i++) {
      if (el.children[i].textContent && el.children[i].textContent.trim()) return false;
    }
    return true;
  });
  var name = function (el) {
    return el.tagName.toLowerCase() +
      (el.className && typeof el.className === 'string'
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : '');
  };

  // --- every distinct type size the page's own words are set in
  var sizes = {};
  withText.forEach(function (el) {
    var s = Math.round(parseFloat(getComputedStyle(el).fontSize) * 2) / 2;
    sizes[s] = 1;
  });

  // --- the label voice: uppercase, small, muted. A page should have
  // one of these, not two.
  var voices = {};
  withText.forEach(function (el) {
    var cs = getComputedStyle(el);
    if (cs.textTransform !== 'uppercase') return;
    var s = Math.round(parseFloat(cs.fontSize) * 2) / 2;
    if (s > 15) return;                       // a heading that happens to be caps
    // A quest code set in the code face is a code, not a label. It is
    // uppercase because its content is, and text-transform inherits, so
    // a mono code inside a label looked like a second label voice.
    if (cs.fontFamily.indexOf('Roboto Mono') !== -1 ||
        cs.fontFamily.indexOf('ui-monospace') !== -1 ||
        cs.fontFamily.indexOf('monospace') !== -1) return;
    voices[s + 'px/' + cs.fontWeight + '/' + cs.letterSpacing] = 1;
  });

  // --- a section heading that is not the site's
  var odd = [];
  [].slice.call(main.querySelectorAll('h2')).forEach(function (el) {
    for (var i = 0; i < chrome.length; i++) if (el.closest(chrome[i])) return;
    if (!el.classList.contains('section-heading')) odd.push(name(el));
  });

  // --- round corners outside the route discs
  var round = [];
  all.forEach(function (el) {
    if (el.closest('.bullet') || el.classList.contains('bullet')) return;
    var cs = getComputedStyle(el);
    var r = parseFloat(cs.borderTopLeftRadius);
    if (!r) return;
    // a percentage radius on a square box is a disc; anything over the
    // system's 2px is the fault
    if (cs.borderTopLeftRadius.indexOf('%') !== -1 || r > 2.5) {
      // inputs and the browser's own controls carry their own radii
      if (/^(input|select|textarea|progress|video|img|svg|circle|rect|path)$/.test(el.tagName.toLowerCase())) return;
      round.push(name(el) + ' ' + cs.borderTopLeftRadius);
    }
  });

  // --- the reading measure, in characters.
  //
  // Measured from the text's own line boxes, not the paragraph's box,
  // and only from paragraphs that actually wrap. A centred one-line
  // sign-off in a full-width box is not a measure problem — the first
  // pass at this took the widest box and reported 148 characters for a
  // page whose reading column is 68.
  var ch = 0, body = 0;
  var blocky = function (el) {
    for (var i = 0; i < el.children.length; i++) {
      var dk = getComputedStyle(el.children[i]).display;
      if (dk === 'block' || dk === 'flex' || dk === 'grid' || dk === 'list-item') return true;
    }
    return false;
  };
  var ps = [].slice.call(main.querySelectorAll('p, li, dd')).filter(function (el) {
    for (var i = 0; i < chrome.length; i++) if (el.closest(chrome[i])) return false;
    if (el.textContent.trim().length <= 80) return false;
    // A sign bar is signage, not prose: it is deliberately as wide as
    // the board and it is read in one or two lines, so it has no
    // measure to compare. It is also a shared component, so its width
    // is the same on every page that uses it and says nothing about
    // this one.
    if (el.closest('.sign-bar, .hero-board')) return false;
    // A Range over an element holding a block-level child returns that
    // child's whole border box as one rect, so a centred sign-off with a
    // block <span> under it reported a 148-character measure on a page
    // whose reading column is 68. Only a single run of prose has a
    // measure.
    return !blocky(el);
  });
  var best = 0, bestEl = null;
  ps.forEach(function (el) {
    var rg = document.createRange();
    rg.selectNodeContents(el);
    var lines = [].slice.call(rg.getClientRects()).filter(function (r) { return r.width > 1; });
    if (lines.length < 2) return;          // it does not wrap, so it has no measure
    // the longest line, ignoring the last one, which is a rag
    var w = 0;
    for (var i = 0; i < lines.length - 1; i++) w = Math.max(w, lines[i].width);
    if (w > best) { best = w; bestEl = el; }
  });
  if (bestEl) {
    var cs2 = getComputedStyle(bestEl);
    body = Math.round(parseFloat(cs2.fontSize) * 10) / 10;
    // 0.5em is the usual average character width in a Helvetica text face
    ch = Math.round(best / (parseFloat(cs2.fontSize) * 0.5));
  }

  var gutter = getComputedStyle(document.documentElement).getPropertyValue('--gutter').trim();

  return {
    sizes: Object.keys(sizes).map(Number).sort(function (a, c) { return c - a; }),
    labelVoices: Object.keys(voices),
    oddHeadings: odd,
    round: [...new Set(round)],
    measure: ch,
    body: body,
    gutter: gutter
  };
}
