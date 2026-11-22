// The Settings tab's Personal data and Original videos cards, for admins:
// the sign-ups' emails, zIDs and dietary needs taken off the databases into
// a file and put back from it, and the proof videos as teams sent them
// downloaded and then deleted (src/privacy.ts, src/originals.ts).
(function (dash) {
  // core.js
  var api = dash.api, post = dash.post, busy = dash.busy, btn = dash.btn, done = dash.done, el = dash.el, h = dash.h,
    toast = dash.toast, fmtTime = dash.fmtTime;

  dash.loadPrivacy = loadPrivacy;

  function plural(n, one, many) { return Number(n || 0).toLocaleString('en-US') + ' ' + (n === 1 ? one : many); }
  function size(n) {
    n = n || 0;
    if (n >= 1073741824) return (Math.round(n / 1073741824 * 10) / 10) + ' GB';
    if (n >= 1048576) return Math.round(n / 1048576) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }
  function saveJson(data, name) {
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    window.setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  function loadPrivacy() {
    var admin = !!dash.access.admin;
    el('set-privacy').classList.toggle('hidden', !admin);
    el('set-originals').classList.toggle('hidden', !admin);
    if (!admin) return;
    loadPersonal();
    loadOriginals();
  }

  // ---- personal data ----
  function paintPersonal(d) {
    var s = d.stored;
    var line;
    if (d.removed && !s.people) {
      line = 'Removed ' + fmtTime(d.removed.at) + ' by ' + d.removed.by + '.';
    } else {
      line = 'Stored now: ' + plural(s.emails, 'email address', 'email addresses') + ', ' + plural(s.zids, 'zID', 'zIDs') +
        ', ' + plural(s.dietary, 'dietary answer', 'dietary answers') + ', ' + plural(s.eoi, 'person', 'people') + ' on the EOI list and ' +
        plural(s.queue, 'announcement address', 'announcement addresses') + '.';
      if (d.removed) line += ' Removed ' + fmtTime(d.removed.at) + ' by ' + d.removed.by + ', and added to since.';
    }
    if (d.checkin.connected && d.checkin.reached) {
      line += ' The check-in worker holds ' + plural(d.checkin.emails, 'email address', 'email addresses') + ' and ' +
        plural(d.checkin.zids, 'zID', 'zIDs') + '.';
    } else if (d.checkin.connected) {
      line += ' The check-in worker did not answer: ' + d.checkin.note + '.';
    }
    el('privacy-state').textContent = line;
  }
  function loadPersonal() {
    api('/api/console/privacy').then(function (d) {
      if (d.ok) paintPersonal(d);
      else el('privacy-state').textContent = d.error || 'Could not read what is stored.';
    }).catch(function () {});
  }

  el('privacy-export').addEventListener('click', function () {
    busy(el('privacy-export'), api('/api/console/privacy/export')).then(function (d) {
      if (!d || !d.ok) { done(d); return; }
      saveJson(d.copy, d.file);
      toast('Saved a copy of ' + plural(d.copy.people.length, 'person', 'people') +
        (d.copy.checkin ? '' : ', without the check-in worker’s'));
    }).catch(function () {});
  });

  // the copy the organiser picks, read and handed to whichever row asked
  var picked = null;
  el('privacy-file').addEventListener('change', function () {
    var input = el('privacy-file');
    var file = input.files && input.files[0];
    var then = picked;
    input.value = '';
    picked = null;
    if (!file || !then) return;
    file.text().then(function (text) {
      var copy = null;
      try { copy = JSON.parse(text); } catch (e) { copy = null; }
      if (!copy || copy.kind !== 'scs2-personal-data') { toast('That is not a copy of the personal data.', true); return; }
      then(copy);
    }).catch(function () { toast('That file could not be read.', true); });
  });
  function pickCopy(then) {
    picked = then;
    el('privacy-file').click();
  }

  function resetRemove() {
    Array.prototype.slice.call(el('privacy-remove-host').querySelectorAll('.privacy-confirm')).forEach(function (n) { n.remove(); });
    el('privacy-remove').classList.remove('hidden');
  }
  function startRemove() {
    pickCopy(function (copy) {
      resetRemove();
      var go = btn('Remove ' + plural(copy.people.length, 'person\u2019s data', 'people\u2019s data'), 'danger fixed privacy-confirm', function () {
        busy(go, post('/api/console/privacy/remove', { copy: copy })).then(function (r) {
          if (!done(r, function () { return 'Removed ' + plural(r.people, 'person\u2019s data', 'people\u2019s data'); })) return;
          el('privacy-remove-out').textContent = 'Removed ' + plural(r.people, 'person\u2019s', 'people\u2019s') +
            ' emails, zIDs and dietary needs' + (r.checkin != null ? ', and ' + plural(r.checkin, 'person\u2019s', 'people\u2019s') +
            ' on the check-in worker' : '') + '.' + (r.note ? ' ' + r.note : '');
          resetRemove();
          loadPersonal();
        }).catch(function () {});
      });
      el('privacy-remove').classList.add('hidden');
      el('privacy-remove-host').appendChild(go);
      el('privacy-remove-host').appendChild(btn('Cancel', 'quiet fixed privacy-confirm', resetRemove));
    });
  }
  el('privacy-remove').addEventListener('click', startRemove);

  el('privacy-restore').addEventListener('click', function () {
    pickCopy(function (copy) {
      busy(el('privacy-restore'), post('/api/console/privacy/restore', { copy: copy })).then(function (r) {
        if (!done(r, function () { return 'Put back ' + plural(r.people, 'person’s data', 'people’s data'); })) return;
        el('privacy-restore-out').textContent = 'Put back ' + plural(r.people, 'person’s', 'people’s') + ' data' +
          (r.checkin != null ? ', and ' + plural(r.checkin, 'person’s', 'people’s') + ' on the check-in worker' : '') + '.' +
          (r.note ? ' ' + r.note : '');
        loadPersonal();
      }).catch(function () {});
    });
  });

  // ---- original videos ----
  function paintOriginals(d) {
    var line;
    if (!d.kept) line = d.gone ? 'Every original has been deleted. The site plays the copies.' : 'No team has sent a video.';
    else {
      line = plural(d.kept, 'original', 'originals') + ' kept, ' + size(d.kept_bytes) + '. ' +
        plural(d.saved, 'has been saved', 'have been saved') + ' in a download.';
      if (d.unencoded) line += ' ' + plural(d.unencoded, 'has', 'have') + ' no copy from the encoder yet and ' +
        (d.unencoded === 1 ? 'is' : 'are') + ' kept until it has.';
    }
    if (d.gone && d.kept) line += ' ' + plural(d.gone, 'original has', 'originals have') + ' been deleted already.';
    el('originals-state').textContent = line;
    el('originals-zip').disabled = !d.kept;
    var host = el('originals-delete-host');
    host.textContent = '';
    if (!d.deletable) {
      host.appendChild(h('span', 'muted', d.kept ? 'Nothing to delete yet' : ''));
      return;
    }
    host.appendChild(dash.armed('Delete ' + plural(d.deletable, 'original', 'originals'),
      'Delete ' + plural(d.deletable, 'original', 'originals') + ', ' + size(d.deletable_bytes), deleteOriginals));
  }
  function loadOriginals() {
    return api('/api/console/originals').then(function (d) {
      if (d.ok) paintOriginals(d);
      else el('originals-state').textContent = d.error || 'Could not count the videos.';
    }).catch(function () {});
  }
  el('originals-count').addEventListener('click', function () { busy(el('originals-count'), loadOriginals()); });

  el('originals-zip').addEventListener('click', function () {
    busy(el('originals-zip'), api('/api/console/originals/zip')).then(function (r) {
      if (!r.ok) { done(r); return; }
      var box = el('originals-parts');
      box.textContent = '';
      r.parts.forEach(function (p) {
        var row = h('div', 'originals-part');
        var link = h('a', null, (r.parts.length > 1 ? 'Part ' + p.n + ' of ' + r.parts.length + ': ' : 'ZIP: ') +
          plural(p.files, 'video', 'videos') + ', ' + size(p.bytes));
        link.href = p.url;
        link.setAttribute('download', '');
        row.appendChild(link);
        if (p.saved) row.appendChild(h('span', 'muted', 'Saved before'));
        box.appendChild(row);
      });
      box.classList.remove('hidden');
      el('originals-zip-out').textContent = 'The links work for ' + r.hours + ' hours. Count again once a download has finished.';
      if (r.parts.length === 1) box.querySelector('a').click();
    }).catch(function () {});
  });

  // a batch a request until none are left
  function deleteOriginals(go) {
    var out = el('originals-delete-out');
    var deleted = 0;
    var freed = 0;
    var kept = 0;
    // the second password, once for the whole run
    var hold = { value: '' };
    function round(after) {
      return post('/api/console/originals/delete', { after: after }, hold).then(function (r) {
        if (!r || !r.ok) return r;
        deleted += r.deleted;
        freed += r.freed;
        kept += r.kept;
        out.textContent = 'Deleted ' + plural(deleted, 'original', 'originals') + '…';
        return r.done ? { ok: true } : round(r.after);
      });
    }
    busy(go, round(0)).then(function (r) {
      if (!r || !r.ok) { done(r); return; }
      out.textContent = 'Deleted ' + plural(deleted, 'original', 'originals') + ', ' + size(freed) + '.' +
        (kept ? ' ' + plural(kept, 'was', 'were') + ' kept, since no copy of ' + (kept === 1 ? 'it' : 'them') + ' was found.' : '');
      toast('Deleted ' + plural(deleted, 'original', 'originals'));
      loadOriginals();
    }).catch(function () { loadOriginals(); });
  }
})(window.dash);
