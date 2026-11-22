-- Quest groups, code metadata and submission answers, for databases
-- created before September 2026. Run once (npm run db:quests), then
-- deploy and use the console's Quests tab: Retire current quests, then
-- Import the SCS.2 list.
CREATE TABLE IF NOT EXISTS quest_groups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  region      TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  flavour     TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  coords      TEXT NOT NULL DEFAULT '[]',
  submit_kind TEXT NOT NULL DEFAULT 'none',
  prompt      TEXT NOT NULL DEFAULT '',
  options     TEXT NOT NULL DEFAULT '[]',
  sort        INTEGER NOT NULL DEFAULT 0,
  hidden      INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE quests ADD COLUMN group_id INTEGER;
ALTER TABLE quests ADD COLUMN label TEXT NOT NULL DEFAULT '';
ALTER TABLE quests ADD COLUMN sort INTEGER NOT NULL DEFAULT 0;
ALTER TABLE quests ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN answer TEXT;
