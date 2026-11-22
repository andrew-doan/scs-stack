// The tab console — how the tab team runs the event without Discord
// commands: add and remove quests and teams, put scores on the tab,
// and read the audit log, all from /dash. Modelled on how debating
// tab software (Tabbycat) runs its tournament console: everything the
// staff do goes through small server-checked actions, every change
// lands in the log with who did it, and destructive actions make you
// type the name of the thing you are destroying.
//
// Each organiser has an account an admin made: a name, a password of
// its own, the tabs it may use, and whether it needs a code from an
// authenticator app. /api/console/login exchanges those for an 18-hour
// session token held in D1, and every endpoint re-checks the token and
// what the account behind it may do (dash-access.ts).

import { normQuest, serveStoredFile, json, cleanText, configured, secretMatches, randomKey, bearerToken, delay, utcStamp, animatedType, settingValue, setSetting, mintCode, asDownload, deleteStored, headStored, servePickedFile, errorMessage, fields, prop, NEXT_TEAM_ID, retireTeamId, uniqueClash, emailsHeld, emailOffRefusal } from './shared.ts';
import { eoiRead, eoiList, eoiPoints, eoiAward } from './eoi.ts';
import { phoneRead, phoneSettingsSave, payphoneSave, phonePinNew, forgetPhoneTeam, phoneTreeSave, phoneMessageAudio, phoneMessageHeard, phoneMessageDelete } from './phone.ts';
import { randomSecret, secretInGroups, otpauthUrl, qrDataUri, verifyCode, makeBackupCodes, hashBackupCode, cleanBackupCode } from './totp.ts';
import { readExif } from './strip.ts';
import { fileKindOf, rulesOf, MAX_FILES_LIMIT } from './rules.ts';
import { SUM_POINTS, amountFor, tabCsv, questsDone, submitTimes, standings, lastPlace, reservedCode } from './tab.ts';
import { DELETED_CODE, holderStatement, holdStatements, nameDeleted, cameFrom, deletedName } from './deleted.ts';
import { readTrack } from './track.ts';
import { partOf, partsFor, creditJson, creditWorth, negated } from './parts.ts';
import { sendTeamPush, pushConfigured, sendAllPush, pushToTeam, pushToDevice, pushesOff,
  pushDevices, nameDevice, outboxWaiting } from './push.ts';
import { attachMedia, parseAnswer, cleanAnswer, renditionKey, largestRendition, wantsSmaller, encoderStatus, encoderSummary, retryVideos, takenOf, recordTaken, pickedOf, MAX_PENDING } from './submit.ts';
import { metaBlock } from './photoserve.ts';
import { regoOverview, regoCsv, regoResync, regoResendEmail, regoPersonQr, regoTeamSave, regoPersonSave, regoPersonDelete, regoPersonMove, regoHide, regoTeamCreate, regoPlace, regoSettings, regoSettingsSet, checkinStatus, syncCheckinHiddenLater, renameCheckinTeam, moveTeamCheckins, ticketsOutstanding, regoEmail, demoQrUrl, turnstileOk, turnstileSiteKey, reservedTeamName, reconcileCheckinsLater } from './rego.ts';
import { announceList, announcePreview, announceTest, announceSend, announceStep, announceStop, announceRetry, emailsWaiting } from './announce.ts';
import { handleDiscordConsole, renameTeamDiscord } from './discord.ts';
import { scopeCodes, inScope, outOfScope, readCreditFrom, worthOf, readCredit, partMarks, partFields, parseQuestKeys, tellTeam, teamTotal, pointsForm, pointsAdd, pointsUndo, pointsRedo, pointsTime, ledgerAdjust, ledgerVoid, dashProofFiles, writeDashProof } from './points.ts';
import { ledgerReady, behind, LEDGER_BEHIND, creditLines, relineSubmission, voidSource, rescoreLines, claimed, codesThere, codeGone, runLedgerCheck, lastLedgerCheck } from './ledger.ts';
import { allGroups, renameStatements, saveGroup, deleteGroup, retireAll, importScs2, saveRegion, deleteRegion, orderRegions, setRegionColour, exportQuests, importQuestsPreview, importQuestsCommit, saveGroupFiles, deleteGroupFile, saveGroupAsk, groupAskResponses, openGroupAsk, groupAsks, settleGroupAsk, unsettleGroupAsk,
  setGroupAccess, saveTag, deleteTag, applyTag, openEverything, saveAudience, deleteAudience, visibleKeys, orderRegionQuests, storedRules, questionsByGroup, rulesForGroup,
  renameInScopes, dropFromScopes, strandedRefusal } from './quests.ts';
import { PLACES } from './data/places.ts';
import { bumpCounter, messagesList, saveMessage, deleteMessage, deleteMessageFile, archiveMessage, orderMessages, countersRead, counterSet } from './messages.ts';
import { trySendEmail, emailConfigured, emailHoldRead, emailHoldSet } from './email.ts';
import { tabState, freezeState, setFrozen, setClosed, renderSnapshot, saveCopy, listCopies, readCopy, copyBefore, copyBoard } from './freeze.ts';
import { flagsRead, flagSet, forgetPhotoPlaces, recapConsole, afterSettings, recapHoursSet, recapReviewSet, teamTimesSet, arrivalsSet, mostSkipSet, questViewSet, lastUntilSet, rankBoards, rankBoardsSet, rankRecap, rankRecapSet, boardTeams, recapSectionsRead, recapSectionsSet, dateRulesSet } from './recap.ts';
import { countdownRead, countdownSet } from './countdown.ts';
import { dropList, dropUpload, dropEdit, dropDelete, linkSave, linkDelete } from './drop.ts';
import { linkPageRead, linkPageSettings, linkPageSave, linkPageDelete, linkPageOrder } from './linkpage.ts';
import { teamMap } from './team-map.ts';
import { tallyBoard, tallyTeam, tallyAward, tallyUnaward } from './tally.ts';
import { albumsConsole, forgetTeam, ANYONE_PER_HOUR } from './albums.ts';
import { slidesList, slideSave, slideEdit, slideFocus, slideHide, slideDelete, slideOrder, slideStepSet } from './slides.ts';
import { stagedConsole } from './staged.ts';
import { isDirect, directAbort, directIdOf } from './r2direct.ts';
import { tracksConsole, forgetTrack } from './tracks.ts';
import { privacyConsole } from './privacy.ts';
import { originalsConsole } from './originals.ts';
import { storageScan } from './storage.ts';
import { PERMS, parsePerms, allowed, guardFor, guardByKey, guardStates, guardRefusal, secondPasswordRefusal,
  secondPasswordGiven, hashPassword, passwordMatches, MIN_PASSWORD } from './dash-access.ts';
import type { Answer, AnswerEntry, AwardRow, ConsoleSession, ConsoleUserRow, Credit, Ctx, DashCode, EncoderRow, EntryRow, Env, JsonBody, LogAction, MediaOut,
  ParticipantRow, Purge, PushPayload, QuestGroupRow, QuestRow, QuestRules, RenderPayload, SubmissionFileRow, SubmissionLogRow, SubmissionRow, TeamCodeRow, TeamRow } from './types.ts';
import type { Part, PartRow } from './parts.ts';
import type { PushOpts } from './webpush.ts';
import type { EmailMessageIn, EmailOutcome } from './email.ts';
import type { CopyListing, SavedCopy } from './freeze.ts';

// A dashboard account as sign-in reads it.
type Account = Pick<ConsoleUserRow, 'name' | 'secret' | 'confirmed_at' | 'last_step' | 'password_hash' | 'admin' | 'perms' | 'require_2fa'>;

// ---------- small helpers ----------

// The session and what its account may do, read together on every
// request, so a change an admin makes holds from the next one. A
// session whose account has gone is no session.
async function sessionByToken(db: D1Database, token: string): Promise<ConsoleSession | null> {
  if (!token) return null;
  var row = await db.prepare(
    'SELECT s.token, s.name, u.name AS account, u.admin, u.perms, u.quests FROM console_sessions s ' +
    'LEFT JOIN console_users u ON u.name = s.name ' +
    "WHERE s.token = ?1 AND s.expires_at > datetime('now')"
  ).bind(token).first<{ token: string; name: string; account: string | null; admin: number | null; perms: string | null; quests: string | null }>();
  if (!row || !row.account) return null;
  return {
    token: row.token, name: row.name, admin: !!row.admin, perms: parsePerms(row.perms),
    quests: row.admin ? [] : parseQuestKeys(row.quests)
  };
}

// <img>/<video> tags can't send an Authorization header, so the file
// endpoint alone also accepts the session from a cookie the page keeps
// scoped to /api/console/file. Nothing else reads it: writes still need
// the header.
function cookieToken(request: Request): string {
  var match = (request.headers.get('cookie') || '').match(/(?:^|;\s*)scs_console=([A-Za-z0-9_-]+)/);
  return match ? match[1] : '';
}

// ---------- numbers the Scores tab can change ----------
// An allow-list rather than a free-for-all: a typo must not be able to
// create a setting that nothing ever reads. Each one falls back to the
// value the code ships with, so an untouched dashboard behaves exactly
// as it did before any of this existed.
var CONSOLE_LIMITS: Record<string, number> = { submit_max_pending: MAX_PENDING, album_anyone_per_hour: ANYONE_PER_HOUR };

async function limitsRead(env: Env): Promise<Response> {
  var out: Record<string, number> = {};
  var names = Object.keys(CONSOLE_LIMITS);
  for (var i = 0; i < names.length; i++) {
    out[names[i]] = await settingValue(env.DB, names[i], CONSOLE_LIMITS[names[i]]);
  }
  return json({ ok: true, limits: out, defaults: CONSOLE_LIMITS });
}

async function limitsSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var sent = (body.limits && typeof body.limits === 'object' ? body.limits : {}) as Record<string, unknown>;
  var names = Object.keys(CONSOLE_LIMITS);
  var wrote: [string, number][] = [];
  for (var i = 0; i < names.length; i++) {
    if (!(names[i] in sent)) continue;
    var n = Number(sent[names[i]]);
    // zero would stop every team submitting, so it is not a value here
    if (!isFinite(n) || n < 1 || n !== Math.round(n) || n > 100000) {
      return json({ error: 'Every limit must be a whole number from 1 to 100000.' }, 400);
    }
    wrote.push([names[i], n]);
  }
  for (var k = 0; k < wrote.length; k++) await setSetting(env.DB, wrote[k][0], wrote[k][1]);
  if (wrote.length) {
    await logAction(env.DB, session.name, 'limits-set',
      wrote.map(function (w) { return w[0] + ' ' + w[1]; }).join(', '), '-', 0, 0, 0);
  }
  return limitsRead(env);
}

// every console action is a log row; entity edits carry zero deltas
function logAction(db: D1Database, actor: string, action: string, teamName: string, questCode: string, delta: number, oldTotal: number | null, newTotal: number | null): Promise<D1Result> {
  return db.prepare(
    'INSERT INTO submission_log (action, team_name, quest_code, points_delta, old_total, new_total, actor) ' +
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
  ).bind(action, teamName, questCode, Math.round(delta * 100) / 100, oldTotal, newTotal, 'console:' + actor).run();
}

function teamById(db: D1Database, id: unknown): Promise<Pick<TeamRow, 'id' | 'name'> | null> {
  return db.prepare('SELECT id, name FROM teams WHERE id = ?1').bind(Number(id) || 0).first<Pick<TeamRow, 'id' | 'name'>>();
}

function questByCode(db: D1Database, code: unknown): Promise<Pick<QuestRow, 'code' | 'points'> | null> {
  return db.prepare('SELECT code, points FROM quests WHERE code = ?1').bind(String(code || '')).first<Pick<QuestRow, 'code' | 'points'>>();
}

// ---------- handlers ----------

// the first eight hex characters of a salted hash of the caller's
// address: enough to tell one address's attempts from another's
async function shortIpHash(request: Request): Promise<string> {
  var ip = request.headers.get('cf-connecting-ip') || 'unknown';
  var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('scs2-login:' + ip));
  var arr = new Uint8Array(digest).slice(0, 4);
  var hex = '';
  for (var i = 0; i < arr.length; i++) hex += (arr[i] + 256).toString(16).slice(1);
  return 'ip:' + hex;
}

// ---------- signing in ----------
// An account is a name and a password, and usually a six-digit code
// from the organiser's own authenticator app as well. An admin makes
// each one and decides whether it needs the code: the code is what a
// password cannot be — per-person, and worth nothing a minute later —
// so an account that can change scores should have one, and an account
// that only reads the review queue on a borrowed laptop may not.
//
// Three things cover the ways that can go wrong. A person whose phone
// is dead has ten printed backup codes, one use each. An account that
// needs a code and has none sets it up at its first sign-in, behind its
// own password. And every attempt from an address is counted, so
// guessing gets slower and then stops, without anybody being locked out
// of the dashboard on the morning of the event.
//
// The very first sign-in on an empty database makes an admin account
// out of the shared CONSOLE_PASSWORD, which is how the first admin
// exists to make everybody else. Accounts from before admins made them
// have no password of their own and still sign in with it.

// How long this address has to wait before it may try again. Failures
// in the last quarter of an hour, doubling from five seconds, capped at
// a quarter of an hour: three wrong tries cost nothing anyone would
// notice, and ten make guessing pointless. Counted per address rather
// than worker-wide on purpose — a lock everybody shares is a lock any
// stranger who finds the address can put on the committee.
var THROTTLE_FREE = 3;      // attempts before any wait at all
var THROTTLE_MAX = 900;     // seconds

// How this address has been doing lately, which answers both of the
// questions asked before a password is even looked at: how long it has
// to wait, and whether it has to pass the human check first.
//
// Only real guesses count: a refused password or a refused code. A
// request that was itself turned away does not, or pressing Sign in
// twice while reading the wait would extend it; a failed human check
// does not either, because the way that fails for an honest organiser
// is a widget that will not load, and compounding that into a lockout
// is the opposite of the point. And nothing before this address last
// got in counts, so one bad morning does not follow somebody around for
// the rest of it.
//
// A sign-in still being checked counts too ('trying', the row each one
// writes before anything is looked at and takes away when it answers),
// so guesses sent in parallel each see the ones ahead of them rather
// than all reading the same count. Only rows before this request's own
// (`mine`) are counted.
async function recentFailures(db: D1Database, ip: string, mine: number): Promise<{ n: number; wait: number }> {
  var row = await db.prepare(
    "SELECT COUNT(*) AS n, MAX(at) AS last FROM console_attempts " +
    "WHERE ip = ?1 AND outcome IN ('bad-password', 'bad-code', 'trying') AND id < ?2 " +
    "AND at > datetime('now', '-15 minutes') " +
    "AND id > COALESCE((SELECT MAX(id) FROM console_attempts WHERE ip = ?1 AND outcome = 'ok'), 0)"
  ).bind(ip, mine).first<{ n: number; last: string | null }>();
  var n = row ? Number(row.n) || 0 : 0;
  var wait = 0;
  if (n >= THROTTLE_FREE && row && row.last) {
    var owed = Math.min(THROTTLE_MAX, Math.pow(2, n - THROTTLE_FREE) * 5);
    // D1 stores UTC without a zone marker; Date.parse needs telling
    var since = (Date.now() - Date.parse(String(row.last).replace(' ', 'T') + 'Z')) / 1000;
    wait = Math.max(0, Math.ceil(owed - since));
  }
  return { n: n, wait: wait };
}

function noteAttempt(db: D1Database, name: unknown, ip: unknown, outcome: string, detail: unknown): Promise<D1Result> {
  return db.prepare(
    'INSERT INTO console_attempts (name, ip, outcome, detail) VALUES (?1, ?2, ?3, ?4)'
  ).bind(String(name || ''), String(ip || ''), String(outcome), String(detail || '')).run();
}

// An account by the name typed, whatever its capitals: a phone puts one
// on the first letter whether it was wanted or not.
function findAccount(db: D1Database, name: string): Promise<Account | null> {
  return db.prepare(
    'SELECT name, secret, confirmed_at, last_step, password_hash, admin, perms, require_2fa ' +
    'FROM console_users WHERE name = ?1 COLLATE NOCASE ORDER BY name = ?1 DESC LIMIT 1'
  ).bind(name).first<Account>();
}

// No account at all: the one time the shared password may make one.
// Once the first admin's row is there, even before its code is set up,
// the shared password makes nobody else.
async function noAccounts(db: D1Database): Promise<boolean> {
  return !(await db.prepare('SELECT 1 AS n FROM console_users LIMIT 1').first());
}

// Nobody has signed in yet, which is the one time an account with no
// password of its own may set a code up: the first admin, finishing a
// setup it started. After that the shared password alone would let
// anybody holding it take that account's code.
async function nobodyYet(db: D1Database): Promise<boolean> {
  var row = await db.prepare(
    'SELECT 1 AS n FROM console_users WHERE confirmed_at IS NOT NULL OR last_seen IS NOT NULL LIMIT 1'
  ).first();
  return !row;
}

async function anyOwnPassword(db: D1Database): Promise<boolean> {
  return !!(await db.prepare('SELECT 1 AS n FROM console_users WHERE password_hash IS NOT NULL LIMIT 1').first());
}

// What the page needs to put a secret into an app: the picture, the
// same thing as text for a desktop authenticator or a typed entry, and
// the link itself.
function enrolPayload(name: string, secret: string, env: Env): { enrol: boolean; name: string; secret: string; otpauth: string; qr: string } {
  var issuer = cleanText(env.ENROL_ISSUER, 40) || 'SCS.2 dashboard';
  var url = otpauthUrl(name, secret, issuer);
  return {
    enrol: true,
    name: name,
    secret: secretInGroups(secret),
    otpauth: url,
    qr: qrDataUri(url)
  };
}

async function newBackupCodes(db: D1Database, name: string): Promise<string[]> {
  var codes = makeBackupCodes(10);
  var rows = [db.prepare('DELETE FROM console_backup_codes WHERE name = ?1').bind(name)];
  for (var i = 0; i < codes.length; i++) {
    rows.push(db.prepare(
      'INSERT INTO console_backup_codes (name, code_hash) VALUES (?1, ?2)'
    ).bind(name, await hashBackupCode(codes[i])));
  }
  await db.batch(rows);
  return codes;
}

// A backup code is spent by the attempt that uses it, whether or not
// anything after it succeeds: a conditional UPDATE is the claim, so two
// requests racing on the same code cannot both win.
async function spendBackupCode(db: D1Database, name: string, typed: unknown): Promise<boolean> {
  var clean = cleanBackupCode(typed);
  if (clean.length < 6) return false;
  var hash = await hashBackupCode(clean);
  var res = await db.prepare(
    "UPDATE console_backup_codes SET used_at = datetime('now') " +
    'WHERE name = ?1 AND code_hash = ?2 AND used_at IS NULL'
  ).bind(name, hash).run();
  // the test shim answers flat
  var meta = (res && res.meta ? res.meta : res) as { changes?: number; changed_db?: boolean } | null;
  return !!(meta && (meta.changes || meta.changed_db || 0));
}

async function startSession(env: Env, name: string, ip: string, how: string): Promise<string> {
  var token = randomKey(32);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM console_sessions WHERE expires_at < datetime('now')"),
    env.DB.prepare(
      "INSERT INTO console_sessions (token, name, expires_at) VALUES (?1, ?2, datetime('now', '+18 hours'))"
    ).bind(token, name),
    env.DB.prepare("UPDATE console_users SET last_seen = datetime('now') WHERE name = ?1").bind(name)
  ]);
  await noteAttempt(env.DB, name, ip, 'ok', how);
  await logAction(env.DB, name, 'login', '-', ip, 0, 0, 0);
  return token;
}

var LOCKED = 'The console is locked: CONSOLE_PASSWORD is not set on the worker.';

