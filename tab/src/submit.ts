// Web quest submissions — the site's /submit page talks to these
// endpoints. Teams sign in with their team name and a submit code
// (minted in the tab console and handed out by organisers), upload
// proof (photos and videos, or whatever kinds of file the quest takes,
// rules.ts), and watch their submissions move through review. The files land in R2 under random keys; review happens in
// the console, and an accepted submission scores through the ledger like
// everything else.
//
// These endpoints are called cross-origin from the website, so every
// response carries open CORS headers. The bearer session is the only
// credential, and it is the team's own.

import { normQuest, serveStoredFile, corsJson as json, json as plainJson, cleanText, configured, secretMatches, randomKey, bearerToken, delay, animatedType, isLinkPreview, settingValue, asDownload, DERIVED, deleteStored, isBlobLike, prop } from './shared.ts';
import { stripImage, imageMatches, pickedMatches, baseType, jpegOrientation, readExif, takenUtc } from './strip.ts';
import { serveCleanPhoto, metaBlock, writeBlock } from './photoserve.ts';
import { SUBMIT_KINDS, MAX_QUESTIONS, rulesForGroup, mysteryIds } from './quests.ts';
import { fileKindOf, storedTypeFor, documentMatches, kindsText, DEFAULT_FILE_KINDS } from './rules.ts';
import { rowVisibleTo } from './access.ts';
import { standings, lastPlace, showsPoints, bandsScore } from './tab.ts';
import { partsFor, creditWorth } from './parts.ts';
import { tabState } from './freeze.ts';
import { directReady, directStart, directPartUrl, directPutUrl, directAbort, directLanded, directJoin, directGetUrl, markDirect, isDirect as directMarked, directIdOf } from './r2direct.ts';
import { serveUploadedVideo, videoTakenAt } from './videostrip.ts';
import { wantsPage, viewedFile, mediaPage, VARY } from './sharepage.ts';
import { bumpCounter } from './messages.ts';
import { nameDeleted } from './deleted.ts';
import type { StagedFile } from './staged.ts';
import type { Answer, AnswerEntry, Credit, EncoderRow, Env, FileKind, JsonBody, MediaOut, QuestGroupRow, QuestRow, QuestRules,
  SubmissionFileRow, SubmissionRenditionRow, SubmissionRow, SubmissionUploadPartRow, TeamCodeRow, TeamRow } from './types.ts';
import type { Seeable } from './access.ts';

// A team signed in with its submit code (requireTeam).
export interface TeamSession {
  token: string;
  team_id: number;
  team_name: string;
}

// Which submission new file rows belong to: the team's newest, for a
// create writing the submission in the same batch, or one already there.
export interface Into {
  team?: number;
  submission?: number;
  claim?: string;
}

// When a file was taken, '' for one that does not say (recordTaken).
export interface Taken {
  key: string;
  taken: string;
}

// The type of the file a photo was picked as, kept beside it (recordPicked);
// `declared` when the page sends it after the slices.
export interface PickedNote {
  key: string;
  picked: string;
  declared?: boolean;
}

// One large file of a create's manifest, once it has been checked.
interface BigEntry {
  name?: unknown;
  type: string;
  size: number;
  picked?: unknown;
}

// A file still arriving in slices, as the upload calls read it. Every
// such row has its slice size and its upload's id.
type UploadRow = Pick<SubmissionFileRow, 'id' | 'r2_key' | 'content_type' | 'bytes' | 'name' | 'status' | 'submission_id'> &
  Pick<SubmissionRow, 'quest_code'> & { part_size: number; upload_id: string };

// A video as the encoder calls read it, from either table.
type EncoderFile = Pick<SubmissionFileRow, 'id' | 'r2_key' | 'name' | 'bytes' | 'content_type' | 'encode_state' | 'status'> &
  { tbl: string; team_name: string | null };

// Which copy the encoder is sending: a rendition's height, or the clean one.
interface Height {
  clean: boolean;
  height: number;
}

// One video waiting, as a poll lists it.
interface Job {
  key: string;
  name: string | null;
  bytes: number;
  type: string;
}

// What the dashboard shows of the encoders (encoderSummary).
interface EncoderSummary {
  ok: boolean;
  waiting: number;
  encoding: number;
  done: number;
  skipped: number;
  encoders: { name: string; online: boolean; last_seen: string; state: string; working_on: string; working_name: string; jobs_done: number; avg_ms: number }[];
}

var MAX_THUMB_BYTES = 300 * 1024; // a browser-made preview, not a photo
var MAX_VIEW_BYTES = 2 * 1024 * 1024; // a browser-made viewing copy of a photo
var MAX_FILE_BYTES = 48 * 1024 * 1024;   // sent whole in the create request
var MAX_TOTAL_BYTES = 90 * 1024 * 1024;  // under the Workers request cap
// How many of one team's submissions the reviewers see at once
// (settable on the Settings tab). A send past it is not refused: it is
// stored as `queued`, the team is told the tab has it, and
// `promoteQueued` moves the oldest one to pending each time a place
// frees. Refusing it, as this used to, stopped a team playing on a busy
// afternoon for as long as the reviewers were behind.
export var MAX_PENDING = 12;
// The queue's own ceiling, so a client stuck in a loop cannot fill the
// bucket. Well past anything a team sends by hand.
export var MAX_QUEUED = 40;
// Bigger files are registered at create time and sent afterwards in
// slices, so the request cap stops mattering: the submission reaches
// the tab team at once, its file rows say "uploading" until the last
// slice lands, and a broken upload resumes from the parts the worker
// already holds. R2 wants every part the same size except the last.
var PART_BYTES = 20 * 1024 * 1024;            // one slice
// a file the page sends straight to R2 (r2direct.ts)
function isDirect(row: Pick<SubmissionFileRow, 'upload_id'> | null | undefined): boolean { return !!row && directMarked(row.upload_id); }
function directId(row: Pick<SubmissionFileRow, 'upload_id'>): string { return directIdOf(row.upload_id); }
var MAX_BIG_BYTES = 4 * 1024 * 1024 * 1024;   // per large file
// a team's own reads are never cached: they are about that team only
var NO_STORE = { 'cache-control': 'no-store' };
// Video renditions: the heights the encoder makes, the ceiling on one
// upload, and how long a claim on a file lasts before another runner
// (or the same one, restarted) may take it.
export var RENDITION_HEIGHTS = [480, 720, 1080];
// What one request will take. A copy bigger than this is sent in
// slices instead (upload/start, upload/part, upload/finish), the same
// way the submit page sends a big file, so neither of these is a
// ceiling on what the encoder can send — only on how it travels.
var MAX_RENDITION_BYTES = 95 * 1024 * 1024;
var MAX_CLEAN_BYTES = 90 * 1024 * 1024;
var CLAIM_MINUTES = 15;

export async function requireTeam(request: Request, db: D1Database): Promise<TeamSession | null> {
  var token = bearerToken(request);
  if (!token) return null;
  return db.prepare(
    'SELECT s.token, s.team_id, t.name AS team_name FROM submit_sessions s ' +
    "JOIN teams t ON t.id = s.team_id WHERE s.token = ?1 AND s.expires_at > datetime('now')"
  ).bind(token).first<TeamSession>();
}

// A dashboard sign-in, for the reads organisers do from the site.
async function organiserSession(request: Request, db: D1Database): Promise<{ token: string } | null> {
  var token = bearerToken(request);
  if (!token) return null;
  return db.prepare(
    "SELECT token FROM console_sessions WHERE token = ?1 AND expires_at > datetime('now')"
  ).bind(token).first<{ token: string }>();
}

// ---------- handlers ----------

async function login(request: Request, env: Env): Promise<Response> {
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  var teamName = cleanText(body.team_name != null ? body.team_name : body.team, 80);
  var code = cleanText(body.code, 40);
  var team = teamName
    ? await env.DB.prepare('SELECT id, name FROM teams WHERE name = ?1 COLLATE NOCASE').bind(teamName).first<Pick<TeamRow, 'id' | 'name'>>()
    : null;
  var row = team
    ? await env.DB.prepare('SELECT code FROM team_codes WHERE team_id = ?1').bind(team.id).first<Pick<TeamCodeRow, 'code'>>()
    : null;
  if (!team || !row || !(await secretMatches(code, row.code))) {
    // one message for a wrong team, a wrong code, or a team without a
    // code yet — nothing to enumerate
    await delay(400);
    return json({ error: 'No match for that team and code.' }, 401);
  }
  var token = randomKey(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM submit_sessions WHERE expires_at < datetime('now')"),
    env.DB.prepare(
      "INSERT INTO submit_sessions (token, team_id, expires_at) VALUES (?1, ?2, datetime('now', '+24 hours'))"
    ).bind(token, team.id)
  ]);
  return json({ ok: true, session: token, team: team.name });
}

// one team's submissions not yet reviewed: those the reviewers see,
// and those queued behind them
async function waitingFor(db: D1Database, teamId: number): Promise<{ pending: number; queued: number }> {
  var r = await db.prepare(
    "SELECT COUNT(CASE WHEN status = 'pending' THEN 1 END) AS pending, " +
    "COUNT(CASE WHEN status = 'queued' THEN 1 END) AS queued FROM submissions WHERE team_id = ?1"
  ).bind(teamId).first<{ pending: number; queued: number }>();
  return { pending: Number(r && r.pending) || 0, queued: Number(r && r.queued) || 0 };
}

// Moves the oldest queued submissions to pending while their team has
// fewer than the cap waiting on review: one team's, or every team's
// (the scheduled run). One statement, so two callers at once cannot
// both fill the same place. Answers how many moved.
export async function promoteQueued(db: D1Database, teamId?: number | null, cap?: number | null): Promise<number> {
  if (cap == null) cap = await settingValue(db, 'submit_max_pending', MAX_PENDING);
  var one = teamId ? ' AND team_id = ?2' : '';
  var stmt = db.prepare(
    "UPDATE submissions SET status = 'pending' WHERE status = 'queued' AND id IN (" +
    'SELECT q.id FROM (SELECT id, team_id, ROW_NUMBER() OVER (PARTITION BY team_id ORDER BY id) AS rn ' +
    "FROM submissions WHERE status = 'queued'" + one + ') q ' +
    "LEFT JOIN (SELECT team_id, COUNT(*) AS n FROM submissions WHERE status = 'pending' GROUP BY team_id) p " +
    'ON p.team_id = q.team_id WHERE q.rn <= ?1 - COALESCE(p.n, 0))'
  );
  var res = await (teamId ? stmt.bind(cap, teamId) : stmt.bind(cap)).run();
  return (res && res.meta && res.meta.changes) || 0;
}

