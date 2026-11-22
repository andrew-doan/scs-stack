/* Cleans a GPX track a team recorded on the day: drops spikes and the
   straight-line filler phones write in tunnels, redraws train, metro and
   light rail rides along the lines in transit.geojson (timed from the
   fixes on them, or through a tunnel from the recorded trip or a typical
   speed), and squashes the jitter where the team stood still. The same
   file runs in Node (tracks/clean.mjs) and in a browser
   (window.SCSTrackClean). How it decides is in tracks/CLAUDE.md. */
(function (root, make) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.SCSTrackClean = make();
})(this, function () {
  'use strict';

  // ---------- settings ----------
  var DAY_FROM = 9 * 3600;          // Sydney time; check-in opened 09:15
  var DAY_TO = 18.5 * 3600;         // the event ended at 18:00
  var SYDNEY_OFFSET = 11 * 3600;    // AEDT on 20 October 2026
  // typical speed between stations (m/s), the stop at each (s), how far a
  // fix may sit off the line (m), and the fastest each can go (m/s)
  var MODES = {
    train: { speed: 15, dwell: 40, fit: 150, max: 36 },
    metro: { speed: 17, dwell: 35, fit: 150, max: 29 },
    tram: { speed: 6.5, dwell: 25, fit: 70, max: 20 },
    walk: { speed: 1.3, dwell: 0, fit: 150, max: 3 }
  };
  var WALK = 1.3;
  var VEHICLE = 5.5;
  var STAY_RADIUS = 60;
  var STAY_MIN = 180;
  var REPLAY_TOLERANCE = 4;
  // the transit file has no point for Central's train station, and draws
  // the stations the metro shares with Sydney Trains as train stations
  var EXTRA_STATIONS = [
    { type: 'Feature', properties: { m: 'train', name: 'Central' }, geometry: { type: 'Point', coordinates: [151.2066, -33.8830] } }
  ];
  var METRO_AT_TRAIN = ['Central', 'Martin Place', 'Sydenham', 'Bankstown'];
  var RAIL = ['train', 'metro', 'tram'];

  // ---------- flat metres around Sydney ----------
  var LAT0 = -33.87;
  var KY = 110574;
  var KX = 111320 * Math.cos(LAT0 * Math.PI / 180);
  function toX(lon) { return (lon - 151) * KX; }
  function toY(lat) { return (lat - LAT0) * KY; }
  function toLon(x) { return x / KX + 151; }
  function toLat(y) { return y / KY + LAT0; }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function copy(o, extra) {
    var out = {};
    var k;
    for (k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
    if (extra) for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    return out;
  }
  function last(list) { return list[list.length - 1]; }

  function sydneyClock(t) {
    return new Date((t + SYDNEY_OFFSET) * 1000).toISOString().slice(11, 19);
  }

  // ---------- reading GPX ----------
  function readGpx(text) {
    var pts = [];
    var re = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
    var m;
    while ((m = re.exec(text))) {
      var lat = /\blat\s*=\s*["']([-\d.]+)/.exec(m[1]);
      var lon = /\blon\s*=\s*["']([-\d.]+)/.exec(m[1]);
      var time = /<time>([^<]+)<\/time>/.exec(m[2]);
      if (!lat || !lon || !time) continue;
      var t = Date.parse(time[1].trim()) / 1000;
      if (!isFinite(t)) continue;
      var ele = /<ele>([^<]+)<\/ele>/.exec(m[2]);
      var la = +lat[1], lo = +lon[1];
      if (!isFinite(la) || !isFinite(lo)) continue;
      var ev = ele ? +ele[1] : null;
      pts.push({ t: t, lat: la, lon: lo, x: toX(lo), y: toY(la), ele: ev !== null && isFinite(ev) ? ev : null, src: 'gps' });
    }
    pts.sort(function (a, b) { return a.t - b.t; });
    var out = [];
    pts.forEach(function (p) { if (!out.length || p.t > last(out).t) out.push(p); });
    return out;
  }

  function gpxName(text) {
    var trk = /<trk>[\s\S]*?<name>([^<]*)<\/name>/.exec(text);
    return trk ? trk[1].trim() : '';
  }

  // ---------- the rail network ----------
  function buildNetwork(geo) {
    var nodes = [];
    var adj = [];
    var grids = {};
    var CELL = 18;
    function key(x, y) { return Math.floor(x / CELL) + ',' + Math.floor(y / CELL); }

    function nodeAt(x, y, mode) {
      var g = grids[mode] || (grids[mode] = new Map());
      var cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
      var best = -1, bd = CELL;
      for (var i = -1; i <= 1; i++) {
        for (var j = -1; j <= 1; j++) {
          var list = g.get((cx + i) + ',' + (cy + j));
          if (!list) continue;
          for (var q = 0; q < list.length; q++) {
            var n = list[q];
            var d = Math.hypot(nodes[n].x - x, nodes[n].y - y);
            if (d < bd) { bd = d; best = n; }
          }
        }
      }
      if (best >= 0) return best;
      nodes.push({ x: x, y: y, mode: mode, station: '' });
      adj.push([]);
      var k = key(x, y);
      if (!g.has(k)) g.set(k, []);
      g.get(k).push(nodes.length - 1);
      return nodes.length - 1;
    }
    function link(a, b, len, mode) {
      if (a === b) return;
      if (adj[a].some(function (e) { return e[0] === b; })) return;
      adj[a].push([b, len, mode]);
      adj[b].push([a, len, mode]);
    }

    geo.features.forEach(function (f) {
      var mode = f.properties.m;
      if (RAIL.indexOf(mode) === -1) return;
      var g = f.geometry;
      var lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      lines.forEach(function (line) {
        var prev = null;
        for (var i = 0; i < line.length; i++) {
          var x = toX(line[i][0]), y = toY(line[i][1]);
          if (prev !== null) {
            // short stretches between nodes
            var px = nodes[prev].x, py = nodes[prev].y;
            var len = Math.hypot(x - px, y - py);
            var steps = Math.max(1, Math.ceil(len / 40));
            for (var s = 1; s <= steps; s++) {
              var n = nodeAt(px + (x - px) * s / steps, py + (y - py) * s / steps, mode);
              if (n !== prev) {
                link(prev, n, Math.hypot(nodes[n].x - nodes[prev].x, nodes[n].y - nodes[prev].y), mode);
                prev = n;
              }
            }
          } else {
            prev = nodeAt(x, y, mode);
          }
        }
      });
    });

    // pieces that stop short of each other (several do at Central): each
    // loose end joins the nearest track of its mode within 150 m that is
    // not already close by along the line
    var loose = [];
    var i;
    for (i = 0; i < nodes.length; i++) if (adj[i].length === 1) loose.push(i);
    loose.forEach(function (i) {
      var mode = nodes[i].mode;
      var nearby = new Set([i]);
      var frontier = [i];
      for (var hop = 0; hop < 6; hop++) {
        var nextF = [];
        frontier.forEach(function (n) {
          adj[n].forEach(function (e) { if (!nearby.has(e[0])) { nearby.add(e[0]); nextF.push(e[0]); } });
        });
        frontier = nextF;
      }
      var best = -1, bd = 150;
      var g = grids[mode];
      var cx = Math.floor(nodes[i].x / CELL), cy = Math.floor(nodes[i].y / CELL);
      var span = Math.ceil(150 / CELL);
      for (var a = -span; a <= span; a++) {
        for (var b = -span; b <= span; b++) {
          var list = g.get((cx + a) + ',' + (cy + b)) || [];
          for (var q = 0; q < list.length; q++) {
            var n = list[q];
            if (nearby.has(n)) continue;
            var d = Math.hypot(nodes[n].x - nodes[i].x, nodes[n].y - nodes[i].y);
            if (d < bd) { bd = d; best = n; }
          }
        }
      }
      if (best >= 0) link(i, best, bd, mode);
    });

    // stations: the nodes near each one stop there, and every node within
    // a short walk of it can change to every other through it
    var all = new Map();
    for (i = 0; i < nodes.length; i++) {
      var k = Math.floor(nodes[i].x / 200) + ',' + Math.floor(nodes[i].y / 200);
      if (!all.has(k)) all.set(k, []);
      all.get(k).push(i);
    }
    function near(x, y, r) {
      var out = [];
      var cx = Math.floor(x / 200), cy = Math.floor(y / 200);
      var span = Math.ceil(r / 200);
      for (var a = -span; a <= span; a++) {
        for (var b = -span; b <= span; b++) {
          var list = all.get((cx + a) + ',' + (cy + b)) || [];
          for (var q = 0; q < list.length; q++) {
            var n = list[q];
            var d = Math.hypot(nodes[n].x - x, nodes[n].y - y);
            if (d <= r) out.push([n, d]);
          }
        }
      }
      return out;
    }
    var stations = [];
    geo.features.concat(EXTRA_STATIONS).forEach(function (f) {
      var mode = f.properties.m;
      if (f.geometry.type !== 'Point' || RAIL.indexOf(mode) === -1) return;
      var s = { name: f.properties.name, mode: mode, x: toX(f.geometry.coordinates[0]), y: toY(f.geometry.coordinates[1]) };
      stations.push(s);
      var modes = [mode];
      if (mode === 'train' && METRO_AT_TRAIN.indexOf(s.name) !== -1) modes.push('metro');
      // the stopping point on each line: its node nearest the station
      var bestPerLine = new Map();
      near(s.x, s.y, mode === 'tram' ? 80 : 250).forEach(function (nd) {
        var n = nd[0], d = nd[1];
        if (modes.indexOf(nodes[n].mode) === -1) return;
        if (nodes[n].mode === mode && d > 160) return;
        var k = nodes[n].mode + ':' + Math.round(d / 1000);
        var cur = bestPerLine.get(k);
        if (!cur || d < cur[1]) bestPerLine.set(k, [n, d]);
      });
      bestPerLine.forEach(function (nd) { if (!nodes[nd[0]].station) nodes[nd[0]].station = s.name; });
      nodes.push({ x: s.x, y: s.y, mode: 'walk', station: s.name, hub: true });
      adj.push([]);
      var hub = nodes.length - 1;
      near(s.x, s.y, 220).forEach(function (nd) {
        if (nodes[nd[0]].hub) return;
        link(hub, nd[0], nd[1] + 150, 'walk');
      });
    });
    // a stopping point also stops the nodes within 60 m on its mode, so
    // the other track or direction stops there too
    for (i = 0; i < nodes.length; i++) {
      if (!nodes[i].station || nodes[i].hub) continue;
      near(nodes[i].x, nodes[i].y, 60).forEach(function (nd) {
        var n = nd[0];
        if (!nodes[n].hub && nodes[n].mode === nodes[i].mode && !nodes[n].station && nd[1] < 60) nodes[n].stationNear = nodes[i].station;
      });
    }
    return { nodes: nodes, adj: adj, near: near, stations: stations };
  }

  function nearestStation(net, p, modes) {
    var best = null, bd = Infinity;
    net.stations.forEach(function (s) {
      if (modes && modes.indexOf(s.mode) === -1) return;
      var d = Math.hypot(s.x - p.x, s.y - p.y);
      if (d < bd) { bd = d; best = s; }
    });
    return best ? { name: best.name, mode: best.mode, d: bd } : null;
  }

  // ---------- a small binary heap ----------
  function Heap() { this.a = []; }
  Heap.prototype.push = function (k, v) {
    var a = this.a;
    a.push([k, v]);
    var i = a.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      var t = a[p]; a[p] = a[i]; a[i] = t;
      i = p;
    }
  };
  Heap.prototype.pop = function () {
    var a = this.a;
    var top = a[0];
    var end = a.pop();
    if (a.length) {
      a[0] = end;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1, r = l + 1, m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        var t = a[m]; a[m] = a[i]; a[i] = t;
        i = m;
      }
    }
    return top;
  };

  // Cheapest route from point A to point B. With guide points (the fixes
  // on the way) track far from all of them costs three times its length,
  // so the route follows the fixes; with none (a tunnel) it is the
  // shortest, leaning towards the metro.
  function routeBetween(net, A, B, guide) {
    var nodes = net.nodes, adj = net.adj;
    var gcell = 200;
    var ggrid = new Map();
    guide.forEach(function (g) {
      var k = Math.floor(g.x / gcell) + ',' + Math.floor(g.y / gcell);
      if (!ggrid.has(k)) ggrid.set(k, []);
      ggrid.get(k).push(g);
    });
    var tunnel = guide.length === 0;
    var factorCache = new Map();
    function factor(a, b, mode) {
      var k = a < b ? a + ':' + b : b + ':' + a;
      var f = factorCache.get(k);
      if (f !== undefined) return f;
      if (tunnel) {
        f = mode === 'metro' ? 0.85 : mode === 'tram' ? 1.6 : mode === 'walk' ? 1.2 : 1;
      } else {
        var mx = (nodes[a].x + nodes[b].x) / 2, my = (nodes[a].y + nodes[b].y) / 2;
        var cx = Math.floor(mx / gcell), cy = Math.floor(my / gcell);
        var dmin = 400;
        for (var i = -2; i <= 2; i++) {
          for (var j = -2; j <= 2; j++) {
            var list = ggrid.get((cx + i) + ',' + (cy + j)) || [];
            for (var q = 0; q < list.length; q++) {
              var d = Math.hypot(list[q].x - mx, list[q].y - my);
              if (d < dmin) dmin = d;
            }
          }
        }
        f = 1 + 2 * Math.min(1, dmin / 250);
      }
      factorCache.set(k, f);
      return f;
    }
    var starts = net.near(A.x, A.y, 900).filter(function (nd) { return !nodes[nd[0]].hub; });
    var ends = new Map(net.near(B.x, B.y, 900).filter(function (nd) { return !nodes[nd[0]].hub; }));
    if (!starts.length || !ends.size) return null;
    var cost = new Map(), prev = new Map();
    var heap = new Heap();
    // walking on or off the network costs more than riding any stretch of
    // line, so the route runs as close to both ends as the lines go
    starts.forEach(function (nd) { cost.set(nd[0], nd[1] * 4); heap.push(nd[1] * 4, nd[0]); prev.set(nd[0], -1); });
    var best = Infinity, bestEnd = -1, pops = 0;
    var costOf = function (n) { var c = cost.get(n); return c === undefined ? Infinity : c; };
    while (heap.a.length) {
      var top = heap.pop();
      var c = top[0], n = top[1];
      if (c > costOf(n)) continue;
      if (c >= best) break;
      if (++pops > 400000) break;
      if (ends.has(n)) {
        var total = c + ends.get(n) * 4;
        if (total < best) { best = total; bestEnd = n; }
      }
      var edges = adj[n];
      for (var e = 0; e < edges.length; e++) {
        var m = edges[e][0];
        var nc = c + edges[e][1] * factor(n, m, edges[e][2]);
        if (nc < costOf(m)) { cost.set(m, nc); prev.set(m, n); heap.push(nc, m); }
      }
    }
    if (bestEnd < 0) return null;
    var ids = [];
    for (var at = bestEnd; at !== -1; at = prev.get(at)) ids.push(at);
    ids.reverse();
    return ids;
  }

  // the route as a line with the distance along it, each stretch's mode
  // and where it stops
  function routeLine(net, ids) {
    var nodes = net.nodes, adj = net.adj;
    var pts = [];
    var D = 0;
    for (var i = 0; i < ids.length; i++) {
      var n = nodes[ids[i]];
      var mode = 'walk';
      if (i > 0) {
        D += Math.hypot(n.x - nodes[ids[i - 1]].x, n.y - nodes[ids[i - 1]].y);
        var want = ids[i];
        var e = adj[ids[i - 1]].find(function (x) { return x[0] === want; });
        mode = e ? e[2] : n.mode;
      }
      pts.push({ x: n.x, y: n.y, D: D, mode: mode, station: n.hub ? '' : (n.station || n.stationNear || ''), hub: !!n.hub, hubName: n.hub ? n.station : '' });
    }
    // a stop is counted once per run of nodes that share its name
    for (var k = 1; k < pts.length; k++) if (pts[k].station && pts[k].station === pts[k - 1].station) pts[k - 1].station = '';
    return pts;
  }

  function projectOnLine(line, p) {
    var best = { d: Infinity, D: 0, i: 0 };
    for (var i = 1; i < line.length; i++) {
      var a = line[i - 1], b = line[i];
      var dx = b.x - a.x, dy = b.y - a.y;
      var L2 = dx * dx + dy * dy;
      var u = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
      u = Math.max(0, Math.min(1, u));
      var d = Math.hypot(p.x - (a.x + u * dx), p.y - (a.y + u * dy));
      if (d < best.d) best = { d: d, D: a.D + u * (b.D - a.D), i: i, mode: b.mode };
    }
    return best;
  }

  function pointAt(line, D) {
    if (D <= 0) return { x: line[0].x, y: line[0].y, mode: line[1] ? line[1].mode : 'walk' };
    for (var i = 1; i < line.length; i++) {
      if (line[i].D >= D) {
        var a = line[i - 1], b = line[i];
        var u = b.D > a.D ? (D - a.D) / (b.D - a.D) : 0;
        return { x: a.x + u * (b.x - a.x), y: a.y + u * (b.y - a.y), mode: b.mode };
      }
    }
    var l = last(line);
    return { x: l.x, y: l.y, mode: l.mode };
  }

  // the part of a route between D0 and D1, measured from D0
  function subLine(line, D0, D1) {
    var out = [];
    var p0 = pointAt(line, D0);
    out.push({ x: p0.x, y: p0.y, D: 0, mode: line[1] ? line[1].mode : 'walk', station: '', hub: false, hubName: '' });
    line.forEach(function (v) {
      if (v.D <= D0 || v.D >= D1) return;
      out.push(copy(v, { D: v.D - D0 }));
    });
    var p1 = pointAt(line, D1);
    var mode = 'walk';
    for (var i = 0; i < line.length; i++) if (line[i].D >= D1) { mode = line[i].mode; break; }
    out.push({ x: p1.x, y: p1.y, D: D1 - D0, mode: mode, station: '', hub: false, hubName: '' });
    return out;
  }

  // The longest run of fixes, in order along the route and in time, that a
  // vehicle could have joined up: tunnel fixes from the phone network carry
  // wrong times and would otherwise make a train jump.
  function plausibleAnchors(line, anchors, endAnchor, startAnchor) {
    function cap(a, b) {
      if (b.D < a.D - 30 || b.t <= a.t) return false;
      var dD = Math.max(0, b.D - a.D);
      var mid = pointAt(line, (a.D + b.D) / 2);
      return dD / (b.t - a.t) <= (MODES[mid.mode] || MODES.train).max * 1.15;
    }
    var all = (startAnchor ? [startAnchor] : []).concat(anchors, [endAnchor]);
    var n = all.length;
    var best = new Array(n).fill(startAnchor ? -Infinity : 1), prev = new Array(n).fill(-1);
    best[0] = 1;
    for (var i = 1; i < n; i++) {
      for (var j = Math.max(0, i - 60); j < i; j++) {
        if (best[j] + 1 > best[i] && cap(all[j], all[i])) { best[i] = best[j] + 1; prev[i] = j; }
      }
    }
    if (best[n - 1] === -Infinity) return [];
    var chain = [];
    for (var k = prev[n - 1]; k >= 0; k = prev[k]) chain.push(all[k]);
    chain.reverse();
    return startAnchor ? chain.slice(1) : chain;
  }

  // a ride from D0 to D1 at the typical speeds, as knots [distance,
  // seconds from the start] with a stop at each station between
  function rideProfile(line, D0, D1) {
    var knots = [[D0, 0]];
    var t = 0, at = D0;
    for (var i = 1; i < line.length && at < D1; i++) {
      var b = line[i];
      if (b.D <= D0) continue;
      var to = Math.min(b.D, D1);
      var mode = MODES[b.mode] || MODES.train;
      t += (to - at) / mode.speed;
      at = to;
      if (to === b.D && to < D1 && b.station) {
        knots.push([at, t]);
        t += mode.dwell;
        knots.push([at, t]);
      }
    }
    if (last(knots)[0] !== D1 || knots.length === 1) knots.push([D1, t]);
    return { knots: knots, total: t };
  }

  // ---------- recorded trips ----------
  // String-line history (TfNSW Open Data, saved by TransportSeek): each
  // line's stops by km along it and every recorded trip as [time, km].
  function normName(n) {
    return String(n || '').toLowerCase().replace(/\s+(station|light rail)$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  }
  // files: [{name, data}], data being a line's string-line JSON
  function loadTrips(files) {
    var out = [];
    (files || []).forEach(function (f) {
      var d = f.data;
      if (!d || !d.stops || !d.trips) return;
      var stops = new Map(d.stops.map(function (st) { return [normName(st.name), st.km]; }));
      out.push({
        line: (d.line && d.line.id) || String(f.name || '').replace(/\.json$/, ''),
        mode: (d.line && d.line.mode) || '',
        stops: stops,
        trips: d.trips.filter(function (t) { return t.points && t.points.length > 1; })
      });
    });
    return out;
  }

  function timeAtKm(points, km, dir) {
    for (var i = 1; i < points.length; i++) {
      var t0 = points[i - 1][0], k0 = points[i - 1][1], t1 = points[i][0], k1 = points[i][1];
      if (k1 === k0 || Math.sign(k1 - k0) !== dir) continue;
      if ((k0 - km) * (k1 - km) <= 0) {
        if (t1 - t0 > 300) return null;
        return t0 + (t1 - t0) * (km - k0) / (k1 - k0);
      }
    }
    return null;
  }

  // the recorded trip between two stations that left after `earliest` and
  // arrived by `latest`, arriving as late as possible: the GPS came back
  // soon after the team got off
  function findTrip(trips, from, to, earliest, latest, mode) {
    var a = normName(from), b = normName(to);
    var best = null;
    trips.forEach(function (L) {
      if (mode && L.mode && L.mode !== mode) return;
      if (!L.stops.has(a) || !L.stops.has(b)) return;
      var kin = L.stops.get(a), kout = L.stops.get(b);
      if (kin === kout) return;
      var dir = Math.sign(kout - kin);
      L.trips.forEach(function (trip) {
        var tin = timeAtKm(trip.points, kin, dir);
        if (tin == null || tin < earliest) return;
        var tout = timeAtKm(trip.points, kout, dir);
        if (tout == null || tout > latest || tout <= tin) return;
        // two crossings read off one long gap in the feed are not a ride
        if (Math.abs(kout - kin) * 1000 / (tout - tin) > 30) return;
        if (!best || tout > best.tout) {
          var pts = trip.points.filter(function (p) { return p[0] > tin && p[0] < tout && (p[1] - kin) * dir > 0 && (kout - p[1]) * dir > 0; });
          best = { line: L.line, run: trip.run || '', tripId: trip.tripId, kin: kin, kout: kout, tin: tin, tout: tout, dir: dir, pts: pts, stops: L.stops };
        }
      });
    });
    return best;
  }

  var TRIP_MODE = { metro: 'metro', train: 'train', tram: 'lightrail' };

  // The recorded trip that explains a tunnel ride, placed on the route: the
  // stations near each end are tried nearest first, and every stop of the
  // trip's line between them is projected onto the route so its km can be
  // turned into distance along it.
  function recordedRide(net, trips, line, mode, A, B, earliest, latest) {
    function near(P) {
      var seen = new Set();
      return net.stations.map(function (st) { return { st: st, d: Math.hypot(st.x - P.x, st.y - P.y) }; })
        .filter(function (o) { return o.d < 700; })
        .sort(function (a, b) { return a.d - b.d; })
        .filter(function (o) { var n = normName(o.st.name); if (seen.has(n)) return false; seen.add(n); return true; })
        .map(function (o) { return o.st; });
    }
    var byName = new Map();
    net.stations.forEach(function (st) {
      var n = normName(st.name);
      if (!byName.has(n)) byName.set(n, []);
      byName.get(n).push(st);
    });
    function onLine(name) {
      var best = null;
      (byName.get(normName(name)) || []).forEach(function (st) {
        var pr = projectOnLine(line, st);
        if (pr.d < 350 && (!best || pr.d < best.d)) best = pr;
      });
      return best;
    }
    var tripMode = TRIP_MODE[mode];
    var nearA = near(A), nearB = near(B);
    for (var i = 0; i < nearA.length; i++) {
      for (var j = 0; j < nearB.length; j++) {
        var a = nearA[i], b = nearB[j];
        var pa = onLine(a.name), pb = onLine(b.name);
        if (!pa || !pb || pa.D >= pb.D - 300) continue;
        var trip = findTrip(trips, a.name, b.name, earliest, latest, tripMode);
        if (!trip) continue;
        var pairs = [];
        trip.stops.forEach(function (km, name) {
          if ((km - trip.kin) * trip.dir < -0.01 || (trip.kout - km) * trip.dir < -0.01) return;
          var pr = onLine(name);
          if (pr) pairs.push([km, pr.D]);
        });
        var dir = trip.dir;
        pairs.sort(function (x, y) { return (x[0] - y[0]) * dir; });
        var mono = [];
        pairs.forEach(function (q) { if (!mono.length || q[1] > last(mono)[1]) mono.push(q); });
        if (mono.length < 2) continue;
        var toD = makeKmToD(mono, dir);
        // a median of three takes out a position the feed reported late
        var raw = trip.pts.map(function (p) { return [toD(p[1]), p[0]]; });
        var knots = raw.map(function (r, k) {
          if (k === 0 || k === raw.length - 1) return [r[0], r[1]];
          var three = [raw[k - 1][0], r[0], raw[k + 1][0]].sort(function (x, y) { return x - y; });
          return [three[1], r[1]];
        });
        for (var k = 1; k < knots.length; k++) if (knots[k][0] < knots[k - 1][0]) knots[k][0] = knots[k - 1][0];
        return { trip: trip, Din: pa.D, Dout: pb.D, knots: knots };
      }
    }
    return null;
  }
  function makeKmToD(mono, dir) {
    return function (km) {
      for (var i = 1; i < mono.length; i++) {
        var k0 = mono[i - 1][0], d0 = mono[i - 1][1], k1 = mono[i][0], d1 = mono[i][1];
        if ((km - k0) * dir >= 0 && (k1 - km) * dir >= 0) return d0 + (d1 - d0) * (km - k0) / (k1 - k0);
      }
      return (km - mono[0][0]) * dir < 0 ? mono[0][1] : last(mono)[1];
    };
  }

  // ---------- the steps ----------
  function dropOutsideDay(pts) {
    return pts.filter(function (p) {
      var d = (p.t + SYDNEY_OFFSET) % 86400;
      return d >= DAY_FROM && d <= DAY_TO;
    });
  }

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function dropSpikes(pts, notes) {
    var changed = true, total = 0;
    for (var pass = 0; changed && pass < 6; pass++) {
      changed = false;
      var keep = [pts[0]];
      for (var i = 1; i < pts.length; i++) {
        var a = last(keep);
        var p = pts[i];
        var dt = Math.max(1, p.t - a.t);
        var d = dist(a, p);
        if (d > 150 && d / dt > 40) {
          // does it come back within two minutes?
          var back = -1;
          for (var j = i + 1; j < pts.length && pts[j].t - p.t <= 120; j++) {
            var q = pts[j];
            if (dist(a, q) <= 150 + 3 * (q.t - a.t) && dist(q, pts[j - 1]) > 200) { back = j; break; }
          }
          if (back > 0) {
            total += back - i;
            i = back - 1;
            changed = true;
            continue;
          }
        }
        keep.push(p);
      }
      pts = keep;
    }
    if (total) notes.push('dropped ' + plural(total, 'spike point'));
    return pts;
  }

  function bearing(a, b) { return Math.atan2(b.y - a.y, b.x - a.x); }
  function dropFiller(pts, notes) {
    var drop = new Set();
    var i = 1;
    while (i < pts.length - 2) {
      var v0 = dist(pts[i - 1], pts[i]) / Math.max(1, pts[i].t - pts[i - 1].t);
      var b0 = bearing(pts[i - 1], pts[i]);
      if (v0 < 3) { i++; continue; }
      var j = i, sparse = pts[i].t - pts[i - 1].t >= 20;
      while (j + 1 < pts.length) {
        var dt = pts[j + 1].t - pts[j].t;
        var d = dist(pts[j], pts[j + 1]);
        if (d < 5) break;
        var v = d / Math.max(1, dt);
        var db = Math.abs(bearing(pts[j], pts[j + 1]) - b0);
        if (db > Math.PI) db = 2 * Math.PI - db;
        if (Math.abs(v - v0) / v0 > 0.015 || db > 0.07) break;
        if (dt >= 20) sparse = true;
        j++;
      }
      var span = pts[j].t - pts[i - 1].t;
      var len = dist(pts[i - 1], pts[j]);
      if (j - i >= 2 && sparse && span >= 120 && len >= 800) {
        for (var k = i; k < j; k++) drop.add(k);
        i = j;
      } else i++;
    }
    if (drop.size) notes.push('dropped ' + plural(drop.size, 'straight-line filler point'));
    return pts.filter(function (_, k) { return !drop.has(k); });
  }

  // speed over the last half minute at each point; a window never reaches
  // back across a gap, or a tunnel's jump would make the walk out of the
  // station look like a ride
  function windowSpeeds(pts) {
    var v = new Array(pts.length).fill(0);
    var k = 0, floor = 0;
    for (var i = 1; i < pts.length; i++) {
      var dt1 = pts[i].t - pts[i - 1].t, d1 = dist(pts[i - 1], pts[i]);
      if (dt1 >= 20 || d1 / Math.max(1, dt1) > 45) { v[i] = d1 / Math.max(1, dt1); floor = k = i; continue; }
      if (k < floor) k = floor;
      while (k < i - 1 && pts[i].t - pts[k + 1].t >= 30) k++;
      var dt = pts[i].t - pts[k].t;
      v[i] = dt >= 10 ? dist(pts[k], pts[i]) / dt : 0;
    }
    return v;
  }

  function findLegs(pts) {
    var v = windowSpeeds(pts);
    var fast = new Array(pts.length).fill(false);
    var i;
    for (i = 1; i < pts.length; i++) {
      var dt = pts[i].t - pts[i - 1].t;
      var d = dist(pts[i - 1], pts[i]);
      if (d >= 400 && (dt >= 60 || d / Math.max(1, dt) >= 2.5)) fast[i] = true;
      else if (v[i] >= VEHICLE && d >= 3) fast[i] = true;
    }
    var runs = [];
    for (i = 1; i < pts.length; i++) {
      if (!fast[i]) continue;
      var j = i;
      while (j + 1 < pts.length && fast[j + 1]) j++;
      runs.push([i - 1, j]);
      i = j;
    }
    // a train standing at a station is still the same ride
    var merged = [];
    runs.forEach(function (r) {
      var prev = last(merged);
      if (prev && pts[r[0]].t - pts[prev[1]].t <= 200) prev[1] = r[1];
      else merged.push([r[0], r[1]]);
    });
    return merged.map(function (se) {
      var s = se[0], e = se[1];
      var len = 0, vmax = 0, wild = false;
      for (var k = s + 1; k <= e; k++) {
        var dt = pts[k].t - pts[k - 1].t, d = dist(pts[k - 1], pts[k]);
        len += d;
        var brk = dt >= 20 || d / Math.max(1, dt) > 45;
        if (brk && d >= 300) wild = true;
        if (d / Math.max(1, dt) > 35 && d >= 300) wild = true;
        // the fastest between real fixes: the half-minute speed where fixes
        // come every second or two, each step's own where they are sparse
        if (!brk) vmax = Math.max(vmax, v[k]);
        else if (dt <= 130 && d / Math.max(1, dt) <= 45) vmax = Math.max(vmax, d / dt);
      }
      return { s: s, e: e, len: len, vmax: vmax, wild: wild };
    }).filter(function (l) { return l.len >= 700 || dist(pts[l.s], pts[l.e]) >= 700; });
  }

  // the earliest the team was already standing where the leg starts: a
  // phone that lost the sky keeps reporting the platform
  function standingSince(pts, s, floor) {
    var k = s;
    while (k - 1 > floor && dist(pts[k - 1], pts[s]) <= 180 && pts[s].t - pts[k - 1].t <= 45 * 60) k--;
    return k;
  }

  function why(ctx, leg, pts, msg) {
    if (ctx.log) ctx.log('    leg ' + sydneyClock(pts[leg.s].t) + '-' + sydneyClock(pts[leg.e].t) + ' ' + Math.round(leg.len) + 'm vmax ' + leg.vmax.toFixed(1) + ': ' + msg);
    return null;
  }

  // A leg with jumps or impossible speeds in it went through a tunnel, and
  // the few fixes the phone made down there (from the network, not the sky)
  // sit on a straight line rather than on the track. If they do not fit,
  // it is tried again with its two ends alone.
  function matchLeg(ctx, pts, leg, floor) {
    var m = matchWith(ctx, pts, leg, floor, false);
    if (m || !leg.wild || leg.e - leg.s < 2) return m;
    return matchWith(ctx, pts, leg, floor, true);
  }

  function matchWith(ctx, pts, leg, floor, ignoreFixes) {
    var net = ctx.net;
    var s = leg.s, e = leg.e;
    var A = pts[s], B = pts[e];
    var interior = ignoreFixes ? [] : pts.slice(s + 1, e);
    var straight = dist(A, B);
    var dt = B.t - A.t;
    // a short gap the team could have walked is left as a straight line
    if (!interior.length && straight < 1500 && straight / Math.max(1, dt) < 1.5) return why(ctx, leg, pts, 'short walkable gap');
    var ids = routeBetween(net, A, B, interior);
    if (!ids || ids.length < 2) return why(ctx, leg, pts, 'no route');
    // start and end where the team's own fixes meet the route, so a route
    // whose cheapest node lay past them does not make the team jump to it
    var full = routeLine(net, ids);
    var Lf = last(full).D;
    var part = function (D0, D1) { return full.filter(function (v) { return v.D >= D0 && v.D <= D1; }); };
    var pa = projectOnLine(part(0, Lf * 0.6), A);
    var pb = projectOnLine(part(Lf * 0.4, Lf), B);
    var line = pa.D < pb.D - 200 ? subLine(full, pa.D, pb.D) : full;
    var L = last(line).D;
    if (L < 500) return why(ctx, leg, pts, 'route too short');
    if (L > (ignoreFixes ? 1.6 : 2.2) * straight + 1500 && (ignoreFixes || L > 1.3 * leg.len + 1000)) return why(ctx, leg, pts, 'route too long ' + Math.round(L) + ' vs ' + Math.round(straight));

    // which mode carried most of it
    var byMode = {};
    for (var i = 1; i < line.length; i++) byMode[line[i].mode] = (byMode[line[i].mode] || 0) + line[i].D - line[i - 1].D;
    var modes = Object.keys(byMode).filter(function (m) { return m !== 'walk'; }).sort(function (a, b) { return byMode[b] - byMode[a]; });
    if (!modes.length) return why(ctx, leg, pts, 'walk only');
    var mode = modes[0];

    var startGap = Math.hypot(line[0].x - A.x, line[0].y - A.y);
    var endGap = Math.hypot(last(line).x - B.x, last(line).y - B.y);
    if (startGap > 900 || endGap > 900) return why(ctx, leg, pts, 'ends far from line');

    // the fixes on the way have to sit on the line
    var anchors = [];
    if (interior.length) {
      var onLine = 0;
      interior.forEach(function (p) {
        var pr = projectOnLine(line, p);
        if (pr.d <= (MODES[pr.mode] || MODES.train).fit) { onLine++; anchors.push({ D: pr.D, t: p.t }); }
      });
      // a few fixes on the way may be bad ones; many have to sit on the line
      if (interior.length > 3 && onLine / interior.length < 0.75) return why(ctx, leg, pts, 'only ' + (100 * onLine / interior.length).toFixed(0) + '% on the ' + mode + ' line');
      if (interior.length <= 3 && (startGap > 400 || endGap > 400)) return why(ctx, leg, pts, 'few fixes and ends far from line');
      var need = mode === 'tram' ? 5 : 11;
      if (interior.length > 3 && leg.vmax < need) return why(ctx, leg, pts, 'too slow for ' + mode);
    }

    // anchors in order along the line and in time
    var kept = [];
    anchors.forEach(function (a) {
      var prev = last(kept);
      if (prev && (a.t - prev.t < 8 || a.D < prev.D - 30)) return;
      if (prev && a.D < prev.D) a.D = prev.D;
      kept.push(a);
    });

    // already on board when the leg's first point is on the line and a fix
    // follows straight after; otherwise the team walked in and waited
    var sGap = startGap, eGap = endGap;
    var onStart = kept.length > 0 && sGap <= 150 && kept[0].t - A.t <= 90 && kept[0].D <= 1500;
    var onEnd = kept.length > 0 && eGap <= 150 && B.t - last(kept).t <= 90 && L - last(kept).D <= 1500;
    var walkIn = onStart ? sGap / WALK : Math.max(sGap / WALK, 60);
    var walkOut = onEnd ? eGap / WALK : Math.max(eGap / WALK, 90);
    kept = plausibleAnchors(line, kept, { D: L, t: B.t - walkOut }, onStart ? { D: 0, t: A.t + walkIn } : null);
    var start = s;
    if (!onStart) {
      var first = kept.length ? kept[0] : { D: L, t: B.t - walkOut };
      var ride0 = rideProfile(line, 0, first.D).total;
      // not enough time since the last fix: was the team already standing
      // there? A phone underground keeps reporting the platform
      if (A.t + walkIn + ride0 > first.t + 30) {
        var k0 = standingSince(pts, s, floor);
        if (k0 < s) start = k0;
      }
    }
    // a tunnel ride with a recorded trip to follow, between a station near
    // where the team was last seen and one near where it was seen again
    var real = null;
    if (!kept.length && ctx.trips && ctx.trips.length) {
      var k = standingSince(pts, s, floor);
      var earliest = pts[k].t + Math.min(walkIn, 120);
      real = recordedRide(net, ctx.trips, line, mode, A, B, earliest, B.t - 30);
      if (real) {
        var st = s;
        while (st > k && pts[st].t > real.trip.tin - 30) st--;
        start = Math.min(start, st);
      }
    }
    if (ctx.log) {
      if (real) ctx.log('      recorded trip ' + real.trip.line + ' ' + real.trip.run + ' ' + sydneyClock(real.trip.tin) + '-' + sydneyClock(real.trip.tout));
      var stops = [];
      line.forEach(function (p) {
        var tag = p.hub ? '[' + p.hubName + ']' : p.station;
        if (tag && last(stops) !== tag) stops.push(tag);
      });
      ctx.log('      via ' + stops.join(' > '));
      why(ctx, leg, pts, 'OK ' + mode + ' ' + Math.round(L) + 'm, ' + kept.length + ' anchors, start ' +
        (start < s ? 'moved back ' + Math.round(pts[s].t - pts[start].t) + 's' : 'as is') + (ignoreFixes ? ', tunnel fixes ignored' : ''));
    }
    return { line: line, mode: mode, kept: kept, start: start, end: e, walkIn: walkIn, walkOut: walkOut, onStart: onStart, onEnd: onEnd, L: L, interior: interior.length, real: real };
  }

  function timedPoints(match, pts) {
    var line = match.line, kept = match.kept, walkIn = match.walkIn, walkOut = match.walkOut, L = match.L;
    var A = pts[match.start], B = pts[match.end];
    var out = [];
    function place(D, t, src) {
      var q = pointAt(line, D);
      out.push({ t: t, x: q.x, y: q.y, lat: toLat(q.y), lon: toLon(q.x), ele: null, src: src, mode: q.mode });
    }
    var fin = [];
    if (match.real) {
      // the walk to the platform, the wait, then the recorded train
      var trip = match.real.trip, Din = match.real.Din, Dout = match.real.Dout;
      out.push(copy(A));
      var pin = pointAt(line, Din);
      var reach = Math.min(A.t + Math.max(60, Math.hypot(pin.x - A.x, pin.y - A.y) / WALK), trip.tin - 1);
      if (reach > A.t) place(Din, reach, 'walk');
      if (trip.tin - reach > 5) place(Din, trip.tin, 'wait');
      else place(Din, trip.tin, 'ride');
      match.real.knots.forEach(function (kn) { place(Math.max(Din, Math.min(Dout, kn[0])), kn[1], 'ride'); });
      place(Dout, trip.tout, 'ride');
      if (L - Dout > 20) {
        var pout = pointAt(line, L), pd = pointAt(line, Dout);
        var tl = Math.min(B.t - 1, trip.tout + Math.hypot(pout.x - pd.x, pout.y - pd.y) / WALK);
        if (tl > trip.tout) place(L, tl, 'walk');
      }
      out.push(copy(B));
      out.forEach(function (p) { if (!fin.length || p.t > last(fin).t) fin.push(p); });
      return fin;
    }
    // when the fixes leave less time than the walk and the ride need, every
    // part is shortened in proportion rather than one of them vanishing
    var lastFix = kept.length ? last(kept) : null;
    var arrive = B.t - walkOut;
    if (lastFix) {
      var tail = rideProfile(line, lastFix.D, L).total;
      var space = B.t - lastFix.t;
      if (space < tail + walkOut) arrive = lastFix.t + space * tail / Math.max(1, tail + walkOut);
    }
    var anchors = [{ D: 0, t: null }].concat(kept).concat([{ D: L, t: arrive }]);
    out.push(copy(A));
    var next = anchors[1];
    var ride = rideProfile(line, 0, next.D).total;
    var room = next.t - A.t;
    var board;
    if (room <= walkIn + ride) {
      board = A.t + room * walkIn / Math.max(1, walkIn + ride);
      if (board > A.t + 1) place(0, board, 'walk');
      anchors[0].t = board;
    } else if (match.onStart) {
      place(0, A.t + walkIn, 'walk');
      anchors[0].t = A.t + walkIn;
    } else {
      // board as late as the ride to the next fix allows: the walk in, then
      // the wait on the platform
      board = next.t - ride;
      place(0, A.t + walkIn, 'walk');
      if (board - (A.t + walkIn) > 5) place(0, board, 'wait');
      anchors[0].t = board;
    }
    for (var i = 1; i < anchors.length; i++) {
      var a = anchors[i - 1], b = anchors[i];
      if (b.t <= a.t) continue;
      if (b.D <= a.D) { place(a.D, b.t, 'ride'); continue; }
      var prof = rideProfile(line, a.D, b.D);
      var avail = b.t - a.t;
      var t0 = a.t, scale = avail / prof.total;
      // a long pause inside a ride is spent standing at the stop before it;
      // a short difference is just a slower or faster train
      var spare = avail - prof.total;
      if (spare >= 120 && avail > 1.5 * prof.total) { place(a.D, a.t + spare, 'wait'); t0 = a.t + spare; scale = 1; }
      var knots = prof.knots;
      for (var k = 1; k < knots.length; k++) {
        var d0 = knots[k - 1][0], s0 = knots[k - 1][1], d1 = knots[k][0], s1 = knots[k][1];
        var steps = Math.max(1, Math.ceil((d1 - d0) / 150));
        for (var q = 1; q <= steps; q++) place(d0 + (d1 - d0) * q / steps, t0 + (s0 + (s1 - s0) * q / steps) * scale, 'ride');
      }
    }
    out.push(copy(B));
    out.forEach(function (p) { if (!fin.length || p.t > last(fin).t) fin.push(p); });
    return fin;
  }

  function compressStays(pts, notes) {
    var out = [];
    var stays = [];
    var i = 0, n = 0;
    while (i < pts.length) {
      if (pts[i].src !== 'gps') { out.push(pts[i]); i++; continue; }
      var j = i + 1;
      // grow while every point stays near the running centre
      var sx = pts[i].x, sy = pts[i].y, c = 1;
      while (j < pts.length && pts[j].src === 'gps') {
        if (Math.hypot(pts[j].x - sx / c, pts[j].y - sy / c) > STAY_RADIUS) break;
        sx += pts[j].x; sy += pts[j].y; c++; j++;
      }
      if (j - 1 > i && pts[j - 1].t - pts[i].t >= STAY_MIN) {
        var span = pts.slice(i, j);
        var xs = span.map(function (p) { return p.x; }).sort(function (a, b) { return a - b; });
        var ys = span.map(function (p) { return p.y; }).sort(function (a, b) { return a - b; });
        var mx = xs[xs.length >> 1], my = ys[ys.length >> 1];
        var eles = span.map(function (p) { return p.ele; }).filter(function (e) { return e != null; }).sort(function (a, b) { return a - b; });
        var ele = eles.length ? eles[eles.length >> 1] : null;
        out.push({ t: pts[i].t, x: mx, y: my, lat: toLat(my), lon: toLon(mx), ele: ele, src: 'stay' });
        out.push({ t: pts[j - 1].t, x: mx, y: my, lat: toLat(my), lon: toLon(mx), ele: ele, src: 'stay' });
        stays.push({ from: pts[i].t, to: pts[j - 1].t, x: mx, y: my });
        n += j - i - 2;
        i = j;
      } else {
        out.push(pts[i]);
        i++;
      }
    }
    if (stays.length) notes.push(stays.length + ' stops, ' + n + ' jittery points squashed');
    return { pts: out, stays: stays };
  }

  // keep the points that matter to within tol metres at the right time
  function simplify(pts, tol) {
    var n = pts.length;
    if (n <= 2) return pts.slice();
    var keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    var stack = [[0, n - 1]];
    while (stack.length) {
      var ab = stack.pop();
      var a = ab[0], b = ab[1];
      var worst = -1, wd = tol;
      var pa = pts[a], pb = pts[b];
      var span = pb.t - pa.t;
      for (var k = a + 1; k < b; k++) {
        var u = span > 0 ? (pts[k].t - pa.t) / span : 0;
        var d = Math.hypot(pts[k].x - (pa.x + u * (pb.x - pa.x)), pts[k].y - (pa.y + u * (pb.y - pa.y)));
        if (d > wd) { wd = d; worst = k; }
      }
      if (worst > 0) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
    }
    return pts.filter(function (_, k) { return keep[k]; });
  }

  function lineStation(net, line, fromStart) {
    var seq = (fromStart ? line : line.slice().reverse()).slice(0, 12);
    for (var i = 0; i < seq.length; i++) if (seq[i].station) return seq[i].station;
    var end = fromStart ? line[0] : last(line);
    var s = nearestStation(net, end, RAIL);
    return s && s.d < 400 ? s.name : '';
  }

  // opts: {trips (from loadTrips), log (a function for the working)}
  function cleanTrack(net, raw, opts) {
    var ctx = { net: net, trips: (opts && opts.trips) || [], log: (opts && opts.log) || null };
    var notes = [];
    var pts = dropOutsideDay(raw);
    if (pts.length < 2) return { pts: pts, legs: [], stays: [], notes: ['no points inside the day'] };
    pts = dropSpikes(pts, notes);
    pts = dropFiller(pts, notes);
    var legs = findLegs(pts);
    var out = [];
    var done = [];
    var siteLegs = [];
    var cursor = 0;
    legs.forEach(function (leg) {
      if (leg.s < cursor) return;
      var m = matchLeg(ctx, pts, leg, cursor);
      if (!m) return;
      for (var k = cursor; k < m.start; k++) out.push(pts[k]);
      var made = timedPoints(m, pts);
      made.forEach(function (p) { out.push(p); });
      cursor = m.end + 1;
      var rides = made.filter(function (p) { return p.src === 'ride'; });
      var boardAt = rides.length ? made[made.indexOf(rides[0]) - 1].t : made[0].t;
      var waitP = made.filter(function (p) { return p.src === 'wait'; });
      var walkP = made.find(function (p) { return p.src === 'walk'; });
      var waited = waitP.length && walkP ? waitP[0].t - walkP.t : 0;
      // one leg per run on one mode, so a light rail ride and the train
      // after it are each named for what they were
      var run = null;
      var runs = [];
      made.forEach(function (q) {
        if (q.src !== 'ride' || q.mode === 'walk') { run = null; return; }
        if (!run || run.mode !== q.mode) { run = { mode: q.mode, a: q, b: q }; runs.push(run); }
        run.b = q;
      });
      runs.forEach(function (r) {
        if (r.b.t - r.a.t < 60 || dist(r.a, r.b) < 300) return;
        var sa = nearestStation(net, r.a, [r.mode]), sb = nearestStation(net, r.b, [r.mode]);
        siteLegs.push({ mode: r.mode, from: sa && sa.d < 500 ? sa.name : '', to: sb && sb.d < 500 ? sb.name : '', t0: r.a.t, t1: r.b.t, filled: !m.interior });
      });
      done.push({
        trip: m.real ? m.real.trip : null, waited: waited,
        rideMin: ((rides.length ? last(rides).t : boardAt) - boardAt) / 60,
        mode: m.mode, from: lineStation(net, m.line, true), to: lineStation(net, m.line, false),
        startT: boardAt, endT: last(made).t, tunnel: !m.interior, gapMin: (pts[m.end].t - pts[m.start].t) / 60
      });
    });
    for (var k = cursor; k < pts.length; k++) out.push(pts[k]);
    done.forEach(function (d) {
      notes.push(d.mode + ' ' + (d.from || '?') + ' to ' + (d.to || '?') + ', ' + sydneyClock(d.startT).slice(0, 5) + '–' + sydneyClock(d.endT).slice(0, 5) + ', ' +
        d.rideMin.toFixed(0) + ' min on board' + (d.waited >= 60 ? ' after ' + (d.waited / 60).toFixed(0) + ' min on the platform' : '') +
        (d.tunnel ? '; no fixes for ' + d.gapMin.toFixed(0) + ' min, filled along the line' : '; fixes snapped to the line') +
        (d.trip ? ', timed from the recorded ' + d.trip.line + ' trip' + (d.trip.run ? ' (run ' + d.trip.run + ')' : '') : ''));
    });
    var st = compressStays(out, notes);
    return { pts: st.pts, legs: siteLegs, stays: st.stays, notes: notes };
  }

  // ---------- writing ----------
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function writeGpx(name, pts) {
    var lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="SCS.2 track cleaner" xmlns="http://www.topografix.com/GPX/1/1">',
      ' <metadata><name>' + esc(name) + '</name></metadata>',
      ' <trk>',
      '  <name>' + esc(name) + '</name>',
      '  <trkseg>'
    ];
    var lastT = -Infinity;
    pts.forEach(function (p) {
      var ts = Math.round(p.t);
      if (ts <= lastT) return;
      lastT = ts;
      lines.push('   <trkpt lat="' + p.lat.toFixed(6) + '" lon="' + p.lon.toFixed(6) + '">' +
        (p.ele != null ? '<ele>' + p.ele.toFixed(1) + '</ele>' : '') +
        '<time>' + new Date(ts * 1000).toISOString().replace('.000', '') + '</time></trkpt>');
    });
    lines.push('  </trkseg>', ' </trk>', '</gpx>', '');
    return lines.join('\n');
  }

  // The replay's copy: times in seconds from t0, positions in 1e-5 degrees,
  // each as the difference from the one before.
  function replayData(team, res) {
    var pts = simplify(res.pts, REPLAY_TOLERANCE);
    if (!pts.length) {
      return { v: 1, team: team, t0: 0, t: [], y: [], x: [], legs: [], stays: [] };
    }
    var t0 = Math.round(pts[0].t);
    var t = [], y = [], x = [];
    var pt = t0, py = 0, px = 0;
    pts.forEach(function (p, i) {
      var ti = Math.round(p.t), yi = Math.round(p.lat * 1e5), xi = Math.round(p.lon * 1e5);
      if (i && ti <= pt) return;
      t.push(ti - pt); y.push(yi - py); x.push(xi - px);
      pt = ti; py = yi; px = xi;
    });
    return {
      v: 1,
      team: team,
      t0: t0,
      t: t, y: y, x: x,
      // a ride with no fixes on it (underground) is drawn dashed
      legs: res.legs.map(function (l) {
        var leg = { mode: l.mode, from: l.from, to: l.to, t0: Math.round(l.t0), t1: Math.round(l.t1) };
        if (l.filled) leg.filled = 1;
        return leg;
      }),
      stays: res.stays.filter(function (s) { return s.to - s.from >= 300; }).map(function (s) {
        return { t0: Math.round(s.from), t1: Math.round(s.to), lat: +toLat(s.y).toFixed(5), lon: +toLon(s.x).toFixed(5) };
      })
    };
  }

  function slug(s) {
    return String(s).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team';
  }

  return {
    network: buildNetwork,
    trips: loadTrips,
    readGpx: readGpx,
    gpxName: gpxName,
    clean: cleanTrack,
    toGpx: writeGpx,
    toReplay: replayData,
    slug: slug,
    clock: sydneyClock,
    dist: dist
  };
});
