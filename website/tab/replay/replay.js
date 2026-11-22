/* The replay page: every team's recorded route played back on the map
   (replay-map.js), with its quests from the tab. Behind the dashboard's
   Replay switch: before that the tab answers 404 and the page says so. */
(function () {
  'use strict';

  var scs = window.scs;
  var API = scs.TAB_API;
  function $(id) { return document.getElementById(id); }

  // the slide in from the tab (assets/push.js) has finished
  function arrived() {
    return window.scsPush ? window.scsPush.ready : Promise.resolve();
  }

  // the map's library comes down while the replay's data does
  if (window.SCSReplay && window.SCSReplay.preload) window.SCSReplay.preload();
  function load() {
  scs.fetch(API + '/api/replay', { cache: 'no-store' }).then(function (r) {
    scs.gotIt('replay');
    $('rp-error').classList.add('is-hidden');
    if (r.status === 404) {
      $('rp-lead').textContent = 'Not open yet.';
      $('rp-closed').hidden = false;
      return null;
    }
    if (!r.ok) throw new Error('replay ' + r.status);
    return r.json();
  }).then(function (d) {
    if (!d || !d.ok) return;
    // drawn once the page has slid in, so the slide has the page to itself
    return arrived().then(function () {
      $('rp-body').hidden = false;
      var player = window.SCSReplay.start($('rp-host'), { api: API, replay: d });
      player.ready.then(function () {
        var n = player.teams().length;
        var all = (d.teams || []).length;
        $('rp-lead').textContent = n === all
          ? (all === 1 ? 'The one team recorded a route.' : 'All ' + all + ' teams recorded a route.')
          : n + ' of ' + all + ' teams recorded a route.';
      }, function () {
        $('rp-lead').textContent = '';
      });
    });
  }).catch(function () {
    $('rp-lead').textContent = 'Could not load.';
    $('rp-body').hidden = true;
    $('rp-error').classList.remove('is-hidden');
    scs.again('replay', load);
  });
  }
  load();
})();
