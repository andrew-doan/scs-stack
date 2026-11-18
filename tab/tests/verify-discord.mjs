// Run with: node tests/verify-discord.mjs   (needs Node 22+ for node:sqlite)
// The bot's Discord side against a pretend Discord: which servers it
// works in (seeded from wrangler vars, managed from the dashboard),
// the organiser guard per server, /verify (signup → team role and
// private channel, deferred reply filled in afterwards), the
// dashboard's Discord tab (status, pickers, posting, registering the
// commands, setting up every team) and registration edits from the
// dashboard (team rename follows through to the tab and Discord,
// people edited, added with a QR and email, removed, a team created).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { d1Shim } from './d1-shim.mjs';
import { consoleSignIn } from './console-signin.mjs';
const BOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function check(label, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + label + (detail ? '  ' + detail : ''));
  if (!ok) failures++;
}

const raw = new DatabaseSync(':memory:');
raw.exec(readFileSync(BOT + '/schema.sql', 'utf8'));
raw.exec(readFileSync(BOT + '/seed.sql', 'utf8'));
const db = d1Shim(raw);
globalThis.caches = { default: { async match() {}, async put() {}, async delete() { return true; } } };

// ---------------- a pretend Discord ----------------
const GUILD = '100000000000000001';
const OTHER = '100000000000000002';
const ORGCOM = '200000000000000001';
let nextId = 300000000000000000n;
const newId = () => String(nextId++);
const discord = {
  me: { id: '999000000000000001', username: 'scs-tab' },
  guilds: {
    [GUILD]: { id: GUILD, name: 'SCS Sydney', roles: [{ id: GUILD, name: '@everyone', position: 0 }, { id: ORGCOM, name: 'OrgCom', position: 5 }, { id: '200000000000000002', name: 'Bot', position: 9, managed: true }],
      channels: [{ id: '400000000000000001', name: 'general', type: 0, position: 0, parent_id: null }, { id: '400000000000000002', name: 'Info', type: 4, position: 1 }],
      members: {}, commands: [] },
    [OTHER]: { id: OTHER, name: 'Test Server', roles: [{ id: OTHER, name: '@everyone', position: 0 }], channels: [], members: {}, commands: [] }
  },
  messages: [],
  followUps: [],
  calls: [],
  // 'METHOD path' -> how many 429s to answer before letting a call through
  limits: {},
  // how many new text channels to refuse, as if the bot lacked the permission
  refuseChannels: 0
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('https://discord.com/api/v10')) {
    if (url.startsWith('https://checkin.example/')) {
      return Response.json({ ok: true, qr_url: 'https://checkin.example/qr/' + JSON.parse(init.body).zid + '.png' });
    }
    return realFetch(input, init);
  }
  const path = url.slice('https://discord.com/api/v10'.length);
  const method = (init && init.method) || 'GET';
  const body = init && init.body ? JSON.parse(init.body) : null;
  discord.calls.push({ method, path, auth: init && init.headers && init.headers.authorization });
  if (!init || !init.headers || init.headers.authorization !== 'Bot bot-token') return Response.json({ message: '401: Unauthorized' }, { status: 401 });
  if (discord.limits[method + ' ' + path] > 0) {
    discord.limits[method + ' ' + path]--;
    return Response.json({ message: 'You are being rate limited.', retry_after: 0.05, global: false }, { status: 429 });
  }
  let m;
  if (path === '/users/@me') return Response.json(discord.me);
  if (path === '/oauth2/applications/@me') return Response.json({ id: discord.me.id, name: 'SCS.2 tab bot' });
  if (path === '/users/@me/guilds') return Response.json(Object.values(discord.guilds).map(g => ({ id: g.id, name: g.name })));
  if ((m = path.match(/^\/guilds\/(\d+)\/roles$/))) {
    const g = discord.guilds[m[1]]; if (!g) return Response.json({ message: 'Unknown Guild' }, { status: 404 });
    if (method === 'POST') { const role = { id: newId(), name: body.name, position: g.roles.length, mentionable: !!body.mentionable, permissions: body.permissions || '0', color: body.color || 0 }; g.roles.push(role); return Response.json(role); }
    return Response.json(g.roles);
  }
  if ((m = path.match(/^\/guilds\/(\d+)\/roles\/(\d+)$/)) && method === 'DELETE') {
    const g = discord.guilds[m[1]]; g.roles = g.roles.filter(r => r.id !== m[2]); return new Response(null, { status: 204 });
  }
  if ((m = path.match(/^\/guilds\/(\d+)\/members\/search\?query=([^&]*)&limit=(\d+)$/))) {
    const g = discord.guilds[m[1]]; const q = decodeURIComponent(m[2]).toLowerCase();
    return Response.json((g.people || []).filter(p => p.user.username.toLowerCase().startsWith(q)).slice(0, Number(m[3])));
  }
  if ((m = path.match(/^\/channels\/(\d+)$/)) && method === 'DELETE') {
    for (const g of Object.values(discord.guilds)) { if (g.channels.some(c => c.id === m[1])) { g.channels = g.channels.filter(c => c.id !== m[1]); return new Response(null, { status: 204 }); } }
    return Response.json({ message: 'Unknown Channel' }, { status: 404 });
  }
  if ((m = path.match(/^\/guilds\/(\d+)\/roles\/(\d+)$/)) && method === 'PATCH') {
    const role = discord.guilds[m[1]].roles.find(r => r.id === m[2]); Object.assign(role, body); return Response.json(role);
  }
  if ((m = path.match(/^\/guilds\/(\d+)\/channels$/))) {
    const g = discord.guilds[m[1]]; if (!g) return Response.json({ message: 'Unknown Guild' }, { status: 404 });
    if (method === 'POST' && body.type === 0 && discord.refuseChannels > 0) {
      discord.refuseChannels--;
      return Response.json({ message: 'Missing Permissions', code: 50013 }, { status: 403 });
    }
    if (method === 'POST') {
      // Discord normalises text channel names itself
      const name = body.type === 0 ? body.name.toLowerCase().replace(/\s+/g, '-') : body.name;
      const ch = { id: newId(), name, type: body.type, parent_id: body.parent_id || null, position: g.channels.length, permission_overwrites: body.permission_overwrites || [], topic: body.topic };
      g.channels.push(ch); return Response.json(ch);
    }
    return Response.json(g.channels);
  }
  if ((m = path.match(/^\/channels\/(\d+)$/)) && method === 'GET') {
    for (const g of Object.values(discord.guilds)) { const ch = g.channels.find(c => c.id === m[1]); if (ch) return Response.json(Object.assign({ guild_id: g.id }, ch)); }
    return Response.json({ message: 'Unknown Channel' }, { status: 404 });
  }
  if ((m = path.match(/^\/channels\/(\d+)$/)) && method === 'PATCH') {
    for (const g of Object.values(discord.guilds)) { const ch = g.channels.find(c => c.id === m[1]); if (ch) { Object.assign(ch, body); return Response.json(ch); } }
    return Response.json({ message: 'Unknown Channel' }, { status: 404 });
  }
  if ((m = path.match(/^\/channels\/(\d+)\/permissions\/(\d+)$/)) && method === 'PUT') {
    for (const g of Object.values(discord.guilds)) {
      const ch = g.channels.find(c => c.id === m[1]);
      if (ch) {
        ch.permission_overwrites = ch.permission_overwrites.filter(o => o.id !== m[2]).concat([{ id: m[2], type: body.type, allow: body.allow, deny: body.deny }]);
        return new Response(null, { status: 204 });
      }
    }
    return Response.json({ message: 'Unknown Channel' }, { status: 404 });
  }
  if ((m = path.match(/^\/channels\/(\d+)\/permissions\/(\d+)$/)) && method === 'DELETE') {
    for (const g of Object.values(discord.guilds)) { const ch = g.channels.find(c => c.id === m[1]); if (ch) { ch.permission_overwrites = ch.permission_overwrites.filter(o => o.id !== m[2]); return new Response(null, { status: 204 }); } }
    return Response.json({ message: 'Unknown Channel' }, { status: 404 });
  }
  if ((m = path.match(/^\/guilds\/(\d+)\/members\/(\d+)\/roles\/(\d+)$/)) && method === 'PUT') {
    const g = discord.guilds[m[1]]; g.members[m[2]] = g.members[m[2]] || []; if (!g.members[m[2]].includes(m[3])) g.members[m[2]].push(m[3]); return new Response(null, { status: 204 });
  }
  if ((m = path.match(/^\/channels\/(\d+)\/messages\/(\d+)$/)) && (method === 'PATCH' || method === 'DELETE')) {
    const msg = discord.messages.find(x => x.channel === m[1] && x.id === m[2]);
    if (!msg) return Response.json({ message: 'Unknown Message' }, { status: 404 });
    if (method === 'DELETE') { discord.messages = discord.messages.filter(x => x !== msg); return new Response(null, { status: 204 }); }
    msg.body = body; msg.edits = (msg.edits || 0) + 1; return Response.json({ id: msg.id });
  }
  // the bot's own membership, its one role Bot: only once the role menus
  // ask, since everything before them reads a missing one as full rights
  if ((m = path.match(/^\/guilds\/(\d+)\/members\/(\d+)$/)) && method === 'GET' && m[2] === discord.me.id && discord.botMember) {
    return Response.json({ user: discord.me, roles: ['200000000000000002'] });
  }
  if ((m = path.match(/^\/channels\/(\d+)\/messages$/)) && method === 'POST') {
    if (m[1] === '400000000000000009') return Response.json({ message: 'Missing Access' }, { status: 403 });
    const posted = { id: newId(), channel: m[1], body, author: discord.me }; discord.messages.push(posted); return Response.json({ id: posted.id, content: body.content });
  }
  // a channel's messages, newest first, a page at a time before an id
  if ((m = path.match(/^\/channels\/(\d+)\/messages\?(.*)$/)) && method === 'GET') {
    const q = new URLSearchParams(m[2]);
    const before = q.get('before') ? BigInt(q.get('before')) : null;
    const page = discord.messages.filter(x => x.channel === m[1] && (before === null || BigInt(x.id) < before))
      .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)).slice(0, Number(q.get('limit')) || 50);
    return Response.json(page.map(x => ({ id: x.id, channel_id: x.channel, author: x.author, content: x.body.content })));
  }
  if ((m = path.match(/^\/webhooks\/(\d+)\/([^/]+)\/messages\/@original$/)) && method === 'PATCH') {
    discord.followUps.push({ app: m[1], token: m[2], body }); return Response.json({ id: newId() });
  }
  if ((m = path.match(/^\/applications\/(\d+)\/guilds\/(\d+)\/commands$/)) && method === 'PUT') {
    discord.guilds[m[2]].commands = body; return Response.json(body.map((c, i) => Object.assign({ id: String(i + 1) }, c)));
  }
  // everyone in the server, a page at a time in id order: whoever has a
  // role, plus whoever is in people
  if ((m = path.match(/^\/guilds\/(\d+)\/members\?limit=(\d+)(?:&after=(\d+))?$/))) {
    const g = discord.guilds[m[1]];
    if (g.noIntent) return Response.json({ message: 'Missing Access', code: 50001 }, { status: 403 });
    const users = {};
    (g.people || []).forEach(p => { users[p.user.id] = p.user; });
    Object.keys(g.members).forEach(id => { users[id] = users[id] || { id, username: 'user' + id }; });
    const list = Object.keys(users).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
      .filter(id => !m[3] || BigInt(id) > BigInt(m[3])).slice(0, Number(m[2]))
      .map(id => ({ user: users[id], roles: (g.members[id] || []).slice() }));
    return Response.json(list);
  }
  if ((m = path.match(/^\/guilds\/(\d+)\/members\/(\d+)$/)) && method === 'PATCH') {
    const g = discord.guilds[m[1]];
    if (g.lockedRoles && body.roles.some(id => g.lockedRoles.includes(id))) return Response.json({ message: 'Missing Permissions', code: 50013 }, { status: 403 });
    g.members[m[2]] = body.roles.slice(); return Response.json({ user: { id: m[2] }, roles: body.roles });
  }
  if ((m = path.match(/^\/guilds\/(\d+)\/members\/(\d+)\/roles\/(\d+)$/)) && method === 'DELETE') {
    const g = discord.guilds[m[1]]; g.members[m[2]] = (g.members[m[2]] || []).filter(id => id !== m[3]); return new Response(null, { status: 204 });
  }
  return Response.json({ message: 'no such route in the pretend Discord: ' + method + ' ' + path }, { status: 404 });
};

