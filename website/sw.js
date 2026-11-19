/* SCS.2 service worker — offline support for the PWA.
   PRECACHE files: fetched at install, then answered from the cache until
   the next version bump installs a new worker. Other pages and files:
   cached copy immediately, refreshed from the network in the background. */

var CACHE = 'scs2-cache-v474';

// Map tiles live in their own cache, kept across version bumps: they
// are big, slow to fetch and the same from one release to the next.
// TILE_CFG holds one synthetic request the settings rocker writes, so
// the page can turn the whole thing off without a new service worker.
var TILE_CACHE = 'scs2-tiles-v1';
var TILE_CFG = 'scs2-tiles-cfg';
var TILE_CFG_URL = '/__tiles';
// The host the map pulls tiles from (TILE_URL in scs-2-questlist-map.js).
// A host missing here still serves tiles and none of them are kept.
var TILE_HOSTS = ['tiles.scs.andyrew.space'];
var TILE_MAX = 800;   // tiles kept before the oldest are dropped
var TILE_TRIM = 80;   // how many go at a time
var TILE_CFG_TTL = 60000;
// a kept tile is fetched again behind the map once it is this old
var TILE_REFRESH = 7 * 86400000;
// The quest page's picture of the map as it was last drawn (one JPEG),
// kept across version bumps like the tiles.
var MAP_SHOT_CACHE = 'scs2-map-shot';

// Proof and quest images live under unguessable keys and never change
// under a key, so a copy is good forever: kept across version bumps
// in their own cache, served cache-first. Images only, and only whole
// ones — videos scrub with Range requests and are far too big.
// Bumped when what the worker serves under an unchanged URL changes.
// The file endpoints answer `immutable`, which is true of the bytes
// under a key but was not true of the copy built from them: the first
// pass at taking metadata out also took the orientation, so portrait
// photos came back on their side. Renaming the cache is what lets the
// corrected ones through to a device that already has the wrong ones.
var FILE_CACHE = 'scs2-files-v2';
var FILE_HOST = 'files.scs.andyrew.space';
var FILE_PATHS = ['/api/submit/file', '/api/quests/file', '/api/messages/file', '/api/slides/file', '/api/albums/file'];
var FILE_MAX = 400;               // images kept before the oldest go
var FILE_TRIM = 40;
var FILE_BYTES_MAX = 2500000;     // covers thumbs and viewing copies, not originals
// The home page's slideshow and the messages page show each picture as
// it was uploaded, not a smaller copy, so they are kept at a higher cap:
// a phone photo is two to eight megabytes, and kept, the page opens
// without asking for any of them again. Uploads go up to 25MB; one past
// this cap is left to the browser's own cache rather than taking that
// much of a phone.
var WHOLE_PATHS = ['/api/slides/file', '/api/messages/file'];
var SLIDE_BYTES_MAX = 12000000;
// grid thumbnails that came in a batch from /api/thumbs, each kept under
// the address it would have on its own
var THUMB_CACHE = 'scs2-thumbs-v1';
var THUMB_PATH = '/api/thumbs';
var THUMB_MAX = 1500;
var THUMB_TRIM = 100;
// a tile path ends in zoom/x/y, with or without an extension
// (/my_area/13/7534/4915.mvt). Built from a string so no escaped
// slashes are needed.
var TILE_PATH = new RegExp('/[0-9]+/[0-9]+/[0-9]+([.][a-z0-9]+)?$', 'i');