async function create(request: Request, env: Env, session: TeamSession): Promise<Response> {
  if (!env.SUBMIT) {
    return json({ error: 'Uploads are not switched on (the worker has no SUBMIT bucket).' }, 503);
  }
  // places freed since the last read go to what was already queued,
  // and a new one queues behind anything still there
  var maxPending = await settingValue(env.DB, 'submit_max_pending', MAX_PENDING);
  await promoteQueued(env.DB, session.team_id, maxPending);
  var waiting = await waitingFor(env.DB, session.team_id);
  var queue = waiting.pending >= maxPending || waiting.queued > 0;
  if (queue && waiting.queued >= MAX_QUEUED) {
    return json({ error: 'You have ' + (waiting.pending + waiting.queued) + ' submissions waiting on review. Wait for some to clear.' }, 429);
  }

  var form: FormData;
  try { form = await request.formData(); } catch (err) {
    return json({ error: 'expected a multipart form' }, 400);
  }
  var questCode = cleanText(form.get('quest'), 40);
  var note = cleanText(form.get('note'), 500);
  var quest = questCode
    ? await env.DB.prepare(
      'SELECT q.code, q.group_id, g.id, g.hidden, g.visibility FROM quests q LEFT JOIN quest_groups g ON g.id = q.group_id ' +
      'WHERE q.norm = ?1 AND q.hidden = 0'
    ).bind(normQuest(questCode)).first<Pick<QuestRow, 'code' | 'group_id'> & { id: number | null; hidden: number | null; visibility: string | null }>()
    : null;
  // a team can only send proof for a quest it can see; one it cannot is
  // answered as if there were no such quest
  // with a group, the group's columns are there
  if (quest && quest.group_id && !(await rowVisibleTo(env.DB, quest as Seeable & { id: number }, session.team_id))) quest = null;
  if (!quest) return json({ error: 'Pick a quest.' }, 400);
  var refused: { error?: string } = {};
  var answer = cleanAnswer(form.get('answer'), refused);
  if (answer === false) return json({ error: refused.error || 'That answer is not valid.' }, 400);
  // which kinds of file the quest takes, how many and whether one is
  // needed; a quest that takes none is sent with its answers alone
  var rules = (await rulesForGroup(env.DB, quest.group_id)).files;

  var files = form.getAll('files').filter(function (f): f is File { return isBlobLike(f); });
  // large files come as a manifest; their bytes follow in slices. With
  // `whole`, every file does, whatever its size: the page asked
  // upload/mode and was told to send them straight to R2
  var whole = form.get('whole') === '1';
  var direct = whole && directReady(env);
  var bigs: unknown[] = [];
  var bigRaw = form.get('bigfiles');
  if (bigRaw) {
    var listed: unknown;
    try { listed = JSON.parse(String(bigRaw).slice(0, 4000)); } catch (err) { listed = null; }
    if (!Array.isArray(listed)) return json({ error: 'bad large-file list' }, 400);
    bigs = listed;
  }
  if (whole && files.length) return json({ error: 'bad file list' }, 400);
  var counted = fileCountProblem(rules, files.length + bigs.length, true);
  if (counted) return json({ error: counted }, 400);
  if (bigs.length && !direct && (!env.SUBMIT || typeof env.SUBMIT.createMultipartUpload !== 'function')) {
    return json({ error: 'Large uploads are not switched on.' }, 503);
  }
  for (var b = 0; b < bigs.length; b++) {
    var bf = (bigs[b] || {}) as Record<string, unknown>;
    var bkind = proofKind(bf.type, bf.name);
    var bsize = Math.round(Number(bf.size) || 0);
    if ((rules.kinds as readonly string[]).indexOf(bkind) === -1) {
      return json({ error: (bf.name || 'A file') + ' is not ' + kindsText(rules.kinds) + '.' }, 400);
    }
    bf.type = storedTypeFor(bkind, bf.type);
    if (bsize < 1) return json({ error: (bf.name || 'A file') + ' is empty.' }, 400);
    if (bsize <= MAX_FILE_BYTES && !whole) return json({ error: (bf.name || 'A file') + ' is small enough to send directly.' }, 400);
    if (bsize > MAX_BIG_BYTES) return json({ error: (bf.name || 'A file') + ' is over 4GB. Compress it first.' }, 413);
    bf.size = bsize;
  }
  var problem = await proofFilesProblem(files, rules.kinds);
  if (problem) return json({ error: problem.error }, problem.status);

  var gallery = form.get('gallery') ? 1 : 0; // opt-in to the post-event gallery

  // The files go into the bucket first and the rows after, in one
  // transaction: the submission and every file row land together or
  // not at all. Written the other way round, a bucket that failed
  // part way left a pending submission with no proof in it, counting
  // against the team's limit, and the retry made a second one.
  var written: string[] = [];
  var started: { abort(): Promise<unknown> }[] = [];
  var rows: D1PreparedStatement[] = [];
  var bigRows: { name: string; size: number; key: string }[] = [];
  var taken: Taken[] = [];
  var picked: PickedNote[] = [];
  try {
    rows = await storeProofFiles(env, form, files, { team: session.team_id }, written, taken, picked);
    // each large file gets its row (visible to the tab team as
    // "uploading"), an R2 multipart upload, and its browser-made preview
    for (var k = 0; k < bigs.length; k++) {
      // checked and tidied above
      var big = bigs[k] as BigEntry;
      var bigName = cleanText(big.name, 120).replace(/[^\w. ()-]/g, '_') || 'proof';
      var bigKey = 'sub/' + randomKey(12);
      var uploadId: string;
      if (direct) {
        var rid = await directStart(env, bigKey, big.type);
        started.push({ abort: directAbort.bind(null, env, bigKey, rid) });
        uploadId = markDirect(rid);
      } else {
        var mp = await env.SUBMIT.createMultipartUpload(bigKey, { httpMetadata: { contentType: big.type } });
        started.push(mp);
        uploadId = mp.uploadId;
      }
      written.push.apply(written, DERIVED.map(function (s) { return bigKey + s; }));
      if (hasCopies(big.type)) {
        await storePreview(env, bigKey + '.t', form.get('bigthumb' + k), MAX_THUMB_BYTES);
        // a photo following the create brings its viewing copy along,
        // as one sent with it does
        await storePreview(env, bigKey + '.v', form.get('bigview' + k), MAX_VIEW_BYTES);
      }
      // and the file it was picked as: sent now when the slices come
      // through the worker, named here when they go straight to R2
      var twin = direct ? pickedDeclared(big, big.type, MAX_FILE_BYTES)
        : await storePicked(env, bigKey, big.type, form.get('bigpicked' + k), MAX_FILE_BYTES);
      if (twin) picked.push({ key: bigKey, picked: twin, declared: direct });
      bigRows.push({ name: bigName, size: big.size, key: bigKey });
      rows.push(env.DB.prepare(
        'INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name, status, upload_id, part_size) ' +
        "VALUES ((SELECT MAX(id) FROM submissions WHERE team_id = ?1), ?2, ?3, ?4, ?5, 'uploading', ?6, ?7)"
      ).bind(session.team_id, bigKey, big.type, big.size, bigName, uploadId, PART_BYTES));
    }
    // D1 runs a batch as one transaction with nothing between its
    // statements, so the newest submission of this team's inside it is
    // the one just inserted. Queued or pending is decided in the insert,
    // from the team's rows as they are then, so two sends at once cannot
    // both go past the cap
    var done = await env.DB.batch([env.DB.prepare(
      'INSERT INTO submissions (team_id, quest_code, note, gallery, answer, status) ' +
      "SELECT ?1, ?2, ?3, ?4, ?5, CASE WHEN EXISTS (SELECT 1 FROM submissions WHERE team_id = ?1 AND status = 'queued') " +
      "OR (SELECT COUNT(*) FROM submissions WHERE team_id = ?1 AND status = 'pending') >= ?6 THEN 'queued' ELSE 'pending' END"
    ).bind(session.team_id, quest.code, note || null, gallery, answer, maxPending)].concat(rows));
  } catch (err) {
    await discard(env, written, started);
    return json({ error: 'The files could not be stored, so nothing was sent. Try again.' }, 500);
  }
  var subId = done[0].meta && done[0].meta.last_row_id;
  // what the insert decided, and how many of the team's were queued
  // before it
  var landed = await env.DB.prepare(
    "SELECT status, (SELECT COUNT(*) FROM submissions WHERE team_id = ?2 AND status = 'queued' AND id < ?1) AS ahead FROM submissions WHERE id = ?1"
  ).bind(subId, session.team_id).first<Pick<SubmissionRow, 'status'> & { ahead: number }>();
  queue = !!landed && landed.status === 'queued';
  try { await recordTaken(env, taken); } catch (err) { /* the dashboard's tidy fills it in */ }
  // the page sends a file it named only when its row can say so
  var named = await recordPicked(env, picked);
  var uploads = bigRows.map(function (b, n) {
    var res = done[1 + files.length + n];
    var out: { file: number; name: string; size: number; part_size: number; direct: boolean; picked?: boolean } =
      { file: res.meta && res.meta.last_row_id, name: b.name, size: b.size, part_size: PART_BYTES, direct: direct };
    if (named && picked.some(function (p) { return p.key === b.key && p.declared; })) out.picked = true;
    return out;
  });

  return json({
    ok: true, id: subId, quest: quest.code, files: files.length + bigs.length, gallery: gallery, uploads: uploads,
    queued: queue, ahead: queue && landed ? Number(landed.ahead) || 0 : 0
  });
}

// The files sent whole in one request: each has to be a kind the quest
// takes (`kinds`, photos and videos when not given), its first bytes
// have to say so, and the sizes have to fit one request. Null when they
// pass, else the refusal.
export async function proofFilesProblem(files: File[], kinds?: readonly string[] | null): Promise<{ error: string; status: number } | null> {
  kinds = kinds || DEFAULT_FILE_KINDS;
  var total = 0;
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    var kind = proofKind(f.type, f.name);
    if (kinds.indexOf(kind) === -1 || !(await proofBytesMatch(f, kind))) {
      return { error: (f.name || 'File ' + (i + 1)) + ' is not ' + kindsText(kinds) + '.', status: 400 };
    }
    if (f.size > MAX_FILE_BYTES) {
      return { error: (f.name || 'A file') + ' is over 48MB. Compress it first.', status: 413 };
    }
    total += f.size;
  }
  if (total > MAX_TOTAL_BYTES) {
    return { error: 'Those files add up to more than 90MB. Split them across submissions.', status: 413 };
  }
  return null;
}

// How many files a quest's rules allow: the refusal, or null. `needed`
// is false where files are optional whatever the quest says (an
// organiser recording points).
export function fileCountProblem(rules: QuestRules['files'], count: number, needed: boolean): string | null {
  if (count > rules.max) {
    return rules.max ? 'At most ' + rules.max + (rules.max === 1 ? ' file' : ' files') + ' per submission.'
      : 'This quest takes no files.';
  }
  if (needed && rules.required && !count) return 'Attach ' + kindsText(rules.kinds) + '.';
  return null;
}

// The kind of proof a file is (rules.ts), or '' for one no quest takes:
// a picture has to be one of the types the worker reads.
export function proofKind(type: unknown, name?: unknown): FileKind | '' {
  var kind = fileKindOf(type, name);
  if ((kind === 'photo' || kind === 'video') && !proofTypeOk(type)) return '';
  return kind;
}

// A proof file's first bytes, read for its kind: a picture's as
// bytesMatch reads them, and a GPX track's or a PDF's as rules.ts says
// one starts. Proof only: a message's or a quest's PDF is taken as sent.
async function proofBytesMatch(file: Blob, kind: string): Promise<boolean> {
  if (kind === 'gpx' || kind === 'pdf') {
    return documentMatches(kind, new Uint8Array(await file.slice(0, 1024).arrayBuffer()));
  }
  return bytesMatch(file, storedTypeFor(kind, file.type));
}

// Photos and videos are what the site shows of a submission. A GPX
// track or a PDF is proof for the organisers alone: the dashboard serves
// it, and nothing public lists or serves it.
export function publicKind(type: unknown): boolean {
  var kind = fileKindOf(type);
  return kind === 'photo' || kind === 'video';
}

// Whether the sender's browser made a small copy and a viewing copy of
// a file: of a photo or a video, never of a GIF (a still of one is not
// what should be served in its place) or of a GPX track or a PDF.
function hasCopies(type: string): boolean {
  return publicKind(type) && !animatedType(type);
}

// Puts each file in the bucket with its metadata block and the copies
// the sender's browser made, and answers the file rows to write. `into`
// says which submission they belong to: `{team}` finds it as the team's
// newest, for a create that writes the submission in the same batch as
// its files, `{claim}` finds the one written in the same batch with that
// stamp in claimed_at (an organiser's entry, which may not go in, and
// then neither do its files), and `{submission}` names one already there. Every
// key it writes goes on `written`, so a failure can take them back.
// `found`, when given, collects when each photo or video was taken, for
// recordTaken once the rows are in. `picked`, when given, collects the
// file each JPEG was picked as (`picked<j>`), for recordPicked.
export async function storeProofFiles(env: Env, form: FormData, files: File[], into: Into, written: string[], found?: Taken[] | null, picked?: PickedNote[] | null): Promise<D1PreparedStatement[]> {
  var rows: D1PreparedStatement[] = [];
  for (var j = 0; j < files.length; j++) {
    var file = files[j];
    var ftype = storedTypeFor(proofKind(file.type, file.name), file.type);
    var key = 'sub/' + randomKey(12);
    // R2 put needs a known length up front — a File carries its size, a
    // bare stream can be refused by the runtime
    await env.SUBMIT.put(key, file, { httpMetadata: { contentType: ftype } });
    written.push.apply(written, [key].concat(DERIVED.map(function (s) { return key + s; })));
    if (picked) {
      var twin = await storePicked(env, key, ftype, form.get('picked' + j), MAX_FILE_BYTES);
      if (twin) picked.push({ key: key, picked: twin });
    }
    // the metadata block on its own, for the organisers; see photoserve.ts
    var clean = await writeBlock(env, key, ftype, file);
    // a photo whose block was not written now is read by metaBlock later
    if (found && clean) found.push({ key: key, taken: takenUtc(readExif(clean.block)) });
    else if (found && fileKindOf(ftype) === 'video') found.push({ key: key, taken: await takenOf(env, key, ftype) });
    rows.push(await proofFileRow(env, form, j, key, ftype, file.size, file.name, into));
  }
  return rows;
}

// The same for files the dashboard sent straight to R2 (src/staged.ts),
// in the order their previews are numbered. Each is under its key
// already, with its first bytes checked and its metadata block read, so only
// the previews are stored here. The staged key itself never goes on
// `written`: a save that fails gives the file back to be sent again.
export async function stagedProofFiles(env: Env, form: FormData, staged: StagedFile[], into: Into, written: string[], found?: Taken[] | null): Promise<D1PreparedStatement[]> {
  var rows: D1PreparedStatement[] = [];
  for (var j = 0; j < staged.length; j++) {
    var s = staged[j];
    written.push(s.key + '.t', s.key + '.v');
    if (found && publicKind(s.type)) found.push({ key: s.key, taken: await takenOf(env, s.key, s.type) });
    rows.push(await proofFileRow(env, form, j, s.key, storedTypeFor(proofKind(s.type, s.name), s.type), s.bytes, s.name, into));
  }
  return rows;
}

// A proof file's browser-made copies and its row, once the file is
// under its key.
async function proofFileRow(env: Env, form: FormData, j: number, key: string, ftype: string, bytes: number, name: string | null, into: Into): Promise<D1PreparedStatement> {
  // The page downscales each photo (and grabs a frame of each video)
  // before uploading — the worker cannot resize images itself, so the
  // sender's browser does it. The preview lives next to the original
  // under the same unguessable key with .t added; nothing breaks when
  // it is missing, reads just fall back to the full file.
  // A GIF gets neither copy: a canvas can only take one frame of it,
  // and a still is never what should be served in its place. A GPX
  // track or a PDF has nothing to draw.
  var copies = hasCopies(ftype);
  if (copies) await storePreview(env, key + '.t', form.get('thumb' + j), MAX_THUMB_BYTES);
  // The same browser also makes a photo's viewing copy — about
  // 1920px on the long edge, for the lightbox, the slideshow and
  // review previews, which used to pull the multi-megabyte
  // original. It lives at .v; a missing copy just means the clean
  // copy serves.
  if (copies) await storePreview(env, key + '.v', form.get('view' + j), MAX_VIEW_BYTES);
  var fileName = cleanText(name, 120).replace(/[^\w. ()-]/g, '_') || 'proof';
  // the row lands only beside the submission holding the stamp
  if (into.claim) {
    return env.DB.prepare(
      'INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) ' +
      'SELECT id, ?2, ?3, ?4, ?5 FROM submissions WHERE claimed_at = ?1'
    ).bind(into.claim, key, ftype, bytes, fileName);
  }
  // a submission named by id has to be there and not deleted: otherwise
  // the id is null and the NOT NULL column fails the batch, so nothing is
  // added to a submission a Delete took in the meantime
  var owner = into.submission ? "(SELECT id FROM submissions WHERE id = ?1 AND status != 'deleted')"
    : '(SELECT MAX(id) FROM submissions WHERE team_id = ?1)';
  return env.DB.prepare(
    'INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) ' +
    'VALUES (' + owner + ', ?2, ?3, ?4, ?5)'
  ).bind(into.submission || into.team, key, ftype, bytes, fileName);
}

