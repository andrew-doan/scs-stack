// SCS.2 tab bot — a Cloudflare Worker behind Discord's interactions
// endpoint. Discord POSTs every slash command here; we verify the
// request really came from Discord (Ed25519 signature), read or update
// the D1 scores database, and answer in the channel for everyone to
// see. No gateway connection, no long-lived process: requests only.
//
// Secrets live outside this file. DISCORD_PUBLIC_KEY arrives via
// `wrangler secret put`, the D1 binding via wrangler.toml.

// interaction types
var PING = 1;
var APPLICATION_COMMAND = 2;
var MESSAGE_COMPONENT = 3;
var AUTOCOMPLETE = 4;
// response types
var PONG = 1;
var MESSAGE = 4;
var AUTOCOMPLETE_RESULT = 8;

import { normQuest, json, corsJson, cleanText, configured, secretMatches, bearerToken, randomKey, readStamp, utcStamp, errorMessage, isLinkPreview } from './shared.ts';
import { fmtPts, fmtAmount, ordinal, standings, leaderboardText, lastPlace, placeRows, SUM_POINTS, showsPoints, NOT_QUESTS, bandsScore } from './tab.ts';
import { writeGuard, handleVerify, postToTeam, checkinText, holdPost, postsHeld } from './discord.ts';
import { isRoleMenu, handleRoleMenu } from './rolemenus.ts';
import { handleConsoleApi } from './console.ts';
import { recordPoints, tellTeam, teamTotal } from './points.ts';
import { partsFor, buildCredit } from './parts.ts';
import type { Part } from './parts.ts';
import { ledgerReady } from './ledger.ts';
import { handleSubmitApi, handleEncoderApi, requireTeam } from './submit.ts';
import { handleAlbumsApi, albumEdgeMark } from './albums.ts';
import { thumbBatch } from './thumbs.ts';
import { handleOriginalsApi } from './originals.ts';
import { viewerFor } from './access.ts';
import { handlePushApi } from './push.ts';
import { handleRegoApi, turnstileSiteKey, teamForCheckin, moveTeamCheckins } from './rego.ts';
import { handleQuestApi, releaseDue, mysteryIds, questListPayload } from './quests.ts';
import { pulsePayload, messagesPayload, publishDue, handleMessagesApi } from './messages.ts';
import { tabState, frozenPayload, closedPayload, FROZEN_PATHS } from './freeze.ts';
import { handleRecapApi, lastQuestUntil, dateRules, undatedBy } from './recap.ts';
import { countdownPayload } from './countdown.ts';
import { slidesPayload, handleSlidesApi } from './slides.ts';
import { handleEmbedApi } from './embed.ts';
import { handlePhoneStep, handlePhoneMessage, handlePhoneApi } from './phone.ts';
import { runSchedule, scheduleNote, logSchedule } from './schedule.ts';
import { handleShortLink, serveDropFile } from './drop.ts';
import { teamTally, standingsPayload, standingsPaths } from './tally.ts';
import { consolePage, spinnerPage } from './console-page.js';
import type { Credit, Ctx, DateRule, DiscordUser, Env, Interaction, InteractionOption, JsonBody, LeaderboardPayload, LeaderboardTeam, QuestRow, RenderPayload,
  StandingsPayload, TeamRow, Viewer } from './types.ts';
import type { TeamArrivalRow, TeamCheckinRow } from './types.ts';
import type { FreezeState, TabState } from './freeze.ts';

// A reply to a slash command: the words, with flags 64 when only whoever
// ran it sees them.
interface Reply {
  content: string;
  flags?: number;
  allowed_mentions?: { parse: string[] };
}
// What a command answers: words, a reply, or a whole interaction
// response (the deferred /verify).
type CommandReply = string | Reply | { type: number; data?: object };
// Whether a post into a channel went.
type Posted = { ok: true } | { ok: false; why: string };

function option(interaction: Interaction, name: string): unknown {
  var options = (interaction.data && interaction.data.options) || [];
  for (var i = 0; i < options.length; i++) {
    if (options[i].name === name) return options[i].value;
  }
  return undefined;
}

function likeSafe(text: unknown): string {
  return String(text).replace(/[%_\\]/g, ' ');
}

// ---------- database ----------

// Hidden teams (test runs) read as unknown everywhere public —
// Discord commands included. The console sees everything.
async function teamByName(db: D1Database, name: unknown): Promise<Pick<TeamRow, 'id' | 'name'> | null> {
  return db.prepare('SELECT id, name FROM teams WHERE name = ?1 COLLATE NOCASE AND hidden = 0')
    .bind(String(name).trim()).first<Pick<TeamRow, 'id' | 'name'>>();
}

async function questByCode(db: D1Database, code: unknown, publicOnly?: boolean): Promise<Pick<QuestRow, 'code' | 'points'> | null> {
  if (!publicOnly) {
    return db.prepare('SELECT code, points FROM quests WHERE norm = ?1')
      .bind(normQuest(code)).first<Pick<QuestRow, 'code' | 'points'>>();
  }
  return db.prepare(
    'SELECT q.code, q.points FROM quests q LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    "WHERE q.norm = ?1 AND q.hidden = 0 AND COALESCE(g.hidden, 0) = 0 AND COALESCE(g.visibility, 'everyone') = 'everyone'"
  ).bind(normQuest(code)).first<Pick<QuestRow, 'code' | 'points'>>();
}

// ---------- command handlers ----------

async function cmdScore(db: D1Database, interaction: Interaction): Promise<string> {
  var team = await teamByName(db, option(interaction, 'team'));
  if (!team) return unknownTeam(option(interaction, 'team'));
  var rows = await standings(db);
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].id === team.id) {
      var said = '**' + team.name + '** — ' + fmtPts(rows[i].pts) + ' points from ' +
        rows[i].quests_done + ' quest' + (rows[i].quests_done === 1 ? '' : 's');
      if (rows[i].dnf) return said + '. Did not finish.';
      // a team that finished has a place
      return said + ', sitting ' + ordinal(rows[i].rank as number) + ' of ' + lastPlace(rows) + '.';
    }
  }
  return unknownTeam(team.name);
}

async function cmdLeaderboard(db: D1Database, interaction: Interaction): Promise<string> {
  var place = String(option(interaction, 'place') || '').trim();
  var rows = await standings(db);

  var from = 1;
  var to = 10;
  var single = false;
  if (place !== '') {
    var range = place.match(/^(\d+)\s*-\s*(\d+)$/);
    var one = place.match(/^(\d+)$/);
    if (range) {
      from = parseInt(range[1], 10);
      to = parseInt(range[2], 10);
    } else if (one) {
      from = to = parseInt(one[1], 10);
      single = true;
    } else {
      return 'That place needs to be a number like `3`, or a range like `3-10`.';
    }
  }
  if (from < 1 || to < from) return 'That range runs backwards. Try something like `3-10`.';
  // places count the teams that finished; one that did not has none, but
  // the top of the board still shows it
  var last = lastPlace(rows);
  if (from > last && !(from === 1 && !single && rows.length)) {
    return 'The table only goes down to ' + ordinal(last) + ' right now.';
  }

  if (single) {
    var r = rows.filter(function (row) { return row.rank === from; })[0];
    return ordinal(from) + ' right now: **' + r.name + '** with ' + fmtPts(r.pts) + ' points.';
  }

  return leaderboardText(rows, from, to);
}

async function cmdQuest(db: D1Database, interaction: Interaction, organiser?: boolean): Promise<string> {
  var team = await teamByName(db, option(interaction, 'team'));
  if (!team) return unknownTeam(option(interaction, 'team'));
  var quest = await questByCode(db, option(interaction, 'quest'), !organiser);
  if (!quest) return unknownQuest(option(interaction, 'quest'));

  var row = await db.prepare(
    'SELECT c.amount, c.points, q.group_id, q.scoring FROM held c JOIN quests q ON q.code = c.quest_code WHERE c.team_id = ?1 AND c.quest_code = ?2'
  ).bind(team.id, quest.code).first<{ amount: number; points: number; group_id: number | null; scoring: string }>();

  if (!row) return 'No. The tab has nothing for ' + quest.code + ' from **' + team.name + '**.';
  if (row.amount === 0 && !row.points) {
    return 'No — ' + quest.code + ' is on the tab for **' + team.name + '**, but at 0 credit.';
  }
  // a part mark on a mystery quest: the amount would give its points away
  var shown = showsPoints((await mysteryIds(db))[String(row.group_id)], row.amount) && !bandsScore(row.scoring);
  var detail = !shown ? (bandsScore(row.scoring) ? '' : ' with part marks') : row.amount === 1 ? '' : ' ×' + fmtAmount(row.amount);
  return 'Yes — **' + team.name + '** has ' + quest.code + ' on the tab' + detail +
    ' (' + fmtPts(row.points) + ' points).';
}

