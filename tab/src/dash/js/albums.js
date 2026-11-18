// The Files tab's albums: making and editing one, its photos, who added
// them, and adding photos and videos from here.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, busy = dash.busy, done = dash.done, el = dash.el,
    emptyRow = dash.emptyRow, fill = dash.fill, fmtTime = dash.fmtTime, h = dash.h, LIMITED = dash.LIMITED,
    post = dash.post, row = dash.row, session = dash.session, setSession = dash.setSession, shake = dash.shake,
    state = dash.state, toast = dash.toast;
  // uploads.js
  var limitedJson = dash.limitedJson, MSG_THUMB_EDGE = dash.MSG_THUMB_EDGE, needsConverting = dash.needsConverting,
    PT_VIEW_BYTES = dash.PT_VIEW_BYTES, PT_VIEW_EDGE = dash.PT_VIEW_EDGE, putSlice = dash.putSlice,
    sizeText = dash.sizeText, toJpeg = dash.toJpeg, uploadMode = dash.uploadMode, waitOutLimit = dash.waitOutLimit;
  // preview.js
  var animatedType = dash.animatedType, fileActions = dash.fileActions, fileUrl = dash.fileUrl,
    openPreview = dash.openPreview, thumbUrl = dash.thumbUrl;
  // tabs.js
  var show = dash.show;

  dash.loadAlbums = loadAlbums;

  // ---- albums ----
  // Made here, read on the site's /albums page. An album open to
  // anyone or to teams takes photos from the site; this card adds them
  // as an organiser, and takes them out.
  var albumEditing = 0;
  var albumOpen = 0;
  var ALBUM_WHOLE_BYTES = 25 * 1024 * 1024;   // anything larger goes in slices
  var ALBUM_BIG_BYTES = 4 * 1024 * 1024 * 1024;
  var VIDEO_STATES = { uploading: 'Still uploading', waiting: 'Waiting for the encoder', encoding: 'Encoding',
    skipped: 'The encoder could not use it' };

  function addingText(adding) {
    return adding === 'anyone' ? 'Anyone' : adding === 'closed' ? 'Organisers' : 'Teams';
  }
  function albumLink(a) {
    var site = (state.albums && state.albums.site) || '';
    return site + '/albums/?' + (a.visibility === 'link' ? 'k=' + encodeURIComponent(a.link_key) : 'a=' + encodeURIComponent(a.slug));
  }
  function albumFile(p, small) {
    if (p.from === 'gallery') return small ? thumbUrl(p.key, p.type) : fileUrl(p.key) + (animatedType(p.type) ? '' : '&res=1080');
    return '/api/albums/file?key=' + encodeURIComponent(p.key) + (p.ver ? '&v=' + p.ver : '') +
      (animatedType(p.type) ? '' : small ? '&thumb=1' : '&res=1080');
  }

  function paintAlbumCheck() {
    var none = state.albums && !state.albums.turnstile;
    el('alb-no-check').classList.toggle('hidden', !(none && el('alb-adding').value === 'anyone'));
  }

  // The teams whose gallery photos an album shows when it does not show
  // the whole gallery. Every team is listed, the ones with photos in the
  // gallery first with how many they have.
  function paintAlbumTeams(picked) {
    var box = el('alb-teams');
    var teams = (state.albums && state.albums.teams) || [];
    box.textContent = '';
    teams.forEach(function (t) {
      var l = h('label');
      var c = h('input');
      c.type = 'checkbox';
      c.value = String(t.id);
      c.checked = picked.indexOf(t.id) !== -1;
      l.appendChild(c);
      var name = h('span', null, t.name);
      var notes = [];
      if (t.gallery) notes.push(String(t.gallery));
      if (t.hidden) notes.push('hidden');
      if (notes.length) name.appendChild(h('span', 'muted', ' (' + notes.join(', ') + ')'));
      l.appendChild(name);
      box.appendChild(l);
    });
    if (!teams.length) box.appendChild(h('span', 'muted', 'No teams yet.'));
  }
  // The albums a merged album shows with its own. One level: a merged
  // album cannot be merged into another. Any ticked makes it organisers only.
  function paintAlbumMerges(picked) {
    var box = el('alb-merges');
    var list = ((state.albums && state.albums.albums) || []).filter(function (a) {
      return a.id !== albumEditing && !(a.merges && a.merges.length);
    });
    box.textContent = '';
    list.forEach(function (a) {
      var l = h('label');
      var c = h('input');
      c.type = 'checkbox';
      c.value = String(a.id);
      c.checked = picked.indexOf(a.id) !== -1;
      l.appendChild(c);
      l.appendChild(h('span', null, a.name));
      box.appendChild(l);
    });
    if (!list.length) box.appendChild(h('span', 'muted', 'No other albums yet.'));
  }
  function pickedAlbumMerges() {
    return Array.prototype.slice.call(el('alb-merges').querySelectorAll('input:checked'))
      .map(function (c) { return Number(c.value); });
  }
  function pickedAlbumTeams() {
    return Array.prototype.slice.call(el('alb-teams').querySelectorAll('input:checked'))
      .map(function (c) { return Number(c.value); });
  }
  function paintAlbumGallery() {
    el('alb-teams-field').classList.toggle('hidden', el('alb-gallery').checked);
  }
  function albumTeamsText(ids) {
    var one = ids.length === 1 && ((state.albums && state.albums.teams) || []).filter(function (t) { return t.id === ids[0]; })[0];
    return one ? one.name : ids.length + (ids.length === 1 ? ' team' : ' teams');
  }

  function paintAlbums(d) {
    var picked = pickedAlbumTeams();
    var merging = pickedAlbumMerges();
    state.albums = d;
    paintAlbumCheck();
    paintAlbumTeams(picked);
    paintAlbumMerges(merging);
    fill(el('alb-rows'), d.albums.length ? d.albums.map(function (a) {
      var name = h('td');
      name.appendChild(h('div', null, a.name));
      var notes = [];
      if (a.merges && a.merges.length) notes.push('merges ' + a.merges.length + (a.merges.length === 1 ? ' album' : ' albums'));
      if (a.gallery) notes.push('with the gallery');
      else if (a.teams && a.teams.length) notes.push('with gallery photos from ' + albumTeamsText(a.teams));
      if (a.visibility === 'hidden') notes.push('only organisers');
      if (a.visibility === 'link') notes.push('only with the link');
      if (notes.length) name.appendChild(h('div', 'muted', notes.join(' · ')));
      var link = h('td');
      if (a.visibility === 'hidden') link.appendChild(btn('Open', 'quiet small', function () { openAlbumPass(a.id); }));
      else link.appendChild(dash.linkCell(albumLink(a), 'open'));
      var actions = h('td', 'num');
      var wrap = h('span', 'inline');
      wrap.appendChild(btn('Photos', 'quiet small', function () { openAlbum(a.id); }));
      if (a.count) wrap.appendChild(btn('Download', 'quiet small', function () { downloadAlbum(a, actions, this); }));
      wrap.appendChild(btn('Edit', 'quiet small', function () { editAlbum(a); }));
      wrap.appendChild(btn('Delete', 'danger small', function () { askAlbumDelete(a, actions); }));
      actions.appendChild(wrap);
      return row([name, h('td', null, addingText(a.adding)), h('td', 'num', String(a.count)), link, actions]);
    }) : [emptyRow('No albums yet.', 5)]);
  }

  // An album only organisers see, opened on the site with a pass that
  // lasts a day; its slideshow runs there. The tab opens on the click, so
  // the browser does not take it for a pop-up.
  function openAlbumPass(id) {
    var tab = window.open('', '_blank');
    if (tab) tab.opener = null;
    api('/api/console/album/pass?id=' + id).then(function (r) {
      if (r.ok) {
        // a browser that refused the tab gets the album here instead
        if (tab) tab.location.href = r.url; else location.href = r.url;
        return;
      }
      if (tab) tab.close();
      done(r);
    }).catch(function () { if (tab) tab.close(); });
  }

  // The whole album as a ZIP, streamed by the worker; a big one comes in
  // parts, a link each. One part starts at once and stays as a link too,
  // in case the browser held the download back.
  function bigSize(bytes) {
    return bytes >= 1024 * 1024 * 1024 ? (Math.round(bytes / 1024 / 1024 / 102.4) / 10) + ' GB' : sizeText(bytes);
  }
  function downloadAlbum(a, cell, button) {
    busy(button, api('/api/console/album/zip?id=' + a.id)).then(function (r) {
      if (!r.ok) { done(r); return; }
      var wrap = h('span', 'inline');
      r.parts.forEach(function (p) {
        var link = h('a', null, (r.parts.length > 1 ? 'Part ' + p.n + ': ' : 'Zip: ') + p.files +
          (p.files === 1 ? ' file, ' : ' files, ') + bigSize(p.bytes));
        link.href = p.url;
        link.setAttribute('download', '');
        wrap.appendChild(link);
      });
      wrap.appendChild(btn('Close', 'quiet small', function () { paintAlbums(state.albums); }));
      cell.textContent = '';
      cell.appendChild(wrap);
      if (r.parts.length === 1) wrap.querySelector('a').click();
    }).catch(function () {});
  }

  function loadAlbums() {
    api('/api/console/albums').then(function (d) {
      if (d.ok) paintAlbums(d);
      else fill(el('alb-rows'), [emptyRow(d.error || 'Could not load the albums.', 5)]);
    }).catch(function () {});
  }

  function resetAlbumForm() {
    albumEditing = 0;
    el('alb-name').value = '';
    el('alb-about').value = '';
    el('alb-adding').value = 'teams';
    el('alb-gallery').checked = false;
    el('alb-show-hidden').checked = false;
    el('alb-details').checked = true;
    el('alb-order').value = 'added';
    el('alb-visibility').value = 'listed';
    paintAlbumMerges([]);
    el('alb-save').textContent = 'Make album';
    el('alb-cancel').classList.add('hidden');
    paintAlbumCheck();
    paintAlbumTeams([]);
    paintAlbumGallery();
    paintAlbumOrder();
  }
  // the order a photo was taken in is one of its details
  function paintAlbumOrder() {
    el('alb-order').disabled = !el('alb-details').checked;
  }
  function editAlbum(a) {
    albumEditing = a.id;
    el('alb-name').value = a.name;
    el('alb-about').value = a.about || '';
    el('alb-adding').value = a.adding;
    el('alb-gallery').checked = !!a.gallery;
    el('alb-show-hidden').checked = !!a.show_hidden;
    el('alb-details').checked = !!a.details;
    el('alb-order').value = a.default_order || 'added';
    el('alb-visibility').value = a.visibility || 'listed';
    paintAlbumMerges(a.merges || []);
    el('alb-save').textContent = 'Save changes';
    el('alb-cancel').classList.remove('hidden');
    paintAlbumCheck();
    paintAlbumTeams(a.teams || []);
    paintAlbumGallery();
    paintAlbumOrder();
    el('alb-name').focus();
  }
  el('alb-adding').addEventListener('change', paintAlbumCheck);
  el('alb-gallery').addEventListener('change', paintAlbumGallery);
  el('alb-details').addEventListener('change', paintAlbumOrder);
  el('alb-cancel').addEventListener('click', resetAlbumForm);
  el('alb-save').addEventListener('click', function () {
    var body = {
      id: albumEditing || 0,
      name: el('alb-name').value.trim(),
      about: el('alb-about').value,
      adding: el('alb-adding').value,
      gallery: el('alb-gallery').checked,
      teams: pickedAlbumTeams(),
      show_hidden: el('alb-show-hidden').checked,
      details: el('alb-details').checked,
      order: el('alb-order').value,
      visibility: el('alb-visibility').value,
      merges: pickedAlbumMerges()
    };
    if (!body.name) { shake(el('alb-name')); el('alb-name').focus(); return; }
    var editing = !!albumEditing;
    busy(el('alb-save'), post('/api/console/albums/save', body)).then(function (r) {
      if (!done(r, (editing ? 'Saved ' : 'Made ') + body.name)) return;
      resetAlbumForm();
      paintAlbums(r);
      if (albumOpen) openAlbum(albumOpen);
    }).catch(function () {});
  });

  // An album's own uploads go with it, so deleting one that has any
  // takes its name typed back. Gallery photos stay in the gallery.
  function askAlbumDelete(a, cell) {
    var wrap = h('span', 'inline');
    var input = null;
    if (a.uploads) {
      wrap.appendChild(h('span', 'muted', 'Deletes the ' + a.uploads + (a.uploads === 1 ? ' photo' : ' photos') + ' added to it. Type its name:'));
      input = h('input');
      input.type = 'text';
      input.placeholder = a.name;
      input.setAttribute('aria-label', 'Album name');
      wrap.appendChild(input);
    } else {
      wrap.appendChild(h('span', 'muted', 'Delete?'));
    }
    var go = btn('Delete', 'danger small', function () {
      if (input && input.value.trim().toLowerCase() !== a.name.toLowerCase()) { shake(input); return; }
      busy(go, post('/api/console/albums/delete', { id: a.id, confirm: input ? input.value.trim() : '' })).then(function (r) {
        if (!done(r, 'Deleted ' + a.name)) return;
        dropAlbumJobs(a.id);
        if (albumOpen === a.id) closeAlbum();
        if (albumEditing === a.id) resetAlbumForm();
        paintAlbums(r);
      }).catch(function () {});
    });
    wrap.appendChild(go);
    wrap.appendChild(btn('Cancel', 'quiet small', function () { paintAlbums(state.albums); }));
    cell.textContent = '';
    cell.appendChild(wrap);
    if (input) input.focus();
  }

  function openAlbum(id) {
    if (albumOpen !== id) { albumPointing = null; albumAuthor = null; }
    albumOpen = id;
    api('/api/console/album?id=' + id).then(function (r) {
      if (r.ok) {
        paintAlbum(r);
        el('album-open').scrollIntoView({ block: 'start', behavior: 'smooth' });
      } else done(r);
    }).catch(function () {});
  }
  function closeAlbum() {
    albumOpen = 0;
    albumPointing = null;
    albumAuthor = null;
    el('album-open').classList.add('hidden');
  }
  el('album-close').addEventListener('click', closeAlbum);

  function albumPhotoAction(id, p, back) {
    return post('/api/console/album/photo/remove', { id: id, key: p.key, back: !!back }).then(function (r) {
      if (done(r, back ? 'Put back' : p.from === 'gallery' ? 'Taken out of the album' : 'Deleted')) {
        paintAlbum(r);
        loadAlbums();
      }
    });
  }

  // A duplicate pointed at another photo in the album: left out of the
  // album, and its links go to that photo. Point to marks the photo, and
  // a click on another of the album's own uploads sets it.
  var albumPointing = null;
  var albumShown = null;
  function pointAlbumPhoto(id, from, to) {
    return post('/api/console/album/photo/point', { id: id, key: from.key, to: to ? to.key : '' }).then(function (r) {
      var name = from.name || 'The photo';
      if (done(r, to ? name + ' now points to ' + (to.name || 'that photo') : name + ' is back in the album')) {
        albumPointing = null;
        paintAlbum(r);
        loadAlbums();
      }
    });
  }
  if (el('album-pointing-cancel')) {
    el('album-pointing-cancel').addEventListener('click', function () {
      albumPointing = null;
      if (albumShown) paintAlbum(albumShown);
    });
  }

  // Who added them, for several at once: Change who added them turns a
  // click on one of the album's own uploads into picking it, and Set
  // puts the team or the name chosen on every one picked. A gallery
  // file is its team's, and a merged album's photo is changed in its own
  // album, so neither can be picked.
  var albumAuthor = null;
  function authorPickable(p) { return p.from === 'album' && !p.via; }
  function setAlbumAuthoring(on) {
    albumAuthor = on ? {} : null;
    if (on) albumPointing = null;
    if (albumShown) paintAlbum(albumShown);
  }
  function paintAuthorBar(r) {
    var mine = r.photos.filter(authorPickable);
    el('album-tools').classList.toggle('hidden', !!albumAuthor || !mine.length);
    el('album-author').classList.toggle('hidden', !albumAuthor);
    if (!albumAuthor) return;
    var n = Object.keys(albumAuthor).length;
    el('album-author-picked').textContent = n ? n + ' picked' : 'Click photos to pick them.';
    el('album-author-all').textContent = n && n === mine.length ? 'Pick none' : 'Pick all';
    var who = el('album-author-who');
    var was = who.value;
    who.textContent = '';
    who.appendChild(h('option', null, 'Who added them'));
    who.firstChild.value = '';
    var teams = h('optgroup');
    teams.label = 'Teams';
    ((state.albums && state.albums.teams) || []).forEach(function (t) {
      var o = h('option', null, t.name + (t.hidden ? ' (hidden)' : ''));
      o.value = 't:' + t.id;
      teams.appendChild(o);
    });
    if (teams.firstChild) who.appendChild(teams);
    var other = h('optgroup');
    other.label = 'Not a team';
    [['name', 'A name'], ['none', 'No name']].forEach(function (c) {
      var o = h('option', null, c[1]);
      o.value = c[0];
      other.appendChild(o);
    });
    who.appendChild(other);
    who.value = was;
    if (who.value !== was) who.value = '';
    // the names already in the album, offered as the name is typed
    var names = el('album-author-names');
    names.textContent = '';
    var seen = {};
    r.photos.forEach(function (p) {
      var k = (p.by || '').toLowerCase();
      if (!p.by || p.team || seen[k]) return;
      seen[k] = true;
      var o = h('option');
      o.value = p.by;
      names.appendChild(o);
    });
    paintAuthorSet();
  }
  function paintAuthorSet() {
    if (!albumAuthor) return;
    var v = el('album-author-who').value;
    var nameBox = el('album-author-name');
    nameBox.classList.toggle('hidden', v !== 'name');
    el('album-author-set').disabled = !Object.keys(albumAuthor).length || !v || (v === 'name' && !nameBox.value.trim());
  }
  function sendAuthor() {
    var keys = Object.keys(albumAuthor || {});
    var v = el('album-author-who').value;
    var body = { id: albumOpen, keys: keys };
    var who = '';
    if (v.indexOf('t:') === 0) {
      body.team_id = Number(v.slice(2));
      who = el('album-author-who').selectedOptions[0].textContent.replace(/ \(hidden\)$/, '');
    } else if (v === 'name') {
      body.name = el('album-author-name').value.trim();
      who = body.name;
    } else if (v === 'none') {
      body.name = '';
    } else return Promise.resolve();
    return post('/api/console/album/photos/author', body).then(function (r) {
      var said = (r.changed === 1 ? '1 file' : r.changed + ' files') + (who ? ' now from ' + who : ' now have no name');
      if (done(r, said)) {
        albumAuthor = {};
        paintAlbum(r);
        loadAlbums();
      }
    });
  }
  if (el('album-author-start')) {
    el('album-author-start').addEventListener('click', function () { setAlbumAuthoring(true); });
    el('album-author-done').addEventListener('click', function () { setAlbumAuthoring(false); });
    el('album-author-all').addEventListener('click', function () {
      if (!albumAuthor || !albumShown) return;
      var mine = albumShown.photos.filter(authorPickable);
      var all = Object.keys(albumAuthor).length === mine.length;
      albumAuthor = {};
      if (!all) mine.forEach(function (p) { albumAuthor[p.key] = true; });
      paintAlbum(albumShown);
    });
    el('album-author-who').addEventListener('change', function () {
      paintAuthorSet();
      if (this.value === 'name') el('album-author-name').focus();
    });
    el('album-author-name').addEventListener('input', paintAuthorSet);
    el('album-author-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !el('album-author-set').disabled) el('album-author-set').click();
    });
    el('album-author-set').addEventListener('click', function () {
      busy(el('album-author-set'), sendAuthor()).catch(function () {});
    });
  }

  function paintAlbum(r) {
    var a = r.album;
    albumShown = r;
    el('album-open').classList.remove('hidden');
    el('album-open-name').textContent = a.name;
    el('album-pointing').classList.toggle('hidden', !albumPointing);
    if (albumPointing) {
      el('album-pointing-what').textContent = 'Click the photo ' + (albumPointing.name || 'this one') + ' should point to.';
    }
    var byKey = {};
    r.photos.forEach(function (p) { byKey[p.key] = p; });
    if (albumAuthor) {
      Object.keys(albumAuthor).forEach(function (k) { if (!byKey[k] || !authorPickable(byKey[k])) delete albumAuthor[k]; });
    }
    paintAuthorBar(r);
    var onSite = r.photos.filter(function (p) { return !p.skipped && !p.hidden_team && !p.points_to && (!p.state || p.state === 'done'); });
    var videos = onSite.filter(function (p) { return p.type.indexOf('video/') === 0; }).length;
    var stills = onSite.length - videos;
    var out = r.photos.length - onSite.length;
    var what = stills && videos ? stills + (stills === 1 ? ' photo and ' : ' photos and ') + videos + (videos === 1 ? ' video' : ' videos')
      : videos ? videos + (videos === 1 ? ' video' : ' videos') : stills + (stills === 1 ? ' photo' : ' photos');
    el('album-open-line').textContent = what + ' on the site' +
      (out ? ', ' + out + ' kept off it' : '') + '. ' +
      (a.adding === 'teams' ? 'Teams add to it with their submit code.' : a.adding === 'anyone' ? 'Anyone can add to it.' : 'Only organisers add to it, here.');
    var grid = el('album-photos');
    grid.textContent = '';
    if (!r.photos.length) grid.appendChild(h('p', 'muted', 'No photos yet.'));
    r.photos.forEach(function (p) {
      var waiting = p.state && p.state !== 'done';
      var pointing = albumPointing && albumPointing.key === p.key;
      var pickable = albumPointing && !pointing && p.from === 'album' && !p.via;
      var choosable = !!albumAuthor && authorPickable(p);
      var tile = h('div', 'alb-ph' + (p.skipped || p.hidden_team || waiting || p.points_to ? ' is-out' : '') +
        (pointing ? ' is-pointing' : '') + (pickable ? ' is-pickable' : '') +
        ((albumPointing && !pickable && !pointing) || (albumAuthor && !choosable) ? ' is-unpickable' : '') +
        (choosable ? ' is-choosable' : '') + (choosable && albumAuthor[p.key] ? ' is-picked' : ''));
      var video = p.type.indexOf('video/') === 0;
      var who = p.team || p.by || '';
      var pic = h('button', 'alb-ph-pic');
      pic.type = 'button';
      pic.setAttribute('aria-label', 'View' + (who ? ' the photo from ' + who : ''));
      var img = h('img');
      img.loading = 'lazy';
      img.alt = '';
      img.src = albumFile(p, true);
      img.addEventListener('error', function () { img.classList.add('hidden'); });
      pic.appendChild(img);
      if (video) pic.appendChild(h('span', 'alb-ph-play'));
      if (choosable) pic.setAttribute('aria-pressed', albumAuthor[p.key] ? 'true' : 'false');
      pic.addEventListener('click', function () {
        if (albumPointing) {
          if (pickable) busy(pic, pointAlbumPhoto(a.id, albumPointing, p)).catch(function () {});
          return;
        }
        if (albumAuthor) {
          if (!choosable) return;
          if (albumAuthor[p.key]) delete albumAuthor[p.key]; else albumAuthor[p.key] = true;
          tile.classList.toggle('is-picked', !!albumAuthor[p.key]);
          pic.setAttribute('aria-pressed', albumAuthor[p.key] ? 'true' : 'false');
          paintAuthorBar(r);
          return;
        }
        // an upload's picked file goes out only where the album shows details
        var picked = p.from === 'album' && !a.details ? '' : p.picked;
        openPreview(albumFile(p, false), who, null, video, fileActions(p.key, p.name || (video ? 'video' : 'photo'), video ? p.heights || [] : null, picked, p.ver));
      });
      tile.appendChild(pic);
      tile.appendChild(h('div', 'alb-ph-who', (p.from === 'gallery' ? (p.quest ? p.quest + ' · ' : '') : '') + (who || 'No name')));
      var target = p.points_to ? byKey[p.points_to] : null;
      tile.appendChild(h('div', 'muted', p.via ? 'From ' + p.via :
        p.points_to ? 'Points to ' + (target ? target.name || 'another photo' : 'another photo') :
        p.hidden_team ? 'A hidden team: not shown' :
        p.skipped ? 'Taken out' : waiting ? VIDEO_STATES[p.state] :
        (p.from === 'gallery' ? 'Gallery · ' : '') + fmtTime(p.at)));
      var bar = h('span', 'inline');
      // a photo of an album merged into this one is changed in its own
      // album, and while photos are being picked a click only picks
      if (p.via || albumAuthor) {
        tile.appendChild(bar);
        grid.appendChild(tile);
        return;
      }
      if (p.skipped) {
        var back = btn('Put back', 'quiet small', function () { busy(back, albumPhotoAction(a.id, p, true)).catch(function () {}); });
        bar.appendChild(back);
      } else if (p.from === 'gallery') {
        var take = btn('Take out', 'quiet small', function () { busy(take, albumPhotoAction(a.id, p, false)).catch(function () {}); });
        bar.appendChild(take);
      } else {
        if (p.points_to) {
          var undo = btn('Undo', 'quiet small', function () { busy(undo, pointAlbumPhoto(a.id, p, null)).catch(function () {}); });
          bar.appendChild(undo);
        } else {
          bar.appendChild(btn('Point to', 'quiet small', function () {
            albumPointing = p;
            paintAlbum(r);
          }));
        }
        var del = btn('Delete', 'danger small', function () {
          bar.textContent = '';
          var sure = btn('Delete', 'danger small', function () { busy(sure, albumPhotoAction(a.id, p, false)).catch(function () {}); });
          bar.appendChild(sure);
          bar.appendChild(btn('Cancel', 'quiet small', function () { paintAlbum(r); }));
        });
        bar.appendChild(del);
      }
      tile.appendChild(bar);
      grid.appendChild(tile);
    });
  }

  // The small copy, a photo's viewing copy and the size of each picture
  // or video, made here as the site's album page makes them.
  function albumCopies(file) {
    var kind = String(file.type || '').toLowerCase();
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      function draw(source, w, ht, edge, quality) {
        return new Promise(function (done) {
          var scale = Math.min(1, edge / Math.max(w, ht));
          var canvas = h2canvas(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(ht * scale)));
          canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
          canvas.toBlob(function (blob) { done(blob || null); }, 'image/jpeg', quality);
        });
      }
      function finish(out) { URL.revokeObjectURL(url); resolve(out); }
      if (kind.indexOf('video/') === 0) {
        var video = h('video');
        var timer = setTimeout(function () { finish({}); }, 4000);
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.addEventListener('loadeddata', function () {
          try { video.currentTime = Math.min(0.1, video.duration || 0.1); } catch (e) { /* draw where it is */ }
          setTimeout(function () {
            var w = video.videoWidth;
            var ht = video.videoHeight;
            if (!w) { clearTimeout(timer); return finish({}); }
            draw(video, w, ht, MSG_THUMB_EDGE, 0.72).then(function (thumb) {
              clearTimeout(timer);
              finish({ thumb: thumb, w: w, h: ht });
            });
          }, 250);
        });
        video.addEventListener('error', function () { clearTimeout(timer); finish({}); });
        video.src = url;
        return;
      }
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth;
        var ht = img.naturalHeight;
        if (animatedType(kind)) return finish({ w: w, h: ht });
        draw(img, w, ht, MSG_THUMB_EDGE, 0.72).then(function (thumb) {
          return draw(img, w, ht, PT_VIEW_EDGE, 0.8).then(function (view) {
            finish({ thumb: thumb, view: view && view.size <= PT_VIEW_BYTES ? view : null, w: w, h: ht });
          });
        });
      };
      img.onerror = function () { finish({}); };
      img.src = url;
    });
  }
  function h2canvas(w, ht) {
    var canvas = h('canvas');
    canvas.width = w;
    canvas.height = ht;
    return canvas;
  }

  // a large file's bytes, or any file's going straight to storage, a
  // slice at a time, with the token its upload handed back; onProgress
  // hears the share sent so far. Each request waits out a 429.
  function albumSlices(u, file, onProgress, onWait) {
    var parts = Math.max(1, Math.ceil(u.size / u.part_size));
    var q = '?file=' + u.file + '&token=' + encodeURIComponent(u.token);
    function give() {
      return fetch('/api/album/upload/abort', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: u.file, token: u.token }) }).catch(function () {});
    }
    // straight to storage: the address the worker signs for the slice,
    // and the slice typed as nothing, so it goes with no headers
    function putDirect(n) {
      return waitOutLimit(function () {
        return fetch('/api/album/upload/sign' + q + '&n=' + n, { cache: 'no-store' }).then(limitedJson);
      }, onWait).then(function (s) {
        if (!s || !s.ok) throw s || {};
        return putSlice(s.url, file.slice((n - 1) * u.part_size, Math.min(n * u.part_size, u.size), ''), function (share) {
          onProgress((n - 1 + share) / parts);
        });
      });
    }
    function putOnce(n) {
      return new Promise(function (resolve) {
        var xhr = new XMLHttpRequest();
        xhr.open('PUT', '/api/album/upload/part' + q + '&n=' + n);
        xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress((n - 1 + e.loaded / e.total) / parts); };
        xhr.onload = function () {
          var d = {};
          try { d = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
          d.status = xhr.status;
          if (xhr.status === 429) d.error = LIMITED;
          resolve(d);
        };
        xhr.onerror = function () { resolve({ error: 'Could not reach the worker.' }); };
        xhr.send(file.slice((n - 1) * u.part_size, Math.min(n * u.part_size, u.size), file.type));
      });
    }
    function put(n) {
      if (u.direct) return putDirect(n);
      return waitOutLimit(function () { return putOnce(n); }, onWait).then(function (d) {
        if (d.status !== 200) throw d;
      });
    }
    var n = 0;
    function next() {
      n += 1;
      if (n > parts) {
        return waitOutLimit(function () {
          return fetch('/api/album/upload/finish', { method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ file: u.file, token: u.token }) }).then(limitedJson);
        }, onWait);
      }
      onProgress((n - 1) / parts);
      return put(n).then(next);
    }
    return next().then(function (r) {
      if (!r || !r.ok) throw r || {};
      return r;
    }).catch(function (err) {
      return give().then(function () {
        return { error: (err && err.error) || 'Could not send ' + file.name + '.' };
      });
    });
  }

  // One file to a request, one after another, each with a row of its
  // own: its small copy, its name, where it is up to and a bar. One that
  // fails says why and can be tried again; the rest carry on.
  var albumJobs = [];
  var albumRunning = false;

  function sendAlbumForm(form, onProgress) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/console/album/upload');
      xhr.setRequestHeader('authorization', 'Bearer ' + session());
      xhr.upload.onprogress = function (e) { if (e.lengthComputable) onProgress(e.loaded / e.total); };
      xhr.onload = function () {
        if (xhr.status === 401) { setSession(''); show(false); }
        var d = {};
        try { d = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
        if (xhr.status === 429) d.error = LIMITED;
        else if (xhr.status !== 200 && !d.error) d.error = 'The worker answered ' + xhr.status + '.';
        d.status = xhr.status;
        resolve(d);
      };
      xhr.onerror = function () { resolve({ error: 'Could not reach the worker.' }); };
      xhr.send(form);
    });
  }

  function albumRow(job, state, share) {
    job.state.textContent = state;
    job.bar.style.width = Math.round(Math.max(0, Math.min(1, share || 0)) * 100) + '%';
  }

  function albumJob(file, id, replace) {
    var row = h('li', 'aq-row');
    var pic = h('span', 'aq-pic');
    var text = h('span', 'aq-text');
    text.appendChild(h('span', 'aq-name', file.name));
    var state = h('span', 'aq-state muted', 'Waiting');
    text.appendChild(state);
    var track = h('span', 'aq-track');
    var bar = h('span', 'aq-bar');
    track.appendChild(bar);
    row.appendChild(pic);
    row.appendChild(text);
    row.appendChild(track);
    el('album-queue').appendChild(row);
    var job = { file: file, album: id, replace: replace, row: row, pic: pic, text: text, state: state, bar: bar, status: 'waiting' };
    albumJobs.push(job);
    return job;
  }

  function albumJobFailed(job, line) {
    job.status = 'failed';
    job.row.classList.add('is-failed');
    albumRow(job, line || 'That did not go through.', 1);
    var again = btn('Try again', 'quiet small', function () {
      again.remove();
      job.row.classList.remove('is-failed');
      job.status = 'waiting';
      albumRow(job, 'Waiting', 0);
      albumPump();
    });
    job.text.appendChild(again);
  }

  function albumRun(job) {
    job.status = 'running';
    albumRow(job, 'Preparing', 0);
    var ready = needsConverting(job.file) ? toJpeg(job.file).catch(function () { return null; }) : Promise.resolve(job.file);
    return ready.then(function (file) {
      if (!file) throw { error: 'Could not read this photo.' };
      job.file = file;
      return Promise.all([albumCopies(file), uploadMode()]).then(function (got) {
        var c = got[0];
        if (c.thumb && !job.pic.firstChild) {
          var im = h('img');
          im.alt = '';
          im.src = URL.createObjectURL(c.thumb);
          job.pic.appendChild(im);
        }
        // straight to storage, every file follows in slices whatever its size
        var direct = !!got[1].direct;
        var big = direct || file.size > ALBUM_WHOLE_BYTES;
        var form = new FormData();
        form.append('id', String(job.album));
        if (direct) form.append('whole', '1');
        if (job.replace) form.append('replace', '1');
        if (job.replace && job.replaceKey) form.append('replace_key', job.replaceKey);
        if (big) {
          if (c.thumb) form.append('bigthumb0', c.thumb, 'thumb.jpg');
          if (c.view) form.append('bigview0', c.view, 'view.jpg');
          form.append('bigfiles', JSON.stringify([{ name: file.name, type: file.type, size: file.size, w: c.w || 0, h: c.h || 0 }]));
        } else {
          form.append('files', file, file.name);
          if (c.thumb) form.append('thumb0', c.thumb, 'thumb.jpg');
          if (c.view) form.append('view0', c.view, 'view.jpg');
          if (c.w) form.append('w0', String(c.w));
          if (c.h) form.append('h0', String(c.h));
        }
        function waiting(secs) { albumRow(job, 'Too many requests right now. Trying again in ' + secs + ' seconds.', 0); }
        return waitOutLimit(function () {
          return sendAlbumForm(form, function (share) {
            albumRow(job, 'Sending ' + Math.round(share * 100) + '%', big ? 0.02 : share * 0.97);
          });
        }, waiting).then(function (r) {
          if (!r.ok) throw r;
          var u = (r.uploads || [])[0];
          var swapped = (r.replaced || [])[0] || (u && u.replaces);
          if (swapped) job.replaced = swapped.png ? 'Replaced the PNG, kept as the original' : 'Replaced';
          if (!u) return;
          return albumSlices(u, file, function (share) {
            albumRow(job, 'Sending ' + Math.round(share * 100) + '%', share * 0.97);
          }, waiting).then(function (done) { if (!done.ok) throw done; });
        });
      });
    }).then(function () {
      job.status = 'done';
      job.row.classList.add('is-done');
      albumRow(job, job.replaced || (String(job.file.type || '').toLowerCase().indexOf('video/') === 0 ? 'Added, waiting for the encoder' : 'Added'), 1);
    }, function (err) {
      if (err && err.choose) albumJobChoose(job, err);
      else albumJobFailed(job, err && err.error);
    });
  }

  // More than one photo in the album has this file's name: the row shows
  // them, and the file waits for the one it is to replace while the rest
  // of the queue carries on.
  function albumJobChoose(job, err) {
    job.status = 'choosing';
    job.row.classList.add('is-choosing');
    albumRow(job, err.error + ' Pick the one to replace.', 0);
    var box = h('div', 'aq-choose');
    var picks = h('div', 'aq-picks');
    err.choose.forEach(function (c) {
      var pick = h('button', 'quiet aq-pick');
      pick.type = 'button';
      var img = h('img');
      img.alt = '';
      img.src = albumFile(c, true);
      pick.appendChild(img);
      pick.appendChild(h('span', 'aq-pick-line', 'Added ' + fmtTime(c.at) + (c.by ? ' by ' + c.by : '')));
      var facts = [];
      if (c.taken) facts.push('Taken ' + fmtTime(c.taken));
      if (c.w && c.h) facts.push(c.w + ' × ' + c.h);
      if (c.bytes) facts.push(sizeText(c.bytes));
      if (facts.length) pick.appendChild(h('span', 'aq-pick-line muted', facts.join(' · ')));
      pick.appendChild(h('span', 'aq-pick-do', 'Replace this one'));
      pick.addEventListener('click', function () { settle(c.key); });
      picks.appendChild(pick);
    });
    box.appendChild(picks);
    var acts = h('span', 'inline');
    acts.appendChild(btn('Add it as a new photo', 'quiet small', function () { settle(''); }));
    acts.appendChild(btn('Skip it', 'quiet small', function () {
      job.row.remove();
      albumJobs.splice(albumJobs.indexOf(job), 1);
      albumPump();
    }));
    box.appendChild(acts);
    job.row.appendChild(box);
    function settle(key) {
      box.remove();
      job.row.classList.remove('is-choosing');
      if (key) job.replaceKey = key;
      else job.replace = false;
      job.status = 'waiting';
      albumRow(job, 'Waiting', 0);
      albumPump();
    }
  }

  function albumPump() {
    if (albumRunning) return;
    var waiting = albumJobs.filter(function (j) { return j.status === 'waiting'; });
    // signed out: the rest wait for Try again rather than each being sent to be refused
    if (waiting.length && !session()) {
      waiting.forEach(function (j) { albumJobFailed(j, 'Signed out. Sign in, then try again.'); });
      return albumDrained();
    }
    var next = waiting[0];
    if (!next) return albumDrained();
    albumRunning = true;
    albumRun(next).then(function () {
      albumRunning = false;
      if (next.dropped) {
        next.row.remove();
        albumJobs.splice(albumJobs.indexOf(next), 1);
      }
      albumPump();
    });
  }
  // A deleted album's files: the ones waiting go, and the one on its way
  // goes once it ends.
  function dropAlbumJobs(id) {
    albumJobs = albumJobs.filter(function (j) {
      if (j.album !== id) return true;
      if (j.status === 'running') { j.dropped = true; return true; }
      j.row.remove();
      return false;
    });
  }

  function albumDrained() {
    var added = albumJobs.filter(function (j) { return j.status === 'done'; });
    var failed = albumJobs.filter(function (j) { return j.status === 'failed'; });
    var choosing = albumJobs.filter(function (j) { return j.status === 'choosing'; });
    if (!added.length && !failed.length && !choosing.length) return;
    var swapped = added.filter(function (j) { return j.replaced; }).length;
    var fresh = added.length - swapped;
    var done = [];
    if (fresh) done.push('added ' + fresh + (fresh === 1 ? ' file' : ' files'));
    if (swapped) done.push('replaced ' + swapped + (swapped === 1 ? ' photo' : ' photos'));
    var line = done.join(' and ');
    line = line ? line.charAt(0).toUpperCase() + line.slice(1) + '.' : '';
    if (choosing.length) {
      line += (line ? ' ' : '') + choosing.length + (choosing.length === 1 ? ' is' : ' are') + ' waiting for you to pick the photo ' +
        (choosing.length === 1 ? 'it replaces.' : 'each replaces.');
    }
    if (failed.length) line += line ? ' ' + failed.length + ' did not go through.' : failed.length + (failed.length === 1 ? ' file' : ' files') + ' did not go through.';
    toast(line, !!failed.length);
    added.forEach(function (j) { j.row.remove(); });
    var ids = {};
    added.forEach(function (j) { ids[j.album] = true; });
    albumJobs = failed.concat(choosing);
    if (albumOpen && ids[albumOpen]) openAlbum(albumOpen);
    if (added.length) loadAlbums();
  }

  el('album-upload').addEventListener('click', function () {
    var input = el('album-files');
    var picked = Array.prototype.slice.call(input.files || []);
    if (!picked.length || !albumOpen) { shake(input); return; }
    var tooBig = picked.filter(function (f) { return f.size > ALBUM_BIG_BYTES; })[0];
    if (tooBig) { toast(tooBig.name + ' is over 4GB.', true); return; }
    var replace = el('album-replace').checked;
    picked.forEach(function (f) { albumJob(f, albumOpen, replace); });
    input.value = '';
    albumPump();
  });
})(window.dash);
