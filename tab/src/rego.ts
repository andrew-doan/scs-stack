// Team registration — the site's /rego page posts here, once, for the
// whole team. One accepted signup: creates the team on the tab,
// records every person (zID, email, dietary, Discord, Arc), registers
// each of them with the check-in worker for a QR, emails each member
// their QR from the unmonitored address, and (when a webhook is
// configured) appends the rows to the organisers' Google Sheet.
//
// The endpoint is public by nature, so it defends itself: everything
// re-validated server-side, a honeypot field, per-IP and global
// hourly rate limits, zID dedupe (except z0000000, the shared
// not-a-UNSW-student marker), and team names checked against the tab.

import { sendEmail, emailConfigured, escapeHtml } from './email.ts';
import * as E from './email-html.ts';
import { corsJson as json, json as plainJson, cleanText, configured, b64url, randomKey, utcStamp, settingValue, setSetting, drain, PERSON_SHOWN, NEXT_TEAM_ID, uniqueClash, prop, fields, emailsHeld, emailOffRefusal } from './shared.ts';
import { renameTeamDiscord, discordApi, guildRows, moveMemberTeam } from './discord.ts';
import { unb64url } from './webpush.ts';
import { personalRemoved } from './privacy.ts';
import type { EmailMessageIn } from './email.ts';
import type { ConsoleSession, Ctx, Env, JsonBody, LogAction, ParticipantRow, RegistrationRow, TeamRow } from './types.ts';

// What the confirmation email and the ticket read of a person. The
// dashboard's test send hands in only the first four.
interface EmailPerson {
  name: string;
  email: string | null;
  position: number;
  qr_url: string | null;
  // the check-in token, when check-in has just handed it over
  checkin_token?: string | null;
  terms_key?: string | null;
  terms_at?: string | null;
}
type Lead = Pick<EmailPerson, 'name'>;
type TicketHolder = Pick<EmailPerson, 'name' | 'qr_url' | 'checkin_token'>;

// One person on a signup: a stored row, or one cleaned from a form
// (cleanMember) and given its id once it is stored.
interface Member extends EmailPerson {
  id?: number;
  zid: string;
  arc: number;
  dietary: string | null;
  discord: string | null;
  email_status: string | null;
  terms_key: string | null;
  terms_at: string | null;
}

// A stored person, with the token check-in handed back when there is one.
type Person = ParticipantRow & { checkin_token?: string | null };

interface RegoEmailOpts {
  banner?: string;
  demo?: boolean;
  placed?: boolean;
  moved?: boolean;
}

// What the check-in worker answered for one person's code.
type QrOutcome = { qr_url: string; token: string | null; note?: undefined } | { note: string; qr_url?: undefined; token?: undefined };

// A person's new name or team, as the check-in worker's /api/rename takes it.
interface RenameEntry {
  participant_id: number | null;
  name: string;
  team_name: string;
  was_name: string;
  was_team: string;
}
type RenameOutcome = { updated: number; missed: unknown[]; note?: undefined } | { note: string };

// One person in the check-in worker's roster (its /api/status). A
// check-in worker from before the hidden flag sends none.
interface RosterPerson {
  participant_id?: number | null;
  name: string;
  team_name: string;
  zid?: string;
  email?: string;
  hidden?: number | boolean;
  checked_in_at?: string | null;
}
// One team in the same roster: how many of its people are in, and when
// the last of them arrived once all are.
interface RosterTeam {
  team_name: string;
  size: number;
  checked_in: number;
  complete: boolean;
  completed_at: string | null;
}
export interface Roster {
  ok: boolean;
  people: number;
  people_checked_in: number;
  people_list?: RosterPerson[];
  team_list?: RosterTeam[];
}

type TermsPerson = Pick<ParticipantRow, 'id' | 'name' | 'terms_at'> & Pick<RegistrationRow, 'team_name'> & { photo_ok?: number | null };
type SheetReg = Pick<RegistrationRow, 'submitted_at' | 'team_name' | 'societies' | 'photo_permission' | 'questions'>;
type SheetMember = Pick<Member, 'position' | 'name' | 'zid' | 'email' | 'arc' | 'dietary' | 'discord'>;

interface CleanOpts {
  requireEmail?: boolean;
  noUnsw?: boolean;
  quiet?: boolean;
  skipId?: number;
}

// A whole team to write down (registerTeam), its people already cleaned.
interface RegisterOpts {
  teamName: string;
  members: Member[];
  societies: string;
  questions: string;
  photoPermission: number;
  ipHash: string | null;
  actor: string;
  guarded?: boolean;
  solo?: boolean;
  // the most people signed up the form allows (rego_cap), 0 for none
  cap?: number;
}
interface Registered {
  capped?: boolean;
  // the name went to another team in the same moment, in another case
  taken?: boolean;
  teamId: number | null;
  regId: number;
  members: number;
  emails: number;
  qrs: number;
  leadTerms: string;
}

// A signup as the Rego tab lists it, its people under it.
type RegPerson = Pick<ParticipantRow, 'id' | 'registration_id' | 'position' | 'name' | 'zid' | 'email' | 'arc' | 'dietary' |
  'discord' | 'qr_url' | 'email_status' | 'terms_at'> &
  { terms_key?: string | null; photo_ok?: number | null; checked_in_at?: string | null; ticket_url?: string; terms_url?: string };
type RegListing = Pick<RegistrationRow, 'id' | 'team_id' | 'team_name' | 'societies' | 'photo_permission' | 'questions' | 'submitted_at'> &
  { hidden?: number; members: RegPerson[]; solo?: number };

// A person as the hidden-flag sync matches them against the roster.
type SyncRow = Pick<ParticipantRow, 'id' | 'name' | 'zid' | 'email'> & { team_name: string | null; hidden: number };

type Size = { n: number; last: number };

export var SOCIETIES = [
  'WestSoc', 'WanderSoc', 'PuzzleSoc', 'Asian Studies Association',
  'PhotoSoc', 'RailSoc', 'Rhythm Games Society', 'Tabletop Games Society',
  'Queer Students in STEM', 'GeoGuessrSoc', 'Chess Club'
];

// The societies picked, joined the way they are stored, or why not: one
// this list does not hold is refused by name, so a page whose list has
// drifted from this one is found out rather than losing the pick.
function pickSocieties(list: unknown[]): { societies: string } | { unknown: string } {
  var picked: string[] = [];
  for (var i = 0; i < list.length; i++) {
    var s = cleanText(list[i], 60);
    if (!s) continue;
    if (SOCIETIES.indexOf(s) === -1) return { unknown: '"' + s + '" is not one of the societies on the form.' };
    if (picked.indexOf(s) === -1) picked.push(s);
  }
  return { societies: picked.join('; ') };
}

var MAX_MEMBERS = 5;               // a rule of the event, held on the public form
var MIN_MEMBERS = 3;               // the same rule, on the public form
var MAX_TEAM = 10;                 // the most the dashboard puts in one team, for a team that asks
var MAX_SOLO = 2;                  // without a team: on your own or as a pair
// What check-in, the ticket and the sheet call the team of somebody who
// signed up without one, until the organisers place them.
// A registration without a team is one with no team row and an empty
// name, which no team ever has: team_name is required everywhere else.
export var NO_TEAM = 'No team yet';
function teamLabel(name: string | null | undefined): string { return name || NO_TEAM; }
function isSolo(reg: Pick<RegistrationRow, 'team_id' | 'team_name'> | null | undefined): boolean { return !!reg && !reg.team_id && !reg.team_name; }
var ALERT_SIGNUPS_HOUR = 10;       // signups in an hour worth a line to the organisers

// The four limits the Rego tab can change, with what they ship as. All
// four were written for signups that trickle in, and society signups do
// not trickle — a link in an announcement or a stall at a market day
// puts a month of them in one hour, and past the limit real teams are
// turned away (or worse, registered with no ticket email, which fails
// quietly). They are settings so that can be fixed from a phone rather
// than from a deploy.
export var REGO_LIMITS: Record<string, number> = {
  rego_per_hour: 15,          // teams from everyone, rolling hour
  rego_per_ip_hour: 4,        // teams from one connection — campus wifi is one connection
  rego_email_per_hour: 60,    // confirmation emails the public form may send in an hour
  rego_email_per_day: 3       // confirmations one address may draw in a day
};

async function limit(db: D1Database, name: string): Promise<number> {
  return settingValue(db, name, REGO_LIMITS[name]);
}
var NO_STORE = { 'cache-control': 'no-store' };
var EVENT_DATE = 'Tuesday 20 October';
// check-in opens, and where (the ticket page and the info page say the same)
var EVENT_WHEN = '9:15am, ' + EVENT_DATE;
var EVENT_PLACE = 'Keith Burrows Theatre, UNSW Kensington';
var SITE_URL = 'https://scs.andyrew.space';
export var ORG_EMAIL = 'westsocunsw@gmail.com';
var DISCORD_INVITE = 'https://discord.gg/7XcsRgvaAU';

function cleanZid(value: unknown): string {
  var z = String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '');
  if (/^\d{7}$/.test(z)) z = 'z' + z;
  return /^z\d{7}$/.test(z) ? z : '';
}

function unswEmail(email: string | null | undefined): boolean {
  var domain = String(email || '').split('@').pop() as string;
  return domain === 'unsw.edu.au' || /\.unsw\.edu\.au$/.test(domain);
}

function cleanEmail(value: unknown): string {
  var e = String(value == null ? '' : value).trim().toLowerCase();
  return e.length <= 120 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

// ---------- the sign-up guard ----------
// Two dashboard settings ride the site_flags table: rego_closed (the
// by-hand switch) and rego_cap (the form closes on its own once this
// many people are signed up; 0 = no cap). rego_alerted holds the
// once-an-hour gate on the Discord alert. A read that fails falls back
// to open.

var guardValue = settingValue;
var setGuardValue = setSetting;

// everyone who is not a test; test teams and test signups do not take
// spots
export async function peopleSignedUp(db: D1Database): Promise<number> {
  var row = await db.prepare(
    'SELECT COUNT(*) AS n FROM participants p LEFT JOIN teams t ON t.id = p.team_id ' +
    'LEFT JOIN registrations r ON r.id = p.registration_id WHERE ' + PERSON_SHOWN
  ).first<{ n: number }>() as { n: number };
  return row.n;
}

// why the form is not taking signups right now, or '' while it is.
// The Discord link preview asks it too, to know whether to offer Sign up.
export async function guardClosed(db: D1Database): Promise<string> {
  if (await guardValue(db, 'rego_closed', 0)) return 'Registrations are closed.';
  var cap = await guardValue(db, 'rego_cap', 0);
  if (cap > 0 && (await peopleSignedUp(db)) >= cap) return 'Registrations are full.';
  return '';
}

// ---------- the human check (Cloudflare Turnstile) ----------
// On only while both TURNSTILE secrets are set: the status read hands
// the page the site key, the page renders the widget, and the token it
// earns is checked here against Cloudflare. With either secret unset
// the check stands down, so the form works before the keys exist.

export function turnstileSiteKey(env: Env): string {
  return configured(env.TURNSTILE_SECRET) && configured(env.TURNSTILE_SITE_KEY)
    ? String(env.TURNSTILE_SITE_KEY) : '';
}

export async function turnstileOk(env: Env, request: Request, token: unknown): Promise<boolean> {
  if (!turnstileSiteKey(env)) return true;
  if (!token) return false;
  try {
    var resp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: token,
        remoteip: request.headers.get('cf-connecting-ip') || undefined
      })
    });
    var data = await resp.json();
    return !!prop(data, 'success');
  } catch (err) {
    // Cloudflare's verify endpoint unreachable: let people register
    // rather than lock the form on the day
    return true;
  }
}

// ---------- telling the organisers ----------
// One line into every enabled server's announce channel when signups
// spike or a limit trips — at most one an hour whatever fires it, so
// a flood cannot flood Discord too.

async function alertOrganisers(env: Env, db: D1Database, text: string): Promise<void> {
  try {
    if (!configured(env.DISCORD_BOT_TOKEN)) return;
    var now = Math.floor(Date.now() / 1000);
    if (now - (await guardValue(db, 'rego_alerted', 0)) < 3600) return;
    await setGuardValue(db, 'rego_alerted', now);
    var guilds = await guildRows(db, env);
    var targets = guilds.filter(function (g) { return g.enabled && g.announce_channel_id; });
    for (var i = 0; i < targets.length; i++) {
      await discordApi(env, 'POST', '/channels/' + targets[i].announce_channel_id + '/messages', {
        content: '**Sign-ups:** ' + text, allowed_mentions: { parse: [] }
      });
    }
  } catch (err) { /* the alert is a bonus, never the failure */ }
}

async function hashIp(request: Request): Promise<string> {
  var ip = request.headers.get('cf-connecting-ip') || 'unknown';
  var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('scs2-rego:' + ip));
  var arr = new Uint8Array(digest).slice(0, 16);
  var hex = '';
  for (var i = 0; i < arr.length; i++) hex += (arr[i] + 256).toString(16).slice(1);
  return hex;
}

