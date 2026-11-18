// The Log tab.
(function (dash) {
  // core.js
  var api = dash.api, el = dash.el, fill = dash.fill, fmtTime = dash.fmtTime, h = dash.h, row = dash.row,
    state = dash.state;

  dash.loadLog = loadLog;

  // ---- log ----
  // A page is asked for once: Load more waits for it, and an answer to a
  // load that a fresh one has since replaced is dropped.
  var logAsked = 0;
  function loadLog(reset) {
    if (reset) { state.logBefore = null; el('log-rows').textContent = ''; }
    var asked = ++logAsked;
    var q = '/api/console/log?limit=50' + (state.logBefore ? '&before=' + state.logBefore : '');
    el('log-more').disabled = true;
    api(q).then(function (d) {
      if (asked !== logAsked) return;
      if (!d.ok) { el('log-more').disabled = false; return; }
      var rows = d.entries.map(function (e) {
        state.logBefore = e.id;
        // a held post keeps its line breaks
        return row([h('td', null, fmtTime(e.at, true)), h('td', null, e.action), h('td', null, e.team_name),
          h('td', e.action === 'discord-held' ? 'log-text' : null, e.quest_code),
          h('td', 'num', (e.points_delta > 0 ? '+' : '') + (Math.round(e.points_delta * 100) / 100)),
          h('td', 'num', Math.round(e.new_total * 100) / 100), h('td', 'muted', e.actor || '')]);
      });
      if (reset) fill(el('log-rows'), rows);
      else rows.forEach(function (r) { el('log-rows').appendChild(r); });
      el('log-more').disabled = d.entries.length < 50;
    }).catch(function () { if (asked === logAsked) el('log-more').disabled = false; });
  }
  el('log-more').addEventListener('click', function () { loadLog(false); });
})(window.dash);