async function login(request: Request, env: Env): Promise<Response> {
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  var ip = await shortIpHash(request);
  var shared = configured(env.CONSOLE_PASSWORD);
  if (!shared && !(await anyOwnPassword(env.DB))) return json({ error: LOCKED }, 403);
  var name = cleanText(body.name, 40);
  if (!name) return json({ error: 'Type your name.' }, 400);

  var trying = await noteAttempt(env.DB, name, ip, 'trying', '');
  var mine = Number(trying.meta && trying.meta.last_row_id) || 0;
  try {
    return await signIn(request, env, body, ip, shared, name, mine);
  } finally {
    await env.DB.prepare('DELETE FROM console_attempts WHERE id = ?1').bind(mine).run();
  }
}

// The rest of a sign-in, from the throttle on, with this request's own
// 'trying' row (`mine`) written.
async function signIn(request: Request, env: Env, body: JsonBody, ip: string, shared: boolean, name: string, mine: number): Promise<Response> {
  var lately = await recentFailures(env.DB, ip, mine);
  if (lately.wait > 0) {
    await noteAttempt(env.DB, name, ip, 'throttled', lately.wait + 's');
    return json({
      error: 'Too many tries from here. Wait ' +
        (lately.wait >= 60 ? Math.ceil(lately.wait / 60) + ' minutes' : lately.wait + ' seconds') +
        ' and try again.',
      retry_after: lately.wait
    }, 429);
  }

  // Cloudflare's human check, once this address has got something
  // wrong. Not before: the way it fails for an organiser is a venue
  // that cannot reach challenges.cloudflare.com, and a first, correct
  // sign-in must never depend on that. Guessing hits it on the second
  // try, which is what it is for. Unset secrets stand it down.
  if (turnstileSiteKey(env) && lately.n > 0 &&
      !(await turnstileOk(env, request, cleanText(body.turnstile, 4096)))) {
    await noteAttempt(env.DB, name, ip, 'bad-human', '');
    await delay(400);
    return json({
      error: 'The check that you are a person did not pass. Reload the page and try again.',
      needs_turnstile: true
    }, 403);
  }

  // The password: the account's own, or the shared one for an account
  // that has none — and for the first account of all.
  var user = await findAccount(env.DB, name);
  var first = !user && await noAccounts(env.DB);
  var typedPassword = String(body.password || '');
  var passOk = false;
  if (user && user.password_hash) passOk = await passwordMatches(typedPassword, user.password_hash);
  else if ((user || first) && shared) passOk = await secretMatches(typedPassword, env.CONSOLE_PASSWORD);
  if (!passOk) {
    await noteAttempt(env.DB, name, ip, 'bad-password', user || first ? '' : 'no such account');
    await logAction(env.DB, name, 'login-failed', '-', ip, 0, 0, 0);
    await delay(400);
    return json({ error: 'wrong name or password' }, 401);
  }

  // The first account on an empty database is an admin, with its code
  // set up now. The row is stored unconfirmed, so a refresh mid-setup
  // picks up the same secret rather than starting again with a QR the
  // app has already taken.
  if (first) {
    var secret = randomSecret();
    // only while the table is still empty: two first sign-ins at once
    // make one admin, not two
    var made = await env.DB.prepare(
      'INSERT INTO console_users (name, secret, admin, require_2fa) SELECT ?1, ?2, 1, 1 ' +
      'WHERE NOT EXISTS (SELECT 1 FROM console_users)'
    ).bind(name, secret).run();
    if (!(made.meta && made.meta.changes)) {
      return json({ error: 'The first account was made a moment ago. Ask whoever made it to make yours.' }, 409);
    }
    await noteAttempt(env.DB, name, ip, 'enrol-started', 'first account');
    await logAction(env.DB, name, 'auth-enrol-start', '-', ip, 0, 0, 0);
    return json(Object.assign({ ok: true }, enrolPayload(name, secret, env)));
  }
  // the password check above refused anybody else
  var account = user as Account;
  name = account.name;

  if (!Number(account.require_2fa)) {
    var plain = await startSession(env, name, ip, 'password');
    return json({ ok: true, session: plain, name: name });
  }

  // A code is needed and none is set up. With a password of its own the
  // account sets one up now. Without one, the shared password is all
  // that stands in front of its secret, which anybody on the committee
  // holds — so only while nobody has signed in yet.
  if (!account.confirmed_at && !account.password_hash && !(await nobodyYet(env.DB))) {
    await noteAttempt(env.DB, name, ip, 'no-setup', '');
    return json({ error: 'This account has no code set up yet. Ask an admin to give it a password of its ' +
      'own, then sign in with that to set one up.' }, 403);
  }

  var typed = String(body.code || '').trim();
  if (!typed) {
    // Unconfirmed means the app may never have taken the secret, so the
    // picture goes back with the ask rather than a bare "code, please".
    if (!account.confirmed_at) {
      await noteAttempt(env.DB, name, ip, 'enrol-started', '');
      return json(Object.assign({ ok: true }, enrolPayload(name, account.secret, env)));
    }
    return json({ error: 'Enter the six-digit code from your authenticator app.', needs_code: true }, 401);
  }

  var step = await verifyCode(account.secret, typed, Date.now(), account.last_step);
  var usedBackup = false;
  if (step < 0) {
    // A confirmed account may fall back to a printed code. An
    // unconfirmed one may not: there are no printed codes yet, and the
    // whole point of the first code is proving the app has the secret.
    usedBackup = !!account.confirmed_at && await spendBackupCode(env.DB, name, typed);
    if (!usedBackup) {
      await noteAttempt(env.DB, name, ip, 'bad-code', '');
      await logAction(env.DB, name, 'login-failed', '-', ip, 0, 0, 0);
      await delay(400);
      return json({ error: 'wrong code', needs_code: true, needs_enrol: !account.confirmed_at }, 401);
    }
  } else {
    // The step is the claim: a code is good once, so the same code sent
    // twice at once passes once, and the step never goes backwards.
    var stepped = await env.DB.prepare('UPDATE console_users SET last_step = ?2 WHERE name = ?1 AND last_step < ?2')
      .bind(name, step).run();
    if (!(stepped.meta && stepped.meta.changes)) {
      await noteAttempt(env.DB, name, ip, 'bad-code', 'used already');
      await logAction(env.DB, name, 'login-failed', '-', ip, 0, 0, 0);
      await delay(400);
      return json({ error: 'That code has been used. Wait for the next one.', needs_code: true, needs_enrol: !account.confirmed_at }, 401);
    }
  }

  // First code through confirms the setup, and the ten printed codes
  // are shown once, here, and never again. Two first codes at once
  // confirm it once: the other signs in as any later code would.
  var confirmed = account.confirmed_at ? null : await env.DB.prepare(
    "UPDATE console_users SET confirmed_at = datetime('now') WHERE name = ?1 AND confirmed_at IS NULL"
  ).bind(name).run();
  if (confirmed && confirmed.meta && confirmed.meta.changes) {
    var fresh = await newBackupCodes(env.DB, name);
    await logAction(env.DB, name, 'auth-enrolled', '-', ip, 0, 0, 0);
    var opened = await startSession(env, name, ip, 'set up a code');
    return json({ ok: true, session: opened, name: name, backup_codes: fresh });
  }

  var token = await startSession(env, name, ip, usedBackup ? 'backup code' : 'code');
  var left = 0;
  if (usedBackup) {
    var row = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM console_backup_codes WHERE name = ?1 AND used_at IS NULL'
    ).bind(name).first<{ n: number }>();
    left = row ? Number(row.n) || 0 : 0;
    await logAction(env.DB, name, 'auth-backup-used', '-', ip, 0, 0, 0);
  }
  return json({ ok: true, session: token, name: name, used_backup: usedBackup, backup_left: left });
}

// ---------- the account signed in ----------
// What the page needs to leave out the tabs this account cannot use.
async function meView(env: Env, session: ConsoleSession): Promise<Response> {
  var row = await env.DB.prepare('SELECT confirmed_at, require_2fa FROM console_users WHERE name = ?1')
    .bind(session.name).first<Pick<ConsoleUserRow, 'confirmed_at' | 'require_2fa'>>();
  return json({
    ok: true, name: session.name, admin: !!session.admin,
    perms: session.admin ? PERMS.slice() : session.perms,
    quests: session.quests || [],
    code: !!(row && row.confirmed_at && Number(row.require_2fa))
  });
}

// ---------- the Accounts tab ----------

async function accountsView(env: Env): Promise<Response> {
  type Listed = Pick<ConsoleUserRow, 'name' | 'admin' | 'perms' | 'require_2fa' | 'confirmed_at' | 'created_at' | 'created_by' | 'last_seen'> &
    { own_password: number; codes_left: number; quests: string };
  var users = await env.DB.prepare(
    'SELECT u.name, u.admin, u.perms, u.require_2fa, u.password_hash IS NOT NULL AS own_password, ' +
    'u.confirmed_at, u.created_at, u.created_by, u.last_seen, u.quests, ' +
    '(SELECT COUNT(*) FROM console_backup_codes b WHERE b.name = u.name AND b.used_at IS NULL) AS codes_left ' +
    'FROM console_users u ORDER BY u.name COLLATE NOCASE'
  ).all<Listed>();
  var attempts = await env.DB.prepare(
    'SELECT at, name, ip, outcome, detail FROM console_attempts ORDER BY id DESC LIMIT 60'
  ).all();
  var recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM console_attempts " +
    "WHERE outcome != 'ok' AND at > datetime('now', '-1 hour')"
  ).first<{ n: number }>();
  return json({
    ok: true,
    users: users.results.map(function (u) {
      return {
        name: u.name, admin: !!u.admin, perms: u.admin ? PERMS.slice() : parsePerms(u.perms),
        require_2fa: !!u.require_2fa, own_password: !!u.own_password, confirmed_at: u.confirmed_at,
        created_at: u.created_at, created_by: u.created_by || '', last_seen: u.last_seen, codes_left: u.codes_left,
        quests: u.admin ? [] : parseQuestKeys(u.quests)
      };
    }),
    perms: PERMS,
    attempts: attempts.results,
    failed_last_hour: recent ? Number(recent.n) || 0 : 0,
    human_check: !!turnstileSiteKey(env),
    guards: await guardStates(env.DB),
    second_password: configured(env.PUSH_PASSWORD)
  });
}

async function adminsBesides(db: D1Database, name: string): Promise<number> {
  var row = await db.prepare('SELECT COUNT(*) AS n FROM console_users WHERE admin = 1 AND name != ?1')
    .bind(name).first<{ n: number }>();
  return row ? Number(row.n) || 0 : 0;
}

// Make an account, or change one. A new account needs its password; a
// changed one keeps its own unless a new one is typed. The tabs are
// ignored for an admin, who has all of them.
async function accountSave(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var name = cleanText(body.name, 40);
  if (!name) return json({ error: 'Give the account a name.' }, 400);
  var password = String(body.password || '');
  if (password && password.length < MIN_PASSWORD) {
    return json({ error: 'A password needs at least ' + MIN_PASSWORD + ' characters.' }, 400);
  }
  var admin = body.admin ? 1 : 0;
  var perms = admin ? '' : parsePerms((Array.isArray(body.perms) ? body.perms : []).join(',')).join(',');
  if (!admin && !perms) return json({ error: 'Tick at least one tab, or Admin.' }, 400);
  // an empty list is every quest, so every quest has to be asked for
  if (!admin && Array.isArray(body.quests) && !parseQuestKeys(body.quests).length && !body.all_quests) {
    return json({ error: 'Tick at least one quest, or Every quest.' }, 400);
  }
  var need2fa = body.require_2fa ? 1 : 0;

  var existing = await env.DB.prepare(
    'SELECT name, admin, password_hash FROM console_users WHERE name = ?1 COLLATE NOCASE ORDER BY name = ?1 DESC LIMIT 1'
  ).bind(name).first<Pick<ConsoleUserRow, 'name' | 'admin' | 'password_hash'>>();

  var setQuests = Array.isArray(body.quests) || !!body.all_quests;
  var questKeys = admin || body.all_quests ? '' : parseQuestKeys(body.quests).join(',');

  if (body.create) {
    if (existing) return json({ error: 'There is already an account called ' + existing.name + '.' }, 409);
    if (!password) return json({ error: 'A new account needs a password.' }, 400);
    await env.DB.prepare(
      'INSERT INTO console_users (name, secret, password_hash, admin, perms, require_2fa, created_by, quests) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)'
    ).bind(name, randomSecret(), await hashPassword(password), admin, perms, need2fa, session.name, setQuests ? questKeys : '').run();
    await logAction(env.DB, session.name, 'account-add', name, '-', 0, 0, 0);
    return accountsView(env);
  }

  if (!existing) return json({ error: 'No account by that name.' }, 404);
  name = existing.name;
  if (existing.admin && !admin && !(await adminsBesides(env.DB, name))) {
    return json({ error: 'At least one account has to stay an admin.' }, 400);
  }
  var writes = [
    setQuests
      ? env.DB.prepare('UPDATE console_users SET admin = ?2, perms = ?3, require_2fa = ?4, quests = ?5 WHERE name = ?1')
          .bind(name, admin, perms, need2fa, questKeys)
      : env.DB.prepare('UPDATE console_users SET admin = ?2, perms = ?3, require_2fa = ?4 WHERE name = ?1')
          .bind(name, admin, perms, need2fa)
  ];
  if (password) {
    writes.push(env.DB.prepare('UPDATE console_users SET password_hash = ?2 WHERE name = ?1')
      .bind(name, await hashPassword(password)));
    // a new password signs that account out everywhere but here
    writes.push(env.DB.prepare('DELETE FROM console_sessions WHERE name = ?1 AND token != ?2')
      .bind(name, session.token));
  }
  await env.DB.batch(writes);
  await logAction(env.DB, session.name, password ? 'account-edit-password' : 'account-edit', name, '-', 0, 0, 0);
  return accountsView(env);
}

async function accountDelete(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var name = cleanText(body.name, 40);
  if (!name) return json({ error: 'name required' }, 400);
  if (name === session.name) return json({ error: 'Another admin has to delete your account.' }, 400);
  var user = await env.DB.prepare('SELECT name, admin FROM console_users WHERE name = ?1').bind(name).first<Pick<ConsoleUserRow, 'name' | 'admin'>>();
  if (!user) return json({ error: 'No account by that name.' }, 404);
  if (user.admin && !(await adminsBesides(env.DB, name))) {
    return json({ error: 'At least one account has to stay an admin.' }, 400);
  }
  await env.DB.batch([
    env.DB.prepare('DELETE FROM console_users WHERE name = ?1').bind(name),
    env.DB.prepare('DELETE FROM console_backup_codes WHERE name = ?1').bind(name),
    env.DB.prepare('DELETE FROM console_sessions WHERE name = ?1').bind(name)
  ]);
  await logAction(env.DB, session.name, 'account-delete', name, '-', 0, 0, 0);
  return accountsView(env);
}

// Somebody's phone is gone: take their code off, sign them out, and they
// set a new one up the next time they sign in. Never your own — an
// organiser who resets themselves has done nothing but lose their codes,
// and it is one misread row away from resetting the person beside them.
async function authReset(request: Request, env: Env, session: ConsoleSession, ip: string): Promise<Response> {
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  var name = cleanText(body.name, 40);
  if (!name) return json({ error: 'name required' }, 400);
  if (name === session.name) {
    return json({ error: 'Ask another admin to reset you: doing it yourself only loses your codes.' }, 400);
  }
  var user = await env.DB.prepare('SELECT name FROM console_users WHERE name = ?1').bind(name).first<Pick<ConsoleUserRow, 'name'>>();
  if (!user) return json({ error: 'no such name' }, 404);
  await env.DB.batch([
    env.DB.prepare('UPDATE console_users SET secret = ?2, confirmed_at = NULL, last_step = 0 WHERE name = ?1')
      .bind(name, randomSecret()),
    env.DB.prepare('DELETE FROM console_backup_codes WHERE name = ?1').bind(name),
    env.DB.prepare('DELETE FROM console_sessions WHERE name = ?1').bind(name)
  ]);
  await noteAttempt(env.DB, name, ip, 'reset', 'by ' + session.name);
  await logAction(env.DB, session.name, 'auth-reset', name, ip, 0, 0, 0);
  return json({ ok: true });
}

async function authBackup(env: Env, session: ConsoleSession, ip: string): Promise<Response> {
  var user = await env.DB.prepare('SELECT confirmed_at FROM console_users WHERE name = ?1')
    .bind(session.name).first<Pick<ConsoleUserRow, 'confirmed_at'>>();
  if (!user || !user.confirmed_at) return json({ error: 'no code set up to make backup codes for' }, 400);
  var codes = await newBackupCodes(env.DB, session.name);
  await logAction(env.DB, session.name, 'auth-backup-new', '-', ip, 0, 0, 0);
  return json({ ok: true, backup_codes: codes });
}

// Which actions ask for the second password. Changing that asks for it
// too whenever the worker has one, or the switch would be the easy way
// round the lock it sets.
async function guardSet(env: Env, session: ConsoleSession, request: Request, body: JsonBody): Promise<Response> {
  var guard = guardByKey(String(body.key || ''));
  if (!guard) return json({ error: 'no such action' }, 400);
  var on = !!body.on;
  if (configured(env.PUSH_PASSWORD)) {
    var refused = await secondPasswordRefusal(env, secondPasswordGiven(request), 'Changing this');
    if (refused) return refused;
  } else if (on) {
    return json({ error: 'The worker has no second password yet: set PUSH_PASSWORD first.' }, 400);
  }
  await setSetting(env.DB, 'guard_' + guard.key, on ? 1 : 0);
  await logAction(env.DB, session.name, on ? 'guard-on' : 'guard-off', guard.label, '-', 0, 0, 0);
  return accountsView(env);
}

async function overview(env: Env): Promise<Response> {
  var teams = await env.DB.prepare(
    'SELECT t.id, t.name, t.hidden, t.dnf, ' + SUM_POINTS + ' AS pts, ' +
    'COUNT(CASE WHEN c.amount > 0 THEN 1 END) AS quests_done ' +
    'FROM teams t LEFT JOIN held c ON c.team_id = t.id ' +
    'LEFT JOIN quests q ON q.code = c.quest_code ' +
    'GROUP BY t.id ORDER BY pts DESC, t.name COLLATE NOCASE'
  ).all();
  var quests = await env.DB.prepare(
    'SELECT q.code, q.norm, q.points, q.hidden, q.label, g.key AS group_key, ' +
    'COUNT(CASE WHEN c.amount > 0 THEN 1 END) AS teams_done ' +
    'FROM quests q LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    'LEFT JOIN held c ON c.quest_code = q.code ' +
    'GROUP BY q.code ORDER BY q.hidden, g.sort, q.sort, q.norm'
  ).all();
  return json({ ok: true, teams: teams.results, quests: quests.results });
}

// A line on the ledger as the receipt and the desk read it, joined to
// what made it and the team that holds it.
// A line on the ledger joined to what made it and the team holding it
// (LINE_SELECT), and as the receipt and the desk send it (ledgerLine).
type LineRead = Pick<EntryRow, 'id' | 'team_id' | 'code' | 'units' | 'points' | 'source_kind' | 'source_id' | 'note' | 'made_by' | 'made_at' |
  'at' | 'voided_by' | 'voided_at' | 'void_reason'> & { label: string | null; each: number | null; key: string | null; name: string | null;
  team_name: string; team_hidden: number; added_by: string | null; status: string | null; quest_code: string | null; submitted_at: string | null;
  reviewed_at: string | null; reviewed_by: string | null; reason: string | null; award_kind: string | null };
interface LedgerLine {
  id: number;
  code: string;
  units: number;
  points: number;
  kind: string;
  source_id: number | null;
  at: string;
  made_at: string;
  by: string;
  note: string;
  organiser: boolean;
  label: string;
  voided: { at: string; by: string; reason: string } | null;
  sub?: { status: string; quest_code: string | null; sent: string; decided: string; by: string; adjust: boolean; reason: string };
  deleted_from?: string;
}
// A submission waiting on review, or one that gave nothing (SUB_SELECT).
type SubRead = Pick<SubmissionRow, 'id' | 'team_id' | 'quest_code' | 'status' | 'reason' | 'submitted_at'> &
  { team_name: string; team_hidden: number; name: string };
