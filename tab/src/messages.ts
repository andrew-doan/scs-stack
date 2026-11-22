// Messages from the organisers, and the two version numbers the
// website polls.
//
// A message is a title, a markdown body and up to six attachments,
// written in the dashboard's Messages tab and read on the site's
// messages page. Attachments go into the same R2 bucket as proof
// files, under their own msg/ prefix, and are served by their keys:
// the random half of a key is the capability, exactly as it is for
// proof.
//
// The counters are two plain numbers, 'quests' and 'messages'. They
// only say that something changed, never what, so the site can ask for
// them every few seconds and decide for itself whether to refetch the
// quest list or the messages. A new message moves the messages number;
// any accepted quest write moves the quests number. Writes only move
// them forward; the dashboard's manual setter can move one either way,
// to put a number back where it belongs after a mistake, and the site
// follows any change, not only a rise.
//
// Urgency decides what posting does beyond putting the message on the
// page. A silent message moves nothing: it is there for whoever looks.
// A normal one moves the counter, which is what makes the site's bell
// mark itself. An urgent one does that and names itself in the pulse,
// so the site can put it in front of people until they dismiss it.
//
// Who reads a message is the same choice a quest has (access.ts):
// everyone, any team signed in, or the teams in chosen team groups; a
// draft is the organisers'. The public reads carry everyone's messages
// only, and a signed-in team asks /api/messages/team and
// /api/pulse/team for its own. The bell is per reader too: each
// message keeps a number from when it went up (seq), above every
// message's before it, and the pulse answers with the newest ones the
// reader can see, so a message for some teams lights nobody else's dot.

import { serveStoredFile, json, corsJson, cleanText, cleanBody, randomKey, normQuest, utcStamp, readStamp, animatedType, fileNameFor, isLinkPreview, deleteStored, errorMessage, isBlobLike, safeDecode } from './shared.ts';
import { sendAllPush, pushConfigured } from './push.ts';
import { discordApi, guildRows, botConfigured } from './discord.ts';
import { VISIBILITIES, messageSeenSql } from './access.ts';
import { flagValues, dateRules, afterPagesShut } from './recap.ts';
import { storePreview, bytesMatch, servePublicCopy } from './submit.ts';
import { writeBlock } from './photoserve.ts';
import { baseType } from './strip.ts';
import { can, guardByKey, guardRefusal, secondPasswordGiven } from './dash-access.ts';
import { readStaged, claimStaged, unclaimStaged, releaseStaged } from './staged.ts';
import { wantsPage, mediaPage, VARY, isMedia } from './sharepage.ts';
import type { StagedFile } from './staged.ts';
import type { AudienceRow, ConsoleSession, Ctx, CounterRow, DiscordGuildRow, Env, JsonBody, LogAction, MessageAudienceRow, MessageFileOut,
  MessageFileRow, MessageRow, MessagesPayload, PulsePayload, QuestGroupRow, QuestRow, Refusal, TeamRow, Viewer } from './types.ts';

// What a message says, for the Discord post.
interface MessageText {
  title: string;
  body: string;
}

// A file linked from the post.
type AttachedFile = Pick<MessageFileRow, 'key' | 'name'> & Partial<Pick<MessageFileRow, 'type'>>;

// A channel the post goes to, and the server it is in.
type PostTarget = Pick<DiscordGuildRow, 'guild_id' | 'name' | 'announce_channel_id'>;

var SITE_URL = 'https://scs.andyrew.space';

var MAX_FILES = 6;
var MAX_FILE_BYTES = 25 * 1024 * 1024;
var MAX_THUMB_BYTES = 300 * 1024;   // a browser-made preview, not a photo
var MAX_TITLE = 120;
var MAX_BODY = 8000;
var PUSH_SUMMARY = 120;             // how much of the body a notification carries
var DISCORD_LIMIT = 2000;           // Discord's own message length

export var COUNTERS = ['quests', 'messages'];
export var URGENCIES = ['silent', 'normal', 'urgent'];

// What a message may carry: pictures, and the documents an organiser
// would actually attach — a map as a PDF, a spreadsheet of times. The
// pictures are the three the stripper can take a location out of, for
// the reason slides.ts gives; WebP, HEIC and AVIF can all carry one.
var PICTURE_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif'];
var DOC_TYPES = [
  'application/pdf',
  'text/plain',
  'text/csv',
  'text/markdown',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation'
];

function typeAllowed(type: string): boolean {
  return PICTURE_TYPES.indexOf(type) !== -1 || DOC_TYPES.indexOf(type) !== -1;
}

// A line of its own reading [[quest:SQ40]] embeds that quest on the
// site. Discord and notifications cannot render the card, so before
// either reads the body the token becomes the quest's code and name —
// with a link to it for Discord, name alone for a notification. A key
// the table does not hold passes through as typed, still a working
// link. Matched like the site matches: by group key or any code.
var QUEST_TOKEN = /^[ \t]*\[\[quest:[ \t]*([^\]]+?)[ \t]*\]\][ \t]*$/gm;
export async function expandQuestTokens(db: D1Database, text: unknown, withLink: boolean): Promise<string> {
  var body = String(text == null ? '' : text);
  if (body.indexOf('[[quest:') === -1) return body;
  var names: Record<string, { key: string; name: string }> = {};
  try {
    var rows = await db.prepare(
      'SELECT g.key, g.name, q.code FROM quest_groups g LEFT JOIN quests q ON q.group_id = g.id'
    ).all<Pick<QuestGroupRow, 'key' | 'name'> & { code: QuestRow['code'] | null }>();
    rows.results.forEach(function (r) {
      var hit = { key: r.key, name: r.name };
      if (!names[normQuest(r.key)]) names[normQuest(r.key)] = hit;
      if (r.code && !names[normQuest(r.code)]) names[normQuest(r.code)] = hit;
    });
  } catch (err) { /* the token still reads as a link */ }
  return body.replace(QUEST_TOKEN, function (m: string, key: string) {
    var hit = names[normQuest(key)];
    var shown = hit ? hit.key + ' — ' + hit.name : key;
    if (!withLink) return shown;
    return shown + ': ' + SITE_URL + '/questlist/#' + encodeURIComponent(hit ? hit.key : key);
  });
}

