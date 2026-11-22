// The quest page's script, part five of five: the whole screen, the chip
// row, the desktop layout and the full-screen map's search. Runs all five.
(window.scsQuestList = window.scsQuestList || { parts: [] }).parts.push(function (ql) {
  'use strict';

  // from the parts before this one
  var LOCAL_GLYPH_RANGES = ql.LOCAL_GLYPH_RANGES;
  var REMOTE_GLYPHS = ql.REMOTE_GLYPHS;
  var QUESTS = ql.QUESTS;
  var state = ql.state;
  var isComplete = ql.isComplete;
  var loadMapLibre = ql.loadMapLibre;
  var questDistanceKm = ql.questDistanceKm;
  var locationText = ql.locationText;
  var pointsSummary = ql.pointsSummary;
  var isLive = ql.isLive;
  var matchesFilters = ql.matchesFilters;
  var renderMarkers = ql.renderMarkers;
  var drawPins = ql.drawPins;
  var overlay = ql.overlay;
  var openDetail = ql.openDetail;
  var sheetMq = ql.sheetMq;
  var mapCardEl = ql.mapCardEl;
  var sheetStop = ql.sheetStop;
  var submitHref = ql.submitHref;
  var readSearchBox = ql.readSearchBox;
  var placePill = ql.placePill;
  var chipsRow = ql.chipsRow;
  var MAP_BOUNDS = ql.MAP_BOUNDS;
  var MAP_CENTER = ql.MAP_CENTER;
  var discoverTileUrl = ql.discoverTileUrl;
  var loadBaseStyle = ql.loadBaseStyle;
  var mapData = ql.mapData;
  var setMapData = ql.setMapData;
  var buildStyle = ql.buildStyle;
  var paintMapGround = ql.paintMapGround;
  var fetchTransit = ql.fetchTransit;
  var syncTransit = ql.syncTransit;
  var hideHoverTip = ql.hideHoverTip;
  var hoverAt = ql.hoverAt;
  var onMapClick = ql.onMapClick;
  var installTapZoom = ql.installTapZoom;
  var wheelStop = ql.wheelStop;
  var mapFullBtn = ql.mapFullBtn;
  var mapLocateBtn = ql.mapLocateBtn;
  var syncDrawer = ql.syncDrawer;
  var setFiltersOpen = ql.setFiltersOpen;
  var positionMapControls = ql.positionMapControls;
  var setMapFull = ql.setMapFull;
  var afterDrawerCloses = ql.afterDrawerCloses;

  // functions the other parts call
  ql.realFullscreen = realFullscreen;
  ql.measureChips = measureChips;
  ql.placeFilters = placeFilters;
  ql.foldChips = foldChips;
  ql.syncSide = syncSide;
  ql.resizeMap = resizeMap;
  ql.setSearchChevron = setSearchChevron;
  ql.resetSearchChevron = resetSearchChevron;
  ql.unfadeMapUi = unfadeMapUi;
  ql.collapseMapSearch = collapseMapSearch;
  ql.raiseMapSearch = raiseMapSearch;
  ql.openQuestPanel = openQuestPanel;
  ql.restoreSearchAfterSheet = restoreSearchAfterSheet;
  ql.setSearchState = setSearchState;
  ql.renderSearchResults = renderSearchResults;

  // ---------- The whole screen ----------
  // Where a browser lets a page have the whole screen (Android, an iPad),
  // the full-screen map takes it, so the browser's own bars go too. Only
  // the tap on the full screen button asks, since nothing else counts as
  // a gesture by the time it runs. An iPhone's Safari has no way to, and
  // is told once how the map gets the whole screen there.
  var fsRoot = document.documentElement;
  var askedFullscreen = false;
  function fullscreenNow() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function realFullscreen(on) {
    var handheldNow = window.matchMedia('(pointer: coarse)').matches;
    if (!handheldNow || fsRoot.classList.contains('is-installed')) return;
    var req = fsRoot.requestFullscreen || fsRoot.webkitRequestFullscreen;
    if (on) {
      if (!req) { homeScreenHint(); return; }
      if (fullscreenNow()) return;
      askedFullscreen = true;
      try {
        var asked = req.call(fsRoot, { navigationUI: 'hide' });
        if (asked && asked.catch) asked.catch(function () { askedFullscreen = false; });
      } catch (err) { askedFullscreen = false; }
    } else if (askedFullscreen) {
      askedFullscreen = false;
      if (!fullscreenNow()) return;
      var exit = document.exitFullscreen || document.webkitExitFullscreen;
      try {
        var left = exit.call(document);
        if (left && left.catch) left.catch(function () { /* already out */ });
      } catch (err) { /* already out */ }
    }
  }
  var HOME_HINT_KEY = 'scs2-map-home-screen-hint';
  function homeScreenHint() {
    if (!/iPhone|iPod/.test(navigator.userAgent)) return;
    try {
      if (localStorage.getItem(HOME_HINT_KEY)) return;
      localStorage.setItem(HOME_HINT_KEY, '1');
    } catch (err) { return; }
    if (window.scsToast) window.scsToast('Add SCS.2 to your Home Screen to have the map without Safari’s bars.');
  }
  // the phone's own back or swipe out of full screen takes the map out too
  ['fullscreenchange', 'webkitfullscreenchange'].forEach(function (name) {
    document.addEventListener(name, function () {
      if (fullscreenNow() || !askedFullscreen) return;
      askedFullscreen = false;
      if (document.documentElement.classList.contains('ql-map-full')) leaveMapFull();
    });
  });

  // Every way out of full screen but the back gesture comes through here.
  // The drawer and then the search panel close first, each waiting for
  // the pop the one before left in flight, so the map's own back layer
  // is the top one when it goes: a layer closed under another leaves its
  // history entry behind as a back press that does nothing.
  function leaveMapFull() {
    afterDrawerCloses(function () {
      if (searchLayer && overlay.classList.contains('is-hidden')) {
        collapseMapSearch();
        window.scsBackLayer.after(function () { setMapFull(false); });
        return;
      }
      setMapFull(false);
    });
  }

  if (mapFullBtn) {
    mapFullBtn.addEventListener('click', function () {
      if (document.documentElement.classList.contains('ql-map-full')) { leaveMapFull(); return; }
      // asked for inside the tap, which is the only time a browser grants it
      realFullscreen(true);
      afterDrawerCloses(function () { setMapFull(true); });
    });
  }

  // The settings menu's Full screen map rocker: site-input.js stamps
  // html.ql-map-home from the stored choice before this runs, and here
  // is where the page acts on it. It waits for the map, because the
  // morph measures the card's box and the card has no box until the
  // page has laid out. The reader still leaves with the same button
  // they always did — what the setting changes is where they start.
  if (document.documentElement.classList.contains('ql-map-home')) {
    window.requestAnimationFrame(function () {
      window.requestAnimationFrame(function () { setMapFull(true); });
    });
  }
  if (mapLocateBtn) {
    mapLocateBtn.addEventListener('click', function () {
      startMap();
      // same flow as the drawer's location button: ask, mark, pan
      var locBtn = document.getElementById('ql-locate');
      if (locBtn) locBtn.click();
    });
  }

  // The two filter buttons — one beside the search box on the page, one
  // in the fullscreen map's search row — open the same drawer.
  // Whether the drawer was open when the button went down decides: in
  // Firefox it could close between the press and the click.
  ['ql-filters-btn', 'ql-search-filters-btn'].forEach(function (id) {
    var btn = document.getElementById(id);
    if (!btn) return;
    var openAtPress = null;
    btn.addEventListener('pointerdown', function () {
      openAtPress = document.documentElement.classList.contains('ql-filters-open');
    });
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      var wasOpen = openAtPress === null ? document.documentElement.classList.contains('ql-filters-open') : openAtPress;
      openAtPress = null;
      if (wasOpen) {
        if (document.documentElement.classList.contains('ql-filters-open')) setFiltersOpen(false);
        return;
      }
      // One panel at a time: the settings menu goes first, and this
      // waits for the pop that closing it leaves in flight before
      // arming a layer of its own.
      if (window.scs.closePanels) window.scs.closePanels('filters');
      window.scsBackLayer.after(function () { setFiltersOpen(true); });
    });
  });
  // the other direction: the settings menu, or anything else that opens
  // over the page, says so and this gets out of the way
  document.addEventListener('scs-close-panels', function (e) {
    if (e.detail && e.detail.except === 'filters') return;
    if (document.documentElement.classList.contains('ql-filters-open')) setFiltersOpen(false);
  });
  // A tap anywhere else puts it away, the way the settings menu closes.
  document.addEventListener('click', function (e) {
    if (!document.documentElement.classList.contains('ql-filters-open')) return;
    if (e.target.closest('#ql-filters') || e.target.closest('.ql-filters-btn')) return;
    setFiltersOpen(false);
  });
  var radiusClearBtn = document.getElementById('ql-radius-clear');
  if (radiusClearBtn) {
    radiusClearBtn.addEventListener('click', function () {
      var clearBtn = document.getElementById('ql-clear-location');
      if (clearBtn) clearBtn.click();
    });
  }

  // The filter controls live in the side panel normally; in the
  // fullscreen map they ride inside the search panel instead, moved
  // (not copied) so state and listeners stay intact.
  // The drawer and the chip row each have one home in the DOM and are
  // MOVED rather than copied, so the switches keep their state and
  // their listeners and there is only ever one of each on the page.
  ql.travelled = null;

  function travel(on) {
    // the radius goes into the chips' host after them, so it is under the
    // chips and counted in the collapsed panel's height with them
    var pairs = [
      ['ql-filters', 'ql-search-filters'],
      ['ql-chips', 'ql-chips-full'],
      ['ql-radius-group', 'ql-chips-full']
    ];
    if (on) {
      if (ql.travelled) return;
      // Every home is read before anything moves. Reading them as they
      // go loses the order when two of them share a parent: taking the
      // filters out first left the chips as the last child, so both
      // came back with nothing to sit before and both were appended —
      // in the side panel that put the chips under the switches.
      ql.travelled = pairs.map(function (pair) {
        var el = document.getElementById(pair[0]);
        var slot = document.getElementById(pair[1]);
        return el && slot ? { el: el, parent: el.parentNode, next: el.nextSibling, slot: slot } : null;
      }).filter(Boolean);
      ql.travelled.forEach(function (h) { h.slot.appendChild(h.el); });
    } else if (ql.travelled) {
      ql.travelled.forEach(function (h) {
        // a sibling that has not been put back yet is no use as a mark
        var before = h.next && h.next.parentNode === h.parent ? h.next : null;
        h.parent.insertBefore(h.el, before);
      });
      ql.travelled = null;
      // They go back wherever they were taken from, so on a wide screen
      // that is the side panel already. The one case this has to catch
      // is the window being resized past the breakpoint while they were
      // away — placeSide stands down while travelled is set.
      if (deskWanted() !== ql.onDesk) placeSide();
    }
    // in the search panel a button is in charge of the drawer, so it
    // arrives closed; back in the side panel it shows again
    syncDrawer();
    // before the measurement: the fold puts the whole row back when the
    // chips are not in the side panel, and the collapsed panel's height
    // is the height of the row it ends up with
    foldChips();
    measureChips();
  }

  // The collapsed search panel shows the box and the chips and nothing
  // else, so its height is the two of them. The row's height follows
  // the text-size ladder, so the drag's cached bar height is dropped and
  // the next read measures it again.
  function measureChips() {
    searchBarH = 0;
  }
  window.addEventListener('resize', measureChips);

  // ---------- The chip row's rubber band ----------
  // A sideways scroller that stops dead at its ends gives nothing back
  // for the pull, so on a row whose first chip is All there is no way
  // to tell "this is the start" from "this is stuck". iOS bounces its
  // own scrollers and nothing else does, so the row does it itself and
  // the same thing happens on every phone.
  //
  // Past either end the content follows the finger at an asymptote —
  // the sheet's own band, the same shape and the same limit — and the
  // release springs it back. The touch is never cancelled while the row
  // still has somewhere to scroll, so the ordinary drag is the
  // browser's own and costs nothing.
  (function () {
    var row = document.getElementById('ql-chips');
    if (!row) return;
    var BAND = 90;     // the furthest it will ever travel
    var startX = 0;
    var pulled = 0;
    var dragging = false;

    function set(px) {
      pulled = px;
      row.style.transform = px ? 'translateX(' + px.toFixed(1) + 'px)' : '';
    }
    function spring() {
      if (!pulled) return;
      row.style.transition = 'transform var(--duration-fast) var(--ease-smooth-out)';
      set(0);
      window.setTimeout(function () { row.style.transition = ''; }, 260);
    }
    row.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) { dragging = false; return; }
      dragging = true;
      startX = e.touches[0].clientX;
      row.style.transition = '';
      set(0);
    }, { passive: true });
    row.addEventListener('touchmove', function (e) {
      if (!dragging || e.touches.length !== 1) return;
      var dx = e.touches[0].clientX - startX;
      var max = row.scrollWidth - row.clientWidth;
      // only past an end, and only in the direction there is no more row
      var over = row.scrollLeft <= 0 && dx > 0 ? dx
        : row.scrollLeft >= max - 1 && dx < 0 ? dx
        : 0;
      if (!over) { if (pulled) set(0); return; }
      // the same asymptote the sheet uses: it approaches BAND and never
      // reaches it, so there is always something left to give
      var d = Math.abs(over);
      var out = (BAND * d) / (d + BAND);
      set(over < 0 ? -out : out);
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    row.addEventListener('touchend', function () { dragging = false; spring(); });
    row.addEventListener('touchcancel', function () { dragging = false; spring(); });
  })();

  // ---------- The chip bar in a narrow desktop window ----------
  // There the chips wrap in the page's column and scroll away with it.
  // Once they are off the top, a one-row copy slides down under the top
  // bar, and it goes back up as they come into view again. A click on
  // the copy presses the chip it copies, so there is still one set of
  // buttons and one state.
  (function () {
    if (!chipsRow) return;
    var narrow = window.matchMedia('(max-width: 930px) and (hover: hover) and (pointer: fine)');
    var root = document.documentElement;
    var nav = document.querySelector('.site-nav');
    var bar = null;
    var queued = 0;

    function wanted() {
      if (!narrow.matches || ql.travelled || root.classList.contains('is-pwa') ||
        root.classList.contains('ql-map-full') || root.classList.contains('ql-desk')) return false;
      var top = nav ? Math.max(0, nav.getBoundingClientRect().bottom) : 0;
      return chipsRow.getBoundingClientRect().bottom <= top;
    }
    function mirror() {
      bar.innerHTML = chipsRow.innerHTML;
      [].forEach.call(bar.querySelectorAll('button'), function (b) {
        b.tabIndex = -1;
        b.removeAttribute('id');
      });
      var on = bar.querySelector('.ql-chip.is-on');
      if (on) bar.scrollLeft = Math.max(0, on.offsetLeft - (bar.clientWidth - on.offsetWidth) / 2);
    }
    // the copy's chips start where the column does
    function place() {
      var r = chipsRow.getBoundingClientRect();
      bar.style.paddingLeft = Math.max(0, r.left) + 'px';
      bar.style.paddingRight = Math.max(0, bar.clientWidth - r.right) + 'px';
    }
    function build() {
      bar = document.createElement('div');
      bar.className = 'ql-chip-bar';
      bar.setAttribute('aria-hidden', 'true');
      bar.addEventListener('click', function (e) {
        var chip = e.target.closest && e.target.closest('button');
        if (!chip) return;
        var twin = chipsRow.children[[].indexOf.call(bar.children, chip)];
        if (twin) twin.click();
      });
      (chipsRow.closest('main') || document.body).appendChild(bar);
      new MutationObserver(function () { if (ql.chipBarIn) mirror(); })
        .observe(chipsRow, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    }
    function show(on) {
      if (on === ql.chipBarIn) return;
      ql.chipBarIn = on;
      if (on) {
        if (!bar) build();
        place();
        mirror();
      }
      bar.classList.toggle('is-in', on);
    }
    function check() {
      queued = 0;
      show(wanted());
    }
    function soon() {
      if (!queued) queued = requestAnimationFrame(check);
    }
    document.addEventListener('scroll', soon, { passive: true, capture: true });
    window.addEventListener('resize', function () {
      if (ql.chipBarIn) place();
      soon();
    });
  })();

  function placeFilters(on) { travel(on); }

  // ---------- The desktop layout ----------
  // On a wide screen the search, the chips and the filters sit in a
  // column down the left that stays put as the page scrolls. They are
  // moved there, not copied: every switch keeps its state and its
  // listeners, and there is only ever one of each on the page.
  //
  // travel() borrows the same three for the fullscreen map's search
  // panel and remembers wherever it took them from, so the two movers
  // cannot disagree — this one stands down while they are away and runs
  // again when they come back.
  var sideCol = document.getElementById('ql-side');
  var sideHomes = null;
  ql.onDesk = false;

  function deskWanted() {
    return window.matchMedia('(min-width: 931px)').matches &&
      !document.documentElement.classList.contains('is-pwa');
  }

  function placeSide() {
    if (ql.travelled) return;
    var want = !!sideCol && deskWanted();
    if (want === ql.onDesk) return;
    ql.onDesk = want;
    document.documentElement.classList.toggle('ql-desk', want);
    if (want) {
      // the drawer is about to become a panel, so whatever the button
      // left open is closed properly first — the back layer with it
      if (document.documentElement.classList.contains('ql-filters-open')) setFiltersOpen(false);
      sideHomes = [];
      ['ql-pill', 'ql-chips', 'ql-filters'].forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        sideHomes.push({ el: el, parent: el.parentNode, next: el.nextSibling });
        sideCol.appendChild(el);
      });
    } else if (sideHomes) {
      sideHomes.forEach(function (h) { h.parent.insertBefore(h.el, h.next); });
      sideHomes = null;
    }
    syncDrawer();
    foldChips();
    measureChips();
    placePill();
    // the map column changed width
    resizeMap();
  }

  window.addEventListener('resize', placeSide);
  placeSide();

  // ---------- Folding the chip row ----------
  // Sideways the row is as long as it needs to be, but wrapped down a
  // 330px column eleven regions are five rows of chips sitting above
  // the search. Two rows stay and the rest open on a button at the end
  // of the row, which is why this belongs to the desktop layout and
  // stands down everywhere else.
  var chipsMore = null;
  var chipsOpen = false;
  var CHIP_ROWS = 2;

  function foldChips() {
    if (!chipsRow) return;
    if (!chipsMore) {
      chipsMore = document.createElement('button');
      chipsMore.type = 'button';
      chipsMore.className = 'ql-chip ql-chip-more';
      chipsMore.addEventListener('click', function () {
        chipsOpen = !chipsOpen;
        foldChips();
      });
    }
    if (chipsMore.parentNode !== chipsRow) chipsRow.appendChild(chipsMore);
    var kids = [].filter.call(chipsRow.children, function (el) { return el !== chipsMore; });
    kids.forEach(function (el) { el.hidden = false; });
    chipsMore.hidden = true;
    // the page's side column, or the full-screen sidebar on a desktop;
    // the phone's panel keeps one row that scrolls sideways
    if (!((ql.onDesk && !ql.travelled) || sideMode())) return;

    function sayMore() {
      var n = kids.filter(function (el) { return el.hidden; }).length;
      chipsMore.textContent = n + ' more';
    }

    // Measured with the whole row showing: a chip's row is its
    // offsetTop, and the first two of those stay.
    var rows = [];
    var tops = kids.map(function (el) {
      var t = el.offsetTop;
      if (rows.indexOf(t) < 0) rows.push(t);
      return t;
    });
    if (rows.length <= CHIP_ROWS) return;
    chipsMore.hidden = false;
    chipsMore.setAttribute('aria-expanded', chipsOpen ? 'true' : 'false');
    if (chipsOpen) {
      chipsMore.textContent = 'Show fewer';
      return;
    }
    // The category that is on is never the one that disappears: a row
    // that folds away the answer reads as nothing being picked. A
    // hidden chip takes up no space, so the one that is kept moves up
    // and sits after the last one still showing.
    var cut = rows[CHIP_ROWS];
    var spare = [];
    kids.forEach(function (el, idx) {
      if (el.classList.contains('is-on')) return;
      if (tops[idx] >= cut) el.hidden = true;
      else spare.push(el);
    });
    sayMore();
    // The button takes a chip's place in the row it joins, so if that
    // has pushed it onto a third row the last chip before it goes too.
    while (spare.length && chipsMore.offsetTop >= cut) {
      spare.pop().hidden = true;
      sayMore();
    }
  }

  window.addEventListener('resize', foldChips);

  // ---------- The desktop full-screen sidebar ----------
  // On a desktop the full-screen map's search panel is a column down the
  // left with the quest list in it (the stylesheet does the layout). It
  // can be put away to give the map the whole width — the strip along
  // its edge, the button at the map's top left, or [ — and the device
  // keeps which.
  var SIDE_KEY = 'scs2-questlist-side';
  var sideEdge = document.getElementById('ql-side-edge');
  var sideShow = document.getElementById('ql-side-show');
  var sideAway = false;
  try { sideAway = localStorage.getItem(SIDE_KEY) === '0'; } catch (err) { /* open */ }
  document.documentElement.classList.toggle('ql-side-away', sideAway);
  var sideTimer = null;

  function sideMode() {
    return document.documentElement.classList.contains('ql-map-full') && !sheetMq.matches;
  }

  // Off the screen, the column is inert: nothing in it takes focus or is
  // read out. Everywhere else it is the phone's panel and always live.
  function syncSide() {
    if (searchWrap) searchWrap.inert = sideMode() && sideAway;
  }

  // `ifChanged`: only when the box is not the size the canvas was drawn
  // at, since a resize clears and redraws the whole canvas
  function resizeMap(ifChanged) {
    if (!state.map) return;
    if (ifChanged === true) {
      var box = state.map.getContainer();
      var canvas = state.map.getCanvas();
      if (box.clientWidth === canvas.clientWidth && box.clientHeight === canvas.clientHeight) return;
    }
    state.map.resize();
  }

  function setSideAway(away) {
    if (away === sideAway) return;
    sideAway = away;
    try { localStorage.setItem(SIDE_KEY, away ? '0' : '1'); } catch (err) { /* not kept */ }
    var root = document.documentElement;
    var dur = window.scs.reducedMotion ? 0 : window.scs.ms('--duration-fast', 250);
    window.clearTimeout(sideTimer);
    if (away) {
      // the map takes the width at once and the column leaves over it
      root.classList.remove('ql-side-opening');
      root.classList.add('ql-side-away');
      resizeMap();
      if (sideShow && sideMode()) sideShow.focus({ preventScroll: true });
    } else {
      // the column comes back over the whole map, and the map gives the
      // room back once it has landed
      root.classList.add('ql-side-opening');
      root.classList.remove('ql-side-away');
      sideTimer = window.setTimeout(function () {
        root.classList.remove('ql-side-opening');
        resizeMap();
      }, dur);
      if (searchInput && sideMode()) searchInput.focus({ preventScroll: true });
    }
    syncSide();
  }

  if (sideEdge) {
    sideEdge.addEventListener('click', function () { setSideAway(true); });
    // the tab rides beside the pointer
    sideEdge.addEventListener('mousemove', function (e) {
      var r = sideEdge.getBoundingClientRect();
      sideEdge.style.setProperty('--edge-y', Math.round(e.clientY - r.top) + 'px');
    });
  }
  if (sideShow) sideShow.addEventListener('click', function () { setSideAway(false); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== '[' || e.ctrlKey || e.metaKey || e.altKey || !sideMode()) return;
    var t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    e.preventDefault();
    setSideAway(!sideAway);
  });
  window.addEventListener('resize', syncSide);

  // One layer an Escape, the way the back gesture goes: the open quest
  // sheet first (its own listener), then the filters drawer, then the
  // search panel, then full screen itself. Capture phase, so this sees
  // the sheet still open before the sheet's listener closes it.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (!document.documentElement.classList.contains('ql-map-full')) return;
    if (!overlay.classList.contains('is-hidden')) return;
    // a layer of somebody else's on top (the settings menu, the viewer)
    // takes this Escape itself
    var stack = window.scsBackLayer;
    if (stack.isOpen() && !ql.mapLayerOnTop() && !stack.isTop(searchLayer)) return;
    e.preventDefault();
    if (document.documentElement.classList.contains('ql-filters-open')) {
      setFiltersOpen(false);
      return;
    }
    if (ql.searchState !== 'bar') {
      collapseMapSearch();
      return;
    }
    leaveMapFull();
  }, true);

  // ---------- Fullscreen-map search (phones) ----------
  // A bottom bar like Apple or Google Maps: tap to type and it rises to
  // half height with matching quests; drag it between bar, half and
  // full; tap a result and its sheet opens on top, ready to be swiped
  // away back to the results. Leaving the fullscreen map puts it away.
  var searchWrap = document.getElementById('ql-map-search');
  ql.searchWrap = searchWrap;
  var searchInput = document.getElementById('ql-search-input');
  var searchResultsEl = document.getElementById('ql-search-results');
  var searchBody = document.getElementById('ql-search-body');
  ql.searchBody = searchBody;
  var searchClear = document.getElementById('ql-search-clear');
  var searchGrab = searchWrap ? searchWrap.querySelector('.ql-search-grab') : null;
  ql.searchState = 'bar'; // bar | half | full
  var searchLayer = null;
  var searchBarH = 0;
  // where the search panel returns to after a result's sheet is closed
  ql.searchReturnState = null;

  // The grab bar's chevron says which way the panel is heading, so it
  // reads as live interaction whether the finger is on the search
  // panel itself or on the quest sheet driving it from above.
  function setSearchChevron(dir) {
    if (!searchGrab) return;
    searchGrab.classList.toggle('is-up', dir === 'up');
    searchGrab.classList.toggle('is-vee', dir === 'vee');
  }

  function resetSearchChevron() {
    if (!searchGrab) return;
    searchGrab.classList.remove('is-up');
    searchGrab.classList.remove('is-vee');
    searchGrab.classList.remove('is-stretching');
    searchGrab.style.setProperty('--stretch', '1');
  }

  // While the map is dragged or pinched in full screen on a phone, the
  // panel goes see-through, the way the app's bottom bar does on a
  // scroll, and stays that way until a finger lands on the panel or any
  // other control, or on a pin. It does not move: sliding it down and
  // up again with every pinch moved the thing people were about to
  // reach for.
  function canFade() {
    return !!searchWrap && document.documentElement.classList.contains('ql-map-full') && sheetMq.matches &&
      !sideMode() && ql.searchState !== 'full' && overlay.classList.contains('is-hidden');
  }
  function onMapMoveStart(e) {
    if (!e.originalEvent) return;
    if (sheetStop() === 'card' && document.documentElement.classList.contains('ql-map-full')) {
      overlay.querySelector('.ql-detail').classList.add('is-faded');
    }
    if (canFade()) searchWrap.classList.add('is-faded');
  }
  function unfadeMapUi() {
    if (searchWrap) searchWrap.classList.remove('is-faded');
    overlay.querySelector('.ql-detail').classList.remove('is-faded');
  }
  overlay.querySelector('.ql-detail').addEventListener('pointerdown', unfadeMapUi);
  // a finger on anything over the map that is not the map itself
  if (mapCardEl) {
    mapCardEl.addEventListener('pointerdown', function (e) {
      if (e.target.closest && !e.target.closest('.maplibregl-canvas-container')) unfadeMapUi();
    }, true);
  }

  // Bowed under a sheet the panel reads as a bar while its back layer
  // is still armed, so the layer is what says it is up.
  function collapseMapSearch() {
    ql.searchReturnState = null;
    if (ql.searchState !== 'bar' || searchLayer) setSearchState('bar');
  }

  // The phone's panel rises from its bar to half. The desktop's sidebar
  // is always open, and a sheet open over the panel keeps it down.
  function raiseMapSearch() {
    if (!searchWrap || !document.documentElement.classList.contains('ql-map-full') || sideMode()) return;
    if (ql.searchState !== 'bar' || !overlay.classList.contains('is-hidden')) return;
    setSearchState('half');
  }

  // Bowing out for a sheet keeps the search's back entry armed — the
  // sheet stacks its own on top, and the restore reuses this one.
  // Re-arming during the sheet's own popstate would get popped straight
  // back off (a race that collapsed the restore).
  function bowSearchForSheet() {
    ql.searchState = 'bar';
    searchWrap.classList.remove('is-half');
    searchWrap.classList.remove('is-full');
  }

  // Opening a quest from the map (a pin) or the results list: the
  // search panel bows out downwards while the sheet rises, and closing
  // the sheet brings it back to exactly this state. Without it the two
  // panels stack on top of each other.
  function openQuestPanel(quest, panMap, opts) {
    opts = opts || {};
    if (!opts.stop && ql.searchState === 'full') opts.stop = 'full';
    ql.searchReturnState = (searchWrap && ql.searchState !== 'bar') ? ql.searchState : null;
    openDetail(quest, panMap, null, opts);
    if (ql.searchReturnState) bowSearchForSheet();
  }

  function restoreSearchAfterSheet() {
    if (!ql.searchReturnState || !searchWrap) return;
    var target = ql.searchReturnState;
    ql.searchReturnState = null;
    resetSearchChevron();
    searchWrap.classList.remove('is-dragging');
    ql.searchState = target;
    searchWrap.classList.toggle('is-half', target === 'half');
    searchWrap.classList.toggle('is-full', target === 'full');
    void searchWrap.offsetWidth;
    searchWrap.style.height = ''; // the height transition carries it up
  }

  function setSearchState(next) {
    if (!searchWrap) return;
    unfadeMapUi();
    ql.searchState = next;
    searchWrap.classList.toggle('is-half', next === 'half');
    searchWrap.classList.toggle('is-full', next === 'full');
    if (next === 'bar') {
      if (searchInput) searchInput.blur();
      if (searchLayer) {
        var layer = searchLayer;
        searchLayer = null;
        if (window.scsBackLayer) window.scsBackLayer.disarm(layer);
      }
    } else if (!searchLayer && window.scsBackLayer) {
      searchLayer = window.scsBackLayer.arm(function () {
        searchLayer = null;
        collapseMapSearch();
      });
    }
    positionMapControls();
  }

  // The panel's filters (category, ticked-off, location) apply here as
  // they do to the list and the markers; the box in this panel is the
  // search, in place of the panel's own (hidden while the map is full).
  function searchMatches(query) {
    // the panel's filters first, then the shared loose matcher, best
    // matches first while something is typed
    return scs.questSearch(QUESTS.filter(function (quest) { return matchesFilters(quest, true); }), query,
      function (quest) { return quest.category + ' ' + locationText(quest) + ' ' + quest.description; });
  }

  function renderSearchResults() {
    if (!searchResultsEl || !searchInput) return;
    // this box takes the same /submit command the floating one does
    var typed = searchInput.value || '';
    var query = readSearchBox(typed).query;
    if (searchClear) searchClear.classList.toggle('is-hidden', typed === '');
    var matches = searchMatches(query);
    searchResultsEl.innerHTML = '';

    var count = document.createElement('p');
    count.className = 'ql-sr-count';
    count.textContent = query
      ? matches.length + ' quest' + (matches.length === 1 ? '' : 's') + ' match'
      : matches.length === QUESTS.length ? 'All ' + matches.length + ' quests'
      : matches.length + ' of ' + QUESTS.length + ' quests';
    searchResultsEl.appendChild(count);

    // A result is the list's own row, as the list draws it on a phone:
    // the code chip and what the quest pays on one line at opposite
    // edges, then the name, where it is and how far away it is. The
    // same chip, the same name span with the LIVE tag before it and
    // the strike drawn across it once the quest is ticked — the list
    // behind the map and this list must not be two ways to draw a
    // quest. The cells are placed by the stylesheet, so the order here
    // is the reading order.
    matches.forEach(function (quest) {
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'ql-sr-item' + (isComplete(quest) ? ' is-done' : '');

      var codeChip = document.createElement('span');
      codeChip.className = 'code ql-code';
      codeChip.textContent = quest.id;
      item.appendChild(codeChip);

      var name = document.createElement('span');
      name.className = 'ql-sr-name';
      if (isLive(quest)) {
        var liveTag = document.createElement('span');
        liveTag.className = 'ql-live';
        liveTag.textContent = 'Live';
        name.appendChild(liveTag);
      }
      // its own class name, sharing the list's strike rules: a suite
      // reads .ql-item-label as the list's names across the whole page
      var nameText = document.createElement('span');
      nameText.className = 'ql-sr-label';
      nameText.textContent = quest.name;
      name.appendChild(nameText);
      item.appendChild(name);

      var meta = document.createElement('span');
      meta.className = 'ql-sr-meta';
      meta.textContent = locationText(quest);
      item.appendChild(meta);

      var d = questDistanceKm(quest);
      if (d !== null) {
        var dist = document.createElement('span');
        dist.className = 'ql-sr-distance';
        dist.textContent = '~' + (d < 10 ? d.toFixed(1) : Math.round(d)) + ' km away';
        item.appendChild(dist);
      }

      var pts = document.createElement('span');
      pts.className = 'ql-sr-pts';
      pts.textContent = pointsSummary(quest.points);
      item.appendChild(pts);

      item.addEventListener('click', function () {
        if (state.submitMode) { window.location.href = submitHref(quest); return; }
        openQuestPanel(quest, true);
      });
      searchResultsEl.appendChild(item);
    });
  }

  if (searchWrap && searchInput && searchResultsEl) {
    searchInput.addEventListener('focus', raiseMapSearch);
    // one search with the floating box: the text, the mode and the filter
    searchInput.addEventListener('input', function () {
      ql.applySearchText(searchInput.value, searchInput);
    });
    searchInput.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      var first = searchResultsEl.querySelector('.ql-sr-item');
      if (first) first.click();
    });
    if (searchClear) {
      searchClear.addEventListener('click', function () {
        ql.applySearchText('', null);
        searchInput.focus();
      });
    }
    renderSearchResults();

    // drag between bar, half and full — same feel as the quest sheet
    var srStartY = null;
    var srMode = null;    // null | 'drag' | 'scroll'
    var srStartH = 0;
    var srFromResults = false;
    var srVel = 0;
    var srLastY = 0;
    var srLastT = 0;

    var srHeights = function () {
      if (!searchBarH && ql.searchState === 'bar' && searchWrap.offsetHeight > 0) {
        searchBarH = searchWrap.offsetHeight;
      }
      return {
        bar: searchBarH || 74,
        half: Math.round(window.innerHeight * 0.52),
        // the panel sits in from the edge on a desktop, flush on a phone
        full: window.innerHeight - (sheetMq.matches ? 14 : 24)
      };
    };
    ql.srHeights = srHeights;

    // the drag itself: the same maths whether a finger or a pointer is
    // doing the pulling
    var applySearchDrag = function (dy) {
      var sizes = srHeights();
      var raw = srStartH - dy;
      var h = raw;
      // soft band past either end, same rubber as the sheet
      if (raw > sizes.full) h = sizes.full + rubberBand(raw - sizes.full, 40);
      else if (raw < sizes.bar) h = sizes.bar - rubberBand(sizes.bar - raw, 30);
      searchWrap.style.height = h + 'px';
      positionMapControls(); // the buttons ride the panel's edge live
      // the grab bar reads the direction, exactly like the quest sheet
      if (!searchGrab) return;
      // At either limit the fold gives way to a stretch: the bar
      // lies flat and elongates with the depth of the pull, the same
      // as a maximised panel being pulled further open.
      var overTop = raw > sizes.full ? h - sizes.full : 0;
      var underBottom = raw < sizes.bar ? sizes.bar - h : 0;
      var band = overTop || underBottom;
      if (raw >= sizes.full - 1 || raw <= sizes.bar + 1) setSearchChevron(null);
      else if (Math.abs(srVel) > 0.05) setSearchChevron(srVel > 0 ? 'vee' : 'up');
      if (band > 0) {
        searchGrab.classList.add('is-stretching');
        searchGrab.style.setProperty('--stretch',
          String(1 + (band / (overTop ? 40 : 30)) * 0.35));
      } else if (searchGrab.classList.contains('is-stretching')) {
        searchGrab.classList.remove('is-stretching');
        searchGrab.style.setProperty('--stretch', '1');
      }
    };

    searchWrap.addEventListener('touchstart', function (e) {
      unfadeMapUi();
      // the desktop's sidebar does not drag: its list scrolls
      if (e.touches.length !== 1 || sideMode()) return;
      srHeights(); // remember the bar height while we're at it
      srStartY = e.touches[0].clientY;
      srLastY = srStartY;
      srLastT = Date.now();
      srVel = 0;
      srStartH = searchWrap.getBoundingClientRect().height;
      srFromResults = !!(e.target.closest && e.target.closest('.ql-search-body'));
      var onGrab = e.target.closest && e.target.closest('.ql-search-grab');
      srMode = onGrab ? 'drag' : null;
      if (srMode === 'drag') searchWrap.classList.add('is-dragging');
    }, { passive: true });

    searchWrap.addEventListener('touchmove', function (e) {
      if (srStartY === null || e.touches.length !== 1) return;
      var now = Date.now();
      var cy = e.touches[0].clientY;
      srVel = (cy - srLastY) / Math.max(now - srLastT, 1);
      srLastY = cy;
      srLastT = now;
      var dy = cy - srStartY;

      if (srMode === null) {
        if (Math.abs(dy) < 8) return; // still a tap
        if (srFromResults) {
          // content scrolls only at full height; everywhere else the
          // panel itself moves, and at the top of the list a downward
          // pull hands the panel over — sheet rules
          var canScroll = ql.searchState === 'full' &&
            searchBody.scrollHeight > searchBody.clientHeight;
          if (dy > 0) srMode = searchBody.scrollTop <= 0 ? 'drag' : 'scroll';
          else srMode = canScroll ? 'scroll' : 'drag';
        } else {
          srMode = 'drag';
        }
        if (srMode === 'drag') {
          srStartY = cy;
          dy = 0;
          srStartH = searchWrap.getBoundingClientRect().height;
          searchWrap.classList.add('is-dragging');
        }
      } else if (srMode === 'scroll' && dy > 0 && searchBody.scrollTop <= 0) {
        srMode = 'drag';
        srStartY = cy;
        dy = 0;
        srStartH = searchWrap.getBoundingClientRect().height;
        searchWrap.classList.add('is-dragging');
      }

      if (srMode !== 'drag') return;
      if (e.cancelable) e.preventDefault();
      applySearchDrag(dy);
    }, { passive: false });

    var endSearchDrag = function () {
      var wasDrag = srMode === 'drag';
      srStartY = null;
      srMode = null;
      resetSearchChevron(); // the bar lies flat and eases back to size
      if (!wasDrag) { positionMapControls(); return; }
      var sizes = srHeights();
      var current = searchWrap.getBoundingClientRect().height;
      var projected = current - Math.max(-3, Math.min(3, srVel)) * 160;
      var target = 'bar';
      if (projected > (sizes.half + sizes.full) / 2) target = 'full';
      else if (projected > (sizes.bar + sizes.half) / 2) target = 'half';
      // let the height transition carry it from wherever the finger left it
      searchWrap.classList.remove('is-dragging');
      setSearchState(target);
      void searchWrap.offsetHeight;
      searchWrap.style.height = '';
      positionMapControls();
    };
    searchWrap.addEventListener('touchend', endSearchDrag);
    searchWrap.addEventListener('touchcancel', endSearchDrag);

    // With a mouse the grab bar drags as well as clicks: hold it and
    // the panel follows the pointer with the same rubber and snap the
    // finger gets, and a plain click still steps bar -> half -> full
    // -> half. A drag swallows the click it would otherwise finish
    // with (touch drags already suppress theirs).
    if (searchGrab) {
      var srPointer = false;
      var srPointerMoved = false;

      searchGrab.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        unfadeMapUi();
        e.preventDefault(); // no text selection while dragging
        srHeights();
        srStartY = e.clientY;
        srLastY = e.clientY;
        srLastT = Date.now();
        srVel = 0;
        srStartH = searchWrap.getBoundingClientRect().height;
        srMode = 'drag';
        srPointer = true;
        srPointerMoved = false;
        searchWrap.classList.add('is-dragging');
      });

      document.addEventListener('mousemove', function (e) {
        if (!srPointer) return;
        var now = Date.now();
        srVel = (e.clientY - srLastY) / Math.max(now - srLastT, 1);
        srLastY = e.clientY;
        srLastT = now;
        var dy = e.clientY - srStartY;
        if (Math.abs(dy) > 3) srPointerMoved = true;
        applySearchDrag(dy);
      });

      document.addEventListener('mouseup', function () {
        if (!srPointer) return;
        srPointer = false;
        endSearchDrag();
        if (srPointerMoved) window.setTimeout(function () { srPointerMoved = false; }, 0);
      });

      searchGrab.addEventListener('click', function () {
        if (srPointerMoved) { srPointerMoved = false; return; } // that was a drag
        if (ql.searchState === 'bar') setSearchState('half');
        else if (ql.searchState === 'half') setSearchState('full');
        else setSearchState('half');
      });
    }
  }

  function rubberBand(excess, limit) {
    return (1 - 1 / (excess * 0.55 / limit + 1)) * limit;
  }

  // The map: MapLibre, the base style and a tile server that answers,
  // all asked for at once. A device that cannot draw WebGL, or a script
  // that does not load, gets a line of text in the map's place.
  // It starts once the list has drawn and the page is idle (startMapSoon,
  // from Init), since MapLibre's script is a second of work on a phone
  // and the list is what the page opens for; at once when the map is
  // the page, a link names a quest, or the reader asks for the map. On a
  // phone that has drawn it before, with its tiles kept, it starts as
  // soon as the list has painted, and the picture of the map as it last
  // stood holds its place meanwhile (showMapShot).
  renderMarkers();
  paintMapGround();
  var mapStarted = false;
  function startMap() {
  if (mapStarted) return;
  mapStarted = true;
  fetchTransit();
  Promise.all([
    loadMapLibre(),
    loadBaseStyle().then(function (s) { ql.baseStyle = s; }, function () { ql.baseStyle = null; }),
    discoverTileUrl().then(function (u) { state.tileUrl = u; }, function () { state.tileUrl = null; })
  ]).then(function (res) {
    var ml = res[0];
    window.scs.gotIt('quest-map');
    // a try after a failed one starts on an empty container
    document.getElementById('ql-map').textContent = '';
    // where the map was left in this tab, or the opening view
    var kept = ql.keptView();
    state.viewKept = !!kept;
    state.map = new ml.Map({
      container: 'ql-map',
      style: buildStyle(),
      pixelRatio: window.scs.mapPixelRatio(),
      center: kept ? [kept.lng, kept.lat] : MAP_CENTER,
      zoom: kept ? kept.zoom : 9,
      minZoom: 7,
      maxZoom: 18,
      maxBounds: MAP_BOUNDS,
      // the wheel and the trackpad are the page's own (see "Zooming with
      // a wheel or a trackpad")
      scrollZoom: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      attributionControl: false,
      fadeDuration: 150,
      // the glyphs kept here are Latin; a name in any other script is
      // fetched from the Protomaps assets site
      transformRequest: function (url, type) {
        if (type === 'Glyphs') {
          var g = /\/assets\/maplibre\/fonts\/([^/]+)\/(\d+-\d+)\.pbf$/.exec(url);
          if (g && LOCAL_GLYPH_RANGES.indexOf(g[2]) < 0) return { url: REMOTE_GLYPHS + '/' + g[1] + '/' + g[2] + '.pbf' };
        }
        return { url: url };
      }
    });
    state.map.touchZoomRotate.disableRotation();
    state.map.keyboard.disableRotation();
    state.map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-left');
    state.map.addControl(new ml.AttributionControl({ compact: false }), 'bottom-right');
    installTapZoom(state.map);
    ql.watchMapShot(state.map);
    ql.keepView(state.map);
    ql.watchCounts(state.map);
    state.map.on('style.load', function () {
      state.mapStyled = true;
      // data that changed while the style was loading
      Object.keys(mapData).forEach(function (k) { setMapData(k, mapData[k]); });
      syncTransit();
    });
    // a tile or a glyph that fails leaves a gap and nothing else
    state.map.on('error', function (e) {
      var msg = String((e && e.error && e.error.message) || '');
      if (/tile|pbf|mvt|png|Failed to fetch|NetworkError|404|AJAXError/i.test(msg)) return;
      if (window.console) console.warn('map', (e && e.error) || e);
    });
    state.map.on('mousedown', wheelStop);
    state.map.on('touchstart', wheelStop);
    state.map.on('click', onMapClick);
    state.map.on('movestart', onMapMoveStart);
    state.map.on('mousemove', function (e) { hoverAt(e.point); });
    state.map.on('mouseout', function () {
      hideHoverTip();
      state.map.getCanvas().style.cursor = '';
    });
    var canvas = state.map.getCanvas();
    canvas.setAttribute('aria-label', 'Map of the quests. Arrow keys pan, plus and minus zoom.');
    drawPins();
    ql.mapArrived();
    // buildStyle falls back to OpenStreetMap when either the tiles or the
    // base style could not be had
    if (window.scsToast) {
      if (!state.tileUrl) window.scsToast('Quest tile server unreachable, using OpenStreetMap.');
      else if (!ql.baseStyle) window.scsToast('Quest map unavailable, using OpenStreetMap.');
    }
  }).catch(function (err) {
    // a map that was made stays; one that never was can be asked for again
    if (state.map) {
      if (window.console) console.warn('map', err);
      return;
    }
    mapStarted = false;
    ql.dropMapShot(false);
    document.getElementById('ql-map').innerHTML =
      '<p style="padding:16px;color:#6f7378;">Map could not be loaded (offline?). The quest list below still works.</p>';
    if (!/WebGL/.test(String((err && err.message) || ''))) window.scs.again('quest-map', startMap);
  });
  }
  function startMapSoon() {
    if (mapStarted) return;
    if (ql.mapDrawnBefore()) {
      // a frame for the list to paint, then the map
      window.requestAnimationFrame(function () { window.setTimeout(startMap, 0); });
      return;
    }
    if (window.requestIdleCallback) window.requestIdleCallback(startMap, { timeout: 1500 });
    else window.setTimeout(startMap, 300);
  }
  ql.startMap = startMap;
  ql.startMapSoon = startMapSoon;
  ql.showMapShot();
  if (document.documentElement.classList.contains('ql-map-home') || location.hash.length > 1) startMap();

  // the Sharper Map setting, applied to a map already drawn
  document.addEventListener('scs-map-sharp-changed', function () {
    if (state.map && state.map.setPixelRatio) state.map.setPixelRatio(window.scs.mapPixelRatio());
    ql.redrawCounts();
  });
  // the Group Map Pins setting, applied to a map already drawn
  document.addEventListener('scs-map-groups-changed', function () { ql.syncPinGroups(); });
});

// every part is in: run them in order, as one script
window.scsQuestList.parts.forEach(function (part) { part(window.scsQuestList); });