async function cmdList(db: D1Database, interaction: Interaction, organiser?: boolean): Promise<string> {
  var team = await teamByName(db, option(interaction, 'team'));
  if (!team) return unknownTeam(option(interaction, 'team'));

  var visClause = organiser
    ? ''
    : "AND q.hidden = 0 AND COALESCE(g.hidden, 0) = 0 AND COALESCE(g.visibility, 'everyone') = 'everyone' " +
      'AND c.quest_code NOT IN (SELECT value FROM json_each(?2)) ';
  var stmt = db.prepare(
    'SELECT c.quest_code AS code, c.amount, c.points AS worth, q.group_id, q.scoring ' +
    'FROM held c JOIN quests q ON q.code = c.quest_code ' +
    'LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    'WHERE c.team_id = ?1 AND (c.amount != 0 OR c.points != 0) ' + visClause +
    'ORDER BY q.norm'
  );
  var res = await (organiser ? stmt.bind(team.id) : stmt.bind(team.id, JSON.stringify(NOT_QUESTS)))
    .all<{ code: string; amount: number; worth: number; group_id: number | null; scoring: string }>();
  var rows = res.results;

  if (!rows.length) return 'Nothing on the tab for **' + team.name + '** yet.';

  var mystery = await mysteryIds(db);
  var total = 0;
  var parts: string[] = [];
  for (var i = 0; i < rows.length; i++) {
    total += rows[i].worth;
    var shown = showsPoints(mystery[String(rows[i].group_id)], rows[i].amount) && !bandsScore(rows[i].scoring);
    parts.push(rows[i].code + (bandsScore(rows[i].scoring) ? '' : !shown ? ' (part marks)' : rows[i].amount === 1 ? '' : ' ×' + fmtAmount(rows[i].amount)));
  }
  var body = parts.join(', ');
  // stay well inside Discord's 2000-character message limit
  if (body.length > 1700) {
    var kept: string[] = [];
    var len = 0;
    for (var j = 0; j < parts.length && len + parts[j].length + 2 < 1650; j++) {
      kept.push(parts[j]);
      len += parts[j].length + 2;
    }
    body = kept.join(', ') + ' … and ' + (parts.length - kept.length) + ' more';
  }
  return '**' + team.name + '** — ' + rows.length + ' quest' + (rows.length === 1 ? '' : 's') +
    ', ' + fmtPts(total) + ' points\n' + body;
}

// Score changes, /post and channel: are organiser-only, and only from
// a server set up in the dashboard: writeGuard in discord.ts.

function actorName(interaction: Interaction): string {
  var user: Partial<DiscordUser> = (interaction.member && interaction.member.user) || interaction.user || {};
  return user.username || '';
}

// ---------- posting into other channels ----------
// Answering an interaction needs no credentials, but writing into a
// channel of our choosing is a plain REST call, and that needs the
// bot token — a worker secret (`wrangler secret put
// DISCORD_BOT_TOKEN`), never a file. Until it is set, these features
// refuse and explain; everything else works without it. The bot must
// also be invited with the `bot` scope and allowed to send messages
// in the target channel, or Discord answers 403 and we pass that on.

