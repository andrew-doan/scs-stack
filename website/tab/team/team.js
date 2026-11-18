/* One team's page: the quests it did with when each was recorded,
   its submissions by hour, and the plain facts of its day. Reached
   from the leaderboard once the organisers open team pages; before
   that the tab answers 404 and the page says so. */
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
  function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'];
    var v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  // the team's name is the app bar's title as well as the page's
  var barTitle = document.querySelector('.site-brand-page');
  function showName(text) {
    $('tm-name').textContent = text;
    if (barTitle) barTitle.textContent = text;
    document.title = text + ' | SCS.2';
  }

  var name = '';
  var teamId = '';
  try {
    var params = new URLSearchParams(location.search);
    name = params.get('name') || '';
    teamId = params.get('id') || '';
  } catch (err) { name = ''; teamId = ''; }
  if (!/^\d+$/.test(teamId)) teamId = '';
  if (name) showName(name);

  // the last answer, drawn again when the settings change how times read
  var shown = null;

  // ---- the chart's step: hour, half hour, quarter or minute ----
  var STEPS = scs.CHART_STEPS;
  var picker = scs.chartStep(document.querySelector('.chart-step'), 'scs2-team-step', function () {
    if (shown) drawSubs(shown);
  });

  // the note and the chart, at the step picked
  function drawSubs(d) {
    var s = d.submissions;
    // an answer from before the finer steps draws by the hour
    var step = picker.step();
    var at = d[STEPS[step].rows] ? step : '60';
    var line = at === '1';
    var mark = line ? ' line)' : ' bar)';
    $('tm-subs-note').textContent = s.sent
      ? fmt(s.sent) + (s.sent === 1 ? ' submission' : ' submissions') + ' total with ' + fmt(s.accepted) + ' accepted (dark green' + mark + ' and ' +
        fmt(s.rejected) + ' rejected' + (s.pending ? ' and ' + fmt(s.pending) + ' waiting' : '') + ' (light green' + mark + '.'
      : 'This team sent nothing to the Tab.';
    // with nothing sent, the line above says so and the chart area
    // stays empty rather than saying it a second time; the chart's own
    // empty line is left for the case where there are submissions but
    // no hours to put them in
    if (s.sent) {
      scs.hourBars($('tm-hours'), d[STEPS[at].rows], {
        key: 'sent', inner: 'accepted', step: Number(at), line: line, empty: 'No submissions to chart.'
      });
    } else {
      $('tm-hours').textContent = '';
    }
  }

  function render(d) {
    // on screen before the chart is drawn, so the chart can measure its width
    $('tm-body').hidden = false;
    showName(d.team);
    // the place, then when the team arrived: when the last of it checked
    // in, or while some are still to come, the last so far
    var lead = d.dnf ? 'Did not finish.' : d.rank ? ordinal(d.rank) + ' of ' + d.teams + ' teams.' : '';
    if (d.checked_in_at) {
      // a time stamp breaks as one word
      var when = scs.fmtTime(d.checked_in_at).replace(/ /g, '\u00a0');
      lead += (lead ? ' ' : '') + (d.checked_in
        ? d.checked_in.n + ' of ' + d.checked_in.of + ' checked in, the last at ' + when + '.'
        : 'Checked in at ' + when + '.');
    }
    $('tm-place').textContent = lead;

    var s = d.submissions;
    var figs = $('tm-figures');
    figs.textContent = '';
    figs.appendChild(scs.figure([d.total, d.total === 1 ? 'Point' : 'Points']));
    figs.appendChild(scs.figure([d.quests_done, 'Quests Done']));
    var sent = [s.sent, 'Submissions Sent'];
    if (s.sent) {
      sent.push(', ', s.accepted, ' Accepted' + (s.pending ? ', ' : ' and '), s.rejected, ' Rejected');
      if (s.pending) sent.push(' and ', s.pending, ' Waiting');
    }
    figs.appendChild(scs.figure(sent));

    // the quests, grouped by region in the order they were recorded
    var wrap = $('tm-lines');
    wrap.textContent = '';
    if (!d.lines.length) {
      wrap.appendChild(el('p', 'tm-note', 'No quests on the tab for this team.'));
    } else {
      var byRegion = {};
      var order = [];
      d.lines.forEach(function (l) {
        var r = l.region || 'Other Quests';
        if (!byRegion[r]) { byRegion[r] = []; order.push(r); }
        byRegion[r].push(l);
      });
      // the roles keep each table a table when a phone lays its rows out
      // as grids
      var part = function (tag, role, cls, text) {
        var node = el(tag, cls, text);
        node.setAttribute('role', role);
        return node;
      };
      order.forEach(function (r) {
        wrap.appendChild(el('h3', 'tm-region', r));
        var box = el('div', 'tm-lines table-scroll');
        var table = part('table', 'table', 'nice tm-table');
        var thead = part('thead', 'rowgroup');
        var hr = part('tr', 'row');
        // an award is counted from a list, not recorded at a moment
        var awards = byRegion[r][0].award;
        hr.appendChild(part('th', 'columnheader', null, awards ? 'Task' : 'Quest'));
        if (!awards) hr.appendChild(part('th', 'columnheader', 'tm-col-at', 'Recorded'));
        hr.appendChild(part('th', 'columnheader', 'num tm-col-points', 'Points'));
        thead.appendChild(hr);
        table.appendChild(thead);
        var tbody = part('tbody', 'rowgroup');
        byRegion[r].forEach(function (l) {
          var tr = part('tr', 'row');
          var td = part('td', 'cell');
          var chip = el('span', 'code', l.code);
          td.appendChild(chip);
          td.appendChild(document.createTextNode(' ' + l.name + (l.label ? ' — ' + l.label : '')));
          if (l.amount != null && l.amount !== 1) td.appendChild(el('span', 'tm-when', ' × ' + fmt(l.amount)));
          tr.appendChild(td);
          // a time outside the dashboard's time frame comes back empty
          if (!awards) tr.appendChild(part('td', 'cell', 'tm-when tm-col-at', l.at ? scs.fmtTime(l.at) : ''));
          tr.appendChild(part('td', 'cell', 'num tm-col-points', fmt(l.worth)));
          tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        box.appendChild(table);
        wrap.appendChild(box);
      });
    }

    drawSubs(d);

    var facts = $('tm-facts');
    facts.textContent = '';
    if (d.first_at) scs.fact(facts, 'First Submission', scs.fmtTime(d.first_at));
    if (d.last_at) scs.fact(facts, 'Last Submission', scs.fmtTime(d.last_at));
    scs.fact(facts, 'Total Submissions Sent', fmt(s.sent) + ', with ' + fmt(d.files.photos) + (d.files.photos === 1 ? ' photo' : ' photos') + ', ' +
      fmt(d.files.videos) + (d.files.videos === 1 ? ' video' : ' videos') + (d.files.bytes ? ', ' + fmtBytes(d.files.bytes) : ''));

    shown = d;
  }

  // Hide dates and 24-hour time change every time on the page
  document.addEventListener('scs-dates-changed', function () {
    if (shown) render(shown);
  });

  // ---- the receipt as a picture, to paste into a chat ----
  // A row a quest, holding the codes recorded against it, in the order
  // the quests were first scored.
  function receiptData(d) {
    var byKey = {};
    var quests = [];
    d.lines.forEach(function (l) {
      var key = l.group_key || l.code;
      var q = byKey[key];
      if (!q) {
        q = byKey[key] = { key: key, name: l.name, held: [], worth: 0 };
        quests.push(q);
      }
      q.held.push({ code: l.code, amount: l.amount, label: l.label, worth: l.worth });
      q.worth = Math.round((q.worth + Number(l.worth || 0)) * 100) / 100;
    });
    return {
      team: d.team,
      total: d.total,
      place: d.dnf ? 'Did not finish' : d.rank ? ordinal(d.rank) + ' of ' + d.teams : null,
      site: location.host,
      quests: quests
    };
  }

  // How much the receipt shows: quests only, each with the codes it holds
  // under it, or each code on a line of its own with its points; kept on
  // the device. The rocker before it kept '1' for quests only.
  var DETAIL_KEY = 'scs2-receipt-detail';
  var detail = 'standard';
  try {
    detail = localStorage.getItem(DETAIL_KEY) || (localStorage.getItem('scs2-receipt-compact') === '1' ? 'compact' : 'standard');
  } catch (err) { /* not kept */ }
  var detailBtns = Array.prototype.slice.call(document.querySelectorAll('#tm-detail button'));
  function paintDetail() {
    detailBtns.forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-detail') === detail ? 'true' : 'false'); });
  }
  paintDetail();

  // The window that shows the receipt before it is copied. The picture is
  // drawn once each way while it is open, so flipping the option back
  // and forth draws nothing twice.
  var preview = $('tm-preview');
  var previewImg = $('tm-preview-img');
  var previewOpen = false;
  var previewLayer = null;
  var previewUrl = '';
  var openedAt = 0;
  var made = {};

  function receiptPng(level) {
    // drawn in the page's own theme, which can change while it is open
    var dark = document.documentElement.getAttribute('data-theme') === 'dark';
    var key = level + (dark ? ' dark' : '');
    if (!made[key]) {
      var data = receiptData(shown);
      data.detail = level;
      data.dark = dark;
      made[key] = window.SCSShareImage.png('receipt', data, '../../assets/icons/logo-256.png');
    }
    return made[key];
  }
  function dropPreviewUrl() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
  }
  function paintPreview() {
    var level = detail;
    receiptPng(level).then(function (blob) {
      if (!previewOpen || detail !== level) return;
      dropPreviewUrl();
      previewUrl = URL.createObjectURL(blob);
      previewImg.src = previewUrl;
      previewImg.hidden = false;
    }, function () {
      if (window.scsToast) window.scsToast('The receipt could not be made.');
    });
  }
  function onPreviewKey(e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (previewLayer && !window.scsBackLayer.isTop(previewLayer)) return;
    e.preventDefault();
    closePreview(false);
  }
  function openPreview() {
    if (!window.SCSShareImage || !shown || previewOpen) return;
    previewOpen = true;
    made = {};
    previewImg.hidden = true;
    preview.hidden = false;
    openedAt = Date.now();
    void preview.offsetWidth;
    preview.classList.add('is-open');
    document.addEventListener('keydown', onPreviewKey);
    if (window.scsBackLayer) previewLayer = window.scsBackLayer.arm(function () { closePreview(true); });
    paintPreview();
    $('tm-preview-copy').focus();
  }
  function closePreview(viaBack) {
    if (!previewOpen) return;
    previewOpen = false;
    document.removeEventListener('keydown', onPreviewKey);
    preview.classList.remove('is-open');
    window.setTimeout(function () {
      if (previewOpen) return;
      preview.hidden = true;
      previewImg.removeAttribute('src');
      dropPreviewUrl();
    }, scs.ms('--duration-fast', 250) + 40);
    if (!viaBack && previewLayer && window.scsBackLayer) window.scsBackLayer.disarm(previewLayer);
    previewLayer = null;
    $('tm-copy').focus();
  }

  detailBtns.forEach(function (b) {
    b.addEventListener('click', function () {
      detail = b.getAttribute('data-detail');
      try { localStorage.setItem(DETAIL_KEY, detail); } catch (err) { /* not kept */ }
      paintDetail();
      if (previewOpen) paintPreview();
    });
  });
  $('tm-copy').addEventListener('click', openPreview);
  $('tm-preview-cancel').addEventListener('click', function () { closePreview(false); });
  preview.addEventListener('click', function (e) {
    // the tap that opened the window lands on its ground a moment later
    if (e.target === preview && Date.now() - openedAt > 400) closePreview(false);
  });
  // the copy has to start inside the tap, with the picture still a promise
  $('tm-preview-copy').addEventListener('click', function () {
    var lib = window.SCSShareImage;
    if (!lib || !shown) return;
    lib.copy(receiptPng(detail), lib.fileName('Receipt ' + shown.team)).then(function (how) {
      if (window.scsToast) window.scsToast(how === 'copied' ? 'Receipt copied.' : 'Receipt saved.');
    }, function () {
      if (window.scsToast) window.scsToast('The receipt could not be made.');
    });
    closePreview(false);
  });

  // The route the team recorded, played back on a map, once the
  // organisers open the replay and when there is a route for this team.
  // Its quests come from the replay's read, which times each one by when
  // its proof was sent.
  var routeShown = false;
  function showRoute(team) {
    if (routeShown || !window.SCSReplay) return;
    var key = String(team).toLowerCase().replace(/\s+/g, ' ').trim();
    scs.pulse().then(function (pulse) {
      if (!pulse || !pulse.replay) return;
      return scs.fetch(API + '/api/replay', { cache: 'no-store' }).then(function (r) {
        return r.ok ? r.json() : null;
      }).then(function (replay) {
        var has = replay && replay.ok && (replay.teams || []).some(function (t) {
          return t.route && String(t.name).toLowerCase().replace(/\s+/g, ' ').trim() === key;
        });
        if (!has || routeShown) return;
        routeShown = true;
        $('tm-route').hidden = false;
        scs.gotIt('team-route');
        window.SCSReplay.start($('tm-replay'), { api: API, single: true, teams: [team], replay: replay });
      });
    }).catch(function () {
      scs.again('team-route', function () { showRoute(team); });
    });
  }

  // the slide in from the tab (assets/push.js) has finished
  function arrived() {
    return window.scsPush ? window.scsPush.ready : Promise.resolve();
  }

  function load() {
    if (!name && !teamId) {
      // no team says nothing about whether the pages are open; the
      // section below is shown for its link back
      $('tm-place').textContent = 'No team named. Pick one from the tab.';
      $('tm-closed-why').hidden = true;
      $('tm-closed').hidden = false;
      return;
    }
    var ask = (teamId ? 'id=' + teamId + '&' : '') + 'name=' + encodeURIComponent(name);
    scs.fetch(API + '/api/team?' + ask, { cache: 'no-store' }).then(function (r) {
      scs.gotIt('team');
      $('tm-error').classList.add('is-hidden');
      if (r.status === 404) {
        $('tm-place').textContent = 'Not open yet.';
        $('tm-closed').hidden = false;
        return null;
      }
      if (!r.ok) throw new Error('team ' + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || !d.ok) return;
      // drawn once the page has slid in, so the slide has the page to itself
      return arrived().then(function () {
        render(d);
        scs.rise($('tm-body'));
        showRoute(d.team);
      });
    }).catch(function () {
      $('tm-place').textContent = 'Could not load.';
      $('tm-body').hidden = true;
      $('tm-error').classList.remove('is-hidden');
      scs.again('team', load);
    });
  }

  load();
})();