// ---------- large files: the slices ----------

function partsOf(bytes: number, partSize: number): number { return Math.max(1, Math.ceil(bytes / partSize)); }

// the file, only if it belongs to the signed-in team
async function uploadRowFor(env: Env, session: TeamSession, id: number): Promise<UploadRow | null> {
  if (!id || id !== Math.round(id)) return null;
  return env.DB.prepare(
    'SELECT f.id, f.r2_key, f.content_type, f.bytes, f.name, f.part_size, f.upload_id, f.status, ' +
    'f.submission_id, s.quest_code ' +
    'FROM submission_files f JOIN submissions s ON s.id = f.submission_id ' +
    'WHERE f.id = ?1 AND s.team_id = ?2'
  ).bind(id, session.team_id).first<UploadRow>();
}

// Which slices already landed — how a reopened page picks an upload
// back up. The file's own name and the quest it belongs to come back
// with them: a page that has been closed and reopened is asking what
// this half-finished thing is, and the answer should not depend on
// what its localStorage happens to still hold.
async function uploadStatus(env: Env, session: TeamSession, url: URL): Promise<Response> {
  var row = await uploadRowFor(env, session, Number(url.searchParams.get('file')));
  if (!row) return json({ error: 'not found' }, 404);
  if (row.status !== 'uploading') return json({ ok: true, file: row.id, done: true });
  var landed: number[];
  if (isDirect(row)) {
    // a slice is only counted at its full size, so one cut off part way
    // is sent again
    try {
      landed = (await directLanded(env, row.r2_key, directId(row), row.bytes, row.part_size)).map(function (p) { return p.n; });
    } catch (err) { return json({ error: 'Storage could not be reached. Try again.' }, 502); }
  } else {
    landed = (await env.DB.prepare(
      'SELECT part_n FROM submission_upload_parts WHERE file_id = ?1 ORDER BY part_n'
    ).bind(row.id).all<Pick<SubmissionUploadPartRow, 'part_n'>>()).results.map(function (p) { return p.part_n; });
  }
  await nameDeleted(env.DB, [row], 'quest_code', 'submissions', function (r) { return r.submission_id; });
  return json({
    ok: true, file: row.id, size: row.bytes, part_size: row.part_size,
    name: row.name || '', quest: row.quest_code || '', direct: isDirect(row),
    parts: landed
  });
}

// The address one slice of a file going straight to R2 is sent to.
// Asked for slice by slice, so none has to outlive a slow upload.
async function uploadSign(env: Env, session: TeamSession, url: URL): Promise<Response> {
  var row = await uploadRowFor(env, session, Number(url.searchParams.get('file')));
  if (!row) return json({ error: 'not found' }, 404);
  if (row.status !== 'uploading') return json({ error: 'already finished' }, 409);
  if (!isDirect(row)) return json({ error: 'this file goes through the worker' }, 409);
  if (!directReady(env)) return json({ error: 'Storage is not set up for direct uploads.' }, 503);
  // picked=1: the file the photo was picked as, sent whole before finish
  if (url.searchParams.get('picked') === '1') {
    var twin = await pickedUrl(env, row.r2_key);
    return twin ? json({ ok: true, file: row.id, url: twin }, 200, NO_STORE) : json({ error: 'not found' }, 404);
  }
  var n = Number(url.searchParams.get('n'));
  if (!n || n !== Math.round(n) || n < 1 || n > partsOf(row.bytes, row.part_size)) {
    return json({ error: 'bad part number' }, 400);
  }
  return json({ ok: true, file: row.id, n: n, url: await directPartUrl(env, row.r2_key, directId(row), n) }, 200, NO_STORE);
}

async function uploadPart(request: Request, env: Env, session: TeamSession, url: URL): Promise<Response> {
  var row = await uploadRowFor(env, session, Number(url.searchParams.get('file')));
  if (!row) return json({ error: 'not found' }, 404);
  if (row.status !== 'uploading') return json({ error: 'already finished' }, 409);
  if (isDirect(row)) return json({ error: 'this file goes straight to storage' }, 409);
  var n = Number(url.searchParams.get('n'));
  var totalParts = partsOf(row.bytes, row.part_size);
  if (!n || n !== Math.round(n) || n < 1 || n > totalParts) return json({ error: 'bad part number' }, 400);
  var body = await request.arrayBuffer();
  var expect = n < totalParts ? row.part_size : row.bytes - row.part_size * (totalParts - 1);
  if (body.byteLength !== expect) {
    return json({ error: 'part ' + n + ' should be ' + expect + ' bytes, got ' + body.byteLength }, 400);
  }
  var sent = await env.SUBMIT.resumeMultipartUpload(row.r2_key, row.upload_id).uploadPart(n, body);
  // a slice that lands after finish (or an abort) is not written back
  // beside a file that no longer has slices
  var kept = await env.DB.prepare(
    'INSERT OR REPLACE INTO submission_upload_parts (file_id, part_n, etag) SELECT ?1, ?2, ?3 ' +
    "WHERE EXISTS (SELECT 1 FROM submission_files WHERE id = ?1 AND status = 'uploading')"
  ).bind(row.id, n, sent.etag).run();
  if (!(kept.meta && kept.meta.changes)) return json({ error: 'already finished' }, 409);
  return json({ ok: true, file: row.id, n: n });
}

async function uploadFinish(request: Request, env: Env, session: TeamSession): Promise<Response> {
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  var row = await uploadRowFor(env, session, Number(body.file));
  if (!row) return json({ error: 'not found' }, 404);
  if (row.status !== 'uploading') return json({ ok: true, file: row.id, done: true });
  if (isDirect(row)) return directFinish(env, row);
  var totalParts = partsOf(row.bytes, row.part_size);
  var parts = await env.DB.prepare(
    'SELECT part_n, etag FROM submission_upload_parts WHERE file_id = ?1 ORDER BY part_n'
  ).bind(row.id).all<Pick<SubmissionUploadPartRow, 'part_n' | 'etag'>>();
  if (parts.results.length !== totalParts) {
    return json({ error: parts.results.length + ' of ' + totalParts + ' parts uploaded' }, 409);
  }
  try {
    await env.SUBMIT.resumeMultipartUpload(row.r2_key, row.upload_id).complete(
      parts.results.map(function (p) { return { partNumber: p.part_n, etag: p.etag }; })
    );
  } catch (err) {
    // a second finish can lose the race to the first; that is still done
    var again = await env.DB.prepare('SELECT status FROM submission_files WHERE id = ?1').bind(row.id).first<Pick<SubmissionFileRow, 'status'>>();
    if (again && again.status === 'ready') return json({ ok: true, file: row.id, done: true });
    return json({ error: 'The parts could not be stitched together. Try the upload again.' }, 500);
  }
  // the worker kept the slices, not the file: its first bytes are read
  // now, as they are for a file sent whole
  if (!(await storedMatches(env, row.r2_key, row.content_type))) return refuseStored(env, row);
  var flipped = await env.DB.batch([
    env.DB.prepare("UPDATE submission_files SET status = 'ready', upload_id = NULL WHERE id = ?1 AND status = 'uploading'").bind(row.id),
    env.DB.prepare('DELETE FROM submission_upload_parts WHERE file_id = ?1').bind(row.id)
  ]);
  return arrived(env, row, !!(flipped[0].meta && flipped[0].meta.changes));
}

// After the flip to ready. Only the request whose flip changed the row
// goes on: a second finish answers done, and a finish whose row went
// while it ran (an abort, the submission's Delete) takes back the file
// it just put together, which nothing points at any more.
async function arrived(env: Env, row: UploadRow, flipped: boolean): Promise<Response> {
  if (!flipped) {
    var now = await env.DB.prepare('SELECT status FROM submission_files WHERE id = ?1').bind(row.id).first<Pick<SubmissionFileRow, 'status'>>();
    if (now) return json({ ok: true, file: row.id, done: true });
    await deleteStored(env.SUBMIT, row.r2_key);
    return json({ error: 'That upload was cancelled.' }, 409);
  }
  await settleArrived(env, row);
  // a Delete between the flip and here leaves what settleArrived wrote
  if (!(await env.DB.prepare('SELECT 1 AS n FROM submission_files WHERE id = ?1').bind(row.id).first())) {
    await deleteStored(env.SUBMIT, row.r2_key);
  }
  return json({ ok: true, file: row.id, done: true });
}

// A file that has just arrived in slices: when it was taken, which
// for a photo writes its metadata block on the way, and the file it was
// picked as read.
async function settleArrived(env: Env, row: Pick<SubmissionFileRow, 'r2_key' | 'content_type'>): Promise<void> {
  if (publicKind(row.content_type)) await noteTaken(env, row.r2_key, row.content_type);
  await settlePicked(env, row.r2_key, MAX_FILE_BYTES);
}

// A file already in the bucket, read the way bytesMatch reads one sent
// in a request: a picture's first bytes, or a GPX track's or a PDF's.
// Anything else (a video) is taken as it is.
export async function storedMatches(env: Env, key: string, type: string): Promise<boolean> {
  var kind = fileKindOf(type);
  var doc = kind === 'gpx' || kind === 'pdf';
  if (!doc && baseType(type).indexOf('image/') !== 0) return true;
  var head = await env.SUBMIT.get(key, { range: { offset: 0, length: doc ? 1024 : 16 } });
  var first = head ? new Uint8Array(await head.arrayBuffer()) : new Uint8Array(0);
  return doc ? documentMatches(kind, first) : imageMatches(type, first);
}

// A finished file that is not what its type says goes, with its row,
// as a send through the worker would have been refused.
async function refuseStored(env: Env, row: UploadRow): Promise<Response> {
  await deleteStored(env.SUBMIT, row.r2_key);
  await dropFileRow(env, row);
  return json({ error: (row.name || 'That file') + ' is not ' + kindsText([fileKindOf(row.content_type) || 'photo']) + '.' }, 400);
}

// A file sent straight to R2: the worker never saw a slice, so it asks
// R2 what arrived, checks every slice is there at its full size, joins
// them, and then reads the first bytes, since nothing has looked at
// them yet.
async function directFinish(env: Env, row: UploadRow): Promise<Response> {
  var problem = await directJoin(env, row.r2_key, directId(row), row.bytes, row.part_size);
  if (problem) {
    // a second finish can lose the race to the first; that is still done
    var again = await env.DB.prepare('SELECT status FROM submission_files WHERE id = ?1').bind(row.id).first<Pick<SubmissionFileRow, 'status'>>();
    if (again && again.status === 'ready') return json({ ok: true, file: row.id, done: true });
    return json({ error: problem.error }, problem.status);
  }
  if (!(await storedMatches(env, row.r2_key, row.content_type))) return refuseStored(env, row);
  var flipped = await env.DB.prepare("UPDATE submission_files SET status = 'ready', upload_id = NULL WHERE id = ?1 AND status = 'uploading'")
    .bind(row.id).run();
  return arrived(env, row, !!(flipped.meta && flipped.meta.changes));
}

// A file still uploading goes, its row and slices, and its submission
// with it when that was all it had — asked in the same statement, so a
// file added in between keeps the submission. Answers whether the row
// was there to go: a file that finished meanwhile stays.
async function dropFileRow(env: Env, row: Pick<UploadRow, 'id' | 'submission_id'>): Promise<boolean> {
  var done = await env.DB.batch([
    env.DB.prepare("DELETE FROM submission_files WHERE id = ?1 AND status = 'uploading'").bind(row.id),
    env.DB.prepare('DELETE FROM submission_upload_parts WHERE file_id = ?1 AND NOT EXISTS (SELECT 1 FROM submission_files WHERE id = ?1)').bind(row.id),
    env.DB.prepare(
      "DELETE FROM submissions WHERE id = ?1 AND status IN ('pending', 'queued') " +
      'AND NOT EXISTS (SELECT 1 FROM submission_files WHERE submission_id = ?1)'
    ).bind(row.submission_id)
  ]);
  return !!(done[0].meta && done[0].meta.changes);
}

// giving up on an upload takes its parts, its row — and the submission,
// when that file was all the submission had
async function uploadAbort(request: Request, env: Env, session: TeamSession): Promise<Response> {
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  var row = await uploadRowFor(env, session, Number(body.file));
  if (!row) return json({ error: 'not found' }, 404);
  if (row.status !== 'uploading') return json({ error: 'already finished' }, 409);
  // the row first, and only while it is still uploading: a finish that
  // got there first keeps its file
  if (!(await dropFileRow(env, row))) return json({ error: 'already finished' }, 409);
  try {
    if (isDirect(row)) await directAbort(env, row.r2_key, directId(row));
    else await env.SUBMIT.resumeMultipartUpload(row.r2_key, row.upload_id).abort();
  } catch (err) { /* parts already gone */ }
  // the previews and the file it was picked as went with the create
  await deleteStored(env.SUBMIT, row.r2_key);
  return json({ ok: true });
}

