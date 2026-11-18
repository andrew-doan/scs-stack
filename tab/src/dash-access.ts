// Who may do what on the dashboard, which actions ask for the second
// password, and the passwords accounts have of their own.
//
// Every account carries a list of the dashboard's tabs it may use, or
// is an admin, which is every tab and the Accounts tab as well. The
// worker checks that list on every request: the page only leaves out
// the tabs an account cannot use, and a request the page would never
// send is answered the same way as one it would.

import { json, configured, secretMatches, delay } from './shared.ts';
import type { ConsoleSession, Env, SiteFlagRow } from './types.ts';

// An action an admin can put behind the second password.
export interface Guard {
  key: string;
  label: string;
  // 1 when it asks with no row saying otherwise
  on: number;
  actions: string[];
}

// One key per tab of the dashboard, in the order the tabs sit.
export var PERMS = ['scores', 'points', 'review', 'map', 'routes', 'quests', 'teams', 'messages', 'push', 'email',
  'rego', 'files', 'discord', 'settings', 'log'];

export function parsePerms(text: unknown): string[] {
  var out: string[] = [];
  String(text || '').split(',').forEach(function (p) {
    p = p.trim();
    if (PERMS.indexOf(p) !== -1 && out.indexOf(p) === -1) out.push(p);
  });
  return out;
}

