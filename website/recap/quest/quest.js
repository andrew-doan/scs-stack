/* One quest's page, opened from the recap's quest table: how many teams
   sent it and did it, the accepted submissions in the order they came
   in, and, for a team signed in, its own submissions for the quest. */
(function () {
  'use strict';

  var scs = window.scs;
  var API = scs.TAB_API;

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function word(n, one, many) { return n === 1 ? one : many; }

  var barTitle = document.querySelector('.site-brand-page');
  function showName(text) {
    $('qs-name').textContent = text;
    if (barTitle) barTitle.textContent = text;
    document.title = text + ' | SCS.2';
  }

  var key = '';
  try { key = new URLSearchParams(location.search).get('key') || ''; } catch (err) { key = ''; }
  if (key) showName(key);

  var shown = null;
  var mineShown = null;
  var teamPages = false;
  scs.pulse().then(function (p) {
    teamPages = !!(p && p.team_pages);
    if (teamPages && shown) render(shown);
  });

  function render(d) {
    $('qs-body').hidden = false;
    showName(d.quest.name);
    // the quest's code as its chip, a link to it on the quest list
    var lead = $('qs-lead');
    lead.textContent = '';
    lead.classList.add('has-code');
    var chip = el('a', 'qs-code');
    chip.href = '../../questlist/#' + encodeURIComponent(d.quest.key);
    chip.appendChild(el('span', 'code', d.quest.key));
    lead.appendChild(chip);
    if (d.quest.region) lead.appendChild(el('span', null, d.quest.region));

    var s = d.submissions;
    var big = $('qs-big');
    big.textContent = '';
    big.appendChild(scs.figure([d.done_by, word(d.done_by, 'Completion', 'Completions') + ' out of ', d.teams, word(d.teams, ' Team', ' Teams')]));
    var sent = [s.sent, word(s.sent, 'Submission', 'Submissions') + ' from ', s.teams, word(s.teams, ' Team', ' Teams') +
      ', ', s.accepted, ' Accepted' + (s.waiting ? ', ' : ' and '), s.rejected, ' Rejected'];
    if (s.waiting) sent.push(' and ', s.waiting, ' Waiting');
    big.appendChild(scs.figure(sent));

    var list = $('qs-order');
    list.textContent = '';
    if (!d.accepted.length) {
      list.appendChild(el('li', 'qs-none', 'None to show.'));
    } else {
      // one sent outside the dashboard's Quest times frame comes last,
      // with a dash for its place and no time
      d.accepted.forEach(function (a, i) {
        var li = el('li', a.at ? null : 'qs-untimed');
        if (a.at) li.style.counterSet = 'rc ' + (i + 1);
        var name = el('span', 'rc-name');
        // a team's own page once team pages are open, in ink as the tab draws them
        if (teamPages) {
          var link = el('a', 'qs-team', a.team);
          link.href = '../../tab/team/?name=' + encodeURIComponent(a.team);
          name.appendChild(link);
        } else {
          name.textContent = a.team;
        }
        li.appendChild(name);
        if (a.at) li.appendChild(el('span', 'rc-num', scs.fmtTime(a.at)));
        list.appendChild(li);
      });
    }
    drawVisits(d);
    shown = d;
  }

  // ---- a quest the organisers show photo by photo: each team's places
  // in the order visited, the most first, each team opening to its list ----
  var KINDS = { stations: ['Stations Visited', ' Station', ' Stations'], places: ['Places Visited', ' Place', ' Places'] };
  var openTeams = {};
  function drawVisits(d) {
    var list = $('qs-visits');
    var v = d.visits || null;
    var kind = KINDS[v && v.kind] || KINDS.places;
    var teams = v && Array.isArray(v.teams) ? v.teams.filter(function (t) { return t.visits && t.visits.length; }) : [];
    $('qs-visits-wrap').hidden = !teams.length;
    $('qs-visits-title').textContent = kind[0];
    list.textContent = '';
    var place = 0;
    var last = -1;
    teams.forEach(function (t, i) {
      var n = t.visits.length;
      if (n !== last) { place = i + 1; last = n; }
      var li = el('li', 'qs-vt');
      li.style.counterSet = 'rc ' + place;
      var toggle = el('button', 'qs-vt-toggle');
      toggle.type = 'button';
      var name = el('span', 'rc-name', t.team);
      name.insertAdjacentHTML('beforeend', '<svg class="qs-vt-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>');
      toggle.appendChild(name);
      toggle.appendChild(el('span', 'rc-num', n + word(n, kind[1], kind[2])));
      var rows = el('div', 'qs-vt-list');
      rows.id = 'qs-vt-' + i;
      rows.setAttribute('role', 'list');
      toggle.setAttribute('aria-controls', rows.id);
      t.visits.forEach(function (visit) {
        var row = el('div', 'qs-vt-row');
        row.setAttribute('role', 'listitem');
        row.appendChild(el('span', 'qs-vt-time', visit.at ? scs.fmtHour(visit.at, true) : ''));
        row.appendChild(el('span', 'qs-vt-name', visit.place));
        rows.appendChild(row);
      });
      function set(open) {
        toggle.setAttribute('aria-expanded', String(open));
        li.classList.toggle('is-open', open);
        rows.hidden = !open;
        if (open) openTeams[t.team] = true; else delete openTeams[t.team];
      }
      set(!!openTeams[t.team]);
      toggle.addEventListener('click', function () { set(toggle.getAttribute('aria-expanded') !== 'true'); });
      li.appendChild(toggle);
      li.appendChild(rows);
      list.appendChild(li);
    });
  }

  // ---- a signed-in team's own submissions for this quest ----
  function session() {
    try { return localStorage.getItem('scs2-submit-session') || ''; } catch (err) { return ''; }
  }
  var STATUS = { accepted: 'Accepted', rejected: 'Rejected', pending: 'Waiting', queued: 'Queued', deleted: 'Deleted' };
  function fileUrl(k) { return API + '/api/submit/file?key=' + encodeURIComponent(k); }
  function shownType(type) { return /^(image|video)\//.test(type || ''); }

  function thumbs(sub) {
    var strip = el('span', 'qs-thumbs');
    var items = [];
    var media = (sub.media || []).filter(function (m) { return !m.uploading && shownType(m.type); });
    media.forEach(function (m) {
      var photo = m.type.indexOf('image/') === 0;
      var item = { url: photo && !scs.animatedType(m.type) ? fileUrl(m.key) + '&res=1080' : fileUrl(m.key), thumb: scs.thumbUrl(m.key, m.type), type: m.type, name: m.name };
      if (photo && !scs.animatedType(m.type)) item.full = fileUrl(m.key);
      if (!photo) {
        if (m.renditions && m.renditions.length && window.scsVideo) {
          item.sizes = window.scsVideo.sizes(m.renditions, function (res) { return fileUrl(m.key) + '&res=' + res; });
          item.url = item.sizes[0].url;
        } else {
          item.processing = true;
          item.still = fileUrl(m.key) + '&thumb=1';
          if (m.skipped) item.skipped = true;
        }
      }
      items.push(item);
    });
    media.forEach(function (m, i) {
      var btn = el('button', 'qs-thumb');
      btn.type = 'button';
      btn.title = m.name;
      var img = el('img');
      img.crossOrigin = 'anonymous';
      img.alt = m.name;
      btn.appendChild(img);
      scs.keepPicture(img, scs.thumbUrl(m.key, m.type));
      if (m.type.indexOf('video/') === 0) btn.appendChild(el('span', 'qs-play', '▶'));
      btn.addEventListener('click', function () { scs.lightbox(items, i, img); });
      strip.appendChild(btn);
    });
    return media.length ? strip : null;
  }

  function renderMine(d) {
    var wrap = $('qs-mine-wrap');
    var list = $('qs-mine');
    list.textContent = '';
    var subs = (d && d.submissions) || [];
    wrap.hidden = false;
    if (!subs.length) {
      list.appendChild(el('li', 'qs-none', 'Your team sent nothing for this quest.'));
    }
    subs.slice().reverse().forEach(function (sub) {
      var li = el('li', 'qs-sub');
      var head = el('div', 'qs-sub-head');
      head.appendChild(el('span', 'qs-status is-' + sub.status, STATUS[sub.status] || sub.status));
      head.appendChild(el('span', 'qs-when', scs.fmtTime(sub.submitted_at)));
      li.appendChild(head);
      if (sub.reason && (sub.status === 'rejected' || sub.status === 'deleted')) {
        li.appendChild(el('p', 'qs-reason', sub.reason));
      }
      var strip = thumbs(sub);
      if (strip) li.appendChild(strip);
      list.appendChild(li);
    });
    mineShown = d;
  }

  function loadMine() {
    var token = session();
    if (!token || !key) return;
    scs.fetch(API + '/api/submit/mine?quest=' + encodeURIComponent(key), {
      cache: 'no-store',
      headers: { authorization: 'Bearer ' + token }
    }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (d) {
      if (d && d.ok) renderMine(d);
    }).catch(function () {});
  }

  // the settings that change how a time reads redraw what is on screen
  document.addEventListener('scs-dates-changed', function () {
    if (shown) render(shown);
    if (mineShown) renderMine(mineShown);
  });

  function load() {
    if (!key) {
      $('qs-lead').textContent = 'No quest named. Pick one from the recap.';
      $('qs-closed-why').hidden = true;
      $('qs-closed').hidden = false;
      return;
    }
    scs.fetch(API + '/api/recap/quest?key=' + encodeURIComponent(key), { cache: 'no-store' }).then(function (r) {
      scs.gotIt('quest-recap');
      $('qs-error').classList.add('is-hidden');
      if (r.status === 404) {
        $('qs-lead').textContent = 'Not open yet.';
        $('qs-closed').hidden = false;
        return null;
      }
      if (!r.ok) throw new Error('quest ' + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || !d.ok) return;
      // drawn once the page has slid in (assets/push.js)
      return (window.scsPush ? window.scsPush.ready : Promise.resolve()).then(function () {
        render(d);
        scs.rise($('qs-body'));
        loadMine();
      });
    }).catch(function () {
      $('qs-lead').textContent = 'Could not load.';
      $('qs-body').hidden = true;
      $('qs-error').classList.remove('is-hidden');
      scs.again('quest-recap', load);
    });
  }

  load();
})();
