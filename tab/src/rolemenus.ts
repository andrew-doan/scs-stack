// Role menus: a message the bot posts with a dropdown of roles, from
// which members give themselves roles — a name colour, a pronoun, a
// ping for announcements. Organisers make them on the dashboard's
// Discord tab (table discord_role_menus) and post them to a channel;
// a pick arrives as a component interaction (custom_id "rm:<id>").
//
// A member can only ever be given or lose the roles the menu offers:
// what Discord sends is checked against the menu's own list, so an
// edited request cannot ask for any other role. The bot can only give
// out roles below its own in the server's list, which is checked when
// a menu is saved or posted and said in plain words if not.

import { json, cleanText } from './shared.ts';
import { discordApi, guildConfig, botConfigured, botUser } from './discord.ts';
import type { ConsoleSession, Ctx, DiscordMember, DiscordResult, DiscordRole, DiscordRoleMenuRow, DiscordUser, Env, Interaction, JsonBody, LogAction } from './types.ts';

// A unicode emoji, or a server emoji by its id.
interface Emoji {
  name: string;
  id?: string;
  animated?: boolean;
}

// One role a menu offers, as stored in `options`.
interface MenuOption {
  role_id: string;
  label: string;
  description: string;
  emoji: string;
}

// A menu as the dashboard reads it and the bot posts it.
export interface RoleMenu {
  id: number;
  guild_id: string;
  title: string;
  body: string;
  pick: string;
  channel_id: string;
  message_id: string;
  options: MenuOption[];
  created_at: string;
  updated_at: string;
}

// One choice in the dropdown.
interface SelectOption {
  label: string;
  value: string;
  description?: string;
  emoji?: Emoji;
}

// The message the bot posts for a menu.
interface MenuPost {
  content: string;
  allowed_mentions: { parse: string[] };
  components: { type: number; components: { type: number; custom_id: string; placeholder: string; min_values: number; max_values: number; options: SelectOption[] }[] }[];
}

var PREFIX = 'rm:';
var MAX_OPTIONS = 24;   // Discord allows 25 in a dropdown; a pick-one menu keeps one for None
var NONE = 'none';

function reply(text: string): { type: number; data: { content: string; flags: number; allowed_mentions: { parse: string[] } } } {
  return { type: 4, data: { content: text, flags: 64, allowed_mentions: { parse: [] } } };
}

function followUp(env: Env, interaction: Interaction, text: string): Promise<DiscordResult<unknown>> {
  return discordApi(env, 'PATCH', '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original',
    { content: text, allowed_mentions: { parse: [] } });
}

function snowflake(value: unknown): string {
  var s = String(value == null ? '' : value).trim();
  return /^\d{5,30}$/.test(s) ? s : '';
}

// A unicode emoji as typed, or a server emoji in Discord's own form
// (<:name:id>, <a:name:id> when it moves).
function emojiOf(text: unknown): Emoji | null {
  var t = String(text || '').trim();
  if (!t) return null;
  var custom = t.match(/^<(a?):(\w{2,32}):(\d{5,30})>$/);
  if (custom) return { name: custom[2], id: custom[3], animated: !!custom[1] };
  if (t.length > 16 || /[\w<>:]/.test(t)) return null;
  return { name: t };
}

function cleanOptions(list: unknown): MenuOption[] {
  var out: MenuOption[] = [];
  var seen: Record<string, boolean> = {};
  (Array.isArray(list) ? list : []).forEach(function (item) {
    var o = (item || {}) as Record<string, unknown>;
    var role = snowflake(o.role_id);
    var label = cleanText(o.label, 100);
    if (!role || !label || seen[role] || out.length >= MAX_OPTIONS) return;
    seen[role] = true;
    var emoji = cleanText(o.emoji, 64);
    out.push({ role_id: role, label: label, description: cleanText(o.description, 100), emoji: emojiOf(emoji) ? emoji : '' });
  });
  return out;
}

function rowToMenu(row: DiscordRoleMenuRow | null): RoleMenu | null {
  if (!row) return null;
  var options: MenuOption[] = [];
  try { options = JSON.parse(row.options || '[]') as MenuOption[]; } catch (err) { options = []; }
  return {
    id: row.id, guild_id: row.guild_id, title: row.title, body: row.body, pick: row.pick === 'many' ? 'many' : 'one',
    channel_id: row.channel_id || '', message_id: row.message_id || '', options: options,
    created_at: row.created_at, updated_at: row.updated_at || ''
  };
}

function readMenu(db: D1Database, id: unknown): Promise<RoleMenu | null> {
  return db.prepare('SELECT * FROM discord_role_menus WHERE id = ?1').bind(Number(id) || 0).first<DiscordRoleMenuRow>().then(rowToMenu);
}

