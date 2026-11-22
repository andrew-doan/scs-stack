-- Regions as their own table (order, rename, delete), for databases
-- that ran 2026-09-quest-groups.sql before this file existed. Safe to
-- re-run; npm run db:quests applies both files.
CREATE TABLE IF NOT EXISTS quest_regions (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);
