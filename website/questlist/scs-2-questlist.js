// The quest page's script, part one of five: the quests, the ticks and lists
// kept on this device, the list itself and the teams' numbers.
// scs-2-questlist-sheet.js, -controls.js, -map.js and -screen.js follow it,
// in that order, and the last of them runs all five.
(window.scsQuestList = window.scsQuestList || { parts: [] }).parts.push(function (ql) {
  'use strict';

  // functions the other parts call
  ql.loadQuests = loadQuests;
  ql.loadDoneMap = loadDoneMap;
  ql.loadLists = loadLists;
  ql.saveDoneMap = saveDoneMap;
  ql.saveHideDone = saveHideDone;
  ql.saveFullInfo = saveFullInfo;
  ql.saveLists = saveLists;
  ql.listById = listById;
  ql.inList = inList;
  ql.listCount = listCount;
  ql.isDone = isDone;
  ql.isComplete = isComplete;
  ql.tickedCodes = tickedCodes;
  ql.doneCount = doneCount;
  ql.setDone = setDone;
  ql.toggleCode = toggleCode;
  ql.setCount = setCount;
  ql.clearDone = clearDone;
  ql.stopFlashCodes = stopFlashCodes;
  ql.paintRoute = paintRoute;
  ql.regionLetter = regionLetter;
  ql.loadMapLibre = loadMapLibre;
  ql.haversineKm = haversineKm;
  ql.questDistanceKm = questDistanceKm;
  ql.locationText = locationText;
  ql.pointsSummary = pointsSummary;
  ql.isLive = isLive;
  ql.matchesFilters = matchesFilters;
  ql.renderList = renderList;
  ql.siteColor = siteColor;
  ql.renderMarkers = renderMarkers;
  ql.drawPins = drawPins;
  ql.clearQuestHighlight = clearQuestHighlight;
  ql.highlightQuestMarkers = highlightQuestMarkers;
  ql.refresh = refresh;
  ql.setAnywhereOnly = setAnywhereOnly;
  ql.setShowUnlocated = setShowUnlocated;
  ql.fetchTabStats = fetchTabStats;

  // The map is MapLibre GL, vendored, with the base style and the
  // glyphs beside it (see the map section further down).
  var MAPLIBRE_JS_URL = '../assets/maplibre/maplibre-gl.js';
  var MAPLIBRE_CSS_URL = '../assets/maplibre/maplibre-gl.css';
  var MAP_STYLE_URL = '../assets/maplibre/style.json';
  var MAP_GLYPHS = '../assets/maplibre/fonts/{fontstack}/{range}.pbf';
  // the glyph ranges kept here: Latin and its punctuation. A name in any
  // other script comes from the Protomaps assets site instead.
  var LOCAL_GLYPH_RANGES = ['0-255', '256-511', '512-767', '768-1023', '7680-7935', '8192-8447', '8448-8703'];
  var REMOTE_GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts';

  // Quest data is the tab worker's list (GET /api/questlist via
  // window.scs.questList, cached in this browser for offline use).
  // Each group there is one quest here; its codes are what the tab
  // scores, the first one carrying the quest's headline points.
  var QUESTS = [];
  ql.CATEGORY_ORDER = [];
  var ROUTE_COLOURS = {}; // region name, upper case -> line colour

  function loadQuests() {
    return window.scs.questList().then(function (data) {
      QUESTS.length = 0;
      ql.CATEGORY_ORDER = data.regions.slice();
      ROUTE_COLOURS = {};
      Object.keys(data.region_colours || {}).forEach(function (name) {
        ROUTE_COLOURS[name.toUpperCase()] = data.region_colours[name];
      });
      // the public list says when signed-in teams see more than it has
      var moreLine = document.getElementById('ql-more');
      if (moreLine) moreLine.hidden = !data.more;
      var OTHER = 'Other quests'; // quests the console has not put in a region
      data.groups.forEach(function (g) {
        var codes = g.codes || [];
        if (!codes.length) return;
        if (!g.region && ql.CATEGORY_ORDER.indexOf(OTHER) === -1) ql.CATEGORY_ORDER.push(OTHER);
        var quest = {
          id: g.key,
          category: g.region || OTHER,
          name: g.name,
          // a mystery quest's points stay with the tab: ??? here, and
          // nothing towards the tally
          mystery: !!g.mystery,
          points: g.mystery ? '???' : String(codes[0].points),
          basePoints: g.mystery ? 0 : Number(codes[0].points) || 0,
          description: g.description || '',
          flavour: g.flavour || '',
          // tags it is searched by and shown with
          keywords: Array.isArray(g.keywords) ? g.keywords.map(String) : [],
          locations: (g.coords || []).map(function (c) {
            return { label: c.label || g.location || g.name, lat: Number(c.lat), lng: Number(c.lng) };
          }).filter(function (l) { return isFinite(l.lat) && isFinite(l.lng); }),
          locationLabel: g.location || '',
          codes: codes,
          submit: g.submit || 'none',
          // organisers can hang pictures or a PDF on a quest, and can
          // ask the teams something while the day runs
          files: g.files || [],
          ask: (g.ask && g.ask.kind) ? g.ask : null,
          // a challenge counted across a team's submissions may show
          // where every team stands
          standings: !!(g.rules && g.rules.tally && g.rules.tally.kind && g.rules.tally.public),
          // scored by calls from payphones: the number teams call
          phone: g.phone && typeof g.phone === 'object' ? { number: String(g.phone.number || '') } : null,
          // the points each place earns, for a counted part's rows
          places: (g.rules && g.rules.tally && g.rules.tally.awards) || [],
          // ticked once per code (tiers, bonuses, places) …
          multi: codes.length > 1,
          // … or as many times as you like: per-unit quests (a count
          // answer box, or a lead code labelled "Per school", "Per floor")
          repeat: codes.length === 1 && (codes[0].scoring === 'unit' || g.submit === 'count' || /^per\b/i.test(codes[0].label || ''))
        };
        QUESTS.push(quest);
      });
      if (!QUESTS.length) throw new Error('empty quest list');
    });
  }

  // ---------- Completion tracking (saved in this browser) ----------
  var DONE_STORAGE_KEY = 'scs2-questlist-done-v2'; // v1 held the old list's ids
  var HIDE_DONE_STORAGE_KEY = 'scs2-questlist-hide-done';

  function loadDoneMap() {
    try {
      var raw = localStorage.getItem(DONE_STORAGE_KEY);
      if (!raw) return {};
      var parsed = JSON.parse(raw);
      var map = {};
      // true = done; a list = which codes; a number = how many times
      if (parsed && typeof parsed === 'object') {
        Object.keys(parsed).forEach(function (id) {
          var v = parsed[id];
          if (Array.isArray(v)) map[id] = v.filter(function (c) { return typeof c === 'string'; });
          else if (typeof v === 'number' && v > 0) map[id] = v;
          else map[id] = true;
        });
      }
      return map;
    } catch (e) { return {}; }
  }

  function loadHideDone() {
    try { return localStorage.getItem(HIDE_DONE_STORAGE_KEY) === '1'; } catch (e) { return false; }
  }

  var FULL_INFO_STORAGE_KEY = 'scs2-questlist-full-info';
  function loadFullInfo() {
    try { return localStorage.getItem(FULL_INFO_STORAGE_KEY) === '1'; } catch (e) { return false; }
  }

  // the train, metro, light rail and ferry lines under the markers; on
  // unless turned off
  var TRANSIT_STORAGE_KEY = 'scs2-questlist-transit';
  function loadTransit() {
    try { return localStorage.getItem(TRANSIT_STORAGE_KEY) !== '0'; } catch (e) { return true; }
  }

  // the light map in the dark theme; off unless turned on
  var LIGHT_MAP_STORAGE_KEY = 'scs2-questlist-light-map';
  function loadLightMap() {
    try { return localStorage.getItem(LIGHT_MAP_STORAGE_KEY) === '1'; } catch (e) { return false; }
  }

  // ---------- Lists (saved in this browser) ----------
  // Saved is always there and comes first; the rest are made from a
  // quest's sheet. A list holds quest keys. A key the quest list does not
  // carry is kept rather than dropped, so a quest hidden for a while is
  // still in its lists when it comes back.
  var LISTS_STORAGE_KEY = 'scs2-questlist-lists';
  var SAVED_LIST = 'saved';
  var MAX_LISTS = 20;
  var LIST_NAME_MAX = 40;

  function loadLists() {
    var lists = [];
    try {
      var parsed = JSON.parse(localStorage.getItem(LISTS_STORAGE_KEY) || 'null');
      if (parsed && Array.isArray(parsed.lists)) {
        parsed.lists.forEach(function (l) {
          if (!l || typeof l.id !== 'string' || typeof l.name !== 'string' || !Array.isArray(l.keys)) return;
          lists.push({ id: l.id, name: l.name.slice(0, LIST_NAME_MAX),
            keys: l.keys.filter(function (k) { return typeof k === 'string'; }) });
        });
      }
    } catch (e) { /* nothing kept */ }
    var saved = lists.filter(function (l) { return l.id === SAVED_LIST; })[0];
    if (saved) lists.splice(lists.indexOf(saved), 1);
    lists.unshift(saved || { id: SAVED_LIST, name: 'Saved', keys: [] });
    return lists;
  }

  var state = {
    map: null,
    // the map has its style: sources and layers can be reached
    mapStyled: false,
    pins: [],
    litQuest: null,
    userPos: null,
    radiusKm: 5,
    search: '',
    category: 'all',
    // the lists, and the one the list is narrowed to ('' for none); a
    // list and a region are never picked together
    lists: loadLists(),
    list: '',
    // the two halves of one three-way choice: everything, only what the
    // map can show, or only what it cannot. The pair is kept legal in
    // setShowUnlocated/setAnywhereOnly — never set them by hand.
    showUnlocated: true,
    anywhereOnly: false,
    liveOnly: false,
    done: loadDoneMap(),
    hideDone: loadHideDone(),
    // the settings menu's Hide Checklist: nothing reads as ticked while it
    // is on, and the saved ticks are left alone
    noChecklist: document.documentElement.classList.contains('hide-checklist'),
    // every quest's description, codes and files under its own row,
    // which is what the page at full/ shows on a page of its own
    fullInfo: loadFullInfo(),
    transit: loadTransit(),
    lightMap: loadLightMap(),
    // the search box holds /submit: a tap on a quest opens its proof
    // form instead of its sheet
    submitMode: false,
    activeQuest: null
  };

  function saveDoneMap() {
    try { localStorage.setItem(DONE_STORAGE_KEY, JSON.stringify(state.done)); } catch (e) { /* storage unavailable */ }
  }

  function saveHideDone() {
    try { localStorage.setItem(HIDE_DONE_STORAGE_KEY, state.hideDone ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  }

  function saveFullInfo() {
    try { localStorage.setItem(FULL_INFO_STORAGE_KEY, state.fullInfo ? '1' : '0'); } catch (e) { /* storage unavailable */ }
  }

  function saveLists() {
    try { localStorage.setItem(LISTS_STORAGE_KEY, JSON.stringify({ lists: state.lists })); } catch (e) { /* storage unavailable */ }
  }

  function listById(id) {
    return state.lists.filter(function (l) { return l.id === id; })[0] || null;
  }
  function inList(list, quest) { return list.keys.indexOf(quest.id) >= 0; }
  function inAnyList(quest) {
    return state.lists.some(function (l) { return inList(l, quest); });
  }
  // the quests on the current list that are in it
  function listCount(list) {
    return QUESTS.filter(function (q) { return inList(list, q); }).length;
  }

  // Every read of the ticks comes through here, and reads what was kept
  // against the quest as it is now, since a quest can gain or lose codes
  // after it was ticked: a tiered quest keeps the ticked codes it still
  // has, and a tick from before it had several stands for its lead code;
  // a list of codes on a quest with one is done if its code is in it; a
  // per-unit quest reads anything else as once.
  function doneValue(quest) {
    if (state.noChecklist) return undefined;
    var v = state.done[quest.id];
    if (v === undefined) return undefined;
    var lead = quest.codes[0].code;
    if (quest.multi) {
      if (!Array.isArray(v)) return [lead];
      var have = quest.codes.map(function (c) { return c.code; });
      var kept = v.filter(function (code) { return have.indexOf(code) !== -1; });
      return kept.length ? kept : undefined;
    }
    if (Array.isArray(v) && v.indexOf(lead) === -1) return undefined;
    if (quest.repeat) return typeof v === 'number' ? v : 1;
    return true;
  }

  function isDone(quest) {
    var v = doneValue(quest);
    return v === true || (Array.isArray(v) && v.length > 0) || (typeof v === 'number' && v > 0);
  }
  // every code of a tiered quest ticked (a plain or counted quest is
  // complete as soon as it is done)
  function isComplete(quest) {
    if (!isDone(quest)) return false;
    return !quest.multi || tickedCodes(quest).length === quest.codes.length;
  }
  function tickedCodes(quest) { var v = doneValue(quest); return Array.isArray(v) ? v : []; }
  function doneCount(quest) { var v = doneValue(quest); return typeof v === 'number' ? v : (v ? 1 : 0); }

  // what a ticked quest is worth: its codes' points for the ones
  // ticked, count × points for a per-unit quest, else the lead points
  function donePoints(quest) {
    var v = doneValue(quest);
    if (Array.isArray(v)) {
      var ticked = v;
      return quest.codes.reduce(function (sum, c) { return sum + (ticked.indexOf(c.code) !== -1 ? (Number(c.points) || 0) : 0); }, 0);
    }
    if (typeof v === 'number') return v * basePointsOf(quest);
    return isDone(quest) ? basePointsOf(quest) : 0;
  }

  function estimatedTotal() {
    var total = 0;
    QUESTS.filter(isDone).forEach(function (q) { total += donePoints(q); });
    return total;
  }

  // the total as written: a ticked mystery quest adds ??? to it
  function totalText() {
    var text = estimatedTotal().toLocaleString();
    return QUESTS.some(function (q) { return q.mystery && isDone(q); }) ? text + ' + ???' : text;
  }

  // Flips the quest's card in place so the tick can draw itself before
  // the list is rebuilt. Returns false when the card is not on the page.
  function tickInPlace(quest, done) {
    var items = listEl.querySelectorAll('.ql-item');
    var item = null;
    for (var i = 0; i < items.length; i++) {
      if (items[i].dataset.questId === quest.id) { item = items[i]; break; }
    }
    if (!item) return false;
    var complete = done && isComplete(quest);
    item.classList.toggle('is-done', complete);
    item.classList.toggle('is-partial', done && !complete);
    if (done && !window.scs.reducedMotion) window.scs.replay(item, 'is-just-done');
    var check = item.querySelector('.ql-check');
    if (check) check.setAttribute('aria-pressed', done ? 'true' : 'false');
    return true;
  }

  // The list rebuild after a tick waits for the card's mark to land;
  // markers and the tally move at once.
  var listRebuildTimer = null;
  function rebuildAfterTick(delay) {
    renderMarkers();
    renderProgress();
    window.clearTimeout(listRebuildTimer);
    listRebuildTimer = window.setTimeout(function () { renderList(true); }, delay);
  }

  function setDone(quest, value) {
    if (value === undefined) {
      value = quest.multi ? quest.codes.map(function (c) { return c.code; }) : quest.repeat ? 1 : true;
    }
    var was = isDone(quest);
    var wasComplete = isComplete(quest);
    state.done[quest.id] = value;
    saveDoneMap();
    // The rebuild waits whenever the card's mark changes, so the mark
    // has time to arrive: the tick draws itself, and on a quest going
    // half-done the box takes its yellow and the dot springs onto it.
    // Ticking another part of an already half-done quest changes no
    // mark, so that one does not wait.
    var markChanged = !was || wasComplete !== isComplete(quest);
    var landed = tickInPlace(quest, true);
    rebuildAfterTick(landed && markChanged && !window.scs.reducedMotion ? 420 : 0);
    if (window.scsHaptic) window.scsHaptic(was ? 'light' : 'success');
    if (window.scsToast) {
      var worth = quest.mystery ? '+???' : (donePoints(quest) < 0 ? '\u2212' + (-donePoints(quest)) : '+' + donePoints(quest));
      window.scsToast((was ? 'Updated. ' : 'Ticked off. ') + worth + ' pts, total ' + totalText() + '.');
    }
  }

  // one code of a tiered quest on or off
  function toggleCode(quest, code) {
    var list = tickedCodes(quest).slice();
    var at = list.indexOf(code);
    if (at === -1) list.push(code); else list.splice(at, 1);
    if (list.length) setDone(quest, list); else clearDone(quest);
  }

  // a per-unit quest: how many times
  function setCount(quest, n) {
    n = Math.max(0, Math.min(99, Math.round(n)));
    if (n === 0) { if (isDone(quest)) clearDone(quest); return; }
    setDone(quest, n);
  }

  function clearDone(quest) {
    delete state.done[quest.id];
    saveDoneMap();
    rebuildAfterTick(tickInPlace(quest, false) && !window.scs.reducedMotion ? 180 : 0);
    if (window.scsHaptic) window.scsHaptic('light');
    if (window.scsToast) window.scsToast('Un-ticked. Est. points now ' + totalText() + ' pts.');
  }

  // The list tick: off is off; on is on for a plain quest, and opens
  // the sheet for a quest with codes or a count to choose.
  function handleCheckTap(quest) {
    if (isDone(quest)) {
      // part-way through a tiered quest: the sheet is where the rest gets ticked
      if (!isComplete(quest)) { ql.openDetail(quest, false); flashCodes(); return; }
      clearDone(quest);
      if (state.activeQuest === quest) ql.updateDetailDoneButton();
      return;
    }
    // a quest with tiers, or one counted per unit, cannot be ticked
    // from the list — the sheet is where the choice is made. Opening
    // it on its own looks like nothing happened, so the box holding
    // that choice flashes once as it arrives.
    if (quest.multi || quest.repeat) { ql.openDetail(quest, false); flashCodes(); return; }
    setDone(quest);
  }

  // Warm light breathes in the codes box while the rest of the sheet
  // holds back, four breaths over 2.7 seconds (the timing is in the
  // stylesheet; the last breath is the quickest, so the run ends
  // rather than trailing off). One class on the sheet drives all of
  // it, so the glow, the red line and the dim cannot drift apart.
  var CUE_MS = 2700;
  // The sheet's own entrance is a 320ms morph that fades the whole
  // thing up from the card. Starting inside it meant the text was on
  // its way down to the dim before the sheet had finished arriving, so
  // it never showed at full strength and read as having been born
  // faint. The cue waits for the sheet to land instead.
  var CUE_WAIT = 340;
  var cueTimers = [];
  // the release has a timer of its own: a stop or a new cue clears the
  // cue's timers, and the release must still come off
  var cueOutTimer = 0;

  function cueSheet() { return document.querySelector('#ql-detail-overlay .ql-detail'); }
  function clearCueTimers() {
    for (var i = 0; i < cueTimers.length; i++) window.clearTimeout(cueTimers[i]);
    cueTimers = [];
  }
  function endCueOut(sheet) {
    window.clearTimeout(cueOutTimer);
    cueOutTimer = 0;
    sheet.classList.remove('is-cue-out');
  }

  // the children the dim covers: everything but the codes box and the
  // grab bar (the same set the stylesheet holds at 0.42)
  var cueDimAnims = [];
  function cueDimTargets(sheet) {
    var out = [];
    for (var i = 0; i < sheet.children.length; i++) {
      var el = sheet.children[i];
      if (el.classList.contains('ql-detail-points') || el.classList.contains('ql-sheet-handle')) continue;
      out.push(el);
    }
    return out;
  }
  function settleCueDims() {
    for (var i = 0; i < cueDimAnims.length; i++) {
      try { cueDimAnims[i].finish(); } catch (err) { /* already done */ }
    }
    cueDimAnims = [];
  }

  // The codes box is the last block on the sheet now — the description,
  // where it is and what came with it are read first — so on a phone
  // opened at half height it starts below the fold, and a cue nobody
  // can see is not a cue. The sheet is brought to it first, on its own
  // scroller rather than through scrollIntoView, which would also walk
  // up and move the page behind the sheet.
  function revealCodes(sheet) {
    var box = sheet.querySelector('.ql-detail-points');
    var max = sheet.scrollHeight - sheet.clientHeight;
    if (!box || max <= 0) return;
    var want = Math.max(0, Math.min(box.offsetTop - 12, max));
    if (Math.abs(sheet.scrollTop - want) < 4) return;
    if (sheet.scrollTo) sheet.scrollTo({ top: want, behavior: 'smooth' });
    else sheet.scrollTop = want;
  }

  function flashCodes() {
    var sheet = cueSheet();
    if (!sheet || window.scs.reducedMotion) return;
    clearCueTimers();
    cueTimers.push(window.setTimeout(function () {
      revealCodes(sheet);
      // a release still running would hold the light down over the cue
      endCueOut(sheet);
      window.scs.replay(sheet, 'is-cueing');
      // The step down is driven from here rather than trusted to a
      // stylesheet rule: on some phones a child's own animation kept
      // the class's fade from showing and the sheet snapped to its
      // dim. A script animation on each child outranks everything in
      // the stylesheet, so the fade reads the same everywhere; it
      // lands on the class's static 0.42 when it ends.
      settleCueDims();
      cueDimAnims = cueDimTargets(sheet).map(function (el) {
        return el.animate(
          [{ opacity: window.getComputedStyle(el).opacity }, { opacity: 0.42 }],
          { duration: window.scs.ms('--duration-fast', 250), easing: 'ease-in-out' }
        );
      });
      // the run ends by dropping the class, which lets the sheet come
      // back out of its dim on the ordinary transition
      cueTimers.push(window.setTimeout(function () { sheet.classList.remove('is-cueing'); }, CUE_MS));
    }, CUE_WAIT));
  }

  // Once the choice has been made the cue has said what it was for, so
  // it stops rather than carrying on over the top of it. Taking the
  // class off mid-breath would cut the light dead in one frame — a
  // browser does not transition out of an animation it has just been
  // handed back — so where the light and the red had got to is written
  // down first, and a short release animation carries them home from
  // there. The dim needs none of this: it is a plain transition.
  function stopFlashCodes() {
    var sheet = cueSheet();
    clearCueTimers();
    // a dim still fading in lands on 0.42 first, so the transition
    // home starts from where the class holds it, not a snap
    settleCueDims();
    if (!sheet || !sheet.classList.contains('is-cueing')) return;
    var box = sheet.querySelector('.ql-detail-points');
    if (box) sheet.style.setProperty('--cue-from-light', window.getComputedStyle(box, '::before').opacity);
    sheet.classList.remove('is-cueing');
    window.clearTimeout(cueOutTimer);
    window.scs.replay(sheet, 'is-cue-out');
    cueOutTimer = window.setTimeout(function () { endCueOut(sheet); }, 400);
  }

  // the tally counts each ticked quest at its headline (first code) points
  function basePointsOf(quest) { return quest.basePoints; }

  // The sheet's route colour is its region's, red where none is set;
  // yellow, lime and grey carry a dark letter.
  var DARK_LETTER = { yellow: true, lime: true, grey: true };
  function paintRoute(sheet, region) {
    if (!sheet) return;
    var colour = ROUTE_COLOURS[String(region || '').toUpperCase()] || '';
    if (/^[a-z]+$/.test(colour)) {
      sheet.style.setProperty('--ql-route', 'var(--line-' + colour + ')');
      sheet.style.setProperty('--ql-route-ink', DARK_LETTER[colour] ? '#111111' : '#ffffff');
    } else {
      sheet.style.removeProperty('--ql-route');
      sheet.style.removeProperty('--ql-route-ink');
    }
  }

  // The route disc on the sheet's head carries the region's initial. A
  // leading "The" is dropped, so The Mainland reads M rather than T.
  function regionLetter(region) {
    var name = String(region || '').replace(/^the\s+/i, '').trim();
    return name ? name.charAt(0).toUpperCase() : '?';
  }

  function webglAvailable() {
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) { return false; }
  }

  function loadMapLibre() {
    return new Promise(function (resolve, reject) {
      if (window.maplibregl) return resolve(window.maplibregl);
      // a device that cannot draw it says so in the map's place
      if (!webglAvailable()) return reject(new Error('no WebGL'));
      // a second try after a failed one adds the stylesheet once
      if (!document.getElementById('ql-maplibre-css')) {
        var link = document.createElement('link');
        link.id = 'ql-maplibre-css';
        link.rel = 'stylesheet';
        link.href = MAPLIBRE_CSS_URL;
        document.head.appendChild(link);
      }
      // the library's script, asked for again when it does not arrive
      var waits = [500, 1500, 4000];
      var n = 0;
      (function ask() {
        var script = document.createElement('script');
        script.src = MAPLIBRE_JS_URL;
        script.onload = function () {
          if (window.maplibregl) resolve(window.maplibregl);
          else reject(new Error('MapLibre missing'));
        };
        script.onerror = function () {
          if (script.parentNode) script.parentNode.removeChild(script);
          if (n < waits.length) setTimeout(ask, waits[n++]);
          else reject(new Error('MapLibre could not be loaded.'));
        };
        document.head.appendChild(script);
      })();
    });
  }

  function haversineKm(a, b) {
    var R = 6371;
    var dLat = (b.lat - a.lat) * Math.PI / 180;
    var dLng = (b.lng - a.lng) * Math.PI / 180;
    var la1 = a.lat * Math.PI / 180;
    var la2 = b.lat * Math.PI / 180;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function questDistanceKm(quest) {
    if (!state.userPos || !quest.locations.length) return null;
    var best = Infinity;
    quest.locations.forEach(function (loc) {
      var d = haversineKm(state.userPos, loc);
      if (d < best) best = d;
    });
    return best;
  }

  function locationText(quest) {
    if (quest.locationLabel) return quest.locationLabel;
    if (quest.locations.length) {
      return quest.locations.map(function (l) { return l.label; }).join(' • ');
    }
    return 'No Fixed Location';
  }

  // A quest with no coordinates gets no pin, and on this list that is
  // more than half of them — the conga on a train, the op shop, the
  // briefings. They are done wherever you are, or at whatever place of
  // the right sort you pass, which is why the filters, the sort and the
  // map's chip all have to know about them.
  function isAnywhere(quest) { return !quest.locations.length; }

  function pointsSummary(points) {
    return points.split('\n')[0];
  }

  // a question organisers have open on this quest right now
  function isLive(quest) {
    return !!(quest.ask && quest.ask.kind && quest.ask.open);
  }

  // skipSearch: the map's list has its own search box instead of the panel's
  function matchesFilters(quest, skipSearch) {
    if (state.hideDone && isComplete(quest)) return false;
    if (state.liveOnly && !isLive(quest)) return false;
    if (state.category !== 'all' && quest.category !== state.category) return false;
    if (state.list) {
      var list = listById(state.list);
      if (!list || !inList(list, quest)) return false;
    }
    if (state.search && !skipSearch) {
      // loose matching, shared with the map's search and the submit
      // page: a code found anywhere ("18"), a name a letter or two off
      if (!scs.questScore(quest, state.search, quest.description + ' ' + locationText(quest) + ' ' + quest.category)) return false;
    }
    if (state.anywhereOnly && !isAnywhere(quest)) return false;
    // a quest without a pin is never out of range: it is wherever you are
    if (isAnywhere(quest)) return state.showUnlocated;
    if (state.userPos) {
      var d = questDistanceKm(quest);
      if (d !== null && d > state.radiusKm) return false;
    }
    return true;
  }

  // matchesFilters takes (quest, skipSearch), so it must never be
  // handed to .filter bare: filter passes the index second, and every
  // index past 0 read as "skip the text search" — typing in the search
  // box filtered exactly one quest.
  function visibleQuests() {
    return QUESTS.filter(function (q) { return matchesFilters(q); });
  }

  // ---------- Rendering ----------
  var listEl = document.getElementById('ql-list');
  var countEl = document.getElementById('ql-count');

  function renderList(quiet, precomputed) {
    var quests = precomputed || visibleQuests();
    listEl.innerHTML = '';
    window.clearTimeout(listRebuildTimer);
    // the distance column is only there while there is a distance to show
    var card = document.querySelector('.ql-list-card');
    if (card) card.classList.toggle('has-distance', !!state.userPos);

    var located = quests.filter(function (q) { return q.locations.length; }).length;
    var hiddenDone = state.hideDone ? QUESTS.filter(isComplete).length : 0;
    window.scs.swapText(countEl, quests.length + ' of ' + QUESTS.length + ' quests shown' +
      (state.userPos ? ' (' + located + ' mappable within ' + state.radiusKm + ' km)' : '') +
      (hiddenDone ? ' · ' + hiddenDone + ' ticked-off hidden' : ''));

    if (!quests.length) {
      var empty = document.createElement('p');
      empty.className = 'ql-empty';
      var picked = state.list && listById(state.list);
      empty.textContent = picked && !listCount(picked) ? 'No quests in this list.' : 'No quests match.';
      listEl.appendChild(empty);
      return;
    }

    var frag = document.createDocumentFragment();
    ql.CATEGORY_ORDER.forEach(function (cat) {
      var inCat = quests.filter(function (q) { return q.category === cat; });
      if (!inCat.length) return;

      var title = document.createElement('p');
      title.className = 'ql-group-title';
      title.textContent = cat;
      frag.appendChild(title);

      if (state.userPos) {
        // An anywhere quest costs no travel, so it sorts as if it were
        // right here — at the top of its region, not below every pin.
        // Sorting it last was what buried half the list the moment
        // anyone shared their location.
        var km = function (q) {
          var d = questDistanceKm(q);
          return d === null ? 0 : d;
        };
        inCat.sort(function (a, b) { return km(a) - km(b); });
      }

      inCat.forEach(function (quest) {
        var done = isDone(quest);
        var complete = isComplete(quest);

        var item = document.createElement('div');
        item.className = 'ql-item' + (complete ? ' is-done' : done ? ' is-partial' : '');
        item.dataset.questId = quest.id; // lets a dismissed sheet find its card again

        var check = document.createElement('button');
        check.type = 'button';
        check.className = 'ql-check';
        var tick = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        tick.setAttribute('viewBox', '0 0 10.17 10.17');
        tick.setAttribute('aria-hidden', 'true');
        var stroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        stroke.setAttribute('d', 'M1 5.52L3.92 9.17L9.17 1');
        tick.appendChild(stroke);
        check.appendChild(tick);
        check.setAttribute('aria-pressed', complete ? 'true' : done ? 'mixed' : 'false');
        check.setAttribute('aria-label', (complete ? 'Un-tick ' : done ? 'Finish ticking ' : 'Tick off ') + quest.name);
        check.title = complete ? 'Un-tick this quest' : done ? 'Some of this quest is ticked' : 'Tick off as done';
        check.addEventListener('click', function () { handleCheckTap(quest); });
        item.appendChild(check);

        var body = document.createElement('button');
        body.type = 'button';
        body.className = 'ql-item-body';

        // The row is five cells in the order the column heads name them:
        // the code, the quest, where it is, how far away it is and what
        // it pays. The code is its own cell rather than part of the
        // name, so the strike a tick draws runs across the name alone —
        // it still comes before the LIVE tag and the name in the
        // document, which is the order the marks are read in.
        var codeChip = document.createElement('span');
        codeChip.className = 'code ql-code';
        codeChip.textContent = quest.id;
        body.appendChild(codeChip);

        var name = document.createElement('span');
        name.className = 'ql-item-name';
        // on one of this device's lists
        if (inAnyList(quest)) name.appendChild(ql.bookmarkIcon('ql-saved-mark', true, 'On a list'));
        // a question is open on this quest right now
        if (isLive(quest)) {
          var liveTag = document.createElement('span');
          liveTag.className = 'ql-live';
          liveTag.textContent = 'Live';
          name.appendChild(liveTag);
        }
        // the name is its own span so the strike can draw across it
        // and leave the code chip alone, which dims instead
        var nameText = document.createElement('span');
        nameText.className = 'ql-item-label';
        nameText.textContent = quest.name;
        name.appendChild(nameText);
        body.appendChild(name);

        var meta = document.createElement('span');
        meta.className = 'ql-item-meta' + (isAnywhere(quest) && !quest.locationLabel ? ' is-anywhere' : '');
        meta.textContent = locationText(quest);
        body.appendChild(meta);

        var d = questDistanceKm(quest);
        if (d !== null) {
          var dist = document.createElement('span');
          dist.className = 'ql-item-distance';
          dist.textContent = '~' + (d < 10 ? d.toFixed(1) : Math.round(d)) + ' km away';
          body.appendChild(dist);
        }

        var pts = document.createElement('span');
        pts.className = 'ql-item-points';
        pts.textContent = pointsSummary(quest.points);
        body.appendChild(pts);

        body.addEventListener('click', function () {
          // /submit in the search box: the row is the way to that
          // quest's proof form, not to its sheet
          if (state.submitMode) { window.location.href = ql.submitHref(quest); return; }
          ql.openDetail(quest, true, item);
        });
        item.appendChild(body);

        // "Full quest information": everything the page at full/ shows,
        // folded under the row instead of on a page of its own
        if (state.fullInfo) {
          var more = fullBlockFor(quest);
          if (more) item.appendChild(more);
        }

        frag.appendChild(item);
      });
    });
    listEl.appendChild(frag);
  }

  // The block full/ draws for one quest — description, flavour, the
  // code table, the files — from full/full.js, so the two pages cannot
  // drift into two ways of saying the same thing. It is built once and
  // kept: the list is rebuilt on every keystroke and after every tick,
  // and re-running the markdown and re-fetching ninety thumbnails each
  // time would be felt. Clearing the list only detaches these, so the
  // same node goes back in.
  var fullBlocks = {};
  function fullBlockFor(quest) {
    if (!window.scsFullQuest) return null;
    if (fullBlocks.hasOwnProperty(quest.id)) return fullBlocks[quest.id];
    var parts = window.scsFullQuest.details(quest, { location: false });
    if (!parts.firstChild) { fullBlocks[quest.id] = null; return null; }
    var box = document.createElement('div');
    box.className = 'ql-item-full';
    box.appendChild(parts);
    var links = document.createElement('p');
    links.className = 'fl-links';
    var submit = document.createElement('a');
    submit.href = ql.submitHref(quest);
    submit.textContent = 'Submit proof';
    links.appendChild(submit);
    box.appendChild(links);
    fullBlocks[quest.id] = box;
    return box;
  }

  // The marks the page draws on the map carry the site's own colours:
  // a pin is the accent green, a ticked one the rule grey, the
  // you-are-here dot the line blue. They are read from the stylesheet's
  // tokens as they are drawn, so a theme flip repaints them with the
  // page — a canvas cannot read a custom property itself, and this is
  // the one place the two meet.
  function siteColor(token, fallback) {
    var v = '';
    try { v = getComputedStyle(document.documentElement).getPropertyValue(token); } catch (e) { /* no styles yet */ }
    v = String(v || '').trim();
    return v || fallback;
  }

  function pinInks() {
    return {
      accent: siteColor('--accent', '#00933c'),
      // white in both themes: the dark card colour is the land's own
      paper: '#ffffff',
      doneRing: siteColor('--border-strong', '#8a8a8a'),
      doneFill: siteColor('--border', '#d5d5d5')
    };
  }

  function renderMarkers(precomputed) {
    var ink = pinInks(); // read once per render, not once per pin
    var features = [];
    (precomputed || visibleQuests()).forEach(function (quest) {
      // only a fully ticked quest greys its pins — a partly ticked
      // tiered quest still has places worth going to
      var done = isComplete(quest);
      quest.locations.forEach(function (loc) {
        features.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [loc.lng, loc.lat] },
          properties: {
            quest: quest.id,
            name: quest.name + (done ? ' (done)' : ''),
            label: loc.label || '',
            stroke: done ? ink.doneRing : ink.accent,
            fill: done ? ink.doneFill : (quest.category === 'Main Quests' ? ink.accent : ink.paper),
            lit: 0
          }
        });
      });
    });
    state.pins = features;
    // a re-render during an open sheet (a tick, a filter change) must
    // not lose the highlight on the quest being read
    var open = state.activeQuest && ql.overlay && !ql.overlay.classList.contains('is-hidden');
    state.litQuest = open ? state.activeQuest.id : null;
    drawPins();
  }

  // The open quest's pins stand out and name themselves — the same
  // label a pin shows under the mouse — so a quest picked from the list
  // or the search results can be told apart from its neighbours.
  function drawPins() {
    var lit = state.litQuest;
    var calm = [];
    var loud = [];
    (state.pins || []).forEach(function (f) {
      f.properties.lit = f.properties.quest === lit ? 1 : 0;
      (f.properties.lit ? loud : calm).push(f);
    });
    // the open quest's pins have a source of their own, so they are never
    // folded into a group
    ql.setMapData('pins', ql.featureSet(calm));
    ql.setMapData('lit', ql.featureSet(loud));
    (state.pinTips || []).forEach(function (tip) { tip.remove(); });
    state.pinTips = [];
    // under the small card the pins stand out without naming themselves:
    // the card names the quest
    if (!lit || !state.map || state.litQuiet) return;
    state.pins.forEach(function (f) {
      if (!f.properties.lit) return;
      state.pinTips.push(ql.mapTip(16).setLngLat(f.geometry.coordinates).setText(f.properties.name).addTo(state.map));
    });
  }

  function clearQuestHighlight() {
    if (!state.litQuest) return;
    state.litQuest = null;
    drawPins();
  }

  function highlightQuestMarkers(quest) {
    state.litQuest = quest ? quest.id : null;
    drawPins();
  }

  function renderProgress() {
    var doneQuests = QUESTS.filter(isDone);
    window.scs.digits(document.getElementById('ql-done-count'), doneQuests.length + ' of ' + QUESTS.length);
    window.scs.digits(document.getElementById('ql-done-points'), totalText());
  }

  // quiet: rebuild without the list rising in (typing, a slider drag)
  function refresh(quiet) {
    var quests = visibleQuests();
    renderList(quiet, quests);
    renderMarkers(quests);
    renderProgress();
    ql.renderSearchResults(); // the map's list rides the same filters
    syncAnywhereChip();
    syncSearchPlaceholder();
  }

  // the collapsed panel shows no chips, so the box names what is picked
  function syncSearchPlaceholder() {
    var box = document.getElementById('ql-search-input');
    if (!box) return;
    var list = state.list ? listById(state.list) : null;
    var scope = list ? list.name : state.category && state.category !== 'all' ? state.category : '';
    box.placeholder = scope ? 'Search ' + scope : 'Search quests';
  }

  // ---------- The map's anywhere chip ----------
  // The map can only draw quests that have coordinates, which on this
  // list is fewer than half of them, so a map read as the whole list
  // hides the rest. The chip sits on the map, counts what the pins are
  // not showing, and switches the list to exactly those.
  var anywhereChip = document.getElementById('ql-map-anywhere');
  var anywhereChipNum = document.getElementById('ql-map-anywhere-num');
  var anywhereChipLabel = document.getElementById('ql-map-anywhere-label');

  // how many anywhere quests the other filters leave: a picked region
  // or hidden ticked-off quests count down with it. Both location flags
  // are put aside — the chip counts what is missing from the map, not
  // what the list happens to be showing — so matchesFilters stays the
  // one place the rules live.
  function anywhereCount() {
    var wasOnly = state.anywhereOnly;
    var wasShow = state.showUnlocated;
    state.anywhereOnly = false;
    state.showUnlocated = true;
    var n = 0;
    QUESTS.forEach(function (q) { if (isAnywhere(q) && matchesFilters(q)) n++; });
    state.anywhereOnly = wasOnly;
    state.showUnlocated = wasShow;
    return n;
  }

  // Three states, one chip: the map is missing N quests, the list is
  // already narrowed to those N, or those N are hidden altogether. It
  // always says what the pins are leaving out, and a tap always gets
  // you to them.
  function syncAnywhereChip() {
    if (!anywhereChip) return;
    var n = anywhereCount();
    var hiding = !state.showUnlocated;
    // while a filter is on the chip is the way back out, so it stays
    // even if nothing is left to count
    anywhereChip.classList.toggle('is-hidden', n === 0 && !state.anywhereOnly && !hiding);
    if (anywhereChipNum) window.scs.swapText(anywhereChipNum, String(n));
    if (anywhereChipLabel) window.scs.swapText(anywhereChipLabel, hiding ? 'hidden' : 'not on the map');
    anywhereChip.classList.toggle('is-on', state.anywhereOnly);
    anywhereChip.classList.toggle('is-off', hiding);
    anywhereChip.setAttribute('aria-pressed', state.anywhereOnly ? 'true' : 'false');
    anywhereChip.title = hiding
      ? 'Show these quests again'
      : state.anywhereOnly
        ? 'Show every quest again'
        : 'Show only the quests you can do anywhere';
  }

  // The pair is exclusive: showing only the quests with no pin and
  // hiding them are the same switch pulled two ways, so whichever one
  // is touched stands the other down.
  function setAnywhereOnly(on) {
    state.anywhereOnly = !!on;
    if (state.anywhereOnly) state.showUnlocated = true;
    syncFilterBoxes();
    refresh();
  }

  function setShowUnlocated(on) {
    state.showUnlocated = !!on;
    if (!state.showUnlocated) state.anywhereOnly = false;
    syncFilterBoxes();
    refresh();
  }

  function syncFilterBoxes() {
    var only = document.getElementById('ql-anywhere-only');
    var show = document.getElementById('ql-show-unlocated');
    if (only) only.checked = state.anywhereOnly;
    if (show) show.checked = state.showUnlocated;
  }

  if (anywhereChip) {
    anywhereChip.addEventListener('click', function () {
      // hidden: put them back. Otherwise narrow to them, or undo that.
      if (!state.showUnlocated) { setShowUnlocated(true); return; }
      var on = !state.anywhereOnly;
      setAnywhereOnly(on);
      if (!on) return;
      // none of these quests have pins, so leaving the tap on an empty
      // map would look like a fault: land on the list instead
      if (document.documentElement.classList.contains('ql-map-full')) {
        ql.raiseMapSearch();
      } else {
        var card = document.querySelector('.ql-list-card');
        if (card) {
          card.scrollIntoView({
            behavior: window.scs.reducedMotion ? 'auto' : 'smooth',
            block: 'start'
          });
        }
      }
    });
  }

  // ---------- Live tab stats: how many teams have done a quest ----------
  // Served by the tab bot worker's HTTP API, straight from the same D1
  // database the Discord commands read. Fetched once per visit and
  // refreshed after a minute; looked up by tab shortcode. Quests with
  // no exact tab code, or an unreachable API, just leave the line out.
  var TAB_API = 'https://files.scs.andyrew.space';
  var TAB_STATS_KEY = 'scs2-tab-stats-cache';
  var tabStats = null;
  var tabStatsAt = 0;
  var tabStatsPromise = null;

  var normTabCode = window.scs.normQuest;

  // the copy the last visit kept: the sheet's teams line renders from
  // it at once instead of waiting on the network every time
  try {
    var storedStats = JSON.parse(localStorage.getItem(TAB_STATS_KEY) || 'null');
    if (storedStats && typeof storedStats.total === 'number') {
      tabStats = storedStats;
      // a copy under a minute old is not asked for again on this load
      tabStatsAt = Number(storedStats.at) || 0;
    }
  } catch (err) { /* first visit */ }

  function refreshTabStats() {
    if (tabStatsPromise) return tabStatsPromise;
    tabStatsPromise = window.scs.fetch(TAB_API + '/api/quests', { cache: 'no-cache' }).then(function (r) {
      if (!r.ok) throw new Error('tab api ' + r.status);
      return r.json();
    }).then(function (data) {
      // closed: nothing to say, and the copy from before goes too
      if (data.closed) {
        try { localStorage.removeItem(TAB_STATS_KEY); } catch (err) { /* nothing kept */ }
        tabStats = { total: 0, byCode: {}, byGroup: {} };
        tabStatsAt = Date.now();
        tabStatsPromise = null;
        return tabStats;
      }
      var byCode = {};
      (data.quests || []).forEach(function (q) { byCode[normTabCode(q.code)] = q.teams_done; });
      var byGroup = {};
      Object.keys(data.groups || {}).forEach(function (key) { byGroup[normTabCode(key)] = data.groups[key]; });
      tabStatsAt = Date.now();
      tabStats = { total: data.total_teams, byCode: byCode, byGroup: byGroup, at: tabStatsAt };
      tabStatsPromise = null;
      try { localStorage.setItem(TAB_STATS_KEY, JSON.stringify(tabStats)); } catch (err) { /* not kept */ }
      return tabStats;
    }).catch(function (err) {
      tabStatsPromise = null;
      throw err;
    });
    return tabStatsPromise;
  }

  function fetchTabStats() {
    if (tabStats && Date.now() - tabStatsAt < 60000) return Promise.resolve(tabStats);
    if (tabStats) {
      // a kept or minute-old copy answers now; the refresh lands
      // behind it for the next sheet
      refreshTabStats().catch(function () { /* the copy stands */ });
      return Promise.resolve(tabStats);
    }
    return refreshTabStats();
  }

  // for the parts after this one
  ql.MAP_STYLE_URL = MAP_STYLE_URL;
  ql.MAP_GLYPHS = MAP_GLYPHS;
  ql.LOCAL_GLYPH_RANGES = LOCAL_GLYPH_RANGES;
  ql.REMOTE_GLYPHS = REMOTE_GLYPHS;
  ql.QUESTS = QUESTS;
  ql.DONE_STORAGE_KEY = DONE_STORAGE_KEY;
  ql.TRANSIT_STORAGE_KEY = TRANSIT_STORAGE_KEY;
  ql.LIGHT_MAP_STORAGE_KEY = LIGHT_MAP_STORAGE_KEY;
  ql.LISTS_STORAGE_KEY = LISTS_STORAGE_KEY;
  ql.SAVED_LIST = SAVED_LIST;
  ql.MAX_LISTS = MAX_LISTS;
  ql.LIST_NAME_MAX = LIST_NAME_MAX;
  ql.state = state;
  ql.listEl = listEl;
  ql.countEl = countEl;
  ql.TAB_API = TAB_API;
  ql.normTabCode = normTabCode;
});