// The quest's answer box, as JSON: {kind, value}. count is a number,
// text a short string, choice one of the options, pick and codes lists
// of strings. A quest that asks several questions sends the first one
// that way and the rest in `more`, in order, each carrying the question
// as it was worded (`prompt`) and null for one left blank; the first is
// where review looks for ticked codes. Anything else is refused;
// nothing is a fine answer. A list longer than MAX_PICKS is refused
// rather than cut, since a challenge counts every entry, and `why` is
// given the words for that.
export var MAX_PICKS = 60;
var TOO_MANY_PICKS = 'At most ' + MAX_PICKS + ' picks in one answer.';
function cleanEntry(data: unknown, why?: { error?: string }): AnswerEntry | false {
  if (!data || typeof data !== 'object') return false;
  var d = data as Record<string, unknown>;
  var kind = String(d.kind || '');
  if (SUBMIT_KINDS.indexOf(kind) === -1 || kind === 'none') return false;
  var sent = d.value;
  var value: AnswerEntry['value'];
  if (sent == null || sent === '') value = null;
  else if (kind === 'count') {
    value = Number(sent);
    if (!isFinite(value) || value < 0 || value > 100000) return false;
  } else if (kind === 'text' || kind === 'choice') {
    value = cleanText(sent, kind === 'text' ? 500 : 120) || null;
  } else {
    if (!Array.isArray(sent)) return false;
    value = sent.map(function (v) { return cleanText(v, 120); }).filter(Boolean);
    if (value.length > MAX_PICKS) {
      if (why) why.error = TOO_MANY_PICKS;
      return false;
    }
    if (!value.length) value = null;
  }
  var out: AnswerEntry = { kind: kind, value: value };
  var prompt = cleanText(d.prompt, 120);
  if (prompt) out.prompt = prompt;
  return out;
}

// `why`, when given, carries the refusal to show when the answer is
// refused for something the sender can put right.
export function cleanAnswer(raw: unknown, why?: { error?: string }): string | null | false {
  if (raw == null || raw === '') return null;
  var data: unknown;
  try { data = JSON.parse(String(raw).slice(0, 16000)); } catch (err) { return false; }
  var top: Answer | false = cleanEntry(data, why);
  if (!top) return false;
  var more: (AnswerEntry | null)[] = [];
  var rest = prop(data, 'more');
  if (Array.isArray(rest)) {
    for (var i = 0; i < rest.length && i < MAX_QUESTIONS - 1; i++) {
      if (rest[i] == null) { more.push(null); continue; }
      var one = cleanEntry(rest[i], why);
      if (!one) return false;
      more.push(one.value == null ? null : one);
    }
  }
  if (top.value == null && !more.some(Boolean)) return null;
  if (more.length) top.more = more;
  return JSON.stringify(top);
}

// Reads a stored answer back into an object (null when there is none).
export function parseAnswer(text: unknown): Answer | null {
  if (!text) return null;
  // the column holds what cleanAnswer wrote
  try { return JSON.parse(text as string) as Answer; } catch (err) { return null; }
}

// Attaches each submission's file descriptors as row.media, one query
// for the lot. The R2 keys double as the file URLs' capability tokens
// (96 random bits), so handing them to their owners is handing them
// the files.
export async function attachMedia<T extends { id: number }>(env: Env, rows: T[]): Promise<(T & { media: MediaOut[] })[]> {
  var out = rows as (T & { media: MediaOut[] })[];
  if (!out.length) return out;
  var byId: Record<number, T & { media: MediaOut[] }> = {};
  for (var i = 0; i < out.length; i++) {
    out[i].media = [];
    byId[out[i].id] = out[i];
  }
  // The ids go in as one JSON list rather than a parameter each: D1
  // takes at most 100 bound parameters in a statement, and the review
  // queue asks for 200 rows and the gallery for 300.
  var ids = JSON.stringify(rows.map(function (r) { return r.id; }));
  var files = await env.DB.prepare(
    'SELECT submission_id, r2_key, content_type, bytes, name, status, encode_state, picked_type FROM submission_files ' +
    'WHERE submission_id IN (SELECT value FROM json_each(?1)) ORDER BY id'
  ).bind(ids).all<Pick<SubmissionFileRow, 'submission_id' | 'r2_key' | 'content_type' | 'bytes' | 'name' | 'status' | 'encode_state' | 'picked_type'>>();
  var videos: Record<string, MediaOut> = {};
  files.results.forEach(function (f) {
    var row = byId[f.submission_id];
    if (!row) return;
    var entry: MediaOut = { key: f.r2_key, type: f.content_type, bytes: f.bytes, name: f.name };
    // the type of the file it was picked as, which the dashboard offers
    if (f.picked_type) entry.picked = f.picked_type;
    if (f.status && f.status !== 'ready') entry.uploading = 1; // registered, slices still coming
    if (String(f.content_type || '').indexOf('video/') === 0) {
      entry.renditions = [];
      if (f.encode_state === 'encoding') entry.encoding = true;
      // the encoder gave up on it: nothing plays until Retry failed videos
      else if (f.encode_state === 'skipped') entry.skipped = true;
      videos[f.r2_key] = entry;
    }
    row.media.push(entry);
  });
  // The smaller copies, for the whole list in one query rather than
  // one per file: the renditions are reached through the same set of
  // submission ids the files came from.
  if (!Object.keys(videos).length) return out;
  var made = await env.DB.prepare(
    'SELECT r.file_key, r.height FROM submission_renditions r ' +
    'JOIN submission_files f ON f.r2_key = r.file_key ' +
    'WHERE f.submission_id IN (SELECT value FROM json_each(?1)) ORDER BY r.height'
  ).bind(ids).all<Pick<SubmissionRenditionRow, 'file_key' | 'height'>>();
  made.results.forEach(function (r) {
    var list = videos[r.file_key] && videos[r.file_key].renditions;
    if (list && list.indexOf(r.height) === -1) list.push(r.height);
  });
  return out;
}

// Which stored object answers a request for a given height: the exact
// rendition, else the largest one below it, else the smallest above
// it, else nothing — and nothing means the original. An unknown or
// missing res is nothing too, so the plain URL keeps its old meaning.
// A photo has one smaller copy, made by the uploader's browser and
// stored at .v — so for images any res short of the original means
// the viewing copy, whatever number the caller sent.
export function wantsSmaller(res: unknown): boolean {
  return !!res && res !== 'original';
}

// ---------- photos as the public sees them ----------
// A phone writes where it was, which phone it is and when, into every
// photo. That belongs to the organisers judging the submission, not to
// every team that can open the gallery. So the original is kept, only
// the dashboard reaches it whole, and everything public serves it with
// that metadata cut out as it streams (photoserve.ts): the identical
// picture, not a re-encode, and no second copy kept. `<key>.x` holds the
// block that came out, a few KB, so the dashboard can say where a photo
// was taken without fetching the photo. A video goes a different way —
// the encoder makes its clean copy, kept at `<key>.c`, by repackaging
// the container.

// ---------- what may come in ----------

// The pictures a phone takes or a browser makes, and video. Never SVG:
// it is a document that can carry script, and these files are served
// from the same hostnames as the dashboard.
var PHOTO_TYPES = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp', 'image/heic', 'image/heif', 'image/avif'];

export function proofTypeOk(type: unknown): boolean {
  var t = baseType(type);
  return PHOTO_TYPES.indexOf(t) !== -1 || /^video\/[\w.+-]+$/.test(t);
}

// A picture's first bytes are what its type says: the type a browser
// sends is only what the file's name said. Video is not read — served
// under a video type with nosniff and a sandbox (serveStoredFile),
// whatever is inside it cannot run.
export async function bytesMatch(file: Blob, type: unknown): Promise<boolean> {
  if (baseType(type).indexOf('image/') !== 0) return true;
  var head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return imageMatches(type, head);
}

// A browser-made preview (.t) or viewing copy (.v): a JPEG or PNG and
// nothing else, read through and stored with any metadata taken out.
// The pages draw them on a canvas, which carries none, but anyone can
// post to the API without the page. Resolves whether one was stored.
export async function storePreview(env: Env, key: string, blob: unknown, maxBytes: number): Promise<boolean> {
  if (!isBlobLike(blob) || !blob.size || blob.size > maxBytes) return false;
  var type = baseType(blob.type);
  if (type !== 'image/jpeg' && type !== 'image/jpg' && type !== 'image/png') return false;
  var bytes = new Uint8Array(await blob.arrayBuffer());
  if (!imageMatches(type, bytes)) return false;
  var out = stripImage(bytes, type);
  if (!out.parsed) return false;
  await env.SUBMIT.put(key, out.bytes, { httpMetadata: { contentType: type } });
  return true;
}

// ---------- the file a photo was picked as ----------
// The submit and album pages turn a HEIC or a WebP into a JPEG before it
// goes up (scs.toJpeg in site.js): most browsers cannot show a HEIC, and
// nothing here can cut the metadata out of either. The file as picked
// comes too, and is kept beside the JPEG at <key>.p with its type in the
// row's picked_type, so it can be saved as the phone wrote it. It holds
// the location like any original, so it goes out only where the original
// may: an album that shows details (albums.ts) and the dashboard.
//   whole     `picked<i>` beside `files`, stored by the create (storePicked)
//   in slices `bigpicked<k>` beside the manifest when the slices come
//             through the worker; when they go straight to R2 the
//             manifest names it (`picked: {type, size}`), the page sends
//             it whole to the address `upload/sign?picked=1` signs, and
//             upload/finish reads it (settlePicked)
// One that is not what its type says, too big, or beside anything but a
// JPEG is left out, and the photo goes in without it.
export var PICKED_TYPES = ['image/heic', 'image/heif', 'image/webp'];

function pickedType(type: unknown): string {
  var t = baseType(type);
  return PICKED_TYPES.indexOf(t) !== -1 ? t : '';
}
function besideJpeg(mainType: unknown): boolean {
  var t = baseType(mainType);
  return t === 'image/jpeg' || t === 'image/jpg';
}

// The file sent beside a JPEG, kept at <key>.p when it may be. Answers
// its type, or '' when it was left out.
export async function storePicked(env: Env, key: string, mainType: unknown, blob: unknown, cap: number): Promise<string> {
  if (!isBlobLike(blob) || !blob.size || blob.size > cap || !besideJpeg(mainType)) return '';
  var type = pickedType(blob.type);
  if (!type || !pickedMatches(type, new Uint8Array(await blob.slice(0, 64).arrayBuffer()))) return '';
  await env.SUBMIT.put(key + '.p', blob, { httpMetadata: { contentType: type } });
  return type;
}

// What a manifest says of the file a photo going straight to R2 was
// picked as: its type when it may be sent, else ''.
export function pickedDeclared(entry: unknown, mainType: unknown, cap: number): string {
  var p = prop(entry, 'picked');
  if (!p || typeof p !== 'object' || !besideJpeg(mainType)) return '';
  var size = Math.round(Number(prop(p, 'size')) || 0);
  return size >= 1 && size <= cap ? pickedType(prop(p, 'type')) : '';
}

// Writes each kept file's type on the row holding its photo, [{key,
// picked}], after the rows are in. Where that fails nothing could list
// them, so what was kept goes again; the photos are in either way.
// Answers whether the types were written.
export async function recordPicked(env: Env, list: PickedNote[] | null | undefined): Promise<boolean> {
  list = (list || []).filter(function (f) { return f.picked; });
  if (!list.length) return true;
  try {
    await env.DB.batch(list.map(function (f) {
      return env.DB.prepare('UPDATE ' + videoTable(f.key) + ' SET picked_type = ?2 WHERE r2_key = ?1').bind(f.key, f.picked);
    }));
    return true;
  } catch (err) {
    for (var i = 0; i < list.length; i++) {
      try { await env.SUBMIT.delete(list[i].key + '.p'); } catch (e) { /* never landed */ }
    }
    return false;
  }
}

// The type of the file a photo was picked as, or '' when none was kept.
export async function pickedOf(env: Env, key: string): Promise<string> {
  var row = await env.DB.prepare('SELECT picked_type FROM ' + videoTable(key) + ' WHERE r2_key = ?1').bind(key).first<Pick<SubmissionFileRow, 'picked_type'>>();
  return (row && row.picked_type) || '';
}

// At upload/finish: a picked file sent straight to R2 has not been read
// by anything, so it is read now. One missing, over `cap` or not what
// its type says goes, and the row stops naming it.
export async function settlePicked(env: Env, key: string, cap: number): Promise<void> {
  var type = await pickedOf(env, key);
  if (!type) return;
  var head = await env.SUBMIT.get(key + '.p', { range: { offset: 0, length: 64 } });
  var first = head ? new Uint8Array(await head.arrayBuffer()) : null;
  if (head && first && head.size <= cap && pickedMatches(type, first)) return;
  try { await env.SUBMIT.delete(key + '.p'); } catch (err) { /* never landed */ }
  await env.DB.prepare('UPDATE ' + videoTable(key) + " SET picked_type = '' WHERE r2_key = ?1").bind(key).run();
}

// upload/sign?picked=1: the address the file a photo was picked as goes
// to, while its photo is still arriving straight to R2. Null when the
// photo named none.
export async function pickedUrl(env: Env, key: string): Promise<string | null> {
  if (!(await pickedOf(env, key))) return null;
  return directPutUrl(env, key + '.p');
}

// Takes back what a create stored before it failed.
export async function discard(env: Env, keys: string[], uploads: { abort(): Promise<unknown> }[]): Promise<void> {
  for (var i = 0; i < uploads.length; i++) {
    try { await uploads[i].abort(); } catch (err) { /* R2 clears it in time */ }
  }
  for (var k = 0; k < keys.length; k++) {
    try { await env.SUBMIT.delete(keys[k]); } catch (err) { /* already gone */ }
  }
}

