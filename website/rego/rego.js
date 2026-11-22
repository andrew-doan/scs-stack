/* Team registration — one person fills this in for the whole team, or
   signs up without one (on their own or with one other person) for the
   organisers to place. Member cards are built here so the page grows to
   fit; the worker re-checks everything server-side, creates the team
   (or not), mints check-in QRs and emails every member, each with their
   own link to accept the terms and waiver: nobody accepts them for
   anybody else. */
(function () {
  'use strict';

  var scs = window.scs;
  var MIN_MEMBERS = 3;
  var MAX_MEMBERS = 5;
  var MAX_SOLO = 2;
  // 'team', or 'solo' for a signup without a team. In solo mode only the
  // first soloCount cards are part of the signup; the rest are hidden,
  // not thrown away, so switching back keeps what was typed in them.
  var mode = 'team';
  var soloCount = 1;
  function soloMode() { return mode === 'solo'; }
  function shown() { return soloMode() ? cards.slice(0, soloCount) : cards; }
  var SOCIETIES = [
    'WestSoc', 'WanderSoc', 'PuzzleSoc', 'Asian Studies Association',
    'PhotoSoc', 'RailSoc', 'Rhythm Games Society', 'Tabletop Games Society',
    'Queer Students in STEM', 'GeoGuessrSoc', 'Chess Club'
  ];
  var DIETARY = ['Vegetarian', 'Vegan', 'Kosher', 'Halal', 'Gluten-free', 'Nut-free / anaphylaxis'];

  var membersWrap = document.getElementById('rg-members');
  var statusEl = document.getElementById('rg-status');

  // ---------- is the form open, and does it want the human check ----------
  // The worker's status read says whether signups are being taken
  // (closed by hand, or full against the cap) and hands over the
  // Turnstile site key while the human check is on. The worker
  // enforces all of it again on the send, so this is only the page
  // matching what the send would say.
  var turnstileId = null;
  function mountTurnstile(sitekey) {
    var slot = document.getElementById('rg-turnstile');
    if (!slot) return;
    window.scsTurnstileReady = function () {
      try {
        turnstileId = window.turnstile.render(slot, { sitekey: sitekey, theme: 'auto' });
      } catch (err) { /* the widget is Cloudflare's; a render failure reads as no token and the send says so */ }
    };
    if (window.turnstile) { window.scsTurnstileReady(); return; }
    scs.needScript('https://challenges.cloudflare.com/turnstile/v0/api.js?onload=scsTurnstileReady&render=explicit');
  }
  function turnstileToken() {
    if (!window.turnstile || turnstileId === null) return '';
    try { return window.turnstile.getResponse(turnstileId) || ''; } catch (err) { return ''; }
  }
  function resetTurnstile() {
    if (!window.turnstile || turnstileId === null) return;
    try { window.turnstile.reset(turnstileId); } catch (err) { /* a fresh token next send */ }
  }
  function readStatus() {
  scs.fetch(scs.TAB_API + '/api/rego/status', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (d) {
      scs.gotIt('rego-status');
      if (!d || !d.ok) return;
      if (!d.open) {
        document.getElementById('rg-closed-msg').textContent = d.message || 'Registrations are closed.';
        document.getElementById('rg-closed').classList.remove('is-hidden');
        document.getElementById('rego-form').classList.add('is-hidden');
      } else if (d.turnstile) {
        mountTurnstile(d.turnstile);
      }
    })
    .catch(function () { scs.again('rego-status', readStatus); });
  }
  readStatus();
  var cards = [];

  // ---------- societies (asked of whoever fills the form) ----------
  var socWrap = document.getElementById('rg-societies');
  function socBox(name) {
    var label = document.createElement('label');
    label.className = 'rg-check';
    var box = document.createElement('input');
    box.type = 'checkbox';
    box.value = name;
    var text = document.createElement('span');
    text.textContent = name;
    label.appendChild(box);
    label.appendChild(text);
    socWrap.appendChild(label);
    return box;
  }
  var socBoxes = SOCIETIES.map(socBox);
  // None of the above sends no societies, the same as ticking nothing,
  // and takes the other ticks off; ticking a society takes it off.
  var socNone = socBox('None of the above');
  socNone.addEventListener('change', function () {
    if (socNone.checked) socBoxes.forEach(function (b) { b.checked = false; });
  });
  socBoxes.forEach(function (b) {
    b.addEventListener('change', function () { if (b.checked) socNone.checked = false; });
  });

  // ---------- member cards ----------
  function field(labelText, type, autocomplete) {
    var wrap = document.createElement('label');
    wrap.className = 'sub-field';
    var caption = document.createElement('span');
    caption.textContent = labelText;
    var input = document.createElement('input');
    input.type = type || 'text';
    if (autocomplete) input.autocomplete = autocomplete;
    wrap.appendChild(caption);
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  function addMember() {
    if (soloMode()) {
      if (soloCount >= MAX_SOLO) return;
      soloCount++;
      if (cards.length >= soloCount) { layout(); return; }
    }
    if (cards.length >= MAX_MEMBERS) return;
    var index = cards.length;
    var card = document.createElement('div');
    card.className = 'card rg-member';

    var head = document.createElement('div');
    head.className = 'rg-head rg-member-head';
    var title = document.createElement('span');
    head.appendChild(title);
    // A team's first three are the smallest team there can be, so only
    // the fourth and fifth can be taken off again; without a team the
    // second person can. layout() decides which cards show the button.
    var remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.addEventListener('click', function () {
      if (soloMode()) {
        // hidden rather than deleted: back in team mode they are a member
        soloCount = 1;
        layout();
        return;
      }
      cards = cards.filter(function (c) { return c.card !== card; });
      layout();
      // the card drops out on the quick clock, then leaves the page
      card.classList.add('is-leaving');
      window.setTimeout(function () {
        if (card.parentNode) membersWrap.removeChild(card);
      }, scs.reducedMotion ? 0 : scs.ms('--duration-quick', 150));
    });
    head.appendChild(remove);
    card.appendChild(head);
    var body = document.createElement('div');
    body.className = 'rg-member-body';
    card.appendChild(body);

    var name = field('Full name', 'text', index === 0 ? 'name' : 'off');
    var two = document.createElement('div');
    two.className = 'rg-two';
    var zid = field('zID (z0000000 if not UNSW)', 'text', 'off');
    zid.input.placeholder = 'z5123456';
    var email = field('Email (no UNSW emails, e.g. z1234567@ad.unsw.edu.au)', 'email', index === 0 ? 'email' : 'off');
    two.appendChild(zid.wrap);
    two.appendChild(email.wrap);
    var discord = field(index === 0 ? 'Discord username' : 'Discord username (optional)', 'text', 'off');

    var arcLabel = document.createElement('p');
    arcLabel.className = 'rg-label';
    arcLabel.textContent = 'Arc member?';
    var arcYes = document.createElement('label');
    arcYes.className = 'rg-radio';
    var arcYesInput = document.createElement('input');
    arcYesInput.type = 'radio';
    arcYesInput.name = 'rg-arc-' + index + '-' + Date.now();
    var yesText = document.createElement('span');
    yesText.textContent = 'Yes';
    arcYes.appendChild(arcYesInput);
    arcYes.appendChild(yesText);
    var arcNo = arcYes.cloneNode(false);
    arcNo.className = 'rg-radio';
    var arcNoInput = arcYesInput.cloneNode(false);
    var noText = document.createElement('span');
    noText.textContent = 'No';
    arcNo.appendChild(arcNoInput);
    arcNo.appendChild(noText);

    var dietLabel = document.createElement('p');
    dietLabel.className = 'rg-label';
    dietLabel.textContent = 'Dietary requirements (for the BBQ)';
    var dietWrap = document.createElement('div');
    dietWrap.className = 'rg-checks';
    var dietBoxes = DIETARY.map(function (option) {
      var label = document.createElement('label');
      label.className = 'rg-check';
      var box = document.createElement('input');
      box.type = 'checkbox';
      box.value = option;
      var text = document.createElement('span');
      text.textContent = option;
      label.appendChild(box);
      label.appendChild(text);
      dietWrap.appendChild(label);
      return box;
    });
    var dietOther = field('Other dietary needs, with allergy severity', 'text', 'off');

    body.appendChild(name.wrap);
    body.appendChild(two);
    body.appendChild(discord.wrap);
    body.appendChild(arcLabel);
    body.appendChild(arcYes);
    body.appendChild(arcNo);
    body.appendChild(dietLabel);
    body.appendChild(dietWrap);
    body.appendChild(dietOther.wrap);
    membersWrap.appendChild(card);

    // the card is titled with the name typed into it
    name.input.addEventListener('input', layout);

    cards.push({
      card: card,
      title: title,
      remove: remove,
      name: name.input,
      zid: zid.input,
      email: email.input,
      discord: discord.input,
      arcYes: arcYesInput,
      arcNo: arcNoInput,
      dietBoxes: dietBoxes,
      dietOther: dietOther.input
    });
    layout();
  }

  var addBtn = document.getElementById('rg-add');
  var sendBtn = document.getElementById('rg-send');

  // What a card is called until a name is typed into it.
  function placeholderTitle(i) {
    return i === 0 ? 'You' : 'Member ' + (i + 1);
  }
  function cardTitle(c, i) {
    return c.name.value.trim() || placeholderTitle(i);
  }

  // Everything that differs between a team and a signup without one.
  function layout() {
    var solo = soloMode();
    cards.forEach(function (c, i) {
      c.card.hidden = solo && i >= soloCount;
      c.title.textContent = cardTitle(c, i);
      c.remove.hidden = solo ? !(i === 1 && soloCount > 1) : i < MIN_MEMBERS;
    });
    document.getElementById('rg-team-field').hidden = solo;
    document.getElementById('rg-team-head').textContent = solo ? 'About you' : (document.getElementById('rg-team').value.trim() || 'Team');
    addBtn.hidden = solo && soloCount >= MAX_SOLO;
    addBtn.disabled = !solo && cards.length >= MAX_MEMBERS;
    sendBtn.textContent = solo ? 'Sign up' : 'Register the team';
  }

  for (var n = 0; n < MIN_MEMBERS; n++) addMember();

  // Something typed and not sent: the browser asks before the page is
  // closed or reloaded, in its own words.
  var sent = false;
  window.addEventListener('beforeunload', function (e) {
    if (sent) return;
    var typed = Array.prototype.some.call(
      document.querySelectorAll('#rego-form input[type="text"], #rego-form input[type="email"], #rego-form input:not([type]), #rego-form textarea'),
      function (box) { return box.value.trim() !== ''; });
    if (!typed) return;
    e.preventDefault();
    e.returnValue = '';
  });
  addBtn.addEventListener('click', addMember);
  document.getElementById('rg-team').addEventListener('input', layout);
  Array.prototype.forEach.call(document.querySelectorAll('input[name="rg-mode"]'), function (radio) {
    radio.addEventListener('change', function () {
      if (!radio.checked) return;
      mode = radio.value === 'solo' ? 'solo' : 'team';
      while (!soloMode() && cards.length < MIN_MEMBERS) addMember();
      layout();
    });
  });

  // ---------- send ----------
  function collect() {
    var photo = document.querySelector('input[name="rg-photo"]:checked');
    return {
      solo: soloMode(),
      team_name: soloMode() ? '' : document.getElementById('rg-team').value,
      societies: socBoxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; }),
      photo_permission: photo ? photo.value === '1' : null,
      questions: document.getElementById('rg-questions').value,
      website: document.getElementById('rg-website').value,
      turnstile: turnstileToken(),
      members: shown().map(function (c) {
        var diets = c.dietBoxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
        if (c.dietOther.value.trim()) diets.push(c.dietOther.value.trim());
        return {
          name: c.name.value,
          zid: c.zid.value,
          email: c.email.value,
          discord: c.discord.value,
          arc: c.arcYes.checked,
          dietary: diets.join('; ')
        };
      })
    };
  }

  // The worker refuses these too; asking here saves the round trip.
  function unswEmail(value) {
    var domain = String(value || '').trim().toLowerCase().split('@').pop();
    return domain === 'unsw.edu.au' || /\.unsw\.edu\.au$/.test(domain);
  }

  function fail(message) {
    scs.swapText(statusEl, message);
    statusEl.classList.add('is-error');
    scs.shake(sendBtn);
  }

  sendBtn.addEventListener('click', function () {
    scs.swapText(statusEl, '');
    statusEl.classList.remove('is-error');
    var body = collect();
    var people = shown();
    if (!body.solo && !body.team_name.trim()) return fail('Your team needs a name.');
    if (body.photo_permission === null) return fail('Answer the photo permission question.');
    if (!body.solo && body.members.length < MIN_MEMBERS) return fail('A team is three to five people.');
    for (var i = 0; i < body.members.length; i++) {
      var m = body.members[i];
      var who = i === 0 ? 'You' : cardTitle(people[i], i);
      if (!m.name.trim()) return fail(who + ' need' + (i === 0 ? '' : 's') + ' a full name.');
      if (!m.email.trim()) return fail(who + ' need' + (i === 0 ? '' : 's') + ' an email address.');
      if (unswEmail(m.email)) return fail(who + ': use an email that is not a UNSW one.');
      if (!people[i].arcYes.checked && !people[i].arcNo.checked) return fail(who + ': answer the Arc member question.');
    }

    sendBtn.disabled = true;
    sendBtn.classList.add('is-busy');
    scs.swapText(statusEl, 'Registering…');
    scs.postJson(scs.TAB_API + '/api/rego/create', body)
      .then(function (res) {
        sendBtn.disabled = false;
        sendBtn.classList.remove('is-busy');
        if (res.status === 200 && res.data.ok) {
          sent = true;
          document.getElementById('rego-form').classList.add('is-hidden');
          var done = document.getElementById('rego-done');
          done.classList.remove('is-hidden');
          scs.rise(done);
          var n = res.data.members;
          document.getElementById('rg-done-line').textContent = res.data.solo
            ? 'You are signed up without a team. You will be assigned a team shortly and emailed when this happens.'
            : 'Team ' + res.data.team + ' is registered: ' + n + (n === 1 ? ' person' : ' people') + '. See you on Tuesday 20 October.';
          document.getElementById('rg-done-each').textContent = res.data.solo
            ? 'Make sure to accept the terms and waiver from the link in your email.'
            : 'Reminder that each person accepts the terms and waiver for themselves, using the link in their email. Please make sure to remind your teammates to open their email and accept the terms and waiver.';
          // the person filling the form is the first member, so the
          // worker hands their own terms link back; the others are emailed
          if (res.data.terms_url) {
            document.getElementById('rg-done-terms-link').href = res.data.terms_url;
            document.getElementById('rg-done-terms').classList.remove('is-hidden');
          }
          done.scrollIntoView();
        } else {
          resetTurnstile(); // tokens are single-use; a failed send needs a fresh one
          fail(res.data.error || 'That did not go through. Try again.');
        }
      })
      .catch(function () {
        resetTurnstile();
        sendBtn.disabled = false;
        sendBtn.classList.remove('is-busy');
        fail('Could not reach the server. Try again.');
      });
  });
})();
