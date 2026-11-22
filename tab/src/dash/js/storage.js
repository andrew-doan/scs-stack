// The Settings tab's Storage card: every object in the bucket, sorted
// by what it is, and the database.
(function (dash) {
  // core.js
  var api = dash.api, busy = dash.busy, el = dash.el, h = dash.h, statCard = dash.statCard;

  // ---- Storage: every object in the bucket, sorted by the worker into
  // an area and a kind, a few thousand a request; the page keeps asking
  // with the cursor and adds the answers up ----
  var STORE_AREAS = [
    ['proof', 'Proof from teams'], ['albums', 'Albums'], ['messages', 'Message attachments'], ['quests', 'Quest files'],
    ['slides', 'Home page slideshow'], ['files', 'Files tab'], ['routes', 'Routes tab'], ['phone', 'Phone messages'], ['other', 'Elsewhere in the bucket']
  ];
  var STORE_KINDS = [
    ['photo', 'Photos as sent'], ['video', 'Videos as sent'], ['other', 'Other files as sent'],
    ['picked', 'Photos as picked (HEIC, WebP)'], ['clean', 'Videos at full size, metadata removed'],
    ['view', 'Viewing copies of photos'], ['thumb', 'Thumbnails and video stills'], ['meta', 'Metadata blocks'],
    ['oldclean', 'Old cleaned photo copies'], ['staged', 'Uploads not saved yet'], ['unlinked', 'Not linked to anything']
  ];
  var STORE_TYPES = {
    'image/jpeg': 'JPEG', 'image/png': 'PNG', 'image/gif': 'GIF', 'image/heic': 'HEIC', 'image/heif': 'HEIF',
    'image/webp': 'WebP', 'image/avif': 'AVIF', 'video/mp4': 'MP4', 'video/quicktime': 'MOV', 'video/webm': 'WebM',
    'application/gpx+xml': 'GPX', 'application/pdf': 'PDF'
  };
  function storeSize(n) {
    n = n || 0;
    if (n >= 1073741824) return (Math.round(n / 1073741824 * 100) / 100) + '\u00a0GB';
    if (n >= 1048576) return (Math.round(n / 1048576 * 10) / 10) + '\u00a0MB';
    if (n >= 1024) return Math.round(n / 1024) + '\u00a0KB';
    return n + '\u00a0bytes';
  }
  function storeShare(n, total) {
    if (!total || !n) return '0%';
    var pct = Math.round(n / total * 1000) / 10;
    return pct < 0.1 ? 'under 0.1%' : pct + '%';
  }
  function storeCount(n) { return (n || 0).toLocaleString('en-US'); }
  // a video copy is 'copy' and its height
  function storeKindName(kind, area) {
    if (/^copy\d+$/.test(kind)) return 'Video copies, ' + kind.slice(4) + 'p';
    if (area === 'other' && kind === 'other') return 'Anything else';
    for (var i = 0; i < STORE_KINDS.length; i++) if (STORE_KINDS[i][0] === kind) return STORE_KINDS[i][1];
    return kind;
  }
  function storeAreaName(area) {
    for (var i = 0; i < STORE_AREAS.length; i++) if (STORE_AREAS[i][0] === area) return STORE_AREAS[i][1];
    return area;
  }
  // the kinds in the order above, the video copies tallest first after
  // the full-size ones
  function storeKindOrder(kinds) {
    var named = STORE_KINDS.map(function (k) { return k[0]; });
    var at = function (k) {
      if (/^copy\d+$/.test(k)) return named.indexOf('clean') + 0.5 - Number(k.slice(4)) / 100000;
      var i = named.indexOf(k);
      return i === -1 ? named.length : i;
    };
    return kinds.slice().sort(function (a, b) { return at(a) - at(b); });
  }
  function storeTable(title, head, rows, numFrom, wide) {
    var card = dash.recapTable(title, head, rows);
    if (wide) card.classList.add('is-wide');
    [].forEach.call(card.querySelectorAll('th, td'), function (c) {
      if (c.cellIndex < numFrom) c.classList.remove('num');
    });
    return card;
  }
  function storeBars(title, rows, total) {
    var card = h('div', 'card rg-chart');
    card.appendChild(h('p', 'rg-chart-title', title));
    var max = 0;
    rows.forEach(function (r) { if (r.bytes > max) max = r.bytes; });
    rows.forEach(function (r) {
      var row = h('div', 'rg-bar-row' + (r.bytes ? '' : ' is-zero'));
      var label = h('span', 'rg-bar-label', r.label);
      label.title = r.label;
      row.appendChild(label);
      var track = h('div', 'rg-bar-track');
      var fill = h('div', 'rg-bar-fill');
      fill.style.width = max ? Math.max(1, Math.round(r.bytes / max * 100)) + '%' : '0%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(h('span', 'rg-bar-n', storeSize(r.bytes) + ' (' + storeShare(r.bytes, total) + ')'));
      card.appendChild(row);
    });
    return card;
  }
  function paintStorage(s) {
    var view = el('storage-view');
    view.textContent = '';
    var byKind = {};
    var byArea = {};
    var inArea = {};
    var bucketBytes = 0;
    Object.keys(s.places).forEach(function (k) {
      var at = k.split('|');
      var area = at[0], kind = at[1], v = s.places[k];
      bucketBytes += v.bytes;
      var kindKey = area === 'other' && kind === 'other' ? 'elsewhere' : kind;
      [[byKind, kindKey], [byArea, area]].forEach(function (pair) {
        var t = pair[0][pair[1]] || (pair[0][pair[1]] = { n: 0, bytes: 0 });
        t.n += v.n;
        t.bytes += v.bytes;
      });
      (inArea[area] || (inArea[area] = {}))[kind] = v;
    });
    var none = { n: 0, bytes: 0 };
    var sumOf = function (kinds) {
      return kinds.reduce(function (t, k) {
        var v = byKind[k] || none;
        return { n: t.n + v.n, bytes: t.bytes + v.bytes };
      }, { n: 0, bytes: 0 });
    };
    var sent = sumOf(['photo', 'video', 'other']);
    var copyKinds = Object.keys(byKind).filter(function (k) { return /^copy\d+$/.test(k); });
    var copies = sumOf(['picked', 'clean', 'view', 'thumb', 'meta', 'oldclean'].concat(copyKinds));
    var dbBytes = s.database && typeof s.database.bytes === 'number' ? s.database.bytes : null;
    var dbRows = s.database ? s.database.tables.reduce(function (t, x) { return t + x.rows; }, 0) : 0;

    var stats = h('div', 'board');
    stats.appendChild(statCard('Stored in all', storeSize(bucketBytes + (dbBytes || 0)),
      storeCount(s.listed) + ' files in the bucket' + (dbBytes !== null ? ', and the database' : '')));
    stats.appendChild(statCard('Files as sent', storeSize(sent.bytes),
      storeCount((byKind.photo || none).n) + ' photos · ' + storeCount((byKind.video || none).n) + ' videos · ' +
      storeCount((byKind.other || none).n) + ' other'));
    stats.appendChild(statCard('Copies made', storeSize(copies.bytes), storeCount(copies.n) + ' thumbnails, viewing copies, video copies and the rest'));
    stats.appendChild(statCard('Database', dbBytes !== null ? storeSize(dbBytes) : '–',
      s.database ? storeCount(dbRows) + ' rows in ' + s.database.tables.length + ' tables' : ''));
    if (byKind.unlinked) {
      stats.appendChild(statCard('Not linked to anything', storeSize(byKind.unlinked.bytes),
        storeCount(byKind.unlinked.n) + ' files no row points at', true));
    }
    view.appendChild(stats);

    var charts = h('div', 'rg-charts store-charts');
    charts.appendChild(storeBars('By area', STORE_AREAS.filter(function (a) { return byArea[a[0]]; }).map(function (a) {
      return { label: a[1], bytes: byArea[a[0]].bytes };
    }), bucketBytes));
    var videoRows = [['As sent', byKind.video], ['Full size, metadata removed', byKind.clean]].concat(
      storeKindOrder(copyKinds).map(function (k) { return [k.slice(4) + 'p', byKind[k]]; }));
    charts.appendChild(storeTable('Videos and their copies', ['', 'Files', 'Size'],
      videoRows.filter(function (r) { return r[1]; }).map(function (r) { return [r[0], storeCount(r[1].n), storeSize(r[1].bytes)]; }), 1));
    charts.appendChild(storeTable('By kind', ['Kind', 'Files', 'Size', 'Share'],
      storeKindOrder(Object.keys(byKind).filter(function (k) { return k !== 'elsewhere'; })).concat(byKind.elsewhere ? ['elsewhere'] : [])
        .map(function (k) {
          var v = byKind[k];
          return [k === 'elsewhere' ? 'Anything else' : storeKindName(k), storeCount(v.n), storeSize(v.bytes), storeShare(v.bytes, bucketBytes)];
        }), 1, true));
    STORE_AREAS.forEach(function (a) {
      var kinds = inArea[a[0]];
      if (!kinds) return;
      var total = byArea[a[0]].bytes;
      charts.appendChild(storeTable(a[1], ['Kind', 'Files', 'Size', 'Share'],
        storeKindOrder(Object.keys(kinds)).map(function (k) {
          return [storeKindName(k, a[0]), storeCount(kinds[k].n), storeSize(kinds[k].bytes), storeShare(kinds[k].bytes, total)];
        }), 1));
    });
    charts.appendChild(storeTable('Files as sent, by type', ['Type', 'Files', 'Size'],
      Object.keys(s.types).sort(function (a, b) { return s.types[b].bytes - s.types[a].bytes; }).map(function (t) {
        return [STORE_TYPES[t] || t, storeCount(s.types[t].n), storeSize(s.types[t].bytes)];
      }), 1));
    charts.appendChild(storeTable('Proof by team, as sent', ['Team', 'Files', 'Size'], (s.teams || []).map(function (t) {
      return [t.name + (t.hidden ? ' (hidden)' : ''), storeCount(t.n), storeSize(t.bytes)];
    }), 1));
    charts.appendChild(storeTable('Albums, as sent', ['Album', 'Files', 'Size'], (s.albums || []).map(function (a) {
      return [a.name, storeCount(a.n), storeSize(a.bytes)];
    }), 1));
    charts.appendChild(storeTable('Database tables', ['Table', 'Rows'], s.database ? s.database.tables.filter(function (t) { return t.rows; }).map(function (t) {
      return [t.name, storeCount(t.rows)];
    }) : [], 1));
    charts.appendChild(storeTable('Largest files', ['File', 'What', 'Size'], s.largest.map(function (x) {
      return [x.name, storeAreaName(x.area) + ': ' + storeKindName(x.kind, x.area).toLowerCase(), storeSize(x.bytes)];
    }), 2, true));
    view.appendChild(charts);
    view.classList.remove('hidden');
  }
  if (el('storage-count')) {
    el('storage-count').addEventListener('click', function () {
      var out = el('storage-state');
      var got = { places: {}, types: {}, largest: [], listed: 0 };
      var add = function (into, from) {
        Object.keys(from || {}).forEach(function (k) {
          var t = into[k] || (into[k] = { n: 0, bytes: 0 });
          t.n += from[k].n;
          t.bytes += from[k].bytes;
        });
      };
      function round(cursor) {
        return api('/api/console/storage' + (cursor ? '?cursor=' + encodeURIComponent(cursor) : '')).then(function (d) {
          if (!d || !d.ok) {
            out.textContent = (d && d.error) || 'The count did not finish.';
            return null;
          }
          got.listed += d.listed;
          add(got.places, d.places);
          add(got.types, d.types);
          got.largest = got.largest.concat(d.largest || []).sort(function (a, b) { return b.bytes - a.bytes; }).slice(0, 12);
          if (d.database) {
            got.database = d.database;
            got.teams = d.teams;
            got.albums = d.albums;
          }
          out.textContent = 'Counted ' + storeCount(got.listed) + ' files…';
          return d.done ? got : round(d.cursor);
        });
      }
      busy(el('storage-count'), round('')).then(function (s) {
        if (!s) return;
        paintStorage(s);
        out.textContent = 'Counted ' + storeCount(s.listed) + ' files at ' +
          new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) + '.';
        el('storage-count').textContent = 'Count again';
      }).catch(function () {
        out.textContent = 'The count did not finish.';
      });
    });
  }
})(window.dash);
