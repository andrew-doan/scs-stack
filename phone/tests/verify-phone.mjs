// Run with: node tests/verify-phone.mjs
// The phone worker against requests signed the way Twilio signs them,
// with the tab worker and Twilio's API stood in for by a fetch stub.
// The signature here is worked out with node:crypto, not the worker's
// own code.
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let fail = 0;
const check = (label, ok, detail) => {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) fail++;
};

const mod = await import(ROOT + '/src/index.js');
const ENV = { TWILIO_AUTH_TOKEN: 'twilio-token-for-tests', PHONE_SYNC_KEY: 'phone-key-phone-key', TAB_API: 'https://tab.example' };
const HOST = 'https://phone.example';

function sign(token, url, fields) {
  let text = url;
  Object.keys(fields).sort().forEach(k => { text += k + fields[k]; });
  return crypto.createHmac('sha1', token).update(text, 'utf8').digest('base64');
}
function twilio(path, fields, opts = {}) {
  const url = HOST + path;
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (opts.signature !== null) headers['x-twilio-signature'] = opts.signature || sign(opts.token || ENV.TWILIO_AUTH_TOKEN, url, opts.signed || fields);
  return mod.default.fetch(new Request(url, { method: 'POST', headers, body: new URLSearchParams(fields).toString() }), opts.env || ENV);
}

// the tab and Twilio's API, answering what the test tells them to
let tabActions = [{ say: 'Hello.' }, { hangup: true }];
let saw = [];
let tabDown = false;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  const seen = { url, method: init.method || 'GET', auth: init.headers && init.headers.authorization };
  if (typeof init.body === 'string') seen.body = JSON.parse(init.body);
  else if (init.body) seen.bytes = init.body.byteLength;
  saw.push(seen);
  if (url.startsWith('https://api.twilio.com/')) {
    if (seen.method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  }
  if (tabDown) throw new Error('down');
  return new Response(JSON.stringify({ ok: true, actions: tabActions, kept: true }), { status: 200, headers: { 'content-type': 'application/json' } });
};

const CALL = { CallSid: 'CA123', From: '+61293850001', To: '+61290000000', AccountSid: 'AC999' };

// the worker's signer against node:crypto's, on the request in Twilio's
// own documentation
const { twilioSignature } = await import(ROOT + '/src/signature.js');
const docFields = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
const doc = await twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', docFields);
check('the signature agrees with node:crypto', doc === sign('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', docFields), doc);

const refused = [
  (await twilio('/voice', CALL, { signature: null })).status,
  (await twilio('/voice', CALL, { token: 'another-token' })).status,
  // signed for one caller, sent claiming another
  (await twilio('/voice/step?node=capture&s=%7B%7D', Object.assign({ Digits: '123456' }, CALL, { From: '+61293859999' }), { signed: Object.assign({ Digits: '123456' }, CALL) })).status,
  // signed for one step, sent to another
  (await twilio('/voice/step?node=other&s=%7B%7D', CALL, { signature: sign(ENV.TWILIO_AUTH_TOKEN, HOST + '/voice/step?node=capture&s=%7B%7D', CALL) })).status,
  (await twilio('/voice', CALL, { env: Object.assign({}, ENV, { TWILIO_AUTH_TOKEN: 'PASTE the token' }) })).status
];
check('unsigned, signed with another token, changed after signing, or with no token set: refused, and the tab is never asked',
  refused.join() === '403,403,403,403,403' && saw.length === 0, refused.join() + ' ' + saw.length);

tabActions = [
  { gather: { digits: 6, say: 'Key in your PIN.', to: { node: 'capture', state: '{"n":1}' } } },
  { say: 'Tom & Jerry <Lane>' },
  { record: { max: 45, to: { node: 'leave', state: '{"t":7,"w":"rec"}' } } },
  { hangup: true }
];
let r = await twilio('/voice', CALL);
let x = await r.text();
check('a new call asks the tab where to start, under the shared key',
  saw.length === 1 && saw[0].url === 'https://tab.example/api/phone/step' && saw[0].auth === 'Bearer phone-key-phone-key' &&
  saw[0].body.node === '' && saw[0].body.from === '+61293850001' && saw[0].body.call === 'CA123', JSON.stringify(saw[0]));
const stepBack = '/voice/step?node=capture&amp;s=' + encodeURIComponent('{"n":1}');
check('the tab’s steps come out as TwiML: keys asked for, words escaped, a recording with both its addresses',
  r.status === 200 && x.includes('<Gather input="dtmf" numDigits="6" timeout="8" action="' + stepBack + '" method="POST"><Say language="en-AU">Key in your PIN.</Say></Gather>') &&
  x.includes('Tom &amp; Jerry &lt;Lane&gt;') && /<Record maxLength="45"[^>]*action="\/voice\/step\?node=leave&amp;s=[^"]+"[^>]*recordingStatusCallback="\/voice\/recorded\?node=leave&amp;s=[^"]+"/.test(x) &&
  x.trim().endsWith('<Hangup/></Response>'), x);

saw = [];
await twilio('/voice/step?node=capture&s=' + encodeURIComponent('{"n":1}'), Object.assign({ Digits: '123456' }, CALL));
check('keys come back to the tab with the step and what the call had said',
  saw.length === 1 && saw[0].body.node === 'capture' && saw[0].body.state === '{"n":1}' && saw[0].body.digits === '123456' && saw[0].body.recorded === false,
  JSON.stringify(saw[0]));

saw = [];
const REC = { AccountSid: 'AC999', CallSid: 'CA123', RecordingSid: 'RE555', RecordingUrl: 'https://api.twilio.com/2010-04-01/Accounts/AC999/Recordings/RE555', RecordingStatus: 'completed', RecordingDuration: '12' };
r = await twilio('/voice/recorded?node=leave&s=' + encodeURIComponent('{"t":7,"w":"rec"}'), REC);
const basic = 'Basic ' + Buffer.from('AC999:' + ENV.TWILIO_AUTH_TOKEN).toString('base64');
check('a finished recording is fetched from Twilio, handed to the tab with whose it is, and deleted at Twilio',
  r.status === 204 && saw.length === 3 &&
  saw[0].url === REC.RecordingUrl + '.mp3' && saw[0].auth === basic &&
  saw[1].url.startsWith('https://tab.example/api/phone/message?rec=RE555&call=CA123&node=leave&state=') && saw[1].url.endsWith('&seconds=12') &&
  saw[1].bytes === 5 && saw[1].auth === 'Bearer phone-key-phone-key' &&
  saw[2].method === 'DELETE' && saw[2].url.endsWith('/Recordings/RE555.json'), JSON.stringify(saw));

saw = [];
r = await twilio('/voice/recorded?node=leave&s=%7B%7D', Object.assign({}, REC, { RecordingUrl: 'https://elsewhere.example/steal' }));
check('a recording address that is not Twilio’s is never fetched', saw.length === 0, JSON.stringify(saw));

tabDown = true;
x = await (await twilio('/voice', CALL)).text();
r = await twilio('/voice/recorded?node=leave&s=%7B%7D', REC);
check('with the tab unreachable a caller is told to try again, and a recording is left at Twilio to be sent again',
  x.includes('Try again in a minute') && r.status === 500 && !saw.some(s => s.method === 'DELETE'), x + ' ' + r.status);

if (fail) { console.log('\n' + fail + ' check(s) failed'); process.exit(1); }
console.log('\nALL CHECKS PASSED');
