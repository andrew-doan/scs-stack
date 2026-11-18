// Role menus, on the Discord tab.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, busy = dash.busy, done = dash.done, el = dash.el, h = dash.h,
    labelled = dash.labelled, post = dash.post, row = dash.row, shake = dash.shake, state = dash.state,
    textInput = dash.textInput, toast = dash.toast;

  dash.renderDiscordMenus = renderDiscordMenus;

  // ---- role menus ----
  // A message the bot posts with a dropdown, from which members give
  // themselves roles: a name colour, a pronoun, a ping. The worker only
  // ever moves the roles a menu offers (rolemenus.js).
  var LINE_COLOURS = [['Red', 0xee352e], ['Orange', 0xff6319], ['Yellow', 0xfccc0a], ['Light Green', 0x6cbe45],
    ['Green', 0x00933c], ['Blue', 0x0039a6], ['Purple', 0xb933ad], ['Brown', 0x996633], ['Grey', 0xa7a9ac]];
  state.menuGuild = '';
  state.menus = [];
  state.menuDraft = null;
  state.menuDetail = null;
  state.menuNote = '';

  function renderDiscordMenus() {
    var box = el('discord-menus');
    var live = state.discord.guilds.filter(function (g) { return g.in_server; });
    box.classList.toggle('hidden', !live.length);
    if (!live.length) return;
    if (!live.some(function (g) { return g.guild_id === state.menuGuild; })) {
      state.menuGuild = live[0].guild_id;
      state.menuDraft = null;
    }
    box.textContent = '';
    var head = h('div', 'card-head');
    head.appendChild(h('h2', 'card-title', 'Role menus'));
    if (live.length > 1) {
      var which = h('select');
      which.setAttribute('aria-label', 'Server');
      live.forEach(function (g) { var o = h('option', null, g.name || g.guild_id); o.value = g.guild_id; which.appendChild(o); });
      which.value = state.menuGuild;
      which.addEventListener('change', function () { state.menuGuild = which.value; state.menuDraft = null; state.menuNote = ''; loadMenus(); });
      head.appendChild(which);
    }
    head.appendChild(btn('New menu', 'fixed', function () { openMenu(null); }));
    box.appendChild(head);
    box.appendChild(h('p', 'card-sub', 'A message the bot posts with a dropdown, from which members give themselves roles.'));
    var note = h('p', 'dc-bad dm-note');
    note.id = 'dm-note';
    box.appendChild(note);
    var list = h('div', 'table-scroll');
    list.id = 'dm-list';
    box.appendChild(list);
    var editor = h('div', 'dm-edit');
    editor.id = 'dm-edit';
    box.appendChild(editor);
    loadMenus();
  }

  function loadMenus() {
    var guildId = state.menuGuild;
    Promise.all([api('/api/console/discord/menus?guild_id=' + encodeURIComponent(guildId)), dash.guildDetail(guildId)]).then(function (res) {
      if (guildId !== state.menuGuild) return;
      state.menus = res[0].ok ? res[0].menus : [];
      state.menuDetail = res[1];
      drawMenuList();
      drawMenuEditor();
    }).catch(function () {});
  }

  function menuChannels() {
    var detail = state.menuDetail || { channels: [] };
    var cats = {};
    detail.channels.forEach(function (c) { if (c.type === 4) cats[c.id] = c.name; });
    return detail.channels.filter(function (c) { return c.type !== 4; }).map(function (c) {
      return { id: c.id, name: c.name, label: '#' + c.name + (c.parent_id && cats[c.parent_id] ? ' (' + cats[c.parent_id] + ')' : '') };
    });
  }
  function menuRole(id) {
    return ((state.menuDetail && state.menuDetail.roles) || []).filter(function (r) { return r.id === id; })[0] || null;
  }
  function hexOf(colour) {
    return '#' + ('000000' + Number(colour || 0).toString(16)).slice(-6);
  }

  function drawMenuList() {
    var list = el('dm-list');
    if (!list) return;
    el('dm-note').textContent = state.menuNote;
    list.textContent = '';
    if (!state.menus.length) { list.appendChild(h('p', 'muted', 'No role menus yet.')); return; }
    var names = {};
    menuChannels().forEach(function (c) { names[c.id] = c.name; });
    var tb = h('tbody');
    state.menus.forEach(function (m) {
      var act = h('td', 'actions');
      act.appendChild(btn('Edit', 'quiet small', function () { openMenu(m); }));
      var delHost = h('span', 'inline');
      var del = btn('Delete', 'danger small', function () {
        var go = btn('Delete ' + m.title, 'danger small', function () {
          busy(go, post('/api/console/discord/menus/delete', { id: m.id })).then(function (r) {
            if (!done(r, 'Deleted ' + m.title)) return;
            if (state.menuDraft && state.menuDraft.id === m.id) state.menuDraft = null;
            loadMenus();
          }).catch(function () {});
        });
        delHost.textContent = '';
        delHost.appendChild(go);
        delHost.appendChild(btn('Cancel', 'quiet small', drawMenuList));
      });
      delHost.appendChild(del);
      act.appendChild(delHost);
      tb.appendChild(row([
        h('td', null, m.title),
        h('td', null, m.pick === 'one' ? 'One' : 'Any number'),
        h('td', null, m.options.map(function (o) { return o.label; }).join(', ')),
        h('td', 'muted', m.message_id ? '#' + (names[m.channel_id] || m.channel_id) : 'Not posted'),
        act
      ]));
    });
    var table = h('table');
    var thead = h('thead');
    thead.appendChild(row([h('th', null, 'Menu'), h('th', null, 'Members pick'), h('th', null, 'Roles'), h('th', null, 'Posted in'), h('th')]));
    table.appendChild(thead);
    table.appendChild(tb);
    list.appendChild(table);
  }

  function openMenu(m) {
    state.menuDraft = m
      ? { id: m.id, title: m.title, body: m.body, pick: m.pick, channel_id: m.channel_id || '',
          options: m.options.map(function (o) { return { role_id: o.role_id, label: o.label, description: o.description || '', emoji: o.emoji || '' }; }) }
      : { id: 0, title: '', body: '', pick: 'one', channel_id: '', options: [] };
    drawMenuEditor();
    el('dm-edit').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  // a role picked for the first time names its row, until the row is
  // given a name of its own
  function addMenuRole(role) {
    var dr = state.menuDraft;
    if (!dr || dr.options.some(function (o) { return o.role_id === role.id; })) return;
    var blank = dr.options.filter(function (o) { return !o.role_id; })[0];
    if (blank) { blank.role_id = role.id; blank.label = blank.label || role.name; }
    else dr.options.push({ role_id: role.id, label: role.name, description: '', emoji: '' });
  }

  function drawMenuEditor() {
    var box = el('dm-edit');
    if (!box) return;
    box.textContent = '';
    var dr = state.menuDraft;
    if (!dr) return;
    var roles = (state.menuDetail && state.menuDetail.roles) || [];
    box.appendChild(h('h3', null, dr.id ? dr.title : 'New role menu'));

    var fields = h('div', 'dc-grid');
    var title = textInput(dr.title, 'Name colour');
    title.addEventListener('input', function () { dr.title = title.value; });
    var pick = h('select');
    [['one', 'One'], ['many', 'Any number']].forEach(function (p) { var o = h('option', null, p[1]); o.value = p[0]; pick.appendChild(o); });
    pick.value = dr.pick;
    pick.addEventListener('change', function () { dr.pick = pick.value; });
    var chan = h('select');
    var none = h('option', null, 'Not posted yet');
    none.value = '';
    chan.appendChild(none);
    menuChannels().forEach(function (c) { var o = h('option', null, c.label); o.value = c.id; chan.appendChild(o); });
    chan.value = dr.channel_id;
    chan.addEventListener('change', function () { dr.channel_id = chan.value; });
    fields.appendChild(labelled('Title', title));
    fields.appendChild(labelled('Members pick', pick));
    fields.appendChild(labelled('Posted in', chan));
    box.appendChild(fields);
    var words = h('textarea', 'dm-words');
    words.rows = 2;
    words.value = dr.body;
    words.placeholder = 'Words above the dropdown';
    words.setAttribute('aria-label', 'Words above the dropdown');
    words.addEventListener('input', function () { dr.body = words.value; });
    box.appendChild(words);

    var rows = h('div', 'dm-rows');
    dr.options.forEach(function (o, i) {
      var line = h('div', 'dm-row');
      var swatch = h('span', 'dm-swatch');
      function paint() {
        var role = menuRole(o.role_id);
        swatch.style.background = role && role.color ? hexOf(role.color) : 'transparent';
      }
      var sel = h('select');
      sel.setAttribute('aria-label', 'Role');
      var blank = h('option', null, 'Pick a role');
      blank.value = '';
      sel.appendChild(blank);
      roles.forEach(function (r) { var opt = h('option', null, r.name); opt.value = r.id; sel.appendChild(opt); });
      sel.value = o.role_id;
      var label = textInput(o.label, 'Label in the dropdown');
      sel.addEventListener('change', function () {
        var was = menuRole(o.role_id);
        var now = menuRole(sel.value);
        if (!o.label || (was && o.label === was.name)) { o.label = now ? now.name : ''; label.value = o.label; }
        o.role_id = sel.value;
        paint();
      });
      label.addEventListener('input', function () { o.label = label.value; });
      var desc = textInput(o.description, 'Description');
      desc.classList.add('dm-desc');
      desc.addEventListener('input', function () { o.description = desc.value; });
      var emoji = textInput(o.emoji, 'Emoji');
      emoji.classList.add('dm-emoji');
      emoji.addEventListener('input', function () { o.emoji = emoji.value; });
      paint();
      line.appendChild(swatch);
      line.appendChild(sel);
      line.appendChild(label);
      line.appendChild(desc);
      line.appendChild(emoji);
      line.appendChild(btn('Remove', 'quiet small', function () { dr.options.splice(i, 1); drawMenuEditor(); }));
      rows.appendChild(line);
    });
    box.appendChild(rows);

    var more = h('div', 'row-form');
    more.appendChild(btn('Add a role', 'quiet fixed', function () {
      dr.options.push({ role_id: '', label: '', description: '', emoji: '' });
      drawMenuEditor();
    }));
    // a role made here for the menu, a colour role usually
    var newName = textInput('', 'New role name');
    var newColour = h('input');
    newColour.type = 'color';
    newColour.value = '#00933c';
    newColour.setAttribute('aria-label', 'Colour');
    function makeRole(name, colour) {
      return post('/api/console/discord/roles/create', { guild_id: state.menuGuild, name: name, color: colour });
    }
    function freshRoles() {
      delete state.discordDetail[state.menuGuild];
      return dash.guildDetail(state.menuGuild).then(function (d) { state.menuDetail = d; });
    }
    var make = btn('Make role', 'quiet fixed', function () {
      if (!newName.value.trim()) { shake(newName); return; }
      busy(make, makeRole(newName.value.trim(), parseInt(newColour.value.slice(1), 16))).then(function (r) {
        if (!done(r, function () { return (r.reused ? 'Added ' : 'Made ') + r.role.name; })) return;
        return freshRoles().then(function () { addMenuRole(r.role); drawMenuEditor(); });
      }).catch(function () {});
    });
    // the site's line colours, one role each; any already made are used
    var lines = btn('Add the line colours', 'quiet fixed', function () {
      var made = [];
      var chain = Promise.resolve();
      LINE_COLOURS.forEach(function (c) {
        chain = chain.then(function () {
          return makeRole(c[0], c[1]).then(function (r) { if (r.ok) made.push(r.role); });
        });
      });
      busy(lines, chain.then(freshRoles)).then(function () {
        made.forEach(addMenuRole);
        if (!dr.title) dr.title = 'Name colour';
        toast(made.length + ' colour roles added');
        drawMenuEditor();
      }).catch(function () {});
    });
    more.appendChild(newName);
    more.appendChild(newColour);
    more.appendChild(make);
    more.appendChild(lines);
    box.appendChild(more);

    var actions = h('div', 'row-form');
    function save(andPost, button) {
      var body = { id: dr.id, guild_id: state.menuGuild, title: dr.title, body: dr.body, pick: dr.pick,
        options: dr.options.filter(function (o) { return o.role_id; }) };
      if (andPost && !dr.channel_id) { shake(chan); toast('Pick a channel to post it in.', true); return; }
      busy(button, post('/api/console/discord/menus/save', body).then(function (r) {
        if (!r.ok || !andPost) return r;
        dr.id = r.menu.id;
        return post('/api/console/discord/menus/post', { id: r.menu.id, channel_id: dr.channel_id });
      })).then(function (r) {
        if (!done(r, andPost ? 'Posted ' + dr.title : 'Saved ' + dr.title)) return;
        state.menuNote = r.note || '';
        state.menuDraft = null;
        loadMenus();
      }).catch(function () {});
    }
    var saveBtn = btn('Save', 'quiet fixed', function () { save(false, saveBtn); });
    var postBtn = btn('Save and post', 'fixed', function () { save(true, postBtn); });
    actions.appendChild(postBtn);
    actions.appendChild(saveBtn);
    actions.appendChild(btn('Cancel', 'quiet fixed', function () { state.menuDraft = null; drawMenuEditor(); }));
    box.appendChild(actions);
  }
})(window.dash);
