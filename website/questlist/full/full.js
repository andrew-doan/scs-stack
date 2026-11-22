/* Everything a quest says beyond its row: the description, the flavour
   line, the code table and whatever is hung on it.

   Two pages draw it. This page lays every quest out on its own, one
   after another. The quest list next door expands the same block under
   a row when "Full quest information" is on — so the pieces live here
   once and both pages call them, rather than the list growing a second
   renderer that drifts from this one.

   `window.scsFullQuest` is the shared part: `details(group)` returns
   the block, `points(group)` the headline figure. The page below it
   only runs where #fl-list exists. #KEY scrolls to that quest. */
(function () {
  'use strict';

  var scs = window.scs;

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function questFileUrl(key) {
    return scs.TAB_API + '/api/quests/file?key=' + encodeURIComponent(key);
  }

  function isLive(g) {
    return !!(g.ask && g.ask.kind && g.ask.open);
  }

  function pointsText(g) {
    var codes = g.codes || [];
    if (!codes.length) return '';
    if (g.mystery) return '??? pts';
    if (codes.length === 1) {
      var lead = codes[0];
      var per = lead.scoring === 'unit' || (lead.label || '').indexOf('Per ') === 0;
      if (lead.scoring === 'tiered' || lead.scoring === 'counted') return 'up to ' + lead.points + ' pts';
      if (lead.scoring === 'judged') return 'up to ' + lead.points + ' pts';
      return lead.points + (per ? ' pts each' : ' pts');
    }
    var lo = null;
    var hi = null;
    codes.forEach(function (c) {
      if (lo === null || c.points < lo) lo = c.points;
      if (hi === null || c.points > hi) hi = c.points;
    });
    return lo === hi ? lo + ' pts per code' : lo + '–' + hi + ' pts';
  }

  // Everything under the head, as a fragment the caller places. `opts`:
  //   location  false to leave the place out (the quest list's row
  //             already carries it in its own column)
  // A quest with nothing to add returns an empty fragment, so a caller
  // can ask whether there was anything to show before it makes room.
  function questDetails(g, opts) {
    opts = opts || {};
    var frag = document.createDocumentFragment();

    if (opts.location !== false && g.location) frag.appendChild(el('p', 'fl-location', g.location));

    if (g.description) {
      var body = el('div', 'md fl-body');
      body.innerHTML = scs.markdown(g.description);
      frag.appendChild(body);
    }
    if (g.flavour) frag.appendChild(el('p', 'fl-flavour', g.flavour));

    // a quest of several parts, or one scored by bands: every part with
    // its label and points, and a tiered or counted part's bands and
    // places under it
    var codes = g.codes || [];
    var banded = codes.some(function (c) { return c.scoring === 'tiered' || c.scoring === 'counted'; });
    if (codes.length > 1 || banded) {
      var table = el('table', 'nice fl-codes');
      var tbody = el('tbody');
      var places = g.places || (g.rules && g.rules.tally && g.rules.tally.awards) || [];
      var line = function (code, label, value, sub) {
        var tr = el('tr', sub ? 'fl-band' : null);
        var codeTd = el('td');
        if (code) codeTd.appendChild(el('span', 'code', code));
        tr.appendChild(codeTd);
        tr.appendChild(el('td', null, label));
        tr.appendChild(el('td', 'fl-num', value));
        tbody.appendChild(tr);
      };
      codes.forEach(function (c) {
        var byBands = c.scoring === 'tiered' || c.scoring === 'counted';
        var pts = c.points == null ? '???' : c.points;
        line(c.code, c.label || '', byBands ? '' : (c.scoring === 'judged' ? 'up to ' : '') + pts + (c.scoring === 'unit' ? ' pts each' : ' pts'));
        if (!byBands) return;
        (c.bands || []).forEach(function (b) { line('', b.from + ' or more', (b.points == null ? '???' : b.points) + ' pts', true); });
        if (c.scoring === 'counted') {
          places.forEach(function (p, i) {
            var n = i + 1;
            var nth = n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
            if (p == null || p > 0) line('', nth + ' place', (p == null ? '???' : p) + ' pts', true);
          });
        }
      });
      table.appendChild(tbody);
      frag.appendChild(table);
    }

    // files hung on the quest: photos open in the zoomable lightbox,
    // PDFs as plain rows
    var files = g.files || [];
    var shots = files.filter(function (f) { return String(f.type || '').indexOf('image/') === 0; });
    var others = files.filter(function (f) { return String(f.type || '').indexOf('image/') !== 0; });
    if (shots.length) {
      var strip = el('div', 'fl-shots');
      var items = shots.map(function (f) {
        return { url: questFileUrl(f.key), type: f.type, name: f.name || g.name };
      });
      shots.forEach(function (f, i) {
        var btn = el('button', 'fl-shot');
        btn.type = 'button';
        var img = el('img');
        img.loading = 'lazy';
        img.crossOrigin = 'anonymous'; // readable to the worker, so it can keep a copy
        img.alt = f.name || g.name;
        img.src = questFileUrl(f.key) + '&thumb=1';
        btn.appendChild(img);
        btn.addEventListener('click', function () { scs.lightbox(items, i, img); });
        strip.appendChild(btn);
      });
      frag.appendChild(strip);
    }
    others.forEach(function (f) {
      var row = el('p', 'fl-file');
      var a = el('a', null, f.name || 'Attachment');
      a.href = questFileUrl(f.key);
      a.target = '_blank';
      a.rel = 'noopener';
      row.appendChild(a);
      frag.appendChild(row);
    });

    return frag;
  }

  window.scsFullQuest = { details: questDetails, points: pointsText, live: isLive };

  // ---------- The page itself ----------
  var listEl = document.getElementById('fl-list');
  var statusEl = document.getElementById('fl-status');
  var summaryEl = document.getElementById('fl-summary');
  if (!listEl) return; // the quest list loads this file for the block above

  function renderQuest(g) {
    var box = el('section', 'fl-quest');
    box.id = g.key;

    var head = el('div', 'fl-head');
    var chip = el('span', 'code', g.key);
    head.appendChild(chip);
    var name = el('h3', 'fl-name', g.name);
    if (isLive(g)) {
      var live = el('span', 'fl-live', 'LIVE');
      name.appendChild(live);
    }
    head.appendChild(name);
    var pts = pointsText(g);
    if (pts) head.appendChild(el('span', 'fl-points', pts));
    box.appendChild(head);

    box.appendChild(questDetails(g));

    var links = el('p', 'fl-links');
    var mapLink = el('a', null, 'Open on the map');
    mapLink.href = '../#' + encodeURIComponent(g.key);
    var subLink = el('a', null, 'Submit proof');
    subLink.href = '../../submit/#' + encodeURIComponent(g.key);
    links.appendChild(mapLink);
    links.appendChild(subLink);
    box.appendChild(links);
    return box;
  }

  function render(data) {
    var groups = data.groups || [];
    var regions = (data.regions || []).slice();
    var byRegion = {};
    groups.forEach(function (g) {
      var r = g.region || '';
      if (!byRegion[r]) byRegion[r] = [];
      byRegion[r].push(g);
    });
    if (byRegion['']) regions.push(''); // no region shows last, as on the list

    listEl.textContent = '';
    regions.forEach(function (r) {
      var inRegion = byRegion[r];
      if (!inRegion || !inRegion.length) return;
      listEl.appendChild(el('h2', 'section-heading', r || 'Other quests'));
      inRegion.forEach(function (g) { listEl.appendChild(renderQuest(g)); });
    });

    summaryEl.textContent = groups.length + ' quests. Points are per code; a "Per …" code pays each time.';
    statusEl.textContent = '';

    // /questlist/full/#SQ40 lands on that quest. The body is the
    // scroller (html is overflow: hidden) and the nav bar is fixed,
    // so step back up by its height or the quest starts underneath.
    var raw = (location.hash || '').slice(1);
    if (raw) {
      var target;
      try { target = document.getElementById(decodeURIComponent(raw)); } catch (err) { target = null; }
      if (target) {
        target.scrollIntoView();
        var nav = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--nav-h')) || 64;
        document.body.scrollTop -= nav + 8;
      }
    }
  }

  scs.questList().then(render).catch(function () {
    statusEl.textContent = 'The quest list could not load. Check your connection and reload.';
  });
})();