// What an action needs: true for any account that is signed in, or the
// tabs any one of which allows it. **An action listed in neither table
// is for admins only**, so a new endpoint is closed until somebody says
// which tab it belongs to.
var EXACT: Record<string, true | string[]> = {
  'GET overview': true,              // the teams and quests every tab reads
  'GET me': true,
  'GET spinner': true,                // team names and points, for the spinner page
  'GET quests': true,                // reviewers read a quest's answers
  'POST auth/backup': true,          // your own printed codes
  'GET board': ['scores'], 'GET recap': ['scores'], 'GET recap/hours': ['scores'], 'POST recap/hours': ['scores'], 'POST recap/review': ['scores'], 'POST recap/times': ['scores'], 'POST recap/arrivals': ['scores'], 'POST recap/most-skip': ['scores'], 'POST recap/views': ['scores'], 'GET recap/sections': ['scores'], 'POST recap/sections': ['scores'], 'POST recap/dates': ['scores'], 'GET ranks/boards': ['scores'], 'POST ranks/boards': ['scores'], 'POST ranks/recap': ['scores'], 'POST tab/last-until': ['scores'], 'GET schedule': ['scores'],
  'GET freeze': ['scores'], 'POST freeze': ['scores'],
  'POST freeze/close': ['scores'], 'POST freeze/save': ['scores'],
  'GET freeze/copy': ['scores'], 'POST freeze/copy/delete': ['scores'], 'GET standings': ['scores'],
  'GET tab/export': ['scores'], 'GET quests-done': ['scores'], 'GET ranks/times': ['scores'], 'GET ranks/custom': ['scores'],
  // a quest's desk: recording a result, taking one back, moving its
  // time. Scores accounts keep it, since setting a score was on their
  // tab before. The desk's lines and its quest list are read by
  // reviewers too.
  'GET points/form': ['points', 'scores', 'review'], 'GET desk': ['review', 'points', 'scores'],
  'POST points/add': ['points', 'scores'], 'POST points/undo': ['points', 'scores', 'review'], 'POST points/redo': ['points', 'scores', 'review'], 'POST points/time': ['points', 'scores'],
  'GET team/receipt': ['review', 'points', 'scores'],
  // a team's ledger: an adjustment, and undoing a line no submission made
  'POST ledger/adjust': ['points', 'scores'], 'POST ledger/void': ['points', 'scores'],
  // a desk's and a ledger's previews show a photo and its details
  'GET submissions': ['review'], 'GET file': ['review', 'points', 'scores'], 'GET file/meta': ['review', 'points', 'scores'],
  'GET file/track': ['review', 'points', 'scores'],
  // a challenge's standings and one team's part in it, read on Review
  // with its quest picked; awarding the places moves scores
  'GET tally': ['review', 'scores', 'points', 'quests'], 'GET tally/team': ['review', 'scores', 'points', 'quests'],
  'POST tally/award': ['scores'], 'POST tally/unaward': ['scores'],
  // a question's answers and its settlement, on the quest's desk as
  // well as in the Quests tab's list of polls and wagers
  'POST quests/group/ask/responses': ['quests', 'review', 'points', 'scores'],
  // taking answers or not is the day's, run from the desk
  'POST quests/group/ask/open': ['quests', 'points', 'scores'],
  'POST quests/group/ask/settle': ['quests', 'scores'], 'POST quests/group/ask/unsettle': ['quests', 'scores'],
  // each line's points against its quest's, on the Scores tab
  'GET ledger/check': ['scores'], 'POST ledger/check': ['scores'],
  'GET map': ['map'],
  // the routes teams recorded for the GPS quest, cleaned and saved on
  // the Routes tab
  'GET tracks': ['routes'], 'GET tracks/gpx': ['routes'],
  'POST tracks/save': ['routes'], 'POST tracks/delete': ['routes'],
  'GET encoder/status': ['review'], 'POST encoder/release': ['review'], 'POST review/claim': ['review'],
  'GET quests/visible': ['quests'], 'GET quests/export': ['quests'], 'GET quests/asks': ['quests'],
  'GET codes': ['teams'], 'POST codes/generate': ['teams'],
  'GET messages/list': ['messages'],
  'GET push/stats': ['push'],
  'GET announce': ['email'],
  'GET rego': ['rego'], 'GET rego/csv': ['rego'],
  // the sign-up form's switches and the test email sit on Settings and
  // are read by the Rego tab too
  'GET rego/settings': ['rego', 'settings'], 'POST rego/settings/set': ['rego', 'settings'],
  'POST rego/email/test': ['rego', 'settings'],
  'GET drop': ['files'], 'GET albums': ['files'], 'GET album': ['files'], 'GET album/pass': ['files'], 'GET album/zip': ['files'],
  'GET flags': ['settings'], 'POST flags/set': ['settings'],
  // the switch that stops every email; the Email and Rego tabs learn it
  // from their own reads (email_off)
  'GET email/hold': ['settings'], 'POST email/hold': ['settings'],
  'GET limits': ['settings'], 'POST limits/set': ['settings'],
  'GET countdown': ['settings'], 'POST countdown/set': ['settings'],
  'GET counters': ['settings'], 'POST counters/set': ['settings'],
  'GET phone': ['quests'], 'GET phone/message': ['quests'], 'GET eoi': ['settings'], 'GET slides': ['settings'],
  'GET export/all': ['settings'], 'POST files/reclean': ['settings'], 'GET storage': ['settings'],
  'GET log': ['log'],
  // a file on its way straight to R2, for any tab that uploads; what it
  // is for decides which of them it needs (src/staged.ts)
  'GET upload/mode': ['messages', 'quests', 'settings', 'files', 'points', 'scores', 'review'],
  'GET upload/sign': ['messages', 'quests', 'settings', 'files', 'points', 'scores', 'review'],
  'POST upload/start': ['messages', 'quests', 'settings', 'files', 'points', 'scores', 'review'],
  'POST upload/finish': ['messages', 'quests', 'settings', 'files', 'points', 'scores', 'review'],
  'POST upload/abort': ['messages', 'quests', 'settings', 'files', 'points', 'scores', 'review']
};

