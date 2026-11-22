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
    loadLinkPage();
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

  // ---- the link page at the short-link domain ----
  state.linkPage = null;
  var lpEditing = 0;
  var lpCancel = null;
  var LP_KIND = { link: 'Link', heading: 'Heading', social: 'Icon' };

  function loadLinkPage() {
    api('/api/console/linkpage').then(function (d) { if (d.ok) paintLinkPage(d); }).catch(function () {});
  }

  function paintLinkPage(d) {
    state.linkPage = d;
    el('lp-on').checked = !!d.on;
    el('lp-backup').classList.toggle('hidden', !!d.backup);
    el('lp-title').value = d.text.title || '';
    el('lp-bio').value = d.text.bio || '';
    var pick = el('lp-bg');
    while (pick.options.length > 1) pick.remove(1);
    d.pictures.forEach(function (p) { addPicture(p.key, p.name, p.url); });
    pick.value = d.look.bg || '';
    el('lp-dim').value = String(d.look.dim);
    el('lp-blur').value = String(d.look.blur);
    paintPreview();
    var open = el('lp-open');
    open.textContent = '';
    if (d.url) open.appendChild(linkCell(d.url, d.url.replace(/^https:\/\//, '')));
    if (!el('lp-icon').options.length) {
      d.icons.forEach(function (i) {
        var o = h('option', null, i.name);
        o.value = i.key;
        el('lp-icon').appendChild(o);
      });
    }
    var views = 0, opens = 0;
    d.days.forEach(function (day) { views += day.views; opens += day.clicks; });
    el('lp-stats').textContent = views + ' view' + (views === 1 ? '' : 's') + ' and ' + opens + ' link' +
      (opens === 1 ? '' : 's') + ' opened in the last ' + d.days_shown + ' days · ' + d.views + ' view' + (d.views === 1 ? '' : 's') + ' in all';

    var items = d.items;
    fill(el('lp-rows'), items.length ? items.map(function (item, i) {
      var name = h('td');
      var what = item.kind === 'social'
        ? (d.icons.filter(function (x) { return x.key === item.icon; })[0] || { name: item.icon }).name
        : item.label;
      name.appendChild(h('div', item.kind === 'heading' ? 'strong' : null, what));
      name.appendChild(h('div', 'muted', LP_KIND[item.kind] + (item.featured ? ', green' : '') + (item.hidden ? ', hidden' : '')));
      var to = h('td', 'muted', item.url);
      var opened = h('td', 'num', item.kind === 'heading' ? '' : String(item.clicks));
      if (item.kind !== 'heading' && item.recent !== item.clicks) opened.title = item.recent + ' in the last ' + d.days_shown + ' days';
      var actions = h('td', 'num');
      var wrap = h('span', 'inline');
      var up = btn('Up', 'quiet small', function () { moveItem(i, -1); });
      up.disabled = i === 0;
      var down = btn('Down', 'quiet small', function () { moveItem(i, 1); });
      down.disabled = i === items.length - 1;
      wrap.appendChild(up);
      wrap.appendChild(down);
      var toggleBtn = btn(item.hidden ? 'Show' : 'Hide', 'quiet small', function () {
        busy(toggleBtn, sendItem(Object.assign({}, item, { hidden: !item.hidden }), item.hidden ? 'Shown' : 'Hidden')).catch(function () {});
      });
      wrap.appendChild(toggleBtn);
      wrap.appendChild(btn('Edit', 'quiet small', function () { editItem(item); }));
      wrap.appendChild(btn('Delete', 'quiet small', function () { askItemDelete(item, actions); }));
      actions.appendChild(wrap);
      if (item.hidden) name.classList.add('muted');
      return row([name, to, opened, actions]);
    }) : [emptyRow('Nothing on the page yet.', 4)]);
  }

  function moveItem(i, by) {
    var ids = state.linkPage.items.map(function (x) { return x.id; });
    var j = i + by;
    if (j < 0 || j >= ids.length) return;
    var t = ids[i]; ids[i] = ids[j]; ids[j] = t;
    post('/api/console/linkpage/order', { ids: ids }).then(function (r) { if (done(r)) paintLinkPage(r); }).catch(function () {});
  }

  function sendItem(item, said) {
    return post('/api/console/linkpage/save', {
      id: item.id, kind: item.kind, label: item.label, url: item.url, icon: item.icon,
      hidden: !!item.hidden, featured: !!item.featured
    }).then(function (r) { if (done(r, said)) paintLinkPage(r); return r; });
  }

  function askItemDelete(item, cell) {
    var wrap = h('span', 'inline');
    wrap.appendChild(h('span', 'muted', 'Delete this row and its counts?'));
    var go = btn('Delete', 'danger small', function () {
      busy(go, post('/api/console/linkpage/delete', { id: item.id })).then(function (r) {
        if (done(r, 'Deleted')) {
          if (lpEditing === item.id) resetItemForm();
          paintLinkPage(r);
        }
      }).catch(function () {});
    });
    wrap.appendChild(go);
    wrap.appendChild(btn('Cancel', 'quiet small', function () { paintLinkPage(state.linkPage); }));
    cell.textContent = '';
    cell.appendChild(wrap);
  }

  function paintItemKind() {
    var kind = el('lp-kind').value;
    el('lp-icon').classList.toggle('hidden', kind !== 'social');
    el('lp-url').classList.toggle('hidden', kind === 'heading');
    el('lp-featured-row').classList.toggle('hidden', kind !== 'link');
    el('lp-label').placeholder = kind === 'social' ? 'Name read out (optional)' : (kind === 'heading' ? 'Heading' : 'Label');
    el('lp-url').placeholder = kind === 'social' && el('lp-icon').value === 'email' ? 'name@example.com' : 'https://...';
  }
  el('lp-kind').addEventListener('change', paintItemKind);
  el('lp-icon').addEventListener('change', paintItemKind);
  paintItemKind();

  function setItemEditing(id) {
    lpEditing = id || 0;
    el('lp-add').textContent = lpEditing ? 'Save changes' : 'Add';
    if (lpEditing && !lpCancel) {
      lpCancel = btn('Cancel', 'quiet fixed', resetItemForm);
      el('lp-add').parentNode.insertBefore(lpCancel, el('lp-add').nextSibling);
    } else if (!lpEditing && lpCancel) {
      lpCancel.parentNode.removeChild(lpCancel);
      lpCancel = null;
    }
  }
  function resetItemForm() {
    el('lp-label').value = '';
    el('lp-url').value = '';
    el('lp-featured').checked = false;
    setItemEditing(0);
    paintItemKind();
  }
  function editItem(item) {
    el('lp-kind').value = item.kind;
    if (item.kind === 'social') el('lp-icon').value = item.icon;
    el('lp-label').value = item.label;
    el('lp-url').value = item.url.replace(/^mailto:/, '');
    el('lp-featured').checked = !!item.featured;
    setItemEditing(item.id);
    paintItemKind();
    el('lp-label').focus();
  }

  el('lp-add').addEventListener('click', function () {
    var kind = el('lp-kind').value;
    if (kind !== 'social' && !el('lp-label').value.trim()) { shake(el('lp-label')); return; }
    if (kind !== 'heading' && !el('lp-url').value.trim()) { shake(el('lp-url')); return; }
    var was = lpEditing ? state.linkPage.items.filter(function (x) { return x.id === lpEditing; })[0] : null;
    busy(el('lp-add'), sendItem({
      id: lpEditing || undefined, kind: kind, label: el('lp-label').value, url: el('lp-url').value,
      icon: el('lp-icon').value, featured: el('lp-featured').checked, hidden: was ? was.hidden : false
    }, lpEditing ? 'Saved' : 'Added')).then(function (r) { if (r && r.ok) resetItemForm(); }).catch(function () {});
  });
  ['lp-label', 'lp-url'].forEach(function (id) {
    el(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') el('lp-add').click(); });
  });

  // ---- the header: a picture under a shade, previewed as it is set ----
  function addPicture(key, name, url) {
    var o = h('option', null, name);
    o.value = key;
    o.dataset.url = url;
    el('lp-bg').appendChild(o);
    return o;
  }
  function pictureUrl() {
    var o = el('lp-bg').selectedOptions[0];
    return (o && o.value && o.dataset.url) || '';
  }

  var blurContrastTimer = 0;
  function paintTextPreview() {
    el('lp-preview-title').textContent = el('lp-title').value.trim() || el('lp-title').placeholder;
    el('lp-preview-bio').textContent = el('lp-bio').value.trim();
  }
  function paintPreview(debounceBlur) {
    var url = pictureUrl();
    var dim = Number(el('lp-dim').value) || 0;
    var blur = Number(el('lp-blur').value) || 0;
    el('lp-dim-val').textContent = dim + '%';
    el('lp-blur-val').textContent = blur + 'px';
    el('lp-dim').disabled = el('lp-blur').disabled = !url;
    var pic = el('lp-preview-pic');
    pic.style.backgroundImage = url ? 'url("' + url.replace(/"/g, '%22') + '")' : '';
    pic.style.filter = url && blur ? 'blur(' + blur + 'px)' : '';
    el('lp-preview-shade').style.opacity = url ? String(dim / 100) : '0';
    paintTextPreview();
    clearTimeout(blurContrastTimer);
    if (debounceBlur) {
      blurContrastTimer = setTimeout(function () { paintContrast(pictureUrl(), Number(el('lp-dim').value) || 0, Number(el('lp-blur').value) || 0); }, 150);
    } else {
      paintContrast(url, dim, blur);
    }
  }
  ['lp-bg', 'lp-dim'].forEach(function (id) {
    el(id).addEventListener('input', function () { paintPreview(false); });
    el(id).addEventListener('change', function () { paintPreview(false); });
  });
  el('lp-blur').addEventListener('input', function () { paintPreview(true); });
  el('lp-blur').addEventListener('change', function () { paintPreview(false); });
  ['lp-title', 'lp-bio'].forEach(function (id) {
    el(id).addEventListener('input', paintTextPreview);
    el(id).addEventListener('change', paintTextPreview);
  });

  // How readable white type is on the picture, by the WCAG contrast ratio
  // against its brightest tenth once shaded: the words sit wherever the
  // picture is lightest as often as anywhere. The picture is read once
  // per address and blur, small.
  var lumaKept = { key: '', values: null };
  function pictureLuma(url, blur) {
    var key = url + '|' + blur;
    if (lumaKept.key === key) return Promise.resolve(lumaKept.values);
    return new Promise(function (resolve) {
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try {
          var w = 160;
          var hgt = Math.max(1, Math.round(w * img.naturalHeight / Math.max(1, img.naturalWidth)));
          var c = document.createElement('canvas');
          c.width = w; c.height = hgt;
          var ctx = c.getContext('2d');
          // the preview is about 400px wide; the canvas is 160
          if (blur && 'filter' in ctx) ctx.filter = 'blur(' + (blur * w / 400) + 'px)';
          ctx.drawImage(img, 0, 0, w, hgt);
          var px = ctx.getImageData(0, 0, w, hgt).data;
          var values = [];
          for (var i = 0; i < px.length; i += 4) values.push([px[i], px[i + 1], px[i + 2]]);
          lumaKept = { key: key, values: values };
          resolve(values);
        } catch (e) { resolve(null); }
      };
      img.onerror = function () { resolve(null); };
      img.src = url;
    });
  }
  function luminance(r, g, b) {
    var lin = function (v) { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }
  var contrastAsked = 0;
  function paintContrast(url, dim, blur) {
    var line = el('lp-contrast');
    var asked = ++contrastAsked;
    line.classList.remove('is-low');
    if (!url) { line.textContent = ''; return; }
    pictureLuma(url, blur).then(function (values) {
      if (asked !== contrastAsked) return;
      if (!values) { line.textContent = 'Could not read the picture to check the contrast.'; return; }
      var keep = 1 - dim / 100;
      var lum = values.map(function (v) { return luminance(v[0] * keep, v[1] * keep, v[2] * keep); }).sort(function (a, b) { return a - b; });
      var bright = lum[Math.floor(lum.length * 0.9)] || 0;
      var ratio = 1.05 / (bright + 0.05);
      var shown = ratio.toFixed(1) + ':1';
      if (ratio >= 4.5) line.textContent = 'Text contrast about ' + shown + ': easy to read.';
      else {
        line.classList.add('is-low');
        line.textContent = 'Text contrast about ' + shown + ': ' + (ratio >= 3
          ? 'the title reads, the line under it may not. More darkness helps.'
          : 'hard to read. Raise the darkness.');
      }
    });
  }

  // A picture picked here is shrunk to 2400px on its long side and made a
  // JPEG in the browser, which also leaves its camera data behind, then
  // goes into Files like any upload and is picked for the header.
  function shrunk(file) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      var src = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(src);
        var scale = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * scale);
        c.height = Math.round(img.naturalHeight * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error('no picture')); }, 'image/jpeg', 0.86);
      };
      img.onerror = function () { URL.revokeObjectURL(src); reject(new Error('unreadable')); };
      img.src = src;
    });
  }
  el('lp-bg-file').addEventListener('change', function () {
    var file = el('lp-bg-file').files[0];
    el('lp-bg-file').value = '';
    if (!file) return;
    var line = el('lp-contrast');
    line.classList.remove('is-low');
    line.textContent = 'Uploading the picture…';
    (needsConverting(file) ? pngPicks([file]).then(function (r) { return r[0]; }) : Promise.resolve(file))
      .then(shrunk)
      .then(function (blob) {
        var form = new FormData();
        form.append('file', new File([blob], 'link-page-header.jpg', { type: 'image/jpeg' }));
        form.append('note', 'Link page header');
        return postForm('/api/console/drop/upload', form);
      })
      .then(function (r) {
        if (!done(r)) { line.textContent = ''; return; }
        addPicture(r.key, r.name, ((state.linkPage && state.linkPage.api) || '') + r.url);
        el('lp-bg').value = r.key;
        paintPreview();
        toast('Picture added. Save page to use it.');
      })
      .catch(function () { line.textContent = 'That picture could not be read. Try a JPEG or PNG.'; });
  });

  el('lp-settings-save').addEventListener('click', function () {
    busy(el('lp-settings-save'), post('/api/console/linkpage/settings', {
      on: el('lp-on').checked, title: el('lp-title').value, bio: el('lp-bio').value,
      bg: el('lp-bg').value, dim: Number(el('lp-dim').value), blur: Number(el('lp-blur').value)
    })).then(function (r) { if (done(r, el('lp-on').checked ? 'Link page saved and showing' : 'Link page saved, not showing')) paintLinkPage(r); }).catch(function () {});
  });
})(window.dash);
