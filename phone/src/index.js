// The phone side of the payphone quest. Twilio answers the event's
// number and asks this worker what to do: POST /voice when a call
// starts, POST /voice/step when the caller's keys or a recording come
// back, POST /voice/recorded when a recording's audio is ready. The
// tab worker decides what a call does (its phone tree is edited on the
// dashboard), and this worker turns its answer into TwiML.
//
// Nothing is kept here. Every request is checked against Twilio's
// signature first, since anything else could claim any payphone for
// any team.
import { signedByTwilio } from './signature.js';
import { twiml, render, down } from './say.js';

function configured(v) {
  return !!v && String(v).indexOf('PASTE') !== 0;
}

async function formOf(request) {
  var out = {};
  new URLSearchParams(await request.text()).forEach(function (v, k) { out[k] = v; });
  return out;
}

function tab(env, path, init) {
  init.headers = Object.assign({ authorization: 'Bearer ' + env.PHONE_SYNC_KEY }, init.headers || {});
  return fetch(env.TAB_API + path, init);
}

// What the call does next, from the tab.
async function step(env, url, fields) {
  try {
    var r = await tab(env, '/api/phone/step', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        node: url.searchParams.get('node') || '', state: url.searchParams.get('s') || '',
        digits: fields.Digits || '', from: fields.From || '', call: fields.CallSid || '',
        recorded: !!fields.RecordingUrl
      })
    });
    if (!r.ok) { console.error('phone: the tab answered', r.status); return null; }
    var d = await r.json();
    return d && Array.isArray(d.actions) ? d.actions : null;
  } catch (err) {
    console.error('phone: the tab could not be reached', err);
    return null;
  }
}

// A finished recording: its audio is fetched from Twilio with the
// account's own key, handed to the tab, and then deleted at Twilio so
// the only copy is the event's.
async function recorded(env, url, fields) {
  if (fields.RecordingStatus && fields.RecordingStatus !== 'completed') return;
  var from = String(fields.RecordingUrl || '');
  var sid = String(fields.RecordingSid || '');
  var account = String(fields.AccountSid || '');
  if (!sid || !account || from.indexOf('https://api.twilio.com/') !== 0) return;
  var auth = { authorization: 'Basic ' + btoa(account + ':' + env.TWILIO_AUTH_TOKEN) };
  var audio = await fetch(from + '.mp3', { headers: auth });
  if (!audio.ok) throw new Error('recording ' + audio.status);
  var query = '?rec=' + encodeURIComponent(sid) + '&call=' + encodeURIComponent(fields.CallSid || '') +
    '&node=' + encodeURIComponent(url.searchParams.get('node') || '') + '&state=' + encodeURIComponent(url.searchParams.get('s') || '') +
    '&seconds=' + encodeURIComponent(fields.RecordingDuration || '0');
  var kept = await tab(env, '/api/phone/message' + query, { method: 'POST', headers: { 'content-type': 'audio/mpeg' }, body: await audio.arrayBuffer() });
  if (!kept.ok) throw new Error('the tab answered ' + kept.status);
  await fetch('https://api.twilio.com/2010-04-01/Accounts/' + encodeURIComponent(account) + '/Recordings/' + encodeURIComponent(sid) + '.json',
    { method: 'DELETE', headers: auth });
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);
    var paths = ['/voice', '/voice/step', '/voice/recorded'];
    if (request.method !== 'POST' || paths.indexOf(url.pathname) === -1) {
      return new Response('SCS.2 phone. Twilio posts calls here.', { status: request.method === 'GET' && url.pathname === '/' ? 200 : 404 });
    }
    var fields = await formOf(request);
    if (!configured(env.TWILIO_AUTH_TOKEN) || !configured(env.PHONE_SYNC_KEY) ||
        !(await signedByTwilio(env.TWILIO_AUTH_TOKEN, request.url, fields, request.headers.get('x-twilio-signature')))) {
      return new Response('not signed', { status: 403 });
    }

    if (url.pathname === '/voice/recorded') {
      // a failure answers 500, and Twilio sends the notice again
      try { await recorded(env, url, fields); } catch (err) {
        console.error('phone: a recording was not kept', err);
        return new Response('not kept', { status: 500 });
      }
      return new Response(null, { status: 204 });
    }

    var actions = await step(env, url, fields);
    return actions ? twiml(render(actions)) : down();
  }
};
