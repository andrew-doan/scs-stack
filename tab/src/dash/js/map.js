// The Map tab: where each team last sent proof from.
(function (dash) {
  // core.js
  var api = dash.api, el = dash.el, fill = dash.fill, fmtTime = dash.fmtTime, h = dash.h, row = dash.row,
    session = dash.session, SITE = dash.SITE, state = dash.state, teamShown = dash.teamShown;

  dash.loadMap = loadMap;
  dash.renderMap = renderMap;
  // the Routes tab draws on the same map
  dash.loadMapLib = loadMapLib;
  dash.teamMapStyle = teamMapStyle;
  dash.addTransit = addTransit;

  // ---- map ----
  // Where each team last sent proof from (the pin of its newest
  // submission on a quest that has one) and when it last sent anything.
  // MapLibre, the base style and its fonts come from the site, as the
  // HEIC decoder does; the tiles from the site's own tile server, or
  // OpenStreetMap's when that one cannot be reached from here.
  var MAP_TILES = 'https://tiles.scs.andyrew.space/my_area/{z}/{x}/{y}.mvt';
  var OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  var MAP_BOUNDS = dash.MAP_BOUNDS = [[149.9, -34.65], [152.1, -32.7]];
  var FRESH_MINS = 30, STALE_MINS = 90;
  var MAP_POLL = 60000;
  // the TfNSW line colours the shapes carry, or their mode's
  var TRANSIT_INK = ['to-color', ['get', 'c'],
    ['match', ['get', 'm'], 'metro', '#168388', 'tram', '#ee343e', 'ferry', '#5ab031', 'bus', '#ffb81c', '#f99d1c']];
  state.teamMap = null;
  var tm = { lib: null, map: null, markers: [], popup: null, fitted: false, timer: null, picked: null };

  function mapStamp(utc) {
    var m = String(utc || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?/);
    if (!m) return NaN;
    return new Date(m[1] + 'T' + m[2] + (m[3] || ':00') + 'Z').getTime();
  }
  function minsAgo(utc) {
    var t = mapStamp(utc);
    return isNaN(t) ? null : Math.max(0, Math.round((Date.now() - t) / 60000));
  }
  function agoWords(utc) {
    var mins = minsAgo(utc);
    if (mins == null) return '';
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' min ago';
    var hrs = Math.floor(mins / 60);
    if (hrs >= 24) return Math.floor(hrs / 24) + 'd ago';
    return hrs + 'h' + (mins % 60 ? ' ' + (mins % 60) + 'm' : '') + ' ago';
  }
  // a time today is a clock time; anything older carries its date
  function whenText(utc) {
    var t = mapStamp(utc);
    if (isNaN(t)) return '';
    var d = new Date(t);
    if (d.toDateString() === new Date().toDateString()) {
      return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }
    return fmtTime(utc);
  }
  function ageClass(utc) {
    var mins = minsAgo(utc);
    if (mins != null && mins < FRESH_MINS) return 'tm-fresh';
    if (mins != null && mins < STALE_MINS) return 'tm-mid';
    return 'tm-old';
  }

  function loadMapLib() {
    if (tm.lib) return tm.lib;
    tm.lib = new Promise(function (resolve, reject) {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = SITE + '/assets/maplibre/maplibre-gl.css';
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = SITE + '/assets/maplibre/maplibre-gl.js';
      s.onload = function () { if (window.maplibregl) resolve(window.maplibregl); else reject(new Error('no maplibre')); };
      s.onerror = function () { reject(new Error('maplibre did not load')); };
      document.head.appendChild(s);
    });
    tm.lib.catch(function () { tm.lib = null; });
    return tm.lib;
  }
  function probeTiles() {
    return fetch(MAP_TILES.replace('{z}/{x}/{y}', '0/0/0')).then(function (r) {
      if (!r.ok) throw new Error('tiles ' + r.status);
      return MAP_TILES;
    });
  }
  function getJson(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(url + ' ' + r.status); return r.json(); });
  }
  // the site's own basemap over its own tiles, else OpenStreetMap's pictures
  function teamMapStyle() {
    return Promise.all([probeTiles(), getJson(SITE + '/assets/maplibre/style.json')]).then(function (got) {
      var style = got[1];
      style.sources.protomaps.tiles = [got[0]];
      style.glyphs = SITE + '/assets/maplibre/fonts/{fontstack}/{range}.pbf';
      return style;
    }, function () {
      return {
        version: 8,
        sources: { osm: { type: 'raster', tiles: [OSM_TILES], tileSize: 256, maxzoom: 19, attribution: '&copy; OpenStreetMap contributors' } },
        layers: [{ id: 'osm', type: 'raster', source: 'osm' }]
      };
    });
  }
  // fetched alongside the style and added as soon as the style is in,
  // rather than on load, which waits for every tile on the screen.
  // opts.under names a layer to draw them under (the Routes tab's route),
  // opts.opacity how strongly.
  function addTransit(map, opts) {
    var data = null, styled = false;
    var o = opts || {};
    function add() {
      if (!data || !styled || map.getSource('transit')) return;
      map.addSource('transit', { type: 'geojson', data: data });
      // under the basemap's names, so a street stays readable
      var before = o.under && map.getLayer(o.under) ? o.under : map.getLayer('address_label') ? 'address_label' : undefined;
      map.addLayer({
        id: 'transit', type: 'line', source: 'transit',
        filter: ['all', ['!=', ['geometry-type'], 'Point'], ['!=', ['get', 'm'], 'bus']],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': TRANSIT_INK, 'line-opacity': o.opacity || 0.7, 'line-width': ['interpolate', ['linear'], ['zoom'], 9, 2, 15, 4] }
      }, before);
    }
    function ready() { styled = true; add(); }
    map.once('style.load', ready);
    map.once('load', ready);
    getJson(SITE + '/assets/transit.geojson').then(function (d) { data = d; add(); }).catch(function () {});
  }
  function buildTeamMap() {
    return Promise.all([loadMapLib(), teamMapStyle()]).then(function (got) {
      if (tm.map) return tm.map;
      var lib = got[0];
      tm.map = new lib.Map({
        container: 'team-map', style: got[1], center: [151.12, -33.87], zoom: 10,
        maxBounds: MAP_BOUNDS, attributionControl: { compact: true }, dragRotate: false, pitchWithRotate: false,
        // on a touch screen one finger scrolls the page past the map and two move it
        cooperativeGestures: window.matchMedia('(pointer: coarse)').matches
      });
      tm.map.touchZoomRotate.disableRotation();
      tm.map.addControl(new lib.NavigationControl({ showCompass: false }), 'top-right');
      addTransit(tm.map);
      tm.map.on('moveend', declutter);
      return tm.map;
    });
  }

  function loadMap() {
    if (tm.map) tm.map.resize();
    api('/api/console/map').then(function (d) {
      if (!d.ok) return;
      var first = !state.teamMap;
      state.teamMap = d;
      renderMapRows(first);
      el('map-error').classList.add('hidden');
      return buildTeamMap().then(function () { tm.map.resize(); drawPins(mapTeams()); });
    }).catch(function () {
      el('map-error').textContent = 'The map could not be drawn. Check the connection and press Refresh.';
      el('map-error').classList.remove('hidden');
    });
    clearTimeout(tm.timer);
    tm.timer = setTimeout(function again() {
      // another tab open, or signed out: it starts again when the tab is opened
      if (el('view-map').classList.contains('hidden') || !session()) return;
      if (document.visibilityState === 'visible') loadMap();
      else tm.timer = setTimeout(again, MAP_POLL);
    }, MAP_POLL);
  }
  el('map-refresh').addEventListener('click', loadMap);

  // the teams to draw: the quietest first, since that is who to look for
  function mapTeams() {
    return state.teamMap.teams.filter(teamShown).slice().sort(function (a, b) {
      var x = mapStamp(a.last_sent), y = mapStamp(b.last_sent);
      if (isNaN(x) !== isNaN(y)) return isNaN(x) ? -1 : 1;
      if (!isNaN(x) && x !== y) return x - y;
      return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
    });
  }
  function renderMap() {
    if (!state.teamMap) return;
    renderMapRows(false);
    drawPins(mapTeams());
  }
  function renderMapRows(animate) {
    var rows = mapTeams().map(function (t) {
      var sent = h('td');
      if (t.last_sent) {
        sent.appendChild(document.createTextNode(agoWords(t.last_sent)));
        sent.appendChild(h('span', 'muted', whenText(t.last_sent)));
      } else sent.appendChild(h('span', 'muted', 'Nothing yet'));
      var pin = h('td');
      var at = h('td');
      if (t.seen) {
        pin.appendChild(document.createTextNode(t.seen.place));
        pin.appendChild(h('span', 'muted', t.seen.quest + ' ' + t.seen.quest_name));
        var swatch = h('span', 'tm-swatch ' + ageClass(t.seen.at));
        swatch.style.display = 'inline-block';
        swatch.style.marginRight = '6px';
        at.appendChild(swatch);
        at.appendChild(document.createTextNode(agoWords(t.seen.at)));
        at.appendChild(h('span', 'muted', whenText(t.seen.at) + (t.seen.organiser ? ', by an organiser' : '')));
      } else {
        pin.appendChild(h('span', 'muted', 'No pin yet'));
      }
      var tr = row([h('td', null, t.name + (t.hidden ? ' (hidden)' : '')), sent, pin, at]);
      if (t.hidden) tr.classList.add('is-hidden-team');
      if (t.seen) {
        tr.classList.add('is-placed');
        tr.addEventListener('click', function () { showTeam(t); });
      }
      return tr;
    });
    if (animate) fill(el('map-rows'), rows);
    else { el('map-rows').textContent = ''; rows.forEach(function (r) { el('map-rows').appendChild(r); }); }
  }

  // one disc per place, carrying how many teams are there when it is
  // more than one; its colour is how long ago the newest of them sent
  // from it
  function drawPins(teams) {
    if (!tm.map) return;
    var lib = window.maplibregl;
    tm.markers.forEach(function (m) { m.marker.remove(); });
    tm.markers = [];
    var spots = {};
    var order = [];
    teams.forEach(function (t) {
      if (!t.seen) return;
      var key = t.seen.lat + ',' + t.seen.lng;
      if (!spots[key]) { spots[key] = { seen: t.seen, teams: [] }; order.push(key); }
      spots[key].teams.push(t);
    });
    order.forEach(function (key) {
      var spot = spots[key];
      spot.teams.sort(function (a, b) { return mapStamp(b.seen.at) - mapStamp(a.seen.at); });
      var newest = spot.teams[0].seen.at;
      var pinEl = h('button', 'tm-pin ' + ageClass(newest));
      pinEl.type = 'button';
      pinEl.setAttribute('aria-label', spot.teams.map(function (t) { return t.name; }).join(', ') + ', ' + spot.seen.place);
      pinEl.appendChild(h('span', 'tm-disc', spot.teams.length > 1 ? String(spot.teams.length) : ''));
      var label = h('span', 'tm-label');
      spot.teams.slice(0, 3).forEach(function (t) { label.appendChild(h('span', null, t.name)); });
      if (spot.teams.length > 3) label.appendChild(h('span', 'tm-more', (spot.teams.length - 3) + ' more'));
      pinEl.appendChild(label);
      var marker = new lib.Marker({ element: pinEl }).setLngLat([spot.seen.lng, spot.seen.lat]).addTo(tm.map);
      pinEl.addEventListener('click', function (e) { e.stopPropagation(); openSpot(spot); });
      pinEl.addEventListener('mouseenter', function () { pinEl.style.zIndex = 3; });
      pinEl.addEventListener('mouseleave', function () { pinEl.style.zIndex = ''; });
      tm.markers.push({ marker: marker, label: label, spot: spot, at: mapStamp(newest) });
    });
    if (!tm.fitted && order.length) {
      tm.fitted = true;
      var b = new lib.LngLatBounds();
      order.forEach(function (key) { b.extend([spots[key].seen.lng, spots[key].seen.lat]); });
      // the names sit to the right of their discs
      var right = Math.min(170, Math.round(el('team-map').clientWidth * 0.3));
      tm.map.fitBounds(b, { padding: { top: 50, bottom: 50, left: 40, right: right }, maxZoom: 14, duration: 0 });
    }
    declutter();
  }

  // names that would sit on each other: the newest keeps its label and
  // the rest show theirs on hover
  function declutter() {
    var kept = [];
    tm.markers.slice().sort(function (a, b) { return b.at - a.at; }).forEach(function (m) {
      m.label.classList.remove('is-off');
      var r = m.label.getBoundingClientRect();
      var hit = kept.some(function (k) {
        return r.left < k.right + 4 && r.right + 4 > k.left && r.top < k.bottom + 2 && r.bottom + 2 > k.top;
      });
      if (hit) m.label.classList.add('is-off');
      else kept.push(r);
    });
  }

  function openSpot(spot) {
    var lib = window.maplibregl;
    var box = h('div', 'tm-pop');
    box.appendChild(h('strong', null, spot.seen.place));
    spot.teams.forEach(function (t) {
      var part = h('div', 'tm-pop-team');
      part.appendChild(h('strong', null, t.name));
      part.appendChild(h('div', null, t.seen.quest + ' ' + t.seen.quest_name));
      part.appendChild(h('div', 'muted', (t.seen.organiser ? 'Recorded by an organiser ' : 'Sent from here ') +
        whenText(t.seen.at) + ', ' + agoWords(t.seen.at)));
      if (t.last_sent && t.last_sent !== t.seen.at) {
        part.appendChild(h('div', 'muted', 'Last sent anything ' + whenText(t.last_sent) + ', ' + agoWords(t.last_sent)));
      }
      box.appendChild(part);
    });
    if (tm.popup) tm.popup.remove();
    tm.popup = new lib.Popup({ offset: 16, maxWidth: '280px', focusAfterOpen: false })
      .setLngLat([spot.seen.lng, spot.seen.lat]).setDOMContent(box).addTo(tm.map);
  }
  function showTeam(t) {
    if (!tm.map || !t.seen) return;
    var hit = tm.markers.filter(function (m) { return m.spot.teams.indexOf(t) !== -1; })[0];
    tm.markers.forEach(function (m) { m.marker.getElement().classList.toggle('is-picked', m === hit); });
    tm.map.flyTo({ center: [t.seen.lng, t.seen.lat], zoom: Math.max(tm.map.getZoom(), 13) });
    if (hit) openSpot(hit.spot);
    el('team-map').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
})(window.dash);
