// Registers the slash commands with Discord. Run this once after any
// change to src/commands.ts — from your own machine, with credentials
// in the environment (never written into the repo):
//
//   DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... node scripts/register.mjs
//
// Add DISCORD_GUILD_ID=<server id> (or several, comma-separated) to
// register to those servers only, which updates instantly — global
// registration can take up to an hour to appear. The dashboard's
// Discord tab can do the same per server without a shell.

import { COMMANDS } from '../src/commands.ts';

const appId = process.env.DISCORD_APPLICATION_ID;
const token = process.env.DISCORD_BOT_TOKEN;
const guildIds = (process.env.DISCORD_GUILD_ID || '').split(',').map(s => s.trim()).filter(Boolean);

if (!appId || !token) {
  console.error('Set DISCORD_APPLICATION_ID and DISCORD_BOT_TOKEN in the environment first.');
  process.exit(1);
}

const targets = guildIds.length
  ? guildIds.map(g => ({ label: 'guild ' + g, url: `https://discord.com/api/v10/applications/${appId}/guilds/${g}/commands` }))
  : [{ label: 'globally', url: `https://discord.com/api/v10/applications/${appId}/commands` }];

for (const target of targets) {
  const res = await fetch(target.url, {
    method: 'PUT',
    headers: {
      'authorization': `Bot ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(COMMANDS)
  });

  if (!res.ok) {
    console.error(`Discord said ${res.status} for ${target.label}:`, await res.text());
    process.exit(1);
  }

  const registered = await res.json();
  console.log(`Registered ${registered.length} commands ${guildIds.length ? 'in ' + target.label : target.label}:`);
  for (const c of registered) console.log(`  /${c.name} — ${c.description}`);
}