// What a phone needs with no signal on the day: the home page, the
// quests and their map, the tab, sending proof, messages, the two
// reference pages and the ticket. Everything else (sign-up, the terms,
// the gallery and albums, the compressor, and the pages that open after
// the event) is kept once it has been opened, like any other file.
var PRECACHE = [
  './',
  'questlist/',
  'questlist/full/full.js',
  'questlist/full/full.css',
  'ticket/',
  'ticket/ticket.css',
  'ticket/ticket.js',
  'ticket/qrcode.js',
  '404.html',
  'info/',
  'welfare/',
  'tab/',
  'tab/scs2-tab.js',
  'tab/scs2-tab.css',
  'submit/',
  'submit/submit.js',
  'submit/submit.css',
  'plan/',
  'plan/plan.js',
  'plan/plan.css',
  'messages/',
  'messages/messages.css',
  'messages/messages.js',
  'assets/haptics/index.mjs',
  'assets/haptics/chunk-4NSAIXAB.mjs',
  // the quest map: MapLibre, its base style, and the Latin glyphs for
  // the three faces the style sets names in
  'assets/maplibre/maplibre-gl.js',
  'assets/maplibre/maplibre-gl.css',
  'assets/maplibre/style.json',
  'assets/maplibre/fonts/Noto Sans Regular/0-255.pbf',
  'assets/maplibre/fonts/Noto Sans Medium/0-255.pbf',
  'assets/maplibre/fonts/Noto Sans Italic/0-255.pbf',
  'assets/transit.geojson',
  'assets/site.css',
  'assets/site.js',
  'assets/site-viewer.js',
  'assets/site-chrome.js',
  'assets/site-input.js',
  'assets/site-app.js',
  'assets/video-sizes.js',
  'assets/share-image.js',
  'questlist/scs-2-questlist.css',
  'questlist/scs-2-questlist.js',
  'questlist/scs-2-questlist-sheet.js',
  'questlist/scs-2-questlist-controls.js',
  'questlist/scs-2-questlist-map.js',
  'questlist/scs-2-questlist-screen.js',
  'manifest.webmanifest',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/icon-maskable-512.png',
  'assets/icons/apple-touch-icon.png',
  'assets/icons/favicon-32.png',
  'assets/icons/logo-64.png',
  'assets/icons/logo-128.png',
  'assets/icons/logo-256.png'
];

// Everything this worker stores is asked of the server, never of the
// browser's own HTTP cache. Something in front of the site can give a
// script hours of life there (Cloudflare does, by default, for a proxied
// domain), and then a new worker filled its new cache with the old
// files and served them on every load after, however many reloads:
// the page kept running the code from before the deploy, and only a
// private window, with no HTTP cache, saw the new one. `no-cache` still
// lets the browser ask "has this changed?" and take a 304, so an
// unchanged file costs a few hundred bytes, not the file.
function fromServer(request) {
  return fetch(request, { cache: 'no-cache' });
}

self.addEventListener('install', function (event) {
  event.waitUntil(
    caches.open(CACHE)
      .then(function (cache) {
        return cache.addAll(PRECACHE.map(function (url) { return new Request(url, { cache: 'no-cache' }); }));
      })
      .then(function () { return self.skipWaiting(); })
  );
});

// Off, because stored pages are answered with no request; an earlier
// worker turned it on, and the setting outlives the worker.
function disablePreload() {
  if (!self.registration.navigationPreload) return Promise.resolve();
  return self.registration.navigationPreload.disable().catch(function () { /* not supported */ });
}

self.addEventListener('activate', function (event) {
  event.waitUntil(
    disablePreload().then(function () { return caches.keys(); })
      .then(function (keys) {
        return Promise.all(keys.map(function (key) {
          // the tile and image caches and the tile flag survive every
          // version bump — a new release must not throw away a
          // downloaded map or the photos already seen
          if (key === CACHE || key === TILE_CACHE || key === TILE_CFG || key === FILE_CACHE || key === THUMB_CACHE || key === MAP_SHOT_CACHE) return null;
          return caches.delete(key);
        }));
      })
      .then(function () { return self.clients.claim(); })
  );
});

