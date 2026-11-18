// Run with: node tests/verify-tracks.mjs   (needs Node 22+)
// The routes teams recorded for the GPS quest, saved on the dashboard's
// Routes tab (src/tracks.ts) and read by the replay (recap.ts). The page
// cleans a GPX file in the browser with the site's cleaner and sends what
// comes out; the worker has to take exactly that and nothing else, so the
// route here is made by the real cleaner, as the page makes it.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = join(BOT, '..', 'website');
const cleaner = createRequire(import.meta.url)(join(SITE, 'tab', 'replay', 'track-clean.js'));

let fail = 0;
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) fail++;
};

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);

const bucket = new Map();
const SUBMIT = {
  async put(key, value, opts) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(await new Response(value).arrayBuffer());
    bucket.set(key, { bytes, meta: (opts && opts.httpMetadata) || {} });
  },
  async get(key) {
    const hit = bucket.get(key);
    if (!hit) return null;
    return { size: hit.bytes.length, httpMetadata: hit.meta, body: hit.bytes,
      async arrayBuffer() { return hit.bytes.buffer.slice(hit.bytes.byteOffset, hit.bytes.byteOffset + hit.bytes.byteLength); } };
  },
  async head(key) { return bucket.has(key) ? { size: bucket.get(key).bytes.length } : null; },
  async delete(key) { bucket.delete(key); }
};

globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };
const mod = await import(BOT + '/src/index.ts');
const ENV = { DB: db, SUBMIT, CONSOLE_PASSWORD: 'tab-pass' };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, { waitUntil() {} });
const jpost = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
const save = (fields, token) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Blob) form.append(k, v, k === 'gpx' ? 'walk.gpx' : 'blob');
    else form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
  }
  return front('/api/console/tracks/save', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: form });
};
const admin = (await consoleSignIn(jpost, 'Tab', 'tab-pass')).session;

