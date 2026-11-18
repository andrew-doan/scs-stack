// Discord beyond answering commands: the bot's REST side. Which
// servers it works in (the dashboard's Discord tab, table
// discord_guilds), the organiser guard for score changes, /verify
// (a member's signup → their team role and private channel), and the
// dashboard's controls: post a message, register the commands, set up
// every team's role and channel at once.
//
// Everything here needs the bot token (`wrangler secret put
// DISCORD_BOT_TOKEN`) and a `bot`-scope invite with Manage Roles,
// Manage Channels and Send Messages. Without the token every feature
// refuses in plain words; the commands that only answer keep working.

import { json, cleanText, configured, delay, fileNameFor, mintCode, fields, prop } from './shared.ts';
import { COMMANDS } from './commands.ts';
import { standings, leaderboardText, fmtPts } from './tab.ts';
import { handleRoleMenuConsole } from './rolemenus.ts';
import { fileKindOf } from './rules.ts';
import type { ConsoleSession, Ctx, DiscordChannel, DiscordGuildRow, DiscordMember, DiscordMessage, DiscordOverwrite, DiscordResult, DiscordRole,
  DiscordTeamRow, DiscordUser, Env, Interaction, JsonBody, LogAction, ParticipantRow, RegistrationRow, SubmissionFileRow, TeamRow } from './types.ts';

// A team as the bot sets it up.
export type TeamRef = Pick<TeamRow, 'id' | 'name'>;

// A role the bot found or made: its id and its name.
type RoleRef = { id: string; name: string };

// A server's roles and channels, fetched once for a batch of teams and
// kept up to date as things are made, with the channel permissions the
// bot can give and Legend and Unknown Team once found.
export interface Known {
  roles?: DiscordRole[];
  channels?: DiscordChannel[];
  allow?: string;
  fixed?: Record<string, RoleRef>;
}

// What ensureTeamSetup made or found for a team.
export interface TeamSetup {
  role_id: string;
  channel_id: string;
  role_name: string;
  channel_name: string;
  made: { role: boolean; category: boolean; channel: boolean };
}
type SetupRefusal = { error: string; hidden?: boolean };

// A signup that names a Discord user (findSignups), and whether it is a
// test: on a hidden team, or a hidden signup with no team.
type Signup = Pick<ParticipantRow, 'id' | 'name' | 'discord' | 'team_id' | 'registration_id'> & Pick<RegistrationRow, 'team_name'> &
  { team_hidden: number; reg_hidden: number };

// A hidden team is a test, and so is a hidden signup with no team: the
// member sweep, /verify and Give roles all read signups this way.
function testSignup(p: { team_id: number | null; team_hidden: number; reg_hidden: number }): boolean {
  return !!(p.team_hidden || (!p.team_id && p.reg_hidden));
}

// Signups with a Discord username, with the two flags testSignup reads.
async function discordSignups<T>(db: D1Database, cols: string): Promise<T[]> {
  return (await db.prepare(
    'SELECT ' + cols + ', COALESCE(t.hidden, 0) AS team_hidden, COALESCE(r.hidden, 0) AS reg_hidden FROM participants p ' +
    'LEFT JOIN registrations r ON r.id = p.registration_id LEFT JOIN teams t ON t.id = p.team_id ' +
    "WHERE p.discord IS NOT NULL AND p.discord != ''"
  ).all<T>()).results;
}

// A proof file linked from a post.
export interface ProofFile {
  key: string;
  name: string | null;
  type: string;
}

// A decision the team's channel is told of (tellTeam in points.ts).
// `gained` is what it was worth, `part` says it was a part mark (`of` the
// full points, null on a mystery quest), `total` the team's points after
// it, or null while the tab is frozen or closed.
export interface Verdict {
  verdict: string;
  team_id: number;
  team: string;
  title: string;
  codes: string;
  files?: ProofFile[];
  reason?: string;
  gained?: number;
  counted?: boolean;
  part?: { of: number | null } | null;
  total?: number | null;
}

// Roles and channels the bot made that no team uses, and the hidden or
// deleted teams whose rows are forgotten once they are gone.
interface Leftovers {
  roles: { id: string; name: string; hidden: boolean }[];
  channels: { id: string; name: string; hidden: boolean }[];
  forget: { team_id: number; team: string }[];
}


var API = 'https://discord.com/api/v10';
var VIEW_CHANNEL = 1024;
var SEND_MESSAGES = 2048;
var READ_HISTORY = 65536;
// What the team, the organiser role and the server's staff roles can do
// in a team channel: what anybody does in an ordinary channel. Bits past
// 31 are why it is a BigInt.
export var CHANNEL_ALLOW = String(
  (1n << 10n) | // view the channel
  (1n << 11n) | // send messages
  (1n << 16n) | // read the history
  (1n << 6n) |  // add reactions
  (1n << 14n) | // embed links
  (1n << 15n) | // attach files
  (1n << 18n) | // emoji from other servers
  (1n << 37n) | // stickers from other servers
  (1n << 38n) | // send messages in threads
  (1n << 31n) | // use apps and slash commands
  (1n << 46n)   // send voice messages
);
// what team channels were opened with before, so an overwrite the bot
// put there can be told from one somebody made by hand
var OLD_ALLOW = String(VIEW_CHANNEL | SEND_MESSAGES | READ_HISTORY);
var TEXT_CHANNEL = 0;
var ANNOUNCEMENT_CHANNEL = 5;
var CATEGORY_CHANNEL = 4;
var ROLE_OVERWRITE = 0;
var MEMBER_OVERWRITE = 1;
// A role carrying any of these is staff, whatever it is called:
// administrator, manage server, roles, channels, messages, webhooks,
// kick, ban, time out and mention everyone.
var STAFF_PERMS = (1n << 3n) | (1n << 5n) | (1n << 28n) | (1n << 4n) | (1n << 13n) |
  (1n << 29n) | (1n << 1n) | (1n << 2n) | (1n << 40n) | (1n << 17n);
var DEFAULT_CATEGORY = 'Private Channels';
var SITE_URL = 'https://scs.andyrew.space';

export function botConfigured(env: Env): boolean {
  return configured(env.DISCORD_BOT_TOKEN || '');
}

function explain(status: number, data: unknown): string {
  var msg = prop(data, 'message') ? String(prop(data, 'message')) : '';
  if (status === 401) return 'Discord rejected the bot token.';
  if (status === 403) return 'The bot is not allowed to do that' + (msg ? ' (' + msg + ')' : '') + '. Check its permissions and that its role sits above the team roles.';
  if (status === 404) return 'Discord could not find that' + (msg ? ' (' + msg + ')' : '') + '.';
  return 'Discord answered ' + status + (msg ? ': ' + msg : '') + '.';
}

// Rate limits. Every answer says how many calls are left in its bucket
// and when the bucket refills; with none left, the next call waits for
// the refill instead of being refused. A 429 says how long to wait and
// is waited out, three times at most. No single wait is longer than
// WAIT_MAX_MS. A 429 means Discord did nothing, so a POST is safe to send
// again.
var TRIES = 4;
var WAIT_MAX_MS = 30000;
var RATE_LIMITED = 'Discord is rate limiting the bot. Wait a minute and run it again: it carries on from where it stopped.';

function seconds(value: unknown): number {
  var n = Number(value);
  return isFinite(n) && n > 0 ? n : 0;
}

// ---------- holding posts, server by server ----------
// The Discord tab's tick box for each server (`discord_guilds.held`):
// while a server's is ticked, nothing the bot would post or edit in a
// channel on it reaches Discord. Each message goes in the log instead
// (`discord-held`: where it was going in the team column, what it says
// in the quest column), which the Log tab shows. Every post and edit
// goes through discordApi or postToChannel in index.ts, so these are the
// gates. A slash command's reply is not a post: it still answers, shown
// only to whoever ran it (index.ts).
export var HELD_WHY = 'Posting to Discord is held for this server on the Discord tab. What it would have sent is in the Log.';
var MESSAGE_WRITE = /^\/channels\/(\d+)\/messages(\/\d+)?$/;

// whether posts to one server are held
export async function postsHeld(db: D1Database, guildId: string | null | undefined): Promise<boolean> {
  if (!guildId) return false;
  try {
    var row = await db.prepare('SELECT held FROM discord_guilds WHERE guild_id = ?1').bind(String(guildId)).first<{ held: number }>();
    return !!(row && row.held);
  } catch (err) {
    return false;
  }
}

async function anyHeld(db: D1Database): Promise<boolean> {
  try {
    return !!(await db.prepare('SELECT 1 AS x FROM discord_guilds WHERE held = 1 LIMIT 1').first());
  } catch (err) {
    return false;
  }
}

// The server a channel is on: from what the tab already keeps (a team's
// channel, an announcements channel, a role menu's), else the server the
// caller names, else what Discord says.
async function guildOfChannel(env: Env, channelId: string, named?: string): Promise<string> {
  var db = env.DB;
  var row = await db.prepare(
    'SELECT guild_id FROM discord_teams WHERE channel_id = ?1 UNION ALL ' +
    'SELECT guild_id FROM discord_guilds WHERE announce_channel_id = ?1 UNION ALL ' +
    'SELECT guild_id FROM discord_role_menus WHERE channel_id = ?1 LIMIT 1'
  ).bind(channelId).first<{ guild_id: string }>();
  if (row) return row.guild_id;
  if (named) return named;
  try {
    var resp = await fetch(API + '/channels/' + channelId, { headers: { 'authorization': 'Bot ' + env.DISCORD_BOT_TOKEN } });
    var data = resp.ok ? await resp.json() as { guild_id?: string } : null;
    return data && data.guild_id ? String(data.guild_id) : '';
  } catch (err) {
    return '';
  }
}

// a held message's words, then its buttons and its menu's options
function heldText(method: string, body: unknown): string {
  var b = fields(body);
  var text = String(b.content || '');
  ((b.components || []) as { components?: { type: number; label?: string; url?: string; options?: { label: string }[] }[] }[]).forEach(function (rowOf) {
    (rowOf.components || []).forEach(function (c) {
      if (c.type === 2 && c.label) text += '\n[' + c.label + (c.url ? ': ' + c.url : '') + ']';
      if (c.type === 3) text += '\n[' + (c.options || []).map(function (o) { return o.label; }).join(', ') + ']';
    });
  });
  if (!text) text = JSON.stringify(b).slice(0, 2000);
  return (method === 'PATCH' ? 'Edit: ' : '') + text;
}

// where it was going: the team whose channel it is, an announcements
// channel, or the channel's id
async function heldWhere(db: D1Database, channelId: string): Promise<string> {
  try {
    var team = await db.prepare('SELECT t.name FROM discord_teams d JOIN teams t ON t.id = d.team_id WHERE d.channel_id = ?1')
      .bind(channelId).first<Pick<TeamRow, 'name'>>();
    if (team) return team.name;
    if (await db.prepare('SELECT 1 AS x FROM discord_guilds WHERE announce_channel_id = ?1').bind(channelId).first()) return 'Announcements';
  } catch (err) { /* the id says it as well */ }
  return 'Channel ' + channelId;
}

// null to send it, or the answer a held post gets once it is in the log.
// With no server held this costs one read; a channel on no server the
// tab or Discord can name is held while any server is, since it cannot
// be shown to be one of the others.
export async function holdPost(env: Env, method: string, path: string, body: unknown, guildId?: string): Promise<DiscordResult<never> | null> {
  var m = MESSAGE_WRITE.exec(path);
  if (!m || (method !== 'POST' && method !== 'PATCH') || !(await anyHeld(env.DB))) return null;
  var guild = await guildOfChannel(env, m[1], guildId);
  if (guild && !(await postsHeld(env.DB, guild))) return null;
  try {
    await env.DB.prepare(
      'INSERT INTO submission_log (action, team_name, quest_code, points_delta, old_total, new_total, actor) ' +
      "VALUES ('discord-held', ?1, ?2, 0, 0, 0, 'discord')"
    ).bind(await heldWhere(env.DB, m[1]), heldText(method, body)).run();
  } catch (err) { /* held whether or not the log took it */ }
  return { ok: false, status: 0, data: null, held: true, why: HELD_WHY };
}

// One server's tick box, on the Discord tab.
async function setHold(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var on = body.held === true || body.held === 1 || body.held === '1';
  var guild = await guildConfig(env.DB, env, cleanText(body.guild_id, 30));
  if (!guild) return json({ error: 'Pick a server that is set up in the dashboard.' }, 400);
  await env.DB.prepare('UPDATE discord_guilds SET held = ?2 WHERE guild_id = ?1').bind(guild.guild_id, on ? 1 : 0).run();
  await logAction(env.DB, session.name, on ? 'discord-hold' : 'discord-release', guild.name || guild.guild_id,
    on ? 'posts held' : 'posts go out', 0, 0, 0);
  return json({ ok: true, guild_id: guild.guild_id, held: on });
}