// What the public file endpoints other than a team's proof answer with
// (message attachments, quest files, the drop, the slideshow): a photo
// with its metadata cut out as it is served. A picture the cutter
// cannot read — a type it does not know, or a file that is not what its
// type says — gets its browser-made preview, never the original.
// Anything that is not a picture (a PDF, a document, a video an
// organiser posted) is served as it is. Resolves null when there is
// nothing to serve.
export async function servePublicCopy(env: Env, request: Request, key: string, type: string | null, cache: string, headers?: Record<string, string>): Promise<Response | null> {
  if (isLinkPreview(request)) {
    var upright = await uprightPreview(env, request, key, type, headers);
    if (upright) return upright;
  }
  var clean = await serveCleanPhoto(env, request, key, type, cache, headers);
  if (clean) return clean;
  if (baseType(type).indexOf('image/') === 0) {
    return serveStoredFile(env.SUBMIT, request, key + '.t', cache, headers);
  }
  return serveStoredFile(env.SUBMIT, request, key, cache, headers);
}

// A link preview of a photo stored on its side. Discord sizes the
// preview from the width and height the picture is stored at, then
// draws it turned the way its orientation tag says, so a photo taken
// with the phone upright came out squashed into a landscape box. Such a
// photo is answered with a copy the browser made, which was drawn the
// right way up and carries no tag: the viewing copy, else the small
// one. Null for anything else, which is served as before.
async function uprightPreview(env: Env, request: Request, key: string, type: string | null, headers?: Record<string, string>): Promise<Response | null> {
  var t = String(type || '').toLowerCase();
  if (t !== 'image/jpeg' && t !== 'image/jpg') return null;
  var head = await env.SUBMIT.get(key, { range: { offset: 0, length: 256 * 1024 } });
  if (!head) return null;
  if (jpegOrientation(new Uint8Array(await head.arrayBuffer())) <= 1) return null;
  return (await serveStoredFile(env.SUBMIT, request, key + '.v', 'private, no-store', headers)) ||
    (await serveStoredFile(env.SUBMIT, request, key + '.t', 'private, no-store', headers));
}

// When a photo or video was taken, in UTC, or '' when it does not say:
// from its metadata block, and for a video that gives no time with a
// zone, from its own movie header.
export async function takenOf(env: Env, key: string, type: string): Promise<string> {
  var video = baseType(type).indexOf('video/') === 0;
  if (!video && baseType(type).indexOf('image/') !== 0) return '';
  var block = await metaBlock(env, key, type);
  var taken = block ? takenUtc(readExif(block)) : '';
  return taken || (video ? videoTakenAt(env.SUBMIT, key) : '');
}

// Writes those times on the rows holding the files, [{key, taken}]: an
// album upload's or a proof file's, by its key. '' says the file was
// looked at and gave no time, so the tidy does not look again.
export async function recordTaken(env: Env, found: Taken[] | null | undefined): Promise<void> {
  if (!found || !found.length) return;
  await env.DB.batch(found.map(function (f) {
    var table = f.key.indexOf('alb/') === 0 ? 'album_photos' : 'submission_files';
    return env.DB.prepare('UPDATE ' + table + ' SET taken_at = ?2 WHERE r2_key = ?1').bind(f.key, f.taken || '');
  }));
}

// The two together for one file that has just arrived whole.
export async function noteTaken(env: Env, key: string, type: string): Promise<void> {
  try {
    await recordTaken(env, [{ key: key, taken: await takenOf(env, key, type) }]);
  } catch (err) { /* the dashboard's tidy fills it in */ }
}

// The biggest smaller copy there is. A video whose clean full-size
// copy would not fit in one request falls back to this, so Original
// still answers with something that has had the location taken out.
export async function largestRendition(env: Env, fileKey: string): Promise<string> {
  var row = await env.DB.prepare(
    'SELECT key FROM submission_renditions WHERE file_key = ?1 ORDER BY height DESC LIMIT 1'
  ).bind(fileKey).first<Pick<SubmissionRenditionRow, 'key'>>();
  return (row && row.key) || '';
}

export async function renditionKey(env: Env, fileKey: string, res: unknown): Promise<string> {
  return (await renditionFor(env, fileKey, res)).key;
}

// The same, and whether the copy is the height asked for (`exact`).
export async function renditionFor(env: Env, fileKey: string, res: unknown): Promise<{ key: string; exact: boolean }> {
  var want = Math.round(Number(res));
  if (!want || RENDITION_HEIGHTS.indexOf(want) === -1) return { key: '', exact: false };
  var rows = await env.DB.prepare(
    'SELECT height, key FROM submission_renditions WHERE file_key = ?1 ORDER BY height'
  ).bind(fileKey).all<Pick<SubmissionRenditionRow, 'height' | 'key'>>();
  var below: Pick<SubmissionRenditionRow, 'height' | 'key'> | null = null;
  var above: Pick<SubmissionRenditionRow, 'height' | 'key'> | null = null;
  for (var i = 0; i < rows.results.length; i++) {
    var row = rows.results[i];
    if (row.height === want) return { key: row.key, exact: true };
    if (row.height < want) below = row;       // rows are ascending: the last one under is the largest
    else if (!above) above = row;             // and the first one over is the smallest
  }
  return { key: (below || above || { key: '' }).key, exact: false };
}

// How a video's file is answered when what is served stands in for what
// was asked: a still in place of the video, or another height than the
// one asked for. Until the encoder is done the same address will serve
// the real copy, so neither the browser nor the edge (edgeFile in
// index.ts keeps only `public, immutable`) may keep the stand-in. Once
// it is done the set of copies is final and the nearest height is the
// answer for good.
export var STAND_IN_CACHE = 'private, no-store';

// What the team sent, and what an organiser recorded for them: each of
// those says so (`organiser`: 'added', or 'taken' for points taken off)
// without saying which organiser. One given part of its points carries
// `part`: {given, of}, with `of` null on a mystery quest. The newest
// MINE_MOST only, with `more: true` when there are older ones.
var MINE_MOST = 100;
async function mine(env: Env, session: TeamSession, quest: string): Promise<Response> {
  await promoteQueued(env.DB, session.team_id);
  // `quest`, a quest's key: only what was sent for that quest (the
  // recap's page for one quest)
  var only = quest ? ' AND s.quest_code IN (SELECT q.code FROM quests q JOIN quest_groups g ON g.id = q.group_id ' +
    'WHERE g.key = ?2 COLLATE NOCASE)' : '';
  // a row as read, then shaped for the team: the answer read back, who
  // added it said only as `organiser`, and any part mark
  type MineRow = Pick<SubmissionRow, 'id' | 'quest_code' | 'note' | 'status' | 'submitted_at' | 'reason' | 'gallery'> &
    { answer: unknown; files: number; added_by?: string; credit?: string | null; organiser?: string; part?: { given: number; of: number | null } | null };
  var st = env.DB.prepare(
    'SELECT s.id, s.quest_code, s.note, s.status, s.submitted_at, s.reason, s.gallery, s.answer, s.added_by, s.credit, ' +
    'COUNT(f.id) AS files FROM submissions s ' +
    'LEFT JOIN submission_files f ON f.submission_id = s.id ' +
    'WHERE s.team_id = ?1' + only + ' GROUP BY s.id ORDER BY s.id DESC LIMIT ' + (MINE_MOST + 1)
  );
  var rows = await (quest ? st.bind(session.team_id, quest) : st.bind(session.team_id)).all<MineRow>();
  var more = rows.results.length > MINE_MOST;
  if (more) rows.results.splice(MINE_MOST);
  // an entry took points off when what it was worth comes out below
  // nothing: an amount taken back, or a quest worth negative points.
  // With no worth to go on (no codes, or quests worth 0) the amount decides
  var credits = rows.results.map(function (r) {
    try { return JSON.parse(r.credit || 'null') as Credit | null; } catch (err) { return null; }
  });
  var codes: string[] = [];
  credits.forEach(function (c) { if (c && Array.isArray(c.codes)) codes = codes.concat(c.codes); });
  var parts = await partsFor(env.DB, codes);
  var groupOf: Record<string, number | null> = {};
  if (codes.length) {
    (await env.DB.prepare('SELECT code, group_id FROM quests WHERE code IN (SELECT value FROM json_each(?1))')
      .bind(JSON.stringify(codes)).all<Pick<QuestRow, 'code' | 'group_id'>>()).results.forEach(function (q) { groupOf[q.code] = q.group_id; });
  }
  var mystery = credits.some(function (c) { return c && c.amounts; }) ? await mysteryIds(env.DB) : {};
  rows.results.forEach(function (r, i) {
    var credit = credits[i];
    var w = credit && Array.isArray(credit.codes) ? creditWorth(parts, credit) : { given: 0, full: 0 };
    var worth = w.given;
    var full = w.full;
    var taken = worth ? worth < 0 : !!(credit && Number(credit.amount) < 0);
    r.organiser = !r.added_by ? '' : (taken ? 'taken' : 'added');
    var hidden = credit && Array.isArray(credit.codes) && credit.codes.some(function (code) { return mystery[String(groupOf[code])]; });
    r.part = r.status === 'accepted' && credit && credit.amounts && worth !== full ? { given: worth, of: hidden ? null : full } : null;
    delete r.added_by;
    delete r.credit;
  });
  await attachMedia(env, rows.results);
  rows.results.forEach(function (r) { r.answer = parseAnswer(r.answer); });
  await nameDeleted(env.DB, rows.results, 'quest_code', 'submissions', function (r) { return r.id; });
  var out: { ok: true; team: string; submissions: MineRow[]; more?: true } = { ok: true, team: session.team_name, submissions: rows.results };
  if (more) out.more = true;
  return json(out);
}

// A team's own score sheet: where it sits, what it has been given
// points for, and how many submissions are still waiting on a
// reviewer. Its own row only — the leaderboard is the public read for
// everyone else's.
//
// The freeze covers this one too. A team's place is exactly what the
// freeze hides, so while the tab is stopped this answers that it is
// stopped and nothing else; there is no sheet to read the standings
// out of sideways. Closed, it answers that it is closed.
async function scoreSheet(env: Env, session: TeamSession): Promise<Response> {
  var gate = await tabState(env.DB);
  if (gate.closed) return json({ ok: true, closed: true }, 200, NO_STORE);
  if (gate.frozen) return json({ ok: true, frozen: true }, 200, NO_STORE);

  var rows = await standings(env.DB);
  var rank: number | null = null;
  var dnf = false;
  for (var i = 0; i < rows.length; i++) {
    // a hidden team (a test run) is not in the standings at all, so it
    // reads its own sheet with no place on it; nor does a team that did
    // not finish
    if (rows[i].id === session.team_id) { rank = rows[i].rank; dnf = rows[i].dnf; break; }
  }

  var entries = (await env.DB.prepare(
    'SELECT c.quest_code AS code, c.amount, c.points AS worth, q.points, q.scoring, q.label, q.group_id, g.key AS group_key, g.name AS name ' +
    'FROM held c JOIN quests q ON q.code = c.quest_code ' +
    'LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    'WHERE c.team_id = ?1'
  ).bind(session.team_id).all<{ code: string; amount: number; worth: number } & Pick<QuestRow, 'points' | 'scoring' | 'label' | 'group_id'> &
    { group_key: string | null; name: string | null }>()).results;
  var mystery = await mysteryIds(env.DB);
  var total = 0;
  var lines = entries.map(function (r) {
    var worth = r.worth;
    total += worth;
    // a part mark on a mystery quest says what it was worth and no more,
    // and a tiered or counted code says only what it came to; `scoring`
    // tells the page which of the two a line with no points is
    var shown = showsPoints(mystery[String(r.group_id)], r.amount) && !bandsScore(r.scoring);
    return {
      code: r.code,
      group_key: r.group_key || r.code,
      // a code with no quest round it (the EOI award) goes by its label
      name: r.name || r.label || r.code,
      scoring: r.scoring || '',
      amount: shown ? r.amount : null,
      points: shown ? r.points : null,
      worth: Math.round(worth * 100) / 100
    };
  });
  lines.sort(function (a, b) { return (b.worth - a.worth) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0); });

  await promoteQueued(env.DB, session.team_id);
  var waiting = await waitingFor(env.DB, session.team_id);

  return json({
    ok: true,
    frozen: false,
    team: session.team_name,
    rank: rank,
    dnf: dnf,
    teams: lastPlace(rows),
    total: Math.round(total * 100) / 100,
    lines: lines,
    pending: waiting.pending,
    queued: waiting.queued
  }, 200, NO_STORE);
}

// Teams can flip their gallery opt-in whenever they like, on their
// own submissions only, and not on one that was deleted.
async function setGallery(request: Request, env: Env, session: TeamSession): Promise<Response> {
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  var id = Number(body.id);
  var want = body.gallery ? 1 : 0;
  var res = await env.DB.prepare("UPDATE submissions SET gallery = ?1 WHERE id = ?2 AND team_id = ?3 AND status != 'deleted'")
    .bind(want, id, session.team_id).run();
  if (!res.meta || !res.meta.changes) return json({ error: 'not found' }, 404);
  return json({ ok: true, id: id, gallery: want });
}

// The gallery: accepted submissions whose team ticked the box. It
// takes a session — any team's, or an organiser's — so the whole set
// of proof cannot be scraped by anyone who finds the URL. The files
// themselves stay reachable by their unguessable keys, which is what
// lets a team share one; the listing is what hands out those keys, so
// the listing is the thing that is gated. The newest GALLERY_MOST
// submissions only, with `more: true` when there are older ones.
var GALLERY_MOST = 300;
async function galleryList(env: Env): Promise<Response> {
  var rows = await env.DB.prepare(
    'SELECT s.id, s.quest_code, s.note, s.submitted_at, t.name AS team_name ' +
    'FROM submissions s JOIN teams t ON t.id = s.team_id ' +
    "WHERE s.gallery = 1 AND s.status = 'accepted' AND t.hidden = 0 ORDER BY s.id DESC LIMIT " + (GALLERY_MOST + 1)
  ).all<Pick<SubmissionRow, 'id' | 'quest_code' | 'note' | 'submitted_at'> & { team_name: string }>();
  var more = rows.results.length > GALLERY_MOST;
  if (more) rows.results.splice(GALLERY_MOST);
  var listed = await attachMedia(env, rows.results);
  // photos and videos only: a GPX track or a PDF is the organisers', and
  // a submission with nothing left to show is not listed
  listed.forEach(function (r) {
    r.media = r.media.filter(function (m) { return !m.uploading && publicKind(m.type); });
  });
  await nameDeleted(env.DB, listed, 'quest_code', 'submissions', function (r) { return r.id; });
  var out: { ok: true; submissions: typeof listed; more?: true } = {
    ok: true, submissions: listed.filter(function (r) { return r.media.length > 0; })
  };
  if (more) out.more = true;
  // never cached at the edge: the answer is only for signed-in readers
  return json(out, 200, { 'cache-control': 'private, no-store' });
}

