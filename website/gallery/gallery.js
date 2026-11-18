/* Post-event gallery — accepted submissions whose teams ticked the
   gallery box on the submit page. Reading it takes a team sign-in (or
   an organiser's dashboard session), so the proof is not there for
   anyone who happens on the address. */
(function () {
  'use strict';

  var scs = window.scs;
  var statusEl = document.getElementById('gal-status');
  var grid = document.getElementById('gal-grid');
  var gateEl = document.getElementById('gal-gate');
  var loginEl = document.getElementById('gal-login');
  // the row of event photographs under the gate, filled by
  // assets/photo-strip.js — it travels with the gate
  var shotsEl = document.getElementById('gal-shots');
  var showBtn = document.getElementById('gal-slideshow');
  var fileUrl = scs.fileUrl;

  var slides = [];    // one entry per photo or video, flattened
  var questNames = {}; // code (normalised) -> the quest's name
  var titleNodes = []; // the tiles waiting on a quest name

  // an hour shows its first row; the count above it opens the rest
  var HOUR_SHOWN = 4;

  var PLAY_GLYPH = '<svg class="gal-play" width="8" height="10" viewBox="0 0 8 10" fill="currentColor" aria-hidden="true"><path d="M0 0l8 5-8 5z"/></svg>';
  var MORE_ARROW = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="square" aria-hidden="true"><path d="M8 1.5v11M2.8 8l5.2 5 5.2-5"/></svg>';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  // The worker stores UTC; the page reads the day in the device's own
  // zone, the same as scs.fmtTime does.
  function stampDate(utc) {
    var t = String(utc == null ? '' : utc).trim();
    var m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/);
    if (!m) return null;
    var d = new Date(m[1] + 'T' + m[2] + (m[3] || ':00') + 'Z');
    return isNaN(d.getTime()) ? null : d;
  }
  function clock(d) { return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function hourKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours());
  }

  // Which copy of a video plays, Auto included, is video-sizes.js's
  // choice, kept on this device for every player on the site. A photo
  // has one viewing copy (~1920px, made at upload), shown unless the
  // choice is Original. A GIF is asked for whole: its only still is its
  // first frame.
  function videoPref() { return window.scsVideo ? window.scsVideo.pref() : 'auto'; }
  function isVideo(item) { return String(item.type).indexOf('video/') === 0; }
  // A video the encoder has not reached plays as it was sent, with what
  // the phone wrote into it blanked by the worker (uploaded=1).
  function unencoded(item) { return isVideo(item) && !(item.renditions && item.renditions.length); }
  function videoSizes(item) {
    if (!window.scsVideo || unencoded(item)) return null;
    return window.scsVideo.sizes(item.renditions, function (res) { return fileUrl(item.key) + '&res=' + res; });
  }
  function videoUrl(item) {
    if (unencoded(item)) return fileUrl(item.key) + '&uploaded=1';
    var list = videoSizes(item);
    return list ? window.scsVideo.pick(list).url : fileUrl(item.key) + '&res=1080';
  }
  function imageUrl(key) {
    return videoPref() === 'original' ? fileUrl(key) : fileUrl(key) + '&res=1080';
  }
  function mediaUrl(item) {
    if (scs.animatedType(item.type)) return fileUrl(item.key);
    return item.type.indexOf('video/') === 0 ? videoUrl(item) : imageUrl(item.key);
  }

  // the submit page's sign-in: a sign-in on either page is both
  function getSession() { return scs.teamSession(); }
  function setSession(token, team) { scs.setTeamSession(token, team); }

  // one photo or video for the slideshow (assets/slideshow.js)
  function slideOf(m, sub) {
    return {
      type: m.type,
      alt: sub.quest_code + ' — ' + sub.team_name,
      photo: function () { return imageUrl(m.key); },
      video: function () { return videoUrl(m); },
      sizes: function () { return videoSizes(m); },
      plate: function () { return { code: sub.quest_code, name: questName(sub.quest_code), right: sub.team_name }; }
    };
  }

  // the quest's name for a code, when the list has loaded
  function questName(code) {
    return questNames[scs.normQuest(code)] || '';
  }

  // The names arrive on their own clock, so the tiles are built with
  // the code and take the name whenever it turns up.
  function applyNames() {
    titleNodes.forEach(function (t) {
      var name = questName(t.code);
      if (name) t.node.textContent = name;
    });
  }

  // what the page holds: the count, the teams and the span of the day
  function holdsLine(photos, videos, teams, first, last) {
    var what;
    if (photos && videos) what = (photos + videos) + ' photos and videos';
    else if (videos) what = plural(videos, 'video', 'videos');
    else what = plural(photos, 'photo', 'photos');
    var line = what + ' from ' + plural(teams, 'team', 'teams');
    if (first && last && clock(first) !== clock(last)) {
      line += ', ' + clock(first) + ' to ' + clock(last);
    }
    return line + '.';
  }

  // One tile: the square, the black plate carrying the code — and the
  // play glyph on a video, which is the only way a video differs — then
  // the quest's name and the time and team under it.
  function tile(item) {
    var sub = item.sub;
    var btn = el('button', 'gal-tile gal-open');
    btn.type = 'button';

    var pic = el('span', 'gal-pic');
    var img = document.createElement('img');
    img.crossOrigin = 'anonymous'; // readable to the worker, so it can keep a copy
    img.alt = ''; // the caption beside it says what the picture is
    pic.appendChild(img);
    // a file with no small copy is a plain square with its plate on it
    scs.keepPicture(img, scs.thumbUrl(item.m.key, item.m.type), { letGo: true, batch: true });

    var plate = el('span', 'gal-plate');
    plate.appendChild(el('span', 'gal-quest', sub.quest_code));
    if (isVideo(item.m)) plate.insertAdjacentHTML('beforeend', PLAY_GLYPH);
    pic.appendChild(plate);
    btn.appendChild(pic);

    var cap = el('span', 'gal-caption');
    var name = el('span', 'gal-name', questName(sub.quest_code) || sub.quest_code);
    titleNodes.push({ code: sub.quest_code, node: name });
    cap.appendChild(name);
    cap.appendChild(el('span', 'gal-meta',
      (item.at ? clock(item.at) + ' · ' : '') + sub.team_name));
    btn.appendChild(cap);

    btn.addEventListener('click', function () {
      scs.lightbox(item.items, item.index, img.parentNode ? img : null);
    });
    return btn;
  }

  // more: the worker listed only the newest submissions
  function render(subs, more) {
    grid.textContent = '';
    slides = [];
    titleNodes = [];
    if (showBtn) { showBtn.classList.add('is-hidden'); showBtn.parentNode.classList.add('is-hidden'); }

    // one tile per photo or video, the day running forwards
    var items = [];
    subs.forEach(function (sub) {
      var media = sub.media || [];
      var at = stampDate(sub.submitted_at);
      var viewItems = media.map(function (m) {
        var list = isVideo(m) ? videoSizes(m) : null;
        // a photo opens as its viewing copy; a zoom brings the whole picture
        var full = !isVideo(m) && !scs.animatedType(m.type) ? fileUrl(m.key) : '';
        var item = { url: list ? list[0].url : mediaUrl(m), sizes: list, full: full, thumb: scs.thumbUrl(m.key, m.type), type: m.type, name: sub.quest_code + ' — ' + sub.team_name };
        // what shows when the browser cannot play the file as it was sent
        if (unencoded(m)) item.still = scs.thumbUrl(m.key, m.type);
        if (m.skipped) item.skipped = true;
        return item;
      });
      media.forEach(function (m, i) {
        items.push({ sub: sub, m: m, at: at, items: viewItems, index: i, seq: items.length });
      });
    });
    if (!items.length) {
      statusEl.textContent = 'Nothing here yet.';
      return;
    }
    items.sort(function (a, b) {
      var at = a.at ? a.at.getTime() : Infinity;
      var bt = b.at ? b.at.getTime() : Infinity;
      return at === bt ? a.seq - b.seq : at - bt;
    });

    var teams = {};
    var photos = 0;
    var videos = 0;
    items.forEach(function (it) {
      teams[it.sub.team_name] = 1;
      if (isVideo(it.m)) videos++; else photos++;
      // the slideshow's own order is the order the page lists them in
      slides.push(slideOf(it.m, it.sub));
    });

    // a rule with the hour on it for every hour that has anything: the
    // hours are the page's index, so there is no second one to scroll past
    var hours = [];
    var byHour = {};
    items.forEach(function (it) {
      var key = it.at ? hourKey(it.at) : 'unknown';
      if (!byHour[key]) {
        byHour[key] = { at: it.at, items: [] };
        hours.push(byHour[key]);
      }
      byHour[key].items.push(it);
    });
    var days = {};
    hours.forEach(function (h) { if (h.at) days[h.at.toDateString()] = 1; });
    var manyDays = Object.keys(days).length > 1;

    hours.forEach(function (hour) {
      var section = el('section', 'gal-hour');
      var head = el('div', 'gal-head');
      var label = 'Time not recorded';
      if (hour.at) {
        label = pad2(hour.at.getHours()) + ':00';
        if (manyDays) {
          label = hour.at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ', ' + label;
        }
      }
      head.appendChild(el('h2', 'gal-hour-time', label));

      // The count is the way into the rest of the hour, so it is the
      // control. An hour whose pictures are all on screen says nothing:
      // the figure is already in the column under it.
      if (hour.items.length > HOUR_SHOWN) {
        var all = el('button', 'gal-all');
        all.type = 'button';
        all.setAttribute('aria-expanded', 'false');
        var word = el('span', null, 'See all ' + hour.items.length);
        all.appendChild(word);
        all.insertAdjacentHTML('beforeend', MORE_ARROW);
        all.addEventListener('click', function () {
          var open = !section.classList.contains('is-open');
          section.classList.toggle('is-open', open);
          all.setAttribute('aria-expanded', open ? 'true' : 'false');
          word.textContent = open ? 'Show fewer' : 'See all ' + hour.items.length;
        });
        head.appendChild(all);
      }
      section.appendChild(head);

      var row = el('div', 'gal-row');
      hour.items.forEach(function (it) { row.appendChild(tile(it)); });
      section.appendChild(row);
      grid.appendChild(section);
    });

    var shown = subs.filter(function (sub) { return sub.media && sub.media.length; }).length;
    statusEl.textContent = holdsLine(photos, videos, Object.keys(teams).length,
      items[0].at, items[items.length - 1].at) +
      (more ? ' Showing the newest ' + plural(shown, 'submission', 'submissions') + '.' : '');
    grid.classList.add('t-rise-list'); // the first hours rise in on a stagger
    applyNames();
    if (showBtn) { showBtn.classList.toggle('is-hidden', !slides.length); showBtn.parentNode.classList.toggle('is-hidden', !slides.length); }
  }

  // Not signed in: say so and put the sign-in under it, rather than
  // showing an error that reads like a fault.
  function showGate() {
    statusEl.textContent = '';
    grid.textContent = '';
    if (showBtn) { showBtn.classList.add('is-hidden'); showBtn.parentNode.classList.add('is-hidden'); }
    if (shotsEl) shotsEl.classList.remove('is-hidden');
    if (loginEl && loginEl.classList.contains('is-hidden')) {
      loginEl.classList.remove('is-hidden');
      scs.rise(loginEl);
    }
    if (!gateEl) return;
    gateEl.classList.remove('is-hidden');
    scs.rise(gateEl);
  }

  function load() {
    var token = getSession();
    if (!token) { showGate(); return; }
    scs.fetch(scs.TAB_API + '/api/submit/gallery', {
      headers: { authorization: 'Bearer ' + token },
      cache: 'no-store'
    })
      .then(function (r) {
        // a session the worker no longer knows is signed out everywhere
        if (r.status === 401) { setSession(''); showGate(); throw new Error('signed out'); }
        return r.json();
      })
      .then(function (data) {
        if (!data.ok) throw new Error('bad payload');
        scs.gotIt('gallery');
        if (gateEl) gateEl.classList.add('is-hidden');
        if (loginEl) loginEl.classList.add('is-hidden');
        if (shotsEl) shotsEl.classList.add('is-hidden');
        render(data.submissions || [], !!data.more);
      })
      .catch(function (err) {
        if (err && err.message === 'signed out') return;
        statusEl.textContent = 'Could not load the gallery. Trying again.';
        scs.again('gallery', load);
      });
  }

  // ---------- sign in ----------
  // The same sign-in as the submit page's, except that it ends in the
  // gallery rather than the composer.
  var loginBtn = document.getElementById('gal-login-btn');
  var loginError = document.getElementById('gal-login-error');
  var loginCard = loginEl ? loginEl.querySelector('.sub-signin') : null;
  var teamInput = document.getElementById('gal-team');
  var codeInput = document.getElementById('gal-code');

  function doLogin() {
    scs.swapText(loginError, '');
    loginBtn.disabled = true;
    loginBtn.classList.add('is-busy');
    scs.postJson(scs.TAB_API + '/api/submit/login', {
      team_name: teamInput.value,
      code: codeInput.value
    }).then(function (res) {
      loginBtn.disabled = false;
      loginBtn.classList.remove('is-busy');
      if (res.status === 200 && res.data.session) {
        setSession(res.data.session, res.data.team);
        codeInput.value = '';
        statusEl.textContent = 'Loading…';
        load();
      } else {
        scs.swapText(loginError, res.data.error || 'Could not sign in.');
        scs.shake(loginCard);
      }
    }).catch(function () {
      loginBtn.disabled = false;
      loginBtn.classList.remove('is-busy');
      scs.swapText(loginError, 'Could not reach the tab. Try again.');
      scs.shake(loginCard);
    });
  }
  if (loginBtn) {
    loginBtn.addEventListener('click', doLogin);
    codeInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doLogin();
    });
  }

  // names for the captions; the grid works without them
  scs.questList().then(function (data) {
    (data.groups || []).forEach(function (g) {
      questNames[scs.normQuest(g.key)] = g.name;
      (g.codes || []).forEach(function (c) { questNames[scs.normQuest(c.code)] = g.name; });
    });
    applyNames();
  }).catch(function () { /* captions fall back to the code alone */ });

  load();

  // the slideshow is assets/slideshow.js
  if (showBtn) showBtn.addEventListener('click', function () {
    if (window.scsSlideshow) window.scsSlideshow.start(slides);
  });
})();

