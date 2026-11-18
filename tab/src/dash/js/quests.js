// The Quests tab: the list by region, who can see a quest, the search,
// the list as one viewer sees it, regions, tags, everything open at once,
// and import and export.
(function (dash) {
  // core.js
  var api = dash.api, armed = dash.armed, btn = dash.btn, busy = dash.busy, chip = dash.chip,
    done = dash.done, el = dash.el, flash = dash.flash, fmtTime = dash.fmtTime,
    fromLocalInput = dash.fromLocalInput, h = dash.h, heldIn = dash.heldIn, post = dash.post, row = dash.row,
    session = dash.session, setSession = dash.setSession, shake = dash.shake, state = dash.state,
    teamShown = dash.teamShown, textInput = dash.textInput, timeBox = dash.timeBox, toast = dash.toast;
  // tabs.js
  var refreshTeamsOnly = dash.refreshTeamsOnly, show = dash.show;

  dash.loadQuestGroups = loadQuestGroups;
  dash.paintQuestGroups = paintQuestGroups;
  dash.whoOf = whoOf;
  dash.whoSelect = whoSelect;
  dash.whoSentence = whoSentence;
  dash.audienceNames = audienceNames;
  dash.tagById = tagById;
  dash.stampMs = stampMs;
  dash.renderQuestGroups = renderQuestGroups;
  dash.renderViewAs = renderViewAs;

  // ---- quests: one card per quest, its codes beneath, every field editable ----
  dash.QUESTION_KINDS = [
    ['text', 'A short answer'], ['count', 'A number'], ['choice', 'Multiple choice, one answer'],
    ['pick', 'Pick from a list'], ['codes', 'Tick which codes were done']
  ];
  state.groups = []; state.loose = []; state.editing = null;

  function loadQuestGroups() {
    return api('/api/console/quests').then(function (d) {
      if (d.ok) paintQuestGroups(d);
    }).catch(function () {});
  }
  // the tab from the worker's list: GET quests, or a write that answers with it
  function paintQuestGroups(d) {
    state.groups = d.groups; state.loose = d.loose; state.regions = d.regions || [];
    dash.fillCustomQuests();
    state.tags = d.tags || []; state.audiences = d.audiences || [];
    renderViewAs();
    renderQuestGroups();
    renderRegions();
    renderTags();
    dash.renderTeamGroups();
    if (state.viewAs) loadViewAs();
  }

  // ---- who can see a quest ----
  var WHO = [['everyone', 'Everyone'], ['teams', 'Signed-in teams'], ['groups', 'Team groups'], ['organisers', 'Organisers only']];
  state.tags = []; state.audiences = []; state.viewAs = ''; state.viewKeys = null; state.whoDraft = null;
  function whoOf(g) { return g.hidden ? 'organisers' : (g.visibility || 'everyone'); }
  function whoSelect(value) {
    var s = h('select');
    WHO.forEach(function (w) { var o = h('option', null, w[1]); o.value = w[0]; s.appendChild(o); });
    s.value = value;
    return s;
  }
  function whoSentence(g) {
    var who = whoOf(g);
    if (who === 'organisers') return g.key + ' is organisers only';
    if (who === 'teams') return g.key + ' shows to signed-in teams';
    if (who === 'groups') return g.key + ' shows to ' + (audienceNames(g.audiences) || 'no team group');
    return g.key + ' shows to everyone';
  }
  function audienceNames(ids) {
    return (state.audiences || []).filter(function (a) { return (ids || []).indexOf(a.id) !== -1; })
      .map(function (a) { return a.name; }).join(', ');
  }
  function tagById(id) { return (state.tags || []).filter(function (t) { return t.id === id; })[0] || null; }
  // a tag hidden from the dashboard (Old) keeps its quests out of the
  // list until the switch asks for them
  function dashHiddenTagIds() {
    var ids = {};
    (state.tags || []).forEach(function (t) { if (t.dash_hidden) ids[t.id] = true; });
    return ids;
  }
  function inHiddenTag(g, hiddenTags) {
    return (g.tags || []).some(function (id) { return hiddenTags[id]; });
  }
  function stampMs(utc) {
    var d = new Date(String(utc || '').replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? 0 : d.getTime();
  }

  // The open editor is kept through a redraw, with what has been typed in
  // it, and so is a reorder in progress; a search or a viewer narrows
  // everything else.
  function renderQuestGroups() {
    var q = el('quest-filter').value.trim().toLowerCase();
    var showAll = el('quest-show-dash-hidden').checked;
    var hiddenTags = dashHiddenTagIds();
    var view = state.viewKeys;
    var list = el('quest-list');
    var take = heldIn(list);
    list.textContent = '';
    var shown = 0;
    // a block per region in the site's order, each ending in the way to
    // add a quest to it; a search or a viewer shows only what matches
    var filtering = !!q || !!view;
    var canon = {};
    (state.regions || []).forEach(function (r) { canon[r.name.toUpperCase()] = r.name; });
    var blocks = {};
    var order = [];
    function block(name) {
      if (!blocks[name]) { blocks[name] = []; order.push(name); }
      return blocks[name];
    }
    function regionOf(g) { return canon[(g.region || '').toUpperCase()] || g.region || ''; }
    if (!filtering) (state.regions || []).forEach(function (r) { block(r.name); });
    state.groups.forEach(function (g) {
      if (state.editing !== g.id) {
        // seen as one viewer: exactly what they get, hidden tags or not
        if (view) { if (!view[g.key]) return; }
        else if (!showAll && inHiddenTag(g, hiddenTags)) return;
        if (q && !questScore([g.key].concat(g.codes.map(function (c) { return c.code; })), g.name, q, g.region)) return;
      }
      block(regionOf(g)).push(g);
    });
    if (state.editing === 'new') block(state.newRegion || '');
    // the region being put in order is all of its quests, whatever the search says
    if (state.ordering) block(state.ordering.region);
    if (!order.length && !filtering) block('');
    order.forEach(function (name) {
      var head = h('p', 'qg-region-head');
      head.appendChild(h('span', null, name || 'No region'));
      list.appendChild(head);
      var ordering = state.ordering && state.ordering.region === name;
      if (ordering) {
        list.appendChild(dash.orderPanel(name));
        shown += state.ordering.ids.length;
        return;
      }
      if (!filtering && !state.ordering && blocks[name].length > 1) {
        var links = h('span', 'row-links');
        links.appendChild(btn('Reorder', 'small', function () {
          state.editing = null;
          var ids = blocks[name].map(function (g) { return g.id; });
          state.ordering = { region: name, was: ids, ids: ids.slice() };
          renderQuestGroups();
        }));
        head.appendChild(links);
      }
      blocks[name].forEach(function (g) { list.appendChild(dash.questCard(g, take)); shown++; });
      if (state.editing === 'new' && (state.newRegion || '') === name) {
        var card = h('div', 'card qg');
        card.appendChild(take('new:' + name) || dash.questEditor(newQuest(name), card));
        list.appendChild(card);
      } else if (!filtering) {
        list.appendChild(btn(name ? 'Add a quest to ' + name : 'Add a quest', 'quiet qg-add', function () {
          state.editing = 'new';
          state.newRegion = name;
          renderQuestGroups();
        }));
      }
    });
    // codes with no quest are not on the site's list at all, and the
    // hidden or retired ones go with the hidden tags
    var loose = view ? [] : state.loose.filter(function (c) {
      if (!showAll && (c.hidden || /-o$/i.test(c.code))) return false;
      return !q || c.code.toLowerCase().indexOf(q) !== -1;
    });
    if (loose.length) {
      list.appendChild(h('p', 'qg-region-head', 'Codes without a quest'));
      var tb = h('tbody');
      loose.forEach(function (c) {
        var pts = h('input', 'amount'); pts.type = 'number'; pts.step = 'any'; pts.value = c.points;
        var ptd = h('td', 'num'); ptd.appendChild(pts);
        var act = h('td', 'actions');
        var codeTd = h('td'); codeTd.appendChild(chip(c.code, c.hidden));
        if (c.hidden) codeTd.appendChild(h('span', 'muted', ' hidden'));
        var tr = row([codeTd, ptd, act]);
        var save = btn('Save', 'quiet small', function () {
          busy(save, post('/api/console/quests/edit', { code: c.code, points: pts.value })).then(function (r) {
            if (done(r, c.code + ' is now worth ' + r.points)) flash(tr);
          }).catch(function () {});
        });
        act.appendChild(save);
        act.appendChild(dash.codeDeleteButton(c.code, act, loadQuestGroups));
        tb.appendChild(tr);
      });
      var table = h('table'); var thead = h('thead');
      thead.appendChild(row([h('th', null, 'Code'), h('th', 'num', 'Points'), h('th')]));
      table.appendChild(thead); table.appendChild(tb);
      var wrap = h('div', 'card table-scroll'); wrap.appendChild(table); list.appendChild(wrap);
    }
    if (!shown && !loose.length && filtering) {
      list.appendChild(h('p', 'info', view && !q ? 'Nothing shows to this viewer.' : 'Nothing matches.'));
    }
  }

  // A new quest for a region: the next code in the region's series
  // (CQ4 after CQ3) when its quests have one, at the end of the region.
  function newQuest(region) {
    var mine = state.groups.filter(function (g) { return (g.region || '').toUpperCase() === region.toUpperCase(); });
    var counts = {};
    var top = {};
    mine.forEach(function (g) {
      var m = /^([A-Za-z]+)(\d+)$/.exec(g.key);
      if (!m) return;
      var p = m[1].toUpperCase();
      counts[p] = (counts[p] || 0) + 1;
      top[p] = Math.max(top[p] || 0, Number(m[2]));
    });
    var prefix = Object.keys(counts).sort(function (x, y) { return counts[y] - counts[x]; })[0];
    var key = '';
    if (prefix) {
      var taken = {};
      state.groups.forEach(function (g) {
        taken[g.key.toUpperCase()] = true;
        g.codes.forEach(function (c) { taken[c.code.toUpperCase()] = true; });
      });
      var n = top[prefix] + 1;
      while (taken[prefix + n]) n++;
      key = prefix + n;
    }
    var last = mine.reduce(function (most, g) { return Math.max(most, Number(g.sort) || 0); }, 0);
    return { id: 0, key: key, name: '', region: region, description: '', flavour: '', location: '', coords: [],
      submit: 'none', prompt: '', options: [], questions: [], sort: last + 1, hidden: 0, codes: [] };
  }

  // ---- the list as one viewer sees it ----
  function renderViewAs() {
    var sel = el('quest-view-as');
    var keep = state.viewAs;
    sel.textContent = '';
    [['', 'All quests'], ['public', 'As someone signed out']].concat(state.teams.filter(teamShown).map(function (t) {
      return [String(t.id), 'As ' + t.name];
    })).forEach(function (o) { var op = h('option', null, o[1]); op.value = o[0]; sel.appendChild(op); });
    sel.value = keep;
    if (sel.value !== keep) { state.viewAs = ''; state.viewKeys = null; }
  }
  function loadViewAs() {
    if (!state.viewAs) { state.viewKeys = null; renderQuestGroups(); return; }
    var asked = state.viewAs;
    api('/api/console/quests/visible?team_id=' + (asked === 'public' ? 0 : asked)).then(function (d) {
      if (!d.ok || state.viewAs !== asked) return;
      var keys = {};
      d.keys.forEach(function (k) { keys[k] = true; });
      state.viewKeys = keys;
      renderQuestGroups();
    }).catch(function () {});
  }
  el('quest-view-as').addEventListener('change', function () {
    state.viewAs = el('quest-view-as').value;
    loadViewAs();
  });

  el('quest-filter').addEventListener('input', renderQuestGroups);
  el('quest-show-dash-hidden').addEventListener('change', renderQuestGroups);
  // ---- regions: the site's categories, in order ----
  el('quest-regions-toggle').addEventListener('click', function () {
    var box = el('quest-regions');
    box.classList.toggle('hidden');
    el('quest-regions-toggle').textContent = box.classList.contains('hidden') ? 'Regions' : 'Hide regions';
  });
  // the site's line colours, as quest-sheet colours for a region
  var ROUTE_NAMES = [['red', 'Red'], ['orange', 'Orange'], ['yellow', 'Yellow'], ['green', 'Green'], ['blue', 'Blue'],
    ['lime', 'Lime'], ['purple', 'Purple'], ['brown', 'Brown'], ['grey', 'Grey'], ['sky', 'Sky']];
  var ROUTE_HEX = { red: '#ee352e', orange: '#ff6319', yellow: '#fccc0a', green: '#00933c', blue: '#0039a6',
    lime: '#6cbe45', purple: '#b933ad', brown: '#996633', grey: '#a7a9ac', sky: '#00a1de' };
  function renderRegions() {
    var box = el('quest-regions');
    box.textContent = '';
    var regions = state.regions || [];
    box.appendChild(h('h3', null, 'Regions, in the order the site shows them'));
    regions.forEach(function (r, i) {
      var line = h('div', 'qr-row');
      var order = h('span', 'order');
      var up = btn('↑', 'quiet small', function () { moveRegion(i, -1); });
      var down = btn('↓', 'quiet small', function () { moveRegion(i, 1); });
      up.disabled = i === 0; down.disabled = i === regions.length - 1;
      order.appendChild(up); order.appendChild(down);
      var name = textInput(r.name, 'Region name');
      var count = h('span', 'count', r.quests + ' quest' + (r.quests === 1 ? '' : 's'));
      // the line colour of the quest sheet's disc and top rule
      var colourBox = h('span', 'qr-colour');
      var swatch = h('span', 'qr-swatch');
      var colour = h('select');
      colour.setAttribute('aria-label', r.name + ' colour');
      ROUTE_NAMES.forEach(function (c) { var o = h('option', null, c[1]); o.value = c[0]; colour.appendChild(o); });
      colour.value = r.colour || 'red';
      swatch.style.background = ROUTE_HEX[colour.value];
      colour.addEventListener('change', function () {
        swatch.style.background = ROUTE_HEX[colour.value];
        post('/api/console/quests/regions/colour', { id: r.id, colour: colour.value }).then(function (res) {
          if (done(res, r.name + ' is ' + colour.selectedOptions[0].textContent.toLowerCase() + ' on the quest sheet')) loadQuestGroups();
        }).catch(function () {});
      });
      colourBox.appendChild(swatch);
      colourBox.appendChild(colour);
      var save = btn('Rename', 'quiet small', function () {
        if (name.value.trim() === r.name) return;
        busy(save, post('/api/console/quests/regions/save', { id: r.id, name: name.value })).then(function (res) {
          if (done(res, 'Renamed to ' + name.value.trim())) loadQuestGroups();
        }).catch(function () {});
      });
      name.addEventListener('keydown', function (e) { if (e.key === 'Enter') save.click(); });
      var delHost = h('span', 'inline');
      var del = btn('Delete', 'danger small', function () {
        var to = h('select');
        var noneOpt = h('option', null, r.quests ? 'leave its quests with no region' : 'no quests to move'); noneOpt.value = ''; to.appendChild(noneOpt);
        regions.forEach(function (other) {
          if (other.id === r.id) return;
          var o = h('option', null, 'move its quests to ' + other.name); o.value = other.name; to.appendChild(o);
        });
        var go = btn('Delete ' + r.name, 'danger small', function () {
          busy(go, post('/api/console/quests/regions/delete', { id: r.id, to: to.value })).then(function (res) {
            if (done(res, 'Deleted ' + r.name + (res.moved ? ', ' + res.moved + ' quests moved' : ''))) loadQuestGroups();
          }).catch(function () {});
        });
        var back = btn('Cancel', 'quiet small', function () { delHost.textContent = ''; delHost.appendChild(del); });
        delHost.textContent = '';
        if (r.quests) delHost.appendChild(to);
        delHost.appendChild(go); delHost.appendChild(back);
      });
      delHost.appendChild(del);
      line.appendChild(order); line.appendChild(name); line.appendChild(colourBox); line.appendChild(count); line.appendChild(save); line.appendChild(delHost);
      box.appendChild(line);
    });
    var addRow = h('div', 'row-form qr-add');
    var newName = textInput('', 'New region name');
    var add = btn('Add region', 'fixed', function () {
      busy(add, post('/api/console/quests/regions/save', { name: newName.value })).then(function (res) {
        if (done(res, 'Added ' + newName.value.trim())) loadQuestGroups();
      }).catch(function () {});
    });
    newName.addEventListener('keydown', function (e) { if (e.key === 'Enter') add.click(); });
    addRow.appendChild(newName); addRow.appendChild(add);
    box.appendChild(addRow);
  }
  function moveRegion(i, dir) {
    var ids = state.regions.map(function (r) { return r.id; });
    var j = i + dir;
    if (j < 0 || j >= ids.length) return;
    var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    post('/api/console/quests/regions/order', { ids: ids }).then(function (res) {
      if (done(res)) loadQuestGroups();
    }).catch(function () {});
  }

  // ---- tags: quests opened together ----
  el('quest-tags-toggle').addEventListener('click', function () {
    var box = el('quest-tags');
    box.classList.toggle('hidden');
    el('quest-tags-toggle').textContent = box.classList.contains('hidden') ? 'Tags' : 'Close tags';
  });
  function renderTags() {
    var box = el('quest-tags');
    box.textContent = '';
    box.appendChild(h('h3', null, 'Tags'));
    (state.tags || []).forEach(function (t) {
      var block = h('div', 'tg-row');
      var many = t.quests + ' quest' + (t.quests === 1 ? '' : 's');
      var after = function (text) {
        return function (res) { if (done(res, typeof text === 'function' ? function () { return text(res); } : text)) loadQuestGroups(); };
      };

      var head = h('div', 'tg-line');
      var name = textInput(t.name, 'Tag name');
      var hideBox = h('input');
      hideBox.type = 'checkbox';
      hideBox.checked = !!t.dash_hidden;
      var hideLabel = h('label', 'check-inline');
      hideLabel.appendChild(hideBox);
      hideLabel.appendChild(document.createTextNode('Hidden from the dashboard'));
      hideBox.addEventListener('change', function () {
        post('/api/console/quests/tags/save', { id: t.id, name: t.name, dash_hidden: hideBox.checked })
          .then(after(hideBox.checked ? t.name + ' is hidden from the dashboard' : t.name + ' shows on the dashboard'))
          .catch(function () { hideBox.checked = !!t.dash_hidden; });
      });
      var rename = btn('Rename', 'quiet small', function () {
        if (name.value.trim() === t.name) return;
        busy(rename, post('/api/console/quests/tags/save', { id: t.id, name: name.value, dash_hidden: t.dash_hidden }))
          .then(after('Renamed to ' + name.value.trim())).catch(function () {});
      });
      name.addEventListener('keydown', function (e) { if (e.key === 'Enter') rename.click(); });
      head.appendChild(name);
      head.appendChild(h('span', 'count', many));
      head.appendChild(hideLabel);
      head.appendChild(rename);
      head.appendChild(armed('Delete', 'Delete ' + t.name, function (go) {
        busy(go, post('/api/console/quests/tags/delete', { id: t.id })).then(after('Deleted ' + t.name)).catch(function () {});
      }));
      block.appendChild(head);

      if (t.quests) {
        // opening: now, or at a time, or the times taken off
        var when = h('div', 'tg-line');
        when.appendChild(armed('Open to everyone now', 'Open ' + many + ' now', function (go) {
          busy(go, post('/api/console/quests/tags/apply', { id: t.id, do: 'open' }))
            .then(after(function (res) { return 'Opened ' + res.quests + ' under ' + t.name; })).catch(function () {});
        }));
        var at = h('input');
        timeBox(at);
        at.setAttribute('aria-label', 'Open ' + t.name + ' to everyone at');
        var setAt = btn('Open at this time', 'quiet small', function () {
          var stamp = fromLocalInput(at.value);
          if (!stamp) { shake(at); return; }
          busy(setAt, post('/api/console/quests/tags/apply', { id: t.id, do: 'at', opens_at: stamp }))
            .then(after(function (res) { return res.quests + ' under ' + t.name + ' open ' + fmtTime(stamp); })).catch(function () {});
        });
        var clear = btn('Clear times', 'quiet small', function () {
          busy(clear, post('/api/console/quests/tags/apply', { id: t.id, do: 'clear' }))
            .then(after('Took the opening times off ' + t.name)).catch(function () {});
        });
        when.appendChild(at); when.appendChild(setAt); when.appendChild(clear);
        block.appendChild(when);

        // who sees them in the meantime, all at once
        var whoLine = h('div', 'tg-line');
        var who = whoSelect('organisers');
        who.setAttribute('aria-label', 'Who can see the quests under ' + t.name);
        var picks = h('span', 'qg-picks');
        var checks = (state.audiences || []).map(function (a) {
          var l = h('label');
          var c = h('input');
          c.type = 'checkbox';
          l.appendChild(c);
          l.appendChild(document.createTextNode(a.name));
          picks.appendChild(l);
          return { box: c, id: a.id };
        });
        if (!checks.length) picks.appendChild(h('span', 'muted', 'No team groups yet.'));
        function syncWho() { picks.classList.toggle('hidden', who.value !== 'groups'); }
        who.addEventListener('change', syncWho);
        syncWho();
        var apply = btn('Set for ' + many, 'quiet small', function () {
          var ids = checks.filter(function (c) { return c.box.checked; }).map(function (c) { return c.id; });
          if (who.value === 'groups' && !ids.length) { shake(picks); toast('Pick at least one team group.', true); return; }
          busy(apply, post('/api/console/quests/tags/apply', { id: t.id, do: 'set', visibility: who.value, audiences: ids }))
            .then(after(function (res) { return res.quests + ' under ' + t.name + ': ' + WHO.filter(function (w) { return w[0] === who.value; })[0][1].toLowerCase(); }))
            .catch(function () {});
        });
        whoLine.appendChild(who); whoLine.appendChild(picks); whoLine.appendChild(apply);
        block.appendChild(whoLine);
      }
      box.appendChild(block);
    });
    var addRow = h('div', 'row-form qr-add');
    var newName = textInput('', 'New tag');
    var add = btn('Add tag', 'fixed', function () {
      busy(add, post('/api/console/quests/tags/save', { name: newName.value })).then(function (res) {
        if (done(res, 'Added ' + newName.value.trim())) loadQuestGroups();
      }).catch(function () {});
    });
    newName.addEventListener('keydown', function (e) { if (e.key === 'Enter') add.click(); });
    addRow.appendChild(newName); addRow.appendChild(add);
    box.appendChild(addRow);
  }

  // ---- everything open at once ----
  el('quest-open-all').addEventListener('click', function () {
    var status = el('quest-status');
    status.textContent = '';
    var hiddenTags = dashHiddenTagIds();
    var now = Date.now();
    // what the worker will open: not under a hidden tag, no time still
    // to come, and not already open to everyone
    var n = state.groups.filter(function (g) {
      if (inHiddenTag(g, hiddenTags)) return false;
      if (g.opens_at && stampMs(g.opens_at) > now) return false;
      return g.hidden || whoOf(g) !== 'everyone' || !!g.opens_at;
    }).length;
    if (!n) { toast('Nothing to open.'); return; }
    var input = h('input');
    input.placeholder = 'Type OPEN';
    var go = btn('Open ' + n + ' quest' + (n === 1 ? '' : 's'), 'danger', function () {
      busy(go, post('/api/console/quests/open-all', { confirm: input.value.trim() })).then(function (r) {
        if (done(r, function () { return 'Opened ' + r.opened + ' quest' + (r.opened === 1 ? '' : 's'); })) {
          status.textContent = '';
          loadQuestGroups();
        }
      }).catch(function () {});
    });
    var cancel = btn('Cancel', 'quiet', function () { status.textContent = ''; });
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); if (e.key === 'Escape') cancel.click(); });
    var wrap = h('span', 'inline');
    wrap.appendChild(document.createTextNode('Opens every quest to everyone now, apart from quests under a hidden tag and quests with a later opening time. '));
    wrap.appendChild(input); wrap.appendChild(go); wrap.appendChild(cancel);
    status.appendChild(wrap);
    input.focus();
  });

  // ---- export and file import ----
  // everyone: only the quests anyone can see now, with their shown codes
  function download(format, everyone) {
    return fetch('/api/console/quests/export?format=' + format + (everyone ? '&only=everyone' : ''), { headers: { authorization: 'Bearer ' + session() } }).then(function (r) {
      if (r.status === 401) { setSession(''); show(false); throw new Error('signed out'); }
      if (!r.ok) throw new Error('export ' + r.status);
      return r.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'scs2-quests' + (everyone ? '-everyone' : '') + '.' + format;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
      toast(everyone ? 'Exported the quests everyone sees' : 'Exported ' + state.groups.length + ' quests');
    }).catch(function (err) { if (err.message !== 'signed out') toast('Export failed.', true); });
  }
  el('quest-export-csv').addEventListener('click', function () { busy(el('quest-export-csv'), download('csv')); });
  el('quest-export-json').addEventListener('click', function () { busy(el('quest-export-json'), download('json')); });
  el('quest-export-open-csv').addEventListener('click', function () { busy(el('quest-export-open-csv'), download('csv', true)); });
  el('quest-export-open-json').addEventListener('click', function () { busy(el('quest-export-open-json'), download('json', true)); });
  el('quest-file-btn').addEventListener('click', function () { el('quest-file').value = ''; el('quest-file').click(); });
  el('quest-file').addEventListener('change', function () {
    var file = el('quest-file').files[0];
    if (!file) return;
    file.text().then(function (text) { previewQuestFile(text, file.name); });
  });
  function previewQuestFile(text, fileName) {
    var box = el('quest-file-preview');
    box.textContent = '';
    box.classList.remove('hidden');
    el('quest-status').textContent = 'Checking ' + fileName + '…';
    post('/api/console/quests/file/preview', { text: text }).then(function (r) {
      el('quest-status').textContent = '';
      if (!done(r)) { box.classList.add('hidden'); return; }
      renderQuestFilePlan(box, r.rows, text, fileName);
    }).catch(function () { el('quest-status').textContent = ''; box.classList.add('hidden'); });
  }
  function renderQuestFilePlan(box, rows, text, fileName) {
    box.textContent = '';
    var counts = { add: 0, update: 0, same: 0, error: 0 };
    var tb = h('tbody');
    rows.forEach(function (line) {
      counts[line.status]++;
      var st = h('td'); st.appendChild(h('span', 'pill ' + line.status, line.status));
      var keyTd = h('td'); keyTd.appendChild(chip(line.key || '?'));
      tb.appendChild(row([h('td', 'num', line.line), keyTd, h('td', null, line.name), st, h('td', 'muted', line.detail)]));
    });
    var table = h('table'); var thead = h('thead');
    thead.appendChild(row([h('th', 'num', '#'), h('th', null, 'Code'), h('th', null, 'Name'), h('th', null, 'Change'), h('th', null, 'What')]));
    table.appendChild(thead); table.appendChild(tb);
    var card = h('div', 'card');
    var summary = fileName + ': ' + counts.add + ' to add, ' + counts.update + ' to update, ' + counts.same + ' unchanged' +
      (counts.error ? ', ' + counts.error + ' with problems' : '') + '.';
    card.appendChild(h('p', null, summary));
    var wrap = h('div', 'table-scroll'); wrap.appendChild(table); card.appendChild(wrap);
    var actions = h('div', 'row-form');
    var go = btn('Import ' + (counts.add + counts.update) + ' quest' + (counts.add + counts.update === 1 ? '' : 's'), null, function () {
      busy(go, post('/api/console/quests/file/commit', { text: text })).then(function (r) {
        if (done(r, 'Imported: ' + r.added + ' added, ' + r.updated + ' updated')) {
          box.classList.add('hidden'); box.textContent = '';
          loadQuestGroups(); refreshTeamsOnly();
        } else if (r.rows) {
          renderQuestFilePlan(box, r.rows, text, fileName);
        }
      }).catch(function () {});
    });
    go.disabled = counts.error > 0 || counts.add + counts.update === 0;
    var cancel = btn('Cancel', 'quiet', function () { box.classList.add('hidden'); box.textContent = ''; });
    actions.appendChild(go); actions.appendChild(cancel);
    card.appendChild(actions);
    box.appendChild(card);
    box.scrollIntoView({ block: 'nearest' });
  }

  // retire everything on the tab: codes become code-o and go hidden
  el('quest-retire').addEventListener('click', function () {
    var status = el('quest-status');
    status.textContent = '';
    var input = h('input'); input.placeholder = 'Type RETIRE';
    var go = btn('Retire every current quest', 'danger', function () {
      busy(go, post('/api/console/quests/retire', { confirm: input.value })).then(function (r) {
        if (done(r, 'Retired ' + r.retired + ' codes')) { status.textContent = ''; loadQuestGroups(); refreshTeamsOnly(); }
      }).catch(function () {});
    });
    var cancel = btn('Cancel', 'quiet', function () { status.textContent = ''; });
    var wrap = h('span', 'inline');
    wrap.appendChild(document.createTextNode('Every code on the tab gets -o added and is hidden. Scores stay. '));
    wrap.appendChild(input); wrap.appendChild(go); wrap.appendChild(cancel);
    status.appendChild(wrap);
    input.focus();
  });
  el('quest-import').addEventListener('click', function () {
    busy(el('quest-import'), post('/api/console/quests/import-scs2')).then(function (r) {
      if (done(r, function () { return 'Imported ' + r.added + ' quests' + (r.skipped.length ? ', skipped ' + r.skipped.length + ' already there' : ''); })) {
        loadQuestGroups(); refreshTeamsOnly();
      }
    }).catch(function () {});
  });
  // The same loose matcher the site uses for quests (site.js
  // textScore/questScore): a code found anywhere, a name with a
  // substring, a word that starts the way the query does, a word a
  // letter or two off, or the letters in order inside a word.
  function textScore(query, text) {
    var q = String(query || '').trim().toLowerCase();
    var t = String(text || '').toLowerCase();
    if (!q || !t) return 0;
    var at = t.indexOf(q);
    if (at !== -1) return (at === 0 || /[^a-z0-9]/.test(t.charAt(at - 1))) ? 180 : 150;
    var words = t.split(/[^a-z0-9]+/).filter(Boolean);
    var parts = q.split(/[^a-z0-9]+/).filter(Boolean);
    if (!parts.length || !words.length) return 0;
    var total = 0;
    for (var i = 0; i < parts.length; i++) {
      var best = 0;
      for (var j = 0; j < words.length && best < 120; j++) {
        var sc = wordScore(parts[i], words[j]);
        if (sc > best) best = sc;
      }
      if (!best) return 0;
      total += best;
    }
    return Math.round(total / parts.length);
    function wordScore(p, w) {
      if (w.indexOf(p) === 0) return 120;
      if (w.indexOf(p) !== -1) return 100;
      if (p.length >= 4) {
        var allow = p.length >= 7 ? 2 : 1;
        if (editDistance(p, w.slice(0, p.length), allow) <= allow) return 95;
        if (editDistance(p, w, allow) <= allow) return 90;
      }
      if (p.length >= 3 && subsequence(p, w)) return 60;
      return 0;
    }
    function subsequence(p, w) {
      var k = 0;
      for (var i = 0; i < w.length && k < p.length; i++) if (w.charAt(i) === p.charAt(k)) k++;
      return k === p.length;
    }
    function editDistance(a, b, cap) {
      if (Math.abs(a.length - b.length) > cap) return cap + 1;
      var prev = [];
      for (var j = 0; j <= b.length; j++) prev.push(j);
      for (var i = 1; i <= a.length; i++) {
        var cur = [i];
        var low = cap + 1;
        for (var jj = 1; jj <= b.length; jj++) {
          var cost = a.charAt(i - 1) === b.charAt(jj - 1) ? 0 : 1;
          var v = Math.min(prev[jj] + 1, cur[jj - 1] + 1, prev[jj - 1] + cost);
          cur.push(v);
          if (v < low) low = v;
        }
        if (low > cap) return cap + 1;
        prev = cur;
      }
      return prev[b.length];
    }
  }
  function normQuest(text) { return String(text).toUpperCase().replace(/\s+/g, ''); }
  function questScore(codes, name, query, extra) {
    var q = String(query || '').trim();
    if (!q) return 1;
    var nq = normQuest(q);
    var best = 0;
    codes.forEach(function (c) {
      var n = normQuest(c || '');
      if (!n) return;
      var sc = n === nq ? 300 : n.indexOf(nq) === 0 ? 250 : n.indexOf(nq) !== -1 ? 200 : 0;
      if (sc > best) best = sc;
    });
    if (/^[0-9-]+$/.test(nq)) return best; // a number alone is a code lookup
    var nm = textScore(q, name);
    if (nm > best) best = nm;
    if (extra) {
      var more = Math.round(textScore(q, extra) * 0.5);
      if (more > best) best = more;
    }
    return best;
  }
})(window.dash);
