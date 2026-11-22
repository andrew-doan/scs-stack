// The payphone quest. A team calls the event's number from a payphone
// and keys in its phone PIN; the phone worker (phone/, its own worker)
// checks the call came from the phone provider and reports the PIN and
// the caller's number to POST /api/phone/capture, keyed by
// PHONE_SYNC_KEY. A capture is one team at one payphone, once, and it
// is recorded on the tab as an organiser's entry on the quest's code
// (recordPoints), so the code's own scoring type decides what it is
// worth: per unit up to its most, or counted towards the challenge.
//
// A number counts once an organiser has confirmed it is a payphone.
// One nobody has looked at keeps its captures waiting, and confirming
// it records them all.
import { json, corsJson, cleanText, configured, secretMatches, bearerToken, utcStamp, randomKey, serveStoredFile } from './shared.ts';
import { ledgerReady, LEDGER_BEHIND } from './ledger.ts';
import { SUM_POINTS } from './tab.ts';
import { partsFor, buildCredit } from './parts.ts';
import { recordPoints, tellTeam } from './points.ts';
import { requireTeam } from './submit.ts';
import { bumpCounter } from './messages.ts';
import type { ConsoleSession, Ctx, Env, JsonBody, LogAction } from './types.ts';

// The name organiser entries from the phone are recorded under.
export var PHONE_ACTOR = 'phone';
// Wrong PINs from one number before it is refused for a while.
var BAD_PINS = 8;
var BAD_PIN_MINUTES = 10;

interface Settings { code: string; number: string; open: boolean; staff_pin: string }
interface Payphone { id: number; number: string; name: string; state: string }
interface Answer { result: string; count?: number; name?: string; team_id?: number }

// ---------- settings ----------

// What the organisers set: the code a capture credits, the number teams
// call as it is shown to them, whether calls are being taken, and the
// PIN an organiser keys in to register the payphone they are at.
export async function phoneSettings(db: D1Database): Promise<Settings> {
  var out: Settings = { code: '', number: '', open: false, staff_pin: '' };
  try {
    var rows = (await db.prepare(
      "SELECT name, value FROM site_text WHERE name IN ('phone_code', 'phone_number', 'phone_open', 'phone_staff_pin')"
    ).all<{ name: string; value: string }>()).results;
    rows.forEach(function (r) {
      if (r.name === 'phone_code') out.code = r.value;
      else if (r.name === 'phone_number') out.number = r.value;
      else if (r.name === 'phone_open') out.open = r.value === '1';
      else if (r.name === 'phone_staff_pin') out.staff_pin = r.value;
    });
  } catch (err) { /* a database from before the table: nothing set */ }
  return out;
}

function setText(db: D1Database, name: string, value: string): D1PreparedStatement {
  return value
    ? db.prepare('INSERT INTO site_text (name, value) VALUES (?1, ?2) ON CONFLICT(name) DO UPDATE SET value = ?2').bind(name, value)
    : db.prepare('DELETE FROM site_text WHERE name = ?1').bind(name);
}

// Six digits, never starting with 0 so it reads the same typed or said.
function newPin(): string {
  var buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(100000 + (buf[0] % 900000));
}

// The team's PIN, minted the first time it is asked for. `fresh` gives
// it a new one. A clash with another team's is tried again.
export async function pinFor(db: D1Database, teamId: number, fresh?: boolean): Promise<string> {
  if (!fresh) {
    var had = await db.prepare('SELECT pin FROM phone_pins WHERE team_id = ?1').bind(teamId).first<{ pin: string }>();
    if (had) return had.pin;
  }
  for (var i = 0; i < 20; i++) {
    var pin = newPin();
    var done = await db.prepare(
      'INSERT INTO phone_pins (team_id, pin) SELECT ?1, ?2 WHERE NOT EXISTS (SELECT 1 FROM phone_pins WHERE pin = ?2) ' +
      "AND ?2 != COALESCE((SELECT value FROM site_text WHERE name = 'phone_staff_pin'), '') " +
      (fresh ? 'ON CONFLICT(team_id) DO UPDATE SET pin = ?2' : 'ON CONFLICT(team_id) DO NOTHING')
    ).bind(teamId, pin).run();
    if (done.meta && done.meta.changes) return pin;
    if (!fresh) {
      var won = await db.prepare('SELECT pin FROM phone_pins WHERE team_id = ?1').bind(teamId).first<{ pin: string }>();
      if (won) return won.pin;
    }
  }
  throw new Error('no free phone PIN');
}

// ---------- the caller's number ----------

// What kind of number called. The provider sends E.164 (+61293851234),
// or a word in place of a number the caller withheld.
export function callerKind(from: unknown): { kind: 'private' | 'mobile' | 'other' | 'landline'; number: string } {
  var raw = String(from == null ? '' : from).trim();
  var digits = raw.replace(/[^\d+]/g, '');
  if (!digits || /anonymous|restricted|unknown|private|blocked/i.test(raw) || digits === '+266696687' || digits === '266696687') {
    return { kind: 'private', number: '' };
  }
  if (digits.charAt(0) !== '+') digits = digits.charAt(0) === '0' ? '+61' + digits.slice(1) : '+' + digits;
  if (/^\+61[45]\d{8}$/.test(digits)) return { kind: 'mobile', number: digits };
  if (/^\+61[2378]\d{8}$/.test(digits)) return { kind: 'landline', number: digits };
  return { kind: 'other', number: digits };
}