const mod = await import(BOT + '/src/index.ts');
const { roleNameFor, channelNameFor, CHANNEL_ALLOW } = await import(BOT + '/src/discord.ts');
const waits = [];
const ctx = { waitUntil(p) { waits.push(p); } };
const settle = () => Promise.all(waits.splice(0));
const ENV = { DB: db, CONSOLE_PASSWORD: 'tab-pass', DISCORD_BOT_TOKEN: 'bot-token', GUILD_ID: GUILD, ORGANISER_ROLE_ID: ORGCOM,
  CHECKIN_API: 'https://checkin.example', CHECKIN_KEY: 'rego-key',
  EMAIL: { send: async () => ({ messageId: 'em' }) }, EMAIL_FROM: 'SCS.2 <tab@scs.andyrew.space>', EMAIL_REPLY_TO: 'westsocunsw@gmail.com' };
const front = (path, opts) => mod.default.fetch(new Request('https://bot.example' + path, opts), ENV, ctx);
const post = (path, body, token) => front(path, {
  method: 'POST',
  headers: Object.assign({ 'content-type': 'application/json' }, token ? { authorization: 'Bearer ' + token } : {}),
  body: JSON.stringify(body)
});
const get = (path, token) => front(path, { headers: token ? { authorization: 'Bearer ' + token } : {} });
// the bot's own command runner, skipping the signature (the payload is what matters here)
const command = (name, guildId, user, roles, options) => mod.runCommand({
  type: 2, id: '1', application_id: discord.me.id, token: 'itoken-' + name + '-' + (user ? user.id : 'x'), guild_id: guildId,
  member: user ? { user, roles: roles || [] } : undefined, data: { name, options: options || [] }
}, ENV, ctx);

// ---------------- names ----------------
check('role names are the team name as typed, tidied',
  roleNameFor('  Loco   Motive!! ') === 'Loco Motive!!' && roleNameFor('@everyone') === 'everyone' && roleNameFor('') === 'Team' && roleNameFor('x'.repeat(120)).length === 100, '');
check('channel names are what Discord allows',
  channelNameFor('Loco Motive!!') === 'loco-motive' && channelNameFor("The S.S. Crab's crew") === 'the-ss-crabs-crew' && channelNameFor('日本語 team') === '日本語-team' && channelNameFor('???') === 'team', channelNameFor("The S.S. Crab's crew"));

// ---------------- a registered team ----------------
let signIn = await consoleSignIn(post, 'Alex', 'tab-pass');
let r = { status: signIn.session ? 200 : 401, json: async () => signIn };
const sess = (await r.json()).session;
r = await post('/api/rego/create', { team_name: 'Loco Motive', members: [
  { name: 'Alice Park', zid: 'z5111111', email: 'alice@example.com', discord: '@AliceP', agreed: true },
  { name: 'Ben Ho', zid: 'z5222222', email: 'ben@example.com', discord: 'benho#0', agreed: true },
  { name: 'Lu Chen', zid: 'z5222223', email: 'lu@example.com', agreed: true }
] });
await settle();
check('a team registers with Discord usernames on file', r.status === 200, await r.text());
r = await post('/api/rego/create', { team_name: 'Ferrous', members: [
  { name: 'Cass Fe', zid: 'z5333333', email: 'cass@example.com', discord: 'cassfe', agreed: true },
  { name: 'Dom Fe', zid: 'z5333334', email: 'dom@example.com', agreed: true },
  { name: 'Eli Fe', zid: 'z5333335', email: 'eli@example.com', agreed: true }
] });
await settle();

// ---------------- the organiser guard, per server ----------------
let out = await command('submit', GUILD, { id: '500000000000000001', username: 'alicep' }, [], [{ name: 'team', value: 'Loco Motive' }, { name: 'quest', value: 'S1' }]);
check('a member without the organiser role cannot change scores', /Only organisers/.test(out), out);
out = await command('submit', OTHER, { id: '500000000000000001', username: 'alicep' }, [ORGCOM], [{ name: 'team', value: 'Loco Motive' }, { name: 'quest', value: 'S1' }]);
check('a server not set up in the dashboard cannot change scores', /server set up in the dashboard/.test(out), out);
const seeded = raw.prepare('SELECT guild_id, organiser_role_id FROM discord_guilds').all();
check('the wrangler vars seeded the first server row', seeded.length === 1 && seeded[0].guild_id === GUILD && seeded[0].organiser_role_id === ORGCOM, JSON.stringify(seeded));
out = await command('submit', GUILD, { id: '500000000000000009', username: 'org' }, [ORGCOM], [{ name: 'team', value: 'Loco Motive' }, { name: 'quest', value: 'S1' }]);
check('an organiser in the set-up server can', /Recorded: S1/.test(out), out);
check('a score changed from Discord leaves a row saying who changed it',
  !!raw.prepare("SELECT 1 FROM submissions WHERE added_by = 'discord:org' AND quest_code = 'S1' AND status = 'accepted'").get(), '');
// /submit keeps to the part rules Accept does: a fixed part once, a
// per-unit part up to its most
{
  raw.prepare("INSERT INTO quests (code, norm, points, scoring, most) VALUES ('PU1', 'PU1', 10, 'unit', 2)").run();
  const org = { id: '500000000000000009', username: 'org' };
  const submit = quest => command('submit', GUILD, org, [ORGCOM], [{ name: 'team', value: 'Loco Motive' }, { name: 'quest', value: quest }]);
  const heldOn = code => (raw.prepare("SELECT amount FROM held WHERE quest_code = ? AND team_id = (SELECT id FROM teams WHERE name = 'Loco Motive')").get(code) || {}).amount;
  const fixedAgain = await submit('S1');
  const units = [await submit('PU1'), await submit('PU1'), await submit('PU1')];
  check('/submit credits a fixed part once and a per-unit part up to its most',
    /credited once/.test(fixedAgain) && heldOn('S1') === 1 && /×2/.test(units[1]) && /counts up to 2/.test(units[2]) && heldOn('PU1') === 2,
    JSON.stringify({ fixedAgain, units, s1: heldOn('S1'), pu1: heldOn('PU1') }));
  // a counted part's count is its accepted submissions, which a line taken
  // off by /unsubmit would not lower
  raw.prepare("INSERT INTO quests (code, norm, points, scoring) VALUES ('CT1', 'CT1', 100, 'counted')").run();
  const countedIn = await submit('CT1');
  const countedOut = await command('unsubmit', GUILD, org, [ORGCOM], [{ name: 'team', value: 'Loco Motive' }, { name: 'quest', value: 'CT1' }]);
  check('/unsubmit refuses a counted part and says where to take it back',
    /Recorded: CT1/.test(countedIn) && /counts towards its challenge/.test(countedOut) && heldOn('CT1') === 1,
    JSON.stringify({ countedIn, countedOut, ct1: heldOn('CT1') }));
}

// ---------------- /verify ----------------
out = await command('verify', OTHER, { id: '500000000000000001', username: 'alicep' });
check('/verify in a server not set up says so', out.flags === 64 && /not set up/.test(out.content), JSON.stringify(out));
out = await command('verify', GUILD, { id: '500000000000000001', username: 'alicep', global_name: 'Alice' });
check('/verify answers deferred and ephemeral', out.type === 5 && out.data.flags === 64, JSON.stringify(out));
await settle();
let g = discord.guilds[GUILD];
let role = g.roles.find(x => x.name === 'Loco Motive');
let cat = g.channels.find(c => c.type === 4 && c.name === 'Private Channels');
let chan = g.channels.find(c => c.type === 0 && c.name === 'loco-motive');
check('the team role, the category and the private channel were created',
  !!role && role.mentionable && !!cat && !!chan && chan.parent_id === cat.id, JSON.stringify({ role: !!role, cat: !!cat, chan: chan && chan.parent_id }));
const ow = chan ? chan.permission_overwrites : [];
check('the channel is hidden from everyone, open to the team role, OrgCom and the bot',
  ow.some(o => o.id === GUILD && o.deny === '1024') && ow.some(o => o.id === role.id && o.allow === CHANNEL_ALLOW) &&
  ow.some(o => o.id === ORGCOM && o.allow === CHANNEL_ALLOW) && ow.some(o => o.id === discord.me.id && o.type === 1), JSON.stringify(ow));
