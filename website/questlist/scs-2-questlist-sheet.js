// The quest page's script, part two of five: the quest sheet — its codes,
// files, question and standings, opening and closing, its stops and drag.
(window.scsQuestList = window.scsQuestList || { parts: [] }).parts.push(function (ql) {
  'use strict';

  // from the parts before this one
  var state = ql.state;
  var isDone = ql.isDone;
  var tickedCodes = ql.tickedCodes;
  var doneCount = ql.doneCount;
  var setDone = ql.setDone;
  var toggleCode = ql.toggleCode;
  var setCount = ql.setCount;
  var clearDone = ql.clearDone;
  var stopFlashCodes = ql.stopFlashCodes;
  var paintRoute = ql.paintRoute;
  var regionLetter = ql.regionLetter;
  var haversineKm = ql.haversineKm;
  var questDistanceKm = ql.questDistanceKm;
  var locationText = ql.locationText;
  var pointsSummary = ql.pointsSummary;
  var listEl = ql.listEl;
  var clearQuestHighlight = ql.clearQuestHighlight;
  var highlightQuestMarkers = ql.highlightQuestMarkers;
  var drawPins = ql.drawPins;
  var TAB_API = ql.TAB_API;
  var normTabCode = ql.normTabCode;
  var fetchTabStats = ql.fetchTabStats;

  // functions the other parts call
  ql.glideSheetHeight = glideSheetHeight;
  ql.renderDetailCodes = renderDetailCodes;
  ql.openDetail = openDetail;
  ql.isSheet = isSheet;
  ql.syncPop = syncPop;
  ql.closeDetail = closeDetail;
  ql.sheetStop = sheetStop;
  ql.frameAboveCard = frameAboveCard;
  ql.updateDetailDoneButton = updateDetailDoneButton;

  // The sheet's one height animator. Cancels any glide already running,
  // measures the current visual height (mid-animation included), applies
  // the change, and glides to wherever the content settles. Everything
  // that resizes the open sheet goes through here — a second change
  // mid-flight (like the teams line arriving late) re-targets smoothly
  // instead of fighting the first and bouncing.
  var sheetHeightAnim = null;
  var sheetGestureActive = false;   // a finger is on the sheet right now
  var pendingSheetChanges = [];     // resizes that arrived mid-gesture, in order

  function cancelSheetGlide() {
    if (sheetHeightAnim) {
      try { sheetHeightAnim.cancel(); } catch (err) {}
      sheetHeightAnim = null;
    }
  }

  function glideSheetHeight(mutate) {
    // Content that lands while the sheet is already moving must not
    // start a second animation against the first. Under a finger the
    // box would animate its height against the drag and lag behind its
    // own text; during the opening morph the morph would be aiming at
    // a height that had already changed, landing short and then
    // growing again. Either way it waits, then glides once.
    if (sheetGestureActive || morphOpenAnim) {
      pendingSheetChanges.push(mutate);
      return;
    }
    if (!sheet || !isSheet() || overlay.classList.contains('is-hidden') ||
        morphClosing || typeof sheet.animate !== 'function' || reducedMotionMq.matches) {
      mutate();
      return;
    }
    var from = sheet.getBoundingClientRect().height;
    cancelSheetGlide();
    mutate();
    var to = sheet.getBoundingClientRect().height;
    measureCard();
    if (Math.abs(to - from) <= 1) return;
    sheetHeightAnim = sheet.animate([
      { height: from + 'px' },
      { height: to + 'px' }
    ], { duration: 240, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
    sheetHeightAnim.onfinish = sheetHeightAnim.oncancel = function () { sheetHeightAnim = null; measureCard(); };
    ql.positionMapControls();
  }

  function flushPendingSheetChanges() {
    var pending = pendingSheetChanges;
    pendingSheetChanges = [];
    if (!pending.length || overlay.classList.contains('is-hidden')) return;
    glideSheetHeight(function () {
      pending.forEach(function (mutate) { mutate(); });
    });
  }

  // The tab's codes for this quest: what each one is for and its points.
  function renderDetailCodes(quest) {
    var box = document.getElementById('ql-detail-codes');
    box.textContent = '';
    var ticked = tickedCodes(quest);
    document.getElementById('ql-detail-codes-label').textContent = 'Quest Codes & Points';
    quest.codes.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'ql-code-row';
      row.dataset.code = c.code;
      if (quest.multi && !state.noChecklist) {
        // each code ticks on its own: a tier reached, a bonus earned
        row.className += ' is-tickable' + (ticked.indexOf(c.code) !== -1 ? ' is-ticked' : '');
        var box2 = document.createElement('input');
        box2.type = 'checkbox';
        box2.checked = ticked.indexOf(c.code) !== -1;
        box2.setAttribute('aria-label', 'Tick off ' + c.code);
        box2.addEventListener('change', function () {
          stopFlashCodes();
          toggleCode(quest, c.code);
          updateDetailDoneButton(); // syncs the rows too
        });
        row.appendChild(box2);
      } else if (!quest.repeat && isDone(quest)) {
        row.className += ' is-ticked'; // the whole quest is done: struck through
      }
      var chip = document.createElement('span');
      chip.className = 'code';
      chip.textContent = c.code;
      // the label and the points sit in one box, which is what the
      // strike runs across — it starts at the words, not at the code
      var text = document.createElement('span');
      text.className = 'ql-code-text';
      var label = document.createElement('span');
      label.className = 'ql-code-label';
      label.textContent = c.label || (quest.codes.length === 1 ? quest.name : '');
      text.appendChild(label);
      // a bare figure in a column the heading already names: the pay is
      // stated once, and 'pts' after every row was the second time
      var pay = codePoints(c);
      if (pay) {
        var pts = document.createElement('span');
        pts.className = 'ql-code-pts';
        pts.textContent = pay;
        text.appendChild(pts);
      }
      row.appendChild(chip);
      row.appendChild(text);
      box.appendChild(row);
      bandRows(quest, c).forEach(function (r) { box.appendChild(r); });
    });
    renderDetailRepeat(quest);
  }

  // what a part pays, by how it is scored: its points, so much each, up
  // to so much, or nothing here when its bands say it underneath
  function codePoints(c) {
    if (c.scoring === 'tiered' || c.scoring === 'counted') return '';
    if (c.points == null) return '???';
    if (c.scoring === 'unit') return c.points + ' each';
    if (c.scoring === 'judged') return 'up to ' + c.points;
    return String(c.points);
  }
  // A tiered or counted part's bands, and a counted part's places, as
  // rows under it: what each is reached by and what it pays.
  function bandRows(quest, c) {
    var out = [];
    function add(words, value) {
      var row = document.createElement('div');
      row.className = 'ql-code-row ql-band-row' + (quest.multi && !state.noChecklist ? ' has-tick' : '');
      if (quest.multi && !state.noChecklist) row.appendChild(document.createElement('span'));
      row.appendChild(document.createElement('span'));
      var text = document.createElement('span');
      text.className = 'ql-code-text';
      var label = document.createElement('span');
      label.className = 'ql-code-label';
      label.textContent = words;
      var pts = document.createElement('span');
      pts.className = 'ql-code-pts';
      pts.textContent = value == null ? '???' : String(value);
      text.appendChild(label);
      text.appendChild(pts);
      row.appendChild(text);
      out.push(row);
    }
    if (c.scoring !== 'tiered' && c.scoring !== 'counted') return out;
    (c.bands || []).forEach(function (b) { add(b.from + ' or more', b.points); });
    if (c.scoring === 'counted') {
      (quest.places || []).forEach(function (p, i) { if (p == null || p > 0) add(ordinalOf(i + 1) + ' place', p); });
    }
    return out;
  }
  function ordinalOf(n) {
    var tail = n % 100;
    if (tail >= 11 && tail <= 13) return n + 'th';
    return n + (n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th');
  }

  // The rows follow the tally in place, without a rebuild, so the
  // strike-through can draw itself across a row that just got ticked
  // (and pull back off one that got un-ticked).
  function syncDetailCodes(quest) {
    var box = document.getElementById('ql-detail-codes');
    if (!box) return;
    var ticked = quest.multi ? tickedCodes(quest) : null;
    var wholeDone = !quest.multi && !quest.repeat && isDone(quest);
    var rows = box.querySelectorAll('.ql-code-row');
    for (var i = 0; i < rows.length; i++) {
      var on = quest.multi ? ticked.indexOf(rows[i].dataset.code) !== -1 : wholeDone;
      rows[i].classList.toggle('is-ticked', on);
      var input = rows[i].querySelector('input');
      if (input) input.checked = on;
    }
  }

  // per-unit quests get a counter instead of one tick
  function renderDetailRepeat(quest) {
    var box = document.getElementById('ql-detail-repeat');
    box.classList.toggle('is-hidden', !quest.repeat);
    if (!quest.repeat) return;
    // The count counts, and nothing else. What the quest pays is in the
    // codes table above it; a running total here said it twice.
    var n = doneCount(quest);
    var count = document.getElementById('ql-repeat-count');
    count.textContent = '';
    if (n === 0) {
      count.textContent = 'Not done yet';
    } else {
      var num = document.createElement('b');
      num.textContent = String(n);
      count.appendChild(num);
      count.appendChild(document.createTextNode(n === 1 ? ' time' : ' times'));
    }
    document.getElementById('ql-repeat-minus').disabled = n === 0;
  }
  document.getElementById('ql-repeat-plus').addEventListener('click', function () {
    if (!state.activeQuest) return;
    stopFlashCodes();
    setCount(state.activeQuest, doneCount(state.activeQuest) + 1);
    renderDetailRepeat(state.activeQuest);
    updateDetailDoneButton();
  });
  document.getElementById('ql-repeat-minus').addEventListener('click', function () {
    if (!state.activeQuest) return;
    stopFlashCodes();
    setCount(state.activeQuest, doneCount(state.activeQuest) - 1);
    renderDetailRepeat(state.activeQuest);
    updateDetailDoneButton();
  });

  // The line keeps its place from the moment the sheet opens (a grey
  // bar while the tab answers), so the answer never resizes the sheet
  // mid-gesture. With nothing to say it is a dash: a label beside an
  // empty value read as something that had failed to draw.
  function renderDetailTeams(quest) {
    var el = document.getElementById('ql-detail-teams');
    if (!el) return;
    el.textContent = '';
    el.classList.remove('is-hidden');
    el.classList.add('is-loading');
    fetchTabStats().then(function (stats) {
      if (state.activeQuest !== quest) return; // another sheet opened meanwhile
      // teams with any of the quest's codes on the tab, or the lead code alone
      var done = stats.byGroup[normTabCode(quest.id)];
      if (done === undefined) done = stats.byCode[normTabCode(quest.codes[0].code)];
      el.classList.remove('is-loading');
      el.textContent = done === undefined ? '\u2014' : done + ' of ' + stats.total + ' teams';
    }).catch(function () {
      if (state.activeQuest !== quest) return;
      el.classList.remove('is-loading');
      el.textContent = '\u2014';
    });
  }

  // ---------- Files hung on a quest ----------
  // Organisers can attach pictures (the thing to find, a map, a photo
  // to name) and PDFs. Pictures show as small copies in a grid and a
  // tap opens the full set in place; anything else is a row to open.
  // Every picture cell is the same size before and after the picture
  // lands, so a slow load never resizes the sheet under a finger.
  function questFileUrl(key) {
    return TAB_API + '/api/quests/file?key=' + encodeURIComponent(key);
  }

  function fileSizeText(n) {
    n = Number(n);
    if (!isFinite(n) || n <= 0) return '';
    if (n > 1024 * 1024) return (Math.round(n / (1024 * 1024) * 10) / 10) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function isImageFile(file) {
    return String(file && file.type || '').indexOf('image/') === 0;
  }

  function renderDetailFiles(quest) {
    var box = document.getElementById('ql-detail-files');
    if (!box) return;
    box.textContent = '';
    var files = quest.files || [];
    box.classList.toggle('is-hidden', !files.length);
    if (!files.length) return;
    var shots = files.filter(isImageFile);
    var rest = files.filter(function (f) { return !isImageFile(f); });

    // named in the same label voice as the rows above it, so it reads as
    // the last row of the quest's table rather than a new block
    var tag = document.createElement('span');
    tag.className = 'ql-fact-k ql-files-label';
    tag.innerHTML = '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="m20.5 11.5-8.4 8.4a5.4 5.4 0 0 1-7.6-7.6l8.6-8.6a3.6 3.6 0 0 1 5.1 5.1l-8.6 8.6a1.8 1.8 0 0 1-2.55-2.55l7.9-7.9"/></svg>Attached';
    box.appendChild(tag);
    var hold = document.createElement('div');
    hold.className = 'ql-files-body';
    box.appendChild(hold);

    if (shots.length) {
      // the full-size pictures, in the order they are shown
      var viewItems = shots.map(function (f) {
        return { url: questFileUrl(f.key), type: f.type, name: f.name || '' };
      });
      var grid = document.createElement('div');
      grid.className = 'ql-file-shots';
      shots.forEach(function (f, i) {
        var open = document.createElement('button');
        open.type = 'button';
        open.className = 'ql-file-shot';
        var img = document.createElement('img');
        img.crossOrigin = 'anonymous'; // readable to the worker, so it can keep a copy
        img.alt = f.name || quest.name;
        open.appendChild(img);
        // the sheet scrolls by itself, which the page's observer cannot see into
        window.scs.keepPicture(img, questFileUrl(f.key) + '&thumb=1', { near: false });
        open.addEventListener('click', function () { window.scs.lightbox(viewItems, i, img); });
        grid.appendChild(open);
      });
      hold.appendChild(grid);
    }

    if (rest.length) {
      var list = document.createElement('ul');
      list.className = 'ql-file-list';
      rest.forEach(function (f) {
        var row = document.createElement('li');
        var link = document.createElement('a');
        link.href = questFileUrl(f.key);
        link.textContent = f.name || 'Attachment';
        row.appendChild(link);
        var size = fileSizeText(f.bytes);
        if (size) {
          var bytes = document.createElement('span');
          bytes.className = 'ql-file-size';
          bytes.textContent = size;
          row.appendChild(bytes);
        }
        list.appendChild(row);
      });
      hold.appendChild(list);
    }
  }

  // ---------- The question a quest is asking right now ----------
  // Organisers can put one question on a quest while the day runs:
  // buttons to pick from, a typed answer, a sealed number, or points
  // wagered on one of several options. The answer belongs to the team,
  // so it needs the submit page's session — with none, the box says
  // where to sign in and sends nothing. The quest list this device
  // reads from can be an old copy, so what the worker answers about
  // the question always wins over what the list said.
  var SUBMIT_SESSION_KEY = 'scs2-submit-session';
  var ASK_SIGN_IN = 'Sign in first on the submit page to answer.';
  var ASK_CLOSED = 'Responses are closed.';
  var ASK_FAILED = 'An error occurred. Try again.';
  var askBox = document.getElementById('ql-detail-ask');
  var ask = null; // the question box on screen, or null
  // how often an open question that shows its answers asks for them again
  var ASK_RESULTS_MS = 20000;
  var askTimer = 0;

  function submitSession() {
    try { return localStorage.getItem(SUBMIT_SESSION_KEY) || ''; } catch (err) { return ''; }
  }

  // what the team has on record, said plainly
  function recordedText(kind, choice, amount) {
    if (kind === 'wager') return 'Recorded: ' + amount + ' points on ' + choice + '.';
    if (kind === 'number') return 'Recorded: ' + amount + '.';
    if (kind === 'text') return 'Recorded: "' + choice + '".';
    return 'Recorded: ' + choice + '.';
  }

  // one team's answer in the list of every answer
  function answerText(kind, a) {
    if (kind === 'wager') return a.amount + ' points on ' + a.choice;
    if (kind === 'number') return String(a.amount);
    return a.choice;
  }

  // a name with its marks after it, which wrap under it rather than
  // breaking it
  function askName(className, text, marks) {
    var cell = document.createElement('span');
    cell.className = className;
    var words = document.createElement('span');
    words.textContent = text;
    cell.appendChild(words);
    marks.forEach(function (m) {
      var mark = document.createElement('span');
      mark.className = 'ql-ask-mark';
      mark.textContent = m;
      cell.appendChild(mark);
    });
    return cell;
  }

  // What the other teams answered, when the question shows it: how many
  // answered, a bar per option, and every team's answer when it shows
  // those too. The worker marks this team's own answer as `mine`.
  function paintResults(ax) {
    var el = ax.resultsEl;
    if (!el) return;
    var res = ax.results;
    var drawn = res ? JSON.stringify(res) : '';
    if (el.getAttribute('data-drawn') === drawn) return;
    el.setAttribute('data-drawn', drawn);
    el.textContent = '';
    el.classList.toggle('is-hidden', !res);
    if (!res) return;

    var total = Number(res.total) || 0;
    var head = document.createElement('p');
    head.className = 'ql-ask-total';
    head.textContent = total ? total + (total === 1 ? ' team answered' : ' teams answered') : 'No answers yet';
    el.appendChild(head);

    if (res.counts && res.counts.length) {
      var tally = document.createElement('ul');
      tally.className = 'ql-ask-tally';
      res.counts.forEach(function (c) {
        var teams = Number(c.teams) || 0;
        var row = document.createElement('li');
        row.className = 'ql-ask-bar' + (c.mine ? ' is-mine' : '');
        var marks = [];
        if (res.winner && c.choice === res.winner) marks.push('Won');
        if (c.mine) marks.push('Your answer');
        var name = askName('ql-ask-bar-name', c.choice, marks);
        var figure = document.createElement('span');
        figure.className = 'ql-ask-bar-figure';
        figure.textContent = teams + (teams === 1 ? ' team' : ' teams') +
          (ax.kind === 'wager' ? ' · ' + (Number(c.points) || 0) + ' points' : '');
        var track = document.createElement('span');
        track.className = 'ql-ask-bar-track';
        var fill = document.createElement('span');
        fill.className = 'ql-ask-bar-fill';
        fill.style.width = (total ? Math.round(teams / total * 1000) / 10 : 0) + '%';
        track.appendChild(fill);
        row.appendChild(name);
        row.appendChild(figure);
        row.appendChild(track);
        tally.appendChild(row);
      });
      el.appendChild(tally);
    }

    if (res.answers && res.answers.length) {
      var list = document.createElement('ul');
      list.className = 'ql-ask-answers';
      res.answers.forEach(function (a) {
        var row = document.createElement('li');
        if (a.mine) row.className = 'is-mine';
        var team = askName('ql-ask-team', a.team, a.mine ? ['Your team'] : []);
        var said = document.createElement('span');
        said.className = 'ql-ask-answer';
        said.textContent = answerText(ax.kind, a);
        row.appendChild(team);
        row.appendChild(said);
        list.appendChild(row);
      });
      el.appendChild(list);
    }
  }

  // While a question is open and shows its answers, they are asked for
  // again every so often, as long as its sheet is open and the page is
  // in view; coming back to the page asks at once.
  function watchResults(ax) {
    window.clearTimeout(askTimer);
    askTimer = 0;
    if (!ax.open || !ax.results) return;
    askTimer = window.setTimeout(function () {
      askTimer = 0;
      if (ask !== ax || state.activeQuest !== ax.quest || overlay.classList.contains('is-hidden')) return;
      if (document.hidden) return;
      loadAsk(ax, true);
    }, ASK_RESULTS_MS);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden || !ask || !ask.open || !ask.results) return;
    if (state.activeQuest !== ask.quest || overlay.classList.contains('is-hidden')) return;
    loadAsk(ask, true);
  });

  // the whole number in the entry box, or null when it is not one yet
  function askAmount(ax) {
    var raw = String(ax.input ? ax.input.value : '').trim();
    if (!/^\d+$/.test(raw)) return null;
    var n = parseInt(raw, 10);
    if (!isFinite(n)) return null;
    if (ax.kind === 'wager' && n < 1) return null;
    return n;
  }

  // The sign-in line carries a link, so it is built rather than set as
  // text; its words read the same either way, which is what keeps a
  // repaint from re-running the swap.
  function setAskLine(ax, text, isError) {
    var el = ax.status;
    el.classList.toggle('is-error', !!isError);
    if (text !== ASK_SIGN_IN) { window.scs.swapText(el, text); return; }
    if (el.textContent === text) return;
    el.textContent = '';
    el.appendChild(document.createTextNode('Sign in on the '));
    var link = document.createElement('a');
    link.href = '../submit/';
    link.textContent = 'submit page';
    el.appendChild(link);
    el.appendChild(document.createTextNode(' to answer.'));
    if (window.scs.reducedMotion) return;
    el.classList.add('t-swap');
    window.scs.replay(el, 'is-swapping');
  }

  // one place decides what is pressed, what is live and what the line
  // under it says
  function paintAsk(ax) {
    var live = ax.open && ax.signedIn && !ax.sending;
    // a choice is sent the moment it is tapped, so the pressed button
    // is the one on record; a wager is picked first and sent after
    var picked = ax.kind === 'wager' ? ax.pick : (ax.recorded ? ax.recorded.choice : '');
    ax.buttons.forEach(function (b) {
      b.setAttribute('aria-pressed', picked && b.getAttribute('data-option') === picked ? 'true' : 'false');
      b.disabled = !live;
    });
    if (ax.input) {
      ax.input.disabled = !live;
      var ready = ax.kind === 'text'
        ? !!ax.input.value.trim()
        : (askAmount(ax) !== null && (ax.kind !== 'wager' || !!ax.pick));
      ax.send.disabled = !live || !ready;
      ax.send.classList.toggle('is-busy', !!ax.sending);
    }
    if (ax.untilEl) {
      var showUntil = ax.open && !!ax.until;
      ax.untilEl.classList.toggle('is-hidden', !showUntil);
      // a label with its figure in ink, so the band reads label,
      // question, field rather than two sentences
      var when = showUntil ? window.scs.fmtTime(ax.until) : '';
      if (showUntil && ax.untilEl.dataset.when !== when) {
        ax.untilEl.dataset.when = when;
        ax.untilEl.textContent = 'Closes ';
        var clock = document.createElement('b');
        clock.textContent = when;
        ax.untilEl.appendChild(clock);
      }
    }
    var line = '';
    var bad = false;
    if (ax.error) { line = ax.error; bad = true; }
    else if (ax.sending) line = 'Sending\u2026';
    else if (!ax.open) line = ASK_CLOSED;
    else if (!ax.signedIn) line = ASK_SIGN_IN;
    else if (ax.recorded) line = recordedText(ax.kind, ax.recorded.choice, ax.recorded.amount);
    setAskLine(ax, line, bad);
    paintResults(ax);
  }

  // a change that may make the box taller glides the sheet with it
  function repaintAsk(ax) {
    glideSheetHeight(function () { paintAsk(ax); });
  }

  function sendAsk(ax, choice, amount) {
    var token = submitSession();
    if (!token) { ax.signedIn = false; paintAsk(ax); return; }
    ax.error = '';
    ax.sending = true;
    paintAsk(ax);
    var body = { quest: ax.quest.id };
    if (ax.kind === 'number') { body.choice = ''; body.amount = amount; }
    else if (ax.kind === 'wager') { body.choice = choice; body.amount = amount; }
    else body.choice = choice;
    window.scs.postJson(TAB_API + '/api/quest/ask', body, token).then(function (res) {
      if (ask !== ax) return; // another quest opened while it was away
      ax.sending = false;
      var data = res.data || {};
      if (res.status === 200 && data.ok) {
        ax.recorded = { choice: data.choice || '', amount: Number(data.amount) || 0 };
        ax.pick = ax.recorded.choice;
        if (ax.input) {
          ax.input.value = ax.kind === 'text'
            ? ax.recorded.choice
            : (ax.recorded.amount ? String(ax.recorded.amount) : '');
        }
        // answers shown while open now count this one too
        if (ax.results) loadAsk(ax, true);
      } else if (res.status === 409) {
        ax.open = false;
        loadAsk(ax, true); // a closed question may show everyone's answers now
      } else if (res.status === 401) ax.signedIn = false;
      else ax.error = data.error || ASK_FAILED;
      repaintAsk(ax);
    }).catch(function () {
      if (ask !== ax) return;
      ax.sending = false;
      ax.error = ASK_FAILED;
      repaintAsk(ax);
    });
  }

  // Builds the box for one question and returns what drives it. A null
  // spec means this quest asks nothing: the box goes away.
  function buildAsk(quest, spec) {
    var ax = {
      quest: quest,
      kind: spec ? spec.kind : '',
      prompt: spec ? (spec.prompt || '') : '',
      options: spec ? (spec.options || []).slice() : [],
      open: spec ? spec.open !== false : false,
      until: spec ? (spec.open_until || '') : '', // when it stops taking answers
      untilEl: null,
      signedIn: !!submitSession(),
      pick: '',        // the option under the finger, before Send
      recorded: null,  // {choice, amount} the worker holds for this team
      results: null,   // everyone's answers, when the question shows them
      error: '',
      sending: false,
      buttons: [],
      input: null,
      send: null,
      status: null,
      resultsEl: null
    };
    if (!askBox) return ax;
    askBox.textContent = '';
    askBox.classList.toggle('is-hidden', !spec);
    if (!spec) return ax;

    // The band's top line names the field on the left and says when it
    // shuts on the right, both in the label voice. The question itself
    // is the line under them.
    var head = document.createElement('div');
    head.className = 'ql-ask-head';
    var label = document.createElement('span');
    label.className = 'ql-points-label';
    label.textContent = ax.kind === 'wager' ? 'Points Wager' : 'Live Question';
    head.appendChild(label);

    // organisers can set a time the question stops taking answers
    var until = document.createElement('p');
    until.className = 'ql-ask-until is-hidden';
    ax.untilEl = until;
    head.appendChild(until);
    askBox.appendChild(head);

    if (ax.prompt) {
      var prompt = document.createElement('p');
      prompt.className = 'ql-ask-prompt';
      prompt.textContent = ax.prompt;
      askBox.appendChild(prompt);
    }

    if (ax.kind === 'choice' || ax.kind === 'wager') {
      var row = document.createElement('div');
      row.className = 'ql-ask-options';
      ax.options.forEach(function (option) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ql-ask-option';
        b.textContent = option;
        b.setAttribute('data-option', option);
        b.setAttribute('aria-pressed', 'false');
        b.addEventListener('click', function () {
          if (b.disabled) return;
          if (ax.kind === 'choice') { sendAsk(ax, option, null); return; }
          ax.pick = option; // a wager is staked, then sent
          ax.error = '';
          paintAsk(ax);
        });
        ax.buttons.push(b);
        row.appendChild(b);
      });
      askBox.appendChild(row);
    }

    if (ax.kind !== 'choice') {
      var entry = document.createElement('div');
      entry.className = 'ql-ask-entry';
      var input = document.createElement('input');
      input.className = 'ql-ask-input';
      if (ax.kind === 'text') {
        input.type = 'text';
        input.maxLength = 200;
        input.placeholder = 'Your answer';
        input.setAttribute('aria-label', 'Your answer');
      } else {
        input.type = 'number';
        input.setAttribute('inputmode', 'numeric');
        input.min = ax.kind === 'wager' ? '1' : '0';
        input.step = '1';
        input.placeholder = ax.kind === 'wager' ? 'Points' : 'Number';
        input.setAttribute('aria-label', ax.kind === 'wager' ? 'Points to stake' : 'Your answer');
      }
      // Send is ink inside the field's own edge, not a filled block:
      // green on the sheet belongs to the one action at the foot.
      var send = document.createElement('button');
      send.type = 'button';
      send.className = 'ql-ask-send';
      send.textContent = 'Send';
      send.addEventListener('click', function () {
        if (send.disabled) return;
        if (ax.kind === 'text') sendAsk(ax, input.value.trim(), null);
        else if (ax.kind === 'number') sendAsk(ax, '', askAmount(ax));
        else sendAsk(ax, ax.pick, askAmount(ax));
      });
      input.addEventListener('input', function () { ax.error = ''; paintAsk(ax); });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') send.click(); });
      ax.input = input;
      ax.send = send;
      entry.appendChild(input);
      entry.appendChild(send);
      askBox.appendChild(entry);
    }

    var status = document.createElement('p');
    status.className = 'ql-ask-status';
    ax.status = status;
    askBox.appendChild(status);

    var results = document.createElement('div');
    results.className = 'ql-ask-results is-hidden';
    ax.resultsEl = results;
    askBox.appendChild(results);
    return ax;
  }

  // What the worker says about the question, and what this team has
  // already answered. The list's copy of the question can be old, so a
  // different question is rebuilt from the answer rather than patched.
  // `again` is a second read of the same box: it takes whether it is
  // open and everyone's answers, and leaves the team's pick and the
  // field alone, which they may be part way through changing.
  function loadAsk(ax, again) {
    var token = submitSession();
    var opts = { cache: 'no-store' };
    if (token) opts.headers = { authorization: 'Bearer ' + token };
    window.scs.fetch(TAB_API + '/api/quest/ask?quest=' + encodeURIComponent(ax.quest.id), opts).then(function (r) {
      if (!r.ok) throw new Error('ask ' + r.status);
      return r.json();
    }).then(function (data) {
      if (ask !== ax || state.activeQuest !== ax.quest) return;
      var fresh = (data && data.kind)
        ? {
          kind: data.kind, prompt: data.prompt || '', options: data.options || [],
          open: !!data.open, open_until: data.open_until || ''
        }
        : null;
      var results = data && data.results && typeof data.results === 'object' ? data.results : null;
      glideSheetHeight(function () {
        var same = fresh && fresh.kind === ax.kind && fresh.prompt === ax.prompt &&
          fresh.options.join('\n') === ax.options.join('\n');
        var box = same ? ax : buildAsk(ax.quest, fresh);
        ask = box;
        if (!fresh) return;
        box.open = fresh.open;
        box.until = fresh.open_until;
        box.results = results;
        watchResults(box);
        if (again && same) { paintAsk(box); return; }
        var response = data.response;
        if (response && typeof response === 'object') {
          box.recorded = { choice: response.choice || '', amount: Number(response.amount) || 0 };
          box.pick = box.recorded.choice;
          if (box.input) {
            box.input.value = box.kind === 'text'
              ? box.recorded.choice
              : (box.recorded.amount ? String(box.recorded.amount) : '');
          }
        }
        paintAsk(box);
      });
    }).catch(function () {
      // the box stands on what it last had; a second read tries again
      if (again && ask === ax) watchResults(ax);
    });
  }

  function renderDetailAsk(quest) {
    if (!askBox) return;
    ask = buildAsk(quest, quest.ask);
    if (quest.ask) {
      paintAsk(ask);
      loadAsk(ask);
      return;
    }
    // The list only carries open questions. A signed-in team asks the
    // worker anyway: a question that closed still shows them their own
    // recorded answer and any answers it shows, and one that opened
    // after the list was cached appears without waiting for a refresh.
    // Signed out, the sheet does not ask about every quest it opens.
    if (submitSession()) loadAsk(ask);
  }

  // A team signing in or out, on the submit page in another tab or
  // here, reaches the box on an open sheet: it is built again for the
  // session there is now.
  function askSessionChanged() {
    var quest = state.activeQuest;
    if (!askBox || !quest || overlay.classList.contains('is-hidden')) return;
    glideSheetHeight(function () { renderDetailAsk(quest); });
  }
  document.addEventListener('scs-session-changed', askSessionChanged);
  window.addEventListener('storage', function (e) {
    if (e.key === SUBMIT_SESSION_KEY || e.key === null) askSessionChanged();
  });

  // ---------- A challenge's standings ----------
  // Where every team stands on a quest counted across all of its
  // submissions. The worker answers only for a quest that shows them,
  // and while the tab is frozen or closed says that instead. Nothing is
  // drawn until the answer arrives, and then through glideSheetHeight.
  var standingsBox = document.getElementById('ql-detail-standings');

  function renderDetailStandings(quest) {
    if (!standingsBox) return;
    standingsBox.textContent = '';
    standingsBox.classList.add('is-hidden');
    if (!quest.standings) return;
    var token = submitSession();
    var opts = { cache: 'no-store' };
    if (token) opts.headers = { authorization: 'Bearer ' + token };
    window.scs.fetch(TAB_API + '/api/quest/standings?quest=' + encodeURIComponent(quest.id), opts).then(function (r) {
      if (!r.ok) throw new Error('standings ' + r.status);
      return r.json();
    }).then(function (data) {
      if (state.activeQuest !== quest) return;
      glideSheetHeight(function () { fillStandings(data); });
    }).catch(function () { /* the block stays away */ });
  }

  function fillStandings(data) {
    standingsBox.textContent = '';
    var head = document.createElement('span');
    head.className = 'ql-points-label ql-detail-head';
    head.textContent = 'Standings';
    standingsBox.appendChild(head);
    var teams = data.teams || [];
    var note = '';
    if (data.closed) note = 'The standings are hidden until the ceremony.';
    else if (data.frozen) note = 'The standings are frozen until the ceremony.';
    else if (!teams.length) note = 'Nothing counted yet.';
    if (note) {
      var line = document.createElement('p');
      line.className = 'ql-standings-note';
      line.textContent = note;
      standingsBox.appendChild(line);
    }
    teams.forEach(function (t) {
      if (note) return;
      var row = document.createElement('div');
      row.className = 'ql-standing';
      var place = document.createElement('span');
      place.className = 'bullet ql-standing-place';
      place.textContent = t.place;
      var name = document.createElement('span');
      name.className = 'ql-standing-team';
      name.textContent = t.name;
      var count = document.createElement('span');
      count.className = 'ql-standing-count';
      count.textContent = t.count;
      row.appendChild(place);
      row.appendChild(name);
      row.appendChild(count);
      standingsBox.appendChild(row);
    });
    standingsBox.classList.remove('is-hidden');
  }

  // ---------- A quest scored by calls from payphones ----------
  // The number to call, and for a signed-in team its phone PIN and the
  // payphones it has. The PIN is the team's, so it needs the submit
  // page's session.
  var phoneBox = document.getElementById('ql-detail-phone');

  function phoneLine(text, cls) {
    var p = document.createElement('p');
    p.className = cls || 'ql-standings-note';
    p.textContent = text;
    return p;
  }

  function fillPhone(quest, mine) {
    phoneBox.textContent = '';
    var head = document.createElement('span');
    head.className = 'ql-points-label ql-detail-head';
    head.textContent = 'Payphones';
    phoneBox.appendChild(head);
    var number = (mine && mine.number) || quest.phone.number;
    if (number) {
      var call = document.createElement('p');
      call.className = 'ql-phone-call';
      call.appendChild(document.createTextNode('From a payphone, call '));
      var link = document.createElement('a');
      link.href = 'tel:' + number.replace(/[^\d+]/g, '');
      link.textContent = number;
      call.appendChild(link);
      call.appendChild(document.createTextNode(' and key in your team\u2019s PIN.'));
      phoneBox.appendChild(call);
    }
    if (!mine) {
      phoneBox.appendChild(phoneLine(submitSession()
        ? 'Your team\u2019s PIN could not be loaded. Close this quest and open it again.'
        : 'Sign in on the submit page to see your team\u2019s PIN.'));
      phoneBox.classList.remove('is-hidden');
      return;
    }
    var pin = document.createElement('div');
    pin.className = 'ql-standing';
    var pinName = document.createElement('span');
    pinName.className = 'ql-standing-team ql-phone-wide';
    pinName.textContent = 'Your team\u2019s PIN';
    var pinValue = document.createElement('span');
    pinValue.className = 'ql-standing-count ql-phone-pin';
    pinValue.textContent = mine.pin;
    pin.appendChild(pinName);
    pin.appendChild(pinValue);
    phoneBox.appendChild(pin);
    var captures = mine.captures || [];
    if (!captures.length) phoneBox.appendChild(phoneLine('No payphones yet.'));
    captures.forEach(function (c, i) {
      var row = document.createElement('div');
      row.className = 'ql-standing';
      var place = document.createElement('span');
      place.className = 'bullet ql-standing-place';
      place.textContent = String(i + 1);
      var name = document.createElement('span');
      name.className = 'ql-standing-team';
      name.textContent = c.name + (c.waiting ? ' (an organiser is checking this phone)' : '');
      var when = document.createElement('span');
      when.className = 'ql-standing-count';
      when.textContent = window.scs.fmtTime(c.at);
      row.appendChild(place);
      row.appendChild(name);
      row.appendChild(when);
      phoneBox.appendChild(row);
    });
    phoneBox.classList.remove('is-hidden');
  }

  function renderDetailPhone(quest) {
    if (!phoneBox) return;
    phoneBox.textContent = '';
    phoneBox.classList.add('is-hidden');
    if (!quest.phone) return;
    var token = submitSession();
    if (!token) { fillPhone(quest, null); return; }
    window.scs.fetch(TAB_API + '/api/phone/mine', { cache: 'no-store', headers: { authorization: 'Bearer ' + token } }).then(function (r) {
      if (!r.ok) throw new Error('phone ' + r.status);
      return r.json();
    }).then(function (data) {
      if (state.activeQuest !== quest) return;
      glideSheetHeight(function () { fillPhone(quest, data); });
    }).catch(function () {
      if (state.activeQuest === quest) glideSheetHeight(function () { fillPhone(quest, null); });
    });
  }
  document.addEventListener('scs-session-changed', function () {
    var quest = state.activeQuest;
    if (phoneBox && quest && quest.phone && !overlay.classList.contains('is-hidden')) renderDetailPhone(quest);
  });

  // ---------- Detail modal ----------
  var overlay = document.getElementById('ql-detail-overlay');
  ql.overlay = overlay;
  ql.sheetOpenedAt = 0; // a sheet must outlive the gesture that opened it

  // opts.stop: 'card', 'half' or 'full' on a phone (half by default);
  // opts.loc: the place tapped, for a quest with several
  function openDetail(quest, panMap, fromCard, opts) {
    opts = opts || {};
    var stop = isSheet() ? (opts.stop || 'half') : 'half';
    var switched = state.activeQuest !== quest;
    state.activeQuest = quest;
    // everything below is drawn and fetched again, so changes still
    // waiting from before have nothing left to change, and a cue on its
    // way belongs to the quest it was for
    pendingSheetChanges = [];
    stopFlashCodes();
    cancelMorphs(); // a reopened sheet starts from a clean slate
    // cancel a close animation still in flight
    if (closeTimer) {
      window.clearTimeout(closeTimer);
      closeTimer = null;
      overlay.classList.remove('is-leaving');
    }
    var wasHidden = overlay.classList.contains('is-hidden');
    document.documentElement.classList.add('ql-sheet-open'); // dim under the bars
    document.documentElement.classList.remove('ql-sheet-dragging');
    document.documentElement.style.removeProperty('--sheet-dim');
    // one back-closable layer per sheet session (quest switches reuse it)
    if (!sheetLayer && window.scsBackLayer) {
      sheetLayer = window.scsBackLayer.arm(function () { closeDetail(); });
    }
    // Everything that changes the sheet's natural size happens inside
    // one glide, so a quest switch moves smoothly to its new height
    // (glideSheetHeight is a no-op on a fresh, still-hidden sheet).
    glideSheetHeight(function () {
      // the phone sheet always starts at half height
      var sheetEl = overlay.querySelector('.ql-detail');
      if (sheetEl) {
        sheetEl.classList.toggle('is-full', stop === 'full');
        setCardStop(stop === 'card');
        sheetEl.style.transition = '';
        sheetEl.style.transform = '';
        // another quest starts at its own top
        if (switched) sheetEl.scrollTop = 0;
      }
      updateDetailDoneButton();
      // the submit page reads the hash and picks this quest by itself
      document.getElementById('ql-detail-submit').href = '../submit/#' + encodeURIComponent(quest.id);
      document.getElementById('ql-detail-bullet').textContent = regionLetter(quest.category);
      paintRoute(overlay.querySelector('.ql-detail'), quest.category);
      document.getElementById('ql-detail-title').textContent = quest.name;
      fillGlance(quest, opts.loc);
      var flavourEl = document.getElementById('ql-detail-flavour');
      flavourEl.textContent = quest.flavour;
      flavourEl.classList.toggle('is-hidden', !quest.flavour);
      // its tags, each a search for itself
      var tagsEl = document.getElementById('ql-detail-tags');
      if (tagsEl) {
        tagsEl.textContent = '';
        (quest.keywords || []).forEach(function (word) {
          var chip = document.createElement('button');
          chip.type = 'button';
          chip.className = 'ql-chip';
          chip.textContent = word;
          chip.addEventListener('click', function () {
            closeDetail();
            ql.applySearchText(word, null);
          });
          tagsEl.appendChild(chip);
        });
        tagsEl.classList.toggle('is-hidden', !(quest.keywords || []).length);
      }
      document.getElementById('ql-detail-description').innerHTML = window.scs.markdown(quest.description);
      renderDetailFiles(quest);
      renderDetailCodes(quest);
      renderDetailAsk(quest);
      renderDetailStandings(quest);
      renderDetailPhone(quest);
      ql.newListOpen = false;
      ql.renderDetailLists();

      renderDetailTeams(quest);
    });
    highlightQuestMarkers(quest);

    overlay.classList.remove('is-hidden');
    measureCard();
    ql.unfadeMapUi();
    ql.sheetOpenedAt = Date.now();
    ql.positionMapControls();

    // container transform (test): a card-opened sheet grows out of its
    // card, and remembers which card to shrink back into on dismissal
    morphQuestId = fromCard ? quest.id : null;
    if (wasHidden) {
      overlay.classList.toggle('is-morphing', startOpenMorph(fromCard || null));
    }

    if (panMap && stop === 'card') frameAboveCard(opts.loc || nearestLocation(quest));
    else if (panMap && state.map && quest.locations.length) {
      // centre the pin in the part of the map the panels leave visible:
      // above the sheet on phones, right of the side panel on desktop
      var occluded = 0;
      var sideways = 0;
      if (!overlay.classList.contains('is-hidden') && sheet) {
        if (isSheet()) {
          occluded = Math.min(sheet.getBoundingClientRect().height, window.innerHeight * 0.6);
        } else if (document.documentElement.classList.contains('ql-map-full')) {
          sideways = Math.max(0, sheet.getBoundingClientRect().right - ql.mapBox.getBoundingClientRect().left);
        }
      }
      var move = { duration: window.scs.reducedMotion ? 0 : 600, essential: true };
      if (quest.locations.length === 1) {
        move.center = [quest.locations[0].lng, quest.locations[0].lat];
        move.zoom = 13;
        move.offset = [sideways / 2, -occluded / 2];
        state.map.easeTo(move);
      } else {
        var lngs = quest.locations.map(function (l) { return l.lng; });
        var lats = quest.locations.map(function (l) { return l.lat; });
        move.padding = { top: 30, right: 30, bottom: 30 + occluded, left: 30 + sideways };
        move.maxZoom = 15;
        state.map.fitBounds([[Math.min.apply(null, lngs), Math.min.apply(null, lats)],
          [Math.max.apply(null, lngs), Math.max.apply(null, lats)]], move);
      }
    }
  }

  var sheetMq = window.matchMedia('(max-width: 930px)');
  // The details are a sheet that drags under a finger, and in the
  // full-screen map on a narrow screen, where the map stays above it. A
  // desktop browser gets them as a box in the middle at any width
  // (html.ql-pop, which the stylesheet keys the two layouts to).
  var fineMq = window.matchMedia('(hover: hover) and (pointer: fine)');
  function isSheet() {
    return sheetMq.matches && (!fineMq.matches || document.documentElement.classList.contains('ql-map-full'));
  }
  // Runs on load, when either query changes and when the map goes full
  // screen or back. A layout that is not the sheet has no card.
  function syncPop() {
    var sheetNow = isSheet();
    document.documentElement.classList.toggle('ql-pop', !sheetNow);
    if (!sheetNow && sheetStop() === 'card') setSheetStop('half');
  }
  syncPop();
  [sheetMq, fineMq].forEach(function (mq) {
    if (mq.addEventListener) mq.addEventListener('change', syncPop);
    else if (mq.addListener) mq.addListener(syncPop);
  });
  var closeTimer = null;

  // The open sheet is a back-gesture layer (shared manager in site-chrome.js):
  // the system back closes it, and UI dismissals consume the entry.
  var sheetLayer = null;

  function closeDetail() {
    if (overlay.classList.contains('is-hidden') || closeTimer || morphClosing) return;
    if (sheetLayer) {
      var layer = sheetLayer;
      sheetLayer = null;
      if (window.scsBackLayer) window.scsBackLayer.disarm(layer);
    }
    pendingSheetChanges = [];
    // an entrance still growing ends here, so its own finish cannot
    // reach into the close below
    if (morphOpenAnim) cancelMorphs();
    stopFlashCodes(); // a sheet on its way out has nothing left to point at
    document.documentElement.classList.remove('ql-sheet-open'); // dim fades out
    document.documentElement.classList.remove('ql-sheet-card');
    state.litQuiet = false;
    clearQuestHighlight();
    ql.restoreSearchAfterSheet(); // the results rise back as the sheet leaves
    var sheetEl = overlay.querySelector('.ql-detail');
    if (isSheet() && sheetEl) {
      // container transform (test): shrink back down into the quest card
      if (startCloseMorph(sheetEl)) return;
      // slide out and fade the dim instead of vanishing
      overlay.classList.add('is-leaving');
      closeTimer = window.setTimeout(function () {
        closeTimer = null;
        overlay.classList.remove('is-leaving');
        overlay.classList.remove('is-morphing');
        overlay.classList.add('is-hidden');
        sheetEl.style.transition = '';
        sheetEl.style.transform = '';
        ql.positionMapControls();
      }, 240);
    } else {
      overlay.classList.remove('is-morphing');
      overlay.classList.add('is-hidden');
    }
    ql.positionMapControls();
  }

  window.addEventListener('resize', ql.positionMapControls);
  // Turning a phone is not one resize: the browser's own bars settle
  // after the turn, so the buttons are placed again — and the map told
  // its container changed — once everything has landed.
  window.addEventListener('orientationchange', function () {
    window.setTimeout(function () {
      ql.positionMapControls();
      if (state.map) state.map.resize();
    }, 300);
  });

  document.getElementById('ql-detail-close').addEventListener('click', closeDetail);

  // ---------- The sheet's stops on a phone ----------
  // One sheet, three stops. A pin opens it at the card: the head and the
  // line under it (the points, how far, where, the way there), with the
  // rest of the half-height sheet waiting below the edge of the screen,
  // so a pull up uncovers it under the finger. The list opens it where
  // the list was. Card, half and full are one drag (the gestures below),
  // and a tap on the card's head or grab bar brings it up to half.
  var mapCardEl = document.querySelector('.ql-map-card');
  var cardDrop = 0; // how far the half sheet is pushed down at the card

  // Apple's maps on an iPhone or iPad, Google's everywhere else
  function directionsUrl(loc) {
    var at = loc.lat + ',' + loc.lng;
    var apple = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
      (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
    return apple ? 'https://maps.apple.com/?daddr=' + at : 'https://www.google.com/maps/dir/?api=1&destination=' + at;
  }

  function nearestLocation(quest) {
    if (!quest.locations.length) return null;
    if (!state.userPos) return quest.locations[0];
    var best = quest.locations[0];
    var bestD = Infinity;
    quest.locations.forEach(function (loc) {
      var d = haversineKm(state.userPos, loc);
      if (d < bestD) { bestD = d; best = loc; }
    });
    return best;
  }

  // the line under the head, at every stop
  function fillGlance(quest, loc) {
    var pts = pointsSummary(quest.points);
    // a bare figure gets its word; "25 each" or "???" already reads
    if (/^-?\d[\d,]*$/.test(pts)) pts += pts === '1' ? ' point' : ' points';
    var bits = [pts];
    var d = loc && state.userPos ? haversineKm(state.userPos, loc) : questDistanceKm(quest);
    if (d !== null && d !== undefined) bits.push('~' + (d < 10 ? d.toFixed(1) : Math.round(d)) + ' km away');
    document.getElementById('ql-glance-meta').textContent = bits.filter(Boolean).join(' · ');
    // a quest with several places names the one tapped
    document.getElementById('ql-detail-location').textContent =
      loc && quest.locations.length > 1 && loc.label ? loc.label : locationText(quest);
    var to = loc || nearestLocation(quest);
    var dir = document.getElementById('ql-glance-dir');
    dir.classList.toggle('is-hidden', !to);
    if (to) dir.href = directionsUrl(to);
  }

  function sheetStop() {
    var el = overlay.querySelector('.ql-detail');
    if (!el || overlay.classList.contains('is-hidden')) return null;
    return el.classList.contains('is-full') ? 'full' : el.classList.contains('is-card') ? 'card' : 'half';
  }

  function setCardStop(on) {
    var el = overlay.querySelector('.ql-detail');
    if (!el) return;
    el.classList.toggle('is-card', on);
    // at the card the page and the map stay live and undimmed
    document.documentElement.classList.toggle('ql-sheet-card', on);
    // and the lit pins drop or take back their name tips with it
    var wasQuiet = !!state.litQuiet;
    state.litQuiet = on;
    if (wasQuiet !== on && state.litQuest) drawPins();
    if (on) el.scrollTop = 0;
  }

  // The card is the half sheet pushed down until only its head and the
  // line under it show. Measured whenever its content or size changes;
  // a full sheet keeps the last half measure.
  function measureCard() {
    var el = overlay.querySelector('.ql-detail');
    var glance = document.getElementById('ql-detail-glance');
    if (!el || !glance || !isSheet() || el.classList.contains('is-full')) return cardDrop;
    var card = glance.getBoundingClientRect().bottom - el.getBoundingClientRect().top + 16;
    cardDrop = Math.max(0, Math.round(el.offsetHeight - card));
    el.style.setProperty('--ql-card-drop', cardDrop + 'px');
    return cardDrop;
  }

  function setSheetStop(next) {
    var el = overlay.querySelector('.ql-detail');
    if (!el || overlay.classList.contains('is-hidden')) return;
    el.classList.toggle('is-full', next === 'full');
    setCardStop(next === 'card');
    measureCard();
    ql.positionMapControls();
  }

  // the pin into the room above the card, moved only when it is not
  // there already
  function frameAboveCard(loc) {
    var el = overlay.querySelector('.ql-detail');
    if (!state.map || !loc || !el) return;
    var box = ql.mapBox.getBoundingClientRect();
    var cardTop = overlay.getBoundingClientRect().bottom - (el.offsetHeight - cardDrop);
    var covered = Math.max(0, box.bottom - cardTop);
    var p = state.map.project([loc.lng, loc.lat]);
    if (p.x > 30 && p.x < box.width - 60 && p.y > 70 && p.y < box.height - covered - 30) return;
    state.map.easeTo({ center: [loc.lng, loc.lat], offset: [0, -covered / 2],
      duration: window.scs.reducedMotion ? 0 : 450, essential: true });
  }

  overlay.querySelector('.ql-detail').addEventListener('click', function (e) {
    if (sheetStop() !== 'card' || !e.target.closest) return;
    if (!e.target.closest('.ql-sheet-handle, .ql-detail-top') || e.target.closest('button, a')) return;
    setSheetStop('half');
  });
  window.addEventListener('resize', function () { if (sheetStop()) measureCard(); });

  // A link to the quest on screen: /questlist/#KEY opens its sheet
  document.getElementById('ql-detail-share').addEventListener('click', function () {
    var quest = state.activeQuest;
    if (!quest) return;
    var link = location.origin + location.pathname.replace(/index\.html$/, '') + '#' + encodeURIComponent(quest.id);
    var done = function () { if (window.scsToast) window.scsToast('Link copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(done, function () { window.prompt('Copy this link', link); });
    } else {
      window.prompt('Copy this link', link);
    }
  });
  overlay.addEventListener('click', function (e) {
    if (e.target !== overlay) return;
    // the second half of a double click or double tap on a pin lands
    // here: it opened this sheet, it should not immediately shut it
    if (Date.now() - ql.sheetOpenedAt < 400) return;
    closeDetail();
  });
  // only while the sheet is the top layer: a menu or the viewer opened
  // over it takes its own Escape
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (overlay.classList.contains('is-hidden')) return;
    if (sheetLayer && !window.scsBackLayer.isTop(sheetLayer)) return;
    e.preventDefault();
    closeDetail();
  });

  // ---------- Container transform (test): card <-> sheet morph ----------
  // Trying a newer app pattern: tapping a quest card grows that card into
  // the sheet, and dismissing the sheet shrinks it back down into the
  // same card. A visual copy of the card rides along and crossfades with
  // the sheet, so both ends of the morph always look right. Phones only;
  // marker taps and the fullscreen map keep the stock slide.
  var reducedMotionMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  var morphQuestId = null;  // quest opened from a list card, else null
  var morphOpenAnim = null; // in-flight grow animation, finishable early
  var morphClosing = false; // shrink in flight: gestures stand down
  var morphCleanup = null;  // idempotent teardown for whichever morph runs

  // the settings menu chooses the style: morph (default) or the slide
  function prefersMorph() {
    try { return localStorage.getItem('scs2-anim') !== 'slide'; } catch (err) { return true; }
  }

  function canMorph() {
    return isSheet() && sheet && prefersMorph() &&
      typeof sheet.animate === 'function' &&
      // a card carrying the quest's full information is taller than the
      // sheet it would grow into, so the morph would squash rather than
      // grow: that reading uses the stock slide
      !state.fullInfo &&
      !document.documentElement.classList.contains('ql-map-full') &&
      !reducedMotionMq.matches;
  }

  function morphCardFor(questId) {
    if (!questId) return null;
    var card = listEl.querySelector('.ql-item[data-quest-id="' + questId + '"]');
    if (!card) return null;
    var r = card.getBoundingClientRect();
    // only morph into a card that is actually on screen
    if (!r.height || r.bottom < 90 || r.top > window.innerHeight - 70) return null;
    return card;
  }

  function makeGhost(card, rect) {
    var ghost = card.cloneNode(true);
    ghost.classList.add('ql-morph-ghost');
    ghost.setAttribute('aria-hidden', 'true');
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    ghost.style.width = rect.width + 'px';
    ghost.style.height = rect.height + 'px';
    document.body.appendChild(ghost);
    return ghost;
  }

  function cancelMorphs() {
    if (morphOpenAnim) { try { morphOpenAnim.cancel(); } catch (err) {} morphOpenAnim = null; }
    if (morphCleanup) morphCleanup();
  }

  function startOpenMorph(card) {
    if (!canMorph() || !card || !card.getBoundingClientRect) return false;
    var first = card.getBoundingClientRect();
    var last = sheet.getBoundingClientRect();
    if (!first.height || !last.height) return false;

    // the sheet grows out of the card's box, fading in as it un-squashes
    sheet.style.transformOrigin = '0 0';
    var grow = sheet.animate([
      {
        transform: 'translate(' + (first.left - last.left) + 'px, ' + (first.top - last.top) + 'px) ' +
          'scale(' + first.width / last.width + ', ' + first.height / last.height + ')',
        opacity: 0.25
      },
      { opacity: 1, offset: 0.45 },
      { transform: 'translate(0px, 0px) scale(1, 1)', opacity: 1 }
    ], { duration: 320, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });
    morphOpenAnim = grow;

    // while a copy of the card stretches up into the sheet and fades away
    var ghost = makeGhost(card, first);
    var ghostAnim = ghost.animate([
      { transform: 'translate(0px, 0px) scale(1)', opacity: 1 },
      { opacity: 0, offset: 0.55 },
      {
        transform: 'translate(' + (last.left - first.left) + 'px, ' + (last.top - first.top) + 'px) ' +
          'scale(' + last.width / first.width + ')',
        opacity: 0
      }
    ], { duration: 320, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });

    var finished = false;
    var done = function () {
      if (finished) return;
      finished = true;
      if (morphOpenAnim === grow) morphOpenAnim = null;
      if (morphCleanup === done) morphCleanup = null;
      try { ghostAnim.cancel(); } catch (err) {}
      sheet.style.transformOrigin = '';
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
      flushPendingSheetChanges(); // anything that landed mid-morph
    };
    morphCleanup = done;
    grow.onfinish = done;
    grow.oncancel = done;
    window.setTimeout(done, 420); // safety net if no finish event lands
    return true;
  }

  function startCloseMorph(sheetEl) {
    if (!canMorph()) return false;
    var card = morphCardFor(morphQuestId);
    if (!card) return false;

    var cur = sheetEl.getBoundingClientRect(); // wherever the drag left it
    sheetEl.style.transition = 'none';
    sheetEl.style.transform = '';
    var base = sheetEl.getBoundingClientRect(); // resting box the keyframes are relative to
    var target = card.getBoundingClientRect();
    if (!base.height || !target.height) {
      sheetEl.style.transition = '';
      return false;
    }

    morphClosing = true;
    sheetEl.style.transformOrigin = '0 0';
    // the sheet keeps moving from under the finger and shrinks into the card
    var shrink = sheetEl.animate([
      {
        transform: 'translate(' + (cur.left - base.left) + 'px, ' + (cur.top - base.top) + 'px) scale(1, 1)',
        opacity: 1
      },
      { opacity: 1, offset: 0.4 },
      {
        transform: 'translate(' + (target.left - base.left) + 'px, ' + (target.top - base.top) + 'px) ' +
          'scale(' + target.width / base.width + ', ' + target.height / base.height + ')',
        opacity: 0
      }
    ], { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' });

    // while the card's copy falls back into its slot in the list
    var ghost = makeGhost(card, target);
    var ghostAnim = ghost.animate([
      {
        transform: 'translate(' + (cur.left - target.left) + 'px, ' + (cur.top - target.top) + 'px) ' +
          'scale(' + base.width / target.width + ')',
        opacity: 0
      },
      { opacity: 0, offset: 0.3 },
      { transform: 'translate(0px, 0px) scale(1)', opacity: 1 }
    ], { duration: 300, easing: 'cubic-bezier(0.4, 0, 0.2, 1)' });

    var finished = false;
    var done = function () {
      if (finished) return;
      finished = true;
      if (morphCleanup === done) morphCleanup = null;
      morphClosing = false;
      overlay.classList.add('is-hidden');
      overlay.classList.remove('is-morphing');
      ql.positionMapControls();
      try { shrink.cancel(); ghostAnim.cancel(); } catch (err) {}
      sheetEl.style.transition = '';
      sheetEl.style.transform = '';
      sheetEl.style.transformOrigin = '';
      if (ghost.parentNode) ghost.parentNode.removeChild(ghost);
    };
    morphCleanup = done;
    shrink.onfinish = done;
    window.setTimeout(done, 400); // safety net if no finish event lands
    return true;
  }

  // ---------- Sheet drag on phones: the whole sheet is the surface ----------
  // Like an iOS sheet. Swipe down anywhere, buttons included: if the
  // content is at its top the sheet follows the finger; if the content is
  // scrolled it scrolls first and hands the gesture over the moment it
  // reaches the top. Swiping up grows the sheet to full before the
  // content starts scrolling. Taps stay taps: a drag only begins once the
  // finger clearly moves, and release snaps to full, half or gone using
  // fling speed as well as distance. The grab bar and title drag
  // instantly, no slop.
  var sheet = overlay.querySelector('.ql-detail');
  var sheetHandle = overlay.querySelector('.ql-sheet-handle');
  if (sheet && sheetHandle) {
    var sheetDragY = null;   // gesture baseline, re-based on handover
    var sheetMode = null;    // null (undecided) | 'drag' | 'handover'
    var sheetDragDelta = 0;
    var sheetDragHeight = 1;
    var sheetMaxUp = 0;
    var sheetHalfDrop = 0;
    var sheetVel = 0;
    var sheetLastY = 0;
    var sheetLastT = 0;
    var sheetDragTop = 0;    // where the sheet's top edge sat when the finger landed
    var sheetSrTop = 0;      // and the search panel's, for the map buttons
    var sheetShownY = 0;     // the translate the sheet is actually drawn at (band included)
    var sheetCardBase = 0;   // where the drag started from the half position: the card's drop, or 0
    var sheetFling = 0;      // rAF handle of a content fling in progress

    // The map buttons ride the sheet. Measuring the sheet on every move
    // right after moving it forced a layout per touch event; its edge is
    // known from where it started plus the drag, so nothing is read.
    var liftDuringDrag = function (y) {
      var root = document.documentElement;
      if (!root.classList.contains('ql-map-full') || !sheetMq.matches) return;
      var srTop = sheetSrTop;
      if (ql.searchReturnState && ql.searchWrap && ql.searchWrap.style.height) {
        srTop = window.innerHeight - parseFloat(ql.searchWrap.style.height);
      }
      ql.applyControlLift(Math.min(sheetDragTop + y, srTop));
    };

    // A sheet that was scrolled by hand (the handover after it reached
    // full height) keeps its momentum when the finger lifts, the way a
    // native scroll would: the speed decays a little each frame and the
    // content stops at its ends. A new touch cancels it.
    var flingSheetContent = function (vel) {
      var v = -vel; // finger moving up = content moving down
      if (Math.abs(v) < 0.15) return;
      var last = Date.now();
      var pos = sheet.scrollTop; // kept as a float between frames
      var step = function () {
        sheetFling = 0;
        var now = Date.now();
        var dt = Math.min(Math.max(now - last, 1), 40);
        last = now;
        var most = sheet.scrollHeight - sheet.clientHeight;
        pos = Math.max(0, Math.min(most, pos + v * dt));
        sheet.scrollTop = pos;
        v *= Math.pow(0.998, dt);
        var atEnd = pos <= 0 || pos >= most;
        if (!atEnd && Math.abs(v) > 0.03) sheetFling = window.requestAnimationFrame(step);
      };
      sheetFling = window.requestAnimationFrame(step);
    };

    // diminishing pull: approaches limit smoothly, never a hard stop
    var rubber = function (excess, limit) {
      return (1 - 1 / (excess * 0.55 / limit + 1)) * limit;
    };

    // The sheet stays: the search panel the drag was raising under it
    // settles back down to its bar.
    var settleSearchUnderSheet = function () {
      if (!ql.searchReturnState || !ql.searchWrap) return;
      ql.searchWrap.classList.remove('is-dragging');
      void ql.searchWrap.offsetWidth;
      ql.searchWrap.style.height = '';
    };

    var endSheetDrag = function () {
      var wasDrag = sheetMode === 'drag';
      var wasHandover = sheetMode === 'handover';
      sheetGestureActive = false;
      var delta = sheetDragDelta;
      // a finger that paused before lifting has no fling left in it
      var vel = Date.now() - sheetLastT > 120 ? 0 : Math.max(-3, Math.min(3, sheetVel));
      sheetDragY = null;
      sheetMode = null;
      sheetDragDelta = 0;
      sheetHandle.classList.remove('is-vee'); // bar lies flat again
      sheetHandle.classList.remove('is-up');
      sheetHandle.classList.remove('is-stretching');
      sheetHandle.style.setProperty('--stretch', '1'); // eases back to size
      ql.resetSearchChevron(); // the panel it was driving lies flat too
      // dim fades smoothly again: back to full if the sheet stays, out if it goes
      document.documentElement.classList.remove('ql-sheet-dragging');
      document.documentElement.style.removeProperty('--sheet-dim');
      if (wasHandover) {
        // the sheet is already at full and the content where the finger
        // left it; the content carries on at the speed it was going
        sheet.style.transition = '';
        settleSearchUnderSheet();
        flushPendingSheetChanges();
        ql.positionMapControls();
        flingSheetContent(vel);
        return;
      }
      if (!wasDrag || overlay.classList.contains('is-hidden') || morphClosing) return;
      var wasFull = sheet.classList.contains('is-full');
      var proj = delta + vel * 160; // where the fling was headed
      var base = sheetCardBase;
      var at = base + proj;          // the same, from the half position
      // Where it settles. From full: half, or gone when flung clearly
      // past half. Otherwise, with a card to stop at: gone below the
      // card, full well above half, and between them the card or half,
      // whichever the pull was heading for.
      var target;
      if (wasFull) target = proj > 90 ? (proj > sheetHalfDrop + 130 ? 'close' : 'half') : 'full';
      else if (cardDrop > 24 && isSheet()) {
        if (at > cardDrop + 60) target = 'close';
        else if (-at > Math.max(55, sheetMaxUp * 0.3)) target = 'full';
        else if (base) target = proj < -40 ? 'half' : 'card';
        else target = proj > 90 ? 'card' : 'half';
      } else {
        target = proj > 90 ? 'close' : (-proj > Math.max(55, sheetMaxUp * 0.3) ? 'full' : 'half');
      }

      if (target === 'close') {
        // gone: keep sliding out from under the finger
        sheet.style.transition = 'transform 240ms cubic-bezier(0.3, 0, 0.7, 0.4)';
        sheet.style.transform = 'translateY(' + Math.ceil(sheet.getBoundingClientRect().height + 80) + 'px)';
        closeDetail(); // it is leaving: nothing waiting is resized
        return;
      }
      // The sheet settles by sliding alone. A change of size (half to
      // full, or back) is applied at once with the sheet pushed to where
      // the finger left it, and only the slide then plays out. Tweening
      // the height and the position together, on two different curves,
      // made the top edge wobble and the bottom edge (with its apron)
      // slide in and out of view.
      var shownY = sheetShownY;
      sheetShownY = 0;
      var heightBefore = sheet.getBoundingClientRect().height;
      sheet.classList.toggle('is-full', target === 'full');
      setCardStop(target === 'card');
      measureCard();
      var grew = sheet.getBoundingClientRect().height - heightBefore;
      if (Math.abs(grew) > 0.5) {
        sheet.style.transition = 'none';
        sheet.style.transform = 'translateY(' + (shownY + grew) + 'px)';
        void sheet.offsetWidth; // drawn there before the slide starts
      }
      sheet.style.transition = '';
      sheet.style.transform = '';
      settleSearchUnderSheet();
      flushPendingSheetChanges();
      ql.positionMapControls();
    };

    var onSheetTouchStart = function (e) {
      if (e.touches.length !== 1) return;
      if (morphClosing) return; // mid-dismissal: let the morph land
      // a grab mid-grow finishes the entrance instantly, then drags
      if (morphOpenAnim) { try { morphOpenAnim.finish(); } catch (err) {} }
      cancelSheetGlide(); // fingers beat animations: measure the real size
      if (sheetFling) { window.cancelAnimationFrame(sheetFling); sheetFling = 0; }
      sheetGestureActive = true;
      sheetDragY = e.touches[0].clientY;
      sheetLastY = sheetDragY;
      sheetLastT = Date.now();
      sheetVel = 0;
      sheetDragDelta = 0;
      sheetShownY = 0;
      var onChrome = e.target.closest &&
        e.target.closest('.ql-sheet-handle, .ql-detail-top') &&
        !e.target.closest('button');
      sheetMode = onChrome ? 'drag' : null;
      // how far up the sheet can still grow before the band engages,
      // and how far down the half position sits from here
      var rect = sheet.getBoundingClientRect();
      var most = Math.min(sheet.scrollHeight + 2, window.innerHeight - 14);
      sheetMaxUp = Math.max(0, most - rect.height);
      sheetHalfDrop = Math.max(0, rect.height - window.innerHeight * 0.52);
      sheetDragHeight = rect.height;
      sheetDragTop = rect.top;
      sheetCardBase = sheet.classList.contains('is-card') ? cardDrop : 0;
      var srRect = ql.searchWrap ? ql.searchWrap.getBoundingClientRect() : null;
      sheetSrTop = srRect && srRect.height > 0 ? srRect.top : window.innerHeight;
      if (sheetMode === 'drag') sheet.style.transition = 'none';
    };
    sheet.addEventListener('touchstart', onSheetTouchStart, { passive: true });

    var onSheetTouchMove = function (e) {
      if (sheetDragY === null || e.touches.length !== 1) return;
      var now = Date.now();
      var cy = e.touches[0].clientY;
      var step = cy - sheetLastY; // this move's travel, before the baseline moves on
      sheetVel = step / Math.max(now - sheetLastT, 1);
      sheetLastY = cy;
      sheetLastT = now;
      var dy = cy - sheetDragY;

      if (sheetMode === null) {
        // Decided on the first move, before the browser can scroll the
        // content a few pixels on its own. Content scrolling is done BY
        // HAND ('handover'), never left to the browser: once a native
        // pan has begun no preventDefault stops it, so a gesture that
        // scrolled the content and then reversed onto the sheet had the
        // browser still scrolling the content while the sheet moved —
        // the content ran ahead of the sheet. Cancelling the first move
        // keeps the whole touch ours, and the release fling
        // (flingSheetContent) puts the native momentum back.
        if (dy === 0) return;
        if (dy > 0) {
          // downward: the sheet moves only once the content is at its top
          sheetMode = sheet.scrollTop <= 0 ? 'drag' : 'handover';
        } else {
          // upward: grow to full first; at full, scroll while the content
          // has room, otherwise pull straight into the rubber band
          var roomBelow = sheet.scrollTop < sheet.scrollHeight - sheet.clientHeight - 1;
          sheetMode = (sheet.classList.contains('is-full') && roomBelow) ? 'handover' : 'drag';
        }
        if (sheetMode === 'drag') {
          sheetDragY = cy; // start the sheet from under the finger
          dy = 0;
          sheet.style.transition = 'none';
        }
      }
      if (sheetMode === 'handover') {
        // the rest of the gesture scrolls the content, by hand (the
        // browser will not start a scroll mid-touch once a move has
        // been cancelled)
        if (e.cancelable) e.preventDefault();
        if (step > 0 && sheet.scrollTop <= 0) {
          // pulled back down to the top: the sheet is a drag again
          sheetMode = 'drag';
          sheetDragY = cy;
          sheetDragDelta = 0;
          sheet.style.transition = 'none';
          return;
        }
        if (step < 0 && sheet.scrollTop >= sheet.scrollHeight - sheet.clientHeight - 1) {
          // the content hit its bottom: hand over to the rubber band
          sheetMode = 'drag';
          sheetDragY = cy;
          sheetDragDelta = 0;
          sheet.style.transition = 'none';
          return;
        }
        sheet.scrollTop -= step;
        return;
      }

      if (sheetMode !== 'drag') return;
      if (e.cancelable) e.preventDefault(); // ours now, not a content scroll
      sheetDragDelta = dy;
      // the grab bar signals the direction: a v heading down, an up arrow
      // while the sheet still has room to grow, and flat at full
      // extension where only the rubber band is left
      if (sheetCardBase + dy <= -sheetMaxUp + 1) {
        sheetHandle.classList.remove('is-vee');
        sheetHandle.classList.remove('is-up');
      } else if (Math.abs(sheetVel) > 0.05) {
        sheetHandle.classList.toggle('is-vee', sheetVel > 0);
        sheetHandle.classList.toggle('is-up', sheetVel < 0);
      }
      // the dim thins the closer the sheet gets to the bottom edge
      document.documentElement.classList.add('ql-sheet-dragging');
      document.documentElement.style.setProperty('--sheet-dim',
        dy > 0 ? String(Math.max(0, 1 - dy / Math.max(sheetDragHeight, 1))) : '1');
      // and the search panel rises back in step with the pull
      if (ql.searchReturnState && ql.searchWrap) {
        var srFrac = dy > 0 ? Math.max(0, Math.min(1, dy / Math.max(sheetDragHeight, 1))) : 0;
        var srSizes = ql.srHeights();
        var srTarget = ql.searchReturnState === 'full' ? srSizes.full : srSizes.half;
        ql.searchWrap.classList.add('is-dragging');
        ql.searchWrap.style.height = (srSizes.bar + (srTarget - srSizes.bar) * srFrac) + 'px';
        // the two panels move together, so its chevron folds too: the
        // search rises as the sheet is pulled down, and sinks back if
        // the finger changes its mind
        if (Math.abs(sheetVel) > 0.05) ql.setSearchChevron(sheetVel > 0 ? 'up' : 'vee');
      }
      var y = sheetCardBase + dy;
      var canScroll = sheet.scrollHeight > sheet.clientHeight + 1;
      if (y <= -sheetMaxUp && canScroll && !sheet.classList.contains('is-full')) {
        // full height reached with content still to read: settle the
        // sheet at full instantly and keep the finger's momentum as
        // content scrolling, instead of bouncing at the rubber band
        sheet.style.transition = 'none';
        sheet.classList.add('is-full');
        setCardStop(false);
        sheetCardBase = 0;
        sheet.style.transform = '';
        sheetHandle.classList.remove('is-vee');
        sheetHandle.classList.remove('is-up');
        sheetHandle.classList.remove('is-stretching');
        sheetHandle.style.setProperty('--stretch', '1');
        document.documentElement.classList.remove('ql-sheet-dragging');
        document.documentElement.style.removeProperty('--sheet-dim');
        settleSearchUnderSheet();
        sheetDragDelta = 0;
        sheetShownY = 0;
        sheetMode = 'handover';
        sheet.scrollTop -= (y + sheetMaxUp);
        ql.positionMapControls();
        return;
      }
      if (y < -sheetMaxUp) {
        var band = rubber(-(y + sheetMaxUp), 48);
        y = -sheetMaxUp - band;
        // the flat bar stretches in step with the depth of the pull
        sheetHandle.classList.add('is-stretching');
        sheetHandle.style.setProperty('--stretch', String(1 + (band / 48) * 0.35));
      } else if (sheetHandle.classList.contains('is-stretching')) {
        sheetHandle.classList.remove('is-stretching');
        sheetHandle.style.setProperty('--stretch', '1');
      }
      sheetShownY = y;
      sheet.style.transform = 'translateY(' + y + 'px)';
      liftDuringDrag(y);
    };
    sheet.addEventListener('touchmove', onSheetTouchMove, { passive: false });

    sheet.addEventListener('touchend', endSheetDrag);
    sheet.addEventListener('touchcancel', endSheetDrag);

    // The grey backdrop above the sheet is a drag surface too: pull the
    // sheet down to dismiss, or up to grow it, straight from the dim.
    // A touch that starts on the backdrop can only mean sheet control,
    // so it drags with no slop; a plain tap still closes via the
    // existing click handler (drags suppress the click themselves).
    overlay.addEventListener('touchstart', function (e) {
      if (e.target !== overlay) return; // the sheet handles its own
      if (overlay.classList.contains('is-hidden')) return;
      onSheetTouchStart(e);
      if (sheetDragY === null) return; // start was refused (mid-morph)
      sheetMode = 'drag';
      sheet.style.transition = 'none';
    }, { passive: true });
    overlay.addEventListener('touchmove', function (e) {
      if (e.target !== overlay) return;
      onSheetTouchMove(e);
    }, { passive: false });
    overlay.addEventListener('touchend', function (e) {
      if (e.target === overlay) endSheetDrag();
    });
    overlay.addEventListener('touchcancel', function (e) {
      if (e.target === overlay) endSheetDrag();
    });

    // A mouse drags the sheet by its grab bar and head the way a finger
    // does; the content keeps the wheel and text selection. A phone also
    // fires mouse events after a tap, so those are ignored.
    var lastTouchAt = 0;
    var mouseMoved = false;
    sheet.addEventListener('touchstart', function () { lastTouchAt = Date.now(); }, { passive: true });
    sheet.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || !isSheet() || Date.now() - lastTouchAt < 800) return;
      if (!e.target.closest || !e.target.closest('.ql-sheet-handle, .ql-detail-top') || e.target.closest('button')) return;
      e.preventDefault();
      var asTouch = function (ev) {
        return { touches: [{ clientY: ev.clientY }], target: e.target, cancelable: true, preventDefault: function () {} };
      };
      onSheetTouchStart(asTouch(e));
      if (sheetDragY === null) return;
      var startY = e.clientY;
      mouseMoved = false;
      var move = function (ev) {
        if (Math.abs(ev.clientY - startY) > 3) mouseMoved = true;
        onSheetTouchMove(asTouch(ev));
      };
      var up = function () {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        endSheetDrag();
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    // a drag released over the backdrop is not a click on it
    overlay.addEventListener('click', function (e) {
      if (!mouseMoved) return;
      mouseMoved = false;
      e.stopPropagation();
    }, true);
  }

  var detailDoneBtn = document.getElementById('ql-detail-done');
  var detailDoneText = document.getElementById('ql-detail-done-text');

  function updateDetailDoneButton() {
    if (!detailDoneBtn || !state.activeQuest) return;
    var quest = state.activeQuest;
    syncDetailCodes(quest);
    var done = isDone(quest);
    // a per-unit quest counts with the stepper instead
    detailDoneBtn.classList.toggle('is-hidden', !!quest.repeat);
    if (quest.multi) {
      var all = tickedCodes(quest).length === quest.codes.length;
      detailDoneText.textContent = all ? 'Clear all' : (done ? 'Tick off the rest' : 'Tick off all');
      detailDoneBtn.classList.toggle('ql-button-accent', !all);
      detailDoneBtn.classList.toggle('is-done-btn', all);
      return;
    }
    detailDoneText.textContent = done ? 'Ticked off. Tap to undo' : 'Tick Off';
    detailDoneBtn.classList.toggle('ql-button-accent', !done);
    detailDoneBtn.classList.toggle('is-done-btn', done);
  }

  if (detailDoneBtn) {
    detailDoneBtn.addEventListener('click', function () {
      var quest = state.activeQuest;
      if (!quest) return;
      stopFlashCodes();
      if (quest.multi) {
        if (tickedCodes(quest).length === quest.codes.length) clearDone(quest); else setDone(quest);
      } else if (isDone(quest)) clearDone(quest);
      else setDone(quest);
      updateDetailDoneButton();
    });
  }

  // for the parts after this one
  ql.sheetMq = sheetMq;
  ql.mapCardEl = mapCardEl;
  ql.sheet = sheet;
});
