// A quest's card and its editor, on the Quests tab: codes, the files
// hung on it, who can see it, its questions, what it takes and counts,
// and its parts.
(function (dash) {
  // core.js
  var btn = dash.btn, busy = dash.busy, canTab = dash.canTab, chip = dash.chip, done = dash.done,
    field = dash.field, fmtTime = dash.fmtTime, fromLocalInput = dash.fromLocalInput, h = dash.h,
    holdOpen = dash.holdOpen, post = dash.post, postForm = dash.postForm, row = dash.row, shake = dash.shake, state = dash.state,
    textInput = dash.textInput, timeBox = dash.timeBox, toast = dash.toast, toLocalInput = dash.toLocalInput;
  // markdown.js
  var markdown = dash.markdown, markdownTools = dash.markdownTools;
  // uploads.js
  var imageThumb = dash.imageThumb, needsConverting = dash.needsConverting, pngPicks = dash.pngPicks,
    renameRow = dash.renameRow, sendName = dash.sendName, sizeText = dash.sizeText,
    stageFiles = dash.stageFiles;
  // preview.js
  var openPreview = dash.openPreview;
  // parts.js
  var SCORING_NAMES = dash.SCORING_NAMES;
  // tabs.js
  var refreshTeamsOnly = dash.refreshTeamsOnly;

  dash.codeDeleteButton = codeDeleteButton;
  dash.questCard = questCard;
  dash.questEditor = questEditor;

  // delete a code: the code typed back, in place; Cancel puts the button
  // back, and after runs once it is deleted
  function codeDeleteButton(code, host, after) {
    var del = btn('Delete', 'danger small', function () {
      var confirmInput = h('input', 'mono'); confirmInput.placeholder = 'Type ' + code;
      var go = btn('Delete', 'danger small', function () {
        busy(go, post('/api/console/quests/delete', { code: code, confirm: confirmInput.value })).then(function (r) {
          if (done(r, (r && r.note) || 'Deleted ' + code)) after();
        }).catch(function () {});
      });
      function back() { host.textContent = ''; host.appendChild(del); }
      var cancel = btn('Cancel', 'quiet small', back);
      confirmInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); if (e.key === 'Escape') back(); });
      host.textContent = '';
      var wrap = h('span', 'inline'); wrap.appendChild(confirmInput); wrap.appendChild(go); wrap.appendChild(cancel);
      host.appendChild(wrap);
      confirmInput.focus();
    });
    return del;
  }

  // ---- files hung on a quest: what the teams see on its sheet ----
  function questFileUrl(key) { return '/api/quests/file?key=' + encodeURIComponent(key); }

  function groupFilesEditor(g) {
    var wrap = h('div', 'qg-sect');
    wrap.appendChild(h('p', 'qg-sub', 'Files on this quest'));
    var list = h('div', 'qg-files');
    wrap.appendChild(list);

    var picker = h('input', 'hidden');
    picker.type = 'file';
    picker.accept = 'image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,.heic,.heif,application/pdf';
    picker.multiple = true;
    var note = h('span', 'muted');
    var add = btn('Add files', 'quiet small', function () { picker.click(); });
    var bar = h('div', 'qg-actions');
    bar.appendChild(add);
    bar.appendChild(picker);
    bar.appendChild(note);
    bar.appendChild(h('span', 'muted', 'Pictures and PDFs, up to 8 on a quest.'));
    wrap.appendChild(bar);
    // picked files wait here, names open to change, until Upload
    var waiting = h('div', 'qg-waiting hidden');
    var waitList = h('div', 'qg-files');
    var upload = btn('Upload', 'small', function () { sendWaiting(); });
    var waitBar = h('div', 'qg-actions');
    waitBar.appendChild(upload);
    waiting.appendChild(waitList);
    waiting.appendChild(waitBar);
    wrap.appendChild(waiting);
    var pending = [];
    var pendingNames = [];
    function renderWaiting() {
      waitList.textContent = '';
      waiting.classList.toggle('hidden', !pending.length);
      pending.forEach(function (f, i) {
        waitList.appendChild(renameRow(f, pendingNames, i, function () {
          pending.splice(i, 1);
          pendingNames.splice(i, 1);
          renderWaiting();
        }));
      });
      upload.textContent = pending.length === 1 ? 'Upload 1 file' : 'Upload ' + pending.length + ' files';
    }

    function render() {
      list.textContent = '';
      var files = g.files || [];
      if (!files.length) { list.appendChild(h('p', 'note', 'No files yet.')); return; }
      files.forEach(function (f) {
        var line = h('div', 'qg-file');
        if (String(f.type || '').indexOf('image/') === 0) {
          var im = h('img');
          im.loading = 'lazy';
          im.src = questFileUrl(f.key) + '&thumb=1';
          im.alt = f.name || '';
          im.addEventListener('click', function () { openPreview(questFileUrl(f.key), f.name); });
          line.appendChild(im);
        }
        var link = h('a', null, f.name || 'file');
        link.href = questFileUrl(f.key);
        link.target = '_blank';
        link.rel = 'noopener';
        line.appendChild(link);
        line.appendChild(h('span', 'muted grow', sizeText(f.bytes)));
        var drop = btn('Remove', 'quiet small', function () {
          busy(drop, post('/api/console/quests/group/file/delete', { key: f.key })).then(function (r) {
            if (done(r, 'Removed ' + (f.name || 'the file'))) {
              g.files = (g.files || []).filter(function (x) { return x.key !== f.key; });
              render();
            }
          }).catch(function () {});
        });
        line.appendChild(drop);
        list.appendChild(line);
      });
    }

    // the worker cannot resize pictures, so the small copies are made
    // here first — the same canvas step a message's attachments take
    picker.addEventListener('change', function () {
      var picked = Array.prototype.slice.call(picker.files);
      picker.value = '';
      if (!picked.length) return;
      if (picked.some(needsConverting)) note.textContent = 'Converting to PNG…';
      pngPicks(picked).then(function (ready) {
        note.textContent = '';
        pending = pending.concat(ready).slice(0, 6);
        pendingNames = pendingNames.slice(0, pending.length);
        renderWaiting();
      });
    });
    function sendWaiting() {
      var picked = pending.slice();
      var names = picked.map(function (f, i) { return sendName(f, pendingNames[i]); });
      if (!picked.length) return;
      note.textContent = 'Preparing files…';
      var form = new FormData();
      form.append('key', g.key);
      busy(upload, Promise.all(picked.map(imageThumb)).then(function (thumbs) {
        // staged under the names typed for them
        var named = picked.map(function (f, i) { return new File([f], names[i], { type: f.type }); });
        return stageFiles(named, 'qst', function (share) {
          note.textContent = 'Sending ' + Math.round(share * 100) + '%';
        }).then(function (ids) {
          picked.forEach(function (f, i) {
            if (ids) form.append('staged' + i, String(ids[i]));
            else form.append('file' + i, f, names[i]);
            if (thumbs[i]) form.append('thumb' + i, thumbs[i], 'thumb.jpg');
          });
          note.textContent = 'Sending…';
          return postForm('/api/console/quests/group/files', form);
        });
      })).then(function (r) {
        note.textContent = '';
        if (done(r, picked.length + (picked.length === 1 ? ' file added' : ' files added'))) {
          g.files = r.files || [];
          pending = [];
          pendingNames = [];
          renderWaiting();
          render();
        }
      }).catch(function (err) {
        note.textContent = '';
        if (err && err.error) toast(err.error, true);
      });
    }

    render();
    return wrap;
  }

  // take hands back the editor already open for this quest, if the list
  // being drawn had one (dash.heldIn), so what is typed in it stays
  function questCard(g, take) {
    var card = h('div', 'card qg');
    card.appendChild(cardRow(g, card));
    if (state.editing === g.id) card.appendChild((take && take(g.id)) || questEditor(g, card));
    return card;
  }
  // the card's head: code, name, codes, who sees it, and the switch for
  // who sees it, which works without opening the card
  function cardRow(g, card) {
    var who = dash.whoOf(g);
    card.classList.toggle('is-hidden-q', who === 'organisers');
    var top = h('div', 'qg-row');
    top.appendChild(chip(g.key, who === 'organisers'));
    var name = h('div');
    name.appendChild(h('div', 'qg-name', g.name));
    var codes = h('div', 'qg-meta');
    g.codes.forEach(function (c) {
      codes.appendChild(document.createTextNode((codes.childNodes.length ? ' · ' : '') + c.code + ' ' + c.points));
    });
    if (g.mystery) codes.appendChild(document.createTextNode(' · shown as ???'));
    name.appendChild(codes);
    var line = h('div', 'qg-access');
    if (who === 'groups') line.appendChild(h('span', null, dash.audienceNames(g.audiences) || 'No team group picked'));
    if (g.opens_at) line.appendChild(h('span', 'qg-opens', 'Opens ' + fmtTime(g.opens_at)));
    (g.tags || []).forEach(function (id) { var t = dash.tagById(id); if (t) line.appendChild(h('span', 'tag-chip', t.name)); });
    if (line.childNodes.length) name.appendChild(line);
    top.appendChild(name);
    var pick = dash.whoSelect(who);
    pick.className = 'qg-who';
    pick.setAttribute('aria-label', 'Who can see ' + g.key);
    pick.addEventListener('click', function (e) { e.stopPropagation(); });
    pick.addEventListener('change', function () {
      var to = pick.value;
      // team groups need picking, which is the editor's job
      if (to === 'groups' && !(g.audiences || []).length) {
        state.editing = g.id;
        state.whoDraft = { id: g.id, who: 'groups' };
        dash.renderQuestGroups();
        return;
      }
      post('/api/console/quests/group/access', {
        id: g.id, visibility: to, audiences: g.audiences || [],
        // shown to everyone now, a time to open it means nothing
        opens_at: to === 'everyone' ? '' : (g.opens_at || '')
      }).then(function (r) {
        if (done(r, function () { return dash.whoSentence(r.group); })) dash.loadQuestGroups();
        else pick.value = who;
      }).catch(function () { pick.value = who; });
    });
    // With the editor open its own Who is the one control: the row's
    // saved at once and redrew the editor, losing whatever had been
    // ticked there and not yet saved.
    if (state.editing !== g.id) top.appendChild(pick);
    else top.appendChild(h('span'));
    top.appendChild(h('span', 'qg-edit-link', state.editing === g.id ? 'Close' : 'Edit'));
    top.addEventListener('click', function () {
      state.editing = state.editing === g.id ? null : g.id;
      dash.renderQuestGroups();
    });
    return top;
  }

  // Who can see the quest, when it opens to everyone, and its tags.
  // The quest's one Save writes them, after the rest of the quest; it
  // used to take a button of its own inside this section, and the Save
  // at the bottom said "Saved" and dropped any change made here.
  function accessEditor(g, card) {
    var isNew = !g.id;
    var wrap = h('div', 'qg-sect');
    wrap.appendChild(h('p', 'qg-sub', 'Who can see it'));
    var draft = state.whoDraft && state.whoDraft.id === g.id ? state.whoDraft.who : null;
    state.whoDraft = null;
    // a new quest starts with the organisers, not on the public list
    var who = dash.whoSelect(draft || (isNew ? 'organisers' : dash.whoOf(g)));
    var opens = h('input');
    timeBox(opens);
    opens.value = toLocalInput(g.opens_at);
    var grid = h('div', 'qg-grid');
    grid.appendChild(field('Who', who));
    var opensField = field('Opens to everyone at (optional)', opens);
    grid.appendChild(opensField);
    wrap.appendChild(grid);

    var groupsWrap = h('div');
    groupsWrap.appendChild(h('p', 'qg-sub', 'Team groups'));
    var groupsBox = h('div', 'qg-picks');
    var groupChecks = [];
    (state.audiences || []).forEach(function (a) {
      var l = h('label');
      var c = h('input');
      c.type = 'checkbox';
      c.checked = (g.audiences || []).indexOf(a.id) !== -1;
      l.appendChild(c);
      l.appendChild(document.createTextNode(a.name + ' (' + a.team_ids.length + (a.team_ids.length === 1 ? ' team)' : ' teams)')));
      groupsBox.appendChild(l);
      groupChecks.push({ box: c, id: a.id });
    });
    if (!groupChecks.length) groupsBox.appendChild(h('span', 'muted', 'No team groups yet. Make them on the Teams tab.'));
    groupsWrap.appendChild(groupsBox);
    wrap.appendChild(groupsWrap);

    var tagsWrap = h('div');
    tagsWrap.appendChild(h('p', 'qg-sub', 'Tags'));
    var tagBox = h('div', 'qg-picks');
    var tagChecks = [];
    (state.tags || []).forEach(function (t) {
      var l = h('label');
      var c = h('input');
      c.type = 'checkbox';
      c.checked = (g.tags || []).indexOf(t.id) !== -1;
      l.appendChild(c);
      l.appendChild(document.createTextNode(t.name));
      tagBox.appendChild(l);
      tagChecks.push({ box: c, name: t.name });
    });
    var newTag = textInput('', 'New tag');
    tagBox.appendChild(newTag);
    tagsWrap.appendChild(tagBox);
    wrap.appendChild(tagsWrap);

    function sync() {
      groupsWrap.classList.toggle('hidden', who.value !== 'groups');
      opensField.classList.toggle('hidden', who.value === 'everyone');
    }
    who.addEventListener('change', sync);
    sync();

    function values() {
      var tags = tagChecks.filter(function (t) { return t.box.checked; }).map(function (t) { return t.name; });
      newTag.value.split(',').forEach(function (n) { if (n.trim()) tags.push(n.trim()); });
      return {
        visibility: who.value,
        audiences: groupChecks.filter(function (c) { return c.box.checked; }).map(function (c) { return c.id; }),
        opens_at: who.value === 'everyone' ? '' : fromLocalInput(opens.value),
        tags: tags
      };
    }
    // the worker refuses this too; asked here, nothing has been written
    function check() {
      var v = values();
      if (v.visibility === 'groups' && !v.audiences.length) {
        toast('Pick at least one team group, or choose another setting.', true);
        shake(groupsBox);
        return null;
      }
      return v;
    }

    // What the section said when the editor opened. The quest's Save
    // sends who can see it only when something here has changed, so a
    // save made in an editor opened before somebody pressed Open
    // everything now cannot close the quest again.
    var opened = JSON.stringify(values());
    function changed() { return JSON.stringify(values()) !== opened; }
    return { node: wrap, check: check, changed: changed };
  }

  // What the submit form asks besides the proof, one row per question in
  // the order the team sees them. None is a quest of photos and videos.
  function questionsEditor(list) {
    var wrap = h('div', 'qg-sect qg-questions');
    wrap.appendChild(h('p', 'qg-sub', 'Questions on the submit form'));
    var rowsBox = h('div', 'qg-q-list');
    var empty = h('p', 'muted qg-q-empty', 'No questions.');
    wrap.appendChild(empty);
    wrap.appendChild(rowsBox);
    var rows = [];
    function renumber() {
      rows.forEach(function (r, i) { r.title.textContent = 'Question ' + (i + 1); });
      empty.classList.toggle('hidden', rows.length > 0);
      add.disabled = rows.length >= 8;
    }
    function addRow(q) {
      var item = h('div', 'qg-q');
      var kind = h('select');
      dash.QUESTION_KINDS.forEach(function (k) { var o = h('option', null, k[1]); o.value = k[0]; kind.appendChild(o); });
      kind.value = q.kind && q.kind !== 'none' ? q.kind : 'text';
      var prompt = textInput(q.prompt, 'What it asks');
      var options = h('textarea');
      options.value = (q.options || []).join('\n');
      var optionsField = field('Options', options);
      var title = h('span', 'qg-q-title');
      var head = h('div', 'qg-q-head');
      head.appendChild(title);
      var entry = { kind: kind, prompt: prompt, options: options, title: title, node: item };
      head.appendChild(btn('Remove', 'quiet small', function () {
        rowsBox.removeChild(item);
        rows = rows.filter(function (r) { return r !== entry; });
        renumber();
      }));
      item.appendChild(head);
      var grid = h('div', 'qg-grid');
      grid.appendChild(field('Kind', kind));
      grid.appendChild(field('Question', prompt));
      item.appendChild(grid);
      item.appendChild(optionsField);
      function sync() {
        var k = kind.value;
        optionsField.classList.toggle('hidden', k !== 'pick' && k !== 'choice');
        options.placeholder = k === 'choice' ? 'One answer per line' : 'One option per line, or @stations / @sushi';
      }
      kind.addEventListener('change', sync); sync();
      rows.push(entry);
      rowsBox.appendChild(item);
      renumber();
      return entry;
    }
    var add = btn('Add a question', 'quiet small', function () { addRow({ kind: 'text' }).prompt.focus(); });
    wrap.appendChild(add);
    (list || []).forEach(addRow);
    renumber();
    return {
      node: wrap,
      read: function () {
        return rows.map(function (r) { return { kind: r.kind.value, prompt: r.prompt.value, options: r.options.value }; });
      }
    };
  }

  // What the submit form takes besides the questions, and whether the
  // quest is a challenge counted across a team's submissions
  // (rules.js). No kinds ticked is a quest answered with its questions.
  var FILE_KINDS = [['photo', 'Photos'], ['video', 'Videos'], ['gpx', 'GPX tracks'], ['pdf', 'PDFs']];
  var TALLY_KINDS = dash.TALLY_KINDS = [['', 'Not a challenge'], ['picks', 'Different places picked'],
    ['sum', 'Running total of the numbers sent'], ['highest', 'Highest number sent'], ['submissions', 'Accepted submissions']];
  function rulesEditor(g) {
    var r = g.rules || { files: { kinds: ['photo', 'video'], max: 4, required: true }, tally: { kind: '', awards: [], public: false } };
    var files = h('div', 'qg-sect qg-files');
    files.appendChild(h('p', 'qg-sub', 'What teams send'));
    var kinds = h('div', 'qg-picks');
    var boxes = {};
    FILE_KINDS.forEach(function (k) {
      var l = h('label');
      var c = h('input'); c.type = 'checkbox'; c.checked = r.files.kinds.indexOf(k[0]) !== -1;
      boxes[k[0]] = c;
      l.appendChild(c); l.appendChild(document.createTextNode(k[1]));
      kinds.appendChild(l);
    });
    files.appendChild(kinds);
    var max = h('input'); max.type = 'number'; max.min = 1; max.max = 20; max.step = 1; max.value = r.files.max || 4;
    var required = h('input'); required.type = 'checkbox'; required.checked = !!r.files.required;
    var reqRow = h('div', 'qg-picks');
    var reqLabel = h('label'); reqLabel.appendChild(required); reqLabel.appendChild(document.createTextNode('A file is needed to send'));
    reqRow.appendChild(reqLabel);
    var maxGrid = h('div', 'qg-grid');
    maxGrid.appendChild(field('Files per submission', max));
    files.appendChild(maxGrid);
    files.appendChild(reqRow);
    var none = h('p', 'muted', 'No files: the team answers the questions and sends.');
    files.appendChild(none);
    function syncFiles() {
      var any = FILE_KINDS.some(function (k) { return boxes[k[0]].checked; });
      maxGrid.classList.toggle('hidden', !any);
      reqRow.classList.toggle('hidden', !any);
      none.classList.toggle('hidden', any);
    }
    FILE_KINDS.forEach(function (k) { boxes[k[0]].addEventListener('change', syncFiles); });
    syncFiles();

    var tally = h('div', 'qg-sect qg-tally');
    tally.appendChild(h('p', 'qg-sub', 'Challenge'));
    var kind = h('select');
    TALLY_KINDS.forEach(function (k) { var o = h('option', null, k[1]); o.value = k[0]; kind.appendChild(o); });
    kind.value = r.tally.kind || '';
    var awards = textInput((r.tally.awards || []).join(', '), '1000, 700, 500');
    var shown = h('input'); shown.type = 'checkbox'; shown.checked = !!r.tally.public;
    var grid = h('div', 'qg-grid');
    grid.appendChild(field('What is counted', kind));
    var awardsField = field('Points by place', awards);
    grid.appendChild(awardsField);
    tally.appendChild(grid);
    var shownRow = h('div', 'qg-picks');
    var shownLabel = h('label'); shownLabel.appendChild(shown); shownLabel.appendChild(document.createTextNode('Show the standings on the site'));
    shownRow.appendChild(shownLabel);
    tally.appendChild(shownRow);
    function syncTally() {
      awardsField.classList.toggle('hidden', !kind.value);
      shownRow.classList.toggle('hidden', !kind.value);
    }
    kind.addEventListener('change', syncTally);
    syncTally();

    return {
      files: files, tally: tally, kind: kind,
      // a counted part needs the challenge; a quest with one from before
      // the types keeps showing it
      showTally: function (counted) { tally.classList.toggle('hidden', !counted && !r.tally.kind); },
      read: function () {
        return {
          files: {
            kinds: FILE_KINDS.filter(function (k) { return boxes[k[0]].checked; }).map(function (k) { return k[0]; }),
            max: max.value, required: required.checked
          },
          tally: { kind: kind.value, awards: awards.value, public: shown.checked }
        };
      }
    };
  }

  // How one part scores, as the editor sets it: its type and what the
  // type needs — its points, the most a per-unit part counts, the bands of
  // a tiered or counted one, typed as "10: 100, 15: 175".
  function partEditor(c, onType) {
    var node = h('span', 'qg-part');
    var type = h('select');
    SCORING_NAMES.forEach(function (k) { var o = h('option', null, k[1]); o.value = k[0]; type.appendChild(o); });
    type.value = c.scoring || '';
    type.setAttribute('aria-label', 'How it scores');
    var pts = h('input', 'pts'); pts.type = 'number'; pts.step = 'any';
    pts.value = c.points == null || c.scoring === 'tiered' || c.scoring === 'counted' ? '' : c.points;
    var most = h('input', 'pts'); most.type = 'number'; most.step = '1'; most.min = '1'; most.placeholder = 'No most';
    most.value = c.most == null ? '' : c.most;
    most.setAttribute('aria-label', 'Counts up to');
    var bands = textInput((c.bands || []).map(function (b) { return b.from + ': ' + b.points; }).join(', '), '10: 100, 15: 175');
    bands.className = 'qg-bands';
    bands.setAttribute('aria-label', 'Bands: from what number, how many points');
    // the words between the boxes, so a figure says what it is
    var before = h('span', 'muted');
    var after = h('span', 'muted');
    var upTo = h('span', 'muted', 'up to');
    function sync() {
      var t = type.value;
      var banded = t === 'tiered' || t === 'counted';
      pts.classList.toggle('hidden', banded);
      pts.placeholder = t === 'unit' ? 'Each' : t === 'judged' ? 'Up to' : 'Points';
      pts.setAttribute('aria-label', t === 'unit' ? 'Points each' : t === 'judged' ? 'Points at most' : 'Points');
      before.textContent = t === 'judged' ? 'up to' : banded ? 'bands' : '';
      after.textContent = t === 'unit' ? 'each,' : banded ? '' : 'points';
      before.classList.toggle('hidden', !before.textContent);
      after.classList.toggle('hidden', !after.textContent);
      upTo.classList.toggle('hidden', t !== 'unit');
      most.classList.toggle('hidden', t !== 'unit');
      bands.classList.toggle('hidden', !banded);
      if (onType) onType();
    }
    type.addEventListener('change', sync);
    [type, before, pts, after, upTo, most, bands].forEach(function (n) { node.appendChild(n); });
    sync();
    return {
      node: node, type: type, pts: pts,
      needsPoints: function () { return type.value !== 'tiered' && type.value !== 'counted' && pts.value.trim() === ''; },
      read: function () { return { scoring: type.value, points: pts.value, most: most.value, bands: bands.value }; }
    };
  }

  // the editor: every field of the quest and each of its parts
  function questEditor(g, card) {
    var box = h('div', 'qg-edit');
    var isNew = !g.id;
    // held while it is open: the list drawn again puts this one back
    holdOpen(box, isNew ? 'new:' + (g.region || '') : g.id);
    var key = textInput(g.key, 'SQ1', true);
    var name = textInput(g.name, 'Quest name');
    var region = h('select');
    var none = h('option', null, 'No region'); none.value = ''; region.appendChild(none);
    (state.regions || []).forEach(function (r) { var o = h('option', null, r.name); o.value = r.name; region.appendChild(o); });
    if (g.region && !(state.regions || []).some(function (r) { return r.name === g.region; })) {
      var extra = h('option', null, g.region); extra.value = g.region; region.appendChild(extra);
    }
    region.value = g.region || '';
    var sort = h('input'); sort.type = 'number'; sort.value = g.sort || 0;
    var location = textInput(g.location, 'Location as shown on the site');
    var coords = h('textarea'); coords.placeholder = 'One pin per line: Label @ -33.8832, 151.2070';
    coords.value = (g.coords || []).map(function (c) { return c.label + ' @ ' + c.lat + ', ' + c.lng; }).join('\n');
    var description = h('textarea', 'tall'); description.value = g.description || '';
    description.placeholder = 'Markdown: **bold**, __underline__, *italic*, - lists';
    var flavour = textInput(g.flavour, 'The italic line under the description');
    var keywords = textInput((g.keywords || []).join(', '), 'train, food, photo');
    var questions = questionsEditor(g.questions || (g.submit && g.submit !== 'none'
      ? [{ kind: g.submit, prompt: g.prompt, options: g.options }] : []));
    var grid = h('div', 'qg-grid');
    grid.appendChild(field('Name', name)); grid.appendChild(field('Code', key)); grid.appendChild(field('Region', region));
    box.appendChild(grid);
    var descField = field('Description', description);
    var preview = h('div', 'qg-preview hidden');
    function renderPreview() {
      preview.innerHTML = markdown(description.value) + (flavour.value ? '<p class="flavour">' + markdown(flavour.value).replace(/^<p>|<\/p>$/g, '') + '</p>' : '');
    }
    descField.insertBefore(markdownTools(description, preview, renderPreview), description);
    box.appendChild(descField);
    box.appendChild(preview);

    // ---- how it scores: one part, or a table of them ----
    var scoringBox = h('div', 'qg-sect qg-scoring');
    scoringBox.appendChild(h('p', 'qg-sub', 'How it scores'));
    var singleSlot = h('div', 'qg-part-one');
    scoringBox.appendChild(singleSlot);
    var codesBox = h('div', 'qg-codes');
    var table = h('table'); var thead = h('thead');
    thead.appendChild(row([h('th', null, 'Code'), h('th', null, 'What it is'), h('th', null, 'How it scores'), h('th', null, 'Hidden'), h('th')]));
    table.appendChild(thead);
    var tbody = h('tbody'); table.appendChild(tbody);
    var codeRows = [];
    function addCodeRow(c) {
      var code = textInput(c.code, 'SQ1-B', true);
      var label = textInput(c.label, 'Longest word'); label.className = 'lbl';
      var part = partEditor(c, syncCounted);
      var hid = h('input'); hid.type = 'checkbox'; hid.checked = !!c.hidden;
      var act = h('td', 'actions');
      var codeTd = h('td'); codeTd.appendChild(code);
      var labelTd = h('td'); labelTd.appendChild(label);
      var partTd = h('td', 'qg-part-cell'); partTd.appendChild(part.node);
      var hidTd = h('td'); hidTd.appendChild(hid);
      var tr = row([codeTd, labelTd, partTd, hidTd, act]);
      var entry = { was: c.code || '', code: code, label: label, part: part, cell: partTd, hid: hid, tr: tr };
      function drop() {
        tbody.removeChild(tr);
        codeRows = codeRows.filter(function (r) { return r !== entry; });
        syncCounted();
      }
      // a code deleted from the tab leaves the editor too; the rest of
      // what is typed in it stays
      if (c.code) act.appendChild(codeDeleteButton(c.code, act, function () { drop(); dash.loadQuestGroups(); }));
      else act.appendChild(btn('Remove', 'quiet small', drop));
      codeRows.push(entry);
      tbody.appendChild(tr);
    }
    (g.codes && g.codes.length ? g.codes : [{ code: g.key || '', label: '', points: '' }]).forEach(addCodeRow);
    codesBox.appendChild(table);
    var addCode = btn('Add a part', 'quiet small', function () { addCodeRow({ code: '', label: '', points: '' }); });
    codesBox.appendChild(addCode);
    scoringBox.appendChild(codesBox);
    var mystery = h('input'); mystery.type = 'checkbox'; mystery.checked = !!g.mystery;
    var mysteryRow = h('div', 'qg-picks');
    var mysteryLabel = h('label');
    mysteryLabel.appendChild(mystery);
    mysteryLabel.appendChild(document.createTextNode('Mystery points: the site shows ??? for every part'));
    mysteryRow.appendChild(mysteryLabel);
    scoringBox.appendChild(mysteryRow);
    box.appendChild(scoringBox);
    var rules = rulesEditor(g);
    box.appendChild(rules.tally);
    box.appendChild(questions.node);
    box.appendChild(rules.files);
    function syncCounted() {
      // the part boxes call this as they are drawn, before the challenge is
      if (rules) rules.showTally(codeRows.some(function (r) { return r.part.type.value === 'counted'; }));
    }

    // One part that is the quest's own is the usual quest: how it scores
    // sits under its name and its code follows the quest's. More parts
    // are a table, and then the table is where they live.
    var single = codeRows.length === 1 && (!codeRows[0].was || codeRows[0].was === g.key);
    var parts = btn('Add a part', 'quiet small', function () {
      codeRows[0].code.value = codeRows[0].code.value || key.value;
      single = false;
      addCodeRow({ code: '', label: '', points: '' });
      setMode();
      codeRows[codeRows.length - 1].code.focus();
    });
    singleSlot.appendChild(parts);
    function setMode() {
      // the one part's boxes sit under the name, or in its table row
      if (single) singleSlot.insertBefore(codeRows[0].part.node, parts);
      else codeRows[0].cell.appendChild(codeRows[0].part.node);
      singleSlot.classList.toggle('hidden', !single);
      codesBox.classList.toggle('hidden', single);
    }
    key.addEventListener('input', function () { if (single) codeRows[0].code.value = key.value; });
    setMode();
    syncCounted();

    var access = accessEditor(g, card);
    box.appendChild(access.node);

    // Files are written on their own, straight away, so they need a
    // quest already saved to hang from.
    if (!isNew) box.appendChild(groupFilesEditor(g));

    // what most quests never need
    var more = h('details', 'qg-more');
    more.appendChild(h('summary', null, 'More options'));
    var moreBody = h('div', 'qg-more-body');
    moreBody.appendChild(field('Location', location));
    moreBody.appendChild(field('Map pins', coords));
    moreBody.appendChild(field('Flavour text', flavour));
    moreBody.appendChild(field('Search tags, shown on the quest', keywords));
    moreBody.appendChild(field('Order in its region', sort));
    more.appendChild(moreBody);
    box.appendChild(more);

    // ---- actions ----
    var actions = h('div', 'qg-actions');
    var save = btn(isNew ? 'Add quest' : 'Save', null, function () {
      var unpointed = codeRows.filter(function (r) { return r.part.needsPoints(); })[0];
      if (unpointed) { shake(unpointed.part.pts); toast('Give ' + (single ? 'the quest' : unpointed.code.value || 'each part') + ' its points.', true); unpointed.part.pts.focus(); return; }
      if (single) codeRows[0].code.value = key.value;
      var sendAccess = isNew || access.changed();
      var who = sendAccess ? access.check() : null;
      if (sendAccess && !who) return;
      var body = {
        id: g.id || 0, key: key.value, name: name.value, region: region.value, sort: sort.value,
        location: location.value, coords: coords.value, description: description.value, flavour: flavour.value, keywords: keywords.value,
        questions: questions.read(), rules: rules.read(), mystery: mystery.checked,
        codes: codeRows.map(function (r, i) {
          return Object.assign({ was: r.was, code: r.code.value, label: r.label.value, sort: i, hidden: r.hid.checked }, r.part.read());
        })
      };
      // a new quest is written hidden unless it is for everyone, then
      // given who can see it, so it is never public by accident between
      // the two
      if (isNew) body.hidden = who.visibility !== 'everyone';
      var created = false;
      var saving = post('/api/console/quests/group/save', body).then(function (r) {
        if (!who || !r || !r.ok) return r;
        created = isNew;
        return post('/api/console/quests/group/access', Object.assign({ id: r.group.id }, who)).then(function (a) {
          return a && a.ok ? r : a;
        });
      });
      busy(save, saving).then(function (r) {
        if (done(r, function () { return r.note || (isNew ? 'Added ' : 'Saved ') + r.group.key; })) { state.editing = null; dash.loadQuestGroups(); refreshTeamsOnly(); }
        // written, but not shown as asked: it stays with the organisers
        else if (created) { state.editing = null; dash.loadQuestGroups(); refreshTeamsOnly(); }
      }).catch(function () {});
    });
    var cancel = btn('Cancel', 'quiet', function () { state.editing = null; dash.renderQuestGroups(); });
    actions.appendChild(save); actions.appendChild(cancel);
    if (!isNew && canTab('desk')) {
      actions.appendChild(btn('Its desk', 'quiet', function () { dash.openDesk(g.key); }));
    }
    actions.appendChild(h('span', 'grow'));
    if (!isNew) {
      var delHost = h('span', 'inline');
      var del = btn('Delete quest', 'danger', function () {
        var confirmInput = h('input', 'mono'); confirmInput.placeholder = 'Type ' + g.key;
        var go = btn('Delete', 'danger', function () {
          busy(go, post('/api/console/quests/group/delete', { id: g.id, confirm: confirmInput.value })).then(function (r) {
            if (done(r, (r && r.note) || 'Deleted ' + g.key)) { state.editing = null; dash.loadQuestGroups(); refreshTeamsOnly(); }
          }).catch(function () {});
        });
        var back = btn('Cancel', 'quiet', function () { delHost.textContent = ''; delHost.appendChild(del); });
        confirmInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); if (e.key === 'Escape') back.click(); });
        delHost.textContent = ''; delHost.appendChild(confirmInput); delHost.appendChild(go); delHost.appendChild(back);
        confirmInput.focus();
      });
      delHost.appendChild(del);
      actions.appendChild(delHost);
    }
    box.appendChild(actions);
    window.setTimeout(function () { name.focus(); }, 0);
    return box;
  }
})(window.dash);
