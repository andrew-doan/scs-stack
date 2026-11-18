// What an SCS email looks like: the site's signage, rebuilt in the
// subset of HTML that email clients actually render.
//
// Kept apart from rego.ts because the two change for different
// reasons — what the message says, and what it looks like — and
// because the look is the part with rules attached to it.
//
// The rules of the medium, which are why none of this looks like the
// site's CSS:
//
//   Tables, not flex or grid. Outlook renders through Word, which has
//   no layout engine worth the name. Every row here is a table row.
//   Inline styles, not classes. Gmail strips <style> from a forwarded
//   message and several clients strip it outright, so the only
//   declarations that can be relied on are the ones on the element.
//   The <style> block below is used for the one thing it is good for —
//   a width media query — and nothing in it is load-bearing.
//   Literal hex, not custom properties. `var()` does not resolve.
//   No background-image. Outlook drops it, and the design does not
//   need one: every surface here is a flat colour.
//   `color-scheme: light only`. Apple Mail and iOS otherwise invert the
//   whole message in dark mode, and aged paper inverted is a grey-brown
//   nobody chose. The site has a real dark theme; an email cannot, so
//   it asks to be left alone instead of being turned inside out.
//
// What degrades, and to what: `border-radius` and `box-shadow` are
// ignored by Outlook's engine, so the 2px corners square off and the
// hard offset shadow disappears. Both are right when they fail — a
// square corner is what the rest of the design system uses anyway, and
// a missing shadow costs depth, not meaning. Nothing is only legible
// because of either.

import { escapeHtml } from './email.ts';

// The light theme's tokens, copied as literals because `var()` does
// not resolve in mail. These are the names from website/assets/
// site.css; if one changes there it has to be changed here, and
// tests/verify-email.mjs checks the two agree.
export var INK = {
  page: '#f2f3f5',
  card: '#ffffff',
  text: '#111111',
  muted: '#616161',
  border: '#d5d5d5',
  tint: '#e7e8eb',
  accent: '#00933c',
  onAccent: '#ffffff',
  sign: '#131313',
  signInk: '#ffffff',
  signMuted: 'rgba(255, 255, 255, 0.72)',
  red: '#ee352e',
  orange: '#ff6319',
  yellow: '#fccc0a',
  green: '#00933c',
  blue: '#0039a6'
};

// The five routes running in parallel along the edge of every bar.
export var STRIPE = [INK.red, INK.orange, INK.yellow, INK.green, INK.blue];

// One row of the details block: the label, the value (HTML), and the
// icon beside it when it has one.
export type DetailRow = [string, string] | [string, string, string];

// button(): `wide` the ticket card's width, `fill` whatever holds it,
// `icon` an icon before the words.
export interface ButtonOpts {
  wide?: boolean;
  fill?: boolean;
  icon?: string;
}

export interface ParagraphOpts {
  end?: boolean;
  center?: boolean;
  size?: number;
  colour?: string;
}

// A picture across the top of the message.
export interface Banner {
  src: string;
  alt?: string;
  href?: string;
  height?: number;
}

// The whole message: the rows of its sheet, the line under them, the
// preview line and the document's title.
export interface ShellOpts {
  banner?: Banner | null;
  body: string;
  footer?: string;
  preheader?: string;
  title?: string;
  heading?: string;
}

export var FONT = "'Helvetica Neue', Helvetica, Arial, sans-serif";
var SHADOW = '3px 3px 0 rgba(17, 17, 17, 0.14)';
var WIDTH = 600;

function table(inner: string, attrs?: string): string {
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" ' +
    (attrs || '') + '>' + inner + '</table>';
}

// A run of colour across the full width. 5px, the same as the site's
// nav and footer edges. The cells carry a non-breaking space because
// several clients collapse an empty one; font-size and line-height at
// zero keep it from adding height.
export function stripe(): string {
  var cells = STRIPE.map(function (colour) {
    return '<td width="20%" height="5" bgcolor="' + colour + '" ' +
      'style="background-color:' + colour + ';height:5px;font-size:0;line-height:0;">&nbsp;</td>';
  }).join('');
  return '<tr><td style="font-size:0;line-height:0;">' +
    table('<tr>' + cells + '</tr>', 'width="100%"') + '</td></tr>';
}