async function postToChannel(env: Env, channelId: unknown, content: string, keepMentions: boolean, guildId?: string): Promise<Posted> {
  var token = env.DISCORD_BOT_TOKEN || '';
  if (!configured(token)) {
    return { ok: false, why: 'Posting into channels is locked until DISCORD_BOT_TOKEN is set on the worker (see the README).' };
  }
  var payload: Reply = { content: content };
  // command output never pings anyone; /post is organiser-written, so
  // their mentions go through as typed
  if (!keepMentions) payload.allowed_mentions = { parse: [] };
  var held = await holdPost(env, 'POST', '/channels/' + channelId + '/messages', payload, guildId);
  if (held) return { ok: false, why: held.why };
  var resp: Response;
  try {
    resp = await fetch('https://discord.com/api/v10/channels/' + channelId + '/messages', {
      method: 'POST',
      headers: {
        'authorization': 'Bot ' + token,
        'content-type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
  } catch (err) {
    return { ok: false, why: 'Could not reach Discord. Try again in a moment.' };
  }
  if (resp.ok) return { ok: true };
  if (resp.status === 401 || resp.status === 403) {
    return { ok: false, why: 'The bot cannot post in that channel. It needs to be invited with the `bot` scope and allowed to send messages there.' };
  }
  if (resp.status === 404) return { ok: false, why: 'The bot cannot see that channel.' };
  return { ok: false, why: 'Discord refused the post (HTTP ' + resp.status + ').' };
}

// only the person who ran the command sees these
function ephemeral(text: string): Reply {
  return { content: text, flags: 64 };
}

// /post: the bot says something, somewhere, on an organiser's behalf.
async function cmdPost(interaction: Interaction, env: Env): Promise<Reply> {
  var denied = await writeGuard(interaction, env);
  if (denied) return ephemeral(denied);
  var channelId = option(interaction, 'channel');
  var message = String(option(interaction, 'message') || '')
    .replace(/\\n/g, '\n') // the input is one line; a typed \n becomes a real break
    .trim()
    .slice(0, 2000);
  if (!channelId) return ephemeral('Pick a channel to post in.');
  if (!message) return ephemeral('Nothing to post.');
  var sent = await postToChannel(env, channelId, message, true, interaction.guild_id);
  if (!sent.ok) return ephemeral(sent.why);
  return ephemeral('Posted in <#' + channelId + '>.');
}

// A channel: option on a read command sends the answer there instead
// — the leaderboard into a pinned leaderboard channel, say. Organiser
// only: it makes the bot speak in rooms of the runner's choosing.
async function maybeElsewhere(interaction: Interaction, env: Env, content: string): Promise<string | Reply> {
  var channelId = option(interaction, 'channel');
  if (!channelId) return content;
  var denied = await writeGuard(interaction, env);
  if (denied) return ephemeral(denied);
  var sent = await postToChannel(env, channelId, content, false, interaction.guild_id);
  if (!sent.ok) return ephemeral(sent.why);
  return ephemeral('Sent to <#' + channelId + '>.');
}

function logChange(db: D1Database, interaction: Interaction, action: string, team: Pick<TeamRow, 'name'>, quest: Pick<QuestRow, 'code'>, delta: number, oldTotal: number, newTotal: number): Promise<D1Result> {
  return db.prepare(
    'INSERT INTO submission_log (action, team_name, quest_code, points_delta, old_total, new_total, actor) ' +
    'VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)'
  ).bind(action, team.name, quest.code, delta, oldTotal, newTotal, actorName(interaction)).run();
}

// A score changed from Discord is recorded the way the dashboard's are:
// a submission row saying who and what, its line on the ledger in the
// same batch, and a line in the team's channel.
// Null when the code left the tab since it was read, and nothing was
// recorded.
async function changeAmount(db: D1Database, env: Env, ctx: Ctx, interaction: Interaction, team: Pick<TeamRow, 'id' | 'name'>, quest: Pick<QuestRow, 'code'>, credit: Credit): Promise<number | null> {
  if (!(await recordPoints(db, { teamId: team.id, quest: quest.code, credit: credit, by: 'discord:' + actorName(interaction) }))) return null;
  var total = await teamTotal(db, team.id);
  var told = tellTeam(env, '', { id: null, team_id: team.id, team_name: team.name },
    { verdict: credit.amount > 0 ? 'accepted' : 'adjusted', quest: quest.code, credit: credit, total: total });
  if (ctx && ctx.waitUntil) ctx.waitUntil(told); else await told;
  return total;
}

var BEHIND_DISCORD = 'The tab’s database is behind, so nothing was changed. An organiser needs to run npm run db:migrate in tab/.';

// A tiered code is worth the band its number reached, which a command
// has no way to give: it is recorded on the quest's desk.
function tieredRefusal(part: Part | undefined, code: string): string {
  return part && part.scoring === 'tiered'
    ? code + ' is scored by bands, so record it on its desk in the dashboard.' : '';
}

// What /submit credits: one of the code, read by the rules Accept reads
// a credit with (buildCredit), held to the same rules against what the
// team has already: a fixed or judged part is credited once and a per-unit
// part up to its most. A counted part's line is worth nothing and each
// one adds to its challenge's count, so it is recorded again. The credit,
// or why not.
function submitCredit(parts: Record<string, Part>, team: Pick<TeamRow, 'name'>, quest: Pick<QuestRow, 'code'>, had: number): { credit: Credit } | { refused: string } {
  var built = buildCredit(parts, [quest.code], { amount: 1 });
  if ('error' in built) return { refused: built.error };
  var part = parts[quest.code];
  var scoring = part ? part.scoring : '';
  if (scoring === 'unit') {
    if (part.most != null && had + 1 > part.most) {
      return { refused: quest.code + ' counts up to ' + part.most + ', and **' + team.name + '** has ' + fmtAmount(had) + '.' };
    }
  } else if (scoring !== 'counted' && had > 0) {
    return { refused: '**' + team.name + '** has ' + quest.code + ' already, and it is credited once. Make it per unit in the quest editor to count it.' };
  }
  return { credit: built.credit };
}

async function cmdSubmit(db: D1Database, interaction: Interaction, env: Env, ctx: Ctx): Promise<string> {
  var denied = await writeGuard(interaction, env);
  if (denied) return denied;
  var team = await teamByName(db, option(interaction, 'team'));
  if (!team) return unknownTeam(option(interaction, 'team'));
  var quest = await questByCode(db, option(interaction, 'quest'));
  if (!quest) return unknownQuest(option(interaction, 'quest'));

  var got = await Promise.all([
    db.prepare('SELECT amount FROM held WHERE team_id = ?1 AND quest_code = ?2').bind(team.id, quest.code).first<{ amount: number }>(),
    teamTotal(db, team.id),
    ledgerReady(db),
    partsFor(db, [quest.code])
  ]);
  var row = got[0], oldTotal = got[1], ready = got[2], parts = got[3];
  if (!ready) return BEHIND_DISCORD;
  var refused = tieredRefusal(parts[quest.code], quest.code);
  if (refused) return refused;
  var had = row ? Number(row.amount) || 0 : 0;
  var credit = submitCredit(parts, team, quest, had);
  if ('refused' in credit) return credit.refused;
  var next = had + 1;
  var total = await changeAmount(db, env, ctx, interaction, team, quest, credit.credit);
  if (total == null) return unknownQuest(quest.code);
  var gained = Math.round((total - oldTotal) * 100) / 100;
  var line = !row
    ? 'Recorded: ' + quest.code + ' for **' + team.name + '** (+' + fmtPts(gained) + ').'
    : quest.code + ' for **' + team.name + '** is now ×' + fmtAmount(next) + ' (+' + fmtPts(gained) + ').';
  await logChange(db, interaction, 'submit', team, quest, gained, oldTotal, total);
  return line + ' Total: ' + fmtPts(total) + '.';
}

async function cmdUnsubmit(db: D1Database, interaction: Interaction, env: Env, ctx: Ctx): Promise<string> {
  var denied = await writeGuard(interaction, env);
  if (denied) return denied;
  var team = await teamByName(db, option(interaction, 'team'));
  if (!team) return unknownTeam(option(interaction, 'team'));
  var quest = await questByCode(db, option(interaction, 'quest'));
  if (!quest) return unknownQuest(option(interaction, 'quest'));

  var row = await db.prepare(
    'SELECT amount FROM held WHERE team_id = ?1 AND quest_code = ?2'
  ).bind(team.id, quest.code).first<{ amount: number }>();
  if (!row || row.amount <= 0) {
    return 'Nothing to remove. The tab has no ' + quest.code + ' for **' + team.name + '**.';
  }
  var got = await Promise.all([teamTotal(db, team.id), ledgerReady(db), partsFor(db, [quest.code])]);
  var oldTotal = got[0], ready = got[1], part = got[2][quest.code];
  if (!ready) return BEHIND_DISCORD;
  var refused = tieredRefusal(part, quest.code);
  if (refused) return refused;
  // a counted part's count is its accepted submissions, which a line taken
  // off here would not lower
  if (part && part.scoring === 'counted') {
    return quest.code + ' counts towards its challenge, so take the submission back on the dashboard instead.';
  }
  var next = row.amount > 1 ? row.amount - 1 : 0;
  // taking one off cannot pass a part's most or credit it twice, and
  // buildCredit reads only counts above nothing, so the credit is the
  // amount that comes off
  var total = await changeAmount(db, env, ctx, interaction, team, quest, { codes: [quest.code], amount: next - row.amount });
  if (total == null) return unknownQuest(quest.code);
  var line = next > 0
    ? quest.code + ' for **' + team.name + '** is back to ×' + fmtAmount(next) + '.'
    : 'Removed: ' + quest.code + ' for **' + team.name + '**.';
  await logChange(db, interaction, 'unsubmit', team, quest, Math.round((total - oldTotal) * 100) / 100, oldTotal, total);
  return line + ' Total: ' + fmtPts(total) + '.';
}

function cmdHelp(): string {
  return [
    '**SCS.2 tab bot**',
    '',
    '`/score team`: that team’s total and where they sit',
    '`/leaderboard`: the top 10',
    '`/leaderboard 3`: whoever is third right now',
    '`/leaderboard 3-10`: that stretch of the table',
    '`/quest team quest`: has the team done a quest',
    '`/list team`: everything on the tab for a team',
    '`/submit team quest`: put a completion on the tab; run it again on a repeatable to count it up',
    '`/unsubmit team quest`: take one back off',
    '`/post channel message`: the bot posts your message in that channel (organisers; write \\n for a line break)',
    '`/verify`: link your Discord to your team signup: you get your team role and private channel',
    '',
    'Organisers can add `channel:` to /score, /leaderboard, /quest and /list to send the answer to another channel.',
    'Quest codes match the tab: SQ1, SQ1-10, MQ4. Case and spaces don’t matter.'
  ].join('\n');
}

function unknownTeam(name: unknown): string {
  return 'No team called “' + String(name).trim() + '” on the tab. Start typing and pick from the suggestions.';
}

function unknownQuest(code: unknown): string {
  return 'No quest “' + String(code).trim() + '” on the tab. Codes look like MQ2, S40, Make 21.';
}

// Discord asks the tab the same questions the website does, so the
// freeze and the closed tab have to reach it too. Organisers still get
// the live answer — they are the ones running the freeze, and the
// dashboard shows them the live tab anyway — but only they see it: a
// reply in a channel is read by everyone in it. Answers the state with
// whether the caller is an organiser, or null to read the tab as usual.
async function stoppedFor(interaction: Interaction, env: Env): Promise<(TabState & { organiser: boolean }) | null> {
  var state = await tabState(env.DB);
  if (!state.closed && !state.frozen) return null;
  return Object.assign(state, { organiser: (await writeGuard(interaction, env)) === null });
}

// The live answer for an organiser while the tab is stopped: to them
// alone, and never into a channel.
async function liveToOrganiser(interaction: Interaction, env: Env, state: TabState, answer: () => Promise<string>): Promise<Reply> {
  if (option(interaction, 'channel')) {
    return ephemeral('The tab is ' + (state.closed ? 'closed' : 'frozen') +
      ', so the live standings are not posted to a channel. Run it without channel: to see them yourself.');
  }
  return ephemeral(await answer());
}

function frozenNote(state: FreezeState): string {
  return 'The tab is frozen' + (state.frozen_at ? ' as at ' + state.frozen_at + ' UTC' : '') + '.';
}

// the board as it stood, straight from the copy — no live query
function frozenBoard(state: FreezeState, from: number, to: number): string {
  var board = state.snapshot['/api/leaderboard'];
  var teams: LeaderboardTeam[] = (board && board.teams) || [];
  if (!teams.length) return frozenNote(state) + ' Nothing was on it when it stopped.';
  var shown = placeRows(teams, from, Math.min(to, lastPlace(teams)));
  if (!shown.length) return frozenNote(state) + ' It only goes down to ' + ordinal(lastPlace(teams)) + '.';
  var lines = shown.map(function (t) {
    return t.dnf
      ? '**-** ' + t.name + ' — ' + fmtPts(t.points) + '\\*'
      : '**' + ordinal(t.rank as number) + '** ' + t.name + ' — ' + fmtPts(t.points);
  });
  var note = shown.some(function (t) { return t.dnf; }) ? '\n\\* Did not finish.' : '';
  return frozenNote(state) + '\n' + lines.join('\n') + note;
}

export async function runCommand(interaction: Interaction, env: Env, ctx: Ctx): Promise<CommandReply> {
  var db = env.DB;
  var name = interaction.data && interaction.data.name;
  if (name === 'verify') return handleVerify(interaction, env, ctx);

  if (name === 'score' || name === 'leaderboard' || name === 'quest' || name === 'list') {
    var halt = await stoppedFor(interaction, env);
    if (halt && halt.organiser) {
      return liveToOrganiser(interaction, env, halt, function () {
        if (name === 'score') return cmdScore(db, interaction);
        if (name === 'leaderboard') return cmdLeaderboard(db, interaction);
        if (name === 'quest') return cmdQuest(db, interaction, true);
        return cmdList(db, interaction, true);
      });
    }
    if (halt && halt.closed) {
      return maybeElsewhere(interaction, env, 'The tab is closed until the ceremony.');
    }
    var stopped = halt && halt.frozen;
    if (stopped) {
      if (name === 'leaderboard') {
        return maybeElsewhere(interaction, env, frozenBoard(stopped, 1, 10));
      }
      if (name === 'score') {
        var want = String(option(interaction, 'team') || '').trim().toLowerCase();
        var board = stopped.snapshot['/api/leaderboard'];
        var rows: LeaderboardTeam[] = (board && board.teams) || [];
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].name.toLowerCase() === want) {
            return maybeElsewhere(interaction, env, frozenNote(stopped) + ' **' + rows[i].name + '** ' +
              (rows[i].dnf ? 'did not finish, on ' : 'was ' + ordinal(rows[i].rank as number) + ' on ') +
              fmtPts(rows[i].points) + ' points.');
          }
        }
        return maybeElsewhere(interaction, env, frozenNote(stopped) + ' No team by that name was on it.');
      }
      // whether a team holds a quest, and what it has, is live
      // progress: both wait
      return maybeElsewhere(interaction, env,
        frozenNote(stopped) + ' This one answers again once the freeze lifts.');
    }
  }

  if (name === 'score') return maybeElsewhere(interaction, env, await cmdScore(db, interaction));
  if (name === 'leaderboard') return maybeElsewhere(interaction, env, await cmdLeaderboard(db, interaction));
  if (name === 'quest') return maybeElsewhere(interaction, env, await cmdQuest(db, interaction));
  if (name === 'list') return maybeElsewhere(interaction, env, await cmdList(db, interaction));
  if (name === 'submit') return cmdSubmit(db, interaction, env, ctx);
  if (name === 'unsubmit') return cmdUnsubmit(db, interaction, env, ctx);
  if (name === 'post') return cmdPost(interaction, env);
  if (name === 'help') return cmdHelp();
  return 'Unknown command.';
}

