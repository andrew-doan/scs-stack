// The pages a file is shown on, on the worker's own address: a near-black
// page with the event's mark at the top, the file as large as fits, its
// credit, Download and Share, and Details where an album showing details
// holds it. A photo opens on the whole screen to zoom (the site's
// photo-view.js). /photo/ (albums.ts) and /view/ draw it
// for a photo or video from an album or the gallery, and every public
// file address draws it for a person who opens that address in a
// browser (wantsPage): a photo, a PDF drawn page by page with the
// site's copy of PDF.js, a video, or any other file as a card to
// download. Everything else that asks those addresses — a picture or a
// player on a page, a script, a download, a chat app working out a
// preview — gets the file itself, so a link pasted into Discord still
// embeds as the picture.

import { animatedType, fileNameFor, isLinkPreview } from './shared.ts';
import { escapeHtml } from './email.ts';
import { publicQuest } from './quests.ts';
import { nameDeleted } from './deleted.ts';
import type { AlbumPhotoRow, AlbumRow, Env, PublicCode, PublicGroup, SubmissionFileRow, SubmissionRenditionRow, SubmissionRow, TeamRow } from './types.ts';

// A file a page is drawn for. From an album or the gallery: where it came
// from, who sent it (a team or a person), the quest, its size in pixels
// and how many times it has been replaced. Opened at its own address:
// `base`, the path it is named under, with its name and bytes.
export interface MediaItem {
  key: string;
  type: string | null;
  from?: string;
  who?: string;
  by?: string;
  quest?: string | null;
  w?: number;
  h?: number;
  ver?: number;
  base?: string;
  name?: string;
  bytes?: number | null;
}

// A photo or video an album showing details holds (detailsHolder).
export interface HeldDetails {
  key: string;
  type: string;
  name: string;
  bytes: number;
  w: number;
  h: number;
  taken: string;
  at: string;
  who: string;
  quest: string;
}

// One quest as the public list shows it, with the code asked for and its
// region's line colour (publicQuest).
export type PublicQuest = PublicGroup & { code: PublicCode; colour: string };

// A submission's files that the site shows, as SQL over submission_files
// f: photos and videos. A GPX track or a PDF is the organisers' alone.
export var SHOWN = "(f.content_type LIKE 'image/%' OR f.content_type LIKE 'video/%')";