// Then by the start of the action, first match wins.
var PREFIX: [string, string[]][] = [
  // team groups are drawn on the Teams tab
  ['POST quests/team-groups/', ['teams', 'quests']],
  ['POST quests/', ['quests']],
  ['POST teams/', ['teams']],
  ['POST submissions/', ['review']],
  ['POST messages/', ['messages']],
  ['POST push/', ['push']],
  ['POST announce/', ['email']],
  ['POST rego/', ['rego']],
  ['POST drop/', ['files']],
  ['POST albums/', ['files']],
  ['POST album/', ['files']],
  ['POST links/', ['files']],
  ['POST slides/', ['settings']],
  ['POST eoi/', ['settings']],
  ['POST phone/', ['quests']],
  ['GET discord/', ['discord']],
  ['POST discord/', ['discord']]
];

function needFor(verb: string, action: string): true | string[] | null {
  var key = verb + ' ' + action;
  if (Object.prototype.hasOwnProperty.call(EXACT, key)) return EXACT[key];
  for (var i = 0; i < PREFIX.length; i++) {
    if (key.indexOf(PREFIX[i][0]) === 0) return PREFIX[i][1];
  }
  return null;
}

export function allowed(session: Pick<ConsoleSession, 'admin' | 'perms'>, verb: string, action: string): boolean {
  var need = needFor(verb, action);
  if (need === true) return true;
  if (session.admin) return true;
  if (!need) return false;
  return need.some(function (p) { return session.perms.indexOf(p) !== -1; });
}

export function can(session: Pick<ConsoleSession, 'admin' | 'perms'> | null | undefined, perm: string): boolean {
  return !!session && (!!session.admin || session.perms.indexOf(perm) !== -1);
}

// ---------- the second password ----------
// A password apart from the one each account signs in with, held by the
// worker as PUSH_PASSWORD (it began as the lock on push alone). An admin
// picks which of these actions ask for it; sending a push does unless
// somebody turns it off. The dashboard sends it in a header, so it never
// sits in a request body beside the thing being changed.
export var GUARDS: Guard[] = [
  { key: 'push', label: 'Sending a push notification', on: 1, actions: ['POST push/send'] },
  { key: 'email', label: 'Sending an email announcement', on: 0, actions: ['POST announce/send'] },
  { key: 'freeze', label: 'Freezing, unfreezing, closing or opening the tab', on: 0, actions: ['POST freeze', 'POST freeze/close'] },
  { key: 'open-all', label: 'Opening every quest at once', on: 0, actions: ['POST quests/open-all'] },
  { key: 'retire', label: 'Retiring every quest', on: 0, actions: ['POST quests/retire'] },
  { key: 'delete-quest', label: 'Deleting a quest', on: 0, actions: ['POST quests/group/delete', 'POST quests/delete'] },
  { key: 'delete-team', label: 'Deleting a team', on: 0, actions: ['POST teams/delete'] },
  { key: 'delete-submission', label: 'Deleting a submission', on: 0, actions: ['POST submissions/delete'] },
  { key: 'adjust', label: 'Adjusting a team\'s points, or undoing an award or balance line', on: 0, actions: ['POST ledger/adjust', 'POST ledger/void'] },
  { key: 'award', label: 'Awarding or undoing a challenge, a wager or the EOI', on: 0,
    actions: ['POST tally/award', 'POST tally/unaward', 'POST quests/group/ask/settle', 'POST quests/group/ask/unsettle', 'POST eoi/award'] },
  { key: 'delete-signup', label: 'Deleting a person from the sign-ups', on: 0, actions: ['POST rego/person/delete'] },
  { key: 'move-signup', label: 'Moving a person to another team', on: 0, actions: ['POST rego/person/move'] },
  { key: 'discord-delete', label: 'Deleting Discord roles and channels', on: 0, actions: ['POST discord/leftovers/delete'] },
  { key: 'discord-codes', label: 'Sending submit codes in Discord', on: 0, actions: ['POST discord/codes/send'] },
  { key: 'export', label: 'Exporting everything', on: 0, actions: ['GET export/all'] },
  { key: 'privacy', label: 'Downloading, removing or putting back personal data', on: 0,
    actions: ['GET privacy/export', 'POST privacy/remove', 'POST privacy/restore'] },
  { key: 'originals', label: 'Deleting original videos', on: 0, actions: ['POST originals/delete'] },
  { key: 'accounts', label: 'Changing an account', on: 0,
    actions: ['POST accounts/save', 'POST accounts/delete', 'POST auth/reset'] }
];

