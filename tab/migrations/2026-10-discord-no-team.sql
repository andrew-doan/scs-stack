-- The role a server gives somebody who signed up without a team and has
-- not been put in one yet, picked on the server's card from the
-- server's own roles. Empty means they get Unknown Team, as before.
ALTER TABLE discord_guilds ADD COLUMN no_team_role_id TEXT NOT NULL DEFAULT '';
