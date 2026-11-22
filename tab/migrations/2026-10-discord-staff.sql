-- The roles, besides the organiser role, that see and talk in every
-- team channel on a server. Comma separated ids; every server's roles
-- are its own.
ALTER TABLE discord_guilds ADD COLUMN staff_role_ids TEXT NOT NULL DEFAULT '';
