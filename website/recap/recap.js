/* The recap: SCS.2 in numbers, from the tab worker's /api/recap.
   Open once the organisers say so; before that the worker answers
   404 and the page says it is not open. Every time is shown in the
   device's own zone. */
(function () {
  'use strict';

  var scs = window.scs;
  var API = scs.TAB_API;

  function $(id) { return document.getElementById(id); }
  function fmt(n) { return (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
  function fmtBytes(n) {
    if (n > 1024 * 1024 * 1024) return (Math.round(n / (1024 * 1024 * 1024) * 10) / 10) + ' GB';
    if (n > 1024 * 1024) return (Math.round(n / (1024 * 1024) * 10) / 10) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }
  function plural(n, one, many) { return fmt(n) + ' ' + (n === 1 ? one : many); }
  function minutes(m) {
    if (m == null) return '';
    if (m < 1) return 'under a minute';
    if (m < 90) return Math.round(m) + ' min';
    return (Math.round(m / 6) / 10) + ' h';
  }
  // a span of seconds as people say it: 40 s, 4 min 12 s, 1 h 05 min
  function span(secs) {
    secs = Math.round(secs);
    if (secs < 60) return secs + ' s';
    var mins = Math.floor(secs / 60);
    if (mins < 60) return mins + ' min ' + (secs % 60) + ' s';
    var m = mins % 60;
    return Math.floor(mins / 60) + ' h ' + (m < 10 ? '0' : '') + m + ' min';
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function word(n, one, many) { return n === 1 ? one : many; }

  var CHEVRON = '<svg class="rc-row-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
  // a quest opening its own numbers: the chip, the name in ink and a
  // chevron, as the tab's team rows are
  function rowLink(q) {
    var a = el('a', 'rc-row-link');
    a.href = 'quest/?key=' + encodeURIComponent(q.key);
    a.setAttribute('data-push', '');
    a.appendChild(el('span', 'code', q.key));
    // the space is for a screen reader and for copied text; the flex
    // gap is what shows
    a.appendChild(document.createTextNode(' '));
    var name = el('span', 'rc-row-name', q.name);
    name.insertAdjacentHTML('beforeend', CHEVRON);
    a.appendChild(name);
    return a;
  }
  // place: the number in the disc, for lists where level teams share one
  function listRow(main, num, place) {
    var li = el('li');
    if (place) li.style.counterSet = 'rc ' + place;
    var name = el('span', 'rc-name');
    if (typeof main === 'string') name.textContent = main; else name.appendChild(main);
    li.appendChild(name);
    li.appendChild(el('span', 'rc-num', num));
    return li;
  }

  // a click anywhere on a quest's row opens it, as the name does, and
  // anywhere on a region's row opens or closes it
  $('rc-body').addEventListener('click', function (e) {
    if (!e.target.closest || e.target.closest('a, button')) return;
    var row = e.target.closest('.has-quest-link');
    if (row) {
      var a = row.querySelector('a.rc-row-link');
      if (a) a.click();
      return;
    }
    var region = e.target.closest('tr.has-quests');
    if (region) region.querySelector('.rc-region-toggle').click();
  });

  // ---- the chart's step: hour, half hour, quarter or minute ----
  var STEPS = scs.CHART_STEPS;
  var picker = scs.chartStep(document.querySelector('.chart-step'), 'scs2-recap-step', function () {
    if (shown) drawSubs(shown);
  });

  // the note, the chart and the facts under it, at the step picked
  function drawSubs(d) {
    var s = d.submissions;
    // an answer from before the finer steps draws by the hour
    var step = picker.step();
    var at = s[STEPS[step].rows] ? step : '60';
    var line = at === '1';
    var mark = line ? ' line)' : ' bar)';
    // the heading above says what the chart is; this says what the two
    // greens mean, which the chart cannot
    $('rc-subs-note').textContent = s.sent
      ? plural(s.sent, 'submission', 'submissions') + ' total with ' + fmt(s.accepted) + ' accepted (dark green' + mark + ' and ' +
        fmt(s.rejected) + ' rejected' + (s.pending ? ' and ' + fmt(s.pending) + ' waiting' : '') + ' (light green' + mark + '.'
      : 'Nothing was sent to the Tab.';
    // with nothing sent, the line above says so and the chart area
    // stays empty rather than saying it a second time; the chart's own
    // empty line is left for the case where there are submissions but
    // no hours to put them in
    if (s.sent) {
      scs.hourBars($('rc-hours'), s[STEPS[at].rows], {
        key: 'sent', inner: 'accepted', step: Number(at), line: line, empty: 'No submissions to chart.'
      });
    } else {
      $('rc-hours').textContent = '';
    }
    var sf = $('rc-subs-facts');
    sf.textContent = '';
    var busy = s[STEPS[at].busiest];
    if (busy) {
      var day = scs.hideDates() ? '' : scs.fmtDay(busy.hour);
      scs.fact(sf, 'Busiest ' + STEPS[at].name, scs.fmtHour(busy.hour, at !== '60') + (day ? ' on ' + day : '') + ', ' +
        plural(busy.sent, 'submission', 'submissions'));
    }
    if (s.first_at) scs.fact(sf, 'First Submission', scs.fmtTime(s.first_at));
    if (s.last_at) scs.fact(sf, 'Last Submission', scs.fmtTime(s.last_at));
    if (d.review.reviewed) {
      scs.fact(sf, 'Processing Time', 'Median ' + minutes(d.review.median_minutes) + ', mean ' + minutes(d.review.mean_minutes) +
        '; fastest ' + minutes(d.review.fastest_minutes) + ', slowest ' + minutes(d.review.slowest_minutes));
    }
  }

  // the regions open while the page is redrawn
  var openRegions = {};

  // the roles keep a table a table when a phone lays its rows out as grids
  function row(cls) {
    var tr = el('tr', cls);
    tr.setAttribute('role', 'row');
    return tr;
  }
  function cell(cls, text) {
    var td = el('td', cls, text);
    td.setAttribute('role', 'cell');
    return td;
  }

  // the last answer, drawn again when the settings change how times read
  var shown = null;

  function render(d) {
    var s = d.submissions;
    // on screen before the chart is drawn, so the chart can measure its width
    $('rc-body').hidden = false;
    $('rc-lead').textContent = '';
    $('rc-lead').hidden = true;

    var big = $('rc-big');
    big.textContent = '';
    big.appendChild(scs.figure([d.teams, word(d.teams, 'Team', 'Teams')]));
    big.appendChild(scs.figure([d.completions, word(d.completions, 'Quest Completion', 'Quest Completions') + ' across ', d.quests, word(d.quests, ' Quest', ' Quests')]));
    big.appendChild(scs.figure(d.points_spread
      ? [d.points, 'Total Points, ', d.points_spread.median, ' for the Median Team']
      : [d.points, 'Total Points']));
    var subLine = [s.sent, word(s.sent, 'Submission', 'Submissions')];
    if (s.sent) {
      subLine.push(', ', s.accepted, ' Accepted' + (s.pending ? ', ' : ' and '), s.rejected, ' Rejected');
      if (s.pending) subLine.push(' and ', s.pending, ' Waiting');
    }
    big.appendChild(scs.figure(subLine));

    drawSubs(d);

    // when each quest was done
    var rows = $('rc-quest-rows');
    rows.textContent = '';
    d.quests_by_time.forEach(function (q) {
      var tr = row();
      tr.className = 'has-quest-link';
      var td = cell();
      td.appendChild(rowLink(q));
      tr.appendChild(td);
      tr.appendChild(cell(null, q.region || 'Other Quests'));
      tr.appendChild(cell('num', String(q.done_by)));
      tr.appendChild(cell(null, q.peak_hour ? scs.fmtHour(q.peak_hour) + (q.peak_count > 1 ? ' (' + q.peak_count + ')' : '') : ''));
      rows.appendChild(tr);
    });
    if (!d.quests_by_time.length) {
      var none = row();
      none.appendChild(cell(null, 'No quests were done.'));
      rows.appendChild(none);
    }

    [['rc-most', d.most_done], ['rc-least', d.least_done]].forEach(function (pair) {
      var list = $(pair[0]);
      list.textContent = '';
      pair[1].forEach(function (q) {
        var li = listRow(rowLink(q), plural(q.done_by, 'team', 'teams'));
        li.className = 'has-quest-link';
        list.appendChild(li);
      });
    });

    $('rc-never-note').textContent = d.never_done.length
      ? plural(d.never_done.length, 'quest was', 'quests were') + ' never done by any team.'
      : 'Every quest was done by at least one team.';
    var never = $('rc-never');
    never.textContent = '';
    d.never_done.forEach(function (q) {
      var a = el('a');
      a.href = '../questlist/#' + encodeURIComponent(q.key);
      a.title = q.name;
      a.appendChild(el('span', 'code', q.key));
      never.appendChild(a);
    });

    var top = $('rc-top');
    top.textContent = '';
    d.top_teams.slice(0, 3).forEach(function (t) {
      top.appendChild(listRow(t.name, fmt(t.points) + ' pts, ' + plural(t.quests_done, 'quest', 'quests'), t.rank));
    });
    var active = $('rc-active');
    active.textContent = '';
    d.most_active.forEach(function (t) {
      active.appendChild(listRow(t.name, plural(t.sent, 'submission', 'submissions') + ', ' + t.accepted + ' accepted'));
    });

    // the leaderboards picked on the dashboard's Ranks tab
    var boards = $('rc-boards');
    boards.textContent = '';
    var shownBoards = (d.boards || []).filter(function (b) { return b.teams && b.teams.length; });
    shownBoards.forEach(function (b) {
      var box = el('div');
      box.appendChild(el('h2', 'section-heading', b.title));
      var ol = el('ol', 'rc-list');
      b.teams.forEach(function (t) {
        var value = b.measure === 'points' ? fmt(t.value) + ' pts'
          : b.measure === 'accepted' ? t.value + ' accepted'
          : b.measure === 'quests' ? plural(t.value, 'quest', 'quests')
          : b.measure === 'time' ? span(t.value) + ' on average'
          : fmt(t.value);
        ol.appendChild(listRow(t.name, value, t.place));
      });
      box.appendChild(ol);
      boards.appendChild(box);
    });
    boards.hidden = !shownBoards.length;

    // sections the organisers wrote on the dashboard: a heading, a few
    // words, and entries with their photos and videos
    var secs = $('rc-sections');
    secs.textContent = '';
    (d.sections || []).forEach(function (sec) {
      var box = el('section', 'section rc-section');
      if (sec.title) box.appendChild(el('h2', 'section-heading', sec.title));
      if (sec.text) {
        var lead = el('div', 'rc-section-text');
        lead.innerHTML = scs.markdown(sec.text);
        box.appendChild(lead);
      }
      var photos = [];
      var entries = el('div', 'rc-entries');
      sec.items.forEach(function (it) {
        var entry = el('article', 'rc-entry');
        if (it.title) entry.appendChild(el('h3', 'rc-entry-title', it.title));
        if (it.text) {
          var words = el('div', 'rc-entry-text');
          words.innerHTML = scs.markdown(it.text);
          entry.appendChild(words);
        }
        it.media.forEach(function (m) {
          var url = API + m.url;
          if (m.type.indexOf('video/') === 0) {
            var v = el('video', 'rc-entry-media');
            v.controls = true;
            v.preload = 'metadata';
            v.playsInline = true;
            v.src = url;
            v.setAttribute('aria-label', m.alt);
            entry.appendChild(v);
            return;
          }
          var at = photos.length;
          photos.push({ url: url, type: m.type, name: m.alt });
          var btn = el('button', 'rc-entry-photo');
          btn.type = 'button';
          var img = el('img', 'rc-entry-media');
          img.crossOrigin = 'anonymous';
          img.alt = m.alt;
          btn.appendChild(img);
          scs.keepPicture(img, url);
          btn.addEventListener('click', function () { scs.lightbox(photos, at, img); });
          entry.appendChild(btn);
        });
        entries.appendChild(entry);
      });
      if (sec.items.length) box.appendChild(entries);
      secs.appendChild(box);
    });

    // each region opens to its quests, with what each brought in
    var regions = $('rc-regions');
    regions.textContent = '';
    d.regions.forEach(function (r, ri) {
      var quests = r.quests || [];
      var tr = row('rc-region');
      var first = cell();
      var toggle = null;
      if (quests.length) {
        tr.classList.add('has-quests');
        toggle = el('button', 'rc-region-toggle');
        toggle.type = 'button';
        // the last word and the chevron wrap together
        var words = r.region.split(' ');
        var tail = el('span', 'rc-region-tail', words.pop());
        tail.insertAdjacentHTML('beforeend', '<svg class="rc-region-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>');
        if (words.length) toggle.appendChild(el('span', null, words.join(' ') + ' '));
        toggle.appendChild(tail);
        first.appendChild(toggle);
      } else {
        first.textContent = r.region;
      }
      tr.appendChild(first);
      tr.appendChild(cell('num', fmt(r.completions)));
      tr.appendChild(cell('num', fmt(r.teams)));
      tr.appendChild(cell('num', fmt(r.points)));
      regions.appendChild(tr);
      if (!toggle) return;
      var ids = [];
      var rows = quests.map(function (q, qi) {
        var sub = row('rc-region-quest has-quest-link');
        sub.id = 'rc-region-' + ri + '-' + qi;
        ids.push(sub.id);
        var td = cell();
        td.appendChild(rowLink(q));
        sub.appendChild(td);
        sub.appendChild(cell('num', fmt(q.completions)));
        sub.appendChild(cell('num', fmt(q.teams)));
        sub.appendChild(cell('num', fmt(q.points)));
        regions.appendChild(sub);
        return sub;
      });
      toggle.setAttribute('aria-controls', ids.join(' '));
      var set = function (open) {
        toggle.setAttribute('aria-expanded', String(open));
        tr.classList.toggle('is-open', open);
        rows.forEach(function (sub) { sub.hidden = !open; });
        if (open) openRegions[r.region] = true; else delete openRegions[r.region];
      };
      set(!!openRegions[r.region]);
      toggle.addEventListener('click', function () {
        var open = toggle.getAttribute('aria-expanded') !== 'true';
        set(open);
        if (open) rows.forEach(function (sub) { scs.rise(sub); });
      });
    });

    var facts = $('rc-facts');
    facts.textContent = '';
    if (d.points_spread) {
      scs.fact(facts, 'Points Range', fmt(d.points_spread.min) + ' to ' + fmt(d.points_spread.max) + ', a mean of ' + fmt(d.points_spread.mean));
    }
    scs.fact(facts, 'Files Sent', plural(d.files.photos, 'photo', 'photos') + ' and ' + plural(d.files.videos, 'video', 'videos') +
      (d.files.bytes ? ', ' + fmtBytes(d.files.bytes) + ' in all' : '') +
      (d.files.biggest_bytes ? '; the biggest file was ' + fmtBytes(d.files.biggest_bytes) : ''));
    if (d.files.gallery) scs.fact(facts, 'Gallery', plural(d.files.gallery, 'accepted submission', 'accepted submissions') + ' opted into the gallery');
    if (d.checkins.n) {
      scs.fact(facts, 'Arrivals', plural(d.checkins.n, 'team', 'teams') + ' checked in, the first at ' + scs.fmtTime(d.checkins.first_at) +
        (d.checkins.last_at && d.checkins.last_at !== d.checkins.first_at ? ' and the last at ' + scs.fmtTime(d.checkins.last_at) : ''));
    }

    shown = d;
  }

  // Hide dates and 24-hour time change every time on the page
  document.addEventListener('scs-dates-changed', function () {
    if (shown) render(shown);
  });

  function load() {
  scs.fetch(API + '/api/recap', { cache: 'no-store' }).then(function (r) {
    scs.gotIt('recap');
    $('rc-error').classList.add('is-hidden');
    if (r.status === 404) {
      $('rc-lead').textContent = 'Not open yet.';
      $('rc-closed').hidden = false;
      return null;
    }
    if (!r.ok) throw new Error('recap ' + r.status);
    return r.json();
  }).then(function (d) {
    if (!d || !d.ok) return;
    // drawn once the page has slid in (assets/push.js)
    return (window.scsPush ? window.scsPush.ready : Promise.resolve()).then(function () {
      render(d);
      scs.rise($('rc-body'));
    });
  }).catch(function () {
    $('rc-lead').textContent = 'Could not load.';
    $('rc-body').hidden = true;
    $('rc-error').classList.remove('is-hidden');
    scs.again('recap', load);
  });
  }
  load();
})();
