-- Discord servers, team roles/channels and verified members, for
-- databases created before the dashboard's Discord tab. Safe to
-- re-run; npm run db:migrate applies every file in this folder.
CREATE TABLE IF NOT EXISTS discord_guilds (
  guild_id          TEXT PRIMARY KEY,
  name              TEXT NOT NULL DEFAULT '',
  organiser_role_id TEXT NOT NULL DEFAULT '',
  category_name     TEXT NOT NULL DEFAULT 'Private Channels',
  category_id       TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  added_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS discord_teams (
  guild_id     TEXT NOT NULL,
  team_id      INTEGER NOT NULL,
  role_id      TEXT,
  channel_id   TEXT,
  role_name    TEXT NOT NULL DEFAULT '',
  channel_name TEXT NOT NULL DEFAULT '',
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, team_id)
);
CREATE TABLE IF NOT EXISTS discord_members (
  guild_id       TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  username       TEXT NOT NULL DEFAULT '',
  participant_id INTEGER,
  team_id        INTEGER,
  verified_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (guild_id, user_id)
);
