// Web Push from a Worker, no library: the Node web-push package can't
// run here, so the two protocol pieces are done directly on WebCrypto —
// VAPID (RFC 8292: an ES256 JWT proving we hold the key the browser
// subscribed with) and payload encryption (RFC 8291: ECDH + HKDF +
// AES-128-GCM in the aes128gcm framing). The round-trip is proved by
// tests/verify-push.mjs, which decrypts a captured push with Node's
// own crypto.

import { b64url, drain } from './shared.ts';
import type { Env, PushSubRow } from './types.ts';

// How long a push service keeps a message, how hard it tries, and the
// topic a later message with the same one replaces it under.
export interface PushOpts {
  ttl?: string;
  urgency?: string;
  topic?: string;
}

var enc = new TextEncoder();
var NUL = String.fromCharCode(0);

export function unb64url(text: unknown): Uint8Array {
  var pad = '===='.slice(0, (4 - (String(text).length % 4)) % 4);
  var bin = atob(String(text).replace(/-/g, '+').replace(/_/g, '/') + pad);
  var out = new Uint8Array(bin.length);
  for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  var total = 0;
  var i;
  for (i = 0; i < parts.length; i++) total += parts[i].length;
  var out = new Uint8Array(total);
  var at = 0;
  for (i = 0; i < parts.length; i++) { out.set(parts[i], at); at += parts[i].length; }
  return out;
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, bytes: number): Promise<Uint8Array> {
  var key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt, info: info }, key, bytes * 8
  ));
}

// RFC 8291: encrypt a payload for one subscription's keys.
export async function encryptPayload(plaintext: string, p256dhB64: string, authB64: string): Promise<Uint8Array> {
  var uaPublic = unb64url(p256dhB64);   // the browser's P-256 point, 65 bytes
  var authSecret = unb64url(authB64);   // its 16-byte auth secret
  var asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']) as CryptoKeyPair;
  var asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey) as ArrayBuffer);
  var uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // the runtime reads `public`, as WebCrypto names it; workers-types calls it $public
  var ecdh = { name: 'ECDH', public: uaKey } as SubtleCryptoDeriveKeyAlgorithm;
  var shared = new Uint8Array(await crypto.subtle.deriveBits(ecdh, asKeys.privateKey, 256));

  var ikm = await hkdf(shared, authSecret, concat([enc.encode('WebPush: info' + NUL), uaPublic, asPublic]), 32);
  var salt = crypto.getRandomValues(new Uint8Array(16));
  var cek = await hkdf(ikm, salt, enc.encode('Content-Encoding: aes128gcm' + NUL), 16);
  var nonce = await hkdf(ikm, salt, enc.encode('Content-Encoding: nonce' + NUL), 12);

  var padded = concat([enc.encode(plaintext), new Uint8Array([2])]); // 0x02 marks the last record
  var aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  var cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, padded));

  // aes128gcm framing: salt, record size, then our public key as the key id
  var header = new Uint8Array(16 + 4 + 1 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = 65;
  header.set(asPublic, 21);
  return concat([header, cipher]);
}

// RFC 8292: the vapid Authorization header for one push service origin.
export async function vapidAuth(endpoint: string, env: Env): Promise<string> {
  var pub = unb64url(env.VAPID_PUBLIC_KEY);
  var jwk = {
    kty: 'EC', crv: 'P-256', ext: true,
    d: env.VAPID_PRIVATE_KEY,
    x: b64url(pub.slice(1, 33)),
    y: b64url(pub.slice(33, 65))
  };
  var key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  var claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || 'https://scs.andyrew.space'
  };
  var input = b64url(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' }))) + '.' +
    b64url(enc.encode(JSON.stringify(claims)));
  var sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(input)));
  return 'vapid t=' + input + '.' + b64url(sig) + ', k=' + env.VAPID_PUBLIC_KEY;
}

// One push to one device. 'dead' means the subscription is gone and
// its row should be deleted; iOS also revokes subs that get pushes
// without visible notifications, so payloads always carry title+body.
// opts tier the message: urgency (very-low/low/normal/high — low ones
// wait for a dozing phone to wake) and topic (an undelivered message
// with the same topic is REPLACED by the next one, so a phone that
// was offline gets the latest, not the whole backlog).
export async function sendPush(env: Env, sub: Pick<PushSubRow, 'endpoint' | 'p256dh' | 'auth'>, payload: unknown, opts?: PushOpts): Promise<'ok' | 'dead' | 'fail'> {
  opts = opts || {};
  try {
    var headers: Record<string, string> = {
      authorization: await vapidAuth(sub.endpoint, env),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: opts.ttl || '3600',
      urgency: opts.urgency || 'normal'
    };
    if (opts.topic) headers.topic = opts.topic;
    var body = await encryptPayload(JSON.stringify(payload), sub.p256dh, sub.auth);
    var resp = await fetch(sub.endpoint, {
      method: 'POST',
      headers: headers,
      body: body
    });
    await drain(resp);
    if (resp.status === 404 || resp.status === 410) return 'dead';
    return resp.ok ? 'ok' : 'fail';
  } catch (err) {
    return 'fail';
  }
}