async function callerKey(number: string): Promise<string> {
  var bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('scs-phone:' + number)));
  var out = '';
  for (var i = 0; i < 8; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return out;
}

// ---------- recording a capture on the tab ----------

async function teamTotal(db: D1Database, teamId: number): Promise<number> {
  var row = await db.prepare('SELECT ' + SUM_POINTS + ' AS total FROM held c WHERE c.team_id = ?1').bind(teamId).first<{ total: number }>();
  return row ? Number(row.total) || 0 : 0;
}

// The capture's entry on the quest's code, or why there is none:
// 'capped' when the code takes no more from this team.
async function scoreCapture(env: Env, ctx: Ctx | null, code: string, capture: { id: number; team_id: number; team_name: string }, phone: Payphone): Promise<'captured' | 'capped' | 'error'> {
  var db = env.DB;
  var claimed = await db.prepare(
    'UPDATE phone_captures SET submission_id = -1 WHERE id = ?1 AND submission_id IS NULL AND capped = 0'
  ).bind(capture.id).run();
  if (!(claimed.meta && claimed.meta.changes)) return 'error';
  var parts = await partsFor(db, [code]);
  var part = parts[code];
  if (!part) {
    await db.prepare('UPDATE phone_captures SET submission_id = NULL WHERE id = ?1 AND submission_id = -1').bind(capture.id).run();
    return 'error';
  }
  var row = await db.prepare('SELECT amount FROM held WHERE team_id = ?1 AND quest_code = ?2')
    .bind(capture.team_id, code).first<{ amount: number }>();
  var had = row ? Number(row.amount) || 0 : 0;
  var full = part.scoring === 'unit' ? part.most != null && had + 1 > part.most : part.scoring !== 'counted' && had > 0;
  if (full) {
    await db.prepare('UPDATE phone_captures SET submission_id = NULL, capped = 1 WHERE id = ?1 AND submission_id = -1').bind(capture.id).run();
    return 'capped';
  }
  var built = buildCredit(parts, [code], { amount: 1 });
  if ('error' in built) {
    await db.prepare('UPDATE phone_captures SET submission_id = NULL WHERE id = ?1 AND submission_id = -1').bind(capture.id).run();
    return 'error';
  }
  var credit = built.credit;
  var id = await recordPoints(db, {
    teamId: capture.team_id, quest: code, credit: credit, by: PHONE_ACTOR,
    note: 'Payphone: ' + (phone.name || phone.number)
  });
  if (!id) {
    await db.prepare('UPDATE phone_captures SET submission_id = NULL WHERE id = ?1 AND submission_id = -1').bind(capture.id).run();
    return 'error';
  }
  await db.prepare('UPDATE phone_captures SET submission_id = ?2, capped = 0 WHERE id = ?1').bind(capture.id, id).run();
  var told = teamTotal(db, capture.team_id).then(function (total: number) {
    return tellTeam(env, '', { id: null, team_id: capture.team_id, team_name: capture.team_name },
      { verdict: 'accepted', quest: code, credit: credit, total: total, reason: phone.name || '' });
  }).catch(function () { /* the capture stands without its post */ });
  if (ctx && ctx.waitUntil) ctx.waitUntil(told); else await told;
  return 'captured';
}

// Every capture waiting on a payphone, recorded now that it is one.
async function settleWaiting(env: Env, ctx: Ctx | null, code: string, phone: Payphone): Promise<number> {
  var waiting = (await env.DB.prepare(
    'SELECT c.id, c.team_id, t.name AS team_name FROM phone_captures c JOIN teams t ON t.id = c.team_id ' +
    'WHERE c.payphone_id = ?1 AND c.submission_id IS NULL AND c.capped = 0 ORDER BY c.id'
  ).bind(phone.id).all<{ id: number; team_id: number; team_name: string }>()).results;
  var n = 0;
  for (var i = 0; i < waiting.length; i++) {
    if ((await scoreCapture(env, ctx, code, waiting[i], phone)) === 'captured') n++;
  }
  return n;
}

// How many payphones the team has: every capture but one at a number
// an organiser said is not a payphone.
async function countFor(db: D1Database, teamId: number): Promise<number> {
  var row = await db.prepare(
    "SELECT COUNT(*) AS n FROM phone_captures c JOIN payphones p ON p.id = c.payphone_id WHERE c.team_id = ?1 AND p.state != 'no'"
  ).bind(teamId).first<{ n: number }>();
  return row ? Number(row.n) || 0 : 0;
}

// ---------- a call ----------

// the results that mean the PIN was a team's
var HAS_TEAM = ['captured', 'already', 'waiting', 'capped', 'not_payphone', 'error'];