// One REST call with the bot token. Resolves {ok, status, data, why}, and
// `held` for a post the switch above kept back; `guildId`, where the
// caller knows the server, saves asking Discord for a channel the tab
// keeps no record of.
export async function discordApi<T = unknown>(env: Env, method: string, path: string, body?: unknown, guildId?: string): Promise<DiscordResult<T>> {
  if (!botConfigured(env)) {
    return { ok: false, status: 0, data: null, why: 'DISCORD_BOT_TOKEN is not set on the worker (see the README).' };
  }
  var held = await holdPost(env, method, path, body, guildId);
  if (held) return held;
  for (var attempt = 0; attempt < TRIES; attempt++) {
    var resp;
    try {
      resp = await fetch(API + path, {
        method: method,
        headers: { 'authorization': 'Bot ' + env.DISCORD_BOT_TOKEN, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (err) {
      return { ok: false, status: 0, data: null, why: 'Could not reach Discord.' };
    }
    var data: unknown = null;
    try { data = await resp.json(); } catch (err) { /* 204: no body */ }
    if (resp.status === 429) {
      if (attempt === TRIES - 1) break;
      var after = seconds(prop(data, 'retry_after')) || seconds(resp.headers.get('retry-after')) || 1;
      await delay(Math.min(WAIT_MAX_MS, after * 1000));
      continue;
    }
    if (resp.headers.get('x-ratelimit-remaining') === '0') {
      var refill = seconds(resp.headers.get('x-ratelimit-reset-after'));
      if (refill) await delay(Math.min(WAIT_MAX_MS, refill * 1000));
    }
    // the body is what Discord sends for this path, which the caller names
    return { ok: resp.ok, status: resp.status, data: data, why: resp.ok ? '' : explain(resp.status, data) } as DiscordResult<T>;
  }
  return { ok: false, status: 429, data: null, why: RATE_LIMITED };
}

// the bot's own user (its id is what channel overwrites need); one
// lookup per isolate
var botUserCache: { token: string | undefined; user: DiscordUser } | null = null;
async function botUser(env: Env): Promise<DiscordUser | null> {
  if (botUserCache && botUserCache.token === env.DISCORD_BOT_TOKEN) return botUserCache.user;
  var res = await discordApi<DiscordUser>(env, 'GET', '/users/@me');
  if (!res.ok) return null;
  botUserCache = { token: env.DISCORD_BOT_TOKEN, user: res.data };
  return res.data;
}

async function applicationId(env: Env): Promise<string | null> {
  var res = await discordApi<{ id: string }>(env, 'GET', '/oauth2/applications/@me');
  return res.ok && res.data ? res.data.id : null;
}

// ---------- which servers ----------

// The servers the bot works in. An empty table is seeded from the
// GUILD_ID / ORGANISER_ROLE_ID secrets, so a bot set up before the
// dashboard had a Discord tab keeps working — once: `discord_seeded` in
// site_flags is set by the seeding and by adding or removing a server
// on the dashboard, so a table emptied there stays empty.
var SEEDED = "INSERT INTO site_flags (name, value) VALUES ('discord_seeded', 1) ON CONFLICT(name) DO UPDATE SET value = 1";

export async function guildRows(db: D1Database, env: Env): Promise<DiscordGuildRow[]> {
  var rows = (await db.prepare('SELECT * FROM discord_guilds ORDER BY added_at, guild_id').all<DiscordGuildRow>()).results;
  if (!rows.length && configured(env.GUILD_ID || '')) {
    var seeded = await db.prepare("SELECT value FROM site_flags WHERE name = 'discord_seeded'").first<{ value: number }>();
    if (seeded && seeded.value) return rows;
    await db.batch([
      db.prepare('INSERT OR IGNORE INTO discord_guilds (guild_id, organiser_role_id) VALUES (?1, ?2)')
        .bind(String(env.GUILD_ID), configured(env.ORGANISER_ROLE_ID || '') ? String(env.ORGANISER_ROLE_ID) : ''),
      db.prepare(SEEDED)
    ]);
    rows = (await db.prepare('SELECT * FROM discord_guilds ORDER BY added_at, guild_id').all<DiscordGuildRow>()).results;
  }
  return rows;
}

export async function guildConfig(db: D1Database, env: Env, guildId: string | null | undefined): Promise<DiscordGuildRow | null> {
  if (!guildId) return null;
  var rows = await guildRows(db, env);
  return rows.filter(function (r) { return r.guild_id === String(guildId); })[0] || null;
}

// Score changes, /post and channel: are organiser-only, and only from
// a server set up in the dashboard. Checked against the signed
// payload Discord sends, so neither server settings nor inviting the
// bot elsewhere can get around it.
export async function writeGuard(interaction: Pick<Interaction, 'guild_id' | 'member'>, env: Env): Promise<string | null> {
  var guild = await guildConfig(env.DB, env, interaction.guild_id);
  if (!guild || !guild.enabled) return 'Score changes only work from a server set up in the dashboard.';
  if (!guild.organiser_role_id) return 'Score changes are locked until an organiser role is chosen for this server in the dashboard.';
  var roles = (interaction.member && interaction.member.roles) || [];
  if (roles.indexOf(guild.organiser_role_id) === -1) {
    return 'Only organisers can change the tab — ask one to run this for you.';
  }
  return null;
}

// ---------- names Discord will take ----------

// A role can be called almost anything: the team name as typed, tidied
// (no control characters, one space between words, no leading @, at
// most 100 characters).
export function roleNameFor(teamName: unknown): string {
  var name = String(teamName == null ? '' : teamName)
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^@+/, '');
  return (name || 'Team').slice(0, 100);
}

// A text channel is lowercase letters, numbers and hyphens (Discord
// drops everything else): "Loco Motive!" becomes loco-motive.
export function channelNameFor(teamName: unknown): string {
  var name = String(teamName == null ? '' : teamName)
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^\p{L}\p{N}-]/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (name || 'team').slice(0, 100);
}

// ---------- a team's role and private channel ----------

// The roles that see every team channel: the organiser role and
// whatever the server's card lists (staff_role_ids, comma separated,
// since every server's roles are its own).
function staffRoles(guild: Pick<DiscordGuildRow, 'guild_id' | 'organiser_role_id' | 'staff_role_ids'>, teamRoleId: string): string[] {
  var ids = String(guild.staff_role_ids || '').split(',').map(function (id) { return id.trim(); })
    .filter(function (id) { return /^\d{5,30}$/.test(id); });
  if (guild.organiser_role_id && ids.indexOf(guild.organiser_role_id) === -1) ids.unshift(guild.organiser_role_id);
  return ids.filter(function (id, i) { return id !== guild.guild_id && id !== teamRoleId && ids.indexOf(id) === i; });
}

function teamOverwrites(guild: DiscordGuildRow, roleId: string, me: DiscordUser | null, allow: string): DiscordOverwrite[] {
  var list: DiscordOverwrite[] = [
    { id: guild.guild_id, type: ROLE_OVERWRITE, allow: '0', deny: String(VIEW_CHANNEL) }, // @everyone
    { id: roleId, type: ROLE_OVERWRITE, allow: allow, deny: '0' }
  ];
  staffRoles(guild, roleId).forEach(function (id) { list.push({ id: id, type: ROLE_OVERWRITE, allow: allow, deny: '0' }); });
  if (me) list.push({ id: me.id, type: MEMBER_OVERWRITE, allow: allow, deny: '0' });
  return list;
}

// Discord refuses an overwrite that grants something the bot does not
// hold itself, so the channel permissions are what the bot can give:
// CHANNEL_ALLOW less anything its roles lack, the three it always gave
// kept. Asked once a batch.
async function channelAllow(env: Env, guild: DiscordGuildRow, known: Known): Promise<string> {
  if (known.allow) return known.allow;
  var me = await botUser(env);
  var mem = me ? await discordApi<DiscordMember>(env, 'GET', '/guilds/' + guild.guild_id + '/members/' + me.id) : null;
  if (!mem || !mem.ok || !mem.data) return (known.allow = CHANNEL_ALLOW);
  var mine = mem.data.roles || [];
  var held = 0n;
  (known.roles || []).forEach(function (r) {
    if (r.id !== guild.guild_id && mine.indexOf(r.id) === -1) return;
    try { held |= BigInt(r.permissions || '0'); } catch (err) { /* unreadable: counts for nothing */ }
  });
  if (held & (1n << 3n)) return (known.allow = CHANNEL_ALLOW); // administrator
  return (known.allow = String(BigInt(CHANNEL_ALLOW) & (held | BigInt(OLD_ALLOW))));
}

// A role /verify may hand to whoever it matches. Never @everyone, the
// organiser role, a bot's own role, another team's role or anything
// carrying a staff permission — even when it is the id stored for this
// team, since a mapping made before this check could be any of those.
function teamRoleOk(role: DiscordRole | null | undefined, guild: Pick<DiscordGuildRow, 'guild_id' | 'organiser_role_id'>, taken: Record<string, unknown>): role is DiscordRole {
  if (!role || role.id === guild.guild_id || role.id === guild.organiser_role_id) return false;
  if (role.managed || taken[role.id]) return false;
  try { return (BigInt(role.permissions || '0') & STAFF_PERMS) === 0n; } catch (err) { return false; }
}

// Finds or creates the team's role, the category, and the team's
// channel under it (visible to the team role, the organiser role and
// the bot; hidden from everyone else), and remembers the ids.
// A role or channel is only ever one this team's own row names: a team
// name picks nothing. Adopting by name let a team called after the
// organiser role be given it, and two teams whose names tidy to the
// same channel name share one channel.
// Each id is written down as soon as Discord hands it back, so a run
// cut off part way (a rate limit, a closed tab) picks up the role it
// already made instead of making another.
// `known` is the server's roles and channels, fetched once for a batch
// of teams and kept up to date as things are made; without it they are
// fetched here.
// Resolves {role_id, channel_id, role_name, channel_name, made} or
// {error}.
export async function ensureTeamSetup(env: Env, guild: DiscordGuildRow, team: TeamRef, known?: Known): Promise<TeamSetup | SetupRefusal> {
  // a hidden team is a test: the bot makes nothing for it
  var row = await env.DB.prepare('SELECT hidden FROM teams WHERE id = ?1').bind(team.id).first<Pick<TeamRow, 'hidden'>>();
  if (!row) return { error: 'Team ' + team.name + ' is no longer on the tab.' };
  if (row.hidden) return { error: team.name + ' is hidden on the Teams tab, so the bot leaves it alone.', hidden: true };
  var lock = await lockTeam(env.DB, guild.guild_id, team.id);
  if (!lock) return { error: 'Team ' + team.name + ' is already being set up. Try again in a minute.' };
  try {
    return await setUpTeam(env, guild, team, known || {});
  } finally {
    await unlockTeam(env.DB, lock);
  }
}

// One setup per team at a time: two members of a new team running
// /verify together, or two organisers pressing Set up, would each find
// no role and make one. The lock is a row in site_flags holding when it
// expires, so a worker that dies holding one does not hold it for good.
var LOCK_SECONDS = 180;
type TeamLock = { name: string; until: number };
async function lockTeam(db: D1Database, guildId: string, teamId: number): Promise<TeamLock | null> {
  var name = 'discord-setup:' + guildId + ':' + teamId;
  for (var i = 0; i < 20; i++) {
    var now = Math.floor(Date.now() / 1000);
    var res = await db.prepare(
      'INSERT INTO site_flags (name, value) VALUES (?1, ?2) ' +
      'ON CONFLICT(name) DO UPDATE SET value = ?2 WHERE site_flags.value < ?3'
    ).bind(name, now + LOCK_SECONDS, now).run();
    if (res.meta && res.meta.changes) return { name: name, until: now + LOCK_SECONDS };
    await delay(1000);
  }
  return null;
}

// Only the lock this run took: a run that outlasted it (three waits on
// a rate limit can) finds the next holder's expiry there and leaves it.
function unlockTeam(db: D1Database, lock: TeamLock): Promise<D1Result> {
  return db.prepare('DELETE FROM site_flags WHERE name = ?1 AND value = ?2').bind(lock.name, lock.until).run();
}

function rememberTeam(db: D1Database, guildId: string, teamId: number, role: Pick<DiscordRole, 'id' | 'name'>, channelId: string | null | undefined, channelName: string | null | undefined): Promise<D1Result> {
  return db.prepare(
    'INSERT INTO discord_teams (guild_id, team_id, role_id, channel_id, role_name, channel_name, updated_at) ' +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now')) " +
    "ON CONFLICT(guild_id, team_id) DO UPDATE SET role_id = ?3, channel_id = ?4, role_name = ?5, channel_name = ?6, updated_at = datetime('now')"
  ).bind(guildId, teamId, role.id, channelId || null, role.name, channelName || '').run();
}

async function setUpTeam(env: Env, guild: DiscordGuildRow, team: TeamRef, known: Known): Promise<TeamSetup | SetupRefusal> {
  var db = env.DB;
  var stored = await db.prepare('SELECT role_id, channel_id, channel_name FROM discord_teams WHERE guild_id = ?1 AND team_id = ?2')
    .bind(guild.guild_id, team.id).first<Pick<DiscordTeamRow, 'role_id' | 'channel_id' | 'channel_name'>>();
  var taken: Record<string, boolean> = {};
  (await db.prepare('SELECT role_id, channel_id FROM discord_teams WHERE guild_id = ?1 AND team_id != ?2')
    .bind(guild.guild_id, team.id).all<Pick<DiscordTeamRow, 'role_id' | 'channel_id'>>()).results.forEach(function (r) {
    if (r.role_id) taken[r.role_id] = true;
    if (r.channel_id) taken[r.channel_id] = true;
  });
  var made = { role: false, category: false, channel: false };

  // ---- role ----
  if (!known.roles) {
    var rolesRes = await discordApi<DiscordRole[]>(env, 'GET', '/guilds/' + guild.guild_id + '/roles');
    if (!rolesRes.ok) return { error: 'Could not list the server\'s roles: ' + rolesRes.why };
    known.roles = rolesRes.data || [];
  }
  var roles = known.roles;
  var roleName = roleNameFor(team.name);
  var storedRole = stored && stored.role_id;
  var role: DiscordRole | null = storedRole ? roles.filter(function (r) { return r.id === storedRole; })[0] : null;
  if (!teamRoleOk(role, guild, taken)) role = null;
  if (!role) {
    // no permissions of its own: the channel's overwrites are what open
    // it, and a new role otherwise copies whatever @everyone has
    var newRole = await discordApi<DiscordRole>(env, 'POST', '/guilds/' + guild.guild_id + '/roles', { name: roleName, permissions: '0', mentionable: true });
    if (!newRole.ok) return { error: 'Could not create the role ' + roleName + ': ' + newRole.why };
    role = newRole.data;
    roles.push(role);
    made.role = true;
    await rememberTeam(db, guild.guild_id, team.id, role, stored && stored.channel_id, stored && stored.channel_name);
  }

  // ---- category ----
  if (!known.channels) {
    var chRes = await discordApi<DiscordChannel[]>(env, 'GET', '/guilds/' + guild.guild_id + '/channels');
    if (!chRes.ok) return { error: 'Could not list the server\'s channels: ' + chRes.why };
    known.channels = chRes.data || [];
  }
  var channels = known.channels;
  var catName = guild.category_name || DEFAULT_CATEGORY;
  var category: DiscordChannel | null = guild.category_id
    ? channels.filter(function (c) { return c.id === guild.category_id && c.type === CATEGORY_CHANNEL; })[0]
    : null;
  if (!category) {
    category = channels.filter(function (c) {
      return c.type === CATEGORY_CHANNEL && c.name.toLowerCase() === catName.toLowerCase();
    })[0] || null;
  }
  if (!category) {
    var newCat = await discordApi<DiscordChannel>(env, 'POST', '/guilds/' + guild.guild_id + '/channels', {
      name: catName, type: CATEGORY_CHANNEL,
      permission_overwrites: [{ id: guild.guild_id, type: ROLE_OVERWRITE, allow: '0', deny: String(VIEW_CHANNEL) }]
    });
    if (!newCat.ok) return { error: 'Could not create the category ' + catName + ': ' + newCat.why };
    category = newCat.data;
    channels.push(category);
    made.category = true;
  }
  if (category.id !== guild.category_id) {
    await db.prepare('UPDATE discord_guilds SET category_id = ?2 WHERE guild_id = ?1').bind(guild.guild_id, category.id).run();
    guild.category_id = category.id;
  }

  // ---- channel ----
  var me = await botUser(env);
  var allow = await channelAllow(env, guild, known);
  var overwrites = teamOverwrites(guild, role.id, me, allow);
  var chanName = channelNameFor(team.name);
  var storedChannel = stored && stored.channel_id;
  var parent = category;
  var channel: DiscordChannel | null = storedChannel ? channels.filter(function (c) {
    return c.id === storedChannel && c.type === TEXT_CHANNEL && !taken[c.id];
  })[0] : null;
  if (!channel) {
    // Discord takes two channels of one name, but a team reading the
    // list could not tell which is theirs
    var clash = channels.some(function (c) { return c.parent_id === parent.id && c.name === chanName; });
    if (clash) chanName = chanName.slice(0, 90) + '-' + team.id;
    var newChan = await discordApi<DiscordChannel>(env, 'POST', '/guilds/' + guild.guild_id + '/channels', {
      name: chanName, type: TEXT_CHANNEL, parent_id: category.id,
      topic: 'Private channel for team ' + team.name, permission_overwrites: overwrites
    });
    if (!newChan.ok) return { error: 'Could not create the channel #' + chanName + ': ' + newChan.why };
    channel = newChan.data;
    channels.push(channel);
    made.channel = true;
  } else {
    // an existing channel gets any overwrite it lacks (a recreated
    // role, an organiser role chosen later)
    var have = (channel.permission_overwrites || []).map(function (o) { return o.id; });
    // a stored role refused above keeps no way into the channel
    var refused = stored && stored.role_id && stored.role_id !== role.id && stored.role_id !== guild.organiser_role_id ? stored.role_id : '';
    if (refused && have.indexOf(refused) !== -1) {
      var drop = await discordApi(env, 'DELETE', '/channels/' + channel.id + '/permissions/' + refused);
      if (!drop.ok) return { error: 'Could not take an old role off #' + channel.name + ': ' + drop.why };
    }
    // what it has is brought up to what it should have; @everyone is
    // left as it is once it is there, since only its view is the bot's
    var current: Record<string, DiscordOverwrite> = {};
    (channel.permission_overwrites || []).forEach(function (o) { current[o.id] = o; });
    for (var i = 1; i < overwrites.length; i++) {
      var ow = overwrites[i];
      var now = current[ow.id];
      if (now && String(now.allow) === ow.allow && String(now.deny || '0') === ow.deny) continue;
      var put = await discordApi(env, 'PUT', '/channels/' + channel.id + '/permissions/' + ow.id, { type: ow.type, allow: ow.allow, deny: ow.deny });
      if (!put.ok) return { error: 'Could not open #' + channel.name + ' to the team: ' + put.why };
      if (now) { now.allow = ow.allow; now.deny = ow.deny; }
    }
    // A role taken off the server's list loses what the bot gave it. Only
    // an overwrite the bot could have written goes: a role, nothing
    // denied, and exactly one of the sets the bot hands out. One made
    // by hand is left alone.
    var wanted: Record<string, boolean> = {};
    overwrites.forEach(function (o) { wanted[o.id] = true; });
    var mine = [allow, CHANNEL_ALLOW, OLD_ALLOW];
    var stale = (channel.permission_overwrites || []).filter(function (o) {
      return Number(o.type) === ROLE_OVERWRITE && !wanted[o.id] && o.id !== guild.guild_id && o.id !== refused &&
        String(o.deny || '0') === '0' && mine.indexOf(String(o.allow)) !== -1;
    });
    for (var k = 0; k < stale.length; k++) {
      var off = await discordApi(env, 'DELETE', '/channels/' + channel.id + '/permissions/' + stale[k].id);
      if (!off.ok && off.status !== 404) return { error: 'Could not close #' + channel.name + ' to a role taken off the list: ' + off.why };
    }
    if (stale.length) {
      channel.permission_overwrites = (channel.permission_overwrites || []).filter(function (o) { return stale.indexOf(o) === -1; });
    }
  }

  await rememberTeam(db, guild.guild_id, team.id, role, channel.id, channel.name);
  return { role_id: role.id, channel_id: channel.id, role_name: role.name, channel_name: channel.name, made: made };
}

// ---------- Legend and Unknown Team ----------
// The server's roles are three kinds: the organiser role, which is
// given by hand and never touched here; Legend, which every participant
// has; and a role per team. Unknown Team is the team role for a member
// whose username no team's signup lists. Legend and Unknown Team are
// found by the id stored on the server's row, then by their exact name
// as long as the role is safe to hand out (the same test a team's role
// passes), and made otherwise. Unlike a team name, these names are the
// organisers' and never a registrant's, so finding them by name cannot
// hand anybody the organiser role.
var FIXED_ROLES: { legend: { column: 'legend_role_id'; name: string }; unknown: { column: 'unknown_role_id'; name: string } } = {
  legend: { column: 'legend_role_id', name: 'Legend' },
  unknown: { column: 'unknown_role_id', name: 'Unknown Team' }
};

// every team's role in a server: role id -> team id; `shown` leaves
// out hidden teams
async function teamRoleIds(db: D1Database, guildId: string, shown?: boolean): Promise<Record<string, number>> {
  var ids: Record<string, number> = {};
  (await db.prepare('SELECT d.role_id, d.team_id FROM discord_teams d' + (shown ? ' JOIN teams t ON t.id = d.team_id AND t.hidden = 0' : '') +
    ' WHERE d.guild_id = ?1 AND d.role_id IS NOT NULL').bind(guildId).all<Pick<DiscordTeamRow, 'role_id' | 'team_id'>>())
    .results.forEach(function (r) { if (r.role_id) ids[r.role_id] = r.team_id; });
  return ids;
}

// Resolves {id, name} or {error}. `known` is the batch's shared lists,
// as for ensureTeamSetup, and keeps what it finds for the next call.
export async function fixedRole(env: Env, guild: DiscordGuildRow, which: keyof typeof FIXED_ROLES, known?: Known): Promise<RoleRef | { error: string }> {
  var spec = FIXED_ROLES[which];
  known = known || {};
  known.fixed = known.fixed || {};
  if (known.fixed[which]) return known.fixed[which];
  if (!known.roles) {
    var list = await discordApi<DiscordRole[]>(env, 'GET', '/guilds/' + guild.guild_id + '/roles');
    if (!list.ok) return { error: 'Could not list the server\'s roles: ' + list.why };
    known.roles = list.data || [];
  }
  var roles = known.roles;
  var taken = await teamRoleIds(env.DB, guild.guild_id);
  var stored = guild[spec.column] || '';
  var role: DiscordRole | null = stored ? roles.filter(function (r) { return r.id === stored; })[0] : null;
  if (!teamRoleOk(role, guild, taken)) {
    role = roles.filter(function (r) { return r.name === spec.name && teamRoleOk(r, guild, taken); })[0] || null;
  }
  if (!role) {
    var made = await discordApi<DiscordRole>(env, 'POST', '/guilds/' + guild.guild_id + '/roles', { name: spec.name, permissions: '0', mentionable: false });
    if (!made.ok) return { error: 'Could not make the ' + spec.name + ' role: ' + made.why };
    role = made.data;
    roles.push(role);
  }
  if (role.id !== stored) {
    await env.DB.prepare('UPDATE discord_guilds SET ' + spec.column + ' = ?2 WHERE guild_id = ?1').bind(guild.guild_id, role.id).run();
    guild[spec.column] = role.id;
  }
  known.fixed[which] = { id: role.id, name: role.name };
  return known.fixed[which];
}

// The role this server gives a signup not in a team yet, when its card
// names one: {id, name}, or null, which means Unknown Team as before.
// Only ever the stored id, never found by name or made, and ignored
// rather than handed out if it has since become a role the bot must not
// give (staff permissions, a team's role, the organiser role).
async function noTeamRole(env: Env, guild: DiscordGuildRow, known?: Known): Promise<RoleRef | null> {
  var id = guild.no_team_role_id || '';
  if (!id || id === guild.unknown_role_id || id === guild.legend_role_id) return null;
  if (String(guild.staff_role_ids || '').split(',').indexOf(id) !== -1) return null;
  known = known || {};
  if (!known.roles) {
    var list = await discordApi<DiscordRole[]>(env, 'GET', '/guilds/' + guild.guild_id + '/roles');
    if (!list.ok) return null;
    known.roles = list.data || [];
  }
  var role = known.roles.filter(function (r) { return r.id === id; })[0];
  if (!teamRoleOk(role, guild, await teamRoleIds(env.DB, guild.guild_id))) return null;
  return { id: role.id, name: role.name };
}

// Legend goes with every team role, and the roles that say somebody has
// no team (Unknown Team, and the server's role for a signup not in a
// team yet) come off. `roles` is what the member holds when that is
// known; without it both are taken off regardless. `keep` is the role
// just given, which is never one of the two taken off. Best effort: the
// team role is what was asked for, and the sweep below puts right
// anybody this misses.
async function markLegend(env: Env, guild: DiscordGuildRow, userId: string, roles: string[] | null, known: Known, keep: string): Promise<void> {
  var found = await fixedRole(env, guild, 'legend', known);
  if ('error' in found) return;
  var legend = found;
  if (!roles || roles.indexOf(legend.id) === -1) {
    await discordApi(env, 'PUT', '/guilds/' + guild.guild_id + '/members/' + userId + '/roles/' + legend.id);
  }
  var off = [guild.unknown_role_id, guild.no_team_role_id].filter(function (id, i, all) {
    return id && id !== keep && id !== legend.id && all.indexOf(id) === i;
  });
  for (var i = 0; i < off.length; i++) {
    if (roles && roles.indexOf(off[i]) === -1) continue;
    await discordApi(env, 'DELETE', '/guilds/' + guild.guild_id + '/members/' + userId + '/roles/' + off[i]);
  }
}

// A renamed team renames its role and channel wherever they exist.
// Best effort: resolves how many servers were updated.
export async function renameTeamDiscord(env: Env, teamId: number, newName: string): Promise<number> {
  if (!botConfigured(env)) return 0;
  var rows = (await env.DB.prepare(
    'SELECT t.guild_id, t.role_id, t.channel_id, g.organiser_role_id, ' +
    '(SELECT COUNT(*) FROM discord_teams o WHERE o.guild_id = t.guild_id AND o.team_id != t.team_id AND o.role_id = t.role_id) AS role_shared, ' +
    '(SELECT COUNT(*) FROM discord_teams o WHERE o.guild_id = t.guild_id AND o.team_id != t.team_id AND o.channel_id = t.channel_id) AS channel_shared ' +
    'FROM discord_teams t LEFT JOIN discord_guilds g ON g.guild_id = t.guild_id WHERE t.team_id = ?1'
  ).bind(teamId).all<Pick<DiscordTeamRow, 'guild_id' | 'role_id' | 'channel_id'> & { organiser_role_id: string | null; role_shared: number; channel_shared: number }>()).results;
  var updated = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var roleName = roleNameFor(newName);
    var chanName = channelNameFor(newName);
    var ok = true;
    // a mapping from before roles were only ever the team's own may
    // name the organiser role or another team's: leave those alone
    if (row.role_shared || row.role_id === row.organiser_role_id) row.role_id = '';
    if (row.channel_shared) row.channel_id = '';
    if (row.role_id) {
      var r = await discordApi(env, 'PATCH', '/guilds/' + row.guild_id + '/roles/' + row.role_id, { name: roleName });
      ok = ok && r.ok;
    }
    if (row.channel_id) {
      var c = await discordApi(env, 'PATCH', '/channels/' + row.channel_id, { name: chanName, topic: 'Private channel for team ' + newName });
      ok = ok && c.ok;
    }
    if (ok) {
      updated++;
      await env.DB.prepare("UPDATE discord_teams SET role_name = ?3, channel_name = ?4, updated_at = datetime('now') WHERE guild_id = ?1 AND team_id = ?2")
        .bind(row.guild_id, teamId, roleName, chanName).run();
    }
  }
  return updated;
}

// ---------- /verify ----------

function normHandle(s: unknown): string {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/^@+/, '').replace(/#0+$/, '');
}

// The signups that name this Discord user, by username. Never by
// display name: anyone can set theirs to somebody else's username,
// and a username is the one name Discord keeps unique.
export async function findSignups(db: D1Database, user: Pick<DiscordUser, 'username' | 'discriminator'>): Promise<Signup[]> {
  var rows = await discordSignups<Signup>(db, 'p.id, p.name, p.discord, p.team_id, p.registration_id, r.team_name');
  var byUsername: Record<string, boolean> = {};
  if (user.username) byUsername[normHandle(user.username)] = true;
  if (user.username && user.discriminator && user.discriminator !== '0') byUsername[normHandle(user.username + '#' + user.discriminator)] = true;
  return rows.filter(function (p) { return byUsername[normHandle(p.discord)]; });
}

// Verifies one member: finds their signup, makes sure the team's role
// and channel exist, gives them the role, records it. Resolves
// {ok, text} where text is what the member sees.
export async function verifyUser(env: Env, guild: DiscordGuildRow, user: DiscordUser, roles: string[] | null): Promise<{ ok: boolean; text: string }> {
  var db = env.DB;
  var hits = await findSignups(db, user);
  // a test signup beside a real one is passed over, as the member sweep
  // passes it over; one with only tests is answered as before
  var real = hits.filter(function (p) { return !testSignup(p); });
  if (real.length) hits = real;
  var handle = user.username || user.global_name || user.id;
  if (!hits.length) {
    return { ok: false, text: 'No signup lists the Discord username **' + handle + '**. If your team is registered, ask an organiser to add your username to your signup in the dashboard; otherwise register at ' + SITE_URL + '/rego/.' };
  }
  // signed up without a team, and not placed in one yet: there is no
  // team role or channel until there is a team, but a server that names
  // a role for people in that position gives it, with Legend
  if (hits.every(function (p) { return !p.team_id && !p.team_name; })) {
    var waiting = 'Found you (**' + hits[0].name + '**), but you signed up without a team and OrgCom has not put you in one yet.';
    var later = ' Run /verify again once you are in one — you will get an email.';
    var asked: Known = {};
    var noTeam = await noTeamRole(env, guild, asked);
    if (noTeam) {
      var tag = await discordApi(env, 'PUT', '/guilds/' + guild.guild_id + '/members/' + user.id + '/roles/' + noTeam.id);
      if (tag.ok) {
        await markLegend(env, guild, user.id, roles || null, asked, noTeam.id);
        return { ok: true, text: waiting + ' You have the role <@&' + noTeam.id + '> until then.' + later };
      }
    }
    return { ok: false, text: waiting + later };
  }
  hits = hits.filter(function (p) { return p.team_id || p.team_name; });
  var teamIds: Record<string, string> = {};
  hits.forEach(function (p) { teamIds[p.team_id || ('name:' + p.team_name)] = p.team_name; });
  var teamNames = Object.keys(teamIds).map(function (k) { return teamIds[k]; });
  if (teamNames.length > 1) {
    return { ok: false, text: 'Your username is on more than one signup (' + teamNames.join(', ') + '). Ask an organiser to fix that in the dashboard, then run /verify again.' };
  }
  var p = hits[0];
  var team = p.team_id ? await db.prepare('SELECT id, name, hidden FROM teams WHERE id = ?1').bind(p.team_id).first<Pick<TeamRow, 'id' | 'name' | 'hidden'>>() : null;
  if (!team) team = await db.prepare('SELECT id, name, hidden FROM teams WHERE name = ?1 COLLATE NOCASE').bind(p.team_name).first<Pick<TeamRow, 'id' | 'name' | 'hidden'>>();
  if (!team) {
    return { ok: false, text: 'Found your signup with team **' + p.team_name + '**, but that team is no longer on the tab. Ask an organiser.' };
  }
  if (team.hidden) {
    return { ok: false, text: 'Found your signup with team **' + team.name + '**, but that team is not taking part, so there is no role to give. Ask an organiser.' };
  }
  var known: Known = {};
  var setup = await ensureTeamSetup(env, guild, team, known);
  if ('error' in setup) {
    return { ok: false, text: 'Found you (**' + p.name + '**, team **' + team.name + '**) but the team role and channel could not be set up: ' + setup.error + ' Ask an organiser to check the bot.' };
  }
  var give = await discordApi(env, 'PUT', '/guilds/' + guild.guild_id + '/members/' + user.id + '/roles/' + setup.role_id);
  if (!give.ok) {
    return { ok: false, text: 'Found you (**' + p.name + '**, team **' + team.name + '**) but the bot could not give you the role: ' + give.why + ' Ask an organiser to check the bot.' };
  }
  await markLegend(env, guild, user.id, roles || null, known, setup.role_id);
  await db.batch([
    db.prepare(
      'INSERT INTO discord_members (guild_id, user_id, username, participant_id, team_id, verified_at) ' +
      "VALUES (?1, ?2, ?3, ?4, ?5, datetime('now')) " +
      "ON CONFLICT(guild_id, user_id) DO UPDATE SET username = ?3, participant_id = ?4, team_id = ?5, verified_at = datetime('now')"
    ).bind(guild.guild_id, user.id, String(user.username || ''), p.id, team.id),
    db.prepare(
      'INSERT INTO submission_log (action, team_name, quest_code, points_delta, old_total, new_total, actor) ' +
      "VALUES ('discord-verify', ?1, ?2, 0, 0, 0, ?3)"
    ).bind(team.name, p.name, 'discord:' + (user.username || user.id))
  ]);
  return {
    ok: true,
    text: 'Verified: **' + p.name + '**, team **' + team.name + '**. You now have the role <@&' + setup.role_id + '> and your team channel is <#' + setup.channel_id + '>.'
  };
}

// The dashboard's way of doing /verify for a whole team: each person on
// it with a Discord username is looked up in the server and given the
// team role. Matched the way /verify matches, by username and never by
// display name, and a username on two teams' signups gets nothing. A
// member already recorded is not searched for again. Resolves
// {given, missing: [usernames not in the server], skipped: [why]}.
export async function giveTeamRoles(env: Env, guild: DiscordGuildRow, team: TeamRef, roleId: string, known: Known): Promise<{ given: number; missing: string[]; skipped: string[] } | { error: string }> {
  var db = env.DB;
  var out: { given: number; missing: string[]; skipped: string[] } = { given: 0, missing: [], skipped: [] };
  // test signups count for nothing here, as in the member sweep: a
  // person on a test team as well is on one team's signup
  var signups = (await discordSignups<Pick<ParticipantRow, 'id' | 'name' | 'discord' | 'team_id'> & { team_hidden: number; reg_hidden: number }>(
    db, 'p.id, p.name, p.discord, p.team_id')).filter(function (p) { return !testSignup(p); });
  var teamsOf: Record<string, Record<string, boolean>> = {};
  signups.forEach(function (p) {
    var key = normHandle(p.discord);
    (teamsOf[key] = teamsOf[key] || {})[p.team_id || 'none'] = true;
  });
  var people = signups.filter(function (p) { return p.team_id === team.id; });
  var recorded: Record<number, string> = {};
  (await db.prepare('SELECT user_id, participant_id FROM discord_members WHERE guild_id = ?1 AND team_id = ?2')
    .bind(guild.guild_id, team.id).all<{ user_id: string; participant_id: number }>()).results.forEach(function (m) { recorded[m.participant_id] = m.user_id; });

  for (var i = 0; i < people.length; i++) {
    var p = people[i];
    var handle = normHandle(p.discord);
    if (Object.keys(teamsOf[handle]).length > 1) { out.skipped.push(handle + ' is on more than one team\'s signup'); continue; }
    var userId = recorded[p.id];
    var username = handle;
    var holds: string[] | null = null;
    if (!userId) {
      var base = handle.split('#')[0];
      var found = await discordApi<DiscordMember[]>(env, 'GET', '/guilds/' + guild.guild_id + '/members/search?query=' + encodeURIComponent(base) + '&limit=10');
      if (!found.ok) return { error: 'Could not search the server\'s members: ' + found.why };
      var hit = (found.data || []).filter(function (m) {
        var u: Partial<DiscordUser> = m.user || {};
        return normHandle(u.username) === handle ||
          (u.discriminator && u.discriminator !== '0' && normHandle(u.username + '#' + u.discriminator) === handle);
      })[0];
      if (!hit || !hit.user) { out.missing.push(handle); continue; }
      userId = hit.user.id;
      username = hit.user.username;
      holds = hit.roles || null;
    }
    var give = await discordApi(env, 'PUT', '/guilds/' + guild.guild_id + '/members/' + userId + '/roles/' + roleId);
    if (!give.ok) {
      // somebody recorded once who has since left the server
      if (give.status === 404) { out.missing.push(handle); continue; }
      return { error: 'Could not give ' + handle + ' the role: ' + give.why };
    }
    await markLegend(env, guild, userId, holds, known, roleId);
    await db.prepare(
      'INSERT INTO discord_members (guild_id, user_id, username, participant_id, team_id, verified_at) ' +
      "VALUES (?1, ?2, ?3, ?4, ?5, datetime('now')) " +
      "ON CONFLICT(guild_id, user_id) DO UPDATE SET username = ?3, participant_id = ?4, team_id = ?5, verified_at = datetime('now')"
    ).bind(guild.guild_id, userId, username, p.id, team.id).run();
    out.given++;
  }
  return out;
}

// A person moved to another team, or out of one (`toTeam` null), in
// every server where they are recorded: the new team's role goes on
// (the team set up there first if it has nothing yet), or, when they
// have no team now, the server's role for a signup not in a team
// (Unknown Team where it names none), and the old team's role comes off — also
// when the new one could not be given, so they stop seeing the old
// team's channel either way. Best effort, like a rename: /verify and the
// sweep put right anybody this misses. Resolves how many servers
// changed.
export async function moveMemberTeam(env: Env, participantId: number, fromTeamId: number | null | undefined, toTeam: TeamRef | null): Promise<number> {
  if (!botConfigured(env)) return 0;
  var db = env.DB;
  var rows = (await db.prepare(
    'SELECT m.guild_id, m.user_id, t.role_id AS old_role FROM discord_members m ' +
    'LEFT JOIN discord_teams t ON t.guild_id = m.guild_id AND t.team_id = ?2 WHERE m.participant_id = ?1'
  ).bind(participantId, fromTeamId || 0).all<{ guild_id: string; user_id: string; old_role: string | null }>()).results;
  var changed = 0;
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    var guild = await guildConfig(db, env, row.guild_id);
    if (!guild || !guild.enabled) continue;
    var known: Known = {};
    var given = '';
    if (toTeam) {
      var setup = await ensureTeamSetup(env, guild, toTeam, known);
      if (!('error' in setup)) {
        var give = await discordApi(env, 'PUT', '/guilds/' + guild.guild_id + '/members/' + row.user_id + '/roles/' + setup.role_id);
        if (give.ok) given = setup.role_id;
      }
    } else {
      var waiting = (await noTeamRole(env, guild, known)) || await fixedRole(env, guild, 'unknown', known);
      if (!('error' in waiting)) {
        var tag = await discordApi(env, 'PUT', '/guilds/' + guild.guild_id + '/members/' + row.user_id + '/roles/' + waiting.id);
        if (tag.ok) given = waiting.id;
      }
    }
    var off: { ok: boolean; status?: number } = { ok: true };
    if (row.old_role && row.old_role !== given) {
      off = await discordApi(env, 'DELETE', '/guilds/' + guild.guild_id + '/members/' + row.user_id + '/roles/' + row.old_role);
    }
    if (given && (off.ok || off.status === 404)) changed++;
  }
  return changed;
}

