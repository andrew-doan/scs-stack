-- Holding posts is chosen per server on the dashboard's Discord tab
-- rather than for every server at once. Each server starts as the one
-- switch was set.
ALTER TABLE discord_guilds ADD COLUMN held INTEGER NOT NULL DEFAULT 0;
UPDATE discord_guilds SET held = COALESCE((SELECT value FROM site_flags WHERE name = 'discord_held'), 0);
DELETE FROM site_flags WHERE name = 'discord_held';