// One call that reached a PIN: who called, from where, and what the
// voice should say about it. Results: captured, already, waiting,
// capped, registered, bad_pin, locked, private, mobile, not_payphone,
// closed, error.
export async function capture(env: Env, ctx: Ctx | null, body: JsonBody): Promise<Answer> {
  var db = env.DB;
  var set = await phoneSettings(db);
  var pin = String(body.pin == null ? '' : body.pin).replace(/\D/g, '').slice(0, 12);
  var caller = callerKind(body.from);
  var key = caller.number ? await callerKey(caller.number) : '';
  var call = cleanText(body.call, 64);
  async function done(result: string, teamId?: number | null, phoneId?: number | null, extra?: Partial<Answer>): Promise<Answer> {
    await db.prepare('INSERT INTO phone_calls (caller, result, team_id, payphone_id) VALUES (?1, ?2, ?3, ?4)')
      .bind(key, result, teamId || null, phoneId || null).run();
    var out: Answer = { result: result };
    if (extra) { if (extra.count != null) out.count = extra.count; if (extra.name) out.name = extra.name; }
    if (teamId && HAS_TEAM.indexOf(result) !== -1) out.team_id = teamId;
    return out;
  }
  if (!set.open || !set.code) return done('closed');
  // decided before the PIN is looked at, so neither is a way to try PINs
  if (caller.kind === 'private') return done('private');
  if (caller.kind === 'mobile') return done('mobile');
  if (caller.kind === 'other') return done('not_payphone');
  var wrong = await db.prepare(
    "SELECT COUNT(*) AS n FROM phone_calls WHERE caller = ?1 AND result = 'bad_pin' AND at > datetime('now', ?2)"
  ).bind(key, '-' + BAD_PIN_MINUTES + ' minutes').first<{ n: number }>();
  if (wrong && wrong.n >= BAD_PINS) return done('locked');

  // the number, kept the first time anything calls from it
  await db.prepare('INSERT INTO payphones (number) VALUES (?1) ON CONFLICT(number) DO NOTHING').bind(caller.number).run();
  var phone = await db.prepare('SELECT id, number, name, state FROM payphones WHERE number = ?1')
    .bind(caller.number).first<Payphone>() as Payphone;

  // an organiser at the phone, registering it
  if (set.staff_pin && pin === set.staff_pin) {
    if (phone.state !== 'ok') {
      var moved = await db.prepare("UPDATE payphones SET state = 'ok' WHERE id = ?1 AND state != 'ok'").bind(phone.id).run();
      phone.state = 'ok';
      if (moved.meta && moved.meta.changes && (await ledgerReady(db))) await settleWaiting(env, ctx, set.code, phone);
    }
    return done('registered', null, phone.id, { name: phone.name });
  }

  var team = pin.length === 6 ? await db.prepare(
    'SELECT t.id, t.name FROM phone_pins p JOIN teams t ON t.id = p.team_id WHERE p.pin = ?1'
  ).bind(pin).first<{ id: number; name: string }>() : null;
  if (!team) return done('bad_pin', null, phone.id);
  if (phone.state === 'no') return done('not_payphone', team.id, phone.id);
  if (!(await ledgerReady(db))) return done('error', team.id, phone.id);

  // one capture a team and payphone: the index decides a repeat
  var made = await db.prepare(
    'INSERT INTO phone_captures (team_id, payphone_id, at, call) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(team_id, payphone_id) DO NOTHING RETURNING id'
  ).bind(team.id, phone.id, utcStamp(), call).first<{ id: number }>();
  if (!made) return done('already', team.id, phone.id, { count: await countFor(db, team.id), name: phone.name });
  if (phone.state !== 'ok') return done('waiting', team.id, phone.id, { count: await countFor(db, team.id) });
  var scored = await scoreCapture(env, ctx, set.code, { id: made.id, team_id: team.id, team_name: team.name }, phone);
  if (scored === 'error') {
    // nothing was recorded, so the team can call again
    await db.prepare('DELETE FROM phone_captures WHERE id = ?1 AND submission_id IS NULL').bind(made.id).run();
    return done('error', team.id, phone.id);
  }
  return done(scored, team.id, phone.id, { count: await countFor(db, team.id), name: phone.name });
}

// ---------- the phone tree ----------

// What a call hears, as steps the organisers edit on the dashboard. A
// menu reads its words and sends each key to another step; a capture
// asks for a team's PIN and records the payphone; a record takes a
// message, from a team when `pin` is on; a say reads its words. A step
// with no `next` ends the call.
export interface TreeNode {
  kind: 'menu' | 'capture' | 'record' | 'say';
  say: string;
  next?: string;
  options?: Record<string, string>;
  max?: number;
  pin?: boolean;
}
export interface Tree { start: string; nodes: Record<string, TreeNode> }

var ASK_PIN = 'Key in your team\'s six digit phone PIN.';
export var DEFAULT_TREE: Tree = {
  start: 'capture',
  nodes: { capture: { kind: 'capture', say: 'S C S payphone tag. ' + ASK_PIN } }
};
var KINDS = ['menu', 'capture', 'record', 'say'];
var MAX_NODES = 30;
var MAX_SAY = 600;
var TRIES = 3;
// how many steps one request may walk, so a tree that loops ends
var MAX_HOPS = 8;