// One attempt to mint a person's QR through the check-in worker.
// Returns { qr_url } on success, { note } saying exactly what went
// wrong otherwise — the console surfaces the note, so a wrong URL or
// mismatched key is a readable message instead of a silent gap.
async function fetchQr(env: Env, member: Pick<Member, 'id' | 'name' | 'email' | 'zid'>, teamName: string): Promise<QrOutcome> {
  if (!configured(env.CHECKIN_KEY) || !configured(env.CHECKIN_API)) {
    return { note: 'check-in is not connected: set CHECKIN_API in wrangler.toml and the CHECKIN_KEY secret, then redeploy' };
  }
  // the check-in worker registers people by email address and refuses a
  // signup without one. The public form always has an email; a person
  // added from the dashboard need not, so say what is missing instead
  // of forwarding "that email address does not look right".
  if (!member.email) {
    return { note: 'no email address on file, and check-in needs one to make a code' };
  }
  // tolerate a pasted URL with a trailing slash — '//api/register'
  // would miss the check-in worker's router
  var base = String(env.CHECKIN_API).replace(/\/+$/, '');
  if (base.indexOf('https://') !== 0) {
    return { note: 'CHECKIN_API must start with https:// (it is "' + base + '")' };
  }
  try {
    var resp = await fetch(base + '/api/register', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.CHECKIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        name: member.name, email: member.email, team_name: teamName, zid: member.zid,
        // participants.id, the only thing about this person that a
        // dashboard edit cannot change — check-in stores it and finds
        // them by it afterwards. registerTeam writes the rows first, so
        // a new team's people have one; a person added in the dashboard
        // does not yet (regoPersonSave asks before the INSERT), their
        // check-in row is written without one, and the next call
        // carries it — Create QR code, Send email and a rename all work
        // from the stored row — and check-in fills it in then.
        participant_id: Number(member.id) > 0 ? Number(member.id) : null
      })
    });
    var data: { qr_url?: string; token?: unknown; error?: unknown } | null = null;
    try { data = await resp.json(); } catch (err) { /* not JSON */ }
    if (data && data.qr_url) {
      var token = cleanText(data.token, 64);
      return { qr_url: data.qr_url, token: /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : null };
    }
    return { note: 'the check-in worker answered ' + resp.status + (data && data.error ? ': ' + data.error : '') +
      ' (check CHECKIN_API points at it and CHECKIN_KEY matches its REGISTRATION_KEY)' };
  } catch (err) {
    return { note: 'could not reach the check-in worker at ' + base };
  }
}

// The other half of sharing the id: pushing a new name to the check-in
// worker so its row keeps matching the person at the door. Same
// defensive shape as fetchQr — it never throws, and a failure comes
// back as a note rather than an exception.
async function pushRename(env: Env, people: RenameEntry[] | null | undefined): Promise<RenameOutcome> {
  if (!people || !people.length) return { updated: 0, missed: [] };
  if (!configured(env.CHECKIN_KEY) || !configured(env.CHECKIN_API)) {
    return { note: 'check-in is not connected: set CHECKIN_API in wrangler.toml and the CHECKIN_KEY secret, then redeploy' };
  }
  var base = String(env.CHECKIN_API).replace(/\/+$/, '');
  if (base.indexOf('https://') !== 0) {
    return { note: 'CHECKIN_API must start with https:// (it is "' + base + '")' };
  }
  try {
    var resp = await fetch(base + '/api/rename', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + env.CHECKIN_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ people: people })
    });
    var data: { ok?: unknown; updated?: unknown; missed?: unknown[]; error?: unknown } | null = null;
    try { data = await resp.json(); } catch (err) { /* not JSON */ }
    if (data && data.ok) return { updated: Number(data.updated) || 0, missed: data.missed || [] };
    return { note: 'the check-in worker answered ' + resp.status + (data && data.error ? ': ' + data.error : '') };
  } catch (err) {
    return { note: 'could not reach the check-in worker at ' + base };
  }
}