// A code a team holds, and one quest on its receipt.
type HeldCode = { code: string; label: string; points: number | null; amount: number; worth: number };
interface ReceiptQuest {
  key: string;
  name: string;
  worth: number;
  times: number;
  held: HeldCode[];
  lines: LedgerLine[];
  entries: { id: number | null; at: string; by: string; organiser: boolean; codes: { code: string; amount: number }[]; worth: number }[];
  other: { code: string; amount: number; worth: number; label: string }[];
  codes?: Record<string, HeldCode>;
}

var AWARD_LABELS: Record<string, string> = { challenge: 'Points by place', wager: 'Wager settled', eoi: 'Expression of interest' };
// The code each line in the holder of deleted quests came from, by line id.
function linesFrom(db: D1Database, rows: LineRead[]): Promise<Record<string, string>> {
  return cameFrom(db, 'entries', rows.filter(function (r) { return r.code === DELETED_CODE; }).map(function (r) { return r.id; }));
}
var LINE_SELECT =
  'SELECT e.id, e.team_id, e.code, e.units, e.points, e.source_kind, e.source_id, e.note, e.made_by, e.made_at, e.at, ' +
  'e.voided_by, e.voided_at, e.void_reason, q.label, q.points AS each, g.key, g.name, t.name AS team_name, t.hidden AS team_hidden, ' +
  's.added_by, s.status, s.quest_code, s.submitted_at, s.reviewed_at, s.reviewed_by, s.reason, a.kind AS award_kind ' +
  'FROM entries e JOIN teams t ON t.id = e.team_id LEFT JOIN quests q ON q.code = e.code LEFT JOIN quest_groups g ON g.id = q.group_id ' +
  "LEFT JOIN submissions s ON e.source_kind = 'submission' AND s.id = e.source_id " +
  "LEFT JOIN awards a ON e.source_kind = 'award' AND a.id = e.source_id ";
// `from` is the code a line in the holder of deleted quests came from
// (linesFrom), and the line is named for it: "SQ12 (deleted)".
function ledgerLine(r: LineRead, from?: string): LedgerLine {
  var line: LedgerLine = {
    id: r.id, code: r.code, units: r.units, points: r.points, kind: r.source_kind, source_id: r.source_id,
    at: r.at, made_at: r.made_at, by: r.made_by || '', note: r.note || '',
    organiser: r.source_kind === 'submission' && !!r.added_by,
    label: r.source_kind === 'award' ? (AWARD_LABELS[String(r.award_kind)] || 'Award') : r.source_kind === 'balance' ? (r.note || 'From before the ledger') : '',
    voided: r.voided_at ? { at: r.voided_at, by: r.voided_by || '', reason: r.void_reason || '' } : null
  };
  if (r.code === DELETED_CODE) {
    line.code = deletedName(from);
    line.deleted_from = from || DELETED_CODE;
  }
  // what the submission behind it says now: an adjustment is an
  // organiser's entry with a reason the team reads
  if (r.source_kind === 'submission' && r.status) {
    line.sub = {
      status: r.status, quest_code: r.quest_code, sent: r.submitted_at || '', decided: r.reviewed_at || '',
      by: r.reviewed_by || '', adjust: !!r.added_by && r.status === 'accepted' && !!r.reason,
      reason: r.added_by && r.status === 'accepted' ? (r.reason || '') : ''
    };
  }
  return line;
}
// The files of every submission behind the lines, by submission id, for
// the ledger and the desk to show on each submission's line.
async function lineMedia(env: Env, lines: LedgerLine[]): Promise<Record<number, MediaOut[]>> {
  var ids: Record<number, boolean> = {};
  lines.forEach(function (l) { if (l.kind === 'submission' && l.source_id) ids[l.source_id] = true; });
  var rows = await attachMedia(env, Object.keys(ids).map(function (id) { return { id: Number(id) }; }));
  var out: Record<number, MediaOut[]> = {};
  rows.forEach(function (r) { if (r.media.length) out[r.id] = r.media; });
  return out;
}
// Submissions that are waiting on review, and those that gave nothing:
// rejected, or deleted before they gave anything (one deleted after
// shows as its voided lines).
var SUB_SELECT =
  'SELECT s.id, s.team_id, t.name AS team_name, t.hidden AS team_hidden, s.quest_code, s.status, s.reason, s.submitted_at, ' +
  'COALESCE(g.name, q.label, s.quest_code) AS name ' +
  'FROM submissions s JOIN teams t ON t.id = s.team_id LEFT JOIN quests q ON q.code = s.quest_code LEFT JOIN quest_groups g ON g.id = q.group_id ';
var WAITING = "s.status IN ('pending', 'queued')";
var CLOSED = "(s.status = 'rejected' OR (s.status = 'deleted' AND NOT EXISTS " +
  "(SELECT 1 FROM entries x WHERE x.source_kind = 'submission' AND x.source_id = s.id)))";
var CLOSED_SHOWN = 50;
function subRow(r: SubRead): object {
  return { id: r.id, team_id: r.team_id, team_name: r.team_name, team_hidden: !!r.team_hidden, quest_code: r.quest_code, name: r.name,
    status: r.status, reason: r.reason || '', submitted_at: r.submitted_at };
}
// The same for a list, each one in the holder of deleted quests named for
// the quest it came from.
async function subRows(db: D1Database, list: SubRead[]): Promise<object[]> {
  list.forEach(function (r) { if (r.quest_code === DELETED_CODE) r.name = ''; });
  await nameDeleted(db, list, 'quest_code', 'submissions', function (r) { return r.id; });
  return list.map(subRow);
}

// A team's receipt, read off its ledger: each quest it has lines on,
// with every line in time order — what made it (a submission, an award,
// a balance from before the ledger), who, when, what it was worth, and
// for a voided one who voided it and why — and what the team holds now
// on each code. `times` is how many submissions give a quest something
// now, which is what shows a quest credited twice. Codes outside the
// account's quests are left out; the total is the whole team's.
async function teamReceipt(env: Env, url: URL, session: ConsoleSession): Promise<Response> {
  var db = env.DB;
  var team = await teamById(db, url.searchParams.get('team_id'));
  if (!team) return json({ error: 'no such team' }, 404);
  if (!(await ledgerReady(db))) return behind();
  var scope = await scopeCodes(db, session);
  var rows = (await db.prepare(LINE_SELECT + 'WHERE e.team_id = ?1 ORDER BY e.at, e.id').bind(team.id).all<LineRead>()).results;
  var from = await linesFrom(db, rows);
  var round = function (n: number) { return Math.round(n * 100) / 100; };
  var quests: Record<string, ReceiptQuest> = {};
  var total = 0;
  rows.forEach(function (r) {
    var live = !r.voided_at;
    if (live) total += Number(r.points) || 0;
    if (!inScope(scope, r.code)) return;
    // a deleted quest's lines are a block of their own, code by code, whose
    // heading opens the desk of everything deleted quests left behind
    var gone = r.code === DELETED_CODE ? from[String(r.id)] || '' : null;
    var key = gone != null ? DELETED_CODE + ':' + gone : r.key || r.code;
    var q = quests[key];
    if (!q) {
      q = quests[key] = { key: gone != null ? DELETED_CODE : key, name: gone != null ? deletedName(gone) : r.name || r.label || r.code,
        worth: 0, times: 0, held: [], lines: [], entries: [], other: [], codes: {} };
    }
    var line = ledgerLine(r, gone == null ? undefined : gone);
    q.lines.push(line);
    if (!live) return;
    q.worth = round(q.worth + Number(r.points));
    // there until the quest is counted, below
    var held = q.codes as Record<string, HeldCode>;
    var c = held[r.code] = held[r.code] || { code: r.code, label: r.label || '', points: r.each, amount: 0, worth: 0 };
    c.amount += Number(r.units);
    c.worth = round(c.worth + Number(r.points));
    if (r.source_kind === 'submission') {
      var entry = q.entries.filter(function (x) { return x.id === r.source_id; })[0];
      if (!entry) {
        entry = { id: r.source_id, at: r.at, by: r.made_by || '', organiser: !!r.added_by, codes: [], worth: 0 };
        q.entries.push(entry);
      }
      entry.codes.push({ code: r.code, amount: r.units });
      entry.worth = round(entry.worth + Number(r.points));
    } else {
      q.other.push({ code: r.code, amount: r.units, worth: round(Number(r.points)), label: line.label });
    }
  });
  var list = Object.keys(quests).map(function (key) {
    var q = quests[key];
    var held = q.codes as Record<string, HeldCode>;
    q.held = Object.keys(held).map(function (code) {
      var c = held[code];
      c.amount = Math.round(c.amount * 1e6) / 1e6;
      return c;
    }).filter(function (c) { return c.amount || c.worth; });
    q.times = q.entries.filter(function (e) { return e.worth > 0 || e.codes.some(function (x) { return x.amount > 0; }); }).length;
    delete q.codes;
    return q;
  });
  list.sort(function (a, b) { return a.key.localeCompare(b.key, 'en', { numeric: true, sensitivity: 'base' }); });
  // what is still waiting on a reviewer, what gave nothing, and where the
  // team sits
  var scopeJson = scope ? JSON.stringify(scope) : '';
  var scopeSql = scope ? ' AND s.quest_code IN (SELECT value FROM json_each(?2))' : '';
  var waitStmt = db.prepare(SUB_SELECT + 'WHERE s.team_id = ?1 AND ' + WAITING + scopeSql + ' ORDER BY s.submitted_at, s.id');
  var closedStmt = db.prepare(SUB_SELECT + 'WHERE s.team_id = ?1 AND ' + CLOSED + scopeSql + ' ORDER BY s.id DESC LIMIT ' + CLOSED_SHOWN);
  var tail = await Promise.all([
    (scope ? waitStmt.bind(team.id, scopeJson) : waitStmt.bind(team.id)).all<SubRead>(),
    (scope ? closedStmt.bind(team.id, scopeJson) : closedStmt.bind(team.id)).all<SubRead>(),
    standings(db),
    db.prepare('SELECT hidden, dnf FROM teams WHERE id = ?1').bind(team.id).first<Pick<TeamRow, 'hidden' | 'dnf'>>().catch(function () { return null; }),
    lineMedia(env, ([] as LedgerLine[]).concat.apply([], list.map(function (q) { return q.lines; })))
  ]);
  var subRes = await Promise.all([subRows(db, tail[0].results), subRows(db, tail[1].results)]);
  var waiting = subRes[0], closed = subRes[1];
  var teamId = team.id;
  var board = tail[2];
  var mine = board.filter(function (t) { return t.id === teamId; })[0] || null;
  var more = tail[3];
  var media = tail[4];
  return json({
    ok: true, team: { id: team.id, name: team.name, hidden: !!(more && more.hidden), dnf: !!(more && more.dnf) },
    total: round(total), place: mine ? mine.rank : null, of: lastPlace(board), quests: list, waiting: waiting, closed: closed, media: media
  });
}

// One quest's desk: every team's lines on its codes, best first, drawn
// the way a team's ledger is, with what is waiting on review for it and
// what was rejected. `quest` is a quest's key or a loose code, in any
// case; an account that scores none of its codes is refused.
async function questDesk(env: Env, url: URL, session: ConsoleSession): Promise<Response> {
  var db = env.DB;
  if (!(await ledgerReady(db))) return behind();
  var key = String(cleanText(url.searchParams.get('quest'), 40) || '').toLowerCase();
  var all = await allGroups(db);
  var g = all.groups.filter(function (x) { return x.key.toLowerCase() === key; })[0];
  var loose = g ? null : all.loose.filter(function (c) { return c.code.toLowerCase() === key; })[0];
  if (!g && !loose) return json({ error: 'No such quest.' }, 404);
  // with no quest of that key, the loose code
  var one = loose as DashCode;
  var scope = await scopeCodes(db, session);
  var codes = (g ? g.codes : [one]).filter(function (c) { return inScope(scope, c.code); });
  if (!codes.length) return outOfScope();
  var list = JSON.stringify(codes.map(function (c) { return c.code; }));
  // allGroups gives every quest its rules
  var quest: { key: string; name: string; hidden: boolean; tally: string; ask: string; codes?: { code: string; label: string; points: number }[] } = g
    ? { key: g.key, name: g.name, hidden: !!g.hidden, tally: (g.rules as QuestRules).tally.kind, ask: g.ask && g.ask.kind || '' }
    : { key: one.code, name: one.label || one.code, hidden: !!one.hidden, tally: '', ask: '' };
  quest.codes = codes.filter(function (c) { return !c.hidden; }).map(function (c) { return { code: c.code, label: c.label, points: c.points }; });
  var rows = (await db.prepare(LINE_SELECT + 'WHERE e.code IN (SELECT value FROM json_each(?1)) ORDER BY e.at, e.id').bind(list).all<LineRead>()).results;
  var from = await linesFrom(db, rows);
  var teams: Record<string, { id: number; name: string; hidden: boolean; worth: number; lines: LedgerLine[] }> = {};
  rows.forEach(function (r) {
    var t = teams[r.team_id] = teams[r.team_id] || { id: r.team_id, name: r.team_name, hidden: !!r.team_hidden, worth: 0, lines: [] };
    t.lines.push(ledgerLine(r, from[String(r.id)]));
    if (!r.voided_at) t.worth = Math.round((t.worth + Number(r.points)) * 100) / 100;
  });
  var order = Object.keys(teams).map(function (id) { return teams[id]; });
  order.sort(function (a, b) { return b.worth - a.worth || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }); });
  var waiting = await subRows(db, (await db.prepare(SUB_SELECT + 'WHERE s.quest_code IN (SELECT value FROM json_each(?1)) AND ' + WAITING +
    ' ORDER BY s.submitted_at, s.id').bind(list).all<SubRead>()).results);
  var closed = await subRows(db, (await db.prepare(SUB_SELECT + 'WHERE s.quest_code IN (SELECT value FROM json_each(?1)) AND ' + CLOSED +
    ' ORDER BY s.id DESC LIMIT ' + CLOSED_SHOWN).bind(list).all<SubRead>()).results);
  var media = await lineMedia(env, ([] as LedgerLine[]).concat.apply([], order.map(function (t) { return t.lines; })));
  return json({ ok: true, quest: quest, teams: order, waiting: waiting, closed: closed, media: media });
}

var TEAM_NAME_TAKEN = 'A team with that name is already on the tab.';

async function addTeam(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var name = cleanText(body.name, 80);
  if (!name) return json({ error: 'The team needs a name.' }, 400);
  var reserved = reservedTeamName(name);
  if (reserved) return json({ error: reserved }, 400);
  var clash = await env.DB.prepare('SELECT id FROM teams WHERE name = ?1 COLLATE NOCASE').bind(name).first();
  if (clash) return json({ error: TEAM_NAME_TAKEN }, 409);
  var res: D1Result;
  try {
    res = await env.DB.prepare('INSERT INTO teams (id, name) VALUES (' + NEXT_TEAM_ID + ', ?1)').bind(name).run();
  } catch (err) {
    if (!uniqueClash(err)) throw err;
    return json({ error: TEAM_NAME_TAKEN }, 409);
  }
  await logAction(env.DB, session.name, 'team-add', name, '-', 0, 0, 0);
  return json({ ok: true, id: res.meta && res.meta.last_row_id, name: name });
}

async function renameTeam(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx): Promise<Response> {
  var team = await teamById(env.DB, body.id);
  if (!team) return json({ error: 'no such team' }, 404);
  var name = cleanText(body.name, 80);
  if (!name) return json({ error: 'The team needs a name.' }, 400);
  var reserved = name.toLowerCase() === team.name.toLowerCase() ? '' : reservedTeamName(name);
  if (reserved) return json({ error: reserved }, 400);
  var clash = await env.DB.prepare('SELECT id FROM teams WHERE name = ?1 COLLATE NOCASE AND id != ?2')
    .bind(name, team.id).first();
  if (clash) return json({ error: TEAM_NAME_TAKEN }, 409);
  // the registration and the Discord role/channel follow the tab name
  try {
    await env.DB.batch([
      env.DB.prepare('UPDATE teams SET name = ?2 WHERE id = ?1').bind(team.id, name),
      env.DB.prepare('UPDATE registrations SET team_name = ?2 WHERE team_id = ?1').bind(team.id, name)
    ]);
  } catch (err) {
    if (!uniqueClash(err)) throw err;
    return json({ error: TEAM_NAME_TAKEN }, 409);
  }
  await moveTeamCheckins(env.DB, team.name, name);
  var discordRenamed = await renameTeamDiscord(env, team.id, name);
  // and so does the check-in roster, in the background
  var roster = await env.DB.prepare('SELECT id, name FROM participants WHERE team_id = ?1').bind(team.id).all<Pick<ParticipantRow, 'id' | 'name'>>();
  renameCheckinTeam(env, ctx, roster.results, team.name, name);
  await logAction(env.DB, session.name, 'team-rename', team.name + ' → ' + name, '-', 0, 0, 0);
  return json({ ok: true, id: team.id, name: name, discord_renamed: discordRenamed });
}

// Destructive: type the team's exact name to confirm; its lines go with
// it. The log keeps what the total was at the end.
async function deleteTeam(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx): Promise<Response> {
  var team = await teamById(env.DB, body.id);
  if (!team) return json({ error: 'no such team' }, 404);
  if (String(body.confirm || '') !== team.name) {
    return json({ error: 'Type the team name exactly to delete it.' }, 428);
  }
  var db = env.DB;
  var total = await teamTotal(db, team.id);
  // The team's submissions, their files, its code and its sign-ins go
  // with it: each refers to the team, so the team cannot go without them.
  var files = (await db.prepare(
    'SELECT f.r2_key, f.upload_id, f.status FROM submission_files f JOIN submissions s ON s.id = f.submission_id WHERE s.team_id = ?1'
  ).bind(team.id).all<Pick<SubmissionFileRow, 'r2_key' | 'upload_id' | 'status'>>()).results;
  var copies = files.length ? (await db.prepare(
    'SELECT key FROM submission_renditions WHERE file_key IN (SELECT value FROM json_each(?1))'
  ).bind(JSON.stringify(files.map(function (f) { return f.r2_key; }))).all<{ key: string }>()).results : [];
  var theirs = 'SELECT f.id FROM submission_files f JOIN submissions s ON s.id = f.submission_id WHERE s.team_id = ?1';
  await db.batch([
    db.prepare('DELETE FROM submission_upload_parts WHERE file_id IN (' + theirs + ')').bind(team.id),
    db.prepare('DELETE FROM submission_renditions WHERE file_key IN (SELECT f.r2_key FROM submission_files f JOIN submissions s ON s.id = f.submission_id WHERE s.team_id = ?1)').bind(team.id),
    db.prepare('DELETE FROM submission_files WHERE id IN (' + theirs + ')').bind(team.id),
    db.prepare('DELETE FROM submissions WHERE team_id = ?1').bind(team.id),
    db.prepare('DELETE FROM team_codes WHERE team_id = ?1').bind(team.id),
    ...forgetPhoneTeam(db, team.id),
    db.prepare('DELETE FROM submit_sessions WHERE team_id = ?1').bind(team.id),
    // the old copy of the tab still names the team, and D1 holds it to
    // its foreign key
    db.prepare('DELETE FROM completions WHERE team_id = ?1').bind(team.id),
    // its lines on the ledger
    db.prepare('DELETE FROM entries WHERE team_id = ?1').bind(team.id),
    db.prepare('DELETE FROM teams WHERE id = ?1').bind(team.id),
    // its id is never given to another team: its people, Discord role,
    // team groups, answers and phones keep it as their paper trail
    retireTeamId(db, team.id)
  ]);
  // and it comes off any album it was picked for
  await forgetTeam(db, team.id);
  // and its recorded route, and where its photos were taken
  await forgetTrack(env, team.id);
  await forgetPhotoPlaces(db);
  await logAction(db, session.name, 'team-delete', team.name, '-', -total, total, 0);
  if (env.SUBMIT && (files.length || copies.length)) {
    var bucket = cleanupBucketFiles(env, files, copies);
    if (ctx && ctx.waitUntil) ctx.waitUntil(bucket); else await bucket;
  }
  return json({ ok: true });
}

