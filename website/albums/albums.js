/* Albums: the list of albums, one album's photos and videos as a
   waterfall or in rows, and adding to one as the album allows. */
(function () {
  'use strict';

  var scs = window.scs;
  var API = scs.TAB_API;
  var TEAM_KEY = 'scs2-submit-team';
  var MAX_FILE_BYTES = 25 * 1024 * 1024;        // sent whole; anything larger goes in slices
  var MAX_BIG_BYTES = 4 * 1024 * 1024 * 1024;
  var THUMB_EDGE = 480;
  var SHAPE_WAIT = 3000;
  var VIEW_EDGE = 1920;
  var VIEW_MAX = 2 * 1024 * 1024;
  var PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/gif'];
  // tiles laid out at a time, items asked for at a time, and roughly
  // how wide a column is
  var CHUNK = 24;
  var PAGE = 60;
  var COLUMN_WIDTH = 260;
  // Whether files go from this phone straight to R2, every one in
  // slices, rather than through the worker. Asked once; until the
  // answer comes, or if it never does, files go the way they always have.
  var direct = false;
  scs.fetch(API + '/api/album/upload/mode', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (d) { direct = !!(d && d.ok && d.direct); })
    .catch(function () { /* through the worker */ });

  var $ = function (id) { return document.getElementById(id); };
  var titleEl = $('alb-title');
  var aboutEl = $('alb-about');
  var statusEl = $('alb-status');
  // the line under the title goes when there is nothing to say on it
  function setStatusLine(text) {
    statusEl.textContent = text;
    statusEl.parentNode.classList.toggle('is-empty', !text);
  }
  var addEl = $('alb-add');
  var addBtn = $('alb-add-btn');
  var addBodyEl = addEl.querySelector('.alb-drawer-body');
  var filterEl = $('alb-filter');
  var whoBtn = $('alb-who-btn');
  var filterBodyEl = filterEl.querySelector('.alb-drawer-body');
  var modeEl = $('alb-mode');
  var peopleEl = $('alb-people');
  var findField = $('alb-find-field');
  var findEl = $('alb-find');
  var filteredEl = $('alb-filtered');
  var shareBtn = $('alb-share');
  var clearBtn = $('alb-clear');
  var loginEl = $('alb-login');
  var pickerEl = $('alb-picker');
  var listEl = $('alb-list');
  var gridEl = $('alb-grid');
  var progressEl = $('alb-progress');
  var pickBtn = $('alb-pick');
  var filesInput = $('alb-files');
  var orderEl = $('alb-order');
  var ORDER_KEY = 'scs2-album-order';
  var viewEl = $('alb-view');
  var toolsEl = $('alb-tools');
  var showBtn = $('alb-show');
  var VIEW_KEY = 'scs2-album-view';
  var skelEl = $('alb-skel');
  var retryRow = $('alb-retry-row');

  // an album on the list is at ?a=<its name>; one shown only to those
  // with the link is at ?k=<its key>; an organiser opens any album from
  // the dashboard at ?pass=<a pass it signed>
  var query = new URLSearchParams(location.search);
  var slug = (query.get('a') || '').trim();
  var linkKey = (query.get('k') || '').trim();
  var viewPass = (query.get('pass') || '').trim();
  var where = viewPass ? 'pass=' + encodeURIComponent(viewPass) : linkKey ? 'k=' + encodeURIComponent(linkKey) : 'a=' + encodeURIComponent(slug);
  if (linkKey || viewPass) {
    var robots = document.createElement('meta');
    robots.name = 'robots';
    robots.content = 'noindex';
    document.head.appendChild(robots);
  }
  var album = null;

  // Whose photos: only the people named, or everyone's but theirs. The
  // address carries it, by= or not= once for each person, so a link
  // copied from the page opens the album the same way.
  function nameKey(n) { return String(n == null ? '' : n).trim().toLowerCase(); }
  function oncePerName(names) {
    var seen = {};
    return names.map(function (n) { return String(n).trim().slice(0, 80); }).filter(function (n) {
      var k = nameKey(n);
      if (seen[k]) return false;
      seen[k] = true;
      return true;
    }).slice(0, 50);
  }
  var filter = { mode: 'by', names: [] };
  if (query.getAll('by').length) filter.names = oncePerName(query.getAll('by'));
  else if (query.getAll('not').length) filter = { mode: 'not', names: oncePerName(query.getAll('not')) };
  function filterQuery() {
    return filter.names.map(function (n) { return '&' + filter.mode + '=' + encodeURIComponent(n); }).join('');
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }

  function getSession() { return scs.teamSession(); }
  function getTeam() {
    try { return localStorage.getItem(TEAM_KEY) || ''; } catch (err) { return ''; }
  }
  function setSession(token, team) { scs.setTeamSession(token, team); }

  // An upload's own copies come from the album endpoint, a gallery
  // submission's from the proof endpoint; neither hands out the original.
  function isVideo(p) { return String(p.type).indexOf('video/') === 0; }
  function handheld() {
    return !!(window.matchMedia && window.matchMedia('(pointer: coarse), (hover: none)').matches);
  }
  // v: how many times the photo has been replaced, so a cached copy of
  // the one before is not used
  function albumFile(p) { return API + '/api/albums/file?key=' + encodeURIComponent(p.key) + (p.ver ? '&v=' + p.ver : ''); }
  function thumbSrc(p) {
    if (p.from === 'gallery') return scs.thumbUrl(p.key, p.type);
    return albumFile(p) + (scs.animatedType(p.type) ? '' : '&thumb=1');
  }
  function fullSrc(p) {
    var base = p.from === 'gallery' ? scs.fileUrl(p.key) : albumFile(p);
    if (scs.animatedType(p.type)) return base;
    return base + '&res=1080';
  }
  // the whole photo: as it was sent where the album shows details, the
  // copy with its metadata taken out where it does not
  function wholeSrc(p) {
    if (album && album.details) return albumFile(p) + '&orig=1';
    return p.from === 'gallery' ? scs.fileUrl(p.key) : albumFile(p);
  }
  // a video the encoder has not reached: as it was sent, with what the
  // phone wrote into it blanked by the worker
  function sentSrc(p) {
    return (p.from === 'gallery' ? scs.fileUrl(p.key) : albumFile(p)) + '&uploaded=1';
  }
  // the file a photo was picked as, where the album shows details
  var PICKED_NAMES = { 'image/heic': 'HEIC', 'image/heif': 'HEIF', 'image/webp': 'WebP' };
  function pickedSrc(p) {
    return albumFile(p) + '&picked=1';
  }
  function credit(p) {
    var who = p.team || p.by || '';
    if (p.quest) return p.quest + (who ? ' · ' + who : '');
    return who;
  }

  // ---------- while it loads ----------
  // Grey shapes stand where the albums or the pictures will land until
  // they come (the markup draws them before any script runs). A read with
  // no answer is asked again (scs.fetch), and the line says so once it has
  // taken a while. One that fails offers to try again, and tries by
  // itself when the phone is back online or the page is looked at again.
  var slowTimer = 0;
  var failedLoad = null;
  function loading(on) {
    clearTimeout(slowTimer);
    skelEl.hidden = !on;
    if (!on) return;
    failedLoad = null;
    retryRow.hidden = true;
    setStatusLine('Loading\u2026');
    slowTimer = setTimeout(function () { scs.swapText(statusEl, 'Still loading\u2026'); }, 6000);
  }
  function loadFailed(line, again) {
    loading(false);
    setStatusLine(line);
    retryRow.hidden = false;
    failedLoad = again;
  }
  function tryAgain() {
    var again = failedLoad;
    if (again && !document.hidden) again();
  }
  $('alb-retry').addEventListener('click', tryAgain);
  window.addEventListener('online', tryAgain);
  document.addEventListener('visibilitychange', tryAgain);
  window.addEventListener('pageshow', function (e) { if (e.persisted) tryAgain(); });

  // ---------- every album ----------

  function showList() {
    document.title = 'Albums | SCS.2';
    loading(true);
    scs.fetch(API + '/api/albums', { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('albums'); return r.json(); })
      .then(function (data) {
        loading(false);
        var albums = (data && data.albums) || [];
        listEl.textContent = '';
        if (!albums.length) {
          setStatusLine('No albums yet.');
          return;
        }
        setStatusLine(plural(albums.length, 'album', 'albums') + '.');
        albums.forEach(function (a) {
          var li = el('li', 'alb-item');
          var link = el('a', 'alb-card');
          link.href = '?a=' + encodeURIComponent(a.slug);
          var cover = el('span', 'alb-cover');
          if (a.cover) {
            var img = document.createElement('img');
            img.crossOrigin = 'anonymous';
            img.alt = '';
            cover.appendChild(img);
            scs.keepPicture(img, thumbSrc(a.cover), { batch: true, instead: frameFor(a.cover) });
          }
          link.appendChild(cover);
          link.appendChild(el('span', 'alb-name', a.name));
          link.appendChild(el('span', 'alb-count', countWords(a.photos || 0, a.videos || 0)));
          li.appendChild(link);
          listEl.appendChild(li);
        });
        listEl.hidden = false;
        listEl.classList.add('t-rise-list');
      })
      .catch(function () { loadFailed('Could not load the albums.', showList); });
  }

  function countWords(stills, videos) {
    if (stills && videos) return plural(stills, 'photo', 'photos') + ' and ' + plural(videos, 'video', 'videos');
    if (videos) return plural(videos, 'video', 'videos');
    return plural(stills, 'photo', 'photos');
  }

  // ---------- one album: the waterfall ----------
  // Each picture keeps its own shape, and goes into whichever column is
  // shortest, newest first. A shape the list does not carry is read off
  // the small copy before the tile is placed, so nothing moves once it
  // is on screen; tiles are laid out a chunk at a time as the page
  // nears the end of them.
  var wf = { photos: [], media: [], ratios: [], tiles: [], placed: 0, cols: [], heights: [], count: 0, busy: false, round: 0, next: null, fetching: null, seen: {}, total: 0, row: null, rowSum: 0, rowN: 0, width: 0, gap: 0, rowH: 0 };
  var sentinel = el('div', 'alb-more');
  gridEl.parentNode.insertBefore(sentinel, gridEl.nextSibling);
  // The foot of the album: a bar running while more of it is still to
  // come, and once it has all come, how many photos and videos it holds.
  // A page that could not be fetched says so and offers to try again.
  var footShows = '';
  function paintFoot(failed) {
    var waiting = wf.next != null || wf.placed < wf.photos.length;
    var shows = !wf.photos.length ? '' : failed ? 'failed' : waiting ? 'loading' : 'end:' + wf.photos.length;
    if (shows === footShows) return;
    footShows = shows;
    sentinel.textContent = '';
    sentinel.className = 'alb-more' + (shows ? ' is-' + shows.split(':')[0] : '');
    sentinel.removeAttribute('role');
    sentinel.removeAttribute('aria-label');
    if (shows === 'loading') {
      sentinel.setAttribute('role', 'progressbar');
      sentinel.setAttribute('aria-label', 'Loading more');
      sentinel.appendChild(el('span', 'alb-more-bar'));
    } else if (shows === 'failed') {
      sentinel.appendChild(el('span', 'alb-more-note', 'Could not load the rest of the album.'));
      var again = el('button', 'btn alb-more-again', 'Try again');
      again.type = 'button';
      again.addEventListener('click', function () {
        paintFoot();
        nextPage();
      });
      sentinel.appendChild(again);
    } else if (shows) {
      var videos = wf.photos.filter(isVideo).length;
      sentinel.appendChild(el('span', 'alb-more-note', countWords(wf.photos.length - videos, videos)));
    }
  }

  var view = 'waterfall';
  try { if (localStorage.getItem(VIEW_KEY) === 'rows') view = 'rows'; } catch (err) { /* this visit only */ }

  function layout() {
    gridEl.classList.toggle('is-rows', view === 'rows');
    if (view === 'rows') buildRows(); else buildColumns();
    for (var i = 0; i < wf.placed; i++) place(i);
  }
  function place(i) {
    if (view === 'rows') placeInRow(i); else placeInColumn(i);
  }
  function columnCount() {
    var width = gridEl.clientWidth || document.documentElement.clientWidth;
    return Math.max(2, Math.min(5, Math.round(width / COLUMN_WIDTH)));
  }
  function buildColumns() {
    wf.count = columnCount();
    gridEl.textContent = '';
    wf.cols = [];
    wf.heights = [];
    for (var i = 0; i < wf.count; i++) {
      var col = el('div', 'alb-col');
      gridEl.appendChild(col);
      wf.cols.push(col);
      wf.heights.push(0);
    }
  }
  function placeInColumn(i) {
    var k = 0;
    for (var j = 1; j < wf.cols.length; j++) if (wf.heights[j] < wf.heights[k] - 0.001) k = j;
    wf.cols[k].appendChild(wf.tiles[i]);
    // a column's height in widths of itself, with the gap counted
    wf.heights[k] += wf.ratios[i] + 0.03;
  }

  // ---------- or as rows ----------
  // Every picture in a row is one height and keeps its shape. A row ends
  // where it fills the width nearest the height rows aim for, and the
  // CSS grows each picture by its width over its height, so the row is
  // exactly as wide as the page. The row still being filled is not
  // stretched.
  function buildRows() {
    gridEl.textContent = '';
    wf.width = gridEl.clientWidth || document.documentElement.clientWidth;
    wf.gap = parseFloat(getComputedStyle(gridEl).rowGap) || 0;
    wf.rowH = Math.round(Math.max(110, Math.min(220, wf.width / 3.2)));
    gridEl.style.setProperty('--row-h', wf.rowH + 'px');
    wf.row = null;
  }
  // the height a row of n pictures, their widths over heights summing to
  // sum, has when it fills the width
  function rowHeight(sum, n) { return (wf.width - wf.gap * (n - 1)) / sum; }
  function closeRow() {
    wf.row.classList.add('is-full');
    wf.row = null;
  }
  function placeInRow(i) {
    var wide = 1 / wf.ratios[i];
    if (wf.row) {
      var withIt = rowHeight(wf.rowSum + wide, wf.rowN + 1);
      if (withIt < wf.rowH && rowHeight(wf.rowSum, wf.rowN) - wf.rowH < wf.rowH - withIt) closeRow();
    }
    if (!wf.row) {
      wf.row = el('div', 'alb-row');
      gridEl.appendChild(wf.row);
      wf.rowSum = 0;
      wf.rowN = 0;
    }
    wf.row.appendChild(wf.tiles[i]);
    wf.rowSum += wide;
    wf.rowN += 1;
    if (rowHeight(wf.rowSum, wf.rowN) <= wf.rowH) closeRow();
  }
  // height over width, read off the small copy where the list gives no
  // size, and the tiles are laid out without waiting longer than
  // SHAPE_WAIT for it
  function shapeOf(p) {
    if (p.w > 0 && p.h > 0) return Promise.resolve(p.h / p.w);
    return new Promise(function (resolve) {
      var probe = new Image();
      var timer = window.setTimeout(function () { done(1); }, SHAPE_WAIT);
      function done(r) {
        window.clearTimeout(timer);
        probe.onload = probe.onerror = null;
        probe.removeAttribute('src');
        resolve(r);
      }
      probe.crossOrigin = 'anonymous';
      probe.onload = function () { done(probe.naturalWidth ? probe.naturalHeight / probe.naturalWidth : 1); };
      probe.onerror = function () { done(1); };
      probe.src = thumbSrc(p);
    });
  }
  // kept within reason, so a panorama or a very tall screenshot is
  // cropped rather than a sliver
  function clampShape(r) { return Math.max(0.4, Math.min(2.5, r || 1)); }

  // the photo viewer is open, and a read of the album is waiting for it
  var viewing = false;
  var readAfterViewer = false;

  function tile(p, i) {
    var btn = el('button', 'alb-tile');
    btn.type = 'button';
    btn.style.setProperty('--wide', String(1 / wf.ratios[i]));
    btn.setAttribute('aria-label', (isVideo(p) ? 'Video' : 'Photo') + (credit(p) ? ' from ' + credit(p) : ''));
    var img = document.createElement('img');
    img.crossOrigin = 'anonymous';
    img.alt = '';
    btn.appendChild(img);
    scs.keepPicture(img, thumbSrc(p), { letGo: true, batch: true, instead: frameFor(p) });
    if (isVideo(p)) {
      btn.insertAdjacentHTML('beforeend', '<span class="alb-play" aria-hidden="true"><svg width="10" height="12" viewBox="0 0 8 10" fill="currentColor"><path d="M0 0l8 5-8 5z"/></svg></span>');
    }
    btn.addEventListener('click', function () {
      viewing = true;
      scs.lightbox(wf.media, i, img.parentNode ? img : null, {
        // the viewer reads the album by place, so a fresh read waits for it
        onClose: function () {
          viewing = false;
          if (!readAfterViewer) return;
          readAfterViewer = false;
          showAlbum(true);
        },
        originFor: function (k) {
          var t = wf.tiles[k];
          return t && t.querySelector('img');
        },
        shareUrl: function (k) {
          var shared = wf.photos[k] && wf.photos[k].share;
          return shared ? API + '/photo/' + shared : '';
        },
        downloadUrl: function (k) {
          var p = wf.photos[k];
          if (!p || p.processing) return '';
          if (album && album.details && !isVideo(p)) {
            if (!p.picked) return wholeSrc(p) + '&download=1';
            return [
              { url: wholeSrc(p) + '&download=1', label: 'Download JPEG' },
              { url: pickedSrc(p), label: p.picked === 'image/png' ? 'Download PNG' : 'Download original (' + (PICKED_NAMES[p.picked] || 'file') + ')' }
            ];
          }
          return (p.from === 'gallery' ? scs.fileUrl(p.key) : albumFile(p)) + '&download=1';
        },
        // a phone's screen is no bigger than the viewing copy, and a
        // whole picture for every photo looked at is more memory than an
        // iPhone gives a page; there it comes on a zoom
        whole: !handheld(),
        total: function () { return wf.next == null ? wf.media.length : wf.total; },
        more: nextPage,
        info: album && album.details ? function (k) { return detailsOf(wf.photos[k]); } : null
      });
    });
    return btn;
  }

  function nearEnd() {
    return sentinel.getBoundingClientRect().top < window.innerHeight + 900;
  }
  function more() {
    if (wf.busy) return;
    if (wf.placed >= wf.photos.length) { nextPage(); return; }
    wf.busy = true;
    var round = wf.round;
    var from = wf.placed;
    var to = Math.min(wf.photos.length, from + CHUNK);
    var shapes = [];
    for (var i = from; i < to; i++) shapes.push(shapeOf(wf.photos[i]));
    Promise.all(shapes).then(function (found) {
      if (round !== wf.round) return; // the album was drawn again meanwhile
      found.forEach(function (r, k) {
        var at = from + k;
        wf.ratios[at] = clampShape(r);
        wf.tiles[at] = tile(wf.photos[at], at);
        place(at);
      });
      wf.placed = to;
      wf.busy = false;
      paintFoot();
      if (nearEnd()) more();
    });
  }
  if (window.IntersectionObserver) {
    new IntersectionObserver(function (entries) {
      if (entries[0] && entries[0].isIntersecting) more();
    }, { rootMargin: '0px 0px 900px 0px' }).observe(sentinel);
  } else {
    window.addEventListener('scroll', function () { if (nearEnd()) more(); }, { passive: true });
  }
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (!wf.photos.length) return;
      if (view === 'rows' ? gridEl.clientWidth === wf.width : columnCount() === wf.count) return;
      layout();
      if (nearEnd()) more();
    }, 150);
  });

  // A video with no still: asked for again with fetch, which says why it
  // failed, and where the worker has none, a frame from the smallest copy
  // (or the file as sent, before there are copies), which the viewer then
  // shows before the video plays.
  function frameFor(p) {
    if (!isVideo(p)) return null;
    return function () {
      return scs.fetch(thumbSrc(p)).then(function (res) {
        if (res.ok) return thumbSrc(p);
        if (res.status !== 404) throw new Error('still ' + res.status);
        var sizes = mediaOf(p).sizes || [];
        var small = sizes.length > 1 ? sizes[sizes.length - 2] : sizes[0];
        var from = small ? small.url : p.processing ? sentSrc(p) : '';
        if (!from) return '';
        return scs.videoFrame(from).then(function (url) {
          p.frame = url;
          var at = wf.photos.indexOf(p);
          var m = at !== -1 && wf.media[at];
          if (m) {
            m.thumb = url;
            if (m.still) m.still = url;
          }
          return url;
        }, function () { return ''; });
      });
    };
  }

  function mediaOf(p) {
    // the still is what shows when the browser cannot play the file as sent
    // (an iPhone's HEVC in Firefox)
    if (p.processing) return { url: sentSrc(p), thumb: p.frame || thumbSrc(p), still: p.frame || thumbSrc(p), type: p.type, name: credit(p) };
    var item = { url: fullSrc(p), thumb: p.frame || thumbSrc(p), type: p.type, name: credit(p) };
    // a photo opens as its viewing copy and the whole picture takes its
    // place once it has loaded
    if (!isVideo(p) && !scs.animatedType(p.type)) item.full = wholeSrc(p);
    if (isVideo(p) && window.scsVideo) {
      var base = p.from === 'gallery' ? scs.fileUrl(p.key) : albumFile(p);
      item.sizes = window.scsVideo.sizes(p.heights, function (res) { return base + '&res=' + res; });
      item.url = item.sizes[0].url;
    }
    return item;
  }
  // Adds a page's items after the ones already in. Something added while
  // the album was being read moves the pages along by one, so an item
  // already in is not taken twice.
  function append(photos) {
    photos.forEach(function (p) {
      if (wf.seen[p.key]) return;
      wf.seen[p.key] = true;
      wf.photos.push(p);
      wf.media.push(mediaOf(p));
    });
  }
  function renderGrid(photos, next) {
    wf.round += 1;
    wf.photos = [];
    wf.media = [];
    wf.seen = {};
    wf.next = next;
    wf.fetching = null;
    append(photos);
    wf.ratios = [];
    wf.tiles = [];
    wf.placed = 0;
    wf.busy = false;
    gridEl.hidden = !photos.length;
    layout();
    paintFoot();
    more();
  }
  function pageUrl(from) {
    return API + '/api/album?' + where + (order ? '&order=' + order : '') + filterQuery() + '&n=' + PAGE + (from ? '&from=' + from : '');
  }
  // the next page on the end of the list; the viewer waits on it too
  function nextPage() {
    if (wf.next == null) return Promise.resolve();
    if (wf.fetching) return wf.fetching;
    var round = wf.round;
    wf.fetching = scs.fetch(pageUrl(wf.next), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('page'); return r.json(); })
      .then(function (data) {
        if (round !== wf.round) return;
        wf.fetching = null;
        wf.next = data.next;
        append(data.photos || []);
        paintFoot();
        if (nearEnd()) more();
      })
      .catch(function () {
        if (round !== wf.round) return;
        wf.fetching = null;
        paintFoot(true);
      });
    return wf.fetching;
  }

  // ---------- the order, and a photo's details ----------
  // The worker puts the album in either order, a page at a time: the
  // album's own until this device picks one for it.
  var orderPicked = {};
  try {
    var kept = JSON.parse(localStorage.getItem(ORDER_KEY) || '{}');
    if (kept && typeof kept === 'object') orderPicked = kept;
  } catch (err) { /* this visit only */ }
  var order = orderPicked[where] === 'taken' || orderPicked[where] === 'added' ? orderPicked[where] : '';
  function paintOrder() {
    Array.prototype.forEach.call(orderEl.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-order') === order ? 'true' : 'false');
    });
    placeSeg(orderEl);
  }
  // the block under the choice in use goes where that button is, as wide
  // as it is; the first time with no travel
  function placeSeg(group) {
    var on = group.querySelector('button[aria-pressed="true"]');
    if (!on || !on.offsetWidth) return;
    group.style.setProperty('--seg-x', on.offsetLeft + 'px');
    group.style.setProperty('--seg-w', on.offsetWidth + 'px');
  }
  function settleSegs() {
    placeSeg(orderEl);
    placeSeg(viewEl);
    placeSeg(modeEl);
    requestAnimationFrame(function () {
      orderEl.classList.remove('is-still');
      viewEl.classList.remove('is-still');
      modeEl.classList.remove('is-still');
    });
  }
  window.addEventListener('resize', function () { placeSeg(orderEl); placeSeg(viewEl); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { placeSeg(orderEl); placeSeg(viewEl); });

  // what the album holds, a figure and its word each
  var COUNT_ICONS = {
    photo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="2"/><circle cx="9" cy="9" r="1.75"/><path d="m20.5 15.5-5-5-11 10"/></svg>',
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M10.5 9.5v5l4-2.5z"/></svg>'
  };
  function paintCounts(stills, videos) {
    var box = $('alb-counts');
    box.textContent = '';
    [[stills, 'photo', 'photos'], [videos, 'video', 'videos']].forEach(function (c) {
      if (!c[0]) return;
      var item = el('span', 'alb-count-item');
      item.innerHTML = COUNT_ICONS[c[1]];
      item.appendChild(el('b', null, String(c[0])));
      item.appendChild(el('span', 'alb-count-word', c[0] === 1 ? c[1] : c[2]));
      box.appendChild(item);
    });
    box.hidden = !box.firstChild;
  }
  orderEl.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-order]');
    if (!b || b.getAttribute('data-order') === order) return;
    order = b.getAttribute('data-order');
    orderPicked[where] = order;
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(orderPicked)); } catch (err) { /* this visit only */ }
    paintOrder();
    showAlbum(true);
  });

  // waterfall or rows, kept on this device
  function paintView() {
    Array.prototype.forEach.call(viewEl.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-view') === view ? 'true' : 'false');
    });
    placeSeg(viewEl);
  }
  viewEl.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-view]');
    if (!b || b.getAttribute('data-view') === view) return;
    view = b.getAttribute('data-view');
    try { localStorage.setItem(VIEW_KEY, view); } catch (err) { /* this visit only */ }
    paintView();
    layout();
    if (nearEnd()) more();
  });

  var detailsCache = {};
  function detailsOf(p) {
    if (!p) return Promise.resolve(null);
    if (!detailsCache[p.key]) {
      detailsCache[p.key] = scs.fetch(API + '/api/albums/info?key=' + encodeURIComponent(p.key), { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error('details'); return r.json(); })
        .then(function (d) { return window.scsPhotoDetails.rows(d, isVideo(p)); });
      detailsCache[p.key].catch(function () { delete detailsCache[p.key]; });
    }
    return detailsCache[p.key];
  }

  // ---------- the slideshow (assets/slideshow.js) ----------
  // Every photo and video in the album, read in one list in the album's
  // order; a video still being encoded is left out.
  var questNames = null;
  function questName(code) {
    return (questNames && questNames[scs.normQuest(code)]) || '';
  }
  function loadQuestNames() {
    if (questNames) return;
    questNames = {};
    scs.questList().then(function (data) {
      (data.groups || []).forEach(function (g) {
        questNames[scs.normQuest(g.key)] = g.name;
        (g.codes || []).forEach(function (c) { questNames[scs.normQuest(c.code)] = g.name; });
      });
    }).catch(function () { /* the code alone */ });
  }
  function slideOf(p) {
    var m = mediaOf(p);
    return {
      type: p.type,
      alt: credit(p),
      photo: function () {
        return m.full && window.scsVideo && window.scsVideo.pref() === 'original' ? m.full : m.url;
      },
      video: function () { return m.sizes && window.scsVideo ? window.scsVideo.pick(m.sizes).url : m.url; },
      sizes: function () { return m.sizes || null; },
      plate: function () {
        return p.quest
          ? { code: p.quest, name: questName(p.quest), right: p.team || p.by || '' }
          : { name: p.via || (album && album.name) || '', right: p.team || p.by || '' };
      }
    };
  }
  function everyItem(from, got) {
    return scs.fetch(API + '/api/album?' + where + (order ? '&order=' + order : '') + filterQuery() + (from ? '&from=' + from : ''), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('album'); return r.json(); })
      .then(function (data) {
        got = got.concat(data.photos || []);
        return data.next != null && data.next > from ? everyItem(data.next, got) : got;
      });
  }
  showBtn.addEventListener('click', function () {
    if (showBtn.disabled) return;
    showBtn.disabled = true;
    loadQuestNames();
    everyItem(0, [])
      .then(function (items) {
        showBtn.disabled = false;
        var slides = items.map(slideOf);
        if (slides.length && window.scsSlideshow) window.scsSlideshow.start(slides);
      })
      .catch(function () {
        showBtn.disabled = false;
        if (window.scsToast) window.scsToast('Could not load the album for the slideshow.');
      });
  });

  // the newest read wins: a filter changed twice quickly asks twice
  var asking = 0;
  var albumTotal = 0;
  function showAlbum(reload) {
    if (!reload) loading(true);
    var ask = ++asking;
    return scs.fetch(pageUrl(0), { cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) throw new Error('missing');
        return r.json();
      })
      .then(function (data) {
        if (ask !== asking) return;
        if (!data || !data.ok) throw new Error('bad payload');
        loading(false);
        gridEl.classList.remove('is-waiting');
        album = data.album;
        order = data.order || order || 'added';
        titleEl.textContent = album.name;
        document.title = album.name + ' | SCS.2';
        aboutEl.textContent = album.about || '';
        aboutEl.hidden = !album.about;
        var count = data.count != null ? data.count : data.photos.length;
        var videos = data.videos != null ? data.videos : data.photos.filter(isVideo).length;
        if (data.people) setPeople(data.people);
        // the whole album, whoever the filter leaves out
        albumTotal = filter.names.length ? people.reduce(function (sum, p) { return sum + p.n; }, 0) : count;
        setStatusLine(count ? '' : !filter.names.length ? 'Nothing here yet.' :
          filter.mode === 'by' ? 'Nothing here from ' + listOf(filter.names.map(personLabel)) + '.' : 'Nothing here from anyone else.');
        paintCounts(count - videos, videos);
        paintFiltered();
        wf.total = count;
        orderEl.hidden = albumTotal < 2 || !album.details;
        viewEl.hidden = albumTotal < 2;
        whoBtn.hidden = people.length < 2 && !filter.names.length;
        filterEl.hidden = whoBtn.hidden;
        showBtn.hidden = !count;
        paintTools();
        paintOrder();
        paintView();
        settleSegs();
        renderGrid(data.photos, data.next == null ? null : data.next);
        if (!reload) setUpAdding();
      })
      .catch(function (err) {
        if (ask !== asking) return;
        gridEl.classList.remove('is-waiting');
        if (err && err.message === 'missing') {
          loading(false);
          titleEl.textContent = 'Albums';
          setStatusLine('There is no album at this address.');
          return;
        }
        loadFailed('Could not load the album.', function () { showAlbum(reload); });
      });
  }

  // ---------- adding ----------

  var turnstileId = null;
  function mountTurnstile(sitekey) {
    var slot = $('alb-turnstile');
    window.scsTurnstileReady = function () {
      try {
        turnstileId = window.turnstile.render(slot, { sitekey: sitekey, theme: 'auto', appearance: 'interaction-only' });
      } catch (err) { /* no token; the send says so */ }
    };
    if (window.turnstile) { window.scsTurnstileReady(); return; }
    scs.needScript('https://challenges.cloudflare.com/turnstile/v0/api.js?onload=scsTurnstileReady&render=explicit');
  }
  function turnstileToken() {
    if (!window.turnstile || turnstileId === null) return '';
    try { return window.turnstile.getResponse(turnstileId) || ''; } catch (err) { return ''; }
  }
  function resetTurnstile() {
    if (!window.turnstile || turnstileId === null) return;
    try { window.turnstile.reset(turnstileId); } catch (err) { /* a fresh token next send */ }
  }

  function paintTools() {
    toolsEl.hidden = orderEl.hidden && viewEl.hidden && whoBtn.hidden && addBtn.hidden && showBtn.hidden;
  }

  // A button opens what is under it: the filter, or the name, the check
  // and the picker for adding. One at a time.
  function openDrawer(box, body, btn, open, still) {
    if (still) box.classList.add('is-still');
    box.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) body.removeAttribute('inert'); else body.setAttribute('inert', '');
    if (still) {
      void box.offsetHeight;
      box.classList.remove('is-still');
    }
  }
  function openAdd(open, still) {
    if (open) openDrawer(filterEl, filterBodyEl, whoBtn, false);
    openDrawer(addEl, addBodyEl, addBtn, open, still);
  }
  function openFilter(open, still) {
    if (open) openDrawer(addEl, addBodyEl, addBtn, false);
    openDrawer(filterEl, filterBodyEl, whoBtn, open, still);
    if (open) placeSeg(modeEl);
  }
  addBtn.addEventListener('click', function () {
    openAdd(!addEl.classList.contains('is-open'));
  });
  whoBtn.addEventListener('click', function () {
    openFilter(!filterEl.classList.contains('is-open'));
  });
  [[addEl, openAdd, addBtn], [filterEl, openFilter, whoBtn]].forEach(function (d) {
    d[0].addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      d[1](false);
      d[2].focus();
    });
  });
  openAdd(false, true);
  openFilter(false, true);

  // ---------- whose photos ----------
  // Everyone the album credits, the most photos first, from the first
  // page of every read; a name the address carries that is not among
  // them is offered too, so it can be taken off.
  var people = [];
  var peopleSig = '';
  var FIND_FROM = 12;
  function personLabel(name) { return name || 'No name'; }
  function listOf(words) {
    if (words.length < 2) return words.join('');
    return words.slice(0, -1).join(', ') + ' and ' + words[words.length - 1];
  }
  function isPicked(name) {
    var k = nameKey(name);
    return filter.names.some(function (n) { return nameKey(n) === k; });
  }
  function offered() {
    var list = people.slice();
    filter.names.forEach(function (n) {
      if (!list.some(function (p) { return nameKey(p.name) === nameKey(n); })) list.push({ name: n, n: 0 });
    });
    return list;
  }
  function setPeople(list) {
    people = list.map(function (p) { return { name: String(p.name || ''), n: p.n || 0 }; });
    var sig = JSON.stringify(offered());
    if (sig === peopleSig) return;
    peopleSig = sig;
    paintPeople();
  }
  function paintPeople() {
    var list = offered();
    var q = nameKey(findEl.value);
    findField.hidden = list.length <= FIND_FROM;
    peopleEl.textContent = '';
    list.forEach(function (p) {
      if (q && nameKey(personLabel(p.name)).indexOf(q) === -1 && !isPicked(p.name)) return;
      var b = el('button', 'alb-person');
      b.type = 'button';
      b.setAttribute('data-name', p.name);
      b.setAttribute('aria-pressed', isPicked(p.name) ? 'true' : 'false');
      b.appendChild(el('span', 'alb-person-name', personLabel(p.name)));
      b.appendChild(el('span', 'alb-person-n', String(p.n)));
      peopleEl.appendChild(b);
    });
    if (!peopleEl.firstChild) peopleEl.appendChild(el('p', 'alb-people-none', 'No one by that name.'));
    paintFilterControls();
  }
  function paintFilterControls() {
    Array.prototype.forEach.call(peopleEl.querySelectorAll('.alb-person'), function (b) {
      b.setAttribute('aria-pressed', isPicked(b.getAttribute('data-name')) ? 'true' : 'false');
    });
    Array.prototype.forEach.call(modeEl.querySelectorAll('button'), function (b) {
      b.setAttribute('aria-pressed', b.getAttribute('data-mode') === filter.mode ? 'true' : 'false');
    });
    placeSeg(modeEl);
    clearBtn.hidden = !filter.names.length;
  }
  // under the counts: who the filter names, each taken off with a tap
  var CROSS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/></svg>';
  function paintFiltered() {
    filteredEl.textContent = '';
    filteredEl.hidden = !filter.names.length;
    if (!filter.names.length) return;
    filteredEl.appendChild(el('span', 'alb-filtered-word', filter.mode === 'by' ? 'Showing only' : 'Leaving out'));
    filter.names.forEach(function (n) {
      var tag = el('button', 'alb-tag');
      tag.type = 'button';
      tag.setAttribute('data-name', n);
      tag.setAttribute('aria-label', 'Remove ' + personLabel(n));
      tag.appendChild(el('span', 'alb-tag-name', personLabel(n)));
      tag.insertAdjacentHTML('beforeend', CROSS);
      filteredEl.appendChild(tag);
    });
    if (filter.names.length > 1) {
      var all = el('button', 'alb-text-btn', 'Clear');
      all.type = 'button';
      all.setAttribute('data-clear', '');
      filteredEl.appendChild(all);
    }
  }
  // the address follows the filter, so Back still leaves the album
  function writeAddress() {
    var q = new URLSearchParams(location.search);
    q.delete('by');
    q.delete('not');
    filter.names.forEach(function (n) { q.append(filter.mode, n); });
    var s = q.toString();
    try { history.replaceState(history.state, '', location.pathname + (s ? '?' + s : '') + location.hash); } catch (err) { /* the page still filters */ }
  }
  var filterTimer = 0;
  function filterChanged() {
    writeAddress();
    paintFilterControls();
    paintFiltered();
    clearTimeout(filterTimer);
    gridEl.classList.add('is-waiting');
    filterTimer = setTimeout(function () { showAlbum(true); }, 250);
  }
  function togglePerson(name) {
    if (isPicked(name)) {
      var k = nameKey(name);
      filter.names = filter.names.filter(function (n) { return nameKey(n) !== k; });
    } else {
      filter.names = oncePerName(filter.names.concat([name]));
    }
    filterChanged();
  }
  peopleEl.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.alb-person');
    if (b) togglePerson(b.getAttribute('data-name'));
  });
  filteredEl.addEventListener('click', function (e) {
    var t = e.target.closest && e.target.closest('.alb-tag, [data-clear]');
    if (!t) return;
    // the focus goes to the next name, or back to the button
    var after = t.nextElementSibling;
    var nextName = after && after.classList.contains('alb-tag') ? after.getAttribute('data-name') : null;
    if (t.hasAttribute('data-clear')) {
      filter.names = [];
      filterChanged();
    } else {
      togglePerson(t.getAttribute('data-name'));
    }
    var next = Array.prototype.filter.call(filteredEl.querySelectorAll('.alb-tag'), function (n) {
      return n.getAttribute('data-name') === nextName;
    })[0];
    (next || whoBtn).focus();
  });
  modeEl.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-mode]');
    if (!b || b.getAttribute('data-mode') === filter.mode) return;
    filter.mode = b.getAttribute('data-mode');
    if (filter.names.length) filterChanged(); else paintFilterControls();
  });
  clearBtn.addEventListener('click', function () {
    filter.names = [];
    filterChanged();
  });
  findEl.addEventListener('input', paintPeople);
  window.addEventListener('resize', function () { placeSeg(modeEl); });
  // the phone's own share sheet, otherwise the link on the clipboard
  shareBtn.addEventListener('click', function () {
    var link = location.href;
    if (navigator.share && handheld()) {
      navigator.share({ url: link }).catch(function () { /* closed without sharing */ });
      return;
    }
    var copied = function () { if (window.scsToast) window.scsToast('Link copied'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(link).then(copied, function () { window.prompt('Copy this link', link); });
    } else {
      window.prompt('Copy this link', link);
    }
  });

  function setUpAdding() {
    var open = !!album && album.adding !== 'closed';
    addEl.hidden = !open;
    addBtn.hidden = !open;
    paintTools();
    if (!open) return;
    if (album.adding === 'anyone') {
      $('alb-by-field').hidden = false;
      if (album.turnstile) mountTurnstile(album.turnstile);
    }
    showAddState();
    // an empty album has nothing to look at but the way to add
    if (!albumTotal) openAdd(true, true);
  }

  function showAddState() {
    var team = getSession() ? getTeam() : '';
    var needsTeam = album.adding === 'teams' && !getSession();
    loginEl.hidden = !needsTeam;
    pickerEl.hidden = needsTeam;
    var who = $('alb-who');
    who.textContent = '';
    if (team && !needsTeam) {
      var line = el('span', null, 'Adding as ');
      line.appendChild(el('strong', null, team));
      who.appendChild(line);
      var out = el('a', null, 'Sign out');
      out.href = '#';
      out.addEventListener('click', function (e) {
        e.preventDefault();
        // the team's verdicts stop coming to this device with it
        scs.pushSub.unlink();
        setSession('', '');
        showAddState();
      });
      who.appendChild(out);
    }
  }

  function doLogin() {
    var btn = $('alb-login-btn');
    var errEl = $('alb-login-error');
    var card = loginEl;
    scs.swapText(errEl, '');
    btn.disabled = true;
    btn.classList.add('is-busy');
    scs.postJson(API + '/api/submit/login', {
      team_name: $('alb-team').value,
      code: $('alb-code').value
    }).then(function (res) {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      if (res.status === 200 && res.data.session) {
        setSession(res.data.session, res.data.team);
        $('alb-code').value = '';
        showAddState();
        scs.rise(pickerEl);
      } else {
        scs.swapText(errEl, res.data.error || 'Could not sign in.');
        scs.shake(card);
      }
    }).catch(function () {
      btn.disabled = false;
      btn.classList.remove('is-busy');
      scs.swapText(errEl, 'Could not reach the tab. Try again.');
      scs.shake(card);
    });
  }

  // The small copy, the viewing copy and the size of each picture are
  // made here, the way the submit page makes them, so the album never
  // loads a full photo and can lay a tile out before it has loaded.
  function drawScaled(source, w, h, edge, quality) {
    return new Promise(function (resolve) {
      var scale = Math.min(1, edge / Math.max(w, h));
      var canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(function (blob) {
        // a phone holds only so many canvases at once
        canvas.width = 0;
        canvas.height = 0;
        resolve(blob || null);
      }, 'image/jpeg', quality);
    });
  }
  function photoCopies(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth;
        var h = img.naturalHeight;
        if (scs.animatedType(file.type)) {
          URL.revokeObjectURL(url);
          return resolve({ w: w, h: h });
        }
        drawScaled(img, w, h, THUMB_EDGE, 0.72).then(function (thumb) {
          return drawScaled(img, w, h, VIEW_EDGE, 0.8).then(function (view) {
            URL.revokeObjectURL(url);
            resolve({ thumb: thumb, view: view && view.size <= VIEW_MAX ? view : null, w: w, h: h });
          });
        }).catch(function () { URL.revokeObjectURL(url); resolve({ w: w, h: h }); });
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve({}); };
      img.src = url;
    });
  }
  // a frame from early in the video, and its size
  function videoCopies(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var video = document.createElement('video');
      var settled = false;
      function finish(out) {
        if (settled) return;
        settled = true;
        URL.revokeObjectURL(url);
        resolve(out);
      }
      var timer = window.setTimeout(function () { finish({}); }, 4000);
      video.muted = true;
      video.playsInline = true;
      video.preload = 'auto';
      video.addEventListener('loadeddata', function () {
        try { video.currentTime = Math.min(0.1, video.duration || 0.1); } catch (err) { /* draw where it is */ }
        window.setTimeout(function () {
          var w = video.videoWidth;
          var h = video.videoHeight;
          if (!w) { window.clearTimeout(timer); return finish({}); }
          drawScaled(video, w, h, THUMB_EDGE, 0.72).then(function (thumb) {
            window.clearTimeout(timer);
            finish({ thumb: thumb, w: w, h: h });
          });
        }, 250);
      });
      video.addEventListener('error', function () { window.clearTimeout(timer); finish({}); });
      video.src = url;
    });
  }
  function isVideoFile(f) { return String(f.type || '').toLowerCase().indexOf('video/') === 0; }
  function copiesOf(file) { return isVideoFile(file) ? videoCopies(file) : photoCopies(file); }

  // ---------- adding: one file to a request ----------
  // Each picked file is prepared and sent on its own, two at a time, with
  // a row showing how far it has got. A photo is decoded only when its
  // turn comes.
  var AT_ONCE = 2;
  var queueEl = el('ul', 'alb-queue');
  queueEl.hidden = true;
  progressEl.parentNode.insertBefore(queueEl, progressEl);
  var jobs = [];
  var pass = '';          // handed back after the person check; lets the rest of a pick through
  var hiddenTeam = false; // the worker said what this team adds is for organisers only

  function setRow(job, state, share) {
    job.stateEl.textContent = state;
    job.bar.style.width = Math.round(Math.max(0, Math.min(1, share || 0)) * 100) + '%';
  }

  function addJob(file) {
    var row = el('li', 'alb-q-row');
    var pic = el('span', 'alb-q-pic');
    var text = el('span', 'alb-q-text');
    text.appendChild(el('span', 'alb-q-name', file.name));
    var stateEl = el('span', 'alb-q-state', 'Waiting');
    text.appendChild(stateEl);
    var track = el('span', 'sub-progress');
    var bar = el('span', 'alb-q-bar');
    track.appendChild(bar);
    row.appendChild(pic);
    row.appendChild(text);
    row.appendChild(track);
    queueEl.appendChild(row);
    queueEl.hidden = false;
    var job = { file: file, row: row, pic: pic, text: text, stateEl: stateEl, bar: bar, state: 'waiting' };
    jobs.push(job);
    return job;
  }

  function failJob(job, line) {
    job.state = 'failed';
    job.row.classList.add('is-failed');
    setRow(job, line || 'That did not go through.', 1);
    var again = el('button', 'alb-q-retry', 'Try again');
    again.type = 'button';
    again.addEventListener('click', function () {
      again.remove();
      job.row.classList.remove('is-failed');
      job.state = 'waiting';
      setRow(job, 'Waiting', 0);
      pump();
    });
    job.text.appendChild(again);
  }

  // A request that never arrived, or found the worker busy, is tried
  // again four times before the row says it failed; the last two waits
  // outlast a minute of the server turning requests away.
  var SEND_WAITS = [1500, 3000, 20000, 40000];
  function postForm(form, onProgress, onRetry, tries) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', API + '/api/album/upload');
      var token = getSession();
      if (token) xhr.setRequestHeader('authorization', 'Bearer ' + token);
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = function () {
        var data = {};
        try { data = JSON.parse(xhr.responseText); } catch (err) { /* not JSON */ }
        resolve({ status: xhr.status, data: data });
      };
      xhr.onerror = function () { resolve({ status: 0, data: {} }); };
      xhr.send(form);
    }).then(function (res) {
      var again = res.status === 0 || res.status === 502 || res.status === 503 || res.status === 504;
      if (!again || (tries || 0) >= SEND_WAITS.length) return res;
      onRetry();
      return new Promise(function (wait) { window.setTimeout(wait, SEND_WAITS[tries || 0]); })
        .then(function () { return postForm(form, onProgress, onRetry, (tries || 0) + 1); });
    });
  }

  function sendJob(job, file, c) {
    var big = direct || file.size > MAX_FILE_BYTES;
    var form = new FormData();
    form.append(linkKey ? 'k' : 'a', linkKey || slug);
    if (direct) form.append('whole', '1');
    // the HEIC or WebP the JPEG was made from goes up beside it
    var twin = job.picked && job.picked.size <= MAX_FILE_BYTES ? job.picked : null;
    var twinType = twin ? scs.pickedType(twin) : '';
    if (big) {
      if (c.thumb) form.append('bigthumb0', c.thumb, 'thumb.jpg');
      if (c.view) form.append('bigview0', c.view, 'view.jpg');
      var entry = { name: file.name, type: file.type, size: file.size, w: c.w || 0, h: c.h || 0 };
      if (twin && direct) entry.picked = { type: twinType, size: twin.size };
      else if (twin) form.append('bigpicked0', twin.slice(0, twin.size, twinType), twin.name);
      form.append('bigfiles', JSON.stringify([entry]));
    } else {
      form.append('files', file, file.name);
      if (c.thumb) form.append('thumb0', c.thumb, 'thumb.jpg');
      if (c.view) form.append('view0', c.view, 'view.jpg');
      if (c.w) form.append('w0', String(c.w));
      if (c.h) form.append('h0', String(c.h));
      if (twin) form.append('picked0', twin.slice(0, twin.size, twinType), twin.name);
    }
    var usedPass = '';
    if (album.adding === 'anyone') {
      form.append('by', $('alb-by').value);
      if (pass) { usedPass = pass; form.append('pass', pass); } else form.append('turnstile', turnstileToken());
    }
    return postForm(form, function (share) {
      setRow(job, 'Sending ' + Math.round(share * 100) + '%', big ? 0.02 : share * 0.97);
    }, function () {
      setRow(job, 'Trying again', 0);
    }).then(function (res) {
      if (res.status === 401) { setSession('', ''); showAddState(); }
      if (res.status !== 200 || !res.data.ok) {
        // a check's token is good once, and a pass that has run out is
        // no good: the next try waits for a fresh check
        if (album.adding === 'anyone' && (!usedPass || usedPass === pass)) { pass = ''; resetTurnstile(); }
        throw { line: res.data.error || (res.status ? 'That did not go through.' : 'Could not reach the tab.') };
      }
      if (res.data.pass && !pass) { pass = res.data.pass; resetTurnstile(); }
      if (res.data.hidden_team) hiddenTeam = true;
      var u = (res.data.uploads || [])[0];
      if (!u) return;
      return sendSlices(u, file, function (share) { setRow(job, 'Sending ' + Math.round(share * 100) + '%', share * 0.97); },
        u.direct && u.picked ? twin : null);
    });
  }

  // without a pass, the check's widget has to have a token to send
  function tokenReady() {
    if (album.adding !== 'anyone' || !album.turnstile || pass) return Promise.resolve();
    return new Promise(function (resolve) {
      var waited = 0;
      (function look() {
        if (pass || turnstileToken() || waited >= 30000) return resolve();
        waited += 300;
        window.setTimeout(look, 300);
      })();
    });
  }

  function runJob(job) {
    job.state = 'running';
    setRow(job, 'Preparing', 0);
    var converting = scs.needsConverting(job.file);
    var ready = converting ? scs.toJpeg(job.file).catch(function () { return null; }) : Promise.resolve(job.file);
    return ready.then(function (file) {
      if (!file) throw { line: 'Could not read this photo.' };
      // kept for a try again, which starts from the JPEG
      if (converting && scs.pickedType(job.file)) job.picked = job.file;
      job.file = file;
      return copiesOf(file).then(function (c) {
        if (c.thumb && !job.pic.firstChild) {
          var im = document.createElement('img');
          im.alt = '';
          im.src = URL.createObjectURL(c.thumb);
          job.pic.appendChild(im);
        }
        return tokenReady().then(function () { return sendJob(job, file, c); });
      });
    }).then(function () {
      job.state = 'done';
      job.row.classList.add('is-done');
      setRow(job, isVideoFile(job.file) ? 'Added, processing' : 'Added', 1);
    }, function (err) {
      failJob(job, err && err.line);
    });
  }

  function pump() {
    var running = jobs.filter(function (j) { return j.state === 'running'; }).length;
    // until the person check has been passed once, one at a time
    var limit = album.adding === 'anyone' && album.turnstile && !pass ? 1 : AT_ONCE;
    var waiting = jobs.filter(function (j) { return j.state === 'waiting'; });
    while (running < limit && waiting.length) {
      running += 1;
      runJob(waiting.shift()).then(pump);
    }
    if (!running && !waiting.length) drained();
  }

  // Everything picked has been tried: what went in leaves the list for
  // the album, and what did not stays with a way to try it again.
  function drained() {
    var added = jobs.filter(function (j) { return j.state === 'done'; });
    var failed = jobs.filter(function (j) { return j.state === 'failed'; });
    if (!added.length && !failed.length) return;
    var stills = added.filter(function (j) { return !isVideoFile(j.file); }).length;
    var videos = added.length - stills;
    if (added.length) window.scsToast('Added ' + countWords(stills, videos) + '.');
    var lines = [];
    if (failed.length) lines.push(plural(failed.length, 'file', 'files') + ' did not go through.');
    if (hiddenTeam) lines.push('Your team is hidden, so what it adds is shown to organisers only.');
    progressEl.textContent = lines.join(' ');
    added.forEach(function (j) {
      var im = j.pic.firstChild;
      if (im) URL.revokeObjectURL(im.src);
      j.row.remove();
    });
    jobs = failed;
    queueEl.hidden = !jobs.length;
    filesInput.value = '';
    if (!added.length) return;
    if (viewing) readAfterViewer = true;
    else showAlbum(true);
  }

  // Nothing added is kept until it has gone up, so a link that would
  // leave the page asks first.
  if (scs.guardLeaving) {
    scs.guardLeaving(function () {
      var going = jobs.some(function (j) { return j.state === 'running' || j.state === 'waiting'; });
      return going ? 'A file is still being added to this album.' : '';
    });
  }

  function addFiles(picked) {
    if (!picked.length) return;
    var bad = picked.filter(function (f) {
      return !scs.needsConverting(f) && !isVideoFile(f) && PHOTO_TYPES.indexOf(String(f.type).toLowerCase()) === -1;
    });
    if (bad.length) {
      progressEl.textContent = bad[0].name + ' is not a photo or a video.';
      return;
    }
    var tooBig = picked.filter(function (f) { return f.size > MAX_BIG_BYTES; });
    if (tooBig.length) {
      progressEl.textContent = tooBig[0].name + ' is over 4GB.';
      return;
    }
    progressEl.textContent = '';
    picked.forEach(addJob);
    pump();
  }

  // A file over 25MB, or any file when it goes straight to R2: its bytes
  // a slice at a time, with the token its upload handed back.
  // onProgress hears the share sent so far. twin, going straight to R2
  // as well, is the file the photo was picked as, sent whole before the
  // finish reads it; one that does not get there leaves the photo
  // without it.
  function sendSlices(u, file, onProgress, twin) {
    var parts = Math.max(1, Math.ceil(u.size / u.part_size));
    var q = '?file=' + u.file + '&token=' + encodeURIComponent(u.token);
    function give(up) {
      return fetch(API + '/api/album/upload/abort', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: u.file, token: u.token })
      }).catch(function () {}).then(function () { throw up; });
    }
    // a slice straight to R2 goes to an address the worker signs for it,
    // asked for on every try so a late retry is not turned away as expired
    function where(n) {
      if (!u.direct) return Promise.resolve(API + '/api/album/upload/part' + q + '&n=' + n);
      return scs.fetch(API + '/api/album/upload/sign' + q + '&n=' + n, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('slice ' + n);
        return r.json();
      }).then(function (d) { return d.url; });
    }
    function put(n, blob) {
      return where(n).then(function (url) { return send(n, url, blob); });
    }
    function send(n, url, blob) {
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', url);
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) onProgress((n - 1 + e.loaded / e.total) / parts);
        };
        xhr.onload = function () { if (xhr.status === 200) resolve(); else reject(new Error('slice ' + n)); };
        xhr.onerror = function () { reject(new Error('slice ' + n)); };
        xhr.send(blob);
      });
    }
    function part(n, tries) {
      var blob = file.slice((n - 1) * u.part_size, Math.min(n * u.part_size, u.size), u.direct ? '' : file.type);
      return put(n, blob).catch(function (err) {
        if (tries >= SEND_WAITS.length) throw err;
        return new Promise(function (res) { window.setTimeout(res, SEND_WAITS[tries]); })
          .then(function () { return part(n, tries + 1); });
      });
    }
    function sendTwin(tries) {
      if (!twin) return Promise.resolve();
      return scs.fetch(API + '/api/album/upload/sign' + q + '&picked=1', { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('picked');
        return r.json();
      }).then(function (d) {
        return fetch(d.url, { method: 'PUT', body: twin.slice(0, twin.size, '') });
      }).then(function (r) {
        if (!r.ok) throw new Error('picked');
      }).catch(function () {
        if (tries >= 2) return;
        return new Promise(function (res) { window.setTimeout(res, 1500 * (tries + 1)); })
          .then(function () { return sendTwin(tries + 1); });
      });
    }
    var n = 0;
    function next() {
      n += 1;
      if (n > parts) {
        return sendTwin(0).then(function () {
          return scs.postJson(API + '/api/album/upload/finish', { file: u.file, token: u.token });
        }).then(function (res) {
          if (res.status !== 200 || !res.data.ok) throw { line: res.data.error || 'That did not go through.' };
        });
      }
      onProgress((n - 1) / parts);
      return part(n, 0).then(next);
    }
    return next().catch(function (err) {
      return give(err && err.line ? err : { line: 'Could not send it. Check the connection.' });
    });
  }

  $('alb-login-btn').addEventListener('click', doLogin);
  $('alb-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  // a computer can drop files anywhere on an album as well as choose them
  function carriesFiles(e) {
    return !!(e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') !== -1);
  }
  function takesDrops(e) {
    return carriesFiles(e) && !!album && !addEl.hidden;
  }
  var dragDepth = 0;
  document.addEventListener('dragenter', function (e) {
    if (!takesDrops(e)) return;
    dragDepth++;
    openAdd(true);
    if (!pickerEl.hidden) pickerEl.classList.add('is-dropping');
  });
  document.addEventListener('dragover', function (e) {
    if (takesDrops(e)) e.preventDefault();
  });
  document.addEventListener('dragleave', function (e) {
    if (!takesDrops(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) pickerEl.classList.remove('is-dropping');
  });
  document.addEventListener('drop', function (e) {
    if (!takesDrops(e)) return;
    e.preventDefault();
    dragDepth = 0;
    pickerEl.classList.remove('is-dropping');
    if (pickerEl.hidden || !readyToAdd()) return;
    addFiles(Array.prototype.slice.call(e.dataTransfer.files || []));
  });
  function readyToAdd() {
    if (album && album.adding === 'anyone' && album.turnstile && !pass && !turnstileToken()) {
      progressEl.textContent = 'Wait for the check above to finish, then add yours.';
      return false;
    }
    return true;
  }
  pickBtn.addEventListener('click', function () {
    if (!readyToAdd()) {
      return;
    }
    filesInput.click();
  });
  filesInput.addEventListener('change', function () {
    addFiles(Array.prototype.slice.call(filesInput.files || []));
  });
  document.addEventListener('scs-session-changed', function () { if (album) showAddState(); });

  if (slug || linkKey || viewPass) showAlbum(false); else showList();
})();