const legend = g.roles.find(x => x.name === 'Legend');
check('Alice got the role and Legend (matched by username, @ and case ignored)',
  (g.members['500000000000000001'] || []).includes(role.id) && !!legend && (g.members['500000000000000001'] || []).includes(legend.id) &&
  legend.permissions === '0' && raw.prepare('SELECT legend_role_id FROM discord_guilds WHERE guild_id = ?').get(GUILD).legend_role_id === legend.id,
  JSON.stringify(g.members['500000000000000001']));
const fu = discord.followUps[discord.followUps.length - 1];
check('the deferred reply was filled in with the role and channel',
  !!fu && fu.token === 'itoken-verify-500000000000000001' && /Verified: \*\*Alice Park\*\*, team \*\*Loco Motive\*\*/.test(fu.body.content) &&
  fu.body.content.includes('<@&' + role.id + '>') && fu.body.content.includes('<#' + chan.id + '>') && fu.body.allowed_mentions.parse.length === 0, fu && fu.body.content);
let stored = raw.prepare('SELECT role_id, channel_id FROM discord_teams WHERE guild_id = ?').get(GUILD);
let member = raw.prepare('SELECT * FROM discord_members WHERE user_id = ?').get('500000000000000001');
check('the ids are remembered and the member recorded', stored.role_id === role.id && stored.channel_id === chan.id && member && member.team_id > 0 && member.username === 'alicep', '');

const callsBefore = discord.calls.length;
out = await command('verify', GUILD, { id: '500000000000000002', username: 'benho', discriminator: '0' });
await settle();
check('a teammate reuses the role and channel (legacy #0 handle tolerated)',
  g.roles.filter(x => x.name === 'Loco Motive').length === 1 && g.channels.filter(c => c.name === 'loco-motive').length === 1 &&
  (g.members['500000000000000002'] || []).includes(role.id) && !discord.calls.slice(callsBefore).some(c => c.method === 'POST' && /\/(roles|channels)$/.test(c.path)), '');
out = await command('verify', GUILD, { id: '500000000000000003', username: 'nobody', global_name: 'Nobody' });
await settle();
const fu2 = discord.followUps[discord.followUps.length - 1];
check('an unknown username is told what to do', /No signup lists the Discord username \*\*nobody\*\*/.test(fu2.body.content) && /rego/.test(fu2.body.content), fu2.body.content);
out = await command('verify', GUILD, { id: '500000000000000015', username: 'someone', global_name: 'CassFe' });
await settle();
check('a display name set to a signed-up username matches nothing', !g.members['500000000000000015'] && !g.roles.some(x => x.name === 'Ferrous'), '');
out = await command('verify', GUILD, { id: '500000000000000004', username: 'cassfe', global_name: 'Someone' });
await settle();
check('the username itself does', (g.members['500000000000000004'] || []).length === 2 && g.members['500000000000000004'].includes(legend.id) &&
  g.roles.some(x => x.name === 'Ferrous') && g.roles.filter(x => x.name === 'Legend').length === 1, JSON.stringify(g.members['500000000000000004']));

out = await command('verify', undefined, { id: '500000000000000001', username: 'alicep' });
check('/verify in a DM is refused', out.flags === 64 && /inside the SCS server/.test(out.content), JSON.stringify(out));
out = await mod.runCommand({ type: 2, application_id: discord.me.id, token: 't', guild_id: GUILD, member: { user: { id: '5', username: 'x' }, roles: [] }, data: { name: 'verify' } }, Object.assign({}, ENV, { DISCORD_BOT_TOKEN: 'PASTE-YOUR-TOKEN' }), ctx);
check('without the bot token /verify says what is missing', /DISCORD_BOT_TOKEN/.test(out.content), JSON.stringify(out));
const help = await command('help', GUILD, { id: '1', username: 'x' });
check('/help lists /verify', /\/verify/.test(help), '');

// ---------------- the dashboard's Discord tab ----------------
r = await get('/api/console/discord/status', sess);
let data = await r.json();
check('status: bot, servers the bot is in, the set-up server with counts, teams and members',
  data.ok && data.configured && data.bot.username === 'scs-tab' && data.servers.length === 1 && data.servers[0].id === OTHER &&
  data.guilds.length === 1 && data.guilds[0].name === 'SCS Sydney' && data.guilds[0].in_server && data.guilds[0].teams_setup === 2 && data.guilds[0].verified === 3 &&
  data.teams.find(t => t.name === 'Loco Motive').guilds[GUILD].channel_name === 'loco-motive' && data.members.length === 3 && data.members[0].person,
  JSON.stringify({ servers: data.servers, guild: data.guilds[0] }));
r = await get('/api/console/discord/guild?guild_id=' + GUILD, sess);
data = await r.json();
check('a server\'s roles (no @everyone, no bot roles) and channels are listed for the pickers',
  data.ok && !data.roles.some(x => x.name === '@everyone' || x.name === 'Bot') && data.roles[0].name === 'OrgCom' && data.channels.some(c => c.name === 'loco-motive'), JSON.stringify(data.roles));
r = await post('/api/console/discord/guild/save', { guild_id: OTHER, name: 'Test Server', organiser_role_id: '', category_name: 'Team Rooms' }, sess);
check('a second server is added', r.status === 200, await r.text());
out = await command('submit', OTHER, { id: '500000000000000009', username: 'org' }, [ORGCOM], [{ name: 'team', value: 'Loco Motive' }, { name: 'quest', value: 'S2' }]);
check('until an organiser role is chosen, score changes there stay locked', /organiser role is chosen/.test(out), out);
r = await post('/api/console/discord/guild/save', { guild_id: OTHER, organiser_role_id: '200000000000000077', category_name: 'Team Rooms', enabled: true }, sess);
out = await command('submit', OTHER, { id: '500000000000000009', username: 'org' }, ['200000000000000077'], [{ name: 'team', value: 'Loco Motive' }, { name: 'quest', value: 'S2' }]);
check('with its own organiser role the second server can change scores', /Recorded: S2/.test(out), out);
r = await post('/api/console/discord/guild/save', { guild_id: 'nope', organiser_role_id: '' }, sess);
check('a server id must be a snowflake', r.status === 400, 'status=' + r.status);
r = await post('/api/console/discord/register', { guild_id: OTHER }, sess);
data = await r.json();
check('the commands can be registered from the dashboard', data.ok && data.commands.includes('verify') && discord.guilds[OTHER].commands.length === data.commands.length, JSON.stringify(data));
r = await post('/api/console/discord/setup', { guild_id: OTHER }, sess);
data = await r.json();
const other = discord.guilds[OTHER];
check('Set up every registered team makes roles and channels in the new server',
  data.ok && data.done.length === 2 && data.failed.length === 0 && other.channels.some(c => c.type === 4 && c.name === 'Team Rooms') &&
  other.channels.filter(c => c.type === 0).length === 2 && other.roles.some(x => x.name === 'Ferrous'), JSON.stringify(data));
r = await post('/api/console/discord/setup', { guild_id: OTHER }, sess);
data = await r.json();
check('running it again makes nothing new', data.done.every(d => !d.made.role && !d.made.channel) && other.roles.length === 3, JSON.stringify(data.done));

// Rate limits and a run cut off part way. Each made role used to be
// written down only once its channel was made too, so a setup stopped
// in between (a rate limit, most often) made a second role next time.
const teamId = async (name, people) => {
  const res = await (await post('/api/console/rego/team/create', { team_name: name, members: people, societies: [] }, sess)).json();
  await settle();
  return raw.prepare('SELECT id FROM teams WHERE name = ?').get(name).id;
};
const slow = await teamId('Slow Train', [
  { name: 'Sam Slow', zid: 'z5600001', email: '', discord: 'slowpoke' },
  { name: 'Gus Ghost', zid: 'z5600002', email: '', discord: 'ghost' }
]);
discord.limits['POST /guilds/' + OTHER + '/roles'] = 1;
discord.refuseChannels = 1;
const cut = await (await post('/api/console/discord/setup', { guild_id: OTHER, team_id: slow }, sess)).json();
const again = await (await post('/api/console/discord/setup', { guild_id: OTHER, team_id: slow }, sess)).json();
check('a rate limit is waited out, and a setup stopped after the role picks that role up next time',
  cut.failed.length === 1 && /Missing Permissions/.test(cut.failed[0].error) && again.done.length === 1 && !again.done[0].made.role &&
  other.roles.filter(x => x.name === 'Slow Train').length === 1 && other.channels.filter(c => c.name === 'slow-train').length === 1,
  JSON.stringify({ cut: cut.failed, again: again.done }));

other.people = [{ user: { id: '600000000000000001', username: 'SlowPoke' } }, { user: { id: '600000000000000002', username: 'slowpoke2' } }];
data = await (await post('/api/console/discord/setup', { guild_id: OTHER, team_id: slow, members: true }, sess)).json();
const slowRole = other.roles.find(x => x.name === 'Slow Train');
check('setting up a team with its members gives everyone in the server the role, by username, and names who is not there',
  data.done[0].given === 1 && data.done[0].missing.join() === 'ghost' &&
  (other.members['600000000000000001'] || []).includes(slowRole.id) && !other.members['600000000000000002'] &&
  raw.prepare('SELECT team_id FROM discord_members WHERE guild_id = ? AND user_id = ?').get(OTHER, '600000000000000001').team_id === slow,
  JSON.stringify(data.done));

// two at once (teammates running /verify together, two organisers
// pressing the button) make one role between them
const twin = await teamId('Twin Set', [{ name: 'Tia Twin', zid: 'z5600003', email: '', discord: 'tiatwin' }]);
await Promise.all([1, 2].map(() => post('/api/console/discord/setup', { guild_id: OTHER, team_id: twin }, sess)));
check('two setups of one team at once make one role and one channel',
  other.roles.filter(x => x.name === 'Twin Set').length === 1 && other.channels.filter(c => c.name === 'twin-set').length === 1, '');