async function cleanupBucketFiles(env: Env, files: { r2_key: string; status: string; upload_id: string | null }[], copies: { key: string }[]): Promise<void> {
  if (!env.SUBMIT) return;
  for (var i = 0; i < files.length; i++) {
    var f = files[i];
    if (f.status === 'uploading' && f.upload_id) {
      try {
        if (isDirect(f.upload_id)) await directAbort(env, f.r2_key, directIdOf(f.upload_id));
        else await env.SUBMIT.resumeMultipartUpload(f.r2_key, f.upload_id).abort();
      } catch (err) { /* parts already gone */ }
    }
    await deleteStored(env.SUBMIT, f.r2_key);
  }
  await Promise.all(copies.map(function (c) {
    return Promise.resolve().then(function () { return env.SUBMIT.delete(c.key); }).catch(function () { /* nothing points at it any more */ });
  }));
}

async function teamsByIds(db: D1Database, rawIds: unknown[]): Promise<Pick<TeamRow, 'id' | 'name'>[]> {
  var unique: number[] = [];
  for (var i = 0; i < rawIds.length && unique.length < 500; i++) {
    var n = Number(rawIds[i]);
    if (n > 0 && isFinite(n) && unique.indexOf(n) === -1) unique.push(n);
  }
  if (!unique.length) return [];
  return (await db.prepare(
    'SELECT id, name FROM teams WHERE id IN (SELECT value FROM json_each(?1))'
  ).bind(JSON.stringify(unique)).all<Pick<TeamRow, 'id' | 'name'>>()).results;
}

// Hidden teams stay fully intact — scores, submissions, codes — but
// vanish from every public read: leaderboard, quest counts, stats,
// gallery, Discord lookups. The switch for test teams on event day.
// `ids` instead of `id` hides or shows several at once (every team in a
// team group, from the Access tab).
async function hideTeam(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var want = body.hidden ? 1 : 0;
  if (Array.isArray(body.ids)) {
    var teams = await teamsByIds(env.DB, body.ids);
    if (!teams.length) return json({ error: 'no such teams' }, 404);
    await env.DB.prepare(
      'UPDATE teams SET hidden = ?2 WHERE id IN (SELECT value FROM json_each(?1))'
    ).bind(JSON.stringify(teams.map(function (t) { return t.id; })), want).run();
    await logAction(env.DB, session.name, want ? 'team-hide' : 'team-show',
      teams.length === 1 ? teams[0].name : teams.length + ' teams', teams.map(function (t) { return t.name; }).join(', ').slice(0, 200), 0, 0, 0);
    return json({ ok: true, count: teams.length, hidden: want });
  }
  var team = await teamById(env.DB, body.id);
  if (!team) return json({ error: 'no such team' }, 404);
  await env.DB.prepare('UPDATE teams SET hidden = ?2 WHERE id = ?1').bind(team.id, want).run();
  await logAction(env.DB, session.name, want ? 'team-hide' : 'team-show', team.name, '-', 0, 0, 0);
  return json({ ok: true, id: team.id, name: team.name, hidden: want });
}

// A team that did not finish keeps its points and its spot in the order
// on every board, with no place, and the teams under it move up one
// (`standings` in tab.ts). `ids` instead of `id` marks several at once.
async function setTeamDnf(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var want = body.dnf ? 1 : 0;
  var teams = await teamsByIds(env.DB, Array.isArray(body.ids) ? body.ids : [body.id]);
  if (!teams.length) return json({ error: Array.isArray(body.ids) ? 'no such teams' : 'no such team' }, 404);
  await env.DB.prepare(
    'UPDATE teams SET dnf = ?2 WHERE id IN (SELECT value FROM json_each(?1))'
  ).bind(JSON.stringify(teams.map(function (t) { return t.id; })), want).run();
  await logAction(env.DB, session.name, want ? 'team-dnf' : 'team-finish',
    teams.length === 1 ? teams[0].name : teams.length + ' teams',
    teams.length === 1 ? '-' : teams.map(function (t) { return t.name; }).join(', ').slice(0, 200), 0, 0, 0);
  if (Array.isArray(body.ids)) return json({ ok: true, count: teams.length, dnf: want });
  return json({ ok: true, id: teams[0].id, name: teams[0].name, dnf: want });
}

async function addQuest(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var code = cleanText(body.code, 40);
  var points = Number(body.points);
  if (!code) return json({ error: 'The quest needs a code.' }, 400);
  if (!isFinite(points)) return json({ error: 'Points must be a number.' }, 400);
  if (reservedCode(code)) return json({ error: reservedCode(code) }, 400);
  var norm = normQuest(code);
  var clash = await env.DB.prepare('SELECT code FROM quests WHERE norm = ?1').bind(norm).first<Pick<QuestRow, 'code'>>();
  if (clash) return json({ error: 'That code already exists as ' + clash.code + '.' }, 409);
  await env.DB.prepare('INSERT INTO quests (code, norm, points) VALUES (?1, ?2, ?3)').bind(code, norm, points).run();
  await logAction(env.DB, session.name, 'quest-add', '-', code, points, 0, 0);
  return json({ ok: true, code: code, norm: norm, points: points });
}

// Points always editable; a rename takes the code's lines with it, so
// nothing on the tab is orphaned. A tiered or counted code's points
// follow its bands, which the quest editor sets, so this refuses one. A
// rename of a code with no quest round it renames it in the accounts
// limited to it, which name it as a quest's key.
async function editQuest(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var quest = await questByCode(env.DB, body.code);
  if (!quest) return json({ error: 'no such quest' }, 404);
  var points = Number(body.points);
  if (!isFinite(points)) return json({ error: 'Points must be a number.' }, 400);
  var newCode = body.new_code != null ? cleanText(body.new_code, 40) : quest.code;
  if (!newCode) return json({ error: 'The quest needs a code.' }, 400);
  var part = (await partsFor(env.DB, [quest.code]))[quest.code];
  if (part && (part.scoring === 'tiered' || part.scoring === 'counted')) {
    return json({ error: quest.code + ' is scored by bands, so change it in its quest’s editor.' }, 409);
  }
  if (newCode !== quest.code) {
    if (reservedCode(quest.code)) return json({ error: quest.code + ' cannot be renamed.' }, 400);
    if (reservedCode(newCode)) return json({ error: reservedCode(newCode) }, 400);
  }
  var newNorm = normQuest(newCode);
  var ledger = await ledgerReady(env.DB);
  if (points !== quest.points && !ledger) return behind();
  if (newCode === quest.code) {
    await env.DB.batch([env.DB.prepare('UPDATE quests SET points = ?2 WHERE code = ?1').bind(quest.code, points)]
      .concat(rescoreLines(env.DB, quest.code, quest.points, points, session.name)));
  } else {
    var clash = await env.DB.prepare('SELECT code FROM quests WHERE norm = ?1 AND code != ?2')
      .bind(newNorm, quest.code).first<Pick<QuestRow, 'code'>>();
    if (clash) return json({ error: 'That code already exists as ' + clash.code + '.' }, 409);
    // a rename re-keys the code's lines and submissions in one batch
    // (see quests.ts)
    // the code's own row
    var meta = await env.DB.prepare('SELECT group_id, label, sort, hidden, scoring, most, bands FROM quests WHERE code = ?1').bind(quest.code)
      .first<Pick<QuestRow, 'group_id' | 'label' | 'sort' | 'hidden' | 'scoring' | 'most' | 'bands'>>() as Pick<QuestRow, 'group_id' | 'label' | 'sort' | 'hidden' | 'scoring' | 'most' | 'bands'>;
    await env.DB.batch(renameStatements(env.DB, quest.code, newCode,
      { points: points, group_id: meta.group_id, label: meta.label || '', sort: meta.sort || 0, hidden: meta.hidden || 0,
        scoring: meta.scoring || '', most: meta.most, bands: meta.bands || '' }, ledger)
      .concat(ledger ? rescoreLines(env.DB, newCode, quest.points, points, session.name) : []));
    if (meta.group_id == null) await renameInScopes(env.DB, quest.code, newCode);
  }
  await logAction(env.DB, session.name, 'quest-edit',
    '-', quest.code + (newCode !== quest.code ? ' → ' + newCode : ''), points - quest.points, quest.points, points);
  return json({ ok: true, code: newCode, points: points });
}

// One code, a quest's part or a code with no quest round it. What it
// leaves behind moves to the holder of deleted quests the way a whole
// quest's does (deleteGroup), and a code with no quest round it comes
// out of the accounts limited to it.
async function deleteQuest(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var db = env.DB;
  var quest = await db.prepare('SELECT code, group_id FROM quests WHERE code = ?1').bind(String(body.code || ''))
    .first<Pick<QuestRow, 'code' | 'group_id'>>();
  if (!quest) return json({ error: 'no such quest' }, 404);
  if (quest.code === DELETED_CODE) return json({ error: quest.code + ' holds what deleted quests leave behind, so it stays.' }, 409);
  var used = await db.prepare('SELECT COUNT(*) AS n FROM held WHERE quest_code = ?1').bind(quest.code).first<{ n: number }>() as { n: number };
  var scopes = quest.group_id == null ? await dropFromScopes(db, quest.code) : { stranded: [], writes: [] };
  if (scopes.stranded.length) return json({ error: strandedRefusal(scopes.stranded) }, 409);
  if (String(body.confirm || '') !== quest.code) {
    return json({
      error: used.n > 0
        ? 'This quest is on the tab for ' + used.n + ' team' + (used.n === 1 ? '' : 's') + '. Type its code exactly to delete it and those entries.'
        : 'Type the quest code exactly to delete it.'
    }, 428);
  }
  var ledger = await ledgerReady(db);
  await db.batch((ledger ? [holderStatement(db)] : []).concat(ledger ? codeGone(db, quest.code, session.name) : [],
    ledger ? holdStatements(db, quest.code) : [], [
      // the old copy of the tab, held to its foreign key on the code
      db.prepare('DELETE FROM completions WHERE quest_code = ?1').bind(quest.code),
      db.prepare('DELETE FROM quests WHERE code = ?1').bind(quest.code)
    ], scopes.writes));
  await logAction(db, session.name, 'quest-delete', used.n + ' entries', quest.code, 0, 0, 0);
  return json({ ok: true });
}

// One call sets a team's amount for a quest: a number upserts, empty
// or zero takes the entry off the tab. Fractions are partial credit,
// counts above one are repeatables — same model as /submit.
// ---------- bulk import (Tabbycat-style: paste, review, commit) ----------
// Preview parses and diffs against the database without writing;
// commit re-runs the same parse server-side and applies it, so a
// stale or tampered preview can never write something it didn't show.


// ---------- web submissions: review, files, team codes ----------

// A claim on a submission lasts this long. It is not a lock — two
// reviewers can still both act — it is one saying to the other that
// they are already on this one.
// One submission as Review lists it, the answer read back and the
// rest put on below.
type ReviewRow = Pick<SubmissionRow, 'id' | 'quest_code' | 'note' | 'status' | 'submitted_at' | 'reviewed_by' | 'reason' | 'gallery'> &
  { answer: unknown; claimed_by: string; claimed_at: string; team_id: number; team_name: string; points: number | null; group_id: number | null;
  group_key: string | null; quest_name: string | null; codes?: Pick<Part, 'code' | 'label' | 'points' | 'scoring' | 'most' | 'bands'>[];
  part?: { given: number; of: number } | null; scoring?: string; most?: number | null; bands?: Part['bands']; files?: { kinds: string[]; max: number };
  tally?: string; added_by?: string; credit?: Credit | null; credited?: Record<string, number>; media?: MediaOut[]; deleted_from?: string };
// A submission as the review actions read it.
type PendingSub = Pick<SubmissionRow, 'id' | 'quest_code' | 'status' | 'team_id'> & { team_name: string };

var CLAIM_MINUTES = 10;
var CLAIM_FRESH = "(COALESCE(s.claimed_at, '') != '' AND s.claimed_at > datetime('now', '-" + CLAIM_MINUTES + " minutes'))";

// The review list: one status, or all of them, one quest when `quest`
// names its key (or a code that has no quest) and one team when
// `team_id` names it; or, with `id`, that one submission whatever its
// status, which is how the ledger and the desk open one. Pending ones
// come oldest first, the order they are reviewed in, and the rest
// newest first. `counts` is how many each quest has in that status and
// `team_counts` how many each team has, the whole of it rather than the
// 200 the list carries and whatever quest or team is picked. A quest's
// `hidden` is how many of those are from hidden teams and a team's is
// its own flag, so the page can leave them out as it does the rows.
async function submissionList(env: Env, url: URL, session: ConsoleSession): Promise<Response> {
  var status = url.searchParams.get('status') || 'pending';
  if (['pending', 'accepted', 'rejected', 'deleted', 'all'].indexOf(status) === -1) status = 'pending';
  var one = Number(url.searchParams.get('id')) || 0;
  if (one) status = 'pending';
  var quest = one ? '' : cleanText(url.searchParams.get('quest'), 40);
  var teamId = one ? 0 : Number(url.searchParams.get('team_id')) || 0;
  // an account limited to some quests reviews those alone
  var scope = await scopeCodes(env.DB, session);
  var scopeJson = scope ? JSON.stringify(scope) : '';
  var binds: (string | number)[] = [status];
  var where = status === 'all' || one ? 'WHERE ?1 = ?1 ' : 'WHERE s.status = ?1 ';
  if (one) { binds.push(one); where += 'AND s.id = ?' + binds.length + ' '; }
  if (quest) { binds.push(quest); where += 'AND COALESCE(g.key, s.quest_code) = ?' + binds.length + ' COLLATE NOCASE '; }
  if (teamId) { binds.push(teamId); where += 'AND s.team_id = ?' + binds.length + ' '; }
  if (scope) { binds.push(scopeJson); where += 'AND s.quest_code IN (SELECT value FROM json_each(?' + binds.length + ')) '; }
  var listStmt = env.DB.prepare(
    'SELECT s.id, s.quest_code, s.note, s.status, s.submitted_at, s.reviewed_by, s.reason, s.gallery, s.answer, ' +
    's.added_by, s.credit AS raw_credit, ' +
    'CASE WHEN ' + CLAIM_FRESH + " THEN s.claimed_by ELSE '' END AS claimed_by, " +
    'CASE WHEN ' + CLAIM_FRESH + " THEN s.claimed_at ELSE '' END AS claimed_at, " +
    't.id AS team_id, t.name AS team_name, q.points, q.group_id, g.key AS group_key, g.name AS quest_name ' +
    'FROM submissions s JOIN teams t ON t.id = s.team_id ' +
    'LEFT JOIN quests q ON q.code = s.quest_code ' +
    'LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    where + (status === 'pending' && !one ? 'ORDER BY s.submitted_at, s.id' : 'ORDER BY s.id DESC') + ' LIMIT 200'
  );
  var countStmt = env.DB.prepare(
    'SELECT COALESCE(g.key, s.quest_code) AS key, COALESCE(g.name, s.quest_code) AS name, s.quest_code, t.hidden, COUNT(*) AS n ' +
    'FROM submissions s JOIN teams t ON t.id = s.team_id ' +
    'LEFT JOIN quests q ON q.code = s.quest_code LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    (status === 'all' ? 'WHERE ?1 = ?1 ' : 'WHERE s.status = ?1 ') + 'GROUP BY 1, s.quest_code, t.hidden'
  );
  var teamStmt = env.DB.prepare(
    'SELECT t.id, t.name, t.hidden, COUNT(*) AS n FROM submissions s JOIN teams t ON t.id = s.team_id ' +
    (status === 'all' ? 'WHERE ?1 = ?1 ' : 'WHERE s.status = ?1 ') +
    (scope ? 'AND s.quest_code IN (SELECT value FROM json_each(?2)) ' : '') + 'GROUP BY t.id'
  );
  var pendingStmt = env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(t.hidden), 0) AS hidden FROM submissions s JOIN teams t ON t.id = s.team_id WHERE s.status = 'pending'" +
    (scope ? ' AND s.quest_code IN (SELECT value FROM json_each(?1))' : '')
  );
  var wave1 = await Promise.all([
    listStmt.bind.apply(listStmt, binds).all<ReviewRow & { raw_credit?: string | null }>(),
    countStmt.bind(status).all<{ key: string; name: string; quest_code: string; hidden: number; n: number }>(),
    teamStmt.bind.apply(teamStmt, scope ? [status, scopeJson] : [status]).all(),
    (scope ? pendingStmt.bind(scopeJson) : pendingStmt).first<{ n: number; hidden: number }>(),
    storedRules(env.DB)
  ]);
  var rows = wave1[0];
  var countRows = wave1[1].results;
  var teamCounts = wave1[2].results;
  var pending = wave1[3] as { n: number; hidden: number };
  var ruled = wave1[4];

  type Count = { key: string; name: string; n: number; hidden: number };
  var counts: Count[] = [];
  var countOf: Record<string, Count> = {};
  countRows.forEach(function (c) {
    if (scope && !inScope(scope, c.quest_code)) return;
    var at = countOf[c.key];
    if (!at) { at = countOf[c.key] = { key: c.key, name: c.name, n: 0, hidden: 0 }; counts.push(at); }
    at.n += c.n;
    if (c.hidden) at.hidden += c.n;
  });

  // the reviewer picks which of the quest's codes to credit, so each
  // row carries its group's codes
  var groupIds: number[] = [];
  var withCredit: { row: ReviewRow; credit: Credit | null }[] = [];
  rows.results.forEach(function (r) {
    r.answer = parseAnswer(r.answer);
    r.added_by = r.added_by || '';
    var parsedCredit = readCredit(r.raw_credit);
    delete r.raw_credit;
    r.credit = parsedCredit;
    if (parsedCredit) withCredit.push({ row: r, credit: parsedCredit });
    if (r.group_id && groupIds.indexOf(r.group_id) === -1) groupIds.push(r.group_id);
  });

  var heldDeleted = rows.results.filter(function (r) { return r.quest_code === DELETED_CODE; });

  var wave2 = await Promise.all([
    attachMedia(env, rows.results),
    groupIds.length
      ? env.DB.prepare(
          'SELECT code, group_id, label, points, scoring, most, bands FROM quests WHERE hidden = 0 AND ' +
          'group_id IN (SELECT value FROM json_each(?1)) ORDER BY sort, code'
        ).bind(JSON.stringify(groupIds)).all<PartRow & { group_id: number }>()
      : Promise.resolve({ results: [] as (PartRow & { group_id: number })[] }),
    partsFor(env.DB, rows.results.map(function (r) { return r.quest_code; })),
    withCredit.length ? partMarks(env.DB, withCredit.map(function (w) { return w.credit; })) : Promise.resolve([] as ({ given: number; of: number } | null)[]),
    attachCredited(env, rows.results),
    nameDeleted(env.DB, rows.results, 'quest_code', 'submissions', function (r) { return r.id; }),
    questionsByGroup(env.DB, groupIds)
  ]);

  var codesByGroup: Record<number, ReturnType<typeof partFields>[]> = {};
  wave2[1].results.forEach(function (c) {
    (codesByGroup[c.group_id] = codesByGroup[c.group_id] || []).push(partFields(partOf(c)));
  });
  var own = wave2[2];
  var marks = wave2[3];
  var gone = wave2[5];
  var questions = wave2[6];

  rows.results.forEach(function (r) {
    var rules = rulesOf(r.group_id ? ruled[r.group_id] : '');
    r.codes = r.group_id ? (codesByGroup[r.group_id] || []) : [];
    var mine = own[r.quest_code];
    r.part = null;
    r.scoring = mine ? mine.scoring : '';
    r.most = mine ? mine.most : null;
    r.bands = mine ? mine.bands : [];
    r.files = { kinds: rules.files.kinds, max: rules.files.max };
    r.tally = rules.tally.kind;
  });
  withCredit.forEach(function (w, i) { w.row.part = marks[i]; });

  // a deleted quest's submission reads as the quest it came from, and the
  // page offers it nothing that credits it
  heldDeleted.forEach(function (r) {
    r.deleted_from = gone[String(r.id)] || DELETED_CODE;
    r.points = null;
    r.quest_name = null;
  });
  counts.forEach(function (c) { if (c.key === DELETED_CODE) c.name = 'Deleted quests'; });
  var wantsPlaces = Object.keys(questions).some(function (id) {
    return questions[id].some(function (q) { return q.kind === 'pick' && q.options.some(function (o) { return o.charAt(0) === '@'; }); });
  });
  return json({ ok: true, status: status, quest: quest, team_id: teamId || null, submissions: rows.results,
    counts: counts, team_counts: teamCounts, pending: { n: pending.n, hidden: pending.hidden }, questions: questions, places: wantsPlaces ? PLACES : undefined });
}

