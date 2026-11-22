-- Live quests: the files an organiser hangs on a quest, the question a
-- quest can ask every team while it runs (buttons, a sealed number, a
-- points wager, a typed answer), and the answers teams give. For
-- databases made before any of it existed. The CREATEs are safe to
-- re-run; the ALTERs fail once the columns are there (same caveat as
-- the other migrations — schema.sql already has them on a fresh
-- database, so run this only on an older one).
-- npm run db:migrate applies every file in this folder.
CREATE TABLE IF NOT EXISTS quest_files (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  key      TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL DEFAULT '',
  type     TEXT NOT NULL DEFAULT '',
  bytes    INTEGER NOT NULL DEFAULT 0,
  sort     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_quest_files_group ON quest_files(group_id);
CREATE TABLE IF NOT EXISTS quest_responses (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id   INTEGER NOT NULL,
  team_id    INTEGER NOT NULL,
  choice     TEXT NOT NULL DEFAULT '',
  amount     REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (group_id, team_id)
);
ALTER TABLE quest_groups ADD COLUMN ask_kind TEXT NOT NULL DEFAULT '';
ALTER TABLE quest_groups ADD COLUMN ask_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE quest_groups ADD COLUMN ask_options TEXT NOT NULL DEFAULT '[]';
ALTER TABLE quest_groups ADD COLUMN ask_open INTEGER NOT NULL DEFAULT 0;
