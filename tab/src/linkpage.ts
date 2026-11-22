// The link page: what go.<domain>/ shows, set on the dashboard's Files
// tab. A title, a line under it, a row of social icons and a list of
// links with headings between them, each link counted as it is opened.
//
// Off (the `link_page` flag unset or 0), the bare domain redirects to the
// site as it always did, so deploying this changes nothing until an
// organiser turns it on. Every link on the page goes through
// `go.<domain>/l/<id>`, which counts the click and redirects; a slug can
// hold no slash, so that path can never be a short link. A view is
// counted when the page is drawn for a person, not for a link preview.
// Counts are numbers per day and nothing else: no address, no referrer,
// no cookie.
//
// **A database that fails does not take the page down.** Every save on
// the dashboard writes the drawn page and each shown link's address to
// Workers KV (`LINK_PAGE_KV`, key `snapshot`), a separate service. An
// ordinary visit reads the database live, in one batch, so an edit shows
// at once; only when that read fails or takes longer than `LIVE_WAIT`
// does the page come from the snapshot, and a click on it redirects from
// the snapshot's list. Nothing is counted while the database is away.
// With the page off the snapshot is deleted, so an outage then sends the
// bare domain to the site as usual. Without the binding there is no
// backup and the page works as before.
import { json, cleanText } from './shared.ts';
import { escapeHtml } from './email.ts';
import { fontFaces } from './sharepage.ts';
import { isLinkPreview } from './shared.ts';
import type { ConsoleSession, Ctx, Env, JsonBody, LogAction } from './types.ts';

export interface LinkPageItemRow {
  id: number;
  kind: string;
  label: string;
  url: string;
  icon: string;
  sort: number;
  hidden: number;
  featured: number;
  clicks: number;
  created_at: string;
  created_by: string;
}

