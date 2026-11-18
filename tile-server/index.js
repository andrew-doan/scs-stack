import { PMTiles, EtagMismatch } from "pmtiles";

// Serves /{archive}/{z}/{x}/{y}.mvt from {archive}.pmtiles in R2, edge-cached.
// Any site may load the tiles: the map data is public.

class R2Source {
  constructor(env, archiveName) {
    this.env = env;
    this.archiveName = archiveName;
  }
  getKey() {
    return this.archiveName;
  }
  async getBytes(offset, length, _signal, etag) {
    const resp = await this.env.BUCKET.get(this.archiveName, {
      range: { offset, length },
    });
    if (!resp) throw new Error("Archive not found");
    // The caller passes the etag its cached header and directories came
    // from: if the archive has been replaced since, PMTiles drops them,
    // reads the new header and tries again.
    if (etag && resp.etag !== etag) throw new EtagMismatch(etag);
    const data = await resp.arrayBuffer();
    return { data, etag: resp.etag };
  }
}

// One PMTiles per archive for the life of the isolate, so its header and
// directory cache is read from R2 once, not once per uncached tile. A name
// that fails is dropped again (a made-up name in the URL keeps nothing).
const archives = new Map();
function archive(env, name) {
  let p = archives.get(name);
  if (!p) {
    p = new PMTiles(new R2Source(env, name + ".pmtiles"));
    archives.set(name, p);
  }
  return p;
}

// Tiles change only when the archive is replaced. The edge keeps them for a
// week; browsers for a day. Tiles already cached at the edge do not notice a
// replaced archive, so put a new archive under a new name (and point
// TS_CONFIG.tileUrl at it), or purge the zone's cache, when it is replaced.
const CACHING = "public, max-age=86400, s-maxage=604800, immutable";
const CORS = { "Access-Control-Allow-Origin": "*" };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    // Expect /{name}/{z}/{x}/{y}.mvt
    const match = url.pathname.match(/^\/([^/]+)\/(\d+)\/(\d+)\/(\d+)\.mvt$/);
    if (!match) return new Response("Not found", { status: 404, headers: CORS });

    // 1. Edge cache, keyed on the URL alone
    const cache = caches.default;
    const cacheKey = new Request(url.toString());
    const cached = await cache.match(cacheKey);
    if (cached) return cached;

    // 2. Cache miss: read from R2 via pmtiles
    const [, name, z, x, y] = match;
    let tile;
    try {
      tile = await archive(env, name).getZxy(+z, +x, +y);
    } catch (e) {
      archives.delete(name);
      return new Response("Archive error", { status: 500, headers: CORS });
    }

    if (!tile || !tile.data) {
      // no tile here, and there will not be one: the browser keeps the
      // answer for a day and does not ask again on every view
      return new Response(null, { status: 204, headers: { ...CORS, "Cache-Control": "public, max-age=86400" } });
    }

    const response = new Response(tile.data, {
      headers: { ...CORS, "Content-Type": "application/x-protobuf", "Cache-Control": CACHING },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