// The body as a notification reads it: markdown marks taken off, links
// down to their words, everything on one line, cut at a word.
export function plainSummary(text: unknown, max: number): string {
  var flat = String(text == null ? '' : text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^[ \t]{0,3}>[ \t]?/gm, '')
    .replace(/^[ \t]{0,3}[-*+][ \t]+/gm, '')
    .replace(/[*_~]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= max) return flat;
  var cut = flat.slice(0, max - 1);
  var space = cut.lastIndexOf(' ');
  if (space > max / 2) cut = cut.slice(0, space);
  return cut + '…';
}

// ---------- counters ----------

// A read that fails gives zeros rather than an error: the pulse is the
// one call every page makes, and it has to answer whatever else is
// true.
export async function counterValues(db: D1Database): Promise<{ quests: number; messages: number }> {
  var out: { quests: number; messages: number } = { quests: 0, messages: 0 };
  try {
    var rows = await db.prepare('SELECT name, value FROM counters').all<CounterRow>();
    rows.results.forEach(function (r) {
      if (r.name === 'quests' || r.name === 'messages') out[r.name] = r.value;
    });
  } catch (err) { /* zeros */ }
  return out;
}

// One step forward, row created on demand. A failure here must not
// take the write it belongs to down with it, so it is swallowed the
// same way: the counter catches up on the next change.
export async function bumpCounter(db: D1Database, name: string): Promise<void> {
  try {
    await db.prepare(
      'INSERT INTO counters (name, value) VALUES (?1, 1) ' +
      'ON CONFLICT(name) DO UPDATE SET value = counters.value + 1'
    ).bind(name).run();
  } catch (err) { /* the write it belongs to still stands */ }
}

// A message going up moves the counter, and the value it moved to is
// written on the message in the same batch. The value is at least one
// above every seq already given, so a counter set back by hand cannot
// number a new message below an older one, which would leave the
// pulse's newest seq where it was and the urgent pick on the older
// message. It also comes here again when a live message turns urgent or
// an urgent one is unarchived: the restamp is what puts it in front of
// the site again. Silent ones never come here. A failure is swallowed
// as bumpCounter's is.
export async function bumpForMessage(db: D1Database, id: number): Promise<void> {
  try {
    await db.batch([
      db.prepare(
        "INSERT INTO counters (name, value) VALUES ('messages', (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages)) " +
        'ON CONFLICT(name) DO UPDATE SET value = MAX(counters.value + 1, excluded.value)'
      ),
      db.prepare("UPDATE messages SET seq = (SELECT value FROM counters WHERE name = 'messages') WHERE id = ?1").bind(id)
    ]);
  } catch (err) { /* the write it belongs to still stands */ }
}

// A query on messages m for one reader: nobody signed in (viewer null)
// or a team (viewerFor in access.ts), whose id is ?1.
function forReader(db: D1Database, sql: string, viewer: Viewer): D1PreparedStatement {
  var stmt = db.prepare(sql);
  return viewer ? stmt.bind(viewer.team_id) : stmt;
}

var SEQ_LIST = 50;

// GET /api/pulse (and /api/pulse/team for a signed-in team): the quests
// counter, the reader's messages version and the newest urgent message
// the reader can see, or 0 when there is none. The site fetches the
// message itself from the list it is allowed.
//
// `messages` is the newest seq among the messages the reader can see,
// and `message_seqs` the newest fifty of them, which is what the app
// icon's count is made from: messages the reader has not seen, rather
// than every change since, some of which were somebody else's.
//
// The urgent message named is the one that went live last, by seq, not
// the one written last: a scheduled or published draft, an edit to
// urgent and an unarchive all take a new seq, and an id fixed when the
// message was written would leave each of them behind an older one.
export async function pulsePayload(db: D1Database, viewer: Viewer): Promise<PulsePayload> {
  // four reads that do not depend on each other, asked together
  var read = await Promise.all([counterValues(db), flagValues(db), afterPagesShut(db), dateRules(db)]);
  var out: PulsePayload = Object.assign(read[0], { urgent: 0, team_pages: false, recap: false, replay: false, date_rules: [] as PulsePayload['date_rules'] });
  // the after-the-event switches ride here: the leaderboard learns
  // whether team names are links, and every page whether the recap and
  // the replay exist, from the read it makes anyway
  // the pages answer nothing while the tab is closed or frozen, so
  // nothing links to them then
  var flags = read[1];
  var open = !read[2];
  out.team_pages = open && flags.team_pages;
  out.recap = open && flags.recap;
  out.replay = open && flags.replay;
  // the days the site prints without their date
  out.date_rules = read[3];
  var from = ' FROM messages m WHERE m.hidden = 0 AND m.archived = 0 AND ' + messageSeenSql(viewer);
  try {
    var mine = await Promise.all([
      forReader(db, 'SELECT m.seq' + from + ' AND m.seq > 0 ORDER BY m.seq DESC LIMIT ' + SEQ_LIST, viewer).all<Pick<MessageRow, 'seq'>>(),
      forReader(db, 'SELECT m.id' + from + " AND m.urgency = 'urgent' ORDER BY m.seq DESC, m.id DESC LIMIT 1", viewer).first<Pick<MessageRow, 'id'>>()
    ]);
    var seqs = mine[0].results.map(function (r) { return r.seq; });
    out.messages = seqs.length ? seqs[0] : 0;
    out.message_seqs = seqs;
    var row = mine[1];
    if (row) out.urgent = row.id;
  } catch (err) { /* the pulse still answers, with the counter as the version */ }
  return out;
}

