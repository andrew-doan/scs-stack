/* Submit a quest — teams sign in with their team name and submit
   code (handed out by organisers), pick a quest, attach proof and
   send it to the tab team. Uploads go straight to the tab worker;
   review happens in the console, and this page shows each
   submission's verdict. Sessions live in localStorage; every check
   is server-side. */
(function () {
  'use strict';

  var scs = window.scs;
  var TAB_API = scs.TAB_API;
  var TEAM_KEY = 'scs2-submit-team';
  var MAX_FILE_BYTES = 48 * 1024 * 1024;         // sent whole with the form
  var MAX_TOTAL_BYTES = 90 * 1024 * 1024;        // the create request's cap
  var MAX_BIG_BYTES = 4 * 1024 * 1024 * 1024;    // per file, sent in slices
  var NUDGE_BYTES = 500 * 1024 * 1024;           // past this, compressing first is kinder
  var UPLOADS_KEY = 'scs2-submit-uploads';       // unfinished large uploads, for resume
  var MAX_PICKS = 60;                            // the most one answer may list (the worker refuses more)
  // Whether files go from this phone straight to R2, every one in
  // slices, rather than through the worker. The worker says, once a
  // team is signed in; until it has, or if it cannot be asked, files go
  // the way they always have.
  var direct = false;

  var loginCard = document.getElementById('sub-login');
  var mainWrap = document.getElementById('sub-main');
  var statusEl = document.getElementById('sub-status');
  // The line changes several times through a send and once per file
  // through an upload, so it is written plainly: a blurred fade on each
  // one reads as the page doing something rather than as it reporting.
  function setStatus(text, queued) {
    if (!statusEl) return;
    statusEl.textContent = text == null ? '' : String(text);
    statusEl.classList.toggle('is-queued', !!queued);
  }
  var quests = [];      // the tab worker's quest list, one entry per quest
  var places = {};      // the place lists behind @stations / @sushi
  var picked = null;    // the chosen quest
  var files = [];       // chosen File objects
  var names = [];       // the name each will be sent under, typed over the file's own

  function getSession() { return scs.teamSession(); }
  function setSession(token, team) { scs.setTeamSession(token, team); }

  function show(signedIn) {
    loginCard.classList.toggle('is-hidden', signedIn);
    mainWrap.classList.toggle('is-hidden', !signedIn);
    scs.rise(signedIn ? mainWrap : loginCard);
    if (signedIn) {
      var team = '';
      try { team = localStorage.getItem(TEAM_KEY) || ''; } catch (err) { /* fine */ }
      document.getElementById('sub-team-name').textContent = team || 'your team';
      loadMine();
      loadScore();
      linkPush();
      checkResume();
      loadMode();
    }
  }

  function loadMode() {
    scs.fetch(TAB_API + '/api/submit/upload/mode', {
      headers: { authorization: 'Bearer ' + getSession() },
      cache: 'no-store'
    }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      direct = !!(d && d.ok && d.direct);
    }).catch(function () { /* through the worker, as before */ });
  }

  // If this device already gets notifications, re-post the
  // subscription with the team session attached so the worker knows
  // whose team the device belongs to — that link is what routes
  // verdict pushes to just this team.
  function linkPush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    navigator.serviceWorker.ready.then(function (reg) {
      return reg.pushManager.getSubscription();
    }).then(function (sub) {
      if (!sub) return;
      var body = sub.toJSON();
      body.label = scs.pushSub.label();
      return fetch(TAB_API + '/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + getSession() },
        body: JSON.stringify(body)
      });
    }).catch(function () { /* the link is a bonus, not a blocker */ });
  }

  function signedOut() {
    setSession('');
    show(false);
  }

  // ---------- sign in ----------
  var loginBtn = document.getElementById('sub-login-btn');
  var loginError = document.getElementById('sub-login-error');

  function doLogin() {
    scs.swapText(loginError, '');
    loginBtn.disabled = true;
    loginBtn.classList.add('is-busy');
    scs.postJson(TAB_API + '/api/submit/login', {
      team_name: document.getElementById('sub-team').value,
      code: document.getElementById('sub-code').value
    }).then(function (res) {
        loginBtn.disabled = false;
        loginBtn.classList.remove('is-busy');
        if (res.status === 200 && res.data.session) {
          setSession(res.data.session, res.data.team);
          document.getElementById('sub-code').value = '';
          show(true);
          loadPicker(true);
        } else {
          scs.swapText(loginError, res.data.error || 'Could not sign in.');
          scs.shake(loginCard);
        }
      })
      .catch(function () {
        loginBtn.disabled = false;
        loginBtn.classList.remove('is-busy');
        scs.swapText(loginError, 'Could not reach the tab. Try again.');
        scs.shake(loginCard);
      });
  }
  loginBtn.addEventListener('click', doLogin);
  document.getElementById('sub-code').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doLogin();
  });
  document.getElementById('sub-signout').addEventListener('click', function (e) {
    e.preventDefault();
    // the team's verdicts stop coming to this device with it
    scs.pushSub.unlink();
    signedOut();
  });

  // ---------- quest picker (the same list the quest page shows) ----------
  // Signing in asks again: a team may see quests the public
  // list does not have.
  function loadPicker(fresh) {
    scs.questList(fresh ? { fresh: true } : undefined).then(function (data) {
      places = data.places || {};
      quests.length = 0;
      data.groups.forEach(function (g) {
        if (!g.codes || !g.codes.length) return;
        quests.push({
          id: g.key, code: g.codes[0].code, name: g.name, codes: g.codes,
          submit: g.submit || 'none', prompt: g.prompt || '', options: g.options || [],
          questions: g.questions || null, rules: g.rules || null
        });
      });
      pickHashQuest();
    }).catch(function () { setStatus('The quest list could not load. Check your connection and reload.'); });
  }
  loadPicker(false);

  // /submit/#MQ1 arrives with the quest already chosen: the quest
  // sheet's Submit button and message embeds link here this way. The
  // hash matches the quest key or any of its codes.
  function pickHashQuest() {
    var raw = (location.hash || '').slice(1);
    if (!raw) return;
    var key;
    try { key = decodeURIComponent(raw); } catch (err) { key = raw; }
    var nk = scs.normQuest(key);
    if (!nk) return;
    for (var i = 0; i < quests.length; i++) {
      var q = quests[i];
      var hit = scs.normQuest(q.id) === nk;
      for (var k = 0; !hit && k < q.codes.length; k++) {
        if (scs.normQuest(q.codes[k].code) === nk) hit = true;
      }
      if (hit) { pickQuest(q); return; }
    }
  }
  window.addEventListener('hashchange', pickHashQuest);

  var searchInput = document.getElementById('sub-quest-search');
  var matchesEl = document.getElementById('sub-quest-matches');
  var pickedEl = document.getElementById('sub-quest-picked');
  var answerEl = document.getElementById('sub-answer');

  // Every match, best first, dropped out of the box: the shared loose
  // matcher finds a code anywhere ("18") and a name a letter or two
  // off. Past a screen's worth the panel scrolls rather than growing.
  function renderMatches() {
    var q = searchInput.value.trim();
    var hadMatches = matchesEl.childElementCount > 0;
    matchesEl.textContent = '';
    if (!q) { matchesEl.hidden = true; return; }
    matchesEl.hidden = false;
    var hits = scs.questSearch(quests, q);
    if (!hits.length) {
      var none = document.createElement('p');
      none.className = 'sub-none';
      none.textContent = 'No quests match.';
      matchesEl.appendChild(none);
      matchesEl.classList.remove('t-rise-list');
      return;
    }
    hits.forEach(function (quest) {
      var btn = document.createElement('button');
      btn.type = 'button';
      var code = document.createElement('span');
      code.className = 'code sub-match-code';
      code.textContent = quest.id;
      var name = document.createElement('span');
      name.className = 'sub-match-name';
      name.textContent = quest.name;
      btn.appendChild(code);
      btn.appendChild(name);
      btn.addEventListener('click', function () { pickQuest(quest); });
      matchesEl.appendChild(btn);
    });
    // the list rises in when it first appears, then sits still while
    // the search is refined
    matchesEl.classList.toggle('t-rise-list', !hadMatches);
  }

  function closeMatches() {
    matchesEl.textContent = '';
    matchesEl.hidden = true;
  }

  function pickQuest(quest) {
    picked = quest;
    closeMatches();
    searchInput.value = '';
    searchInput.classList.add('is-hidden');
    pickedEl.textContent = '';
    pickedEl.classList.remove('is-hidden');
    scs.rise(pickedEl);
    var chip = document.createElement('span');
    chip.className = 'code';
    chip.textContent = quest.id;
    var label = document.createElement('span');
    label.textContent = quest.name;
    var change = document.createElement('a');
    change.href = '#';
    change.textContent = 'change';
    change.addEventListener('click', function (e) {
      e.preventDefault();
      clearPick();
      searchInput.focus();
    });
    pickedEl.appendChild(chip);
    pickedEl.appendChild(label);
    pickedEl.appendChild(change);
    renderAnswerBox(quest);
    renderFileField(quest);
    loadTally(quest);
  }

  // keepTally leaves the count line up, for the send that clears the
  // pick and then refreshes it
  function clearPick(keepTally) {
    picked = null;
    searchInput.classList.remove('is-hidden');
    pickedEl.classList.add('is-hidden');
    answerEl.textContent = '';
    answerEl.classList.add('is-hidden');
    renderFileField(null);
    if (!keepTally) hideTally();
  }

  // ---------- a challenge's count ----------
  // A quest counted across everything the team sends for it, such as
  // the most stations, says under the quest what the team has so far.
  var tallyEl = document.getElementById('sub-tally');
  var tallyQuest = null;

  function isChallenge(quest) {
    return !!(quest && quest.rules && quest.rules.tally && quest.rules.tally.kind);
  }

  function hideTally() {
    tallyQuest = null;
    if (!tallyEl) return;
    tallyEl.textContent = '';
    tallyEl.classList.add('is-hidden');
  }

  function loadTally(quest) {
    if (!tallyEl || !isChallenge(quest) || !getSession()) { hideTally(); return; }
    tallyQuest = quest;
    scs.fetch(TAB_API + '/api/submit/tally?quest=' + encodeURIComponent(quest.id), {
      headers: { authorization: 'Bearer ' + getSession() },
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) throw new Error('tally ' + r.status);
      return r.json();
    }).then(function (data) {
      if (tallyQuest !== quest) return; // another quest was picked meanwhile
      if (!data || !data.ok || !(data.kind || data.frozen || data.closed)) throw new Error('tally shape');
      renderTally(quest, data);
    }).catch(function () {
      if (tallyQuest === quest) hideTally();
    });
  }

  function renderTally(quest, data) {
    tallyEl.textContent = '';
    var line = document.createElement('p');
    line.className = 'sub-tally-count';
    // once a send has cleared the pick, the line names its own quest
    if (picked !== quest) {
      var chip = document.createElement('span');
      chip.className = 'code';
      chip.textContent = quest.id;
      line.appendChild(chip);
    }
    var words = document.createElement('span');
    if (data.closed) words.textContent = 'Counts are hidden until the ceremony.';
    else if (data.frozen) words.textContent = 'Counts are frozen until the ceremony.';
    else {
      var highest = data.kind === 'highest';
      words.appendChild(document.createTextNode(highest ? 'Your highest: ' : 'Your count: '));
      var count = document.createElement('b');
      count.textContent = fmtPts(data.count);
      words.appendChild(count);
      var waiting = Number(data.waiting) || 0;
      if (waiting) words.appendChild(document.createTextNode(highest ? ' · ' + fmtPts(waiting) + ' sent, waiting for review' : ' · ' + fmtPts(waiting) + ' waiting for review'));
    }
    line.appendChild(words);
    tallyEl.appendChild(line);
    var items = (!data.frozen && !data.closed && data.items) || [];
    if (items.length) {
      var so = document.createElement('p');
      so.className = 'sub-hint sub-tally-items';
      so.textContent = 'So far: ' + items.join(', ');
      tallyEl.appendChild(so);
    }
    tallyEl.classList.remove('is-hidden');
  }

  // ---------- the quest's answer box ----------
  // What the quest asks for beyond the proof, one box per question: a
  // count, a line of text, one answer out of a few, places picked from
  // a list, or which of the quest's codes the team is claiming. Read
  // back by currentAnswer() when the form is sent.
  var answerRead = null;

  function expandOptions(q) {
    var out = [];
    q.options.forEach(function (o) {
      if (o === '@stations') out = out.concat(places.stations || []);
      else if (o === '@sushi') out = out.concat(places.sushi || []);
      else out.push(o);
    });
    return out;
  }

  function fieldLabel(text) {
    var label = document.createElement('label');
    label.className = 'sub-field';
    var span = document.createElement('span');
    span.textContent = text;
    label.appendChild(span);
    return label;
  }

  // A count is one control with a minus and a plus either side of the
  // box, both big enough for a thumb. The box stays a number input, so
  // a keyboard and the browser's own validation work as before.
  function stepper(input) {
    var wrap = document.createElement('span');
    wrap.className = 'sub-step';
    function arrow(label, by) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sub-step-btn';
      btn.textContent = by < 0 ? '−' : '+';
      btn.setAttribute('aria-label', label);
      btn.addEventListener('click', function () {
        var n = Math.round(Number(input.value));
        if (!isFinite(n)) n = 0;
        input.value = String(Math.max(0, n + by));
      });
      return btn;
    }
    wrap.appendChild(arrow('One fewer', -1));
    wrap.appendChild(input);
    wrap.appendChild(arrow('One more', 1));
    return wrap;
  }

  function questionsOf(quest) {
    if (quest.questions && quest.questions.length) return quest.questions;
    if (!quest.submit || quest.submit === 'none') return [];
    return [{ kind: quest.submit, prompt: quest.prompt, options: quest.options }];
  }

  function renderAnswerBox(quest) {
    answerEl.textContent = '';
    answerRead = null;
    var list = questionsOf(quest);
    if (!list.length) { answerEl.classList.add('is-hidden'); return; }
    answerEl.classList.remove('is-hidden');
    var many = list.length > 1;
    var reads = list.map(function (q, i) {
      var into = answerEl;
      if (many) {
        into = document.createElement('div');
        into.className = 'sub-q';
        answerEl.appendChild(into);
      }
      if (q.kind === 'count') return renderCount(q, into, i);
      if (q.kind === 'text') return renderText(q, into);
      if (q.kind === 'choice') return renderChoice(q, into, i);
      if (q.kind === 'pick') return renderPick(q, into);
      if (q.kind === 'codes') return renderCodes(q, into, quest);
      return null;
    });
    // the first answer at the top, the rest under more, each carrying
    // the question as it was worded
    answerRead = function () {
      var out = null;
      for (var i = 0; i < list.length; i++) {
        if (!reads[i]) continue;
        var got = reads[i]();
        if (got.error) return got;
        var entry = { kind: list[i].kind, value: got.value };
        if (many && list[i].prompt) entry.prompt = list[i].prompt;
        if (!out) { out = entry; if (many) out.more = []; } else out.more.push(entry);
      }
      return out;
    };
    scs.rise(answerEl);
  }

  function renderCount(q, into, i) {
    var countLabel = fieldLabel(q.prompt || 'How many?');
    var countInput = document.createElement('input');
    countInput.type = 'number';
    countInput.min = '0';
    countInput.step = '1';
    countInput.inputMode = 'numeric';
    countInput.id = i ? 'sub-answer-count-' + i : 'sub-answer-count';
    // The label has to name the box rather than wrap it: a label
    // wrapping several controls belongs to the first one, which here
    // would be the minus button.
    countLabel.htmlFor = countInput.id;
    countLabel.appendChild(stepper(countInput));
    into.appendChild(countLabel);
    return function () {
      var n = Number(countInput.value);
      if (countInput.value === '' || !isFinite(n) || n < 0) return { error: 'Enter a number' + (q.prompt ? ': ' + q.prompt : '.') };
      return { value: n };
    };
  }

  function renderText(q, into) {
    var textLabel = fieldLabel(q.prompt || 'Your answer');
    var textInput = document.createElement('input');
    textInput.type = 'text';
    textInput.maxLength = 500;
    textLabel.appendChild(textInput);
    into.appendChild(textLabel);
    return function () {
      var v = textInput.value.trim();
      if (!v) return { error: q.prompt ? 'Fill in: ' + q.prompt : 'Fill in the answer.' };
      return { value: v };
    };
  }

  // one answer out of a few: a tile each, the picked one in the sign's black
  function renderChoice(q, into, i) {
    var set = document.createElement('fieldset');
    set.className = 'sub-field sub-choice';
    var legend = document.createElement('legend');
    legend.textContent = q.prompt || 'Pick one';
    set.appendChild(legend);
    var tiles = document.createElement('div');
    tiles.className = 'sub-choice-opts';
    var inputs = [];
    q.options.forEach(function (o) {
      var tile = document.createElement('label');
      tile.className = 'sub-choice-opt';
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'sub-choice-' + i;
      input.value = o;
      input.addEventListener('change', function () {
        inputs.forEach(function (x) { x.parentNode.classList.toggle('is-selected', x.checked); });
      });
      var text = document.createElement('span');
      text.textContent = o;
      tile.appendChild(input);
      tile.appendChild(text);
      tiles.appendChild(tile);
      inputs.push(input);
    });
    set.appendChild(tiles);
    into.appendChild(set);
    return function () {
      var on = inputs.filter(function (x) { return x.checked; })[0];
      if (!on) return { error: 'Pick an answer' + (q.prompt ? ': ' + q.prompt : '.') };
      return { value: on.value };
    };
  }

  // places: a filter box over the list, chosen ones stack as chips
  function renderPick(q, into) {
    var all = expandOptions(q);
    var chosen = [];
    var label = fieldLabel(q.prompt || 'Which ones?');
    var input = document.createElement('input');
    input.type = 'search';
    input.autocomplete = 'off';
    input.placeholder = 'Name';
    label.appendChild(input);
    var results = document.createElement('div');
    results.className = 'sub-matches sub-pick-results';
    var chips = document.createElement('div');
    chips.className = 'sub-chips';
    into.appendChild(label);
    into.appendChild(results);
    into.appendChild(chips);

    function drawChips() {
      chips.textContent = '';
      chosen.forEach(function (name) {
        var chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'sub-chip';
        chip.textContent = name;
        chip.title = 'Remove';
        chip.addEventListener('click', function () {
          chosen.splice(chosen.indexOf(name), 1);
          drawChips();
        });
        chips.appendChild(chip);
      });
    }
    function drawResults() {
      var term = input.value.trim().toLowerCase();
      results.textContent = '';
      if (!term) return;
      if (chosen.length >= MAX_PICKS) {
        var full = document.createElement('p');
        full.className = 'sub-none';
        full.textContent = 'One submission takes at most ' + MAX_PICKS + '. Send the rest in another.';
        results.appendChild(full);
        return;
      }
      var hits = all.filter(function (name) {
        return chosen.indexOf(name) === -1 && name.toLowerCase().indexOf(term) !== -1;
      }).slice(0, 8);
      hits.forEach(function (name) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = name;
        btn.addEventListener('click', function () {
          if (chosen.length >= MAX_PICKS) return;
          chosen.push(name);
          input.value = '';
          drawResults();
          drawChips();
          input.focus();
        });
        results.appendChild(btn);
      });
    }
    input.addEventListener('input', drawResults);
    input.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      var first = results.querySelector('button');
      if (first) first.click();
    });
    return function () {
      if (!chosen.length) return { error: 'Pick at least one from the list' + (q.prompt ? ': ' + q.prompt : '.') };
      return { value: chosen.slice() };
    };
  }

  // codes: one rocker per code the quest can score
  function renderCodes(q, into, quest) {
    var head = document.createElement('p');
    head.className = 'sub-hint';
    head.textContent = q.prompt || 'Which of these are you claiming?';
    into.appendChild(head);
    var boxes = [];
    quest.codes.forEach(function (c) {
      var caption = document.createElement('span');
      var chip = document.createElement('span');
      chip.className = 'code';
      chip.textContent = c.code;
      caption.appendChild(chip);
      caption.appendChild(document.createTextNode(' ' + (c.label || quest.name) + ' (' + (c.points == null ? '???' : c.points) + ' pts)'));
      var r = scs.rocker('sub-check', caption);
      boxes.push({ code: c.code, input: r.input });
      into.appendChild(r.label);
    });
    return function () {
      var codes = boxes.filter(function (b) { return b.input.checked; }).map(function (b) { return b.code; });
      if (!codes.length) return { error: 'Tick at least one of the codes.' };
      return { value: codes };
    };
  }

  function currentAnswer() {
    return answerRead ? answerRead() : null;
  }

  searchInput.addEventListener('input', renderMatches);
  // The panel is over the page, so it has to be dismissible the way
  // everything else over a page is: Escape, a tap outside it, or Enter
  // on the best match. A mouse press inside it would take focus off the
  // box first, so the caret is held and the click still lands.
  searchInput.addEventListener('focus', renderMatches);
  searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeMatches(); return; }
    if (e.key !== 'Enter') return;
    var first = matchesEl.querySelector('button');
    if (!first) return;
    e.preventDefault();
    first.click();
  });
  matchesEl.addEventListener('mousedown', function (e) { e.preventDefault(); });
  document.addEventListener('click', function (e) {
    if (matchesEl.hidden) return;
    if (e.target.closest && e.target.closest('.sub-pick')) return;
    closeMatches();
  });

  // ---------- files ----------
  var filesInput = document.getElementById('sub-files');
  var fileList = document.getElementById('sub-file-list');
  var filesBtn = document.getElementById('sub-files-btn');
  var filesField = document.getElementById('sub-files-field');
  var filesLabel = document.getElementById('sub-files-label');
  var compressLink = document.querySelector('.sub-compress-link');
  var galleryRow = document.getElementById('sub-gallery-row');

  // What the picked quest takes: which kinds of file, how many, and
  // whether one is needed (`rules.files` in the quest list, the worker's
  // rules.js). A list from a worker without rules carries none, and then
  // the worker is the one to say.
  var KIND_ACCEPT = {
    photo: 'image/*', video: 'video/*',
    gpx: '.gpx,application/gpx+xml', pdf: '.pdf,application/pdf'
  };
  var KIND_ONE = { photo: 'photo', video: 'video', gpx: 'GPX track', pdf: 'PDF' };
  var KIND_MANY = { photo: 'photos', video: 'videos', gpx: 'GPX tracks', pdf: 'PDFs' };

  function fileRules(quest) {
    var f = quest && quest.rules && quest.rules.files;
    return f && Array.isArray(f.kinds) ? f : null;
  }
  function takesFiles(rules) {
    return !rules || (rules.kinds.length > 0 && rules.max > 0);
  }

  // the kind a file is, as the worker reads it: a GPX track usually
  // arrives with no useful type, so there the name decides
  function kindOf(file) {
    var type = String(file.type || '').toLowerCase().split(';')[0];
    if (type.indexOf('image/') === 0) return type === 'image/svg+xml' ? '' : 'photo';
    if (type.indexOf('video/') === 0) return 'video';
    if (type === 'application/pdf') return 'pdf';
    if (type === 'application/gpx+xml') return 'gpx';
    var ext = String(file.name || '').toLowerCase().split('.').pop();
    var vague = type === '' || type === 'application/octet-stream' || type === 'application/xml' || type === 'text/xml';
    return vague && (ext === 'gpx' || ext === 'pdf') ? ext : '';
  }

  // "a photo, video or GPX track"
  function kindsWords(kinds) {
    var list = kinds.map(function (k) { return KIND_ONE[k]; });
    var last = list.pop();
    return 'a ' + (list.length ? list.join(', ') + ' or ' + last : last);
  }
  // the field's name: "Photos or GPX tracks — up to 6", "A PDF"
  function fieldWords(rules) {
    var one = rules.max === 1;
    var list = rules.kinds.map(function (k) { return (one ? KIND_ONE : KIND_MANY)[k]; });
    var last = list.pop();
    var text = list.length ? list.join(', ') + ' or ' + last : last;
    text = one ? 'A ' + text : text.charAt(0).toUpperCase() + text.slice(1);
    var notes = [];
    if (!one) notes.push('up to ' + rules.max);
    if (!rules.required) notes.push('optional');
    return notes.length ? text + ' (' + notes.join(', ') + ')' : text;
  }

  // The file field as the picked quest has it: what the picker offers,
  // what its label says, the compress line for a quest that takes video,
  // the gallery switch for one that takes something the gallery shows,
  // and no field at all for a quest answered with its questions alone.
  function renderFileField(quest) {
    var rules = fileRules(quest);
    var kinds = rules ? rules.kinds : ['photo', 'video'];
    var takes = takesFiles(rules);
    var shows = kinds.indexOf('photo') !== -1 || kinds.indexOf('video') !== -1;
    filesField.classList.toggle('is-hidden', !takes);
    filesInput.accept = kinds.map(function (k) { return KIND_ACCEPT[k]; }).join(',');
    filesInput.multiple = !rules || rules.max > 1;
    filesLabel.textContent = rules && takes ? fieldWords(rules) : 'Photos or videos';
    compressLink.classList.toggle('is-hidden', kinds.indexOf('video') === -1);
    galleryRow.classList.toggle('is-hidden', !takes || !shows);
    if (!takes || !shows) document.getElementById('sub-gallery').checked = false;
    if (!takes) {
      files = [];
      names = [];
      filesInput.value = '';
      renderFiles();
    } else if (rules && files.length > rules.max) {
      files = files.slice(0, rules.max);
      names = names.slice(0, rules.max);
      setStatus('Only ' + rules.max + (rules.max === 1 ? ' file' : ' files') + ' can go in one submission for this quest.');
      renderFiles();
    }
  }

  // what Send refuses before anything goes, in the worker's own words
  function filesProblem(rules) {
    if (!rules) return files.length ? '' : 'Attach at least one photo or video.';
    if (files.length > rules.max) {
      return rules.max ? 'At most ' + rules.max + (rules.max === 1 ? ' file' : ' files') + ' per submission.' : 'This quest takes no files.';
    }
    if (rules.required && !files.length) return 'Attach ' + kindsWords(rules.kinds) + '.';
    for (var i = 0; i < files.length; i++) {
      if (rules.kinds.indexOf(kindOf(files[i])) === -1) return files[i].name + ' is not ' + kindsWords(rules.kinds) + '.';
    }
    return '';
  }

  function fmtBytes(n) {
    if (n > 1024 * 1024 * 1024) return (Math.round(n / (1024 * 1024 * 1024) * 10) / 10) + ' GB';
    if (n > 1024 * 1024) return (Math.round(n / (1024 * 1024) * 10) / 10) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  // a file's name is typed over before it goes: the box holds the
  // part before the extension, the extension stays as it was
  function splitName(name) {
    var m = /^(.*?)(\.[A-Za-z0-9]{1,5})$/.exec(String(name || ''));
    return m ? { base: m[1], ext: m[2] } : { base: String(name || ''), ext: '' };
  }
  function fileName(i) {
    var parts = splitName(files[i].name);
    var typed = String(names[i] || '').trim().replace(/[\\/:*?"<>|]/g, '');
    return (typed || parts.base || 'proof') + parts.ext;
  }

  function renderFiles() {
    fileList.textContent = '';
    var most = fileRules(picked);
    filesBtn.textContent = !files.length ? 'Choose files' : most && most.max === 1 ? 'Choose another' : 'Add more';
    files.forEach(function (file, i) {
      var li = document.createElement('li');
      var name = document.createElement('span');
      name.className = 'sub-file-name';
      var parts = splitName(file.name);
      var box = document.createElement('input');
      box.type = 'text';
      box.className = 'sub-file-rename';
      box.value = names[i] !== undefined ? names[i] : parts.base;
      box.setAttribute('aria-label', 'File name');
      box.maxLength = 100;
      box.addEventListener('input', function () { names[i] = box.value; });
      var ext = document.createElement('span');
      ext.className = 'sub-file-ext';
      ext.textContent = parts.ext;
      name.appendChild(box);
      name.appendChild(ext);
      var size = document.createElement('span');
      size.className = 'sub-file-size';
      li.appendChild(name);
      li.appendChild(size);
      // takes one file back off without picking them all again
      var drop = document.createElement('button');
      drop.type = 'button';
      drop.className = 'sub-file-drop';
      drop.setAttribute('aria-label', 'Remove ' + file.name);
      drop.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
        'stroke-width="2" stroke-linecap="round" aria-hidden="true">' +
        '<path d="M6 6 18 18"/><path d="M18 6 6 18"/></svg>';
      drop.addEventListener('click', function () { dropFile(i); });
      li.appendChild(drop);
      if (file.size > MAX_BIG_BYTES) {
        li.className = 'is-too-big is-long';
        size.textContent = fmtBytes(file.size) + ', over 4GB';
      } else if (file.size > MAX_FILE_BYTES) {
        size.textContent = fmtBytes(file.size) + ', uploads in the background';
        li.classList.add('is-long');
        if (file.size > NUDGE_BYTES && kindOf(file) === 'video') {
          // big enough that shrinking it first beats waiting it out
          var nudge = document.createElement('span');
          nudge.className = 'sub-file-nudge';
          var link = document.createElement('a');
          link.href = '../compress/';
          link.textContent = 'Compressing it';
          nudge.appendChild(link);
          nudge.appendChild(document.createTextNode(' first would make this upload much faster.'));
          li.appendChild(nudge);
        }
      } else {
        size.textContent = fmtBytes(file.size);
      }
      fileList.appendChild(li);
    });
  }

  function dropFile(i) {
    files.splice(i, 1);
    names.splice(i, 1);
    renderFiles();
  }

  // a pick adds to the files already listed, leaving out one listed
  // already; a quest that takes one file has it replaced
  filesInput.addEventListener('change', function () {
    var picks = Array.prototype.slice.call(filesInput.files, 0);
    filesInput.value = '';
    if (!picks.length) return;
    // the picked quest's most; with no quest picked yet the worker decides
    var rules = fileRules(picked);
    if (rules && rules.max === 1) {
      files = [];
      names = [];
    }
    var fresh = picks.filter(function (f) {
      return !files.some(function (g) { return g.name === f.name && g.size === f.size && g.lastModified === f.lastModified; });
    });
    var all = files.concat(fresh);
    files = rules ? all.slice(0, rules.max) : all;
    if (files.length < all.length) {
      setStatus('Only ' + rules.max + (rules.max === 1 ? ' file' : ' files') + ' can go in one submission.');
    }
    renderFiles();
    convertPicked();
  });

  // A HEIC or WebP photo is redrawn as JPEG as soon as it is picked
  // (scs.toJpeg), so the row shows what will actually go and Send waits
  // for it. One that cannot be redrawn goes as it was: the worker takes
  // either for proof, only at a smaller size. The JPEG carries the file
  // it was made from as .picked, which goes up beside it.
  var converting = 0;
  var pickRound = 0;
  function convertPicked() {
    var round = ++pickRound;
    var todo = files.filter(scs.needsConverting);
    if (!todo.length) return;
    converting++;
    setStatus(todo.length === 1 ? 'Converting ' + todo[0].name + ' to JPEG…' : 'Converting ' + todo.length + ' photos to JPEG…');
    Promise.all(todo.map(function (file) {
      return scs.toJpeg(file).then(function (jpeg) { return [file, jpeg]; }, function () { return [file, null]; });
    })).then(function (pairs) {
      converting--;
      if (round !== pickRound) return;
      var failed = [];
      pairs.forEach(function (pair) {
        var i = files.indexOf(pair[0]);
        if (i === -1) return;
        if (pair[1] && scs.pickedType(pair[0])) pair[1].picked = pair[0];
        if (pair[1]) files[i] = pair[1]; else failed.push(pair[0].name);
      });
      renderFiles();
      setStatus(failed.length ? 'Could not convert ' + failed.join(', ') + ' to JPEG, so it will go as it is.' : '');
    });
  }

  // ---------- previews for upload ----------
  // The worker cannot resize photos, so this browser makes the small
  // copy before sending: photos scaled to 480px on the long edge, and
  // a frame grabbed from each video, as light JPEGs. Any failure just
  // means no preview for that file.
  var THUMB_EDGE = 480;
  var VIEW_EDGE = 1920;   // a photo's viewing copy: full quality on a projector
  var VIEW_MAX = 2 * 1024 * 1024;
  var THUMB_MAX = 300 * 1024;

  function drawScaled(source, w, h, edge, quality) {
    return new Promise(function (resolve) {
      var scale = Math.min(1, edge / Math.max(w, h));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) { resolve(blob || null); }, 'image/jpeg', quality);
    });
  }

  function drawThumb(source, w, h) {
    return drawScaled(source, w, h, THUMB_EDGE, 0.72);
  }

  function imageThumb(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        drawThumb(img, img.naturalWidth, img.naturalHeight).then(function (blob) {
          URL.revokeObjectURL(url);
          resolve(blob);
        });
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function videoThumb(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var video = document.createElement('video');
      var settled = false;
      function finish(blob) {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(blob);
      }
      var timer = window.setTimeout(function () { finish(null); }, 3000);
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.addEventListener('loadeddata', function () {
        try { video.currentTime = Math.min(0.1, video.duration || 0.1); } catch (err) { /* draw where it is */ }
        window.setTimeout(function () {
          if (!video.videoWidth) { window.clearTimeout(timer); return finish(null); }
          drawThumb(video, video.videoWidth, video.videoHeight).then(function (blob) {
            window.clearTimeout(timer);
            finish(blob);
          });
        }, 250);
      });
      video.addEventListener('error', function () { window.clearTimeout(timer); finish(null); });
      video.src = url;
    });
  }

  // A GIF is skipped by both makers: drawing one onto a canvas gives
  // the first frame, and the worker will not store a still in place of
  // an animation, so making one is upload bytes spent on nothing.
  function moves(file) {
    return String(file && file.type || '').toLowerCase() === 'image/gif';
  }

  function makeThumbs(list) {
    return Promise.all(list.map(function (file) {
      var kind = String(file.type || '');
      if (moves(file)) return Promise.resolve(null);
      if (kind.indexOf('image/') === 0) return imageThumb(file);
      if (kind.indexOf('video/') === 0) return videoThumb(file);
      return Promise.resolve(null);
    })).catch(function () { return list.map(function () { return null; }); });
  }

  // A photo's viewing copy: the lightbox, slideshow and review
  // previews show this instead of the multi-megabyte original. Only
  // sent when it is clearly lighter than the original — a photo that
  // is already small keeps just its full file.
  function imageView(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        drawScaled(img, img.naturalWidth, img.naturalHeight, VIEW_EDGE, 0.8).then(function (blob) {
          URL.revokeObjectURL(url);
          // Sent whatever it weighs, as long as it fits. It used to
          // be held back unless it was clearly lighter than the
          // original, which meant a small photo had no copy at all —
          // and a request for a smaller one then fell through to the
          // file the camera wrote, metadata and all.
          var worth = blob && blob.size > 0 && blob.size <= VIEW_MAX;
          resolve(worth ? blob : null);
        });
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  function makeViews(list) {
    return Promise.all(list.map(function (file) {
      if (!moves(file) && String(file.type || '').indexOf('image/') === 0) return imageView(file);
      return Promise.resolve(null); // videos get their copies from the encoder
    })).catch(function () { return list.map(function () { return null; }); });
  }

  // the most the previews of these files can add to a request, with a
  // viewing copy for each photo when `views`
  function previewBytes(list, views) {
    var n = 0;
    list.forEach(function (file) {
      n += THUMB_MAX;
      if (views && !moves(file) && String(file.type || '').indexOf('image/') === 0) n += VIEW_MAX;
    });
    return n;
  }

  // ---------- send ----------
  var sendBtn = document.getElementById('sub-send');
  var progressWrap = document.getElementById('sub-progress');
  var progressBar = document.getElementById('sub-progress-bar');
  // True from the moment Send is pressed until the create request has
  // answered. What is in flight then — the form, the answer, the
  // previews and every file small enough to ride with them — exists
  // nowhere but this page, so it is the one thing here that cannot be
  // picked back up.
  var sending = false;

  sendBtn.addEventListener('click', function () {
    setStatus('');
    if (!picked) { setStatus('Pick a quest first.'); return; }
    var answer = currentAnswer();
    if (answer && answer.error) { setStatus(answer.error); return; }
    var fileProblem = filesProblem(fileRules(picked));
    if (fileProblem) { setStatus(fileProblem); return; }
    if (converting) { setStatus('Wait for the photos to finish converting to JPEG.'); return; }
    // small files ride the create request; big ones follow in slices
    var inline = [];
    var inlineNames = [];
    var bigs = [];
    var bigNames = [];
    var total = 0;
    for (var i = 0; i < files.length; i++) {
      if (files[i].size > MAX_BIG_BYTES) {
        setStatus('One of those files is over 4GB. Compress it first.');
        return;
      }
      if (direct || files[i].size > MAX_FILE_BYTES) { bigs.push(files[i]); bigNames.push(fileName(i)); continue; }
      inline.push(files[i]);
      inlineNames.push(fileName(i));
      total += files[i].size;
    }
    // The files, their previews and the form share one request. When
    // they could go past its cap, every file follows the create in
    // slices instead.
    var whole = direct;
    if (inline.length && total + previewBytes(inline, true) + previewBytes(bigs, whole) > MAX_TOTAL_BYTES) {
      whole = true;
      bigs = files.slice();
      bigNames = files.map(function (f, k) { return fileName(k); });
      inline = [];
      inlineNames = [];
      total = 0;
    }

    // held now: the picker is cleared the moment the send lands, and
    // the uploads that follow still have to say what they are for
    var questCode = picked.code;
    var sentQuest = picked;
    var form = new FormData();
    form.append('quest', questCode);
    if (answer) form.append('answer', JSON.stringify(answer));
    form.append('note', document.getElementById('sub-note').value);
    if (document.getElementById('sub-gallery').checked) form.append('gallery', '1');
    inline.forEach(function (file, k) { form.append('files', file, inlineNames[k]); });
    if (whole) form.append('whole', '1');
    // The HEIC or WebP a JPEG was made from goes up beside it: in this
    // request while the request has room, or, for a file going straight
    // to R2, named here and sent after its slices.
    var room = MAX_TOTAL_BYTES - total - previewBytes(inline, true) - previewBytes(bigs, whole);
    function twinFits(f) {
      var twin = f.picked;
      if (!twin || twin.size > MAX_FILE_BYTES || twin.size > room) return null;
      room -= twin.size;
      return twin.slice(0, twin.size, scs.pickedType(twin));
    }
    inline.forEach(function (file, k) {
      var twin = twinFits(file);
      if (twin) form.append('picked' + k, twin, file.picked.name);
    });
    if (bigs.length) {
      form.append('bigfiles', JSON.stringify(bigs.map(function (f, k) {
        var entry = { name: bigNames[k], type: f.type, size: f.size };
        if (f.picked && whole && f.picked.size <= MAX_FILE_BYTES) entry.picked = { type: scs.pickedType(f.picked), size: f.picked.size };
        return entry;
      })));
      if (!direct) {
        bigs.forEach(function (f, k) {
          var twin = twinFits(f);
          if (twin) form.append('bigpicked' + k, twin, f.picked.name);
        });
      }
    }

    // A send worth watching gets the upload box as well as the thin bar
    // by the button: a handful of phone photos is tens of megabytes and
    // minutes on a venue connection, and the bar alone does not say how
    // far through that is.
    var sendRow = null;
    if (total > DETAIL_BYTES) {
      openUploads();
      sendRow = addUploadRow(questCode, inline.length === 1 ? inlineNames[0] : inline.length + ' files');
      setRow(sendRow, 0, 'Starting');
    }

    var xhr = new XMLHttpRequest();
    xhr.open('POST', TAB_API + '/api/submit/create');
    xhr.setRequestHeader('authorization', 'Bearer ' + getSession());
    xhr.upload.onprogress = function (e) {
      if (!e.lengthComputable) return;
      progressBar.style.width = Math.round(e.loaded / e.total * 100) + '%';
      // slices still going from an earlier send have the tab's title
      if (!uploadsRunning) titleProgress(e.loaded / e.total);
      if (sendRow) setRow(sendRow, e.loaded / e.total, fmtBytes(e.loaded) + ' of ' + fmtBytes(e.total));
    };
    xhr.onload = function () {
      sending = false;
      // whatever follows re-arms it: runUploads takes it straight back
      // over for the slices, in this same turn, so nothing flickers
      if (!uploadsRunning) setRun('send', false);
      sendBtn.disabled = false;
      sendBtn.classList.remove('is-busy');
      progressWrap.classList.add('is-hidden');
      var data = {};
      try { data = JSON.parse(xhr.responseText); } catch (err) { /* not JSON */ }
      if (xhr.status === 401) { signedOut(); return; }
      if (xhr.status === 200 && data.ok) {
        var ups = data.uploads || [];
        var sentLine = 'Sent: ' + data.quest + (data.files ? ', ' + data.files + (data.files === 1 ? ' file' : ' files') : '') + '.';
        // past the team's review cap the tab still takes it, and says so
        var queuedNote = data.queued ? 'Queued: it goes to review once fewer of your submissions are waiting.' : '';
        setStatus(queuedNote ? sentLine + ' ' + queuedNote : sentLine, !!queuedNote);
        // a challenge's count stays up, and shows this one as waiting
        clearPick(isChallenge(sentQuest));
        if (isChallenge(sentQuest)) loadTally(sentQuest);
        files = [];
        names = [];
        filesInput.value = '';
        document.getElementById('sub-note').value = '';
        document.getElementById('sub-gallery').checked = false;
        renderFiles();
        loadMine();
        loadScore();
        if (ups.length) {
          if (sendRow) setRow(sendRow, 1, 'Sent · ' + fmtBytes(total), true);
          // a row per large file, in a box cleared first unless an earlier
          // send's slices are still going
          runUploads(ups.map(function (u, k) {
            return { entry: rememberUpload(u, bigNames[k], questCode), file: bigs[k], doneParts: [],
              twin: u.direct && u.picked ? bigs[k].picked : null };
          }), queuedNote);
        } else if (sendRow) {
          setRow(sendRow, 1, 'Sent · ' + fmtBytes(total), true);
          endUploads('Upload finished');
        }
      } else {
        setStatus(data.error || 'That did not go through. Try again.');
        if (sendRow) {
          if (uploadsRunning) setRow(sendRow, 0, 'Stopped');
          endUploads('Upload stopped', 'The tab team did not take that one. Nothing was sent.');
        }
      }
    };
    xhr.onerror = function () {
      sending = false;
      if (!uploadsRunning) setRun('send', false);
      sendBtn.disabled = false;
      sendBtn.classList.remove('is-busy');
      progressWrap.classList.add('is-hidden');
      // the files may have reached the tab before the connection went,
      // so the list is asked again rather than the send called lost
      setStatus('The connection dropped. Check Already sent before sending again.');
      if (sendRow) {
        if (uploadsRunning) setRow(sendRow, 0, 'Stopped');
        endUploads('Upload stopped', 'The connection dropped before the tab answered. If it is not under Already sent, send it again.');
      }
      loadMine();
    };
    sending = true;
    sendBtn.disabled = true;
    sendBtn.classList.add('is-busy');
    progressBar.style.width = '0%';
    progressWrap.classList.remove('is-hidden');
    // the previews are made before a byte goes, and there is nothing to
    // count while they are: the segment shuttles rather than sitting at
    // nothing, which reads as stopped
    if (!uploadsRunning) setRun('send', true, null);
    // previews for every file, the big ones included — theirs is all
    // the tab team sees until the slices land
    Promise.all([makeThumbs(inline), makeThumbs(bigs), makeViews(inline), whole ? makeViews(bigs) : []]).then(function (made) {
      made[0].forEach(function (blob, k) {
        if (blob && blob.size > 0 && blob.size <= THUMB_MAX) form.append('thumb' + k, blob, 'thumb.jpg');
      });
      made[1].forEach(function (blob, k) {
        if (blob && blob.size > 0 && blob.size <= THUMB_MAX) form.append('bigthumb' + k, blob, 'thumb.jpg');
      });
      made[2].forEach(function (blob, k) {
        if (blob) form.append('view' + k, blob, 'view.jpg');
      });
      made[3].forEach(function (blob, k) {
        if (blob) form.append('bigview' + k, blob, 'view.jpg');
      });
      xhr.send(form);
    });
  });

  // ---------- what is going up right now ----------
  // A large upload used to report itself in one status line beside the
  // Send button. That is easy to miss, and after the page had been
  // closed and reopened it said nothing at all about what was in
  // flight — so choosing the file again looked like it had done
  // nothing, and the empty quest picker beside it looked like the thing
  // to fix. This box is the whole report instead: which quest, which
  // file, how much of it has gone, and what closing the page does.
  var DETAIL_BYTES = 5 * 1024 * 1024;   // under this it is over before a count could be read
  var uploadsBox = document.getElementById('sub-uploads');
  var uploadsList = document.getElementById('sub-up-list');
  var uploadsTitle = uploadsBox ? uploadsBox.querySelector('.sub-up-title') : null;
  var uploadsWarn = uploadsBox ? uploadsBox.querySelector('.sub-up-warn') : null;

  // An upload says so in the browser's tab title (the script below this
  // one), which is the only thing a page in the background can say.
  function setRun(which, running, pct) {
    document.dispatchEvent(new CustomEvent('scs-run', {
      detail: { which: which, running: !!running, pct: pct == null ? null : pct }
    }));
  }

  // one row per file, built once and then only written to
  function uploadRow(quest, name) {
    var row = document.createElement('div');
    row.className = 'sub-up-row';
    var head = document.createElement('div');
    head.className = 'sub-up-head';
    if (quest) {
      var chip = document.createElement('span');
      chip.className = 'sub-up-quest';
      chip.textContent = quest;
      head.appendChild(chip);
    }
    var label = document.createElement('span');
    label.className = 'sub-up-name';
    label.textContent = name || 'file';
    head.appendChild(label);
    var bar = document.createElement('span');
    bar.className = 'sub-progress';
    var fill = document.createElement('span');
    bar.appendChild(fill);
    var count = document.createElement('p');
    count.className = 'sub-up-count';
    row.appendChild(head);
    row.appendChild(bar);
    row.appendChild(count);
    row.fill = fill;
    row.count = count;
    return row;
  }

  // A send can be made while an earlier one's slices are still going,
  // and a resumed file can join them: the box is cleared only when
  // nothing in it is still running, and settles when the last one ends.
  var keepOpenLine = uploadsWarn ? uploadsWarn.textContent : '';
  function openUploads() {
    if (!uploadsBox) return;
    if (!uploadsRunning) uploadsList.textContent = '';
    uploadsBox.classList.remove('is-hidden', 'is-stopped', 'is-settled');
    uploadsTitle.textContent = 'Uploading';
    // a stopped upload left its own line here
    uploadsWarn.textContent = keepOpenLine;
    uploadsWarn.classList.remove('is-hidden');
  }
  function endUploads(title, warning) {
    if (!uploadsBox || uploadsRunning) return;
    uploadsTitle.textContent = title;
    uploadsBox.classList.add('is-settled');
    uploadsBox.classList.toggle('is-stopped', !!warning);
    if (warning) uploadsWarn.textContent = warning;
    else uploadsWarn.classList.add('is-hidden');
    setRun('send', false);
  }
  // built and hung in the box in one step, so every caller is safe on
  // a page whose markup predates the box
  function addUploadRow(quest, name) {
    if (!uploadsBox) return null;
    var row = uploadRow(quest, name);
    uploadsList.appendChild(row);
    return row;
  }
  function setUploadTitle(text) {
    if (uploadsTitle) uploadsTitle.textContent = text;
  }
  function setRow(row, fraction, text, done) {
    if (!row) return;
    var pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    row.fill.style.width = pct + '%';
    row.count.textContent = text;
    row.classList.toggle('is-done', !!done);
  }
  // the browser's tab strip is the one place a page nobody is looking
  // at still speaks, so the share of the whole job goes in the title
  // while it runs — setRun, below, owns that now
  function titleProgress(fraction) {
    setRun('send', true, Math.max(0, Math.min(1, fraction)) * 100);
  }
  function showUploads() {
    if (!uploadsBox) return;
    uploadsBox.scrollIntoView({ block: 'center', behavior: scs.reducedMotion ? 'auto' : 'smooth' });
  }

  // ---------- large files: slices, after the submission exists ----------
  // The worker knows the file from the create call; what follows is
  // 20MB slices, one at a time, each retried on its own. The list of
  // unfinished uploads sits in localStorage so a closed page can carry
  // on — the worker keeps the slices that landed.
  var uploadsRunning = 0;

  function storedUploads() {
    try { return JSON.parse(localStorage.getItem(UPLOADS_KEY) || '[]') || []; } catch (err) { return []; }
  }
  function saveUploads(list) {
    try { localStorage.setItem(UPLOADS_KEY, JSON.stringify(list)); } catch (err) { /* no resume then */ }
  }
  // the quest rides along: a file picked up days later has to be able
  // to say what it is proof of without the page guessing; and the team,
  // since another team signed in on this phone cannot ask about it
  function rememberUpload(u, name, quest) {
    var entry = { file: u.file, name: name, size: u.size, part_size: u.part_size, quest: quest || '', direct: !!u.direct, team: teamNow() };
    var list = storedUploads();
    list.push(entry);
    saveUploads(list);
    return entry;
  }
  function teamNow() {
    try { return localStorage.getItem(TEAM_KEY) || ''; } catch (err) { return ''; }
  }
  function sameTeam(a, b) {
    return !!a && !!b && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
  }
  function forgetUpload(id) {
    saveUploads(storedUploads().filter(function (e) { return e.file !== id; }));
  }

  // Which stored uploads a page is sending right now, so another tab
  // does not offer them as broken off: each sending page stamps its
  // files every slice and every 20 seconds, and a stamp older than three
  // minutes (a tab that closed or crashed) counts for nothing.
  var CLAIMS_KEY = 'scs2-submit-claims';
  var CLAIM_FRESH = 3 * 60 * 1000;
  var claimed = {};
  function readClaims() {
    try { return JSON.parse(localStorage.getItem(CLAIMS_KEY) || '{}') || {}; } catch (err) { return {}; }
  }
  function writeClaims(drop) {
    var all = readClaims();
    var now = Date.now();
    Object.keys(all).forEach(function (id) {
      if (now - all[id] > CLAIM_FRESH || (drop && drop[id])) delete all[id];
    });
    Object.keys(claimed).forEach(function (id) { if (!(drop && drop[id])) all[id] = now; });
    try { localStorage.setItem(CLAIMS_KEY, JSON.stringify(all)); } catch (err) { /* not shared */ }
  }
  function claimUpload(id) { claimed[id] = true; writeClaims(); }
  function releaseUpload(id) {
    var drop = {};
    drop[id] = true;
    delete claimed[id];
    writeClaims(drop);
  }
  function sentElsewhere(id) {
    if (claimed[id]) return false;
    var at = readClaims()[id];
    return !!at && Date.now() - at < CLAIM_FRESH;
  }
  window.setInterval(function () { if (Object.keys(claimed).length) writeClaims(); }, 20000);
  // a page going away gives its files up at once, so a reload offers them
  window.addEventListener('pagehide', function () { writeClaims(claimed); });
  window.addEventListener('pageshow', function (e) {
    if (e.persisted && Object.keys(claimed).length) writeClaims();
  });

  function putPart(entry, n, blob) {
    if (entry.direct) return putDirect(entry, n, blob);
    return fetch(TAB_API + '/api/submit/upload/part?file=' + entry.file + '&n=' + n, {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + getSession() },
      body: blob
    }).then(function (r) {
      if (r.status === 401) { signedOut(); throw new Error('signed out'); }
      if (!r.ok) throw new Error('part failed');
    });
  }

  // A slice that goes straight to R2: the worker signs an address for
  // it, good for a quarter of an hour, and the slice is sent there with
  // nothing else on the request. A new address is asked for on every
  // try, so a retry long after the first is not turned away as expired.
  function putDirect(entry, n, blob) {
    return scs.fetch(TAB_API + '/api/submit/upload/sign?file=' + entry.file + '&n=' + n, {
      headers: { authorization: 'Bearer ' + getSession() },
      cache: 'no-store'
    }).then(function (r) {
      if (r.status === 401) { signedOut(); throw new Error('signed out'); }
      if (!r.ok) throw new Error('sign failed');
      return r.json();
    }).then(function (d) {
      return fetch(d.url, { method: 'PUT', body: blob });
    }).then(function (r) {
      if (!r.ok) throw new Error('part failed');
    });
  }

  // The file a photo going straight to R2 was picked as, sent whole to
  // the address the worker signs for it, before the finish reads it.
  // One that does not get there leaves the photo without it.
  function putTwin(entry, twin, tries) {
    if (!twin) return Promise.resolve();
    return scs.fetch(TAB_API + '/api/submit/upload/sign?file=' + entry.file + '&picked=1', {
      headers: { authorization: 'Bearer ' + getSession() },
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) throw new Error('sign failed');
      return r.json();
    }).then(function (d) {
      return fetch(d.url, { method: 'PUT', body: twin.slice(0, twin.size, '') });
    }).then(function (r) {
      if (!r.ok) throw new Error('part failed');
    }).catch(function () {
      if (tries >= 2) return;
      return new Promise(function (res) { window.setTimeout(res, 1500 * (tries + 1)); })
        .then(function () { return putTwin(entry, twin, tries + 1); });
    });
  }

  // one file: every missing slice in order, three tries each, then
  // finish. onSlice fires once per slice, the ones already on the
  // worker included, so a resumed file jumps straight to where it left
  // off rather than starting its bar at nothing.
  function uploadBig(entry, file, doneParts, onSlice, twin) {
    var totalParts = Math.max(1, Math.ceil(entry.size / entry.part_size));
    var have = {};
    (doneParts || []).forEach(function (n) { have[n] = true; });
    var n = 0;
    function next() {
      n += 1;
      if (n > totalParts) {
        return putTwin(entry, twin, 0).then(function () {
          return scs.postJson(TAB_API + '/api/submit/upload/finish', { file: entry.file }, getSession());
        }).then(function (res) {
          if (res.status === 401) { signedOut(); throw new Error('signed out'); }
          if (res.status === 200 && res.data.ok) return;
          var err = new Error(res.data.error || 'finish failed');
          // turned down for good (the file is not what it says, or it has
          // gone); a 409 can be slices still missing, which a resume sends
          if (res.status >= 400 && res.status < 500 && res.status !== 409 && res.status !== 429) err.name = 'Refused';
          throw err;
        });
      }
      if (have[n]) { onSlice(); return next(); }
      var blob = file.slice((n - 1) * entry.part_size, Math.min(n * entry.part_size, entry.size), entry.direct ? '' : file.type);
      var tries = 0;
      function attempt() {
        return putPart(entry, n, blob).catch(function (err) {
          if (err && err.message === 'signed out') throw err;
          tries += 1;
          if (tries >= 3) throw err;
          return new Promise(function (res) { window.setTimeout(res, 1500 * tries * tries); }).then(attempt);
        });
      }
      return attempt().then(function () { onSlice(); return next(); });
    }
    return next();
  }

  // the queue: files one after another, a row each in the upload box
  // queuedNote: what the status line says about a send queued past the
  // team's review cap, kept to the end so the uploads do not wipe it
  // every run of slices still going, for the share of the whole that
  // goes in the tab's title
  var upRuns = [];
  function runsShare() {
    var done = 0;
    var total = 0;
    upRuns.forEach(function (r) { done += r.done; total += r.total; });
    return total ? done / total : 0;
  }

  function runUploads(jobs, queuedNote) {
    if (!jobs.length) return;
    progressWrap.classList.add('is-hidden');
    openUploads();
    var run = { done: 0, total: 0 };
    upRuns.push(run);
    uploadsRunning += 1;
    jobs.forEach(function (job) {
      job.parts = Math.max(1, Math.ceil(job.entry.size / job.entry.part_size));
      job.sent = 0;
      run.total += job.parts;
      job.row = addUploadRow(job.entry.quest, job.entry.name);
      setRow(job.row, 0, jobs.length > 1 ? 'Waiting its turn' : 'Starting');
      claimUpload(job.entry.file);
    });
    titleProgress(runsShare());

    function line(job) {
      var bytes = Math.min(job.entry.size, job.sent * job.entry.part_size);
      return 'Slice ' + job.sent + ' of ' + job.parts + ' \u00b7 ' +
        fmtBytes(bytes) + ' of ' + fmtBytes(job.entry.size);
    }
    function tick(job) {
      job.sent += 1;
      run.done += 1;
      setRow(job.row, job.sent / job.parts, line(job));
      titleProgress(runsShare());
      claimUpload(job.entry.file);
    }
    function finish() {
      upRuns.splice(upRuns.indexOf(run), 1);
      uploadsRunning -= 1;
      jobs.forEach(function (job) { releaseUpload(job.entry.file); });
    }

    var at = 0;
    // what the tab turned down for good, in its own words
    var turnedDown = [];
    function nextJob() {
      if (at >= jobs.length) {
        finish();
        loadMine();
        // another send's slices still going keep the box and the line
        if (uploadsRunning) return;
        if (turnedDown.length) {
          endUploads('Upload stopped', turnedDown.join(' '));
          setStatus(turnedDown.join(' '));
          return;
        }
        endUploads(jobs.length === 1 ? 'Upload finished' : 'All ' + jobs.length + ' uploads finished');
        var doneLine = jobs.length === 1 ? 'The file finished uploading.' : 'All ' + jobs.length + ' files finished uploading.';
        setStatus(queuedNote ? doneLine + ' ' + queuedNote : doneLine, !!queuedNote);
        return;
      }
      var job = jobs[at];
      at += 1;
      setUploadTitle(jobs.length > 1 ? 'Uploading file ' + at + ' of ' + jobs.length : 'Uploading');
      setStatus('Uploading ' + job.entry.name + (jobs.length > 1 ? ' (' + at + ' of ' + jobs.length + ')' : '') + '\u2026');
      uploadBig(job.entry, job.file, job.doneParts, function () { tick(job); }, job.twin).then(function () {
        forgetUpload(job.entry.file);
        setRow(job.row, 1, 'Sent \u00b7 ' + fmtBytes(job.entry.size), true);
        nextJob();
      }).catch(function (err) {
        // the file will never be taken, so there is nothing to carry on
        // from: the entry goes and the next file starts
        if (err && err.name === 'Refused') {
          forgetUpload(job.entry.file);
          setRow(job.row, job.sent / job.parts, err.message);
          turnedDown.push(err.message);
          nextJob();
          return;
        }
        finish();
        if (err && err.message === 'signed out') { endUploads('Upload stopped'); return; }
        // the box goes on for the slices still going, so the row says it
        if (uploadsRunning) setRow(job.row, job.sent / job.parts, 'Stopped');
        // The entry stays stored and reloading offers it back, so the
        // slice number is worth saying. What happens if the phone hands
        // back a re-encoded copy is said where it happens — the resume
        // row turns that file away and explains it there — rather than
        // here, before anyone has tried.
        endUploads('Upload stopped',
          'The connection dropped part way. Reload this page and choose ' + job.entry.name +
          ' again: it may carry on from slice ' + (job.sent + 1) + '.');
        setStatus('The upload of ' + job.entry.name + ' broke off. Reload this page and choose it ' +
          'again to try carrying on from where it stopped.');
      });
    }
    nextJob();
  }

  // ---------- leaving while something is in flight ----------
  // Two things can be going here: the create request, which carries
  // the whole submission and exists nowhere else, and the slices of a
  // large file, which follow it. Each says what it is, and neither
  // promises the reader anything about picking it up again.
  //
  // The resume path below is real, but it is not a promise this page
  // can make. It asks for the same file again and matches it on size,
  // and iOS re-encodes a video on its way out of the photo library —
  // so the file that comes back is often not the file that went, the
  // size does not match, and the resume is refused. Most phones here
  // are iPhones. A reassurance that only holds on Android is worse
  // than none: somebody reads it, leaves, and cannot get back.
  var guardArmed = false;
  if (scs.guardLeaving) {
    guardArmed = true;
    scs.guardLeaving(function () {
      if (sending) {
        return 'This submission is still being sent. Nothing is kept until it arrives, ' +
          'so it would have to be filled in and sent again.';
      }
      if (uploadsRunning) {
        return 'A file is still uploading. The submission is already with the tab ' +
          'team but the file is not, and it will not finish on its own.';
      }
      return '';
    });
  }

  // Closing the tab or typing an address is the browser's to catch and
  // nobody else's. The guard above arms one of these itself, covering
  // the send as well as the slices, and stands it down once somebody
  // has answered the slide-and-confirm — so this one only speaks where
  // the guard never armed at all, which is a cached site.js from
  // before it existed.
  window.addEventListener('beforeunload', function (e) {
    if (guardArmed || !uploadsRunning) return;
    e.preventDefault();
    e.returnValue = '';
  });

  // ---------- picking an interrupted upload back up ----------
  // The page cannot keep the file across a reload, so it asks for the
  // same file again, checks the size matches, and sends only the
  // slices the worker does not have yet.
  var resumeEl = document.getElementById('sub-resume');

  // Only the signed-in team's entries are asked about; another team's
  // wait for that team. An entry from before they named a team is asked
  // about once per team: a 404 may be another team's file, so it is kept
  // and marked as asked by this one.
  function checkResume() {
    if (!resumeEl) return;
    resumeEl.classList.add('is-hidden');
    resumeEl.textContent = '';
    var team = teamNow();
    var mark = team.trim().toLowerCase();
    var list = storedUploads().filter(function (e) {
      if (e.team) return sameTeam(e.team, team);
      return !(mark && e.not && e.not.indexOf(mark) !== -1);
    });
    if (!list.length) return;
    Promise.all(list.map(function (entry) {
      return scs.fetch(TAB_API + '/api/submit/upload/status?file=' + entry.file, {
        headers: { authorization: 'Bearer ' + getSession() },
        cache: 'no-store'
      }).then(function (r) {
        if (r.status === 404) {
          // this team's and gone
          if (entry.team) return null;
          entry.not = (entry.not || []).filter(function (t) { return t !== mark; });
          if (mark) entry.not.push(mark);
          return { entry: entry, doneParts: null };
        }
        // a session that has run out, or the tab or its storage out of
        // reach: kept for later
        if (!r.ok) return { entry: entry, doneParts: null };
        return r.json().then(function (d) {
          if (d.done) return null;
          if (!d.ok) return { entry: entry, doneParts: null };
          // the worker's copy wins: an entry written by an older build
          // has no quest on it, and this is where it gets one
          if (d.name) entry.name = d.name;
          if (d.quest) entry.quest = d.quest;
          if (d.size) entry.size = d.size;
          if (d.part_size) entry.part_size = d.part_size;
          entry.direct = !!d.direct;
          // the worker answers only for the team's own file
          if (!entry.team && team) {
            entry.team = team;
            delete entry.not;
          }
          return { entry: entry, doneParts: d.parts || [] };
        });
      }).catch(function () { return { entry: entry, doneParts: null }; }); // offline: keep for later
    })).then(function (found) {
      // The list is read again: a send made while the worker was being
      // asked has added to it, and a run finishing has taken from it.
      // Only the entries asked about are changed.
      var asked = {};
      list.forEach(function (e) { asked[e.file] = true; });
      var kept = {};
      found.forEach(function (p) { if (p) kept[p.entry.file] = p.entry; });
      var still = {};
      saveUploads(storedUploads().filter(function (e) {
        return !asked[e.file] || kept[e.file];
      }).map(function (e) {
        still[e.file] = true;
        return kept[e.file] || e;
      }));
      // and one being sent, here or in another tab, is not broken off
      var resumable = found.filter(function (p) {
        return p && p.doneParts !== null && still[p.entry.file] &&
          !claimed[p.entry.file] && !sentElsewhere(p.entry.file);
      });
      if (resumable.length) renderResume(resumable);
    });
  }

  function hideResumeIfEmpty() {
    if (!resumeEl.querySelector('.sub-resume-row')) resumeEl.classList.add('is-hidden');
  }

  function renderResume(items) {
    resumeEl.textContent = '';
    resumeEl.classList.remove('is-hidden');
    var head = document.createElement('p');
    head.className = 'sub-hint';
    head.textContent = (items.length === 1 ? 'A file did not finish uploading.' :
      items.length + ' files did not finish uploading.') +
      ' The submission is already with the tab team; only the file is short. ' +
      'Choose the same file again below.';
    resumeEl.appendChild(head);
    items.forEach(function (item) {
      var row = document.createElement('div');
      row.className = 'sub-resume-row';
      var totalParts = Math.max(1, Math.ceil(item.entry.size / item.entry.part_size));
      if (item.entry.quest) {
        var chip = document.createElement('span');
        chip.className = 'sub-up-quest';
        chip.textContent = item.entry.quest;
        row.appendChild(chip);
      }
      var label = document.createElement('span');
      label.className = 'sub-resume-label';
      label.textContent = item.entry.name + ' \u2014 ' + fmtBytes(item.entry.size) + ', ' +
        item.doneParts.length + ' of ' + totalParts + ' slices sent (' +
        Math.round(item.doneParts.length / totalParts * 100) + '%)';
      var input = document.createElement('input');
      input.type = 'file';
      input.className = 'is-hidden';
      input.accept = [KIND_ACCEPT.photo, KIND_ACCEPT.video, KIND_ACCEPT.gpx, KIND_ACCEPT.pdf].join(',');
      var pickBtn = document.createElement('button');
      pickBtn.type = 'button';
      // black, not green: green is the page's one action and that is
      // the Send button, which is on screen at the same time
      pickBtn.className = 'btn btn-dark';
      pickBtn.textContent = 'Choose the file';
      pickBtn.addEventListener('click', function () { input.click(); });
      input.addEventListener('change', function () {
        var f = input.files[0];
        if (!f) return;
        if (f.size !== item.entry.size) {
          // Not necessarily the wrong file. A phone can hand back a
          // re-encoded copy of the same video every time it is picked,
          // and then the size never matches however right the file is \u2014
          // so this must not tell somebody they chose wrongly and send
          // them hunting for a video that does not exist.
          setStatus('That copy is a different size, so it cannot carry on from where it stopped. ' +
            'Some phones re-encode a video each time it is picked. Discard it below and send the quest again.');
          input.value = '';
          return;
        }
        row.parentNode.removeChild(row);
        hideResumeIfEmpty();
        runUploads([{ entry: item.entry, file: f, doneParts: item.doneParts }]);
        // the box that has just appeared is the answer to "did that do
        // anything?", so the page goes to it rather than waiting to be found
        showUploads();
      });
      var dropBtn = document.createElement('button');
      dropBtn.type = 'button';
      dropBtn.className = 'btn';
      dropBtn.textContent = 'Discard';
      dropBtn.addEventListener('click', function () {
        scs.postJson(TAB_API + '/api/submit/upload/abort', { file: item.entry.file }, getSession())
          .catch(function () { /* the stored entry goes either way */ });
        forgetUpload(item.entry.file);
        row.parentNode.removeChild(row);
        hideResumeIfEmpty();
        loadMine();
      });
      row.appendChild(label);
      row.appendChild(pickBtn);
      row.appendChild(dropBtn);
      row.appendChild(input);
      resumeEl.appendChild(row);
    });
  }

  // ---------- your score ----------
  // What the tab has for this team: its place, its total and every
  // line behind it. The tab worker answers only to a signed-in team,
  // and says nothing at all while the tab is frozen or closed. Anything the
  // worker cannot answer leaves the whole section off the page.
  var scoreSection = document.getElementById('sub-score');
  var scoreFrozen = document.getElementById('sub-score-frozen');
  var scoreClosed = document.getElementById('sub-score-closed');
  var scoreLive = document.getElementById('sub-score-live');
  var scoreRankStat = document.getElementById('sub-score-rank-stat');
  var scoreRank = document.getElementById('sub-score-rank');
  var scoreTotal = document.getElementById('sub-score-total');
  var scoreTable = document.getElementById('sub-score-table');
  var scoreRows = document.getElementById('sub-score-rows');
  var scoreEmpty = document.getElementById('sub-score-empty');
  var scorePending = document.getElementById('sub-score-pending');

  // the same three the tab itself uses, so a team reads the same
  // numbers here as on the leaderboard
  function ordinal(n) {
    var tail = n % 100;
    if (tail >= 11 && tail <= 13) return n + 'th';
    var last = n % 10;
    return n + (last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th');
  }
  function fmtPts(n) {
    var rounded = Math.round((Number(n) || 0) * 100) / 100;
    return rounded.toLocaleString('en-US', { maximumFractionDigits: 2 });
  }
  function fmtAmount(n) {
    return String(Math.round((Number(n) || 0) * 100) / 100);
  }
  // a count of the code's points, or part of them; a tiered or counted
  // code is what it came to, and a mystery quest's part mark comes
  // without its points
  function scoredText(line) {
    if (line.scoring === 'tiered' || line.scoring === 'counted') return fmtPts(line.worth);
    if (line.points == null) return 'Part marks';
    var amount = Math.round((Number(line.amount) || 0) * 100) / 100;
    if (amount > 0 && amount < 1) return fmtPts(line.worth) + ' of ' + fmtPts(line.points);
    return fmtAmount(amount) + ' × ' + fmtPts(line.points);
  }

  function renderScore(data) {
    scoreSection.classList.remove('is-hidden');
    var closed = !!data.closed;
    var frozen = !!data.frozen && !closed;
    scoreFrozen.classList.toggle('is-hidden', !frozen);
    scoreClosed.classList.toggle('is-hidden', !closed);
    scoreLive.classList.toggle('is-hidden', frozen || closed);
    if (frozen || closed) return;

    var rank = (typeof data.rank === 'number' && data.rank > 0) ? Math.floor(data.rank) : null;
    var teams = Number(data.teams) || 0;
    var dnf = !!data.dnf;
    scoreRankStat.classList.toggle('is-hidden', rank === null && !dnf);
    if (dnf) {
      scoreRank.textContent = 'Did not finish';
    } else if (rank !== null) {
      scoreRank.textContent = ordinal(rank) + ' of ' + teams + (teams === 1 ? ' team' : ' teams');
    }
    scs.digits(scoreTotal, fmtPts(data.total));

    var lines = data.lines || [];
    scoreRows.textContent = '';
    scoreTable.classList.toggle('is-hidden', !lines.length);
    scoreEmpty.classList.toggle('is-hidden', !!lines.length);
    lines.forEach(function (line) {
      var tr = document.createElement('tr');
      var quest = document.createElement('td');
      var chip = document.createElement('span');
      chip.className = 'code';
      chip.textContent = line.code;
      quest.appendChild(chip);
      if (line.name) {
        var name = document.createElement('span');
        name.className = 'sub-score-name';
        name.textContent = line.name;
        quest.appendChild(name);
      }
      var scored = document.createElement('td');
      scored.className = 'sub-score-num';
      scored.textContent = scoredText(line);
      var worth = document.createElement('td');
      worth.className = 'sub-score-num';
      worth.textContent = fmtPts(line.worth);
      tr.appendChild(quest);
      tr.appendChild(scored);
      tr.appendChild(worth);
      scoreRows.appendChild(tr);
    });

    var pending = Number(data.pending) || 0;
    var queued = Number(data.queued) || 0;
    scorePending.classList.toggle('is-hidden', !pending && !queued);
    if (pending || queued) {
      scorePending.textContent = pending + ' waiting for review' +
        (queued ? ' and ' + queued + ' queued behind ' + (pending === 1 ? 'it' : 'them') + '.' : '.');
    }
  }

  function loadScore() {
    if (!scoreSection) return;
    scs.fetch(TAB_API + '/api/submit/score', {
      headers: { authorization: 'Bearer ' + getSession() },
      cache: 'no-store'
    }).then(function (r) {
      if (!r.ok) throw new Error('score ' + r.status);
      return r.json();
    }).then(function (data) {
      if (!data || !data.ok) throw new Error('score shape');
      renderScore(data);
    }).catch(function () {
      // signed out, frozen out or offline: the section says nothing
      scoreSection.classList.add('is-hidden');
    });
  }

  // ---------- your submissions ----------
  var fileUrl = scs.fileUrl;

  // Photos and videos are what the site serves of a submission. A GPX
  // track or a PDF goes to the organisers alone.
  function shownType(type) {
    return String(type || '').indexOf('image/') === 0 || String(type || '').indexOf('video/') === 0;
  }
  // whether a row has something the gallery could show; a list from an
  // older worker carries no files, only their count
  function showable(sub) {
    if (!sub.media || !sub.media.length) return !!sub.files;
    return sub.media.some(function (m) { return shownType(m.type); });
  }

  // thumbnails for a submission's proof: images inline, videos as a
  // play chip — both open the full file in a new tab
  function mediaCell(sub) {
    var cell = document.createElement('td');
    if (!sub.media || !sub.media.length) {
      // an older row the worker sent no file list for: the count is
      // all there is, and the CSS labels it so a bare numeral on its
      // own line says what it counts
      cell.className = 'sub-count-only';
      cell.textContent = sub.files;
      return cell;
    }
    // small previews; a tap opens the full file over the page — a file
    // whose slices are still going up shows a placeholder instead
    var viewItems = [];
    var viewFiles = [];
    sub.media.forEach(function (m) {
      if (m.uploading || !shownType(m.type)) return;
      // a photo opens as its viewing copy; the chain serves the
      // original when there is none
      var full = (m.type.indexOf('image/') === 0 && !scs.animatedType(m.type)) ? fileUrl(m.key) + '&res=1080' : fileUrl(m.key);
      var item = { url: full, thumb: scs.thumbUrl(m.key, m.type), type: m.type, name: m.name };
      // a zoom on a photo brings the whole picture in place of its viewing copy
      if (m.type.indexOf('image/') === 0 && !scs.animatedType(m.type)) item.full = fileUrl(m.key);
      if (m.type.indexOf('video/') === 0 && window.scsVideo) {
        item.sizes = window.scsVideo.sizes(m.renditions, function (res) { return fileUrl(m.key) + '&res=' + res; });
        item.url = item.sizes[0].url;
      }
      // nothing of a video plays until the encoder has been through it,
      // and one it gave up on does not play here at all
      if (!ready(m)) {
        item.processing = true;
        item.still = fileUrl(m.key) + '&thumb=1';
        if (m.skipped) item.skipped = true;
      }
      viewItems.push(item);
      viewFiles.push(m);
    });
    // a video has nothing whole to save or show until the encoder has
    // been through it
    function ready(m) { return m.type.indexOf('video/') !== 0 || (m.renditions && m.renditions.length); }
    var viewOpts = {
      downloadUrl: function (k) { return ready(viewFiles[k]) ? fileUrl(viewFiles[k].key) + '&download=1' : ''; },
      shareUrl: function (k) {
        var m = viewFiles[k];
        if (!ready(m)) return '';
        // a video is shared as a page with a player on it; a photo as itself
        var path = m.key.split('/').map(encodeURIComponent).join('/') + '/' + encodeURIComponent(m.name || 'proof');
        return TAB_API + (m.type.indexOf('video/') === 0 ? '/view/' : '/api/submit/file/') + path;
      }
    };
    var strip = document.createElement('span');
    strip.className = 'sub-thumbs';
    var viewAt = 0;
    sub.media.forEach(function (m) {
      if (m.uploading) {
        var up = document.createElement('span');
        up.className = 'sub-thumb sub-thumb-up';
        up.textContent = '\u2191';
        up.title = m.name + ', still uploading';
        strip.appendChild(up);
        return;
      }
      if (!shownType(m.type)) {
        // named, not opened: nothing public serves it
        var doc = document.createElement('span');
        doc.className = 'sub-thumb-doc';
        doc.textContent = m.name;
        doc.title = m.name;
        strip.appendChild(doc);
        return;
      }
      var i = viewAt;
      viewAt += 1;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sub-thumb-btn';
      btn.title = m.name;
      if (m.type.indexOf('image/') === 0) {
        var img = document.createElement('img');
        img.className = 'sub-thumb';
        img.crossOrigin = 'anonymous'; // readable to the worker, so it can keep a copy
        img.alt = m.name;
        btn.appendChild(img);
        scs.keepPicture(img, scs.thumbUrl(m.key));
      } else {
        btn.className += ' sub-thumb sub-thumb-vid';
        btn.textContent = '▶';
      }
      btn.addEventListener('click', function () { scs.lightbox(viewItems, i, btn.firstChild, viewOpts); });
      strip.appendChild(btn);
    });
    cell.appendChild(strip);
    return cell;
  }

  // the gallery rocker on each row — flipping it tells the tab worker
  function galleryCell(sub) {
    var cell = document.createElement('td');
    var rocker = scs.rocker('sub-check sub-gal', 'Gallery');
    var box = rocker.input;
    box.checked = !!sub.gallery;
    box.addEventListener('change', function () {
      var want = box.checked;
      box.disabled = true;
      scs.postJson(TAB_API + '/api/submit/gallery', { id: sub.id, gallery: want }, getSession())
        .then(function (res) {
          box.disabled = false;
          if (res.status === 401) { signedOut(); throw new Error('signed out'); }
          if (res.status !== 200) throw new Error('failed');
          sub.gallery = want ? 1 : 0;
        }).catch(function () {
          box.disabled = false;
          box.checked = !!sub.gallery;
          setStatus('Could not change the gallery setting. Try again.');
        });
    });
    cell.appendChild(rocker.label);
    return cell;
  }

  // a stored answer in a few words for the table
  function answerSummary(answer) {
    if (!answer) return '';
    if (answer.more) {
      return [answer].concat(answer.more).filter(function (a) { return a && a.value != null; })
        .map(function (a) { return answerSummary({ kind: a.kind, value: a.value }); }).join(' \u00b7 ');
    }
    if (answer.kind === 'count') return String(answer.value);
    if (answer.kind === 'text' || answer.kind === 'choice') return String(answer.value);
    if (Array.isArray(answer.value)) return answer.value.join(', ');
    return '';
  }

  // Every time in the sent list comes out of scs.fmtTime, so the
  // settings menu's Hide dates rocker changes all of them at once —
  // and the list is only drawn when it is fetched, so it is fetched.
  document.addEventListener('scs-dates-changed', function () {
    if (getSession()) loadMine();
  });

  function loadMine() {
    scs.fetch(TAB_API + '/api/submit/mine', {
      headers: { authorization: 'Bearer ' + getSession() },
      cache: 'no-store'
    }).then(function (r) {
      if (r.status === 401) { signedOut(); throw new Error('signed out'); }
      return r.json();
    }).then(function (data) {
      if (!data.ok) return;
      var body = document.getElementById('sub-mine-rows');
      body.textContent = '';
      // the line under the table; the worker lists the newest only
      document.getElementById('sub-mine-empty').textContent = !data.submissions.length ? 'Nothing sent yet.' :
        data.more ? 'Showing the newest ' + data.submissions.length + '.' : '';
      data.submissions.forEach(function (sub) {
        var tr = document.createElement('tr');
        var quest = document.createElement('td');
        var chip = document.createElement('span');
        chip.className = 'code';
        chip.textContent = sub.quest_code;
        quest.appendChild(chip);
        var when = document.createElement('td');
        when.textContent = scs.fmtTime(sub.submitted_at);
        // points an organiser recorded, and a quest answered with its
        // questions alone, come with no file at all
        var bare = !sub.files;
        var count = bare ? document.createElement('td') : mediaCell(sub);
        if (bare) tr.classList.add('no-files');
        var status = document.createElement('td');
        var pill = document.createElement('span');
        pill.className = 'pill ' + sub.status;
        pill.textContent = sub.status;
        status.appendChild(pill);
        // what was claimed and what was said about it, on a line of
        // their own under the verdict
        var notes = document.createElement('div');
        notes.className = 'sub-notes';
        var answerText = answerSummary(sub.answer);
        if (answerText) {
          var ans = document.createElement('span');
          ans.className = 'sub-answer-text';
          ans.textContent = answerText;
          notes.appendChild(ans);
        }
        if (sub.status === 'queued') {
          var held = document.createElement('span');
          held.className = 'sub-reason is-note';
          held.textContent = 'Received. It goes to review once fewer of your submissions are waiting.';
          notes.appendChild(held);
        }
        // the tab team's reason or note, on its own line under the verdict
        var gone = sub.status === 'deleted';
        var taken = sub.organiser === 'taken';
        if (sub.organiser) {
          var who = document.createElement('span');
          who.className = 'sub-reason is-note is-who';
          who.textContent = gone ? 'Added by an organiser and taken back' : taken ? 'Points taken off by an organiser' : 'Added by an organiser';
          notes.appendChild(who);
        }
        if (sub.reason && (sub.organiser ? !gone : sub.status === 'rejected' || gone)) {
          var reason = document.createElement('span');
          reason.className = 'sub-reason' + (sub.status === 'rejected' ? '' : ' is-note');
          reason.textContent = sub.reason;
          notes.appendChild(reason);
        }
        if (sub.part) {
          var part = document.createElement('span');
          part.className = 'sub-reason is-note';
          part.textContent = 'Part marks: ' + fmtPts(sub.part.given) +
            (sub.part.of != null ? ' of ' + fmtPts(sub.part.of) : '') + ' points';
          notes.appendChild(part);
        }
        if (notes.firstChild) {
          status.appendChild(notes);
          tr.classList.add('has-note');
        }
        tr.appendChild(quest);
        tr.appendChild(when);
        tr.appendChild(count);
        tr.appendChild(status);
        tr.appendChild(gone || !showable(sub) ? document.createElement('td') : galleryCell(sub));
        body.appendChild(tr);
      });
      if (!scs.reducedMotion) scs.replay(body, 't-rise-list');
    }).catch(function () { /* the table just stays as it was */ });
  }

  show(!!getSession());
})();

/* ---------------- An upload in the tab's title ---------------- */
(function () {
  'use strict';

  var pageTitle = document.title;
  document.addEventListener('scs-run', function (e) {
    var d = e.detail || {};
    if (d.which !== 'send') return;
    if (!d.running) { document.title = pageTitle; return; }
    document.title = (d.pct == null ? '' : Math.round(Math.max(0, Math.min(100, d.pct))) + '% ') + 'uploading \u2014 ' + pageTitle;
  });
})();
