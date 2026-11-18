-- Organiser messages, the two version counters the website polls, and
-- the Discord channel a new message is cross-posted to, for databases
-- made before any of it existed. The CREATEs are safe to re-run; the
-- ALTER fails once the column is there (same caveat as the other
-- migrations — schema.sql already has it on a fresh database).
-- npm run db:migrate applies every file in this folder.
CREATE TABLE IF NOT EXISTS counters (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT,
  hidden     INTEGER NOT NULL DEFAULT 0,
  sort       INTEGER NOT NULL DEFAULT 0,
  archived   INTEGER NOT NULL DEFAULT 0,
  urgency    TEXT NOT NULL DEFAULT 'normal'
);
CREATE TABLE IF NOT EXISTS message_files (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL,
  key        TEXT NOT NULL UNIQUE,
  name       TEXT,
  type       TEXT,
  bytes      INTEGER,
  sort       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_message_files_msg ON message_files(message_id);
ALTER TABLE discord_guilds ADD COLUMN announce_channel_id TEXT;