// A tree as typed on the dashboard, checked, or why it will not do.
export function cleanTree(raw: unknown): { tree: Tree } | { error: string } {
  var v = raw && typeof raw === 'object' ? raw as Record<string, unknown> : null;
  var given = v && v.nodes && typeof v.nodes === 'object' ? v.nodes as Record<string, unknown> : null;
  if (!v || !given) return { error: 'The phone tree needs its steps.' };
  var ids = Object.keys(given);
  if (!ids.length) return { error: 'The phone tree needs at least one step.' };
  if (ids.length > MAX_NODES) return { error: 'A phone tree has at most ' + MAX_NODES + ' steps.' };
  var nodes: Record<string, TreeNode> = {};
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    if (!/^[a-z0-9-]{1,30}$/.test(id)) return { error: 'A step\'s name is lower case letters, digits and hyphens: ' + id };
    var n = given[id] && typeof given[id] === 'object' ? given[id] as Record<string, unknown> : {};
    var kind = String(n.kind || '');
    if (KINDS.indexOf(kind) === -1) return { error: id + ' has no kind.' };
    var say = cleanText(n.say, MAX_SAY);
    if (!say && kind !== 'capture') return { error: id + ' needs words to say.' };
    var node: TreeNode = { kind: kind as TreeNode['kind'], say: say || ASK_PIN };
    var next = String(n.next || '');
    if (next && kind !== 'menu') {
      if (ids.indexOf(next) === -1) return { error: id + ' goes on to ' + next + ', which is not a step.' };
      node.next = next;
    }
    if (kind === 'menu') {
      var opts = n.options && typeof n.options === 'object' ? n.options as Record<string, unknown> : {};
      var keys = Object.keys(opts);
      if (!keys.length) return { error: id + ' is a menu with no keys.' };
      node.options = {};
      for (var k = 0; k < keys.length; k++) {
        var to = String(opts[keys[k]] || '');
        if (!/^[0-9*#]$/.test(keys[k])) return { error: id + ': a menu key is one of 0 to 9, * and #.' };
        if (ids.indexOf(to) === -1) return { error: id + ': key ' + keys[k] + ' goes to ' + to + ', which is not a step.' };
        node.options[keys[k]] = to;
      }
    }
    if (kind === 'record') {
      node.max = Math.max(5, Math.min(120, Math.round(Number(n.max) || 60)));
      if (n.pin) node.pin = true;
    }
    nodes[id] = node;
  }
  var start = String(v.start || '');
  if (!nodes[start]) return { error: 'Pick the step a call starts at.' };
  return { tree: { start: start, nodes: nodes } };
}

// The tree in force: the saved one, or one step that takes a capture.
export async function phoneTree(db: D1Database): Promise<Tree> {
  try {
    var row = await db.prepare("SELECT value FROM site_text WHERE name = 'phone_tree'").first<{ value: string }>();
    if (row && row.value) {
      var read = cleanTree(JSON.parse(row.value));
      if ('tree' in read) return read.tree;
    }
  } catch (err) { /* unreadable: the default */ }
  return DEFAULT_TREE;
}

// What the voice says about a capture.
function count(n: number): string {
  return n === 1 ? 'That is 1 payphone.' : 'That is ' + n + ' payphones.';
}
export function resultLine(d: Answer): string {
  var n = Number(d.count) || 0;
  switch (d.result) {
    case 'captured': return (d.name ? d.name + ' captured. ' : 'Payphone captured. ') + count(n);
    case 'already': return 'Your team already has this payphone. ' + count(n);
    case 'waiting': return 'Recorded. An organiser will check this phone. ' + count(n);
    case 'capped': return 'Captured. Your team has reached the most this quest counts. ' + count(n);
    case 'registered': return 'This payphone is registered.';
    case 'private': return 'This phone hides its number, so it cannot be captured by calling. Send a photo of it on the website instead.';
    case 'mobile': return 'This call is from a mobile. Call from a payphone.';
    case 'not_payphone': return 'This phone does not count as a payphone.';
    case 'locked': return 'Too many wrong PINs from this phone. Try again in ten minutes.';
    case 'closed': return 'Payphone tag is not open.';
    case 'bad_pin': return 'That PIN is not right.';
    default: return 'Something went wrong. Try again in a minute.';
  }
}

// What the phone worker is told to do, in order. `to` is where the
// caller's keys or recording come back: a step and what the call has
// said so far, which the phone worker hands back untouched.
type Action =
  | { say: string }
  | { gather: { digits: number; say: string; to: { node: string; state: string } } }
  | { record: { max: number; to: { node: string; state: string } } }
  | { hangup: true };
// t the team the call has proved, n tries so far, w what the keys
// coming back are, c the caller's key and p its payphone, for a message
interface CallState { t?: number; n?: number; w?: string; c?: string; p?: number }

function packState(s: CallState): string { return JSON.stringify(s); }
function readState(raw: unknown): CallState {
  try {
    var v = JSON.parse(String(raw || '{}')) as Record<string, unknown>;
    if (!v || typeof v !== 'object') return {};
    var out: CallState = {};
    if (Number(v.t) > 0) out.t = Number(v.t);
    if (Number(v.n) > 0) out.n = Number(v.n);
    if (typeof v.w === 'string') out.w = v.w.slice(0, 10);
    if (typeof v.c === 'string') out.c = v.c.slice(0, 32);
    if (Number(v.p) > 0) out.p = Number(v.p);
    return out;
  } catch (err) { return {}; }
}

// One step of a call: where it is, what was keyed in, and what to do
// next. The phone worker posts here at the start of a call and every
// time the caller's keys or a recording come back.
export async function phoneStep(env: Env, ctx: Ctx | null, body: JsonBody): Promise<{ actions: Action[]; result?: string }> {
  var db = env.DB;
  var tree = await phoneTree(db);
  var caller = callerKind(body.from);
  var key = caller.number ? await callerKey(caller.number) : '';
  var result: string | undefined;
  var bye: Action[] = [{ hangup: true }];

  // the team a PIN belongs to, with the same lock a capture has
  async function teamByPin(pin: string): Promise<number | 'locked' | null> {
    var wrong = await db.prepare(
      "SELECT COUNT(*) AS n FROM phone_calls WHERE caller = ?1 AND result = 'bad_pin' AND at > datetime('now', ?2)"
    ).bind(key, '-' + BAD_PIN_MINUTES + ' minutes').first<{ n: number }>();
    if (wrong && wrong.n >= BAD_PINS) return 'locked';
    var team = /^\d{6}$/.test(pin) ? await db.prepare('SELECT team_id FROM phone_pins WHERE pin = ?1').bind(pin).first<{ team_id: number }>() : null;
    if (team) return team.team_id;
    await db.prepare("INSERT INTO phone_calls (caller, result) VALUES (?1, 'bad_pin')").bind(key).run();
    return null;
  }

  async function visit(id: string, digits: string, state: CallState, hops: number, back: boolean): Promise<Action[]> {
    var node = tree.nodes[id];
    if (!node || hops > MAX_HOPS) return bye;
    var kept: CallState = state.t ? { t: state.t } : {};
    var onward = async function (): Promise<Action[]> {
      return node.next ? visit(node.next, '', kept, hops + 1, false) : bye;
    };
    var tries = state.n || 0;

    if (node.kind === 'say') return ([{ say: node.say }] as Action[]).concat(await onward());

    if (node.kind === 'menu') {
      var options = node.options || {};
      if (digits && options[digits]) return visit(options[digits], '', kept, hops + 1, false);
      if (digits && tries + 1 >= TRIES) return ([{ say: 'Goodbye.' }] as Action[]).concat(bye);
      var again = Object.assign({}, kept, { n: digits ? tries + 1 : tries });
      return [
        { gather: { digits: 1, say: (digits ? 'That is not one of the choices. ' : '') + node.say, to: { node: id, state: packState(again) } } },
        { say: 'Goodbye.' }, { hangup: true }
      ];
    }

    if (node.kind === 'capture') {
      if (!digits) {
        return [
          { gather: { digits: 6, say: node.say, to: { node: id, state: packState(kept) } } },
          { say: 'No PIN came through. Call again when you are ready.' }, { hangup: true }
        ];
      }
      var ans = await capture(env, ctx, { pin: digits, from: body.from, call: body.call });
      result = ans.result;
      if (ans.result === 'bad_pin' && tries + 1 < TRIES) {
        return [
          { gather: { digits: 6, say: 'That PIN is not right. ' + ASK_PIN, to: { node: id, state: packState(Object.assign({}, kept, { n: tries + 1 })) } } },
          { hangup: true }
        ];
      }
      if (ans.team_id) kept = { t: ans.team_id };
      var said: Action[] = [{ say: resultLine(ans) }];
      // a call that proved no team ends here: what follows may be the team's
      return ans.team_id || ans.result === 'registered' ? said.concat(await onward()) : said.concat(bye);
    }

    // record
    if (back && state.w === 'rec') {
      result = 'message';
      return ([{ say: 'Thank you. Your message is saved.' }] as Action[]).concat(await onward());
    }
    if (node.pin && !state.t) {
      var askPin = function (lead: string, n: number): Action[] {
        return [
          { gather: { digits: 6, say: lead + ASK_PIN, to: { node: id, state: packState({ w: 'pin', n: n }) } } },
          { hangup: true }
        ];
      };
      if (!digits || state.w !== 'pin') return askPin('', 0);
      var who = await teamByPin(digits);
      if (who === 'locked') { result = 'locked'; return ([{ say: resultLine({ result: 'locked' }) }] as Action[]).concat(bye); }
      if (!who) {
        result = 'bad_pin';
        return tries + 1 < TRIES ? askPin('That PIN is not right. ', tries + 1) : ([{ say: 'That PIN is not right.' }] as Action[]).concat(bye);
      }
      kept = { t: who };
    }
    var holds: CallState = Object.assign({}, kept, { w: 'rec' });
    if (key) holds.c = key;
    if (caller.kind === 'landline') {
      var phone = await db.prepare('SELECT id FROM payphones WHERE number = ?1').bind(caller.number).first<{ id: number }>();
      if (phone) holds.p = phone.id;
    }
    return [
      { say: node.say },
      { record: { max: node.max || 60, to: { node: id, state: packState(holds) } } },
      { say: 'Nothing was recorded.' }, { hangup: true }
    ];
  }

  var state = readState(body.state);
  var id = String(body.node || '');
  var digits = String(body.digits == null ? '' : body.digits).replace(/[^\d*#]/g, '').slice(0, 12);
  var actions = tree.nodes[id]
    ? await visit(id, digits, state, 0, !!body.recorded)
    : await visit(tree.start, '', {}, 0, false);
  return { actions: actions, result: result };
}

async function fromPhoneWorker(request: Request, env: Env): Promise<boolean> {
  return configured(env.PHONE_SYNC_KEY) && (await secretMatches(bearerToken(request), env.PHONE_SYNC_KEY));
}

// POST /api/phone/step, from the phone worker.
export async function handlePhoneStep(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  if (!(await fromPhoneWorker(request, env))) return json({ error: 'not allowed' }, 401);
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  try {
    return json(Object.assign({ ok: true }, await phoneStep(env, ctx, body)));
  } catch (err) {
    console.error('phone step', err);
    return json({ ok: true, result: 'error', actions: [{ say: resultLine({ result: 'error' }) }, { hangup: true }] });
  }
}

// ---------- recorded messages ----------

var MAX_MESSAGE_BYTES = 10 * 1024 * 1024;

// POST /api/phone/message, from the phone worker: the audio of one
// recording as the body, and in the query its id at the provider (rec),
// the call, the step, how long it runs and what the call had said
// (state). Kept once per rec.
export async function handlePhoneMessage(request: Request, env: Env, url: URL): Promise<Response> {
  if (!(await fromPhoneWorker(request, env))) return json({ error: 'not allowed' }, 401);
  var rec = cleanText(url.searchParams.get('rec'), 64);
  if (!rec) return json({ error: 'rec is required' }, 400);
  var db = env.DB;
  if (await db.prepare('SELECT 1 AS x FROM phone_messages WHERE rec = ?1').bind(rec).first()) return json({ ok: true, kept: false });
  var bytes = await request.arrayBuffer();
  if (!bytes.byteLength) return json({ error: 'no audio' }, 400);
  if (bytes.byteLength > MAX_MESSAGE_BYTES) return json({ error: 'too large' }, 413);
  var state = readState(url.searchParams.get('state'));
  var key = 'phn/' + randomKey(12);
  await env.SUBMIT.put(key, bytes, { httpMetadata: { contentType: request.headers.get('content-type') || 'audio/mpeg' } });
  var made = await db.prepare(
    'INSERT INTO phone_messages (rec, call, node, team_id, payphone_id, caller, r2_key, seconds, bytes) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) ' +
    'ON CONFLICT(rec) DO NOTHING'
  ).bind(rec, cleanText(url.searchParams.get('call'), 64), cleanText(url.searchParams.get('node'), 30), state.t || null, state.p || null,
    state.c || '', key, Math.max(0, Math.round(Number(url.searchParams.get('seconds')) || 0)), bytes.byteLength).run();
  // the same recording sent twice at once: the second copy goes
  if (!(made.meta && made.meta.changes)) { await env.SUBMIT.delete(key); return json({ ok: true, kept: false }); }
  return json({ ok: true, kept: true });
}

// ---------- the team's own read ----------

// GET /api/phone/mine (a team's submit session): the number to call,
// the team's PIN and the payphones it has. 404 while calls are not
// being taken, so the site shows nothing.
export async function handlePhoneApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== '/api/phone/mine') return null;
  if (request.method === 'OPTIONS') return corsJson({ ok: true });
  if (request.method !== 'GET') return corsJson({ error: 'not found' }, 404);
  var quiet = { 'cache-control': 'private, no-store' };
  var team = await requireTeam(request, env.DB);
  if (!team) return corsJson({ error: 'signed out' }, 401, quiet);
  var set = await phoneSettings(env.DB);
  if (!set.open || !set.code) return corsJson({ ok: false, open: false }, 404, quiet);
  var rows = (await env.DB.prepare(
    'SELECT p.name, p.state, c.at, c.submission_id, c.capped FROM phone_captures c JOIN payphones p ON p.id = c.payphone_id ' +
    "WHERE c.team_id = ?1 AND p.state != 'no' ORDER BY c.id"
  ).bind(team.team_id).all<{ name: string; state: string; at: string; submission_id: number | null; capped: number }>()).results;
  return corsJson({
    ok: true, open: true, number: set.number, pin: await pinFor(env.DB, team.team_id),
    count: rows.length,
    captures: rows.map(function (r, i) {
      return { name: r.name || 'Payphone ' + (i + 1), at: r.at, waiting: r.state !== 'ok', capped: !!r.capped };
    })
  }, 200, quiet);
}

// ---------- the dashboard ----------

async function summary(db: D1Database): Promise<Record<string, unknown>> {
  var set = await phoneSettings(db);
  var phones = (await db.prepare(
    'SELECT p.id, p.number, p.name, p.state, p.created_at, ' +
    '(SELECT COUNT(*) FROM phone_captures c WHERE c.payphone_id = p.id) AS teams, ' +
    '(SELECT COUNT(*) FROM phone_captures c WHERE c.payphone_id = p.id AND c.submission_id IS NULL AND c.capped = 0) AS waiting ' +
    "FROM payphones p ORDER BY CASE p.state WHEN 'new' THEN 0 WHEN 'ok' THEN 1 ELSE 2 END, p.name, p.id"
  ).all()).results;
  var teams = (await db.prepare(
    'SELECT t.id, t.name, t.hidden, COALESCE(p.pin, \'\') AS pin, ' +
    "(SELECT COUNT(*) FROM phone_captures c JOIN payphones h ON h.id = c.payphone_id WHERE c.team_id = t.id AND h.state != 'no') AS captures " +
    'FROM teams t LEFT JOIN phone_pins p ON p.team_id = t.id ORDER BY t.name COLLATE NOCASE'
  ).all()).results;
  var calls = (await db.prepare(
    'SELECT c.at, c.result, COALESCE(t.name, \'\') AS team, COALESCE(NULLIF(p.name, \'\'), p.number, \'\') AS payphone ' +
    'FROM phone_calls c LEFT JOIN teams t ON t.id = c.team_id LEFT JOIN payphones p ON p.id = c.payphone_id ORDER BY c.id DESC LIMIT 60'
  ).all()).results;
  var part = set.code ? (await partsFor(db, [set.code]))[set.code] : null;
  var messages = (await db.prepare(
    'SELECT m.id, m.at, m.node, m.seconds, m.bytes, m.heard, COALESCE(t.name, \'\') AS team, ' +
    'COALESCE(NULLIF(p.name, \'\'), p.number, \'\') AS payphone ' +
    'FROM phone_messages m LEFT JOIN teams t ON t.id = m.team_id LEFT JOIN payphones p ON p.id = m.payphone_id ORDER BY m.id DESC LIMIT 200'
  ).all()).results;
  var saved = await db.prepare("SELECT 1 AS x FROM site_text WHERE name = 'phone_tree'").first();
  return {
    ok: true, settings: set, scoring: part ? part.scoring : null, code_missing: !!set.code && !part,
    payphones: phones, teams: teams, calls: calls, messages: messages,
    tree: await phoneTree(db), tree_default: !saved
  };
}

export async function phoneRead(env: Env): Promise<Response> {
  return json(await summary(env.DB));
}

// POST phone/settings {code, number, open}: only what is sent changes.
export async function phoneSettingsSave(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var now = await phoneSettings(db);
  var stmts: D1PreparedStatement[] = [];
  if (body.code !== undefined) {
    var code = cleanText(body.code, 60);
    if (code) {
      var part = (await partsFor(db, [code]))[code];
      if (!part) return json({ error: 'No code called ' + code + ' is on the tab.' }, 400);
      if (part.scoring !== 'unit' && part.scoring !== 'counted') {
        return json({ error: code + ' has to be per unit or counted, so each payphone adds to it. Change it in the quest editor.' }, 400);
      }
    }
    stmts.push(setText(db, 'phone_code', code));
    now.code = code;
  }
  if (body.number !== undefined) {
    var number = cleanText(body.number, 30);
    if (number && !/^[\d +()-]{6,30}$/.test(number)) return json({ error: 'That does not look like a phone number.' }, 400);
    stmts.push(setText(db, 'phone_number', number));
    now.number = number;
  }
  if (body.open !== undefined) {
    if (body.open && !now.code) return json({ error: 'Pick the code a capture credits first.' }, 400);
    stmts.push(setText(db, 'phone_open', body.open ? '1' : ''));
    now.open = !!body.open;
  }
  if (body.staff_pin) {
    // a new organiser PIN, never one a team holds
    var pin = '';
    for (var i = 0; i < 20 && !pin; i++) {
      var tried = newPin();
      if (!(await db.prepare('SELECT 1 AS x FROM phone_pins WHERE pin = ?1').bind(tried).first())) pin = tried;
    }
    stmts.push(setText(db, 'phone_staff_pin', pin));
  }
  if (stmts.length) await db.batch(stmts);
  // the quest list says which quest is the phone's, and with what number
  await bumpCounter(db, 'quests');
  await logAction(db, session.name, 'phone-settings', now.open ? 'open' : 'shut', now.code || '-', 0, 0, 0);
  return json(await summary(db));
}

// POST phone/payphone {id, name, state} or {number, name, state} for
// one typed in by hand. Confirming one records the captures waiting on
// it. Saying it is not a payphone stops new captures there; entries it
// already made are taken back from the team's ledger, one by one.
export async function payphoneSave(env: Env, ctx: Ctx | null, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var phone: Payphone | null = null;
  if (body.id) {
    phone = await db.prepare('SELECT id, number, name, state FROM payphones WHERE id = ?1').bind(Number(body.id) || 0).first<Payphone>();
    if (!phone) return json({ error: 'No such payphone.' }, 404);
  } else {
    var typed = callerKind(body.number);
    if (typed.kind !== 'landline') return json({ error: 'Give the payphone’s number with its area code, like 02 9385 1234.' }, 400);
    await db.prepare('INSERT INTO payphones (number) VALUES (?1) ON CONFLICT(number) DO NOTHING').bind(typed.number).run();
    phone = await db.prepare('SELECT id, number, name, state FROM payphones WHERE number = ?1').bind(typed.number).first<Payphone>() as Payphone;
    if (body.state === undefined) body.state = 'ok';
  }
  var name = body.name !== undefined ? cleanText(body.name, 80) : phone.name;
  var state = body.state !== undefined ? String(body.state) : phone.state;
  if (['new', 'ok', 'no'].indexOf(state) === -1) return json({ error: 'Unknown state.' }, 400);
  var confirming = state === 'ok' && phone.state !== 'ok';
  if (confirming && !(await ledgerReady(db))) return json({ error: LEDGER_BEHIND }, 503);
  var settled = false;
  if (confirming) {
    var moved = await db.prepare("UPDATE payphones SET name = ?2, state = 'ok' WHERE id = ?1 AND state != 'ok'").bind(phone.id, name).run();
    settled = !!(moved.meta && moved.meta.changes);
    if (!settled) await db.prepare('UPDATE payphones SET name = ?2 WHERE id = ?1').bind(phone.id, name).run();
  } else {
    await db.prepare('UPDATE payphones SET name = ?2, state = ?3 WHERE id = ?1').bind(phone.id, name, state).run();
  }
  phone.name = name; phone.state = state;
  var recorded = 0;
  if (settled) {
    var set = await phoneSettings(db);
    if (set.code) recorded = await settleWaiting(env, ctx, set.code, phone);
  }
  await logAction(db, session.name, 'phone-payphone', name || phone.number, state + (recorded ? ', ' + recorded + ' recorded' : ''), 0, 0, 0);
  var out = await summary(db);
  out.recorded = recorded;
  return json(out);
}

// POST phone/pin {team_id}: a new PIN for one team.
export async function phonePinNew(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var team = await env.DB.prepare('SELECT id, name FROM teams WHERE id = ?1').bind(Number(body.team_id) || 0).first<{ id: number; name: string }>();
  if (!team) return json({ error: 'No such team.' }, 404);
  await pinFor(env.DB, team.id, true);
  await logAction(env.DB, session.name, 'phone-pin', team.name, '-', 0, 0, 0);
  return json(await summary(env.DB));
}

// POST phone/tree {tree}, or {reset: true} for the one capture step.
// The next call hears it.
export async function phoneTreeSave(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  if (body.reset) {
    await db.prepare("DELETE FROM site_text WHERE name = 'phone_tree'").run();
    await logAction(db, session.name, 'phone-tree', 'reset', '-', 0, 0, 0);
    return json(await summary(db));
  }
  var read = cleanTree(body.tree);
  if ('error' in read) return json({ error: read.error }, 400);
  await setText(db, 'phone_tree', JSON.stringify(read.tree)).run();
  await logAction(db, session.name, 'phone-tree', Object.keys(read.tree.nodes).length + ' steps', read.tree.start, 0, 0, 0);
  return json(await summary(db));
}

// GET phone/message?id=: one message's audio.
export async function phoneMessageAudio(request: Request, env: Env, url: URL): Promise<Response> {
  var row = await env.DB.prepare('SELECT r2_key FROM phone_messages WHERE id = ?1')
    .bind(Number(url.searchParams.get('id')) || 0).first<{ r2_key: string }>();
  var served = row ? await serveStoredFile(env.SUBMIT, request, row.r2_key, 'private, no-store') : null;
  return served || json({ error: 'No such message.' }, 404);
}

// POST phone/message/heard {id, heard} and phone/message/delete {id}.
export async function phoneMessageHeard(env: Env, body: JsonBody): Promise<Response> {
  await env.DB.prepare('UPDATE phone_messages SET heard = ?2 WHERE id = ?1').bind(Number(body.id) || 0, body.heard ? 1 : 0).run();
  return json(await summary(env.DB));
}
export async function phoneMessageDelete(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var row = await db.prepare('SELECT m.id, m.r2_key, COALESCE(t.name, \'\') AS team FROM phone_messages m LEFT JOIN teams t ON t.id = m.team_id WHERE m.id = ?1')
    .bind(Number(body.id) || 0).first<{ id: number; r2_key: string; team: string }>();
  if (!row) return json({ error: 'No such message.' }, 404);
  await db.prepare('DELETE FROM phone_messages WHERE id = ?1').bind(row.id).run();
  await env.SUBMIT.delete(row.r2_key);
  await logAction(db, session.name, 'phone-message-delete', row.team || '-', '-', 0, 0, 0);
  return json(await summary(db));
}

// A deleted team's PIN and captures, for the delete's batch.
export function forgetPhoneTeam(db: D1Database, teamId: number): D1PreparedStatement[] {
  return [
    db.prepare('DELETE FROM phone_captures WHERE team_id = ?1').bind(teamId),
    db.prepare('DELETE FROM phone_pins WHERE team_id = ?1').bind(teamId)
  ];
}