function ephemeral(text: string): { content: string; flags: number } {
  return { content: text, flags: 64 };
}

async function followUp(env: Env, interaction: Pick<Interaction, 'application_id' | 'token'>, text: string): Promise<DiscordResult<unknown>> {
  return discordApi(env, 'PATCH', '/webhooks/' + interaction.application_id + '/' + interaction.token + '/messages/@original',
    { content: text, allowed_mentions: { parse: [] } });
}

// /verify answers with a deferred, only-you-can-see-it message, does
// the role and channel work in the background (several Discord calls,
// more than the three seconds an interaction may take), then fills
// the message in.
export async function handleVerify(interaction: Interaction, env: Env, ctx: Ctx): Promise<{ content: string; flags: number } | { type: number; data: object }> {
  var user = (interaction.member && interaction.member.user) || interaction.user;
  if (!interaction.guild_id || !user) return ephemeral('Run /verify inside the SCS server, not in a direct message.');
  var guild = await guildConfig(env.DB, env, interaction.guild_id);
  if (!guild || !guild.enabled) return ephemeral('This server is not set up for verification yet. An organiser can add it in the dashboard.');
  if (!botConfigured(env)) return ephemeral('Verification is locked until DISCORD_BOT_TOKEN is set on the worker (see the README).');
  var work = verifyUser(env, guild, user, (interaction.member && interaction.member.roles) || null)
    .catch(function () { return { ok: false, text: 'Something went wrong while verifying you. Try again in a minute.' }; })
    .then(function (res) { return followUp(env, interaction, res.text); });
  if (ctx && ctx.waitUntil) ctx.waitUntil(work); else await work;
  return { type: 5, data: { flags: 64 } };
}