// Proof files by capability URL: the random half of the key is the
// secret, so only people a team (or the gallery) handed the URL to
// can fetch it. The key must exist in the database, contents never
// change under a key, and Range passes through so videos scrub.
async function serveTeamFile(env: Env, request: Request, url: URL, pathKey?: string): Promise<Response> {
  if (!env.SUBMIT) return json({ error: 'Uploads are not switched on.' }, 503);
  var key = pathKey || url.searchParams.get('key') || '';
  // The file a photo was picked as carries the location and is never
  // served here: it is for the dashboard and an album showing details.
  if (key.indexOf('sub/') !== 0 || url.searchParams.get('picked')) return json({ error: 'not found' }, 404);
  var row = await env.DB.prepare(
    'SELECT id, content_type, status, name, encode_state FROM submission_files WHERE r2_key = ?1'
  ).bind(key).first<Pick<SubmissionFileRow, 'id' | 'content_type' | 'status' | 'name' | 'encode_state'>>();
  // a GPX track or a PDF is the organisers' alone: the dashboard's file
  // endpoint serves it, and this one answers as if it were not there
  if (!row || !publicKind(row.content_type)) return json({ error: 'not found' }, 404);
  // a person opening the address gets the file's page
  if (wantsPage(request, url, { named: !!pathKey, media: true })) {
    var shown = await viewedFile(env.DB, key);
    if (shown) return mediaPage(env, url, shown);
  }
  var type = row.content_type;
  // download=1: the whole file as the public sees it, saved as a file
  if (url.searchParams.get('download')) {
    var inner = new URL(url);
    ['download', 'thumb', 'res'].forEach(function (p) { inner.searchParams.delete(p); });
    // the inner ask is never the page: a download a browser makes the way it
    // opens a page (Safari) was given the page's HTML under the photo's name
    inner.searchParams.set('raw', '1');
    return asDownload(await serveTeamFile(env, request, inner, pathKey), row.name,
      String(type || '').indexOf('video/') === 0);
  }
  // A GIF is served whole whatever is asked for: both its small copies
  // are one frame drawn onto a canvas, and a still in place of the
  // animation is the animation not playing.
  var moves = animatedType(type);
  var res = url.searchParams.get('res');
  // A picture asked for by a link unfurler is answered whole: the URL
  // people copy out of a page is the one in its img tag, so a photo
  // pasted into Discord was embedding at thumbnail size. Video is
  // left as asked — an unfurl has no business pulling a whole
  // original down a venue connection. That answer is not cached
  // anywhere but Discord's own media host, so the small copy stays
  // the small copy for the page that asked for it.
  var whole = isLinkPreview(request) && String(type || '').indexOf('image/') === 0;
  var asked = url.searchParams.get('thumb') || wantsSmaller(res);
  var CACHE = whole && asked ? 'private, no-store' : 'public, max-age=31536000, immutable';
  var CORS = Object.assign({ 'access-control-allow-origin': '*' }, VARY);
  function serve(k: string, cacheControl?: string): Promise<Response | null> {
    return serveStoredFile(env.SUBMIT, request, k, cacheControl || CACHE, CORS);
  }
  var video = String(type || '').indexOf('video/') === 0;
  // what another height of a video is answered with (STAND_IN_CACHE)
  var NEAREST = row.encode_state === 'done' ? CACHE : STAND_IN_CACHE;
  // and a still in place of a video, whatever the encoder has done
  var STILL = video ? STAND_IN_CACHE : CACHE;
  if (whole && !moves) {
    var upright = await uprightPreview(env, request, key, type, CORS);
    if (upright) return upright;
  }

  // uploaded=1: a video as it was sent with its metadata boxes blanked
  // (videostrip.ts), which the team gallery plays until the encoder's
  // copies exist; a file it cannot read falls through to the chain
  if (url.searchParams.get('uploaded') && video && row.status !== 'uploading') {
    var sent = await serveUploadedVideo(env, request, key, type, CORS);
    if (sent) return sent;
  }
  // thumb=1 asks for the small preview; a file uploaded without one
  // (older submissions, an odd video) falls through to the chain below
  if (url.searchParams.get('thumb') && !moves && !whole) {
    var small = await serve(key + '.t');
    if (small) return small;
    // one with no small copy: the viewing copy rather than the whole
    // photo, and nothing for a video with no still (Safari takes a video
    // in an img and downloads every byte of it)
    if (video) return json({ error: 'no still' }, 404, CORS);
    var viewing = await serve(key + '.v');
    if (viewing) return viewing;
  }
  // res=480/720/1080 asks for a smaller copy of a video, and any res
  // short of the original asks for a photo's viewing copy.
  var alt = await renditionFor(env, key, res);
  if (alt.key) {
    var smaller = await serve(alt.key, alt.exact ? CACHE : NEAREST);
    if (smaller) return smaller;
  }
  if (wantsSmaller(res) && !moves && !whole) {
    var view = await serve(key + '.v', STILL);
    if (view) return view;
  }
  // **This endpoint never serves an original.** It takes no session —
  // the random half of the key is the whole credential, and the
  // gallery hands those keys to every signed-in team — so what it
  // answers with has had the location and the camera taken out of it:
  // a photo cut as it is served, a video the encoder's clean copy.
  var clean = video
    ? await serve(key + '.c')
    : await serveCleanPhoto(env, request, key, type, CACHE, CORS);
  if (clean) return clean;
  // A video whose clean copy did not come out — the encoder measured
  // it the wrong way up, say: the largest rendition stands in, and it
  // was encoded with the metadata dropped.
  if (video) {
    var biggest = await largestRendition(env, key);
    if (biggest) {
      var best = await serve(biggest, NEAREST);
      if (best) return best;
    }
  }
  // A file whose slices are still arriving has no whole self to serve
  // yet, clean or otherwise. Its preview above is the thing to show.
  if (row.status === 'uploading') return json({ error: 'still uploading' }, 404);
  // A format this cannot clean — an unknown image type, or a video the
  // encoder has not reached. The browser-made copies are canvas
  // redraws and carry nothing, so they stand in at a smaller size; the
  // original stays where it is. Nothing here ever reaches it, even
  // when the stripper could not read the file: a file this cannot
  // parse is not thereby a file with nothing in it, and guessing the
  // other way is how metadata gets handed out by accident. For a video
  // the still is a stand-in, kept by nobody (STAND_IN_CACHE).
  var fallback = (await serve(key + '.v', STILL)) || (await serve(key + '.t', STILL));
  if (fallback) return fallback;
  return json({ error: 'That file has no copy that can be shown here yet.' }, 404);
}

// ---------- the video encoders ----------
// Workers cannot run ffmpeg, so on the day organisers run
// scripts/encoder.mjs on their own computers: each asks for a video,
// downloads it, encodes 480p/720p/1080p copies and sends them back.
// These are the endpoints they talk to. Any number of machines can
// work at once and they need no coordinating — see the claim. They
// are not called from a browser, so they carry no CORS, and
// ENCODER_KEY is the whole credential.
//
// The videos are proof (submission_files, sub/ keys) and album uploads
// (album_photos, alb/ keys, see albums.ts). Both tables carry the same
// status and encode columns, the key says which table a file is in,
// and proof comes first in the queue.

function videoTable(key: unknown): string {
  return String(key || '').indexOf('alb/') === 0 ? 'album_photos' : 'submission_files';
}

async function encoderGuard(request: Request, env: Env): Promise<Response | null> {
  if (!configured(env.ENCODER_KEY)) {
    return plainJson({ error: 'The encoder is locked until ENCODER_KEY is set on the worker (see ENCODER.md).' }, 503);
  }
  if (!(await secretMatches(bearerToken(request), env.ENCODER_KEY))) {
    // The 401 already tells anyone guessing that they guessed wrong,
    // so naming what did not match gives nothing away — and it is the
    // one thing the organiser running the encoder needs to hear.
    return plainJson({
      error: 'the key does not match the worker\'s ENCODER_KEY. ' +
        'Check what --key was given against the value in secrets.json, ' +
        'and remember npm run secrets uploads every secret in that file.'
    }, 401);
  }
  return null;
}

function encoderFile(db: D1Database, key: unknown): Promise<EncoderFile | null> {
  key = String(key || '');
  if (videoTable(key) === 'album_photos') {
    return db.prepare(
      "SELECT p.id, p.r2_key, p.name, p.bytes, p.content_type, p.encode_state, p.status, 'album_photos' AS tbl, " +
      "COALESCE(t.name, NULLIF(p.added_by, ''), 'an album') AS team_name " +
      'FROM album_photos p LEFT JOIN teams t ON t.id = p.team_id WHERE p.r2_key = ?1'
    ).bind(key).first<EncoderFile>();
  }
  return db.prepare(
    "SELECT f.id, f.r2_key, f.name, f.bytes, f.content_type, f.encode_state, f.status, 'submission_files' AS tbl, " +
    't.name AS team_name ' +
    'FROM submission_files f JOIN submissions s ON s.id = f.submission_id ' +
    'LEFT JOIN teams t ON t.id = s.team_id WHERE f.r2_key = ?1'
  ).bind(key).first<EncoderFile>();
}

// A video nobody is working on: never claimed, or claimed by a runner
// that then went quiet for CLAIM_MINUTES, which is how a machine that
// was closed mid-file leaves nothing stuck.
var FREE_FOR_ENCODING =
  "content_type LIKE 'video/%' AND status = 'ready' AND (encode_state = '' OR " +
  "(encode_state = 'encoding' AND encode_claimed_at < datetime('now', '-" + CLAIM_MINUTES + " minutes')))";

// Put every video that is not finished back on the pile.
//
// Two ways one falls off it. A machine holds a video while it works,
// and lets go by itself only after CLAIM_MINUTES — right for a runner
// that died, a long wait when you know it died. And a run that came
// back with nothing is recorded 'skipped', which is meant for a video
// that genuinely cannot be encoded but catches every passing failure
// too: a closed laptop, a wrong key, a download that broke. **Skipped
// is not a verdict, it is the last thing that happened**, so it must
// be visible and it must be retryable — one that is neither is a video
// nobody will ever see, since nothing public serves an original.
//
// If a machine really is mid-encode it carries on and uploads as
// normal; another may start the same video and the second copy
// replaces the first. Wasted effort, not a broken file.
function changed(res: D1Result | null | undefined): number {
  return (res && res.meta ? (res.meta.changes != null ? res.meta.changes : res.meta.rows_written) : 0) || 0;
}

export async function retryVideos(env: Env): Promise<{ held: number; failed: number; freed: number }> {
  var held = 0;
  var failed = 0;
  for (var table of ['submission_files', 'album_photos']) {
    var reset = "UPDATE " + table + " SET encode_state = '', encode_claimed_at = '' WHERE encode_state = ";
    held += changed(await env.DB.prepare(reset + "'encoding'").run());
    failed += changed(await env.DB.prepare(reset + "'skipped'").run());
  }
  await env.DB.prepare("UPDATE encoders SET state = 'idle', working_on = ''").run();
  return { held: held, failed: failed, freed: held + failed };
}

// The heartbeat, every ten seconds: one machine says what it is doing
// and is shown what is waiting. Several machines can run at once — the
// work is handed out by them asking for it one video at a time, so a
// faster machine simply asks again sooner and there is no scheduler to
// get wrong.
async function encoderPoll(env: Env, body: JsonBody, name: string): Promise<Response> {
  var state = body.state === 'encoding' ? 'encoding' : 'idle';
  var workingOn = cleanText(body.working_on, 200);
  await env.DB.prepare(
    "INSERT INTO encoders (name, last_seen, state, working_on) VALUES (?1, datetime('now'), ?2, ?3) " +
    "ON CONFLICT(name) DO UPDATE SET last_seen = datetime('now'), state = ?2, working_on = ?3"
  ).bind(name, state, workingOn).run();
  var jobs: Job[] = [];
  var waiting = { n: 0, bytes: 0 };
  for (var table of ['submission_files', 'album_photos']) {
    var list = await env.DB.prepare(
      'SELECT r2_key AS key, name, bytes, content_type AS type FROM ' + table +
      ' WHERE ' + FREE_FOR_ENCODING + ' ORDER BY id LIMIT ?1'
    ).bind(Math.max(0, 5 - jobs.length)).all<Job>();
    var count = await env.DB.prepare(
      'SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS bytes FROM ' + table + ' WHERE ' + FREE_FOR_ENCODING
    ).first<{ n: number; bytes: number }>() as { n: number; bytes: number };
    jobs = jobs.concat(list.results);
    waiting.n += count.n;
    waiting.bytes += count.bytes;
  }
  return plainJson({ ok: true, jobs: jobs, waiting: waiting.n, waiting_bytes: waiting.bytes });
}

