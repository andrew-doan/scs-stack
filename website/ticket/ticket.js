/* The ticket page reads one base64url blob from the link:
   /ticket/?<blob>. Its first byte is 2, then the check-in token's length,
   the token's bytes and "name\nteam" in UTF-8, and the QR is drawn right
   here: no image fetch, works offline. Error codes on the page: E1 no
   token, E2 the token does not decode, E3 it decodes to something that
   is not a ticket. */
(function () {
  'use strict';
  var box = document.getElementById('tk-qr');
  var haveName = false;

  // held up to a scanner: no browser install banner over it
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); });

  // What each error means, and what the person holding the phone can do
  // about it. All three mean the link is wrong, so each says which way
  // it is wrong rather than three copies of one sentence. They end at
  // the same place, which is
  // written into the page: an organiser at the door can check somebody
  // in by name.
  var FAULTS = {
    E1: ['This link has no ticket code in it.',
      'Open the link in your confirmation email again. Copying part of an address leaves the code behind.'],
    E2: ['The ticket code in this link could not be read.',
      'The address looks cut short or changed. Open the link in your confirmation email again.'],
    E3: ['This link does not hold a ticket.',
      'It may be an old link, or the address may be wrong. Open the link in your confirmation email again.']
  };

  // The code panel is emptied and the fault takes its place. The stub
  // stays: the time and the place are still true, and they are what a
  // person with a broken link needs next.
  function fail(code) {
    var say = FAULTS[code] || FAULTS.E3;
    box.classList.add('is-hidden');
    document.querySelector('.tk-note').classList.add('is-hidden');
    document.getElementById('tk-why').textContent = say[0];
    document.getElementById('tk-do').textContent = say[1];
    document.getElementById('tk-code').textContent = code;
    document.getElementById('tk-missing').classList.remove('is-hidden');
    document.getElementById('ticket').classList.add('is-empty');
    // The board says what happened when it has no name to show.
    if (!haveName) {
      document.getElementById('tk-name').textContent = 'This ticket did not open';
      document.title = 'Ticket did not open | SCS.2';
    }
  }

  function decodeBytes(token) {
    var b64 = token.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  }

  function b64url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  // the same drawing the check-in worker does: EC level M, 4 quiet
  // modules, 8 pixels a module, black on white in every theme
  function drawQr(text) {
    var qr = window.scs2qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var n = qr.getModuleCount();
    var quiet = 4;
    var scale = 8;
    var size = (n + quiet * 2) * scale;
    var canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Your check-in QR code');
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (var r = 0; r < n; r++) {
      for (var c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((quiet + c) * scale, (quiet + r) * scale, scale, scale);
      }
    }
    return canvas;
  }

  function showDetails(name, team) {
    if (name.length > 120 || team.length > 120) return fail('E3');
    if (name) {
      document.getElementById('tk-name').textContent = name;
      document.title = 'Ticket for ' + name + ' | SCS.2';
      haveName = true;
    }
    if (team) {
      var teamEl = document.getElementById('tk-team');
      teamEl.textContent = team;
      teamEl.classList.remove('is-hidden');
    }
  }

  var raw = location.search.replace(/^\?/, '').split('&')[0];
  if (!raw) return fail('E1');

  var bytes = null;
  try { bytes = decodeBytes(raw); } catch (err) { bytes = null; }
  if (!bytes || !bytes.length) return fail('E2');

  if (bytes[0] === 2) {
    // the token travels in the link: draw the code here
    var len = bytes[1];
    if (!len || bytes.length < 2 + len) return fail('E3');
    var token = b64url(bytes.slice(2, 2 + len));
    var meta;
    try { meta = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(2 + len)); } catch (err) {
      return fail('E3');
    }
    try { box.appendChild(drawQr('scs2:' + token)); } catch (err) {
      return fail('E3');
    }
    var lines = meta.split('\n');
    return showDetails((lines[0] || '').trim(), (lines[1] || '').trim());
  }

  // any other first byte is a link this page does not read
  fail('E3');
})();