var KINDS = ['link', 'heading', 'social'];
// the icons a social link can carry, in the order the dashboard offers them
export var SOCIAL_ICONS: Record<string, { name: string; svg: string }> = {
  discord: { name: 'Discord', svg: '<path d="M8.5 7.5c-1.3.3-2.5.8-3.5 1.5-1.5 2.6-2 5.2-1.8 7.8 1.3 1 2.7 1.7 4.2 2.1l.9-1.6"/><path d="M15.5 7.5c1.3.3 2.5.8 3.5 1.5 1.5 2.6 2 5.2 1.8 7.8-1.3 1-2.7 1.7-4.2 2.1l-.9-1.6"/><path d="M8 16.5c2.6 1 5.4 1 8 0"/><path d="M8.5 7.5c2.3-.6 4.7-.6 7 0"/><circle cx="9.5" cy="12.5" r="1" fill="currentColor"/><circle cx="14.5" cy="12.5" r="1" fill="currentColor"/>' },
  instagram: { name: 'Instagram', svg: '<rect x="3.5" y="3.5" width="17" height="17" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.2" cy="6.8" r="0.6" fill="currentColor"/>' },
  tiktok: { name: 'TikTok', svg: '<path d="M14 3.5v11.25a3.75 3.75 0 1 1-3.75-3.75"/><path d="M14 3.5c.4 2.6 2.3 4.6 5 5"/>' },
  facebook: { name: 'Facebook', svg: '<path d="M14.5 21v-7.5h2.75l.5-3.25H14.5V8.4c0-.9.4-1.65 1.75-1.65h1.6V3.9a20 20 0 0 0-2.4-.15c-2.6 0-4.2 1.55-4.2 4.35v2.15H8.5v3.25h2.75V21"/>' },
  youtube: { name: 'YouTube', svg: '<rect x="2.5" y="5.5" width="19" height="13" rx="3.5"/><path d="M10 9.25v5.5l4.75-2.75z"/>' },
  x: { name: 'X', svg: '<path d="M4.5 4h4l11 16h-4z"/><path d="M19.5 4l-6.6 7.3"/><path d="M4.5 20l6.6-7.3"/>' },
  linkedin: { name: 'LinkedIn', svg: '<rect x="3.5" y="3.5" width="17" height="17" rx="2"/><path d="M8 10.5v6"/><path d="M8 7.5v.01"/><path d="M12 16.5v-6"/><path d="M12 13.25c0-1.6 1-2.75 2.5-2.75s2 1.1 2 2.6v3.4"/>' },
  email: { name: 'Email', svg: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 6.5 8.5 6.5 8.5-6.5"/>' },
  website: { name: 'Website', svg: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/>' }
};
var MAX_ITEMS = 60;
var MAX_LABEL = 80;
var MAX_URL = 2000;
var MAX_TITLE = 80;
var MAX_BIO = 300;
var DAYS_SHOWN = 30;
var LIVE_WAIT = 3000;   // ms the database gets before the snapshot is used
var SNAPSHOT_KEY = 'snapshot';
// the header picture's shade and blur: what an untouched page gets, and the most each may be
var DIM_DEFAULT = 45;
var DIM_MAX = 90;
var BLUR_MAX = 20;

// An address a link may go to: the web, an email or a phone number. A
// bare email address on an email icon is taken as one.
export function cleanTarget(raw: unknown, icon: string): string {
  var url = String(raw == null ? '' : raw).trim().slice(0, MAX_URL);
  if (icon === 'email' && /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(url)) url = 'mailto:' + url;
  if (/^https?:\/\/[^\s<>"]+$/i.test(url)) return url;
  if (/^mailto:[^\s@<>"]+@[^\s@<>"]+$/i.test(url)) return url;
  if (/^tel:\+?[0-9 ()-]{3,30}$/i.test(url)) return url.replace(/\s+/g, '');
  return '';
}

// the answer, or a refusal once `ms` has passed without one
function within<T>(work: Promise<T>, ms: number): Promise<T> {
  var timer: ReturnType<typeof setTimeout> | undefined;
  var late = new Promise<never>(function (_, no) { timer = setTimeout(function () { no(new Error('slow')); }, ms); });
  return Promise.race([work, late]).finally(function () { if (timer !== undefined) clearTimeout(timer); });
}

// the header picture: a picture in the Files tab's drop, darkened by `dim` percent and blurred by `blur` px
interface PageLook { bg: { key: string; name: string } | null; dim: number; blur: number }
interface PageState extends PageLook { on: boolean; title: string; bio: string; items: LinkPageItemRow[] }

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  var n = Math.round(Number(v));
  return isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

// Everything the page needs in one round trip. Throws when the database
// fails or is slower than `wait`, which is the caller's cue to use the
// snapshot.
async function readPage(db: D1Database, wait?: number): Promise<PageState> {
  var read = db.batch([
    db.prepare("SELECT name, value FROM site_flags WHERE name IN ('link_page', 'link_page_dim', 'link_page_blur')"),
    db.prepare("SELECT name, value FROM site_text WHERE name IN ('link_page_title', 'link_page_bio')"),
    db.prepare('SELECT * FROM link_page_items ORDER BY sort, id'),
    // a picture deleted from the drop leaves no row here, and the board is plain black again
    db.prepare("SELECT d.key, d.name FROM drop_files d WHERE d.key = (SELECT value FROM site_text WHERE name = 'link_page_bg') AND d.type LIKE 'image/%'")
  ]);
  var res = wait ? await within(read, wait) : await read;
  var flags: Record<string, number> = {};
  (res[0].results as { name: string; value: number }[]).forEach(function (r) { flags[r.name] = Number(r.value); });
  var pic = (res[3].results as { key: string; name: string }[])[0];
  var out: PageState = {
    on: !!flags.link_page, title: '', bio: '', items: res[2].results as LinkPageItemRow[],
    bg: pic ? { key: pic.key, name: pic.name } : null,
    dim: clampInt('link_page_dim' in flags ? flags.link_page_dim : DIM_DEFAULT, 0, DIM_MAX, DIM_DEFAULT),
    blur: clampInt(flags.link_page_blur || 0, 0, BLUR_MAX, 0)
  };
  (res[1].results as { name: string; value: string }[]).forEach(function (r) {
    if (r.name === 'link_page_title') out.title = r.value;
    else out.bio = r.value;
  });
  return out;
}

interface Snapshot { html: string; links: Record<string, string> }

async function readSnapshot(env: Env): Promise<Snapshot | null> {
  if (!env.LINK_PAGE_KV) return null;
  try { return await env.LINK_PAGE_KV.get<Snapshot>(SNAPSHOT_KEY, 'json'); } catch (err) { return null; }
}

// Written after every save: the page as drawn now and each shown link's
// address, or nothing while the page is off. A failure here never fails
// the save; the next save writes it again.
export async function writeSnapshot(env: Env): Promise<void> {
  if (!env.LINK_PAGE_KV) return;
  try {
    var state = await readPage(env.DB);
    if (!state.on) { await env.LINK_PAGE_KV.delete(SNAPSHOT_KEY); return; }
    var shown = state.items.filter(function (i) { return !i.hidden; });
    var links: Record<string, string> = {};
    shown.forEach(function (i) { if (i.kind !== 'heading' && i.url) links[String(i.id)] = i.url; });
    var snap: Snapshot = { html: pageHtml(env, state, shown), links: links };
    await env.LINK_PAGE_KV.put(SNAPSHOT_KEY, JSON.stringify(snap));
  } catch (err) {
    console.error('link page snapshot not written', err);
  }
}

function today(): string { return new Date().toISOString().slice(0, 10); }

// one day's count for a link, or for the page itself (item 0)
function countDay(db: D1Database, itemId: number): D1PreparedStatement {
  return db.prepare(
    'INSERT INTO link_page_days (day, item_id, n) VALUES (?1, ?2, 1) ' +
    'ON CONFLICT(day, item_id) DO UPDATE SET n = n + 1'
  ).bind(today(), itemId);
}

// ---------- the public side, on the short-link host ----------

// `/` and `/l/<id>` on the short host, or null for every other path
// (a short link) and for `/` while the page is off.
export async function linkPageRoute(request: Request, env: Env, ctx: Ctx, path: string): Promise<Response | null> {
  var click = /^l\/(\d+)$/.exec(path);
  if (click) return linkClick(request, env, ctx, Number(click[1]));
  if (path) return null;
  var body: string;
  var state: PageState | null = null;
  try { state = await readPage(env.DB, LIVE_WAIT); } catch (err) { state = null; }
  if (state) {
    if (!state.on) return null;
    body = pageHtml(env, state, state.items.filter(function (i) { return !i.hidden; }));
    if (!isLinkPreview(request) && request.method === 'GET') {
      var view = countDay(env.DB, 0).run().catch(function () {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(view);
      else await view;
    }
  } else {
    var snap = await readSnapshot(env);
    if (!snap) return null;
    body = snap.html;
  }
  return new Response(request.method === 'HEAD' ? null : body, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }
  });
}

async function linkClick(request: Request, env: Env, ctx: Ctx, id: number): Promise<Response> {
  var url = '';
  try {
    var read = env.DB.prepare('SELECT id, url, hidden, kind FROM link_page_items WHERE id = ?1')
      .bind(id).first<Pick<LinkPageItemRow, 'id' | 'url' | 'hidden' | 'kind'>>();
    var row = await within(read, LIVE_WAIT);
    if (row && !row.hidden && row.kind !== 'heading') url = row.url;
    if (url && !isLinkPreview(request) && request.method === 'GET') {
      // a count that fails is not worth failing the link over
      var count = env.DB.batch([
        env.DB.prepare('UPDATE link_page_items SET clicks = clicks + 1 WHERE id = ?1').bind(id),
        countDay(env.DB, id)
      ]).catch(function () {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(count);
      else await count;
    }
  } catch (err) {
    var snap = await readSnapshot(env);
    url = (snap && snap.links[String(id)]) || '';
  }
  if (!url) {
    return new Response('No link here.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
  }
  return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'no-store' } });
}

// The black board, or the picture under a shade: the picture's layer is
// pulled out past the board's edges so a blur does not show a pale rim.
function boardOpen(env: Env, look: Partial<PageLook>): string {
  var url = look.bg ? pictureUrl(env, look.bg) : '';
  if (!url) return '<header class="lp-board">';
  var dim = clampInt(look.dim, 0, DIM_MAX, DIM_DEFAULT);
  var blur = clampInt(look.blur, 0, BLUR_MAX, 0);
  return '<header class="lp-board has-picture">' +
    '<div class="lp-picture" aria-hidden="true" style="background-image:url(\'' + escapeHtml(url).replace(/'/g, '%27') + '\')' +
    (blur ? ';filter:blur(' + blur + 'px)' : '') + '"></div>' +
    '<div class="lp-shade" aria-hidden="true" style="opacity:' + (dim / 100) + '"></div>';
}

function icon(svg: string): string {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + svg + '</svg>';
}

// where the header picture is served from: the public file route, since
// the short-link host answers nothing but short links and this page
export function pictureUrl(env: Env, bg: { key: string; name: string }): string {
  var api = String(env.PUBLIC_API || '').replace(/\/+$/, '');
  return api ? api + '/api/drop/' + bg.key.split('/').map(encodeURIComponent).join('/') + '/' + encodeURIComponent(bg.name) : '';
}

export function pageHtml(env: Env, text: { title: string; bio: string } & Partial<PageLook>, items: LinkPageItemRow[]): string {
  var site = String(env.SITE_URL || 'https://scs.andyrew.space').replace(/\/+$/, '');
  var api = String(env.PUBLIC_API || '').replace(/\/+$/, '');
  var title = text.title || 'SCS.2 Legends of the City';
  var socials = items.filter(function (i) { return i.kind === 'social' && i.url; });
  var rest = items.filter(function (i) { return i.kind !== 'social'; });
  var head = '<title>' + escapeHtml(title) + '</title>' +
    (text.bio ? '<meta name="description" content="' + escapeHtml(text.bio) + '">' : '') +
    '<meta property="og:type" content="website"><meta property="og:title" content="' + escapeHtml(title) + '">' +
    (text.bio ? '<meta property="og:description" content="' + escapeHtml(text.bio) + '">' : '') +
    (api ? '<meta property="og:image" content="' + escapeHtml(api) + '/api/slides/cover"><meta name="twitter:card" content="summary_large_image">' : '') +
    '<link rel="icon" href="' + escapeHtml(site) + '/assets/icons/favicon-32.png" type="image/png">';
  var social = socials.length
    ? '<nav class="lp-social" aria-label="Elsewhere">' + socials.map(function (s) {
      var known = SOCIAL_ICONS[s.icon] || SOCIAL_ICONS.website;
      var name = s.label || known.name;
      return '<a href="l/' + s.id + '" aria-label="' + escapeHtml(name) + '" title="' + escapeHtml(name) + '">' + icon(known.svg) + '</a>';
    }).join('') + '</nav>'
    : '';
  var list = rest.map(function (i) {
    if (i.kind === 'heading') return '<li class="lp-head"><h2>' + escapeHtml(i.label) + '</h2></li>';
    if (!i.url) return '';
    return '<li><a class="lp-btn' + (i.featured ? ' is-featured' : '') + '" href="l/' + i.id + '">' + escapeHtml(i.label || i.url) + '</a></li>';
  }).join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta name="theme-color" content="#131313">' + head +
    '<style>' + fontFaces(site) + LINK_PAGE_CSS + '</style></head><body>' +
    '<main class="lp">' +
    boardOpen(env, text) + '<a class="lp-mark" href="' + escapeHtml(site) + '/"><img src="' + escapeHtml(site) +
    '/assets/icons/logo-128.png" width="78" height="64" alt="SCS"></a>' +
    '<h1>' + escapeHtml(title) + '</h1>' + (text.bio ? '<p>' + escapeHtml(text.bio) + '</p>' : '') + social + '</header>' +
    (list ? '<ul class="lp-links">' + list + '</ul>' : '') +
    '</main></body></html>';
}

// The site's own tokens, written out: this page loads nothing from the
// site but its fonts and its logo.
var LINK_PAGE_CSS =
  ':root{--page-bg:#f2f3f5;--surface:#ffffff;--text:#111111;--muted:#616161;--rule:#111111;' +
  '--accent:#00933c;--accent-dark:#00752f;--shadow-hover:3px 3px 0 rgba(17,17,17,0.28);--sign-bg:#131313;color-scheme:light}' +
  '@media (prefers-color-scheme:dark){:root{--page-bg:#121212;--surface:#1b1b1b;--text:#eeeeee;--muted:#a3a3a3;' +
  '--rule:#6d6d6d;--accent-dark:#55c581;--shadow-hover:3px 3px 0 rgba(47,176,99,0.3);--sign-bg:#0c0c0c;color-scheme:dark}' +
  // on the dark page the black board is a few steps from the ground, so an edge says where it ends
  '.lp-board{border-bottom:1px solid #2a2a2a}}' +
  'html{-webkit-text-size-adjust:100%}' +
  'body{margin:0;background:var(--page-bg);color:var(--text);' +
  'font-family:"Helvetica Neue","SCS Heros",Helvetica,Arial,sans-serif;font-size:1rem;line-height:1.5}' +
  '.lp{min-height:100vh;display:flex;flex-direction:column}' +
  '.lp-board{background:var(--sign-bg);color:#ffffff;text-align:center;' +
  'padding:calc(40px + env(safe-area-inset-top,0px)) 16px 36px}' +
  '.lp-board.has-picture{position:relative;overflow:hidden;isolation:isolate}' +
  '.lp-picture{position:absolute;inset:-40px;z-index:-2;background-size:cover;background-position:center}' +
  '.lp-shade{position:absolute;inset:0;z-index:-1;background:#000000}' +
  '.lp-mark{display:inline-block}' +
  // the mark on a white square, as the site draws it on black: its black edge is lost otherwise
  '.lp-mark img{display:block;height:56px;width:auto;box-sizing:border-box;padding:5px;border-radius:2px;background:#ffffff}' +
  '.lp-board h1{margin:20px auto 0;max-width:24ch;font-size:clamp(2rem,8vw,2.75rem);font-weight:850;letter-spacing:-0.03em;line-height:1.05;text-wrap:balance}' +
  '.lp-board p{margin:12px auto 0;max-width:32em;color:rgba(255,255,255,0.72);text-wrap:balance}' +
  '.lp-social{display:flex;justify-content:center;flex-wrap:wrap;gap:8px;margin-top:22px}' +
  '.lp-social a{display:inline-grid;place-items:center;width:44px;height:44px;color:#ffffff;border-radius:2px}' +
  '.lp-social a:hover{background:rgba(255,255,255,0.12)}' +
  '.lp-social a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
  '.lp-social svg{width:26px;height:26px}' +
  '.lp-links{list-style:none;margin:0 auto;padding:32px 16px calc(48px + env(safe-area-inset-bottom,0px));width:100%;max-width:36rem;box-sizing:border-box;display:grid;gap:12px}' +
  '.lp-head h2{margin:20px 0 0;padding-top:12px;border-top:2px solid var(--rule);font-size:1.375rem;font-weight:800;letter-spacing:-0.01em;line-height:1.25}' +
  '.lp-links li:first-child.lp-head h2{margin-top:0}' +
  '.lp-btn{display:flex;align-items:center;justify-content:center;min-height:48px;box-sizing:border-box;padding:10px 20px;' +
  'border:2px solid var(--text);border-radius:2px;background:var(--surface);color:var(--text);text-align:center;' +
  'text-decoration:none;font-weight:800;line-height:1.25;transition:transform 150ms cubic-bezier(0.22,1,0.36,1),box-shadow 150ms cubic-bezier(0.22,1,0.36,1)}' +
  '.lp-btn.is-featured{background:var(--accent);border-color:var(--accent);color:#ffffff}' +
  '@media (hover:hover){.lp-btn:hover{transform:translateY(-1px);box-shadow:var(--shadow-hover)}}' +
  '.lp-btn:active{transform:translate(1px,1px);box-shadow:none}' +
  '.lp-btn:focus-visible{outline:2px solid var(--accent);outline-offset:2px}' +
  '@media (prefers-reduced-motion:reduce){.lp-btn{transition:none}}';

// ---------- the dashboard's side (Files tab) ----------

export async function linkPageRead(env: Env): Promise<Response> {
  var state = await readPage(env.DB);
  var items = state.items;
  // the first look after the backup is set up writes it, rather than waiting for a save
  if (state.on && env.LINK_PAGE_KV && !(await readSnapshot(env))) await writeSnapshot(env);
  var since = new Date(Date.now() - (DAYS_SHOWN - 1) * 86400000).toISOString().slice(0, 10);
  var days = (await env.DB.prepare('SELECT day, item_id, n FROM link_page_days WHERE day >= ?1 ORDER BY day')
    .bind(since).all<{ day: string; item_id: number; n: number }>()).results;
  var views = (await env.DB.prepare('SELECT COALESCE(SUM(n), 0) AS n FROM link_page_days WHERE item_id = 0')
    .first<{ n: number }>()) || { n: 0 };
  var recent: Record<number, number> = {};
  var byDay: Record<string, { views: number; clicks: number }> = {};
  days.forEach(function (d) {
    var day = byDay[d.day] || (byDay[d.day] = { views: 0, clicks: 0 });
    if (d.item_id === 0) day.views += d.n;
    else { day.clicks += d.n; recent[d.item_id] = (recent[d.item_id] || 0) + d.n; }
  });
  var host = String(env.SHORT_HOST || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
  return json({
    ok: true,
    on: state.on,
    url: host ? 'https://' + host + '/' : '',
    text: { title: state.title, bio: state.bio },
    api: String(env.PUBLIC_API || '').replace(/\/+$/, ''),
    look: { bg: state.bg ? state.bg.key : '', url: state.bg ? pictureUrl(env, state.bg) : '', dim: state.dim, blur: state.blur },
    pictures: (await env.DB.prepare("SELECT key, name FROM drop_files WHERE type LIKE 'image/%' ORDER BY id DESC LIMIT 100")
      .all<{ key: string; name: string }>()).results.map(function (p) { return { key: p.key, name: p.name, url: pictureUrl(env, p) }; }),
    backup: !!env.LINK_PAGE_KV,
    icons: Object.keys(SOCIAL_ICONS).map(function (k) { return { key: k, name: SOCIAL_ICONS[k].name }; }),
    items: items.map(function (i) { return Object.assign({}, i, { recent: recent[i.id] || 0 }); }),
    views: views.n,
    days: Object.keys(byDay).sort().map(function (d) { return { day: d, views: byDay[d].views, clicks: byDay[d].clicks }; }),
    days_shown: DAYS_SHOWN
  });
}

export async function linkPageSettings(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var writes: D1PreparedStatement[] = [];
  if ('on' in body) {
    writes.push(env.DB.prepare(
      "INSERT INTO site_flags (name, value) VALUES ('link_page', ?1) ON CONFLICT(name) DO UPDATE SET value = ?1"
    ).bind(body.on ? 1 : 0));
  }
  var fields: [string, string, number][] = [['title', 'link_page_title', MAX_TITLE], ['bio', 'link_page_bio', MAX_BIO]];
  fields.forEach(function (f) {
    if (!(f[0] in body)) return;
    var value = cleanText(body[f[0]], f[2]);
    writes.push(value
      ? env.DB.prepare('INSERT INTO site_text (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = ?2').bind(f[1], value)
      : env.DB.prepare('DELETE FROM site_text WHERE name = ?1').bind(f[1]));
  });
  if ('bg' in body) {
    var bg = String(body.bg || '');
    if (bg) {
      var pic = await env.DB.prepare("SELECT key FROM drop_files WHERE key = ?1 AND type LIKE 'image/%'").bind(bg).first<{ key: string }>();
      if (!pic) return json({ error: 'That picture is not in Files.' }, 404);
      writes.push(env.DB.prepare("INSERT INTO site_text (name, value) VALUES ('link_page_bg', ?1) ON CONFLICT(name) DO UPDATE SET value = ?1").bind(bg));
    } else {
      writes.push(env.DB.prepare("DELETE FROM site_text WHERE name = 'link_page_bg'"));
    }
  }
  var numbers: [string, string, number, number][] = [['dim', 'link_page_dim', DIM_MAX, DIM_DEFAULT], ['blur', 'link_page_blur', BLUR_MAX, 0]];
  numbers.forEach(function (f) {
    if (!(f[0] in body)) return;
    writes.push(env.DB.prepare('INSERT INTO site_flags (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = ?2')
      .bind(f[1], clampInt(body[f[0]], 0, f[2], f[3])));
  });
  if (writes.length) await env.DB.batch(writes);
  await logAction(env.DB, session.name, 'link-page-settings', '', 'on' in body ? (body.on ? 'on' : 'off') : '', 0, 0, 0);
  await writeSnapshot(env);
  return linkPageRead(env);
}

export async function linkPageSave(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var id = Number(body.id) || 0;
  var kind = KINDS.indexOf(String(body.kind)) !== -1 ? String(body.kind) : 'link';
  var label = cleanText(body.label, MAX_LABEL);
  var iconKey = kind === 'social' ? (SOCIAL_ICONS[String(body.icon)] ? String(body.icon) : 'website') : '';
  var url = '';
  if (kind !== 'heading') {
    url = cleanTarget(body.url, iconKey);
    if (!url) return json({ error: 'The address has to start with https://, mailto: or tel:' }, 400);
  }
  if (kind === 'heading' && !label) return json({ error: 'A heading needs its words.' }, 400);
  if (kind === 'link' && !label) return json({ error: 'A link needs a label.' }, 400);
  var hidden = body.hidden ? 1 : 0;
  var featured = kind === 'link' && body.featured ? 1 : 0;
  if (id) {
    var res = await env.DB.prepare(
      'UPDATE link_page_items SET kind = ?2, label = ?3, url = ?4, icon = ?5, hidden = ?6, featured = ?7 WHERE id = ?1'
    ).bind(id, kind, label, url, iconKey, hidden, featured).run();
    if (!(res.meta && res.meta.changes)) return json({ error: 'no such link' }, 404);
  } else {
    var count = await env.DB.prepare('SELECT COUNT(*) AS n FROM link_page_items').first<{ n: number }>();
    if (count && count.n >= MAX_ITEMS) return json({ error: 'The page holds ' + MAX_ITEMS + ' rows at most.' }, 400);
    await env.DB.prepare(
      'INSERT INTO link_page_items (kind, label, url, icon, hidden, featured, sort, created_by) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, (SELECT COALESCE(MAX(sort), 0) + 1 FROM link_page_items), ?7)'
    ).bind(kind, label, url, iconKey, hidden, featured, session.name).run();
  }
  await logAction(env.DB, session.name, id ? 'link-page-edit' : 'link-page-add', '', label || iconKey, 0, 0, 0);
  await writeSnapshot(env);
  return linkPageRead(env);
}

export async function linkPageDelete(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var id = Number(body.id) || 0;
  var row = await env.DB.prepare('SELECT label, icon FROM link_page_items WHERE id = ?1').bind(id).first<{ label: string; icon: string }>();
  if (!row) return json({ error: 'no such link' }, 404);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM link_page_items WHERE id = ?1').bind(id),
    env.DB.prepare('DELETE FROM link_page_days WHERE item_id = ?1').bind(id)
  ]);
  await logAction(env.DB, session.name, 'link-page-delete', '', row.label || row.icon, 0, 0, 0);
  await writeSnapshot(env);
  return linkPageRead(env);
}

export async function linkPageOrder(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(function (n) { return n > 0; }) : [];
  if (!ids.length) return json({ error: 'nothing to order' }, 400);
  await env.DB.batch(ids.map(function (id, i) {
    return env.DB.prepare('UPDATE link_page_items SET sort = ?2 WHERE id = ?1').bind(id, i + 1);
  }));
  await logAction(env.DB, session.name, 'link-page-order', '', '', 0, 0, 0);
  await writeSnapshot(env);
  return linkPageRead(env);
}