// what earlier runs left behind is found for an organiser to delete;
// a team's own role, and a role that only shares a name, are not
other.roles.push({ id: newId(), name: 'Ferrous', position: 9, permissions: '0' });
other.roles.push({ id: newId(), name: 'Ferrous', position: 10, permissions: '1024' });
other.roles.push({ id: newId(), name: 'Alumni', position: 11, permissions: '0' });
data = await (await get('/api/console/discord/leftovers?guild_id=' + OTHER, sess)).json();
const gone = await (await post('/api/console/discord/leftovers/delete', { guild_id: OTHER }, sess)).json();
check('a leftover role is listed and deleted, and the team\'s own role and other roles stay',
  data.ok && data.roles.length === 1 && data.roles[0].name === 'Ferrous' && data.channels.length === 0 &&
  gone.deleted === 1 && gone.left === 0 && other.roles.filter(x => x.name === 'Ferrous').length === 2 && other.roles.some(x => x.name === 'Alumni'),
  JSON.stringify({ data, gone }));
r = await post('/api/console/discord/post', { guild_id: GUILD, channel_id: '400000000000000001', content: 'Briefing 3 is up.\r\n@everyone go' }, sess);
data = await r.json();
const msg = discord.messages[discord.messages.length - 1];
check('the dashboard posts as the bot, mentions as typed', data.ok && msg.channel === '400000000000000001' && msg.body.content === 'Briefing 3 is up.\n@everyone go' && !msg.body.allowed_mentions, JSON.stringify(msg));
r = await post('/api/console/discord/post', { channel_id: '400000000000000001', preset: 'leaderboard' }, sess);
const lb = discord.messages[discord.messages.length - 1];
check('the top 10 preset posts the leaderboard without pings', r.status === 200 && /\*\*Top 10\*\*/.test(lb.body.content) && lb.body.allowed_mentions.parse.length === 0, lb.body.content.slice(0, 12));
r = await post('/api/console/discord/post', { channel_id: '400000000000000009', content: 'hi' }, sess);
check('a channel the bot cannot post in is explained', r.status === 502 && /not allowed/.test((await r.json()).error), '');
r = await post('/api/console/discord/post', { channel_id: '400000000000000001', content: '   ' }, sess);
check('an empty message is refused', r.status === 400, '');

// ---------------- registration edits from the dashboard ----------------
r = await get('/api/console/rego', sess);
data = await r.json();
const reg = data.registrations.find(x => x.team_name === 'Loco Motive');
const alice = reg.members.find(m => m.name === 'Alice Park');
r = await post('/api/console/rego/team/save', { id: reg.id, team_name: 'Loco Motive 2', photo_permission: true, societies: ['RailSoc', 'NotASoc'], questions: 'Any wet weather plan?' }, sess);
data = await r.json();
check('a society not on the list is refused by name, and nothing is saved',
  r.status === 400 && /NotASoc/.test(data.error) && raw.prepare('SELECT name FROM teams WHERE id = ?').get(reg.team_id).name === 'Loco Motive',
  JSON.stringify(data));
r = await post('/api/console/rego/team/save', { id: reg.id, team_name: 'no team YET', photo_permission: true, societies: ['RailSoc'] }, sess);
check('nor can a team take the name check-in gives people without one', r.status === 400, 'status=' + r.status);
r = await post('/api/console/rego/team/save', { id: reg.id, team_name: 'Loco Motive 2', photo_permission: true, societies: ['RailSoc'], questions: 'Any wet weather plan?' }, sess);
data = await r.json();
await settle();
check('renaming the team renames it on the tab and in both servers',
  data.ok && data.discord_renamed === 2 && raw.prepare('SELECT name FROM teams WHERE id = ?').get(reg.team_id).name === 'Loco Motive 2' &&
  g.roles.some(x => x.name === 'Loco Motive 2') && g.channels.some(c => c.name === 'loco-motive-2') && other.channels.some(c => c.name === 'loco-motive-2'),
  JSON.stringify(data));
check('the societies are saved', raw.prepare('SELECT societies FROM registrations WHERE id = ?').get(reg.id).societies === 'RailSoc', '');
r = await post('/api/console/rego/team/save', { id: reg.id, team_name: 'Ferrous' }, sess);
check('a rename onto another team is refused', r.status === 409, 'status=' + r.status);
r = await post('/api/console/rego/person/save', { id: alice.id, name: 'Alice Park-Lee', zid: 'z5111111', email: 'alice.lee@example.com', discord: '@alicepl', dietary: 'Vegan', arc: false }, sess);
data = await r.json();
check('a person is edited in place', data.ok && data.person.name === 'Alice Park-Lee' && data.person.discord === 'alicepl' && data.person.email === 'alice.lee@example.com' && data.person.arc === 0 && data.person.qr_url === alice.qr_url, JSON.stringify(data.person));
r = await post('/api/console/rego/person/save', { id: alice.id, name: 'Alice', zid: 'z5333333', email: 'alice@example.com' }, sess);
check('a zID already on another team is refused', r.status === 409 && /Ferrous/.test((await r.json()).error), '');
const checkinBefore = discord.calls.length;
r = await post('/api/console/rego/person/save', { registration_id: reg.id, name: 'Dee New', zid: 'z5444444', email: 'dee@example.com', discord: 'deenew', arc: true }, sess);
data = await r.json();
check('a person added from the dashboard gets a QR and an email',
  data.ok && data.person.position === 4 && data.qr === 'attached' && data.person.qr_url.includes('z5444444') && data.person.email_status === 'sent', JSON.stringify(data));
out = await command('verify', GUILD, { id: '500000000000000005', username: 'deenew' });
await settle();
check('and can /verify straight away', (g.members['500000000000000005'] || []).includes(role.id), '');
r = await post('/api/console/rego/person/delete', { id: data.person.id }, sess);
check('a person can be removed (their verification goes too)',
  r.status === 200 && !raw.prepare('SELECT id FROM participants WHERE zid = ?').get('z5444444') && !raw.prepare('SELECT * FROM discord_members WHERE user_id = ?').get('500000000000000005'), '');
r = await post('/api/console/rego/team/create', { team_name: 'Walk-ins', members: [{ name: 'Eve Late', zid: 'z0000000', email: '', discord: 'evelate' }], societies: ['WestSoc'] }, sess);
data = await r.json();
await settle();
// no email address is allowed here, unlike the public form — and
// check-in registers people by email, so that person gets no code
check('a team is created from the dashboard with no email address, and so no QR',
  data.ok && data.members === 1 && data.qrs === 0 && data.emails === 0 && raw.prepare("SELECT id FROM teams WHERE name = 'Walk-ins'").get() &&
  raw.prepare("SELECT actor FROM submission_log WHERE action = 'team-register' AND team_name = 'Walk-ins'").get().actor === 'console:Alex', JSON.stringify(data));
r = await post('/api/console/rego/team/create', { team_name: 'Walk-ins Two', members: [{ name: 'Fay Late', zid: 'z0000000', email: 'fay@example.com', discord: 'faylate' }], societies: [] }, sess);
data = await r.json();
await settle();
check('one with an address does get a QR', data.ok && data.qrs === 1, JSON.stringify(data));
r = await post('/api/console/rego/team/create', { team_name: 'Walk-ins', members: [{ name: 'X', zid: 'z0000000' }] }, sess);
check('a taken team name is refused', r.status === 409, '');
r = await post('/api/console/teams/rename', { id: reg.team_id, name: 'Loco Motive 3' }, sess);
data = await r.json();
check('a Teams-tab rename follows through to the registration and Discord',
  data.ok && data.discord_renamed === 2 && raw.prepare('SELECT team_name FROM registrations WHERE id = ?').get(reg.id).team_name === 'Loco Motive 3' && g.roles.some(x => x.name === 'Loco Motive 3'), JSON.stringify(data));
r = await post('/api/console/discord/guild/delete', { guild_id: OTHER }, sess);
check('removing a server drops its rows and nothing else', r.status === 200 && raw.prepare('SELECT COUNT(*) AS n FROM discord_teams').get().n === 2 && raw.prepare('SELECT COUNT(*) AS n FROM discord_members').get().n === 3, '');

r = await get('/api/console/log', sess);
const actions = (await r.json()).entries.map(e => e.action);
check('every step is in the log',
  ['discord-verify', 'discord-guild-add', 'discord-commands', 'discord-setup', 'discord-post', 'rego-team-edit', 'rego-person-edit', 'rego-person-add', 'rego-person-remove', 'team-register', 'discord-guild-remove'].every(a => actions.includes(a)),
  JSON.stringify(actions.slice(0, 12)));

// a team name never picks a role or a channel that is not its own
// (each signup from its own address, past the per-connection limit)
const regoFrom = (ip, body) => front('/api/rego/create', { method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip }, body: JSON.stringify(body) });
r = await regoFrom('192.0.2.6', { team_name: 'OrgCom', members: [
  { name: 'Mal One', zid: 'z5444441', email: 'mal1@example.com', discord: 'malone', agreed: true },
  { name: 'Mal Two', zid: 'z5444442', email: 'mal2@example.com', agreed: true },
  { name: 'Mal Three', zid: 'z5444443', email: 'mal3@example.com', agreed: true }
] });
await settle();
out = await command('verify', GUILD, { id: '500000000000000006', username: 'malone' });
await settle();
const malRoles = (g.members['500000000000000006'] || []).filter(id => id !== legend.id);
check('a team named after the organiser role gets a role of its own, not the organiser role',
  malRoles.length === 1 && malRoles[0] !== ORGCOM && g.roles.filter(x => x.name === 'OrgCom').length === 2, JSON.stringify(malRoles));
for (const [i, name] of [['7', 'Collision!'], ['8', 'Collision?']]) {
  r = await regoFrom('192.0.2.' + i, { team_name: name, members: [
    { name: 'Col ' + i + 'a', zid: 'z55555' + i + '1', email: 'col' + i + 'a@example.com', discord: 'col' + i, agreed: true },
    { name: 'Col ' + i + 'b', zid: 'z55555' + i + '2', email: 'col' + i + 'b@example.com', agreed: true },
    { name: 'Col ' + i + 'c', zid: 'z55555' + i + '3', email: 'col' + i + 'c@example.com', agreed: true }
  ] });
  await settle();
  await command('verify', GUILD, { id: '50000000000000000' + i, username: 'col' + i });
  await settle();
}
const colRows = raw.prepare("SELECT d.channel_id, d.role_id FROM discord_teams d JOIN teams t ON t.id = d.team_id WHERE d.guild_id = ? AND t.name LIKE 'Collision%'").all(GUILD);
const colChans = colRows.map(x => g.channels.find(c => c.id === x.channel_id));
check('two team names that tidy to one channel name get a channel each, each open to its own role only',
  colRows.length === 2 && colRows[0].channel_id !== colRows[1].channel_id && colChans.every(Boolean) &&
  colChans.every((c, k) => !c.permission_overwrites.some(o => o.id === colRows[1 - k].role_id)),
  JSON.stringify(colChans.map(c => c && c.name)));