// ---------- autocomplete ----------

export async function autocompleteChoices(interaction: Interaction, db: D1Database): Promise<{ name: string; value: string }[]> {
  var options = (interaction.data && interaction.data.options) || [];
  var focused: InteractionOption | null = null;
  for (var i = 0; i < options.length; i++) {
    if (options[i].focused) { focused = options[i]; break; }
  }
  if (!focused) return [];
  var typed = likeSafe(focused.value || '').trim();

  if (focused.name === 'team') {
    var res = await db.prepare(
      "SELECT name FROM teams WHERE hidden = 0 AND name LIKE ?1 ESCAPE '\\' COLLATE NOCASE ORDER BY name COLLATE NOCASE LIMIT 25"
    ).bind('%' + typed + '%').all<Pick<TeamRow, 'name'>>();
    return res.results.map(function (r) { return { name: r.name, value: r.name }; });
  }
  if (focused.name === 'quest') {
    var norm = normQuest(typed);
    // /submit and /unsubmit are organisers' and offer every code; /quest
    // is anyone's and offers only the codes everyone can see
    var everyone = interaction.data && interaction.data.name === 'quest';
    var res2 = await db.prepare(
      'SELECT q.code FROM quests q LEFT JOIN quest_groups g ON g.id = q.group_id ' +
      "WHERE q.hidden = 0 AND q.norm LIKE ?1 ESCAPE '\\' " +
      (everyone ? "AND COALESCE(g.hidden, 0) = 0 AND COALESCE(g.visibility, 'everyone') = 'everyone' " : '') +
      'ORDER BY q.norm LIMIT 25'
    ).bind('%' + norm + '%').all<Pick<QuestRow, 'code'>>();
    return res2.results.map(function (r) { return { name: r.code, value: r.code }; });
  }
  return [];
}

// ---------- request verification and routing ----------

function hexToBytes(hex: string): Uint8Array {
  var bytes = new Uint8Array(hex.length / 2);
  for (var i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return bytes;
}

export async function verifySignature(request: Request, bodyText: string, publicKeyHex: string | null | undefined): Promise<boolean> {
  var signature = request.headers.get('x-signature-ed25519');
  var timestamp = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp || !publicKeyHex) return false;
  try {
    var key = await crypto.subtle.importKey(
      'raw', hexToBytes(publicKeyHex), { name: 'Ed25519' }, false, ['verify']
    );
    return await crypto.subtle.verify(
      'Ed25519', key, hexToBytes(signature),
      new TextEncoder().encode(timestamp + bodyText)
    );
  } catch (err) {
    return false;
  }
}

// ---------- HTTP API for the website ----------
// Same worker, same database as the Discord commands. Public read-only
// JSON with open CORS, cached briefly at the edge so a rush of quest
// page opens costs one query, not hundreds.

var API_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=0, s-maxage=30'
};
// The live tab asks every 10 seconds (/api/tab, the two others together;
// a page from before it asks for each), so these are kept for 10 rather
// than 30. A write purges them, but cache.delete only clears the copy in
// the data centre that took the write, and a phone served by another one
// sees the old copy until it expires.
var LIVE_PATHS = ['/api/tab', '/api/leaderboard', '/api/stats'];
var LIVE_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
  'cache-control': 'public, max-age=0, s-maxage=10'
};

// The quest each team last had scored, keyed by team id, for the live
// tab's Last scored column. One row per team, from the newest
// completion that earned something — SQLite takes the bare columns
// from the row MAX() picked, so this is one pass rather than a query
// per team. Only visible teams are on the board, so hidden ones fall
// out when the map is read. Nothing scored after the dashboard's cutoff
// counts (lastQuestUntil).
// Last scored is each team's newest accepted submission, by when it was
// sent (an organiser's entry by the time it is recorded for), and at or
// before the dashboard's cutoff when one is set. An award with no
// submission behind it (places, a wager, the EOI) is never shown, and
// nor is an entry that took points off or an adjustment (a credit that
// sets its own `points`). The cutoff picks what the
// column shows and nothing else: no score moves. A team with no such
// submission shows its newest completion instead, for scores from
// before every change was a submission row.
async function lastScored(db: D1Database): Promise<Record<number, { code: string; name: string; at: string }>> {
  var until = await lastQuestUntil(db);
  var sentAsk = db.prepare(
    'SELECT s.team_id AS team_id, MAX(s.submitted_at) AS at, ' +
    's.quest_code AS code, g.name AS name ' +
    'FROM submissions s JOIN quests q ON q.code = s.quest_code ' +
    'LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    "WHERE s.status = 'accepted' AND s.quest_code NOT IN (SELECT value FROM json_each(?1)) AND (?2 = '' OR s.submitted_at <= ?2) " +
    "AND NOT (s.added_by != '' AND (COALESCE(json_extract(s.credit, '$.amount'), 1) < 0 OR json_extract(s.credit, '$.points') IS NOT NULL)) " +
    'GROUP BY s.team_id'
  ).bind(JSON.stringify(NOT_QUESTS), until).all<{ team_id: number; at: string; code: string; name: string | null }>();
  var scoredAsk = db.prepare(
    'SELECT c.team_id AS team_id, MAX(c.updated_at) AS at, ' +
    'c.quest_code AS code, g.name AS name ' +
    'FROM held c JOIN quests q ON q.code = c.quest_code ' +
    'LEFT JOIN quest_groups g ON g.id = q.group_id ' +
    'WHERE c.amount > 0 AND c.quest_code NOT IN (SELECT value FROM json_each(?1)) AND (?2 = \'\' OR c.updated_at <= ?2) GROUP BY c.team_id'
  ).bind(JSON.stringify(NOT_QUESTS), until).all<{ team_id: number; at: string; code: string; name: string | null }>();
  var both = await Promise.all([sentAsk, scoredAsk]);
  var sent = both[0];
  var scored = both[1];
  var byTeam: Record<number, { code: string; name: string; at: string }> = {};
  sent.results.concat(scored.results).forEach(function (r) {
    if (!byTeam[r.team_id]) byTeam[r.team_id] = { code: r.code, name: r.name || r.code, at: r.at };
  });
  return byTeam;
}