// ---------- messages written ahead of time ----------

// A message due to go up. An archived one is off the site whatever its
// time says, so it does not go up and takes no seq.
var DUE = "hidden = 1 AND archived = 0 AND publish_at != '' AND publish_at <= datetime('now')";

// A message can be given a time instead of a moment: it saves hidden,
// and the first public read after that time puts it on the site. A
// Worker has no clock of its own — nothing runs unless somebody asks
// it something — so the site polling the pulse is what moves these,
// which means one cheap SELECT before each of the two public reads.
//
// Nothing here may throw: it runs in front of the call every page
// makes, and a message that will not publish must not take the pulse
// down with it. Returns how many went up.
export async function publishDue(db: D1Database): Promise<number> {
  var due: Pick<MessageRow, 'id' | 'title' | 'urgency'>[];
  try {
    due = (await db.prepare(
      'SELECT id, title, urgency FROM messages WHERE ' + DUE + ' ORDER BY id LIMIT 20'
    ).all<Pick<MessageRow, 'id' | 'title' | 'urgency'>>()).results;
  } catch (err) {
    return 0; // the pulse still answers
  }
  if (!due.length) return 0;
  // The pulse is polled by many pages at once, and an organiser may move
  // a message back to drafts between the read above and this write, so
  // the write asks again and only the rows it changed are logged and
  // counted. The time comes off with the publish: a message put back
  // into drafts later must stay a draft, not publish itself again.
  var went: Pick<MessageRow, 'id' | 'title' | 'urgency'>[];
  try {
    went = (await db.prepare(
      "UPDATE messages SET hidden = 0, publish_at = '' WHERE id IN (SELECT value FROM json_each(?1)) AND " + DUE +
      ' RETURNING id, title, urgency'
    ).bind(JSON.stringify(due.map(function (m) { return m.id; }))).all<Pick<MessageRow, 'id' | 'title' | 'urgency'>>()).results;
  } catch (err) {
    return 0;
  }
  if (!went.length) return 0;
  try {
    await db.batch(went.map(function (m) {
      return db.prepare(
        'INSERT INTO submission_log (action, team_name, quest_code, points_delta, old_total, new_total, actor) ' +
        "VALUES ('message-publish', ?1, '-', 0, 0, 0, 'schedule')"
      ).bind(String(m.title || '').slice(0, 60));
    }));
  } catch (err) { /* the message is up either way */ }
  for (var i = 0; i < went.length; i++) {
    if (went[i].urgency !== 'silent') await bumpForMessage(db, went[i].id);
  }
  return went.length;
}

// ---------- public payloads ----------

// Every message's files in one query, newest message first, in the
// order they were attached. The console asks for the row ids too, so
// it can offer a Remove button per file; the public payload does not
// need them.
async function attachFiles(db: D1Database, rows: { id: number; files?: MessageFileOut[] }[], withIds: boolean): Promise<void> {
  if (!rows.length) return;
  var byId: Record<number, { files?: MessageFileOut[] }> = {};
  for (var i = 0; i < rows.length; i++) {
    rows[i].files = [];
    byId[rows[i].id] = rows[i];
  }
  // one JSON list, not a parameter per message: D1 takes at most 100
  // bound parameters, and the dashboard lists 200 messages
  var files = await db.prepare(
    'SELECT id, message_id, key, name, type, bytes FROM message_files ' +
    'WHERE message_id IN (SELECT value FROM json_each(?1)) ORDER BY sort, id'
  ).bind(JSON.stringify(rows.map(function (r) { return r.id; }))).all<Omit<MessageFileRow, 'sort'>>();
  files.results.forEach(function (f) {
    var row = byId[f.message_id];
    if (!row) return;
    var entry: MessageFileOut = { key: f.key, name: f.name, type: f.type, bytes: f.bytes };
    if (withIds) entry.id = f.id;
    (row.files as MessageFileOut[]).push(entry);
  });
}

// GET /api/messages: what the site shows, in the order it shows it —
// the array is the display order, so the page renders it as given.
// Drafts and archived messages never leave the dashboard. The body
// goes out as written; the site renders the markdown.
//
// The public list is everyone's messages; /api/messages/team adds what
// that team may read. Like the quest list, nothing in it says who else
// can see a message. Each carries its seq (0 for a silent one), so the
// site marks read exactly the messages it drew: the pulse is a separate
// cached read and may already name one this list does not have.
//
// The order is `sort` first, newest first within it. A message is
// posted with sort 0, so new ones sit above anything the reorder
// controls have placed by hand.
var PUBLIC_ORDER = 'ORDER BY sort, created_at DESC, id DESC';

export async function messagesPayload(db: D1Database, viewer: Viewer): Promise<MessagesPayload> {
  type Listed = MessagesPayload['messages'][number];
  var rows = await forReader(db,
    'SELECT m.id, m.title, m.body, m.created_at, m.urgency, m.seq FROM messages m ' +
    'WHERE m.hidden = 0 AND m.archived = 0 AND ' + messageSeenSql(viewer) + ' ' + PUBLIC_ORDER + ' LIMIT 100',
    viewer).all<Listed>();
  await attachFiles(db, rows.results, false);
  return { messages: rows.results };
}

// ---------- files ----------

