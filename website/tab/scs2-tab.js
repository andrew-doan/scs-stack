/* Live tab — pulls the leaderboard and headline stats from the tab
   bot's HTTP API and keeps them fresh: a refresh every 10 seconds
   while the page is visible, plus one the moment it becomes visible
   again. If the API is unreachable the last good table stays put and a
   notice says which of the two things happened — a board on screen
   that is the copy this device kept, or a first visit with nothing to
   show. */
(function () {
  'use strict';

  var API = window.scs.TAB_API;
  var REFRESH_MS = 10000;  // the worker keeps these two for the same 10

  var bodyEl = document.getElementById('tab-body');
  // a tap anywhere on a team's row opens its page, not only its name
  bodyEl.addEventListener('click', function (e) {
    if (e.target.closest && e.target.closest('a, button')) return;
    var row = e.target.closest && e.target.closest('tr.has-team-link');
    var link = row && row.querySelector('a.tab-team-link');
    if (link) link.click();
  });
  var updatedEl = document.getElementById('tab-updated');
  var errorEl = document.getElementById('tab-error');
  var errorTextEl = document.getElementById('tab-error-text');
  var waitingEl = document.getElementById('tab-waiting');
  var dnfNote = document.getElementById('tab-dnf');
  var lastGoodAt = null;
  // is there a board on screen to explain, or is this a first visit?
  function haveBoard() { return !!(bodyEl && bodyEl.children.length); }

  function fmt(n) {
    return (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 });
  }

  // A UTC stamp as the clock a reader is holding. This lived here as
  // its own copy and is site.js's now: the same rule reads the messages
  // page and the submit page's sent list, and the settings menu's Hide
  // dates rocker takes the date off all three together.
  function whenText(utc) {
    return String(utc == null ? '' : utc).trim() ? window.scs.fmtTime(utc) : '';
  }

  var scs = window.scs;
  // stat digits pop in when a value changes (shared number pop-in)
  function setStat(id, value) { scs.digits(document.getElementById(id), value); }

  // After the event the organisers open the team pages, the recap and
  // the replay; the pulse says which, and the table is drawn again so the
  // names turn into links without waiting for the next refresh.
  var flags = { team_pages: false, recap: false, replay: false };
  var lastTeams = null;
  function applyFlags(pulse) {
    if (!pulse) return;
    var was = flags.team_pages;
    flags = { team_pages: !!pulse.team_pages, recap: !!pulse.recap, replay: !!pulse.replay };
    var recapLink = document.getElementById('tab-recap');
    if (recapLink) recapLink.hidden = !flags.recap;
    var replayLink = document.getElementById('tab-replay');
    if (replayLink) replayLink.hidden = !flags.replay;
    if (was !== flags.team_pages && lastTeams) renderTable(lastTeams);
    syncShare();
    syncOver();
  }

  // the band at the top once any of the switches is on
  var overBand = document.getElementById('tab-over');
  // once the results are out the tab is no longer live: the title says Tab
  var liveWord = document.querySelector('.tab-live-word');
  function syncOver() {
    var over = !!(flags.team_pages || flags.recap || flags.replay);
    if (liveWord) liveWord.hidden = over;
    document.title = (over ? 'Tab' : 'Live Tab') + ' | SCS.2';
    if (!overBand) return;
    overBand.hidden = !over;
    document.getElementById('tab-over-line').textContent = flags.team_pages
      ? 'These are the finalised results for SCS.2. Tap a team to explore the submissions recorded on the Tab.'
      : 'These are the finalised results for SCS.2.';
  }
  scs.pulse().then(applyFlags);

  // ---- the standings as a picture, once the results are out ----
  var shareRow = document.getElementById('tab-share');
  function syncShare() {
    if (shareRow) shareRow.hidden = !(flags.team_pages && lastTeams && lastTeams.length && !closedNow);
  }
  var copyBtn = document.getElementById('tab-copy');
  if (copyBtn) {
    copyBtn.addEventListener('click', function () {
      var lib = window.SCSShareImage;
      if (!lib || !lastTeams) return;
      var data = {
        title: 'SCS.2 Leaderboard',
        site: location.host,
        // drawn in the page's own theme
        dark: document.documentElement.getAttribute('data-theme') === 'dark',
        teams: lastTeams.map(function (t) {
          return { rank: t.rank, name: t.name, points: t.points, quests: t.quests_done, dnf: !!t.dnf };
        })
      };
      var blob = lib.png('leaderboard', data, '../assets/icons/logo-256.png');
      lib.copy(blob, lib.fileName('SCS.2 standings')).then(function (how) {
        if (window.scsToast) window.scsToast(how === 'copied' ? 'Tab copied.' : 'Tab saved.');
      }, function () {
        if (window.scsToast) window.scsToast('The picture could not be made.');
      });
    });
  }

  var tableEl = document.getElementById('tab-table');
  var painted = false;
  function renderTable(teams) {
    if (!bodyEl) return;
    lastTeams = teams;
    syncShare();
    // nothing to sum means no totals row
    if (tableEl) tableEl.classList.toggle('is-empty', teams.length === 0);

    // remember where each team's row sat, keyed by name, so rows that
    // change place can glide there instead of teleporting
    var wasAt = {};
    Array.prototype.forEach.call(bodyEl.children, function (tr) {
      wasAt[tr.getAttribute('data-team')] = tr.getBoundingClientRect().top;
    });

    bodyEl.innerHTML = '';
    // the gap to the leader, worked out from the column it sits under;
    // the leader's own is the 0 it is. The leader is first place, never
    // a team that did not finish.
    var leaderPoints = 0;
    for (var l = 0; l < teams.length; l++) {
      if (!teams[l].dnf) { leaderPoints = Number(teams[l].points) || 0; break; }
    }
    var anyDnf = false;

    function cell(className) {
      var td = document.createElement('td');
      td.className = className;
      td.setAttribute('role', 'cell');
      return td;
    }
    function word(text) {
      var i = document.createElement('i');
      i.className = 'tab-word';
      i.textContent = text;
      return i;
    }

    teams.forEach(function (team) {
      // a team that did not finish keeps its row, with no place
      var dnf = !!team.dnf;
      if (dnf) anyDnf = true;
      var medal = !dnf && team.rank >= 1 && team.rank <= 3;
      var tr = document.createElement('tr');
      tr.setAttribute('role', 'row');
      if (medal) tr.className = 'is-podium';
      if (dnf) tr.classList.add('is-dnf');
      else if (Number(team.points) === leaderPoints) tr.classList.add('is-leader');
      tr.setAttribute('data-team', team.name);

      var rank = cell('tab-col-rank');
      if (medal) {
        // gold, silver and bronze: the one place the design system
        // allows a round thing is a bullet, and a medal is one
        var rankBullet = document.createElement('span');
        rankBullet.className = 'rank-bullet rank-bullet--' + team.rank;
        rankBullet.textContent = team.rank;
        rank.appendChild(rankBullet);
      } else {
        // the medal's box without the medal, so every place sits on the
        // same centre line as the 1, 2 and 3 above it
        var rankFigure = document.createElement('span');
        rankFigure.className = 'rank-figure';
        rankFigure.textContent = dnf ? '–' : team.rank;
        rank.appendChild(rankFigure);
      }

      var name = cell('tab-team');
      if (flags.team_pages) {
        // the team's own page: what it did, and when
        var link = document.createElement('a');
        link.className = 'tab-team-link';
        // by id, which a rename does not change; a copy frozen without ids links by name
        link.href = 'team/?' + (team.id ? 'id=' + encodeURIComponent(team.id) + '&' : '') + 'name=' + encodeURIComponent(team.name);
        link.setAttribute('data-push', '');
        link.textContent = team.name;
        link.insertAdjacentHTML('beforeend', '<svg class="tab-team-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>');
        name.appendChild(link);
        tr.classList.add('has-team-link');
      } else {
        name.textContent = team.name;
      }
      name.title = team.name;

      var points = cell('tab-col-points');
      points.textContent = fmt(team.points);
      if (dnf) {
        var star = document.createElement('span');
        star.className = 'tab-dnf-mark';
        star.textContent = '*';
        points.appendChild(star);
      }

      // out of the race, so not behind anybody
      var behind = cell('tab-col-behind');
      if (!dnf) {
        behind.appendChild(word('behind '));
        behind.appendChild(document.createTextNode(fmt(leaderPoints - (Number(team.points) || 0))));
      }

      var quests = cell('tab-col-quests');
      if (team.quests_done != null) {
        quests.appendChild(word('quests'));
        quests.appendChild(document.createTextNode(' ' + team.quests_done));
      }

      // what the team last had scored: when, the code, and its name. A
      // team with nothing on the tab yet gets an empty cell rather than
      // something made up to fill it.
      var last = cell('tab-col-last');
      var lq = team.last_quest;
      if (lq && lq.code) {
        var wrap = document.createElement('span');
        wrap.className = 'tab-last';
        var at = document.createElement('span');
        at.className = 'tab-last-at';
        at.textContent = whenText(lq.at);
        var code = document.createElement('span');
        code.className = 'code';
        code.textContent = lq.code;
        var what = document.createElement('span');
        what.className = 'tab-last-name';
        what.textContent = lq.name || lq.code;
        if (at.textContent) wrap.appendChild(at);
        wrap.appendChild(code);
        wrap.appendChild(what);
        last.appendChild(wrap);
      }

      tr.appendChild(rank);
      tr.appendChild(name);
      tr.appendChild(points);
      tr.appendChild(behind);
      tr.appendChild(quests);
      tr.appendChild(last);
      bodyEl.appendChild(tr);
    });
    if (dnfNote) dnfNote.hidden = !anyDnf;

    if (scs.reducedMotion) { painted = true; return; }
    Array.prototype.forEach.call(bodyEl.children, function (tr) {
      if (typeof tr.animate !== 'function') return;
      var before = wasAt[tr.getAttribute('data-team')];
      if (before === undefined) {
        // a team new to the table rises in (the first paint is the
        // skeleton reveal's job)
        if (painted) tr.classList.add('is-new');
        return;
      }
      var shift = before - tr.getBoundingClientRect().top;
      if (Math.abs(shift) < 2) return;
      tr.animate([
        { transform: 'translateY(' + shift + 'px)' },
        { transform: 'translateY(0)' }
      ], { duration: scs.ms('--duration-medium', 350), easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
    });
    painted = true;
  }

  var TAB_CACHE_KEY = 'scs2-tab-cache';

  // Compact or full, on a phone. The choice is kept, since somebody who
  // wants the detail wants it every time they open the board.
  (function () {
    var VIEW_KEY = 'scs2-tab-view';
    var card = document.querySelector('[data-view-card]');
    var buttons = document.querySelectorAll('.tab-view button');
    if (!card || !buttons.length) return;
    function set(view, keep) {
      card.classList.toggle('is-full', view === 'full');
      Array.prototype.forEach.call(buttons, function (b) {
        b.setAttribute('aria-pressed', b.getAttribute('data-view') === view ? 'true' : 'false');
      });
      if (keep) { try { localStorage.setItem(VIEW_KEY, view); } catch (err) { /* not kept */ } }
    }
    var start = 'compact';
    try { if (localStorage.getItem(VIEW_KEY) === 'full') start = 'full'; } catch (err) { /* default */ }
    set(start, false);
    Array.prototype.forEach.call(buttons, function (b) {
      b.addEventListener('click', function () { set(b.getAttribute('data-view'), true); });
      if (scs.hapticTap) scs.hapticTap(b);
    });
  })();

  // the pulsing placeholders hand over to the real content (a no-op on
  // every call after the first)
  function reveal() {
    Array.prototype.forEach.call(document.querySelectorAll('.t-skel'), function (el) {
      el.classList.add('is-revealed');
    });
  }

  var lastPaint = null;

  // Every time in the last-scored column comes out of scs.fmtTime, so
  // the settings menu's Hide dates rocker changes all of them at once —
  // and this page only redraws on its own 30-second refresh, so it is
  // told to.
  document.addEventListener('scs-dates-changed', function () {
    if (lastPaint) paintTab(lastPaint.lb, lastPaint.stats, true);
  });

  // what the table was last drawn from
  var lastDrawn = '';

  function paintTab(lb, stats, force) {
    lastPaint = { lb: lb, stats: stats };
    if (setClosed(!!lb.closed)) { reveal(); return; }
    setFrozen(lb.frozen ? lb : null);
    // the same answer as last time leaves the page alone; while frozen
    // it is the same answer every time
    var drawn = JSON.stringify([lb.teams, stats.total_completions, stats.total_points, stats.submissions_pending]);
    if (!force && drawn === lastDrawn) return;
    lastDrawn = drawn;
    renderTable(lb.teams || []);
    setStat('tab-completions', fmt(stats.total_completions));
    setStat('tab-points', fmt(stats.total_points));
    // no team count in the totals row: the last place in the column
    // above it is the number of teams, and the page says it once
    setWaiting(stats.submissions_pending);
    reveal();
  }

  // What the tab is not showing yet. An older kept copy has no count in
  // it, so the line stays away rather than claiming nothing is waiting.
  function setWaiting(n) {
    if (!waitingEl) return;
    var count = Number(n);
    if (!isFinite(count) || count <= 0) {
      waitingEl.classList.add('is-hidden');
      waitingEl.textContent = '';
      return;
    }
    // the icon is drawn, not a character, so it keeps its weight at
    // every stop on the text-size ladder and in both themes
    waitingEl.textContent = '';
    var mark = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    mark.setAttribute('class', 'tab-waiting-mark');
    mark.setAttribute('viewBox', '0 0 24 24');
    mark.setAttribute('fill', 'none');
    mark.setAttribute('stroke', 'currentColor');
    mark.setAttribute('stroke-width', '2');
    mark.setAttribute('stroke-linecap', 'round');
    mark.setAttribute('aria-hidden', 'true');
    mark.innerHTML = '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 7.6v.4"/>';
    var words = document.createElement('span');
    words.textContent = count === 1
      ? '1 submission is waiting for review and is not included on the tab.'
      : fmt(count) + ' submissions are waiting for review and are not included on the tab.';
    waitingEl.appendChild(mark);
    waitingEl.appendChild(words);
    waitingEl.classList.remove('is-hidden');
  }

  // What went wrong, and what the reader is looking at. With a kept
  // copy on screen there is a board to explain; on a first visit there
  // is not, and that is a different sentence.
  function showError() {
    // closed, the sign is the copy kept and there are no standings to explain
    if (!errorEl || closedNow) return;
    var showing = haveBoard();
    var text = showing
      ? 'The last refresh failed. These standings are the copy saved on this device. The page tries again every 10 seconds.'
      : 'The tab did not answer, so there are no standings to show yet. The page tries again every 10 seconds.';
    if (errorTextEl) errorTextEl.textContent = text;
    if (!showing) {
      // nothing is loading any more: the empty board stands behind the
      // message rather than a skeleton that will never fill
      reveal();
      // the line above the table dates the copy on screen; with no copy
      // it has nothing to date, and the message right above it already
      // says there are no standings. It stays in the layout — its
      // bottom margin is the air between the message and the table.
      if (updatedEl) updatedEl.textContent = '';
    }
    if (errorEl.classList.contains('is-hidden')) {
      errorEl.classList.remove('is-hidden');
      scs.rise(errorEl);
    }
  }

  // The refresh arrow turns for the last second before each refresh and
  // stops when it lands, at the end of a turn.
  var updatedLine = updatedEl && updatedEl.parentNode;
  var refreshIcon = updatedLine && updatedLine.querySelector('.ic-refresh');
  var spinTimer = null;
  function startSpin() {
    if (!updatedLine || frozenNow || closedNow || scs.reducedMotion) return;
    updatedLine.classList.add('is-refreshing');
  }
  function stopSpin() {
    if (!updatedLine || !updatedLine.classList.contains('is-refreshing')) return;
    var settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      refreshIcon.removeEventListener('animationiteration', settle);
      updatedLine.classList.remove('is-refreshing');
    }
    refreshIcon.addEventListener('animationiteration', settle);
    window.setTimeout(settle, 1000);
  }

  // the board and the totals in one read; `no-cache` has the browser send
  // back the tag of its copy, so an unchanged board is a 304 with no body
  function readBoard() {
    return scs.fetch(API + '/api/tab', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('tab ' + r.status);
      return r.json().then(function (d) {
        if (!d || !d.leaderboard || !d.stats) throw new Error('tab shape');
        return [d.leaderboard, d.stats];
      });
    });
  }

  // The interval, a return to the page, Retry and the first load can
  // each have a read in flight, and each read tries again on its own, so
  // they land in any order: only an answer newer than the one drawn is
  // drawn or kept.
  var readsAsked = 0;
  var readDrawn = 0;
  function refreshTab() {
    if (!window.fetch) return Promise.resolve();
    var asked = ++readsAsked;
    window.clearTimeout(spinTimer);
    spinTimer = window.setTimeout(startSpin, REFRESH_MS - 1000);
    return readBoard().then(function (results) {
      if (asked < readDrawn) return;
      readDrawn = asked;
      paintTab(results[0], results[1]);
      // the copy the next visit opens on, before its own refresh lands
      try {
        localStorage.setItem(TAB_CACHE_KEY, JSON.stringify({ lb: results[0], stats: results[1], at: Date.now() }));
      } catch (err) { /* not kept */ }
      lastGoodAt = Date.now();
      // fresh data: the line swaps in; the seconds then tick quietly
      if (!frozenNow && !closedNow) scs.swapText(updatedEl, 'Updated just now');
      if (errorEl) errorEl.classList.add('is-hidden');
    }).catch(function () {
      // a newer read has already answered
      if (asked < readDrawn) return;
      showError();
    }).then(stopSpin);
  }

  // ---------------- Closed ----------------
  // The organisers can shut the tab altogether: the worker answers that
  // it is closed and nothing else, and the board gives way to a sign.
  // The kept copy is that answer too, so the next visit opens on the
  // sign rather than on standings from before it closed.
  var closedNow = false;
  function setClosed(on) {
    if (on === closedNow) return on;
    closedNow = on;
    document.documentElement.classList.toggle('tab-closed', on);
    syncShare();
    if (on) {
      setFrozen(null);
      if (updatedEl) updatedEl.textContent = '';
      if (errorEl) errorEl.classList.add('is-hidden');
    }
    return on;
  }

  // ---------------- The freeze ----------------
  // Partway through the day the tab stops in public. The worker sends
  // the standings as they were; the page frosts over from its edges,
  // icicles hang off the top bar, snow falls, and the line under the
  // title says when it stopped.
  var frozenNow = false;
  var frozenAt = '';

  function setFrozen(info) {
    var on = !!info;
    if (on && info.frozen_at) frozenAt = info.frozen_at;
    if (on === frozenNow) {
      if (on) sayFrozen();
      return;
    }
    frozenNow = on;
    document.documentElement.classList.toggle('tab-frozen', on);
    if (on) { Ice.start(); sayFrozen(); } else { Ice.stop(); }
  }

  function sayFrozen() {
    if (!updatedEl || !frozenAt) return;
    var line = 'Standings as of ' + scs.fmtTime(frozenAt);
    if (updatedEl.textContent !== line) updatedEl.textContent = line;
  }

  // The frost, the icicles and the snow. Drawn rather than fetched, so
  // they cost nothing, follow the theme and fit any screen.
  var Ice = (function () {
    var layer = null;
    var frost = null;
    var snow = null;
    var icicles = null;
    var flakes = [];
    var raf = 0;
    var lastT = 0;
    var size = '';
    var themeWatch = null;
    var still = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

    function dark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }

    // the same frost every time for a given screen, so a resize does
    // not reshuffle it in front of the reader
    function seeded(n) {
      return function () {
        n = (n * 16807) % 2147483647;
        return (n - 1) / 2147483646;
      };
    }

    function canvas(cls) {
      var c = document.createElement('canvas');
      c.className = cls;
      return c;
    }

    function fit(c) {
      var dpr = Math.min(2, window.devicePixelRatio || 1);
      c.width = Math.round(window.innerWidth * dpr);
      c.height = Math.round(window.innerHeight * dpr);
      var ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return ctx;
    }

    // Crystals grow in from the frame at the angles ice grows at: a
    // dense rime along the very edge, feathered arms reaching in from
    // it, and faint frost flowers across the rest of the glass, the
    // middle kept light enough to read the standings through.
    function drawFrost() {
      var ctx = fit(frost);
      var w = window.innerWidth;
      var h = window.innerHeight;
      var rand = seeded(97);
      var isDark = dark();
      ctx.clearRect(0, 0, w, h);
      ctx.lineCap = 'round';
      slab(ctx, w, h, rand, isDark);
      var reach = Math.max(44, Math.min(w, h) * (w < 600 ? 0.1 : 0.15));
      var ink = isDark ? '235, 245, 252' : '255, 255, 255';
      var strength = isDark ? 0.6 : 0.95;
      function line(x1, y1, x2, y2, width, alpha) {
        if (alpha <= 0.02) return;
        ctx.strokeStyle = 'rgba(' + ink + ', ' + Math.min(1, alpha).toFixed(3) + ')';
        ctx.lineWidth = width;
        ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      }
      function fade(x, y) { return Math.max(0, 1 - Math.min(x, y, w - x, h - y) / reach); }
      // an arm with short side shoots at sixty degrees, like a fern of ice
      function arm(x, y, a, len, depth, alphaOf) {
        if (len < 2.5 || depth > 2) return;
        var x2 = x + Math.cos(a) * len;
        var y2 = y + Math.sin(a) * len;
        line(x, y, x2, y2, Math.max(0.6, 1.5 - depth * 0.4), alphaOf((x + x2) / 2, (y + y2) / 2));
        if (depth < 2) {
          for (var k = 1; k <= 3; k++) {
            var t = k / 4;
            var px = x + (x2 - x) * t;
            var py = y + (y2 - y) * t;
            var side = len * 0.34 * (1 - t * 0.6);
            arm(px, py, a + Math.PI / 3, side, depth + 1, alphaOf);
            arm(px, py, a - Math.PI / 3, side, depth + 1, alphaOf);
          }
        }
        if (depth === 0) arm(x2, y2, a + (rand() - 0.5) * 0.3, len * 0.6, 1, alphaOf);
      }
      function edgePoint() {
        var e = rand() * (2 * w + 2 * h);
        if (e < w) return [e, 0, Math.PI / 2];
        if (e < 2 * w) return [e - w, h, -Math.PI / 2];
        if (e < 2 * w + h) return [0, e - 2 * w, 0];
        return [w, e - 2 * w - h, Math.PI];
      }
      var atEdge = function (x, y) { return strength * fade(x, y); };
      // the rime: many small stars hugging the frame
      var rime = Math.round((w + h) / 3);
      for (var r = 0; r < rime; r++) {
        var pr = edgePoint();
        var inward = rand() * rand() * reach * 0.6;
        var rx = pr[0] + Math.cos(pr[2]) * inward;
        var ry = pr[1] + Math.sin(pr[2]) * inward;
        var size = 1.5 + rand() * 4;
        var turn = rand() * Math.PI;
        for (var s3 = 0; s3 < 3; s3++) {
          var ra = turn + s3 * Math.PI / 3;
          line(rx - Math.cos(ra) * size, ry - Math.sin(ra) * size, rx + Math.cos(ra) * size, ry + Math.sin(ra) * size, 0.7, atEdge(rx, ry) * 0.85);
        }
      }
      // the arms reaching in, longer toward the corners
      var seeds = Math.round((w + h) / 16);
      for (var i = 0; i < seeds; i++) {
        var pt = edgePoint();
        var cx = Math.min(pt[0], w - pt[0]) / (w / 2);
        var cy = Math.min(pt[1], h - pt[1]) / (h / 2);
        var corner = 1 - Math.min(cx, cy);
        var len = reach * (0.3 + 0.4 * rand() + 0.5 * corner) * 0.62;
        arm(pt[0], pt[1], pt[2] + (rand() - 0.5) * 1.2, len, 0, atEdge);
      }
      // frost flowers over the rest of the glass, faint enough to read through
      var flowers = Math.round(w * h / 7000);
      var faint = isDark ? 0.2 : 0.42;
      for (var f = 0; f < flowers; f++) {
        var fx = rand() * w;
        var fy = rand() * h;
        var arms = rand() < 0.35 ? 6 : 3;
        var fl = 3 + rand() * rand() * 14;
        var spin = rand() * Math.PI * 2;
        var alpha = faint * (0.4 + rand() * 0.6);
        for (var q = 0; q < arms; q++) {
          arm(fx, fy, spin + q * Math.PI * 2 / arms, fl, 1, function () { return alpha; });
        }
      }
    }

    // The face of the slab: light catching it in broad diagonal bands,
    // and a few long fractures running through it, each a bright edge
    // with a darker one beside it, as a crack inside clear ice reads.
    function slab(ctx, w, h, rand, isDark) {
      var bands = w < 600 ? 2 : 3;
      for (var b = 0; b < bands; b++) {
        var at = (b + 0.3 + rand() * 0.4) / bands;
        var bw = Math.max(w, h) * (0.06 + rand() * 0.08);
        var cx = w * at;
        var tilt = h * 0.55;
        var g = ctx.createLinearGradient(cx - bw, 0, cx + bw, 0);
        var peak = isDark ? 0.05 : 0.22;
        g.addColorStop(0, 'rgba(255, 255, 255, 0)');
        g.addColorStop(0.5, 'rgba(255, 255, 255, ' + peak + ')');
        g.addColorStop(1, 'rgba(255, 255, 255, 0)');
        ctx.save();
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(cx - bw + tilt, 0);
        ctx.lineTo(cx + bw + tilt, 0);
        ctx.lineTo(cx + bw - tilt, h);
        ctx.lineTo(cx - bw - tilt, h);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
      var lightInk = isDark ? 'rgba(225, 240, 250, 0.32)' : 'rgba(255, 255, 255, 0.85)';
      var darkInk = isDark ? 'rgba(10, 30, 45, 0.35)' : 'rgba(95, 145, 180, 0.32)';
      // straight runs with sharp turns between them, as ice splits
      function crack(x, y, a, len, width, depth) {
        var pts = [[x, y]];
        var steps = Math.max(2, Math.round(len / 90));
        for (var s = 0; s < steps; s++) {
          a += (rand() - 0.5) * 0.5;
          x += Math.cos(a) * len / steps;
          y += Math.sin(a) * len / steps;
          pts.push([x, y]);
          if (depth < 1 && rand() < 0.45) crack(x, y, a + (rand() < 0.5 ? 1 : -1) * (0.6 + rand() * 0.5), len * (0.2 + rand() * 0.2), width * 0.75, depth + 1);
        }
        [[darkInk, 1, 1], [lightInk, 0, 0]].forEach(function (pass) {
          ctx.strokeStyle = pass[0];
          ctx.lineWidth = width;
          ctx.beginPath();
          ctx.moveTo(pts[0][0] + pass[1], pts[0][1] + pass[2]);
          for (var p = 1; p < pts.length; p++) ctx.lineTo(pts[p][0] + pass[1], pts[p][1] + pass[2]);
          ctx.stroke();
        });
      }
      var cracks = w < 600 ? 2 : 3;
      for (var c = 0; c < cracks; c++) {
        var fromLeft = rand() < 0.5;
        var sx = fromLeft ? rand() * w * 0.3 : w - rand() * w * 0.3;
        var sy = rand() * h;
        var dir = (fromLeft ? 0 : Math.PI) + (rand() - 0.5) * 1.4;
        crack(sx, sy, dir, Math.min(w, h) * (0.4 + rand() * 0.35), 1.2, 0);
      }
    }

    // A ledge of snow along the bottom of the top bar with icicles
    // hanging from it, inside the bar so they go where it goes. Shaded
    // rather than outlined: a light face and a darker side.
    function hang() {
      var nav = document.querySelector('.site-nav');
      if (icicles && icicles.parentNode) icicles.parentNode.removeChild(icicles);
      if (!nav) return;
      var w = window.innerWidth;
      var rand = seeded(31);
      var ice = '';
      var shade = '';
      var shine = '';
      var x = -4;
      while (x < w) {
        var base = 10 + rand() * 16;
        var long = rand() < 0.2;
        var len = base * (long ? 2.4 + rand() * 1.4 : 0.7 + rand() * 1.1);
        var tipX = x + base * (0.42 + rand() * 0.16);
        var top = 3;
        ice += 'M' + x.toFixed(1) + ' ' + top + 'C' + (x + base * 0.12).toFixed(1) + ' ' + (len * 0.45).toFixed(1) + ' ' +
          (tipX - base * 0.12).toFixed(1) + ' ' + (len * 0.8).toFixed(1) + ' ' + tipX.toFixed(1) + ' ' + len.toFixed(1) +
          'C' + (tipX + base * 0.1).toFixed(1) + ' ' + (len * 0.75).toFixed(1) + ' ' + (x + base * 0.9).toFixed(1) + ' ' + (len * 0.4).toFixed(1) + ' ' +
          (x + base).toFixed(1) + ' ' + top + 'Z';
        shade += 'M' + (x + base * 0.58).toFixed(1) + ' ' + top + 'C' + (x + base * 0.6).toFixed(1) + ' ' + (len * 0.5).toFixed(1) + ' ' +
          (tipX + base * 0.02).toFixed(1) + ' ' + (len * 0.85).toFixed(1) + ' ' + tipX.toFixed(1) + ' ' + len.toFixed(1) +
          'C' + (tipX + base * 0.1).toFixed(1) + ' ' + (len * 0.75).toFixed(1) + ' ' + (x + base * 0.9).toFixed(1) + ' ' + (len * 0.4).toFixed(1) + ' ' +
          (x + base).toFixed(1) + ' ' + top + 'Z';
        shine += 'M' + (x + base * 0.2).toFixed(1) + ' ' + (top + 2) + 'Q' + (x + base * 0.26).toFixed(1) + ' ' + (len * 0.45).toFixed(1) + ' ' +
          (tipX - base * 0.06).toFixed(1) + ' ' + (len * 0.82).toFixed(1) + 'Q' + (x + base * 0.36).toFixed(1) + ' ' + (len * 0.42).toFixed(1) + ' ' +
          (x + base * 0.34).toFixed(1) + ' ' + (top + 2) + 'Z';
        x += base * (0.75 + rand() * 0.5);
      }
      // the ledge itself: a soft, uneven bank of snow
      var snowEdge = 'M0 0H' + w + 'V5';
      var sx = w;
      while (sx > 0) {
        var step = 18 + rand() * 30;
        var nx = Math.max(0, sx - step);
        snowEdge += 'Q' + ((sx + nx) / 2).toFixed(1) + ' ' + (7 + rand() * 7).toFixed(1) + ' ' + nx.toFixed(1) + ' ' + (4 + rand() * 3).toFixed(1);
        sx = nx;
      }
      snowEdge += 'Z';
      icicles = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      icicles.setAttribute('class', 'tab-icicles');
      icicles.setAttribute('aria-hidden', 'true');
      icicles.setAttribute('viewBox', '0 0 ' + w + ' 72');
      icicles.setAttribute('preserveAspectRatio', 'xMidYMin slice');
      icicles.innerHTML = '<path class="tab-icicle" d="' + ice + '"/><path class="tab-icicle-shade" d="' + shade + '"/>' +
        '<path class="tab-icicle-shine" d="' + shine + '"/><path class="tab-snowbank" d="' + snowEdge + '"/>';
      nav.appendChild(icicles);
    }

    function makeFlakes() {
      var w = window.innerWidth;
      var h = window.innerHeight;
      var rand = seeded(5);
      var n = Math.max(30, Math.min(160, Math.round(w * h / 9000)));
      flakes = [];
      for (var i = 0; i < n; i++) {
        var r = 0.8 + rand() * rand() * 4;
        flakes.push({ x: rand() * w, y: rand() * h, r: r, vy: 12 + r * 10 + rand() * 10, sway: 8 + rand() * 22, phase: rand() * 6.28, spin: rand() * 6.28 });
      }
    }

    function drawFlake(ctx, x, y, r, turn) {
      ctx.beginPath();
      for (var k = 0; k < 6; k++) {
        var a = turn + k * Math.PI / 3;
        var ex = x + Math.cos(a) * r * 1.7;
        var ey = y + Math.sin(a) * r * 1.7;
        ctx.moveTo(x, y);
        ctx.lineTo(ex, ey);
        var mx = x + Math.cos(a) * r * 1.05;
        var my = y + Math.sin(a) * r * 1.05;
        ctx.moveTo(mx + Math.cos(a + 0.9) * r * 0.55, my + Math.sin(a + 0.9) * r * 0.55);
        ctx.lineTo(mx, my);
        ctx.lineTo(mx + Math.cos(a - 0.9) * r * 0.55, my + Math.sin(a - 0.9) * r * 0.55);
      }
      ctx.stroke();
    }

    function drawSnow(t) {
      var ctx = snow.getContext('2d');
      var w = window.innerWidth;
      var h = window.innerHeight;
      var dt = lastT ? Math.min(0.05, (t - lastT) / 1000) : 0;
      lastT = t;
      ctx.clearRect(0, 0, w, h);
      var isDark = dark();
      ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.9)' : 'rgba(255, 255, 255, 0.95)';
      ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.85)' : 'rgba(110, 160, 195, 0.9)';
      ctx.lineCap = 'round';
      for (var i = 0; i < flakes.length; i++) {
        var f = flakes[i];
        f.y += f.vy * dt;
        f.phase += dt * 0.8;
        if (f.y > h + 8) { f.y = -8; }
        var x = f.x + Math.sin(f.phase) * f.sway;
        if (f.r > 2.6) {
          ctx.lineWidth = 1;
          drawFlake(ctx, x, f.y, f.r, f.spin + f.phase * 0.25);
        } else {
          ctx.beginPath();
          ctx.arc(x, f.y, f.r, 0, Math.PI * 2);
          ctx.fill();
          if (!isDark) { ctx.lineWidth = 0.5; ctx.stroke(); }
        }
      }
      raf = window.requestAnimationFrame(drawSnow);
    }

    function resize() {
      var now = window.innerWidth + 'x' + window.innerHeight;
      if (!layer || now === size) return;
      size = now;
      drawFrost();
      hang();
      if (snow) { fit(snow); makeFlakes(); }
    }

    function visible() {
      if (!snow) return;
      window.cancelAnimationFrame(raf);
      lastT = 0;
      if (!document.hidden) raf = window.requestAnimationFrame(drawSnow);
    }

    function start() {
      if (layer) return;
      layer = document.createElement('div');
      layer.id = 'tab-ice';
      layer.className = 'tab-ice';
      layer.setAttribute('aria-hidden', 'true');
      frost = canvas('tab-frost');
      layer.appendChild(frost);
      if (!still) { snow = canvas('tab-snow'); layer.appendChild(snow); }
      document.body.appendChild(layer);
      size = '';
      resize();
      visible();
      window.addEventListener('resize', resize);
      document.addEventListener('visibilitychange', visible);
      // a theme change repaints the frost in the other theme's colours
      if (typeof MutationObserver === 'function') {
        themeWatch = new MutationObserver(redraw);
        themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      }
    }

    function redraw() { if (layer) { size = ''; resize(); } }

    function stop() {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', visible);
      if (themeWatch) { themeWatch.disconnect(); themeWatch = null; }
      if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
      if (icicles && icicles.parentNode) icicles.parentNode.removeChild(icicles);
      layer = frost = snow = icicles = null;
    }

    return { start: start, stop: stop };
  })();

  // "updated 12s ago", ticking along between refreshes
  window.setInterval(function () {
    if (!updatedEl) return;
    if (lastGoodAt === null) return;
    var secs = Math.max(0, Math.round((Date.now() - lastGoodAt) / 1000));
    if (frozenNow || closedNow) return; // nothing is updating; the stamp says so
    if (secs >= 4) {
      updatedEl.textContent = secs < 90
        ? 'Updated ' + secs + 's ago'
        : 'Updated ' + Math.round(secs / 60) + ' min ago'; // a table painted from the kept copy can be old
    }
  }, 1000);

  // The after-the-event switches are asked again now and then, so a tab
  // left open sees them go on without a reload.
  var FLAGS_EVERY = 6; // refreshes, a minute
  var sinceFlags = 0;
  window.setInterval(function () {
    if (document.hidden) return;
    refreshTab();
    sinceFlags += 1;
    if (sinceFlags < FLAGS_EVERY) return;
    sinceFlags = 0;
    scs.pulse(true);
  }, REFRESH_MS);
  // every fresh pulse, this page's and the chrome's after a while away
  window.addEventListener('scs-pulse', function (e) { applyFlags(e.detail); });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshTab();
  });

  // bad signal on first load: a hand-cranked retry
  var retryBtn = document.getElementById('tab-retry');
  if (retryBtn) {
    retryBtn.addEventListener('click', function () {
      retryBtn.disabled = true;
      retryBtn.textContent = 'Retrying…';
      Promise.resolve(refreshTab()).then(function () {
        retryBtn.disabled = false;
        retryBtn.textContent = 'Retry';
      });
    });
  }

  // The last good table paints at once from the copy this device
  // kept, so a return visit never opens onto the skeleton; the
  // network refresh lands behind it and the rows glide into their
  // new places. The "updated" ticker says how old the copy is.
  try {
    var savedTab = JSON.parse(localStorage.getItem(TAB_CACHE_KEY) || 'null');
    if (savedTab && savedTab.lb && savedTab.stats) {
      paintTab(savedTab.lb, savedTab.stats);
      lastGoodAt = Number(savedTab.at) || null;
      if (updatedEl && lastGoodAt && !frozenNow && !closedNow) {
        var oldSecs = Math.max(0, Math.round((Date.now() - lastGoodAt) / 1000));
        updatedEl.textContent = oldSecs < 90
          ? 'Updated ' + oldSecs + 's ago'
          : 'Updated ' + Math.round(oldSecs / 60) + ' min ago';
      }
    }
  } catch (err) { /* first visit */ }

  refreshTab();
})();