// What a team answered, changed after it was sent: a count misread, the
// wrong option picked. Any submission but a deleted one, by an account
// that scores its quest. The answer is cleaned as a team's is. Nothing on
// the tab moves, though a challenge counted from the answers counts the
// new one.
async function reviseAnswer(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var db = env.DB;
  var sub = await db.prepare(
    'SELECT s.id, s.status, s.quest_code, s.answer, t.name AS team_name FROM submissions s JOIN teams t ON t.id = s.team_id WHERE s.id = ?1'
  ).bind(Number(body.id) || 0).first<Pick<SubmissionRow, 'id' | 'status' | 'quest_code' | 'answer'> & { team_name: string }>();
  if (!sub) return json({ error: 'not found' }, 404);
  if (sub.status === 'deleted') return json({ error: 'That submission has been deleted.' }, 409);
  if (!inScope(await scopeCodes(db, session), sub.quest_code)) {
    return json({ error: 'This account does not score ' + sub.quest_code + '.', no_access: true }, 403);
  }
  var raw = body.answer == null ? '' : typeof body.answer === 'string' ? body.answer : JSON.stringify(body.answer);
  var refused: { error?: string } = {};
  var answer = cleanAnswer(raw, refused);
  if (answer === false) return json({ error: refused.error || 'That answer is not valid.' }, 400);
  if ((answer || null) === (sub.answer || null)) return json({ ok: true, unchanged: true, answer: parseAnswer(sub.answer) });
  await db.prepare("UPDATE submissions SET answer = ?2 WHERE id = ?1 AND status != 'deleted'").bind(sub.id, answer).run();
  await logAction(db, session.name, 'submit-answer', sub.team_name,
    sub.quest_code + ' ' + answerText(sub.answer) + ' → ' + answerText(answer), 0, 0, 0);
  return json({ ok: true, answer: parseAnswer(answer) });
}

// a stored answer on one line for the log
function answerText(stored: unknown): string {
  var a = parseAnswer(stored);
  if (!a) return '(none)';
  return ([a] as (AnswerEntry | null)[]).concat(a.more || []).map(function (e) {
    if (!e || e.value == null) return '-';
    return Array.isArray(e.value) ? e.value.join(', ') : String(e.value);
  }).join(' | ').slice(0, 300);
}

// What each team already holds on the quest it is submitting for, so a
// second acceptance is a choice rather than an accident. One query for
// the whole list, matching only the submission ids in the page.
async function attachCredited(env: Env, rows: ReviewRow[]): Promise<void> {
  rows.forEach(function (r) { r.credited = {}; });
  if (!rows.length) return;
  var byId: Record<number, ReviewRow> = {};
  var ids: number[] = [];
  rows.forEach(function (r) {
    byId[r.id] = r;
    ids.push(r.id);
  });
  var held = await env.DB.prepare(
    'SELECT s.id AS sub_id, c.quest_code AS code, c.amount AS amount FROM submissions s ' +
    'JOIN quests q0 ON q0.code = s.quest_code ' +
    'JOIN quests q ON q.code = s.quest_code OR ' +
    '(q0.group_id IS NOT NULL AND q.group_id = q0.group_id AND q.hidden = 0) ' +
    'JOIN held c ON c.team_id = s.team_id AND c.quest_code = q.code ' +
    'WHERE s.id IN (SELECT value FROM json_each(?1))'
  ).bind(JSON.stringify(ids)).all<{ sub_id: number; code: string; amount: number }>();
  held.results.forEach(function (c) {
    var row = byId[c.sub_id];
    if (row) (row.credited as Record<string, number>)[c.code] = c.amount;
  });
}

// Where a photo was taken, on what, and whether it has been touched
// since — read from the block the worker took out of it at upload, a
// few KB rather than the whole picture. This is the only place that
// data is handed out: the site serves the copy with it removed.
//
// None of it is proof. Anyone who knows to strip a file before
// uploading defeats all of it. What it catches is what actually
// happens: a screenshot of someone else's photo, or a picture off the
// internet, arrives with no camera data in it at all.
async function fileMeta(env: Env, url: URL, session: ConsoleSession): Promise<Response> {
  if (!env.SUBMIT) return json({ error: 'no SUBMIT bucket bound' }, 503);
  var key = url.searchParams.get('key') || '';
  if (key.indexOf('sub/') !== 0) return json({ error: 'not found' }, 404);
  var row = await env.DB.prepare(
    'SELECT f.content_type, f.name, s.quest_code FROM submission_files f ' +
    'JOIN submissions s ON s.id = f.submission_id WHERE f.r2_key = ?1'
  ).bind(key).first<Pick<SubmissionFileRow, 'content_type' | 'name'> & { quest_code: string }>();
  if (!row) return json({ error: 'not found' }, 404);
  if (!inScope(await scopeCodes(env.DB, session), row.quest_code)) return outOfScope();
  // the block is written at upload; a photo from before that is read
  // here the first time someone asks
  var meta = readExif(await metaBlock(env, key, row.content_type));
  return json(Object.assign({ ok: true, name: row.name, type: row.content_type }, meta),
    200, { 'cache-control': 'private, no-store' });
}

// A GPX track sent as proof, read for the review card (track.ts): how
// far it goes, when, and a line to draw. A submission's own files only.
var MAX_TRACK_BYTES = 32 * 1024 * 1024;

async function fileTrack(env: Env, url: URL, session: ConsoleSession): Promise<Response> {
  if (!env.SUBMIT) return json({ error: 'no SUBMIT bucket bound' }, 503);
  var key = url.searchParams.get('key') || '';
  if (key.indexOf('sub/') !== 0) return json({ error: 'not found' }, 404);
  var row = await env.DB.prepare(
    'SELECT f.content_type, f.name, f.status, s.quest_code FROM submission_files f ' +
    'JOIN submissions s ON s.id = f.submission_id WHERE f.r2_key = ?1'
  ).bind(key).first<Pick<SubmissionFileRow, 'content_type' | 'name' | 'status'> & { quest_code: string }>();
  if (!row || fileKindOf(row.content_type, row.name) !== 'gpx') return json({ error: 'not found' }, 404);
  if (!inScope(await scopeCodes(env.DB, session), row.quest_code)) return outOfScope();
  if (row.status === 'uploading') return json({ error: 'That track is still uploading.' }, 409);
  var stored = await env.SUBMIT.get(key);
  if (!stored) return json({ error: 'not found' }, 404);
  if (stored.size > MAX_TRACK_BYTES) return json({ error: 'That track is too large to read here. Download it instead.' }, 413);
  var track = readTrack(new TextDecoder().decode(await stored.arrayBuffer()));
  return json(Object.assign({ ok: true }, track), 200, { 'cache-control': 'private, no-store' });
}

// Streams a proof file to the signed-in reviewer, passing Range
// through so videos scrub instead of downloading whole. This is the
// one endpoint that still reaches an original — everything public
// gets the copy with the metadata taken out.
async function serveFile(env: Env, request: Request, url: URL, session: ConsoleSession): Promise<Response> {
  if (!env.SUBMIT) return json({ error: 'no SUBMIT bucket bound' }, 503);
  var key = url.searchParams.get('key') || '';
  if (key.indexOf('sub/') !== 0) return json({ error: 'not found' }, 404);
  var scope = await scopeCodes(env.DB, session);
  var fileRow: (Pick<SubmissionFileRow, 'content_type' | 'name'> & { quest_code: string }) | null = null;
  var res = url.searchParams.get('res');
  var needRow = !!scope || url.searchParams.get('picked') === '1' || !!url.searchParams.get('download') ||
    !!url.searchParams.get('thumb') || wantsSmaller(res);
  if (needRow) {
    fileRow = await env.DB.prepare(
      'SELECT f.content_type, f.name, s.quest_code FROM submission_files f ' +
      'JOIN submissions s ON s.id = f.submission_id WHERE f.r2_key = ?1'
    ).bind(key).first<Pick<SubmissionFileRow, 'content_type' | 'name'> & { quest_code: string }>();
    if (scope) {
      if (!fileRow) return json({ error: 'not found' }, 404);
      if (!inScope(scope, fileRow.quest_code)) return outOfScope();
    }
  }
  // picked=1: the HEIC or WebP the photo was picked as, saved as a file
  if (url.searchParams.get('picked') === '1') {
    var twin = fileRow ? await pickedOf(env, key) : null;
    return (fileRow && twin && await servePickedFile(env.SUBMIT, request, key, twin, fileRow.name, 'private, no-store')) ||
      json({ error: 'not found' }, 404);
  }
  // download=1: the original, saved as a file under the name it was sent with
  if (url.searchParams.get('download')) {
    if (!fileRow) return json({ error: 'not found' }, 404);
    return asDownload((await serveStoredFile(env.SUBMIT, request, key, 'private, no-store')) ||
      (await standIn(env, request, key, 'private, no-store')), fileRow.name) ||
      json({ error: 'not found' }, 404);
  }
  // A GIF's small copies are one frame of it, so it is served whole
  // whatever was asked for — a still in place of the animation is the
  // animation not playing. Only looked up when a smaller copy is on
  // the table; the plain URL is the original either way.
  var moves = animatedType(fileRow && fileRow.content_type);
  var video = String((fileRow && fileRow.content_type) || '').indexOf('video/') === 0;
  if (url.searchParams.get('thumb') && !moves) {
    var small = await serveStoredFile(env.SUBMIT, request, key + '.t', 'private, max-age=300');
    if (small) return small;
    // the still of a video is asked for by an img tag, which cannot
    // show the video itself
    if (video) return json({ error: 'no still' }, 404);
  }
  // res= picks a smaller copy of a video where the encoder has made
  // one, or a photo's viewing copy; every step falls back to the
  // original
  var alt = await renditionKey(env, key, res);
  if (alt) {
    var smaller = await serveStoredFile(env.SUBMIT, request, alt, 'private, max-age=300');
    if (smaller) return smaller;
  }
  if (wantsSmaller(res) && !moves) {
    var view = await serveStoredFile(env.SUBMIT, request, key + '.v', 'private, max-age=300');
    if (view) return view;
  }
  return (await serveStoredFile(env.SUBMIT, request, key, 'private, max-age=300')) ||
    (await standIn(env, request, key, 'private, max-age=300')) ||
    json({ error: 'not found' }, 404);
}

// A video whose original has been deleted (originals.ts) is shown by
// the copy that stands in for it on the site: the clean copy, else the
// largest of the smaller ones.
async function standIn(env: Env, request: Request, key: string, cacheControl: string): Promise<Response | null> {
  var clean = await serveStoredFile(env.SUBMIT, request, key + '.c', cacheControl);
  if (clean) return clean;
  var top = await largestRendition(env, key);
  return top ? serveStoredFile(env.SUBMIT, request, top, cacheControl) : null;
}

function pendingSubmission(db: D1Database, id: unknown): Promise<PendingSub | null> {
  return db.prepare(
    'SELECT s.id, s.quest_code, s.status, s.team_id, t.name AS team_name FROM submissions s ' +
    'JOIN teams t ON t.id = s.team_id WHERE s.id = ?1'
  ).bind(Number(id) || 0).first<PendingSub>();
}

// Accepting adds the given amount onto the team's entry for that
// quest (1 for a normal completion, a count for a repeat) — the same
// increment /submit does, then the submission is stamped. On a quest
// that takes part marks, `awarded` gives a code part of its points.
async function acceptSubmission(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, origin: string): Promise<Response> {
  var sub = await pendingSubmission(env.DB, body.id);
  if (!sub) return json({ error: 'no such submission' }, 404);
  if (sub.status !== 'pending') return json({ error: 'already ' + sub.status }, 409);
  if (sub.quest_code === DELETED_CODE) return json({ error: DELETED_QUEST }, 409);
  var quest = await questByCode(env.DB, sub.quest_code);
  if (!quest) return json({ error: 'Quest ' + sub.quest_code + ' is no longer on the tab. Add it back or reject this.' }, 409);
  var read = await readCreditFrom(env.DB, quest, body);
  if ('error' in read) return json({ error: read.error }, 400);
  var given = read.credit;
  var codes = given.codes;
  var scope = await scopeCodes(env.DB, session);
  if (!inScope(scope, sub.quest_code) || !codes.every(function (c) { return inScope(scope, c); })) return outOfScope();
  if (!(await ledgerReady(env.DB))) return behind();
  var oldTotal = await teamTotal(env.DB, sub.team_id);
  // The decision, what it gave and its lines are one transaction, and
  // the decision goes first: it claims the submission from pending with
  // a stamp of this request's own (in claimed_at, which a decision clears
  // anyway), and each line only lands if that stamp is the one there.
  // Two reviewers pressing Accept at once, or a request sent twice,
  // credit it once; an Accept racing a Reject credits only if it won. A
  // code renamed or deleted since it was read has no row to write a line
  // on, so the claim waits for every code to be there.
  var mark = 'accepting:' + randomKey(9);
  var stmts = [env.DB.prepare(
    "UPDATE submissions SET status = 'accepted', reviewed_by = ?2, reviewed_at = datetime('now'), " +
    "claimed_by = '', claimed_at = ?3, credit = ?4 WHERE id = ?1 AND status = 'pending' AND " + codesThere('?4')
  ).bind(sub.id, session.name, mark, creditJson(given))]
    .concat(creditLines(env.DB, sub, given, { by: session.name, where: claimed(10), args: [sub.id, mark] }),
      [env.DB.prepare("UPDATE submissions SET claimed_at = '' WHERE id = ?1 AND claimed_at = ?2").bind(sub.id, mark)]);
  var done = await env.DB.batch(stmts);
  if (!done[0].meta || !done[0].meta.changes) {
    var now = await pendingSubmission(env.DB, sub.id);
    if (now && now.status === 'pending') return json({ error: CODES_MOVED }, 409);
    return json({ error: 'already ' + (now ? now.status : 'decided') }, 409);
  }
  var total = await teamTotal(env.DB, sub.team_id);
  await logAction(env.DB, session.name, 'submit-accept', sub.team_name, codes.join(' + '), total - oldTotal, oldTotal, total);
  var told = tellTeam(env, origin, sub, { verdict: 'accepted', quest: quest.code, credit: given, total: total });
  if (ctx && ctx.waitUntil) ctx.waitUntil(told); else await told;
  var worth = creditWorth(read.parts, given);
  return json({ ok: true, id: sub.id, team: sub.team_name, quest: codes.join(' + '), codes: codes, amount: given.amount, total: total,
    gained: worth.given, full: worth.full });
}

// Rejecting takes an optional reason. It is the one thing the team is
// told beyond the verdict — it rides out on the notification and sits
// on the submission in their own list — so it is worth typing.
async function rejectSubmission(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, origin: string): Promise<Response> {
  var sub = await pendingSubmission(env.DB, body.id);
  if (!sub) return json({ error: 'no such submission' }, 404);
  if (sub.status !== 'pending') return json({ error: 'already ' + sub.status }, 409);
  if (!inScope(await scopeCodes(env.DB, session), sub.quest_code)) return outOfScope();
  var reason = cleanText(body.reason, 200);
  // only from pending, so a Reject racing an Accept cannot leave a
  // rejected submission whose points are on the tab
  var res = await env.DB.prepare(
    "UPDATE submissions SET status = 'rejected', reviewed_by = ?2, reviewed_at = datetime('now'), reason = ?3, " +
    "claimed_by = '', claimed_at = '' WHERE id = ?1 AND status = 'pending'"
  ).bind(sub.id, session.name, reason || null).run();
  if (!res.meta || !res.meta.changes) {
    var now = await pendingSubmission(env.DB, sub.id);
    return json({ error: 'already ' + (now ? now.status : 'decided') }, 409);
  }
  await logAction(env.DB, session.name, 'submit-reject', sub.team_name, sub.quest_code, 0, 0, 0);
  await tellRejected(env, ctx, origin, sub, reason);
  return json({ ok: true, id: sub.id, reason: reason });
}

// A rejection is the one verdict worth a buzz: the team can act on it
// while they're still near the quest. Acceptances stay quiet — they're
// on the tab already. Then the post in the team's channel.
async function tellRejected(env: Env, ctx: Ctx, origin: string, sub: PendingSub, reason: string): Promise<void> {
  await sendTeamPush(env, sub.team_id, {
    title: 'Submission rejected',
    body: sub.quest_code + (reason ? ' — ' + reason : ''),
    url: '/submit/',
    tag: 'sub-' + sub.id,
    renotify: true
  }, { urgency: 'normal', topic: 's' + sub.id });
  var told = tellTeam(env, origin, sub, { verdict: 'rejected', quest: sub.quest_code, codes: [sub.quest_code], reason: reason });
  if (ctx && ctx.waitUntil) ctx.waitUntil(told); else await told;
}

// ---------- changing a decision ----------
// An accepted submission can be changed (what it credited), rejected
// after all, or sent back to pending; a rejected one can be sent back
// to pending. Whatever an accepted one gave comes off, or moves, in the
// same batch as the change. The batch's first statement takes the row
// only from the status and credit it was read with, and stamps
// claimed_at as Accept does, so a second press or two reviewers at once
// move the score once and the other is a 409.
// A decided submission as Undo, Change and Delete read it.
type DecidedSub = Pick<SubmissionRow, 'id' | 'quest_code' | 'status' | 'team_id' | 'added_by' | 'credit'> & { team_name: string };
var NO_CREDIT = 'This was accepted before the dashboard kept what it gave. Change its points on Scores instead.';
var BY_ORGANISER = 'An organiser recorded this. Take it back on the Points tab instead.';
var MOVED_ON = 'This submission has changed since it was loaded. Refresh and try again.';
var CODES_MOVED = 'This quest’s codes have changed since it was loaded. Refresh and try again.';
var DELETED_QUEST = 'Its quest was deleted, so it cannot be credited. Reject or delete it instead.';

// The submission, in one of the states `from` allows, with what it gave
// when accepted, after the checks all three share: the database has the
// credit column, and the account scores its quest and every code it
// credited. {sub, credit, scope} or {res}.
async function decidedSubmission(env: Env, session: ConsoleSession, id: unknown, from: string[]): Promise<{ res: Response } | { sub: DecidedSub; credit: Credit | null; scope: string[] | null }> {
  var db = env.DB;
  if (!(await ledgerReady(db))) return { res: behind() };
  var sub = await db.prepare(
    'SELECT s.id, s.quest_code, s.status, s.team_id, s.added_by, s.credit, t.name AS team_name FROM submissions s ' +
    'JOIN teams t ON t.id = s.team_id WHERE s.id = ?1'
  ).bind(Number(id) || 0).first<DecidedSub>();
  if (!sub) return { res: json({ error: 'no such submission' }, 404) };
  if (from.indexOf(sub.status) === -1) return { res: json({ error: 'That submission is ' + sub.status + '.' }, 409) };
  var credit = sub.status === 'accepted' ? readCredit(sub.credit) : null;
  if (sub.status === 'accepted' && !credit) return { res: json({ error: NO_CREDIT }, 409) };
  var scope = await scopeCodes(db, session);
  if (!inScope(scope, sub.quest_code) || (credit && !credit.codes.every(function (c) { return inScope(scope, c); }))) {
    return { res: outOfScope() };
  }
  return { sub: sub, credit: credit, scope: scope };
}