// ---- the header ----
//
// The title animation's map with the sign and the S C S 2 discs, as a
// 3:1 banner at 1200x400 so it is sharp at the sheet's 600 and takes
// 200 of its height. The site serves it at a fixed address,
// website/assets/email/header-banner.png, and tests/verify-email.mjs
// checks the file is there at that size. The taller 16:9 frame before
// it is still at header.png, because every email sent with it points
// there; a different shape is a new file, never one saved over the old.
//
// It was drawn here in table cells, which needed nothing hosted and
// drew where a client holds pictures back, but could not carry the 45
// degree doglegs and so never looked like the map. A client that holds
// pictures back shows the alt text instead, set in the sign's face on
// the paper, and the message under it is whole without the picture.
export var HEADER: Banner = {
  src: 'https://scs.andyrew.space/assets/email/header-banner.png',
  alt: 'Legends of the City, SCS.2',
  href: 'https://scs.andyrew.space',
  height: 200
};

// The uppercase muted label the site puts over a value. Written
// uppercase rather than transformed: text-transform is not carried by
// every client, and a label that arrives in sentence case reads as a
// different design.
export function label(text: unknown): string {
  return '<div style="font-family:' + FONT + ';font-size:11px;line-height:1.3;font-weight:bold;' +
    'letter-spacing:0.09em;color:' + INK.muted + ';">' + escapeHtml(String(text).toUpperCase()) + '</div>';
}

// The icons beside the details, on the check-in note and in the link
// buttons: the ticket page's outlines (and Discord's mark) as pictures,
// because mail clients do not draw SVG. scripts/email-icons.cjs draws
// them into website/assets/email/icon-<name>.png at three times their
// 24px, in the ink, on nothing, and the site serves them. They carry no
// alt text: each sits beside words that say the same thing, and a
// client that holds pictures back keeps the space rather than closing
// it up.
export var ICONS = 'https://scs.andyrew.space/assets/email/';

export function icon(name: string, size?: number): string {
  var px = size || 24;
  return '<img src="' + ICONS + 'icon-' + name + '.png" alt="" width="' + px + '" height="' + px + '" ' +
    'style="display:block;width:' + px + 'px;height:' + px + 'px;border:0;" />';
}

// An icon in a column of its own with what goes beside it, both on the
// icon's middle line. The icon stands 14px in from the edge with 14px
// to the words, so it sits in the middle of the space before them, the
// way the ticket page sets its rows; the note's box puts its own edge
// where the rows' rule starts, so its icon lines up with theirs.
// The two gaps are cells of their own rather than padding, since
// Outlook reads a cell's width attribute with its padding inside it.
function withIcon(name: string, html: string): string {
  var gap = '<td width="14" style="width:14px;font-size:0;line-height:0;">&nbsp;</td>';
  return table('<tr>' + gap + '<td width="24" valign="middle" style="width:24px;">' + icon(name) + '</td>' + gap +
    '<td valign="middle">' + html + '</td></tr>', 'width="100%"');
}

// Label over value, one to a row, ruled off from the next, with the
// row's icon beside it when it names one. The departure-board block:
// what, when, where.
export function details(rows: (DetailRow | false | null | undefined)[]): string {
  var body = rows.filter(function (row): row is DetailRow { return !!row; }).map(function (row, i) {
    var words = label(row[0]) +
      '<div style="font-family:' + FONT + ';font-size:17px;line-height:1.35;font-weight:bold;' +
      'color:' + INK.text + ';padding-top:3px;">' + row[1] + '</div>';
    return '<tr><td style="padding:' + (i ? '12px' : '0') + ' 0 12px;' +
      'border-bottom:1px solid ' + INK.border + ';">' +
      (row[2] ? withIcon(row[2], words) : words) + '</td></tr>';
  }).join('');
  return table(body, 'width="100%"');
}

// The one thing to remember, in a grey box with its icon: the ticket
// page's note. As wide as the ticket card and its button, so the three
// read as one column.
export function note(name: string, html: string): string {
  return table('<tr><td bgcolor="' + INK.tint + '" style="background-color:' + INK.tint + ';' +
    'border-radius:2px;padding:12px 14px 12px 0;">' +
    withIcon(name, '<div style="font-family:' + FONT + ';font-size:15px;line-height:1.4;color:' + INK.text + ';">' +
      html + '</div>') +
    '</td></tr>', 'width="100%" align="center" style="width:100%;max-width:320px;margin:0 auto;"');
}

