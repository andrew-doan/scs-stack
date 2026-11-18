/* The terms and waiver. Opened from a confirmation email the address
   carries ?k=, that person's own key: the page says who the link is for
   and takes their acceptance and their own answer to the photo question,
   which the worker records against that one person (handleTerms in
   tab/src/rego.js). The answer goes with the acceptance; once accepted,
   changing it saves on its own. Without a key the page is the terms and
   nothing else. */
(function () {
  'use strict';

  var scs = window.scs;
  var key = '';
  try { key = new URLSearchParams(location.search).get('k') || ''; } catch (err) { /* no key */ }
  if (!key) return;

  var whoLine = document.getElementById('tc-who-line');
  var whoError = document.getElementById('tc-who-error');
  var accept = document.getElementById('tc-accept');
  var btn = document.getElementById('tc-accept-btn');
  var status = document.getElementById('tc-status');
  var photoBox = document.getElementById('tc-photo');
  var photoStatus = document.getElementById('tc-photo-status');
  var photoRadios = Array.prototype.slice.call(document.querySelectorAll('input[name="tc-photo"]'));
  var API = scs.TAB_API + '/api/rego/terms';
  var accepted = false;

  function photoAnswer() {
    var picked = photoRadios.filter(function (r) { return r.checked; })[0];
    return picked ? picked.value === '1' : null;
  }

  function draw(d) {
    whoError.classList.add('is-hidden');
    whoLine.classList.remove('is-hidden');
    accepted = !!d.accepted_at;
    photoBox.classList.remove('is-hidden');
    if (d.photo !== null && d.photo !== undefined) {
      photoRadios.forEach(function (r) { r.checked = (r.value === '1') === d.photo; });
    }
    // the worker names somebody not yet placed in a team 'No team yet'
    var who = d.name + (d.team === 'No team yet' ? ', not on a team yet' : ', team ' + d.team);
    if (d.accepted_at) {
      whoLine.textContent = who + ': accepted ' + scs.fmtTime(d.accepted_at, true) + '.';
    } else {
      whoLine.textContent = 'For ' + who + '. Read them through, then answer the photo question and accept them at the end of the page.';
      accept.classList.remove('is-hidden');
    }
  }

  function cannot(text) {
    whoLine.classList.add('is-hidden');
    whoError.textContent = text;
    whoError.classList.remove('is-hidden');
    accept.classList.add('is-hidden');
    photoBox.classList.add('is-hidden');
  }

  scs.fetch(API + '?k=' + encodeURIComponent(key), { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (d && d.ok) draw(d);
      else cannot((d && d.error) || 'This link could not be checked. Reload the page to try again.');
    })
    .catch(function () {
      cannot('This link could not be checked. Reload the page to try again.');
    });

  function fail(message) {
    scs.swapText(status, message);
    status.classList.add('is-error');
    scs.shake(btn);
  }

  // after accepting, a changed answer is saved by itself
  photoRadios.forEach(function (radio) {
    radio.addEventListener('change', function () {
      photoStatus.classList.remove('is-error');
      if (!accepted || !radio.checked) { scs.swapText(photoStatus, ''); return; }
      scs.swapText(photoStatus, 'Saving…');
      scs.postJson(API, { k: key, photo: radio.value === '1', accept: false })
        .then(function (res) {
          if (res.status === 200 && res.data.ok) scs.swapText(photoStatus, 'Saved.');
          else { photoStatus.classList.add('is-error'); scs.swapText(photoStatus, res.data.error || 'That did not save. Try again.'); }
        })
        .catch(function () {
          photoStatus.classList.add('is-error');
          scs.swapText(photoStatus, 'Could not reach the server. Try again.');
        });
    });
  });

  btn.addEventListener('click', function () {
    status.classList.remove('is-error');
    var photo = photoAnswer();
    if (photo === null) return fail('Answer the photo question first.');
    btn.disabled = true;
    btn.classList.add('is-busy');
    scs.swapText(status, 'Saving…');
    scs.postJson(API, { k: key, photo: photo })
      .then(function (res) {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        if (res.status === 200 && res.data.ok && res.data.accepted_at) {
          draw(res.data);
          btn.classList.add('is-hidden');
          scs.swapText(status, 'Accepted ' + scs.fmtTime(res.data.accepted_at, true) + '.');
        } else {
          fail(res.data.error || 'That did not go through. Try again.');
        }
      })
      .catch(function () {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        fail('Could not reach the server. Try again.');
      });
  });
})();