// ---------- a reviewed submission, in the team's own channel ----------
// "Wondabyne (SQ40) accepted for 950 points. Galahs's points now
// 4,467.", "Wondabyne (SQ40) rejected: the sign is not in the photo",
// for a correction, "Wondabyne (SQ40): 950 points taken off." or, for an
// accepted one changed, "Wondabyne (SQ40) changed: now worth 500 of 950
// points.", and a
// link to each photo and video, which Discord embeds — a running record for
// the team of what has been decided. Every enabled server where the
// team has a channel gets it, unless the server's switch is off; a
// hidden team is a test and gets nothing. While the tab is frozen the
// total is left out, the way the team's own score sheet goes quiet.
// Runs after the review's answer has gone, so it never throws.
export async function postVerdict(env: Env, origin: string, v: Verdict): Promise<{ sent: number; failed: number }> {
  return postToTeam(env, v.team_id, function () {
    return verdictText(String(env.PUBLIC_API || origin).replace(/\/+$/, ''), v);
  });
}

// One message in a team's channel on every enabled server where it has
// one, unless the server's switch is off; a hidden team gets nothing.
// `content` is a function so nothing is built for a team with nowhere
// to post. Never throws.
export async function postToTeam(env: Env, teamId: number, content: () => string): Promise<{ sent: number; failed: number }> {
  var out = { sent: 0, failed: 0 };
  try {
    if (!botConfigured(env)) return out;
    type Row = { guild_id: string; channel_id: string; accept_posts: number | null };
    var rows = (await env.DB.prepare(
      'SELECT g.guild_id, t.channel_id, g.accept_posts FROM discord_teams t ' +
      'JOIN discord_guilds g ON g.guild_id = t.guild_id JOIN teams tm ON tm.id = t.team_id ' +
      'WHERE t.team_id = ?1 AND t.channel_id IS NOT NULL AND g.enabled = 1 AND COALESCE(tm.hidden, 0) = 0'
    ).bind(teamId).all<Row>()).results;
    rows = rows.filter(function (r) { return r.accept_posts == null || r.accept_posts; });
    if (!rows.length) return out;
    var text = content();
    for (var i = 0; i < rows.length; i++) {
      var res = await discordApi(env, 'POST', '/channels/' + rows[i].channel_id + '/messages',
        { content: text, allowed_mentions: { parse: [] } });
      if (res.ok) out.sent++; else out.failed++;
    }
  } catch (err) { /* whatever this follows went through; the post is extra */ }
  return out;
}

