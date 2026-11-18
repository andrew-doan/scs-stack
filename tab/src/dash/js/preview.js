// A proof file as the dashboard shows it: its address and small copy,
// the tile for a GPX track or a PDF, a submission's files as a grid, and
// the full-size preview over the page.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, copyLink = dash.copyLink, fill = dash.fill, fmtTime = dash.fmtTime,
    h = dash.h, SITE = dash.SITE, toast = dash.toast;
  // uploads.js
  var sizeText = dash.sizeText;

  dash.fileUrl = fileUrl;
  dash.animatedType = animatedType;
  dash.thumbUrl = thumbUrl;
  dash.reviewMedia = reviewMedia;
  dash.fileActions = fileActions;
  dash.openPreview = openPreview;

  function fileUrl(key) { return '/api/console/file?key=' + encodeURIComponent(key); }
  // a GIF is asked for whole: the only still of one is its first frame
  function animatedType(type) {
    return String(type || '').toLowerCase().split(';')[0].trim() === 'image/gif';
  }
  function thumbUrl(key, type) {
    return fileUrl(key) + (animatedType(type) ? '' : '&thumb=1');
  }

  // A GPX track or a PDF sent as proof has no picture to show: a track
  // is drawn from its points, which the worker reads (file/track), with
  // how far it goes and when, and its name downloads it; a PDF is its
  // name, which opens the original. Null for a photo or a video.
  function docTile(f) {
    var type = String(f.type || '').toLowerCase();
    if (type === 'application/gpx+xml') return trackTile(f);
    if (type !== 'application/pdf') return null;
    var box = h('div', 'review-doc');
    box.appendChild(h('span', 'review-doc-kind', 'PDF'));
    var link = h('a', 'review-doc-name', f.name);
    link.href = fileUrl(f.key);
    link.target = '_blank';
    link.rel = 'noopener';
    box.appendChild(link);
    box.appendChild(h('span', 'review-doc-facts', sizeText(f.bytes)));
    return box;
  }
  function trackTile(f) {
    var box = h('div', 'review-doc');
    box.appendChild(h('span', 'review-doc-kind', 'GPX track'));
    var art = h('div');
    box.appendChild(art);
    var link = h('a', 'review-doc-name', f.name);
    link.href = fileUrl(f.key) + '&download=1';
    link.setAttribute('download', '');
    box.appendChild(link);
    var facts = h('span', 'review-doc-facts', f.uploading ? 'Still uploading' : 'Reading the track…');
    box.appendChild(facts);
    if (f.uploading) return box;
    api('/api/console/file/track?key=' + encodeURIComponent(f.key)).then(function (d) {
      if (!d || !d.ok || !d.points) { facts.textContent = (d && d.error) || 'No points could be read.'; return; }
      art.appendChild(trackDrawing(d.line));
      var said = [distanceText(d.distance_m)];
      if (d.started) said.push(trackWhen(d.started, d.ended));
      facts.textContent = said.join(' · ');
    }).catch(function () { facts.textContent = 'No points could be read.'; });
    return box;
  }
  function distanceText(m) {
    return m >= 1000 ? (Math.round(m / 100) / 10) + ' km' : Math.round(m) + ' m';
  }
  // when a track ran: the start with its day, the end as a time on the same day
  function trackWhen(started, ended) {
    var text = fmtTime(started);
    if (!ended || ended === started) return text;
    var from = new Date(started.replace(' ', 'T') + 'Z');
    var to = new Date(ended.replace(' ', 'T') + 'Z');
    if (from.toDateString() !== to.toDateString()) return text + ' to ' + fmtTime(ended);
    return text + ' to ' + to.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  // [lat, lng] pairs drawn to fit the box, a degree of longitude
  // narrowed to its width at that latitude, north up, a dot at the start
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function trackDrawing(line) {
    var W = 160, H = 110, PAD = 8;
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('class', 'review-track-svg');
    svg.setAttribute('aria-hidden', 'true');
    if (!line || !line.length) return svg;
    var lat = line.reduce(function (sum, p) { return sum + p[0]; }, 0) / line.length;
    var narrow = Math.cos(lat * Math.PI / 180);
    var xs = line.map(function (p) { return p[1] * narrow; });
    var ys = line.map(function (p) { return p[0]; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);
    var scale = Math.min((W - 2 * PAD) / ((maxX - minX) || 1e-9), (H - 2 * PAD) / ((maxY - minY) || 1e-9));
    var left = (W - (maxX - minX) * scale) / 2;
    var top = (H - (maxY - minY) * scale) / 2;
    var points = line.map(function (p, i) {
      return [(left + (xs[i] - minX) * scale).toFixed(1), (H - top - (ys[i] - minY) * scale).toFixed(1)];
    });
    var path = document.createElementNS(SVG_NS, 'polyline');
    path.setAttribute('points', points.map(function (p) { return p.join(','); }).join(' '));
    svg.appendChild(path);
    var start = document.createElementNS(SVG_NS, 'circle');
    start.setAttribute('cx', points[0][0]);
    start.setAttribute('cy', points[0][1]);
    start.setAttribute('r', '3');
    svg.appendChild(start);
    return svg;
  }

  // A submission's files as the review list draws them: the small copy
  // of each, a click opening it over the page.
  function reviewMedia(files) {
    var media = h('div', 'review-media');
    files.forEach(function (f) {
      var node;
      var tag = null;
      if (f.encoding) tag = h('span', 'review-flag', 'Encoding');
      else if (f.skipped) tag = h('span', 'review-flag', 'Gave up');
      else if (f.renditions && f.renditions.length) {
        tag = h('span', 'review-flag res-flag', f.renditions.map(function (n) { return n + 'p'; }).join(' · '));
      }
      var doc = docTile(f);
      if (doc) {
        node = doc;
      } else if (f.uploading) {
        // registered at submit time, slices still on their way up;
        // the preview (made before the upload began) already shows
        node = h('span', 'review-up');
        var im = h('img'); im.loading = 'lazy'; im.src = thumbUrl(f.key, f.type);
        im.addEventListener('error', function () { im.classList.add('is-hidden'); });
        node.appendChild(im);
        node.appendChild(h('span', 'review-up-tag', 'still uploading · ' + Math.max(1, Math.round(f.bytes / (1024 * 1024))) + ' MB'));
      } else if (f.type.indexOf('video/') === 0) {
        // A still from the video, and the video plays in the preview.
        // A video element per card had Firefox on a Mac flickering
        // with several HDR videos on screen at once.
        node = h('button', 'review-video');
        node.type = 'button';
        node.setAttribute('aria-label', 'Play ' + f.name);
        var still = h('img'); still.loading = 'lazy'; still.alt = '';
        still.src = thumbUrl(f.key, f.type);
        still.addEventListener('error', function () { still.classList.add('is-hidden'); });
        node.appendChild(still);
        node.appendChild(h('span', 'review-play'));
        // the 720p copy where there is one; the fallback chain
        // hands back the original where there is not
        node.addEventListener('click', function () { openPreview(fileUrl(f.key) + '&res=1080', f.name, null, true, fileActions(f.key, f.name, f.renditions || [])); });
      } else {
        // the grid shows the small copy; a click previews the
        // photo's viewing copy over the page (the chain serves
        // the original when there is none)
        node = h('img'); node.loading = 'lazy';
        node.src = thumbUrl(f.key, f.type);
        node.addEventListener('click', function () { openPreview(fileUrl(f.key) + (animatedType(f.type) ? '' : '&res=1080'), f.name, f.key, false, fileActions(f.key, f.name, null, f.picked)); });
      }
      node.title = f.name + ' (' + Math.round(f.bytes / 1024) + ' KB)';
      media.appendChild(node);
      if (tag) media.appendChild(tag);
    });
    return media;
  }

  // ---- full-size preview over the page ----
  // What the photo says about itself: where it was taken, on what, and
  // whether it has been written to since. The site serves the copy
  // with all of this removed, so this panel is the only place it is
  // read — and it is read from the few-KB block the worker took off
  // the picture, not from the picture.
  //
  // None of it is proof. Anyone who knows to strip a file before
  // uploading defeats all of it. What it catches is what happens: a
  // screenshot of someone else's photo arrives with no camera data at
  // all, and that is very visible.
  function metaPanel(key) {
    var box = h('div', 'preview-meta');
    box.appendChild(h('p', 'preview-meta-line muted', 'Reading the photo’s details…'));
    api('/api/console/file/meta?key=' + encodeURIComponent(key)).then(function (d) {
      fill(box, []);
      if (!d || !d.ok) {
        box.appendChild(h('p', 'preview-meta-line muted', 'No details could be read.'));
        return;
      }
      var verdict = h('p', 'preview-verdict', d.verdict);
      if (d.verdict !== 'camera original') verdict.classList.add('is-off');
      box.appendChild(verdict);
      var rows = [];
      if (d.taken_at) rows.push(['Taken', d.taken_at + ' (the camera’s own clock)']);
      if (d.make || d.model) rows.push(['Camera', (d.make + ' ' + d.model).trim()]);
      if (d.lens) rows.push(['Lens', d.lens]);
      if (d.software) rows.push(['Software', d.software]);
      if (d.modified_at && d.modified_at !== d.taken_at) rows.push(['Last written', d.modified_at]);
      rows.forEach(function (r) {
        var line = h('p', 'preview-meta-line');
        line.appendChild(h('span', 'preview-meta-label', r[0]));
        line.appendChild(h('span', null, r[1]));
        box.appendChild(line);
      });
      if (d.gps) {
        var where = h('p', 'preview-meta-line');
        where.appendChild(h('span', 'preview-meta-label', 'Where'));
        var link = h('a', null, d.gps.lat.toFixed(6) + ', ' + d.gps.lng.toFixed(6));
        link.href = 'https://www.openstreetmap.org/?mlat=' + d.gps.lat + '&mlon=' + d.gps.lng + '#map=17/' + d.gps.lat + '/' + d.gps.lng;
        link.target = '_blank';
        link.rel = 'noreferrer';
        where.appendChild(link);
        box.appendChild(where);
      } else if (d.has_exif) {
        box.appendChild(h('p', 'preview-meta-line muted', 'No location recorded.'));
      }
      (d.signals || []).forEach(function (text) {
        box.appendChild(h('p', 'preview-meta-line muted', text));
      });
    }).catch(function () {
      fill(box, [h('p', 'preview-meta-line muted', 'No details could be read.')]);
    });
    return box;
  }

  // Saving a file and a link to it, for the full-screen preview: the
  // download is the original; the link is the public one, which serves
  // it with its metadata cut to anyone who has it and shows as the picture when
  // pasted into Discord, since it ends in the file's name.
  var PUBLIC_FILES = document.body.getAttribute('data-files') || location.origin;
  // What the preview offers for a file: Download, Copy link and, for a
  // video (heights: the copies the encoder made), its sizes. A video's
  // link is a page with a player on it; a photo's is the photo. picked is
  // the type of the HEIC or WebP a photo was picked as, offered as a
  // second download: proof's from the dashboard's own file route, an
  // album upload's from the album's, which hands it out only where the
  // album shows details.
  // ver: how many times an album photo has been replaced in place.
  var PICKED_NAMES = { 'image/heic': 'HEIC', 'image/heif': 'HEIF', 'image/webp': 'WebP', 'image/png': 'PNG' };
  function fileActions(key, name, heights, picked, ver) {
    var album = key.indexOf('alb/') === 0;
    var path = key.split('/').map(encodeURIComponent).join('/') + '/' + encodeURIComponent(name || 'file');
    var v = album && ver ? 'v=' + ver : '';
    var file = album ? '/api/albums/file?key=' + encodeURIComponent(key) + (v ? '&' + v : '') : fileUrl(key);
    return {
      download: file + '&download=1',
      picked: picked ? file + '&picked=1' : '',
      pickedName: PICKED_NAMES[picked] || 'file',
      share: PUBLIC_FILES + (heights ? '/view/' : album ? '/api/albums/file/' : '/api/submit/file/') + path + (v && !heights ? '?' + v : ''),
      heights: heights,
      sizeUrl: function (res) { return file + '&res=' + res; }
    };
  }

  // The site's video player script (video-sizes.js): Auto and the menu
  // of sizes. Without it a video plays its largest copy.
  var videoLib = null;
  function videoSizesLib() {
    if (window.scsVideo) return Promise.resolve(window.scsVideo);
    if (!videoLib) {
      videoLib = new Promise(function (resolve) {
        var tag = h('script');
        tag.src = SITE + '/assets/video-sizes.js';
        tag.onload = function () { resolve(window.scsVideo || null); };
        tag.onerror = function () { videoLib = null; resolve(null); };
        document.head.appendChild(tag);
      });
    }
    return videoLib;
  }

  function openPreview(src, name, key, isVideo, actions) {
    var overlay = h('div', 'preview-overlay');
    var media;
    if (isVideo) {
      media = h('video');
      media.controls = true;
      media.autoplay = true;
      media.playsInline = true;
      // the controls are pressed, not a click to close
      media.addEventListener('click', function (e) { e.stopPropagation(); });
    } else {
      media = h('img');
      media.alt = name || '';
    }
    var sizer = null;
    var shut = false;
    var bar = null;
    if (isVideo && actions && actions.heights && actions.heights.length) {
      videoSizesLib().then(function (lib) {
        if (shut) return;
        if (!lib) { media.src = src; return; }
        sizer = lib.play(media, lib.sizes(actions.heights, actions.sizeUrl), {
          control: true, className: 'preview-size', note: function (text) { toast(text, true); }
        });
        if (sizer.control && bar) bar.insertBefore(sizer.control, bar.firstChild);
      });
    } else {
      media.src = src;
    }
    overlay.appendChild(media);
    if (name) overlay.appendChild(h('p', 'preview-name', name));
    if (actions) {
      bar = h('div', 'preview-actions');
      var save = h('a', 'preview-action', actions.picked ? 'Download JPEG' : 'Download');
      save.href = actions.download;
      save.setAttribute('download', '');
      bar.appendChild(save);
      if (actions.picked) {
        var twin = h('a', 'preview-action', actions.pickedName === 'PNG' ? 'Download PNG' : 'Download original (' + actions.pickedName + ')');
        twin.href = actions.picked;
        twin.setAttribute('download', '');
        bar.appendChild(twin);
      }
      bar.appendChild(btn('Copy link', 'preview-action', function () { copyLink(actions.share); }));
      // pressing these is not dismissing the preview
      bar.addEventListener('click', function (e) { e.stopPropagation(); });
      overlay.appendChild(bar);
    }
    if (key) {
      var panel = metaPanel(key);
      // a click inside the panel is reading it, not dismissing
      panel.addEventListener('click', function (e) { e.stopPropagation(); });
      overlay.appendChild(panel);
    }
    function dismiss() {
      shut = true;
      if (sizer) sizer.destroy();
      if (isVideo) { media.pause(); media.removeAttribute('src'); media.load(); }
      overlay.remove();
      document.removeEventListener('keydown', onKey);
    }
    function onKey(e) { if (e.key === 'Escape') dismiss(); }
    overlay.addEventListener('click', dismiss);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
  }
})(window.dash);