// A button, written as a table so the whole rectangle is the link
// rather than the words inside it. Green by default; `kind` true or
// 'dark' is the black one, 'line' the keyline on the paper for a link
// beside the actions (the 2px edge comes off the padding, so all three
// are one height). It sits in the middle of the column (`align` for
// Outlook, auto margins for everything else). `o.wide` stretches it to
// the ticket card's width, `o.fill` to whatever holds it, and `o.icon`
// names an icon to go before the words, at 20px on their middle line.
export function button(href: string, text: string, kind?: boolean | 'dark' | 'line', opts?: ButtonOpts): string {
  var o: ButtonOpts = opts || {};
  var line = kind === 'line';
  var bg = line ? INK.card : kind ? INK.sign : INK.accent;
  var ink = line ? INK.text : INK.onAccent;
  var cell = 'background-color:' + bg + ';border-radius:2px;' +
    (line ? 'border:2px solid ' + INK.text + ';' : '');
  return table(
    '<tr><td bgcolor="' + bg + '" align="center" style="' + cell + '">' +
    '<a href="' + escapeHtml(href) + '" style="display:block;padding:' + (line ? '11px 24px' : '13px 26px') + ';' +
    'font-family:' + FONT + ';font-size:16px;font-weight:bold;line-height:' + (o.icon ? '20px' : '1.2') + ';' +
    'color:' + ink + ';text-decoration:none;">' +
    // The icon fills the line from top to bottom: the line is 20px and so
    // is the icon, so it is centred on the words by arithmetic rather than
    // by `middle`, which every client measures from a different place.
    (o.icon ? '<img src="' + ICONS + 'icon-' + o.icon + '.png" alt="" width="20" height="20" ' +
      'style="display:inline-block;width:20px;height:20px;border:0;vertical-align:top;margin:0 10px 0 0;" />' : '') +
    escapeHtml(text) + '</a>' +
    '</td></tr>', o.fill
      ? 'width="100%" style="width:100%;border-collapse:separate;"'
      : 'align="center"' + (o.wide ? ' width="100%"' : '') +
        ' style="' + (o.wide ? 'width:100%;max-width:320px;' : '') + 'margin:0 auto;border-collapse:separate;"');
}

// Buttons side by side in the middle of the column, each its own block
// of one width, so a narrow screen puts the second under the first at
// the same size rather than squeezing both. Outlook's Word engine
// ignores inline-block and stacks them, which reads the same way. Build
// the buttons with `fill`.
export function buttonRow(buttons: string[]): string {
  return '<div style="font-size:0;line-height:0;text-align:center;">' + buttons.map(function (b) {
    return '<div style="display:inline-block;vertical-align:top;width:236px;margin:0 5px 10px;">' + b + '</div>';
  }).join('') + '</div>';
}

// Vertical space. A div with a height, because margins on tables and
// paragraphs are dropped or doubled by one client or another.
export function gap(px: number): string {
  return '<div style="height:' + px + 'px;font-size:0;line-height:0;">&nbsp;</div>';
}

// A hairline across the sheet, between what the message is for and the
// links after it.
export function rule(): string {
  return table('<tr><td height="1" bgcolor="' + INK.border + '" style="background-color:' + INK.border + ';' +
    'height:1px;font-size:0;line-height:0;">&nbsp;</td></tr>', 'width="100%"');
}

// `o.end` is a paragraph that ends its part of the message: no margin
// under it, so the gap that follows is the whole of the space.
// `o.center` sets it in the middle, over a button or the ticket.
export function paragraph(html: string, opts?: ParagraphOpts): string {
  var o: ParagraphOpts = opts || {};
  return '<p style="margin:0 0 ' + (o.end ? 0 : 14) + 'px;' + (o.center ? 'text-align:center;' : '') +
    'font-family:' + FONT + ';font-size:' + (o.size || 15) + 'px;' +
    'line-height:1.55;color:' + (o.colour || INK.text) + ';">' + html + '</p>';
}

export function link(href: string, text?: string | null): string {
  return '<a href="' + escapeHtml(href) + '" style="color:' + INK.accent + ';font-weight:bold;">' +
    escapeHtml(text == null ? href : text) + '</a>';
}

