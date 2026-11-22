// The quest page's script, part four of five: the map — its style, pins,
// transit lines, taps and zoom — and the full-screen map.
(window.scsQuestList = window.scsQuestList || { parts: [] }).parts.push(function (ql) {
  'use strict';

  // from the parts before this one
  var MAP_STYLE_URL = ql.MAP_STYLE_URL;
  var MAP_GLYPHS = ql.MAP_GLYPHS;
  var QUESTS = ql.QUESTS;
  var state = ql.state;
  var siteColor = ql.siteColor;
  var overlay = ql.overlay;
  var sheetMq = ql.sheetMq;
  var isSheet = ql.isSheet;
  var syncPop = ql.syncPop;
  var closeDetail = ql.closeDetail;
  var sheetStop = ql.sheetStop;
  var frameAboveCard = ql.frameAboveCard;
  var sheet = ql.sheet;
  var syncMarkInks = ql.syncMarkInks;
  var placePill = ql.placePill;
  var mapBox = ql.mapBox;

  // functions the other parts call
  ql.discoverTileUrl = discoverTileUrl;
  ql.showMapShot = showMapShot;
  ql.dropMapShot = dropMapShot;
  ql.watchMapShot = watchMapShot;
  ql.mapDrawnBefore = mapDrawnBefore;
  ql.keptView = keptView;
  ql.keepView = keepView;
  ql.syncPinGroups = syncPinGroups;
  ql.watchCounts = watchCounts;
  ql.redrawCounts = redrawCounts;
  ql.loadBaseStyle = loadBaseStyle;
  ql.featureSet = featureSet;
  ql.setMapData = setMapData;
  ql.buildStyle = buildStyle;
  ql.paintMapGround = paintMapGround;
  ql.repaintMap = repaintMap;
  ql.fetchTransit = fetchTransit;
  ql.syncTransit = syncTransit;
  ql.mapTip = mapTip;
  ql.hideHoverTip = hideHoverTip;
  ql.hoverAt = hoverAt;
  ql.onMapClick = onMapClick;
  ql.installTapZoom = installTapZoom;
  ql.wheelStop = wheelStop;
  ql.filtersArePanel = filtersArePanel;
  ql.syncDrawer = syncDrawer;
  ql.setFiltersOpen = setFiltersOpen;
  ql.applyControlLift = applyControlLift;
  ql.positionMapControls = positionMapControls;
  ql.setMapFull = setMapFull;
  ql.afterDrawerCloses = afterDrawerCloses;

  // ---------- The map ----------
  // MapLibre GL draws the map with WebGL: the vector tiles, the transport lines, the pins and the
  // you-are-here dot are layers of one style on the graphics card, so a
  // pan or a zoom moves one picture rather than redrawing a canvas for
  // every layer. MapLibre, the base style and the label glyphs are all
  // in assets/maplibre/. The base style is the Protomaps basemap
  // (@protomaps/basemaps) with its icon layers taken out, and its
  // colours are replaced from MAP_PALETTES as the page builds the style.
  //
  // The tiles come from our own Protomaps server (a Cloudflare worker in
  // front of the my_area.pmtiles archive). No commercial tile service,
  // no API key. If the tile host does not answer (outage, CORS) the map
  // falls back to standard OSM raster tiles. The host must match
  // TILE_HOSTS in sw.js or the tiles a device downloads are not kept.
  var TILE_URL = 'https://tiles.scs.andyrew.space/my_area/{z}/{x}/{y}.mvt';
  var OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  // Roughly Lithgow to the west, Newcastle to the north, Wollongong to
  // the south, and the sea: panning stops here. [west, south], [east, north]
  var MAP_BOUNDS = [[149.9, -34.65], [152.1, -32.7]];
  var MAP_CENTER = [151.05, -33.85];

  // the z0 world tile: tiny, and every archive has one
  // Two tries, four seconds each: the map waits on this.
  function discoverTileUrl() {
    function probe(left) {
      var stop = new AbortController();
      var timer = setTimeout(function () { stop.abort(); }, 4000);
      return fetch(TILE_URL.replace('{z}/{x}/{y}', '0/0/0'), { signal: stop.signal }).then(function (res) {
        clearTimeout(timer);
        if (!res.ok) throw new Error('tile probe ' + res.status);
        return TILE_URL;
      }).catch(function (err) {
        clearTimeout(timer);
        if (left > 0) return probe(left - 1);
        throw err;
      });
    }
    return probe(1);
  }

  function loadBaseStyle() {
    return window.scs.fetch(MAP_STYLE_URL).then(function (r) {
      if (!r.ok) throw new Error('map style ' + r.status);
      return r.json();
    });
  }

  // ---------- The map's own colours ----------
  // The basemap's stock colours are a warm paper with blue water, and a
  // map in them read as a widget dropped onto the page. So every layer
  // of it is repainted from the palette below.
  //
  // What it is drawn to do is recede. The quest pins, the you-are-here
  // dot and the transit overlay (the TfNSW line colours, carried by the
  // geojson) sit on top and have to be the loudest things on it. So the
  // land is a grey a shade under the page, roads are white ribbons with
  // the width saying which class a road is, water is a pale slate, parks
  // a muted green, and every other use of land a tint of the grey. Names
  // are the page's inks with a halo of whatever they sit on, so a name
  // crossing a park or the harbour stays readable. Dark is the same
  // drawing on the dark card, with roads, water and parks lifted far
  // enough off the land to be told apart, and white stations.
  var MAP_PALETTES = {
    light: {
      land: '#e7e7e7', water: '#c9d6dc',
      park: '#d8e1cf', parkLight: '#e0e6d7', wood: '#d1dcc7', scrub: '#e0e5d6',
      sand: '#e9e1cd', beach: '#ece3c9',
      hospital: '#eae0dc', industrial: '#e1e1e1', school: '#e8e2d5', zoo: '#dfe4d8',
      aerodrome: '#e0e0e0', runway: '#d0d0d0', pier: '#dadada', pedestrian: '#e2e2e2',
      buildings: '#d0d0d0',
      road: '#ffffff', tunnel: '#f0f0f0',
      railway: '#8a8a8a', boundaries: '#adadad',
      ink: '#111111', inkMuted: '#616161', inkFaint: '#8a8a8a',
      roadInkMajor: '#494949', roadInkMinor: '#616161', waterInk: '#5c6f7a',
      stationFill: '#ffffff', stationRing: '#111111'
    },
    dark: {
      land: '#1b1b1b', water: '#0f2630',
      park: '#1c3122', parkLight: '#1e2e20', wood: '#1a2e1d', scrub: '#20291d',
      sand: '#26231a', beach: '#2a2619',
      hospital: '#252020', industrial: '#21211e', school: '#25231d', zoo: '#202621',
      aerodrome: '#21211e', runway: '#2e2e2e', pier: '#282828', pedestrian: '#242424',
      buildings: '#2b2b2b',
      road: '#4a4a4a', tunnel: '#2f2f2f',
      railway: '#808080', boundaries: '#4a4a4a',
      ink: '#f2f2f2', inkMuted: '#a3a3a3', inkFaint: '#8a8a8a',
      roadInkMajor: '#d0d0d0', roadInkMinor: '#a3a3a3', waterInk: '#8fb0bd',
      stationFill: '#ffffff', stationRing: '#111111'
    }
  };

  function mapPalette() {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark' && !state.lightMap;
    return MAP_PALETTES[dark ? 'dark' : 'light'];
  }

  var PARK_KINDS = ['national_park', 'park', 'cemetery', 'protected_area', 'nature_reserve', 'forest', 'golf_course'];
  // the basemap layers painted in one flat colour of the palette
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
  // a name's ink and the halo it sits in
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

  // The train, metro, light rail and ferry lines: the TfNSW shapes carry
  // their own official line colour, so T1 is orange, T4 blue, T8 green
  // and so on; anything without one takes the colour of its mode.
  var TRANSIT_COLORS = {
    train: '#f99d1c', metro: '#168388', tram: '#ee343e',
    ferry: '#5ab031', bus: '#ffb81c'
  };
  function byMode(metro, tram, ferry, bus, train) {
    return ['match', ['get', 'm'], 'metro', metro, 'tram', tram, 'ferry', ferry, 'bus', bus, train];
  }
  var TRANSIT_INK = ['to-color', ['get', 'c'],
    byMode(TRANSIT_COLORS.metro, TRANSIT_COLORS.tram, TRANSIT_COLORS.ferry, TRANSIT_COLORS.bus, TRANSIT_COLORS.train)];

  // The colours of one layer, basemap or ours, in the palette; nothing
  // for a layer that has none to change.
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
      // a casing in the land colour: the white ribbon is the road
      out[colour] = /_casing/.test(id) ? t.land : /^roads_tunnels_/.test(id) ? t.tunnel : t.road;
    } else if (LABEL_INKS[id]) {
      out['text-color'] = t[LABEL_INKS[id][0]];
      out['text-halo-color'] = t[LABEL_INKS[id][1]];
    } else if (id === 'ql-radius-fill') out['fill-color'] = siteColor('--accent', '#00933c');
    else if (id === 'ql-radius-line') out['line-color'] = siteColor('--accent', '#00933c');
    else if (id === 'ql-stations') {
      // a station is a hollow ring over the lines it serves; a train
      // station's ring stays neutral since it serves several lines and
      // must not claim one of their colours, and so does a light rail
      // stop that serves more than one (`shared`)
      out['circle-color'] = t.stationFill;
      out['circle-stroke-color'] = ['case',
        ['any', ['==', ['get', 'm'], 'train'], ['==', ['get', 'shared'], 1]], t.stationRing, TRANSIT_INK];
    } else if (id === 'ql-pin-groups') {
      // a group is a sign: black with white, in either theme
      out['circle-color'] = siteColor('--sign-bg', '#111111');
      out['circle-stroke-color'] = siteColor('--sign-ink', '#ffffff');
    } else if (id === 'ql-me') {
      // the line blue under a white ring: the one blue thing the page
      // puts on the map
      out['circle-color'] = siteColor('--line-blue', '#0039a6');
      out['circle-stroke-color'] = siteColor('--sign-ink', '#ffffff');
    } else return null;
    return out;
  }

  // ---------- What the page draws on the map ----------
  // Four GeoJSON sources the page keeps up to date: the transport
  // network, the radius around you, you, and the pins. The style is
  // built with whatever they hold, so data set before the map has
  // loaded is drawn when it does.
  function featureSet(features) { return { type: 'FeatureCollection', features: features || [] }; }
  var mapData = { transit: featureSet(), radius: featureSet(), me: featureSet(), pins: featureSet(), lit: featureSet() };
  // pins closer than this many pixels are one disc with their count,
  // until the map is zoomed past the second number
  var PIN_GROUP_RADIUS = 26;
  var PIN_GROUP_MAX_ZOOM = 12;
  // the Group Map Pins setting, on unless turned off
  var PIN_GROUPS_KEY = 'scs2-map-groups';
  function pinGroupsOn() {
    try { return localStorage.getItem(PIN_GROUPS_KEY) !== '0'; } catch (err) { return true; }
  }
  function pinGroupOptions() {
    return { cluster: pinGroupsOn(), clusterRadius: PIN_GROUP_RADIUS, clusterMaxZoom: PIN_GROUP_MAX_ZOOM };
  }
  // the setting changed with the map on screen
  function syncPinGroups() {
    dropMapShot(false);
    var src = state.map && state.mapStyled ? state.map.getSource('ql-pins') : null;
    if (src && src.setClusterOptions) src.setClusterOptions(pinGroupOptions());
  }

  // A group's count is a picture drawn in the site's own type (Helvetica
  // Neue, or SCS Heros where there is none), since the map's glyphs are
  // one fixed face. Each count is drawn the first time the map asks for
  // it, and again once the face has loaded or the map's sharpness changes.
  var COUNT_PREFIX = 'ql-count-';
  var COUNT_SIZE = 12.5;
  var countIds = [];
  function countFont(ratio) {
    var family = '';
    try { family = getComputedStyle(document.body).fontFamily; } catch (err) { /* no styles yet */ }
    return '700 ' + (COUNT_SIZE * ratio) + 'px ' + (family || '"Helvetica Neue", "SCS Heros", Helvetica, Arial, sans-serif');
  }
  function countPicture(label, ratio) {
    var c = document.createElement('canvas');
    var ctx = c.getContext('2d');
    if (!ctx) return null;
    ctx.font = countFont(ratio);
    var m = ctx.measureText(label);
    var w = Math.max(1, Math.ceil(m.width + 2 * ratio));
    var h = Math.ceil(COUNT_SIZE * ratio * 1.4);
    c.width = w;
    c.height = h;
    ctx.font = countFont(ratio);
    ctx.fillStyle = siteColor('--sign-ink', '#ffffff');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    // the figures' own height, centred
    var up = m.actualBoundingBoxAscent || COUNT_SIZE * ratio * 0.72;
    var down = m.actualBoundingBoxDescent || 0;
    ctx.fillText(label, w / 2, (h + up - down) / 2);
    return ctx.getImageData(0, 0, w, h);
  }
  function mapRatio(map) {
    return (map.getPixelRatio && map.getPixelRatio()) || window.devicePixelRatio || 1;
  }
  function addCount(map, id) {
    var ratio = mapRatio(map);
    var pic = countPicture(id.slice(COUNT_PREFIX.length), ratio);
    if (!pic) return;
    if (map.hasImage(id)) map.removeImage(id);
    map.addImage(id, pic, { pixelRatio: ratio });
    if (countIds.indexOf(id) < 0) countIds.push(id);
  }
  function redrawCounts() {
    var map = state.map;
    if (!map || !state.mapStyled) return;
    countIds.forEach(function (id) { if (map.hasImage(id)) addCount(map, id); });
  }
  function watchCounts(map) {
    map.on('styleimagemissing', function (e) {
      if (e && typeof e.id === 'string' && e.id.indexOf(COUNT_PREFIX) === 0) addCount(map, e.id);
    });
    if (document.fonts && document.fonts.addEventListener) {
      document.fonts.addEventListener('loadingdone', redrawCounts);
    }
  }

  function setMapData(key, data) {
    mapData[key] = data;
    var src = state.map && state.mapStyled ? state.map.getSource('ql-' + key) : null;
    if (src) src.setData(data);
  }

  var TRANSIT_LAYERS = ['ql-transit-lines', 'ql-transit-ferry', 'ql-stations'];

  // under the basemap's names, so a road or a suburb stays readable
  function underLayers() {
    var vis = state.transit ? 'visible' : 'none';
    var zoomed = function (w) { return ['interpolate', ['linear'], ['zoom'], 9, w, 15, w * 1.6]; };
    return [
      { id: 'ql-radius-fill', type: 'fill', source: 'ql-radius', paint: { 'fill-opacity': 0.07 } },
      { id: 'ql-radius-line', type: 'line', source: 'ql-radius', paint: { 'line-width': 1.5 } },
      {
        id: 'ql-transit-lines', type: 'line', source: 'ql-transit',
        filter: ['all', ['!=', ['geometry-type'], 'Point'], ['!=', ['get', 'm'], 'ferry']],
        layout: { 'line-cap': 'round', 'line-join': 'round', visibility: vis },
        paint: {
          'line-color': TRANSIT_INK,
          'line-opacity': 0.85,
          'line-width': ['interpolate', ['linear'], ['zoom'],
            9, byMode(2.8, 2, 1.8, 2, 2.4), 15, byMode(4.5, 3.2, 2.9, 3.2, 3.8)]
        }
      },
      {
        id: 'ql-transit-ferry', type: 'line', source: 'ql-transit',
        filter: ['all', ['!=', ['geometry-type'], 'Point'], ['==', ['get', 'm'], 'ferry']],
        layout: { 'line-cap': 'round', visibility: vis },
        paint: { 'line-color': TRANSIT_INK, 'line-opacity': 0.75, 'line-width': zoomed(1.8), 'line-dasharray': [2.8, 3.3] }
      }
    ];
  }

  // over everything: stations once there is room for them, then the
  // pins, then you
  function overLayers() {
    return [
      {
        id: 'ql-stations', type: 'circle', source: 'ql-transit', minzoom: 11,
        filter: ['==', ['geometry-type'], 'Point'],
        layout: { visibility: state.transit ? 'visible' : 'none' },
        paint: { 'circle-radius': byMode(3, 1.6, 2.4, 1.8, 2.4), 'circle-stroke-width': 2 }
      },
      {
        // pins close together at this zoom: a disc with how many, which a
        // tap opens up
        id: 'ql-pin-groups', type: 'circle', source: 'ql-pins', filter: ['has', 'point_count'],
        paint: {
          'circle-radius': ['step', ['get', 'point_count'], 12, 10, 14.5, 25, 17],
          'circle-stroke-width': 2
        }
      },
      {
        id: 'ql-pin-counts', type: 'symbol', source: 'ql-pins', filter: ['has', 'point_count'],
        layout: {
          'icon-image': ['concat', COUNT_PREFIX, ['get', 'point_count_abbreviated']],
          'icon-allow-overlap': true,
          'icon-ignore-placement': true
        }
      },
      pinLayer('ql-pins', 'ql-pins'),
      pinLayer('ql-pins-lit', 'ql-lit'),
      { id: 'ql-me', type: 'circle', source: 'ql-me', paint: { 'circle-radius': 7.5, 'circle-stroke-width': 3 } }
    ];
  }

  // a pin is white with an accent ring, a main quest's filled, a ticked
  // one the rule grey: the colours ride on each pin. The open quest's
  // pins are louder and drawn over their neighbours.
  function pinLayer(id, source) {
    return {
      id: id, type: 'circle', source: source,
      filter: ['!', ['has', 'point_count']],
      layout: { 'circle-sort-key': ['get', 'lit'] },
      paint: {
        'circle-radius': ['case', ['==', ['get', 'lit'], 1], 9.25, 7],
        'circle-stroke-width': ['case', ['==', ['get', 'lit'], 1], 3.5, 2],
        'circle-color': ['get', 'fill'],
        'circle-stroke-color': ['get', 'stroke'],
        'circle-opacity': 0.95
      }
    };
  }

  ql.baseStyle = null;

  function absUrl(path) {
    return new URL(path, location.href).href.replace(/%7B/g, '{').replace(/%7D/g, '}');
  }

  // The whole style: the basemap over our tiles, or OpenStreetMap's
  // pictures when our tiles cannot be reached, with the page's own
  // layers put in among them, and every colour from the palette.
  function buildStyle() {
    var t = mapPalette();
    var style;
    if (state.tileUrl && ql.baseStyle) {
      style = JSON.parse(JSON.stringify(ql.baseStyle));
      style.sources.protomaps.tiles = [state.tileUrl];
    } else {
      style = {
        version: 8,
        sources: {
          osm: { type: 'raster', tiles: [OSM_TILES], tileSize: 256, maxzoom: 19, attribution: '&copy; OpenStreetMap contributors' }
        },
        layers: [{ id: 'background', type: 'background' }, { id: 'osm', type: 'raster', source: 'osm' }]
      };
    }
    style.glyphs = absUrl(MAP_GLYPHS);
    Object.keys(mapData).forEach(function (k) {
      style.sources['ql-' + k] = { type: 'geojson', data: mapData[k] };
    });
    var groups = pinGroupOptions();
    Object.keys(groups).forEach(function (k) { style.sources['ql-pins'][k] = groups[k]; });
    var before = style.layers.map(function (l) { return l.id; })
      .indexOf((style.metadata && style.metadata['scs:data-before']) || '');
    if (before < 0) before = style.layers.length;
    style.layers = style.layers.slice(0, before).concat(underLayers(), style.layers.slice(before), overLayers());
    style.layers.forEach(function (l) {
      var p = layerPaint(l, t);
      if (!p) return;
      l.paint = l.paint || {};
      Object.keys(p).forEach(function (k) { l.paint[k] = p[k]; });
    });
    state.styleLayers = style.layers.map(function (l) { return { id: l.id, type: l.type }; });
    return style;
  }

  // the container under the canvas wears the same land colour, so the
  // edge of what has loaded so far is never a seam
  function paintMapGround() {
    var box = document.getElementById('ql-map');
    if (box) box.style.backgroundColor = mapPalette().land;
  }

  // A theme flip repaints every layer in place: building the style again
  // and handing it over would compare the whole transport network to
  // find out that nothing in it changed.
  function repaintMap() {
    dropMapShot(false);
    paintMapGround();
    if (!state.map || !state.mapStyled) return;
    var t = mapPalette();
    (state.styleLayers || []).forEach(function (l) {
      var p = layerPaint(l, t);
      if (!p || !state.map.getLayer(l.id)) return;
      Object.keys(p).forEach(function (k) { state.map.setPaintProperty(l.id, k, p[k]); });
    });
  }

  new MutationObserver(function () {
    repaintMap();
    syncMarkInks();
  }).observe(document.documentElement, { attributeFilter: ['data-theme'] });

  // ---------- Transit overlay: the real network, from OpenStreetMap ----------
  // The tile archive carries no transit layer, so the network rides
  // along as GeoJSON instead (assets/transit.geojson, built from an OSM
  // export): Sydney Trains, Metro, light rail and the numbered ferry
  // routes in official mode colours, with stations as ringed dots once
  // the map is in close. Drawn beneath the quest pins, cached by the
  // service worker.
  var TRANSIT_URL = '../assets/transit.geojson';

  function fetchTransit() {
    window.scs.fetch(TRANSIT_URL).then(function (r) {
      if (!r.ok) throw new Error('transit overlay ' + r.status);
      return r.json();
    }).then(function (data) {
      setMapData('transit', data);
    }).catch(function () { /* the map still works without the overlay */ });
  }

  function syncTransit() {
    if (!state.map || !state.mapStyled) return;
    TRANSIT_LAYERS.forEach(function (id) {
      if (state.map.getLayer(id)) state.map.setLayoutProperty(id, 'visibility', state.transit ? 'visible' : 'none');
    });
  }
  // ---------- The map as it was last drawn ----------
  // Every visit builds the page, and so the map, afresh: MapLibre's
  // script, the style and every tile on screen are decoded and drawn
  // again. A picture of the map as it last stood at its opening view (a
  // JPEG in the Cache API, its size and look in localStorage) takes its
  // place at once and fades when the live map has drawn.
  var SHOT_CACHE = 'scs2-map-shot';
  var SHOT_URL = '/__map-shot';
  var SHOT_KEY = 'scs2-map-shot';
  var SHOT_MIN_BYTES = 12000; // under this the canvas read came back blank
  var shotImg = null;

  function shotLook() {
    return (mapPalette() === MAP_PALETTES.dark ? 'dark' : 'light') +
      (state.transit ? '' : '-plain') + (pinGroupsOn() ? '' : '-loose') + '-' + window.scs.mapPixelRatio();
  }
  function shotMeta() {
    try { return JSON.parse(localStorage.getItem(SHOT_KEY) || 'null'); } catch (err) { return null; }
  }
  function onPage() {
    var root = document.documentElement.classList;
    return !root.contains('ql-map-full') && !root.contains('ql-map-home');
  }
  // drawn here before, with its tiles kept on the phone
  function mapDrawnBefore() {
    var tiles = null;
    try { tiles = localStorage.getItem('scs2-tile-cache'); } catch (err) { /* unknown */ }
    return !!shotMeta() && tiles !== '0';
  }

  // ---------- Where the map was left ----------
  // Within one tab the map comes back where it was left, across pages and
  // reloads; a new tab, or the app opened again, starts at the opening
  // view. A quest named in the address opens on that quest instead.
  var VIEW_KEY = 'scs2-questlist-view';
  function keptView() {
    if (location.hash.length > 1) return null;
    try {
      var v = JSON.parse(sessionStorage.getItem(VIEW_KEY) || 'null');
      if (v && isFinite(v.lng) && isFinite(v.lat) && isFinite(v.zoom)) return v;
    } catch (err) { /* nothing kept */ }
    return null;
  }
  function keepView(map) {
    map.on('moveend', function () {
      var c = map.getCenter();
      try {
        sessionStorage.setItem(VIEW_KEY, JSON.stringify({ lng: Math.round(c.lng * 1e5) / 1e5, lat: Math.round(c.lat * 1e5) / 1e5, zoom: Math.round(map.getZoom() * 100) / 100 }));
      } catch (err) { /* not kept */ }
    });
  }

  function showMapShot() {
    var meta = shotMeta();
    var box = document.getElementById('ql-map');
    if (!meta || !box || !window.caches || state.mapDrawn || !onPage() || keptView()) return;
    if (Math.abs(box.clientWidth - meta.w) > 1 || Math.abs(box.clientHeight - meta.h) > 1) return;
    if (meta.look !== shotLook()) return;
    caches.open(SHOT_CACHE)
      .then(function (cache) { return cache.match(SHOT_URL); })
      .then(function (res) { return res ? res.blob() : null; })
      .then(function (blob) {
        if (!blob || shotImg || state.mapDrawn || !onPage()) return;
        var img = document.createElement('img');
        img.className = 'ql-map-shot';
        img.alt = '';
        img.setAttribute('aria-hidden', 'true');
        img.style.left = box.offsetLeft + 'px';
        img.style.top = box.offsetTop + 'px';
        img.style.width = meta.w + 'px';
        img.style.height = meta.h + 'px';
        img.src = URL.createObjectURL(blob);
        shotImg = img;
        box.parentNode.insertBefore(img, box.nextSibling);
      })
      .catch(function () { /* the map draws as it always did */ });
  }

  function dropMapShot(fade) {
    var img = shotImg;
    if (!img) return;
    shotImg = null;
    var gone = function () {
      if (img.parentNode) img.parentNode.removeChild(img);
      URL.revokeObjectURL(img.src);
    };
    if (!fade || window.scs.reducedMotion) { gone(); return; }
    img.classList.add('is-leaving');
    window.setTimeout(gone, window.scs.ms('--duration-quick', 150) + 50);
  }

  // a hand on the map, or the map's box changing size, takes it away
  var shotCard = document.querySelector('.ql-map-card');
  if (shotCard) {
    ['pointerdown', 'touchstart', 'wheel'].forEach(function (name) {
      shotCard.addEventListener(name, function () { dropMapShot(false); }, { capture: true, passive: true });
    });
  }
  window.addEventListener('resize', function () {
    var box = document.getElementById('ql-map');
    if (!shotImg || !box) return;
    if (box.clientWidth !== parseFloat(shotImg.style.width) || box.clientHeight !== parseFloat(shotImg.style.height)) dropMapShot(false);
  });

  // Read the canvas the moment a frame is drawn, onto a canvas of its own
  // (a WebGL canvas keeps nothing once the frame is shown), then keep it.
  function takeMapShot(map) {
    if (!onPage() || !state.tileUrl || !ql.baseStyle || state.userPos || !window.caches) return;
    if (!overlay.classList.contains('is-hidden')) return;
    var box = document.getElementById('ql-map');
    var meta = { w: box.clientWidth, h: box.clientHeight, look: shotLook() };
    map.once('render', function () {
      var source = map.getCanvas();
      var copy = document.createElement('canvas');
      copy.width = source.width;
      copy.height = source.height;
      try {
        copy.getContext('2d').drawImage(source, 0, 0);
        copy.toBlob(function (blob) {
          if (!blob || blob.size < SHOT_MIN_BYTES) return;
          caches.open(SHOT_CACHE)
            .then(function (cache) { return cache.put(SHOT_URL, new Response(blob, { headers: { 'content-type': 'image/jpeg' } })); })
            .then(function () { localStorage.setItem(SHOT_KEY, JSON.stringify(meta)); })
            .catch(function () { /* not kept */ });
        }, 'image/jpeg', 0.85);
      } catch (err) { /* a canvas that cannot be read */ }
    });
    map.triggerRepaint();
  }

  // The first time the live map has drawn every tile, the picture fades;
  // once the transport lines are in too, and nobody has moved it, the
  // picture is taken again for the next visit.
  function watchMapShot(map) {
    var moved = false;
    var safety = window.setTimeout(function () { dropMapShot(true); }, 10000);
    map.on('movestart', function (e) { if (e.originalEvent) moved = true; });
    map.once('load', function () {
      var onIdle = function () {
        if (!state.mapDrawn) {
          state.mapDrawn = true;
          window.clearTimeout(safety);
          dropMapShot(true);
        }
        if (state.transit && !mapData.transit.features.length) return;
        map.off('idle', onIdle);
        if (!moved && !state.viewKept) takeMapShot(map);
      };
      map.on('idle', onIdle);
    });
  }


  // ---------- Finding what was tapped ----------
  // The nearest of a layer's features within `reach` pixels of a point:
  // fingers hit the dots without the dots themselves growing.
  function nearestOn(layer, point, reach) {
    if (!state.map || !state.map.getLayer(layer)) return null;
    var hits = state.map.queryRenderedFeatures(
      [[point.x - reach, point.y - reach], [point.x + reach, point.y + reach]], { layers: [layer] });
    var best = null;
    var bestD = Infinity;
    hits.forEach(function (f) {
      var p = state.map.project(f.geometry.coordinates);
      var d = (p.x - point.x) * (p.x - point.x) + (p.y - point.y) * (p.y - point.y);
      if (d < bestD) { bestD = d; best = f; }
    });
    return best;
  }

  // A label on the map is a black sign, the way a code chip is. One
  // follows the mouse; the open quest's pins keep theirs while it is up.
  function mapTip(offset) {
    return new window.maplibregl.Popup({
      closeButton: false, closeOnClick: false, focusAfterOpen: false,
      anchor: 'bottom', offset: offset, className: 'ql-map-tip'
    });
  }

  var hoverTip = null;
  function hideHoverTip() {
    if (hoverTip) hoverTip.remove();
  }

  function showHoverTip(f) {
    var pin = /^ql-pins/.test(f.layer.id);
    if (!hoverTip) hoverTip = mapTip(12);
    hoverTip.setOffset(pin ? 12 : f.layer.id === 'ql-me' ? 13 : 7)
      .setLngLat(f.geometry.coordinates)
      .setText(f.properties.name)
      .addTo(state.map);
  }

  function hoverAt(point) {
    var f = nearestOn('ql-me', point, 3) || nearestOn('ql-pins-lit', point, 3) || nearestOn('ql-pins', point, 3) ||
      nearestOn('ql-pin-groups', point, 3) || nearestOn('ql-stations', point, 3);
    state.map.getCanvas().style.cursor = f && /^ql-pin/.test(f.layer.id) ? 'pointer' : '';
    // the open quest's pins already say their name
    if (!f || !f.properties.name || f.properties.lit === 1) hideHoverTip();
    else showHoverTip(f);
  }

  function questById(id) {
    for (var i = 0; i < QUESTS.length; i++) if (QUESTS[i].id === id) return QUESTS[i];
    return null;
  }

  // A group opens up: the map zooms in on it as far as it takes for its
  // pins to come apart.
  function openGroup(f) {
    var at = f.geometry.coordinates;
    var go = function (z) {
      state.map.easeTo({ center: at, zoom: Math.min(16, z), duration: window.scs.reducedMotion ? 0 : 450, essential: true });
    };
    var further = function () { go(state.map.getZoom() + 2); };
    try {
      var asked = state.map.getSource('ql-pins').getClusterExpansionZoom(f.properties.cluster_id);
      if (asked && asked.then) asked.then(go, further); else further();
    } catch (err) { further(); }
  }

  function onMapClick(e) {
    hideHoverTip();
    var pin = nearestOn('ql-pins-lit', e.point, 14) || nearestOn('ql-pins', e.point, 14);
    if (pin) {
      var quest = questById(pin.properties.quest);
      if (!quest) return;
      state.pinTapAt = Date.now(); // not a map double tap
      // on a phone a pin opens the sheet at its card, or swaps the quest
      // in a sheet already up at whatever stop it is at
      if (isSheet()) {
        var c = pin.geometry.coordinates;
        var loc = { lat: c[1], lng: c[0], label: pin.properties.label };
        var was = sheetStop();
        ql.openQuestPanel(quest, false, { stop: was || 'card', loc: loc });
        if (!was || was === 'card') frameAboveCard(loc);
        return;
      }
      // pins open the sheet the same way the search results do, so
      // the two panels trade places instead of stacking up
      ql.openQuestPanel(quest, false);
      return;
    }
    var group = nearestOn('ql-pin-groups', e.point, 18);
    if (group) {
      state.pinTapAt = Date.now();
      openGroup(group);
      return;
    }
    // a tap on the map itself puts the card away
    if (sheetStop() === 'card') {
      if (Date.now() - ql.sheetOpenedAt > 400) closeDetail();
      return;
    }
    // a station or you, tapped: its name, until the next tap
    var named = nearestOn('ql-me', e.point, 10) || nearestOn('ql-stations', e.point, 10);
    if (named && named.properties.name) {
      showHoverTip(named);
      return;
    }
    // In the fullscreen map a tap on the map itself, with a quest
    // sheet up, reads as "put that away" — same as swiping it down.
    // The tap that just opened the sheet doesn't count.
    if (!sheetMq.matches) return;
    if (!document.documentElement.classList.contains('ql-map-full')) return;
    if (overlay.classList.contains('is-hidden')) return;
    if (Date.now() - ql.sheetOpenedAt < 400) return;
    closeDetail();
  }

  // Double tap zooms in on the spot, and every tap after the first in a
  // quick chain adds one more level to the same zoom. MapLibre's own
  // double tap, and a chain of eases, both start a new
  // animation on each tap, and a touch stops the one under way, so
  // tapping on through a zoom froze and then jumped. Here one frame loop
  // runs the whole chain: a tap raises the level it is heading for, and
  // each frame closes part of the gap, so the zoom never stops between
  // taps. The spot under the latest tap stays under the finger. A double
  // click with a mouse goes through the same loop; a pinch or a wheel
  // takes over from it.
  function installTapZoom(map) {
    map.doubleClickZoom.disable();
    var el = map.getCanvasContainer();
    var target = null;
    var anchor = null;
    var frame = 0;
    var lastAt = 0;
    var down = null;
    var last = null;
    var touchZoomAt = 0;

    function stop() {
      if (frame) window.cancelAnimationFrame(frame);
      frame = 0;
      target = null;
      lastAt = 0;
    }

    function step(now) {
      frame = 0;
      if (target === null) return;
      var dt = lastAt ? Math.min(50, now - lastAt) : 16;
      lastAt = now;
      var z = map.getZoom();
      var gap = target - z;
      // most of the way in about a quarter of a second, easing out
      var next = Math.abs(gap) < 0.003 ? target : z + gap * (1 - Math.exp(-dt / 80));
      map.easeTo({ zoom: next, around: anchor, duration: 0, essential: true });
      if (next === target) { stop(); return; }
      frame = window.requestAnimationFrame(step);
    }

    function zoomAt(x, y) {
      target = Math.min(map.getMaxZoom(), (target !== null ? target : map.getZoom()) + 1);
      anchor = map.unproject([x, y]);
      if (window.scs.reducedMotion) {
        map.easeTo({ zoom: target, around: anchor, duration: 0, essential: true });
        stop();
        return;
      }
      if (!frame) frame = window.requestAnimationFrame(step);
    }

    el.addEventListener('pointerdown', function (e) {
      if (e.pointerType !== 'touch') return;
      // a second finger is a pinch: it has the zoom from here
      if (!e.isPrimary) { stop(); down = null; return; }
      down = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    }, { passive: true });
    el.addEventListener('pointerup', function (e) {
      if (e.pointerType !== 'touch' || !e.isPrimary || !down) return;
      var moved = Math.abs(e.clientX - down.x) + Math.abs(e.clientY - down.y);
      var quick = e.timeStamp - down.t < 250;
      var downAt = down.t;
      down = null;
      if (moved > 12 || !quick) { last = null; return; }
      var r = el.getBoundingClientRect();
      var x = e.clientX - r.left;
      var y = e.clientY - r.top;
      // timed from the last lift to this touch, so a finger that rests a
      // moment longer does not break the chain: 320ms for the first pair,
      // and once a chain is going a little longer still carries on
      var gapMs = target !== null ? 420 : 320;
      if (last && downAt - last.t < gapMs && Math.abs(x - last.x) < 40 && Math.abs(y - last.y) < 40 &&
          Date.now() - (state.pinTapAt || 0) > 500) {
        zoomAt(x, y);
        touchZoomAt = Date.now();
      }
      last = { t: e.timeStamp, x: x, y: y };
    }, { passive: true });
    map.on('dblclick', function (e) {
      e.preventDefault();
      // a touch double tap can also fire dblclick: the chain has it
      if (Date.now() - touchZoomAt < 700) return;
      zoomAt(e.point.x, e.point.y);
    });
    // a zoom the person starts themselves (a pinch, a wheel, a tap and
    // drag) carries an event; the loop's own steps do not
    map.on('zoomstart', function (e) { if (e.originalEvent) stop(); });
  }

  // ---------- Zooming with a wheel or a trackpad ----------
  // Every wheel over the map is the page's, in the page and in full
  // screen alike: a capture listener on #ql-map stops it before
  // MapLibre's own wheel zoom sees it. MapLibre eases each event over
  // 200ms and guesses mouse or trackpad from the first few, so a pinch
  // through it trailed the fingers and changed speed part way.
  //
  // A trackpad pinch arrives as ctrl+wheel and zooms by exactly what the
  // fingers did (a pinch's delta is about 100 times the log of its
  // scale); a plain wheel or a two-finger scroll zooms at a gentler rate.
  // Small steps go straight on, so the map stays under the fingers; a
  // mouse notch is a big step and glides out over a short ease instead
  // of jumping. When the input stops the zoom carries on at the speed it
  // was going and slows to a stop, the way a touch screen does; grabbing
  // the map stops it. All of it is around the pointer.
  //
  // In the page a scroll of the page that runs on over the map is still
  // the page's: the map takes the wheel once the pointer has rested on
  // it, so passing over it on the way down does not trap the page.
  var wheelInstant = 0;
  var wheelPending = 0;
  var wheelVel = 0;
  var wheelCoasting = false;
  var wheelAt = null;
  var wheelEvent = null;
  var wheelLastInput = -1e9;
  var wheelSamples = [];
  var wheelFrame = 0;
  var wheelLastFrame = 0;
  var pageWheelAt = -1e9;

  function wheelStop() {
    if (wheelFrame) window.cancelAnimationFrame(wheelFrame);
    wheelFrame = 0;
    wheelInstant = 0;
    wheelPending = 0;
    wheelVel = 0;
    wheelCoasting = false;
    wheelSamples = [];
    wheelLastFrame = 0;
  }

  // the speed the zoom was going over the last tenth of a second of
  // input, in levels a millisecond; nothing if the input had already
  // come to rest before it stopped
  function wheelSpeed(now) {
    var last = wheelSamples[wheelSamples.length - 1];
    if (!last || now - last[0] > 100) return 0;
    var first = last;
    for (var i = wheelSamples.length - 1; i >= 0 && last[0] - wheelSamples[i][0] <= 100; i--) first = wheelSamples[i];
    var span = last[0] - first[0];
    if (span < 16) return 0;
    return Math.max(-0.003, Math.min(0.003, (last[1] - first[1]) / span));
  }

  function wheelStep(now) {
    wheelFrame = 0;
    if (!state.map || !wheelAt) { wheelStop(); return; }
    var dt = wheelLastFrame ? Math.min(50, now - wheelLastFrame) : 16;
    wheelLastFrame = now;
    var z = state.map.getZoom();
    var dz = wheelInstant;
    wheelInstant = 0;
    if (wheelPending) {
      var take = Math.abs(wheelPending) < 0.002 ? wheelPending : wheelPending * (1 - Math.exp(-dt / 70));
      dz += take;
      wheelPending -= take;
    }
    var inputLive = now - wheelLastInput < 60;
    if (dz) {
      wheelSamples.push([now, z + dz]);
      while (wheelSamples.length && now - wheelSamples[0][0] > 200) wheelSamples.shift();
    } else if (!inputLive && !wheelCoasting) {
      wheelVel = wheelSpeed(now);
      wheelCoasting = true;
    }
    if (wheelCoasting) {
      // at most three levels a second, which carries on for about a
      // third of a level: a phone map's coast, not a second zoom
      dz = wheelVel * dt;
      wheelVel *= Math.exp(-dt / 100);
      if (Math.abs(wheelVel) < 0.0003) wheelVel = 0;
    }
    if (dz) {
      state.map.easeTo({ zoom: z + dz, around: state.map.unproject(wheelAt), duration: 0, essential: true },
        { originalEvent: wheelEvent });
      // against the zoom limit nothing more will happen
      if (wheelCoasting && state.map.getZoom() === z) wheelVel = 0;
    }
    if (wheelPending || inputLive || (wheelCoasting && wheelVel)) {
      wheelFrame = window.requestAnimationFrame(wheelStep);
    } else {
      wheelStop();
    }
  }

  document.addEventListener('wheel', function (e) {
    if (!mapBox || !mapBox.contains(e.target)) pageWheelAt = window.performance.now();
  }, { passive: true, capture: true });

  if (mapBox) {
    mapBox.addEventListener('wheel', function (e) {
      if (!state.map) return;
      var now = window.performance.now();
      var full = document.documentElement.classList.contains('ql-map-full');
      if (!full && !e.ctrlKey && now - pageWheelAt < 300 && now - wheelLastInput > 300) {
        pageWheelAt = now; // still the page's scroll: let it carry on
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      var r = mapBox.getBoundingClientRect();
      var px = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? r.height : 1);
      var dz = Math.max(-2, Math.min(2, e.ctrlKey ? -px / 69.3 : -px / 150));
      if (Math.abs(dz) > 0.2) wheelPending += dz;
      else wheelInstant += dz;
      wheelCoasting = false;
      wheelVel = 0;
      wheelAt = [e.clientX - r.left, e.clientY - r.top];
      wheelEvent = e;
      wheelLastInput = now;
      if (!wheelFrame) wheelFrame = window.requestAnimationFrame(wheelStep);
    }, { passive: false, capture: true });
  }

  // ---------- Full screen map ----------
  var mapFullBtn = document.getElementById('ql-map-full');
  var mapLocateBtn = document.getElementById('ql-map-locate');

  var mapLayer = null;
  var armTimer = 0;
  var filtersLayer = null;
  // the full-screen map's or the drawer's layer is the top one
  ql.mapLayerOnTop = function () {
    var stack = window.scsBackLayer;
    return stack.isTop(mapLayer) || stack.isTop(filtersLayer);
  };

  // Is the drawer the side panel at the moment? On a wide screen it is
  // a column of switches in the page rather than something a button
  // opens, so nothing closes it — but the fullscreen map borrows it
  // back into its search panel, where the button is in charge again.
  function filtersArePanel() {
    return ql.onDesk && !ql.travelled;
  }

  // The one rule for whether the drawer shows: while it is the side
  // panel, or while it is open. Run whenever either of those changes.
  function syncDrawer() {
    var drawer = document.getElementById('ql-filters');
    if (drawer) drawer.hidden = !filtersArePanel() && !document.documentElement.classList.contains('ql-filters-open');
  }

  function setFiltersOpen(open) {
    document.documentElement.classList.toggle('ql-filters-open', open);
    syncDrawer();
    ['ql-filters-btn', 'ql-search-filters-btn'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) {
        b.setAttribute('aria-expanded', open ? 'true' : 'false');
        b.classList.toggle('is-open', open);
      }
    });
    // In full screen the drawer is at the head of the search panel's
    // list. On a phone that list is folded away under the bar until the
    // panel rises, so opening the drawer raises it.
    if (open) ql.raiseMapSearch();
    if (open && ql.searchBody && document.documentElement.classList.contains('ql-map-full')) ql.searchBody.scrollTop = 0;
    if (open && !filtersLayer && window.scsBackLayer) {
      filtersLayer = window.scsBackLayer.arm(function () { setFiltersOpen(false); });
    } else if (!open && filtersLayer) {
      var layer = filtersLayer;
      filtersLayer = null;
      window.scsBackLayer.disarm(layer);
    }
  }

  // In-flight morph bookkeeping: spamming the fullscreen button used to
  // stack cleanup timers, measure rectangles mid-transform, and could
  // leave the fixed, screen-covering card with a stuck transform — a
  // frozen-looking UI. Any new toggle first snaps the old morph to its
  // end state, so the card can never wedge.
  var mapMorphTimer = null;

  // The full screen map's buttons sit just clear of the tallest panel
  // on screen and follow it wherever it goes: above the search bar,
  // above the results when they rise, above the quest sheet when that
  // takes over. Rather than guess where a panel is heading and hope a
  // matching transition keeps step, they measure the panels' real top
  // edge every frame while anything is moving — which covers finger
  // drags, snap-backs, slide-ups and morphs alike — and stop once
  // things have been still for a few frames. Phones and the app only;
  // on desktop the buttons stay in the corner.
  var followFrame = 0;
  var followStillFor = 0;
  var followLastTop = -1;
  var followUntil = 0;

  function panelTopEdge() {
    var top = window.innerHeight;
    if (ql.searchWrap) {
      var sr = ql.searchWrap.getBoundingClientRect();
      if (sr.height > 0) top = Math.min(top, sr.top);
    }
    if (sheet && !overlay.classList.contains('is-hidden')) {
      top = Math.min(top, sheet.getBoundingClientRect().top);
    }
    return top;
  }

  // The lift goes on the map card, which holds every control that reads
  // it: set on the root it restyled the whole page on every frame.
  function applyControlLift(top) {
    var root = document.documentElement;
    var card = document.querySelector('.ql-map-card');
    if (card) card.style.setProperty('--map-btn-lift', Math.max(0, Math.round(window.innerHeight - top)) + 'px');
    // a panel this tall leaves no room to sit above it
    root.classList.toggle('ql-controls-tucked', top < 120);
  }

  function followPanels() {
    followFrame = 0;
    var top = panelTopEdge();
    applyControlLift(top);
    followStillFor = Math.abs(top - followLastTop) < 0.5 ? followStillFor + 1 : 0;
    followLastTop = top;
    if (followStillFor < 4 || Date.now() < followUntil) {
      followFrame = window.requestAnimationFrame(followPanels);
    }
  }

  function positionMapControls() {
    var root = document.documentElement;
    if (!root.classList.contains('ql-map-full') || !sheetMq.matches) {
      if (followFrame) { window.cancelAnimationFrame(followFrame); followFrame = 0; }
      var card = document.querySelector('.ql-map-card');
      if (card) card.style.removeProperty('--map-btn-lift');
      root.classList.remove('ql-controls-tucked');
      return;
    }
    applyControlLift(panelTopEdge()); // this frame, without waiting
    followStillFor = 0;               // and keep watching until it settles
    followUntil = Date.now() + 180;   // transitions can take a frame to start
    if (!followFrame) followFrame = window.requestAnimationFrame(followPanels);
  }

  function settleMapMorph(card) {
    if (mapMorphTimer) { window.clearTimeout(mapMorphTimer); mapMorphTimer = null; }
    card.style.transition = '';
    card.style.transform = '';
    card.style.transformOrigin = '';
    card.style.zIndex = '';
  }

  function setMapFull(on) {
    dropMapShot(false);
    if (on && ql.startMap) ql.startMap();
    var was = document.documentElement.classList.contains('ql-map-full');
    var card = document.querySelector('.ql-map-card');
    if (card) settleMapMorph(card); // finish any morph before measuring
    var first = card ? card.getBoundingClientRect() : null;
    document.documentElement.classList.toggle('ql-map-full', on);
    ql.unfadeMapUi();
    syncPop();
    setFiltersOpen(false);
    if (!on) ql.collapseMapSearch(); // leaving the map puts the search away
    // full screen itself answers to the back gesture, armed once the
    // morph is over: the history entry it pushes is a long task
    if (on && !was && !mapLayer && !armTimer && window.scsBackLayer) {
      armTimer = window.setTimeout(function () {
        armTimer = 0;
        if (!mapLayer && document.documentElement.classList.contains('ql-map-full')) {
          mapLayer = window.scsBackLayer.arm(function () { setMapFull(false); });
        }
      }, 340);
    } else if (!on) {
      if (armTimer) { window.clearTimeout(armTimer); armTimer = 0; }
      if (mapLayer) {
        var mlayer = mapLayer;
        mapLayer = null;
        window.scsBackLayer.disarm(mlayer);
      }
    }

    // A real morph between the in-page card and the full screen: measure
    // both rectangles and animate the difference, both directions.
    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (card && first && on !== was && !reduced) {
      var last = card.getBoundingClientRect();
      if (last.width > 0 && last.height > 0 && first.width > 0) {
        card.style.transformOrigin = 'top left';
        card.style.transition = 'none';
        card.style.zIndex = on ? '' : '1300'; // stay on top while shrinking back
        card.style.transform = 'translate(' + (first.left - last.left) + 'px,' + (first.top - last.top) + 'px) ' +
          'scale(' + (first.width / last.width) + ',' + (first.height / last.height) + ')';
        void card.offsetWidth; // paint the starting frame
        card.style.transition = 'transform 320ms cubic-bezier(0.2, 0.85, 0.3, 1)';
        card.style.transform = '';
        mapMorphTimer = window.setTimeout(function () {
          mapMorphTimer = null;
          settleMapMorph(card);
        }, 340);
      }
    }

    ql.placeFilters(on);
    ql.syncSide();
    positionMapControls();
    // the floating search takes its place from the submit button, and
    // both are away while the map is full screen
    placePill();
    if (mapFullBtn) mapFullBtn.setAttribute('aria-label', on ? 'Exit full screen map' : 'Full screen map');
    if (!on) ql.realFullscreen(false);
    // the canvas takes the new container size once right away, so the
    // tiles cover the big canvas during the morph, and once after it
    window.setTimeout(ql.resizeMap, 20);
    window.setTimeout(function () { ql.resizeMap(true); }, 360);
  }

  // Closing a back layer leaves a history.back() in flight: the stack
  // pops on the popstate, not on the call. So the drawer is closed first
  // and what comes next waits for the pop it caused.
  function afterDrawerCloses(fn) {
    if (document.documentElement.classList.contains('ql-filters-open')) setFiltersOpen(false);
    if (window.scsBackLayer) window.scsBackLayer.after(fn);
    else fn();
  }

  // for the parts after this one
  ql.MAP_BOUNDS = MAP_BOUNDS;
  ql.MAP_CENTER = MAP_CENTER;
  ql.mapData = mapData;
  ql.mapFullBtn = mapFullBtn;
  ql.mapLocateBtn = mapLocateBtn;
});
