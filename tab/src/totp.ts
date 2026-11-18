// The dashboard's second factor: a six-digit code from an
// authenticator app, the printable codes that stand in when the phone
// with it is dead or lost, and the QR that enrols one.
//
// TOTP is RFC 6238 — HMAC-SHA1 over the number of 30-second steps since
// the epoch, truncated to six digits — and every piece of it is on
// WebCrypto, so nothing is vendored here but the QR encoder. SHA-1 is
// the algorithm every authenticator app implements and the only one
// some of them implement; it is used as a MAC over a shared secret and
// a counter, which is not the use its collision weakness touches.
//
// The secret never leaves the worker except once, at enrolment, in the
// QR and the line of text beside it.
import { qrcode } from './vendor/qrcode.js';

var STEP = 30;          // seconds a code lasts
var DIGITS = 6;
var SKEW = 1;           // how many steps either side are accepted
var SECRET_BYTES = 20;  // what RFC 4226 says an HMAC-SHA1 key should be
var B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes: Uint8Array): string {
  var out = '';
  var bits = 0;
  var value = 0;
  for (var i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i];
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;   // no padding: every app reads it, and '=' in a URL is noise
}

// Spaces, hyphens and lower case are all things a person types when
// they copy a secret by hand, so none of them are an error.
export function base32Decode(text: unknown): Uint8Array | null {
  var clean = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  var bytes: number[] = [];
  var bits = 0;
  var value = 0;
  for (var i = 0; i < clean.length; i++) {
    var n = B32.indexOf(clean[i]);
    if (n < 0) return null;
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

export function randomSecret(): string {
  var bytes = new Uint8Array(SECRET_BYTES);
  crypto.getRandomValues(bytes);
  return base32Encode(bytes);
}

// Read back in fours, which is how the apps print it and how a person
// types it without losing their place.
export function secretInGroups(secret: string | null | undefined): string {
  return String(secret || '').replace(/(.{4})/g, '$1 ').trim();
}

export function stepNow(nowMs?: number): number {
  return Math.floor((nowMs === undefined ? Date.now() : nowMs) / 1000 / STEP);
}

async function hmacSha1(keyBytes: Uint8Array, msgBytes: Uint8Array): Promise<Uint8Array> {
  var key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, msgBytes));
}

export async function codeAt(secret: string, step: number): Promise<string> {
  var key = base32Decode(secret);
  if (!key || !key.length) return '';
  // the counter as eight bytes, big-endian; the top four are zero for
  // any time this century
  var msg = new Uint8Array(8);
  var n = step;
  for (var i = 7; i >= 0; i--) {
    msg[i] = n & 255;
    n = Math.floor(n / 256);
  }
  var mac = await hmacSha1(key, msg);
  var off = mac[mac.length - 1] & 15;
  var bin = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  var digits = String(bin % Math.pow(10, DIGITS));
  while (digits.length < DIGITS) digits = '0' + digits;
  return digits;
}

// Answers the step the code belongs to, or -1. The step is what the
// caller stores so the same code cannot be used twice: a code is good
// for thirty seconds and anyone who reads it over a shoulder has the
// rest of that window to use it.
export async function verifyCode(secret: string, typed: unknown, nowMs?: number, sinceStep?: number | null): Promise<number> {
  var clean = String(typed || '').replace(/\s/g, '');
  if (!/^[0-9]{6}$/.test(clean)) return -1;
  var now = stepNow(nowMs);
  for (var d = -SKEW; d <= SKEW; d++) {
    var step = now + d;
    if (sinceStep && step <= sinceStep) continue;
    var want = await codeAt(secret, step);
    // constant time over six digits is theatre, but it costs nothing
    if (want.length === DIGITS && timingSafe(want, clean)) return step;
  }
  return -1;
}

function timingSafe(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  var diff = 0;
  for (var i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// otpauth://totp/<issuer>:<name>?secret=…&issuer=… — the label carries
// the issuer as well as the name because that is what the apps show in
// their list, and a row reading only a first name is no use on a phone
// that holds codes for a dozen things.
export function otpauthUrl(name: string, secret: string, issuer: string): string {
  var label = encodeURIComponent(issuer) + ':' + encodeURIComponent(name);
  return 'otpauth://totp/' + label +
    '?secret=' + secret +
    '&issuer=' + encodeURIComponent(issuer) +
    '&algorithm=SHA1&digits=' + DIGITS + '&period=' + STEP;
}

// The QR as an SVG data URI, so the page sets one img src and nothing
// is written into the document as markup. Drawn here rather than
// fetched because a secret must not travel to another service to be
// made into a picture.
export function qrDataUri(text: string): string {
  var qr = qrcode(0, 'M');   // 0 = the smallest version the text fits in
  qr.addData(text);
  qr.make();
  var n = qr.getModuleCount();
  var quiet = 4;             // modules of white border, per the spec
  var size = n + quiet * 2;
  var path = '';
  for (var r = 0; r < n; r++) {
    for (var c = 0; c < n; c++) {
      if (qr.isDark(r, c)) path += 'M' + (c + quiet) + ' ' + (r + quiet) + 'h1v1h-1z';
    }
  }
  var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + size + ' ' + size + '" ' +
    'shape-rendering="crispEdges"><rect width="' + size + '" height="' + size + '" fill="#fff"/>' +
    '<path d="' + path + '" fill="#000"/></svg>';
  return 'data:image/svg+xml;base64,' + b64(svg);
}

function b64(text: string): string {
  var bytes = new TextEncoder().encode(text);
  var bin = '';
  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

// The codes that stand in for the app. Ten of them, in two groups of
// four from an alphabet with no 0/O/1/I/L in it, because these get read
// off paper under pressure and written into a box by someone who has
// just lost their phone.
var CODE_ALPHA = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function makeBackupCodes(count?: number): string[] {
  var out: string[] = [];
  var bytes = new Uint8Array((count || 10) * 8);
  crypto.getRandomValues(bytes);
  for (var i = 0; i < (count || 10); i++) {
    var code = '';
    for (var k = 0; k < 8; k++) code += CODE_ALPHA[bytes[i * 8 + k] % CODE_ALPHA.length];
    out.push(code.slice(0, 4) + '-' + code.slice(4));
  }
  return out;
}

export function cleanBackupCode(typed: unknown): string {
  return String(typed || '').toUpperCase().replace(/[^0-9A-Z]/g, '');
}

export async function hashBackupCode(code: unknown): Promise<string> {
  var bytes = new TextEncoder().encode('scs2-backup:' + cleanBackupCode(code));
  var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  var hex = '';
  for (var i = 0; i < digest.length; i++) hex += (digest[i] + 256).toString(16).slice(1);
  return hex;
}
