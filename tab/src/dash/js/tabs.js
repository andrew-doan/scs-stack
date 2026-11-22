// Signed in or not, the tabs this account has, the tab bar and its pill,
// which tab is open (kept across a reload and in the address), the menus,
// and the overview every tab reads.
(function (dash) {
  // core.js
  var api = dash.api, can = dash.can, canTab = dash.canTab, el = dash.el, KEY = dash.KEY, session = dash.session,
    state = dash.state, toast = dash.toast, whoAmI = dash.whoAmI;

  dash.show = show;
  dash.loadMe = loadMe;
  dash.activeTab = activeTab;
  dash.rememberTab = rememberTab;
  dash.openTab = openTab;
  dash.restoreTab = restoreTab;
  dash.refresh = refresh;
  dash.refreshTeamsOnly = refreshTeamsOnly;

  // Signed out (a 401 from any request), the page stays as it is behind
  // the sign-in form, and nothing more is sent until someone signs in:
  // api() sends nothing without a session, and the polls and queues stop
  // at their next turn. Signing in again opens the tab that was open.
  function show(signedIn) {
    // the spinner sends a visitor here to sign in, and gets them back
    if (signedIn && /[?&]then=spinner(&|$)/.test(location.search)) { location.replace('/dash/spinner'); return; }
    var asking = !el('login').classList.contains('hidden');
    el('login').classList.toggle('hidden', signedIn);
    el('backup').classList.add('hidden');
    el('main').classList.toggle('hidden', !signedIn);
    el('who-line').classList.toggle('hidden', !signedIn);
    el('menu-btn').classList.toggle('hidden', !signedIn);
    if (signedIn) {
      loadMe().then(function () {
        // back from a sign-out, the tab already open loads again
        if (!restoreTab() && state.ready) reloadTab();
        refresh();
        placePill(false);
      });
    } else if (!asking) el('login-pass').focus();
  }
  // What this account may use. A failed answer (an error, or no answer
  // at all) is never read as admin: the page keeps what it last knew of
  // this account on this device, or shows no tabs, and asks again until
  // the worker answers. A worker from before accounts answers with no
  // list of tabs, and everybody signed in to it could use everything.
  var ACCESS_KEY = KEY + '-access';
  var NO_ACCESS = { admin: false, perms: [], quests: [] };
  var meTimer = null;
  function loadMe() {
    clearTimeout(meTimer);
    var tries = 0;
    var known = false;
    return new Promise(function (resolve) {
      function ask() {
        api('/api/console/me').then(function (d) {
          if (!d || !d.ok) throw new Error('no access');
          var access = Array.isArray(d.perms)
            ? { admin: !!d.admin, perms: d.perms, quests: Array.isArray(d.quests) ? d.quests : [] }
            : { admin: true, perms: [], quests: [] };
          // the name as the worker keeps it, whatever capitals were typed
          if (d.name) {
            try { localStorage.setItem(KEY + '-name', d.name); } catch (e) {}
            el('who').textContent = el('who-menu').textContent = d.name;
          }
          try { localStorage.setItem(ACCESS_KEY, JSON.stringify({ name: whoAmI(), access: access })); } catch (e) {}
          var changed = JSON.stringify(access) !== JSON.stringify(dash.access);
          dash.access = access;
          applyAccess();
          if (!known) { known = true; resolve(); }
          else if (changed) accessChanged();
        }).catch(function () {
          if (!session()) return;
          if (!known) {
            var kept = keptAccess();
            dash.access = kept || NO_ACCESS;
            applyAccess();
            if (kept) { known = true; resolve(); }
            else if (!tries) toast('Could not read which tabs this account has. Trying again.', true);
          }
          meTimer = setTimeout(ask, Math.min(30, 5 * Math.pow(2, tries++)) * 1000);
        });
      }
      ask();
    });
  }
  function keptAccess() {
    try {
      var kept = JSON.parse(localStorage.getItem(ACCESS_KEY) || 'null');
      if (kept && kept.name === whoAmI() && kept.access && Array.isArray(kept.access.perms)) return kept.access;
    } catch (e) { /* nothing kept */ }
    return null;
  }
  // the worker's answer came after the page went on with what it kept
  function accessChanged() {
    var tab = activeTab();
    if (!tab.classList.contains('is-active') || el('view-' + tab.dataset.tab).classList.contains('hidden')) restoreTab(true);
    placePill(false);
  }
  function reloadTab() {
    var name = activeTab().dataset.tab;
    if (TAB_LOAD[name]) TAB_LOAD[name]();
  }
  function applyAccess() {
    tabButtons.forEach(function (b) { b.classList.toggle('hidden', !canTab(b.dataset.tab)); });
    tabBar.classList.toggle('is-few', shownTabs().length <= 4);
    VIEWS.forEach(function (t) { if (!canTab(t)) el('view-' + t).classList.add('hidden'); });
    el('msg-push-row').classList.toggle('hidden', !can('push'));
    if (!can('push')) el('msg-push').checked = false;
  }
  // phones: the tabs fold into a menu behind the Menu button
  function setMenu(open) {
    tabBar.classList.toggle('is-open', open);
    el('menu-btn').setAttribute('aria-expanded', open ? 'true' : 'false');
    el('menu-btn').textContent = open ? 'Close' : 'Menu';
  }
  el('menu-btn').addEventListener('click', function () { setMenu(!tabBar.classList.contains('is-open')); });

  // ---- tabs with a sliding pill ----
  var tabBar = document.querySelector('.tabs');
  var pill = tabBar.querySelector('.tabs-pill');
  var tabButtons = Array.prototype.slice.call(tabBar.querySelectorAll('button[data-tab]'));
  var VIEWS = ['tab', 'ranks', 'review', 'desk', 'ledger', 'map', 'routes', 'quests', 'teams', 'messages', 'push', 'email', 'rego', 'files', 'discord', 'settings', 'accounts', 'log'];
  // a tab this account cannot use is not drawn, and is not a tab here
  function shownTabs() {
    return tabButtons.filter(function (b) { return !b.classList.contains('hidden'); });
  }
  function activeTab() {
    var shown = shownTabs();
    return shown.filter(function (b) { return b.classList.contains('is-active'); })[0] || shown[0] || tabButtons[0];
  }
  function placePill(animate) {
    var tab = activeTab();
    if (getComputedStyle(pill).display === 'none') return; // the phone menu has no pill
    if (!animate) pill.style.transition = 'none';
    // the tabs wrap on a narrow screen, so the pill moves down as well as along
    pill.style.transform = 'translate(' + tab.offsetLeft + 'px, ' + tab.offsetTop + 'px)';
    pill.style.width = tab.offsetWidth + 'px';
    pill.style.height = tab.offsetHeight + 'px';
    if (!animate) { void pill.offsetWidth; pill.style.transition = ''; }
  }
  // What each tab fetches when it is opened.
  var TAB_LOAD = {
    tab: function () { dash.loadBoard(); dash.loadSchedule(); dash.loadLedgerCheck(); },
    ranks: function () { dash.loadRanks().catch(function () {}); },
    desk: function () { dash.loadDesk(); },
    log: function () { dash.loadLog(true); },
    review: function () { dash.loadReview(); dash.loadEncoder(); },
    ledger: function () { dash.loadLedger(); },
    map: function () { dash.loadMap(); },
    routes: function () { dash.loadRoutes(); },
    messages: function () { dash.loadMessages(); },
    files: function () { dash.loadDrop(); dash.loadAlbums(); },
    push: function () { dash.loadPush(); },
    email: function () { dash.loadAnnounce({ opened: true }); },
    rego: function () { dash.loadRego(); },
    discord: function () { dash.loadDiscord(); },
    settings: function () {
      dash.loadRegoSettings(); dash.loadLimits(); dash.loadEoi(); dash.loadCountdown(); dash.loadFlags();
      dash.loadEmailHold(); dash.loadSlides(); dash.loadCounters(); dash.loadPrivacy();
    },
    accounts: function () { dash.loadAccounts(); }
  };
  // And what it fetches when the page has just opened on it, where
  // refresh() is about to run and already gets some of this. Only the
  // two tabs refresh() overlaps are listed; everything else loads the
  // same way whether it was clicked or restored.
  var TAB_BOOT = {
    tab: function () {},                           // refresh() loads the day board
    review: function () { dash.loadEncoder(); }    // it loads the list, but not the machines
  };

  // Which tab is open, kept so a reload comes back to it. On the day
  // the dashboard is reloaded constantly — a flaky venue connection, a
  // phone waking up, a stale session — and landing on Scores every time
  // when the job in hand is Review means finding your place again on
  // every one of them.
  //
  // The address carries it too (/dash#rego), so it survives a reload
  // with nothing stored, and a link to one tab can be passed to someone
  // else. replaceState rather than assigning to location.hash: the
  // latter fills the back button with tab changes, so Back stops
  // meaning "the page I came from".
  var TAB_KEY = 'scs2-dashboard-tab';
  dash.REVIEW_KEY = 'scs2-dashboard-review';
  function rememberTab(name) {
    try { localStorage.setItem(TAB_KEY, name); } catch (e) {}
    try { history.replaceState(null, '', '#' + name); } catch (e) {}
  }
  function buttonFor(name) {
    return shownTabs().filter(function (b) { return b.dataset.tab === name; })[0] || null;
  }

  // opts.boot says the page has just opened on this tab: the pill has
  // nothing to slide from, and refresh() is about to fetch some of what
  // the tab would.
  function openTab(name, opts) {
    var o = opts || {};
    var b = buttonFor(name);
    if (!b) return false;
    tabButtons.forEach(function (x) {
      var on = x === b;
      x.classList.toggle('is-active', on);
      x.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    placePill(!o.boot);
    VIEWS.forEach(function (t) {
      var view = el('view-' + t);
      var on = t === name;
      if (on && view.classList.contains('hidden')) {
        view.classList.remove('hidden');
        view.style.animation = 'none'; void view.offsetWidth; view.style.animation = '';
      } else view.classList.toggle('hidden', !on);
    });
    var load = (o.boot && TAB_BOOT[name]) || TAB_LOAD[name];
    if (load) load();
    setMenu(false);
    return true;
  }

  tabButtons.forEach(function (b) {
    b.addEventListener('click', function () {
      if (b.classList.contains('is-active')) return;
      // the Queue's own button opens the queue, not the last card opened
      if (b.dataset.tab === 'review') state.reviewOne = null;
      openTab(b.dataset.tab);
      rememberTab(b.dataset.tab);
    });
  });

  // The tab to open on boot: the address first, so a link or a
  // bookmark wins, then what was last open here. A name that is no
  // longer a tab, or not one this account has, falls through to the
  // first tab it does have. Says whether it opened one. fresh loads the
  // tab in full, for when refresh() is not about to run.
  function restoreTab(fresh) {
    var fromHash = String(location.hash || '').replace(/^#/, '');
    var stored = '';
    try { stored = localStorage.getItem(TAB_KEY) || ''; } catch (e) {}
    var current = activeTab();
    var name = buttonFor(fromHash) ? fromHash : (buttonFor(stored) ? stored : current.dataset.tab);
    // already where we are going, unless the view was put away while
    // the account's tabs were not known; the address should still say so
    if (name === current.dataset.tab && current.classList.contains('is-active') && !el('view-' + name).classList.contains('hidden')) {
      rememberTab(name);
      return false;
    }
    openTab(name, fresh === true ? {} : { boot: true });
    rememberTab(name);
    return true;
  }

  // A link to a tab, followed while the dashboard is already open,
  // changes the address and nothing else: a browser does not reload a
  // page for a fragment. So answer the change. An address naming a tab
  // that is not there is rewritten to the one actually open, rather
  // than left saying something untrue.
  window.addEventListener('hashchange', function () {
    var name = String(location.hash || '').replace(/^#/, '');
    if (!buttonFor(name)) { rememberTab(activeTab().dataset.tab); return; }
    if (name === activeTab().dataset.tab) return;
    openTab(name);
    rememberTab(name);
  });

  window.addEventListener('resize', function () { placePill(false); });

  // A menu of the buttons used once in a while: it closes once one is
  // pressed, and on a press anywhere outside it. The press outside is
  // heard as pointerdown too, since Safari on an iPad or a phone sends no
  // click for a tap on something that does not take one.
  document.addEventListener('click', function (e) {
    Array.prototype.forEach.call(document.querySelectorAll('details.menu[open]'), function (d) {
      var inside = d.contains(e.target);
      if (!inside || (e.target.closest('button') && d.querySelector('.menu-pop').contains(e.target))) d.open = false;
    });
  });
  document.addEventListener('pointerdown', function (e) {
    Array.prototype.forEach.call(document.querySelectorAll('details.menu[open]'), function (d) {
      if (!d.contains(e.target)) d.open = false;
    });
  });
  // It opens leftward from its button, or rightward when that would run
  // off the screen: on a narrow screen its button can wrap to the left.
  document.addEventListener('toggle', function (e) {
    var d = e.target;
    if (!d.classList || !d.classList.contains('menu') || !d.open) return;
    var pop = d.querySelector('.menu-pop');
    if (!pop) return;
    pop.classList.remove('is-rightward');
    if (pop.getBoundingClientRect().left < 8) pop.classList.add('is-rightward');
  }, true);

  // A link to one card: the Settings tab's contents line, and the
  // buttons elsewhere that send you to the setting they are about. The
  // address keeps naming the tab, so a reload lands on the tab.
  document.addEventListener('click', function (e) {
    var link = e.target.closest && e.target.closest('[data-anchor]');
    if (!link) return;
    e.preventDefault();
    var go = link.getAttribute('data-goto');
    if (go && go !== activeTab().dataset.tab) { openTab(go); rememberTab(go); }
    var target = el(link.getAttribute('data-anchor'));
    if (target) target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  // ---- overview (teams + quests feed every tab) ----
  function refresh() {
    el('who').textContent = el('who-menu').textContent = whoAmI();
    return api('/api/console/overview').then(function (d) {
      if (!d.ok) return;
      state.teams = d.teams;
      state.quests = d.quests;
      dash.renderTeams();
      dash.ledgerTeams();
      dash.loadQuestGroups();
      // only what this account's tabs show
      if (can('scores')) { dash.loadFreeze(); dash.loadSchedule(); dash.loadLedgerCheck(); dash.loadBoard(); dash.loadAfter(); }
      if (can('settings')) { dash.loadFlags(); dash.loadCountdown(); dash.loadLimits(); }
      if (can('review')) dash.loadReview();
      if (!state.ready) { state.ready = true; el('main').classList.add('is-ready'); placePill(false); }
    }).catch(function (err) {
      // nothing drawn yet: asked again until the console has its data
      if (state.ready || (err && err.message === 'signed out')) return;
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 5000);
    });
  }
  var refreshTimer = 0;
  window.addEventListener('online', function () {
    if (!state.ready && session()) { clearTimeout(refreshTimer); refresh(); }
  });
  function refreshTeamsOnly() {
    api('/api/console/overview').then(function (d) {
      if (!d.ok) return;
      state.teams = d.teams; state.quests = d.quests;
      dash.renderTeams(); dash.ledgerTeams();
    }).catch(function () {});
  }
})(window.dash);