// Every public read goes through here, and so does the freeze: while
// the tab is stopped these paths answer with the copy taken at that
// moment and the live tables are never asked. Putting the check here
// rather than in the routes means a new caller cannot forget it.
//
// viewer is a signed-in team (viewerFor) for the pulse and the
// messages, which are the two reads a team asks for its own copy of;
// null is the public answer.
export async function apiResponse(pathname: string, db: D1Database, onPublish?: (() => Promise<void>) | null, viewer?: Viewer): Promise<unknown> {
  // These two sit above the freeze on purpose. The freeze stops the
  // standings, not the organisers telling everyone something: the
  // pulse the site polls and the messages it polls for have to keep
  // answering from the live tables while the tab is stopped.
  //
  // They are also where a message written ahead of time goes up: the
  // site asking one of these two questions publishes anything due first,
  // and the payload is built after it, so the same request that
  // publishes a message already carries it. The once-a-minute scheduled
  // run (schedule.ts) publishes it when nobody is asking.
  if (pathname === '/api/pulse' || pathname === '/api/messages') {
    if (await publishDue(db)) { if (onPublish) await onPublish(); }
  }
  // A quest with an opening time goes to everyone the same way, ahead
  // of the pulse, so the version the page reads already counts it.
  if (pathname === '/api/pulse') {
    if (await releaseDue(db)) { if (onPublish) await onPublish(); }
  }
  if (pathname === '/api/pulse') return pulsePayload(db, viewer || null);
  if (pathname === '/api/messages') return messagesPayload(db, viewer || null);
  // The countdown is site chrome, not standings: it goes on answering
  // while the tab is frozen, and it is cached like every other public
  // read because the page has its own date to show until it arrives.
  if (pathname === '/api/countdown') return countdownPayload(db);
  // So are the home page's pictures: a slideshow of photographs is not
  // standings, so it goes on answering while the tab is frozen, and it
  // is cached like every other public read.
  if (pathname === '/api/slides') return slidesPayload(db);
  // The public quest list, kept at the edge like the rest. A quest with
  // an opening time goes to everyone first, as the pulse does it, so the
  // other cached reads are purged with it.
  if (pathname === '/api/questlist') {
    if (await releaseDue(db)) { if (onPublish) await onPublish(); }
    return questListPayload(db, null);
  }

  // The live tab's one poll: the board and the totals together, each
  // through the gate below, so a frozen or closed tab answers here too.
  // The gate and the date rules are read once for both, and the two are
  // built side by side.
  var both = pathname === '/api/tab';
  if (both || FROZEN_PATHS.indexOf(pathname) !== -1) {
    var gate = await tabState(db);
    var parts = both ? ['/api/leaderboard', '/api/stats'] : [pathname];
    var built: unknown[];
    if (gate.closed) {
      built = parts.map(function () { return closedPayload(); });
    } else {
      var frozen = gate.frozen;
      var answers = await Promise.all([dateRules(db) as Promise<unknown>].concat(parts.map(function (p) {
        return frozen ? Promise.resolve(frozenPayload(frozen, p)) : livePayload(p, db);
      })));
      // a time on a day the date rules match goes out without its date
      var rules = answers[0] as DateRule[];
      built = answers.slice(1).map(function (b) { return undatedBy(rules, b); });
    }
    return both ? { leaderboard: built[0], stats: built[1] } : built[0];
  }
  return null;
}

// The three standings payloads from the live tables, whatever the
// freeze says. The public reads above come here only while the tab is
// live and open; a freeze and a saved copy ask for them directly, since
// a copy saved while the tab is frozen is of the tab, not of the copy.
export function livePayload(pathname: '/api/leaderboard', db: D1Database): Promise<LeaderboardPayload>;
export function livePayload(pathname: string, db: D1Database): Promise<StandingsPayload | null>;
export async function livePayload(pathname: string, db: D1Database): Promise<StandingsPayload | null> {
  if (pathname === '/api/leaderboard') {
    var board = await Promise.all([standings(db), lastScored(db)]);
    var rows = board[0];
    var last = board[1];
    return {
      teams: rows.map(function (r) {
        return {
          id: r.id,
          rank: r.rank,
          dnf: r.dnf,
          name: r.name,
          points: Math.round(r.pts * 100) / 100,
          quests_done: r.quests_done,
          last_quest: last[r.id] || null
        };
      })
    };
  }

  if (pathname === '/api/quests') {
    var qRes = await Promise.all([
      db.prepare('SELECT COUNT(*) AS n FROM teams WHERE hidden = 0').first<{ n: number }>(),
      db.prepare(
        'SELECT q.code, q.points, q.group_id, g.key AS group_key, ' +
        'COUNT(CASE WHEN c.amount > 0 AND t.hidden = 0 THEN 1 END) AS teams_done ' +
        'FROM quests q ' +
        'LEFT JOIN quest_groups g ON g.id = q.group_id ' +
        'LEFT JOIN held c ON c.quest_code = q.code ' +
        'LEFT JOIN teams t ON t.id = c.team_id ' +
        // only what anyone may see: a quest shown to some teams has no
        // public numbers, which would say it exists
        "WHERE q.hidden = 0 AND COALESCE(g.hidden, 0) = 0 AND COALESCE(g.visibility, 'everyone') = 'everyone' " +
        'GROUP BY q.code ORDER BY q.norm'
      ).all<{ code: string; points: number; group_id: number | null; group_key: string | null; teams_done: number }>(),
      // a quest with tiers counts a team once, whichever tier it holds
      db.prepare(
        'SELECT g.key, COUNT(DISTINCT c.team_id) AS teams_done ' +
        'FROM quest_groups g JOIN quests q ON q.group_id = g.id ' +
        'JOIN held c ON c.quest_code = q.code AND c.amount > 0 ' +
        'JOIN teams t ON t.id = c.team_id AND t.hidden = 0 ' +
        "WHERE g.hidden = 0 AND g.visibility = 'everyone' GROUP BY g.id"
      ).all<{ key: string; teams_done: number }>(),
      mysteryIds(db)
    ]);
    var totalRow = qRes[0] as { n: number };
    var res = qRes[1];
    var byGroup = qRes[2];
    var mystery = qRes[3];
    var groups: Record<string, number> = {};
    byGroup.results.forEach(function (r) { groups[r.key] = r.teams_done; });
    return {
      total_teams: totalRow.n,
      quests: res.results.map(function (r) {
        return { code: r.code, points: mystery[String(r.group_id)] ? null : r.points, group: r.group_key || null, teams_done: r.teams_done };
      }),
      groups: groups
    };
  }

  if (pathname === '/api/stats') {
    var sRes = await Promise.all([
      db.prepare(
        'SELECT (SELECT COUNT(*) FROM teams WHERE hidden = 0) AS teams, ' +
        'COUNT(CASE WHEN c.amount > 0 THEN 1 END) AS completions, ' +
        SUM_POINTS + ' AS points ' +
        'FROM held c JOIN quests q ON q.code = c.quest_code ' +
        'JOIN teams t ON t.id = c.team_id WHERE t.hidden = 0'
      ).first<{ teams: number; completions: number; points: number }>(),
      // submissions the review queue has not reached, so the tab can say
      // what it is not showing yet; hidden teams are left out like every
      // other public number
      db.prepare(
        'SELECT COUNT(*) AS n FROM submissions s JOIN teams t ON t.id = s.team_id ' +
        "WHERE s.status IN ('pending', 'queued') AND t.hidden = 0"
      ).first<{ n: number }>()
    ]);
    var agg = sRes[0] as { teams: number; completions: number; points: number };
    var waiting = sRes[1];
    return {
      total_teams: agg.teams,
      total_completions: agg.completions,
      total_points: Math.round(agg.points * 100) / 100,
      submissions_pending: (waiting && waiting.n) || 0
    };
  }

  return null;
}

// The Cache API keeps hot reads (a room full of phones on the live
// tab) off D1: 30 seconds per response, 10 for the live tab's own two,
// purged early when a score changes. On workers.dev the cache is a no-op — the custom domain is
// where this earns its keep.
function edgeCache(): Cache | null {
  return (typeof caches !== 'undefined' && caches.default) ? caches.default : null;
}

// Each cached answer carries a weak ETag, a hash of its body, so a
// device that already has it is answered 304 with no body. The pages
// fetch with cache: 'no-cache', which has the browser send the tag it
// holds and hand the page its stored copy on a 304; a header the page
// set itself would make every request cross-origin preflighted. Weak,
// because Cloudflare turns a strong tag weak when it compresses.
async function bodyTag(text: string): Promise<string> {
  var digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  var hex = Array.prototype.map.call(new Uint8Array(digest).subarray(0, 12), function (b: number) {
    return (b < 16 ? '0' : '') + b.toString(16);
  }).join('');
  return 'W/"' + hex + '"';
}