// A message's attachments by their URLs. The key must exist in
// message_files, contents never change under a key, and Range passes
// through so a long video or a big PDF can be read in pieces.
// thumb=1 asks for the small copy the dashboard made; a file without
// one (a PDF, say) serves whole instead, and so does a GIF — its
// thumbnail is one frame of it, which is not the picture. So does a
// picture a link unfurler is asking for: the embed under a pasted
// link is what a channel sees.
export async function serveMessageFile(env: Env, request: Request, url: URL, keyFromPath?: string): Promise<Response> {
  if (!env.SUBMIT) return corsJson({ error: 'Attachments are not switched on.' }, 503);
  var key = keyFromPath || url.searchParams.get('key') || '';
  if (key.indexOf('msg/') !== 0) return corsJson({ error: 'not found' }, 404);
  var row = await env.DB.prepare('SELECT id, type, name, bytes FROM message_files WHERE key = ?1').bind(key).first<Pick<MessageFileRow, 'id' | 'type' | 'name' | 'bytes'>>();
  if (!row) return corsJson({ error: 'not found' }, 404);
  // a person opening the address gets the file's page
  if (wantsPage(request, url, { named: !!keyFromPath, media: isMedia(row.type) })) {
    return mediaPage(env, url, { key: key, type: row.type, name: row.name || 'attachment', bytes: row.bytes,
      base: '/api/messages/file/' + key.split('/').map(encodeURIComponent).join('/') + '/' });
  }
  // A link unfurler is answered with the whole picture rather than the
  // page's thumbnail — see isLinkPreview. The URL people copy out of a
  // page is the one in its img tag, which is the small copy.
  var whole = isLinkPreview(request) && String(row.type || '').indexOf('image/') === 0;
  var asked = !!url.searchParams.get('thumb');
  var cache = whole && asked ? 'private, no-store' : 'public, max-age=31536000, immutable';
  var cors: Record<string, string> = Object.assign({ 'access-control-allow-origin': '*' }, VARY);
  if (asked && !animatedType(row.type) && !whole) {
    var small = await serveStoredFile(env.SUBMIT, request, key + '.t', cache, cors);
    if (small) return small;
  }
  // An organiser's photo carries a location like anyone else's, and
  // this link goes out in a public Discord channel. It answers with the
  // metadata cut out; nothing here sends the original as it is.
  return (await servePublicCopy(env, request, key, row.type, cache, cors)) ||
    corsJson({ error: 'not found' }, 404);
}

// A file and everything kept beside it leave the bucket together. A
// bucket that has already lost them is not worth failing a delete over.
async function dropStored(env: Env, key: string): Promise<void> {
  await deleteStored(env.SUBMIT, key);
}

// ---------- dashboard ----------

// Everything, drafts and archived included, in the same order the site
// would use. The tab sorts the archived ones into their own view. Each
// carries who reads it, and the team groups come with the list, since
// an account with only the Messages tab never loads the Quests tab
// where they are made.
var LIST_COLUMNS = 'SELECT id, title, body, created_at, updated_at, hidden, archived, urgency, sort, publish_at';

export async function messagesList(env: Env): Promise<Response> {
  var db = env.DB;
  type Listed = Pick<MessageRow, 'id' | 'title' | 'body' | 'created_at' | 'updated_at' | 'hidden' | 'archived' | 'urgency' | 'sort' | 'publish_at' | 'visibility'> &
    { audiences?: number[]; files?: MessageFileOut[] };
  var rows = await db.prepare(LIST_COLUMNS + ', visibility FROM messages ' + PUBLIC_ORDER + ' LIMIT 200').all<Listed>();
  var byId: Record<number, Listed & { audiences: number[] }> = {};
  rows.results.forEach(function (m) {
    var listed = Object.assign(m, { audiences: [] as number[] });
    byId[m.id] = listed;
  });
  (await db.prepare('SELECT message_id, audience_id FROM message_audiences').all<MessageAudienceRow>()).results.forEach(function (r) {
    if (byId[r.message_id]) byId[r.message_id].audiences.push(r.audience_id);
  });
  var groups = (await db.prepare(
    'SELECT a.id, a.name, COUNT(at.team_id) AS teams FROM audiences a ' +
    'LEFT JOIN audience_teams at ON at.audience_id = a.id GROUP BY a.id ORDER BY a.name COLLATE NOCASE'
  ).all<Pick<AudienceRow, 'id' | 'name'> & { teams: number }>()).results;
  await attachFiles(db, rows.results, true);
  return json({ ok: true, messages: rows.results, team_groups: groups });
}

// Who a message is for, from the form: the visibility and, for team
// groups, the ids of groups that exist, each once.
async function cleanAudience(db: D1Database, form: FormData): Promise<{ who: string; audiences: number[] } | { error: string }> {
  var who = cleanText(form.get('visibility'), 10) || 'everyone';
  if (VISIBILITIES.indexOf(who) === -1) {
    return { error: 'Choose who can see it: everyone, signed-in teams or team groups.' };
  }
  if (who !== 'groups') return { who: who, audiences: [] };
  var known: Record<number, boolean> = {};
  (await db.prepare('SELECT id FROM audiences').all<Pick<AudienceRow, 'id'>>()).results.forEach(function (r) { known[r.id] = true; });
  var ids = String(form.get('audiences') || '').split(',').map(Number)
    .filter(function (id, i, list) { return known[id] && list.indexOf(id) === i; });
  if (!ids.length) return { error: 'Pick at least one team group, or choose another setting.' };
  return { who: who, audiences: ids };
}

// The teams a message reaches beyond the site, for the push and the
// Discord post: null for everyone, else a list of team ids (every team
// for signed-in teams, the groups' members for team groups).
async function audienceTeams(db: D1Database, who: string, audiences: number[]): Promise<number[] | null> {
  if (who === 'everyone') return null;
  if (who === 'teams') {
    return (await db.prepare('SELECT id FROM teams ORDER BY id').all<Pick<TeamRow, 'id'>>()).results.map(function (r) { return r.id; });
  }
  return (await db.prepare(
    'SELECT DISTINCT team_id FROM audience_teams WHERE audience_id IN (SELECT value FROM json_each(?1)) ORDER BY team_id'
  ).bind(JSON.stringify(audiences)).all<{ team_id: number }>()).results.map(function (r) { return r.team_id; });
}