// Taking one video. Two machines will ask for the same one sooner or
// later, so the taking is the conditional write itself: whoever's
// UPDATE changes the row has it, and the other is told to go and poll
// again. Nothing else keeps them apart.
async function encoderClaim(env: Env, body: JsonBody, name: string): Promise<Response> {
  var row = await encoderFile(env.DB, body.key);
  if (!row) return plainJson({ error: 'no such file' }, 404);
  if (row.encode_state === 'done') return plainJson({ error: 'already encoded' }, 409);
  // the stamp goes back to the machine, which sends it with finish: it
  // is how finish tells this claim from a later one on the same video
  var took = await env.DB.prepare(
    'UPDATE ' + row.tbl + " SET encode_state = 'encoding', encode_claimed_at = datetime('now') " +
    'WHERE id = ?1 AND ' + FREE_FOR_ENCODING + ' RETURNING encode_claimed_at'
  ).bind(row.id).first<{ encode_claimed_at: string }>();
  if (!took) return plainJson({ error: 'another encoder has that one' }, 409);
  await env.DB.prepare(
    "UPDATE encoders SET state = 'encoding', working_on = ?2 WHERE name = ?1"
  ).bind(name, row.r2_key).run();
  return plainJson({ ok: true, key: row.r2_key, name: row.name, claimed_at: took.encode_claimed_at });
}

async function encoderSource(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.SUBMIT) return plainJson({ error: 'no SUBMIT bucket bound' }, 503);
  var key = url.searchParams.get('key') || '';
  if (key.indexOf('sub/') !== 0 && key.indexOf('alb/') !== 0) return plainJson({ error: 'not found' }, 404);
  var row = await encoderFile(env.DB, key);
  if (!row) return plainJson({ error: 'not found' }, 404);
  if (row.status === 'uploading') return plainJson({ error: 'that file is still uploading' }, 409);
  // With the R2 token set, a runner that asks for it is given an address
  // to read the file from R2 itself, so a long video does not pass
  // through the worker's memory on its way to the encoder. A runner
  // that does not ask is sent the bytes.
  if (url.searchParams.get('signed') === '1' && directReady(env)) {
    if (!(await env.SUBMIT.head(key))) return plainJson({ error: 'not found' }, 404);
    return plainJson({ ok: true, url: await directGetUrl(env, key) }, 200, { 'cache-control': 'private, no-store' });
  }
  return (await serveStoredFile(env.SUBMIT, request, key, 'private, no-store')) ||
    plainJson({ error: 'not found' }, 404);
}

// Which copy is being sent: one of the rendition heights, or the
// clean one.
function renditionHeight(raw: unknown): Height | { error: string } {
  var wanted = String(raw == null ? '' : raw);
  if (wanted === 'clean') return { clean: true, height: 0 };
  var height = Math.round(Number(wanted));
  if (RENDITION_HEIGHTS.indexOf(height) === -1) {
    return { error: 'height must be clean, or one of ' + RENDITION_HEIGHTS.join(', ') };
  }
  return { clean: false, height: height };
}

// Where that copy goes. A rendition lands under its own random key, so
// an old copy of the same height is replaced rather than overwritten —
// the row and the bytes it pointed at both go. The clean copy is not a
// rendition and gets no row: it lives at `<key>.c`, the same place and
// the same meaning as a photo's clean copy, and it is what the site
// serves at Original.
function renditionTarget(row: Pick<EncoderFile, 'r2_key'>, clean: boolean): string {
  return clean ? row.r2_key + '.c' : 'rnd/' + randomKey(12);
}

// Could this endpoint have handed this key out? The slice calls carry
// the destination back and forth, so its shape is checked rather than
// taken on trust: a rendition's own key, or a submission file's clean
// copy beside it. The slices themselves cannot tell which they are
// building, but the call that finishes one knows, and asks the
// narrower question — a rendition row must never come to point at
// some other file's clean copy.
function isRenditionKey(stored: string): boolean {
  return /^rnd\/[A-Za-z0-9_-]{16}$/.test(stored);
}

function isRenditionTarget(stored: string): boolean {
  // proof keys were sub/<submission>/<random> until the files began
  // going in before the submission's row, and are sub/<random> since;
  // an album's are alb/<random>
  return isRenditionKey(stored) || /^sub\/(\d+\/)?[A-Za-z0-9_-]{16}\.c$/.test(stored) ||
    /^alb\/[A-Za-z0-9_-]{16}\.c$/.test(stored);
}

// sending a copy counts as calling in: a long upload should not read
// as a machine that has gone
function touchEncoder(env: Env, name: string): Promise<D1Result> {
  return env.DB.prepare("UPDATE encoders SET last_seen = datetime('now') WHERE name = ?1").bind(name).run();
}

function renditionAnswer(out: { ok: boolean }): Response {
  return plainJson(out, out.ok ? 200 : 409);
}

// The bytes are in R2 by now, whole. This is what it means afterwards.
async function recordRendition(env: Env, row: EncoderFile, want: Height, stored: string, size: number, name: string): Promise<{ ok: boolean; clean?: boolean; height?: number; bytes: number; error?: string }> {
  if (want.clean) {
    await touchEncoder(env, name);
    return { ok: true, clean: true, bytes: size };
  }
  // Two machines on one video can send the same height at once. The row
  // is replaced only while it still names the copy read here, and the
  // insert only lands once it is gone, so whichever loses reads again:
  // every copy replaced is one this request deletes, and none is left
  // in the bucket with nothing pointing at it.
  for (var attempt = 0; attempt < 5; attempt++) {
    var old = await env.DB.prepare(
      'SELECT key FROM submission_renditions WHERE file_key = ?1 AND height = ?2'
    ).bind(row.r2_key, want.height).first<Pick<SubmissionRenditionRow, 'key'>>();
    var swapped = await env.DB.batch([
      env.DB.prepare('DELETE FROM submission_renditions WHERE file_key = ?1 AND height = ?2 AND key = ?3')
        .bind(row.r2_key, want.height, old ? old.key : ''),
      env.DB.prepare(
        'INSERT INTO submission_renditions (file_key, height, key, bytes) SELECT ?1, ?2, ?3, ?4 ' +
        'WHERE NOT EXISTS (SELECT 1 FROM submission_renditions WHERE file_key = ?1 AND height = ?2)'
      ).bind(row.r2_key, want.height, stored, size)
    ]);
    if (swapped[1].meta && swapped[1].meta.changes) {
      if (old && old.key && old.key !== stored && env.SUBMIT.delete) {
        try { await env.SUBMIT.delete(old.key); } catch (err) { /* the row is gone either way */ }
      }
      await touchEncoder(env, name);
      return { ok: true, height: want.height, bytes: size };
    }
  }
  // lost every time: this copy is nobody's
  try { await env.SUBMIT.delete(stored); } catch (err) { /* nothing points at it */ }
  return { ok: false, error: 'Another copy of that height was being saved at the same time. Send it again.', bytes: size };
}

// One finished copy, whole, in one request. Anything that will not fit
// in one goes through the slice calls below instead.
async function encoderRendition(request: Request, env: Env, url: URL, name: string): Promise<Response> {
  if (!env.SUBMIT) return plainJson({ error: 'no SUBMIT bucket bound' }, 503);
  var want = renditionHeight(url.searchParams.get('height'));
  if ('error' in want) return plainJson({ error: want.error }, 400);
  var row = await encoderFile(env.DB, url.searchParams.get('key') || '');
  if (!row) return plainJson({ error: 'no such file' }, 404);
  var cap = want.clean ? MAX_CLEAN_BYTES : MAX_RENDITION_BYTES;
  var tooBig = 'That copy is bigger than one request carries. Send it in slices.';
  var declared = Number(request.headers.get('content-length') || 0);
  if (declared > cap) return plainJson({ error: tooBig }, 413);
  var bytes = await request.arrayBuffer();
  if (bytes.byteLength > cap) return plainJson({ error: tooBig }, 413);
  var stored = renditionTarget(row, want.clean);
  await env.SUBMIT.put(stored, bytes, { httpMetadata: { contentType: 'video/mp4' } });
  return renditionAnswer(await recordRendition(env, row, want, stored, bytes.byteLength, name));
}

// A still for a video that has none. The page makes one as the video
// goes up, from a frame the browser decodes, and a browser that cannot
// decode it (an iPhone's HEVC in Firefox, a long video that takes more
// than the page waits) sends the video without one, which left its
// tile blank. The encoder takes a frame from a copy it made and sends
// it here. A still already there is kept: it is the one the page made.
async function encoderStill(request: Request, env: Env, url: URL, name: string): Promise<Response> {
  if (!env.SUBMIT) return plainJson({ error: 'no SUBMIT bucket bound' }, 503);
  var row = await encoderFile(env.DB, url.searchParams.get('key') || '');
  if (!row) return plainJson({ error: 'no such file' }, 404);
  if (String(row.content_type || '').indexOf('video/') !== 0) return plainJson({ error: 'that file is not a video' }, 400);
  var tooBig = 'A still is a JPEG or PNG of up to ' + Math.round(MAX_THUMB_BYTES / 1024) + 'KB.';
  if (Number(request.headers.get('content-length') || 0) > MAX_THUMB_BYTES) return plainJson({ error: tooBig }, 413);
  var bytes = await request.arrayBuffer();
  var key = row.r2_key + '.t';
  if (typeof env.SUBMIT.head === 'function' && (await env.SUBMIT.head(key))) {
    await touchEncoder(env, name);
    return plainJson({ ok: true, kept: true });
  }
  var blob = new Blob([bytes], { type: request.headers.get('content-type') || '' });
  if (!(await storePreview(env, key, blob, MAX_THUMB_BYTES))) return plainJson({ error: tooBig }, 400);
  await touchEncoder(env, name);
  return plainJson({ ok: true, stored: true });
}

// ---------- a copy too big for one request ----------
//
// A long video's clean copy is the source repackaged, so it is the
// source's size, and the source got here in slices in the first place.
// These three calls are the submit page's sliced upload for the
// encoder: R2 takes the parts, R2 stitches them, and nothing in
// between has to hold a whole video in memory.
//
// The encoder keeps the upload id and the part tags between calls, so
// there is no table here. One machine is sending one file, and a
// machine that dies part-way leaves an unfinished multipart upload
// that R2 clears out on its own.
//
// With the R2 token set (r2direct.ts), start opens the upload over R2's
// own API and answers `direct: true`, and the runner sends every copy
// this way whatever its size: it asks upload/sign for each slice's
// address and sends the slice to R2 there, so the worker never holds a
// copy. Its id carries the `r2:` mark, which is how the other calls
// tell the two kinds apart, and finish asks R2 which slices arrived.

function noSlices(env: Env): boolean {
  return !env.SUBMIT || typeof env.SUBMIT.createMultipartUpload !== 'function' ||
    typeof env.SUBMIT.resumeMultipartUpload !== 'function';
}

async function encoderUploadStart(env: Env, body: JsonBody, name: string): Promise<Response> {
  var direct = directReady(env);
  if (!direct && noSlices(env)) return plainJson({ error: 'this bucket cannot take a sliced upload' }, 503);
  var want = renditionHeight(body.height);
  if ('error' in want) return plainJson({ error: want.error }, 400);
  var row = await encoderFile(env.DB, body.key);
  if (!row) return plainJson({ error: 'no such file' }, 404);
  var bytes = Math.round(Number(body.bytes));
  if (!isFinite(bytes) || bytes < 1) {
    return plainJson({ error: 'bytes must say how big the whole copy is' }, 400);
  }
  var stored = renditionTarget(row, want.clean);
  var upload: string;
  if (direct) {
    try { upload = markDirect(await directStart(env, stored, 'video/mp4')); } catch (err) {
      return plainJson({ error: 'Storage could not be reached. Try again.' }, 502);
    }
  } else {
    upload = (await env.SUBMIT.createMultipartUpload(stored, { httpMetadata: { contentType: 'video/mp4' } })).uploadId;
  }
  await touchEncoder(env, name);
  return plainJson({
    ok: true, upload: upload, stored: stored, direct: direct,
    part_size: PART_BYTES, parts: partsOf(bytes, PART_BYTES)
  });
}

// The address one slice of a direct upload is sent to, asked for again
// on every try so none has to outlive a slow connection. The worker
// never sees the slice, so it cannot check its length here; finish
// counts only the slices R2 holds at their full size.
async function encoderUploadSign(env: Env, url: URL, name: string): Promise<Response> {
  var stored = url.searchParams.get('stored') || '';
  var upload = url.searchParams.get('upload') || '';
  if (!upload || !isRenditionTarget(stored)) return plainJson({ error: 'not found' }, 404);
  if (!directMarked(upload)) return plainJson({ error: 'this copy goes through the worker' }, 409);
  // R2 numbers a multipart upload's parts 1 to 10000
  var n = Math.round(Number(url.searchParams.get('n')));
  if (!n || n < 1 || n > 10000) return plainJson({ error: 'bad slice number' }, 400);
  if (!directReady(env)) return plainJson({ error: 'Storage is not set up for direct uploads.' }, 503);
  var signed = await directPartUrl(env, stored, directIdOf(upload), n);
  await touchEncoder(env, name);
  return plainJson({ ok: true, n: n, url: signed }, 200, { 'cache-control': 'private, no-store' });
}

// One slice. Its body is the video, so this one names its machine and
// says where it belongs in the query string.
async function encoderUploadPart(request: Request, env: Env, url: URL, name: string): Promise<Response> {
  if (noSlices(env)) return plainJson({ error: 'this bucket cannot take a sliced upload' }, 503);
  var stored = url.searchParams.get('stored') || '';
  var upload = url.searchParams.get('upload') || '';
  if (!upload || !isRenditionTarget(stored)) return plainJson({ error: 'not found' }, 404);
  if (directMarked(upload)) return plainJson({ error: 'this copy goes straight to storage' }, 409);
  var whole = Math.round(Number(url.searchParams.get('bytes')));
  if (!isFinite(whole) || whole < 1) return plainJson({ error: 'bad size' }, 400);
  var count = partsOf(whole, PART_BYTES);
  var n = Math.round(Number(url.searchParams.get('n')));
  if (!n || n < 1 || n > count) return plainJson({ error: 'bad slice number' }, 400);
  // R2 wants every part the same size except the last, so a slice that
  // is not the size it should be is caught here rather than at the end
  var expect = n < count ? PART_BYTES : whole - PART_BYTES * (count - 1);
  var bytes = await request.arrayBuffer();
  if (bytes.byteLength !== expect) {
    return plainJson({ error: 'slice ' + n + ' should be ' + expect + ' bytes, got ' + bytes.byteLength }, 400);
  }
  var sent = await env.SUBMIT.resumeMultipartUpload(stored, upload).uploadPart(n, bytes);
  await touchEncoder(env, name);
  return plainJson({ ok: true, n: n, etag: sent.etag });
}

