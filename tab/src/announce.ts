// Email announcements, from the dashboard's Email tab.
//
// Everyone signed up, or one team, gets the same message — and each
// person gets their own copy, addressed to them alone. Nothing here
// puts two addresses in one message: no list in To, no Cc, no Bcc. A
// Bcc would hide the list too, but it is one message carrying every
// address to the mail service, and the first mistake with it (a list
// pasted into To, a client that shows Bcc to its own sender) shows
// three hundred students' addresses to each other. One message per
// person makes that mistake impossible rather than unlikely, and
// `oneAddress` refuses any stored value that is not exactly one plain
// address, so a row holding "a@x.com, b@y.com" cannot become two
// recipients of one message either. The test in
// tests/verify-announce.mjs reads every message that went out.
//
// A send to everyone is three hundred messages, more than one request
// should try to carry. So an announcement is a row in email_sends and
// one row per address in email_queue, and the addresses are sent in
// batches: the first while the organiser watches the Send button, the
// next ones as the Email tab asks for them, and whatever is left, if
// the tab is closed, by the scheduled run a batch a minute. A batch
// claims its rows in one UPDATE before it sends, so the page and the
// schedule working on the same announcement cannot send anyone the
// same message twice; a claim left by a request that died is taken
// back after ten minutes.
//
// The message is written as text with the dashboard's light markdown
// (bold, italic, headings, lists, links), or as HTML. Both go inside
// the confirmation email's frame — the header picture, the stripe, the
// footer — so an announcement looks like the rest of what SCS sends.
// HTML is the organisers' own; what is taken out of it is only what a
// mail client would strip anyway and what could run in the dashboard's
// preview: scripts, frames, event handlers and javascript: links.
//
// While email is off on the Settings tab (emailsHeld), a send, a step, a
// retry and a test are refused before anything is written, and the
// batches claim nothing: an announcement part way out waits, queue and
// all, and carries on once email is back on. Stop still works.

import { json, cleanText, utcStamp, PERSON_SHOWN, errorMessage, emailsHeld, emailOffRefusal } from './shared.ts';
import { trySendEmail, emailConfigured, escapeHtml } from './email.ts';
import * as E from './email-html.ts';
import { ORG_EMAIL } from './rego.ts';
import { personalRemoved } from './privacy.ts';
import type { ConsoleSession, EmailQueueRow, EmailSendRow, Env, JsonBody, LogAction, ParticipantRow, TeamRow } from './types.ts';

// An announcement as it goes out.
export interface Announcement {
  subject: string;
  html: string;
  text: string;
}

// What the Email tab sent, cleaned (draftOf).
interface Draft {
  subject: string;
  format: string;
  body: string;
  footer: string | null;
  replyTo: string | null;
  replyBad: boolean;
}

// A send as the Email tab lists it.
type SendRow = Pick<EmailSendRow, 'id' | 'subject' | 'format' | 'audience' | 'team_id' | 'total' | 'sent' | 'failed' | 'status' | 'created_by' | 'created_at' | 'finished_at'> &
  { team_name: TeamRow['name'] | null };

export var ANNOUNCE_INLINE = 20;   // what one request sends while somebody watches
export var ANNOUNCE_SWEEP = 50;    // what the scheduled run sends each minute
var FANOUT = 5;                    // messages in flight at once inside a batch
var STALE_MINUTES = 10;
var MAX_SUBJECT = 150;
var MAX_BODY = 20000;
var MAX_LIST = 2000;               // addresses one typed-in send may take

// ---------- one address, and only one ----------

export function oneAddress(value: unknown): string {
  var e = String(value == null ? '' : value).trim().toLowerCase();
  if (e.length > 120) return '';
  return /^[^\s@,;:<>()"'\[\]\\]+@[^\s@,;:<>()"'\[\]\\]+\.[^\s@,;:<>()"'\[\]\\]+$/.test(e) ? e : '';
}