// a walk up George Street on the day, a fix every ten seconds from 10:00
// Sydney time (23:00 UTC the day before), wandering a little
function walkGpx(name) {
  const start = Date.parse('2026-10-19T23:00:00Z') / 1000;
  const pts = [];
  for (let i = 0; i < 120; i++) {
    const lat = -33.8830 + i * 0.00012;
    const lon = 151.2065 + Math.sin(i / 6) * 0.0002;
    pts.push(`<trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"><time>${new Date((start + i * 10) * 1000).toISOString()}</time></trkpt>`);
  }
  return `<?xml version="1.0"?><gpx version="1.1"><trk><name>${name}</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
}
const net = cleaner.network(JSON.parse(readFileSync(join(SITE, 'assets', 'transit.geojson'), 'utf8')));
const text = walkGpx('Morning Walk');
const res = cleaner.clean(net, cleaner.readGpx(text), {});
const route = cleaner.toReplay('whatever the page called it', res);
const gpx = new Blob([text], { type: 'application/gpx+xml' });

const teams = raw.prepare('SELECT id, name FROM teams WHERE hidden = 0 ORDER BY id LIMIT 3').all();
const [one, two, three] = teams;

// ---------------- saving a route the cleaner made ----------------
{
  const r = await save({
    team_id: String(one.id), route, gpx, source: 'Morning Walk.gpx', notes: 'Started at Central.',
    edits: { from: '10:00', to: '25:00', cut: [['10:05', '10:06'], ['10:09', '10:08'], 'nope'], extra: 1 }
  }, admin);
  const body = await r.json();
  const list = await (await get('/api/console/tracks', admin)).json();
  const row = list.tracks && list.tracks.find(t => t.team_id === one.id);
  const stored = raw.prepare('SELECT gpx_key, route FROM team_tracks WHERE team_id = ?').get(one.id);
  const kept = stored && bucket.get(stored.gpx_key);
  const back = await (await get('/api/console/tracks/gpx?team_id=' + one.id, admin)).json();
  check('a route the cleaner made saves with its GPX file under trk/, and what was cut keeps only the parts that are clock times',
    r.status === 200 && body.points === route.t.length && row && row.points === route.t.length && row.has_gpx &&
    row.source === 'Morning Walk.gpx' && row.notes === 'Started at Central.' && row.saved_by === 'Tab' &&
    JSON.stringify(row.edits) === JSON.stringify({ from: '10:00', to: '', cut: [['10:05', '10:06']] }) &&
    row.started_at === '2026-10-19 23:00:00' && /^trk\//.test(stored.gpx_key) && kept && new TextDecoder().decode(kept.bytes) === text &&
    back.ok && back.text === text && back.name === 'Morning Walk.gpx' && JSON.parse(stored.route).team === one.name,
    JSON.stringify({ status: r.status, body, row, key: stored && stored.gpx_key }));
}

// ---------------- what is refused ----------------
{
  const wrong = async (fields) => (await save(Object.assign({ team_id: String(two.id), route }, fields), admin)).status;
  const away = Object.assign({}, route, { y: [route.y[0] + 4000000].concat(route.y.slice(1)) });
  const backwards = Object.assign({}, route, { t: route.t.map((v, i) => (i === 1 ? -5 : v)) });
  const got = {
    version: await wrong({ route: Object.assign({}, route, { v: 2 }) }),
    away: await wrong({ route: away }),
    backwards: await wrong({ route: backwards }),
    short: await wrong({ route: Object.assign({}, route, { t: [0], y: [route.y[0]], x: [route.x[0]] }) }),
    notJson: await wrong({ route: '{not json' }),
    notGpx: await wrong({ gpx: new Blob(['just words'], { type: 'application/gpx+xml' }) }),
    noTeam: await wrong({ team_id: '99999' })
  };
  check('a route from somewhere else, out of order, too short or not one at all is refused, and so is a file that is not GPX',
    Object.values(got).every(s => s === 400) && !raw.prepare('SELECT 1 FROM team_tracks WHERE team_id = ?').get(two.id),
    JSON.stringify(got));
}

// ---------------- a GPX file a team sent as proof ----------------
{
  raw.prepare("INSERT INTO submissions (team_id, quest_code, status, submitted_at) VALUES (?, 'SQ1', 'accepted', '2026-10-20 05:00:00')").run(two.id);
  const sub = raw.prepare('SELECT MAX(id) AS id FROM submissions').get().id;
  raw.prepare("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, 'sub/gpxtwo', 'application/octet-stream', ?, 'two.gpx')").run(sub, text.length);
  raw.prepare("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, 'sub/photo', 'image/jpeg', 100, 'p.jpg')").run(sub);
  await SUBMIT.put('sub/gpxtwo', new TextEncoder().encode(text).buffer);
  const list = await (await get('/api/console/tracks', admin)).json();
  const sent = list.sent || [];
  const read = await (await get('/api/console/tracks/gpx?key=sub/gpxtwo', admin)).json();
  const photo = (await get('/api/console/tracks/gpx?key=sub/photo', admin)).status;
  const elsewhere = (await get('/api/console/tracks/gpx?key=trk/whatever', admin)).status;
  const otherTeam = (await save({ team_id: String(three.id), route, gpx_key: 'sub/gpxtwo' }, admin)).status;
  const r = await save({ team_id: String(two.id), route, gpx_key: 'sub/gpxtwo', source: 'two.gpx' }, admin);
  const row = raw.prepare('SELECT gpx_key FROM team_tracks WHERE team_id = ?').get(two.id);
  check('the GPX files teams sent are listed and read for cleaning, a photo is not, and one is saved only as its own team\'s',
    sent.length === 1 && sent[0].key === 'sub/gpxtwo' && sent[0].team_id === two.id && read.ok && read.text === text &&
    photo === 404 && elsewhere === 404 && otherTeam === 400 && r.status === 200 && row.gpx_key === 'sub/gpxtwo',
    JSON.stringify({ sent, photo, elsewhere, otherTeam, status: r.status, row }));

  // cleaned again with nothing sent, the route keeps its file; replaced
  // with an upload, a file of ours goes and the team's own proof stays
  const firstKey = raw.prepare('SELECT gpx_key FROM team_tracks WHERE team_id = ?').get(one.id).gpx_key;
  const again = (await save({ team_id: String(one.id), route }, admin)).status;
  const keptKey = raw.prepare('SELECT gpx_key FROM team_tracks WHERE team_id = ?').get(one.id).gpx_key;
  await save({ team_id: String(one.id), route, gpx }, admin);
  const newKey = raw.prepare('SELECT gpx_key FROM team_tracks WHERE team_id = ?').get(one.id).gpx_key;
  await save({ team_id: String(two.id), route, gpx }, admin);
  check('saved again with no file it keeps the one it had; a new file replaces one of ours and never the team\'s own proof',
    again === 200 && keptKey === firstKey && newKey !== firstKey && !bucket.has(firstKey) && bucket.has(newKey) && bucket.has('sub/gpxtwo'),
    JSON.stringify({ again, firstKey, keptKey, newKey }));
}

// ---------------- who can ----------------
{
  await jpost('/api/console/accounts/save', { create: true, name: 'Mapper', password: 'mapper-pass-1', perms: ['map'], require_2fa: false }, admin);
  await jpost('/api/console/accounts/save', { create: true, name: 'Router', password: 'router-pass-1', perms: ['routes'], require_2fa: false }, admin);
  const mapper = (await (await jpost('/api/console/login', { name: 'Mapper', password: 'mapper-pass-1' })).json()).session;
  const router = (await (await jpost('/api/console/login', { name: 'Router', password: 'router-pass-1' })).json()).session;
  const got = {
    mapperList: (await get('/api/console/tracks', mapper)).status,
    mapperSave: (await save({ team_id: String(three.id), route }, mapper)).status,
    routerList: (await get('/api/console/tracks', router)).status,
    routerSave: (await save({ team_id: String(three.id), route, gpx }, router)).status,
    signedOut: (await get('/api/console/tracks')).status
  };
  check('the routes are the Routes tab\'s: another tab is refused and signed out is 401',
    got.mapperList === 403 && got.mapperSave === 403 && got.routerList === 200 && got.routerSave === 200 && got.signedOut === 401,
    JSON.stringify(got));
}

// ---------------- what the replay reads ----------------
{
  const off = (await get('/api/replay/route?name=' + encodeURIComponent(one.name))).status;
  await jpost('/api/console/flags/set', { name: 'replay', value: true }, admin);
  const replay = await (await get('/api/replay')).json();
  const mine = replay.teams.find(t => t.name === one.name);
  const without = replay.teams.find(t => !raw.prepare('SELECT 1 FROM team_tracks WHERE team_id = (SELECT id FROM teams WHERE name = ?)').get(t.name));
  const r = await get('/api/replay/route?name=' + encodeURIComponent(one.name.toUpperCase()));
  const body = await r.json();
  const nobody = (await get('/api/replay/route?name=' + encodeURIComponent(without.name))).status;
  raw.prepare('UPDATE teams SET hidden = 1 WHERE id = ?').run(three.id);
  const hidden = (await get('/api/replay/route?name=' + encodeURIComponent(three.name))).status;
  raw.prepare('UPDATE teams SET hidden = 0 WHERE id = ?').run(three.id);
  await jpost('/api/console/freeze/close', { closed: true }, admin);
  const closed = (await get('/api/replay/route?name=' + encodeURIComponent(one.name))).status;
  await jpost('/api/console/freeze/close', { closed: false }, admin);
  check('the replay says which teams have a route and serves each by name behind its switch, never a hidden team\'s or on a closed tab',
    off === 404 && mine && mine.route && without.route === '' && r.status === 200 &&
    r.headers.get('access-control-allow-origin') === '*' && body.route.team === one.name && body.route.t.length === route.t.length &&
    nobody === 404 && hidden === 404 && closed === 404,
    JSON.stringify({ off, mine: mine && mine.route, status: r.status, nobody, hidden, closed }));
}

// ---------------- taking a route away ----------------
{
  const gone = (await jpost('/api/console/tracks/delete', { team_id: one.id }, admin)).status;
  const twice = (await jpost('/api/console/tracks/delete', { team_id: one.id }, admin)).status;
  const replay = await (await get('/api/replay')).json();
  const key = raw.prepare('SELECT gpx_key FROM team_tracks WHERE team_id = ?').get(three.id).gpx_key;
  const deleted = (await jpost('/api/console/teams/delete', { id: three.id, confirm: three.name }, admin)).status;
  check('a route can be deleted once, and deleting a team takes its route and its GPX file with it',
    gone === 200 && twice === 404 && replay.teams.find(t => t.name === one.name).route === '' &&
    deleted === 200 && !raw.prepare('SELECT 1 FROM team_tracks WHERE team_id = ?').get(three.id) && !bucket.has(key),
    JSON.stringify({ gone, twice, deleted, key }));
}

console.log(fail ? 'FAILURES: ' + fail : '\nALL CHECKS PASSED');
process.exit(fail ? 1 : 0);