async function encoderUploadFinish(env: Env, body: JsonBody, name: string): Promise<Response> {
  var direct = directMarked(body.upload);
  if (!direct && noSlices(env)) return plainJson({ error: 'this bucket cannot take a sliced upload' }, 503);
  var want = renditionHeight(body.height);
  if ('error' in want) return plainJson({ error: want.error }, 400);
  var row = await encoderFile(env.DB, body.key);
  if (!row) return plainJson({ error: 'no such file' }, 404);
  var stored = String(body.stored || '');
  var mine = want.clean ? stored === row.r2_key + '.c' : isRenditionKey(stored);
  if (!mine) return plainJson({ error: 'not found' }, 404);
  var whole = Math.round(Number(body.bytes));
  if (!isFinite(whole) || whole < 1) return plainJson({ error: 'bad size' }, 400);
  if (direct) {
    if (!directReady(env)) return plainJson({ error: 'Storage is not set up for direct uploads.' }, 503);
    // the worker saw none of the slices, so R2 says which arrived, and
    // every one has to be there at its full size for `whole`
    var problem = await directJoin(env, stored, directIdOf(body.upload), whole, PART_BYTES);
    if (problem) return plainJson({ error: problem.error }, problem.status);
    return renditionAnswer(await recordRendition(env, row, want, stored, whole, name));
  }
  var count = partsOf(whole, PART_BYTES);
  var parts = (Array.isArray(body.parts) ? body.parts : []).map(function (p) {
    return { partNumber: Math.round(Number(prop(p, 'n'))), etag: String(prop(p, 'etag') || '') };
  });
  if (parts.length !== count) {
    return plainJson({ error: parts.length + ' of ' + count + ' slices arrived' }, 409);
  }
  var done: R2Object;
  try {
    done = await env.SUBMIT.resumeMultipartUpload(stored, String(body.upload || '')).complete(parts);
  } catch (err) {
    return plainJson({ error: 'The slices could not be stitched together. Send that copy again.' }, 500);
  }
  var size = done && done.size != null ? done.size : whole;
  return renditionAnswer(await recordRendition(env, row, want, stored, size, name));
}

// A copy the encoder gave up on part-way. Saying so is what stops the
// half-sent parts sitting in the bucket until R2 times them out.
async function encoderUploadAbort(env: Env, body: JsonBody, name: string): Promise<Response> {
  var stored = String(body.stored || '');
  var upload = String(body.upload || '');
  if (isRenditionTarget(stored)) {
    try {
      if (directMarked(upload)) {
        if (directReady(env)) await directAbort(env, stored, directIdOf(upload));
      } else if (!noSlices(env)) {
        await env.SUBMIT.resumeMultipartUpload(stored, upload).abort();
      }
    } catch (err) { /* never started, or already gone */ }
  }
  await touchEncoder(env, name);
  return plainJson({ ok: true });
}

// A machine is finished with a file, whether or not anything came of
// it. This is the one encoder call that writes to the log — the poll
// fires every ten seconds and would drown it. A finished encode also
// adds to that machine's tally, which is where the dashboard's pace
// per machine comes from.
async function encoderFinish(env: Env, body: JsonBody, name: string): Promise<Response> {
  var row = await encoderFile(env.DB, body.key);
  if (!row) return plainJson({ error: 'no such file' }, 404);
  var heights = (Array.isArray(body.heights) ? body.heights : [])
    .map(function (h) { return Math.round(Number(h)); })
    .filter(function (h) { return RENDITION_HEIGHTS.indexOf(h) !== -1; });
  var note = cleanText(body.note, 200);
  var took = Math.round(Number(body.took_ms));
  if (!isFinite(took) || took < 0) took = 0;
  var state = heights.length ? 'done' : 'skipped';
  var what = heights.length ? heights.map(function (h) { return h + 'p'; }).join(' + ') : 'nothing made';
  // A finish that made copies marks the video done whoever holds it now:
  // the copies are saved. One that made nothing only lands on the claim
  // it was given (`claimed_at`, from claim; a runner that sends none is
  // held to the video still being claimed), so a machine whose claim ran
  // out cannot turn another machine's done, or live claim, into skipped.
  var claimedAt = cleanText(body.claimed_at, 40);
  var marked = await env.DB.prepare(
    'UPDATE ' + row.tbl + " SET encode_state = ?2, encode_claimed_at = '' WHERE id = ?1 AND (" +
    "(?2 = 'done' AND encode_state != 'done') OR " +
    "(?2 = 'skipped' AND encode_state = 'encoding' AND (?3 = '' OR encode_claimed_at = ?3)))"
  ).bind(row.id, state, claimedAt).run();
  if (!(marked.meta && marked.meta.changes)) {
    await env.DB.prepare("UPDATE encoders SET state = 'idle', working_on = '' WHERE name = ?1").bind(name).run();
    var now = await encoderFile(env.DB, row.r2_key);
    return plainJson({ ok: true, key: row.r2_key, state: now ? now.encode_state : state, heights: heights, kept: true });
  }
  var writes = [
    env.DB.prepare(
      'INSERT INTO submission_log (action, team_name, quest_code, points_delta, old_total, new_total, actor) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
    ).bind('encode-done', row.team_name || (row.name || 'a file'),
      what + (note ? ' — ' + note : ''), 0, 0, 0, 'encoder:' + name)
  ];
  if (state === 'done') {
    writes.push(env.DB.prepare(
      "UPDATE encoders SET state = 'idle', working_on = '', jobs_done = jobs_done + 1, encode_ms = encode_ms + ?2 " +
      'WHERE name = ?1'
    ).bind(name, took));
  } else {
    writes.push(env.DB.prepare("UPDATE encoders SET state = 'idle', working_on = '' WHERE name = ?1").bind(name));
  }
  await env.DB.batch(writes);
  // a finished video plays in the albums, its own or the gallery's
  await bumpCounter(env.DB, 'albums');
  return plainJson({ ok: true, key: row.r2_key, state: state, heights: heights });
}

// What the dashboard's Review tab shows: every machine that has ever
// called in, whether it is still there, and how much is waiting on
// them between them. The day board on the Scores tab reads the same
// numbers, so the counting lives here once.
export async function encoderStatus(env: Env): Promise<Response> {
  return plainJson(await encoderSummary(env));
}

export async function encoderSummary(env: Env): Promise<EncoderSummary> {
  var counts: Record<string, number> = { waiting: 0, encoding: 0, done: 0, skipped: 0 };
  for (var table of ['submission_files', 'album_photos']) {
    var some = await env.DB.prepare(
      "SELECT COALESCE(SUM(CASE WHEN encode_state = '' THEN 1 ELSE 0 END), 0) AS waiting, " +
      "COALESCE(SUM(CASE WHEN encode_state = 'encoding' THEN 1 ELSE 0 END), 0) AS encoding, " +
      "COALESCE(SUM(CASE WHEN encode_state = 'done' THEN 1 ELSE 0 END), 0) AS done, " +
      // counted and shown, because a skipped video is out of the queue
      // and there is nothing else to notice it by
      "COALESCE(SUM(CASE WHEN encode_state = 'skipped' THEN 1 ELSE 0 END), 0) AS skipped " +
      'FROM ' + table + " WHERE content_type LIKE 'video/%' AND status = 'ready'"
    ).first<Record<string, number>>();
    if (some) {
      var got = some;
      Object.keys(counts).forEach(function (k) { counts[k] += got[k]; });
    }
  }
  var rows = await env.DB.prepare(
    'SELECT e.name, e.last_seen, e.state, e.working_on, e.jobs_done, e.encode_ms, ' +
    "(e.last_seen != '' AND e.last_seen > datetime('now', '-45 seconds')) AS online, " +
    'COALESCE((SELECT f.name FROM submission_files f WHERE f.r2_key = e.working_on), ' +
    '(SELECT p.name FROM album_photos p WHERE p.r2_key = e.working_on)) AS working_name ' +
    'FROM encoders e ORDER BY e.name'
  ).all<Pick<EncoderRow, 'name' | 'last_seen' | 'state' | 'working_on' | 'jobs_done' | 'encode_ms'> & { online: number; working_name: string | null }>();
  return {
    ok: true,
    waiting: counts.waiting,
    encoding: counts.encoding,
    done: counts.done,
    skipped: counts.skipped,
    encoders: rows.results.map(function (e) {
      return {
        name: e.name,
        online: !!e.online,
        last_seen: e.last_seen,
        state: e.state,
        working_on: e.working_on,
        working_name: e.working_name || '',
        jobs_done: e.jobs_done,
        avg_ms: e.jobs_done ? Math.round(e.encode_ms / e.jobs_done) : 0
      };
    })
  };
}

// ---------- router: /api/encoder/* ----------

export async function handleEncoderApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  var path = url.pathname;
  if (path.indexOf('/api/encoder/') !== 0) return null;
  var action = path.slice('/api/encoder/'.length);
  var needsName = 'Every call must say which machine it is (name).';

  var denied = await encoderGuard(request, env);
  if (denied) return denied;

  // The source video, whole, for the machine that is going to encode
  // it. The public endpoint stopped handing originals over — that is
  // the whole point of it — but the encoder is what *makes* the copy
  // everyone else is served, so it has to be able to read the thing it
  // is copying. ENCODER_KEY is what separates the two: this is the
  // only way to an original besides a dashboard session.
  if (request.method === 'GET' && action === 'source') {
    return encoderSource(request, env, url);
  }
  // These carry the video itself or have no body, so they name their
  // machine in the query string; the rest name it in their JSON.
  var queryName = cleanText(url.searchParams.get('name'), 40);
  if (request.method === 'GET' && action === 'upload/sign') {
    if (!queryName) return plainJson({ error: needsName }, 400);
    return encoderUploadSign(env, url, queryName);
  }
  if (request.method === 'PUT' && (action === 'rendition' || action === 'upload/part' || action === 'still')) {
    if (!queryName) return plainJson({ error: needsName }, 400);
    if (action === 'still') return encoderStill(request, env, url, queryName);
    return action === 'rendition'
      ? encoderRendition(request, env, url, queryName)
      : encoderUploadPart(request, env, url, queryName);
  }
  if (request.method !== 'POST') return plainJson({ error: 'not found' }, 404);

  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return plainJson({ error: 'body must be JSON' }, 400); }
  var name = cleanText(body.name, 40);
  if (!name) return plainJson({ error: needsName }, 400);

  if (action === 'poll') return encoderPoll(env, body, name);
  if (action === 'claim') return encoderClaim(env, body, name);
  if (action === 'finish') return encoderFinish(env, body, name);
  if (action === 'upload/start') return encoderUploadStart(env, body, name);
  if (action === 'upload/finish') return encoderUploadFinish(env, body, name);
  if (action === 'upload/abort') return encoderUploadAbort(env, body, name);
  return plainJson({ error: 'not found' }, 404);
}

// ---------- router: /api/submit/* ----------

export async function handleSubmitApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  var path = url.pathname;
  if (path.indexOf('/api/submit/') !== 0) return null;
  var action = path.slice('/api/submit/'.length);

  if (request.method === 'POST' && action === 'login') return login(request, env);
  // public: files by their unguessable keys, so a shared link works
  if (request.method === 'GET' && action === 'file') return serveTeamFile(env, request, url);
  // /api/submit/file/sub/<key>/<name>: the same file at a path that ends
  // in its name, which is how Discord tells a picture from a link (the
  // accepted-submission posts use it). The key is what is checked.
  var named = path.match(/^\/api\/submit\/file\/(sub\/.+)\/[^/]*$/);
  if (request.method === 'GET' && named) return serveTeamFile(env, request, url, decodeURIComponent(named[1]));

  var session = await requireTeam(request, env.DB);
  // the gallery opens to any signed-in team, and to organisers on a
  // dashboard session (the closing-ceremony slideshow runs from one)
  if (request.method === 'GET' && action === 'gallery') {
    if (!session && !(await organiserSession(request, env.DB))) {
      return json({ error: 'not signed in' }, 401);
    }
    return galleryList(env);
  }
  if (!session) return json({ error: 'not signed in' }, 401);

  if (request.method === 'POST' && action === 'create') return create(request, env, session);
  if (request.method === 'GET' && action === 'mine') return mine(env, session, cleanText(url.searchParams.get('quest'), 40));
  if (request.method === 'GET' && action === 'score') return scoreSheet(env, session);
  if (request.method === 'POST' && action === 'gallery') return setGallery(request, env, session);
  // whether files go straight to R2, asked before a send
  if (request.method === 'GET' && action === 'upload/mode') {
    return json({ ok: true, direct: directReady(env), part_size: PART_BYTES }, 200, NO_STORE);
  }
  if (request.method === 'GET' && action === 'upload/sign') return uploadSign(env, session, url);
  if (request.method === 'GET' && action === 'upload/status') return uploadStatus(env, session, url);
  if (request.method === 'PUT' && action === 'upload/part') return uploadPart(request, env, session, url);
  if (request.method === 'POST' && action === 'upload/finish') return uploadFinish(request, env, session);
  if (request.method === 'POST' && action === 'upload/abort') return uploadAbort(request, env, session);
  return json({ error: 'not found' }, 404);
}