// The first statement of each batch below: the change, made only while
// the row has the status and credit it was read with, and `also` when
// given. ?1 is the id, ?2 the stamp, ?3 the status and ?4 the credit;
// `set` and `also` may use ?5 on.
function claimDecided(db: D1Database, set: string, binds: unknown[], also?: string): D1PreparedStatement {
  var stmt = db.prepare(
    'UPDATE submissions SET ' + set + ", claimed_by = '', claimed_at = ?2 WHERE id = ?1 AND status = ?3 AND credit IS ?4" +
    (also ? ' AND ' + also : '')
  );
  return stmt.bind.apply(stmt, binds);
}

function unclaim(db: D1Database, id: number, mark: string): D1PreparedStatement {
  return db.prepare("UPDATE submissions SET claimed_at = '' WHERE id = ?1 AND claimed_at = ?2").bind(id, mark);
}

// Changing what an accepted submission credited — its codes, amount and
// part marks, by the same rules as Accept. The team's points move by the
// difference. An organiser's entry is changed the same way.
async function reviseSubmission(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, origin: string): Promise<Response> {
  var db = env.DB;
  var got = await decidedSubmission(env, session, body.id, ['accepted']);
  if ('res' in got) return got.res;
  var sub = got.sub;
  // accepted, so it has one
  var was = got.credit as Credit;
  var scope = got.scope;
  // an adjustment's credit sets what it is worth, which a change by
  // Accept's rules would drop
  if (was.points) return json({ error: 'An adjustment cannot be changed. Take it back and adjust again.' }, 409);
  if (sub.quest_code === DELETED_CODE) return json({ error: DELETED_QUEST }, 409);
  var quest = await questByCode(db, sub.quest_code);
  if (!quest) return json({ error: 'Quest ' + sub.quest_code + ' is no longer on the tab. Change its points on Scores instead.' }, 409);
  var read = await readCreditFrom(db, quest, body);
  if ('error' in read) return json({ error: read.error }, 400);
  var now = read.credit;
  var codes = now.codes;
  if (!codes.every(function (c) { return inScope(scope, c); })) return outOfScope();
  var worth = creditWorth(read.parts, now);
  var before = await worthOf(db, was);
  var answer = { ok: true, id: sub.id, team: sub.team_name, quest: codes.join(' + '), codes: codes, amount: now.amount,
    gained: worth.given, full: worth.full, was: before.given };
  var numberOf = function (credit: Credit, c: string) { return credit.numbers && credit.numbers[c] != null ? Number(credit.numbers[c]) : null; };
  var same = was.codes.length === codes.length && codes.every(function (c) {
    return was.codes.indexOf(c) !== -1 && amountFor(was, c) === amountFor(now, c) && numberOf(was, c) === numberOf(now, c);
  });
  if (same) return json(Object.assign(answer, { unchanged: true, total: await teamTotal(db, sub.team_id) }));

  var oldTotal = await teamTotal(db, sub.team_id);
  var mark = 'revising:' + randomKey(9);
  // the new codes have to be there for their lines to land
  var done = await db.batch([claimDecided(db, 'credit = ?5', [sub.id, mark, 'accepted', sub.credit, creditJson(now)], codesThere('?5'))]
    .concat(relineSubmission(db, sub, now, mark, session.name, 'Changed'), [unclaim(db, sub.id, mark)]));
  if (!done[0].meta || !done[0].meta.changes) return json({ error: MOVED_ON }, 409);
  var total = await teamTotal(db, sub.team_id);
  await logAction(db, session.name, 'submit-revise', sub.team_name, was.codes.join(' + ') + ' → ' + codes.join(' + '),
    total - oldTotal, oldTotal, total);
  var told = tellTeam(env, origin, sub, { verdict: 'revised', quest: quest.code, credit: now, total: total });
  if (ctx && ctx.waitUntil) ctx.waitUntil(told); else await told;
  return json(Object.assign(answer, { total: total }));
}

// Sending a decided submission back to pending, to be accepted or
// rejected again the usual way; an accepted one's points come off. The
// team is not told: the decision that follows is.
async function reopenSubmission(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var db = env.DB;
  var got = await decidedSubmission(env, session, body.id, ['accepted', 'rejected']);
  if ('res' in got) return got.res;
  var credit = got.credit;
  var sub = got.sub;
  if (sub.added_by) return json({ error: BY_ORGANISER }, 409);
  var oldTotal = await teamTotal(db, sub.team_id);
  var mark = 'reopening:' + randomKey(9);
  var why = cleanText(body.reason, 200);
  var done = await db.batch([claimDecided(db,
    "status = 'pending', reviewed_by = NULL, reviewed_at = NULL, reason = NULL, credit = NULL",
    [sub.id, mark, sub.status, sub.credit])]
    .concat(credit ? relineSubmission(db, sub, null, mark, session.name, 'Sent back to the queue' + (why ? ': ' + why : '')) : [], [unclaim(db, sub.id, mark)]));
  if (!done[0].meta || !done[0].meta.changes) return json({ error: MOVED_ON }, 409);
  var total = await teamTotal(db, sub.team_id);
  await logAction(db, session.name, 'submit-reopen', sub.team_name, credit ? credit.codes.join(' + ') : sub.quest_code,
    total - oldTotal, oldTotal, total);
  return json({ ok: true, id: sub.id, team: sub.team_name, was: sub.status, total: total });
}

// Deleting takes a submission away, from any state, usually because the
// team asked: its files go, and whatever an accepted one gave comes off
// the tab in the same batch, under the same stamp as Undo. The row stays,
// marked deleted with the reviewer's note, so the team's own list says
// what happened.
async function deleteSubmission(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, origin: string): Promise<Response> {
  var db = env.DB;
  var sub = await pendingSubmission(db, body.id);
  if (!sub) return json({ error: 'no such submission' }, 404);
  if (sub.status === 'deleted') return json({ error: 'already deleted' }, 409);
  var scope = await scopeCodes(db, session);
  if (!inScope(scope, sub.quest_code)) return outOfScope();
  var credit: Credit | null = null;
  var stored: string | null = null;
  if (sub.status === 'accepted') {
    if (!(await ledgerReady(db))) return behind();
    // the row read above
    stored = (await db.prepare('SELECT credit FROM submissions WHERE id = ?1').bind(sub.id).first<Pick<SubmissionRow, 'credit'>>() as Pick<SubmissionRow, 'credit'>).credit;
    credit = readCredit(stored);
    if (!credit) return json({ error: NO_CREDIT }, 409);
    if (!credit.codes.every(function (c) { return inScope(scope, c); })) return outOfScope();
  }
  var oldTotal = credit ? await teamTotal(db, sub.team_id) : 0;
  var note = cleanText(body.note, 200);
  var files = (await db.prepare(
    'SELECT id, r2_key, upload_id, status FROM submission_files WHERE submission_id = ?1'
  ).bind(sub.id).all<Pick<SubmissionFileRow, 'id' | 'r2_key' | 'upload_id' | 'status'>>()).results;
  var copies = files.length ? (await db.prepare(
    'SELECT key FROM submission_renditions WHERE file_key IN (SELECT value FROM json_each(?1))'
  ).bind(JSON.stringify(files.map(function (f) { return f.r2_key; }))).all<{ key: string }>()).results : [];
  // the rows go only if this request is the one that marked it deleted
  var mine = "EXISTS (SELECT 1 FROM submissions WHERE id = ?1 AND status = 'deleted' AND reviewed_by = ?2 AND claimed_at = ?3)";
  var mark = 'deleting:' + randomKey(9);
  // an accepted one is taken only from the credit it was read with, and
  // what that credit gave comes off under this request's stamp
  var claim = credit
    ? db.prepare(
      "UPDATE submissions SET status = 'deleted', reviewed_by = ?2, reviewed_at = datetime('now'), reason = ?3, " +
      "claimed_by = '', claimed_at = ?4, gallery = 0, credit = NULL WHERE id = ?1 AND status = ?5 AND credit IS ?6"
    ).bind(sub.id, session.name, note || null, mark, sub.status, stored)
    : db.prepare(
      "UPDATE submissions SET status = 'deleted', reviewed_by = ?2, reviewed_at = datetime('now'), reason = ?3, " +
      "claimed_by = '', claimed_at = ?4, gallery = 0 WHERE id = ?1 AND status = ?5"
    ).bind(sub.id, session.name, note || null, mark, sub.status);
  var done = await db.batch([claim].concat(credit ? relineSubmission(db, sub, null, mark, session.name, 'Deleted' + (note ? ': ' + note : '')) : [], [
    db.prepare('DELETE FROM submission_upload_parts WHERE file_id IN (SELECT id FROM submission_files WHERE submission_id = ?1) AND ' + mine)
      .bind(sub.id, session.name, mark),
    db.prepare('DELETE FROM submission_renditions WHERE file_key IN (SELECT r2_key FROM submission_files WHERE submission_id = ?1) AND ' + mine)
      .bind(sub.id, session.name, mark),
    db.prepare('DELETE FROM submission_files WHERE submission_id = ?1 AND ' + mine).bind(sub.id, session.name, mark),
    db.prepare("UPDATE submissions SET claimed_at = '' WHERE id = ?1 AND claimed_at = ?2").bind(sub.id, mark)
  ]));
  if (!done[0].meta || !done[0].meta.changes) {
    var now = await pendingSubmission(db, sub.id);
    return json({ error: now && now.status !== sub.status ? 'already ' + now.status : MOVED_ON }, 409);
  }
  var total = credit ? await teamTotal(db, sub.team_id) : 0;
  if (credit) {
    var told = tellTeam(env, origin, { id: null, team_id: sub.team_id, team_name: sub.team_name },
      { verdict: 'adjusted', quest: sub.quest_code, credit: negated(credit), total: total });
    if (ctx && ctx.waitUntil) ctx.waitUntil(told); else await told;
  }
  // then the bucket: the original, its small copies and the encoder's
  if (env.SUBMIT && (files.length || copies.length)) {
    var bucket = cleanupBucketFiles(env, files, copies);
    if (ctx && ctx.waitUntil) ctx.waitUntil(bucket); else await bucket;
  }
  await logAction(db, session.name, 'submit-delete', sub.team_name, sub.quest_code + (note ? ': ' + note : ''),
    total - oldTotal, oldTotal, total);
  var answer: { ok: boolean; id: number; was: string; files: number; note: string; total?: number; off?: number } =
    { ok: true, id: sub.id, was: sub.status, files: files.length, note: note };
  if (credit) { answer.total = total; answer.off = Math.round((oldTotal - total) * 100) / 100; }
  return json(answer);
}

// Files added to a submission already sent, at any status but deleted:
// proof the team sent some other way, or a file that did not arrive. The
// quest's kinds apply and its most does not, since the organiser is
// adding what the team could not, but a submission holds no more than
// MAX_FILES_LIMIT, counting every row it has. Multipart, the files sent
// the way points/add takes them. An accepted one in the gallery is on the
// gallery albums at once, so their number moves.
async function addSubmissionFiles(env: Env, session: ConsoleSession, request: Request): Promise<Response> {
  var db = env.DB;
  var form: FormData;
  try { form = await request.formData(); } catch (err) { return json({ error: 'expected a multipart form' }, 400); }
  var sub = await db.prepare(
    'SELECT s.id, s.quest_code, s.status, s.gallery, t.name AS team_name, q.group_id, ' +
    '(SELECT COUNT(*) FROM submission_files f WHERE f.submission_id = s.id) AS held ' +
    'FROM submissions s JOIN teams t ON t.id = s.team_id LEFT JOIN quests q ON q.code = s.quest_code WHERE s.id = ?1'
  ).bind(Number(form.get('id')) || 0).first<Pick<SubmissionRow, 'id' | 'quest_code' | 'status' | 'gallery'> &
    { team_name: string; group_id: number | null; held: number }>();
  if (!sub) return json({ error: 'no such submission' }, 404);
  var held = sub.held;
  if (!inScope(await scopeCodes(db, session), sub.quest_code)) return outOfScope();
  if (sub.status === 'deleted') return json({ error: 'That submission is deleted.' }, 409);
  var kinds = (await rulesForGroup(db, sub.group_id)).files.kinds;
  var got = await dashProofFiles(env, session, form, kinds, function (n) {
    if (!kinds.length) return 'This quest takes no files.';
    if (!n) return 'Add at least one file.';
    if (held + n > MAX_FILES_LIMIT) {
      return 'A submission holds at most ' + MAX_FILES_LIMIT + ' files, and this one has ' + held + '.';
    }
    return null;
  });
  if ('res' in got) return got.res;
  // the file rows find the submission only while it is not deleted
  // (submit.ts), so a Delete in between fails the batch and takes back
  // what was stored
  var stored = await writeDashProof(env, form, got, { submission: sub.id }, function (rows) {
    return db.batch(rows);
  }, 'The files could not be stored, so nothing was added. Try again.');
  if ('res' in stored) {
    var now = await db.prepare('SELECT status FROM submissions WHERE id = ?1').bind(sub.id).first<Pick<SubmissionRow, 'status'>>();
    if (!now || now.status === 'deleted') return json({ error: 'That submission is deleted.' }, 409);
    return stored.res;
  }
  var names = got.files.map(function (f) { return f.name; }).concat(got.staged.map(function (s) { return s.name; }));
  if (sub.status === 'accepted' && sub.gallery) await bumpCounter(db, 'albums');
  await logAction(db, session.name, 'submit-files-add', sub.team_name,
    (sub.quest_code + ', ' + names.length + (names.length === 1 ? ' file: ' : ' files: ') + names.join(', ')).slice(0, 300), 0, 0, 0);
  return json({ ok: true, id: sub.id, team: sub.team_name, quest: sub.quest_code, added: names.length, files: sub.held + names.length });
}

// Two people reviewing at once should not both open the same
// submission. Opening one claims it in their name; anyone else's
// dashboard then says who has it. The claim is advice, not a lock —
// their Accept and Reject stay live — and it goes stale after ten
// minutes, so a reviewer who closed the tab holds nothing.
//
// Nothing is logged: this fires as a reviewer reads, and the log is
// for what they decided.
async function claimSubmission(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var sub = await env.DB.prepare(
    'SELECT s.id, s.quest_code, s.claimed_by, ' + CLAIM_FRESH + ' AS held FROM submissions s WHERE s.id = ?1'
  ).bind(Number(body.id) || 0).first<Pick<SubmissionRow, 'id' | 'quest_code' | 'claimed_by'> & { held: number }>();
  if (!sub) return json({ error: 'no such submission' }, 404);
  if (!inScope(await scopeCodes(env.DB, session), sub.quest_code)) return outOfScope();
  if (sub.held && sub.claimed_by && sub.claimed_by !== session.name) {
    return json({ error: sub.claimed_by + ' is reviewing this one.', claimed_by: sub.claimed_by }, 409);
  }
  var at = utcStamp();
  await env.DB.prepare('UPDATE submissions SET claimed_by = ?2, claimed_at = ?3 WHERE id = ?1')
    .bind(sub.id, session.name, at).run();
  return json({ ok: true, id: sub.id, claimed_by: session.name, claimed_at: at });
}

// ---------- push notifications ----------
// Sending is double-locked: the caller already holds a console
// session, and every send must carry the separate push password.
// A send to everyone goes the way a message's push does (sendAllPush):
// the first batch here, the rest left in the outbox for the scheduled
// run, so closing the tab part way cannot drop anybody.

async function pushStats(env: Env): Promise<Response> {
  var row = await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs').first<{ n: number }>() as { n: number };
  return json({ ok: true, subscribers: row.n, devices: await pushDevices(env.DB) });
}

async function pushName(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var id = await nameDevice(env.DB, body.id, body.label);
  if (!id) return json({ error: 'no such device' }, 404);
  await logAction(env.DB, session.name, 'push-device-name', cleanText(body.label, 40) || '(no name)', '-', 0, 0, 0);
  return pushStats(env);
}

// The second password, when sending a push asks for it, is checked by
// the router before this is reached.
async function pushSend(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  if (!pushConfigured(env)) {
    return json({ error: 'Push is not configured: generate VAPID keys first.' }, 403);
  }
  var title = cleanText(body.title, 80);
  var text = cleanText(body.body, 300);
  if (!title || !text) return json({ error: 'A title and a message are both needed.' }, 400);
  var link = cleanText(body.url, 200);

  // two tiers: an announcement buzzes and rides out at high urgency; a
  // quiet update goes out low-urgency and replaces the previous one on
  // screen instead of stacking. Same-topic messages a phone missed
  // while offline collapse to the latest.
  var quiet = body.kind === 'update';
  var opts: PushOpts = quiet ? { urgency: 'low', topic: 'update' } : { urgency: 'high', topic: 'announce' };

  var payload: PushPayload = { title: title, body: text, tag: quiet ? 'scs2-update' : 'scs2-announce', renotify: !quiet };
  if (link) payload.url = link;

  // Who it goes to. Everyone is a first batch here and the rest from the
  // outbox; a team or a single device is a handful of phones and
  // finishes here, which is what makes a test send to your own phone
  // possible at all — before this the only way to see what an
  // announcement looks like was to send it to everybody.
  if (await pushesOff(env.DB)) {
    return json({ error: 'Push notifications are turned off in Settings, After the event.', push_off: true }, 409);
  }
  var target = fields(body.target);
  var aim = target.kind === 'team' || target.kind === 'device' ? target.kind : 'all';
  var out: { sent: number; failed: number; dead: number; remaining: number; queued: boolean };
  var who = 'everyone';

  if (aim === 'team') {
    var team = await env.DB.prepare('SELECT id, name FROM teams WHERE id = ?1')
      .bind(Math.round(Number(target.team_id) || 0)).first<Pick<TeamRow, 'id' | 'name'>>();
    if (!team) return json({ error: 'Pick a team to send to.' }, 400);
    var toTeam = await pushToTeam(env, team.id, payload, opts);
    out = { sent: toTeam.sent, failed: toTeam.failed, dead: toTeam.dead.length, remaining: 0, queued: false };
    who = team.name;
    if (!out.sent && !out.failed) return json({ error: team.name + ' has no device signed up for notifications.' }, 404);
  } else if (aim === 'device') {
    var toDevice = await pushToDevice(env, target.sub_id, payload, opts);
    if (!toDevice.sent && !toDevice.failed && !toDevice.dead.length) {
      return json({ error: 'That device is not subscribed any more.' }, 404);
    }
    out = { sent: toDevice.sent, failed: toDevice.failed, dead: toDevice.dead.length, remaining: 0, queued: false };
    who = 'one device';
  } else {
    out = await sendAllPush(env, payload, opts);
  }

  await logAction(env.DB, session.name, 'push-send',
    title.slice(0, 60) + ' (' + out.sent + ' sent' + (out.dead ? ', ' + out.dead + ' gone' : '') + ')',
    who.slice(0, 40), 0, 0, 0);
  return json({ ok: true, target: aim, who: who, sent: out.sent, failed: out.failed,
    dead: out.dead, remaining: out.remaining, queued: out.queued });
}

// ---------- team submit codes ----------
// Readable eight-character codes (no 0/O or 1/I), minted for every
// team that lacks one, listed for handing out.

