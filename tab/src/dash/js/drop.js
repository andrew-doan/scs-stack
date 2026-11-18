// The Files tab's files to share and short links.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, busy = dash.busy, copyLink = dash.copyLink, done = dash.done,
    el = dash.el, emptyRow = dash.emptyRow, fill = dash.fill, fmtTime = dash.fmtTime, h = dash.h,
    heldIn = dash.heldIn, holdOpen = dash.holdOpen, letGo = dash.letGo, post = dash.post,
    postForm = dash.postForm, row = dash.row, shake = dash.shake, state = dash.state, toast = dash.toast;
  // uploads.js
  var needsConverting = dash.needsConverting, pngPicks = dash.pngPicks, sizeText = dash.sizeText,
    stageFiles = dash.stageFiles, uploadMode = dash.uploadMode;

  dash.linkCell = linkCell;
  dash.loadDrop = loadDrop;

  // ---- files to share, and the short links that point at them ----
  // The dashboard answers on its own hostname, and a link copied from
  // here is pasted somewhere public, so the addresses are built from
  // the worker's public name — the same rule the Discord cross-post
  // follows.
  state.drop = null;

  function dropBase() {
    return (state.drop && state.drop.api) || location.origin;
  }

  function linkCell(href, label) {
    var wrap = h('span', 'inline');
    var a = h('a', 'mono', label);
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener';
    wrap.appendChild(a);
    wrap.appendChild(btn('Copy', 'quiet small', function () { copyLink(href); }));
    return wrap;
  }

  function paintDrop(d) {
    state.drop = d;
    var base = dropBase();
    var byKey = {};
    d.files.forEach(function (f) { byKey[f.key] = f; });

    el('link-host').textContent = d.host ? d.host + '/' : 'no short-link domain set';

    // a file's row open as its form stays as it is
    var take = heldIn(el('drop-rows'));
    fill(el('drop-rows'), d.files.length ? d.files.map(function (f) {
      var editing = take(f.key);
      if (editing) return editing;
      var name = h('td');
      name.appendChild(h('div', null, f.name));
      if (f.note) name.appendChild(h('div', 'muted', f.note));
      name.appendChild(h('div', 'muted', fmtTime(f.created_at) + ' · ' + (f.created_by || '')));

      var link = h('td');
      link.appendChild(linkCell(base + f.url, 'open'));

      var actions = h('td', 'num');
      var wrap = h('span', 'inline');
      wrap.appendChild(btn('Edit', 'quiet small', function () { editDrop(f, tr); }));
      wrap.appendChild(btn('Short link', 'quiet small', function () { startFileLink(f); }));
      wrap.appendChild(btn('Delete', 'danger small', function () { askDropDelete(f, actions); }));
      actions.appendChild(wrap);

      var tr = row([name, h('td', 'num', sizeText(f.bytes)), link, actions]);
      return tr;
    }) : [emptyRow('Nothing uploaded yet.', 4)]);

    // the picker the file kind of short link chooses from
    var picker = el('link-file');
    var held = picker.value;
    picker.textContent = '';
    d.files.forEach(function (f) {
      var opt = h('option', null, f.name + ' (' + sizeText(f.bytes) + ')');
      opt.value = f.key;
      picker.appendChild(opt);
    });
    if (held && byKey[held]) picker.value = held;

    fill(el('link-rows'), d.links.length ? d.links.map(function (l) {
      var name = h('td');
      name.appendChild(l.url ? linkCell(l.url, '/' + l.slug) : h('span', 'mono', '/' + l.slug));

      var where = h('td');
      if (l.kind === 'file') {
        var file = byKey[l.file_key];
        where.appendChild(h('span', file ? null : 'muted', file ? file.name : 'a file that is gone'));
      } else {
        var a = h('a', null, l.target.length > 60 ? l.target.slice(0, 60) + '…' : l.target);
        a.href = l.target;
        a.target = '_blank';
        a.rel = 'noopener';
        where.appendChild(a);
      }

      var actions = h('td', 'num');
      var wrap = h('span', 'inline');
      wrap.appendChild(btn('Edit', 'quiet small', function () { editLink(l); }));
      wrap.appendChild(btn('Delete', 'danger small', function () { askLinkDelete(l, actions); }));
      actions.appendChild(wrap);

      return row([name, where, h('td', 'num', String(l.hits || 0)), actions]);
    }) : [emptyRow('No short links yet.', 4)]);
  }

  function loadDrop() {
    api('/api/console/drop').then(function (d) { if (d.ok) paintDrop(d); }).catch(function () {});
    // a file sent straight to storage is not held to one request's size
    uploadMode().then(function (m) { el('drop-max').textContent = m.direct ? '4GB' : '90MB'; });
  }

  el('drop-send').addEventListener('click', function () {
    var input = el('drop-file');
    var picked = input.files && input.files[0];
    if (!picked) { shake(input); return; }
    if (needsConverting(picked)) el('drop-state').textContent = 'Converting to PNG…';
    busy(el('drop-send'), pngPicks([picked]).then(function (ready) {
      var file = ready[0];
      var form = new FormData();
      form.append('name', file.name);
      form.append('note', el('drop-note').value);
      el('drop-state').textContent = 'Sending ' + sizeText(file.size) + '…';
      return stageFiles([file], 'drop', function (share) {
        el('drop-state').textContent = 'Sending ' + Math.round(share * 100) + '%';
      }).then(function (ids) {
        if (ids) form.append('staged', String(ids[0]));
        else form.append('file', file);
        return postForm('/api/console/drop/upload', form);
      });
    })).then(function (r) {
      el('drop-state').textContent = '';
      if (!done(r, function () { return 'Uploaded ' + r.name; })) return;
      input.value = '';
      el('drop-note').value = '';
      loadDrop();
    }).catch(function (err) {
      el('drop-state').textContent = '';
      if (err && err.error) toast(err.error, true);
    });
  });

  // A file's own row becomes its form: the name, the note, and a file to
  // put in its place. The worker keeps the key, so the link and the short
  // links pointing at it serve whatever is picked here.
  function editDrop(f, tr) {
    var cell = h('td');
    cell.colSpan = 4;
    var bar = h('div', 'row-form');
    var name = h('input');
    name.type = 'text';
    name.maxLength = 120;
    name.value = f.name;
    name.setAttribute('aria-label', 'Name');
    var note = h('input');
    note.type = 'text';
    note.maxLength = 120;
    note.value = f.note || '';
    note.placeholder = 'What is it (optional)';
    note.setAttribute('aria-label', 'What is it');
    var swap = h('label', 'check-inline', 'Replace with ');
    var pick = h('input');
    pick.type = 'file';
    swap.appendChild(pick);
    var status = h('span', 'muted');
    var save = btn('Save', 'small', function () {
      var picked = pick.files && pick.files[0];
      var typed = name.value.trim();
      if (!typed) { shake(name); return; }
      if (picked && needsConverting(picked)) status.textContent = 'Converting to PNG…';
      busy(save, (picked ? pngPicks([picked]) : Promise.resolve([])).then(function (ready) {
        var form = new FormData();
        form.append('key', f.key);
        form.append('name', typed);
        form.append('note', note.value);
        if (!ready[0]) return postForm('/api/console/drop/edit', form);
        status.textContent = 'Sending ' + sizeText(ready[0].size) + '…';
        return stageFiles([ready[0]], 'drop', function (share) {
          status.textContent = 'Sending ' + Math.round(share * 100) + '%';
        }).then(function (ids) {
          if (ids) form.append('staged', String(ids[0]));
          else form.append('file', ready[0]);
          return postForm('/api/console/drop/edit', form);
        });
      })).then(function (r) {
        status.textContent = '';
        if (!done(r, (picked ? 'Replaced ' : 'Saved ') + typed)) return;
        letGo(tr);
        paintDrop(r);
      }).catch(function (err) {
        status.textContent = '';
        if (err && err.error) toast(err.error, true);
      });
    });
    [name, note, swap, save, btn('Cancel', 'quiet small', function () { letGo(tr); paintDrop(state.drop); }), status]
      .forEach(function (n) { bar.appendChild(n); });
    cell.appendChild(bar);
    cell.appendChild(h('p', 'muted', 'A file picked here takes this one’s place at the same link, short links included.'));
    holdOpen(tr, f.key);
    tr.textContent = '';
    tr.appendChild(cell);
    name.focus();
  }

  // A file goes with every short link pointing at it, so the question
  // says how many of those there are before it is answered.
  function askDropDelete(f, cell) {
    var links = ((state.drop && state.drop.links) || []).filter(function (l) { return l.file_key === f.key; });
    var wrap = h('span', 'inline');
    wrap.appendChild(h('span', 'muted', links.length
      ? 'Delete, and drop ' + links.length + (links.length === 1 ? ' short link?' : ' short links?')
      : 'Delete?'));
    var go = btn('Delete', 'danger small', function () {
      busy(go, post('/api/console/drop/delete', { key: f.key })).then(function (r) {
        if (done(r, 'Deleted ' + f.name)) paintDrop(r);
      }).catch(function () {});
    });
    wrap.appendChild(go);
    wrap.appendChild(btn('Cancel', 'quiet small', function () { paintDrop(state.drop); }));
    cell.textContent = '';
    cell.appendChild(wrap);
  }

  function askLinkDelete(l, cell) {
    var wrap = h('span', 'inline');
    wrap.appendChild(h('span', 'muted', 'Delete /' + l.slug + '?'));
    var go = btn('Delete', 'danger small', function () {
      busy(go, post('/api/console/links/delete', { slug: l.slug })).then(function (r) {
        if (done(r, 'Deleted /' + l.slug)) {
          if (linkEditing === l.slug) resetLinkForm();
          paintDrop(r);
        }
      }).catch(function () {});
    });
    wrap.appendChild(go);
    wrap.appendChild(btn('Cancel', 'quiet small', function () { paintDrop(state.drop); }));
    cell.textContent = '';
    cell.appendChild(wrap);
  }

  // ---- the short link form ----
  var linkEditing = '';
  var linkCancel = null;

  function paintLinkKind() {
    var file = el('link-kind').value === 'file';
    el('link-target').classList.toggle('hidden', file);
    el('link-file').classList.toggle('hidden', !file);
  }
  el('link-kind').addEventListener('change', paintLinkKind);
  paintLinkKind();

  // Editing a link means the old name may be given up for a new one, so
  // the form carries which one it started as.
  function setLinkEditing(slug) {
    linkEditing = slug || '';
    el('link-save').textContent = linkEditing ? 'Save changes' : 'Save link';
    if (linkEditing && !linkCancel) {
      linkCancel = btn('Cancel', 'quiet fixed', resetLinkForm);
      el('link-save').parentNode.insertBefore(linkCancel, el('link-save').nextSibling);
    } else if (!linkEditing && linkCancel) {
      linkCancel.parentNode.removeChild(linkCancel);
      linkCancel = null;
    }
  }
  function resetLinkForm() {
    el('link-slug').value = '';
    el('link-target').value = '';
    el('link-kind').value = 'url';
    paintLinkKind();
    setLinkEditing('');
  }
  function editLink(l) {
    el('link-slug').value = l.slug;
    el('link-kind').value = l.kind === 'file' ? 'file' : 'url';
    el('link-target').value = l.kind === 'file' ? '' : l.target;
    if (l.kind === 'file') el('link-file').value = l.file_key;
    paintLinkKind();
    setLinkEditing(l.slug);
    el('link-slug').focus();
  }
  // A file's own name, extension and all, is offered as the link name:
  // a slug ending in .png is what makes Discord read the address as a
  // picture.
  function startFileLink(f) {
    el('link-kind').value = 'file';
    el('link-file').value = f.key;
    el('link-slug').value = f.suggest || '';
    el('link-target').value = '';
    paintLinkKind();
    setLinkEditing('');
    el('link-slug').focus();
    el('link-slug').select();
  }

  el('link-save').addEventListener('click', function () {
    var kind = el('link-kind').value === 'file' ? 'file' : 'url';
    if (!el('link-slug').value.trim()) { shake(el('link-slug')); return; }
    if (kind === 'file' && !el('link-file').value) { shake(el('link-file')); return; }
    if (kind === 'url' && !el('link-target').value.trim()) { shake(el('link-target')); return; }
    busy(el('link-save'), post('/api/console/links/save', {
      slug: el('link-slug').value,
      was: linkEditing,
      kind: kind,
      target: el('link-target').value,
      file_key: el('link-file').value
    })).then(function (r) {
      if (!done(r, 'Link saved')) return;
      resetLinkForm();
      paintDrop(r);
    }).catch(function () {});
  });
  el('link-slug').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') el('link-save').click();
  });
  el('link-target').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') el('link-save').click();
  });
})(window.dash);