// Renames go out in the background, like the sheet resync: a slow or
// unreachable check-in worker must never hold up a save, or fail one.
function renameLater(env: Env, ctx: Ctx, people: RenameEntry[]): void {
  if (!people || !people.length) return;
  var work = pushRename(env, people).catch(function () {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
}

// A whole team's new name: one entry per person on it, each still under
// the name check-in has, so rows written before the shared id existed
// are found too. Both renames use this — the Rego tab's team editor and
// the Teams tab's rename.
export function renameCheckinTeam(env: Env, ctx: Ctx, people: Pick<ParticipantRow, 'id' | 'name'>[] | null | undefined, wasTeam: string, teamName: string): void {
  renameLater(env, ctx, (people || []).map(function (p) {
    return { participant_id: p.id, name: p.name, team_name: teamName, was_name: p.name, was_team: wasTeam };
  }));
}

// What the check-in reports left on the tab, kept under the team's name,
// goes with the team to its new one: the team page reads both by name.
// A row already under the new name is from an older team of that name
// and is replaced.
export async function moveTeamCheckins(db: D1Database, wasTeam: string, teamName: string): Promise<void> {
  if (!wasTeam || wasTeam === teamName) return;
  var tables = ['team_checkins', 'team_arrivals'];
  for (var i = 0; i < tables.length; i++) {
    await db.prepare('UPDATE OR REPLACE ' + tables[i] + ' SET team_name = ?2 WHERE team_name = ?1 COLLATE NOCASE')
      .bind(wasTeam, teamName).run();
  }
}

// ---------- the confirmation email ----------

// The ticket page on the site shows the QR large with the person's
// name and team. The link carries one base64url blob. When the
// check-in token is in hand it is packed raw — a version byte of 2,
// the token's length, its bytes, then "name\nteam" in UTF-8 — and the
// page rebuilds the QR itself (the code encodes scs2:<token>), no
// image fetch at all. Without the token the older text form (the QR
// image's file name, name, team, one per line) is used and the page
// fetches the image through this worker (GET /api/ticket/qr). The
// first byte tells them apart: 2 is never the first byte of the text
// form, whose first character is a base64url letter of the key.
export function qrKey(qrUrl: string | null | undefined): string {
  var m = String(qrUrl || '').match(/\/qr\/([A-Za-z0-9_-]+)\.png(?:[?#].*)?$/);
  return m ? m[1] : '';
}
export function ticketToken(member: TicketHolder, teamName: string): string {
  if (member.checkin_token) {
    var raw = unb64url(member.checkin_token);
    var meta = new TextEncoder().encode(member.name + '\n' + teamName);
    var bytes = new Uint8Array(2 + raw.length + meta.length);
    bytes[0] = 2;
    bytes[1] = raw.length;
    bytes.set(raw, 2);
    bytes.set(meta, 2 + raw.length);
    return b64url(bytes);
  }
  return b64url(new TextEncoder().encode(qrKey(member.qr_url) + '\n' + member.name + '\n' + teamName));
}
export function ticketUrl(member: TicketHolder, teamName: string): string {
  return SITE_URL + '/ticket/?' + ticketToken(member, teamName);
}
// The dashboard opens a person's ticket in a new tab, so the worker
// hands it a finished link rather than the page rebuilding the blob.
// Nobody without a code gets one: '' means no button.
function ticketFor(member: TicketHolder | null | undefined, teamName: string): string {
  return member && member.qr_url ? ticketUrl(member, teamName) : '';
}

// The code the test ticket email carries. The check-in worker draws it
// on the spot from a fixed string and stores nothing, so a test send
// does not put a person who does not exist on the board. It is served
// like any other code image — public on its name — so the picture loads
// in an inbox the same way a real one does, and the ticket page's
// fallback (/api/ticket/qr?k=demo) resolves to the same image.
// '' when the check-in worker is not connected; the email then says the
// code is coming separately, which is what a real one does too.
export function demoQrUrl(env: Env): string {
  return configured(env.CHECKIN_API)
    ? String(env.CHECKIN_API).replace(/\/+$/, '') + '/qr/demo.png' : '';
}

// the QR image by its key, streamed from the check-in worker; the key
// is the capability, so nothing else is checked
async function serveTicketQr(env: Env, url: URL): Promise<Response> {
  var key = String(url.searchParams.get('k') || '');
  if (!/^[A-Za-z0-9_-]{4,80}$/.test(key)) return plainJson({ error: 'bad key' }, 400);
  if (!configured(env.CHECKIN_API)) return plainJson({ error: 'check-in is not connected' }, 503);
  var base = String(env.CHECKIN_API).replace(/\/+$/, '');
  var resp;
  try {
    resp = await fetch(base + '/qr/' + key + '.png');
  } catch (err) {
    return plainJson({ error: 'could not reach the check-in worker' }, 502);
  }
  if (!resp.ok) return plainJson({ error: 'no such ticket' }, 404);
  return new Response(resp.body, {
    status: 200,
    headers: {
      'content-type': resp.headers.get('content-type') || 'image/png',
      'cache-control': 'public, max-age=31536000, immutable',
      'access-control-allow-origin': '*'
    }
  });
}

// ---------- the terms and waiver ----------
// Nobody accepts them for anybody else. Each person's confirmation email
// carries a link with their own key; the terms page shows the terms and
// who the link is for, and accepting stamps terms_at on that person's
// row. The key is the whole capability, the same as a ticket's. Keys
// made here are base64url and the ones the migration gave to earlier
// signups are hex, so the check takes both.
var TERMS_KEY = /^[A-Za-z0-9_-]{20,64}$/;

export function termsUrl(member: Pick<EmailPerson, 'terms_key'> | null | undefined): string {
  return member && member.terms_key ? SITE_URL + '/terms/?k=' + member.terms_key : '';
}

// A row written before the column existed, or by hand, has no key; it
// gets one the first time an email is about to go to that person.
async function ensureTermsKey(db: D1Database, member: Pick<Member, 'id' | 'terms_key'>): Promise<string | null> {
  if (member.terms_key) return member.terms_key;
  await db.prepare('UPDATE participants SET terms_key = ?2 WHERE id = ?1 AND terms_key IS NULL')
    .bind(member.id, randomKey(18)).run();
  var row = await db.prepare('SELECT terms_key FROM participants WHERE id = ?1').bind(member.id).first<Pick<ParticipantRow, 'terms_key'>>();
  member.terms_key = row ? row.terms_key : null;
  return member.terms_key;
}

// photo_ok is each person's own answer to the photo question, given on
// the terms page.
function findByTermsKey(db: D1Database, key: string): Promise<TermsPerson | null> {
  return db.prepare(
    'SELECT p.id, p.name, p.terms_at, p.photo_ok, r.team_name FROM participants p ' +
    'JOIN registrations r ON r.id = p.registration_id WHERE p.terms_key = ?1'
  ).bind(key).first<TermsPerson>();
}

// GET ?k= says who the link is for, whether they have accepted and what
// they said about photos; POST {k, photo} accepts and records the
// answer. Accepting twice keeps the first time. {k, photo, accept:
// false} changes the answer alone, so it can be changed after accepting
// without a change before accepting counting as accepting.
async function handleTerms(request: Request, env: Env, url: URL): Promise<Response> {
  var given: unknown;
  var body: Record<string, unknown> = {};
  if (request.method === 'GET') {
    given = url.searchParams.get('k');
  } else if (request.method === 'POST') {
    try { body = fields(await request.json()); } catch (err) { return json({ error: 'body must be JSON' }, 400, NO_STORE); }
    given = body.k;
  } else {
    return json({ error: 'not found' }, 404);
  }
  var key = String(given || '');
  if (!TERMS_KEY.test(key)) {
    return json({ error: 'This link is not complete. Open it again from your confirmation email.' }, 400, NO_STORE);
  }
  var db = env.DB;
  var person = await findByTermsKey(db, key);
  if (!person) {
    return json({ error: 'This link does not match anyone who is registered. Email ' + ORG_EMAIL + ' if you think it should.' }, 404, NO_STORE);
  }
  if (request.method === 'POST') {
    var photo = typeof body.photo === 'boolean' ? (body.photo ? 1 : 0) : null;
    if (photo !== null && person.photo_ok !== photo) {
      await db.batch([
        db.prepare('UPDATE participants SET photo_ok = ?2 WHERE id = ?1').bind(person.id, photo),
        db.prepare(
          'INSERT INTO submission_log (action, team_name, quest_code, points_delta, old_total, new_total, actor) ' +
          "VALUES (?3, ?1, ?2, 0, 0, 0, 'rego:terms')"
        ).bind(person.team_name, person.name, photo ? 'rego-photo-yes' : 'rego-photo-no')
      ]);
    }
    if (body.accept !== false && !person.terms_at) {
      var claim = await db.prepare('UPDATE participants SET terms_at = ?2 WHERE id = ?1 AND terms_at IS NULL')
        .bind(person.id, utcStamp()).run();
      if (Number(claim.meta && claim.meta.changes)) {
        await db.prepare(
          'INSERT INTO submission_log (action, team_name, quest_code, points_delta, old_total, new_total, actor) ' +
          "VALUES ('rego-terms', ?1, ?2, 0, 0, 0, 'rego:terms')"
        ).bind(person.team_name, person.name).run();
      }
    }
    // found a moment ago
    person = await findByTermsKey(db, key) as TermsPerson;
  }
  return json({
    ok: true, name: person.name, team: teamLabel(person.team_name), accepted_at: person.terms_at || null,
    photo: person.photo_ok == null ? null : !!person.photo_ok
  }, 200, NO_STORE);
}

// The confirmation, in the site's signage. The look lives in
// email-html.ts; what is here is what the message says.
//
// opts.banner hangs a picture across the top. Nothing on the public
// path passes one — it is the dashboard's second test send, and the
// note on that card says why it is a test and not the real thing.
// opts.demo is every test send: the terms link has no person behind it.
// Only a person with an address is sent one, so `to` is always one.
export function regoEmail(member: EmailPerson, lead: Lead, teamName: string, opts?: RegoEmailOpts): EmailMessageIn {
  var o = opts || {};
  var first = member.name.split(' ')[0];
  // '' is somebody who signed up without a team and has not been placed.
  // Their email is the same message with nothing added to say so: no
  // team row, no line about being placed. The ticket at the bottom says
  // No team yet, and that is where they see it.
  var placed = !!teamName;
  var byLine = !placed
    ? (member.position === 1 ? '' : lead.name + ' signed you up and gave this email address for you.')
    : member.position === 1
      ? 'You registered the team, so this is your copy.'
      : lead.name + ' signed your team up and gave this email address for you.';
  if (placed && o.placed) {
    byLine = 'You have been assigned to team ' + teamName + '. Please get in contact with each other on Discord, ' +
      'where you have been given a private team channel, to decide on a new team name!';
  }
  if (placed && o.moved) byLine = 'You have been moved to team ' + teamName + '.';
  var ticket = member.qr_url ? ticketUrl(member, teamLabel(teamName)) : '';
  // a test send has nobody to accept for, so its link is the terms alone
  var terms = o.demo ? SITE_URL + '/terms/' : termsUrl(member);

  var subject = !placed ? "You're In! You are registered for SCS.2"
    : o.placed || o.moved ? "You're In! You are on team " + teamName + ' for SCS.2'
      : "You're In! Team " + teamName + ' is registered for SCS.2';

  // The details, then the parts of the message one after another with a
  // hairline between each and the same gap either side of it, so the
  // spacing is one number. The parts are set in the middle of the
  // column, each sentence over its button or the ticket. A part ends on its button or on a paragraph
  // with no margin under it. The details end on a hairline of their own,
  // so the first part only takes the gap.
  var GAP = 24;
  var body =
    E.paragraph('Hi ' + escapeHtml(first) + ',') +
    E.paragraph('You are registered for the Sydney Challenge Scramble.' + (byLine ? ' ' + escapeHtml(byLine) : '')) +
    E.gap(6) +
    E.details([
      placed ? ['Team', escapeHtml(teamName), 'team'] : null,
      ['Date', EVENT_WHEN, 'date'],
      ['Location', EVENT_PLACE, 'place']
    ]);

  var parts = [];
  // Everyone accepts the terms for themselves, from this link, so it
  // comes before the code: it is the one thing in here to do.
  if (terms && !member.terms_at) {
    parts.push(
      E.paragraph('<strong>Make sure to read the terms and waiver and accept them before the event. ' +
        'You will not be allowed to take part if this is not done.</strong>', { center: true }) +
      E.button(terms, 'Read and accept the terms', 'dark'));
  } else if (terms) {
    parts.push(E.paragraph('You have accepted the ' + E.link(terms, 'terms and waiver') + '.', { end: true, center: true }));
  }

  // The code, its button and the note under them are one column at the
  // card's width, the way the ticket page ends on its note.
  if (member.qr_url) {
    parts.push(
      E.paragraph('Your check-in QR code.', { center: true }) +
      E.ticketCard({ src: member.qr_url, name: member.name, team: teamLabel(teamName) }) +
      E.gap(12) +
      E.button(ticket, 'Open your ticket', false, { wide: true }) +
      E.gap(12) +
      E.note('phone', 'Please have this open at check-in on the day.'));
  } else {
    parts.push(E.paragraph('Your check-in QR code will come in a separate email.', { end: true, center: true }));
  }

  parts.push(
    E.paragraph('Make sure to join the SCS.2 Discord server and visit the SCS.2 website for further&nbsp;details.', { center: true }) +
    E.buttonRow([
      E.button(DISCORD_INVITE, 'SCS.2 Discord', 'line', { fill: true, icon: 'discord' }),
      E.button(SITE_URL, 'SCS.2 Website', 'line', { fill: true, icon: 'web' })
    ]));

  body += E.gap(GAP) + parts.join(E.gap(GAP) + E.rule() + E.gap(GAP));

  var footer = E.paragraph(
    'Questions? Email ' + E.link('mailto:' + ORG_EMAIL, ORG_EMAIL) + '.',
    { size: 13, colour: E.INK.muted });

  var html = E.shell({
    heading: 'Legends of the City',
    title: subject,
    preheader: (placed ? teamName + ' is in. ' : 'You are in. ') + EVENT_WHEN + ', ' + EVENT_PLACE + '.',
    banner: o.banner ? { src: o.banner, alt: 'SCS.2', href: SITE_URL } : null,
    body: body,
    footer: footer
  });

  var text = 'Hi ' + first + ',\n\n' +
    'You are registered for the Sydney Challenge Scramble.' + (byLine ? ' ' + byLine : '') + '\n\n' +
    (placed ? 'Team: ' + teamName + '\n' : '') +
    'Date: ' + EVENT_WHEN + '\n' +
    'Location: ' + EVENT_PLACE + '\n\n' +
    (terms && !member.terms_at ? 'Make sure to read the terms and waiver and accept them before the event. ' +
      'You will not be allowed to take part if this is not done: ' + terms + '\n\n' : '') +
    (terms && member.terms_at ? 'You have accepted the terms and waiver: ' + terms + '\n\n' : '') +
    (member.qr_url ? 'Your check-in QR code. Please have this open at check-in on the day: ' + ticket + '\n\n' : '') +
    'Make sure to join the SCS.2 Discord server and visit the SCS.2 website for further details.\n' +
    'Discord: ' + DISCORD_INVITE + '\n' +
    'Website: ' + SITE_URL + '\n\n' +
    'Questions? Email ' + ORG_EMAIL + '.\n';
  return {
    to: member.email as string,
    subject: subject,
    html: html,
    text: text
  };
}

// ---------- Google Sheet webhook ----------

export var SHEET_HEADER = [
  'Submitted (UTC)', 'Team', '#', 'Name', 'zID', 'Email', 'Arc member',
  'Dietary', 'Discord', 'Societies', 'Photo permission', 'Questions'
];

// Everything here was typed into a public form, and a spreadsheet reads
// a cell starting = + - or @ as a formula: a dietary note of
// =HYPERLINK(…) would be a live link in the organisers' sheet. An
// apostrophe in front makes it text in Google Sheets (which hides the
// apostrophe) and in Excel. Both the sheet and the CSV export go
// through this.
export function inert(value: unknown): unknown {
  return typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
}

function sheetRow(reg: SheetReg, member: SheetMember): unknown[] {
  var lead = member.position === 1;
  return [
    reg.submitted_at, teamLabel(reg.team_name), member.position, member.name, member.zid,
    member.email || '', member.arc ? 'Yes' : 'No', member.dietary || '',
    member.discord || '', lead ? (reg.societies || '') : '',
    lead ? (reg.photo_permission ? 'Yes' : 'No') : '',
    lead ? (reg.questions || '') : ''
  ].map(inert);
}

// What came back from the sheet's script, in words an organiser can act
// on. Apps Script answers 200 whatever happened, so the body is the
// verdict: its own 'ok' or 'no', 'error: …' from the script in the
// README, or a Google page when the script never ran or crashed.
export function sheetTrouble(status: number, text: string): string {
  var body = String(text || '');
  if (status === 404) {
    return 'There is no web app at the sheet\'s address. The deployment was removed, or SHEETS_WEBHOOK_URL has the wrong address.';
  }
  if (body === 'no') {
    return 'The sheet\'s script refused the token: the token at the end of SHEETS_WEBHOOK_URL is not the TOKEN in the script.';
  }
  if (/accounts\.google\.com|ServiceLogin/.test(body)) {
    return 'Google asked for a sign-in. The web app\'s access has to be Anyone.';
  }
  var said = /^error: ([\s\S]+)/.exec(body);
  if (said) return 'The sheet\'s script failed: ' + said[1].trim().slice(0, 200);
  var page = /(?:TypeError|ReferenceError|SyntaxError|Exception|Script function not found)[^<]{0,200}/.exec(body);
  if (page) return 'The sheet\'s script failed: ' + page[0].replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  return 'The sheet answered ' + status + ' without saying ok.';
}

// One push to the sheet: {ok} or {ok: false, why}. Apps Script runs the
// script on the POST and hands the answer back behind a redirect, which
// is asked for here with a GET rather than left to the runtime's
// redirect rules, so the answer is the script's whatever those do with
// a POST. A script that has not answered in 50 seconds is reported as
// slow rather than left hanging.
async function sheetPush(env: Env, mode: string, rows: unknown[][]): Promise<{ ok: boolean; skipped?: boolean; why?: string }> {
  if (!configured(env.SHEETS_WEBHOOK_URL)) return { ok: false, skipped: true, why: 'No sheet webhook is configured (SHEETS_WEBHOOK_URL).' };
  var signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(50000) : undefined;
  try {
    var resp = await fetch(env.SHEETS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: mode, header: SHEET_HEADER, rows: rows }),
      redirect: 'manual',
      signal: signal
    });
    var next = resp.status >= 300 && resp.status < 400 && resp.headers.get('location');
    if (next) {
      await drain(resp);
      resp = await fetch(new URL(next, env.SHEETS_WEBHOOK_URL).href, { signal: signal });
    }
    var text = '';
    try { text = (await resp.text()).trim(); } catch (err) { /* unreadable */ }
    if (resp.ok && text === 'ok') return { ok: true };
    return { ok: false, why: sheetTrouble(resp.status, text) };
  } catch (err) {
    var slow = err && (prop(err, 'name') === 'TimeoutError' || prop(err, 'name') === 'AbortError');
    return { ok: false, why: slow
      ? 'The sheet\'s script took longer than 50 seconds to answer. The script in the worker\'s README writes every row in one go.'
      : 'The sheet\'s address could not be reached.' };
  }
}

async function postToSheet(env: Env, mode: string, rows: unknown[][]): Promise<string> {
  var r = await sheetPush(env, mode, rows);
  return r.ok ? 'sent' : r.skipped ? 'skipped' : 'failed';
}

// ---------- one team's signup, from the site or the dashboard ----------

// Cleans one person's fields. Resolves {member} or {error}. Duplicate
// zIDs are checked against every other signup (z0000000, the shared
// not-at-UNSW marker, never dedupes); `skipId` is the person being
// edited, whose own row must not count as a clash.
async function cleanMember(db: D1Database, raw: Record<string, unknown>, pos: number, seenZids: Record<string, boolean>, opts: CleanOpts): Promise<{ member: Member } | { error: string }> {
  raw = raw || {};
  var name = cleanText(raw.name, 80);
  var zid = cleanZid(raw.zid);
  var email = cleanEmail(raw.email);
  if (!name) return { error: 'Member ' + pos + ' needs a full name.' };
  if (!zid) return { error: name + "'s zID should be z followed by seven digits (z0000000 if not at UNSW)." };
  if (!email && (opts.requireEmail || cleanText(raw.email, 120))) return { error: name + "'s email address does not look right." };
  // The public form takes no UNSW address, and says so on the field.
  // Only there: an organiser editing someone already signed up with one
  // must not be stopped from saving their dietary needs over it.
  if (opts.noUnsw && unswEmail(email)) return { error: name + "'s email is a UNSW address. Use a different one." };
  if (zid !== 'z0000000') {
    if (seenZids[zid]) return { error: zid + ' appears twice in this team.' };
    seenZids[zid] = true;
    var known = await db.prepare(
      'SELECT p.id, r.team_name FROM participants p JOIN registrations r ON r.id = p.registration_id WHERE p.zid = ?1 AND p.id != ?2'
    ).bind(zid, opts.skipId || 0).first<{ id: number; team_name: string }>();
    // the public form does not say which team: that would tell anyone
    // who types a student number where that student signed up
    if (known) {
      return { error: opts.quiet
        ? zid + ' is already registered. If that is wrong, email ' + ORG_EMAIL + '.'
        : zid + ' is already registered' + (known.team_name ? ' with team "' + known.team_name + '"' : ', without a team yet') + '.' };
    }
  }
  return { member: {
    position: pos,
    name: name,
    zid: zid,
    email: email,
    arc: raw.arc ? 1 : 0,
    dietary: cleanText(raw.dietary, 200),
    discord: cleanText(raw.discord, 60).replace(/^@+/, ''),
    qr_url: null,
    checkin_token: null,
    email_status: null,
    // used only when this person is being added: an edit never
    // touches the key already on their row
    terms_key: randomKey(18),
    terms_at: null
  } };
}

// Writes a whole team down: the team on the tab, the registration,
// every person, the log line — one transaction — and then each
// person's QR and confirmation email, and the sheet rows. `members` are
// already cleaned.
//
// The rows go in before anything leaves the worker. Written the other
// way round, a failure part way left the team name taken with nobody on
// it, emails sent for people who were never stored, and a retry refused
// because the name was gone. Now a failed write leaves nothing, and once
// the rows are in, a QR or an email that does not come off is what the
// scheduled sweep (regoRetryTick) is there to finish.
async function registerTeam(env: Env, ctx: Ctx, opts: RegisterOpts): Promise<Registered> {
  var db = env.DB;
  var members = opts.members;
  // A batch runs whole with nothing between its statements, so the team
  // and registration just inserted are found by name. Without a team
  // (opts.solo, one or two people waiting to be placed) there is no team
  // row and the registration is simply the newest one.
  var solo = !!opts.solo;
  // With a cap, the registration, team and first person all check the
  // same headcount before any person goes in, and every further person
  // and the log entry select from that first person's freshly minted
  // terms_key — so a batch that misses the cap inserts nothing at all.
  var cap = Math.max(0, Math.round(Number(opts.cap) || 0));
  if (members.length && !members[0].terms_key) members[0].terms_key = randomKey(18);
  var anchorKey = members.length ? (members[0].terms_key as string) : '';
  function fits(): string {
    if (!cap) return '';
    return ' WHERE (SELECT COUNT(*) FROM participants p LEFT JOIN teams t ON t.id = p.team_id ' +
      'LEFT JOIN registrations r ON r.id = p.registration_id WHERE ' + PERSON_SHOWN + ') + ' + members.length + ' <= ' + cap;
  }
  function statements(): D1PreparedStatement[] {
    var stmts = solo ? [
      db.prepare(
        'INSERT INTO registrations (team_id, team_name, societies, photo_permission, questions, ip_hash) ' +
        "SELECT NULL, '', ?1, ?2, ?3, ?4" + fits()
      ).bind(opts.societies || null, opts.photoPermission ? 1 : 0, opts.questions || null, opts.ipHash || null)
    ] : [
      db.prepare('INSERT INTO teams (id, name) SELECT ' + NEXT_TEAM_ID + ', ?1' + fits()).bind(opts.teamName),
      db.prepare(
        'INSERT INTO registrations (team_id, team_name, societies, photo_permission, questions, ip_hash) ' +
        'SELECT (SELECT id FROM teams WHERE name = ?1), ?1, ?2, ?3, ?4, ?5' + fits()
      ).bind(opts.teamName, opts.societies || null, opts.photoPermission ? 1 : 0, opts.questions || null, opts.ipHash || null)
    ];
    members.forEach(function (member, k) {
      if (k === 0) {
        stmts.push(solo ? db.prepare(
          'INSERT INTO participants (registration_id, team_id, position, name, zid, email, arc, dietary, discord, terms_key) ' +
          'SELECT (SELECT MAX(id) FROM registrations), NULL, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8' + fits()
        ).bind(member.position, member.name, member.zid, member.email || null,
          member.arc, member.dietary || null, member.discord || null, member.terms_key) : db.prepare(
          'INSERT INTO participants (registration_id, team_id, position, name, zid, email, arc, dietary, discord, terms_key) ' +
          'SELECT (SELECT MAX(id) FROM registrations WHERE team_name = ?1), (SELECT id FROM teams WHERE name = ?1), ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9' + fits()
        ).bind(opts.teamName, member.position, member.name, member.zid, member.email || null,
          member.arc, member.dietary || null, member.discord || null, member.terms_key));
      } else {
        stmts.push(db.prepare(
          'INSERT INTO participants (registration_id, team_id, position, name, zid, email, arc, dietary, discord, terms_key) ' +
          'SELECT p0.registration_id, p0.team_id, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 FROM participants p0 WHERE p0.terms_key = ?9'
        ).bind(member.position, member.name, member.zid, member.email || null,
          member.arc, member.dietary || null, member.discord || null, member.terms_key, anchorKey));
      }
    });
    stmts.push(anchorKey ? db.prepare(
      'INSERT INTO submission_log (action, team_name, quest_code, points_delta, old_total, new_total, actor) ' +
      'SELECT ?4, ?1, ?2, 0, 0, 0, ?3 FROM participants p0 WHERE p0.terms_key = ?5'
    ).bind(teamLabel(opts.teamName), members.length + (members.length === 1 ? ' member' : ' members'), opts.actor || 'rego:public',
      solo ? 'solo-register' : 'team-register', anchorKey) : db.prepare(
      'INSERT INTO submission_log (action, team_name, quest_code, points_delta, old_total, new_total, actor) ' +
      'SELECT ?4, ?1, ?2, 0, 0, 0, ?3' + fits()
    ).bind(teamLabel(opts.teamName), members.length + (members.length === 1 ? ' member' : ' members'), opts.actor || 'rego:public',
      solo ? 'solo-register' : 'team-register'));
    return stmts;
  }
  var done: D1Result[];
  try {
    done = await db.batch(statements());
  } catch (err) {
    // the one unique index the batch can meet is the team's name
    if (solo || !uniqueClash(err)) throw err;
    return { taken: true, teamId: null, regId: 0, members: 0, emails: 0, qrs: 0, leadTerms: '' };
  }
  if (cap && !(done[0].meta && done[0].meta.changes)) {
    return { capped: true, teamId: null, regId: 0, members: 0, emails: 0, qrs: 0, leadTerms: '' };
  }
  var teamId = solo ? null : done[0].meta && done[0].meta.last_row_id;
  var regId = (solo ? done[0] : done[1]).meta.last_row_id;
  // every person has an id now, which check-in stores beside its own row
  (await db.prepare('SELECT id, position FROM participants WHERE registration_id = ?1').bind(regId).all<Pick<ParticipantRow, 'id' | 'position'>>())
    .results.forEach(function (row) {
      members.forEach(function (member) { if (member.position === row.position) member.id = row.id; });
    });

  // On the public form (guarded) the confirmation emails are capped:
  // one address can only draw a few a day whatever signups carry it,
  // and the form as a whole has an hourly ceiling. A capped email is
  // recorded as skipped, which the dashboard's Rego tab can resend —
  // a real one is delayed, never lost. Console adds are not capped.
  var hourSent = 0;
  var perHour = await limit(db, 'rego_email_per_hour');
  var perDay = await limit(db, 'rego_email_per_day');
  if (opts.guarded) {
    hourSent = (await db.prepare(
      'SELECT COUNT(*) AS n FROM participants p JOIN registrations r ON r.id = p.registration_id ' +
      "WHERE p.email_status = 'sent' AND r.submitted_at > datetime('now', '-1 hour')"
    ).first<{ n: number }>() as { n: number }).n;
  }
  async function emailAllowed(member: Member, emailedHere: number): Promise<boolean> {
    if (!opts.guarded) return true;
    if (hourSent + emailedHere >= perHour) return false;
    // this team's earlier members are counted here too: each one's
    // status is written as soon as their email has gone
    var toAddress = (await db.prepare(
      'SELECT COUNT(*) AS n FROM participants p JOIN registrations r ON r.id = p.registration_id ' +
      "WHERE p.email = ?1 AND p.email_status = 'sent' AND r.submitted_at > datetime('now', '-1 day')"
    ).bind(member.email).first<{ n: number }>() as { n: number }).n;
    return toAddress < perDay;
  }

  var emailed = 0;
  var qrs = 0;
  // email off on the Settings tab: the signup goes through and each
  // confirmation is recorded 'held', for the sweep to send once it is on
  var held = await emailsHeld(db);
  for (var m = 0; m < members.length; m++) {
    var member = members[m];
    var minted = await fetchQr(env, member, teamLabel(opts.teamName));
    if (minted.qr_url) { member.qr_url = minted.qr_url; member.checkin_token = minted.token || null; qrs++; }
    member.email_status = member.email && held ? 'held'
      : member.email && (await emailAllowed(member, emailed))
        ? await sendEmail(env, regoEmail(member, members[0], opts.teamName)) : 'skipped';
    if (member.email_status === 'sent') emailed++;
    await db.prepare('UPDATE participants SET qr_url = ?2, email_status = ?3 WHERE id = ?1')
      .bind(member.id, member.qr_url, member.email_status).run();
  }

  if (configured(env.SHEETS_WEBHOOK_URL)) {
    var regRow: SheetReg = { submitted_at: new Date().toISOString().slice(0, 19).replace('T', ' '), team_name: opts.teamName,
      societies: opts.societies, photo_permission: opts.photoPermission ? 1 : 0, questions: opts.questions };
    var rows = members.map(function (member) { return sheetRow(regRow, member); });
    var push = postToSheet(env, 'append', rows);
    if (ctx && ctx.waitUntil) ctx.waitUntil(push); else await push;
  }
  return { teamId: teamId, regId: regId, members: members.length, emails: emailed, qrs: qrs,
    leadTerms: termsUrl(members[0]) };
}

// ---------- the public endpoint ----------

// The answer to a signup the cap has no room for.
function noRoom(left: number, solo: boolean, people: number): Response {
  left = Math.max(0, left);
  return json({ error: 'There ' + (left === 1 ? 'is 1 place' : 'are ' + left + ' places') +
    ' left and this ' + (solo ? 'signup' : 'team') + ' has ' + people + (people === 1 ? ' person' : ' people') +
    '. Email ' + ORG_EMAIL + ' with any questions.' }, 403);
}

export async function handleRegoApi(request: Request, env: Env, ctx: Ctx, url: URL): Promise<Response | null> {
  if (url.pathname === '/api/ticket/qr' && request.method === 'GET') return serveTicketQr(env, url);
  if (url.pathname === '/api/rego/terms') return handleTerms(request, env, url);
  // the rego page asks this at load: whether the form is taking
  // signups, and the Turnstile site key when the human check is on
  if (url.pathname === '/api/rego/status' && request.method === 'GET') {
    var why = await guardClosed(env.DB);
    return json({ ok: true, open: !why, message: why, turnstile: why ? '' : turnstileSiteKey(env) }, 200, NO_STORE);
  }
  if (url.pathname !== '/api/rego/create') return null;
  if (request.method !== 'POST') return json({ error: 'not found' }, 404);
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }

  // the honeypot: a hidden field people never see. Bots that fill it
  // get an ok and nothing happens.
  if (cleanText(body.website, 60)) return json({ ok: true, team: cleanText(body.team_name, 40) });

  // closed by hand, or full against the cap
  var shut = await guardClosed(env.DB);
  if (shut) {
    if (shut === 'Registrations are full.' && ctx && ctx.waitUntil) {
      ctx.waitUntil(alertOrganisers(env, env.DB, 'the signup cap is reached and the form is turning teams away.'));
    }
    return json({ error: shut + ' Email ' + ORG_EMAIL + ' with any questions.' }, 403);
  }

  var ip = await hashIp(request);
  var counts = await env.DB.prepare(
    'SELECT COUNT(*) AS everyone, SUM(ip_hash = ?1) AS mine FROM registrations ' +
    "WHERE submitted_at > datetime('now', '-1 hour')"
  ).bind(ip).first<{ everyone: number; mine: number | null }>() as { everyone: number; mine: number | null };
  var perIp = await limit(env.DB, 'rego_per_ip_hour');
  var perAll = await limit(env.DB, 'rego_per_hour');
  if (Number(counts.mine) >= perIp) {
    return json({ error: 'Too many signups from this connection. Try again in an hour, or email ' + ORG_EMAIL + '.' }, 429);
  }
  if (counts.everyone >= perAll) {
    if (ctx && ctx.waitUntil) {
      ctx.waitUntil(alertOrganisers(env, env.DB, 'the hourly signup cap (' + perAll + ') tripped. The form is turning teams away for the rest of the hour. Raise it on the Rego tab if this is a real rush.'));
    }
    return json({ error: 'Too many signups right now. Try again in a few minutes.' }, 429);
  }

  // the human check, once the cheap checks are passed
  if (!(await turnstileOk(env, request, cleanText(body.turnstile, 4096)))) {
    return json({ error: 'The check that you are a person did not pass. Reload the page and try again.' }, 403);
  }

  // ---- team ----
  // Without one (solo): one person, or two who want to stay together,
  // for the organisers to put in a team. No name to check.
  var solo = body.solo === true;
  var teamName = solo ? '' : cleanText(body.team_name, 40);
  var nameTaken = 'A team called "' + teamName + '" is already registered. Pick another name.';
  if (!solo) {
    if (!teamName) return json({ error: 'Your team needs a name.' }, 400);
    var reserved = reservedTeamName(teamName);
    if (reserved) return json({ error: reserved }, 400);
    var taken = await env.DB.prepare('SELECT id FROM teams WHERE name = ?1 COLLATE NOCASE').bind(teamName).first();
    if (taken) return json({ error: nameTaken }, 409);
  }

  // ---- members ----
  var filled = (Array.isArray(body.members) ? body.members : []).filter(function (m) {
    return m && (cleanText(prop(m, 'name'), 80) || cleanText(prop(m, 'zid'), 20) || cleanText(prop(m, 'email'), 120));
  }).length;
  if (solo && filled > MAX_SOLO) {
    return json({ error: 'Without a team is one or two people. Three or more can sign up as a team.' }, 400);
  }
  if (!solo && filled > MAX_MEMBERS) {
    return json({ error: 'A team is at most ' + MAX_MEMBERS + ' people.' }, 400);
  }
  var rawMembers = Array.isArray(body.members) ? body.members : [];
  var members: Member[] = [];
  var seenZids: Record<string, boolean> = {};
  for (var i = 0; i < rawMembers.length; i++) {
    var raw = fields(rawMembers[i]);
    // an untouched trailing section is simply not a member
    if (!cleanText(raw.name, 80) && !cleanText(raw.zid, 20) && !cleanText(raw.email, 120)) continue;
    var cleaned = await cleanMember(env.DB, raw, members.length + 1, seenZids, { requireEmail: true, noUnsw: true, quiet: true });
    if ('error' in cleaned) return json({ error: cleaned.error }, cleaned.error.indexOf('already registered') !== -1 ? 409 : 400);
    members.push(cleaned.member);
  }
  // the event's rule, which the page also holds; the dashboard can still
  // make a team bigger, up to MAX_TEAM, for a team that asks
  if (solo && !members.length) return json({ error: 'Fill in your details.' }, 400);
  if (!solo && members.length < MIN_MEMBERS) return json({ error: 'A team needs at least three people.' }, 400);
  if (!members[0].discord) return json({ error: 'The person registering needs a Discord username.' }, 400);
  // the cap counts people, so the whole team has to fit, not only its
  // first person
  var cap = await guardValue(env.DB, 'rego_cap', 0);
  if (cap > 0) {
    var left = cap - (await peopleSignedUp(env.DB));
    if (members.length > left) return noRoom(left, solo, members.length);
  }

  var socs = pickSocieties(Array.isArray(body.societies) ? body.societies : []);
  if ('unknown' in socs) return json({ error: socs.unknown }, 400);
  var questions = cleanText(body.questions, 1000);
  var photoPermission = body.photo_permission ? 1 : 0;

  var made = await registerTeam(env, ctx, {
    teamName: teamName, members: members, societies: socs.societies, questions: questions,
    photoPermission: photoPermission, ipHash: ip, actor: 'rego:public', guarded: true, solo: solo, cap: cap
  });
  // the same name in another case, sent at the same moment
  if (made.taken) return json({ error: nameTaken }, 409);
  // another signup took the last places while this one was being read
  if (made.capped) return noRoom(cap - (await peopleSignedUp(env.DB)), solo, members.length);

  // worth a line to the organisers: a busy hour, or this signup
  // reached the cap and closed the form behind itself
  if (ctx && ctx.waitUntil) {
    var busyHour = counts.everyone + 1 >= ALERT_SIGNUPS_HOUR;
    ctx.waitUntil((async function () {
      var cap = await guardValue(env.DB, 'rego_cap', 0);
      if (cap > 0 && (await peopleSignedUp(env.DB)) >= cap) {
        await alertOrganisers(env, env.DB, 'the signup cap (' + cap + ' people) is reached. The form has closed itself.');
      } else if (busyHour) {
        await alertOrganisers(env, env.DB, (counts.everyone + 1) + ' teams signed up in the past hour.');
      }
    })());
  }
  // the person who filled the form is the first member, so their own
  // terms link goes back to them; everyone else's is only in their email
  return json({ ok: true, team: teamName, solo: solo, members: made.members, emails: made.emails, qrs: made.qrs,
    terms_url: made.leadTerms });
}

// ---------- console side (session checks live in console.ts) ----------

// the Rego tab's Sign-ups card: the switch, the cap and where the
// count stands, plus whether the human check is on
export async function regoSettings(env: Env): Promise<Response> {
  var db = env.DB;
  var limits: Record<string, number> = {};
  var names = Object.keys(REGO_LIMITS);
  for (var i = 0; i < names.length; i++) limits[names[i]] = await limit(db, names[i]);
  return plainJson({
    ok: true,
    closed: !!(await guardValue(db, 'rego_closed', 0)),
    cap: await guardValue(db, 'rego_cap', 0),
    people: await peopleSignedUp(db),
    turnstile: !!turnstileSiteKey(env),
    limits: limits,
    defaults: REGO_LIMITS
  });
}

export async function regoSettingsSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var cap = Number(body.cap);
  if (!isFinite(cap) || cap < 0 || cap !== Math.round(cap) || cap > 100000) {
    return plainJson({ error: 'The cap must be a whole number of people, or zero for none.' }, 400);
  }
  // A limit that reads as zero turns everybody away, so zero is not a
  // value here: a limit left out keeps what it had, and one that is
  // sent has to be a whole number of at least one.
  var sent = (body.limits && typeof body.limits === 'object' ? body.limits : {}) as Record<string, unknown>;
  var names = Object.keys(REGO_LIMITS);
  var writes: [string, number][] = [];
  for (var i = 0; i < names.length; i++) {
    if (!(names[i] in sent)) continue;
    var n = Number(sent[names[i]]);
    if (!isFinite(n) || n < 1 || n !== Math.round(n) || n > 100000) {
      return plainJson({ error: 'Every limit must be a whole number from 1 to 100000.' }, 400);
    }
    writes.push([names[i], n]);
  }
  var closed = body.closed === true || body.closed === 1 || body.closed === '1';
  await setGuardValue(env.DB, 'rego_closed', closed ? 1 : 0);
  await setGuardValue(env.DB, 'rego_cap', cap);
  for (var k = 0; k < writes.length; k++) await setGuardValue(env.DB, writes[k][0], writes[k][1]);
  await logAction(env.DB, session.name, 'rego-settings',
    (closed ? 'closed' : 'open') + ', cap ' + (cap || 'none') +
    (writes.length ? ', ' + writes.map(function (w) { return w[0] + ' ' + w[1]; }).join(', ') : ''),
    '-', 0, 0, 0);
  return regoSettings(env);
}

