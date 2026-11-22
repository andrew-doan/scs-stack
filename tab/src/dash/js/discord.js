// The Discord tab: servers, holding every post, sending a message as
// the bot, team roles and channels, submit codes and members.
(function (dash) {
  // core.js
  var api = dash.api, btn = dash.btn, busy = dash.busy, done = dash.done, el = dash.el, fill = dash.fill,
    fmtTime = dash.fmtTime, h = dash.h, heldIn = dash.heldIn, hiddenTeamNames = dash.hiddenTeamNames,
    holdOpen = dash.holdOpen, labelled = dash.labelled, letGo = dash.letGo, post = dash.post, row = dash.row,
    savesAtOnce = dash.savesAtOnce, state = dash.state, textInput = dash.textInput, toast = dash.toast;

  dash.loadDiscord = loadDiscord;
  dash.guildDetail = guildDetail;
  dash.renderDiscord = renderDiscord;

  // ---- discord: servers, the bot, messages, team roles and channels ----
  state.discord = null;
  state.discordDetail = {};
  state.discordReports = {};
  function loadDiscord() {
    el('discord-status').textContent = 'Asking Discord…';
    api('/api/console/discord/status').then(function (d) {
      if (!d.ok) return;
      state.discord = d;
      renderDiscord();
    }).catch(function () { el('discord-status').textContent = 'Could not load the Discord status.'; });
  }
  // Hold posts: a tick box a server, each saved as soon as it is flipped
  function renderHold() {
    var box = el('discord-hold');
    box.textContent = '';
    el('discord-hold-card').classList.toggle('hidden', !state.discord.guilds.length);
    state.discord.guilds.forEach(function (g) {
      var name = g.name || 'Server ' + g.guild_id;
      var tick = h('input');
      tick.type = 'checkbox';
      tick.checked = !!g.held;
      var label = h('label', 'check-inline');
      label.appendChild(tick);
      label.appendChild(document.createTextNode(' ' + name));
      box.appendChild(label);
      savesAtOnce(tick, function (want) {
        return post('/api/console/discord/hold', { guild_id: g.guild_id, held: want }).then(function (r) {
          var ok = done(r, want ? 'Posts to ' + name + ' are held. Each one goes in the Log.' : 'Posts go to ' + name + ' again.');
          if (ok) g.held = want ? 1 : 0;
          return ok;
        });
      });
    });
  }
  function guildDetail(guildId) {
    if (state.discordDetail[guildId]) return Promise.resolve(state.discordDetail[guildId]);
    return api('/api/console/discord/guild?guild_id=' + encodeURIComponent(guildId)).then(function (d) {
      if (!d.ok) throw new Error(d.error || 'no detail');
      state.discordDetail[guildId] = d;
      return d;
    });
  }
  function renderDiscord() {
    var d = state.discord;
    var status = el('discord-status');
    status.textContent = '';
    if (!d.configured) {
      status.appendChild(h('span', 'dc-bad', 'The bot token is not set. '));
      status.appendChild(document.createTextNode('Run npx wrangler secret put DISCORD_BOT_TOKEN, then reload.'));
    } else if (!d.bot) {
      status.appendChild(h('span', 'dc-bad', 'Discord did not accept the bot token.' + (d.why ? ' ' + d.why : '')));
    } else {
      status.appendChild(h('span', 'dc-ok', 'Signed in as ' + d.bot.username + '. '));
      status.appendChild(document.createTextNode('Members get their team role and channel by running /verify, or all at once from a server\'s Set up teams and give out roles.'));
    }
    renderHold();
    var servers = el('discord-servers');
    // a server card with a run still going on it stays as it is, so the
    // run reports on the card on the page and its button stays busy
    var take = heldIn(servers);
    servers.textContent = '';
    d.guilds.forEach(function (g) { servers.appendChild(take('g' + g.guild_id) || serverCard(g)); });
    var row = h('div', 'row-form');
    var pick = h('select');
    var manual = h('option', null, d.servers.length ? 'Add a server the bot is in' : 'Add a server by id'); manual.value = '';
    pick.appendChild(manual);
    d.servers.forEach(function (sv) { var o = h('option', null, sv.name + ' (' + sv.id + ')'); o.value = sv.id; pick.appendChild(o); });
    var idInput = textInput('', 'or type a server id', true);
    pick.addEventListener('change', function () { idInput.value = pick.value; });
    var add = btn('Add server', 'fixed', function () {
      var chosen = d.servers.filter(function (sv) { return sv.id === idInput.value.trim(); })[0];
      busy(add, post('/api/console/discord/guild/save', { guild_id: idInput.value, name: chosen ? chosen.name : '', organiser_role_id: '', category_name: 'Private Channels' }))
        .then(function (r) { if (done(r, 'Added. Now pick its organiser role.')) { state.discordDetail = {}; loadDiscord(); } })
        .catch(function () {});
    });
    row.appendChild(pick); row.appendChild(idInput); row.appendChild(add);
    servers.appendChild(row);
    renderDiscordPost();
    dash.renderDiscordMenus();
    renderDiscordTeams();
    renderDiscordCodes();
    renderDiscordMembers();
  }
  function serverCard(g) {
    var card = h('div', 'card dc-server');
    var title = h('div', 'dc-title');
    title.appendChild(h('strong', null, g.name || 'Server ' + g.guild_id));
    title.appendChild(h('span', 'mono muted', g.guild_id));
    title.appendChild(h('span', g.in_server ? 'dc-ok' : 'dc-bad', g.in_server ? 'bot is in this server' : (state.discord.configured ? 'the bot is not in this server' : '')));
    title.appendChild(h('span', 'muted', g.teams_setup + ' team' + (g.teams_setup === 1 ? '' : 's') + ' set up, ' + g.verified + ' with a team role'));
    card.appendChild(title);
    var grid = h('div', 'dc-grid');
    var role = h('select');
    var none = h('option', null, 'Choose the organiser role'); none.value = ''; role.appendChild(none);
    if (g.organiser_role_id) { var cur = h('option', null, 'Role ' + g.organiser_role_id); cur.value = g.organiser_role_id; role.appendChild(cur); role.value = g.organiser_role_id; }
    var category = textInput(g.category_name, 'Private Channels');
    var enabled = h('select');
    [['1', 'Enabled'], ['0', 'Paused']].forEach(function (o) { var opt = h('option', null, o[1]); opt.value = o[0]; enabled.appendChild(opt); });
    enabled.value = g.enabled ? '1' : '0';
    // where a new message from the Messages tab is cross-posted
    var announce = h('select');
    var noChannel = h('option', null, 'No cross-posting'); noChannel.value = ''; announce.appendChild(noChannel);
    if (g.announce_channel_id) {
      var chan = h('option', null, 'Channel ' + g.announce_channel_id);
      chan.value = g.announce_channel_id;
      announce.appendChild(chan);
      announce.value = g.announce_channel_id;
    }
    var accepts = h('select');
    [['1', 'Reviews, points and check-ins'], ['0', 'None']].forEach(function (o) { var opt = h('option', null, o[1]); opt.value = o[0]; accepts.appendChild(opt); });
    accepts.value = g.accept_posts === 0 ? '0' : '1';
    grid.appendChild(labelled('Organiser role (OrgCom)', role));
    grid.appendChild(labelled('Team channels go under', category));
    grid.appendChild(labelled('Verification and score changes', enabled));
    grid.appendChild(labelled('New messages are posted in', announce));
    grid.appendChild(labelled('Posted in team channels', accepts));
    // the two roles the bot hands out by itself: for a member no signup
    // lists, and for somebody signed up without a team and not placed yet
    var unknown = h('select');
    var botUnknown = h('option', null, 'Unknown Team'); botUnknown.value = '';
    if (g.unknown_role_id) {
      var stored = h('option', null, 'Role ' + g.unknown_role_id);
      stored.value = g.unknown_role_id;
      unknown.appendChild(stored);
      unknown.value = g.unknown_role_id;
    } else unknown.appendChild(botUnknown);
    grid.appendChild(labelled('Not on any signup', unknown));
    var noTeam = h('select');
    var asUnknown = h('option', null, 'Unknown Team'); asUnknown.value = ''; noTeam.appendChild(asUnknown);
    if (g.no_team_role_id) {
      var held = h('option', null, 'Role ' + g.no_team_role_id);
      held.value = g.no_team_role_id;
      noTeam.appendChild(held);
      noTeam.value = g.no_team_role_id;
    }
    grid.appendChild(labelled('Signed up without a team', noTeam));
    card.appendChild(grid);

    // Besides the organiser role, the roles that see and talk in every
    // team channel. Roles differ from server to server, so each server
    // keeps its own list.
    var staffBox = h('div', 'dc-staff');
    staffBox.appendChild(h('p', 'dc-staff-head', 'Roles that see every team channel'));
    var staffList = h('div', 'dc-staff-list');
    staffBox.appendChild(staffList);
    var staffBoxes = [];
    function drawStaff(roles) {
      var ticked = staffBoxes.length ? pickedStaff() : (g.staff_role_ids || []);
      staffList.textContent = '';
      staffBoxes = [];
      roles.forEach(function (r) {
        var lab = h('label');
        var box = h('input');
        box.type = 'checkbox';
        box.value = r.id;
        var organiser = r.id === role.value;
        box.checked = organiser || ticked.indexOf(r.id) !== -1;
        box.disabled = organiser;
        lab.appendChild(box);
        lab.appendChild(document.createTextNode(r.name + (organiser ? ' (organiser role)' : '')));
        staffList.appendChild(lab);
        staffBoxes.push(box);
      });
    }
    function pickedStaff() {
      return staffBoxes.filter(function (b) { return b.checked && !b.disabled; }).map(function (b) { return b.value; });
    }
    if (g.in_server) card.appendChild(staffBox);
    if (g.in_server) {
      guildDetail(g.guild_id).then(function (detail) {
        var keep = role.value;
        role.textContent = '';
        role.appendChild(none);
        detail.roles.forEach(function (r) { var o = h('option', null, r.name); o.value = r.id; role.appendChild(o); });
        role.value = keep;
        var keepChannel = announce.value;
        announce.textContent = '';
        announce.appendChild(noChannel);
        var cats = {};
        detail.channels.forEach(function (c) { if (c.type === 4) cats[c.id] = c.name; });
        detail.channels.filter(function (c) { return c.type !== 4; }).forEach(function (c) {
          var o = h('option', null, '#' + c.name + (c.parent_id && cats[c.parent_id] ? ' (' + cats[c.parent_id] + ')' : ''));
          o.value = c.id;
          announce.appendChild(o);
        });
        announce.value = keepChannel;
        if (!keep) {
          // a role called OrgComm (or OrgCom, or organiser-ish) is the obvious default
          var guess = detail.roles.filter(function (r) { return /^orgcomm?$/i.test(r.name); })[0] || detail.roles.filter(function (r) { return /organis/i.test(r.name); })[0];
          if (guess) role.value = guess.id;
        }
        drawStaff(detail.roles);
        role.addEventListener('change', function () { drawStaff(detail.roles); });
        // with nothing stored the bot finds its own Unknown Team by name,
        // so that one is the first choice rather than listed twice
        var keepUnknown = unknown.value;
        unknown.textContent = '';
        if (!g.unknown_role_id) unknown.appendChild(botUnknown);
        detail.roles.forEach(function (r) {
          if (!g.unknown_role_id && r.name === 'Unknown Team') return;
          var o = h('option', null, r.name);
          o.value = r.id;
          unknown.appendChild(o);
        });
        unknown.value = keepUnknown;
        if (g.unknown_role_id && unknown.selectedIndex >= 0) unknownName = unknown.options[unknown.selectedIndex].textContent;
        var keepNoTeam = noTeam.value;
        noTeam.textContent = '';
        noTeam.appendChild(asUnknown);
        detail.roles.forEach(function (r) {
          if (r.id === keepUnknown || (!keepUnknown && r.name === 'Unknown Team')) return;
          var o = h('option', null, r.name);
          o.value = r.id;
          noTeam.appendChild(o);
        });
        noTeam.value = keepNoTeam;
        asUnknown.textContent = unknownName;
        noTeamName = noTeam.value && noTeam.selectedIndex >= 0 ? noTeam.options[noTeam.selectedIndex].textContent : '';
        recheck.textContent = recheckLabel();
      }).catch(function () {});
    }
    var actions = h('div', 'row-form');
    var save = btn('Save', null, function () {
      var staff = staffBoxes.length ? pickedStaff() : (g.staff_role_ids || []);
      // who sees the team channels changed: bring every channel up to date
      var reopen = staffBoxes.length && (role.value !== (g.organiser_role_id || '') ||
        staff.slice().sort().join() !== (g.staff_role_ids || []).slice().sort().join());
      busy(save, post('/api/console/discord/guild/save', { guild_id: g.guild_id, name: g.name, organiser_role_id: role.value, category_name: category.value, enabled: enabled.value === '1', announce_channel_id: announce.value, staff_role_ids: staff, accept_posts: accepts.value === '1', unknown_role_id: unknown.value, no_team_role_id: noTeam.value }))
        .then(function (r) {
          if (!done(r, r && r.note ? r.note : 'Saved ' + (g.name || g.guild_id))) return;
          if (reopen && !r.note) { g.organiser_role_id = role.value; g.staff_role_ids = staff; updateChannels(); }
          else loadDiscord();
        }).catch(function () {});
    });
    var register = btn('Register the commands here', 'quiet', function () {
      busy(register, post('/api/console/discord/register', { guild_id: g.guild_id }))
        .then(function (r) { done(r, 'Registered /' + (r.commands || []).join(', /')); }).catch(function () {});
    });
    // What the last run of either button below said, kept in state so
    // it survives the card being drawn again when the status reloads.
    var report = h('div', 'dc-report');
    function showReport(lines, ephemeral) {
      if (!ephemeral) {
        state.discordReports[g.guild_id] = lines.filter(function (l) { return !(l && l.nodeType && l.tagName === 'BUTTON'); });
      }
      fill(report, lines.map(function (l) {
        if (l && l.nodeType) return l;
        return h('p', null, l);
      }));
    }
    if (state.discordReports[g.guild_id]) showReport(state.discordReports[g.guild_id]);
    // while a run is going the card is held, and the tab drawing its
    // servers again leaves this one as it is
    var runs = 0;
    function running(on) {
      runs += on ? 1 : -1;
      if (runs > 0) holdOpen(card, 'g' + g.guild_id); else letGo(card);
    }

    // One team per request, in turn, so a long list never has to fit in
    // one request and the line below can say how far it has got.
    var setup = btn('Set up teams and give out roles', 'quiet', function () {
      var teams = state.discord.teams.filter(function (t) { return !t.hidden && (t.registrations || t.people); });
      if (!teams.length) { toast('No team has anybody on it yet.', true); return; }
      var at = 0, made = 0, given = 0, missing = [], failed = [], inARow = 0;
      setup.disabled = true; setup.classList.add('is-busy');
      running(true);
      function next() {
        if (at >= teams.length || inARow >= 3) { finish(); return; }
        var t = teams[at++];
        showReport(['Setting up ' + t.name + ' (' + at + ' of ' + teams.length + ')…']);
        post('/api/console/discord/setup', { guild_id: g.guild_id, team_id: t.id, members: true }).then(function (r) {
          var d = r && r.ok && r.done && r.done[0];
          if (d) {
            inARow = 0;
            if (d.made && (d.made.role || d.made.channel)) made++;
            given += d.given || 0;
            missing = missing.concat(d.missing || []);
          } else {
            inARow++;
            var why = (r && (r.error || (r.failed && r.failed[0] && r.failed[0].error))) || 'did not go through';
            failed.push(t.name + ': ' + why);
          }
        }, function () {
          inARow++;
          failed.push(t.name + ': the worker did not answer');
        }).then(next);
      }
      function finish() {
        setup.disabled = false; setup.classList.remove('is-busy');
        running(false);
        var lines = [(at - failed.length) + ' of ' + teams.length + ' teams set up (' + made + ' new). ' +
          given + ' ' + (given === 1 ? 'person' : 'people') + ' given their team role.'];
        if (missing.length) lines.push('Not in the server yet (' + missing.length + '): ' + missing.join(', '));
        if (inARow >= 3) lines.push('Stopped after three teams in a row failed. Run it again to carry on.');
        failed.forEach(function (f) { lines.push(h('p', 'dc-bad', f)); });
        showReport(lines);
        state.discordDetail = {}; loadDiscord();
      }
      next();
    });

    // Every member with no role yet: their team's role and Legend, or
    // Unknown Team and Legend. A page of members per request, until the
    // worker says it has reached the end of the list. The recheck goes
    // through the same list and only moves the members with no team role
    // whose signup has since been found on a team.
    function sweep(button, recheck) {
      var totals = { checked: 0, team: 0, noteam: 0, unknown: 0, legend: 0 };
      var waitName = '';
      var unknownSaid = unknownName;
      var failed = [];
      button.disabled = true; button.classList.add('is-busy');
      running(true);
      function more(after) {
        post('/api/console/discord/roles/all', { guild_id: g.guild_id, after: after, recheck: recheck }).then(function (r) {
          if (!r || !r.ok) { finish((r && r.error) || 'That did not go through.'); return; }
          Object.keys(totals).forEach(function (k) { totals[k] += r[k] || 0; });
          waitName = r.no_team_role || waitName;
          unknownSaid = r.unknown_role || unknownSaid;
          failed = failed.concat(r.failed || []);
          if (r.done) { finish(''); return; }
          if (r.halted) { finish('Stopped. Check the bot can manage roles and that its role is above the team roles, then run it again.'); return; }
          showReport(['Checked ' + totals.checked + ' members so far…']);
          more(r.after);
        }, function () { finish('The worker did not answer. Run it again to carry on.'); });
      }
      function finish(problem) {
        button.disabled = false; button.classList.remove('is-busy');
        running(false);
        var lines = ['Checked ' + totals.checked + (totals.checked === 1 ? ' member.' : ' members.'),
          totals.team + (recheck ? ' moved to their team.' : ' given their team role and Legend.')];
        if (waitName) {
          lines.push(totals.noteam + (recheck ? ' moved from ' + unknownSaid + ' to ' + waitName + '.' : ' signed up without a team given ' + waitName + ' and Legend.'));
        }
        if (!recheck) {
          lines.push(totals.unknown + ' given ' + unknownSaid + ' and Legend.');
          lines.push(totals.legend + ' already in a team given Legend.');
        }
        failed.forEach(function (f) { lines.push(h('p', 'dc-bad', f)); });
        if (problem) lines.push(h('p', 'dc-bad', problem));
        showReport(lines);
        state.discordDetail = {}; loadDiscord();
      }
      more('');
    }
    var everyone = btn('Give every member a role', 'quiet', function () { sweep(everyone, false); });
    // the recheck covers the no-team role too, and says so once it is named
    var unknownName = 'Unknown Team';
    var noTeamName = '';
    function recheckLabel() { return 'Recheck ' + unknownName + (noTeamName ? ' and ' + noTeamName : ''); }
    var recheck = btn(recheckLabel(), 'quiet', function () { sweep(recheck, true); });

    // Every team channel this server already has, one request each, so
    // its permissions match the roles above.
    function updateChannels() {
      var teams = state.discord.teams.filter(function (t) { return !t.hidden && t.guilds[g.guild_id] && t.guilds[g.guild_id].channel_id; });
      if (!teams.length) { showReport(['No team channels here yet.']); loadDiscord(); return; }
      var at = 0, failed = [];
      update.disabled = true; update.classList.add('is-busy');
      running(true);
      function next() {
        if (at >= teams.length || failed.length >= 3) { finish(); return; }
        var t = teams[at++];
        showReport(['Updating #' + t.guilds[g.guild_id].channel_name + ' (' + at + ' of ' + teams.length + ')…']);
        post('/api/console/discord/setup', { guild_id: g.guild_id, team_id: t.id }).then(function (r) {
          if (!(r && r.ok && r.done && r.done.length)) {
            failed.push(t.name + ': ' + ((r && (r.error || (r.failed && r.failed[0] && r.failed[0].error))) || 'did not go through'));
          }
        }, function () { failed.push(t.name + ': the worker did not answer'); }).then(next);
      }
      function finish() {
        update.disabled = false; update.classList.remove('is-busy');
        running(false);
        var lines = [(at - failed.length) + ' of ' + teams.length + ' team channels updated.'];
        if (failed.length >= 3 && at < teams.length) lines.push('Stopped after three failed. Run it again to carry on.');
        failed.forEach(function (f) { lines.push(h('p', 'dc-bad', f)); });
        showReport(lines);
        state.discordDetail = {}; loadDiscord();
      }
      next();
    }
    var update = btn('Update team channels', 'quiet', updateChannels);

    // The bot's posts in every team channel here given fresh links to
    // their photos and videos, so Discord makes each preview again. One
    // team at a time, each a page of messages a request until it says
    // there are no more.
    function refreshPreviews() {
      var teams = state.discord.teams.filter(function (t) { return !t.hidden && t.guilds[g.guild_id] && t.guilds[g.guild_id].channel_id; });
      if (!teams.length) { showReport(['No team channels here yet.']); return; }
      var at = 0, edited = 0, failed = [], stopped = '';
      refresh.disabled = true; refresh.classList.add('is-busy');
      running(true);
      function team() {
        if (at >= teams.length || stopped) { finish(); return; }
        var t = teams[at++];
        function more(before) {
          showReport(['Refreshing #' + t.guilds[g.guild_id].channel_name + ' (' + at + ' of ' + teams.length + ')…',
            edited + (edited === 1 ? ' post' : ' posts') + ' refreshed so far.']);
          post('/api/console/discord/refresh', { guild_id: g.guild_id, team_id: t.id, before: before }).then(function (r) {
            if (!r || !r.ok) { failed.push(t.name + ': ' + ((r && r.error) || 'did not go through')); team(); return; }
            edited += r.edited;
            (r.failed || []).slice(0, 2).forEach(function (f) { failed.push(t.name + ': ' + f); });
            if (r.halted) { stopped = r.halted; finish(); return; }
            if (r.before) more(r.before); else team();
          }, function () { failed.push(t.name + ': the worker did not answer'); team(); });
        }
        more('');
      }
      function finish() {
        refresh.disabled = false; refresh.classList.remove('is-busy');
        running(false);
        var lines = [edited + (edited === 1 ? ' post' : ' posts') + ' refreshed in ' + at + ' of ' + teams.length + ' team channels.'];
        if (stopped) lines.push(h('p', 'dc-bad', 'Stopped: ' + stopped));
        failed.slice(0, 6).forEach(function (f) { lines.push(h('p', 'dc-bad', f)); });
        showReport(lines);
      }
      team();
    }
    var refresh = btn('Refresh photo and video previews', 'quiet', refreshPreviews);

    // Roles and channels a setup cut off part way left behind. Listed
    // first; deleted only from the button that appears with the list.
    var tidy = btn('Find leftover roles and channels', 'quiet', function () {
      busy(tidy, api('/api/console/discord/leftovers?guild_id=' + encodeURIComponent(g.guild_id))).then(function (r) {
        if (!r.ok) { done(r); return; }
        var all = r.roles.map(function (x) { return { label: '@' + x.name, hidden: x.hidden }; })
          .concat(r.channels.map(function (x) { return { label: '#' + x.name, hidden: x.hidden }; }));
        var names = all.filter(function (x) { return !x.hidden; }).map(function (x) { return x.label; });
        var tests = all.filter(function (x) { return x.hidden; }).map(function (x) { return x.label; });
        var forget = r.hidden_teams || [];
        if (!all.length && !forget.length) { showReport(['No leftover roles or channels.']); return; }
        var go = btn(all.length ? 'Delete these ' + all.length : 'Forget them', 'danger', function () {
          var deleted = 0;
          // the second password, once for the whole run
          var hold = { value: '' };
          go.disabled = true; go.classList.add('is-busy');
          running(true);
          function more() {
            post('/api/console/discord/leftovers/delete', { guild_id: g.guild_id }, hold).then(function (d) {
              if (!d.ok) { running(false); showReport([h('p', 'dc-bad', d.error)]); return; }
              deleted += d.deleted;
              if (d.left && d.deleted) { showReport(['Deleted ' + deleted + ', ' + d.left + ' to go…']); more(); return; }
              running(false);
              showReport(['Deleted ' + deleted + '.' + (d.forgotten ? ' The bot has forgotten ' + d.forgotten + ' hidden ' + (d.forgotten === 1 ? 'team' : 'teams') + ' here.' : '')]);
              state.discordDetail = {}; loadDiscord();
            }, function () { running(false); showReport([h('p', 'dc-bad', 'The worker did not answer. Deleted ' + deleted + ' so far.')]); });
          }
          more();
        });
        var lines = [];
        if (names.length) lines.push(names.length + ' with a team’s name that no team uses: ' + names.join(', '));
        if (tests.length) lines.push(tests.length + ' made for hidden teams: ' + tests.join(', '));
        if (forget.length) lines.push('The bot stops setting up ' + forget.join(', ') + ' here.');
        lines.push(go);
        showReport(lines, true);
      }).catch(function () {});
    });
    var removeHost = h('span', 'inline');
    var remove = btn('Remove', 'danger', function () {
      var go = btn('Remove ' + (g.name || g.guild_id), 'danger', function () {
        busy(go, post('/api/console/discord/guild/delete', { guild_id: g.guild_id }))
          .then(function (r) { if (done(r, 'Removed. Its roles and channels stay in Discord.')) loadDiscord(); }).catch(function () {});
      });
      var back = btn('Cancel', 'quiet', function () { removeHost.textContent = ''; removeHost.appendChild(remove); });
      removeHost.textContent = ''; removeHost.appendChild(go); removeHost.appendChild(back);
    });
    removeHost.appendChild(remove);
    actions.appendChild(save); actions.appendChild(register); actions.appendChild(setup); actions.appendChild(everyone); actions.appendChild(recheck); actions.appendChild(update); actions.appendChild(refresh); actions.appendChild(tidy);
    actions.appendChild(h('span', 'grow')); actions.appendChild(removeHost);
    if (!g.in_server) { register.disabled = true; setup.disabled = true; everyone.disabled = true; recheck.disabled = true; update.disabled = true; refresh.disabled = true; tidy.disabled = true; }
    card.appendChild(actions);
    card.appendChild(report);
    return card;
  }
  function renderDiscordPost() {
    var d = state.discord;
    var box = el('discord-post');
    var live = d.guilds.filter(function (g) { return g.in_server; });
    box.classList.toggle('hidden', !live.length);
    if (!live.length) return;
    var guildSel = el('discord-post-guild');
    var chanSel = el('discord-post-channel');
    var keep = guildSel.value;
    guildSel.textContent = '';
    live.forEach(function (g) { var o = h('option', null, g.name || g.guild_id); o.value = g.guild_id; guildSel.appendChild(o); });
    if (keep && live.some(function (g) { return g.guild_id === keep; })) guildSel.value = keep;
    function fillChannels() {
      var wantGuild = guildSel.value;
      chanSel.textContent = '';
      var wait = h('option', null, 'Loading channels…'); wait.value = ''; chanSel.appendChild(wait);
      guildDetail(wantGuild).then(function (detail) {
        if (guildSel.value !== wantGuild) return;
        chanSel.textContent = '';
        var cats = {};
        detail.channels.forEach(function (c) { if (c.type === 4) cats[c.id] = c.name; });
        detail.channels.filter(function (c) { return c.type !== 4; }).forEach(function (c) {
          var o = h('option', null, '#' + c.name + (c.parent_id && cats[c.parent_id] ? ' (' + cats[c.parent_id] + ')' : ''));
          o.value = c.id; chanSel.appendChild(o);
        });
      }).catch(function () {
        if (guildSel.value !== wantGuild) return;
        chanSel.textContent = ''; var bad = h('option', null, 'Could not list channels'); bad.value = ''; chanSel.appendChild(bad);
      });
    }
    guildSel.onchange = fillChannels;
    fillChannels();
  }
  function sendDiscordPost(preset) {
    var button = preset ? el('discord-post-leaderboard') : el('discord-post-send');
    var channel = el('discord-post-channel').value;
    if (!channel) { toast('Pick a channel first.', true); return; }
    busy(button, post('/api/console/discord/post', { guild_id: el('discord-post-guild').value, channel_id: channel, content: el('discord-post-text').value, preset: preset || '' }))
      .then(function (r) { if (done(r, preset ? 'Posted the top 10' : 'Posted') && !preset) el('discord-post-text').value = ''; })
      .catch(function () {});
  }
  el('discord-post-send').addEventListener('click', function () { sendDiscordPost(''); });
  el('discord-post-leaderboard').addEventListener('click', function () { sendDiscordPost('leaderboard'); });

  function renderDiscordTeams() {
    var d = state.discord;
    var box = el('discord-teams');
    box.textContent = '';
    var live = d.guilds.filter(function (g) { return g.in_server; });
    var teams = d.teams.filter(function (t) { return !t.hidden || !state.hideHidden; });
    box.classList.toggle('hidden', !live.length || !teams.length);
    if (!live.length || !teams.length) return;
    box.appendChild(h('h3', null, 'Team roles and channels'));
    var tb = h('tbody');
    var span = 3 + live.length;
    teams.forEach(function (t) {
      var nameTd = h('td', null, t.name);
      if (t.hidden) nameTd.appendChild(h('span', 'muted', ' (hidden)'));
      var cells = [nameTd, h('td', 'num', t.registrations ? 'yes' : 'no'), h('td', 'num', t.verified)];
      var editRow = null;
      live.forEach(function (g) {
        var s = t.guilds[g.guild_id];
        var td = h('td');
        if (s && (s.channel_id || s.role_id)) {
          td.appendChild(h('span', 'dc-ok', s.role_id ? '@' + s.role_name : 'no role'));
          td.appendChild(document.createTextNode(s.channel_id ? ' #' + s.channel_name : ' · no channel'));
        }
        if (!t.hidden) {
          td.appendChild(document.createTextNode(' '));
          td.appendChild(btn('Edit', 'quiet small', function () { editTeamDiscord(t, g, s || {}); }));
        }
        if (t.hidden) { if (!s || !s.channel_id) td.appendChild(h('span', 'muted', 'Hidden')); }
        else if (!s || !s.channel_id) {
          var go = btn('Set up', 'quiet small', function () {
            busy(go, post('/api/console/discord/setup', { guild_id: g.guild_id, team_id: t.id, members: true })).then(function (r) {
              if (!done(r, function () {
                if (!r.done.length) return r.failed[0] ? r.failed[0].error : 'nothing done';
                var d = r.done[0];
                return 'Set up ' + d.team + ', ' + d.given + ' given the role' + (d.missing.length ? ', ' + d.missing.length + ' not in the server' : '');
              })) return;
              state.discordDetail = {}; loadDiscord();
            }).catch(function () {});
          });
          td.appendChild(go);
        }
        cells.push(td);
      });
      var tr = row(cells);
      tb.appendChild(tr);
      // Picking a team's role and channel by hand, in a row under it.
      // The worker refuses what the bot would never give a team.
      function editTeamDiscord(team, g, s) {
        if (editRow) editRow.remove();
        editRow = h('tr', 'dc-team-edit');
        var cell = h('td');
        cell.colSpan = span;
        editRow.appendChild(cell);
        tr.parentNode.insertBefore(editRow, tr.nextSibling);
        cell.appendChild(h('p', 'muted', 'Loading ' + (g.name || g.guild_id) + '…'));
        guildDetail(g.guild_id).then(function (detail) {
          cell.textContent = '';
          var role = h('select');
          var none = h('option', null, 'No role: the next setup makes one'); none.value = ''; role.appendChild(none);
          detail.roles.forEach(function (r) {
            if (r.id === g.organiser_role_id) return;
            var o = h('option', null, '@' + r.name); o.value = r.id; role.appendChild(o);
          });
          role.value = s.role_id || '';
          var chan = h('select');
          var noChan = h('option', null, 'No channel: the next setup makes one'); noChan.value = ''; chan.appendChild(noChan);
          var cats = {};
          detail.channels.forEach(function (c) { if (c.type === 4) cats[c.id] = c.name; });
          detail.channels.filter(function (c) { return c.type === 0; }).forEach(function (c) {
            var o = h('option', null, '#' + c.name + (c.parent_id && cats[c.parent_id] ? ' (' + cats[c.parent_id] + ')' : ''));
            o.value = c.id;
            chan.appendChild(o);
          });
          chan.value = s.channel_id || '';
          var grid = h('div', 'dc-grid');
          grid.appendChild(labelled(team.name + '’s role', role));
          grid.appendChild(labelled(team.name + '’s channel', chan));
          cell.appendChild(grid);
          var actions = h('div', 'row-form dc-team-edit-actions');
          var save = btn('Save', null, function () {
            busy(save, post('/api/console/discord/team/save', { guild_id: g.guild_id, team_id: team.id, role_id: role.value, channel_id: chan.value }))
              .then(function (r) {
                if (!done(r, function () {
                  return r.note || 'Saved ' + team.name + '’s role and channel' + (r.given ? ', ' + r.given + ' given the role' : '');
                })) return;
                state.discordDetail = {};
                loadDiscord();
              }).catch(function () {});
          });
          actions.appendChild(save);
          actions.appendChild(btn('Cancel', 'quiet', function () { editRow.remove(); editRow = null; }));
          cell.appendChild(actions);
        }).catch(function (err) {
          cell.textContent = '';
          cell.appendChild(h('p', 'info error', 'Could not read the server: ' + (err && err.message ? err.message : 'no answer')));
        });
      }
    });
    var table = h('table'); var thead = h('thead');
    var heads = [h('th', null, 'Team'), h('th', 'num', 'Registered'), h('th', 'num', 'With the role')];
    live.forEach(function (g) { heads.push(h('th', null, g.name || g.guild_id)); });
    thead.appendChild(row(heads)); table.appendChild(thead); table.appendChild(tb);
    var wrap = h('div', 'table-scroll'); wrap.appendChild(table); box.appendChild(wrap);
  }
  // Each team's submit code, posted in its own channel with its role
  // mentioned. Every team with a channel, or the ones ticked; one
  // request per team, the way setup goes, so the line under the button
  // can say how far it has got.
  // while a send is going the box is left as it is, so its line keeps
  // counting and there is no second Send to start it again
  var codesRunning = false;
  function renderDiscordCodes() {
    if (codesRunning) return;
    var d = state.discord;
    var box = el('discord-codes');
    box.textContent = '';
    var live = d.guilds.filter(function (g) { return g.in_server && g.enabled; });
    function hasChannel(t) {
      return live.some(function (g) { return t.guilds[g.guild_id] && t.guilds[g.guild_id].channel_id; });
    }
    var teams = d.teams.filter(function (t) { return !t.hidden && hasChannel(t); });
    var without = d.teams.filter(function (t) { return !t.hidden && (t.registrations || t.people) && !hasChannel(t); }).length;
    box.classList.toggle('hidden', !live.length || !teams.length);
    if (!live.length || !teams.length) return;
    var head = h('div', 'card-head');
    head.appendChild(h('h2', 'card-title', 'Submit codes'));
    box.appendChild(head);
    box.appendChild(h('p', 'card-sub', 'Each team gets its code in its own channel, with its role mentioned.' +
      (without ? ' ' + without + (without === 1 ? ' team has' : ' teams have') + ' no channel yet and get nothing.' : '')));
    var every = h('input');
    every.type = 'checkbox';
    every.checked = true;
    var everyLabel = h('label', 'acc-check');
    everyLabel.appendChild(every);
    everyLabel.appendChild(h('span', null, 'Every team with a channel'));
    box.appendChild(everyLabel);
    var list = h('div', 'acc-picks hidden');
    var ticks = teams.map(function (t) {
      var lab = h('label');
      var tick = h('input');
      tick.type = 'checkbox';
      tick.value = t.id;
      tick.addEventListener('change', sync);
      lab.appendChild(tick);
      lab.appendChild(document.createTextNode(t.name));
      list.appendChild(lab);
      return tick;
    });
    box.appendChild(list);
    var actions = h('div', 'row-form');
    var report = h('p', 'muted dc-codes-report');
    box.appendChild(actions);
    box.appendChild(report);
    function chosen() {
      return every.checked ? teams : teams.filter(function (t, i) { return ticks[i].checked; });
    }
    var send = btn('', 'quiet fixed', function () {
      var picked = chosen();
      if (!picked.length) { toast('Tick at least one team.', true); return; }
      actions.textContent = '';
      actions.appendChild(btn('Send ' + picked.length + (picked.length === 1 ? ' code' : ' codes') + ' now', 'fixed', function () { run(picked); }));
      actions.appendChild(btn('Cancel', 'quiet fixed', function () { actions.textContent = ''; actions.appendChild(send); }));
    });
    function sync() {
      list.classList.toggle('hidden', every.checked);
      var n = chosen().length;
      send.textContent = 'Send to ' + n + (n === 1 ? ' team' : ' teams');
    }
    every.addEventListener('change', sync);
    sync();
    actions.appendChild(send);
    function run(picked) {
      actions.textContent = '';
      codesRunning = true;
      var at = 0, sent = 0, failed = [], stopped = '';
      // the second password, typed once for every team
      var hold = { value: '' };
      function next() {
        if (at >= picked.length) {
          codesRunning = false;
          report.textContent = 'Sent to ' + sent + (sent === 1 ? ' team' : ' teams') + '.' +
            (stopped ? ' Stopped at ' + stopped + '.' : '') +
            (failed.length ? ' Not sent: ' + failed.join('; ') + '.' : '');
          actions.appendChild(send);
          return;
        }
        var t = picked[at];
        report.textContent = 'Sending ' + (at + 1) + ' of ' + picked.length + '…';
        post('/api/console/discord/codes/send', { team_id: t.id }, hold).then(function (r) {
          // Cancel on the second password gives up on the rest
          if (r && r.cancelled) { stopped = t.name; at = picked.length; next(); return; }
          if (r && r.ok && r.sent) sent++;
          else failed.push(t.name + ': ' + ((r && (r.error || (r.failed || [])[0])) || 'no channel'));
          at++;
          next();
        }).catch(function () { failed.push(t.name + ': no answer'); at++; next(); });
      }
      next();
    }
  }
  function renderDiscordMembers() {
    var d = state.discord;
    var box = el('discord-members');
    box.textContent = '';
    var hiddenNames = hiddenTeamNames();
    var members = d.members.filter(function (m) { return !hiddenNames[String(m.team_name || '').toLowerCase()]; });
    box.classList.toggle('hidden', !members.length);
    if (!members.length) return;
    box.appendChild(h('h3', null, members.length + (members.length === 1 ? ' member' : ' members') + ' with a team role'));
    var tb = h('tbody');
    var names = {};
    d.guilds.forEach(function (g) { names[g.guild_id] = g.name || g.guild_id; });
    members.forEach(function (m) {
      tb.appendChild(row([h('td', null, m.username), h('td', null, m.person || '?'), h('td', null, m.team_name || '?'),
        h('td', null, names[m.guild_id] || m.guild_id), h('td', 'muted', fmtTime(m.verified_at))]));
    });
    var table = h('table'); var thead = h('thead');
    thead.appendChild(row([h('th', null, 'Discord'), h('th', null, 'Person'), h('th', null, 'Team'), h('th', null, 'Server'), h('th', null, 'Since')]));
    table.appendChild(thead); table.appendChild(tb);
    var wrap = h('div', 'table-scroll'); wrap.appendChild(table); box.appendChild(wrap);
  }
})(window.dash);