// What the bot posts: the title and the words, and one dropdown.
export function menuMessage(menu: RoleMenu): MenuPost {
  var options = menu.options.map(function (o) {
    var opt: SelectOption = { label: o.label, value: o.role_id };
    if (o.description) opt.description = o.description;
    var e = emojiOf(o.emoji);
    if (e) opt.emoji = e;
    return opt;
  });
  if (menu.pick === 'one') options.push({ label: 'None', value: NONE });
  return {
    content: '**' + menu.title + '**' + (menu.body ? '\n' + menu.body : ''),
    allowed_mentions: { parse: [] },
    components: [{ type: 1, components: [{
      type: 3,
      custom_id: PREFIX + menu.id,
      placeholder: menu.pick === 'one' ? 'Choose a role' : 'Choose your roles',
      min_values: menu.pick === 'one' ? 1 : 0,
      max_values: menu.pick === 'one' ? 1 : menu.options.length,
      options: options
    }] }]
  };
}

// ---------- a member picks ----------

export function isRoleMenu(interaction: Interaction | null | undefined): boolean {
  return !!(interaction && interaction.data && String(interaction.data.custom_id || '').indexOf(PREFIX) === 0);
}

export async function handleRoleMenu(interaction: Interaction, env: Env, ctx: Ctx): Promise<{ type: number; data: object }> {
  var user = interaction.member && interaction.member.user;
  if (!interaction.guild_id || !user) return reply('Role menus only work inside the server.');
  var data = interaction.data || {};
  var menu = await readMenu(env.DB, String(data.custom_id).slice(PREFIX.length));
  if (!menu || menu.guild_id !== interaction.guild_id) return reply('This menu has been taken down. Ask an organiser for the new one.');
  var guild = await guildConfig(env.DB, env, interaction.guild_id);
  if (!guild || !guild.enabled) return reply('Roles from menus are paused on this server.');
  if (!botConfigured(env)) return reply('Roles from menus are locked until DISCORD_BOT_TOKEN is set on the worker.');

  var offered = menu.options.map(function (o) { return o.role_id; });
  var picked = (data.values || []).filter(function (v) { return offered.indexOf(v) !== -1; });
  if (menu.pick === 'one') picked = picked.slice(0, 1);
  var held = (interaction.member && interaction.member.roles) || [];
  var add = picked.filter(function (r) { return held.indexOf(r) === -1; });
  var remove = offered.filter(function (r) { return picked.indexOf(r) === -1 && held.indexOf(r) !== -1; });
  if (!add.length && !remove.length) return reply(picked.length ? 'You already have that.' : 'You have none of these roles.');

  var labels: Record<string, string> = {};
  menu.options.forEach(function (o) { labels[o.role_id] = o.label; });
  var work = changeRoles(env, interaction.guild_id, user.id, add, remove, labels)
    .catch(function () { return 'Something went wrong while changing your roles. Try again in a minute.'; })
    .then(function (text) { return followUp(env, interaction, text); });
  if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
  return { type: 5, data: { flags: 64 } };
}

async function changeRoles(env: Env, guildId: string, userId: string, add: string[], remove: string[], labels: Record<string, string>): Promise<string> {
  var added: string[] = [], removed: string[] = [], failed: string[] = [];
  for (var i = 0; i < remove.length; i++) {
    var off = await discordApi(env, 'DELETE', '/guilds/' + guildId + '/members/' + userId + '/roles/' + remove[i]);
    (off.ok ? removed : failed).push(labels[remove[i]]);
  }
  for (var k = 0; k < add.length; k++) {
    var on = await discordApi(env, 'PUT', '/guilds/' + guildId + '/members/' + userId + '/roles/' + add[k]);
    (on.ok ? added : failed).push(labels[add[k]]);
  }
  var text = '';
  if (added.length && removed.length) text = 'Swapped ' + removed.join(', ') + ' for ' + added.join(', ') + '.';
  else if (added.length) text = 'Added ' + added.join(', ') + '.';
  else if (removed.length) text = 'Removed ' + removed.join(', ') + '.';
  if (failed.length) {
    text += (text ? ' ' : '') + 'The bot could not change ' + failed.join(', ') + '. An organiser needs to move the bot’s role above ' +
      (failed.length === 1 ? 'it' : 'them') + ' in the server settings.';
  }
  return text;
}

// ---------- the dashboard ----------

