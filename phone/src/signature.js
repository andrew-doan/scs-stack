// Twilio signs each request it makes: the base64 HMAC-SHA1, keyed by
// the account's auth token, of the request's full address followed by
// every form field's name and value, the fields in name order. It
// arrives in X-Twilio-Signature.

function b64(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export async function twilioSignature(token, url, fields) {
  var text = url;
  Object.keys(fields).sort().forEach(function (k) { text += k + fields[k]; });
  var enc = new TextEncoder();
  var key = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  return b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(text))));
}

// Compared as hashes, so the time taken says nothing about how much of
// a guess was right.
async function same(a, b) {
  var enc = new TextEncoder();
  var ha = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(a)));
  var hb = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(b)));
  var diff = 0;
  for (var i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i];
  return diff === 0;
}

export async function signedByTwilio(token, url, fields, given) {
  if (!token || !given) return false;
  return same(await twilioSignature(token, url, fields), String(given));
}
