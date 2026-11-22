// Signing in to the dashboard takes two steps now: the shared password,
// then a six-digit code from the authenticator app that name enrolled.
// A test has no phone, so it reads the secret out of the enrolment
// answer and works the code out itself.
//
// The code is worked out here from node:crypto rather than from the
// worker's own totp.js, deliberately: a test that asks the worker to
// check its own arithmetic proves nothing. This is a second
// implementation of RFC 6238, and the two have to agree.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(text) {
  const clean = String(text || '').toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const n = B32.indexOf(ch);
    if (n < 0) throw new Error('not base32: ' + ch);
    value = (value << 5) | n;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

// RFC 6238 with the defaults every authenticator app uses: SHA-1, six
// digits, thirty-second steps.
export function totpAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const off = mac[mac.length - 1] & 15;
  const bin = ((mac[off] & 127) << 24) | (mac[off + 1] << 16) | (mac[off + 2] << 8) | mac[off + 3];
  return String(bin % 1000000).padStart(6, '0');
}

export function totpNow(secret, atMs) {
  return totpAt(secret, Math.floor((atMs === undefined ? Date.now() : atMs) / 30000));
}

// One call for what a person does over two screens: type the password,
// scan the QR, type the first code. Answers whatever the second request
// answered, so a caller reads `.session` exactly as it used to.
export async function consoleSignIn(jpost, name, password, opts) {
  const first = await (await jpost('/api/console/login',
    Object.assign({ password, name }, (opts && opts.extra) || {}))).json();
  if (first.session || !first.secret) return first;
  const code = totpNow(first.secret.replace(/\s/g, ''));
  // whatever went with the first step goes with the second: the
  // enrolment password guards confirming a code as well as asking for one
  const out = await (await jpost('/api/console/login',
    Object.assign({ password, name, code }, (opts && opts.extra) || {}))).json();
  // the secret comes back with it, so a caller that wants to sign the
  // same name in again later can make its own codes
  if (out.session) out.secret = first.secret;
  return out;
}