// Which of these roles sit at or above the bot's own highest role, and
// so cannot be given out by it.
async function rolesTooHigh(env: Env, guildId: string, roleIds: string[]): Promise<string[]> {
  if (!roleIds.length) return [];
  var me = await botUser(env);
  if (!me) return [];
  var both = await Promise.all([
    discordApi<DiscordMember>(env, 'GET', '/guilds/' + guildId + '/members/' + me.id),
    discordApi<DiscordRole[]>(env, 'GET', '/guilds/' + guildId + '/roles')
  ]);
  var member = both[0], roles = both[1];
  if (!member.ok || !roles.ok) return [];
  var pos: Record<string, number> = {};
  var names: Record<string, string> = {};
  (roles.data || []).forEach(function (r) { pos[r.id] = r.position; names[r.id] = r.name; });
  var top = 0;
  ((member.data && member.data.roles) || []).forEach(function (id) { if ((pos[id] || 0) > top) top = pos[id]; });
  return roleIds.filter(function (id) { return id in pos && pos[id] >= top; }).map(function (id) { return names[id]; });
}

function tooHighNote(names: string[]): string {
  if (!names.length) return '';
  return 'The bot cannot give out ' + names.join(', ') + ' until its own role is above ' +
    (names.length === 1 ? 'it' : 'them') + ' in Server Settings, Roles.';
}

async function listMenus(env: Env, url: URL): Promise<Response> {
  var guildId = snowflake(url.searchParams.get('guild_id'));
  if (!guildId) return json({ error: 'guild_id must be a server id' }, 400);
  var rows = (await env.DB.prepare('SELECT * FROM discord_role_menus WHERE guild_id = ?1 ORDER BY id').bind(guildId).all<DiscordRoleMenuRow>()).results;
  return json({ ok: true, menus: rows.map(rowToMenu) });
}

async function editPosted(env: Env, menu: RoleMenu): Promise<DiscordResult<unknown> | { ok: true; held?: undefined; why?: undefined }> {
  if (!menu.message_id || !menu.channel_id) return { ok: true };
  return discordApi(env, 'PATCH', '/channels/' + menu.channel_id + '/messages/' + menu.message_id, menuMessage(menu));
}

// Make a menu, or change one. One that is already posted is edited in
// place, so members keep using the same message.
async function saveMenu(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var guildId = snowflake(body.guild_id);
  if (!guildId || !(await guildConfig(env.DB, env, guildId))) return json({ error: 'Add the server on this tab first.' }, 400);
  var title = cleanText(body.title, 200);
  if (!title) return json({ error: 'Give the menu a title.' }, 400);
  var options = cleanOptions(body.options);
  if (!options.length) return json({ error: 'Add at least one role.' }, 400);
  var pick = body.pick === 'many' ? 'many' : 'one';
  var text = String(body.body == null ? '' : body.body).slice(0, 1500).trim();
  var id = Number(body.id) || 0;
  var menu: RoleMenu | null;
  if (id) {
    menu = await readMenu(env.DB, id);
    if (!menu || menu.guild_id !== guildId) return json({ error: 'No such menu.' }, 404);
    await env.DB.prepare(
      "UPDATE discord_role_menus SET title = ?2, body = ?3, pick = ?4, options = ?5, updated_at = datetime('now') WHERE id = ?1"
    ).bind(id, title, text, pick, JSON.stringify(options)).run();
  } else {
    var made = await env.DB.prepare(
      'INSERT INTO discord_role_menus (guild_id, title, body, pick, options) VALUES (?1, ?2, ?3, ?4, ?5)'
    ).bind(guildId, title, text, pick, JSON.stringify(options)).run();
    id = made.meta && made.meta.last_row_id;
  }
  // just written, so it is there
  menu = await readMenu(env.DB, id) as RoleMenu;
  var note = tooHighNote(await rolesTooHigh(env, guildId, menu.options.map(function (o) { return o.role_id; })));
  var edited = await editPosted(env, menu);
  if (!edited.ok) note = (note ? note + ' ' : '') + 'The posted message could not be updated: ' + edited.why;
  await logAction(env.DB, session.name, body.id ? 'discord-menu-edit' : 'discord-menu-add', title.slice(0, 60), '-', 0, 0, 0);
  return json({ ok: true, menu: menu, note: note });
}