// Post a new message or edit one. Multipart, because the attachments
// ride along: title, body, hidden, urgency, file0..file5 with an
// optional thumb0..thumb5 beside each, the push tick with its own
// password, and the Discord tick. In place of file<i> the page may send
// staged<i>, the id of a file it sent straight to R2 (src/staged.ts),
// which is already under its key with its first bytes checked.
//
// Everything is checked before anything is written — the push password
// included. A refused push means nothing was saved, which is the whole
// point of ticking the box: the announcement and the message are one
// action, not two.
export async function saveMessage(env: Env, session: ConsoleSession, request: Request, ctx: Ctx, logAction: LogAction): Promise<Response> {
  var form;
  try { form = await request.formData(); } catch (err) {
    return json({ error: 'expected a multipart form' }, 400);
  }

  var id = Number(form.get('id')) || 0;
  var title = cleanText(form.get('title'), MAX_TITLE);
  if (!title) return json({ error: 'The message needs a title.' }, 400);
  var body = cleanBody(form.get('body'), MAX_BODY);
  var hidden = String(form.get('hidden') || '') === '1' ? 1 : 0;
  var urgency = cleanText(form.get('urgency'), 10) || 'normal';
  if (URGENCIES.indexOf(urgency) === -1) {
    return json({ error: 'Urgency must be silent, normal or urgent.' }, 400);
  }
  // A time on the message means it publishes itself later, so it is
  // saved as a draft whatever the draft tick says. A time already past
  // is a message being posted now.
  var publishAt = readStamp(form.get('publish_at'));
  if (publishAt === null) {
    return json({ error: 'Publish at must be a time like 2026-10-20 14:30 (UTC).' }, 400);
  }
  var scheduled = !!publishAt && publishAt > utcStamp();
  if (scheduled) hidden = 1;
  else publishAt = '';
  // A past time puts the message in the list as if it had been posted
  // then: it moves no counter, so no bell dot and no pop-up, and is
  // never pushed or posted to Discord. Empty on an edit keeps the date.
  var postedAt = readStamp(form.get('posted_at'));
  if (postedAt === null) {
    return json({ error: 'Posted at must be a time like 2026-10-20 14:30 (UTC).' }, 400);
  }
  if (postedAt && postedAt > utcStamp(new Date(Date.now() + 5 * 60000))) {
    return json({ error: 'Posted at is for a time already past. Publish at puts a message up later.' }, 400);
  }
  if (postedAt && scheduled) {
    return json({ error: 'A message can have Posted at or Publish at, not both.' }, 400);
  }
  var backdated = !!postedAt;
  var cleaned = await cleanAudience(env.DB, form);
  if ('error' in cleaned) return json({ error: cleaned.error }, 400);
  var aud = cleaned;

  var existing = id
    ? await env.DB.prepare('SELECT id, title, hidden FROM messages WHERE id = ?1').bind(id).first<Pick<MessageRow, 'id' | 'title' | 'hidden'>>()
    : null;
  if (id && !existing) return json({ error: 'no such message' }, 404);

  // the scan runs past the cap on purpose: a send with too many files
  // is refused rather than quietly losing the ones over the line
  // a file sent in the form, or one sent straight to R2 described by its row
  type Sent = File | { name: string; type: string; size: number };
  var files: { file: Sent; thumb: File | string | null; staged: StagedFile | null }[] = [];
  for (var i = 0; i < MAX_FILES + 6; i++) {
    var staged: StagedFile | Refusal | null = null;
    var sent: Sent | string | null = form.get('file' + i);
    if (form.get('staged' + i)) {
      staged = await readStaged(env, session, form.get('staged' + i), 'msg');
      if ('error' in staged) return json({ error: staged.error }, staged.status);
      sent = { name: staged.name, type: staged.type, size: staged.bytes };
    } else if (!isBlobLike(sent)) {
      continue;
    }
    var type = baseType(sent.type);
    // with nothing staged, the file is the form's
    if (!typeAllowed(type) || (!staged && !(await bytesMatch(sent as File, type)))) {
      return json({ error: (sent.name || 'That file') + ' is not a JPEG, PNG or GIF, a PDF or a document.' }, 400);
    }
    if (sent.size > MAX_FILE_BYTES) {
      return json({ error: (sent.name || 'That file') + ' is over 25MB.' }, 413);
    }
    files.push({ file: sent, thumb: form.get('thumb' + i), staged: staged });
  }
  var held = existing
    ? (await env.DB.prepare('SELECT COUNT(*) AS n FROM message_files WHERE message_id = ?1').bind(existing.id).first<{ n: number }>() as { n: number }).n
    : 0;
  if (held + files.length > MAX_FILES) {
    return json({ error: 'A message carries at most ' + MAX_FILES + ' files.' }, 400);
  }
  if (files.length && !env.SUBMIT) {
    return json({ error: 'Attachments are not switched on (the worker has no SUBMIT bucket).' }, 503);
  }

  // A notification with it is a push like the Push tab's: the account
  // needs that tab, and the second password when sending a push asks
  // for it. Checked before anything is stored.
  var wantPush = !backdated && String(form.get('push') || '') === '1';
  if (wantPush) {
    if (scheduled) {
      return json({ error: 'A message with a time on it goes up on its own, without a notification. Post it now to announce it.' }, 400);
    }
    if (hidden) {
      return json({ error: 'A draft is not on the site yet, so there is nothing to announce.' }, 400);
    }
    if (!can(session, 'push')) {
      return json({ error: 'Your account cannot send push notifications.', no_access: true }, 403);
    }
    var refused = await guardRefusal(env, guardByKey('push'), secondPasswordGiven(request));
    if (refused) return refused;
    if (!pushConfigured(env)) {
      return json({ error: 'Push is not configured: generate VAPID keys first.' }, 403);
    }
  }

  // the files the page sent straight to R2 are this save's from here,
  // so a second save naming them is refused before anything is written
  var claims = files.map(function (f) { return f.staged; }).filter(function (s): s is StagedFile { return !!s; });
  var taken = await claimStaged(env, claims);
  if (taken) return json({ error: taken.error }, taken.status);

  var messageId: number = 0;
  // whether this save is what put the message on the site
  var published = !hidden && !existing;
  // whether it made a message already on the site urgent
  var turnedUrgent = false;
  var written: string[] = [];
  try {
    // Store attachments in R2 before inserting/updating DB rows so a
    // storage failure never leaves a live message missing its files.
    var prepared: { key: string; name: string; type: string; size: number; staged: StagedFile | null; sort: number }[] = [];
    for (var k = 0; k < files.length; k++) {
      var entry = files[k];
      var name = cleanText(entry.file.name, 120).replace(/[^\w. ()-]/g, '_') || 'file';
      var key: string;
      if (entry.staged) {
        key = entry.staged.key;
      } else {
        key = 'msg/' + randomKey(12);
        await env.SUBMIT.put(key, entry.file as File, { httpMetadata: { contentType: entry.file.type } });
        written.push(key);
        // the copy with the location taken out: what the page and the
        // Discord link both point at (see submit.ts)
        await writeBlock(env, key, entry.file.type, entry.file as File);
      }
      // the dashboard downscales pictures before sending, the same way
      // the submit page does; the preview sits beside the original under
      // the same key with .t added. A GIF gets none: a canvas can only
      // take one frame of it, and that still is never what should be
      // served, so there is no reason to keep it.
      if (!animatedType(entry.file.type)) await storePreview(env, key + '.t', entry.thumb, MAX_THUMB_BYTES);
      prepared.push({ key: key, name: name, type: entry.file.type, size: entry.file.size, staged: entry.staged, sort: held + k });
    }

    if (existing) {
      var edit = env.DB.prepare(
        'UPDATE messages SET title = ?2, body = ?3, hidden = ?4, urgency = ?5, publish_at = ?6, visibility = ?7, ' +
        "created_at = CASE WHEN ?8 != '' THEN ?8 ELSE created_at END, updated_at = datetime('now') WHERE id = ?1"
      ).bind(existing.id, title, body, hidden, urgency, publishAt, aud.who, postedAt);
      // A draft going live is decided by this write rather than by
      // the read above: publishDue may have put a scheduled one up
      // in between, and only one of the two may count it. A live
      // message turning urgent is decided the same way, before the
      // publish, so a draft published as urgent counts once.
      var steps = [edit];
      if (!hidden) {
        steps.unshift(env.DB.prepare('UPDATE messages SET hidden = 0 WHERE id = ?1 AND hidden = 1').bind(existing.id));
        if (urgency === 'urgent') {
          steps.unshift(env.DB.prepare(
            "UPDATE messages SET urgency = 'urgent' WHERE id = ?1 AND urgency != 'urgent' AND hidden = 0 AND archived = 0"
          ).bind(existing.id));
        }
      }
      var wrote = await env.DB.batch(steps);
      var changed = function (i: number) { return !!(wrote[i].meta && wrote[i].meta.changes); };
      turnedUrgent = !hidden && urgency === 'urgent' && changed(0);
      published = !hidden && changed(urgency === 'urgent' ? 1 : 0);
      messageId = existing.id;
    } else {
      var ins = await env.DB.prepare(
        'INSERT INTO messages (title, body, created_at, hidden, urgency, publish_at, visibility) ' +
        "VALUES (?1, ?2, CASE WHEN ?7 != '' THEN ?7 ELSE datetime('now') END, ?3, ?4, ?5, ?6)"
      ).bind(title, body, hidden, urgency, publishAt, aud.who, postedAt).run();
      messageId = ins.meta && ins.meta.last_row_id;
    }
    var rows: D1PreparedStatement[] = [env.DB.prepare('DELETE FROM message_audiences WHERE message_id = ?1').bind(messageId)];
    aud.audiences.forEach(function (aid) {
      rows.push(env.DB.prepare('INSERT OR IGNORE INTO message_audiences (message_id, audience_id) VALUES (?1, ?2)').bind(messageId, aid));
    });
    prepared.forEach(function (p) {
      rows.push(env.DB.prepare(
        'INSERT INTO message_files (message_id, key, name, type, bytes, sort) VALUES (?1, ?2, ?3, ?4, ?5, ?6)'
      ).bind(messageId, p.key, p.name, p.type, p.size, p.sort));
      if (p.staged) rows.push(releaseStaged(env, p.staged));
    });
    await env.DB.batch(rows);
  } catch (err) {
    await unclaimStaged(env, claims);
    await Promise.all(written.map(function (k) { return deleteStored(env.SUBMIT, k); }));
    throw err;
  }

  // The counter moves when there is something new to read: a message
  // posted, or a draft published. Silent moves nothing, which is what
  // silent means — it appears, and nothing goes looking for it. An
  // ordinary edit moves nothing either: the page has that one already.
  // A live message made urgent is the exception: it takes a new seq, as
  // a new message would, so the site puts it in front of people.
  if (!backdated && ((published && urgency !== 'silent') || turnedUrgent)) await bumpForMessage(env.DB, messageId);

  // A push and a Discord post reach the same readers the site does: a
  // message for some teams goes to those teams' phones and channels.
  var discordField = form.get('discord');
  var toDiscord = !existing && !hidden && !backdated && String(discordField == null ? '1' : discordField) !== '0';
  var teamIds = (wantPush || toDiscord) ? await audienceTeams(env.DB, aud.who, aud.audiences) : null;

  var pushed = null;
  if (wantPush) {
    pushed = await sendAllPush(env, {
      title: title,
      body: plainSummary(await expandQuestTokens(env.DB, body, false), PUSH_SUMMARY) || 'Open the messages page to read it.',
      url: '/messages/',
      tag: 'scs2-announce',
      renotify: true
    }, { urgency: 'high', topic: 'announce' }, teamIds);
  }

  // The cross-post is a new message only, and it happens after the
  // answer has gone back: a slow Discord must never hold up a save.
  if (toDiscord) {
    var stored = (await env.DB.prepare('SELECT key, name FROM message_files WHERE message_id = ?1 ORDER BY sort, id')
      .bind(messageId).all<Pick<MessageFileRow, 'key' | 'name'>>()).results;
    var work = crossPostMessage(env, new URL(request.url).origin, session.name,
      { title: title, body: body }, stored, logAction, teamIds);
    if (ctx && ctx.waitUntil) ctx.waitUntil(work);
    else await work;
  }

  await logAction(env.DB, session.name, existing ? 'message-edit' : 'message-post',
    title.slice(0, 60), aud.who === 'everyone' ? '-' : aud.who, 0, 0, 0);
  return json({
    ok: true, id: messageId, title: title, hidden: hidden, urgency: urgency,
    publish_at: publishAt, posted_at: postedAt, visibility: aud.who, audiences: aud.audiences, added: files.length, push: pushed
  });
}

