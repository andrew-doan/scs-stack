// The quest page's script, part three of five: location, the floating
// search, the categories, the lists, ticking off, and loading the quests.
(window.scsQuestList = window.scsQuestList || { parts: [] }).parts.push(function (ql) {
  'use strict';

  // from the parts before this one
  var QUESTS = ql.QUESTS;
  var loadQuests = ql.loadQuests;
  var loadDoneMap = ql.loadDoneMap;
  var DONE_STORAGE_KEY = ql.DONE_STORAGE_KEY;
  var TRANSIT_STORAGE_KEY = ql.TRANSIT_STORAGE_KEY;
  var LIGHT_MAP_STORAGE_KEY = ql.LIGHT_MAP_STORAGE_KEY;
  var LISTS_STORAGE_KEY = ql.LISTS_STORAGE_KEY;
  var SAVED_LIST = ql.SAVED_LIST;
  var MAX_LISTS = ql.MAX_LISTS;
  var LIST_NAME_MAX = ql.LIST_NAME_MAX;
  var loadLists = ql.loadLists;
  var state = ql.state;
  var saveDoneMap = ql.saveDoneMap;
  var saveHideDone = ql.saveHideDone;
  var saveFullInfo = ql.saveFullInfo;
  var saveLists = ql.saveLists;
  var listById = ql.listById;
  var inList = ql.inList;
  var listCount = ql.listCount;
  var listEl = ql.listEl;
  var countEl = ql.countEl;
  var renderList = ql.renderList;
  var renderMarkers = ql.renderMarkers;
  var refresh = ql.refresh;
  var setAnywhereOnly = ql.setAnywhereOnly;
  var setShowUnlocated = ql.setShowUnlocated;
  var fetchTabStats = ql.fetchTabStats;
  var glideSheetHeight = ql.glideSheetHeight;
  var renderDetailCodes = ql.renderDetailCodes;
  var overlay = ql.overlay;
  var openDetail = ql.openDetail;
  var updateDetailDoneButton = ql.updateDetailDoneButton;

  // functions the other parts call
  ql.syncMarkInks = syncMarkInks;
  ql.mapArrived = mapArrived;
  ql.submitHref = submitHref;
  ql.readSearchBox = readSearchBox;
  ql.applySearchText = applySearchText;
  ql.placePill = placePill;
  ql.bookmarkIcon = bookmarkIcon;
  ql.renderDetailLists = renderDetailLists;

  // ---------- Geolocation ----------
  var locateBtn = document.getElementById('ql-locate');
  var clearBtn = document.getElementById('ql-clear-location');
  var locateStatus = document.getElementById('ql-locate-status');
  var radiusGroup = document.getElementById('ql-radius-group');
  var radiusInput = document.getElementById('ql-radius');
  var radiusValue = document.getElementById('ql-radius-value');

  // the you-are-here dot and the radius around it: a ring of points
  // the radius out from you, near enough round at this latitude
  function radiusRing(pos, km) {
    var latR = km / 110.574;
    var lngR = km / (111.32 * Math.cos(pos.lat * Math.PI / 180));
    var ring = [];
    for (var i = 0; i <= 64; i++) {
      var a = i / 64 * 2 * Math.PI;
      ring.push([pos.lng + lngR * Math.cos(a), pos.lat + latR * Math.sin(a)]);
    }
    return ring;
  }

  function drawUser() {
    var pos = state.userPos;
    if (!pos) {
      ql.setMapData('me', ql.featureSet());
      ql.setMapData('radius', ql.featureSet());
      return null;
    }
    var ring = radiusRing(pos, state.radiusKm);
    ql.setMapData('me', ql.featureSet([{
      type: 'Feature', geometry: { type: 'Point', coordinates: [pos.lng, pos.lat] }, properties: { name: 'You are here' }
    }]));
    ql.setMapData('radius', ql.featureSet([{
      type: 'Feature', geometry: { type: 'Polygon', coordinates: [ring] }, properties: {}
    }]));
    return ring;
  }

  // a location found before the map was made is fitted once it is
  var fitOwed = false;

  function updateUserOverlays() {
    var ring = drawUser();
    fitOwed = !!ring && !state.map;
    if (ring && state.map) fitRing(ring);
  }

  function mapArrived() {
    if (!fitOwed) return;
    fitOwed = false;
    if (state.userPos && state.map) fitRing(radiusRing(state.userPos, state.radiusKm));
  }

  function fitRing(ring) {
    var lngs = ring.map(function (p) { return p[0]; });
    var lats = ring.map(function (p) { return p[1]; });
    state.map.fitBounds([[Math.min.apply(null, lngs), Math.min.apply(null, lats)],
      [Math.max.apply(null, lngs), Math.max.apply(null, lats)]],
      { padding: 20, duration: window.scs.reducedMotion ? 0 : window.scs.ms('--duration-slow', 400) });
  }

  // a theme flip draws the pins again; the dot and the ring take their
  // new colours with the rest of the map's layers
  function syncMarkInks() {
    renderMarkers();
  }

  // The request in flight: an answer to one that Clear or a second tap
  // has replaced since is dropped.
  var locateAsk = 0;

  locateBtn.addEventListener('click', function () {
    if (!navigator.geolocation) {
      window.scs.swapText(locateStatus, 'Geolocation is not supported by this browser.');
      return;
    }
    var mine = ++locateAsk;
    window.scs.swapText(locateStatus, 'Locating…');
    navigator.geolocation.getCurrentPosition(function (position) {
      if (mine !== locateAsk) return;
      state.userPos = { lat: position.coords.latitude, lng: position.coords.longitude };
      window.scs.swapText(locateStatus, 'Location on. Showing quests within ' + state.radiusKm + ' km of you.');
      radiusGroup.classList.remove('is-hidden');
      // in the full-screen panel the collapsed bar is the box, the chips
      // and now the radius
      ql.measureChips();
      clearBtn.classList.remove('is-hidden');
      updateUserOverlays();
      refresh();
    }, function (err) {
      if (mine !== locateAsk) return;
      window.scs.swapText(locateStatus, 'Could not get your location (' + err.message + ').');
    }, { enableHighAccuracy: true, timeout: 12000 });
  });

  clearBtn.addEventListener('click', function () {
    locateAsk++;
    fitOwed = false;
    state.userPos = null;
    radiusGroup.classList.add('is-hidden');
    ql.measureChips();
    clearBtn.classList.add('is-hidden');
    window.scs.swapText(locateStatus, 'Location off. Showing all quests.');
    drawUser();
    refresh();
  });

  radiusInput.addEventListener('input', function (e) {
    // a tiny detent tick for every km the thumb crosses (real slides
    // only: the stepper buttons already give their own tap)
    if (e.isTrusted && window.scsHaptic) window.scsHaptic('selection');
    state.radiusKm = Number(radiusInput.value);
    radiusValue.textContent = state.radiusKm + ' km';
    if (state.userPos) {
      locateStatus.textContent = 'Location on. Showing quests within ' + state.radiusKm + ' km of you.';
      drawUser();
      refresh(true);
    }
  });

  // Stepper buttons beside the slider drive the same input path
  function nudgeRadius(delta) {
    var v = Math.max(1, Math.min(50, (parseInt(radiusInput.value, 10) || 5) + delta));
    radiusInput.value = String(v);
    radiusInput.dispatchEvent(new Event('input', { bubbles: true }));
  }
  var radiusDec = document.getElementById('ql-radius-dec');
  var radiusInc = document.getElementById('ql-radius-inc');
  if (radiusDec) radiusDec.addEventListener('click', function () { nudgeRadius(-1); });
  if (radiusInc) radiusInc.addEventListener('click', function () { nudgeRadius(1); });

  // ---------- The floating search, and its one command ----------
  // The box is the page's text filter, as it was when it sat in the
  // panel; what changed is where it is reached from. It rides beside
  // the submit button a thumb's width above the bottom bar, and a tap
  // on it puts the first row under the map at the top of the screen
  // before the box opens over it — so what is being narrowed is what is
  // on screen while it is typed.
  //
  // One command. A box that starts "/submit" changes what a tap on a
  // quest does: its proof form, with the quest already picked, instead
  // of its sheet. What follows the command is still the search, so
  // "/submit ferry" narrows to the ferry quests and one tap lands on
  // the right form. The mode is said in two places — the tag in the bar
  // and the line over the list — because a mode shown in one place is a
  // mode people fall into and cannot get out of.
  var SUBMIT_CMD = /^\/submit\b[ \t]*/i;
  var pill = document.getElementById('ql-pill');
  var pillBar = pill ? pill.querySelector('.ql-pill-bar') : null;
  var pillClear = document.getElementById('ql-pill-clear');
  var pillMode = document.getElementById('ql-pill-mode');
  var searchBox = document.getElementById('ql-search');
  var modeLine = document.getElementById('ql-mode-line');
  var modeOff = document.getElementById('ql-mode-off');

  function submitHref(quest) { return '../submit/#' + encodeURIComponent(quest.id); }

  // what the box says, split into the command and the words after it
  function readSearchBox(raw) {
    var v = String(raw || '');
    var m = SUBMIT_CMD.exec(v);
    return m ? { submit: true, query: v.slice(m[0].length) } : { submit: false, query: v };
  }

  function syncSearchUi() {
    var raw = searchBox ? searchBox.value : '';
    if (pill) pill.classList.toggle('is-submit', state.submitMode);
    if (pillMode) pillMode.classList.toggle('is-hidden', !state.submitMode);
    if (pillClear) pillClear.classList.toggle('is-hidden', raw === '');
    if (modeLine) modeLine.classList.toggle('is-hidden', !state.submitMode);
    if (searchBox) searchBox.placeholder = state.submitMode ? 'Pick a quest to submit for' : 'Search quests';
  }

  // The floating box and the fullscreen map's are one search: what is
  // typed in either is the text of both, and the mode and the filter
  // are read from it, so they belong to the page rather than to a box.
  // `from` is the box typed in, which is left as it is.
  function applySearchText(raw, from) {
    raw = String(raw || '');
    var mapInput = document.getElementById('ql-search-input');
    [searchBox, mapInput].forEach(function (box) {
      if (box && box !== from && box.value !== raw) box.value = raw;
    });
    var read = readSearchBox(raw);
    state.submitMode = read.submit;
    state.search = read.query.trim().toLowerCase();
    syncSearchUi();
    refresh(true);
  }

  function applySearchBox() {
    applySearchText(searchBox ? searchBox.value : '', searchBox);
  }

  // the first row under the map, at the top of the screen: the list's
  // own scroll-margin clears the fixed bar
  function scrollToList() {
    var card = document.querySelector('.ql-list-card');
    if (!card) return;
    card.scrollIntoView({
      behavior: window.scs.reducedMotion ? 'auto' : 'smooth',
      block: 'start'
    });
  }

  function openPill(scroll) {
    if (!pill) return;
    var was = pill.classList.contains('is-open');
    pill.classList.add('is-open');
    // in the side panel the box is already beside the list; jumping the
    // page down on focus would only move what the reader is looking at
    if (scroll !== false && !was && !ql.onDesk) scrollToList();
  }

  function closePill() {
    if (!pill) return;
    pill.classList.remove('is-open');
    if (searchBox) searchBox.blur();
  }

  // Both edges come off the submit button, so the two sit on one line
  // whatever the bottom of the page is doing — a footer, the app's tab
  // bar, or a safe area on a phone turned sideways. With the button
  // away (the fullscreen map) the stylesheet's own sums stand.
  // On the web the footer is on screen only at the end of the scroll, and
  // the bar steps up by however much of it is showing: the gap between
  // where the page's paper ends and the bottom of the screen. The app
  // layout has no web footer and is spaced by its own bar.
  var pillMain = document.querySelector('main.page-shell');
  var pillLift = null;
  function placePill(e) {
    if (!pill) return;
    // Only the page's own scroll moves the bar. The listener below is
    // capture-phase, so it also sees the quest sheet's content and the
    // search panel being scrolled, and a rect read in the middle of one
    // of those is a layout read in the middle of a drag.
    if (e && e.type === 'scroll' && e.target !== document &&
        e.target !== document.body && e.target !== document.documentElement) return;
    var root = document.documentElement;
    // hidden while the map is full screen; left as it is, since a
    // property changed on the root restyles the page
    if (root.classList.contains('ql-map-full')) return;
    var lift = 0;
    if (pillMain && !root.classList.contains('is-pwa')) {
      lift = Math.round(window.innerHeight - pillMain.getBoundingClientRect().bottom);
      if (!(lift > 0)) lift = 0;
    }
    if (lift === pillLift) return;
    pillLift = lift;
    root.style.setProperty('--ql-pill-lift', lift + 'px');
  }
  document.addEventListener('scroll', placePill, { passive: true, capture: true });

  if (searchBox) {
    searchBox.addEventListener('input', applySearchBox);
    searchBox.addEventListener('focus', function () { openPill(true); });
    // a tap anywhere on the bar is a tap on the box
    if (pillBar) {
      pillBar.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('.ql-pill-clear')) return;
        searchBox.focus();
      });
    }
    searchBox.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { searchBox.blur(); return; }
      if (e.key !== 'Escape') return;
      searchBox.value = '';
      applySearchBox();
      closePill();
    });
    // an empty box that has been left alone folds back into the pill
    searchBox.addEventListener('blur', function () {
      window.setTimeout(function () {
        if (pill && pill.contains(document.activeElement)) return;
        if (searchBox.value !== '') return;
        pill.classList.remove('is-open');
      }, 160);
    });
  }

  if (pillClear) {
    pillClear.addEventListener('click', function () {
      var hadText = searchBox && searchBox.value !== '';
      if (searchBox) searchBox.value = '';
      applySearchBox();
      if (hadText && searchBox) searchBox.focus();
      else closePill();
    });
  }

  if (modeOff) {
    // out of the mode without losing what was typed after the command
    modeOff.addEventListener('click', function () {
      if (!searchBox) return;
      searchBox.value = readSearchBox(searchBox.value).query;
      applySearchBox();
    });
  }

  placePill();
  window.requestAnimationFrame(placePill);
  window.setTimeout(placePill, 400);
  window.addEventListener('resize', placePill);
  window.addEventListener('orientationchange', function () {
    window.setTimeout(placePill, 120);
    window.setTimeout(placePill, 450);
  });
  syncSearchUi();

  // ---------- Categories ----------
  // One chip per region with All at the head, in a row that scrolls
  // sideways. It replaced a select in a black panel that took the whole
  // first screen before the map: a chip says which regions exist
  // without being opened, and the choice stays one tap away. The row
  // has one DOM home and is moved into the fullscreen map's search
  // panel and back, so there is one set of buttons and one state.
  var chipsRow = document.getElementById('ql-chips');
  // the row's one-line copy under the top bar is showing (below)
  ql.chipBarIn = false;

  function paintChips() {
    if (!chipsRow) return;
    var kids = chipsRow.children;
    for (var i = 0; i < kids.length; i++) {
      var on = state.list ? kids[i].dataset.list === state.list
        : !kids[i].dataset.list && kids[i].dataset.cat === state.category;
      kids[i].classList.toggle('is-on', on);
      kids[i].setAttribute('aria-selected', on ? 'true' : 'false');
      kids[i].tabIndex = on ? 0 : -1;
    }
  }

  function showPickedChip() {
    // the chosen chip comes back into view: the row scrolls, and a
    // choice made from the far end must not leave the page looking
    // like nothing was picked
    var on = chipsRow && chipsRow.querySelector('.ql-chip.is-on');
    // picked from the copy under the bar: the row itself is off the top
    // of the page, and bringing it into view would scroll the page there
    if (on && on.scrollIntoView && !ql.chipBarIn) {
      on.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    }
  }

  function pickCategory(cat) {
    var hadList = !!state.list;
    state.category = cat;
    state.list = '';
    // an emptied list keeps its chip only while it is picked
    if (hadList) fillCategorySelect(); else { paintChips(); ql.foldChips(); }
    renderListLine();
    refresh();
    showPickedChip();
  }

  function pickList(id) {
    // a rename or delete opened on one list is not carried to another
    if (id !== state.list) listLineMode = '';
    state.list = id;
    state.category = 'all';
    paintChips();
    ql.foldChips();
    renderListLine();
    refresh();
    showPickedChip();
  }

  // The bookmark: outlined, or filled for a quest on a list
  function bookmarkIcon(cls, filled, label) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('class', cls);
    svg.setAttribute('fill', filled ? 'currentColor' : 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linejoin', 'round');
    if (label) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', label);
    } else svg.setAttribute('aria-hidden', 'true');
    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M6 3.5h12v17l-6-4.5-6 4.5z');
    svg.appendChild(path);
    return svg;
  }

  // the regions come with the list, so the chips are built once it has
  // loaded. A list with quests in it (or the one picked) sits between
  // All and the regions.
  function fillCategorySelect() {
    if (!chipsRow) return;
    chipsRow.textContent = '';
    if (state.list && !listById(state.list)) state.list = '';
    ['all'].concat(ql.CATEGORY_ORDER).forEach(function (cat) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ql-chip';
      b.dataset.cat = cat;
      b.setAttribute('role', 'tab');
      b.textContent = cat === 'all' ? 'All' : cat;
      b.addEventListener('click', function () { pickCategory(cat); });
      chipsRow.appendChild(b);
      if (cat !== 'all') return;
      state.lists.forEach(function (list) {
        var n = listCount(list);
        if (!n && list.id !== state.list) return;
        var lb = document.createElement('button');
        lb.type = 'button';
        lb.className = 'ql-chip ql-chip-list';
        lb.dataset.list = list.id;
        lb.setAttribute('role', 'tab');
        lb.appendChild(bookmarkIcon('ql-chip-ic', true));
        lb.appendChild(document.createTextNode(list.name));
        var count = document.createElement('span');
        count.className = 'ql-chip-n';
        count.textContent = String(n);
        lb.appendChild(count);
        lb.addEventListener('click', function () { pickList(list.id); });
        chipsRow.appendChild(lb);
      });
    });
    paintChips();
    ql.foldChips();
    // The row has a height for the first time here. The fullscreen
    // search panel's collapsed bar is sized to show the box and the
    // chips together, so it has to be told: with the map opening full
    // screen by default this runs the other way round from usual — the
    // panel is already up when the list arrives — and the bar was left
    // cut off at the chips.
    ql.measureChips();
  }

  // ---------- Changing the lists ----------
  function cleanListName(text) {
    return String(text || '').replace(/\s+/g, ' ').trim().slice(0, LIST_NAME_MAX);
  }

  // every view of the lists is drawn again from state.lists
  function listsChanged() {
    saveLists();
    fillCategorySelect();
    renderListLine();
    renderDetailLists();
    refresh(true);
  }

  function toggleInList(list, quest) {
    var at = list.keys.indexOf(quest.id);
    if (at >= 0) list.keys.splice(at, 1); else list.keys.push(quest.id);
    listsChanged();
  }

  // a name already in use is the same list
  function addList(name, quest) {
    name = cleanListName(name);
    if (!name) return null;
    var list = state.lists.filter(function (l) { return l.name.toLowerCase() === name.toLowerCase(); })[0];
    if (!list) {
      if (state.lists.length >= MAX_LISTS) return null;
      list = { id: 'l' + Date.now().toString(36), name: name, keys: [] };
      state.lists.push(list);
    }
    if (quest && !inList(list, quest)) list.keys.push(quest.id);
    listsChanged();
    return list;
  }

  // Another tab on this device changed the lists or the ticks
  window.addEventListener('storage', function (e) {
    if (e.key === LISTS_STORAGE_KEY || e.key === null) {
      state.lists = loadLists();
      fillCategorySelect();
      renderListLine();
      renderDetailLists();
      refresh(true);
    }
    if (e.key === DONE_STORAGE_KEY || e.key === null) {
      state.done = loadDoneMap();
      redrawTicks();
    }
  });

  // ---------- The line over a picked list ----------
  // Renaming and deleting a list someone made. Saved has neither, so it
  // has no line.
  var listLine = document.getElementById('ql-list-line');
  var listLineMode = '';

  // the cross that puts a name box away
  function cancelButton(onClick) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ql-button ql-list-cancel';
    b.setAttribute('aria-label', 'Cancel');
    b.textContent = '✕';
    b.addEventListener('click', onClick);
    return b;
  }

  function lineButton(text, onClick, cls) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ql-mode-off' + (cls ? ' ' + cls : '');
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  // the picked list as a route, on the planner page
  function planLink(list) {
    var a = document.createElement('a');
    a.className = 'ql-mode-off';
    a.href = '../plan/?list=' + encodeURIComponent(list.id);
    a.textContent = 'Plan Route';
    return a;
  }

  function renderListLine() {
    if (!listLine) return;
    var list = state.list && listById(state.list);
    listLine.textContent = '';
    listLine.classList.toggle('is-hidden', !list);
    if (!list) { listLineMode = ''; return; }
    // Saved is neither renamed nor deleted
    if (list.id === SAVED_LIST) {
      var saved = document.createElement('span');
      var savedName = document.createElement('strong');
      savedName.textContent = list.name;
      saved.appendChild(savedName);
      listLine.appendChild(saved);
      listLine.appendChild(planLink(list));
      return;
    }
    if (listLineMode === 'rename') {
      var form = document.createElement('form');
      form.className = 'ql-list-form';
      var input = document.createElement('input');
      input.type = 'text';
      input.value = list.name;
      input.maxLength = LIST_NAME_MAX;
      input.setAttribute('aria-label', 'List name');
      form.appendChild(input);
      var save = document.createElement('button');
      save.type = 'submit';
      save.className = 'ql-button ql-button-accent';
      save.textContent = 'Rename';
      form.appendChild(save);
      form.appendChild(cancelButton(function () { listLineMode = ''; renderListLine(); }));
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var name = cleanListName(input.value);
        listLineMode = '';
        if (name) list.name = name;
        listsChanged();
      });
      listLine.appendChild(form);
      input.focus();
      input.select();
      return;
    }
    var label = document.createElement('span');
    var strong = document.createElement('strong');
    strong.textContent = list.name;
    label.appendChild(strong);
    if (listLineMode === 'delete') {
      label.textContent = '';
      label.appendChild(document.createTextNode('Delete the list '));
      label.appendChild(strong);
      label.appendChild(document.createTextNode('?'));
      listLine.appendChild(label);
      listLine.appendChild(lineButton('Delete', function () {
        listLineMode = '';
        state.lists = state.lists.filter(function (l) { return l !== list; });
        state.list = '';
        listsChanged();
      }, 'is-alert'));
      listLine.appendChild(lineButton('Cancel', function () { listLineMode = ''; renderListLine(); }));
      return;
    }
    listLine.appendChild(label);
    listLine.appendChild(planLink(list));
    listLine.appendChild(lineButton('Rename', function () { listLineMode = 'rename'; renderListLine(); }));
    listLine.appendChild(lineButton('Delete List', function () { listLineMode = 'delete'; renderListLine(); }));
  }

  // ---------- The sheet's lists ----------
  // A chip a list, pressed for the lists the quest is on; one tap adds
  // or takes it off. New List opens a name box in place.
  var detailListsEl = document.getElementById('ql-detail-list-picks');
  ql.newListOpen = false;

  function renderDetailLists() {
    if (!detailListsEl) return;
    var quest = state.activeQuest;
    detailListsEl.textContent = '';
    if (!quest) return;
    state.lists.forEach(function (list) {
      var on = inList(list, quest);
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ql-chip ql-list-pick' + (on ? ' is-on' : '');
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      b.appendChild(bookmarkIcon('ql-chip-ic', on));
      b.appendChild(document.createTextNode(list.name));
      b.addEventListener('click', function () { toggleInList(list, quest); });
      detailListsEl.appendChild(b);
    });
    if (ql.newListOpen) {
      var form = document.createElement('form');
      form.className = 'ql-list-form';
      var input = document.createElement('input');
      input.type = 'text';
      input.maxLength = LIST_NAME_MAX;
      input.placeholder = 'List name';
      input.setAttribute('aria-label', 'List name');
      form.appendChild(input);
      var add = document.createElement('button');
      add.type = 'submit';
      add.className = 'ql-button ql-button-accent';
      add.textContent = 'Add';
      form.appendChild(add);
      form.appendChild(cancelButton(function () { setNewListOpen(false); }));
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        if (!cleanListName(input.value)) { input.focus(); return; }
        ql.newListOpen = false;
        glideSheetHeight(function () { addList(input.value, state.activeQuest); });
      });
      detailListsEl.appendChild(form);
      setTimeout(function () { input.focus({ preventScroll: true }); }, 0);
    } else if (state.lists.length < MAX_LISTS) {
      var more = document.createElement('button');
      more.type = 'button';
      more.className = 'ql-chip ql-chip-more ql-list-new';
      more.textContent = '+ New List';
      more.addEventListener('click', function () { setNewListOpen(true); });
      detailListsEl.appendChild(more);
    }
  }

  function setNewListOpen(open) {
    ql.newListOpen = open;
    glideSheetHeight(renderDetailLists);
  }

  var anywhereOnlyBox = document.getElementById('ql-anywhere-only');
  if (anywhereOnlyBox) {
    anywhereOnlyBox.addEventListener('change', function (e) {
      setAnywhereOnly(e.target.checked);
    });
  }

  var showUnlocatedBox = document.getElementById('ql-show-unlocated');
  if (showUnlocatedBox) {
    showUnlocatedBox.addEventListener('change', function (e) {
      setShowUnlocated(e.target.checked);
    });
  }

  var liveOnlyBox = document.getElementById('ql-live-only');
  if (liveOnlyBox) {
    liveOnlyBox.addEventListener('change', function (e) {
      state.liveOnly = e.target.checked;
      refresh();
    });
  }

  // ---------- Completion controls ----------
  var hideDoneInput = document.getElementById('ql-hide-done');
  if (hideDoneInput) {
    hideDoneInput.checked = state.hideDone;
    hideDoneInput.addEventListener('change', function (e) {
      state.hideDone = e.target.checked;
      saveHideDone();
      refresh();
      if (window.scsToast) {
        window.scsToast(state.hideDone
          ? 'Ticked-off quests hidden from the list & map.'
          : 'Showing ticked-off quests again.');
      }
    });
  }

  // the ticks read differently: the list, the pins and an open sheet
  function redrawTicks() {
    refresh(true);
    var open = state.activeQuest;
    if (open && !overlay.classList.contains('is-hidden')) {
      glideSheetHeight(function () {
        renderDetailCodes(open);
        updateDetailDoneButton();
      });
    }
  }

  // the settings menu's Hide Checklist, flipped on this page
  document.addEventListener('scs-checklist-changed', function () {
    state.noChecklist = document.documentElement.classList.contains('hide-checklist');
    redrawTicks();
  });

  // Everything about a quest, under its own row: the same block the
  // page at full/ lays out, which is why that page's renderer draws it.
  // The choice is kept, like hiding ticked-off quests, because it is a
  // way of reading the list rather than a one-off.
  var fullInfoBox = document.getElementById('ql-full-info');
  if (fullInfoBox) {
    fullInfoBox.checked = state.fullInfo;
    fullInfoBox.addEventListener('change', function (e) {
      state.fullInfo = e.target.checked;
      saveFullInfo();
      renderList(true);
      if (window.scsToast) {
        window.scsToast(state.fullInfo
          ? 'Every quest now shows its description, codes and files.'
          : 'Quests are back to one row each.');
      }
    });
  }

  // The transport lines come off by hiding their layers, so the overlay
  // is fetched and drawn either way and comes back at once.
  var transitBox = document.getElementById('ql-transit');
  var mapBox = document.getElementById('ql-map');
  ql.mapBox = mapBox;
  if (transitBox) {
    transitBox.checked = state.transit;
    transitBox.addEventListener('change', function (e) {
      state.transit = e.target.checked;
      ql.dropMapShot(false);
      try { localStorage.setItem(TRANSIT_STORAGE_KEY, state.transit ? '1' : '0'); } catch (err) { /* storage unavailable */ }
      ql.syncTransit();
    });
  }
  var lightMapBox = document.getElementById('ql-light-map');
  if (lightMapBox) {
    lightMapBox.checked = state.lightMap;
    lightMapBox.addEventListener('change', function (e) {
      state.lightMap = e.target.checked;
      try { localStorage.setItem(LIGHT_MAP_STORAGE_KEY, state.lightMap ? '1' : '0'); } catch (err) { /* storage unavailable */ }
      ql.repaintMap();
    });
  }

  // Clearing every tick is easy to do by accident — a wet screen taps
  // on its own — so it takes the shared two-step confirm: a thumb slid
  // the whole way across and released at the far end, then a plain
  // Clear button on a second panel.
  function openClearFlow(count) {
    window.scs.confirmSlide({
      title: 'Clear all ticked-off quests?',
      slideLabel: 'Slide to clear',
      confirmTitle: 'Last check',
      confirmCopy: 'This clears all ' + count + ' ticked-off quest' + (count === 1 ? '' : 's') +
        ' on this device. It cannot be undone.',
      confirmLabel: 'Clear progress',
      cancelLabel: 'Cancel',
      onConfirm: function () {
        state.done = {};
        saveDoneMap();
        refresh();
        if (window.scsHaptic) window.scsHaptic('warning');
        if (window.scsToast) window.scsToast('Progress cleared.');
      }
    });
  }

  var resetDoneBtn = document.getElementById('ql-reset-done');
  if (resetDoneBtn) {
    resetDoneBtn.addEventListener('click', function () {
      var count = Object.keys(state.done).length;
      if (!count) {
        if (window.scsToast) window.scsToast('Nothing is ticked off yet.');
        return;
      }
      openClearFlow(count);
    });
  }

  // ---------- Init ----------
  // The list shows straight from the copy on this device. Whether the
  // worker has a newer one is a single number: /api/pulse carries a
  // quest-list version, and the banner appears when it is past the
  // version this device took. A lower one is the counter set back: it
  // becomes the version taken, and the list is fetched again without
  // the banner.
  var QUESTS_SEEN_KEY = 'scs2-quests-seen';
  var updateBanner = document.getElementById('ql-update');
  if (updateBanner && window.scs.pulse) {
    var pulseQuests = null;
    var updateBusy = false;
    var hideTimer = 0;
    var hideBanner = function () {
      updateBanner.classList.remove('is-shown');
      window.clearTimeout(hideTimer);
      hideTimer = window.setTimeout(function () { updateBanner.hidden = true; }, 400);
    };
    // Take the new list now rather than hoping the reload lands on a
    // colo that has it: fetch it, write it to this device's copy, and
    // only then reload onto it. A failure changes nothing, so the
    // banner stays and the tap can be tried again.
    var takeUpdate = function () {
      if (updateBusy) return;
      updateBusy = true;
      // the team's own list when one is signed in, stored by site.js
      var take = window.scs.fetchQuestList(pulseQuests);
      take
        .then(function () {
          window.scs.markSeen(QUESTS_SEEN_KEY, pulseQuests);
          location.reload();
        })
        .catch(function () {
          updateBusy = false;
          if (window.scsToast) window.scsToast('Could not update. Check your connection.');
        });
    };
    // one listener on the banner itself, so it works whatever markup
    // an older cached page pairs this script with
    updateBanner.addEventListener('click', function (e) {
      if (e.target.closest && e.target.closest('#ql-update-close')) {
        // putting it away is reading it: the same version never asks again
        window.scs.markSeen(QUESTS_SEEN_KEY, pulseQuests);
        hideBanner();
        return;
      }
      takeUpdate();
    });
    var readPulse = function (pulse) {
      if (!pulse || typeof pulse.quests !== 'number') return;
      // an update already on its way keeps the version it asked for
      if (updateBusy || pulse.quests === pulseQuests) return;
      pulseQuests = pulse.quests;
      var seen = window.scs.seen(QUESTS_SEEN_KEY);
      // a first visit is not an update: take the version as read
      if (seen === null) { window.scs.markSeen(QUESTS_SEEN_KEY, pulseQuests); return; }
      if (pulseQuests <= seen) {
        if (!updateBanner.hidden) hideBanner();
        if (pulseQuests === seen) return;
        window.scs.markSeen(QUESTS_SEEN_KEY, pulseQuests);
        if (window.scs.fetchQuestList) window.scs.fetchQuestList(pulseQuests).catch(function () { /* the next look asks again */ });
        return;
      }
      window.clearTimeout(hideTimer);
      updateBanner.hidden = false;
      requestAnimationFrame(function () { updateBanner.classList.add('is-shown'); });
    };
    window.scs.pulse().then(readPulse);
    // every pulse the site reads after this one, and one asked for every
    // five minutes while the page is in view
    window.addEventListener('scs-pulse', function (e) { readPulse(e.detail); });
    window.setInterval(function () { if (!document.hidden) window.scs.pulse(true); }, 300000);
  }
  // /questlist/#MQ1 opens that quest's sheet: what a message embed, the
  // submit page or a shared link points at. The hash matches the quest
  // key or any of its codes, the same way the submit search does.
  function openHashQuest() {
    var raw = (location.hash || '').slice(1);
    if (!raw) return;
    var key;
    try { key = decodeURIComponent(raw); } catch (err) { key = raw; }
    var nk = window.scs.normQuest(key);
    if (!nk) return;
    for (var i = 0; i < QUESTS.length; i++) {
      var q = QUESTS[i];
      if (window.scs.normQuest(q.id) === nk ||
          q.codes.some(function (c) { return window.scs.normQuest(c.code) === nk; })) {
        openDetail(q, true);
        return;
      }
    }
  }
  window.addEventListener('hashchange', openHashQuest);

  loadQuests().then(function () {
    fillCategorySelect();
    refresh();
    openHashQuest();
    // warm the tab numbers now: fetched on the first quest open they
    // would arrive mid-animation and resize the sheet under it
    fetchTabStats().catch(function () { /* shown when it answers, or not at all */ });
  }).catch(function () {
    if (listEl) listEl.innerHTML = '<p class="ql-empty">The quest list could not load. Check your connection and try again.</p>';
    // the line under the title still says the list is on its way
    if (countEl) countEl.textContent = '';
  }).then(function () {
    // list and ticked-off state are real now; lift the first-paint veil
    document.documentElement.classList.remove('ql-pending');
    if (ql.startMapSoon) ql.startMapSoon();
  });

  // for the parts after this one
  ql.chipsRow = chipsRow;
});