// Post a menu, or move it: posting to the channel it is already in
// edits the message there; posting anywhere else takes the old one down.
async function postMenu(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var menu = await readMenu(env.DB, body.id);
  if (!menu) return json({ error: 'No such menu.' }, 404);
  var channel = snowflake(body.channel_id);
  if (!channel) return json({ error: 'Pick a channel.' }, 400);
  var gone = false;
  if (menu.message_id && menu.channel_id === channel) {
    var edited = await editPosted(env, menu);
    if (edited.held) return json({ error: edited.why, held: true }, 409);
    if (edited.ok) return json({ ok: true, menu: menu, note: tooHighNote(await rolesTooHigh(env, menu.guild_id, menu.options.map(function (o) { return o.role_id; }))) });
    // Posted again only when the message was deleted in Discord. Any
    // other failure (a rate limit, Discord down) leaves the message
    // there, and a second post would be a second live menu.
    if (edited.status !== 404) return json({ error: edited.why }, 502);
    gone = true;
  }
  var res = await discordApi<{ id: string }>(env, 'POST', '/channels/' + channel + '/messages', menuMessage(menu));
  if (!res.ok) return json({ error: res.why, held: !!res.held }, res.held ? 409 : 502);
  if (menu.message_id && !gone && (menu.channel_id !== channel || res.data.id !== menu.message_id)) {
    // Moved: the old one comes down, and if it will not, the new one
    // does instead, so there is never more than one menu to pick from.
    var down = await discordApi(env, 'DELETE', '/channels/' + menu.channel_id + '/messages/' + menu.message_id);
    if (!down.ok && down.status !== 404) {
      await discordApi(env, 'DELETE', '/channels/' + channel + '/messages/' + res.data.id);
      return json({ error: 'The menu where it is now could not be taken down, so it was not moved: ' + down.why }, 502);
    }
  }
  await env.DB.prepare(
    "UPDATE discord_role_menus SET channel_id = ?2, message_id = ?3, updated_at = datetime('now') WHERE id = ?1"
  ).bind(menu.id, channel, res.data.id).run();
  // just written, so it is there
  menu = await readMenu(env.DB, menu.id) as RoleMenu;
  await logAction(env.DB, session.name, 'discord-menu-post', menu.title.slice(0, 60), '-', 0, 0, 0);
  return json({ ok: true, menu: menu, note: tooHighNote(await rolesTooHigh(env, menu.guild_id, menu.options.map(function (o) { return o.role_id; }))) });
}

async function deleteMenu(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var menu = await readMenu(env.DB, body.id);
  if (!menu) return json({ error: 'No such menu.' }, 404);
  if (menu.message_id) {
    var gone = await discordApi(env, 'DELETE', '/channels/' + menu.channel_id + '/messages/' + menu.message_id);
    // already deleted in Discord is as good as deleted here
    if (!gone.ok && gone.status !== 404) return json({ error: gone.why }, 502);
  }
  await env.DB.prepare('DELETE FROM discord_role_menus WHERE id = ?1').bind(menu.id).run();
  await logAction(env.DB, session.name, 'discord-menu-delete', menu.title.slice(0, 60), '-', 0, 0, 0);
  return json({ ok: true });
}

// A role for a menu, made from the dashboard: a colour role usually.
// One already called that is used rather than made a second time.
async function createRole(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var guildId = snowflake(body.guild_id);
  if (!guildId) return json({ error: 'guild_id must be a server id' }, 400);
  var name = cleanText(body.name, 100);
  if (!name) return json({ error: 'Give the role a name.' }, 400);
  var colour = Math.round(Number(body.color));
  if (!isFinite(colour) || colour < 0 || colour > 0xffffff) colour = 0;
  var roles = await discordApi<DiscordRole[]>(env, 'GET', '/guilds/' + guildId + '/roles');
  if (!roles.ok) return json({ error: roles.why }, 502);
  var same = (roles.data || []).filter(function (r) { return r.name.toLowerCase() === name.toLowerCase() && !r.managed; })[0];
  if (same) return json({ ok: true, reused: true, role: { id: same.id, name: same.name, color: same.color || 0 } });
  var made = await discordApi<DiscordRole>(env, 'POST', '/guilds/' + guildId + '/roles',
    { name: name, color: colour, permissions: '0', mentionable: false, hoist: false });
  if (!made.ok) return json({ error: made.why }, 502);
  await logAction(env.DB, session.name, 'discord-role-add', name, '-', 0, 0, 0);
  return json({ ok: true, reused: false, role: { id: made.data.id, name: made.data.name, color: made.data.color || colour } });
}

export async function handleRoleMenuConsole(request: Request, env: Env, session: ConsoleSession, action: string, body: JsonBody, url: URL, logAction: LogAction): Promise<Response | null> {
  if (request.method === 'GET') {
    if (action === 'discord/menus') return listMenus(env, url);
    return null;
  }
  if (action === 'discord/menus/save') return saveMenu(env, session, body, logAction);
  if (action === 'discord/menus/post') return postMenu(env, session, body, logAction);
  if (action === 'discord/menus/delete') return deleteMenu(env, session, body, logAction);
  if (action === 'discord/roles/create') return createRole(env, session, body, logAction);
  return null;
}