async function allRows(env: Env): Promise<RegListing[]> {
  // each signup's people are put under it below
  var regs = await env.DB.prepare(
    'SELECT id, team_id, team_name, societies, photo_permission, questions, submitted_at, hidden FROM registrations ORDER BY id'
  ).all<RegListing>();
  var people = await env.DB.prepare(
    'SELECT id, registration_id, position, name, zid, email, arc, dietary, discord, qr_url, email_status, terms_key, terms_at, photo_ok ' +
    'FROM participants ORDER BY registration_id, position'
  ).all<RegPerson>();
  var byReg: Record<number, RegListing> = {};
  regs.results.forEach(function (r) { r.members = []; byReg[r.id] = r; });
  people.results.forEach(function (p) { if (byReg[p.registration_id]) byReg[p.registration_id].members.push(p); });
  return regs.results;
}

// Who has checked in, from the check-in worker (its /api/status with
// the registration key). Best effort: unreachable means no marks.
export async function checkinStatus(env: Env): Promise<Roster | null> {
  if (!configured(env.CHECKIN_KEY) || !configured(env.CHECKIN_API)) return null;
  var base = String(env.CHECKIN_API).replace(/\/+$/, '');
  try {
    var resp = await Promise.race([
      fetch(base + '/api/status', { headers: { authorization: 'Bearer ' + env.CHECKIN_KEY } }),
      new Promise<null>(function (resolve) { setTimeout(function () { resolve(null); }, 2500); })
    ]);
    if (!resp || !resp.ok) return null;
    var data = await resp.json<Roster | null>();
    return data && data.ok ? data : null;
  } catch (err) {
    return null;
  }
}