// Addresses typed or pasted into the Email tab: one a line, separated by
// commas or semicolons, or whole rows copied out of a spreadsheet, which
// arrive tab-separated with names and other columns beside the address.
// Every piece that is an address is taken, each once; a piece with an @
// in it that is not one comes back in `bad` so the page can say which.
export function pastedAddresses(text: unknown): { emails: string[]; bad: string[] } {
  var seen: Record<string, boolean> = {};
  var emails: string[] = [];
  var bad: string[] = [];
  String(text == null ? '' : text).split(/[\s,;<>()"'\[\]]+/).forEach(function (piece) {
    if (!piece) return;
    var e = oneAddress(piece.replace(/^mailto:/i, ''));
    if (e) {
      if (!seen[e]) { seen[e] = true; emails.push(e); }
      return;
    }
    if (piece.indexOf('@') !== -1 && bad.length < 20) bad.push(piece.slice(0, 120));
  });
  return { emails: emails, bad: bad };
}

// Everyone signed up who is not a test (see PERSON_SHOWN), or everyone
// on one team, with an address — each address once, however many
// people share it.
async function recipients(db: D1Database, audience: string, teamId: number): Promise<string[]> {
  // LEFT JOIN: somebody who signed up without a team and has not been
  // placed has no team row, and is still somebody coming on the day
  var sql = 'SELECT p.email AS email FROM participants p LEFT JOIN teams t ON t.id = p.team_id ' +
    "LEFT JOIN registrations r ON r.id = p.registration_id WHERE COALESCE(p.email, '') != ''";
  type Row = Pick<ParticipantRow, 'email'>;
  var rows: Row[];
  if (audience === 'team') {
    rows = (await db.prepare(sql + ' AND p.team_id = ?1 ORDER BY p.id').bind(teamId).all<Row>()).results;
  } else {
    rows = (await db.prepare(sql + ' AND ' + PERSON_SHOWN + ' ORDER BY p.id').all<Row>()).results;
  }
  var seen: Record<string, boolean> = {};
  var out: string[] = [];
  rows.forEach(function (r) {
    var e = oneAddress(r.email);
    if (!e || seen[e]) return;
    seen[e] = true;
    out.push(e);
  });
  return out;
}

// How many each audience reaches, for the Send button's label.
async function audienceCounts(db: D1Database): Promise<{ all: number; teams: Record<string, number> }> {
  type Row = Pick<ParticipantRow, 'team_id' | 'email'> & { hidden: number };
  var rows = (await db.prepare(
    'SELECT p.team_id AS team_id, p.email AS email, CASE WHEN ' + PERSON_SHOWN + ' THEN 0 ELSE 1 END AS hidden ' +
    'FROM participants p LEFT JOIN teams t ON t.id = p.team_id LEFT JOIN registrations r ON r.id = p.registration_id ' +
    "WHERE COALESCE(p.email, '') != ''"
  ).all<Row>()).results;
  var all: Record<string, boolean> = {};
  var teams: Record<string, Record<string, boolean>> = {};
  rows.forEach(function (r) {
    var e = oneAddress(r.email);
    if (!e) return;
    if (!r.hidden) all[e] = true;
    if (r.team_id == null) return;
    teams[r.team_id] = teams[r.team_id] || {};
    teams[r.team_id][e] = true;
  });
  var byTeam: Record<string, number> = {};
  Object.keys(teams).forEach(function (k) { byTeam[k] = Object.keys(teams[k]).length; });
  return { all: Object.keys(all).length, teams: byTeam };
}

// ---------- what the message looks like ----------

var FONT = E.FONT;
var INK = E.INK;

function inline(escaped: string): string {
  return escaped
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<u>$1</u>')
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" style="color:' + INK.accent + ';font-weight:bold;">$1</a>');
}