// somebody who signed up without a team has nothing to be given yet
r = await regoFrom('192.0.2.9', { solo: true, members: [{ name: 'Lone Wolf', zid: 'z5555591', email: 'lone@example.com', discord: 'lonewolf', agreed: true }] });
await settle();
await command('verify', GUILD, { id: '500000000000000009', username: 'lonewolf' });
await settle();
const lone = discord.followUps[discord.followUps.length - 1];
check('/verify tells somebody not yet placed in a team to come back once they are, and gives no role',
  r.status === 200 && /without a team/.test(lone.body.content) && !g.members['500000000000000009'], lone.body.content);

// ---------------- who else sees the team channels ----------------
// A server lists its own staff roles. Setting one up again brings an
// existing channel's permissions to the full set, opens it to the listed
// roles, and takes back only what the bot gave a role taken off the list.
{
  const TABTEAM = '200000000000000041';
  const HAND = '200000000000000042';
  g.roles.push({ id: TABTEAM, name: 'TabTeam', position: 3, permissions: '0' }, { id: HAND, name: 'Photographers', position: 2, permissions: '0' });
  const loco = raw.prepare('SELECT team_id, channel_id FROM discord_teams WHERE guild_id = ? AND channel_id IS NOT NULL ORDER BY team_id LIMIT 1').get(GUILD);
  const ch = () => g.channels.find(c => c.id === loco.channel_id);
  // as channels were opened before: the three old permissions
  ch().permission_overwrites = ch().permission_overwrites.map(o => o.id === GUILD ? o : Object.assign({}, o, { allow: '68608' }));
  ch().permission_overwrites.push({ id: HAND, type: 0, allow: '1024', deny: '0' });
  let res = await (await post('/api/console/discord/guild/save', { guild_id: GUILD, name: 'SCS Sydney', organiser_role_id: ORGCOM, staff_role_ids: [TABTEAM] }, sess)).json();
  res = await (await post('/api/console/discord/setup', { guild_id: GUILD, team_id: loco.team_id }, sess)).json();
  const allowOf = id => (ch().permission_overwrites.find(o => o.id === id) || {}).allow;
  check('a listed staff role is let into an existing team channel, and everyone in it gets the full set',
    res.ok && res.done.length === 1 && allowOf(TABTEAM) === CHANNEL_ALLOW && allowOf(ORGCOM) === CHANNEL_ALLOW &&
    allowOf(raw.prepare('SELECT role_id FROM discord_teams WHERE guild_id = ? AND team_id = ?').get(GUILD, loco.team_id).role_id) === CHANNEL_ALLOW &&
    allowOf(discord.me.id) === CHANNEL_ALLOW && allowOf(HAND) === '1024',
    JSON.stringify(ch().permission_overwrites));
  const status = await (await get('/api/console/discord/status', sess)).json();
  check('the server\'s list comes back to the dashboard', status.guilds.find(x => x.guild_id === GUILD).staff_role_ids.join() === TABTEAM, '');
  await post('/api/console/discord/guild/save', { guild_id: GUILD, name: 'SCS Sydney', organiser_role_id: ORGCOM, staff_role_ids: [] }, sess);
  await post('/api/console/discord/setup', { guild_id: GUILD, team_id: loco.team_id }, sess);
  check('taken off the list, the role loses what the bot gave it, and an overwrite made by hand stays',
    !allowOf(TABTEAM) && allowOf(HAND) === '1024' && allowOf(ORGCOM) === CHANNEL_ALLOW, JSON.stringify(ch().permission_overwrites));
  const calls = discord.calls.length;
  await post('/api/console/discord/setup', { guild_id: GUILD, team_id: loco.team_id }, sess);
  const again = discord.calls.slice(calls).filter(c => c.path.indexOf('/permissions/') !== -1);
  check('a channel already right is not written to again', again.length === 0, JSON.stringify(again));
}

// ---------------- every member of a server, at once ----------------
// A third server with its own organiser role and a Legend made by hand
// before the bot arrived, a member already on a team, one with only the
// organiser role, a bot, people the signups list and people they do not.
const THIRD = '100000000000000003';
const ORG3 = '200000000000000031';
const HAND_LEGEND = '200000000000000032';
discord.guilds[THIRD] = { id: THIRD, name: 'Third', roles: [{ id: THIRD, name: '@everyone', position: 0 }, { id: ORG3, name: 'OrgCom', position: 5, permissions: '8' },
  { id: HAND_LEGEND, name: 'Legend', position: 2, permissions: '0' }], channels: [], members: {}, commands: [] };
const third = discord.guilds[THIRD];
await post('/api/console/discord/guild/save', { guild_id: THIRD, name: 'Third', organiser_role_id: ORG3 }, sess);
const placed = await teamId('Night Owls', [{ name: 'Nia Owl', zid: 'z5700001', email: '', discord: 'niaowl' }]);
const owlRoleBefore = await (await post('/api/console/discord/setup', { guild_id: THIRD, team_id: placed }, sess)).json();
const owlRole = third.roles.find(x => x.name === 'Night Owls').id;
third.people = [
  { user: { id: '700000000000000001', username: 'BenHo' } },         // on a team, no role yet
  { user: { id: '700000000000000002', username: 'stranger' } },      // on nobody's signup
  { user: { id: '700000000000000003', username: 'orga' } },          // the organiser role, left alone
  { user: { id: '700000000000000004', username: 'niaowl' } },        // already holds Night Owls
  { user: { id: '700000000000000005', username: 'lonewolf' } },      // signed up without a team
  { user: { id: '700000000000000006', username: 'scs-bot', bot: true } }
];
for (let i = 0; i < 12; i++) third.people.push({ user: { id: '7000000000000001' + String(i).padStart(2, '0'), username: 'walkin' + i } });
third.members['700000000000000003'] = [ORG3];
third.members['700000000000000004'] = [owlRole];
const sweep = async (recheck) => {
  const total = { checked: 0, team: 0, unknown: 0, legend: 0, requests: 0, failed: [] };
  let after = '';
  for (;;) {
    const res = await (await post('/api/console/discord/roles/all', { guild_id: THIRD, after, recheck: !!recheck }, sess)).json();
    total.requests++;
    if (!res.ok) return Object.assign(total, { error: res.error });
    ['checked', 'team', 'noteam', 'unknown', 'legend'].forEach(k => { total[k] = (total[k] || 0) + (res[k] || 0); });
    total.failed = total.failed.concat(res.failed);
    if (res.done || res.halted || total.requests > 20) return Object.assign(total, { halted: res.halted });
    after = res.after;
  }
};
let swept = await sweep();
const benTeam = raw.prepare("SELECT team_id FROM participants WHERE discord = 'benho#0'").get().team_id;
const loco = third.roles.find(x => x.id === (raw.prepare('SELECT role_id FROM discord_teams WHERE guild_id = ? AND team_id = ?').get(THIRD, benTeam) || {}).role_id);
const unknownRole = third.roles.find(x => x.name === 'Unknown Team');
const has = (id, ...want) => { const got = third.members[id] || []; return got.length === want.length && want.every(x => got.includes(x)); };
check('every member with no role gets their team role and Legend, or Unknown Team and Legend, a page of changes at a time',
  owlRoleBefore.done.length === 1 && swept.requests > 1 && swept.checked === third.people.length && !swept.failed.length &&
  !!loco && !!unknownRole && has('700000000000000001', loco.id, HAND_LEGEND) &&
  has('700000000000000002', unknownRole.id, HAND_LEGEND) && has('700000000000000005', unknownRole.id, HAND_LEGEND) &&
  has('700000000000000100', unknownRole.id, HAND_LEGEND) &&
  raw.prepare('SELECT team_id FROM discord_members WHERE guild_id = ? AND user_id = ?').get(THIRD, '700000000000000001').team_id ===
    benTeam,
  JSON.stringify({ swept, members: third.members }));
check('the organiser role and bots are left alone, a team member gets Legend, and the Legend made by hand is the one used',
  has('700000000000000003', ORG3) && !third.members['700000000000000006'] && has('700000000000000004', owlRole, HAND_LEGEND) &&
  third.roles.filter(x => x.name === 'Legend').length === 1 &&
  raw.prepare('SELECT legend_role_id, unknown_role_id FROM discord_guilds WHERE guild_id = ?').get(THIRD).legend_role_id === HAND_LEGEND,
  JSON.stringify(third.roles.map(x => x.name)));
const callsAt = discord.calls.length;
swept = await sweep();
check('running it again changes nothing',
  swept.team === 0 && swept.unknown === 0 && swept.legend === 0 && !discord.calls.slice(callsAt).some(c => c.method !== 'GET'),
  JSON.stringify(swept));
// somebody tagged Unknown Team who signs up later moves to their team,
// and the recheck touches nobody else: a member who joined since stays
// without a role, and nobody gets Legend topped up
await teamId('Late Birds', [{ name: 'Stan Ger', zid: 'z5700002', email: '', discord: 'stranger' }]);
third.people.push({ user: { id: '700000000000000200', username: 'justjoined' } });
const recheckCalls = discord.calls.length;
swept = await sweep(true);
const late = third.roles.find(x => x.name === 'Late Birds');
const patched = discord.calls.slice(recheckCalls).filter(c => c.method === 'PATCH').map(c => c.path);
check('the recheck moves a member tagged Unknown Team whose signup turns up later to their team, and changes nobody else',
  swept.team === 1 && swept.unknown === 0 && swept.legend === 0 && !!late && has('700000000000000002', late.id, HAND_LEGEND) &&
  !third.members['700000000000000200'] && patched.length === 1 && patched[0].endsWith('/700000000000000002'),
  JSON.stringify({ swept, patched, stan: third.members['700000000000000002'] }));

