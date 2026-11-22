// Outbound email, Cloudflare-native: the Email Service send_email
// binding (declared in wrangler.toml as EMAIL) sends straight from
// the worker once the domain is onboarded under Compute > Email
// Service > Email Sending — no third party, no API key. A Resend API
// key (EMAIL_API_KEY secret) still works as a fallback path for
// accounts without the service, and with neither configured sends
// report 'skipped' so the console can retry later.
//
// From is the unmonitored address; Reply-To points at the real inbox
// so hitting reply fills in the org's gmail. **The binding's field is
// `replyTo`** (a string or {email, name}); Resend's is `reply_to`. The
// binding was handed `reply_to` for a while and took the message
// without complaint while ignoring the field, so every reply went to
// the From address. A message can name its own (`msg.replyTo`, the
// Email tab's Replies go to box); otherwise EMAIL_REPLY_TO. If the
// binding ever refuses the field the message is retried without it —
// the Email Routing rule on the From address forwards replies to the
// same inbox anyway, so nothing is lost.
//
// The Settings tab can stop every email (`site_flags.email_held`, read
// by emailsHeld in shared.ts). trySendEmail is the one way a message
// reaches the binding or Resend, so it asks before each one and answers
// 'held' without sending.

import { configured, drain, errorMessage, json, emailsHeld } from './shared.ts';
import type { ConsoleSession, Env, JsonBody, LogAction } from './types.ts';

// One message to one address, as every caller builds it.
export interface EmailMessageIn {
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

interface Envelope {
  to: string | string[];
  from: string;
  subject: string;
  html: string;
  text: string;
  reply_to?: string;
}

// 'held': the Settings tab's switch kept it back (emailsHeld)
export type EmailStatus = 'sent' | 'failed' | 'skipped' | 'held';

// The whole story of one send (trySendEmail).
export interface EmailOutcome {
  status: EmailStatus;
  via: string;
  shape: string;
  name_kept: boolean;
  from: string;
  refused: { shape: string; error: string }[];
}

var DEFAULT_FROM = 'SCS.2 <tab@scs.andyrew.space>';
var DEFAULT_REPLY_TO = 'westsocunsw@gmail.com';

export function emailConfigured(env: Env): boolean {
  return !!env.EMAIL || configured(env.EMAIL_API_KEY);
}

function envelope(env: Env, msg: EmailMessageIn): Envelope {
  return {
    to: msg.to,
    from: env.EMAIL_FROM || DEFAULT_FROM,
    subject: msg.subject,
    html: msg.html,
    text: msg.text
  };
}

// "SCS.2 Tab Team <tab@scs.andyrew.space>" as {name, email}. The
// Email Service binding takes the sender as an object; handed the
// whole string it keeps the address and drops the name, which is why
// inboxes showed the bare address.
export function fromParts(from: unknown): { name?: string; email: string } {
  var m = String(from || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return m[1] ? { name: m[1], email: m[2].trim() } : { email: m[2].trim() };
  return { email: String(from || '').trim() };
}

// The three shapes, in the order they are tried. The last one hands
// the binding the sender as one string, which it answers by keeping
// the address and dropping the name — so a send that gets that far is
// exactly why an inbox shows the bare address. Every failure used to
// be swallowed and a success at any shape reported the same 'sent',
// so nothing recorded that the name had been lost.
var SHAPES = [
  'name and address, with a reply-to',
  'name and address',
  'the whole sender as one string'
];

function replyAddress(env: Env, msg: EmailMessageIn | null | undefined): string {
  return (msg && msg.replyTo) || env.EMAIL_REPLY_TO || DEFAULT_REPLY_TO;
}

async function sendViaBinding(env: Env, msg: EmailMessageIn): Promise<EmailOutcome> {
  var base = envelope(env, msg);
  var named = Object.assign({}, base, { from: fromParts(base.from) });
  var attempts: object[] = [
    Object.assign({ replyTo: replyAddress(env, msg) }, named),
    named,
    base // an older binding that only takes the address string
  ];
  var refused: { shape: string; error: string }[] = [];
  for (var i = 0; i < attempts.length; i++) {
    try {
      // the sender's name is left off when it has none, which the binding
      // takes although its type asks for one
      await (env.EMAIL as SendEmail).send(attempts[i] as EmailMessageBuilder);
      return {
        status: 'sent', via: 'the Email Service binding', shape: SHAPES[i],
        // only the two object shapes carry the display name
        name_kept: i < 2, from: base.from, refused: refused
      };
    } catch (err) {
      refused.push({ shape: SHAPES[i], error: String(errorMessage(err) || err) });
    }
  }
  return {
    status: 'failed', via: 'the Email Service binding', shape: '',
    name_kept: false, from: base.from, refused: refused
  };
}

async function sendViaResend(env: Env, msg: EmailMessageIn): Promise<EmailOutcome> {
  var body = envelope(env, msg);
  body.to = [msg.to];
  body.reply_to = replyAddress(env, msg);
  try {
    var resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + env.EMAIL_API_KEY,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    });
    await drain(resp);
    // Resend reads "Name <address>" out of the string itself, so the
    // name survives this path
    return {
      status: resp.ok ? 'sent' : 'failed', via: 'Resend',
      shape: 'the whole sender as one string', name_kept: true, from: body.from,
      refused: resp.ok ? [] : [{ shape: 'Resend', error: 'answered ' + resp.status }]
    };
  } catch (err) {
    return {
      status: 'failed', via: 'Resend', shape: '', name_kept: false, from: body.from,
      refused: [{ shape: 'Resend', error: String(errorMessage(err) || err) }]
    };
  }
}

// The whole story of one send: which way it went out, which shape the
// binding accepted, whether the display name survived it, and what
// the shapes it refused said. The dashboard's test send reports it.
export async function trySendEmail(env: Env, msg: EmailMessageIn): Promise<EmailOutcome> {
  if (await emailsHeld(env.DB)) {
    return {
      status: 'held', via: 'nothing: email is off in Settings', shape: '', name_kept: false,
      from: env.EMAIL_FROM || DEFAULT_FROM, refused: []
    };
  }
  if (env.EMAIL) return sendViaBinding(env, msg);
  if (configured(env.EMAIL_API_KEY)) return sendViaResend(env, msg);
  return {
    status: 'skipped', via: 'nothing configured', shape: '', name_kept: false,
    from: env.EMAIL_FROM || DEFAULT_FROM, refused: []
  };
}

// Callers that only record 'sent' / 'failed' / 'skipped' keep taking
// the string.
export async function sendEmail(env: Env, msg: EmailMessageIn): Promise<EmailStatus> {
  return (await trySendEmail(env, msg)).status;
}

// ---------- the switch, on the Settings tab ----------
// GET email/hold and POST email/hold {held}, both Settings (dash-access.ts).
export async function emailHoldRead(env: Env): Promise<Response> {
  return json({ ok: true, held: await emailsHeld(env.DB) });
}

export async function emailHoldSet(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var on = body.held === true || body.held === 1 || body.held === '1';
  await env.DB.prepare(
    "INSERT INTO site_flags (name, value) VALUES ('email_held', ?1) ON CONFLICT(name) DO UPDATE SET value = ?1"
  ).bind(on ? 1 : 0).run();
  await logAction(env.DB, session.name, on ? 'email-hold' : 'email-release', '-', on ? 'no email goes out' : 'email goes out', 0, 0, 0);
  return json({ ok: true, held: on });
}

export function escapeHtml(text: unknown): string {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