async function generateCodes(env: Env, session: ConsoleSession): Promise<Response> {
  var missing = await env.DB.prepare(
    'SELECT t.id FROM teams t LEFT JOIN team_codes c ON c.team_id = t.id WHERE c.team_id IS NULL'
  ).all<Pick<TeamRow, 'id'>>();
  if (missing.results.length) {
    await env.DB.batch(missing.results.map(function (t) {
      return env.DB.prepare('INSERT INTO team_codes (team_id, code) VALUES (?1, ?2)').bind(t.id, mintCode());
    }));
    await logAction(env.DB, session.name, 'codes-generate', missing.results.length + ' teams', '-', 0, 0, 0);
  }
  return json({ ok: true, minted: missing.results.length });
}

async function listCodes(env: Env): Promise<Response> {
  var rows = await env.DB.prepare(
    'SELECT t.name, c.code FROM teams t LEFT JOIN team_codes c ON c.team_id = t.id ORDER BY t.name COLLATE NOCASE'
  ).all();
  return json({ ok: true, codes: rows.results });
}

// One message to one organiser, and the whole story of how it went
// out. The confirmation emails take the same path, so this is what
// answers "why does the inbox show the address with no name": a send
// that fell through to the string shape says so here, along with what
// the shapes before it refused.
//
// Three kinds:
//
//   plain    the message above and nothing else — the sender test
//   ticket   the confirmation exactly as a team gets it, with a name, a
//            team and a code in it, so the layout can be read in a real
//            inbox rather than guessed at
//   banner   the same with a picture across the top
//
// The ticket send builds the real email through regoEmail, so what
// lands is what a team would get and not a copy of it that can drift.
// Its code is the demo one: drawn by the check-in worker on the spot
// from a fixed string, nothing stored, nobody added to the board.
export function testBanner(url: unknown): string {
  var u = String(url || '').trim();
  // an http:// picture in an https:// message is blocked by most
  // clients and shows as a broken box, which reads as our fault
  if (!/^https:\/\/[^\s"'<>]+$/.test(u) || u.length > 400) return '';
  return u;
}

async function emailTest(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  if (await emailsHeld(env.DB)) return emailOffRefusal();
  var to = cleanText(body.to, 120).toLowerCase();
  var kind = ['plain', 'ticket', 'banner'].indexOf(String(body.kind || 'plain')) === -1
    ? 'plain' : String(body.kind || 'plain');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return json({ error: 'That email address does not look right.' }, 400);
  }
  if (!emailConfigured(env)) {
    return json({ error: 'Nothing to send with: neither the Email Service binding nor an EMAIL_API_KEY is set.' }, 400);
  }

  var stamp = utcStamp();
  var message: EmailMessageIn;
  var note = '';
  if (kind === 'plain') {
    message = {
      to: to,
      subject: 'SCS.2 test message',
      text: 'A test from the dashboard, ' + stamp + ' UTC.\n\n' +
        'Look at who this is from. An address on its own, with no name beside it, is the fault being chased.',
      html: '<p>A test from the dashboard, ' + stamp + ' UTC.</p>' +
        '<p>Look at who this is from. An address on its own, with no name beside it, is the fault being chased.</p>'
    };
  } else {
    var banner = kind === 'banner' ? testBanner(body.banner) : '';
    if (kind === 'banner' && !banner) {
      return json({ error: 'That banner address does not look right. It has to be an https:// link to a picture.' }, 400);
    }
    var name = cleanText(body.name, 80) || 'Alex Nguyen';
    var team = cleanText(body.team, 80) || 'Test Team';
    var qr = demoQrUrl(env);
    if (!qr) note = 'The check-in worker is not connected (CHECKIN_API), so this one has no code in it.';
    message = regoEmail(
      { name: name, email: to, position: 1, qr_url: qr },
      { name: name }, team, { banner: banner, demo: true });
  }

  var sent = await trySendEmail(env, message);
  await logAction(env.DB, session.name, 'email-test', to,
    kind + ' ' + sent.status + (sent.shape ? ': ' + sent.shape : ''), 0, 0, 0);
  var out: EmailOutcome & { ok: boolean; kind: string; note: string; error?: string } =
    Object.assign({ ok: sent.status === 'sent', kind: kind, note: note }, sent);
  if (!out.ok) {
    out.error = sent.status === 'skipped'
      ? 'Nothing is configured to send email.'
      : 'Every shape was refused. ' + sent.refused.map(function (r) { return r.shape + ': ' + r.error; }).join(' | ');
  }
  return json(out);
}

async function logView(env: Env, url: URL): Promise<Response> {
  var limit = Math.min(200, Math.max(1, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  var before = parseInt(url.searchParams.get('before') || '', 10) || 0;
  // before = 0 means "from the top"; every real id is above it
  var rows = await env.DB.prepare(
    'SELECT id, at, action, team_name, quest_code, points_delta, old_total, new_total, actor ' +
    'FROM submission_log WHERE (?1 = 0 OR id < ?1) ORDER BY id DESC LIMIT ?2'
  ).bind(before, limit).all();
  return json({ ok: true, entries: rows.results });
}

// ---------- the day board ----------
// One read behind the row of numbers at the top of the Scores tab: how
// much review is waiting and how long the oldest has waited, how busy
// the last twelve hours have been, who is in the room, and whether the
// pieces that run on other machines are answering.

var BOARD_HOURS = 12;

async function dayBoard(env: Env, ctx: Ctx): Promise<Response> {
  var got = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n, MIN(submitted_at) AS oldest FROM submissions WHERE status = 'pending'")
      .first<{ n: number; oldest: string | null }>(),
    env.DB.prepare(
      "SELECT strftime('%Y-%m-%d %H:00', submitted_at) AS hour, COUNT(*) AS submissions " +
      "FROM submissions WHERE submitted_at >= datetime('now', '-" + BOARD_HOURS + " hours') " +
      'GROUP BY hour ORDER BY hour'
    ).all<{ hour: string; submissions: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS total, COALESCE(SUM(hidden), 0) AS hidden FROM teams')
      .first<{ total: number; hidden: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs').first<{ n: number }>(),
    checkinStatus(env),
    encoderSummary(env),
    tabState(env.DB)
  ]);
  var waiting = got[0] as { n: number; oldest: string | null };
  var perHour = got[1].results;
  // every hour is in the list whether or not anything came in, oldest
  // first, so the last entry is always the hour we are in
  var counts: Record<string, number> = {};
  perHour.forEach(function (r) { counts[r.hour] = r.submissions; });
  var hours = [];
  for (var i = BOARD_HOURS - 1; i >= 0; i--) {
    var hour = utcStamp(new Date(Date.now() - i * 3600000)).slice(0, 13) + ':00';
    hours.push({ hour: hour, submissions: counts[hour] || 0 });
  }

  var teams = got[2] as { total: number; hidden: number };
  var subs = got[3] as { n: number };
  var roster = got[4];
  if (roster) { syncCheckinHiddenLater(env, ctx, roster); reconcileCheckinsLater(env, ctx, roster); }
  var encoders = got[5];
  var online = 0;
  encoders.encoders.forEach(function (e) { if (e.online) online++; });
  var state = got[6];

  return json({
    ok: true,
    pending: waiting.n,
    oldest_pending_at: waiting.oldest || '',
    per_hour: hours,
    teams: { total: teams.total, hidden: teams.hidden },
    checkin: {
      registered: roster ? roster.people : 0,
      checked_in: roster ? roster.people_checked_in : 0,
      live: !!roster
    },
    push_subs: subs.n,
    encoder: { waiting: encoders.waiting, encoding: encoders.encoding, done: encoders.done, online: online },
    frozen: !!state.frozen,
    closed: !!state.closed
  });
}

// ---------- the whole database, as JSON ----------
// One file an organiser can keep after the day: every row of every
// table that holds what happened. Push subscriptions are left out —
// an endpoint and its keys are enough to send notifications to that
// device, and a copy of them on a laptop is a copy of that power —
// and so are the session tables, which are live credentials.

var EXPORT_TABLES = [
  'teams', 'quests', 'quest_groups', 'quest_regions', 'completions', 'entries', 'awards',
  'submissions', 'submission_files', 'submission_renditions',
  'quest_files', 'quest_responses', 'messages', 'message_files', 'message_audiences',
  'counters', 'registrations', 'participants',
  'discord_guilds', 'discord_teams', 'discord_members',
  'submission_log', 'encoders', 'eoi_people',
  'drop_files', 'short_links', 'link_page_items', 'link_page_days', 'home_slides',
  'quest_tags', 'quest_group_tags', 'audiences', 'audience_teams', 'quest_audiences',
  'email_sends', 'email_queue', 'tab_snapshots', 'albums', 'album_photos', 'album_skips', 'album_teams',
  'team_tracks', 'payphones', 'phone_captures', 'phone_calls', 'phone_messages'
];

// Tidy the photo files. Photos used to be served from a cleaned copy
// kept beside each one (`<key>.c`); they are cut as they are served now
// (photoserve.ts), so those copies are only taking up space, and this
// deletes them — a photo's only: a video's `.c` is the encoder's clean
// copy and is what plays. The same walk reads when each proof file and
// album upload was taken, for the ones from before that was written
// down (taken_at still null), and reads again each photo that gave no
// time (''), since a block from an earlier reading is read afresh
// (metaBlock) and a PNG or GIF that said nothing then may say when now.
// It goes in batches, each call answering how far it got so the page
// can call again, and doing it twice changes nothing.
var RECLEAN_BATCH = 12;
// One file as the walk reads it, its id moved into its source's run.
type RecleanRow = { id: number; key: string; type: string | null; taken: string | null };

// Every place a file can live, each given its own run of ids so one
// cursor walks them all the same way every time. Each is asked on its
// own and the answers put in order here: D1 refuses a SELECT joined from
// more than a few UNION terms, which is how this was first written and
// what made Tidy fail on the real database.
var RECLEAN_SOURCES = [
  { base: 0, sql: 'SELECT id, r2_key AS key, content_type AS type, taken_at AS taken FROM submission_files' },
  { base: 1000000, sql: "SELECT id, key, type, '' AS taken FROM message_files" },
  { base: 2000000, sql: "SELECT id, key, type, '' AS taken FROM quest_files" },
  { base: 3000000, sql: 'SELECT id, r2_key AS key, content_type AS type, taken_at AS taken FROM album_photos' },
  { base: 4000000, sql: "SELECT id, key, type, '' AS taken FROM drop_files" },
  { base: 5000000, sql: "SELECT id, key, type, '' AS taken FROM home_slides" }
];

async function recleanRows(db: D1Database, after: number, limit: number): Promise<RecleanRow[]> {
  var out: RecleanRow[] = [];
  for (var i = 0; i < RECLEAN_SOURCES.length && out.length < limit; i++) {
    var source = RECLEAN_SOURCES[i];
    var res = await db.prepare(source.sql + ' WHERE id > ?1 ORDER BY id LIMIT ?2')
      .bind(after - source.base, limit).all<RecleanRow>();
    res.results.forEach(function (r) {
      out.push({ id: r.id + source.base, key: r.key, type: r.type, taken: r.taken });
    });
  }
  return out.slice(0, limit);
}

async function recleanFiles(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  if (!env.SUBMIT) return json({ error: 'no SUBMIT bucket bound' }, 503);
  var after = Math.max(0, Math.round(Number(body && body.after) || 0));
  var rows = { results: await recleanRows(env.DB, after, RECLEAN_BATCH) };

  var removed = 0;
  var dated = 0;
  var found = [];
  var last = after;
  for (var i = 0; i < rows.results.length; i++) {
    var row = rows.results[i];
    last = row.id;
    var photo = String(row.type || '').indexOf('image/') === 0;
    if (photo && (await headStored(env.SUBMIT, row.key + '.c'))) {
      await env.SUBMIT.delete(row.key + '.c');
      removed++;
    }
    var media = /^(image|video)\//.test(String(row.type));
    if (media && (row.taken === null || (photo && row.taken === '' && /^(sub|alb)\//.test(row.key)))) {
      // a photo or a video, so it has a type
      var taken = await takenOf(env, row.key, row.type as string);
      found.push({ key: row.key, taken: taken });
      if (taken) dated++;
    }
  }
  await recordTaken(env, found);
  // a time read moves a photo in an album's Date taken order
  if (dated) await bumpCounter(env.DB, 'albums');
  var done = rows.results.length < RECLEAN_BATCH;
  if (done) {
    await logAction(env.DB, session.name, 'files-reclean', 'tidied', '-', 0, 0, 0);
  }
  return json({ ok: true, done: done, checked: rows.results.length, removed: removed, dated: dated, after: last });
}

// Put every unfinished video back on the pile: the ones a machine is
// still holding, and the ones a run gave up on. A failure recorded as
// 'skipped' is otherwise out of the queue for good and counted
// nowhere, which made a batch of videos look as though they had simply
// stopped existing.
async function encoderRelease(env: Env, session: ConsoleSession, logAction: LogAction): Promise<Response> {
  var out = await retryVideos(env);
  await logAction(env.DB, session.name, 'encoder-retry',
    out.held + ' held, ' + out.failed + ' failed', '-', 0, 0, 0);
  return json(Object.assign({ ok: true }, out));
}

async function exportAll(env: Env, session: ConsoleSession): Promise<Response> {
  var out: { ok: boolean; exported_at: string; push_subs_count: number; tables: Record<string, unknown[]> } =
    { ok: true, exported_at: utcStamp(), push_subs_count: 0, tables: {} };
  var all = await Promise.all(
    EXPORT_TABLES.map(function (table) { return env.DB.prepare('SELECT * FROM ' + table).all(); })
  );
  for (var i = 0; i < EXPORT_TABLES.length; i++) {
    out.tables[EXPORT_TABLES[i]] = all[i].results;
  }
  out.push_subs_count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM push_subs').first<{ n: number }>() as { n: number }).n;
  await logAction(env.DB, session.name, 'export-all',
    Object.keys(out.tables).length + ' tables', '-', 0, 0, 0);
  return json(out, 200, { 'cache-control': 'no-store' });
}

// ---------- router ----------
// Returns a Response for /api/console/* requests, null otherwise.
// `purge` is called after any accepted write so the public API and the
// live tab catch up immediately.

// ---------- freezing and closing the tab ----------
// Reading it is the state and the saved copies; the dashboard shows the
// live tab either way, since the console's own queries never go through
// the public payloads.
async function freezeStatus(env: Env): Promise<Response> {
  var state = await tabState(env.DB);
  var copies = await listCopies(env.DB);
  return json({
    ok: true,
    frozen: !!state.frozen, frozen_at: state.frozen ? state.frozen.frozen_at : null,
    closed: !!state.closed, closed_at: state.closed ? state.closed.closed_at : null,
    copies: copies
  });
}

// A fresh freeze takes the standings as they are; with `copy_id` a
// saved copy goes back up with the time it was taken, which also works
// while frozen, to change which copy the public sees.
async function freezeSet(env: Env, session: ConsoleSession, body: JsonBody, renderPayload: RenderPayload): Promise<Response> {
  if (typeof renderPayload !== 'function') return json({ error: 'freezing is not wired up' }, 500);
  var want = !!body.frozen;
  var copy: SavedCopy | null = null;
  if (want && body.copy_id) {
    copy = await readCopy(env.DB, body.copy_id);
    if (!copy) return json({ error: 'That copy is not there any more.' }, 404);
  } else if (want) {
    var was = await freezeState(env.DB);
    if (was) return json({ ok: true, frozen: true, frozen_at: was.frozen_at });
  }
  // a press that changed nothing (another freeze got there first, or the
  // tab was already live) is answered as it stands and not logged
  var res = await setFrozen(env.DB, want, renderPayload, { copy: copy, by: session.name });
  if (res.changed) await logAction(env.DB, session.name, want ? 'tab-freeze' : 'tab-unfreeze', copy ? 'copy of ' + copy.taken_at : '-', '-', 0, 0, 0);
  return json({ ok: true, frozen: res.frozen, frozen_at: res.frozen_at, copy_id: res.copy_id });
}

async function closeSet(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var res = await setClosed(env.DB, !!body.closed);
  if (res.changed) await logAction(env.DB, session.name, res.closed ? 'tab-close' : 'tab-open', '-', '-', 0, 0, 0);
  return json({ ok: true, closed: res.closed, closed_at: res.closed_at });
}

async function copySave(env: Env, session: ConsoleSession, renderPayload: RenderPayload): Promise<Response> {
  var id = await saveCopy(env.DB, 'hand', session.name, await renderSnapshot(renderPayload));
  await logAction(env.DB, session.name, 'tab-copy', '-', '-', 0, 0, 0);
  return json({ ok: true, id: id });
}

// One copy's board, and the board of the copy before it, so the page
// can say what moved in between.
async function copyView(env: Env, url: URL): Promise<Response> {
  var copy = await readCopy(env.DB, url.searchParams.get('id'));
  if (!copy) return json({ error: 'no such copy' }, 404);
  var before = await copyBefore(env.DB, copy);
  return json({
    ok: true,
    copy: { id: copy.id, taken_at: copy.taken_at, kind: copy.kind, taken_by: copy.taken_by, teams: copyBoard(copy) },
    before: before ? { id: before.id, taken_at: before.taken_at, kind: before.kind, teams: copyBoard(before) } : null
  });
}

async function copyDelete(env: Env, session: ConsoleSession, body: JsonBody): Promise<Response> {
  var row = await env.DB.prepare('SELECT id, taken_at FROM tab_snapshots WHERE id = ?1').bind(Number(body.id) || 0).first<{ id: number; taken_at: string }>();
  if (!row) return json({ error: 'no such copy' }, 404);
  await env.DB.prepare('DELETE FROM tab_snapshots WHERE id = ?1').bind(row.id).run();
  await logAction(env.DB, session.name, 'tab-copy-delete', row.taken_at, '-', 0, 0, 0);
  return json({ ok: true });
}

export async function handleConsoleApi(request: Request, env: Env, ctx: Ctx, url: URL, purge: Purge | null, renderPayload: RenderPayload): Promise<Response | null> {
  var path = url.pathname;
  if (path.indexOf('/api/console/') !== 0) return null;
  var action = path.slice('/api/console/'.length);

  if (request.method === 'POST' && action === 'login') return login(request, env);

  var session = await sessionByToken(env.DB, bearerToken(request));
  if (!session && request.method === 'GET' && action === 'file') {
    session = await sessionByToken(env.DB, cookieToken(request));
  }
  if (!session) return json({ error: 'not signed in' }, 401);

  // What this account may do, then whether this action asks for the
  // second password. Both before anything is read or written.
  var verb = request.method === 'GET' ? 'GET' : request.method;
  if (!allowed(session, verb, action)) {
    return json({ error: 'Your account does not have access to that.', no_access: true }, 403);
  }
  var guarded = await guardRefusal(env, guardFor(verb, action), secondPasswordGiven(request));
  if (guarded) return guarded;

  // files on their way straight to R2, for the saves below to adopt;
  // nothing public reads them until a save does, so no purge
  if (action.indexOf('upload/') === 0) {
    var sent: JsonBody = {};
    if (verb === 'POST') {
      try { sent = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
    }
    return (await stagedConsole(env, session, verb, action, sent, url)) || json({ error: 'not found' }, 404);
  }

  // personal data and the original videos, both off the database into
  // files an organiser keeps; nothing the site caches reads either
  if (action === 'privacy' || action.indexOf('privacy/') === 0) {
    return (await privacyConsole(env, session, request, action, logAction)) || json({ error: 'not found' }, 404);
  }
  if (action === 'originals' || action.indexOf('originals/') === 0) {
    return (await originalsConsole(env, session, request, action, url, logAction)) || json({ error: 'not found' }, 404);
  }

  // the routes teams recorded: a save comes as a form, and nothing the
  // site caches reads them, so no purge
  if (action === 'tracks' || action.indexOf('tracks/') === 0) {
    return (await tracksConsole(env, session, request, action, url, logAction)) || json({ error: 'not found' }, 404);
  }

  if (request.method === 'GET') {
    if (action === 'me') return meView(env, session);
    if (action === 'overview') return overview(env);
    if (action === 'team/receipt') return teamReceipt(env, url, session);
    if (action === 'desk') return questDesk(env, url, session);
    if (action === 'log') return logView(env, url);
    if (action === 'map') return teamMap(env);
    if (action === 'albums' || action === 'album' || action === 'album/pass' || action === 'album/zip') return albumsConsole(env, session, request, action, url, logAction);
    if (action === 'points/form') return pointsForm(env, session);
    if (action === 'submissions') return submissionList(env, url, session);
    if (action === 'tally') return tallyBoard(env, session, url);
    if (action === 'tally/team') return tallyTeam(env, session, url);
    if (action === 'file') return serveFile(env, request, url, session);
    if (action === 'file/meta') return fileMeta(env, url, session);
    if (action === 'file/track') return fileTrack(env, url, session);
    if (action === 'codes') return listCodes(env);
    if (action === 'quests') return json(Object.assign({ ok: true }, await allGroups(env.DB)));
    if (action === 'quests/visible') return visibleKeys(env, url);
    if (action === 'quests/asks') return groupAsks(env);
    if (action === 'quests/export') {
      var everyone = url.searchParams.get('only') === 'everyone';
      var file = await exportQuests(env.DB, url.searchParams.get('format') === 'json' ? 'json' : 'csv', everyone);
      return new Response(file.body, { headers: {
        'content-type': file.type + '; charset=utf-8',
        'content-disposition': 'attachment; filename="scs2-quests' + (everyone ? '-everyone' : '') + '.' + file.ext + '"',
        'cache-control': 'no-store'
      } });
    }
    if (action === 'freeze') return freezeStatus(env);
    if (action === 'freeze/copy') return copyView(env, url);
    // the standings as they are, frozen or not, for the leaderboard picture
    if (action === 'standings') return json({ ok: true, teams: (await renderPayload('/api/leaderboard')).teams });
    if (action === 'quests-done') return json({ ok: true, teams: await questsDone(env.DB) });
    if (action === 'ranks/times') return json({ ok: true, teams: await submitTimes(env.DB) });
    if (action === 'ranks/custom') {
      var ranked = await boardTeams(env.DB, cleanText(url.searchParams.get('quest'), 40), url.searchParams.get('measure'));
      if (!ranked) return json({ error: 'That quest is not a challenge, so it has no count of its own.' }, 400);
      return json({ ok: true, teams: ranked });
    }
    if (action === 'ranks/boards') return json({ ok: true, boards: await rankBoards(env.DB), builtin: await rankRecap(env.DB) });
    if (action === 'recap/sections') return recapSectionsRead(env);
    // the spinner page's whole read: the board's teams and their points
    // as the tab has them now, and nothing else
    if (action === 'spinner') return json({ ok: true, teams: (await standings(env.DB)).map(function (t) {
      return { id: t.id, name: t.name, points: t.pts };
    }) });
    if (action === 'tab/export') return new Response(await tabCsv(env.DB), { headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="scs2-tab.csv"',
      'cache-control': 'no-store'
    } });
    if (action === 'flags') return flagsRead(env);
    if (action === 'recap') return recapConsole(env);
    if (action === 'recap/hours') return afterSettings(env);
    if (action === 'limits') return limitsRead(env);
    if (action === 'storage') return storageScan(env, url);
    if (action === 'eoi') return eoiRead(env);
    if (action === 'phone') return phoneRead(env);
    if (action === 'phone/message') return phoneMessageAudio(request, env, url);
    if (action === 'ledger/check') return json({ ok: true, ready: await ledgerReady(env.DB), check: await lastLedgerCheck(env.DB) });
    if (action === 'drop') return dropList(env);
    if (action === 'linkpage') return linkPageRead(env);
    if (action === 'slides') return slidesList(env);
    if (action === 'schedule') return json({
      ok: true, push_waiting: await outboxWaiting(env.DB), tickets_waiting: await ticketsOutstanding(env.DB),
      emails_waiting: await emailsWaiting(env.DB), email_off: await emailsHeld(env.DB)
    });
    if (action === 'countdown') return countdownRead(env);
    if (action === 'board') return dayBoard(env, ctx);
    if (action === 'export/all') return exportAll(env, session);
    if (action === 'encoder/status') return encoderStatus(env);
    if (action === 'messages/list') return messagesList(env);
    if (action === 'counters') return countersRead(env);
    if (action === 'push/stats') return pushStats(env);
    if (action === 'announce') return announceList(env);
    if (action === 'email/hold') return emailHoldRead(env);
    if (action === 'accounts') return accountsView(env);
    if (action === 'rego') return regoOverview(env, ctx);
    if (action === 'rego/settings') return regoSettings(env);
    if (action === 'rego/csv') return regoCsv(env);
    if (action.indexOf('discord/') === 0) return (await handleDiscordConsole(request, env, session, action, null, url, logAction)) || json({ error: 'not found' }, 404);
    return json({ error: 'not found' }, 404);
  }

  if (request.method !== 'POST') return json({ error: 'not found' }, 404);

  // Sign-in housekeeping: neither reads or writes anything public, so
  // both answer before the JSON parse and the purge below.
  if (action === 'auth/reset') return authReset(request, env, session, await shortIpHash(request));
  if (action === 'auth/backup') return authBackup(env, session, await shortIpHash(request));

  // A message carries its attachments, so it arrives as multipart form
  // data rather than the JSON body every other action uses — it has to
  // be read before the parse below.
  if (action === 'messages/save') {
    var saved = await saveMessage(env, session, request, ctx, logAction);
    if (saved.status === 200 && purge) {
      if (ctx && ctx.waitUntil) ctx.waitUntil(purge());
      else await purge();
    }
    return saved;
  }

  // Points with their photos are multipart, like a team's submission,
  // and move the tab, so they purge.
  if (action === 'points/add') {
    var added = await pointsAdd(env, session, request, ctx, url.origin, logAction);
    if (added.status === 200 && purge) {
      if (ctx && ctx.waitUntil) ctx.waitUntil(purge());
      else await purge();
    }
    return added;
  }

  // Files added to a submission are multipart as well. No cached read
  // lists a submission's files, so there is nothing to purge; the gallery
  // albums move on their own number.
  if (action === 'submissions/files') return addSubmissionFiles(env, session, request);

  // A dropped file is multipart too, and nothing public reads it, so
  // it answers here rather than going through the purge below.
  if (action === 'drop/upload') return dropUpload(env, session, request, logAction);
  if (action === 'drop/edit') return dropEdit(env, session, request, logAction);
  // the albums read their own bodies, one of them multipart
  if (action.indexOf('albums/') === 0 || action.indexOf('album/') === 0) {
    var albumResp = await albumsConsole(env, session, request, action, url, logAction);
    if (albumResp) return albumResp;
  }

  // A home page picture is multipart for the same reason a message is,
  // and /api/slides is a cached read, so this one purges.
  if (action === 'slides/save') {
    var slide = await slideSave(env, session, request, logAction);
    if (slide.status === 200 && purge) {
      if (ctx && ctx.waitUntil) ctx.waitUntil(purge());
      else await purge();
    }
    return slide;
  }

  // A quest's files arrive as multipart form data for the same reason
  // a message's do, and like the rest of quests/* they move the quest
  // counter and purge the public reads — so they go through `out`
  // below rather than answering here.
  var body: JsonBody = {};
  if (action !== 'quests/group/files') {
    try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  }

  // accounts and the second password: nothing public reads either
  if (action === 'accounts/save') return accountSave(env, session, body);
  if (action === 'accounts/delete') return accountDelete(env, session, body);
  if (action === 'guards/set') return guardSet(env, session, request, body);

  var out: Response;
  if (action === 'quests/group/files') out = await saveGroupFiles(env, session, request, logAction);
  else if (action === 'teams/add') out = await addTeam(env, session, body);
  else if (action === 'teams/rename') out = await renameTeam(env, session, body, ctx);
  else if (action === 'teams/delete') out = await deleteTeam(env, session, body, ctx);
  else if (action === 'teams/hide') out = await hideTeam(env, session, body);
  else if (action === 'teams/dnf') out = await setTeamDnf(env, session, body); // moves the places: purge
  else if (action === 'quests/add') out = await addQuest(env, session, body);
  else if (action === 'quests/edit') out = await editQuest(env, session, body);
  else if (action === 'quests/delete') out = await deleteQuest(env, session, body);
  else if (action === 'quests/group/save') out = await saveGroup(env, session, body, logAction);
  // who can see a quest: one quest, a tag's quests, everything, and the
  // team groups — all quests/*, so each moves the counter and purges
  else if (action === 'quests/group/access') out = await setGroupAccess(env, session, body, logAction);
  else if (action === 'quests/tags/save') out = await saveTag(env, session, body, logAction);
  else if (action === 'quests/tags/delete') out = await deleteTag(env, session, body, logAction);
  else if (action === 'quests/tags/apply') out = await applyTag(env, session, body, logAction);
  else if (action === 'quests/open-all') out = await openEverything(env, session, body, logAction);
  else if (action === 'quests/team-groups/save') out = await saveAudience(env, session, body, logAction);
  else if (action === 'quests/team-groups/delete') out = await deleteAudience(env, session, body, logAction);
  else if (action === 'quests/group/delete') out = await deleteGroup(env, session, body, logAction);
  else if (action === 'quests/retire') out = await retireAll(env, session, body, logAction);
  else if (action === 'quests/import-scs2') out = await importScs2(env, session, logAction);
  else if (action === 'quests/regions/save') out = await saveRegion(env, session, body, logAction);
  else if (action === 'quests/regions/delete') out = await deleteRegion(env, session, body, logAction);
  else if (action === 'quests/regions/order') out = await orderRegions(env, session, body, logAction);
  else if (action === 'quests/order') out = await orderRegionQuests(env, session, body, logAction);
  else if (action === 'quests/regions/colour') out = await setRegionColour(env, session, body, logAction);
  else if (action === 'quests/file/preview') return importQuestsPreview(env, body); // read-only: no purge
  else if (action === 'quests/file/commit') out = await importQuestsCommit(env, session, body, logAction);
  else if (action === 'quests/group/file/delete') out = await deleteGroupFile(env, session, body, logAction);
  else if (action === 'quests/group/ask/save') out = await saveGroupAsk(env, session, body, logAction);
  // a quest's question as the day runs it, from its desk: an account
  // limited to other quests can do none of it to this one
  else if (['quests/group/ask/responses', 'quests/group/ask/open', 'quests/group/ask/settle', 'quests/group/ask/unsettle'].indexOf(action) !== -1) {
    var askScope = await scopeCodes(env.DB, session);
    var scored = function (code: string) { return inScope(askScope, code); };
    if (action === 'quests/group/ask/responses') return groupAskResponses(env, body, scored); // read-only: no purge, no counter
    if (action === 'quests/group/ask/open') out = await openGroupAsk(env, session, body, logAction, scored);
    else if (action === 'quests/group/ask/settle') out = await settleGroupAsk(env, session, body, logAction, scored);
    else out = await unsettleGroupAsk(env, session, body, logAction, scored);
  }
  else if (action === 'messages/delete') out = await deleteMessage(env, session, body, logAction);
  else if (action === 'messages/archive') out = await archiveMessage(env, session, body, logAction);
  else if (action === 'messages/order') out = await orderMessages(env, session, body, logAction);
  else if (action === 'messages/file/delete') out = await deleteMessageFile(env, session, body, logAction);
  else if (action === 'counters/set') out = await counterSet(env, session, body, logAction);
  else if (action === 'files/reclean') return recleanFiles(env, session, body, logAction); // no public payload changes
  else if (action === 'encoder/release') return encoderRelease(env, session, logAction); // nothing public reads this
  else if (action === 'freeze') out = await freezeSet(env, session, body, renderPayload);
  else if (action === 'freeze/close') out = await closeSet(env, session, body);
  else if (action === 'freeze/save') return copySave(env, session, renderPayload); // nothing public changed: no purge
  else if (action === 'freeze/copy/delete') return copyDelete(env, session, body); // nor here
  else if (action === 'flags/set') return flagSet(env, session, body, logAction); // no purge: the public pulse is kept at the edge for 30 seconds, so a switch reaches the site within that
  else if (action === 'recap/hours') return recapHoursSet(env, session, body, logAction); // the recap is never cached: no purge
  else if (action === 'recap/review') return recapReviewSet(env, session, body, logAction);
  else if (action === 'recap/times') return teamTimesSet(env, session, body, logAction);
  else if (action === 'recap/arrivals') return arrivalsSet(env, session, body, logAction);
  else if (action === 'recap/most-skip') return mostSkipSet(env, session, body, logAction);
  else if (action === 'recap/views') return questViewSet(env, session, body, logAction);
  else if (action === 'recap/sections') return recapSectionsSet(env, session, body, logAction);
  else if (action === 'recap/dates') out = await dateRulesSet(env, session, body, logAction); // the leaderboard's times change: purge
  else if (action === 'ranks/boards') return rankBoardsSet(env, session, body, logAction);
  else if (action === 'ranks/recap') return rankRecapSet(env, session, body, logAction);
  else if (action === 'tab/last-until') out = await lastUntilSet(env, session, body, logAction); // the leaderboard is cached: purge
  else if (action === 'limits/set') return limitsSet(env, session, body, logAction); // nothing public reads a limit: no purge
  else if (action === 'drop/delete') return dropDelete(env, session, body, logAction); // not on the tab: no purge
  else if (action === 'links/save') return linkSave(env, session, body, logAction);
  else if (action === 'links/delete') return linkDelete(env, session, body, logAction);
  else if (action === 'linkpage/settings') return linkPageSettings(env, session, body, logAction); // not on the tab: no purge
  else if (action === 'linkpage/save') return linkPageSave(env, session, body, logAction);
  else if (action === 'linkpage/delete') return linkPageDelete(env, session, body, logAction);
  else if (action === 'linkpage/order') return linkPageOrder(env, session, body, logAction);
  else if (action === 'countdown/set') out = await countdownSet(env, session, body, logAction); // /api/countdown is cached: purge
  else if (action === 'phone/settings') out = await phoneSettingsSave(env, session, body, logAction); // the quest list names the phone's quest: purge
  else if (action === 'phone/payphone') out = await payphoneSave(env, ctx, session, body, logAction); // confirming records captures: purge
  else if (action === 'phone/pin') return phonePinNew(env, session, body, logAction);
  else if (action === 'phone/tree') return phoneTreeSave(env, session, body, logAction);
  else if (action === 'phone/message/heard') return phoneMessageHeard(env, body);
  else if (action === 'phone/message/delete') return phoneMessageDelete(env, session, body, logAction);
  else if (action === 'eoi/list') return eoiList(env, session, body, logAction); // nobody's points move until they are awarded
  else if (action === 'eoi/points') out = await eoiPoints(env, session, body, logAction); // re-scores the award: purge
  else if (action === 'eoi/award') out = await eoiAward(env, session, body, logAction); // moves scores: purge
  else if (action === 'ledger/check') return json(Object.assign({ ok: true }, await runLedgerCheck(env.DB)));
  // the home page's pictures: /api/slides is cached, so every one purges
  else if (action === 'slides/edit') out = await slideEdit(env, session, body, logAction);
  else if (action === 'slides/focus') out = await slideFocus(env, session, body, logAction);
  else if (action === 'slides/hide') out = await slideHide(env, session, body, logAction);
  else if (action === 'slides/delete') out = await slideDelete(env, session, body, logAction);
  else if (action === 'slides/order') out = await slideOrder(env, session, body, logAction);
  else if (action === 'slides/step') out = await slideStepSet(env, session, body, logAction);
  else if (action === 'ledger/adjust') out = await ledgerAdjust(env, session, body, ctx, url.origin, logAction); // moves scores: purge
  else if (action === 'ledger/void') out = await ledgerVoid(env, session, body, ctx, url.origin, logAction);
  else if (action === 'points/undo') out = await pointsUndo(env, session, body, ctx, url.origin, logAction);
  else if (action === 'points/redo') out = await pointsRedo(env, session, body, ctx, url.origin, logAction);
  else if (action === 'points/time') out = await pointsTime(env, session, body, logAction); // the recap reads it: purge
  else if (action === 'tally/award') out = await tallyAward(env, session, body, logAction); // a challenge's places: moves scores
  else if (action === 'tally/unaward') out = await tallyUnaward(env, session, body, logAction);
  else if (action === 'submissions/accept') out = await acceptSubmission(env, session, body, ctx, url.origin);
  // a decision changed: each can move scores, so all three purge
  else if (action === 'submissions/revise') out = await reviseSubmission(env, session, body, ctx, url.origin);
  else if (action === 'submissions/reopen') out = await reopenSubmission(env, session, body);
  else if (action === 'submissions/answer') out = await reviseAnswer(env, session, body); // a challenge's public standings can move
  else if (action === 'submissions/delete') out = await deleteSubmission(env, session, body, ctx, url.origin); // an accepted one's points come off
  else if (action === 'submissions/reject') return rejectSubmission(env, session, body, ctx, url.origin); // no score moved: no purge
  else if (action === 'review/claim') return claimSubmission(env, session, body); // who is looking: no public data
  else if (action === 'codes/generate') return generateCodes(env, session); // no public data changed
  else if (action === 'push/send') return pushSend(env, session, body); // no tab data touched: no purge
  // email announcements: nothing public reads them, so none purges
  else if (action === 'announce/preview') return announcePreview(env, body);
  else if (action === 'announce/test') return announceTest(env, session, body, logAction);
  else if (action === 'announce/send') return announceSend(env, session, body, logAction);
  else if (action === 'announce/step') return announceStep(env, body);
  else if (action === 'announce/stop') return announceStop(env, session, body, logAction);
  else if (action === 'announce/retry') return announceRetry(env, session, body, logAction);
  else if (action === 'email/hold') return emailHoldSet(env, session, body, logAction); // the switch that stops every email
  else if (action === 'push/name') return pushName(env, session, body, logAction);
  else if (action === 'rego/settings/set') return regoSettingsSet(env, session, body, logAction); // the form guard; no public cache touched (the status read is never cached)
  else if (action === 'rego/resync') return regoResync(env); // reads only, pushes to the sheet
  else if (action === 'rego/email') return regoResendEmail(env, session, body, logAction); // one person's confirmation again
  else if (action === 'rego/email/test') return emailTest(env, session, body, logAction); // nothing public: one message to one organiser
  else if (action === 'rego/person/qr') return regoPersonQr(env, session, body, logAction); // their check-in code on its own
  else if (action === 'rego/team/save') out = await regoTeamSave(env, session, body, ctx, logAction); // may rename a tab team
  else if (action === 'rego/person/save') return regoPersonSave(env, session, body, ctx, logAction); // no public data
  else if (action === 'rego/person/delete') return regoPersonDelete(env, session, body, ctx, logAction);
  else if (action === 'rego/person/move') return regoPersonMove(env, session, body, ctx, logAction); // to another team, or out of one
  else if (action === 'rego/hide') { // a test signup: the public count is never cached
    var hid = await regoHide(env, session, body, logAction);
    if (hid.status === 200) syncCheckinHiddenLater(env, ctx);
    return hid;
  }
  else if (action === 'rego/team/create') out = await regoTeamCreate(env, session, body, ctx, logAction); // a new team on the tab
  else if (action === 'rego/place') out = await regoPlace(env, session, body, ctx, logAction); // may put a new team on the tab
  else if (action.indexOf('discord/') === 0) return (await handleDiscordConsole(request, env, session, action, body, url, logAction)) || json({ error: 'not found' }, 404);
  else return json({ error: 'not found' }, 404);

  if (out.status === 200) {
    // a hidden team is a test team at the door too
    if (action === 'teams/hide') syncCheckinHiddenLater(env, ctx);
    // The site polls /api/pulse to know when to fetch the quest list
    // again, so every accepted quests/* write moves that number on —
    // once per request, here, rather than in each handler.
    if (action.indexOf('quests/') === 0) await bumpCounter(env.DB, 'quests');
    if (purge) {
      if (ctx && ctx.waitUntil) ctx.waitUntil(purge());
      else await purge();
    }
  }
  return out;
}