// The ticket: the code in a paper frame with a name plate under it,
// the way a station sign sits under the platform it names.
export function ticketCard(opts: { name: string; team: string; src: string }): string {
  var plate = '<tr><td bgcolor="' + INK.sign + '" style="background-color:' + INK.sign + ';' +
    'padding:12px 16px;font-family:' + FONT + ';">' +
    '<div style="font-size:17px;line-height:1.25;font-weight:bold;color:' + INK.signInk + ';">' +
    escapeHtml(opts.name) + '</div>' +
    '<div style="font-size:13px;line-height:1.4;color:' + INK.signMuted + ';padding-top:2px;">' +
    escapeHtml(opts.team) + '</div></td></tr>';
  var image = '<tr><td align="center" bgcolor="#ffffff" style="background-color:#ffffff;padding:18px;">' +
    // 220 in the attributes, which is what Outlook reads and what the
    // image really is, and fluid in the CSS, which is what everything
    // else reads: at 220 fixed the frame could not shrink below 326 and
    // a 320px phone scrolled sideways.
    '<img src="' + escapeHtml(opts.src) + '" alt="Your check-in QR code" width="220" height="220" ' +
    'style="display:block;width:100%;max-width:220px;height:auto;border:0;" /></td></tr>';
  // 320 rather than the full width: the code is 220 across, and a
  // 600-wide frame around it reads as a picture that failed to fill
  // its box rather than as a ticket.
  // Capped at 320 rather than set to it: the code is 220 across and a
  // 600-wide frame around it reads as a picture that failed to fill its
  // box. A width *attribute* of 320 would also become the table's
  // smallest width, and on a 380px phone that pushes the whole message
  // sideways — so the cap is a max-width and the table is still 100%.
  return table(image + plate,
    'width="100%" align="center" style="width:100%;max-width:320px;margin:0 auto;border:1px solid ' + INK.border +
    ';border-radius:2px;"');
}

// A picture across the top of the message: the header above, or the
// dashboard's banner test send, which puts its own in the same place.
// The height is the picture's own at the sheet's width, so a client
// that holds pictures back keeps the space rather than closing it up.
function bannerRow(banner: Banner): string {
  var img = '<img src="' + escapeHtml(banner.src) + '" alt="' + escapeHtml(banner.alt || '') + '" ' +
    'width="' + WIDTH + '"' + (banner.height ? ' height="' + banner.height + '"' : '') + ' ' +
    'style="display:block;width:100%;max-width:' + WIDTH + 'px;height:auto;border:0;' +
    'font-family:' + FONT + ';font-size:22px;font-weight:bold;line-height:1.3;color:' + INK.text + ';" />';
  return '<tr><td bgcolor="' + INK.page + '" style="background-color:' + INK.page + ';font-size:0;line-height:0;">' +
    (banner.href ? '<a href="' + escapeHtml(banner.href) + '" style="color:' + INK.text + ';text-decoration:none;">' +
      img + '</a>' : img) +
    '</td></tr>';
}

// The whole document. `body` is already-built rows of the inner table;
// everything around it is the same on every message we send.
export function shell(opts: ShellOpts): string {
  var o: ShellOpts = opts || { body: '' };
  // A banner stands in for the header rather than sitting above it.
  var sheet = table(
    stripe() +
    bannerRow(o.banner || HEADER) +
    '<tr><td bgcolor="' + INK.card + '" style="background-color:' + INK.card + ';padding:24px 22px;">' +
    o.body + '</td></tr>' +
    (o.footer
      ? '<tr><td bgcolor="' + INK.card + '" style="background-color:' + INK.card + ';' +
        'padding:0 22px 22px;border-top:0;">' + o.footer + '</td></tr>'
      : '') +
    stripe(),
    'width="' + WIDTH + '" class="sheet" style="width:' + WIDTH + 'px;max-width:' + WIDTH + 'px;' +
    'border-radius:2px;box-shadow:' + SHADOW + ';"');

  // The hidden line inboxes show beside the subject. Padded, or the
  // client fills the rest of the preview with whatever comes next.
  var preheader = '<div style="display:none;max-height:0;overflow:hidden;font-size:1px;' +
    'line-height:1px;color:' + INK.page + ';opacity:0;">' + escapeHtml(o.preheader || '') +
    '&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;&#8203;&nbsp;</div>';

  return '<!DOCTYPE html>\n' +
    '<html lang="en"><head>' +
    '<meta charset="utf-8" />' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />' +
    '<meta name="color-scheme" content="light only" />' +
    '<meta name="supported-color-schemes" content="light only" />' +
    '<title>' + escapeHtml(o.title || o.heading) + '</title>' +
    '<style>@media only screen and (max-width: 620px) {' +
    '.sheet { width: 100% !important; }' +
    '}</style>' +
    '</head>' +
    '<body style="margin:0;padding:0;background-color:' + INK.page + ';">' +
    preheader +
    table('<tr><td align="center" style="padding:24px 12px;">' + sheet + '</td></tr>',
      'width="100%" bgcolor="' + INK.page + '" style="background-color:' + INK.page + ';"') +
    '</body></html>';
}