export function guardByKey(key: string): Guard | null {
  return GUARDS.filter(function (g) { return g.key === key; })[0] || null;
}

export function guardFor(verb: string, action: string): Guard | null {
  var key = verb + ' ' + action;
  return GUARDS.filter(function (g) { return g.actions.indexOf(key) !== -1; })[0] || null;
}

// Every switch as it stands. Kept in site_flags as guard_<key>; one with
// no row is what the list above ships with.
export async function guardStates(db: D1Database): Promise<{ key: string; label: string; on: boolean }[]> {
  var set: Record<string, number> = {};
  try {
    var rows = await db.prepare("SELECT name, value FROM site_flags WHERE substr(name, 1, 6) = 'guard_'").all<SiteFlagRow>();
    (rows.results || []).forEach(function (r) { set[r.name.slice(6)] = Number(r.value) ? 1 : 0; });
  } catch (err) { /* no table yet: the defaults */ }
  return GUARDS.map(function (g) {
    return { key: g.key, label: g.label, on: (g.key in set ? set[g.key] : g.on) === 1 };
  });
}

async function guardOn(db: D1Database, guard: Guard): Promise<boolean> {
  var states = await guardStates(db);
  return states.filter(function (s) { return s.key === guard.key; })[0].on;
}

// The second password itself: null to go ahead, or the answer to send.
// 403 rather than 401, because the session is fine and the page signs
// out on a 401.
export async function secondPasswordRefusal(env: Env, given: unknown, what: string): Promise<Response | null> {
  if (!configured(env.PUSH_PASSWORD)) {
    return json({ error: what + ' needs the second password, and the worker has none: set PUSH_PASSWORD.' }, 403);
  }
  if (await secretMatches(String(given || ''), env.PUSH_PASSWORD)) return null;
  if (given) await delay(400);
  return json({
    error: given ? 'Wrong second password.' : 'This needs the second password.',
    second_password: true, wrong: !!given, what: what
  }, 403);
}

export async function guardRefusal(env: Env, guard: Guard | null, given: unknown): Promise<Response | null> {
  if (!guard || !(await guardOn(env.DB, guard))) return null;
  return secondPasswordRefusal(env, given, guard.label);
}

export function secondPasswordGiven(request: Request): string {
  return request.headers.get('x-second-password') || '';
}

// ---------- an account's own password ----------
// PBKDF2 with SHA-256 through WebCrypto, at the most rounds Workers will
// run. The count is stored with the hash, so it can change later without
// anybody's password having to.
var ROUNDS = 100000;
export var MIN_PASSWORD = 10;

function toB64(bytes: Uint8Array): string {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromB64(text: string): Uint8Array {
  var s = atob(text);
  var out = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function derive(password: unknown, salt: Uint8Array, rounds: number): Promise<Uint8Array> {
  var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)),
    'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt, iterations: rounds }, key, 256));
}

export async function hashPassword(password: unknown): Promise<string> {
  var salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  return 'pbkdf2$' + ROUNDS + '$' + toB64(salt) + '$' + toB64(await derive(password, salt, ROUNDS));
}

export async function passwordMatches(password: unknown, stored: string | null | undefined): Promise<boolean> {
  var parts = String(stored || '').split('$');
  if (!password || parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  var rounds = Number(parts[1]);
  if (!(rounds >= 1 && rounds <= ROUNDS)) return false;
  var want;
  var got;
  try {
    want = fromB64(parts[3]);
    got = await derive(password, fromB64(parts[2]), rounds);
  } catch (err) {
    return false;
  }
  if (got.length !== want.length) return false;
  var diff = 0;
  for (var i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
