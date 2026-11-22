-- The two roles the bot hands out that are not a team's: Legend for
-- everyone taking part, Unknown Team for a member no signup lists.
ALTER TABLE discord_guilds ADD COLUMN legend_role_id TEXT NOT NULL DEFAULT '';
ALTER TABLE discord_guilds ADD COLUMN unknown_role_id TEXT NOT NULL DEFAULT '';