// Push notifications: every push shows a visible notification (iOS
// revokes subscriptions that stay silent), and tapping one opens the
// pushed link on whichever deployment the reader installed.
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (err) { data = { body: event.data ? event.data.text() : '' }; }
  var opts = {
    body: data.body || '',
    icon: 'assets/icons/icon-192.png',
    badge: 'assets/icons/icon-192.png',
    // no link means no link: the tap should bring the app forward
    // where the reader left it, not send them back to the home page
    data: { url: data.url || '' }
  };
  // a tagged notification replaces the one already showing under the
  // same tag; renotify decides whether the replacement buzzes again
  if (data.tag) {
    opts.tag = data.tag;
    opts.renotify = !!data.renotify;
  }
  event.waitUntil(self.registration.showNotification(data.title || 'SCS.2', opts));
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  // Links are resolved against this registration's own scope, so the
  // same push works on the live site, a Netlify preview or a local
  // server without knowing which one it landed on. No link means just
  // bring the app forward, wherever the reader had it open.
  var raw = event.notification.data && event.notification.data.url;
  var scope = self.registration.scope;
  var target = raw ? new URL(raw, scope).href : null;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        var client = list[i];
        if (client.url.indexOf(scope) !== 0) continue; // another origin's window
        if (target && 'navigate' in client) {
          return client.navigate(target).then(function (moved) {
            return (moved || client).focus();
          }, function () {
            // refused for a window this worker does not control
            return clients.openWindow(target || scope);
          });
        }
        if ('focus' in client) return client.focus();
      }
      return clients.openWindow(target || scope);
    })
  );
});

// A phone that has just woken or changed networks often loses its first
// request and gets the second: the page failed to load and a reload
// worked. So a page or file with no stored copy is asked for up to four
// more times over about four seconds before the fallback is shown —
// when no answer came back at all, or on 502, 503 or 504, which are a
// gateway saying the same thing. One with a stored copy is already on
// screen and has nothing to wait for. The tab worker's API is not this
// worker's to answer; the pages ask it through scs.fetch, which does
// the same.
var RETRY_DELAYS = [250, 500, 1000, 2000];