// ---------- cross-posting to Discord ----------

// A message attachment's link, with the file's name on the end of the
// path. Discord works out whether a link is a picture from the URL's
// shape alone, and `?key=abc` with no extension is not one to it — so
// a cross-posted GIF arrived as a bare link instead of playing. The
// path form serves exactly the same bytes (the key is still the whole
// capability; the name is only there to be read), so pictures embed
// and GIFs animate. The ?key= form keeps working for everything
// already linked.
export function fileLink(origin: string, file: AttachedFile): string {
  return origin + '/api/messages/file/' + file.key.split('/').map(encodeURIComponent).join('/') +
    '/' + encodeURIComponent(fileNameFor(file.name, file.type));
}

// What the bot says in the announcement channel: the title in bold,
// the body as written (Discord renders markdown too), then a link per
// attachment. Discord takes 2000 characters, so it is cut to fit.
export function discordContent(origin: string, message: MessageText, files: AttachedFile[] | null | undefined): string {
  var parts = ['**' + message.title + '**'];
  if (message.body) parts.push(message.body);
  if (files && files.length) {
    parts.push(files.map(function (f) {
      return (f.name || 'file') + ': ' + fileLink(origin, f);
    }).join('\n'));
  }
  var content = parts.join('\n\n');
  return content.length > DISCORD_LIMIT ? content.slice(0, DISCORD_LIMIT - 1) + '…' : content;
}