// If-None-Match against a tag, compared weakly as the header is.
export function tagMatches(header: string | null, tag: string | null): boolean {
  if (!header || !tag) return false;
  var bare = tag.replace(/^W\//, '');
  return header.split(',').some(function (one) {
    var t = one.trim();
    return t === '*' || t.replace(/^W\//, '') === bare;
  });
}

// What a cached read answers: 304 when the device holds this body
// already, else the body with its tag. The 304 carries the cache and
// CORS headers, which the browser checks against the stored copy.
function tagged(request: Request, resp: Response): Response {
  var tag = resp.headers.get('etag');
  if (resp.status !== 200 || !tagMatches(request.headers.get('if-none-match'), tag)) return resp;
  var head = new Headers();
  ['etag', 'cache-control', 'access-control-allow-origin', 'x-robots-tag'].forEach(function (name) {
    var v = resp.headers.get(name);
    if (v) head.set(name, v);
  });
  return new Response(null, { status: 304, headers: head });
}

async function taggedJson(payload: unknown, headers: Record<string, string>): Promise<Response> {
  var text = JSON.stringify(payload);
  return new Response(text, { headers: Object.assign({ etag: await bodyTag(text) }, headers) });
}

// ---------- the file endpoints, kept at the edge ----------
// A thumbnail, a viewing copy or a slideshow picture is the same bytes
// for everyone who asks by that address, and the routes answer it
// public and immutable, so each data centre keeps the first answer and
// the next asks reach neither D1 nor R2. Only a plain ask is kept: not
// a range (a video), not a link preview (which gets the full picture, or
// the upright copy, under the same address), not a person opening the
// address (who gets the file's page), and not the original, the file as
// picked or a download, which go to some and not others. The routes say
// Vary: Sec-Fetch-Dest, which the edge cache does not honour, hence the
// page check here. Kept an hour at the edge, so a file deleted is gone
// from it within the hour; the browser's own copy keeps its year.
var EDGE_FILE_PATHS = /^\/api\/(submit|albums|slides|messages|quests)\/file(\/|$)/;
var EDGE_FILE_MAX = 10 * 1024 * 1024;
var EDGE_FILE_SECONDS = 3600;

export function edgeFileAsk(request: Request, url: URL): boolean {
  if (request.method !== 'GET' || !EDGE_FILE_PATHS.test(url.pathname)) return false;
  if (request.headers.get('range') || isLinkPreview(request)) return false;
  var dest = request.headers.get('sec-fetch-dest');
  if (dest ? dest === 'document' || dest === 'iframe' : /text\/html/i.test(request.headers.get('accept') || '')) return false;
  return !['orig', 'picked', 'download', 'uploaded'].some(function (p) { return url.searchParams.has(p); });
}

// `mark` is what else the answer depends on (albumEdgeMark), kept in the
// key beside the address.
async function edgeFile(request: Request, ctx: Ctx, mark: string, serve: () => Promise<Response>): Promise<Response> {
  var cache = edgeCache();
  if (!cache) return serve();
  var keyed = new URL(request.url);
  if (mark) keyed.searchParams.set('__edge', mark);
  var address = keyed.toString();
  var hit = await cache.match(address);
  if (hit) {
    var shown = new Headers(hit.headers);
    shown.set('cache-control', (shown.get('cache-control') || '').replace(/, s-maxage=\d+$/, ''));
    return new Response(hit.body, { status: hit.status, headers: shown });
  }
  var resp = await serve();
  var cc = resp.headers.get('cache-control') || '';
  var length = resp.headers.get('content-length');
  var keep = resp.status === 200 && !!resp.body && /\bpublic\b/.test(cc) && /\bimmutable\b/.test(cc) &&
    length !== null && Number(length) <= EDGE_FILE_MAX && !resp.headers.has('content-range');
  if (!keep) return resp;
  var copy = resp.clone();
  var head = new Headers(copy.headers);
  head.set('cache-control', cc + ', s-maxage=' + EDGE_FILE_SECONDS);
  var put = cache.put(address, new Response(copy.body, { status: 200, headers: head }));
  if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
  return resp;
}

// The dashboard's page and the spinner's, built once per isolate with
// their tag. The page is the same for everyone and holds no session (the
// token is in the browser's storage), so a browser keeps it and asks
// each time whether it changed: a reopen is a 304 rather than the whole
// page. The key covers the two values the worker fills in.
var dashPages: Record<string, { html: string; tag: string }> = {};
async function dashPage(request: Request, key: string, build: () => string): Promise<Response> {
  var page = dashPages[key];
  if (!page) {
    var html = build();
    page = dashPages[key] = { html: html, tag: await bodyTag(html) };
  }
  return tagged(request, new Response(page.html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'x-robots-tag': 'noindex',
      'cache-control': 'private, no-cache',
      etag: page.tag
    }
  }));
}

// Keyed by the address alone (/api/questlist?v=N is a copy of its own),
// never by the request's conditional headers.
async function cachedApi(request: Request, env: Env, ctx: Ctx, pathname: string): Promise<Response> {
  var cache = edgeCache();
  // no answer here reads the query but the quest list's version, so any
  // other query is the same copy and not a build of its own
  var asked = new URL(request.url);
  var origin = asked.origin;
  var version = pathname === '/api/questlist' ? asked.searchParams.get('v') : null;
  var address = origin + pathname + (version ? '?v=' + encodeURIComponent(version) : '');
  if (cache) {
    var hit = await cache.match(address);
    if (hit) return tagged(request, hit);
  }
  // publishing a scheduled message changes what every cached public
  // read says, so the copies go before this response is stored
  var payload = await apiResponse(pathname, env.DB, function () { return purgeApiCache(env, origin); });
  if (!payload) {
    return new Response(JSON.stringify({ error: 'not found' }), { status: 404, headers: API_HEADERS });
  }
  var resp = await taggedJson(payload, LIVE_PATHS.indexOf(pathname) !== -1 ? LIVE_HEADERS : API_HEADERS);
  if (cache) {
    var stored = resp.clone();
    if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(address, stored));
    else await cache.put(address, stored);
  }
  return tagged(request, resp);
}

// A challenge's standings for the quest page (tally.ts), kept at the
// edge like the live tab's two reads. The copy is kept under the address
// alone, so a team's session never decides what somebody else is
// served: only an answer that is the same for every reader is kept, and
// one for a quest only some teams see goes to that team and nobody else.
async function cachedStandings(request: Request, env: Env, ctx: Ctx, url: URL): Promise<Response> {
  var cache = edgeCache();
  var asked = normQuest(url.searchParams.get('quest') || '');
  var address = asked ? url.origin + url.pathname + '?quest=' + encodeURIComponent(asked) : '';
  if (cache && address) {
    var hit = await cache.match(address);
    if (hit) return tagged(request, hit);
  }
  var team = await requireTeam(request, env.DB);
  var out = await standingsPayload(env.DB, url.searchParams.get('quest'), team ? team.team_id : 0);
  var keep = out.status === 200 && out.everyone;
  var resp = keep
    ? await taggedJson(out.body, LIVE_HEADERS)
    : corsJson(out.body, out.status, { 'cache-control': 'private, no-store' });
  if (cache && keep) {
    var storeKey = url.origin + url.pathname + '?quest=' + encodeURIComponent(out.key || asked);
    var stored = resp.clone();
    if (ctx && ctx.waitUntil) ctx.waitUntil(cache.put(storeKey, stored));
    else await cache.put(storeKey, stored);
  }
  return keep ? tagged(request, resp) : resp;
}

// A signed-in team's own pulse and messages: what the public reads say
// plus the messages that team may read. Never cached, since they are
// the team's; a session the worker does not know is a bare 401, and the
// site asks the public read instead.
var TEAM_READS: Record<string, string> = { '/api/pulse/team': '/api/pulse', '/api/messages/team': '/api/messages' };

async function teamRead(request: Request, env: Env, pathname: string): Promise<Response> {
  var team = await requireTeam(request, env.DB);
  var head = { 'cache-control': 'private, no-store' };
  if (!team) return corsJson({ error: 'not signed in' }, 401, head);
  var origin = new URL(request.url).origin;
  var payload = await apiResponse(TEAM_READS[pathname], env.DB,
    function () { return purgeApiCache(env, origin); }, await viewerFor(env.DB, team.team_id));
  return corsJson(payload, 200, head);
}

// Every hostname a cached public read might be sitting under: the one
// this request came in on and the one the site uses. The edge cache is keyed by the whole URL, so a
// copy stored under one hostname is invisible to a purge aimed at
// another — and since the dashboard has a hostname of its own now, a
// score set there would have purged nothing the site reads and sat
// stale on the tab for the full 30 seconds.
function purgeOrigins(env: Env, origin: string): string[] {
  var list = [String(origin || '').replace(/\/+$/, '')];
  var site = String(env.PUBLIC_API || '').trim().replace(/\/+$/, '');
  if (site && list.indexOf(site) === -1) list.push(site);
  return list.filter(Boolean);
}

async function purgeApiCache(env: Env, origin: string): Promise<void> {
  var cache = edgeCache();
  if (!cache) return;
  var paths = [
    '/api/tab', '/api/leaderboard', '/api/quests', '/api/stats', '/api/questlist',
    '/api/pulse', '/api/messages', '/api/countdown', '/api/slides'
  ].concat(await standingsPaths(env.DB));
  var jobs: Promise<boolean>[] = [];
  var edge = cache;
  purgeOrigins(env, origin).forEach(function (base) {
    paths.forEach(function (path) { jobs.push(edge.delete(base + path)); });
  });
  await Promise.all(jobs);
}