// somebody moved to another team on the Rego tab takes the new team's
// role with them and loses the old one, so the old channel closes to them
const movers = await teamId('Moving Co', [{ name: 'Mo Ver', zid: 'z5700008', email: '', discord: 'mover' }]);
third.people.push({ user: { id: '700000000000000300', username: 'mover' } });
await post('/api/console/discord/setup', { guild_id: THIRD, team_id: movers, members: true }, sess);
const moversRole = third.roles.find(x => x.name === 'Moving Co');
const mo = raw.prepare("SELECT id FROM participants WHERE zid = 'z5700008'").get().id;
const moved = await (await post('/api/console/rego/person/move', { id: mo, team_id: placed, email: false }, sess)).json();
check('moving a person to another team moves their Discord role with them',
  moved.ok && moved.discord === 1 && has('700000000000000300', owlRole, HAND_LEGEND) && !!moversRole &&
  raw.prepare('SELECT team_id FROM discord_members WHERE guild_id = ? AND user_id = ?').get(THIRD, '700000000000000300').team_id === placed,
  JSON.stringify({ moved, roles: third.members['700000000000000300'] }));

// ---------------- the role for a signup not in a team yet ----------------
// The third server's own No Team Assigned role, made by hand, picked on
// the card. Once set, somebody signed up without a team gets it rather
// than Unknown Team, the recheck moves its holders on once they are in a
// team, and somebody given it by hand whom no signup lists keeps it.
{
  const NO_TEAM = '200000000000000033';
  third.roles.push({ id: NO_TEAM, name: 'No Team Assigned', position: 1, permissions: '0' });
  const save = extra => post('/api/console/discord/guild/save', Object.assign({ guild_id: THIRD, name: 'Third', organiser_role_id: ORG3 }, extra), sess);
  const refused = [(await save({ no_team_role_id: ORG3 })).status, (await save({ no_team_role_id: NO_TEAM, staff_role_ids: [NO_TEAM] })).status];
  r = await save({ no_team_role_id: NO_TEAM });
  check('the role for people without a team is a setting per server, never the organiser role or one that sees every team channel',
    refused[0] === 400 && refused[1] === 400 && r.status === 200 &&
    raw.prepare('SELECT no_team_role_id FROM discord_guilds WHERE guild_id = ?').get(THIRD).no_team_role_id === NO_TEAM,
    JSON.stringify(refused));

  third.people.push({ user: { id: '700000000000000400', username: 'handpicked' } });
  third.members['700000000000000400'] = [NO_TEAM];
  swept = await sweep(true);
  check('the recheck moves somebody in Unknown Team who signed up without a team to the no-team role, and nobody else',
    swept.noteam === 1 && swept.team === 0 && has('700000000000000005', NO_TEAM, HAND_LEGEND) && has('700000000000000400', NO_TEAM),
    JSON.stringify({ swept, lone: third.members['700000000000000005'] }));

  const loneReg = raw.prepare("SELECT registration_id FROM participants WHERE discord = 'lonewolf#0' OR discord = 'lonewolf'").get().registration_id;
  r = await post('/api/console/rego/place', { registration_ids: [loneReg], team_id: placed, email: false }, sess);
  await settle();
  swept = await sweep(true);
  check('once placed, the recheck moves them from the no-team role to their team',
    r.status === 200 && swept.team === 1 && has('700000000000000005', owlRole, HAND_LEGEND),
    JSON.stringify({ status: r.status, swept, lone: third.members['700000000000000005'] }));

  swept = await sweep();
  check('the full sweep leaves the no-team role on somebody given it by hand whom no signup lists',
    has('700000000000000400', NO_TEAM), JSON.stringify(third.members['700000000000000400']));

  await regoFrom('192.0.2.10', { solo: true, members: [{ name: 'Dee Rifter', zid: 'z5555592', email: 'dee@example.com', discord: 'drifter', agreed: true }] });
  await settle();
  third.people.push({ user: { id: '700000000000000500', username: 'drifter' } });
  await command('verify', THIRD, { id: '700000000000000500', username: 'drifter' });
  await settle();
  const said = discord.followUps[discord.followUps.length - 1].body.content;
  check('/verify gives somebody signed up without a team the no-team role and Legend, and says so',
    has('700000000000000500', NO_TEAM, HAND_LEGEND) && said.indexOf('<@&' + NO_TEAM + '>') !== -1, said);
}

// ---------------- the role for members no signup lists ----------------
// Unknown Team can be one of the server's own roles too. Picking another
// says that whoever has the old one keeps it.
{
  const UNVERIFIED = '200000000000000034';
  third.roles.push({ id: UNVERIFIED, name: 'Unverified', position: 1, permissions: '0' });
  const save = extra => post('/api/console/discord/guild/save', Object.assign({ guild_id: THIRD, name: 'Third', organiser_role_id: ORG3 }, extra), sess);
  const refused = [(await save({ unknown_role_id: ORG3 })).status, (await save({ unknown_role_id: UNVERIFIED, staff_role_ids: [UNVERIFIED] })).status];
  const answer = await (await save({ unknown_role_id: UNVERIFIED })).json();
  third.people.push({ user: { id: '700000000000000600', username: 'nobodyknows' } });
  swept = await sweep();
  check('the role for members no signup lists can be picked, never the organiser role or one that sees every team channel, and the sweep gives it',
    refused[0] === 400 && refused[1] === 400 && answer.ok && /Unknown Team keep it/.test(answer.note) &&
    has('700000000000000600', UNVERIFIED, HAND_LEGEND), JSON.stringify({ refused, answer, m: third.members['700000000000000600'] }));
  await save({ unknown_role_id: unknownRole.id });
}

// ---------------- a test team set up before it was hidden ----------------
const testTeam = await teamId('Test Squad', [{ name: 'Tess Ter', zid: 'z5700003', email: '', discord: 'tester' }]);
await post('/api/console/discord/setup', { guild_id: THIRD, team_id: testTeam }, sess);
const testRole = third.roles.find(x => x.name === 'Test Squad');
const testChan = third.channels.find(c => c.type === 0 && c.name === 'test-squad');
raw.prepare('UPDATE teams SET hidden = 1 WHERE id = ?').run(testTeam);
third.roles = third.roles.filter(x => x.id !== testRole.id);
third.channels = third.channels.filter(c => c.id !== testChan.id);
third.people.push({ user: { id: '700000000000000007', username: 'tester' } });
r = await post('/api/console/discord/setup', { guild_id: THIRD, team_id: testTeam }, sess);
swept = await sweep();
out = await command('verify', THIRD, { id: '700000000000000007', username: 'tester' });
await settle();
check('a hidden team is never set up again, its only member is left alone, and /verify says there is no role',
  r.status === 409 && !third.roles.some(x => x.name === 'Test Squad') && !third.channels.some(c => c.name === 'test-squad') &&
  !third.members['700000000000000007'] && /not taking part/.test(discord.followUps[discord.followUps.length - 1].body.content),
  JSON.stringify({ status: r.status, member: third.members['700000000000000007'] }));
// put back, as if they had been left in Discord, then cleared out
third.roles.push(testRole);
third.channels.push(testChan);
data = await (await get('/api/console/discord/leftovers?guild_id=' + THIRD, sess)).json();
const cleared = await (await post('/api/console/discord/leftovers/delete', { guild_id: THIRD }, sess)).json();
check('a hidden team\'s role and channel are leftovers, and deleting them makes the bot forget the team',
  data.roles.some(x => x.id === testRole.id && x.hidden) && data.channels.some(c => c.id === testChan.id && c.hidden) &&
  data.hidden_teams.includes('Test Squad') && cleared.forgotten === 1 &&
  !third.roles.some(x => x.id === testRole.id) && !third.channels.some(c => c.id === testChan.id) &&
  !raw.prepare('SELECT 1 FROM discord_teams WHERE guild_id = ? AND team_id = ?').get(THIRD, testTeam) &&
  third.roles.some(x => x.name === 'Night Owls'),
  JSON.stringify({ data, cleared }));

third.noIntent = true;
swept = await sweep();
check('without the Server Members Intent it says what to turn on', /Server Members Intent/.test(swept.error || ''), swept.error);
third.noIntent = false;

{
  // ---------------- role menus ----------------
  // A message the bot posts with a dropdown, from which members give
  // themselves roles. A pick only ever moves the roles the menu offers.
  const rm = await import(BOT + '/src/rolemenus.ts');
  discord.botMember = true;
  const sg = discord.guilds[GUILD];
  const roleRed = (await (await post('/api/console/discord/roles/create', { guild_id: GUILD, name: 'Red', color: 0xee352e }, sess)).json()).role;
  const redAgain = await (await post('/api/console/discord/roles/create', { guild_id: GUILD, name: 'red', color: 0x00933c }, sess)).json();
  const roleBlue = (await (await post('/api/console/discord/roles/create', { guild_id: GUILD, name: 'Blue', color: 0x0039a6 }, sess)).json()).role;
  sg.roles.filter(r => r.id === roleRed.id || r.id === roleBlue.id).forEach(r => { r.position = 1; });
  check('a colour role is made with its colour, and one already called that is used rather than made again',
    sg.roles.find(r => r.id === roleRed.id).color === 0xee352e && redAgain.reused === true && redAgain.role.id === roleRed.id &&
    sg.roles.filter(r => r.name.toLowerCase() === 'red').length === 1, JSON.stringify(redAgain));

  let menuOut = await (await post('/api/console/discord/menus/save', { guild_id: GUILD, title: 'Name colour', body: 'Pick one.', pick: 'one',
    options: [{ role_id: roleRed.id, label: 'Red' }, { role_id: roleBlue.id, label: 'Blue' }, { role_id: 'junk', label: 'Nope' }] }, sess)).json();
  const menuId = menuOut.menu.id;
  const menuPosted = await (await post('/api/console/discord/menus/post', { id: menuId, channel_id: '400000000000000001' }, sess)).json();
  const menuMsg = discord.messages.find(x => x.id === menuPosted.menu.message_id);
  const select = menuMsg && menuMsg.body.components[0].components[0];
  check('a menu is saved with the roles it offers and posted as one dropdown, with None for a pick-one menu',
    menuOut.menu.options.length === 2 && !!select && select.custom_id === 'rm:' + menuId &&
    select.options.map(o => o.value).join() === roleRed.id + ',' + roleBlue.id + ',none' && select.max_values === 1,
    JSON.stringify(select && select.options));

  const MEMBER = '700000000000000099';
  const pickFrom = async (values, held) => {
    discord.followUps.length = 0;
    const res = await rm.handleRoleMenu({ type: 3, application_id: discord.me.id, token: 'pick-token', guild_id: GUILD,
      member: { user: { id: MEMBER, username: 'picker' }, roles: held }, data: { custom_id: 'rm:' + menuId, component_type: 3, values } }, ENV, ctx);
    await settle();
    return { res, said: discord.followUps.length ? discord.followUps[0].body.content : (res.data && res.data.content) };
  };
  let picked = await pickFrom([roleRed.id], []);
  const afterRed = (sg.members[MEMBER] || []).slice();
  const swapped = await pickFrom([roleBlue.id], afterRed);
  const afterBlue = (sg.members[MEMBER] || []).slice();
  const forged = await pickFrom([ORGCOM], afterBlue);
  check('picking gives the role, picking another in a pick-one menu swaps them, and a role the menu does not offer is never given',
    picked.res.type === 5 && afterRed.join() === roleRed.id && picked.said === 'Added Red.' &&
    afterBlue.join() === roleBlue.id && swapped.said === 'Swapped Red for Blue.' &&
    !(sg.members[MEMBER] || []).includes(ORGCOM), JSON.stringify({ afterRed, afterBlue, now: sg.members[MEMBER], said: [picked.said, swapped.said, forged.said] }));

  sg.roles.push({ id: '200000000000000077', name: 'Admins', position: 10 });
  menuOut = await (await post('/api/console/discord/menus/save', { id: menuId, guild_id: GUILD, title: 'Name colour', body: 'Pick one.', pick: 'one',
    options: [{ role_id: roleRed.id, label: 'Red' }, { role_id: '200000000000000077', label: 'Admins' }] }, sess)).json();
  check('changing a posted menu edits the message in place, and says which roles the bot sits too low to give',
    discord.messages.find(x => x.id === menuPosted.menu.message_id).edits === 1 && /Admins/.test(menuOut.note || ''), menuOut.note);

  const menuGone = await (await post('/api/console/discord/menus/delete', { id: menuId }, sess)).json();
  const late = await pickFrom([roleRed.id], []);
  check('deleting a menu takes its message down, and a pick from an old copy changes nothing',
    menuGone.ok && !discord.messages.some(x => x.id === menuPosted.menu.message_id) &&
    !raw.prepare('SELECT 1 FROM discord_role_menus WHERE id = ?').get(menuId) && late.res.type === 4 && !(sg.members[MEMBER] || []).includes(roleRed.id),
    JSON.stringify({ menuGone, said: late.said }));
}