// The dashboard's markdown, with every style written on the element:
// a mail client keeps nothing else.
export function markdownEmail(text: unknown): string {
  var esc = escapeHtml(String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim());
  return esc.split(/\n{2,}/).map(function (block) {
    var lines = block.split('\n');
    if (lines.length === 1 && /^#{1,3} /.test(lines[0])) {
      return '<h2 style="margin:6px 0 10px;font-family:' + FONT + ';font-size:20px;line-height:1.25;' +
        'font-weight:bold;color:' + INK.text + ';">' + inline(lines[0].replace(/^#{1,3} /, '')) + '</h2>';
    }
    if (lines.every(function (l) { return /^\s*[-*] /.test(l); })) {
      return '<ul style="margin:0 0 14px;padding-left:22px;font-family:' + FONT + ';font-size:15px;' +
        'line-height:1.55;color:' + INK.text + ';">' + lines.map(function (l) {
          return '<li style="margin:0 0 4px;">' + inline(l.replace(/^\s*[-*] /, '')) + '</li>';
        }).join('') + '</ul>';
    }
    return E.paragraph(lines.map(inline).join('<br>'));
  }).join('');
}

// The organisers' HTML, less what could run.
export function cleanHtml(html: unknown): string {
  return String(html == null ? '' : html)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(script|iframe|object|embed|frame|frameset|base|meta|link)\b[^>]*>/gi, '')
    .replace(/<\/(iframe|object|embed|frame|frameset)\s*>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src)\s*=\s*(["']?)\s*javascript:[^"'\s>]*\2/gi, '$1="#"');
}

function markdownText(text: unknown): string {
  return String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim()
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/(^|[^*\w])\*([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/^#{1,3} /gm, '')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)');
}

function htmlText(html: unknown): string {
  return String(html == null ? '' : html)
    .replace(/<(style|script)[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, function (all: string, href: string, words: string) {
      return /^https?:|^mailto:/i.test(href) ? words + ' (' + href.replace(/^mailto:/i, '') + ')' : words;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|ul|ol)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// The line at the foot of every announcement. The Email tab starts its
// box with this and an organiser can change it for one send; what was
// sent is kept with the send (`email_sends.footer`), so the rest of a
// queue goes out the way it started. NULL on a send is this line, and
// '' is no line at all.
export var DEFAULT_FOOTER = 'You are getting this because you are registered for SCS.2. Questions? Email ' + ORG_EMAIL + '.';
var MAX_FOOTER = 500;

// The footer as HTML: the body's own Markdown, and any email address in
// it made a link, outside a link already there.
function footerHtml(text: string): string {
  var inA = false;
  return inline(escapeHtml(text)).split(/(<[^>]+>)/).map(function (bit) {
    if (/^<a\b/i.test(bit)) { inA = true; return bit; }
    if (/^<\/a>/i.test(bit)) { inA = false; return bit; }
    if (inA || bit.charAt(0) === '<') return bit;
    return bit.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g, function (e) {
      return E.link('mailto:' + e, e);
    });
  }).join('');
}

export function buildAnnouncement(subject: string, format: string, body: string, footer: string | null | undefined): Announcement {
  var html = format === 'html';
  // the plain-text copy and the inbox's preview line come from the
  // cleaned HTML too, or a javascript: link taken out of one is left in
  // the other
  var clean = html ? cleanHtml(body) : '';
  var text = html ? htmlText(clean) : markdownText(body);
  var foot = footer == null ? DEFAULT_FOOTER : String(footer).trim();
  return {
    subject: subject,
    html: E.shell({
      heading: subject,
      title: subject,
      preheader: text.replace(/\s+/g, ' ').slice(0, 110),
      body: html ? clean : markdownEmail(body),
      footer: foot ? E.paragraph(footerHtml(foot), { size: 13, colour: INK.muted }) : ''
    }),
    text: text + (foot ? '\n\n' + markdownText(foot) : '') + '\n'
  };
}

function draftOf(body: JsonBody): Draft {
  return {
    subject: cleanText(body.subject, MAX_SUBJECT),
    format: body.format === 'html' ? 'html' : 'text',
    body: String(body.body == null ? '' : body.body).replace(/\r\n?/g, '\n').slice(0, MAX_BODY),
    // left out, it is the default line; sent empty, there is none
    footer: body.footer == null ? null : String(body.footer).replace(/\s+/g, ' ').trim().slice(0, MAX_FOOTER),
    // where a reply goes: blank is the worker's own (EMAIL_REPLY_TO);
    // typed and not an address, `replyBad` says so
    replyTo: oneAddress(body.reply_to) || null,
    replyBad: !!String(body.reply_to == null ? '' : body.reply_to).trim() && !oneAddress(body.reply_to)
  };
}

function defaultReplyTo(env: Env): string {
  return env.EMAIL_REPLY_TO || ORG_EMAIL;
}

// ---------- the dashboard's actions ----------

// GET announce: the recent announcements and how many each audience reaches
export async function announceList(env: Env): Promise<Response> {
  var sends: SendRow[] = [];
  try {
    sends = (await env.DB.prepare(
      'SELECT s.id, s.subject, s.format, s.audience, s.team_id, t.name AS team_name, s.total, s.sent, ' +
      's.failed, s.status, s.created_by, s.created_at, s.finished_at ' +
      'FROM email_sends s LEFT JOIN teams t ON t.id = s.team_id ORDER BY s.id DESC LIMIT 20'
    ).all<SendRow>()).results;
  } catch (err) { sends = []; }
  return json({ ok: true, configured: emailConfigured(env), email_off: await emailsHeld(env.DB),
    counts: await audienceCounts(env.DB), sends: sends, default_footer: DEFAULT_FOOTER, default_reply_to: defaultReplyTo(env) });
}

// POST announce/preview: the message exactly as it would go out
export async function announcePreview(env: Env, body: JsonBody): Promise<Response> {
  var d = draftOf(body);
  var built = buildAnnouncement(d.subject || '(no subject)', d.format, d.body, d.footer);
  return json({ ok: true, html: built.html, text: built.text });
}

// POST announce/test: one copy to one address the organiser types
export async function announceTest(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  if (await emailsHeld(env.DB)) return emailOffRefusal();
  var d = draftOf(body);
  if (!d.subject || !d.body.trim()) return json({ error: 'A subject and a message are both needed.' }, 400);
  var to = oneAddress(body.to);
  if (!to) return json({ error: 'That test address does not look right.' }, 400);
  if (d.replyBad) return json({ error: 'The address replies go to does not look right.' }, 400);
  if (!emailConfigured(env)) return json({ error: 'Email is not set up on the worker.' }, 503);
  var built = buildAnnouncement(d.subject, d.format, d.body, d.footer);
  var result = await trySendEmail(env, { to: to, subject: '[Test] ' + built.subject, html: built.html, text: built.text,
    replyTo: d.replyTo || undefined });
  await logAction(env.DB, session.name, 'announce-test', d.subject.slice(0, 60), '-', 0, 0, 0);
  if (result.status !== 'sent') {
    return json({ error: 'The test did not go out: ' + ((result.refused[0] && result.refused[0].error) || result.status) }, 502);
  }
  return json({ ok: true, to: to });
}

async function sendRow(db: D1Database, id: number): Promise<SendRow | null> {
  return db.prepare(
    'SELECT s.id, s.subject, s.format, s.audience, s.team_id, t.name AS team_name, s.total, s.sent, ' +
    's.failed, s.status, s.created_by, s.created_at, s.finished_at ' +
    'FROM email_sends s LEFT JOIN teams t ON t.id = s.team_id WHERE s.id = ?1'
  ).bind(id).first<SendRow>();
}

// POST announce/send: everyone, one team, or addresses the organiser
// typed or pasted (`emails`, the box's text as it stands). Writes the
// announcement and its addresses down, then sends the first batch.
export async function announceSend(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  // refused before the send row is written, so nothing is left queued
  if (await emailsHeld(env.DB)) return emailOffRefusal();
  var d = draftOf(body);
  if (!d.subject || !d.body.trim()) return json({ error: 'A subject and a message are both needed.' }, 400);
  if (!emailConfigured(env)) return json({ error: 'Email is not set up on the worker.' }, 503);
  if (d.replyBad) return json({ error: 'The address replies go to does not look right.' }, 400);
  var audience = body.audience === 'team' || body.audience === 'list' ? body.audience : 'all';
  var team: Pick<TeamRow, 'id' | 'name'> | null = null;
  var list: string[];
  if (audience === 'list') {
    list = pastedAddresses(body.emails).emails;
    if (!list.length) return json({ error: 'Type or paste at least one email address.' }, 400);
    if (list.length > MAX_LIST) {
      return json({ error: 'That is ' + list.length + ' addresses. One send takes at most ' + MAX_LIST + '.' }, 400);
    }
  } else {
    if (audience === 'team') {
      team = await env.DB.prepare('SELECT id, name FROM teams WHERE id = ?1')
        .bind(Math.round(Number(body.team_id) || 0)).first<Pick<TeamRow, 'id' | 'name'>>();
      if (!team) return json({ error: 'Pick a team to send to.' }, 400);
    }
    list = await recipients(env.DB, audience, team ? team.id : 0);
    if (!list.length) return json({ error: (team ? team.name : 'Nobody signed up') + ' has no email address to send to.' }, 400);
  }

  var ins = await env.DB.prepare(
    'INSERT INTO email_sends (subject, format, body, audience, team_id, total, status, created_by, footer, reply_to) ' +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'sending', ?7, ?8, ?9)"
  ).bind(d.subject, d.format, d.body, audience, team ? team.id : null, list.length, session.name, d.footer, d.replyTo).run();
  var id = ins.meta && ins.meta.last_row_id;
  var stmts = list.map(function (e) {
    return env.DB.prepare('INSERT OR IGNORE INTO email_queue (send_id, email) VALUES (?1, ?2)').bind(id, e);
  });
  for (var i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await logAction(env.DB, session.name, 'announce-send', d.subject.slice(0, 60),
    team ? team.name.slice(0, 40) : audience === 'list' ? list.length + ' addresses' : 'everyone', 0, 0, list.length);

  await sendBatch(env, id, ANNOUNCE_INLINE);
  return json({ ok: true, send: await sendRow(env.DB, id) });
}

// POST announce/step: the next batch of one announcement, which the
// Email tab asks for until there is nothing left
export async function announceStep(env: Env, body: JsonBody): Promise<Response> {
  if (await emailsHeld(env.DB)) return emailOffRefusal();
  var id = Math.round(Number(body.id) || 0);
  if (!(await sendRow(env.DB, id))) return json({ error: 'That announcement is not there.' }, 404);
  await sendBatch(env, id, ANNOUNCE_INLINE);
  return json({ ok: true, send: await sendRow(env.DB, id) });
}

// POST announce/stop: whatever has not gone out yet stays unsent
export async function announceStop(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var id = Math.round(Number(body.id) || 0);
  var row = await sendRow(env.DB, id);
  if (!row) return json({ error: 'That announcement is not there.' }, 404);
  // the addresses still waiting are marked too, so a Retry later puts
  // back the failed ones and never these
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE email_sends SET status = 'stopped', finished_at = ?2 WHERE id = ?1 AND status = 'sending'"
    ).bind(id, utcStamp()),
    env.DB.prepare("UPDATE email_queue SET status = 'stopped' WHERE send_id = ?1 AND status = ''").bind(id)
  ]);
  await logAction(env.DB, session.name, 'announce-stop', row.subject.slice(0, 60), '-', 0, 0, row.sent);
  return json({ ok: true, send: await sendRow(env.DB, id) });
}

// POST announce/retry: the addresses that failed go back on the pile
export async function announceRetry(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  if (await emailsHeld(env.DB)) return emailOffRefusal();
  var id = Math.round(Number(body.id) || 0);
  var row = await sendRow(env.DB, id);
  if (!row) return json({ error: 'That announcement is not there.' }, 404);
  if (!row.failed) return json({ error: 'Nothing failed on that one.' }, 400);
  // its addresses went with the personal data, and a retry would count
  // the send again from a queue with none in it
  if (await personalRemoved(env.DB)) {
    return json({ error: 'The addresses are off the database with the rest of the personal data. Put them back on the Settings tab first.' }, 409);
  }
  // Only the failed addresses go back. On a stopped send the rest stay
  // stopped, and settle marks it stopped again once these are through.
  await env.DB.batch([
    // a send stopped before Stop marked its queue still has them waiting
    env.DB.prepare(
      "UPDATE email_queue SET status = 'stopped' WHERE send_id = ?1 AND status = '' " +
      "AND (SELECT status FROM email_sends WHERE id = ?1) = 'stopped'"
    ).bind(id),
    env.DB.prepare("UPDATE email_queue SET status = '', error = '' WHERE send_id = ?1 AND status = 'failed'").bind(id),
    env.DB.prepare(
      "UPDATE email_sends SET status = 'sending', finished_at = NULL WHERE id = ?1 " +
      "AND EXISTS (SELECT 1 FROM email_queue WHERE send_id = ?1 AND status = '')"
    ).bind(id)
  ]);
  await logAction(env.DB, session.name, 'announce-retry', row.subject.slice(0, 60), '-', 0, 0, row.failed);
  await sendBatch(env, id, ANNOUNCE_INLINE);
  return json({ ok: true, send: await sendRow(env.DB, id) });
}

// ---------- the batches ----------

function stamp(msAgo?: number): string { return utcStamp(new Date(Date.now() - (msAgo || 0))); }

async function sendBatch(env: Env, id: number, limit: number): Promise<{ sent: number; failed: number }> {
  var row = await env.DB.prepare('SELECT * FROM email_sends WHERE id = ?1').bind(id).first<EmailSendRow>();
  if (!row || row.status !== 'sending' || limit < 1) return { sent: 0, failed: 0 };
  // email off: nothing is claimed, so the queue waits as it is
  if (await emailsHeld(env.DB)) return { sent: 0, failed: 0 };
  // the send is asked about again inside the claim: a Stop pressed since
  // the read above takes nothing more
  var claimed = (await env.DB.prepare(
    "UPDATE email_queue SET status = 'sending', claimed_at = ?3 WHERE id IN (" +
    'SELECT id FROM email_queue WHERE send_id = ?1 AND ' +
    "(status = '' OR (status = 'sending' AND claimed_at < ?4)) ORDER BY id LIMIT ?2) " +
    "AND (SELECT status FROM email_sends WHERE id = ?1) = 'sending' RETURNING id, email"
  ).bind(id, limit, stamp(0), stamp(STALE_MINUTES * 60000)).all<Pick<EmailQueueRow, 'id' | 'email'>>()).results;

  var sent = 0;
  var failed = 0;
  if (claimed.length) {
    var msg = buildAnnouncement(row.subject, row.format, row.body, row.footer);
    var send = row;
    for (var i = 0; i < claimed.length; i += FANOUT) {
      var chunk = claimed.slice(i, i + FANOUT);
      var results: { status: string; refused: { error: string }[] }[] = await Promise.all(chunk.map(function (r) {
        // one person per message: the address is the only recipient
        return trySendEmail(env, { to: r.email, subject: msg.subject, html: msg.html, text: msg.text, replyTo: send.reply_to || undefined })
          .catch(function (err) { return { status: 'failed', refused: [{ error: String(errorMessage(err) || err) }] }; });
      }));
      var marks: D1PreparedStatement[] = [];
      results.forEach(function (res, k) {
        // switched off since the claim: back in the queue, unsent
        if (res.status === 'held') {
          marks.push(env.DB.prepare("UPDATE email_queue SET status = '' WHERE id = ?1").bind(chunk[k].id));
          return;
        }
        var ok = res.status === 'sent';
        if (ok) sent++; else failed++;
        var why = ok ? '' : String((res.refused && res.refused[0] && res.refused[0].error) || res.status).slice(0, 200);
        marks.push(env.DB.prepare('UPDATE email_queue SET status = ?2, error = ?3 WHERE id = ?1')
          .bind(chunk[k].id, ok ? 'sent' : 'failed', why));
      });
      // Each chunk is marked as soon as it has gone, and tried twice: a
      // row left 'sending' is taken back after STALE_MINUTES and sent
      // again, so the less that waits unmarked the fewer second copies.
      try { await env.DB.batch(marks); } catch (err) { await env.DB.batch(marks); }
    }
  }
  await settle(env.DB, id);
  return { sent: sent, failed: failed };
}

// The counts come from the queue, so they cannot drift from it, and an
// announcement with nothing waiting is finished: done, or stopped again
// when it was a stopped one whose failed addresses were retried.
async function settle(db: D1Database, id: number): Promise<void> {
  await db.prepare(
    'UPDATE email_sends SET ' +
    "sent = (SELECT COUNT(*) FROM email_queue WHERE send_id = ?1 AND status = 'sent'), " +
    "failed = (SELECT COUNT(*) FROM email_queue WHERE send_id = ?1 AND status = 'failed') WHERE id = ?1"
  ).bind(id).run();
  var left = await db.prepare(
    "SELECT COUNT(*) AS n FROM email_queue WHERE send_id = ?1 AND status IN ('', 'sending')"
  ).bind(id).first<{ n: number }>() as { n: number };
  if (!left.n) {
    await db.prepare(
      "UPDATE email_sends SET status = CASE WHEN EXISTS (SELECT 1 FROM email_queue WHERE send_id = ?1 AND status = 'stopped') " +
      "THEN 'stopped' ELSE 'done' END, finished_at = ?2 WHERE id = ?1 AND status = 'sending'"
    ).bind(id, utcStamp()).run();
  }
}

// The scheduled run: what is left of any announcement, oldest first,
// up to a minute's worth.
export async function announceTick(env: Env): Promise<{ ran: boolean; sent?: number; failed?: number; remaining?: number; held?: boolean }> {
  var rows: Pick<EmailSendRow, 'id'>[];
  try {
    rows = (await env.DB.prepare("SELECT id FROM email_sends WHERE status = 'sending' ORDER BY id").all<Pick<EmailSendRow, 'id'>>()).results;
  } catch (err) { return { ran: false }; }
  if (!rows.length || !emailConfigured(env)) return { ran: false };
  // email off on the Settings tab: the rows stay queued, neither sent nor
  // stopped, until it is back on
  if (await emailsHeld(env.DB)) return { ran: false, held: true };
  var budget = ANNOUNCE_SWEEP;
  var out: { ran: boolean; sent: number; failed: number; remaining?: number } = { ran: true, sent: 0, failed: 0 };
  for (var i = 0; i < rows.length && budget > 0; i++) {
    var b = await sendBatch(env, rows[i].id, budget);
    out.sent += b.sent;
    out.failed += b.failed;
    budget -= b.sent + b.failed;
  }
  var left = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM email_queue q JOIN email_sends s ON s.id = q.send_id " +
    "WHERE s.status = 'sending' AND q.status IN ('', 'sending')"
  ).first<{ n: number }>() as { n: number };
  out.remaining = left.n;
  if (!out.sent && !out.failed) out.ran = false;
  return out;
}

// What the Scores tab says the worker still has in hand.
export async function emailsWaiting(db: D1Database): Promise<number> {
  try {
    var row = await db.prepare(
      "SELECT COUNT(*) AS n FROM email_queue q JOIN email_sends s ON s.id = q.send_id " +
      "WHERE s.status = 'sending' AND q.status IN ('', 'sending')"
    ).first<{ n: number }>() as { n: number };
    return row.n;
  } catch (err) { return 0; }
}