function isVideoType(type: unknown): boolean { return /^video\/[\w.+-]+$/.test(String(type || '').toLowerCase().split(';')[0].trim()); }
function isPdf(type: unknown): boolean { return String(type || '').toLowerCase().split(';')[0].trim() === 'application/pdf'; }
export function isMedia(type: unknown): boolean { return /^(image|video)\//i.test(String(type || '')); }
// the same address with raw=1, which is never a page
function rawOf(address: string): string { return address + (address.indexOf('?') === -1 ? '?raw=1' : '&raw=1'); }

// What a file response says it varies by: the same address answers a
// page or the file depending on what is asking (wantsPage), and a
// browser that kept one must not hand it out for the other.
export var VARY: Record<string, string> = { vary: 'Sec-Fetch-Dest' };

// Whether a request for a file is a person opening its address in a
// browser, who is answered with the file's page rather than its bytes:
// a navigation, which a browser marks Sec-Fetch-Dest: document (or,
// where it sends none, by asking for HTML). A link preview, a picture
// or a player on a page, PDF.js reading the file, a download, a range
// and raw=1 all get the file.
//
// `file` says what is being asked for: `named` when the address ends in
// the file's name, the form handed out to people (Copy link, Share, a
// Discord post), and `media` for a photo or a video. A photo or a video
// is a page only at its named address. The ?key= addresses are the ones
// the site's own viewers show, and a browser saving a picture it has on
// screen ("Save image as", "Download image") asks for it again the way
// it opens a page — so those were saved as the page's HTML.
export function wantsPage(request: Request, url: URL, file: { named?: boolean; media?: boolean } | null | undefined): boolean {
  if (request.method !== 'GET') return false;
  if (url.searchParams.has('raw') || url.searchParams.has('download')) return false;
  if (file && file.media && !file.named) return false;
  if (request.headers.get('range') || isLinkPreview(request)) return false;
  var dest = request.headers.get('sec-fetch-dest');
  if (dest) return dest === 'document';
  return /text\/html/i.test(request.headers.get('accept') || '');
}

// The heights the encoder made of each of these files, smallest first.
export async function heightsFor(db: D1Database, keys: string[]): Promise<Record<string, number[]>> {
  var out: Record<string, number[]> = {};
  if (!keys.length) return out;
  (await db.prepare(
    'SELECT file_key, height FROM submission_renditions WHERE file_key IN (SELECT value FROM json_each(?1)) ORDER BY height'
  ).bind(JSON.stringify(keys)).all<Pick<SubmissionRenditionRow, 'file_key' | 'height'>>()).results.forEach(function (r) {
    (out[r.file_key] = out[r.file_key] || []).push(r.height);
  });
  return out;
}

// The file behind a /view/ link: any proof or album file, opened by its
// key as the file routes are, once it has all arrived and, for a video,
// once the encoder has finished with it.
// How many times an album upload has been replaced in place.
export async function photoVersion(db: D1Database, key: string): Promise<number> {
  var row = await db.prepare('SELECT version FROM album_photos WHERE r2_key = ?1').bind(key).first<Pick<AlbumPhotoRow, 'version'>>();
  return (row && row.version) || 0;
}

export async function viewedFile(db: D1Database, key: string): Promise<MediaItem | null> {
  if (key.indexOf('alb/') === 0) {
    var r = await db.prepare(
      'SELECT p.content_type, p.width, p.height, p.status, p.encode_state, p.added_by, p.version, t.name AS team ' +
      'FROM album_photos p LEFT JOIN teams t ON t.id = p.team_id WHERE p.r2_key = ?1'
    ).bind(key).first<Pick<AlbumPhotoRow, 'content_type' | 'width' | 'height' | 'status' | 'encode_state' | 'added_by' | 'version'> & { team: string | null }>();
    if (!r || r.status === 'uploading' || (isVideoType(r.content_type) && r.encode_state !== 'done')) return null;
    return { key: key, type: r.content_type, from: 'album', who: r.team || r.added_by || '', by: r.team ? 'team' : 'person', w: r.width, h: r.height,
      ver: r.version || 0 };
  }
  var f = await db.prepare(
    'SELECT f.content_type, f.status, f.encode_state, s.quest_code, t.name AS team ' +
    'FROM submission_files f JOIN submissions s ON s.id = f.submission_id JOIN teams t ON t.id = s.team_id WHERE f.r2_key = ?1 AND ' + SHOWN
  ).bind(key).first<Pick<SubmissionFileRow, 'content_type' | 'status' | 'encode_state'> & Pick<SubmissionRow, 'quest_code'> & { team: string }>();
  if (!f || f.status === 'uploading' || (isVideoType(f.content_type) && f.encode_state !== 'done')) return null;
  var item = { key: key, type: f.content_type, from: 'proof', who: f.team, quest: f.quest_code, w: 0, h: 0 };
  // a deleted quest's file reads as the quest it came from
  await nameDeleted(db, [item], 'quest', 'files', function (it) { return it.key; });
  return item;
}

// Whether a gallery submission (s) is from a team picked for the album
// whose id is `album` (SQL).
export function teamPicked(album: string): string {
  return 'EXISTS (SELECT 1 FROM album_teams m WHERE m.album_id = ' + album + ' AND m.team_id = s.team_id)';
}
// Whether album a shows a gallery submission (s): the whole gallery, or
// the submission's team picked for it.
export function showsGallery(): string {
  return '(a.gallery = 1 OR ' + teamPicked('a.id') + ')';
}

// The photo or video behind a key while an album showing details shows
// it: an upload in such an album, or a gallery file in one (the whole
// gallery or its team picked) and not taken out of it, with the album
// not hidden and a hidden team's only where the album shows them. Null
// otherwise. The albums' routes ask it for the original and the details,
// and the file's page for whether to offer the details.
export async function detailsHolder(db: D1Database, key: string): Promise<HeldDetails | null> {
  if (key.indexOf('alb/') === 0) {
    var r = await db.prepare(
      'SELECT a.*, p.r2_key, p.content_type, p.name AS file_name, p.bytes, p.width, p.height, p.status AS file_status, ' +
      'p.added_at, p.added_by, p.taken_at, t.name AS team, COALESCE(t.hidden, 0) AS team_hidden ' +
      'FROM album_photos p JOIN albums a ON a.id = p.album_id LEFT JOIN teams t ON t.id = p.team_id WHERE p.r2_key = ?1'
    ).bind(key).first<AlbumRow & Pick<AlbumPhotoRow, 'r2_key' | 'content_type' | 'bytes' | 'width' | 'height' | 'added_at' | 'added_by' | 'taken_at'> &
      { file_name: string; file_status: string; team: TeamRow['name'] | null; team_hidden: number }>();
    if (!r || !r.details || r.hidden || (r.team_hidden && !r.show_hidden) || r.file_status === 'uploading') return null;
    return { key: key, type: r.content_type, name: r.file_name, bytes: r.bytes, w: r.width, h: r.height,
      taken: r.taken_at || '', at: r.added_at, who: r.team || r.added_by || '', quest: '' };
  }
  if (key.indexOf('sub/') !== 0) return null;
  var g = await db.prepare(
    'SELECT f.*, s.submitted_at, s.quest_code, t.name AS team ' +
    'FROM submission_files f JOIN submissions s ON s.id = f.submission_id JOIN teams t ON t.id = s.team_id ' +
    "WHERE f.r2_key = ?1 AND s.gallery = 1 AND s.status = 'accepted' AND f.status != 'uploading' AND " + SHOWN + ' ' +
    'AND EXISTS (SELECT 1 FROM albums a WHERE ' + showsGallery() + ' AND a.hidden = 0 AND a.details = 1 AND (t.hidden = 0 OR a.show_hidden = 1) ' +
    'AND NOT EXISTS (SELECT 1 FROM album_skips k WHERE k.album_id = a.id AND k.r2_key = f.r2_key))'
  ).bind(key).first<SubmissionFileRow & Pick<SubmissionRow, 'submitted_at' | 'quest_code'> & { team: string }>();
  if (!g) return null;
  await nameDeleted(db, [g], 'quest_code', 'files', function (it) { return it.r2_key; });
  return { key: key, type: g.content_type, name: g.name || '', bytes: g.bytes, w: 0, h: 0,
    taken: g.taken_at || '', at: g.submitted_at, who: g.team, quest: g.quest_code };
}

// The page is the photo viewer's: a near-black ground, the picture as
// large as fits, and under it the credit and the controls, drawn as the
// viewer's 40px sign-black squares. The figure takes the picture's own
// shape (--ar, written by the page once the file says what it is), so
// the caption sits under the picture at its width rather than at the
// foot of the screen.
// The site's stand-in for Helvetica (website/assets/fonts/, SCS Heros),
// loaded from the site, which sends those files with an open CORS
// header. It comes before Helvetica because Windows answers Helvetica
// with Arial and Android with Roboto; the Latin Extended files are only
// fetched for a page that shows one of those letters, and the overrides
// are Helvetica Neue's own ascent, descent and line gap.
var FONT_FACES = [['regular', 400, 'normal'], ['italic', 400, 'italic'], ['bold', 700, 'normal'], ['bolditalic', 700, 'italic']];
var FONT_RANGES: Record<string, string> = {
  ext: 'U+0100-02AF,U+0304,U+0308,U+0329,U+1E00-1EFF,U+20A0-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,' +
    'U+2000-206F,U+20AC,U+2122,U+2190-2193,U+2212,U+2215,U+FEFF,U+FFFD'
};
export function fontFaces(site: string): string {
  // a configured address, but it lands in a stylesheet, where nothing is escaped
  var base = String(site || '').replace(/["'\\<>\s]/g, '');
  var out = '';
  ['ext', 'latin'].forEach(function (cut) {
    FONT_FACES.forEach(function (f) {
      out += '@font-face{font-family:"SCS Heros";src:url("' + base + '/assets/fonts/heros-' + f[0] + '-' + cut +
        '.woff2") format("woff2");font-weight:' + f[1] + ';font-style:' + f[2] + ';font-display:swap;' +
        'ascent-override:95.2%;descent-override:21.3%;line-gap-override:2.8%;unicode-range:' +
        FONT_RANGES[cut] + '}';
    });
  });
  return out;
}

function sharePageHtml(head: string, body: string, site: string, cls?: string): string {
  return '<!doctype html><html lang="en"' + (cls ? ' class="' + cls + '"' : '') + '><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">' +
    '<meta name="robots" content="noindex">' + head +
    '<style>' + fontFaces(site) +
    'html{color-scheme:dark}' +
    'html,body{margin:0;height:100%;background:#111111;color:#ffffff;' +
    'font-family:"Helvetica Neue","SCS Heros",Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}' +
    'body{display:grid;grid-template-rows:auto minmax(0,1fr)}' +
    '.ph-top{padding:calc(12px + env(safe-area-inset-top,0px)) 16px 4px}' +
    '.ph-home{display:inline-flex;align-items:center;gap:10px;color:#ffffff;text-decoration:none;font-size:0.95rem;font-weight:800}' +
    // the mark sits on a white square of its own, as the site's bar
    // draws it in the dark theme: its black edge is lost on black
    '.ph-home img{display:block;height:32px;width:auto;box-sizing:border-box;padding:3px;border-radius:2px;background:#ffffff}' +
    '.ph-home span{font-weight:400}' +
    '.ph-home b{font-weight:800}' +
    '.ph{display:grid;grid-template-columns:minmax(0,1fr);place-items:center;min-height:0;overflow:auto;container-type:size;' +
    'padding:12px 16px calc(20px + env(safe-area-inset-bottom,0px))}' +
    // never narrower than the row of buttons under it: a tall video's width
    // comes from the height and can be less, and the row then widened the
    // contents out of the box on the right while the box stayed centred
    '.ph-fig{margin:0;display:grid;gap:14px;min-width:min-content;' +
    'width:min(100%,1280px,calc((100vh - 200px) * var(--ar,1.7778)));' +
    'width:min(100%,1280px,calc((100cqh - 110px) * var(--ar,1.7778)))}' +
    '.ph-fig img,.ph-fig video{display:block;width:100%;height:auto;aspect-ratio:var(--ar,auto);border-radius:2px;background:#000000}' +
    '#ph-i{cursor:zoom-in}' +
    '#ph-i:focus-visible{outline:2px solid #ffffff;outline-offset:2px}' +
    // the whole picture on its way: the site's loading bar along the top,
    // over the full-screen view and the sheets
    '.ph-load{position:fixed;left:0;right:0;top:env(safe-area-inset-top,0px);height:4px;z-index:25;' +
    'background:rgba(255,255,255,0.16);opacity:0;pointer-events:none;transition:opacity 150ms cubic-bezier(0.22,1,0.36,1)}' +
    '.ph-load span{display:block;height:100%;width:0;background:#2fb063}' +
    '.ph-load.is-going{opacity:1}' +
    '.ph-load.is-going span{transition:width 300ms linear}' +
    '@media (prefers-reduced-motion:reduce){.ph-load.is-going span{transition:none}}' +
    '.ph-cap{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 16px}' +
    '.ph-who{display:flex;align-items:center;gap:10px;min-width:0;font-size:1rem;font-weight:700;line-height:1.3}' +
    '.ph-code{flex:none;padding:5px 7px;border:1px solid #484848;border-radius:2px;background:#0c0c0c;' +
    'font-family:"Roboto Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:0.8rem;font-weight:700;line-height:1}' +
    '.ph-acts{display:flex;flex-wrap:wrap;align-items:center;gap:8px}' +
    '.ph-size-slot:empty{display:none}' +
    '.ph-size,.ph-save{box-sizing:border-box;height:40px;padding:0 12px;border:1px solid #484848;border-radius:2px;' +
    'background:#0c0c0c;color:#ffffff;font:inherit;font-size:0.85rem;font-weight:700;cursor:pointer}' +
    '.ph-size{max-width:150px;font-variant-numeric:tabular-nums}' +
    '.ph-save{display:inline-flex;align-items:center;gap:8px;text-decoration:none}' +
    '.ph-save svg{display:block}' +
    // a video's row also holds its size menu: on a phone, Download is a
    // square like the buttons beside it, its name kept for a screen reader
    '@media (max-width:420px){.ph-save.is-tight{width:40px;padding:0;justify-content:center}' +
    '.ph-save.is-tight span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}}' +
    '.ph-size:hover,.ph-save:hover{border-color:#ffffff}' +
    '.ph-size:focus-visible,.ph-save:focus-visible,.ph-home:focus-visible{outline:2px solid #ffffff;outline-offset:2px}' +
    '.ph-icon{box-sizing:border-box;width:40px;height:40px;padding:0;display:grid;place-items:center;border:1px solid #484848;' +
    'border-radius:2px;background:#0c0c0c;color:#ffffff;cursor:pointer}' +
    '.ph-icon svg{display:block}' +
    '.ph-icon:hover{border-color:#ffffff}' +
    '.ph-icon:focus-visible{outline:2px solid #ffffff;outline-offset:2px}' +
    // the quest, as the quest list's sheet draws it, in the dark theme:
    // up from the foot of the screen, the region's line along its top, a
    // black head; on a phone a grab bar and no cross, with a mouse a cross
    '.qs-overlay{position:fixed;inset:0;z-index:20;display:flex;align-items:flex-end;justify-content:center;' +
    'background:rgba(0,0,0,0.6);transition:background-color 250ms ease}' +
    '.qs-overlay[hidden]{display:none}' +
    'body.qs-open .ph,body.qs-open .ph-view{overflow:hidden}' +
    '.qs-overlay.is-closing{background:transparent}' +
    '.qs{--route:#ee352e;--route-ink:#ffffff;box-sizing:border-box;width:100%;max-width:640px;max-height:82vh;overflow-y:auto;' +
    'overscroll-behavior:contain;background:#1b1b1b;color:#eeeeee;border:1px solid #333333;border-top:3px solid var(--route);' +
    'border-radius:2px 2px 0 0;padding:0 20px calc(20px + env(safe-area-inset-bottom,0px));outline:none;' +
    'animation:qs-up 320ms cubic-bezier(0.22,1,0.36,1);transition:transform 300ms cubic-bezier(0.22,1,0.36,1)}' +
    '.qs.is-dragging{transition:none}' +
    '.qs.is-closing{transform:translateY(100%) !important;transition:transform 250ms cubic-bezier(0.4,0,1,1)}' +
    '@keyframes qs-up{from{transform:translateY(100%)}}' +
    '.qs-handle{display:none}' +
    '.qs-top{margin:0 -20px;padding:18px 20px;background:#0c0c0c;color:#ffffff;display:grid;' +
    'grid-template-columns:1.75rem minmax(0,1fr);column-gap:12px;align-items:start}' +
    '.qs-disc{display:inline-flex;align-items:center;justify-content:center;width:1.75rem;height:1.75rem;border-radius:50%;' +
    'background:var(--route);color:var(--route-ink);font-size:1rem;font-weight:800;line-height:1}' +
    '.qs h3{margin:0;font-size:1.375rem;font-weight:800;letter-spacing:-0.02em;line-height:1.2;overflow-wrap:break-word}' +
    '.qs-close{display:none;width:44px;height:44px;margin:-6px -12px 0 0;padding:0;border:0;background:transparent;color:#ffffff;' +
    'font:inherit;font-size:1.375rem;font-weight:800;line-height:1;cursor:pointer;align-items:center;justify-content:center}' +
    '.qs-close:focus-visible{outline:2px solid #ffffff;outline-offset:-4px}' +
    '@media (hover:hover) and (pointer:fine){.qs-top{grid-template-columns:1.75rem minmax(0,1fr) 44px}.qs-close{display:flex}}' +
    '@media (max-width:930px){' +
    '.qs{border-width:3px 0 0}' +
    '.qs-handle{display:block;position:sticky;top:0;z-index:5;margin:0 -20px -1px;padding:6px 0 22px;background:#0c0c0c;' +
    'touch-action:none;cursor:grab}' +
    '.qs-handle::before,.qs-handle::after{content:"";position:absolute;top:6px;width:23px;height:5px;background:#6d6d6d;' +
    'border-radius:2px;transition:transform 160ms ease}' +
    '.qs-handle::before{left:calc(50% - 22px)}' +
    '.qs-handle::after{right:calc(50% - 22px)}' +
    '.qs-handle.is-vee::before{transform:translateY(3px) rotate(15deg)}' +
    '.qs-handle.is-vee::after{transform:translateY(3px) rotate(-15deg)}' +
    '.qs-top{padding-top:0;touch-action:none;cursor:grab}}' +
    '@media (max-width:380px){.qs{padding-left:16px;padding-right:16px}.qs-top,.qs-handle{margin-left:-16px;margin-right:-16px}' +
    '.qs-top{padding-left:16px;padding-right:16px}}' +
    // a computer keeps the box, as the quest list does: centred, a stop
    // larger, the cross on the name's line, and no slide
    '@media (min-width:931px){.qs-overlay{align-items:center;padding:20px}' +
    '.qs{max-width:520px;border-radius:2px;animation:none;transition:none}' +
    '.qs.is-closing{transform:none !important}' +
    '.qs-top{grid-template-columns:1.875rem minmax(0,1fr) 44px;column-gap:16px;padding-top:16px}' +
    '.qs-disc{width:1.875rem;height:1.875rem}' +
    '.qs h3,.qs-close{font-size:1.625rem}' +
    '.qs-close{display:flex}' +
    '.qs-body,.qs-points{margin-top:32px}' +
    '.qs-row{grid-template-columns:minmax(max-content,6.75rem) minmax(0,1fr);column-gap:16px;padding:12px 0}' +
    '.qs-head,.qs-pts{font-size:1.25rem}}' +
    '@media (prefers-reduced-motion:reduce){.qs,.qs-overlay{animation:none;transition:none}}' +
    '.qs-body{margin-top:24px;font-size:1rem;line-height:1.55;overflow-wrap:break-word}' +
    '.qs-body p,.qs-body ul{margin:0 0 0.7em}' +
    '.qs-body ul{padding-left:1.2em}' +
    '.qs-body > :last-child{margin-bottom:0}' +
    '.qs-body a{color:#eeeeee;font-weight:700}' +
    '.qs-body code{font-family:"Roboto Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:0.9em}' +
    '.qs-flavour{margin:12px 0 0;font-size:1rem;line-height:1.5;font-style:italic;color:#a3a3a3;overflow-wrap:break-word}' +
    '.qs-facts{margin-top:12px;border-top:1px solid #4a4a4a}' +
    '.qs-row{display:grid;grid-template-columns:minmax(max-content,6.25rem) minmax(0,1fr);column-gap:12px;padding:8px 0;' +
    'border-bottom:1px solid #4a4a4a}' +
    '.qs-fact{align-items:start}' +
    '.qs-k{display:flex;align-items:center;gap:8px;min-height:1.5rem;color:#a3a3a3;font-size:0.72rem;font-weight:800;' +
    'letter-spacing:0.08em;text-transform:uppercase}' +
    '.qs-k svg{width:1.4em;height:1.4em;flex:none}' +
    '.qs-v{min-width:0;font-size:1rem;line-height:1.5;overflow-wrap:break-word}' +
    '.qs-points{margin-top:24px}' +
    '.qs-head{display:block;margin:0;padding:10px 0 4px;border-top:2px solid #6d6d6d;font-size:1.125rem;font-weight:800;' +
    'letter-spacing:-0.02em;line-height:1.2}' +
    '.qs-code{align-items:baseline}' +
    '.qs-chip{justify-self:start;padding:0 6px;border-radius:2px;background:#0c0c0c;color:#ffffff;box-shadow:inset 0 0 0 1px #484848;' +
    'font-family:"Roboto Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:0.72rem;font-weight:500;line-height:1.5;' +
    'white-space:nowrap}' +
    '.qs-text{display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:12px;align-items:start;min-width:0}' +
    '.qs-label{font-size:1rem;line-height:1.5rem;overflow-wrap:break-word}' +
    '.qs-pts{font-size:1.375rem;font-weight:800;letter-spacing:-0.02em;line-height:1.5rem;white-space:nowrap;text-align:right;' +
    'font-variant-numeric:tabular-nums lining-nums}' +
    // what a photo says about itself, on the same sheet without the
    // region's line or disc: the album viewer's Details rows
    '.qs.is-plain{--route:#333333;border-top-width:1px}' +
    '.qs-top.is-plain{grid-template-columns:minmax(0,1fr) auto}' +
    '.qs-info{margin-top:20px;display:grid;gap:18px}' +
    '.qs-info-row{display:grid;grid-template-columns:24px minmax(0,1fr);gap:14px;align-items:start}' +
    '.qs-info-icon{color:#a3a3a3}' +
    '.qs-info-icon svg{display:block;width:22px;height:22px}' +
    '.qs-info-text{min-width:0;display:grid;gap:3px}' +
    '.qs-info-title{margin:0;font-size:0.95rem;font-weight:700;overflow-wrap:anywhere}' +
    '.qs-info-line,.qs-note{margin:0;font-size:0.85rem;color:#a3a3a3;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}' +
    '.qs-info-link{justify-self:start;margin-top:4px;color:#eeeeee;font-size:0.85rem;font-weight:800;text-decoration:none;' +
    'border-bottom:2px solid currentColor}' +
    '.qs-info-link:focus-visible{outline:2px solid #ffffff;outline-offset:2px}' +
    // Link copied, dropping in at the top and leaving the way it came
    '.ph-toast{position:fixed;left:50%;top:calc(12px + env(safe-area-inset-top,0px));z-index:30;max-width:calc(100vw - 24px);' +
    'box-sizing:border-box;padding:10px 14px;border-radius:2px;background:rgba(12,15,20,0.94);color:#ffffff;' +
    'box-shadow:0 0 0 1px #484848,2px 2px 0 rgba(0,0,0,0.5);font-size:0.9rem;font-weight:700;line-height:1.4;' +
    'opacity:0;pointer-events:none;transform:translate(-50%,-8px);' +
    'transition:opacity 250ms cubic-bezier(0.22,1,0.36,1),transform 250ms cubic-bezier(0.22,1,0.36,1)}' +
    '.ph-toast.is-open{opacity:1;transform:translate(-50%,0);transition-duration:350ms}' +
    '@media (prefers-reduced-motion:reduce){.ph-toast{transition:none}}' +
    '.ph-name{min-width:0;overflow-wrap:anywhere}' +
    '.ph-by{display:inline-flex;flex:none;color:#b8bcc2}.ph-who .ph-by+.ph-name{margin-left:-4px}' +
    '.ph-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
    '.ph-meta{margin:0;color:#a3a3a3;font-size:0.85rem;font-weight:400;font-variant-numeric:tabular-nums}' +
    // a PDF: one bar across the top (the mark, the file's name, its
    // buttons) over the pages, which scroll under it, and the page and
    // zoom controls floating over the foot of the pages. The reader takes
    // both of the body's rows, since the site's name is in the bar
    '.ph-reader{--bar-h:calc(61px + env(safe-area-inset-top,0px));position:relative;grid-row:1 / -1;display:grid;' +
    'grid-template-rows:minmax(0,1fr);min-height:0}' +
    '.ph-bar{position:absolute;top:0;left:0;right:0;z-index:4;display:grid;grid-template-columns:auto minmax(0,1fr) auto;' +
    'align-items:center;gap:12px;padding:calc(10px + env(safe-area-inset-top,0px)) 16px 10px;background:#111111;' +
    'border-bottom:1px solid #333333;transition:transform 250ms cubic-bezier(0.22,1,0.36,1)}' +
    // on a phone it leaves while the pages scroll down and comes back
    // when they scroll up
    '.ph-bar.is-tucked{transform:translateY(-100%);transition-duration:150ms}' +
    '@media (prefers-reduced-motion:reduce){.ph-bar{transition:none}}' +
    '.ph-title{display:grid;gap:2px;min-width:0}' +
    '.ph-bar .ph-who{font-size:0.95rem}' +
    '.ph-bar .ph-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.ph-bar .ph-acts{flex-wrap:nowrap}' +
    '@media (max-width:560px){.ph-bar .ph-meta{display:none}' +
    '.ph-bar .ph-name{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;white-space:normal;line-height:1.25}' +
    '.ph-bar .ph-save{width:40px;padding:0;justify-content:center}' +
    '.ph-bar .ph-save span{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}}' +
    // a pinch on the pages is the viewer's own zoom, not the browser's
    '.ph-view{position:relative;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable both-edges;' +
    'touch-action:pan-x pan-y;' +
    'padding:calc(var(--bar-h) + 16px) 16px calc(88px + env(safe-area-inset-bottom,0px))}' +
    '.ph-view:focus{outline:none}' +
    '.ph-view:focus-visible{outline:2px solid #ffffff;outline-offset:-2px}' +
    '.ph-pdf{display:grid;justify-items:center;gap:12px;width:max-content;min-width:100%}' +
    '.ph-page{position:relative;width:595px;height:842px;background:#ffffff;border-radius:2px;overflow:hidden}' +
    '.ph-page canvas{position:absolute;inset:0;display:block;width:100%;height:100%}' +
    '.ph-note{margin:8px 0;color:#a3a3a3;justify-self:start}' +
    '.ph-pdf.is-failed .ph-note{color:#ffffff;font-weight:700}' +
    // the text under each page's picture, invisible until selected
    // (PDF.js's own text layer rules, from its viewer's stylesheet)
    '.textLayer{position:absolute;inset:0;overflow:clip;opacity:1;line-height:1;text-align:initial;' +
    '-webkit-text-size-adjust:none;text-size-adjust:none;forced-color-adjust:none;transform-origin:0 0;caret-color:CanvasText;z-index:0}' +
    '.textLayer span,.textLayer br{color:transparent;position:absolute;white-space:pre;cursor:text;transform-origin:0% 0%}' +
    '.textLayer > :not(.markedContent),.textLayer .markedContent span:not(.markedContent){z-index:1}' +
    '.textLayer span.markedContent{top:0;height:0}' +
    '.textLayer ::selection{background:rgba(0,0,255,0.25);background:color-mix(in srgb,AccentColor,transparent 75%)}' +
    '.textLayer br::selection{background:transparent}' +
    '.textLayer .endOfContent{display:block;position:absolute;inset:100% 0 0;z-index:0;cursor:default;' +
    '-webkit-user-select:none;user-select:none}' +
    '.textLayer.selecting .endOfContent{top:0}' +
    // the PDF's links, over its text
    '.ph-links{position:absolute;inset:0;z-index:1;pointer-events:none}' +
    '.ph-links a{position:absolute;pointer-events:auto;border-radius:2px;-webkit-tap-highlight-color:rgba(0,147,60,0.25)}' +
    '.ph-links a:focus-visible{outline:2px solid #00933c;outline-offset:1px}' +
    '.ph-tools{position:absolute;left:50%;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:3;transform:translateX(-50%);' +
    'display:flex;align-items:center;gap:2px;padding:4px;border:1px solid #484848;border-radius:2px;background:#0c0c0c;' +
    'box-shadow:2px 2px 0 rgba(0,0,0,0.5);white-space:nowrap}' +
    '.ph-tools[hidden],.ph-tools [hidden]{display:none}' +
    '.ph-at{display:flex;align-items:center;gap:6px;padding:0 6px 0 8px;font-size:0.85rem;font-weight:700;' +
    'font-variant-numeric:tabular-nums}' +
    '.ph-at input{box-sizing:content-box;width:2ch;height:30px;padding:0 6px;border:1px solid #484848;border-radius:2px;' +
    'background:#111111;color:#ffffff;font:inherit;text-align:center}' +
    '.ph-at input:hover{border-color:#a3a3a3}' +
    '.ph-at input:focus{outline:none;border-color:#ffffff}' +
    '.ph-of{color:#a3a3a3}' +
    '.ph-sep{flex:none;width:1px;height:24px;margin:0 6px;background:#333333}' +
    '.ph-tool{box-sizing:border-box;width:40px;height:40px;display:grid;place-items:center;padding:0;border:0;border-radius:2px;' +
    'background:transparent;color:#ffffff;cursor:pointer}' +
    '.ph-tool svg{display:block}' +
    '.ph-tool:disabled{color:#5c5c5c;cursor:default}' +
    '.ph-fs-box{display:flex;align-items:center;gap:2px}' +
    '.ph-zoom-box{position:relative;display:block}' +
    '.ph-zoom-box::after{content:"";position:absolute;right:12px;top:50%;width:5px;height:5px;margin-top:-5px;' +
    'border:solid #a3a3a3;border-width:0 2px 2px 0;transform:rotate(45deg);pointer-events:none}' +
    '.ph-zoom{-webkit-appearance:none;appearance:none;box-sizing:border-box;display:block;width:6.75rem;height:40px;' +
    'padding:0 22px;border:0;border-radius:2px;background:transparent;color:#ffffff;font:inherit;font-size:0.85rem;' +
    'font-weight:700;font-variant-numeric:tabular-nums;text-align:center;text-align-last:center;cursor:pointer}' +
    '.ph-zoom option{background:#1b1b1b;color:#ffffff}' +
    '@media (hover:hover) and (pointer:fine){.ph-tool:not(:disabled):hover,.ph-zoom:hover{background:#262626}}' +
    '.ph-tool:focus-visible,.ph-zoom:focus-visible{outline:2px solid #ffffff;outline-offset:-2px}' +
    // a PDF's zoom is the page's own, so the browser's pinch and double
    // tap are kept off all of it, the bar and the controls included; the
    // first line is for a browser that knows only manipulation
    'html.is-reader{touch-action:manipulation;touch-action:pan-x pan-y}' +
    '.ph-tools,.ph-bar .ph-acts{-webkit-user-select:none;user-select:none}' +
    '.ph-at input{-webkit-user-select:text;user-select:text}' +
    '.ph-tool,.ph-zoom{-webkit-tap-highlight-color:transparent}' +
    '.ph-tool:not(:disabled):active,.ph-zoom:active{background:#262626}' +
    '.ph-tool .ph-fs-in{display:none}' +
    'html.is-full .ph-tool .ph-fs-out{display:none}' +
    'html.is-full .ph-tool .ph-fs-in{display:block}' +
    // under 16px a phone's browser zooms the page to type in a box
    '@media (pointer:coarse){.ph-at{font-size:1rem}}' +
    '@media (max-width:480px){.ph-at-k{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}' +
    '.ph-at{padding-left:4px}.ph-sep{margin:0 2px}.ph-zoom{width:6.5rem;padding:0 20px}.ph-zoom-box::after{right:10px}}' +
    '@media (max-width:359px){.ph-at{padding:0 4px 0 2px}.ph-sep{margin:0 1px}.ph-tool{width:34px}' +
    '.ph-zoom{width:5.5rem;padding:0 20px 0 6px}.ph-zoom-box::after{right:9px}}' +
    // any other file: a card to download it from
    '.ph-file{box-sizing:border-box;display:grid;justify-items:center;gap:10px;width:min(100%,28rem);padding:32px 24px;' +
    'text-align:center;border:1px solid #333333;border-radius:2px;background:#1b1b1b}' +
    '.ph-file-icon{color:#a3a3a3}' +
    '.ph-file-icon svg{display:block}' +
    '.ph-file-name{margin:0;font-size:1.25rem;font-weight:800;line-height:1.3;overflow-wrap:anywhere}' +
    '.ph-file .ph-acts{margin-top:8px}' +
    '.ph-gone{padding:48px 16px;max-width:36rem}' +
    '.ph-gone a{color:#ffffff;font-weight:800}' +
    '</style></head><body>' + body + '</body></html>';
}

export function gonePage(env: Env, line: string): Response {
  var site = String(env.SITE_URL || 'https://scs.andyrew.space').replace(/\/+$/, '');
  return new Response(sharePageHtml('<title>SCS.2</title>',
    '<main class="ph-gone"><p>' + escapeHtml(line) + '</p>' +
    '<p><a href="' + escapeHtml(site) + '/">SCS.2 Legends of the City</a></p></main>', site),
    { status: 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' } });
}

// A quest's text, as the site's scs.markdown renders it: escaped first,
// then bold, underline, italic, code, https links, paragraphs and - lists.
function questMarkdown(text: unknown): string {
  function inline(t: string): string {
    return t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/__(.+?)__/g, '<u>$1</u>')
      .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
  return escapeHtml(String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim()).split(/\n{2,}/).map(function (block) {
    var lines = block.split('\n');
    if (lines.every(function (l) { return /^\s*[-*] /.test(l); })) {
      return '<ul>' + lines.map(function (l) { return '<li>' + inline(l.replace(/^\s*[-*] /, '')) + '</li>'; }).join('') + '</ul>';
    }
    return '<p>' + lines.map(inline).join('<br>') + '</p>';
  }).join('');
}

// the details button is the site viewer's, and the quest's is the pin the
// quest list's tab carries
var INFO_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/>' +
  '<path d="M11.95 7.5h.1"/></svg>';
var PIN_PATH = '<path d="M12 21s-7-5.1-7-11a7 7 0 1 1 14 0c0 5.9-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>';
var PIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true">' + PIN_PATH + '</svg>';
var QUEST_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + PIN_PATH + '</svg>';
var SHARE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3"/><path d="M7 8l5-5 5 5"/>' +
  '<path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
// the site's line colours in the dark theme, and the ones a white
// letter does not read on (quest list: paintRoute)
var LINE: Record<string, string> = { red: '#ee352e', orange: '#ff6319', yellow: '#fccc0a', green: '#00933c', blue: '#3d74d6', lime: '#6cbe45',
  purple: '#b933ad', brown: '#996633', grey: '#a7a9ac', sky: '#00a1de' };
var DARK_LETTER: Record<string, boolean> = { yellow: true, lime: true, grey: true };

// The quest a shared file was sent for, drawn as the quest list's sheet
// draws it: the region's disc and the name on the black head, the
// description, the flavour line, where it is, and its codes and points
// (??? for a mystery). No actions: ticking off and sending proof belong
// to the quest list and the submit page.
function questPanel(q: PublicQuest): string {
  var colour = LINE[q.colour] ? q.colour : 'red';
  var route = '--route:' + LINE[colour] + ';--route-ink:' + (DARK_LETTER[colour] ? '#111111' : '#ffffff');
  var letter = String(q.region || '').replace(/^the\s+/i, '').trim().charAt(0).toUpperCase() || '?';
  var where = q.location || (q.coords || []).map(function (c) { return c.label || q.name; }).join(' • ') || 'No Fixed Location';
  var rows = q.codes.map(function (c) {
    var label = c.label || (q.codes.length === 1 ? q.name : '');
    return '<div class="qs-row qs-code"><span class="qs-chip">' + escapeHtml(c.code) + '</span><span class="qs-text">' +
      '<span class="qs-label">' + escapeHtml(label) + '</span>' +
      '<span class="qs-pts">' + (c.points == null ? '???' : escapeHtml(String(c.points))) + '</span></span></div>';
  }).join('');
  return '<div class="qs-overlay" id="ph-quest" hidden>' +
    '<div class="qs" role="dialog" aria-modal="true" aria-labelledby="ph-quest-name" tabindex="-1" style="' + route + '">' +
    '<div class="qs-handle" aria-hidden="true"></div>' +
    '<div class="qs-top"><span class="qs-disc" aria-hidden="true">' + escapeHtml(letter) + '</span>' +
    '<h3 id="ph-quest-name">' + escapeHtml(q.name || q.code.code) + '</h3>' +
    '<button class="qs-close" type="button" id="ph-quest-close" aria-label="Close">&#10005;</button></div>' +
    (q.description ? '<div class="qs-body">' + questMarkdown(q.description) + '</div>' : '') +
    (q.flavour ? '<p class="qs-flavour">' + escapeHtml(q.flavour) + '</p>' : '') +
    '<div class="qs-facts"><div class="qs-row qs-fact"><span class="qs-k">' + PIN_ICON + 'Where</span>' +
    '<span class="qs-v">' + escapeHtml(where) + '</span></div></div>' +
    '<div class="qs-points"><span class="qs-head">Quest Codes &amp; Points</span>' + rows + '</div>' +
    '</div></div>' +
    sheetScript('ph-quest');
}

// What makes a sheet open and close: its button (`<id>-open`), the
// cross, the dim, Escape, and on a phone a drag down. Another control can
// open it with a ph-open event naming itself, which gets the focus back;
// it says ph-shown each time it opens.
function sheetScript(id: string): string {
  return '<script>(function(){var o=document.getElementById("' + id + '"),s=o&&o.querySelector(".qs"),' +
    'b=document.getElementById("' + id + '-open"),x=document.getElementById("' + id + '-close");if(!s||!b)return;' +
    'var h=s.querySelector(".qs-handle"),top=s.querySelector(".qs-top"),narrow=window.matchMedia("(max-width: 930px)"),back=b;' +
    'function gone(){o.hidden=true;o.classList.remove("is-closing");s.classList.remove("is-closing");s.style.transform="";' +
    'document.body.classList.remove("qs-open");if(back&&back.isConnected)back.focus();}' +
    // Escape closes it ahead of anything open under it
    'function key(e){if(e.key==="Escape"){e.preventDefault();close();}}' +
    'function open(from){back=from||b;o.hidden=false;s.classList.remove("is-closing");s.style.transform="";s.scrollTop=0;' +
    'document.body.classList.add("qs-open");s.focus();document.addEventListener("keydown",key,true);' +
    'o.dispatchEvent(new CustomEvent("ph-shown"));}' +
    'function close(){if(o.hidden||s.classList.contains("is-closing"))return;document.removeEventListener("keydown",key,true);' +
    'if(!narrow.matches){gone();return;}s.classList.add("is-closing");o.classList.add("is-closing");setTimeout(gone,250);}' +
    'b.addEventListener("click",function(){open(b);});if(x)x.addEventListener("click",close);' +
    'o.addEventListener("ph-open",function(e){open(e.detail);});' +
    // a tap on the dim closes it
    'o.addEventListener("click",function(e){if(e.target===o)close();});' +
    // on a phone the grab bar and the head drag it, and so does the rest
    // of it pulled down from the top: let go past 90px or quickly to
    // close, short of that it springs back. A move the sheet cannot
    // scroll with is kept from the page under it
    'var y0=null,dy=0,lastY=0,lastT=0,speed=0,dragging=false,grip=false;' +
    'function at(e){return e.touches?e.touches[0].clientY:e.clientY;}' +
    'function start(e){if(!narrow.matches||(e.target.closest&&e.target.closest("button,a")))return;' +
    'y0=lastY=at(e);lastT=Date.now();dy=0;speed=0;dragging=false;grip=!!(e.target.closest&&e.target.closest(".qs-handle,.qs-top"));}' +
    'function move(e){if(y0===null)return;var y=at(e),t=Date.now();' +
    'if(!dragging){var d=y-y0,room=s.scrollHeight-s.clientHeight;if(!d)return;' +
    'if(grip||(d>0&&s.scrollTop<=0)){dragging=true;s.classList.add("is-dragging");}' +
    'else if(room>0&&!(d<0&&s.scrollTop>=room)){y0=null;return;}' +
    'else{if(e.cancelable)e.preventDefault();return;}}' +
    'dy=y-y0;speed=(y-lastY)/Math.max(1,t-lastT);lastY=y;lastT=t;' +
    's.style.transform="translateY("+(dy>0?dy:-Math.min(24,Math.sqrt(-dy)*3))+"px)";if(h)h.classList.toggle("is-vee",dy>4);' +
    'if(e.cancelable)e.preventDefault();}' +
    'function end(){if(y0===null)return;y0=null;if(!dragging)return;dragging=false;s.classList.remove("is-dragging");' +
    'if(h)h.classList.remove("is-vee");if(dy>90||speed>0.5)close();else s.style.transform="";}' +
    's.addEventListener("touchstart",start,{passive:true});s.addEventListener("touchmove",move,{passive:false});' +
    's.addEventListener("touchend",end);s.addEventListener("touchcancel",end);' +
    '[h,top].forEach(function(n){if(!n)return;' +
    'n.addEventListener("mousedown",function(e){start(e);if(y0===null)return;e.preventDefault();' +
    'function up(){document.removeEventListener("mousemove",move);document.removeEventListener("mouseup",up);end();}' +
    'document.addEventListener("mousemove",move);document.addEventListener("mouseup",up);});});})();</script>';
}

// What a photo or video says about itself, on the quest's sheet without
// the region's line: the album viewer's Details, for a file an album
// showing details holds (detailsHolder). The rows are asked for the first
// time it opens, from /api/albums/info, and drawn by the site's
// photo-details.js.
function detailsPanel(api: string, site: string, item: Pick<MediaItem, 'key' | 'type'>): string {
  var src = api + '/api/albums/info?key=' + encodeURIComponent(item.key);
  return '<div class="qs-overlay" id="ph-info" hidden data-src="' + escapeHtml(src) + '"' +
    (isVideoType(item.type) ? ' data-video="1"' : '') + '>' +
    '<div class="qs is-plain" role="dialog" aria-modal="true" aria-labelledby="ph-info-name" tabindex="-1">' +
    '<div class="qs-handle" aria-hidden="true"></div>' +
    '<div class="qs-top is-plain"><h3 id="ph-info-name">Details</h3>' +
    '<button class="qs-close" type="button" id="ph-info-close" aria-label="Close">&#10005;</button></div>' +
    '<div class="qs-info" id="ph-info-body"></div></div></div>' +
    '<script>(function(){var o=document.getElementById("ph-info"),body=document.getElementById("ph-info-body");if(!o||!body)return;' +
    'phNeed(' + JSON.stringify(site + '/assets/photo-details.js').replace(/</g, '\\u003c') + ');' +
    'var asked=false,miss=0;' +
    'function line(c,t){var p=document.createElement("p");p.className=c;p.textContent=t;return p;}' +
    'function say(t){body.textContent="";body.appendChild(line("qs-note",t));}' +
    'function draw(rows){body.textContent="";rows.forEach(function(r){' +
    'var row=document.createElement("div");row.className="qs-info-row";' +
    'var icon=document.createElement("span");icon.className="qs-info-icon";icon.innerHTML=r.icon||"";' +
    'var text=document.createElement("div");text.className="qs-info-text";text.appendChild(line("qs-info-title",r.title||""));' +
    '(r.lines||[]).forEach(function(l){if(l)text.appendChild(line("qs-info-line",l));});' +
    'if(r.href){var a=document.createElement("a");a.className="qs-info-link";a.href=r.href;a.target="_blank";a.rel="noopener";' +
    'a.textContent=r.link||r.href;text.appendChild(a);}' +
    'row.appendChild(icon);row.appendChild(text);body.appendChild(row);});}' +
    'function fill(){if(asked)return;asked=true;say("Loading…");' +
    'fetch(o.getAttribute("data-src"),{cache:"no-store"}).then(function(r){if(!r.ok)throw 0;return r.json();}).then(function(d){' +
    'if(!window.scsPhotoDetails)throw 0;miss=0;draw(scsPhotoDetails.rows(d,o.getAttribute("data-video")==="1"));' +
    // asked again by itself a few times while the sheet is open
    '}).catch(function(){asked=false;if(miss<4&&!o.hidden){setTimeout(function(){if(!o.hidden)fill();},phWaits[miss++]);return;}' +
    'miss=0;say("Could not load the details.");});}' +
    'o.addEventListener("ph-shown",fill);})();</script>' +
    sheetScript('ph-info');
}

// Share: the phone's own share sheet on a phone, the clipboard and a
// note elsewhere, as the site's viewer does. The address is this page's.
// Loads that are asked for again when a phone's connection drops one:
// phNeed(src, then) for a script from the site, phKeep(el) for the
// page's picture or a video with no player of its own. Each waits a
// little longer than the last, seven tries in all.
var LOAD_SCRIPT = '<script>(function(){var W=[400,800,1600,3200,6400,8000];' +
  'window.phWaits=W;' +
  'window.phNeed=function(src,then){var n=0;(function go(){var s=document.createElement("script");' +
  's.src=src+(n?(src.indexOf("?")<0?"?":"&")+"r="+n:"");s.async=true;' +
  's.onload=function(){if(then)then();};' +
  's.onerror=function(){if(s.parentNode)s.parentNode.removeChild(s);if(n<W.length)setTimeout(go,W[n++]);};' +
  'document.head.appendChild(s);})();};' +
  'window.phKeep=function(m){if(!m)return;var n=0,v=m.tagName==="VIDEO";' +
  'm.addEventListener("error",function(){if(n>=W.length)return;setTimeout(function(){' +
  'if(v){var at=m.currentTime||0;m.load();if(at){try{m.currentTime=at;}catch(e){}}}else m.src=m.getAttribute("src");},W[n++]);});' +
  'm.addEventListener(v?"loadeddata":"load",function(){n=0;});};' +
  '})();</script>';

var SHARE_SCRIPT = '<div class="ph-toast" id="ph-toast" role="status" aria-live="polite"></div>' +
  '<script>(function(){var b=document.getElementById("ph-share"),n=document.getElementById("ph-toast");if(!b)return;var t=0;' +
  'function handheld(){return !!(window.matchMedia&&(matchMedia("(pointer: coarse)").matches||matchMedia("(hover: none)").matches));}' +
  'function note(s){if(!n)return;n.textContent=s;n.classList.add("is-open");clearTimeout(t);' +
  't=setTimeout(function(){n.classList.remove("is-open");},2200);}' +
  'b.addEventListener("click",function(){var link=location.href.split("#")[0];' +
  'if(navigator.share&&handheld()){navigator.share({url:link}).catch(function(){});return;}' +
  'if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(link).then(function(){note("Link copied");},' +
  'function(){window.prompt("Copy this link",link);});}else{window.prompt("Copy this link",link);}});})();</script>';

var DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v12"/><path d="M7 10l5 5 5-5"/><path d="M5 21h14"/></svg>';
var OPEN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/>' +
  '<path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
// who sent it, beside the name, so a typed name is not read as the
// photo's title: one person for a name somebody typed, two for a team
var PERSON_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>';
var TEAM_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/>' +
  '<path d="M16 4.6a3.5 3.5 0 0 1 0 6.8"/><path d="M18 13.6a6.5 6.5 0 0 1 3.5 6.4"/></svg>';
function toolIcon(paths: string, cls?: string): string {
  return '<svg' + (cls ? ' class="' + cls + '"' : '') + ' viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>';
}
// the page and zoom controls over a PDF's pages
var PDF_TOOLS = '<div class="ph-tools" id="ph-tools" role="group" aria-label="Page and zoom" hidden>' +
  '<span class="ph-at"><label class="ph-at-k" for="ph-at-n">Page</label>' +
  '<input id="ph-at-n" type="text" inputmode="numeric" autocomplete="off" enterkeyhint="go" value="1" aria-describedby="ph-of">' +
  '<span class="ph-of" id="ph-of"></span></span>' +
  '<span class="ph-sep" aria-hidden="true"></span>' +
  '<button class="ph-tool" type="button" id="ph-out" aria-label="Zoom out">' + toolIcon('<path d="M5 12h14"/>') + '</button>' +
  '<span class="ph-zoom-box"><select class="ph-zoom" id="ph-zoom" aria-label="Zoom">' +
  '<option value="width">Fit width</option><option value="page">Fit page</option>' +
  [25, 50, 75, 100, 125, 150, 200, 300, 400].map(function (p) { return '<option value="' + (p / 100) + '">' + p + '%</option>'; }).join('') +
  '</select></span>' +
  '<button class="ph-tool" type="button" id="ph-in" aria-label="Zoom in">' + toolIcon('<path d="M12 5v14"/><path d="M5 12h14"/>') + '</button>' +
  '<span class="ph-fs-box" id="ph-fs-box" hidden><span class="ph-sep" aria-hidden="true"></span>' +
  '<button class="ph-tool" type="button" id="ph-fs" aria-label="Full screen">' +
  toolIcon('<path d="M4 9V4h5"/><path d="M15 4h5v5"/><path d="M20 15v5h-5"/><path d="M9 20H4v-5"/>', 'ph-fs-out') +
  toolIcon('<path d="M9 4v5H4"/><path d="M20 9h-5V4"/><path d="M15 20v-5h5"/><path d="M4 15h5v5"/>', 'ph-fs-in') +
  '</button></span></div>';

var FILE_ICON = '<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/>' +
  '<path d="M14 3v5h5"/></svg>';

function sizeText(bytes: unknown): string {
  var n = Number(bytes) || 0;
  if (!n) return '';
  if (n >= 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

// what kind of file a name and a type say it is, for the card: the
// extension in capitals, or the type's second half
function kindText(name: unknown, type: unknown): string {
  var m = String(name || '').match(/\.([A-Za-z0-9]{1,8})$/);
  if (m) return m[1].toUpperCase();
  var t = String(type || '').split(';')[0].split('/')[1] || '';
  return t ? t.toUpperCase() : 'File';
}

// the site's mark, home; the words beside it, or named for a screen reader
function homeLink(site: string, cls: string, words: boolean): string {
  return '<a class="' + cls + '" href="' + escapeHtml(site) + '/"' + (words ? '' : ' aria-label="SCS.2 Legends of the City"') + '>' +
    '<img src="' + escapeHtml(site + '/assets/icons/logo-64.png') + '" srcset="' + escapeHtml(site + '/assets/icons/logo-128.png') +
    ' 2x" width="39" height="32" alt="">' + (words ? '<span><b>SCS.2</b> Legends of the City</span>' : '') + '</a>';
}

function link(cls: string, href: string, inner: string, extra?: string): string {
  return '<a class="' + cls + '" href="' + escapeHtml(href) + '"' + (extra || '') + '>' + inner + '</a>';
}

// The page for one file. `item` says what it is and where it came from:
// {key, type, from, who, quest, w, h} for a photo or video from an album
// or the gallery (the share links), or, for a file opened at its own
// address, `base` too — the path the file is named under, to which its
// name is added — with its `name` and `bytes`. Such a file is shown
// as it is served there: a photo whole, a video as it was sent, a PDF
// drawn page by page, anything else as a card to download.
export async function mediaPage(env: Env, url: URL, item: MediaItem): Promise<Response> {
  var site = String(env.SITE_URL || 'https://scs.andyrew.space').replace(/\/+$/, '');
  var api = String(env.PUBLIC_API || url.origin).replace(/\/+$/, '');
  var plain = !!item.base;
  var base = api + (item.base || (item.from === 'album' ? '/api/albums/file/' : '/api/submit/file/') +
    item.key.split('/').map(encodeURIComponent).join('/') + '/');
  var fileName = item.name ? fileNameFor(item.name, item.type) : '';
  var named = base + encodeURIComponent(fileName || fileNameFor('file', item.type));
  var kind = isVideoType(item.type) ? 'video' : String(item.type || '').indexOf('image/') === 0 ? 'photo' : isPdf(item.type) ? 'pdf' : 'file';
  // said the way the album's viewer says it
  var who = item.quest ? item.quest + (item.who ? ' · ' + item.who : '') : item.who;
  var title = (who || fileName) ? (who || fileName) + ' · SCS.2' : 'SCS.2';
  var head = '<title>' + escapeHtml(title) + '</title>' +
    '<meta property="og:site_name" content="SCS.2 Legends of the City">' +
    '<meta property="og:title" content="' + escapeHtml(title) + '">' +
    '<meta name="theme-color" content="#00933c">';
  var media = '';
  var save: string;
  var script = '';
  var open = '';
  if (kind === 'video' && !plain) {
    var still = base + 'still.jpg?thumb=1';
    var clip = base + 'clip.mp4';
    var heights = (await heightsFor(env.DB, [item.key]))[item.key] || [];
    head += '<meta name="twitter:card" content="summary_large_image">' +
      '<meta property="og:type" content="video.other">' +
      '<meta property="og:image" content="' + escapeHtml(still) + '">' +
      '<meta property="og:video" content="' + escapeHtml(clip + '?res=1080') + '">' +
      '<meta property="og:video:type" content="video/mp4">';
    media = '<video id="ph-v" src="' + escapeHtml(rawOf(clip + '?res=1080')) + '" poster="' + escapeHtml(rawOf(still)) + '" controls playsinline preload="metadata"></video>';
    save = base + 'video.mp4?download=1';
    var data = JSON.stringify({ clip: clip, heights: heights }).replace(/</g, '\\u003c');
    // the video plays from its own address at once; the site's player
    // takes it over, with the menu of sizes, when its script arrives
    script = '<script>(function(){var d=' + data + ';var v=document.getElementById("ph-v");if(!v)return;' +
      'phNeed(' + JSON.stringify(site + '/assets/video-sizes.js').replace(/</g, '\\u003c') + ',function(){if(!window.scsVideo)return;' +
      // one already playing carries on from where it was
      'var at=v.currentTime||0,on=!v.paused;' +
      'var c=scsVideo.play(v,scsVideo.sizes(d.heights,function(r){return d.clip+"?res="+r+"&raw=1";}),{control:true,className:"ph-size"});' +
      'if(c.control)document.getElementById("ph-size").appendChild(c.control);' +
      'if(at>0){var back=function(){v.removeEventListener("loadedmetadata",back);try{v.currentTime=at;}catch(e){}' +
      'if(on){var p=v.play();if(p&&p.catch)p.catch(function(){});}};v.addEventListener("loadedmetadata",back);}' +
      '});})();</script>';
  } else if (kind === 'video') {
    head += '<meta property="og:type" content="video.other">';
    media = '<video id="ph-v" src="' + escapeHtml(named + '?raw=1') + '" controls playsinline preload="metadata"></video>';
    script = '<script>phKeep(document.getElementById("ph-v"));</script>';
    save = named + '?download=1';
  } else if (kind === 'photo') {
    // a photo from an album or the gallery opens as its viewing copy, a
    // JPEG, except a GIF; any other is served whole at its address
    // one replaced in place is named for its version, so nothing cached
    // answers with the picture it was before
    var photoName = plain ? fileName : item.from !== 'album' ? fileNameFor('photo', item.type) :
      'photo' + (item.ver ? '-' + item.ver : '') + (animatedType(item.type) ? '.gif' : '.jpg');
    var whole = plain ? named : base + encodeURIComponent(photoName);
    var picture = whole + (plain || animatedType(item.type) ? '' : '?res=1080');
    head += '<meta name="twitter:card" content="summary_large_image">' +
      '<meta property="og:type" content="website">' +
      '<meta property="og:image" content="' + escapeHtml(picture) + '">';
    if (item.w && item.h) {
      var scale = Math.min(1, 1920 / Math.max(item.w, item.h));
      head += '<meta property="og:image:width" content="' + Math.round(item.w * scale) + '">' +
        '<meta property="og:image:height" content="' + Math.round(item.h * scale) + '">';
    }
    // the picture on the page is asked for with raw=1, so a browser
    // saving it gets the picture rather than this page again
    var sharpens = !plain && !animatedType(item.type);
    media = (sharpens ? '<div id="ph-load" class="ph-load" aria-hidden="true"><span></span></div>' : '') +
      '<img id="ph-i" src="' + escapeHtml(rawOf(picture)) + '" alt="' + escapeHtml(who ? 'Photo from ' + who : fileName || 'Photo') + '"' +
      ' tabindex="0" data-caption="' + escapeHtml(who || fileName) + '"' +
      (sharpens ? ' data-full="' + escapeHtml(rawOf(whole)) + '"' : '') + '>';
    save = whole + '?download=1';
    // A click or a tap shows it on the whole screen (the site's
    // photo-view.js), where it zooms and pans, and brings the whole
    // picture in place of the viewing copy; so does a pinch of the page.
    // The whole picture is read a piece at a time so the bar can say how
    // far it has got, shown only if it is still coming after 250ms,
    // creeping when the answer gives no length; anything refused before
    // an answer loads as an img
    script = '<script>(function(){var i=document.getElementById("ph-i");if(!i)return;var full=i.getAttribute("data-full");' +
      'phKeep(i);phNeed(' + JSON.stringify(site + '/assets/photo-view.js').replace(/</g, '\\u003c') + ');' +
      'var done=!full,bar=document.getElementById("ph-load"),fill=bar&&bar.firstChild,part=0,shown=false,sized=false,wait=0,creep=0,viewer=null,miss=0;' +
      // the whole picture not arriving is asked for again a few times
      'function lost(){end(false);done=false;part=0;shown=false;if(miss<4)setTimeout(sharpen,phWaits[miss++]);}' +
      'function to(p){part=Math.max(part,p);if(shown&&fill)fill.style.width=(part*100).toFixed(1)+"%";}' +
      'function end(ok){clearTimeout(wait);clearInterval(creep);if(!shown||!bar)return;if(ok)to(1);' +
      'setTimeout(function(){bar.className="ph-load";},ok?300:0);}' +
      'function put(u){var w=new Image();w.onload=function(){var s=function(){i.src=u;if(viewer)viewer.swap(u);end(true);};' +
      'if(w.decode)w.decode().then(s,s);else s();};w.onerror=lost;w.src=u;}' +
      'function sharpen(){if(done)return;done=true;' +
      'wait=setTimeout(function(){shown=true;if(!bar)return;bar.className="ph-load is-going";to(part);' +
      'if(!sized)creep=setInterval(function(){to(part?Math.min(0.94,part+(1-part)*0.1):0.2);},300);},250);' +
      'if(!window.fetch||!window.URL||!URL.createObjectURL){put(full);return;}' +
      'var answered=false;' +
      'fetch(full).then(function(r){answered=true;if(!r.ok)throw 0;' +
      'var n=Number(r.headers.get("content-length"))||0,t=r.headers.get("content-type")||"";' +
      'if(!r.body||!r.body.getReader)return r.blob();' +
      'if(n){sized=true;clearInterval(creep);}' +
      'var rd=r.body.getReader(),ps=[],got=0;' +
      'function pump(){return rd.read().then(function(x){if(x.done)return new Blob(ps,{type:t});' +
      'ps.push(x.value);got+=x.value.length;if(n)to(Math.min(0.98,got/n));return pump();});}' +
      'return pump();' +
      '}).then(function(b){put(URL.createObjectURL(b));}).catch(function(){if(!answered)put(full);else lost();});}' +
      // the full-screen view carries the page's own Details, Share and Download
      'function buttons(){var out=[],d=document.getElementById("ph-info"),db=document.getElementById("ph-info-open"),' +
      'sh=document.getElementById("ph-share"),sv=document.querySelector(".ph-fig .ph-save");' +
      'if(d&&db)out.push({label:"Details",icon:db.innerHTML,onClick:function(e,n){d.dispatchEvent(new CustomEvent("ph-open",{detail:n}));}});' +
      'if(sh)out.push({label:"Share",icon:sh.innerHTML,onClick:function(){sh.click();}});' +
      'if(sv)out.push({label:"Download",icon:sv.querySelector("svg").outerHTML,href:sv.href,download:true});return out;}' +
      'function show(){sharpen();if(viewer)return;' +
      'if(!window.SCSPhotoView){location.href=full||i.src;return;}' +
      'viewer=SCSPhotoView.open({src:i.currentSrc||i.src,alt:i.alt,caption:i.getAttribute("data-caption")||"",' +
      'ratio:i.naturalWidth&&i.naturalHeight?i.naturalWidth/i.naturalHeight:0,origin:i,buttons:buttons(),' +
      'onClose:function(){viewer=null;i.focus({preventScroll:true});}});}' +
      'i.addEventListener("click",show);' +
      'i.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();show();}});' +
      'if(window.visualViewport)visualViewport.addEventListener("resize",function(){if(visualViewport.scale>1.05)sharpen();});' +
      '})();</script>';
  } else {
    save = named + '?download=1';
    open = named + '?raw=1';
  }
  // the quest's code as a chip beside the team, as the gallery's tiles
  // show it; a file of the organisers' says its own name
  var sender = item.who ? '<span class="ph-by" title="' + (item.by === 'person' ? 'Sent by' : 'Sent by team') + '">' +
    (item.by === 'person' ? PERSON_ICON : TEAM_ICON) + '<span class="ph-hidden">' + (item.by === 'person' ? 'Sent by' : 'Sent by team') + '</span></span>' : '';
  var credit = (item.quest ? '<span class="ph-code">' + escapeHtml(item.quest) + '</span>' : '') + sender +
    ((item.who || fileName) ? '<span class="ph-name">' + escapeHtml(item.who || fileName) + '</span>' : '');
  // the quest, behind a button, while the public can see it
  var quest = item.quest ? await publicQuest(env.DB, item.quest) : null;
  var questButton = quest ? '<button class="ph-icon" type="button" id="ph-quest-open" aria-haspopup="dialog" ' +
    'aria-controls="ph-quest" aria-label="Quest details">' + QUEST_ICON + '</button>' : '';
  // what the photo or video says about itself, where an album showing
  // details holds it
  var details = (kind === 'photo' || kind === 'video') && !plain && await detailsHolder(env.DB, item.key);
  var detailsButton = details ? '<button class="ph-icon" type="button" id="ph-info-open" aria-haspopup="dialog" ' +
    'aria-controls="ph-info" aria-label="Details">' + INFO_ICON + '</button>' : '';
  var shareButton = '<button class="ph-icon" type="button" id="ph-share" aria-label="Share">' + SHARE_ICON + '</button>';
  var tight = kind === 'video' && !plain && (details || quest);
  var saveLink = link('ph-save' + (tight ? ' is-tight' : ''), save, DOWNLOAD_ICON + '<span>Download</span>', ' download');
  var buttons = saveLink + shareButton + detailsButton + questButton;
  var body: string;
  if (kind === 'pdf') {
    // PDF.js and the file start downloading with the page, not one after
    // the other once the script has run
    var pdfLib = site + '/assets/pdfjs';
    head += '<link rel="preconnect" href="' + escapeHtml(site) + '" crossorigin>' +
      '<link rel="modulepreload" href="' + escapeHtml(pdfLib + '/pdf.min.mjs') + '">' +
      '<link rel="preload" href="' + escapeHtml(open) + '" as="fetch" crossorigin="anonymous">';
    // the pages are drawn here by the site's PDF.js, a canvas each and
    // only near the screen, with the page's text laid over it unseen so
    // it can be selected and copied; Open hands the file to the browser's
    // own viewer
    body = '<main class="ph-reader" id="ph-reader">' +
      '<header class="ph-bar" id="ph-bar">' + homeLink(site, 'ph-home ph-mark', false) +
      '<span class="ph-title"' + (fileName ? ' title="' + escapeHtml(fileName) + '"' : '') + '><span class="ph-who">' + credit + '</span>' +
      '<span class="ph-meta">' + escapeHtml(['PDF', sizeText(item.bytes)].filter(Boolean).join(' · ')) + '</span></span>' +
      '<span class="ph-acts">' + link('ph-save', open, OPEN_ICON + '<span>Open</span>', ' target="_blank" rel="noopener"') + buttons + '</span></header>' +
      '<div class="ph-view" id="ph-view" tabindex="0" role="region" aria-label="Pages">' +
      '<div class="ph-pdf" id="ph-pdf" data-src="' + escapeHtml(open) + '" data-lib="' + escapeHtml(pdfLib) + '">' +
      '<p class="ph-note" id="ph-pdf-note">Loading…</p></div></div>' + PDF_TOOLS + '</main>';
    script = '<script>(function(){var box=document.getElementById("ph-pdf"),view=document.getElementById("ph-view");if(!box||!view)return;' +
      'function el(id){return document.getElementById(id);}' +
      'var lib=box.getAttribute("data-lib"),note=el("ph-pdf-note"),tools=el("ph-tools"),num=el("ph-at-n"),of=el("ph-of"),' +
      'zoom=el("ph-zoom"),zin=el("ph-in"),zout=el("ph-out"),fs=el("ph-fs"),fsBox=el("ph-fs-box"),bar=el("ph-bar"),reader=el("ph-reader"),' +
      'tuckable=window.matchMedia?matchMedia("(max-width: 760px), (pointer: coarse)"):null,lastY=0,mark=0,dir=0,tucked=false;' +
      // the bar steps out of the way of the pages on a phone or a tablet:
      // gone after 24px of scrolling down, back after 24px up or at the top
      'function tuck(on){if(on&&!(tuckable&&tuckable.matches))on=false;if(on===tucked)return;tucked=on;bar.classList.toggle("is-tucked",on);}' +
      'function settle(){lastY=mark=view.scrollTop;dir=0;}' +
      'function barFit(){reader.style.setProperty("--bar-h",bar.offsetHeight+"px");}' +
      'bar.addEventListener("focusin",function(){tuck(false);});barFit();' +
      // mode is auto (the page at its size, or narrower to fit), width,
      // page, or a scale where 1 is the page at 96 pixels an inch
      'var pdf=null,doc=null,pages=[],n=0,cur=1,mode="auto",w0=595,h0=842,later=0,PX=4/3,BUDGET=1e7,' +
      'STEPS=[0.25,0.5,0.75,1,1.25,1.5,2,3,4];' +
      // given up for now: Try again starts over, and so does the phone
      // coming back online
      'function fail(){note.textContent="This PDF could not be shown here. ";box.classList.add("is-failed");' +
      'var b=document.createElement("button");b.type="button";b.className="ph-save";b.textContent="Try again";' +
      'b.addEventListener("click",function(){tries=0;boot();});note.appendChild(b);}' +
      'function pad(){var s=getComputedStyle(view);return{t:parseFloat(s.paddingTop)||0,b:parseFloat(s.paddingBottom)||0,' +
      'x:(parseFloat(s.paddingLeft)||0)+(parseFloat(s.paddingRight)||0)};}' +
      'function room(){var p=pad();return{w:Math.max(80,view.clientWidth-p.x),h:Math.max(80,view.clientHeight-p.t-p.b)};}' +
      'function fitW(r){return r.w/(w0*PX);}' +
      'function fitted(){return mode==="auto"||mode==="width"||mode==="page";}' +
      'function scale(r){var f=fitW(r);if(mode==="width")return f;if(mode==="page")return Math.min(f,r.h/(h0*PX));' +
      'if(mode==="auto")return Math.min(1,f);return mode;}' +
      // a fitted page never runs wider than the view; the page's text
      // follows its width through --scale-factor
      'function place(h,s,r){var pw=h.pw||w0,ph=h.ph||h0,w=pw*PX*s;if(fitted()&&w>r.w)w=r.w;' +
      'h.style.width=w.toFixed(2)+"px";h.style.height=(w*ph/pw).toFixed(2)+"px";h.style.setProperty("--scale-factor",(w/pw).toFixed(5));}' +
      'function layout(){var r=room(),s=scale(r);for(var i=0;i<pages.length;i++)place(pages[i],s,r);showZoom(r);' +
      'zout.disabled=!(s>STEPS[0]+0.001);zin.disabled=!(s<STEPS[STEPS.length-1]-0.001);}' +
      // a scale a pinch left between the menu's own is shown as an option
      // of its own at the top of the menu
      'function showZoom(r){var v=mode==="auto"?(fitW(r)<1?"width":"1"):String(mode),own=zoom.querySelector("[data-pinch]"),known=false;' +
      'for(var i=0;i<zoom.options.length;i++)if(zoom.options[i]!==own&&zoom.options[i].value===v)known=true;' +
      'if(known){if(own)zoom.removeChild(own);}else{if(!own){own=document.createElement("option");own.setAttribute("data-pinch","");' +
      'zoom.insertBefore(own,zoom.firstChild);}own.value=v;own.textContent=Math.round(mode*100)+"%";}zoom.value=v;}' +
      // a page is drawn when it comes near the screen and let go again
      // when it is far off, so a long file does not hold every page at
      // once; a canvas is held to BUDGET pixels however far it is zoomed
      'function paint(h){var t=h.ticket=(h.ticket||0)+1;h.want=h.offsetWidth;if(h.task){h.task.cancel();h.task=null;}' +
      'doc.getPage(Number(h.getAttribute("data-n"))).then(function(page){if(h.ticket!==t||!h.drawn)return;' +
      'var one=page.getViewport({scale:1});' +
      'if(!h.pw){h.pw=one.width;h.ph=one.height;var r=room();place(h,scale(r),r);}' +
      'var w=h.want=h.offsetWidth,px=Math.min(w*(window.devicePixelRatio||1),Math.sqrt(BUDGET*one.width/one.height));' +
      'var vp=page.getViewport({scale:px/one.width}),c=document.createElement("canvas");c.width=Math.floor(vp.width);c.height=Math.floor(vp.height);' +
      'var task=h.task=page.render({canvasContext:c.getContext("2d"),viewport:vp});' +
      'return task.promise.then(function(){if(h.task===task)h.task=null;if(h.ticket!==t||!h.drawn){c.width=0;c.height=0;return;}' +
      'var old=h.querySelector("canvas");if(old){old.width=0;old.height=0;h.removeChild(old);}h.insertBefore(c,h.firstChild);' +
      'if(!h.links){h.links=true;links(h,page,one);}' +
      'if(h.text||!pdf.TextLayer)return;var tl=document.createElement("div");tl.className="textLayer";h.appendChild(tl);h.text=tl;' +
      'h.layer=new pdf.TextLayer({textContentSource:page.streamTextContent(),container:tl,viewport:one});h.layer.render().catch(function(){});});' +
      // a page that failed to arrive is asked for again while it is near
      // the screen, a little later each time
      '}).then(function(){if(h.ticket===t)h.tries=0;}).catch(function(){if(h.ticket!==t)return;h.drawn=false;h.tries=(h.tries||0)+1;' +
      'if(h.tries<7)setTimeout(function(){if(h.near&&!h.drawn)draw(h);},Math.min(8000,400*Math.pow(2,h.tries-1)));});}' +
      // a page's links, laid over it where the PDF puts them, sized in
      // shares of the page so a zoom carries them: a web address opens in
      // a new tab without this page's address, a place in the document
      // scrolls there
      'function links(h,page,one){var life=h.life;page.getAnnotations({intent:"display"}).then(function(list){if(h.life!==life||!h.drawn)return;' +
      'var lay=null;list.forEach(function(a){if(a.subtype!=="Link")return;' +
      'var url=typeof a.url==="string"&&/^(https?:|mailto:|tel:)/i.test(a.url)?a.url:"";if(!url&&!a.dest)return;' +
      'var q=one.convertToViewportRectangle(a.rect),el=document.createElement("a");' +
      'el.style.left=(100*Math.min(q[0],q[2])/one.width)+"%";el.style.top=(100*Math.min(q[1],q[3])/one.height)+"%";' +
      'el.style.width=(100*Math.abs(q[2]-q[0])/one.width)+"%";el.style.height=(100*Math.abs(q[3]-q[1])/one.height)+"%";' +
      'if(url){el.href=url;el.title=url;el.setAttribute("aria-label",url);if(/^https?:/i.test(url)){el.target="_blank";el.rel="noopener noreferrer";}}' +
      'else{el.href="#";el.setAttribute("aria-label","Go to another page");' +
      'el.addEventListener("click",function(e){e.preventDefault();toDest(a.dest);});' +
      'where(a.dest).then(function(d){if(d)el.setAttribute("aria-label","Go to page "+d.n);});}' +
      'if(!lay){lay=document.createElement("div");lay.className="ph-links";h.appendChild(lay);}lay.appendChild(el);});' +
      '}).catch(function(){});}' +
      // a destination is a name or [page, how, ...], the page a reference
      // or an index; XYZ and FitH say how far down the page as well
      'function where(dest){return Promise.resolve(typeof dest==="string"?doc.getDestination(dest):dest).then(function(d){' +
      'if(!Array.isArray(d)||!d.length)return null;var ref=d[0];' +
      'return Promise.resolve(typeof ref==="number"?ref:doc.getPageIndex(ref)).then(function(i){var how=d[1]&&d[1].name,' +
      'top=how==="XYZ"?d[3]:how==="FitH"||how==="FitBH"?d[2]:null;return{n:i+1,top:typeof top==="number"?top:null};});' +
      '}).catch(function(){return null;});}' +
      // the place lands 16px below the bar, or below the top where the bar
      // tucks away
      'function toDest(dest){where(dest).then(function(d){if(!d||d.n<1||d.n>n)return;if(d.top===null)return jump(d.n);' +
      'var h=pages[d.n-1],ph=h.ph||h0,y=h.offsetTop+Math.min(1,Math.max(0,(ph-d.top)/ph))*h.offsetHeight,b=bar.offsetHeight,' +
      'hide=!!(tuckable&&tuckable.matches&&y>b+pad().t);tuck(hide);cur=d.n;num.value=d.n;view.scrollTop=y-(hide?16:b+16);settle();});}' +
      'function draw(h){if(h.drawn||!doc)return;h.drawn=true;paint(h);}' +
      'function drop(h){if(!h.drawn)return;h.drawn=false;h.ticket=(h.ticket||0)+1;h.want=0;if(h.task){h.task.cancel();h.task=null;}' +
      'h.life=(h.life||0)+1;if(h.links){h.links=false;var l=h.querySelector(".ph-links");if(l)h.removeChild(l);}' +
      'var c=h.querySelector("canvas");if(c){c.width=0;c.height=0;h.removeChild(c);}' +
      'if(h.layer){try{h.layer.cancel();}catch(e){}h.layer=null;}if(h.text){h.removeChild(h.text);h.text=null;}}' +
      // pages drawn at another size are drawn again once the zoom settles,
      // the old picture stretched over the gap meanwhile
      'function repaint(){clearTimeout(later);later=setTimeout(function(){pages.forEach(function(h){' +
      'if(h.drawn&&Math.abs((h.want||0)-h.offsetWidth)>1)paint(h);});},150);}' +
      // the page at a third of the way down the view is the one being read,
      // and stays where it was through a change of zoom
      'function which(){if(!pages.length)return 1;if(view.scrollTop>0&&view.scrollTop+view.clientHeight>=view.scrollHeight-2)return n;' +
      'var y=view.scrollTop+view.clientHeight*0.35,lo=0,hi=pages.length-1;' +
      'while(lo<hi){var mid=(lo+hi+1)>>1;if(pages[mid].offsetTop<=y)lo=mid;else hi=mid-1;}return lo+1;}' +
      'function setZoom(m){var p=pages[cur-1],frac=p?(view.scrollTop-p.offsetTop)/Math.max(1,p.offsetHeight):0,' +
      'cx=(view.scrollLeft+view.clientWidth/2)/Math.max(1,view.scrollWidth);mode=m;layout();' +
      'if(p)view.scrollTop=p.offsetTop+frac*p.offsetHeight;view.scrollLeft=cx*view.scrollWidth-view.clientWidth/2;settle();repaint();}' +
      'function step(d){var s=scale(room()),i;if(d>0){for(i=0;i<STEPS.length;i++)if(STEPS[i]>s+0.001)return setZoom(STEPS[i]);}' +
      'else{for(i=STEPS.length-1;i>=0;i--)if(STEPS[i]<s-0.001)return setZoom(STEPS[i]);}}' +
      // a page jumped to sits under the bar, or at the top with the bar
      // tucked away where it tucks
      'function jump(v){v=Math.min(n,Math.max(1,v));cur=v;num.value=v;var top=pages[v-1].offsetTop,t=pad().t,b=bar.offsetHeight,' +
      'hide=!!(tuckable&&tuckable.matches&&top-t>b);tuck(hide);view.scrollTop=top-(hide?t-b:t);settle();}' +
      'function go(){var v=parseInt(num.value,10);jump(v>=1?v:cur);}' +
      'var ticking=false;view.addEventListener("scroll",function(){if(ticking)return;ticking=true;requestAnimationFrame(function(){' +
      'ticking=false;var c=which();if(c!==cur){cur=c;if(document.activeElement!==num)num.value=c;}' +
      'var y=view.scrollTop,d=y-lastY;if(y<=bar.offsetHeight)tuck(false);' +
      'else if(d){var nd=d>0?1:-1;if(nd!==dir){dir=nd;mark=lastY;}if(y-mark>24)tuck(true);else if(mark-y>24)tuck(false);}lastY=y;' +
      '});},{passive:true});' +
      'num.addEventListener("focus",function(){num.select();});' +
      'num.addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();go();num.select();}' +
      'else if(e.key==="Escape"){num.value=cur;num.blur();}});' +
      'num.addEventListener("change",go);num.addEventListener("blur",function(){num.value=cur;});' +
      'zoom.addEventListener("change",function(){var v=zoom.value;setZoom(v==="width"||v==="page"?v:Number(v));});' +
      'zin.addEventListener("click",function(){step(1);});zout.addEventListener("click",function(){step(-1);});' +
      // the keys every PDF viewer takes for its own zoom
      'document.addEventListener("keydown",function(e){if(!pages.length||!(e.ctrlKey||e.metaKey)||e.altKey)return;var k=e.key;' +
      'if(k==="="||k==="+"){e.preventDefault();step(1);}else if(k==="-"||k==="_"){e.preventDefault();step(-1);}' +
      'else if(k==="0"){e.preventDefault();setZoom("auto");}});' +
      // A pinch, with two fingers or on a trackpad, zooms to any scale the
      // menu runs between. While it lasts the pages are only scaled as a
      // picture, about the point between the fingers, and moved with
      // them; on letting go they are laid out at that scale and the point
      // of the page that was between the fingers is put back under them
      'var live=null,liveEnd=0;' +
      'function pageAt(y){var lo=0,hi=pages.length-1;while(lo<hi){var mid=(lo+hi+1)>>1;if(pages[mid].offsetTop<=y)lo=mid;else hi=mid-1;}return pages[lo];}' +
      'function pinchStart(cx,cy){var r=view.getBoundingClientRect(),x=view.scrollLeft+cx-r.left,y=view.scrollTop+cy-r.top,p=pageAt(y),s=scale(room());' +
      'live={s0:s,s:s,p:p,fx:(x-p.offsetLeft)/p.offsetWidth,fy:(y-p.offsetTop)/p.offsetHeight,x0:cx,y0:cy,cx:cx,cy:cy};' +
      'box.style.transformOrigin=(x-box.offsetLeft)+"px "+(y-box.offsetTop)+"px";box.style.willChange="transform";}' +
      'function pinchTo(s,cx,cy){s=Math.min(STEPS[STEPS.length-1],Math.max(STEPS[0],s));live.s=s;live.cx=cx;live.cy=cy;' +
      'box.style.transform="translate("+(cx-live.x0)+"px,"+(cy-live.y0)+"px) scale("+(s/live.s0)+")";}' +
      'function pinchEnd(m){var L=live;if(!L)return;live=null;box.style.transform="";box.style.transformOrigin="";box.style.willChange="";' +
      'box.style.transition="";mode=m!==undefined?m:Math.round(L.s*100)/100;layout();var r=view.getBoundingClientRect(),p=L.p;' +
      'view.scrollLeft=p.offsetLeft+L.fx*p.offsetWidth-(L.cx-r.left);view.scrollTop=p.offsetTop+L.fy*p.offsetHeight-(L.cy-r.top);' +
      'cur=which();num.value=cur;settle();repaint();}' +
      'var gap=0;function apart(t){return Math.hypot(t[0].clientX-t[1].clientX,t[0].clientY-t[1].clientY)||1;}' +
      'view.addEventListener("touchstart",function(e){if(e.touches.length!==2||!pages.length)return;if(live)pinchEnd();' +
      'gap=apart(e.touches);pinchStart((e.touches[0].clientX+e.touches[1].clientX)/2,(e.touches[0].clientY+e.touches[1].clientY)/2);},{passive:true});' +
      'view.addEventListener("touchmove",function(e){if(!live||!gap||e.touches.length<2)return;if(e.cancelable)e.preventDefault();' +
      'pinchTo(live.s0*apart(e.touches)/gap,(e.touches[0].clientX+e.touches[1].clientX)/2,(e.touches[0].clientY+e.touches[1].clientY)/2);},{passive:false});' +
      'var lift=function(e){if(gap&&e.touches.length<2){gap=0;pinchEnd();}};' +
      'view.addEventListener("touchend",lift);view.addEventListener("touchcancel",lift);' +
      // Safari zooms the whole page on a pinch unless told not to
      'document.addEventListener("gesturestart",function(e){e.preventDefault();});' +
      // A double tap on the pages, which the browser no longer takes, zooms
      // them to twice the fitted size about the tap, and back out from
      // there or further in; on a link it is a tap on the link
      'var tapAt=0,tapX=0,tapY=0,downX=0,downY=0,downAt=0,many=false,still=window.matchMedia&&matchMedia("(prefers-reduced-motion: reduce)");' +
      'function twice(x,y){var r=room(),f=Math.min(1,fitW(r)),s=scale(r),m,to;' +
      'if(s<f*1.5){to=Math.min(STEPS[STEPS.length-1],f*2);m=Math.round(to*100)/100;}else{m="auto";to=f;}' +
      'pinchStart(x,y);if(still&&still.matches){pinchEnd(m);return;}' +
      'box.style.transition="transform 250ms cubic-bezier(0.22,1,0.36,1)";pinchTo(to,x,y);' +
      'clearTimeout(liveEnd);liveEnd=setTimeout(function(){pinchEnd(m);},260);}' +
      'view.addEventListener("touchstart",function(e){many=e.touches.length>1;if(many)return;' +
      'downX=e.touches[0].clientX;downY=e.touches[0].clientY;downAt=Date.now();},{passive:true});' +
      'view.addEventListener("touchend",function(e){if(many||e.touches.length||!pages.length||live)return;var t=e.changedTouches[0],now=Date.now();' +
      'if(now-downAt>300||Math.abs(t.clientX-downX)>10||Math.abs(t.clientY-downY)>10||(e.target.closest&&e.target.closest("a"))){tapAt=0;return;}' +
      'if(now-tapAt<300&&Math.abs(t.clientX-tapX)<30&&Math.abs(t.clientY-tapY)<30){tapAt=0;if(e.cancelable)e.preventDefault();twice(t.clientX,t.clientY);return;}' +
      'tapAt=now;tapX=t.clientX;tapY=t.clientY;});' +
      // a trackpad pinch arrives as the wheel with Ctrl held, and so does
      // Ctrl and a mouse wheel, a notch at a time; laid out once it stops
      'view.addEventListener("wheel",function(e){if(!e.ctrlKey||!pages.length)return;e.preventDefault();' +
      'if(!live)pinchStart(e.clientX,e.clientY);var d=e.deltaY*(e.deltaMode===1?16:1);d=Math.max(-25,Math.min(25,d));' +
      'pinchTo(live.s*Math.exp(-d/100),live.x0,live.y0);clearTimeout(liveEnd);liveEnd=setTimeout(pinchEnd,200);},{passive:false});' +
      // full screen where the browser has it for a page (not an iPhone)
      'var root=document.documentElement,ask=root.requestFullscreen||root.webkitRequestFullscreen,' +
      'quit=document.exitFullscreen||document.webkitExitFullscreen;' +
      'function full(){return !!(document.fullscreenElement||document.webkitFullscreenElement);}' +
      'if(ask&&quit&&(document.fullscreenEnabled||document.webkitFullscreenEnabled)){fsBox.hidden=false;' +
      'fs.addEventListener("click",function(){var r=full()?quit.call(document):ask.call(root);if(r&&r.catch)r.catch(function(){});});' +
      'var changed=function(){var on=full();root.classList.toggle("is-full",on);fs.setAttribute("aria-label",on?"Exit full screen":"Full screen");};' +
      'document.addEventListener("fullscreenchange",changed);document.addEventListener("webkitfullscreenchange",changed);}' +
      // a phone's keyboard opening for the page box is not a new size to fit
      'var resized=function(){barFit();if(!tuckable||!tuckable.matches)tuck(false);if(pages.length&&document.activeElement!==num)setZoom(mode);};' +
      'if(window.ResizeObserver){var ro=new ResizeObserver(resized);ro.observe(view);ro.observe(bar);}else window.addEventListener("resize",resized);' +
      // The worker comes from the site, so it starts from a blob here that
      // imports it, and before the library so the two download together.
      // Any of the three downloads failing starts the lot again, a little
      // later each time. What has already arrived is kept, and a module
      // that failed is asked for under a new address, since a browser may
      // keep a module's failure
      'var tries=0,run=0,port=null,job=null,libQ=0,workQ=0;' +
      'function stop(){try{if(job)job.destroy();}catch(e){}try{if(port)port.terminate();}catch(e){}job=null;port=null;}' +
      'function again(){stop();tries++;if(tries>6){fail();return;}' +
      'note.textContent="Trying again\u2026";setTimeout(boot,Math.min(8000,400*Math.pow(2,tries-1)));}' +
      'function boot(){var mine=++run,q=workQ?"?r="+workQ:"";stop();box.classList.remove("is-failed");' +
      'if(!tries)note.textContent="Loading\u2026";' +
      'try{port=new Worker(URL.createObjectURL(new Blob(["import \\""+lib+"/pdf.worker.min.mjs"+q+"\\";"],' +
      '{type:"text/javascript"})),{type:"module"});}catch(e){port=null;}' +
      'var broke=new Promise(function(yes,no){if(port)port.addEventListener("error",function(){if(mine===run)workQ++;no(new Error("worker"));});});' +
      'var got=pdf?Promise.resolve(pdf):import(lib+"/pdf.min.mjs"+(libQ?"?r="+libQ:"")).catch(function(e){libQ++;throw e;});' +
      'Promise.race([broke,got.then(function(m){pdf=m;' +
      'if(port)m.GlobalWorkerOptions.workerPort=port;else m.GlobalWorkerOptions.workerSrc=lib+"/pdf.worker.min.mjs"+q;' +
      'job=m.getDocument({url:box.getAttribute("data-src"),isEvalSupported:false});return job.promise;' +
      '}).then(function(d){return d.getPage(1).then(function(first){return[d,first];});})]).then(function(got){' +
      'if(mine!==run)return;doc=got[0];var one=got[1].getViewport({scale:1});' +
      'w0=one.width;h0=one.height;n=doc.numPages;box.textContent="";of.textContent="/ "+n;num.style.width=Math.max(2,String(n).length)+"ch";' +
      'for(var i=1;i<=n;i++){var h=document.createElement("div");h.className="ph-page";h.setAttribute("data-n",i);' +
      'h.setAttribute("role","group");h.setAttribute("aria-label","Page "+i+" of "+n);box.appendChild(h);pages.push(h);}' +
      'pages[0].pw=w0;pages[0].ph=h0;tools.hidden=false;layout();' +
      'if(!("IntersectionObserver" in window)){pages.slice(0,8).forEach(function(h){h.near=true;draw(h);});return;}' +
      'var io=new IntersectionObserver(function(es){es.forEach(function(e){e.target.near=e.isIntersecting;' +
      'if(e.isIntersecting)draw(e.target);else drop(e.target);});},' +
      '{root:view,rootMargin:"1200px"});pages.forEach(function(h){io.observe(h);});' +
      '}).catch(function(){if(mine===run&&!doc)again();});}' +
      'window.addEventListener("online",function(){if(!doc&&box.classList.contains("is-failed")){tries=0;boot();}});' +
      'boot();})();</script>';
  } else if (kind === 'file') {
    body = '<main class="ph"><div class="ph-file">' +
      '<span class="ph-file-icon">' + FILE_ICON + '</span>' +
      (item.quest ? '<span class="ph-code">' + escapeHtml(item.quest) + '</span>' : '') +
      '<p class="ph-file-name">' + escapeHtml(fileName || 'File') + '</p>' +
      '<p class="ph-meta">' + escapeHtml([kindText(fileName, item.type), sizeText(item.bytes)].filter(Boolean).join(' · ')) + '</p>' +
      '<span class="ph-acts">' + buttons + '</span></div></main>';
  } else {
    var shape = item.w && item.h ? ' style="--ar:' + (item.w / item.h).toFixed(4) + '"' : '';
    body = '<main class="ph"><figure class="ph-fig"' + shape + '>' + media +
      '<figcaption class="ph-cap"><span class="ph-who">' + credit + '</span>' +
      '<span class="ph-acts"><span class="ph-size-slot" id="ph-size"></span>' + buttons +
      '</span></figcaption></figure></main>';
    // the figure takes the shape of what is in it once the file says
    script += '<script>(function(){var f=document.querySelector(".ph-fig");var m=f&&f.querySelector("img,video");' +
      'if(!m)return;function fit(){var w=m.videoWidth||m.naturalWidth,h=m.videoHeight||m.naturalHeight;' +
      'if(w&&h)f.style.setProperty("--ar",(w/h).toFixed(4));}' +
      'fit();m.addEventListener(m.tagName==="VIDEO"?"loadedmetadata":"load",fit);})();</script>';
  }
  // a PDF's bar carries the mark itself, to give its pages the height
  return new Response(sharePageHtml(head,
    LOAD_SCRIPT + (kind === 'pdf' ? '' : '<header class="ph-top">' + homeLink(site, 'ph-home', true) + '</header>') +
    body + (quest ? questPanel(quest) : '') + (details ? detailsPanel(api, site, item) : '') + SHARE_SCRIPT + script, site,
    kind === 'pdf' ? 'is-reader' : ''),
    { status: 200, headers: Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' }, VARY) });
}