// ---------- check-in reports ----------
// The check-in worker (its own worker, database and secrets) calls
// this when a team's last member arrives — or, after an undo over
// there, when a team stops being complete. The shared TAB_SYNC_KEY is
// the whole trust model: only something holding it can write here,
// and until the secret is set on this worker the endpoint is locked.

// How many of a team are in and when the last arrived, for the team
// page while the team is not complete. `last_at` is the check-in
// worker's own latest time; an older worker sends none, and then an
// arrival is stamped now and a departure leaves the time as it was.
async function noteArrival(db: D1Database, teamName: string, body: JsonBody): Promise<void> {
  var n = Math.max(0, Math.min(1000, Math.round(Number(body.checked_in) || 0)));
  var people = Math.max(0, Math.min(1000, Math.round(Number(body.people) || 0)));
  var at = readStamp(body.last_at) || (body.event === 'in' ? utcStamp() : '');
  if (!n) {
    await db.prepare('DELETE FROM team_arrivals WHERE team_name = ?1 COLLATE NOCASE').bind(teamName).run();
  } else if (at) {
    await db.prepare(
      'INSERT INTO team_arrivals (team_name, last_at, checked_in, people) VALUES (?1, ?2, ?3, ?4) ' +
      'ON CONFLICT(team_name) DO UPDATE SET last_at = ?2, checked_in = ?3, people = ?4'
    ).bind(teamName, at, n, people).run();
  } else {
    await db.prepare('UPDATE team_arrivals SET checked_in = ?2, people = ?3 WHERE team_name = ?1 COLLATE NOCASE')
      .bind(teamName, n, people).run();
  }
}

// The latest time the tab holds from the check-in worker for a team
// (when it was complete, or when the last of those in arrived) and how
// many were in by then. Found the way moveTeamCheckins and the team page
// find the rows, by name ignoring case.
async function lastReported(db: D1Database, teamName: string): Promise<{ at: string; checked_in: number }> {
  var latest = { at: '', checked_in: 0 };
  var done = await db.prepare('SELECT completed_at, people FROM team_checkins WHERE team_name = ?1 COLLATE NOCASE')
    .bind(teamName).first<Pick<TeamCheckinRow, 'completed_at' | 'people'>>();
  if (done) latest = { at: readStamp(done.completed_at) || '', checked_in: Number(done.people) || 0 };
  var part = await db.prepare('SELECT last_at, checked_in FROM team_arrivals WHERE team_name = ?1 COLLATE NOCASE')
    .bind(teamName).first<Pick<TeamArrivalRow, 'last_at' | 'checked_in'>>();
  var at = part ? readStamp(part.last_at) || '' : '';
  if (part && at > latest.at) latest = { at: at, checked_in: Number(part.checked_in) || 0 };
  else if (part && at && at === latest.at) latest.checked_in = Math.max(latest.checked_in, Number(part.checked_in) || 0);
  return latest;
}

export async function handleTeamCheckin(request: Request, env: Env, ctx: Ctx): Promise<Response> {
  if (!configured(env.TAB_SYNC_KEY) || !(await secretMatches(bearerToken(request), env.TAB_SYNC_KEY))) {
    return json({ error: 'not allowed' }, 401);
  }
  var body: JsonBody;
  try { body = await request.json<JsonBody>(); } catch (err) { return json({ error: 'body must be JSON' }, 400); }
  var reported = cleanText(body.team_name, 80);
  if (!reported) return json({ error: 'team_name is required' }, 400);
  // Check-in stores a name without <>&"'`, so the tab's team is found by
  // its name as check-in would store it, and everything is kept under
  // the tab's own spelling, which is what the team page and the recap
  // read. Rows kept under check-in's spelling before that are moved.
  var team = await teamForCheckin(env.DB, reported);
  var teamName = team ? team.name : reported;
  if (team && reported.toLowerCase() !== team.name.toLowerCase()) await moveTeamCheckins(env.DB, reported, team.name);
  // hidden teams (test runs) get no lines in Discord
  var known = team && !team.hidden ? team : null;

  // Reports are separate requests and can arrive out of order: a "2 of
  // 3" landing after "3 of 3" would take the team's completion away. A
  // report carries when its change happened (`at`; an arrival's own
  // time is its `last_at`, for a check-in worker that sends no `at`),
  // and one older than what the tab already has changes nothing here.
  // The times are whole seconds, so two reports can carry the same one:
  // then the one with more people in is the later.
  var when = readStamp(body.at) || (body.event === 'in' ? readStamp(body.last_at) || '' : '');
  var latest = when ? await lastReported(env.DB, teamName) : { at: '', checked_in: 0 };
  var inNow = Math.max(0, Math.round(Number(body.checked_in) || 0));
  var stale = !!(when && latest.at && (when < latest.at || (when === latest.at && inNow < latest.checked_in)));

  if (stale) {
    // the line below still goes: the person did check in or out
  } else if (body.completed_at) {
    var at = String(body.completed_at).slice(0, 32);
    var people = Math.max(0, Math.min(1000, Math.round(Number(body.people) || 0)));
    await env.DB.prepare(
      'INSERT INTO team_checkins (team_name, completed_at, people) VALUES (?1, ?2, ?3) ' +
      'ON CONFLICT(team_name) DO UPDATE SET completed_at = ?2, people = ?3'
    ).bind(teamName, at, people).run();
  } else {
    // the team stopped being complete: take the row back out
    await env.DB.prepare('DELETE FROM team_checkins WHERE team_name = ?1 COLLATE NOCASE').bind(teamName).run();
  }
  if (!stale) await noteArrival(env.DB, teamName, body);
  // the person it was about, in the team's own Discord channel
  var person = cleanText(body.person, 80);
  if (known && person && (body.event === 'in' || body.event === 'out')) {
    var line = checkinText({
      person: person, event: body.event as string, complete: !!body.completed_at,
      checked_in: Math.max(0, Math.round(Number(body.checked_in) || 0)),
      people: Math.max(0, Math.round(Number(body.people) || 0))
    });
    var told = postToTeam(env, known.id, function () { return line; });
    if (ctx && ctx.waitUntil) ctx.waitUntil(told); else await told;
  }
  return json({ ok: true, team_name: teamName, matched_tab_team: !!team, stale: stale });
}