// Discord's markdown taken out of a name a person typed.
export function plainName(text: unknown): string {
  return String(text || '').replace(/[\\*_~`|>#]/g, '\\$&');
}

// A person checked in at the door, or taken back off. The check-in
// worker reports each one with where the team stands.
export function checkinText(c: { person: string; event: string; complete: boolean; checked_in: number; people: number }): string {
  var who = '**' + plainName(c.person) + '**';
  var count = ' (' + c.checked_in + ' of ' + c.people + ')';
  if (c.event === 'out') return who + '\u2019s check-in was taken back' + count + '.';
  if (c.complete) return who + ' checked in. The whole team is here' + count + '.';
  return who + ' checked in' + count + '.';
}

var MAX_LINKS = 10; // file links in one post

// A proof file's link in a post, at a path ending in its name so Discord
// takes it for a picture or a video. A video is linked as the encoder's
// 720p MP4: without res the route serves the clean copy of what the
// phone filmed, often HEVC in a .mov, which Discord does not play. `mark`
// makes the address new, so Discord fetches the preview again rather
// than showing the one it keeps for the old address.
export function fileLink(base: string, f: ProofFile, mark?: string): string {
  var video = fileKindOf(f.type, f.name) === 'video';
  var name = video ? String(f.name || 'video').replace(/\.[A-Za-z0-9]{1,5}$/, '') + '.mp4' : fileNameFor(f.name || 'proof', f.type);
  var query = (video ? ['res=720'] : []).concat(mark ? ['v=' + mark] : []);
  return base + '/api/submit/file/' + f.key.split('/').map(encodeURIComponent).join('/') + '/' +
    encodeURIComponent(fileNameFor(name, video ? 'video/mp4' : f.type)) + (query.length ? '?' + query.join('&') : '');
}

export function verdictText(base: string, v: Verdict): string {
  var line = '**' + v.title + '**' + (v.title !== v.codes ? ' (' + v.codes + ')' : '');
  if (v.verdict === 'rejected') {
    line += ' rejected' + (v.reason ? ': ' + v.reason : '.');
  } else {
    var n = Math.abs(v.gained as number);
    var pts = fmtPts(n) + (n === 1 ? ' point' : ' points');
    // part of the points: out of how many, unless the quest keeps its
    // points a mystery, when it only says it was a part mark
    var part = v.part && v.verdict !== 'adjusted' ? v.part : null;
    if (part && part.of != null) pts = fmtPts(n) + ' of ' + fmtPts(Math.abs(part.of)) + ' points';
    var accepted = part && part.of == null ? ' accepted with part marks' : ' accepted';
    var gained = v.gained as number;
    if (v.verdict === 'adjusted') line += ': ' + pts + (gained < 0 ? ' taken off' : ' added') + (v.reason ? ' (' + v.reason + ').' : '.');
    else if (v.verdict === 'revised') {
      line += part && part.of == null ? ' changed to part marks: ' + pts + (gained < 0 ? ' taken off.' : '.')
        : gained < 0 ? ' changed: now takes ' + pts + ' off.' : ' changed: now worth ' + pts + '.';
    }
    else if (gained < 0) line += accepted + ': ' + pts + ' taken off.';
    // a submission on a counted part adds to the challenge's count
    else if (v.counted) line += ' accepted. It counts towards the challenge.';
    else line += accepted + (part && part.of == null ? ': ' : ' for ') + pts + '.';
    if (v.total != null) line += ' ' + v.team + '\u2019s points now ' + fmtPts(v.total) + '.';
  }
  // the photos and videos, which are what the public file route serves,
  // as many whole links as fit under Discord's 2000 characters
  var text = line.slice(0, 2000);
  (v.files || []).filter(function (f) {
    var kind = fileKindOf(f.type, f.name);
    return kind === 'photo' || kind === 'video';
  }).slice(0, MAX_LINKS).forEach(function (f) {
    var link = fileLink(base, f);
    if (text.length + 1 + link.length <= 2000) text += '\n' + link;
  });
  return text;
}

// ---------- the dashboard's Discord tab ----------

async function status(env: Env): Promise<Response> {
  var db = env.DB;
  var out: { ok: true; configured: boolean; bot: { id: string; username: string } | null; servers: { id: string; name: string }[];
    guilds: Record<string, unknown>[]; teams: unknown[]; members: unknown[]; why: string } =
    { ok: true, configured: botConfigured(env), bot: null, servers: [], guilds: [], teams: [], members: [], why: '' };
  var rows = await guildRows(db, env);
  var serverNames: Record<string, string> = {};
  if (out.configured) {
    var me = await botUser(env);
    if (me) out.bot = { id: me.id, username: me.username };
    var servers = await discordApi<{ id: string; name: string }[]>(env, 'GET', '/users/@me/guilds');
    if (servers.ok) {
      out.servers = (servers.data || []).map(function (g) { serverNames[g.id] = g.name; return { id: g.id, name: g.name }; });
    } else {
      out.why = servers.why;
    }
  }
  var teamCounts: Record<string, number> = {};
  (await db.prepare('SELECT guild_id, COUNT(*) AS n FROM discord_teams WHERE channel_id IS NOT NULL GROUP BY guild_id').all<{ guild_id: string; n: number }>()).results
    .forEach(function (r) { teamCounts[r.guild_id] = r.n; });
  var memberCounts: Record<string, number> = {};
  (await db.prepare('SELECT guild_id, COUNT(*) AS n FROM discord_members GROUP BY guild_id').all<{ guild_id: string; n: number }>()).results
    .forEach(function (r) { memberCounts[r.guild_id] = r.n; });
  for (var i = 0; i < rows.length; i++) {
    var g = rows[i];
    if (serverNames[g.guild_id] && serverNames[g.guild_id] !== g.name) {
      await db.prepare('UPDATE discord_guilds SET name = ?2 WHERE guild_id = ?1').bind(g.guild_id, serverNames[g.guild_id]).run();
      g.name = serverNames[g.guild_id];
    }
    out.guilds.push({
      guild_id: g.guild_id, name: g.name, organiser_role_id: g.organiser_role_id, category_name: g.category_name,
      category_id: g.category_id, enabled: g.enabled, announce_channel_id: g.announce_channel_id || '',
      accept_posts: g.accept_posts == null ? 1 : g.accept_posts,
      staff_role_ids: String(g.staff_role_ids || '').split(',').filter(Boolean),
      no_team_role_id: g.no_team_role_id || '',
      unknown_role_id: g.unknown_role_id || '',
      held: g.held ? 1 : 0,
      in_server: !!serverNames[g.guild_id],
      teams_setup: teamCounts[g.guild_id] || 0, verified: memberCounts[g.guild_id] || 0
    });
  }
  var known: Record<string, boolean> = {};
  out.guilds.forEach(function (g) { known[g.guild_id as string] = true; });
  out.servers = out.servers.filter(function (s) { return !known[s.id]; });

  var teams = (await db.prepare(
    'SELECT t.id, t.name, t.hidden, (SELECT COUNT(*) FROM registrations r WHERE r.team_id = t.id) AS registrations, ' +
    '(SELECT COUNT(*) FROM participants p WHERE p.team_id = t.id) AS people, ' +
    "(SELECT COUNT(*) FROM participants p WHERE p.team_id = t.id AND p.discord IS NOT NULL AND p.discord != '') AS on_discord " +
    'FROM teams t ORDER BY t.name COLLATE NOCASE'
  ).all<Pick<TeamRow, 'id' | 'name' | 'hidden'> & { registrations: number; people: number; on_discord: number; guilds?: Record<string, unknown>; verified?: number }>()).results;
  var setups = (await db.prepare('SELECT guild_id, team_id, role_id, channel_id, role_name, channel_name FROM discord_teams').all<Omit<DiscordTeamRow, 'updated_at'>>()).results;
  var verifiedPerTeam: Record<number, number> = {};
  (await db.prepare('SELECT team_id, COUNT(*) AS n FROM discord_members GROUP BY team_id').all<{ team_id: number; n: number }>()).results
    .forEach(function (r) { verifiedPerTeam[r.team_id] = r.n; });
  var byTeam: Record<number, (typeof teams)[number] & { guilds: Record<string, unknown> }> = {};
  teams.forEach(function (t) {
    t.guilds = {};
    t.verified = verifiedPerTeam[t.id] || 0;
    byTeam[t.id] = t as typeof t & { guilds: Record<string, unknown> };
  });
  setups.forEach(function (s) {
    if (byTeam[s.team_id]) byTeam[s.team_id].guilds[s.guild_id] = { role_id: s.role_id, channel_id: s.channel_id, role_name: s.role_name, channel_name: s.channel_name };
  });
  out.teams = teams;
  out.members = (await db.prepare(
    'SELECT m.guild_id, m.user_id, m.username, m.verified_at, t.name AS team_name, p.name AS person ' +
    'FROM discord_members m LEFT JOIN teams t ON t.id = m.team_id LEFT JOIN participants p ON p.id = m.participant_id ' +
    'ORDER BY m.verified_at DESC LIMIT 300'
  ).all()).results;
  return json(out);
}

// roles and channels of one server, for the dashboard's pickers
async function guildDetail(env: Env, url: URL): Promise<Response> {
  var guildId = cleanText(url.searchParams.get('guild_id'), 30);
  if (!/^\d{5,30}$/.test(guildId)) return json({ error: 'guild_id must be a server id' }, 400);
  var roles = await discordApi<DiscordRole[]>(env, 'GET', '/guilds/' + guildId + '/roles');
  if (!roles.ok) return json({ error: roles.why }, 502);
  var channels = await discordApi<DiscordChannel[]>(env, 'GET', '/guilds/' + guildId + '/channels');
  if (!channels.ok) return json({ error: channels.why }, 502);
  return json({
    ok: true,
    roles: (roles.data || []).filter(function (r) { return r.id !== guildId && !r.managed; })
      .sort(function (a, b) { return b.position - a.position; })
      .map(function (r) { return { id: r.id, name: r.name, color: r.color || 0 }; }),
    channels: (channels.data || []).filter(function (c) {
      return c.type === TEXT_CHANNEL || c.type === ANNOUNCEMENT_CHANNEL || c.type === CATEGORY_CHANNEL;
    }).sort(function (a, b) { return (a.position || 0) - (b.position || 0); })
      .map(function (c) { return { id: c.id, name: c.name, type: c.type, parent_id: c.parent_id || null }; })
  });
}

async function saveGuild(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var guildId = cleanText(body.guild_id, 30);
  if (!/^\d{5,30}$/.test(guildId)) return json({ error: 'The server id is the long number from Copy Server ID.' }, 400);
  var roleId = cleanText(body.organiser_role_id, 30);
  if (roleId && !/^\d{5,30}$/.test(roleId)) return json({ error: 'The organiser role id should be a number.' }, 400);
  var category = cleanText(body.category_name, 100) || DEFAULT_CATEGORY;
  var name = cleanText(body.name, 100);
  var enabled = body.enabled == null || body.enabled ? 1 : 0;
  // where a new message is cross-posted; empty means this server gets none
  var announce = cleanText(body.announce_channel_id, 30);
  if (announce && !/^\d{5,30}$/.test(announce)) {
    return json({ error: 'The announcement channel id should be a number.' }, 400);
  }
  var existing = await db.prepare('SELECT * FROM discord_guilds WHERE guild_id = ?1').bind(guildId).first<DiscordGuildRow>();
  // The two roles the bot hands out by itself: Unknown Team, for a member
  // no signup lists ('' is the bot's own, found by its name or made), and
  // the role for a signup not in a team yet ('' is Unknown Team again).
  // Each has to pass what a team's role passes and cannot be Legend or a
  // role that sees every team channel, which would open every team
  // channel to whoever holds it; the same role picked for both is the
  // same as no second role. Checked before anything is written, so a
  // refusal saves nothing.
  var unknownId = body.unknown_role_id == null ? null : cleanText(body.unknown_role_id, 30);
  var noTeamId = body.no_team_role_id == null ? null : cleanText(body.no_team_role_id, 30);
  if ((unknownId && !/^\d{5,30}$/.test(unknownId)) || (noTeamId && !/^\d{5,30}$/.test(noTeamId))) {
    return json({ error: 'Pick one of the server\'s roles.' }, 400);
  }
  var unknownNow = unknownId != null ? unknownId : (existing && existing.unknown_role_id) || '';
  if (noTeamId && noTeamId === unknownNow) noTeamId = '';
  var noTeamNow = noTeamId != null ? noTeamId : (existing && existing.no_team_role_id) || '';
  if (noTeamNow && noTeamNow === unknownNow) { noTeamId = ''; noTeamNow = ''; }
  var staffNow: string[] = Array.isArray(body.staff_role_ids) ? body.staff_role_ids.map(String)
    : String((existing && existing.staff_role_ids) || '').split(',');
  if (unknownNow && staffNow.indexOf(unknownNow) !== -1) {
    return json({ error: 'The role for members no signup lists is also ticked to see every team channel. Untick it there or pick another.' }, 400);
  }
  if (noTeamNow && staffNow.indexOf(noTeamNow) !== -1) {
    return json({ error: 'The role for people without a team is also ticked to see every team channel. Untick it there or pick another.' }, 400);
  }
  var serverRoles: DiscordRole[] | null = null;
  // only a change is looked up: an unchanged card saves even while the
  // bot cannot see the server
  var picks: string[] = [];
  if (unknownId && unknownId !== ((existing && existing.unknown_role_id) || '')) picks.push(unknownId);
  if (noTeamId && noTeamId !== ((existing && existing.no_team_role_id) || '')) picks.push(noTeamId);
  if (picks.length) {
    var list = await discordApi<DiscordRole[]>(env, 'GET', '/guilds/' + guildId + '/roles');
    if (!list.ok) return json({ error: 'Could not list the server\'s roles: ' + list.why }, 502);
    var found: DiscordRole[] = serverRoles = list.data || [];
    var taken = await teamRoleIds(db, guildId);
    for (var k = 0; k < picks.length; k++) {
      var picked = found.filter(function (r) { return r.id === picks[k]; })[0];
      if (!picked) return json({ error: 'That role is not on the server.' }, 400);
      if ((existing && picks[k] === existing.legend_role_id) ||
          !teamRoleOk(picked, { guild_id: guildId, organiser_role_id: roleId }, taken)) {
        return json({ error: 'The bot will not hand out ' + picked.name + ' by itself: it is the organiser role, Legend, a team\'s role, a bot\'s own role, or one with staff permissions.' }, 400);
      }
    }
  }
  await db.prepare(
    'INSERT INTO discord_guilds (guild_id, name, organiser_role_id, category_name, enabled, announce_channel_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6) ' +
    'ON CONFLICT(guild_id) DO UPDATE SET name = CASE WHEN ?2 = \'\' THEN name ELSE ?2 END, organiser_role_id = ?3, category_name = ?4, enabled = ?5, announce_channel_id = ?6' +
    // a renamed category is found or made afresh on the next setup
    (existing && existing.category_name !== category ? ', category_id = NULL' : '')
  ).bind(guildId, name, roleId, category, enabled, announce || null).run();
  await db.prepare(SEEDED).run();
  // the roles that see every team channel, and whether accepted
  // submissions are posted, each saved only when the request names it
  var note = '';
  if (body.accept_posts != null) {
    await db.prepare('UPDATE discord_guilds SET accept_posts = ?2 WHERE guild_id = ?1').bind(guildId, body.accept_posts ? 1 : 0).run();
  }
  if (Array.isArray(body.staff_role_ids)) {
    var staff = body.staff_role_ids.map(function (id) { return cleanText(id, 30); })
      .filter(function (id, i, all) { return /^\d{5,30}$/.test(id) && id !== guildId && all.indexOf(id) === i; }).slice(0, 25);
    await db.prepare('UPDATE discord_guilds SET staff_role_ids = ?2 WHERE guild_id = ?1').bind(guildId, staff.join(',')).run();
  }
  if (unknownId != null) {
    var was = (existing && existing.unknown_role_id) || '';
    await db.prepare('UPDATE discord_guilds SET unknown_role_id = ?2 WHERE guild_id = ?1').bind(guildId, unknownId).run();
    // the bot only ever looks at the one role, so whoever it gave the old
    // one to keeps it until somebody takes it off in Discord
    if (was && was !== unknownId) {
      var old = (serverRoles || []).filter(function (r) { return r.id === was; })[0];
      note = 'Saved. People who already have ' + (old ? old.name : 'the old role') + ' keep it; the bot gives the new one from now on.';
    }
  }
  if (noTeamId != null) {
    await db.prepare('UPDATE discord_guilds SET no_team_role_id = ?2 WHERE guild_id = ?1').bind(guildId, noTeamId).run();
  }
  await logAction(db, session.name, existing ? 'discord-guild-edit' : 'discord-guild-add', name || guildId, roleId ? 'role ' + roleId : 'no organiser role', 0, 0, 0);
  return json({ ok: true, guild_id: guildId, note: note });
}

async function deleteGuild(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var guildId = cleanText(body.guild_id, 30);
  var row = await env.DB.prepare('SELECT guild_id, name FROM discord_guilds WHERE guild_id = ?1').bind(guildId).first<Pick<DiscordGuildRow, 'guild_id' | 'name'>>();
  if (!row) return json({ error: 'no such server' }, 404);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM discord_guilds WHERE guild_id = ?1').bind(guildId),
    env.DB.prepare('DELETE FROM discord_teams WHERE guild_id = ?1').bind(guildId),
    env.DB.prepare('DELETE FROM discord_members WHERE guild_id = ?1').bind(guildId),
    // the last one gone stays gone: the secrets do not bring it back
    env.DB.prepare(SEEDED)
  ]);
  await logAction(env.DB, session.name, 'discord-guild-remove', row.name || guildId, '-', 0, 0, 0);
  return json({ ok: true });
}

// registers the slash commands in one server (instant, unlike global)
async function registerCommands(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var guildId = cleanText(body.guild_id, 30);
  if (!/^\d{5,30}$/.test(guildId)) return json({ error: 'Pick a server.' }, 400);
  var appId = await applicationId(env);
  if (!appId) return json({ error: 'Could not read the application id from Discord. Is DISCORD_BOT_TOKEN set?' }, 502);
  var res = await discordApi<{ name: string }[]>(env, 'PUT', '/applications/' + appId + '/guilds/' + guildId + '/commands', COMMANDS);
  if (!res.ok) return json({ error: res.why }, 502);
  await logAction(env.DB, session.name, 'discord-commands', guildId, (res.data || []).length + ' commands', 0, 0, 0);
  return json({ ok: true, commands: (res.data || []).map(function (c) { return c.name; }) });
}

// the bot says something in a channel, or posts the leaderboard
async function postMessage(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var channelId = cleanText(body.channel_id, 30);
  if (!/^\d{5,30}$/.test(channelId)) return json({ error: 'Pick a channel.' }, 400);
  var preset = String(body.preset || '');
  var payload: { content: string; allowed_mentions?: object };
  if (preset === 'leaderboard') {
    var rows = await standings(env.DB);
    if (!rows.length) return json({ error: 'The tab has no teams yet.' }, 400);
    payload = { content: leaderboardText(rows, 1, 10), allowed_mentions: { parse: [] } };
  } else {
    var content = String(body.content == null ? '' : body.content).replace(/\r\n/g, '\n').trim().slice(0, 2000);
    if (!content) return json({ error: 'Nothing to post.' }, 400);
    // typed by an organiser: their mentions go through as written
    payload = { content: content };
  }
  var res = await discordApi<DiscordMessage>(env, 'POST', '/channels/' + channelId + '/messages', payload,
    cleanText(body.guild_id, 30) || undefined);
  if (!res.ok) return json({ error: res.why, held: !!res.held }, res.held ? 409 : 502);
  await logAction(env.DB, session.name, 'discord-post', channelId, preset || (payload.content.length + ' chars'), 0, 0, 0);
  return json({ ok: true, id: res.data && res.data.id });
}

// Teams with people on them: registered as a team, or placed from solo
// signups.
var TEAMS_WITH_PEOPLE =
  'SELECT t.id, t.name FROM teams t WHERE t.hidden = 0 AND (' +
  'EXISTS (SELECT 1 FROM registrations r WHERE r.team_id = t.id) OR ' +
  'EXISTS (SELECT 1 FROM participants p WHERE p.team_id = t.id)) ORDER BY t.name COLLATE NOCASE';

// Role and channel for one team, or every team with people on it, in a
// server; with `members`, everyone on the team who is in the server is
// given the role as well. The dashboard sends one team per request, so
// a long list never has to fit in one request.
async function setupTeams(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var guild = await guildConfig(db, env, cleanText(body.guild_id, 30));
  if (!guild) return json({ error: 'Pick a server that is set up in the dashboard.' }, 400);
  var teams: TeamRef[];
  if (body.team_id) {
    var one = await db.prepare('SELECT id, name, hidden FROM teams WHERE id = ?1').bind(Number(body.team_id)).first<Pick<TeamRow, 'id' | 'name' | 'hidden'>>();
    if (!one) return json({ error: 'no such team' }, 404);
    if (one.hidden) return json({ error: one.name + ' is hidden on the Teams tab, so the bot leaves it alone.' }, 409);
    teams = [one];
  } else {
    teams = (await db.prepare(TEAMS_WITH_PEOPLE).all<TeamRef>()).results;
  }
  var known: Known = {};
  var done: Record<string, unknown>[] = [];
  var failed: { team: string; error: string }[] = [];
  var given = 0;
  for (var i = 0; i < teams.length; i++) {
    var res: TeamSetup | { error: string } = await ensureTeamSetup(env, guild, teams[i], known);
    if (!('error' in res)) {
      var entry: Record<string, unknown> = { team: teams[i].name, role: res.role_name, channel: res.channel_name, made: res.made };
      if (body.members) {
        var roles = await giveTeamRoles(env, guild, teams[i], res.role_id, known);
        if ('error' in roles) res = roles;
        else { entry.given = roles.given; entry.missing = roles.missing; entry.skipped = roles.skipped; given += roles.given; }
      }
      if (!('error' in res)) done.push(entry);
    }
    if ('error' in res) failed.push({ team: teams[i].name, error: res.error });
    if (failed.length && !body.team_id && failed.length >= 3) break; // three failures: something is wrong with the bot
  }
  await logAction(db, session.name, 'discord-setup', guild.name || guild.guild_id,
    (teams.length === 1 ? teams[0].name : done.length + ' teams') +
    (body.members ? ', ' + given + ' given the role' : '') + (failed.length ? ', ' + failed.length + ' failed' : ''), 0, 0, 0);
  return json({ ok: true, done: done, failed: failed });
}

// ---------- a team's role and channel, by hand ----------
// An organiser pointing a team at a role and a channel themselves: the
// server already had them, or what the bot made went wrong. The bot's
// own rules still hold — never @everyone, the organiser role, Legend,
// Unknown Team, a bot's role, a role with staff permissions, or another
// team's role or channel — because /verify hands this role to whoever
// it matches. Empty forgets one, and the next setup makes a new one.
// With both set, the team's setup runs so the channel lets the role in,
// and a role new to the team is given to its people in the server.
async function saveTeamDiscord(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var guild = await guildConfig(db, env, cleanText(body.guild_id, 30));
  if (!guild) return json({ error: 'Pick a server that is set up in the dashboard.' }, 400);
  var team = await db.prepare('SELECT id, name, hidden FROM teams WHERE id = ?1').bind(Number(body.team_id) || 0).first<Pick<TeamRow, 'id' | 'name' | 'hidden'>>();
  if (!team) return json({ error: 'no such team' }, 404);
  if (team.hidden) return json({ error: team.name + ' is hidden on the Teams tab, so the bot leaves it alone.' }, 409);
  var roleId = cleanText(body.role_id, 30);
  var channelId = cleanText(body.channel_id, 30);
  if ((roleId && !/^\d{5,30}$/.test(roleId)) || (channelId && !/^\d{5,30}$/.test(channelId))) {
    return json({ error: 'A role or channel id is a number.' }, 400);
  }
  var others = (await db.prepare(
    'SELECT d.role_id, d.channel_id, t.name FROM discord_teams d LEFT JOIN teams t ON t.id = d.team_id WHERE d.guild_id = ?1 AND d.team_id != ?2'
  ).bind(guild.guild_id, team.id).all<Pick<DiscordTeamRow, 'role_id' | 'channel_id'> & { name: string | null }>()).results;
  var was = await db.prepare('SELECT role_id FROM discord_teams WHERE guild_id = ?1 AND team_id = ?2').bind(guild.guild_id, team.id).first<Pick<DiscordTeamRow, 'role_id'>>();
  var holder = function (id: string, field: 'role_id' | 'channel_id') {
    var hit = others.filter(function (r) { return r[field] === id; })[0];
    return hit ? (hit.name || 'another team') : '';
  };
  var role: DiscordRole | null = null;
  var channel: DiscordChannel | null = null;
  if (roleId) {
    var roles = await discordApi<DiscordRole[]>(env, 'GET', '/guilds/' + guild.guild_id + '/roles');
    if (!roles.ok) return json({ error: 'Could not list the server\'s roles: ' + roles.why }, 502);
    role = (roles.data || []).filter(function (r) { return r.id === roleId; })[0];
    if (!role) return json({ error: 'That role is not on the server.' }, 400);
    if (holder(roleId, 'role_id')) return json({ error: holder(roleId, 'role_id') + ' already has that role.' }, 409);
    if (roleId === guild.legend_role_id || roleId === guild.unknown_role_id || roleId === guild.no_team_role_id ||
        !teamRoleOk(role, guild, {})) {
      return json({ error: 'The bot will not give ' + role.name + ' to a team: it is everyone\'s, the organiser role, Legend, Unknown Team, the role for people without a team, a bot\'s own role, or one with staff permissions.' }, 400);
    }
  }
  if (channelId) {
    var channels = await discordApi<DiscordChannel[]>(env, 'GET', '/guilds/' + guild.guild_id + '/channels');
    if (!channels.ok) return json({ error: 'Could not list the server\'s channels: ' + channels.why }, 502);
    channel = (channels.data || []).filter(function (c) { return c.id === channelId && c.type === TEXT_CHANNEL; })[0];
    if (!channel) return json({ error: 'That is not a text channel on the server.' }, 400);
    if (holder(channelId, 'channel_id')) return json({ error: holder(channelId, 'channel_id') + ' already has that channel.' }, 409);
  }
  // the same lock a setup takes, so a setup running now cannot write the
  // team's role or channel back over this, and this one's setup runs
  // inside it
  var lock = await lockTeam(db, guild.guild_id, team.id);
  if (!lock) return json({ error: 'Team ' + team.name + ' is being set up right now. Try again in a minute.' }, 409);
  var known: Known = {};
  var set: TeamSetup | SetupRefusal | null = null;
  try {
    await db.prepare(
      'INSERT INTO discord_teams (guild_id, team_id, role_id, channel_id, role_name, channel_name, updated_at) ' +
      "VALUES (?1, ?2, ?3, ?4, ?5, ?6, datetime('now')) " +
      "ON CONFLICT(guild_id, team_id) DO UPDATE SET role_id = ?3, channel_id = ?4, role_name = ?5, channel_name = ?6, updated_at = datetime('now')"
    ).bind(guild.guild_id, team.id, role ? role.id : null, channel ? channel.id : null, role ? role.name : '', channel ? channel.name : '').run();
    if (role && channel) set = await setUpTeam(env, guild, team, known);
  } finally {
    await unlockTeam(db, lock);
  }
  var note = '';
  var given = 0;
  if (role && channel && set) {
    if ('error' in set) note = 'Saved, but the channel was not brought up to date: ' + set.error;
    else if (!was || was.role_id !== role.id) {
      // a new role goes to everyone on the team who is in the server
      var handed = await giveTeamRoles(env, guild, team, role.id, known);
      if ('error' in handed) note = 'Saved, but the team was not given the role: ' + handed.error;
      else given = handed.given;
    }
  }
  await logAction(db, session.name, 'discord-team-edit', team.name,
    (role ? '@' + role.name : 'no role') + ', ' + (channel ? '#' + channel.name : 'no channel'), 0, 0, 0);
  return json({ ok: true, team: team.name, role_name: role ? role.name : '', channel_name: channel ? channel.name : '', given: given, note: note });
}

// ---------- submit codes, in each team's channel ----------
// The code a team signs in to the submit page with, posted in its own
// channel with its role mentioned so everyone on the team sees it, and
// a button to the page. One team a request, like setup; a team with no
// code yet is given one first. This is an organiser's own action, so the
// server's switch for automatic posts does not stop it.
export function codeText(roleId: string | null, code: string): string {
  return 'Hey ' + (roleId ? '<@&' + roleId + '>' : 'team') + ', your submit code for SCS.2 is:\n' +
    '```\n' + code + '\n```\n' +
    'Use it to sign in to the SCS.2 app and submit quests. See you around, Legends!';
}

async function sendCode(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  if (!botConfigured(env)) return json({ error: 'The bot needs DISCORD_BOT_TOKEN on the worker to post.' }, 400);
  var team = await db.prepare('SELECT id, name, hidden FROM teams WHERE id = ?1').bind(Number(body.team_id) || 0).first<Pick<TeamRow, 'id' | 'name' | 'hidden'>>();
  if (!team) return json({ error: 'no such team' }, 404);
  if (team.hidden) return json({ error: team.name + ' is hidden on the Teams tab, so the bot leaves it alone.' }, 409);
  var row = await db.prepare('SELECT code FROM team_codes WHERE team_id = ?1').bind(team.id).first<{ code: string }>();
  var minted = false;
  for (var tries = 0; !row && tries < 3; tries++) {
    try {
      var fresh = mintCode();
      await db.prepare('INSERT INTO team_codes (team_id, code) VALUES (?1, ?2)').bind(team.id, fresh).run();
      row = { code: fresh };
      minted = true;
    } catch (err) {
      // another request gave it one first, or the code was taken
      row = await db.prepare('SELECT code FROM team_codes WHERE team_id = ?1').bind(team.id).first<{ code: string }>();
    }
  }
  if (!row) return json({ error: 'Could not give ' + team.name + ' a code. Try again.' }, 500);
  var where = (await db.prepare(
    'SELECT d.guild_id, d.role_id, d.channel_id FROM discord_teams d JOIN discord_guilds g ON g.guild_id = d.guild_id ' +
    'WHERE d.team_id = ?1 AND d.channel_id IS NOT NULL AND g.enabled = 1'
  ).bind(team.id).all<Pick<DiscordTeamRow, 'guild_id' | 'role_id' | 'channel_id'>>()).results;
  var sent = 0;
  var failed: string[] = [];
  for (var i = 0; i < where.length; i++) {
    var res = await discordApi(env, 'POST', '/channels/' + where[i].channel_id + '/messages', {
      content: codeText(where[i].role_id, row.code),
      allowed_mentions: { parse: [], roles: where[i].role_id ? [where[i].role_id] : [] },
      components: [{ type: 1, components: [{ type: 2, style: 5, label: 'Submit a Quest', url: SITE_URL + '/submit/' }] }]
    });
    if (res.ok) sent++; else failed.push(res.why);
  }
  await logAction(db, session.name, 'discord-codes', team.name, sent + (sent === 1 ? ' channel' : ' channels'), 0, 0, 0);
  return json({ ok: true, team: team.name, sent: sent, failed: failed, no_channel: !where.length, minted: minted });
}

// ---------- previews in the team channels ----------
// Discord keeps the preview it made for an address, so a post whose
// preview came out wrong — a photo stored on its side squashed into a
// landscape box, a video linked as the phone's own file — stays wrong
// after the file route is fixed. This goes back through the bot's own
// posts in one team's channel, newest first, and gives every proof link
// in them the current form (fileLink) at a new address, which makes
// Discord fetch each preview again. Nothing but the bot's messages is
// touched, and in them nothing but links to proof files that still
// exist. A page of a hundred messages and at most REFRESH_EDITS edits a
// request; `before` is where the next one carries on, null at the end.
var REFRESH_EDITS = 20;
var PROOF_LINK = /https?:\/\/[^\s<>()]+?\/api\/submit\/file\/(sub\/[^\s?#<>()]+)(\?[^\s<>()]*)?/g;
async function refreshPosts(env: Env, session: ConsoleSession, body: JsonBody, url: URL, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  if (!botConfigured(env)) return json({ error: 'The bot needs DISCORD_BOT_TOKEN on the worker to edit its posts.' }, 400);
  var guild = await guildConfig(db, env, cleanText(body.guild_id, 30));
  if (!guild) return json({ error: 'Pick a server that is set up in the dashboard.' }, 400);
  // new links are not new words: held, the run stops rather than logging
  // every edit
  if (guild.held) return json({ ok: true, edited: 0, checked: 0, before: null, halted: HELD_WHY, failed: [] });
  var team = await db.prepare('SELECT id, name FROM teams WHERE id = ?1').bind(Number(body.team_id) || 0).first<TeamRef>();
  if (!team) return json({ error: 'no such team' }, 404);
  var where = await db.prepare('SELECT channel_id FROM discord_teams WHERE guild_id = ?1 AND team_id = ?2')
    .bind(guild.guild_id, team.id).first<Pick<DiscordTeamRow, 'channel_id'>>();
  if (!where || !where.channel_id) return json({ ok: true, team: team.name, edited: 0, checked: 0, before: null, no_channel: true });
  var me = await botUser(env);
  if (!me) return json({ error: 'Could not reach Discord.' }, 502);
  var before = cleanText(body.before, 30);
  var page = await discordApi<DiscordMessage[]>(env, 'GET', '/channels/' + where.channel_id + '/messages?limit=100' +
    (/^\d{5,30}$/.test(before) ? '&before=' + before : ''));
  if (!page.ok) return json({ error: 'Could not read #' + team.name + '’s channel: ' + page.why }, 502);
  var list = page.data || [];
  var base = String(env.PUBLIC_API || url.origin).replace(/\/+$/, '');
  var mark = Date.now().toString(36);
  var edited = 0, checked = 0, failed: string[] = [], halted = '', next = list.length === 100 ? list[list.length - 1].id : null;
  for (var i = 0; i < list.length; i++) {
    var m = list[i];
    if (!m.author || m.author.id !== me.id || !m.content) continue;
    var found: string[] = [];
    m.content.replace(PROOF_LINK, function (all: string, path: string) { found.push(path); return all; });
    if (!found.length) continue;
    checked++;
    // the last part of the path is the name, the rest the file's key
    var keys = found.map(function (p) {
      var parts = p.split('/').map(function (s) { try { return decodeURIComponent(s); } catch (err) { return s; } });
      return parts.slice(0, -1).join('/');
    });
    var rows = (await db.prepare(
      'SELECT r2_key, name, content_type FROM submission_files WHERE r2_key IN (SELECT value FROM json_each(?1))'
    ).bind(JSON.stringify(keys)).all<Pick<SubmissionFileRow, 'r2_key' | 'name' | 'content_type'>>()).results;
    var byKey: Record<string, Pick<SubmissionFileRow, 'r2_key' | 'name' | 'content_type'>> = {};
    rows.forEach(function (r) { byKey[r.r2_key] = r; });
    var at = 0;
    var text = m.content.replace(PROOF_LINK, function (all: string) {
      var f = byKey[keys[at++]];
      return f ? fileLink(base, { key: f.r2_key, name: f.name, type: f.content_type }, mark) : all;
    });
    if (text === m.content || text.length > 2000) continue;
    var res = await discordApi(env, 'PATCH', '/channels/' + where.channel_id + '/messages/' + m.id,
      { content: text, allowed_mentions: { parse: [] } });
    // a refusal every edit after would meet too stops the run
    if (!res.ok && (res.status === 429 || res.status === 403)) { halted = res.why; break; }
    if (res.ok) edited++; else failed.push(res.why);
    if (edited >= REFRESH_EDITS) { next = i < list.length - 1 ? m.id : next; break; }
  }
  if (edited) await logAction(db, session.name, 'discord-refresh', team.name, edited + (edited === 1 ? ' post' : ' posts'), 0, 0, 0);
  return json({ ok: true, team: team.name, edited: edited, checked: checked, before: halted ? null : next, halted: halted, failed: failed });
}

// ---------- everyone on the server ----------
// The Discord tab's "Give every member a role". Each member holding no
// role but Legend, Unknown Team and the server's role for a signup not
// in a team yet (when its card names one) is matched by username, the
// way /verify matches: when one team's signup lists them they get that
// team's role (the team is set up first if it has none here yet) and
// Legend, and the other two come off; when their signups are not in a
// team yet they get the server's role for that, or Unknown Team where
// it names none; when no signup lists them, or two teams' do, they get
// Unknown Team — except somebody already holding the no-team role, which
// an organiser may have given by hand, who keeps it. A member with a
// team's role and no Legend gets Legend. Anybody holding any other role
// (the organiser role, and whatever else the server gives by hand) is
// left alone. Discord lists
// members a thousand at a time from a cursor and each change is one
// call, so a request makes at most SWEEP_CHANGES and hands back where it
// stopped; the page asks again until it says done. Listing members needs
// the bot's Server Members Intent.
var SWEEP_CHANGES = 10;
var SETUP_COST = 4;
async function sweepMembers(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var db = env.DB;
  var guild = await guildConfig(db, env, cleanText(body.guild_id, 30));
  if (!guild) return json({ error: 'Pick a server that is set up in the dashboard.' }, 400);
  var after = cleanText(body.after, 30);
  if (!/^\d{5,30}$/.test(after)) after = '';
  // A recheck only moves members holding nothing but Legend, Unknown
  // Team and the no-team role: to their team when their signup has since
  // been found on one, and from Unknown Team to the no-team role when it
  // turns out they signed up without a team. It tags nobody new and
  // leaves everyone else alone.
  var recheck = !!body.recheck;
  var known: Known = {};
  var gotLegend = await fixedRole(env, guild, 'legend', known);
  if ('error' in gotLegend) return json({ error: gotLegend.error }, 502);
  var legend = gotLegend;
  var gotUnknown = await fixedRole(env, guild, 'unknown', known);
  if ('error' in gotUnknown) return json({ error: gotUnknown.error }, 502);
  var unknown = gotUnknown;
  var noTeam = await noTeamRole(env, guild, known);
  if (noTeam && noTeam.id === legend.id) noTeam = null;
  var waitRoles = [legend.id, unknown.id].concat(noTeam ? [noTeam.id] : []);
  var page = await discordApi<DiscordMember[]>(env, 'GET', '/guilds/' + guild.guild_id + '/members?limit=1000' + (after ? '&after=' + after : ''));
  if (!page.ok) {
    return json({ error: 'Could not list the server\'s members: ' + page.why +
      (page.status === 403 ? ' Turn on Server Members Intent on the bot\'s page in the Discord developer portal.' : '') }, 502);
  }
  var members = page.data || [];
  var teamOfRole = await teamRoleIds(db, guild.guild_id, true);
  var roleOfTeam: Record<number, string> = {};
  Object.keys(teamOfRole).forEach(function (id) { roleOfTeam[teamOfRole[id]] = id; });
  // A signup on a hidden team, or a hidden signup with no team, is a
  // test: it gives nobody a role, and a member whose only signups are
  // tests is left alone rather than tagged Unknown Team.
  type Row = Pick<ParticipantRow, 'id' | 'discord' | 'team_id'> & { team_hidden: number; reg_hidden: number };
  var byHandle: Record<string, Row[]> = {};
  var testOnly: Record<string, boolean> = {};
  (await db.prepare(
    'SELECT p.id, p.discord, p.team_id, COALESCE(t.hidden, 0) AS team_hidden, COALESCE(r.hidden, 0) AS reg_hidden ' +
    'FROM participants p LEFT JOIN teams t ON t.id = p.team_id LEFT JOIN registrations r ON r.id = p.registration_id ' +
    "WHERE p.discord IS NOT NULL AND p.discord != ''"
  ).all<Row>()).results.forEach(function (p) {
    var k = normHandle(p.discord);
    if (p.team_hidden || (!p.team_id && p.reg_hidden)) { if (!byHandle[k]) testOnly[k] = true; return; }
    delete testOnly[k];
    (byHandle[k] = byHandle[k] || []).push(p);
  });

  function isTestOnly(user: Pick<DiscordUser, 'username' | 'discriminator'>): boolean {
    var a = normHandle(user.username);
    var b = user.discriminator && user.discriminator !== '0' ? normHandle(user.username + '#' + user.discriminator) : '';
    return !!((testOnly[a] || (b && testOnly[b])) && !byHandle[a] && !(b && byHandle[b]));
  }
  var out: { checked: number; team: number; noteam: number; unknown: number; legend: number; failed: string[] } = { checked: 0, team: 0, noteam: 0, unknown: 0, legend: 0, failed: [] };
  var spent = 0;
  var last = after;
  var stopped = false;
  var halted = false;
  for (var i = 0; i < members.length; i++) {
    if (spent >= SWEEP_CHANGES) { stopped = true; break; }
    var m = members[i];
    var user = (m.user || {}) as DiscordUser;
    var roles = (m.roles || []).slice();
    var own = roles.filter(function (id) { return waitRoles.indexOf(id) === -1; });
    var held = noTeam && roles.indexOf(noTeam.id) !== -1;
    var want: string[] | null = null;
    var kind: '' | 'team' | 'noteam' | 'unknown' | 'legend' = '';
    var signup: Row | null = null;
    var teamId = 0;
    if (user.bot) {
      // a bot is not taking part
    } else if (!own.length && isTestOnly(user)) {
      // only on a test signup
    } else if (!own.length) {
      var hits = (byHandle[normHandle(user.username)] || []).concat(user.discriminator && user.discriminator !== '0'
        ? byHandle[normHandle(user.username + '#' + user.discriminator)] || [] : []);
      var teams: Record<string, Row> = {};
      hits.forEach(function (p) { teams[p.team_id || 'none'] = p; });
      var keys = Object.keys(teams);
      if (keys.length === 1 && keys[0] !== 'none') {
        teamId = Number(keys[0]);
        signup = teams[keys[0]];
        if (!roleOfTeam[teamId]) {
          var team = await db.prepare('SELECT id, name FROM teams WHERE id = ?1').bind(teamId).first<TeamRef>();
          var made = team ? await ensureTeamSetup(env, guild, team, known) : { error: 'their team is no longer on the tab' };
          spent += SETUP_COST;
          if ('error' in made) { out.failed.push((user.username || user.id) + ': ' + made.error); teamId = 0; }
          else { roleOfTeam[teamId] = made.role_id; teamOfRole[made.role_id] = teamId; }
        }
      }
      var solo = keys.length === 1 && keys[0] === 'none';
      if (teamId) { want = [roleOfTeam[teamId], legend.id]; kind = 'team'; }
      else if (noTeam && solo && (!recheck || roles.indexOf(unknown.id) !== -1)) { want = [noTeam.id, legend.id]; kind = 'noteam'; }
      else if (!recheck && !held) { want = [unknown.id, legend.id]; kind = 'unknown'; }
    } else if (!recheck && own.every(function (id) { return teamOfRole[id]; })) {
      want = own.concat([legend.id]);
      kind = 'legend';
    }
    var same = want && want.length === roles.length && want.every(function (id) { return roles.indexOf(id) !== -1; });
    if (want && !same) {
      var res = await discordApi(env, 'PATCH', '/guilds/' + guild.guild_id + '/members/' + user.id, { roles: want });
      spent++;
      if (res.ok) {
        if (kind) out[kind]++;
        if (kind === 'team') {
          await db.prepare(
            'INSERT INTO discord_members (guild_id, user_id, username, participant_id, team_id, verified_at) ' +
            "VALUES (?1, ?2, ?3, ?4, ?5, datetime('now')) " +
            "ON CONFLICT(guild_id, user_id) DO UPDATE SET username = ?3, participant_id = ?4, team_id = ?5, verified_at = datetime('now')"
          ).bind(guild.guild_id, user.id, String(user.username || ''), (signup as Row).id, teamId).run();
        }
      } else if (res.status !== 404) {
        // the bot's own role under the ones it is handing out stops every change after this one too
        out.failed.push((user.username || user.id) + ': ' + res.why);
        if (res.status === 403 || out.failed.length >= 3) { stopped = halted = true; break; }
      }
    }
    out.checked++;
    last = user.id;
  }
  var finished = !stopped && members.length < 1000;
  if (out.team || out.noteam || out.unknown || out.legend) {
    await logAction(db, session.name, recheck ? 'discord-roles-recheck' : 'discord-roles-all', guild.name || guild.guild_id,
      out.team + ' team, ' + (noTeam ? out.noteam + ' no team, ' : '') + out.unknown + ' unknown, ' + out.legend + ' legend', 0, 0, 0);
  }
  return json({ ok: true, done: finished, halted: halted, after: last || '', checked: out.checked,
    team: out.team, noteam: out.noteam, unknown: out.unknown, legend: out.legend, failed: out.failed,
    legend_role: legend.name, unknown_role: unknown.name, no_team_role: noTeam ? noTeam.name : '' });
}

// ---------- leftovers ----------
// Roles and channels the bot made that no team uses: what a setup cut
// off part way left behind before each id was written down as it was
// made, and what it made for a team since hidden or deleted (a test
// set up before it was hidden). A role counts when it carries a team's
// role name, has no permissions of its own (as the bot makes them) and
// is not the organiser role or a managed one; a channel when it is in
// the team category and carries the topic the bot gives team channels.
// Nothing here picks a role for a team: they are listed for an
// organiser to look at, and deleted when they say so.
async function findLeftovers(env: Env, guild: DiscordGuildRow): Promise<Leftovers | { error: string }> {
  var db = env.DB;
  var mapped: Record<string, boolean> = {};
  var hiddenOf: Record<string, string> = {};
  var forget: { team_id: number; team: string }[] = [];
  var names: Record<string, boolean> = {};
  (await db.prepare(
    'SELECT d.team_id, d.role_id, d.channel_id, d.role_name, t.name AS team, t.hidden FROM discord_teams d ' +
    'LEFT JOIN teams t ON t.id = d.team_id WHERE d.guild_id = ?1'
  ).bind(guild.guild_id).all<Pick<DiscordTeamRow, 'team_id' | 'role_id' | 'channel_id' | 'role_name'> & { team: string | null; hidden: number | null }>()).results.forEach(function (r) {
    if (r.team == null || r.hidden) {
      forget.push({ team_id: r.team_id, team: r.team || '' });
      if (r.role_name) names[r.role_name] = true;
      if (r.role_id) hiddenOf[r.role_id] = r.team || '';
      if (r.channel_id) hiddenOf[r.channel_id] = r.team || '';
      return;
    }
    if (r.role_id) mapped[r.role_id] = true;
    if (r.channel_id) mapped[r.channel_id] = true;
  });
  (await db.prepare('SELECT name FROM teams').all<Pick<TeamRow, 'name'>>()).results.forEach(function (t) { names[roleNameFor(t.name)] = true; });
  var roles = await discordApi<DiscordRole[]>(env, 'GET', '/guilds/' + guild.guild_id + '/roles');
  if (!roles.ok) return { error: 'Could not list the server\'s roles: ' + roles.why };
  var channels = await discordApi<DiscordChannel[]>(env, 'GET', '/guilds/' + guild.guild_id + '/channels');
  if (!channels.ok) return { error: 'Could not list the server\'s channels: ' + channels.why };
  return {
    roles: (roles.data || []).filter(function (r) {
      return names[r.name] && !mapped[r.id] && r.id !== guild.guild_id && r.id !== guild.organiser_role_id &&
        !r.managed && String(r.permissions) === '0';
    }).map(function (r) { return { id: r.id, name: r.name, hidden: r.id in hiddenOf }; }),
    channels: (channels.data || []).filter(function (c) {
      return c.type === TEXT_CHANNEL && guild.category_id && c.parent_id === guild.category_id && !mapped[c.id] &&
        /^Private channel for team /.test(c.topic || '');
    }).map(function (c) { return { id: c.id, name: c.name, hidden: c.id in hiddenOf }; }),
    forget: forget
  };
}

async function leftovers(env: Env, url: URL): Promise<Response> {
  var guild = await guildConfig(env.DB, env, cleanText(url.searchParams.get('guild_id'), 30));
  if (!guild) return json({ error: 'Pick a server that is set up in the dashboard.' }, 400);
  var found = await findLeftovers(env, guild);
  if ('error' in found) return json({ error: found.error }, 502);
  return json({ ok: true, roles: found.roles, channels: found.channels,
    hidden_teams: found.forget.map(function (f) { return f.team; }).filter(Boolean) });
}

// Deletes what findLeftovers finds now, never ids sent from the page,
// twenty at a time; the page asks again until nothing is left.
var LEFTOVERS_PER_CALL = 20;
async function deleteLeftovers(env: Env, session: ConsoleSession, body: JsonBody, logAction: LogAction): Promise<Response> {
  var guild = await guildConfig(env.DB, env, cleanText(body.guild_id, 30));
  if (!guild) return json({ error: 'Pick a server that is set up in the dashboard.' }, 400);
  var found = await findLeftovers(env, guild);
  if ('error' in found) return json({ error: found.error }, 502);
  var leftover = found;
  var gid = guild.guild_id;
  var all = found.roles.map(function (r) { return { path: '/guilds/' + gid + '/roles/' + r.id, label: '@' + r.name }; })
    .concat(found.channels.map(function (c) { return { path: '/channels/' + c.id, label: '#' + c.name }; }));
  var batch = all.slice(0, LEFTOVERS_PER_CALL);
  var deleted = 0;
  for (var i = 0; i < batch.length; i++) {
    var res = await discordApi(env, 'DELETE', batch[i].path);
    if (!res.ok && res.status !== 404) return json({ error: 'Could not delete ' + batch[i].label + ': ' + res.why, deleted: deleted }, 502);
    deleted++;
  }
  // With its role and channel gone, a hidden or deleted team is
  // forgotten here, so nothing sets it up again from what was stored.
  var forgotten = 0;
  if (all.length === deleted && found.forget.length) {
    var writes: D1PreparedStatement[] = [];
    leftover.forget.forEach(function (f) {
      writes.push(env.DB.prepare('DELETE FROM discord_teams WHERE guild_id = ?1 AND team_id = ?2').bind(gid, f.team_id));
      writes.push(env.DB.prepare('DELETE FROM discord_members WHERE guild_id = ?1 AND team_id = ?2').bind(gid, f.team_id));
    });
    await env.DB.batch(writes);
    forgotten = found.forget.length;
  }
  if (deleted || forgotten) {
    await logAction(env.DB, session.name, 'discord-leftovers', guild.name || guild.guild_id,
      deleted + ' deleted' + (forgotten ? ', ' + forgotten + ' hidden teams forgotten' : ''), 0, 0, 0);
  }
  return json({ ok: true, deleted: deleted, forgotten: forgotten, left: all.length - deleted });
}

// ---------- router: /api/console/discord/* (session already checked) ----------

export async function handleDiscordConsole(request: Request, env: Env, session: ConsoleSession, action: string, body: JsonBody | null, url: URL, logAction: LogAction): Promise<Response | null> {
  var menus = await handleRoleMenuConsole(request, env, session, action, body || {}, url, logAction);
  if (menus) return menus;
  if (request.method === 'GET') {
    if (action === 'discord/status') return status(env);
    if (action === 'discord/guild') return guildDetail(env, url);
    if (action === 'discord/leftovers') return leftovers(env, url);
    return null;
  }
  var sent = body || {};
  if (action === 'discord/leftovers/delete') return deleteLeftovers(env, session, sent, logAction);
  if (action === 'discord/guild/save') return saveGuild(env, session, sent, logAction);
  if (action === 'discord/guild/delete') return deleteGuild(env, session, sent, logAction);
  if (action === 'discord/register') return registerCommands(env, session, sent, logAction);
  if (action === 'discord/post') return postMessage(env, session, sent, logAction);
  if (action === 'discord/hold') return setHold(env, session, sent, logAction);
  if (action === 'discord/setup') return setupTeams(env, session, sent, logAction);
  if (action === 'discord/team/save') return saveTeamDiscord(env, session, sent, logAction);
  if (action === 'discord/codes/send') return sendCode(env, session, sent, logAction);
  if (action === 'discord/refresh') return refreshPosts(env, session, sent, url, logAction);
  if (action === 'discord/roles/all') return sweepMembers(env, session, sent, logAction);
  return null;
}