function wait(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function withRetries(get) {
  function attempt(i) {
    return get().then(function (response) {
      var busy = response.status === 502 || response.status === 503 || response.status === 504;
      if (!busy || i >= RETRY_DELAYS.length) return response;
      return wait(RETRY_DELAYS[i]).then(function () { return attempt(i + 1); });
    }, function (err) {
      // a device that knows it is offline gets the fallback at once
      if (i >= RETRY_DELAYS.length || self.navigator.onLine === false) throw err;
      return wait(RETRY_DELAYS[i]).then(function () { return attempt(i + 1); });
    });
  }
  return attempt(0);
}

// A page is stored under its address without the query. Every page is
// a static file and reads its query in the browser, so /ticket/?<blob>
// is the same file as /ticket/. Keyed with the query, a ticket link
// this phone had not opened before found nothing stored, so with no
// signal it fell back to the home page; and every ticket opened was
// stored again as a page of its own.
function pageKey(request) {
  var url = new URL(request.url);
  url.search = '';
  return url.href;
}

// the PRECACHE files by their full address, worked out on first use
var precached = Object.create(null);
var precachedKnown = false;
function isPrecached(href) {
  if (!precachedKnown) {
    PRECACHE.forEach(function (url) { precached[new URL(url, self.location.href).href] = true; });
    precachedKnown = true;
  }
  return precached[href] === true;
}

// A PRECACHE file with a stored copy is answered from it and not fetched
// again: a background copy would put the next build's file beside this
// build's others. Anything else is answered from its stored copy and
// refreshed behind it. `offline` is what a request with no stored copy
// gets when the network is down too.
function siteResponse(request, offline) {
  var navigating = request.mode === 'navigate';
  var key = navigating ? pageKey(request) : request;
  var fixed = isPrecached(navigating ? key : request.url);
  // This cache by name, never `caches.match(request)`. That form walks
  // every cache this origin has, in the order they were created, and
  // two of the others are big: up to 800 map tiles and up to 400
  // images. A version bump makes the new page cache the newest of the
  // four, so it is searched last — every page switch and every asset
  // paid for a scan of both of those first, on a worker that has just
  // been woken to answer it. Pages and assets only ever live here.
  return caches.open(CACHE).then(function (cache) {
    return cache.match(key);
  }).then(function (cached) {
    if (cached && fixed) return cached;
    // a page's own navigation goes as the browser sent it
    function get() { return navigating ? fetch(request) : fromServer(request); }
    var fetched = (cached ? get() : withRetries(get))
      .then(function (response) {
        if (response && response.ok) {
          var copy = response.clone();
          caches.open(CACHE).then(function (cache) { cache.put(key, copy); });
        }
        return response;
      })
      .catch(function () { return cached || offline(); });
    return cached || fetched;
  });
}

// ---------------- Offline map tiles ----------------
// The map's vector tiles come from our own tile workers. Kept in their
// own cache, they make the map work with no signal at all. A kept tile
// is answered with no request: tiles change only when the archive is
// replaced, so one is fetched again behind the map once it is a week old.
// A tile URL with a query is the page asking whether a host still
// answers, and goes to the network.

function isTileRequest(url) {
  if (TILE_HOSTS.indexOf(url.hostname) === -1 || url.search) return false;
  return TILE_PATH.test(url.pathname);
}

// The settings rocker writes 'on' or 'off' into TILE_CFG. Read at most
// once a minute; a flag that is not there yet counts as on.
var tilesOn = true;
var tilesReadAt = 0;

function tilesEnabled() {
  if (tilesReadAt && Date.now() - tilesReadAt < TILE_CFG_TTL) return Promise.resolve(tilesOn);
  return caches.open(TILE_CFG)
    .then(function (cache) { return cache.match(TILE_CFG_URL); })
    .then(function (res) { return res ? res.text() : ''; })
    .then(function (text) {
      tilesOn = text !== 'off';
      tilesReadAt = Date.now();
      return tilesOn;
    })
    .catch(function () { return true; });
}

// The settings rocker tells the worker as well as writing the flag, so
// a switch turned off stops the storing now rather than within the
// minute, and the cache the page throws away is not filled again.
self.addEventListener('message', function (event) {
  var data = event.data || {};
  if (data.type !== 'scs-tiles') return;
  tilesOn = data.on !== false;
  tilesReadAt = Date.now();
  if (!tilesOn) event.waitUntil(caches.delete(TILE_CACHE).catch(function () { /* nothing stored */ }));
});

// How many tiles to drop once the cache is over its cap. keys() comes
// back in insertion order, so the ones to go are at the front.
function tileTrimCount(total) {
  if (total <= TILE_MAX) return 0;
  return Math.max(TILE_TRIM, total - TILE_MAX);
}

var trimming = false;

function trimTiles(cache) {
  if (trimming) return Promise.resolve(0);
  trimming = true;
  return cache.keys().then(function (keys) {
    var drop = tileTrimCount(keys.length);
    if (!drop) return 0;
    return Promise.all(keys.slice(0, drop).map(function (key) {
      return cache.delete(key);
    })).then(function () { return drop; });
  }).catch(function () { return 0; }).then(function (dropped) {
    trimming = false;
    return dropped;
  });
}

var tileRefreshing = {};

// when a tile was kept, stamped by this worker: a cross-origin answer
// does not let script read its own Date header
function tileAge(response) {
  var stamp = Number(response.headers && response.headers.get('x-scs-kept'));
  return stamp ? Date.now() - stamp : Infinity;
}

function keepTile(cache, request, response) {
  return response.arrayBuffer().then(function (body) {
    return cache.put(request, new Response(body, {
      status: 200,
      headers: {
        'content-type': response.headers.get('content-type') || 'application/x-protobuf',
        'x-scs-kept': String(Date.now())
      }
    }));
  });
}

function tileResponse(request, event) {
  return tilesEnabled().then(function (on) {
    if (!on) return fetch(request);
    return caches.open(TILE_CACHE).then(function (cache) {
      var fetchAndStore = function () {
        return fetch(request).then(function (response) {
          // only a whole tile is worth keeping, and only while the switch
          // is still on; the store and the trim run behind the response
          if (response && response.status === 200 && tilesOn) {
            keepTile(cache, request, response.clone())
              .then(function () { return trimTiles(cache); })
              .catch(function () { /* out of room: the map still works */ });
          }
          return response;
        });
      };
      return cache.match(request).then(function (cached) {
        if (!cached) return fetchAndStore().catch(function () { return Response.error(); });
        if (tileAge(cached) > TILE_REFRESH && !tileRefreshing[request.url]) {
          tileRefreshing[request.url] = true;
          var refresh = fetchAndStore().catch(function () { /* the kept one stays */ })
            .then(function () { delete tileRefreshing[request.url]; });
          if (event && event.waitUntil) event.waitUntil(refresh);
        }
        return cached;
      });
    });
  }).catch(function () { return fetch(request); });
}

// ---------------- Proof and quest images ----------------
// Once an image has been seen it never needs the network again: keys
// are immutable, so a hit is final. Only readable (CORS) image
// responses under the size cap are stored — a video, a PDF, a partial
// response or an opaque one passes straight through.

function isFileRequest(url) {
  if (url.hostname !== FILE_HOST) return false;
  return FILE_PATHS.indexOf(url.pathname) !== -1;
}

var fileTrimming = false;

function trimFiles(cache) {
  if (fileTrimming) return Promise.resolve();
  fileTrimming = true;
  return cache.keys().then(function (keys) {
    if (keys.length <= FILE_MAX) return null;
    var drop = Math.max(FILE_TRIM, keys.length - FILE_MAX);
    return Promise.all(keys.slice(0, drop).map(function (key) { return cache.delete(key); }));
  }).catch(function () { /* the cache still works */ }).then(function () {
    fileTrimming = false;
  });
}

function keepableImage(request, response, max) {
  if (!response || response.status !== 200) return false;
  if (response.type !== 'cors' && response.type !== 'basic') return false; // opaque: unreadable, quota-padded
  if (request.headers.get('range')) return false;
  // an answer the worker says not to keep, such as a still standing in for a video
  if (/no-store/.test(response.headers.get('cache-control') || '')) return false;
  var type = response.headers.get('content-type') || '';
  if (type.indexOf('image/') !== 0) return false;
  var length = Number(response.headers.get('content-length'));
  return !!length && length <= (max || FILE_BYTES_MAX);
}

// again= only steers a retry past a failure the browser kept, and only
// good pictures are kept here, so it is not part of the key
function fileKey(request) {
  var url = new URL(request.url);
  url.searchParams.delete('again');
  return url.toString();
}

function fileResponse(request) {
  var max = WHOLE_PATHS.indexOf(new URL(request.url).pathname) !== -1 ? SLIDE_BYTES_MAX : FILE_BYTES_MAX;
  var key = fileKey(request);
  return caches.open(FILE_CACHE).then(function (cache) {
    return cache.match(key).then(function (cached) {
      if (cached) return cached;
      return fetch(request).then(function (response) {
        if (keepableImage(request, response, max)) {
          cache.put(key, response.clone())
            .then(function () { return trimFiles(cache); })
            .catch(function () { /* out of room: it still serves */ });
        }
        return response;
      });
    });
  }).catch(function () { return fetch(request); });
}

// ---------------- Thumbnails in batches ----------------
// The pages ask /api/thumbs for a screenful of grid thumbnails at once.
// Each part that comes back is kept on its own, so a thumbnail seen once
// is answered from here on every later visit and only the ones not kept
// go to the network, as a smaller batch. The answer is the worker's own
// shape: a four-byte length, that much JSON naming the parts, then their
// bytes in order.

function thumbParts(url) {
  var versions = url.searchParams.getAll('v');
  return url.searchParams.getAll('k').map(function (key, i) {
    var v = versions[i] || '';
    var path = key.indexOf('alb/') === 0
      ? '/api/albums/file?key=' + encodeURIComponent(key) + (v ? '&v=' + encodeURIComponent(v) : '') + '&thumb=1'
      : '/api/submit/file?key=' + encodeURIComponent(key) + '&thumb=1';
    return { key: key, v: v, address: url.origin + path };
  });
}

function packThumbs(parts) {
  var head = new TextEncoder().encode(JSON.stringify({ parts: parts.map(function (p) {
    return p.bytes ? { key: p.key, type: p.type, size: p.bytes.length } : { key: p.key, missing: true };
  }) }));
  var total = 4 + head.length;
  parts.forEach(function (p) { if (p.bytes) total += p.bytes.length; });
  var out = new Uint8Array(total);
  new DataView(out.buffer).setUint32(0, head.length);
  out.set(head, 4);
  var at = 4 + head.length;
  parts.forEach(function (p) {
    if (!p.bytes) return;
    out.set(p.bytes, at);
    at += p.bytes.length;
  });
  return out;
}

function unpackThumbs(buf) {
  var headLength = new DataView(buf).getUint32(0);
  var head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headLength)));
  var at = 4 + headLength;
  return (head.parts || []).map(function (p) {
    if (p.missing || !p.size) return { key: p.key, missing: true };
    var bytes = new Uint8Array(buf, at, p.size);
    at += p.size;
    return { key: p.key, type: p.type, bytes: bytes };
  });
}

