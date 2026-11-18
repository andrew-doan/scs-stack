// The Messages tab: writing, editing and sending a message, and the list.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, busy = dash.busy, can = dash.can, done = dash.done, el = dash.el,
    fmtTime = dash.fmtTime, fromLocalInput = dash.fromLocalInput, h = dash.h, post = dash.post,
    postForm = dash.postForm, shake = dash.shake, state = dash.state, toast = dash.toast,
    toLocalInput = dash.toLocalInput;
  // markdown.js
  var markdownTools = dash.markdownTools;
  // uploads.js
  var imageThumb = dash.imageThumb, pngPicks = dash.pngPicks, renameRow = dash.renameRow,
    sendName = dash.sendName, sizeText = dash.sizeText, stageFiles = dash.stageFiles;
  // preview.js
  var openPreview = dash.openPreview;

  dash.loadMessages = loadMessages;

  // ---- messages ----
  // The compose card doubles as the editor: Edit fills it in, Cancel
  // edit empties it again. Files picked here are added to the message;
  // the ones already on it are removed from their own card.
  var MSG_MAX_FILES = 6;
  var msgEditing = null;
  var msgFiles = [];
  var msgNames = []; // the name each goes up under, typed over in its row

  function msgFileUrl(key) { return '/api/messages/file?key=' + encodeURIComponent(key); }
  function msgThumbUrl(key) { return msgFileUrl(key) + '&thumb=1'; }

  // markdown help and a preview for the body, the same pair the quest
  // description gets
  var msgPreview = h('div', 'md-preview hidden');
  el('msg-body').parentNode.insertBefore(markdownTools(el('msg-body'), msgPreview, null, true), el('msg-body'));
  el('msg-body').parentNode.insertBefore(msgPreview, el('msg-body').nextSibling);

  function renderMsgPicked() {
    var line = el('msg-files-list');
    line.textContent = '';
    msgFiles.forEach(function (f, i) {
      line.appendChild(renameRow(f, msgNames, i, function () {
        msgFiles.splice(i, 1);
        msgNames.splice(i, 1);
        renderMsgPicked();
      }));
    });
  }
  // Discord only ever hears about a new message, so its tick goes away
  // while an existing one is being edited — and a draft is not on the
  // site yet, so neither announcement is offered for one.
  // What the urgency means, said for the one picked rather than all
  // three at once.
  var URGENCY_HINT = {
    silent: 'On the messages page and nowhere else.',
    normal: 'Lights the bell in the app.',
    urgent: 'Lights the bell and stays in front of people until they dismiss it.'
  };
  // the same audiences a quest has; a draft is the organisers only
  var WHO_HINT = {
    everyone: 'Anyone who opens the site.',
    teams: 'Teams signed in with their code. A push goes to their phones and a Discord post to their team channels.',
    groups: 'The teams in the groups ticked. A push goes to their phones and a Discord post to their team channels.'
  };
  state.msgGroups = [];
  function renderMsgGroups(picked) {
    var box = el('msg-groups');
    box.textContent = '';
    state.msgGroups.forEach(function (g) {
      var l = h('label');
      var c = h('input');
      c.type = 'checkbox';
      c.value = String(g.id);
      c.checked = (picked || []).indexOf(g.id) !== -1;
      l.appendChild(c);
      l.appendChild(document.createTextNode(g.name + ' (' + g.teams + (g.teams === 1 ? ' team)' : ' teams)')));
      box.appendChild(l);
    });
    if (!state.msgGroups.length) box.appendChild(h('span', 'muted', 'No team groups yet. Make them on the Teams tab.'));
  }
  function pickedMsgGroups() {
    return Array.prototype.slice.call(el('msg-groups').querySelectorAll('input:checked'))
      .map(function (c) { return Number(c.value); });
  }
  // Draft is a button rather than a switch: Post puts it up, Save as
  // draft keeps it off the site. Editing, the buttons follow what the
  // message is now: a draft can be posted or kept, a live one saved or
  // taken back to drafts.
  var msgEditingDraft = false;
  function syncMsgMode() {
    var editing = msgEditing != null;
    // a time on it holds the message back until then, and neither
    // announcement is offered for something not up yet
    var scheduled = !!el('msg-publish-at').value;
    el('msg-discord-row').classList.toggle('hidden', editing || scheduled);
    el('msg-push-row').classList.toggle('hidden', scheduled || !can('push'));
    el('msg-also-row').classList.toggle('hidden', scheduled);
    if (scheduled) el('msg-push').checked = false;
    el('msg-urgency-hint').textContent = URGENCY_HINT[el('msg-urgency').value] || '';
    el('msg-who-hint').textContent = WHO_HINT[el('msg-who').value] || '';
    el('msg-groups').classList.toggle('hidden', el('msg-who').value !== 'groups');
    el('msg-publish-hint').textContent = scheduled
      ? 'Goes up on its own at this time, with no push and no Discord post.'
      : 'Empty posts it now.';
    if (scheduled) el('msg-post').textContent = editing ? 'Save changes' : 'Schedule message';
    else if (editing && !msgEditingDraft) el('msg-post').textContent = 'Save changes';
    else el('msg-post').textContent = 'Post message';
    el('msg-draft').textContent = editing && !msgEditingDraft ? 'Move to drafts' : (editing ? 'Save draft' : 'Save as draft');
    el('msg-draft').classList.toggle('hidden', scheduled);
    el('msg-cancel').classList.toggle('hidden', !editing);
  }
  el('msg-urgency').addEventListener('change', syncMsgMode);
  el('msg-who').addEventListener('change', syncMsgMode);
  el('msg-publish-at').addEventListener('change', syncMsgMode);
  el('msg-publish-at').addEventListener('input', syncMsgMode);
  el('msg-publish-clear').addEventListener('click', function () {
    el('msg-publish-at').value = '';
    syncMsgMode();
  });
  // Which filling of the form this is: Edit and Cancel each start a new
  // one, so a save that comes back after either leaves the form alone.
  var msgFormAt = 0;
  var msgSaving = false;
  function resetMsgForm() {
    msgFormAt++;
    msgEditing = null;
    msgEditingDraft = false;
    msgFiles = [];
    msgNames = [];
    el('msg-title').value = '';
    el('msg-body').value = '';
    el('msg-hidden').checked = false;
    el('msg-urgency').value = 'normal';
    el('msg-who').value = 'everyone';
    renderMsgGroups([]);
    el('msg-discord').checked = true;
    el('msg-push').checked = false;
    el('msg-publish-at').value = '';
    el('msg-form-title').textContent = 'New message';
    msgPreview.classList.add('hidden');
    syncMsgMode();
    renderMsgPicked();
  }
  function editMessage(m) {
    msgFormAt++;
    msgEditing = m.id;
    msgEditingDraft = !!m.hidden && !m.publish_at;
    msgFiles = [];
    msgNames = [];
    el('msg-title').value = m.title;
    el('msg-body').value = m.body || '';
    el('msg-hidden').checked = !!m.hidden && !m.publish_at;
    el('msg-urgency').value = m.urgency || 'normal';
    el('msg-who').value = m.visibility || 'everyone';
    renderMsgGroups(m.audiences || []);
    el('msg-publish-at').value = toLocalInput(m.publish_at);
    el('msg-form-title').textContent = 'Editing: ' + m.title;
    syncMsgMode();
    renderMsgPicked();
    el('msg-form-title').scrollIntoView({ block: 'nearest' });
    el('msg-title').focus();
  }

  el('msg-files-btn').addEventListener('click', function () { el('msg-files').click(); });
  el('msg-files').addEventListener('change', function () {
    var picked = Array.prototype.slice.call(el('msg-files').files);
    el('msg-files').value = '';
    pngPicks(picked).then(function (ready) {
      msgFiles = msgFiles.concat(ready).slice(0, MSG_MAX_FILES);
      msgNames = msgNames.slice(0, msgFiles.length);
      renderMsgPicked();
    });
  });
  el('msg-cancel').addEventListener('click', resetMsgForm);
  syncMsgMode();

  el('msg-post').addEventListener('click', function () { sendMessage(false); });
  el('msg-draft').addEventListener('click', function () { sendMessage(true); });
  function sendMessage(asDraft) {
    // one save at a time: Post and Save draft together would make two messages
    if (msgSaving) return;
    var send = asDraft ? el('msg-draft') : el('msg-post');
    var other = asDraft ? el('msg-post') : el('msg-draft');
    var title = el('msg-title').value.trim();
    if (!title) { toast('The message needs a title.', true); shake(el('msg-title')); return; }
    var who = el('msg-who').value;
    var groups = who === 'groups' ? pickedMsgGroups() : [];
    if (who === 'groups' && !groups.length) {
      toast('Pick at least one team group.', true);
      shake(el('msg-groups'));
      return;
    }
    // a draft is not up, so nothing announces it
    el('msg-hidden').checked = asDraft && !el('msg-publish-at').value;
    var wantPush = !asDraft && el('msg-push').checked;
    var form = new FormData();
    if (msgEditing) form.append('id', String(msgEditing));
    form.append('title', title);
    form.append('body', el('msg-body').value);
    form.append('hidden', el('msg-hidden').checked ? '1' : '0');
    form.append('urgency', el('msg-urgency').value);
    form.append('visibility', who);
    form.append('audiences', groups.join(','));
    form.append('publish_at', fromLocalInput(el('msg-publish-at').value));
    form.append('discord', !msgEditing && !asDraft && el('msg-discord').checked ? '1' : '0');
    if (wantPush) form.append('push', '1');
    var editing = msgEditing;
    var formAt = msgFormAt;
    var status = el('msg-status');
    status.textContent = msgFiles.length ? 'Preparing files…' : 'Sending…';
    var files = msgFiles.slice();
    var sendNames = files.map(function (f, i) { return sendName(f, msgNames[i]); });
    msgSaving = true;
    other.disabled = true;
    function saved() { msgSaving = false; other.disabled = false; }
    busy(send, Promise.all(files.map(imageThumb)).then(function (thumbs) {
      // staged under the names typed for them
      var named = files.map(function (f, i) { return new File([f], sendNames[i], { type: f.type }); });
      return stageFiles(named, 'msg', function (share) {
        status.textContent = 'Sending ' + Math.round(share * 100) + '%';
      }).then(function (ids) {
        files.forEach(function (f, i) {
          if (ids) form.append('staged' + i, String(ids[i]));
          else form.append('file' + i, f, sendNames[i]);
          if (thumbs[i]) form.append('thumb' + i, thumbs[i], 'thumb.jpg');
        });
        status.textContent = 'Sending…';
        return postForm('/api/console/messages/save', form);
      });
    })).then(function (r) {
      saved();
      status.textContent = '';
      var line = asDraft ? 'Saved ' + title + ' as a draft' : (editing ? 'Saved ' + title : 'Posted ' + title);
      if (r && r.ok && r.publish_at) line = title + ' goes up at ' + fmtTime(r.publish_at);
      if (r && r.ok && r.push && r.push.off) {
        line += ' · no push sent: push notifications are turned off in Settings';
      } else if (r && r.ok && r.push) {
        // failed and dead were counted by the worker and dropped here,
        // so a send that reached fifty of three hundred read exactly
        // like one that reached everybody
        line += ' · pushed to ' + r.push.sent + ' device' + (r.push.sent === 1 ? '' : 's') +
          (r.push.failed ? ', ' + r.push.failed + ' could not be reached' : '') +
          (r.push.dead ? ', ' + r.push.dead + ' gone' : '') +
          (r.push.queued ? ', the rest going out over the next few minutes' : '');
      }
      if (done(r, line)) {
        // an Edit or Cancel pressed while it was on its way stays as it is
        if (msgFormAt === formAt) resetMsgForm();
        loadMessages();
      }
    }).catch(function (err) {
      saved();
      status.textContent = '';
      if (err && err.error) toast(err.error, true);
    });
  }

  function loadMessages() {
    api('/api/console/messages/list').then(function (d) {
      if (!d.ok) return;
      state.messages = d.messages;
      // the ticks follow the groups as they now are, keeping what was ticked
      var picked = pickedMsgGroups();
      state.msgGroups = d.team_groups || [];
      renderMsgGroups(picked);
      renderMessages();
    }).catch(function () {});
  }
  el('msg-show-archived').addEventListener('change', renderMessages);

  function renderMessages() {
    var archivedView = el('msg-show-archived').checked;
    var shown = state.messages.filter(function (m) { return !!m.archived === archivedView; });
    var list = el('msg-list');
    list.textContent = '';
    var away = state.messages.length - shown.length;
    el('msg-count').textContent = shown.length + (archivedView ? ' archived' : ' on the site') +
      (away ? ' · ' + away + (archivedView ? ' live' : ' archived') : '');
    if (!shown.length) {
      list.appendChild(h('p', 'note', archivedView ? 'Nothing archived.' : 'No messages yet.'));
      return;
    }
      shown.forEach(function (m, index) {
        var card = h('div', 'msg-card');
        var head = h('div', 'msg-head');
        head.appendChild(h('strong', null, m.title));
        head.appendChild(h('span', 'muted', fmtTime(m.created_at, true)));
        if (m.updated_at) head.appendChild(h('span', 'muted', 'edited ' + fmtTime(m.updated_at)));
        if (m.hidden && m.publish_at) {
          head.appendChild(h('span', 'pill update', 'scheduled'));
          head.appendChild(h('span', 'muted', 'goes up ' + fmtTime(m.publish_at)));
        } else if (m.hidden) head.appendChild(h('span', 'pill update', 'draft'));
        if (m.archived) head.appendChild(h('span', 'pill same', 'archived'));
        if (m.visibility === 'teams') head.appendChild(h('span', 'pill same', 'signed-in teams'));
        if (m.visibility === 'groups') {
          var names = state.msgGroups.filter(function (g) { return (m.audiences || []).indexOf(g.id) !== -1; })
            .map(function (g) { return g.name; }).join(', ');
          head.appendChild(h('span', 'pill same', names || 'no team group'));
        }
        if (m.urgency === 'urgent') head.appendChild(h('span', 'pill rejected', 'urgent'));
        if (m.urgency === 'silent') head.appendChild(h('span', 'pill same', 'silent'));
        card.appendChild(head);
        if (m.body) card.appendChild(h('p', 'msg-body', m.body));

        if (m.files.length) {
          var files = h('div', 'msg-files');
          m.files.forEach(function (f) {
            var box = h('span', 'msg-file');
            if (String(f.type || '').indexOf('image/') === 0) {
              var im = h('img');
              im.loading = 'lazy';
              im.src = msgThumbUrl(f.key);
              im.alt = f.name || '';
              im.addEventListener('click', function () { openPreview(msgFileUrl(f.key), f.name); });
              box.appendChild(im);
            }
            var link = h('a', null, f.name || 'file');
            link.href = msgFileUrl(f.key);
            link.target = '_blank';
            link.rel = 'noopener';
            box.appendChild(link);
            box.appendChild(h('span', 'muted', sizeText(f.bytes)));
            var drop = btn('Remove', 'quiet small', function () {
              busy(drop, post('/api/console/messages/file/delete', { id: f.id })).then(function (r) {
                if (done(r, 'Removed ' + (f.name || 'the file'))) loadMessages();
              }).catch(function () {});
            });
            box.appendChild(drop);
            files.appendChild(box);
          });
          card.appendChild(files);
        }

        var actions = h('div', 'msg-actions row-links');
        if (!archivedView) {
          // the order the site shows them in: move a card, and the whole
          // visible list is written back as 1, 2, 3 …
          var up = btn('Up', 'quiet small', function () { moveMessage(shown, index, -1, up); });
          var down = btn('Down', 'quiet small', function () { moveMessage(shown, index, 1, down); });
          up.disabled = index === 0;
          down.disabled = index === shown.length - 1;
          actions.appendChild(up);
          actions.appendChild(down);
        }
        actions.appendChild(btn('Edit', 'quiet small', function () { editMessage(m); }));
        var stow = btn(m.archived ? 'Unarchive' : 'Archive', 'quiet small', function () {
          busy(stow, post('/api/console/messages/archive', { id: m.id, archived: !m.archived })).then(function (r) {
            if (done(r, r.archived ? 'Archived ' + m.title : m.title + ' is back on the site')) loadMessages();
          }).catch(function () {});
        });
        actions.appendChild(stow);
        // deleting takes the attachments with it, so the title is typed back
        actions.appendChild(btn('Delete', 'danger small', function () {
          var input = h('input');
          input.placeholder = 'Type the title to confirm';
          var go = btn('Delete', 'danger small', function () {
            if (input.value.trim() !== m.title) { shake(input); return; }
            busy(go, post('/api/console/messages/delete', { id: m.id })).then(function (r) {
              if (done(r, 'Deleted ' + m.title)) {
                if (msgEditing === m.id) resetMsgForm();
                loadMessages();
              }
            }).catch(function () {});
          });
          var cancel = btn('Cancel', 'quiet small', loadMessages);
          input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') go.click();
            if (e.key === 'Escape') loadMessages();
          });
          actions.textContent = '';
          var wrap = h('span', 'inline');
          wrap.appendChild(input); wrap.appendChild(go); wrap.appendChild(cancel);
          actions.appendChild(wrap);
          input.focus();
        }));
        card.appendChild(actions);
        list.appendChild(card);
      });
  }

  function moveMessage(shown, index, step, button) {
    var to = index + step;
    if (to < 0 || to >= shown.length) return;
    var moved = shown.slice();
    var held = moved[index];
    moved[index] = moved[to];
    moved[to] = held;
    busy(button, post('/api/console/messages/order', {
      ids: moved.map(function (m) { return m.id; })
    })).then(function (r) { if (done(r, 'Order saved')) loadMessages(); }).catch(function () {});
  }
})(window.dash);
