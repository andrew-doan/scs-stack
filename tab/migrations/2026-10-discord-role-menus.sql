-- Role menus: a message the bot posts with a dropdown from which members
-- give themselves roles, made on the dashboard's Discord tab.
CREATE TABLE IF NOT EXISTS discord_role_menus (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id    TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  pick        TEXT NOT NULL DEFAULT 'one',
  options     TEXT NOT NULL DEFAULT '[]',
  channel_id  TEXT,
  message_id  TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT
);
