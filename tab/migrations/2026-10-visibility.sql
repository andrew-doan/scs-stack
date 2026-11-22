-- Who can see a quest, and when it opens to everyone.
--
-- visibility: everyone, signed-in teams, or only chosen team groups
-- (audiences). hidden = 1 still means organisers only. opens_at is when
-- the quest opens to everyone by itself; the worker clears it when it
-- does.
--
-- schema.sql has all of this on a fresh database. The ALTERs fail once
-- they are there, which is the signal they have already run.
ALTER TABLE quest_groups ADD COLUMN visibility TEXT NOT NULL DEFAULT 'everyone';
ALTER TABLE quest_groups ADD COLUMN opens_at TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS quest_tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  dash_hidden INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS quest_group_tags (
  group_id INTEGER NOT NULL,
  tag_id   INTEGER NOT NULL,
  PRIMARY KEY (group_id, tag_id)
);

CREATE TABLE IF NOT EXISTS audiences (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);

CREATE TABLE IF NOT EXISTS audience_teams (
  audience_id INTEGER NOT NULL,
  team_id     INTEGER NOT NULL,
  PRIMARY KEY (audience_id, team_id)
);

CREATE TABLE IF NOT EXISTS quest_audiences (
  group_id    INTEGER NOT NULL,
  audience_id INTEGER NOT NULL,
  PRIMARY KEY (group_id, audience_id)
);

-- (site_flags comes from 2026-10-recap.sql; repeated here so this file
-- does not depend on the order the two are read in.)
CREATE TABLE IF NOT EXISTS site_flags (
  name  TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);

-- Every quest hidden before tags existed goes under one tag, Old, which
-- is hidden from the dashboard as well. This must happen once only: the
-- migrations are rerun, and on a rerun a quest hidden since (a bonus
-- quest waiting to drop) would be filed as Old too. The site_flags row
-- written last is what says it has been done.
INSERT OR IGNORE INTO quest_tags (name, dash_hidden, sort)
  SELECT 'Old', 1, 0 WHERE NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'quest_tags_seeded');
INSERT OR IGNORE INTO quest_group_tags (group_id, tag_id)
  SELECT g.id, t.id FROM quest_groups g JOIN quest_tags t ON t.name = 'Old'
  WHERE g.hidden = 1 AND NOT EXISTS (SELECT 1 FROM site_flags WHERE name = 'quest_tags_seeded');
INSERT OR IGNORE INTO site_flags (name, value) VALUES ('quest_tags_seeded', 1);