// The team channels a message for some teams goes to: every enabled
// server where one of those teams has a channel, hidden teams left out
// as the bot leaves them out everywhere. An organiser ticked Post to
// Discord for this one, so a server's choice about automatic posts in
// team channels (reviews, points, check-ins) does not apply.
async function teamChannels(env: Env, teamIds: number[]): Promise<PostTarget[]> {
  if (!botConfigured(env) || !teamIds.length) return [];
  return (await env.DB.prepare(
    'SELECT g.guild_id, g.name, t.channel_id AS announce_channel_id FROM discord_teams t ' +
    'JOIN discord_guilds g ON g.guild_id = t.guild_id JOIN teams tm ON tm.id = t.team_id ' +
    'WHERE t.team_id IN (SELECT value FROM json_each(?1)) AND t.channel_id IS NOT NULL ' +
    "AND t.channel_id != '' AND g.enabled = 1 AND COALESCE(tm.hidden, 0) = 0 ORDER BY g.guild_id, t.team_id"
  ).bind(JSON.stringify(teamIds)).all<PostTarget>()).results;
}

// Every enabled server with an announcement channel gets the message,
// or, for a message some teams read (teamIds), those teams' own
// channels. Nothing here may throw: it runs after the response has
// gone, so a failure has nowhere to surface except the log, which is
// where it goes. Mentions are stripped — a message body is written for
// the site, and an @everyone that reads fine there should not ring a
// whole server.
export async function crossPostMessage(env: Env, origin: string, actor: string, message: MessageText, files: AttachedFile[], logAction: LogAction, teamIds: number[] | null): Promise<{ sent: number; failed: number }> {
  var out = { sent: 0, failed: 0 };
  try {
    var targets: PostTarget[] = Array.isArray(teamIds)
      ? await teamChannels(env, teamIds)
      : (await guildRows(env.DB, env)).filter(function (g) { return g.enabled && g.announce_channel_id; });
    if (!targets.length) return out;
    // Built from the hostname the public reads on, never from the one
    // this save happened to arrive on — an organiser posting from the
    // dashboard would otherwise put the dashboard's hostname on every
    // attachment link in a public channel.
    var base = String(env.PUBLIC_API || origin).replace(/\/+$/, '');
    var content = discordContent(base, {
      title: message.title,
      body: await expandQuestTokens(env.DB, message.body, true)
    }, files);
    var why = '';
    for (var i = 0; i < targets.length; i++) {
      var res = await discordApi(env, 'POST', '/channels/' + targets[i].announce_channel_id + '/messages', {
        content: content, allowed_mentions: { parse: [] }
      });
      if (res.ok) out.sent++;
      else { out.failed++; why = why || ((targets[i].name || targets[i].guild_id) + ': ' + res.why); }
    }
    await logAction(env.DB, actor, 'message-discord', message.title.slice(0, 50),
      out.failed ? why.slice(0, 60) : out.sent + ' channel' + (out.sent === 1 ? '' : 's'), 0, 0, 0);
  } catch (err) {
    try {
      await logAction(env.DB, actor, 'message-discord', message.title.slice(0, 50),
        String(errorMessage(err) ? errorMessage(err) : err).slice(0, 60), 0, 0, 0);
    } catch (also) { /* nothing left to try */ }
  }
  return out;
}

// ---------- archiving and order ----------