// ---------- test people at the door ----------
// A name as the check-in worker stores it: its cleanText also drops
// <>&"'` — compared any other way, every read would rename again.
export function checkinName(value: unknown): string {
  return cleanText(String(value == null ? '' : value).replace(/[<>&"'`]/g, ''), 80);
}

// A team name the tab will not take, or ''. NO_TEAM is what check-in and
// the terms page call everyone not yet placed, so a team of that name
// would be merged with all of them at the door.
export function reservedTeamName(name: string): string {
  return checkinName(name).toLowerCase() === NO_TEAM.toLowerCase()
    ? '"' + NO_TEAM + '" is what check-in calls people without a team. Pick another name.' : '';
}

type CheckinTeam = Pick<TeamRow, 'id' | 'name' | 'hidden'>;

// The tab's team for a name check-in reported, out of `teams`, or null.
// Check-in stores names without <>&"'`, so the tab's are compared the
// way it would store them, ignoring case; the tab's own spelling, when
// one matches it outright, comes first.
function pickCheckinTeam(teams: CheckinTeam[], reported: string): CheckinTeam | null {
  var want = checkinName(reported).toLowerCase();
  if (!want) return null;
  var exact = teams.filter(function (t) { return t.name.toLowerCase() === want; })[0];
  return exact || teams.filter(function (t) { return checkinName(t.name).toLowerCase() === want; })[0] || null;
}

export async function teamForCheckin(db: D1Database, reported: string): Promise<CheckinTeam | null> {
  var exact = await db.prepare('SELECT id, name, hidden FROM teams WHERE name = ?1 COLLATE NOCASE')
    .bind(reported).first<CheckinTeam>();
  if (exact) return exact;
  var teams = (await db.prepare('SELECT id, name, hidden FROM teams ORDER BY id').all<CheckinTeam>()).results;
  return pickCheckinTeam(teams, reported);
}

// A team check-in says is all in that the tab has no completion for: its
// report was lost (check-in sends each once, and a wrong TAB_SYNC_KEY
// drops them all). Recorded under the tab's name from the roster read
// that is being made anyway. A row already there is left as it is, so
// running it again changes nothing. Never throws.
export async function reconcileCheckins(db: D1Database, roster: Roster | null): Promise<number> {
  try {
    var complete = (roster && Array.isArray(roster.team_list) ? roster.team_list : []).filter(function (t) {
      return t && t.complete && t.completed_at && t.team_name;
    });
    if (!complete.length) return 0;
    var have: Record<string, boolean> = {};
    (await db.prepare('SELECT team_name FROM team_checkins').all<{ team_name: string }>()).results.forEach(function (r) {
      have[String(r.team_name).toLowerCase()] = true;
    });
    var teams = (await db.prepare('SELECT id, name, hidden FROM teams ORDER BY id').all<CheckinTeam>()).results;
    var stmts: D1PreparedStatement[] = [];
    complete.forEach(function (t) {
      var team = pickCheckinTeam(teams, t.team_name);
      if (!team || have[team.name.toLowerCase()]) return;
      have[team.name.toLowerCase()] = true;
      stmts.push(db.prepare(
        'INSERT INTO team_checkins (team_name, completed_at, people) VALUES (?1, ?2, ?3) ON CONFLICT(team_name) DO NOTHING'
      ).bind(team.name, String(t.completed_at).slice(0, 32), Math.max(0, Math.min(1000, Math.round(Number(t.size) || 0)))));
    });
    if (stmts.length) await db.batch(stmts);
    return stmts.length;
  } catch (err) {
    return 0;
  }
}

// The same, after the answer: the day board and the Rego tab both read
// the roster, and neither waits for this.
export function reconcileCheckinsLater(env: Env, ctx: Ctx, roster: Roster | null): void {
  var work = reconcileCheckins(env.DB, roster);
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
}

// A test person (a hidden team, or a hidden signup with no team — see
// PERSON_SHOWN) is kept off the check-in board, out of the scanner's
// list and out of its counts, and their code checks nobody in. The
// check-in worker holds a hidden flag per person for that; this sets
// every flag that differs from what the tab says. It runs after a team
// or a signup is hidden or shown, and whenever the dashboard reads the
// check-in roster, so a change made while that worker was away is put
// right the next time it answers. A row still under a name or team the
// tab has since changed, or with no shared id, is renamed to match at
// the same time. Never throws.
export async function syncCheckinHidden(env: Env, roster?: Roster | null): Promise<{ sent: number; renamed: number }> {
  try {
    if (!configured(env.CHECKIN_KEY) || !configured(env.CHECKIN_API)) return { sent: 0, renamed: 0 };
    if (!roster) roster = await checkinStatus(env);
    var list = roster && Array.isArray(roster.people_list) ? roster.people_list : [];
    var rows = (await env.DB.prepare(
      'SELECT p.id, p.name, p.zid, p.email, r.team_name AS team_name, CASE WHEN ' + PERSON_SHOWN + ' THEN 0 ELSE 1 END AS hidden ' +
      'FROM participants p LEFT JOIN teams t ON t.id = p.team_id LEFT JOIN registrations r ON r.id = p.registration_id'
    ).all<SyncRow>()).results;
    // Four ways to find a person in the roster, surest first: the shared
    // id, the name and team check-in has, the zID (not the shared
    // z0000000) and the email. The last two find a row written before
    // either side kept the id and left behind by a rename from before
    // renames were sent across, which matches nothing else.
    var byId: Record<number, SyncRow> = {};
    var byName: Record<string, SyncRow> = {};
    var byZid: Record<string, SyncRow | null> = {};
    var byEmail: Record<string, SyncRow | null> = {};
    function once(map: Record<string, SyncRow | null>, key: string, p: SyncRow): void {
      if (!key) return;
      map[key] = map[key] === undefined ? p : null; // two people on one key match neither
    }
    rows.forEach(function (p) {
      byId[p.id] = p;
      byName[checkinName(teamLabel(p.team_name)).toLowerCase() + '|' + checkinName(p.name).toLowerCase()] = p;
      if (p.zid && p.zid !== 'z0000000') once(byZid, String(p.zid).toLowerCase(), p);
      once(byEmail, String(p.email || '').trim().toLowerCase(), p);
    });
    // which roster row already carries each shared id: check-in finds a
    // rename by the id first, so a second row given it would never be
    // found again
    var owner: Record<number, RosterPerson> = {};
    list.forEach(function (c) { if (c.participant_id) owner[Number(c.participant_id)] = c; });
    var renames: RenameEntry[] = [];
    var fixes: { participant_id: number | null; name: string; team_name: string; hidden: number }[] = [];
    list.forEach(function (c) {
      var p = (c.participant_id && byId[c.participant_id]) ||
        byName[String(c.team_name).toLowerCase() + '|' + String(c.name).toLowerCase()] ||
        (c.zid && c.zid !== 'z0000000' && byZid[String(c.zid).toLowerCase()]) ||
        (c.email && byEmail[String(c.email).trim().toLowerCase()]) || null;
      if (!p) return;
      // a check-in worker from before the flag sends none: nothing to set.
      // The flag is sent with the row's own id, name and team, so it finds
      // this row whatever the rename below does.
      if ('hidden' in c && (c.hidden ? 1 : 0) !== Number(p.hidden)) {
        fixes.push({ participant_id: c.participant_id || null, name: c.name, team_name: c.team_name, hidden: Number(p.hidden) });
      }
      // a row behind the tab — an old name, an old team, no shared id —
      // is brought up to date, unless another row is this person's already
      var name = checkinName(p.name);
      var team = checkinName(teamLabel(p.team_name));
      var mine = Number(c.participant_id) === Number(p.id);
      if (!mine && owner[p.id] && owner[p.id] !== c) return;
      if (mine && c.name === name && c.team_name === team) return;
      owner[p.id] = c;
      renames.push({ participant_id: p.id, name: name, team_name: team, was_name: c.name, was_team: c.team_name });
    });
    var base = String(env.CHECKIN_API).replace(/\/+$/, '');
    for (var i = 0; i < fixes.length; i += 200) {
      await fetch(base + '/api/hide', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + env.CHECKIN_KEY, 'content-type': 'application/json' },
        body: JSON.stringify({ people: fixes.slice(i, i + 200) })
      });
    }
    for (var r = 0; r < renames.length; r += 200) await pushRename(env, renames.slice(r, r + 200));
    return { sent: fixes.length, renamed: renames.length };
  } catch (err) {
    return { sent: 0, renamed: 0 };
  }
}

export function syncCheckinHiddenLater(env: Env, ctx: Ctx, roster?: Roster | null): Promise<{ sent: number; renamed: number }> {
  var work = syncCheckinHidden(env, roster);
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
  return work;
}

export async function regoOverview(env: Env, ctx: Ctx): Promise<Response> {
  var regs = await allRows(env);
  regs.forEach(function (r) { r.solo = isSolo(r) ? 1 : 0; });
  var checkin = await checkinStatus(env);
  if (checkin) {
    syncCheckinHiddenLater(env, ctx, checkin);
    reconcileCheckinsLater(env, ctx, checkin);
  }
  // Two ways to find a person in the check-in roster. The shared
  // participants.id is the one that survives a rename; the name and
  // team still cover a row written before that column existed.
  var checkedIn: Record<string, string> = {};
  var checkedInById: Record<number, string> = {};
  if (checkin && Array.isArray(checkin.people_list)) {
    checkin.people_list.forEach(function (p) {
      if (!p.checked_in_at) return;
      if (p.participant_id) checkedInById[p.participant_id] = p.checked_in_at;
      checkedIn[String(p.team_name).toLowerCase() + '|' + String(p.name).toLowerCase()] = p.checked_in_at;
    });
  }
  var people = 0;
  var dietary: Record<string, number> = {};
  regs.forEach(function (r) {
    r.members.forEach(function (m) {
      m.checked_in_at = checkedInById[m.id] ||
        checkedIn[teamLabel(r.team_name).toLowerCase() + '|' + String(m.name).toLowerCase()] || null;
      m.ticket_url = ticketFor(m, teamLabel(r.team_name));
      // the link rather than the key: an organiser passes it on as it is
      m.terms_url = termsUrl(m);
      delete m.terms_key;
      people++;
      String(m.dietary || '').split(';').forEach(function (d) {
        d = d.trim();
        if (d) dietary[d] = (dietary[d] || 0) + 1;
      });
    });
  });
  var placedTeams = regs.filter(function (r) { return !r.solo; }).length;
  return json({ ok: true, teams: placedTeams, people: people, dietary: dietary, registrations: regs, checkin_live: !!checkin, max_team: MAX_TEAM,
    email_off: await emailsHeld(env.DB) });
}

function csvCell(value: unknown): string {
  var text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

export async function regoCsv(env: Env): Promise<Response> {
  var regs = await allRows(env);
  var lines = [SHEET_HEADER.concat(['QR', 'Email status', 'Terms accepted (UTC)', 'Own photo answer']).map(csvCell).join(',')];
  regs.forEach(function (r) {
    r.members.forEach(function (m) {
      var own = m.photo_ok == null ? '' : m.photo_ok ? 'Yes' : 'No';
      lines.push(sheetRow(r, m).concat([m.qr_url || '', m.email_status || '', m.terms_at || '', own]).map(csvCell).join(','));
    });
  });
  return new Response(lines.join('\r\n') + '\r\n', {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="scs2-registrations.csv"',
      'cache-control': 'no-store'
    }
  });
}

// Rewrites the whole sheet — the recovery path when rows were missed
// (webhook down, configured late) or the sheet was edited by hand.
export async function regoResync(env: Env): Promise<Response> {
  if (!configured(env.SHEETS_WEBHOOK_URL)) {
    return json({ error: 'No sheet webhook is configured (SHEETS_WEBHOOK_URL).' }, 403);
  }
  var regs = await allRows(env);
  var rows: unknown[][] = [];
  regs.forEach(function (r) {
    r.members.forEach(function (m) { rows.push(sheetRow(r, m)); });
  });
  var outcome = await sheetPush(env, 'replace', rows);
  if (!outcome.ok) return json({ error: outcome.why }, 502);
  return json({ ok: true, rows: rows.length });
}

// Make one person's QR code and nothing else. Registering again is
// idempotent and hands back the same person, so this is safe to press
// as often as anyone likes.
export async function regoPersonQr(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var member = await db.prepare('SELECT * FROM participants WHERE id = ?1').bind(Number(body.id) || 0).first<Person>();
  if (!member) return json({ error: 'no such person' }, 404);
  var reg = await db.prepare('SELECT team_name FROM registrations WHERE id = ?1').bind(member.registration_id).first<Pick<RegistrationRow, 'team_name'>>();
  var teamName = teamLabel(reg ? reg.team_name : '');
  var minted = await fetchQr(env, member, teamName);
  if (!minted.qr_url) {
    return json({ ok: false, name: member.name, qr: 'missing', qr_note: minted.note,
      error: 'No QR code for ' + member.name + ': ' + minted.note });
  }
  member.qr_url = minted.qr_url;
  member.checkin_token = minted.token || null;
  await db.prepare('UPDATE participants SET qr_url = ?2 WHERE id = ?1').bind(member.id, member.qr_url).run();
  await logAction(db, session.name, 'rego-qr', teamName, member.name, 0, 0, 0);
  return json({ ok: true, name: member.name, qr: 'attached', qr_note: null,
    ticket_url: ticketFor(member, teamName), email_status: member.email_status || '' });
}

// ---------- the scheduled sweep ----------
// A ticket that did not go out used to sit there until the person said
// so at the door. Nothing retried it: the registration had succeeded,
// the row recorded 'skipped' or 'failed', and the only cure was an
// organiser noticing and pressing resend.
//
// This is the cure running on its own. It takes a few rows a tick, in
// registration order, and only ones with a real address: a missing QR
// is minted and a missing email is sent. Every attempt counts up in
// email_tries and stops at MAX_EMAIL_TRIES, because an address that
// will never accept mail must not be tried once a minute for the rest
// of the event. A person the organisers fixed by hand already reads as
// 'sent' and is never picked up.
//
// While email is off on the Settings tab it does nothing at all: no
// email, no code and no try spent, since a code that fails to mint
// spends one too. The confirmations held meanwhile read 'held', which is
// not 'sent', so once email is back on this is what sends them.
var SWEEP_ROWS = 3;           // per tick: each one is two calls to other services
var MAX_EMAIL_TRIES = 5;
var SWEEP_DAYS = 14;          // older than this, nobody is waiting on the email any more

export async function regoRetryTick(env: Env): Promise<{ ran: false; held?: true } | { ran: true; tried: number; fixed: number }> {
  var db = env.DB;
  if (await emailsHeld(db)) return { ran: false, held: true };
  // With email not set up nothing can be sent, so a try spent now would
  // be one the person never had: only missing codes are made, and the
  // tries wait for email to be set up.
  var mail = emailConfigured(env);
  if (!mail && !(configured(env.CHECKIN_KEY) && configured(env.CHECKIN_API))) return { ran: false };
  var rows = (await db.prepare(
    'SELECT p.*, r.team_name FROM participants p JOIN registrations r ON r.id = p.registration_id ' +
    "WHERE p.email IS NOT NULL AND p.email != '' " +
    (mail ? "AND (COALESCE(p.email_status, '') != 'sent' OR COALESCE(p.qr_url, '') = '') "
      : "AND COALESCE(p.qr_url, '') = '' ") +
    'AND COALESCE(p.email_tries, 0) < ?1 ' +
    "AND r.submitted_at > datetime('now', '-' || ?2 || ' days') " +
    // a signup still being sent out is registerTeam's, not the sweep's
    "AND r.submitted_at < datetime('now', '-2 minutes') " +
    'ORDER BY p.id LIMIT ?3'
  ).bind(MAX_EMAIL_TRIES, SWEEP_DAYS, SWEEP_ROWS).all<Person & Pick<RegistrationRow, 'team_name'>>()).results;
  if (!rows.length) return { ran: false };

  var fixed = 0;
  var tried = 0;
  for (var i = 0; i < rows.length; i++) {
    var member = rows[i];
    // The row is claimed before anything is sent: the try is spent only
    // if the row is still as it was read, so a second scheduled run, or
    // a Resend that has finished since, leaves this one alone.
    if (mail) {
      try {
        var claim = await db.prepare(
          'UPDATE participants SET email_tries = COALESCE(email_tries, 0) + 1 WHERE id = ?1 ' +
          "AND COALESCE(email_tries, 0) = ?2 AND COALESCE(email_status, '') = ?3 AND COALESCE(qr_url, '') = ?4"
        ).bind(member.id, Number(member.email_tries) || 0, member.email_status || '', member.qr_url || '').run();
        if (!(claim.meta && claim.meta.changes)) continue;
      } catch (err) { continue; }
    }
    tried++;
    try {
      // registering again is idempotent and hands back the same person,
      // so this fills a missing code without minting a second identity
      var hadCode = !!member.qr_url;
      var minted = await fetchQr(env, member, teamLabel(member.team_name));
      if (minted.qr_url && minted.qr_url !== member.qr_url) {
        member.qr_url = minted.qr_url;
        await db.prepare('UPDATE participants SET qr_url = ?2 WHERE id = ?1')
          .bind(member.id, member.qr_url).run();
      }
      if (member.checkin_token == null) member.checkin_token = minted.token || null;
      if (!mail) {
        // a code that could not be made still counts against the row
        if (!member.qr_url) await spendTry(db, member.id);
        continue;
      }
      // an email with no ticket in it promises a code that is not
      // coming, so a row still without one waits for the next tick. A
      // person whose first email went out without one was told the code
      // would come separately: the confirmation goes again, carrying it.
      if ((String(member.email_status || '') !== 'sent' || !hadCode) && member.qr_url) {
        var lead = await db.prepare(
          'SELECT name FROM participants WHERE registration_id = ?1 ORDER BY position LIMIT 1'
        ).bind(member.registration_id).first<Pick<ParticipantRow, 'name'>>();
        await ensureTermsKey(db, member);
        var status = await sendEmail(env, regoEmail(member, lead || { name: 'Your teammate' }, member.team_name || ''));
        await db.prepare('UPDATE participants SET email_status = ?2 WHERE id = ?1').bind(member.id, status).run();
        if (status === 'sent') fixed++;
        // switched off since the claim: the try goes back
        if (status === 'held') {
          await db.prepare('UPDATE participants SET email_tries = MAX(COALESCE(email_tries, 0) - 1, 0) WHERE id = ?1').bind(member.id).run();
        }
      }
    } catch (err) {
      // one bad row must not stop the sweep; with email set up its try
      // was spent by the claim
      if (!mail) {
        try { await spendTry(db, member.id); } catch (also) { /* nothing left to try */ }
      }
    }
  }
  return { ran: true, tried: tried, fixed: fixed };
}

function spendTry(db: D1Database, id: number): Promise<D1Result> {
  return db.prepare('UPDATE participants SET email_tries = COALESCE(email_tries, 0) + 1 WHERE id = ?1').bind(id).run();
}

// What the Rego tab shows about tickets still outstanding.
export async function ticketsOutstanding(db: D1Database): Promise<number> {
  try {
    var row = await db.prepare(
      'SELECT COUNT(*) AS n FROM participants ' +
      "WHERE email IS NOT NULL AND email != '' " +
      "AND (COALESCE(email_status, '') != 'sent' OR COALESCE(qr_url, '') = '')"
    ).first<{ n: number }>();
    return row ? row.n : 0;
  } catch (err) {
    return 0;
  }
}

// Resend one person's confirmation. The QR is minted first every time:
// registering again is idempotent and hands back the same person, so
// this fills a missing code and, either way, gets the token that makes
// the short self-rendering ticket link.
//
// An email with no ticket in it promises a code that is not coming, so
// it is never sent by accident: without a code the answer is
// `needs_qr` and the dashboard asks whether to send it anyway. `force`
// is that answer. One such email per person is allowed and a second is
// refused, and the claim is a single conditional write so two taps
// cannot both get through.
export async function regoResendEmail(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  if (await emailsHeld(db)) return emailOffRefusal();
  var member = await db.prepare('SELECT * FROM participants WHERE id = ?1').bind(Number(body.id) || 0).first<Person>();
  if (!member) return json({ error: 'no such person' }, 404);
  if (!member.email) return json({ error: member.name + ' has no email address on file.' }, 400);
  // every person has a registration
  var reg = await db.prepare('SELECT team_name FROM registrations WHERE id = ?1').bind(member.registration_id).first<Pick<RegistrationRow, 'team_name'>>() as Pick<RegistrationRow, 'team_name'>;
  var lead = await db.prepare(
    'SELECT name FROM participants WHERE registration_id = ?1 AND position = 1'
  ).bind(member.registration_id).first<Pick<ParticipantRow, 'name'>>();
  var qrNote: string | null | undefined = null;
  var minted = await fetchQr(env, member, teamLabel(reg.team_name));
  if (minted.qr_url) { member.qr_url = minted.qr_url; member.checkin_token = minted.token || null; }
  else if (!member.qr_url) qrNote = minted.note;
  if (!emailConfigured(env)) return json({ error: 'Email is not configured.' }, 403);

  if (!member.qr_url && !body.force) {
    return json({ ok: false, needs_qr: true, name: member.name, qr: 'missing', qr_note: qrNote,
      error: 'No QR code for ' + member.name + ': ' + qrNote });
  }
  if (!member.qr_url) {
    var claim = await db.prepare(
      "UPDATE participants SET email_status = 'sent' WHERE id = ?1 AND qr_url IS NULL AND COALESCE(email_status, '') != 'sent'"
    ).bind(member.id).run();
    if (!Number(claim.meta && claim.meta.changes)) {
      return json({ error: member.name + ' has already had an email without a QR code. '
        + 'Make the code first, then send again.' }, 409);
    }
  }
  await ensureTermsKey(db, member);
  var status = await sendEmail(env, regoEmail(member, lead || { name: 'Your teammate' }, reg.team_name));
  await db.prepare('UPDATE participants SET qr_url = ?2, email_status = ?3 WHERE id = ?1')
    .bind(member.id, member.qr_url, status).run();
  if (!member.qr_url) {
    await logAction(db, session.name, 'rego-email-no-qr', teamLabel(reg.team_name), member.name, 0, 0, 0);
  }
  return json({
    ok: status === 'sent',
    status: status,
    name: member.name,
    qr: member.qr_url ? 'attached' : 'missing',
    qr_note: qrNote,
    ticket_url: ticketFor(member, teamLabel(reg.team_name)),
    sent_without_qr: !member.qr_url
  });
}

// ---------- dashboard edits (session checks live in console.ts) ----------

// After any edit the sheet is rewritten in the background, when a
// webhook is configured; the Resync button covers a failure.
function resyncLater(env: Env, ctx: Ctx): void {
  if (!configured(env.SHEETS_WEBHOOK_URL)) return;
  var work = regoResync(env).catch(function () {});
  if (ctx && ctx.waitUntil) ctx.waitUntil(work);
}

// Team name (which renames the tab team and its Discord role and
// channel), societies, photo permission, questions.
export async function regoTeamSave(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var reg = await db.prepare('SELECT id, team_id, team_name FROM registrations WHERE id = ?1').bind(Number(body.id) || 0).first<Pick<RegistrationRow, 'id' | 'team_id' | 'team_name'>>();
  if (!reg) return plainJson({ error: 'no such registration' }, 404);
  // people without a team get one by being placed (rego/place), not by
  // a name typed here
  var teamName = isSolo(reg) ? '' : cleanText(body.team_name, 40);
  if (!teamName && !isSolo(reg)) return plainJson({ error: 'The team needs a name.' }, 400);
  var socs = pickSocieties(Array.isArray(body.societies) ? body.societies : String(body.societies == null ? '' : body.societies).split(';'));
  if ('unknown' in socs) return plainJson({ error: socs.unknown }, 400);
  var societies = socs.societies;
  var questions = cleanText(body.questions, 1000);
  var photoPermission = body.photo_permission ? 1 : 0;
  var stmts: D1PreparedStatement[] = [];
  var renamed = 0;
  var nameTaken = 'A team called "' + teamName + '" already exists on the tab.';
  if (teamName !== reg.team_name) {
    var reserved = reservedTeamName(teamName);
    if (reserved) return plainJson({ error: reserved }, 400);
    var clash = await db.prepare('SELECT id FROM teams WHERE name = ?1 COLLATE NOCASE AND id != ?2').bind(teamName, reg.team_id || 0).first();
    if (clash) return plainJson({ error: nameTaken }, 409);
    if (reg.team_id) stmts.push(db.prepare('UPDATE teams SET name = ?2 WHERE id = ?1').bind(reg.team_id, teamName));
  }
  stmts.push(db.prepare('UPDATE registrations SET team_name = ?2, societies = ?3, photo_permission = ?4, questions = ?5 WHERE id = ?1')
    .bind(reg.id, teamName, societies || null, photoPermission, questions || null));
  try {
    await db.batch(stmts);
  } catch (err) {
    if (!uniqueClash(err)) throw err;
    return plainJson({ error: nameTaken }, 409);
  }
  if (teamName !== reg.team_name) {
    if (reg.team_id) await moveTeamCheckins(db, reg.team_name, teamName);
    if (reg.team_id) renamed = await renameTeamDiscord(env, reg.team_id, teamName);
    var roster = await db.prepare('SELECT id, name FROM participants WHERE registration_id = ?1').bind(reg.id).all<Pick<ParticipantRow, 'id' | 'name'>>();
    renameCheckinTeam(env, ctx, roster.results, reg.team_name, teamName);
  }
  await logAction(db, session.name, 'rego-team-edit', teamLabel(reg.team_name) + (teamName !== reg.team_name ? ' → ' + teamName : ''), '-', 0, 0, 0);
  resyncLater(env, ctx);
  return plainJson({ ok: true, team_name: teamName, discord_renamed: renamed });
}

// One person: edit in place, or add to a registration (with a QR and
// a confirmation email, like the signup form would have done).
export async function regoPersonSave(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var id = Number(body.id) || 0;
  var existing = id ? await db.prepare('SELECT * FROM participants WHERE id = ?1').bind(id).first<Person>() : null;
  if (id && !existing) return plainJson({ error: 'no such person' }, 404);
  if (existing && await personalRemoved(db)) {
    return plainJson({ error: "The sign-ups' zIDs, emails and dietary needs are off the database. Put them back on the Settings tab before editing someone." }, 409);
  }
  var regId = existing ? existing.registration_id : Number(body.registration_id) || 0;
  var reg = await db.prepare('SELECT id, team_id, team_name FROM registrations WHERE id = ?1').bind(regId).first<Pick<RegistrationRow, 'id' | 'team_id' | 'team_name'>>();
  if (!reg) return plainJson({ error: 'no such registration' }, 404);
  var count = (await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS last FROM participants WHERE registration_id = ?1').bind(reg.id).first<Size>() as Size);
  if (!existing && count.n >= MAX_TEAM) return plainJson({ error: 'A team has at most ' + MAX_TEAM + ' people.' }, 400);
  var cleaned = await cleanMember(db, body, existing ? existing.position : count.last + 1, {}, { skipId: id });
  if ('error' in cleaned) return plainJson({ error: cleaned.error }, cleaned.error.indexOf('already registered') !== -1 ? 409 : 400);
  var m = cleaned.member;
  var qrNote: string | null | undefined = null;
  var emailHeld = false;
  if (existing) {
    await db.prepare(
      'UPDATE participants SET name = ?2, zid = ?3, email = ?4, arc = ?5, dietary = ?6, discord = ?7 WHERE id = ?1'
    ).bind(id, m.name, m.zid, m.email || null, m.arc, m.dietary || null, m.discord || null).run();
    // check-in holds a copy of the name; push the change so their row
    // at the door still matches them and their code is not re-minted
    if (m.name !== existing.name) {
      renameLater(env, ctx, [{ participant_id: id, name: m.name, team_name: teamLabel(reg.team_name),
        was_name: existing.name, was_team: teamLabel(reg.team_name) }]);
    }
    await logAction(db, session.name, 'rego-person-edit', reg.team_name, m.name, 0, 0, 0);
  } else {
    var minted = await fetchQr(env, m, teamLabel(reg.team_name));
    if (minted.qr_url) { m.qr_url = minted.qr_url; m.checkin_token = minted.token || null; } else qrNote = minted.note;
    var lead = await db.prepare('SELECT name FROM participants WHERE registration_id = ?1 AND position = 1').bind(reg.id).first<Pick<ParticipantRow, 'name'>>();
    // No code, no email: a confirmation with no ticket in it promises
    // one that is not coming. It is recorded as skipped, so the Rego
    // tab can send it once the code is made — or send it anyway, once,
    // if an organiser says so.
    emailHeld = !!(m.email && emailConfigured(env) && !m.qr_url);
    m.email_status = m.email && m.qr_url && emailConfigured(env)
      ? await sendEmail(env, regoEmail(m, lead || { name: 'An organiser' }, reg.team_name)) : 'skipped';
    var ins = await db.prepare(
      'INSERT INTO participants (registration_id, team_id, position, name, zid, email, arc, dietary, discord, qr_url, email_status, terms_key) ' +
      'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)'
    ).bind(reg.id, reg.team_id, m.position, m.name, m.zid, m.email || null, m.arc, m.dietary || null, m.discord || null, m.qr_url, m.email_status, m.terms_key).run();
    id = ins.meta && ins.meta.last_row_id;
    await logAction(db, session.name, 'rego-person-add', reg.team_name, m.name, 0, 0, 0);
  }
  resyncLater(env, ctx);
  // just written, so it is there
  var person = await db.prepare('SELECT * FROM participants WHERE id = ?1').bind(id).first<ParticipantRow>() as ParticipantRow;
  return plainJson({
    ok: true, person: person, qr: person.qr_url ? 'attached' : 'missing', qr_note: qrNote,
    ticket_url: ticketFor({ qr_url: person.qr_url, name: person.name, checkin_token: m.checkin_token }, teamLabel(reg.team_name)),
    email_held: emailHeld
  });
}

// Signups with nobody yet in a team marked as tests, or back (`ids`, or
// one `id`). A team's signup goes with its team, which is hidden from
// the Teams tab.
export async function regoHide(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var raw = Array.isArray(body.ids) ? body.ids : [body.id];
  var ids: number[] = [];
  for (var i = 0; i < raw.length && ids.length < 200; i++) {
    var n = Number(raw[i]);
    if (n > 0 && isFinite(n) && ids.indexOf(n) === -1) ids.push(n);
  }
  if (!ids.length) return json({ error: 'no such signup' }, 404);
  var idJson = JSON.stringify(ids);
  var regs = (await env.DB.prepare(
    'SELECT id, team_id, team_name FROM registrations WHERE id IN (SELECT value FROM json_each(?1))'
  ).bind(idJson).all<Pick<RegistrationRow, 'id' | 'team_id' | 'team_name'>>()).results;
  if (regs.length !== ids.length) return json({ error: 'no such signup' }, 404);
  if (regs.some(function (r) { return !isSolo(r); })) {
    return json({ error: 'That signup is in a team. Hide the team in the Teams tab.' }, 400);
  }
  var want = body.hidden ? 1 : 0;
  var namesRes = await Promise.all([
    env.DB.prepare('UPDATE registrations SET hidden = ?2 WHERE id IN (SELECT value FROM json_each(?1))').bind(idJson, want).run(),
    env.DB.prepare('SELECT name FROM participants WHERE registration_id IN (SELECT value FROM json_each(?1)) ORDER BY registration_id, position')
      .bind(idJson).all<Pick<ParticipantRow, 'name'>>()
  ]);
  var names = namesRes[1].results.map(function (p) { return p.name; });
  await logAction(env.DB, session.name, want ? 'rego-hide' : 'rego-show', '', names.join(', ').slice(0, 200), 0, 0, 0);
  return json({ ok: true, count: regs.length, hidden: want });
}

export async function regoPersonDelete(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var person = await db.prepare(
    'SELECT p.id, p.name, r.team_name FROM participants p JOIN registrations r ON r.id = p.registration_id WHERE p.id = ?1'
  ).bind(Number(body.id) || 0).first<{ id: number; name: string; team_name: string }>();
  if (!person) return plainJson({ error: 'no such person' }, 404);
  await db.batch([
    db.prepare('DELETE FROM participants WHERE id = ?1').bind(person.id),
    db.prepare('DELETE FROM discord_members WHERE participant_id = ?1').bind(person.id)
  ]);
  await logAction(db, session.name, 'rego-person-remove', person.team_name, person.name, 0, 0, 0);
  resyncLater(env, ctx);
  return plainJson({ ok: true });
}

// One person out of their team and into another on the tab
// (`team_id`), or out to no team at all (`team_id` 0), for someone put
// in the wrong team or a team that changes. Somebody without a team is
// placed from the Without a team box instead. They join the new team's
// registration after the people already there, keeping their code, their
// terms and everything they gave; a team on the tab with no
// registration gets one, and no team is a signup of their own, like the
// form's, carrying the old team's answers. The team they leave keeps its
// name and its points, even with nobody left on it. Then check-in is
// told their team, Discord moves their role, the sheet is rewritten and,
// unless `email` is false, they are emailed their ticket under the new
// team.
export async function regoPersonMove(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var person = await db.prepare('SELECT * FROM participants WHERE id = ?1').bind(Math.round(Number(body.id)) || 0).first<Person>();
  if (!person) return plainJson({ error: 'no such person' }, 404);
  var from = await db.prepare('SELECT id, team_id, team_name, societies, photo_permission FROM registrations WHERE id = ?1')
    .bind(person.registration_id).first<Pick<RegistrationRow, 'id' | 'team_id' | 'team_name' | 'societies' | 'photo_permission'>>();
  if (!from) return plainJson({ error: 'no such registration' }, 404);
  if (isSolo(from)) return plainJson({ error: person.name + ' is not in a team yet. Place them from the Without a team box.' }, 400);
  var fromName = teamLabel(from.team_name);

  var toId = Math.round(Number(body.team_id)) || 0;
  var team: Pick<TeamRow, 'id' | 'name'> | null = null;
  var target: Pick<RegistrationRow, 'id'> | null = null;
  var position = 1;
  if (toId) {
    team = await db.prepare('SELECT id, name FROM teams WHERE id = ?1').bind(toId).first<Pick<TeamRow, 'id' | 'name'>>();
    if (!team) return plainJson({ error: 'That team is not on the tab.' }, 404);
    if (team.id === person.team_id) return plainJson({ error: person.name + ' is already on ' + team.name + '.' }, 400);
    var size = await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS last FROM participants WHERE team_id = ?1')
      .bind(team.id).first<Size>() as Size;
    if (size.n >= MAX_TEAM) return plainJson({ error: team.name + ' already has ' + MAX_TEAM + ' people.' }, 400);
    position = size.last + 1;
    target = await db.prepare('SELECT id FROM registrations WHERE team_id = ?1 ORDER BY id LIMIT 1').bind(team.id).first<Pick<RegistrationRow, 'id'>>();
  }
  var teamName = team ? team.name : '';

  // In one batch. A registration made here is found again by MAX(id):
  // D1 runs a batch with nothing between its statements, so it is the
  // one just inserted.
  var stmts: D1PreparedStatement[] = [];
  if (team && target) {
    stmts.push(db.prepare('UPDATE participants SET team_id = ?1, registration_id = ?2, position = ?3 WHERE id = ?4')
      .bind(team.id, target.id, position, person.id));
  } else if (team) {
    stmts.push(db.prepare('INSERT INTO registrations (team_id, team_name) VALUES (?1, ?2)').bind(team.id, team.name));
    stmts.push(db.prepare(
      'UPDATE participants SET team_id = ?1, registration_id = (SELECT MAX(id) FROM registrations WHERE team_id = ?1), position = ?2 WHERE id = ?3'
    ).bind(team.id, position, person.id));
  } else {
    // someone taken off a test team is still a test
    var was = from.team_id ? await db.prepare('SELECT hidden FROM teams WHERE id = ?1').bind(from.team_id).first<Pick<TeamRow, 'hidden'>>() : null;
    stmts.push(db.prepare(
      "INSERT INTO registrations (team_id, team_name, societies, photo_permission, hidden) VALUES (NULL, '', ?1, ?2, ?3)"
    ).bind(from.societies || null, from.photo_permission ? 1 : 0, was && was.hidden ? 1 : 0));
    stmts.push(db.prepare(
      "UPDATE participants SET team_id = NULL, position = 1, registration_id = (SELECT MAX(id) FROM registrations WHERE team_id IS NULL AND team_name = '') WHERE id = ?1"
    ).bind(person.id));
  }
  stmts.push(db.prepare('UPDATE discord_members SET team_id = ?2 WHERE participant_id = ?1').bind(person.id, team ? team.id : null));
  await db.batch(stmts);
  await logAction(db, session.name, 'rego-person-move', team ? team.name : NO_TEAM, (person.name + ' from ' + fromName).slice(0, 200), 0, 0, 0);

  renameLater(env, ctx, [{ participant_id: person.id, name: person.name, team_name: teamLabel(teamName),
    was_name: person.name, was_team: fromName }]);
  var discord = 0;
  try { discord = await moveMemberTeam(env, person.id, from.team_id, team); } catch (err) { /* best effort */ }
  var emailed = false;
  var emailOff = false;
  if (team && body.email !== false && person.email) {
    person.position = position;
    await ensureTermsKey(db, person);
    var moveMail = await sendEmail(env, regoEmail(person, { name: '' }, teamName, { moved: true }));
    emailed = moveMail === 'sent';
    emailOff = moveMail === 'held';
  }
  var left = await db.prepare('SELECT COUNT(*) AS n FROM participants WHERE registration_id = ?1').bind(from.id).first<{ n: number }>() as { n: number };
  resyncLater(env, ctx);
  return plainJson({ ok: true, name: person.name, from: fromName, team: team ? team.name : NO_TEAM, team_id: team ? team.id : null,
    emailed: emailed, email_off: emailOff, discord: discord, left: left.n });
}

// A whole team from the dashboard, skipping the public form (no
// rate limit, no honeypot). Everyone still accepts the terms from
// their own email.
export async function regoTeamCreate(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var teamName = cleanText(body.team_name, 40);
  if (!teamName) return plainJson({ error: 'The team needs a name.' }, 400);
  var reserved = reservedTeamName(teamName);
  if (reserved) return plainJson({ error: reserved }, 400);
  var nameTaken = 'A team called "' + teamName + '" already exists on the tab.';
  var taken = await db.prepare('SELECT id FROM teams WHERE name = ?1 COLLATE NOCASE').bind(teamName).first();
  if (taken) return plainJson({ error: nameTaken }, 409);
  var rawMembers = Array.isArray(body.members) ? body.members : [];
  var filled = rawMembers.filter(function (m) {
    return m && (cleanText(prop(m, 'name'), 80) || cleanText(prop(m, 'zid'), 20) || cleanText(prop(m, 'email'), 120));
  }).length;
  if (filled > MAX_TEAM) return plainJson({ error: 'A team has at most ' + MAX_TEAM + ' people.' }, 400);
  var members: Member[] = [];
  var seenZids: Record<string, boolean> = {};
  for (var i = 0; i < rawMembers.length; i++) {
    var raw = fields(rawMembers[i]);
    if (!cleanText(raw.name, 80) && !cleanText(raw.zid, 20) && !cleanText(raw.email, 120)) continue;
    var cleaned = await cleanMember(db, raw, members.length + 1, seenZids, {});
    if ('error' in cleaned) return plainJson({ error: cleaned.error }, cleaned.error.indexOf('already registered') !== -1 ? 409 : 400);
    members.push(cleaned.member);
  }
  if (!members.length) return plainJson({ error: 'A team needs at least one person.' }, 400);
  var socs = pickSocieties(Array.isArray(body.societies) ? body.societies : []);
  if ('unknown' in socs) return plainJson({ error: socs.unknown }, 400);
  var made = await registerTeam(env, ctx, {
    teamName: teamName, members: members, societies: socs.societies, questions: cleanText(body.questions, 1000),
    photoPermission: body.photo_permission ? 1 : 0, ipHash: null, actor: 'console:' + session.name
  });
  if (made.taken) return plainJson({ error: nameTaken }, 409);
  return plainJson({ ok: true, team: teamName, registration_id: made.regId, members: made.members, emails: made.emails, qrs: made.qrs });
}

// ---------- placing people who signed up without a team ----------
// One or more of those signups (a person, or a pair kept together) go
// into a new team or into one already on the tab with room for them.
// Their people move to that team's registration and the signups they
// came in on are deleted; what they answered on the form comes with
// them — societies added together, photo permission only if everyone
// said yes, questions kept. Check-in is told their team, the sheet is
// rewritten, and each of them is emailed their ticket under the team's
// name, which is what their first email told them to wait for.
export async function regoPlace(env: Env, session: ConsoleSession, body: JsonBody, ctx: Ctx, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var nameTaken = function (name: string) {
    return 'A team called "' + name + '" already exists on the tab. Pick it from the list to add them to it.';
  };
  var ids: number[] = [];
  (Array.isArray(body.registration_ids) ? body.registration_ids : []).forEach(function (x) {
    var n = Math.round(Number(x));
    if (n > 0 && ids.indexOf(n) === -1) ids.push(n);
  });
  if (!ids.length) return plainJson({ error: 'Pick who to place.' }, 400);
  var idList = JSON.stringify(ids);
  var regs = (await db.prepare(
    'SELECT id, team_id, team_name, societies, photo_permission, questions FROM registrations ' +
    'WHERE id IN (SELECT value FROM json_each(?1)) ORDER BY id'
  ).bind(idList).all<Pick<RegistrationRow, 'id' | 'team_id' | 'team_name' | 'societies' | 'photo_permission' | 'questions'>>()).results;
  if (regs.length !== ids.length || regs.some(function (r) { return !isSolo(r); })) {
    return plainJson({ error: 'Only people without a team can be placed, and one of those is not.' }, 400);
  }
  var people = (await db.prepare(
    'SELECT * FROM participants WHERE registration_id IN (SELECT value FROM json_each(?1)) ORDER BY registration_id, position'
  ).bind(idList).all<Person>()).results;
  if (!people.length) return plainJson({ error: 'Nobody is on those signups any more.' }, 400);

  var team: Pick<TeamRow, 'id' | 'name'> | null = null;
  var target: Pick<RegistrationRow, 'id' | 'societies' | 'photo_permission' | 'questions'> | null = null;
  var teamName: string;
  if (body.team_id) {
    team = await db.prepare('SELECT id, name FROM teams WHERE id = ?1').bind(Math.round(Number(body.team_id)) || 0).first<Pick<TeamRow, 'id' | 'name'>>();
    if (!team) return plainJson({ error: 'That team is not on the tab.' }, 404);
    teamName = team.name;
    target = await db.prepare(
      'SELECT id, societies, photo_permission, questions FROM registrations WHERE team_id = ?1 ORDER BY id LIMIT 1'
    ).bind(team.id).first<Pick<RegistrationRow, 'id' | 'societies' | 'photo_permission' | 'questions'>>();
  } else {
    teamName = cleanText(body.team_name, 40);
    if (!teamName) return plainJson({ error: 'Name the new team, or pick one to add them to.' }, 400);
    var reserved = reservedTeamName(teamName);
    if (reserved) return plainJson({ error: reserved }, 400);
    var taken = await db.prepare('SELECT id FROM teams WHERE name = ?1 COLLATE NOCASE').bind(teamName).first();
    if (taken) return plainJson({ error: nameTaken(teamName) }, 409);
  }
  var size = team ? (await db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(position), 0) AS last FROM participants WHERE team_id = ?1')
    .bind(team.id).first<Size>() as Size) : { n: 0, last: 0 };
  if (size.n + people.length > MAX_TEAM) {
    return plainJson({ error: teamName + ' has ' + size.n + (size.n === 1 ? ' person' : ' people') + '; with these ' +
      people.length + ' it would be more than ' + MAX_TEAM + '.' }, 400);
  }

  var sources: Pick<RegistrationRow, 'societies' | 'photo_permission' | 'questions'>[] = (target ? [target] : []).concat(regs);
  var picked: Record<string, boolean> = {};
  sources.forEach(function (r) {
    String(r.societies || '').split(';').forEach(function (x) { x = x.trim(); if (x) picked[x] = true; });
  });
  var societies = SOCIETIES.filter(function (x) { return picked[x]; }).join('; ');
  var photo = sources.every(function (r) { return !!r.photo_permission; }) ? 1 : 0;
  var questions = sources.map(function (r) { return r.questions || ''; }).filter(Boolean).join('\n').slice(0, 1000);

  // In one batch: the team and its registration when there is none, the
  // people moved across, the signups they came on taken away, the log.
  // A new registration is found by its team's name, which is unique.
  var stillSolo = "(SELECT COUNT(*) FROM registrations WHERE id IN (SELECT value FROM json_each(?)) AND team_id IS NULL) = " + regs.length;
  var stmts: D1PreparedStatement[] = [];
  if (!team) {
    stmts.push(db.prepare('INSERT INTO teams (id, name) SELECT ' + NEXT_TEAM_ID + ', ?1 WHERE ' + stillSolo).bind(teamName, idList));
  }
  if (!target) {
    stmts.push(db.prepare(
      'INSERT INTO registrations (team_id, team_name, societies, photo_permission, questions) ' +
      'SELECT (SELECT id FROM teams WHERE name = ?1), ?1, ?2, ?3, ?4 WHERE ' + stillSolo
    ).bind(teamName, societies || null, photo, questions || null, idList));
  } else {
    stmts.push(db.prepare('UPDATE registrations SET societies = ?2, photo_permission = ?3, questions = ?4 WHERE id = ?1 AND ' + stillSolo)
      .bind(target.id, societies || null, photo, questions || null, idList));
  }
  var firstMoveIdx = stmts.length;
  people.forEach(function (p, i) {
    stmts.push(db.prepare(
      'UPDATE participants SET team_id = (SELECT id FROM teams WHERE name = ?1), ' +
      'registration_id = COALESCE(?2, (SELECT MAX(id) FROM registrations WHERE team_name = ?1)), position = ?3 ' +
      'WHERE id = ?4 AND team_id IS NULL AND registration_id = ?5 AND ' + stillSolo
    ).bind(teamName, target ? target.id : null, size.last + i + 1, p.id, p.registration_id, idList));
  });
  stmts.push(db.prepare('DELETE FROM registrations WHERE id IN (SELECT value FROM json_each(?1)) AND team_id IS NULL').bind(idList));
  stmts.push(db.prepare(
    'INSERT INTO submission_log (action, team_name, quest_code, points_delta, old_total, new_total, actor) ' +
    "SELECT 'rego-place', ?1, ?2, 0, 0, 0, ?3 WHERE EXISTS (SELECT 1 FROM participants WHERE id = ?4 AND team_id IS NOT NULL)"
  ).bind(teamName, people.map(function (p) { return p.name; }).join(', ').slice(0, 200), 'console:' + session.name, people[0].id));
  var placed: D1Result[];
  try {
    placed = await db.batch(stmts);
  } catch (err) {
    if (team || !uniqueClash(err)) throw err;
    return plainJson({ error: nameTaken(teamName) }, 409);
  }
  if (!(placed[firstMoveIdx] && placed[firstMoveIdx].meta && placed[firstMoveIdx].meta.changes)) {
    return plainJson({ error: 'Those signups have already been placed.' }, 409);
  }
  var teamId = team ? team.id : (await db.prepare('SELECT id FROM teams WHERE name = ?1').bind(teamName).first<Pick<TeamRow, 'id'>>() as Pick<TeamRow, 'id'>).id;

  renameLater(env, ctx, people.map(function (p) {
    return { participant_id: p.id, name: p.name, team_name: teamName, was_name: p.name, was_team: NO_TEAM };
  }));
  var emails = 0;
  var emailOff = false;
  if (body.email !== false) {
    for (var k = 0; k < people.length; k++) {
      var person = people[k];
      if (!person.email) continue;
      person.position = size.last + k + 1;
      await ensureTermsKey(db, person);
      var status = await sendEmail(env, regoEmail(person, { name: '' }, teamName, { placed: true }));
      if (status === 'sent') emails++;
      if (status === 'held') emailOff = true;
    }
  }
  resyncLater(env, ctx);
  return plainJson({ ok: true, team: teamName, team_id: teamId, created: !team, moved: people.length, emails: emails, email_off: emailOff });
}