export default {
  // The Cron Trigger, once a minute (wrangler.toml `[triggers]`). It is
  // the floor under everything the site polling used to be the only
  // clock for: a message written for 3am, the rest of an announcement
  // that did not fit in one request, a ticket email that failed. The
  // work goes in waitUntil so a slow push cannot hold the tick open,
  // and nothing in it may throw — there is nobody here to see it.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    var origin = String(env.PUBLIC_API || '').replace(/\/+$/, '');
    var job = (async function () {
      try {
        // livePayload's own overloads
        var out = await runSchedule(env, function () { return purgeApiCache(env, origin); },
          (function (path: string) { return livePayload(path, env.DB); }) as RenderPayload);
        var note = scheduleNote(out);
        if (note) await logSchedule(env.DB, note); // a quiet minute writes nothing
      } catch (err) { /* the next minute tries again */ }
    }());
    if (ctx && ctx.waitUntil) ctx.waitUntil(job);
    else await job;
  },

  // Unhandled exceptions become a JSON 500. The dashboard's own paths
  // name the cause, and so does every path when the cause is the
  // database being behind the code — "no such column: hidden" in a
  // response beats an opaque 1101 in the logs for the
  // deploy-before-migrate mistake, and names nothing that is not in the
  // repo. Anything else on a path the public reads says only that it
  // failed and a reference the worker's log carries with the cause.
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      var self = this;
      var asked = new URL(request.url);
      // many thumbnails in one answer, each through this same fetch
      if (request.method === 'GET' && asked.pathname === '/api/thumbs') {
        return await thumbBatch(asked, function (inner) { return self.fetch(inner, env, ctx); });
      }
      if (edgeFileAsk(request, asked)) {
        var mark = asked.pathname.indexOf('/api/albums/file') === 0 ? await albumEdgeMark(env.DB, asked) : '';
        return await edgeFile(request, ctx, mark, function () { return self.route(request, env, ctx); });
      }
      return await this.route(request, env, ctx);
    } catch (err) {
      var message = errorMessage(err);
      var cause = message ? String(message) : String(err);
      var path = new URL(request.url).pathname;
      var ref = randomKey(6);
      console.error('worker error ' + ref + ' on ' + path + ': ' + cause);
      var behind = /no such (column|table)/.test(cause);
      var organiser = path.indexOf('/api/console/') === 0 || path === '/dash';
      return new Response(JSON.stringify({
        error: organiser || behind
          ? 'worker error: ' + cause +
            (behind ? ' — the database is behind the code: run npm run db:migrate in the tab folder' : '')
          : 'Something went wrong on our side. Try again in a minute. (ref ' + ref + ')'
      }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
      });
    }
  },

  async route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-methods': 'GET, POST, PUT, OPTIONS',
          'access-control-allow-headers': 'content-type, authorization',
          'access-control-max-age': '86400'
        }
      });
    }

    var url = new URL(request.url);

    // go.<domain>/<slug>: one hostname that is nothing but short links.
    // It answers before anything else because on that hostname nothing
    // else exists — no API, no dashboard, no Discord endpoint.
    var shortResp = await handleShortLink(request, env, ctx, url);
    if (shortResp) return shortResp;

    // a file OrgComm dropped in, by its key, with its name on the end
    // of the path so an unfurler can see what it is
    var drop = url.pathname.match(/^\/api\/drop\/(drop\/[A-Za-z0-9_-]+)\/([^/]+)$/);
    if (drop && request.method === 'GET') {
      return serveDropFile(env, request, drop[1], decodeURIComponent(drop[2]));
    }

    // the dashboard: its page, and its own authed API (never edge
    // cached, so it routes before the public cached reads). The page is
    // at /dash; /console is where it used to be and still answers, as a
    // redirect, because organisers have it bookmarked. The API paths
    // keep the /api/console/ prefix — they are not a URL anyone types.
    if (request.method === 'GET' && (url.pathname === '/dash' || url.pathname === '/dash/')) {
      return dashPage(request, 'dash|' + turnstileSiteKey(env) + '|' + (env.PUBLIC_API || ''), function () {
        return consolePage(turnstileSiteKey(env), env.PUBLIC_API);
      });
    }
    if (request.method === 'GET' && url.pathname === '/dash/spinner') {
      return dashPage(request, 'spinner', spinnerPage);
    }
    if (request.method === 'GET' && (url.pathname === '/console' || url.pathname === '/console/')) {
      return new Response(null, { status: 302, headers: { location: '/dash', 'cache-control': 'no-store' } });
    }
    var consoleResp = await handleConsoleApi(request, env, ctx, url, function () {
      return purgeApiCache(env, url.origin);
    }, (function (path: string) {
      // the freeze and the saved copies take the public payloads as
      // they stand; they ask for them here so they never have to know
      // how they are built
      return livePayload(path, env.DB);
    }) as RenderPayload);
    if (consoleResp) return consoleResp;

    // a challenge: the team's own count, never cached, and the standings
    // the quest page shows. Both route before submit.ts, which answers
    // every other /api/submit/ path.
    if (request.method === 'GET' && url.pathname === '/api/submit/tally') return teamTally(request, env, url);
    if (request.method === 'GET' && url.pathname === '/api/quest/standings') return cachedStandings(request, env, ctx, url);

    // team-facing submission endpoints (cross-origin from the site)
    var submitResp = await handleSubmitApi(request, env, url);
    if (submitResp) return submitResp;

    // the video encoder on an organiser's laptop, holding ENCODER_KEY.
    // It routes here, before the Discord signature check, for the same
    // reason the check-in report does: its POSTs carry a bearer token
    // rather than a signature.
    var encoderResp = await handleEncoderApi(request, env, url);
    if (encoderResp) return encoderResp;

    // push subscriptions (cross-origin from the site's settings rocker)
    var pushResp = await handlePushApi(request, env, url);
    if (pushResp) return pushResp;

    // team registration (cross-origin from the site's /rego page)
    var regoResp = await handleRegoApi(request, env, ctx, url);
    if (regoResp) return regoResp;

    // the quest list itself (the site's quest page and submit picker),
    // the files hung on a quest, and the question a live quest asks —
    // none of them cached reads, so they route before the cached API
    var questsResp = await handleQuestApi(request, env, url);
    if (questsResp) return questsResp;

    // a message's attachments, by their unguessable keys (the messages
    // themselves are a cached read like the rest of the public API)
    var messagesResp = await handleMessagesApi(request, env, url);
    if (messagesResp) return messagesResp;

    // the home page's pictures, by their keys (the list itself is a
    // cached read like the rest of the public API)
    var slidesResp = await handleSlidesApi(request, env, url);
    if (slidesResp) return slidesResp;

    // the albums on the site: never cached, since a photo added should
    // show at once
    var albumsResp = await handleAlbumsApi(request, env, url);
    if (albumsResp) return albumsResp;

    // the original videos as a ZIP, by a link the dashboard signed
    var originalsResp = await handleOriginalsApi(request, env, url);
    if (originalsResp) return originalsResp;

    // the card Discord draws for a link to one of the site's pages
    // a team's phone PIN and the payphones it has
    var phoneResp = await handlePhoneApi(request, env, url);
    if (phoneResp) return phoneResp;

    var embedResp = await handleEmbedApi(request, env, url);
    if (embedResp) return embedResp;

    // after the event: a team's page and the recap, both behind the
    // dashboard's switches and never cached
    var recapResp = await handleRecapApi(request, env, url);
    if (recapResp) return recapResp;

    if (request.method === 'GET') {
      if (TEAM_READS[url.pathname]) return await teamRead(request, env, url.pathname);
      if (url.pathname.indexOf('/api/') === 0) {
        // no catch here on purpose: the top-level wrapper turns a
        // failure into a 500 that names the cause
        return await cachedApi(request, env, ctx, url.pathname);
      }
      return new Response('SCS.2 tab bot. Discord interactions POST here; the site reads /api/leaderboard, /api/quests and /api/stats.', { status: 200 });
    }

    if (request.method !== 'POST') {
      return new Response('SCS.2 tab bot. Discord interactions POST here.', { status: 200 });
    }

    // the check-in worker's report, keyed by the shared secret rather
    // than a Discord signature
    if (url.pathname === '/api/team-checkin') return handleTeamCheckin(request, env, ctx);
    // the phone worker asking what a call does next, and handing over a
    // recorded message, keyed the same way
    if (url.pathname === '/api/phone/step') return handlePhoneStep(request, env, ctx);
    if (url.pathname === '/api/phone/message') return handlePhoneMessage(request, env, url);

    var body = await request.text();
    var valid = await verifySignature(request, body, env.DISCORD_PUBLIC_KEY);
    if (!valid) return new Response('invalid request signature', { status: 401 });

    // Discord's, signed as checked above
    var interaction = JSON.parse(body) as Interaction;

    if (interaction.type === PING) return json({ type: PONG });

    if (interaction.type === AUTOCOMPLETE) {
      var choices: { name: string; value: string }[] = [];
      try { choices = await autocompleteChoices(interaction, env.DB); } catch (err) {}
      return json({ type: AUTOCOMPLETE_RESULT, data: { choices: choices } });
    }

    if (interaction.type === APPLICATION_COMMAND) {
      var content: CommandReply;
      try {
        content = await runCommand(interaction, env, ctx);
        // a score may just have moved: drop the cached API responses so
        // the live tab picks it up straight away
        var name = interaction.data && interaction.data.name;
        if (name === 'submit' || name === 'unsubmit') {
          if (ctx && ctx.waitUntil) ctx.waitUntil(purgeApiCache(env, url.origin));
          else await purgeApiCache(env, url.origin);
        }
      } catch (err) {
        content = 'Something went wrong on the tab. Try again.';
      }
      // a handler may answer with a whole interaction response (a
      // deferred reply, say); otherwise a plain channel message,
      // visible to everyone, unless the handler chose to answer
      // ephemerally ({ content, flags }); either way a team name can
      // never ping people
      if (content && typeof content === 'object' && 'type' in content && content.type) return json(content);
      // words or a reply, not a whole response
      var data = (typeof content === 'string' ? { content: content } : content) as Reply;
      if (!data.allowed_mentions) data.allowed_mentions = { parse: [] };
      // while posts on this server are held (the Discord tab), only
      // whoever ran the command sees the answer
      if (!((data.flags || 0) & 64) && await postsHeld(env.DB, interaction.guild_id)) data.flags = (data.flags || 0) | 64;
      return json({ type: MESSAGE, data: data });
    }

    // a pick from a role menu the bot posted
    if (interaction.type === MESSAGE_COMPONENT && isRoleMenu(interaction)) {
      var picked: object;
      try { picked = await handleRoleMenu(interaction, env, ctx); }
      catch (err) { picked = { type: MESSAGE, data: { content: 'Something went wrong. Try again.', flags: 64 } }; }
      return json(picked);
    }

    return new Response('unhandled interaction type', { status: 400 });
  }
};
