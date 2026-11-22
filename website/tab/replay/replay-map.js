/* The replay: the routes teams recorded on the day, drawn on the site's
   map and played back, with each quest appearing where and when its
   proof was sent. The replay page draws every team and a team's page its
   own (window.SCSReplay.start). The routes come from the tab, which
   keeps the ones the organisers saved. */
(function () {
  'use strict';

  var script = document.currentScript;
  var BASE = script && script.src ? script.src.replace(/[^/]*$/, '') : './';
  var ASSETS = BASE + '../../assets/';
  var MAPLIBRE_JS = ASSETS + 'maplibre/maplibre-gl.js';
  var MAPLIBRE_CSS = ASSETS + 'maplibre/maplibre-gl.css';
  var MAP_STYLE = ASSETS + 'maplibre/style.json';
  var MAP_GLYPHS = ASSETS + 'maplibre/fonts/{fontstack}/{range}.pbf';
  var TRANSIT = ASSETS + 'transit.geojson';
  var LOCAL_GLYPH_RANGES = ['0-255', '256-511', '512-767', '768-1023', '7680-7935', '8192-8447', '8448-8703'];
  var REMOTE_GLYPHS = 'https://protomaps.github.io/basemaps-assets/fonts';
  // the same host as the quest page's TILE_URL and sw.js's TILE_HOSTS
  var TILE_URL = 'https://tiles.scs.andyrew.space/my_area/{z}/{x}/{y}.mvt';
  var OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var MAP_BOUNDS = [[149.9, -34.65], [152.1, -32.7]];
  var ZONE = 'Australia/Sydney';
  var SPEEDS = { slow: 2, normal: 6, fast: 15 }; // minutes of the day a second
  var SPEED_KEY = 'scs2-replay-speed';

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }
  function siteColor(token, fallback) {
    var v = '';
    try { v = getComputedStyle(document.documentElement).getPropertyValue(token); } catch (e) { v = ''; }
    v = String(v || '').trim();
    return v || fallback;
  }
  function isDark() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
  function reducedMotion() {
    try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  // read through the site's retrying fetch
  function getJson(url, opts) {
    var ask = window.scs && window.scs.fetch ? window.scs.fetch : fetch;
    return ask(url, opts || {}).then(function (r) {
      if (!r.ok) throw new Error(url + ' ' + r.status);
      return r.json();
    });
  }
  var normName = function (s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); };

  // ---------- time ----------
  function hour24() { return !!(window.scs && window.scs.hour24 && window.scs.hour24()); }
  function clock(t) {
    var o = hour24() ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: ZONE } : { hour: 'numeric', minute: '2-digit', timeZone: ZONE };
    try { return new Date(t * 1000).toLocaleTimeString(undefined, o); } catch (e) { return new Date(t * 1000).toLocaleTimeString(); }
  }
  function hourLabel(t) {
    var o = hour24() ? { hour: '2-digit', hourCycle: 'h23', timeZone: ZONE } : { hour: 'numeric', timeZone: ZONE };
    try { return new Date(t * 1000).toLocaleTimeString(undefined, o); } catch (e) { return ''; }
  }
  // Sydney's offset from UTC at a moment, in seconds
  var zoneFmt = null;
  function zoneOffset(t) {
    try {
      if (!zoneFmt) {
        zoneFmt = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      }
      var p = {};
      zoneFmt.formatToParts(new Date(t * 1000)).forEach(function (x) { p[x.type] = x.value; });
      return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000) - Math.floor(t);
    } catch (e) { return 11 * 3600; }
  }
  // a stamp from the tab: UTC "YYYY-MM-DD HH:MM:SS", or "HH:MM" on
  // Sydney's clock when the organisers have taken the date off
  function readStamp(s, dayOf) {
    var str = String(s || '').trim();
    var m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/.exec(str);
    if (m) return Date.parse(m[1] + 'T' + m[2] + (m[3] || ':00') + 'Z') / 1000;
    var b = /^(\d{2}):(\d{2})$/.exec(str);
    if (!b || !dayOf) return NaN;
    var off = zoneOffset(dayOf);
    var local = dayOf + off;
    var midnight = local - (((local % 86400) + 86400) % 86400);
    return midnight + (+b[1]) * 3600 + (+b[2]) * 60 - off;
  }

  // ---------- the map, in the site's own colours ----------
  var MAP_PALETTES = {
    light: {
      land: '#e7e7e7', water: '#c9d6dc',
      park: '#d8e1cf', parkLight: '#e0e6d7', wood: '#d1dcc7', scrub: '#e0e5d6',
      sand: '#e9e1cd', beach: '#ece3c9',
      hospital: '#eae0dc', industrial: '#e1e1e1', school: '#e8e2d5', zoo: '#dfe4d8',
      aerodrome: '#e0e0e0', runway: '#d0d0d0', pier: '#dadada', pedestrian: '#e2e2e2',
      buildings: '#d0d0d0', road: '#ffffff', tunnel: '#f0f0f0',
      railway: '#8a8a8a', boundaries: '#adadad',
      ink: '#111111', inkMuted: '#616161', inkFaint: '#8a8a8a',
      roadInkMajor: '#494949', roadInkMinor: '#616161', waterInk: '#5c6f7a'
    },
    dark: {
      land: '#1b1b1b', water: '#0f2630',
      park: '#1c3122', parkLight: '#1e2e20', wood: '#1a2e1d', scrub: '#20291d',
      sand: '#26231a', beach: '#2a2619',
      hospital: '#252020', industrial: '#21211e', school: '#25231d', zoo: '#202621',
      aerodrome: '#21211e', runway: '#2e2e2e', pier: '#282828', pedestrian: '#242424',
      buildings: '#2b2b2b', road: '#4a4a4a', tunnel: '#2f2f2f',
      railway: '#808080', boundaries: '#4a4a4a',
      ink: '#f2f2f2', inkMuted: '#a3a3a3', inkFaint: '#8a8a8a',
      roadInkMajor: '#d0d0d0', roadInkMinor: '#a3a3a3', waterInk: '#8fb0bd'
    }
  };
  function palette() { return MAP_PALETTES[isDark() ? 'dark' : 'light']; }
  var PARK_KINDS = ['national_park', 'park', 'cemetery', 'protected_area', 'nature_reserve', 'forest', 'golf_course'];
  var FLAT_INKS = {
    earth: 'land', landcover: 'land',
    landuse_urban_green: 'parkLight', landuse_hospital: 'hospital', landuse_industrial: 'industrial',
    landuse_school: 'school', landuse_beach: 'beach', landuse_zoo: 'zoo', landuse_aerodrome: 'aerodrome',
    landuse_runway: 'runway', roads_runway: 'runway', roads_taxiway: 'runway',
    landuse_pedestrian: 'pedestrian', landuse_pier: 'pier', roads_pier: 'pier',
    water: 'water', water_stream: 'water', water_river: 'water',
    buildings: 'buildings', roads_rail: 'railway',
    boundaries: 'boundaries', boundaries_country: 'boundaries'
  };
  var LABEL_INKS = {
    address_label: ['inkFaint', 'road'],
    water_waterway_label: ['waterInk', 'water'],
    water_label_ocean: ['waterInk', 'water'],
    water_label_lakes: ['waterInk', 'water'],
    roads_labels_minor: ['roadInkMinor', 'road'],
    roads_labels_major: ['roadInkMajor', 'road'],
    earth_label_islands: ['inkMuted', 'land'],
    places_subplace: ['ink', 'land'],
    places_locality: ['ink', 'land'],
    places_region: ['inkFaint', 'land'],
    places_country: ['inkFaint', 'land']
  };

  function layerPaint(layer, t) {
    var id = layer.id;
    var colour = layer.type === 'line' ? 'line-color' : 'fill-color';
    var out = {};
    if (id === 'background') out['background-color'] = t.land;
    else if (FLAT_INKS[id]) out[colour] = t[FLAT_INKS[id]];
    else if (id === 'landuse_park') {
      out['fill-color'] = ['case',
        ['in', ['get', 'kind'], ['literal', PARK_KINDS]], t.park,
        ['==', ['get', 'kind'], 'wood'], t.wood,
        ['in', ['get', 'kind'], ['literal', ['scrub', 'grassland', 'grass']]], t.scrub,
        ['==', ['get', 'kind'], 'sand'], t.sand,
        ['in', ['get', 'kind'], ['literal', ['military', 'naval_base', 'airfield']]], t.aerodrome,
        t.land];
    } else if (layer.type === 'line' && /^roads_/.test(id)) {
      out[colour] = /_casing/.test(id) ? t.land : /^roads_tunnels_/.test(id) ? t.tunnel : t.road;
    } else if (LABEL_INKS[id]) {
      out['text-color'] = t[LABEL_INKS[id][0]];
      out['text-halo-color'] = t[LABEL_INKS[id][1]];
    } else if (id === 'rp-transit') {
      // the lines in grey, so a team's colour is never read as a line's
      out['line-color'] = t.railway;
    } else return null;
    return out;
  }

  var libPromise = null;
  function webglAvailable() {
    try {
      var c = document.createElement('canvas');
      return !!(c.getContext('webgl2') || c.getContext('webgl'));
    } catch (e) { return false; }
  }
  function loadMapLibre() {
    if (libPromise) return libPromise;
    libPromise = new Promise(function (resolve, reject) {
      if (window.maplibregl) return resolve(window.maplibregl);
      if (!webglAvailable()) return reject(new Error('no WebGL'));
      if (!document.querySelector('link[href="' + MAPLIBRE_CSS + '"]')) {
        var link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = MAPLIBRE_CSS;
        document.head.appendChild(link);
      }
      // the library's script, asked for again when it does not arrive
      var waits = [500, 1500, 4000, 8000];
      var n = 0;
      (function ask() {
        var s = document.createElement('script');
        s.src = MAPLIBRE_JS;
        s.onload = function () { if (window.maplibregl) resolve(window.maplibregl); else reject(new Error('MapLibre missing')); };
        s.onerror = function () {
          if (s.parentNode) s.parentNode.removeChild(s);
          if (n < waits.length) setTimeout(ask, waits[n++]);
          else reject(new Error('MapLibre could not be loaded'));
        };
        document.head.appendChild(s);
      })();
    });
    libPromise.catch(function () { libPromise = null; });
    return libPromise;
  }
  function tileEndpoint() {
    var ctl = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = ctl ? window.setTimeout(function () { ctl.abort(); }, 4000) : 0;
    return fetch(TILE_URL.replace('{z}/{x}/{y}', '0/0/0'), ctl ? { signal: ctl.signal } : {}).then(function (r) {
      if (timer) window.clearTimeout(timer);
      if (!r.ok) throw new Error('tiles ' + r.status);
      return TILE_URL;
    }, function (err) {
      if (timer) window.clearTimeout(timer);
      throw err;
    });
  }
  function absUrl(path) {
    return new URL(path, location.href).href.replace(/%7B/g, '{').replace(/%7D/g, '}');
  }
  // the basemap over the site's tiles, or OpenStreetMap's pictures when
  // they cannot be reached; the transport lines under the names
  function buildStyle(transit) {
    var t = palette();
    return Promise.all([
      tileEndpoint().catch(function () { return null; }),
      getJson(MAP_STYLE).catch(function () { return null; })
    ]).then(function (got) {
      var style;
      if (got[0] && got[1]) {
        style = got[1];
        style.sources.protomaps.tiles = [got[0]];
      } else {
        style = {
          version: 8,
          sources: { osm: { type: 'raster', tiles: [OSM_TILES], tileSize: 256, maxzoom: 19, attribution: '&copy; OpenStreetMap contributors' } },
          layers: [{ id: 'background', type: 'background' }, { id: 'osm', type: 'raster', source: 'osm' }]
        };
      }
      style.glyphs = absUrl(MAP_GLYPHS);
      style.sources['rp-transit'] = { type: 'geojson', data: transit || { type: 'FeatureCollection', features: [] } };
      var lines = {
        id: 'rp-transit', type: 'line', source: 'rp-transit',
        filter: ['all', ['!=', ['geometry-type'], 'Point'], ['!=', ['get', 'm'], 'bus'], ['!=', ['get', 'm'], 'ferry']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-opacity': 0.45, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 1.2, 15, 2.6] }
      };
      var ids = style.layers.map(function (l) { return l.id; });
      var before = ids.indexOf((style.metadata && style.metadata['scs:data-before']) || '');
      if (before < 0) before = style.layers.length;
      style.layers.splice(before, 0, lines);
      style.layers.forEach(function (l) {
        var p = layerPaint(l, t);
        if (!p) return;
        l.paint = l.paint || {};
        Object.keys(p).forEach(function (k) { l.paint[k] = p[k]; });
      });
      return style;
    });
  }

  // ---------- the routes ----------
  function merc(lon, lat) {
    var s = Math.sin(lat * Math.PI / 180);
    return [(lon + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
  }
  function decode(d) {
    var n = d.t.length;
    var tr = { team: d.team, n: n, t: new Float64Array(n), lat: new Float64Array(n), lon: new Float64Array(n),
      mx: new Float64Array(n), my: new Float64Array(n), filled: new Uint8Array(n), legs: d.legs || [], stays: d.stays || [] };
    var t = d.t0, y = 0, x = 0;
    for (var i = 0; i < n; i++) {
      t += d.t[i]; y += d.y[i]; x += d.x[i];
      tr.t[i] = t; tr.lat[i] = y / 1e5; tr.lon[i] = x / 1e5;
      var m = merc(tr.lon[i], tr.lat[i]);
      tr.mx[i] = m[0]; tr.my[i] = m[1];
    }
    // the stretch ending at point i is underground, filled in along the line
    (d.legs || []).forEach(function (leg) {
      if (!leg.filled) return;
      for (var k = 1; k < n; k++) {
        var mid = (tr.t[k - 1] + tr.t[k]) / 2;
        if (mid > leg.t0 && mid < leg.t1) tr.filled[k] = 1;
      }
    });
    tr.from = tr.t[0];
    tr.to = tr.t[n - 1];
    return tr;
  }
  // the last point at or before time `now`
  function indexAt(tr, now) {
    var lo = 0, hi = tr.n - 1;
    if (now < tr.t[0]) return -1;
    if (now >= tr.t[hi]) return hi;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (tr.t[mid] <= now) lo = mid; else hi = mid - 1;
    }
    return lo;
  }
  function positionAt(tr, now) {
    var i = indexAt(tr, now);
    if (i < 0) i = 0;
    if (i >= tr.n - 1) return { mx: tr.mx[tr.n - 1], my: tr.my[tr.n - 1], lat: tr.lat[tr.n - 1], lon: tr.lon[tr.n - 1], i: tr.n - 1 };
    var span = tr.t[i + 1] - tr.t[i];
    var u = span > 0 ? Math.max(0, Math.min(1, (now - tr.t[i]) / span)) : 0;
    return {
      mx: tr.mx[i] + (tr.mx[i + 1] - tr.mx[i]) * u, my: tr.my[i] + (tr.my[i + 1] - tr.my[i]) * u,
      lat: tr.lat[i] + (tr.lat[i + 1] - tr.lat[i]) * u, lon: tr.lon[i] + (tr.lon[i + 1] - tr.lon[i]) * u, i: i
    };
  }
  function metres(lat1, lon1, lat2, lon2) {
    var k = Math.cos((lat1 + lat2) / 2 * Math.PI / 180);
    var dx = (lon2 - lon1) * 111320 * k, dy = (lat2 - lat1) * 110574;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Each quest where the team did it: on the quest's own pin when the
  // route passes within 300 m of it in the hour before the proof was
  // sent (at the moment it came closest), otherwise wherever the team
  // was when it was sent. A station the team's photo was taken at is at
  // that station, at the time it was taken.
  function placeQuests(tr, quests, pins) {
    var out = [];
    (quests || []).forEach(function (q) {
      var at = readStamp(q.at, tr.from);
      if (!isFinite(at)) return;
      if (q.stop && q.spot) {
        var sm = merc(q.spot.lng, q.spot.lat);
        out.push({ t: at, sent: at, lat: q.spot.lat, lon: q.spot.lng, mx: sm[0], my: sm[1], q: q });
        return;
      }
      var best = null;
      (q.spot ? [q.spot] : pins[q.key] || []).forEach(function (p) {
        var i = Math.max(0, indexAt(tr, at - 3600));
        for (; i < tr.n && tr.t[i] <= at + 300; i++) {
          var d = metres(p.lat, p.lng, tr.lat[i], tr.lon[i]);
          if (!best || d < best.d) best = { d: d, lat: p.lat, lon: p.lng, t: Math.min(tr.t[i], at) };
        }
      });
      var spot;
      if (best && best.d <= 300) spot = { lat: best.lat, lon: best.lon, t: best.t };
      else if (at >= tr.from - 600 && at <= tr.to + 600) {
        var pos = positionAt(tr, at);
        spot = { lat: pos.lat, lon: pos.lon, t: at };
      } else return;
      var m = merc(spot.lon, spot.lat);
      out.push({ t: spot.t, sent: at, lat: spot.lat, lon: spot.lon, mx: m[0], my: m[1], q: q });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  // a team with no route: each quest with a spot, at it, from when it was
  // sent; dayOf puts a time sent without its date on the replay's day
  function spotQuests(quests, dayOf) {
    var out = [];
    (quests || []).forEach(function (q) {
      if (!q.spot) return;
      var at = readStamp(q.at, dayOf);
      if (!isFinite(at)) return;
      var m = merc(q.spot.lng, q.spot.lat);
      out.push({ t: at, sent: at, lat: q.spot.lat, lon: q.spot.lng, mx: m[0], my: m[1], q: q });
    });
    out.sort(function (a, b) { return a.t - b.t; });
    return out;
  }

  var TEAM_INKS = [
    ['--line-red', '#ee352e'], ['--line-blue', '#0039a6'], ['--line-green', '#00933c'], ['--line-orange', '#ff6319'],
    ['--line-purple', '#b933ad'], ['--line-sky', '#00a1de'], ['--line-brown', '#996633'], ['--line-lime', '#6cbe45'],
    [null, '#168388'], [null, '#c4258f'], [null, '#1d2a6b'], ['--line-yellow', '#fccc0a'], ['--line-grey', '#a7a9ac']
  ];
  function teamInk(i) {
    var c = TEAM_INKS[i % TEAM_INKS.length];
    return c[0] ? siteColor(c[0], c[1]) : c[1];
  }
  var MODE_WORDS = { train: 'train', metro: 'metro', tram: 'light rail' };

  // ---------- the replay ----------
  function start(host, opts) {
    opts = opts || {};
    var single = !!opts.single;
    var replay = opts.replay || { teams: [], pins: {} };
    var pins = replay.pins || {};
    var tabTeams = {};
    (replay.teams || []).forEach(function (t) { tabTeams[normName(t.name)] = t; });

    // the page's parts
    host.textContent = '';
    var root = el('div', 'rp' + (single ? ' rp-single' : ''));
    var card = el('div', 'rp-map-card');
    var mapBox = el('div', 'rp-map');
    var status = el('p', 'rp-status', 'Loading the map…');
    var fullBtn = el('button', 'rp-map-btn rp-full-btn');
    fullBtn.type = 'button';
    fullBtn.setAttribute('aria-label', 'Full screen map');
    fullBtn.innerHTML = '<svg class="rp-icon-expand" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>' +
      '<svg class="rp-icon-shrink" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/></svg>';
    card.appendChild(mapBox);
    card.appendChild(status);
    card.appendChild(fullBtn);
    root.appendChild(card);

    var key = el('ul', 'rp-key');
    var keyRide = el('li', 'rp-key-ride');
    keyRide.appendChild(el('span', 'rp-key-dash'));
    keyRide.appendChild(document.createTextNode('Underground, no GPS: drawn along the line'));
    var keyQuest = el('li', 'rp-key-quest');
    keyQuest.appendChild(el('span', 'rp-key-ring'));
    keyQuest.appendChild(document.createTextNode('A quest, where its proof was sent'));
    var keyOther = el('li', 'rp-key-other');
    keyOther.appendChild(el('span', 'rp-key-ring rp-key-ring-other'));
    keyOther.appendChild(document.createTextNode('A quest by a team with no route'));
    keyOther.hidden = true;
    key.appendChild(keyRide);
    key.appendChild(keyQuest);
    key.appendChild(keyOther);
    root.appendChild(key);

    var bar = el('div', 'rp-controls');
    var play = el('button', 'btn btn-accent rp-play');
    play.type = 'button';
    play.innerHTML = '<svg class="rp-icon-play" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4.5v15l12.5-7.5z"/></svg>' +
      '<svg class="rp-icon-pause" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4.5h4.5v15H6zM13.5 4.5H18v15h-4.5z"/></svg>' +
      '<span class="rp-play-text">Play</span>';
    var now = el('p', 'rp-clock', '');
    now.setAttribute('aria-live', 'off');
    var speed = el('div', 'rp-speed');
    speed.setAttribute('role', 'group');
    speed.setAttribute('aria-label', 'Speed');
    var speedPick = 'normal';
    try { speedPick = localStorage.getItem(SPEED_KEY) || 'normal'; } catch (e) { speedPick = 'normal'; }
    if (!SPEEDS[speedPick]) speedPick = 'normal';
    var speedBtns = [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']].map(function (s) {
      var b = el('button', '', s[1]);
      b.type = 'button';
      b.setAttribute('data-speed', s[0]);
      b.setAttribute('aria-pressed', s[0] === speedPick ? 'true' : 'false');
      speed.appendChild(b);
      return b;
    });
    var scrubWrap = el('div', 'rp-scrub-wrap');
    // the track and its played part, drawn under the slider's own thumb
    var scrubTrack = el('div', 'rp-scrub-track');
    var scrubFill = el('div', 'rp-scrub-fill');
    scrubTrack.setAttribute('aria-hidden', 'true');
    scrubTrack.appendChild(scrubFill);
    scrubWrap.appendChild(scrubTrack);
    var scrub = el('input', 'rp-scrub');
    scrub.type = 'range';
    scrub.setAttribute('aria-label', 'Time of day');
    var ticks = el('div', 'rp-ticks');
    ticks.setAttribute('aria-hidden', 'true');
    scrubWrap.appendChild(scrub);
    scrubWrap.appendChild(ticks);
    var head = el('div', 'rp-controls-head');
    head.appendChild(play);
    head.appendChild(now);
    head.appendChild(speed);
    bar.appendChild(head);
    bar.appendChild(scrubWrap);
    root.appendChild(bar);

    var picker = null, othersRow = null, feed = null, pairBox = null, boardList = null, boardMore = null;
    var statsBox = null, statsFigures = null, chartHost = null;
    if (!single) {
      picker = el('div', 'rp-teams');
      picker.setAttribute('role', 'group');
      picker.setAttribute('aria-label', 'Teams on the map');
      root.appendChild(picker);
      // the teams with no route: a second set of marks, on a line of its own
      othersRow = el('div', 'rp-others');
      othersRow.hidden = true;
      root.appendChild(othersRow);
      // the standings at the replay's time, beside the latest quests
      pairBox = el('div', 'rp-pair');
      var boardBox = el('section', 'rp-board');
      boardBox.appendChild(el('h2', 'section-heading', 'Leaderboard'));
      boardList = el('ol', 'rp-board-list');
      boardList.setAttribute('aria-live', 'off');
      boardBox.appendChild(boardList);
      boardMore = el('button', 'btn rp-board-more');
      boardMore.type = 'button';
      boardMore.hidden = true;
      boardBox.appendChild(boardMore);
      pairBox.appendChild(boardBox);
      // beside the leaderboard: the latest quests, then what had been sent
      var sideBox = el('div', 'rp-side');
      var feedBox = el('section', 'rp-feed');
      feedBox.appendChild(el('h2', 'section-heading', 'Latest Quests'));
      feed = el('ol', 'rp-feed-list');
      feedBox.appendChild(feed);
      sideBox.appendChild(feedBox);
      pairBox.appendChild(sideBox);
      root.appendChild(pairBox);
      statsBox = el('section', 'rp-stats');
      statsBox.appendChild(el('h2', 'section-heading', 'Submissions'));
      statsFigures = el('ul', 'figures figures-2 rp-figures');
      statsBox.appendChild(statsFigures);
      chartHost = el('div', 'rp-chart');
      statsBox.appendChild(chartHost);
      statsBox.appendChild(el('p', 'rp-chart-note',
        'A bar is a quarter hour: sent in light green, accepted in dark green. Bars after the replay\u2019s time are faded.'));
      sideBox.appendChild(statsBox);
    }
    // Full screen: the map takes the screen and everything under it moves
    // into this pane, a panel along the bottom on a phone (the controls,
    // and the rest a tap on its bar away) and a column down the left on a
    // computer.
    var pane = el('div', 'rp-pane');
    pane.setAttribute('role', 'region');
    pane.setAttribute('aria-label', 'Replay controls');
    var paneGrab = el('button', 'rp-pane-grab');
    paneGrab.type = 'button';
    paneGrab.setAttribute('aria-expanded', 'false');
    paneGrab.setAttribute('aria-label', single ? 'Show the key' : 'Show the teams and latest quests');
    var paneHead = el('div', 'rp-pane-head');
    var paneMore = el('div', 'rp-pane-more');
    pane.appendChild(paneGrab);
    pane.appendChild(paneHead);
    pane.appendChild(paneMore);
    root.appendChild(pane);
    host.appendChild(root);

    var state = {
      teams: [], map: null, canvas: null, ctx: null, dpr: 1, from: 0, to: 0, now: 0,
      playing: false, last: 0, raf: 0, drawQueued: false, rings: [], popup: null, focus: -1, lib: null,
      others: [], showOthers: false
    };
    var OTHERS_KEY = 'scs2-replay-others';
    try { state.showOthers = localStorage.getItem(OTHERS_KEY) === '1'; } catch (e) { state.showOthers = false; }

    function fail(text) {
      status.textContent = text;
      status.hidden = false;
      card.classList.add('is-failed');
    }

    // ---- data ----
    var wanted = opts.teams ? opts.teams.map(normName) : null;

    // ---- where the map was left, and how it last looked ----
    // Within one tab the map comes back where it was left, on this page
    // or a team's; a new tab starts at the routes' own view. A picture of
    // the map as it last stood at that view holds its place while the
    // live map loads, and fades once it has drawn.
    var page = wanted ? 'team:' + wanted.join('|') : 'all';
    var VIEW_KEY = 'scs2-replay-view:' + page;
    var SHOT_CACHE = 'scs2-map-shot';
    var SHOT_URL = '/__replay-shot/' + encodeURIComponent(page);
    var SHOT_KEY = 'scs2-replay-shot:' + page;
    var SHOT_MIN_BYTES = 12000;
    var shotImg = null;
    function keptView() {
      try {
        var v = JSON.parse(sessionStorage.getItem(VIEW_KEY) || 'null');
        if (v && isFinite(v.lng) && isFinite(v.lat) && isFinite(v.zoom)) return v;
      } catch (e) { /* nothing kept */ }
      return null;
    }
    function shotLook() {
      return (isDark() ? 'dark' : 'light') + '-' + (window.scs && window.scs.mapPixelRatio ? window.scs.mapPixelRatio() : 1) +
        '-' + (state.showOthers ? 'others' : '');
    }
    function shotMeta() {
      try { return JSON.parse(localStorage.getItem(SHOT_KEY) || 'null'); } catch (e) { return null; }
    }
    function showShot() {
      var meta = shotMeta();
      if (!meta || !window.caches || keptView() || state.drawnOnce) return;
      if (Math.abs(mapBox.clientWidth - meta.w) > 1 || Math.abs(mapBox.clientHeight - meta.h) > 1 || meta.look !== shotLook()) return;
      caches.open(SHOT_CACHE).then(function (c) { return c.match(SHOT_URL); }).then(function (res) {
        return res ? res.blob() : null;
      }).then(function (blob) {
        if (!blob || shotImg || state.drawnOnce) return;
        var img = el('img', 'rp-shot');
        img.alt = '';
        img.setAttribute('aria-hidden', 'true');
        img.style.width = meta.w + 'px';
        img.style.height = meta.h + 'px';
        img.src = URL.createObjectURL(blob);
        shotImg = img;
        card.insertBefore(img, mapBox.nextSibling);
      }).catch(function () { /* the map draws as it always did */ });
    }
    function dropShot(fade) {
      var img = shotImg;
      if (!img) return;
      shotImg = null;
      var gone = function () {
        if (img.parentNode) img.parentNode.removeChild(img);
        URL.revokeObjectURL(img.src);
      };
      if (!fade || reducedMotion()) { gone(); return; }
      img.classList.add('is-leaving');
      window.setTimeout(gone, 220);
    }
    ['pointerdown', 'touchstart', 'wheel'].forEach(function (name) {
      card.addEventListener(name, function () { dropShot(false); }, { capture: true, passive: true });
    });
    // the map and its routes as they stand, read the moment a frame is drawn
    function takeShot(map) {
      if (!window.caches || keptView() || isFull() || state.now !== state.to) return;
      if (state.teams.some(function (t) { return !t.shown; })) return;
      var meta = { w: mapBox.clientWidth, h: mapBox.clientHeight, look: shotLook() };
      map.once('render', function () {
        var source = map.getCanvas();
        var copy = document.createElement('canvas');
        copy.width = source.width;
        copy.height = source.height;
        try {
          var c = copy.getContext('2d');
          c.drawImage(source, 0, 0);
          if (state.canvas) c.drawImage(state.canvas, 0, 0, copy.width, copy.height);
          copy.toBlob(function (blob) {
            if (!blob || blob.size < SHOT_MIN_BYTES) return;
            caches.open(SHOT_CACHE)
              .then(function (cache) { return cache.put(SHOT_URL, new Response(blob, { headers: { 'content-type': 'image/jpeg' } })); })
              .then(function () { localStorage.setItem(SHOT_KEY, JSON.stringify(meta)); })
              .catch(function () { /* not kept */ });
          }, 'image/jpeg', 0.85);
        } catch (e) { /* a canvas that cannot be read */ }
      });
      map.triggerRepaint();
    }
    function watchShot(map) {
      var moved = false;
      var safety = window.setTimeout(function () { dropShot(true); }, 10000);
      map.on('movestart', function (e) { if (e.originalEvent) moved = true; });
      map.once('load', function () {
        map.once('idle', function () {
          state.drawnOnce = true;
          window.clearTimeout(safety);
          dropShot(true);
          if (!moved) takeShot(map);
        });
      });
      map.on('moveend', function () {
        var c = map.getCenter();
        try {
          sessionStorage.setItem(VIEW_KEY, JSON.stringify({ lng: Math.round(c.lng * 1e5) / 1e5, lat: Math.round(c.lat * 1e5) / 1e5, zoom: Math.round(map.getZoom() * 100) / 100 }));
        } catch (e) { /* not kept */ }
      });
    }
    showShot();
    var api = opts.api || '';
    var data = Promise.all((replay.teams || []).filter(function (t) {
      return t.route && (!wanted || wanted.indexOf(normName(t.name)) !== -1);
    }).map(function (t) {
      return getJson(api + '/api/replay/route?name=' + encodeURIComponent(t.name), { cache: 'no-store' }).then(function (d) {
        return d && d.route ? decode(d.route) : null;
      }).catch(function () { return null; });
    })).then(function (tracks) {
      tracks = tracks.filter(Boolean);
      // best placed first, then the rest by name
      tracks.sort(function (a, b) {
        var ra = tabTeams[normName(a.team)], rb = tabTeams[normName(b.team)];
        var pa = ra && ra.rank ? ra.rank : 1e6, pb = rb && rb.rank ? rb.rank : 1e6;
        return pa - pb || a.team.localeCompare(b.team);
      });
      state.teams = tracks.map(function (tr, i) {
        var tab = tabTeams[normName(tr.team)];
        return { tr: tr, name: tab ? tab.name : tr.team, ink: teamInk(i), shown: true,
          quests: placeQuests(tr, tab ? tab.quests : [], pins) };
      });
      if (!state.teams.length) throw new Error('no routes');
      state.from = Math.min.apply(null, state.teams.map(function (t) { return t.tr.from; }));
      state.to = Math.max.apply(null, state.teams.map(function (t) { return t.tr.to; }));
      state.now = state.to;
      if (!single) buildBoard();
      // the teams the replay has no route for, behind their own toggle
      if (!single) {
        var drawn = {};
        state.teams.forEach(function (t) { drawn[normName(t.name)] = true; });
        state.others = (replay.teams || []).filter(function (t) { return !drawn[normName(t.name)]; }).map(function (t) {
          return { name: t.name, rank: t.rank, quests: spotQuests(t.quests, state.from) };
        }).filter(function (t) { return t.quests.length; });
      }
    });

    var transit = getJson(TRANSIT).catch(function () { return null; });

    Promise.all([data, loadMapLibre(), transit]).then(function (got) {
      state.lib = got[1];
      return buildStyle(got[2]).then(function (style) { makeMap(style); });
    }).catch(function (err) {
      var msg = String((err && err.message) || '');
      fail(msg === 'no routes' ? 'No routes to show.' : /WebGL|MapLibre missing/.test(msg) ? 'The map could not be loaded on this device.' : /MapLibre/.test(msg) ? 'The map could not be loaded. Check your connection.' : 'The routes could not be loaded.');
    });

    function bounds(teams) {
      var w = 180, s = 90, e = -180, n = -90;
      teams.forEach(function (t) {
        for (var i = 0; i < t.tr.n; i++) {
          if (t.tr.lon[i] < w) w = t.tr.lon[i];
          if (t.tr.lon[i] > e) e = t.tr.lon[i];
          if (t.tr.lat[i] < s) s = t.tr.lat[i];
          if (t.tr.lat[i] > n) n = t.tr.lat[i];
        }
      });
      return [[w, s], [e, n]];
    }

    function makeMap(style) {
      var ml = state.lib;
      mapBox.style.backgroundColor = palette().land;
      var kept = keptView();
      var map = new ml.Map({
        container: mapBox,
        style: style,
        // at most 2x unless the Sharper Map setting is on
        pixelRatio: window.scs && window.scs.mapPixelRatio ? window.scs.mapPixelRatio() : undefined,
        // where it was left in this tab, or the routes' own view
        center: kept ? [kept.lng, kept.lat] : undefined,
        zoom: kept ? kept.zoom : undefined,
        bounds: kept ? undefined : bounds(state.teams),
        fitBoundsOptions: { padding: 28 },
        maxBounds: MAP_BOUNDS,
        minZoom: 7,
        maxZoom: 17,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        // the wheel is handled below, as on the quest map
        scrollZoom: false,
        attributionControl: false,
        fadeDuration: 150,
        transformRequest: function (url, type) {
          if (type === 'Glyphs') {
            var g = /\/assets\/maplibre\/fonts\/([^/]+)\/(\d+-\d+)\.pbf$/.exec(url);
            if (g && LOCAL_GLYPH_RANGES.indexOf(g[2]) < 0) return { url: REMOTE_GLYPHS + '/' + g[1] + '/' + g[2] + '.pbf' };
          }
          return { url: url };
        }
      });
      state.map = map;
      watchShot(map);
      document.addEventListener('scs-map-sharp-changed', function () {
        if (state.map === map && map.setPixelRatio) map.setPixelRatio(window.scs.mapPixelRatio());
      });
      map.touchZoomRotate.disableRotation();
      map.keyboard.disableRotation();
      map.addControl(new ml.NavigationControl({ showCompass: false }), 'top-left');
      map.addControl(new ml.AttributionControl({ compact: true }), 'bottom-right');
      map.on('error', function (e) {
        var msg = String((e && e.error && e.error.message) || '');
        if (/tile|pbf|mvt|png|Failed to fetch|NetworkError|404|AJAXError/i.test(msg)) return;
        if (window.console) console.warn('map', (e && e.error) || e);
      });

      // the routes are drawn on a canvas over the map, under its
      // controls and pop-ups
      var canvas = el('canvas', 'rp-canvas');
      canvas.setAttribute('aria-hidden', 'true');
      var under = mapBox.querySelector('.maplibregl-canvas-container');
      if (under && under.nextSibling) mapBox.insertBefore(canvas, under.nextSibling);
      else mapBox.appendChild(canvas);
      state.canvas = canvas;
      state.ctx = canvas.getContext('2d');
      map.on('resize', function () { sizeCanvas(); requestDraw(); });
      map.on('movestart', function (e) {
        if (e.originalEvent && isFull() && sheetMq.matches) pane.classList.add('is-faded');
      });
      // a moving map: the routes are drawn in the map's own frame, as soon
      // as it has drawn, so they move with it rather than a frame behind
      map.on('render', function () { if (cameraKey() !== state.drawnAt) draw(); });
      // the routes need only the map's position, not its tiles
      map.once('styledata', function () { status.hidden = true; });
      sizeCanvas();
      setupControls();
      requestDraw();
      map.on('click', onClick);
      map.on('mousemove', function (e) {
        map.getCanvas().style.cursor = hit(e.point) ? 'pointer' : '';
      });
      new MutationObserver(repaint).observe(document.documentElement, { attributeFilter: ['data-theme'] });
    }

    function repaint() {
      var map = state.map;
      if (!map) return;
      mapBox.style.backgroundColor = palette().land;
      var t = palette();
      var layers = (map.getStyle() && map.getStyle().layers) || [];
      layers.forEach(function (l) {
        var p = layerPaint(l, t);
        if (!p) return;
        Object.keys(p).forEach(function (k) { try { map.setPaintProperty(l.id, k, p[k]); } catch (e) { /* layer gone */ } });
      });
      state.teams.forEach(function (team, i) { team.ink = teamInk(i); });
      paintPicker();
      requestDraw();
    }

    function sizeCanvas() {
      var c = state.canvas;
      if (!c) return;
      var w = mapBox.clientWidth, h = mapBox.clientHeight;
      state.dpr = window.devicePixelRatio || 1;
      c.width = Math.round(w * state.dpr);
      c.height = Math.round(h * state.dpr);
      c.style.width = w + 'px';
      c.style.height = h + 'px';
    }

    // map position to screen: two points tell the scale and the shift,
    // since the map neither turns nor tilts
    function projector() {
      var map = state.map;
      var a = map.project([151.0, -33.95]), b = map.project([151.3, -33.75]);
      var ma = merc(151.0, -33.95), mb = merc(151.3, -33.75);
      var sx = (b.x - a.x) / (mb[0] - ma[0]), sy = (b.y - a.y) / (mb[1] - ma[1]);
      return { sx: sx, sy: sy, ox: a.x - ma[0] * sx, oy: a.y - ma[1] * sy };
    }

    function requestDraw() {
      if (state.drawQueued) return;
      state.drawQueued = true;
      requestAnimationFrame(function () {
        state.drawQueued = false;
        draw();
      });
    }

    function cameraKey() {
      var map = state.map, c = map.getCenter();
      return c.lng + ',' + c.lat + ',' + map.getZoom() + ',' + (state.canvas ? state.canvas.width + 'x' + state.canvas.height : '');
    }
    function draw() {
      var ctx = state.ctx, map = state.map;
      if (!ctx || !map) return;
      state.drawnAt = cameraKey();
      var p = projector();
      var dpr = state.dpr;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      var casing = palette().land;
      var paper = siteColor('--surface', '#ffffff');
      var ringInk = siteColor('--sign-ink', '#ffffff');
      var width = single ? 4.5 : 3.5;
      var order = state.teams.map(function (t, i) { return i; }).filter(function (i) { return state.teams[i].shown; });
      if (state.focus >= 0 && order.indexOf(state.focus) !== -1) {
        order.splice(order.indexOf(state.focus), 1);
        order.push(state.focus);
      }
      var tnow = state.now;
      // the routes so far
      order.forEach(function (i) {
        var team = state.teams[i], tr = team.tr;
        var last = indexAt(tr, tnow);
        if (last < 0) return;
        var pos = positionAt(tr, tnow);
        [0, 1].forEach(function (pass) {
          ctx.strokeStyle = pass ? team.ink : casing;
          ctx.lineWidth = pass ? width : width + 3;
          var dashed = -1;
          var px = tr.mx[0] * p.sx + p.ox, py = tr.my[0] * p.sy + p.oy;
          ctx.beginPath();
          ctx.moveTo(px, py);
          for (var k = 1; k <= last + 1 && k < tr.n; k++) {
            var through = k > last;
            var x = (through ? pos.mx : tr.mx[k]) * p.sx + p.ox;
            var y = (through ? pos.my : tr.my[k]) * p.sy + p.oy;
            var f = pass ? tr.filled[k] : 0;
            if (f !== dashed) {
              // a change between ground and underground ends one stroke
              if (dashed !== -1) { ctx.stroke(); ctx.beginPath(); ctx.moveTo(px, py); }
              ctx.setLineDash(f ? [width * 1.6, width * 1.6] : []);
              dashed = f;
            }
            if (Math.abs(x - px) + Math.abs(y - py) < 0.8 && !through) continue;
            ctx.lineTo(x, y);
            px = x; py = y;
          }
          ctx.stroke();
          ctx.setLineDash([]);
        });
      });
      // the quests sent so far: a team with no route's first, in ink, under
      // the routed teams' own
      var r = single ? 5.5 : 4.5;
      if (state.showOthers) {
        var otherInk = siteColor('--text', '#111111');
        state.others.forEach(function (o) {
          o.quests.forEach(function (m) {
            if (m.t > tnow) return;
            ctx.beginPath();
            ctx.arc(m.mx * p.sx + p.ox, m.my * p.sy + p.oy, r - 0.5, 0, Math.PI * 2);
            ctx.fillStyle = paper;
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = otherInk;
            ctx.stroke();
          });
        });
      }
      order.forEach(function (i) {
        var team = state.teams[i];
        team.quests.forEach(function (m) {
          if (m.t > tnow) return;
          var x = m.mx * p.sx + p.ox, y = m.my * p.sy + p.oy;
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = paper;
          ctx.fill();
          ctx.lineWidth = 2.5;
          ctx.strokeStyle = team.ink;
          ctx.stroke();
        });
      });
      // a quest that has just appeared rings out once
      var clockNow = performance.now();
      state.rings = state.rings.filter(function (ring) { return clockNow - ring.born < 900; });
      state.rings.forEach(function (ring) {
        var k = (clockNow - ring.born) / 900;
        var x = ring.m.mx * p.sx + p.ox, y = ring.m.my * p.sy + p.oy;
        ctx.beginPath();
        ctx.arc(x, y, r + 16 * k, 0, Math.PI * 2);
        ctx.globalAlpha = 1 - k;
        ctx.lineWidth = 2;
        ctx.strokeStyle = ring.ink;
        ctx.stroke();
        ctx.globalAlpha = 1;
      });
      // where each team is now
      order.forEach(function (i) {
        var team = state.teams[i], tr = team.tr;
        if (tnow < tr.from) return;
        var pos = positionAt(tr, tnow);
        var x = pos.mx * p.sx + p.ox, y = pos.my * p.sy + p.oy;
        ctx.beginPath();
        ctx.arc(x, y, single ? 8 : 7, 0, Math.PI * 2);
        ctx.fillStyle = team.ink;
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = ringInk;
        ctx.stroke();
        if (tnow > tr.to) {
          // the route has ended: a dot in the middle says so
          ctx.beginPath();
          ctx.arc(x, y, 2.4, 0, Math.PI * 2);
          ctx.fillStyle = ringInk;
          ctx.fill();
        }
      });
      if (state.rings.length) requestDraw();
    }

    // ---- what is under a tap ----
    function hit(point) {
      if (!state.map) return null;
      var p = projector();
      var best = null;
      var tnow = state.now;
      state.teams.forEach(function (team, i) {
        if (!team.shown || tnow < team.tr.from) return;
        var pos = positionAt(team.tr, tnow);
        var d = Math.hypot(pos.mx * p.sx + p.ox - point.x, pos.my * p.sy + p.oy - point.y);
        if (d <= 22 && (!best || d < best.d)) best = { d: d, kind: 'team', i: i, lat: pos.lat, lon: pos.lon };
      });
      if (best) return best;
      state.teams.forEach(function (team, i) {
        if (!team.shown) return;
        team.quests.forEach(function (m) {
          if (m.t > tnow) return;
          var d = Math.hypot(m.mx * p.sx + p.ox - point.x, m.my * p.sy + p.oy - point.y);
          if (d <= 16 && (!best || d < best.d)) best = { d: d, kind: 'quest', i: i, m: m, lat: m.lat, lon: m.lon };
        });
      });
      if (best || !state.showOthers) return best;
      var under = [];
      state.others.forEach(function (o) {
        o.quests.forEach(function (m) {
          if (m.t > tnow) return;
          var d = Math.hypot(m.mx * p.sx + p.ox - point.x, m.my * p.sy + p.oy - point.y);
          if (d <= 16) under.push({ d: d, m: m, team: o });
        });
      });
      if (!under.length) return null;
      under.sort(function (a, b) { return a.d - b.d; });
      var near = under[0].m;
      // the ones at the same place as the nearest, in the order sent
      var here = under.filter(function (u) { return u.m.lat === near.lat && u.m.lon === near.lon; });
      here.sort(function (a, b) { return a.m.t - b.m.t; });
      return { kind: 'others', list: here, lat: near.lat, lon: near.lon };
    }

    // what a team was doing at that moment
    function doing(team, t) {
      var tr = team.tr;
      if (t < tr.from) return 'Route starts at ' + clock(tr.from) + '.';
      if (t > tr.to) return 'Route ends at ' + clock(tr.to) + '.';
      for (var i = 0; i < tr.legs.length; i++) {
        var l = tr.legs[i];
        if (t >= l.t0 && t <= l.t1) {
          var on = 'On the ' + (MODE_WORDS[l.mode] || l.mode);
          if (l.from && l.to && l.from !== l.to) on += ', ' + l.from + ' to ' + l.to;
          return on + '.';
        }
      }
      for (var j = 0; j < tr.stays.length; j++) {
        var s = tr.stays[j];
        if (t >= s.t0 && t <= s.t1) return 'Here from ' + clock(s.t0) + ' to ' + clock(s.t1) + '.';
      }
      return '';
    }

    function onClick(e) {
      var h = hit(e.point);
      if (state.popup) { state.popup.remove(); state.popup = null; }
      if (!h) {
        if (state.focus !== -1) { state.focus = -1; requestDraw(); }
        return;
      }
      var box = el('div', 'rp-tip-body');
      if (h.kind === 'others') {
        if (state.focus !== -1) state.focus = -1;
        var keys = {};
        h.list.forEach(function (u) { keys[u.m.q.key] = true; });
        var oneQuest = Object.keys(keys).length === 1;
        if (oneQuest) box.appendChild(questRow(h.list[0].m.q));
        if (oneQuest && h.list[0].m.q.stop) box.appendChild(el('span', 'rp-tip-line', h.list[0].m.q.stop));
        h.list.slice(0, 6).forEach(function (u) {
          var line = el('span', 'rp-tip-line');
          if (!oneQuest) line.appendChild(el('span', 'code', u.m.q.key || u.m.q.code));
          line.appendChild(document.createTextNode((oneQuest ? '' : ' ') + u.team.name + ', ' + whenWord(u.m.q) + clock(u.m.sent)));
          box.appendChild(line);
        });
        if (h.list.length > 6) box.appendChild(el('span', 'rp-tip-line', 'and ' + (h.list.length - 6) + ' more'));
        state.popup = new state.lib.Popup({ closeButton: false, closeOnClick: false, className: 'rp-tip', offset: 12, maxWidth: '280px' })
          .setLngLat([h.lon, h.lat]).setDOMContent(box).addTo(state.map);
        requestDraw();
        return;
      }
      var team = state.teams[h.i];
      state.focus = h.i;
      if (h.kind === 'team') {
        box.appendChild(el('strong', 'rp-tip-name', team.name));
        var what = doing(team, state.now);
        if (what) box.appendChild(el('span', 'rp-tip-line', what));
      } else {
        box.appendChild(questRow(h.m.q));
        box.appendChild(el('span', 'rp-tip-line', (single ? '' : team.name + ', ') + (h.m.q.stop ? h.m.q.stop + ', ' : '') +
          whenWord(h.m.q) + clock(h.m.sent)));
      }
      state.popup = new state.lib.Popup({ closeButton: false, closeOnClick: false, className: 'rp-tip', offset: 12, maxWidth: '280px' })
        .setLngLat([h.lon, h.lat]).setDOMContent(box).addTo(state.map);
      requestDraw();
    }

    // a station's time is when its photo was taken, where the photo says
    function whenWord(q) { return q.taken ? 'photo taken at ' : 'sent at '; }
    function questRow(q) {
      var row = el('span', 'rp-tip-quest');
      if (q.code) row.appendChild(el('span', 'code', q.key || q.code));
      row.appendChild(document.createTextNode(' ' + (q.name || '')));
      return row;
    }

    // ---- playing ----
    function setNow(t, fromPlay) {
      var before = state.now;
      state.now = Math.max(state.from, Math.min(state.to, t));
      if (fromPlay && !reducedMotion()) {
        // the quests passed in this step ring out as they appear
        state.teams.forEach(function (team) {
          if (!team.shown) return;
          team.quests.forEach(function (m) {
            if (m.t > before && m.t <= state.now) state.rings.push({ m: m, ink: team.ink, born: performance.now() });
          });
        });
        if (state.showOthers) {
          var otherInk = siteColor('--text', '#111111');
          state.others.forEach(function (o) {
            o.quests.forEach(function (m) {
              if (m.t > before && m.t <= state.now) state.rings.push({ m: m, ink: otherInk, born: performance.now() });
            });
          });
        }
      }
      if (state.popup && fromPlay) { state.popup.remove(); state.popup = null; }
      scrub.value = String(Math.round(state.now));
      scrubFill.style.width = (state.to > state.from ? (state.now - state.from) / (state.to - state.from) * 100 : 0) + '%';
      var text = clock(state.now);
      now.textContent = text;
      scrub.setAttribute('aria-valuetext', text);
      paintFeed();
      paintBoard();
      paintStats();
      requestDraw();
    }

    function setPlaying(on) {
      state.playing = on;
      root.classList.toggle('is-playing', on);
      play.querySelector('.rp-play-text').textContent = on ? 'Pause' : 'Play';
      play.setAttribute('aria-pressed', on ? 'true' : 'false');
      if (on) {
        if (state.now >= state.to) setNow(state.from);
        state.last = performance.now();
        state.raf = requestAnimationFrame(tick);
      } else if (state.raf) {
        cancelAnimationFrame(state.raf);
        state.raf = 0;
      }
    }

    function tick(clockNow) {
      if (!state.playing) return;
      var dt = Math.min(0.25, Math.max(0, (clockNow - state.last) / 1000));
      state.last = clockNow;
      setNow(state.now + dt * SPEEDS[speedPick] * 60, true);
      if (state.now >= state.to) { setPlaying(false); return; }
      state.raf = requestAnimationFrame(tick);
    }

    function setupControls() {
      scrub.min = String(Math.floor(state.from));
      scrub.max = String(Math.ceil(state.to));
      scrub.step = '10';
      layoutTicks();
      window.addEventListener('resize', layoutTicks);
      play.addEventListener('click', function () { setPlaying(!state.playing); });
      scrub.addEventListener('input', function () { setNow(Number(scrub.value)); });
      speedBtns.forEach(function (b) {
        b.addEventListener('click', function () {
          speedPick = b.getAttribute('data-speed');
          try { localStorage.setItem(SPEED_KEY, speedPick); } catch (e) { /* not kept */ }
          speedBtns.forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
        });
      });
      buildPicker();
      drawChart();
      setNow(state.to);
      document.addEventListener('scs-dates-changed', function () { setupTicksText(); setNow(state.now); });
    }
    // a label on the hour under the slider, every hour, or every second
    // or third where the labels would meet
    var ticksEvery = '';
    function layoutTicks() {
      if (!(state.to > state.from)) return;
      var first = Math.ceil(state.from / 3600) * 3600;
      var hours = [];
      for (var h = first; h <= state.to; h += 3600) hours.push(h);
      var room = (ticks.clientWidth || 600) * 3600 / (state.to - state.from);
      var every = room >= 64 ? 1 : room * 2 >= 64 ? 2 : 3;
      var halves = every === 1 && room >= 120;
      var layout = every + (halves ? 'h' : '');
      if (layout === ticksEvery && ticks.children.length) return;
      ticksEvery = layout;
      ticks.textContent = '';
      var at = function (t, cls, text) {
        var tick = el('span', cls, text);
        tick.style.left = ((t - state.from) / (state.to - state.from) * 100) + '%';
        ticks.appendChild(tick);
      };
      hours.forEach(function (hh, i) {
        at(hh, i % every ? 'rp-tick is-bare' : 'rp-tick', i % every ? '' : hourLabel(hh));
      });
      // with room to spare, a bare mark at each half hour too
      if (halves) {
        for (var half = Math.ceil((state.from - 1800) / 3600) * 3600 + 1800; half <= state.to; half += 3600) {
          if (half >= state.from) at(half, 'rp-tick is-bare', '');
        }
      }
    }
    function setupTicksText() {
      [].forEach.call(ticks.children, function (tick) {
        if (tick.classList.contains('is-bare')) return;
        var frac = parseFloat(tick.style.left) / 100;
        tick.textContent = hourLabel(Math.round(state.from + frac * (state.to - state.from)));
      });
    }

    // ---- the teams to show ----
    var allBtn = null, othersBtn = null;
    function buildPicker() {
      if (!picker) return;
      picker.textContent = '';
      allBtn = el('button', 'rp-team rp-team-all', 'All');
      allBtn.type = 'button';
      allBtn.addEventListener('click', function () {
        var every = state.teams.every(function (t) { return t.shown; });
        state.teams.forEach(function (t) { t.shown = !every; });
        if (!every) state.focus = -1;
        paintPicker();
        paintFeed();
        requestDraw();
      });
      picker.appendChild(allBtn);
      state.teams.forEach(function (team, i) {
        var b = el('button', 'rp-team');
        b.type = 'button';
        var disc = el('span', 'rp-team-disc');
        disc.setAttribute('aria-hidden', 'true');
        b.appendChild(disc);
        b.appendChild(el('span', 'rp-team-name', team.name));
        b.addEventListener('click', function () {
          team.shown = !team.shown;
          if (!team.shown && state.focus === i) state.focus = -1;
          if (state.popup) { state.popup.remove(); state.popup = null; }
          paintPicker();
          paintFeed();
          requestDraw();
        });
        team.btn = b;
        team.disc = disc;
        picker.appendChild(b);
      });
      if (state.others.length) {
        othersBtn = el('button', 'rp-team rp-team-others');
        othersBtn.type = 'button';
        var ring = el('span', 'rp-team-disc rp-team-ring');
        ring.setAttribute('aria-hidden', 'true');
        othersBtn.appendChild(ring);
        othersBtn.appendChild(el('span', 'rp-team-name', state.others.length + (state.others.length === 1 ? ' team' : ' teams') + ' with no route'));
        othersBtn.addEventListener('click', function () {
          state.showOthers = !state.showOthers;
          try { localStorage.setItem(OTHERS_KEY, state.showOthers ? '1' : '0'); } catch (e) { /* kept for this visit only */ }
          if (state.popup) { state.popup.remove(); state.popup = null; }
          paintPicker();
          paintFeed();
          requestDraw();
        });
        othersRow.textContent = '';
        othersRow.appendChild(othersBtn);
        othersRow.hidden = false;
      }
      paintPicker();
    }
    function paintPicker() {
      if (!picker || !allBtn) return;
      allBtn.setAttribute('aria-pressed', state.teams.every(function (t) { return t.shown; }) ? 'true' : 'false');
      state.teams.forEach(function (team) {
        if (!team.btn) return;
        team.btn.setAttribute('aria-pressed', team.shown ? 'true' : 'false');
        team.disc.style.backgroundColor = team.ink;
      });
      if (othersBtn) othersBtn.setAttribute('aria-pressed', state.showOthers ? 'true' : 'false');
      keyOther.hidden = !(state.showOthers && state.others.length);
    }

    // ---- the latest quests, as the replay passes them ----
    var feedShown = '';
    function paintFeed() {
      if (!feed) return;
      var all = [];
      state.teams.forEach(function (team) {
        if (!team.shown) return;
        team.quests.forEach(function (m) { if (m.t <= state.now) all.push({ m: m, team: team }); });
      });
      if (state.showOthers) {
        state.others.forEach(function (o) {
          o.quests.forEach(function (m) { if (m.t <= state.now) all.push({ m: m, team: o, other: true }); });
        });
      }
      // newest sent first, as the times read
      all.sort(function (a, b) { return b.m.sent - a.m.sent || b.m.t - a.m.t; });
      var latest = all.slice(0, 5);
      var sig = latest.map(function (x) { return x.team.name + '|' + x.m.q.key + '|' + (x.m.q.stop || ''); }).join(';') + '|' + clockSig();
      if (sig === feedShown) return;
      feedShown = sig;
      feed.textContent = '';
      if (!latest.length) {
        feed.appendChild(el('li', 'rp-feed-none', 'None yet.'));
        return;
      }
      latest.forEach(function (x) {
        var li = el('li', 'rp-feed-row');
        li.appendChild(el('span', 'rp-feed-time', clock(x.m.sent)));
        var who = el('span', 'rp-feed-team');
        var disc = el('span', x.other ? 'rp-team-disc rp-team-ring' : 'rp-team-disc');
        if (!x.other) disc.style.backgroundColor = x.team.ink;
        disc.setAttribute('aria-hidden', 'true');
        who.appendChild(disc);
        who.appendChild(document.createTextNode(x.team.name));
        li.appendChild(who);
        var what = el('span', 'rp-feed-quest');
        what.appendChild(el('span', 'code', x.m.q.key || x.m.q.code));
        what.appendChild(el('span', 'rp-feed-name', x.m.q.stop || x.m.q.name || ''));
        li.appendChild(what);
        feed.appendChild(li);
      });
    }
    function clockSig() { return hour24() ? '24' : '12'; }

    // ---- the leaderboard at the replay's time ----
    // Every team's points over the day, from the tab's log: a submission
    // counts from when it was sent, and anything the log puts before or
    // after the Quest times frame from the first or the last moment, so
    // the last moment adds up to the tab.
    var BOARD_TOP = 10;
    var BOARD_FULL = 15; // up to this many teams, all of them with no button
    var boardAll = false, boardSig = '';
    state.board = null;
    function buildBoard() {
      var inkOf = {};
      state.teams.forEach(function (t) { inkOf[normName(t.name)] = t.ink; });
      var sentTimes = [];
      state.board = (replay.teams || []).map(function (t) {
        var items = (t.log || []).map(function (i) {
          var at = i.at ? readStamp(i.at, state.from) : NaN;
          if (isFinite(at) && i.sent) sentTimes.push(at);
          return { at: at, edge: isFinite(at) ? '' : i.edge === 'start' ? 'start' : 'end', points: Number(i.points) || 0,
            sent: i.sent ? 1 : 0, accepted: i.accepted ? 1 : 0, t: 0 };
        });
        return { name: t.name, rank: t.rank, dnf: !!t.dnf, ink: inkOf[normName(t.name)] || '', items: items, row: null };
      });
      // the day takes in everything sent, up to three hours either side
      // of the routes
      if (sentTimes.length) {
        var lo = Math.min.apply(null, sentTimes), hi = Math.max.apply(null, sentTimes);
        state.from = Math.max(state.from - 3 * 3600, Math.min(state.from, lo));
        state.to = Math.min(state.to + 3 * 3600, Math.max(state.to, hi));
        state.now = state.to;
      }
      state.board.forEach(function (b) {
        b.items.forEach(function (i) {
          i.t = i.edge === 'start' ? state.from : i.edge === 'end' ? state.to : Math.min(state.to, Math.max(state.from, i.at));
        });
        b.items.sort(function (x, y) { return x.t - y.t; });
      });
    }
    // each team's points and quests sent by time t, best first; level
    // teams share a place, and a team that did not finish or has nothing
    // yet has none
    function standingsAt(t) {
      var rows = state.board.map(function (b) {
        var pts = 0, sent = 0, accepted = 0;
        for (var i = 0; i < b.items.length && b.items[i].t <= t; i++) {
          pts += b.items[i].points;
          sent += b.items[i].sent;
          accepted += b.items[i].accepted;
        }
        return { b: b, pts: Math.round(pts * 100) / 100, sent: sent, accepted: accepted, place: 0 };
      });
      rows.sort(function (x, y) {
        return y.pts - x.pts || (x.b.rank || 1e6) - (y.b.rank || 1e6) || x.b.name.localeCompare(y.b.name);
      });
      var placed = rows.filter(function (r) { return !r.b.dnf && r.pts > 0; });
      placed.forEach(function (r, i) {
        r.place = i && placed[i - 1].pts === r.pts ? placed[i - 1].place : i + 1;
      });
      return rows;
    }
    function fmtPoints(n) { return (Math.round(n * 100) / 100).toLocaleString('en-US', { maximumFractionDigits: 2 }); }
    function boardRow(b) {
      var li = el('li', 'rp-board-row');
      var place = el('span', 'rp-board-place');
      var team = el('span', 'rp-board-team');
      var disc = el('span', b.ink ? 'rp-team-disc' : 'rp-team-disc rp-team-ring');
      if (b.ink) disc.style.backgroundColor = b.ink;
      disc.setAttribute('aria-hidden', 'true');
      team.appendChild(disc);
      team.appendChild(el('span', 'rp-board-name', b.name));
      var pts = el('span', 'rp-board-points');
      li.appendChild(place);
      li.appendChild(team);
      li.appendChild(pts);
      b.row = li;
      return li;
    }
    function fillRow(r) {
      var li = r.b.row;
      var place = li.firstChild;
      place.textContent = '';
      var medal = r.place >= 1 && r.place <= 3;
      // the tab's own: a medal for the first three, the figure in the
      // medal's width for the rest
      var mark = el('span', medal ? 'rank-bullet rank-bullet--' + r.place : 'rank-figure', r.place ? String(r.place) : '\u2013');
      place.appendChild(mark);
      li.lastChild.textContent = fmtPoints(r.pts);
      li.setAttribute('aria-label', (r.place ? 'Place ' + r.place + ', ' : '') + r.b.name + ', ' + fmtPoints(r.pts) + ' points');
    }
    function paintBoard() {
      if (!boardList || !state.board) return;
      var rows = standingsAt(state.now);
      var shown = boardAll || rows.length <= BOARD_FULL ? rows : rows.slice(0, BOARD_TOP);
      var sig = shown.map(function (r) { return r.b.name + ':' + r.pts + ':' + r.place; }).join('|');
      if (sig === boardSig) return;
      boardSig = sig;
      // where each row was, so it can glide from there
      var was = {};
      shown.forEach(function (r) { if (r.b.row && r.b.row.parentNode) was[r.b.name] = r.b.row.getBoundingClientRect().top; });
      boardList.textContent = '';
      shown.forEach(function (r) {
        if (!r.b.row) boardRow(r.b);
        fillRow(r);
        boardList.appendChild(r.b.row);
      });
      if (!reducedMotion()) {
        var moved = [];
        shown.forEach(function (r) {
          if (was[r.b.name] == null) return;
          var dy = was[r.b.name] - r.b.row.getBoundingClientRect().top;
          if (Math.abs(dy) >= 1) moved.push({ row: r.b.row, dy: dy });
        });
        if (moved.length) {
          moved.forEach(function (m) {
            m.row.style.transition = 'none';
            m.row.style.transform = 'translateY(' + m.dy + 'px)';
          });
          void boardList.offsetWidth;
          moved.forEach(function (m) {
            m.row.style.transition = 'transform var(--duration-medium) var(--ease-smooth-out)';
            m.row.style.transform = '';
          });
        }
      }
      boardMore.hidden = rows.length <= BOARD_FULL;
      boardMore.textContent = boardAll ? 'Show Top ' + BOARD_TOP : 'Show All ' + rows.length + ' Teams';
    }
    if (boardMore) {
      boardMore.addEventListener('click', function () {
        boardAll = !boardAll;
        boardSig = '';
        paintBoard();
      });
    }

    // ---- what had been sent by then ----
    var counted = { sent: null, accepted: null };
    var chartRows = [];
    function paintStats() {
      if (!statsFigures || !state.board) return;
      var sent = 0, accepted = 0;
      state.board.forEach(function (b) {
        for (var i = 0; i < b.items.length && b.items[i].t <= state.now; i++) {
          sent += b.items[i].sent;
          accepted += b.items[i].accepted;
        }
      });
      if (sent !== counted.sent || accepted !== counted.accepted) {
        counted.sent = sent;
        counted.accepted = accepted;
        statsFigures.textContent = '';
        var figure = window.scs && window.scs.figure;
        [[sent, 'Sent'], [accepted, 'Accepted']].forEach(function (f) {
          statsFigures.appendChild(figure ? figure(f) : el('li', 'figure', f[0] + ' ' + f[1]));
        });
      }
      // the bars after the replay's time fade
      [].forEach.call(chartHost.querySelectorAll('.hour-col'), function (col, i) {
        col.classList.toggle('is-ahead', !!chartRows[i] && chartRows[i].start > state.now);
      });
    }
    // a bar a quarter hour, from what every team sent
    function drawChart() {
      if (!chartHost || !state.board || !window.scs || !window.scs.hourBars) return;
      var STEP = 900;
      var first = Math.floor(state.from / STEP) * STEP;
      chartRows = [];
      for (var t = first; t <= state.to; t += STEP) {
        chartRows.push({ hour: new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' '), sent: 0, accepted: 0, start: t });
      }
      state.board.forEach(function (b) {
        b.items.forEach(function (i) {
          if (!i.sent) return;
          var row = chartRows[Math.max(0, Math.min(chartRows.length - 1, Math.floor((i.t - first) / STEP)))];
          if (!row) return;
          row.sent += 1;
          row.accepted += i.accepted;
        });
      });
      window.scs.hourBars(chartHost, chartRows, { key: 'sent', inner: 'accepted', step: 15, empty: 'Nothing was sent.' });
      paintStats();
    }
    if (chartHost) {
      document.addEventListener('scs-dates-changed', drawChart);
      var chartTimer = 0;
      window.addEventListener('resize', function () {
        window.clearTimeout(chartTimer);
        chartTimer = window.setTimeout(drawChart, 200);
      });
    }

    // ---- the wheel, as on the quest map ----
    // Every wheel over the map is the map's, in the page and in full
    // screen: a trackpad pinch (ctrl+wheel) zooms by what the fingers did,
    // a plain wheel or two-finger scroll more gently, a mouse notch glides
    // out over a short ease, and when the input stops the zoom carries on
    // briefly and slows. In the page, a scroll of the page that runs on
    // over the map stays the page's until the pointer rests on the map.
    var wheel = { instant: 0, pending: 0, vel: 0, coasting: false, at: null, event: null,
      lastInput: -1e9, samples: [], frame: 0, lastFrame: 0, pageAt: -1e9 };
    function wheelStop() {
      if (wheel.frame) window.cancelAnimationFrame(wheel.frame);
      wheel.frame = 0;
      wheel.instant = 0;
      wheel.pending = 0;
      wheel.vel = 0;
      wheel.coasting = false;
      wheel.samples = [];
      wheel.lastFrame = 0;
    }
    function wheelSpeed(now) {
      var last = wheel.samples[wheel.samples.length - 1];
      if (!last || now - last[0] > 100) return 0;
      var first = last;
      for (var i = wheel.samples.length - 1; i >= 0 && last[0] - wheel.samples[i][0] <= 100; i--) first = wheel.samples[i];
      var span = last[0] - first[0];
      if (span < 16) return 0;
      return Math.max(-0.003, Math.min(0.003, (last[1] - first[1]) / span));
    }
    function wheelStep(now) {
      wheel.frame = 0;
      var map = state.map;
      if (!map || !wheel.at) { wheelStop(); return; }
      var dt = wheel.lastFrame ? Math.min(50, now - wheel.lastFrame) : 16;
      wheel.lastFrame = now;
      var z = map.getZoom();
      var dz = wheel.instant;
      wheel.instant = 0;
      if (wheel.pending) {
        var take = Math.abs(wheel.pending) < 0.002 ? wheel.pending : wheel.pending * (1 - Math.exp(-dt / 70));
        dz += take;
        wheel.pending -= take;
      }
      var inputLive = now - wheel.lastInput < 60;
      if (dz) {
        wheel.samples.push([now, z + dz]);
        while (wheel.samples.length && now - wheel.samples[0][0] > 200) wheel.samples.shift();
      } else if (!inputLive && !wheel.coasting) {
        wheel.vel = wheelSpeed(now);
        wheel.coasting = true;
      }
      if (wheel.coasting) {
        dz = wheel.vel * dt;
        wheel.vel *= Math.exp(-dt / 100);
        if (Math.abs(wheel.vel) < 0.0003) wheel.vel = 0;
      }
      if (dz) {
        map.easeTo({ zoom: z + dz, around: map.unproject(wheel.at), duration: 0, essential: true }, { originalEvent: wheel.event });
        if (wheel.coasting && map.getZoom() === z) wheel.vel = 0;
      }
      if (wheel.pending || inputLive || (wheel.coasting && wheel.vel)) wheel.frame = window.requestAnimationFrame(wheelStep);
      else wheelStop();
    }
    document.addEventListener('wheel', function (e) {
      if (!mapBox.contains(e.target)) wheel.pageAt = window.performance.now();
    }, { passive: true, capture: true });
    mapBox.addEventListener('wheel', function (e) {
      if (!state.map) return;
      var now = window.performance.now();
      if (!isFull() && !e.ctrlKey && now - wheel.pageAt < 300 && now - wheel.lastInput > 300) {
        wheel.pageAt = now; // still the page's scroll: let it carry on
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      var r = mapBox.getBoundingClientRect();
      var px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1);
      var dz = Math.max(-2, Math.min(2, e.ctrlKey ? -px / 69.3 : -px / 150));
      if (Math.abs(dz) > 0.2) wheel.pending += dz;
      else wheel.instant += dz;
      wheel.coasting = false;
      wheel.vel = 0;
      wheel.at = [e.clientX - r.left, e.clientY - r.top];
      wheel.event = e;
      wheel.lastInput = now;
      if (!wheel.frame) wheel.frame = window.requestAnimationFrame(wheelStep);
    }, { passive: false, capture: true });
    mapBox.addEventListener('mousedown', wheelStop);
    mapBox.addEventListener('touchstart', wheelStop, { passive: true });

    // ---- full screen ----
    var FULL = 'rp-map-full';
    var fullLayer = null;
    var morphTimer = 0;
    // where the moved parts go back to, in their order under the map
    var homeParts = [key, bar, picker, othersRow, pairBox].filter(Boolean);
    function isFull() { return document.documentElement.classList.contains(FULL); }
    function settleMorph() {
      if (morphTimer) { window.clearTimeout(morphTimer); morphTimer = 0; }
      card.style.transition = '';
      card.style.transform = '';
      card.style.transformOrigin = '';
      card.style.zIndex = '';
    }
    // ---- the pane on a phone ----
    // The quest map's search panel's physics with two stops, its bar and
    // half the screen (less when what is in it is shorter, and what does
    // not fit scrolls): it follows the finger, gives at either end like
    // a rubber band, and settles where the flick was heading. The bar's
    // chevron says which way it is going. A computer's column does none
    // of this.
    var sheetMq = window.matchMedia('(max-width: 930px)');
    var paneState = 'bar';
    var paneLayer = null;
    function paneSizes() {
      var cs = window.getComputedStyle(pane);
      var barH = Math.ceil(paneGrab.offsetHeight + paneHead.offsetHeight +
        (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0));
      var openH = Math.min(barH + paneMore.scrollHeight, Math.round(window.innerHeight * 0.52));
      return { bar: barH, open: Math.max(barH, openH) };
    }
    // the map stops where the bar starts
    function measurePane() {
      var sizes = isFull() ? paneSizes() : { bar: 0, open: 0 };
      document.documentElement.style.setProperty('--rp-pane-h', sizes.bar + 'px');
      pane.style.setProperty('--rp-pane-bar', sizes.bar + 'px');
      pane.style.setProperty('--rp-pane-open', sizes.open + 'px');
      return sizes;
    }
    function setPaneState(next) {
      paneState = next;
      measurePane();
      pane.classList.toggle('is-open', next === 'open');
      paneGrab.setAttribute('aria-expanded', next === 'open' ? 'true' : 'false');
      if (next === 'open' && !paneLayer && window.scsBackLayer) {
        paneLayer = window.scsBackLayer.arm(function () { paneLayer = null; setPaneState('bar'); });
      } else if (next === 'bar' && paneLayer) {
        var layer = paneLayer;
        paneLayer = null;
        window.scsBackLayer.disarm(layer);
      }
    }
    function setChevron(dir) {
      paneGrab.classList.toggle('is-up', dir === 'up');
      paneGrab.classList.toggle('is-vee', dir === 'vee');
    }
    function resetChevron() {
      setChevron(null);
      paneGrab.classList.remove('is-stretching');
      paneGrab.style.setProperty('--stretch', '1');
    }
    function rubberBand(excess, limit) {
      return (1 - 1 / (excess * 0.55 / limit + 1)) * limit;
    }
    // where the pane goes see-through while the map is moved, until a
    // finger or the mouse lands on it or a control over the map
    function unfade() { pane.classList.remove('is-faded'); }
    var drag = { startY: null, mode: null, startH: 0, fromMore: false, vel: 0, lastY: 0, lastT: 0, sizes: null, mouse: false, moved: false };
    function startDrag(y) {
      drag.startY = y;
      drag.lastY = y;
      drag.lastT = Date.now();
      drag.vel = 0;
      drag.sizes = measurePane();
      drag.startH = pane.getBoundingClientRect().height;
    }
    function trackDrag(y) {
      var now = Date.now();
      drag.vel = (y - drag.lastY) / Math.max(now - drag.lastT, 1);
      drag.lastY = y;
      drag.lastT = now;
    }
    function applyDrag(dy) {
      var sizes = drag.sizes;
      var raw = drag.startH - dy;
      var h = raw;
      if (raw > sizes.open) h = sizes.open + rubberBand(raw - sizes.open, 40);
      else if (raw < sizes.bar) h = sizes.bar - rubberBand(sizes.bar - raw, 30);
      pane.style.height = h + 'px';
      // at either end the chevron lies flat and stretches with the pull
      var overTop = raw > sizes.open ? h - sizes.open : 0;
      var underBottom = raw < sizes.bar ? sizes.bar - h : 0;
      var band = overTop || underBottom;
      if (raw >= sizes.open - 1 || raw <= sizes.bar + 1) setChevron(null);
      else if (Math.abs(drag.vel) > 0.05) setChevron(drag.vel > 0 ? 'vee' : 'up');
      if (band > 0) {
        paneGrab.classList.add('is-stretching');
        paneGrab.style.setProperty('--stretch', String(1 + (band / (overTop ? 40 : 30)) * 0.35));
      } else if (paneGrab.classList.contains('is-stretching')) {
        paneGrab.classList.remove('is-stretching');
        paneGrab.style.setProperty('--stretch', '1');
      }
    }
    function beginDragHere(y) {
      drag.mode = 'drag';
      drag.startY = y;
      drag.startH = pane.getBoundingClientRect().height;
      pane.classList.add('is-dragging');
    }
    function endDrag() {
      var wasDrag = drag.mode === 'drag';
      drag.startY = null;
      drag.mode = null;
      resetChevron();
      if (!wasDrag) return;
      var sizes = drag.sizes;
      var current = pane.getBoundingClientRect().height;
      var projected = current - Math.max(-3, Math.min(3, drag.vel)) * 160;
      // the height transition carries it on from where it was let go
      pane.classList.remove('is-dragging');
      setPaneState(projected > (sizes.bar + sizes.open) / 2 ? 'open' : 'bar');
      void pane.offsetHeight;
      pane.style.height = '';
    }
    pane.addEventListener('touchstart', function (e) {
      unfade();
      drag.startY = null;
      if (!sheetMq.matches || !isFull() || e.touches.length !== 1) return;
      // the slider over the day keeps its own drag
      if (e.target.closest && e.target.closest('.rp-scrub')) return;
      startDrag(e.touches[0].clientY);
      drag.fromMore = !!(e.target.closest && e.target.closest('.rp-pane-more'));
      drag.mode = e.target.closest && e.target.closest('.rp-pane-grab') ? 'drag' : null;
      if (drag.mode === 'drag') pane.classList.add('is-dragging');
    }, { passive: true });
    pane.addEventListener('touchmove', function (e) {
      if (drag.startY === null || e.touches.length !== 1) return;
      var cy = e.touches[0].clientY;
      trackDrag(cy);
      var dy = cy - drag.startY;
      if (drag.mode === null) {
        if (Math.abs(dy) < 8) return; // still a tap
        if (drag.fromMore) {
          // what is in the pane scrolls once it is open; a pull down at
          // the top of it moves the pane instead
          var canScroll = paneState === 'open' && paneMore.scrollHeight > paneMore.clientHeight;
          if (dy > 0) drag.mode = paneMore.scrollTop <= 0 ? 'drag' : 'scroll';
          else drag.mode = canScroll ? 'scroll' : 'drag';
        } else {
          drag.mode = 'drag';
        }
        if (drag.mode === 'drag') { beginDragHere(cy); dy = 0; }
      } else if (drag.mode === 'scroll' && dy > 0 && paneMore.scrollTop <= 0) {
        beginDragHere(cy);
        dy = 0;
      }
      if (drag.mode !== 'drag') return;
      if (e.cancelable) e.preventDefault();
      applyDrag(dy);
    }, { passive: false });
    pane.addEventListener('touchend', endDrag);
    pane.addEventListener('touchcancel', endDrag);
    pane.addEventListener('pointerdown', unfade);
    // a rule under the controls once what is below them has scrolled
    paneMore.addEventListener('scroll', function () {
      pane.classList.toggle('is-scrolled', paneMore.scrollTop > 0);
    }, { passive: true });
    card.addEventListener('pointerdown', function (e) {
      if (e.target.closest && !e.target.closest('.maplibregl-canvas-container')) unfade();
    }, true);
    // a mouse drags the bar too, and a plain click on it opens or closes
    // the pane; a drag swallows the click it ends with
    paneGrab.addEventListener('mousedown', function (e) {
      if (e.button !== 0 || !sheetMq.matches) return;
      unfade();
      e.preventDefault();
      startDrag(e.clientY);
      drag.mode = 'drag';
      drag.mouse = true;
      drag.moved = false;
      pane.classList.add('is-dragging');
    });
    document.addEventListener('mousemove', function (e) {
      if (!drag.mouse) return;
      trackDrag(e.clientY);
      var dy = e.clientY - drag.startY;
      if (Math.abs(dy) > 3) drag.moved = true;
      applyDrag(dy);
    });
    document.addEventListener('mouseup', function () {
      if (!drag.mouse) return;
      drag.mouse = false;
      endDrag();
      if (drag.moved) window.setTimeout(function () { drag.moved = false; }, 0);
    });
    paneGrab.addEventListener('click', function () {
      if (drag.moved) { drag.moved = false; return; }
      setPaneState(paneState === 'open' ? 'bar' : 'open');
    });
    function setFull(on, viaBack) {
      var was = isFull();
      if (on === was) return;
      settleMorph();
      var first = card.getBoundingClientRect();
      if (on) {
        paneHead.appendChild(bar);
        [key, picker, othersRow, pairBox].forEach(function (n) { if (n) paneMore.appendChild(n); });
      } else {
        if (paneState === 'open') setPaneState('bar');
        homeParts.forEach(function (n) { root.insertBefore(n, pane); });
        pane.style.height = '';
        unfade();
      }
      document.documentElement.classList.toggle(FULL, on);
      root.classList.toggle('is-full', on);
      fullBtn.setAttribute('aria-label', on ? 'Exit full screen map' : 'Full screen map');
      measurePane();
      // the slider's marks for the width it now has
      layoutTicks();
      paneMore.scrollTop = 0;
      pane.classList.remove('is-scrolled');
      if (on && window.scsBackLayer) {
        fullLayer = window.scsBackLayer.arm(function () { setFull(false, true); });
      } else if (!on && fullLayer) {
        var layer = fullLayer;
        fullLayer = null;
        // after the pane's own entry has gone, so this one is the top
        if (!viaBack && window.scsBackLayer) {
          window.scsBackLayer.after(function () { window.scsBackLayer.disarm(layer); });
        }
      }
      // the card grows from where it sat in the page, and back
      var last = card.getBoundingClientRect();
      if (!reducedMotion() && first.width > 0 && last.width > 0) {
        card.style.transformOrigin = 'top left';
        card.style.transition = 'none';
        card.style.zIndex = on ? '' : '1300';
        card.style.transform = 'translate(' + (first.left - last.left) + 'px,' + (first.top - last.top) + 'px) ' +
          'scale(' + (first.width / last.width) + ',' + (first.height / last.height) + ')';
        void card.offsetWidth;
        card.style.transition = 'transform 320ms cubic-bezier(0.2, 0.85, 0.3, 1)';
        card.style.transform = '';
        morphTimer = window.setTimeout(settleMorph, 340);
      }
      if (!on) root.scrollIntoView({ block: 'nearest' });
      window.setTimeout(function () { if (state.map) state.map.resize(); }, 20);
      window.setTimeout(function () { if (state.map) state.map.resize(); }, 360);
      // the chart measures its labels against the width it is drawn at
      window.setTimeout(drawChart, 360);
    }
    fullBtn.addEventListener('click', function () { setFull(!isFull()); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !isFull() || e.defaultPrevented) return;
      if (fullLayer && window.scsBackLayer && !window.scsBackLayer.isTop(fullLayer)) return;
      e.preventDefault();
      setFull(false);
    });
    window.addEventListener('resize', function () { if (isFull()) measurePane(); });

    return {
      ready: data,
      teams: function () { return state.teams.map(function (t) { return t.name; }); },
      stop: function () { setPlaying(false); }
    };
  }

  // `preload` starts the map's library loading before the replay's data
  // has arrived; `start` asks for it again and gets the same promise
  window.SCSReplay = { start: start, preload: function () { loadMapLibre().catch(function () { /* start says so */ }); } };
})();
