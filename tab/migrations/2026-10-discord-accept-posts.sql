-- Each accepted submission is posted in the team's own channel on a
-- server, with what it was worth and the team's new total, unless this
-- is turned off for the server on the dashboard's Discord tab.
ALTER TABLE discord_guilds ADD COLUMN accept_posts INTEGER NOT NULL DEFAULT 1;