// Archiving takes a message off the site and out of the tab's main
// list without destroying it; unarchiving puts it back where its sort
// says it belongs. A live urgent message coming back takes a new seq,
// as a new one would, so the site puts it in front of people again;
// whether it came back is this write's to say, so two at once count it
// once.
export async function archiveMessage(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var msg = await env.DB.prepare('SELECT id, title, archived FROM messages WHERE id = ?1')
    .bind(Number(body.id) || 0).first<Pick<MessageRow, 'id' | 'title' | 'archived'>>();
  if (!msg) return json({ error: 'no such message' }, 404);
  var want = body.archived ? 1 : 0;
  var back = (await env.DB.prepare(
    'UPDATE messages SET archived = ?2 WHERE id = ?1 AND archived != ?2 RETURNING hidden, urgency'
  ).bind(msg.id, want).all<Pick<MessageRow, 'hidden' | 'urgency'>>()).results[0];
  if (!want && back && !back.hidden && back.urgency === 'urgent') await bumpForMessage(env.DB, msg.id);
  await logAction(env.DB, session.name, want ? 'message-archive' : 'message-unarchive',
    msg.title.slice(0, 60), '-', 0, 0, 0);
  return json({ ok: true, id: msg.id, archived: want });
}

// The whole visible list in the order the tab now shows it, written as
// sort 1, 2, 3 … A message posted afterwards keeps sort 0 and lands on
// top, which is what people expect of a new message.
export async function orderMessages(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var ids = Array.isArray(body.ids) ? body.ids.map(Number).filter(function (n) { return n > 0; }) : [];
  if (!ids.length) return json({ error: 'Send the messages in order.' }, 400);
  await env.DB.batch(ids.map(function (id, i) {
    return env.DB.prepare('UPDATE messages SET sort = ?2 WHERE id = ?1').bind(id, i + 1);
  }));
  await logAction(env.DB, session.name, 'message-order', ids.length + ' messages', '-', 0, 0, 0);
  return json({ ok: true, ordered: ids.length });
}

export async function deleteMessage(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var msg = await env.DB.prepare('SELECT id, title FROM messages WHERE id = ?1')
    .bind(Number(body.id) || 0).first<Pick<MessageRow, 'id' | 'title'>>();
  if (!msg) return json({ error: 'no such message' }, 404);
  var files = (await env.DB.prepare('SELECT key FROM message_files WHERE message_id = ?1')
    .bind(msg.id).all<Pick<MessageFileRow, 'key'>>()).results;
  for (var i = 0; i < files.length; i++) await dropStored(env, files[i].key);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM message_audiences WHERE message_id = ?1').bind(msg.id),
    env.DB.prepare('DELETE FROM message_files WHERE message_id = ?1').bind(msg.id),
    env.DB.prepare('DELETE FROM messages WHERE id = ?1').bind(msg.id)
  ]);
  await logAction(env.DB, session.name, 'message-delete', msg.title.slice(0, 60), '-', 0, 0, 0);
  return json({ ok: true, id: msg.id, files: files.length });
}

// One attachment off a message, bytes and preview with it.
export async function deleteMessageFile(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var row = await env.DB.prepare(
    'SELECT f.id, f.key, f.name, m.title FROM message_files f ' +
    'JOIN messages m ON m.id = f.message_id WHERE f.id = ?1'
  ).bind(Number(body.id) || 0).first<Pick<MessageFileRow, 'id' | 'key' | 'name'> & Pick<MessageRow, 'title'>>();
  if (!row) return json({ error: 'no such file' }, 404);
  await dropStored(env, row.key);
  await env.DB.prepare('DELETE FROM message_files WHERE id = ?1').bind(row.id).run();
  await logAction(env.DB, session.name, 'message-edit',
    row.title.slice(0, 50) + ' — removed ' + (row.name || 'a file'), '-', 0, 0, 0);
  return json({ ok: true, id: row.id });
}

export async function countersRead(env: Env): Promise<Response> {
  return json({ ok: true, counters: await counterValues(env.DB) });
}

// The one thing that may move a counter backwards. The site follows
// the quests number either way: a page that took a higher one takes the
// lower one as its own and fetches the list again, quietly, and from
// there a rise shows the update banner as usual. That is how a bad bump
// is undone. The messages number lights nothing by itself (the pulse
// reads the messages' seqs), and a message posted after it is lowered
// still takes a seq above every message before it.
export async function counterSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var name = String(body.name || '');
  if (COUNTERS.indexOf(name) === -1) {
    return json({ error: 'The counter must be quests or messages.' }, 400);
  }
  var value = Number(body.value);
  if (!isFinite(value) || value < 0 || value !== Math.round(value) || value > 1e9) {
    return json({ error: 'The value must be a whole number, zero or more.' }, 400);
  }
  await env.DB.prepare(
    'INSERT INTO counters (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = ?2'
  ).bind(name, value).run();
  await logAction(env.DB, session.name, 'counter-set', name + ' = ' + value, '-', 0, 0, 0);
  return json({ ok: true, counters: await counterValues(env.DB) });
}

// ---------- router: the one message path that is not a cached read ----------
// /api/messages itself is built in apiResponse with the other public
// payloads; the files need the bucket and the request, so they come
// through here.

export async function handleMessagesApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (request.method !== 'GET') return null;
  if (url.pathname === '/api/messages/file') return serveMessageFile(env, request, url);
  // /api/messages/file/msg/<key>/<name> — the same file at a path that
  // ends in its name, so Discord can tell a picture from a link. The
  // key between the two is what is checked; the name is ignored.
  var path = url.pathname.match(/^\/api\/messages\/file\/(msg\/[^/]+)\/[^/]*$/);
  if (path) {
    var decoded = safeDecode(path[1]);
    if (!decoded) return corsJson({ error: 'not found' }, 404);
    return serveMessageFile(env, request, url, decoded);
  }
  return null;
}
