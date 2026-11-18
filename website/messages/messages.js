/* Messages — announcements from OrgComm, in the order the worker sent
   them. The copy on this device is shown at once and the worker's is
   fetched behind it, so the page reads the same offline as on. A
   message drawn here is read: the bell in the top bar drops its dot.

   The newest message is drawn on the black board at the top when it is
   flagged urgent, and the rest read below it. That is a place on the
   page, not a reordering: the board only ever takes the first message
   the payload carries. */
(function () {
  'use strict';

  var scs = window.scs;
  var listEl = document.getElementById('msg-list');
  var statusEl = document.getElementById('msg-status');
  var noticeEl = document.getElementById('msg-notice');
  var logEl = document.getElementById('msg-log');
  var logHeadEl = document.getElementById('msg-log-head');
  var CACHE_KEY = 'scs2-messages-cache';
  var showing = null; // the payload on screen, as text, so a same answer is left alone

  function fileUrl(key) {
    return scs.TAB_API + '/api/messages/file?key=' + encodeURIComponent(key);
  }
  // a GIF is asked for whole: the only still of one is its first
  // frame, which is the picture not moving
  function thumbUrl(key, type) {
    return fileUrl(key) + (scs.animatedType(type) ? '' : '&thumb=1');
  }

  // The small copy shows first; the whole picture is fetched once that
  // has loaded and takes its place when it is ready.
  function sharpen(img, file) {
    if (scs.animatedType(file.type)) return;
    var done = false;
    img.addEventListener('load', function () {
      if (done) return;
      done = true;
      var full = new Image();
      full.crossOrigin = 'anonymous';
      full.onload = function () {
        var swap = function () { img.src = full.src; };
        if (full.decode) full.decode().then(swap, swap); else swap();
      };
      full.src = fileUrl(file.key);
    });
  }

  function fmtBytes(n) {
    n = Number(n);
    if (!isFinite(n) || n <= 0) return '';
    if (n > 1024 * 1024 * 1024) return (Math.round(n / (1024 * 1024 * 1024) * 10) / 10) + ' GB';
    if (n > 1024 * 1024) return (Math.round(n / (1024 * 1024) * 10) / 10) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  function isImage(file) {
    return String(file && file.type || '').indexOf('image/') === 0;
  }

  // ---------- one message ----------
  // The time identifies it, the headline and the body are read, and
  // everything that came attached sits in the third column. `notice` is
  // the same message drawn on the board at the top of the page.
  function card(msg, notice) {
    var article = document.createElement('article');
    article.className = notice ? 'msg-card msg-row msg-notice' : 'msg-card msg-row';

    var key = document.createElement('div');
    key.className = 'msg-key';
    var stamp = String(msg.created_at || '');
    if (stamp) {
      var when = document.createElement('time');
      when.className = 'msg-time';
      when.setAttribute('datetime', stamp.replace(' ', 'T') + 'Z');
      when.textContent = scs.fmtTime(stamp);
      key.appendChild(when);
    }
    // only urgent says anything; silent and ordinary messages read the same
    if (String(msg.urgency || '') === 'urgent') {
      var flag = document.createElement('p');
      flag.className = 'msg-urgent';
      flag.textContent = 'Urgent';
      key.appendChild(flag);
    }
    article.appendChild(key);

    var title = document.createElement('h2');
    title.className = 'msg-title';
    title.textContent = msg.title || '';
    article.appendChild(title);

    if (msg.body) {
      var body = document.createElement('div');
      body.className = 'msg-body md';
      scs.messageBody(body, msg.body); // markdown + quest embeds
      article.appendChild(body);
    }

    var files = msg.files || [];
    var shots = files.filter(isImage);
    var rest = files.filter(function (f) { return !isImage(f); });
    var rail = document.createElement('div');
    rail.className = 'msg-rail';

    if (shots.length) {
      // a tap opens the picture in place
      var viewItems = shots.map(function (f) {
        return { url: fileUrl(f.key), thumb: thumbUrl(f.key, f.type), type: f.type, name: f.name || '' };
      });
      var grid = document.createElement('div');
      grid.className = 'msg-shots';
      shots.forEach(function (f, i) {
        var open = document.createElement('button');
        open.type = 'button';
        open.className = 'msg-shot';
        var img = document.createElement('img');
        img.crossOrigin = 'anonymous'; // readable to the worker, so it can keep a copy
        img.alt = f.name || (msg.title || 'Attachment');
        sharpen(img, f);
        open.appendChild(img);
        scs.keepPicture(img, thumbUrl(f.key, f.type));
        open.addEventListener('click', function () {
          scs.lightbox(viewItems, i, img);
        });
        grid.appendChild(open);
      });
      rail.appendChild(grid);
    }

    if (rest.length) {
      var list = document.createElement('ul');
      list.className = 'msg-files';
      rest.forEach(function (f) {
        var row = document.createElement('li');
        var link = document.createElement('a');
        link.href = fileUrl(f.key);
        link.textContent = f.name || 'Attachment';
        row.appendChild(link);
        var size = fmtBytes(f.bytes);
        if (size) {
          var bytes = document.createElement('span');
          bytes.className = 'msg-file-size';
          bytes.textContent = size;
          row.appendChild(bytes);
        }
        list.appendChild(row);
      });
      rail.appendChild(list);
    }

    // an empty cell is an empty cell: the column stays where it is
    if (rail.firstChild) article.appendChild(rail);

    return article;
  }

  // The newest message goes on the board when it is flagged urgent —
  // it is the only thing here that changes what somebody does in the
  // next hour. Everything else reads in the order the worker sent it.
  function render(messages) {
    noticeEl.textContent = '';
    listEl.textContent = '';
    var lead = messages[0];
    var promoted = !!(lead && String(lead.urgency || '') === 'urgent');
    var rest = promoted ? messages.slice(1) : messages;
    if (promoted) noticeEl.appendChild(card(lead, true));
    // In the app layout the bar is the page's name, so the masthead is
    // hidden and the board carries the urgent message alone. With no
    // urgent message it carries nothing, and a band of black holding
    // nothing is not a band: messages.css takes it off the page.
    noticeEl.parentNode.classList.toggle('has-notice', promoted);
    logHeadEl.classList.toggle('is-hidden', !promoted || !rest.length);
    logEl.classList.toggle('has-head', promoted && rest.length > 0);
    logEl.classList.toggle('is-hidden', promoted && !rest.length);
    if (!messages.length) {
      statusEl.textContent = 'Nothing from OrgCom yet.';
      return;
    }
    statusEl.textContent = '';
    if (!rest.length) return;
    listEl.classList.add('t-rise-list'); // the first messages rise in on a stagger
    rest.forEach(function (msg) { listEl.appendChild(card(msg, false)); });
  }

  function show(data, text) {
    if (text === showing) return;
    showing = text;
    render((data && data.messages) || []);
  }

  // Every time on this page comes out of scs.fmtTime, so flipping the
  // settings menu's Hide dates rocker changes all of them — and nothing
  // here redraws itself, so it is told to. `showing` is what stops an
  // unchanged payload re-rendering, and this is the one case where the
  // same payload has to be drawn again.
  document.addEventListener('scs-dates-changed', function () {
    var text = showing;
    if (!text) return;
    showing = null;
    try { show(JSON.parse(text), text); } catch (err) { showing = text; }
  });

  // The messages drawn are the ones read, and no others: the bell drops
  // their dot without waiting for the next page load.
  function markRead(messages, fresh) {
    var seqs = messages.map(function (m) { return Number(m.seq) || 0; });
    // a list from a worker that sends no seq: what the pulse names
    var unnumbered = fresh && messages.some(function (m) { return m.seq === undefined; });
    scs.pulse().then(function (pulse) {
      if (unnumbered) seqs = pulse ? (pulse.message_seqs || [pulse.messages]) : [];
      scs.readMessages(seqs);
    });
  }

  // A signed-in team reads its own list, which can hold messages the
  // public one does not, so the copy kept on the device says whose it is
  // and is never painted for anyone else.
  function load() {
    var cached = null;
    try { cached = localStorage.getItem(CACHE_KEY); } catch (err) { cached = null; }
    if (cached) {
      try {
        var kept = JSON.parse(cached);
        if ((kept.seenBy || '') !== scs.reader()) cached = null;
        else {
          show(kept, cached);
          markRead(kept.messages || [], false);
        }
      } catch (err) { cached = null; }
    }
    scs.readAs('/api/messages', '/api/messages/team')
      .then(function (data) {
        if (!data || !Array.isArray(data.messages)) throw new Error('messages shape');
        data.seenBy = scs.reader();
        var text = JSON.stringify(data);
        try { localStorage.setItem(CACHE_KEY, text); } catch (err) { /* not persisted */ }
        scs.gotIt('messages');
        show(data, text);
        markRead(data.messages, true);
      })
      .catch(function () {
        // the copy on the device stands; with nothing to show, say so
        if (!cached) statusEl.textContent = 'Messages could not load. Check your connection.';
        scs.again('messages', load);
      });
  }

  // ---------- notifications ----------
  // The same helper the settings menu runs on, so both switches mean
  // the same thing and say the same thing.
  var pushCheck = document.getElementById('msg-push');
  var pushHint = document.getElementById('msg-push-hint');
  var pushBusy = false;

  function setPushHint(text) {
    if (!pushHint) return;
    scs.pushSub.paint(pushHint, text || '');
    pushHint.classList.toggle('is-hidden', !text);
  }

  function syncPush() {
    return scs.pushSub.state().then(function (state) {
      pushCheck.checked = state === 'on';
      if (state === 'denied') setPushHint(scs.pushSub.hint('denied'));
      return state;
    }).catch(function () { /* stays off */ });
  }

  if (pushCheck) {
    if (!scs.pushSub.supported()) {
      pushCheck.disabled = true;
      // on a phone the settings menu says how; here it only points there
      setPushHint(scs.pushSub.platform() === 'other'
        ? scs.pushSub.hint('unsupported')
        : 'Please see the notifications settings in the settings menu to enable this.');
    } else {
      syncPush();
      pushCheck.addEventListener('change', function () {
        // the browser has already flipped the box: one change at a time,
        // across both switches, so it goes back
        if (pushBusy || scs.pushSub.busy()) { pushCheck.checked = !pushCheck.checked; return; }
        pushBusy = true;
        setPushHint('');
        var want = pushCheck.checked;
        (want ? scs.pushSub.enable() : scs.pushSub.disable()).then(function () {
          if (window.scsToast) window.scsToast('Push Notifications for Announcements ' + (want ? 'On' : 'Off'));
        }, function (err) {
          pushCheck.checked = !want;
          setPushHint(err && err.message === 'denied'
            ? scs.pushSub.hint('denied')
            : 'That did not work. Try again.');
        }).then(function () {
          pushBusy = false;
        });
      });
      // the settings menu's switch changed it (that switch hears this one
      // the same way)
      document.addEventListener('scs-push-changed', function () {
        if (!pushBusy) syncPush();
      });
      // permission can be changed in the browser while the page waits
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && !pushBusy) syncPush();
      });
    }
  }

  load();
})();