{
  // ---------------- an accepted submission, in the team's channel ----------------
  const set = raw.prepare('SELECT t.id, t.name, d.channel_id FROM teams t JOIN discord_teams d ON d.team_id = t.id ' +
    'WHERE d.guild_id = ? AND d.channel_id IS NOT NULL AND t.hidden = 0 ORDER BY t.id LIMIT 1').get(GUILD);
  const team = set.id, teamChan = set.channel_id;
  const grp = Number(raw.prepare("INSERT INTO quest_groups (key, name) VALUES ('SQ90', 'Wondabyne')").run().lastInsertRowid);
  raw.prepare("INSERT INTO quests (code, norm, points, group_id) VALUES ('SQ90', 'SQ90', 50, ?), ('SQ90-2', 'SQ90-2', 25, ?)").run(grp, grp);
  const submitted = () => {
    const id = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'SQ90')").run(team).lastInsertRowid);
    raw.prepare("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, ?, 'image/jpeg', 10, 'IMG 1.jpg')").run(id, 'sub/Ab12Cd34Ef56Gh' + id);
    return id;
  };
  const inChannel = () => discord.messages.filter(x => x.channel === teamChan);
  ENV.PUBLIC_API = 'https://files.example';
  const before = inChannel().length;
  const first = submitted();
  const accepted = await (await post('/api/console/submissions/accept', { id: first, codes: ['SQ90', 'SQ90-2'] }, sess)).json();
  await settle();
  const said = inChannel().slice(before);
  const text = said.length ? said[0].body.content : '';
  check('accepting a submission posts it in the team’s channel: the quest, what it was worth, the new total and an embeddable link to the file',
    accepted.ok && said.length === 1 &&
    text.split('\n')[0] === '**Wondabyne** (SQ90 + SQ90-2) accepted for 75 points. ' + set.name + '’s points now ' + accepted.total.toLocaleString('en-US', { maximumFractionDigits: 2 }) + '.' &&
    text.split('\n')[1] === 'https://files.example/api/submit/file/sub/Ab12Cd34Ef56Gh' + first + '/IMG%201.jpg' &&
    said[0].body.allowed_mentions.parse.length === 0, text);

  await post('/api/console/freeze', { frozen: true }, sess);
  const second = submitted();
  await post('/api/console/submissions/accept', { id: second }, sess);
  await settle();
  const frozenText = (inChannel().slice(before + 1)[0] || { body: {} }).body.content || '';
  await post('/api/console/freeze', { frozen: false }, sess);
  check('while the tab is frozen the post leaves the total out',
    /^\*\*Wondabyne\*\* \(SQ90\) accepted for 50 points\.$/m.test(frozenText) && !/points now/.test(frozenText), frozenText);

  const row = raw.prepare('SELECT * FROM discord_guilds WHERE guild_id = ?').get(GUILD);
  const saveWith = (on) => post('/api/console/discord/guild/save', { guild_id: GUILD, name: row.name, organiser_role_id: row.organiser_role_id,
    category_name: row.category_name, enabled: true, announce_channel_id: row.announce_channel_id || '', accept_posts: on }, sess);
  await saveWith(false);
  const shown = (await (await get('/api/console/discord/status', sess)).json()).guilds.find(x => x.guild_id === GUILD);
  const quiet = inChannel().length;
  await post('/api/console/submissions/accept', { id: submitted() }, sess);
  await settle();
  check('with the server’s switch off nothing is posted', shown.accept_posts === 0 && inChannel().length === quiet, JSON.stringify({ shown: shown.accept_posts }));
  await saveWith(true);

  // a rejection, points an organiser records, and points taken back
  const fmt = n => n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  const mark = inChannel().length;
  await post('/api/console/submissions/reject', { id: submitted(), reason: 'the sign is not in the photo' }, sess);
  await settle();
  const recorded = new FormData();
  recorded.append('team_id', String(team)); recorded.append('quest', 'SQ90'); recorded.append('codes', JSON.stringify(['SQ90-2']));
  const added = await (await front('/api/console/points/add', { method: 'POST', headers: { authorization: 'Bearer ' + sess }, body: recorded })).json();
  await settle();
  const undone = await (await post('/api/console/points/undo', { id: added.id }, sess)).json();
  await settle();
  const lines = inChannel().slice(mark).map(x => x.body.content);
  check('a rejection, points an organiser records and points taken back each get a line in the team\u2019s channel',
    lines.length === 3 && lines[0].split('\n')[0] === '**Wondabyne** (SQ90) rejected: the sign is not in the photo' &&
    /^https:\/\/files\.example\/api\/submit\/file\/sub\//m.test(lines[0]) &&
    lines[1] === '**Wondabyne** (SQ90-2) accepted for 25 points. ' + set.name + '\u2019s points now ' + fmt(added.total) + '.' &&
    lines[2] === '**Wondabyne** (SQ90-2): 25 points taken off. ' + set.name + '\u2019s points now ' + fmt(undone.total) + '.',
    JSON.stringify(lines));

  // ---------------- a video in the post, and old posts given fresh links ----------------
  const clipSub = Number(raw.prepare("INSERT INTO submissions (team_id, quest_code) VALUES (?, 'SQ90')").run(team).lastInsertRowid);
  const clipKey = 'sub/Vd12Cd34Ef56Gh' + clipSub;
  raw.prepare("INSERT INTO submission_files (submission_id, r2_key, content_type, bytes, name) VALUES (?, ?, 'video/quicktime', 10, 'clip.MOV')").run(clipSub, clipKey);
  const clipMark = inChannel().length;
  await post('/api/console/submissions/accept', { id: clipSub }, sess);
  await settle();
  const clipText = (inChannel()[clipMark] || { body: {} }).body.content || '';
  check('a video in the post is linked as the encoder\u2019s 720p MP4, which Discord plays',
    clipText.split('\n')[1] === 'https://files.example/api/submit/file/' + clipKey + '/clip.mp4?res=720', clipText);

  // posts as the bot wrote them before: a photo by its name, a video as
  // the phone's own file, on the old hostname
  const said2 = (content, author) => { const msg = { id: newId(), channel: teamChan, body: { content }, author: author || discord.me }; discord.messages.push(msg); return msg; };
  const photoLink = 'https://files.example/api/submit/file/sub/Ab12Cd34Ef56Gh' + first + '/IMG%201.jpg';
  const oldPhoto = said2('**Wondabyne** (SQ90) accepted for 50 points.\n' + photoLink);
  const oldVideo = said2('**Wondabyne** (SQ90) accepted for 50 points.\nhttps://old.example/api/submit/file/' + clipKey + '/clip.MOV\n' +
    'https://files.example/api/submit/file/sub/Gone00000000000/x.jpg');
  const someone = said2('look ' + photoLink, { id: '555000000000000001', username: 'sam' });
  const plain = said2('**Alice Park** checked in (2 of 3).');
  const many = [];
  for (let k = 0; k < 22; k++) many.push(said2('**Wondabyne** (SQ90) accepted for 50 points.\n' + photoLink));
  let cursor = '', asks = 0, refreshed = 0, last;
  do {
    last = await (await post('/api/console/discord/refresh', { guild_id: GUILD, team_id: team, before: cursor }, sess)).json();
    asks++; refreshed += last.edited || 0; cursor = last.before;
  } while (last.ok && cursor && asks < 10);
  const now = x => x.body.content;
  const mark2 = (now(oldPhoto).match(/\?v=([a-z0-9]+)$/) || [])[1];
  check('a refresh gives the bot\u2019s posts fresh links a page at a time: the photo at a new address, the video as the MP4, a file gone and other people\u2019s messages left as they were',
    last.ok && asks >= 2 && !!mark2 && now(oldPhoto) === '**Wondabyne** (SQ90) accepted for 50 points.\n' + photoLink + '?v=' + mark2 &&
    now(oldVideo).split('\n')[1] === 'https://files.example/api/submit/file/' + clipKey + '/clip.mp4?res=720&v=' + mark2 &&
    now(oldVideo).split('\n')[2] === 'https://files.example/api/submit/file/sub/Gone00000000000/x.jpg' &&
    !someone.edits && !plain.edits && many.every(x => x.edits === 1) && oldPhoto.edits === 1 &&
    refreshed === inChannel().filter(x => x.edits && x.author === discord.me).length,
    JSON.stringify({ asks, refreshed, photo: now(oldPhoto), video: now(oldVideo), last }));
  delete ENV.PUBLIC_API;

  // ---------------- a team's role and channel, picked by hand ----------------
  const kept = raw.prepare('SELECT role_id, channel_id FROM discord_teams WHERE guild_id = ? AND team_id = ?').get(GUILD, team);
  const otherChan = raw.prepare('SELECT channel_id FROM discord_teams WHERE guild_id = ? AND team_id != ? AND channel_id IS NOT NULL').get(GUILD, team);
  const sg = discord.guilds[GUILD];
  const crew = { id: newId(), name: 'Crew', position: 1, permissions: '0' };
  const hq = { id: newId(), name: 'crew-hq', type: 0, position: 40, parent_id: null, permission_overwrites: [] };
  sg.roles.push(crew); sg.channels.push(hq);
  const pick = (roleId, channelId) => post('/api/console/discord/team/save', { guild_id: GUILD, team_id: team, role_id: roleId, channel_id: channelId }, sess);
  const asOrganiser = await pick(ORGCOM, kept.channel_id);
  const theirChannel = await pick(kept.role_id, otherChan.channel_id);
  const picked = await (await pick(crew.id, hq.id)).json();
  const stored = raw.prepare('SELECT role_id, channel_id, role_name, channel_name FROM discord_teams WHERE guild_id = ? AND team_id = ?').get(GUILD, team);
  check('a team can be given a role and a channel by hand, never the organiser role or another team\u2019s channel, and the channel then lets the role in',
    asOrganiser.status === 400 && theirChannel.status === 409 && picked.ok && !picked.note &&
    stored.role_id === crew.id && stored.channel_id === hq.id && stored.role_name === 'Crew' &&
    hq.permission_overwrites.some(o => o.id === crew.id), JSON.stringify({ organiser: asOrganiser.status, theirs: theirChannel.status, picked, stored }));
  await pick(kept.role_id, kept.channel_id);

  // ---------------- a check-in, in the team's channel ----------------
  ENV.TAB_SYNC_KEY = 'sync-key';
  const report = body => front('/api/team-checkin', { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sync-key' }, body: JSON.stringify(body) });
  const door = inChannel().length;
  await report({ team_name: set.name, completed_at: null, people: 3, checked_in: 2, person: 'Alice Park', event: 'in' });
  await report({ team_name: set.name, completed_at: '2026-10-20 08:40:00', people: 3, checked_in: 3, person: 'Ben_Ho', event: 'in' });
  await report({ team_name: set.name, completed_at: null, people: 3, checked_in: 2, person: 'Ben_Ho', event: 'out' });
  await report({ team_name: set.name, completed_at: null, people: 3 }); // a check-in worker from before names nobody
  await settle();
  const doorLines = inChannel().slice(door).map(x => x.body.content);
  check('each check-in and undo the check-in worker reports is a line in the team\u2019s channel',
    doorLines.length === 3 && doorLines[0] === '**Alice Park** checked in (2 of 3).' &&
    doorLines[1] === '**Ben\\_Ho** checked in. The whole team is here (3 of 3).' &&
    doorLines[2] === '**Ben\\_Ho**\u2019s check-in was taken back (2 of 3).', JSON.stringify(doorLines));

  // ---------------- submit codes, in the team's channel ----------------
  raw.prepare('DELETE FROM team_codes WHERE team_id = ?').run(team);
  const codeMark = inChannel().length;
  const codeSent = await (await post('/api/console/discord/codes/send', { team_id: team }, sess)).json();
  const minted = (raw.prepare('SELECT code FROM team_codes WHERE team_id = ?').get(team) || {}).code;
  const codeMsg = (inChannel()[codeMark] || { body: {} }).body;
  const hiddenTeam = raw.prepare('SELECT id FROM teams WHERE hidden = 1 LIMIT 1').get();
  const refused = hiddenTeam ? await post('/api/console/discord/codes/send', { team_id: hiddenTeam.id }, sess) : { status: 409 };
  check('a team\u2019s submit code goes to its channel with its role mentioned and a button to the submit page, minted first when it had none',
    codeSent.ok && codeSent.minted === true && codeSent.sent === raw.prepare(
      'SELECT COUNT(*) AS n FROM discord_teams d JOIN discord_guilds g ON g.guild_id = d.guild_id WHERE d.team_id = ? AND d.channel_id IS NOT NULL AND g.enabled = 1').get(team).n && /^[A-Z2-9]{8}$/.test(minted || '') &&
    codeMsg.content === 'Hey <@&' + kept.role_id + '>, your submit code for SCS.2 is:\n```\n' + minted + '\n```\n' +
      'Use it to sign in to the SCS.2 app and submit quests. See you around, Legends!' &&
    codeMsg.allowed_mentions.roles.join() === kept.role_id && codeMsg.components[0].components[0].url === 'https://scs.andyrew.space/submit/' &&
    refused.status === 409, JSON.stringify({ codeSent, codeMsg, refused: refused.status }));

  // ---------------- posts held on one server ----------------
  const holdOn = await (await post('/api/console/discord/hold', { guild_id: GUILD, held: true }, sess)).json();
  const heldStatus = (await (await get('/api/console/discord/status', sess)).json()).guilds.map(g => g.guild_id + ':' + g.held).sort().join();
  const quietFrom = discord.messages.length;
  const logFrom = raw.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM submission_log').get().n;
  await post('/api/console/submissions/accept', { id: submitted() }, sess);
  await settle();
  await post('/api/console/discord/codes/send', { team_id: team }, sess);
  const typed = await post('/api/console/discord/post', { channel_id: '400000000000000001', content: 'Briefing 4 is up.' }, sess);
  const typedWhy = (await typed.json()).error;
  const thirdChannel = raw.prepare('SELECT channel_id FROM discord_teams WHERE guild_id = ? AND team_id = ?').get(THIRD, team).channel_id;
  const elsewhere = await post('/api/console/discord/post', { guild_id: THIRD, channel_id: thirdChannel, content: 'Third server only.' }, sess);
  const onGuild = channel => discord.guilds[GUILD].channels.some(c => c.id === channel);
  const sentSince = () => discord.messages.slice(quietFrom).map(x => x.channel);
  const heldLog = raw.prepare("SELECT team_name, quest_code, actor FROM submission_log WHERE id > ? AND action = 'discord-held' ORDER BY id").all(logFrom);
  const accepts = heldLog.filter(l => /^\*\*Wondabyne\*\* \(SQ90\) accepted for 50 points\./.test(l.quest_code));
  const codes = heldLog.filter(l => /your submit code/.test(l.quest_code));
  check('held on one server, nothing reaches it: an accept, a submit code and a post typed on the dashboard each go in the log with where they were going and what they say, and a post to a server not held goes out',
    holdOn.ok && holdOn.held === true && heldStatus === [GUILD + ':1', THIRD + ':0'].sort().join() &&
    elsewhere.status === 200 && sentSince().every(c => !onGuild(c)) && discord.messages.slice(quietFrom).some(x => x.channel === thirdChannel && x.body.content === 'Third server only.') &&
    typed.status === 409 && /held/.test(typedWhy) && accepts.length >= 1 && accepts.every(l => l.team_name === set.name) &&
    codes.length === accepts.length && codes.every(l => /\[Submit a Quest: https:\/\/scs\.andyrew\.space\/submit\/\]$/.test(l.quest_code)) &&
    heldLog.some(l => l.team_name === 'Channel 400000000000000001' && l.quest_code === 'Briefing 4 is up.') &&
    heldLog.length === accepts.length * 2 + 1,
    JSON.stringify({ holdOn, heldStatus, heldLog, posted: sentSince() }));

  // a command's answer, the way Discord asks for it: signed
  const keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  ENV.DISCORD_PUBLIC_KEY = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex');
  const ask = async payload => {
    const text = JSON.stringify(payload);
    const at = String(Math.floor(Date.now() / 1000));
    const sig = Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(at + text))).toString('hex');
    return (await front('/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature-ed25519': sig, 'x-signature-timestamp': at }, body: text })).json();
  };
  const leaderboard = { type: 2, id: '2', application_id: discord.me.id, token: 'itoken-board', guild_id: GUILD,
    member: { user: { id: '600000000000000001', username: 'kim' }, roles: [] }, data: { name: 'leaderboard', options: [] } };
  const quietReply = await ask(leaderboard);
  await post('/api/console/discord/hold', { guild_id: GUILD, held: false }, sess);
  const openReply = await ask(leaderboard);
  const openFrom = discord.messages.length;
  await post('/api/console/discord/post', { channel_id: '400000000000000001', content: 'Briefing 5 is up.' }, sess);
  check('held, a command still answers but only to whoever ran it; let go, answers and posts go out as before',
    quietReply.type === 4 && (quietReply.data.flags & 64) === 64 && openReply.type === 4 && !(openReply.data.flags & 64) &&
    discord.messages.length === openFrom + 1 && discord.messages[openFrom].body.content === 'Briefing 5 is up.',
    JSON.stringify({ quiet: quietReply.data && quietReply.data.flags, open: openReply.data && openReply.data.flags }));
  delete ENV.DISCORD_PUBLIC_KEY;
}

{
  // GUILD_ID seeded the table once, at the start; the last server removed
  // on the dashboard stays removed rather than coming back from it
  const { guildRows } = await import(BOT + '/src/discord.ts');
  const ids = raw.prepare('SELECT guild_id FROM discord_guilds').all().map(x => x.guild_id);
  const removed = [];
  for (const id of ids) removed.push((await post('/api/console/discord/guild/delete', { guild_id: id }, sess)).status);
  const after = await guildRows(db, ENV);
  check('the secrets seed the servers once: removing the last one leaves none',
    ids.includes(GUILD) && removed.every(s => s === 200) && after.length === 0 &&
    raw.prepare('SELECT COUNT(*) AS n FROM discord_guilds').get().n === 0, JSON.stringify({ ids, removed, after: after.length }));
}

console.log(failures ? '\n' + failures + ' CHECK(S) FAILED' : '\nALL CHECKS PASSED');
process.exit(failures ? 1 : 0);