var thumbTrimming = false;
function trimThumbs(cache) {
  if (thumbTrimming) return;
  thumbTrimming = true;
  cache.keys().then(function (keys) {
    if (keys.length <= THUMB_MAX) return null;
    var drop = Math.max(THUMB_TRIM, keys.length - THUMB_MAX);
    return Promise.all(keys.slice(0, drop).map(function (key) { return cache.delete(key); }));
  }).catch(function () { /* the cache still works */ }).then(function () {
    thumbTrimming = false;
  });
}

function thumbsAnswer(parts) {
  return new Response(packThumbs(parts), {
    headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' }
  });
}

function keptThumbs(cache, parts) {
  return Promise.all(parts.map(function (p) {
    return cache.match(p.address).then(function (hit) {
      if (!hit) return null;
      var type = hit.headers.get('content-type') || 'image/jpeg';
      return hit.arrayBuffer().then(function (b) { return { key: p.key, type: type, bytes: new Uint8Array(b) }; });
    });
  }));
}

function thumbsResponse(request) {
  var asked = new URL(request.url);
  var parts = thumbParts(asked);
  return caches.open(THUMB_CACHE).then(function (cache) {
    return keptThumbs(cache, parts).then(function (kept) {
      var missing = parts.filter(function (p, i) { return !kept[i]; });
      if (!missing.length) return thumbsAnswer(kept);
      var ask = new URL(asked.origin + THUMB_PATH);
      missing.forEach(function (p) {
        ask.searchParams.append('k', p.key);
        ask.searchParams.append('v', p.v);
      });
      var again = asked.searchParams.get('again');
      if (again) ask.searchParams.set('again', again);
      // a failure goes back to the page as it came, for the page to wait out
      return fetch(ask.toString(), { credentials: 'omit' }).then(function (res) {
        if (!res.ok) return res;
        return res.arrayBuffer().then(function (buf) {
          var got = unpackThumbs(buf);
          var j = 0;
          var all = kept.map(function (k, i) {
            if (k) return k;
            var g = got[j++] || { key: parts[i].key, missing: true };
            if (g.bytes) {
              cache.put(parts[i].address, new Response(g.bytes.slice(), {
                headers: { 'content-type': g.type, 'content-length': String(g.bytes.length) }
              })).catch(function () { /* out of room: it still serves */ });
            }
            return g;
          });
          trimThumbs(cache);
          return thumbsAnswer(all);
        });
      });
    }, function () { return fetch(request); });
  }, function () { return fetch(request); });
}

self.addEventListener('fetch', function (event) {
  var request = event.request;
  if (request.method !== 'GET') return;

  var url = new URL(request.url);
  if (isTileRequest(url)) { event.respondWith(tileResponse(request, event)); return; }
  if (isFileRequest(url)) {
    // a video scrubbing is never kept, so it is the browser's own
    if (request.headers.has('range')) return;
    event.respondWith(fileResponse(request));
    return;
  }
  if (url.hostname === FILE_HOST && url.pathname === THUMB_PATH) { event.respondWith(thumbsResponse(request)); return; }
  if (url.origin !== self.location.origin) return; // leave CDNs (Leaflet, fonts) to the browser

  event.respondWith(siteResponse(request, request.mode === 'navigate'
    ? function () { return toHomePage(request); }
    : function () { return Response.error(); }));
});

// Offline, a page never stored is sent to the home page by a redirect,
// so its relative links resolve from the home page's own address.
function toHomePage(request) {
  var home = self.registration.scope;
  if (pageKey(request) === home) return Response.error();
  return caches.open(CACHE).then(function (cache) { return cache.match(home); }).then(function (stored) {
    return stored ? Response.redirect(home, 302) : Response.error();
  });
}
