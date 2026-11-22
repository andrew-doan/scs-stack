// The tab's instructions for a call, written as TwiML. The words
// themselves come from the tab; the one line kept here is for when the
// tab cannot be reached.

var VOICE = ' language="en-AU"';
export var TAB_DOWN = 'Something went wrong. Try again in a minute.';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function twiml(inner) {
  return new Response('<?xml version="1.0" encoding="UTF-8"?><Response>' + inner + '</Response>', {
    headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' }
  });
}

function say(text) {
  return '<Say' + VOICE + '>' + esc(text) + '</Say>';
}

// Where the caller's keys or recording come back to: the step and what
// the call has said so far, both the tab's, carried in the address.
function back(path, to) {
  return path + '?node=' + encodeURIComponent(to.node || '') + '&s=' + encodeURIComponent(to.state || '');
}

// actions: [{say}, {gather: {digits, say, to}}, {record: {max, to}}, {hangup}]
export function render(actions) {
  var out = '';
  (actions || []).forEach(function (a) {
    if (a.say) out += say(a.say);
    else if (a.gather) {
      out += '<Gather input="dtmf" numDigits="' + (Number(a.gather.digits) || 1) + '" timeout="8" action="' +
        esc(back('/voice/step', a.gather.to)) + '" method="POST">' + say(a.gather.say) + '</Gather>';
    } else if (a.record) {
      out += '<Record maxLength="' + (Number(a.record.max) || 60) + '" playBeep="true" finishOnKey="#" action="' +
        esc(back('/voice/step', a.record.to)) + '" method="POST" recordingStatusCallback="' +
        esc(back('/voice/recorded', a.record.to)) + '" recordingStatusCallbackMethod="POST" recordingStatusCallbackEvent="completed"/>';
    } else if (a.hangup) out += '<Hangup/>';
  });
  return out;
}

export function down() {
  return twiml(say(TAB_DOWN) + '<Hangup/>');
}
